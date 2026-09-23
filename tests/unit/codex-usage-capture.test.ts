import { describe, expect, it, vi } from "vitest";
import { CodexUsageCapture } from "../../src/server/backends/codex/codex-usage-capture.js";
import { codexBackendTurnId } from "../../src/server/backends/codex/codex-history-projector.js";
import type { UsageObservation, UsageSink } from "../../src/server/usage/contracts.js";

function fixture(provenZero = false, inherited = false) {
  const observations: UsageObservation[] = [];
  const gap = vi.fn();
  const registerTurns = vi.fn();
  const open = vi.fn<UsageSink["open"]>(() => ({ registerTurns,
    capture: entries => { observations.push(...entries); return true; }, reconcile: () => true, gap, seal: vi.fn() }));
  const capture = new CodexUsageCapture({ sink: { open, listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: () => [] }, provenZero, ancestry: inherited ? {forkedFromThreadId: "parent-native", sourceTurnId: "turn-1"} : null,
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
    const fresh = fixture(true); fresh.capture.started({turnId: "turn-1", generation: 1, sequence: 0}); fresh.observe(1, 100);
    expect(intervals(fresh.observations)[0]!.tokens.input).toBe("100");
    expect(intervals(fresh.observations)[0]).toMatchObject({quality: "complete", turn: {scope: "main_loop"}});
    expect(intervals(fresh.observations)[0]!.reasons).toEqual(["model_coverage_unknown", "main_loop_only"]);
  });

  it("ignores duplicate and stale sequence delivery within one attachment", () => {
    const f = fixture(); f.observe(1, 100); f.observe(1, 100); f.observe(0, 80); f.observe(2, 100);
    expect(f.observations).toHaveLength(2);
    expect(intervals(f.observations)).toHaveLength(0);
  });

  it.each([false, true])("uses an idle resume replay before the first new turn (early replay=%s)", early => {
    const f = fixture();
    if (early) f.observe(2, 100, "old-turn");
    f.capture.resumed({ generation: 1, sequence: 1, idle: true });
    if (!early) f.observe(2, 100, "old-turn");
    f.capture.started({ turnId: "new-turn", generation: 1, sequence: 3 });
    f.observe(4, 120, "new-turn");
    f.observe(5, 120, "new-turn"); // Rate-limit replay is not another charge.
    expect(intervals(f.observations).map(fact => fact.tokens.input)).toEqual(["20"]);
    expect(intervals(f.observations)[0]!.turn?.backendTurnId).toBe(codexBackendTurnId("native-thread", "new-turn"));
  });

  it("keeps an established idle baseline when the same generation resumes without replay", () => {
    const f = fixture();
    f.capture.resumed({ generation: 1, sequence: 1, idle: true });
    f.observe(2, 100, "old-turn");
    f.capture.resumed({ generation: 1, sequence: 3, idle: true });
    f.capture.started({ turnId: "new-turn", generation: 1, sequence: 4 });
    f.observe(5, 120, "new-turn");
    expect(intervals(f.observations).map(fact => fact.tokens.input)).toEqual(["20"]);
    expect(intervals(f.observations)[0]!.reasons).not.toContain("unknown_baseline");
  });

  it("does not move a replay baseline past lifecycle notifications deferred during pagination", () => {
    const f = fixture();
    f.observe(2, 100, "old-turn"); // Replay can arrive before the resume promise continues.
    f.capture.resumed({ generation: 1, sequence: 1, idle: true });
    f.observe(4, 120, "new-turn"); // Usage bypasses deferred transcript notifications.
    f.capture.started({ turnId: "new-turn", generation: 1, sequence: 3 });
    expect(intervals(f.observations)).toHaveLength(0);
    f.observe(5, 150, "new-turn");
    expect(intervals(f.observations).map(fact => fact.tokens.input)).toEqual(["30"]);
    expect(intervals(f.observations)[0]!.reasons).toContain("unknown_baseline");
  });

  it.each(["active", "gap", "generation", "before_receipt", "started_before_continuation", "missing_replay"])(
    "does not infer an idle replay baseline with %s", reason => {
      const f = fixture();
      if (reason === "before_receipt") f.observe(1, 100, "old-turn");
      if (reason === "started_before_continuation") f.capture.started({ turnId: "racing-turn", generation: 1, sequence: 3 });
      f.capture.resumed({ generation: 1, sequence: 2, idle: reason !== "active" });
      if (!["before_receipt", "missing_replay"].includes(reason)) f.observe(4, 100, "old-turn");
      if (reason === "gap") f.capture.gap("capture_gap");
      const generation = reason === "generation" ? 2 : 1;
      f.capture.started({ turnId: "new-turn", generation, sequence: 5 });
      f.observe(6, 120, "new-turn", generation);
      expect(intervals(f.observations)).toHaveLength(0);
    },
  );

  it("does not assign a counter catch-up across disconnect to the newest turn", () => {
    const f = fixture(); f.observe(1, 100); f.capture.gap("capture_gap"); f.observe(2, 150); f.observe(3, 170);
    expect(intervals(f.observations).map(fact => fact.tokens.input)).toEqual(["20"]);
    expect(f.gap).toHaveBeenCalledWith("capture_gap");
  });

  it("does not treat turn-start as proof that the prior checkpoint was final", () => {
    const f = fixture(); f.observe(1, 100); f.observe(2, 150, "turn-2");
    expect(intervals(f.observations)).toHaveLength(0);
    f.capture.started({turnId: "turn-3", generation: 1, sequence: 2}); f.observe(3, 180, "turn-3");
    expect(intervals(f.observations)).toHaveLength(0);
    f.observe(4, 200, "turn-3");
    expect(intervals(f.observations)[0]!.tokens.input).toBe("20");
  });

  it("includes the first interval after an ordered completed-to-started boundary", () => {
    const f = fixture(); f.observe(1, 100, "turn-1");
    f.capture.completed({turnId: "turn-1", generation: 1, sequence: 2});
    f.capture.started({turnId: "turn-2", generation: 1, sequence: 3});
    f.observe(4, 120, "turn-2"); f.observe(5, 150, "turn-2");
    expect(intervals(f.observations).map(fact => fact.tokens.input)).toEqual(["20", "30"]);
    expect(intervals(f.observations).every(fact => fact.turn?.scope === "main_loop" && fact.quality === "complete")).toBe(true);
    expect(intervals(f.observations).every(fact => !fact.reasons.includes("unknown_baseline"))).toBe(true);
  });

  it.each(["gap", "generation", "late_checkpoint", "wrong_completion", "reordered_start"])(
    "does not use a completed-to-started boundary after %s", reason => {
      const f = fixture(); f.observe(1, 100, "turn-1");
      f.capture.completed({turnId: reason === "wrong_completion" ? "other-turn" : "turn-1", generation: 1, sequence: 2});
      if (reason === "gap") f.capture.gap("capture_gap");
      const generation = reason === "generation" ? 2 : 1;
      f.capture.started({turnId: "turn-2", generation, sequence: reason === "reordered_start" ? 1 : 3});
      if (reason === "late_checkpoint") f.observe(4, 110, "turn-1");
      f.observe(5, 120, "turn-2", generation);
      expect(intervals(f.observations).filter(fact => fact.turn?.backendTurnId === codexBackendTurnId("native-thread", "turn-2"))).toHaveLength(0);
    },
  );

  it("loses the proved turn baseline when capture continuity is broken", () => {
    const f = fixture(); f.observe(1, 100, "turn-1");
    f.capture.completed({turnId: "turn-1", generation: 1, sequence: 2});
    f.capture.started({turnId: "turn-2", generation: 1, sequence: 3});
    f.observe(4, 120, "turn-2"); f.capture.gap("capture_gap");
    f.observe(5, 150, "turn-2"); f.observe(6, 180, "turn-2");
    const recorded = intervals(f.observations);
    expect(recorded.map(fact => fact.tokens.input)).toEqual(["20", "30"]);
    expect(recorded[0]!.reasons).not.toContain("unknown_baseline");
    expect(recorded[1]!.reasons).toContain("unknown_baseline");
    expect(recorded[1]).toMatchObject({quality: "partial", turn: {scope: "partial_interval"}});
  });

  it("keeps restored totals in the same source across an app-server generation change", () => {
    // Pinned 0.153.0 thread_resume.rs:3502 restores total150 from a saved rollout
    // in a fresh app-server; session/mod.rs:1450 seeds the cumulative accumulator.
    const f = fixture(); f.observe(1, 150); f.capture.gap("capture_gap");
    f.observe(1, 150, "turn-1", 2); f.observe(2, 175, "turn-1", 2);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.observations.map(observation => observation.facts[0]!.tokens.input)).toEqual(["150", "150", "175"]);
    expect(intervals(f.observations).map(fact => fact.tokens.input)).toEqual(["25"]);
  });

  it("never creates a reset series just because a resumed generation reports lower totals", () => {
    const f = fixture(); f.observe(1, 150); f.capture.gap("capture_gap");
    f.observe(1, 20, "turn-1", 2);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.open.mock.calls[0]![0].epoch).toBe("native-counter-v1");
    expect(intervals(f.observations)).toHaveLength(0);
    // The durable receiver compares20 with its preserved150 checkpoint and
    // holds it as a regression. Adapter-local generation loss cannot erase it.
    expect(f.observations.at(-1)?.replaceCheckpoint).toBe(true);
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

  it("carries the supplied effective tuple without changing measurements", () => {
    const f = fixture();
    const usage = { total: { inputTokens: 100, outputTokens: 0, totalTokens: 100, cachedInputTokens: 2, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
      last: { inputTokens: 7, outputTokens: 0, totalTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 }, modelContextWindow: 100 };
    f.observe(1, 100);
    f.capture.observe({ generation: 1, sequence: 2, turnId: "turn-1", usage,
      attribution: { model: { provider: "openai", model: "gpt-5.6" }, reasoningEffort: "high" } });
    f.capture.observe({ generation: 1, sequence: 3, turnId: "turn-1", usage: { ...usage, total: { ...usage.total, inputTokens: 101 } },
      attribution: { model: { provider: "", model: "m".repeat(241) }, reasoningEffort: "x".repeat(65) } });
    expect(f.observations.map(observation => observation.attribution)).toEqual([undefined,
      { model: { provider: "openai", model: "gpt-5.6" }, reasoningEffort: "high" }, { model: null, reasoningEffort: null }]);
    expect(f.observations.flatMap(observation => observation.facts.map(fact => fact.models)))
      .toEqual(Array(f.observations.flatMap(observation => observation.facts).length).fill([{ provider: null, model: null }]));
    expect(f.gap).not.toHaveBeenCalled();
  });

  it("rejects unsafe integers without retrying provider work", () => {
    const f = fixture(); f.observe(1, Number.MAX_SAFE_INTEGER + 1);
    expect(f.observations).toHaveLength(0);
    expect(f.gap).toHaveBeenCalledWith("capture_failed");
  });
});
