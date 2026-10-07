import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ThreadAutomationRun,
  ThreadAutomationRunCounts,
  ThreadAutomationRunPage,
} from "../../../shared/protocol/automation-presentation.js";
import type { AutomationRunFilter } from "../../../shared/protocol/domain.js";
import { threadRunPhase } from "../../automation/automation-health.js";
import { findLoadedThread } from "../../automation/loaded-threads.js";
import {
  messageFrom,
  type ApplicationClientState,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { useApplicationStoreSelector } from "../../stores/use-application-store-selector.js";
import { automationLiveKey, type AutomationThread } from "./use-automation-thread.js";

/** Runs per page, for the first page and for each "Load more". */
export const AUTOMATION_RUNS_PAGE_SIZE = 25;

/**
 * How long the refresh after a watched thread's turn ends waits: turn
 * endings that land together (a queued run starting, a fork and its anchor)
 * make one request, and the settlement the server records as the turn ends
 * has committed by then.
 */
export const TURN_END_REFRESH_DELAY_MILLISECONDS = 500;

export interface AutomationRuns {
  /** `idle` while the thread has no automation. */
  readonly status: "idle" | "loading" | "ready" | "error";
  /** Newest first, in the server's order. */
  readonly items: readonly ThreadAutomationRun[];
  /** Whole-history counts, from the latest first page. */
  readonly counts?: ThreadAutomationRunCounts;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly error?: string;
  readonly loadMoreError?: string;
  /** Runs the latest live refresh brought in that were not listed before. */
  readonly arrived: readonly ThreadAutomationRun[];
  readonly loadMore: () => void;
  readonly retry: () => void;
  /** Shows a run an action returned (Run now, Mark as failed) before the refresh lands. */
  readonly upsert: (run: ThreadAutomationRun) => void;
}

interface RunsState {
  readonly filter: AutomationRunFilter;
  readonly status: AutomationRuns["status"];
  readonly items: readonly ThreadAutomationRun[];
  readonly nextCursor: string | null;
  readonly counts?: ThreadAutomationRunCounts;
  readonly loadingMore: boolean;
  readonly error?: string;
  readonly loadMoreError?: string;
  readonly arrived: readonly ThreadAutomationRun[];
}

function emptyState(
  filter: AutomationRunFilter,
  status: RunsState["status"],
): RunsState {
  return { filter, status, items: [], nextCursor: null, loadingMore: false, arrived: [] };
}

/**
 * Merges a fresh first page into the listed runs, keeping the server's
 * order. Both are prefixes of the same newest-first history, so when the
 * page shares a run with the list it holds everything newer than that run,
 * and the listed runs after the last shared one continue it: they stay,
 * with the old cursor, which points past the last of them. When the page
 * shares nothing, more runs arrived than a page holds and there may be
 * unseen runs between the two; the page then replaces the list, and its
 * cursor leads on through that gap. A page without a cursor is the whole
 * history.
 */
export function mergeRunPage(
  current: readonly ThreadAutomationRun[],
  currentCursor: string | null,
  page: Pick<ThreadAutomationRunPage, "items" | "nextCursor">,
): { readonly items: readonly ThreadAutomationRun[]; readonly nextCursor: string | null } {
  const replaced = { items: page.items, nextCursor: page.nextCursor };
  if (page.nextCursor === null) return replaced;
  const fresh = new Set(page.items.map(({ id }) => id));
  const lastShared = current.findLastIndex(({ id }) => fresh.has(id));
  if (lastShared < 0) return replaced;
  const older = current.slice(lastShared + 1);
  return older.length === 0
    ? replaced
    : { items: [...page.items, ...older], nextCursor: currentCursor };
}

/**
 * Whether a run belongs in the list for a filter, as the server filters:
 * problems are failed or uncertain runs and runs whose agent turn failed.
 */
function runMatchesFilter(
  run: Pick<ThreadAutomationRun, "state" | "turn">,
  filter: AutomationRunFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "problems":
      return (
        run.state === "failed" ||
        run.state === "uncertain" ||
        run.turn?.outcome === "failed"
      );
    case "skipped":
      return run.state === "skipped";
  }
}

