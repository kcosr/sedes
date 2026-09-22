import { NO_USAGE_SINK, type UsageObservation } from "../../src/server/usage/contracts.js";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBinding,
} from "../../src/server/backends/contracts.js";
import type { SequencedBackendEvent } from "../../src/shared/protocol/backend.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../../src/server/backends/fork-context-boundary.js";
import {
  parseCodexBindingDetail,
  serializeCodexBindingDetail,
} from "../../src/server/backends/codex/codex-binding-codec.js";
import {
  codexThreadListMethod,
  codexThreadReadMethod,
  codexThreadResumeMethod,
  codexThreadUnsubscribeMethod,
} from "../../src/server/backends/codex/codex-c1-protocol.js";
import {
  codexThreadStartMethod,
  codexTurnStartMethod,
} from "../../src/server/backends/codex/codex-c2-protocol.js";
import {
  CodexConversationBackendDriver,
  CodexConversationOwnershipRegistry,
} from "../../src/server/backends/codex/codex-conversation-driver.js";
import { unavailableCodexAgentToolCliEnvironmentProvider } from "../../src/server/backends/codex/codex-agent-tool-cli-environment.js";
import type {
  CodexExecutionSettingsProvider,
  CodexExecutionSettingsTuple,
  CodexObservedExecutionSettings,
} from "../../src/server/backends/codex/codex-conversation-handle.js";
import { CodexDaemonSupervisor } from "../../src/server/backends/codex/codex-daemon-supervisor.js";
import { CodexFastModeSessionRegistry } from "../../src/server/backends/codex/codex-fast-mode-session.js";
import { CodexNativeStoreOwnershipGate } from "../../src/server/backends/codex/codex-native-store-ownership.js";
import { CODEX_APP_SERVER_RELEASE } from "../../src/server/backends/codex/codex-release-guard.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";
import {
  materializeCodexGeneratedImagePublications,
  projectCodexHistory,
} from "../../src/server/backends/codex/codex-history-projector.js";
import { resolveCodexRuntimeConfiguration } from "../../src/server/backends/codex/codex-runtime-config.js";
import type {
  ProviderTransportScope,
  FramedTransportFactory,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import { OwnedStdioTransportFactory } from "../../src/server/backends/codex/transport/owned-stdio-transport.js";
import { TcpWebSocketTransportFactory } from "../../src/server/backends/codex/transport/tcp-websocket-transport.js";
import { UnixWebSocketTransportFactory } from "../../src/server/backends/codex/transport/unix-websocket-transport.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { pinnedCodexTestExecutable } from "../helpers/pinned-codex-test-executable.js";

const catalogModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "model_effort",
);
const codexBinary = pinnedCodexTestExecutable();
const requestOptions = Object.freeze({ timeoutMilliseconds: 5_000 });
function liveExecutionSettings(
  selected: () => CodexExecutionSettingsTuple,
  observeEffective: (settings: CodexObservedExecutionSettings) => void = () =>
    undefined,
): CodexExecutionSettingsProvider {
  return {
    desiredSettings: () => selected(),
    resolveFastModeDisabled: () => selected(),
    forkSettingsEligibility: () => ({
      availability: "available",
      settingsRevision: 1,
      settings: selected(),
    }),
    freezeOperationSnapshot: () => ({ settings: selected() }),
    observeEffective: (_scope, input) => observeEffective(input.settings),
    markEffectiveUnknown: () => undefined,
  };
}

function selectedCatalogSettings(
  models: Awaited<
    ReturnType<CodexConversationBackendDriver["catalog"]>
  >["models"],
): CodexExecutionSettingsTuple {
  const model = models.find(({ isDefault }) => isDefault === true) ?? models[0];
  const reasoningEffort =
    model?.defaultReasoningEffort ?? model?.supportedReasoningEfforts?.[0];
  if (!model || !reasoningEffort) {
    throw new Error("codex_live_model_catalog_invalid");
  }
  return {
    model: model.id,
    reasoningEffort,
    serviceTier: "standard",
    ...readOnlyPolicy,
  };
}

const readOnlyPolicy = {
  sandboxMode: "read-only",
  networkAccess: "disabled",
  approvalPolicy: "never",
  approvalReviewer: "user",
} as const;

const workspacePolicy = {
  sandboxMode: "workspace-write",
  networkAccess: "disabled",
  approvalPolicy: "on-request",
  approvalReviewer: "user",
} as const;

const configuredSharedUdsLiveEndpoint = readSharedUdsLiveEndpoint();
const generatedImageLiveEnabled =
  process.env.SEDES_REAL_CODEX_GENERATED_IMAGE === "1";

