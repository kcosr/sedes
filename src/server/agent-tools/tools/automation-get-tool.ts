import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import type {
  AgentAutomationDefinition,
  AutomationAgentToolService,
  AutomationTargetInput,
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

export const automationGetToolId =
  CANONICAL_AGENT_TOOL_MANIFEST["automation.get"].id;

export function createAutomationGetToolDefinition(
  service: AutomationAgentToolService,
): AgentToolDefinition<AutomationTargetInput, AgentAutomationDefinition> {
  return {
    ...CANONICAL_AGENT_TOOL_MANIFEST["automation.get"],
    inputSchema: automationToolInputSchema({
      threadId: optionalAutomationThreadId,
    }),
    outputSchema: automationDefinitionToolOutputSchema,
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: automationReadWaitCeilings,
      supportsCancellation: true,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 1_024,
      maximumOutputBytes: 512 * 1_024,
      concurrencyClass: "automation_read",
      uncertainExternalOutcome: false,
    },
    exposure: automationToolExposure,
    adapters: automationToolPresentations({
      piName: "sedes_automation_get",
      label: "Get Sedes automation",
      promptSnippet: "Read an automation and its upcoming schedule.",
      command: automationGetToolId,
    }),
    execute: (input, context) => service.get(input, context),
  };
}
