// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationItem,
  ConversationTurn,
} from "../../../shared/index.js";
import {
  ChatHistoryRail,
  createChatHistoryEntries,
} from "./ChatHistoryRail.js";

afterEach(cleanup);

describe("chat history rail", () => {
  it("labels callback result entries with their immutable source thread", () => {
    const turnsById = {
      "turn-1": {
        id: "turn-1",
        revision: 1,
        status: "completed",
        orderedItemIds: ["user-1"],
      },
    } satisfies Record<string, ConversationTurn>;
    const itemsById = {
      "user-1": {
        id: "user-1",
        turnId: "turn-1",
        kind: "user_message",
        status: "completed",
        revision: 1,
        deliveryOperationId: "operation-1",
        origin: {
          kind: "agent_result",
          callbackId: "callback-1",
          sourceThreadId: "worker-thread",
          sourceThreadLabel: { text: "Research agent" },
        },
        content: [{ kind: "text", text: { text: "Result" } }],
      },
    } satisfies Record<string, ConversationItem>;
    const entries = createChatHistoryEntries(
      ["turn-1"],
      turnsById,
      itemsById,
    );

    expect(entries[0]?.userLabel).toBe("Agent result · Research agent");
    render(
      <ChatHistoryRail
        entries={entries}
        assistantLabel="Codex"
        onSelect={vi.fn()}
      />,
    );
    const target = screen.getByRole("button", {
      name: "Jump to conversation message 1 from Agent result · Research agent",
    });
    fireEvent.focus(target);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Agent result · Research agent: Result",
    );
  });

  it("labels persisted question responses and previews their structured answers", () => {
    const entries = createChatHistoryEntries(["turn-1"], {
      "turn-1": { id: "turn-1", revision: 1, status: "completed", orderedItemIds: ["reply-1"] },
    }, {
      "reply-1": {
        id: "reply-1", turnId: "turn-1", kind: "user_message", status: "completed", revision: 1,
        deliveryOperationId: "question-operation-1",
        origin: {
          kind: "question_response", requestId: "request-1", sourceItemId: "source-1",
          answers: [{ questionIndex: 0, question: "Which region?", answer: "eu-west-1" }],
        },
        content: [{ kind: "text", text: { text: "User responded to a question:\nQuestion: Which region?\nAnswer: eu-west-1" } }],
      },
    });
    expect(entries[0]?.userLabel).toBe("Question answered");
    expect(entries[0]?.userPreview).toBe("Which region?: eu-west-1");
    render(<ChatHistoryRail entries={entries} assistantLabel="Codex" onSelect={vi.fn()} />);
    const target = screen.getByRole("button", { name: "Jump to conversation message 1 from Question answered" });
    fireEvent.focus(target);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Question answered: Which region?: eu-west-1");
  });

  it("builds one user-and-assistant preview for every user message", () => {
    const turnsById: Record<string, ConversationTurn> = {
      "turn-1": {
        id: "turn-1",
        revision: 1,
        status: "completed",
        orderedItemIds: ["user-1", "assistant-1", "user-2", "assistant-2"],
      },
      "turn-2": {
        id: "turn-2",
        revision: 1,
        status: "in_progress",
        orderedItemIds: ["user-3"],
      },
    };
    const itemsById: Record<string, ConversationItem> = {
      "user-1": {
        id: "user-1",
        turnId: "turn-1",
        kind: "user_message",
        status: "completed",
        revision: 1,
        content: [{ kind: "text", text: { text: "  First\n  prompt  " } }],
      },
      "assistant-1": {
        id: "assistant-1",
        turnId: "turn-1",
        kind: "assistant_message",
        status: "completed",
        revision: 1,
        markdown: {
          text: "# First **assistant** [reply](https://example.com)",
        },
      },
      "user-2": {
        id: "user-2",
        turnId: "turn-1",
        kind: "user_message",
        status: "completed",
        revision: 1,
        content: [
          { kind: "skill", name: { text: "review" } },
          {
            kind: "context_excerpt",
            excerpt: {
              id: "11111111-1111-4111-8111-111111111111",
              excerpt: "const behavior = 'keep';",
              note: "Keep this behavior",
              source: {
                kind: "workspace_file",
                rootId: "primary",
                path: "src/example.ts",
                revision: "revision-1",
              },
              locator: {
                kind: "line_range",
                startLine: 1,
                endLine: 1,
              },
            },
          },
          {
            kind: "image",
            fileName: { text: "reference.png" },
            omitted: true,
          },
          {
            kind: "task_context",
            task: {
              id: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
              scope: { kind: "global" },
              title: "Include exact task identity",
              details: "Use the materialized task snapshot.",
              pinned: false,
              files: [],
              completedAt: null,
              revision: 2,
              createdAt: "2026-08-12T00:00:00.000Z",
              updatedAt: "2026-08-12T01:00:00.000Z",
            },
          },
        ],
      },
      "assistant-2": {
        id: "assistant-2",
        turnId: "turn-1",
        kind: "assistant_message",
        status: "completed",
        revision: 1,
        markdown: { text: "Second assistant reply" },
      },
      "user-3": {
        id: "user-3",
        turnId: "turn-2",
        kind: "user_message",
        status: "completed",
        revision: 1,
        content: [{ kind: "text", text: { text: "Still running" } }],
      },
    };

    expect(
      createChatHistoryEntries(["turn-1", "turn-2"], turnsById, itemsById),
    ).toEqual([
      {
        itemId: "user-1",
        turnId: "turn-1",
        userPreview: "First prompt",
        assistantPreview: "First assistant reply",
        responseState: "available",
      },
      {
        itemId: "user-2",
        turnId: "turn-1",
        userPreview:
          "/review Context from example.ts: Keep this behavior reference.png Task: Include exact task identity",
        assistantPreview: "Second assistant reply",
        responseState: "available",
      },
      {
        itemId: "user-3",
        turnId: "turn-2",
        userPreview: "Still running",
        assistantPreview: "Waiting for a response…",
        responseState: "pending",
      },
    ]);
  });

  it("exposes hover previews as keyboard-focusable jump targets", () => {
    const onSelect = vi.fn();
    render(
      <ChatHistoryRail
        entries={[
          {
            itemId: "user-1",
            turnId: "turn-1",
            userPreview: "First prompt",
            assistantPreview: "First reply",
            responseState: "available",
          },
          {
            itemId: "user-2",
            turnId: "turn-2",
            userPreview: "Second prompt",
            assistantPreview: "Second reply",
            responseState: "available",
          },
        ]}
        activeItemId="user-2"
        assistantLabel="Codex"
        onSelect={onSelect}
      />,
    );

    expect(
      screen.getByRole("navigation", { name: "Conversation history" }),
    ).toBeInTheDocument();

    const first = screen.getByRole("button", {
      name: "Jump to conversation message 1",
    });
    const second = screen.getByRole("button", {
      name: "Jump to conversation message 2",
    });
    expect(first).not.toHaveAttribute("aria-current");
    expect(second).toHaveAttribute("aria-current", "location");

    fireEvent.focus(first);
    expect(screen.getByRole("tooltip")).toHaveTextContent("First reply");
    fireEvent.click(first);
    expect(onSelect).toHaveBeenCalledWith("user-1");
  });

  it("marks only the initiating user-message rail entry for a bookmarked turn", () => {
    const turnsById = {
      "turn-1": {
        id: "turn-1",
        revision: 1,
        status: "completed",
        orderedItemIds: ["user-1", "user-2"],
      },
    } satisfies Record<string, ConversationTurn>;
    const itemsById = {
      "user-1": {
        id: "user-1",
        turnId: "turn-1",
        kind: "user_message",
        status: "completed",
        revision: 1,
        content: [{ kind: "text", text: { text: "First" } }],
      },
      "user-2": {
        id: "user-2",
        turnId: "turn-1",
        kind: "user_message",
        status: "completed",
        revision: 1,
        content: [{ kind: "text", text: { text: "Steering" } }],
      },
    } satisfies Record<string, ConversationItem>;

    const entries = createChatHistoryEntries(
      ["turn-1"],
      turnsById,
      itemsById,
      new Set(["turn-1"]),
    );
    expect(entries.map((entry) => entry.bookmarked)).toEqual([true, undefined]);

    render(
      <ChatHistoryRail
        entries={entries}
        assistantLabel="Codex"
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Jump to conversation message 1, bookmarked",
      }),
    ).toBeInTheDocument();
  });
});
