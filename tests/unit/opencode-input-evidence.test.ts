import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { OpenCodeInputEvidenceRepository, openCodeOperationFingerprint, openCodePreparedPayloadFingerprint } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { OpenCodeMutationEvidenceRepository } from "../../src/server/backends/opencode/opencode-mutation-evidence.js";
import { OpenCodeThreadRepository, type OpenCodeOperationKind } from "../../src/server/backends/opencode/opencode-thread-repository.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function fixture() {
  const base = createOpenCodeConversationFixture(); cleanups.push(base.dispose);
  const evidence = new OpenCodeInputEvidenceRepository(base.repository);
  const mutations = new OpenCodeMutationEvidenceRepository(base.repository);
  const reserve = (kind: OpenCodeOperationKind = "submit", operationId = "operation", nativeInputId: string | null = "msg_owned") =>
    base.repository.reserveOperation(scope, { applicationThreadId: threadID,
      connectionProfileId: base.target.binding.connectionProfileId, executionEnvironmentId: base.target.binding.executionEnvironmentId,
      nativeSessionId: base.wire.sessionID, applicationOperationId: operationId, operationKind: kind, nativeInputId,
      requestFingerprint: openCodeOperationFingerprint({ text: "original wire input" }), requestSource: { kind: "user" }, deadlineAt: null,
    }, 1);
  const begin = (kind: "submit" | "steer" = "submit", operationId = "operation", tracker = "tracker-one") => {
    reserve(kind, operationId, `msg_${kind}_${operationId}`);
    return evidence.begin(scope, threadID, operationId, kind, tracker, kind === "submit" ? "queue" : "steer", 2);
  };
  const dispatch = (kind: "submit" | "steer" = "submit", operationId = "operation") =>
    base.repository.markDispatched(scope, threadID, operationId, kind, 3);
  return { ...base, evidence, mutations, reserve, begin, dispatch };
}

