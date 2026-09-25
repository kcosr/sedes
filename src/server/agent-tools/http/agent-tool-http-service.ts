import type { Request } from "express";
import type { BackendKind } from "../../backends/contracts.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  AgentToolCatalogSummary,
  AgentToolDescription,
  SedesToolInvocationResult,
} from "../contracts/agent-tool-contracts.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";
import { BackendAgentToolRequestError } from "../adapters/backend-facade.js";
import type { SourceScopedAgentToolService } from "../application/source-scoped-agent-tool-service.js";
import type { CreateAgentToolInvocationRequest } from "./agent-tool-http-contracts.js";

export interface ResolvedAgentToolSourceContext {
  readonly scope: RequestScope;
  readonly sourceThreadId: string;
  readonly sourceWorkspaceId: string;
  readonly sourceEnvironmentId: string;
  readonly backendKind: BackendKind;
}

/**
 * A thread caller resolved from its opaque reference. The reference, not the
 * request, names the presentation: the CLI and `sedes mcp` share these routes.
 */
export interface ResolvedAgentToolSourceCapabilityContext {
  readonly source: ResolvedAgentToolSourceContext;
  readonly presentation: "cli" | "mcp";
}

/** Resolves only inside the server-derived request scope. */
export interface AgentToolSourceContextResolver {
  resolve(
    request: Request,
    sourceCapability: string,
    signal: AbortSignal,
  ): Promise<ResolvedAgentToolSourceCapabilityContext>;
}

/**
 * Thin HTTP adapter over the same source-scoped admission service used by
 * provider-native tools. HTTP cannot bypass live policy or environment reach.
 */
export class PolicyCheckedAgentToolHttpService {
  constructor(readonly scoped: SourceScopedAgentToolService) {}

  async catalog(
    caller: ResolvedAgentToolSourceCapabilityContext,
  ): Promise<readonly AgentToolCatalogSummary[]> {
    try {
      return this.scoped.catalogSummaries(
        caller.source,
        discoveryAdapter(caller),
      );
    } catch (error) {
      throw mapBackendError(error);
    }
  }

  async describeMany(
    caller: ResolvedAgentToolSourceCapabilityContext,
    toolIds: readonly string[],
  ): Promise<readonly AgentToolDescription[]> {
    try {
      return this.scoped.describeMany(
        caller.source,
        discoveryAdapter(caller),
        toolIds,
      );
    } catch (error) {
      throw mapBackendError(error);
    }
  }

  async invoke(
    caller: ResolvedAgentToolSourceCapabilityContext,
    request: CreateAgentToolInvocationRequest,
    signal: AbortSignal,
  ): Promise<SedesToolInvocationResult<unknown>> {
    try {
      return await this.scoped.invoke({
        source: caller.source,
        adapter: caller.presentation === "mcp" ? "mcp" : "http",
        request,
        signal,
      });
    } catch (error) {
      throw mapBackendError(error);
    }
  }
}

function discoveryAdapter(
  caller: ResolvedAgentToolSourceCapabilityContext,
): "cli" | "mcp" {
  return caller.presentation === "mcp" ? "mcp" : "cli";
}

function mapBackendError(error: unknown): unknown {
  if (!(error instanceof BackendAgentToolRequestError)) return error;
  return new CanonicalAgentToolRequestError(
    error.toolError.code,
    error.toolError.message,
    error.toolError.retryable,
  );
}
