// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import { shortAutomationTime } from "../../lib/time.js";
import {
  FlatThreadRow,
  flatRowGlyphKind,
  futureTimeLabel,
} from "./FlatThreadRow.js";

type ThreadAutomation = NonNullable<
  NormalizedApplicationThreadSummary["automation"]
>;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeThread(
  overrides: Partial<NormalizedApplicationThreadSummary> = {},
): NormalizedApplicationThreadSummary {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: "Fix flaky retries" },
    backend: { label: { text: "Pi" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 0,
    pinned: false,
    pinRevision: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    threadRevision: 0,
    runState: "idle",
    queuedInputCount: 0,
    stashedPromptCount: 0,
    pendingQuestionCount: 0,
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    available: true,
    lastActivityAt: iso(-2 * 3_600_000),
    stateChangedAt: iso(-2 * 3_600_000),
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
    ...overrides,
    preferredWorktreeRevision: overrides.preferredWorktreeRevision ?? 0,
    preferredWorktree: overrides.preferredWorktree ?? null,
  };
}

function makeAutomation(
  overrides: Partial<ThreadAutomation> = {},
): ThreadAutomation {
  return {
    status: "enabled",
    runMode: "same_thread",
    scheduleKind: "interval",
    revision: 0,
    hasPrecheck: false,
    ...overrides,
  };
}

function attention(
  overrides: Partial<NormalizedApplicationThreadSummary["attention"]>,
): NormalizedApplicationThreadSummary["attention"] {
  return {
    wake: false,
    automationContext: null,
    unseenCompletion: false,
    queueFailure: false,
    ...overrides,
  };
}

function chipsOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".flat-row-chip")].map(
    (chip) => chip.getAttribute("data-chip") ?? "",
  );
}

function indicatorsOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".flat-row-indicator")].map(
    (indicator) => indicator.getAttribute("data-indicator") ?? "",
  );
}

afterEach(cleanup);

describe("terminal inventory", () => {
  it("shows retained and running counts without attaching a terminal", () => {
    render(
      <FlatThreadRow
        thread={makeThread({
          terminalSummary: { runningCount: 1, retainedCount: 3 },
        })}
        density="compact"
        showBackendBrand={false}
      />,
    );

    const indicator = screen.getByRole("img", {
      name: "1 running terminal, 3 retained",
    });
    expect(indicator.querySelector(".flat-row-indicator-count")).toBeNull();
  });
});

