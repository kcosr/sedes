import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { generate as generateCertificate } from "selfsigned";
import WebSocket, { WebSocketServer } from "ws";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import { serializeCodexBindingDetail } from "../../src/server/backends/codex/codex-binding-codec.js";
import {
  CodexConversationHandle,
  type CodexExecutionSettingsProvider,
} from "../../src/server/backends/codex/codex-conversation-handle.js";
import { CodexDaemonSupervisor } from "../../src/server/backends/codex/codex-daemon-supervisor.js";
import { CodexFastModeSessionRegistry } from "../../src/server/backends/codex/codex-fast-mode-session.js";
import { TcpWebSocketTransportFactory } from "../../src/server/backends/codex/transport/tcp-websocket-transport.js";
import { UnixWebSocketTransportFactory } from "../../src/server/backends/codex/transport/unix-websocket-transport.js";
import { ConversationActor } from "../../src/server/conversations/conversation-actor.js";
import { ConversationProjector } from "../../src/server/conversations/conversation-projector.js";
import { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import { ThreadEventHub } from "../../src/server/events/thread-event-hub.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import type {
  NormalizedThreadSnapshot,
  ThreadEventEnvelope,
} from "../../src/shared/protocol/conversation.js";
import { COMPOSER_ATTACHMENT_POLICY } from "../../src/shared/protocol/composer-attachments.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";
import { pinnedCodexTestExecutable } from "../helpers/pinned-codex-test-executable.js";

const execFile = promisify(execFileCallback);
const codexBinary = pinnedCodexTestExecutable();
const tmuxAvailable = await execFile("tmux", ["-V"])
  .then(() => true)
  .catch(() => false);

type JsonRecord = Record<string, unknown>;

interface FixtureProviderHold {
  readonly received: Promise<void>;
  release(): void;
}

const tmuxServers = new Set<string>();
const realCodexTuiHome = readRealCodexTuiHome();
const launchHome = process.env.HOME ?? os.homedir();
const managedTuiConfigArguments = Object.freeze([
  "-c",
  "check_for_update_on_startup=false",
  "-c",
  "tui.auto_recap=false",
  "-c",
  'tui.keymap.composer.submit="enter"',
  "-c",
  "tui.vim_mode_default=false",
  "-c",
  'tui.alternate_screen="always"',
  "-c",
  "tui.raw_output_mode=false",
  "-c",
  "tui.disable_paste_burst=false",
]);

afterEach(async () => {
  await Promise.all(
    [...tmuxServers].map(async (serverName) => {
      await execFile("tmux", ["-L", serverName, "kill-server"]).catch(
        () => undefined,
      );
      tmuxServers.delete(serverName);
    }),
  );
});

