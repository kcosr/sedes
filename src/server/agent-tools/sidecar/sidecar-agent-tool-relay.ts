import {
  agentToolsCatalogOperation,
  agentToolsDescribeOperation,
  agentToolsInvokeOperation,
  type SidecarOperationRegistry,
} from "../../../internal/sidecar-protocol/index.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  BackendAgentToolRequestError,
  type BackendAgentToolFacade,
} from "../adapters/backend-facade.js";
import type { SedesToolError } from "../contracts/agent-tool-contracts.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";
import type { EnvironmentScopedAgentToolSourceResolver } from "../application/database-agent-tool-source-authority.js";

export interface SidecarAgentToolRelayAuthority {
  readonly scope: RequestScope;
  readonly executionEnvironmentId: string;
}

/**
 * Registers only main-Sedes-owned reverse operations. The sidecar session
 * supplies tenant, principal, and execution-environment authority; its UDS
 * caller supplies only an opaque restart-safe thread source reference and canonical
 * tool input.
 */
export function registerSidecarAgentToolRelayOperations(
  registry: SidecarOperationRegistry,
  input: {
    readonly authority: SidecarAgentToolRelayAuthority;
    readonly sources: EnvironmentScopedAgentToolSourceResolver;
    readonly tools: BackendAgentToolFacade;
  },
): void {
  const scope = Object.freeze({ ...input.authority.scope });
  const executionEnvironmentId = input.authority.executionEnvironmentId;
  if (!scope.tenantId || !scope.principalId || !executionEnvironmentId) {
    throw new Error("sidecar_agent_tool_relay_authority_invalid");
  }

  const resolve = (sourceCapability: string, signal: AbortSignal) =>
    input.sources.resolveCapabilityInExecutionEnvironment(
      scope,
      executionEnvironmentId,
      sourceCapability,
      signal,
    );

  registry.register(
    agentToolsCatalogOperation,
    async ({ sourceCapability }, { signal }) => {
      try {
        const source = await resolve(sourceCapability, signal);
        assertOpen(signal);
        return {
          outcome: "ok" as const,
          tools: [...input.tools.catalogSummaries(source, "cli")],
        };
      } catch (error) {
        return relayError(error);
      }
    },
  );

  registry.register(
    agentToolsDescribeOperation,
    async ({ sourceCapability, toolIds }, { signal }) => {
      try {
        const source = await resolve(sourceCapability, signal);
        assertOpen(signal);
        return {
          outcome: "ok" as const,
          tools: [...input.tools.describeMany(source, "cli", toolIds)],
        };
      } catch (error) {
        return relayError(error);
      }
    },
  );

  registry.register(
    agentToolsInvokeOperation,
    async (
      { sourceCapability, toolId, schemaVersion, requestId, input: toolInput },
      { signal },
    ) => {
      try {
        const source = await resolve(sourceCapability, signal);
        assertOpen(signal);
        return {
          outcome: "ok" as const,
          result: await input.tools.invoke({
            source,
            adapter: "cli",
            request: {
              toolId,
              schemaVersion,
              requestId,
              input: toolInput,
            },
            signal,
          }),
        };
      } catch (error) {
        return relayError(error);
      }
    },
  );
}

function assertOpen(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CanonicalAgentToolRequestError(
      "cancelled",
      "The agent-tool request was cancelled.",
    );
  }
}

function relayError(error: unknown): {
  readonly outcome: "error";
  readonly error: SedesToolError;
} {
  if (error instanceof BackendAgentToolRequestError) {
    return Object.freeze({
      outcome: "error",
      error: Object.freeze({ ...error.toolError }),
    });
  }
  if (error instanceof CanonicalAgentToolRequestError) {
    return Object.freeze({
      outcome: "error",
      error: Object.freeze({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      }),
    });
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return Object.freeze({
      outcome: "error",
      error: Object.freeze({
        code: "cancelled",
        message: "The agent-tool request was cancelled.",
        retryable: false,
      }),
    });
  }
  if (
    error instanceof Error &&
    (error.message === "agent_tool_facade_unavailable" ||
      error.message === "agent_tool_facade_closed")
  ) {
    return Object.freeze({
      outcome: "error",
      error: Object.freeze({
        code: "unavailable",
        message: "Agent tools are currently unavailable.",
        retryable: true,
      }),
    });
  }
  return Object.freeze({
    outcome: "error",
    error: Object.freeze({
      code: "internal_error",
      message: "The agent-tool request failed.",
      retryable: false,
    }),
  });
}
