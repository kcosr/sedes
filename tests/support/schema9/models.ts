import type {
  AttemptPhase,
  BackingState,
  InventoryState,
  ThreadAvailability,
  ToolMode,
  WakeReason,
} from "./legacy-domain.js";
import type { RequestScope } from "../../../src/server/identity/identity-provider.js";

export type EnvironmentRecord = {
  tenantId: string;
  ownerPrincipalId: string;
  id: string;
  kind: "local";
  label: string;
  availability: "available" | "unavailable";
  diagnosticCode: string | null;
  revision: number;
};

export type WorkspaceRecord = {
  tenantId: string;
  ownerPrincipalId: string;
  environmentId: string;
  id: string;
  canonicalPath: string;
  displayName: string;
  availability: "available" | "unavailable";
  trustState: "trusted" | "untrusted";
  revision: number;
  lastOpenedAt: number;
  createdAt: number;
  updatedAt: number;
};

export type ApplicationThreadRecord = {
  tenantId: string;
  id: string;
  ownerPrincipalId: string;
  environmentId: string;
  workspaceId: string;
  backingState: BackingState;
  reservedNativeSessionId: string | null;
  nativeSessionPath: string | null;
  title: string;
  toolMode: ToolMode;
  availability: ThreadAvailability;
  reconciliationAt: number | null;
  lastActivityAt: number;
  materializationAttemptId: string | null;
  attemptPhase: AttemptPhase | null;
  attemptDiagnosticCode: string | null;
  uncertainAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type ThreadPrincipalStateRecord = {
  tenantId: string;
  principalId: string;
  threadId: string;
  inventoryState: InventoryState;
  stateChangedAt: number;
  snoozedAt: number | null;
  snoozedUntil: number | null;
  wokeAt: number | null;
  wakeReason: WakeReason | null;
  wakeAcknowledgedAt: number | null;
  wakeReminderText: string | null;
  latestAgentCompletionId: string | null;
  latestAgentCompletionAt: number | null;
  seenAgentCompletionId: string | null;
  automationContextRunId: string | null;
  automationContextSourceThreadId: string | null;
  automationContextAt: number | null;
  automationContextOutcome: "triggered" | "failed" | null;
  automationContextDiagnostic: string | null;
  inventoryRevision: number;
};

export type DraftRecord = {
  tenantId: string;
  principalId: string;
  threadId: string;
  text: string;
  updatedAt: number;
  revision: number;
};

export type StashRecord = {
  tenantId: string;
  principalId: string;
  threadId: string;
  id: string;
  text: string;
  createdAt: number;
};

export type ThreadStartPreferencesRecord = {
  tenantId: string;
  threadId: string;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  revision: number;
};

export type PendingFirstSendRecord = {
  tenantId: string;
  principalId: string;
  threadId: string;
  attemptId: string;
  mutationId: string;
  text: string;
  createdAt: number;
  retryMutationId: string | null;
  retryAnchorEntryId: string | null;
  retryAnchorEntryCount: number | null;
  sourceKind: "composer" | "automation";
  automationId: string | null;
  automationRunId: string | null;
};

export type ThreadWithState = {
  thread: ApplicationThreadRecord;
  inventory: ThreadPrincipalStateRecord;
  draft: DraftRecord;
};

export type ThreadInventoryChange =
  | { action: "settle" }
  | { action: "unsettle" }
  | {
      action: "snooze";
      snoozedUntil: number;
      wakeReminderText?: string | null;
    }
  | { action: "wake" }
  | { action: "archive" }
  | { action: "restore" };

export type InventoryChangedEvent = {
  scope: RequestScope;
  threadId: string;
  state: ThreadPrincipalStateRecord;
};

export interface InventoryChangePublisher {
  publishInventoryChanged(event: InventoryChangedEvent): void;
}
