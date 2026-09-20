import { describe, expect, it, vi } from "vitest";
import type {
  CannedPromptLibrary,
  CannedPromptMutationResult,
} from "../../shared/protocol/canned-prompts.js";
import { ApiError, type ApiClient } from "../api/ApiClient.js";
import { CannedPromptClientStore } from "./CannedPromptClientStore.js";

const firstId = "10000000-0000-4000-8000-000000000001";
const secondId = "10000000-0000-4000-8000-000000000002";

function library(
  revision: number,
  titles: readonly string[],
): CannedPromptLibrary {
  return {
    revision,
    items: titles.map((title, position) => ({
      id: position === 0 ? firstId : secondId,
      title,
      text: `${title} text`,
      position,
      createdAt: 1,
      updatedAt: revision + 1,
    })),
  };
}

function mutationResult(
  revision: number,
  titles: readonly string[],
): CannedPromptMutationResult {
  return { ...library(revision, titles), replayed: false };
}

describe("CannedPromptClientStore", () => {
  it("loads lazily and shares one in-flight initial read", async () => {
    const expected = library(2, ["Review"]);
    const api = {
      listCannedPrompts: vi.fn().mockResolvedValue(expected),
    } as unknown as ApiClient;
    const store = new CannedPromptClientStore(api);

    expect(api.listCannedPrompts).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({
      status: "loading",
      library: { revision: 0, items: [] },
    });

    const first = store.load();
    const second = store.load();
    await Promise.all([first, second]);

    expect(api.listCannedPrompts).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({
      status: "ready",
      library: expected,
      updateAvailable: false,
      pendingMutation: false,
    });
  });

  it("stages a newer revision until the client deliberately applies it", async () => {
    const initial = library(1, ["Original"]);
    const current = library(2, ["Changed elsewhere"]);
    const api = {
      listCannedPrompts: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(current),
    } as unknown as ApiClient;
    const store = new CannedPromptClientStore(api);
    await store.load();

    await store.revalidate();

    expect(store.getSnapshot()).toMatchObject({
      library: initial,
      updateAvailable: true,
    });
    expect(store.applyAvailableUpdate()).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      library: current,
      updateAvailable: false,
    });
    expect(store.applyAvailableUpdate()).toBe(false);

    await store.revalidate();
    expect(store.getSnapshot()).toMatchObject({
      library: current,
      updateAvailable: false,
    });
  });

  it("admits only the newest overlapping refresh", async () => {
    let resolveFirst!: (value: CannedPromptLibrary) => void;
    let resolveSecond!: (value: CannedPromptLibrary) => void;
    const api = {
      listCannedPrompts: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<CannedPromptLibrary>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<CannedPromptLibrary>((resolve) => {
              resolveSecond = resolve;
            }),
        ),
    } as unknown as ApiClient;
    const store = new CannedPromptClientStore(api);

    const stale = store.load();
    const fresh = store.refresh();
    resolveSecond(library(3, ["Fresh"]));
    await fresh;
    resolveFirst(library(1, ["Stale"]));
    await stale;

    expect(store.getSnapshot().library).toEqual(library(3, ["Fresh"]));
  });

  it("serializes mutations against the latest exact server result", async () => {
    const created = mutationResult(1, ["Review"]);
    const updated = mutationResult(2, ["Careful review"]);
    const api = {
      listCannedPrompts: vi.fn().mockResolvedValue(library(0, [])),
      createCannedPrompt: vi.fn().mockResolvedValue(created),
      updateCannedPrompt: vi.fn().mockResolvedValue(updated),
    } as unknown as ApiClient;
    const store = new CannedPromptClientStore(api);

    const create = store.create({ title: "Review", text: "Review text" });
    const update = store.update(firstId, {
      title: "Careful review",
      text: "Careful review text",
    });

    await expect(create).resolves.toEqual(created);
    await expect(update).resolves.toEqual(updated);
    expect(api.createCannedPrompt).toHaveBeenCalledWith(
      {
        title: "Review",
        text: "Review text",
        expectedRevision: 0,
        mutationId: expect.any(String),
      },
      expect.any(AbortSignal),
    );
    expect(api.updateCannedPrompt).toHaveBeenCalledWith(
      firstId,
      {
        title: "Careful review",
        text: "Careful review text",
        expectedRevision: 1,
        mutationId: expect.any(String),
      },
      expect.any(AbortSignal),
    );
    expect(store.getSnapshot()).toEqual({
      status: "ready",
      library: { revision: 2, items: updated.items },
      updateAvailable: false,
      pendingMutation: false,
    });
  });

  it("refetches an authoritative library after a revision conflict", async () => {
    const current = library(5, ["Other tab"]);
    const conflict = new ApiError(
      409,
      "conflict",
      "The canned prompt library changed.",
      false,
    );
    const api = {
      listCannedPrompts: vi
        .fn()
        .mockResolvedValueOnce(library(1, ["Original"]))
        .mockResolvedValueOnce(current),
      deleteCannedPrompt: vi.fn().mockRejectedValue(conflict),
    } as unknown as ApiClient;
    const store = new CannedPromptClientStore(api);
    await store.load();

    await expect(store.delete(firstId)).rejects.toBe(conflict);

    expect(api.deleteCannedPrompt).toHaveBeenCalledWith(
      firstId,
      {
        expectedRevision: 1,
        mutationId: expect.any(String),
      },
      expect.any(AbortSignal),
    );
    expect(api.listCannedPrompts).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({
      status: "ready",
      library: current,
      updateAvailable: false,
      pendingMutation: false,
    });
  });

  it("aborts work and ignores late publication after disposal", async () => {
    let resolve!: (value: CannedPromptLibrary) => void;
    let observedSignal: AbortSignal | undefined;
    const api = {
      listCannedPrompts: vi.fn((signal: AbortSignal) => {
        observedSignal = signal;
        return new Promise<CannedPromptLibrary>((done) => {
          resolve = done;
        });
      }),
    } as unknown as ApiClient;
    const store = new CannedPromptClientStore(api);
    const listener = vi.fn();
    store.subscribe(listener);

    const pending = store.load();
    store.dispose();
    expect(observedSignal?.aborted).toBe(true);
    resolve(library(9, ["Late"]));
    await pending;

    expect(store.getSnapshot().library).toEqual(library(0, []));
    const callsAtDispose = listener.mock.calls.length;
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(callsAtDispose);
  });
});
