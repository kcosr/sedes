import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/ApiClient.js";
import { AgentClientStore } from "./AgentClientStore.js";

describe("AgentClientStore", () => {
  it("fetches only when opened and appends paginated results", async () => {
    const listSavedAgents = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: "a" }],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({ items: [{ id: "b" }] });
    const store = new AgentClientStore({
      listSavedAgents,
    } as unknown as ApiClient);

    expect(listSavedAgents).not.toHaveBeenCalled();
    await store.open();
    expect(store.getSnapshot().items).toEqual([{ id: "a" }]);
    await store.loadMore();
    expect(store.getSnapshot().items).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("ignores a stale search response", async () => {
    let finishFirst!: (value: { items: [] }) => void;
    const listSavedAgents = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ items: [] }>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ items: [{ id: "current" }] });
    const store = new AgentClientStore({
      listSavedAgents,
    } as unknown as ApiClient);

    const first = store.refresh("old");
    await store.refresh("new");
    finishFirst({ items: [] });
    await first;
    expect(store.getSnapshot().items).toEqual([{ id: "current" }]);
    expect(store.getSnapshot().search).toBe("new");
  });

  it("keeps a failed Agent load apart from the list, until another Agent or a successful retry", async () => {
    const agent = { id: "a", name: "A" };
    const getSavedAgent = vi.fn()
      .mockRejectedValueOnce(new Error("Gone"))
      .mockRejectedValueOnce(new Error("Still gone"))
      .mockResolvedValueOnce(agent)
      .mockRejectedValueOnce(new Error("Gone too"));
    const store = new AgentClientStore({
      getSavedAgent,
      listSavedAgents: vi.fn().mockResolvedValue({ items: [{ id: "b" }] }),
    } as unknown as ApiClient);

    const first = store.loadAgent("a");
    expect(store.getSnapshot().detail).toEqual({ status: "loading", agentId: "a" });
    await first;
    expect(store.getSnapshot().detail).toEqual({ status: "error", agentId: "a", error: "Gone", retrying: false });
    // A list refresh clears only the list's error.
    await store.refresh();
    expect(store.getSnapshot().error).toBeUndefined();
    expect(store.getSnapshot().detail).toEqual({ status: "error", agentId: "a", error: "Gone", retrying: false });
    // A retry keeps the failure until it succeeds.
    const retry = store.loadAgent("a");
    expect(store.getSnapshot().detail).toEqual({ status: "error", agentId: "a", error: "Gone", retrying: true });
    await retry;
    expect(store.getSnapshot().detail).toEqual({ status: "error", agentId: "a", error: "Still gone", retrying: false });
    await store.loadAgent("a");
    expect(store.getSnapshot().detail).toEqual({ status: "ready", agentId: "a", agent });
    // Another Agent starts from loading, not from this one's state.
    const other = store.loadAgent("c");
    expect(store.getSnapshot().detail).toEqual({ status: "loading", agentId: "c" });
    await other;
    expect(store.getSnapshot().detail).toMatchObject({ status: "error", agentId: "c", error: "Gone too" });
    store.clearSelection();
    expect(store.getSnapshot().detail).toEqual({ status: "none" });
  });

  it("ignores a stale Agent load once another Agent is asked for", async () => {
    let finishFirst!: (value: unknown) => void;
    const getSavedAgent = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ id: "b" });
    const store = new AgentClientStore({ getSavedAgent } as unknown as ApiClient);
    const first = store.loadAgent("a");
    await store.loadAgent("b");
    finishFirst({ id: "a" });
    await first;
    expect(store.getSnapshot().detail).toEqual({ status: "ready", agentId: "b", agent: { id: "b" } });
  });
});
