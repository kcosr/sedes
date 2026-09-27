import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageInfo } from "@opencode/client";
import { NO_USAGE_CAPTURE, NO_USAGE_SINK, type UsageObservation, type UsageSink } from "../../src/server/usage/contracts.js";
import { UsageService } from "../../src/server/usage/usage-service.js";
import { durableUsageAccountingMigration } from "../../src/server/db/migrations/110-durable-usage-accounting.js";
import { usageGapSessionScopeMigration } from "../../src/server/db/migrations/111-usage-gap-session-scope.js";
import { usageSubagentsMigration } from "../../src/server/db/migrations/112-usage-subagents.js";
import { usageTimelineMigration } from "../../src/server/db/migrations/113-usage-timeline.js";
import { usageSubagentRecoveryIndexesMigration } from "../../src/server/db/migrations/114-usage-subagent-recovery-indexes.js";
import { OpenCodeUsageAccounting, openCodeUsageAllocations, openCodeUsageCheckpoint } from "../../src/server/backends/opencode/opencode-usage-accounting.js";
import { openCodeHistoryTurnId } from "../../src/server/backends/opencode/opencode-history-projection.js";
import { applicationTurnIdForBackendTurn } from "../../src/server/conversations/conversation-projector.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function setup(proven = true) {
  const fixture = createOpenCodeConversationFixture(); cleanup.push(fixture.dispose);
  vi.spyOn(fixture.repository, "hasCreatedRoot").mockReturnValue(proven);
  return fixture;
}
function recorder() {
  const captured: UsageObservation[] = [];
  const capture = { ...NO_USAGE_CAPTURE, capture: vi.fn((values: readonly UsageObservation[]) => { captured.push(...values); return true; }),
    registerTurns: vi.fn(), gap: vi.fn(), reconcile: vi.fn(() => true), seal: vi.fn() };
  const sink: UsageSink = { ...NO_USAGE_SINK, enabled: true, open: vi.fn(() => capture) };
  const accounting = new OpenCodeUsageAccounting(sink); cleanup.push(() => accounting.close());
  return { capture, captured, sink, accounting };
}
const counts = (input = 10) => ({ input, output: 5, reasoning: 2, cache: { read: 3, write: 4 } });
function history(): SessionMessageInfo[] {
  return [
    { id: "msg_question", type: "user", text: "Question", time: { created: 1 } },
    { id: "msg_answer", type: "assistant", agent: "build", content: [{ type: "text", text: "Answer" }],
      model: { providerID: "fixture", id: "model-actual" }, tokens: counts(), cost: 0.02, time: { created: 2, streamed: 3, completed: 3 } },
    { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 4 } },
  ];
}
function turns(sessionID: string) {
  return [{ backendTurnId: openCodeHistoryTurnId(sessionID, "msg_question"), status: "completed" as const, orderedBackendItemIds: [] }];
}
function canonical(fixture: ReturnType<typeof setup>) {
  fixture.database.exec(`
    ALTER TABLE conversation_bindings ADD COLUMN created_at INTEGER NOT NULL DEFAULT 1790467200000;
    CREATE TABLE conversation_creation_attempts(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,backend_instance_id TEXT,connection_profile_id TEXT,execution_environment_id TEXT,provisional_backend_conversation_id TEXT,provisional_opaque_binding_detail TEXT,force_reset_at INTEGER,phase TEXT);
    CREATE TABLE thread_lineage_closure(tenant_id TEXT,owner_principal_id TEXT,ancestor_thread_id TEXT,descendant_thread_id TEXT);
    CREATE TABLE thread_fork_origins(tenant_id TEXT,owner_principal_id TEXT,child_thread_id TEXT,source_thread_id TEXT,creation_operation_id TEXT,source_thread_state TEXT);
    CREATE TABLE claude_usage_ledgers(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,request_count INTEGER,updated_at INTEGER);
  `);
  for (const migration of [durableUsageAccountingMigration, usageGapSessionScopeMigration, usageSubagentsMigration, usageTimelineMigration, usageSubagentRecoveryIndexesMigration]) fixture.database.exec(migration.sql);
  const sink = new UsageService(fixture.database, { enabled: true });
  const accounting = new OpenCodeUsageAccounting(sink); cleanup.push(() => accounting.close());
  const lease = accounting.acquire(fixture.context, fixture.target, fixture.runtime, fixture.port);
  return { sink, accounting, lease, read: () => sink.read(scope, threadID) };
}

