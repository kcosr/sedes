import { z } from "zod";
import { MAXIMUM_BROWSER_ENTITY_BYTES, requireSerializedByteLimit } from "./payload.js";
import { agentToolIdSchema, agentToolResourceScopeSchema, agentToolPresentationSchema, agentToolPresentationOptionsSchema, normalizedThreadAgentToolGroupSchema } from "./conversation.js";

export const TOOL_POLICY_PAGE_MAX_ITEMS = 100;
export const TOOL_POLICY_SELECTION_MAX_ITEMS = 2048;
export const TOOL_POLICY_MAX_BYTES = 128 * 1024;
export const TOOL_POLICY_CURSOR_MAX_CHARACTERS = 4096;
const cursorSchema = z.string().min(1).max(TOOL_POLICY_CURSOR_MAX_CHARACTERS);
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const toolPolicySetIdSchema = z.uuid();
export const toolPolicySelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inherit") }),
  z.strictObject({ kind: z.literal("disabled") }),
  z.strictObject({ kind: z.literal("policy_set"), policySetId: toolPolicySetIdSchema }),
]);
export type ToolPolicySelection = z.infer<typeof toolPolicySelectionSchema>;
export const toolPolicySourceSchema = z.enum(["default", "account", "environment", "backend", "agent", "thread"]);
export type ToolPolicySource = z.infer<typeof toolPolicySourceSchema>;
export const toolPolicyResolutionIssueSchema = z.strictObject({
  kind: z.literal("missing_policy_set"),
  source: z.enum(["account", "environment", "backend", "agent", "thread"]),
  policySetId: toolPolicySetIdSchema,
});
export type ToolPolicyResolutionIssue = z.infer<typeof toolPolicyResolutionIssueSchema>;

const toolPolicyDefinitionObjectSchema = z.strictObject({
  name: z.string().trim().min(1).max(160).refine(value => !/[\uD800-\uDFFF]/u.test(value), "Policy names must be well-formed display text."),
  enabledToolIds: z.array(agentToolIdSchema).max(512).refine(ids => new Set(ids).size === ids.length, "Tool IDs must be unique."),
  resourceScope: agentToolResourceScopeSchema,
});
export const toolPolicyDefinitionSchema = toolPolicyDefinitionObjectSchema.superRefine((value, context) => {
  requireSerializedByteLimit(value, context, TOOL_POLICY_MAX_BYTES, "Tool policy exceeds its serialized byte limit.");
});
export type ToolPolicyDefinition = z.infer<typeof toolPolicyDefinitionSchema>;
export const toolPolicySetSchema = toolPolicyDefinitionObjectSchema.extend({
  id: toolPolicySetIdSchema,
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine((value, context) => {
  requireSerializedByteLimit(value, context, TOOL_POLICY_MAX_BYTES, "Tool policy exceeds its serialized byte limit.");
});
export type ToolPolicySet = z.infer<typeof toolPolicySetSchema>;
export const toolPolicySetListQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  pageSize: z.coerce.number().int().min(1).max(TOOL_POLICY_PAGE_MAX_ITEMS).optional(),
});
export const toolPolicySetListSchema = z.strictObject({
  items: z.array(toolPolicySetSchema).max(TOOL_POLICY_PAGE_MAX_ITEMS),
  nextCursor: cursorSchema.optional(),
}).superRefine((value, context) => {
  requireSerializedByteLimit(value, context, MAXIMUM_BROWSER_ENTITY_BYTES, "Tool policy page exceeds its serialized byte limit.");
});
export const createToolPolicySetRequestSchema = toolPolicyDefinitionSchema;
export const updateToolPolicySetRequestSchema = toolPolicyDefinitionObjectSchema.extend({ expectedRevision: revisionSchema }).superRefine((value, context) => {
  requireSerializedByteLimit(value, context, TOOL_POLICY_MAX_BYTES, "Tool policy exceeds its serialized byte limit.");
});
export const deleteToolPolicySetRequestSchema = z.strictObject({ expectedRevision: revisionSchema });
export const toolPolicySetRouteParametersSchema = z.strictObject({ policySetId: toolPolicySetIdSchema });
export const toolPolicySetMutationResultSchema = z.strictObject({ policySet: toolPolicySetSchema });
export const deleteToolPolicySetResultSchema = z.strictObject({ deleted: z.literal(true) });
export const toolPolicySelectionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account") }),
  z.strictObject({ kind: z.literal("environment"), executionEnvironmentId: z.string().min(1).max(160) }),
  z.strictObject({ kind: z.literal("backend"), backendId: z.string().min(1).max(160) }),
]);
export type ToolPolicySelectionTarget = z.infer<typeof toolPolicySelectionTargetSchema>;
export const toolPolicySelectionSettingSchema = z.strictObject({
  target: toolPolicySelectionTargetSchema,
  selection: toolPolicySelectionSchema,
  revision: revisionSchema,
});
export type ToolPolicySelectionSetting = z.infer<typeof toolPolicySelectionSettingSchema>;
export const toolPolicySelectionListSchema = z.strictObject({ items: z.array(toolPolicySelectionSettingSchema).max(TOOL_POLICY_SELECTION_MAX_ITEMS) }).superRefine((value, context) => {
  requireSerializedByteLimit(value, context, MAXIMUM_BROWSER_ENTITY_BYTES, "Tool policy selections exceed their serialized byte limit.");
});
export const updateToolPolicySelectionRequestSchema = z.strictObject({
  target: toolPolicySelectionTargetSchema,
  selection: toolPolicySelectionSchema,
  expectedRevision: revisionSchema,
});
export const toolPolicySelectionMutationResultSchema = z.strictObject({ setting: toolPolicySelectionSettingSchema });
export const resolvedToolPolicySchema = z.strictObject({
  enabled: z.boolean(),
  enabledToolIds: z.array(agentToolIdSchema).max(512),
  resourceScope: agentToolResourceScopeSchema,
  source: toolPolicySourceSchema,
  policySet: z.strictObject({ id: toolPolicySetIdSchema, name: toolPolicyDefinitionSchema.shape.name, revision: revisionSchema }).optional(),
});
export type ResolvedToolPolicy = z.infer<typeof resolvedToolPolicySchema>;
/** Target presentation metadata is preview-only; durable policy snapshots remain backend-neutral. */
export const toolPolicyPreviewSchema = resolvedToolPolicySchema.extend({
  presentationOptions: agentToolPresentationOptionsSchema,
  defaultPresentation: agentToolPresentationSchema,
});
export type ToolPolicyPreview = z.infer<typeof toolPolicyPreviewSchema>;
export type ToolPolicyInspection =
  | { readonly kind: "resolved"; readonly policy: ResolvedToolPolicy }
  | ToolPolicyResolutionIssue;
export const resolveToolPolicyRequestSchema = z.strictObject({
  targetId: z.string().min(1).max(160),
  agentId: z.uuid().optional(),
  agentSelection: toolPolicySelectionSchema.optional(),
  threadSelection: toolPolicySelectionSchema.optional(),
});

export const toolPolicyOptionsSchema = z.strictObject({ groups: z.array(normalizedThreadAgentToolGroupSchema).max(64) }).superRefine((value, context) => {
  requireSerializedByteLimit(value, context, MAXIMUM_BROWSER_ENTITY_BYTES, "Tool policy options exceed their serialized byte limit.");
});
