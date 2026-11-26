import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { EarlyReplyFrame, EarlyReplyInterest } from "../../shared/protocol/early-reply.js";
import { EarlyReplyDelivery } from "./early-reply-delivery.js";
import { EarlyReplyPublication, type EarlyReplyAuthority } from "./early-reply-publication.js";
import { notificationSourceId, progressNotificationKey, scopedReplyKey, turnNotificationKey } from "./notification-identity.js";
import type { EarlyReplyObservation, EarlyReplySource } from "../conversations/early-reply-observation.js";
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
import { MAX_REPLY_STREAM_IDS } from "../../shared/protocol/client-controls.js";

export const MAX_DEFERRED_VOICE_PUBLICATIONS = 128;
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
export type VoiceStreamReservation = { readonly voiceStreamId: string; readonly release: () => void };
export type VoiceNotificationPublication = {
  readonly sourceEventId: string;
  readonly voiceStreamIds: readonly string[];
};
type Subscriber = { readonly scope: RequestScope; readonly listener: (frame: string) => void; readonly sequence: number;
  readonly voiceStream?: VoiceStreamReservation };
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
  readonly #voiceStreams = new Map<VoiceStreamReservation, {
    readonly scope: RequestScope;
    subscriber?: Subscriber;
    early?: {token: string; revision: number; enabled: boolean; delivery: EarlyReplyDelivery};
  }>();
  readonly #earlyReplies = new Map<string, EarlyReplyPublication>();
  readonly #pendingProgress = new Set<string>();
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

  /** Reserve before response headers so every delivered native stream fits the reply receipt. */
  reserveVoiceStream(scope: RequestScope, voiceStreamId: string, early?: {enabled: boolean; revision: number}): VoiceStreamReservation {
    for (const [reservation, stream] of this.#voiceStreams) {
      if (sameScope(scope, stream.scope) && reservation.voiceStreamId === voiceStreamId)
        throw new DomainError("conflict", "A native stream with this ID is already open.");
    }
    if (this.#closed || [...this.#voiceStreams.values()].filter(stream => sameScope(scope, stream.scope)).length >= MAX_REPLY_STREAM_IDS) {
      throw new DomainError("runtime_unavailable", "Native voice stream capacity is unavailable. Retry shortly.", true);
    }
    const reservation: VoiceStreamReservation = { voiceStreamId, release: () => {
      const stream = this.#voiceStreams.get(reservation);
      if (!stream) return;
      this.#voiceStreams.delete(reservation);
      for (const group of this.#earlyReplies.values()) {
        if (sameScope(scope, group.scope)) group.remove(voiceStreamId);
      }
      if (stream.subscriber) this.#removeSubscriber(stream.subscriber, "unsubscribed");
    } };
    this.#voiceStreams.set(reservation, { scope: { ...scope },
      ...(early ? {early: {...early, token: randomBytes(32).toString("base64url"), delivery: new EarlyReplyDelivery()}} : {}) });
    return reservation;
  }

  /** Subscribe and deliver policy synchronously; this lane has no replay or inventory cursor. */
  subscribe(scope: RequestScope, listener: (frame: string) => void, voiceStream?: VoiceStreamReservation): () => void {
    const reserved = voiceStream ? this.#voiceStreams.get(voiceStream) : undefined;
    if (voiceStream && (!reserved || !sameScope(scope, reserved.scope) || reserved.subscriber)) {
      throw new DomainError("invalid_transition", "The native voice stream reservation is unavailable.");
    }
    let policy: NotificationDispatchSettings;
    try { policy = this.input.repository.readDispatch(scope); } catch {
      // No policy, no lane: the stream keeps inventory and never receives voice frames.
      this.#report("Notification policy could not be read; voice notifications are unavailable on this stream.");
      return () => {};
    }
    if (this.#closed) return () => {};
    const subscriber: Subscriber = { scope: { ...scope }, listener, sequence: ++this.#subscriberSequence,
      ...(voiceStream ? { voiceStream } : {}) };
    if (reserved) reserved.subscriber = subscriber;
    this.#subscribers.add(subscriber);
    recordVoiceDiagnostic("voice_lane_subscribed", { applicationStreamCount: this.#subscriberCount(scope) });
    if (this.#deliver(subscriber, "notification_policy", policy) && voiceStream && reserved?.early) {
      this.#deliver(subscriber, "voice_early_session", {
        voiceStreamId: voiceStream.voiceStreamId, token: reserved.early.token, revision: reserved.early.revision,
      });
    }
    return () => { this.#removeSubscriber(subscriber, "unsubscribed"); };
  }

  updateEarlyInterest(scope: RequestScope, voiceStreamId: string, input: EarlyReplyInterest): void {
    for (const [reservation, stream] of this.#voiceStreams) {
      if (reservation.voiceStreamId !== voiceStreamId || !sameScope(scope, stream.scope) || !stream.early || !stream.subscriber) continue;
      const provided = Buffer.from(input.token);
      const expected = Buffer.from(stream.early.token);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) break;
      if (input.revision === stream.early.revision && input.enabled === stream.early.enabled) return;
      if (input.revision <= stream.early.revision) throw new DomainError("conflict", "The voice stream interest revision is stale.");
      stream.early.revision = input.revision;
      stream.early.enabled = input.enabled;
      if (!input.enabled) for (const group of this.#earlyReplies.values()) {
        if (sameScope(scope, group.scope)) group.remove(voiceStreamId, false);
      }
      return;
    }
    throw new DomainError("not_found", "The voice stream reservation is unavailable.");
  }

  /** Freeze the precise opt-in reservations before awaiting submission admission. */
  captureEarlyReply(scope: RequestScope, threadId: string, source: EarlyReplySource,
    captureAuthority: () => EarlyReplyAuthority | undefined): EarlyReplyObservation | undefined {
    if (this.#closed) return;
    const eventKey = source.event === "turn.progress"
      ? progressNotificationKey(threadId, source.applicationTurnId, source.applicationItemId)
      : turnNotificationKey(threadId, source.applicationTurnId);
    const replyId = notificationSourceId(eventKey);
    const recipients = [...this.#voiceStreams.entries()].flatMap(([reservation, stream]) => {
      if (!sameScope(scope, stream.scope) || !stream.subscriber || !stream.early?.enabled || !stream.early.delivery.mayOpen(replyId)) return [];
      const subscriber = stream.subscriber;
      const delivery = stream.early.delivery;
      return [{voiceStreamId: reservation.voiceStreamId, send: (frame: EarlyReplyFrame) =>
        delivery.send(frame, outgoing => this.#deliver(subscriber, "voice_early_reply", outgoing))}];
    });
    if (!recipients.length) return;
    const key = scopedReplyKey(scope, replyId);
    if (this.#earlyReplies.has(key) || [...this.#earlyReplies.values()].filter(group => sameScope(scope, group.scope)).length >= 64) return;
    const {generation, settings} = this.input.repository.readDispatch(scope);
    if (!settings.enabled || settings.silenced || settings.delivery[source.event].voice === "none" ||
        (source.event === "turn.completed" && !settings.assistantResultPhases.includes("final"))) return;
    const authority = captureAuthority();
    if (!authority) return;
    const publication = new EarlyReplyPublication(scope, threadId, source.applicationTurnId, source.applicationItemId,
      source.event, generation, replyId, settings.assistantResultPhases,
      recipients, authority, () => this.input.repository.readDispatch(scope).generation === generation,
      () => { if (this.#earlyReplies.get(key) === publication) this.#earlyReplies.delete(key); });
    this.#earlyReplies.set(key, publication);
    return publication;
  }

  checkEarlyReplyFreshness(scope: RequestScope, threadId: string): void {
    for (const group of this.#earlyReplies.values()) {
      if (group.threadId === threadId && sameScope(scope, group.scope)) group.checkFreshness();
    }
  }

  finishEarlyReply(scope: RequestScope, threadId: string, turnId: string, publication: VoiceNotificationPublication | undefined): void {
    this.#finishPublication(scope, notificationSourceId(turnNotificationKey(threadId, turnId)), publication);
    // A rewritten or abandoned commentary can still get its ordinary notice until
    // turn settlement. Preserve a publication already claimed by its item observer.
    for (const [key, group] of this.#earlyReplies) {
      if (group.event === "turn.progress" && group.threadId === threadId && group.turnId === turnId &&
          sameScope(scope, group.scope) && !this.#pendingProgress.has(key)) group.dispose();
    }
    for (const stream of this.#voiceStreams.values()) {
      if (!stream.early || !stream.subscriber || !sameScope(scope, stream.scope)) continue;
      const subscriber = stream.subscriber;
      for (const replyId of stream.early.delivery.openProgressForTurn(threadId, turnId)) {
        if (!this.#pendingProgress.has(scopedReplyKey(scope, replyId))) stream.early.delivery.terminal(
          replyId, false, frame => this.#deliver(subscriber, "voice_early_reply", frame));
      }
    }
  }

  /** A completed commentary item owns its publication independently of the turn and other items. */
  finishEarlyProgress(scope: RequestScope, threadId: string, turnId: string, itemId: string,
    publication?: Promise<VoiceNotificationPublication | undefined>): void {
    const replyId = notificationSourceId(progressNotificationKey(threadId, turnId, itemId));
    const key = scopedReplyKey(scope, replyId);
    if (this.#closed || this.#pendingProgress.has(key)) return;
    // Expired scanners can still have recipients awaiting the ordinary item decision.
    if (!this.#earlyReplies.has(key) && ![...this.#voiceStreams.values()].some(stream =>
      sameScope(scope, stream.scope) && stream.early?.delivery.hasOpen(replyId))) return;
    if (!publication) {
      this.#finishPublication(scope, replyId, undefined);
      return;
    }
    // The ordinary lane claims synchronously, then may await a settlement.
    // Repeated completed/filtered observations cannot retire the claiming publication.
    this.#pendingProgress.add(key);
    void publication.catch(() => undefined).then(receipt => {
      if (this.#pendingProgress.delete(key)) this.#finishPublication(scope, replyId, receipt);
    });
  }

  #finishPublication(scope: RequestScope, replyId: string, publication: VoiceNotificationPublication | undefined): void {
    this.#earlyReplies.get(scopedReplyKey(scope, replyId))?.dispose();
    const delivered = new Set(publication?.sourceEventId === replyId ? publication.voiceStreamIds : []);
    for (const [reservation, stream] of this.#voiceStreams) {
      if (!stream.early || !stream.subscriber || !sameScope(scope, stream.scope)) continue;
      const subscriber = stream.subscriber;
      stream.early.delivery.terminal(replyId, delivered.has(reservation.voiceStreamId),
        frame => this.#deliver(subscriber, "voice_early_reply", frame));
    }
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
    const sourceEventId = notificationSourceId(eventKey);
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
    for (const group of this.#earlyReplies.values()) {
      group.cancel("authority_lost");
      group.dispose();
    }
    this.#pending.length = 0;
    this.#deferred.clear();
    this.#pendingProgress.clear();
    for (const subscriber of this.#subscribers) this.#removeSubscriber(subscriber, "service_closed");
    for (const reservation of this.#voiceStreams.keys()) reservation.release();
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
        const voiceStreamIds = new Set<string>();
        for (const recipient of recipients) {
          if (!this.#subscribers.has(recipient)) continue;
          // Partial answers retain the ordinary delivery decision if an item's commentary classification changed.
          if (payload.event !== "turn.partial" && recipient.voiceStream &&
              this.#voiceStreams.get(recipient.voiceStream)?.early?.delivery.mayDeliverTerminal(sourceEventId) === false) continue;
          attemptedCount++;
          if (this.#deliver(recipient, "notification", value)) {
            deliveredCount++;
            if (recipient.voiceStream) voiceStreamIds.add(recipient.voiceStream.voiceStreamId);
          }
        }
        recordVoiceDiagnostic("voice_published", { sourceEventId, recipientCount: recipients.length, attemptedCount, deliveredCount, staleGeneration: false });
        return { sourceEventId: envelope.sourceEventId, voiceStreamIds: [...voiceStreamIds] };
      };
      if (!settlement) return publish(context.recognitionTarget);
      // Bound transient waiting independently from script capacity.
      if (this.#deferred.size >= MAX_DEFERRED_VOICE_PUBLICATIONS) return publish(undefined);
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
    for (const group of this.#earlyReplies.values()) {
      if (sameScope(scope, group.scope)) group.cancel("policy_changed");
    }
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
    subscriber.voiceStream?.release();
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
