import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { databaseOwnedConfigurationMigration } from "../../src/server/db/migrations/093-database-owned-configuration.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { ConfigurationAdminService, type ConfigurationRuntimeAdapter } from "../../src/server/configuration-admin/configuration-admin-service.js";
import { configurationDocumentSchema, type ConfigurationDocument, type ConfigurationLifecycleRequest, type ConfigurationRuntimeState } from "../../src/shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { validateConfigurationDocument } from "../../src/server/configuration-admin/configuration-validation.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";

const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const remoteId = "019196f7-a0a8-7bc4-a89b-8cf013978499";
const legacy = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [{ id: environmentId, kind: "local", label: "Local" }],
  backends: [{ id: "pi-primary", kind: "pi", label: "Pi SDK", enabled: true, modelPolicy: { type: "catalog" } }],
  targets: [{ id: "local-primary", kind: "pi_sdk", label: "Local SDK", backendInstanceId: "pi-primary", executionEnvironmentId: environmentId, enabled: true }],
  defaultTargetId: "local-primary",
});
function initialDocument(): ConfigurationDocument {
  return configurationDocumentSchema.parse({
    executionEnvironments: [{ id: environmentId, kind: "local", label: "Local", workspaceRoots: ["/tmp"], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }],
    backends: legacy.backends.map(({ protocolRelease: _release, ...backend }) => backend),
    targets: legacy.targets, defaultTargetId: legacy.defaultTargetId, webSearch: null,
  });
}
const databases: Database.Database[] = [];
function codexTarget(backendInstanceId: string): ConfigurationDocument["targets"][number] {
  return { id: `${backendInstanceId}-target`, kind: "codex_app_server", label: "Codex target", enabled: false,
    backendInstanceId, executionEnvironmentId: environmentId,
    moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "on-request", approvalReviewer: "user", model: { type: "catalogDefault" } } } };
}
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture(imported = true) {
  const database = openOverlayDatabase(":memory:");
  databases.push(database);
  const scope = new SingleUserIdentityProvider(database).getScope();
  applyBackendNormalizationMigration(database, { configuration: legacy, quiescentCutoverConfirmed: true, appliedAt: 100 });
  applyDatabaseMigrations(database, [...backendNormalizedMigrations.filter(migration => migration.version <= 92), databaseOwnedConfigurationMigration]);
  const repository = new ConfigurationRepository(database, () => 1000);
  const projection = new ConfigurationProjection(database, { pi: "0.86.0", codex_app_server: "test", claude_agent_sdk: "test", grok_build: "test" }, () => 1000);
  const document = initialDocument();
  const provenance = { sourceFingerprint: configurationFingerprint(document), sourceLabel: "test-import" };
  const initialize = () => repository.initialize(scope, document, provenance, () => { projection.adoptLegacyOwnership(scope); projection.project(scope, document); });
  if (imported) initialize();
  const authorize = vi.fn(() => {});
  const service = new ConfigurationAdminService(repository, { authorize, projection, now: () => 1000 });
  return { database, scope, repository, projection, document, provenance, initialize, service, authorize };
}
function remoteDocument(): ConfigurationDocument {
  const document = initialDocument();
  document.executionEnvironments.push({ id: remoteId, kind: "ssh", label: "Remote", hostAlias: "workstation", workspaceRoots: ["/work"], operations: { kind: "sidecar", enabledCapabilities: ["workspace_tools", "workspace_context"] } });
  return document;
}

