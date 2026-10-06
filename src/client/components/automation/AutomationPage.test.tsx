// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/ApiClient.js";
import { navigate } from "../../app/router.js";
import type { SummaryAutomation } from "../../automation/automation-health.js";
import { dayTimeLabel, dayTimePhrase } from "../../automation/automation-text.js";
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
  viewport();
  navigate(`/automations/${THREAD_ID}`, { replace: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
      3,
      expect.any(AbortSignal),
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
      `Sedes stops waiting on the run from ${dayTimePhrase("2026-10-06T00:00:00.000Z")}.`,
    );
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
