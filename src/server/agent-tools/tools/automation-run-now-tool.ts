import type { ThreadAutomationRun } from "../../../shared/protocol/automation-presentation.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import type {
  AutomationAgentToolService,
  AutomationTargetInput,
} from "./automation-agent-tool-service.js";
import {
  automationRunToolSchema,
  automationRunWaitCeilings,
  automationToolExposure,
  automationToolInputSchema,
  automationToolPresentations,
  optionalAutomationThreadId,
} from "./automation-tool-schemas.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import { Type } from "typebox";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

export const automationRunNowToolId =
  CANONICAL_AGENT_TOOL_MANIFEST["automation.run_now"].id;

export function createAutomationRunNowToolDefinition(
  service: AutomationAgentToolService,
): AgentToolDefinition<AutomationTargetInput, ThreadAutomationRun> {
  return {
    ...CANONICAL_AGENT_TOOL_MANIFEST["automation.run_now"],
    inputSchema: automationToolInputSchema({
      threadId: optionalAutomationThreadId,
    }),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(automationRunToolSchema.properties, {
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        additionalProperties: false,
        maxProperties: 14,
      }),
    ),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: automationRunWaitCeilings,
      supportsCancellation: false,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 1_024,
      maximumOutputBytes: 32 * 1_024,
      concurrencyClass: "automation_run",
      uncertainExternalOutcome: true,
    },
    exposure: automationToolExposure,
    adapters: automationToolPresentations({
      piName: "sedes_automation_run_now",
      label: "Run Sedes automation now",
      promptSnippet: "Start a new automation run, which starts model work.",
      command: automationRunNowToolId,
    }),
    execute: (input, context) => service.runNow(input, context),
  };
}
