import { usageSubagentRecoveryIndexesMigration } from "../../src/server/db/migrations/114-usage-subagent-recovery-indexes.js";
import Database from "better-sqlite3";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentBackendInstance, AgentConnectionProfile, ConversationBinding, ConversationHandle } from "../../src/server/backends/contracts.js";
import { CodexConversationBackendDriver, CodexConversationOwnershipRegistry } from "../../src/server/backends/codex/codex-conversation-driver.js";
import { CodexDaemonSupervisor } from "../../src/server/backends/codex/codex-daemon-supervisor.js";
import { CodexNativeStoreOwnershipGate } from "../../src/server/backends/codex/codex-native-store-ownership.js";
import { resolveCodexRuntimeConfiguration } from "../../src/server/backends/codex/codex-runtime-config.js";
import { UnixWebSocketTransportFactory } from "../../src/server/backends/codex/transport/unix-websocket-transport.js";
import { OwnedStdioTransportFactory } from "../../src/server/backends/codex/transport/owned-stdio-transport.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { CODEX_APP_SERVER_RELEASE } from "../../src/server/backends/codex/codex-release-guard.js";
import { codexThreadResumeMethod } from "../../src/server/backends/codex/codex-c1-protocol.js";
import { codexC2NotificationSchemas, codexModelListMethod, codexThreadStartMethod, codexTurnStartMethod } from "../../src/server/backends/codex/codex-c2-protocol.js";
import { serializeCodexBindingDetail } from "../../src/server/backends/codex/codex-binding-codec.js";
import { unavailableCodexAgentToolCliEnvironmentProvider } from "../../src/server/backends/codex/codex-agent-tool-cli-environment.js";
import type { CodexExecutionSettingsTuple } from "../../src/server/backends/codex/codex-conversation-handle.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { durableUsageAccountingMigration } from "../../src/server/db/migrations/110-durable-usage-accounting.js";
import { usageGapSessionScopeMigration } from "../../src/server/db/migrations/111-usage-gap-session-scope.js";
import { usageSubagentsMigration } from "../../src/server/db/migrations/112-usage-subagents.js";
import { usageTimelineMigration } from "../../src/server/db/migrations/113-usage-timeline.js";
import { UsageService } from "../../src/server/usage/usage-service.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";
import { pinnedCodexTestExecutable } from "../helpers/pinned-codex-test-executable.js";

// Never consumes provider capacity in the normal test suite.
const enabled = process.env.SEDES_REAL_CODEX_SUBAGENTS === "1";
const model = "gpt-5.6-luna";
// Explicit opt-in targets an existing operator-owned endpoint. Its global
// configuration, process and other conversations are never changed.
const udsSocket = process.env.SEDES_REAL_CODEX_SUBAGENTS_UDS_SOCKET;
const scope = { tenantId: "tenant-live", principalId: "principal-live" };
const requestOptions = { timeoutMilliseconds: 15_000 };

