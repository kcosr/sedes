import { z } from "zod";

export const PAGE_SOURCE_MAX_BYTES = 1_048_576;
export const PAGE_INLINE_MAX_CHARACTERS = 65_536;
export const PAGE_DOCUMENT_MAX_BYTES = 16_777_216;
/** Private encoded storage and response bounds; public byteSize measures authored HTML. */
export const PAGE_ESCAPED_MAX_BYTES = 33_554_432;
export const PAGE_RENDER_OVERHEAD_MAX_BYTES = 65_536;
export const PAGE_RENDER_MAX_BYTES = PAGE_ESCAPED_MAX_BYTES + PAGE_RENDER_OVERHEAD_MAX_BYTES;
export const PAGE_MAX_IMAGES = 64;
export const pageIdSchema = z.string().uuid();
export const pageRevisionNumberSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const pageViewportSchema = z.strictObject({
  width: z.number().int().min(100).max(4096).optional(),
  height: z.number().int().min(100).max(8192).optional(),
});
export type PageViewport = z.infer<typeof pageViewportSchema>;
/** Immutable presentation metadata. Paths and document bytes never enter history. */
export const pageRevisionSchema = z.strictObject({
  pageId: pageIdSchema,
  threadId: z.string().min(1).max(128),
  revision: pageRevisionNumberSchema,
  title: z.string().trim().min(1).max(240),
  viewport: pageViewportSchema,
  createdAt: z.iso.datetime(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().min(1).max(PAGE_DOCUMENT_MAX_BYTES),
});
export type PageRevision = z.infer<typeof pageRevisionSchema>;
export const pageRevisionPageSchema = z.strictObject({
  items: z.array(pageRevisionSchema).max(100), nextCursor: z.string().max(256).optional(),
});
export type PageRevisionPage = z.infer<typeof pageRevisionPageSchema>;
const pageSourceFields = {
  path: z.string().min(1).max(4096).optional(),
  html: z.string().min(1).max(PAGE_INLINE_MAX_CHARACTERS).optional(),
};
export const pageSourceSchema = z.strictObject(pageSourceFields).refine(value => (value.path === undefined) !== (value.html === undefined),
  "Provide exactly one of path or html.");
export type PageSource = z.infer<typeof pageSourceSchema>;
export const publishPageRequestSchema = z.strictObject({
  ...pageSourceFields,
  title: z.string().trim().min(1).max(240),
  pageId: pageIdSchema.optional(),
  expectedRevision: pageRevisionNumberSchema.optional(),
  viewport: pageViewportSchema.optional(),
}).refine(value => (value.pageId === undefined) === (value.expectedRevision === undefined),
  "Updating a page requires both pageId and expectedRevision.")
  .refine(value => (value.path === undefined) !== (value.html === undefined), "Provide exactly one of path or html.");
export type PublishPageRequest = z.infer<typeof publishPageRequestSchema>;
export const pagePublicationResultSchema = z.strictObject({ page: pageRevisionSchema, changed: z.boolean() });
export type PagePublicationResult = z.infer<typeof pagePublicationResultSchema>;
