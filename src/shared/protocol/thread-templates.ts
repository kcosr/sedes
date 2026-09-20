import { environmentVariableOverridesSchema } from "./environment-variables.js";
import { z } from "zod";
import { executionWorkspaceSelectionSchema } from "./conversation.js";
import { workspaceIdSchema } from "./domain.js";
import {
  MAXIMUM_BROWSER_ENTITY_BYTES,
  requireSerializedByteLimit,
} from "./payload.js";
import { savedAgentIdSchema } from "./saved-agents.js";

export const THREAD_TEMPLATE_NAME_MAX_CHARACTERS = 160;
export const THREAD_TEMPLATE_PAGE_MAX_ITEMS = 100;
export const THREAD_TEMPLATE_CURSOR_MAX_CHARACTERS = 2_048;

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
  message: "Thread template text must contain well-formed UTF-16.",
});

export const threadTemplateIdSchema = z.uuid();
export const threadTemplateNameSchema = wellFormedTextSchema
  .trim()
  .min(1)
  .max(THREAD_TEMPLATE_NAME_MAX_CHARACTERS);
export const threadTemplateTargetIdSchema = z.string().min(1).max(160);
export const threadTemplateCapturedAgentNameSchema = wellFormedTextSchema
  .min(1)
  .max(160);
export const threadTemplateCapturedWorkspaceNameSchema = wellFormedTextSchema
  .min(1)
  .max(240);
export const threadTemplateCapturedTargetNameSchema = wellFormedTextSchema
  .min(1)
  .max(120);

const threadTemplateRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const threadTemplateSchema = z.strictObject({
  id: threadTemplateIdSchema,
  name: threadTemplateNameSchema,
  workspaceId: workspaceIdSchema,
  targetId: threadTemplateTargetIdSchema,
  executionWorkspace: executionWorkspaceSelectionSchema,
  agentId: savedAgentIdSchema,
  environmentVariables: environmentVariableOverridesSchema.optional(),
  capturedAgentName: threadTemplateCapturedAgentNameSchema,
  capturedWorkspaceName: threadTemplateCapturedWorkspaceNameSchema,
  capturedTargetName: threadTemplateCapturedTargetNameSchema,
  revision: threadTemplateRevisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ThreadTemplate = z.infer<typeof threadTemplateSchema>;

export const threadTemplateListPageSchema = z
  .strictObject({
    items: z.array(threadTemplateSchema).max(THREAD_TEMPLATE_PAGE_MAX_ITEMS),
    nextCursor: z
      .string()
      .min(1)
      .max(THREAD_TEMPLATE_CURSOR_MAX_CHARACTERS)
      .optional(),
  })
  .superRefine((page, context) => {
    requireSerializedByteLimit(
      page,
      context,
      MAXIMUM_BROWSER_ENTITY_BYTES,
      "Thread templates exceed the serialized byte limit.",
    );
  });
export type ThreadTemplateListPage = z.infer<
  typeof threadTemplateListPageSchema
>;

export const threadTemplateListQuerySchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(THREAD_TEMPLATE_CURSOR_MAX_CHARACTERS)
    .optional(),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(THREAD_TEMPLATE_PAGE_MAX_ITEMS)
    .default(50),
});
export type ThreadTemplateListQuery = z.infer<
  typeof threadTemplateListQuerySchema
>;

const threadTemplateSelectionShape = {
  workspaceId: workspaceIdSchema,
  targetId: threadTemplateTargetIdSchema,
  executionWorkspace: executionWorkspaceSelectionSchema,
  agentId: savedAgentIdSchema,
  environmentVariables: environmentVariableOverridesSchema.optional(),
} as const;

export const createThreadTemplateRequestSchema = z.strictObject({
  name: threadTemplateNameSchema,
  ...threadTemplateSelectionShape,
});
export type CreateThreadTemplateRequest = z.infer<
  typeof createThreadTemplateRequestSchema
>;

export const updateThreadTemplateRequestSchema = z
  .strictObject({
    expectedRevision: threadTemplateRevisionSchema,
    name: threadTemplateNameSchema.optional(),
    workspaceId: workspaceIdSchema.optional(),
    targetId: threadTemplateTargetIdSchema.optional(),
    executionWorkspace: executionWorkspaceSelectionSchema.optional(),
    agentId: savedAgentIdSchema.optional(),
    environmentVariables: environmentVariableOverridesSchema.optional(),
  })
  .refine(
    (request) =>
      request.name !== undefined ||
      request.workspaceId !== undefined ||
      request.targetId !== undefined ||
      request.executionWorkspace !== undefined ||
      request.agentId !== undefined ||
      request.environmentVariables !== undefined,
    { message: "A thread template update must change at least one field." },
  );
export type UpdateThreadTemplateRequest = z.infer<
  typeof updateThreadTemplateRequestSchema
>;

export const deleteThreadTemplateRequestSchema = z.strictObject({
  expectedRevision: threadTemplateRevisionSchema,
});
export type DeleteThreadTemplateRequest = z.infer<
  typeof deleteThreadTemplateRequestSchema
>;

export const threadTemplateRouteParametersSchema = z.strictObject({
  templateId: threadTemplateIdSchema,
});

export const threadTemplateMutationResultSchema = z.strictObject({
  template: threadTemplateSchema,
});
export type ThreadTemplateMutationResult = z.infer<
  typeof threadTemplateMutationResultSchema
>;

export const threadTemplateDeleteResultSchema = z.strictObject({
  deleted: z.literal(true),
  templateId: threadTemplateIdSchema,
});
export type ThreadTemplateDeleteResult = z.infer<
  typeof threadTemplateDeleteResultSchema
>;
