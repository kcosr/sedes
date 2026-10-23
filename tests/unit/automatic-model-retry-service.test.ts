import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATIC_MODEL_RETRY_TEXT,
  AutomaticModelRetryService,
  type AutomaticModelRetryCompletion,
  type AutomaticModelRetryInput,
} from "../../src/server/conversations/automatic-model-retry-service.js";
import { MODEL_FAILURE_RETRY_DELAY_MS, type ModelFailureRetryPolicy } from "../../src/server/backends/model-failure-retry.js";
import type { QueuedInputRecord } from "../../src/server/db/repositories/queued-input-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope: RequestScope = { tenantId: "tenant", principalId: "principal" };
const threadId = "thread";
const failure: AutomaticModelRetryCompletion = {
  backendTurnId: "failed-turn", completionIdentity: "failed-turn:failed", outcome: "failed", provenance: "live",
};

function input(state: QueuedInputRecord["state"], overrides: Partial<QueuedInputRecord> = {}): QueuedInputRecord {
  return {
    tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId: threadId,
    id: "input", mutationId: "mutation", sequence: 1, inputOrigin: null, state,
    ...overrides,
  } as QueuedInputRecord;
}

function fixture() {
  let enabled = true;
  let used = false;
  let acceptedSequence = 1;
  let lastSuccess: string | undefined;
  const failureIdentities = new Set<string>();
  const policy: ModelFailureRetryPolicy = {
    enabled: vi.fn(() => enabled),
    claim: vi.fn(identity => {
      if (!enabled || used || failureIdentities.has(identity)) return false;
      failureIdentities.add(identity);
      used = true;
      return true;
    }),
    reset: vi.fn(identity => {
      if (identity !== lastSuccess) used = false;
      lastSuccess = identity;
    }),
    resetForInput: vi.fn(sequence => {
      if (sequence <= acceptedSequence) return false;
      acceptedSequence = sequence;
      used = false;
      return true;
    }),
  };
  const enqueue = vi.fn(async (_scope: RequestScope, _threadId: string, retry: AutomaticModelRetryInput) => {
    expect(retry.isCurrent()).toBe(true);
    retry.onAdmitted();
  });
  const onPendingChanged = vi.fn();
  const onError = vi.fn();
  const resolvePolicy = vi.fn((_owner: RequestScope, _thread: string) => policy);
  const create = () => new AutomaticModelRetryService({ resolvePolicy, enqueue, onPendingChanged, onError });
  const service = create();
  return { service, create, policy, enqueue, onPendingChanged, onError, resolvePolicy,
    disable: () => { enabled = false; } };
}

