import { describe, expect, it, vi } from "vitest";
import { BackendError } from "../../src/server/backends/contracts.js";
import { attachRetainedThreads } from "../../src/server/runtime/retained-provider-work.js";

function budgetReached(): BackendError {
  return new BackendError({ category: "overloaded", retryable: true, crossedSubmissionBoundary: false,
    backendCode: "conversation_runtime_budget_reached", safeMessage: "The conversation runtime budget is full." });
}

describe("retained provider work attachment", () => {
  it("opens each listed thread once, one at a time, and releases it at once", async () => {
    let open = 0;
    const order: string[] = [];
    const report = vi.fn();
    const result = await attachRetainedThreads({
      threadIds: ["running", "unacknowledged", "running"],
      signal: new AbortController().signal,
      acquire: async threadId => {
        open++;
        expect(open).toBe(1);
        order.push(threadId);
        return { release: () => { open--; } };
      },
      report,
    });
    expect(order).toEqual(["running", "unacknowledged"]);
    expect(open).toBe(0);
    expect(result).toEqual({ complete: true, attachedThreadIds: ["running", "unacknowledged"] });
    expect(report).not.toHaveBeenCalled();
  });

  it("stops at the runtime budget and reports the pass incomplete", async () => {
    const acquire = vi.fn(async (threadId: string) => {
      if (threadId === "second") throw budgetReached();
      return { release: () => undefined };
    });
    const report = vi.fn();
    const result = await attachRetainedThreads({
      threadIds: ["first", "second", "third"], signal: new AbortController().signal, acquire, report,
    });
    expect(acquire.mock.calls.map(([threadId]) => threadId)).toEqual(["first", "second"]);
    expect(result).toEqual({ complete: false, attachedThreadIds: ["first"] });
    expect(report).toHaveBeenCalledWith(expect.stringContaining("runtime budget"), expect.any(BackendError));
  });

  it("reports an unusable thread without stranding the rest", async () => {
    const report = vi.fn();
    const result = await attachRetainedThreads({
      threadIds: ["archived", "live"],
      signal: new AbortController().signal,
      acquire: async threadId => {
        if (threadId === "archived") throw new Error("thread_not_found");
        return { release: () => undefined };
      },
      report,
    });
    expect(result).toEqual({ complete: true, attachedThreadIds: ["live"] });
    expect(report).toHaveBeenCalledOnce();
  });

  it("stops quietly once shutdown aborts the pass", async () => {
    const controller = new AbortController();
    const report = vi.fn();
    const result = await attachRetainedThreads({
      threadIds: ["first", "second"],
      signal: controller.signal,
      acquire: async () => { controller.abort(); return { release: () => undefined }; },
      report,
    });
    expect(result).toEqual({ complete: false, attachedThreadIds: ["first"] });
    expect(report).not.toHaveBeenCalled();
  });
});
