import { z } from "zod";
import { pageRevisionSchema, type PageRevision } from "../../shared/protocol/pages.js";

const pagesPanelIntentSchema = z.strictObject({
  threadId: z.string().min(1),
  page: pageRevisionSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type PagesPanelIntent = z.infer<typeof pagesPanelIntentSchema>;

let nextSequence = 0;

/** A chat occurrence opens its exact published revision, including repeat clicks. */
export function createPagesPanelIntent(page: PageRevision): PagesPanelIntent {
  return { threadId: page.threadId, page, sequence: ++nextSequence };
}

export function parsePagesPanelIntent(value: unknown): PagesPanelIntent | undefined {
  const result = pagesPanelIntentSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
