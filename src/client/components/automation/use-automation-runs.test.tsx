// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AutomationRunFilter } from "../../../shared/protocol/domain.js";
import {
  automationStore,
  automationSummary,
  run,
  THREAD_ID,
} from "./automation-test-fixture.js";
import {
  AUTOMATION_RUNS_PAGE_SIZE,
  mergeRunPage,
  useAutomationRuns,
} from "./use-automation-runs.js";

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
});

describe("useAutomationRuns", () => {
  it("loads the first page with the whole-history counts", async () => {
    const items = [run(), run()];
    const fixture = automationStore([{ automation: automationSummary() }], {
      listThreadAutomationRuns: vi.fn().mockResolvedValue(page(items, "next-1")),
    });
    const { result } = renderHook(() => useAutomationRuns(fixture.store, THREAD_ID, "all"));
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
    const { result } = renderHook(() => useAutomationRuns(fixture.store, THREAD_ID, "all"));
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
    const { result } = renderHook(() => useAutomationRuns(fixture.store, THREAD_ID, "skipped"));
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
      ({ filter }: { filter: AutomationRunFilter }) => useAutomationRuns(fixture.store, THREAD_ID, filter),
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
    const { result } = renderHook(() => useAutomationRuns(fixture.store, THREAD_ID, "all"));
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

  it("shows a run an action returned at once", async () => {
    const older = run();
    const fixture = automationStore([{ automation: automationSummary() }], {
      listThreadAutomationRuns: vi.fn().mockResolvedValue(page([older])),
    });
    const { result } = renderHook(() => useAutomationRuns(fixture.store, THREAD_ID, "all"));
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
    const { result } = renderHook(() => useAutomationRuns(fixture.store, THREAD_ID, "problems"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.upsert(run({ state: "claimed" })));
    expect(result.current.items).toEqual([]);
  });

  it("reports a failed first page and retries it", async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error("Runs are unavailable")).mockResolvedValueOnce(page([]));
    const fixture = automationStore([{ automation: automationSummary() }], { listThreadAutomationRuns: list });
    const { result } = renderHook(() => useAutomationRuns(fixture.store, THREAD_ID, "all"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Runs are unavailable");
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(list).toHaveBeenCalledTimes(2);
  });
});
