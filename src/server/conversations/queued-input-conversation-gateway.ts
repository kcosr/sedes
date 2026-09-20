import type { SteerTarget } from "../../shared/protocol/conversation.js";
import type {
  SteerTurnInput,
  SteerTurnResult,
  SubmissionReconciliation,
  SubmitTurnInput,
  SubmitTurnResult,
} from "../backends/contracts.js";
import type { MaterializedComposerAttachmentDelivery } from "../composer-attachments/composer-attachment-delivery-service.js";
import type { ComposerAttachmentDescriptor } from "../../shared/protocol/composer-attachments.js";
import type { ComposerAttachmentDeliveryService } from "../composer-attachments/composer-attachment-delivery-service.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { type AcquireConversationActorInput } from "./conversation-actor-manager.js";
import type { ConversationActor } from "./conversation-actor.js";
import type {
  ApplicationSteerTurnInput,
  ApplicationSubmitTurnInput,
} from "./delivery-input-projection.js";

export interface QueuedInputConversation {
  readonly generation: string;
  readonly authoritativelySettled: boolean;
  captureSubmissionRetryAnchor(): Promise<string>;
  materializeAttachments(
    attachments: readonly ComposerAttachmentDescriptor[],
  ): Promise<MaterializedComposerAttachmentDelivery>;
  submit(input: ApplicationSubmitTurnInput): Promise<SubmitTurnResult>;
  /**
   * Returns the backend's currently available normalized steering target, or
   * null when backend/runtime/shared run-state does not allow new Steer intent.
   * Already-admitted conversation intent may also target a settled conversation
   * while its backend still advertises steering support.
   */
  steerTarget?(options?: {
    readonly allowSettledConversation: boolean;
  }): Promise<SteerTarget | null>;
  steer?(
    input: ApplicationSteerTurnInput,
  ): Promise<SteerTurnResult>;
  replayAuthoritativeCompletions(): Promise<void>;
}

/**
 * Backend-neutral actor boundary used by the durable queue. Implementations
 * resolve application threads to backend bindings; the dispatcher never sees
 * native conversation paths, Pi settings, or provider error types.
 */
export interface QueuedInputConversationGateway {
  withConversation<T>(
    scope: RequestScope,
    applicationThreadId: string,
    operation: (conversation: QueuedInputConversation) => Promise<T> | T,
  ): Promise<T>;
  reconcileSubmission(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly applicationOperationId: string;
      readonly reconciliationToken?: string;
      readonly retryAnchor?: string;
      readonly attachments?: readonly ComposerAttachmentDescriptor[];
    },
  ): Promise<SubmissionReconciliation>;
}

export interface QueuedInputActorTargetResolver {
  resolve(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<AcquireConversationActorInput>;
}

export interface QueuedInputRuntimeOwner {
  acquire(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<{
    readonly actor: ConversationActor;
    release(): void;
  }>;
}

/**
 * The production-neutral adapter from application thread IDs to their
 * process-wide runtime owner.
 *
 * Background submissions must acquire the same runtime that owns browser
 * projection and application-summary publication. Going directly to the actor
 * manager would execute correctly but leave unselected threads invisible to
 * the application-wide activity stream.
 */
export class RuntimeBackedQueuedInputConversationGateway implements QueuedInputConversationGateway {
  readonly #runtimes: QueuedInputRuntimeOwner;
  readonly #targets: QueuedInputActorTargetResolver;
  readonly #attachmentDelivery?: ComposerAttachmentDeliveryService;

  constructor(input: {
    readonly runtimes: QueuedInputRuntimeOwner;
    readonly targets: QueuedInputActorTargetResolver;
    readonly attachmentDelivery?: ComposerAttachmentDeliveryService;
  }) {
    this.#runtimes = input.runtimes;
    this.#targets = input.targets;
    this.#attachmentDelivery = input.attachmentDelivery;
  }

