import { Type } from "typebox";
import type { OpenedWorkspaceSummary } from "../../application/workspace-application-service.js";
import type { AgentManagementService } from "../application/agent-management-service.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import { identifierSchema, sharedAdapters } from "./management-tool-schemas.js";

const manifest = CANONICAL_AGENT_TOOL_MANIFEST["workspace.open"];

export type WorkspaceOpenInput = {
  readonly environmentId: string;
  readonly path: string;
  readonly projectId?: string;
};
export type WorkspaceOpenOutput = OpenedWorkspaceSummary;

export function createWorkspaceOpenToolDefinition(
  service: AgentManagementService,
): AgentToolDefinition<WorkspaceOpenInput, WorkspaceOpenOutput> {
  return {
    ...manifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          environmentId: identifierSchema,
          path: Type.String({
            minLength: 1,
            maxLength: 4_096,
            description:
              "Absolute path to an existing directory on the selected configured execution environment. A known directory keeps its project.",
          }),
          projectId: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 128,
              description:
                "An existing active project to add a new directory to, or to restore a removed location of that project into. Without it, a new directory becomes a new single-location project named after it, and a removed location is a conflict. Naming a project other than a known directory's own is a conflict.",
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
          workspaceId: identifierSchema,
          environmentId: identifierSchema,
          projectId: identifierSchema,
          label: Type.String({ minLength: 1, maxLength: 240 }),
          availability: Type.String({
            enum: ["available", "unavailable"],
            maxLength: 11,
          }),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 5,
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
      maximumInputBytes: 32 * 1_024,
      maximumOutputBytes: 16 * 1_024,
      concurrencyClass: "workspace_open_write",
      uncertainExternalOutcome: true,
    },
    exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
    adapters: {
      pi: {
        name: "sedes_workspace_open",
        label: "Sedes workspace open",
        promptSnippet:
          "Open an existing directory as a Sedes workspace in a configured execution environment.",
      },
      mcp: { name: "sedes_workspace_open" },
      http: { invocation: "inline" },
      cli: { command: manifest.id },
    },
    execute(input, context) {
      return service.openWorkspaceForAgent(
        { tenantId: context.tenantId, principalId: context.principalId },
        input,
        context.environmentAuthority,
        context.abortSignal,
      );
    },
  };
}
