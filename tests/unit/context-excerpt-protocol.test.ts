import { describe, expect, it } from "vitest";
import {
  backendItemSchema,
  contextExcerptArraySchema,
  contextExcerptSchema,
  MAXIMUM_COMPOSER_INPUT_BYTES,
  MAXIMUM_CONTEXT_EXCERPT_BYTES,
  normalizedDraftSchema,
  normalizedStashSchema,
  saveDraftRequestSchema,
  userMessageItemSchema,
  workspaceDiffContextSourceSchema,
} from "../../src/shared/index.js";

const id = "10000000-0000-4000-8000-000000000001";

const excerpt = {
  id,
  excerpt: "const answer = 42;",
  note: "Explain this value.",
  source: {
    kind: "workspace_file" as const,
    rootId: "primary" as const,
    path: "src/example.ts",
    revision: "revision-1",
  },
  locator: {
    kind: "line_range" as const,
    startLine: 10,
    endLine: 10,
  },
};

describe("context excerpt protocol", () => {
  it("requires display paths on workspace diff source provenance", () => {
    expect(
      workspaceDiffContextSourceSchema.safeParse({
        kind: "workspace_diff",
        workspaceId: id,
        rootId: "primary",
        comparisonId: "comparison-1",
        comparisonFingerprint: "fingerprint-1234567890",
        fileId: "changed-file-1",
      }).success,
    ).toBe(false);
  });

  it("accepts strict file, diff, Markdown, and conversation provenance", () => {
    expect(contextExcerptSchema.parse(excerpt)).toEqual(excerpt);
    expect(
      contextExcerptSchema.parse({
        ...excerpt,
        source: {
          kind: "conversation_diff",
          itemId: "item-1",
          itemRevision: 3,
          path: "/workspace/old.ts",
          destinationPath: "/workspace/new.ts",
        },
        locator: {
          kind: "diff_line_range",
          start: { side: "old", line: 4 },
          end: { side: "new", line: 8 },
        },
      }),
    ).toMatchObject({ source: { kind: "conversation_diff" } });
    expect(
      contextExcerptSchema.parse({
        ...excerpt,
        source: {
          kind: "workspace_diff",
          workspaceId: id,
          rootId: "primary",
          comparisonId: "comparison-1",
          comparisonFingerprint: "fingerprint-1234567890",
          fileId: "changed-file-1",
          oldPath: "src/old.ts",
          newPath: "src/new.ts",
        },
        locator: {
          kind: "diff_line_range",
          start: { side: "old", line: 4 },
          end: { side: "new", line: 8 },
        },
      }),
    ).toMatchObject({
      source: {
        kind: "workspace_diff",
        comparisonId: "comparison-1",
        fileId: "changed-file-1",
      },
      locator: {
        kind: "diff_line_range",
        start: { side: "old", line: 4 },
        end: { side: "new", line: 8 },
      },
    });
    expect(
      contextExcerptSchema.parse({
        ...excerpt,
        locator: {
          kind: "text_quote",
          prefix: "Before ",
          suffix: " after",
          headingTrail: ["Design", "Protocol"],
          sourceStartLine: 20,
          sourceEndLine: 21,
        },
      }),
    ).toMatchObject({ locator: { kind: "text_quote" } });
    expect(
      contextExcerptSchema.parse({
        ...excerpt,
        source: {
          kind: "conversation_message",
          itemId: "normalized-message-item-1",
          itemRevision: 7,
        },
        locator: {
          kind: "text_quote",
          prefix: "Before ",
          suffix: " after",
        },
      }),
    ).toMatchObject({
      source: {
        kind: "conversation_message",
        itemId: "normalized-message-item-1",
        itemRevision: 7,
      },
      locator: { kind: "text_quote" },
    });
  });

  it("enforces UTF-8 byte limits and ordered unique identities", () => {
    const multibyte = "😀".repeat(MAXIMUM_CONTEXT_EXCERPT_BYTES / 4);
    expect(
      contextExcerptSchema.safeParse({ ...excerpt, excerpt: multibyte })
        .success,
    ).toBe(true);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        excerpt: `${multibyte}😀`,
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        source: {
          kind: "workspace_diff",
          workspaceId: id,
          rootId: "primary",
          comparisonId: "comparison-1",
          comparisonFingerprint: "fingerprint-1234567890",
          fileId: "changed-file-1",
        },
        locator: {
          kind: "diff_line_range",
          start: { side: "new", line: 1 },
          end: { side: "new", line: 1 },
        },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        source: {
          kind: "workspace_diff",
          workspaceId: id,
          rootId: "primary",
          comparisonId: "comparison-1",
          comparisonFingerprint: "fingerprint-1234567890",
          fileId: "changed-file-1",
          newPath: "src/new.ts",
          revisionSelector: "feature~3",
        },
        locator: {
          kind: "diff_line_range",
          start: { side: "new", line: 1 },
          end: { side: "new", line: 1 },
        },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        source: {
          kind: "workspace_diff",
          workspaceId: id,
          rootId: "primary",
          comparisonId: "comparison-1",
          comparisonFingerprint: "fingerprint-1234567890",
          fileId: "changed-file-1",
          newPath: "src/new.ts",
        },
        locator: { kind: "line_range", startLine: 1, endLine: 1 },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptArraySchema.safeParse([excerpt, excerpt]).success,
    ).toBe(false);
  });

  it("rejects contradictory locators and non-normalized file paths", () => {
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        locator: { kind: "line_range", startLine: 4, endLine: 3 },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        source: { ...excerpt.source, path: "../outside.ts" },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        locator: {
          kind: "text_quote",
          sourceStartLine: 2,
        },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        source: {
          kind: "conversation_diff",
          itemId: "item-1",
          itemRevision: 3,
          path: "src/example.ts",
        },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        source: {
          kind: "conversation_message",
          itemId: "normalized-message-item-1",
          itemRevision: 7,
        },
        locator: { kind: "line_range", startLine: 1, endLine: 1 },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        source: {
          kind: "conversation_message",
          itemId: "normalized-message-item-1",
          itemRevision: 7,
          providerMessageId: "must-stay-private",
        },
        locator: { kind: "text_quote" },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        source: {
          kind: "conversation_message",
          itemId: "normalized-message-item-1",
          itemRevision: -1,
        },
        locator: { kind: "text_quote" },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        source: {
          kind: "conversation_message",
          itemId: "x".repeat(161),
          itemRevision: 7,
        },
        locator: { kind: "text_quote" },
      }).success,
    ).toBe(false);
    expect(
      contextExcerptSchema.safeParse({
        ...excerpt,
        source: {
          kind: "conversation_message",
          itemId: "normalized-message-item-1",
          itemRevision: Number.MAX_SAFE_INTEGER + 1,
        },
        locator: { kind: "text_quote" },
      }).success,
    ).toBe(false);
  });

  it("requires excerpts on drafts, stashes, and save requests", () => {
    expect(
      normalizedDraftSchema.safeParse({ text: "Prompt", revision: 0 }).success,
    ).toBe(false);
    expect(
      normalizedDraftSchema.parse({
        text: "Prompt",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 0,
      }),
    ).toMatchObject({ contextExcerpts: [] });
    expect(
      normalizedStashSchema.safeParse({
        id: "stash-1",
        text: "Prompt",
        createdAt: "2026-08-07T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      saveDraftRequestSchema.safeParse({
        text: "Prompt",
        expectedRevision: 0,
      }).success,
    ).toBe(false);
  });

  it("enforces the aggregate composer byte budget", () => {
    expect(
      saveDraftRequestSchema.safeParse({
        text: "a".repeat(
          MAXIMUM_COMPOSER_INPUT_BYTES - MAXIMUM_CONTEXT_EXCERPT_BYTES + 1,
        ),
        contextExcerpts: [
          { ...excerpt, excerpt: "b".repeat(MAXIMUM_CONTEXT_EXCERPT_BYTES) },
        ],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: 0,
      }).success,
    ).toBe(false);
  });

  it("round-trips context parts through normalized and backend messages", () => {
    const normalized = {
      id: "item-1",
      turnId: "turn-1",
      status: "completed" as const,
      revision: 0,
      kind: "user_message" as const,
      deliveryOperationId: "delivery-operation-1",
      content: [{ kind: "context_excerpt" as const, excerpt }],
    };
    expect(userMessageItemSchema.parse(normalized)).toEqual(normalized);
    expect(
      backendItemSchema.parse({
        backendItemId: "backend-item-1",
        backendTurnId: "backend-turn-1",
        status: "completed",
        sourceOrder: 0,
        semanticKind: "user_message",
        deliveryOperationId: normalized.deliveryOperationId,
        content: normalized.content,
      }),
    ).toMatchObject({
      deliveryOperationId: normalized.deliveryOperationId,
      content: normalized.content,
    });
    expect(
      userMessageItemSchema.safeParse({
        ...normalized,
        content: [
          { kind: "context_excerpt", excerpt },
          { kind: "context_excerpt", excerpt },
        ],
      }).success,
    ).toBe(false);
  });
});
