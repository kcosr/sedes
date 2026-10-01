import { describe, expect, it } from "vitest";
import { ConversationInterruptLedger } from "../../src/server/backends/conversation-interrupt.js";
import { BackendError } from "../../src/server/backends/contracts.js";

const lifetime = () => new AbortController().signal;
describe("conversation interrupt ledger", () => {
  it("reserves before effect, retains accepted evidence, and rejects a changed original deadline", async () => {
    const ledger = new ConversationInterruptLedger();
    const input = { applicationOperationId: "stop", deadlineAt: Date.now() + 1_000 };
    let effects = 0;
    const effect = async () => { effects += 1; };
    await ledger.execute(input, lifetime(), effect);
    await ledger.execute(input, lifetime(), effect);
    expect(effects).toBe(1);
    expect(ledger.reconcile(input)).toEqual({ outcome: "accepted" });
    await expect(ledger.execute({ ...input, deadlineAt: input.deadlineAt + 1 }, lifetime(), effect)).rejects.toMatchObject({ backendCode: "interrupt_replay_mismatch" });
  });

  it("does not dispatch an expired operation or reuse its identity with a new budget", async () => {
    const ledger = new ConversationInterruptLedger();
    const input = { applicationOperationId: "stop", deadlineAt: Date.now() + 15 };
    let effects = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await expect(ledger.execute(input, lifetime(), async (budget) => {
      budget.dispatch(); effects += 1; await budget.wait(pending);
    })).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    release();
    await Promise.resolve();
    expect(ledger.reconcile(input)).toEqual({ outcome: "unknown" });
    await expect(ledger.execute(input, lifetime(), async () => { effects += 1; })).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await expect(ledger.execute({ ...input, deadlineAt: Date.now() + 1_000 }, lifetime(), async () => { effects += 1; })).rejects.toMatchObject({ backendCode: "interrupt_replay_mismatch" });
    expect(effects).toBe(1);
    expect(ledger.reconcile({ applicationOperationId: "absent", deadlineAt: Date.now() + 1_000 })).toEqual({ outcome: "unknown" });
  });

  it("does not begin native effects after a delayed readiness wait exhausts the original budget", async () => {
    const ledger = new ConversationInterruptLedger();
    const input = { applicationOperationId: "waiting", deadlineAt: Date.now() + 15 };
    let effects = 0;
    let release!: () => void;
    const readiness = new Promise<void>((resolve) => { release = resolve; });
    await expect(ledger.execute(input, lifetime(), async (budget) => {
      await budget.wait(readiness);
      budget.dispatch(); effects += 1;
    })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    release();
    await Promise.resolve();
    expect(effects).toBe(0);
    expect(ledger.reconcile(input)).toEqual({ outcome: "not_applied" });
  });

  it("bounds retained evidence without evicting earlier operation identities", async () => {
    const ledger = new ConversationInterruptLedger(1);
    const input = { applicationOperationId: "first", deadlineAt: Date.now() + 1_000 };
    await ledger.execute(input, lifetime(), async () => undefined);
    await expect(ledger.execute({ ...input, applicationOperationId: "second" }, lifetime(), async () => { throw new Error("must not dispatch"); })).rejects.toMatchObject({ backendCode: "interrupt_ledger_full", crossedSubmissionBoundary: false });
    expect(ledger.reconcile(input)).toEqual({ outcome: "accepted" });
  });

  it("revokes a pending operation when native control authority is lost", async () => {
    const ledger = new ConversationInterruptLedger();
    const authority = new AbortController();
    const input = { applicationOperationId: "stop", deadlineAt: Date.now() + 1_000 };
    const stopping = ledger.execute(input, authority.signal, async (budget) => {
      budget.dispatch(); await budget.wait(new Promise<void>(() => undefined));
    });
    authority.abort();
    await expect(stopping).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(ledger.reconcile(input)).toEqual({ outcome: "unknown" });
  });

  it("retains explicit native nonacceptance after dispatch without replaying the operation", async () => {
    const ledger = new ConversationInterruptLedger();
    const input = { applicationOperationId: "rejected", deadlineAt: Date.now() + 1_000 };
    const rejected = new BackendError({ category: "rejected", retryable: false, crossedSubmissionBoundary: false,
      backendCode: "native_interrupt_rejected", safeMessage: "The native operation was rejected." });
    let effects = 0;
    const effect = async (budget: Parameters<Parameters<typeof ledger.execute>[2]>[0]) => {
      budget.dispatch(); effects += 1; throw rejected;
    };
    await expect(ledger.execute(input, lifetime(), effect)).rejects.toBe(rejected);
    expect(ledger.reconcile(input)).toEqual({ outcome: "not_applied" });
    await expect(ledger.execute(input, lifetime(), effect)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(ledger.execute({ ...input, deadlineAt: input.deadlineAt + 1 }, lifetime(), effect)).rejects.toMatchObject({ backendCode: "interrupt_replay_mismatch" });
    expect(effects).toBe(1);
  });

  it("does not turn an uncertain dispatch into nonacceptance on an unclassified or late rejection", async () => {
    const ledger = new ConversationInterruptLedger();
    const input = { applicationOperationId: "transport", deadlineAt: Date.now() + 1_000 };
    await expect(ledger.execute(input, lifetime(), async budget => { budget.dispatch(); throw new Error("connection reset"); })).rejects.toThrow("connection reset");
    expect(ledger.reconcile(input)).toEqual({ outcome: "unknown" });
    const late = { applicationOperationId: "late", deadlineAt: Date.now() + 15 };
    let rejectLate!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectLate = reject; });
    await expect(ledger.execute(late, lifetime(), async budget => { budget.dispatch(); await pending; })).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    rejectLate(new BackendError({ category: "rejected", retryable: false, crossedSubmissionBoundary: false,
      backendCode: "native_interrupt_rejected", safeMessage: "The native operation was rejected." }));
    await Promise.resolve(); await Promise.resolve();
    expect(ledger.reconcile(late)).toEqual({ outcome: "unknown" });
  });
});
