import { Type } from "typebox";
import {
  SAVED_AGENT_CURSOR_MAX_CHARACTERS,
  createSavedAgentRequestSchema,
  deleteSavedAgentRequestSchema,
  savedAgentIdSchema,
  savedAgentListQuerySchema,
  savedAgentOptionsRequestSchema,
  updateSavedAgentRequestSchema,
  type CreateSavedAgentRequest,
  type SavedAgent,
  type SavedAgentBackendTypeId,
  type SavedAgentDeleteResult,
  type SavedAgentListPage,
  type SavedAgentOptionsRequest,
  type SavedAgentOptionsResult,
  type UpdateSavedAgentRequest,
} from "../../../shared/protocol/saved-agents.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { requireAdmittedResource, type TrustedEnvironmentAuthorityGrant } from "../environment/environment-authority.js";
import { AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES } from "../contracts/agent-tool-transport-limits.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import {
  identifierSchema,
  pageSizeSchema,
  sharedAdapters,
} from "./management-tool-schemas.js";
import {
  savedAgentAuthoringContextToolSchema,
  savedAgentBackendTypeIdToolSchema,
  savedAgentDescriptionToolSchema,
  savedAgentSedesToolsToolSchema,
  savedAgentListPageToolSchema,
  savedAgentNameToolSchema,
  savedAgentOptionsResultToolSchema,
  savedAgentOutputToolSchema,
  savedAgentOverridesToolSchema,
} from "./saved-agent-tool-schemas.js";

const listManifest = CANONICAL_AGENT_TOOL_MANIFEST["saved_agent.list"];
const getManifest = CANONICAL_AGENT_TOOL_MANIFEST["saved_agent.get"];
const optionsManifest = CANONICAL_AGENT_TOOL_MANIFEST["saved_agent.options"];
const createManifest = CANONICAL_AGENT_TOOL_MANIFEST["saved_agent.create"];
const updateManifest = CANONICAL_AGENT_TOOL_MANIFEST["saved_agent.update"];
const deleteManifest = CANONICAL_AGENT_TOOL_MANIFEST["saved_agent.delete"];

export type SavedAgentListToolInput = {
  readonly backendTypeId?: string;
  readonly nameSearch?: string;
  readonly cursor?: string;
  readonly pageSize?: number;
};

type SavedAgentListServiceInput = Omit<
  SavedAgentListToolInput,
  "backendTypeId"
> & { readonly backendTypeId?: SavedAgentBackendTypeId };

export type SavedAgentOptionsToolInput = Omit<
  SavedAgentOptionsRequest,
  "workspaceId"
> & { readonly workspaceId?: string };

export type SavedAgentUpdateToolInput = UpdateSavedAgentRequest & {
  readonly agentId: string;
};

export type SavedAgentDeleteToolInput = {
  readonly agentId: string;
  readonly expectedRevision: number;
};

/**
 * Source-scoped application facade shared by all canonical SavedAgent
 * presentations. It derives ownership and authoring backend identity; tools
 * never accept either as authority.
 */
export interface SavedAgentCanonicalToolService {
  list(
    scope: RequestScope,
    input: SavedAgentListServiceInput,
  ): SavedAgentListPage | Promise<SavedAgentListPage>;
  get(scope: RequestScope, agentId: string): SavedAgent | Promise<SavedAgent>;
  optionsForAgentTool(
    scope: RequestScope,
    input: SavedAgentOptionsRequest,
    signal: AbortSignal | undefined,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
  ): Promise<SavedAgentOptionsResult>;
  createAgentForAgentTool(
    scope: RequestScope,
    input: CreateSavedAgentRequest,
    signal: AbortSignal | undefined,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
  ): SavedAgent | Promise<SavedAgent>;
  updateAgentForAgentTool(
    scope: RequestScope,
    agentId: string,
    input: UpdateSavedAgentRequest,
    signal: AbortSignal | undefined,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
  ): SavedAgent | Promise<SavedAgent>;
  deleteAgent(
    scope: RequestScope,
    agentId: string,
    expectedRevision: number,
  ): SavedAgentDeleteResult | Promise<SavedAgentDeleteResult>;
}

