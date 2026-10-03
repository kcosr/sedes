import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import { createHash, randomUUID } from "node:crypto";
import type { BoundedText } from "../../shared/protocol/payload.js";
import {
  testNotificationRequestSchema,
  updateNotificationSettingsRequestSchema,
  notificationPayloadSchema,
  voiceNotificationSchema,
  type VoiceRecognitionTarget,
  type NotificationEventPayload,
  type NotificationAssistantResultPhase,
  type NotificationPayload,
  type NotificationSettings,
  type NotificationTestResult,
  type TestNotificationRequest,
  type UpdateNotificationSettingsRequest,
} from "../../shared/protocol/notification.js";
import type { NotificationRepository } from "../db/repositories/notification-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { executeNotificationScript } from "../runtime/notification-script-executor.js";
import { DomainError } from "./errors.js";

const MAX_CONCURRENT = 4;
const MAX_PENDING = 64;
const MAX_PAYLOAD_BYTES = 65_536;
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
type Subscriber = { readonly scope: RequestScope; readonly listener: (frame: string) => void };
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

  /** Subscribe and deliver policy synchronously; this lane has no replay or inventory cursor. */
  subscribe(scope: RequestScope, listener: (frame: string) => void): () => void {
    const policy = this.input.repository.readDispatch(scope);
    if (this.#closed) return () => {};
    const subscriber = { scope: { ...scope }, listener };
    this.#subscribers.add(subscriber);
    this.#deliver(subscriber, "notification_policy", policy);
    return () => { this.#subscribers.delete(subscriber); };
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
      schemaVersion: 4,
      notificationId: randomUUID(),
      event: "notification.test",
      occurredAt: new Date(this.#now()).toISOString(),
      title: "Sedes test notification",
      message: "Your Sedes notification script was invoked successfully.",
    });
  }

  emit(
    scope: RequestScope,
    event: NotificationEventPayload,
    eventKey: string,
    assistantResult?: ClassifiedAssistantResult,
    voiceContext: VoiceNotificationContext = {},
  ): void {
    if (this.#closed) return;
    try {
      const occurredAt = Date.parse(event.occurredAt);
      if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) return;
      const dispatch = this.input.repository.consume(
        scope,
        eventKey,
        occurredAt,
      );
      if (
        !dispatch ||
        !dispatch.settings.enabled ||
        dispatch.settings.silenced
      )
        return;
      let payload: NotificationPayload = {
        ...structuredClone(event),
        schemaVersion: 4,
        notificationId: randomUUID(),
      };
      // Event metadata is bounded independently of any source transcript size.
      if (
        Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES
      )
        return;
      if (
        event.event === "turn.completed" &&
        dispatch.settings.assistantResultPhases.length > 0 &&
        assistantResult !== undefined
      ) {
        payload = withAssistantResult(
          payload,
          assistantResult,
          dispatch.settings.assistantResultPhases,
        );
      }
      payload = notificationPayloadSchema.parse(payload);
      const channels = dispatch.settings.delivery[event.event];
      if (channels.script && this.#pending.length < MAX_PENDING) {
        this.#pending.push({ scope: { ...scope }, payload, generation: dispatch.generation });
        this.#schedule();
      }
      if (channels.voice !== "none") {
        const recipients = [...this.#subscribers].filter((subscriber) => sameScope(scope, subscriber.scope));
        if (!recipients.length) return;
        const { settlement, ...context } = voiceContext;
        const envelope = {
          payload, sourceEventId: createHash("sha256").update(eventKey).digest("hex"),
          voice: channels.voice, generation: dispatch.generation, ...context,
        };
        const publish = (recognitionTarget: VoiceRecognitionTarget | undefined) => {
          if (this.#closed || this.input.repository.readDispatch(scope).generation !== dispatch.generation) return;
          const value = voiceNotificationSchema.parse({ ...envelope, recognitionTarget });
          for (const recipient of recipients) this.#deliver(recipient, "notification", value);
        };
        if (settlement) {
          // Bound transient waiting independently from script capacity. No later subscribers join.
          if (this.#deferred.size >= 128) { publish(undefined); return; }
          const key = {};
          this.#deferred.set(key, scope);
          void settlement.then((target) => {
            if (this.#deferred.delete(key)) publish(target);
          }, () => {
            if (this.#deferred.delete(key)) publish(undefined);
          }).catch(() => this.#report("Deferred voice notification could not be processed."));
        } else publish(context.recognitionTarget);
      }
    } catch {
      this.#report("Notification event could not be processed.");
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#pending.length = 0;
    this.#deferred.clear();
    this.#subscribers.clear();
    for (const controller of this.#active.keys()) controller.abort();
    await Promise.allSettled(this.#active.values());
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

  #deliver(subscriber: Subscriber, event: string, data: unknown): void {
    if (!this.#subscribers.has(subscriber)) return;
    try { subscriber.listener(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { this.#subscribers.delete(subscriber); }
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

/** Fit escaped JSON while preserving final text ahead of provisional/unknown text. */
function withAssistantResult(
  metadata: NotificationPayload,
  result: ClassifiedAssistantResult,
  selectedPhases: readonly NotificationAssistantResultPhase[],
): NotificationPayload {
  const sections: Partial<ClassifiedAssistantResult> = {};
  // Select before reading or cloning: omitted response phases need no work.
  for (const phase of ["provisional", "final", "unclassified"] as const) {
    if (selectedPhases.includes(phase)) {
      sections[phase] = structuredClone(result[phase]);
    }
  }
  const payload = { ...metadata, assistantResult: sections };
  const fits = () => Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_PAYLOAD_BYTES;
  if (fits()) return payload;
  for (const phase of ["unclassified", "provisional", "final"] as const) {
    const original = sections[phase];
    if (original == null || original.text.length === 0) continue;
    const points = Array.from(original.text);
    const candidate = (count: number): BoundedText => {
      const text = points.slice(0, count).join("") + (count > 0 ? "…" : "");
      return { text, truncation: {
        ...original.truncation,
        truncated: true,
        retainedBytes: Buffer.byteLength(text, "utf8"),
        reason: "byte_limit",
      } };
    };
    sections[phase] = candidate(0);
    if (!fits()) continue;
    let best = sections[phase];
    let low = 1;
    let high = Math.max(0, points.length - 1);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      sections[phase] = candidate(middle);
      if (fits()) { best = sections[phase]; low = middle + 1; }
      else high = middle - 1;
    }
    sections[phase] = best;
    return payload;
  }
  return fits() ? payload : metadata;
}
