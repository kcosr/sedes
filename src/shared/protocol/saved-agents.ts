import { environmentVariableOverridesSchema } from "./environment-variables.js";
import { z } from "zod";
import {
  agentToolAccessBoundarySchema,
  agentToolIdSchema,
  agentToolPresentationSchema,
  agentToolPresentationOptionsSchema,
  backendBrandSchema,
  normalizedThreadAgentToolGroupSchema,
} from "./conversation.js";
import { workspaceIdSchema } from "./domain.js";
import {
  boundedDisplayTextSchema,
  MAXIMUM_BROWSER_ENTITY_BYTES,
  requireSerializedByteLimit,
} from "./payload.js";

export const SAVED_AGENT_NAME_MAX_CHARACTERS = 160;
export const SAVED_AGENT_DESCRIPTION_MAX_CHARACTERS = 4_096;
export const SAVED_AGENT_OVERRIDE_MAX_COUNT = 32;
export const SAVED_AGENT_OVERRIDE_ID_MAX_CHARACTERS = 128;
export const SAVED_AGENT_OVERRIDE_VALUE_MAX_CHARACTERS = 240;
export const SAVED_AGENT_OVERRIDES_MAX_BYTES = 32 * 1_024;
export const SAVED_AGENT_SEDES_TOOLS_MAX_COUNT = 512;
export const SAVED_AGENT_SEDES_TOOLS_MAX_BYTES = 128 * 1_024;
export const SAVED_AGENT_PAGE_MAX_ITEMS = 100;
export const SAVED_AGENT_CURSOR_MAX_CHARACTERS = 2_048;

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const wellFormedTextSchema = z.string().refine(hasWellFormedUtf16, {
  message: "Saved Agent text must contain well-formed UTF-16.",
});

/**
 * Opaque normalized type contributed by one compiled backend adapter. The
 * registry, rather than browser input, closes the set available in a build.
 */
export const savedAgentBackendTypeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/);
export type SavedAgentBackendTypeId = z.infer<
  typeof savedAgentBackendTypeIdSchema
>;

export const savedAgentBackendPresentationSchema = z.strictObject({
  typeId: savedAgentBackendTypeIdSchema,
  label: boundedDisplayTextSchema,
  brand: backendBrandSchema,
});
export type SavedAgentBackendPresentation = z.infer<
  typeof savedAgentBackendPresentationSchema
>;

export const savedAgentIdSchema = z.uuid();
export const savedAgentNameSchema = wellFormedTextSchema
  .trim()
  .min(1)
  .max(SAVED_AGENT_NAME_MAX_CHARACTERS);
export const savedAgentDescriptionSchema = wellFormedTextSchema.max(
  SAVED_AGENT_DESCRIPTION_MAX_CHARACTERS,
);

export const agentConfigurationOverrideSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(SAVED_AGENT_OVERRIDE_ID_MAX_CHARACTERS)
    .regex(/^[a-z][a-z0-9_.-]*$/),
  value: wellFormedTextSchema
    .min(1)
    .max(SAVED_AGENT_OVERRIDE_VALUE_MAX_CHARACTERS),
});
export type AgentConfigurationOverride = z.infer<
  typeof agentConfigurationOverrideSchema
>;

export const normalizedAgentConfigurationOverridesSchema = z
  .array(agentConfigurationOverrideSchema)
  .max(SAVED_AGENT_OVERRIDE_MAX_COUNT)
  .superRefine((overrides, context) => {
    const ids = new Set<string>();
    for (const [index, override] of overrides.entries()) {
      if (ids.has(override.id)) {
        context.addIssue({
          code: "custom",
          message: "Saved Agent override IDs must be unique.",
          path: [index, "id"],
        });
      }
      ids.add(override.id);
    }
    requireSerializedByteLimit(
      overrides,
      context,
      SAVED_AGENT_OVERRIDES_MAX_BYTES,
      "Saved Agent overrides exceed the serialized byte limit.",
    );
  });
export type NormalizedAgentConfigurationOverrides = z.infer<
  typeof normalizedAgentConfigurationOverridesSchema
>;

