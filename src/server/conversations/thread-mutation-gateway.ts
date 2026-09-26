import type { SteerTarget } from "../../shared/protocol/conversation.js";
import { randomUUID } from "node:crypto";
import type {
  ThreadDeliveryMutationResult,
  ThreadApplicationMutationResult,
  ThreadApplicationOperation,
} from "../../shared/protocol/api.js";
import { hasDeliverableComposerInput } from "../../shared/protocol/conversation.js";
import {
  BackendError,
  type InteractionResponseInput,
  type RegisteredBackendActionInput,
} from "../backends/contracts.js";
import type { ConversationOperationRepository } from "../db/repositories/conversation-operation-repository.js";
import type { SubmissionCompletionRepository } from "../db/repositories/submission-completion-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  AcquiredThreadRuntime,
  ThreadRuntimeCoordinator,
} from "../events/thread-runtime-coordinator.js";
import type { QueuedInputDispatcher } from "./queued-input-dispatcher.js";
import type { ConversationLifecycleService } from "./conversation-lifecycle-service.js";
import type { ThreadForkService } from "./thread-fork-service.js";
import type { QueuedInputConversationGateway } from "./queued-input-conversation-gateway.js";
import type {
  InteractionBroker,
  PreparedInteractionResponse,
} from "./interaction-broker.js";
import { SerializedMailbox } from "./serialized-mailbox.js";
import type {
  ThreadApplicationMutationGateway,
  ThreadApplicationPresentation,
  ThreadApplicationPresentationReader,
} from "./thread-application-service.js";
import { DomainError } from "../domain/errors.js";
import type { ProviderFeatureRef } from "../../shared/protocol/provider-feature.js";
import type { ProviderFeatureConcurrency } from "../provider-features/contracts.js";
import type { ThreadAgentToolPolicyRepository } from "../db/repositories/thread-agent-tool-policy-repository.js";
import type { ToolInitiator } from "../agent-tools/contracts/tool-initiator.js";
import { ThreadCompletionCallbackRepository } from "../db/repositories/thread-completion-callback-repository.js";
import {
  ThreadRuntimeNotIdleError,
  ThreadRuntimeRetirementUnprovenError,
} from "../events/thread-runtime-coordinator.js";

type PerformOperation = Extract<
  ThreadApplicationOperation,
  { readonly kind: "perform" }
>;

function clearedDeliveryDraft(revision: number, updatedAt: number) {
  return {
    text: "" as const,
    contextExcerpts: [] as [],
    attachments: [] as [],
    taskReferences: [] as [],
    revision,
    updatedAt: new Date(updatedAt).toISOString(),
  };
}

function authoritativeDeliveryDraft(
  draft: Pick<
    ReturnType<InventoryRepository["getDraft"]>,
    | "text"
    | "selectedSkillId"
    | "contextExcerpts"
    | "attachments"
    | "taskReferences"
    | "revision"
    | "updatedAt"
  >,
) {
  return {
    text: draft.text,
    ...(draft.selectedSkillId === null
      ? {}
      : { selectedSkillId: draft.selectedSkillId }),
    contextExcerpts: draft.contextExcerpts,
    attachments: draft.attachments,
    taskReferences: draft.taskReferences,
    revision: draft.revision,
    updatedAt: new Date(draft.updatedAt).toISOString(),
  };
}

/**
 * Settings-revision fence for a durable action accept. `staged` guards a
 * not-yet-applied setting change against interleaved durable settings writes
 * and is required for local (pre-boundary) settings mutations.
 * `proven_applied` is used only after the backend action is known applied —
 * a successful perform or a reconciliation decision of accepted — and
 * directs the provider to persist against its current durable settings
 * revision, because provider-owned observed-settings adoption may
 * legitimately advance that revision while the action is in flight. Reusing
 * the client-staged revision after proven application would wedge the
 * operation in an uncertainty it could never reconcile.
 */
export type BackendActionSettingsGuard =
  | { readonly kind: "staged"; readonly expectedRevision: number }
  | { readonly kind: "proven_applied" };

export interface ProviderFeatureMutationActor {
  readonly mutateProviderFeature?: (input: {
    readonly featureId: string;
    readonly schemaVersion: number;
    readonly actionId: string;
    readonly arguments: unknown;
  }) => Promise<{
    readonly outcome: "accepted" | "uncertain" | "rejected";
    readonly projectedState?: unknown;
    readonly safeMessage?: string;
  }>;
}

export interface ThreadActionPersistenceProvider {
  /** Backend-owned best-effort feature lifecycle work after accepted Stop. */
  afterInterruptAccepted(actor: ProviderFeatureMutationActor): Promise<boolean>;
  /** Local next-turn settings never cross a provider boundary at mutation time. */
  isLocalOperation?(operation: PerformOperation["operation"]): boolean;
  driverAction(
    operation: PerformOperation["operation"],
    applicationOperationId: string,
  ): RegisteredBackendActionInput;
  persistAccepted(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly settingsGuard: BackendActionSettingsGuard;
      readonly operation: PerformOperation["operation"];
      readonly now: number;
    },
  ): void;
  /** Provider-specific post-commit work. Never runs inside a SQLite transaction. */
  afterPersistAccepted(
    scope: RequestScope,
    applicationThreadId: string,
    operation: PerformOperation["operation"],
  ): Promise<void>;
  /** Required per-action quietness policy shared by projection and enforcement. */
  providerFeatureConcurrency(
    feature: ProviderFeatureRef,
    actionId: string,
  ): ProviderFeatureConcurrency;
  /**
   * True when the feature requires an attached conversation handle for a
   * durable external provider RPC.
   */
  requiresRuntimeProviderFeature?(
    operation: Extract<
      PerformOperation["operation"],
      { readonly action: "perform_provider_feature" }
    >,
  ): boolean;
  performProviderFeature?(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly operation: Extract<
        PerformOperation["operation"],
        { readonly action: "perform_provider_feature" }
      >;
      readonly now: number;
      /**
       * Present when requiresRuntimeProviderFeature is true. Invokes the
       * attached handle's durable provider-feature mutation path.
       */
      readonly mutateExternal?: (input: {
        readonly featureId: string;
        readonly schemaVersion: number;
        readonly actionId: string;
        readonly arguments: unknown;
      }) => Promise<{
        readonly outcome: "accepted" | "uncertain" | "rejected";
        readonly projectedState?: unknown;
        readonly safeMessage?: string;
      }>;
    },
  ):
    | { readonly applicationOperationId: string }
    | Promise<
        | { readonly applicationOperationId: string }
        | {
            readonly status: "recovery_required";
            readonly retryable: boolean;
          }
      >;
  replayProviderFeature?(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly operation: Extract<
        PerformOperation["operation"],
        { readonly action: "perform_provider_feature" }
      >;
    },
  ): { readonly applicationOperationId: string } | undefined;
}

function operationKey(
  scope: RequestScope,
  applicationThreadId: string,
): string {
  return `${scope.tenantId}\0${scope.principalId}\0${applicationThreadId}`;
}

export type AgentThreadDirectSendResult =
  | {
      readonly status: "delivery_accepted";
      readonly operationId: string;
      readonly callbackId?: string;
    }
  | {
      readonly status: "recovery_required";
      readonly operationId: string;
      readonly retryable: boolean;
      readonly callbackId?: string;
    }
  | { readonly status: "aborted"; readonly operationId: string };

function backendActionReceiptKind(
  operation: PerformOperation["operation"],
): "conversation_rename" | "conversation_compact" | "conversation_settings" {
  if (operation.action === "rename") return "conversation_rename";
  if (operation.action === "compact") return "conversation_compact";
  return "conversation_settings";
}

function validateStagedSetting(
  presentation: ThreadApplicationPresentation,
  operation: Extract<
    PerformOperation["operation"],
    { readonly action: "set_setting" }
  >,
): void {
  const descriptor = presentation.settingDescriptors.find(
    ({ id }) => id === operation.settingId,
  );
  if (!descriptor || !descriptor.available) {
    throw new DomainError(
      "invalid_transition",
      "The requested setting is not currently available.",
    );
  }
  const option = descriptor.options.find(
    ({ value }) => value === operation.value,
  );
  if (!option?.available) {
    throw new DomainError(
      "invalid_transition",
      "The requested setting value is not currently available.",
    );
  }
}

/**
 * Capability-driven application mutation boundary. Bound submit/queue inputs
 * always enter the durable queue. Steer intents retain their exact active-turn
 * target and cross the provider boundary later under dispatcher ownership.
 */
