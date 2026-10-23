import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import { CodexGoalRecoveryReceipts } from "../../src/server/backends/codex/codex-goal-recovery-receipts.js";
import { ProviderFeatureMutationRepository } from "../../src/server/db/repositories/provider-feature-mutation-repository.js";
import type { CodexGoalRecoveryEvidence } from "../../src/server/backends/codex/codex-goal-recovery.js";

const openDatabases: Database.Database[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture() {
  const database = new Database(":memory:");
  openDatabases.push(database);
  database.exec(`
    CREATE TABLE application_threads (
      tenant_id TEXT, owner_principal_id TEXT, id TEXT, backend_instance_id TEXT,
      connection_profile_id TEXT, backing_state TEXT, revision INTEGER,
      PRIMARY KEY(tenant_id, owner_principal_id, id)
    );
    CREATE TABLE provider_feature_mutation_receipts (
      tenant_id TEXT, owner_principal_id TEXT, application_thread_id TEXT, mutation_id TEXT,
      feature_id TEXT, schema_version INTEGER, action_id TEXT, request_fingerprint TEXT,
      expected_thread_revision INTEGER, expected_mutation_revision INTEGER,
      state TEXT CHECK(state IN ('prepared', 'accepted', 'uncertain')),
      desired_postcondition_json TEXT, result_json TEXT, created_at INTEGER, updated_at INTEGER,
      force_reset_at INTEGER, PRIMARY KEY(tenant_id, owner_principal_id, mutation_id)
    );
    INSERT INTO application_threads VALUES ('tenant-1', 'principal-1', 'app-thread', 'codex-1', 'connection-1', 'bound', 5);
  `);
  const binding: ConversationBinding = {
    tenantId: "tenant-1", ownerPrincipalId: "principal-1", applicationThreadId: "app-thread",
    backendInstanceId: "codex-1", connectionProfileId: "connection-1", executionEnvironmentId: "environment-1",
    backendConversationId: "native-thread", createdAt: "2026-10-01T00:00:00.000Z",
  };
  const evidence: CodexGoalRecoveryEvidence = {
    generation: 1, turnId: "native-turn", epoch: 2,
    goal: { threadId: "native-thread", objective: "Finish migration", status: "active", tokenBudget: 1_000,
      tokensUsed: 15, timeUsedSeconds: 1, createdAt: 10, updatedAt: 11 },
  };
  const input = { binding, evidence, mutationId: "retry-1", mutationRevision: 3, now: 100 };
  let now = 200;
  const receipts = new CodexGoalRecoveryReceipts(database, () => now);
  const repository = new ProviderFeatureMutationRepository(database);
  const scope = { tenantId: binding.tenantId, principalId: binding.ownerPrincipalId };
  return { database, binding, evidence, input, receipts, repository, scope, advance: (next: number) => { now = next; } };
}

describe("CodexGoalRecoveryReceipts", () => {
  it("durably admits a resume once before provider work and uses injected finish time", () => {
    const { receipts, input, repository, scope, advance } = fixture();
    const admitted = receipts.begin(input);
    expect(admitted.outcome).toBe("admitted");
    expect(repository.find(scope, input.mutationId)).toMatchObject({
      featureId: "codex.goal", schemaVersion: 1, actionId: "resume", state: "uncertain",
      expectedThreadRevision: 5, expectedMutationRevision: 3, createdAt: 100, updatedAt: 100,
      desiredPostcondition: { kind: "resume", status: "active" }, result: { automaticRetry: true },
    });
    expect(receipts.begin(input)).toEqual({ outcome: "uncertain" });
    advance(350);
    expect(admitted.finish!("accepted")).toBe(true);
    expect(repository.find(scope, input.mutationId)).toMatchObject({
      state: "accepted", updatedAt: 350, result: { automaticRetry: true, outcome: "accepted" },
    });
    expect(receipts.begin(input)).toEqual({ outcome: "accepted" });
    expect(admitted.finish!("accepted")).toBe(false);
  });

  it("never repeats a prepared or uncertain admission", () => {
    const { receipts, input, database } = fixture();
    const first = receipts.begin(input);
    expect(receipts.begin(input)).toEqual({ outcome: "uncertain" });
    database.prepare("UPDATE provider_feature_mutation_receipts SET state = 'prepared'").run();
    expect(receipts.begin(input)).toEqual({ outcome: "uncertain" });
    expect(first.finish!("accepted")).toBe(false);
  });

  it("records rejection without writing the unsupported abandoned database state", () => {
    const { receipts, input, repository, scope } = fixture();
    const first = receipts.begin(input);
    expect(first.finish!("rejected")).toBe(true);
    expect(repository.find(scope, input.mutationId)).toMatchObject({
      state: "uncertain", result: { automaticRetry: true, outcome: "rejected" },
    });
    expect(receipts.begin(input)).toEqual({ outcome: "rejected" });
    expect(first.finish!("accepted")).toBe(false);
  });

  it("leaves uncertain outcomes consumed without allowing a late second finish", () => {
    const { receipts, input, repository, scope } = fixture();
    const first = receipts.begin(input);
    expect(first.finish!("uncertain")).toBe(true);
    expect(receipts.begin(input)).toEqual({ outcome: "uncertain" });
    expect(first.finish!("accepted")).toBe(false);
    expect(repository.find(scope, input.mutationId)?.state).toBe("uncertain");
  });

  it.each([
    { feature_id: "codex.other" },
    { schema_version: 2 },
    { action_id: "pause" },
    { application_thread_id: "other-thread" },
    { request_fingerprint: "a".repeat(64) },
  ])("rejects replay and conditional finish when receipt identity changes: %j", (change) => {
    const { database, receipts, input } = fixture();
    const first = receipts.begin(input);
    const [column, value] = Object.entries(change)[0]!;
    database.prepare(`UPDATE provider_feature_mutation_receipts SET ${column} = ?`).run(value);
    expect(receipts.begin(input)).toEqual({ outcome: "rejected" });
    expect(first.finish!("accepted")).toBe(false);
  });

  it.each([
    { tenantId: "tenant-2" },
    { ownerPrincipalId: "principal-2" },
    { applicationThreadId: "other-thread" },
    { backendInstanceId: "other-backend" },
    { connectionProfileId: "other-connection" },
    { executionEnvironmentId: "other-environment" },
    { createdAt: "2026-10-02T00:00:00.000Z" },
  ])("rejects wrong scope or changed binding: %j", (change) => {
    const { receipts, input, binding } = fixture();
    expect(receipts.begin(input).outcome).toBe("admitted");
    expect(receipts.begin({ ...input, binding: { ...binding, ...change } })).toEqual({ outcome: "rejected" });
  });

  it("rejects a goal belonging to another native thread before admission", () => {
    const { receipts, input, evidence, repository, scope } = fixture();
    expect(receipts.begin({ ...input, evidence: { ...evidence, goal: { ...evidence.goal, threadId: "other-native" } } })).toEqual({ outcome: "rejected" });
    expect(repository.find(scope, input.mutationId)).toBeUndefined();
  });

  it.each(["objective", "createdAt", "tokenBudget"] as const)("rejects changed Goal %s on replay", (property) => {
    const { receipts, input, evidence } = fixture();
    receipts.begin(input);
    const goal = { ...evidence.goal, [property]: property === "objective" ? "Other work" : 999 };
    expect(receipts.begin({ ...input, evidence: { ...evidence, goal } })).toEqual({ outcome: "rejected" });
  });

  it("does not confuse changing counters or connection generation with another admission", () => {
    const { receipts, input, evidence } = fixture();
    const first = receipts.begin(input);
    first.finish!("accepted");
    expect(receipts.begin({ ...input, mutationRevision: 99, evidence: {
      ...evidence, generation: 2, epoch: 50, goal: { ...evidence.goal, tokensUsed: 80, timeUsedSeconds: 5, updatedAt: 40 },
    } })).toEqual({ outcome: "accepted" });
  });

  it.each(["uncertain", "accepted"] as const)("does not revive a force-reset %s receipt", (state) => {
    const { database, receipts, input, repository, scope } = fixture();
    const first = receipts.begin(input);
    if (state === "accepted") expect(first.finish!("accepted")).toBe(true);
    database.prepare("UPDATE provider_feature_mutation_receipts SET force_reset_at = 500").run();
    expect(repository.find(scope, input.mutationId)?.state).toBe("abandoned");
    expect(receipts.begin(input)).toEqual({ outcome: "rejected" });
    expect(first.finish!("accepted")).toBe(false);
  });

  it("cannot finish a receipt moved outside its original scope", () => {
    const { database, receipts, input } = fixture();
    const first = receipts.begin(input);
    database.prepare("UPDATE provider_feature_mutation_receipts SET owner_principal_id = 'principal-2'").run();
    expect(first.finish!("accepted")).toBe(false);
  });

  it("rejects unavailable or unbound targets without creating a receipt", () => {
    const { database, receipts, input, repository, scope } = fixture();
    database.prepare("UPDATE application_threads SET backing_state = 'unbound'").run();
    expect(receipts.begin(input)).toEqual({ outcome: "rejected" });
    expect(repository.find(scope, input.mutationId)).toBeUndefined();
  });

  it("never moves receipt time backwards and refuses invalid injected timestamps", () => {
    const { receipts, input, repository, scope, advance } = fixture();
    const first = receipts.begin(input);
    advance(50);
    expect(first.finish!("accepted")).toBe(true);
    expect(repository.find(scope, input.mutationId)?.updatedAt).toBe(100);
    const next = receipts.begin({ ...input, mutationId: "retry-2" });
    advance(Number.NaN);
    expect(() => next.finish!("accepted")).toThrow("codex_goal_recovery_timestamp_invalid");
    expect(repository.find(scope, "retry-2")?.state).toBe("uncertain");
  });
});
