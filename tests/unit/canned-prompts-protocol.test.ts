import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CANNED_PROMPT_MAX_ITEMS,
  cannedPromptTextSchema,
  cannedPromptTitleSchema,
  cannedPromptLibrarySchema,
  reorderCannedPromptsRequestSchema,
} from "../../src/shared/protocol/canned-prompts.js";

describe("canned prompt protocol", () => {
  it("normalizes titles and enforces character and UTF-8 byte limits", () => {
    expect(cannedPromptTitleSchema.parse("  Review changes  ")).toBe(
      "Review changes",
    );
    expect(cannedPromptTitleSchema.parse("ＡＢＣ")).toBe("ABC");
    expect(cannedPromptTitleSchema.safeParse(" ").success).toBe(false);
    expect(cannedPromptTitleSchema.safeParse("a".repeat(121)).success).toBe(
      false,
    );
    expect(cannedPromptTitleSchema.safeParse("😀".repeat(120)).success).toBe(
      true,
    );
    expect(cannedPromptTitleSchema.safeParse("😀".repeat(121)).success).toBe(
      false,
    );
  });

  it("preserves meaningful prompt whitespace while enforcing byte limits", () => {
    expect(cannedPromptTextSchema.parse("  line one\nline two  ")).toBe(
      "  line one\nline two  ",
    );
    expect(cannedPromptTextSchema.safeParse("\n\t ").success).toBe(false);
    expect(cannedPromptTextSchema.safeParse("a".repeat(8192)).success).toBe(
      true,
    );
    expect(cannedPromptTextSchema.safeParse("😀".repeat(2049)).success).toBe(
      false,
    );
  });

  it("caps reorder requests at the collection capacity", () => {
    expect(
      reorderCannedPromptsRequestSchema.safeParse({
        promptIds: [],
        expectedRevision: 0,
        mutationId: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      reorderCannedPromptsRequestSchema.safeParse({
        promptIds: Array.from({ length: CANNED_PROMPT_MAX_ITEMS }, () =>
          randomUUID(),
        ),
        expectedRevision: 0,
        mutationId: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      reorderCannedPromptsRequestSchema.safeParse({
        promptIds: Array.from({ length: CANNED_PROMPT_MAX_ITEMS + 1 }, () =>
          randomUUID(),
        ),
        expectedRevision: 0,
        mutationId: randomUUID(),
      }).success,
    ).toBe(false);
  });

  it("requires library positions to be contiguous and in array order", () => {
    const item = {
      id: randomUUID(),
      title: "Review",
      text: "Review this.",
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(
      cannedPromptLibrarySchema.safeParse({ revision: 1, items: [item] })
        .success,
    ).toBe(true);
    expect(
      cannedPromptLibrarySchema.safeParse({
        revision: 1,
        items: [{ ...item, position: 1 }],
      }).success,
    ).toBe(false);
    expect(
      cannedPromptLibrarySchema.safeParse({
        revision: 1,
        items: [item, { ...item, id: randomUUID(), position: 0 }],
      }).success,
    ).toBe(false);
    expect(
      cannedPromptLibrarySchema.safeParse({
        revision: 1,
        items: [item, { ...item, position: 1 }],
      }).success,
    ).toBe(false);
  });
});
