import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configurationDocumentSchema, type ConfigurationDocument, type ConfigurationLifecycleRequest, type ConfigurationLifecycleResult, type SaveConfigurationRequest } from "../../src/shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { HostPairingRepository } from "../../src/server/host-pairing/host-pairing-repository.js";
import { SingleUserIdentityProvider, type RequestScope } from "../../src/server/identity/identity-provider.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";

describe("Codex web search migration", () => {
  it("clears only obsolete auxiliary Grok selections across owners and replays migrated saves", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-codex-search-migration-"));
    const filename = path.join(directory, "state.sqlite");
    const initial = openPreCodexSearchDatabase(filename);
    let database = initial.database;
    try {
      const { scope } = initial;
      const otherTenant = randomUUID();
      database.prepare("INSERT INTO tenants(id,created_at) VALUES (?,0)").run(otherTenant);
      const owners = [scope, { tenantId: otherTenant, principalId: scope.principalId },
        { ...scope, principalId: randomUUID() }, { ...scope, principalId: randomUUID() }];
      for (const owner of owners.slice(1)) {
        database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES (?,?,'local_human',0)")
          .run(owner.tenantId, owner.principalId);
      }
      const selections = [{ provider: "grok_cli", grokHome: "/retired/grok-auth" }, { provider: "grok_cli" },
        { provider: "codex_cli", codexHome: "/existing/codex-auth" }, null];
      const saves = owners.map((owner, index) => {
        const document = { ...conversationConfiguration(`Owner ${index}`), webSearch: selections[index] };
        const historical = { ...document, executionEnvironments: document.executionEnvironments.map(environment => ({ ...environment, label: `Historical ${index}` })) };
        const request = { mutationId: randomUUID(), expectedRevision: 2, configuration: historical };
        const result = { revision: 3, configuration: historical, runtimes: [] };
        const stored = { request_json: JSON.stringify(request, null, 2), result_json: JSON.stringify(result, null, 2), request_fingerprint: configurationFingerprint(request) };
        const configurationJson = JSON.stringify(document, null, 2);
        database.prepare("INSERT INTO principal_execution_configuration VALUES (?,?,?,?,?)")
          .run(owner.tenantId, owner.principalId, 9, configurationJson, 123);
        database.prepare("INSERT INTO execution_configuration_receipts VALUES (?,?,?,?,?,?,?,?)")
          .run(owner.tenantId, owner.principalId, request.mutationId, "save", stored.request_fingerprint, stored.request_json, stored.result_json, 456);
        return { owner, document, request, result, stored, configurationJson, changed: index < 2 };
      });
      const lifecycleRequest: ConfigurationLifecycleRequest = {
        mutationId: randomUUID(), resourceKind: "backend", resourceId: "grok", action: "start", expectedRevision: 8, expectedIncarnation: null, impactToken: null,
      };
      const lifecycleResult: ConfigurationLifecycleResult = {
        mutationId: lifecycleRequest.mutationId, state: "pending", runtime: {
          resourceKind: "backend", resourceId: "grok", desiredRevision: 9, effectiveRevision: null, applyState: "pending",
          preference: "automatic", connectionState: "unknown", incarnation: null, softwareVersion: null,
          upgradeState: "unknown", activeResources: 0, supportedActions: ["start"], lastError: null,
        },
      };
      const lifecycleRow = { request_json: JSON.stringify(lifecycleRequest, null, 2), result_json: JSON.stringify(lifecycleResult, null, 2), request_fingerprint: configurationFingerprint(lifecycleRequest) };
      database.prepare("INSERT INTO execution_configuration_receipts VALUES (?,?,?,?,?,?,?,?)")
        .run(scope.tenantId, scope.principalId, lifecycleRequest.mutationId, "lifecycle", lifecycleRow.request_fingerprint, lifecycleRow.request_json, lifecycleRow.result_json, 457);

      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const migratedRows = database.prepare("SELECT * FROM principal_execution_configuration ORDER BY tenant_id, owner_principal_id").all();
      const migratedReceipts = database.prepare("SELECT * FROM execution_configuration_receipts ORDER BY tenant_id, owner_principal_id, mutation_id").all();
      database.close();
      database = openOverlayDatabase(filename, { migrate: false });
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(database.prepare("SELECT * FROM principal_execution_configuration ORDER BY tenant_id, owner_principal_id").all()).toEqual(migratedRows);
      expect(database.prepare("SELECT * FROM execution_configuration_receipts ORDER BY tenant_id, owner_principal_id, mutation_id").all()).toEqual(migratedReceipts);

      const repository = new ConfigurationRepository(database);
      for (const { owner, document, request, result, stored, configurationJson, changed } of saves) {
        const expectedDocument = configurationDocumentSchema.parse({ ...document, webSearch: changed ? null : document.webSearch });
        expect(repository.get(owner)).toEqual({ revision: 9, configuration: expectedDocument, runtimes: [] });
        const row = database.prepare("SELECT configuration_json, revision, updated_at FROM principal_execution_configuration WHERE tenant_id = ? AND owner_principal_id = ?")
          .get(owner.tenantId, owner.principalId);
        expect(row).toEqual({ configuration_json: changed ? JSON.stringify(expectedDocument) : configurationJson, revision: 9, updated_at: 123 });
        const migratedRequest: SaveConfigurationRequest = { ...request, configuration: configurationDocumentSchema.parse({ ...request.configuration, webSearch: changed ? null : request.configuration.webSearch }) };
        const migratedResult = { ...result, configuration: migratedRequest.configuration };
        const receipt = database.prepare("SELECT request_json, request_fingerprint, result_json, created_at FROM execution_configuration_receipts WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?")
          .get(owner.tenantId, owner.principalId, request.mutationId) as typeof stored & { created_at: number };
        expect(JSON.parse(receipt.request_json)).toEqual(migratedRequest);
        expect(JSON.parse(receipt.result_json)).toEqual(migratedResult);
        expect(receipt.request_fingerprint).toBe(configurationFingerprint(migratedRequest));
        expect(receipt.created_at).toBe(456);
        if (!changed) expect(receipt).toEqual({ ...stored, created_at: 456 });
        expect(repository.replaySave(owner, migratedRequest)).toEqual(migratedResult);
        const wrongOwner = owners.find(candidate => candidate.tenantId !== owner.tenantId || candidate.principalId !== owner.principalId)!;
        expect(repository.replaySave(wrongOwner, migratedRequest)).toBeUndefined();
        expect(() => repository.replaySave(owner, { ...migratedRequest, expectedRevision: 99 })).toThrow("mutation ID");
      }
      expect(repository.replayLifecycle(scope, lifecycleRequest)).toEqual(lifecycleResult);
      expect(repository.pendingLifecycle(scope)).toEqual([{ request: lifecycleRequest, result: lifecycleResult }]);
      expect(database.prepare("SELECT request_json, result_json, request_fingerprint FROM execution_configuration_receipts WHERE mutation_id = ?")
        .get(lifecycleRequest.mutationId)).toEqual(lifecycleRow);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps pairing decisions and their matching saves replayable without changing pairing requests", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-codex-search-pairing-"));
    const initial = openPreCodexSearchDatabase(path.join(directory, "state.sqlite"));
    const { database, scope } = initial;
    try {
      const now = () => 1_800_000_000_000;
      const configuration = new ConfigurationRepository(database, now);
      const projection = new ConfigurationProjection(database, { pi: "test", codex_app_server: "test", claude_agent_sdk: "test", grok_build: "test" }, now);
      const hosts = new HostPairingRepository(database, configuration, { project: (owner, document) => projection.project(owner, document), now });
      const metadata = { hostname: "migration-host", platform: "linux" as const, architecture: "x64", account: "operator", connectorVersion: "test" };
      const registration = hosts.register(scope, { connectorId: randomUUID(), registrationAttemptId: randomUUID(), metadata });
      const acceptance = { mutationId: randomUUID(), registrationId: registration.id, expectedRegistrationRevision: registration.revision,
        expectedConfigurationRevision: 0, label: "Retained host", workspaceRoots: ["/work"],
        operations: { kind: "sidecar" as const, enabledCapabilities: ["workspace_files" as const] } };
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
      const saves = database.prepare("SELECT mutation_id, request_json, request_fingerprint, result_json FROM execution_configuration_receipts WHERE operation = 'save'")
        .all() as { mutation_id: string; request_json: string; request_fingerprint: string; result_json: string }[];
      const pairingRows = database.prepare("SELECT * FROM host_pairing_receipts ORDER BY mutation_id").all();

      // Reconstruct only the obsolete auxiliary selection on genuine snapshots.
      // Conversation, pairing, runtime, and mutation identities stay untouched.
      const oldSelection = { provider: "grok_cli", grokHome: "/retired/grok" };
      database.prepare("UPDATE principal_execution_configuration SET configuration_json = json_set(configuration_json, '$.webSearch', json(?))")
        .run(JSON.stringify(oldSelection));
      for (const save of saves) {
        const oldRequest = { ...JSON.parse(save.request_json), configuration: { ...JSON.parse(save.request_json).configuration, webSearch: oldSelection } };
        const oldResult = { ...JSON.parse(save.result_json), configuration: { ...JSON.parse(save.result_json).configuration, webSearch: oldSelection } };
        database.prepare("UPDATE execution_configuration_receipts SET request_json = ?, request_fingerprint = ?, result_json = ? WHERE mutation_id = ?")
          .run(JSON.stringify(oldRequest), configurationFingerprint(oldRequest), JSON.stringify(oldResult), save.mutation_id);
      }
      database.prepare("UPDATE host_pairing_receipts SET result_json = json_set(result_json, '$.configuration.configuration.webSearch', json(?)) WHERE operation IN ('accept','revoke','reapprove')")
        .run(JSON.stringify(oldSelection));

      applyDatabaseMigrations(database, backendNormalizedMigrations);
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const repository = new ConfigurationRepository(database, now);
      const replay = new HostPairingRepository(database, repository, { project: () => { throw new Error("Unexpected projection during replay"); }, now });
      expect(replay.accept(scope, acceptance)).toEqual(accepted);
      expect(replay.revoke(scope, revocation)).toEqual(revoked);
      expect(replay.reapprove(scope, reapproval)).toEqual(reapproved);
      expect(replay.deny(scope, denial)).toEqual(denied);
      expect(database.prepare("SELECT * FROM host_pairing_receipts ORDER BY mutation_id").all()).toEqual(pairingRows);
      for (const save of saves) {
        expect(repository.replaySave(scope, JSON.parse(save.request_json))).toEqual(JSON.parse(save.result_json));
        expect(database.prepare("SELECT mutation_id, request_json, request_fingerprint, result_json FROM execution_configuration_receipts WHERE mutation_id = ?")
          .get(save.mutation_id)).toEqual(save);
      }
      expect(repository.get(scope)).toEqual(current);
      expect(replay.getPairing(scope, accepted.pairing.id)).toEqual(reapproved.pairing);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function conversationConfiguration(label: string): ConfigurationDocument {
  const environmentId = randomUUID();
  return configurationDocumentSchema.parse({
    executionEnvironments: [{ id: environmentId, kind: "local", label, workspaceRoots: ["/work"],
      workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated", "execution_host"] } }],
    backends: [{ id: "grok", kind: "grok_build", label: "Grok conversations", enabled: true, modelPolicy: { type: "catalog" },
      moduleConfiguration: { connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectoryPolicy: "workspace" } },
        authentication: { type: "native" }, security: { profile: "unrestricted_v1", sandboxProfile: "off", networkAccess: "enabled", approvalMode: "full_access" } } }],
    targets: [{ id: "grok-target", kind: "grok_acp", label: "Grok target", enabled: true, backendInstanceId: "grok", executionEnvironmentId: environmentId,
      moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, reasoningEffort: { type: "modelDefault" } } } }],
    defaultTargetId: "grok-target", webSearch: null,
  });
}

function openPreCodexSearchDatabase(filename: string) {
  const database = openOverlayDatabase(filename);
  try {
    const scope: RequestScope = new SingleUserIdentityProvider(database).getScope();
    const localId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
    const legacy = parseResolvedBackendConfiguration({
      schemaVersion: 10, executionEnvironments: [{ id: localId, kind: "local", label: "Local" }],
      backends: [{ id: "pi", kind: "pi", label: "Pi", enabled: true, modelPolicy: { type: "catalog" } }],
      targets: [{ id: "pi-target", kind: "pi_sdk", label: "Pi", enabled: true, backendInstanceId: "pi", executionEnvironmentId: localId }],
      defaultTargetId: "pi-target",
    });
    applyBackendNormalizationMigration(database, { configuration: legacy, quiescentCutoverConfirmed: true });
    applyDatabaseMigrations(database, backendNormalizedMigrations.filter(migration => migration.version <= 157));
    return { database, scope };
  } catch (error) {
    database.close();
    throw error;
  }
}
