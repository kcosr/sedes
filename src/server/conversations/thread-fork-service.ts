import type { EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import type { EnvironmentVariablesService } from "../environment-variables/environment-variables-service.js";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  NormalizedThreadDescendantsPage,
  NormalizedThreadLineagePlacement,
} from "../../shared/protocol/application.js";
import type {
  BackendBranchingCapability,
  BackendEffectiveSettings,
} from "../../shared/protocol/backend.js";
import { BackendError } from "../backends/contracts.js";
import { reportBackgroundError } from "../report-background-error.js";
import type { BackendCheckpointRef } from "../backends/contracts.js";
import type { ConversationActorManager } from "./conversation-actor-manager.js";
import type { ActorBranchCheckpointSelection } from "./conversation-actor.js";
import type { DatabaseConversationTargetStore } from "./database-conversation-adapters.js";
import type { BackendThreadPersistenceAdapter } from "./conversation-lifecycle-service.js";
import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type {
  ConversationCreationAttemptRecord,
  ConversationCreationRepository,
} from "../db/repositories/conversation-creation-repository.js";
import type { BackendCheckpointRepository } from "../db/repositories/backend-checkpoint-repository.js";
import type { ThreadLineageRepository } from "../db/repositories/thread-lineage-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { ConversationOperationRepository } from "../db/repositories/conversation-operation-repository.js";
import type { DeliveryInputSnapshotRepository } from "../db/repositories/delivery-input-snapshot-repository.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  ApplicationSnapshotPublicationBoundary,
  ApplicationTerminalSummaryReader,
} from "../application/application-snapshot-service.js";
import { applicationTurnIdForBackendTurn } from "./conversation-projector.js";
import type { DatabaseApplicationThreadSummaryReader } from "../application/database-application-summary-reader.js";
import type { ThreadRuntimeCoordinator } from "../events/thread-runtime-coordinator.js";
import type { AutomationExecutionPolicy } from "../runtime/automation-execution-policy.js";
import type { ThreadRunState } from "../../shared/protocol/conversation.js";
import {
  requireAdmittedResource,
  type TrustedEnvironmentAuthorityGrant,
} from "../agent-tools/environment/environment-authority.js";
import type { OutputArtifactService } from "../output-artifacts/service.js";

export type ThreadForkResult =
  | { readonly status: "created"; readonly childThreadId: string }
  | {
      readonly status: "recovery_required";
      readonly childThreadId: string;
      readonly retryable: boolean;
      readonly uncertaintyKind: "fork_unknown" | null;
      readonly diagnostic: string;
    }
  | {
      readonly status: "aborted";
      readonly childThreadId: string;
      readonly diagnostic: string;
      /** False when a new fork of the same boundary would fail the same way. */
      readonly restartable: boolean;
    };

type ManualForkInputBase = {
  readonly environmentVariables?: EnvironmentVariableOverrides;
  readonly scope: RequestScope;
  readonly sourceThreadId: string;
  readonly mutationId: string;
};

type ManualForkInput = ManualForkInputBase &
  (
    | {
        readonly boundary: "selected_completed_turn";
        readonly sourceTurnId: string;
        readonly expectedTurnRevision: number;
      }
    | { readonly boundary: "latest_provider_snapshot" }
  );

export type AgentForkInput = {
  readonly scope: RequestScope;
  /** Trusted application thread from whose runtime the agent tool was invoked. */
  readonly controllerThreadId: string;
  readonly sourceThreadId: string;
  readonly sourceTurnId: string;
  readonly expectedTurnRevision: number;
  readonly mutationId: string;
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
};

export type PrincipalClientForkInput = {
  readonly scope: RequestScope;
  readonly clientId: string;
  readonly sourceThreadId: string;
  readonly sourceTurnId: string;
  readonly expectedTurnRevision: number;
  readonly mutationId: string;
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
};

type ForkSourceKind =
  | "automation"
  | "user_fork"
  | "agent_control"
  | "principal_client";
type UserForkOriginKind =
  | "user_fork"
  | "agent_fork"
  | "principal_client_fork";

type AutomationForkInput = {
  readonly scope: RequestScope;
  readonly anchorThreadId: string;
  readonly automationId: string;
  readonly automationRunId: string;
  readonly mutationId: string;
};

type CapturedForkCommon = {
  readonly target: Awaited<
    ReturnType<Pick<DatabaseConversationTargetStore, "actor">["actor"]>
  >;
  readonly checkpointRef: BackendCheckpointRef;
  readonly effectiveSettings: BackendEffectiveSettings;
  readonly branching: Extract<
    BackendBranchingCapability,
    { readonly availability: "available" }
  >;
};

type CapturedFork = CapturedForkCommon &
  (
    | {
        readonly boundaryKind: "completed_turn_inclusive";
        /** Null only for migrated automation forks without an application turn. */
        readonly sourceTurnId: string | null;
        readonly sourceTurnCompletedAt: string | null;
      }
    | {
        readonly boundaryKind: "provider_snapshot_at_acceptance";
        readonly sourceTurnId: null;
        readonly sourceTurnCompletedAt: null;
      }
  );

const FORK_UNKNOWN_DIAGNOSTIC =
  "The provider may have created a full native fork, but Sedes did not receive a trustworthy response. The possible orphan was not retried or adopted automatically.";

interface AutomationForkBinder {
  readonly database: Database.Database;
  bindForkChild(
    scope: RequestScope,
    automationId: string,
    automationRunId: string,
    input: { readonly childThreadId: string; readonly now: number },
  ): unknown;
}

function forkKey(scope: RequestScope, mutationId: string): string {
  return `${scope.tenantId}\0${scope.principalId}\0${mutationId}`;
}

function forkRequestFingerprint(
  input:
    | {
        readonly originKind: "automation_fork";
        readonly sourceThreadId: string;
        readonly automationId: string | null;
        readonly automationRunId: string | null;
      }
    | {
        readonly originKind: UserForkOriginKind;
        readonly environmentVariablesFingerprint?: string;
        readonly initiatingAgentThreadId: string | null;
        readonly initiatingToolClientId: string | null;
        readonly sourceThreadId: string;
        readonly selection:
          | {
              readonly kind: "selected_completed_turn";
              readonly sourceTurnId: string | null;
              readonly expectedTurnRevision: number | null;
            }
          | { readonly kind: "latest_provider_snapshot" };
      },
): string {
  if (input.originKind === "automation_fork") {
    return JSON.stringify([
      input.originKind,
      input.sourceThreadId,
      input.automationId,
      input.automationRunId,
    ]);
  }
  return JSON.stringify([
    input.originKind,
    input.initiatingAgentThreadId,
    input.initiatingToolClientId,
    input.environmentVariablesFingerprint ?? null,
    input.sourceThreadId,
    input.selection.kind,
    input.selection.kind === "selected_completed_turn"
      ? input.selection.sourceTurnId
      : null,
    input.selection.kind === "selected_completed_turn"
      ? input.selection.expectedTurnRevision
      : null,
  ]);
}

