import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configurationDocumentSchema, type ConfigurationDocument, type ConfigurationEnvironment } from "../../src/shared/protocol/configuration-admin.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { initializeDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";

const latestBackendNormalizedVersion = backendNormalizedMigrations.at(-1)!.version;
const localEnvironmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const sshEnvironmentId = "019196f7-a0a8-7bc4-a89b-8cf013978406";
type SshEnvironment = Extract<ConfigurationEnvironment, { kind: "ssh" }>;

function localCutoverConfiguration() {
  return parseResolvedBackendConfiguration({
    schemaVersion: 10,
    executionEnvironments: [
      { id: localEnvironmentId, kind: "local", label: "Local" },
    ],
    backends: [
      {
        id: "pi-primary",
        kind: "pi",
        label: "Primary Pi",
        enabled: true,
        modelPolicy: { type: "catalog" },
      },
    ],
    targets: [
      {
        id: "local-primary",
        kind: "pi_sdk",
        label: "Primary Local SDK",
        backendInstanceId: "pi-primary",
        executionEnvironmentId: localEnvironmentId,
        enabled: true,
      },
    ],
    defaultTargetId: "local-primary",
  });
}

function localDocument(workspaceRoots = ["/workspace/a"]): ConfigurationDocument {
  const legacy = localCutoverConfiguration();
  return configurationDocumentSchema.parse({
    executionEnvironments: [{ id: localEnvironmentId, kind: "local", label: "Local", workspaceRoots,
      workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }],
    backends: legacy.backends.map(({ protocolRelease: _release, ...backend }) => backend),
    targets: legacy.targets, defaultTargetId: legacy.defaultTargetId, webSearch: null,
  });
}

