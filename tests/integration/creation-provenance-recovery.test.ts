import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationCreationProvenanceRepository } from "../../src/server/db/repositories/conversation-creation-provenance-repository.js";
import { ThreadForceResetRepository } from "../../src/server/db/repositories/thread-force-reset-repository.js";
import { DatabaseCodexAgentToolCliEnvironmentProvider, withCodexAgentToolCliEnvironment } from "../../src/server/backends/codex/codex-agent-tool-cli-environment.js";
import { serializeCodexBindingDetail } from "../../src/server/backends/codex/codex-binding-codec.js";
import { runCreationProvenanceCli, verifyCreationRepair } from "../../src/cli/creation-provenance-cli.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { CodexThreadExecutionSettingsRepository } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(migrateLatest = true, filename = ":memory:") {
  const database = openOverlayDatabase(filename); databases.push(database);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(scope, { environmentId: environment.id,
    canonicalPath: "/tmp/provenance-regression", displayName: "Provenance", availability: "available", trustState: "trusted" }, 10);
  const configuration = parseResolvedBackendConfiguration({ schemaVersion: 10,
    executionEnvironments: [{ id: environment.id, kind: "local", label: "Local" }],
    backends: [{ id: "codex-proof", kind: "codex_app_server", label: "Codex", enabled: true, modelPolicy: { type: "catalog" },
      moduleConfiguration: { connection: { ownership: "owned", channel: { type: "process_stdio", executablePath: "/usr/bin/false", workingDirectory: "/tmp" } },
        policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled", "enabled"], allowedApprovalPolicies: ["never"], allowedApprovalReviewers: ["user"] } } },
      { id: "pi-proof", kind: "pi", label: "Pi", enabled: true, modelPolicy: { type: "catalog" } }],
    targets: [{ id: "codex-proof-target", kind: "codex_app_server", label: "Codex", backendInstanceId: "codex-proof",
      executionEnvironmentId: environment.id, enabled: true, moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "enabled",
        approvalPolicy: "never", approvalReviewer: "user", model: { type: "fixed", modelId: "test-model" } } } }, { id: "pi-proof-target", kind: "pi_sdk", label: "Pi",
        backendInstanceId: "pi-proof", executionEnvironmentId: environment.id, enabled: true }], defaultTargetId: "pi-proof-target",
  });
  applyBackendNormalizationMigration(database, { configuration, quiescentCutoverConfirmed: true, appliedAt: 20 });
  applyDatabaseMigrations(database, backendNormalizedMigrations.filter(value => migrateLatest || value.version < 142));
  importLegacyDatabaseConfigurationFixture(database, { configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "Provenance regression" }, 25);
  const profile = new BackendConfigurationRepository(database).listProfiles(scope).find(row => row.backendInstanceId === "codex-proof")!;
  const bindings = new ConversationBindingRepository(database);
  const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId: profile.id, title: "Proof", now: 30 });
  const threadId = thread.id;
  new CodexThreadExecutionSettingsRepository(database).initialize(scope, { applicationThreadId: threadId,
    desired: { model: "test-model", reasoningEffort: "low", serviceTier: "standard", sandboxMode: "read-only",
      networkAccess: "enabled", approvalPolicy: "never", approvalReviewer: "user" }, now: 30 });
  const creation = new ConversationCreationRepository(database);
  const nativeId = "01a128fe-18dd-7692-9de2-eaba461aa90c";
  const detail = serializeCodexBindingDetail({ threadId: nativeId, sessionId: "native-session-proof", correlationAncestorThreadIds: [], nativeAncestry: null });
  const prepare = () => {
    creation.prepare(scope, threadId, { attemptId: "attempt", mutationId: "create-operation", expectedThreadRevision: 0,
      creationKind: "first_input", sourceKind: "direct_input", initialInputText: "Original request", initialAttachmentIds: [],
      backendCreationCorrelation: "create-correlation", now: 40 });
    creation.markExternalCallStarted(scope, threadId, "attempt", 50);
  };
  const identify = () => creation.recordConversationIdentified(scope, threadId, "attempt", {
    backendConversationId: nativeId, opaqueBindingDetail: detail, reconciliationToken: "create-token", now: 60 });
  const bind = () => bindings.bindProviderAssignedConversation(scope, threadId, { attemptId: "attempt", backendConversationId: nativeId, boundAt: 70 });
  const abandon = () => {
    creation.markFirstSubmissionStarted(scope, threadId, "attempt", { reconciliationToken: "first-token", retryAnchor: "anchor", now: 80 });
    creation.markRecoveryRequired(scope, threadId, "attempt", { expected: "first_submission_started", diagnostic: "Transport lost", now: 90 });
    const resets = new ThreadForceResetRepository(database);
    resets.forceReset(scope, threadId, { expectedBlockerFingerprint: resets.impact(scope, threadId).blockerFingerprint, mutationId: "reset", now: 100 });
  };
  const provider = (surface: "native" | "cli") => new DatabaseCodexAgentToolCliEnvironmentProvider({ database, backendInstanceId: "codex-proof",
    runtime: { availability: "available", endpoint: "http://127.0.0.1:4784", executableDirectory: "/tmp/sedes/bin", inheritedPath: "/bin" },
    sourceCapabilities: { issue: () => "scoped-test-capability-00000000000000000000000000000000" }, agentTools: { readPolicy: () => ({ enabled: true,
      presentation: { surface, mode: "individual" }, accessBoundary: "environment", enabledToolIds: ["agent.context"] }) } });
  return { database, scope, threadId, nativeId, bindings, creation, prepare, identify, bind, abandon, provider };
}

