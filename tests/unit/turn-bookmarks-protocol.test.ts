import { describe, expect, it } from "vitest";
import {
  listTurnBookmarksResultSchema,
  setTurnBookmarkRequestSchema,
  setTurnBookmarkResultSchema,
  turnBookmarkSchema,
} from "../../src/shared/protocol/turn-bookmarks.js";

const mutationId = "65fa1d7b-157f-4851-8b4e-0769b7b0105c";
const replyOnlyBookmark = {
  turnId: "turn-reply-only",
  userPreview: null,
  assistantPreview: "The background task finished; here is its result.",
  responseState: "responded",
  createdAt: 700,
} as const;
const replyOnlyRequest = {
  bookmarked: true,
  expectedRevision: 0,
  mutationId,
  userPreview: null,
  assistantPreview: replyOnlyBookmark.assistantPreview,
  responseState: "responded",
} as const;
const missingPreviewIssue = expect.objectContaining({
  code: "custom",
  path: ["userPreview"],
  message: "A bookmark without a user prompt requires an assistant preview.",
});

describe("turn bookmark contract", () => {
  it("accepts a reply-only bookmark identified by its reply", () => {
    expect(turnBookmarkSchema.parse(replyOnlyBookmark)).toEqual(
      replyOnlyBookmark,
    );
    expect(
      listTurnBookmarksResultSchema.parse({
        revision: 1,
        bookmarks: [replyOnlyBookmark],
      }),
    ).toEqual({ revision: 1, bookmarks: [replyOnlyBookmark] });
    expect(
      setTurnBookmarkResultSchema.parse({
        revision: 1,
        bookmark: replyOnlyBookmark,
        replayed: false,
      }),
    ).toEqual({ revision: 1, bookmark: replyOnlyBookmark, replayed: false });
  });

  it("rejects a bookmark with neither a user nor an assistant preview", () => {
    for (const responseState of ["responded", "no_response"] as const) {
      const result = turnBookmarkSchema.safeParse({
        ...replyOnlyBookmark,
        assistantPreview: null,
        responseState,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(missingPreviewIssue);
    }
    expect(
      turnBookmarkSchema.safeParse({
        ...replyOnlyBookmark,
        responseState: "no_response",
      }).error?.issues,
    ).toEqual([
      expect.objectContaining({ code: "custom", path: ["assistantPreview"] }),
    ]);
    expect(
      turnBookmarkSchema.safeParse({ ...replyOnlyBookmark, userPreview: "" })
        .success,
    ).toBe(false);
  });

  it("accepts reply-only set requests and leaves removal requests unchanged", () => {
    expect(setTurnBookmarkRequestSchema.parse(replyOnlyRequest)).toEqual(
      replyOnlyRequest,
    );
    for (const responseState of ["responded", "no_response"] as const) {
      const result = setTurnBookmarkRequestSchema.safeParse({
        ...replyOnlyRequest,
        assistantPreview: null,
        responseState,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(missingPreviewIssue);
    }

    const removal = { bookmarked: false, expectedRevision: 1, mutationId };
    expect(setTurnBookmarkRequestSchema.parse(removal)).toEqual(removal);
    for (const extra of [
      { userPreview: null },
      { assistantPreview: null },
      { responseState: "responded" },
    ]) {
      expect(
        setTurnBookmarkRequestSchema.safeParse({ ...removal, ...extra })
          .success,
      ).toBe(false);
    }
  });
});