export class ThreadMutationGateway implements ThreadApplicationMutationGateway {
  readonly #mailboxes = new Map<string, SerializedMailbox>();
  readonly #detachedPublications = new Set<Promise<void>>();
  readonly #callbacks: ThreadCompletionCallbackRepository;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    readonly input: {
      readonly bindings: ConversationBindingRepository;
      readonly inventory: InventoryRepository;
      readonly lifecycle: ConversationLifecycleService;
      readonly forks: Pick<ThreadForkService, "recoverActive" | "discardActive">;
      readonly queue: QueuedInputDispatcher;
      readonly operations: ConversationOperationRepository;
      readonly completions: SubmissionCompletionRepository;
      readonly queueGateway: QueuedInputConversationGateway;
      readonly runtimes: ThreadRuntimeCoordinator;
      readonly interactions: InteractionBroker;
      readonly presentation: ThreadApplicationPresentationReader;
      readonly agentToolPolicies: Pick<
        ThreadAgentToolPolicyRepository,
        "database" | "get" | "update"
      >;
      readonly actionPersistence: ReadonlyMap<
        string,
        ThreadActionPersistenceProvider
      >;
      readonly publishThreadSnapshot: (
        scope: RequestScope,
        applicationThreadId: string,
      ) => Promise<void>;
      /**
       * Reports post-acceptance publication failures. The durable receipt is
       * already authoritative at that point, so the failure cannot be
       * surfaced to the caller; it must not be silent either.
       */
      readonly onPublicationError?: (error: unknown) => void;
      readonly now?: () => number;
      readonly onThreadChanged?: (
        scope: RequestScope,
        applicationThreadId: string,
      ) => void | Promise<void>;
    },
  ) {
    const database = input.bindings.database;
    if (
      input.inventory.database !== database ||
      input.operations.database !== database ||
      input.completions.database !== database ||
      input.agentToolPolicies.database !== database
    ) {
      throw new Error("thread_mutation_database_mismatch");
    }
    this.#callbacks = new ThreadCompletionCallbackRepository(database);
  }

  mutate(
    scope: RequestScope,
    applicationThreadId: string,
    operation: ThreadApplicationOperation,
  ): Promise<ThreadApplicationMutationResult> {
    if (this.#closing) {
      return Promise.reject(new Error("thread_mutation_gateway_closed"));
    }
    const key = operationKey(scope, applicationThreadId);
    let mailbox = this.#mailboxes.get(key);
    if (!mailbox) {
      mailbox = new SerializedMailbox();
      this.#mailboxes.set(key, mailbox);
    }
    return mailbox.enqueue(async () => {
      const uncertaintyBlockedQueue =
        this.input.operations.findUncertainThreadOperation(
          scope,
          applicationThreadId,
        ) !== undefined;
      try {
        return await this.#mutate(scope, applicationThreadId, operation);
      } finally {
        if (
          uncertaintyBlockedQueue &&
          !this.input.operations.findUncertainThreadOperation(
            scope,
            applicationThreadId,
          )
        ) {
          try {
            await this.input.queue.onAuthoritativeSettled(
              scope,
              applicationThreadId,
            );
          } catch {
            // The durable queue remains authoritative. Its own recovery and
            // retry scheduling resume dispatch after transient failures.
          }
        }
      }
    });
  }

  /**
   * Admits an agent-originated user message without reading or mutating the
   * independently owned browser composer draft. It shares this gateway's
   * per-target mailbox with browser mutations, so concurrent sends cannot
   * both win the same idle/revision fence.
   */
  sendDirect(
    scope: RequestScope,
    input: {
      readonly initiator: ToolInitiator;
      readonly targetThreadId: string;
      readonly message: string;
      readonly callback?: boolean;
      readonly mutationId: string;
    },
  ): Promise<AgentThreadDirectSendResult> {
    if (this.#closing) {
      return Promise.reject(new Error("thread_mutation_gateway_closed"));
    }
    const key = operationKey(scope, input.targetThreadId);
    let mailbox = this.#mailboxes.get(key);
    if (!mailbox) {
      mailbox = new SerializedMailbox();
      this.#mailboxes.set(key, mailbox);
    }
    return mailbox.enqueue(() => this.#sendDirect(scope, input));
  }

  recoverThread(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ThreadApplicationMutationResult> {
    return this.mutate(scope, applicationThreadId, {
      kind: "recover_uncertain",
    });
  }

  observeAuthoritativeSubmission(
    scope: RequestScope,
    applicationThreadId: string,
    backendCorrelation: string,
  ): Promise<void> {
    if (this.#closing) {
      return Promise.reject(new Error("thread_mutation_gateway_closed"));
    }
    const routedSteer = this.input.operations.findAwaitingSteerSubmission(
      scope,
      applicationThreadId,
      backendCorrelation,
    );
    if (routedSteer) {
      const receipt = routedSteer;
      if (receipt.source === "queued_input") {
        return this.input.queue
          .observeAuthoritativeSubmission(
            scope,
            applicationThreadId,
            backendCorrelation,
          )
          .then(() => undefined);
      }
    }
    const key = operationKey(scope, applicationThreadId);
    let mailbox = this.#mailboxes.get(key);
    if (!mailbox) {
      mailbox = new SerializedMailbox();
      this.#mailboxes.set(key, mailbox);
    }
    return mailbox.enqueue(async () => {
      const receipt = this.input.operations.findAwaitingSteerSubmission(
        scope,
        applicationThreadId,
        backendCorrelation,
      );
      if (!receipt) return;
      if (receipt.source === "queued_input") return;
      if (receipt.applicationOperationId !== backendCorrelation) return;
      const acceptedAt = this.#now();
      this.input.operations.database.transaction(() => {
        this.input.operations.acceptSteer(
          scope,
          receipt.mutationId,
          acceptedAt,
        );
        this.input.completions.recordAccepted(scope, applicationThreadId, {
          operationId: receipt.applicationOperationId,
          acceptedAt,
          backendCorrelation,
          attachmentIds: receipt.attachments.map(({ id }) => id),
        });
      })();
      await this.input.publishThreadSnapshot(scope, applicationThreadId);
      await this.#changed(scope, applicationThreadId);
    });
  }

  async recoverUncertain(scope: RequestScope): Promise<void> {
    for (const operation of this.input.operations.listPreparedDraftSteers(
      scope,
    )) {
      try {
        // No backend call was allowed before this state. A prepared draft
        // receipt left by process loss is therefore safe to discard while the
        // authoritative draft remains untouched.
        this.input.operations.rejectSteerBeforeAcceptance(
          scope,
          operation.mutationId,
        );
      } catch {
        // A concurrent recovery may already have removed the receipt.
      }
    }
    for (const operation of this.input.operations.listUncertainSteers(scope)) {
      try {
        await this.recoverThread(scope, operation.threadId);
      } catch (error) {
        // Terminal unknown delivery is a durable, nonblocking recovery result.
        // Its user-facing diagnostic must not abort recovery of other threads.
        if (this.input.operations.findSteer(scope, operation.mutationId)?.state !== "failed_unknown") {
          throw error;
        }
      }
    }
    for (const operation of this.input.operations.listPendingMaterializationSteers(
      scope,
    )) {
      if (operation.source !== "draft") continue;
      try {
        await this.#reconcileSteer(scope, operation.mutationId);
      } catch {
        // The durable pending receipt remains the startup recovery authority.
      }
      const current = this.input.operations.findSteer(scope, operation.mutationId);
      if (
        current?.state === "pending_materialization" &&
        current.target?.kind === "conversation"
      ) {
        this.input.operations.markSteerMaterializationUncertain(
          scope, current.mutationId, this.#now(),
        );
        await this.input.publishThreadSnapshot(scope, current.threadId);
        await this.#changed(scope, current.threadId);
      }
    }
    for (const operation of this.input.operations.listUncertainInterrupts(
      scope,
    )) {
      try {
        await this.mutate(scope, operation.threadId, {
          kind: "interrupt",
          operationId: operation.operationId,
        });
      } catch {
        // The durable receipt remains the recovery authority. A later startup
        // or explicit recover operation retries the exact original Stop.
      }
    }
    for (const operation of this.input.operations.listUncertainBackendActions(
      scope,
    )) {
      try {
        await this.mutate(scope, operation.threadId, {
          kind: "perform",
          mutationId: operation.mutationId,
          expectedThreadRevision: operation.expectedThreadRevision,
          ...(operation.expectedSettingsRevision === undefined
            ? {}
            : {
                expectedSettingsRevision: operation.expectedSettingsRevision,
              }),
          operation: operation.operation,
        });
      } catch {
        // Preserve uncertainty when the backend is unavailable or cannot yet
        // reconcile its durable action marker.
      }
    }
    for (const operation of this.input.operations.listUncertainInteractionResponses(
      scope,
    )) {
      try {
        if (!operation.response) {
          throw new Error("uncertain_interaction_response_payload_missing");
        }
        await this.mutate(scope, operation.threadId, {
          kind: "respond",
          operationId: operation.operationId,
          interactionId: operation.interactionId,
          response: operation.response,
        });
      } catch {
        // The exact response remains recoverable by the closed recovery
        // operation if a live backend interaction still owns it.
      }
    }
  }

  async onAuthoritativeSettled(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    const pending = this.input.operations.findPendingMaterializationSteer(
      scope,
      applicationThreadId,
    );
    if (!pending || pending.source !== "draft") return;
    const key = operationKey(scope, applicationThreadId);
    let mailbox = this.#mailboxes.get(key);
    if (!mailbox) {
      mailbox = new SerializedMailbox();
      this.#mailboxes.set(key, mailbox);
    }
    await mailbox.enqueue(async () => {
      const current = this.input.operations.findPendingMaterializationSteer(
        scope,
        applicationThreadId,
      );
      if (!current || current.source !== "draft") return;
      await this.#reconcileSteer(scope, current.mutationId);
    });
  }

  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    const mailboxes = [...this.#mailboxes.values()];
    this.#mailboxes.clear();
    await Promise.all(mailboxes.map((mailbox) => mailbox.close()));
    while (this.#detachedPublications.size > 0) {
      await Promise.allSettled([...this.#detachedPublications]);
    }
  }

  async #acquireActiveWorkspaceRuntime(scope: RequestScope, applicationThreadId: string) {
    const runtime = await this.input.runtimes.acquire(scope, applicationThreadId);
    try {
      const thread = this.input.inventory.getThread(scope, applicationThreadId).thread;
      this.input.inventory.assertWorkspaceActive(scope, thread.workspaceId);
      return runtime;
    } catch (error) {
      runtime.release();
      throw error;
    }
  }

  async #mutate(
    scope: RequestScope,
    applicationThreadId: string,
    operation: ThreadApplicationOperation,
  ): Promise<ThreadApplicationMutationResult> {
    if (operation.kind === "recover_uncertain") {
      return this.#recoverCurrent(scope, applicationThreadId);
    }
    if (operation.kind === "discard_fork") {
      const discarded = await this.input.forks.discardActive(scope, applicationThreadId);
      await this.input.publishThreadSnapshot(scope, applicationThreadId);
      await this.#changed(scope, applicationThreadId);
      return { status: "aborted", diagnostic: discarded.diagnostic };
    }
    if (operation.kind !== "interrupt" && operation.kind !== "cancel_queued_input") {
      const thread = this.input.inventory.getThread(scope, applicationThreadId).thread;
      this.input.inventory.assertWorkspaceActive(scope, thread.workspaceId);
    }
    if (
      operation.kind === "move_draft" &&
      this.input.bindings.isUnboundThreadWorkspaceMoveReplay(
        scope,
        applicationThreadId,
        operation,
      )
    ) {
      return { status: "completed" };
    }
    if (operation.kind === "cancel_queued_input") {
      return this.#cancelQueuedInput(scope, applicationThreadId, operation);
    }
    if (operation.kind === "restore_queued_input") {
      return this.#restoreQueuedInput(scope, applicationThreadId, operation);
    }
    const unresolvedOperation =
      this.input.operations.findUncertainThreadOperation(
        scope,
        applicationThreadId,
      );
    const retriesUncertainOperation =
      unresolvedOperation !== undefined &&
      ((operation.kind === "deliver" &&
        unresolvedOperation.operationKind === "conversation_steer" &&
        unresolvedOperation.mutationId === operation.mutationId) ||
        (operation.kind === "steer_queued_input" &&
          unresolvedOperation.operationKind === "conversation_steer" &&
          unresolvedOperation.mutationId === operation.mutationId) ||
        (operation.kind === "interrupt" &&
          unresolvedOperation.operationKind === "conversation_interrupt" &&
          unresolvedOperation.mutationId === operation.operationId) ||
        (operation.kind === "perform" &&
          unresolvedOperation.operationKind ===
            backendActionReceiptKind(operation.operation) &&
          unresolvedOperation.mutationId === operation.mutationId) ||
        (operation.kind === "respond" &&
          unresolvedOperation.operationKind ===
            "conversation_interaction_response" &&
          unresolvedOperation.mutationId === operation.operationId));
    const admitsBehindQueuedSteer =
      unresolvedOperation !== undefined &&
      unresolvedOperation.operationKind === "conversation_steer" &&
      operation.kind === "deliver" &&
      operation.mode === "steer" &&
      unresolvedOperation.mutationId !== operation.mutationId &&
      this.input.operations.findSteer(scope, unresolvedOperation.mutationId)
        ?.source === "queued_input";
    if (
      unresolvedOperation &&
      !retriesUncertainOperation &&
      !admitsBehindQueuedSteer
    ) {
      throw new DomainError(
        "operation_outcome_uncertain",
        "A prior operation must be reconciled before another mutation can be applied.",
      );
    }
    if (operation.kind === "set_agent_tool_policy") {
      return this.#setAgentToolPolicy(scope, applicationThreadId, operation);
    }
    if (operation.kind === "deliver") {
      return this.#deliver(scope, applicationThreadId, operation);
    }
    if (operation.kind === "steer_queued_input") {
      return this.#steerQueuedInput(scope, applicationThreadId, operation);
    }
    if (operation.kind === "move_draft") {
      const aggregate = this.input.inventory.getThread(
        scope,
        applicationThreadId,
      );
      if (
        aggregate.thread.availability !== "available" ||
        aggregate.inventory.inventoryState === "archived"
      ) {
        throw new DomainError(
          "invalid_transition",
          "Only an available, unarchived draft can change workspaces.",
        );
      }
      await this.input.lifecycle.moveServerDraftWorkspace(
        scope,
        applicationThreadId,
        {
          workspaceId: operation.workspaceId,
          expectedThreadRevision: operation.expectedThreadRevision,
          mutationId: operation.mutationId,
        },
      );
      await this.input.publishThreadSnapshot(scope, applicationThreadId);
      return { status: "completed" };
    }
    if (operation.kind === "interrupt") {
      return this.#interrupt(scope, applicationThreadId, operation);
    }
    if (operation.kind === "respond") {
      return this.#respond(scope, applicationThreadId, operation);
    }
    return this.#perform(scope, applicationThreadId, operation);
  }

  async #sendDirect(
    scope: RequestScope,
    input: {
      readonly initiator: ToolInitiator;
      readonly targetThreadId: string;
      readonly message: string;
      readonly callback?: boolean;
      readonly mutationId: string;
    },
  ): Promise<AgentThreadDirectSendResult> {
    // Resolve durable caller provenance through the server-derived scope. A
    // caller cannot smuggle browser-selected ownership into this boundary.
    if (input.initiator.kind === "thread_agent") {
      const source = this.input.inventory.getThread(scope, input.initiator.sourceThreadId).thread;
      this.input.inventory.assertWorkspaceActive(scope, source.workspaceId);
    }
    const aggregate = this.input.inventory.getThread(
      scope,
      input.targetThreadId,
    );
    this.input.inventory.assertWorkspaceActive(scope, aggregate.thread.workspaceId);
    const target = this.input.bindings.getTarget(scope, input.targetThreadId);
    if (input.callback === true && input.initiator.kind !== "thread_agent") {
      throw new DomainError(
        "invalid_transition",
        "Completion callbacks are available only to thread-agent callers.",
      );
    }
    if (
      input.callback === true &&
      input.initiator.kind === "thread_agent" &&
      input.initiator.sourceThreadId === input.targetThreadId
    ) {
      throw new DomainError(
        "invalid_transition",
        "A thread cannot register a completion callback to itself.",
      );
    }
    if (
      !hasDeliverableComposerInput({
        text: input.message,
        contextExcerpts: [],
      })
    ) {
      throw new DomainError(
        "invalid_transition",
        "The agent-control message is empty.",
      );
    }
    if (
      aggregate.thread.availability !== "available" ||
      aggregate.inventory.inventoryState === "archived" ||
      aggregate.inventory.inventoryState === "snoozed"
    ) {
      throw new DomainError(
        "invalid_transition",
        "Input cannot be delivered in the current thread state.",
      );
    }
    if (
      this.input.operations.findUncertainThreadOperation(
        scope,
        input.targetThreadId,
      ) ||
      this.input.operations.hasPendingMaterializationSteer(
        scope,
        input.targetThreadId,
      ) ||
      this.#hasActiveQueuedInput(scope, input.targetThreadId)
    ) {
      throw new DomainError(
        "invalid_transition",
        "The target thread has pending or recovery-required work.",
      );
    }
    const existingCallback = this.#callbacks.findForTargetOperation(
      scope,
      input.targetThreadId,
      input.mutationId,
    );
    const callbackCallerThreadId =
      input.callback === true && input.initiator.kind === "thread_agent"
        ? input.initiator.sourceThreadId
        : undefined;
    let callbackId: string | undefined;
    if (callbackCallerThreadId !== undefined) {
      if (
        existingCallback !== undefined &&
        existingCallback.callerThreadId !== callbackCallerThreadId
      ) {
        throw new DomainError(
          "conflict",
          "The send operation already has a different completion callback.",
        );
      }
      callbackId = existingCallback?.id ?? randomUUID();
    } else if (existingCallback !== undefined) {
      throw new DomainError(
        "conflict",
        "The send operation callback preference does not match its durable registration.",
      );
    }
    if (target.backingState === "unbound") {
      const common = {
        prompt: input.message,
        mutationId: input.mutationId,
        expectedThreadRevision: aggregate.thread.revision,
      };
      const result =
        input.initiator.kind === "thread_agent"
          ? await this.input.lifecycle.startAgentControlFirstSend(
              scope,
              input.targetThreadId,
              {
                ...common,
                initiatingAgentThreadId: input.initiator.sourceThreadId,
                ...(callbackId === undefined
                  ? {}
                  : {
                      completionCallback: {
                        id: callbackId,
                        callerThreadId: input.initiator.sourceThreadId,
                      },
                    }),
              },
            )
          : await this.input.lifecycle.startPrincipalClientFirstSend(
              scope,
              input.targetThreadId,
              {
                ...common,
                initiatingToolClientId: input.initiator.clientId,
              },
            );
      if (result.status === "recovery_required") {
        await this.input.publishThreadSnapshot(scope, input.targetThreadId);
        await this.#changed(scope, input.targetThreadId);
        return {
          status: "recovery_required",
          operationId: input.mutationId,
          retryable: result.retryable,
          ...(callbackId === undefined ? {} : { callbackId }),
        };
      }
      if (result.status === "aborted") {
        if (callbackId !== undefined) {
          this.#callbacks.cancelRegistered(scope, callbackId, {
            cancelledAt: this.#now(),
            reason: "The target send aborted before authoritative acceptance.",
            cancellationMutationId: `${callbackId}:target_send_aborted`,
          });
        }
        await this.input.publishThreadSnapshot(scope, input.targetThreadId);
        await this.#changed(scope, input.targetThreadId);
        return { status: "aborted", operationId: input.mutationId };
      }
      this.#ownDetachedPublication(async () => {
        let runtime: AcquiredThreadRuntime | undefined;
        try {
          // First-send lifecycle owns the provisional backend identity through
          // durable acceptance. Once bound, immediately establish the ordinary
          // runtime owner so an unselected agent-created thread publishes its
          // live run state through the application-wide activity stream. This
          // continuation is owned but detached because observation must not
          // delay the already-authoritative accepted delivery receipt.
          runtime = await this.#acquireActiveWorkspaceRuntime(
            scope,
            input.targetThreadId,
          );
        } catch (error) {
          // The durable snapshot/application publication can still converge
          // the bound inventory even if live runtime observation is currently
          // unavailable.
          this.#reportPublicationError(error);
        }
        try {
          await this.input.publishThreadSnapshot(scope, input.targetThreadId);
          await this.#changed(scope, input.targetThreadId);
        } finally {
          // Keep the runtime loaded until the application summary has captured
          // the actor state. Active actors then retain themselves until their
          // terminal run-state publication and normal retention cleanup.
          runtime?.release();
        }
      });
      return {
        status: "delivery_accepted",
        operationId: input.mutationId,
        ...(callbackId === undefined ? {} : { callbackId }),
      };
    }
    if (target.backingState !== "bound") {
      throw new DomainError(
        "invalid_transition",
        "The target thread is being created or requires recovery.",
      );
    }
    const runtime = await this.#acquireActiveWorkspaceRuntime(
      scope,
      input.targetThreadId,
    );
    try {
      const submit = runtime.hub.snapshot?.capabilities.deliveryModes.find(
        ({ id }) => id === "submit",
      );
      if (
        (runtime.actor.timeline.runState !== "idle" &&
          runtime.actor.timeline.runState !== "failed") ||
        !submit?.available
      ) {
        throw new DomainError(
          "invalid_transition",
          submit?.unavailableReason?.text ??
            "Send is available only while the target thread is idle.",
        );
      }
    } finally {
      runtime.release();
    }
    const queued = await this.input.queue.enqueue(scope, input.targetThreadId, {
      mutationId: input.mutationId,
      text: input.message,
      contextExcerpts: [],
      attachmentIds: [],
      taskReferences: [],
      source:
        input.initiator.kind === "thread_agent"
          ? {
              kind: "agent_control",
              expectedThreadRevision: aggregate.thread.revision,
              initiatingAgentThreadId: input.initiator.sourceThreadId,
              ...(callbackId === undefined
                ? {}
                : {
                    completionCallback: {
                      id: callbackId,
                      callerThreadId: input.initiator.sourceThreadId,
                    },
                  }),
            }
          : {
              kind: "principal_client_control",
              expectedThreadRevision: aggregate.thread.revision,
              initiatingToolClientId: input.initiator.clientId,
            },
      now: this.#now(),
    });
    await this.input.publishThreadSnapshot(scope, input.targetThreadId);
    await this.#changed(scope, input.targetThreadId);
    return {
      status: "delivery_accepted",
      operationId: queued.item.mutationId,
      ...(callbackId === undefined ? {} : { callbackId }),
    };
  }

  async #cancelQueuedInput(
    scope: RequestScope,
    applicationThreadId: string,
    operation: Extract<
      ThreadApplicationOperation,
      { readonly kind: "cancel_queued_input" }
    >,
  ): Promise<ThreadApplicationMutationResult> {
    const result = await this.input.queue.cancelUserInput(
      scope,
      applicationThreadId,
      operation.queuedInputId,
      {
        mutationId: operation.mutationId,
        expectedThreadRevision: operation.expectedThreadRevision,
        now: this.#now(),
      },
    );
    return {
      status: "queue_cancelled",
      queuedInputId: result.item.id,
      mutationId: operation.mutationId,
      threadRevision: result.threadRevision,
      queue: [...result.queue],
    };
  }

  async #steerQueuedInput(
    scope: RequestScope,
    applicationThreadId: string,
    operation: Extract<
      ThreadApplicationOperation,
      { readonly kind: "steer_queued_input" }
    >,
  ): Promise<ThreadApplicationMutationResult> {
    const replay = this.input.operations.findSteer(scope, operation.mutationId);
    if (!replay) {
      await this.#assertNormalizedSteerAvailable(scope, applicationThreadId);
    }
    const result = await this.input.queue.steerUserInput(
      scope,
      applicationThreadId,
      operation.queuedInputId,
      {
        mutationId: operation.mutationId,
        expectedThreadRevision: operation.expectedThreadRevision,
      },
    );
    if (result.status === "restored") {
      throw new DomainError(
        "invalid_transition",
        "The backend proved that queued-input Steer was not accepted.",
      );
    }
    return result.status === "accepted"
      ? {
          status: "queue_steer_accepted",
          queuedInputId: operation.queuedInputId,
          operationId: operation.mutationId,
          threadRevision: result.threadRevision,
          queue: [...result.queue],
        }
      : result.status === "pending_materialization"
        ? {
            status: "queue_steer_pending_materialization",
            queuedInputId: operation.queuedInputId,
            operationId: operation.mutationId,
            threadRevision: result.threadRevision,
            queue: [...result.queue],
          }
        : {
            status: "queue_steer_recovery_required",
            queuedInputId: operation.queuedInputId,
            operationId: operation.mutationId,
            retryable: result.retryable,
            threadRevision: result.threadRevision,
            queue: [...result.queue],
          };
  }

  async #restoreQueuedInput(
    scope: RequestScope,
    applicationThreadId: string,
    operation: Extract<
      ThreadApplicationOperation,
      { readonly kind: "restore_queued_input" }
    >,
  ): Promise<ThreadApplicationMutationResult> {
    const result = await this.input.queue.restoreUserInput(
      scope,
      applicationThreadId,
      operation.queuedInputId,
      {
        mutationId: operation.mutationId,
        expectedThreadRevision: operation.expectedThreadRevision,
        expectedDraftRevision: operation.expectedDraftRevision,
        now: this.#now(),
      },
    );
    await this.input.publishThreadSnapshot(scope, applicationThreadId);
    await this.#changed(scope, applicationThreadId);
    return {
      status: "queue_restored",
      queuedInputId: result.item.id,
      mutationId: operation.mutationId,
      threadRevision: result.threadRevision,
      queue: [...result.queue],
      draft: authoritativeDeliveryDraft(result.draft),
    };
  }

  async #assertNormalizedSteerAvailable(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    if (
      this.input.operations.hasPendingMaterializationSteer(
        scope,
        applicationThreadId,
      )
    ) {
      throw new DomainError(
        "invalid_transition",
        "Wait for the previous steering input to appear before steering again.",
      );
    }
    const aggregate = this.input.inventory.getThread(
      scope,
      applicationThreadId,
    );
    if (
      aggregate.thread.availability !== "available" ||
      aggregate.inventory.inventoryState === "archived" ||
      aggregate.thread.backingState !== "bound"
    ) {
      throw new DomainError(
        "invalid_transition",
        "The active backend turn cannot be steered.",
      );
    }
    const runtime = await this.#acquireActiveWorkspaceRuntime(
      scope,
      applicationThreadId,
    );
    try {
      const steer = runtime.hub.snapshot?.capabilities.deliveryModes.find(
        ({ id }) => id === "steer",
      );
      if (
        !steer?.available ||
        runtime.actor.timeline.runState !== "running" ||
        (steer.steerTarget === "turn" && !runtime.actor.timeline.activeTurnId)
      ) {
        throw new DomainError(
          "invalid_transition",
          steer?.unavailableReason?.text ??
            "The active backend turn cannot be steered.",
        );
      }
    } finally {
      runtime.release();
    }
  }

  async #respond(
    scope: RequestScope,
    applicationThreadId: string,
    operation: Extract<
      ThreadApplicationOperation,
      { readonly kind: "respond" }
    >,
    preparedResponse?: PreparedInteractionResponse,
  ): Promise<ThreadApplicationMutationResult> {
    const existing = this.input.operations.findInteractionResponse(
      scope,
      operation.operationId,
    );
    if (existing && existing.interactionId !== operation.interactionId) {
      throw new DomainError(
        "conflict",
        "The operation ID is already used by another interaction response.",
      );
    }
    const prepared =
      existing === undefined
        ? (preparedResponse ??
          this.input.interactions.prepareResponse(
            scope,
            applicationThreadId,
            operation.operationId,
            operation.interactionId,
            operation.response,
          ))
        : undefined;
    if (prepared?.persistence === "ephemeral") {
      return this.#respondEphemeral(scope, applicationThreadId, prepared);
    }
    const receipt = this.input.operations.prepareRecoverableInteractionResponse(
      scope,
      applicationThreadId,
      {
        operationId: operation.operationId,
        interactionId: operation.interactionId,
        response: operation.response,
        ...(prepared ? { backendResponse: prepared.backendResponse } : {}),
        now: this.#now(),
      },
    );
    if (receipt.state === "accepted") {
      this.#ownAcceptedInteractionPublication(scope, applicationThreadId);
      return { status: "completed" };
    }
    const backendResponse =
      receipt.backendResponse ??
      (() => {
        throw new Error("interaction_response_backend_payload_missing");
      })();
    if (receipt.state === "uncertain") {
      if (!receipt.backendResponse) {
        throw new Error(
          "uncertain_interaction_response_backend_payload_missing",
        );
      }
      const reconciliation = await this.#reconcileInteractionResponse(
        scope,
        applicationThreadId,
        receipt.backendResponse,
      );
      if (reconciliation === "accepted") {
        this.input.operations.acceptInteractionResponse(
          scope,
          operation.operationId,
        );
        this.#ownAcceptedInteractionPublication(scope, applicationThreadId);
        return { status: "completed" };
      }
      if (reconciliation === "unknown") {
        await this.input.publishThreadSnapshot(scope, applicationThreadId);
        await this.#changed(scope, applicationThreadId);
        return { status: "recovery_required", retryable: true };
      }
    }
    this.input.operations.markInteractionResponseStarted(
      scope,
      operation.operationId,
    );
    try {
      await this.input.interactions.respondPrepared(
        scope,
        applicationThreadId,
        { owner: "provider", persistence: "durable", backendResponse },
      );
    } catch (error) {
      if (
        error instanceof DomainError ||
        (error instanceof BackendError && !error.crossedSubmissionBoundary)
      ) {
        this.input.operations.rejectInteractionResponseProvenNotApplied(
          scope,
          operation.operationId,
        );
        throw error;
      }
      if (error instanceof BackendError && error.lateMutationReconciliation) {
        this.#ownLateInteractionResponseReconciliation(
          scope,
          applicationThreadId,
          operation,
          error.lateMutationReconciliation,
        );
      }
      await this.input.publishThreadSnapshot(scope, applicationThreadId);
      await this.#changed(scope, applicationThreadId);
      return { status: "recovery_required", retryable: true };
    }
    this.input.operations.acceptInteractionResponse(
      scope,
      operation.operationId,
    );
    this.#ownAcceptedInteractionPublication(scope, applicationThreadId);
    return { status: "completed" };
  }

  async #respondEphemeral(
    scope: RequestScope,
    applicationThreadId: string,
    prepared: Extract<
      PreparedInteractionResponse,
      { readonly persistence: "ephemeral" }
    >,
  ): Promise<ThreadApplicationMutationResult> {
    try {
      await this.input.interactions.respondPrepared(
        scope,
        applicationThreadId,
        prepared,
      );
    } catch (error) {
      if (
        error instanceof DomainError ||
        (error instanceof BackendError && !error.crossedSubmissionBoundary)
      ) {
        throw error;
      }
      return { status: "recovery_required", retryable: false };
    }
    return { status: "completed" };
  }

  async #reconcileInteractionResponse(
    scope: RequestScope,
    applicationThreadId: string,
    response: InteractionResponseInput,
  ): Promise<"accepted" | "not_applied" | "unknown"> {
    const runtime = await this.input.runtimes.acquire(
      scope,
      applicationThreadId,
    );
    try {
      return (await runtime.actor.reconcileInteractionResponse(response))
        .outcome;
    } finally {
      runtime.release();
    }
  }

  #ownLateInteractionResponseReconciliation(
    scope: RequestScope,
    applicationThreadId: string,
    operation: Extract<
      ThreadApplicationOperation,
      { readonly kind: "respond" }
    >,
    reconciliation: Promise<{
      readonly outcome: "accepted" | "not_applied" | "unknown";
    }>,
  ): void {
    this.#ownDetachedPublication(async () => {
      const result = await reconciliation;
      if (result.outcome !== "accepted") return;
      const accepted =
        this.input.operations.acceptInteractionResponseIfUncertain(
          scope,
          applicationThreadId,
          {
            operationId: operation.operationId,
            interactionId: operation.interactionId,
            response: operation.response,
          },
        );
      if (!accepted) return;
      await this.input.publishThreadSnapshot(scope, applicationThreadId);
      await this.#changed(scope, applicationThreadId);
    });
  }

  #ownAcceptedInteractionPublication(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    this.#ownDetachedPublication(async () => {
      await this.input.publishThreadSnapshot(scope, applicationThreadId);
      await this.#changed(scope, applicationThreadId);
    });
  }

  async #recoverCurrent(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ThreadApplicationMutationResult> {
    this.input.inventory.getThread(scope, applicationThreadId);
    const unresolved = this.input.operations.findUncertainThreadOperation(
      scope,
      applicationThreadId,
    );
    if (!unresolved) {
      const queued = this.input.operations.database.prepare(`
        SELECT id FROM queued_inputs
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ? AND state = 'uncertain'
        ORDER BY sequence LIMIT 1
      `).get(scope.tenantId, scope.principalId, applicationThreadId) as
        { readonly id: string } | undefined;
      if (queued) {
        const result = await this.input.queue.reconcileUncertain(
          scope, applicationThreadId, queued.id,
        );
        await this.input.publishThreadSnapshot(scope, applicationThreadId);
        await this.#changed(scope, applicationThreadId);
        return result.state === "uncertain"
          ? { status: "recovery_required", retryable: true }
          : { status: "completed" };
      }
      const fork = this.input.forks.recoverActive(scope, applicationThreadId);
      if (fork) {
        const result = await fork;
        await this.input.publishThreadSnapshot(scope, applicationThreadId);
        await this.#changed(scope, applicationThreadId);
        return result.status === "recovery_required"
          ? { status: "recovery_required", retryable: result.retryable }
          : result.status === "aborted"
            ? { status: "aborted", diagnostic: result.diagnostic }
            : { status: "completed" };
      }
      const creation = this.input.lifecycle.recoverActiveFirstSend(
        scope,
        applicationThreadId,
      );
      if (!creation) {
        await this.input.publishThreadSnapshot(scope, applicationThreadId);
        await this.#changed(scope, applicationThreadId);
        return { status: "completed" };
      }
      const result = await creation;
      await this.input.publishThreadSnapshot(scope, applicationThreadId);
      await this.#changed(scope, applicationThreadId);
      return result.status === "recovery_required"
        ? {
            status: "recovery_required",
            retryable: result.retryable,
          }
        : { status: "completed" };
    }
    if (unresolved.operationKind === "conversation_steer") {
      const steer = this.input.operations.getSteer(
        scope,
        unresolved.mutationId,
      );
      if (steer.source === "queued_input") {
        const result = await this.input.queue.steerUserInput(
          scope,
          applicationThreadId,
          steer.queuedInputId,
          {
            mutationId: steer.mutationId,
            expectedThreadRevision: steer.expectedThreadRevision,
          },
        );
        if (result.status === "accepted") {
          return {
            status: "queue_steer_accepted",
            queuedInputId: steer.queuedInputId,
            operationId: steer.applicationOperationId,
            threadRevision: result.threadRevision,
            queue: [...result.queue],
          };
        }
        if (result.status === "restored") {
          return {
            status: "queue_steer_restored",
            queuedInputId: steer.queuedInputId,
            operationId: steer.applicationOperationId,
            threadRevision: result.threadRevision,
            queue: [...result.queue],
          };
        }
        if (result.status === "pending_materialization") {
          return {
            status: "queue_steer_pending_materialization",
            queuedInputId: steer.queuedInputId,
            operationId: steer.applicationOperationId,
            threadRevision: result.threadRevision,
            queue: [...result.queue],
          };
        }
        return {
          status: "queue_steer_recovery_required",
          queuedInputId: steer.queuedInputId,
          operationId: steer.applicationOperationId,
          retryable: result.retryable,
          threadRevision: result.threadRevision,
          queue: [...result.queue],
        };
      }
      return this.#reconcileSteer(scope, unresolved.mutationId);
    }
    if (unresolved.operationKind === "conversation_interrupt") {
      return this.#interrupt(scope, applicationThreadId, {
        kind: "interrupt",
        operationId: unresolved.mutationId,
      });
    }
    if (
      unresolved.operationKind === "conversation_rename" ||
      unresolved.operationKind === "conversation_compact" ||
      unresolved.operationKind === "conversation_settings"
    ) {
      const action = this.input.operations.getBackendAction(
        scope,
        unresolved.mutationId,
      );
      return this.#perform(scope, applicationThreadId, {
        kind: "perform",
        mutationId: action.mutationId,
        expectedThreadRevision: action.expectedThreadRevision,
        ...(action.expectedSettingsRevision === undefined
          ? {}
          : {
              expectedSettingsRevision: action.expectedSettingsRevision,
            }),
        operation: action.operation,
      });
    }
    if (unresolved.operationKind === "conversation_interaction_response") {
      const response = this.input.operations.getInteractionResponse(
        scope,
        unresolved.mutationId,
      );
      if (!response.response) {
        throw new Error("uncertain_interaction_response_payload_missing");
      }
      return this.#respond(scope, applicationThreadId, {
        kind: "respond",
        operationId: response.operationId,
        interactionId: response.interactionId,
        response: response.response,
      });
    }
    throw new DomainError(
      "invalid_transition",
      "This uncertain operation cannot be recovered by the thread command.",
    );
  }

  async #deliver(
    scope: RequestScope,
    applicationThreadId: string,
    operation: Extract<
      ThreadApplicationOperation,
      { readonly kind: "deliver" }
    >,
  ): Promise<ThreadDeliveryMutationResult> {
    if (
      this.input.lifecycle.hasFirstInputMutation(scope, operation.mutationId)
    ) {
      const alreadyBound = this.input.lifecycle.isBoundFirstInputMutation(
        scope,
        operation.mutationId,
      );
      return this.#firstSend(
        scope,
        applicationThreadId,
        operation,
        !alreadyBound,
      );
    }
    const steerReplay = this.input.operations.findSteer(
      scope,
      operation.mutationId,
    );
    if (steerReplay?.source === "draft") {
      if (operation.mode !== "steer") {
        throw new DomainError(
          "conflict",
          "The delivery mutation ID belongs to a Steer operation.",
        );
      }
      {
        const replay = steerReplay;
        if (
          replay.threadId !== applicationThreadId ||
          replay.expectedThreadRevision !== operation.expectedThreadRevision ||
          replay.expectedDraftRevision !== operation.expectedDraftRevision ||
          JSON.stringify(replay.target) !== JSON.stringify(operation.steerTarget)
        ) {
          throw new DomainError(
            "conflict",
            "The delivery mutation ID was reused with different input.",
          );
        }
        if (replay.state === "accepted") {
          return {
            status: "delivery_accepted",
            operationId: replay.applicationOperationId,
            resolvedDeliveryMode: "steer",
            threadRevision: this.input.inventory.getThread(
              scope,
              applicationThreadId,
            ).thread.revision,
            draft: clearedDeliveryDraft(
              replay.expectedDraftRevision + 1,
              replay.createdAt,
            ),
          };
        }
        // Version 58 moves all new composer Steers into queued_inputs. A
        // pre-upgrade draft-source receipt may still be prepared, uncertain,
        // or awaiting provider materialization, so resume that durable record
        // through its original boundary instead of creating a second intent.
        return this.#steer(scope, applicationThreadId, operation);
      }
    }
    const queuedReplay = this.input.queue.findComposerDeliveryReplay(
      scope,
      applicationThreadId,
      {
        mutationId: operation.mutationId,
        requestedDeliveryMode: operation.mode,
        ...(operation.mode === "steer"
          ? { requestedSteerTarget: operation.steerTarget }
          : {}),
        expectedThreadRevision: operation.expectedThreadRevision,
        expectedDraftRevision: operation.expectedDraftRevision,
      },
    );
    if (queuedReplay) {
      return {
        status: "delivery_queued",
        queuedInputId: queuedReplay.id,
        resolvedDeliveryMode: queuedReplay.resolvedDeliveryMode,
        threadRevision: this.input.inventory.getThread(
          scope,
          applicationThreadId,
        ).thread.revision,
        draft: clearedDeliveryDraft(
          queuedReplay.requestedDraftRevision! + 1,
          queuedReplay.createdAt,
        ),
      };
    }
    const target = this.input.bindings.getTarget(scope, applicationThreadId);
    const inventory = this.input.inventory.getThread(
      scope,
      applicationThreadId,
    );
    if (
      inventory.thread.availability !== "available" ||
      inventory.inventory.inventoryState === "archived" ||
      inventory.inventory.inventoryState === "snoozed"
    ) {
      throw new DomainError(
        "invalid_transition",
        "Input cannot be delivered in the current thread state.",
      );
    }
    if (target.backingState === "unbound") {
      return this.#firstSend(scope, applicationThreadId, operation);
    }
    if (target.backingState !== "bound") {
      throw new DomainError(
        "invalid_transition",
        "The thread is already being created or requires recovery.",
      );
    }
    let draft!: ReturnType<InventoryRepository["getDraft"]>;
    let resolvedDeliveryMode!: "submit" | "steer" | "queue";
    let resolvedSteerTarget: SteerTarget | undefined;
    const deliverStart = Date.now();
    const runtime = await this.#acquireActiveWorkspaceRuntime(
      scope,
      applicationThreadId,
    );
    // TEMPORARY DIAGNOSTIC (SEDES_DEBUG_DELIVERY): deliver path timings.
    const debugDelivery = process.env.SEDES_DEBUG_DELIVERY
      ? (step: string, since: number) =>
          console.error(
            `[delivery] thread=${applicationThreadId} step=${step} ms=${Date.now() - since}`,
          )
      : undefined;
    debugDelivery?.("runtimes.acquire", deliverStart);
    try {
      const timeline = runtime.actor.timeline;
      const authoritativelySettled = runtime.actor.authoritativelySettled;
      const authoritativelyActive =
        timeline.runState === "running" ||
        timeline.runState === "waiting_for_approval" ||
        timeline.runState === "waiting_for_input";
      if (!authoritativelySettled && !authoritativelyActive) {
        throw new DomainError(
          "invalid_transition",
          "Input cannot be delivered while the thread state is transitional or uncertain.",
        );
      }
      const steer = runtime.hub.snapshot?.capabilities.deliveryModes.find(
        ({ id }) => id === "steer",
      );
      const currentSteerTarget: SteerTarget | undefined =
        timeline.runState === "running" && steer?.available
          ? steer.steerTarget === "conversation"
            ? { kind: "conversation" }
            : steer.steerTarget === "turn" && timeline.activeTurnId
              ? { kind: "turn", turnId: timeline.activeTurnId }
              : undefined
          : undefined;
      if (
        operation.mode === "steer" &&
        steer !== undefined &&
        operation.steerTarget?.kind !== steer?.steerTarget
      ) {
        throw new DomainError(
          "invalid_transition",
          "The requested steering target is not supported by this backend.",
        );
      }
      if (authoritativelySettled) {
        resolvedDeliveryMode = "submit";
      } else if (operation.mode === "queue") {
        resolvedDeliveryMode = "queue";
      } else if (
        operation.mode === "steer" &&
        JSON.stringify(operation.steerTarget) !== JSON.stringify(currentSteerTarget)
      ) {
        // A turn-targeted Steer may fall back to ordinary queue work, but
        // must never drift into a replacement turn.
        resolvedDeliveryMode = "queue";
      } else if (currentSteerTarget) {
        resolvedDeliveryMode = "steer";
        resolvedSteerTarget = currentSteerTarget;
      } else {
        resolvedDeliveryMode = "queue";
      }
      if (
        resolvedDeliveryMode !== "steer" &&
        this.input.operations.hasPendingMaterializationSteer(
          scope,
          applicationThreadId,
        ) &&
        this.input.operations.findPendingMaterializationSteer(
          scope,
          applicationThreadId,
        )?.source === "draft"
      ) {
        throw new DomainError(
          "invalid_transition",
          "Wait for the previous steering input to appear before delivering more input.",
        );
      }
      const projectedDelivery =
        runtime.hub.snapshot?.capabilities.deliveryModes.find(
          ({ id }) => id === resolvedDeliveryMode,
        );
      if (!projectedDelivery?.available) {
        throw new DomainError(
          "invalid_transition",
          projectedDelivery?.unavailableReason?.text ??
            "Input cannot be delivered in the current thread state.",
        );
      }
      draft = this.input.inventory.getDraft(scope, applicationThreadId);
      if (
        draft.revision !== operation.expectedDraftRevision ||
        !hasDeliverableComposerInput(draft)
      ) {
        throw new DomainError(
          "draft_revision_conflict",
          "The composer changed or is empty.",
        );
      }
    } finally {
      runtime.release();
    }
    const enqueueStart = Date.now();
    const sourceFence = {
      kind: "composer" as const,
      expectedThreadRevision: operation.expectedThreadRevision,
      expectedDraftRevision: operation.expectedDraftRevision,
    };
    const composerSource =
      resolvedDeliveryMode === "steer"
        ? ({
            ...sourceFence,
            requestedDeliveryMode: operation.mode as "submit" | "steer",
            ...(operation.mode === "steer"
              ? { requestedSteerTarget: operation.steerTarget! }
              : {}),
            resolvedDeliveryMode,
            resolvedSteerTarget: resolvedSteerTarget!,
          } as const)
        : operation.mode === "steer"
          ? ({
              ...sourceFence,
              requestedDeliveryMode: "steer",
              requestedSteerTarget: operation.steerTarget!,
              resolvedDeliveryMode,
            } as const)
          : ({
              ...sourceFence,
              requestedDeliveryMode: operation.mode,
              resolvedDeliveryMode,
            } as const);
    const queued = await this.input.queue.enqueue(scope, applicationThreadId, {
      mutationId: operation.mutationId,
      text: draft.text,
      ...(draft.selectedSkillId === null
        ? {}
        : { selectedSkillId: draft.selectedSkillId }),
      contextExcerpts: draft.contextExcerpts,
      attachmentIds: draft.attachments.map(({ id }) => id),
      taskReferences: draft.taskReferences,
      source: composerSource,
      now: this.#now(),
    });
    debugDelivery?.("queue.enqueue+dispatch", enqueueStart);
    // The durable queue owns dispatch from here and the receipt is already
    // authoritative, so return it immediately. The lightweight application
    // overlay publication runs in the background and never rebuilds transcript
    // history. A publication failure is reported, never thrown: the caller
    // would strand its composer text even though the input was accepted.
    const publishStart = Date.now();
    this.#ownDetachedPublication(async () => {
      try {
        await this.input.publishThreadSnapshot(scope, applicationThreadId);
        await this.#changed(scope, applicationThreadId);
        debugDelivery?.(
          "publishThreadSnapshot+changed(background)",
          publishStart,
        );
      } catch (error) {
        debugDelivery?.(
          "publishThreadSnapshot FAILED(background)",
          publishStart,
        );
        throw error;
      }
    });
    return {
      status: "delivery_queued",
      queuedInputId: queued.item.id,
      resolvedDeliveryMode: queued.item.resolvedDeliveryMode,
      threadRevision: this.input.inventory.getThread(scope, applicationThreadId)
        .thread.revision,
      draft: clearedDeliveryDraft(
        operation.expectedDraftRevision + 1,
        queued.item.createdAt,
      ),
    };
  }

  async #firstSend(
    scope: RequestScope,
    applicationThreadId: string,
    operation: Extract<
      ThreadApplicationOperation,
      { readonly kind: "deliver" }
    >,
    publish = true,
  ): Promise<ThreadDeliveryMutationResult> {
    const result = await this.input.lifecycle.startFirstSend(
      scope,
      applicationThreadId,
      operation,
    );
    if (result.status === "recovery_required") {
      return {
        status: "recovery_required",
        retryable: result.retryable,
        draft: authoritativeDeliveryDraft(
          this.input.inventory.getDraft(scope, applicationThreadId),
        ),
      };
    }
    if (result.status === "aborted") return { status: "aborted" };
    if (publish) {
      this.#ownDetachedPublication(async () => {
        await this.input.publishThreadSnapshot(scope, applicationThreadId);
        await this.#changed(scope, applicationThreadId);
      });
    }
    return {
      status: "delivery_accepted",
      operationId: operation.mutationId,
      resolvedDeliveryMode: "submit",
      threadRevision: this.input.inventory.getThread(scope, applicationThreadId)
        .thread.revision,
      draft: clearedDeliveryDraft(
        operation.expectedDraftRevision + 1,
        this.#now(),
      ),
    };
  }

  async #interrupt(
    scope: RequestScope,
    applicationThreadId: string,
    operation: Extract<
      ThreadApplicationOperation,
      { readonly kind: "interrupt" }
    >,
  ): Promise<ThreadApplicationMutationResult> {
    let receipt = this.input.operations.findInterrupt(
      scope,
      operation.operationId,
    );
    if (receipt && receipt.threadId !== applicationThreadId) {
      throw new DomainError(
        "conflict",
        "The operation ID is already used by another thread.",
      );
    }
    if (receipt?.state === "accepted") {
      return {
        status: "accepted",
        operationId: receipt.applicationOperationId,
      };
    }

    const runtime = await this.input.runtimes.acquire(
      scope,
      applicationThreadId,
    );
    try {
      const timeline = runtime.actor.timeline;
      if (!receipt) {
        if (
          (timeline.runState !== "running" &&
            timeline.runState !== "waiting_for_approval" &&
            timeline.runState !== "waiting_for_input") ||
          !timeline.activeTurnId
        ) {
          throw new DomainError(
            "invalid_transition",
            "There is no active turn to stop.",
          );
        }
        receipt = this.input.operations.prepareInterrupt(
          scope,
          applicationThreadId,
          {
            operationId: operation.operationId,
            expectedActiveTurnId: timeline.activeTurnId,
            now: this.#now(),
          },
        );
      }

      const stillTargetsOriginalTurn =
        (timeline.runState === "running" ||
          timeline.runState === "waiting_for_approval" ||
          timeline.runState === "waiting_for_input") &&
        timeline.activeTurnId === receipt.expectedActiveTurnId;
      const interruptInput = {
        applicationOperationId: receipt.applicationOperationId,
        expectedActiveTurnId: receipt.expectedActiveTurnId,
      };
      if (receipt.state === "uncertain") {
        let reconciliation;
        try {
          reconciliation =
            await runtime.actor.reconcileInterrupt(interruptInput);
        } catch {
          return { status: "recovery_required", retryable: true };
        }
        if (reconciliation.outcome === "unknown") {
          return { status: "recovery_required", retryable: true };
        }
        if (reconciliation.outcome === "accepted") {
          this.input.operations.acceptInterrupt(scope, operation.operationId);
          await this.#afterInterruptAccepted(
            scope,
            applicationThreadId,
            runtime.actor,
          );
          await this.input.publishThreadSnapshot(scope, applicationThreadId);
          await this.#changed(scope, applicationThreadId);
          return {
            status: "accepted",
            operationId: receipt.applicationOperationId,
          };
        }
      }
      if (
        timeline.runState === "starting" ||
        timeline.runState === "disconnected" ||
        timeline.runState === "reconciling"
      ) {
        return { status: "recovery_required", retryable: true };
      }
      if (!stillTargetsOriginalTurn) {
        this.input.operations.acceptInterrupt(scope, operation.operationId);
        await this.#afterInterruptAccepted(
          scope,
          applicationThreadId,
          runtime.actor,
        );
        await this.input.publishThreadSnapshot(scope, applicationThreadId);
        await this.#changed(scope, applicationThreadId);
        return {
          status: "accepted",
          operationId: receipt.applicationOperationId,
        };
      }

      this.input.operations.markInterruptStarted(scope, operation.operationId);
      try {
        await runtime.actor.interrupt(interruptInput);
      } catch (error) {
        if (error instanceof BackendError && !error.crossedSubmissionBoundary) {
          this.input.operations.rejectInterruptProvenNotApplied(
            scope,
            operation.operationId,
          );
          throw error;
        }
        return { status: "recovery_required", retryable: true };
      }
      this.input.operations.acceptInterrupt(scope, operation.operationId);
      const featureChanged = await this.#afterInterruptAccepted(
        scope,
        applicationThreadId,
        runtime.actor,
      );
      if (featureChanged) {
        try {
          await this.input.publishThreadSnapshot(scope, applicationThreadId);
        } catch {
          // Publishing a backend-owned feature change is best-effort after an
          // accepted interrupt.
        }
      }
      await this.#changed(scope, applicationThreadId);
      return {
        status: "accepted",
        operationId: receipt.applicationOperationId,
      };
    } finally {
      runtime.release();
    }
  }

  async #afterInterruptAccepted(
    scope: RequestScope,
    applicationThreadId: string,
    actor: ProviderFeatureMutationActor,
  ): Promise<boolean> {
    const aggregate = this.input.inventory.getThread(
      scope,
      applicationThreadId,
    );
    const provider = this.input.actionPersistence.get(
      aggregate.thread.backendInstanceId,
    );
    if (!provider) return false;
    try {
      return await provider.afterInterruptAccepted(actor);
    } catch {
      // Best-effort only — Stop remains the interrupt outcome.
      return false;
    }
  }

  async #steer(
    scope: RequestScope,
    applicationThreadId: string,
    operation: Extract<
      ThreadApplicationOperation,
      { readonly kind: "deliver" }
    >,
  ): Promise<ThreadDeliveryMutationResult> {
    // Legacy exact-turn durable-recovery path only; conversation targets did
    // not exist for these draft receipts. New composer Steers are admitted as
    // exact-target queued inputs in #deliver above.
    const draft = this.input.inventory.getDraft(scope, applicationThreadId);
    let receipt = this.input.operations.prepareSteer(
      scope,
      applicationThreadId,
      {
        mutationId: operation.mutationId,
        text: draft.text,
        ...(draft.selectedSkillId === null
          ? {}
          : { selectedSkillId: draft.selectedSkillId }),
        contextExcerpts: draft.contextExcerpts,
        attachmentIds: draft.attachments.map(({ id }) => id),
        taskReferences: draft.taskReferences,
        expectedThreadRevision: operation.expectedThreadRevision,
        expectedDraftRevision: operation.expectedDraftRevision,
        now: this.#now(),
      },
    );
    if (receipt.state === "accepted") {
      return {
        status: "delivery_accepted",
        operationId: receipt.applicationOperationId,
        resolvedDeliveryMode: "steer",
        threadRevision: this.input.inventory.getThread(
          scope,
          applicationThreadId,
        ).thread.revision,
        draft: clearedDeliveryDraft(
          receipt.expectedDraftRevision + 1,
          receipt.createdAt,
        ),
      };
    }
    if (receipt.state === "failed_unknown") {
      throw new DomainError("invalid_transition", receipt.failureDiagnostic!);
    }
    if (receipt.state === "uncertain") {
      return this.#reconcileSteer(scope, operation.mutationId);
    }
    if (receipt.state === "pending_materialization") {
      const thread = this.input.inventory.getThread(
        scope,
        applicationThreadId,
      ).thread;
      return {
        status: "delivery_pending_materialization",
        operationId: receipt.applicationOperationId,
        resolvedDeliveryMode: "steer",
        threadRevision: thread.revision,
        draft: authoritativeDeliveryDraft(
          this.input.inventory.getDraft(scope, applicationThreadId),
        ),
      };
    }
    let runtime;
    try {
      runtime = await this.#acquireActiveWorkspaceRuntime(scope, applicationThreadId);
    } catch (error) {
      this.input.operations.rejectSteerBeforeAcceptance(
        scope,
        operation.mutationId,
      );
      throw error;
    }
    let acceptedAt: number | undefined;
    let followUpOwnsRuntime = false;
    try {
      const timeline = runtime.actor.timeline;
      const projectedSteer =
        runtime.hub.snapshot?.capabilities.deliveryModes.find(
          ({ id }) => id === "steer",
        );
      if (
        !projectedSteer?.available ||
        timeline.runState !== "running" ||
        !timeline.activeTurnId
      ) {
        this.input.operations.rejectSteerBeforeAcceptance(
          scope,
          operation.mutationId,
        );
        throw new DomainError(
          "invalid_transition",
          projectedSteer?.unavailableReason?.text ??
            "The targeted turn is no longer active.",
        );
      }
      let attachmentDelivery;
      try {
        attachmentDelivery = await runtime.actor.materializeAttachments(
          receipt.attachments,
        );
      } catch (error) {
        this.input.operations.rejectSteerBeforeAcceptance(
          scope,
          operation.mutationId,
        );
        throw error;
      }
      const startedReceipt = this.input.operations.markSteerSubmissionStarted(
        scope,
        operation.mutationId,
        { kind: "turn", turnId: timeline.activeTurnId },
      );
      if (startedReceipt.source !== "draft") {
        throw new Error("draft_steer_receipt_source_mismatch");
      }
      receipt = startedReceipt;
      const accepted = await runtime.actor.steer({
        applicationOperationId: receipt.applicationOperationId,
        mutationId: receipt.mutationId,
        reconciliationToken: receipt.reconciliationToken,
        target: receipt.target!,
        text: draft.text,
        ...(receipt.selectedSkillId === null
          ? {}
          : { selectedSkillId: receipt.selectedSkillId }),
        contextExcerpts: receipt.contextExcerpts,
        attachments: attachmentDelivery.attachments,
        ...(attachmentDelivery.attachments.length > 0
          ? {
              attachmentBytes: attachmentDelivery.canonicalBytes,
              attachmentEvidence: attachmentDelivery.canonicalEvidence,
            }
          : {}),
        taskContexts: receipt.taskContexts,
      });
      if (
        accepted.reconciliationToken !== receipt.reconciliationToken ||
        accepted.completionCorrelation !== receipt.applicationOperationId
      ) {
        return this.#deliveryRecovery(scope, applicationThreadId, false);
      }
      const acceptedAtNow = this.#now();
      if (accepted.status === "pending_materialization") {
        this.input.operations.markSteerPendingMaterialization(
          scope,
          operation.mutationId,
          acceptedAtNow,
        );
        this.#ownDetachedPublication(async () => {
          await this.input.publishThreadSnapshot(scope, applicationThreadId);
          await this.#changed(scope, applicationThreadId);
        });
        return {
          status: "delivery_pending_materialization",
          operationId: receipt.applicationOperationId,
          resolvedDeliveryMode: "steer",
          threadRevision: this.input.inventory.getThread(
            scope,
            applicationThreadId,
          ).thread.revision,
          draft: authoritativeDeliveryDraft(
            this.input.inventory.getDraft(scope, applicationThreadId),
          ),
        };
      }
      acceptedAt = acceptedAtNow;
      this.input.operations.database.transaction(() => {
        this.input.operations.acceptSteer(
          scope,
          operation.mutationId,
          acceptedAtNow,
        );
        this.input.completions.recordAccepted(scope, applicationThreadId, {
          operationId: receipt.applicationOperationId,
          acceptedAt: acceptedAtNow,
          backendCorrelation: accepted.completionCorrelation,
          attachmentIds: receipt.attachments.map(({ id }) => id),
        });
      })();
      followUpOwnsRuntime = true;
      this.#ownDetachedPublication(async () => {
        const failures: unknown[] = [];
        try {
          await runtime.actor.replayAuthoritativeCompletions();
        } catch (error) {
          failures.push(error);
        }
        try {
          await this.input.publishThreadSnapshot(scope, applicationThreadId);
          await this.#changed(scope, applicationThreadId);
        } catch (error) {
          failures.push(error);
        } finally {
          runtime.release();
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Accepted steer follow-up did not finish cleanly.",
          );
        }
      });
    } catch (error) {
      if (error instanceof BackendError && !error.crossedSubmissionBoundary) {
        this.input.operations.rejectSteerBeforeAcceptance(
          scope,
          operation.mutationId,
        );
        throw error;
      }
      return this.#deliveryRecovery(scope, applicationThreadId, false);
    } finally {
      if (!followUpOwnsRuntime) runtime.release();
    }
    if (acceptedAt === undefined) throw new Error("steer_accept_time_missing");
    return {
      status: "delivery_accepted",
      operationId: operation.mutationId,
      resolvedDeliveryMode: "steer",
      threadRevision: this.input.inventory.getThread(scope, applicationThreadId)
        .thread.revision,
      draft: clearedDeliveryDraft(
        operation.expectedDraftRevision + 1,
        acceptedAt,
      ),
    };
  }

  async #reconcileSteer(
    scope: RequestScope,
    mutationId: string,
  ): Promise<ThreadDeliveryMutationResult> {
    const receipt = this.input.operations.getSteer(scope, mutationId);
    if (receipt.source !== "draft") {
      throw new Error("draft_steer_receipt_source_mismatch");
    }
    let reconciliation;
    try {
      reconciliation = await this.input.queueGateway.reconcileSubmission(
        scope,
        receipt.threadId,
        {
          applicationOperationId: receipt.applicationOperationId,
          reconciliationToken: receipt.reconciliationToken,
          ...(receipt.attachments.length > 0
            ? { attachments: receipt.attachments }
            : {}),
          ...(receipt.target ? { steerTarget: receipt.target } : {}),
        },
      );
    } catch {
      return this.#deliveryRecovery(scope, receipt.threadId, false);
    }
    if (reconciliation.status === "unresolved") {
      if (receipt.state === "pending_materialization") {
        return {
          status: "delivery_pending_materialization",
          operationId: receipt.applicationOperationId,
          resolvedDeliveryMode: "steer",
          threadRevision: this.input.inventory.getThread(
            scope,
            receipt.threadId,
          ).thread.revision,
          draft: authoritativeDeliveryDraft(
            this.input.inventory.getDraft(scope, receipt.threadId),
          ),
        };
      }
      return this.#deliveryRecovery(scope, receipt.threadId, false);
    }
    if (reconciliation.status === "failed_unknown") {
      if (receipt.target?.kind !== "conversation") {
        return this.#deliveryRecovery(scope, receipt.threadId, false);
      }
      const diagnostic = `Delivery outcome is unknown; the backend may already have received this input. Nothing was resent. Review the preserved draft before sending again. ${reconciliation.diagnostic.text}`.slice(0, 500);
      this.input.operations.failSteerUnknown(scope, mutationId, diagnostic, this.#now());
      await this.input.publishThreadSnapshot(scope, receipt.threadId);
      await this.#changed(scope, receipt.threadId);
      throw new DomainError("invalid_transition", diagnostic);
    }
    if (reconciliation.status === "not_accepted") {
      if (receipt.state === "pending_materialization") {
        this.input.operations.rejectPendingMaterializationSteer(
          scope,
          mutationId,
          this.#now(),
        );
        await this.input.publishThreadSnapshot(scope, receipt.threadId);
        await this.#changed(scope, receipt.threadId);
      } else {
        this.input.operations.rejectSteerBeforeAcceptance(scope, mutationId);
      }
      return this.#deliveryRecovery(
        scope,
        receipt.threadId,
        reconciliation.retryable,
      );
    }
    const acceptedAt = this.#now();
    this.input.operations.database.transaction(() => {
      this.input.operations.acceptSteer(scope, mutationId, acceptedAt);
      this.input.completions.recordAccepted(scope, receipt.threadId, {
        operationId: receipt.applicationOperationId,
        acceptedAt,
        backendCorrelation: receipt.applicationOperationId,
        attachmentIds: receipt.attachments.map(({ id }) => id),
      });
      if (reconciliation.completionIdentity && reconciliation.backendTurn) {
        this.input.completions.observeCompletion(
          scope,
          receipt.threadId,
          receipt.applicationOperationId,
          {
            completionIdentity: reconciliation.completionIdentity,
            observedAt: acceptedAt,
            createAttention: true,
          },
        );
      }
    })();
    await this.#changed(scope, receipt.threadId);
    return {
      status: "delivery_accepted",
      operationId: receipt.applicationOperationId,
      resolvedDeliveryMode: "steer",
      threadRevision: this.input.inventory.getThread(scope, receipt.threadId)
        .thread.revision,
      draft: clearedDeliveryDraft(
        receipt.expectedDraftRevision + 1,
        acceptedAt,
      ),
    };
  }

  #deliveryRecovery(
    scope: RequestScope,
    applicationThreadId: string,
    retryable: boolean,
  ): ThreadDeliveryMutationResult {
    return {
      status: "recovery_required",
      retryable,
      draft: authoritativeDeliveryDraft(
        this.input.inventory.getDraft(scope, applicationThreadId),
      ),
    };
  }

  async #perform(
    scope: RequestScope,
    applicationThreadId: string,
    operation: PerformOperation,
  ): Promise<ThreadApplicationMutationResult> {
    if (operation.operation.action === "perform_provider_feature") {
      return this.#performProviderFeature(scope, applicationThreadId, {
        ...operation,
        operation: operation.operation,
      });
    }
    const priorReceipt = this.input.operations.findBackendAction(
      scope,
      operation.mutationId,
    );
    if (priorReceipt) {
      const replay = this.input.operations.prepareBackendAction(
        scope,
        applicationThreadId,
        {
          mutationId: operation.mutationId,
          expectedThreadRevision: operation.expectedThreadRevision,
          ...(operation.expectedSettingsRevision === undefined
            ? {}
            : {
                expectedSettingsRevision: operation.expectedSettingsRevision,
              }),
          operation: operation.operation,
          now: this.#now(),
        },
      );
      if (replay.state === "accepted") {
        return {
          status: "accepted",
          operationId: replay.applicationOperationId,
        };
      }
    }
    const aggregate = this.input.inventory.getThread(
      scope,
      applicationThreadId,
    );
    if (
      aggregate.thread.availability !== "available" ||
      aggregate.inventory.inventoryState === "archived"
    ) {
      throw new DomainError(
        "invalid_transition",
        "The requested action is unavailable in the current thread state.",
      );
    }
    const provider = this.input.actionPersistence.get(
      aggregate.thread.backendInstanceId,
    );
    if (
      operation.operation.action === "set_setting" &&
      (aggregate.thread.backingState === "unbound" ||
        provider?.isLocalOperation?.(operation.operation) === true)
    ) {
      if (
        (aggregate.thread.backingState !== "unbound" &&
          aggregate.thread.backingState !== "bound") ||
        this.input.operations.findUncertainThreadOperation(
          scope,
          applicationThreadId,
        ) !== undefined ||
        this.#hasActiveQueuedInput(scope, applicationThreadId)
      ) {
        throw new DomainError(
          "invalid_transition",
          "The setting cannot change while the thread has active durable work.",
        );
      }
      if (aggregate.thread.backingState === "bound") {
        const runtime = await this.#acquireActiveWorkspaceRuntime(
          scope,
          applicationThreadId,
        );
        try {
          if (
            runtime.actor.timeline.runState !== "idle" &&
            runtime.actor.timeline.runState !== "failed"
          ) {
            throw new DomainError(
              "invalid_transition",
              "The setting cannot change while a turn is active.",
            );
          }
        } finally {
          runtime.release();
        }
      }
      if (!provider) {
        throw new DomainError(
          "invalid_transition",
          "The backend setting persistence provider is unavailable.",
        );
      }
      if (operation.expectedSettingsRevision === undefined) {
        throw new DomainError(
          "invalid_transition",
          "The setting mutation requires an expected settings revision.",
        );
      }
      const expectedSettingsRevision = operation.expectedSettingsRevision;
      validateStagedSetting(
        await this.input.presentation.read(scope, applicationThreadId),
        operation.operation,
      );
      const receipt = this.input.operations.prepareBackendAction(
        scope,
        applicationThreadId,
        {
          mutationId: operation.mutationId,
          expectedThreadRevision: operation.expectedThreadRevision,
          expectedSettingsRevision,
          operation: operation.operation,
          now: this.#now(),
        },
      );
      if (receipt.state === "accepted") {
        return {
          status: "accepted",
          operationId: receipt.applicationOperationId,
        };
      }
      if (
        receipt.state !== "prepared" ||
        aggregate.thread.revision !== operation.expectedThreadRevision
      ) {
        if (receipt.state === "prepared") {
          this.input.operations.rejectBackendActionProvenNotApplied(
            scope,
            operation.mutationId,
          );
        }
        throw new DomainError(
          "conflict",
          "The thread changed in another client.",
        );
      }
      try {
        this.input.operations.database.transaction(() => {
          provider.persistAccepted(scope, applicationThreadId, {
            mutationId: operation.mutationId,
            expectedThreadRevision: operation.expectedThreadRevision,
            settingsGuard: {
              kind: "staged",
              expectedRevision: expectedSettingsRevision,
            },
            operation: operation.operation,
            now: this.#now(),
          });
          this.input.operations.acceptBackendAction(
            scope,
            operation.mutationId,
          );
        })();
      } catch (error) {
        this.input.operations.rejectBackendActionProvenNotApplied(
          scope,
          operation.mutationId,
        );
        throw error;
      }
      await provider.afterPersistAccepted(
        scope,
        applicationThreadId,
        operation.operation,
      );
      await this.input.publishThreadSnapshot(scope, applicationThreadId);
      return {
        status: "accepted",
        operationId: receipt.applicationOperationId,
      };
    }
    if (
      operation.operation.action === "rename" &&
      aggregate.thread.backingState === "unbound"
    ) {
      if (aggregate.thread.revision !== operation.expectedThreadRevision) {
        throw new DomainError(
          "conflict",
          "The thread changed in another client.",
        );
      }
      this.input.inventory.renameThread(scope, applicationThreadId, {
        title: operation.operation.title,
        expectedRevision: operation.expectedThreadRevision,
        mutationId: operation.mutationId,
        now: this.#now(),
      });
      await this.input.publishThreadSnapshot(scope, applicationThreadId);
      return {
        status: "accepted",
        operationId: operation.mutationId,
      };
    } else {
      const receipt = this.input.operations.prepareBackendAction(
        scope,
        applicationThreadId,
        {
          mutationId: operation.mutationId,
          expectedThreadRevision: operation.expectedThreadRevision,
          ...(operation.expectedSettingsRevision === undefined
            ? {}
            : {
                expectedSettingsRevision: operation.expectedSettingsRevision,
              }),
          operation: operation.operation,
          now: this.#now(),
        },
      );
      if (receipt.state === "accepted") {
        return {
          status: "accepted",
          operationId: receipt.applicationOperationId,
        };
      }
      if (
        receipt.state === "prepared" &&
        aggregate.thread.revision !== operation.expectedThreadRevision
      ) {
        if (receipt.state === "prepared") {
          this.input.operations.rejectBackendActionProvenNotApplied(
            scope,
            operation.mutationId,
          );
        }
        throw new DomainError(
          "conflict",
          "The thread changed in another client.",
        );
      }
      const runtime = await this.#acquireActiveWorkspaceRuntime(
        scope,
        applicationThreadId,
      );
      let crossedBackendBoundary = receipt.state === "uncertain";
      try {
        const provider = this.input.actionPersistence.get(
          aggregate.thread.backendInstanceId,
        );
        if (!provider) {
          throw new DomainError(
            "invalid_transition",
            "The backend action persistence provider is unavailable.",
          );
        }
        const driverAction = provider.driverAction(
          operation.operation,
          receipt.applicationOperationId,
        );
        if (receipt.state === "uncertain") {
          let reconciliation;
          try {
            reconciliation = await runtime.actor.reconcileAction(driverAction);
          } catch {
            return { status: "recovery_required", retryable: true };
          }
          if (reconciliation.outcome === "unknown") {
            return { status: "recovery_required", retryable: true };
          }
          if (reconciliation.outcome === "accepted") {
            const acceptedAt = this.#now();
            try {
              this.input.operations.database.transaction(() => {
                provider.persistAccepted(scope, applicationThreadId, {
                  mutationId: operation.mutationId,
                  expectedThreadRevision: aggregate.thread.revision,
                  settingsGuard: { kind: "proven_applied" },
                  operation: operation.operation,
                  now: acceptedAt,
                });
                this.input.operations.acceptBackendAction(
                  scope,
                  operation.mutationId,
                );
              })();
              await this.input.publishThreadSnapshot(
                scope,
                applicationThreadId,
              );
              await this.#changed(scope, applicationThreadId);
            } catch {
              return { status: "recovery_required", retryable: true };
            }
            return {
              status: "accepted",
              operationId: receipt.applicationOperationId,
            };
          }
          if (aggregate.thread.revision !== receipt.expectedThreadRevision) {
            this.input.operations.rejectBackendActionProvenNotApplied(
              scope,
              operation.mutationId,
            );
            throw new DomainError(
              "conflict",
              "The thread changed before the backend action could be retried.",
            );
          }
        }
        const backendCapabilities = await runtime.actor.backendCapabilities();
        if (!backendCapabilities.actions.includes(driverAction.action)) {
          throw new DomainError(
            "invalid_transition",
            "The backend does not support the requested action.",
          );
        }
        if (
          driverAction.action !== "rename" &&
          runtime.actor.timeline.runState !== "idle" &&
          runtime.actor.timeline.runState !== "failed"
        ) {
          throw new DomainError(
            "invalid_transition",
            "The requested action requires an idle thread.",
          );
        }
        this.input.operations.markBackendActionStarted(
          scope,
          operation.mutationId,
        );
        crossedBackendBoundary = true;
        try {
          await runtime.actor.perform(driverAction);
        } catch (error) {
          if (
            error instanceof BackendError &&
            !error.crossedSubmissionBoundary
          ) {
            this.input.operations.rejectBackendActionProvenNotApplied(
              scope,
              operation.mutationId,
            );
            throw error;
          }
          return { status: "recovery_required", retryable: true };
        }
        const acceptedAt = this.#now();
        try {
          this.input.operations.database.transaction(() => {
            provider.persistAccepted(scope, applicationThreadId, {
              mutationId: operation.mutationId,
              expectedThreadRevision:
                receipt.state === "uncertain"
                  ? aggregate.thread.revision
                  : operation.expectedThreadRevision,
              settingsGuard: { kind: "proven_applied" },
              operation: operation.operation,
              now: acceptedAt,
            });
            this.input.operations.acceptBackendAction(
              scope,
              operation.mutationId,
            );
          })();
        } catch {
          return { status: "recovery_required", retryable: true };
        }
        await this.input.publishThreadSnapshot(scope, applicationThreadId);
      } catch (error) {
        if (!crossedBackendBoundary) {
          this.input.operations.rejectBackendActionProvenNotApplied(
            scope,
            operation.mutationId,
          );
        }
        throw error;
      } finally {
        runtime.release();
      }
    }
    await this.#changed(scope, applicationThreadId);
    return { status: "accepted", operationId: operation.mutationId };
  }

  #hasActiveQueuedInput(
    scope: RequestScope,
    applicationThreadId: string,
  ): boolean {
    const row = this.input.operations.database
      .prepare(
        `
          SELECT 1 AS present
          FROM queued_inputs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
            AND state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
          LIMIT 1
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      { readonly present: 1 } | undefined;
    return row !== undefined;
  }

  async #setAgentToolPolicy(
    scope: RequestScope,
    applicationThreadId: string,
    operation: Extract<
      ThreadApplicationOperation,
      { readonly kind: "set_agent_tool_policy" }
    >,
  ): Promise<ThreadApplicationMutationResult> {
    const aggregate = this.input.inventory.getThread(
      scope,
      applicationThreadId,
    );
    const currentPolicy = this.input.agentToolPolicies.get(
      scope,
      applicationThreadId,
    );
    // CLI credentials identify the thread, not its grants. Only presentation
    // changes require replacing the runtime that captured its CLI environment.
    const liveCliPolicy =
      currentPolicy.presentation.surface === "cli" &&
      operation.presentation.surface === "cli" &&
      currentPolicy.presentation.mode === operation.presentation.mode;
    if (
      aggregate.thread.availability !== "available" ||
      aggregate.inventory.inventoryState === "archived" ||
      (aggregate.thread.backingState !== "unbound" &&
        aggregate.thread.backingState !== "bound") ||
      (!liveCliPolicy && this.#hasActiveQueuedInput(scope, applicationThreadId))
    ) {
      throw new DomainError(
        "invalid_transition",
        "Agent tool exposure can change only while the thread is idle.",
      );
    }
    if (aggregate.thread.backingState === "bound" && !liveCliPolicy) {
      try {
        await this.input.runtimes.runWithRuntimeRetired(
          scope,
          applicationThreadId,
          async () => {
            return this.input.agentToolPolicies.update(
              scope,
              applicationThreadId,
              {
                expectedRevision: operation.expectedPolicyRevision,
                enabled: operation.enabled,
                enabledToolIds: operation.enabledToolIds,
                presentation: operation.presentation,
                accessBoundary: operation.accessBoundary,
                now: this.#now(),
              },
            );
          },
        );
      } catch (error) {
        if (error instanceof ThreadRuntimeNotIdleError) {
          throw new DomainError(
            "invalid_transition",
            "Agent tool exposure can change only while the thread is idle.",
            false,
            { cause: error },
          );
        }
        if (error instanceof ThreadRuntimeRetirementUnprovenError) {
          throw new DomainError(
            "operation_outcome_uncertain",
            "Sedes could not prove that the thread runtime stopped before changing agent tool exposure. Restart Sedes before retrying.",
            false,
            { cause: error },
          );
        }
        throw error;
      }
    } else {
      this.input.agentToolPolicies.update(scope, applicationThreadId, {
        expectedRevision: operation.expectedPolicyRevision,
        enabled: operation.enabled,
        enabledToolIds: operation.enabledToolIds,
        presentation: operation.presentation,
        accessBoundary: operation.accessBoundary,
        now: this.#now(),
      });
    }
    await this.input.publishThreadSnapshot(scope, applicationThreadId);
    return { status: "accepted", operationId: operation.mutationId };
  }

  async #performProviderFeature(
    scope: RequestScope,
    applicationThreadId: string,
    operation: PerformOperation & {
      readonly operation: Extract<
        PerformOperation["operation"],
        { readonly action: "perform_provider_feature" }
      >;
    },
  ): Promise<ThreadApplicationMutationResult> {
    const aggregate = this.input.inventory.getThread(
      scope,
      applicationThreadId,
    );
    const provider = this.input.actionPersistence.get(
      aggregate.thread.backendInstanceId,
    );
    const replay = provider?.replayProviderFeature?.(
      scope,
      applicationThreadId,
      {
        mutationId: operation.mutationId,
        expectedThreadRevision: operation.expectedThreadRevision,
        operation: operation.operation,
      },
    );
    if (replay) {
      return {
        status: "accepted",
        operationId: replay.applicationOperationId,
      };
    }
    const concurrency = provider?.providerFeatureConcurrency(
      operation.operation.feature,
      operation.operation.actionId,
    );
    const allowsActiveTurn =
      concurrency?.kind === "concurrent" && concurrency.activeTurn;
    const allowsQueuedInput =
      concurrency?.kind === "concurrent" && concurrency.queuedInput;
    const requiresRuntime =
      provider?.requiresRuntimeProviderFeature?.(operation.operation) === true;
    if (
      aggregate.thread.availability !== "available" ||
      aggregate.inventory.inventoryState === "archived" ||
      (aggregate.thread.backingState !== "unbound" &&
        aggregate.thread.backingState !== "bound") ||
      this.input.operations.findUncertainThreadOperation(
        scope,
        applicationThreadId,
      ) !== undefined ||
      (!allowsQueuedInput &&
        this.#hasActiveQueuedInput(scope, applicationThreadId))
    ) {
      throw new DomainError(
        "invalid_transition",
        "The requested provider feature is unavailable in the current thread state.",
      );
    }
    if (aggregate.thread.backingState === "bound" && !allowsActiveTurn) {
      const runtime = await this.#acquireActiveWorkspaceRuntime(
        scope,
        applicationThreadId,
      );
      try {
        if (
          runtime.actor.timeline.runState !== "idle" &&
          runtime.actor.timeline.runState !== "failed"
        ) {
          throw new DomainError(
            "invalid_transition",
            "Provider features cannot change while a turn is active.",
          );
        }
      } finally {
        runtime.release();
      }
    }
    if (requiresRuntime && aggregate.thread.backingState !== "bound") {
      throw new DomainError(
        "invalid_transition",
        "The provider feature requires a bound thread.",
      );
    }
    const presentation = await this.input.presentation.read(
      scope,
      applicationThreadId,
    );
    const capability = presentation.providerFeatureCapabilities.find(
      ({ ref }) =>
        ref.featureId === operation.operation.feature.featureId &&
        ref.schemaVersion === operation.operation.feature.schemaVersion,
    );
    const action = capability?.operations.find(
      ({ actionId }) => actionId === operation.operation.actionId,
    );
    if (
      capability?.availability !== "available" ||
      capability.revision !== operation.operation.expectedFeatureRevision ||
      !action ||
      (action.confirmation === "explicit" &&
        operation.operation.confirmed !== true)
    ) {
      throw new DomainError(
        "invalid_transition",
        "The requested provider feature action is unavailable or stale.",
      );
    }
    if (!provider?.performProviderFeature) {
      throw new DomainError(
        "invalid_transition",
        "The provider feature persistence boundary is unavailable.",
      );
    }
    if (requiresRuntime) {
      const runtime = await this.#acquireActiveWorkspaceRuntime(
        scope,
        applicationThreadId,
      );
      try {
        const result = await provider.performProviderFeature(
          scope,
          applicationThreadId,
          {
            mutationId: operation.mutationId,
            expectedThreadRevision: operation.expectedThreadRevision,
            operation: operation.operation,
            now: this.#now(),
            mutateExternal: (external) =>
              runtime.actor.mutateProviderFeature(external),
          },
        );
        if ("status" in result) {
          return {
            status: "recovery_required",
            retryable: result.retryable,
          };
        }
        await this.input.publishThreadSnapshot(scope, applicationThreadId);
        await this.#changed(scope, applicationThreadId);
        return {
          status: "accepted",
          operationId: result.applicationOperationId,
        };
      } finally {
        runtime.release();
      }
    }
    const result = await provider.performProviderFeature(
      scope,
      applicationThreadId,
      {
        mutationId: operation.mutationId,
        expectedThreadRevision: operation.expectedThreadRevision,
        operation: operation.operation,
        now: this.#now(),
      },
    );
    if ("status" in result) {
      return {
        status: "recovery_required",
        retryable: result.retryable,
      };
    }
    await this.input.publishThreadSnapshot(scope, applicationThreadId);
    await this.#changed(scope, applicationThreadId);
    return {
      status: "accepted",
      operationId: result.applicationOperationId,
    };
  }

  async #changed(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    await this.input.onThreadChanged?.(scope, applicationThreadId);
  }

  #ownDetachedPublication(publication: () => Promise<void>): void {
    let completion!: Promise<void>;
    completion = Promise.resolve()
      .then(publication)
      .catch((error) => this.#reportPublicationError(error))
      .finally(() => this.#detachedPublications.delete(completion));
    this.#detachedPublications.add(completion);
  }

  #reportPublicationError(error: unknown): void {
    try {
      this.input.onPublicationError?.(error);
    } catch {
      // Diagnostics cannot escape or prevent shutdown from draining the
      // accepted publication's owned continuation.
    }
  }

  #now(): number {
    return this.input.now?.() ?? Date.now();
  }
}
