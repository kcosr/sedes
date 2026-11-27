import type { AuthoritativeCompletionObserver } from "../conversations/conversation-actor-manager.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ClientControlService } from "./client-control-service.js";
import { MAX_DEFERRED_VOICE_PUBLICATIONS, type NotificationService, type VoiceNotificationPublication } from "./notification-service.js";

type Completion = Parameters<AuthoritativeCompletionObserver>[2];
type Publication = Promise<VoiceNotificationPublication | undefined>;
type PendingCorrelations = {
  key: string;
  pending: Set<string>;
  anchored: boolean;
  resolved: boolean;
  expiry: NodeJS.Timeout;
};
const CORRELATION_LIFETIME_MS = 60_000;

/** Coordinate one terminal publication across the actor's per-input observers. */
export class TurnVoiceCompletion {
  readonly #correlations = new Map<string, PendingCorrelations>();
  // Actor fan-out shares a freshly frozen correlation array across its ordered
  // callbacks. The actor rail, rather than a timer, owns the factual return
  // count for that batch. Unreachable/abandoned batches retain no strong key.
  #actorBatches = new WeakMap<readonly string[], PendingCorrelations>();
  readonly #recent = new Map<string, "published" | "unclaimed">();
  #closed = false;

  constructor(
    private readonly notifications: Pick<NotificationService, "finishEarlyReply">,
    private readonly controls: Pick<ClientControlService, "observeNotification" | "hasPendingNotification" | "complete">,
  ) {}

  close(): void {
    this.#closed = true;
    for (const [key, group] of this.#correlations) this.#retire(key, group);
    this.#actorBatches = new WeakMap();
    this.#recent.clear();
  }

  #retire(key: string, group: PendingCorrelations): void {
    if (this.#correlations.get(key) !== group) return;
    clearTimeout(group.expiry);
    this.#correlations.delete(key);
  }

  #awaitCorrelations(key: string, input: Completion): PendingCorrelations {
    const batch = this.#actorBatches.get(input.backendCorrelations);
    if (batch?.key === key && !batch.resolved) return batch;
    const current = this.#correlations.get(key);
    if (current) {
      this.#actorBatches.set(input.backendCorrelations, current);
      return current;
    }
    if (this.#correlations.size >= MAX_DEFERRED_VOICE_PUBLICATIONS) {
      const [oldestKey, oldestGroup] = this.#correlations.entries().next().value!;
      this.#retire(oldestKey, oldestGroup);
    }
    const group: PendingCorrelations = {
      key,
      pending: new Set(input.backendCorrelations),
      resolved: false,
      anchored: false,
      expiry: setTimeout(() => this.#retire(key, group), CORRELATION_LIFETIME_MS).unref(),
    };
    this.#correlations.set(key, group);
    this.#actorBatches.set(input.backendCorrelations, group);
    return group;
  }

  #remember(key: string, result: "published" | "unclaimed"): void {
    this.#recent.delete(key);
    this.#recent.set(key, result);
    if (this.#recent.size > 4096) this.#recent.delete(this.#recent.keys().next().value!);
  }

  observe(scope: RequestScope, threadId: string, input: Completion) {
    const turnId = input.applicationTurnId;
    const key = JSON.stringify([scope.tenantId, scope.principalId, threadId, turnId, input.completionIdentity]);
    const owned = () => this.#recent.get(key) === "published" || this.controls.hasPendingNotification(scope, threadId, turnId);
    if (this.#closed || !input.backendCorrelations.includes(input.backendCorrelation) || owned()) return () => {};

    const original = this.#awaitCorrelations(key, input);
    let returned = false;
    return (publish?: () => Publication | undefined): void => {
      if (returned || this.#closed || owned()) return;
      returned = true;
      if (original.resolved || !original.pending.delete(input.backendCorrelation)) return;

      // Only a durably matched submission supplies publish. This authority
      // also settles an explicitly staged action when ordinary voice is silent.
      if (publish) original.anchored = true;
      let publication: Publication | undefined;
      try { publication = publish?.(); } catch { /* Another correlation may still own publication. */ }
      if (!publication && original.pending.size) return;

      // A miss is definitive only after this actor batch actually returns every
      // expected correlation. An admitted publication can win immediately.
      original.resolved = true;
      original.pending.clear();
      const registered = this.#correlations.get(key);
      if (registered) this.#retire(key, registered);
      const controlsSettled = this.#recent.get(key) === "unclaimed";
      this.#remember(key, publication ? "published" : "unclaimed");
      if (controlsSettled && !publication) return;
      const finalized = (publication ?? Promise.resolve(undefined)).catch(() => undefined).then(receipt => {
        if (this.#closed) return receipt;
        this.notifications.finishEarlyReply(scope, threadId, turnId, receipt);
        // Refresh an owner that outlived the recent-decision window before
        // releasing the actual control barrier guarded by hasPendingNotification.
        if (publication) this.#remember(key, "published");
        return receipt;
      });
      if (!controlsSettled) {
        this.controls.observeNotification(scope, threadId, turnId, finalized);
        void this.controls.complete(scope, threadId, turnId, input.outcome, !original.anchored || input.responseVoice?.superseded === true);
      }
    };
  }
}