describe.sequential("Codex daemon supervisor live lifecycle", () => {
  it("streams and interrupts an attached thread, replaces a killed daemon, and leaves no process group", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.homedir(), ".sedes-codex-supervisor-live-"),
    );
    const codexHome = path.join(temporaryRoot, "codex-home");
    const workingDirectory = path.join(temporaryRoot, "workspace");
    const secureCodexBinary = path.join(temporaryRoot, "codex");
    const provider = await startLocalProvider();
    const openedPids: number[] = [];
    let supervisor: CodexDaemonSupervisor | undefined;

    try {
      await Promise.all([
        mkdir(codexHome, { recursive: true }),
        mkdir(workingDirectory, { recursive: true }),
        link(codexBinary, secureCodexBinary),
      ]);
      await writeFile(
        path.join(codexHome, "config.toml"),
        `
model = "sedes-live-fixture"
model_provider = "sedes_live_fixture"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.sedes_live_fixture]
name = "Sedes live supervisor fixture"
base_url = "${provider.baseUrl}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
requires_openai_auth = false

[features]
apps = false
plugins = false
`,
        { encoding: "utf8", mode: 0o600 },
      );

      const scope = Object.freeze({
        tenantId: "tenant-live",
        principalId: "principal-live",
      });
      const instance: AgentBackendInstance = Object.freeze({
        id: "codex-live",
        tenantId: scope.tenantId,
        kind: "codex_app_server",
        label: "Codex live",
        enabled: true,
        configurationRevision: 1,
        protocolRelease: CODEX_APP_SERVER_RELEASE,
      });
      const connection: AgentConnectionProfile = Object.freeze({
        id: "codex-live-profile",
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        templateId: "codex-live-template",
        kind: "codex_app_server",
        backendInstanceId: instance.id,
        executionEnvironmentId: "codex-live-environment",
        label: "Codex live profile",
        enabled: true,
        configurationRevision: 1,
      });
      const secondConnection: AgentConnectionProfile = Object.freeze({
        ...connection,
        id: "codex-live-profile-two",
        templateId: "codex-live-template-two",
        label: "Codex live profile two",
      });
      const environmentChannel = new LocalEnvironmentChannelProvider({
        scope,
        executionEnvironmentId: connection.executionEnvironmentId,
      });
      const resolved = await resolveCodexRuntimeConfiguration({
        scope,
        instance,
        connections: [connection, secondConnection],
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath: secureCodexBinary,
            workingDirectory,
            codexHome,
          },
        },
        environmentChannel,
        environment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      });
      if (
        resolved.connection.ownership !== "owned" ||
        resolved.codexHome === undefined ||
        resolved.nativeStoreHome === undefined ||
        resolved.childEnvironment === undefined
      ) {
        throw new Error("live_test_expected_owned_connection");
      }
      expect(resolved.childEnvironment).toEqual({
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: os.homedir(),
        CODEX_HOME: resolved.codexHome,
        NO_COLOR: "1",
        TERM: "dumb",
      });

      const runtimeScope: ProviderTransportScope = Object.freeze({
        ...resolved.scope,
        backendInstanceId: resolved.instance.id,
        executionEnvironmentId: resolved.executionEnvironmentId,
      });
      const ownedFactory = new OwnedStdioTransportFactory({
        scope: runtimeScope,
        channels: environmentChannel,
        process: resolved.connection.channel.process,
        environment: resolved.childEnvironment,
        sqliteHome: resolved.nativeStoreHome,
        limits: {
          gracefulCloseMilliseconds: 500,
          terminateMilliseconds: 750,
          killMilliseconds: 1_000,
        },
        sensitiveValues: [resolved.codexHome, provider.baseUrl],
      });
      const capturingFactory = captureOwnedPids(ownedFactory, openedPids);
      supervisor = new CodexDaemonSupervisor({
        scope: runtimeScope,
        expectedCodexHome: resolved.codexHome,
        transportFactory: capturingFactory,
        restartDelaysMilliseconds: [25, 50, 100],
        maximumRestartAttempts: 3,
        nativeStoreOwnership: new CodexNativeStoreOwnershipGate(),
      });

      await supervisor.start();
      const initial = supervisor.snapshot();
      expect(initial).toMatchObject({
        state: "ready",
        generation: 1,
        restartAttempts: 0,
      });
      expect(openedPids).toHaveLength(1);
      const firstPid = openedPids[0]!;
      expect(processGroupExists(firstPid)).toBe(true);

      const listParams = Object.freeze({
        limit: 1 as const,
        sourceKinds: [] as [],
        useStateDbOnly: true as const,
      });
      const [firstRead, secondRead] = await Promise.all([
        supervisor.client.request(
          codexThreadListMethod,
          listParams,
          requestOptions,
        ),
        supervisor.client.request(
          codexThreadListMethod,
          listParams,
          requestOptions,
        ),
      ]);
      expect(firstRead).toEqual({
        data: [],
        nextCursor: null,
        backwardsCursor: null,
      });
      expect(secondRead).toEqual(firstRead);
      expect(supervisor.snapshot()).toMatchObject({
        state: "ready",
        generation: initial.generation,
      });
      expect(openedPids).toEqual([firstPid]);

      const threadSource = "sedes_c1_live_read_fixture";
      const started = await supervisor.client.request(
        codexThreadStartMethod,
        {
          cwd: resolved.connection.channel.workingDirectory,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          threadSource,
        },
        requestOptions,
      );
      const completed = nextNotification(
        supervisor.client,
        "turn/completed",
        (params) => isRecord(params) && params.threadId === started.thread.id,
      );
      await supervisor.client.request(
        codexTurnStartMethod,
        {
          threadId: started.thread.id,
          clientUserMessageId: "sedes-c1-live-message",
          input: [
            {
              type: "text",
              text: "Materialize the disposable C1 read fixture.",
              text_elements: [],
            },
          ],
        },
        requestOptions,
      );
      await completed;
      await supervisor.client.request(
        codexThreadUnsubscribeMethod,
        { threadId: started.thread.id },
        requestOptions,
      );

      const workspace = Object.freeze({
        authorityRevision: 1,
        summary: Object.freeze({
          id: "12000000-0000-4000-8000-000000000001",
          environmentId: connection.executionEnvironmentId,
          displayName: "Codex live workspace",
          displayPath: resolved.connection.channel.workingDirectory,
          availability: "available" as const,
          trustState: "trusted" as const,
          revision: 1,
        }),
        canonicalPath: resolved.connection.channel.workingDirectory,
      });
      const ownership = new CodexConversationOwnershipRegistry();
      let selectedSettings: CodexExecutionSettingsTuple = {
        model: "unselected",
        reasoningEffort: "low",
        serviceTier: "standard",
        ...readOnlyPolicy,
      };
      const usageObservations: UsageObservation[] = [];
      const driver = new CodexConversationBackendDriver({
    usageSink: { open: () => ({ registerTurns: () => undefined, capture: observations => {
      usageObservations.push(...observations); return true;
    }, reconcile: () => true, gap: () => undefined, seal: () => undefined }) },
    nativeNamespace: "test-codex-store",
        instance,
        connection,
        client: supervisor.client,
        serverRequests: supervisor.serverRequests,
        ownership,
        toolProvenanceKey: new Uint8Array(32).fill(0x4c),
        modelPolicy: catalogModelPolicy,
        executionSettings: liveExecutionSettings(() => selectedSettings),
        outputArtifacts: createInMemoryOutputArtifactPublisher(),
        fastModeSessions: new CodexFastModeSessionRegistry(),
        agentToolCliEnvironment:
          unavailableCodexAgentToolCliEnvironmentProvider,
      });
      selectedSettings = selectedCatalogSettings(
        (await driver.catalog({ scope, workspace })).models,
      );
      const discovered = await driver.discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        limit: 10,
      });
      expect(discovered.conversations).toEqual([
        expect.objectContaining({
          backendConversationId: started.thread.id,
          canonicalWorkspacePath: resolved.connection.channel.workingDirectory,
        }),
      ]);
      const binding: ConversationBinding = Object.freeze({
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        applicationThreadId: "13000000-0000-4000-8000-000000000001",
        backendInstanceId: instance.id,
        connectionProfileId: connection.id,
        executionEnvironmentId: connection.executionEnvironmentId,
        backendConversationId: started.thread.id,
        createdAt: new Date().toISOString(),
      });
      const opaqueBindingDetail = serializeCodexBindingDetail({
        threadId: started.thread.id,
        sessionId: started.thread.sessionId,
        nativeAncestry: null,
        correlationAncestorThreadIds: [],
      });
      const boundInput = {
        scope,
        binding,
        workspace,
        opaqueBindingDetail,
      };
      const read = await driver.read(boundInput);
      expect(read.snapshot.runState).toBe("idle");
      expect(read.snapshot.orderedBackendTurnIds).toHaveLength(1);
      expect(read.snapshot.itemsById).not.toEqual({});

      const handle = await driver.attach({
        scope,
        binding,
        workspace,
        opaqueBindingDetail,
      });
      const established = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(established.snapshot).toEqual(read.snapshot);
      const lifecycleEvents: string[] = [];
      const handleEvents: SequencedBackendEvent[] = [];
      const recordHandleEvent = (sequencedEvent: SequencedBackendEvent) => {
        handleEvents.push(sequencedEvent);
        const { event } = sequencedEvent;
        if (event.type === "run_state_changed") {
          lifecycleEvents.push(event.state);
        } else if (event.type === "resnapshot_required") {
          lifecycleEvents.push(event.type);
        }
      };
      let unsubscribeProjection =
        established.subscribeFromNext(recordHandleEvent);

      const streamEventStart = handleEvents.length;
      const submission = await handle.submit({
        applicationOperationId: "sedes-c2-live-submit",
        source: { kind: "user" },
        mutationId: "sedes-c2-live-mutation",
        reconciliationToken: "sedes-c2-live-reconciliation",
        contextExcerpts: [],
        taskContexts: [],
        attachments: [],
        text: "Exercise the attached C2 streaming path.",
      });
      expect(submission).toMatchObject({
        accepted: true,
        reconciliationToken: "sedes-c2-live-reconciliation",
        completionCorrelation: "sedes-c2-live-submit",
        backendTurnId: expect.any(String),
      });
      await waitUntil(
        () =>
          handleEvents
            .slice(streamEventStart)
            .some(
              ({ event }) =>
                event.type === "item_updated" &&
                event.item.semanticKind === "assistant_message" &&
                event.item.status === "streaming" &&
                event.item.markdown.text === "fixture streaming ",
            ),
        5_000,
      );
      await waitUntil(
        () =>
          handleEvents
            .slice(streamEventStart)
            .some(
              ({ event }) =>
                event.type === "turn_completed" &&
                event.turn.backendTurnId === submission.backendTurnId,
            ),
        5_000,
      );
      const firstTurnUsage = usageObservations.flatMap(observation => observation.facts)
        .filter(fact => fact.turn?.backendTurnId === submission.backendTurnId);
      expect(firstTurnUsage.map(fact => fact.tokens.input)).toEqual(["11"]);
      expect(firstTurnUsage.map(fact => fact.tokens.output)).toEqual(["7"]);
      expect(firstTurnUsage.flatMap(fact => fact.reasons)).not.toContain("unknown_baseline");
      const firstStreamEvents = handleEvents.slice(streamEventStart);
      const streamedDeltaIndex = firstStreamEvents.findIndex(
        ({ event }) =>
          event.type === "item_updated" &&
          event.item.semanticKind === "assistant_message" &&
          event.item.status === "streaming",
      );
      const completionIndex = firstStreamEvents.findIndex(
        ({ event }) =>
          event.type === "turn_completed" &&
          event.turn.backendTurnId === submission.backendTurnId,
      );
      expect(streamedDeltaIndex).toBeGreaterThanOrEqual(0);
      expect(completionIndex).toBeGreaterThan(streamedDeltaIndex);
      expect(firstStreamEvents).not.toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({ type: "resnapshot_required" }),
        }),
      );
      const streamedSnapshot = (await driver.read(boundInput)).snapshot;
      expect(streamedSnapshot.runState).toBe("idle");
      expect(
        streamedSnapshot.turnsById[submission.backendTurnId!]?.status,
      ).toBe("completed");
      expect(Object.values(streamedSnapshot.itemsById)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            semanticKind: "assistant_message",
            markdown: {
              text: "fixture streaming complete",
            },
          }),
        ]),
      );

      provider.holdNextResponse();
      const interruptEventStart = handleEvents.length;
      const interruptedSubmission = await handle.submit({
        applicationOperationId: "sedes-c2-live-interrupt-submit",
        source: { kind: "user" },
        mutationId: "sedes-c2-live-interrupt-mutation",
        reconciliationToken: "sedes-c2-live-interrupt-reconciliation",
        contextExcerpts: [],
        taskContexts: [],
        attachments: [],
        text: "Hold this disposable turn until Sedes interrupts it.",
      });
      expect(interruptedSubmission.backendTurnId).toEqual(expect.any(String));
      await waitUntil(
        () =>
          handleEvents
            .slice(interruptEventStart)
            .some(
              ({ event }) =>
                event.type === "item_updated" &&
                event.item.backendTurnId ===
                  interruptedSubmission.backendTurnId &&
                event.item.semanticKind === "assistant_message" &&
                event.item.status === "streaming" &&
                event.item.markdown.text === "fixture streaming ",
            ),
        5_000,
      );
      await handle.interrupt({
        applicationOperationId: "sedes-c2-live-interrupt",
        expectedBackendTurnId: interruptedSubmission.backendTurnId!,
      });
      await waitUntil(
        () =>
          handleEvents
            .slice(interruptEventStart)
            .some(({ event }) => event.type === "resnapshot_required"),
        5_000,
      );
      expect(
        handleEvents
          .slice(interruptEventStart)
          .some(
            ({ event }) =>
              event.type === "run_state_changed" && event.state === "stopping",
          ),
      ).toBe(true);
      expect(
        handleEvents
          .slice(interruptEventStart)
          .some(({ event }) => event.type === "resnapshot_required"),
      ).toBe(true);
      expect(
        handleEvents
          .slice(interruptEventStart)
          .some(
            ({ event }) =>
              event.type === "turn_completed" &&
              event.turn.backendTurnId === interruptedSubmission.backendTurnId,
          ),
      ).toBe(false);
      // Mirror the actor's recovery boundary: the ambiguous terminal summary
      // ends the old projection, then one authoritative thread/read import
      // starts the next generation.
      unsubscribeProjection();
      const recoveredAfterInterrupt = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      unsubscribeProjection =
        recoveredAfterInterrupt.subscribeFromNext(recordHandleEvent);
      const completedSnapshot = recoveredAfterInterrupt.snapshot;
      expect(completedSnapshot.runState).toBe("idle");
      expect(
        completedSnapshot.turnsById[interruptedSubmission.backendTurnId!]
          ?.status,
      ).toBe("interrupted");

      process.kill(-firstPid, "SIGKILL");
      await waitUntil(() => !processGroupExists(firstPid), 5_000);
      await waitUntil(() => provider.heldResponseCloseCount() === 1, 5_000);
      await waitUntil(() => lifecycleEvents.includes("disconnected"), 5_000);
      expect(lifecycleEvents).toContain("disconnected");
      expect(["disconnected", "reconciling"]).toContain(
        (await driver.read(boundInput)).snapshot.runState,
      );
      const restarted = await waitUntil(() => {
        const snapshot = supervisor?.snapshot();
        return snapshot?.state === "ready" &&
          snapshot.generation > initial.generation
          ? snapshot
          : undefined;
      }, 20_000);
      expect(restarted.generation).toBeGreaterThan(initial.generation);
      expect(restarted.restartAttempts).toBeGreaterThanOrEqual(1);
      expect(openedPids.length).toBeGreaterThanOrEqual(2);
      const replacementPid = openedPids.at(-1)!;
      expect(replacementPid).not.toBe(firstPid);
      expect(processGroupExists(replacementPid)).toBe(true);

      const afterRestartList = await supervisor.client.request(
        codexThreadListMethod,
        listParams,
        requestOptions,
      );
      expect(afterRestartList.data).toEqual([
        expect.objectContaining({
          id: started.thread.id,
          cwd: resolved.connection.channel.workingDirectory,
        }),
      ]);
      expect(afterRestartList.nextCursor).toBeNull();
      expect(supervisor.snapshot()).toMatchObject({
        state: "ready",
        generation: restarted.generation,
      });
      await waitUntil(
        () =>
          lifecycleEvents.includes("reconciling") &&
          lifecycleEvents.includes("resnapshot_required"),
        5_000,
      );
      unsubscribeProjection();
      const reestablished = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(reestablished.snapshot.runState).toBe("idle");
      expect(
        reestablished.snapshot.turnsById[interruptedSubmission.backendTurnId!]
          ?.status,
      ).toBe("interrupted");
      expect(
        Object.values(completedSnapshot.itemsById).some(
          (item) =>
            item.backendTurnId === interruptedSubmission.backendTurnId &&
            item.semanticKind === "assistant_message",
        ),
      ).toBe(false);
      expect(
        Object.values(reestablished.snapshot.itemsById).some(
          (item) =>
            item.backendTurnId === interruptedSubmission.backendTurnId &&
            item.semanticKind === "assistant_message",
        ),
      ).toBe(false);
      expect((await driver.read(boundInput)).snapshot.runState).toBe("idle");
      unsubscribeProjection();
      expect(provider.requestCount()).toBe(3);
      provider.failNextResponse();
      const failureCompleted = nextNotification(supervisor.client, "turn/completed", (value) =>
        isRecord(value) && value.threadId === started.thread.id && isRecord(value.turn) && value.turn.status === "failed");
      const failedSubmission = await handle.submit({
        applicationOperationId: "sedes-live-model-failure", source: { kind: "user" },
        mutationId: "sedes-live-model-failure", reconciliationToken: "sedes-live-model-failure",
        contextExcerpts: [], taskContexts: [], attachments: [], text: "Trigger the isolated model failure.",
      });
      await failureCompleted;
      const failed = await handle.establishProjection({ signal: new AbortController().signal });
      const failedTurn = failed.snapshot.turnsById[failedSubmission.backendTurnId!]!;
      expect(failedTurn.status).toBe("failed");
      expect(failedTurn.failure?.message.text).toContain("Invalid model configuration for Sedes fixture");
      await handle.close();
      expect(ownership.size()).toBe(0);
      const reopened = await driver.attach(boundInput);
      try {
        const restored = await reopened.establishProjection({ signal: new AbortController().signal });
        expect(restored.snapshot.turnsById[failedSubmission.backendTurnId!]?.failure).toEqual(failedTurn.failure);
      } finally { await reopened.close(); }
      expect(provider.requestCount()).toBe(4);

      await supervisor.close();
      expect(supervisor.snapshot().state).toBe("closed");
      await waitUntil(
        () =>
          openedPids.every(
            (pid) => !processExists(pid) && !processGroupExists(pid),
          ),
        5_000,
      );
    } finally {
      await supervisor?.close().catch(() => undefined);
      for (const pid of openedPids) {
        if (processGroupExists(pid)) {
          process.kill(-pid, "SIGKILL");
        }
      }
      await provider.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("creates a workspace-profile provider thread and confirms its exact first-turn policy", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.homedir(), ".sedes-codex-c3-create-live-"),
    );
    const codexHome = path.join(temporaryRoot, "codex-home");
    const workingDirectory = path.join(temporaryRoot, "workspace");
    const secureCodexBinary = path.join(temporaryRoot, "codex");
    const provider = await startLocalProvider();
    const openedPids: number[] = [];
    let supervisor: CodexDaemonSupervisor | undefined;

    try {
      await Promise.all([
        mkdir(codexHome, { recursive: true }),
        mkdir(workingDirectory, { recursive: true }),
        link(codexBinary, secureCodexBinary),
      ]);
      await writeFile(
        path.join(codexHome, "config.toml"),
        `
model = "sedes-live-fixture"
model_provider = "sedes_live_fixture"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.sedes_live_fixture]
name = "Sedes live C3 fixture"
base_url = "${provider.baseUrl}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
requires_openai_auth = false

[features]
apps = false
plugins = false
`,
        { encoding: "utf8", mode: 0o600 },
      );

      const scope = Object.freeze({
        tenantId: "tenant-c3-live",
        principalId: "principal-c3-live",
      });
      const instance: AgentBackendInstance = Object.freeze({
        id: "codex-c3-live",
        tenantId: scope.tenantId,
        kind: "codex_app_server",
        label: "Codex C3 live",
        enabled: true,
        configurationRevision: 1,
        protocolRelease: CODEX_APP_SERVER_RELEASE,
      });
      const connection: AgentConnectionProfile = Object.freeze({
        id: "codex-c3-live-profile",
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        templateId: "codex-c3-live-template",
        kind: "codex_app_server",
        backendInstanceId: instance.id,
        executionEnvironmentId: "codex-c3-live-environment",
        label: "Codex C3 live profile",
        enabled: true,
        configurationRevision: 1,
      });
      const environmentChannel = new LocalEnvironmentChannelProvider({
        scope,
        executionEnvironmentId: connection.executionEnvironmentId,
      });
      const resolved = await resolveCodexRuntimeConfiguration({
        scope,
        instance,
        connections: [connection],
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath: secureCodexBinary,
            workingDirectory,
            codexHome,
          },
        },
        environmentChannel,
        environment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
      });
      if (
        resolved.connection.ownership !== "owned" ||
        resolved.codexHome === undefined ||
        resolved.nativeStoreHome === undefined ||
        resolved.childEnvironment === undefined
      ) {
        throw new Error("live_test_expected_owned_connection");
      }
      expect(resolved.connection.channel.executable.version).toBe(
        CODEX_APP_SERVER_RELEASE,
      );

      const runtimeScope: ProviderTransportScope = Object.freeze({
        ...resolved.scope,
        backendInstanceId: instance.id,
        executionEnvironmentId: resolved.executionEnvironmentId,
      });
      const ownedFactory = new OwnedStdioTransportFactory({
        scope: runtimeScope,
        channels: environmentChannel,
        process: resolved.connection.channel.process,
        environment: resolved.childEnvironment,
        sqliteHome: resolved.nativeStoreHome,
        limits: {
          gracefulCloseMilliseconds: 500,
          terminateMilliseconds: 750,
          killMilliseconds: 1_000,
        },
        sensitiveValues: [resolved.codexHome, provider.baseUrl],
      });
      supervisor = new CodexDaemonSupervisor({
        scope: runtimeScope,
        expectedCodexHome: resolved.codexHome,
        transportFactory: captureOwnedPids(ownedFactory, openedPids),
        restartDelaysMilliseconds: [25, 50, 100],
        maximumRestartAttempts: 3,
        nativeStoreOwnership: new CodexNativeStoreOwnershipGate(),
      });
      await supervisor.start();

      const workspace = Object.freeze({
        authorityRevision: 1,
        summary: Object.freeze({
          id: "22000000-0000-4000-8000-000000000001",
          environmentId: connection.executionEnvironmentId,
          displayName: "Codex C3 workspace",
          displayPath: resolved.connection.channel.workingDirectory,
          availability: "available" as const,
          trustState: "trusted" as const,
          revision: 1,
        }),
        canonicalPath: resolved.connection.channel.workingDirectory,
      });
      const ownership = new CodexConversationOwnershipRegistry();
      const observedSettings: CodexObservedExecutionSettings[] = [];
      let selectedSettings: CodexExecutionSettingsTuple = {
        model: "unselected",
        reasoningEffort: "low",
        serviceTier: "standard",
        ...readOnlyPolicy,
      };
      const driver = new CodexConversationBackendDriver({
    usageSink: NO_USAGE_SINK,
    nativeNamespace: "test-codex-store",
        instance,
        connection,
        client: supervisor.client,
        serverRequests: supervisor.serverRequests,
        ownership,
        toolProvenanceKey: new Uint8Array(32).fill(0x43),
        modelPolicy: catalogModelPolicy,
        executionSettings: liveExecutionSettings(
          () => selectedSettings,
          (settings) => observedSettings.push(settings),
        ),
        outputArtifacts: createInMemoryOutputArtifactPublisher(),
        fastModeSessions: new CodexFastModeSessionRegistry(),
        agentToolCliEnvironment:
          unavailableCodexAgentToolCliEnvironmentProvider,
      });
      selectedSettings = {
        ...selectedCatalogSettings(
          (await driver.catalog({ scope, workspace })).models,
        ),
        ...workspacePolicy,
      };

      const created = await driver.create({
        scope,
        applicationThreadId: "sedes-c3-live-create",
        applicationOperationId: "sedes-c3-live-create",
        source: { kind: "user" },
        workspace,
        creationCorrelation: "sedes_c3_live_create",
      });
      expect(created.backendConversationId.length).toBeGreaterThan(0);
      expect(created.opaqueBindingDetail).toBe(
        serializeCodexBindingDetail({
          threadId: created.backendConversationId,
          sessionId: parseCodexBindingDetail(created.opaqueBindingDetail)
            .sessionId,
          nativeAncestry: null,
          correlationAncestorThreadIds: [],
        }),
      );
      expect(observedSettings.at(-1)).toMatchObject({
        networkAccess: "disabled",
        approvalPolicy: "on-request",
        approvalReviewer: "user",
        policyObservation: "complete",
      });

      const binding: ConversationBinding = Object.freeze({
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        applicationThreadId: "23000000-0000-4000-8000-000000000001",
        backendInstanceId: instance.id,
        connectionProfileId: connection.id,
        executionEnvironmentId: connection.executionEnvironmentId,
        backendConversationId: created.backendConversationId,
        createdAt: new Date().toISOString(),
      });
      const handle = await driver.attach({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      try {
        const established = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        expect(established.snapshot.runState).toBe("idle");
        expect(established.snapshot.orderedBackendTurnIds).toEqual([]);

        const completed = nextNotification(
          supervisor.client,
          "turn/completed",
          (params) =>
            isRecord(params) &&
            params.threadId === created.backendConversationId,
        );
        const submission = await handle.submit({
          applicationOperationId: "sedes-c3-live-first-prompt",
          source: { kind: "user" },
          mutationId: "sedes-c3-live-first-mutation",
          reconciliationToken: "sedes-c3-live-first-reconciliation",
          contextExcerpts: [],
          taskContexts: [],
          attachments: [],
          text: "Complete the disposable C3 first prompt.",
        });
        expect(submission).toMatchObject({
          accepted: true,
          reconciliationToken: "sedes-c3-live-first-reconciliation",
          completionCorrelation: "sedes-c3-live-first-prompt",
          backendTurnId: expect.any(String),
        });
        await completed;
        await vi.waitFor(() =>
          expect(observedSettings).toContainEqual(
            expect.objectContaining({
              ...workspacePolicy,
              policyObservation: "complete",
            }),
          ),
        );
        const afterPrompt = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        expect(
          afterPrompt.snapshot.turnsById[submission.backendTurnId!]?.status,
        ).toBe("completed");

        const generationBeforeFork = supervisor.client.lifecycleSnapshot();
        expect(generationBeforeFork.state).toBe("ready");
        const forkCheckpoint = await driver.resolveBranchCheckpoint({
          scope,
          binding,
          workspace,
          opaqueBindingDetail: created.opaqueBindingDetail,
          selection: {
            kind: "selected_completed_turn",
            backendTurnId: submission.backendTurnId!,
            boundary: "completed_turn_inclusive",
          },
        });
        const forked = await driver.branchConversation({
          scope,
          childApplicationThreadId: "sedes-c4-live-fork-child",
          applicationOperationId: "sedes-c4-live-fork-operation",
          source: { kind: "user" },
          sourceBinding: binding,
          sourceOpaqueBindingDetail: created.opaqueBindingDetail,
          workspace,
          sourceCheckpoint: forkCheckpoint,
          creationCorrelation: "sedes_c4_live_fork",
        });
        expect(supervisor.client.lifecycleSnapshot()).toEqual(
          generationBeforeFork,
        );
        const forkDetail = parseCodexBindingDetail(forked.opaqueBindingDetail);
        expect(forkDetail).toMatchObject({
          threadId: forked.backendConversationId,
          sessionId: expect.any(String),
          nativeAncestry: {
            forkedFromThreadId: created.backendConversationId,
            sourceTurnId: expect.any(String),
          },
        });
        const nativeFork = await supervisor.client.request(
          codexThreadReadMethod,
          { threadId: forked.backendConversationId, includeTurns: true },
          requestOptions,
        );
        expect(forkDetail.sessionId).toBe(nativeFork.thread.sessionId);
        expect(nativeFork.thread.forkedFromId).toBe(
          created.backendConversationId,
        );
        expect(nativeFork.thread.turns).toHaveLength(1);
        expect(nativeFork.thread.turns[0]).toMatchObject({
          status: "completed",
          itemsView: "full",
          items: expect.arrayContaining([
            expect.objectContaining({ type: "userMessage" }),
            expect.objectContaining({ type: "agentMessage" }),
          ]),
        });
        // Prove durability before the first child attachment: retiring the
        // source's last lease cannot lose the unopened fork's native history.
        await handle.close({ reason: "evicted" });
        expect(supervisor.snapshot().state).toBe("idle");
        await supervisor.wake();
        expect(supervisor.snapshot().generation).toBeGreaterThan(generationBeforeFork.generation);
        const restoredFork = await supervisor.client.request(
          codexThreadReadMethod,
          { threadId: forked.backendConversationId, includeTurns: true },
          requestOptions,
        );
        expect(restoredFork.thread.id).toBe(nativeFork.thread.id);
        expect(restoredFork.thread.sessionId).toBe(nativeFork.thread.sessionId);
        expect(restoredFork.thread.turns).toEqual(nativeFork.thread.turns);
        // This fixture constructs the raw driver; production's factory holds
        // these same semantic-operation leases around reads and attachment.
        const projectedFork = await supervisor.client.residency!.run(() => driver.read({
          scope,
          binding: {
            ...binding,
            applicationThreadId: "sedes-c4-live-fork-child",
            backendConversationId: forked.backendConversationId,
          },
          workspace,
          opaqueBindingDetail: forked.opaqueBindingDetail,
        }));
        expect(projectedFork.snapshot.orderedBackendTurnIds).toHaveLength(1);
        expect(projectedFork.snapshot.runState).toBe("idle");
        const childHandle = await supervisor.client.residency!.run(() => driver.attach({
          scope,
          binding: {
            ...binding,
            applicationThreadId: "sedes-c4-live-fork-child",
            backendConversationId: forked.backendConversationId,
          },
          workspace,
          opaqueBindingDetail: forked.opaqueBindingDetail,
        }));
        try {
          const establishedChild = await childHandle.establishProjection({
            signal: new AbortController().signal,
          });
          expect(establishedChild.snapshot.orderedBackendTurnIds).toHaveLength(
            1,
          );
        } finally {
          await childHandle.close();
        }
      } finally {
        await handle.close();
      }

      await supervisor.close();
      await waitUntil(
        () =>
          openedPids.every(
            (pid) => !processExists(pid) && !processGroupExists(pid),
          ),
        5_000,
      );
    } finally {
      await supervisor?.close().catch(() => undefined);
      for (const pid of openedPids) {
        if (processGroupExists(pid)) {
          process.kill(-pid, "SIGKILL");
        }
      }
      await provider.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("connects to an exact-release external UDS listener, fences replacement, and never owns the daemon", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.homedir(), ".sedes-codex-uds-live-"),
    );
    const codexHome = path.join(temporaryRoot, "codex-home");
    const workingDirectory = path.join(temporaryRoot, "workspace");
    const socketDirectory = path.join(temporaryRoot, "socket");
    const socketPath = path.join(socketDirectory, "app-server.sock");
    const secureCodexBinary = path.join(temporaryRoot, "codex");
    const provider = await startLocalProvider();
    const scope = Object.freeze({
      tenantId: "tenant-uds-live",
      principalId: "principal-uds-live",
    });
    const runtimeScope: ProviderTransportScope = Object.freeze({
      ...scope,
      backendInstanceId: "codex-uds-live",
      executionEnvironmentId: "codex-uds-live-environment",
    });
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: runtimeScope.executionEnvironmentId,
    });
    let external: ExternalCodexUdsProcess | undefined;
    let observer: WebSocket | undefined;
    let supervisor: CodexDaemonSupervisor | undefined;

    try {
      await Promise.all([
        mkdir(codexHome, { recursive: true }),
        mkdir(workingDirectory, { recursive: true }),
        mkdir(socketDirectory, { recursive: true, mode: 0o700 }),
        link(codexBinary, secureCodexBinary),
      ]);
      await chmod(socketDirectory, 0o700);
      await writeFile(
        path.join(codexHome, "config.toml"),
        `
model = "sedes-live-fixture"
model_provider = "sedes_live_fixture"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.sedes_live_fixture]
name = "Sedes live UDS fixture"
base_url = "${provider.baseUrl}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
requires_openai_auth = false

[features]
apps = false
plugins = false
`,
        { encoding: "utf8", mode: 0o600 },
      );

      external = await startExternalCodexUds({
        executablePath: secureCodexBinary,
        codexHome,
        workingDirectory,
        socketPath,
      });
      const initialPid = external.pid;
      const socketMetadata = await lstat(socketPath);
      expect(socketMetadata.isSocket()).toBe(true);
      expect(socketMetadata.mode & 0o777).toBe(0o600);

      const transportFactory = new UnixWebSocketTransportFactory({
        scope: runtimeScope,
        channels: environmentChannel,
        socketPath,
        limits: { handshakeTimeoutMilliseconds: 2_000 },
      });
      supervisor = externalSupervisor({
        scope: runtimeScope,
        transportFactory,
      });
      await supervisor.start();
      expect(supervisor.snapshot()).toMatchObject({
        state: "ready",
        generation: 1,
      });
      const initialRead = await supervisor.client.request(
        codexThreadListMethod,
        { limit: 1, sourceKinds: [], useStateDbOnly: true },
        requestOptions,
      );
      expect(initialRead.data).toEqual([]);

      observer = await openExternalObserver(socketPath, codexHome);
      expect(observer.readyState).toBe(WebSocket.OPEN);

      await external.stop();
      external = undefined;
      await waitUntil(() => supervisor?.snapshot().state === "backoff", 5_000);
      expect(processExists(initialPid)).toBe(false);
      await closeObserver(observer);
      observer = undefined;

      external = await startExternalCodexUds({
        executablePath: secureCodexBinary,
        codexHome,
        workingDirectory,
        socketPath,
      });
      await waitUntil(() => {
        const snapshot = supervisor?.snapshot();
        return snapshot?.state === "ready" && snapshot.generation > 1
          ? snapshot
          : undefined;
      }, 10_000);
      expect(supervisor.snapshot().generation).toBeGreaterThan(1);
      await expect(
        supervisor.client.request(
          codexThreadListMethod,
          { limit: 1, sourceKinds: [], useStateDbOnly: true },
          requestOptions,
        ),
      ).resolves.toMatchObject({ data: [] });
      const udsThread = await supervisor.client.request(
        codexThreadStartMethod,
        {
          cwd: workingDirectory,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          threadSource: "sedes_c5b_live_uds",
        },
        requestOptions,
      );
      const udsCompleted = nextNotification(
        supervisor.client,
        "turn/completed",
        (params) => isRecord(params) && params.threadId === udsThread.thread.id,
      );
      await supervisor.client.request(
        codexTurnStartMethod,
        {
          threadId: udsThread.thread.id,
          clientUserMessageId: "sedes-c5b-live-uds-message",
          input: [
            {
              type: "text",
              text: "Complete the disposable C5b UDS turn.",
              text_elements: [],
            },
          ],
        },
        requestOptions,
      );
      await udsCompleted;
      expect(provider.requestCount()).toBeGreaterThan(0);
      await supervisor.client.request(
        codexThreadUnsubscribeMethod,
        { threadId: udsThread.thread.id },
        requestOptions,
      );

      const replacementPid = external.pid;
      await supervisor.close();
      supervisor = undefined;
      expect(processExists(replacementPid)).toBe(true);
      await expect(
        lstat(path.join(codexHome, ".sedes-codex-runtime.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const restartedSedesClient = externalSupervisor({
        scope: runtimeScope,
        transportFactory,
      });
      supervisor = restartedSedesClient;
      await restartedSedesClient.start();
      expect(restartedSedesClient.snapshot()).toMatchObject({
        state: "ready",
        generation: 1,
      });
      await restartedSedesClient.close();
      supervisor = undefined;
      expect(processExists(replacementPid)).toBe(true);
    } finally {
      await supervisor?.close().catch(() => undefined);
      await closeObserver(observer).catch(() => undefined);
      await external?.stop().catch(() => undefined);
      environmentChannel.close();
      await provider.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it("creates and observes low-reasoning work through an authenticated exact-release TCP listener without owning it", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.homedir(), ".sedes-codex-tcp-live-"),
    );
    const codexHome = path.join(temporaryRoot, "codex-home");
    const workingDirectory = path.join(temporaryRoot, "workspace");
    const tokenPath = path.join(temporaryRoot, "app-server-token");
    const secureCodexBinary = path.join(temporaryRoot, "codex");
    let token = randomBytes(32).toString("base64url");
    const port = await availableTcpPort();
    const url = `ws://127.0.0.1:${port}`;
    const provider = await startLocalProvider();
    const scope = Object.freeze({
      tenantId: "tenant-tcp-live",
      principalId: "principal-tcp-live",
    });
    const runtimeScope: ProviderTransportScope = Object.freeze({
      ...scope,
      backendInstanceId: "codex-tcp-live",
      executionEnvironmentId: "codex-tcp-live-environment",
    });
    const environmentChannel = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: runtimeScope.executionEnvironmentId,
    });
    const transportFactory = new TcpWebSocketTransportFactory({
      scope: runtimeScope,
      channels: environmentChannel,
      url,
      secretReference: { source: "protected_file", path: tokenPath },
      limits: { handshakeTimeoutMilliseconds: 2_000 },
    });
    let external: ExternalCodexTcpProcess | undefined;
    let observer: WebSocket | undefined;
    let supervisor: CodexDaemonSupervisor | undefined;

    try {
      await Promise.all([
        mkdir(codexHome, { recursive: true }),
        mkdir(workingDirectory, { recursive: true }),
        link(codexBinary, secureCodexBinary),
        writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 }),
      ]);
      const tokenMetadata = await lstat(tokenPath);
      expect(tokenMetadata.isFile()).toBe(true);
      expect(tokenMetadata.mode & 0o777).toBe(0o600);
      await writeFile(
        path.join(codexHome, "config.toml"),
        `
model = "gpt-5.6-luna"
model_provider = "sedes_live_fixture"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.sedes_live_fixture]
name = "Sedes live authenticated TCP fixture"
base_url = "${provider.baseUrl}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
requires_openai_auth = false

[features]
apps = false
plugins = false
`,
        { encoding: "utf8", mode: 0o600 },
      );

      external = await startExternalCodexTcp({
        executablePath: secureCodexBinary,
        codexHome,
        workingDirectory,
        url,
        port,
        tokenPath,
        token,
      });
      const initialExternalPid = external.pid;
      supervisor = externalSupervisor({
        scope: runtimeScope,
        transportFactory,
      });
      await supervisor.start();
      expect(supervisor.snapshot()).toMatchObject({
        state: "ready",
        generation: 1,
      });

      observer = await openExternalTcpObserver(url, token, codexHome);
      expect(observer.readyState).toBe(WebSocket.OPEN);

      const started = await supervisor.client.request(
        codexThreadStartMethod,
        {
          model: "gpt-5.6-luna",
          cwd: workingDirectory,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          threadSource: "sedes_c5c_live_tcp",
        },
        requestOptions,
      );
      const firstCompleted = nextNotification(
        supervisor.client,
        "turn/completed",
        (params) => isRecord(params) && params.threadId === started.thread.id,
      );
      await supervisor.client.request(
        codexTurnStartMethod,
        {
          threadId: started.thread.id,
          clientUserMessageId: "sedes-c5c-live-tcp-first",
          input: [
            {
              type: "text",
              text: "Complete the first disposable authenticated TCP turn.",
              text_elements: [],
            },
          ],
          model: "gpt-5.6-luna",
          effort: "low",
        },
        requestOptions,
      );
      await firstCompleted;

      const observerResume = observerResponse(observer, "observer-resume");
      observer.send(
        JSON.stringify({
          id: "observer-resume",
          method: "thread/resume",
          params: { threadId: started.thread.id },
        }),
      );
      await expect(observerResume).resolves.toMatchObject({
        result: { thread: { id: started.thread.id } },
      });
      const sedesCompleted = nextNotification(
        supervisor.client,
        "turn/completed",
        (params) => isRecord(params) && params.threadId === started.thread.id,
      );
      const observerCompleted = observerNotification(
        observer,
        "turn/completed",
        (params) => isRecord(params) && params.threadId === started.thread.id,
      );
      await supervisor.client.request(
        codexTurnStartMethod,
        {
          threadId: started.thread.id,
          clientUserMessageId: "sedes-c5c-live-tcp-observed",
          input: [
            {
              type: "text",
              text: "Complete the second disposable authenticated TCP turn.",
              text_elements: [],
            },
          ],
          model: "gpt-5.6-luna",
          effort: "low",
        },
        requestOptions,
      );
      await Promise.all([sedesCompleted, observerCompleted]);
      expect(provider.requestCount()).toBe(2);

      const replacementLifecycle: Array<{
        readonly state: string;
        readonly generation: number;
      }> = [];
      const unsubscribeReplacementLifecycle =
        supervisor.client.subscribeLifecycle(({ state, generation }) => {
          replacementLifecycle.push({ state, generation });
        });
      await external.stop();
      external = undefined;
      await waitUntil(
        () =>
          replacementLifecycle.some(({ state }) => state === "unavailable") ||
          undefined,
        5_000,
      );
      await expect(
        supervisor.client.request(
          codexThreadListMethod,
          { limit: 1, sourceKinds: [], useStateDbOnly: true },
          requestOptions,
        ),
      ).rejects.toMatchObject({ delivery: "not_sent" });
      await waitUntil(
        () => observer?.readyState === WebSocket.CLOSED || undefined,
        5_000,
      );
      expect(processExists(initialExternalPid)).toBe(false);
      expect(processGroupExists(initialExternalPid)).toBe(false);
      observer = undefined;

      token = randomBytes(32).toString("base64url");
      await writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 });
      external = await startExternalCodexTcp({
        executablePath: secureCodexBinary,
        codexHome,
        workingDirectory,
        url,
        port,
        tokenPath,
        token,
      });
      const replacementExternalPid = external.pid;
      expect(replacementExternalPid).not.toBe(initialExternalPid);
      const replacement = await waitUntil(() => {
        const snapshot = supervisor?.snapshot();
        return snapshot?.state === "ready" && snapshot.generation > 1
          ? snapshot
          : undefined;
      }, 20_000);
      expect(replacement).toMatchObject({
        state: "ready",
      });
      expect(
        replacementLifecycle.some(
          ({ state, generation }) => state === "reconciling" && generation > 1,
        ),
      ).toBe(true);
      unsubscribeReplacementLifecycle();
      await expect(
        supervisor.client.request(
          codexThreadReadMethod,
          { threadId: started.thread.id, includeTurns: true },
          requestOptions,
        ),
      ).resolves.toMatchObject({
        thread: {
          id: started.thread.id,
          turns: expect.arrayContaining([
            expect.objectContaining({ status: "completed" }),
          ]),
        },
      });
      await expect(
        supervisor.client.request(
          codexThreadResumeMethod,
          { threadId: started.thread.id },
          requestOptions,
        ),
      ).resolves.toMatchObject({ thread: { id: started.thread.id } });

      observer = await openExternalTcpObserver(url, token, codexHome);
      const replacementObserverResume = observerResponse(
        observer,
        "replacement-observer-resume",
      );
      observer.send(
        JSON.stringify({
          id: "replacement-observer-resume",
          method: "thread/resume",
          params: { threadId: started.thread.id },
        }),
      );
      await expect(replacementObserverResume).resolves.toMatchObject({
        result: { thread: { id: started.thread.id } },
      });
      const replacementSedesCompleted = nextNotification(
        supervisor.client,
        "turn/completed",
        (params) => isRecord(params) && params.threadId === started.thread.id,
      );
      const replacementObserverCompleted = observerNotification(
        observer,
        "turn/completed",
        (params) => isRecord(params) && params.threadId === started.thread.id,
      );
      await supervisor.client.request(
        codexTurnStartMethod,
        {
          threadId: started.thread.id,
          clientUserMessageId: "sedes-c5c-live-tcp-replacement",
          input: [
            {
              type: "text",
              text: "Complete the authenticated replacement-generation turn.",
              text_elements: [],
            },
          ],
          model: "gpt-5.6-luna",
          effort: "low",
        },
        requestOptions,
      );
      await Promise.all([
        replacementSedesCompleted,
        replacementObserverCompleted,
      ]);
      expect(provider.requestCount()).toBe(3);

      await supervisor.client.request(
        codexThreadUnsubscribeMethod,
        { threadId: started.thread.id },
        requestOptions,
      );
      await supervisor.close();
      supervisor = undefined;
      expect(processExists(replacementExternalPid)).toBe(true);
      await expect(
        lstat(path.join(codexHome, ".sedes-codex-runtime.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const observerRead = observerResponse(observer, "observer-read");
      observer.send(
        JSON.stringify({
          id: "observer-read",
          method: "thread/read",
          params: { threadId: started.thread.id, includeTurns: false },
        }),
      );
      await expect(observerRead).resolves.toMatchObject({
        result: { thread: { id: started.thread.id } },
      });

      supervisor = externalSupervisor({
        scope: runtimeScope,
        transportFactory,
      });
      await supervisor.start();
      expect(supervisor.snapshot()).toMatchObject({
        state: "ready",
        generation: 1,
      });
      await expect(
        supervisor.client.request(
          codexThreadListMethod,
          { limit: 1, sourceKinds: [], useStateDbOnly: true },
          requestOptions,
        ),
      ).resolves.toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({ id: started.thread.id }),
        ]),
      });
      await supervisor.close();
      supervisor = undefined;
      expect(processExists(replacementExternalPid)).toBe(true);

      await closeObserver(observer);
      observer = undefined;
      await external.stop();
      external = undefined;
      expect(processExists(replacementExternalPid)).toBe(false);
      expect(processGroupExists(replacementExternalPid)).toBe(false);
    } finally {
      await supervisor?.close().catch(() => undefined);
      await closeObserver(observer).catch(() => undefined);
      await external?.stop().catch(() => undefined);
      environmentChannel.close();
      await provider.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!configuredSharedUdsLiveEndpoint)(
    "creates and streams a disposable low-reasoning agent through an operator-owned UDS daemon",
    async () => {
      const configured = configuredSharedUdsLiveEndpoint!;
      const workingDirectory = await mkdtemp(
        path.join(os.tmpdir(), "sedes-codex-shared-uds-live-"),
      );
      const scope = Object.freeze({
        tenantId: "tenant-shared-uds-live",
        principalId: "principal-shared-uds-live",
      });
      const runtimeScope: ProviderTransportScope = Object.freeze({
        ...scope,
        backendInstanceId: "codex-shared-uds-live",
        executionEnvironmentId: "codex-shared-uds-live-environment",
      });
      const environmentChannel = new LocalEnvironmentChannelProvider({
        scope,
        executionEnvironmentId: runtimeScope.executionEnvironmentId,
      });
      const before = await lstat(configured.socketPath, { bigint: true });
      let observer: WebSocket | undefined;
      let supervisor: CodexDaemonSupervisor | undefined;

      try {
        supervisor = externalSupervisor({
          scope: runtimeScope,
          transportFactory: new UnixWebSocketTransportFactory({
            scope: runtimeScope,
            channels: environmentChannel,
            socketPath: configured.socketPath,
          }),
        });
        await supervisor.start();
        observer = await openExternalObserver(
          configured.socketPath,
          undefined,
          { accountType: "chatgpt", requiresOpenaiAuth: true },
        );

        const started = await supervisor.client.request(
          codexThreadStartMethod,
          {
            model: configured.model,
            cwd: workingDirectory,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: false,
            threadSource: "sedes_c5b_shared_uds_live",
          },
          requestOptions,
        );
        const streamed = nextNotification(
          supervisor.client,
          "item/agentMessage/delta",
          (params) => isRecord(params) && params.threadId === started.thread.id,
          120_000,
        );
        const completed = nextNotification(
          supervisor.client,
          "turn/completed",
          (params) => isRecord(params) && params.threadId === started.thread.id,
          120_000,
        );
        await supervisor.client.request(
          codexTurnStartMethod,
          {
            threadId: started.thread.id,
            clientUserMessageId: `sedes-c5b-shared-uds-${randomFixtureId()}`,
            input: [
              {
                type: "text",
                text: "Reply with a short confirmation that this disposable C5b UDS agent can stream.",
                text_elements: [],
              },
            ],
            model: configured.model,
            effort: "low",
          },
          requestOptions,
        );
        await Promise.all([streamed, completed]);
        await supervisor.client.request(
          codexThreadUnsubscribeMethod,
          { threadId: started.thread.id },
          requestOptions,
        );

        await closeObserver(observer);
        observer = undefined;
        await supervisor.close();
        supervisor = undefined;
        const after = await lstat(configured.socketPath, { bigint: true });
        expect(after.isSocket()).toBe(true);
        expect({ device: after.dev, inode: after.ino }).toEqual({
          device: before.dev,
          inode: before.ino,
        });
        const afterCloseObserver = await openExternalObserver(
          configured.socketPath,
          undefined,
          { accountType: "chatgpt", requiresOpenaiAuth: true },
        );
        await closeObserver(afterCloseObserver);
      } finally {
        await supervisor?.close().catch(() => undefined);
        await closeObserver(observer).catch(() => undefined);
        environmentChannel.close();
        await rm(workingDirectory, { recursive: true, force: true });
      }
    },
    150_000,
  );

  it.skipIf(!configuredSharedUdsLiveEndpoint || !generatedImageLiveEnabled)(
    "publishes one real generated image through the normalized Codex artifact path",
    async () => {
      const configured = configuredSharedUdsLiveEndpoint!;
      const workingDirectory = await mkdtemp(
        path.join(os.tmpdir(), "sedes-codex-generated-image-live-"),
      );
      const scope = Object.freeze({
        tenantId: "tenant-generated-image-live",
        principalId: "principal-generated-image-live",
      });
      const runtimeScope: ProviderTransportScope = Object.freeze({
        ...scope,
        backendInstanceId: "codex-generated-image-live",
        executionEnvironmentId: "codex-generated-image-live-environment",
      });
      const environmentChannel = new LocalEnvironmentChannelProvider({
        scope,
        executionEnvironmentId: runtimeScope.executionEnvironmentId,
      });
      let supervisor: CodexDaemonSupervisor | undefined;

      try {
        supervisor = externalSupervisor({
          scope: runtimeScope,
          transportFactory: new UnixWebSocketTransportFactory({
            scope: runtimeScope,
            channels: environmentChannel,
            socketPath: configured.socketPath,
          }),
        });
        await supervisor.start();
        const started = await supervisor.client.request(
          codexThreadStartMethod,
          {
            model: configured.model,
            cwd: workingDirectory,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: false,
            threadSource: "sedes_generated_image_live",
          },
          requestOptions,
        );
        const completed = nextNotification(
          supervisor.client,
          "turn/completed",
          (params) => isRecord(params) && params.threadId === started.thread.id,
          180_000,
        );
        await supervisor.client.request(
          codexTurnStartMethod,
          {
            threadId: started.thread.id,
            clientUserMessageId: `sedes-generated-image-${randomFixtureId()}`,
            input: [
              {
                type: "text",
                text: "Use the imagegen skill to generate exactly one simple image of a solid red square. Do not use any other tool. When it is complete, reply exactly `image-ready`.",
                text_elements: [],
              },
            ],
            model: configured.model,
            effort: "low",
          },
          requestOptions,
        );
        await completed;
        const read = await supervisor.client.request(
          codexThreadReadMethod,
          { threadId: started.thread.id, includeTurns: true },
          { timeoutMilliseconds: 30_000 },
        );
        const nativeImage = read.thread.turns
          .flatMap(({ items }) => items)
          .find(
            (item) =>
              item.type === "imageGeneration" && item.status === "completed",
          );
        expect(nativeImage).toMatchObject({
          type: "imageGeneration",
          status: "completed",
          result: expect.any(String),
        });
        if (
          !nativeImage ||
          nativeImage.type !== "imageGeneration" ||
          nativeImage.status !== "completed" ||
          typeof nativeImage.result !== "string"
        ) {
          throw new Error("codex_live_generated_image_missing");
        }

        const stored = createInMemoryOutputArtifactPublisher();
        const publications: Uint8Array[] = [];
        const outputArtifacts = {
          findImage: stored.findImage,
          publishImage: async (
            input: Parameters<typeof stored.publishImage>[0],
          ) => {
            publications.push(input.bytes);
            return await stored.publishImage(input);
          },
        };
        const context = {
          scope,
          applicationThreadId: randomUUID(),
          outputArtifacts,
          verifiedPublicationKeys: new Set<string>(),
        } as const;
        const planned = projectCodexHistory(
          read.thread,
          {
            toolProvenanceKey: new Uint8Array(32).fill(0x69),
            ...scope,
            backendInstanceId: runtimeScope.backendInstanceId,
            nativeThreadId: started.thread.id,
            correlationAncestorThreadIds: [],
          },
          new Map(),
          context,
        );
        const projected = await materializeCodexGeneratedImagePublications(
          planned,
          context,
        );
        const artifact = Object.values(projected.snapshot.itemsById).find(
          (item) =>
            item.semanticKind === "image" &&
            item.image.representation === "artifact",
        );
        expect(artifact).toMatchObject({
          semanticKind: "image",
          image: {
            representation: "artifact",
            mimeType: "image/png",
            byteSize: publications[0]?.byteLength,
          },
        });
        expect(publications).toHaveLength(1);
        const normalized = JSON.stringify(projected.snapshot);
        expect(normalized).not.toContain(nativeImage.result);
        if (nativeImage.savedPath !== null) {
          expect(normalized).not.toContain(nativeImage.savedPath);
        }
        await supervisor.client.request(
          codexThreadUnsubscribeMethod,
          { threadId: started.thread.id },
          requestOptions,
        );
      } finally {
        await supervisor?.close().catch(() => undefined);
        environmentChannel.close();
        await rm(workingDirectory, { recursive: true, force: true });
      }
    },
    210_000,
  );
});

