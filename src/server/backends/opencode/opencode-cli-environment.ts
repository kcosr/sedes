import path from "node:path";
import type { AgentToolCliAvailability } from "../module.js";
import type { AgentToolSourceCapabilityIssuer } from "../../agent-tools/application/database-agent-tool-source-authority.js";
import type { BackendAgentToolFacade, TrustedAgentToolSource } from "../../agent-tools/adapters/backend-facade.js";
import type { AttachConversationInput } from "../contracts.js";
import { isAgentToolCliEndpoint } from "../../../internal/agent-tool-cli-protocol/local-endpoint.js";
import { openCodeConversationError, type OpenCodeDriverContext } from "./opencode-conversation-context.js";

export interface OpenCodeCliPlan {
  readonly source: TrustedAgentToolSource;
  readonly endpoint: string;
  readonly executableDirectory: string;
  readonly mode: "individual" | "progressive";
}

/** CLI references retain their existing strict audience; they never enter the shared MCP registration. */
export class OpenCodeCliEnvironment {
  constructor(readonly options: { readonly availability: AgentToolCliAvailability;
    readonly sourceCapabilities: AgentToolSourceCapabilityIssuer;
    readonly tools: Pick<BackendAgentToolFacade, "readPolicy"> }) {}

  plan(context: OpenCodeDriverContext, input: AttachConversationInput): OpenCodeCliPlan | undefined {
    const source: TrustedAgentToolSource = { scope: input.scope, sourceThreadId: input.binding.applicationThreadId,
      sourceWorkspaceId: input.workspace.summary.id, sourceEnvironmentId: input.binding.executionEnvironmentId, backendKind: "opencode" };
    const policy = this.options.tools.readPolicy(source);
    if (!policy.enabled || policy.presentation.surface !== "cli") return undefined;
    const availability = this.options.availability;
    if (availability.availability !== "available" || !path.isAbsolute(availability.executableDirectory) ||
        availability.executableDirectory.includes("\0") || !endpointAllowed(availability.endpoint)) throw unavailable();
    const created = context.repository.hasCreatedRoot(input.scope, input.binding.applicationThreadId, input.binding.backendConversationId);
    if (!created) throw unavailable();
    return { source, endpoint: availability.endpoint, executableDirectory: availability.executableDirectory, mode: policy.presentation.mode };
  }

  materialize(plan: OpenCodeCliPlan): Readonly<Record<string, string>> {
    return Object.freeze({ SEDES_AGENT_TOOL_ENDPOINT: plan.endpoint,
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: this.options.sourceCapabilities.issue(plan.source, "management_http", "cli"),
      SEDES_AGENT_TOOL_CLI_MODE: plan.mode });
  }
}
function endpointAllowed(endpoint: string): boolean {
  if (isAgentToolCliEndpoint(endpoint)) return true;
  try { const url = new URL(endpoint); return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port &&
    !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && url.origin === endpoint; }
  catch { return false; }
}
function unavailable() { return openCodeConversationError("opencode_cli_unavailable", "Sedes CLI tools require an admitted owned local Sedes-created OpenCode root session.", "invalid_state"); }