describe("Codex managed TUI config parser compatibility", () => {
  it("accepts the exact process-local Codex 0.153 override profile", async () => {
    await access(codexBinary);
    const root = await mkdtemp(
      path.join(os.tmpdir(), "sedes-codex-tui-config-parser-"),
    );
    const codexHome = path.join(root, "codex-home");
    try {
      await mkdir(codexHome);
      const { stdout } = await execFile(
        codexBinary,
        [
          "debug",
          "prompt-input",
          ...managedTuiConfigArguments,
          "managed TUI config parser probe",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            CODEX_HOME: codexHome,
            CODEX_SQLITE_HOME: codexHome,
            NO_COLOR: "1",
            TERM: "dumb",
          },
          timeout: 10_000,
        },
      );
      expect(() => JSON.parse(stdout)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.runIf(tmuxAvailable)("Codex TUI remote live compatibility", () => {
  it("overrides conflicting account TUI config, resumes through UDS, and converges TUI-originated work", async () => {
    await access(codexBinary);
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-codex-tui-live-"));
    const codexHome = path.join(root, "codex-home");
    const workspace = path.join(root, "workspace");
    const socketPath = path.join(root, "app-server.sock");
    const sedesScope = Object.freeze({
      tenantId: "tenant-feature-033-normalized-live",
      principalId: "principal-feature-033-normalized-live",
    });
    const executionEnvironmentId = "environment-feature-033-normalized-live";
    const applicationThreadId = "33000000-0000-4000-8000-000000000033";
    const backendInstanceId = "codex-feature-033-normalized-live";
    const connectionProfileId = "codex-feature-033-normalized-profile";
    const provider = await startFixtureProvider();
    let appServer: ChildProcess | undefined;
    let client: JsonRpcWebSocketClient | undefined;
    let tmuxServer: string | undefined;
    let createdThreadId: string | undefined;
    let sedesSupervisor: CodexDaemonSupervisor | undefined;
    let sedesActor: ConversationActor | undefined;
    let sedesBridgeBinding:
      ReturnType<ConversationEventBridge["bind"]> | undefined;
    let sedesEnvironment: LocalEnvironmentChannelProvider | undefined;

    try {
      await Promise.all([
        mkdir(codexHome),
        mkdir(workspace),
        mkdir(path.join(root, ".codex")),
      ]);
      const fixtureConfig = codexConfig(provider.baseUrl, workspace);
      await Promise.all([
        writeFile(path.join(codexHome, "config.toml"), fixtureConfig, {
          encoding: "utf8",
          mode: 0o600,
        }),
        writeFile(path.join(root, ".codex", "config.toml"), fixtureConfig, {
          encoding: "utf8",
          mode: 0o600,
        }),
      ]);
      appServer = startAppServer(codexHome, workspace, `unix://${socketPath}`);
      await waitUntil(
        async () => {
          try {
            const metadata = await lstat(socketPath);
            return metadata.isSocket() && (metadata.mode & 0o777) === 0o600;
          } catch {
            return false;
          }
        },
        8_000,
        "UDS listener",
      );

      sedesEnvironment = new LocalEnvironmentChannelProvider({
        scope: sedesScope,
        executionEnvironmentId,
      });
      sedesSupervisor = new CodexDaemonSupervisor({
        scope: {
          ...sedesScope,
          backendInstanceId,
          executionEnvironmentId,
        },
        transportFactory: new UnixWebSocketTransportFactory({
          scope: {
            ...sedesScope,
            backendInstanceId,
            executionEnvironmentId,
          },
          channels: sedesEnvironment,
          socketPath,
        }),
        restartDelaysMilliseconds: [25, 50, 100],
        maximumRestartAttempts: 3,
        initializationTimeoutMilliseconds: 5_000,
      });
      await sedesSupervisor.start();

      client = await JsonRpcWebSocketClient.connect(
        `ws+unix://${socketPath}:/`,
      );
      await client.initialize(codexHome, true);
      const started = asRecord(
        await client.request("thread/start", {
          model: "gpt-5.6-luna",
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          threadSource: "sedes_feature_033_tui_live",
        }),
      );
      const threadId = String(asRecord(started.thread).id);
      createdThreadId = threadId;
      expect(threadId).toMatch(/^[0-9a-f-]{36}$/i);
      const seedStarted = client.nextNotification(
        "turn/started",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      const seedCompleted = client.nextNotification(
        "turn/completed",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      await client.request("turn/start", {
        threadId,
        clientUserMessageId: "feature-033-seed",
        input: [
          {
            type: "text",
            text: "Seed the disposable thread before the remote TUI attaches.",
            text_elements: [],
          },
        ],
        model: "gpt-5.6-luna",
        effort: "low",
      });
      await seedStarted;
      await seedCompleted;

      const binding: ConversationBinding = Object.freeze({
        tenantId: sedesScope.tenantId,
        ownerPrincipalId: sedesScope.principalId,
        applicationThreadId,
        backendInstanceId,
        connectionProfileId,
        executionEnvironmentId,
        backendConversationId: threadId,
        createdAt: new Date().toISOString(),
      });
      const normalizedHandle = new CodexConversationHandle({
    usageSink: NO_USAGE_SINK,
    nativeNamespace: "test-codex-store",
    usageProvenZero: false,
        binding,
        canonicalWorkspacePath: workspace,
        workspaceId: "workspace-feature-033-normalized-live",
        opaqueBindingDetail: serializeCodexBindingDetail({
          threadId,
          sessionId: String(asRecord(started.thread).sessionId),
          nativeAncestry: null,
          correlationAncestorThreadIds: [],
        }),
        client: sedesSupervisor.client,
        serverRequests: sedesSupervisor.serverRequests,
        toolProvenanceKey: new Uint8Array(32).fill(0x33),
        correlationAncestorThreadIds: [],
        executionSettings: normalizedLiveExecutionSettings,
        outputArtifacts: createInMemoryOutputArtifactPublisher(),
        fastModeSessions: new CodexFastModeSessionRegistry(),
        validateExecutionSettings: async () => undefined,
        resolveImportedReasoningEffort: async (_model, observed) =>
          observed ?? "low",
        releaseOwnership: () => undefined,
      });
      sedesActor = new ConversationActor({
        handle: normalizedHandle,
        attachmentDelivery: {
          materialize: async () => ({
            attachments: [],
            canonicalBytes: {
              read: async () => {
                throw new Error("unexpected_canonical_attachment_read");
              },
            },
            canonicalEvidence: { resolve: () => [] },
          }),
        } as never,
        environmentLease: {
          scope: sedesScope,
          environment: {
            id: executionEnvironmentId,
            label: "Local fixture",
            availability: "available",
            diagnosticCode: null,
            revision: 1,
          },
          workspace: {
            canonicalPath: workspace,
            authorityRevision: 1,
            summary: {
              id: "workspace-feature-033-normalized-live",
              environmentId: executionEnvironmentId,
              displayName: "Fixture workspace",
              displayPath: workspace,
              availability: "available",
              trustState: "trusted",
              revision: 1,
            },
          },
          release: async () => undefined,
        },
        projector: new ConversationProjector({
          backendInstanceId,
          bindingIdentity: applicationThreadId,
        }),
        projectionUpdateIntervalMilliseconds: 1,
      });
      await sedesActor.start({ signal: new AbortController().signal });
      expect(sedesActor.timeline.orderedTurnIds).toHaveLength(1);
      const normalizedHub = new ThreadEventHub();
      const normalizedEnvelopes: ThreadEventEnvelope[] = [];
      const normalizedSubscription = normalizedHub.subscribe((envelope) =>
        normalizedEnvelopes.push(envelope),
      );
      const normalizedBridge = new ConversationEventBridge({
        snapshot: async (_scope, _threadId, state) =>
          normalizedFixtureSnapshot(state.timeline.generation),
        capabilitiesAndProviderFeatures: async () => ({
          threadRevision:
            normalizedFixtureSnapshot("unused").thread.threadRevision,
          capabilities: normalizedFixtureSnapshot("unused").capabilities,
          providerFeatures: [],
          interactions: [],
        }),
        forkSource: async () => normalizedFixtureSnapshot("unused").forkSource,
        ancillary: async () => [],
      }, () => undefined);
      sedesBridgeBinding = normalizedBridge.bind({
        scope: sedesScope,
        applicationThreadId,
        actor: sedesActor,
        hub: normalizedHub,
      });
      await sedesBridgeBinding.ready;

      const activeAttachPrompt =
        "Keep this disposable UDS turn active while the remote TUI attaches.";
      const activeAttachHold = provider.holdNextResponse();
      const activeAttachStarted = client.nextNotification(
        "turn/started",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      const activeAttachCompleted = client.nextNotification(
        "turn/completed",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      await client.request("turn/start", {
        threadId,
        clientUserMessageId: "feature-033-active-attach",
        input: [
          {
            type: "text",
            text: activeAttachPrompt,
            text_elements: [],
          },
        ],
        model: "gpt-5.6-luna",
        effort: "low",
      });
      await Promise.all([activeAttachStarted, activeAttachHold.received]);

      tmuxServer = `sedes-codex-tui-${randomUUID()}`;
      tmuxServers.add(tmuxServer);
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-x",
        "100",
        "-y",
        "30",
        "-s",
        "codex",
        "sleep",
        "60",
      ]);
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "set-option",
        "-g",
        "remain-on-exit",
        "on",
      ]);
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "respawn-pane",
        "-k",
        "-t",
        "codex:0.0",
        "env",
        `HOME=${root}`,
        `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
        "TERM=xterm-256color",
        "NO_COLOR=1",
        codexBinary,
        "resume",
        threadId,
        "--remote",
        `unix://${socketPath}`,
        "--strict-config",
        ...managedTuiConfigArguments,
        "--cd",
        workspace,
        "--model",
        "gpt-5.6-luna",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
      ]);
      await waitUntil(
        async () =>
          (await capturePane(tmuxServer!)).includes(activeAttachPrompt),
        12_000,
        "active UDS TUI resume",
      );
      // Codex keeps its main surface inline. `alternate_screen = "always"`
      // enables the alternate buffer for full-screen overlays, so open and
      // close the transcript overlay to prove the process-local override won
      // over the fixture account's conflicting `never` value.
      expect(await paneAlternateScreenActive(tmuxServer)).toBe(false);
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "send-keys",
        "-t",
        "codex:0.0",
        "C-t",
      ]);
      await waitUntil(
        () => paneAlternateScreenActive(tmuxServer!),
        3_000,
        "transcript overlay alternate screen",
      );
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "send-keys",
        "-t",
        "codex:0.0",
        "C-t",
      ]);
      await waitUntil(
        async () => !(await paneAlternateScreenActive(tmuxServer!)),
        3_000,
        "transcript overlay close",
      );
      const activeAttachRead = asRecord(
        await client.request("thread/read", { threadId, includeTurns: true }),
      );
      const activeAttachTurns = asRecord(activeAttachRead.thread).turns;
      expect(
        Array.isArray(activeAttachTurns) ? activeAttachTurns : [],
      ).toHaveLength(2);
      expect(provider.requestCount()).toBe(2);
      activeAttachHold.release();
      await activeAttachCompleted;
      await waitUntil(
        () => {
          const snapshot = normalizedHub.snapshot;
          return (
            Object.values(snapshot?.itemsById ?? {}).filter((item) =>
              JSON.stringify(item).includes(activeAttachPrompt),
            ).length === 1 &&
            snapshot?.orderedTurnIds.length === 1 &&
            snapshot.turnsById[snapshot.orderedTurnIds[0]!]?.status ===
              "completed"
          );
        },
        8_000,
        "active UDS attach convergence",
      );

      await execFile("tmux", [
        "-L",
        tmuxServer,
        "resize-window",
        "-x",
        "52",
        "-y",
        "16",
      ]);
      await waitUntil(
        async () => (await paneSize(tmuxServer!)) === "52x16",
        3_000,
        "narrow PTY resize",
      );
      const narrow = await capturePane(tmuxServer);
      expect(narrow).toContain("gpt-5.6-luna");
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "resize-window",
        "-x",
        "120",
        "-y",
        "40",
      ]);
      await waitUntil(
        async () => (await paneSize(tmuxServer!)) === "120x40",
        3_000,
        "wide PTY resize",
      );
      const wide = await capturePane(tmuxServer);
      expect(wide).toContain("gpt-5.6-luna");
      expect(wide).not.toBe(narrow);

      const settingsNotification = client.nextNotification(
        "thread/settings/updated",
        (params) => {
          const notification = asOptionalRecord(params);
          return (
            notification?.threadId === threadId &&
            asOptionalRecord(notification.threadSettings)?.effort === "medium"
          );
        },
      );
      await expect(
        client.request("thread/settings/update", {
          threadId,
          model: "gpt-5.6-luna",
          effort: "medium",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        }),
      ).resolves.toEqual({});
      const settings = asRecord((await settingsNotification).params);
      expect(asRecord(settings.threadSettings)).toMatchObject({
        model: "gpt-5.6-luna",
        effort: "medium",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      await waitUntil(
        async () =>
          (await capturePane(tmuxServer!)).toLowerCase().includes("medium"),
        5_000,
        "TUI settings repaint",
      );

      const turnStarted = client.nextNotification(
        "turn/started",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      const turnCompleted = client.nextNotification(
        "turn/completed",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "send-keys",
        "-t",
        "codex:0.0",
        "-l",
        "Reply with the disposable fixture response.",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "send-keys",
        "-t",
        "codex:0.0",
        "Enter",
      ]);
      await turnStarted;
      try {
        await turnCompleted;
      } catch (error) {
        throw new Error(
          `TUI-originated turn did not complete (provider requests=${provider.requestCount()}):\n${await capturePane(tmuxServer)}`,
          { cause: error },
        );
      }
      expect(provider.requestCount()).toBe(3);
      await waitUntil(
        () => {
          const snapshot = normalizedHub.snapshot;
          return (
            snapshot?.orderedTurnIds.length === 2 &&
            snapshot.orderedTurnIds.every(
              (turnId) => snapshot.turnsById[turnId]?.status === "completed",
            ) &&
            Object.values(snapshot.itemsById).filter((item) =>
              JSON.stringify(item).includes(
                "Reply with the disposable fixture response.",
              ),
            ).length === 1 &&
            Object.values(snapshot.itemsById).filter((item) =>
              JSON.stringify(item).includes("fixture streaming complete"),
            ).length === 2
          );
        },
        8_000,
        "normalized Sedes event bridge convergence",
      );
      expect(normalizedEnvelopes[0]?.event.type).toBe("snapshot");
      const bridgedTurnEvents = normalizedEnvelopes
        .map(({ event }) => event)
        .filter((event) => event.type === "turn_upsert");
      expect(bridgedTurnEvents.length).toBeGreaterThanOrEqual(2);
      expect(new Set(bridgedTurnEvents.map(({ turn }) => turn.id)).size).toBe(
        2,
      );
      expect(bridgedTurnEvents.at(-1)?.turn.status).toBe("completed");
      normalizedSubscription.close();
      await waitUntil(
        async () =>
          (await capturePane(tmuxServer!)).includes(
            "fixture streaming complete",
          ),
        8_000,
        "TUI assistant repaint",
      );
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "resize-window",
        "-x",
        "119",
        "-y",
        "40",
      ]);
      await waitUntil(
        async () => (await paneSize(tmuxServer!)) === "119x40",
        3_000,
        "request-sync jiggle",
      );
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "resize-window",
        "-x",
        "120",
        "-y",
        "40",
      ]);
      await waitUntil(
        async () => (await paneSize(tmuxServer!)) === "120x40",
        3_000,
        "request-sync repaint",
      );
      const synchronizedPane = await capturePane(tmuxServer);
      expect(synchronizedPane).toContain("Seed the disposable thread");
      expect(synchronizedPane).toContain(
        "Reply with the disposable fixture response.",
      );
      expect(synchronizedPane).toContain("fixture streaming complete");
      const read = asRecord(
        await client.request("thread/read", { threadId, includeTurns: true }),
      );
      const turns = asRecord(read.thread).turns;
      expect(Array.isArray(turns) ? turns : []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "completed" }),
        ]),
      );

      const activeStopPrompt =
        "Keep this second disposable UDS turn active while the TUI stops.";
      const activeStopHold = provider.holdNextResponse();
      const activeStopStarted = client.nextNotification(
        "turn/started",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      const activeStopCompleted = client.nextNotification(
        "turn/completed",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      await client.request("turn/start", {
        threadId,
        clientUserMessageId: "feature-033-active-stop",
        input: [
          {
            type: "text",
            text: activeStopPrompt,
            text_elements: [],
          },
        ],
        model: "gpt-5.6-luna",
        effort: "low",
      });
      await Promise.all([activeStopStarted, activeStopHold.received]);
      await waitUntil(
        async () => (await capturePane(tmuxServer!)).includes(activeStopPrompt),
        8_000,
        "active UDS stop repaint",
      );
      await stopTmuxServer(tmuxServer);
      tmuxServer = undefined;
      activeStopHold.release();
      await activeStopCompleted;
      expect(provider.requestCount()).toBe(4);
      await waitUntil(
        () => {
          const snapshot = normalizedHub.snapshot;
          return (
            snapshot?.orderedTurnIds.length === 3 &&
            snapshot.orderedTurnIds.every(
              (turnId) => snapshot.turnsById[turnId]?.status === "completed",
            ) &&
            Object.values(snapshot.itemsById).filter((item) =>
              JSON.stringify(item).includes(activeStopPrompt),
            ).length === 1
          );
        },
        8_000,
        "active UDS stop convergence",
      );
      const stoppedRead = asRecord(
        await client.request("thread/read", { threadId, includeTurns: true }),
      );
      const stoppedTurns = asRecord(stoppedRead.thread).turns;
      expect(Array.isArray(stoppedTurns) ? stoppedTurns : []).toHaveLength(4);
      expect(
        Array.isArray(stoppedTurns) ? stoppedTurns.at(-1) : undefined,
      ).toMatchObject({ status: "completed" });
      await expect(
        client.request("thread/archive", { threadId }),
      ).resolves.toEqual({});
      createdThreadId = undefined;
    } finally {
      if (tmuxServer) {
        await stopTmuxServer(tmuxServer);
      }
      if (client && createdThreadId) {
        await client
          .request("thread/archive", { threadId: createdThreadId })
          .catch(() => undefined);
      }
      await sedesBridgeBinding?.release().catch(() => undefined);
      await sedesActor?.close().catch(() => undefined);
      await sedesSupervisor?.close().catch(() => undefined);
      sedesEnvironment?.close();
      await client?.close().catch(() => undefined);
      if (appServer) await stopChild(appServer);
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("resumes through an authenticated loopback WebSocket using an environment token", async () => {
    await access(codexBinary);
    const root = await mkdtemp(
      path.join(os.tmpdir(), "sedes-codex-tui-tcp-live-"),
    );
    const codexHome = path.join(root, "codex-home");
    const workspace = path.join(root, "workspace");
    const tokenPath = path.join(root, "app-server-token");
    const token = randomBytes(32).toString("base64url");
    const port = await availableTcpPort();
    const endpoint = `ws://127.0.0.1:${port}`;
    const sedesScope = Object.freeze({
      tenantId: "tenant-feature-033-tcp-active",
      principalId: "principal-feature-033-tcp-active",
    });
    const executionEnvironmentId = "environment-feature-033-tcp-active";
    const applicationThreadId = "33000000-0000-4000-8000-000000000034";
    const backendInstanceId = "codex-feature-033-tcp-active";
    const connectionProfileId = "codex-feature-033-tcp-profile";
    const provider = await startFixtureProvider();
    let appServer: ChildProcess | undefined;
    let client: JsonRpcWebSocketClient | undefined;
    let tmuxServer: string | undefined;
    let createdThreadId: string | undefined;
    let sedesEnvironment: LocalEnvironmentChannelProvider | undefined;
    let sedesSupervisor: CodexDaemonSupervisor | undefined;
    let normalizedProjection:
      Awaited<ReturnType<typeof startNormalizedLiveProjection>> | undefined;

    try {
      await Promise.all([
        mkdir(codexHome),
        mkdir(workspace),
        mkdir(path.join(root, ".codex")),
      ]);
      const fixtureConfig = codexConfig(provider.baseUrl, workspace);
      await Promise.all([
        writeFile(path.join(codexHome, "config.toml"), fixtureConfig, {
          encoding: "utf8",
          mode: 0o600,
        }),
        writeFile(path.join(root, ".codex", "config.toml"), fixtureConfig, {
          encoding: "utf8",
          mode: 0o600,
        }),
        writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 }),
      ]);
      await chmod(tokenPath, 0o600);
      appServer = startAppServer(codexHome, workspace, endpoint, tokenPath);
      await waitUntil(
        () => tcpListenerAvailable(port),
        8_000,
        "authenticated TCP listener",
      );

      sedesEnvironment = new LocalEnvironmentChannelProvider({
        scope: sedesScope,
        executionEnvironmentId,
      });
      sedesSupervisor = new CodexDaemonSupervisor({
        scope: {
          ...sedesScope,
          backendInstanceId,
          executionEnvironmentId,
        },
        transportFactory: new TcpWebSocketTransportFactory({
          scope: {
            ...sedesScope,
            backendInstanceId,
            executionEnvironmentId,
          },
          channels: sedesEnvironment,
          url: endpoint,
          secretReference: { source: "protected_file", path: tokenPath },
        }),
        restartDelaysMilliseconds: [25, 50, 100],
        maximumRestartAttempts: 3,
        initializationTimeoutMilliseconds: 5_000,
      });
      await sedesSupervisor.start();

      client = await JsonRpcWebSocketClient.connect(endpoint, token);
      await client.initialize(codexHome, true);
      const started = asRecord(
        await client.request("thread/start", {
          model: "gpt-5.6-luna",
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          threadSource: "sedes_feature_033_tui_tcp_live",
        }),
      );
      const threadId = String(asRecord(started.thread).id);
      createdThreadId = threadId;
      const seedCompleted = client.nextNotification(
        "turn/completed",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      await client.request("turn/start", {
        threadId,
        clientUserMessageId: "feature-033-tcp-seed",
        input: [
          {
            type: "text",
            text: "Seed the disposable authenticated WebSocket thread.",
            text_elements: [],
          },
        ],
        model: "gpt-5.6-luna",
        effort: "low",
      });
      await seedCompleted;

      normalizedProjection = await startNormalizedLiveProjection({
        scope: sedesScope,
        applicationThreadId,
        backendInstanceId,
        connectionProfileId,
        executionEnvironmentId,
        workspaceId: "workspace-feature-033-tcp-active",
        workspace,
        threadId,
        sessionId: String(asRecord(started.thread).sessionId),
        supervisor: sedesSupervisor,
      });
      expect(normalizedProjection.actor.timeline.orderedTurnIds).toHaveLength(
        1,
      );

      const activeAttachPrompt =
        "Keep this disposable authenticated TCP turn active while the TUI attaches.";
      const activeAttachHold = provider.holdNextResponse();
      const activeAttachStarted = client.nextNotification(
        "turn/started",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      const activeAttachCompleted = client.nextNotification(
        "turn/completed",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      await client.request("turn/start", {
        threadId,
        clientUserMessageId: "feature-033-tcp-active-attach",
        input: [
          {
            type: "text",
            text: activeAttachPrompt,
            text_elements: [],
          },
        ],
        model: "gpt-5.6-luna",
        effort: "low",
      });
      await Promise.all([activeAttachStarted, activeAttachHold.received]);

      tmuxServer = `sedes-codex-tui-tcp-${randomUUID()}`;
      tmuxServers.add(tmuxServer);
      await execFile(
        "tmux",
        [
          "-L",
          tmuxServer,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-x",
          "100",
          "-y",
          "30",
          "-s",
          "codex",
          "sleep",
          "60",
        ],
        {
          env: {
            ...process.env,
            SEDES_FEATURE_033_TEST_TOKEN: token,
          },
        },
      );
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "set-option",
        "-g",
        "remain-on-exit",
        "on",
      ]);
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "respawn-pane",
        "-k",
        "-t",
        "codex:0.0",
        "env",
        `HOME=${root}`,
        `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
        "TERM=xterm-256color",
        "NO_COLOR=1",
        codexBinary,
        "resume",
        threadId,
        "--remote",
        endpoint,
        "--remote-auth-token-env",
        "SEDES_FEATURE_033_TEST_TOKEN",
        "--strict-config",
        ...managedTuiConfigArguments,
        "--cd",
        workspace,
        "--model",
        "gpt-5.6-luna",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
      ]);
      await waitUntil(
        async () =>
          (await capturePane(tmuxServer!)).includes(activeAttachPrompt),
        12_000,
        "active authenticated WebSocket TUI resume",
      );
      expect(await capturePane(tmuxServer)).toContain("gpt-5.6-luna low");
      const activeAttachRead = asRecord(
        await client.request("thread/read", { threadId, includeTurns: true }),
      );
      const activeAttachTurns = asRecord(activeAttachRead.thread).turns;
      expect(
        Array.isArray(activeAttachTurns) ? activeAttachTurns : [],
      ).toHaveLength(2);
      expect(provider.requestCount()).toBe(2);
      activeAttachHold.release();
      await activeAttachCompleted;
      await waitUntil(
        () => {
          const snapshot = normalizedProjection!.hub.snapshot;
          return (
            snapshot?.orderedTurnIds.length === 1 &&
            snapshot.turnsById[snapshot.orderedTurnIds[0]!]?.status ===
              "completed" &&
            Object.values(snapshot.itemsById).filter((item) =>
              JSON.stringify(item).includes(activeAttachPrompt),
            ).length === 1
          );
        },
        8_000,
        "active authenticated TCP attach convergence",
      );

      const activeStopPrompt =
        "Keep this second authenticated TCP turn active while the TUI stops.";
      const activeStopHold = provider.holdNextResponse();
      const activeStopStarted = client.nextNotification(
        "turn/started",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      const activeStopCompleted = client.nextNotification(
        "turn/completed",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      await client.request("turn/start", {
        threadId,
        clientUserMessageId: "feature-033-tcp-active-stop",
        input: [
          {
            type: "text",
            text: activeStopPrompt,
            text_elements: [],
          },
        ],
        model: "gpt-5.6-luna",
        effort: "low",
      });
      await Promise.all([activeStopStarted, activeStopHold.received]);
      await waitUntil(
        async () => (await capturePane(tmuxServer!)).includes(activeStopPrompt),
        8_000,
        "active authenticated TCP stop repaint",
      );
      await stopTmuxServer(tmuxServer);
      tmuxServer = undefined;
      activeStopHold.release();
      await activeStopCompleted;
      expect(provider.requestCount()).toBe(3);
      await waitUntil(
        () => {
          const snapshot = normalizedProjection!.hub.snapshot;
          return (
            snapshot?.orderedTurnIds.length === 2 &&
            snapshot.orderedTurnIds.every(
              (turnId) => snapshot.turnsById[turnId]?.status === "completed",
            ) &&
            Object.values(snapshot.itemsById).filter((item) =>
              JSON.stringify(item).includes(activeStopPrompt),
            ).length === 1
          );
        },
        8_000,
        "active authenticated TCP stop convergence",
      );
      const stoppedRead = asRecord(
        await client.request("thread/read", { threadId, includeTurns: true }),
      );
      const stoppedTurns = asRecord(stoppedRead.thread).turns;
      expect(Array.isArray(stoppedTurns) ? stoppedTurns : []).toHaveLength(3);
      expect(
        Array.isArray(stoppedTurns) ? stoppedTurns.at(-1) : undefined,
      ).toMatchObject({ status: "completed" });
      await expect(
        client.request("thread/archive", { threadId }),
      ).resolves.toEqual({});
      createdThreadId = undefined;
    } finally {
      if (tmuxServer) {
        await stopTmuxServer(tmuxServer);
      }
      if (client && createdThreadId) {
        await client
          .request("thread/archive", { threadId: createdThreadId })
          .catch(() => undefined);
      }
      await normalizedProjection?.close().catch(() => undefined);
      await sedesSupervisor?.close().catch(() => undefined);
      sedesEnvironment?.close();
      await client?.close().catch(() => undefined);
      if (appServer) await stopChild(appServer);
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 35_000);

  it("resumes through authenticated WSS using a disposable trusted CA", async () => {
    await access(codexBinary);
    const root = await mkdtemp(
      path.join(os.tmpdir(), "sedes-codex-tui-wss-live-"),
    );
    const codexHome = path.join(root, "codex-home");
    const workspace = path.join(root, "workspace");
    const tokenPath = path.join(root, "app-server-token");
    const token = randomBytes(32).toString("base64url");
    const upstreamPort = await availableTcpPort();
    const upstreamEndpoint = `ws://127.0.0.1:${upstreamPort}`;
    const provider = await startFixtureProvider();
    let appServer: ChildProcess | undefined;
    let proxy: Awaited<ReturnType<typeof startTrustedWssProxy>> | undefined;
    let client: JsonRpcWebSocketClient | undefined;
    let tmuxServer: string | undefined;
    let createdThreadId: string | undefined;

    try {
      await Promise.all([
        mkdir(codexHome),
        mkdir(workspace),
        mkdir(path.join(root, ".codex")),
      ]);
      const fixtureConfig = codexConfig(provider.baseUrl, workspace);
      await Promise.all([
        writeFile(path.join(codexHome, "config.toml"), fixtureConfig, {
          encoding: "utf8",
          mode: 0o600,
        }),
        writeFile(path.join(root, ".codex", "config.toml"), fixtureConfig, {
          encoding: "utf8",
          mode: 0o600,
        }),
        writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 }),
      ]);
      appServer = startAppServer(
        codexHome,
        workspace,
        upstreamEndpoint,
        tokenPath,
      );
      await waitUntil(
        () => tcpListenerAvailable(upstreamPort),
        8_000,
        "authenticated WSS upstream",
      );
      proxy = await startTrustedWssProxy(root, upstreamEndpoint, token);

      client = await JsonRpcWebSocketClient.connect(upstreamEndpoint, token);
      await client.initialize(codexHome, true);
      const started = asRecord(
        await client.request("thread/start", {
          model: "gpt-5.6-luna",
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          threadSource: "sedes_feature_033_tui_wss_live",
        }),
      );
      const threadId = String(asRecord(started.thread).id);
      createdThreadId = threadId;
      const seedCompleted = client.nextNotification(
        "turn/completed",
        (params) => asOptionalRecord(params)?.threadId === threadId,
      );
      await client.request("turn/start", {
        threadId,
        clientUserMessageId: "feature-033-wss-seed",
        input: [
          {
            type: "text",
            text: "Seed the disposable trusted-WSS thread.",
            text_elements: [],
          },
        ],
        model: "gpt-5.6-luna",
        effort: "low",
      });
      await seedCompleted;

      tmuxServer = `sedes-codex-tui-wss-${randomUUID()}`;
      tmuxServers.add(tmuxServer);
      await execFile(
        "tmux",
        [
          "-L",
          tmuxServer,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-x",
          "100",
          "-y",
          "30",
          "-s",
          "codex",
          "sleep",
          "60",
        ],
        {
          env: {
            ...process.env,
            SEDES_FEATURE_033_TEST_TOKEN: token,
            SSL_CERT_FILE: proxy.caPath,
          },
        },
      );
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "set-option",
        "-g",
        "remain-on-exit",
        "on",
      ]);
      await execFile("tmux", [
        "-L",
        tmuxServer,
        "respawn-pane",
        "-k",
        "-t",
        "codex:0.0",
        "env",
        `HOME=${root}`,
        `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
        "TERM=xterm-256color",
        "NO_COLOR=1",
        codexBinary,
        "resume",
        threadId,
        "--remote",
        proxy.endpoint,
        "--remote-auth-token-env",
        "SEDES_FEATURE_033_TEST_TOKEN",
        "--strict-config",
        ...managedTuiConfigArguments,
        "--cd",
        workspace,
        "--model",
        "gpt-5.6-luna",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
      ]);
      await waitUntil(
        async () =>
          (await capturePane(tmuxServer!)).includes(
            "fixture streaming complete",
          ),
        15_000,
        "trusted WSS TUI resume",
      );
      expect(await capturePane(tmuxServer)).toContain("gpt-5.6-luna low");
      expect(proxy.authenticatedConnections()).toBeGreaterThanOrEqual(1);
      await stopTmuxServer(tmuxServer);
      tmuxServer = undefined;
      await expect(
        client.request("thread/archive", { threadId }),
      ).resolves.toEqual({});
      createdThreadId = undefined;
    } finally {
      if (tmuxServer) await stopTmuxServer(tmuxServer);
      if (client && createdThreadId) {
        await client
          .request("thread/archive", { threadId: createdThreadId })
          .catch(() => undefined);
      }
      await client?.close().catch(() => undefined);
      await proxy?.close().catch(() => undefined);
      if (appServer) await stopChild(appServer);
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);

  it.skipIf(!realCodexTuiHome)(
    "creates a new low/read-only Luna thread and converges real TUI-originated work",
    async () => {
      const authenticatedSourceHome = realCodexTuiHome!;
      const root = await mkdtemp(
        path.join(os.tmpdir(), "sedes-codex-tui-luna-live-"),
      );
      const workspace = path.join(root, "workspace");
      const providerCodexHome = path.join(root, "provider-home");
      const socketPath = path.join(root, "app-server.sock");
      let appServer: ChildProcess | undefined;
      let client: JsonRpcWebSocketClient | undefined;
      let tmuxServer: string | undefined;
      let createdThreadId: string | undefined;

      try {
        await mkdir(workspace);
        // Isolate both homes and trust only the empty fixture workspace,
        // without changing the operator's credentials or project settings.
        const clientConfigDirectory = path.join(root, ".codex");
        await mkdir(clientConfigDirectory, { mode: 0o700 });
        await mkdir(providerCodexHome, { mode: 0o700 });
        await copyFile(
          path.join(authenticatedSourceHome, "auth.json"),
          path.join(providerCodexHome, "auth.json"),
        );
        await chmod(path.join(providerCodexHome, "auth.json"), 0o600);
        const sourceConfig = await readFile(
          path.join(authenticatedSourceHome, "config.toml"), "utf8",
        ).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        });
        const fixtureConfig = `${sourceConfig}\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`;
        await Promise.all(
          [clientConfigDirectory, providerCodexHome].map((directory) =>
            writeFile(path.join(directory, "config.toml"), fixtureConfig, {mode: 0o600}),
          ),
        );
        appServer = startAppServer(
          providerCodexHome,
          workspace,
          `unix://${socketPath}`,
        );
        await waitUntil(
          async () => {
            try {
              const metadata = await lstat(socketPath);
              return metadata.isSocket() && (metadata.mode & 0o777) === 0o600;
            } catch {
              return false;
            }
          },
          10_000,
          "real Luna UDS listener",
        );

        client = await JsonRpcWebSocketClient.connect(
          `ws+unix://${socketPath}:/`,
        );
        await client.initialize(providerCodexHome, true);
        const account = asRecord(
          await client.request("account/read", { refreshToken: false }),
        );
        const accountValue = asOptionalRecord(account.account);
        if (
          account.requiresOpenaiAuth !== true ||
          accountValue?.type !== "chatgpt"
        ) {
          throw new Error("real_codex_tui_account_gate_failed");
        }
        const catalog = asRecord(
          await client.request("model/list", {
            limit: 100,
            includeHidden: true,
          }),
        );
        const models = Array.isArray(catalog.data) ? catalog.data : [];
        const lunaModels = models.filter((value) => {
          const model = asOptionalRecord(value);
          return (
            model?.id === "gpt-5.6-luna" || model?.model === "gpt-5.6-luna"
          );
        });
        if (lunaModels.length !== 1) {
          throw new Error("real_codex_tui_luna_catalog_gate_failed");
        }
        const luna = asRecord(lunaModels[0]);
        const efforts = Array.isArray(luna.supportedReasoningEfforts)
          ? luna.supportedReasoningEfforts
          : [];
        if (
          !efforts.some(
            (value) => asOptionalRecord(value)?.reasoningEffort === "low",
          )
        ) {
          throw new Error("real_codex_tui_low_reasoning_gate_failed");
        }

        const started = asRecord(
          await client.request("thread/start", {
            model: "gpt-5.6-luna",
            cwd: workspace,
            // Force a real preflight transition when the account already
            // defaults to low. No turn starts until never/read-only is proven.
            approvalPolicy: "on-request",
            sandbox: "read-only",
            ephemeral: false,
            threadSource: "sedes_feature_033_tui_real_luna_live",
          }),
        );
        const threadId = String(asRecord(started.thread).id);
        createdThreadId = threadId;
        if (!/^[0-9a-f-]{36}$/i.test(threadId)) {
          throw new Error("real_codex_tui_new_thread_id_invalid");
        }
        const settingsUpdated = client.nextNotification(
          "thread/settings/updated",
          (params) => {
            const notification = asOptionalRecord(params);
            const settings = asOptionalRecord(notification?.threadSettings);
            return (
              notification?.threadId === threadId &&
              settings?.model === "gpt-5.6-luna" &&
              settings.effort === "low"
            );
          },
          30_000,
        );
        await client.request("thread/settings/update", {
          threadId,
          model: "gpt-5.6-luna",
          effort: "low",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        });
        const effective = asRecord((await settingsUpdated).params);
        const effectiveSettings = asRecord(effective.threadSettings);
        if (
          effectiveSettings.model !== "gpt-5.6-luna" ||
          effectiveSettings.effort !== "low" ||
          effectiveSettings.approvalPolicy !== "never" ||
          asOptionalRecord(effectiveSettings.sandboxPolicy)?.type !== "readOnly"
        ) {
          throw new Error("real_codex_tui_effective_settings_gate_failed");
        }

        const seedCompleted = client.nextNotification(
          "turn/completed",
          (params) => asOptionalRecord(params)?.threadId === threadId,
          180_000,
        );
        await client.request("turn/start", {
          threadId,
          clientUserMessageId: `feature-033-real-seed-${randomUUID()}`,
          input: [
            {
              type: "text",
              text: "Reply exactly DISPOSABLE_LUNA_TUI_READY. Do not use tools.",
              text_elements: [],
            },
          ],
          model: "gpt-5.6-luna",
          effort: "low",
        });
        await seedCompleted;

        tmuxServer = `sedes-codex-tui-luna-${randomUUID()}`;
        tmuxServers.add(tmuxServer);
        await execFile("tmux", [
          "-L",
          tmuxServer,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-x",
          "100",
          "-y",
          "30",
          "-s",
          "codex",
          "sleep",
          "300",
        ]);
        await execFile("tmux", [
          "-L",
          tmuxServer,
          "set-option",
          "-g",
          "remain-on-exit",
          "on",
        ]);
        await execFile("tmux", [
          "-L",
          tmuxServer,
          "respawn-pane",
          "-k",
          "-t",
          "codex:0.0",
          "env",
          `HOME=${root}`,
          `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
          "TERM=xterm-256color",
          "NO_COLOR=1",
          codexBinary,
          "resume",
          threadId,
          "--remote",
          `unix://${socketPath}`,
          "--strict-config",
          ...managedTuiConfigArguments,
          "--cd",
          workspace,
          "--model",
          "gpt-5.6-luna",
          "--sandbox",
          "read-only",
          "--ask-for-approval",
          "never",
        ]);
        await waitUntil(
          async () =>
            (await capturePane(tmuxServer!)).includes(
              "DISPOSABLE_LUNA_TUI_READY",
            ),
          30_000,
          "real Luna TUI resume",
        ).catch(async (error: unknown) => {
          throw new Error(
            `${String(error)}\n${(await capturePane(tmuxServer!)).slice(-4_000)}`,
          );
        });

        const tuiStarted = client.nextNotification(
          "turn/started",
          (params) => asOptionalRecord(params)?.threadId === threadId,
          30_000,
        );
        const tuiCompleted = client.nextNotification(
          "turn/completed",
          (params) => asOptionalRecord(params)?.threadId === threadId,
          180_000,
        );
        await execFile("tmux", [
          "-L",
          tmuxServer,
          "send-keys",
          "-t",
          "codex:0.0",
          "-l",
          "Reply exactly DISPOSABLE_LUNA_TUI_CONVERGED. Do not use tools.",
        ]);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await execFile("tmux", [
          "-L",
          tmuxServer,
          "send-keys",
          "-t",
          "codex:0.0",
          "Enter",
        ]);
        await tuiStarted;
        await tuiCompleted;
        await waitUntil(
          async () =>
            (await capturePane(tmuxServer!)).includes(
              "DISPOSABLE_LUNA_TUI_CONVERGED",
            ),
          30_000,
          "real Luna TUI-originated convergence",
        );
        const finalPane = await capturePane(tmuxServer);
        if (
          !finalPane.includes("gpt-5.6-luna low") ||
          !finalPane.includes("DISPOSABLE_LUNA_TUI_READY") ||
          !finalPane.includes("DISPOSABLE_LUNA_TUI_CONVERGED")
        ) {
          throw new Error("real_codex_tui_final_projection_gate_failed");
        }
        await stopTmuxServer(tmuxServer);
        tmuxServer = undefined;
        const archived = await client.request("thread/archive", { threadId });
        if (Object.keys(asRecord(archived)).length !== 0) {
          throw new Error("real_codex_tui_archive_receipt_invalid");
        }
        createdThreadId = undefined;
      } finally {
        if (tmuxServer) {
          await stopTmuxServer(tmuxServer);
        }
        if (client && createdThreadId) {
          await client
            .request("thread/archive", { threadId: createdThreadId })
            .catch(() => undefined);
        }
        await client?.close().catch(() => undefined);
        if (appServer) await stopChild(appServer);
        await rm(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

const normalizedLiveExecutionSettings: CodexExecutionSettingsProvider = {
  desiredSettings: () => ({
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    serviceTier: "standard",
    sandboxMode: "read-only",
    networkAccess: "disabled",
    approvalPolicy: "never",
    approvalReviewer: "user",
  }),
  resolveFastModeDisabled: () => ({
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    serviceTier: "standard",
    sandboxMode: "read-only",
    networkAccess: "disabled",
    approvalPolicy: "never",
    approvalReviewer: "user",
  }),
  forkSettingsEligibility: () => ({
    availability: "available",
    settingsRevision: 1,
    settings: {
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      serviceTier: "standard",
      sandboxMode: "read-only",
      networkAccess: "disabled",
      approvalPolicy: "never",
      approvalReviewer: "user",
    },
  }),
  freezeOperationSnapshot: () => ({
    settings: {
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      serviceTier: "standard",
      sandboxMode: "read-only",
      networkAccess: "disabled",
      approvalPolicy: "never",
      approvalReviewer: "user",
    },
  }),
  observeEffective: () => undefined,
  markEffectiveUnknown: () => undefined,
};

async function startNormalizedLiveProjection(input: {
  readonly scope: Readonly<{ tenantId: string; principalId: string }>;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly workspaceId: string;
  readonly workspace: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly supervisor: CodexDaemonSupervisor;
}): Promise<{
  readonly actor: ConversationActor;
  readonly binding: ReturnType<ConversationEventBridge["bind"]>;
  readonly hub: ThreadEventHub;
  readonly envelopes: ThreadEventEnvelope[];
  close(): Promise<void>;
}> {
  const conversationBinding: ConversationBinding = Object.freeze({
    tenantId: input.scope.tenantId,
    ownerPrincipalId: input.scope.principalId,
    applicationThreadId: input.applicationThreadId,
    backendInstanceId: input.backendInstanceId,
    connectionProfileId: input.connectionProfileId,
    executionEnvironmentId: input.executionEnvironmentId,
    backendConversationId: input.threadId,
    createdAt: new Date().toISOString(),
  });
  const handle = new CodexConversationHandle({
    usageSink: NO_USAGE_SINK,
    nativeNamespace: "test-codex-store",
    usageProvenZero: false,
    binding: conversationBinding,
    canonicalWorkspacePath: input.workspace,
    workspaceId: input.workspaceId,
    opaqueBindingDetail: serializeCodexBindingDetail({
      threadId: input.threadId,
      sessionId: input.sessionId,
      nativeAncestry: null,
      correlationAncestorThreadIds: [],
    }),
    client: input.supervisor.client,
    serverRequests: input.supervisor.serverRequests,
    toolProvenanceKey: new Uint8Array(32).fill(0x33),
    correlationAncestorThreadIds: [],
    executionSettings: normalizedLiveExecutionSettings,
    outputArtifacts: createInMemoryOutputArtifactPublisher(),
    fastModeSessions: new CodexFastModeSessionRegistry(),
    validateExecutionSettings: async () => undefined,
    resolveImportedReasoningEffort: async (_model, observed) =>
      observed ?? "low",
    releaseOwnership: () => undefined,
  });
  const actor = new ConversationActor({
    handle,
    attachmentDelivery: {
      materialize: async () => ({
        attachments: [],
        canonicalBytes: {
          read: async () => {
            throw new Error("unexpected_canonical_attachment_read");
          },
        },
        canonicalEvidence: { resolve: () => [] },
      }),
    } as never,
    environmentLease: {
      scope: input.scope,
      environment: {
        id: input.executionEnvironmentId,
        label: "Local fixture",
        availability: "available",
        diagnosticCode: null,
        revision: 1,
      },
      workspace: {
        canonicalPath: input.workspace,
        authorityRevision: 1,
        summary: {
          id: input.workspaceId,
          environmentId: input.executionEnvironmentId,
          displayName: "Fixture workspace",
          displayPath: input.workspace,
          availability: "available",
          trustState: "trusted",
          revision: 1,
        },
      },
      release: async () => undefined,
    },
    projector: new ConversationProjector({
      backendInstanceId: input.backendInstanceId,
      bindingIdentity: input.applicationThreadId,
    }),
    projectionUpdateIntervalMilliseconds: 1,
  });
  await actor.start({ signal: new AbortController().signal });
  const hub = new ThreadEventHub();
  const envelopes: ThreadEventEnvelope[] = [];
  const subscription = hub.subscribe((envelope) => envelopes.push(envelope));
  const bridge = new ConversationEventBridge({
    snapshot: async (_scope, _threadId, state) =>
      normalizedFixtureSnapshot(state.timeline.generation),
    capabilitiesAndProviderFeatures: async () => ({
      threadRevision: normalizedFixtureSnapshot("unused").thread.threadRevision,
      capabilities: normalizedFixtureSnapshot("unused").capabilities,
      providerFeatures: [],
      interactions: [],
    }),
    forkSource: async () => normalizedFixtureSnapshot("unused").forkSource,
    ancillary: async () => [],
  }, () => undefined);
  const binding = bridge.bind({
    scope: input.scope,
    applicationThreadId: input.applicationThreadId,
    actor,
    hub,
  });
  await binding.ready;
  return {
    actor,
    binding,
    hub,
    envelopes,
    close: async () => {
      subscription.close();
      await binding.release();
      await actor.close();
    },
  };
}

function normalizedFixtureSnapshot(
  generation: string,
): NormalizedThreadSnapshot {
  return {
    forkSource: {
      selectedCompletedTurn: {
        available: false,
        unavailableReason: { text: "Forking is unavailable in this fixture." },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "Latest provider snapshot forking is unavailable in this fixture.",
        },
      },
    },
    forksByTurnId: {},
    thread: {
      id: "33000000-0000-4000-8000-000000000033",
      workspaceId: "workspace-feature-033-normalized-live",
      targetId: "target-feature-033-normalized-live",
      title: { text: "Codex TUI normalized live fixture" },
      backend: { label: { text: "Codex" }, brand: "codex" },
      backingState: "bound",
      inventoryState: "active",
      inventoryRevision: 0,
      threadRevision: 0,
      runState: "idle",
      queuedInputCount: 0,
      available: true,
      lastActivityAt: "2026-08-04T00:00:00.000Z",
      stateChangedAt: "2026-08-04T00:00:00.000Z",
      automation: null,
    },
    executionWorkspace: { kind: "direct" },
    workspace: {
      id: "workspace-feature-033-normalized-live",
      environmentId: "environment-feature-033-normalized-live",
      label: { text: "Fixture workspace" },
      displayPath: { text: "/fixture-workspace" },
      available: true,
    },
    environment: {
      id: "environment-feature-033-normalized-live",
      kind: "local" as const,
      label: { text: "Local fixture" },
      available: true,
      directoryBrowsing: "available" as const,
    },
    draft: {
      text: "",
      contextExcerpts: [],
      taskReferences: [],
      attachments: [],
      revision: 0,
    },
    stashes: [],
    composerCommands: [],
    agentTools: {
      enabled: false,
      accessBoundary: "environment",
      groups: [],
      presentation: { surface: "cli", mode: "progressive" },
      presentationOptions: [
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 0,
    },
    orderedTurnIds: [],
    turnsById: {},
    itemsById: {},
    history: { hasOlder: false },
    runState: "idle",
    queue: [],
    capabilities: {
      revision: `capabilities-${generation}`,
      backend: { label: { text: "Codex" } },
      interactionMode: "interactive",
      runState: "idle",
      operations: [],
      deliveryModes: [],
      settings: [],
      composerActions: [],
      interactions: [],
      providerFeatures: [],
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      composerAttachments: {
        fileStaging: {
          availability: "unavailable",
          reason: {
            text: "Attachment staging is unavailable in this fixture.",
          },
        },
        nativeImage: {
          availability: "unavailable",
          reason: {
            text: "Native image input is unavailable in this fixture.",
          },
        },
        policy: COMPOSER_ATTACHMENT_POLICY,
      },
      history: { available: true, paginated: true },
      automation: {
        available: true,
        canAttach: true,
        canRunNow: true,
        canCloneOnRun: true,
      },
    },
    settings: { revision: 0, values: [] },
    providerFeatures: [],
    usage: {},
    interactions: [],
    attention: {},
  };
}

function codexConfig(providerBaseUrl: string, workspace: string): string {
  return `
model = "gpt-5.6-luna"
model_provider = "sedes_live_fixture"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.sedes_live_fixture]
name = "Sedes TUI disposable fixture"
base_url = ${JSON.stringify(providerBaseUrl)}
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
requires_openai_auth = false

[tui]
auto_recap = true
disable_paste_burst = true
vim_mode_default = true
raw_output_mode = true
alternate_screen = "never"

[tui.keymap.composer]
submit = "ctrl-j"

[projects.${JSON.stringify(workspace)}]
trust_level = "trusted"

[features]
apps = false
plugins = false
`;
}

function startAppServer(
  nativeStoreHome: string,
  cwd: string,
  endpoint: string,
  tokenPath?: string,
): ChildProcess {
  const authenticationArgs = tokenPath
    ? ["--ws-auth", "capability-token", "--ws-token-file", tokenPath]
    : [];
  const child = spawn(
    codexBinary,
    [
      "app-server",
      "--config",
      `sqlite_home=${JSON.stringify(nativeStoreHome)}`,
      "--strict-config",
      "--listen",
      endpoint,
      ...authenticationArgs,
    ],
    {
      cwd,
      detached: true,
      env: {
        HOME: launchHome,
        CODEX_HOME: nativeStoreHome,
        CODEX_SQLITE_HOME: nativeStoreHome,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NO_COLOR: "1",
        TERM: "dumb",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr?.resume();
  return child;
}

async function availableTcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("TCP port unavailable");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function tcpListenerAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => finish(false), 250);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function capturePane(serverName: string): Promise<string> {
  const { stdout } = await execFile("tmux", [
    "-L",
    serverName,
    "capture-pane",
    "-p",
    "-J",
    "-t",
    "codex:0.0",
  ]);
  return stdout;
}

async function stopTmuxServer(serverName: string): Promise<void> {
  await execFile("tmux", ["-L", serverName, "kill-server"]).catch(
    () => undefined,
  );
  tmuxServers.delete(serverName);
}

async function paneSize(serverName: string): Promise<string> {
  const { stdout } = await execFile("tmux", [
    "-L",
    serverName,
    "display-message",
    "-p",
    "-t",
    "codex:0.0",
    "#{pane_width}x#{pane_height}",
  ]);
  return stdout.trim();
}

async function paneAlternateScreenActive(serverName: string): Promise<boolean> {
  const { stdout } = await execFile("tmux", [
    "-L",
    serverName,
    "display-message",
    "-p",
    "-t",
    "codex:0.0",
    "#{alternate_on}",
  ]);
  return stdout.trim() === "1";
}

class JsonRpcWebSocketClient {
  readonly #socket: WebSocket;
  readonly #responses = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  readonly #notifications: JsonRecord[] = [];
  readonly #waiters: Array<{
    method: string;
    predicate(params: unknown): boolean;
    resolve(value: JsonRecord): void;
  }> = [];
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const parsed = asOptionalRecord(
        JSON.parse(Buffer.from(data as Buffer).toString("utf8")),
      );
      if (!parsed) return;
      if (typeof parsed.id === "string") {
        const pending = this.#responses.get(parsed.id);
        if (!pending) return;
        this.#responses.delete(parsed.id);
        if (parsed.error)
          pending.reject(new Error(JSON.stringify(parsed.error)));
        else pending.resolve(parsed.result);
        return;
      }
      if (typeof parsed.method !== "string") return;
      const waiterIndex = this.#waiters.findIndex(
        (waiter) =>
          waiter.method === parsed.method && waiter.predicate(parsed.params),
      );
      if (waiterIndex >= 0) {
        this.#waiters.splice(waiterIndex, 1)[0]!.resolve(parsed);
      } else {
        this.#notifications.push(parsed);
      }
    });
  }

  static async connect(
    url: string,
    token?: string,
  ): Promise<JsonRpcWebSocketClient> {
    const socket = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      perMessageDeflate: false,
      handshakeTimeout: 3_000,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new JsonRpcWebSocketClient(socket);
  }

  async initialize(codexHome: string, experimentalApi: boolean): Promise<void> {
    const initialized = asOptionalRecord(
      await this.request("initialize", {
        clientInfo: {
          name: "sedes_feature_033_probe",
          title: "Sedes FEATURE-033 probe",
          version: "0.1.0",
        },
        capabilities: { experimentalApi, requestAttestation: false },
      }),
    );
    if (initialized?.codexHome !== codexHome) {
      throw new Error("codex_tui_probe_home_identity_mismatch");
    }
    this.#socket.send(JSON.stringify({ method: "initialized" }));
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = `probe-${this.#nextId++}`;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#responses.set(id, { resolve, reject });
      setTimeout(() => {
        const pending = this.#responses.get(id);
        if (!pending) return;
        this.#responses.delete(id);
        pending.reject(new Error(`request timeout: ${method}`));
      }, 10_000).unref();
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return await response;
  }

  async nextNotification(
    method: string,
    predicate: (params: unknown) => boolean,
    timeoutMilliseconds = 15_000,
  ): Promise<JsonRecord> {
    const existing = this.#notifications.findIndex(
      (notification) =>
        notification.method === method && predicate(notification.params),
    );
    if (existing >= 0) return this.#notifications.splice(existing, 1)[0]!;
    return await new Promise<JsonRecord>((resolve, reject) => {
      const waiter = { method, predicate, resolve };
      this.#waiters.push(waiter);
      setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index < 0) return;
        this.#waiters.splice(index, 1);
        reject(new Error(`notification timeout: ${method}`));
      }, timeoutMilliseconds).unref();
    });
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) =>
      this.#socket.once("close", () => resolve()),
    );
    this.#socket.close(1000);
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if ((this.#socket.readyState as number) !== WebSocket.CLOSED) {
      this.#socket.terminate();
    }
  }
}

