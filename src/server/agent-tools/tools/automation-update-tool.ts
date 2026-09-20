import { Type } from "typebox";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import type {
  AgentAutomationDefinition,
  AutomationAgentToolService,
  AutomationUpdateToolInput,
} from "./automation-agent-tool-service.js";
import {
  automationDefinitionToolOutputSchema,
  automationPrecheckToolSchema,
  automationReadWaitCeilings,
  automationScheduleToolSchema,
  automationToolExposure,
  automationToolInputSchema,
  automationToolPresentations,
  optionalAutomationThreadId,
} from "./automation-tool-schemas.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

export const automationUpdateToolId =
  CANONICAL_AGENT_TOOL_MANIFEST["automation.update"].id;

export function createAutomationUpdateToolDefinition(
  service: AutomationAgentToolService,
): AgentToolDefinition<AutomationUpdateToolInput, AgentAutomationDefinition> {
  return {
    ...CANONICAL_AGENT_TOOL_MANIFEST["automation.update"],
    inputSchema: automationToolInputSchema(
      {
        expectedRevision: Type.Integer({
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
        prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
        runMode: Type.Optional(
          Type.String({ maxLength: 11, enum: ["same_thread", "clone"] }),
        ),
        schedule: Type.Optional(automationScheduleToolSchema),
        misfirePolicy: Type.Optional(
          Type.String({ maxLength: 8, enum: ["coalesce", "skip"] }),
        ),
        precheck: Type.Optional(
          Type.Union([automationPrecheckToolSchema, Type.Null()]),
        ),
        threadId: optionalAutomationThreadId,
      },
      { minProperties: 2 },
    ),
    outputSchema: automationDefinitionToolOutputSchema,
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: automationReadWaitCeilings,
      supportsCancellation: false,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 512 * 1_024,
      maximumOutputBytes: 512 * 1_024,
      concurrencyClass: "automation_write",
      uncertainExternalOutcome: true,
    },
    exposure: automationToolExposure,
    adapters: automationToolPresentations({
      piName: "sedes_automation_update",
      label: "Update Sedes automation",
      promptSnippet:
        "Update schedule, pre-check, prompt, or run mode for future automated executions.",
      command: automationUpdateToolId,
    }),
    execute: (input, context) => service.update(input, context),
  };
}
