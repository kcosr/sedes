// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedThreadSnapshot } from "../../../shared/index.js";
import { ReasoningSummaryStatus } from "./ReasoningSummaryStatus.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";

type StatusItem = {
  readonly id: string;
  readonly turnId: string;
  readonly kind: "reasoning" | "activity_summary";
  readonly activityKind?: "reasoning";
  readonly status: "streaming";
  readonly revision: number;
  readonly markdown?: { readonly text: string };
  readonly summaryParts?: readonly { readonly text: string }[];
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ReasoningSummaryStatus", () => {
  it("streams one part in place, crossfades a new part, and keeps its slot after fading", () => {
    const { rerender } = renderStatus(snapshot());

    rerenderStatus(rerender, snapshot(reasoning(["Preparing tests"], 1)));
    const slot = screen.getByTestId("reasoning-summary-status");
    const trigger = screen.getByRole("button", {
      name: "Show full reasoning summary",
    });
    expect(trigger).toHaveTextContent("Preparing tests");
    expect(slot).toHaveAttribute("data-visible", "true");
    const dot = slot.querySelector(".reasoning-summary-status-dot");
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute("aria-hidden", "true");

    rerenderStatus(rerender, snapshot(reasoning(["Preparing tests now"], 2)));
    expect(trigger).toHaveTextContent("Preparing tests now");
    expect(
      document.querySelector(".reasoning-summary-status-text.outgoing"),
    ).toBeNull();

    rerenderStatus(
      rerender,
      snapshot(reasoning(["Preparing tests now", "Running focused tests"], 3)),
    );
    expect(trigger).toHaveTextContent("Preparing tests now");
    expect(trigger).toHaveTextContent("Running focused tests");
    expect(
      document.querySelector(".reasoning-summary-status-text.outgoing"),
    ).not.toBeNull();

    act(() => vi.advanceTimersByTime(180));
    expect(trigger).not.toHaveTextContent("Preparing tests now");
    expect(trigger).toHaveTextContent("Running focused tests");

    act(() => vi.advanceTimersByTime(3_500));
    expect(slot).toHaveAttribute("data-visible", "false");
    expect(screen.getByTestId("reasoning-summary-status")).toBeInTheDocument();

    rerenderStatus(rerender, terminalSnapshot());
    expect(screen.queryByTestId("reasoning-summary-status")).toBeNull();
  });

  it("does not replay an initial or hidden summary", () => {
    const { rerender } = renderStatus(
      snapshot(reasoning(["Already in snapshot"], 1)),
    );
    expect(screen.queryByTestId("reasoning-summary-status")).toBeNull();

    rerenderStatus(
      rerender,
      snapshot(reasoning(["Already in snapshot, now live"], 2)),
    );
    expect(screen.getByRole("button")).toHaveTextContent(
      "Already in snapshot, now live",
    );

    rerenderStatus(rerender, snapshot(reasoning(["Updated while in TUI"], 3)), {
      chatVisible: false,
    });
    expect(screen.queryByTestId("reasoning-summary-status")).toBeNull();

    rerenderStatus(rerender, snapshot(reasoning(["Updated while in TUI"], 3)));
    expect(screen.queryByTestId("reasoning-summary-status")).toBeNull();

    rerenderStatus(rerender, snapshot(reasoning(["Fresh Chat update"], 4)));
    expect(screen.getByRole("button")).toHaveTextContent("Fresh Chat update");

    rerenderStatus(rerender, snapshot(reasoning(["Historical update"], 5)), {
      livePresentation: false,
    });
    expect(screen.queryByTestId("reasoning-summary-status")).toBeNull();

    rerenderStatus(rerender, snapshot(reasoning(["Interaction update"], 6)), {
      interactionTakeover: true,
    });
    expect(screen.queryByTestId("reasoning-summary-status")).toBeNull();

    rerenderStatus(rerender, snapshot(reasoning(["Interaction update"], 6)));
    expect(screen.queryByTestId("reasoning-summary-status")).toBeNull();
  });

  it("accepts summary-mode reasoning descriptors and never falls back to markdown", () => {
    const { rerender } = renderStatus(snapshot());
    rerenderStatus(
      rerender,
      snapshot(activitySummary(["Checking the client"], 1)),
    );
    expect(screen.getByRole("button")).toHaveTextContent("Checking the client");

    rerenderStatus(
      rerender,
      snapshot(reasoning(undefined, 2, "Hidden raw reasoning")),
    );
    expect(screen.getByRole("button")).not.toHaveTextContent(
      "Hidden raw reasoning",
    );
  });

  it("clears a claimed slot when a new active turn has no summary", () => {
    const { rerender } = renderStatus(snapshot());
    rerenderStatus(rerender, snapshot(reasoning(["Finishing turn one"], 1)));
    expect(screen.getByTestId("reasoning-summary-status")).toBeInTheDocument();

    rerenderStatus(rerender, nextTurnSnapshot());
    expect(screen.queryByTestId("reasoning-summary-status")).toBeNull();
  });

  it("bounds normalization work for a pathological unmatched-backtick summary", () => {
    const pathologicalSummary = `\`${"a".repeat(131_071)}`;
    const { rerender } = renderStatus(snapshot());

    rerenderStatus(rerender, snapshot(reasoning([pathologicalSummary], 1)));

    const compact = screen.getByRole("button", {
      name: "Show full reasoning summary",
    }).textContent;
    expect(compact).toBeDefined();
    expect([...(compact ?? "")].length).toBeLessThanOrEqual(160);
    expect(compact).toMatch(/…$/);
  });

  it("expands only the full summary, pauses dismissal, and politely announces after a debounce", () => {
    const fullSummary = `**A long** summary with \`code\`, [docs](https://example.com), and file_name plus ${"detail ".repeat(40)}the final phrase`;
    const { rerender } = renderStatus(snapshot());
    rerenderStatus(rerender, snapshot(reasoning([fullSummary], 1)));

    const trigger = screen.getByRole("button", {
      name: "Show full reasoning summary",
    });
    expect(trigger).toHaveTextContent(
      "A long summary with code, docs, and file_name plus",
    );
    expect(trigger).not.toHaveTextContent("**");
    expect(trigger).not.toHaveTextContent("https://example.com");
    const visibleSummary = trigger.textContent ?? "";
    expect([...visibleSummary]).toHaveLength(160);
    expect(visibleSummary).toMatch(/…$/);

    act(() => vi.advanceTimersByTime(649));
    expect(screen.getByRole("status")).toHaveTextContent("");
    act(() => vi.advanceTimersByTime(1));
    const announcement = screen.getByRole("status").textContent ?? "";
    expect([...announcement]).toHaveLength(160);
    expect(announcement).toMatch(
      /^A long summary with code, docs, and file_name plus/,
    );
    expect(announcement).toMatch(/…$/);
    expect(announcement).not.toContain("**");
    expect(announcement).not.toContain("https://example.com");

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Reasoning summary" });
    expect(dialog).toBe(screen.getByTestId("reasoning-summary-popover"));
    expect(dialog).toHaveTextContent("the final phrase");
    expect(dialog.querySelector("strong")).toHaveTextContent("A long");
    expect(dialog.querySelector("code")).toHaveTextContent("code");
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute(
      "href",
      "https://example.com/",
    );
    expect(dialog).not.toHaveTextContent(
      "RAW_REASONING_DETAIL_MUST_NOT_REACH_SUMMARY_CLIENT",
    );
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByTestId("reasoning-summary-status")).toHaveAttribute(
      "data-visible",
      "true",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.blur(
      screen.getByRole("button", { name: "Show full reasoning summary" }),
      { relatedTarget: document.body },
    );
    act(() => vi.advanceTimersByTime(3_500));
    expect(screen.getByTestId("reasoning-summary-status")).toHaveAttribute(
      "data-visible",
      "false",
    );
  });
});

