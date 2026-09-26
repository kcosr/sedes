export type ForkBoundaryKind =
  | "completed_turn_inclusive"
  | "provider_snapshot_at_acceptance";

export type ForkOriginKind =
  | "user_fork"
  | "automation_fork"
  | "agent_fork"
  | "principal_client_fork"
  | "imported_native_fork";

export type ForkBranchMethod = "provider_native" | "provider_history_import";

export type ForkSourceTurnState = "resolved" | "unresolved";
export type ForkSourceThreadState = "resolved" | "unresolved";
export type ForkOriginState = "prepared" | "committed";
export type ThreadLineagePlacementMode = "nested_under_source" | "top_level";
export type ThreadLineagePlacementState = "default" | "explicit";

type ThreadForkOriginRecordCommon = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly childThreadId: string;
  readonly providerParentBackendConversationId: string | null;
  readonly sourceCheckpointId: string | null;
  readonly initiatingPrincipalId: string | null;
  readonly initiatingAgentThreadId: string | null;
  readonly initiatingToolClientId: string | null;
  readonly sourceAutomationId: string | null;
  readonly sourceAutomationRunId: string | null;
  readonly branchMethod: ForkBranchMethod;
  readonly creationOperationId: string | null;
  readonly originState: ForkOriginState;
  readonly createdAt: number;
  readonly committedAt: number | null;
};

export type CompletedTurnThreadForkOriginRecord =
  ThreadForkOriginRecordCommon & {
    readonly sourceThreadState: ForkSourceThreadState;
    readonly sourceThreadId: string | null;
    readonly sourceTurnState: ForkSourceTurnState;
    readonly sourceTurnId: string | null;
    readonly sourceTurnRevision: number | null;
    readonly sourceTurnCompletedAt: number | null;
    readonly boundaryKind: "completed_turn_inclusive";
    readonly originKind: ForkOriginKind;
  };

export type ProviderSnapshotThreadForkOriginRecord =
  ThreadForkOriginRecordCommon & {
    readonly sourceThreadState: "resolved";
    readonly sourceThreadId: string;
    readonly sourceTurnState: "unresolved";
    readonly sourceTurnId: null;
    readonly sourceTurnRevision: null;
    readonly sourceTurnCompletedAt: null;
    readonly sourceCheckpointId: string;
    readonly boundaryKind: "provider_snapshot_at_acceptance";
    readonly originKind: "user_fork";
  };

export type ThreadForkOriginRecord =
  | CompletedTurnThreadForkOriginRecord
  | ProviderSnapshotThreadForkOriginRecord;

export type AbortedThreadForkRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly creationOperationId: string;
  readonly reservedChildThreadId: string;
  readonly sourceThreadId: string;
  readonly sourceTurnId: string | null;
  readonly sourceTurnRevision: number | null;
  readonly boundaryKind: ForkBoundaryKind;
  readonly sourceKind:
    | "automation"
    | "user_fork"
    | "agent_control"
    | "principal_client";
  readonly initiatingAgentThreadId: string | null;
  readonly initiatingToolClientId: string | null;
  readonly sourceAutomationId: string | null;
  readonly sourceAutomationRunId: string | null;
  readonly diagnostic: string;
  readonly abortedAt: number;
  /** False when a new fork of the same boundary would fail the same way. */
  readonly restartable: boolean;
};

export type ThreadLineagePlacementRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly childThreadId: string;
  readonly placementMode: ThreadLineagePlacementMode;
  readonly placementState: ThreadLineagePlacementState;
  readonly revision: number;
  readonly updatedAt: number;
};

export type ThreadDescendantCursor = {
  readonly createdAt: number;
  readonly childThreadId: string;
};

export type ThreadDescendantPage = {
  readonly descendants: readonly ThreadForkOriginRecord[];
  readonly nextCursor: ThreadDescendantCursor | null;
};