export const agentToolBootstrapPolicySchema = z
  .strictObject({
    enabled: z.boolean(),
    enabledToolIds: z
      .array(agentToolIdSchema)
      .max(SAVED_AGENT_SEDES_TOOLS_MAX_COUNT),
    presentation: agentToolPresentationSchema,
    accessBoundary: agentToolAccessBoundarySchema,
  })
  .superRefine((policy, context) => {
    if (new Set(policy.enabledToolIds).size !== policy.enabledToolIds.length) {
      context.addIssue({
        code: "custom",
        message: "Saved Agent Sedes tool IDs must be unique.",
        path: ["enabledToolIds"],
      });
    }
    requireSerializedByteLimit(
      policy,
      context,
      SAVED_AGENT_SEDES_TOOLS_MAX_BYTES,
      "Saved Agent Sedes tool policy exceeds the serialized byte limit.",
    );
  });
export type AgentToolBootstrapPolicy = z.infer<
  typeof agentToolBootstrapPolicySchema
>;

export const savedAgentSchema = z.strictObject({
  environmentVariables: environmentVariableOverridesSchema.optional(),
  id: savedAgentIdSchema,
  name: savedAgentNameSchema,
  description: savedAgentDescriptionSchema.optional(),
  backendTypeId: savedAgentBackendTypeIdSchema,
  backend: savedAgentBackendPresentationSchema,
  backendOverrides: normalizedAgentConfigurationOverridesSchema,
  sedesTools: agentToolBootstrapPolicySchema.optional(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SavedAgent = z.infer<typeof savedAgentSchema>;

export const savedAgentSummarySchema = z.strictObject({
  id: savedAgentIdSchema,
  name: savedAgentNameSchema,
  descriptionExcerpt: wellFormedTextSchema.max(240).optional(),
  backendTypeId: savedAgentBackendTypeIdSchema,
  backend: savedAgentBackendPresentationSchema,
  overrideCount: z
    .number()
    .int()
    .nonnegative()
    .max(SAVED_AGENT_OVERRIDE_MAX_COUNT),
  sedesTools: z
    .strictObject({
      enabled: z.boolean(),
      selectedToolCount: z
        .number()
        .int()
        .nonnegative()
        .max(SAVED_AGENT_SEDES_TOOLS_MAX_COUNT),
      presentation: agentToolPresentationSchema,
      accessBoundary: agentToolAccessBoundarySchema,
    })
    .nullable(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SavedAgentSummary = z.infer<typeof savedAgentSummarySchema>;

export const savedAgentListPageSchema = z.strictObject({
  items: z.array(savedAgentSummarySchema).max(SAVED_AGENT_PAGE_MAX_ITEMS),
  nextCursor: z
    .string()
    .min(1)
    .max(SAVED_AGENT_CURSOR_MAX_CHARACTERS)
    .optional(),
});
export type SavedAgentListPage = z.infer<typeof savedAgentListPageSchema>;

export const agentConfigurationOptionSchema = z.strictObject({
  value: wellFormedTextSchema
    .min(1)
    .max(SAVED_AGENT_OVERRIDE_VALUE_MAX_CHARACTERS),
  label: boundedDisplayTextSchema,
  available: z.boolean(),
  unavailableReason: boundedDisplayTextSchema.optional(),
});
export type AgentConfigurationOption = z.infer<
  typeof agentConfigurationOptionSchema
>;

export const agentConfigurationFieldDescriptorSchema = z.strictObject({
  id: agentConfigurationOverrideSchema.shape.id,
  label: boundedDisplayTextSchema,
  description: boundedDisplayTextSchema.optional(),
  options: z.array(agentConfigurationOptionSchema).max(512),
  currentDefaultValue: agentConfigurationOverrideSchema.shape.value.nullable(),
  resolvedValue: agentConfigurationOverrideSchema.shape.value.nullable(),
});
export type AgentConfigurationFieldDescriptor = z.infer<
  typeof agentConfigurationFieldDescriptorSchema
>;

export const normalizedAgentConfigurationDescriptorSchema = z
  .strictObject({
    backendTypeId: savedAgentBackendTypeIdSchema,
    fields: z
      .array(agentConfigurationFieldDescriptorSchema)
      .max(SAVED_AGENT_OVERRIDE_MAX_COUNT),
    canonicalOverrides: normalizedAgentConfigurationOverridesSchema,
  })
  .superRefine((descriptor, context) => {
    const ids = descriptor.fields.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Saved Agent configuration field IDs must be unique.",
        path: ["fields"],
      });
    }
    requireSerializedByteLimit(
      descriptor,
      context,
      MAXIMUM_BROWSER_ENTITY_BYTES,
      "Saved Agent configuration descriptor exceeds the serialized byte limit.",
    );
  });
export type NormalizedAgentConfigurationDescriptor = z.infer<
  typeof normalizedAgentConfigurationDescriptorSchema
>;

const targetIdSchema = z.string().min(1).max(160);
const savedAgentRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const savedAgentRouteParametersSchema = z.strictObject({
  agentId: savedAgentIdSchema,
});

export const savedAgentListQuerySchema = z
  .strictObject({
    backendTypeId: savedAgentBackendTypeIdSchema.optional(),
    targetId: targetIdSchema.optional(),
    nameSearch: savedAgentNameSchema.optional(),
    cursor: z.string().min(1).max(SAVED_AGENT_CURSOR_MAX_CHARACTERS).optional(),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(SAVED_AGENT_PAGE_MAX_ITEMS)
      .default(50),
  })
  .superRefine((query, context) => {
    if (query.backendTypeId && query.targetId) {
      context.addIssue({
        code: "custom",
        message:
          "Filter saved Agents by backend type or Target, not both.",
        path: ["targetId"],
      });
    }
  });
export type SavedAgentListQuery = z.infer<typeof savedAgentListQuerySchema>;

export const savedAgentAuthoringContextSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  targetId: targetIdSchema,
});

export const createSavedAgentRequestSchema = z.strictObject({
  environmentVariables: environmentVariableOverridesSchema.optional(),
  name: savedAgentNameSchema,
  description: savedAgentDescriptionSchema.optional(),
  authoringContext: savedAgentAuthoringContextSchema,
  backendOverrides: normalizedAgentConfigurationOverridesSchema,
  sedesTools: agentToolBootstrapPolicySchema.optional(),
});
export type CreateSavedAgentRequest = z.infer<
  typeof createSavedAgentRequestSchema
>;

export const updateSavedAgentRequestSchema = z
  .strictObject({
    expectedRevision: savedAgentRevisionSchema,
    environmentVariables: environmentVariableOverridesSchema.optional(),
    name: savedAgentNameSchema.optional(),
    description: savedAgentDescriptionSchema.nullable().optional(),
    authoringContext: savedAgentAuthoringContextSchema.optional(),
    backendOverrides: normalizedAgentConfigurationOverridesSchema.optional(),
    sedesTools: agentToolBootstrapPolicySchema.nullable().optional(),
  })
  .superRefine((request, context) => {
    const changesConfiguration =
      request.backendOverrides !== undefined ||
      request.sedesTools !== undefined || request.environmentVariables !== undefined;
    if (
      request.name === undefined &&
      request.description === undefined &&
      !changesConfiguration
    ) {
      context.addIssue({
        code: "custom",
        message: "A Saved Agent update must change at least one field.",
      });
    }
    if (changesConfiguration !== (request.authoringContext !== undefined)) {
      context.addIssue({
        code: "custom",
        message:
          "Saved Agent configuration replacements require exactly one authoring context.",
        path: ["authoringContext"],
      });
    }
  });
export type UpdateSavedAgentRequest = z.infer<
  typeof updateSavedAgentRequestSchema
>;

export const deleteSavedAgentRequestSchema = z.strictObject({
  expectedRevision: savedAgentRevisionSchema,
});
export type DeleteSavedAgentRequest = z.infer<
  typeof deleteSavedAgentRequestSchema
>;

export const savedAgentMutationResultSchema = z.strictObject({
  agent: savedAgentSchema,
});
export type SavedAgentMutationResult = z.infer<
  typeof savedAgentMutationResultSchema
>;

export const savedAgentDeleteResultSchema = z.strictObject({
  deleted: z.literal(true),
  agentId: savedAgentIdSchema,
});
export type SavedAgentDeleteResult = z.infer<
  typeof savedAgentDeleteResultSchema
>;

export const savedAgentTargetDescriptorSchema = z.strictObject({
  id: targetIdSchema,
  label: boundedDisplayTextSchema,
  backend: savedAgentBackendPresentationSchema,
});
export type SavedAgentTargetDescriptor = z.infer<
  typeof savedAgentTargetDescriptorSchema
>;

export const resolvedAgentToolBootstrapPolicySchema = z.strictObject({
  enabled: z.boolean(),
  enabledToolIds: z
    .array(agentToolIdSchema)
    .max(SAVED_AGENT_SEDES_TOOLS_MAX_COUNT),
  presentation: agentToolPresentationSchema,
  accessBoundary: agentToolAccessBoundarySchema,
});
export type ResolvedAgentToolBootstrapPolicy = z.infer<
  typeof resolvedAgentToolBootstrapPolicySchema
>;

export const agentToolBootstrapDescriptorSchema = z.strictObject({
  defaultPolicy: resolvedAgentToolBootstrapPolicySchema,
  resolvedPolicy: resolvedAgentToolBootstrapPolicySchema,
  groups: z.array(normalizedThreadAgentToolGroupSchema).max(64),
  presentationOptions: agentToolPresentationOptionsSchema,
});
export type AgentToolBootstrapDescriptor = z.infer<
  typeof agentToolBootstrapDescriptorSchema
>;

export const savedAgentOptionsRequestSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    targetId: targetIdSchema.optional(),
    overrides: normalizedAgentConfigurationOverridesSchema.optional(),
    sedesTools: agentToolBootstrapPolicySchema.optional(),
  })
  .superRefine((request, context) => {
    if (
      request.targetId === undefined &&
      (request.overrides !== undefined || request.sedesTools !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Saved Agent overrides require a selected target.",
        path: ["targetId"],
      });
    }
  });
