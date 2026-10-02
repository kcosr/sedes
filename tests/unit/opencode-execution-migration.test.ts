import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { insertPreProjectWorkspace, savedAgentDatabase } from "../support/saved-agent-fixture.js";

function fixture() {
  const { database, scope } = savedAgentDatabase(122);
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = insertPreProjectWorkspace(database, scope, { environmentId: environment.id,
    canonicalPath: "/tmp/opencode-migration", displayName: "Migration", available: true,
    trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 150 });
  database.prepare(`INSERT INTO agent_backend_instances
    (tenant_id,owner_principal_id,id,kind,label,enabled,protocol_release,created_at,updated_at)
    VALUES (?,?,'opencode-v2','opencode','OpenCode',1,'2.0.18',200,200)`)
    .run(scope.tenantId, scope.principalId);
  database.prepare(`INSERT INTO agent_connection_profiles
    (tenant_id,owner_principal_id,id,template_id,backend_instance_id,backend_kind,execution_environment_id,kind,label,enabled,created_at,updated_at)
    VALUES (?,?,'opencode-profile','opencode-template','opencode-v2','opencode',?,'opencode_http','OpenCode',1,200,200)`)
    .run(scope.tenantId, scope.principalId, environment.id);
  const thread = new ConversationBindingRepository(database).createUnboundThread(scope, {
    workspaceId: workspace.id, connectionProfileId: "opencode-profile", title: "OpenCode", now: 210 });
  database.prepare(`INSERT INTO opencode_operation_receipts
    (tenant_id,owner_principal_id,application_thread_id,backend_instance_id,connection_profile_id,
      execution_environment_id,native_namespace_key,native_session_id,application_operation_id,operation_kind,
      request_fingerprint,disposition,native_evidence_fingerprint,created_at,updated_at)
    VALUES (?,?,?,'opencode-v2','opencode-profile',?,'namespace','ses_reserved','operation','create',?,'accepted',?,211,212)`)
    .run(scope.tenantId, scope.principalId, thread.id, environment.id, "a".repeat(64), "b".repeat(64));
  return { database, scope, thread, environment };
}

describe("OpenCode execution migration", () => {
  it("preserves old receipt evidence and checksums while allowing create and first submit to share an operation", () => {
    const { database, scope, thread } = fixture();
    try {
      const prior = database.prepare("SELECT * FROM opencode_operation_receipts").get();
      const checksums = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const { request_source_json, ...migrated } = database.prepare("SELECT * FROM opencode_operation_receipts").get() as Record<string, unknown>;
      expect(migrated).toEqual(prior); expect(request_source_json).toBeNull();
      expect(database.prepare("SELECT * FROM schema_migrations WHERE version <= 122 ORDER BY version").all()).toEqual(checksums);
      database.prepare(`INSERT INTO opencode_operation_receipts
        SELECT tenant_id,owner_principal_id,application_thread_id,backend_instance_id,connection_profile_id,
          execution_environment_id,native_namespace_key,native_session_id,application_operation_id,'submit',
          'msg_reserved',request_fingerprint,request_source_json,deadline_at,'prepared',NULL,created_at,updated_at
        FROM opencode_operation_receipts WHERE operation_kind='create'`).run();
      expect(database.prepare("SELECT operation_kind FROM opencode_operation_receipts ORDER BY operation_kind").all())
        .toEqual([{ operation_kind: "create" }, { operation_kind: "submit" }]);
      expect(database.prepare(`SELECT desired_selection_json,observation_state,revision FROM opencode_thread_settings
        WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=?`).get(scope.tenantId, scope.principalId, thread.id))
        .toEqual({ desired_selection_json: null, observation_state: "unknown", revision: 0 });
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally { database.close(); }
  });

  it("rejects wrong scoped targets and unproved effective settings", () => {
    const { database, scope, thread } = fixture();
    try {
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(() => database.prepare("UPDATE opencode_thread_settings SET observation_state='confirmed'").run()).toThrow();
      expect(() => database.prepare("UPDATE opencode_thread_settings SET connection_profile_id='foreign'").run()).toThrow();
      const insert = database.prepare(`INSERT INTO opencode_operation_settings_snapshots
        VALUES (?,?,?,'operation',?,0,'{"providerID":"p","id":"m"}',212)`);
      insert.run(scope.tenantId, scope.principalId, thread.id, "create");
      insert.run(scope.tenantId, scope.principalId, thread.id, "submit");
      expect(() => insert.run(scope.tenantId, "foreign", thread.id, "steer")).toThrow();
      expect(() => insert.run(scope.tenantId, scope.principalId, thread.id, "submit")).toThrow();
      expect(() => database.prepare("DELETE FROM opencode_thread_settings").run()).toThrow();
    } finally { database.close(); }
  });
});
