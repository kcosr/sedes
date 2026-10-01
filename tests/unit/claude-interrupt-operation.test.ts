import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeInterruptOperations } from "../../src/server/backends/claude/claude-interrupt-operation.js";

afterEach(() => vi.useRealTimers());
describe("Claude native-owner Stop journal", () => {
  it("retains an exact acknowledgement and never redispatches a duplicate", async () => {
    const ledger = new ClaudeInterruptOperations<{ still_queued: string[] }>();
    const native = vi.fn(async () => ({ still_queued: [] }));
    const input = { applicationOperationId: crypto.randomUUID(), deadlineAt: Date.now() + 30_000 };
    await expect(ledger.run(input, native)).resolves.toEqual({ still_queued: [] });
    await expect(ledger.run({ ...input, deadlineAt: input.deadlineAt + 1_000 }, native)).resolves.toEqual({ still_queued: [] });
    expect(ledger.outcome(input.applicationOperationId)).toBe("accepted");
    expect(native).toHaveBeenCalledOnce();
  });

  it("keeps a lost acknowledgement uncertain across retries with translated owner budgets", async () => {
    const ledger = new ClaudeInterruptOperations<void>();
    const native = vi.fn(async () => { throw new Error("carrier_lost"); });
    const input = { applicationOperationId: crypto.randomUUID(), deadlineAt: Date.now() + 30_000 };
    await expect(ledger.run(input, native)).rejects.toThrow("carrier_lost");
    await expect(ledger.run({ ...input, deadlineAt: input.deadlineAt + 1_000 }, native)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(ledger.outcome(input.applicationOperationId)).toBe("unknown");
    expect(native).toHaveBeenCalledOnce();
  });

  it("does not accept late acknowledgement or resend after the original owner deadline", async () => {
    vi.useFakeTimers();
    const ledger = new ClaudeInterruptOperations<void>();
    let acknowledge!: () => void;
    const native = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    const input = { applicationOperationId: crypto.randomUUID(), deadlineAt: Date.now() + 25 };
    const result = expect(ledger.run(input, native)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await vi.advanceTimersByTimeAsync(25);
    await result;
    acknowledge();
    await Promise.resolve();
    await expect(ledger.run({ ...input, deadlineAt: Date.now() + 30_000 }, native)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(ledger.outcome(input.applicationOperationId)).toBe("unknown");
    expect(native).toHaveBeenCalledOnce();
  });

  it("does not dispatch after an expired budget or revoked control lease", async () => {
    const ledger = new ClaudeInterruptOperations<void>();
    const native = vi.fn(async () => {});
    for (const input of [
      { applicationOperationId: crypto.randomUUID(), deadlineAt: Date.now() - 1 },
      { applicationOperationId: crypto.randomUUID(), deadlineAt: Date.now() + 30_000, signal: AbortSignal.abort() },
    ]) await expect(ledger.run(input, native)).rejects.toBeDefined();
    expect(native).not.toHaveBeenCalled();
  });
});