export class ThreadForkService {
  readonly #inFlight = new Map<
    string,
    {
      readonly requestFingerprint: string;
      readonly promise: Promise<ThreadForkResult>;
    }
  >();
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #cursorSigningKey: Buffer;
  #applicationSnapshots?: ApplicationSnapshotPublicationBoundary;
  #taskPublications?: {
    publishTaskChange(scope: RequestScope, taskId: string): Promise<void>;
  };
  #descendantRunStates?: Pick<ThreadRuntimeCoordinator, "captureLoadedState">;

  constructor(
    readonly input: {
      readonly environmentVariables?: EnvironmentVariablesService;
      readonly database: Database.Database;
      readonly targets: Pick<DatabaseConversationTargetStore, "actor">;
      readonly actors: ConversationActorManager;
      readonly backendPersistence: ReadonlyMap<
        string,
        BackendThreadPersistenceAdapter
      >;
      readonly bindings: ConversationBindingRepository;
      readonly creation: ConversationCreationRepository;
      readonly checkpoints: BackendCheckpointRepository;
      readonly lineage: ThreadLineageRepository;
      readonly inventory: InventoryRepository;
      readonly operations: ConversationOperationRepository;
      readonly deliveryInputSnapshots?: DeliveryInputSnapshotRepository;
      readonly outputArtifacts: Pick<OutputArtifactService, "collectGarbage">;
      readonly automations: AutomationForkBinder;
      readonly automationExecutionPolicy: AutomationExecutionPolicy;
      /** SQLite-only copy of application-owned thread workspace selection. */
      readonly executionWorkspaces?: {
        copySelection(
          scope: RequestScope,
          sourceApplicationThreadId: string,
          childApplicationThreadId: string,
        ): void;
      };
      readonly descendantSummaries: Pick<
        DatabaseApplicationThreadSummaryReader,
        "listByIds"
      >;
      readonly descendantTerminalSummaries: ApplicationTerminalSummaryReader;
      readonly lineageCursorSigningKey: Uint8Array;
      readonly now?: () => number;
      readonly id?: () => string;
    },
  ) {
    const database = input.database;
    if (
      input.bindings.database !== database ||
      input.creation.database !== database ||
      input.checkpoints.database !== database ||
      input.lineage.database !== database ||
      input.inventory.database !== database ||
      input.operations.database !== database ||
      (input.deliveryInputSnapshots !== undefined &&
        input.deliveryInputSnapshots.database !== database) ||
      input.automations.database !== database ||
      [...input.backendPersistence.values()].some(
        ({ database: candidate }) => candidate !== database,
      )
    ) {
      throw new Error("thread_fork_service_database_mismatch");
    }
    this.#now = input.now ?? Date.now;
    this.#id = input.id ?? randomUUID;
    if (input.lineageCursorSigningKey.byteLength < 32) {
      throw new Error("thread_fork_cursor_signing_key_too_short");
    }
    this.#cursorSigningKey = Buffer.from(input.lineageCursorSigningKey);
  }

  bindApplicationSnapshots(
    applicationSnapshots: ApplicationSnapshotPublicationBoundary,
  ): void {
    if (this.#applicationSnapshots) {
      throw new Error("thread_fork_application_snapshots_already_bound");
    }
    this.#applicationSnapshots = applicationSnapshots;
  }

  /**
   * Binds the non-throwing, queue-on-failure task publisher used for tasks
   * promoted off an aborted fork child, so a failed publication enters the
   * same scheduler-driven retry queue as every other task change.
   */
  bindTaskPublications(taskPublications: {
    publishTaskChange(scope: RequestScope, taskId: string): Promise<void>;
  }): void {
    if (this.#taskPublications) {
      throw new Error("thread_fork_task_publications_already_bound");
    }
    this.#taskPublications = taskPublications;
  }

  bindDescendantRunStates(
    runtimes: Pick<ThreadRuntimeCoordinator, "captureLoadedState">,
  ): void {
    if (this.#descendantRunStates) {
      throw new Error("thread_fork_descendant_run_states_already_bound");
    }
    this.#descendantRunStates = runtimes;
  }

  forkManual(input: ManualForkInput): Promise<ThreadForkResult> {
    const environmentVariablesFingerprint = this.input.environmentVariables?.forkRequestFingerprint(input.scope, input.sourceThreadId, input.environmentVariables);
    if (environmentVariablesFingerprint !== undefined) this.input.environmentVariables!.assertForkRequest(input.scope, input.mutationId, environmentVariablesFingerprint);
    return this.#coalesce(
      input.scope,
      input.mutationId,
      forkRequestFingerprint({
        originKind: "user_fork",
        environmentVariablesFingerprint,
        initiatingAgentThreadId: null,
        initiatingToolClientId: null,
        sourceThreadId: input.sourceThreadId,
        selection:
          input.boundary === "selected_completed_turn"
            ? {
                kind: input.boundary,
                sourceTurnId: input.sourceTurnId,
                expectedTurnRevision: input.expectedTurnRevision,
              }
            : { kind: input.boundary },
      }),
      () =>
        this.#fork({
          ...input,
          sourceKind: "user_fork",
          originKind: "user_fork",
          initiatingPrincipalId: input.scope.principalId,
          selection:
            input.boundary === "selected_completed_turn"
              ? {
                  kind: "selected_completed_turn",
                  turnId: input.sourceTurnId,
                  expectedTurnRevision: input.expectedTurnRevision,
                }
              : { kind: "latest_provider_snapshot" },
        }),
    );
  }

  forkAgent(input: AgentForkInput): Promise<ThreadForkResult> {
    const source = this.input.inventory.getThread(
      input.scope,
      input.sourceThreadId,
    );
    requireAdmittedResource(input.environmentAuthority, {
      kind: "thread",
      id: source.thread.id,
      environmentId: source.thread.environmentId,
      workspaceId: source.thread.workspaceId,
    });
    const { environmentAuthority: _environmentAuthority, ...forkInput } = input;
    return this.#coalesce(
      input.scope,
      input.mutationId,
      forkRequestFingerprint({
        originKind: "agent_fork",
        initiatingAgentThreadId: input.controllerThreadId,
        initiatingToolClientId: null,
        sourceThreadId: input.sourceThreadId,
        selection: {
          kind: "selected_completed_turn",
          sourceTurnId: input.sourceTurnId,
          expectedTurnRevision: input.expectedTurnRevision,
        },
      }),
      () =>
        this.#fork({
          ...forkInput,
          sourceKind: "agent_control",
          originKind: "agent_fork",
          initiatingPrincipalId: input.scope.principalId,
          initiatingAgentThreadId: input.controllerThreadId,
          selection: {
            kind: "selected_completed_turn",
            turnId: input.sourceTurnId,
            expectedTurnRevision: input.expectedTurnRevision,
          },
        }),
    );
  }

  forkPrincipalClient(input: PrincipalClientForkInput): Promise<ThreadForkResult> {
    const source = this.input.inventory.getThread(
      input.scope,
      input.sourceThreadId,
    );
    requireAdmittedResource(input.environmentAuthority, {
      kind: "thread",
      id: source.thread.id,
      environmentId: source.thread.environmentId,
      workspaceId: source.thread.workspaceId,
    });
    const { environmentAuthority: _environmentAuthority, ...forkInput } = input;
    return this.#coalesce(
      input.scope,
      input.mutationId,
      forkRequestFingerprint({
        originKind: "principal_client_fork",
        initiatingAgentThreadId: null,
        initiatingToolClientId: input.clientId,
        sourceThreadId: input.sourceThreadId,
        selection: {
          kind: "selected_completed_turn",
          sourceTurnId: input.sourceTurnId,
          expectedTurnRevision: input.expectedTurnRevision,
        },
      }),
      () =>
        this.#fork({
          ...forkInput,
          sourceKind: "principal_client",
          originKind: "principal_client_fork",
          initiatingPrincipalId: input.scope.principalId,
          initiatingToolClientId: input.clientId,
          selection: {
            kind: "selected_completed_turn",
            turnId: input.sourceTurnId,
            expectedTurnRevision: input.expectedTurnRevision,
          },
        }),
    );
  }

  forkAutomation(input: AutomationForkInput): Promise<ThreadForkResult> {
    return this.#coalesce(
      input.scope,
      input.mutationId,
      forkRequestFingerprint({
        originKind: "automation_fork",
        sourceThreadId: input.anchorThreadId,
        automationId: input.automationId,
        automationRunId: input.automationRunId,
      }),
      () =>
        this.#fork({
          scope: input.scope,
          sourceThreadId: input.anchorThreadId,
          mutationId: input.mutationId,
          sourceKind: "automation",
          originKind: "automation_fork",
          initiatingPrincipalId: input.scope.principalId,
          automationId: input.automationId,
          automationRunId: input.automationRunId,
        }),
    );
  }

  recoverActive(
    scope: RequestScope,
    childThreadId: string,
    options: { readonly automatic?: boolean } = {},
  ): Promise<ThreadForkResult> | undefined {
    const attempt = this.input.creation.findActiveForThread(
      scope,
      childThreadId,
    );
    if (!attempt || attempt.creationKind !== "fork") return undefined;
    const origin = this.input.lineage.getOrigin(scope, childThreadId);
    if (!origin.creationOperationId || !origin.sourceThreadId) {
      throw new DomainError(
        "conflict",
        "The fork recovery is missing its creation operation.",
      );
    }
    if (
      origin.originKind !== "automation_fork" &&
      origin.originKind !== "user_fork" &&
      origin.originKind !== "agent_fork"
      && origin.originKind !== "principal_client_fork"
    ) {
      throw new DomainError(
        "conflict",
        "The active fork has unsupported creation provenance.",
      );
    }
    const recoverableOriginKind = origin.originKind;
    const creationOperationId = origin.creationOperationId;
    const sourceThreadId = origin.sourceThreadId;
    return this.#coalesce(
      scope,
      creationOperationId,
      recoverableOriginKind === "automation_fork"
        ? forkRequestFingerprint({
            originKind: "automation_fork",
            sourceThreadId,
            automationId: origin.sourceAutomationId,
            automationRunId: origin.sourceAutomationRunId,
          })
        : forkRequestFingerprint({
            originKind: recoverableOriginKind,
            ...(recoverableOriginKind === "user_fork" && this.input.environmentVariables ? {
              environmentVariablesFingerprint: this.input.environmentVariables.forkRequestFingerprint(scope, sourceThreadId, this.input.environmentVariables.get(scope, childThreadId).layers.thread),
            } : {}),
            initiatingAgentThreadId: origin.initiatingAgentThreadId,
            initiatingToolClientId: origin.initiatingToolClientId,
            sourceThreadId,
            selection:
              origin.boundaryKind === "provider_snapshot_at_acceptance"
                ? { kind: "latest_provider_snapshot" }
                : {
                    kind: "selected_completed_turn",
                    sourceTurnId: origin.sourceTurnId,
                    expectedTurnRevision: origin.sourceTurnRevision,
                  },
          }),
      () =>
        this.#fork({
          scope,
          sourceThreadId,
          mutationId: creationOperationId,
          ...(options.automatic ? { automatic: true } : {}),
          sourceKind:
            recoverableOriginKind === "automation_fork"
              ? "automation"
              : recoverableOriginKind === "agent_fork"
                ? "agent_control"
                : recoverableOriginKind === "principal_client_fork"
                  ? "principal_client"
                : "user_fork",
          originKind: recoverableOriginKind,
          initiatingPrincipalId:
            origin.initiatingPrincipalId ?? scope.principalId,
          ...(origin.sourceAutomationId
            ? { automationId: origin.sourceAutomationId }
            : {}),
          ...(origin.sourceAutomationRunId
            ? { automationRunId: origin.sourceAutomationRunId }
            : {}),
          ...(origin.initiatingAgentThreadId
            ? { initiatingAgentThreadId: origin.initiatingAgentThreadId }
            : {}),
          ...(origin.initiatingToolClientId
            ? { initiatingToolClientId: origin.initiatingToolClientId }
            : {}),
          ...(origin.originKind === "automation_fork"
            ? {}
            : origin.boundaryKind === "provider_snapshot_at_acceptance"
              ? {
                  selection: {
                    kind: "latest_provider_snapshot" as const,
                  },
                }
              : {
                  selection: {
                    kind: "selected_completed_turn" as const,
                    turnId: origin.sourceTurnId!,
                    expectedTurnRevision: origin.sourceTurnRevision!,
                  },
                }),
        }),
    );
  }

  /**
   * Startup recovery. It runs after the server listens and logs every outcome.
   *
   * - A fork whose provider child was already returned (identified, or
   *   awaiting recovery with the child's identity and binding detail) is
   *   finalized locally, without a provider call.
   * - A fork a crash interrupted before its provider response (prepared, or
   *   with its provider call started) is retried under its recovery policy.
   *
   * Other attempts already awaiting explicit recovery are left for the user.
   * Automatic recovery never aborts a fork: a definite failure found here is
   * kept as a visible recovery rather than discarding the reserved child.
   */
  async recoverInterruptedForks(scope: RequestScope): Promise<void> {
    let after:
      | {
          readonly preparedAt: number;
          readonly attemptId: string;
          readonly applicationThreadId: string;
        }
      | undefined;
    for (;;) {
      const page = this.input.creation.listActiveForks(scope, 256, after);
      for (const attempt of page) {
        // Matches #fork's local finalization exactly, so no provider call.
        const childReturned =
          (attempt.phase === "conversation_identified" ||
            attempt.phase === "recovery_required") &&
          attempt.provisionalBackendConversationId !== null &&
          attempt.provisionalOpaqueBindingDetail !== null;
        const interrupted =
          attempt.phase === "prepared" ||
          attempt.phase === "external_call_started";
        if (!childReturned && !interrupted) continue;
        try {
          const result = await this.recoverActive(scope, attempt.applicationThreadId, { automatic: true });
          if (result) {
            console.warn("thread_fork_startup_recovery", {
              childThreadId: attempt.applicationThreadId,
              phase: attempt.phase,
              outcome: result.status,
              ...(result.status === "created" ? {} : { diagnostic: result.diagnostic }),
            });
          }
        } catch (error) {
          // The durable attempt remains authoritative; explicit recovery
          // retries the same operation.
          reportBackgroundError(`Startup recovery of fork ${attempt.applicationThreadId}`)(error);
        }
      }
      if (page.length < 256) return;
      const last = page.at(-1)!;
      after = {
        preparedAt: last.preparedAt,
        attemptId: last.attemptId,
        applicationThreadId: last.applicationThreadId,
      };
    }
  }

  /**
   * Explicitly discard an unfinished fork child the user no longer wants,
   * without re-running its provider call. The reserved child thread is
   * removed. A fork whose child the provider already returned is refused:
   * recovery finishes it locally instead. A child the provider may have
   * created is never adopted into this fork. Discovery never imports an
   * application-reserved child identity, which stays quarantined; a
   * provider-assigned child has no reserved identity and may later be
   * imported as a separate thread.
   */
  async discardActive(
    scope: RequestScope,
    childThreadId: string,
  ): Promise<Extract<ThreadForkResult, { readonly status: "aborted" }>> {
    const attempt = this.input.creation.findActiveForThread(scope, childThreadId);
    if (!attempt || attempt.creationKind !== "fork") {
      throw new DomainError("not_found", "There is no unfinished fork to discard.");
    }
    if (this.#inFlight.has(forkKey(scope, attempt.mutationId))) {
      throw new DomainError(
        "invalid_transition",
        "This fork is still being created. Wait for it to finish before discarding it.",
      );
    }
    if (attempt.provisionalBackendConversationId !== null) {
      throw new DomainError(
        "invalid_transition",
        "The provider returned this fork's child. Recover the fork to finish it instead.",
      );
    }
    const origin = this.input.lineage.getOrigin(scope, childThreadId);
    let promotedTaskIds: readonly string[] = [];
    const abortInput = {
      creationOperationId: attempt.mutationId,
      diagnostic: "The fork was discarded.",
      restartable: true,
      now: this.#now(),
      onThreadTasksPromoted: (taskIds: readonly string[]) => {
        promotedTaskIds = taskIds;
      },
    };
    const aborted =
      origin.boundaryKind === "provider_snapshot_at_acceptance"
        ? this.input.lineage.abortPreparedProviderSnapshotFork(scope, childThreadId, abortInput)
        : this.input.lineage.abortPreparedFork(scope, childThreadId, abortInput);
    for (const promotedTaskId of promotedTaskIds) {
      await this.#taskPublications?.publishTaskChange(scope, promotedTaskId);
    }
    await this.#collectOutputArtifactGarbage();
    await this.#publications().publishAuthoritativeReplacement(scope);
    return {
      status: "aborted",
      childThreadId: aborted.reservedChildThreadId,
      diagnostic: aborted.diagnostic,
      restartable: aborted.restartable,
    };
  }

  async readRecovery(
    scope: RequestScope,
    childThreadId: string,
  ): Promise<{ readonly recoverable: boolean }> {
    const attempt = this.input.creation.findActiveForThread(
      scope,
      childThreadId,
    );
    if (!attempt || attempt.creationKind !== "fork") {
      throw new DomainError("not_found", "The fork recovery was not found.");
    }
    if (attempt.phase === "prepared") {
      return { recoverable: true };
    }
    if (attempt.forkUncertaintyKind === "fork_unknown") {
      return { recoverable: false };
    }
    if (
      attempt.provisionalBackendConversationId !== null &&
      attempt.provisionalOpaqueBindingDetail !== null
    ) {
      return { recoverable: true };
    }
    return { recoverable: attempt.forkCreationRecovery === "idempotent" };
  }

  async reconcileDiscoveredFork(
    scope: RequestScope,
    input: {
      readonly applicationOperationId: string;
      readonly backendInstanceId: string;
      readonly connectionProfileIds: readonly string[];
      readonly executionEnvironmentId: string;
      readonly backendConversationId: string;
      readonly parentBackendConversationId: string;
      readonly sourceBackendTurnId?: string;
      readonly childIdentity: "application_reserved" | "provider_assigned";
      readonly creationRecovery:
        "idempotent" | "exactly_reconcilable" | "potentially_unknown";
      readonly method: "provider_native" | "provider_history_import";
      readonly opaqueBindingDetail: string;
    },
  ): Promise<string | undefined> {
    let attempt = this.input.creation.findByMutationId(
      scope,
      input.applicationOperationId,
    );
    if (!attempt || attempt.creationKind !== "fork") return undefined;
    const origin = this.input.lineage.findByCreationOperation(
      scope,
      input.applicationOperationId,
    );
    if (
      !origin ||
      origin.childThreadId !== attempt.applicationThreadId ||
      attempt.backendInstanceId !== input.backendInstanceId ||
      attempt.executionEnvironmentId !== input.executionEnvironmentId ||
      !input.connectionProfileIds.includes(attempt.connectionProfileId) ||
      input.childIdentity !== attempt.forkChildIdentity ||
      input.creationRecovery !== attempt.forkCreationRecovery ||
      (input.childIdentity === "application_reserved" &&
        (input.creationRecovery !== "idempotent" ||
          attempt.backendCreationCorrelation !==
            input.backendConversationId)) ||
      origin.branchMethod !== input.method ||
      !origin.sourceThreadId ||
      !origin.sourceTurnId ||
      !input.sourceBackendTurnId
    ) {
      return undefined;
    }
    const sourceBinding = this.input.bindings.getBinding(
      scope,
      origin.sourceThreadId,
    );
    if (
      sourceBinding?.backendConversationId !==
        input.parentBackendConversationId ||
      sourceBinding.connectionProfileId !== attempt.connectionProfileId ||
      sourceBinding.executionEnvironmentId !== attempt.executionEnvironmentId ||
      applicationTurnIdForBackendTurn({
        backendInstanceId: input.backendInstanceId,
        sourceApplicationThreadId: origin.sourceThreadId,
        backendTurnId: input.sourceBackendTurnId,
      }) !== origin.sourceTurnId
    ) {
      return undefined;
    }
    if (
      attempt.provisionalBackendConversationId !== null &&
      attempt.provisionalBackendConversationId !== input.backendConversationId
    ) {
      return undefined;
    }
    if (attempt.phase === "bound") {
      const binding = this.input.bindings.getBinding(
        scope,
        attempt.applicationThreadId,
      );
      return binding?.backendConversationId === input.backendConversationId
        ? attempt.applicationThreadId
        : undefined;
    }
    if (
      attempt.phase !== "external_call_started" &&
      attempt.phase !== "recovery_required" &&
      attempt.phase !== "conversation_identified"
    ) {
      return undefined;
    }
    if (attempt.phase !== "conversation_identified") {
      const expected = attempt.phase;
      attempt = this.#recordIdentifiedResponse(scope, attempt, {
        expected,
        backendConversationId: input.backendConversationId,
        opaqueBindingDetail: input.opaqueBindingDetail,
        now: this.#now(),
      });
    }
    this.#finalize(
      {
        scope,
        mutationId: input.applicationOperationId,
        sourceKind: attempt.sourceKind as ForkSourceKind,
        ...(attempt.sourceAutomationId
          ? { automationId: attempt.sourceAutomationId }
          : {}),
        ...(attempt.sourceAutomationRunId
          ? { automationRunId: attempt.sourceAutomationRunId }
          : {}),
      },
      attempt,
    );
    return attempt.applicationThreadId;
  }

  async updatePlacement(input: {
    readonly scope: RequestScope;
    readonly childThreadId: string;
    readonly mode: "nested_under_source" | "top_level";
    readonly expectedRevision: number;
    readonly mutationId: string;
  }): Promise<NormalizedThreadLineagePlacement> {
    const placement = this.input.lineage.updatePlacement(
      input.scope,
      input.childThreadId,
      {
        placementMode: input.mode,
        expectedRevision: input.expectedRevision,
        mutationId: input.mutationId,
        now: this.#now(),
      },
    );
    await this.#publications().publishAuthoritativeReplacement(input.scope);
    return {
      childThreadId: placement.childThreadId,
      mode: placement.placementMode,
      revision: placement.revision,
      updatedAt: new Date(placement.updatedAt).toISOString(),
    };
  }

  async listDescendants(input: {
    readonly scope: RequestScope;
    readonly sourceThreadId: string;
    readonly cursor?: string;
    readonly pageSize: number;
  }): Promise<NormalizedThreadDescendantsPage> {
    if (
      !this.input.bindings.findThreadDefinition(
        input.scope,
        input.sourceThreadId,
      )
    ) {
      throw new DomainError("not_found", "The thread was not found.");
    }
    const cursor = input.cursor
      ? this.#decodeCursor(input.scope, input.sourceThreadId, input.cursor)
      : undefined;
    const page = this.input.lineage.listDescendants(
      input.scope,
      input.sourceThreadId,
      { limit: input.pageSize, ...(cursor ? { cursor } : {}) },
    );
    const childThreadIds = page.descendants.map(
      ({ childThreadId }) => childThreadId,
    );
    const terminalSummaries =
      this.input.descendantTerminalSummaries.summariesByThread(
        input.scope,
        childThreadIds,
      );
    if (!this.#descendantRunStates) {
      throw new Error("thread_fork_descendant_run_states_unbound");
    }
    const threads = new Map(
      await Promise.all(
        this.input.descendantSummaries
          .listByIds(input.scope, childThreadIds)
          .map(async (thread) => {
            const loaded = await this.#descendantRunStates!.captureLoadedState(
              input.scope,
              thread.id,
            );
            const runState: ThreadRunState =
              thread.backingState === "creating"
                ? "starting"
                : thread.backingState === "creation_unknown"
                  ? "failed"
                  : thread.backingState === "unbound"
                    ? "idle"
                    : !thread.available
                      ? "disconnected"
                      : (loaded?.runState ?? "idle");
            return [
              thread.id,
              {
                ...thread,
                terminalSummary: terminalSummaries.get(thread.id) ?? {
                  runningCount: 0,
                  retainedCount: 0,
                },
                runState,
              },
            ] as const;
          }),
      ),
    );
    const origins = new Map(
      this.input.lineage
        .listOrigins(input.scope, childThreadIds)
        .filter(({ originState }) => originState === "committed")
        .map((origin) => [
          origin.childThreadId,
          {
            childThreadId: origin.childThreadId,
            sourceThreadId: origin.sourceThreadId,
            sourceTurnId: origin.sourceTurnId,
            sourceTurnCompletedAt:
              origin.sourceTurnCompletedAt === null
                ? null
                : new Date(origin.sourceTurnCompletedAt).toISOString(),
            boundaryKind: origin.boundaryKind,
            originKind: origin.originKind,
            initiatingAgentThreadId: origin.initiatingAgentThreadId,
            initiatingToolClientId: origin.initiatingToolClientId,
            branchMethod: origin.branchMethod,
            createdAt: new Date(origin.createdAt).toISOString(),
          },
        ]),
    );
    const placements = new Map(
      this.input.lineage
        .listPlacements(input.scope, childThreadIds)
        .map((placement) => [
          placement.childThreadId,
          {
            childThreadId: placement.childThreadId,
            mode: placement.placementMode,
            revision: placement.revision,
            updatedAt: new Date(placement.updatedAt).toISOString(),
          },
        ]),
    );
    return {
      descendants: page.descendants.map((record) => {
        const thread = threads.get(record.childThreadId);
        const origin = origins.get(record.childThreadId);
        const placement = placements.get(record.childThreadId);
        if (!thread || !origin || !placement) {
          throw new DomainError(
            "not_found",
            "A descendant is outside the authorized application inventory.",
          );
        }
        return { thread, origin, placement };
      }),
      ...(page.nextCursor
        ? {
            nextCursor: this.#encodeCursor(
              input.scope,
              input.sourceThreadId,
              page.nextCursor,
            ),
          }
        : {}),
    };
  }

  #coalesce(
    scope: RequestScope,
    mutationId: string,
    requestFingerprint: string,
    operation: () => Promise<ThreadForkResult>,
  ): Promise<ThreadForkResult> {
    const key = forkKey(scope, mutationId);
    const current = this.#inFlight.get(key);
    if (current) {
      if (current.requestFingerprint !== requestFingerprint) {
        return Promise.reject(
          new DomainError(
            "conflict",
            "The fork mutation ID is already used by another request.",
          ),
        );
      }
      return current.promise;
    }
    const pending = operation().finally(() => {
      if (this.#inFlight.get(key)?.promise === pending) {
        this.#inFlight.delete(key);
      }
    });
    this.#inFlight.set(key, { requestFingerprint, promise: pending });
    return pending;
  }

  async #collectOutputArtifactGarbage(): Promise<void> {
    try {
      // A fork tombstone proves the provisional thread was hard-deleted and
      // its artifact rows cascaded. Startup reconciliation remains the retry
      // path if this best-effort filesystem removal is temporarily unavailable.
      await this.input.outputArtifacts.collectGarbage();
    } catch {
      // Cleanup must not turn a durable, replayable fork abort into an
      // uncertain mutation result.
    }
  }

  async #fork(input: {
    readonly environmentVariables?: EnvironmentVariableOverrides;
    readonly scope: RequestScope;
    readonly sourceThreadId: string;
    readonly mutationId: string;
    /** Startup recovery: a definite failure stays a visible recovery. */
    readonly automatic?: boolean;
    readonly sourceKind: ForkSourceKind;
    readonly originKind: "automation_fork" | UserForkOriginKind;
    readonly initiatingPrincipalId: string;
    readonly initiatingAgentThreadId?: string;
    readonly initiatingToolClientId?: string;
    readonly automationId?: string;
    readonly automationRunId?: string;
    readonly selection?: ActorBranchCheckpointSelection;
  }): Promise<ThreadForkResult> {
    const aborted = this.input.lineage.findAbortedOperation(
      input.scope,
      input.mutationId,
    );
    if (aborted) {
      this.#assertAbortedReplay(input, aborted);
      await this.#collectOutputArtifactGarbage();
      return {
        status: "aborted",
        childThreadId: aborted.reservedChildThreadId,
        diagnostic: aborted.diagnostic,
        restartable: aborted.restartable,
      };
    }
    let attempt = this.input.creation.findByMutationId(
      input.scope,
      input.mutationId,
    );
    if (attempt?.phase === "bound") {
      this.#assertAttempt(input, attempt);
      const origin = this.input.lineage.getOrigin(
        input.scope,
        attempt.applicationThreadId,
      );
      if (
        origin.originState !== "committed" ||
        origin.creationOperationId !== input.mutationId
      ) {
        throw new DomainError(
          "conflict",
          "The bound fork is missing committed provenance.",
        );
      }
      await this.#publications().publishAuthoritativeReplacement(input.scope);
      return { status: "created", childThreadId: attempt.applicationThreadId };
    }
    if (attempt?.phase === "aborted_unpersisted") {
      this.#assertAttempt(input, attempt);
      return {
        status: "aborted",
        childThreadId: attempt.applicationThreadId,
        diagnostic: attempt.diagnostic ?? "The backend fork was not created.",
        restartable: true,
      };
    }
    if (attempt) {
      this.#assertAttempt(input, attempt);
      if (
        attempt.provisionalBackendConversationId !== null &&
        attempt.provisionalOpaqueBindingDetail !== null
      ) {
        this.#finalize(input, attempt);
        await this.#publications().publishAuthoritativeReplacement(input.scope);
        return {
          status: "created",
          childThreadId: attempt.applicationThreadId,
        };
      }
      if (
        attempt.phase === "recovery_required" &&
        attempt.forkUncertaintyKind === "fork_unknown"
      ) {
        await this.#publications().publishAuthoritativeReplacement(input.scope);
        return this.#recovery(attempt, false);
      }
      if (
        attempt.phase === "external_call_started" &&
        attempt.forkCreationRecovery !== "idempotent"
      ) {
        attempt = this.input.creation.markRecoveryRequired(
          input.scope,
          attempt.applicationThreadId,
          attempt.attemptId,
          {
            expected: "external_call_started",
            diagnostic:
              attempt.forkCreationRecovery === "potentially_unknown"
                ? FORK_UNKNOWN_DIAGNOSTIC
                : "The provider fork requires exact reconciliation and was not repeated.",
            ...(attempt.forkCreationRecovery === "potentially_unknown"
              ? { forkUncertaintyKind: "fork_unknown" as const }
              : {}),
            now: this.#now(),
          },
        );
        await this.#publications().publishAuthoritativeReplacement(input.scope);
        return this.#recovery(attempt, false);
      }
      const origin = this.input.lineage.getOrigin(
        input.scope,
        attempt.applicationThreadId,
      );
      if (
        !origin.sourceThreadId ||
        (origin.boundaryKind === "completed_turn_inclusive" &&
          origin.sourceTurnId === null &&
          input.sourceKind !== "automation")
      ) {
        throw new DomainError(
          "conflict",
          "The fork recovery is missing its resolved source.",
        );
      }
      const target = await this.input.targets.actor(
        input.scope,
        origin.sourceThreadId,
      );
      const acquired = await this.input.actors.acquire(target, {
        idleRelease: "retain",
      });
      try {
        const result = await acquired.actor.withBranchExecution(
          origin.boundaryKind,
          async (branching) => {
            const checkpoint = this.input.checkpoints.get(
              input.scope,
              input.mutationId,
            );
            if (
              checkpoint.boundaryKind !== origin.boundaryKind ||
              checkpoint.applicationThreadId !== origin.sourceThreadId ||
              checkpoint.applicationTurnId !== origin.sourceTurnId
            ) {
              throw new DomainError(
                "conflict",
                "The durable fork checkpoint no longer matches its source boundary.",
              );
            }
            const capturedCommon: CapturedForkCommon = {
              target,
              checkpointRef: {
                backendInstanceId: checkpoint.backendInstanceId,
                kind: checkpoint.kind,
                opaqueReference: checkpoint.opaqueReference,
              },
              effectiveSettings: this.#persistence(
                input.scope,
                attempt!.applicationThreadId,
              ).readForkSettings(input.scope, attempt!.applicationThreadId),
              branching,
            };
            const captured: CapturedFork =
              origin.boundaryKind === "provider_snapshot_at_acceptance"
                ? {
                    ...capturedCommon,
                    boundaryKind: origin.boundaryKind,
                    sourceTurnId: null,
                    sourceTurnCompletedAt: null,
                  }
                : {
                    ...capturedCommon,
                    boundaryKind: origin.boundaryKind,
                    sourceTurnId: origin.sourceTurnId,
                    sourceTurnCompletedAt:
                      origin.sourceTurnCompletedAt === null
                        ? null
                        : new Date(
                            origin.sourceTurnCompletedAt,
                          ).toISOString(),
                  };
            return this.#materialize(input, captured, attempt!);
          },
        );
        await this.#publications().publishAuthoritativeReplacement(input.scope);
        return result;
      } finally {
        acquired.release();
      }
    }
    if (input.sourceKind === "automation") {
      this.input.automationExecutionPolicy.assertCanAutomate(
        input.scope,
        input.sourceThreadId,
      );
    } else if (input.sourceKind === "agent_control") {
      if (!input.initiatingAgentThreadId) {
        throw new DomainError(
          "conflict",
          "The agent fork is missing its trusted controller thread.",
        );
      }
      this.input.inventory.getThread(
        input.scope,
        input.initiatingAgentThreadId,
      );
    } else if (input.sourceKind === "principal_client") {
      if (!input.initiatingToolClientId) {
        throw new DomainError(
          "conflict",
          "The principal-client fork is missing its trusted client.",
        );
      }
    }
    this.#assertSourceEligible(input.scope, input.sourceThreadId);
    const target = await this.input.targets.actor(
      input.scope,
      input.sourceThreadId,
    );
    const acquired = await this.input.actors.acquire(target, {
      idleRelease: "retain",
    });
    try {
      const result = await acquired.actor.withBranchCheckpoint(
        input.selection ?? { kind: "latest_completed" },
        async (resolved) => {
          if (
            resolved.reference.backendInstanceId !==
            target.binding.backendInstanceId
          ) {
            throw new DomainError(
              "conflict",
              "The backend returned a checkpoint for a different instance.",
            );
          }
          const capturedCommon: CapturedForkCommon = {
            target,
            checkpointRef: resolved.reference,
            effectiveSettings: resolved.effectiveSettings,
            branching: resolved.branching,
          };
          const captured: CapturedFork =
            resolved.boundaryKind === "provider_snapshot_at_acceptance"
              ? {
                  ...capturedCommon,
                  boundaryKind: resolved.boundaryKind,
                  sourceTurnId: null,
                  sourceTurnCompletedAt: null,
                }
              : {
                  ...capturedCommon,
                  boundaryKind: resolved.boundaryKind,
                  sourceTurnId: resolved.sourceTurnId,
                  sourceTurnCompletedAt: resolved.sourceTurnCompletedAt,
                };
          const prepared = this.#prepare(input, captured);
          return this.#materialize(input, captured, prepared);
        },
      );
      await this.#publications().publishAuthoritativeReplacement(input.scope);
      return result;
    } finally {
      acquired.release();
    }
  }

  #prepare(
    input: {
      readonly scope: RequestScope;
      readonly sourceThreadId: string;
      readonly environmentVariables?: EnvironmentVariableOverrides;
      readonly mutationId: string;
      readonly sourceKind: ForkSourceKind;
      readonly originKind: "automation_fork" | UserForkOriginKind;
      readonly initiatingPrincipalId: string;
      readonly initiatingAgentThreadId?: string;
      readonly initiatingToolClientId?: string;
      readonly automationId?: string;
      readonly automationRunId?: string;
      readonly selection?: ActorBranchCheckpointSelection;
    },
    captured: CapturedFork,
  ): ConversationCreationAttemptRecord {
    if (
      captured.boundaryKind === "completed_turn_inclusive" &&
      captured.sourceTurnId === null
    ) {
      throw new DomainError(
        "conflict",
        "A new completed-turn fork requires a resolved source turn.",
      );
    }
    const childId = this.#id();
    const attemptId = this.#id();
    const creationCorrelation = this.#id();
    try {
      return this.input.database.transaction(() => {
        // Check application-owned eligibility again at the atomic reservation
        // boundary. Checkpoint capture can await provider I/O, during which an
        // archive, queued input, or recovery state may have become durable.
        if (input.sourceKind === "automation") {
          this.input.automationExecutionPolicy.assertCanAutomate(
            input.scope,
            input.sourceThreadId,
          );
        }
        this.#assertSourceEligible(input.scope, input.sourceThreadId);
        const source = this.input.bindings.findThreadDefinition(
          input.scope,
          input.sourceThreadId,
        );
        if (!source || source.backingState !== "bound") {
          throw new DomainError(
            "invalid_transition",
            "Only a bound thread can be forked.",
          );
        }
        const checkpoint = (() => {
          if (captured.boundaryKind === "provider_snapshot_at_acceptance") {
            return this.input.checkpoints.createProviderSnapshot(
              input.scope,
              input.sourceThreadId,
              {
                id: input.mutationId,
                opaqueReference: captured.checkpointRef.opaqueReference,
                now: this.#now(),
              },
            );
          }
          if (captured.sourceTurnId === null) {
            throw new DomainError(
              "conflict",
              "A new completed-turn fork requires a resolved source turn.",
            );
          }
          return this.input.checkpoints.create(
            input.scope,
            input.sourceThreadId,
            {
              id: input.mutationId,
              applicationTurnId: captured.sourceTurnId,
              opaqueReference: captured.checkpointRef.opaqueReference,
              now: this.#now(),
            },
          );
        })();
        const child = this.input.bindings.createUnboundThread(input.scope, {
          id: childId,
          workspaceId: source.workspaceId,
          connectionProfileId: source.connectionProfileId,
          title: source.title,
          now: this.#now(),
        });
        this.input.environmentVariables?.copy(input.scope, input.sourceThreadId, child.id, input.environmentVariables);
        this.input.executionWorkspaces?.copySelection(
          input.scope,
          input.sourceThreadId,
          child.id,
        );
        this.input.deliveryInputSnapshots?.copyThread(
          input.scope,
          input.sourceThreadId,
          child.id,
        );
        const persistence = this.#persistence(input.scope, child.id);
        persistence.initializeForkThread(
          input.scope,
          input.sourceThreadId,
          child.id,
          captured.target.driver.connection,
          captured.effectiveSettings,
        );
        const common = {
          attemptId,
          mutationId: input.mutationId,
          expectedThreadRevision: 0,
          creationKind: "fork" as const,
          forkChildIdentity: captured.branching.childIdentity,
          forkCreationRecovery: captured.branching.creationRecovery,
          initialInputText: null,
          initialAttachmentIds: [] as const,
          backendCreationCorrelation: creationCorrelation,
          now: this.#now(),
        };
        const attempt =
          input.sourceKind === "automation"
            ? this.input.creation.prepare(input.scope, child.id, {
                ...common,
                sourceKind: "automation",
                sourceAutomationId: input.automationId!,
                sourceAutomationRunId: input.automationRunId!,
              })
            : input.sourceKind === "agent_control"
              ? this.input.creation.prepare(input.scope, child.id, {
                  ...common,
                  sourceKind: "agent_control",
                  initiatingAgentThreadId: input.initiatingAgentThreadId!,
                })
              : input.sourceKind === "principal_client"
                ? this.input.creation.prepare(input.scope, child.id, {
                    ...common,
                    sourceKind: "principal_client",
                    initiatingToolClientId: input.initiatingToolClientId!,
                  })
              : this.input.creation.prepare(input.scope, child.id, {
                  ...common,
                  sourceKind: "user_fork",
                });
        this.input.environmentVariables?.recordForkRequest(input.scope, input.mutationId, child.id);
        const originCommon = {
          childThreadId: child.id,
          sourceThreadId: input.sourceThreadId,
          sourceCheckpointId: checkpoint.id,
          initiatingPrincipalId: input.initiatingPrincipalId,
          branchMethod: captured.branching.method,
          creationOperationId: input.mutationId,
          now: this.#now(),
        };
        if (captured.boundaryKind === "provider_snapshot_at_acceptance") {
          if (
            input.originKind !== "user_fork" ||
            input.selection?.kind !== "latest_provider_snapshot" ||
            captured.sourceTurnId !== null ||
            captured.sourceTurnCompletedAt !== null
          ) {
            throw new DomainError(
              "conflict",
              "A provider snapshot requires an unanchored manual fork.",
            );
          }
          this.input.lineage.prepareProviderSnapshotOrigin(input.scope, {
            childThreadId: child.id,
            sourceThreadId: input.sourceThreadId,
            sourceCheckpointId: checkpoint.id,
            initiatingPrincipalId: input.initiatingPrincipalId,
            branchMethod: captured.branching.method,
            creationOperationId: input.mutationId,
            now: this.#now(),
          });
        } else {
          const sourceTurnId = captured.sourceTurnId;
          if (sourceTurnId === null) {
            throw new DomainError(
              "conflict",
              "A new completed-turn fork requires a resolved source turn.",
            );
          }
          if (input.originKind === "automation_fork") {
            this.input.lineage.prepareOrigin(input.scope, {
              ...originCommon,
              sourceTurnId,
              sourceTurnCompletedAt:
                captured.sourceTurnCompletedAt === null
                  ? null
                  : Date.parse(captured.sourceTurnCompletedAt),
              originKind: "automation_fork",
              sourceAutomationId: input.automationId!,
              sourceAutomationRunId: input.automationRunId!,
            });
          } else if (input.selection?.kind !== "selected_completed_turn") {
            throw new DomainError(
              "conflict",
              "A manual fork requires an exact source-turn revision.",
            );
          } else if (input.originKind === "agent_fork") {
            this.input.lineage.prepareOrigin(input.scope, {
              ...originCommon,
              sourceTurnId,
              sourceTurnCompletedAt:
                captured.sourceTurnCompletedAt === null
                  ? null
                  : Date.parse(captured.sourceTurnCompletedAt),
              originKind: "agent_fork",
              sourceTurnRevision: input.selection.expectedTurnRevision,
              initiatingAgentThreadId: input.initiatingAgentThreadId!,
            });
          } else if (input.originKind === "principal_client_fork") {
            this.input.lineage.prepareOrigin(input.scope, {
              ...originCommon,
              sourceTurnId,
              sourceTurnCompletedAt:
                captured.sourceTurnCompletedAt === null
                  ? null
                  : Date.parse(captured.sourceTurnCompletedAt),
              originKind: "principal_client_fork",
              sourceTurnRevision: input.selection.expectedTurnRevision,
              initiatingToolClientId: input.initiatingToolClientId!,
            });
          } else {
            this.input.lineage.prepareOrigin(input.scope, {
              ...originCommon,
              sourceTurnId,
              sourceTurnCompletedAt:
                captured.sourceTurnCompletedAt === null
                  ? null
                  : Date.parse(captured.sourceTurnCompletedAt),
              originKind: "user_fork",
              sourceTurnRevision: input.selection.expectedTurnRevision,
            });
          }
        }
        return attempt;
      })();
    } catch (error) {
      const concurrent = this.input.creation.findByMutationId(
        input.scope,
        input.mutationId,
      );
      if (!concurrent) throw error;
      this.#assertAttempt(input, concurrent);
      return concurrent;
    }
  }

  async #materialize(
    input: {
      readonly scope: RequestScope;
      readonly sourceThreadId: string;
      readonly mutationId: string;
      readonly sourceKind: ForkSourceKind;
      readonly automationId?: string;
      readonly automationRunId?: string;
      readonly automatic?: boolean;
    },
    captured: CapturedFork,
    initial: ConversationCreationAttemptRecord,
  ): Promise<ThreadForkResult> {
    let attempt = initial;
    if (attempt.phase === "bound") {
      return { status: "created", childThreadId: attempt.applicationThreadId };
    }
    if (attempt.phase === "aborted_unpersisted") {
      return {
        status: "aborted",
        childThreadId: attempt.applicationThreadId,
        diagnostic: attempt.diagnostic ?? "The backend fork was not created.",
        restartable: true,
      };
    }
    if (
      attempt.phase === "conversation_identified" ||
      (attempt.phase === "recovery_required" &&
        attempt.provisionalBackendConversationId !== null &&
        attempt.provisionalOpaqueBindingDetail !== null)
    ) {
      this.#finalize(input, attempt);
      return { status: "created", childThreadId: attempt.applicationThreadId };
    }
    // Validate every local prerequisite before crossing the durable external
    // boundary. A corrupt checkpoint or settings row is a local failure, not
    // an unknown provider outcome.
    const durableSettings = this.#persistence(
      input.scope,
      attempt.applicationThreadId,
    ).readForkSettings(input.scope, attempt.applicationThreadId);
    const checkpoint = this.input.checkpoints.get(
      input.scope,
      input.mutationId,
    );
    if (
      checkpoint.applicationThreadId !== input.sourceThreadId ||
      checkpoint.applicationTurnId !== captured.sourceTurnId ||
      checkpoint.boundaryKind !== captured.boundaryKind ||
      checkpoint.backendInstanceId !== captured.checkpointRef.backendInstanceId
    ) {
      throw new DomainError(
        "conflict",
        "The durable fork checkpoint no longer matches its source boundary.",
      );
    }
    let startedNow = false;
    if (attempt.phase === "prepared") {
      attempt = this.input.creation.markExternalCallStarted(
        input.scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        this.#now(),
      );
      startedNow = true;
    }
    if (
      attempt.phase !== "external_call_started" &&
      attempt.phase !== "recovery_required"
    ) {
      throw new DomainError(
        "materialization_unresolved",
        `Fork creation cannot continue from ${attempt.phase}.`,
      );
    }
    if (!startedNow && attempt.forkCreationRecovery !== "idempotent") {
      if (attempt.phase === "external_call_started") {
        attempt = this.input.creation.markRecoveryRequired(
          input.scope,
          attempt.applicationThreadId,
          attempt.attemptId,
          {
            expected: "external_call_started",
            diagnostic:
              attempt.forkCreationRecovery === "potentially_unknown"
                ? FORK_UNKNOWN_DIAGNOSTIC
                : "The provider fork requires exact reconciliation and was not repeated.",
            ...(attempt.forkCreationRecovery === "potentially_unknown"
              ? { forkUncertaintyKind: "fork_unknown" as const }
              : {}),
            now: this.#now(),
          },
        );
      }
      return this.#recovery(attempt, false);
    }
    const externalPhase = attempt.phase;
    let created;
    try {
      const branchCommon = {
        scope: input.scope,
        childApplicationThreadId: attempt.applicationThreadId,
        applicationOperationId: input.mutationId,
        sourceBinding: captured.target.binding,
        sourceOpaqueBindingDetail: captured.target.opaqueBindingDetail,
        workspace: captured.target.workspace,
        sourceCheckpoint: {
          backendInstanceId: checkpoint.backendInstanceId,
          kind: checkpoint.kind,
          opaqueReference: checkpoint.opaqueReference,
        },
        ...(attempt.forkChildIdentity === "application_reserved"
          ? {
              requestedBackendConversationId:
                attempt.backendCreationCorrelation,
            }
          : { creationCorrelation: attempt.backendCreationCorrelation }),
        inheritedSettings: durableSettings,
        title: this.input.bindings.findThreadDefinition(
          input.scope,
          input.sourceThreadId,
        )?.title,
      } as const;
      created =
        input.sourceKind === "automation"
          ? await captured.target.driver.branchConversation({
              ...branchCommon,
              source: {
                kind: "automation",
                automationId: input.automationId!,
                automationRunId: input.automationRunId!,
              },
            })
          : await captured.target.driver.branchConversation({
              ...branchCommon,
              source: { kind: "user" },
            });
      if (
        attempt.forkChildIdentity === "application_reserved" &&
        created.backendConversationId !== attempt.backendCreationCorrelation
      ) {
        throw new BackendError({
          category: "internal",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage:
            "The backend returned a different reserved fork identity.",
        });
      }
    } catch (error) {
      // Only a definite failure may discard the reserved child. On a retry,
      // an earlier call may already have created it, so a transient definite
      // failure keeps the recovery; startup recovery never discards at all.
      const definite =
        error instanceof BackendError && !error.crossedSubmissionBoundary;
      const discard =
        definite &&
        !input.automatic &&
        (externalPhase !== "recovery_required" || !error.retryable);
      reportBackgroundError(
        `Fork ${attempt.applicationThreadId} creation (${discard ? "aborted" : "needs recovery"}${
          error instanceof BackendError && error.backendCode ? `, ${error.backendCode}` : ""
        })`,
      )(error);
      if (discard) {
        let promotedTaskIds: readonly string[] = [];
        const abortInput = {
          creationOperationId: input.mutationId,
          diagnostic: safeDiagnostic(error),
          restartable: error.forkRestart !== "futile",
          now: this.#now(),
          onThreadTasksPromoted: (taskIds: readonly string[]) => {
            promotedTaskIds = taskIds;
          },
        };
        const aborted =
          captured.boundaryKind === "provider_snapshot_at_acceptance"
            ? this.input.lineage.abortPreparedProviderSnapshotFork(
                input.scope,
                attempt.applicationThreadId,
                abortInput,
              )
            : this.input.lineage.abortPreparedFork(
                input.scope,
                attempt.applicationThreadId,
                abortInput,
              );
        for (const promotedTaskId of promotedTaskIds) {
          // The bound publisher (TaskService) queues a scheduler-driven
          // retry on failure instead of throwing, so the successful abort
          // result is preserved without abandoning the publication.
          await this.#taskPublications?.publishTaskChange(
            input.scope,
            promotedTaskId,
          );
        }
        await this.#collectOutputArtifactGarbage();
        return {
          status: "aborted",
          childThreadId: aborted.reservedChildThreadId,
          diagnostic: aborted.diagnostic,
          restartable: aborted.restartable,
        };
      }
      const forkUnknown =
        attempt.forkCreationRecovery === "potentially_unknown" &&
        (!(error instanceof BackendError) || error.crossedSubmissionBoundary);
      attempt =
        externalPhase === "recovery_required"
          ? this.input.creation.refreshRecoveryRequired(
              input.scope,
              attempt.applicationThreadId,
              attempt.attemptId,
              {
                diagnostic: forkUnknown
                  ? FORK_UNKNOWN_DIAGNOSTIC
                  : safeDiagnostic(error),
                now: this.#now(),
              },
            )
          : this.input.creation.markRecoveryRequired(
              input.scope,
              attempt.applicationThreadId,
              attempt.attemptId,
              {
                expected: "external_call_started",
                diagnostic: forkUnknown
                  ? FORK_UNKNOWN_DIAGNOSTIC
                  : safeDiagnostic(error),
                ...(forkUnknown
                  ? { forkUncertaintyKind: "fork_unknown" as const }
                  : {}),
                now: this.#now(),
              },
            );
      return this.#recovery(
        attempt,
        attempt.forkCreationRecovery === "idempotent",
      );
    }
    try {
      attempt = this.#recordIdentifiedResponse(input.scope, attempt, {
        expected: externalPhase,
        backendConversationId: created.backendConversationId,
        opaqueBindingDetail: created.opaqueBindingDetail,
        reconciliationToken: created.reconciliationToken,
        now: this.#now(),
      });
      this.#finalize(input, attempt);
      return { status: "created", childThreadId: attempt.applicationThreadId };
    } catch (error) {
      const current = this.input.creation.get(
        input.scope,
        attempt.applicationThreadId,
        attempt.attemptId,
      );
      if (
        current.phase === "external_call_started" ||
        current.phase === "conversation_identified"
      ) {
        this.input.creation.markRecoveryRequired(
          input.scope,
          current.applicationThreadId,
          current.attemptId,
          {
            expected: current.phase,
            reconciliationToken: created.reconciliationToken,
            provisionalBackendConversationId: created.backendConversationId,
            provisionalOpaqueBindingDetail: created.opaqueBindingDetail,
            diagnostic: safeDiagnostic(error),
            now: this.#now(),
          },
        );
      }
      const recovery = this.input.creation.get(
        input.scope,
        attempt.applicationThreadId,
        attempt.attemptId,
      );
      return this.#recovery(
        recovery,
        recovery.provisionalBackendConversationId !== null &&
          recovery.provisionalOpaqueBindingDetail !== null
          ? true
          : attempt.forkCreationRecovery === "idempotent",
      );
    }
  }

  #recordIdentifiedResponse(
    scope: RequestScope,
    attempt: ConversationCreationAttemptRecord,
    input: {
      readonly expected: "external_call_started" | "recovery_required";
      readonly backendConversationId: string;
      readonly opaqueBindingDetail: string;
      readonly reconciliationToken?: string;
      readonly now: number;
    },
  ): ConversationCreationAttemptRecord {
    const matches = (current: ConversationCreationAttemptRecord): boolean =>
      current.provisionalBackendConversationId ===
        input.backendConversationId &&
      current.provisionalOpaqueBindingDetail === input.opaqueBindingDetail;
    const read = (): ConversationCreationAttemptRecord =>
      this.input.creation.get(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
      );
    const record = (): void => {
      this.input.creation.recordConversationIdentified(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        {
          ...input,
          clearForkUncertainty:
            attempt.forkUncertaintyKind === "fork_unknown" &&
            input.expected === "recovery_required",
        },
      );
    };
    try {
      record();
    } catch (firstError) {
      const afterFirst = read();
      if (matches(afterFirst)) return afterFirst;
      if (afterFirst.phase !== input.expected) throw firstError;
      try {
        record();
      } catch (secondError) {
        const afterSecond = read();
        if (matches(afterSecond)) return afterSecond;
        throw secondError;
      }
    }
    return read();
  }

  #finalize(
    input: {
      readonly scope: RequestScope;
      readonly mutationId: string;
      readonly sourceKind: ForkSourceKind;
      readonly automationId?: string;
      readonly automationRunId?: string;
    },
    attempt: ConversationCreationAttemptRecord,
  ): void {
    const persistence = this.#persistence(
      input.scope,
      attempt.applicationThreadId,
    );
    const detail = attempt.provisionalOpaqueBindingDetail;
    if (!detail || !attempt.provisionalBackendConversationId) {
      throw new DomainError(
        "materialization_unresolved",
        "The fork is missing durable backend binding detail.",
      );
    }
    this.input.database.transaction(() => {
      this.input.bindings.bindCreatedConversation(
        input.scope,
        attempt.applicationThreadId,
        {
          attemptId: attempt.attemptId,
          backendConversationId: attempt.provisionalBackendConversationId!,
          acceptedAt: this.#now(),
        },
      );
      persistence.saveBoundBindingDetail(
        input.scope,
        attempt.applicationThreadId,
        detail,
      );
      this.input.lineage.commitOrigin(
        input.scope,
        attempt.applicationThreadId,
        input.mutationId,
        this.#now(),
      );
      if (input.sourceKind === "automation") {
        this.input.automations.bindForkChild(
          input.scope,
          input.automationId!,
          input.automationRunId!,
          { childThreadId: attempt.applicationThreadId, now: this.#now() },
        );
      }
    })();
  }

  #persistence(
    scope: RequestScope,
    applicationThreadId: string,
  ): BackendThreadPersistenceAdapter {
    const thread = this.input.bindings.findThreadDefinition(
      scope,
      applicationThreadId,
    );
    const persistence = thread
      ? this.input.backendPersistence.get(thread.backendInstanceId)
      : undefined;
    if (!persistence) {
      throw new DomainError(
        "invalid_transition",
        "The fork backend persistence provider is unavailable.",
      );
    }
    return persistence;
  }

  #assertSourceEligible(scope: RequestScope, sourceThreadId: string): void {
    const aggregate = this.input.inventory.getThread(scope, sourceThreadId);
    const source = aggregate.thread;
    this.input.inventory.assertWorkspaceActive(scope, source.workspaceId);
    if (
      source.backingState !== "bound" ||
      source.availability !== "available" ||
      aggregate.inventory.inventoryState === "archived"
    ) {
      throw new DomainError(
        "invalid_transition",
        "The source thread is unavailable for forking.",
      );
    }
    if (
      this.input.creation.findActiveForThread(scope, sourceThreadId) ||
      this.input.operations.hasBlockingThreadOperation(scope, sourceThreadId)
    ) {
      throw new DomainError(
        "invalid_transition",
        "Resolve the source thread's uncertain operation before forking.",
      );
    }
    const queued = this.input.database
      .prepare(
        `
      SELECT 1
      FROM queued_inputs
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND application_thread_id = ?
        AND (
          state IN ('pending', 'retry_wait', 'dispatching', 'uncertain')
          OR (state = 'failed' AND failure_acknowledged_at IS NULL)
        )
      LIMIT 1
    `,
      )
      .get(scope.tenantId, scope.principalId, sourceThreadId);
    if (queued) {
      throw new DomainError(
        "invalid_transition",
        "Resolve or cancel queued source work before forking.",
      );
    }
  }

  #assertAttempt(
    input: {
      readonly scope: RequestScope;
      readonly sourceThreadId: string;
      readonly sourceKind: ForkSourceKind;
      readonly originKind: "automation_fork" | UserForkOriginKind;
      readonly initiatingAgentThreadId?: string;
      readonly initiatingToolClientId?: string;
      readonly automationId?: string;
      readonly automationRunId?: string;
      readonly selection?: ActorBranchCheckpointSelection;
    },
    attempt: ConversationCreationAttemptRecord,
  ): void {
    if (
      attempt.creationKind !== "fork" ||
      attempt.sourceKind !== input.sourceKind ||
      attempt.sourceAutomationId !== (input.automationId ?? null) ||
      attempt.sourceAutomationRunId !== (input.automationRunId ?? null) ||
      attempt.initiatingAgentThreadId !==
        (input.initiatingAgentThreadId ?? null) ||
      attempt.initiatingToolClientId !==
        (input.initiatingToolClientId ?? null) ||
      attempt.initialInputText !== null
    ) {
      throw new DomainError(
        "conflict",
        "The fork mutation ID is already used by another operation.",
      );
    }
    const origin = this.input.lineage.findByCreationOperation(
      input.scope,
      attempt.mutationId,
    );
    const boundaryMatches =
      input.sourceKind === "automation"
        ? true
        : input.selection?.kind === "selected_completed_turn"
          ? origin?.boundaryKind === "completed_turn_inclusive" &&
            origin.sourceTurnId === input.selection.turnId &&
            origin.sourceTurnRevision === input.selection.expectedTurnRevision
          : input.selection?.kind === "latest_provider_snapshot"
            ? origin?.boundaryKind === "provider_snapshot_at_acceptance" &&
              origin.sourceTurnId === null &&
              origin.sourceTurnRevision === null
            : false;
    if (
      !origin ||
      origin.childThreadId !== attempt.applicationThreadId ||
      origin.sourceThreadId !== input.sourceThreadId ||
      origin.originKind !== input.originKind ||
      origin.initiatingAgentThreadId !==
        (input.initiatingAgentThreadId ?? null) ||
      origin.initiatingToolClientId !==
        (input.initiatingToolClientId ?? null) ||
      !boundaryMatches
    ) {
      throw new DomainError(
        "conflict",
        "The fork mutation ID is already used by another source boundary.",
      );
    }
  }

  #assertAbortedReplay(
    input: {
      readonly sourceThreadId: string;
      readonly sourceKind: ForkSourceKind;
      readonly initiatingAgentThreadId?: string;
      readonly initiatingToolClientId?: string;
      readonly automationId?: string;
      readonly automationRunId?: string;
      readonly selection?: ActorBranchCheckpointSelection;
    },
    aborted: import("../domain/thread-lineage-models.js").AbortedThreadForkRecord,
  ): void {
    const boundaryMatches =
      input.sourceKind === "automation"
        ? aborted.boundaryKind === "completed_turn_inclusive"
        : input.selection?.kind === "selected_completed_turn"
          ? aborted.boundaryKind === "completed_turn_inclusive" &&
            aborted.sourceTurnId === input.selection.turnId &&
            aborted.sourceTurnRevision === input.selection.expectedTurnRevision
          : input.selection?.kind === "latest_provider_snapshot"
            ? aborted.boundaryKind === "provider_snapshot_at_acceptance" &&
              aborted.sourceTurnId === null &&
              aborted.sourceTurnRevision === null
            : false;
    if (
      aborted.sourceThreadId !== input.sourceThreadId ||
      aborted.sourceKind !== input.sourceKind ||
      aborted.sourceAutomationId !== (input.automationId ?? null) ||
      aborted.sourceAutomationRunId !== (input.automationRunId ?? null) ||
      aborted.initiatingAgentThreadId !==
        (input.initiatingAgentThreadId ?? null) ||
      aborted.initiatingToolClientId !==
        (input.initiatingToolClientId ?? null) ||
      !boundaryMatches
    ) {
      throw new DomainError(
        "conflict",
        "The fork mutation ID is already used by another aborted request.",
      );
    }
  }

  #recovery(
    attempt: ConversationCreationAttemptRecord,
    retryable: boolean,
  ): ThreadForkResult {
    return {
      status: "recovery_required",
      childThreadId: attempt.applicationThreadId,
      retryable,
      uncertaintyKind: attempt.forkUncertaintyKind,
      diagnostic:
        attempt.diagnostic ?? "Fork creation requires explicit recovery.",
    };
  }

  #encodeCursor(
    scope: RequestScope,
    sourceThreadId: string,
    cursor: { readonly createdAt: number; readonly childThreadId: string },
  ): string {
    const payload = Buffer.from(
      JSON.stringify({ version: 1, ...cursor }),
    ).toString("base64url");
    const signature = this.#cursorSignature(
      scope,
      sourceThreadId,
      payload,
    ).toString("base64url");
    return `${payload}.${signature}`;
  }

  #publications(): ApplicationSnapshotPublicationBoundary {
    if (!this.#applicationSnapshots) {
      throw new Error("thread_fork_application_snapshots_unbound");
    }
    return this.#applicationSnapshots;
  }

  #decodeCursor(
    scope: RequestScope,
    sourceThreadId: string,
    encoded: string,
  ): { readonly createdAt: number; readonly childThreadId: string } {
    try {
      const parts = encoded.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error("invalid");
      }
      const [payload, encodedSignature] = parts as [string, string];
      const signature = Buffer.from(encodedSignature, "base64url");
      const payloadBytes = Buffer.from(payload, "base64url");
      if (
        signature.toString("base64url") !== encodedSignature ||
        payloadBytes.toString("base64url") !== payload
      ) {
        throw new Error("invalid");
      }
      const expected = this.#cursorSignature(scope, sourceThreadId, payload);
      if (
        signature.length !== expected.length ||
        !timingSafeEqual(signature, expected)
      ) {
        throw new Error("invalid");
      }
      const value = JSON.parse(payloadBytes.toString()) as {
        version?: unknown;
        createdAt?: unknown;
        childThreadId?: unknown;
      };
      if (
        value.version !== 1 ||
        !Number.isSafeInteger(value.createdAt) ||
        typeof value.childThreadId !== "string" ||
        value.childThreadId.length < 1 ||
        value.childThreadId.length > 160
      ) {
        throw new Error("invalid");
      }
      return {
        createdAt: value.createdAt as number,
        childThreadId: value.childThreadId,
      };
    } catch {
      throw new DomainError(
        "cursor_invalid",
        "The descendant cursor is invalid.",
      );
    }
  }

  #cursorSignature(
    scope: RequestScope,
    sourceThreadId: string,
    payload: string,
  ): Buffer {
    return createHmac("sha256", this.#cursorSigningKey)
      .update(scope.tenantId)
      .update("\0")
      .update(scope.principalId)
      .update("\0")
      .update(sourceThreadId)
      .update("\0")
      .update(payload)
      .digest();
  }
}

function safeDiagnostic(error: unknown): string {
  const message =
    error instanceof BackendError
      ? error.safeMessage
      : error instanceof Error
        ? error.message
        : "Unknown backend fork failure.";
  return message.length <= 500 ? message : message.slice(0, 500);
}
