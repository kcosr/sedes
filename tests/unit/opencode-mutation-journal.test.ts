import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeMutationJournal } from "../../src/server/backends/opencode/opencode-mutation-journal.js";
import type { OpenCodeMutationControl, OpenCodeNativeAuthority } from "../../src/server/backends/opencode/opencode-native-port.js";

const authority: OpenCodeNativeAuthority = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment",
  backendInstanceId: "backend", runtimeId: "runtime", nativeGeneration: "generation", directory: "/workspace",
  session: { applicationThreadId: "thread", nativeSessionID: "ses_test", bindingFingerprint: "binding" } };
function control(id = "operation", step = "prepare_model", deadlineAt = Date.now() + 30_000): OpenCodeMutationControl {
  return { identity: { origin: "application", applicationOperationId: id, operationKind: "submit", step }, deadlineAt };
}
const model = { sessionID: "ses_test", model: { providerID: "provider", id: "model" } };
const success = { ok: true } as const;
afterEach(() => vi.useRealTimers());

describe("OpenCode owner mutation journal", () => {
  it("never turns an aborted retry of a completed or acknowledged write into a refusal", async () => {
    const journal = new OpenCodeMutationJournal();
    const dispatch = vi.fn(async () => success);
    const request = control();
    await journal.mutate(authority, "setModel", model, request, dispatch);
    const signal = AbortSignal.abort();
    await expect(journal.mutate(authority, "setModel", model, request, dispatch, signal))
      .rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    journal.acknowledge(authority, "setModel", request.identity);
    await expect(journal.mutate(authority, "setModel", model, request, dispatch, signal))
      .rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    await expect(journal.mutate(authority, "setModel", model, control("fresh"), dispatch, signal))
      .rejects.toMatchObject({ delivery: "not_sent" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("continues an admitted mutation across caller cancellation and returns its exact result without redispatch", async () => {
    const journal = new OpenCodeMutationJournal();
    const done = deferred<typeof success>();
    const dispatch = vi.fn(async (_input: typeof model, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return done.promise;
    });
    const request = control();
    const caller = new AbortController();
    const first = journal.mutate(authority, "setModel", model, request, dispatch, caller.signal);
    const rejected = expect(first).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    await Promise.resolve(); caller.abort(); await rejected;
    expect(journal.outcome(authority, "setModel", request.identity)).toEqual({ status: "pending" });
    const retry = journal.mutate(authority, "setModel", model, request, dispatch);
    done.resolve(success);
    await expect(retry).resolves.toEqual(success);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(journal.outcome(authority, "setModel", request.identity)).toEqual({ status: "completed", result: success });
  });

  it("fences conflicting input, method and deadline while allowing distinct preparation steps", async () => {
    const journal = new OpenCodeMutationJournal();
    const dispatch = vi.fn(async () => success);
    const request = control();
    await journal.mutate(authority, "setModel", model, request, dispatch);
    await expect(journal.mutate(authority, "setModel", { ...model, model: { ...model.model, id: "changed" } }, request, dispatch))
      .rejects.toMatchObject({ delivery: "not_sent" });
    await expect(journal.mutate(authority, "renameSession", { sessionID: "ses_test", title: "title" }, request, dispatch))
      .rejects.toMatchObject({ delivery: "not_sent" });
    await expect(journal.mutate(authority, "setModel", model, { ...request, deadlineAt: request.deadlineAt! + 1 }, dispatch))
      .rejects.toMatchObject({ delivery: "not_sent" });
    await journal.mutate(authority, "renameSession", { sessionID: "ses_test", title: "title" }, control("operation", "title", request.deadlineAt!), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("captures queued inputs and refuses an expired queued mutation without extending its deadline", async () => {
    vi.useFakeTimers();
    const journal = new OpenCodeMutationJournal({ concurrency: 1 });
    const done = deferred<typeof success>();
    const first = journal.mutate(authority, "setModel", model, control("first"), async () => done.promise);
    const input = { sessionID: "ses_test", title: "original" };
    const dispatch = vi.fn(async () => success);
    const request = control("second", "title", Date.now() + 10);
    const next = journal.mutate(authority, "renameSession", input, request, dispatch);
    const rejected = expect(next).rejects.toMatchObject({ delivery: "not_sent" });
    input.title = "changed";
    await vi.advanceTimersByTimeAsync(11);
    done.resolve(success); await first; await rejected;
    expect(dispatch).not.toHaveBeenCalled();
    expect(journal.outcome(authority, "renameSession", request.identity)).toMatchObject({ status: "failed", failure: { delivery: "not_sent" } });
  });

  it("does not let ordinary occupied lanes block Stop or pending-input withdrawal", async () => {
    const journal = new OpenCodeMutationJournal({ concurrency: 1, controlConcurrency: 1, maximumOperations: 1 });
    const done = deferred<typeof success>();
    const ordinary = journal.mutate(authority, "setModel", model, control("ordinary"), async () => done.promise);
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    await expect(journal.mutate(authority, "interruptSession", { sessionID: "ses_test" }, control("stop", "interrupt"), interrupt))
      .resolves.toEqual({ interrupted: true });
    await journal.mutate(authority, "cancelInput", { sessionID: "ses_test", inboxID: "msg_pending" }, control("stop", "withdraw:msg_pending"), async () => success);
    expect(interrupt).toHaveBeenCalledOnce();
    done.resolve(success); await ordinary;
  });

  it("retains pending proof after a terminal receipt ACK, releasing only after native settlement", async () => {
    const journal = new OpenCodeMutationJournal({ maximumOperations: 1 });
    const done = deferred<typeof success>();
    const request = control();
    const active = journal.mutate(authority, "setModel", model, request, async () => done.promise);
    journal.acknowledge(authority, "setModel", request.identity);
    expect(journal.hasRetainedAuthority(authority)).toBe(true);
    expect(journal.outcome(authority, "setModel", request.identity)).toEqual({ status: "pending" });
    await expect(journal.mutate(authority, "setModel", model, control("second"), async () => success))
      .rejects.toMatchObject({ delivery: "not_sent" });
    done.resolve(success); await active;
    expect(journal.snapshot().operations).toHaveLength(0);
    expect(journal.hasRetainedAuthority(authority)).toBe(false);
    journal.acknowledge(authority, "setModel", request.identity);
    const dispatch = vi.fn(async () => success);
    await expect(journal.mutate(authority, "setModel", model, request, dispatch)).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    expect(dispatch).not.toHaveBeenCalled();
    await journal.mutate(authority, "setModel", model, control("second"), dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("never evicts settled unacknowledged evidence to admit later work", async () => {
    const journal = new OpenCodeMutationJournal({ maximumOperations: 1 });
    const request = control();
    await journal.mutate(authority, "setModel", model, request, async () => success);
    await expect(journal.mutate(authority, "setModel", model, control("later"), async () => success))
      .rejects.toMatchObject({ delivery: "not_sent" });
    expect(journal.outcome(authority, "setModel", request.identity)).toEqual({ status: "completed", result: success });
  });

  it("does not invent a deadline for prepared application operations", async () => {
    vi.useFakeTimers();
    const journal = new OpenCodeMutationJournal({ concurrency: 1 });
    const pending = deferred<typeof success>();
    const first = journal.mutate(authority, "setModel", model, { ...control("first"), deadlineAt: null }, async () => pending.promise);
    const dispatch = vi.fn(async (_input: typeof model, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return success;
    });
    const request = { ...control("later"), deadlineAt: null };
    const later = journal.mutate(authority, "setModel", model, request, dispatch);
    await vi.advanceTimersByTimeAsync(120_000);
    pending.resolve(success); await first; await later;
    await journal.mutate(authority, "setModel", model, request, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("reclaims repeated terminal failures and notifies scope release only after settlement", async () => {
    const onReleased = vi.fn();
    const journal = new OpenCodeMutationJournal({ maximumOperations: 1, maximumControlOperations: 1, onReleased });
    for (let i = 0; i < 24; i++) {
      const request = control(`failed-${i}`);
      await expect(journal.mutate(authority, "cancelInput", { sessionID: "ses_test", inboxID: "msg_pending" }, request,
        async () => { throw new Error("native failure"); })).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
      journal.acknowledge(authority, "cancelInput", request.identity);
    }
    expect(onReleased).toHaveBeenCalledTimes(24);
    expect(journal.snapshot().operations).toHaveLength(0);
    const done = deferred<{ interrupted: boolean }>();
    const request = control("stop");
    const stop = journal.mutate(authority, "interruptSession", { sessionID: "ses_test" }, request, async () => done.promise);
    journal.acknowledge(authority, "interruptSession", request.identity);
    expect(onReleased).toHaveBeenCalledTimes(24);
    done.resolve({ interrupted: true }); await stop;
    expect(onReleased).toHaveBeenCalledTimes(25);
  });

  it("retries operation ACK for dynamic withdrawal steps without releasing foreign or pending work early", async () => {
    const journal = new OpenCodeMutationJournal();
    const first = control("stop", "interrupt");
    const second = control("stop", "withdraw-input:msg_one");
    const third = control("stop", "withdraw-compaction:msg_two");
    const foreign = { ...authority, principalId: "other" };
    await journal.mutate(authority, "interruptSession", { sessionID: "ses_test" }, first, async () => ({ interrupted: true }));
    // Simulate a lost ACK for the first completed substep.
    await journal.mutate(authority, "cancelInput", { sessionID: "ses_test", inboxID: "msg_one" }, second, async () => success);
    const done = deferred<typeof success>();
    const pending = journal.mutate(authority, "cancelInput", { sessionID: "ses_test", inboxID: "msg_two" }, third, async () => done.promise);
    await journal.mutate(foreign, "setModel", model, first, async () => success);
    await journal.mutate(authority, "setModel", model, control("other-operation"), async () => success);
    journal.acknowledgeOperation(authority, { applicationOperationId: "stop", operationKind: "submit" });
    expect(journal.snapshot().operations).toHaveLength(3);
    expect(journal.outcome(authority, "cancelInput", third.identity)).toEqual({ status: "pending" });
    done.resolve(success); await pending;
    expect(journal.snapshot().operations).toHaveLength(2);
    expect(journal.outcome(foreign, "setModel", first.identity)).toEqual({ status: "completed", result: success });
    journal.acknowledgeOperation(authority, { applicationOperationId: "stop", operationKind: "submit" });
    // Stop may intentionally add another cancellation after native interrupt
    // acceptance. An ACK releases evidence, never grants or revokes new steps.
    const later = control("stop", "withdraw-input:msg_later");
    await journal.mutate(authority, "cancelInput", { sessionID: "ses_test", inboxID: "msg_later" }, later, async () => success);
    journal.acknowledgeOperation(authority, { applicationOperationId: "stop", operationKind: "submit" });
    expect(journal.snapshot().operations).toHaveLength(2);
  });

  it("admits all sixteen control operations while bulk ordinary retention is saturated", async () => {
    const journal = new OpenCodeMutationJournal({ maximumBytes: 34 * 1_024 * 1_024 });
    const bulk = deferred<never>();
    const input = { sessionID: "ses_test", id: "msg_bulk", text: "input", delivery: "queue", resume: true } as const;
    const ordinary = journal.mutate(authority, "prompt", input, control("ordinary"), async () => bulk.promise);
    const ordinaryFailure = expect(ordinary).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    await expect(journal.mutate(authority, "prompt", input, control("second"), async () => bulk.promise))
      .rejects.toMatchObject({ delivery: "not_sent" });
    const done = deferred<{ interrupted: boolean }>();
    const controls = Array.from({ length: 16 }, (_, i) => journal.mutate(authority, "interruptSession",
      { sessionID: "ses_test" }, control(`stop-${i}`), async () => done.promise));
    expect(journal.snapshot().operations).toHaveLength(17);
    await expect(journal.mutate(authority, "interruptSession", { sessionID: "ses_test" }, control("overflow"), async () => done.promise))
      .rejects.toMatchObject({ delivery: "not_sent" });
    done.resolve({ interrupted: true }); await Promise.all(controls);
    bulk.reject(new Error("test native completion")); await ordinaryFailure;
  });

  it("does not revoke queued ordinary reservations when control work uses its extra reserve", async () => {
    const journal = new OpenCodeMutationJournal({ maximumBytes: 15_000, concurrency: 1 });
    const firstDone = deferred<typeof success>();
    const first = journal.mutate(authority, "setModel", model, control("ordinary-first"), async () => firstDone.promise);
    const nextDispatch = vi.fn(async () => success);
    const next = journal.mutate(authority, "setModel", model, control("ordinary-next"), nextDispatch);
    const stopDone = deferred<{ interrupted: boolean }>();
    const stops = Array.from({ length: 3 }, (_, i) => journal.mutate(authority, "interruptSession",
      { sessionID: "ses_test" }, control(`stop-reserve-${i}`), async () => stopDone.promise));
    expect(journal.snapshot().retainedBytes).toBeGreaterThan(15_000);
    firstDone.resolve(success); await first; await expect(next).resolves.toEqual(success);
    expect(nextDispatch).toHaveBeenCalledOnce();
    stopDone.resolve({ interrupted: true }); await Promise.all(stops);
  });

  it("keeps scope, runtime and session binding out of another caller's outcome authority", async () => {
    const journal = new OpenCodeMutationJournal();
    const request = control();
    await journal.mutate(authority, "setModel", model, request, async () => success);
    for (const other of [{ ...authority, principalId: "other" }, { ...authority, runtimeId: "replacement" },
      { ...authority, session: { ...authority.session!, bindingFingerprint: "rebound" } }]) {
      expect(() => journal.outcome(other, "setModel", request.identity)).toThrow();
      expect(() => journal.acknowledge(other, "setModel", request.identity)).toThrow();
    }
    expect(journal.snapshot().operations).toHaveLength(1);
  });

  it("reserves response capacity before dispatch and leaves independent space for Stop", async () => {
    const journal = new OpenCodeMutationJournal({ maximumBytes: 10_000 });
    const done = deferred<typeof success>();
    const first = journal.mutate(authority, "setModel", model, control("first"), async () => done.promise);
    const second = vi.fn(async () => success);
    await expect(journal.mutate(authority, "setModel", model, control("second"), second))
      .rejects.toMatchObject({ delivery: "not_sent" });
    expect(second).not.toHaveBeenCalled();
    await expect(journal.mutate(authority, "interruptSession", { sessionID: "ses_test" }, control("stop", "interrupt"),
      async () => ({ interrupted: true }))).resolves.toEqual({ interrupted: true });
    expect(journal.snapshot().retainedBytes).toBeLessThanOrEqual(104 * 1_024 * 1_024);
    done.resolve(success); await first;
    await journal.mutate(authority, "setModel", model, control("second"), second);
    expect(second).toHaveBeenCalledOnce();
  });

  it("classifies explicit owner abandonment by actual dispatch and ignores late completion", async () => {
    const journal = new OpenCodeMutationJournal({ concurrency: 1 });
    const done = deferred<typeof success>();
    const one = control("first"), two = control("second");
    const first = journal.mutate(authority, "setModel", model, one, async () => done.promise);
    const nextDispatch = vi.fn(async () => success);
    const second = journal.mutate(authority, "setModel", model, two, nextDispatch);
    const firstCheck = expect(first).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    const secondCheck = expect(second).rejects.toMatchObject({ delivery: "not_sent" });
    await Promise.resolve(); journal.close(); await Promise.all([firstCheck, secondCheck]);
    done.resolve(success); await Promise.resolve(); await Promise.resolve();
    expect(journal.outcome(authority, "setModel", one.identity)).toMatchObject({ status: "failed", failure: { delivery: "sent_outcome_unknown" } });
    expect(nextDispatch).not.toHaveBeenCalled();
  });

  it("retains only bounded classified failure, never native exception text", async () => {
    const journal = new OpenCodeMutationJournal();
    const request = control();
    await expect(journal.mutate(authority, "setModel", model, request, async () => { throw new Error("PRIVATE_NATIVE_SECRET"); }))
      .rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    expect(JSON.stringify(journal.snapshot())).not.toContain("PRIVATE_NATIVE_SECRET");
    expect(JSON.stringify(journal.outcome(authority, "setModel", request.identity))).not.toContain("PRIVATE_NATIVE_SECRET");
  });

  it("does not expose mutable receipt authority through administration snapshots", async () => {
    const journal = new OpenCodeMutationJournal();
    const request = control();
    await journal.mutate(authority, "setModel", model, request, async () => success);
    const snapshot = journal.snapshot();
    Object.assign(snapshot.operations[0]!.authority.session!, { bindingFingerprint: "changed" });
    Object.assign(snapshot.operations[0]!.identity, { step: "changed" });
    expect(journal.outcome(authority, "setModel", request.identity)).toEqual({ status: "completed", result: success });
    journal.acknowledge(authority, "setModel", request.identity);
    expect(journal.hasRetainedAuthority(authority)).toBe(false);
    expect(journal.snapshot().operations).toHaveLength(0);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
