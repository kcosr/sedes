import type { UsageService } from "../usage/usage-service.js";
import { createHash } from "node:crypto";
import type { BackendCapabilityDocument } from "../../shared/protocol/backend.js";
import type { BackendEffectiveSettings } from "../../shared/protocol/backend.js";
import type {
  ThreadApplicationMutationResult,
  ThreadApplicationOperation,
} from "../../shared/protocol/api.js";
import {
  normalizedThreadSnapshotSchema,
  type BackendInteraction,
  type ComposerCommandDescriptor,
  type ComposerSkillCatalog,
  type ComposerSkillDescriptor,
  type ConversationHistoryWindow,
  type NormalizedThreadRecovery,
  type NormalizedThreadAttention,
  type NormalizedThreadAgentToolPolicy,
  type NormalizedThreadExecutionWorkspace,
  type NormalizedThreadSavedAgentOrigin,
  type NormalizedThreadSnapshot,
  type NormalizedThreadEvent,
  type NormalizedThreadSummary,
  type QueuedInputSummary,
  type SettingDescriptor,
  type ThreadCapabilityDocument,
  type ThreadRunState,
  type ThreadSettingsSnapshot,
  type UsageSnapshot,
} from "../../shared/protocol/conversation.js";
import type { BackendPresentation } from "../../shared/protocol/conversation.js";
import type {
  ProviderFeatureCapability,
  ProviderFeatureStateEnvelope,
} from "../../shared/protocol/provider-feature.js";
import { BackendError } from "../backends/contracts.js";
import type {
  AcquireConversationActorInput,
  ConversationActorManager,
} from "./conversation-actor-manager.js";
import type { ConversationActorSnapshotState } from "./conversation-actor.js";
import { projectedThreadForkSourceCapability } from "./conversation-projector.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ThreadActionPersistenceProvider } from "./thread-mutation-gateway.js";
import type { ComposerAttachmentDeliveryService } from "../composer-attachments/composer-attachment-delivery-service.js";
import { COMPOSER_ATTACHMENT_POLICY } from "../../shared/protocol/composer-attachments.js";
import { hasDeliverableComposerInput } from "../../shared/protocol/conversation.js";
import { interactionRunState } from "./thread-interaction-run-state.js";

type InventoryThread = Omit<
  NormalizedThreadSummary,
  "runState" | "queuedInputCount"
>;

export interface AuthorizedThreadApplicationState {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  /** Server-only backend authority used to resolve module contributions. */
  readonly backendInstanceId: string;
  /** Server-derived immutable binding identity, projected only for display. */
  readonly backendSessionId?: string;
  readonly thread: InventoryThread;
  readonly executionWorkspace: NormalizedThreadExecutionWorkspace;
  readonly createdWithAgent?: NormalizedThreadSavedAgentOrigin;
  readonly workspace: NormalizedThreadSnapshot["workspace"];
  readonly environment: NormalizedThreadSnapshot["environment"];
  readonly draft: NormalizedThreadSnapshot["draft"];
  readonly stashes: NormalizedThreadSnapshot["stashes"];
  readonly agentTools: NormalizedThreadAgentToolPolicy;
  readonly attention: NormalizedThreadAttention;
}

/**
 * The inventory reader is the authorization boundary. Implementations must
 * scope the lookup by both tenant and owner; the service verifies the returned
 * ownership again before consulting any runtime dependency.
 */
export interface ThreadApplicationInventoryReader {
  getAuthorized(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<AuthorizedThreadApplicationState>;
}

export type ThreadConversationCapture =
  | {
      readonly status: "connected";
      readonly state: ConversationActorSnapshotState;
    }
  | {
      readonly status: "disconnected";
    };

export interface ThreadApplicationConversationReader {
  capture(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ThreadConversationCapture>;
}

export interface ThreadApplicationActorTargetResolver {
  resolve(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<AcquireConversationActorInput>;
}

/**
 * Resolves the immutable application binding and borrows the process-wide
 * single-writer actor only for the duration of a snapshot capture.
 */
export class ActorBackedThreadApplicationConversationReader implements ThreadApplicationConversationReader {
  readonly #actors: Pick<ConversationActorManager, "acquire">;
  readonly #targets: ThreadApplicationActorTargetResolver;

  constructor(input: {
    readonly actors: Pick<ConversationActorManager, "acquire">;
    readonly targets: ThreadApplicationActorTargetResolver;
  }) {
    this.#actors = input.actors;
    this.#targets = input.targets;
  }