describe("flatRowGlyphKind ladder", () => {
  it("failed beats waiting, snoozed, and automation", () => {
    expect(
      flatRowGlyphKind(
        makeThread({
          runState: "failed",
          inventoryState: "snoozed",
          snoozedUntil: iso(3_600_000),
          automation: makeAutomation({ nextRunAt: iso(3_600_000) }),
        }),
      ),
    ).toBe("failed");
  });

  it("start-failed counts as failed", () => {
    expect(
      flatRowGlyphKind(
        makeThread({
          backingState: "creation_unknown",
          inventoryState: "snoozed",
        }),
      ),
    ).toBe("failed");
  });

  it("waiting beats running-adjacent states, draft, snoozed, and automation", () => {
    expect(
      flatRowGlyphKind(
        makeThread({
          runState: "waiting_for_input",
          backingState: "unbound",
          inventoryState: "snoozed",
          automation: makeAutomation(),
        }),
      ),
    ).toBe("waiting");
    expect(
      flatRowGlyphKind(makeThread({ runState: "waiting_for_approval" })),
    ).toBe("waiting");
  });

  it("running beats draft, snoozed, and automation", () => {
    expect(
      flatRowGlyphKind(
        makeThread({
          runState: "running",
          inventoryState: "snoozed",
          automation: makeAutomation(),
        }),
      ),
    ).toBe("running");
    expect(flatRowGlyphKind(makeThread({ backingState: "creating" }))).toBe(
      "running",
    );
  });

  it("reconciling sits in the running branch and renders the spinner", () => {
    expect(flatRowGlyphKind(makeThread({ runState: "reconciling" }))).toBe(
      "running",
    );
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({ runState: "reconciling" })}
        density="compact"
      />,
    );
    expect(container.querySelector(".flat-row-glyph > span")).toHaveClass(
      "comet-spinner",
      "flat-row-spin",
    );
  });

  it("draft beats snoozed and automation", () => {
    expect(
      flatRowGlyphKind(
        makeThread({
          backingState: "unbound",
          inventoryState: "snoozed",
          automation: makeAutomation(),
        }),
      ),
    ).toBe("draft");
  });

  it("snoozed (Moon) beats automation (Repeat)", () => {
    expect(
      flatRowGlyphKind(
        makeThread({
          inventoryState: "snoozed",
          snoozedUntil: iso(3_600_000),
          automation: makeAutomation({ nextRunAt: iso(3_600_000) }),
        }),
      ),
    ).toBe("snoozed");
  });

  it("automation beats settled; settled beats idle", () => {
    expect(
      flatRowGlyphKind(
        makeThread({ inventoryState: "settled", automation: makeAutomation() }),
      ),
    ).toBe("automation");
    expect(flatRowGlyphKind(makeThread({ inventoryState: "settled" }))).toBe(
      "settled",
    );
  });

  it("idle is the floor, hollow when disconnected", () => {
    expect(flatRowGlyphKind(makeThread())).toBe("idle");
    expect(flatRowGlyphKind(makeThread({ runState: "disconnected" }))).toBe(
      "disconnected",
    );
  });

  it("renders the glyph with its state color hook and accessible name", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({ runState: "failed" })}
        density="compact"
      />,
    );
    const glyph = container.querySelector(".flat-row-glyph");
    expect(glyph).toHaveAttribute("data-glyph", "failed");
    expect(screen.getByRole("img", { name: "Failed" })).toBe(glyph);
  });

  it("renders the running spinner with the reduced-motion-aware class", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({ runState: "running" })}
        density="compact"
      />,
    );
    expect(container.querySelector(".flat-row-glyph > span")).toHaveClass(
      "comet-spinner",
      "flat-row-spin",
    );
  });

  it("reserves an empty status slot without rendering an idle marker", () => {
    const { container } = render(
      <FlatThreadRow
        thread={makeThread()}
        showBackendBrand
        density="compact"
      />,
    );
    const glyph = container.querySelector(".flat-row-glyph");
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph).toBeEmptyDOMElement();
  });

  it("renders the backend brand mark only when showBackendBrand is set", () => {
    const shown = render(
      <FlatThreadRow
        thread={makeThread()}
        showBackendBrand
        density="compact"
      />,
    );
    const brand = shown.container.querySelector(".flat-row-brand");
    expect(brand).not.toBeNull();
    expect(brand).toHaveAttribute("title", "Pi");
    // The mark is meaningful, so it carries an accessible name like the
    // sibling glyph and badges; the inner SVG stays aria-hidden.
    expect(screen.getByRole("img", { name: "Pi" })).toBe(brand);
    expect(brand!.querySelector("svg")).not.toBeNull();
    shown.unmount();

    const hidden = render(
      <FlatThreadRow
        thread={makeThread()}
        showBackendBrand={false}
        density="compact"
      />,
    );
    expect(hidden.container.querySelector(".flat-row-brand")).toBeNull();
  });

  it("renders the Claude backend mark from normalized thread identity", () => {
    const { container } = render(
      <FlatThreadRow
        thread={makeThread({
          backend: { label: { text: "Claude" }, brand: "claude" },
        })}
        showBackendBrand
        density="compact"
      />,
    );

    expect(screen.getByRole("img", { name: "Claude" })).toBeTruthy();
    const mark = container.querySelector(".flat-row-brand svg");
    expect(mark).toHaveAttribute("viewBox", "0 0 256 257");
    expect(mark).toHaveAttribute("fill", "#D97757");
  });

  it("keeps unseen as title weight when another status owns the glyph", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          runState: "running",
          attention: attention({ unseenCompletion: true }),
        })}
        density="compact"
      />,
    );
    expect(container.querySelector(".flat-row")).toHaveClass("flat-row-unseen");
    expect(container.querySelector(".flat-row-glyph")).toHaveAttribute(
      "data-glyph",
      "running",
    );
    expect(container.querySelector(".flat-row-unseen-dot")).toBeNull();
  });
});

