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

/** Resolves only inside the server-derived request scope. */
export interface AgentToolSourceContextResolver {
  resolve(
    request: Request,
    sourceCapability: string,
    signal: AbortSignal,
  ): Promise<ResolvedAgentToolSourceContext>;
}

/**
 * Thin HTTP adapter over the same source-scoped admission service used by
 * provider-native tools. HTTP cannot bypass live policy or environment reach.
 */
export class PolicyCheckedAgentToolHttpService {
  constructor(readonly scoped: SourceScopedAgentToolService) {}

  async catalog(
    source: ResolvedAgentToolSourceContext,
  ): Promise<readonly AgentToolCatalogSummary[]> {
    try {
      return this.scoped.catalogSummaries(source, "cli");
    } catch (error) {
      throw mapBackendError(error);
    }
  }

  async describeMany(
    source: ResolvedAgentToolSourceContext,
    toolIds: readonly string[],
  ): Promise<readonly AgentToolDescription[]> {
    try {
      return this.scoped.describeMany(source, "cli", toolIds);
    } catch (error) {
      throw mapBackendError(error);
    }
  }

  async invoke(
    source: ResolvedAgentToolSourceContext,
    request: CreateAgentToolInvocationRequest,
    signal: AbortSignal,
  ): Promise<SedesToolInvocationResult<unknown>> {
    try {
      return await this.scoped.invoke({
        source,
        adapter: "http",
        request,
        signal,
      });
    } catch (error) {
      throw mapBackendError(error);
    }
  }
}

function mapBackendError(error: unknown): unknown {
  if (!(error instanceof BackendAgentToolRequestError)) return error;
  return new CanonicalAgentToolRequestError(
    error.toolError.code,
    error.toolError.message,
    error.toolError.retryable,
  );
}
