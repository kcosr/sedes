import { Type } from "typebox";
import {
  SAVED_AGENT_CURSOR_MAX_CHARACTERS,
  SAVED_AGENT_DESCRIPTION_MAX_CHARACTERS,
  SAVED_AGENT_SEDES_TOOLS_MAX_COUNT,
  SAVED_AGENT_NAME_MAX_CHARACTERS,
  SAVED_AGENT_OVERRIDE_ID_MAX_CHARACTERS,
  SAVED_AGENT_OVERRIDE_MAX_COUNT,
  SAVED_AGENT_OVERRIDE_VALUE_MAX_CHARACTERS,
  SAVED_AGENT_PAGE_MAX_ITEMS,
} from "../../../shared/protocol/saved-agents.js";
import { PAYLOAD_LIMITS } from "../../../shared/protocol/payload.js";
import { identifierSchema, isoDateSchema } from "./management-tool-schemas.js";
import { AGENT_TOOL_JSON_SCHEMA_DIALECT } from "../schema/canonical-json-schema.js";

export const savedAgentBackendTypeIdToolSchema = Type.String({
  minLength: 1,
  maxLength: 128,
});

export const savedAgentNameToolSchema = Type.String({
  minLength: 1,
  maxLength: SAVED_AGENT_NAME_MAX_CHARACTERS,
});

export const savedAgentDescriptionToolSchema = Type.String({
  maxLength: SAVED_AGENT_DESCRIPTION_MAX_CHARACTERS,
});

export const savedAgentOverrideToolSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      maxLength: SAVED_AGENT_OVERRIDE_ID_MAX_CHARACTERS,
    }),
    value: Type.String({
      minLength: 1,
      maxLength: SAVED_AGENT_OVERRIDE_VALUE_MAX_CHARACTERS,
    }),
  },
  { additionalProperties: false, maxProperties: 2 },
);

export const savedAgentOverridesToolSchema = Type.Array(
  savedAgentOverrideToolSchema,
  { maxItems: SAVED_AGENT_OVERRIDE_MAX_COUNT },
);

export const agentToolAccessBoundaryToolSchema = Type.String({
  enum: ["thread", "environment", "unrestricted"],
  maxLength: 12,
});

const agentToolPresentationToolSchema = Type.Object(
  {
    surface: Type.String({ enum: ["native", "cli"], maxLength: 6 }),
    mode: Type.String({
      enum: ["progressive", "individual"],
      maxLength: 11,
    }),
  },
  { additionalProperties: false, maxProperties: 2 },
);

const agentToolPresentationOptionToolSchema = Type.Object(
  {
    surface: Type.String({ enum: ["native", "cli"], maxLength: 6 }),
    modes: Type.Array(
      Type.String({
        enum: ["progressive", "individual"],
        maxLength: 11,
      }),
      { minItems: 1, maxItems: 2, uniqueItems: true },
    ),
  },
  { additionalProperties: false, maxProperties: 2 },
);

export const savedAgentSedesToolsToolSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    enabledToolIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: SAVED_AGENT_SEDES_TOOLS_MAX_COUNT,
      uniqueItems: true,
    }),
    presentation: agentToolPresentationToolSchema,
    accessBoundary: agentToolAccessBoundaryToolSchema,
  },
  { additionalProperties: false, maxProperties: 4 },
);

export const savedAgentAuthoringContextToolSchema = Type.Object(
  {
    workspaceId: identifierSchema,
    targetId: Type.String({ minLength: 1, maxLength: 160 }),
  },
  { additionalProperties: false, maxProperties: 2 },
);

const truncationToolSchema = Type.Object(
  {
    truncated: Type.Boolean(),
    originalBytes: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    retainedBytes: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    reason: Type.String({
      enum: ["byte_limit", "depth_limit", "entry_limit", "binary_omitted"],
      maxLength: 14,
    }),
  },
  { additionalProperties: false, maxProperties: 4 },
);

export const savedAgentDisplayTextToolSchema = Type.Object(
  {
    text: Type.String({ maxLength: PAYLOAD_LIMITS.displayTextCharacters }),
    truncation: Type.Optional(truncationToolSchema),
  },
  { additionalProperties: false, maxProperties: 2 },
);

export const savedAgentBackendPresentationToolSchema = Type.Object(
  {
    typeId: savedAgentBackendTypeIdToolSchema,
    label: savedAgentDisplayTextToolSchema,
    brand: Type.String({
      enum: ["pi", "codex", "claude", "grok"],
      maxLength: 6,
    }),
  },
  { additionalProperties: false, maxProperties: 3 },
);

export const savedAgentOutputToolSchema = Type.Object(
  {
    id: identifierSchema,
    name: savedAgentNameToolSchema,
    description: Type.Optional(savedAgentDescriptionToolSchema),
    backendTypeId: savedAgentBackendTypeIdToolSchema,
    backend: savedAgentBackendPresentationToolSchema,
    backendOverrides: savedAgentOverridesToolSchema,
    sedesTools: Type.Optional(savedAgentSedesToolsToolSchema),
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  },
  {
    $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
    additionalProperties: false,
    maxProperties: 10,
  },
);

