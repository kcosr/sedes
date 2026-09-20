import { describe, expect, it } from "vitest";
import {
  conversationItemSchema,
  type ConversationItem,
} from "../../src/shared/protocol/conversation.js";
import { projectConversationItemActivity } from "../../src/server/conversations/thread-activity-projection.js";

const marker = "ACTIVITY_DETAIL_MUST_NOT_REACH_BROWSER";
const reasoningSummary = "Inspecting the server projection";
const base = {
  turnId: "turn-1",
  status: "completed" as const,
  revision: 7,
  startedAt: "2026-08-14T12:00:00.000Z",
  completedAt: "2026-08-14T12:00:01.000Z",
};

function detailedItems(): ConversationItem[] {
  return [
    {
      ...base,
      id: "reasoning",
      kind: "reasoning",
      summaryParts: [{ text: reasoningSummary }],
      markdown: { text: `${marker}:reasoning` },
    },
    {
      ...base,
      id: "command",
      kind: "command",
      phase: "completed",
      command: { text: `${marker}:command` },
      cwd: { text: `/${marker}/cwd` },
      output: { text: `${marker}:output` },
      exitCode: 0,
    },
    {
      ...base,
      id: "file-read",
      kind: "file_read",
      phase: "completed",
      path: { text: `${marker}/read.txt` },
      range: { startLine: 1, endLine: 2 },
      contentPreview: { text: `${marker}:read-preview` },
    },
    {
      ...base,
      id: "file-change-diff",
      kind: "file_change",
      phase: "completed",
      operation: "edit",
      effect: "applied",
      path: { text: `${marker}/before.ts` },
      destinationPath: { text: `${marker}/after.ts` },
      diff: {
        text: {
          text: `@@ -1 +1 @@\n-${marker}:old\n+${marker}:new\n`,
        },
      },
      additions: 1,
      deletions: 1,
    },
    {
      ...base,
      id: "file-change-preview",
      kind: "file_change",
      phase: "completed",
      operation: "write",
      effect: "applied",
      path: { text: `${marker}/written.ts` },
      contentPreview: { text: `${marker}:write-preview` },
    },
    {
      ...base,
      id: "file-change-replacement",
      kind: "file_change",
      phase: "completed",
      operation: "edit",
      effect: "applied",
      path: { text: `${marker}/replacement.ts` },
      replacement: {
        before: { text: `${marker}:replacement-before` },
        after: { text: `${marker}:replacement-after` },
      },
    },
    {
      ...base,
      id: "tool",
      kind: "tool",
      phase: "completed",
      toolName: { text: `${marker}:tool-name` },
      title: { text: `${marker}:tool-title` },
      category: "other",
      arguments: { text: `${marker}:tool-arguments` },
      result: {
        content: [{ kind: "text", value: { text: `${marker}:tool-result` } }],
        isError: false,
      },
    },
    {
      ...base,
      id: "mcp",
      kind: "mcp",
      phase: "completed",
      server: { text: `${marker}:mcp-server` },
      toolName: { text: `${marker}:mcp-tool` },
      arguments: { text: `${marker}:mcp-arguments` },
      result: {
        content: [{ kind: "text", value: { text: `${marker}:mcp-result` } }],
        isError: false,
      },
    },
    {
      ...base,
      id: "web-search",
      kind: "web_search",
      phase: "failed",
      status: "failed",
      query: { text: `${marker}:query` },
      result: {
        content: [{ kind: "text", value: { text: `${marker}:search-result` } }],
        isError: true,
      },
      error: {
        category: "unavailable",
        code: "search_failed",
        message: { text: `${marker}:error` },
      },
    },
  ].map((item) => conversationItemSchema.parse(item));
}

describe("thread activity viewer projection", () => {
  it("replaces every detailed activity kind with bounded metadata only", () => {
    for (const item of detailedItems()) {
      const before = JSON.stringify(item);
      const projected = projectConversationItemActivity(item, "summary");

      expect(projected).toEqual({
        id: item.id,
        turnId: item.turnId,
        kind: "activity_summary",
        activityKind: item.kind,
        status: item.status,
        revision: item.revision,
        ...(item.kind === "reasoning"
          ? { summaryParts: [{ text: reasoningSummary }] }
          : {}),
        startedAt: item.startedAt,
        completedAt: item.completedAt,
      });
      expect(JSON.stringify(projected)).not.toContain(marker);
      expect(JSON.stringify(item)).toBe(before);
      expect(conversationItemSchema.safeParse(projected).success).toBe(true);
    }
  });

  it("copies only explicit reasoning summary parts while omitting detailed content", () => {
    const reasoning = detailedItems()[0]!;
    const projected = projectConversationItemActivity(reasoning, "summary");

    expect(projected).toMatchObject({
      kind: "activity_summary",
      activityKind: "reasoning",
      summaryParts: [{ text: reasoningSummary }],
    });
    expect(projected).not.toHaveProperty("markdown");
    expect(projected).not.toHaveProperty("error");
  });

  it("preserves full activity and non-activity items by identity", () => {
    const activity = detailedItems()[0]!;
    const message = conversationItemSchema.parse({
      ...base,
      id: "assistant",
      kind: "assistant_message",
      markdown: { text: `${marker}:ordinary-message` },
    });

    expect(projectConversationItemActivity(activity, "full")).toBe(activity);
    expect(projectConversationItemActivity(message, "summary")).toBe(message);
  });

  it("is idempotent when a summary descriptor crosses the boundary again", () => {
    const first = projectConversationItemActivity(
      detailedItems()[0]!,
      "summary",
    );
    expect(projectConversationItemActivity(first, "summary")).toBe(first);
  });
});
