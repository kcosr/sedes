import { z } from "zod";
import { agentToolEffectsSchema } from "./conversation.js";
import { apiErrorDetailSchema } from "./api.js";

export const TOOL_CLIENT_MAXIMUM_TOOLS = 256;
export const TOOL_CLIENT_MAXIMUM_ENVIRONMENTS = 16;
export const TOOL_CLIENT_MAXIMUM_GROUPS = 64;
export const TOOL_CLIENT_PAGE_MAXIMUM_ITEMS = 100;
export const TOOL_CLIENT_CURSOR_MAXIMUM_CHARACTERS = 2_048;

const resourceIdSchema = z.string().min(1).max(128);
const toolIdSchema = resourceIdSchema.regex(
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u,
);
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const generationSchema = z.number().int().min(1).max(0xffff_ffff);
const uniqueIds = <T extends z.ZodType<string>>(item: T, maximum: number) =>
  z
    .array(item)
    .max(maximum)
    .superRefine((ids, context) => {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: "custom",
          message: "IDs must be unique.",
        });
      }
    });

export const toolClientIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
export const toolClientCreationRequestIdSchema = z.uuid();
export const toolClientNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((name) => new TextEncoder().encode(name).byteLength <= 240, {
    message: "The tool client name exceeds 240 UTF-8 bytes.",
  });

const toolClientPolicyFields = {
  name: toolClientNameSchema,
  toolIds: uniqueIds(toolIdSchema, TOOL_CLIENT_MAXIMUM_TOOLS).min(1),
  defaultEnvironmentId: resourceIdSchema,
  allowedEnvironmentIds: uniqueIds(
    resourceIdSchema,
    TOOL_CLIENT_MAXIMUM_ENVIRONMENTS,
  ).min(1),
  defaultWorkspaceId: resourceIdSchema.optional(),
  defaultThreadId: resourceIdSchema.optional(),
} as const;

function refinePolicy(
  policy: {
    readonly defaultEnvironmentId: string;
    readonly allowedEnvironmentIds: readonly string[];
    readonly defaultWorkspaceId?: string;
    readonly defaultThreadId?: string;
  },
  context: z.RefinementCtx,
): void {
  if (!policy.allowedEnvironmentIds.includes(policy.defaultEnvironmentId)) {
    context.addIssue({
      code: "custom",
      path: ["defaultEnvironmentId"],
      message: "The default environment must be allowed.",
    });
  }
  if (policy.defaultThreadId && !policy.defaultWorkspaceId) {
    context.addIssue({
      code: "custom",
      path: ["defaultThreadId"],
      message: "A default thread requires a default workspace.",
    });
  }
}

export const createToolClientRequestSchema = z
  .strictObject({
    requestId: toolClientCreationRequestIdSchema,
    ...toolClientPolicyFields,
  })
  .superRefine(refinePolicy);
export type CreateToolClientRequest = z.infer<
  typeof createToolClientRequestSchema
>;

export const replaceToolClientRequestSchema = z
  .strictObject({
    ...toolClientPolicyFields,
    enabled: z.boolean(),
    expectedRevision: revisionSchema,
  })
  .superRefine(refinePolicy);
export type ReplaceToolClientRequest = z.infer<
  typeof replaceToolClientRequestSchema
>;

export const toolClientRevisionRequestSchema = z.strictObject({
  expectedRevision: revisionSchema,
});
export type ToolClientRevisionRequest = z.infer<
  typeof toolClientRevisionRequestSchema
>;

export const toolClientRouteParametersSchema = z.strictObject({
  clientId: toolClientIdSchema,
});

export const toolClientListQuerySchema = z
  .strictObject({
    creationRequestId: toolClientCreationRequestIdSchema.optional(),
    cursor: z
      .string()
      .min(1)
      .max(TOOL_CLIENT_CURSOR_MAXIMUM_CHARACTERS)
      .optional(),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(TOOL_CLIENT_PAGE_MAXIMUM_ITEMS)
      .default(50),
  })
  .superRefine((query, context) => {
    if (query.creationRequestId && query.cursor) {
      context.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "A recovery filter cannot be combined with a cursor.",
      });
    }
  });
export type ToolClientListQuery = z.infer<typeof toolClientListQuerySchema>;

const availabilityEntrySchema = z.strictObject({
  id: resourceIdSchema,
  available: z.boolean(),
});