describe("status badges and wake indicator", () => {
  const busy = makeThread({
    queuedInputCount: 2,
    attention: attention({ queueFailure: true, wake: true }),
  });
  const fork = { descendantCount: 3, isChild: false };

  it("identifies a failed queued input instead of showing a generic warning", () => {
    render(
      <FlatThreadRow
        thread={makeThread({
          attention: attention({ queueFailure: true }),
        })}
        showBackendBrand
        density="compact"
      />,
    );
    expect(
      screen.getByRole("img", { name: "Queued input failed" }),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Needs attention" })).toBeNull();
  });

  it("shows stash and bookmark overlays after fork and tasks, and omits zero", () => {
    const { rerender } = render(
      <FlatThreadRow
        thread={makeThread({ stashedPromptCount: 2, turnBookmarkCount: 3 })}
        showBackendBrand
        density="compact"
        fork={fork}
        taskSummary={{ openCount: 1 }}
      />,
    );
    expect(indicatorsOf(document.body)).toEqual([
      "fork",
      "task",
      "stash",
      "bookmark",
    ]);
    expect(screen.getByRole("img", { name: "2 stashed prompts" })).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "3 bookmarked turns" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("img", { name: "2 stashed prompts" })
        .querySelector(".lucide-archive-restore"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("img", { name: "3 bookmarked turns" })
        .querySelector(".lucide-bookmark"),
    ).toBeTruthy();

    rerender(
      <FlatThreadRow
        thread={makeThread()}
        showBackendBrand
        density="compact"
      />,
    );
    expect(screen.queryByRole("img", { name: /stashed prompt/ })).toBeNull();
    expect(screen.queryByRole("img", { name: /bookmarked turn/ })).toBeNull();
  });

  it("compact shows alert and queued chips with wake in the trailing list", () => {
    const { container } = render(
      <FlatThreadRow
        thread={busy}
        showBackendBrand
        density="compact"
        fork={fork}
      />,
    );
    expect(chipsOf(container)).toEqual(["alert", "queued"]);
    expect(screen.getByRole("img", { name: "2 queued" })).toHaveTextContent("");
    expect(indicatorsOf(container)).toEqual(["wake", "fork"]);
  });

  it("card shows alert and queued chips with wake in the trailing list", () => {
    const { container } = render(
      <FlatThreadRow
        thread={busy}
        showBackendBrand
        density="card"
        fork={fork}
      />,
    );
    expect(chipsOf(container)).toEqual(["alert", "queued"]);
    expect(indicatorsOf(container)).toEqual(["wake", "fork"]);
  });

  it("renders wake as a trailing indicator before fork, not a badge", () => {
    const woken = makeThread({
      queuedInputCount: 1,
      attention: attention({ wake: true }),
    });
    const { container } = render(
      <FlatThreadRow
        thread={woken}
        showBackendBrand
        density="compact"
        fork={fork}
      />,
    );
    expect(chipsOf(container)).toEqual(["queued"]);
    expect(indicatorsOf(container)).toEqual(["wake", "fork"]);
  });

  it("keeps fork separate from status badges", () => {
    const queued = makeThread({ queuedInputCount: 1 });
    const { container } = render(
      <FlatThreadRow
        thread={queued}
        showBackendBrand
        density="compact"
        fork={fork}
      />,
    );
    expect(chipsOf(container)).toEqual(["queued"]);
    expect(indicatorsOf(container)).toEqual(["fork"]);
  });

  it("card shows statuses and separate wake and fork indicators", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          queuedInputCount: 1,
          attention: attention({ wake: true }),
        })}
        density="card"
        fork={fork}
      />,
    );
    expect(chipsOf(container)).toEqual(["queued"]);
    expect(indicatorsOf(container)).toEqual(["wake", "fork"]);
  });

  it("a fork child renders a bare indicator naming its source", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="compact"
        fork={{ isChild: true, sourceTitle: "Root work" }}
      />,
    );
    const indicator = container.querySelector('[data-indicator="fork"]');
    expect(indicator).toHaveAttribute("aria-label", "Fork of Root work");
    expect(indicator?.querySelector(".flat-row-indicator-count")).toBeNull();
  });
});

