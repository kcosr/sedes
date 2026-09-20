import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import { randomUUID } from "node:crypto";
import type { BoundedText } from "../../shared/protocol/payload.js";
import {
  testNotificationRequestSchema,
  updateNotificationSettingsRequestSchema,
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

/** Passive, best-effort hooks. No durable delivery queue, receipts, or retries. */
export class NotificationService {
  readonly #pending: Pending[] = [];
  readonly #active = new Map<
    AbortController,
    Promise<NotificationTestResult>
  >();
  readonly #cwd = process.cwd();
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
    return settings;
  }

  setSilenced(scope: RequestScope, silenced: boolean): NotificationSettings {
    const before = this.read(scope);
    const settings = this.input.repository.setSilenced(
      scope,
      silenced,
      this.#now(),
    );
    if (before.silenced !== silenced) this.#discardPending(scope);
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
      schemaVersion: 3,
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
        dispatch.settings.silenced ||
        !dispatch.settings.events.includes(event.event) ||
        this.#pending.length >= MAX_PENDING
      )
        return;
      let payload: NotificationPayload = {
        ...structuredClone(event),
        schemaVersion: 3,
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
      this.#pending.push({
        scope: { ...scope },
        payload,
        generation: dispatch.generation,
      });
      this.#schedule();
    } catch {
      this.#report("Notification event could not be processed.");
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#pending.length = 0;
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
          !current.settings.events.includes(
            pending.payload.event as NotificationEventPayload["event"],
          )
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