  async capture(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ThreadConversationCapture> {
    let target: AcquireConversationActorInput;
    try {
      target = await this.#targets.resolve(scope, applicationThreadId);
      assertActorTargetScope(scope, applicationThreadId, target);
      const acquired = await this.#actors.acquire(target, {
        idleRelease: "retain",
      });
      try {
        return {
          status: "connected",
          state: await acquired.actor.captureSnapshotState(),
        };
      } finally {
        acquired.release();
      }
    } catch (error) {
      if (
        error instanceof BackendError &&
        (error.category === "unavailable" || error.category === "overloaded")
      ) {
        return { status: "disconnected" };
      }
      throw error;
    }
  }
}

export interface ThreadApplicationQueueReader {
  list(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<readonly QueuedInputSummary[]>;
}

export interface ThreadApplicationPresentation {
  readonly revision: string;
  readonly backend: BackendPresentation;
  readonly interactionMode: "interactive" | "read_only";
  readonly settings: ThreadSettingsSnapshot;
  readonly settingDescriptors: readonly SettingDescriptor[];
  /** Settings applied locally to the next provider submission. */
  readonly nextTurnSettingIds?: readonly SettingDescriptor["id"][];
  /** Provider execution policy for attach/enable/run automation controls. */
  readonly automationAllowed?: boolean;
  readonly providerFeatureCapabilities: readonly ProviderFeatureCapability[];
  readonly providerFeatureStates: readonly ProviderFeatureStateEnvelope[];
  readonly composerCommands: readonly ComposerCommandDescriptor[];
  readonly skills: readonly ComposerSkillDescriptor[];
}

export interface ThreadApplicationPresentationReader {
  read(
    scope: RequestScope,
    applicationThreadId: string,
    effectiveSettings?: BackendEffectiveSettings,
  ): Promise<ThreadApplicationPresentation>;
  /** Recompose durable presentation using only an already-loaded catalog. */
  readCached(
    scope: RequestScope,
    applicationThreadId: string,
    effectiveSettings?: BackendEffectiveSettings,
  ): Promise<ThreadApplicationPresentation>;
}

export interface ThreadApplicationRecoveryReader {
  read(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<NormalizedThreadRecovery | undefined>;
  hasPendingDelivery(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<boolean>;
}

export interface ThreadApplicationInteractionReader {
  listPending(
    scope: RequestScope,
    applicationThreadId: string,
  ): BackendInteraction[];
}

export interface ThreadApplicationMutationGateway {
  mutate(
    scope: RequestScope,
    applicationThreadId: string,
    operation: ThreadApplicationOperation,
  ): Promise<ThreadApplicationMutationResult>;
}

export interface ThreadApplicationHistoryBoundary {
  operational(state: ConversationActorSnapshotState | undefined): boolean;
  window(
    scope: RequestScope,
    applicationThreadId: string,
    state: ConversationActorSnapshotState | undefined,
    snapshot: NormalizedThreadSnapshot,
  ): ConversationHistoryWindow;
}

const emptyBackendCapabilities: BackendCapabilityDocument = {
  revision: "unbound",
  actions: [],
  deliveryModes: [],
  steerTarget: null,
  composerAttachments: { fileStaging: false, nativeImage: false },
  nonblockingQuestions: false,
  providerOutputArtifacts: { nativeImage: false },
  supportsHistory: false,
  branching: {
    availability: "unavailable",
    reason: { text: "This thread has no backend conversation to fork." },
  },
  interactionKinds: [],
  usageAccounting: "unsupported",
      usageSections: [],
  effectiveSettings: {},
};

export class ThreadApplicationService {
  readonly #inventory: ThreadApplicationInventoryReader;
  readonly #conversations: ThreadApplicationConversationReader;
  readonly #queue: ThreadApplicationQueueReader;
  readonly #presentation: ThreadApplicationPresentationReader;
  readonly #recovery: ThreadApplicationRecoveryReader;
  readonly #interactions: ThreadApplicationInteractionReader;
  readonly #actionPersistence: ReadonlyMap<
    string,
    ThreadActionPersistenceProvider
  >;
  readonly #attachmentDelivery: Pick<
    ComposerAttachmentDeliveryService,
    "supports"
  >;
  #mutations?: ThreadApplicationMutationGateway;
  #history?: ThreadApplicationHistoryBoundary;

  readonly #usage: Pick<UsageService, "registerVisibleTurns">;
  constructor(input: {
    readonly usage: Pick<UsageService, "registerVisibleTurns">;
    readonly inventory: ThreadApplicationInventoryReader;
    readonly conversations: ThreadApplicationConversationReader;
    readonly queue: ThreadApplicationQueueReader;
    readonly presentation: ThreadApplicationPresentationReader;
    readonly recovery: ThreadApplicationRecoveryReader;
    readonly interactions: ThreadApplicationInteractionReader;
    readonly actionPersistence: ReadonlyMap<
      string,
      ThreadActionPersistenceProvider
    >;
    readonly attachmentDelivery: Pick<
      ComposerAttachmentDeliveryService,
      "supports"
    >;
    readonly mutations?: ThreadApplicationMutationGateway;
  }) {
    this.#usage = input.usage;
    this.#inventory = input.inventory;
    this.#conversations = input.conversations;
    this.#queue = input.queue;
    this.#presentation = input.presentation;
    this.#recovery = input.recovery;
    this.#interactions = input.interactions;
    this.#actionPersistence = input.actionPersistence;
    this.#attachmentDelivery = input.attachmentDelivery;
    this.#mutations = input.mutations;
  }

  bindMutations(mutations: ThreadApplicationMutationGateway): void {
    if (this.#mutations) {
      throw new Error("thread_application_mutations_already_bound");
    }
    this.#mutations = mutations;
  }

  bindHistory(history: ThreadApplicationHistoryBoundary): void {
    if (this.#history) {
      throw new Error("thread_application_history_already_bound");
    }
    this.#history = history;
  }

  async skills(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ComposerSkillCatalog> {
    await this.#authorize(scope, applicationThreadId);
    const presentation = await this.#presentation.read(
      scope,
      applicationThreadId,
    );
    return { skills: [...presentation.skills] };
  }

  async snapshot(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<NormalizedThreadSnapshot> {
    const inventory = await this.#authorize(scope, applicationThreadId);
    const capture =
      inventory.thread.backingState === "bound" && inventory.thread.available
        ? await this.#conversations.capture(scope, applicationThreadId)
        : ({ status: "disconnected" } as const);
    return this.#composeSnapshot(
      scope,
      applicationThreadId,
      inventory,
      capture,
    );
  }

  /**
   * Captures only the application-owned projection around the current actor
   * state. Overlay publication must not rebuild or validate transcript
   * history merely because durable application state changed.
   */
  async applicationState(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<
    Extract<
      NormalizedThreadEvent,
      { readonly type: "application_state_changed" }
    >["state"]
  > {
    const inventory = await this.#authorize(scope, applicationThreadId);
    if (inventory.thread.backingState === "bound") {
      throw new Error("thread_application_bound_state_requires_actor_capture");
    }
    return this.#composeApplicationState(
      scope,
      applicationThreadId,
      inventory,
      { status: "disconnected" },
    );
  }

  async applicationStateFromActorCapture(
    scope: RequestScope,
    applicationThreadId: string,
    actor: ConversationActorSnapshotState,
  ): Promise<
    Extract<
      NormalizedThreadEvent,
      { readonly type: "application_state_changed" }
    >["state"]
  > {
    const inventory = await this.#authorize(scope, applicationThreadId);
    if (inventory.thread.backingState !== "bound") {
      throw new Error("thread_application_capture_requires_bound_thread");
    }
    return this.#composeApplicationState(
      scope,
      applicationThreadId,
      inventory,
      {
        status: "connected",
        state: actor,
      },
    );
  }

  /**
   * Composes the application-owned snapshot fields around the exact actor
   * capture carried by a projection replacement. The event bridge must use
   * this path so it never stamps a later actor capture with an older
   * projection generation.
   */
  async snapshotFromActorCapture(
    scope: RequestScope,
    applicationThreadId: string,
    actor: ConversationActorSnapshotState,
  ): Promise<NormalizedThreadSnapshot> {
    const inventory = await this.#authorize(scope, applicationThreadId);
    if (inventory.thread.backingState !== "bound") {
      throw new Error("thread_application_capture_requires_bound_thread");
    }
    return this.#composeSnapshot(scope, applicationThreadId, inventory, {
      status: "connected",
      state: actor,
    });
  }