describe("settled recession", () => {
  it("mutes the row, suppresses status badges, and retains wake and fork", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          inventoryState: "settled",
          queuedInputCount: 4,
          attention: attention({ queueFailure: true, wake: true }),
        })}
        density="compact"
        fork={{ descendantCount: 2, isChild: false }}
      />,
    );
    expect(container.querySelector(".flat-row")).toHaveClass(
      "flat-row-settled",
    );
    expect(chipsOf(container)).toEqual([]);
    expect(indicatorsOf(container)).toEqual(["wake", "fork"]);
  });

  it("renders no badge cluster when settled without fork context", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          inventoryState: "settled",
          attention: attention({ queueFailure: true }),
        })}
        density="compact"
      />,
    );
    expect(container.querySelector(".flat-row-badges")).toBeNull();
  });
});

describe("thread task indicator", () => {
  it("shows open work prominently with an exact accessible count", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="compact"
        taskSummary={{ openCount: 2 }}
      />,
    );
    const indicator = screen.getByTestId("flat-row-task-indicator");
    expect(indicator).toHaveAttribute("aria-label", "2 open tasks");
    expect(indicator.querySelector(".flat-row-indicator-count")).toBeNull();
  });

  it("uses a singular accessible count in card density", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="card"
        taskSummary={{ openCount: 1 }}
      />,
    );
    const indicator = screen.getByRole("img", { name: "1 open task" });
    expect(indicator.querySelector(".flat-row-indicator-count")).toBeNull();
  });

  it("survives settled-row badge suppression", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          inventoryState: "settled",
          queuedInputCount: 2,
          attention: attention({ queueFailure: true, wake: true }),
        })}
        density="compact"
        taskSummary={{ openCount: 1 }}
      />,
    );
    expect(container.querySelector(".flat-row-badges")).toBeNull();
    expect(
      screen.getByRole("img", { name: "1 open task" }),
    ).toBeInTheDocument();
  });

  it("packs wake, fork, and task in stable order beside the timestamp", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          queuedInputCount: 2,
          attention: attention({ queueFailure: true, wake: true }),
        })}
        density="compact"
        fork={{ descendantCount: 3, isChild: false }}
        taskSummary={{ openCount: 5 }}
      />,
    );
    expect(chipsOf(container)).toEqual(["alert", "queued"]);
    expect(indicatorsOf(container)).toEqual(["wake", "fork", "task"]);
    expect(
      screen.getByRole("img", { name: "5 open tasks" }),
    ).toBeInTheDocument();
    expect(
      container.querySelector(
        ".flat-row-default-trailing > .flat-row-indicators",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(".flat-row-link .flat-row-indicators"),
    ).toBeNull();
  });

  it("packs card indicators beside the trailing timestamp", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="card"
        fork={{ descendantCount: 3, isChild: false }}
        taskSummary={{ openCount: 5 }}
      />,
    );
    expect(indicatorsOf(container)).toEqual(["fork", "task"]);
    expect(
      container.querySelector(
        ".flat-row-default-trailing > .flat-row-indicators",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(".flat-row-line2 .flat-row-indicators"),
    ).toBeNull();
  });

  it("omits the indicator when the normalized summary is empty", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="compact"
        taskSummary={{ openCount: 0 }}
      />,
    );
    expect(screen.queryByTestId("flat-row-task-indicator")).toBeNull();
    expect(screen.queryByTestId("flat-row-indicators")).toBeNull();
  });
});