describe("database-owned configuration", () => {
  it("rejects incomplete legacy import before adopting ownership or reserving identities", () => {
    const current = fixture(false);
    const document = { ...current.document, backends: [], executionEnvironments: [], targets: [], defaultTargetId: null };
    const project = vi.fn();
    expect(() => current.repository.initialize(current.scope, document, current.provenance, project)).toThrow("every retained");
    expect(project).not.toHaveBeenCalled();
    expect(current.database.prepare("SELECT count(*) count FROM execution_configuration_identities").get()).toEqual({ count: 0 });
    expect(current.database.prepare("SELECT owner_principal_id owner FROM agent_backend_instances").get()).toEqual({ owner: null });
  });

  it("requires native identity reservations even for direct projection maintenance", () => {
    const current = fixture();
    current.database.prepare("DELETE FROM execution_configuration_identities WHERE resource_kind = 'backend'").run();
    expect(() => current.database.transaction(() => current.projection.project(current.scope, current.document))()).toThrow("matching execution identity");
  });

  it("projects only current runtimes after more than 128 historical identities", () => {
    const current = fixture();
    const old = current.repository.runtime(current.scope, "backend", "pi-primary");
    const insert = current.database.prepare(`INSERT INTO execution_configuration_runtime_state
      (tenant_id, owner_principal_id, resource_kind, resource_id, state_json) VALUES (?, ?, 'backend', ?, ?)`);
    current.database.transaction(() => {
      for (let i = 0; i < 130; i++) insert.run(current.scope.tenantId, current.scope.principalId, `removed-${i}`, JSON.stringify({ ...old, resourceId: `removed-${i}` }));
    })();
    expect(current.repository.get(current.scope).runtimes).toHaveLength(2);
    expect(() => current.repository.beginLifecycle(current.scope, { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "removed-0", action: "stop", expectedIncarnation: null, impactToken: null })).toThrow("removed");
    expect(current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: current.document }).revision).toBe(1);
  });

  it("retires settled receipts at capacity while retaining uncertain lifecycle recovery and fencing expired replay", () => {
    const current = fixture();
    const request = { mutationId: "old-save", expectedRevision: 0, configuration: current.document };
    const result = current.repository.save(current.scope, request);
    const insert = current.database.prepare(`INSERT INTO execution_configuration_receipts
      (tenant_id, owner_principal_id, mutation_id, operation, request_fingerprint, request_json, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    current.database.transaction(() => {
      for (let i = 0; i < 9997; i++) insert.run(current.scope.tenantId, current.scope.principalId, `save-${i}`, "save", configurationFingerprint(request), JSON.stringify(request), JSON.stringify(result), 2000);
      for (const state of ["pending", "unknown"] as const) {
        const pending = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "stop", expectedIncarnation: null, impactToken: null };
        insert.run(current.scope.tenantId, current.scope.principalId, pending.mutationId, "lifecycle", configurationFingerprint(pending), JSON.stringify(pending), JSON.stringify({ mutationId: pending.mutationId, state, runtime: result.runtimes[0] }), 0);
      }
    })();
    expect(current.repository.save(current.scope, { ...request, mutationId: randomUUID(), expectedRevision: 1 }).revision).toBe(2);
    expect(current.database.prepare("SELECT count(*) count FROM execution_configuration_receipts").get()).toEqual({ count: 10000 });
    expect(current.repository.pendingLifecycle(current.scope).map(item => item.result.state).sort()).toEqual(["pending", "unknown"]);
    expect(current.repository.replaySave(current.scope, request)).toBeUndefined();
    expect(() => current.repository.save(current.scope, request)).toThrow("changed");
  });

  it.each(["applied", "rejected", "unavailable"] as const)("reclaims a full ledger of %s lifecycle results within scope and fences expired replay", (state) => {
    const current = fixture();
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0,
      resourceKind: "backend", resourceId: "pi-primary", action: "stop", expectedIncarnation: null, impactToken: null };
    const admitted = current.repository.beginLifecycle(current.scope, request).result;
    const result = current.repository.completeLifecycle(current.scope, request, { ...admitted, state });
    const insert = current.database.prepare(`INSERT INTO execution_configuration_receipts
      (tenant_id, owner_principal_id, mutation_id, operation, request_fingerprint, request_json, result_json, created_at)
      VALUES (?, ?, ?, 'lifecycle', ?, ?, ?, ?)`);
    const other = { ...current.scope, principalId: randomUUID() };
    current.database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES (?,?,'local_human',0)").run(other.tenantId, other.principalId);
    current.database.transaction(() => {
      for (let i = 0; i < 9997; i++) {
        const repeated = { ...request, mutationId: randomUUID() };
        insert.run(current.scope.tenantId, current.scope.principalId, repeated.mutationId,
          configurationFingerprint(repeated), JSON.stringify(repeated), JSON.stringify({ ...result, mutationId: repeated.mutationId }), 2000);
      }
      for (const unsettled of ["pending", "unknown"] as const) {
        const pending = { ...request, mutationId: randomUUID() };
        insert.run(current.scope.tenantId, current.scope.principalId, pending.mutationId,
          configurationFingerprint(pending), JSON.stringify(pending), JSON.stringify({ ...admitted, mutationId: pending.mutationId, state: unsettled }), 0);
      }
      // The same mutation ID in another principal is older but never eligible
      // for this principal's capacity reclamation.
      insert.run(other.tenantId, other.principalId, request.mutationId, configurationFingerprint(request), JSON.stringify(request), JSON.stringify(result), 0);
    })();
    expect(current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 1, configuration: current.document }).revision).toBe(2);
    expect(current.database.prepare("SELECT count(*) count FROM execution_configuration_receipts WHERE owner_principal_id = ?").get(current.scope.principalId)).toEqual({ count: 10000 });
    expect(current.repository.pendingLifecycle(current.scope).map(item => item.result.state).sort()).toEqual(["pending", "unknown"]);
    expect(current.repository.replayLifecycle(current.scope, request)).toBeUndefined();
    expect(() => current.repository.beginLifecycle(current.scope, request)).toThrow("changed");
    expect(current.repository.replayLifecycle(other, request)).toEqual(result);
  });

  it("migrates proven Codex store identities once and allows binary maintenance without retargeting history", () => {
    const current = fixture();
    const document = structuredClone(current.document);
    document.backends.push({ id: "owned-codex", kind: "codex_app_server", label: "Codex", enabled: false, modelPolicy: { type: "catalog" }, moduleConfiguration: {
      connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectory: "/tmp", executablePath: "/bin/codex", codexHome: "/home/account/.codex" } },
      policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["on-request"], allowedApprovalReviewers: ["user"] },
    } });
    document.targets.push(codexTarget("owned-codex"));
    current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: document });
    const backend = document.backends.at(-1)!;
    if (backend.kind !== "codex_app_server") throw new Error("fixture");
    const previous = configurationFingerprint({ kind: backend.kind, environmentId, nativeIdentity: backend.moduleConfiguration.connection });
    current.database.prepare("UPDATE execution_configuration_identities SET identity_fingerprint = ? WHERE resource_id = 'owned-codex'").run("0".repeat(64));
    expect(() => applyDatabaseMigrations(current.database, backendNormalizedMigrations)).toThrow("identity_migration_conflict");
    expect(current.database.prepare("SELECT version FROM schema_migrations WHERE version = 96").get()).toBeUndefined();
    current.database.prepare("UPDATE execution_configuration_identities SET identity_fingerprint = ? WHERE resource_id = 'owned-codex'").run(previous);
    applyDatabaseMigrations(current.database, backendNormalizedMigrations);
    const channel = backend.moduleConfiguration.connection.channel;
    if (channel.type !== "process_stdio") throw new Error("fixture");
    channel.executablePath = "/opt/codex/new";
    channel.workingDirectory = "/work";
    expect(current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 1, configuration: document }).revision).toBe(2);
    channel.codexHome = "/home/other/.codex";
    expect(() => current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 2, configuration: document })).toThrow("immutable");
    applyDatabaseMigrations(current.database, backendNormalizedMigrations);
  });

  it("allows Codex credential reference rotation but keeps endpoint identity immutable", () => {
    const current = fixture();
    const document = structuredClone(current.document);
    document.backends.push({ id: "tcp-codex", kind: "codex_app_server", label: "Codex", enabled: false, modelPolicy: { type: "catalog" }, moduleConfiguration: {
      connection: { ownership: "external", channel: { type: "tcp_websocket", url: "ws://127.0.0.1:4501", authentication: { type: "capability_token", secret: { source: "environment", variable: "SEDES_CODEX_OLD_TOKEN" } } } },
      policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["on-request"], allowedApprovalReviewers: ["user"] },
    } });
    document.targets.push(codexTarget("tcp-codex"));
    current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: document });
    const backend = document.backends.at(-1)!;
    if (backend.kind !== "codex_app_server" || backend.moduleConfiguration.connection.channel.type !== "tcp_websocket") throw new Error("fixture");
    backend.moduleConfiguration.connection.channel.authentication.secret = { source: "environment", variable: "SEDES_CODEX_NEW_TOKEN" };
    expect(current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 1, configuration: document }).revision).toBe(2);
    backend.moduleConfiguration.connection.channel.url = "ws://127.0.0.1:4502";
    expect(() => current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 2, configuration: document })).toThrow("immutable");
  });

  it("has an empty management snapshot without claiming an import or seeding defaults", () => {
    const { repository, scope, database, initialize } = fixture(false);
    expect(repository.get(scope)).toEqual({ revision: 0, configuration: { executionEnvironments: [], backends: [], targets: [], defaultTargetId: null, webSearch: null }, runtimes: [] });
    expect(repository.isInitialized(scope)).toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM execution_configuration_imports").get()).toEqual({ count: 0 });
    initialize();
    expect(repository.get(scope).configuration.backends[0]?.id).toBe("pi-primary");
  });

  it("imports ownership and definitions atomically and preserves existing profile IDs", () => {
    const current = fixture(false);
    const oldProfiles = current.database.prepare("SELECT id, template_id FROM agent_connection_profiles").all();
    expect(() => current.repository.initialize(current.scope, current.document, current.provenance, () => {
      current.projection.adoptLegacyOwnership(current.scope);
      throw new Error("injected_projection_failure");
    })).toThrow("injected_projection_failure");
    expect(current.database.prepare("SELECT owner_principal_id AS owner FROM agent_backend_instances").get()).toEqual({ owner: null });
    expect(current.repository.isInitialized(current.scope)).toBe(false);
    const imported = current.initialize();
    expect(imported.revision).toBe(0);
    expect(current.database.prepare("SELECT owner_principal_id AS owner FROM agent_backend_instances").get()).toEqual({ owner: current.scope.principalId });
    expect(current.database.prepare("SELECT id, template_id FROM agent_connection_profiles").all()).toEqual(oldProfiles);
  });

  it("projects a compiled release upgrade once without rewriting desired configuration or historical identities", () => {
    const current = fixture();
    const reader = new BackendConfigurationRepository(current.database);
    const historical = structuredClone(current.document);
    historical.backends.push({ ...historical.backends[0]!, id: "historical-pi", label: "Historical Pi" });
    historical.targets.push({ ...historical.targets[0]!, id: "historical-target", backendInstanceId: "historical-pi" });
    current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: historical }, document => current.projection.project(current.scope, document));
    current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 1, configuration: current.document }, document => current.projection.project(current.scope, document));
    const desired = current.repository.get(current.scope);
    const activeBefore = reader.getBackend(current.scope, "pi-primary");
    const profilesBefore = reader.listProfiles(current.scope);
    const removedBefore = reader.getBackend(current.scope, "historical-pi");
    expect(removedBefore.enabled).toBe(0);
    const upgraded = new ConfigurationProjection(current.database, { ...current.projection.protocolReleases, pi: "0.85.0" }, () => 2000);
    current.database.transaction(() => upgraded.project(current.scope, desired.configuration))();
    expect(reader.getBackend(current.scope, "pi-primary")).toMatchObject({ protocolRelease: "0.85.0", configurationRevision: activeBefore.configurationRevision + 1 });
    expect(reader.getBackend(current.scope, "historical-pi")).toEqual(removedBefore);
    expect(reader.listProfiles(current.scope)).toEqual(profilesBefore);
    expect(current.repository.get(current.scope)).toEqual(desired);
    const afterUpgrade = reader.getBackend(current.scope, "pi-primary");
    current.database.transaction(() => upgraded.project(current.scope, desired.configuration))();
    expect(reader.getBackend(current.scope, "pi-primary")).toEqual(afterUpgrade);
  });

  it("refuses ambiguous legacy owners without writing the import marker", () => {
    const current = fixture(false);
    current.database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES (?,?,'local_human',0)").run(current.scope.tenantId, randomUUID());
    expect(() => current.initialize()).toThrow("ambiguous");
    expect(current.repository.isInitialized(current.scope)).toBe(false);
  });

  it("retries the original import without replacing later edits", async () => {
    const current = fixture();
    const document = initialDocument();
    document.backends[0]!.label = "Edited in Settings";
    await current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: document });
    expect(current.initialize().configuration.backends[0]?.label).toBe("Edited in Settings");
    expect(() => current.repository.initialize(current.scope, document, { ...current.provenance, sourceFingerprint: configurationFingerprint(document) }, () => {})).toThrow("different source");
  });

  it("saves desired state independently of runtime application and supports receipt replay", async () => {
    const current = fixture();
    const document = initialDocument();
    document.executionEnvironments[0]!.label = "Local execution";
    const request = { mutationId: randomUUID(), expectedRevision: 0, configuration: document };
    const first = await current.service.save(current.scope, request);
    expect(first.revision).toBe(1);
    expect(first.runtimes.every(runtime => runtime.effectiveRevision === null && runtime.applyState === "pending")).toBe(true);
    expect(await current.service.save(current.scope, request)).toEqual(first);
    expect(current.repository.get(current.scope).revision).toBe(1);
    await expect(current.service.save(current.scope, { ...request, mutationId: randomUUID() })).rejects.toMatchObject({ code: "conflict" });
    await expect(current.service.save(current.scope, { ...request, configuration: initialDocument() })).rejects.toThrow("different contents");
  });

  it("keeps scopes separate in config, legacy backend reads, and profile writes", async () => {
    const current = fixture();
    const other = { tenantId: current.scope.tenantId, principalId: randomUUID() };
    current.database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES (?,?,'local_human',0)").run(other.tenantId, other.principalId);
    expect(current.repository.get(other).configuration.backends).toEqual([]);
    const projectionReader = new BackendConfigurationRepository(current.database);
    expect(projectionReader.listBackends(other)).toEqual([]);
    expect(() => projectionReader.getBackend(other, "pi-primary")).toThrow("not found");
    expect(() => current.database.prepare(`UPDATE agent_connection_profiles SET owner_principal_id = ? WHERE tenant_id = ?`).run(other.principalId, current.scope.tenantId)).toThrow("backend_principal_mismatch");
    await expect(current.service.save(other, { mutationId: randomUUID(), expectedRevision: 0, configuration: initialDocument() })).rejects.toThrow();
    expect(current.repository.isInitialized(other)).toBe(false);
  });

  it("keeps Pi backend ownership in one environment even after its definition is removed", async () => {
    const current = fixture();
    const replacement = initialDocument();
    replacement.executionEnvironments.push({ id: remoteId, kind: "ssh", label: "Other host", hostAlias: "other-host", workspaceRoots: ["/tmp"], operations: { kind: "none" } });
    replacement.backends[0]!.enabled = false;
    replacement.targets[0]!.enabled = false;
    replacement.defaultTargetId = null;
    const otherTarget = { ...replacement.targets[0]!, id: "other-pi-target", executionEnvironmentId: remoteId };
    expect(() => configurationDocumentSchema.parse({ ...replacement, targets: [...replacement.targets, otherTarget] }))
      .toThrow("A configured backend belongs to one execution environment.");

    // Removing a backend does not release its ID for a different environment:
    // environment Stop can therefore retire its entire module without touching
    // an actor belonging to a neighboring execution environment.
    await current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0,
      configuration: { ...initialDocument(), backends: [], targets: [], defaultTargetId: null } });
    replacement.targets = [otherTarget];
    await expect(current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 1, configuration: replacement }))
      .rejects.toThrow("backend execution identity is immutable");
    expect(current.repository.get(current.scope).revision).toBe(1);
  });

  it("rejects namespace retargeting even after the original definition is removed", async () => {
    const current = fixture();
    await current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: remoteDocument() });
    await current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 1, configuration: initialDocument() });
    const replacement = remoteDocument();
    const remote = replacement.executionEnvironments.find(environment => environment.kind === "ssh")!;
    if (remote.kind === "ssh") remote.hostAlias = "different-host";
    await expect(current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 2, configuration: replacement })).rejects.toThrow("immutable");
    expect(current.repository.get(current.scope).revision).toBe(2);
  });

  it("retains disabled historical profile/backend records on configuration removal", async () => {
    const current = fixture();
    const originalId = current.database.prepare("SELECT id FROM agent_connection_profiles").get();
    const empty = { ...initialDocument(), backends: [], targets: [], defaultTargetId: null };
    await current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: empty });
    expect(current.database.prepare("SELECT id FROM agent_connection_profiles").get()).toEqual(originalId);
    expect(current.database.prepare("SELECT enabled FROM agent_connection_profiles").get()).toEqual({ enabled: 0 });
    expect(current.database.prepare("SELECT enabled FROM agent_backend_instances").get()).toEqual({ enabled: 0 });
  });

  it("centralizes administration authorization for reads, writes, impact and actions", async () => {
    const current = fixture();
    const authorize = vi.fn(() => { throw new Error("administration_denied"); });
    const service = new ConfigurationAdminService(current.repository, { authorize, projection: current.projection });
    await expect(service.get(current.scope)).rejects.toThrow("administration_denied");
    await expect(service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: current.document })).rejects.toThrow("administration_denied");
    await expect(service.impact(current.scope, { resourceKind: "backend", resourceId: "pi-primary", action: "stop", expectedRevision: 0 })).rejects.toThrow("administration_denied");
    await expect(service.lifecycle(current.scope, { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "stop", expectedIncarnation: null, impactToken: null })).rejects.toThrow("administration_denied");
    expect(authorize.mock.calls).toHaveLength(4);
    expect(current.repository.get(current.scope).revision).toBe(0);
  });

  it("rejects stale or falsely applied runtime observations", () => {
    const current = fixture();
    const runtime = current.repository.runtime(current.scope, "backend", "pi-primary");
    expect(() => current.repository.observe(current.scope, { ...runtime, desiredRevision: 4 })).toThrow("stale");
    expect(() => current.repository.observe(current.scope, { ...runtime, applyState: "applied" })).toThrow("exact desired revision");
    expect(current.repository.observe(current.scope, { ...runtime, effectiveRevision: 0, applyState: "applied" }).applyState).toBe("applied");
  });
});

function lifecycleFixture() {
  const current = fixture();
  const runtime: ConfigurationRuntimeState = { ...current.repository.runtime(current.scope, "backend", "pi-primary"),
    incarnation: "provider-generation-one", effectiveRevision: 0, applyState: "applied", connectionState: "connected",
    supportedActions: ["disconnect", "connect", "stop", "restart"], activeResources: 1,
  };
  current.repository.observe(current.scope, runtime);
  const execute = vi.fn<ConfigurationRuntimeAdapter["execute"]>(async (_scope, input) => ({
    mutationId: input.request.mutationId, state: "applied", runtime: { ...input.runtime, effectiveRevision: input.runtime.desiredRevision,
      applyState: "applied", connectionState: input.request.action === "disconnect" ? "disconnected" : "stopped", activeResources: 0 },
  }));
  const adapter: ConfigurationRuntimeAdapter = {
    observe: async () => [], reconcile: async () => {},
    impact: async (_scope, _request, observed) => ({ runtime: observed, fence: "controller-active-work-fence", interruptions: ["One active turn will be interrupted."] }), execute,
  };
  const service = new ConfigurationAdminService(current.repository, { authorize: current.authorize, projection: current.projection, runtime: adapter, now: () => 1000 });
  return { ...current, runtime, adapter, execute, service };
}

describe("configuration lifecycle receipts", () => {
  it.each(["pending", "unknown"] as const)("restores a durable %s command in snapshots without persisting receipt projections", async state => {
    const current = lifecycleFixture();
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "restart", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    const admitted = current.repository.beginLifecycle(current.scope, request).result;
    if (state === "unknown") current.repository.completeLifecycle(current.scope, request, { ...admitted, state });
    const restarted = new ConfigurationRepository(current.database);
    const projected = restarted.get(current.scope).runtimes.find(item => item.resourceId === "pi-primary")!;
    expect(projected.lifecycleOperation).toEqual({ mutationId: request.mutationId, action: "restart", state });
    restarted.observe(current.scope, projected);
    expect(restarted.runtime(current.scope, "backend", "pi-primary").lifecycleOperation).toBeUndefined();
    restarted.completeLifecycle(current.scope, request, { ...admitted, state: "applied" });
    expect(restarted.get(current.scope).runtimes.find(item => item.resourceId === "pi-primary")!.lifecycleOperation).toBeUndefined();
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("returns pending while a slow lifecycle continues and refreshes its final result without replay", async () => {
    const current = lifecycleFixture();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    current.execute.mockImplementation(async (_scope, input) => {
      await gate;
      return { mutationId: input.request.mutationId, state: "applied", runtime: { ...input.runtime, applyState: "applied", effectiveRevision: input.runtime.desiredRevision } };
    });
    const recover = vi.fn<NonNullable<ConfigurationRuntimeAdapter["recoverLifecycle"]>>(async () => undefined);
    current.adapter.recoverLifecycle = recover;
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "stop", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    const impact = await current.service.impact(current.scope, { resourceKind: "backend", resourceId: "pi-primary", action: "stop", expectedRevision: 0 });
    request.impactToken = impact.token;
    vi.useFakeTimers();
    let result: Awaited<ReturnType<ConfigurationAdminService["lifecycle"]>> | undefined;
    try {
      const response = current.service.lifecycle(current.scope, request).then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(result?.state).toBe("pending");
      expect((await current.service.lifecycleReceipt(current.scope, request.mutationId)).state).toBe("pending");
      expect(recover).not.toHaveBeenCalled();
      expect((await current.service.lifecycle(current.scope, request)).state).toBe("pending");
      await expect(current.service.lifecycle(current.scope, { ...request, mutationId: randomUUID(), expectedRevision: 1 })).rejects.toThrow("still running");
      finish();
      await vi.advanceTimersByTimeAsync(0);
      await response;
      expect((await current.service.lifecycleReceipt(current.scope, request.mutationId)).state).toBe("applied");
      expect(current.execute).toHaveBeenCalledTimes(1);
    } finally { finish(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); }
  });

  it.each([false, true])("marks an orphaned pending receipt unknown after server restart even without recovery (%s)", async recoveryAvailable => {
    const current = lifecycleFixture();
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "restart", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    const admitted = current.repository.beginLifecycle(current.scope, request).result;
    const restartedRepository = new ConfigurationRepository(current.database);
    const recover = vi.fn<NonNullable<ConfigurationRuntimeAdapter["recoverLifecycle"]>>(async () => undefined);
    const report = vi.fn();
    const restarted = new ConfigurationAdminService(restartedRepository, {
      authorize: current.authorize, projection: current.projection, onLifecycleError: report,
      ...(recoveryAvailable ? { runtime: { ...current.adapter, recoverLifecycle: recover } } : {}),
    });
    const result = await restarted.lifecycleReceipt(current.scope, request.mutationId);
    expect(result).toEqual({ ...admitted, state: "unknown", runtime: {
      ...admitted.runtime, applyState: "unavailable", lastError: expect.stringContaining("server no longer owns"),
    } });
    expect(restartedRepository.pendingLifecycle(current.scope)).toEqual([{ request, result }]);
    expect(restartedRepository.get(current.scope).runtimes.find(item => item.resourceId === request.resourceId)?.lifecycleOperation)
      .toEqual({ mutationId: request.mutationId, action: "restart", state: "unknown" });
    expect(recover).toHaveBeenCalledTimes(recoveryAvailable ? 1 : 0);
    if (recoveryAvailable) expect(recover).toHaveBeenCalledWith(current.scope, { request, result });
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining("remote outcome is unconfirmed") }), {
      mutationId: request.mutationId, resourceKind: "backend", resourceId: "pi-primary", action: "restart",
    });
    expect(await restarted.lifecycleReceipt(current.scope, request.mutationId)).toEqual(result);
    expect(report).toHaveBeenCalledTimes(1);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("keeps a newer Stop preference when marking an older orphaned request unknown", async () => {
    const current = lifecycleFixture();
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "restart", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    const original = current.repository.beginLifecycle(current.scope, request).result;
    const stop = { ...request, mutationId: randomUUID(), expectedRevision: 1, action: "stop" as const };
    const newer = current.repository.beginLifecycle(current.scope, stop).result;
    const restarted = new ConfigurationAdminService(new ConfigurationRepository(current.database), {
      authorize: current.authorize, projection: current.projection,
    });
    const result = await restarted.lifecycleReceipt(current.scope, request.mutationId);
    expect(result.runtime.desiredRevision).toBe(original.runtime.desiredRevision);
    expect(result.runtime.preference).toBe("automatic");
    expect(current.repository.runtime(current.scope, "backend", "pi-primary")).toEqual(newer.runtime);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("requires scope/revision/incarnation-bound impact before disruptive execution", async () => {
    const current = lifecycleFixture();
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "stop", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    await expect(current.service.lifecycle(current.scope, request)).rejects.toThrow("confirmation");
    expect(current.execute).not.toHaveBeenCalled();
    const impact = await current.service.impact(current.scope, { resourceKind: "backend", resourceId: "pi-primary", action: "stop", expectedRevision: 0 });
    request.impactToken = impact.token;
    const result = await current.service.lifecycle(current.scope, request);
    expect(result.state).toBe("applied");
    expect(result.runtime.preference).toBe("stopped");
    expect(current.execute.mock.calls[0]?.[1].expectedFence).toBe("controller-active-work-fence");
    expect(await current.service.lifecycle(current.scope, request)).toEqual(result);
    expect(current.execute).toHaveBeenCalledTimes(1);
  });

  it("persists disconnect preference and never retries an uncertain side effect", async () => {
    const current = lifecycleFixture();
    current.execute.mockRejectedValueOnce(new Error("ssh lost after delivery"));
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "disconnect", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    const result = await current.service.lifecycle(current.scope, request);
    expect(result.state).toBe("unknown");
    expect(result.runtime.preference).toBe("disconnected");
    const restarted = new ConfigurationAdminService(new ConfigurationRepository(current.database), { authorize: current.authorize, projection: current.projection, runtime: current.adapter });
    expect(await restarted.lifecycle(current.scope, request)).toEqual(result);
    expect(current.execute).toHaveBeenCalledTimes(1);
    expect(current.repository.pendingLifecycle(current.scope)).toEqual([{ request, result }]);
    expect(await restarted.lifecycleReceipt(current.scope, request.mutationId)).toEqual(result);
  });

  it.each([false, true])("reports underlying lifecycle failure and retains uncertainty even if reporting throws (%s)", async reportingThrows => {
    const current = lifecycleFixture();
    const cause = new Error("remote attachment closed");
    const error = new Error("shutdown response lost", { cause });
    const report = vi.fn(() => { if (reportingThrows) throw new Error("log unavailable"); });
    const service = new ConfigurationAdminService(current.repository, {
      authorize: current.authorize, projection: current.projection, runtime: current.adapter, onLifecycleError: report,
    });
    current.execute.mockRejectedValueOnce(error);
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "disconnect", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    const result = await service.lifecycle(current.scope, request);
    expect(report).toHaveBeenCalledWith(error, { mutationId: request.mutationId, resourceKind: "backend", resourceId: "pi-primary", action: "disconnect" });
    expect(result.state).toBe("unknown");
    expect(current.repository.lifecycleReceipt(current.scope, request.mutationId)).toEqual(result);
  });

  it("recovers a reserved request after a crash before delivery and fences late results", async () => {
    const current = lifecycleFixture();
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "disconnect", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    const reserved = current.repository.beginLifecycle(current.scope, request);
    const restartedRepository = new ConfigurationRepository(current.database);
    expect(restartedRepository.pendingLifecycle(current.scope)).toEqual([{ request, result: reserved.result }]);
    expect(current.execute).not.toHaveBeenCalled();
    const changed = initialDocument(); changed.backends[0]!.label = "New desired revision";
    await current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 1, configuration: changed });
    const settled = restartedRepository.completeLifecycle(current.scope, request, { ...reserved.result, state: "applied", runtime: {
      ...reserved.result.runtime, applyState: "applied", effectiveRevision: 1, connectionState: "disconnected",
    } });
    expect(settled.state).toBe("applied");
    expect(restartedRepository.runtime(current.scope, "backend", "pi-primary").desiredRevision).toBe(2);
    expect(restartedRepository.pendingLifecycle(current.scope)).toEqual([]);
  });

  it.each(["pending", "unknown"] as const)("recovers a durable %s receipt only on explicit lookup without replaying execution", async state => {
    const current = lifecycleFixture();
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "disconnect", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    const reserved = current.repository.beginLifecycle(current.scope, request).result;
    const uncertain = state === "unknown" ? current.repository.completeLifecycle(current.scope, request, { ...reserved, state: "unknown", runtime: { ...reserved.runtime, applyState: "pending" } }) : reserved;
    const proof: typeof reserved = { ...reserved, state: "applied", runtime: { ...reserved.runtime, applyState: "applied", effectiveRevision: reserved.runtime.desiredRevision, connectionState: "disconnected", activeResources: 0 } };
    const recover = vi.fn<NonNullable<ConfigurationRuntimeAdapter["recoverLifecycle"]>>(async () => proof);
    current.adapter.recoverLifecycle = recover;
    await current.service.get(current.scope);
    expect(recover).not.toHaveBeenCalled();
    expect(await current.service.lifecycle(current.scope, request)).toEqual(uncertain);
    expect(recover).not.toHaveBeenCalled();
    expect(await current.service.lifecycleReceipt(current.scope, request.mutationId)).toEqual(proof);
    expect(recover).toHaveBeenCalledExactlyOnceWith(current.scope, { request, result: state === "unknown" ? uncertain : {
      ...uncertain, state: "unknown", runtime: { ...uncertain.runtime, applyState: "unavailable", lastError: expect.stringContaining("server no longer owns") },
    } });
    expect(new ConfigurationRepository(current.database).lifecycleReceipt(current.scope, request.mutationId)).toEqual(proof);
    expect(current.repository.pendingLifecycle(current.scope)).toEqual([]);
    expect(await current.service.lifecycleReceipt(current.scope, request.mutationId)).toEqual(proof);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("retains uncertainty without proof and denies recovery before reading another scope's receipt", async () => {
    const current = lifecycleFixture();
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "disconnect", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    const reserved = current.repository.beginLifecycle(current.scope, request).result;
    const recover = vi.fn<NonNullable<ConfigurationRuntimeAdapter["recoverLifecycle"]>>(async () => undefined);
    current.adapter.recoverLifecycle = recover;
    const unknown = await current.service.lifecycleReceipt(current.scope, request.mutationId);
    expect(unknown).toEqual({ ...reserved, state: "unknown", runtime: {
      ...reserved.runtime, applyState: "unavailable", lastError: expect.stringContaining("remote outcome is unconfirmed"),
    } });
    expect(current.repository.pendingLifecycle(current.scope)).toEqual([{ request, result: unknown }]);
    const other = { ...current.scope, principalId: randomUUID() };
    current.database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES (?,?,'local_human',0)").run(other.tenantId, other.principalId);
    await expect(current.service.lifecycleReceipt(other, request.mutationId)).rejects.toMatchObject({ code: "not_found" });
    expect(current.authorize).toHaveBeenLastCalledWith(other, "read");
    expect(recover).toHaveBeenCalledTimes(1);
    current.authorize.mockImplementation(() => { throw new Error("administration_denied"); });
    await expect(current.service.lifecycleReceipt(current.scope, request.mutationId)).rejects.toThrow("administration_denied");
    expect(recover).toHaveBeenCalledTimes(1);
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("settles recovered old receipts without overwriting newer desired configuration", async () => {
    const current = lifecycleFixture();
    const request: ConfigurationLifecycleRequest = { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "disconnect", expectedIncarnation: current.runtime.incarnation, impactToken: null };
    const reserved = current.repository.beginLifecycle(current.scope, request).result;
    const changed = initialDocument(); changed.backends[0]!.label = "Updated while receipt was uncertain";
    await current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 1, configuration: changed });
    const snapshot = current.repository.get(current.scope);
    const proof: typeof reserved = { ...reserved, state: "applied", runtime: { ...reserved.runtime, applyState: "applied", effectiveRevision: 1, connectionState: "disconnected", activeResources: 0 } };
    current.adapter.recoverLifecycle = async () => proof;
    expect(await current.service.lifecycleReceipt(current.scope, request.mutationId)).toEqual(proof);
    expect(current.repository.get(current.scope)).toEqual({ ...snapshot,
      runtimes: snapshot.runtimes.map(({ lifecycleOperation: _settled, ...runtime }) => runtime),
    });
    expect(current.execute).not.toHaveBeenCalled();
  });

  it("does not accept confirmation after desired config changes", async () => {
    const current = lifecycleFixture();
    const impact = await current.service.impact(current.scope, { resourceKind: "backend", resourceId: "pi-primary", action: "restart", expectedRevision: 0 });
    const next = initialDocument(); next.backends[0]!.label = "Updated";
    await current.service.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: next });
    await expect(current.service.lifecycle(current.scope, { mutationId: randomUUID(), expectedRevision: 0, resourceKind: "backend", resourceId: "pi-primary", action: "restart", expectedIncarnation: current.runtime.incarnation, impactToken: impact.token })).rejects.toThrow("changed");
    expect(current.execute).not.toHaveBeenCalled();
  });
});

describe("configuration validation", () => {
  it("accepts zero backends but rejects unknown config and incompatible remote topologies", () => {
    expect(validateConfigurationDocument({ executionEnvironments: [], backends: [], targets: [], defaultTargetId: null, webSearch: null }).backends).toEqual([]);
    expect(() => validateConfigurationDocument({ ...initialDocument(), arbitraryAuthority: true })).toThrow();
    const invalid = remoteDocument();
    invalid.targets[0]!.executionEnvironmentId = remoteId;
    const environment = invalid.executionEnvironments.find(item => item.kind === "ssh")!;
    if (environment.kind === "ssh") environment.operations = { kind: "none" };
    expect(() => validateConfigurationDocument(invalid)).toThrow();
  });

  it.each([environmentId, remoteId])("preserves an omitted Claude configuration directory for environment %s", (executionEnvironmentId) => {
    const document = remoteDocument();
    document.backends.push({ id: "native-claude", kind: "claude_agent_sdk", label: "Claude", enabled: true, modelPolicy: { type: "catalog" },
      moduleConfiguration: { initializationTimeoutMs: 20_000, permissionPolicy: { allowedModes: ["default"] } } });
    document.targets.push({ id: "native-claude-target", kind: "claude_agent_sdk", label: "Claude", enabled: true,
      backendInstanceId: "native-claude", executionEnvironmentId, moduleConfiguration: { defaults: { permissionMode: "default" } } });
    const saved = validateConfigurationDocument(document).backends.at(-1)!;
    expect(saved).toMatchObject({ kind: "claude_agent_sdk" });
    if (saved.kind !== "claude_agent_sdk") throw new Error("Unexpected backend");
    expect(saved.moduleConfiguration).not.toHaveProperty("configDirectory");
    const current = fixture();
    const committed = current.repository.save(current.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: document });
    expect(committed.configuration.backends.find(backend => backend.id === "native-claude")).toEqual(saved);
    const backend = document.backends.at(-1)!;
    if (backend.kind === "claude_agent_sdk") backend.moduleConfiguration.configDirectory = "";
    expect(() => validateConfigurationDocument(document)).toThrow("An absolute execution-environment path is required.");
  });

  it.each([environmentId, remoteId])("requires explicit homes for multiple enabled Claude backends in %s", executionEnvironmentId => {
    const document = remoteDocument();
    for (const id of ["claude-default", "claude-custom"]) {
      document.backends.push({ id, kind: "claude_agent_sdk", label: id, enabled: true, modelPolicy: { type: "catalog" },
        moduleConfiguration: { ...(id === "claude-custom" ? { configDirectory: "/custom/.claude" } : {}),
          initializationTimeoutMs: 20_000, permissionPolicy: { allowedModes: ["default"] } } });
      document.targets.push({ id: `${id}-target`, kind: "claude_agent_sdk", label: id, enabled: true,
        backendInstanceId: id, executionEnvironmentId, moduleConfiguration: { defaults: { permissionMode: "default" } } });
    }
    expect(() => validateConfigurationDocument(document)).toThrow("Set explicit configuration directories");
    const defaultBackend = document.backends.find(backend => backend.id === "claude-default")!;
    if (defaultBackend.kind !== "claude_agent_sdk") throw new Error("Unexpected backend");
    defaultBackend.moduleConfiguration.configDirectory = "/account/.claude";
    expect(() => validateConfigurationDocument(document)).not.toThrow();
    delete defaultBackend.moduleConfiguration.configDirectory;
    defaultBackend.enabled = false;
    document.targets.find(target => target.backendInstanceId === defaultBackend.id)!.enabled = false;
    expect(() => validateConfigurationDocument(document)).not.toThrow();
    defaultBackend.enabled = true;
    const defaultTarget = document.targets.find(target => target.backendInstanceId === defaultBackend.id)!;
    defaultTarget.enabled = true;
    defaultTarget.executionEnvironmentId = executionEnvironmentId === environmentId ? remoteId : environmentId;
    expect(() => validateConfigurationDocument(document)).not.toThrow();
  });

  it("admits enabled remote Claude independently of optional operations and validates disabled defaults", () => {
    const document = remoteDocument();
    document.backends.push({ id: "remote-claude", kind: "claude_agent_sdk", label: "Retained Claude", enabled: false, modelPolicy: { type: "catalog" },
      moduleConfiguration: { configDirectory: "/home/remote/.claude", initializationTimeoutMs: 20_000, permissionPolicy: { allowedModes: ["default"] } } });
    document.targets.push({ id: "remote-claude-target", kind: "claude_agent_sdk", label: "Retained remote target", enabled: false,
      backendInstanceId: "remote-claude", executionEnvironmentId: remoteId, moduleConfiguration: { defaults: { permissionMode: "default" } } });
    expect(validateConfigurationDocument(document).targets.at(-1)?.enabled).toBe(false);
    document.backends.at(-1)!.enabled = true;
    document.targets.at(-1)!.enabled = true;
    const environment = document.executionEnvironments.find(item => item.id === remoteId)!;
    if (environment.kind === "ssh") environment.operations = { kind: "none" };
    expect(validateConfigurationDocument(document).targets.at(-1)?.enabled).toBe(true);
    document.backends.at(-1)!.enabled = false;
    const target = document.targets.at(-1)!;
    target.enabled = false;
    if (target.kind === "claude_agent_sdk") target.moduleConfiguration.defaults.permissionMode = "acceptEdits";
    expect(() => validateConfigurationDocument(document)).toThrow("configuration or target defaults are invalid");
  });

  it("validates Codex endpoints and requires admitted credential references before commit", async () => {
    const current = fixture();
    const document = initialDocument();
    document.backends.push({ id: "network-codex", kind: "codex_app_server", label: "Codex", enabled: true, modelPolicy: { type: "catalog" }, moduleConfiguration: {
      connection: { ownership: "external", channel: { type: "tcp_websocket", url: "ws://127.0.0.1:4501", authentication: { type: "capability_token", secret: { source: "protected_file", path: "/protected/codex-token" } } } },
      policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["on-request"], allowedApprovalReviewers: ["user"] },
    } });
    document.targets.push({ id: "network-codex-target", kind: "codex_app_server", label: "Codex target", enabled: true, backendInstanceId: "network-codex", executionEnvironmentId: environmentId,
      moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "on-request", approvalReviewer: "user", model: { type: "catalogDefault" } } } });
    const request = { mutationId: randomUUID(), expectedRevision: 0, configuration: document };
    await expect(current.service.save(current.scope, request)).rejects.toThrow("has not been approved");
    expect(current.repository.get(current.scope).revision).toBe(0);
    const authorizeReference = vi.fn(() => {});
    const service = new ConfigurationAdminService(current.repository, { authorize: current.authorize, projection: current.projection, authorizeSecretReference: authorizeReference });
    expect((await service.save(current.scope, request)).revision).toBe(1);
    expect(authorizeReference).toHaveBeenCalledWith(current.scope, environmentId, { source: "protected_file", path: "/protected/codex-token" });
    const providerOnly = structuredClone(document);
    providerOnly.executionEnvironments.push({ id: remoteId, kind: "ssh", label: "Provider only", hostAlias: "provider-only", workspaceRoots: ["/work"], operations: { kind: "none" } });
    providerOnly.targets.at(-1)!.executionEnvironmentId = remoteId;
    expect(validateConfigurationDocument(providerOnly).targets.at(-1)?.executionEnvironmentId).toBe(remoteId);
    const invalid = structuredClone(document);
    const backend = invalid.backends.at(-1)!;
    if (backend.kind === "codex_app_server" && backend.moduleConfiguration.connection.ownership === "external" && backend.moduleConfiguration.connection.channel.type === "tcp_websocket") backend.moduleConfiguration.connection.channel.url = "ws://remote.example:4501";
    expect(() => validateConfigurationDocument(invalid)).toThrow("configuration or target defaults are invalid");
  });
});
