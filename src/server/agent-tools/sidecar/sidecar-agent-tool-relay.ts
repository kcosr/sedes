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
import { openCodeToolInvokeOperation } from "../../backends/opencode/opencode-tool-relay-wire.js";
import { assertOpenCodeInvocationSource, runWithOpenCodeInvocation } from "../../backends/opencode/opencode-tool-invocation.js";
import type { z } from "zod";

import type { AgentToolRouteBinding } from "../../../internal/sidecar-protocol/agent-tools-v7.js";

export interface SidecarAgentToolRelayAuthority {
  readonly scope: RequestScope;
  readonly executionEnvironmentId: string;
}

/**
 * Registers only main-Sedes-owned reverse operations. The sidecar session
 * supplies tenant, principal, and execution-environment authority; its UDS
 * caller supplies only an opaque restart-safe thread source reference and canonical
 * tool input. The reference also names its presentation, so the generated CLI
 * and the `sedes mcp` server share this relay without a wire discriminator.
 */
export function registerSidecarAgentToolRelayOperations(
  registry: SidecarOperationRegistry,
  input: {
    readonly authority: SidecarAgentToolRelayAuthority;
    readonly sources: EnvironmentScopedAgentToolSourceResolver;
    readonly tools: BackendAgentToolFacade;
    readonly openCodeTools?: boolean;
    readonly retainRoute?: (binding: AgentToolRouteBinding) => {signal: AbortSignal; release(): void};
    readonly authorizeSource?: (backendId: string, binding: AgentToolRouteBinding) => boolean;
  },
): void {
  const scope = Object.freeze({ ...input.authority.scope });
  const executionEnvironmentId = input.authority.executionEnvironmentId;
  if (!scope.tenantId || !scope.principalId || !executionEnvironmentId) {
    throw new Error("sidecar_agent_tool_relay_authority_invalid");
  }

  const resolve = async (sourceCapability: string, signal: AbortSignal, binding?: AgentToolRouteBinding) => {
    const caller = await input.sources.resolveCapabilityInExecutionEnvironment(
      scope,
      executionEnvironmentId,
      sourceCapability,
      signal,
    );
    const assertCurrent = () => {
      if (input.authorizeSource && (!caller.backendInstanceId || !binding || caller.backendInstanceId !== binding.backendInstanceId ||
        !input.authorizeSource(caller.backendInstanceId, binding))) throw new CanonicalAgentToolRequestError("permission_denied", "The execution host tool route has changed.");
    };
    assertCurrent();
    return {
      assertCurrent,
      source: caller.source,
      adapter: caller.presentation === "mcp" ? ("mcp" as const) : ("cli" as const),
      ...(caller.accessDecisionAuthority ? { accessDecisionAuthority: caller.accessDecisionAuthority } : {}),
    };
  };

  registry.register(
    agentToolsCatalogOperation,
    async ({ sourceCapability, routeBinding }, { signal }) => {
      try {
        const { source, adapter, assertCurrent } = await resolve(sourceCapability, signal, routeBinding);
        assertCurrent();
        assertOpen(signal);
        return {
          outcome: "ok" as const,
          tools: [...input.tools.catalogSummaries(source, adapter)],
        };
      } catch (error) {
        return relayError(error);
      }
    },
  );

  registry.register(
    agentToolsDescribeOperation,
    async ({ sourceCapability, routeBinding, toolIds }, { signal }) => {
      try {
        const { source, adapter, assertCurrent } = await resolve(sourceCapability, signal, routeBinding);
        assertCurrent();
        assertOpen(signal);
        return {
          outcome: "ok" as const,
          tools: [...input.tools.describeMany(source, adapter, toolIds)],
        };
      } catch (error) {
        return relayError(error);
      }
    },
  );

  const invoke = async (
    { sourceCapability, routeBinding, toolId, schemaVersion, requestId, input: toolInput }: z.infer<typeof agentToolsInvokeOperation.requestSchema>,
    signal: AbortSignal,
    validateSource?: (source: Awaited<ReturnType<typeof resolve>>["source"]) => void,
  ) => {
      let route: {signal: AbortSignal; release(): void} | undefined;
      try {
        const { source, adapter, accessDecisionAuthority, assertCurrent } = await resolve(sourceCapability, signal, routeBinding);
        assertCurrent();
        validateSource?.(source);
        route = routeBinding && input.retainRoute?.(routeBinding);
        const invocationSignal = route ? AbortSignal.any([signal, route.signal]) : signal;
        assertOpen(invocationSignal);
        return {
          outcome: "ok" as const,
          result: await input.tools.invoke({
            source,
            adapter,
            request: {
              toolId,
              schemaVersion,
              requestId,
              input: toolInput,
            },
            signal: invocationSignal,
            ...(accessDecisionAuthority ? { accessDecisionAuthority } : {}),
          }),
        };
      } catch (error) {
        return relayError(error);
      } finally {
        route?.release();
      }
  };
  registry.register(agentToolsInvokeOperation, (request, { signal }) => invoke(request, signal, source => {
    if (source.backendKind === "opencode") throw new BackendAgentToolRequestError({ code: "permission_denied", retryable: false,
      message: "This tool request has no valid OpenCode invocation authority." });
  }));
  if (input.openCodeTools) registry.register(openCodeToolInvokeOperation, ({ stamp, request }, { signal }) =>
    runWithOpenCodeInvocation(stamp, () => invoke(request, signal, source => assertOpenCodeInvocationSource(stamp, source))));
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
