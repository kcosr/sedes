import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { codexApplicationReceiptProofsMigration } from "../../src/server/db/migrations/095-codex-application-receipt-proofs.js";
import { codexRuntimeReceiptsMigration } from "../../src/server/db/migrations/094-codex-runtime-receipts.js";
import {
  CodexRuntimeReceiptStore,
  type CodexRuntimeReceiptAuthority,
  type CodexRuntimeReceiptObservation,
  type CodexRuntimeReceiptReservation,
} from "../../src/server/backends/codex/runtime/codex-runtime-receipt-store.js";

const authority: CodexRuntimeReceiptAuthority = {
  scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment", backendInstanceId: "backend" },
  runtimeId: "incarnation",
};
const reservation: CodexRuntimeReceiptReservation = {
  operationId: "operation", method: "thread/start", requestFingerprint: "a".repeat(64),
  correlation: { kind: "create", applicationOperationId: "app-operation", applicationThreadId: "app-thread" },
};
const observation: CodexRuntimeReceiptObservation = {
  status: "completed", operationId: "operation", method: "thread/start",
  receipt: { result: { thread: { id: "native-thread", turns: [{ secret: "transcript" }] }, secret: "not retained" },
    generation: 1, inboundSequence: 25 },
};
const resources: (() => void)[] = [];
afterEach(() => { for (const cleanup of resources.splice(0).reverse()) cleanup(); });
function setup(limits?: { maximumRecords: number; maximumRecordsPerRuntime: number; maximumRetiredRuntimes?: number }) {
  const database = new Database(":memory:");
  resources.push(() => database.close());
  initialize(database);
  return new CodexRuntimeReceiptStore(database, limits);
}
function initialize(database: Database.Database) {
  database.exec(codexRuntimeReceiptsMigration.sql);
  database.exec(`CREATE TABLE application_threads (
    tenant_id TEXT, owner_principal_id TEXT, id TEXT, backing_state TEXT,
    backend_instance_id TEXT, environment_id TEXT);
    CREATE TABLE conversation_bindings (tenant_id TEXT, owner_principal_id TEXT,
    application_thread_id TEXT, backend_instance_id TEXT, execution_environment_id TEXT, backend_conversation_id TEXT);
    CREATE TABLE submission_completion_observations (tenant_id TEXT, owner_principal_id TEXT,
    application_thread_id TEXT, operation_id TEXT, backend_correlation TEXT);
    CREATE TABLE conversation_creation_attempts (tenant_id TEXT, owner_principal_id TEXT,
    application_thread_id TEXT, mutation_id TEXT, phase TEXT, execution_environment_id TEXT, backend_instance_id TEXT);`);
  database.exec(codexApplicationReceiptProofsMigration.sql);
}
function applicationState(store: CodexRuntimeReceiptStore) {
  store.database.exec(`INSERT INTO application_threads VALUES ('tenant', 'principal', 'app-thread', 'bound', 'backend', 'environment');
    INSERT INTO conversation_bindings VALUES ('tenant', 'principal', 'app-thread', 'backend', 'environment', 'native-thread');
    INSERT INTO conversation_creation_attempts
      (tenant_id, owner_principal_id, application_thread_id, mutation_id, phase, execution_environment_id, backend_instance_id)
      VALUES ('tenant', 'principal', 'app-thread', 'app-operation', 'bound', 'environment', 'backend');`);
}