describe("wake indicator", () => {
  it("renders first in the trailing list with an accessible label and no count", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          stashedPromptCount: 1,
          pendingQuestionCount: 0,
          attention: attention({ wake: true }),
        })}
        density="compact"
        fork={{ descendantCount: 3, isChild: false }}
        taskSummary={{ openCount: 1 }}
      />,
    );
    expect(indicatorsOf(container)).toEqual(["wake", "fork", "task", "stash"]);
    const indicator = container.querySelector('[data-indicator="wake"]');
    expect(indicator).toHaveAttribute("aria-label", "Woke");
    expect(indicator?.querySelector(".flat-row-indicator-count")).toBeNull();
  });

  it("survives settled until acknowledged and omits zero attention", () => {
    const { container, rerender } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          inventoryState: "settled",
          attention: attention({ wake: true }),
        })}
        density="compact"
      />,
    );
    expect(indicatorsOf(container)).toEqual(["wake"]);

    rerender(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({ inventoryState: "settled" })}
        density="compact"
      />,
    );
    expect(screen.queryByTestId("flat-row-wake-indicator")).toBeNull();
    expect(screen.queryByTestId("flat-row-indicators")).toBeNull();
  });

  it("packs into line 1 trailing, not line 2, in card density", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({ attention: attention({ wake: true }) })}
        density="card"
        workspaceLabel="sedes"
      />,
    );
    expect(indicatorsOf(container)).toEqual(["wake"]);
    expect(
      container.querySelector(
        ".flat-row-default-trailing > .flat-row-indicators",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(".flat-row-line2 .flat-row-indicators"),
    ).toBeNull();
  });
});

describe("thread pin presentation", () => {
  it("does not repeat pin state in persistent row metadata", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({ pinned: true })}
        density="compact"
      />,
    );
    expect(screen.queryByRole("img", { name: "Pinned" })).toBeNull();
  });
});

describe("card context slot priority", () => {
  it("failure beats paused, schedule, and wake", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          inventoryState: "snoozed",
          snoozedUntil: iso(3_600_000),
          automation: makeAutomation({
            status: "paused",
            nextRunAt: iso(3_600_000),
            lastRun: {
              id: "run-1",
              state: "failed",
              occurrence: "scheduled",
              scheduledFor: iso(-3_600_000),
            },
          }),
        })}
        density="card"
      />,
    );
    const context = screen.getByTestId("flat-row-context");
    expect(context).toHaveTextContent("run failed");
    expect(context).toHaveAttribute("data-tone", "failure");
  });

  it("paused beats schedule", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          automation: makeAutomation({
            status: "paused",
            nextRunAt: iso(3_600_000),
          }),
        })}
        density="card"
      />,
    );
    expect(screen.getByTestId("flat-row-context")).toHaveTextContent("paused");
  });

  it("schedule renders as next {time}", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          automation: makeAutomation({ nextRunAt: iso(30 * 60_000) }),
        })}
        density="card"
      />,
    );
    expect(screen.getByTestId("flat-row-context").textContent).toMatch(
      /^next /,
    );
  });

  it("snoozed renders wakes {time}; draft renders draft", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          inventoryState: "snoozed",
          snoozedUntil: iso(30 * 60_000),
        })}
        density="card"
      />,
    );
    expect(screen.getByTestId("flat-row-context").textContent).toMatch(
      /^wakes /,
    );
    cleanup();
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({ backingState: "unbound" })}
        density="card"
      />,
    );
    expect(screen.getByTestId("flat-row-context")).toHaveTextContent("draft");
  });

  it("compact never renders the context slot", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          automation: makeAutomation({ nextRunAt: iso(3_600_000) }),
        })}
        density="compact"
      />,
    );
    expect(screen.queryByTestId("flat-row-context")).toBeNull();
  });
});

