// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/ApiClient.js";
import { navigate } from "../../app/router.js";
import type { SummaryAutomation } from "../../automation/automation-health.js";
import { dayTimeLabel, dayTimePhrase } from "../../automation/automation-text.js";
import { usageReport } from "../../stores/usage-test-fixture.js";
import { AutomationPage } from "./AutomationPage.js";
import {
  automationStore,
  automationSummary,
  definition,
  run,
  THREAD_ID,
  type FixtureThread,
} from "./automation-test-fixture.js";

/** Matches the given media queries; the others do not match. */
function viewport(...matching: string[]): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: matching.includes(query),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  // Keep the fixed schedule preview in the future without replacing real timers.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-06T03:40:00.000Z") });
  viewport();
  navigate(`/automations/${THREAD_ID}`, { replace: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function page(items: ReturnType<typeof run>[], nextCursor: string | null = null) {
  return {
    items,
    nextCursor,
    counts: {
      all: items.length + (nextCursor ? 10 : 0),
      problems: items.filter(({ state }) => state === "failed" || state === "uncertain").length,
      skipped: 0,
    },
  };
}

function lastRun(state: NonNullable<SummaryAutomation["lastRun"]>["state"], id = "run-last") {
  return {
    id,
    state,
    occurrence: "scheduled" as const,
    scheduledFor: "2026-10-06T00:00:00.000Z",
    finishedAt: "2026-10-06T00:00:05.000Z",
    errorCode: state === "failed" ? "automation_dispatch_failed" : undefined,
  };
}

function renderPage(threads: readonly FixtureThread[] | undefined, api: Parameters<typeof automationStore>[1] = {}) {
  const fixture = automationStore(threads, api);
  render(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />);
  return fixture;
}

describe("AutomationPage", () => {
  it("shows an active automation: header, definition and the latest runs", async () => {
    const delivered = run({ occurrence: "manual" });
    const fixture = renderPage([{ automation: automationSummary() }], {
      getThreadAutomation: vi.fn().mockResolvedValue(
        definition({
          precheck: { command: "test -f package-lock.json", timeoutSeconds: 30, includeStdout: true },
        }),
      ),
      listThreadAutomationRuns: vi.fn().mockResolvedValue(page([delivered])),
    });

    expect(screen.getByRole("heading", { level: 1, name: "Nightly dependency audit" })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/^next /u)).toBeInTheDocument();
    expect(screen.getByText("acme-web")).toBeInTheDocument();
    expect(screen.getByText("Pi SDK")).toBeInTheDocument();

    expect(await screen.findByText("Check acme-web for outdated dependencies.")).toBeInTheDocument();
    expect(screen.getByText("Every day at 2:00 AM UTC")).toBeInTheDocument();
    expect(await screen.findByText(/^Next: /u)).toBeInTheDocument();
    expect(screen.getByText("If Sedes was down: run once")).toBeInTheDocument();
    expect(screen.getByText("This thread")).toBeInTheDocument();
    expect(screen.getByText("test -f package-lock.json")).toBeInTheDocument();
    expect(screen.getByText("30 s timeout · output added to prompt")).toBeInTheDocument();
    expect(fixture.api.previewThreadAutomationSchedule).toHaveBeenCalledWith(
      THREAD_ID,
      definition().schedule,
      { count: 3, signal: expect.any(AbortSignal) },
    );

    const runs = await screen.findByRole("list", { name: "Runs, newest first" });
    expect(within(runs).getByRole("button", { name: /Delivered, Manual$/u })).toBeInTheDocument();
    expect(screen.getByText("1 run")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /callout/u })).toBeNull();
  });

  it("lists the next runs with their times, however far out", async () => {
    const soon = new Date(Date.now() + 20 * 60_000).toISOString();
    const nextWeek = new Date(Date.now() + 8 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 15 * 86_400_000).toISOString();
    renderPage([{ automation: automationSummary() }], {
      previewThreadAutomationSchedule: vi.fn().mockResolvedValue({ occurrences: [soon, nextWeek, later] }),
    });
    expect(await screen.findByText(/^Next: /u)).toHaveTextContent(
      `Next: ${[soon, nextWeek, later].map((occurrence) => dayTimeLabel(occurrence)).join(", ")}`,
    );
  });

  it("lists the next runs after a snooze, asking the server from the wake time", async () => {
    // A five-minute schedule snoozed for a day skips far more than ten runs.
    const wake = new Date(Date.now() + 86_400_000).toISOString();
    const occurrences = [1, 2, 3].map((index) => new Date(Date.parse(wake) + index * 300_000).toISOString());
    const preview = vi.fn().mockResolvedValue({ occurrences });
    renderPage(
      [
        {
          inventoryState: "snoozed",
          snoozedUntil: wake,
          automation: automationSummary({
            scheduleKind: "interval",
            schedule: { kind: "interval", anchorAt: "2026-01-01T00:00:00.000Z", everySeconds: 300 },
          }),
        },
      ],
      { previewThreadAutomationSchedule: preview },
    );
    expect(await screen.findByText(/^Next after snooze: /u)).toHaveTextContent(
      `Next after snooze: ${occurrences.map((occurrence) => dayTimeLabel(occurrence)).join(", ")}`,
    );
    expect(preview).toHaveBeenCalledWith(THREAD_ID, definition().schedule, {
      count: 3,
      after: wake,
      signal: expect.any(AbortSignal),
    });
  });

  it("asks for the next runs again when a scheduled run moves the next run on", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    const later = new Date(Date.now() + 2 * 86_400_000);
    const preview = vi
      .fn()
      .mockResolvedValueOnce({ occurrences: [tomorrow.toISOString()] })
      .mockResolvedValueOnce({ occurrences: [later.toISOString()] });
    const fixture = renderPage([{ automation: automationSummary({ nextRunAt: tomorrow.toISOString() }) }], {
      previewThreadAutomationSchedule: preview,
    });
    await waitFor(() => expect(preview).toHaveBeenCalledOnce());
    act(() =>
      fixture.publish([
        {
          automation: automationSummary({
            nextRunAt: later.toISOString(),
            lastRun: { id: "run-1", state: "completed", occurrence: "scheduled", scheduledFor: new Date().toISOString() },
          }),
        },
      ]),
    );
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
  });

  it("runs now and pauses through the header", async () => {
    const started = run({ occurrence: "manual", state: "claimed", scheduledFor: new Date().toISOString() });
    const fixture = renderPage([{ automation: automationSummary() }], {
      runThreadAutomationNow: vi.fn().mockResolvedValue(started),
      setThreadAutomationState: vi.fn().mockResolvedValue(definition({ status: "paused", revision: 4 })),
      listThreadAutomationRuns: vi.fn().mockResolvedValue(page([run()])),
    });
    await screen.findByRole("list", { name: "Runs, newest first" });

    await userEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(fixture.api.runThreadAutomationNow).toHaveBeenCalledWith(THREAD_ID, expect.any(String)));
    expect(await screen.findByRole("button", { name: /Starting, Manual$/u })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Pause automation" }));
    await waitFor(() =>
      expect(fixture.api.setThreadAutomationState).toHaveBeenCalledWith(THREAD_ID, "pause", 3, expect.any(String)),
    );
  });

  it("explains a failed last run with its diagnostic and opens the thread", async () => {
    const failed = run({ id: "run-last", state: "failed", diagnostic: "The model provider returned 529 (overloaded)." });
    renderPage([{ automation: automationSummary({ lastRun: lastRun("failed") }) }], {
      listThreadAutomationRuns: vi.fn().mockResolvedValue(page([failed])),
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    const callout = screen.getByText(/^Last run failed /u).closest("[data-slot=callout]") as HTMLElement;
    expect(callout).toHaveAttribute("data-tone", "danger");
    expect(await within(callout).findByText("The model provider returned 529 (overloaded).")).toBeInTheDocument();
    expect(within(callout).queryByRole("button", { name: "Run now" })).toBeNull();
    await userEvent.click(within(callout).getByRole("button", { name: "Open thread" }));
    expect(window.location.pathname).toBe(`/threads/${THREAD_ID}`);
  });

  it("blocks actions on an unknown outcome and marks the run failed either way", async () => {
    const resolution = {
      run: run({ id: "run-last", state: "failed" }),
      automation: definition({ status: "enabled", revision: 5 }),
    };
    const fixture = renderPage(
      [{ automation: automationSummary({ status: "paused", lastRun: lastRun("uncertain") }) }],
      { resolveThreadAutomationRun: vi.fn().mockResolvedValue(resolution) },
    );
    expect(screen.getByText("Outcome unknown")).toBeInTheDocument();
    expect(screen.getByText("scheduling paused")).toBeInTheDocument();
    for (const name of ["Run now", "Enable automation", "Edit automation"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-disabled", "true");
    }
    await userEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(fixture.api.runThreadAutomationNow).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Mark as failed…" }));
    let dialog = screen.getByRole("dialog", { name: "Mark the run as failed?" });
    expect(dialog).toHaveTextContent(
      `Sedes stops waiting on the run from ${dayTimePhrase("2026-10-06T00:00:00.000Z")}. If the agent`,
    );
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Cancel",
      "Mark failed, keep paused",
      "Mark failed and resume",
    ]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark failed, keep paused" }));
    await waitFor(() =>
      expect(fixture.api.resolveThreadAutomationRun).toHaveBeenLastCalledWith(THREAD_ID, "run-last", { resume: false }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Mark as failed…" }));
    dialog = screen.getByRole("dialog", { name: "Mark the run as failed?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark failed and resume" }));
    await waitFor(() =>
      expect(fixture.api.resolveThreadAutomationRun).toHaveBeenLastCalledWith(THREAD_ID, "run-last", { resume: true }),
    );
  });

  it("ends a one-time automation with a single Mark failed", async () => {
    const fixture = renderPage(
      [
        {
          automation: automationSummary({
            status: "paused",
            scheduleKind: "date_time",
            schedule: { kind: "date_time", runAt: "2026-10-06T00:00:00.000Z" },
            nextRunAt: undefined,
            lastRun: lastRun("uncertain"),
          }),
        },
      ],
      {
        getThreadAutomation: vi.fn().mockResolvedValue(
          definition({ scheduleKind: "date_time", schedule: { kind: "date_time", runAt: "2026-10-06T00:00:00.000Z" } }),
        ),
        resolveThreadAutomationRun: vi.fn().mockResolvedValue({ run: run({ id: "run-last", state: "failed" }), automation: null }),
      },
    );
    expect(
      screen.getByText("Check the thread, then mark the run as failed to end this one-time automation."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark as failed…" }));
    const dialog = screen.getByRole("dialog", { name: "Mark the run as failed?" });
    expect(dialog).toHaveTextContent(
      `Sedes stops waiting on the run from ${dayTimePhrase("2026-10-06T00:00:00.000Z")}, and this one-time automation ends.`,
    );
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Cancel",
      "Mark failed",
    ]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark failed" }));
    await waitFor(() =>
      expect(fixture.api.resolveThreadAutomationRun).toHaveBeenCalledWith(THREAD_ID, "run-last", { resume: false }),
    );
    // The automation has ended.
    expect(await screen.findByText("No automation")).toBeInTheDocument();
  });

  it("lets a one-time automation's manual run resume or stay paused while its time is ahead", async () => {
    const runAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const fixture = renderPage(
      [
        {
          automation: automationSummary({
            status: "paused",
            scheduleKind: "date_time",
            schedule: { kind: "date_time", runAt },
            nextRunAt: undefined,
            lastRun: { ...lastRun("uncertain"), occurrence: "manual" },
          }),
        },
      ],
      {
        getThreadAutomation: vi.fn().mockResolvedValue(
          definition({ scheduleKind: "date_time", schedule: { kind: "date_time", runAt } }),
        ),
        resolveThreadAutomationRun: vi.fn().mockResolvedValue({
          run: run({ id: "run-last", state: "failed" }),
          automation: definition({ status: "enabled", scheduleKind: "date_time", schedule: { kind: "date_time", runAt }, revision: 5 }),
        }),
      },
    );
    expect(
      screen.getByText("Check the thread, then mark the run as failed to resume scheduling."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark as failed…" }));
    const dialog = screen.getByRole("dialog", { name: "Mark the run as failed?" });
    expect(dialog).not.toHaveTextContent("ends");
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Cancel",
      "Mark failed, keep paused",
      "Mark failed and resume",
    ]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark failed and resume" }));
    await waitFor(() =>
      expect(fixture.api.resolveThreadAutomationRun).toHaveBeenCalledWith(THREAD_ID, "run-last", { resume: true }),
    );
  });

  it("keeps a one-time automation paused after a manual run once its time has passed", async () => {
    const fixture = renderPage(
      [
        {
          automation: automationSummary({
            status: "paused",
            scheduleKind: "date_time",
            schedule: { kind: "date_time", runAt: "2026-10-06T00:00:00.000Z" },
            nextRunAt: undefined,
            lastRun: { ...lastRun("uncertain"), occurrence: "manual" },
          }),
        },
      ],
      {
        resolveThreadAutomationRun: vi.fn().mockResolvedValue({
          run: run({ id: "run-last", state: "failed" }),
          automation: definition({ status: "paused", scheduleKind: "date_time", revision: 5 }),
        }),
      },
    );
    expect(screen.getByText(/Check the thread, then mark the run as failed\.$/u)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark as failed…" }));
    const dialog = screen.getByRole("dialog", { name: "Mark the run as failed?" });
    expect(dialog).toHaveTextContent("The automation stays paused: its time has passed, so edit it to run it again.");
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Cancel",
      "Mark failed",
    ]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark failed" }));
    await waitFor(() =>
      expect(fixture.api.resolveThreadAutomationRun).toHaveBeenCalledWith(THREAD_ID, "run-last", { resume: false }),
    );
  });

  it("keeps the mark-failed dialog open with the error when resolving fails", async () => {
    renderPage([{ automation: automationSummary({ status: "paused", lastRun: lastRun("uncertain") }) }], {
      resolveThreadAutomationRun: vi.fn().mockRejectedValue(new Error("Choose an allowed model.")),
    });
    await userEvent.click(screen.getByRole("button", { name: "Mark as failed…" }));
    const dialog = screen.getByRole("dialog", { name: "Mark the run as failed?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark failed and resume" }));
    expect(await within(dialog).findByText("Choose an allowed model.")).toBeInTheDocument();
  });

  it("enables an automation that never started", async () => {
    const fixture = renderPage([{ automation: automationSummary({ status: "paused" }) }], {
      setThreadAutomationState: vi.fn().mockResolvedValue(definition({ revision: 4 })),
    });
    expect(screen.getByText("Not started")).toBeInTheDocument();
    expect(screen.getByText("scheduling paused")).toBeInTheDocument();
    expect(screen.getByText("Paused. This automation won't run until you enable it.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() =>
      expect(fixture.api.setThreadAutomationState).toHaveBeenCalledWith(THREAD_ID, "enable", 3, expect.any(String)),
    );
  });

  it("offers the header actions by the shared policy", () => {
    renderPage([{ inventoryState: "archived", automation: automationSummary() }]);
    // Archived: no run or edit, but the schedule can still be paused.
    expect(screen.getByRole("button", { name: "Run now" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Pause automation" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: "Edit automation" })).toHaveAttribute("aria-disabled", "true");
    cleanup();

    renderPage([
      {
        automation: automationSummary({
          lastRun: { id: "run-1", state: "running", occurrence: "manual", scheduledFor: new Date().toISOString() },
        }),
      },
    ]);
    // In flight: wait to run or switch the schedule; editing stays open.
    expect(screen.getByRole("button", { name: "Run now" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Pause automation" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Edit automation" })).not.toHaveAttribute("aria-disabled");
  });

  it("restores an archived thread and unsnoozes a snoozed one", async () => {
    const archived = renderPage([{ inventoryState: "archived", automation: automationSummary() }]);
    expect(screen.getByText("Runs are suspended while the thread is archived.")).toBeInTheDocument();
    expect(screen.getByText("runs suspended")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now" })).toHaveAttribute("aria-disabled", "true");
    // Neither the schedule nor Run now will make a first run here.
    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
    expect(screen.queryByText("0 runs")).toBeNull();
    expect(screen.queryByText("Run now to try it.")).toBeNull();
    expect(screen.queryByText(/^The first run is /u)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Restore thread" }));
    await waitFor(() =>
      expect(archived.mutateInventory).toHaveBeenCalledWith(expect.objectContaining({ id: THREAD_ID }), "restore"),
    );
    cleanup();

    const snoozed = renderPage([
      {
        inventoryState: "snoozed",
        snoozedUntil: new Date(Date.now() + 86_400_000).toISOString(),
        automation: automationSummary(),
      },
    ]);
    expect(screen.getByText(/^Scheduled runs are skipped until /u)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unsnooze" }));
    await waitFor(() =>
      expect(snoozed.mutateInventory).toHaveBeenCalledWith(expect.objectContaining({ id: THREAD_ID }), "wake"),
    );
  });

  it("offers Automate… for a thread without an automation", async () => {
    renderPage([{ automation: null }], {
      getThreadAutomationCapability: vi.fn().mockResolvedValue({
        available: true,
        canAttach: true,
        canRunNow: false,
        canCloneOnRun: true,
      }),
    });
    expect(screen.getByText("No automation")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Automate…" }));
    expect(window.location.pathname).toBe(`/automations/${THREAD_ID}/edit`);
  });

  it("waits for the snapshot before deciding where the thread comes from", () => {
    const fixture = renderPage(undefined);
    expect(screen.getByRole("status", { name: "Loading automation" })).toBeInTheDocument();
    expect(fixture.threadRegistry.retain).not.toHaveBeenCalled();
  });

  it("finds a fork the sidebar loaded beyond the bootstrap", async () => {
    const fixture = automationStore(
      [{ id: "root-thread", automation: null }],
      {},
      [{ title: "Nightly audit fork", inventoryState: "archived", automation: automationSummary() }],
    );
    render(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />);
    expect(screen.getByRole("heading", { level: 1, name: "Nightly audit fork" })).toBeInTheDocument();
    expect(await screen.findByText("Check acme-web for outdated dependencies.")).toBeInTheDocument();
    expect(fixture.threadRegistry.retain).not.toHaveBeenCalled();
    // The fork's inventory revision carries a restore.
    await userEvent.click(screen.getByRole("button", { name: "Restore thread" }));
    await waitFor(() =>
      expect(fixture.mutateInventory).toHaveBeenCalledWith(
        expect.objectContaining({ id: THREAD_ID, inventoryRevision: 4 }),
        "restore",
      ),
    );
  });

  it("loads a thread the store does not hold as its thread route would, and lets it go", async () => {
    const fixture = automationStore([{ id: "other-thread", automation: null }]);
    const view = render(
      <AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />,
    );
    expect(screen.getByRole("status", { name: "Loading automation" })).toBeInTheDocument();
    expect(screen.queryByText("Thread not found")).toBeNull();
    expect(fixture.threadRegistry.retain).toHaveBeenCalledWith(THREAD_ID);

    act(() => fixture.threadRegistry.settle({ thread: { title: "Deep fork", automation: automationSummary() } }));
    expect(screen.getByRole("heading", { level: 1, name: "Deep fork" })).toBeInTheDocument();
    expect(screen.getByText("acme-web")).toBeInTheDocument();
    expect(await screen.findByText("Check acme-web for outdated dependencies.")).toBeInTheDocument();

    // A thread update brings the thread into the store; its store is let go.
    act(() => fixture.publish([{ title: "Deep fork", automation: automationSummary() }]));
    expect(fixture.threadRegistry.release).toHaveBeenCalledWith(THREAD_ID);
    expect(screen.getByRole("heading", { level: 1, name: "Deep fork" })).toBeInTheDocument();
    view.unmount();
    expect(fixture.threadRegistry.release).toHaveBeenCalledOnce();
  });

  it("says why a thread outside the store could not be loaded, and retries", async () => {
    const fixture = automationStore([{ id: "other-thread", automation: null }]);
    render(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />);
    act(() => fixture.threadRegistry.settle({ error: "This thread was not found." }));
    expect(screen.getByText("Couldn't open this thread")).toBeInTheDocument();
    expect(screen.getByText("This thread was not found.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fixture.threadRegistry.retryLoad).toHaveBeenCalledOnce();
  });

  it("retries a definition that failed to load, and falls back when the server has none", async () => {
    const getThreadAutomation = vi
      .fn()
      .mockRejectedValueOnce(new Error("The server is unavailable."))
      .mockResolvedValueOnce(definition());
    renderPage([{ automation: automationSummary() }], { getThreadAutomation });
    expect(await screen.findByText("The server is unavailable.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Check acme-web for outdated dependencies.")).toBeInTheDocument();
    cleanup();

    renderPage([{ automation: automationSummary() }], {
      getThreadAutomation: vi.fn().mockRejectedValue(new ApiError(404, "not_found", "This thread has no automation.", false)),
    });
    expect(await screen.findByText("No automation")).toBeInTheDocument();
  });

  it("shows five runs, then the whole history with a filter, paging and Show fewer", async () => {
    const runs = Array.from({ length: 7 }, (_, index) =>
      run({ state: index === 2 ? "failed" : "completed", scheduledFor: new Date(Date.now() - index * 3_600_000).toISOString() }),
    );
    const older = run({ state: "skipped" });
    const problem = runs[2]!;
    const list = vi.fn(async (_threadId: string, input: { cursor?: string; filter?: string }) =>
      input.filter === "problems"
        ? page([problem])
        : input.cursor
          ? { items: [older], nextCursor: null }
          : page(runs, "after-7"),
    );
    renderPage([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    const compact = await screen.findByRole("list", { name: "Runs, newest first" });
    expect(within(compact).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "1 problem" }).closest("p")).toHaveTextContent("17 runs · 1 problem");

    await userEvent.click(screen.getByRole("button", { name: "Show all runs" }));
    const region = screen.getByRole("region", { name: "Run history" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(7);
    expect(screen.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(region).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(8));
    expect(list).toHaveBeenLastCalledWith(THREAD_ID, expect.objectContaining({ cursor: "after-7", filter: "all" }));
    expect(within(region).queryByRole("button", { name: "Load more" })).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "Problems" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Run history" })).getAllByRole("listitem")).toHaveLength(1));
    expect(list).toHaveBeenLastCalledWith(THREAD_ID, expect.not.objectContaining({ cursor: expect.anything() }));

    await userEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByRole("region", { name: "Run history" })).toBeNull();
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Runs, newest first" })).getAllByRole("listitem")).toHaveLength(5));
  });

  it("opens the problems from the count", async () => {
    const failed = run({ state: "failed" });
    const list = vi.fn(async (_threadId: string, input: { filter?: string }) =>
      input.filter === "problems" ? page([failed]) : page([run(), failed]),
    );
    renderPage([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    await userEvent.click(await screen.findByRole("button", { name: "1 problem" }));
    expect(screen.getByRole("radio", { name: "Problems" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(THREAD_ID, expect.objectContaining({ filter: "problems" })));
  });

  it("says when there are no runs yet", async () => {
    renderPage([{ automation: automationSummary() }]);
    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
    expect(screen.getByText(/^The first run is /u)).toBeInTheDocument();
  });

  it("refreshes the runs live and announces a new one", async () => {
    const older = run();
    const fresh = run({ state: "running", occurrence: "manual", scheduledFor: new Date().toISOString() });
    const list = vi.fn().mockResolvedValueOnce(page([older])).mockResolvedValueOnce(page([fresh, older]));
    const getThreadAutomation = vi.fn().mockResolvedValue(definition());
    const fixture = renderPage([{ automation: automationSummary() }], { listThreadAutomationRuns: list, getThreadAutomation });
    await screen.findByRole("list", { name: "Runs, newest first" });
    act(() =>
      fixture.publish([
        {
          automation: automationSummary({
            runsRevision: 1,
            lastRun: { id: fresh.id, state: "running", occurrence: "manual", scheduledFor: fresh.scheduledFor },
          }),
        },
      ]),
    );
    expect(await screen.findByRole("button", { name: /Sending, Manual$/u })).toBeInTheDocument();
    expect(await screen.findByText(/^New run: .*Sending, Manual$/u)).toBeInTheDocument();
    expect(getThreadAutomation).toHaveBeenCalledTimes(2);
  });

  it("expands a run's facts inline on desktop", async () => {
    const childId = "30000000-0000-4000-8000-000000000001";
    const failed = run({
      state: "failed",
      runMode: "clone",
      resultThreadId: childId,
      definitionRevision: 2,
      errorCode: "runtime_unavailable",
      diagnostic: "The Pi runtime did not accept the prompt.",
    });
    renderPage(
      [
        { automation: automationSummary() },
        { id: childId, title: "Nightly dependency audit · Oct 6, 2:00 AM", automation: null },
      ],
      { listThreadAutomationRuns: vi.fn().mockResolvedValue(page([failed])) },
    );
    const row = await screen.findByRole("button", { name: /Failed, Scheduled$/u });
    expect(row).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
    expect(within(detail).getByText("Timeline")).toBeInTheDocument();
    expect(within(detail).getByText("The Pi runtime did not accept the prompt.")).toBeInTheDocument();
    expect(within(detail).getByText("runtime_unavailable")).toBeInTheDocument();
    expect(within(detail).getByText("Revision 2 · edited since (now revision 3)")).toBeInTheDocument();
    await userEvent.click(within(detail).getByRole("link", { name: "Nightly dependency audit · Oct 6, 2:00 AM" }));
    expect(window.location.pathname).toBe(`/threads/${childId}`);
  });

  it("opens a run's facts in a sheet on phones, with Pause and Edit in the menu", async () => {
    viewport("(max-width: 819px)");
    renderPage([{ automation: automationSummary() }], {
      listThreadAutomationRuns: vi.fn().mockResolvedValue(page([run({ state: "skipped", errorCode: "automation_snoozed" })])),
    });
    expect(screen.queryByRole("button", { name: "Pause automation" })).toBeNull();
    const row = await screen.findByRole("button", { name: /Skipped, Scheduled$/u });
    const rowTime = row.querySelector(".automation-run-time")!.textContent!;
    await userEvent.click(row);
    const sheet = screen.getByRole("dialog", { name: "Skipped run" });
    // The sheet names the run's time exactly as its row does.
    expect(within(sheet).getByText(`${rowTime} · Scheduled`)).toBeInTheDocument();
    expect(within(sheet).getByText("Skipped because the thread was snoozed.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "More automation actions" }));
    expect(screen.getByRole("menuitem", { name: "Pause" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(window.location.pathname).toBe(`/automations/${THREAD_ID}/edit`);
  });

  it("deletes through the menu and its confirmation, then goes to the list", async () => {
    const fixture = renderPage([{ automation: automationSummary() }]);
    await screen.findByText("Check acme-web for outdated dependencies.");
    await userEvent.click(screen.getByRole("button", { name: "More automation actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete automation…" }));
    const confirm = screen.getByRole("dialog", { name: "Delete this automation?" });
    expect(confirm).toHaveTextContent("Run history is no longer shown.");
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete automation" }));
    await waitFor(() => expect(fixture.api.deleteThreadAutomation).toHaveBeenCalledWith(THREAD_ID, 3, expect.any(String)));
    await waitFor(() => expect(window.location.pathname).toBe("/automations"));
  });

  it("shows the destination's own automation when moving between pages", async () => {
    const otherId = "10000000-0000-4000-8000-000000000002";
    let releaseOther!: (value: ReturnType<typeof definition>) => void;
    const getThreadAutomation = vi.fn((threadId: string) =>
      threadId === THREAD_ID
        ? Promise.resolve(definition({ prompt: "First prompt" }))
        : new Promise<ReturnType<typeof definition>>((resolve) => {
            releaseOther = resolve;
          }),
    );
    const fixture = automationStore(
      [
        { automation: automationSummary({ revision: 3 }) },
        { id: otherId, title: "Weekly release notes draft", automation: automationSummary({ revision: 3 }) },
      ],
      { getThreadAutomation },
    );
    const view = render(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />);
    expect(await screen.findByText("First prompt")).toBeInTheDocument();

    view.rerender(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={otherId} />);
    expect(screen.getByRole("heading", { level: 1, name: "Weekly release notes draft" })).toBeInTheDocument();
    // Nothing of the first automation stays on screen while the second loads.
    expect(screen.queryByText("First prompt")).toBeNull();
    act(() => releaseOther(definition({ prompt: "Second prompt" })));
    expect(await screen.findByText("Second prompt")).toBeInTheDocument();
  });

  it("goes back where the user came from", async () => {
    navigate(`/threads/${THREAD_ID}`, { replace: true });
    navigate(`/automations/${THREAD_ID}`);
    renderPage([{ automation: automationSummary() }]);
    await userEvent.click(screen.getByRole("link", { name: "Automations" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/threads/${THREAD_ID}`));
  });
});

describe("AutomationPage: agent turns", () => {
  const CHILD_ID = "30000000-0000-4000-8000-000000000002";
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  function settledTurn(
    outcome: "completed" | "failed" | "interrupted",
    seconds?: number,
    id = "turn-1",
  ): NonNullable<ReturnType<typeof run>["turn"]> {
    const startedAt = "2026-10-06T02:00:03.000Z";
    return {
      id,
      outcome,
      settledAt: "2026-10-06T02:10:00.000Z",
      ...(seconds === undefined
        ? {}
        : { startedAt, endedAt: new Date(Date.parse(startedAt) + seconds * 1_000).toISOString() }),
    };
  }

  function rowParts(row: HTMLElement) {
    return {
      state: row.querySelector(".automation-run-state")!,
      meta: row.querySelector(".automation-run-meta")!.textContent,
      glyph: row.querySelector(".automation-run-glyph .automation-glyph")!,
    };
  }

  it("labels runs by how their turn ended, with its duration, and adds no attention", async () => {
    const finished = run({ turn: settledTurn("completed", 134) });
    const failed = run({ turn: settledTurn("failed", 40, "turn-2") });
    const interrupted = run({ turn: settledTurn("interrupted", undefined, "turn-3") });
    const delivered = run();
    renderPage(
      [{ automation: automationSummary({ lastRun: { ...lastRun("completed", finished.id), turn: { outcome: "failed" } } }) }],
      { listThreadAutomationRuns: vi.fn().mockResolvedValue(page([finished, failed, interrupted, delivered])) },
    );

    const finishedRow = rowParts(await screen.findByRole("button", { name: /Finished in 2m 14s, Scheduled$/u }));
    expect(finishedRow.state).toHaveTextContent("Finished");
    expect(finishedRow.state).toHaveAttribute("data-health", "finished");
    expect(finishedRow.meta).toBe("Scheduled · 2m 14s");
    expect(finishedRow.glyph).toHaveAttribute("data-tone", "success");

    const failedRow = rowParts(screen.getByRole("button", { name: /Failed after 40s, Scheduled$/u }));
    expect(failedRow.state).toHaveAttribute("data-health", "failed");
    expect(failedRow.meta).toBe("Scheduled · 40s");
    expect(failedRow.glyph).toHaveAttribute("data-tone", "danger");

    const interruptedRow = rowParts(screen.getByRole("button", { name: /Interrupted, Scheduled$/u }));
    expect(interruptedRow.state).toHaveAttribute("data-health", "interrupted");
    expect(interruptedRow.meta).toBe("Scheduled");
    expect(interruptedRow.glyph).not.toHaveAttribute("data-tone");

    const deliveredRow = rowParts(screen.getByRole("button", { name: /Delivered, Scheduled$/u }));
    expect(deliveredRow.glyph).not.toHaveAttribute("data-tone");

    // A failed turn is history only: the automation stays Active, without a callout.
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(document.querySelector("[data-slot=callout]")).toBeNull();
  });

  it("reads the latest delivered run as Running while its thread works, then as its turn ended", async () => {
    const delivered = run({ acceptedAt: minutesAgo(4.5), finishedAt: minutesAgo(4.5), scheduledFor: minutesAgo(5) });
    const older = run();
    const summary = (turn?: { outcome: "completed" }) =>
      automationSummary({
        // The server advances the run-history revision when the turn settles.
        runsRevision: turn ? 1 : 0,
        lastRun: { ...lastRun("completed", delivered.id), ...(turn ? { turn } : {}) },
      });
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([delivered, older]))
      .mockResolvedValueOnce(page([{ ...delivered, turn: settledTurn("completed", 300) }, older]));
    const fixture = renderPage([{ runState: "running", automation: summary() }], { listThreadAutomationRuns: list });

    const row = await screen.findByRole("button", { name: /Running for 4m, Scheduled$/u });
    expect(rowParts(row).state).toHaveTextContent("Running · 4m");
    expect(rowParts(row).state).toHaveAttribute("data-health", "running");
    expect(rowParts(row).glyph).toHaveClass("comet-spinner");
    // Only the latest run can be running.
    expect(screen.getByRole("button", { name: /Delivered, Scheduled$/u })).toBeInTheDocument();
    // The header hints at the thread's turn; the chip keeps the automation's state.
    expect(screen.getByText("Running", { selector: ".automation-page-meta > span" })).toHaveAttribute("data-tone", "info");
    expect(screen.getByText("Active")).toBeInTheDocument();

    // The turn ends: Delivered until the server records how, then its ending.
    act(() => fixture.publish([{ runState: "idle", automation: summary() }]));
    expect(row).toHaveAccessibleName(/ Delivered, Scheduled$/u);
    expect(rowParts(row).state).toHaveTextContent("Delivered");
    expect(screen.queryByText("Running", { selector: ".automation-page-meta > span" })).toBeNull();
    act(() => fixture.publish([{ runState: "idle", automation: summary({ outcome: "completed" }) }]));
    expect(await screen.findByRole("button", { name: /Finished in 5m, Scheduled$/u })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("follows a fork run's own thread for Running, and the anchor for the header hint", async () => {
    const forked = run({
      runMode: "clone",
      resultThreadId: CHILD_ID,
      acceptedAt: minutesAgo(12),
      finishedAt: minutesAgo(12),
      scheduledFor: minutesAgo(13),
    });
    renderPage(
      [
        {
          runState: "waiting_for_input",
          automation: automationSummary({
            runMode: "clone",
            lastRun: { ...lastRun("completed", forked.id), resultThreadId: CHILD_ID },
          }),
        },
        { id: CHILD_ID, title: "Nightly dependency audit · Oct 6", runState: "waiting_for_approval", automation: null },
      ],
      { listThreadAutomationRuns: vi.fn().mockResolvedValue(page([forked])) },
    );
    expect(await screen.findByRole("button", { name: /Running for 12m, Scheduled$/u })).toBeInTheDocument();
    expect(screen.getByText("Waiting for you", { selector: ".automation-page-meta > span" })).toHaveAttribute(
      "data-tone",
      "warning",
    );
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("leaves a fork run Delivered while its thread is idle or not loaded, and the header quiet", async () => {
    const forked = run({ runMode: "clone", resultThreadId: CHILD_ID });
    renderPage(
      [
        {
          automation: automationSummary({
            runMode: "clone",
            lastRun: { ...lastRun("completed", forked.id), resultThreadId: CHILD_ID },
          }),
        },
      ],
      { listThreadAutomationRuns: vi.fn().mockResolvedValue(page([forked])) },
    );
    expect(await screen.findByRole("button", { name: /Delivered, Scheduled$/u })).toBeInTheDocument();
    expect(document.querySelectorAll(".automation-page-meta > span[data-tone]")).toHaveLength(0);
  });

  it("opens a run's turn with its times and Go to turn, in this thread and in a fork", async () => {
    const sameThread = run({ resultThreadId: THREAD_ID, turn: settledTurn("completed", 134) });
    const forked = run({ runMode: "clone", resultThreadId: CHILD_ID, turn: settledTurn("failed", undefined, "turn-9") });
    renderPage(
      [
        { automation: automationSummary() },
        { id: CHILD_ID, title: "Nightly dependency audit · Oct 6", automation: null },
      ],
      { listThreadAutomationRuns: vi.fn().mockResolvedValue(page([sameThread, forked])) },
    );
    const finishedRow = await screen.findByRole("button", { name: /Finished in 2m 14s, Scheduled$/u });
    await userEvent.click(finishedRow);
    const detail = document.getElementById(finishedRow.getAttribute("aria-controls")!)!;
    const turnFact = within(detail).getByText("Turn").nextElementSibling as HTMLElement;
    const clock = (iso: string) =>
      new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    expect(turnFact).toHaveTextContent(
      `Finished · 2m 14sStarted ${clock(sameThread.turn!.startedAt!)} · ended ${clock(sameThread.turn!.endedAt!)}Go to turn`,
    );
    // Experimental usage is off: no usage row, and no usage read.
    expect(within(detail).queryByText("Usage")).toBeNull();
    const goToTurn = within(detail).getByRole("link", { name: "Go to turn" });
    expect(goToTurn).toHaveAttribute("href", `/threads/${THREAD_ID}#turn=turn-1`);
    await userEvent.click(goToTurn);
    expect(window.location.pathname).toBe(`/threads/${THREAD_ID}`);
    expect(window.location.hash).toBe("#turn=turn-1");

    const failedRow = screen.getByRole("button", { name: /Failed, Scheduled$/u });
    await userEvent.click(failedRow);
    const forkDetail = document.getElementById(failedRow.getAttribute("aria-controls")!)!;
    expect(within(forkDetail).getByText("Turn").nextElementSibling).toHaveTextContent(/^FailedGo to turn$/u);
    expect(within(forkDetail).getByRole("link", { name: "Go to turn" })).toHaveAttribute(
      "href",
      `/threads/${CHILD_ID}#turn=turn-9`,
    );
    expect(within(forkDetail).getByRole("link", { name: "Nightly dependency audit · Oct 6" })).toBeInTheDocument();
  });
});

describe("AutomationPage: agent turns on phones", () => {
  it("titles a run's sheet by its turn and offers Go to turn there", async () => {
    viewport("(max-width: 819px)");
    const interrupted = run({
      turn: { id: "turn-4", outcome: "interrupted", settledAt: "2026-10-06T02:10:00.000Z" },
    });
    renderPage([{ automation: automationSummary() }], {
      listThreadAutomationRuns: vi.fn().mockResolvedValue(page([interrupted])),
    });
    await userEvent.click(await screen.findByRole("button", { name: /Interrupted, Scheduled$/u }));
    const sheet = screen.getByRole("dialog", { name: "Interrupted run" });
    expect(within(sheet).getByRole("link", { name: "Go to turn" })).toHaveAttribute(
      "href",
      `/threads/${THREAD_ID}#turn=turn-4`,
    );
  });
});

describe("AutomationPage: turn usage", () => {
  function renderWithUsage(api: Parameters<typeof automationStore>[1], experimentalUsageEnabled: boolean) {
    const finished = run({
      turn: { id: "turn-1", outcome: "completed", settledAt: "2026-10-06T02:10:00.000Z" },
    });
    const fixture = automationStore(
      [{ automation: automationSummary() }],
      { listThreadAutomationRuns: vi.fn().mockResolvedValue({ items: [finished], nextCursor: null }), ...api },
      [],
      { experimentalUsageEnabled },
    );
    render(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />);
    return fixture;
  }

  async function openDetail(): Promise<HTMLElement> {
    const row = await screen.findByRole("button", { name: /Finished, Scheduled$/u });
    await userEvent.click(row);
    return document.getElementById(row.getAttribute("aria-controls")!)!;
  }

  it("shows the turn's usage when experimental usage is on and the server recorded some", async () => {
    const report = usageReport({
      threadId: THREAD_ID,
      turnId: "turn-1",
      summary: {
        ...usageReport().summary,
        metrics: {
          ...usageReport().summary.metrics,
          input: { value: "12000", quality: "complete", basis: ["provider_reported"], providerPresence: "reported" },
          output: { value: "800", quality: "complete", basis: ["provider_reported"], providerPresence: "reported" },
        },
      },
    });
    const fixture = renderWithUsage(
      {
        getUsageAvailability: vi.fn().mockResolvedValue({
          threadId: THREAD_ID,
          revision: "1",
          turns: [{ turnId: "turn-1", available: true }],
        }),
        getUsage: vi.fn().mockResolvedValue(report),
      },
      true,
    );
    const detail = await openDetail();
    const usage = (await within(detail).findByText("Usage")).nextElementSibling as HTMLElement;
    expect(fixture.api.getUsageAvailability).toHaveBeenCalledWith(THREAD_ID, ["turn-1"], expect.any(AbortSignal));
    expect(await within(usage).findByText("12,000")).toBeInTheDocument();
    expect(within(usage).getByText("800")).toBeInTheDocument();
    expect(fixture.api.getUsage).toHaveBeenCalledWith(THREAD_ID, "turn-1", expect.any(AbortSignal));
  });

  it("hides usage the server did not record", async () => {
    const fixture = renderWithUsage(
      {
        getUsageAvailability: vi.fn().mockResolvedValue({
          threadId: THREAD_ID,
          revision: "1",
          turns: [{ turnId: "turn-1", available: false }],
        }),
      },
      true,
    );
    const detail = await openDetail();
    await waitFor(() => expect(fixture.api.getUsageAvailability).toHaveBeenCalledOnce());
    expect(within(detail).getByText("Turn")).toBeInTheDocument();
    expect(within(detail).queryByText("Usage")).toBeNull();
    expect(fixture.api.getUsage).not.toHaveBeenCalled();
  });

  it("treats a turn whose usage read finds none as no usage, not an error", async () => {
    const fixture = renderWithUsage(
      {
        getUsageAvailability: vi.fn().mockResolvedValue({
          threadId: THREAD_ID,
          revision: "1",
          turns: [{ turnId: "turn-1", available: true }],
        }),
        getUsage: vi.fn().mockRejectedValue(new ApiError(404, "not_found", "No usage was recorded for this turn.", false)),
      },
      true,
    );
    const detail = await openDetail();
    await waitFor(() => expect(fixture.api.getUsage).toHaveBeenCalled());
    await waitFor(() => expect(within(detail).queryByText("Usage")).toBeNull());
    expect(within(detail).queryByText(/could not be refreshed|No usage recorded/u)).toBeNull();
    expect(within(detail).getByRole("link", { name: "Go to turn" })).toBeInTheDocument();
  });

  it("reads no usage while experimental usage is off", async () => {
    const fixture = renderWithUsage({}, false);
    const detail = await openDetail();
    expect(within(detail).getByRole("link", { name: "Go to turn" })).toBeInTheDocument();
    expect(within(detail).queryByText("Usage")).toBeNull();
    expect(fixture.api.getUsageAvailability).not.toHaveBeenCalled();
    expect(fixture.api.getUsage).not.toHaveBeenCalled();
  });
});
