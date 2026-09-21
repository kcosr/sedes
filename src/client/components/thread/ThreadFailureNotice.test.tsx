// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationTurn, NormalizedThreadSnapshot } from "../../../shared/index.js";
import { ThreadFailureNotice, TurnFailureDetails } from "./ThreadFailureNotice.js";

afterEach(cleanup);
const turn: ConversationTurn = { id: "turn-1", revision: 1, status: "failed", orderedItemIds: [], failure: { message: { text: "Model configuration is invalid." } } };
function snapshot(runState: NormalizedThreadSnapshot["runState"], turns = [turn]): NormalizedThreadSnapshot {
  return { thread: { id: "thread-1" }, runState, orderedTurnIds: turns.map(t => t.id), turnsById: Object.fromEntries(turns.map(t => [t.id, t])) } as unknown as NormalizedThreadSnapshot;
}
describe("turn failure presentation", () => {
  it("shows persisted failure without announcing historical state and clears only when run state changes", () => {
    const { container, rerender } = render(<ThreadFailureNotice snapshot={snapshot("failed")} />);
    expect(screen.getByText("Model configuration is invalid.")).toBeVisible();
    expect(container.querySelector('[aria-live]')).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<ThreadFailureNotice snapshot={snapshot("failed")} />);
    expect(screen.getByText("Model configuration is invalid.")).toBeVisible();
    rerender(<ThreadFailureNotice snapshot={snapshot("running")} />);
    expect(screen.queryByText("Turn failed")).toBeNull();
    expect(turn.failure?.message.text).toBe("Model configuration is invalid.");
  });
  it("announces a live transition and uses the newest failed turn", () => {
    const { container, rerender } = render(<ThreadFailureNotice snapshot={snapshot("running")} />);
    const latest = { ...turn, id: "turn-2", failure: { message: { text: "Quota exceeded." } } };
    rerender(<ThreadFailureNotice snapshot={snapshot("failed", [turn, latest])} />);
    expect(container.querySelector('[aria-live]')).toHaveTextContent("Quota exceeded.");
    expect(screen.queryByText("Model configuration is invalid.")).toBeNull();
  });
  it("does not attribute a runtime failure to an older failed turn or invent a failed turn", () => {
    const { rerender } = render(<ThreadFailureNotice snapshot={snapshot("failed", [])} />);
    expect(screen.queryByText("Turn failed")).toBeNull();
    const latest: ConversationTurn = { id: "turn-2", status: "completed", revision: 1, orderedItemIds: [] };
    rerender(<ThreadFailureNotice snapshot={snapshot("failed", [turn, latest])} />);
    expect(screen.queryByText("Turn failed")).toBeNull();
    expect(screen.queryByText("Model configuration is invalid.")).toBeNull();
  });
  it("keeps history quietly inspectable as plain text without alerts", () => {
    const { container } = render(<TurnFailureDetails turn={{ ...turn, failure: { message: { text: "<script>bad model</script>" } } }} />);
    expect(screen.getByText("Failed turn details")).toBeVisible();
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
