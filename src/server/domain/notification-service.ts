import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import { createHash, randomUUID } from "node:crypto";
import {
  testNotificationRequestSchema,
  updateNotificationSettingsRequestSchema,
  voiceNotificationSchema,
  type VoiceAction,
  type VoiceRecognitionTarget,
  type NotificationEventPayload,
  type NotificationPayload,
  type NotificationSettings,
  type NotificationTestResult,
  type TestNotificationRequest,
  type UpdateNotificationSettingsRequest,
} from "../../shared/protocol/notification.js";
import type { NotificationDispatchSettings, NotificationRepository } from "../db/repositories/notification-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { recordVoiceDiagnostic, type VoiceDiagnosticSuppressionReason } from "../diagnostics/voice-diagnostics.js";
import { executeNotificationScript } from "../runtime/notification-script-executor.js";
import {
  fitBoundedText,
  fitsNotificationBudget,
  selectAssistantResult,
} from "./assistant-result-selection.js";
import { DomainError } from "./errors.js";
import type { ResponseVoiceFreshness } from "../conversations/response-voice-freshness.js";

const MAX_CONCURRENT = 4;
const MAX_PENDING = 64;
type Pending = {
  readonly scope: RequestScope;
  readonly payload: NotificationPayload;
  readonly generation: number;
};
export type VoiceNotificationContext = {
  readonly origin?: { readonly clientId: string };
  readonly recognitionTarget?: VoiceRecognitionTarget;
  readonly subjectId?: string;
  /** The epoch and recipients are captured before waiting for terminal settlement. */
  readonly settlement?: Promise<VoiceRecognitionTarget | undefined>;
};
/** Server-derived registration identity; never expose the connection token in an event or diagnostic. */
export type VoiceStreamRecipient = { readonly connectionToken: string; readonly voiceStreamId: string };
export type VoiceNotificationPublication = {
  readonly sourceEventId: string;
  readonly deliveries: readonly (VoiceStreamRecipient & { readonly subscriberSequence: number })[];
};
type Subscriber = { readonly scope: RequestScope; readonly listener: (frame: string) => void; readonly sequence: number;
  readonly voiceStream?: VoiceStreamRecipient };
const sameScope = (left: RequestScope, right: RequestScope) =>
  left.tenantId === right.tenantId && left.principalId === right.principalId;

/** Passive, best-effort hooks. No durable delivery queue, receipts, or retries. */
export class NotificationService {
  readonly #pending: Pending[] = [];
  readonly #active = new Map<
    AbortController,
    Promise<NotificationTestResult>
  >();
  readonly #cwd = process.cwd();
  readonly #subscribers = new Set<Subscriber>();
  readonly #deferred = new Map<object, RequestScope>();
  #subscriberSequence = 0;
  #closed = false;
  #scheduled = false;

  constructor(
    readonly input: {
      readonly repository: NotificationRepository;
      readonly executor?: typeof executeNotificationScript;
      readonly now?: () => number;
      readonly onError?: (message: string) => void;
    },
  ) {}

  read(scope: RequestScope): NotificationSettings {
    return this.input.repository.read(scope);
  }

  /** Captured at completion observation; reconnecting streams cannot join later. */
  captureSubscriberWatermark(): number {
    return this.#subscriberSequence;
  }

