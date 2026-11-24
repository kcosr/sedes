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

type TurnBookmarkPreviewFields = {
  readonly userPreview: string | null;
  readonly assistantPreview: string | null;
  readonly responseState: TurnBookmarkResponseState;
};

/**
 * A turn without a durable user prompt, such as a reply continued after
 * background work, is identified by its reply instead.
 */
function refineTurnBookmarkPreview(
  preview: TurnBookmarkPreviewFields,
  context: z.RefinementCtx,
): void {
  if (
    (preview.responseState === "responded") !==
    (preview.assistantPreview !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "Response state must match assistant preview presence.",
      path: ["assistantPreview"],
    });
  }
  if (preview.userPreview === null && preview.assistantPreview === null) {
    context.addIssue({
      code: "custom",
      message: "A bookmark without a user prompt requires an assistant preview.",
      path: ["userPreview"],
    });
  }
}

export const turnBookmarkSchema = z
  .strictObject({
    turnId: applicationTurnIdSchema,
    userPreview: turnBookmarkPreviewSchema.nullable(),
    assistantPreview: turnBookmarkPreviewSchema.nullable(),
    responseState: turnBookmarkResponseStateSchema,
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine(refineTurnBookmarkPreview);
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
      userPreview: turnBookmarkPreviewSchema.nullable(),
      assistantPreview: turnBookmarkPreviewSchema.nullable(),
      responseState: turnBookmarkResponseStateSchema,
    }),
    z.strictObject({
      bookmarked: z.literal(false),
      ...turnBookmarkMutationFields,
    }),
  ])
  .superRefine((input, context) => {
    if (input.bookmarked) refineTurnBookmarkPreview(input, context);
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
