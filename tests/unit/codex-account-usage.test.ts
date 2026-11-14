import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAccountUsageSource } from "../../src/server/backends/codex/codex-account-usage.js";
import { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import { RetainedRuntimeLifecycle } from "../../src/server/backends/retained-runtime-lifecycle.js";
import { codexAccountUsageResult } from "../helpers/codex-account-usage.js";

const INTERVAL = 5 * 60 * 1_000;
const sources: CodexAccountUsageSource[] = [];

function fixture(residency?: RetainedRuntimeLifecycle) {
  const read = vi.fn(async () => codexAccountUsageResult());
  const encoded: unknown[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const client = new CodexSharedClientFacade({
    ...(residency ? { residency } : {}),
    current: () => ({
      generation: 1,
      request: async (method, params, options) => {
        expect(method.method).toBe("account/rateLimits/read");
        encoded.push(method.encodeParams(params));
        signals.push(options.signal);
        return method.decodeResult(await read());
      },
      requestWithReceipt: async () => { throw new Error("Unexpected receipt"); },
    }),
    latestGeneration: () => 1,
    retireGeneration: async () => undefined,
  });
  const source = new CodexAccountUsageSource(client);
  sources.push(source);
  return { source, client, read, encoded, signals };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
});
afterEach(() => {
  for (const source of sources.splice(0)) source.close();
  vi.useRealTimers();
});

describe("Codex account usage polling", () => {
  it("starts on first readiness and polls without any browser subscribers", async () => {
    const f = fixture();
    f.source.start();
    f.client.updateLifecycle({ state: "reconciling", generation: 0 });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.read).not.toHaveBeenCalled();

    f.client.updateLifecycle({ state: "ready", generation: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.encoded).toEqual([{ excludeResetCreditDetails: true }]);
    expect(f.source.snapshot()).toEqual({
      capturedAt: Date.now(), accountId: "account-1", plan: "Pro Max", includedUsageAllowed: true,
      windows: [{ remainingPercent: 28, durationMinutes: 10_080, resetsAt: 1_800_000_000_000 }],
    });
    f.source.start();
    f.client.updateLifecycle({ state: "idle", generation: 1 });
    f.client.updateLifecycle({ state: "ready", generation: 2 });
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(f.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("keeps only one read in flight and never polls from snapshot/subscription reads", async () => {
    const f = fixture();
    let resolve!: (result: ReturnType<typeof codexAccountUsageResult>) => void;
    f.read.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    f.client.updateLifecycle({ state: "ready", generation: 1 });
    f.source.start();
    const changed = vi.fn();
    const unsubscribe = f.source.subscribe(changed);
    f.source.snapshot();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(f.read).toHaveBeenCalledTimes(1);
    resolve(codexAccountUsageResult());
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("wakes and reparks exactly once per scheduled read", async () => {
    const wake = vi.fn();
    const retire = vi.fn(async () => undefined);
    const residency = new RetainedRuntimeLifecycle({ wake, retire });
    await residency.retain().release(true);
    retire.mockClear();
    const f = fixture(residency);
    f.client.updateLifecycle({ state: "idle", generation: 1 });
    f.source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(f.source.snapshot()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenCalledTimes(2);
  });

  it("clears failures and recovers on the same schedule after login or transport recovery", async () => {
    const f = fixture();
    f.client.updateLifecycle({ state: "ready", generation: 1 });
    f.source.start();
    await vi.advanceTimersByTimeAsync(0);
    f.read.mockRejectedValueOnce(new Error("chatgpt authentication required"));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.source.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.source.snapshot()).not.toBeNull();
    expect(f.read).toHaveBeenCalledTimes(3);
  });

  it("stops before shutdown, clears cached data and rejects a late response", async () => {
    const f = fixture();
    f.client.updateLifecycle({ state: "ready", generation: 1 });
    f.source.start();
    await vi.advanceTimersByTimeAsync(0);
    let resolve!: (result: ReturnType<typeof codexAccountUsageResult>) => void;
    f.read.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    f.source.close();
    expect(f.signals.at(-1)?.aborted).toBe(true);
    expect(f.source.snapshot()).toBeNull();
    resolve(codexAccountUsageResult());
    f.source.start();
    f.client.updateLifecycle({ state: "ready", generation: 2 });
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(f.source.snapshot()).toBeNull();
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("picks up a switched account on the next poll without retaining the previous plan or windows", async () => {
    const f = fixture();
    f.client.updateLifecycle({ state: "ready", generation: 1 });
    f.source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.source.snapshot()).toMatchObject({ accountId: "account-1", plan: "Pro Max" });
    const next = codexAccountUsageResult();
    next.accountId = "account-2";
    next.rateLimitsByLimitId!.codex!.planType = "plus";
    next.rateLimitsByLimitId!.codex!.primary = { usedPercent: 40, windowDurationMins: 300, resetsAt: null };
    next.rateLimitsByLimitId!.codex!.secondary = null;
    f.read.mockResolvedValueOnce(next);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.source.snapshot()).toEqual({
      capturedAt: Date.now(), accountId: "account-2", plan: "Plus", includedUsageAllowed: true,
      windows: [{ remainingPercent: 60, durationMinutes: 300, resetsAt: null }],
    });
  });

  it("replaces identity and windows atomically using only ordinary full snapshots", async () => {
    const f = fixture();
    f.client.updateLifecycle({ state: "ready", generation: 1 });
    f.source.start();
    await vi.advanceTimersByTimeAsync(0);
    const next = codexAccountUsageResult();
    next.accountId = null;
    next.ordinaryUsageAllowed = false;
    const ordinary = next.rateLimitsByLimitId!.codex!;
    ordinary.planType = null;
    ordinary.primary = { usedPercent: 120, windowDurationMins: null, resetsAt: null };
    ordinary.secondary = null;
    next.rateLimitsByLimitId!.other = { ...ordinary, primary: null, secondary: { usedPercent: 99, windowDurationMins: 300, resetsAt: null } };
    f.read.mockResolvedValueOnce(next);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.source.snapshot()).toEqual({
      capturedAt: Date.now(), accountId: null, plan: null, includedUsageAllowed: false,
      windows: [{ remainingPercent: 0, durationMinutes: null, resetsAt: null }],
    });
    next.rateLimitsByLimitId = null;
    f.read.mockResolvedValueOnce(next);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.source.snapshot()).toBeNull();
  });
});