  /** Subscribe and deliver policy synchronously; this lane has no replay or inventory cursor. */
  subscribe(scope: RequestScope, listener: (frame: string) => void, voiceStream?: VoiceStreamRecipient): () => void {
    let policy: NotificationDispatchSettings;
    try { policy = this.input.repository.readDispatch(scope); } catch {
      // No policy, no lane: the stream keeps inventory and never receives voice frames.
      this.#report("Notification policy could not be read; voice notifications are unavailable on this stream.");
      return () => {};
    }
    if (this.#closed) return () => {};
    const subscriber: Subscriber = { scope: { ...scope }, listener, sequence: ++this.#subscriberSequence,
      ...(voiceStream ? { voiceStream: { ...voiceStream } } : {}) };
    this.#subscribers.add(subscriber);
    recordVoiceDiagnostic("voice_lane_subscribed", { applicationStreamCount: this.#subscriberCount(scope) });
    this.#deliver(subscriber, "notification_policy", policy);
    return () => { this.#removeSubscriber(subscriber, "unsubscribed"); };
  }

  update(
    scope: RequestScope,
    input: UpdateNotificationSettingsRequest,
  ): NotificationSettings {
    const settings = this.input.repository.update(
      scope,
      updateNotificationSettingsRequestSchema.parse(input),
      this.#now(),
    );
    this.#discardPending(scope);
    this.#publishPolicy(scope);
    return settings;
  }

  setSilenced(scope: RequestScope, silenced: boolean): NotificationSettings {
    const before = this.read(scope);
    const settings = this.input.repository.setSilenced(
      scope,
      silenced,
      this.#now(),
    );
    if (before.silenced !== silenced) {
      this.#discardPending(scope);
      this.#publishPolicy(scope);
    }
    return settings;
  }

  async test(
    scope: RequestScope,
    input: TestNotificationRequest,
  ): Promise<NotificationTestResult> {
    this.input.repository.assertScope(scope);
    const script = testNotificationRequestSchema.parse(input);
    if (this.#closed || this.#active.size >= MAX_CONCURRENT) {
      throw new DomainError(
        "conflict",
        "Notification executor is busy or shutting down.",
      );
    }
    return this.#execute(script, {
      schemaVersion: 5,
      notificationId: randomUUID(),
      event: "notification.test",
      occurredAt: new Date(this.#now()).toISOString(),
      title: "Sedes test notification",
      message: "Your Sedes notification script was invoked successfully.",
    });
  }

  /**
   * Claim once, then dispatch script and voice independently. Payload, result
   * and voice-context work runs only when a channel can deliver.
   */
  async emit(
    scope: RequestScope,
    event: NotificationEventPayload,
    eventKey: string,
    provenance: "live" | "recovered",
    assistantResult?: ClassifiedAssistantResult,
    voiceContext?: () => VoiceNotificationContext,
    subscriberWatermark?: number,
    responseVoice?: ResponseVoiceFreshness,
  ): Promise<VoiceNotificationPublication | undefined> {
    const sourceEventId = createHash("sha256").update(eventKey).digest("hex");
    let claimed = false;
    let scriptQueued = false;
    const decision = (suppressionReason?: VoiceDiagnosticSuppressionReason, recipientCount = 0, action?: VoiceAction) => {
      recordVoiceDiagnostic("voice_decision", {
        sourceEventId, provenance, threadId: event.thread?.id, turnId: event.turn?.id,
        claimed, scriptQueued, applicationStreamCount: this.#subscriberCount(scope),
        recipientCount, ...(action ? { action } : {}), ...(suppressionReason ? { suppressionReason } : {}),
      });
    };
    if (this.#closed) { decision("service_closed"); return; }
    try {
      const occurredAt = Date.parse(event.occurredAt);
      if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) { decision("invalid_event"); return; }
      const dispatch = this.input.repository.consume(
        scope,
        eventKey,
        occurredAt,
      );
      if (!dispatch) { decision("not_claimed"); return; }
      claimed = true;
      if (!dispatch.settings.enabled) { decision("disabled"); return; }
      if (dispatch.settings.silenced) { decision("silenced"); return; }
      const channels = dispatch.settings.delivery[event.event];
      const script = channels.script && this.#pending.length < MAX_PENDING;
      const superseded = event.event.startsWith("turn.") && responseVoice?.superseded === true;
      // Completion recipients must also predate the first live observation.
      const recipients = provenance !== "live" || channels.voice === "none" || superseded ? []
        : [...this.#subscribers].filter((subscriber) => sameScope(scope, subscriber.scope) &&
          (subscriberWatermark === undefined || subscriber.sequence <= subscriberWatermark));
      const suppressionReason = provenance !== "live" ? "recovered"
        : superseded ? "superseded_by_input"
        : channels.voice === "none" ? "voice_disabled" : !recipients.length ? "no_recipients" : undefined;
      if (!script && !recipients.length) { decision(suppressionReason, 0, channels.voice); return; }
      const payload = notificationPayload(event, dispatch.settings, assistantResult);
      if (!payload) { decision("payload_unavailable", recipients.length, channels.voice); return; }
      if (script) {
        this.#pending.push({ scope: { ...scope }, payload, generation: dispatch.generation });
        scriptQueued = true;
        this.#schedule();
      }
      decision(suppressionReason, recipients.length, channels.voice);
      if (recipients.length) {
        return this.#voice(scope, sourceEventId, payload, channels.voice, dispatch.generation, recipients, voiceContext, responseVoice);
      }
    } catch {
      decision("processing_failed");
      this.#report("Notification event could not be processed.");
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#pending.length = 0;
    this.#deferred.clear();
    for (const subscriber of this.#subscribers) this.#removeSubscriber(subscriber, "service_closed");
    for (const controller of this.#active.keys()) controller.abort();
    await Promise.allSettled(this.#active.values());
  }

  /** Context capture and the strict envelope parse are voice-only; failures never reach the script lane. */
  async #voice(
    scope: RequestScope,
    sourceEventId: string,
    payload: NotificationPayload,
    voice: VoiceAction,
    generation: number,
    recipients: readonly Subscriber[],
    voiceContext: (() => VoiceNotificationContext) | undefined,
    responseVoice: ResponseVoiceFreshness | undefined,
  ): Promise<VoiceNotificationPublication | undefined> {
    try {
      const { settlement, ...context } = voiceContext?.() ?? {};
      const envelope = {
        payload, sourceEventId,
        voice, generation, ...context,
        ...(payload.event.startsWith("turn.") && responseVoice ? { userInputRevision: responseVoice.userInputRevision } : {}),
      };
      const publish = (recognitionTarget: VoiceRecognitionTarget | undefined) => {
        const staleGeneration = !this.#closed && this.input.repository.readDispatch(scope).generation !== generation;
        if (this.#closed || staleGeneration) {
          recordVoiceDiagnostic("voice_published", { sourceEventId, recipientCount: recipients.length, attemptedCount: 0, deliveredCount: 0, staleGeneration,
            suppressionReason: this.#closed ? "service_closed" : "policy_changed" });
          return;
        }
        const value = voiceNotificationSchema.parse({ ...envelope, recognitionTarget });
        let attemptedCount = 0;
        let deliveredCount = 0;
        const deliveries: Array<VoiceStreamRecipient & { subscriberSequence: number }> = [];
        for (const recipient of recipients) {
          if (!this.#subscribers.has(recipient)) continue;
          attemptedCount++;
          if (this.#deliver(recipient, "notification", value)) {
            deliveredCount++;
            if (recipient.voiceStream) deliveries.push({ ...recipient.voiceStream, subscriberSequence: recipient.sequence });
          }
        }
        recordVoiceDiagnostic("voice_published", { sourceEventId, recipientCount: recipients.length, attemptedCount, deliveredCount, staleGeneration: false });
        return { sourceEventId: envelope.sourceEventId, deliveries };
      };
      if (!settlement) return publish(context.recognitionTarget);
      // Bound transient waiting independently from script capacity.
      if (this.#deferred.size >= 128) return publish(undefined);
      const key = {};
      this.#deferred.set(key, scope);
      let target: VoiceRecognitionTarget | undefined;
      try { target = await settlement; } catch { /* Announce without recognition authority. */ }
      if (this.#deferred.delete(key)) return publish(target);
      recordVoiceDiagnostic("voice_published", { sourceEventId, recipientCount: recipients.length, attemptedCount: 0, deliveredCount: 0,
        suppressionReason: this.#closed ? "service_closed" : "policy_changed" });
    } catch {
      recordVoiceDiagnostic("voice_published", { sourceEventId, recipientCount: recipients.length, attemptedCount: 0, deliveredCount: 0, suppressionReason: "processing_failed" });
      this.#report("Voice notification could not be processed.");
    }
  }

  #schedule(): void {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    while (
      !this.#closed &&
      this.#active.size < MAX_CONCURRENT &&
      this.#pending.length > 0
    ) {
      const pending = this.#pending.shift()!;
      try {
        const current = this.input.repository.readDispatch(pending.scope);
        if (
          current.generation !== pending.generation ||
          !current.settings.enabled ||
          current.settings.silenced ||
          !current.settings.delivery[pending.payload.event as NotificationEventPayload["event"]].script
        )
          continue;
        void this.#execute(current.settings, pending.payload).then((result) => {
          if (!result.success)
            this.#report("Notification script did not complete successfully.");
        });
      } catch {
        this.#report("Notification script could not be started.");
      }
    }
  }

  #execute(
    script: TestNotificationRequest,
    payload: NotificationPayload,
  ): Promise<NotificationTestResult> {
    const controller = new AbortController();
    // Invoke synchronously with the final eligibility check: no microtask gap
    // in which a silence/configuration change could admit an obsolete script.
    const execution = new Promise<NotificationTestResult>((resolve) =>
      resolve(
        (this.input.executor ?? executeNotificationScript)({
          ...script,
          payload,
          cwd: this.#cwd,
          signal: controller.signal,
        }),
      ),
    )
      .catch((): NotificationTestResult => ({
        success: false,
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        error: "Notification script could not be executed.",
      }))
      .finally(() => {
        this.#active.delete(controller);
        this.#schedule();
      });
    this.#active.set(controller, execution);
    return execution;
  }

  #discardPending(scope: RequestScope): void {
    for (const [key, pendingScope] of this.#deferred) {
      if (sameScope(scope, pendingScope)) this.#deferred.delete(key);
    }
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const pending = this.#pending[index]!;
      if (
        pending.scope.tenantId === scope.tenantId &&
        pending.scope.principalId === scope.principalId
      ) {
        this.#pending.splice(index, 1);
      }
    }
  }

  #publishPolicy(scope: RequestScope): void {
    const policy = this.input.repository.readDispatch(scope);
    for (const subscriber of [...this.#subscribers]) {
      if (sameScope(scope, subscriber.scope)) this.#deliver(subscriber, "notification_policy", policy);
    }
  }

  #subscriberCount(scope: RequestScope): number {
    return [...this.#subscribers].filter(subscriber => sameScope(scope, subscriber.scope)).length;
  }

  #removeSubscriber(subscriber: Subscriber, reason: "unsubscribed" | "listener_failed" | "service_closed"): void {
    if (!this.#subscribers.delete(subscriber)) return;
    recordVoiceDiagnostic("voice_lane_unsubscribed", { reason, applicationStreamCount: this.#subscriberCount(subscriber.scope) });
  }

  #deliver(subscriber: Subscriber, event: string, data: unknown): boolean {
    if (!this.#subscribers.has(subscriber)) return false;
    try {
      subscriber.listener(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // A bounded stream may close synchronously when the frame overflows.
      return this.#subscribers.has(subscriber);
    }
    catch { this.#removeSubscriber(subscriber, "listener_failed"); return false; }
  }

  #now(): number {
    return this.input.now?.() ?? Date.now();
  }

  #report(message: string): void {
    try {
      this.input.onError?.(message);
    } catch {
      /* Hooks cannot fail conversation work. */
    }
  }
}

/** Event metadata is bounded independently of any source transcript size; only progress text shortens. */
function notificationPayload(
  event: NotificationEventPayload,
  settings: NotificationSettings,
  assistantResult: ClassifiedAssistantResult | undefined,
): NotificationPayload | undefined {
  let payload: NotificationPayload = {
    ...structuredClone(event),
    schemaVersion: 5,
    notificationId: randomUUID(),
  };
  if (!fitsNotificationBudget(payload)) {
    const progress = payload.progress;
    if (!progress?.text || !fitBoundedText(progress, () => fitsNotificationBudget(payload), (text) => {
      payload = { ...payload, progress: { phase: progress.phase, itemId: progress.itemId, ...text } };
    })) return undefined;
  }
  if (
    event.event === "turn.completed" &&
    settings.assistantResultPhases.length > 0 &&
    assistantResult !== undefined
  ) {
    // The result shares the payload budget; with no room the metadata is sent alone.
    const selected = selectAssistantResult(
      assistantResult,
      settings.assistantResultPhases,
      payload,
    );
    if (selected) payload = { ...payload, assistantResult: selected };
  }
  return payload;
}