  async withConversation<T>(
    scope: RequestScope,
    applicationThreadId: string,
    operation: (conversation: QueuedInputConversation) => Promise<T> | T,
  ): Promise<T> {
    const acquired = await this.#runtimes.acquire(scope, applicationThreadId);
    try {
      return await operation({
        get generation() {
          return acquired.actor.timeline.generation;
        },
        get authoritativelySettled() {
          return acquired.actor.authoritativelySettled;
        },
        captureSubmissionRetryAnchor: () =>
          acquired.actor.captureSubmissionRetryAnchor(),
        materializeAttachments: (attachments) =>
          acquired.actor.materializeAttachments(attachments),
        submit: (input) => acquired.actor.submit(input),
        steerTarget: async (options) => {
          const timeline = acquired.actor.timeline;
          const allowSettledConversation =
            options?.allowSettledConversation === true &&
            acquired.actor.authoritativelySettled;
          if (timeline.runState !== "running" && !allowSettledConversation) {
            return null;
          }
          const capabilities = await acquired.actor.backendCapabilities();
          if (!capabilities.deliveryModes.includes("steer")) return null;
          if (capabilities.steerTarget === "conversation") {
            return { kind: "conversation" };
          }
          return timeline.runState === "running" &&
            capabilities.steerTarget === "turn" && timeline.activeTurnId
            ? { kind: "turn", turnId: timeline.activeTurnId }
            : null;
        },
        steer: (input) => acquired.actor.steer(input),
        replayAuthoritativeCompletions: () =>
          acquired.actor.replayAuthoritativeCompletions(),
      });
    } finally {
      acquired.release();
    }
  }

  async reconcileSubmission(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly applicationOperationId: string;
      readonly reconciliationToken?: string;
      readonly retryAnchor?: string;
      readonly attachments?: readonly ComposerAttachmentDescriptor[];
    },
  ): Promise<SubmissionReconciliation> {
    const target = await this.#targets.resolve(scope, applicationThreadId);
    this.#assertTarget(scope, applicationThreadId, target);
    const descriptors = input.attachments ?? [];
    const attachmentEvidence =
      descriptors.length === 0
        ? []
        : this.#attachmentDelivery?.resolveCanonicalEvidence(
            scope,
            applicationThreadId,
            descriptors,
          );
    if (attachmentEvidence === undefined) {
      throw new Error("composer_attachment_reconciliation_unavailable");
    }
    const reconciliation = await target.driver.reconcileSubmission({
      scope,
      binding: target.binding,
      opaqueBindingDetail: target.opaqueBindingDetail,
      workspace: target.workspace,
      applicationOperationId: input.applicationOperationId,
      ...(input.reconciliationToken
        ? { reconciliationToken: input.reconciliationToken }
        : {}),
      ...(input.retryAnchor ? { retryAnchor: input.retryAnchor } : {}),
      ...(attachmentEvidence.length > 0 ? { attachmentEvidence } : {}),
    });
    if (reconciliation.status === "not_accepted") {
      try {
        const acquired = await this.#runtimes.acquire(
          scope,
          applicationThreadId,
        );
        try {
          await acquired.actor.reconcileSubmissionNotAccepted(
            input.applicationOperationId,
          );
        } finally {
          acquired.release();
        }
      } catch {
        // The durable reconciliation result remains authoritative. A later
        // actor establishment starts from backend state and clears the
        // process-local submission latch.
      }
    }
    return reconciliation;
  }

  #assertTarget(
    scope: RequestScope,
    applicationThreadId: string,
    target: AcquireConversationActorInput,
  ): void {
    if (
      target.scope.tenantId !== scope.tenantId ||
      target.scope.principalId !== scope.principalId ||
      target.binding.applicationThreadId !== applicationThreadId ||
      target.binding.tenantId !== scope.tenantId ||
      target.binding.ownerPrincipalId !== scope.principalId
    ) {
      throw new Error("queued_input_actor_target_scope_mismatch");
    }
  }
}
