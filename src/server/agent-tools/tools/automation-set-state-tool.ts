import { Type } from "typebox";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import type {
  AgentAutomationDefinition,
  AutomationAgentToolService,
  AutomationSetStateToolInput,
} from "./automation-agent-tool-service.js";
import {
  automationDefinitionToolOutputSchema,
  automationReadWaitCeilings,
  automationToolExposure,
  automationToolInputSchema,
  automationToolPresentations,
  optionalAutomationThreadId,
} from "./automation-tool-schemas.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

export const automationSetStateToolId =
  CANONICAL_AGENT_TOOL_MANIFEST["automation.set_state"].id;

export function createAutomationSetStateToolDefinition(
  service: AutomationAgentToolService,
): AgentToolDefinition<AutomationSetStateToolInput, AgentAutomationDefinition> {
  return {
    ...CANONICAL_AGENT_TOOL_MANIFEST["automation.set_state"],
    inputSchema: automationToolInputSchema({
      expectedRevision: Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
      action: Type.String({ maxLength: 6, enum: ["enable", "pause"] }),
      threadId: optionalAutomationThreadId,
    }),
    outputSchema: automationDefinitionToolOutputSchema,
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: automationReadWaitCeilings,
      supportsCancellation: false,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 2 * 1_024,
      maximumOutputBytes: 512 * 1_024,
      concurrencyClass: "automation_write",
      uncertainExternalOutcome: true,
    },
    exposure: automationToolExposure,
    adapters: automationToolPresentations({
      piName: "sedes_automation_set_state",
      label: "Enable or pause Sedes automation",
      promptSnippet: "Enable (scheduling future model work) or pause an automation.",
      command: automationSetStateToolId,
    }),
    execute: (input, context) => service.setState(input, context),
  };
}