function readSharedUdsLiveEndpoint():
  | Readonly<{
      socketPath: string;
      model: "gpt-5.6-luna";
    }>
  | undefined {
  const socketPath = process.env.SEDES_REAL_CODEX_UDS_SOCKET;
  const model = process.env.SEDES_REAL_CODEX_UDS_MODEL;
  if (!socketPath && !model) return undefined;
  if (
    !socketPath ||
    model !== "gpt-5.6-luna" ||
    !path.isAbsolute(socketPath) ||
    path.resolve(socketPath) !== socketPath
  ) {
    throw new Error("codex_shared_uds_live_gate_invalid");
  }
  return Object.freeze({ socketPath, model });
}

function randomFixtureId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type ExternalCodexUdsProcess = Readonly<{
  readonly pid: number;
  stop(): Promise<void>;
}>;

type ExternalCodexTcpProcess = Readonly<{
  readonly pid: number;
  stop(): Promise<void>;
}>;

async function startExternalCodexUds(input: {
  readonly executablePath: string;
  readonly codexHome: string;
  readonly workingDirectory: string;
  readonly socketPath: string;
}): Promise<ExternalCodexUdsProcess> {
  await removeFixtureSocket(input.socketPath);
  const child = spawn(
    input.executablePath,
    [
      "app-server",
      "--config",
      `sqlite_home=${JSON.stringify(input.codexHome)}`,
      "--strict-config",
      "--listen",
      `unix://${input.socketPath}`,
    ],
    {
      cwd: input.workingDirectory,
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: input.codexHome,
        CODEX_HOME: input.codexHome,
        CODEX_SQLITE_HOME: input.codexHome,
        NO_COLOR: "1",
        TERM: "dumb",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
  });
  await new Promise<void>((resolve, reject) => {
    const spawned = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("codex_uds_live_spawn_failed"));
    };
    const cleanup = () => {
      child.removeListener("spawn", spawned);
      child.removeListener("error", failed);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
  const pid = child.pid;
  if (!pid) throw new Error("codex_uds_live_pid_unavailable");
  try {
    await waitUntil(async () => {
      if (!processExists(pid)) {
        throw new Error(
          `codex_uds_live_exited:${stderrTail.replaceAll(input.codexHome, "[redacted]")}`,
        );
      }
      try {
        const metadata = await lstat(input.socketPath);
        // The exact app-server creates the filesystem node before applying its
        // private mode. Treat only the final assured identity as listener-ready.
        return metadata.isSocket() && (metadata.mode & 0o777) === 0o600
          ? true
          : undefined;
      } catch (error) {
        if (isErrno(error, "ENOENT")) return undefined;
        throw error;
      }
    }, 5_000);
  } catch (error) {
    await stopExternalProcess(child, pid);
    throw error;
  }
  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    pid,
    stop: () => {
      stopPromise ??= stopExternalProcess(child, pid).finally(() =>
        removeFixtureSocket(input.socketPath),
      );
      return stopPromise;
    },
  });
}