export type SavedAgentOptionsRequest = z.infer<
  typeof savedAgentOptionsRequestSchema
>;

const selectedSavedAgentOptionsSchema = z.strictObject({
  kind: z.literal("configuration"),
  target: savedAgentTargetDescriptorSchema,
  configuration: normalizedAgentConfigurationDescriptorSchema,
  sedesTools: agentToolBootstrapDescriptorSchema,
});

export const savedAgentOptionsResultSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("targets"),
      targets: z.array(savedAgentTargetDescriptorSchema).max(256),
    }),
    selectedSavedAgentOptionsSchema,
  ])
  .superRefine((result, context) => {
    requireSerializedByteLimit(
      result,
      context,
      MAXIMUM_BROWSER_ENTITY_BYTES,
      "Saved Agent options exceed the serialized byte limit.",
    );
  });
export type SavedAgentOptionsResult = z.infer<
  typeof savedAgentOptionsResultSchema
>;

export const resolveSavedAgentRequestSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  targetId: targetIdSchema.optional(),
});
export type ResolveSavedAgentRequest = z.infer<
  typeof resolveSavedAgentRequestSchema
>;

export const savedAgentResolutionCandidateSchema = z.strictObject({
  target: savedAgentTargetDescriptorSchema,
  configuration: normalizedAgentConfigurationDescriptorSchema,
  sedesTools: agentToolBootstrapDescriptorSchema,
});
export type SavedAgentResolutionCandidate = z.infer<
  typeof savedAgentResolutionCandidateSchema
>;

export const savedAgentResolutionFailureSchema = z.strictObject({
  target: savedAgentTargetDescriptorSchema,
  reason: boundedDisplayTextSchema,
});

export const resolveSavedAgentResultSchema = z
  .strictObject({
    candidates: z.array(savedAgentResolutionCandidateSchema).max(256),
    failures: z.array(savedAgentResolutionFailureSchema).max(256),
  })
  .superRefine((result, context) => {
    requireSerializedByteLimit(
      result,
      context,
      MAXIMUM_BROWSER_ENTITY_BYTES,
      "Saved Agent resolution exceeds the serialized byte limit.",
    );
  });
export type ResolveSavedAgentResult = z.infer<
  typeof resolveSavedAgentResultSchema
>;
