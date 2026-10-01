// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NormalizedApplicationThreadSummary,
  ThreadArchiveImpact,
} from "../../shared/index.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { getBlockingOperation, runBlockingOperation } from "./blocking-operation.js";
import { getThreadArchiveOperations } from "./thread-archive.js";

afterEach(() => getBlockingOperation()?.dismiss());

const thread = { id: "source" } as NormalizedApplicationThreadSummary;
const impact: ThreadArchiveImpact = {
  descendantCount: 0,
  pendingQuestions: { root: 0, descendants: 0 },
  stashedPrompts: { root: 0, descendants: 0 },
  openTasks: {
    familySnapshot: "b".repeat(64),
    root: { snapshot: "a".repeat(64), items: [], total: 0, omitted: 0 },
    descendants: { snapshot: "a".repeat(64), items: [], total: 0, omitted: 0 },
  },
  executionWorkspace: { kind: "direct" },
  archiveOnly: { available: true },
  archiveAll: { available: true },
};

function fixture() {
  const store = {
    getThreadArchiveImpact: vi.fn(async () => impact),
    mutateInventory: vi.fn(async (): Promise<void> => undefined),
  };
  const operations = getThreadArchiveOperations(store as unknown as ApplicationClientStore);
  return { store, operations };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("direct archive checks", () => {
  it("does not navigate when an already-started archive completes after dismissal", async () => {
    const { store, operations } = fixture();
    const mutation = deferred<void>();
    store.mutateInventory.mockReturnValueOnce(mutation.promise);
    const onArchived = vi.fn();
    const onPendingChange = vi.fn();
    const operation = operations.start({ thread, onArchived, onPendingChange });
    await vi.waitFor(() => expect(store.mutateInventory).toHaveBeenCalledOnce());
    expect(getBlockingOperation()?.message).toBe("Archiving thread…");
    getBlockingOperation()!.dismiss();
    expect(getBlockingOperation()).toBeNull();
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
    mutation.resolve();
    await operation;
    expect(onArchived).not.toHaveBeenCalled();
    // Finishing detached work must not release controls owned by a later action.
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
    expect(operations.getSnapshot()).toEqual([]);
  });

  it("continues archiving when dismissed before the activity check completes", async () => {
    const { store, operations } = fixture();
    const check = deferred<ThreadArchiveImpact>();
    store.getThreadArchiveImpact.mockReturnValueOnce(check.promise);
    const onArchived = vi.fn();
    const operation = operations.start({ thread, onArchived });
    getBlockingOperation()!.dismiss();
    check.resolve(impact);
    await operation;
    expect(store.mutateInventory).toHaveBeenCalledExactlyOnceWith(thread, "archive", {
      expectedStashedPromptCount: 0,
    });
    expect(onArchived).not.toHaveBeenCalled();
    expect(getBlockingOperation()).toBeNull();
  });

  it.each(["check", "mutation"] as const)("retains a dismissed %s failure without disturbing newer progress", async (phase) => {
    const { store, operations } = fixture();
    const failure = deferred<never>();
    if (phase === "check") store.getThreadArchiveImpact.mockReturnValueOnce(failure.promise);
    else store.mutateInventory.mockReturnValueOnce(failure.promise);
    const operation = operations.start({ thread });
    if (phase === "mutation") await vi.waitFor(() => expect(store.mutateInventory).toHaveBeenCalledOnce());
    getBlockingOperation()!.dismiss();
    void runBlockingOperation({ message: "New operation", run: () => new Promise(() => {}) });
    failure.reject(new Error("Archive failed"));
    await operation;
    expect(operations.getSnapshot()[0]?.result).toEqual({ kind: "error", message: "Archive failed" });
    expect(getBlockingOperation()?.message).toBe("New operation");
  });

  it("reopens progress across entry points without duplicating a dismissed check or mutation", async () => {
    const { store, operations } = fixture();
    const check = deferred<ThreadArchiveImpact>();
    const mutation = deferred<void>();
    store.getThreadArchiveImpact.mockReturnValueOnce(check.promise);
    store.mutateInventory.mockReturnValueOnce(mutation.promise);
    const onArchived = vi.fn();
    const first = operations.start({ thread, onArchived });
    getBlockingOperation()!.dismiss();
    const anotherSurface = getThreadArchiveOperations(store as unknown as ApplicationClientStore);
    const reopenedCheck = anotherSurface.start({ thread, onArchived });
    expect(getBlockingOperation()?.message).toBe("Archiving thread…");
    expect(store.getThreadArchiveImpact).toHaveBeenCalledOnce();
    getBlockingOperation()!.dismiss();
    await reopenedCheck;
    check.resolve(impact);
    await vi.waitFor(() => expect(store.mutateInventory).toHaveBeenCalledOnce());
    const reopenedMutation = anotherSurface.start({ thread, onArchived });
    expect(getBlockingOperation()?.message).toBe("Archiving thread…");
    expect(store.getThreadArchiveImpact).toHaveBeenCalledOnce();
    mutation.resolve();
    await Promise.all([first, reopenedMutation]);
    expect(operations.getSnapshot()).toEqual([]);
    expect(getBlockingOperation()).toBeNull();
    expect(onArchived).not.toHaveBeenCalled();
  });

  it("retains authoritative choices and prevents reentry until those choices close", async () => {
    const { store, operations } = fixture();
    const freshImpact = { ...impact, descendantCount: 2 };
    store.getThreadArchiveImpact.mockResolvedValue(freshImpact);
    await operations.start({ thread });
    expect(operations.getSnapshot()[0]?.result).toEqual({ kind: "choices", impact: freshImpact });
    await operations.start({ thread });
    expect(store.getThreadArchiveImpact).toHaveBeenCalledOnce();
    expect(store.mutateInventory).not.toHaveBeenCalled();
    operations.closeResult(operations.getSnapshot()[0]!.id);
    await operations.start({ thread });
    expect(store.getThreadArchiveImpact).toHaveBeenCalledTimes(2);
  });

  it("isolates pending results between application connections with the same thread id", async () => {
    const first = fixture();
    const second = fixture();
    const check = deferred<ThreadArchiveImpact>();
    first.store.getThreadArchiveImpact.mockReturnValueOnce(check.promise);
    const pending = first.operations.start({ thread });
    getBlockingOperation()!.dismiss();
    await second.operations.start({ thread });
    expect(second.store.mutateInventory).toHaveBeenCalledOnce();
    check.resolve({ ...impact, descendantCount: 2 });
    await pending;
    expect(first.operations.getSnapshot()[0]?.result?.kind).toBe("choices");
    expect(second.operations.getSnapshot()).toEqual([]);
  });
});
