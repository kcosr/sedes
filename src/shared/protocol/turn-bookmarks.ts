import { z } from "zod";
import {
  applicationTurnIdSchema,
  mutationIdSchema,
  threadIdSchema,
} from "./domain.js";

export const TURN_BOOKMARK_PREVIEW_MAXIMUM_CHARACTERS = 1_000;
export const MAXIMUM_TURN_BOOKMARKS_PER_THREAD = 500;

export const turnBookmarkPreviewSchema = z
  .string()
  .min(1)
  .max(TURN_BOOKMARK_PREVIEW_MAXIMUM_CHARACTERS);

export const turnBookmarkResponseStateSchema = z.enum([
  "responded",
  "no_response",
]);
export type TurnBookmarkResponseState = z.infer<
  typeof turnBookmarkResponseStateSchema
>;

export const turnBookmarkSchema = z
  .strictObject({
    turnId: applicationTurnIdSchema,
    userPreview: turnBookmarkPreviewSchema,
    assistantPreview: turnBookmarkPreviewSchema.nullable(),
    responseState: turnBookmarkResponseStateSchema,
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((bookmark, context) => {
    if (
      (bookmark.responseState === "responded") !==
      (bookmark.assistantPreview !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Response state must match assistant preview presence.",
        path: ["assistantPreview"],
      });
    }
  });
export type TurnBookmark = z.infer<typeof turnBookmarkSchema>;

export const turnBookmarkRouteParametersSchema = z.strictObject({
  threadId: threadIdSchema,
  turnId: applicationTurnIdSchema,
});

const turnBookmarkMutationFields = {
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mutationId: mutationIdSchema,
} as const;

export const setTurnBookmarkRequestSchema = z
  .discriminatedUnion("bookmarked", [
    z.strictObject({
      bookmarked: z.literal(true),
      ...turnBookmarkMutationFields,
      userPreview: turnBookmarkPreviewSchema,
      assistantPreview: turnBookmarkPreviewSchema.nullable(),
      responseState: turnBookmarkResponseStateSchema,
    }),
    z.strictObject({
      bookmarked: z.literal(false),
      ...turnBookmarkMutationFields,
    }),
  ])
  .superRefine((input, context) => {
    if (
      input.bookmarked &&
      (input.responseState === "responded") !==
        (input.assistantPreview !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Response state must match assistant preview presence.",
        path: ["assistantPreview"],
      });
    }
  });
export type SetTurnBookmarkRequest = z.infer<
  typeof setTurnBookmarkRequestSchema
>;

export const listTurnBookmarksResultSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bookmarks: z.array(turnBookmarkSchema).max(MAXIMUM_TURN_BOOKMARKS_PER_THREAD),
});
export type ListTurnBookmarksResult = z.infer<
  typeof listTurnBookmarksResultSchema
>;

export const setTurnBookmarkResultSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bookmark: turnBookmarkSchema.nullable(),
  replayed: z.boolean(),
});
export type SetTurnBookmarkResult = z.infer<typeof setTurnBookmarkResultSchema>;
