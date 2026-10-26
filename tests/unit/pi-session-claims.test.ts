import type Database from "better-sqlite3";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionClaims } from "../../src/server/backends/pi/pi-session-claims.js";
import { PiSessionStore } from "../../src/server/backends/pi/pi-session-store.js";
import { PiNativeDiskStore } from "../../src/server/backends/pi/native/host/disk-store.js";
import { PiConversationRepository } from "../../src/server/backends/pi/pi-conversation-repository.js";
import { PiNativeThreadRepository } from "../../src/server/backends/pi/native/pi-native-thread-repository.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
function fixture() {
  const { database, scope } = savedAgentDatabase();
  databases.push(database);
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, { environmentId: environment.id,
    canonicalPath: "/tmp/pi-claims", displayName: "Claims", project: { kind: "new", name: "Claims" },
    available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 200 });
  const configuration = new BackendConfigurationRepository(database);
  const sdk = configuration.listProfiles(scope).find(profile => profile.kind === "pi_sdk")!;
  const clone = (table: string, id: string, changes: Record<string, unknown>) => {
    const row = { ...(database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>), ...changes };
    database.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  };
  clone("agent_backend_instances", sdk.backendInstanceId, { id: "native-one", kind: "pi_native" });
  clone("agent_backend_instances", sdk.backendInstanceId, { id: "native-two", kind: "pi_native" });
  clone("agent_connection_profiles", sdk.id, { id: "native-profile", template_id: "native-target", backend_instance_id: "native-one", backend_kind: "pi_native", kind: "pi_rpc" });
  clone("agent_connection_profiles", sdk.id, { id: "native-profile-two", template_id: "native-target-two", backend_instance_id: "native-two", backend_kind: "pi_native", kind: "pi_rpc" });
  const native = configuration.getProfile(scope, "native-profile");
  const nativeTwo = configuration.getProfile(scope, "native-profile-two");
  const bindings = new ConversationBindingRepository(database);
  const claims = new PiSessionClaims(database);
  const thread = (id: string, profile = sdk) => bindings.createUnboundThread(scope, {
    id, workspaceId: workspace.id, connectionProfileId: profile.id, title: id, initialText: "Hi", now: 300,
  });
  const prepare = (id: string, profile = sdk, sessionId = "shared", fork = false) => {
    thread(id, profile);
    const common = { attemptId: `attempt-${id}`, mutationId: `operation-${id}`,
      expectedThreadRevision: 0, initialAttachmentIds: [] as const,
      backendCreationCorrelation: sessionId, now: 400 };
    new ConversationCreationRepository(database).prepare(scope, id, fork
      ? { ...common, creationKind: "fork", sourceKind: "user_fork", initialInputText: null,
        forkChildIdentity: "application_reserved", forkCreationRecovery: "idempotent" }
      : { ...common, creationKind: "first_input", sourceKind: "composer", initialInputText: "Hi",
        initialContextExcerpts: [], initialTaskReferences: [], expectedDraftRevision: 0 });
    return { applicationThreadId: id, applicationOperationId: `operation-${id}`,
      sessionId, sessionDirectory: "/native/sessions" };
  };
  const discovered = (profile = native, sessionId = "shared", sessionFile = "/native/sessions/shared.jsonl") => ({
    backendInstanceId: profile.backendInstanceId, executionEnvironmentId: environment.id, sessionId, sessionFile,
  });
  const bind = (id: string, profile = sdk, sessionId = "shared", sessionFile = "/native/sessions/shared.jsonl") => {
    thread(id, profile);
    bindings.bindDiscoveredConversation(scope, id, { backendConversationId: sessionId, now: 500 });
    const repository = profile.kind === "pi_sdk" ? new PiConversationRepository(database) : new PiNativeThreadRepository(database);
    const detail = profile.kind === "pi_sdk" ? { backendConversationId: sessionId, sessionFile }
      : { version: 1, sessionId, sessionFile, cwd: "/tmp/pi-claims" };
    repository.saveBindingDetails(scope, id, { backendConversationId: sessionId,
      nativeSessionPath: sessionFile, opaqueBindingDetail: JSON.stringify(detail) });
  };
  return { database, scope, environment, sdk, native, nativeTwo, claims, thread, prepare, discovered, bind, clone };
}

