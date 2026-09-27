import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openCodeNativeEvidenceMigration } from "../../src/server/db/migrations/121-opencode-native-evidence.js";
import { parseOpenCodeBindingDetail, serializeOpenCodeBindingDetail, type OpenCodeBindingDetail } from "../../src/server/backends/opencode/opencode-binding-detail.js";
import { OpenCodeThreadRepository, type OpenCodeOperationEvidence } from "../../src/server/backends/opencode/opencode-thread-repository.js";
const scope = { tenantId: "tenant", principalId: "principal" };
const detail: OpenCodeBindingDetail = { version: 1, sessionId: "session", ...scope, backendInstanceId: "backend",
  connectionProfileId: "connection", executionEnvironmentId: "local", canonicalWorkspacePath: "/workspace", nativeNamespaceKey: "native-store" };
const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture() {
  const database = new Database(":memory:"); databases.push(database);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE agent_backend_instances (tenant_id TEXT, id TEXT, kind TEXT, PRIMARY KEY(tenant_id,id));
    CREATE TABLE agent_connection_profiles (tenant_id TEXT, owner_principal_id TEXT, id TEXT, kind TEXT, PRIMARY KEY(tenant_id,owner_principal_id,id));
    CREATE TABLE workspaces (tenant_id TEXT, owner_principal_id TEXT, id TEXT, canonical_path TEXT, PRIMARY KEY(tenant_id,owner_principal_id,id));
    CREATE TABLE application_threads (tenant_id TEXT, owner_principal_id TEXT, id TEXT, backend_instance_id TEXT, connection_profile_id TEXT, environment_id TEXT, workspace_id TEXT, PRIMARY KEY(tenant_id,owner_principal_id,id));
    CREATE TABLE conversation_bindings (tenant_id TEXT, owner_principal_id TEXT, application_thread_id TEXT, backend_instance_id TEXT, connection_profile_id TEXT, execution_environment_id TEXT, backend_conversation_id TEXT,
      UNIQUE(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,connection_profile_id,execution_environment_id));
    INSERT INTO agent_backend_instances VALUES ('tenant','backend','opencode');
    INSERT INTO agent_connection_profiles VALUES ('tenant','principal','connection','opencode_http');
    INSERT INTO workspaces VALUES ('tenant','principal','workspace','/workspace');
    INSERT INTO application_threads VALUES ('tenant','principal','thread','backend','connection','local','workspace');
    INSERT INTO application_threads VALUES ('tenant','principal','other-thread','backend','connection','local','workspace');
    INSERT INTO conversation_bindings VALUES ('tenant','principal','thread','backend','connection','local','session');
    INSERT INTO conversation_bindings VALUES ('tenant','principal','other-thread','backend','connection','local','session');
  `);
  database.exec(openCodeNativeEvidenceMigration.sql);
  const repository = new OpenCodeThreadRepository({ database, scope, backendInstanceId: "backend", nativeNamespaceKey: "native-store" });
  return { database, repository };
}
function operation(overrides: Partial<OpenCodeOperationEvidence> = {}): OpenCodeOperationEvidence {
  return { applicationThreadId: "thread", connectionProfileId: "connection", executionEnvironmentId: "local",
    nativeSessionId: "session", applicationOperationId: "operation", operationKind: "create", nativeInputId: null,
    requestFingerprint: "a".repeat(64), deadlineAt: null, ...overrides };
}

describe("OpenCode immutable scoped native evidence", () => {
  it("roundtrips one strict binding shape and rejects alternate or oversized input", () => {
    expect(parseOpenCodeBindingDetail(serializeOpenCodeBindingDetail(detail))).toEqual(detail);
    for (const value of [{ ...detail, version: 2 }, { ...detail, session_id: "session" },
      { ...detail, canonicalWorkspacePath: "/workspace/../other" }, { ...detail, sessionId: "\0" },
      { ...detail, nativeNamespaceKey: "x".repeat(2_000) }]) {
      expect(() => parseOpenCodeBindingDetail(JSON.stringify(value))).toThrow();
    }
  });

  it("never overwrites or adopts another scope, target, namespace or native identity", () => {
    const { repository } = fixture();
    repository.saveBinding(scope, "thread", detail);
    repository.saveBinding(scope, "thread", detail);
    expect(repository.getBinding(scope, "thread")).toBe(serializeOpenCodeBindingDetail(detail));
    for (const change of [{ tenantId: "other" }, { principalId: "other" }, { backendInstanceId: "other" },
      { connectionProfileId: "other" }, { executionEnvironmentId: "other" }, { canonicalWorkspacePath: "/other" },
      { nativeNamespaceKey: "other" }, { sessionId: "other" }]) {
      expect(() => repository.saveBinding(scope, "thread", { ...detail, ...change })).toThrow();
    }
    expect(() => repository.getBinding({ ...scope, principalId: "other" }, "thread")).toThrow();
    expect(() => repository.saveBinding(scope, "other-thread", detail)).toThrow();
  });

  it("checks current shared binding and namespace again on reads", () => {
    const { database, repository } = fixture();
    repository.saveBinding(scope, "thread", detail);
    const other = new OpenCodeThreadRepository({ database, scope, backendInstanceId: "backend", nativeNamespaceKey: "other" });
    expect(() => other.getBinding(scope, "thread")).toThrow();
    database.prepare("UPDATE conversation_bindings SET backend_conversation_id = 'replacement' WHERE application_thread_id = 'thread'").run();
    expect(() => repository.getBinding(scope, "thread")).toThrow();
  });

  it("reserves immutable create evidence before one dispatch and preserves it after response loss", () => {
    const { database, repository } = fixture();
    expect(repository.reserveOperation(scope, operation(), 1)).toMatchObject({ disposition: "prepared", createdAt: 1 });
    expect(repository.markDispatched(scope, "thread", "operation", 2)).toBe(true);
    expect(repository.markDispatched(scope, "thread", "operation", 3)).toBe(false);
    expect(repository.recordOutcome(scope, "thread", "operation", { expected: "dispatched", disposition: "unknown", nativeEvidenceFingerprint: null, now: 4 })).toBe(true);
    const replacement = new OpenCodeThreadRepository({ database, scope, backendInstanceId: "backend", nativeNamespaceKey: "native-store" });
    expect(replacement.reserveOperation(scope, operation(), 5)).toMatchObject({ disposition: "unknown", createdAt: 1 });
    expect(replacement.markDispatched(scope, "thread", "operation", 6)).toBe(false);
    for (const change of [{ requestFingerprint: "b".repeat(64) }, { nativeSessionId: "other" },
      { applicationThreadId: "other-thread" }, { operationKind: "fork" as const }]) {
      expect(() => replacement.reserveOperation(scope, operation(change), 7)).toThrow();
    }
    expect(() => replacement.reserveOperation(scope, operation({ applicationOperationId: "other-operation" }), 7)).toThrow();
  });

  it("requires exact acknowledgement evidence and makes terminal outcomes immutable", () => {
    const { repository } = fixture();
    repository.reserveOperation(scope, operation(), 1);
    expect(() => repository.recordOutcome(scope, "thread", "operation", { expected: "prepared", disposition: "accepted", nativeEvidenceFingerprint: "b".repeat(64), now: 2 })).toThrow();
    repository.markDispatched(scope, "thread", "operation", 2);
    expect(() => repository.recordOutcome(scope, "thread", "operation", { expected: "dispatched", disposition: "accepted", nativeEvidenceFingerprint: null, now: 3 })).toThrow();
    expect(repository.recordOutcome(scope, "thread", "operation", { expected: "dispatched", disposition: "accepted", nativeEvidenceFingerprint: "b".repeat(64), now: 3 })).toBe(true);
    expect(() => repository.recordOutcome(scope, "thread", "operation", { expected: "dispatched", disposition: "unknown", nativeEvidenceFingerprint: null, now: 4 })).toThrow();
    expect(() => repository.recordOutcome(scope, "thread", "operation", { expected: "dispatched", disposition: "accepted", nativeEvidenceFingerprint: "c".repeat(64), now: 4 })).toThrow();
  });

  it("preserves the original Stop deadline and cannot accept a late acknowledgement", () => {
    const { repository } = fixture();
    repository.saveBinding(scope, "thread", detail);
    const input = operation({ operationKind: "interrupt", deadlineAt: 10 });
    repository.reserveOperation(scope, input, 1);
    expect(repository.markDispatched(scope, "thread", "operation", 2)).toBe(true);
    expect(repository.recordOutcome(scope, "thread", "operation", { expected: "dispatched", disposition: "unknown", nativeEvidenceFingerprint: null, now: 10 })).toBe(true);
    expect(() => repository.reserveOperation(scope, { ...input, deadlineAt: 100 }, 11)).toThrow();
    expect(() => repository.recordOutcome(scope, "thread", "operation", { expected: "unknown", disposition: "accepted", nativeEvidenceFingerprint: "b".repeat(64), now: 11 })).toThrow();
    expect(repository.readOperation(scope, "thread", "operation")).toMatchObject({ disposition: "unknown", deadlineAt: 10 });
    repository.reserveOperation(scope, { ...input, applicationOperationId: "new-stop" }, 1);
    expect(repository.markDispatched(scope, "thread", "new-stop", 10)).toBe(false);
  });

  it.each(["submit", "steer", "interrupt"] as const)("binds %s evidence to the exact saved native session on reservation and reads", operationKind => {
    const { database, repository } = fixture();
    const evidence = operation({ operationKind, nativeInputId: operationKind === "interrupt" ? null : "native-input", deadlineAt: operationKind === "interrupt" ? 30_000 : null });
    expect(() => repository.reserveOperation(scope, evidence, 1)).toThrow();
    repository.saveBinding(scope, "thread", detail);
    expect(() => repository.reserveOperation(scope, { ...evidence, nativeSessionId: "another-session" }, 1)).toThrow();
    expect(repository.reserveOperation(scope, evidence, 1)).toMatchObject({ nativeSessionId: detail.sessionId, disposition: "prepared" });
    database.prepare("UPDATE conversation_bindings SET backend_conversation_id = 'replacement' WHERE application_thread_id = 'thread'").run();
    expect(() => repository.readOperation(scope, "thread", "operation")).toThrow();
    expect(() => repository.markDispatched(scope, "thread", "operation", 2)).toThrow();
  });
});