const readExecution = (
  concurrencyClass: string,
  inputBytes: number,
  outputBytes: number,
) => ({
  form: "inline" as const,
  adapterWaitCeilingMilliseconds: sharedAdapters,
  supportsCancellation: true,
  idempotency: "not_applicable" as const,
  progress: "none" as const,
  maximumInputBytes: inputBytes,
  maximumOutputBytes: outputBytes,
  concurrencyClass,
  uncertainExternalOutcome: false,
});

const writeExecution = (
  concurrencyClass: string,
  inputBytes: number,
  outputBytes: number,
) => ({
  ...readExecution(concurrencyClass, inputBytes, outputBytes),
  uncertainExternalOutcome: true,
});

const exposure = { adapters: ["pi_sdk", "http", "cli"] } as const;

function scope(context: {
  readonly tenantId: string;
  readonly principalId: string;
}): RequestScope {
  return { tenantId: context.tenantId, principalId: context.principalId };
}

export function createSavedAgentListToolDefinition(
  service: SavedAgentCanonicalToolService,
): AgentToolDefinition<SavedAgentListToolInput, SavedAgentListPage> {
  return {
    ...listManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          backendTypeId: Type.Optional(savedAgentBackendTypeIdToolSchema),
          nameSearch: Type.Optional(savedAgentNameToolSchema),
          cursor: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: SAVED_AGENT_CURSOR_MAX_CHARACTERS,
            }),
          ),
          pageSize: Type.Optional(pageSizeSchema),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 4,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(
      savedAgentListPageToolSchema,
    ),
    requiredCapabilities: [],
    execution: readExecution("saved_agent_list_read", 8 * 1_024, 1_024 * 1_024),
    exposure,
    adapters: {
      pi: {
        name: "sedes_saved_agent_list",
        label: "List Sedes Agents",
        promptSnippet: "Discover reusable Sedes Agent configurations.",
      },
      http: { invocation: "inline" },
      cli: { command: listManifest.id },
    },
    async execute(input, context) {
      const parsed = savedAgentListQuerySchema.parse(input);
      return service.list(scope(context), parsed);
    },
  };
}

export function createSavedAgentGetToolDefinition(
  service: SavedAgentCanonicalToolService,
): AgentToolDefinition<{ readonly agentId: string }, SavedAgent> {
  return {
    ...getManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        { agentId: identifierSchema },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 1,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(savedAgentOutputToolSchema),
    requiredCapabilities: [],
    execution: readExecution("saved_agent_get_read", 2 * 1_024, 256 * 1_024),
    exposure,
    adapters: {
      pi: {
        name: "sedes_saved_agent_get",
        label: "Get Sedes Agent",
        promptSnippet: "Read one complete saved Sedes Agent.",
      },
      http: { invocation: "inline" },
      cli: { command: getManifest.id },
    },
    async execute(input, context) {
      const agent = await service.get(
        scope(context),
        savedAgentIdSchema.parse(input.agentId),
      );
      requireAdmittedResource(context.environmentAuthority, {
        kind: "saved_agent", id: agent.id, revision: agent.revision,
      });
      return agent;
    },
  };
}

export function createSavedAgentOptionsToolDefinition(
  service: SavedAgentCanonicalToolService,
): AgentToolDefinition<SavedAgentOptionsToolInput, SavedAgentOptionsResult> {
  return {
    ...optionsManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          workspaceId: Type.Optional(identifierSchema),
          targetId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 160 }),
          ),
          overrides: Type.Optional(savedAgentOverridesToolSchema),
          sedesTools: Type.Optional(savedAgentSedesToolsToolSchema),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 4,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(
      savedAgentOptionsResultToolSchema,
    ),
    requiredCapabilities: [],
    execution: readExecution(
      "saved_agent_options_read",
      256 * 1_024,
      AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES,
    ),
    exposure,
    adapters: {
      pi: {
        name: "sedes_saved_agent_options",
        label: "Inspect Sedes Agent options",
        promptSnippet:
          "Inspect current target-specific Agent configuration options before writing.",
      },
      http: { invocation: "inline" },
      cli: { command: optionsManifest.id },
    },
    async execute(input, context) {
      const workspaceId = input.workspaceId ?? context.defaults.workspaceId;
      if (!workspaceId) {
        throw new CanonicalAgentToolRequestError(
          "invalid_input",
          "The requested operation requires a configured default workspace.",
        );
      }
      const parsed = savedAgentOptionsRequestSchema.parse({
        ...input,
        workspaceId,
      });
      return service.optionsForAgentTool(
        scope(context),
        parsed,
        context.abortSignal,
        context.environmentAuthority,
      );
    },
  };
}

