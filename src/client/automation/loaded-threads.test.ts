import { describe, expect, it } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import type { ApplicationClientState } from "../stores/ApplicationClientStore.js";
import { findLoadedThread, loadedDescendantThreads } from "./loaded-threads.js";

function thread(id: string, title = id): NormalizedApplicationThreadSummary {
  return { id, title: { text: title } } as NormalizedApplicationThreadSummary;
}

function state(
  held: readonly NormalizedApplicationThreadSummary[] | undefined,
  pages: Record<string, readonly NormalizedApplicationThreadSummary[]> = {},
): Pick<ApplicationClientState, "snapshot" | "descendantPages"> {
  return {
    snapshot: held ? ({ threads: held } as ApplicationClientState["snapshot"]) : undefined,
    descendantPages: Object.fromEntries(
      Object.entries(pages).map(([root, threads]) => [
        root,
        { descendants: threads.map((loaded) => ({ thread: loaded })), loading: false, loaded: true },
      ]),
    ) as unknown as ApplicationClientState["descendantPages"],
  };
}

describe("loaded threads", () => {
  it("lists loaded forks the snapshot does not hold, each once", () => {
    const loaded = state([thread("root"), thread("live-fork")], {
      root: [thread("fork-a"), thread("live-fork", "Stale copy")],
      other: [thread("fork-a"), thread("fork-b")],
    });
    expect(loadedDescendantThreads(loaded).map(({ id }) => id)).toEqual(["fork-a", "fork-b"]);
    expect(loadedDescendantThreads(state([thread("root")]))).toHaveLength(0);
  });

  it("finds a thread in the snapshot first, then among the loaded forks", () => {
    const loaded = state([thread("root"), thread("live-fork", "Live")], {
      root: [thread("live-fork", "Stale copy"), thread("fork-a", "Loaded")],
    });
    expect(findLoadedThread(loaded, "live-fork")?.title.text).toBe("Live");
    expect(findLoadedThread(loaded, "fork-a")?.title.text).toBe("Loaded");
    expect(findLoadedThread(loaded, "elsewhere")).toBeUndefined();
    expect(findLoadedThread(state(undefined, { root: [thread("fork-a")] }), "fork-a")?.id).toBe("fork-a");
  });
});
