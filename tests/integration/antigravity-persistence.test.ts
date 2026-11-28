import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ThreadMutationGateway } from "../../src/server/conversations/thread-mutation-gateway.js";
import { AntigravityArchiveReceipts } from "../../src/server/backends/antigravity/archive-receipts.js";
import type { AntigravityArchiveOperation, AntigravityCommand, AntigravitySetup } from "../../src/server/backends/antigravity/port.js";
import { antigravityAdministration } from "../../src/server/backends/antigravity/runtime-administration.js";
import { DEFAULT_QUEUE_RETRY_POLICY, QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import type { AntigravityAttachment, AntigravityInspection, AntigravityPort } from "../../src/server/backends/antigravity/port.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { threadAgentToolPolicyRepository } from "../support/thread-agent-tool-policy.js";
import { AntigravityActionPersistence } from "../../src/server/backends/antigravity/action-persistence.js";
import { serializeAntigravityBinding } from "../../src/server/backends/antigravity/binding.js";
import { AntigravityModeCatalog } from "../../src/server/backends/antigravity/mode-catalog.js";
import { ANTIGRAVITY_MODE_FEATURE_REF } from "../../src/server/backends/antigravity/mode-feature.js";
import { encodeAntigravityModelSetting } from "../../src/server/backends/antigravity/model-selection.js";
import { AntigravitySavedAgentAdapter } from "../../src/server/backends/antigravity/saved-agent-adapter.js";
import { AntigravityThreadPersistence } from "../../src/server/backends/antigravity/thread-persistence.js";
import { AntigravityThreadPresentation } from "../../src/server/backends/antigravity/thread-presentation.js";
import { AntigravityThreadRepository } from "../../src/server/backends/antigravity/thread-repository.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { settleArchiveSnapshot } from "../../src/server/conversations/archive-snapshot-settlement.js";
import { AntigravityDriver } from "../../src/server/backends/antigravity/driver.js";
import { AntigravityHost } from "../../src/server/backends/antigravity/host/native-host.js";
import { buildAntigravityPrompt } from "../../src/server/backends/antigravity/submission.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { ThreadArchiveObligationRepository } from "../../src/server/db/repositories/thread-archive-obligation-repository.js";
import { QuestionRequestRepository } from "../../src/server/db/repositories/question-request-repository.js";
import type { AntigravityHistory } from "../../src/server/backends/antigravity/port.js";
import type { BackendCatalog, PrepareConversationArchiveInput } from "../../src/server/backends/contracts.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { ConversationCreationTransaction, type ResolvedSavedAgentBackendConfiguration } from "../../src/server/backends/saved-agent-adapter.js";
import { SavedAgentBackendAdapterRegistry } from "../../src/server/backends/saved-agent-adapter-registry.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import { SavedAgentService } from "../../src/server/domain/saved-agent-service.js";
import type { NormalizedAgentConfigurationOverrides } from "../../src/shared/protocol/saved-agents.js";
import { savedAgentDatabase, insertPreRootGrantWorkspace } from "../support/saved-agent-fixture.js";

function antigravityConnection({ database, scope }: ReturnType<typeof savedAgentDatabase>,
  releases = compiledBackendModuleCatalog.protocolReleases()) {
  const profiles = new BackendConfigurationRepository(database);
  const environmentId = profiles.listProfiles(scope)[0]!.executionEnvironmentId;
  const configuration = new ConfigurationRepository(database, () => 220);
  const projection = new ConfigurationProjection(database, releases, () => 220);
  const current = configuration.get(scope);
  configuration.save(scope, { mutationId: randomUUID(), expectedRevision: current.revision, configuration: {
    ...current.configuration,
    backends: [...current.configuration.backends, { id: "ag", label: "Antigravity", kind: "antigravity", enabled: true,
      modelPolicy: { type: "catalog" }, moduleConfiguration: { initializationTimeoutMs: 30_000 } }],
    targets: [...current.configuration.targets, { id: "ag-default", label: "Antigravity", kind: "antigravity_acp", enabled: true,
      backendInstanceId: "ag", executionEnvironmentId: environmentId, moduleConfiguration: { defaults: {} } }],
  } }, document => projection.project(scope, document));
  const row = profiles.listProfiles(scope).find(profile => profile.kind === "antigravity_acp")!;
  return { ...row, enabled: row.enabled === 1 };
}

describe("Antigravity persistence", () => {
  it("reconciles an existing 1.5.14 backend to the qualified release once while retaining its target", () => {
    const { database, scope } = savedAgentDatabase();
    try {
      const releases = compiledBackendModuleCatalog.protocolReleases();
      const connection = antigravityConnection({ database, scope }, { ...releases, antigravity: "1.5.14" });
      const profiles = new BackendConfigurationRepository(database);
      const backend = profiles.getBackend(scope, connection.backendInstanceId);
      const target = profiles.getProfileByTemplate(scope, "ag-default");
      expect(backend.protocolRelease).toBe("1.5.14");

      const saved = new ConfigurationRepository(database).get(scope);
      const projection = new ConfigurationProjection(database, releases);
      for (let startup = 0; startup < 2; startup++) {
        database.transaction(() => projection.project(scope, saved.configuration))();
        expect(profiles.getBackend(scope, connection.backendInstanceId)).toEqual({
          ...backend, protocolRelease: "1.5.18", configurationRevision: backend.configurationRevision + 1,
        });
        expect(profiles.getProfileByTemplate(scope, "ag-default")).toEqual(target);
      }
    } finally { database.close(); }
  });

  function renameGatewayFixture(backingState: "unbound" | "bound" | "creating" | "creation_unknown", cwd = "/tmp/rename-gateway") {
    const { database, scope } = savedAgentDatabase();
    const connection = antigravityConnection({ database, scope });
    const inventory = new InventoryRepository(database);
    const workspace = inventory.upsertWorkspace(scope, {
      environmentId: connection.executionEnvironmentId, canonicalPath: cwd, displayName: "Project",
      project: { kind: "new", name: "Project" }, available: true, trustState: "trusted", environmentConfigurationRevision: 0, now: 230,
    });
    const bindings = new ConversationBindingRepository(database);
    const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId: connection.id, title: "Original", now: 230 });
    const settings = new AntigravityThreadRepository(database);
    settings.initialize(scope, thread.id, connection, { modelId: null, thinkingLevel: null, modeId: null }, 230);
    if (backingState === "bound") bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: randomUUID(), now: 240 });
    else database.prepare("UPDATE application_threads SET backing_state = ? WHERE id = ?").run(backingState, thread.id);
    const action = new AntigravityActionPersistence(settings, scope, "ag", compileBackendModelPolicy({ type: "catalog" }, "model_effort"));
    const persistImplementation = action.persistLocalRename.bind(action);
    const persist = vi.spyOn(action, "persistLocalRename");
    const operations = new ConversationOperationRepository(database);
    const prepare = vi.spyOn(operations, "prepareBackendAction");
    const acquire = vi.fn(async () => { throw new Error("Local rename must not acquire a provider runtime"); });
    const gateway = new ThreadMutationGateway({
      actors: {} as never, bindings, inventory, operations, completions: { database } as never,
      lifecycle: {} as never, forks: {} as never, queue: {} as never, queueGateway: {} as never,
      runtimes: { acquire } as never, interactions: {} as never, presentation: {} as never,
      agentToolPolicies: threadAgentToolPolicyRepository(database), actionPersistence: new Map([["ag", action]]),
      publishThreadSnapshot: vi.fn(async () => {}), now: () => 250,
    });
    const request = { kind: "perform" as const, mutationId: randomUUID(), expectedThreadRevision: settings.target(scope, thread.id).revision,
      operation: { action: "rename" as const, title: "Local name" } };
    return { database, scope, thread, workspace, settings, inventory, gateway, operations, action, persist, persistImplementation, prepare, acquire, request };
  }

  it.each(["archive retry", "ordinary open and restart"] as const)("settles a detached native host prompt in SQLite before its ACK and recovers a lost ACK reply through %s", async recovery => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sedes-antigravity-archive-")));
    const f = renameGatewayFixture("bound", cwd);
    const bindings = new ConversationBindingRepository(f.database);
    const binding = bindings.getBinding(f.scope, f.thread.id)!;
    const profiles = new BackendConfigurationRepository(f.database);
    const connection = profiles.getProfile(f.scope, binding.connectionProfileId);
    const instance = profiles.getBackend(f.scope, binding.backendInstanceId);
    const identity = { sessionId: binding.backendConversationId, cwd };
    const executablePath = path.join(cwd, "agy");
    const channels = new LocalEnvironmentChannelProvider({ scope: f.scope, executionEnvironmentId: connection.executionEnvironmentId, environment: process.env });
    const native: AntigravityHistory["native"] = { revision: "a".repeat(64), executions: [], steps: [] };
    const host = new AntigravityHost({ configuration: { ...f.scope, backendInstanceId: instance.id, executionEnvironmentId: connection.executionEnvironmentId,
      executablePath, initializationTimeoutMs: 5000 }, channels, environment: process.env,
      history: { read: async requested => ({ ...requested, native }), forget: async () => {}, close: async () => {} } });
    const key = Buffer.alloc(32, 7);
    const obligations = new ThreadArchiveObligationRepository(f.database);
    const completion = new SubmissionCompletionRepository(f.database);
    const questions = new QuestionRequestRepository(f.database, f.inventory);
    const settle = (snapshot: Parameters<PrepareConversationArchiveInput["settle"]>[0], ids: readonly string[]) =>
      settleArchiveSnapshot({ bindings, completion, questions, usage: { registerVisibleTurns() {} },
        recordSubmission() {}, settleAutomation() {} }, f.scope, f.thread.id, snapshot, ids);
    const driver = new AntigravityDriver({ scope: f.scope, instance: { ...instance, enabled: true }, connection: { ...connection, enabled: true },
      settings: f.settings, port: host, correlationKey: key, nativeNamespaceKey: "test-profile", modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
      archiveObserver: { retained: () => obligations.read(f.scope, f.thread.id)?.retainedOwner,
        settle: (_thread, _owner, snapshot, ids) => settle(snapshot, ids),
        release: (thread, owner) => { expect(obligations.settleIfRetained(f.scope, thread, owner)).toBe(true); } },
      archiveReceipts: new AntigravityArchiveReceipts(f.database, f.action) });
    try {
      await copyFile(new URL("../fixtures/antigravity/fake-antigravity-acp-peer.mjs", import.meta.url), executablePath);
      await chmod(executablePath, 0o755);
      const attached = await host.attach(identity);
      const id = randomUUID();
      const detail = driver.nativeBinding(identity.sessionId, cwd);
      const prompt = await buildAntigravityPrompt({ binding: detail, key }, { applicationOperationId: id, mutationId: id,
        reconciliationToken: id, source: { kind: "user" }, text: "Archive this run", contextExcerpts: [], taskContexts: [], attachments: [] });
      if (prompt[0]?.type !== "text") throw new Error("missing fixture prompt");
      await host.request({ handleId: attached.handleId, operationId: id, command: { type: "prompt", prompt } });
      await vi.waitFor(async () => expect(await host.outcome({ handleId: attached.handleId, operationId: id })).toMatchObject({ status: "completed" }));
      native.steps.push(
        { index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: prompt[0].text }, executionId: "execution" },
        { index: 1, type: 15, status: 3, hasSubtrajectory: false, response: { text: "Archived answer", thinking: "", stopReason: 2, toolCalls: [] }, executionId: "execution" });
      native.revision = "b".repeat(64);
      host.detach();
      completion.recordAccepted(f.scope, f.thread.id, { operationId: id, backendCorrelation: id, acceptedAt: 245 });
      const savedOwner = () => obligations.read(f.scope, f.thread.id)?.retainedOwner ?? undefined;
      const input: PrepareConversationArchiveInput = { scope: f.scope, workspace: { canonicalPath: cwd, authorityRevision: 0, summary: {
        id: f.workspace.id, displayName: "Project", displayPath: cwd, availability: "available", trustState: "trusted", revision: 0, environmentId: connection.executionEnvironmentId } },
        binding: { ...binding, createdAt: new Date(binding.createdAt).toISOString() }, opaqueBindingDetail: serializeAntigravityBinding(detail),
        signal: AbortSignal.timeout(8000), get retainedOwner() { return savedOwner(); }, markObserved() { obligations.remember(f.scope, f.thread.id); },
        markRetained(owner) { obligations.markRetained(f.scope, f.thread.id, owner); }, markSettled(owner) { obligations.markSettled(f.scope, f.thread.id, owner); },
        async settle(snapshot, ids) { settle(snapshot, ids); } };
      const ack = host.acknowledgeOperation.bind(host);
      const lost = vi.spyOn(host, "acknowledgeOperation").mockImplementationOnce(async (...args) => {
        expect(completion.get(f.scope, f.thread.id, id)).toMatchObject({ completionOutcome: "completed", assistantResult: { text: "Archived answer" }, attentionCreatedAt: null });
        await ack(...args);
        throw new Error("ACK reply lost");
      });
      const attach = vi.spyOn(host, "attach");
      const dispatch = vi.spyOn(host, "request");
      expect((await driver.prepareArchive(input)).outcome).toBe("inconclusive");
      expect(savedOwner()).toEqual(expect.any(String));
      expect(lost).toHaveBeenCalledTimes(1);
      if (recovery === "ordinary open and restart") {
        const ordinary = await driver.attach(input);
        expect(savedOwner()).toBeUndefined();
        await ordinary.close(); await host.close();
        native.revision = "c".repeat(64);
        const restarted = new AntigravityHost(host.input);
        const afterRestart = new AntigravityDriver({ ...driver.input, port: restarted });
        try { await expect(afterRestart.prepareArchive(input)).resolves.toEqual({ outcome: "released" }); }
        finally { await afterRestart.close(); await restarted.close(); }
      } else {
        await expect(driver.prepareArchive(input)).resolves.toEqual({ outcome: "released" });
        expect(await host.probeArchiveOwner(identity)).toBeNull();
      }
      expect(savedOwner()).toBeUndefined();
      // The receipt ACK reached the host, while its retained operation event
      // still needed the same committed disposition on the second request.
      expect(lost).toHaveBeenCalledTimes(2);
      expect(completion.get(f.scope, f.thread.id, id)).toMatchObject({ completionOutcome: "completed", assistantResult: { text: "Archived answer" }, attentionCreatedAt: null });
      expect(attach).toHaveBeenCalledTimes(recovery === "ordinary open and restart" ? 1 : 0); expect(dispatch).not.toHaveBeenCalled();
    } finally { await driver.close(); await host.close(); channels.close(); f.database.close(); await rm(cwd, { recursive: true, force: true }); }
  });

  it("requires exact durable dispositions for all six retained archive receipt kinds and replays committed results", () => {
    const f = renameGatewayFixture("bound");
    try {
      const binding = new ConversationBindingRepository(f.database).getBinding(f.scope, f.thread.id)!;
      const target = { scope: f.scope, binding: { ...binding, createdAt: new Date(binding.createdAt).toISOString() }, opaqueBindingDetail: "bound detail" };
      const store = new AntigravityArchiveReceipts(f.database, f.action);
      const complete = { status: "completed" as const, result: {} };
      const proof = (operationId: string, cmd: AntigravityCommand): AntigravityArchiveOperation => ({ operationId, originOwner: "original", kind: cmd.type,
        commandFingerprint: createHash("sha256").update(JSON.stringify(cmd)).digest("hex"),
        setterConfirmed: cmd.type === "set_config" || cmd.type === "set_mode", sessionConfiguration: "origin" in cmd && cmd.origin === "session_configuration" });
      const setup: AntigravitySetup = { initialize: { protocolVersion: 1 }, session: { configOptions: [
        { id: "model", name: "Model", type: "select", category: "model", currentValue: "model", options: [{ value: "model", name: "Model" }] },
        { id: "think", name: "Reasoning", type: "select", category: "thought_level", currentValue: "low", options: [{ value: "low", name: "Low" }] },
      ] } };
      const completions = new SubmissionCompletionRepository(f.database);
      for (const type of ["prompt", "steer"] as const) {
        const id = randomUUID(), retained = proof(id, { type, prompt: [] });
        completions.recordAccepted(f.scope, f.thread.id, { operationId: id, backendCorrelation: id, acceptedAt: 245 });
        expect(store.apply(target, retained, complete, true, setup)).toBe(false);
        completions.observeCompletion(f.scope, f.thread.id, id, { completionIdentity: id, createAttention: false, observedAt: 250,
          finalized: { applicationTurnId: randomUUID(), outcome: "completed", result: { text: "Done" }, classifiedResult: null } });
        expect(store.apply(target, retained, complete, false, setup)).toBe(false);
        expect(store.apply(target, retained, complete, true, setup)).toBe(true);
      }
      // A signed terminal input plus the finalized application result settles a lost ACP reply.
      const uncertain = randomUUID(), uncertainInput = proof(uncertain, { type: "prompt", prompt: [] });
      const lostReply = { status: "failed" as const, failure: { code: "antigravity_process_closed", delivery: "sent_outcome_unknown" as const } };
      completions.recordAccepted(f.scope, f.thread.id, { operationId: uncertain, backendCorrelation: uncertain, acceptedAt: 245 });
      expect(store.apply(target, uncertainInput, lostReply, true, setup)).toBe(false);
      completions.observeCompletion(f.scope, f.thread.id, uncertain, { completionIdentity: uncertain, createAttention: false, observedAt: 250,
        finalized: { applicationTurnId: randomUUID(), outcome: "completed", result: { text: "Done" }, classifiedResult: null } });
      expect(store.apply(target, uncertainInput, lostReply, false, setup)).toBe(false);
      expect(store.apply(target, uncertainInput, lostReply, true, setup)).toBe(true);

      const stop = randomUUID();
      f.operations.prepareInterrupt(f.scope, f.thread.id, { operationId: stop, now: 250 });
      f.operations.markInterruptStarted(f.scope, stop);
      expect(store.apply(target, proof(stop, { type: "cancel" }), complete, false, setup)).toBe(true);
      expect(f.operations.findInterrupt(f.scope, stop)?.state).toBe("accepted");

      const permission = randomUUID();
      f.operations.prepareRecoverableInteractionResponse(f.scope, f.thread.id, { operationId: permission, interactionId: "pending",
        response: { kind: "cancel" }, backendResponse: { applicationOperationId: permission, interactionId: "native", kind: "cancel" }, now: 250 });
      f.operations.markInteractionResponseStarted(f.scope, permission);
      const response = { outcome: { outcome: "cancelled" as const } };
      expect(store.apply(target, proof(permission, { type: "permission", requestId: "elsewhere", response }), complete, false, setup)).toBe(false);
      expect(store.apply(target, proof(permission, { type: "permission", requestId: "native", response }), complete, false, setup)).toBe(true);
      expect(f.operations.findInteractionResponse(f.scope, permission)?.state).toBe("accepted");

      const setting = randomUUID();
      const request = { operation: { action: "set_setting" as const, settingId: "model" as const, value: encodeAntigravityModelSetting(binding.connectionProfileId, "model", "low") },
        mutationId: setting, expectedThreadRevision: f.settings.target(f.scope, f.thread.id).revision, expectedSettingsRevision: f.settings.get(f.scope, f.thread.id).revision, now: 250 };
      f.operations.prepareBackendAction(f.scope, f.thread.id, request); f.operations.markBackendActionStarted(f.scope, setting);
      expect(store.apply(target, proof(setting, { type: "set_config", origin: "thread_action", configId: "wrong", value: "model" }), complete, false, setup)).toBe(false);
      const setConfig = proof(setting, { type: "set_config", origin: "thread_action", configId: "model", value: "model" });
      expect(store.apply(target, setConfig, complete, false, setup)).toBe(true);
      expect(store.apply(target, setConfig, complete, false, setup)).toBe(true);
      expect(f.operations.findBackendAction(f.scope, setting)?.state).toBe("accepted");
      expect(f.settings.get(f.scope, f.thread.id)).toMatchObject({ modelId: "model", thinkingLevel: "low", revision: request.expectedSettingsRevision + 1 });

      const mode = proof(randomUUID(), { type: "set_mode", origin: "session_configuration", modeId: "plan" });
      expect(store.apply(target, { ...mode, setterConfirmed: false }, complete, false, setup)).toBe(false);
      expect(store.apply(target, mode, { status: "failed", failure: { code: "lost", delivery: "sent_outcome_unknown" } }, false, setup)).toBe(false);
      expect(store.apply(target, mode, complete, false, setup)).toBe(true);
      const count = f.database.prepare("SELECT COUNT(*) AS n FROM mutation_receipts WHERE operation_kind = 'antigravity_archive_receipt'").get();
      expect(count).toEqual({ n: 7 });

      const queue = new QueuedInputRepository(f.database);
      const queuedId = randomUUID();
      const queued = queue.enqueue(f.scope, f.thread.id, { mutationId: queuedId, text: "Try again", contextExcerpts: [], attachmentIds: [], taskReferences: [],
        source: { kind: "direct_input", resolvedDeliveryMode: "submit", expectedThreadRevision: f.settings.target(f.scope, f.thread.id).revision }, now: 300 });
      expect(queue.claimHead(f.scope, f.thread.id, "retry anchor", 301)?.id).toBe(queued.item.id);
      const before = Date.now();
      const failed = { status: "failed" as const, failure: { code: "transport", delivery: "not_sent" as const } };
      const attempt = proof(queuedId, { type: "prompt", prompt: [] });
      expect(store.apply(target, attempt, failed, false, setup)).toBe(true);
      const retry = queue.get(f.scope, f.thread.id, queued.item.id);
      expect(retry).toMatchObject({ state: "retry_wait", retryCount: 1 });
      expect(retry.nextAttemptAt).toBeGreaterThanOrEqual(before + DEFAULT_QUEUE_RETRY_POLICY.baseDelayMilliseconds);
      expect(store.apply(target, attempt, failed, false, setup)).toBe(true);
      expect(queue.get(f.scope, f.thread.id, queued.item.id)).toEqual(retry);

      const rejected = randomUUID();
      f.operations.prepareInterrupt(f.scope, f.thread.id, { operationId: rejected, now: 250 });
      f.operations.markInterruptStarted(f.scope, rejected);
      const rejection = { status: "failed" as const, failure: { code: "antigravity_request_rejected", delivery: "rejected" as const } };
      expect(store.apply(target, proof(rejected, { type: "cancel" }), rejection, false, setup)).toBe(true);
      expect(f.operations.findInterrupt(f.scope, rejected)).toBeUndefined();
      expect(store.apply(target, proof(rejected, { type: "cancel" }), rejection, false, setup)).toBe(true);
      const expired = randomUUID(), nativeRejection = randomUUID(), rejectedPermission = randomUUID();
      f.operations.prepareInterrupt(f.scope, f.thread.id, { operationId: expired, now: 251 });
      f.operations.markInterruptStarted(f.scope, expired); f.operations.expireInterrupts(f.scope, Number.MAX_SAFE_INTEGER, f.thread.id);
      expect(store.apply(target, proof(expired, { type: "cancel" }), lostReply, false, setup)).toBe(false);
      expect(store.apply(target, proof(expired, { type: "cancel" }), complete, false, setup)).toBe(true);
      f.operations.prepareInterrupt(f.scope, f.thread.id, { operationId: nativeRejection, now: 251 });
      f.operations.markInterruptStarted(f.scope, nativeRejection); f.operations.rejectInterruptProvenNotApplied(f.scope, nativeRejection);
      expect(store.apply(target, proof(nativeRejection, { type: "cancel" }), complete, false, setup)).toBe(false);
      expect(store.apply(target, proof(nativeRejection, { type: "cancel" }), rejection, false, setup)).toBe(true);
      f.operations.prepareRecoverableInteractionResponse(f.scope, f.thread.id, { operationId: rejectedPermission, interactionId: "pending2",
        response: { kind: "cancel" }, backendResponse: { applicationOperationId: rejectedPermission, interactionId: "right", kind: "cancel" }, now: 251 });
      f.operations.markInteractionResponseStarted(f.scope, rejectedPermission); f.operations.rejectInteractionResponseProvenNotApplied(f.scope, rejectedPermission);
      expect(store.apply(target, proof(rejectedPermission, { type: "permission", requestId: "wrong", response }), rejection, false, setup)).toBe(false);
      expect(store.apply(target, proof(rejectedPermission, { type: "permission", requestId: "right", response }), rejection, false, setup)).toBe(true);
      // The inheriting generation replays the original scoped application disposition.
      const inherited = { ...proof(rejectedPermission, { type: "permission", requestId: "right", response }), originOwner: "original" };
      expect(store.apply(target, inherited, rejection, false, setup)).toBe(true);

    } finally { f.database.close(); }
  });

  it("acknowledges only terminal retained operations with matching durable thread evidence before upgrade", async () => {
    const { database, scope } = savedAgentDatabase();
    try {
      const connection = antigravityConnection({ database, scope });
      const environment = connection.executionEnvironmentId;
      const instance = new BackendConfigurationRepository(database).getBackend(scope, connection.backendInstanceId);
      const workspace = new InventoryRepository(database).upsertWorkspace(scope, { environmentId: environment, canonicalPath: "/tmp/upgrade",
        displayName: "Project", project: { kind: "new", name: "Project" }, available: true, trustState: "trusted", environmentConfigurationRevision: 0, now: 230 });
      const bindings = new ConversationBindingRepository(database);
      const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId: connection.id, title: "Antigravity", now: 230 });
      const session = { sessionId: randomUUID(), cwd: workspace.canonicalPath, handleId: randomUUID(), generation: randomUUID(), closed: false };
      bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: session.sessionId, now: 240 });
      const settings = new AntigravityThreadRepository(database);
      const persistence = new AntigravityThreadPersistence({ scope, backendInstanceId: instance.id, settings,
        modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"), defaultsForConnection: () => ({}), nativeNamespaceKey: "test-profile" });
      persistence.saveBoundBindingDetail(scope, thread.id, serializeAntigravityBinding({ version: 1, ...scope, sessionId: session.sessionId,
        backendInstanceId: instance.id, connectionProfileId: connection.id, executionEnvironmentId: environment,
        canonicalWorkspacePath: workspace.canonicalPath, nativeNamespaceKey: "test-profile" }));
      const completion = new SubmissionCompletionRepository(database);
      for (const operationId of ["delivered", "pending", "uncertain", "accepted-without-completion"]) {
        completion.recordAccepted(scope, thread.id, { operationId, backendCorrelation: operationId, acceptedAt: 245 });
        if (operationId !== "accepted-without-completion") completion.observeCompletion(scope, thread.id, operationId, {
          completionIdentity: operationId, createAttention: false, observedAt: 250,
          finalized: { applicationTurnId: randomUUID(), outcome: "completed", result: { text: "Done" }, classifiedResult: null } });
      }
      const retained: AntigravityAttachment = { sessionId: session.sessionId, cwd: session.cwd, handleId: session.handleId,
        generation: session.generation, createdByOperationId: "unbound-creation", throughSequence: 10, retainedAfterSequence: 10,
        setup: { initialize: { protocolVersion: 1 }, session: {} }, activePromptIds: ["pending"], pendingPermissions: [],
        retainedOperationIds: ["delivered", "pending", "uncertain", "accepted-without-completion", "unowned"] };
      const inspection: AntigravityInspection = { runtimeId: randomUUID(), revision: "revision", state: "active", blockers: ["unsettled_outcome"],
        retainedSessions: [session] };
      const attachExisting = vi.fn(async () => retained);
      const acknowledgeOperation = vi.fn<AntigravityPort["acknowledgeOperation"]>();
      const port = { inspect: vi.fn(async () => inspection), stop: vi.fn(), attachExisting,
        outcome: vi.fn<AntigravityPort["outcome"]>(async ({ operationId }) => operationId === "pending" ? { status: "pending" } :
          operationId === "uncertain" ? { status: "failed", failure: { code: "unknown", delivery: "sent_outcome_unknown" } } : { status: "completed", result: {} }),
        acknowledgeOperation, acknowledgeCreation: vi.fn() };
      const administration = (principalId = scope.principalId) =>
        antigravityAdministration({ database, scope: { ...scope, principalId }, instance: { ...instance, enabled: true } }, environment, persistence, port);
      const signal = AbortSignal.timeout(5000);
      await administration("other").reconcileForUpgrade!(signal);
      expect(attachExisting).not.toHaveBeenCalled();
      port.inspect.mockResolvedValueOnce({ ...inspection, retainedSessions: [{ ...session, cwd: "/wrong-workspace" }] });
      await administration().reconcileForUpgrade!(signal);
      expect(attachExisting).not.toHaveBeenCalled();
      attachExisting.mockResolvedValueOnce({ ...retained, generation: randomUUID() });
      await administration().reconcileForUpgrade!(signal);
      expect(acknowledgeOperation).not.toHaveBeenCalled();
      await administration().reconcileForUpgrade!(signal);
      expect(acknowledgeOperation.mock.calls).toEqual([[{ handleId: session.handleId, operationId: "delivered" }, signal]]);
      expect(port.acknowledgeCreation).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it.each(["creating", "creation_unknown"] as const)("refuses local rename during %s without preparing a receipt", async (state) => {
    const f = renameGatewayFixture(state);
    try {
      await expect(f.gateway.mutate(f.scope, f.thread.id, f.request)).rejects.toMatchObject({ code: "invalid_transition" });
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.persist).not.toHaveBeenCalled();
      expect(f.acquire).not.toHaveBeenCalled();
      expect(f.inventory.getThread(f.scope, f.thread.id).thread.title).toBe("Original");
    } finally { f.database.close(); }
  });

  it.each(["unbound", "bound"] as const)("replays local rename and refuses a changed fingerprint on %s threads", async (state) => {
    const f = renameGatewayFixture(state);
    try {
      const result = { status: "accepted", operationId: f.request.mutationId };
      await expect(f.gateway.mutate(f.scope, f.thread.id, f.request)).resolves.toEqual(result);
      await expect(f.gateway.mutate(f.scope, f.thread.id, f.request)).resolves.toEqual(result);
      await expect(f.gateway.mutate(f.scope, f.thread.id, { ...f.request,
        operation: { action: "rename", title: "Changed replay" } })).rejects.toMatchObject({ code: "conflict" });
      expect(f.persist).toHaveBeenCalledOnce();
      expect(f.acquire).not.toHaveBeenCalled();
      expect(f.inventory.getThread(f.scope, f.thread.id).thread).toMatchObject({ title: "Local name", revision: f.request.expectedThreadRevision + 1 });
      expect(f.settings.hasLocalTitleOverride(f.scope, f.thread.id)).toBe(true);
      expect(f.operations.findBackendAction(f.scope, f.request.mutationId)?.state).toBe("accepted");
    } finally { f.database.close(); }
  });

  it("rolls back local title and override writes and rejects the prepared receipt when persistence fails", async () => {
    const f = renameGatewayFixture("bound");
    try {
      f.persist.mockImplementationOnce((...args) => { f.persistImplementation(...args); throw new Error("Failure after title writes"); });
      await expect(f.gateway.mutate(f.scope, f.thread.id, f.request)).rejects.toThrow("Failure after title writes");
      expect(f.inventory.getThread(f.scope, f.thread.id).thread).toMatchObject({ title: "Original", revision: f.request.expectedThreadRevision });
      expect(f.settings.hasLocalTitleOverride(f.scope, f.thread.id)).toBe(false);
      expect(f.operations.findBackendAction(f.scope, f.request.mutationId)).toBeUndefined();
      expect(f.acquire).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each([false, true])("owns a revision-fenced local title for an unbound or bound thread (bound=%s)", (bound) => {
    const { database, scope } = savedAgentDatabase();
    try {
      const connection = antigravityConnection({ database, scope });
      const inventory = new InventoryRepository(database);
      const workspace = inventory.upsertWorkspace(scope, {
        environmentId: connection.executionEnvironmentId, canonicalPath: "/tmp/local-title", displayName: "Project",
        project: { kind: "new", name: "Project" }, available: true, trustState: "trusted", environmentConfigurationRevision: 0, now: 230,
      });
      const bindings = new ConversationBindingRepository(database);
      const thread = bindings.createUnboundThread(scope, {
        workspaceId: workspace.id, connectionProfileId: connection.id, title: "Native title", now: 230,
      });
      const settings = new AntigravityThreadRepository(database);
      const policy = compileBackendModelPolicy({ type: "catalog" }, "model_effort");
      const persistence = new AntigravityThreadPersistence({ scope, backendInstanceId: "ag", settings, modelPolicy: policy,
        defaultsForConnection: () => ({}), nativeNamespaceKey: "antigravity:test" });
      persistence.initializeThread(scope, thread.id, connection);
      if (bound) bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: randomUUID(), now: 240 });
      const action = new AntigravityActionPersistence(settings, scope, "ag", policy);
      const originalSettings = settings.get(scope, thread.id);
      const revision = settings.target(scope, thread.id).revision;
      const input = { expectedThreadRevision: revision, title: "My local title", now: 250 };
      expect(persistence.preservesLocalTitle(scope, thread.id)).toBe(false);
      expect(() => action.persistLocalRename({ ...scope, principalId: randomUUID() }, thread.id, input)).toThrow();
      expect(() => action.persistLocalRename({ ...scope, tenantId: randomUUID() }, thread.id, input)).toThrow();
      expect(() => new AntigravityActionPersistence(settings, scope, "wrong-backend", policy).persistLocalRename(scope, thread.id, input)).toThrow();
      expect(() => action.persistLocalRename(scope, thread.id, { ...input, title: "" })).toThrow();
      expect(persistence.preservesLocalTitle(scope, thread.id)).toBe(false);
      const generation = database.prepare("SELECT inventory_generation AS generation FROM principal_generations WHERE tenant_id = ? AND principal_id = ?");
      const before = generation.get(scope.tenantId, scope.principalId) as { generation: number };
      action.persistLocalRename(scope, thread.id, input);
      expect(inventory.getThread(scope, thread.id).thread).toMatchObject({ title: "My local title", revision: revision + 1 });
      expect(generation.get(scope.tenantId, scope.principalId)).toEqual({ generation: before.generation + 1 });
      expect(settings.get(scope, thread.id)).toEqual(originalSettings);
      expect(persistence.preservesLocalTitle(scope, thread.id)).toBe(true);
      expect(() => action.persistLocalRename(scope, thread.id, input)).toThrow(/changed/);
      expect(() => persistence.preservesLocalTitle({ ...scope, principalId: randomUUID() }, thread.id)).toThrow();
      database.prepare("DELETE FROM antigravity_thread_settings WHERE application_thread_id = ?").run(thread.id);
      expect(() => action.persistLocalRename(scope, thread.id, { ...input, expectedThreadRevision: revision + 1,
        title: "Must roll back" })).toThrow(/not found/);
      expect(inventory.getThread(scope, thread.id).thread).toMatchObject({ title: "My local title", revision: revision + 1 });
      expect(generation.get(scope.tenantId, scope.principalId)).toEqual({ generation: before.generation + 1 });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally { database.close(); }
  });

  it("preserves old identities and enforces scope, target, and revision fences", async () => {
    const { database, scope } = savedAgentDatabase(162);
    try {
      const backendsBefore = database.prepare("SELECT * FROM agent_backend_instances").all();
      const profilesBefore = database.prepare("SELECT * FROM agent_connection_profiles").all();
      const profiles = new BackendConfigurationRepository(database);
      const bindings = new ConversationBindingRepository(database);
      const environmentId = profiles.listProfiles(scope)[0]!.executionEnvironmentId;
      const workspace = insertPreRootGrantWorkspace(database, scope, {
        environmentId, canonicalPath: "/tmp/antigravity", displayName: "Project", project: { kind: "new", name: "Project" },
        available: true, trustState: "trusted", environmentConfigurationRevision: 0, now: 200,
      });
      const pi = bindings.createUnboundThread(scope, {
        workspaceId: workspace.id, connectionProfileId: profiles.listProfiles(scope)[0]!.id, title: "Existing", now: 210,
      });
      const piSession = randomUUID();
      bindings.bindDiscoveredConversation(scope, pi.id, { backendConversationId: piSession, now: 215 });
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(database.prepare("SELECT * FROM agent_backend_instances").all()).toEqual(backendsBefore);
      expect(database.prepare("SELECT * FROM agent_connection_profiles").all()).toEqual(profilesBefore);
      expect(database.prepare("SELECT backend_conversation_id FROM conversation_bindings WHERE application_thread_id = ?").get(pi.id))
        .toEqual({ backend_conversation_id: piSession });

      const connection = antigravityConnection({ database, scope });
      const thread = bindings.createUnboundThread(scope, {
        workspaceId: workspace.id, connectionProfileId: connection.id, title: "Antigravity", now: 230,
      });
      const settings = new AntigravityThreadRepository(database);
      const policy = compileBackendModelPolicy({ type: "denylist", denied: [{ reasoningEfforts: ["max"] }] }, "model_effort");
      const nativeNamespaceKey = "antigravity:test";
      const persistence = new AntigravityThreadPersistence({ scope, backendInstanceId: "ag", modelPolicy: policy, settings,
        defaultsForConnection: () => ({}), nativeNamespaceKey, now: () => 230 });
      const catalog: BackendCatalog = { models: [
        { provider: connection.id, id: "model-a", label: "Model A", inputModalities: ["text"], isDefault: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "provider-specific"], defaultReasoningEffort: "low" },
      ], commands: [], skills: [], notices: [] };
      persistence.initializeNewThread(scope, thread.id, connection, catalog);
      expect(settings.get(scope, thread.id)).toMatchObject({ modelId: "model-a", thinkingLevel: "low", revision: 0 });
      persistence.validateInitialization(scope, thread.id, catalog);

      const other = { ...scope, principalId: randomUUID() };
      expect(() => settings.get(other, thread.id)).toThrow(/not found/i);
      expect(() => settings.target(scope, pi.id)).toThrow(/not found/i);
      expect(() => persistence.initializeThread(scope, thread.id, { ...connection, ownerPrincipalId: other.principalId })).toThrow(/does not match/i);
      expect(() => persistence.initializeThread(scope, pi.id, connection)).toThrow(/not found/i);

      const backend = profiles.listBackends(scope).find(candidate => candidate.kind === "antigravity")!;
      const presentation = new AntigravityThreadPresentation(settings, policy);
      const presentationInput = { scope, applicationThreadId: thread.id, backend: { ...backend, enabled: backend.enabled === 1 }, connection, catalog };
      expect((await presentation.read(presentationInput)).settingDescriptors.find(item => item.id === "thinking_level")
        ?.options.map(({ value, label }) => [value, label.text])).toEqual([
        ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra High"], ["provider-specific", "provider-specific"],
      ]);

      const action = new AntigravityActionPersistence(settings, scope, "ag", policy);
      const stage = (thinkingLevel: string) => action.persistAccepted(scope, thread.id, {
        mutationId: randomUUID(), expectedThreadRevision: settings.target(scope, thread.id).revision,
        settingsGuard: { kind: "staged", expectedRevision: 0 }, now: 240,
        operation: { action: "set_setting", settingId: "thinking_level", value: thinkingLevel },
      });
      expect(() => stage("max")).toThrow(/unavailable/);
      stage("xhigh");
      expect(() => stage("low")).toThrow(/changed/);
      expect(settings.get(scope, thread.id)).toMatchObject({ thinkingLevel: "xhigh", revision: 1 });
      expect((await presentation.read(presentationInput)).settings.values[0]).toMatchObject({
        desiredValue: encodeAntigravityModelSetting(connection.id, "model-a", "xhigh"), effectiveValue: null, applicationState: "draft",
      });
      expect((await presentation.read({ ...presentationInput, catalog: undefined })).settingDescriptors
        .find(item => item.id === "thinking_level")?.options).toEqual([
        { value: "xhigh", label: { text: "Extra High" }, available: false },
      ]);

      const modes = new AntigravityModeCatalog();
      const modeAction = new AntigravityActionPersistence(settings, scope, "ag", policy, modes);
      const modePresentation = new AntigravityThreadPresentation(settings, policy, modes);
      expect((await modePresentation.read(presentationInput)).providerFeatureCapabilities[0]?.operations.map(operation => operation.actionId))
        .toEqual(["keep_native_mode"]);
      const modeInput = { mutationId: randomUUID(), expectedThreadRevision: settings.target(scope, thread.id).revision, now: 245,
        operation: { action: "perform_provider_feature" as const, feature: ANTIGRAVITY_MODE_FEATURE_REF,
          actionId: "set_mode_plan", arguments: null, expectedMutationRevision: settings.get(scope, thread.id).revision } };
      await expect(modeAction.performProviderFeature(scope, thread.id, modeInput)).rejects.toMatchObject({ code: "invalid_transition" });
      modes.observe({ initialize: { protocolVersion: 1 }, session: { configOptions: [{ type: "select", id: "native-mode-selector",
        category: "mode", name: "Mode", currentValue: "default", options: [
          { value: "default", name: "Default" }, { value: "plan", name: "Plan" }, { value: "future-provider-mode", name: "Unqualified" },
        ] }] } });
      const feature = (await modePresentation.read(presentationInput)).providerFeatureCapabilities[0]!;
      expect(feature.operations.map(operation => operation.actionId)).toEqual(["keep_native_mode", "set_mode_default", "set_mode_plan"]);
      expect(feature.mutationRevision).toBe(1);
      expect((await modePresentation.read(presentationInput)).providerFeatureStates[0]?.revision).toBe(feature.revision);
      const acceptedMode = await modeAction.performProviderFeature(scope, thread.id, modeInput);
      expect(settings.get(scope, thread.id)).toMatchObject({ modeId: "plan", modelId: "model-a", thinkingLevel: "xhigh", revision: 2 });
      modes.observe({ initialize: { protocolVersion: 1 }, session: {} });
      // Accepted application receipts replay even after native options change.
      expect(await modeAction.performProviderFeature(scope, thread.id, modeInput)).toEqual(acceptedMode);
      await expect(modeAction.performProviderFeature(scope, thread.id, { ...modeInput,
        operation: { ...modeInput.operation, actionId: "set_mode_default" } })).rejects.toMatchObject({ code: "conflict" });
      await expect(modeAction.performProviderFeature(other, thread.id, modeInput)).rejects.toMatchObject({ code: "conflict" });
      const wrongBackend = new AntigravityActionPersistence(settings, scope, "other-backend", policy, modes);
      expect(() => wrongBackend.replayProviderFeature(scope, thread.id, modeInput)).toThrow(/changed/);
      await expect(modeAction.performProviderFeature(scope, thread.id, { ...modeInput, mutationId: randomUUID() })).rejects.toMatchObject({ code: "invalid_transition" });
      await modeAction.performProviderFeature(scope, thread.id, { mutationId: randomUUID(), expectedThreadRevision: settings.target(scope, thread.id).revision,
        operation: { ...modeInput.operation, actionId: "keep_native_mode", expectedMutationRevision: 2 }, now: 246 });
      expect(settings.get(scope, thread.id)).toMatchObject({ modeId: null, revision: 3 });
      const modeState = (await modePresentation.read(presentationInput)).providerFeatureStates[0]!;
      expect(modeState.revision).toBe((await modePresentation.read(presentationInput)).providerFeatureCapabilities[0]!.revision);
      expect(modeState.state).toEqual({ kind: "object", entries: [
        { key: { text: "desiredMode" }, value: null }, { key: { text: "application" }, value: { text: "next_turn" } },
      ] });

      const sessionId = randomUUID();
      bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: sessionId, now: 250 });
      const detail = { version: 1 as const, ...scope, sessionId, backendInstanceId: "ag", connectionProfileId: connection.id,
        executionEnvironmentId: environmentId, canonicalWorkspacePath: workspace.canonicalPath, nativeNamespaceKey };
      expect(() => persistence.saveBoundBindingDetail(scope, thread.id, serializeAntigravityBinding({ ...detail, nativeNamespaceKey: "wrong-namespace" })))
        .toThrow(/does not match/);
      const encoded = serializeAntigravityBinding(detail);
      persistence.saveBoundBindingDetail(scope, thread.id, encoded);
      persistence.saveBoundBindingDetail(scope, thread.id, encoded);
      expect(persistence.getBindingDetail(scope, thread.id)).toBe(encoded);
      expect(() => persistence.getBindingDetail(other, thread.id)).toThrow(/does not match/);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally { database.close(); }
  });

  it("edits, resolves, and captures qualified Saved Agent modes against the target's catalog", () => {
    const { database, scope } = savedAgentDatabase();
    try {
      const connection = antigravityConnection({ database, scope });
      const workspace = new InventoryRepository(database).upsertWorkspace(scope, {
        environmentId: connection.executionEnvironmentId, canonicalPath: "/tmp/antigravity", displayName: "Project",
        project: { kind: "new", name: "Project" }, available: true, trustState: "trusted", environmentConfigurationRevision: 0, now: 230,
      });
      const catalog: BackendCatalog = { models: [
        { provider: connection.id, id: "model-a", label: "Model A", inputModalities: ["text"], isDefault: true,
          supportedReasoningEfforts: ["low", "high", "xhigh"], defaultReasoningEffort: "low" },
        { provider: connection.id, id: "model-b", label: "Model B", inputModalities: ["text"],
          supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" },
      ], commands: [], skills: [], notices: [] };
      const settings = new AntigravityThreadRepository(database);
      const persistence = new AntigravityThreadPersistence({ scope, backendInstanceId: connection.backendInstanceId,
        settings, modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
        defaultsForConnection: () => ({ modelId: "model-a", thinkingLevel: "xhigh", modeId: "plan" }),
        nativeNamespaceKey: "antigravity:test", now: () => 240 });
      const modes = new AntigravityModeCatalog();
      const adapter = new AntigravitySavedAgentAdapter(persistence, modes);
      const agents = new SavedAgentService(new SavedAgentRepository(database),
        new SavedAgentBackendAdapterRegistry([{ backendInstanceId: connection.backendInstanceId, adapter }]));
      const bindings = new ConversationBindingRepository(database);
      const context = { scope, connection, catalog, workspace: { canonicalPath: workspace.canonicalPath, authorityRevision: 0,
        summary: { ...workspace, displayPath: workspace.canonicalPath } } };
      const resolutionInput = (overrides: NormalizedAgentConfigurationOverrides = []) => ({ ...context,
        prepared: adapter.prepareResolutionContext(context), overrides: adapter.validateOverrides({ overrides }) });
      const advertise = (currentValue: string, ...otherValues: string[]) => modes.observe({ initialize: { protocolVersion: 1 }, session: {
        configOptions: [{ type: "select", id: "native-mode-selector", category: "mode", name: "Mode",
          currentValue, options: [currentValue, ...otherValues].map(value => ({ value, name: value })) }],
      } });
      const initialize = (resolved: ResolvedSavedAgentBackendConfiguration) => database.transaction(() => {
        const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId: connection.id, title: "New thread", now: 240 });
        adapter.initializeNewThread({ scope, connection, applicationThreadId: thread.id, resolved,
          transaction: ConversationCreationTransaction.fromActiveDatabase(database) });
        return thread.id;
      })();

      advertise("default", "plan", "future-provider-mode");
      expect(() => resolutionInput([{ id: "mode", value: "future-provider-mode" }])).toThrow(/unavailable/);
      expect(() => adapter.resolve(resolutionInput([{ id: "mode", value: "auto" }]))).toThrow(/mode is unavailable/);
      expect(() => adapter.prepareResolutionContext({ ...context, scope: { ...scope, principalId: randomUUID() } })).toThrow(/does not match/);
      expect(adapter.describeEditor(resolutionInput()).fields.find(item => item.id === "mode")).toMatchObject({
        label: { text: "Mode" }, currentDefaultValue: "plan", resolvedValue: "plan",
        options: [{ value: "default", label: { text: "Default" }, available: true }, { value: "plan", label: { text: "Plan" }, available: true }],
      });
      expect(adapter.resolve(resolutionInput()).value).toEqual({ modelId: "model-a", thinkingLevel: "xhigh", modeId: "plan" });
      const unavailableEffort = resolutionInput([{ id: "model", value: "model-b" }, { id: "reasoning_effort", value: "max" }]);
      expect(adapter.describeEditor(unavailableEffort).fields.find(item => item.id === "reasoning_effort")).toMatchObject({
        currentDefaultValue: "xhigh", resolvedValue: "max", options: [
          { value: "medium", label: { text: "Medium" }, available: true },
          { value: "xhigh", label: { text: "Extra High" }, available: false },
          { value: "max", label: { text: "Maximum" }, available: false },
        ],
      });
      expect(() => adapter.resolve(unavailableEffort)).toThrow(/unavailable/);

      const overrides = [{ id: "model", value: "model-a" }, { id: "reasoning_effort", value: "high" }, { id: "mode", value: "default" }];
      const input = resolutionInput(overrides);
      const resolved = adapter.resolve(input);
      const saved = agents.create(scope, { name: "Mode override", backendTypeId: "antigravity", backendOverrides: input.overrides.overrides });
      expect(saved.backendOverrides.map(item => item.id)).toEqual(["mode", "model", "reasoning_effort"]);
      const threadId = initialize(resolved);
      expect(settings.get(scope, threadId)).toMatchObject({ modelId: "model-a", thinkingLevel: "high", modeId: "default" });
      const capture = adapter.captureThreadConfiguration({ scope, connection, applicationThreadId: threadId });
      expect(capture.overrides).toEqual(saved.backendOverrides);
      expect(adapter.resolve(resolutionInput(capture.overrides)).value).toEqual(resolved.value);

      advertise("plan");
      expect(agents.get(scope, saved.id).backendOverrides).toEqual(saved.backendOverrides);
      expect(adapter.describeEditor(resolutionInput(saved.backendOverrides)).fields.find(item => item.id === "mode")).toMatchObject({
        currentDefaultValue: "plan", resolvedValue: "default", options: [
          { value: "plan", available: true }, { value: "default", label: { text: "default (unavailable)" }, available: false },
        ],
      });
      expect(() => adapter.resolve(resolutionInput(saved.backendOverrides))).toThrow(/mode is unavailable/);
      expect(() => initialize(resolved)).toThrow(/mode is unavailable/);

      modes.observe({ initialize: { protocolVersion: 1 }, session: {} });
      expect(adapter.describeEditor(resolutionInput()).fields.find(item => item.id === "mode")).toMatchObject({
        currentDefaultValue: "plan", resolvedValue: "plan", options: [{ value: "plan", available: false }],
      });
      expect(() => adapter.resolve(resolutionInput())).toThrow(/mode is unavailable/);
      const withoutModeDefault = new AntigravitySavedAgentAdapter(
        new AntigravityThreadPersistence({ ...persistence.input, defaultsForConnection: () => ({}) }), modes);
      const native = withoutModeDefault.resolve({ ...context, prepared: withoutModeDefault.prepareResolutionContext(context),
        overrides: withoutModeDefault.validateOverrides({ overrides: [] }) });
      expect(native.value).toEqual({ modelId: "model-a", thinkingLevel: "low", modeId: null });
      expect(native.normalizedValues.map(item => item.id)).toEqual(["model", "reasoning_effort"]);
    } finally { database.close(); }
  });
});
