// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  mergeRunPage,
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

describe("mergeRunPage", () => {
  it("puts a fresh first page before the older runs it pushed out, keeping their cursor", () => {
    const [a, b, c] = [run(), run(), run()];
    const fresh = run();
    expect(mergeRunPage([a!, b!, c!], "after-c", { items: [fresh, a!, { ...b!, state: "failed" }], nextCursor: "after-b" }))
      .toEqual({ items: [fresh, a, { ...b, state: "failed" }, c], nextCursor: "after-c" });
    // A page that holds every listed run brings its own cursor.
    expect(mergeRunPage([a!], null, { items: [fresh, a!], nextCursor: "after-a" })).toEqual({
      items: [fresh, a],
      nextCursor: "after-a",
    });
  });

  it("starts over from the page when it cannot show it continues the listed runs", () => {
    const listed = [run(), run(), run()];
    // More new runs than a page: the page shares no run with the list, so
    // there may be unseen runs between them. The list was exhausted (null
    // cursor), but the page's own cursor leads on through that gap.
    const arrivals = Array.from({ length: AUTOMATION_RUNS_PAGE_SIZE }, () => run());
    expect(mergeRunPage(listed, null, { items: arrivals, nextCursor: "after-arrivals" })).toEqual({
      items: arrivals,
      nextCursor: "after-arrivals",
    });
  });

  it("keeps only the listed runs past the page's last shared run", () => {
    const [a, b, c, d] = [run(), run(), run(), run()];
    const fresh = run();
    // b left the filter; c is the page's last listed run, so d continues it.
    expect(mergeRunPage([a!, b!, c!, d!], "after-d", { items: [fresh, a!, c!], nextCursor: "after-c" })).toEqual({
      items: [fresh, a, c, d],
      nextCursor: "after-d",
    });
  });

  it("takes a page that holds the whole history as it is", () => {
    const [a, b] = [run(), run()];
    expect(mergeRunPage([a!, b!], null, { items: [a!], nextCursor: null })).toEqual({ items: [a], nextCursor: null });
  });
});

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
            lastRun: { id: fresh.id, state: "completed", occurrence: "scheduled", scheduledFor: fresh.scheduledFor },
          }),
        },
      ]),
    );
    await waitFor(() => expect(result.current.items).toEqual([delivered, older]));
    expect(result.current.arrived).toEqual([]);
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

  it("drops a Load more answer once a refresh has replaced the history it continued", async () => {
    const listed = Array.from({ length: 3 }, () => run());
    const older = Array.from({ length: 3 }, () => run());
    const arrivals = Array.from({ length: AUTOMATION_RUNS_PAGE_SIZE }, () => run());
    let answerOlder!: (value: ReturnType<typeof page>) => void;
    const list = vi
      .fn()
      .mockResolvedValueOnce(page(listed, "after-listed"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerOlder = resolve;
          }),
      )
      .mockResolvedValueOnce(page(arrivals, "after-arrivals"));
    const fixture = automationStore([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    const { result } = renderHook(() => useRuns(fixture, "all"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.loadMore());
    expect(result.current.loadingMore).toBe(true);

    // More runs arrive than a page holds: the refresh replaces the history.
    const newest = arrivals[0]!;
    act(() =>
      fixture.publish([
        {
          automation: automationSummary({
            lastRun: { id: newest.id, state: "completed", occurrence: "scheduled", scheduledFor: newest.scheduledFor },
          }),
        },
      ]),
    );
    await waitFor(() => expect(result.current.items).toEqual(arrivals));
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.hasMore).toBe(true);

    // The old page answers late; it continued a history that is gone.
    await act(async () => {
      answerOlder(page(older, null, false));
    });
    expect(result.current.items).toEqual(arrivals);
    expect(result.current.hasMore).toBe(true);
    list.mockResolvedValueOnce(page(listed, null, false));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(list).toHaveBeenLastCalledWith(THREAD_ID, expect.objectContaining({ cursor: "after-arrivals" }));
  });

  it("keeps a pending Load more when a refresh keeps the history it continues", async () => {
    const [a, b] = [run(), run()];
    const fresh = run();
    const older = [run(), run()];
    let answerOlder!: (value: ReturnType<typeof page>) => void;
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([a!, b!], "after-b"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerOlder = resolve;
          }),
      )
      .mockResolvedValueOnce(page([fresh, a!], "after-a"));
    const fixture = automationStore([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    const { result } = renderHook(() => useRuns(fixture, "all"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.loadMore());
    act(() =>
      fixture.publish([
        {
          automation: automationSummary({
            lastRun: { id: fresh.id, state: "completed", occurrence: "scheduled", scheduledFor: fresh.scheduledFor },
          }),
        },
      ]),
    );
    await waitFor(() => expect(result.current.items).toEqual([fresh, a, b]));
    expect(result.current.loadingMore).toBe(true);
    await act(async () => {
      answerOlder(page(older, null, false));
    });
    expect(result.current.items).toEqual([fresh, a, b, ...older]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loadingMore).toBe(false);
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
    expect(result.current.items).toEqual([]);
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
