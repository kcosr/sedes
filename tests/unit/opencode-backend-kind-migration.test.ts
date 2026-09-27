import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("OpenCode v2 identity migration", () => {
  it("preserves existing identities and principal ownership guards while admitting only matching v2 kinds", () => {
    const { database, scope } = savedAgentDatabase(119);
    try {
      const backends = database.prepare("SELECT * FROM agent_backend_instances ORDER BY id").all();
      const profiles = database.prepare("SELECT * FROM agent_connection_profiles ORDER BY id").all();
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(database.prepare("SELECT * FROM agent_backend_instances ORDER BY id").all()).toEqual(backends);
      expect(database.prepare("SELECT * FROM agent_connection_profiles ORDER BY id").all()).toEqual(profiles);
      const insert = database.prepare(`INSERT INTO agent_backend_instances
        (tenant_id,owner_principal_id,id,kind,label,enabled,protocol_release,created_at,updated_at)
        VALUES (?,?,'opencode-v2','opencode','OpenCode v2',1,'2.0.18',200,200)`);
      expect(() => insert.run(scope.tenantId, null)).toThrow("backend_principal_required");
      insert.run(scope.tenantId, scope.principalId);
      expect(() => database.prepare("UPDATE agent_backend_instances SET owner_principal_id = NULL WHERE id = 'opencode-v2'").run()).toThrow("backend_principal_immutable");
      const profile = database.prepare(`INSERT INTO agent_connection_profiles
        (tenant_id,owner_principal_id,id,template_id,backend_instance_id,backend_kind,execution_environment_id,kind,label,enabled,created_at,updated_at)
        SELECT tenant_id,owner_principal_id,'opencode-profile','opencode-template','opencode-v2','opencode',execution_environment_id,?,'OpenCode',1,200,200 FROM agent_connection_profiles LIMIT 1`);
      expect(() => profile.run("pi_sdk")).toThrow();
      profile.run("opencode_http");
      expect(() => database.prepare("UPDATE agent_connection_profiles SET owner_principal_id='other' WHERE id='opencode-profile'").run()).toThrow("backend_principal_mismatch");
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(() => database.prepare("DELETE FROM principals WHERE tenant_id=? AND id=?").run(scope.tenantId, scope.principalId)).toThrow("backend_principal_still_referenced");
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally { database.close(); }
  });
});
