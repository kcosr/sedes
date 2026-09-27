import { agentToolsCatalogOperation, agentToolsDescribeOperation, agentToolsInvokeOperation,
  SidecarProtocolDeliveryError } from "../../internal/sidecar-protocol/index.js";
import type { AgentToolCliRequest, AgentToolCliResult } from "../../internal/agent-tool-cli-protocol/index.js";
import { AgentToolCliIngressError } from "./agent-tool-cli-local-ingress.js";
import { SidecarRuntimeAttachment, SidecarUpstreamUnavailableError } from "./sidecar-runtime-attachment.js";
import { openCodeToolInvokeOperation } from "../backends/opencode/opencode-tool-relay-wire.js";
import type { OpenCodeToolInvocationStamp } from "../backends/opencode/opencode-tool-invocation.js";

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