describe("shared SDK/native Pi store ownership", () => {
  it.each(["sdk", "native"] as const)("suppresses a %s-owned file across all other Pi backend instances", owner => {
    const f = fixture();
    f.bind("owner", owner === "sdk" ? f.sdk : f.native);
    expect(f.claims.isClaimed(f.scope, f.discovered(owner === "sdk" ? f.native : f.sdk))).toBe(true);
    expect(f.claims.isClaimed(f.scope, f.discovered(f.nativeTwo))).toBe(true);
    expect(() => f.bind("duplicate", f.nativeTwo)).toThrow("already owned or reserved");
    expect(f.database.prepare("SELECT count(*) AS count FROM pi_session_claims").get()).toEqual({ count: 1 });
  });

  it.each([false, true])("reserves before publication and retains an abandoned create/fork tombstone (fork=%s)", fork => {
    const f = fixture();
    const reservation = f.prepare("reserved", f.sdk, "shared", fork);
    f.claims.reserve(f.scope, reservation);
    f.claims.reserve(f.scope, reservation);
    expect(f.claims.isClaimed(f.scope, f.discovered())).toBe(true);
    expect(f.claims.isClaimed(f.scope, f.discovered(f.nativeTwo))).toBe(true);
    f.database.prepare("DELETE FROM conversation_creation_attempts WHERE application_thread_id = ?").run("reserved");
    f.database.prepare("DELETE FROM thread_drafts WHERE thread_id = ?").run("reserved");
    f.database.prepare("DELETE FROM thread_principal_state WHERE thread_id = ?").run("reserved");
    f.database.prepare("DELETE FROM application_threads WHERE id = ?").run("reserved");
    expect(f.claims.isClaimed(f.scope, f.discovered())).toBe(true);
    const other = f.prepare("other", f.nativeTwo);
    expect(() => f.claims.reserve(f.scope, other)).toThrow("already owned or reserved");
  });

  it("requires the exact durable creation attempt and isolates distinct stores and storage hosts", () => {
    const f = fixture();
    const reservation = f.prepare("reserved");
    expect(() => f.claims.reserve(f.scope, { ...reservation, applicationOperationId: "wrong" })).toThrow("matching creation attempt");
    expect(() => f.claims.reserve(f.scope, { ...reservation, sessionId: "wrong" })).toThrow("matching creation attempt");
    expect(() => f.claims.reserve({ ...f.scope, principalId: "wrong" }, reservation)).toThrow("not found");
    f.claims.reserve(f.scope, reservation);
    expect(() => f.claims.reserve(f.scope, { ...reservation, sessionDirectory: "/other/sessions" })).toThrow("already owned or reserved");
    expect(f.claims.isClaimed(f.scope, f.discovered(f.native, "shared", "/other/sessions/shared.jsonl"))).toBe(false);
    expect(f.claims.isClaimed(f.scope, f.discovered(f.native, "another", "/native/sessions/another.jsonl"))).toBe(false);
    const otherEnvironment = "00000000-0000-4000-8000-000000000002";
    f.clone("execution_environments", f.environment.id, { id: otherEnvironment, kind: "ssh" });
    expect(f.claims.isClaimed(f.scope, { ...f.discovered(), executionEnvironmentId: otherEnvironment })).toBe(false);
    // SDK files stay on main even when its workspace is remote; native files
    // are on that remote host. Equal path text cannot join those namespaces.
    f.database.prepare("UPDATE execution_environments SET kind = 'ssh' WHERE id = ?").run(f.environment.id);
    expect(f.claims.isClaimed(f.scope, f.discovered())).toBe(false);
    expect(f.claims.isClaimed(f.scope, f.discovered(f.sdk))).toBe(true);
  });

  it("honors bound and identified files written before claims existed", () => {
    const f = fixture();
    f.bind("owner");
    f.database.prepare("DELETE FROM pi_session_claims").run();
    expect(f.claims.isClaimed(f.scope, f.discovered())).toBe(true);
    expect(() => f.bind("duplicate", f.native)).toThrow("already owned or reserved");
    const reservation = f.prepare("identified", f.sdk, "identified");
    f.database.prepare(`UPDATE conversation_creation_attempts SET provisional_backend_conversation_id = ?,
      provisional_opaque_binding_detail = ? WHERE application_thread_id = ?`).run("identified",
      JSON.stringify({ backendConversationId: "identified", sessionFile: "/native/sessions/identified.jsonl" }), reservation.applicationThreadId);
    expect(f.claims.isClaimed(f.scope, f.discovered(f.native, "identified", "/native/sessions/identified.jsonl"))).toBe(true);
    f.database.prepare(`INSERT INTO aborted_thread_forks (tenant_id, owner_principal_id, creation_operation_id,
      reserved_child_thread_id, source_thread_id, boundary_kind, source_kind, diagnostic, aborted_at,
      reserved_backend_instance_id, reserved_backend_conversation_id)
      VALUES (?, ?, 'aborted-op', 'aborted-child', 'owner', 'provider_snapshot_at_acceptance', 'user_fork',
        'aborted', 600, ?, 'aborted-session')`).run(f.scope.tenantId, f.scope.principalId, f.sdk.backendInstanceId);
    expect(f.claims.isClaimed(f.scope, f.discovered(f.native, "aborted-session", "/native/sessions/aborted.jsonl"))).toBe(true);
    expect(f.claims.isClaimed(f.scope, f.discovered(f.native, "aborted-session", "/other/sessions/aborted.jsonl"))).toBe(false);
  });

  it("resolves default and explicit stores to the same physical directory without creating it", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-claims-")));
    directories.push(root);
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    const agentDirectory = path.join(root, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
    const native = new PiNativeDiskStore({ agentDirectory, authenticationKey: new Uint8Array(32).fill(1) });
    const expected = native.getSessionDirectory(cwd);
    const explicit = new PiNativeDiskStore({ sessionDirectory: expected, authenticationKey: new Uint8Array(32).fill(1) });
    const workspace = { canonicalPath: cwd } as ValidatedWorkspace;
    try {
      expect(await native.resolveSessionDirectory(cwd)).toBe(expected);
      expect(await explicit.resolveSessionDirectory(cwd)).toBe(expected);
      expect(await new PiSessionStore().resolveSessionDirectory(workspace)).toBe(expected);
      expect(await new PiSessionStore({ sessionDirectory: expected }).resolveSessionDirectory(workspace)).toBe(expected);
      await expect(stat(agentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { native.close(); explicit.close(); }
  });
});
