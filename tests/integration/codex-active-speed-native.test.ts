import model from "../../scripts/codex-probes/speed-fixture-model.json";
import { CODEX_SPEED_REF, speedArgumentsValue, speedResultWireSchema, type SpeedSelection } from "../../src/shared/provider-features/codex-speed.js";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  initializeEmptyBackendNormalizedDatabase,
} from "../../src/server/db/migrate.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { CodexThreadActionPersistence } from "../../src/server/backends/codex/codex-thread-action-persistence.js";
import { CodexThreadExecutionSettingsRepository } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import { serializeCodexBindingDetail } from "../../src/server/backends/codex/codex-binding-codec.js";
import { codexThreadGoalSetMethod } from "../../src/server/backends/codex/codex-goal-protocol.js";
import { CodexGoalSessionRegistry } from "../../src/server/backends/codex/codex-goal-session.js";
import { ProviderFeatureMutationRepository } from "../../src/server/db/repositories/provider-feature-mutation-repository.js";
import { CodexThreadPresentationProvider } from "../../src/server/backends/codex/codex-thread-presentation-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";


import { createPersistentCodexLiveSidecar } from "../helpers/persistent-codex-live-sidecar.js";
import { CodexRuntimeClient } from "../../src/server/backends/codex/runtime/codex-runtime-client.js";
import { CodexSidecarRuntimeConnection } from "../../src/server/backends/codex/runtime/codex-sidecar-runtime.js";
import { CodexRuntimeReceiptStore } from "../../src/server/backends/codex/runtime/codex-runtime-receipt-store.js";

import { mkdtemp, mkdir, writeFile, readFile, rm, access, stat, chmod } from "node:fs/promises";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexExecutionSettingsRepositoryAdapter } from "../../src/server/backends/codex/codex-backend-module.js";
import { CodexConversationBackendDriver } from "../../src/server/backends/codex/codex-conversation-driver.js";
import { CodexConversationOwnershipRegistry } from "../../src/server/backends/codex/codex-conversation-driver.js";
import { CodexFastModeSessionRegistry } from "../../src/server/backends/codex/codex-fast-mode-session.js";
import { CodexDaemonSupervisor } from "../../src/server/backends/codex/codex-daemon-supervisor.js";
import { CodexNativeStoreOwnershipGate } from "../../src/server/backends/codex/codex-native-store-ownership.js";
import { OwnedStdioTransportFactory } from "../../src/server/backends/codex/transport/owned-stdio-transport.js";
import { UnixWebSocketTransportFactory } from "../../src/server/backends/codex/transport/unix-websocket-transport.js";
import { resolveCodexRuntimeConfiguration } from "../../src/server/backends/codex/codex-runtime-config.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { unavailableCodexAgentToolCliEnvironmentProvider } from "../../src/server/backends/codex/codex-agent-tool-cli-environment.js";
import { ConversationActor } from "../../src/server/conversations/conversation-actor.js";
import { ConversationProjector } from "../../src/server/conversations/conversation-projector.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { speedStateWireSchema } from "../../src/shared/provider-features/codex-speed.js";
import { startMockResponsesServer, type MockResponseEvent } from "../../scripts/codex-probes/mock-responses-server.mjs";
import { probeEnvironment } from "../../scripts/codex-probes/raw-app-server-client.mjs";
import { codexThreadReadMethod, codexThreadResumeMethod, codexThreadUnsubscribeMethod } from "../../src/server/backends/codex/codex-c1-protocol.js";
import { codexExperimentalFeatureListMethod, codexThreadStartMethod, codexTurnStartMethod, codexThreadSettingsUpdateMethod } from "../../src/server/backends/codex/codex-c2-protocol.js";
import { codexTurnSettingsUpdateMethod } from "../../src/server/backends/codex/codex-active-speed-protocol.js";
import type { FramedTransportFactory } from "../../src/server/provider-protocol/transport/assured-framed-transport.js";

// Explicit local-artifact gate: isolated CODEX_HOME and a loopback Responses
// fixture only. This never uses an authenticated provider or executes a command.
// Native subagent and Goal tools are exercised through deterministic responses.
const candidate = process.env.SEDES_SPEED_NATIVE_EXECUTABLE;
const native = candidate ? it : it.skip;
const nativeTimeout = 120_000;
if (candidate) beforeAll(async () => {
  expect(path.isAbsolute(candidate)).toBe(true);
  const versionHome = await mkdtemp(path.join(tmpdir(), "speed-version-"));
  let version: string;
  try {
    version = execFileSync(candidate, ["--version"], { env: probeEnvironment(versionHome), encoding: "utf8", timeout: 10_000 }).trim().replace(/^codex-cli /, "");
  } finally { await rm(versionHome, { recursive: true, force: true }); }
  expect(["0.162.1", "0.163.0"]).toContain(version);
  const metadata = JSON.parse(await readFile(path.resolve(`protocol/codex-app-server/0.163.0/runtime-compatibility/${version}.json`), "utf8"));
  const sha256 = createHash("sha256").update(await readFile(candidate)).digest("hex");
  expect(sha256).toBe(metadata.platforms.find((platform: { nodePlatform: string; nodeArch: string }) => platform.nodePlatform === process.platform && platform.nodeArch === process.arch).executableSha256);
  process.stdout.write(`Offline Speed qualification: ${JSON.stringify({ version, sha256, platform: process.platform, arch: process.arch, authenticatedProvider: false })}\n`);
});