async function startTrustedWssProxy(
  root: string,
  upstreamEndpoint: string,
  capabilityToken: string,
): Promise<{
  endpoint: string;
  caPath: string;
  authenticatedConnections(): number;
  close(): Promise<void>;
}> {
  const now = Date.now();
  const authority = await generateCertificate(
    [{ name: "commonName", value: "Sedes Codex TUI WSS fixture CA" }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate: new Date(now - 60 * 60 * 1_000),
      notAfterDate: new Date(now + 48 * 60 * 60 * 1_000),
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        {
          name: "keyUsage",
          keyCertSign: true,
          cRLSign: true,
          critical: true,
        },
      ],
    },
  );
  const leaf = await generateCertificate(
    [{ name: "commonName", value: "127.0.0.1" }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate: new Date(now - 60 * 60 * 1_000),
      notAfterDate: new Date(now + 24 * 60 * 60 * 1_000),
      ca: { key: authority.private, cert: authority.cert },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: "extKeyUsage", serverAuth: true },
        {
          name: "subjectAltName",
          altNames: [{ type: 7 as const, ip: "127.0.0.1" }],
        },
      ],
    },
  );
  const caPath = path.join(root, "tui-wss-ca.pem");
  await writeFile(caPath, authority.cert, { encoding: "utf8", mode: 0o600 });
  const server = createHttpsServer({
    key: leaf.private,
    cert: leaf.cert,
    minVersion: "TLSv1.2",
  });
  const websocketServer = new WebSocketServer({ server });
  const sockets = new Set<WebSocket>();
  let authenticatedConnections = 0;
  websocketServer.on("connection", (downstream, request) => {
    sockets.add(downstream);
    downstream.once("close", () => sockets.delete(downstream));
    if (request.headers.authorization !== `Bearer ${capabilityToken}`) {
      downstream.close(1008, "unauthorized");
      return;
    }
    authenticatedConnections += 1;
    const upstream = new WebSocket(upstreamEndpoint, {
      headers: { Authorization: `Bearer ${capabilityToken}` },
      perMessageDeflate: false,
    });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
    downstream.on("message", (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary });
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push({ data, binary });
      }
    });
    upstream.once("open", () => {
      for (const frame of pending.splice(0)) {
        upstream.send(frame.data, { binary: frame.binary });
      }
    });
    upstream.on("message", (data, binary) => {
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data, { binary });
      }
    });
    downstream.once("close", () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000);
      else upstream.terminate();
    });
    upstream.once("close", () => {
      if (downstream.readyState === WebSocket.OPEN) downstream.close(1000);
    });
    upstream.once("error", () => downstream.close(1011));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("trusted WSS proxy address unavailable");
  }
  return {
    endpoint: `wss://127.0.0.1:${address.port}`,
    caPath,
    authenticatedConnections: () => authenticatedConnections,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) =>
        websocketServer.close(() => resolve()),
      );
      await closeServer(server);
    },
  };
}