function renderStatus(
  value: NormalizedThreadSnapshot,
  overrides: Partial<StatusProps> = {},
) {
  return render(<Status snapshot={value} {...overrides} />);
}

function rerenderStatus(
  rerender: ReturnType<typeof render>["rerender"],
  value: NormalizedThreadSnapshot,
  overrides: Partial<StatusProps> = {},
): void {
  rerender(<Status snapshot={value} {...overrides} />);
}

type StatusProps = {
  readonly snapshot: NormalizedThreadSnapshot;
  readonly chatVisible?: boolean;
  readonly livePresentation?: boolean;
  readonly interactionTakeover?: boolean;
};

function Status({
  snapshot: value,
  chatVisible = true,
  livePresentation = true,
  interactionTakeover = false,
}: StatusProps): React.JSX.Element {
  return (
    <ChatViewVisibilityContext.Provider value={chatVisible}>
      <ReasoningSummaryStatus
        snapshot={value}
        livePresentation={livePresentation}
        interactionTakeover={interactionTakeover}
      />
    </ChatViewVisibilityContext.Provider>
  );
}

function snapshot(item?: StatusItem): NormalizedThreadSnapshot {
  return {
    runState: "running",
    activeTurnId: "turn-1",
    orderedTurnIds: ["turn-1"],
    turnsById: {
      "turn-1": {
        id: "turn-1",
        revision: item?.revision ?? 0,
        status: "in_progress",
        orderedItemIds: item ? [item.id] : [],
      },
    },
    itemsById: item ? { [item.id]: item } : {},
  } as unknown as NormalizedThreadSnapshot;
}

function terminalSnapshot(): NormalizedThreadSnapshot {
  return {
    ...snapshot(reasoning(["Finished"], 4)),
    runState: "idle",
    activeTurnId: undefined,
    turnsById: {
      "turn-1": {
        id: "turn-1",
        revision: 4,
        status: "completed",
        orderedItemIds: ["reasoning-1"],
      },
    },
  } as unknown as NormalizedThreadSnapshot;
}

function nextTurnSnapshot(): NormalizedThreadSnapshot {
  return {
    ...snapshot(),
    activeTurnId: "turn-2",
    orderedTurnIds: ["turn-1", "turn-2"],
    turnsById: {
      "turn-1": {
        id: "turn-1",
        revision: 2,
        status: "completed",
        orderedItemIds: ["reasoning-1"],
      },
      "turn-2": {
        id: "turn-2",
        revision: 1,
        status: "in_progress",
        orderedItemIds: [],
      },
    },
    itemsById: {
      "reasoning-1": reasoning(["Finishing turn one"], 1),
    },
  } as unknown as NormalizedThreadSnapshot;
}

function reasoning(
  parts: readonly string[] | undefined,
  revision: number,
  markdown = "",
): StatusItem {
  return {
    id: "reasoning-1",
    turnId: "turn-1",
    kind: "reasoning",
    status: "streaming",
    revision,
    markdown: { text: markdown },
    ...(parts ? { summaryParts: parts.map((text) => ({ text })) } : {}),
  };
}

function activitySummary(
  parts: readonly string[],
  revision: number,
): StatusItem {
  return {
    id: "reasoning-1",
    turnId: "turn-1",
    kind: "activity_summary",
    activityKind: "reasoning",
    status: "streaming",
    revision,
    summaryParts: parts.map((text) => ({ text })),
  };
}
