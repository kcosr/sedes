// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import type { ApplicationClientState } from "../../stores/ApplicationClientStore.js";
import { AutomationContextNotice } from "./AutomationContextNotice.js";

afterEach(cleanup);

type LastRun = NonNullable<
  NonNullable<NormalizedApplicationThreadSummary["automation"]>["lastRun"]
>;

/** An application store holding only the source thread's last run. */
function storeWith(lastRun: LastRun | undefined) {
  const listeners = new Set<() => void>();
  let state = stateFor(lastRun);
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    publish(next: LastRun | undefined) {
      state = stateFor(next);
      for (const listener of listeners) listener();
    },
  };
}

function stateFor(lastRun: LastRun | undefined): ApplicationClientState {
  return {
    descendantPages: {
      "other-thread": {
        descendants: [
          {
            thread: {
              id: "loaded-fork",
              automation: { status: "paused", runMode: "same_thread", scheduleKind: "cron", revision: 1, hasPrecheck: false },
            },
          },
        ],
        loading: false,
        loaded: true,
      },
    },
    snapshot: {
      threads: [
        { id: "other-thread", automation: null },
        {
          id: "source-thread",
          automation: {
            status: "enabled",
            runMode: "same_thread",
            scheduleKind: "cron",
            revision: 1,
            hasPrecheck: false,
            ...(lastRun ? { lastRun } : {}),
          },
        },
      ],
    },
  } as unknown as ApplicationClientState;
}

function lastRun(overrides: Partial<LastRun> = {}): LastRun {
  return {
    id: "run-1",
    state: "failed",
    occurrence: "scheduled",
    scheduledFor: "2026-10-06T06:30:00.000Z",
    ...overrides,
  };
}

const context = {
  runId: "run-1",
  sourceThreadId: "source-thread",
  triggeredAt: "2026-10-06T06:30:05.000Z",
};

describe("AutomationContextNotice", () => {
  it("says the thread was triggered, in the neutral tone (nothing to act on), and dismisses", async () => {
    const onDismiss = vi.fn();
    render(
      <AutomationContextNotice
        context={{ ...context, outcome: "triggered" }}
        store={storeWith(lastRun({ state: "completed" }))}
        onDismiss={onDismiss}
      />,
    );
    const notice = screen.getByRole("complementary");
    expect(notice).toHaveTextContent("This thread was triggered by an automation.");
    expect(notice).toHaveAttribute("data-tone", "neutral");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("marks a failed scheduled run red, with its diagnostic under the label and the actions apart", () => {
    render(
      <AutomationContextNotice
        context={{
          ...context,
          outcome: "failed",
          diagnostic: { text: "The execution environment was unreachable." },
        }}
        store={storeWith(lastRun())}
        onDismiss={vi.fn()}
      />,
    );
    const notice = screen.getByRole("complementary");
    expect(notice).toHaveAttribute("data-tone", "danger");
    // Label over diagnostic in one text block; the actions are their own
    // group, which wraps under the text when the row is narrow.
    const text = notice.querySelector(".automation-context-text")!;
    expect([...text.children].map((child) => [child.tagName, child.textContent])).toEqual([
      ["P", "This scheduled run failed."],
      ["SMALL", "The execution environment was unreachable."],
    ]);
    const actions = notice.querySelector(".automation-context-actions")!;
    expect([...actions.children].map((child) => child.textContent)).toEqual([
      "Open automation",
      "Dismiss",
    ]);
    expect(text.contains(actions)).toBe(false);
  });

  it("drops 'scheduled' when the source thread shows the failed run was manual", () => {
    const store = storeWith(lastRun({ occurrence: "manual" }));
    render(
      <AutomationContextNotice
        context={{ ...context, outcome: "failed" }}
        store={store}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("complementary")).toHaveTextContent(/^This run failed\./);

    // A newer run replaces the source's last run: the kind is no longer known.
    act(() => store.publish(lastRun({ id: "run-2", occurrence: "manual" })));
    expect(screen.getByRole("complementary")).toHaveTextContent(
      /^This scheduled run failed\./,
    );
  });

  it("links to the source thread's automation page while it has one", async () => {
    window.history.replaceState(null, "", "/threads/result-thread");
    render(
      <AutomationContextNotice
        context={{ ...context, outcome: "failed" }}
        store={storeWith(lastRun())}
        onDismiss={vi.fn()}
      />,
    );
    const link = screen.getByRole("link", { name: "Open automation" });
    expect(link).toHaveAttribute("href", "/automations/source-thread");
    await userEvent.click(link);
    expect(window.location.pathname).toBe("/automations/source-thread");
  });

  it("links to the automation of a source fork loaded beyond the bootstrap", () => {
    render(
      <AutomationContextNotice
        context={{ ...context, outcome: "triggered", sourceThreadId: "loaded-fork" }}
        store={storeWith(lastRun())}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: "Open automation" })).toHaveAttribute(
      "href",
      "/automations/loaded-fork",
    );
  });

  it("offers no link when the source thread has no automation any more", () => {
    render(
      <AutomationContextNotice
        context={{ ...context, outcome: "triggered", sourceThreadId: "other-thread" }}
        store={storeWith(lastRun())}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("link", { name: "Open automation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("keeps the scheduled wording when the run's kind cannot be determined", () => {
    render(
      <AutomationContextNotice
        context={{ ...context, outcome: "failed", sourceThreadId: "missing-thread" }}
        store={storeWith(lastRun({ occurrence: "manual" }))}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("complementary")).toHaveTextContent(
      /^This scheduled run failed\./,
    );
  });
});