describe("durable verified creation identity", () => {
  it.each(["native", "cli"] as const)("retains %s tools after unresolved first-send force reset without replay", async surface => {
    const f = fixture(); f.prepare();
    expect(await f.provider(surface).acquire(f.scope, f.threadId)).toMatchObject({ availability: "unavailable" });
    const initial = await f.provider(surface).acquire(f.scope, f.threadId, { creationOperationId: "create-operation" });
    expect(initial.availability).toBe("available"); if (initial.availability === "available") initial.release();
    expect(await f.provider(surface).acquire(f.scope, f.threadId, { creationOperationId: "foreign-operation" })).toMatchObject({ availability: "unavailable" });
    f.identify(); f.bind(); f.abandon();
    const before = f.database.prepare("SELECT * FROM conversation_creation_attempts").get();
    const resolved = await f.provider(surface).acquire(f.scope, f.threadId);
    expect(resolved.availability).toBe("available");
    const config = withCodexAgentToolCliEnvironment({}, { resolution: resolved, applicationThreadId: f.threadId });
    if (surface === "native") expect(Object.hasOwn(config, "mcp_servers.sedes")).toBe(true);
    else expect(config).toHaveProperty("shell_environment_policy");
    if (resolved.availability === "available") resolved.release();
    expect(f.database.prepare("SELECT * FROM conversation_creation_attempts").get()).toEqual(before);
    expect(() => f.creation.get(f.scope, f.threadId, "attempt")).toThrow("abandoned");
    expect(() => f.database.prepare("UPDATE conversation_creation_provenance SET backend_conversation_id='foreign'").run()).toThrow("immutable");
    expect(await f.provider(surface).acquire({ ...f.scope, principalId: "foreign" }, f.threadId)).toMatchObject({ availability: "unavailable" });
    expect(new ConversationCreationProvenanceRepository(f.database).matchesBinding(f.scope, f.threadId, { backendConversationId: "foreign" })).toBe(false);
    f.database.prepare("UPDATE codex_thread_execution_settings SET desired_network_access='disabled'").run();
    expect(await f.provider(surface).acquire(f.scope, f.threadId)).toMatchObject({ availability: "unavailable", reason: "network_disabled" });
  });

  it("never treats an imported binding as created", async () => {
    const f = fixture();
    f.bindings.bindDiscoveredConversation(f.scope, f.threadId, { backendConversationId: f.nativeId, now: 50 });
    expect(await f.provider("native").acquire(f.scope, f.threadId)).toMatchObject({ availability: "unavailable", reason: "imported_thread" });
  });

  it.each(["identified", "mismatched_native", "unidentified", "imported"] as const)(
    "migrates only verified existing identity: %s", kind => {
      const f = fixture(false);
      if (kind === "imported") f.bindings.bindDiscoveredConversation(f.scope, f.threadId, { backendConversationId: f.nativeId, now: 70 });
      else {
        f.prepare();
        if (kind !== "unidentified") f.identify();
        f.database.prepare(`INSERT INTO conversation_bindings SELECT tenant_id,owner_principal_id,id,backend_instance_id,
          connection_profile_id,environment_id,?,70 FROM application_threads WHERE id=?`)
          .run(kind === "mismatched_native" ? "different-native-id" : f.nativeId, f.threadId);
      }
      applyDatabaseMigrations(f.database, backendNormalizedMigrations);
      expect(new ConversationCreationProvenanceRepository(f.database).matchesBinding(f.scope, f.threadId)).toBe(kind === "identified");
    },
  );

  it("repairs only exact retained evidence, preserving abandoned receipts and archived lifecycle", () => {
    const f = fixture(false); f.prepare(); f.identify();
    f.database.prepare(`INSERT INTO conversation_bindings
      SELECT tenant_id,owner_principal_id,id,backend_instance_id,connection_profile_id,environment_id,?,70
      FROM application_threads WHERE id=?`).run(f.nativeId, f.threadId);
    f.abandon();
    applyDatabaseMigrations(f.database, backendNormalizedMigrations);
    const repository = new ConversationCreationProvenanceRepository(f.database);
    expect(repository.get(f.scope, f.threadId)).toBeUndefined();
    const stale = repository.previewRepair(f.scope, f.threadId, f.nativeId);
    expect(verifyCreationRepair(f.database, stale)).toBe(true);
    f.database.prepare("UPDATE thread_principal_state SET inventory_state='archived' WHERE thread_id=?").run(f.threadId);
    expect(() => repository.applyRepair(f.scope, f.threadId, { expectedNativeSessionId: f.nativeId,
      expectedFingerprint: stale.fingerprint, now: 200, repairId: "stale", verify: row => verifyCreationRepair(f.database, row) })).toThrow("changed after preview");
    const evidence = repository.previewRepair(f.scope, f.threadId, f.nativeId);
    const attempt = f.database.prepare("SELECT * FROM conversation_creation_attempts").get();
    const thread = f.database.prepare("SELECT * FROM application_threads").get();
    const result = repository.applyRepair(f.scope, f.threadId, { expectedNativeSessionId: f.nativeId,
      expectedFingerprint: evidence.fingerprint, now: 200, repairId: "repair", verify: row => verifyCreationRepair(f.database, row) });
    expect(result.inventoryState).toBe("archived");
    expect(repository.matchesBinding(f.scope, f.threadId)).toBe(true);
    expect(f.database.prepare("SELECT * FROM conversation_creation_attempts").get()).toEqual(attempt);
    expect(f.database.prepare("SELECT * FROM application_threads").get()).toEqual(thread);
    expect(f.database.prepare("SELECT count(*) AS n FROM conversation_creation_provenance_repairs").get()).toEqual({ n: 1 });
    expect(() => repository.previewRepair(f.scope, f.threadId, "another-session")).toThrow("exact verified creation");
    expect(() => repository.previewRepair({ ...f.scope, principalId: "another-principal" }, f.threadId, f.nativeId)).toThrow();
    f.database.prepare("DELETE FROM conversation_bindings WHERE application_thread_id=?").run(f.threadId);
    expect(repository.get(f.scope, f.threadId)).toBeUndefined();
    expect(f.database.prepare("SELECT count(*) AS n FROM conversation_creation_provenance_repairs").get()).toEqual({ n: 1 });
  });

  it("previews and applies an offline exact-thread repair without changing archived state or replaying input", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sedes-proof-")); directories.push(directory);
    const filename = path.join(directory, "overlay.sqlite");
    const f = fixture(false, filename); f.prepare(); f.identify();
    f.database.prepare(`INSERT INTO conversation_bindings SELECT tenant_id,owner_principal_id,id,backend_instance_id,
      connection_profile_id,environment_id,?,70 FROM application_threads WHERE id=?`).run(f.nativeId, f.threadId);
    f.abandon();
    const args = ["creation-provenance", "--database", filename, "--tenant", f.scope.tenantId,
      "--principal", f.scope.principalId, "--thread", f.threadId, "--native-session", f.nativeId];
    let output = ""; let error = "";
    const io = { stdout: { write: (text: string) => { output += text; } }, stderr: { write: (text: string) => { error += text; } } };
    expect(await runCreationProvenanceCli(["creation-provenance", "--help"], io)).toBe(0);
    expect(output).toContain("Usage:"); output = "";
    expect(await runCreationProvenanceCli(args, io)).toBe(1);
    expect(error).toContain("Upgrade and migrate");
    applyDatabaseMigrations(f.database, backendNormalizedMigrations);
    f.database.prepare("UPDATE thread_principal_state SET inventory_state='archived' WHERE thread_id=?").run(f.threadId);
    const attempt = f.database.prepare("SELECT * FROM conversation_creation_attempts").get();
    error = "";
    expect(await runCreationProvenanceCli(args, io)).toBe(0);
    const preview = JSON.parse(output);
    expect(preview).toMatchObject({ status: "dry_run", inventoryState: "archived", runtimeRefresh: "deferred_until_explicit_restore" });
    expect(f.database.prepare("SELECT count(*) AS n FROM conversation_creation_provenance").get()).toEqual({ n: 0 });
    expect(await runCreationProvenanceCli([...args, "--apply", "--expected-fingerprint", preview.fingerprint], io)).toBe(2);
    output = "";
    expect(await runCreationProvenanceCli([...args, "--apply", "--server-stopped", "--expected-fingerprint", preview.fingerprint], io)).toBe(0);
    expect(JSON.parse(output).status).toBe("repaired");
    expect(f.database.prepare("SELECT * FROM conversation_creation_attempts").get()).toEqual(attempt);
    expect(f.database.prepare("SELECT inventory_state FROM thread_principal_state WHERE thread_id=?").get(f.threadId)).toEqual({ inventory_state: "archived" });
  });
});
