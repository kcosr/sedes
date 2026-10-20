import { describe, expect, it } from "vitest";
import type { ConversationItem, ConversationTurn } from "../../../shared/index.js";
import { createChatHistoryEntries } from "./ChatHistoryRail.js";
import { turnBookmarkPreview, turnResponseItemId } from "./turn-bookmark-presentation.js";
import { formatThreadReferenceText } from "../../../shared/thread-references.js";

const user = (id: string, text: string): ConversationItem => ({ id, turnId: "turn", revision: 1, status: "completed", kind: "user_message", content: [{ kind: "text", text: { text } }] });
const assistant = (id: string, text: string): ConversationItem => ({ id, turnId: "turn", revision: 1, status: "completed", kind: "assistant_message", markdown: { text } });
const turn = (orderedItemIds: string[]): ConversationTurn => ({ id: "turn", revision: 1, status: "completed", orderedItemIds });

describe("turn bookmark presentation", () => {
  it("keeps thread-reference metadata out of bookmark and history previews", () => {
    const references = [{ threadId: "093bf3c2-e16d-4cf2-84a3-93ef12ae1ff5", title: "Related work" }];
    for (const [body, preview] of [["Explain this change", "Explain this change"], ["", "Thread: Related work"]] as const) {
      const items = { question: user("question", formatThreadReferenceText(body, references)), reply: assistant("reply", "Reply") };
      const current = turn(Object.keys(items));
      expect(turnBookmarkPreview(current, items)?.userPreview).toBe(preview);
      expect(createChatHistoryEntries(["turn"], { turn: current }, items)[0]?.userPreview).toBe(preview);
    }
  });

  it("includes replies after steering while keeping the rail's individual message previews", () => {
    const items = { question: user("question", "Initial question"), first: assistant("first", "First **reply**"), steer: user("steer", "Also explain this"), last: assistant("last", "Second reply") };
    const current = turn(Object.keys(items));
    expect(turnBookmarkPreview(current, items)).toEqual({ userPreview: "Initial question", assistantPreview: "First reply Second reply", responseState: "responded" });
    expect(createChatHistoryEntries(["turn"], { turn: current }, items).map(entry => entry.assistantPreview)).toEqual(["First reply", "Second reply"]);
    expect(turnResponseItemId(current, items)).toBe("first");
  });

  it("keeps agent-authored reference-looking text literal in previews", () => {
    const text = formatThreadReferenceText("", [{ threadId: "093bf3c2-e16d-4cf2-84a3-93ef12ae1ff5", title: "Related work" }]);
    const message = user("callback", text);
    if (message.kind !== "user_message") throw new Error("Invalid fixture.");
    message.origin = { kind: "agent_result", callbackId: "callback", sourceThreadId: "source", sourceThreadLabel: { text: "Agent" } };
    const current = turn(["callback"]);
    expect(turnBookmarkPreview(current, { callback: message })?.userPreview).toContain("Sedes thread references selected for this message:");
    expect(createChatHistoryEntries(["turn"], { turn: current }, { callback: message })[0]?.userPreview).toContain("Sedes thread references selected for this message:");
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

  it("reuses a turn's presentation until one of its items changes", () => {
    const items = { question: user("question", "Question"), reply: assistant("reply", "Reply") };
    const current = turn(Object.keys(items));
    const preview = turnBookmarkPreview(current, items);
    const [entry] = createChatHistoryEntries(["turn"], { turn: current }, items);

    // A streamed delta elsewhere replaces the item map, not this turn's items.
    const unrelated = { ...items, other: assistant("other", "Other") };
    expect(turnBookmarkPreview(current, unrelated)).toBe(preview);
    expect(createChatHistoryEntries(["turn"], { turn: current }, unrelated)[0]).toBe(entry);

    const edited = { ...items, reply: assistant("reply", "Edited reply") };
    expect(turnBookmarkPreview(current, edited)?.assistantPreview).toBe("Edited reply");
    expect(createChatHistoryEntries(["turn"], { turn: current }, edited)[0]?.assistantPreview).toBe("Edited reply");
  });
});