export function createSavedAgentCreateToolDefinition(
  service: SavedAgentCanonicalToolService,
): AgentToolDefinition<CreateSavedAgentRequest, SavedAgent> {
  return {
    ...createManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          name: savedAgentNameToolSchema,
          description: Type.Optional(savedAgentDescriptionToolSchema),
          authoringContext: savedAgentAuthoringContextToolSchema,
          backendOverrides: savedAgentOverridesToolSchema,
          sedesTools: Type.Optional(savedAgentSedesToolsToolSchema),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 5,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(savedAgentOutputToolSchema),
    requiredCapabilities: [],
    execution: writeExecution(
      "saved_agent_create_write",
      256 * 1_024,
      256 * 1_024,
    ),
    exposure,
    adapters: {
      pi: {
        name: "sedes_saved_agent_create",
        label: "Create Sedes Agent",
        promptSnippet:
          "Create a reusable Sedes Agent from current normalized options.",
      },
      http: { invocation: "inline" },
      cli: { command: createManifest.id },
    },
    async execute(input, context) {
      return service.createAgentForAgentTool(
        scope(context),
        createSavedAgentRequestSchema.parse(input),
        context.abortSignal,
        context.environmentAuthority,
      );
    },
  };
}

export function createSavedAgentUpdateToolDefinition(
  service: SavedAgentCanonicalToolService,
): AgentToolDefinition<SavedAgentUpdateToolInput, SavedAgent> {
  return {
    ...updateManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          agentId: identifierSchema,
          expectedRevision: Type.Integer({
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          }),
          name: Type.Optional(savedAgentNameToolSchema),
          description: Type.Optional(
            Type.Union([savedAgentDescriptionToolSchema, Type.Null()]),
          ),
          authoringContext: Type.Optional(savedAgentAuthoringContextToolSchema),
          backendOverrides: Type.Optional(savedAgentOverridesToolSchema),
          sedesTools: Type.Optional(
            Type.Union([savedAgentSedesToolsToolSchema, Type.Null()]),
          ),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          minProperties: 3,
          maxProperties: 7,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(savedAgentOutputToolSchema),
    requiredCapabilities: [],
    execution: writeExecution(
      "saved_agent_update_write",
      256 * 1_024,
      256 * 1_024,
    ),
    exposure,
    adapters: {
      pi: {
        name: "sedes_saved_agent_update",
        label: "Update Sedes Agent",
        promptSnippet:
          "Revision-check and atomically update a saved Sedes Agent.",
      },
      http: { invocation: "inline" },
      cli: { command: updateManifest.id },
    },
    async execute(input, context) {
      const agentId = savedAgentIdSchema.parse(input.agentId);
      const { agentId: _agentId, ...request } = input;
      return service.updateAgentForAgentTool(
        scope(context),
        agentId,
        updateSavedAgentRequestSchema.parse(request),
        context.abortSignal,
        context.environmentAuthority,
      );
    },
  };
}

export function createSavedAgentDeleteToolDefinition(
  service: SavedAgentCanonicalToolService,
): AgentToolDefinition<SavedAgentDeleteToolInput, SavedAgentDeleteResult> {
  return {
    ...deleteManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          agentId: identifierSchema,
          expectedRevision: Type.Integer({
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          }),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 2,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        { deleted: Type.Boolean(), agentId: identifierSchema },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 2,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: writeExecution("saved_agent_delete_write", 2 * 1_024, 2 * 1_024),
    exposure,
    adapters: {
      pi: {
        name: "sedes_saved_agent_delete",
        label: "Delete Sedes Agent",
        promptSnippet:
          "Revision-check and delete only the reusable Sedes Agent preset.",
      },
      http: { invocation: "inline" },
      cli: { command: deleteManifest.id },
    },
    async execute(input, context) {
      const parsed = deleteSavedAgentRequestSchema.parse({
        expectedRevision: input.expectedRevision,
      });
      return service.deleteAgent(
        scope(context),
        savedAgentIdSchema.parse(input.agentId),
        parsed.expectedRevision,
      );
    },
  };
}
