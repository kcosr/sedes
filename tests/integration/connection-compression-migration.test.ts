import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configurationSnapshotSchema, type SaveConfigurationRequest } from "../../src/shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { HostPairingRepository } from "../../src/server/host-pairing/host-pairing-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";

describe("connection compression migration", () => {
  it("durably backfills scoped documents and historical receipts while preserving unrelated state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-compression-migration-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = openPreCompressionDatabase(filename);
    let database = initial.database;
    try {
      const { scope } = initial;
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
      for (const owner of [scope, otherScope]) {
        const scopedRequest = { ...saveRequest, mutationId: randomUUID() };
        database.prepare("INSERT INTO principal_execution_configuration VALUES (?,?,?,?,?)")
          .run(owner.tenantId, owner.principalId, 9, JSON.stringify(oldDocument), 123);
        database.prepare("INSERT INTO execution_configuration_receipts VALUES (?,?,?,?,?,?,?,?)")
          .run(owner.tenantId, owner.principalId, scopedRequest.mutationId, "save", configurationFingerprint(scopedRequest), JSON.stringify(scopedRequest), JSON.stringify(historicalSnapshot), 456);
        database.prepare("INSERT INTO execution_configuration_receipts VALUES (?,?,?,?,?,?,?,?)")
          .run(owner.tenantId, owner.principalId, "lifecycle-request", "lifecycle", "a".repeat(64), '{"retained":"request"}', '{"state":"applied","retained":"result"}', 457);
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
        expect(database.prepare("SELECT request_fingerprint, request_json, result_json FROM execution_configuration_receipts WHERE owner_principal_id = ? AND operation = 'lifecycle'").get(owner.principalId))
          .toEqual({ request_fingerprint: "a".repeat(64), request_json: '{"retained":"request"}', result_json: '{"state":"applied","retained":"result"}' });
      }
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays migrated pairing decisions and their matching configuration saves through the repositories", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-pairing-compression-migration-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = openPreCompressionDatabase(filename);
    let database = initial.database;
    try {
      const { scope } = initial;
      const now = () => 1_800_000_000_000;
      const configuration = new ConfigurationRepository(database, now);
      const projection = new ConfigurationProjection(database, { pi: "test", codex_app_server: "test", claude_agent_sdk: "test", grok_build: "test" }, now);
      const hosts = new HostPairingRepository(database, configuration, { project: (owner, document) => projection.project(owner, document), now });
      const metadata = { hostname: "migration-host", platform: "linux" as const, architecture: "x64", account: "operator", connectorVersion: "test" };
      const registration = hosts.register(scope, { connectorId: randomUUID(), registrationAttemptId: randomUUID(), metadata });
      const acceptance = {
        mutationId: randomUUID(), registrationId: registration.id, expectedRegistrationRevision: registration.revision,
        expectedConfigurationRevision: configuration.get(scope).revision, label: "Migrated host", workspaceRoots: ["/work"],
        operations: { kind: "sidecar" as const, enabledCapabilities: ["workspace_files" as const] },
      };
      const accepted = hosts.accept(scope, acceptance);
      const revocation = { mutationId: randomUUID(), pairingId: accepted.pairing.id, expectedPairingRevision: accepted.pairing.revision,
        expectedConfigurationRevision: accepted.configuration.revision };
      const revoked = hosts.revoke(scope, revocation);
      const reapproval = { mutationId: randomUUID(), pairingId: revoked.pairing.id, expectedPairingRevision: revoked.pairing.revision,
        expectedConfigurationRevision: revoked.configuration.revision };
      const reapproved = hosts.reapprove(scope, reapproval);
      const otherRegistration = hosts.register(scope, { connectorId: randomUUID(), registrationAttemptId: randomUUID(), metadata });
      const denial = { mutationId: randomUUID(), registrationId: otherRegistration.id, expectedRegistrationRevision: otherRegistration.revision };
      const denied = hosts.deny(scope, denial);
      const current = configuration.get(scope);
      const operations = [
        { operation: "accept", request: acceptance, result: accepted },
        { operation: "revoke", request: revocation, result: revoked },
        { operation: "reapprove", request: reapproval, result: reapproved },
      ];
      type StoredReceipt = { request_fingerprint: string; result_json: string; created_at: number };
      const pairingReceipt = (mutationId: string) => database.prepare("SELECT request_fingerprint, result_json, created_at FROM host_pairing_receipts WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?")
        .get(scope.tenantId, scope.principalId, mutationId) as StoredReceipt;
      const originalDenialReceipt = pairingReceipt(denial.mutationId);
      const saves = operations.map(({ request }) => {
        const row = database.prepare("SELECT request_json, request_fingerprint, result_json, created_at FROM execution_configuration_receipts WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ? AND operation = 'save'")
          .get(scope.tenantId, scope.principalId, request.mutationId) as StoredReceipt & { request_json: string };
        return { ...row, request: JSON.parse(row.request_json) as SaveConfigurationRequest, result: configurationSnapshotSchema.parse(JSON.parse(row.result_json)) };
      });

      // Keep genuine registration, pairing, runtime, and receipt shapes. Remove
      // only the field introduced by 157 to reconstruct their earlier JSON contract.
      const before157 = (json: string) => JSON.stringify(JSON.parse(json), (key, value) => key === "connectionCompression" ? undefined : value);
      const oldDocument = before157(JSON.stringify(current.configuration));
      expect(oldDocument).not.toContain("connectionCompression");
      database.prepare("UPDATE principal_execution_configuration SET configuration_json = ? WHERE tenant_id = ? AND owner_principal_id = ?")
        .run(oldDocument, scope.tenantId, scope.principalId);
      for (const save of saves) {
        const requestJson = before157(save.request_json);
        const fingerprint = configurationFingerprint(JSON.parse(requestJson));
        expect(fingerprint).not.toBe(save.request_fingerprint);
        database.prepare("UPDATE execution_configuration_receipts SET request_json = ?, request_fingerprint = ?, result_json = ? WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?")
          .run(requestJson, fingerprint, before157(save.result_json), scope.tenantId, scope.principalId, save.request.mutationId);
      }
      for (const { request } of operations) {
        const receipt = pairingReceipt(request.mutationId);
        expect(receipt.request_fingerprint).toBe(configurationFingerprint(request));
        const resultJson = before157(receipt.result_json);
        expect(resultJson).not.toContain("connectionCompression");
        database.prepare("UPDATE host_pairing_receipts SET result_json = ? WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?")
          .run(resultJson, scope.tenantId, scope.principalId, request.mutationId);
      }
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      database.close();
      database = openOverlayDatabase(filename, { migrate: false });
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const repository = new ConfigurationRepository(database, now);
      const replay = new HostPairingRepository(database, repository, { project: () => { throw new Error("Unexpected projection during replay"); }, now });
      const replayed = [replay.accept(scope, acceptance), replay.revoke(scope, revocation), replay.reapprove(scope, reapproval)];
      for (const [index, { request, result }] of operations.entries()) {
        expect(replayed[index]).toEqual(result);
        expect(replayed[index]!.configuration.configuration.executionEnvironments).toEqual([
          expect.objectContaining({ id: accepted.pairing.executionEnvironmentId, kind: "outbound", connectionCompression: true }),
        ]);
        expect(pairingReceipt(request.mutationId)).toMatchObject({ request_fingerprint: configurationFingerprint(request), created_at: now() });
      }
      for (const save of saves) {
        expect(repository.replaySave(scope, save.request)).toEqual(save.result);
        const migrated = database.prepare("SELECT request_fingerprint, created_at FROM execution_configuration_receipts WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?")
          .get(scope.tenantId, scope.principalId, save.request.mutationId);
        expect(migrated).toEqual({ request_fingerprint: save.request_fingerprint, created_at: save.created_at });
      }
      expect(replay.deny(scope, denial)).toEqual(denied);
      expect(pairingReceipt(denial.mutationId)).toEqual(originalDenialReceipt);
      expect(() => replay.accept(scope, { ...acceptance, label: "Changed host" })).toThrow("mutation ID");
      expect(() => replay.revoke(scope, { ...revocation, expectedConfigurationRevision: 99 })).toThrow("mutation ID");
      expect(() => replay.reapprove(scope, { ...reapproval, expectedConfigurationRevision: 99 })).toThrow("mutation ID");
      const otherScope = { ...scope, principalId: randomUUID() };
      database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES (?,?,'local_human',0)").run(otherScope.tenantId, otherScope.principalId);
      expect(() => replay.accept(otherScope, acceptance)).toThrow("unavailable in this scope");
      expect(() => replay.revoke(otherScope, revocation)).toThrow("unavailable in this scope");
      expect(() => replay.reapprove(otherScope, reapproval)).toThrow("unavailable in this scope");
      expect(repository.get(scope)).toEqual(current);
      expect(replay.getPairing(scope, accepted.pairing.id)).toEqual(reapproved.pairing);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function openPreCompressionDatabase(filename: string) {
  const database = openOverlayDatabase(filename);
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
    return { database, scope };
  } catch (error) {
    database.close();
    throw error;
  }
}
