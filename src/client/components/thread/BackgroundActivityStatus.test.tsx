// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedThreadSnapshot } from "../../../shared/index.js";
import { BackgroundActivityStatus } from "./BackgroundActivityStatus.js";
import { ReasoningSummaryStatus } from "./ReasoningSummaryStatus.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";

type Activity = NonNullable<NormalizedThreadSnapshot["backgroundActivity"]>;
const empty: Activity = { state: "known", agents: 0, commands: 0, other: 0 };
const agent: Activity = { ...empty, agents: 1, description: { text: "Sleep 20 seconds test" } };

afterEach(cleanup);

function snapshot(activity?: Activity, runState: NormalizedThreadSnapshot["runState"] = "idle"): NormalizedThreadSnapshot {
  return {
    thread: { id: "thread-one" },
    runState,
    backgroundActivity: activity,
    orderedTurnIds: [],
    turnsById: {},
    itemsById: {},
  } as unknown as NormalizedThreadSnapshot;
}

function status(value: NormalizedThreadSnapshot): React.JSX.Element {
  return <BackgroundActivityStatus current snapshot={value} livePresentation interactionTakeover={false} />;
}

describe("BackgroundActivityStatus", () => {
  it("keeps real work visible after the main turn settles and clears only on an empty inventory", () => {
    const { rerender } = render(status(snapshot(agent, "running")));
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for subagent · Sleep 20 seconds test");
    rerender(status(snapshot(agent)));
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for subagent · Sleep 20 seconds test");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(status(snapshot(empty)));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("describes commands and mixed work without exposing native ids", () => {
    const { rerender } = render(status(snapshot({ ...empty, commands: 1, description: { text: "Run tests\nnow" } })));
    expect(screen.getByRole("status")).toHaveTextContent("Background command running · Run tests now");
    rerender(status(snapshot({ ...empty, agents: 2, commands: 1, other: 1 })));
    expect(screen.getByRole("status")).toHaveTextContent("Background work · 2 subagents, 1 command, 1 other task");
  });

  it.each(["idle", "disconnected", "reconciling"] as const)("does not present uncertain counts as running in %s", (runState) => {
    render(status(snapshot({ ...agent, state: "unknown" }, runState)));
    expect(screen.getByTestId("background-activity-status")).toHaveAttribute("data-state", "unknown");
    expect(screen.getByRole("status")).toHaveTextContent(runState === "reconciling" ? "Checking background work…" : "Background work status unavailable");
    expect(screen.getByRole("status")).not.toHaveTextContent("Sleep 20 seconds");
  });

  it.each(["disconnected", "reconciling"] as const)("does not claim last-known work is still running when %s", (runState) => {
    render(status(snapshot(agent, runState)));
    expect(screen.getByTestId("background-activity-status")).toHaveAttribute("data-state", "unknown");
  });

  it("marks retained activity uncertain while the browser catches up", () => {
    const { rerender } = render(status(snapshot(agent)));
    rerender(<BackgroundActivityStatus current={false} snapshot={snapshot(agent)} livePresentation interactionTakeover={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking background work…");
    expect(screen.getByTestId("background-activity-status")).toHaveAttribute("data-state", "unknown");
    rerender(status(snapshot(empty)));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not retain the old thread's work when the selected snapshot changes", () => {
    const { rerender } = render(status(snapshot(agent)));
    expect(screen.getByRole("status")).toBeVisible();
    rerender(status({ ...snapshot(), thread: { ...snapshot().thread, id: "thread-two" } }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not show unsupported work or empty known inventory", () => {
    const { rerender } = render(status(snapshot()));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(status(snapshot(empty)));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides during historical browsing, interaction takeover, and terminal view", () => {
    const value = snapshot(agent);
    const { rerender } = render(<BackgroundActivityStatus current snapshot={value} livePresentation={false} interactionTakeover={false} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<BackgroundActivityStatus current snapshot={value} livePresentation interactionTakeover />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<ChatViewVisibilityContext.Provider value={false}>{status(value)}</ChatViewVisibilityContext.Provider>);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(status(value));
    expect(screen.getByRole("status")).toBeVisible();
  });

  it("coexists with new reasoning and remains visible when that turn finishes", () => {
    const value = {
      ...snapshot(agent, "running"),
      activeTurnId: "turn-1",
      turnsById: { "turn-1": { id: "turn-1", revision: 0, status: "in_progress", orderedItemIds: [] } },
    } as NormalizedThreadSnapshot;
    const statuses = (next: NormalizedThreadSnapshot) => <>
      <ReasoningSummaryStatus snapshot={next} livePresentation interactionTakeover={false} />
      {status(next)}
    </>;
    const { rerender } = render(statuses(value));
    const thinking = {
      ...value,
      turnsById: { "turn-1": { id: "turn-1", revision: 1, status: "in_progress", orderedItemIds: ["reasoning-1"] } },
      itemsById: { "reasoning-1": { id: "reasoning-1", turnId: "turn-1", kind: "reasoning", revision: 1, status: "streaming", summaryParts: [{ text: "Preparing follow-up" }] } },
    } as unknown as NormalizedThreadSnapshot;
    rerender(statuses(thinking));
    expect(screen.getByTestId("reasoning-summary-status")).toHaveTextContent("Preparing follow-up");
    expect(screen.getByTestId("background-activity-status")).toHaveTextContent("Waiting for subagent");
    rerender(statuses(snapshot(agent)));
    expect(screen.queryByTestId("reasoning-summary-status")).toBeNull();
    expect(screen.getByTestId("background-activity-status")).toBeVisible();
  });
});
