import { agentToolsCatalogOperation, agentToolsDescribeOperation, agentToolsInvokeOperation,
  SidecarProtocolDeliveryError } from "../../internal/sidecar-protocol/index.js";
import type { AgentToolCliRequest, AgentToolCliResult } from "../../internal/agent-tool-cli-protocol/index.js";
import { AgentToolCliIngressError } from "./agent-tool-cli-local-ingress.js";
import { SidecarRuntimeAttachment, SidecarUpstreamUnavailableError } from "./sidecar-runtime-attachment.js";
import { openCodeToolInvokeOperation } from "../backends/opencode/opencode-tool-relay-wire.js";
import type { OpenCodeToolInvocationStamp } from "../backends/opencode/opencode-tool-invocation.js";
import { OpenCodeRuntimeError } from "../backends/opencode/opencode-release.js";
import { BackendAgentToolRequestError } from "../agent-tools/adapters/backend-facade.js";

/** Capture host authority before any asynchronous relay work. A recognized but
 * revoked source must fail here, never fall through to the generic tool route. */
export async function relayAgentToolCliRequest(
  peer: SidecarRuntimeAttachment,
  request: AgentToolCliRequest,
  signal: AbortSignal,
  capture: (sourceCapability: string) => OpenCodeToolInvocationStamp | undefined,
): Promise<AgentToolCliResult> {
  let stamp: OpenCodeToolInvocationStamp | undefined;
  try {
    stamp = request.operation.type === "invoke" ? capture(request.sourceCapability) : undefined;
  } catch (error) {
    if (error instanceof BackendAgentToolRequestError) throw new AgentToolCliIngressError(error.toolError);
    if (error instanceof OpenCodeRuntimeError) {
      if (error.code === "configuration_scope_denied" || error.code === "opencode_request_authority_mismatch") {
        throw new AgentToolCliIngressError({ code: "permission_denied", message: "This OpenCode session is not admitted to Sedes tools.", retryable: false });
      }
      if (error.code === "opencode_runtime_unavailable") {
        throw new AgentToolCliIngressError({ code: "unavailable", message: "The OpenCode runtime is currently unavailable.", retryable: true });
      }
    }
    throw error;
  }
  return relayAgentToolRequest(peer, request, signal, stamp);
}

export async function relayAgentToolRequest(
  peer: SidecarRuntimeAttachment,
  request: AgentToolCliRequest,
  signal: AbortSignal,
  stamp?: OpenCodeToolInvocationStamp,
): Promise<AgentToolCliResult> {
  switch (request.operation.type) {
    case "list": {
      let response;
      try {
        response = await peer.call(
          agentToolsCatalogOperation,
          { sourceCapability: request.sourceCapability },
          { signal, deadlineMilliseconds: 30_000 },
        );
      } catch (error) {
        throw mapAgentToolDeliveryError(error, false);
      }
      if (response.outcome === "error") {
        throw new AgentToolCliIngressError(response.error);
      }
      return { type: "list", value: { tools: response.tools } };
    }
    case "describe": {
      let response;
      try {
        response = await peer.call(
          agentToolsDescribeOperation,
          {
            sourceCapability: request.sourceCapability,
            toolIds: request.operation.toolIds,
          },
          { signal, deadlineMilliseconds: 30_000 },
        );
      } catch (error) {
        throw mapAgentToolDeliveryError(error, false);
      }
      if (response.outcome === "error") {
        throw new AgentToolCliIngressError(response.error);
      }
      return { type: "describe", value: { tools: response.tools } };
    }
    case "invoke": {
      let response;
      try {
        const current = peer.currentPeer;
        if (stamp && current) {
          try { current.assertReady(); } catch { throw new SidecarUpstreamUnavailableError(); }
          if (!current.supportsOperation(openCodeToolInvokeOperation)) throw new AgentToolCliIngressError({ code: "unavailable", retryable: false,
            message: "Sedes OpenCode tools require a current main server and execution-host sidecar. Upgrade and reconnect them before retrying." });
        }
        response = stamp ? await peer.call(openCodeToolInvokeOperation, {
          stamp, request: { sourceCapability: request.sourceCapability, ...request.operation.request },
        }, { signal }) : await peer.call(
          agentToolsInvokeOperation,
          {
            sourceCapability: request.sourceCapability,
            ...request.operation.request,
          },
          { signal },
        );
      } catch (error) {
        throw mapAgentToolDeliveryError(error, true);
      }
      if (response.outcome === "error") {
        throw new AgentToolCliIngressError(response.error);
      }
      return { type: "invoke", value: response.result };
    }
  }
}

function mapAgentToolDeliveryError(
  error: unknown,
  invocation: boolean,
): unknown {
  if (error instanceof SidecarUpstreamUnavailableError) {
    return new AgentToolCliIngressError({ code: "unavailable", message: "Upstream Sedes is unavailable.", retryable: true });
  }
  if (!(error instanceof SidecarProtocolDeliveryError)) return error;
  if (invocation && error.delivery === "sent_outcome_unknown") {
    return new AgentToolCliIngressError({
      code: "uncertain_outcome",
      message: "The agent-tool invocation outcome is unknown.",
      retryable: false,
    });
  }
  return new AgentToolCliIngressError({
    code: "unavailable",
    message: "Agent tools are currently unavailable.",
    retryable: true,
  });
}