function remoteDocument(overrides: Partial<Omit<SshEnvironment, "id" | "kind">> = {}): ConfigurationDocument {
  return configurationDocumentSchema.parse({
    executionEnvironments: [...localDocument().executionEnvironments, {
      id: sshEnvironmentId, kind: "ssh", label: "srv", hostAlias: "srv",
      workspaceRoots: ["/home/operator/projects"], operations: { kind: "none" }, ...overrides,
    }],
    backends: [{ id: "remote-codex", kind: "codex_app_server", label: "Remote Codex", enabled: true,
      modelPolicy: { type: "catalog" }, moduleConfiguration: {
        connection: { ownership: "external", channel: { type: "unix_websocket", socketPath: "/home/operator/.codex/app-server-control/app-server.sock" } },
        policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["never"], allowedApprovalReviewers: ["user"] },
      } }],
    targets: [{ id: "remote-codex", kind: "codex_app_server", label: "Remote Codex", backendInstanceId: "remote-codex", executionEnvironmentId: sshEnvironmentId, enabled: true,
      moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user", model: { type: "catalogDefault" } } } }],
    defaultTargetId: "remote-codex", webSearch: null,
  });
}

function migratedFixture(initialize = true) {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  applyBackendNormalizationMigration(database, { configuration: localCutoverConfiguration(), quiescentCutoverConfirmed: true, appliedAt: 100 });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const administration = initialize ? initializeDatabaseConfigurationFixture(database, localDocument(), { sourceLabel: "ssh-persistence", now: 100 }) : null;
  const save = (configuration: ConfigurationDocument) => {
    if (!administration) throw new Error("fixture_not_initialized");
    return administration.repository.save(scope, {
      mutationId: randomUUID(), expectedRevision: administration.repository.get(scope).revision, configuration,
    }, document => administration.projection.project(scope, document));
  };
  return { database, scope, save, administration, inventory: new InventoryRepository(database) };
}

describe("SSH execution environment persistence", () => {
  it("migrates the seeded local environment without breaking its foreign keys", () => {
    const fixture = migratedFixture(false);
    try {
      expect(fixture.database.pragma("foreign_key_check")).toEqual([]);
      const local = fixture.inventory.getLocalEnvironment(fixture.scope);
      expect(local).toMatchObject({ id: localEnvironmentId, kind: "local", configurationRevision: 0 });
      expect(fixture.inventory.listEnvironments(fixture.scope)).toEqual([local]);
      expect(local.configurationFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.database.prepare("SELECT max(version) AS version FROM schema_migrations").get()).toEqual({ version: latestBackendNormalizedVersion });
    } finally { fixture.database.close(); }
  });

  it("advances local authority once when saved workspace roots change", () => {
    const fixture = migratedFixture();
    try {
      const first = fixture.inventory.getLocalEnvironment(fixture.scope);
      fixture.save(localDocument(["/workspace/b"]));
      const changed = fixture.inventory.getLocalEnvironment(fixture.scope);
      expect(changed.configurationFingerprint).not.toBe(first.configurationFingerprint);
      expect(changed).toMatchObject({ configurationRevision: first.configurationRevision + 1, revision: first.revision + 1,
        availability: "unavailable", diagnosticCode: "configuration_apply_pending" });
      fixture.save(localDocument(["/workspace/b"]));
      expect(fixture.inventory.getLocalEnvironment(fixture.scope)).toEqual(changed);
    } finally { fixture.database.close(); }
  });

  it("projects scoped SSH authority without publishing private connection details", () => {
    const fixture = migratedFixture();
    try {
      fixture.save(remoteDocument());
      const first = fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId);
      expect(first).toMatchObject({ kind: "ssh", label: "srv", availability: "unavailable", diagnosticCode: "configuration_apply_pending",
        revision: 0, configurationRevision: 0, operationsConfigurationRevision: 0 });
      expect(first.configurationFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(first.operationsConfigurationFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.inventory.listEnvironments(fixture.scope)).toHaveLength(2);
      fixture.save(remoteDocument({ label: "Server" }));
      const relabeled = fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId);
      expect(relabeled).toMatchObject({ label: "Server", revision: 1, configurationRevision: 0, operationsConfigurationRevision: 0,
        configurationFingerprint: first.configurationFingerprint });
      // Explicit simulated successful observation before the next desired edit.
      fixture.inventory.updateEnvironmentAvailability(fixture.scope, sshEnvironmentId, { available: true, now: 350 });
      fixture.save(remoteDocument({ label: "Server", workspaceRoots: ["/workspace/remote"] }));
      const reconfigured = fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId);
      expect(reconfigured).toMatchObject({ availability: "unavailable", diagnosticCode: "configuration_apply_pending", revision: 3,
        configurationRevision: 1, operationsConfigurationRevision: 0, operationsConfigurationFingerprint: relabeled.operationsConfigurationFingerprint });
      expect(reconfigured.configurationFingerprint).not.toBe(relabeled.configurationFingerprint);
      for (const privateField of ["hostAlias", "workspaceRoots", "operations"]) expect(reconfigured).not.toHaveProperty(privateField);
      const saved = fixture.administration!.repository.get(fixture.scope);
      expect(() => fixture.save(remoteDocument({ hostAlias: "srv-backup" }))).toThrow(/immutable/);
      expect(fixture.administration!.repository.get(fixture.scope)).toEqual(saved);
      expect(fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId)).toEqual(reconfigured);
    } finally { fixture.database.close(); }
  });

  it("advances operations authority and requires apply when sidecar grants change", () => {
    const fixture = migratedFixture();
    try {
      fixture.save(remoteDocument());
      fixture.inventory.updateEnvironmentAvailability(fixture.scope, sshEnvironmentId, { available: true, now: 250 });
      const before = fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId);
      const workspace = fixture.inventory.upsertWorkspace(fixture.scope, {
        environmentId: sshEnvironmentId, canonicalPath: "/home/operator/projects/sedes", displayName: "Sedes", available: true,
        trustState: "untrusted", environmentConfigurationRevision: before.configurationRevision, now: 275,
      });
      const operations: SshEnvironment["operations"] = { kind: "sidecar", enabledCapabilities: ["agent_tools_cli"] };
      fixture.save(remoteDocument({ operations }));
      const after = fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId);
      expect(after).toMatchObject({ availability: "unavailable", diagnosticCode: "configuration_apply_pending", revision: before.revision + 1,
        configurationRevision: before.configurationRevision, configurationFingerprint: before.configurationFingerprint,
        operationsConfigurationRevision: before.operationsConfigurationRevision + 1 });
      expect(after.operationsConfigurationFingerprint).not.toBe(before.operationsConfigurationFingerprint);
      expect(fixture.inventory.getWorkspace(fixture.scope, workspace.id)).toMatchObject({ environmentConfigurationRevision: before.configurationRevision, revision: workspace.revision });
      fixture.save(remoteDocument({ operations }));
      expect(fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId)).toEqual(after);
      fixture.save(remoteDocument({ operations: { kind: "sidecar", enabledCapabilities: ["workspace_files", "workspace_tools", "workspace_context", "composer_attachments", "agent_tools_cli"] } }));
      const allEnabled = fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId);
      expect(allEnabled).toMatchObject({ availability: "unavailable", diagnosticCode: "configuration_apply_pending", revision: after.revision + 1,
        configurationRevision: after.configurationRevision, configurationFingerprint: after.configurationFingerprint,
        operationsConfigurationRevision: after.operationsConfigurationRevision + 1 });
      expect(allEnabled.operationsConfigurationFingerprint).not.toBe(after.operationsConfigurationFingerprint);
      expect(fixture.inventory.getWorkspace(fixture.scope, workspace.id)).toMatchObject({ environmentConfigurationRevision: before.configurationRevision, revision: workspace.revision });
    } finally { fixture.database.close(); }
  });

  it.each([true, false])("hides removed empty environments that were available=%s without deleting their identities", (available) => {
    const fixture = migratedFixture();
    try {
      fixture.save(remoteDocument());
      fixture.inventory.updateEnvironmentAvailability(fixture.scope, sshEnvironmentId, {
        available, diagnosticCode: "outbound_environment_offline", now: 200,
      });
      const before = fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId);
      expect(fixture.inventory.listEnvironments(fixture.scope).map(({ id }) => id)).toContain(sshEnvironmentId);

      fixture.save(localDocument());
      const removed = fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId);
      expect(removed).toMatchObject({ availability: "unavailable", diagnosticCode: "configuration_removed",
        revision: before.revision + 1, configurationRevision: before.configurationRevision });
      expect(fixture.inventory.listEnvironments(fixture.scope).map(({ id }) => id)).toEqual([localEnvironmentId]);
      fixture.save(localDocument());
      expect(fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId)).toEqual(removed);

      // A stale offline observation, including one persisted before this fix,
      // cannot put a removed identity back into the application inventory.
      fixture.inventory.updateEnvironmentAvailability(fixture.scope, sshEnvironmentId, {
        available: false, diagnosticCode: "outbound_environment_offline", now: 300,
      });
      expect(new InventoryRepository(fixture.database).listEnvironments(fixture.scope).map(({ id }) => id)).toEqual([localEnvironmentId]);
      fixture.save(localDocument());
      expect(fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId).diagnosticCode).toBe("configuration_removed");

      fixture.save(remoteDocument());
      expect(fixture.inventory.listEnvironments(fixture.scope)).toContainEqual(expect.objectContaining({
        id: sshEnvironmentId, label: "srv", availability: "unavailable", diagnosticCode: "configuration_apply_pending",
        configurationRevision: before.configurationRevision,
      }));
      expect(fixture.database.pragma("foreign_key_check")).toEqual([]);
    } finally { fixture.database.close(); }
  });

  it.each([true, false])("retains environments and thread bindings for available=%s workspaces when definitions are removed", (available) => {
    const fixture = migratedFixture();
    try {
      fixture.save(remoteDocument());
      fixture.inventory.updateEnvironmentAvailability(fixture.scope, sshEnvironmentId, { available: true, now: 200 });
      const workspace = fixture.inventory.upsertWorkspace(fixture.scope, {
        environmentId: sshEnvironmentId, canonicalPath: "/home/operator/projects/sedes", displayName: "Sedes", available,
        trustState: "trusted", environmentConfigurationRevision: 0, now: 210,
      });
      const reader = new BackendConfigurationRepository(fixture.database);
      const profile = reader.getProfileByTemplate(fixture.scope, "remote-codex");
      const thread = new ConversationBindingRepository(fixture.database).createUnboundThread(fixture.scope, {
        workspaceId: workspace.id, connectionProfileId: profile.id, title: "Retained conversation", now: 215,
      });
      fixture.save(localDocument());
      expect(fixture.inventory.getEnvironment(fixture.scope, sshEnvironmentId)).toMatchObject({ availability: "unavailable", diagnosticCode: "configuration_removed" });
      expect(fixture.inventory.listEnvironments(fixture.scope)).toContainEqual(expect.objectContaining({
        id: sshEnvironmentId, label: "srv", availability: "unavailable", diagnosticCode: "configuration_removed",
      }));
      expect(fixture.inventory.getWorkspace(fixture.scope, workspace.id).environmentId).toBe(sshEnvironmentId);
      expect(fixture.inventory.listWorkspaces(fixture.scope)).toEqual([workspace]);
      expect(fixture.inventory.getThread(fixture.scope, thread.id).thread).toMatchObject({
        id: thread.id, workspaceId: workspace.id, environmentId: sshEnvironmentId, title: "Retained conversation",
      });
      expect(reader.getProfileByTemplate(fixture.scope, "remote-codex")).toMatchObject({ id: profile.id, executionEnvironmentId: sshEnvironmentId, enabled: 0 });
      expect(fixture.database.pragma("foreign_key_check")).toEqual([]);
      expect(() => fixture.save(remoteDocument({ hostAlias: "replacement-host" }))).toThrow(/immutable/);
    } finally { fixture.database.close(); }
  });

  it("keeps desired membership, retained workspace references, and removal projection within their owner scope", () => {
    const fixture = migratedFixture();
    try {
      fixture.save(remoteDocument());
      const other = { tenantId: randomUUID(), principalId: fixture.scope.principalId };
      fixture.database.prepare("INSERT INTO tenants(id, created_at) VALUES (?, 0)").run(other.tenantId);
      fixture.database.prepare("INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 0)")
        .run(other.tenantId, other.principalId);
      fixture.database.prepare("INSERT INTO principal_generations(tenant_id, principal_id) VALUES (?, ?)")
        .run(other.tenantId, other.principalId);
      fixture.administration!.repository.save(other, {
        mutationId: randomUUID(), expectedRevision: 0, configuration: remoteDocument({ label: "Other tenant server" }),
      }, document => fixture.administration!.projection.project(other, document));
      const otherEnvironment = fixture.inventory.getEnvironment(other, sshEnvironmentId);
      fixture.inventory.upsertWorkspace(other, {
        environmentId: sshEnvironmentId, canonicalPath: "/home/operator/projects/sedes", displayName: "Other tenant workspace", available: false,
        trustState: "trusted", environmentConfigurationRevision: 0, now: 200,
      });
      fixture.save(localDocument());
      expect(fixture.inventory.listEnvironments(fixture.scope).map(({ id }) => id)).toEqual([localEnvironmentId]);
      expect(fixture.inventory.listWorkspaces(fixture.scope)).toEqual([]);
      expect(fixture.inventory.getEnvironment(other, sshEnvironmentId)).toEqual(otherEnvironment);
      expect(fixture.inventory.listEnvironments(other)).toContainEqual(otherEnvironment);

      const otherPrincipal = { ...fixture.scope, principalId: randomUUID() };
      fixture.database.prepare("INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 0)")
        .run(otherPrincipal.tenantId, otherPrincipal.principalId);
      expect(fixture.inventory.listEnvironments(otherPrincipal)).toEqual([]);
      expect(() => fixture.inventory.getEnvironment(otherPrincipal, localEnvironmentId)).toThrow("not found");
      expect(fixture.database.pragma("foreign_key_check")).toEqual([]);
    } finally { fixture.database.close(); }
  });

  it("preserves a connection template's immutable environment binding", () => {
    const fixture = migratedFixture();
    try {
      const remote = remoteDocument();
      fixture.save(remote);
      const snapshot = fixture.administration!.repository.get(fixture.scope);
      const retargeted = structuredClone(remote);
      retargeted.targets[0]!.executionEnvironmentId = localEnvironmentId;
      expect(() => fixture.save(retargeted)).toThrow(/immutable/);
      expect(fixture.administration!.repository.get(fixture.scope)).toEqual(snapshot);
    } finally { fixture.database.close(); }
  });
});