async function startExternalCodexTcp(input: {
  readonly executablePath: string;
  readonly codexHome: string;
  readonly workingDirectory: string;
  readonly url: string;
  readonly port: number;
  readonly tokenPath: string;
  readonly token: string;
}): Promise<ExternalCodexTcpProcess> {
  const child = spawn(
    input.executablePath,
    [
      "app-server",
      "--config",
      `sqlite_home=${JSON.stringify(input.codexHome)}`,
      "--strict-config",
      "--listen",
      input.url,
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      input.tokenPath,
    ],
    {
      cwd: input.workingDirectory,
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: input.codexHome,
        CODEX_HOME: input.codexHome,
        CODEX_SQLITE_HOME: input.codexHome,
        NO_COLOR: "1",
        TERM: "dumb",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
  });
  await new Promise<void>((resolve, reject) => {
    const spawned = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("codex_tcp_live_spawn_failed"));
    };
    const cleanup = () => {
      child.removeListener("spawn", spawned);
      child.removeListener("error", failed);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
  const pid = child.pid;
  if (!pid) throw new Error("codex_tcp_live_pid_unavailable");
  try {
    await waitUntil(async () => {
      if (!processExists(pid)) {
        const safeTail = stderrTail
          .replaceAll(input.codexHome, "[redacted-home]")
          .replaceAll(input.token, "[redacted-token]");
        throw new Error(`codex_tcp_live_exited:${safeTail}`);
      }
      return (await tcpListenerAvailable(input.port)) || undefined;
    }, 5_000);
  } catch (error) {
    await stopExternalProcess(child, pid);
    throw error;
  }
  let stopPromise: Promise<void> | undefined;
  return Object.freeze({
    pid,
    stop: () => {
      stopPromise ??= stopExternalProcess(child, pid);
      return stopPromise;
    },
  });
}

function externalSupervisor(input: {
  readonly scope: ProviderTransportScope;
  readonly transportFactory: FramedTransportFactory;
}): CodexDaemonSupervisor {
  return new CodexDaemonSupervisor({
    ...input,
    restartDelaysMilliseconds: [25, 50, 100],
    maximumRestartAttempts: "unbounded",
    initializationTimeoutMilliseconds: 5_000,
    shutdownTimeoutMilliseconds: 3_000,
  });
}

async function openExternalObserver(
  socketPath: string,
  expectedCodexHome: string | undefined,
  requiredAccountState: Readonly<{
    accountType: "chatgpt" | null;
    requiresOpenaiAuth: boolean;
  }> = { accountType: null, requiresOpenaiAuth: false },
): Promise<WebSocket> {
  const observer = new WebSocket(`ws+unix://${socketPath}:/`, {
    perMessageDeflate: false,
    handshakeTimeout: 2_000,
    maxPayload: 8 * 1024 * 1024,
  });
  await waitForObserverOpen(observer);
  return await initializeExternalObserver(
    observer,
    expectedCodexHome,
    requiredAccountState,
    "sedes_c5b_observer",
    "Sedes C5b observer",
  );
}

async function openExternalTcpObserver(
  url: string,
  token: string,
  codexHome: string,
): Promise<WebSocket> {
  const observer = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
    perMessageDeflate: false,
    handshakeTimeout: 2_000,
    maxPayload: 8 * 1024 * 1024,
  });
  await waitForObserverOpen(observer);
  return await initializeExternalObserver(
    observer,
    codexHome,
    { accountType: null, requiresOpenaiAuth: false },
    "sedes_c5c_observer",
    "Sedes C5c observer",
  );
}

