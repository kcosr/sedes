import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexRuntimeReceiptsMigration } from "../../src/server/db/migrations/094-codex-runtime-receipts.js";
import { codexApplicationReceiptProofsMigration } from "../../src/server/db/migrations/095-codex-application-receipt-proofs.js";
import { codexActiveSpeedMigration } from "../../src/server/db/migrations/154-codex-active-speed.js";
import { CodexSpeedPublicationRepository } from "../../src/server/backends/codex/codex-speed-publication-repository.js";
import { CodexRuntimeReceiptStore, type CodexRuntimeReceiptObservation } from "../../src/server/backends/codex/runtime/codex-runtime-receipt-store.js";
import type { SpeedResult } from "../../src/shared/provider-features/codex-speed.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const authority = { scope: { ...scope, executionEnvironmentId: "environment", backendInstanceId: "backend" }, runtimeId: "runtime" };
const target = { turnId: "application-turn", activationId: "activation" };
const reservation = { operationId: "native-operation", method: "turn/settings/update" as const, nativeGeneration: 3, requestFingerprint: "a".repeat(64),
  correlation: { kind: "speed" as const, applicationThreadId: "thread", applicationOperationId: "mutation" } };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const db = new Database(":memory:");
  cleanups.push(() => db.close());
  db.exec(codexRuntimeReceiptsMigration.sql);
  db.exec(`CREATE TABLE application_threads(tenant_id TEXT, owner_principal_id TEXT, id TEXT, backing_state TEXT,
    backend_instance_id TEXT, environment_id TEXT, PRIMARY KEY(tenant_id,owner_principal_id,id));
    CREATE TABLE conversation_bindings(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,backend_instance_id TEXT,execution_environment_id TEXT,backend_conversation_id TEXT);
    CREATE TABLE conversation_creation_attempts(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,mutation_id TEXT,phase TEXT,execution_environment_id TEXT,backend_instance_id TEXT);
    CREATE TABLE submission_completion_observations(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,operation_id TEXT,backend_correlation TEXT);
    CREATE TABLE provider_feature_mutation_receipts(tenant_id TEXT,owner_principal_id TEXT,mutation_id TEXT,expected_feature_revision INTEGER,result_json TEXT,PRIMARY KEY(tenant_id,owner_principal_id,mutation_id));
    CREATE TABLE codex_thread_execution_settings(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,revision INTEGER,
      desired_model TEXT,desired_reasoning_effort TEXT,desired_service_tier TEXT,desired_sandbox_mode TEXT,desired_network_access TEXT,desired_approval_policy TEXT,desired_approval_reviewer TEXT);
    INSERT INTO application_threads VALUES('tenant','principal','thread','bound','backend','environment');
    INSERT INTO provider_feature_mutation_receipts VALUES('tenant','principal','mutation',4,'{"saved":"immutable"}');`);
  db.exec(codexApplicationReceiptProofsMigration.sql);
  db.exec(codexActiveSpeedMigration.sql);
  db.pragma("foreign_keys = ON");
  const publications = new CodexSpeedPublicationRepository(db);
  const initial: SpeedResult = { operationId: "mutation", receiptRevision: 1,
    saved: { status: "saved", selection: "fast", desiredRevision: 5 }, currentRun: { status: "pending", target, selection: "fast" } };
  db.transaction(() => publications.create(scope, "thread", initial, 1))();
  cleanups.push(() => publications.release(scope, "mutation"));
  const changed = vi.fn();
  const store = new CodexRuntimeReceiptStore(db, undefined, changed);
  const dispatch = () => { publications.dispatching(scope, "mutation", "continuous-stream"); return store.reserve(authority, reservation); };
  const success = (generation = 3): CodexRuntimeReceiptObservation => ({ status: "completed", operationId: "native-operation", method: "turn/settings/update", receipt: { result: { status: "applied" }, generation, inboundSequence: 8 } });
  return { db, publications, store, changed, dispatch, success };
}