export const toolClientSchema = z
  .strictObject({
    id: toolClientIdSchema,
    creationRequestId: toolClientCreationRequestIdSchema,
    name: toolClientNameSchema,
    state: z.enum(["enabled", "disabled", "revoked"]),
    availability: z.enum(["available", "needs_attention"]),
    toolIds: uniqueIds(toolIdSchema, TOOL_CLIENT_MAXIMUM_TOOLS),
    tools: z.array(availabilityEntrySchema).max(TOOL_CLIENT_MAXIMUM_TOOLS),
    defaultEnvironmentId: resourceIdSchema.nullable(),
    allowedEnvironmentIds: uniqueIds(
      resourceIdSchema,
      TOOL_CLIENT_MAXIMUM_ENVIRONMENTS,
    ),
    environments: z
      .array(availabilityEntrySchema)
      .max(TOOL_CLIENT_MAXIMUM_ENVIRONMENTS),
    defaultWorkspaceId: resourceIdSchema.nullable(),
    defaultWorkspaceAvailable: z.boolean().nullable(),
    defaultThreadId: resourceIdSchema.nullable(),
    defaultThreadAvailable: z.boolean().nullable(),
    policyRevision: revisionSchema,
    credentialGeneration: generationSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .superRefine((client, context) => {
    const toolAvailabilityIds = client.tools.map(({ id }) => id);
    const environmentAvailabilityIds = client.environments.map(({ id }) => id);
    if (
      new Set(toolAvailabilityIds).size !== toolAvailabilityIds.length ||
      !sameIds(client.toolIds, toolAvailabilityIds)
    ) {
      context.addIssue({
        code: "custom",
        path: ["tools"],
        message: "Tool availability must exactly match the durable selection.",
      });
    }
    if (
      new Set(environmentAvailabilityIds).size !==
        environmentAvailabilityIds.length ||
      !sameIds(client.allowedEnvironmentIds, environmentAvailabilityIds)
    ) {
      context.addIssue({
        code: "custom",
        path: ["environments"],
        message:
          "Environment availability must exactly match the durable selection.",
      });
    }
    const revoked = client.state === "revoked";
    if (
      revoked !== (client.revokedAt !== null) ||
      (revoked &&
        (client.toolIds.length > 0 ||
          client.allowedEnvironmentIds.length > 0 ||
          client.defaultEnvironmentId !== null ||
          client.defaultWorkspaceId !== null ||
          client.defaultThreadId !== null)) ||
      (!revoked &&
        (client.defaultEnvironmentId === null ||
          !client.allowedEnvironmentIds.includes(client.defaultEnvironmentId)))
    ) {
      context.addIssue({
        code: "custom",
        message: "The tool client lifecycle and policy fields do not agree.",
      });
    }
    if (
      (client.defaultWorkspaceId === null) !==
        (client.defaultWorkspaceAvailable === null) ||
      (client.defaultThreadId === null) !==
        (client.defaultThreadAvailable === null) ||
      (client.defaultThreadId !== null && client.defaultWorkspaceId === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "The tool client default availability fields do not agree.",
      });
    }
  });
export type ToolClient = z.infer<typeof toolClientSchema>;

export const toolClientListPageSchema = z.strictObject({
  items: z.array(toolClientSchema).max(TOOL_CLIENT_PAGE_MAXIMUM_ITEMS),
  nextCursor: z
    .string()
    .min(1)
    .max(TOOL_CLIENT_CURSOR_MAXIMUM_CHARACTERS)
    .optional(),
});
export type ToolClientListPage = z.infer<typeof toolClientListPageSchema>;

export const toolClientCredentialSchema = z
  .string()
  .min(88)
  .max(97)
  .regex(
    /^hatc1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_[1-9][0-9]{0,9}_[A-Za-z0-9_-]{43}$/u,
  )
  .refine((credential) => {
    const generation = Number(credential.split("_")[2]);
    return Number.isInteger(generation) && generation <= 0xffff_ffff;
  }, "The credential generation is invalid.");

export const toolClientCredentialResultSchema = z.strictObject({
  client: toolClientSchema,
  credential: toolClientCredentialSchema,
});
export type ToolClientCredentialResult = z.infer<
  typeof toolClientCredentialResultSchema
>;

export const toolClientCreationConflictSchema = z.strictObject({
  error: apiErrorDetailSchema.extend({ code: z.literal("conflict") }),
  client: toolClientSchema,
});

const toolClientOptionToolSchema = z.strictObject({
  id: toolIdSchema,
  label: z.string().min(1).max(240),
  description: z.string().min(1).max(4_096),
  order: revisionSchema,
  effects: agentToolEffectsSchema,
  available: z.boolean(),
  unavailableReason: z.string().min(1).max(4_096).optional(),
});

const toolClientOptionGroupSchema = z.strictObject({
  id: resourceIdSchema,
  label: z.string().min(1).max(240),
  description: z.string().min(1).max(4_096),
  order: revisionSchema,
  tools: z.array(toolClientOptionToolSchema).min(1).max(TOOL_CLIENT_MAXIMUM_TOOLS),
});

const toolClientEnvironmentOptionSchema = z.strictObject({
  id: resourceIdSchema,
  label: z.string().min(1).max(240),
  kind: z.enum(["local", "ssh", "outbound"]),
  available: z.boolean(),
});

export const toolClientOptionsSchema = z
  .strictObject({
    environments: z
      .array(toolClientEnvironmentOptionSchema)
      .max(TOOL_CLIENT_MAXIMUM_ENVIRONMENTS),
    groups: z.array(toolClientOptionGroupSchema).max(TOOL_CLIENT_MAXIMUM_GROUPS),
  })
  .superRefine((options, context) => {
    const environmentIds = options.environments.map(({ id }) => id);
    const groupIds = options.groups.map(({ id }) => id);
    const toolIds = options.groups.flatMap(({ tools }) =>
      tools.map(({ id }) => id),
    );
    if (
      new Set(environmentIds).size !== environmentIds.length ||
      new Set(groupIds).size !== groupIds.length ||
      new Set(toolIds).size !== toolIds.length ||
      toolIds.length > TOOL_CLIENT_MAXIMUM_TOOLS
    ) {
      context.addIssue({
        code: "custom",
        message: "Tool client options must contain unique bounded IDs.",
      });
    }
  });
export type ToolClientOptions = z.infer<typeof toolClientOptionsSchema>;

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}
