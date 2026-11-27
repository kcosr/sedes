import type { NormalizedThreadSummary } from "../../../shared/protocol/conversation.js";
import type { BackendKind } from "../../backends/contracts.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AgentThreadGroup } from "../application/thread-group-membership-read.js";
import type { AgentThreadSnoozeFields } from "../application/thread-snooze-presentation.js";
import type { TrustedEnvironmentAuthorityGrant } from "../environment/environment-authority.js";

export interface AgentSourceContext {
  readonly threadId: string;
  readonly workspaceId: string;
  /** The project of the source workspace, read live at admission. */
  readonly projectId: string;
  readonly backend: BackendKind;
}

export interface ThreadStatusResult extends AgentThreadSnoozeFields {
  readonly threadId: string;
  readonly backend: BackendKind;
  readonly lifecycle: NormalizedThreadSummary["inventoryState"];
  readonly pinned: boolean;
  readonly group: AgentThreadGroup | null;
  readonly activity: "idle" | "running" | "waiting_for_input";
}

/** A scoped miss and a foreign-scope thread are intentionally indistinguishable. */
export interface AgentToolApplicationReader {
  readThreadStatus(
    scope: RequestScope,
    threadId: string,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
    signal: AbortSignal,
  ): Promise<ThreadStatusResult | undefined>;
}