async function initializeExternalObserver(
  observer: WebSocket,
  expectedCodexHome: string | undefined,
  requiredAccountState: Readonly<{
    accountType: "chatgpt" | null;
    requiresOpenaiAuth: boolean;
  }>,
  clientName: string,
  clientTitle: string,
): Promise<WebSocket> {
  const initializeResponse = observerResponse(observer, "observer-initialize");
  observer.send(
    JSON.stringify({
      id: "observer-initialize",
      method: "initialize",
      params: {
        clientInfo: {
          name: clientName,
          title: clientTitle,
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      },
    }),
  );
  const initialized = await initializeResponse;
  expect(initialized).toMatchObject({
    result: {
      codexHome: expectedCodexHome ?? expect.any(String),
    },
  });
  observer.send(JSON.stringify({ method: "initialized" }));
  const accountResponse = observerResponse(observer, "observer-account");
  observer.send(
    JSON.stringify({
      id: "observer-account",
      method: "account/read",
      params: { refreshToken: false },
    }),
  );
  const account = await accountResponse;
  const result = isRecord(account.result) ? account.result : undefined;
  const accountValue = result?.account;
  const accountType = isRecord(accountValue)
    ? accountValue.type
    : accountValue === null
      ? null
      : undefined;
  if (
    accountType !== requiredAccountState.accountType ||
    result?.requiresOpenaiAuth !== requiredAccountState.requiresOpenaiAuth
  ) {
    observer.terminate();
    throw new Error("codex_observer_account_identity_mismatch");
  }
  return observer;
}

async function waitForObserverOpen(observer: WebSocket): Promise<void> {
  if (observer.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      observer.terminate();
      reject(new Error("codex_uds_observer_open_timeout"));
    }, 3_000);
    const cleanup = () => {
      clearTimeout(timer);
      observer.removeListener("open", opened);
      observer.removeListener("error", failed);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("codex_uds_observer_open_failed"));
    };
    observer.once("open", opened);
    observer.once("error", failed);
  });
}