export const savedAgentSummaryToolSchema = Type.Object(
  {
    id: identifierSchema,
    name: savedAgentNameToolSchema,
    descriptionExcerpt: Type.Optional(Type.String({ maxLength: 240 })),
    backendTypeId: savedAgentBackendTypeIdToolSchema,
    backend: savedAgentBackendPresentationToolSchema,
    overrideCount: Type.Integer({
      minimum: 0,
      maximum: SAVED_AGENT_OVERRIDE_MAX_COUNT,
    }),
    sedesTools: Type.Union([
      Type.Object(
        {
          enabled: Type.Boolean(),
          selectedToolCount: Type.Integer({
            minimum: 0,
            maximum: SAVED_AGENT_SEDES_TOOLS_MAX_COUNT,
          }),
          presentation: agentToolPresentationToolSchema,
          accessBoundary: agentToolAccessBoundaryToolSchema,
        },
        { additionalProperties: false, maxProperties: 4 },
      ),
      Type.Null(),
    ]),
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  },
  { additionalProperties: false, maxProperties: 10 },
);

export const savedAgentListPageToolSchema = Type.Object(
  {
    items: Type.Array(savedAgentSummaryToolSchema, {
      maxItems: SAVED_AGENT_PAGE_MAX_ITEMS,
    }),
    nextCursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: SAVED_AGENT_CURSOR_MAX_CHARACTERS,
      }),
    ),
  },
  {
    $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
    additionalProperties: false,
    maxProperties: 2,
  },
);

export const savedAgentConfigurationDescriptorToolSchema = Type.Object(
  {
    backendTypeId: savedAgentBackendTypeIdToolSchema,
    fields: Type.Array(
      Type.Object(
        {
          id: Type.String({
            minLength: 1,
            maxLength: SAVED_AGENT_OVERRIDE_ID_MAX_CHARACTERS,
          }),
          label: savedAgentDisplayTextToolSchema,
          description: Type.Optional(savedAgentDisplayTextToolSchema),
          options: Type.Array(
            Type.Object(
              {
                value: Type.String({
                  minLength: 1,
                  maxLength: SAVED_AGENT_OVERRIDE_VALUE_MAX_CHARACTERS,
                }),
                label: savedAgentDisplayTextToolSchema,
                available: Type.Boolean(),
                unavailableReason: Type.Optional(
                  savedAgentDisplayTextToolSchema,
                ),
              },
              { additionalProperties: false, maxProperties: 4 },
            ),
            { maxItems: 512 },
          ),
          currentDefaultValue: Type.Union([
            Type.String({
              minLength: 1,
              maxLength: SAVED_AGENT_OVERRIDE_VALUE_MAX_CHARACTERS,
            }),
            Type.Null(),
          ]),
          resolvedValue: Type.Union([
            Type.String({
              minLength: 1,
              maxLength: SAVED_AGENT_OVERRIDE_VALUE_MAX_CHARACTERS,
            }),
            Type.Null(),
          ]),
        },
        { additionalProperties: false, maxProperties: 6 },
      ),
      { maxItems: SAVED_AGENT_OVERRIDE_MAX_COUNT },
    ),
    canonicalOverrides: savedAgentOverridesToolSchema,
  },
  { additionalProperties: false, maxProperties: 3 },
);

export const savedAgentTargetDescriptorToolSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 160 }),
    label: savedAgentDisplayTextToolSchema,
    backend: savedAgentBackendPresentationToolSchema,
  },
  { additionalProperties: false, maxProperties: 3 },
);

const resolvedSedesToolPolicySchema = Type.Object(
  {
    enabled: Type.Boolean(),
    enabledToolIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: SAVED_AGENT_SEDES_TOOLS_MAX_COUNT,
      uniqueItems: true,
    }),
    presentation: agentToolPresentationToolSchema,
    accessBoundary: agentToolAccessBoundaryToolSchema,
  },
  { additionalProperties: false, maxProperties: 4 },
);

const agentToolEffectsToolSchema = Type.Object(
  {
    application: Type.String({
      enum: ["read", "write", "destructive"],
      maxLength: 11,
    }),
    modelUsage: Type.String({
      enum: ["none", "agent_execution"],
      maxLength: 15,
    }),
    external: Type.String({
      enum: ["none", "durable_side_effect"],
      maxLength: 19,
    }),
  },
  { additionalProperties: false, maxProperties: 3 },
);

const agentToolGroupToolSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    label: savedAgentDisplayTextToolSchema,
    description: savedAgentDisplayTextToolSchema,
    order: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    tools: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 128 }),
          label: savedAgentDisplayTextToolSchema,
          description: Type.Optional(savedAgentDisplayTextToolSchema),
          order: Type.Integer({
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          }),
          effects: agentToolEffectsToolSchema,
          enabled: Type.Boolean(),
        },
        { additionalProperties: false, maxProperties: 6 },
      ),
      { minItems: 1, maxItems: 512 },
    ),
  },
  { additionalProperties: false, maxProperties: 5 },
);

export const savedAgentSedesToolDescriptorToolSchema = Type.Object(
  {
    defaultPolicy: resolvedSedesToolPolicySchema,
    resolvedPolicy: resolvedSedesToolPolicySchema,
    groups: Type.Array(agentToolGroupToolSchema, { maxItems: 64 }),
    presentationOptions: Type.Array(agentToolPresentationOptionToolSchema, {
      minItems: 1,
      maxItems: 2,
    }),
  },
  { additionalProperties: false, maxProperties: 4 },
);

export const savedAgentOptionsResultToolSchema = Type.Object(
  {
    kind: Type.String({ enum: ["targets", "configuration"], maxLength: 13 }),
    targets: Type.Optional(
      Type.Array(savedAgentTargetDescriptorToolSchema, { maxItems: 256 }),
    ),
    target: Type.Optional(savedAgentTargetDescriptorToolSchema),
    configuration: Type.Optional(savedAgentConfigurationDescriptorToolSchema),
    sedesTools: Type.Optional(savedAgentSedesToolDescriptorToolSchema),
  },
  {
    $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
    additionalProperties: false,
    maxProperties: 5,
  },
);
