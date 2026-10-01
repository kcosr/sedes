// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NormalizedApplicationThreadSummary,
  ThreadArchiveImpact,
} from "../../shared/index.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { getBlockingOperation, runBlockingOperation } from "./blocking-operation.js";
import { runThreadArchiveCheck } from "./thread-archive.js";

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

describe("direct archive checks", () => {
  it("does not navigate when an already-started archive completes after dismissal", async () => {
    let finish!: () => void;
    const mutation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const mutateInventory = vi.fn(() => mutation);
    const onArchived = vi.fn();
    const operation = runThreadArchiveCheck({
      thread,
      store: {
        getThreadArchiveImpact: vi.fn(async () => impact),
        mutateInventory,
      } as unknown as ApplicationClientStore,
      onChoices: vi.fn(),
      onDismissedError: vi.fn(),
      onArchived,
    });
    expect(getBlockingOperation()?.message).toBe("Archiving thread…");
    await vi.waitFor(() => expect(mutateInventory).toHaveBeenCalledOnce());
    expect(getBlockingOperation()?.message).toBe("Archiving thread…");
    getBlockingOperation()!.dismiss();
    expect(getBlockingOperation()).toBeNull();
    finish();
    await operation;
    await mutation;
    await Promise.resolve();
    expect(onArchived).not.toHaveBeenCalled();
  });

  it("continues archiving when dismissed before the activity check completes", async () => {
    let answer!: (value: ThreadArchiveImpact) => void;
    const check = new Promise<ThreadArchiveImpact>((resolve) => { answer = resolve; });
    const mutateInventory = vi.fn(async () => undefined);
    const onArchived = vi.fn();
    const operation = runThreadArchiveCheck({
      thread,
      store: {
        getThreadArchiveImpact: vi.fn(() => check),
        mutateInventory,
      } as unknown as ApplicationClientStore,
      onChoices: vi.fn(),
      onArchived,
      onDismissedError: vi.fn(),
    });
    expect(getBlockingOperation()?.message).toBe("Archiving thread…");
    getBlockingOperation()!.dismiss();
    answer(impact);
    await operation;
    expect(mutateInventory).toHaveBeenCalledExactlyOnceWith(thread, "archive", {
      expectedStashedPromptCount: 0,
    });
    expect(onArchived).not.toHaveBeenCalled();
    expect(getBlockingOperation()).toBeNull();
  });

  it.each(["check", "mutation"] as const)("reports a dismissed %s failure without disturbing newer progress", async (phase) => {
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { fail = reject; });
    const mutateInventory = vi.fn(() => failure);
    const onDismissedError = vi.fn();
    const operation = runThreadArchiveCheck({
      thread,
      store: {
        getThreadArchiveImpact: vi.fn(() => phase === "check" ? failure : Promise.resolve(impact)),
        mutateInventory,
      } as unknown as ApplicationClientStore,
      onChoices: vi.fn(),
      onArchived: vi.fn(),
      onDismissedError,
    });
    if (phase === "mutation") await vi.waitFor(() => expect(mutateInventory).toHaveBeenCalledOnce());
    getBlockingOperation()!.dismiss();
    void runBlockingOperation({ message: "New operation", run: () => new Promise(() => {}) });
    const error = new Error("Archive failed");
    fail(error);
    await operation;
    expect(onDismissedError).toHaveBeenCalledExactlyOnceWith(error);
    expect(getBlockingOperation()?.message).toBe("New operation");
  });

  it("hands authoritative newly discovered descendants directly to confirmation", async () => {
    const freshImpact = { ...impact, descendantCount: 2 };
    const mutateInventory = vi.fn();
    const onChoices = vi.fn();
    await runThreadArchiveCheck({
      thread,
      store: {
        getThreadArchiveImpact: vi.fn(async () => freshImpact),
        mutateInventory,
      } as unknown as ApplicationClientStore,
      onChoices,
      onDismissedError: vi.fn(),
      onArchived: vi.fn(),
    });
    expect(onChoices).toHaveBeenCalledWith(freshImpact);
    expect(mutateInventory).not.toHaveBeenCalled();
  });
});
