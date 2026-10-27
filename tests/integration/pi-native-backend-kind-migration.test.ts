import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations, deployedMigrations } from "../../src/server/db/migrate.js";
import { parseBackendConfiguration } from "../../src/server/config/backend-configuration.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";

describe("native Pi backend kind migration", () => {
  it("retains SDK identities and dependent foreign keys while adding scoped RPC identities", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      applyDatabaseMigrations(database, deployedMigrations);
      const scope = new SingleUserIdentityProvider(database).getScope();
      const configuration = parseBackendConfiguration({
        schemaVersion: 10,
        executionEnvironments: [{ id: "10000000-0000-4000-8000-000000000001", kind: "local", label: "Local" }],
        backends: [{ id: "pi-sdk", kind: "pi", label: "Existing SDK", enabled: true, modelPolicy: { type: "catalog" } }],
        targets: [{ id: "sdk-target", kind: "pi_sdk", label: "Existing SDK target", enabled: true, backendInstanceId: "pi-sdk", executionEnvironmentId: "10000000-0000-4000-8000-000000000001" }],
        defaultTargetId: "sdk-target",
      });
      applyBackendNormalizationMigration(database, { configuration: { ...configuration, backends: configuration.backends.map(backend => ({ ...backend, protocolRelease: "0.86.0" })) }, quiescentCutoverConfirmed: true });
      applyDatabaseMigrations(database, backendNormalizedMigrations.filter(migration => migration.version <= 158));
      const backends = database.prepare("SELECT * FROM agent_backend_instances ORDER BY id").all();
      const profiles = database.prepare("SELECT * FROM agent_connection_profiles ORDER BY id").all();
      const existing = database.prepare("SELECT id, execution_environment_id AS environmentId FROM agent_connection_profiles WHERE template_id = 'sdk-target'").get() as { id: string; environmentId: string };
      database.exec(`CREATE TABLE test_preserved_bindings (
        tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, backend_id TEXT NOT NULL, profile_id TEXT NOT NULL,
        FOREIGN KEY (tenant_id, backend_id) REFERENCES agent_backend_instances(tenant_id, id),
        FOREIGN KEY (tenant_id, owner_principal_id, profile_id) REFERENCES agent_connection_profiles(tenant_id, owner_principal_id, id)
      ) STRICT`);
      database.prepare("INSERT INTO test_preserved_bindings VALUES (?, ?, ?, ?)").run(scope.tenantId, scope.principalId, "pi-sdk", existing.id);

      const migrations = backendNormalizedMigrations.filter(migration => migration.version <= 159);
      applyDatabaseMigrations(database, migrations);
      expect(database.prepare("SELECT * FROM agent_backend_instances ORDER BY id").all()).toEqual(backends);
      expect(database.prepare("SELECT * FROM agent_connection_profiles ORDER BY id").all()).toEqual(profiles);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);

      const addBackend = database.prepare(`INSERT INTO agent_backend_instances
        (tenant_id, owner_principal_id, id, kind, label, enabled, protocol_release, created_at, updated_at)
        VALUES (?, ?, ?, 'pi_native', 'Pi', 1, '1.4.0', 1, 1)`);
      addBackend.run(scope.tenantId, scope.principalId, "native-pi");
      expect(() => addBackend.run(scope.tenantId, "unknown-principal", "wrong-owner")).toThrow("backend_principal_required");
      const addProfile = database.prepare(`INSERT INTO agent_connection_profiles
        (tenant_id, owner_principal_id, id, template_id, backend_instance_id, backend_kind, execution_environment_id, kind, label, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pi', 1, 1, 1)`);
      addProfile.run(scope.tenantId, scope.principalId, "native-profile", "native-target", "native-pi", "pi_native", existing.environmentId, "pi_rpc");
      expect(() => addProfile.run(scope.tenantId, scope.principalId, "wrong-profile", "wrong-target", "native-pi", "pi_native", existing.environmentId, "pi_sdk")).toThrow();
      expect(() => addProfile.run(scope.tenantId, scope.principalId, "wrong-profile", "wrong-target", "pi-sdk", "pi", existing.environmentId, "pi_rpc")).toThrow();
      expect(() => addProfile.run(scope.tenantId, "unknown-principal", "wrong-profile", "wrong-target", "native-pi", "pi_native", existing.environmentId, "pi_rpc")).toThrow("backend_principal_mismatch");
      applyDatabaseMigrations(database, migrations);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });
});