/**
 * The fork threads whose turn may still settle a listed run: the result
 * thread of each delivered fork run without a settled turn, sorted and
 * space-separated (a stable key).
 */
function unsettledForkThreads(
  items: readonly ThreadAutomationRun[],
  anchorId: string,
): string {
  const forks = new Set<string>();
  for (const run of items) {
    if (
      run.state === "completed" &&
      run.turn === undefined &&
      run.resultThreadId !== undefined &&
      run.resultThreadId !== anchorId
    ) {
      forks.add(run.resultThreadId);
    }
  }
  return [...forks].sort().join(" ");
}

function threadIds(key: string): readonly string[] {
  return key === "" ? [] : key.split(" ");
}

/**
 * One automation's run history for a filter: the first page with the
 * whole-history counts, cursor paging, and a live refresh of the first page
 * whenever the live thread summary's latest run or revision moves (the
 * server publishes a thread update for each run transition).
 *
 * A run that is not the latest settles without moving the summary: in this
 * thread, an earlier run's turn ends while the next run waits behind it, and
 * a fork run's turn ends in its own thread. So the first page is also read
 * again shortly after a watched thread's turn ends (its run phase leaves
 * busy): this thread, whose runs and own turns can both change the history,
 * and the fork thread of every listed run whose turn has not settled.
 */