  /**
   * Capability document and provider feature state envelopes from ONE
   * targeted-state pass around the exact actor capture. The bridge's
   * capabilities_changed path — the frequent backend-driven feature
   * transition signal (for example a Codex Goal status change) — uses this
   * so each event costs one authorization and one composition, not two.
   */
  async capabilitiesAndProviderFeaturesFromActorCapture(
    scope: RequestScope,
    applicationThreadId: string,
    actor: ConversationActorSnapshotState,
  ): Promise<{
    readonly threadRevision: number;
    readonly capabilities: NormalizedThreadSnapshot["capabilities"];
    readonly providerFeatures: NormalizedThreadSnapshot["providerFeatures"];
    readonly interactions: NormalizedThreadSnapshot["interactions"];
  }> {
    const inventory = await this.#authorize(scope, applicationThreadId);
    if (inventory.thread.backingState !== "bound") {
      throw new Error("thread_application_capture_requires_bound_thread");
    }
    const composed = await this.#composeTargetedState(
      scope,
      applicationThreadId,
      inventory,
      { status: "connected", state: actor },
    );
    return {
      threadRevision: inventory.thread.threadRevision,
      capabilities: composed.capabilities,
      providerFeatures: [...composed.presentation.providerFeatureStates],
      interactions: composed.interactions,
    };
  }

