import type { AgentToolCliAvailability } from "../module.js";
import type { BackendAgentToolFacade, TrustedAgentToolSource } from "../../agent-tools/adapters/backend-facade.js";
import type { AttachConversationInput } from "../contracts.js";
import type { OpenCodeDriverContext } from "./opencode-conversation-context.js";

export interface OpenCodeCliPlan {
  readonly source: TrustedAgentToolSource;
  readonly mode: "individual" | "progressive";
}

/** CLI references retain their existing strict audience; they never enter the shared MCP registration. */
export class OpenCodeCliEnvironment {
  readonly #diagnostics = new Map<string, string>();
  constructor(readonly options: { readonly ownership: "owned" | "external"; readonly availability: AgentToolCliAvailability;
    readonly tools: Pick<BackendAgentToolFacade, "readPolicy"> }) {}

  plan(context: OpenCodeDriverContext, input: AttachConversationInput): OpenCodeCliPlan | undefined {
    const threadId = input.binding.applicationThreadId;
    this.#diagnostics.delete(threadId);
    const source: TrustedAgentToolSource = { scope: input.scope, sourceThreadId: input.binding.applicationThreadId,
      sourceWorkspaceId: input.workspace.summary.id, sourceEnvironmentId: input.binding.executionEnvironmentId, backendKind: "opencode" };
    const policy = this.options.tools.readPolicy(source);
    if (!policy.enabled || policy.presentation.surface !== "cli") return undefined;
    const unavailable = () => {
      this.#diagnostics.set(threadId, "Sedes CLI tools are unavailable for this OpenCode session. CLI requires a Sedes-created root on an owned server with an available Sedes CLI endpoint on its execution host. Choose Native tools where supported, or disable Sedes tools; messages and conversation controls remain available.");
      return undefined;
    };
    const availability = this.options.availability;
    if (this.options.ownership !== "owned" || availability.availability === "unavailable") return unavailable();
    const created = context.repository.hasCreatedRoot(input.scope, input.binding.applicationThreadId, input.binding.backendConversationId);
    if (!created) return unavailable();
    return { source, mode: policy.presentation.mode };
  }

  unavailable(threadId: string): void {
    this.#diagnostics.set(threadId, "Sedes CLI tools are unavailable for this message. Messages and conversation controls remain available; tool admission will be retried on a later message.");
  }
  diagnostic(threadId: string): string | undefined { return this.#diagnostics.get(threadId); }
  release(threadId: string): void { this.#diagnostics.delete(threadId); }
  close(): void { this.#diagnostics.clear(); }

}
