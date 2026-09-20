import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { HostPairingRepository } from "../../src/server/host-pairing/host-pairing-repository.js";
import { configurationDocumentSchema } from "../../src/shared/protocol/configuration-admin.js";
import type { HostMetadata, HostRegistration } from "../../src/shared/protocol/host-pairing.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));
const metadata: HostMetadata = { hostname: "my-mac", platform: "darwin", architecture: "arm64", account: "operator", connectorVersion: "test", nodeVersion: "24.18.0" };
function fixture(options: { maxRegistrations?: number; failProjection?: boolean } = {}) {
  const database = openOverlayDatabase(":memory:", { migrate: false });
  databases.push(database);
  initializeEmptyBackendNormalizedDatabase(database);
  const scope = new SingleUserIdentityProvider(database).getScope();
  let now = 1_800_000_000_000;
  const configuration = new ConfigurationRepository(database, () => now);
  const projection = new ConfigurationProjection(database, { pi: "test", codex_app_server: "test", claude_agent_sdk: "test", grok_build: "test" }, () => now);
  const project = (scope: Parameters<ConfigurationProjection["project"]>[0], value: Parameters<ConfigurationProjection["project"]>[1]) => {
    projection.project(scope, value);
    if (options.failProjection) throw new Error("projection-failed");
  };
  const hosts = new HostPairingRepository(database, configuration, { project, now: () => now, registrationTtlMs: 1000,
    ...(options.maxRegistrations === undefined ? {} : { maxRegistrations: options.maxRegistrations }) });
  const request = { connectorId: randomUUID(), registrationAttemptId: randomUUID(), metadata };
  const register = () => hosts.register(scope, request);
  const acceptance = (registration: HostRegistration, workspaceRoots = ["/Users/operator/work"]) => ({
    mutationId: randomUUID(), registrationId: registration.id, expectedRegistrationRevision: registration.revision,
    expectedConfigurationRevision: configuration.get(scope).revision, label: "Work host", workspaceRoots,
    operations: { kind: "sidecar" as const, enabledCapabilities: ["directory_browser" as const, "workspace_files" as const] },
  });
  const change = (pairing: { id: string; revision: number }) => ({ mutationId: randomUUID(), pairingId: pairing.id,
    expectedPairingRevision: pairing.revision, expectedConfigurationRevision: configuration.get(scope).revision });
  return { database, scope, configuration, projection, hosts, request, register, acceptance, change, advance: (ms: number) => { now += ms; } };
}