describe("compact vs card structure", () => {
  it("shows a clickable group badge only in card density", () => {
    const onGroupSelect = vi.fn();
    const { rerender } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="card"
        groupLabel="Design review"
        onGroupSelect={onGroupSelect}
      />,
    );
    const group = screen.getByRole("button", {
      name: "Filter threads by group Design review",
    });
    expect(group).toHaveTextContent("Design review");
    fireEvent.click(group);
    expect(onGroupSelect).toHaveBeenCalledOnce();

    rerender(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="compact"
        groupLabel="Design review"
        onGroupSelect={onGroupSelect}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: "Filter threads by group Design review",
      }),
    ).toBeNull();
  });

  it("can identify a compact stack face without changing compact rows by default", () => {
    const onGroupSelect = vi.fn();
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="compact"
        groupLabel="Design review"
        showCompactGroupLabel
        onGroupSelect={onGroupSelect}
      />,
    );

    const group = screen.getByRole("button", {
      name: "Filter threads by group Design review",
    });
    expect(group).toHaveTextContent("Design review");
    fireEvent.click(group);
    expect(onGroupSelect).toHaveBeenCalledOnce();
  });

  it("exposes stack activation semantics without claiming the selected page", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="compact"
        selected
        selectAriaLabel="Open Design review stack, 2 threads"
        selectAriaCurrent={false}
        selectAriaHasPopup="dialog"
        selectAriaExpanded
        selectAriaControls="design-review-roster"
      />,
    );

    const button = screen.getByRole("button", {
      name: "Open Design review stack, 2 threads",
    });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", "design-review-roster");
    expect(screen.getByTestId("thread-row-link")).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByTestId("flat-thread-row")).toHaveAttribute(
      "data-selected",
      "true",
    );
  });

  it("compact is one line without a workspace monogram", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="compact"
        workspaceLabel="Sedes"
      />,
    );
    const row = screen.getByTestId("flat-thread-row");
    expect(row).toHaveAttribute("data-density", "compact");
    expect(container.querySelector(".flat-row-line2")).toBeNull();
    expect(screen.queryByTestId("flat-row-project")).toBeNull();
  });

  it("card adds line 2 with the folder project label", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="card"
        workspaceLabel="Sedes"
      />,
    );
    expect(screen.getByTestId("flat-thread-row")).toHaveAttribute(
      "data-density",
      "card",
    );
    const line2 = container.querySelector(".flat-row-line2");
    expect(line2).not.toBeNull();
    const project = screen.getByTestId("flat-row-project");
    expect(project).toHaveTextContent("Sedes");
    expect(project.querySelector("svg")).not.toBeNull();
    expect(line2!.contains(project)).toBe(true);
  });

  it("renders only the unsuppressed project, environment, and Target metadata", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="card"
        workspaceLabel="agent-workspaces"
        environmentLabel="aw-rocky8-sip"
        targetLabel="Codex SSH"
        showProjectLabel
        showEnvironmentLabel
        showTargetLabel
      />,
    );
    const location = screen.getByTestId("flat-row-location");
    expect(location).toHaveTextContent("agent-workspaces");
    expect(location).toHaveTextContent("aw-rocky8-sip");
    expect(location).toHaveTextContent("Codex SSH");
    cleanup();

    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="card"
        workspaceLabel="agent-workspaces"
        environmentLabel="aw-rocky8-sip"
        targetLabel="Codex SSH"
        showProjectLabel={false}
        showEnvironmentLabel={false}
        showTargetLabel={false}
      />,
    );
    expect(screen.queryByTestId("flat-row-location")).toBeNull();
  });

  it("hides the project label when suppressed or unlabeled", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="compact"
        workspaceLabel="Sedes"
        showProjectLabel={false}
      />,
    );
    expect(screen.queryByTestId("flat-row-project")).toBeNull();
    cleanup();
    render(
      <FlatThreadRow
        thread={makeThread()}
        showBackendBrand
        density="compact"
      />,
    );
    expect(screen.queryByTestId("flat-row-project")).toBeNull();
  });

  it("selected marks the rail and aria-current", () => {
    render(
      <FlatThreadRow
        thread={makeThread()}
        showBackendBrand
        density="compact"
        selected
      />,
    );
    expect(screen.getByTestId("flat-thread-row")).toHaveClass(
      "flat-row-selected",
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-current", "page");
  });

  it("promotes the unseen dot to the exceptional leading slot and weights the title", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          attention: attention({ unseenCompletion: true }),
        })}
        density="card"
      />,
    );
    const dot = screen.getByTestId("flat-row-unseen-dot");
    expect(container.querySelector(".flat-row-glyph")!.contains(dot)).toBe(
      true,
    );
    expect(screen.getByTestId("flat-thread-row")).toHaveClass(
      "flat-row-unseen",
    );
  });

  it("renders caller-provided actions in the trailing swap slot", () => {
    const { container } = render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread()}
        density="compact"
        actions={<button type="button">Archive</button>}
      />,
    );
    const actions = container.querySelector(".flat-row-actions");
    expect(actions).not.toBeNull();
    expect(actions!.querySelector("button")).toHaveTextContent("Archive");
  });
});

