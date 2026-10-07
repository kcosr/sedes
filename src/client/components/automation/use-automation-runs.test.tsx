// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import type { ThreadAutomationRun } from "../../../shared/protocol/automation-presentation.js";
import type { AutomationRunFilter } from "../../../shared/protocol/domain.js";
import {
  automationStore,
  automationSummary,
  run,
  THREAD_ID,
  type AutomationStore,
} from "./automation-test-fixture.js";
import {
  AUTOMATION_RUNS_PAGE_SIZE,
  useAutomationRuns,
} from "./use-automation-runs.js";
import { useAutomationThread } from "./use-automation-thread.js";

/** The fixture thread's runs, read as the page does: from its live summary. */
function useRuns(fixture: AutomationStore, filter: AutomationRunFilter) {
  const thread = useAutomationThread(fixture.store, THREAD_ID);
  return useAutomationRuns(fixture.store, thread ?? { id: THREAD_ID, automation: null }, filter);
}

const counts = { all: 30, problems: 2, skipped: 4 };

function page(items: ReturnType<typeof run>[], nextCursor: string | null = null, withCounts = true) {
  return { items, nextCursor, ...(withCounts ? { counts } : {}) };
}

describe("useAutomationRuns", () => {
  it("loads the first page with the whole-history counts", async () => {
    const items = [run(), run()];
    const fixture = automationStore([{ automation: automationSummary() }], {
      listThreadAutomationRuns: vi.fn().mockResolvedValue(page(items, "next-1")),
    });
    const { result } = renderHook(() => useRuns(fixture, "all"));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.items).toEqual(items);
    expect(result.current.counts).toEqual(counts);
    expect(result.current.hasMore).toBe(true);
    expect(fixture.api.listThreadAutomationRuns).toHaveBeenCalledWith(THREAD_ID, {
      limit: AUTOMATION_RUNS_PAGE_SIZE,
      filter: "all",
      signal: expect.any(AbortSignal),
    });
  });

  it("stays idle without an automation", () => {
    const fixture = automationStore([{ automation: null }]);
    const { result } = renderHook(() => useRuns(fixture, "all"));
    expect(result.current.status).toBe("idle");
    expect(fixture.api.listThreadAutomationRuns).not.toHaveBeenCalled();
  });

  it("pages on with the cursor and filter, without repeating a run", async () => {
    const [a, b, c] = [run(), run(), run()];
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([a!, b!], "after-b"))
      .mockResolvedValueOnce(page([b!, c!], null, false));
    const fixture = automationStore([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    const { result } = renderHook(() => useRuns(fixture, "skipped"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.loadMore());
    expect(result.current.loadingMore).toBe(true);
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(list).toHaveBeenLastCalledWith(THREAD_ID, {
      cursor: "after-b",
      limit: AUTOMATION_RUNS_PAGE_SIZE,
      filter: "skipped",
      signal: expect.any(AbortSignal),
    });
    expect(result.current.items).toEqual([a, b, c]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.counts).toEqual(counts);
  });

  it("starts over on a new filter, without the old cursor", async () => {
    const list = vi.fn().mockResolvedValue(page([run()], "after"));
    const fixture = automationStore([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    const { result, rerender } = renderHook(
      ({ filter }: { filter: AutomationRunFilter }) => useRuns(fixture, filter),
      { initialProps: { filter: "all" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const problem = run({ state: "failed" });
    list.mockResolvedValueOnce(page([problem]));
    rerender({ filter: "problems" });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.items).toEqual([problem]));
    expect(list).toHaveBeenLastCalledWith(THREAD_ID, {
      limit: AUTOMATION_RUNS_PAGE_SIZE,
      filter: "problems",
      signal: expect.any(AbortSignal),
    });
  });

  it("refreshes the first page when the summary's latest run moves, and reports only new runs", async () => {
    const older = run({ state: "completed" });
    const list = vi.fn().mockResolvedValueOnce(page([older]));
    const fixture = automationStore([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    const { result } = renderHook(() => useRuns(fixture, "all"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.arrived).toEqual([]);

    const fresh = run({ state: "running" });
    list.mockResolvedValueOnce(page([fresh, older], null, true));
    act(() =>
      fixture.publish([
        {
          automation: automationSummary({
            runsRevision: 1,
            lastRun: { id: fresh.id, state: "running", occurrence: "scheduled", scheduledFor: fresh.scheduledFor },
          }),
        },
      ]),
    );
    await waitFor(() => expect(result.current.items).toEqual([fresh, older]));
    expect(result.current.arrived).toEqual([fresh]);

    // The same run moving on is a refresh, not an arrival.
    const delivered = { ...fresh, state: "completed" as const };
    list.mockResolvedValueOnce(page([delivered, older]));
    act(() =>
      fixture.publish([
        {
          automation: automationSummary({
            runsRevision: 2,
            lastRun: { id: fresh.id, state: "completed", occurrence: "scheduled", scheduledFor: fresh.scheduledFor },
          }),
        },
      ]),
    );
    await waitFor(() => expect(result.current.items).toEqual([delivered, older]));
    expect(result.current.arrived).toEqual([]);
    expect(list).toHaveBeenCalledTimes(3);

    // Its turn settling, with the state unchanged, refreshes it too.
    const finished = {
      ...delivered,
      turn: { id: "turn-1", outcome: "failed" as const, settledAt: new Date().toISOString() },
    };
    list.mockResolvedValueOnce(page([finished, older]));
    act(() =>
      fixture.publish([
        {
          automation: automationSummary({
            runsRevision: 3,
            lastRun: {
              id: fresh.id,
              state: "completed",
              occurrence: "scheduled",
              scheduledFor: fresh.scheduledFor,
              turn: { outcome: "failed" },
            },
          }),
        },
      ]),
    );
    await waitFor(() => expect(result.current.items).toEqual([finished, older]));
    expect(result.current.arrived).toEqual([]);
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("refreshes when an older run settles or gains turn times without the latest run moving", async () => {
    const older = run({ state: "completed" });
    const newest = run({ state: "queued" });
    const latest = {
      id: newest.id,
      state: "queued" as const,
      occurrence: "scheduled" as const,
      scheduledFor: newest.scheduledFor,
    };
    const list = vi.fn().mockResolvedValueOnce(page([newest, older]));
    const fixture = automationStore(
      [{ automation: automationSummary({ lastRun: latest, runsRevision: 4 }) }],
      { listThreadAutomationRuns: list },
    );
    const { result } = renderHook(() => useRuns(fixture, "all"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const settled = {
      ...older,
      turn: { id: "turn-older", outcome: "failed" as const, settledAt: new Date().toISOString() },
    };
    list.mockResolvedValueOnce(page([newest, settled]));
    act(() =>
      fixture.publish([{ automation: automationSummary({ lastRun: latest, runsRevision: 5 }) }]),
    );
    await waitFor(() => expect(result.current.items).toEqual([newest, settled]));

    const timed = {
      ...settled,
      turn: { ...settled.turn, startedAt: "2026-10-06T02:00:02.000Z", endedAt: "2026-10-06T02:02:16.000Z" },
    };
    list.mockResolvedValueOnce(page([newest, timed]));
    act(() =>
      fixture.publish([{ automation: automationSummary({ lastRun: latest, runsRevision: 6 }) }]),
    );
    await waitFor(() => expect(result.current.items).toEqual([newest, timed]));
    expect(result.current.arrived).toEqual([]);

    // A republish with the same revision is not a change.
    act(() =>
      fixture.publish([{ automation: automationSummary({ lastRun: latest, runsRevision: 6 }) }]),
    );
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("pages on through a gap after more than a page of runs arrived", async () => {
    const listed = [run(), run()];
    const arrivals = Array.from({ length: AUTOMATION_RUNS_PAGE_SIZE }, () => run());
    const gap = [run(), run()];
    const list = vi
      .fn()
      .mockResolvedValueOnce(page(listed, null))
      .mockResolvedValueOnce(page(arrivals, "after-arrivals"))
      .mockResolvedValueOnce(page([...gap, ...listed], null, false));
    const fixture = automationStore([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    const { result } = renderHook(() => useRuns(fixture, "all"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.hasMore).toBe(false);

    const newest = arrivals[0]!;
    act(() =>
      fixture.publish([
        {
          automation: automationSummary({
            runsRevision: 1,
            lastRun: { id: newest.id, state: "completed", occurrence: "scheduled", scheduledFor: newest.scheduledFor },
          }),
        },
      ]),
    );
    await waitFor(() => expect(result.current.items).toEqual(arrivals));
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toEqual([...arrivals, ...gap, ...listed]));
    expect(list).toHaveBeenLastCalledWith(THREAD_ID, expect.objectContaining({ cursor: "after-arrivals" }));
    expect(result.current.hasMore).toBe(false);
  });

  it("shows a run an action returned at once", async () => {
    const older = run();
    const fixture = automationStore([{ automation: automationSummary() }], {
      listThreadAutomationRuns: vi.fn().mockResolvedValue(page([older])),
    });
    const { result } = renderHook(() => useRuns(fixture, "all"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const manual = run({ occurrence: "manual", state: "claimed" });
    act(() => result.current.upsert(manual));
    expect(result.current.items).toEqual([manual, older]);
    act(() => result.current.upsert({ ...older, state: "failed" }));
    expect(result.current.items).toEqual([manual, { ...older, state: "failed" }]);
  });

  it("leaves a run out of a filter it does not match", async () => {
    const fixture = automationStore([{ automation: automationSummary() }], {
      listThreadAutomationRuns: vi.fn().mockResolvedValue(page([])),
    });
    const { result } = renderHook(() => useRuns(fixture, "problems"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.upsert(run({ state: "claimed" })));
    act(() =>
      result.current.upsert(run({ turn: { id: "turn-1", outcome: "interrupted", settledAt: new Date().toISOString() } })),
    );
    expect(result.current.items).toEqual([]);
    // A failed turn is a problem, as the server counts and filters it.
    const failedTurn = run({ turn: { id: "turn-2", outcome: "failed", settledAt: new Date().toISOString() } });
    act(() => result.current.upsert(failedTurn));
    expect(result.current.items).toEqual([failedTurn]);
  });

  it("reports a failed first page and retries it", async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error("Runs are unavailable")).mockResolvedValueOnce(page([]));
    const fixture = automationStore([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    const { result } = renderHook(() => useRuns(fixture, "all"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Runs are unavailable");
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("useAutomationRuns: reconciling the loaded history", () => {
  type ListInput = {
    readonly cursor?: string;
    readonly limit?: number;
    readonly filter?: AutomationRunFilter;
    readonly signal?: AbortSignal;
  };

  function matches(item: ThreadAutomationRun, filter: AutomationRunFilter): boolean {
    switch (filter) {
      case "all":
        return true;
      case "problems":
        return item.state === "failed" || item.state === "uncertain" || item.turn?.outcome === "failed";
      case "skipped":
        return item.state === "skipped";
    }
  }

  /**
   * A run-history server over a newest-first history that changes between
   * requests. Each answer is the history as it was when it was asked, so a
   * held answer is stale by the time it lands. Cursors continue after a run.
   */
  function historyServer(initial: readonly ThreadAutomationRun[]) {
    let history = initial;
    let gate: Promise<void> | undefined;
    const signals: AbortSignal[] = [];
    const list = vi.fn(async (_threadId: string, input: ListInput) => {
      if (input.signal) signals.push(input.signal);
      const filter = input.filter ?? "all";
      const matching = history.filter((item) => matches(item, filter));
      const start = input.cursor
        ? matching.findIndex(({ id }) => `after-${id}` === input.cursor) + 1
        : 0;
      const limit = input.limit ?? 50;
      const items = matching.slice(start, start + limit);
      const answer = {
        items,
        nextCursor: start + limit < matching.length ? `after-${items.at(-1)!.id}` : null,
        ...(input.cursor
          ? {}
          : {
              counts: {
                all: history.length,
                problems: history.filter((item) => matches(item, "problems")).length,
                skipped: history.filter((item) => matches(item, "skipped")).length,
              },
            }),
      };
      const held = gate;
      if (held) await held;
      return answer;
    });
    return {
      list,
      signals,
      history: () => history,
      change(id: string, change: Partial<ThreadAutomationRun>) {
        history = history.map((item) => (item.id === id ? { ...item, ...change } : item));
      },
      add(item: ThreadAutomationRun) {
        history = [item, ...history];
      },
      /** Holds every answer asked for from now until the release. */
      hold(): () => void {
        let release!: () => void;
        gate = new Promise((resolve) => {
          release = resolve;
        });
        return () => {
          gate = undefined;
          release();
        };
      },
    };
  }

  const turn = (outcome: "completed" | "failed" | "interrupted", times = false) => ({
    id: `turn-${outcome}`,
    outcome,
    settledAt: "2026-10-06T02:10:00.000Z",
    ...(times ? { startedAt: "2026-10-06T02:00:02.000Z", endedAt: "2026-10-06T02:02:16.000Z" } : {}),
  });

  async function loadedRuns(
    server: ReturnType<typeof historyServer>,
    filter: AutomationRunFilter,
    pages: number,
  ) {
    const fixture = automationStore([{ automation: automationSummary() }], { listThreadAutomationRuns: server.list });
    const hook = renderHook(() => useRuns(fixture, filter));
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    for (let loaded = 1; loaded < pages; loaded++) {
      act(() => hook.result.current.loadMore());
      await waitFor(() => expect(hook.result.current.loadingMore).toBe(false));
    }
    server.list.mockClear();
    let revision = 0;
    return {
      ...hook,
      fixture,
      /** The server's run-history revision moves, as it does for any run change. */
      revise: () =>
        act(() => fixture.publish([{ automation: automationSummary({ runsRevision: ++revision }) }])),
    };
  }

  const cursors = (server: ReturnType<typeof historyServer>) =>
    server.list.mock.calls.map(([, input]) => (input as ListInput).cursor ?? "start");

  it("rereads every loaded page when an older run past the first page settles its turn", async () => {
    const history = Array.from({ length: 60 }, () => run());
    const server = historyServer(history);
    const { result, revise } = await loadedRuns(server, "all", 2);
    expect(result.current.items).toHaveLength(50);

    const older = history[39]!;
    server.change(older.id, { turn: turn("failed") });
    revise();
    await waitFor(() => expect(result.current.items[39]).toEqual({ ...older, turn: turn("failed") }));
    // Two pages of the list's own size, the second continuing the first.
    expect(cursors(server)).toEqual(["start", `after-${history[24]!.id}`]);
    expect(server.list).toHaveBeenLastCalledWith(THREAD_ID, expect.objectContaining({ limit: AUTOMATION_RUNS_PAGE_SIZE }));
    expect(result.current.items).toEqual(server.history().slice(0, 50));
    expect(result.current.hasMore).toBe(true);
    expect(result.current.arrived).toEqual([]);

    // Load more continues where the reread prefix ends.
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(60));
    expect(result.current.items).toEqual(server.history());
  });

  it("brings an older run's late turn times to its row", async () => {
    const history = Array.from({ length: 40 }, () => run({ turn: turn("completed") }));
    const server = historyServer(history);
    const { result, revise } = await loadedRuns(server, "all", 2);
    expect(result.current.hasMore).toBe(false);

    const older = history[33]!;
    server.change(older.id, { turn: turn("completed", true) });
    revise();
    await waitFor(() => expect(result.current.items[33]?.turn).toEqual(turn("completed", true)));
    expect(server.list).toHaveBeenCalledTimes(2);
    expect(result.current.items).toEqual(server.history());
  });

  it("lists an older run that newly fails in Problems, between pages it had loaded", async () => {
    // 55 problems among other runs; two pages of them are listed.
    const history = Array.from({ length: 80 }, (_, index) =>
      run({ state: index % 16 < 11 ? "failed" : "completed" }),
    );
    const server = historyServer(history);
    const { result, revise } = await loadedRuns(server, "problems", 2);
    expect(result.current.items).toHaveLength(50);
    expect(result.current.counts?.problems).toBe(55);

    // A delivered run between listed problems past the first page fails its turn.
    const lastListed = history.findIndex(({ id }) => id === result.current.items[49]!.id);
    const firstAfterPage = history.findIndex(({ id }) => id === result.current.items[25]!.id);
    const between = history.findIndex(
      (item, index) => index > firstAfterPage && index < lastListed && item.state === "completed",
    );
    const newlyFailed = history[between]!;
    const position = history.slice(0, between).filter((item) => matches(item, "problems")).length;
    expect(position).toBeGreaterThan(25);
    server.change(newlyFailed.id, { turn: turn("failed") });
    revise();
    await waitFor(() => expect(result.current.counts?.problems).toBe(56));
    expect(result.current.items[position]).toEqual({ ...newlyFailed, turn: turn("failed") });
    expect(result.current.items).toHaveLength(50);
    // It did not arrive: it is an older run that now matches.
    expect(result.current.arrived).toEqual([]);
    // The last listed problem moved behind the cursor, and Load more finds it.
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.items.map(({ id }) => id)).toEqual(
      server.history().filter((item) => matches(item, "problems")).map(({ id }) => id),
    );
  });

  it("keeps the common case to one request, with a run that newly fails behind the first page reachable", async () => {
    const history = Array.from({ length: 40 }, () => run({ state: "failed" }));
    history.splice(30, 0, run({ state: "completed" }));
    const server = historyServer(history);
    const { result, revise } = await loadedRuns(server, "problems", 1);
    expect(result.current.items).toHaveLength(25);

    server.change(history[30]!.id, { turn: turn("failed") });
    revise();
    await waitFor(() => expect(result.current.counts?.problems).toBe(41));
    expect(cursors(server)).toEqual(["start"]);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.items.map(({ id }) => id)).toContain(history[30]!.id);
    expect(result.current.items).toHaveLength(41);
  });

  it("rereads the whole history when every page was loaded, adding a run that arrived", async () => {
    const history = Array.from({ length: 30 }, () => run());
    const server = historyServer(history);
    const { result, revise } = await loadedRuns(server, "all", 2);
    expect(result.current.hasMore).toBe(false);

    const arrived = run({ state: "running", occurrence: "manual" });
    server.add(arrived);
    server.change(history[28]!.id, { turn: turn("interrupted") });
    revise();
    await waitFor(() => expect(result.current.items).toHaveLength(31));
    expect(result.current.items).toEqual(server.history());
    expect(result.current.items[29]?.turn).toEqual(turn("interrupted"));
    expect(result.current.hasMore).toBe(false);
    expect(result.current.arrived).toEqual([arrived]);
  });

  it("takes over a Load more in flight, whose answer predates the change", async () => {
    const history = Array.from({ length: 60 }, () => run());
    const server = historyServer(history);
    const { result, revise } = await loadedRuns(server, "all", 1);

    // Load more is answered from the history before the older run settles.
    const release = server.hold();
    act(() => result.current.loadMore());
    expect(result.current.loadingMore).toBe(true);
    const staleLoadMore = server.signals.at(-1)!;
    const older = history[30]!;
    server.change(older.id, { turn: turn("completed") });
    revise();
    expect(staleLoadMore.aborted).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    // The refresh read the Load more's page too, from the changed history.
    expect(cursors(server)).toEqual([`after-${history[24]!.id}`, "start", `after-${history[24]!.id}`]);
    expect(result.current.items).toEqual(server.history().slice(0, 50));
    expect(result.current.items[30]?.turn).toEqual(turn("completed"));
    expect(result.current.hasMore).toBe(true);
  });

  it("reads a Load more asked for during a refresh with it, and folds revisions that move meanwhile into one more", async () => {
    const history = Array.from({ length: 60 }, () => run());
    const server = historyServer(history);
    const { result, revise } = await loadedRuns(server, "all", 1);

    const release = server.hold();
    revise();
    expect(server.list).toHaveBeenCalledTimes(1);
    act(() => result.current.loadMore());
    expect(result.current.loadingMore).toBe(true);
    // No separate request continues the old cursor.
    expect(server.list).toHaveBeenCalledTimes(1);
    revise();
    revise();
    server.change(history[45]!.id, { turn: turn("failed") });
    await act(async () => release());
    await waitFor(() => expect(result.current.items[45]?.turn).toEqual(turn("failed")));
    // The refresh read two pages; the moved revisions made one more of two.
    expect(cursors(server)).toEqual([
      "start",
      `after-${history[24]!.id}`,
      "start",
      `after-${history[24]!.id}`,
    ]);
    expect(result.current.items).toEqual(server.history().slice(0, 50));
    expect(result.current.loadingMore).toBe(false);
  });

  it("lets only the newest history read land when the filter and the revision move together", async () => {
    const newest = run();
    const older = run();
    let history: readonly ThreadAutomationRun[] = [newest, older];
    // Every answer is the history when it was asked, held until answered.
    const pending: { readonly input: ListInput; readonly answer: () => void }[] = [];
    const list = vi.fn(
      (_threadId: string, input: ListInput) =>
        new Promise((resolve) => {
          const filter = input.filter ?? "all";
          const asked = history;
          const items = asked.filter((item) => matches(item, filter));
          pending.push({
            input,
            answer: () =>
              resolve({
                items,
                nextCursor: null,
                counts: {
                  all: asked.length,
                  problems: asked.filter((item) => matches(item, "problems")).length,
                  skipped: 0,
                },
              }),
          });
        }),
    );
    const live = () => pending.filter(({ input }) => !input.signal?.aborted);
    /** Answers what is asked, newest request first, until nothing is asked. */
    const answerNewestFirst = async () => {
      while (pending.length > 0) {
        await act(async () => {
          for (const { answer } of pending.splice(0).reverse()) answer();
        });
      }
    };
    const fixture = automationStore([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    let setFilter!: (filter: AutomationRunFilter) => void;
    const { result } = renderHook(() => {
      const [filter, set] = useState<AutomationRunFilter>("all");
      setFilter = set;
      return useRuns(fixture, filter);
    });
    await answerNewestFirst();
    expect(result.current.items).toEqual([newest, older]);

    // Problems and a new revision in one render, then the older run's turn
    // fails and the revision moves again while the history is being read.
    act(() =>
      flushSync(() => {
        setFilter("problems");
        fixture.publish([{ automation: automationSummary({ runsRevision: 1 }) }]);
      }),
    );
    history = [newest, { ...older, turn: { id: "turn-older", outcome: "failed", settledAt: new Date().toISOString() } }];
    act(() => fixture.publish([{ automation: automationSummary({ runsRevision: 2 }) }]));
    // One read owns the history at a time.
    expect(live()).toHaveLength(1);
    expect(live()[0]!.input).toMatchObject({ filter: "problems" });

    await answerNewestFirst();
    expect(result.current.status).toBe("ready");
    expect(result.current.items).toEqual([history[1]]);
    expect(result.current.counts?.problems).toBe(1);
  });

  it("keeps the listed runs when a refresh fails, and reports a Load more it took over", async () => {
    const history = Array.from({ length: 30 }, () => run());
    const server = historyServer(history);
    const { result, revise } = await loadedRuns(server, "all", 1);
    const listed = result.current.items;
    server.list.mockRejectedValueOnce(new Error("Runs are unavailable"));
    revise();
    await waitFor(() => expect(server.list).toHaveBeenCalledTimes(1));
    expect(result.current.items).toBe(listed);
    expect(result.current.loadMoreError).toBeUndefined();

    const release = server.hold();
    act(() => result.current.loadMore());
    server.list.mockRejectedValueOnce(new Error("Runs are unavailable"));
    revise();
    await act(async () => release());
    await waitFor(() => expect(result.current.loadMoreError).toBe("Runs are unavailable"));
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.items).toBe(listed);
  });
});
