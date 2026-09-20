import { Type } from "typebox";
import type { ThreadAutomationRun } from "../../../shared/protocol/automation-presentation.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import type {
  AutomationAgentToolService,
  AutomationRunsToolInput,
} from "./automation-agent-tool-service.js";
import {
  automationReadWaitCeilings,
  automationRunToolSchema,
  automationToolExposure,
  automationToolInputSchema,
  automationToolPresentations,
  optionalAutomationThreadId,
} from "./automation-tool-schemas.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

export interface AutomationRunsToolResult {
  readonly items: readonly ThreadAutomationRun[];
  readonly nextCursor: string | null;
}

export const automationRunsToolId =
  CANONICAL_AGENT_TOOL_MANIFEST["automation.runs"].id;

export function createAutomationRunsToolDefinition(
  service: AutomationAgentToolService,
): AgentToolDefinition<AutomationRunsToolInput, AutomationRunsToolResult> {
  return {
    ...CANONICAL_AGENT_TOOL_MANIFEST["automation.runs"],
    inputSchema: automationToolInputSchema({
      threadId: optionalAutomationThreadId,
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
      pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          items: Type.Array(automationRunToolSchema, { maxItems: 100 }),
          nextCursor: Type.Union([
            Type.String({ minLength: 1, maxLength: 2_048 }),
            Type.Null(),
          ]),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 2,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: automationReadWaitCeilings,
      supportsCancellation: true,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 4 * 1_024,
      maximumOutputBytes: 512 * 1_024,
      concurrencyClass: "automation_read",
      uncertainExternalOutcome: false,
    },
    exposure: automationToolExposure,
    adapters: automationToolPresentations({
      piName: "sedes_automation_runs",
      label: "List Sedes automation runs",
      promptSnippet: "Inspect bounded recent automation run history.",
      command: automationRunsToolId,
    }),
    async execute(input, context) {
      return service.listRuns(input, context);
    },
  };
}
