import { describe, expect, it, vi } from "vitest";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import { CodexSubagentUsageCoordinator } from "../../src/server/backends/codex/codex-subagent-usage.js";
import { CodexSharedClientFacade, type CodexReadyClientGeneration } from "../../src/server/backends/codex/codex-client-facade.js";
import { decodeCodexServerNotificationParams } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import type { UsageObservation, UsageSink } from "../../src/server/usage/contracts.js";

const binding: ConversationBinding = { tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "app",
  backendConversationId: "root", backendInstanceId: "backend", connectionProfileId: "connection", executionEnvironmentId: "environment", createdAt: "2026-09-22T00:00:00Z" };

function fixture() {
  let sequence = 0;
  const observations = new Map<string, UsageObservation[]>();
  const client = new CodexSharedClientFacade({ current: () => ({ generation: 1 } as CodexReadyClientGeneration), latestGeneration: () => 1, retireGeneration: async () => undefined });
  client.updateLifecycle({ state: "ready", generation: 1 });
  const open = vi.fn<UsageSink["open"]>(input => {
    const entries = observations.get(input.nativeSession) ?? [];
    observations.set(input.nativeSession, entries);
    return { registerTurns: vi.fn(), capture: vi.fn(items => { entries.push(...items); return true; }), gap: vi.fn(), seal: vi.fn(), reconcile: vi.fn(() => true) };
  });
  const sink: UsageSink = { open, listSubagentRoots: () => ({ bindings: [], nextCursor: null }), listSubagents: () => [] };
  const onError = vi.fn();
  const coordinator = new CodexSubagentUsageCoordinator({ client, sink, nativeNamespace: "store", runtimeScope: {
    tenantId: binding.tenantId, principalId: binding.ownerPrincipalId, backendInstanceId: binding.backendInstanceId,
    executionEnvironmentId: binding.executionEnvironmentId, connectionProfileId: binding.connectionProfileId }, onError });
  const notify = (method: "item/completed" | "thread/tokenUsage/updated", params: unknown) => client.forwardNotification(1, {
    kind: "decoded_notification", method, params: decodeCodexServerNotificationParams(method, params), generation: 1, sequence: ++sequence,
  });
  const activity = (id: string, parent = "root", kind: "started" | "interacted" | "interrupted" | "completed" = "started") => notify("item/completed", {
    threadId: parent, turnId: "parent-turn", completedAtMs: 1_700_000_000_000, item: { type: "subAgentActivity", id: `activity-${sequence}`, kind, agentThreadId: id, agentPath: "/worker" },
  });
  const usage = (id: string, inputTokens: number) => {
    const total = { inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: inputTokens };
    notify("thread/tokenUsage/updated", { threadId: id, turnId: "child-turn", tokenUsage: { total, last: total, modelContextWindow: 1000 } });
  };
  return { coordinator, open, observations, activity, usage, onError };
}

describe("Codex v2 subagent usage discovery", () => {
  it("admits native v2 start activity and records separate lifetime counters without a collab spawn item", () => {
    const f = fixture(); f.coordinator.registerRoot(binding);
    f.activity("child"); f.usage("child", 40); f.usage("child", 70);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.open.mock.calls[0]?.[0]).toMatchObject({ binding, nativeSession: "child", subagent: { nativeParentSession: "root" } });
    expect(f.observations.get("child")?.map(entry => entry.facts[0])).toMatchObject([
      { kind: "cumulative", turn: null, tokens: { input: "40" } }, { kind: "cumulative", turn: null, tokens: { input: "70" } },
    ]);
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("resolves nested v2 descendants and their latest early counter when root ancestry arrives later", () => {
    const f = fixture();
    f.usage("nested", 10); f.usage("nested", 25); f.activity("nested", "child"); f.activity("child");
    expect(f.open).not.toHaveBeenCalled();
    f.coordinator.registerRoot(binding);
    expect(f.open.mock.calls.map(([input]) => [input.nativeSession, input.subagent?.nativeParentSession])).toEqual([["child", "root"], ["nested", "child"]]);
    expect(f.observations.get("nested")?.map(entry => entry.facts[0]?.tokens.input)).toEqual(["25"]);
    expect(f.onError).not.toHaveBeenCalled();
  });

  it.each(["interacted", "interrupted", "completed"] as const)("does not infer parentage from v2 %s activity", kind => {
    const f = fixture(); f.coordinator.registerRoot(binding);
    f.activity("foreign", "root", kind); f.usage("foreign", 900);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.observations.size).toBe(0);
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("keeps v2 discovery scoped to an admitted root and rejects contradictory parentage", () => {
    const f = fixture(); f.coordinator.registerRoot(binding);
    f.activity("foreign", "unowned"); f.usage("foreign", 900);
    f.activity("child"); f.activity("child", "unowned"); f.usage("child", 20);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.observations.has("foreign")).toBe(false);
    expect(f.observations.get("child")?.[0]?.facts[0]?.tokens.input).toBe("20");
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "codex_subagent_parent_conflict" }));
  });
});