describe("durable Speed publication and remote proof", () => {
  it("atomically reserves exact correlation before submit and refines retained success after carrier loss", async () => {
    const f = fixture();
    expect(() => f.store.reserve(authority, reservation)).toThrow("codex_speed_runtime_owner_missing");
    expect(f.store.pending(authority)).toEqual([]);
    f.dispatch();
    const row = f.db.prepare("SELECT runtime_correlation_json AS value FROM codex_speed_publications").get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ executionEnvironmentId: "environment", backendInstanceId: "backend", runtimeId: "runtime", operationId: "native-operation", generation: 3 });
    f.publications.finish(scope, "mutation", { status: "uncertain", reason: "response_lost", target, selection: "fast" });
    f.publications.release(scope, "mutation");
    f.store.recordOutcome(authority, f.success());
    expect(f.publications.find(scope, "mutation")?.result).toMatchObject({ receiptRevision: 4, saved: { desiredRevision: 5 }, currentRun: { status: "published" } });
    expect(f.db.prepare("SELECT result_json AS value FROM provider_feature_mutation_receipts").get()).toEqual({ value: '{"saved":"immutable"}' });
    await Promise.resolve(); expect(f.changed).toHaveBeenCalledWith(scope, "thread");
    expect(f.store.reconcileRecordedApplicationState(authority)).toBe(1);
    expect(f.store.pending(authority)).toEqual([]);
    expect(f.db.prepare("SELECT count(*) AS total FROM codex_runtime_receipts").get()).toEqual({ total: 0 });
    expect(f.store.reserve(authority, { ...reservation, operationId: "new-random-id" })).toMatchObject({ operationId: "native-operation", state: "reconciled" });
    expect(f.publications.find(scope, "mutation")?.result.currentRun.status).toBe("published");
  });
  it("keeps a host-native timeout uncertain through reconciliation and compaction", () => {
    const f = fixture(); f.dispatch();
    f.store.recordOutcome(authority, { status: "failed", operationId: "native-operation", method: "turn/settings/update",
      failure: { kind: "delivery", code: "timeout", delivery: "sent_outcome_unknown", generation: 3 } });
    expect(f.publications.find(scope, "mutation")?.result.currentRun.status).toBe("uncertain");
    expect(f.store.reconcileRecordedApplicationState(authority)).toBe(1);
    expect(f.store.pending(authority)).toEqual([]);
    expect(f.publications.find(scope, "mutation")?.result.currentRun.status).toBe("uncertain");
    expect(() => f.store.recordOutcome(authority, f.success())).toThrow("outcome_conflict");
  });
  it.each(["tenantId", "principalId", "executionEnvironmentId", "backendInstanceId"] as const)("rejects remote proof from another %s", axis => {
    const f = fixture(); f.dispatch();
    expect(() => f.store.recordOutcome({ ...authority, scope: { ...authority.scope, [axis]: "other" } }, f.success())).toThrow("not_found");
    expect(f.publications.find(scope, "mutation")?.result.currentRun.status).toBe("pending");
  });
  it("does not refine an exact operation from another native generation or runtime", () => {
    const f = fixture(); f.dispatch();
    expect(() => f.store.reserve(authority, { ...reservation, nativeGeneration: 4 })).toThrow("identity_conflict");
    expect(() => f.store.recordOutcome({ ...authority, runtimeId: "other" }, f.success())).toThrow("not_found");
    f.store.recordOutcome(authority, f.success(4));
    expect(f.publications.find(scope, "mutation")?.result.currentRun.status).toBe("pending");
  });
  it.each(["ready", "dispatching"] as const)("closes a crashed %s owner without issuing another native request", phase => {
    const f = fixture(); if (phase === "dispatching") f.dispatch();
    f.db.prepare("UPDATE codex_speed_publications SET executor_id='prior-process'").run();
    const recovered = new CodexSpeedPublicationRepository(f.db).find(scope, "mutation")!;
    expect(recovered.result.currentRun.status).toBe(phase === "ready" ? "not_attempted" : "uncertain");
    expect(recovered.result.saved).toEqual({ status: "saved", selection: "fast", desiredRevision: 5 });
    expect(() => f.publications.dispatching(scope, "mutation", "new-stream")).toThrow("not_owned");
  });
  it("closes a released owner after result persistence failure but preserves its saved receipt", () => {
    const f = fixture(); f.dispatch();
    f.db.exec("CREATE TRIGGER fail_finish BEFORE UPDATE OF phase ON codex_speed_publications WHEN NEW.phase='settled' BEGIN SELECT RAISE(ABORT,'disk failure'); END;");
    expect(() => f.publications.finish(scope, "mutation", { status: "published", target, selection: "fast" })).toThrow("disk failure");
    f.publications.release(scope, "mutation");
    expect(f.publications.find(scope, "mutation")?.result.currentRun.status).toBe("uncertain");
  });
});
