// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NormalizedApplicationThreadSummary,
  ThreadArchiveImpact,
} from "../../shared/index.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { getBlockingOperation } from "./blocking-operation.js";
import { runThreadArchiveCheck } from "./thread-archive.js";

afterEach(() => getBlockingOperation()?.cancel());

const thread = { id: "source" } as NormalizedApplicationThreadSummary;
const impact: ThreadArchiveImpact = {
  descendantCount: 0,
  pendingQuestions: { root: 0, descendants: 0 },
  stashedPrompts: { root: 0, descendants: 0 },
  openTasks: {
    root: { items: [], total: 0, omitted: 0 },
    descendants: { items: [], total: 0, omitted: 0 },
  },
  executionWorkspace: { kind: "direct" },
  archiveOnly: { available: true },
  archiveAll: { available: true },
};

describe("direct archive checks", () => {
  it("does not navigate when an already-started archive completes after Cancel", async () => {
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
      onArchived,
    });
    expect(getBlockingOperation()?.message).toBe("Checking thread activity…");
    await vi.waitFor(() => expect(mutateInventory).toHaveBeenCalledOnce());
    expect(getBlockingOperation()?.message).toBe("Archiving thread…");
    getBlockingOperation()!.cancel();
    await operation;
    finish();
    await mutation;
    await Promise.resolve();
    expect(onArchived).not.toHaveBeenCalled();
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
      onArchived: vi.fn(),
    });
    expect(onChoices).toHaveBeenCalledWith(freshImpact);
    expect(mutateInventory).not.toHaveBeenCalled();
  });
});
