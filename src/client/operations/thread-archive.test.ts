// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BulkInventoryImpact,
  NormalizedApplicationThreadSummary,
  ThreadArchiveImpact,
} from "../../shared/index.js";
import { ApiError } from "../api/ApiClient.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { getBlockingOperation, runBlockingOperation } from "./blocking-operation.js";
import { getThreadArchiveOperations } from "./thread-archive.js";

afterEach(() => getBlockingOperation()?.dismiss());

const thread = { id: "source", inventoryRevision: 17 } as NormalizedApplicationThreadSummary;
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
    archiveThreads: vi.fn(async (): Promise<readonly string[]> => [thread.id]),
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
  it("checks the exact confirmed archive after a lost reply and trusts an empty receipt after restore", async () => {
    const { store, operations } = fixture();
    store.archiveThreads.mockRejectedValueOnce(new ApiError(503, "operation_outcome_uncertain", "Lost receipt", true))
      .mockResolvedValueOnce([]);
    const onArchived = vi.fn();
    const completion = operations.start({ thread, onArchived });
    await vi.waitFor(() => expect(getBlockingOperation()?.error).toBe("Lost receipt"));
    getBlockingOperation()!.retry!();
    await completion;
    expect(store.getThreadArchiveImpact).toHaveBeenCalledOnce();
    expect(store.archiveThreads.mock.calls).toEqual([
      [thread.id, {
        action: "archive", mutationId: expect.any(String), expectedRevision: 17,
        expectedStashedPromptCount: 0, expectedPendingQuestionCount: 0,
        expectedOpenTaskSnapshot: impact.openTasks.root.snapshot, executionWorkspaceDisposition: { kind: "keep" },
      }], store.archiveThreads.mock.calls[0],
    ]);
    expect(onArchived).toHaveBeenCalledExactlyOnceWith("only", []);
  });

  it("requires renewed confirmation after a conflict even when the fresh impact read has to retry", async () => {
    const { store, operations } = fixture();
    store.archiveThreads.mockRejectedValueOnce(new ApiError(409, "conflict", "Reviewed work changed", false));
    store.getThreadArchiveImpact.mockResolvedValueOnce(impact)
      .mockRejectedValueOnce(new TypeError("Read failed")).mockResolvedValueOnce(impact);
    const completion = operations.start({ thread });
    await vi.waitFor(() => expect(getBlockingOperation()?.error).toBe("Read failed"));
    getBlockingOperation()!.retry!();
    await completion;
    expect(operations.getSnapshot()[0]?.result).toEqual({ kind: "choices", impact });
    expect(store.archiveThreads).toHaveBeenCalledOnce();
    expect(operations.confirmed(thread.id)).toBeUndefined();
  });

  it("does not navigate when an already-started archive completes after dismissal", async () => {
    const { store, operations } = fixture();
    const mutation = deferred<readonly string[]>();
    store.archiveThreads.mockReturnValueOnce(mutation.promise);
    const onArchived = vi.fn();
    const onPendingChange = vi.fn();
    const operation = operations.start({ thread, onArchived, onPendingChange });
    await vi.waitFor(() => expect(store.archiveThreads).toHaveBeenCalledOnce());
    expect(getBlockingOperation()?.message).toBe("Archiving thread…");
    getBlockingOperation()!.dismiss();
    expect(getBlockingOperation()).toBeNull();
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
    mutation.resolve([thread.id]);
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
    expect(store.archiveThreads).toHaveBeenCalledExactlyOnceWith(
      thread.id,
      expect.objectContaining({
        action: "archive",
        expectedStashedPromptCount: 0,
      }),
    );
    expect(onArchived).not.toHaveBeenCalled();
    expect(getBlockingOperation()).toBeNull();
  });

  it.each(["check", "mutation"] as const)("retains a dismissed %s failure without disturbing newer progress", async (phase) => {
    const { store, operations } = fixture();
    const failure = deferred<never>();
    if (phase === "check") store.getThreadArchiveImpact.mockReturnValueOnce(failure.promise);
    else store.archiveThreads.mockReturnValueOnce(failure.promise);
    const operation = operations.start({ thread });
    if (phase === "mutation") await vi.waitFor(() => expect(store.archiveThreads).toHaveBeenCalledOnce());
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
    const mutation = deferred<readonly string[]>();
    store.getThreadArchiveImpact.mockReturnValueOnce(check.promise);
    store.archiveThreads.mockReturnValueOnce(mutation.promise);
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
    await vi.waitFor(() => expect(store.archiveThreads).toHaveBeenCalledOnce());
    const reopenedMutation = anotherSurface.start({ thread, onArchived });
    expect(getBlockingOperation()?.message).toBe("Archiving thread…");
    expect(store.getThreadArchiveImpact).toHaveBeenCalledOnce();
    mutation.resolve([thread.id]);
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
    expect(store.archiveThreads).not.toHaveBeenCalled();
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
    expect(second.store.archiveThreads).toHaveBeenCalledOnce();
    check.resolve({ ...impact, descendantCount: 2 });
    await pending;
    expect(first.operations.getSnapshot()[0]?.result?.kind).toBe("choices");
    expect(second.operations.getSnapshot()).toEqual([]);
  });
});

describe("confirmed stack archives", () => {
  it("shares one pending request across remounts and rechecks its original members and choices after transport loss", async () => {
    const stackImpact: BulkInventoryImpact = {
      action: "archive", targets: [{ threadId: "a", expectedRevision: 1 }], targetCount: 1,
      affectedCount: 1, unchangedCount: 0, pendingQuestionCount: 2, stashedPromptCount: 0,
      blockers: { items: [], total: 0, omitted: 0 }, openTasks: impact.openTasks.root, available: true,
    };
    const request = {
      action: "archive" as const, targets: stackImpact.targets, mutationId: crypto.randomUUID(),
      expectedPendingQuestionCount: 2, expectedOpenTaskCount: 0, expectedStashedPromptCount: 0,
      expectedOpenTaskSnapshot: stackImpact.openTasks.snapshot,
    };
    const held = deferred<{ changedThreadIds: string[] }>();
    const mutateBulkInventory = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValueOnce({ changedThreadIds: [] });
    const store = { mutateBulkInventory } as unknown as ApplicationClientStore;
    const original = getThreadArchiveOperations(store).submitStack("stack", stackImpact, request);
    const remounted = getThreadArchiveOperations(store);
    const changed = { ...request, mutationId: crypto.randomUUID(), targets: [{ threadId: "b", expectedRevision: 5 }] };
    expect(remounted.submitStack("stack", stackImpact, changed)).toBe(original);
    held.reject(new TypeError("Lost response"));
    await expect(original).rejects.toThrow("Lost response");
    expect(remounted.stack("stack")?.request).toBe(request);
    expect(await remounted.submitStack("stack", stackImpact, changed)).toEqual({ changedThreadIds: [] });
    expect(mutateBulkInventory.mock.calls).toEqual([[request], [request]]);
    expect(remounted.stack("stack")).toBeUndefined();
  });
});
