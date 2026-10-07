import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import type { ApplicationClientState } from "../stores/ApplicationClientStore.js";

/**
 * The thread summaries the client holds. The application snapshot is a
 * bootstrap that bounds fork summaries (the server's
 * MAXIMUM_APPLICATION_BOOTSTRAP_FORKS per environment); the sidebar loads
 * further fork descendants page by page into `descendantPages`. The
 * snapshot's copy of a thread is the live one (a thread update adds a fork
 * to it), so it wins over a loaded page's copy, which is as of its load.
 */
type LoadedThreadsState = Pick<
  ApplicationClientState,
  "snapshot" | "descendantPages"
>;

const NO_THREADS: readonly NormalizedApplicationThreadSummary[] = [];

/** Loaded fork summaries the snapshot does not hold, each once. */
export function loadedDescendantThreads(
  state: LoadedThreadsState,
): readonly NormalizedApplicationThreadSummary[] {
  const pages = Object.values(state.descendantPages);
  if (pages.length === 0) return NO_THREADS;
  const held = new Set(state.snapshot?.threads.map(({ id }) => id));
  const threads: NormalizedApplicationThreadSummary[] = [];
  for (const { descendants } of pages) {
    for (const { thread } of descendants) {
      if (held.has(thread.id)) continue;
      held.add(thread.id);
      threads.push(thread);
    }
  }
  return threads.length === 0 ? NO_THREADS : threads;
}

/** A thread's summary from the snapshot, else from the loaded fork descendants. */
export function findLoadedThread(
  state: LoadedThreadsState,
  threadId: string,
): NormalizedApplicationThreadSummary | undefined {
  const held = state.snapshot?.threads.find(({ id }) => id === threadId);
  if (held) return held;
  for (const { descendants } of Object.values(state.descendantPages)) {
    const loaded = descendants.find(({ thread }) => thread.id === threadId);
    if (loaded) return loaded.thread;
  }
  return undefined;
}