export function useAutomationRuns(
  store: Pick<ApplicationClientStore, "api" | "subscribe" | "getSnapshot">,
  thread: Pick<AutomationThread, "id" | "automation" | "runState">,
  filter: AutomationRunFilter,
): AutomationRuns {
  const threadId = thread.id;
  const liveKey = automationLiveKey(thread.automation);
  const present = liveKey !== undefined;
  const [state, setState] = useState<RunsState>(() =>
    emptyState(filter, present ? "loading" : "idle"),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const firstPage = useRef<AbortController | undefined>(undefined);
  const nextPage = useRef<AbortController | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  const fetchFirstPage = useCallback(
    (mode: "replace" | "merge") => {
      firstPage.current?.abort();
      const controller = new AbortController();
      firstPage.current = controller;
      store.api
        .listThreadAutomationRuns(threadId, {
          limit: AUTOMATION_RUNS_PAGE_SIZE,
          filter,
          signal: controller.signal,
        })
        .then(
          (page) => {
            if (controller.signal.aborted) return;
            setState((current) => {
              if (current.filter !== filter) return current;
              if (mode === "merge" && current.status === "ready") {
                const listed = new Set(current.items.map(({ id }) => id));
                const merged = mergeRunPage(current.items, current.nextCursor, page);
                // A replaced history has a new cursor; a Load more sent with
                // the old one no longer continues it (its answer is dropped).
                const continued = merged.nextCursor === current.nextCursor;
                return {
                  ...current,
                  ...merged,
                  counts: page.counts ?? current.counts,
                  arrived: page.items.filter(({ id }) => !listed.has(id)),
                  ...(continued ? {} : { loadingMore: false, loadMoreError: undefined }),
                };
              }
              return {
                ...emptyState(filter, "ready"),
                items: page.items,
                nextCursor: page.nextCursor,
                ...(page.counts ? { counts: page.counts } : {}),
              };
            });
          },
          (reason: unknown) => {
            if (controller.signal.aborted) return;
            // A failed live refresh keeps the listed runs; the next one retries.
            setState((current) =>
              mode === "merge" && current.status === "ready"
                ? current
                : { ...emptyState(filter, "error"), error: messageFrom(reason) },
            );
          },
        );
    },
    [filter, store, threadId],
  );

  // A new thread, filter or automation starts the list over.
  useEffect(() => {
    nextPage.current?.abort();
    if (!present) {
      firstPage.current?.abort();
      setState(emptyState(filter, "idle"));
      return;
    }
    setState(emptyState(filter, "loading"));
    fetchFirstPage("replace");
  }, [attempt, fetchFirstPage, filter, present]);

  const observedKey = useRef(liveKey);
  useEffect(() => {
    const previous = observedKey.current;
    observedKey.current = liveKey;
    if (previous === liveKey || previous === undefined || liveKey === undefined) {
      return;
    }
    fetchFirstPage("merge");
  }, [fetchFirstPage, liveKey]);

  // Busy watched threads, as a stable key: this thread from its live
  // summary, forks from the application store (unloaded forks are not
  // watched). Phases, not states, so steps within a turn (running, waiting)
  // are not an ending.
  const forkKey = useMemo(
    () => unsettledForkThreads(state.items, threadId),
    [state.items, threadId],
  );
  const selectBusyForks = useCallback(
    (application: ApplicationClientState) =>
      threadIds(forkKey)
        .filter((forkId) => {
          const fork = findLoadedThread(application, forkId);
          return fork !== undefined && threadRunPhase(fork.runState) === "busy";
        })
        .join(" "),
    [forkKey],
  );
  const busyForks = useApplicationStoreSelector(store, selectBusyForks);
  const anchorBusy = threadRunPhase(thread.runState) === "busy";
  const busyKey = [anchorBusy ? threadId : "", busyForks].filter(Boolean).join(" ");
  const observedBusy = useRef(busyKey);
  const turnEndRefresh = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The refresh reads the list as it is when it fires, for the filter then.
  const refreshFirstPage = useRef(fetchFirstPage);
  refreshFirstPage.current = fetchFirstPage;
  useEffect(() => {
    const previous = threadIds(observedBusy.current);
    observedBusy.current = busyKey;
    const busy = new Set(threadIds(busyKey));
    const watched = new Set([threadId, ...threadIds(forkKey)]);
    // A thread that stopped being watched settled its runs already.
    if (!previous.some((id) => !busy.has(id) && watched.has(id))) return;
    clearTimeout(turnEndRefresh.current);
    turnEndRefresh.current = setTimeout(() => {
      turnEndRefresh.current = undefined;
      if (stateRef.current.status === "ready") refreshFirstPage.current("merge");
    }, TURN_END_REFRESH_DELAY_MILLISECONDS);
  }, [busyKey, forkKey, threadId]);

  useEffect(
    () => () => {
      firstPage.current?.abort();
      nextPage.current?.abort();
      clearTimeout(turnEndRefresh.current);
    },
    [],
  );

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== "ready" || !current.nextCursor || current.loadingMore) {
      return;
    }
    nextPage.current?.abort();
    const controller = new AbortController();
    nextPage.current = controller;
    setState((latest) => ({ ...latest, loadingMore: true, loadMoreError: undefined }));
    const cursor = current.nextCursor;
    // The answer extends the list only while the list still ends where the
    // cursor continues: a refresh that replaced the history, or another
    // filter, made it stale.
    const continues = (latest: RunsState) =>
      latest.filter === current.filter && latest.nextCursor === cursor;
    store.api
      .listThreadAutomationRuns(threadId, {
        cursor,
        limit: AUTOMATION_RUNS_PAGE_SIZE,
        filter: current.filter,
        signal: controller.signal,
      })
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          setState((latest) => {
            if (!continues(latest)) return latest;
            const listed = new Set(latest.items.map(({ id }) => id));
            return {
              ...latest,
              items: [...latest.items, ...page.items.filter(({ id }) => !listed.has(id))],
              nextCursor: page.nextCursor,
              loadingMore: false,
            };
          });
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return;
          setState((latest) =>
            continues(latest)
              ? { ...latest, loadingMore: false, loadMoreError: messageFrom(reason) }
              : latest,
          );
        },
      );
  }, [store, threadId]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  const upsert = useCallback((run: ThreadAutomationRun) => {
    setState((current) => {
      if (current.status !== "ready" || !runMatchesFilter(run, current.filter)) {
        return current;
      }
      const index = current.items.findIndex(({ id }) => id === run.id);
      return {
        ...current,
        items: index >= 0 ? current.items.with(index, run) : [run, ...current.items],
      };
    });
  }, []);

  return {
    status: state.status,
    items: state.items,
    ...(state.counts ? { counts: state.counts } : {}),
    hasMore: state.nextCursor !== null,
    loadingMore: state.loadingMore,
    ...(state.error === undefined ? {} : { error: state.error }),
    ...(state.loadMoreError === undefined ? {} : { loadMoreError: state.loadMoreError }),
    arrived: state.arrived,
    loadMore,
    retry,
    upsert,
  };
}