describe("durable Codex critical receipt handoff", () => {
  it("recovers reserved operation identity and minimal outcome after main process database reopen", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-receipts-"));
    resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "application.sqlite");
    const first = new Database(filename);
    initialize(first);
    const store = new CodexRuntimeReceiptStore(first);
    store.reserve(authority, reservation);
    store.recordOutcome(authority, observation);
    first.close();
    const second = new Database(filename);
    resources.push(() => second.close());
    const recovered = new CodexRuntimeReceiptStore(second);
    const replay = recovered.reserve(authority, { ...reservation, operationId: "fresh-process-random-id" });
    expect(replay.operationId).toBe("operation");
    expect(replay.outcome).toEqual({ status: "completed", generation: 1, inboundSequence: 25, nativeThreadId: "native-thread" });
    expect(JSON.stringify(recovered.pending(authority))).not.toContain("transcript");
    expect(recovered.recordOutcome(authority, observation)).toBe("recorded");
  });

  it("commits authoritative application state and receipt reconciliation atomically", () => {
    const store = setup();
    store.database.exec("CREATE TABLE app_effects (id TEXT PRIMARY KEY)");
    store.reserve(authority, reservation);
    store.recordOutcome(authority, observation);
    expect(() => store.reconcile(authority, "operation", () => {
      store.database.prepare("INSERT INTO app_effects VALUES (?)").run("bound");
      throw new Error("crash before commit");
    })).toThrow("crash before commit");
    expect(store.database.prepare("SELECT * FROM app_effects").all()).toEqual([]);
    expect(store.pending(authority)[0]?.state).toBe("recorded");
    let commits = 0;
    const commit = () => { commits++; store.database.prepare("INSERT INTO app_effects VALUES (?)").run("bound"); };
    expect(store.reconcile(authority, "operation", commit)).toBe("committed");
    expect(store.reconcile(authority, "operation", commit)).toBe("already_reconciled");
    expect(commits).toBe(1);
    expect(store.pending(authority)).toEqual([]);
    expect(store.reserve(authority, { ...reservation, operationId: "new-id" })).toMatchObject({ operationId: "operation", state: "reconciled", outcome: null });
    expect(store.recordOutcome(authority, observation)).toBe("recorded");
  });

  it.each(["tenantId", "principalId", "executionEnvironmentId", "backendInstanceId"] as const)("denies critical receipt handoff and reconciliation under wrong %s", (axis) => {
    const store = setup();
    store.reserve(authority, reservation);
    const wrong = { ...authority, scope: { ...authority.scope, [axis]: "wrong" } };
    expect(store.pending(wrong)).toEqual([]);
    expect(() => store.recordOutcome(wrong, observation)).toThrow("codex_runtime_receipt_not_found");
    expect(() => store.reconcile(wrong, "operation", () => {})).toThrow("codex_runtime_receipt_not_found");
    expect(store.pending(authority)[0]?.state).toBe("reserved");
  });

  it("does not confuse backend incarnations", () => {
    const store = setup();
    store.reserve(authority, reservation);
    expect(() => store.recordOutcome({ ...authority, runtimeId: "replacement" }, observation)).toThrow("not_found");
  });

  it("rejects operation identity reuse with changed payload, correlation, or outcome", () => {
    const store = setup();
    store.reserve(authority, reservation);
    expect(() => store.reserve(authority, { ...reservation, requestFingerprint: "b".repeat(64) })).toThrow("identity_conflict");
    expect(() => store.reserve(authority, { ...reservation, correlation: { ...reservation.correlation, applicationThreadId: "other" } })).toThrow("identity_conflict");
    store.recordOutcome(authority, observation);
    expect(() => store.recordOutcome(authority, { ...observation, receipt: { ...observation.receipt!, generation: 2 } })).toThrow("outcome_conflict");
  });

  it("preserves unsettled work and dedup tombstones at capacity instead of evicting", () => {
    const store = setup({ maximumRecords: 2, maximumRecordsPerRuntime: 1 });
    store.reserve(authority, reservation);
    const another = { ...reservation, operationId: "second", correlation: { ...reservation.correlation, applicationOperationId: "second" } };
    expect(() => store.reserve(authority, another)).toThrow("capacity_exhausted");
    store.recordOutcome(authority, observation);
    store.reconcile(authority, "operation", () => {});
    expect(() => store.reserve(authority, another)).toThrow("capacity_exhausted");
    store.reserve({ ...authority, runtimeId: "another-incarnation" }, reservation);
    expect(() => store.reserve({ ...authority, runtimeId: "third-incarnation" }, reservation)).toThrow("capacity_exhausted");
    expect(store.reserve(authority, reservation).state).toBe("reconciled");
  });

  it.each([
    { method: "thread/fork", kind: "fork", result: { thread: { id: "fork", turns: ["secret"] } }, identity: { nativeThreadId: "fork" } },
    { method: "turn/start", kind: "start", result: { turn: { id: "turn", items: ["secret"] } }, identity: { nativeTurnId: "turn" } },
    { method: "turn/steer", kind: "steer", result: { turnId: "turn" }, identity: { nativeTurnId: "turn" } },
  ] as const)("retains bounded native identity for $method", ({ method, kind, result, identity }) => {
    const store = setup();
    store.reserve(authority, { ...reservation, method, correlation: { ...reservation.correlation, kind } });
    store.recordOutcome(authority, { ...observation, method, receipt: { result, generation: 1, inboundSequence: 2 } });
    expect(store.pending(authority)[0]?.outcome).toEqual({ status: "completed", generation: 1, inboundSequence: 2, ...identity });
  });

  it("retains uncertainty without copying remote failure messages and tool data", () => {
    const store = setup();
    store.reserve(authority, reservation);
    store.recordOutcome(authority, { status: "failed", operationId: "operation", method: "thread/start",
      failure: { kind: "delivery", code: "timeout", generation: 1, delivery: "sent_outcome_unknown" } });
    expect(store.pending(authority)[0]?.outcome).toEqual({ status: "failed", generation: 1,
      failure: { kind: "delivery", code: "timeout", delivery: "sent_outcome_unknown" } });
  });

  it("permits reconstructible untracked reads but fails closed for missing critical reservations and malformed outcomes", () => {
    const store = setup();
    expect(store.recordOutcome(authority, { ...observation, method: "thread/read" })).toBe("untracked");
    expect(() => store.recordOutcome(authority, observation)).toThrow("not_found");
    store.reserve(authority, reservation);
    expect(() => store.recordOutcome(authority, { ...observation, status: "pending" })).toThrow("unsettled");
    expect(() => store.recordOutcome(authority, { ...observation, receipt: { result: { thread: { id: "x".repeat(257) } }, generation: 1, inboundSequence: 1 } })).toThrow();
    expect(() => store.reconcile(authority, "operation", () => {})).toThrow("unsettled");
  });

  it("reconciles create only after its exact native thread is durably bound in the matching scope", () => {
    const store = setup();
    applicationState(store);
    store.reserve(authority, reservation);
    store.recordOutcome(authority, observation);
    store.database.prepare("UPDATE conversation_bindings SET backend_conversation_id = ?").run("other-native-thread");
    expect(store.reconcileRecordedApplicationState(authority)).toBe(0);
    store.database.prepare("UPDATE conversation_bindings SET backend_conversation_id = ?, execution_environment_id = ?").run("native-thread", "other-environment");
    expect(store.reconcileRecordedApplicationState(authority)).toBe(0);
    store.database.prepare("UPDATE conversation_bindings SET execution_environment_id = ?").run("environment");
    expect(store.reconcileRecordedApplicationState(authority)).toBe(1);
    expect(store.reconcileRecordedApplicationState(authority)).toBe(0);
  });

  it.each(["start", "steer"] as const)("requires exact durable %s acceptance correlation, retaining unknown state", (kind) => {
    const store = setup();
    applicationState(store);
    const method = kind === "start" ? "turn/start" : "turn/steer";
    store.reserve(authority, { ...reservation, method, correlation: { ...reservation.correlation, kind } });
    store.recordOutcome(authority, { ...observation, method,
      receipt: { result: kind === "start" ? { turn: { id: "turn" } } : { turnId: "turn" }, generation: 1, inboundSequence: 1 } });
    expect(store.reconcileRecordedApplicationState(authority)).toBe(0);
    store.database.prepare("INSERT INTO submission_completion_observations (tenant_id, owner_principal_id, application_thread_id, operation_id, backend_correlation) VALUES (?, ?, ?, ?, ?)")
      .run("tenant", "principal", "app-thread", "app-operation", "other-correlation");
    expect(store.reconcileRecordedApplicationState(authority)).toBe(0);
    store.database.prepare("UPDATE submission_completion_observations SET backend_correlation = ?").run("app-operation");
    expect(store.reconcileRecordedApplicationState(authority)).toBe(1);
  });

  it("compacts only positively retired fully reconciled incarnations and permanently fences replay", () => {
    const store = setup({ maximumRecords: 3, maximumRecordsPerRuntime: 2 });
    const proof = { disposition: "confirmed_retired" as const, runtimeId: "incarnation", retirementOperationId: "stop-operation", retiredAt: 10 };
    store.reserve(authority, reservation);
    expect(() => store.compactRetiredRuntime(authority, proof)).toThrow("retirement_unreconciled");
    store.recordOutcome(authority, observation);
    expect(() => store.compactRetiredRuntime(authority, proof)).toThrow("retirement_unreconciled");
    store.reconcile(authority, "operation", () => {});
    expect(() => store.compactRetiredRuntime(authority, { ...proof, runtimeId: "replacement" })).toThrow("retirement_identity_mismatch");
    expect(() => store.compactRetiredRuntime(authority, { ...proof, disposition: "unreachable" } as never)).toThrow();
    expect(store.compactRetiredRuntime(authority, proof)).toBe(1);
    expect(store.compactRetiredRuntime(authority, proof)).toBe(0);
    expect(() => new CodexRuntimeReceiptStore(store.database).reserve(authority, reservation)).toThrow("incarnation_retired");
    expect(() => store.recordOutcome(authority, observation)).toThrow("not_found");
    expect(store.reserve({ ...authority, runtimeId: "replacement" }, reservation).state).toBe("reserved");
  });

  it("bounds retired-incarnation fences without discarding any previous fence", () => {
    const store = setup({ maximumRecords: 3, maximumRecordsPerRuntime: 2, maximumRetiredRuntimes: 1 });
    store.compactRetiredRuntime(authority, { disposition: "confirmed_retired", runtimeId: "incarnation", retirementOperationId: "stop", retiredAt: 1 });
    expect(() => store.compactRetiredRuntime({ ...authority, runtimeId: "second" }, {
      disposition: "confirmed_retired", runtimeId: "second", retirementOperationId: "stop-second", retiredAt: 2,
    })).toThrow("retirement_capacity_exhausted");
    expect(() => store.reserve(authority, reservation)).toThrow("incarnation_retired");
  });
  it("keeps a long-lived runtime below capacity using final application proof and rejects old replay after reopen", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-receipt-retention-"));
    resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "application.sqlite");
    const first = new Database(filename);
    initialize(first);
    const store = new CodexRuntimeReceiptStore(first, { maximumRecords: 2, maximumRecordsPerRuntime: 1 });
    applicationState(store);
    for (let index = 0; index < 12; index++) {
      const operationId = `operation-${index}`;
      const input = { ...reservation, operationId, method: "turn/start",
        correlation: { ...reservation.correlation, kind: "start" as const, applicationOperationId: operationId } };
      store.reserve(authority, input);
      store.recordOutcome(authority, { ...observation, operationId, method: "turn/start",
        receipt: { result: { turn: { id: `turn-${index}` } }, generation: 1, inboundSequence: index } });
      store.database.prepare(`INSERT INTO submission_completion_observations
        (tenant_id, owner_principal_id, application_thread_id, operation_id, backend_correlation) VALUES (?, ?, ?, ?, ?)`)
        .run("tenant", "principal", "app-thread", operationId, operationId);
      expect(store.reconcileRecordedApplicationState(authority)).toBe(1);
      expect(store.database.prepare("SELECT count(*) AS count FROM codex_runtime_receipts").get()).toEqual({ count: 0 });
    }
    first.close();
    const reopened = new Database(filename);
    resources.push(() => reopened.close());
    const recovered = new CodexRuntimeReceiptStore(reopened);
    const old = { ...reservation, operationId: "new-wire-operation", method: "turn/start",
      correlation: { ...reservation.correlation, kind: "start" as const, applicationOperationId: "operation-0" } };
    expect(recovered.reserve(authority, old)).toMatchObject({ operationId: "operation-0", state: "reconciled" });
    expect(() => recovered.reserve(authority, { ...old, requestFingerprint: "b".repeat(64) })).toThrow("identity_conflict");
    expect(() => recovered.reserve(authority, { ...old, operationId: "operation-0",
      correlation: { ...old.correlation, applicationOperationId: "different" } })).toThrow("identity_conflict");
    expect(recovered.recordOutcome(authority, { ...observation, operationId: "operation-0", method: "turn/start",
      receipt: { result: { turn: { id: "turn-0" } }, generation: 1, inboundSequence: 0 } })).toBe("recorded");
    expect(() => recovered.recordOutcome({ ...authority, scope: { ...authority.scope, principalId: "other" } },
      { ...observation, operationId: "operation-0", method: "turn/start" })).toThrow("not_found");
  });

  it("transfers old reconciled creation proof only onto its exact final application owner", () => {
    const store = setup({ maximumRecords: 2, maximumRecordsPerRuntime: 1 });
    applicationState(store);
    store.database.prepare("UPDATE conversation_creation_attempts SET phase = 'prepared'").run();
    store.reserve(authority, reservation);
    store.recordOutcome(authority, observation);
    store.reconcile(authority, reservation.operationId, () => {});
    const next = { ...reservation, operationId: "next", correlation: { ...reservation.correlation, applicationOperationId: "next" } };
    expect(() => store.reserve(authority, next)).toThrow("capacity_exhausted");
    store.database.prepare("UPDATE conversation_creation_attempts SET phase = 'bound'").run();
    expect(store.reserve(authority, next).state).toBe("reserved");
    expect(store.reserve(authority, { ...reservation, operationId: "new" }).state).toBe("reconciled");
    expect(store.recordOutcome(authority, observation)).toBe("recorded");
  });

  it("rolls back receipt compaction if final proof persistence fails", () => {
    const store = setup();
    applicationState(store);
    store.reserve(authority, reservation);
    store.recordOutcome(authority, observation);
    store.database.exec(`CREATE TRIGGER refuse_proof BEFORE UPDATE OF codex_runtime_receipts_json
      ON conversation_creation_attempts BEGIN SELECT RAISE(ABORT, 'proof disk failure'); END;`);
    expect(() => store.reconcileRecordedApplicationState(authority)).toThrow("proof disk failure");
    expect(store.pending(authority)[0]?.state).toBe("recorded");
  });

  it.each([
    { kind: "delivery" as const, code: "unsent", generation: 1, delivery: "not_sent" as const },
    { kind: "remote" as const, code: -32600, generation: 1, rejectionReason: "no_active_turn" as const },
    { kind: "remote" as const, code: -32600, generation: 1, rejectionReason: "expected_turn_mismatch" as const },
  ])("releases only a proven no-effect rejection for intended retry: $kind $rejectionReason", (failure) => {
    const store = setup({ maximumRecords: 1, maximumRecordsPerRuntime: 1 });
    const input = { ...reservation, method: "turn/steer", correlation: { ...reservation.correlation, kind: "steer" as const } };
    store.reserve(authority, input);
    store.recordOutcome(authority, { ...observation, status: "failed", method: "turn/steer", failure });
    const { generation, ...storedFailure } = failure;
    expect(store.pending(authority)[0]?.outcome).toMatchObject({ status: "failed", generation, failure: storedFailure });
    expect(store.releaseRejected({ ...authority, scope: { ...authority.scope, principalId: "wrong" } }, "operation")).toBe(false);
    expect(store.releaseRejected(authority, "operation")).toBe(true);
    expect(store.reserve(authority, { ...input, operationId: "retry" }).operationId).toBe("retry");
  });

  it.each([
    ["thread/start", "create"], ["thread/fork", "fork"], ["turn/start", "start"], ["turn/steer", "steer"],
  ] as const)("releases definitive overload rejection for %s and recovers receipt capacity", (method, kind) => {
    const store = setup({ maximumRecords: 1, maximumRecordsPerRuntime: 1 });
    const input = { ...reservation, method, correlation: { ...reservation.correlation, kind } };
    store.reserve(authority, input);
    store.recordOutcome(authority, { status: "failed", operationId: input.operationId, method,
      failure: { kind: "remote", code: -32001, generation: 1 } });
    expect(() => store.reserve(authority, { ...input, operationId: "other", correlation: { ...input.correlation, applicationOperationId: "other" } })).toThrow("capacity_exhausted");
    expect(store.releaseRejected(authority, input.operationId)).toBe(true);
    expect(store.reserve(authority, { ...input, operationId: "retry" }).operationId).toBe("retry");
  });

  it.each([
    { kind: "delivery" as const, code: "timeout", generation: 1, delivery: "sent_outcome_unknown" as const },
    { kind: "remote" as const, code: -32603, generation: 1 },
    { kind: "remote" as const, code: -32603, generation: 1, rejectionReason: "no_active_turn" as const },
    { kind: "remote" as const, code: -32600, generation: 1, rejectionReason: "no_active_turn" as const },
  ])("preserves unresolved rejection evidence: $kind", (failure) => {
    const store = setup();
    store.reserve(authority, reservation);
    expect(() => store.releaseRejected(authority, "operation")).toThrow("rejection_unconfirmed");
    store.recordOutcome(authority, { ...observation, status: "failed", failure });
    expect(() => store.releaseRejected(authority, "operation")).toThrow("rejection_unconfirmed");
    expect(store.pending(authority)).toHaveLength(1);
  });

});
