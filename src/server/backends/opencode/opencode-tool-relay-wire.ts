import { z } from "zod";
import { agentToolsInvokeOperation } from "../../../internal/sidecar-protocol/agent-tools-v3.js";
import { defineSidecarOperation } from "../../../internal/sidecar-protocol/operation-registry.js";
import { openCodeToolInvocationStampSchema } from "./opencode-tool-invocation.js";

/** Private native provenance travels beside canonical tool input, never in it. */
export const openCodeToolInvokeOperation = defineSidecarOperation({
  capabilityId: "opencode_tools",
  majorVersion: 1,
  operation: "tools.invoke",
  lane: "operation",
  maximumDeadlineMilliseconds: "caller_abort",
  requestSchema: z.strictObject({ stamp: openCodeToolInvocationStampSchema, request: agentToolsInvokeOperation.requestSchema }),
  responseSchema: agentToolsInvokeOperation.responseSchema,
});