function toolResponse(id: string) {
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item: { type: "function_call", call_id: id, name: "exec_command",
      arguments: JSON.stringify({ cmd: "touch command-must-not-run", sandbox_permissions: "require_escalated", justification: "Decline the offline qualification command", yield_time_ms: 1000 }) } },
    { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
}
async function until<T>(read: () => T | undefined | null | false, label: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Native Speed qualification timed out: ${label}`);
}

const nativeScenarios = [
  ...(["local", "external", "sidecar"] as const).map(topology => ({ topology, scenario: "full" as const })),
  ...(["no-fast", "no-ultrafast", "no-tiers", "fallback-only", "non-advertising", "stale-gate"] as const)
    .map(scenario => ({ topology: "local" as const, scenario })),
  { topology: "external" as const, scenario: "restart" as const },
  { topology: "external" as const, scenario: "recovery-link" as const },
];
native.each(nativeScenarios)("qualifies real native Speed ($topology/$scenario)", async ({ topology, scenario }) => {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-speed-native-"));
  const home = path.join(root, "home"), workspacePath = path.join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(workspacePath)]);
  const provider = await startMockResponsesServer();
  const releases: Array<() => void> = [];
  let supervisor: CodexDaemonSupervisor | CodexRuntimeClient | undefined;
  let sidecar: Awaited<ReturnType<typeof createPersistentCodexLiveSidecar>> | undefined;
  let attachment: Awaited<ReturnType<Awaited<ReturnType<typeof createPersistentCodexLiveSidecar>>["attach"]>> | undefined;
  let actor: ConversationActor | undefined;
  let driver: CodexConversationBackendDriver | undefined;
  let external: ChildProcess | undefined;
  let wakeAfterEviction: () => Promise<void>;
  let restartExternal: (() => Promise<unknown>) | undefined;
  let holdSpeedFrame = false;
  let heldSpeedFrame: string | undefined;
  let sidecarAuthority: import("../../src/server/backends/codex/runtime/codex-runtime-protocol.js").CodexRuntimeAuthority | undefined;
  const ingressPath = path.join(root, "native-ingress.jsonl");
  try {
    const modelPath = path.join(home, "models.json");
    const advertisedModel = ["fallback-only", "non-advertising"].includes(scenario)
      ? { ...model, service_tiers: [], additional_speed_tiers: scenario === "fallback-only" ? ["fast"] : [] } : model;
    await writeFile(modelPath, JSON.stringify({ models: [advertisedModel] }));
    const config = `model = "${model.slug}"
model_catalog_json = ${JSON.stringify(modelPath)}
model_provider = "sedes_fixture"
approval_policy = "on-request"
sandbox_mode = "read-only"
[model_providers.sedes_fixture]
name = "Sedes offline fixture"
base_url = "${provider.baseUrl}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
requires_openai_auth = false
supports_websockets = false
[features]
apps = false
plugins = false
fast_mode = ${scenario !== "no-fast" && scenario !== "no-tiers"}
ultrafast_mode = ${scenario !== "no-ultrafast" && scenario !== "no-tiers"}
step_model_switching = false
multi_agent = true
goals = true
`;
    await writeFile(path.join(home, "config.toml"), config);
    const sessions = new CodexFastModeSessionRegistry();
    const goals = new CodexGoalSessionRegistry();
    let adapter: CodexExecutionSettingsRepositoryAdapter;
    const f = fixture(workspacePath, { fastModeRuntime: sessions,
      desiredSettingsChanged: (scope, id) => adapter.notifyDesiredSettingsChanged(scope, id) });
    adapter = new CodexExecutionSettingsRepositoryAdapter(f.settings, executionPolicy, catalogModelPolicy);
    const desired = f.settings.find(f.scope, f.codexThreadId)!;
    f.settings.updateDesired(f.scope, f.codexThreadId, { expectedRevision: desired.revision,
      desired: { ...desired.desired!, model: model.slug, approvalPolicy: "on-request" }, now: Date.now() });
    const rawBackend = f.configurations.getBackend(f.scope, "codex-primary");
    const { ownerPrincipalId: _owner, configurationFingerprint: _backendFingerprint, ...backendConfiguration } = rawBackend;
    const { configurationFingerprint: _profileFingerprint, ...profileConfiguration } = f.codexProfile;
    const instance = { ...backendConfiguration, enabled: true }, connection = { ...profileConfiguration, enabled: true };
    const channels = new LocalEnvironmentChannelProvider({ scope: f.scope, executionEnvironmentId: connection.executionEnvironmentId, environment: probeEnvironment(home) });
    const resolved = await resolveCodexRuntimeConfiguration({ scope: f.scope, instance, connections: [connection],
      connection: { ownership: "owned", channel: { type: "process_stdio", executablePath: candidate!, workingDirectory: workspacePath, codexHome: home } },
      environmentChannel: channels, environment: probeEnvironment(home) });
    if (resolved.connection.ownership !== "owned" || !resolved.childEnvironment || !resolved.nativeStoreHome) throw new Error("expected_owned");
    const runtimeScope = { ...f.scope, backendInstanceId: instance.id, executionEnvironmentId: connection.executionEnvironmentId };
    if (topology === "sidecar") {
      // Observe complete frames at the real native process boundary. This
      // transparent fixture relay preserves byte order and records no secrets.
      const relayPath = path.join(root, "native-ingress-relay.mjs");
      await writeFile(relayPath, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const child = spawn(${JSON.stringify(candidate)}, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] });
let pending = '';
process.stdin.on('data', bytes => {
  pending += bytes.toString();
  let end;
  while ((end = pending.indexOf('\\n')) !== -1) {
    const line = pending.slice(0, end + 1); pending = pending.slice(end + 1);
    appendFileSync(${JSON.stringify(ingressPath)}, line); child.stdin.write(line);
  }
});
process.stdin.on('end', () => child.stdin.end(pending));
child.stdout.pipe(process.stdout);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
`);
      await chmod(relayPath, 0o700);
      sidecar = await createPersistentCodexLiveSidecar({ ...f.scope, executionEnvironmentId: connection.executionEnvironmentId });
      attachment = await sidecar.attach();
      const remote = new CodexSidecarRuntimeConnection(attachment.session.runtimeChannel);
      const runtimeId = await remote.ensure({ instance, connections: [connection], connection: {
        ownership: "owned", channel: { type: "process_stdio", executablePath: relayPath, workingDirectory: workspacePath, codexHome: home },
      } });
      const receipts = new CodexRuntimeReceiptStore(f.database, undefined, (scope, id) => sessions.controller(scope, id)?.publicationChanged());
      const authority = { scope: runtimeScope, runtimeId, controllerId: String(attachment.status.controllerEpoch) };
      sidecarAuthority = authority;
      supervisor = new CodexRuntimeClient({ connection: remote, authority, receipts,
        onAttachmentFailure: failure => process.stderr.write(`Offline sidecar failure: ${failure.stage} ${failure.method ?? ""} ${String(failure.error)}\n`),
      });
      await supervisor.start();
      wakeAfterEviction = async () => {
        await remote.idle(authority, supervisor!.client.lifecycleSnapshot().generation);
        await until(() => supervisor!.client.lifecycleSnapshot().state === "idle", "sidecar idle retirement");
        await remote.wake(authority);
        await until(() => supervisor!.client.lifecycleSnapshot().state === "ready", "sidecar cold wake");
      };
    } else if (topology === "external") {
      const socketPath = path.join(root, "native.sock");
      const launchExternal = async () => {
      external = spawn(candidate!, ["app-server", "--config", `sqlite_home=${JSON.stringify(home)}`, "--strict-config", "--listen", `unix://${socketPath}`,
        ...(["restart", "recovery-link"].includes(scenario) ? ["--managed-daemon"] : [])], {
        cwd: workspacePath, env: probeEnvironment(home), stdio: ["ignore", "ignore", "ignore"],
      });
      await once(external, "spawn");
      for (let attempt = 0; ; attempt++) {
        if (external.exitCode !== null) throw new Error("offline_native_daemon_exited");
        const metadata = await stat(socketPath).catch(() => undefined);
        if (metadata?.isSocket() && (metadata.mode & 0o777) === 0o600) {
          // The path can appear before listen() is ready. Probe connectivity
          // before handing this external daemon to the Sedes supervisor.
          const listening = await new Promise<boolean>(resolve => {
            const socket = createConnection(socketPath);
            const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
            socket.once("connect", () => finish(true));
            socket.once("error", () => finish(false));
            socket.setTimeout(1_000, () => finish(false));
          });
          if (listening) break;
        }
        if (attempt === 500) throw new Error("offline_native_socket_timeout");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      };
      await launchExternal();
      restartExternal = async () => {
        external!.kill("SIGTERM");
        const snapshotPath = path.join(home, "app-server-daemon", "loaded-threads.json");
        let snapshot: unknown;
        for (let i = 0; ; i++) {
          try { snapshot = JSON.parse(await readFile(snapshotPath, "utf8")); break; } catch {
            if (i === 500) throw new Error("native_restart_snapshot_timeout");
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        const exited = once(external!, "exit"); external!.kill("SIGKILL"); await exited;
        await launchExternal();
        return snapshot;
      };
      const nativeTransport = new UnixWebSocketTransportFactory({ scope: runtimeScope, channels, socketPath });
      const transportFactory: FramedTransportFactory = scenario === "restart" ? {
        open: async (scope, generation, signal) => {
          const transport = await nativeTransport.open(scope, generation, signal);
          return { maximumFrameBytes: transport.maximumFrameBytes, assurance: transport.assurance,
            frames: transport.frames, closed: transport.closed, close: reason => transport.close(reason),
            send: async (text, options) => {
              if (holdSpeedFrame && JSON.parse(text).method === "turn/settings/update") {
                // A carrier accepted a frame but the native reply never arrives.
                // Retirement discards it; a new generation cannot replay it.
                heldSpeedFrame = text; return { disposition: "sent" as const };
              }
              return transport.send(text, options);
            } };
        },
      } : nativeTransport;
      supervisor = new CodexDaemonSupervisor({ scope: runtimeScope,
        transportFactory });
      await supervisor.start();
      const localSupervisor = supervisor;
      wakeAfterEviction = async () => { await localSupervisor.wake(); };
    } else {
    supervisor = new CodexDaemonSupervisor({ scope: runtimeScope, expectedCodexHome: home, nativeStoreOwnership: new CodexNativeStoreOwnershipGate(),
      transportFactory: new OwnedStdioTransportFactory({ scope: runtimeScope, channels,
        process: resolved.connection.channel.process, environment: resolved.childEnvironment, sqliteHome: resolved.nativeStoreHome }) });
    await supervisor.start();
    const localSupervisor = supervisor;
    wakeAfterEviction = async () => { await localSupervisor.wake(); };
    }
    const nativeRequest = supervisor.client.requestWithReceipt.bind(supervisor.client);
    const requestSpy = vi.spyOn(supervisor.client, "requestWithReceipt");
    if (scenario === "stale-gate") {
      // Reproduce a Sedes-created session loaded before this feature existed.
      // Only its initial per-thread override is absent; native execution and
      // the eventual disabled-feature error are the real pinned binary.
      requestSpy.mockImplementation(((method: { method: string }, params: Record<string, unknown>, options: unknown) => {
        if (method.method === "thread/start") {
          const config = { ...(params.config as Record<string, unknown>) }; delete config["features.step_model_switching"];
          return nativeRequest.call(supervisor!.client, method as never, { ...params, config }, options as never);
        }
        return nativeRequest.call(supervisor!.client, method as never, params, options as never);
      }) as typeof supervisor.client.requestWithReceipt);
    }
    const warnings: unknown[] = [];
    supervisor.client.subscribeNotifications(notification => { if (notification.kind === "decoded_notification" && notification.method === "warning") warnings.push(notification.params); });
    driver = new CodexConversationBackendDriver({ instance, connection, client: supervisor.client, serverRequests: supervisor.serverRequests,
      ownership: new CodexConversationOwnershipRegistry(), toolProvenanceKey: new Uint8Array(32).fill(23), modelPolicy: catalogModelPolicy,
      executionSettings: adapter, fastModeSessions: sessions, goalSessions: goals, outputArtifacts: createInMemoryOutputArtifactPublisher(),
      agentToolCliEnvironment: unavailableCodexAgentToolCliEnvironmentProvider,
      usageSink: NO_USAGE_SINK, nativeNamespace: "offline-speed-native", viewedImageCapture: { capture: async () => undefined } });
    const workspace = { authorityRevision: 1, canonicalPath: workspacePath, summary: { id: f.workspace.id, environmentId: connection.executionEnvironmentId,
      displayName: "Offline Speed", displayPath: workspacePath, availability: "available" as const, trustState: "trusted" as const, revision: 1 } };
    const creations = new ConversationCreationRepository(f.database);
    const bindings = new ConversationBindingRepository(f.database);
    creations.prepare(f.scope, f.codexThreadId, { attemptId: "native-create", mutationId: "native-create",
      expectedThreadRevision: f.inventory.getThread(f.scope, f.codexThreadId).thread.revision,
      creationKind: "first_input", sourceKind: "direct_input", initialInputText: "Offline Speed qualification",
      initialAttachmentIds: [], backendCreationCorrelation: "offline_speed_native", now: Date.now() });
    creations.markExternalCallStarted(f.scope, f.codexThreadId, "native-create", Date.now());
    const created = await driver.create({ scope: f.scope, applicationThreadId: f.codexThreadId, applicationOperationId: "native-create",
      source: { kind: "user" }, workspace, creationCorrelation: "offline_speed_native" });
    creations.recordConversationIdentified(f.scope, f.codexThreadId, "native-create", { backendConversationId: created.backendConversationId,
      opaqueBindingDetail: created.opaqueBindingDetail, now: Date.now() });
    bindings.bindProviderAssignedConversation(f.scope, f.codexThreadId, { attemptId: "native-create", backendConversationId: created.backendConversationId, boundAt: Date.now() });
    const binding = { ...runtimeScope, ownerPrincipalId: f.scope.principalId, connectionProfileId: connection.id,
      applicationThreadId: f.codexThreadId, backendConversationId: created.backendConversationId, createdAt: new Date().toISOString() };
    const opened: Array<Extract<import("../../src/shared/protocol/backend.js").BackendConversationEvent, { type: "interaction_opened" }>> = [];
    const openActor = async () => {
      const handle = await driver!.attach({ scope: f.scope, binding, workspace, opaqueBindingDetail: created.opaqueBindingDetail });
      handle.subscribe(event => { if (event.type === "interaction_opened") opened.push(event); });
      const next = new ConversationActor({ handle, environmentLease: { scope: f.scope, environment: { id: connection.executionEnvironmentId,
        label: "Local", availability: "available", diagnosticCode: null, revision: 1 }, workspace, release: async () => {} },
        attachmentDelivery: {} as never, projector: new ConversationProjector({ backendInstanceId: instance.id, bindingIdentity: f.codexThreadId }),
        projectionUpdateIntervalMilliseconds: 1 });
      await next.start({ signal: new AbortController().signal });
      return next;
    };
    actor = await openActor();
    const presentation = new CodexThreadPresentationProvider({ settings: f.settings, executionPolicy, modelPolicy: catalogModelPolicy, fastModeRuntime: sessions });
    const present = async () => presentation.read({ scope: f.scope, applicationThreadId: f.codexThreadId, backend: instance, connection, workspace,
      catalog: await driver!.catalog({ scope: f.scope, workspace }) });
    const speed = async () => speedStateWireSchema.parse((await present()).providerFeatureStates.find(s => s.ref.featureId === CODEX_SPEED_REF.featureId)!.state);
    const envelopes: Parameters<typeof f.persistence.performProviderFeature>[2][] = [];
    const change = async (selection: SpeedSelection, target = sessions.controller(f.scope, f.codexThreadId)!.currentRun()?.target ?? null) => {
      const view = await present(); const state = view.providerFeatureStates.find(s => s.ref.featureId === CODEX_SPEED_REF.featureId)!;
      const cap = view.providerFeatureCapabilities.find(c => c.ref.featureId === CODEX_SPEED_REF.featureId)!;
      const envelope = { mutationId: randomUUID(), expectedThreadRevision: f.inventory.getThread(f.scope, f.codexThreadId).thread.revision,
        operation: { action: "perform_provider_feature" as const, feature: CODEX_SPEED_REF, actionId: "set_speed", expectedMutationRevision: cap.mutationRevision,
          arguments: speedArgumentsValue({ selection, currentRunTarget: target }) }, featureState: state.state, now: Date.now() };
      envelopes.push(envelope);
      const result = await actor!.runProviderFeatureMutation(context => f.persistence.performProviderFeature(f.scope, f.codexThreadId, { ...envelope, actor: context })).catch(error => {
        throw new Error(`Speed ${selection} failed: ${JSON.stringify({ target, current: sessions.controller(f.scope, f.codexThreadId)?.currentRun(), runState: actor!.timeline.runState, requests: provider.requestCount })}`, { cause: error });
      });
      expect("status" in result && result.status).toBe("provider_feature_result");
      if (!("status" in result) || result.status !== "provider_feature_result") throw new Error("missing_speed_result");
      return speedResultWireSchema.parse(result.result);
    };
    const submit = (id: string, text = "Offline Speed qualification") => actor!.submit({ applicationOperationId: id, source: { kind: "user" }, mutationId: id,
      reconciliationToken: id, contextExcerpts: [], taskContexts: [], attachments: [], text });
    const firstSubmit = async (id: string) => {
      creations.markFirstSubmissionStarted(f.scope, f.codexThreadId, "native-create", { reconciliationToken: id, retryAnchor: id, now: Date.now() });
      await submit(id);
      creations.markAcceptedUnpersisted(f.scope, f.codexThreadId, "native-create", { expected: "first_submission_started", acceptedAt: Date.now() });
      bindings.completeProviderAssignedFirstSend(f.scope, f.codexThreadId, { attemptId: "native-create", backendConversationId: created.backendConversationId, acceptedAt: Date.now() });
    };
    if (scenario !== "full" && scenario !== "restart" && scenario !== "recovery-link") {
      const events = toolResponse("gate-next-step"); (events[1]!.item as { name: string }).name = "offline_nonexistent_tool";
      const held = provider.hold(events); releases.push(held);
      await firstSubmit("gate-qualification");
      await until(() => provider.requestCount === 1, "gate model capture");
      if (scenario === "stale-gate") {
        expect(sessions.projection(f.scope, f.codexThreadId)?.stepSwitchingEnabled).toBe(false);
        const nativeProjection = sessions.projection.bind(sessions);
        vi.spyOn(sessions, "projection").mockImplementation((scope, id) => {
          const state = nativeProjection(scope, id);
          return state ? { ...state, stepSwitchingEnabled: true } : state;
        });
        const target = await until(() => sessions.controller(f.scope, f.codexThreadId)?.currentRun()?.target, "stale gate target");
        await until(() => actor!.timeline.turnsById[target.turnId], "stale gate projection");
        const result = await change("fast", target);
        expect(result.currentRun).toMatchObject({ status: "rejected", reason: "not_enabled" });
        expect(result.saved.selection).toBe("fast");
        expect(sessions.controller(f.scope, f.codexThreadId)!.currentRun()!.target).toBeNull();
        const count = requestSpy.mock.calls.filter(([method]) => method.method === "turn/settings/update").length;
        expect(count).toBe(1);
        await expect(change("standard", target)).rejects.toThrow();
        expect(requestSpy.mock.calls.filter(([method]) => method.method === "turn/settings/update")).toHaveLength(count);
      } else {
        const enabled = scenario === "no-fast" ? ["ultrafast"] : scenario === "no-ultrafast" ? ["fast"] : [];
        const view = await present();
        const state = view.providerFeatureStates.find(item => item.ref.featureId === CODEX_SPEED_REF.featureId);
        expect(state ? speedStateWireSchema.parse(state.state).offered.map(item => item.selection) : ["standard"]).toEqual(["standard", ...enabled]);
        for (const selection of ["fast", "ultrafast"] as const) {
          const before = requestSpy.mock.calls.filter(([method]) => method.method === "turn/settings/update").length;
          if (enabled.includes(selection)) expect((await change(selection)).currentRun.status).toBe("published");
          else {
            if (state) await expect(change(selection)).rejects.toThrow();
            else await expect(sessions.controller(f.scope, f.codexThreadId)!.prepare(selection)).rejects.toThrow();
            expect(requestSpy.mock.calls.filter(([method]) => method.method === "turn/settings/update")).toHaveLength(before);
          }
        }
      }
      held(); await until(() => actor!.timeline.runState === "idle", "gate completion");
      expect(JSON.parse(provider.requestBodies.at(-1)!).service_tier).toBe(scenario === "no-fast" ? "ultrafast" : scenario === "no-ultrafast" ? "priority" : undefined);
      expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(config);
      process.stdout.write(`Offline Speed scenario: ${JSON.stringify({ topology, scenario, status: "passed", modelRequests: provider.requestCount,
        nativeSpeedPublications: requestSpy.mock.calls.filter(([method]) => method.method === "turn/settings/update").length,
        nextStepTier: JSON.parse(provider.requestBodies.at(-1)!).service_tier ?? "default" })}\n`);
      return;
    }
    if (scenario === "restart" || scenario === "recovery-link") {
      const completeResponse = (id: string): MockResponseEvent[] => [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item: { type: "message", role: "assistant", id, content: [{ type: "output_text", text: "Offline restart complete" }] } },
        { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      releases.push(provider.hold(completeResponse("interrupted-original")));
      releases.push(provider.hold(completeResponse("native-recovery")));
      await firstSubmit("interrupted-native-run");
      const oldTarget = await until(() => sessions.controller(f.scope, f.codexThreadId)?.currentRun()?.target, "interrupted target");
      await until(() => actor!.timeline.turnsById[oldTarget.turnId] && provider.requestCount === 1, "interrupted projection and capture");
      const generation = supervisor.client.lifecycleSnapshot().generation;
      const nativeThread = await supervisor.client.request(codexThreadReadMethod,
        { threadId: created.backendConversationId, includeTurns: true }, { timeoutMilliseconds: 10_000 });
      const nativeTurnId = nativeThread.thread.turns.find(turn => turn.status === "inProgress")!.id;
      expect(nativeTurnId).toBeTruthy();
      if (scenario === "recovery-link") {
        // Fault qualification only: normal Sedes admission forbids an active
        // default write. Qualify the interrupted snapshot and actual recovery.
        let defaultApplied = false;
        const stopObserving = supervisor.client.subscribeNotifications(notification => {
          if (notification.kind !== "decoded_notification" || notification.method !== "thread/settings/updated") return;
          const value = notification.params as { threadId: string; threadSettings: { serviceTier: string | null } };
          if (value.threadId === created.backendConversationId && value.threadSettings.serviceTier === "priority") defaultApplied = true;
        });
        try {
          await supervisor.client.request(codexThreadSettingsUpdateMethod, { threadId: created.backendConversationId, serviceTier: "priority" },
            { timeoutMilliseconds: 10_000 });
          await until(() => defaultApplied, "active native default applied notification");
        } finally { stopObserving(); }
        const snapshot = await restartExternal!();
        expect(JSON.stringify(snapshot)).toContain(created.backendConversationId);
        expect(JSON.stringify(snapshot)).toContain(nativeTurnId);
        await until(() => provider.requestCount === 2, "native recovery after active default update");
        expect(provider.requestBodies[1]).toContain("server restarted");
        expect(JSON.parse(provider.requestBodies[1]!).service_tier).toBeUndefined();
        process.stdout.write(`Offline Speed scenario: ${JSON.stringify({ topology, scenario, status: "passed",
          activeDefaultWritePreservesInterruptedSnapshot: true, nativeRecoveryObserved: true, recoveredTier: "default" })}\n`);
        return;
      }
      const beforeDefaults = requestSpy.mock.calls.filter(([method]) => method.method === "thread/settings/update").length;
      holdSpeedFrame = true;
      const pending = change("fast", oldTarget);
      await until(() => heldSpeedFrame, "accepted frame before native generation loss");
      const restartedAt = performance.now();
      const snapshot = await restartExternal!();
      const result = await pending;
      expect(result.currentRun.status).toBe("uncertain");
      expect(result.saved.selection).toBe("fast");
      expect(JSON.stringify(snapshot)).toContain(created.backendConversationId);
      expect(JSON.stringify(snapshot)).toContain(nativeTurnId);
      holdSpeedFrame = false;
      await until(() => supervisor!.client.lifecycleSnapshot().state === "ready" && supervisor!.client.lifecycleSnapshot().generation > generation, "successor generation");
      expect(sessions.controller(f.scope, f.codexThreadId)!.currentRun()?.target).toBeNull();
      await expect(change("ultrafast", oldTarget)).rejects.toThrow();
      expect(requestSpy.mock.calls.filter(([method]) => method.method === "turn/settings/update")).toHaveLength(1);
      expect(requestSpy.mock.calls.filter(([method]) => method.method === "thread/settings/update")).toHaveLength(beforeDefaults);
      await until(() => provider.requestCount >= 2, "native recovery request");
      expect(JSON.parse(provider.requestBodies[1]!).service_tier).toBeUndefined();
      expect(provider.requestBodies[1]).toContain("server restarted");
      releases[0]!(); releases[1]!();
      await until(() => actor!.timeline.runState === "idle", "recovered idle");
      // Synthetic interrupted history cannot end the saved grace; a new Sedes
      // start still explicitly carries the saved tier before the grace expires.
      expect(performance.now() - restartedAt).toBeLessThan(30_000);
      expect(await actor.runProviderFeatureMutation(() => sessions.controller(f.scope, f.codexThreadId)!.syncDefaults())).toBe("deferred");
      await submit("explicit-after-restart");
      await until(() => provider.requestCount === 3 && actor!.timeline.runState === "idle", "explicit successor completion");
      expect(JSON.parse(provider.requestBodies[2]!).service_tier).toBe("priority");
      const remaining = 30_100 - (performance.now() - restartedAt);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      await until(() => sessions.controller(f.scope, f.codexThreadId)!.defaultState === "confirmed", "bounded recovery grace expiry");
      process.stdout.write(`Offline Speed scenario: ${JSON.stringify({ topology, scenario, status: "passed", generationChangedDuringPublication: true,
        nativeRecoveryTier: "default", explicitSuccessorTier: "priority", graceBoundMilliseconds: 30_000 })}\n`);
      return;
    }
    // Unknown tool calls return an error to the model without executing code.
    // Hold each already-captured model request while Sedes publishes the next tier.
    for (let i = 0; i < 3; i++) {
      const events = toolResponse(`speed-step-${i}`);
      (events[1]!.item as { name: string }).name = "offline_nonexistent_tool";
      releases.push(provider.hold(events));
    }
    await firstSubmit("first-native-run");
    expect(adapter.isSedesCreated(f.scope, f.codexThreadId, created.backendConversationId)).toBe(true);
    const target = await until(() => sessions.controller(f.scope, f.codexThreadId)?.currentRun()?.target, "active target");
    await until(() => actor!.timeline.turnsById[target.turnId], "projected current turn");
    const statuses: string[] = [];
    for (const [index, selection] of (["fast", "standard", "ultrafast"] as const).entries()) {
      await until(() => provider.requestCount === index + 1, `captured request ${index}`);
      const captured = provider.requestBodies[index];
      const result = await change(selection, target); statuses.push(result.currentRun.status);
      expect(result.currentRun).toMatchObject({ status: "published", target, selection });
      expect((await speed()).currentRun).toMatchObject({ startingSelection: "standard", requestedSelection: selection });
      expect(provider.requestBodies[index]).toBe(captured);
      releases[index]!();
    }
    await until(() => actor!.timeline.runState === "idle", "first completion");
    expect(provider.requestBodies.map((body: string) => JSON.parse(body).service_tier ?? "omitted")).toEqual(["omitted", "priority", "omitted", "ultrafast"]);
    const beforeReplay = provider.requestCount;
    const publicationsBeforeReplay = requestSpy.mock.calls.filter(([method]) => method.method === "turn/settings/update").length;
    const old = envelopes[0]!;
    const replay = await f.persistence.performProviderFeature(f.scope, f.codexThreadId, old);
    expect("status" in replay && replay.status).toBe("provider_feature_result"); expect(provider.requestCount).toBe(beforeReplay);
    expect(requestSpy.mock.calls.filter(([method]) => method.method === "turn/settings/update")).toHaveLength(publicationsBeforeReplay);
    const finished = await change("fast", target);
    expect(finished.currentRun).toMatchObject({ status: "target_finished" });
    expect(requestSpy.mock.calls.filter(([method]) => method.method === "turn/settings/update")).toHaveLength(publicationsBeforeReplay);
    await submit("future-native-run");
    await until(() => provider.requestCount === beforeReplay + 1 && actor!.timeline.runState === "idle", "future completion");
    expect(JSON.parse(provider.requestBodies.at(-1)!).service_tier).toBe("priority");
    const idle = await change("standard", null);
    expect(idle.currentRun.status).toBe("not_requested");
    await until(() => f.settings.find(f.scope, f.codexThreadId)?.effective?.serviceTier === "standard", "idle default confirmation");
    await submit("future-standard-run");
    await until(() => provider.requestCount === beforeReplay + 2 && actor!.timeline.runState === "idle", "future Standard completion");
    expect(JSON.parse(provider.requestBodies.at(-1)!).service_tier).toBeUndefined();
    expect(requestSpy.mock.calls.filter(([method]) => method.method === "turn/start").map(([, params]) => (params as { serviceTier?: string }).serviceTier)).toEqual(["default", "priority", "default"]);
    // Evict before starting background agents. Unlike a main-server detach,
    // idle eviction plus the runtime owner's idle/wake boundary exercises cold resume.
    await until(() => actor!.canEvict, "native idle eviction authority");
    expect(await actor.closeIfIdle()).toBe(true); actor = undefined;
    await wakeAfterEviction();
    const beforeColdResume = requestSpy.mock.calls.length;
    actor = await openActor();
    expect(requestSpy.mock.calls.slice(beforeColdResume).filter(([method]) => method.method === "thread/resume")
      .some(([, params]) => (params as { config?: Record<string, unknown> }).config?.["features.step_model_switching"] === true)).toBe(true);
    // A publication is still truthful when Stop prevents all later inference.
    provider.enqueue(toolResponse("approval-ending-run"));
    const requestsBeforeApproval = provider.requestCount;
    await submit("approval-ending-run");
    const approval = await until(() => opened.at(-1), "native approval");
    expect(approval.interaction.kind).toBe("decision");
    const approvalTarget = sessions.controller(f.scope, f.codexThreadId)!.currentRun()!.target!;
    await until(() => actor!.timeline.turnsById[approvalTarget.turnId], "approval turn projection");
    expect((await change("fast", approvalTarget)).currentRun.status).toBe("published");
    await actor.interrupt({ applicationOperationId: "stop-after-publication", deadlineAt: Date.now() + 10_000 });
    await until(() => actor!.timeline.runState === "idle", "stopped run");
    expect(provider.requestCount).toBe(requestsBeforeApproval + 1);
    await change("standard", null);
    await until(() => f.settings.find(f.scope, f.codexThreadId)?.effective?.serviceTier === "standard", "subagent initial defaults");
    // Drive real native subagents using only deterministic model responses.
    // Their requests inherit thread defaults independently of the parent's
    // active-run override, including an old default arriving during that run.
    const captures: Record<string, { tier: unknown; release(events: readonly MockResponseEvent[]): void }[]> = {};
    const finishedResponse = (id: string): MockResponseEvent[] => [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id,
        content: [{ type: "output_text", text: "Offline subagent complete" }] } },
      { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    const functionResponse = (id: string, name: string, args: object): MockResponseEvent[] => [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: id, name,
        ...(name === "spawn_agent" ? { namespace: "multi_agent_v1" } : {}), arguments: JSON.stringify(args) } },
      { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    provider.setResponder(async body => {
      const request = JSON.parse(body) as { input: { role?: string; content?: unknown }[]; service_tier?: string };
      const latestUser = JSON.stringify(request.input.filter(item => item.role === "user").at(-1));
      const kind = latestUser.includes("NATIVE_SPEED_CHILD_ONE") ? "one" : latestUser.includes("NATIVE_SPEED_CHILD_TWO") ? "two" : "parent";
      return await new Promise(resolve => {
        (captures[kind] ??= []).push({ tier: request.service_tier ?? "omitted", release: resolve });
        releases.push(() => resolve(finishedResponse(`cleanup-${kind}`)));
      });
    });
    await submit("subagent-inheritance", "NATIVE_SPEED_PARENT: explicitly spawn two subagents for the offline inheritance test.");
    await until(() => captures.parent?.[0], "parent inference");
    const parentTarget = sessions.controller(f.scope, f.codexThreadId)!.currentRun()!.target!;
    await until(() => actor!.timeline.turnsById[parentTarget.turnId], "parent projected target");
    await change("fast", parentTarget);
    captures.parent![0]!.release(functionResponse("spawn-one", "spawn_agent", { message: "NATIVE_SPEED_CHILD_ONE", fork_context: false }));
    await until(() => captures.one?.[0] && captures.parent?.[1], "first child and parent continuation");
    expect(captures.one![0]!.tier).toBe("omitted");
    expect(captures.parent![1]!.tier).toBe("priority");
    await change("ultrafast", parentTarget);
    captures.one![0]!.release(functionResponse("child-step", "offline_nonexistent_tool", {}));
    await until(() => captures.one?.[1], "already-running child continuation");
    expect(captures.one![1]!.tier).toBe("omitted");
    captures.one![1]!.release(finishedResponse("child-one-complete"));
    let childDefaultApplied = false;
    const stopChildDefaultObserver = supervisor.client.subscribeNotifications(notification => {
      if (notification.kind !== "decoded_notification" || notification.method !== "thread/settings/updated") return;
      const value = notification.params as { threadId: string; threadSettings: { serviceTier: string | null } };
      if (value.threadId === created.backendConversationId && value.threadSettings.serviceTier === "priority") childDefaultApplied = true;
    });
    try {
      await supervisor.client.request(codexThreadSettingsUpdateMethod, { threadId: created.backendConversationId, serviceTier: "priority" }, { timeoutMilliseconds: 10_000 });
      await until(() => childDefaultApplied, "later child default applied notification");
    } finally { stopChildDefaultObserver(); }
    captures.parent![1]!.release(functionResponse("spawn-two", "spawn_agent", { message: "NATIVE_SPEED_CHILD_TWO", fork_context: false }));
    await until(() => captures.two?.[0] && captures.parent?.[2], "later child and parent continuation");
    expect(captures.two![0]!.tier).toBe("priority");
    expect(captures.parent![2]!.tier).toBe("ultrafast");
    provider.setResponder(undefined);
    captures.two![0]!.release(finishedResponse("child-two-complete"));
    captures.parent![2]!.release(finishedResponse("parent-complete"));
    await until(() => actor!.timeline.runState === "idle", "subagent parent completion");
    await until(() => f.settings.find(f.scope, f.codexThreadId)?.effective?.serviceTier === "ultrafast", "post-run saved default convergence");
    // Paused Goals converge before Resume, which uses the confirmed native default.
    const refreshGoal = () => goals.refresh({ scope: f.scope, applicationThreadId: f.codexThreadId,
      nativeThreadId: created.backendConversationId, connectionGeneration: supervisor!.client.lifecycleSnapshot().generation,
      client: supervisor!.client });
    const goalAction = (actionId: "resume" | "pause" | "clear") => actor!.mutateProviderFeature({
      featureId: "codex.goal", schemaVersion: 1, actionId, arguments: {},
    });
    await supervisor.client.request(codexThreadGoalSetMethod, { threadId: created.backendConversationId,
      origin: "user", objective: "Offline paused Goal", status: "paused" }, { timeoutMilliseconds: 10_000 });
    expect((await refreshGoal()).state).toMatchObject({ state: "set", status: "paused" });
    await change("fast", null);
    await until(() => f.settings.find(f.scope, f.codexThreadId)?.effective?.serviceTier === "fast", "paused Goal convergence");
    const beforeGoalResume = provider.requestCount;
    const releaseResumedGoal = provider.hold(finishedResponse("resumed-goal")); releases.push(releaseResumedGoal);
    expect(await goalAction("resume")).toMatchObject({ outcome: "accepted" });
    await until(() => provider.requestCount > beforeGoalResume, "resumed Goal inference");
    expect(JSON.parse(provider.requestBodies[beforeGoalResume]!).service_tier).toBe("priority");
    expect(sessions.controller(f.scope, f.codexThreadId)!.currentRun()?.target).toBeNull();
    expect(await goalAction("pause")).toMatchObject({ outcome: "accepted" });
    releaseResumedGoal();
    await until(() => actor!.timeline.runState === "idle", "resumed Goal completion");
    expect(await goalAction("clear")).toMatchObject({ outcome: "accepted" });
    // A model-created Goal does not revoke the current Sedes run's target.
    // Its later native continuation inherits the earlier native default.
    const beforeModelGoal = provider.requestCount;
    const releaseGoalCreation = provider.hold(functionResponse("model-create-goal", "create_goal", { objective: "Complete the offline qualification" }));
    const releaseGoalRoot = provider.hold(finishedResponse("goal-root"));
    const releaseGoalContinuation = provider.hold(finishedResponse("goal-continuation"));
    releases.push(releaseGoalCreation, releaseGoalRoot, releaseGoalContinuation);
    await submit("model-created-goal", "Explicitly create a Goal to complete the offline qualification.");
    await until(() => provider.requestCount > beforeModelGoal, "model Goal root inference");
    const goalRootTarget = sessions.controller(f.scope, f.codexThreadId)!.currentRun()!.target!;
    await until(() => actor!.timeline.turnsById[goalRootTarget.turnId], "model Goal root projection");
    expect((await change("ultrafast", goalRootTarget)).currentRun.status).toBe("published");
    releaseGoalCreation();
    await until(() => provider.requestCount > beforeModelGoal + 1, "model-created Goal follow-up");
    expect((await refreshGoal()).state).toMatchObject({ state: "set", status: "active" });
    expect(sessions.controller(f.scope, f.codexThreadId)!.currentRun()?.target).toEqual(goalRootTarget);
    expect(JSON.parse(provider.requestBodies[beforeModelGoal + 1]!).service_tier).toBe("ultrafast");
    expect((await change("ultrafast", goalRootTarget)).currentRun.status).toBe("published");
    releaseGoalRoot();
    await until(() => provider.requestCount > beforeModelGoal + 2, "native Goal continuation");
    expect(JSON.parse(provider.requestBodies[beforeModelGoal + 2]!).service_tier).toBe("priority");
    expect(await goalAction("pause")).toMatchObject({ outcome: "accepted" });
    releaseGoalContinuation();
    await until(() => actor!.timeline.runState === "idle", "paused native continuation completion");
    await until(() => f.settings.find(f.scope, f.codexThreadId)?.effective?.serviceTier === "ultrafast", "post-Goal saved default convergence");
    expect(await goalAction("clear")).toMatchObject({ outcome: "accepted" });
    // The override belongs only to the Sedes-created thread in this daemon.
    const options = { timeoutMilliseconds: 10_000 };
    const featureEnabled = async (threadId: string) => {
      let cursor: string | undefined;
      do {
        const page = await supervisor!.client.request(codexExperimentalFeatureListMethod, { threadId, limit: 100, ...(cursor ? { cursor } : {}) }, options);
        const feature = page.data.find(item => item.name === "step_model_switching");
        if (feature) return feature.enabled;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      throw new Error("missing_native_step_flag");
    };
    expect(await featureEnabled(created.backendConversationId)).toBe(true);
    const unrelatedAppId = bindings.createUnboundThread(f.scope, { id: "external-thread", workspaceId: f.workspace.id,
      connectionProfileId: connection.id, title: "External native thread", now: Date.now() }).id;
    f.settings.initialize(f.scope, { applicationThreadId: unrelatedAppId,
      desired: f.settings.find(f.scope, f.codexThreadId)!.desired, now: Date.now() });
    const unrelated = await supervisor.client.request(codexThreadStartMethod, { cwd: workspacePath, model: model.slug,
      sandbox: "read-only", approvalPolicy: "on-request", ephemeral: false }, { ...options,
      runtimeCorrelation: { kind: "create", applicationThreadId: unrelatedAppId, applicationOperationId: "external-native-create" },
    });
    expect(await featureEnabled(unrelated.thread.id)).toBe(false);
    let unrelatedComplete = false;
    const stopUnrelatedObserver = supervisor.client.subscribeNotifications(notification => {
      if (notification.kind === "decoded_notification" && notification.method === "turn/completed" &&
          (notification.params as { threadId?: string }).threadId === unrelated.thread.id) unrelatedComplete = true;
    });
    try {
      await supervisor.client.request(codexTurnStartMethod, { threadId: unrelated.thread.id,
        input: [{ type: "text", text: "Persist this external native fixture.", text_elements: [] }], serviceTier: "default" },
      { ...options, runtimeCorrelation: { kind: "start", applicationThreadId: unrelatedAppId, applicationOperationId: "external-native-start" } });
      await until(() => unrelatedComplete, "external thread persistence");
    } finally { stopUnrelatedObserver(); }
    // Resuming a loaded native session does not retroactively apply config.
    await supervisor.client.request(codexThreadResumeMethod, { threadId: unrelated.thread.id,
      config: { "features.step_model_switching": true }, excludeTurns: true }, options);
    expect(await featureEnabled(unrelated.thread.id)).toBe(false);
    // The application never supplies the override for imported provenance.
    bindings.bindDiscoveredConversation(f.scope, unrelatedAppId, { backendConversationId: unrelated.thread.id, now: Date.now() });
    // Warm persistent-sidecar reattachment correctly reuses retained settings
    // without resuming. Drop that subscription to exercise a real imported resume.
    expect(await supervisor.client.request(codexThreadUnsubscribeMethod, { threadId: unrelated.thread.id }, options))
      .toEqual({ status: "unsubscribed" });
    const beforeExternalAttach = requestSpy.mock.calls.length;
    const imported = await driver.attach({ scope: f.scope, workspace,
      opaqueBindingDetail: serializeCodexBindingDetail({ threadId: unrelated.thread.id, sessionId: unrelated.thread.sessionId,
        correlationAncestorThreadIds: [], nativeAncestry: null }),
      binding: { ...binding, applicationThreadId: unrelatedAppId, backendConversationId: unrelated.thread.id } });
    try {
      await imported.establishProjection({ signal: new AbortController().signal });
      const importedResumes = requestSpy.mock.calls.slice(beforeExternalAttach)
        .filter(([method, params]) => method.method === "thread/resume" && (params as { threadId?: string }).threadId === unrelated.thread.id);
      expect(importedResumes.length).toBeGreaterThan(0);
      expect(importedResumes
        .every(([, params]) => (params as { config?: Record<string, unknown> }).config?.["features.step_model_switching"] !== true)).toBe(true);
      expect(await featureEnabled(unrelated.thread.id)).toBe(false);
    } finally { await imported.close(); }
    // Untracked mutation probes are intentionally forbidden by the sidecar's
    // durable receipt contract. Its disabled flag is verified above instead.
    if (topology !== "sidecar") await expect(supervisor.client.request(codexTurnSettingsUpdateMethod, { threadId: unrelated.thread.id,
      turnId: "not-running", serviceTier: "priority" }, options)).rejects.toMatchObject({ code: -32600, message: expect.stringContaining("step_model_switching") });
    expect(warnings.some(value => JSON.stringify(value).includes("step_model_switching"))).toBe(true);
    // The real Sedes fork path carries the override into a new native session.
    const childId = bindings.createUnboundThread(f.scope, { id: "fork-child", workspaceId: f.workspace.id,
      connectionProfileId: connection.id, title: "Offline fork", now: Date.now() }).id;
    f.settings.initialize(f.scope, { applicationThreadId: childId, desired: f.settings.find(f.scope, f.codexThreadId)!.desired, now: Date.now() });
    const checkpoint = await driver.resolveBranchCheckpoint({ scope: f.scope, binding, workspace,
      opaqueBindingDetail: created.opaqueBindingDetail, selection: { kind: "latest_provider_snapshot" } });
    const forked = await driver.branchConversation({ scope: f.scope, childApplicationThreadId: childId,
      applicationOperationId: "native-fork", sourceBinding: binding, sourceOpaqueBindingDetail: created.opaqueBindingDetail,
      workspace, sourceCheckpoint: checkpoint, source: { kind: "user" }, creationCorrelation: "native_speed_fork" });
    expect(await featureEnabled(forked.backendConversationId)).toBe(true);
    expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(config);
    await expect(access(path.join(workspacePath, "command-must-not-run"))).rejects.toThrow();
    if (topology === "sidecar") {
      const frames = (await readFile(ingressPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const speedFrames = frames.filter(frame => frame.method === "turn/settings/update");
      expect(speedFrames.slice(0, 3).map(frame => frame.params)).toEqual(["priority", "default", "ultrafast"].map(serviceTier => ({
        threadId: created.backendConversationId, turnId: speedFrames[0].params.turnId, serviceTier,
      })));
      expect(speedFrames.map(frame => frame.params)).toEqual(requestSpy.mock.calls
        .filter(([method]) => method.method === "turn/settings/update").map(([, params]) => params));
      // Retire the real carrier, then submit the former controller's command
      // through its replacement. Host admission must reject it before native IO.
      await actor.close(); actor = undefined;
      await supervisor.close(); supervisor = undefined;
      await attachment!.session.close("replace_controller_for_qualification");
      attachment = await sidecar!.attach();
      expect(String(attachment.status.controllerEpoch)).not.toBe(sidecarAuthority!.controllerId);
      const replacement = new CodexSidecarRuntimeConnection(attachment.session.runtimeChannel);
      await expect(replacement.inspect({ ...sidecarAuthority!, controllerId: String(attachment.status.controllerEpoch) }))
        .resolves.toMatchObject({ incarnation: expect.any(String) });
      const before = await readFile(ingressPath, "utf8");
      // Internal admission reasons are intentionally sanitized at the sidecar
      // protocol boundary; the valid replacement and zero native frames prove
      // that this is rejection of the former controller before native IO.
      await expect(replacement.submit(sidecarAuthority!, { operationId: "stale-speed-controller", generation: 1,
        method: "turn/settings/update", params: { threadId: created.backendConversationId, turnId: target.turnId, serviceTier: "priority" },
        timeoutMilliseconds: 10_000 })).rejects.toMatchObject({ code: "sidecar_operation_failed", retryable: false });
      expect(await readFile(ingressPath, "utf8")).toBe(before);
      process.stdout.write(`Offline Speed scenario: ${JSON.stringify({ topology, scenario: "framed-order-and-stale-controller", status: "passed",
        firstPublishedTiers: speedFrames.slice(0, 3).map(frame => frame.params.serviceTier), staleControllerNativeFrames: 0 })}\n`);
    }
    process.stdout.write(`Offline Speed result: ${JSON.stringify({ topology, statuses,
      modelRequests: provider.requestCount, serviceTiers: provider.requestBodies.map(body => JSON.parse(body).service_tier ?? "omitted"),
      subagents: { firstChildInitialTier: captures.one![0]!.tier, firstChildNextStepTier: captures.one![1]!.tier,
        laterChildInitialTier: captures.two![0]!.tier, parentAfterFirstSpawnTier: captures.parent![1]!.tier,
        parentAfterSecondSpawnTier: captures.parent![2]!.tier },
      replayNativePublications: 0, completedTargetNativePublications: 0,
      liveProviderVerified: false })}\n`);
  } catch (error) {
    process.stderr.write(`Offline native Speed failure (${topology}): ${String(error)}\n`);
    process.stderr.write(JSON.stringify(provider.requestBodies.slice(-5).map(body => {
      const value = JSON.parse(body);
      return { tier: value.service_tier, inputs: value.input?.length, lastTypes: value.input?.slice(-2).map((item: { type: string }) => item.type) };
    })).slice(-6000) + "\n");
    throw error;
  } finally {
    provider.setResponder(undefined);
    for (const release of releases) release();
    await actor?.close(); await supervisor?.close();
    await attachment?.session.close("offline_speed_complete"); await sidecar?.close();
    if (external && external.exitCode === null) { const exited = once(external, "exit"); external.kill("SIGTERM"); await exited; }
    await provider.close(); await rm(root, { recursive: true, force: true });
  }
}, nativeTimeout);

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "codex-primary",
      kind: "codex_app_server",
      label: "Codex",
      enabled: true,
      modelPolicy: { type: "catalog" },
      moduleConfiguration: {
        connection: { ownership: "owned", channel: { type: "process_stdio", executablePath: "/usr/bin/false", workingDirectory: "/tmp", codexHome: "/tmp/codex-fixture-home" } },
        policy: { allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"], allowedNetworkAccess: ["disabled", "enabled"], allowedApprovalPolicies: ["untrusted", "on-request", "never"], allowedApprovalReviewers: ["user", "auto_review"] },
      },
    },
  ],
  targets: [
    {
      id: "codex-local",
      kind: "codex_app_server",
      label: "Local Codex",
      backendInstanceId: "codex-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
      moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user", model: { type: "catalogDefault" } } },
    },
  ],
  defaultTargetId: "codex-local",
});

const databases: Database.Database[] = [];
const catalogModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "model_effort",
);
const readOnlyPolicy = {
  sandboxMode: "read-only",
  networkAccess: "disabled",
  approvalPolicy: "never",
  approvalReviewer: "user",
} as const;
const executionPolicy = {
  allowedSandboxModes: [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ] as const,
  allowedNetworkAccess: ["disabled", "enabled"] as const,
  allowedApprovalPolicies: ["untrusted", "on-request", "never"] as const,
  allowedApprovalReviewers: ["user", "auto_review"] as const,
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(
  workspacePath: string,
  input: {
    readonly desiredSettingsChanged: (scope: RequestScope, applicationThreadId: string) => void;
    readonly fastModeRuntime: CodexFastModeSessionRegistry;
  },
) {
  const database = openOverlayDatabase(":memory:", { migrate: false });
  initializeEmptyBackendNormalizedDatabase(database);
  databases.push(database);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const configurations = new BackendConfigurationRepository(database);
  importLegacyDatabaseConfigurationFixture(database, { configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "codex-persistence-fixture" }, 210);

  new InventoryRepository(database).updateEnvironmentAvailability(scope, configuration.executionEnvironments[0]!.id, { available: true, now: 210 });
  const workspace = new InventoryRepository(database).upsertWorkspace(scope, {
    environmentId: configuration.executionEnvironments[0]!.id, canonicalPath: workspacePath,
    displayName: "Offline Speed", available: true, trustState: "trusted",
    environmentConfigurationRevision: 1, now: 211, project: { kind: "new", name: "Speed qualification" },
  });
  const profiles = configurations.listProfiles(scope);
  const codexProfile = profiles.find(
    ({ templateId }) => templateId === "codex-local",
  )!;
  const bindings = new ConversationBindingRepository(database);
  const settings = new CodexThreadExecutionSettingsRepository(database);
  const featureMutations = new ProviderFeatureMutationRepository(database);
  const createUnbound = (id: string, connectionProfileId: string) =>
    bindings.createUnboundThread(scope, {
      id,
      workspaceId: workspace.id,
      connectionProfileId,
      title: `Initial ${id}`,
      now: 300,
    });
  const codexThreadId = createUnbound("codex-thread", codexProfile.id).id;
  settings.initialize(scope, {
    applicationThreadId: codexThreadId,
    desired: {
          model: "gpt-5.6-codex",
          reasoningEffort: "low",
          serviceTier: "standard",
          ...readOnlyPolicy,
        },
    now: 320,
  });
  return {
    database,
    scope,
    codexProfile,
    configurations,
    workspace,
    inventory: new InventoryRepository(database),
    codexThreadId,
    persistence: new CodexThreadActionPersistence({
      desiredSettingsChanged: input.desiredSettingsChanged ?? (() => undefined),
      database,
      scope,
      backendInstanceId: "codex-primary",
      settings,
      featureMutations,
      executionPolicy,
      modelPolicy: catalogModelPolicy,
      defaultExecutionPolicyByConnectionId: new Map([
        [codexProfile.id, readOnlyPolicy],
      ]),
      ...(input.fastModeRuntime
        ? { fastModeRuntime: input.fastModeRuntime }
        : {}),
    }),
    settings,
    featureMutations,
  };
}
