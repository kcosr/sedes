import path from "node:path";
import type { AgentToolCliAvailability } from "../module.js";
import type { AgentToolSourceCapabilityIssuer } from "../../agent-tools/application/database-agent-tool-source-authority.js";
import type { BackendAgentToolFacade, TrustedAgentToolSource } from "../../agent-tools/adapters/backend-facade.js";
import type { AttachConversationInput } from "../contracts.js";
import { isAgentToolCliEndpoint } from "../../../internal/agent-tool-cli-protocol/local-endpoint.js";
import type { OpenCodeDriverContext } from "./opencode-conversation-context.js";

export interface OpenCodeCliPlan {
  readonly source: TrustedAgentToolSource;
  readonly endpoint: string;
  readonly executableDirectory: string;
  readonly mode: "individual" | "progressive";
}

/** CLI references retain their existing strict audience; they never enter the shared MCP registration. */
export class OpenCodeCliEnvironment {
  readonly #diagnostics = new Map<string, string>();
  constructor(readonly options: { readonly ownership: "owned" | "external"; readonly availability: AgentToolCliAvailability;
    readonly sourceCapabilities: AgentToolSourceCapabilityIssuer;
    readonly tools: Pick<BackendAgentToolFacade, "readPolicy"> }) {}

  plan(context: OpenCodeDriverContext, input: AttachConversationInput): OpenCodeCliPlan | undefined {
    const threadId = input.binding.applicationThreadId;
    this.#diagnostics.delete(threadId);
    const source: TrustedAgentToolSource = { scope: input.scope, sourceThreadId: input.binding.applicationThreadId,
      sourceWorkspaceId: input.workspace.summary.id, sourceEnvironmentId: input.binding.executionEnvironmentId, backendKind: "opencode" };
    const policy = this.options.tools.readPolicy(source);
    if (!policy.enabled || policy.presentation.surface !== "cli") return undefined;
    const unavailable = () => {
      this.#diagnostics.set(threadId, "Sedes CLI tools are unavailable for this OpenCode session. CLI requires a Sedes-created root on an owned local server and an available local Sedes CLI endpoint. Choose Native tools where supported, or disable Sedes tools; messages and conversation controls remain available.");
      return undefined;
    };
    const availability = this.options.availability;
    if (this.options.ownership !== "owned" || availability.availability !== "available" || !path.isAbsolute(availability.executableDirectory) ||
        availability.executableDirectory.includes("\0") || !endpointAllowed(availability.endpoint)) return unavailable();
    const created = context.repository.hasCreatedRoot(input.scope, input.binding.applicationThreadId, input.binding.backendConversationId);
    if (!created) return unavailable();
    return { source, endpoint: availability.endpoint, executableDirectory: availability.executableDirectory, mode: policy.presentation.mode };
  }

  diagnostic(threadId: string): string | undefined { return this.#diagnostics.get(threadId); }
  release(threadId: string): void { this.#diagnostics.delete(threadId); }
  close(): void { this.#diagnostics.clear(); }

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
