// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "./ApplicationClientStore.js";
import { useApplicationStoreSelector } from "./use-application-store-selector.js";

afterEach(cleanup);

function fakeStore(initial: Partial<ApplicationClientState>) {
  let state = { search: "", ...initial } as ApplicationClientState;
  const listeners = new Set<() => void>();
  return {
    store: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => state,
    } as unknown as ApplicationClientStore,
    publish(patch: Partial<ApplicationClientState>) {
      state = { ...state, ...patch };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

const selectSearch = (state: ApplicationClientState) => state.search;
const selectIds = (state: ApplicationClientState) =>
  state.visibleThreads.map(({ id }) => id);
const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

describe("useApplicationStoreSelector", () => {
  it("skips renders while the selection is unchanged", () => {
    const { store, publish } = fakeStore({ search: "alpha" });
    const renders = vi.fn();
    function Probe() {
      const search = useApplicationStoreSelector(store, selectSearch);
      renders(search);
      return <span data-testid="value">{search}</span>;
    }
    render(<Probe />);
    expect(renders).toHaveBeenCalledTimes(1);
    publish({ connection: "connected" });
    publish({ status: "ready" });
    expect(renders).toHaveBeenCalledTimes(1);
    publish({ search: "beta" });
    expect(renders).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("value")).toHaveTextContent("beta");
  });

  it("keeps the previous reference for an equal selection", () => {
    const { store, publish } = fakeStore({
      visibleThreads: [{ id: "a" }, { id: "b" }] as never,
    });
    const seen: (readonly string[])[] = [];
    function Probe() {
      const ids = useApplicationStoreSelector(store, selectIds, sameIds);
      seen.push(ids);
      return <span>{ids.join(",")}</span>;
    }
    render(<Probe />);
    // A fresh array with equal contents keeps the first selection.
    publish({ visibleThreads: [{ id: "a" }, { id: "b" }] as never });
    expect(seen).toHaveLength(1);
    publish({ visibleThreads: [{ id: "a" }] as never });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(["a"]);
  });

  it("passes the previous selection to the selector", () => {
    const { store, publish } = fakeStore({ search: "one" });
    const selector = vi.fn(
      (state: ApplicationClientState, previous: string | undefined) =>
        `${previous ?? "∅"}→${state.search}`,
    );
    function Probe() {
      return <span>{useApplicationStoreSelector(store, selector)}</span>;
    }
    render(<Probe />);
    publish({ search: "two" });
    expect(selector).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "two" }),
      "∅→one",
    );
  });
});
