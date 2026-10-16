import { Type } from "typebox";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import type {
  AutomationAgentToolService,
  AutomationListToolInput,
  AutomationDeleteToolInput,
} from "./automation-agent-tool-service.js";
import {
  automationListItemToolSchema,
  automationReadWaitCeilings,
  automationToolExposure,
  automationToolInputSchema,
  automationToolPresentations,
  optionalAutomationThreadId,
  requiredAutomationId,
} from "./automation-tool-schemas.js";
import {
  normalizeCanonicalAgentToolSchema,
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
} from "../schema/canonical-json-schema.js";

const cursor = Type.Union([
  Type.String({ minLength: 1, maxLength: 2048 }),
  Type.Null(),
]);
function policy(write: boolean, output = 512 * 1024) {
  return {
    form: "inline" as const,
    adapterWaitCeilingMilliseconds: automationReadWaitCeilings,
    supportsCancellation: !write,
    idempotency: "not_applicable" as const,
    progress: "none" as const,
    maximumInputBytes: 4096,
    maximumOutputBytes: output,
    concurrencyClass: write ? "automation_write" : "automation_read",
    uncertainExternalOutcome: write,
  };
}
function presentation(id: string, label: string) {
  return automationToolPresentations({
    piName: `sedes_${id.replaceAll(".", "_")}`,
    label,
    promptSnippet: label,
    command: id,
  });
}
export function createAutomationListToolDefinition(
  service: AutomationAgentToolService,
): AgentToolDefinition<
  AutomationListToolInput,
  ReturnType<AutomationAgentToolService["list"]>
> {
  return {
    ...CANONICAL_AGENT_TOOL_MANIFEST["automation.list"],
    inputSchema: automationToolInputSchema({
      threadId: optionalAutomationThreadId,
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
      pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      status: Type.Optional(
        Type.String({ maxLength: 9, enum: ["enabled", "paused", "exhausted"] }),
      ),
    }),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          items: Type.Array(automationListItemToolSchema, { maxItems: 100 }),
          nextCursor: cursor,
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 2,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: policy(false, 2 * 1024 * 1024),
    exposure: automationToolExposure,
    adapters: presentation("automation.list", "List Sedes automations"),
    execute: async (input, context) => service.list(input, context),
  };
}
export function createAutomationDeleteToolDefinition(
  service: AutomationAgentToolService,
): AgentToolDefinition<
  AutomationDeleteToolInput,
  ReturnType<AutomationAgentToolService["delete"]>
> {
  return {
    ...CANONICAL_AGENT_TOOL_MANIFEST["automation.delete"],
    inputSchema: automationToolInputSchema({
      automationId: requiredAutomationId,
      expectedRevision: Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
    }),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        { deleted: Type.Boolean() },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 1,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: policy(true),
    exposure: automationToolExposure,
    adapters: presentation("automation.delete", "Delete Sedes automation"),
    execute: async (input, context) => service.delete(input, context),
  };
}