async function observerResponse(
  observer: WebSocket,
  expectedId: string,
): Promise<Readonly<Record<string, unknown>>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("codex_uds_observer_response_timeout"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timer);
      observer.removeListener("message", message);
      observer.removeListener("close", closed);
    };
    const message = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(data as Buffer).toString("utf8"));
      } catch {
        return;
      }
      if (!isRecord(parsed) || parsed.id !== expectedId) return;
      cleanup();
      resolve(parsed);
    };
    const closed = () => {
      cleanup();
      reject(new Error("codex_uds_observer_closed"));
    };
    observer.on("message", message);
    observer.once("close", closed);
  });
}

async function observerNotification(
  observer: WebSocket,
  expectedMethod: string,
  predicate: (params: unknown) => boolean,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`codex_observer_notification_timeout:${expectedMethod}`),
      );
    }, timeoutMilliseconds);
    const cleanup = () => {
      clearTimeout(timer);
      observer.removeListener("message", message);
      observer.removeListener("close", closed);
    };
    const message = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(data as Buffer).toString("utf8"));
      } catch {
        return;
      }
      if (
        !isRecord(parsed) ||
        parsed.method !== expectedMethod ||
        !predicate(parsed.params)
      ) {
        return;
      }
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new Error("codex_observer_closed"));
    };
    observer.on("message", message);
    observer.once("close", closed);
  });
}

