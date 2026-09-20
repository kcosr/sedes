import type { BackendKind } from "../../backends/contracts.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { TrustedEnvironmentAuthorityGrant } from "../environment/environment-authority.js";

export interface AgentSourceContext {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly backend: BackendKind;
}

export interface ThreadStatusResult {
  readonly threadId: string;
  readonly backend: BackendKind;
  readonly lifecycle: "active" | "snoozed" | "settled" | "archived";
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