describe("trailing time", () => {
  it("renders past-relative by default", () => {
    render(
      <FlatThreadRow
        thread={makeThread()}
        showBackendBrand
        density="compact"
      />,
    );
    const time = screen.getByTestId("flat-row-time");
    expect(time).toHaveTextContent("2h");
    expect(time).not.toHaveAttribute("data-future");
  });

  it("keeps relative time visible while the thread is actively running", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({ runState: "running" })}
        density="compact"
      />,
    );
    expect(screen.getByTestId("flat-row-time")).toHaveTextContent("2h");
    expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument();
  });

  it("renders future-absolute wake time in future-times groups", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          inventoryState: "snoozed",
          snoozedUntil: iso(30 * 60_000),
        })}
        density="compact"
        futureTimes
      />,
    );
    const time = screen.getByTestId("flat-row-time");
    expect(time).toHaveTextContent("in 30m");
    expect(time).toHaveAttribute("data-future", "true");
    expect(time).not.toHaveAttribute("data-overdue");
  });

  it("uses the automation next run when there is no wake", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          automation: makeAutomation({ nextRunAt: iso(45 * 60_000) }),
        })}
        density="compact"
        futureTimes
      />,
    );
    expect(screen.getByTestId("flat-row-time")).toHaveTextContent("in 45m");
  });

  it("marks a past-due future stamp as overdue", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({
          inventoryState: "snoozed",
          snoozedUntil: iso(-10 * 60_000),
        })}
        density="compact"
        futureTimes
      />,
    );
    expect(screen.getByTestId("flat-row-time")).toHaveAttribute(
      "data-overdue",
      "true",
    );
  });

  it("falls back to past-relative when a future group lacks a timestamp", () => {
    render(
      <FlatThreadRow
        showBackendBrand
        thread={makeThread({ inventoryState: "snoozed" })}
        density="compact"
        futureTimes
      />,
    );
    const time = screen.getByTestId("flat-row-time");
    expect(time).toHaveTextContent("2h");
    expect(time).not.toHaveAttribute("data-future");
  });
});

describe("futureTimeLabel ladder", () => {
  const now = new Date(2026, 7, 1, 9, 0, 0); // Sat Aug 1 2026, 09:00 local

  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
  const clock = (date: Date) =>
    date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  it("relative inside the hour", () => {
    expect(futureTimeLabel(at(45 * 60_000).toISOString(), now)).toBe("in 45m");
    expect(futureTimeLabel(at(30_000).toISOString(), now)).toBe("in 1m");
  });

  it("same-day clock time past the hour", () => {
    const date = at(5 * 3_600_000);
    expect(futureTimeLabel(date.toISOString(), now)).toBe(clock(date));
  });

  it("tomorrow gets the Tmrw prefix", () => {
    const date = at(24 * 3_600_000);
    expect(futureTimeLabel(date.toISOString(), now)).toBe(
      `Tmrw ${clock(date)}`,
    );
  });

  it("inside a week gets weekday + time", () => {
    const date = at(3 * 24 * 3_600_000);
    expect(futureTimeLabel(date.toISOString(), now)).toBe(
      shortAutomationTime(date.toISOString()),
    );
  });

  it("a week and beyond gets month + day", () => {
    const date = at(30 * 24 * 3_600_000);
    expect(futureTimeLabel(date.toISOString(), now)).toBe(
      date.toLocaleDateString([], { month: "short", day: "numeric" }),
    );
  });

  it("past-due falls back to the absolute wake label", () => {
    const date = at(-3_600_000);
    expect(futureTimeLabel(date.toISOString(), now)).not.toMatch(/^in /);
  });
});