async function closeObserver(observer: WebSocket | undefined): Promise<void> {
  if (!observer || observer.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) =>
    observer.once("close", resolve),
  );
  if (observer.readyState === WebSocket.OPEN) observer.close(1000);
  else observer.terminate();
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 1_000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!settled) observer.terminate();
}

async function stopExternalProcess(
  child: ChildProcess,
  pid: number,
): Promise<void> {
  if (!processExists(pid) && !processGroupExists(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!isErrno(error, "ESRCH")) throw error;
  }
  if (!(await waitForChildExit(child, 3_000)) && processGroupExists(pid)) {
    process.kill(-pid, "SIGKILL");
    await waitForChildExit(child, 2_000);
  }
  await waitUntil(
    () => (!processExists(pid) && !processGroupExists(pid)) || undefined,
    3_000,
  );
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function removeFixtureSocket(socketPath: string): Promise<void> {
  try {
    const metadata = await lstat(socketPath);
    if (!metadata.isSocket()) {
      throw new Error("codex_uds_live_socket_path_not_socket");
    }
    await unlink(socketPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function captureOwnedPids(
  ownedFactory: OwnedStdioTransportFactory,
  openedPids: number[],
): FramedTransportFactory {
  return Object.freeze({
    async open(
      expectedScope: ProviderTransportScope,
      connectionGeneration: number,
      signal: AbortSignal,
    ) {
      const transport = await ownedFactory.open(
        expectedScope,
        connectionGeneration,
        signal,
      );
      if (transport.assurance.kind !== "owned_process") {
        await transport.close("live_test_invalid_transport");
        throw new Error("live_test_expected_owned_process");
      }
      const processIdentity =
        transport.assurance.environmentChannelIdentity.providerProcessIdentity;
      if (processIdentity.type !== "local_process_group") {
        await transport.close("live_test_invalid_platform");
        throw new Error("live_test_requires_posix_process_group");
      }
      openedPids.push(processIdentity.processGroupId);
      return transport;
    },
  });
}

async function nextNotification(
  client: CodexDaemonSupervisor["client"],
  method: string,
  predicate: (params: unknown) => boolean,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`live_test_notification_timeout:${method}`));
    }, timeoutMilliseconds);
    const unsubscribe = client.subscribeNotifications((notification) => {
      if (
        notification.kind !== "decoded_notification" ||
        notification.method !== method ||
        !predicate(notification.params)
      ) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function startLocalProvider(): Promise<{
  readonly baseUrl: string;
  requestCount(): number;
  holdNextResponse(): void;
  failNextResponse(): void;
  heldResponseCloseCount(): number;
  close(): Promise<void>;
}> {
  let requests = 0;
  let holdNextResponse = false;
  let failNextResponse = false;
  let heldResponseCloses = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.once("end", () => {
      requests += 1;
      if (failNextResponse) {
        failNextResponse = false;
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
          error: { message: "Invalid model configuration for Sedes fixture", type: "invalid_request_error", code: "model_not_found" },
        }));
        return;
      }
      const holdResponse = holdNextResponse;
      holdNextResponse = false;
      const responseId = `live-fixture-response-${requests}`;
      const messageId = `live-fixture-message-${requests}`;
      const events = [
        {
          type: "response.created",
          response: { id: responseId },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            role: "assistant",
            id: messageId,
            status: "in_progress",
            content: [],
          },
        },
        {
          type: "response.content_part.added",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: {
            type: "output_text",
            annotations: [],
            logprobs: [],
            text: "",
          },
        },
        {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: "fixture streaming ",
          logprobs: [],
        },
        {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: "complete",
          logprobs: [],
        },
        {
          type: "response.output_text.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: "fixture streaming complete",
          logprobs: [],
        },
        {
          type: "response.content_part.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: {
            type: "output_text",
            annotations: [],
            logprobs: [],
            text: "fixture streaming complete",
          },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            role: "assistant",
            id: messageId,
            status: "completed",
            content: [
              {
                type: "output_text",
                annotations: [],
                logprobs: [],
                text: "fixture streaming complete",
              },
            ],
          },
        },
        {
          type: "response.completed",
          response: {
            id: responseId,
            usage: {
              input_tokens: 11,
              input_tokens_details: null,
              output_tokens: 7,
              output_tokens_details: null,
              total_tokens: 18,
            },
          },
        },
      ];
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });
      if (holdResponse) {
        response.once("close", () => {
          heldResponseCloses += 1;
        });
        void writeProviderEvents(response, events.slice(0, 4), false);
        return;
      }
      void writeProviderEvents(response, events, true);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("live_test_provider_address_unavailable");
  }
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
    holdNextResponse: () => {
      if (holdNextResponse) {
        throw new Error("live_test_provider_response_already_held");
      }
      holdNextResponse = true;
    },
    failNextResponse: () => { failNextResponse = true; },
    heldResponseCloseCount: () => heldResponseCloses,
    close: () => closeServer(server),
  });
}

async function writeProviderEvents(
  response: import("node:http").ServerResponse,
  events: readonly Readonly<Record<string, unknown>>[],
  end: boolean,
): Promise<void> {
  for (const event of events) {
    if (response.destroyed) return;
    response.write(`event: ${String(event.type)}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (end) response.end();
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function availableTcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("codex_tcp_live_port_unavailable");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function tcpListenerAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const timer = setTimeout(() => finish(false), 200);
    timer.unref();
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitUntil<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMilliseconds: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("live_test_wait_timeout");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw error;
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
