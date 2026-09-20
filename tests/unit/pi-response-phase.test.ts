import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiHistoryProjector } from "../../src/server/backends/pi/pi-history-projector.js";

function entry(id: string, message: unknown): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "2026-09-17T00:00:00.000Z", message } as SessionEntry;
}

const text = (value: string) => ({ type: "text", text: value });
const user = entry("user", { role: "user", content: [text("Question")] });
function assistant(id: string, stopReason: string | undefined, content: unknown[]) {
  return entry(id, { role: "assistant", stopReason, content });
}
function phases(branch: SessionEntry[], running = false) {
  return Object.values(new PiHistoryProjector({ runState: running ? "running" : "idle" }).project(branch).snapshot.itemsById)
    .filter(item => item.semanticKind === "assistant_message")
    .map(item => [item.markdown.text, item.responsePhase]);
}

describe("Pi authoritative assistant response phases", () => {
  it.each(["stop", "length"])("groups every text block of the terminal native %s message", reason => {
    expect(phases([
      user,
      assistant("interim", "stop", [text("Interim")]),
      assistant("final", reason, [text("Final first"), { type: "thinking", thinking: "private" }, text("Final second")]),
    ])).toEqual([["Interim", "provisional"], ["Final first", "final"], ["Final second", "final"]]);
  });

  it("keeps terminal candidates unclassified while a turn is still running", () => {
    expect(phases([user, assistant("candidate", "stop", [text("Pending settlement")])], true))
      .toEqual([["Pending settlement", "unclassified"]]);
  });

  it.each([undefined, "error", "aborted", "toolUse"])("does not guess final text for stop reason %s", reason => {
    expect(phases([user, assistant("unknown", reason, [text("Uncertain")])]))
      .toEqual([["Uncertain", "unclassified"]]);
  });

  it("classifies native tool-call text as provisional without inventing a final answer", () => {
    expect(phases([user, assistant("tool", "toolUse", [
      text("Checking"), { type: "toolCall", id: "read-1", name: "read", arguments: {} },
    ])])).toEqual([["Checking", "provisional"]]);
  });

  it("does not reuse an earlier terminal candidate after another assistant message", () => {
    expect(phases([user, assistant("candidate", "stop", [text("Earlier")]), assistant("unknown", undefined, [text("Later")])]))
      .toEqual([["Earlier", "unclassified"], ["Later", "unclassified"]]);
  });
});
