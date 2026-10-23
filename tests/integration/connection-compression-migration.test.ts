import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configurationSnapshotSchema } from "../../src/shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";

describe("connection compression migration", () => {
  it("durably backfills scoped documents and historical receipts while preserving unrelated state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-compression-migration-"));
    const filename = path.join(directory, "state.sqlite");
    let database = openOverlayDatabase(filename);
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const localId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
      const legacy = parseResolvedBackendConfiguration({
        schemaVersion: 10, executionEnvironments: [{ id: localId, kind: "local", label: "Local" }],
        backends: [{ id: "pi", kind: "pi", label: "Pi", enabled: true, modelPolicy: { type: "catalog" } }],
        targets: [{ id: "pi-target", kind: "pi_sdk", label: "Pi", enabled: true, backendInstanceId: "pi", executionEnvironmentId: localId }],
        defaultTargetId: "pi-target",
      });
      applyBackendNormalizationMigration(database, { configuration: legacy, quiescentCutoverConfirmed: true });
      applyDatabaseMigrations(database, backendNormalizedMigrations.filter(migration => migration.version <= 156));
      const otherScope = { ...scope, principalId: randomUUID() };
      database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES (?,?,'local_human',0)")
        .run(otherScope.tenantId, otherScope.principalId);
      const oldDocument = {
        executionEnvironments: [
          { id: randomUUID(), kind: "local", label: "Local", workspaceRoots: ["/work"], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } },
          { id: randomUUID(), kind: "ssh", label: "SSH", hostAlias: "build", workspaceRoots: ["/work"], operations: { kind: "none" } },
          { id: randomUUID(), kind: "outbound", label: "Outbound", pairingId: randomUUID(), platform: "linux", workspaceRoots: ["/work"], operations: { kind: "none" } },
        ], backends: [], targets: [], defaultTargetId: null, webSearch: null,
      };
      const migratedDocument = { ...oldDocument, executionEnvironments: oldDocument.executionEnvironments.map(environment =>
        environment.kind === "local" ? environment : { ...environment, connectionCompression: true }) };
      const historicalDocument = { ...oldDocument, executionEnvironments: oldDocument.executionEnvironments.map(environment => ({ ...environment, label: `Historical ${environment.label}` })) };
      const historicalSnapshot = { revision: 3, configuration: historicalDocument, runtimes: [] };
      const saveRequest = { mutationId: "saved-request", expectedRevision: 2, configuration: historicalDocument };
      const pairingDigest = configurationFingerprint({ mutationId: "pairing-request", expectedPairingRevision: 4 });
      for (const owner of [scope, otherScope]) {
        const scopedRequest = { ...saveRequest, mutationId: randomUUID() };
        database.prepare("INSERT INTO principal_execution_configuration VALUES (?,?,?,?,?)")
          .run(owner.tenantId, owner.principalId, 9, JSON.stringify(oldDocument), 123);
        database.prepare("INSERT INTO execution_configuration_receipts VALUES (?,?,?,?,?,?,?,?)")
          .run(owner.tenantId, owner.principalId, scopedRequest.mutationId, "save", configurationFingerprint(scopedRequest), JSON.stringify(scopedRequest), JSON.stringify(historicalSnapshot), 456);
        database.prepare("INSERT INTO execution_configuration_receipts VALUES (?,?,?,?,?,?,?,?)")
          .run(owner.tenantId, owner.principalId, "lifecycle-request", "lifecycle", "a".repeat(64), '{"retained":"request"}', '{"state":"applied","retained":"result"}', 457);
        for (const operation of ["accept", "revoke", "reapprove", "deny"]) {
          const result = operation === "deny" ? { retained: "denial" } : { retained: operation, configuration: historicalSnapshot };
          database.prepare("INSERT INTO host_pairing_receipts VALUES (?,?,?,?,?,?,?)")
            .run(owner.tenantId, owner.principalId, operation, operation, pairingDigest, JSON.stringify(result), 789);
        }
      }
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      database.close();
      database = openOverlayDatabase(filename, { migrate: false });
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const repository = new ConfigurationRepository(database);
      for (const owner of [scope, otherScope]) {
        expect(repository.get(owner)).toEqual({ revision: 9, configuration: migratedDocument, runtimes: [] });
        const row = database.prepare("SELECT request_json, request_fingerprint, result_json, created_at FROM execution_configuration_receipts WHERE tenant_id = ? AND owner_principal_id = ? AND operation = 'save'")
          .get(owner.tenantId, owner.principalId) as { request_json: string; request_fingerprint: string; result_json: string; created_at: number };
        const request = JSON.parse(row.request_json);
        expect(request.configuration.executionEnvironments[1]).toMatchObject({ label: "Historical SSH", connectionCompression: true });
        expect(row.request_fingerprint).toBe(configurationFingerprint(request));
        expect(row.created_at).toBe(456);
        expect(repository.replaySave(owner, request)).toEqual(configurationSnapshotSchema.parse(JSON.parse(row.result_json)));
        expect(repository.replaySave({ ...owner, principalId: owner.principalId === scope.principalId ? otherScope.principalId : scope.principalId }, request)).toBeUndefined();
        expect(() => repository.get({ ...owner, principalId: randomUUID() })).toThrow("ownership");
        for (const operation of ["accept", "revoke", "reapprove", "deny"]) {
          const receipt = database.prepare("SELECT request_fingerprint, result_json, created_at FROM host_pairing_receipts WHERE tenant_id = ? AND owner_principal_id = ? AND operation = ?")
            .get(owner.tenantId, owner.principalId, operation) as { request_fingerprint: string; result_json: string; created_at: number };
          expect(receipt.request_fingerprint).toBe(pairingDigest);
          expect(receipt.created_at).toBe(789);
          const result = JSON.parse(receipt.result_json);
          if (operation === "deny") expect(result).toEqual({ retained: "denial" });
          else {
            expect(result.retained).toBe(operation);
            expect(configurationSnapshotSchema.parse(result.configuration).configuration.executionEnvironments[2])
              .toMatchObject({ label: "Historical Outbound", connectionCompression: true });
          }
        }
        expect(database.prepare("SELECT request_fingerprint, request_json, result_json FROM execution_configuration_receipts WHERE owner_principal_id = ? AND operation = 'lifecycle'").get(owner.principalId))
          .toEqual({ request_fingerprint: "a".repeat(64), request_json: '{"retained":"request"}', result_json: '{"state":"applied","retained":"result"}' });
      }
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
