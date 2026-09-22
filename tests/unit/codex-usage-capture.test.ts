import { describe, expect, it, vi } from "vitest";
import { CodexUsageCapture } from "../../src/server/backends/codex/codex-usage-capture.js";
import { codexBackendTurnId } from "../../src/server/backends/codex/codex-history-projector.js";
import type { UsageObservation, UsageSink } from "../../src/server/usage/contracts.js";

function fixture(provenZero = false, inherited = false) {
  const observations: UsageObservation[] = [];
  const gap = vi.fn();
  const registerTurns = vi.fn();
  const open = vi.fn<UsageSink["open"]>(() => ({ registerTurns,
    capture: entries => { observations.push(...entries); return true; }, gap, seal: vi.fn() }));
  const capture = new CodexUsageCapture({ sink: { open }, provenZero, ancestry: inherited ? {forkedFromThreadId: "parent-native", sourceTurnId: "turn-1"} : null,
    nativeNamespace: "native-store", onError: vi.fn(), binding: {
      tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "app-thread",
      backendConversationId: "native-thread", backendInstanceId: "backend", connectionProfileId: "connection",
      executionEnvironmentId: "environment", createdAt: "2026-09-22T00:00:00.000Z",
    } });
  const observe = (sequence: number, total: number, turnId = "turn-1", generation = 1) => capture.observe({
    generation, sequence, turnId, usage: {
      total: { inputTokens: total, outputTokens: 0, totalTokens: total, cachedInputTokens: 2,
        cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
      last: { inputTokens: 7, outputTokens: 0, totalTokens: 7, cachedInputTokens: 0,
        cacheWriteInputTokens: 0, reasoningOutputTokens: 0 }, modelContextWindow: 100,
    },
  });
  return { capture, observations, gap, open, observe, registerTurns };
}

const intervals = (observations: readonly UsageObservation[]) => observations.flatMap(o => o.facts.filter(f => f.kind === "turn_aggregate"));

describe("Codex cumulative accounting capture", () => {
  it("retains total and last separately and allocates only proved intervals", () => {
    const f = fixture();
    f.observe(1, 100);
    f.observe(2, 150);
    expect(f.observations[0]!.facts.map(fact => [fact.sessionContribution, fact.tokens.input])).toEqual([["checkpoint", "100"], ["none", "7"]]);
    expect(intervals(f.observations)).toMatchObject([{ tokens: { input: "50" }, sessionContribution: "none",
      turn: { backendTurnId: codexBackendTurnId("native-thread", "turn-1"), scope: "partial_interval" },
      models: [{ provider: null, model: null }], basis: ["sdk_normalized", "derived"] }]);
    expect(f.open.mock.calls[0]![0]).toMatchObject({ epoch: "native-counter-v1", initialBaseline: "unknown", nativeNamespace: "native-store" });
  });

  it("does not invent first-turn zero but accepts proven fresh creation", () => {
    const unknown = fixture(); unknown.observe(1, 100);
    expect(intervals(unknown.observations)).toHaveLength(0);
    const fresh = fixture(true); fresh.capture.started("turn-1"); fresh.observe(1, 100);
    expect(intervals(fresh.observations)[0]!.tokens.input).toBe("100");
  });

  it("ignores duplicate and stale sequence delivery within one attachment", () => {
    const f = fixture(); f.observe(1, 100); f.observe(1, 100); f.observe(0, 80); f.observe(2, 100);
    expect(f.observations).toHaveLength(2);
    expect(intervals(f.observations)).toHaveLength(0);
  });

  it("does not assign a counter catch-up across disconnect to the newest turn", () => {
    const f = fixture(); f.observe(1, 100); f.capture.gap("capture_gap"); f.observe(2, 150); f.observe(3, 170);
    expect(intervals(f.observations).map(fact => fact.tokens.input)).toEqual(["20"]);
    expect(f.gap).toHaveBeenCalledWith("capture_gap");
  });

  it("does not treat turn-start as proof that the prior checkpoint was final", () => {
    const f = fixture(); f.observe(1, 100); f.observe(2, 150, "turn-2");
    expect(intervals(f.observations)).toHaveLength(0);
    f.capture.started("turn-3"); f.observe(3, 180, "turn-3");
    expect(intervals(f.observations)).toHaveLength(0);
    f.observe(4, 200, "turn-3");
    expect(intervals(f.observations)[0]!.tokens.input).toBe("20");
  });

  it("never treats regression as reset or resumes allocating when counters catch up", () => {
    const f = fixture(); f.observe(1, 100); f.observe(2, 20); f.observe(3, 110);
    expect(f.gap).toHaveBeenCalledWith("counter_regression");
    expect(intervals(f.observations)).toHaveLength(0);
    expect(f.observations).toHaveLength(3);
  });

  it("does not recharge inherited fork totals, while preserving new owned intervals", () => {
    const f = fixture(false, true); f.observe(1, 100); f.observe(2, 140);
    expect(f.observations[0]!.facts[0]!.sessionContribution).toBe("none");
    expect(intervals(f.observations)[0]).toMatchObject({ sessionContribution: "additive", tokens: { input: "40" } });
    expect(f.gap).toHaveBeenCalledWith("inherited_baseline_unknown");
  });

  it("maps inherited native turn IDs through each native thread namespace", () => {
    const f = fixture(false, true);
    const backendTurnId = codexBackendTurnId("native-thread", "turn-1");
    const turn = { backendTurnId, status: "completed" as const, orderedBackendItemIds: [] };
    f.capture.registerTurns([turn], ["turn-1", "not-visible"]);
    expect(f.registerTurns).toHaveBeenCalledWith([turn], { nativeSession: "parent-native", turns: [{
      backendTurnId, sourceBackendTurnId: codexBackendTurnId("parent-native", "turn-1"),
    }] });
  });

  it("rejects unsafe integers without retrying provider work", () => {
    const f = fixture(); f.observe(1, Number.MAX_SAFE_INTEGER + 1);
    expect(f.observations).toHaveLength(0);
    expect(f.gap).toHaveBeenCalledWith("capture_failed");
  });
});
