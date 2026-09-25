import type { BackendKind } from "../../backends/contracts.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AgentToolPresentation } from "../../../shared/protocol/conversation.js";
import type {
  AgentToolAdapter,
  AgentToolCatalogSummary,
  AgentToolContractArtifact,
  AgentToolDescription,
  SedesToolError,
  SedesToolInvocationRequest,
  SedesToolInvocationResult,
  SedesToolProgress,
} from "../contracts/agent-tool-contracts.js";

/** Safe, provider-facing rejection emitted before an invocation is accepted. */
export class BackendAgentToolRequestError extends Error {
  constructor(readonly toolError: SedesToolError) {
    super(toolError.message);
    this.name = "BackendAgentToolRequestError";
  }
}

/** Server-derived attachment identity. Providers and models cannot select it. */
export interface TrustedAgentToolSource {
  readonly scope: RequestScope;
  readonly sourceThreadId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceEnvironmentId: string;
  readonly backendKind: BackendKind;
}

/**
 * The adapter behind each backend's Native tool surface: Pi installs SDK
 * tools in process, while Codex and Claude load the stdio `sedes mcp` server.
 * Grok has no Native surface. Admission uses this so one backend's native
 * mechanism can never satisfy another backend's Native presentation.
 */
export function nativeAgentToolAdapter(
  backendKind: BackendKind,
): Extract<AgentToolAdapter, "pi_sdk" | "mcp"> | undefined {
  switch (backendKind) {
    case "pi":
      return "pi_sdk";
    case "codex_app_server":
    case "claude_agent_sdk":
      return "mcp";
    case "grok_build":
      return undefined;
    default: {
      const unsupported: never = backendKind;
      throw new Error(`agent_tool_native_adapter_missing:${unsupported}`);
    }
  }
}

/** Whether the thread's current presentation admits a calling adapter. */
export function agentToolPresentationPermitsAdapter(
  presentation: AgentToolPresentation,
  backendKind: BackendKind,
  adapter: AgentToolAdapter,
): boolean {
  return presentation.surface === "cli"
    ? adapter === "cli" || adapter === "http"
    : adapter === nativeAgentToolAdapter(backendKind);
}

export interface BackendAgentToolPolicy {
  readonly enabled: boolean;
  readonly presentation: AgentToolPresentation;
  readonly accessBoundary: "thread" | "environment" | "unrestricted";
  readonly enabledToolIds: readonly string[];
}

export interface BackendAgentToolInvocationInput {
  readonly source: TrustedAgentToolSource;
  readonly adapter: AgentToolAdapter;
  readonly request: SedesToolInvocationRequest;
  readonly signal: AbortSignal;
  readonly onInvocationStarted?: (invocationId: string) => void | Promise<void>;
  readonly onProgress?: (progress: SedesToolProgress) => void | Promise<void>;
}

export interface BackendAgentToolFacade {
  eligibleCatalog(
    adapter: AgentToolAdapter,
  ): readonly AgentToolContractArtifact[];
  catalogSummaries(
    source: TrustedAgentToolSource,
    adapter: AgentToolAdapter,
  ): readonly AgentToolCatalogSummary[];
  describeMany(
    source: TrustedAgentToolSource,
    adapter: AgentToolAdapter,
    toolIds: readonly string[],
  ): readonly AgentToolDescription[];
  readPolicy(source: TrustedAgentToolSource): BackendAgentToolPolicy;
  invoke<Output = unknown>(
    input: BackendAgentToolInvocationInput,
  ): Promise<SedesToolInvocationResult<Output>>;
}

/** Stable startup seam for runtimes created before application readers exist. */
export class LateBoundBackendAgentToolFacade implements BackendAgentToolFacade {
  #delegate?: BackendAgentToolFacade;
  #closed = false;

  bind(delegate: BackendAgentToolFacade): void {
    if (this.#closed) throw new Error("agent_tool_facade_closed");
    if (this.#delegate) throw new Error("agent_tool_facade_already_bound");
    this.#delegate = delegate;
  }

  eligibleCatalog(
    adapter: AgentToolAdapter,
  ): readonly AgentToolContractArtifact[] {
    return this.#requireDelegate().eligibleCatalog(adapter);
  }

  catalogSummaries(
    source: TrustedAgentToolSource,
    adapter: AgentToolAdapter,
  ): readonly AgentToolCatalogSummary[] {
    return this.#requireDelegate().catalogSummaries(source, adapter);
  }

  describeMany(
    source: TrustedAgentToolSource,
    adapter: AgentToolAdapter,
    toolIds: readonly string[],
  ): readonly AgentToolDescription[] {
    return this.#requireDelegate().describeMany(source, adapter, toolIds);
  }

  readPolicy(source: TrustedAgentToolSource): BackendAgentToolPolicy {
    return this.#requireDelegate().readPolicy(source);
  }

  invoke<Output = unknown>(
    input: BackendAgentToolInvocationInput,
  ): Promise<SedesToolInvocationResult<Output>> {
    try {
      return this.#requireDelegate().invoke<Output>(input);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  close(): void {
    this.#closed = true;
    this.#delegate = undefined;
  }

  #requireDelegate(): BackendAgentToolFacade {
    if (this.#closed) throw new Error("agent_tool_facade_closed");
    if (!this.#delegate) throw new Error("agent_tool_facade_unavailable");
    return this.#delegate;
  }
}
