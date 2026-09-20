import { Type } from "typebox";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import type {
  AgentManagementService,
  AgentWorkspaceListScope,
  AgentWorkspaceSummary,
} from "../application/agent-management-service.js";
import {
  cursorSchema,
  identifierSchema,
  sharedAdapters,
} from "./management-tool-schemas.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

const workspaceListManifest = CANONICAL_AGENT_TOOL_MANIFEST["workspace.list"];

export type WorkspaceListInput = {
  readonly scope?: AgentWorkspaceListScope;
  readonly cursor?: string;
  readonly pageSize?: number;
};
export type WorkspaceListOutput = {
  readonly items: readonly AgentWorkspaceSummary[];
  readonly nextCursor?: string;
};

export function createWorkspaceListToolDefinition(
  service: AgentManagementService,
): AgentToolDefinition<WorkspaceListInput, WorkspaceListOutput> {
  return {
    ...workspaceListManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          scope: Type.Optional(
            Type.Union(
              [
                Type.Object(
                  {
                    kind: Type.String({
                      enum: ["default_environment"],
                      maxLength: 19,
                    }),
                  },
                  { additionalProperties: false, maxProperties: 1 },
                ),
                Type.Object(
                  {
                    kind: Type.String({ enum: ["environment"], maxLength: 11 }),
                    environmentId: identifierSchema,
                  },
                  { additionalProperties: false, maxProperties: 2 },
                ),
                Type.Object(
                  {
                    kind: Type.String({
                      enum: ["all_allowed_environments"],
                      maxLength: 24,
                    }),
                  },
                  { additionalProperties: false, maxProperties: 1 },
                ),
              ],
              {
                description:
                  "Workspace environment scope. Omit for the caller's configured default environment.",
              },
            ),
          ),
          cursor: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 2_048,
              description:
                "Opaque cursor for the next page in fixed last-opened order. Continue with the same pageSize.",
            }),
          ),
          pageSize: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 100,
              description:
                "Maximum workspace summaries to return; defaults to 50.",
            }),
          ),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 3,
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
                lastOpenedAt: Type.String({
                  minLength: 20,
                  maxLength: 40,
                  description:
                    "Last-opened time; results are ordered by this field descending, then id ascending.",
                }),
                environment: Type.Object(
                  {
                    id: identifierSchema,
                    label: Type.String({ minLength: 1, maxLength: 240 }),
                  },
                  {
                    additionalProperties: false,
                    maxProperties: 2,
                    description:
                      "Execution-environment identity and safe display label; no host or transport topology is exposed.",
                  },
                ),
              },
              { additionalProperties: false, maxProperties: 5 },
            ),
            { maxItems: 100 },
          ),
          nextCursor: Type.Optional(cursorSchema),
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
      adapterWaitCeilingMilliseconds: sharedAdapters,
      supportsCancellation: true,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 4_096,
      maximumOutputBytes: 256 * 1_024,
      concurrencyClass: "workspace_list_read",
      uncertainExternalOutcome: false,
    },
    exposure: { adapters: ["pi_sdk", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_workspace_list",
        label: "Sedes workspace list",
        promptSnippet: "Discover available Sedes workspaces.",
      },
      http: { invocation: "inline" },
      cli: { command: workspaceListManifest.id },
    },
    async execute(input, context) {
      return service.listWorkspaces(
        { tenantId: context.tenantId, principalId: context.principalId },
        {
          scope: input.scope ?? { kind: "default_environment" },
          ...(input.cursor ? { cursor: input.cursor } : {}),
          pageSize: input.pageSize ?? 50,
        },
        context.environmentAuthority,
      );
    },
  };
}
