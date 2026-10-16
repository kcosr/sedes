import { Type } from "typebox";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import type {
  AgentAutomationDefinition,
  AutomationAgentToolService,
  AutomationCreateToolInput,
} from "./automation-agent-tool-service.js";
import {
  automationDefinitionToolOutputSchema,
  automationNameToolSchema,
  automationPrecheckToolSchema,
  automationReadWaitCeilings,
  automationScheduleToolSchema,
  automationToolExposure,
  automationToolInputSchema,
  automationToolPresentations,
  optionalAutomationThreadId,
  automationMutationId,
} from "./automation-tool-schemas.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

export const automationCreateToolId =
  CANONICAL_AGENT_TOOL_MANIFEST["automation.create"].id;

export function createAutomationCreateToolDefinition(
  service: AutomationAgentToolService,
): AgentToolDefinition<AutomationCreateToolInput, AgentAutomationDefinition> {
  return {
    ...CANONICAL_AGENT_TOOL_MANIFEST["automation.create"],
    inputSchema: automationToolInputSchema({
      name: automationNameToolSchema,
      initialState: Type.String({ maxLength: 7, enum: ["enabled", "paused"] }),
      mutationId: automationMutationId,
      prompt: Type.String({ minLength: 1, maxLength: 65_536 }),
      runMode: Type.String({ maxLength: 11, enum: ["same_thread", "clone"] }),
      schedule: automationScheduleToolSchema,
      misfirePolicy: Type.Union([
        Type.String({ maxLength: 8, enum: ["coalesce", "skip"] }),
        Type.Null(),
      ]),
      precheck: Type.Optional(
        Type.Union([automationPrecheckToolSchema, Type.Null()]),
      ),
      threadId: optionalAutomationThreadId,
    }),
    outputSchema: automationDefinitionToolOutputSchema,
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: automationReadWaitCeilings,
      supportsCancellation: false,
      idempotency: "required",
      progress: "none",
      maximumInputBytes: 512 * 1_024,
      maximumOutputBytes: 512 * 1_024,
      concurrencyClass: "automation_write",
      uncertainExternalOutcome: true,
    },
    exposure: automationToolExposure,
    adapters: automationToolPresentations({
      piName: "sedes_automation_create",
      label: "Create Sedes automation",
      promptSnippet:
        "Create an independent named automation; enabled state schedules future model work.",
      command: automationCreateToolId,
    }),
    execute: (input, context) => service.create(input, context),
  };
}
