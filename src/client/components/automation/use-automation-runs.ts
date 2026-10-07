import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ThreadAutomationRun,
  ThreadAutomationRunCounts,
  ThreadAutomationRunPage,
} from "../../../shared/protocol/automation-presentation.js";
import type { AutomationRunFilter } from "../../../shared/protocol/domain.js";
import {
  messageFrom,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { automationRunsKey, type AutomationThread } from "./use-automation-thread.js";

/** Runs per page, for the first page and for each "Load more". */
export const AUTOMATION_RUNS_PAGE_SIZE = 25;

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

type RunsApi = Pick<ApplicationClientStore["api"], "listThreadAutomationRuns">;

interface HistoryPrefix {
  readonly items: readonly ThreadAutomationRun[];
  readonly nextCursor: string | null;
  readonly counts?: ThreadAutomationRunCounts;
}

/**
 * Reads a filter's run history again from its start, a page of the list's
 * size at a time (a cursor is only valid for the page size it was made
 * with), until the pages hold at least `target()` runs or the history ends.
 * Each page continues the one before by cursor, so the result is a true
 * prefix of the history with the cursor that continues it. `target` is read
 * after every page, so a Load more asked for meanwhile extends the read.
 */
async function readHistoryPrefix(
  api: RunsApi,
  threadId: string,
  filter: AutomationRunFilter,
  target: () => number,
  signal: AbortSignal,
): Promise<HistoryPrefix> {
  const items: ThreadAutomationRun[] = [];
  const read = new Set<string>();
  let cursor: string | null = null;
  let counts: ThreadAutomationRunCounts | undefined;
  do {
    const page: ThreadAutomationRunPage = await api.listThreadAutomationRuns(threadId, {
      ...(cursor === null ? {} : { cursor }),
      limit: AUTOMATION_RUNS_PAGE_SIZE,
      filter,
      signal,
    });
    if (cursor === null) counts = page.counts;
    for (const run of page.items) {
      if (read.has(run.id)) continue;
      read.add(run.id);
      items.push(run);
    }
    cursor = page.nextCursor;
  } while (cursor !== null && items.length < target());
  return { items, nextCursor: cursor, ...(counts ? { counts } : {}) };
}

/**
 * The runs a refreshed history lists newly above everything it listed
 * before: runs that arrived. A run that newly matches the filter further
 * down (an older turn that failed, in Problems) did not arrive.
 */
function arrivedRuns(
  listed: readonly ThreadAutomationRun[],
  refreshed: readonly ThreadAutomationRun[],
): readonly ThreadAutomationRun[] {
  const before = new Set(listed.map(({ id }) => id));
  const firstListed = refreshed.findIndex(({ id }) => before.has(id));
  return (firstListed < 0 ? refreshed : refreshed.slice(0, firstListed)).filter(
    ({ id }) => !before.has(id),
  );
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
 * One automation's run history for a filter: the first page with the
 * whole-history counts, cursor paging, and a live refresh whenever the live
 * thread summary's run-history revision moves (the server advances it, and
 * publishes a thread update, for every presented run change).
 *
 * A refresh reconciles everything listed, not just the first page: any run
 * may have changed, an older one settling its turn or gaining its times, and
 * in Problems an older run may newly match. It reads the history again from
 * its start until it covers as many runs as are listed (one request while
 * only the first page is), then replaces the list and its cursor at once.
 * Revisions that move during a refresh make one more refresh after it. A
 * Load more in flight may predate the change, so the refresh takes over its
 * page, as it does for a Load more asked for while it runs.
 */
export function useAutomationRuns(
  store: Pick<ApplicationClientStore, "api">,
  thread: Pick<AutomationThread, "id" | "automation">,
  filter: AutomationRunFilter,
): AutomationRuns {
  const threadId = thread.id;
  const liveKey = automationRunsKey(thread.automation);
  const present = liveKey !== undefined;
  const [state, setState] = useState<RunsState>(() =>
    emptyState(filter, present ? "loading" : "idle"),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const firstPage = useRef<AbortController | undefined>(undefined);
  const nextPage = useRef<AbortController | undefined>(undefined);
  /** The refresh in flight: the runs it must cover, and whether to run again. */
  const refreshing = useRef<
    | { readonly controller: AbortController; target: number; again: boolean }
    | undefined
  >(undefined);
  const [attempt, setAttempt] = useState(0);

  const loadFirstPage = useCallback(() => {
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
          setState((current) =>
            current.filter !== filter
              ? current
              : {
                  ...emptyState(filter, "ready"),
                  items: page.items,
                  nextCursor: page.nextCursor,
                  ...(page.counts ? { counts: page.counts } : {}),
                },
          );
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return;
          setState({ ...emptyState(filter, "error"), error: messageFrom(reason) });
        },
      );
  }, [filter, store, threadId]);

  const refresh = useCallback(() => {
    const current = stateRef.current;
    // Before the list is ready, its first page is read again instead.
    if (current.status !== "ready") {
      loadFirstPage();
      return;
    }
    if (refreshing.current) {
      refreshing.current.again = true;
      return;
    }
    // A pass covers `listed` runs. When the revision moved meanwhile it runs
    // once more, covering the runs it just listed (taken from its own result:
    // React has not rendered them into the state ref yet).
    const pass = (listed: number) => {
      const read = {
        controller: new AbortController(),
        target: Math.max(listed, AUTOMATION_RUNS_PAGE_SIZE),
        again: false,
      };
      refreshing.current = read;
      readHistoryPrefix(store.api, threadId, filter, () => read.target, read.controller.signal).then(
        (prefix) => {
          if (read.controller.signal.aborted) return;
          setState((latest) =>
            latest.filter !== filter || latest.status !== "ready"
              ? latest
              : {
                  ...latest,
                  items: prefix.items,
                  nextCursor: prefix.nextCursor,
                  counts: prefix.counts ?? latest.counts,
                  arrived: arrivedRuns(latest.items, prefix.items),
                  loadingMore: false,
                  loadMoreError: undefined,
                },
          );
          refreshing.current = undefined;
          if (read.again) pass(prefix.items.length);
        },
        (reason: unknown) => {
          if (read.controller.signal.aborted) return;
          // A failed refresh keeps the listed runs; the next one retries. A
          // Load more it read for reports the failure.
          setState((latest) =>
            latest.loadingMore
              ? { ...latest, loadingMore: false, loadMoreError: messageFrom(reason) }
              : latest,
          );
          refreshing.current = undefined;
          if (read.again) pass(listed);
        },
      );
    };
    // A Load more in flight may have been answered before the change; the
    // refresh reads its page instead.
    if (current.loadingMore) nextPage.current?.abort();
    pass(current.items.length + (current.loadingMore ? AUTOMATION_RUNS_PAGE_SIZE : 0));
  }, [filter, loadFirstPage, store, threadId]);

  // A new thread, filter or automation starts the list over.
  useEffect(() => {
    nextPage.current?.abort();
    refreshing.current?.controller.abort();
    refreshing.current = undefined;
    if (!present) {
      firstPage.current?.abort();
      setState(emptyState(filter, "idle"));
      return;
    }
    setState(emptyState(filter, "loading"));
    loadFirstPage();
  }, [attempt, filter, loadFirstPage, present]);

  const observedKey = useRef(liveKey);
  useEffect(() => {
    const previous = observedKey.current;
    observedKey.current = liveKey;
    if (previous === liveKey || previous === undefined || liveKey === undefined) {
      return;
    }
    refresh();
  }, [liveKey, refresh]);

  useEffect(
    () => () => {
      firstPage.current?.abort();
      nextPage.current?.abort();
      refreshing.current?.controller.abort();
    },
    [],
  );

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== "ready" || !current.nextCursor || current.loadingMore) {
      return;
    }
    setState((latest) => ({ ...latest, loadingMore: true, loadMoreError: undefined }));
    // A refresh in flight reads the next page with the rest.
    const inFlight = refreshing.current;
    if (inFlight) {
      inFlight.target = Math.max(
        inFlight.target,
        current.items.length + AUTOMATION_RUNS_PAGE_SIZE,
      );
      return;
    }
    // The answer continues the list as it is now: a refresh, another filter
    // or another thread aborts it first.
    const controller = new AbortController();
    nextPage.current = controller;
    store.api
      .listThreadAutomationRuns(threadId, {
        cursor: current.nextCursor,
        limit: AUTOMATION_RUNS_PAGE_SIZE,
        filter: current.filter,
        signal: controller.signal,
      })
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          setState((latest) => {
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
          setState((latest) => ({
            ...latest,
            loadingMore: false,
            loadMoreError: messageFrom(reason),
          }));
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