describe("OpenCode usage evidence", () => {
  it("preserves native absence, SDK zeros, disjoint token buckets and tiny estimated costs", () => {
    const { wire } = setup(); wire.session.tokens = counts(); wire.session.cost = 1e-9;
    const fact = openCodeUsageCheckpoint(wire.session).facts[0]!;
    expect(openCodeUsageCheckpoint(wire.session).occurredAt).toBeNull();
    expect(fact).toMatchObject({ tokens: { input: "17", uncachedInput: "10", cacheRead: "3", cacheWrite: "4", output: "7", reasoning: "2", total: "24", requests: null },
      costs: [{ amount: "0.000000001", kind: "estimated", currency: "USD" }], models: [], providerPresence: "unknown", sessionContribution: "checkpoint" });
    const entries = history(); const assistant = entries[1] as Extract<SessionMessageInfo, { type: "assistant" }>;
    delete assistant.tokens; assistant.cost = 0;
    const missing = openCodeUsageAllocations(wire.sessionID, entries, new Set(turns(wire.sessionID).map(turn => turn.backendTurnId)))[0]!.facts[0]!;
    expect(Object.values(missing.tokens).every(value => value === null)).toBe(true);
    expect(missing.costs[0]!.amount).toBe("0");
    assistant.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    expect(openCodeUsageAllocations(wire.sessionID, entries, new Set(turns(wire.sessionID).map(turn => turn.backendTurnId)))[0]!.facts[0]!.tokens.total).toBe("0");
  });
  it("rejects unsafe counts and sums, withholds oversized model labels, and ignores unfinished responses", () => {
    const { wire } = setup(); wire.session.tokens = counts(Number.MAX_SAFE_INTEGER);
    expect(() => openCodeUsageCheckpoint(wire.session)).toThrow();
    wire.session.tokens = counts(Number.MAX_SAFE_INTEGER + 1);
    expect(() => openCodeUsageCheckpoint(wire.session)).toThrow();
    const entries = history(); const assistant = entries[1] as Extract<SessionMessageInfo, { type: "assistant" }>;
    assistant.model.id = "m".repeat(241);
    const ids = new Set(turns(wire.sessionID).map(turn => turn.backendTurnId));
    expect(openCodeUsageAllocations(wire.sessionID, entries, ids)[0]!.facts[0]!.models).toEqual([]);
    delete assistant.time.streamed; delete assistant.time.completed;
    expect(openCodeUsageAllocations(wire.sessionID, entries, ids)).toEqual([]);
  });
  it("does not allocate observers, reads or captures while disabled", async () => {
    const f = setup(); const sink = { ...NO_USAGE_SINK, open: vi.fn() }; const service = new OpenCodeUsageAccounting(sink);
    const lease = service.acquire(f.context, { ...f.target, scope: { ...scope, principalId: "foreign" } }, f.runtime, f.port);
    lease.record(history(), turns(f.wire.sessionID)); await lease.settled(); lease.release(); service.close();
    expect(sink.open).not.toHaveBeenCalled(); expect(f.wire.requests).toEqual([]);
  });
  it("shares actor/read captures, coalesces bursts and seals only after the last pending read", async () => {
    const f = setup(); const { accounting, sink, capture } = recorder();
    const actor = accounting.acquire(f.context, f.target, f.runtime, f.port);
    const { binding } = f.target;
    const reordered = { ...f.target, scope: { principalId: scope.principalId, tenantId: scope.tenantId }, binding: {
      createdAt: "2026-09-27T00:00:00Z", backendConversationId: binding.backendConversationId, executionEnvironmentId: binding.executionEnvironmentId,
      connectionProfileId: binding.connectionProfileId, backendInstanceId: binding.backendInstanceId, applicationThreadId: binding.applicationThreadId,
      ownerPrincipalId: binding.ownerPrincipalId, tenantId: binding.tenantId } };
    const reader = accounting.acquire(f.context, reordered, f.runtime, { ...f.port });
    const route = `/api/session/${f.wire.sessionID}`; const held = f.wire.hold(route);
    actor.record(history(), turns(f.wire.sessionID)); await held.entered;
    for (let i = 0; i < 100; i++) reader.record(history(), turns(f.wire.sessionID));
    reader.release(); expect(capture.seal).not.toHaveBeenCalled(); held.release(); await actor.settled();
    expect(f.wire.requests.filter(request => request.pathname === route)).toHaveLength(2);
    expect(sink.open).toHaveBeenCalledTimes(1); expect(capture.seal).not.toHaveBeenCalled();
    actor.release(); await Promise.resolve(); expect(capture.seal).toHaveBeenCalledWith("detached");
  });
  it("rejects wrong scope, discards late reads after a moved binding, and survives optional capture failures", async () => {
    const f = setup(); const { accounting, captured, capture } = recorder();
    expect(() => accounting.acquire(f.context, { ...f.target, scope: { ...scope, principalId: "foreign" } }, f.runtime, f.port)).toThrow();
    const lease = accounting.acquire(f.context, f.target, f.runtime, f.port);
    lease.record([], []); await lease.settled(); expect(captured).toHaveLength(1);
    capture.capture.mockImplementationOnce(() => { throw new Error("optional sink failed"); });
    lease.record([], []); await expect(lease.settled()).resolves.toBeUndefined(); expect(capture.gap).toHaveBeenCalledWith("capture_failed");
    const held = f.wire.hold(`/api/session/${f.wire.sessionID}`); lease.record([], []); await held.entered;
    vi.spyOn(f.repository, "getBinding").mockReturnValue(undefined); held.release(); await lease.settled();
    expect(captured).toHaveLength(1); expect(capture.gap).toHaveBeenCalledWith("capture_failed");
  });
  it("does not lose a notification queued while the previous reader is completing", async () => {
    const f = setup(); const { accounting, captured, capture } = recorder();
    const lease = accounting.acquire(f.context, f.target, f.runtime, f.port);
    capture.capture.mockImplementationOnce(values => {
      captured.push(...values);
      queueMicrotask(() => queueMicrotask(() => lease.record([], [])));
      return true;
    });
    lease.record([], []);
    await vi.waitFor(() => expect(capture.capture).toHaveBeenCalledTimes(2));
    await lease.settled();
  });
  it("withholds an in-flight checkpoint when the native runtime generation changes", async () => {
    const f = setup(); const { accounting, captured, capture } = recorder();
    const lease = accounting.acquire(f.context, f.target, f.runtime, f.port);
    lease.record([], []); await lease.settled();
    const held = f.wire.hold(`/api/session/${f.wire.sessionID}`); lease.record([], []); await held.entered;
    const prior = f.runtime.snapshot(); vi.spyOn(f.runtime, "snapshot").mockReturnValue({ ...prior, generation: "replacement" });
    held.release(); await lease.settled();
    expect(captured).toHaveLength(1); expect(capture.gap).toHaveBeenCalledWith("capture_failed");
  });
  it("does not allocate copied parent history to a native child or fork counter", async () => {
    const f = setup(); f.wire.session.parentID = "ses_parent";
    const { accounting, sink, captured, capture } = recorder(); const lease = accounting.acquire(f.context, f.target, f.runtime, f.port);
    lease.record(history(), turns(f.wire.sessionID)); await lease.settled();
    expect(sink.open).toHaveBeenCalledWith(expect.objectContaining({ initialBaseline: "unknown", reportedBaseline: expect.any(Object) }));
    expect(captured).toHaveLength(1); expect(capture.gap).toHaveBeenCalledWith("inherited_baseline_unknown");
  });
  it("counts native lifetime totals once across history, read handles, revert and reconnect", async () => {
    const f = setup(); f.wire.session.tokens = counts(); f.wire.session.cost = 0.12;
    const { accounting, lease, read, sink } = canonical(f);
    lease.record(history(), turns(f.wire.sessionID)); await lease.settled();
    expect(read()).toMatchObject({ support: "supported", state: "partial", summary: { metrics: { input: { value: "17" }, total: { value: "24" }, requests: { value: null } }, costs: [{ amount: "0.12" }] } });
    const turn = applicationTurnIdForBackendTurn({ backendInstanceId: f.target.binding.backendInstanceId, sourceApplicationThreadId: threadID, backendTurnId: turns(f.wire.sessionID)[0]!.backendTurnId });
    expect(sink.read(scope, threadID, turn).summary.costs[0]!.amount).toBe("0.02");
    lease.record(history(), turns(f.wire.sessionID)); await lease.settled();
    lease.record([], []); await lease.settled(); // retained detail was removed; lifetime work stays charged
    expect(read().summary.costs[0]!.amount).toBe("0.12");
    lease.release(); await Promise.resolve();
    const replacement = accounting.acquire(f.context, f.target, f.runtime, f.port);
    f.wire.session.tokens = counts(20); f.wire.session.cost = 0.15;
    replacement.record([], []); await replacement.settled();
    expect(read().summary.metrics.input.value).toBe("27"); expect(read().summary.costs[0]!.amount).toBe("0.15");
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM usage_sources").get()).toEqual({ count: 1 });
    expect(read().summary.reasons).toEqual(expect.arrayContaining(["child_coverage_unknown", "model_coverage_unknown"]));
  });
  it("does not retroactively bill imported totals and keeps real counter regressions visible", async () => {
    const f = setup(false); f.wire.session.tokens = counts(100); f.wire.session.cost = 0.5;
    const { lease, read } = canonical(f); lease.record([], []); await lease.settled();
    expect(read().summary.metrics.input.value).toBe("0"); expect(read().summary.reasons).toContain("unknown_baseline");
    f.wire.session.tokens = counts(120); f.wire.session.cost = 0.6;
    lease.record([], []); await lease.settled();
    expect(read().summary.metrics.input.value).toBe("20"); expect(read().summary.costs[0]!.amount).toBe("0.1");
    f.wire.session.tokens = counts(110); f.wire.session.cost = 0.55;
    lease.record([], []); await lease.settled();
    expect(read().summary.reasons).toContain("counter_regression"); expect(read().summary.metrics.input.value).toBe("20");
  });
});