describe("automatic model failure follow-up", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("admits one new ordinary message after the fixed delay and retires pending before dispatch", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    expect(f.policy.claim).toHaveBeenCalledExactlyOnceWith(failure.completionIdentity);
    expect(f.service.isPending(scope, threadId)).toBe(true);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS - 1);
    expect(f.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(scope, threadId, expect.objectContaining({
      text: "Please continue from where you left off.", sourceFailureIdentity: failure.completionIdentity,
      backendTurnId: failure.backendTurnId,
      mutationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    }));
    expect(AUTOMATIC_MODEL_RETRY_TEXT).toBe("Please continue from where you left off.");
    expect(f.service.isPending(scope, threadId)).toBe(false);
    expect(f.onPendingChanged.mock.calls.map(call => call[2])).toEqual([true, false]);
    await f.service.close();
  });

  it("passes native recovery to admission without altering the failure identity", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, { ...failure, nativeRecovery: true });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(scope, threadId, expect.objectContaining({
      nativeRecovery: true, backendTurnId: failure.backendTurnId, sourceFailureIdentity: failure.completionIdentity,
    }));
    expect(f.service.isPending(scope, threadId)).toBe(false);
  });

  it("does not rearm native recovery from intermediate model feedback", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, { ...failure, nativeRecovery: true });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    f.service.onModelFeedback(scope, threadId, "native-goal-tool-response", true);
    expect(f.policy.reset).not.toHaveBeenCalled();
    f.service.onCompletion(scope, threadId, { ...failure, nativeRecovery: true,
      backendTurnId: "resumed-goal-turn", completionIdentity: "resumed-goal-turn:failed" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    f.service.onCompletion(scope, threadId, { ...failure, nativeRecovery: true,
      backendTurnId: "successful-goal-turn", completionIdentity: "successful-goal-turn:completed", outcome: "completed" });
    expect(f.policy.reset).toHaveBeenCalledExactlyOnceWith("successful-goal-turn:completed");
    f.service.onCompletion(scope, threadId, { ...failure, nativeRecovery: true,
      backendTurnId: "later-goal-turn", completionIdentity: "later-goal-turn:failed" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("native-only cancellation preserves an ordinary pending retry (nativeRecovery=%s)", async nativeRecovery => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, { ...failure, ...(nativeRecovery ? { nativeRecovery: true as const } : {}) });
    expect(f.service.cancelNativeRecovery(scope, threadId)).toBe(nativeRecovery);
    expect(f.service.isPending(scope, threadId)).toBe(!nativeRecovery);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(nativeRecovery ? 0 : 1);
    await f.service.close();
  });

  it("cancels native recovery on new input before admission", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, { ...failure, nativeRecovery: true });
    f.service.onInputChanged(scope, threadId, input("pending"));
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.service.isPending(scope, threadId)).toBe(false);
  });

  it("cancels a pending native recovery without restoring its consumed allowance", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, { ...failure, nativeRecovery: true });
    expect(f.service.cancelNativeRecovery(scope, threadId)).toBe(true);
    expect(f.service.cancelNativeRecovery(scope, threadId)).toBe(false);
    expect(f.service.isPending(scope, threadId)).toBe(false);
    expect(f.onPendingChanged.mock.calls.map(call => call[2])).toEqual([true, false]);
    expect(f.policy.reset).not.toHaveBeenCalled();
    expect(f.policy.resetForInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).not.toHaveBeenCalled();
    f.service.onCompletion(scope, threadId, { ...failure, nativeRecovery: true,
      backendTurnId: "later-turn", completionIdentity: "later-turn:failed" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.service.isPending(scope, threadId)).toBe(false);
    await f.service.close();
  });

  it("leaves an ordinary retry pending when only native recovery is cancelled", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    expect(f.service.cancelNativeRecovery(scope, threadId)).toBe(false);
    expect(f.service.isPending(scope, threadId)).toBe(true);
    expect(f.onPendingChanged.mock.calls.map(call => call[2])).toEqual([true]);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(scope, threadId, expect.not.objectContaining({ nativeRecovery: true }));
    await f.service.close();
  });

  it("scopes native cancellation to the exact principal and thread", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, { ...failure, nativeRecovery: true });
    expect(f.service.cancelNativeRecovery({ ...scope, principalId: "other" }, threadId)).toBe(false);
    expect(f.service.cancelNativeRecovery(scope, "other-thread")).toBe(false);
    expect(f.service.isPending(scope, threadId)).toBe(true);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledOnce();
    await f.service.close();
  });

  it("does not retry a failed follow-up again until a completed successful response", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    f.service.onCompletion(scope, threadId, { ...failure, backendTurnId: "retry-turn", completionIdentity: "retry-turn:failed" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    f.service.onModelFeedback(scope, threadId, "successful-tool-only-response", false);
    f.service.onCompletion(scope, threadId, { ...failure, backendTurnId: "later-turn", completionIdentity: "later-turn:failed" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(2);
  });

  it("does not re-arm a failed automatic follow-up from its own successful model or tool progress", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    f.service.onModelFeedback(scope, threadId, "automatic-retry-tool-response", true);
    expect(f.policy.reset).not.toHaveBeenCalled();
    f.service.onCompletion(scope, threadId, { ...failure, completionIdentity: "automatic-retry:failed" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    f.service.onCompletion(scope, threadId, { ...failure, outcome: "completed", completionIdentity: "automatic-retry:completed" });
    f.service.onCompletion(scope, threadId, { ...failure, completionIdentity: "later-occurrence:failed" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(2);
  });

  it("skips an arbitrarily long retained accepted replay without resolving policy for every old row", () => {
    const f = fixture();
    f.service.onInputChanged(scope, threadId, input("accepted", { sequence: 10_000, id: "latest" }));
    f.resolvePolicy.mockClear();
    for (let sequence = 1; sequence <= 10_000; sequence += 1) {
      f.service.onInputChanged(scope, threadId, input("accepted", { sequence, id: sequence === 10_000 ? "latest" : `old-${sequence}` }));
    }
    expect(f.resolvePolicy).not.toHaveBeenCalled();
    f.service.onInputChanged(scope, threadId, input("accepted", { sequence: 10_001, id: "new" }));
    f.service.onInputChanged(scope, threadId, input("accepted", { sequence: 10_001, id: "replacement-binding-row" }));
    expect(f.resolvePolicy).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repeated completion correlations before and after admission", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    f.service.onCompletion(scope, threadId, failure);
    expect(f.policy.claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    f.service.onCompletion(scope, threadId, failure);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not schedule or reset from recovered history with nativeRecovery=%s", async nativeRecovery => {
    const f = fixture();
    const recovery = nativeRecovery ? { nativeRecovery: true as const } : {};
    f.service.onCompletion(scope, threadId, { ...failure, ...recovery, provenance: "recovered" });
    f.service.onCompletion(scope, threadId, { ...failure, ...recovery, provenance: "recovered", outcome: "completed" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.policy.claim).not.toHaveBeenCalled();
    expect(f.policy.reset).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("does not resurrect a cancelled delay after a process restart or replay", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    await f.service.close();
    const replacement = f.create();
    replacement.onCompletion(scope, threadId, { ...failure, provenance: "recovered" });
    replacement.onCompletion(scope, threadId, failure);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(replacement.isPending(scope, threadId)).toBe(false);
  });

  it.each(["pending", "retry_wait", "dispatching", "uncertain"] as const)("lets %s manual input cancel pending recovery", async state => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    f.service.onInputChanged(scope, threadId, input(state));
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.policy.resetForInput).not.toHaveBeenCalled();
    expect(f.service.isPending(scope, threadId)).toBe(false);
  });

  it("ignores historical accepted replay and resets only newly accepted ordinary input", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    f.service.onInputChanged(scope, threadId, input("accepted", { sequence: 1 }));
    expect(f.service.isPending(scope, threadId)).toBe(true);
    f.service.onInputChanged(scope, threadId, input("accepted", { sequence: 2 }));
    expect(f.service.isPending(scope, threadId)).toBe(false);
    f.service.onCompletion(scope, threadId, { ...failure, completionIdentity: "new-input:failed" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    f.service.onInputChanged(scope, threadId, input("accepted", { sequence: 2 }));
    f.service.onCompletion(scope, threadId, { ...failure, completionIdentity: "retry:failed" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "accepted"] as const)("does not cancel or reset from its own %s input", async state => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    f.service.onInputChanged(scope, threadId, input(state, {
      sequence: 2, inputOrigin: { kind: "automatic_retry" },
    }));
    expect(f.policy.resetForInput).not.toHaveBeenCalled();
    expect(f.service.isPending(scope, threadId)).toBe(true);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "cancelled"] as const)("ignores retained %s queue records", async state => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    f.service.onInputChanged(scope, threadId, input(state));
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it("keeps owner scope and mutation identities distinct for the same thread ID", async () => {
    const f = fixture();
    const second = fixture();
    const other = { ...scope, principalId: "other" };
    f.resolvePolicy.mockImplementation(owner => owner.principalId === scope.principalId ? f.policy : second.policy);
    f.service.onCompletion(scope, threadId, failure);
    f.service.onCompletion(other, threadId, failure);
    f.service.cancel(scope, threadId);
    expect(f.service.isPending(other, threadId)).toBe(true);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0]![0]).toEqual(other);
    const firstMutation = f.enqueue.mock.calls[0]![2].mutationId;
    const third = fixture();
    third.service.onCompletion(scope, threadId, failure);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(third.enqueue.mock.calls[0]![2].mutationId).not.toBe(firstMutation);
  });

  it("checks a changed preference again when the delay expires", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    f.disable();
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.service.isPending(scope, threadId)).toBe(false);
  });

  it("rejects input observations belonging to a different owner or thread", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    f.service.onInputChanged(scope, threadId, input("accepted", { sequence: 2, ownerPrincipalId: "other" }));
    f.service.onInputChanged(scope, threadId, input("pending", { tenantId: "other" }));
    f.service.onInputChanged(scope, threadId, input("pending", { applicationThreadId: "other" }));
    expect(f.policy.resetForInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it("immediately cancels pending presentation when preferences are disabled", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    f.disable();
    f.service.cancelDisabled();
    expect(f.service.isPending(scope, threadId)).toBe(false);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).not.toHaveBeenCalled();
    f.service.onCompletion(scope, threadId, { ...failure, completionIdentity: "disabled-failure" });
    expect(f.policy.claim).toHaveBeenCalledTimes(1);
  });

  it.each(["interrupted", "completed"] as const)("cancels a pending delay on a live %s turn", async outcome => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    f.service.onCompletion(scope, threadId, { ...failure, outcome, completionIdentity: `turn:${outcome}` });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.policy.reset).toHaveBeenCalledTimes(outcome === "completed" ? 1 : 0);
  });

  it("fences new input arriving while ordinary admission awaits its runtime", async () => {
    const f = fixture();
    let finishAdmission!: () => void;
    const committed = vi.fn();
    f.enqueue.mockImplementation(async (_owner, _thread, retry) => {
      await new Promise<void>(resolve => { finishAdmission = resolve; });
      if (retry.isCurrent()) { committed(); retry.onAdmitted(); }
    });
    f.service.onCompletion(scope, threadId, failure);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    f.service.onInputChanged(scope, threadId, input("pending"));
    finishAdmission();
    await f.service.close();
    expect(committed).not.toHaveBeenCalled();
  });

  it("clears pending at admission while ordinary queue dispatch is still running", async () => {
    const f = fixture();
    let finishDispatch!: () => void;
    f.enqueue.mockImplementation(async (_owner, _thread, retry) => {
      retry.onAdmitted();
      expect(f.service.isPending(scope, threadId)).toBe(false);
      await new Promise<void>(resolve => { finishDispatch = resolve; });
    });
    f.service.onCompletion(scope, threadId, failure);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.service.isPending(scope, threadId)).toBe(false);
    finishDispatch();
    await f.service.close();
  });

  it("reports admission errors once and leaves the consumed retry exhausted", async () => {
    const f = fixture();
    const error = new Error("ordinary Send unavailable");
    f.enqueue.mockRejectedValue(error);
    f.service.onCompletion(scope, threadId, failure);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.service.isPending(scope, threadId)).toBe(false);
    f.service.onCompletion(scope, threadId, { ...failure, completionIdentity: "later-unreset-failure" });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });

  it("cancels pending delays on shutdown and ignores later observations", async () => {
    const f = fixture();
    f.service.onCompletion(scope, threadId, failure);
    await f.service.close();
    f.service.onCompletion(scope, threadId, { ...failure, completionIdentity: "after-close" });
    f.service.onModelFeedback(scope, threadId, "after-close-success", false);
    f.service.onInputChanged(scope, threadId, input("accepted", { sequence: 2 }));
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.policy.claim).toHaveBeenCalledTimes(1);
    expect(f.policy.reset).not.toHaveBeenCalled();
    expect(f.policy.resetForInput).not.toHaveBeenCalled();
  });
});
