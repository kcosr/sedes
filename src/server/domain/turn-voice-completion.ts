import type { AuthoritativeCompletionObserver } from "../conversations/conversation-actor-manager.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ClientControlService } from "./client-control-service.js";
import type { NotificationService, VoiceNotificationPublication } from "./notification-service.js";

type Completion = Parameters<AuthoritativeCompletionObserver>[2];
type Publication = Promise<VoiceNotificationPublication | undefined>;
type Correlations = {
  readonly pending: Set<string>;
  owner: boolean;
  settled: boolean;
  delivered: boolean;
};

/** Coordinate one terminal publication across the actor's per-input observers. */
export class TurnVoiceCompletion {
  readonly #correlations = new Map<string, Correlations>();
  readonly #recent = new Map<string, boolean>();

  constructor(
    private readonly notifications: Pick<NotificationService, "finishEarlyReply">,
    private readonly controls: Pick<ClientControlService, "observeNotification" | "complete">,
  ) {}

  observe(scope: RequestScope, threadId: string, input: Completion) {
    const key = JSON.stringify([scope.tenantId, scope.principalId, threadId, input.applicationTurnId, input.completionIdentity]);
    if (this.#recent.get(key) === true) return () => {};
    const controlsSettled = this.#recent.has(key);
    const group = this.#correlations.get(key) ?? {
      pending: new Set(input.backendCorrelations), owner: false, settled: false, delivered: false,
    };
    this.#correlations.set(key, group);
    const retire = () => {
      if (group.pending.size || !group.settled) return;
      this.#correlations.delete(key);
      // The durable notification claim governs older re-observed history. This
      // recent window also avoids repeating control completion for snapshots.
      this.#recent.set(key, group.delivered);
      if (this.#recent.size > 4096) this.#recent.delete(this.#recent.keys().next().value!);
    };
    const settle = (publication: Publication) => {
      group.owner = true;
      const finalized = publication.catch(() => undefined).then(receipt => {
        group.delivered = receipt !== undefined;
        if (!controlsSettled || group.delivered) {
          this.notifications.finishEarlyReply(scope, threadId, input.applicationTurnId, receipt);
        }
        group.settled = true;
        retire();
        return receipt;
      });
      if (!controlsSettled) {
        this.controls.observeNotification(scope, threadId, input.applicationTurnId, finalized);
        void this.controls.complete(scope, threadId, input.applicationTurnId, input.outcome,
          input.responseVoice?.superseded === true);
      }
    };
    return (publish?: () => Publication | undefined): void => {
      if (!group.pending.delete(input.backendCorrelation)) return;
      if (!group.owner && publish) {
        let publication: Publication | undefined;
        try { publication = publish(); } catch { /* A later correlation may still own publication. */ }
        if (publication) settle(publication);
      }
      if (!group.pending.size && !group.owner) settle(Promise.resolve(undefined));
      retire();
    };
  }
}
