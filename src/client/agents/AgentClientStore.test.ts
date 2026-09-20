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
});