  async forkSourceFromActorCapture(
    scope: RequestScope,
    applicationThreadId: string,
    actor: ConversationActorSnapshotState,
  ): Promise<NormalizedThreadSnapshot["forkSource"]> {
    const inventory = await this.#authorize(scope, applicationThreadId);
    if (inventory.thread.backingState !== "bound") {
      throw new Error("thread_application_capture_requires_bound_thread");
    }
    return (
      await this.#composeTargetedState(scope, applicationThreadId, inventory, {
        status: "connected",
        state: actor,
      })
    ).forkSource;
  }

  async #composeTargetedState(
    scope: RequestScope,
    applicationThreadId: string,
    inventory: AuthorizedThreadApplicationState,
    capture: ThreadConversationCapture,
    presentationSource: "fresh" | "cached" = "fresh",
  ) {
    const [queue, presentation, recovery, pendingDelivery] = await Promise.all([
      this.#queue.list(scope, applicationThreadId),
      this.#presentation[
        presentationSource === "fresh" ? "read" : "readCached"
      ](
        scope,
        applicationThreadId,
        capture.status === "connected"
          ? capture.state.backendCapabilities.effectiveSettings
          : undefined,
      ),
      this.#recovery.read(scope, applicationThreadId),
      this.#recovery.hasPendingDelivery(scope, applicationThreadId),
    ]);
    const interactions = this.#interactions.listPending(
      scope,
      applicationThreadId,
    );
    assertCompositionScope(inventory, interactions);
    const actor = capture.status === "connected" ? capture.state : undefined;
    const runState = deriveRunState(
      inventory.thread.backingState,
      actor?.timeline.runState,
      interactions,
      capture.status === "disconnected",
    );
    const backendCapabilities =
      actor?.backendCapabilities ?? emptyBackendCapabilities;
    const actionPersistence = this.#actionPersistence.get(
      inventory.backendInstanceId,
    );
    if (!actionPersistence) {
      throw new Error("thread_application_action_persistence_missing");
    }
    const historyOperational = this.#history?.operational(actor) === true;
    const capabilities = composeCapabilities({
      inventory,
      queue,
      runState,
      ...(actor?.timeline.activeTurnId
        ? { activeTurnId: actor.timeline.activeTurnId }
        : {}),
      backendCapabilities,
      presentation,
      recovery,
      pendingDelivery,
      interactions,
      providerFeatureConcurrency: (feature, actionId) =>
        actionPersistence.providerFeatureConcurrency(feature, actionId),
      historyOperational,
      attachmentStagingAvailable: this.#attachmentDelivery.supports(
        scope,
        inventory.environment.id,
      ),
    });
    let forkSourceUnavailableReason: string | undefined;
    if (inventory.thread.backingState !== "bound") {
      forkSourceUnavailableReason =
        "The source thread is not bound to a backend conversation.";
    } else if (inventory.thread.inventoryState === "archived") {
      forkSourceUnavailableReason = "Archived threads cannot be forked.";
    } else if (!inventory.workspace.available) {
      forkSourceUnavailableReason = "The project is unavailable for new work.";
    } else if (queue.length > 0) {
      forkSourceUnavailableReason =
        "Resolve or cancel queued source work before forking.";
    } else if (recovery !== undefined) {
      forkSourceUnavailableReason =
        "Resolve the thread's uncertain operation before forking.";
    } else if (pendingDelivery) {
      forkSourceUnavailableReason =
        "Wait for the pending steering input to appear before forking.";
    }
    const projectedForkSource = projectedThreadForkSourceCapability({
      branching: backendCapabilities.branching,
      sourceRunState: runState,
    });
    const forkSource = forkSourceUnavailableReason
      ? {
          selectedCompletedTurn: {
            available: false as const,
            unavailableReason: { text: forkSourceUnavailableReason },
          },
          latestProviderSnapshot: {
            available: false as const,
            unavailableReason: { text: forkSourceUnavailableReason },
          },
        }
      : projectedForkSource;
    return {
      queue,
      presentation,
      recovery,
      interactions,
      actor,
      runState,
      backendCapabilities,
      historyOperational,
      capabilities,
      forkSource,
    };
  }

  async #composeSnapshot(
    scope: RequestScope,
    applicationThreadId: string,
    inventory: AuthorizedThreadApplicationState,
    capture: ThreadConversationCapture,
  ): Promise<NormalizedThreadSnapshot> {
    const {
      queue,
      presentation,
      recovery,
      interactions,
      actor,
      runState,
      historyOperational,
      capabilities,
      forkSource,
    } = await this.#composeTargetedState(
      scope,
      applicationThreadId,
      inventory,
      capture,
    );
    const timeline = actor?.timeline;
    const snapshotWithoutHistory = normalizedThreadSnapshotSchema.parse({
      thread: {
        ...inventory.thread,
        runState,
        queuedInputCount: queue.length,
      },
      executionWorkspace: inventory.executionWorkspace,
      ...(inventory.createdWithAgent
        ? { createdWithAgent: inventory.createdWithAgent }
        : {}),
      ...(inventory.backendSessionId
        ? { backendSessionId: inventory.backendSessionId }
        : {}),
      workspace: inventory.workspace,
      environment: inventory.environment,
      draft: inventory.draft,
      stashes: inventory.stashes,
      composerCommands: presentation.composerCommands,
      agentTools: inventory.agentTools,
      orderedTurnIds: timeline?.orderedTurnIds ?? [],
      turnsById: timeline?.turnsById ?? {},
      forkSource,
      forksByTurnId: Object.fromEntries(
        Object.values(timeline?.turnsById ?? {}).map((turn) => {
          const turnEligible =
            turn.status === "completed" && turn.endedBy === "agent_settled";
          const available =
            turnEligible && forkSource.selectedCompletedTurn.available;
          const unavailableReason = turnEligible
            ? forkSource.selectedCompletedTurn.unavailableReason?.text
            : "Only a successfully completed turn can be forked.";
          return [
            turn.id,
            {
              sourceTurnId: turn.id,
              expectedTurnRevision: turn.revision,
              available,
              ...(unavailableReason
                ? { unavailableReason: { text: unavailableReason } }
                : {}),
            },
          ];
        }),
      ),
      itemsById: timeline?.itemsById ?? {},
      history: { hasOlder: false },
      runState,
      ...(timeline?.backgroundActivity ? { backgroundActivity: timeline.backgroundActivity } : {}),
      ...(timeline?.activeTurnId
        ? { activeTurnId: timeline.activeTurnId }
        : {}),
      queue,
      capabilities,
      settings: presentation.settings,
      providerFeatures: presentation.providerFeatureStates,
      usage: actor?.usage ?? {},
      interactions,
      ...(recovery ? { recovery } : {}),
      attention: inventory.attention,
    });
    this.#usage.registerVisibleTurns(scope, applicationThreadId, Object.values(snapshotWithoutHistory.turnsById));
    if (!historyOperational) return snapshotWithoutHistory;
    return normalizedThreadSnapshotSchema.parse({
      ...snapshotWithoutHistory,
      history: this.#history!.window(
        scope,
        applicationThreadId,
        actor,
        snapshotWithoutHistory,
      ),
    });
  }

  async #composeApplicationState(
    scope: RequestScope,
    applicationThreadId: string,
    inventory: AuthorizedThreadApplicationState,
    capture: ThreadConversationCapture,
  ): Promise<
    Extract<
      NormalizedThreadEvent,
      { readonly type: "application_state_changed" }
    >["state"]
  > {
    const {
      queue,
      presentation,
      recovery,
      interactions,
      runState,
      capabilities,
      forkSource,
    } = await this.#composeTargetedState(
      scope,
      applicationThreadId,
      inventory,
      capture,
      "cached",
    );
    return {
      thread: {
        ...inventory.thread,
        runState,
        queuedInputCount: queue.length,
      },
      executionWorkspace: inventory.executionWorkspace,
      ...(inventory.createdWithAgent
        ? { createdWithAgent: inventory.createdWithAgent }
        : {}),
      workspace: inventory.workspace,
      environment: inventory.environment,
      draft: inventory.draft,
      stashes: inventory.stashes,
      composerCommands: [...presentation.composerCommands],
      agentTools: inventory.agentTools,
      forkSource,
      queue: [...queue],
      capabilities,
      settings: presentation.settings,
      providerFeatures: [...presentation.providerFeatureStates],
      interactions,
      ...(recovery ? { recovery } : {}),
      attention: inventory.attention,
    };
  }

  async mutate(
    scope: RequestScope,
    applicationThreadId: string,
    operation: ThreadApplicationOperation,
  ): Promise<ThreadApplicationMutationResult> {
    await this.#authorize(scope, applicationThreadId);
    if (!this.#mutations) {
      throw new Error("thread_application_mutations_unavailable");
    }
    return this.#mutations.mutate(scope, applicationThreadId, operation);
  }

  async #authorize(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<AuthorizedThreadApplicationState> {
    const state = await this.#inventory.getAuthorized(
      scope,
      applicationThreadId,
    );
    if (
      state.tenantId !== scope.tenantId ||
      state.ownerPrincipalId !== scope.principalId ||
      !state.backendInstanceId ||
      state.thread.id !== applicationThreadId
    ) {
      throw new Error("thread_application_scope_mismatch");
    }
    return state;
  }
}

