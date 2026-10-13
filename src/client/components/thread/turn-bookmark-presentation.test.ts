import { describe, expect, it } from "vitest";
import type { ConversationItem, ConversationTurn } from "../../../shared/index.js";
import { createChatHistoryEntries } from "./ChatHistoryRail.js";
import { turnBookmarkPreview, turnResponseItemId } from "./turn-bookmark-presentation.js";

const user = (id: string, text: string): ConversationItem => ({ id, turnId: "turn", revision: 1, status: "completed", kind: "user_message", content: [{ kind: "text", text: { text } }] });
const assistant = (id: string, text: string): ConversationItem => ({ id, turnId: "turn", revision: 1, status: "completed", kind: "assistant_message", markdown: { text } });
const turn = (orderedItemIds: string[]): ConversationTurn => ({ id: "turn", revision: 1, status: "completed", orderedItemIds });

describe("turn bookmark presentation", () => {
  it("includes replies after steering while keeping the rail's individual message previews", () => {
    const items = { question: user("question", "Initial question"), first: assistant("first", "First **reply**"), steer: user("steer", "Also explain this"), last: assistant("last", "Second reply") };
    const current = turn(Object.keys(items));
    expect(turnBookmarkPreview(current, items)).toEqual({ userPreview: "Initial question", assistantPreview: "First reply Second reply", responseState: "responded" });
    expect(createChatHistoryEntries(["turn"], { turn: current }, items).map(entry => entry.assistantPreview)).toEqual(["First reply", "Second reply"]);
    expect(turnResponseItemId(current, items)).toBe("first");
  });

  it("skips an empty assistant placeholder for both text and activity targets", () => {
    const items: Record<string, ConversationItem> = { question: user("question", "Question"), empty: assistant("empty", " "), activity: { id: "activity", turnId: "turn", revision: 1, kind: "reasoning", status: "completed", markdown: { text: "Thinking" } } };
    expect(turnResponseItemId(turn(Object.keys(items)), items)).toBe("activity");
    items.reply = assistant("reply", "Reply");
    expect(turnResponseItemId(turn(Object.keys(items)), items)).toBe("reply");
    expect(turnResponseItemId(turn(["question", "empty"]), items)).toBeUndefined();
    expect(turnBookmarkPreview(turn(["question", "empty"]), items)).toEqual({ userPreview: "Question", assistantPreview: null, responseState: "no_response" });
  });

  it("does not offer a bookmark for an optimistic or provider-only turn without a durable user message", () => {
    expect(turnBookmarkPreview(turn(["reply"]), { reply: assistant("reply", "Reply") })).toBeUndefined();
  });
});
