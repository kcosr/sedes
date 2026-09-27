import { OpenCodeUsageAccounting } from "../../src/server/backends/opencode/opencode-usage-accounting.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import Database from "better-sqlite3";
import { vi } from "vitest";
import type { SessionMessageInfo } from "@opencode/client";
import type { AgentBackendInstance, AgentConnectionProfile, ConversationBinding, ConversationHandle } from "../../src/server/backends/contracts.js";
import { OpenCodeConversationBackendDriver } from "../../src/server/backends/opencode/opencode-conversation-driver.js";
import type { OpenCodeConversationRuntime } from "../../src/server/backends/opencode/opencode-conversation-context.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { serializeOpenCodeBindingDetail, type OpenCodeBindingDetail } from "../../src/server/backends/opencode/opencode-binding-detail.js";
import { OpenCodeThreadSettingsRepository } from "../../src/server/backends/opencode/opencode-thread-settings-repository.js";
import { OpenCodeModelCatalog } from "../../src/server/backends/opencode/opencode-model-catalog.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { OpenCodeExecutionEnvironment } from "../../src/server/backends/opencode/opencode-execution-environment.js";
import { OpenCodeSkillCatalog } from "../../src/server/backends/opencode/opencode-skill-catalog.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { openCodeExecutionSettingsMigration } from "../../src/server/db/migrations/123-opencode-execution-settings.js";
import { openCodeRecoveryRetirementMigration } from "../../src/server/db/migrations/124-opencode-recovery-retirement.js";
import { OpenCodeThreadRepository } from "../../src/server/backends/opencode/opencode-thread-repository.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import type { OpenCodeNativeIdentity } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { openCodeNativeEvidenceMigration } from "../../src/server/db/migrations/121-opencode-native-evidence.js";
import { ConversationActorManager } from "../../src/server/conversations/conversation-actor-manager.js";
import type { ComposerAttachmentDeliveryService } from "../../src/server/composer-attachments/composer-attachment-delivery-service.js";
import type { ExecutionEnvironmentProvider, ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { createOpenCodeApiFixture } from "./opencode-api-fixture.js";


export const scope = { tenantId: "tenant", principalId: "principal" };
const backend = "opencode-fixture";
const connectionID = "opencode-connection";
const environmentID = "a3bc9398-a451-4305-a543-5e230254242d";
export const threadID = "78cbf267-a526-43b0-8262-8ec2c23dce4c";
const workspaceID = "ba11a564-8ef6-4d99-8bc1-680a05a87f00";

export function createOpenCodeConversationFixture(input: {
  messages?: SessionMessageInfo[];
  retentionMilliseconds?: number;
  /** Isolated stock-native HTTP transport; fixture disposal also closes this client. */
  native?: { client: OpenCodeHttpClient; sessionID: string; directory: string; runtime?: OpenCodeConversationRuntime };
} = {}) {
  const namespace = input.native?.runtime?.nativeNamespaceKey ?? "fixture-native-store";
  const wire = createOpenCodeApiFixture({ messages: input.messages });
  const client = input.native?.client ?? new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture-only-canary", fetch: wire.fetch });
  const sessionID = input.native?.sessionID ?? wire.sessionID;
  const directory = input.native?.directory ?? wire.directory;
  const database = new Database(":memory:"); database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE agent_backend_instances (tenant_id TEXT,id TEXT,kind TEXT,PRIMARY KEY(tenant_id,id));
    CREATE TABLE agent_connection_profiles (tenant_id TEXT,owner_principal_id TEXT,id TEXT,kind TEXT,PRIMARY KEY(tenant_id,owner_principal_id,id));
    CREATE TABLE workspaces (tenant_id TEXT,owner_principal_id TEXT,id TEXT,canonical_path TEXT,PRIMARY KEY(tenant_id,owner_principal_id,id));
    CREATE TABLE application_threads (tenant_id TEXT,owner_principal_id TEXT,id TEXT,backend_instance_id TEXT,connection_profile_id TEXT,environment_id TEXT,workspace_id TEXT, backing_state TEXT DEFAULT 'bound', PRIMARY KEY(tenant_id,owner_principal_id,id), UNIQUE(tenant_id,owner_principal_id,id,backend_instance_id,connection_profile_id,environment_id));
    CREATE TABLE conversation_bindings (tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,backend_instance_id TEXT,connection_profile_id TEXT,execution_environment_id TEXT,backend_conversation_id TEXT,
      UNIQUE(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,connection_profile_id,execution_environment_id));
  `);
  database.prepare("INSERT INTO agent_backend_instances VALUES (?,?,?)").run(scope.tenantId, backend, "opencode");
  database.prepare("INSERT INTO agent_connection_profiles VALUES (?,?,?,?)").run(scope.tenantId, scope.principalId, connectionID, "opencode_http");
  database.prepare("INSERT INTO workspaces VALUES (?,?,?,?)").run(scope.tenantId, scope.principalId, workspaceID, directory);
  database.prepare("INSERT INTO application_threads (tenant_id,owner_principal_id,id,backend_instance_id,connection_profile_id,environment_id,workspace_id) VALUES (?,?,?,?,?,?,?)").run(scope.tenantId, scope.principalId, threadID, backend, connectionID, environmentID, workspaceID);
  database.prepare("INSERT INTO conversation_bindings VALUES (?,?,?,?,?,?,?)").run(scope.tenantId, scope.principalId, threadID, backend, connectionID, environmentID, sessionID);
  database.exec(openCodeNativeEvidenceMigration.sql);
  database.exec(openCodeExecutionSettingsMigration.sql);
  database.exec(openCodeRecoveryRetirementMigration.sql);
  const repository = new OpenCodeThreadRepository({ database, scope, backendInstanceId: backend, nativeNamespaceKey: namespace });
  const detail: OpenCodeBindingDetail = { version: 1, ...scope, sessionId: sessionID, backendInstanceId: backend,
    connectionProfileId: connectionID, executionEnvironmentId: environmentID, canonicalWorkspacePath: directory, nativeNamespaceKey: namespace };
  repository.saveBinding(scope, threadID, detail);
  const workspace: ValidatedWorkspace = { canonicalPath: directory, authorityRevision: 1,
    summary: { id: workspaceID, environmentId: environmentID, displayName: "Fixture", displayPath: directory, availability: "available", trustState: "trusted", revision: 0 } };
  const binding: ConversationBinding = { tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId: threadID,
    backendInstanceId: backend, connectionProfileId: connectionID, executionEnvironmentId: environmentID,
    backendConversationId: sessionID, createdAt: "2026-09-27T00:00:00.000Z" };
  const instance: AgentBackendInstance = { id: backend, tenantId: scope.tenantId, kind: "opencode", label: "Fixture", enabled: true, configurationRevision: 1, protocolRelease: "2.0.18" };
  const connection: AgentConnectionProfile = { id: connectionID, tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
    backendInstanceId: backend, executionEnvironmentId: environmentID, kind: "opencode_http", label: "Fixture", templateId: "fixture", enabled: true, configurationRevision: 1 };
  let references = 0;
  const identity: OpenCodeNativeIdentity = { pid: process.pid, startTime: "fixture-start", uid: process.getuid?.() ?? 0,
    executablePath: "/fixture/opencode2", executable: { device: "1", inode: "2" }, nativeStorePath: "/fixture/opencode.db",
    store: { device: "1", inode: "3" }, storeObservation: "open_file" };
  // The runtime-owner seam isolates OS admission already qualified natively in
  // M1; real driver, handle, HTTP client/parser, SQL binding and actor remain.
  const runtime: OpenCodeConversationRuntime = input.native?.runtime ?? {
    nativeNamespaceKey: namespace,
    start: vi.fn(async () => { if (client.lifetime.aborted) throw new OpenCodeRuntimeError("opencode_runtime_identity_changed"); }),
    health: async () => ({ available: !client.lifetime.aborted, checkedAt: new Date().toISOString() }),
    snapshot: () => ({ state: client.lifetime.aborted ? "disconnected" : "ready", ownership: "owned", generation: "native-generation", references, identity }),
    assertCurrent: vi.fn(async signal => { signal?.throwIfAborted(); if (client.lifetime.aborted) throw new OpenCodeRuntimeError("opencode_runtime_identity_changed"); }),
    installSessionEnvironment: vi.fn(async () => { throw new Error("unexpected scoped environment installation"); }),
    acquire: vi.fn(() => {
      if (client.lifetime.aborted) throw new OpenCodeRuntimeError("opencode_runtime_identity_changed");
      references++; let released = false;
      return { client, generation: "native-generation", identity, release: () => { if (!released) { released = true; references--; } } };
    }),
  };
  const settings = new OpenCodeThreadSettingsRepository({ database, scope, backendInstanceId: backend });
  const modelPolicy = compileBackendModelPolicy({ type: "catalog" }, "provider_model_effort");
  const catalog = new OpenCodeModelCatalog({ modelPolicy, readNative: async (directory, signal) => {
    const native = new OpenCodeNativeMutations(client);
    const models = await native.listModels(directory, signal);
    const defaultModel = await native.getDefaultModel(directory, signal);
    return { models, ...(defaultModel ? { defaultModel } : {}) };
  } });
  const executionEnvironment = new OpenCodeExecutionEnvironment({ scope, ownership: "owned", readDefinitions: () => ({}), resolve: async () => ({}) });
  const skills = new OpenCodeSkillCatalog({ scope, backendInstanceId: backend, nativeNamespaceKey: namespace,
    readNative: (directory, signal) => new OpenCodeNativeMutations(client).listSkills(directory, signal) });
  const context = { scope, instance, connection, repository, settings, catalog, modelPolicy, executionEnvironment, skills, usage: new OpenCodeUsageAccounting(NO_USAGE_SINK),
    attachmentProvenanceKey: Buffer.alloc(32, 7), outputArtifacts: { findImage: () => undefined,
      publishImage: async (): Promise<import("../../src/server/output-artifacts/contracts.js").OutputImageArtifactDescriptor> => { throw new Error("unexpected image publication"); } },
    tools: { admit: async () => {}, release: () => {}, diagnostic: () => undefined, gatewayAction: () => undefined }, nativeNamespaceKey: namespace, runtime: async () => runtime };
  const driver = new OpenCodeConversationBackendDriver(context);
  const attached = vi.spyOn(driver, "attach");
  const environmentRelease = vi.fn(async () => undefined);
  const manager = new ConversationActorManager({
    environments: { acquireLease: async () => ({ scope, workspace,
      environment: { id: environmentID, label: "Fixture", availability: "available", diagnosticCode: null, revision: 0 }, release: environmentRelease }) } as unknown as ExecutionEnvironmentProvider,
    attachmentDelivery: { materialize: async () => { throw new Error("unexpected attachment materialization"); } } as unknown as ComposerAttachmentDeliveryService,
    retentionMilliseconds: input.retentionMilliseconds ?? 60_000, runtimeBudget: 8,
  });
  const target = { scope, binding, workspace, opaqueBindingDetail: serializeOpenCodeBindingDetail(detail), driver };
  const dispose = async () => { try { await manager.close(); } finally { client.close(); database.close(); } };
  const acquire = () => manager.acquire(target, { idleRelease: "retain" });
  const handle = async (): Promise<ConversationHandle> => attached.mock.results[0]!.value;
  const interrupts = () => wire.requests.filter(request => request.pathname.endsWith("/interrupt"));
  return { wire, client, runtime, context, database, repository, driver, manager, target, acquire, handle, attached, environmentRelease, interrupts, dispose };
}
