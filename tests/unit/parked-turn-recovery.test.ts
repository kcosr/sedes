import { expect, it, vi } from "vitest";
import { recoverParkedTurns, type ParkedTurnRetry } from "../../src/server/conversations/parked-turn-recovery.js";

it("backs off per parked thread, reports repeated read failures once, and retries a new park immediately", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const candidates = ["first", "second"].map(threadId => ({
      threadId, turnId: "turn", progressParkRevision: 1, readable: 1 as const,
    }));
    const retries = new Map<string, ParkedTurnRetry>();
    const resolve = vi.fn().mockRejectedValue(new Error("history offline"));
    const onError = vi.fn();
    const check = (milliseconds: number) => {
      vi.setSystemTime(milliseconds);
      return recoverParkedTurns({
        scope: { tenantId: "tenant", principalId: "principal" }, backendInstanceId: "backend", retries,
        inventory: { listParkedTurnTargets: () => candidates, unparkIfTurnEnded: vi.fn() },
        targets: { resolve }, signal: new AbortController().signal,
        isAdmitted: () => true, hasLiveTurn: () => false, publish: vi.fn(), onError,
      });
    };
    await check(0);
    await check(30_000);
    await check(60_000);
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledTimes(2);

    candidates[0]!.progressParkRevision++;
    await check(60_001);
    expect(resolve.mock.calls.map(([, id]) => id)).toEqual(["first", "second", "first", "second", "first"]);
    expect(onError).toHaveBeenCalledTimes(3);

    candidates.length = 0;
    expect(await check(90_000)).toBe(false);
    expect(retries.size).toBe(0);
  } finally { vi.useRealTimers(); }
});