function assertActorTargetScope(
  scope: RequestScope,
  applicationThreadId: string,
  target: AcquireConversationActorInput,
): void {
  if (
    target.scope.tenantId !== scope.tenantId ||
    target.scope.principalId !== scope.principalId ||
    target.binding.tenantId !== scope.tenantId ||
    target.binding.ownerPrincipalId !== scope.principalId ||
    target.binding.applicationThreadId !== applicationThreadId
  ) {
    throw new Error("thread_application_actor_target_scope_mismatch");
  }
}

function assertCompositionScope(
  inventory: AuthorizedThreadApplicationState,
  interactions: readonly BackendInteraction[],
): void {
  if (
    inventory.thread.workspaceId !== inventory.workspace.id ||
    inventory.workspace.environmentId !== inventory.environment.id ||
    interactions.some(({ threadId }) => threadId !== inventory.thread.id)
  ) {
    throw new Error("thread_application_composition_scope_mismatch");
  }
}

function deriveRunState(
  backingState: InventoryThread["backingState"],
  actorState: ThreadRunState | undefined,
  interactions: readonly BackendInteraction[],
  disconnected: boolean,
): ThreadRunState {
  if (backingState === "creating") return "starting";
  if (backingState === "creation_unknown") return "failed";
  if (backingState === "unbound") return "idle";
  if (disconnected || !actorState) return "disconnected";
  return interactionRunState(actorState, interactions);
}