describe("OpenCode durable private input and mutation evidence", () => {
  it.each(["cancelled", "reverted"] as const)("records %s admission without inventing enqueue or consumption proof", kind => {
    const f = fixture(); f.begin(); f.dispatch();
    expect(f.evidence.withdraw(scope, threadID, "operation", "submit", kind, "a".repeat(64))).toMatchObject({
      receipt: { disposition: "accepted" }, withdrawalKind: kind, withdrawnFingerprint: "a".repeat(64),
      preparedPayloadFingerprint: null, enqueueSequence: null, consumedFingerprint: null,
    });
  });
  it("tracks native prepared payload separately from immutable original request and consumption", () => {
    const f = fixture(); const prepared = f.begin(); f.dispatch();
    const native = openCodePreparedPayloadFingerprint({ text: "Native hook transformed input", metadata: { prepared: true } });
    const admitted = f.evidence.admit(scope, threadID, "operation", "submit", { payloadFingerprint: native, delivery: "queue", enqueueSequence: 7 });
    expect(admitted).toMatchObject({ preparedPayloadFingerprint: native, consumedFingerprint: null, payloadConflict: false,
      receipt: { disposition: "accepted", requestFingerprint: prepared.receipt.requestFingerprint } });
    expect(admitted.preparedPayloadFingerprint).not.toBe(admitted.receipt.requestFingerprint);
    const consumed = f.evidence.consume(scope, threadID, "operation", "submit", openCodeOperationFingerprint({ exactDelivered: 8 }), native);
    expect(consumed.consumedFingerprint).not.toBeNull(); expect(consumed.payloadConflict).toBe(false);
  });

  it("requires dispatch before admitting, consuming, or withdrawing reserved input", () => {
    const f = fixture(); f.begin(); const digest = "a".repeat(64);
    expect(() => f.evidence.admit(scope, threadID, "operation", "submit", { payloadFingerprint: digest, delivery: "queue" })).toThrow();
    expect(() => f.evidence.consume(scope, threadID, "operation", "submit", digest)).toThrow();
    expect(() => f.evidence.withdraw(scope, threadID, "operation", "submit", "cancelled", digest)).toThrow();
    expect(f.evidence.get(scope, threadID, "operation", "submit")).toMatchObject({ consumedFingerprint: null, withdrawnFingerprint: null,
      preparedPayloadFingerprint: null, receipt: { disposition: "prepared" } });
  });

  it("refreshes tracker identity only until dispatch and preserves it across restarts", () => {
    const f = fixture(); f.begin();
    expect(f.evidence.begin(scope, threadID, "operation", "submit", "tracker-two", "queue").trackerId).toBe("tracker-two");
    f.dispatch();
    expect(f.evidence.begin(scope, threadID, "operation", "submit", "tracker-three", "queue").trackerId).toBe("tracker-two");
    expect(() => f.evidence.begin(scope, threadID, "operation", "submit", "tracker-four", "steer")).toThrow();
    expect(f.evidence.get(scope, threadID, "operation", "submit").trackerId).toBe("tracker-two");
  });

  it.each(["payload", "enqueue"] as const)("retains sticky %s conflicts without replacing the original native evidence", kind => {
    const f = fixture(); f.begin(); f.dispatch();
    const first = { payloadFingerprint: "a".repeat(64), delivery: "queue" as const, enqueueSequence: 2 };
    f.evidence.admit(scope, threadID, "operation", "submit", first);
    f.evidence.admit(scope, threadID, "operation", "submit", {
      ...first, ...(kind === "payload" ? { payloadFingerprint: "b".repeat(64) } : { enqueueSequence: 3 }),
    });
    f.evidence.admit(scope, threadID, "operation", "submit", first);
    expect(f.evidence.consume(scope, threadID, "operation", "submit", "c".repeat(64), first.payloadFingerprint)).toMatchObject({
      preparedPayloadFingerprint: first.payloadFingerprint, enqueueSequence: 2, payloadConflict: true,
    });
  });

  it("preserves exact consumption through subsequent cancellation and revert", () => {
    const f = fixture(); f.begin(); f.dispatch();
    f.evidence.consume(scope, threadID, "operation", "submit", "a".repeat(64));
    f.evidence.withdraw(scope, threadID, "operation", "submit", "cancelled", "b".repeat(64));
    f.evidence.withdraw(scope, threadID, "operation", "submit", "reverted", "c".repeat(64));
    expect(f.evidence.get(scope, threadID, "operation", "submit")).toMatchObject({
      consumedFingerprint: "a".repeat(64), withdrawnFingerprint: "b".repeat(64), withdrawalKind: "cancelled", payloadConflict: false,
    });
  });

  it("isolates principal, thread, native namespace and create/submit/steer operation kinds", () => {
    const f = fixture(); f.reserve("create", "operation", null); f.begin(); f.dispatch(); f.begin("steer");
    f.evidence.consume(scope, threadID, "operation", "submit", "a".repeat(64));
    expect(f.repository.requireOperation(scope, threadID, "operation", "create").disposition).toBe("prepared");
    expect(f.evidence.get(scope, threadID, "operation", "steer").consumedFingerprint).toBeNull();
    expect(() => f.evidence.get({ ...scope, principalId: "other" }, threadID, "operation", "submit")).toThrow();
    expect(() => f.evidence.get(scope, "other-thread", "operation", "submit")).toThrow();
    const foreign = new OpenCodeThreadRepository({ database: f.database, scope, backendInstanceId: f.context.instance.id, nativeNamespaceKey: "other-store" });
    expect(() => new OpenCodeInputEvidenceRepository(foreign).get(scope, threadID, "operation", "submit")).toThrow();
    expect(() => f.evidence.get(scope, threadID, "operation", "create" as never)).toThrow();
    expect(f.evidence.list(scope, threadID)).toHaveLength(2);
  });

  it("freezes mutation intent independently of input phase and rejects changed or unscoped replay", () => {
    const f = fixture(); f.reserve("action", "operation", null); f.reserve("interaction", "operation", null);
    const payload = { kind: "model", selection: { providerID: "provider", id: "model" } };
    f.mutations.prepare(scope, threadID, "operation", "action", payload);
    payload.selection.id = "later-mutated-object";
    expect(f.mutations.find(scope, threadID, "operation", "action")).toEqual({ kind: "model", selection: { providerID: "provider", id: "model" } });
    expect(() => f.mutations.prepare(scope, threadID, "operation", "action", payload)).toThrow();
    f.mutations.prepare(scope, threadID, "operation", "action", { selection: { id: "model", providerID: "provider" }, kind: "model" });
    f.mutations.prepare(scope, threadID, "operation", "interaction", { decision: "reject" });
    expect(f.mutations.find(scope, threadID, "operation", "interaction")).toEqual({ decision: "reject" });
    expect(() => f.mutations.find({ ...scope, tenantId: "other" }, threadID, "operation", "action")).toThrow();
    expect(() => f.mutations.find(scope, "other-thread", "operation", "action")).toThrow();
    expect(() => f.mutations.prepare(scope, threadID, "missing", "action", {})).toThrow();
  });

  it("rejects malformed digests and oversized immutable mutation payloads", () => {
    const f = fixture(); f.begin(); f.dispatch(); f.reserve("action", "large", null);
    expect(() => f.evidence.consume(scope, threadID, "operation", "submit", "not-a-digest")).toThrow();
    expect(() => f.evidence.admit(scope, threadID, "operation", "submit", { payloadFingerprint: "a".repeat(64), delivery: "queue", enqueueSequence: -1 })).toThrow();
    expect(() => f.mutations.prepare(scope, threadID, "large", "action", { text: "x".repeat(1_048_577) })).toThrow();
    expect(f.mutations.find(scope, threadID, "large", "action")).toBeUndefined();
  });

  it("includes only dispatched inputs without consumption, withdrawal, conflict or terminal loss in retirement queries", () => {
    const f = fixture();
    for (const state of ["prepared", "dispatched", "accepted", "unknown", "consumed", "withdrawn", "conflicted", "lost", "not_applied"]) {
      f.begin("submit", state);
      if (state === "prepared") continue;
      if (state === "not_applied") {
        f.repository.recordOutcome(scope, threadID, state, "submit", { expected: "prepared", disposition: "not_applied", nativeEvidenceFingerprint: null, now: 4 });
        continue;
      }
      f.dispatch("submit", state);
      if (state === "accepted" || state === "conflicted") f.evidence.admit(scope, threadID, state, "submit", { payloadFingerprint: "a".repeat(64), delivery: "queue" });
      if (state === "unknown") f.repository.recordOutcome(scope, threadID, state, "submit", { expected: "dispatched", disposition: "unknown", nativeEvidenceFingerprint: null, now: 4 });
      if (state === "consumed") f.evidence.consume(scope, threadID, state, "submit", "a".repeat(64));
      if (state === "withdrawn") f.evidence.withdraw(scope, threadID, state, "submit", "cancelled", "a".repeat(64));
      if (state === "conflicted") f.evidence.admit(scope, threadID, state, "submit", { payloadFingerprint: "b".repeat(64), delivery: "queue" });
      if (state === "lost") f.evidence.recordTerminalLoss(scope, threadID, state, "submit");
    }
    expect(f.evidence.hasUnresolved(scope, threadID)).toBe(true);
    expect(f.evidence.unresolved(scope, threadID).map(row => row.operationId).sort()).toEqual(["accepted", "dispatched", "unknown"]);
    for (const row of f.evidence.unresolved(scope, threadID)) f.evidence.consume(scope, threadID, row.operationId, row.kind, "c".repeat(64));
    expect(f.evidence.hasUnresolved(scope, threadID)).toBe(false); expect(f.evidence.unresolved(scope, threadID)).toEqual([]);
    expect(f.evidence.list(scope, threadID)).toHaveLength(9);
    expect(() => f.evidence.hasUnresolved({ ...scope, principalId: "other" }, threadID)).toThrow();
    expect(f.evidence.unresolved(scope, "other-thread")).toEqual([]);
  });

  it("persists the first tracker loss without forging nonacceptance and permits later exact consumption", () => {
    const f = fixture(); f.begin();
    expect(() => f.evidence.recordTerminalLoss(scope, threadID, "operation", "submit")).toThrow(); f.dispatch();
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    f.evidence.recordTerminalLoss(scope, threadID, "operation", "submit");
    clock.mockReturnValue(200); f.evidence.recordTerminalLoss(scope, threadID, "operation", "submit");
    expect(f.evidence.get(scope, threadID, "operation", "submit")).toMatchObject({ terminalLostAt: 100,
      consumedFingerprint: null, withdrawnFingerprint: null, receipt: { disposition: "dispatched" } });
    expect(f.evidence.hasUnresolved(scope, threadID)).toBe(false);
    expect(() => f.database.prepare("UPDATE opencode_input_evidence SET terminal_lost_at=-1").run()).toThrow();
    const consumed = f.evidence.consume(scope, threadID, "operation", "submit", "a".repeat(64));
    expect(consumed).toMatchObject({ terminalLostAt: 100, consumedFingerprint: "a".repeat(64), receipt: { disposition: "accepted" } });
    expect(f.evidence.unresolved(scope, threadID)).toEqual([]);
    expect(() => f.evidence.recordTerminalLoss({ ...scope, tenantId: "other" }, threadID, "operation", "submit")).toThrow();
  });

  it.each(["consumed", "withdrawn", "conflicted"])("does not replace %s evidence with a terminal-loss marker", state => {
    const f = fixture(); f.begin(); f.dispatch();
    if (state === "consumed") f.evidence.consume(scope, threadID, "operation", "submit", "a".repeat(64));
    if (state === "withdrawn") f.evidence.withdraw(scope, threadID, "operation", "submit", "cancelled", "a".repeat(64));
    if (state === "conflicted") for (const digest of ["a", "b"]) f.evidence.admit(scope, threadID, "operation", "submit", { payloadFingerprint: digest.repeat(64), delivery: "queue" });
    f.evidence.recordTerminalLoss(scope, threadID, "operation", "submit");
    expect(f.evidence.get(scope, threadID, "operation", "submit").terminalLostAt).toBeNull();
    expect(f.evidence.hasUnresolved(scope, threadID)).toBe(false);
  });

  it("applies registered migration 124 forward without changing prior evidence or migration checksums", () => {
    const { database, scope: owner } = savedAgentDatabase(123);
    try {
      const inventory = new InventoryRepository(database); const environment = inventory.getLocalEnvironment(owner);
      const workspace = inventory.upsertWorkspace(owner, { environmentId: environment.id, canonicalPath: "/tmp/retirement-migration",
        displayName: "Migration", available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 200 });
      database.prepare(`INSERT INTO agent_backend_instances
        (tenant_id,owner_principal_id,id,kind,label,enabled,protocol_release,created_at,updated_at)
        VALUES (?,?,'opencode-v2','opencode','OpenCode',1,'2.0.18',200,200)`).run(owner.tenantId, owner.principalId);
      database.prepare(`INSERT INTO agent_connection_profiles
        (tenant_id,owner_principal_id,id,template_id,backend_instance_id,backend_kind,execution_environment_id,kind,label,enabled,created_at,updated_at)
        VALUES (?,?,'opencode-profile','opencode-template','opencode-v2','opencode',?,'opencode_http','OpenCode',1,200,200)`)
        .run(owner.tenantId, owner.principalId, environment.id);
      const thread = new ConversationBindingRepository(database).createUnboundThread(owner, {
        workspaceId: workspace.id, connectionProfileId: "opencode-profile", title: "Migration", now: 201 });
      database.prepare(`INSERT INTO opencode_operation_receipts
        (tenant_id,owner_principal_id,application_thread_id,backend_instance_id,connection_profile_id,execution_environment_id,
        native_namespace_key,native_session_id,application_operation_id,operation_kind,native_input_id,request_fingerprint,disposition,created_at,updated_at)
        VALUES (?,?,?,'opencode-v2','opencode-profile',?,'namespace','ses_reserved','operation','submit','msg_reserved',?,'dispatched',202,202)`)
        .run(owner.tenantId, owner.principalId, thread.id, environment.id, "a".repeat(64));
      database.prepare(`INSERT INTO opencode_input_evidence
        (tenant_id,owner_principal_id,application_operation_id,operation_kind,tracker_id,requested_delivery,updated_at)
        VALUES (?,?,'operation','submit','old-tracker','queue',202)`).run(owner.tenantId, owner.principalId);
      const prior = database.prepare("SELECT * FROM opencode_input_evidence").get();
      const checksums = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      expect(backendNormalizedMigrations.some(migration => migration.version === 124)).toBe(true);
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const { terminal_lost_at, ...preserved } = database.prepare("SELECT * FROM opencode_input_evidence").get() as Record<string, unknown>;
      expect(preserved).toEqual(prior); expect(terminal_lost_at).toBeNull();
      expect(database.prepare("SELECT * FROM schema_migrations WHERE version<=123 ORDER BY version").all()).toEqual(checksums);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name='opencode_input_evidence_unresolved'").get()).toBeDefined();
      expect(database.pragma("foreign_key_check")).toEqual([]); expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally { database.close(); }
  });
});
