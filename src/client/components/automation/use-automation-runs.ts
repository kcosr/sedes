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

/** Pages of the list's size that hold `runs` runs; at least the first. */
function pagesFor(runs: number): number {
  return Math.max(1, Math.ceil(runs / AUTOMATION_RUNS_PAGE_SIZE));
}

/**
 * Reads a filter's run history from its start, a page of the list's size at
 * a time (a cursor is only valid for the page size it was made with), until
 * it has read `pages()` pages or the history ends. Each page continues the
 * one before by cursor, so the result is a true prefix of the history with
 * the cursor that continues it. `pages` is read after every page, so a Load
 * more asked for meanwhile extends the read.
 */
async function readHistoryPrefix(
  api: RunsApi,
  threadId: string,
  filter: AutomationRunFilter,
  pages: () => number,
  signal: AbortSignal,
): Promise<HistoryPrefix> {
  const items: ThreadAutomationRun[] = [];
  const read = new Set<string>();
  let cursor: string | null = null;
  let counts: ThreadAutomationRunCounts | undefined;
  let pagesRead = 0;
  do {
    const page: ThreadAutomationRunPage = await api.listThreadAutomationRuns(threadId, {
      ...(cursor === null ? {} : { cursor }),
      limit: AUTOMATION_RUNS_PAGE_SIZE,
      filter,
      signal,
    });
    pagesRead += 1;
    if (cursor === null) counts = page.counts;
    for (const run of page.items) {
      if (read.has(run.id)) continue;
      read.add(run.id);
      items.push(run);
    }
    cursor = page.nextCursor;
  } while (cursor !== null && pagesRead < pages());
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
 * Every read of the history from its start has one owner: the first load (one
 * page), a retry, and each refresh. Starting one aborts the one before, so
 * only the newest can land. A refresh reconciles everything listed, not just
 * the first page: any run may have changed, an older one settling its turn
 * or gaining its times, and in Problems an older run may newly match. It
 * reads the pages that hold as many runs as are listed (one request while
 * only the first page is), then replaces the list and its cursor at once.
 * Revisions that move during a read make one more read after it. A Load more
 * in flight may predate the change, so a refresh aborts it and reads its
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
  const nextPage = useRef<AbortController | undefined>(undefined);
  /** The read of the history from its start in flight: its owner. */
  const reading = useRef<
    | { readonly controller: AbortController; pages: number; again: boolean }
    | undefined
  >(undefined);
  const [attempt, setAttempt] = useState(0);

  /**
   * Reads the history from its start, the pages that hold `listed` runs, in
   * place of any read in flight. Before the list is ready the answer starts
   * it; after, it replaces what is listed. When the revision moved meanwhile
   * it reads once more, covering the runs it just listed (taken from its own
   * result: React has not rendered them into the state ref yet).
   */
  const readHistory = useCallback(
    function read(listed: number): void {
      reading.current?.controller.abort();
      const pass = { controller: new AbortController(), pages: pagesFor(listed), again: false };
      reading.current = pass;
      readHistoryPrefix(store.api, threadId, filter, () => pass.pages, pass.controller.signal).then(
        (prefix) => {
          if (pass.controller.signal.aborted) return;
          reading.current = undefined;
          setState((latest) =>
            latest.status === "ready"
              ? {
                  ...latest,
                  items: prefix.items,
                  nextCursor: prefix.nextCursor,
                  counts: prefix.counts ?? latest.counts,
                  arrived: arrivedRuns(latest.items, prefix.items),
                  loadingMore: false,
                  loadMoreError: undefined,
                }
              : {
                  ...emptyState(filter, "ready"),
                  items: prefix.items,
                  nextCursor: prefix.nextCursor,
                  ...(prefix.counts ? { counts: prefix.counts } : {}),
                },
          );
          if (pass.again) read(prefix.items.length);
        },
        (reason: unknown) => {
          if (pass.controller.signal.aborted) return;
          reading.current = undefined;
          // A failed refresh keeps the listed runs; the next one retries. A
          // Load more it read for reports the failure.
          setState((latest) =>
            latest.status !== "ready"
              ? { ...emptyState(filter, "error"), error: messageFrom(reason) }
              : latest.loadingMore
                ? { ...latest, loadingMore: false, loadMoreError: messageFrom(reason) }
                : latest,
          );
          if (pass.again) read(listed);
        },
      );
    },
    [filter, store, threadId],
  );

  // A new thread, filter or automation starts the list over.
  useEffect(() => {
    nextPage.current?.abort();
    if (!present) {
      reading.current?.controller.abort();
      reading.current = undefined;
      setState(emptyState(filter, "idle"));
      return;
    }
    setState(emptyState(filter, "loading"));
    readHistory(0);
  }, [attempt, filter, present, readHistory]);

  const observedKey = useRef(liveKey);
  useEffect(() => {
    const previous = observedKey.current;
    observedKey.current = liveKey;
    if (previous === liveKey || previous === undefined || liveKey === undefined) {
      return;
    }
    // A read in flight, the first load included, reads once more after it.
    if (reading.current) {
      reading.current.again = true;
      return;
    }
    // With no read in flight the state ref is current. A Load more in flight
    // may have been answered before the change; the refresh reads its page.
    const current = stateRef.current;
    if (current.loadingMore) nextPage.current?.abort();
    readHistory(current.items.length + (current.loadingMore ? AUTOMATION_RUNS_PAGE_SIZE : 0));
  }, [liveKey, readHistory]);

  useEffect(
    () => () => {
      reading.current?.controller.abort();
      nextPage.current?.abort();
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
    const inFlight = reading.current;
    if (inFlight) {
      inFlight.pages = Math.max(
        inFlight.pages,
        pagesFor(current.items.length + AUTOMATION_RUNS_PAGE_SIZE),
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