function composeCapabilities(input: {
  readonly inventory: AuthorizedThreadApplicationState;
  readonly queue: readonly QueuedInputSummary[];
  readonly runState: ThreadRunState;
  readonly activeTurnId?: string;
  readonly backendCapabilities: BackendCapabilityDocument;
  readonly presentation: ThreadApplicationPresentation;
  readonly recovery?: NormalizedThreadRecovery;
  readonly pendingDelivery: boolean;
  readonly interactions: readonly BackendInteraction[];
  readonly providerFeatureConcurrency: ThreadActionPersistenceProvider["providerFeatureConcurrency"];
  readonly historyOperational: boolean;
  readonly attachmentStagingAvailable: boolean;
}): ThreadCapabilityDocument {
  const archived = input.inventory.thread.inventoryState === "archived";
  const snoozed = input.inventory.thread.inventoryState === "snoozed";
  const available = input.inventory.thread.available && input.inventory.workspace.available;
  const bound = input.inventory.thread.backingState === "bound";
  const unbound = input.inventory.thread.backingState === "unbound";
  const interactive = input.presentation.interactionMode === "interactive";
  const idle = input.runState === "idle";
  const settled = idle || input.runState === "failed";
  const inFlight = new Set<ThreadRunState>([
    "starting",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
    "stopping",
  ]).has(input.runState);
  const mutationBlocked =
    inFlight ||
    input.runState === "disconnected" ||
    input.runState === "reconciling";
  const backendTransitioning =
    input.runState === "disconnected" || input.runState === "reconciling";
  const backendCanSubmit =
    interactive &&
    (unbound || input.backendCapabilities.deliveryModes.includes("submit"));
  // Queue events may arrive without a new capability document. Reconciliation
  // is a safe check on any bound writable conversation; the UI presents it only
  // while its authoritative queue contains uncertainty.
  const canReconcileQueue = bound && backendCanSubmit;
  const backendCanSteer =
    interactive && input.backendCapabilities.deliveryModes.includes("steer");
  const backendCanRename =
    unbound || input.backendCapabilities.actions.includes("rename");
  const turnControllable = new Set<ThreadRunState>([
    "running",
    "waiting_for_approval",
    "waiting_for_input",
  ]).has(input.runState);
  const steerAvailable =
    interactive &&
    available &&
    !archived &&
    bound &&
    input.runState === "running" &&
    (input.backendCapabilities.steerTarget === "conversation" || input.activeTurnId !== undefined) &&
    input.recovery === undefined &&
    !input.pendingDelivery &&
    input.backendCapabilities.deliveryModes.includes("steer");
  const initialSettingsReady = input.presentation.settingDescriptors
    .filter(({ requiredForFirstSubmission }) => requiredForFirstSubmission)
    .every((descriptor) => {
      const value = input.presentation.settings.values.find(
        ({ id }) => id === descriptor.id,
      )?.desiredValue;
      return (
        typeof value === "string" &&
        descriptor.options.some(
          (option) => option.available && option.value === value,
        )
      );
    });
  const settingsMutationQueueBlocked = input.queue.some(
    ({ state }) => state !== "failed",
  );
  const reason = (available: boolean, message: string) =>
    available ? {} : { unavailableReason: { text: message } };
  // A child the provider already returned finishes through recovery, and the
  // fork service refuses to discard it; an unfinished fork without one can be
  // discarded without crossing the provider boundary again.
  const discardableFork =
    input.recovery?.kind === "conversation_creation" &&
    input.recovery.creationType === "fork" &&
    !input.recovery.conversationIdentified &&
    input.recovery.phase !== "conversation_identified" &&
    input.recovery.phase !== "accepted_unpersisted";
  const operation = (
    id:
      | "interrupt"
      | "retry_submission"
      | "recover_uncertain"
      | "discard_fork"
      | "archive"
      | "settle"
      | "acknowledge_attention"
      | "remove_automation"
      | "run_automation",
    label: string,
    available: boolean,
    unavailable: string,
    destructive = false,
  ) => ({
    id,
    label: { text: label },
    destructive,
    available,
    ...reason(available, unavailable),
    parameters: { kind: "none" as const },
  });
  const operations: ThreadCapabilityDocument["operations"] = [
    {
      id: "rename",
      label: { text: "Rename" },
      destructive: false,
      available: available && !archived && !backendTransitioning && backendCanRename,
      ...reason(
        available && !archived && !backendTransitioning && backendCanRename,
        "Renaming is unavailable for this backend or while its state is being restored.",
      ),
      parameters: {
        kind: "text",
        field: "title",
        required: true,
        maximumLength: 240,
      },
    },
    {
      id: "compact",
      label: { text: "Compact" },
      destructive: false,
      available:
        available &&
        bound &&
        settled &&
        input.backendCapabilities.actions.includes("compact") &&
        !archived,
      ...reason(
        bound &&
          available &&
          settled &&
          input.backendCapabilities.actions.includes("compact") &&
          !archived,
        "Compaction requires an idle, active backend conversation.",
      ),
      parameters: {
        kind: "text",
        field: "instructions",
        required: false,
        maximumLength: 65_536,
      },
    },
    {
      id: "move_draft",
      label: { text: "Move draft" },
      destructive: false,
      available: available && unbound && !archived,
      ...reason(
        available && unbound && !archived,
        "Only an available, unbound draft can change workspaces.",
      ),
      parameters: { kind: "workspace" },
    },
    operation(
      "interrupt",
      "Stop",
      available && bound && turnControllable,
      "There is no active turn to stop.",
      true,
    ),
    operation(
      "retry_submission",
      "Retry submission",
      available && input.recovery?.submissionMayHaveBeenAccepted === true,
      "There is no unresolved submission to retry.",
    ),
    operation(
      "recover_uncertain",
      input.recovery?.kind === "conversation_creation"
        ? input.recovery.creationType === "fork"
          ? input.recovery.recoverable
            ? "Recover fork"
            : "Recovery unavailable"
          : input.recovery.submissionMayHaveBeenAccepted
            ? "Reconcile submission"
            : input.recovery.recoverable
              ? "Resume submission"
              : "Recovery unavailable"
        : "Reconcile operation",
      available && (input.recovery?.recoverable === true || (!input.recovery && canReconcileQueue)),
      input.recovery && !input.recovery.recoverable
        ? "The provider-assigned create outcome cannot be replayed or reconciled automatically."
        : "There is no recoverable operation.",
    ),
    operation(
      "discard_fork",
      "Discard this fork",
      available && discardableFork,
      "Only an unfinished fork whose provider child was not returned can be discarded.",
      true,
    ),
    operation(
      "archive",
      "Archive",
      !archived && !mutationBlocked,
      "An active or already archived thread cannot be archived.",
      true,
    ),
    operation(
      "settle",
      "Settle",
      !archived && !mutationBlocked,
      "Only an inactive, unarchived thread can be settled.",
    ),
    {
      id: "snooze",
      label: { text: "Snooze" },
      destructive: false,
      available:
        available &&
        input.inventory.thread.inventoryState === "active" &&
        !mutationBlocked,
      ...reason(
        available &&
          input.inventory.thread.inventoryState === "active" &&
          !mutationBlocked,
        "Only an inactive Active thread can be snoozed.",
      ),
      parameters: {
        kind: "date_time",
        field: "snoozedUntil",
      },
    },
    operation(
      "acknowledge_attention",
      "Acknowledge",
      Object.keys(input.inventory.attention).length > 0,
      "This thread has no pending attention.",
    ),
  ];
  const automation = input.inventory.thread.automation;
  if (automation) {
    operations.push(
      operation(
        "remove_automation",
        "Remove automation",
        available && !mutationBlocked && backendCanSubmit,
        "Automation cannot be removed during an active turn.",
        true,
      ),
      operation(
        "run_automation",
        "Run automation",
        available && settled && !archived && !snoozed && backendCanSubmit,
        "Automation requires an idle, active thread.",
      ),
    );
  } else {
    operations.push({
      id: "attach_automation",
      label: { text: "Add automation" },
      destructive: false,
      available: available && !archived && !mutationBlocked && backendCanSubmit,
      ...reason(
        available && !archived && !mutationBlocked && backendCanSubmit,
        "Automation requires an inactive, unarchived thread.",
      ),
      parameters: { kind: "automation_editor" },
    });
  }
  const allDeliveryModes: ThreadCapabilityDocument["deliveryModes"] = [
    {
      id: "submit",
      steerTarget: null,
      label: { text: "Send" },
      available:
        interactive &&
        available &&
        !archived &&
        !snoozed &&
        !input.pendingDelivery &&
        initialSettingsReady &&
        (input.inventory.thread.backingState === "unbound" ||
          (bound &&
            settled &&
            input.backendCapabilities.deliveryModes.includes("submit"))),
      ...reason(
        interactive &&
          available &&
          !archived &&
          !snoozed &&
          !input.pendingDelivery &&
          initialSettingsReady &&
          (input.inventory.thread.backingState === "unbound" ||
            (bound &&
              settled &&
              input.backendCapabilities.deliveryModes.includes("submit"))),
        input.pendingDelivery
          ? "Wait for the previous steering input to appear before sending again."
          : !initialSettingsReady
            ? "Choose the required thread settings before sending."
            : "A new turn cannot start in the current thread state.",
      ),
    },
    {
      id: "steer",
      steerTarget: input.backendCapabilities.steerTarget,
      label: { text: "Steer" },
      available: steerAvailable,
      ...reason(
        steerAvailable,
        input.pendingDelivery
          ? "Wait for the previous steering input to appear before steering again."
          : "The active backend turn cannot be steered.",
      ),
    },
    {
      id: "queue",
      steerTarget: null,
      label: { text: "Queue" },
      available:
        available &&
        !archived &&
        !snoozed &&
        bound &&
        inFlight &&
        !input.pendingDelivery &&
        backendCanSubmit &&
        initialSettingsReady &&
        input.queue.length < 500,
      ...reason(
        available &&
          !archived &&
          !snoozed &&
          bound &&
          inFlight &&
          !input.pendingDelivery &&
          backendCanSubmit &&
          initialSettingsReady &&
          input.queue.length < 500,
        input.pendingDelivery
          ? "Wait for the previous steering input to appear before queueing more input."
          : !initialSettingsReady
            ? "Choose the required thread settings before queueing input."
            : "Input cannot be queued in the current thread state.",
      ),
    },
  ];
  const deliveryModes = allDeliveryModes.filter((mode) => {
    if (mode.id === "submit")
      return interactive && (unbound || backendCanSubmit);
    if (mode.id === "steer") return backendCanSteer;
    return backendCanSubmit;
  });
  const supportedOperations = operations.filter((operation) => {
    if (operation.id === "rename") {
      return (
        interactive &&
        (unbound || input.backendCapabilities.actions.includes("rename"))
      );
    }
    if (operation.id === "move_draft") return interactive && unbound;
    if (operation.id === "compact") {
      return input.backendCapabilities.actions.includes("compact");
    }
    if (operation.id === "interrupt") {
      return backendCanSubmit || backendCanSteer;
    }
    if (operation.id === "discard_fork") {
      return input.recovery?.kind === "conversation_creation" &&
        input.recovery.creationType === "fork";
    }
    if (
      operation.id === "retry_submission" ||
      operation.id === "recover_uncertain"
    ) {
      return input.recovery !== undefined ||
        (operation.id === "recover_uncertain" && canReconcileQueue);
    }
    if (operation.id === "remove_automation") return backendCanSubmit;
    if (operation.id === "attach_automation") return backendCanSubmit;
    if (operation.id === "run_automation") {
      return backendCanSubmit && input.presentation.automationAllowed !== false;
    }
    return true;
  });
  const supportedSettings = new Set([
    ...input.backendCapabilities.actions.flatMap((action) => {
      if (action === "set_model") return ["model"];
      if (action === "set_thinking_level") return ["thinking_level"];
      if (action === "set_tool_access") return ["tool_access"];
      return [];
    }),
    ...(input.presentation.nextTurnSettingIds ?? []),
  ]);
  const nextTurnSettings = new Set(input.presentation.nextTurnSettingIds ?? []);
  const settingAvailable = (descriptor: SettingDescriptor): boolean =>
    descriptor.available &&
    available &&
    (input.inventory.thread.backingState === "unbound" ||
      (supportedSettings.has(descriptor.id) &&
        bound &&
        settled &&
        (!nextTurnSettings.has(descriptor.id) ||
          (!settingsMutationQueueBlocked && input.recovery === undefined))));
  const settings = input.presentation.settingDescriptors.map((descriptor) => ({
    ...descriptor,
    available: settingAvailable(descriptor),
    ...reason(
      settingAvailable(descriptor),
      "This setting is unavailable in the current thread state.",
    ),
  }));
  const providerFeatures = input.presentation.providerFeatureCapabilities.map(
    (feature) => {
      const applicationMutable =
        feature.availability === "available" &&
        available &&
        !archived &&
        !backendTransitioning &&
        input.recovery === undefined;
      const mutableOperations = feature.operations.filter((action) => {
        if (!applicationMutable) return false;
        const concurrency = input.providerFeatureConcurrency(
          feature.ref,
          action.actionId,
        );
        return (
          (!inFlight ||
            (concurrency.kind === "concurrent" && concurrency.activeTurn)) &&
          (!settingsMutationQueueBlocked ||
            (concurrency.kind === "concurrent" && concurrency.queuedInput))
        );
      });
      const mutable =
        applicationMutable &&
        (feature.operations.length === 0 || mutableOperations.length > 0);
      return {
        ...feature,
        ...(mutable && mutableOperations.length !== feature.operations.length
          ? { operations: mutableOperations }
          : {}),
        availability: mutable
          ? ("available" as const)
          : feature.availability === "unavailable"
            ? ("unavailable" as const)
            : ("read_only" as const),
        ...(mutable
          ? {}
          : {
              unavailableReason: feature.unavailableReason ?? {
                text: "This feature cannot change while the thread has active, queued, or uncertain work.",
              },
            }),
      };
    },
  );
  const capabilityRevision = createHash("sha256")
    .update(
      JSON.stringify({
        presentation: input.presentation.revision,
        interactionMode: input.presentation.interactionMode,
        backend: input.backendCapabilities.revision,
        runState: input.runState,
        inventoryRevision: input.inventory.thread.inventoryRevision,
        threadRevision: input.inventory.thread.threadRevision,
        available,
        inventoryState: input.inventory.thread.inventoryState,
        automation: input.inventory.thread.automation,
        draftRevision: input.inventory.draft.revision,
        stashIds: input.inventory.stashes.map(({ id }) => id),
        attention: input.inventory.attention,
        queue: input.queue.map(({ id, state }) => [id, state]),
        interactions: input.interactions.map(({ id, kind }) => [id, kind]),
        recovery: input.recovery,
        pendingDelivery: input.pendingDelivery,
        historyOperational: input.historyOperational,
        attachmentStagingAvailable: input.attachmentStagingAvailable,
      }),
    )
    .digest("base64url")
    .slice(0, 40);
  return {
    revision: `cap_${capabilityRevision}`,
    backend: input.presentation.backend,
    interactionMode: input.presentation.interactionMode,
    runState: input.runState,
    operations: supportedOperations,
    deliveryModes,
    settings,
    providerFeatures,
    composerActions: [
      {
        id: "stash_prompt",
        label: { text: "Stash prompt" },
        available: hasDeliverableComposerInput(input.inventory.draft),
        ...reason(
          hasDeliverableComposerInput(input.inventory.draft),
          "The composer is empty.",
        ),
      },
      {
        id: "restore_stash",
        label: { text: "Restore stash" },
        available: input.inventory.stashes.length > 0,
        ...reason(
          input.inventory.stashes.length > 0,
          "There are no stashed prompts.",
        ),
      },
    ],
    composerAttachments: {
      fileStaging:
        input.attachmentStagingAvailable &&
        (unbound || input.backendCapabilities.composerAttachments.fileStaging)
          ? { availability: "available" }
          : {
              availability: "unavailable",
              reason: {
                text: "File attachments are unavailable for this backend or execution environment.",
              },
            },
      nativeImage:
        input.attachmentStagingAvailable &&
        input.backendCapabilities.composerAttachments.nativeImage
          ? { availability: "available" }
          : {
              availability: "unavailable",
              reason: {
                text: "The current backend does not accept native image input.",
              },
            },
      policy: COMPOSER_ATTACHMENT_POLICY,
    },
    nonblockingQuestions: input.backendCapabilities.nonblockingQuestions,
    providerOutputArtifacts: input.backendCapabilities.providerOutputArtifacts,
    interactions: interactive
      ? [
          ...new Set([
            ...input.backendCapabilities.interactionKinds,
            ...input.interactions.map(({ kind }) => kind),
          ]),
        ].map((kind) => ({
          kind,
          available: available && bound && !backendTransitioning,
          ...reason(
            available && bound && !backendTransitioning,
            "The backend interaction is unavailable in the current thread state.",
          ),
        }))
      : [],
    history: {
      available: input.historyOperational,
      paginated: input.historyOperational,
      ...reason(
        input.historyOperational,
        "History pagination is not available for this thread.",
      ),
    },
    automation: {
      available:
        available && !archived && !backendTransitioning && backendCanSubmit,
      canAttach:
        available &&
        !automation &&
        !archived &&
        !mutationBlocked &&
        backendCanSubmit,
      canRunNow:
        available &&
        Boolean(automation) &&
        settled &&
        !archived &&
        !snoozed &&
        backendCanSubmit &&
        input.presentation.automationAllowed !== false,
      canCloneOnRun:
        available &&
        bound &&
        !backendTransitioning &&
        input.backendCapabilities.branching.availability === "available" &&
        input.backendCapabilities.branching.boundaries.includes(
          "latest_completed",
        ) &&
        !archived &&
        input.presentation.automationAllowed !== false,
      ...reason(
        available && !archived && !backendTransitioning && backendCanSubmit,
        "Automation is unavailable for this thread.",
      ),
    },
  };
}