function prepareDatabase(file: string, nativeRoot: string): Database.Database {
  const database = new Database(file);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE application_threads(tenant_id TEXT,owner_principal_id TEXT,id TEXT,backend_instance_id TEXT,environment_id TEXT,workspace_id TEXT,PRIMARY KEY(tenant_id,owner_principal_id,id));
    CREATE TABLE agent_backend_instances(tenant_id TEXT,id TEXT,kind TEXT,PRIMARY KEY(tenant_id,id));
    CREATE TABLE conversation_bindings(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,backend_instance_id TEXT,execution_environment_id TEXT,backend_conversation_id TEXT,connection_profile_id TEXT,created_at INTEGER);
    CREATE TABLE claude_usage_ledgers(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,request_count INTEGER,updated_at INTEGER);
    INSERT INTO application_threads VALUES('tenant-live','principal-live','application-live','backend-live','environment-live','workspace-live');
    INSERT INTO agent_backend_instances VALUES('tenant-live','backend-live','codex_app_server');
  `);
  database.prepare("INSERT INTO conversation_bindings VALUES('tenant-live','principal-live','application-live','backend-live','environment-live',?,'connection-live',?)").run(nativeRoot, Date.now());
  database.exec(durableUsageAccountingMigration.sql);
  database.exec(usageGapSessionScopeMigration.sql);
  database.exec(usageSubagentsMigration.sql);
  database.exec(usageTimelineMigration.sql); database.exec(usageSubagentRecoveryIndexesMigration.sql);
  return database;
}

describe.skipIf(!enabled)("live Codex subagent durable accounting", () => {
  it.each(["v1", "v2"] as const)("%s captures automatic child events, aggregates separately, and continues after the parent handle closes", async (agentVersion) => {
    // Codex rejects helper aliases beneath OS tmp; keep the disposable store
    // under the user-owned home, as the existing native supervisor suite does.
    const temporaryRoot = await mkdtemp(path.join(os.homedir(), ".sedes-subagent-live-"));
    const codexHome = path.join(temporaryRoot, "codex-home");
    const workingDirectory = path.join(temporaryRoot, "workspace");
    const databasePath = path.join(temporaryRoot, "usage.sqlite");
    let supervisor: CodexDaemonSupervisor | undefined;
    let handle: ConversationHandle | undefined;
    let database: Database.Database | undefined;
    let environmentChannel: LocalEnvironmentChannelProvider | undefined;
    if (udsSocket && (!path.isAbsolute(udsSocket) || path.resolve(udsSocket) !== udsSocket)) throw new Error("Expected absolute UDS socket path");
    const socketBefore = udsSocket ? await lstat(udsSocket, { bigint: true }) : undefined;
    if (socketBefore) expect(socketBefore.isSocket()).toBe(true);
    try {
      await mkdir(codexHome, { mode: 0o700 });
      await mkdir(workingDirectory);
      if (!udsSocket) {
        const authSource = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json");
        await copyFile(authSource, path.join(codexHome, "auth.json"));
        await chmod(path.join(codexHome, "auth.json"), 0o600);
        await writeFile(path.join(codexHome, "config.toml"), `[features]\nmulti_agent = true\napps = false\nplugins = false\n[features.multi_agent_v2]\nenabled = ${agentVersion === "v2"}\n`, { mode: 0o600 });
      }
      const instance: AgentBackendInstance = { id: "backend-live", tenantId: scope.tenantId, kind: "codex_app_server", label: "Live test", enabled: true, configurationRevision: 1, protocolRelease: CODEX_APP_SERVER_RELEASE };
      const connection: AgentConnectionProfile = { id: "connection-live", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
        templateId: "template-live", kind: "codex_app_server", backendInstanceId: instance.id, executionEnvironmentId: "environment-live", label: "Live test", enabled: true, configurationRevision: 1 };
      environmentChannel = new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: connection.executionEnvironmentId });
      const runtimeScope = { ...scope, backendInstanceId: instance.id, executionEnvironmentId: connection.executionEnvironmentId };
      const onRuntimeVersionAssessment = (assessment: { version: string; newerThanTested: boolean }) => console.info("Codex subagent live endpoint", {
        transport: udsSocket ? "external_uds" : "owned_stdio", agentVersion, ...assessment,
      });
      if (udsSocket) {
        supervisor = new CodexDaemonSupervisor({ scope: runtimeScope,
          transportFactory: new UnixWebSocketTransportFactory({ scope: runtimeScope, channels: environmentChannel, socketPath: udsSocket }),
          restartDelaysMilliseconds: [25], maximumRestartAttempts: 1, onRuntimeVersionAssessment });
      } else {
        const resolved = await resolveCodexRuntimeConfiguration({ scope, instance, connections: [connection], connection: {
          ownership: "owned", channel: { type: "process_stdio", executablePath: pinnedCodexTestExecutable(), workingDirectory, codexHome },
        }, environmentChannel, environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
        if (resolved.connection.ownership !== "owned" || !resolved.codexHome || !resolved.nativeStoreHome || !resolved.childEnvironment) throw new Error("Expected isolated owned runtime");
        const transportFactory = new OwnedStdioTransportFactory({ scope: runtimeScope, channels: environmentChannel,
          process: resolved.connection.channel.process, environment: resolved.childEnvironment, sqliteHome: resolved.nativeStoreHome });
        supervisor = new CodexDaemonSupervisor({ scope: runtimeScope, expectedCodexHome: resolved.codexHome, transportFactory,
          restartDelaysMilliseconds: [25], maximumRestartAttempts: 1, nativeStoreOwnership: new CodexNativeStoreOwnershipGate(), onRuntimeVersionAssessment });
      }
      await supervisor.start();
      const client = supervisor.client;
      const catalog = await client.request(codexModelListMethod, { limit: 100, includeHidden: true }, requestOptions);
      expect(catalog.data.some(entry => entry.id === model && entry.supportedReasoningEfforts.some(effort => effort.reasoningEffort === "low"))).toBe(true);
      const started = await client.request(codexThreadStartMethod, { model, cwd: workingDirectory, sandbox: "read-only", approvalPolicy: "never", ephemeral: false,
        ...(udsSocket ? { config: { "features.multi_agent": true, "features.multi_agent_v2.enabled": agentVersion === "v2", "features.apps": false, "features.plugins": false }, threadSource: "sedes_subagent_usage_live" } : {}),
      }, requestOptions);
      const nativeRoot = started.thread.id;
      database = prepareDatabase(databasePath, nativeRoot);
      const usage = new UsageService(database, {enabled: true});
      const binding: ConversationBinding = { tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId: "application-live",
        backendInstanceId: instance.id, connectionProfileId: connection.id, executionEnvironmentId: connection.executionEnvironmentId,
        backendConversationId: nativeRoot, createdAt: new Date().toISOString() };
      const workspace = { authorityRevision: 1, canonicalPath: workingDirectory, summary: { id: "workspace-live", environmentId: connection.executionEnvironmentId,
        displayName: "Disposable test", displayPath: workingDirectory, availability: "available" as const, trustState: "trusted" as const, revision: 1 } };
      const settings: CodexExecutionSettingsTuple = { model, reasoningEffort: "low", serviceTier: "standard", sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user" };
      const diagnostics: unknown[] = [];
      const driver = new CodexConversationBackendDriver({ usageSink: usage, nativeNamespace: "disposable-codex-store", instance, connection, client,
        serverRequests: supervisor.serverRequests, ownership: new CodexConversationOwnershipRegistry(), toolProvenanceKey: new Uint8Array(32).fill(0x5a),
        modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"), outputArtifacts: createInMemoryOutputArtifactPublisher(),
        agentToolCliEnvironment: unavailableCodexAgentToolCliEnvironmentProvider, onError: error => diagnostics.push(error), executionSettings: {
          desiredSettings: () => settings, resolveFastModeDisabled: () => settings, forkSettingsEligibility: () => ({ availability: "available", settingsRevision: 1, settings }),
          freezeOperationSnapshot: () => ({ settings }), observeEffective: () => undefined, markEffectiveUnknown: () => undefined,
        } });
      handle = await driver.attach({ scope, binding, workspace, opaqueBindingDetail: serializeCodexBindingDetail({ threadId: nativeRoot,
        sessionId: started.thread.sessionId, nativeAncestry: null, correlationAncestorThreadIds: [] }) });
      await handle.establishProjection({ signal: new AbortController().signal });
      const nativeCounters = new Map<string, number>();
      const completed = new Map<string, number>();
      const discovered = new Set<string>();
      const stopObserver = client.subscribeNotifications(notification => {
        if (notification.kind !== "decoded_notification") return;
        if (notification.method === "thread/tokenUsage/updated") {
          const event = codexC2NotificationSchemas["thread/tokenUsage/updated"].parse(notification.params);
          nativeCounters.set(event.threadId, event.tokenUsage.total.totalTokens);
        } else if (notification.method === "item/completed") {
          const event = codexC2NotificationSchemas["item/completed"].parse(notification.params);
          if (event.threadId === nativeRoot) {
            if (agentVersion === "v2" && event.item.type === "subAgentActivity" && event.item.kind === "started") discovered.add(event.item.agentThreadId);
            if (agentVersion === "v1" && event.item.type === "collabAgentToolCall" && event.item.tool === "spawnAgent" && event.item.status === "completed") {
              for (const id of event.item.receiverThreadIds) discovered.add(id);
            }
          }
        } else if (notification.method === "turn/completed") {
          const event = codexC2NotificationSchemas["turn/completed"].parse(notification.params);
          completed.set(event.threadId, (completed.get(event.threadId) ?? 0) + 1);
        }
      });
      try {
        await handle.submit({ applicationOperationId: "live-subagent-prompt", source: { kind: "user" }, mutationId: "live-subagent-mutation",
          reconciliationToken: "live-subagent-token", contextExcerpts: [], taskContexts: [], attachments: [],
          text: "This is an authorized subagent accounting test. Use spawn_agent exactly once to delegate: 'Reply with the word READY. Do not use tools.' Use gpt-5.6-luna with low reasoning if selectable. Wait for the child to finish, then reply DONE. Do not use shell, filesystem, network, or any tools except agent spawning and waiting." });
        await vi.waitFor(() => expect(completed.get(nativeRoot)).toBe(1), { timeout: 90_000, interval: 100 });
        expect(discovered.size).toBe(1);
        const childId = [...discovered][0]!;
        expect(usage.findSubagent({ ...runtimeScope, connectionProfileId: connection.id,
          nativeNamespace: "disposable-codex-store", nativeSession: childId })).toMatchObject({
          binding: {applicationThreadId: binding.applicationThreadId, backendConversationId: nativeRoot},
          nativeParentSession: nativeRoot,
        });
        await vi.waitFor(() => expect(completed.get(childId)).toBe(1), { timeout: 30_000, interval: 100 });
        expect(usage.listSubagents({ binding, nativeNamespace: "disposable-codex-store" })).toEqual([]);
        const initial = usage.read(scope, binding.applicationThreadId);
        const mainTotal = nativeCounters.get(nativeRoot)!;
        const childTotal = nativeCounters.get(childId)!;
        expect(mainTotal).toBeGreaterThan(0);
        expect(childTotal).toBeGreaterThan(0);
        expect(initial.breakdown?.main.metrics.total.value).toBe(String(mainTotal));
        expect(initial.breakdown?.subagents.metrics.total.value).toBe(String(childTotal));
        expect(initial.summary.metrics.total.value).toBe(String(mainTotal + childTotal));
        await handle.close(); handle = undefined;
        // Revisions belong to the whole conversation and advance on child
        // updates. All actual main-turn accounting must remain identical.
        const turnDatabase = database;
        const readMainTurns = () => (turnDatabase.prepare("SELECT turn_id,report_json FROM usage_turn_state ORDER BY turn_id").all() as {turn_id:string;report_json:string}[])
          .map(row => ({turnId: row.turn_id, report: {...JSON.parse(row.report_json), revision: "ignored"}}));
        const mainTurns = readMainTurns();
        expect(mainTurns.length).toBeGreaterThan(0);
        // Continue the same child after the parent presentation unsubscribes.
        // V2 rejects direct child input. Its native parent control prompt is
        // deliberately outside the closed app handle, and asks the supported
        // followup_task tool to start the child again. Handle close
        // unsubscribes the parent, so restore this test connection's native
        // lifecycle subscription without opening an app handle or history.
        // Neither path reads a child transcript; the app turn stays unchanged.
        if (agentVersion === "v2") await client.request(codexThreadResumeMethod, { threadId: nativeRoot, excludeTurns: true }, requestOptions);
        const followup = agentVersion === "v2"
          ? "Use followup_task to tell the existing child to reply READY AGAIN without tools. Do not spawn another agent. Wait for its reply, then say DONE. Do not use tools except followup_task and agent waiting."
          : "Reply READY AGAIN. Do not use any tools.";
        await client.request(codexTurnStartMethod, { threadId: agentVersion === "v2" ? nativeRoot : childId, model, effort: "low", approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false }, input: [{ type: "text", text: followup, text_elements: [] }] }, requestOptions);
        await vi.waitFor(() => expect(completed.get(childId)).toBe(2), { timeout: 60_000, interval: 100 });
        if (agentVersion === "v2") await vi.waitFor(() => expect(completed.get(nativeRoot)).toBe(2), { timeout: 60_000, interval: 100 });
        const updated = usage.read(scope, binding.applicationThreadId);
        expect(Number(updated.breakdown?.subagents.metrics.total.value)).toBeGreaterThan(childTotal);
        expect(updated.breakdown?.main.metrics.total.value).toBe(String(mainTotal));
        expect(updated.summary.metrics.total.value).toBe(String(mainTotal + nativeCounters.get(childId)!));
        expect(readMainTurns()).toEqual(mainTurns);
        expect(database.prepare("SELECT COUNT(*) AS n FROM usage_records r JOIN usage_sources s ON s.id=r.source_id WHERE s.agent_role='subagent' AND r.turn_id IS NOT NULL").get()).toEqual({ n: 0 });
        expect(diagnostics).toEqual([]);
        await supervisor.close(); supervisor = undefined;
        database.close(); database = new Database(databasePath);
        const restored = new UsageService(database, {enabled: true}).read(scope, binding.applicationThreadId);
        expect(restored.summary.metrics.total.value).toBe(updated.summary.metrics.total.value);
        expect(restored.breakdown?.subagents.metrics.total.value).toBe(updated.breakdown?.subagents.metrics.total.value);
      } finally { stopObserver(); }
    } finally {
      await handle?.close().catch(() => undefined);
      await supervisor?.close();
      database?.close();
      environmentChannel?.close();
      await rm(temporaryRoot, { recursive: true, force: true });
      if (udsSocket && socketBefore) {
        const after = await lstat(udsSocket, { bigint: true });
        expect(after.isSocket()).toBe(true);
        expect({ device: after.dev, inode: after.ino }).toEqual({ device: socketBefore.dev, inode: socketBefore.ino });
      }
    }
  }, 210_000);
});