describe("pending question indicator", () => {
  it.each(["compact", "card"] as const)("shows an actionable count in %s rows and hides it when resolved", (density) => {
    const onOpenQuestions = vi.fn();
    const onSelect = vi.fn();
    const props = { density, showBackendBrand: false, selected: false, futureTimes: false, onOpenQuestions, onSelect };
    const view = render(<FlatThreadRow {...props} thread={makeThread({ pendingQuestionCount: 2 })} />);
    const icon = screen.getByRole("button", { name: "2 unanswered questions" });
    expect(icon.getAttribute("title")).toBe("2 unanswered questions");
    fireEvent.click(icon);
    expect(onOpenQuestions).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    view.rerender(<FlatThreadRow {...props} thread={makeThread()} />);
    expect(screen.queryByTestId("flat-row-question-indicator")).toBeNull();
  });
});


describe("project name filtering", () => {
  it("keeps project metadata passive by default and makes an independent button when enabled", () => {
    const onSelect = vi.fn();
    const onProjectSelect = vi.fn();
    const props = { thread: makeThread(), density: "card" as const,
      showBackendBrand: true, workspaceLabel: "Sedes", onSelect, onProjectSelect };
    const { rerender, container } = render(<FlatThreadRow {...props} />);
    expect(screen.queryByRole("button", { name: "Filter threads by project Sedes" })).toBeNull();
    rerender(<FlatThreadRow {...props} clickNamesToFilter />);
    const project = screen.getByRole("button", { name: "Filter threads by project Sedes" });
    expect(container.querySelector("button button")).toBeNull();
    fireEvent.click(project);
    expect(onProjectSelect).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("thread-row-link"));
    expect(onSelect).toHaveBeenCalledOnce();
    rerender(<FlatThreadRow {...props} clickNamesToFilter showProjectLabel={false} />);
    expect(screen.queryByRole("button", { name: "Filter threads by project Sedes" })).toBeNull();
  });
});


describe("environment name filtering", () => {
  it.each([true, false])("keeps the environment button separate when project visibility is %s", (showProjectLabel) => {
    const onSelect = vi.fn();
    const onProjectSelect = vi.fn();
    const onEnvironmentSelect = vi.fn();
    const props = {
      thread: makeThread(), density: "card" as const, showBackendBrand: true,
      workspaceLabel: "Sedes", environmentLabel: "AW personal", showEnvironmentLabel: true,
      showProjectLabel, onSelect, onProjectSelect, onEnvironmentSelect,
    };
    const { rerender, container } = render(<FlatThreadRow {...props} />);
    expect(screen.getByTestId("flat-row-environment").tagName).toBe("SPAN");
    rerender(<FlatThreadRow {...props} clickNamesToFilter />);
    const environment = screen.getByRole("button", { name: "Filter threads by environment AW personal" });
    expect(container.querySelector("button button")).toBeNull();
    fireEvent.click(environment);
    expect(onEnvironmentSelect).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onProjectSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("thread-row-link"));
    expect(onSelect).toHaveBeenCalledOnce();
    rerender(<FlatThreadRow {...props} clickNamesToFilter showEnvironmentLabel={false} />);
    expect(screen.queryByTestId("flat-row-environment")).toBeNull();
  });
});
