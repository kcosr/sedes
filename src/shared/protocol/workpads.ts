import { z } from "zod";
import { taskScopeSchema } from "./tasks.js";

export const WORKPAD_CONTENT_MAX_CHARACTERS = 262_144;
export const workpadIdSchema = z.string().min(1).max(128);
export const workpadScopeSchema = taskScopeSchema;
export type WorkpadScope = z.infer<typeof workpadScopeSchema>;
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(WORKPAD_CONTENT_MAX_CHARACTERS).refine(value => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), "Text must be well-formed UTF-16.");
const title = z.string().trim().min(1).max(240);
const authorName = z.string().min(1).max(240);
export const workpadAuthorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), threadId: z.null(), clientId: z.null(), name: authorName, nameSnapshot: authorName }),
  z.strictObject({ kind: z.literal("agent"), threadId: z.string().min(1).max(128), clientId: z.null(), name: authorName, nameSnapshot: authorName }),
  z.strictObject({ kind: z.literal("tool_client"), threadId: z.null(), clientId: z.string().min(1).max(128), name: authorName, nameSnapshot: authorName }),
]);
export type WorkpadAuthor = z.infer<typeof workpadAuthorSchema>;
export const workpadAttributionSpanSchema = z.strictObject({
  start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), end: z.number().int().positive(), revision,
  author: workpadAuthorSchema, createdAt: z.iso.datetime(),
}).refine(span => span.end > span.start, "Attribution spans must have positive length.");
export type WorkpadAttributionSpan = z.infer<typeof workpadAttributionSpanSchema>;
export const workpadChangeSchema = z.strictObject({
  kind: z.enum(["added", "removed"]), text, offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type WorkpadChange = z.infer<typeof workpadChangeSchema>;
export const workpadSummarySchema = z.strictObject({
  id: workpadIdSchema, title, scope: workpadScopeSchema, revision,
  archivedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  author: workpadAuthorSchema,
});
export type WorkpadSummary = z.infer<typeof workpadSummarySchema>;
export const workpadSchema = workpadSummarySchema.extend({ content: text, attribution: z.array(workpadAttributionSpanSchema).max(4_096) });
export type Workpad = z.infer<typeof workpadSchema>;
export const workpadRevisionSchema = z.strictObject({
  workpadId: workpadIdSchema, revision, title, content: text, scope: workpadScopeSchema,
  archivedAt: z.iso.datetime().nullable(), author: workpadAuthorSchema,
  createdAt: z.iso.datetime(), attribution: z.array(workpadAttributionSpanSchema).max(4_096), changes: z.array(workpadChangeSchema),
});
export type WorkpadRevision = z.infer<typeof workpadRevisionSchema>;
export const createWorkpadRequestSchema = z.strictObject({ title, scope: workpadScopeSchema, content: text.optional() });
export type CreateWorkpadRequest = z.infer<typeof createWorkpadRequestSchema>;
export const workpadContentEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("replace"), content: text }),
  z.strictObject({ kind: z.literal("append"), text }),
  z.strictObject({ kind: z.literal("patch"), edits: z.array(z.strictObject({ oldText: text.refine(value => value.length > 0), newText: text })).min(1).max(100) }),
]);
export type WorkpadContentEdit = z.infer<typeof workpadContentEditSchema>;
export const updateWorkpadRequestSchema = z.strictObject({
  expectedRevision: revision, title: title.optional(), scope: workpadScopeSchema.optional(),
  archived: z.boolean().optional(), edit: workpadContentEditSchema.optional(),
}).refine(value => value.title !== undefined || value.scope !== undefined || value.archived !== undefined || value.edit !== undefined, "An update must specify a change.");
export type UpdateWorkpadRequest = z.infer<typeof updateWorkpadRequestSchema>;
export const listWorkpadsRequestSchema = z.strictObject({
  scope: workpadScopeSchema, scopeMode: z.enum(["exact", "subtree"]).default("exact"),
  query: z.string().trim().min(1).max(240).optional(), archived: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(256).optional(),
});
export type ListWorkpadsRequest = z.input<typeof listWorkpadsRequestSchema>;
export const workpadListPageSchema = z.strictObject({ items: z.array(workpadSummarySchema), nextCursor: z.string().optional() });
export type WorkpadListPage = z.infer<typeof workpadListPageSchema>;
export const workpadRevisionSummarySchema = workpadRevisionSchema.omit({ content: true, attribution: true, changes: true });
export type WorkpadRevisionSummary = z.infer<typeof workpadRevisionSummarySchema>;
export const workpadRevisionPageSchema = z.strictObject({ items: z.array(workpadRevisionSummarySchema), nextCursor: z.string().optional() });
export type WorkpadRevisionPage = z.infer<typeof workpadRevisionPageSchema>;
export const workpadDraftSchema = z.strictObject({
  workpadId: workpadIdSchema, revision, baseRevision: revision, content: text,
  updatedAt: z.iso.datetime(),
});
export type WorkpadDraft = z.infer<typeof workpadDraftSchema>;
export const saveWorkpadDraftRequestSchema = z.strictObject({ expectedRevision: revision, baseRevision: revision, content: text });
export type SaveWorkpadDraftRequest = z.infer<typeof saveWorkpadDraftRequestSchema>;
export const commitWorkpadDraftRequestSchema = z.strictObject({ expectedDraftRevision: revision, expectedRevision: revision });
export type CommitWorkpadDraftRequest = z.infer<typeof commitWorkpadDraftRequestSchema>;

export const workpadMutationResultSchema = z.strictObject({ workpad: workpadSchema });
export const workpadDraftResultSchema = z.strictObject({ draft: workpadDraftSchema });
export const workpadRevisionResultSchema = z.strictObject({ revision: workpadRevisionSchema });
export const workpadDraftCommitResultSchema = z.strictObject({ workpad: workpadSchema, draft: workpadDraftSchema });