describe("outbound host pairing persistence", () => {
  it("deduplicates attempts, requires fresh review after metadata changes, and never derives identity from hostnames", () => {
    const f = fixture();
    const original = f.register();
    f.advance(100);
    const retry = f.register();
    expect(retry.id).toBe(original.id);
    expect(retry.revision).toBe(original.revision);
    expect(retry.lastSeenAt).not.toBe(original.lastSeenAt);
    const changed = f.hosts.register(f.scope, { ...f.request, metadata: { ...metadata, hostname: "renamed" } });
    expect(changed).toMatchObject({ id: original.id, connectorId: original.connectorId, revision: 1 });
    expect(() => f.hosts.accept(f.scope, f.acceptance(original))).toThrow("changed or expired");
    expect(() => f.hosts.register(f.scope, { ...f.request, registrationAttemptId: randomUUID() })).toThrow("pending registration");
    const sameName = f.hosts.register(f.scope, { ...f.request, connectorId: randomUUID() });
    expect(sameName.id).not.toBe(original.id);
  });

  it("atomically accepts and projects an environment; recovers lost replies and replays exact receipts", () => {
    const f = fixture();
    const request = f.register();
    const input = f.acceptance(request);
    const accepted = f.hosts.accept(f.scope, input);
    expect(accepted.configuration.revision).toBe(1);
    expect(accepted.configuration.configuration.executionEnvironments).toEqual([{
      id: accepted.pairing.executionEnvironmentId, kind: "outbound", pairingId: accepted.pairing.id, platform: "darwin",
      label: input.label, workspaceRoots: input.workspaceRoots, operations: input.operations,
    }]);
    expect(f.database.prepare("SELECT kind, availability FROM execution_environments").get()).toEqual({ kind: "outbound", availability: "unavailable" });
    expect(f.database.pragma("foreign_key_check")).toEqual([]);
    expect(f.hosts.accept(f.scope, input)).toEqual(accepted);
    expect(f.register()).toEqual(accepted.registration);
    expect(() => f.hosts.accept(f.scope, { ...input, label: "Different" })).toThrow("mutation ID");
    expect(() => f.hosts.deny(f.scope, { mutationId: randomUUID(), registrationId: request.id, expectedRegistrationRevision: request.revision })).toThrow("changed or expired");
    expect(() => f.hosts.register(f.scope, { ...f.request, registrationAttemptId: randomUUID() })).toThrow("already has a pairing");
  });

  it("rolls back pairing, configuration, identity reservation, and decision if projection fails", () => {
    const f = fixture({ failProjection: true });
    const request = f.register();
    expect(() => f.hosts.accept(f.scope, f.acceptance(request))).toThrow("projection-failed");
    expect(f.hosts.getRegistration(f.scope, request.id).state).toBe("pending");
    expect(f.hosts.list(f.scope).pairings).toEqual([]);
    expect(f.configuration.get(f.scope).revision).toBe(0);
    for (const table of ["execution_environments", "execution_configuration_identities", "execution_configuration_receipts", "host_pairing_receipts"]) {
      expect(f.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("fences stale configuration, preserves the pending request, and handles accept-versus-deny", () => {
    const f = fixture();
    const request = f.register();
    const input = f.acceptance(request);
    f.configuration.save(f.scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: f.configuration.get(f.scope).configuration });
    expect(() => f.hosts.accept(f.scope, input)).toThrow("Configuration changed");
    expect(f.hosts.getRegistration(f.scope, request.id).state).toBe("pending");
    const denial = { mutationId: randomUUID(), registrationId: request.id, expectedRegistrationRevision: request.revision };
    const denied = f.hosts.deny(f.scope, denial);
    expect(f.hosts.deny(f.scope, denial)).toEqual(denied);
    expect(f.register().state).toBe("denied");
    expect(() => f.hosts.accept(f.scope, f.acceptance(denied))).toThrow("changed or expired");
  });

  it("expires on access without a timer and replays retained terminal attempts", () => {
    const f = fixture();
    const request = f.register();
    f.advance(1001);
    expect(() => f.hosts.accept(f.scope, f.acceptance(request))).toThrow("changed or expired");
    expect(f.register()).toMatchObject({ id: request.id, state: "expired", revision: 1 });
    expect(f.hosts.register(f.scope, { ...f.request, registrationAttemptId: randomUUID() }).state).toBe("pending");
  });

  it("reclaims expired history while old approvals cannot address a fresh request", () => {
    const f = fixture({ maxRegistrations: 1 });
    const request = f.register();
    const approval = f.acceptance(request);
    f.advance(1001);
    const replacement = f.hosts.register(f.scope, { ...f.request, registrationAttemptId: randomUUID() });
    expect(f.hosts.list(f.scope).registrations.map(row => row.id)).toEqual([replacement.id]);
    expect(() => f.hosts.accept(f.scope, approval)).toThrow("unavailable in this scope");
    f.advance(1001);
    const replayAfterEviction = f.register();
    expect(replayAfterEviction.id).not.toBe(request.id);
    expect(replayAfterEviction.state).toBe("pending");
    expect(f.hosts.list(f.scope).pairings).toEqual([]);
    expect(() => f.hosts.accept(f.scope, approval)).toThrow("unavailable in this scope");
  });

  it("evicts denied history without losing exact mutation replay or immutable accepted bindings", () => {
    const f = fixture({ maxRegistrations: 3 });
    const acceptedRequest = f.register();
    const accepted = f.hosts.accept(f.scope, f.acceptance(acceptedRequest));
    const deniedRequest = f.hosts.register(f.scope, { ...f.request, connectorId: randomUUID() });
    const denial = { mutationId: randomUUID(), registrationId: deniedRequest.id, expectedRegistrationRevision: deniedRequest.revision };
    const denied = f.hosts.deny(f.scope, denial);
    const pending = f.hosts.register(f.scope, { ...f.request, connectorId: randomUUID() });
    const newest = f.hosts.register(f.scope, { ...f.request, connectorId: randomUUID() });
    expect(new Set(f.hosts.list(f.scope).registrations.map(row => row.id)))
      .toEqual(new Set([acceptedRequest.id, pending.id, newest.id]));
    expect(f.hosts.getPairing(f.scope, accepted.pairing.id)).toEqual(accepted.pairing);
    expect(f.register()).toEqual(accepted.registration);
    expect(f.hosts.deny(f.scope, denial)).toEqual(denied);
    expect(() => f.hosts.deny(f.scope, { ...denial, registrationId: newest.id })).toThrow("reused with different contents");
    expect(() => f.hosts.register(f.scope, { ...f.request, connectorId: randomUUID() })).toThrow("capacity");
    expect(f.hosts.list(f.scope).registrations).toHaveLength(3);
  });

  it("keeps terminal pruning scoped and registration storage within the public list bound", () => {
    const f = fixture();
    const other = { tenantId: f.scope.tenantId, principalId: randomUUID() };
    f.database.prepare("INSERT INTO principals (tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 0)").run(other.tenantId, other.principalId);
    const otherRequest = f.hosts.register(other, { ...f.request, connectorId: randomUUID() });
    const otherDenial = { mutationId: randomUUID(), registrationId: otherRequest.id, expectedRegistrationRevision: 0 };
    const otherDenied = f.hosts.deny(other, otherDenial);
    for (let index = 0; index < 260; index += 1) {
      f.hosts.register(f.scope, { ...f.request, registrationAttemptId: randomUUID() });
      f.advance(1001);
    }
    expect(f.hosts.list(f.scope).registrations).toHaveLength(256);
    expect(f.database.prepare("SELECT count(*) AS count FROM host_registration_requests WHERE tenant_id = ? AND owner_principal_id = ?")
      .get(f.scope.tenantId, f.scope.principalId)).toEqual({ count: 256 });
    expect(f.hosts.getRegistration(other, otherRequest.id)).toEqual(otherDenied);
    expect(f.hosts.deny(other, otherDenial)).toEqual(otherDenied);
    expect(() => f.hosts.deny(f.scope, otherDenial)).toThrow("unavailable in this scope");
  });

  it("uses exact principal scope for requests, pairings, and mutation receipts", () => {
    const f = fixture();
    const other = { tenantId: f.scope.tenantId, principalId: randomUUID() };
    f.database.prepare("INSERT INTO principals (tenant_id,id,kind,created_at) VALUES (?,?,'local_human',0)").run(other.tenantId, other.principalId);
    const request = f.register();
    const input = f.acceptance(request);
    const accepted = f.hosts.accept(f.scope, input);
    expect(f.hosts.list(other)).toEqual({ registrations: [], pairings: [] });
    expect(f.hosts.pairingForConnector(other, f.request.connectorId)).toBeUndefined();
    expect(() => f.hosts.accept(other, input)).toThrow("unavailable in this scope");
    expect(() => f.hosts.getPairing(other, accepted.pairing.id)).toThrow("unavailable in this scope");
    expect(() => f.hosts.revoke(other, f.change(accepted.pairing))).toThrow("unavailable in this scope");
  });

  it("revokes and reapproves the exact identity while fencing old revisions and preserving history bindings", () => {
    const f = fixture();
    const accepted = f.hosts.accept(f.scope, f.acceptance(f.register()));
    const revoke = f.change(accepted.pairing);
    const revoked = f.hosts.revoke(f.scope, revoke);
    expect(revoked.pairing).toMatchObject({ id: accepted.pairing.id, state: "revoked", revision: 1 });
    expect(revoked.configuration.revision).toBe(2);
    expect(revoked.configuration.runtimes[0]).toMatchObject({ desiredRevision: 2, preference: "disconnected", connectionState: "disconnected", applyState: "unavailable" });
    expect(f.hosts.revoke(f.scope, revoke)).toEqual(revoked);
    expect(() => f.hosts.reapprove(f.scope, { ...f.change(revoked.pairing), expectedPairingRevision: 0 })).toThrow("pairing state changed");
    const reapproved = f.hosts.reapprove(f.scope, f.change(revoked.pairing));
    expect(reapproved.pairing).toMatchObject({ id: accepted.pairing.id, executionEnvironmentId: accepted.pairing.executionEnvironmentId, state: "accepted", revision: 2 });
    expect(reapproved.configuration.runtimes[0]).toMatchObject({ preference: "automatic", connectionState: "disconnected" });
    expect(f.database.prepare("SELECT configuration_revision AS revision FROM execution_environments").get()).toEqual({ revision: 0 });
    f.database.prepare("UPDATE execution_environments SET availability = 'available', diagnostic_code = NULL").run();
    const environment = reapproved.configuration.configuration.executionEnvironments[0]!;
    const changed = { ...reapproved.configuration.configuration, executionEnvironments: [{ ...environment, workspaceRoots: ["/Users/operator/other-work"] }] };
    f.configuration.save(f.scope, { mutationId: randomUUID(), expectedRevision: reapproved.configuration.revision, configuration: changed },
      document => f.projection.project(f.scope, document));
    expect(f.database.prepare("SELECT configuration_revision AS revision, availability, diagnostic_code AS diagnosticCode FROM execution_environments").get())
      .toEqual({ revision: 1, availability: "unavailable", diagnosticCode: "configuration_apply_pending" });
  });

  it("rejects forged pairing references, cross-host retargeting, and removal until revoked; retained revoked definitions remain editable", () => {
    const f = fixture();
    const accepted = f.hosts.accept(f.scope, f.acceptance(f.register()));
    const save = (configuration: typeof accepted.configuration.configuration) => f.configuration.save(f.scope,
      { mutationId: randomUUID(), expectedRevision: f.configuration.get(f.scope).revision, configuration }, value => f.projection.project(f.scope, value));
    const document = accepted.configuration.configuration;
    const environment = document.executionEnvironments[0]!;
    if (environment.kind !== "outbound") throw new Error("expected outbound");
    expect(() => save({ ...document, executionEnvironments: [{ ...environment, pairingId: randomUUID() }] })).toThrow("exact approved pairing");
    expect(() => save({ ...document, executionEnvironments: [{ ...environment, id: randomUUID() }] })).toThrow("exact approved pairing");
    expect(() => save({ ...document, executionEnvironments: [] })).toThrow("Revoke");
    f.hosts.revoke(f.scope, f.change(accepted.pairing));
    const edited = save({ ...document, executionEnvironments: [{ ...environment, label: "Retained" }] });
    expect(edited.configuration.executionEnvironments[0]?.label).toBe("Retained");
    save({ ...document, executionEnvironments: [] });
    expect(() => save(document)).toThrow("cannot be restored");
    expect(() => f.hosts.reapprove(f.scope, f.change(f.hosts.getPairing(f.scope, accepted.pairing.id)))).toThrow("removed");
  });

  it("preserves identity through reconnect metadata changes without persisting online claims", () => {
    const f = fixture();
    const accepted = f.hosts.accept(f.scope, f.acceptance(f.register()));
    f.advance(100);
    const observed = f.hosts.observe(f.scope, accepted.pairing.id, { ...metadata, hostname: "new-hostname", connectorVersion: "new" });
    expect(observed).toMatchObject({ id: accepted.pairing.id, revision: 0, metadata: { hostname: "new-hostname" } });
    expect(observed.lastSeenAt).not.toBe(accepted.pairing.lastSeenAt);
    expect(f.hosts.list(f.scope).pairings[0]?.connected).toBe(false);
    expect(() => f.hosts.observe(f.scope, accepted.pairing.id, { ...metadata, platform: "win32" })).toThrow("platform");
  });

  it("derives the immutable Windows platform from the connector and validates canonical roots on that platform", () => {
    const f = fixture();
    const request = f.hosts.register(f.scope, { ...f.request, metadata: { ...metadata, platform: "win32" } });
    expect(() => f.hosts.accept(f.scope, f.acceptance(request, ["/Users/operator/work"]))).toThrow("canonical absolute paths");
    const accepted = f.hosts.accept(f.scope, f.acceptance(request, ["C:\\Users\\operator\\work"]));
    expect(accepted.configuration.configuration.executionEnvironments[0]).toMatchObject({ platform: "win32", workspaceRoots: ["C:\\Users\\operator\\work"] });
  });

  it("accepts a canonical Windows UNC share root and rejects drive-relative/device paths", () => {
    const f = fixture();
    const request = f.hosts.register(f.scope, { ...f.request, metadata: { ...metadata, platform: "win32" } });
    const share = "\\\\fileserver\\projects\\";
    const accepted = f.hosts.accept(f.scope, f.acceptance(request, [share]));
    expect(accepted.configuration.configuration.executionEnvironments[0]?.workspaceRoots).toEqual([share]);
    for (const root of ["C:work", "\\\\?\\C:\\work", "\\\\fileserver\\projects"]) {
      const document = { ...accepted.configuration.configuration,
        executionEnvironments: [{ ...accepted.configuration.configuration.executionEnvironments[0]!, workspaceRoots: [root] }] };
      expect(configurationDocumentSchema.safeParse(document).success).toBe(false);
    }
  });

  it("admits outbound Claude on macOS and Linux while retaining Windows and Grok restrictions", () => {
    const f = fixture();
    const accepted = f.hosts.accept(f.scope, f.acceptance(f.register()));
    const document = accepted.configuration.configuration;
    const claude = { ...document,
      backends: [{ id: "claude", kind: "claude_agent_sdk", label: "Claude", enabled: true, modelPolicy: { type: "catalog" },
        moduleConfiguration: { configDirectory: "/home/me/.claude", initializationTimeoutMs: 20000, permissionPolicy: { allowedModes: ["default"] } } }],
      targets: [{ id: "claude-target", kind: "claude_agent_sdk", label: "Claude", enabled: true, backendInstanceId: "claude",
        executionEnvironmentId: accepted.pairing.executionEnvironmentId, moduleConfiguration: { defaults: { permissionMode: "default" } } }],
    };
    expect(configurationDocumentSchema.safeParse(claude).success).toBe(true);
    for (const platform of ["linux", "darwin", "win32"]) {
      const candidate = { ...claude, executionEnvironments: document.executionEnvironments.map(environment => ({ ...environment, platform, workspaceRoots: [platform === "win32" ? "C:\\Projects" : "/projects"] })) };
      expect(configurationDocumentSchema.safeParse(candidate).success).toBe(platform !== "win32");
    }
    expect(configurationDocumentSchema.safeParse({ ...document,
      backends: [{ id: "grok", kind: "grok_build", label: "Grok", enabled: true, modelPolicy: { type: "catalog" }, moduleConfiguration: {} }],
      targets: [{ id: "grok-target", kind: "grok_acp", label: "Grok", enabled: true, backendInstanceId: "grok", executionEnvironmentId: accepted.pairing.executionEnvironmentId, moduleConfiguration: {} }],
    }).success).toBe(false);
  });
});