async function startFixtureProvider(): Promise<{
  baseUrl: string;
  requestCount(): number;
  holdNextResponse(): FixtureProviderHold;
  close(): Promise<void>;
}> {
  let requests = 0;
  let pendingHold:
    | {
        readonly requestOrdinal: number;
        readonly received: Promise<void>;
        readonly resolveReceived: () => void;
        readonly released: Promise<void>;
        readonly resolveReleased: () => void;
      }
    | undefined;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.once("end", async () => {
      requests += 1;
      const hold =
        pendingHold?.requestOrdinal === requests ? pendingHold : undefined;
      if (hold) {
        hold.resolveReceived();
        await hold.released;
        if (pendingHold === hold) pendingHold = undefined;
      }
      const responseId = `fixture-response-${requests}`;
      const messageId = `fixture-message-${requests}`;
      const events: JsonRecord[] = [
        { type: "response.created", response: { id: responseId } },
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
          delta: "fixture streaming complete",
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
              input_tokens: 0,
              input_tokens_details: null,
              output_tokens: 0,
              output_tokens_details: null,
              total_tokens: 0,
            },
          },
        },
      ];
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });
      for (const event of events) {
        response.write(`event: ${String(event.type)}\n`);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture provider address unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
    holdNextResponse: () => {
      if (pendingHold) throw new Error("fixture_provider_hold_already_pending");
      let resolveReceived!: () => void;
      let resolveReleased!: () => void;
      const received = new Promise<void>((resolve) => {
        resolveReceived = resolve;
      });
      const released = new Promise<void>((resolve) => {
        resolveReleased = resolve;
      });
      pendingHold = {
        requestOrdinal: requests + 1,
        received,
        resolveReceived,
        released,
        resolveReleased,
      };
      let releaseCalled = false;
      return {
        received,
        release: () => {
          if (releaseCalled) return;
          releaseCalled = true;
          resolveReleased();
        },
      };
    },
    close: async () => {
      pendingHold?.resolveReleased();
      pendingHold = undefined;
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function stopChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    process.kill(-pid, "SIGKILL");
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMilliseconds: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function asRecord(value: unknown): JsonRecord {
  const record = asOptionalRecord(value);
  if (!record) throw new Error("expected object");
  return record;
}

function asOptionalRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function readRealCodexTuiHome(): string | undefined {
  const value = process.env.SEDES_REAL_CODEX_TUI_HOME;
  if (!value) return undefined;
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error("real_codex_tui_home_gate_invalid");
  }
  return value;
}
