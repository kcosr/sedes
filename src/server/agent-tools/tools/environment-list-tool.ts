import { Type } from "typebox";
import type { WorkspaceEnvironmentSummary } from "../../application/workspace-application-service.js";
import type { AgentManagementService } from "../application/agent-management-service.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import { identifierSchema, sharedAdapters } from "./management-tool-schemas.js";

const manifest = CANONICAL_AGENT_TOOL_MANIFEST["environment.list"];

export type EnvironmentListInput = Record<string, never>;
export type EnvironmentListOutput = {
  readonly items: readonly WorkspaceEnvironmentSummary[];
};

export function createEnvironmentListToolDefinition(
  service: AgentManagementService,
): AgentToolDefinition<EnvironmentListInput, EnvironmentListOutput> {
  return {
    ...manifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {},
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 0,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          items: Type.Array(
            Type.Object(
              {
                id: identifierSchema,
                label: Type.String({ minLength: 1, maxLength: 240 }),
                availability: Type.String({
                  enum: ["available", "unavailable"],
                  maxLength: 11,
                }),
              },
              { additionalProperties: false, maxProperties: 3 },
            ),
            { maxItems: 16 },
          ),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 1,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: sharedAdapters,
      supportsCancellation: true,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 1_024,
      maximumOutputBytes: 32 * 1_024,
      concurrencyClass: "environment_list_read",
      uncertainExternalOutcome: false,
    },
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_environment_list",
        label: "Sedes environment list",
        promptSnippet: "Discover configured Sedes execution environments.",
      },
      mcp: { name: "sedes_environment_list" },
      http: { invocation: "inline" },
      cli: { command: manifest.id },
    },
    async execute(_input, context) {
      return {
        items: service.listEnvironments({
          tenantId: context.tenantId,
          principalId: context.principalId,
        }),
      };
    },
  };
}
