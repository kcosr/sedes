import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokAcpConnection } from "../../src/server/backends/grok/grok-acp-connection.js";
import {
  admitGrokAcpInitializeProfile,
  decodeGrokModelImageInput,
  decodeGrokEffectiveSessionConfiguration,
  decodeGrokInitializeModelCatalog,
  decodeGrokSourceCandidateTurnCompleted,
  GrokAuthenticationRequiredError,
  GROK_ACP_DIALECT_PROFILE,
  GROK_XAI_NOTIFICATIONS,
  GROK_XAI_REQUESTS,
} from "../../src/server/backends/grok/grok-acp-dialect.js";
import { GrokOwnedStdioTransportFactory } from "../../src/server/backends/grok/grok-owned-stdio-transport.js";
import { assertGrokProductionProfileAdmitted } from "../../src/server/backends/grok/grok-release-guard.js";
import type { ResolvedGrokWorkspaceRuntimeConfiguration } from "../../src/server/backends/grok/grok-runtime-config.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../src/server/provider-protocol/transport/framed-message-limits.js";

const fixture = fileURLToPath(
  new URL("../fixtures/grok/fake-grok-acp-peer.mjs", import.meta.url),
);
const scope = Object.freeze({
  tenantId: "tenant-grok",
  principalId: "principal-grok",
});
const executionEnvironmentId = "10000000-0000-4000-8000-000000000020";
const backendInstanceId = "grok-private-test";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Grok ACP 1.0.4 connection generation", () => {
  it("decodes the closed model catalog and effective session selection", () => {
    const catalog = decodeGrokInitializeModelCatalog({
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [
            {
              modelId: "grok-build",
              name: "Grok Build",
              additive: "discarded",
              _meta: {
                acceptsImages: false,
                inputModalities: ["text", "image"],
                supportsReasoningEffort: true,
                reasoningEffort: "low",
                reasoningEfforts: [
                  { value: "low", default: true },
                  { value: "high", default: true },
                ],
              },
            },
          ],
        },
      },
    });
    expect(catalog).toEqual({
      currentModelId: "grok-build",
      availableModels: [
        {
          modelId: "grok-build",
          name: "Grok Build",
          imageInput: false,
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
        },
      ],
    });
    expect(
      decodeGrokEffectiveSessionConfiguration({
        _meta: {
          "x.ai/sessionConfig": {
            options: [
              { id: "grok-build", category: "model", selected: true },
              { id: "other", category: "model", selected: false },
              { id: "low", category: "mode", selected: true },
            ],
          },
        },
      }),
    ).toEqual({ modelId: "grok-build", reasoningEffort: "low" });
    expect(() =>
      decodeGrokInitializeModelCatalog({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
        _meta: {
          modelState: {
            currentModelId: "missing",
            availableModels: [{ modelId: "grok-build", name: "Grok" }],
          },
        },
      }),
    ).toThrow("grok_model_catalog_invalid");
    expect(() =>
      decodeGrokEffectiveSessionConfiguration({
        _meta: {
          "x.ai/sessionConfig": {
            options: [
              { id: "one", category: "model", selected: true },
              { id: "two", category: "model", selected: true },
            ],
          },
        },
      }),
    ).toThrow("grok_session_configuration_invalid");
  });

  it("decodes source-backed model image evidence with explicit precedence", () => {
    expect(
      decodeGrokModelImageInput({
        acceptsImages: false,
        inputModalities: ["text", "image"],
      }),
    ).toBe(false);
    expect(
      decodeGrokModelImageInput({
        acceptsImages: true,
        inputModalities: ["text"],
      }),
    ).toBe(true);
    expect(decodeGrokModelImageInput({ inputModalities: ["text"] })).toBe(
      false,
    );
    expect(
      decodeGrokModelImageInput({ inputModalities: ["TEXT", "IMAGE"] }),
    ).toBe(true);
    expect(decodeGrokModelImageInput({})).toBeUndefined();
    expect(decodeGrokModelImageInput(undefined)).toBeUndefined();
  });

  it("projects the reviewed x.ai routes and rejects incompatible profile shapes", () => {
    expect(GROK_ACP_DIALECT_PROFILE).toBe("grok-acp/1.0.4");
    expect(GROK_XAI_REQUESTS.renameSession.method).toBe("_x.ai/session/rename");
    expect(GROK_XAI_REQUESTS.sessionUpdates.method).toBe(
      "_x.ai/session/updates",
    );
    expect(GROK_XAI_NOTIFICATIONS.sessionUpdatesChunk.method).toBe(
      "_x.ai/session/updates/chunk",
    );
    expect(
      GROK_XAI_REQUESTS.sessionUpdates.decodeRequest({
        sessionId: "s",
        cwd: "/workspace",
        offset: -2,
        limit: 2,
        stream: true,
        chunkSize: 1,
      }),
    ).toEqual({
      sessionId: "s",
      cwd: "/workspace",
      offset: -2,
      limit: 2,
      stream: true,
      chunkSize: 1,
    });
    expect(
      GROK_XAI_REQUESTS.sessionUpdates.decodeRequest({
        sessionId: "s",
        cwd: "/workspace",
        stream: true,
        chunkSize: 2,
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_REQUESTS.sessionUpdates.decodeResponse({
        totalCount: 2,
        chunkCount: 2,
        lastEventId: "event-2",
        promptStarts: [0],
      }),
    ).toEqual({
      totalCount: 2,
      chunkCount: 2,
      lastEventId: "event-2",
      promptStarts: [0],
    });
    expect(
      GROK_XAI_REQUESTS.sessionUpdates.decodeResponse({
        totalCount: 2,
        chunkCount: 2,
        promptStarts: [],
        updates: [],
      }),
    ).toBeUndefined();
    const storedUpdate = {
      timestamp: 1,
      method: "session/update",
      params: {
        sessionId: "s",
        update: { sessionUpdate: "agent_message_chunk" },
      },
    };
    expect(
      GROK_XAI_NOTIFICATIONS.sessionUpdatesChunk.decodeParams({
        sessionId: "s",
        index: 0,
        updates: [storedUpdate],
        done: true,
      }),
    ).toEqual({
      sessionId: "s",
      index: 0,
      updates: [storedUpdate],
      done: true,
    });
    expect(
      GROK_XAI_NOTIFICATIONS.sessionUpdatesChunk.decodeParams({
        sessionId: "s",
        index: 0,
        updates: [storedUpdate, storedUpdate],
        done: true,
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_NOTIFICATIONS.sessionUpdatesChunk.decodeParams({
        sessionId: "s",
        index: 0,
        updates: [],
        done: true,
      }),
    ).toEqual({ sessionId: "s", index: 0, updates: [], done: true });
    expect(
      GROK_XAI_NOTIFICATIONS.sessionUpdatesChunk.decodeParams({
        sessionId: "s",
        index: 0,
        updates: [
          {
            method: "session/update",
            params: { sessionId: "s", update: {} },
          },
        ],
        done: true,
      }),
    ).toEqual({
      sessionId: "s",
      index: 0,
      updates: [
        {
          timestamp: 0,
          method: "session/update",
          params: { sessionId: "s", update: {} },
        },
      ],
      done: true,
    });
    expect(
      GROK_XAI_REQUESTS.renameSession.decodeResponse({ success: true }),
    ).toEqual({ success: true });
    expect(
      GROK_XAI_REQUESTS.renameSession.decodeResponse({
        result: { success: true },
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_NOTIFICATIONS.promptComplete.decodeParams({
        sessionId: "s",
        promptId: "p",
        stopReason: "end_turn",
        agentResult: null,
        additive: "ignored",
      }),
    ).toEqual({
      sessionId: "s",
      promptId: "p",
      stopReason: "end_turn",
      agentResult: null,
    });
    expect(
      GROK_XAI_NOTIFICATIONS.promptComplete.decodeParams({
        method: "x.ai/session/prompt_complete",
        params: { sessionId: "s", stopReason: "cancelled" },
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_NOTIFICATIONS.promptComplete.decodeParams({
        sessionId: "s",
        stopReason: "cancelled",
      }),
    ).toEqual({ sessionId: "s", stopReason: "cancelled" });
    expect(
      decodeGrokSourceCandidateTurnCompleted({
        sessionId: "s",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p",
          stop_reason: "end_turn",
          additive: true,
        },
        _meta: {
          eventId: "s-1",
          promptId: "p",
          isReplay: true,
          additive: true,
        },
      }),
    ).toEqual({
      sessionId: "s",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "p",
        stop_reason: "end_turn",
      },
      _meta: { eventId: "s-1", promptId: "p", isReplay: true },
    });
    expect(
      GROK_XAI_NOTIFICATIONS.liveSessionNotification.decodeParams({
        sessionId: "s",
        update: { sessionUpdate: "retry_state", secretPayload: "discarded" },
      }),
    ).toEqual({ kind: "passive_ignored", sessionId: "s" });
    expect(
      GROK_XAI_NOTIFICATIONS.replaySessionUpdate.decodeParams({
        sessionId: "s",
        update: { sessionUpdate: "hook_annotation", payload: "discarded" },
      }),
    ).toEqual({ kind: "passive_ignored", sessionId: "s" });
    expect(
      GROK_XAI_NOTIFICATIONS.liveSessionNotification.decodeParams({
        sessionId: "parent",
        update: {
          sessionUpdate: "subagent_spawned",
          subagent_id: "child",
          parent_session_id: "parent",
          parent_prompt_id: "prompt",
          child_session_id: "child",
          subagent_type: "reviewer",
          description: "Review the change",
        },
        _meta: { eventId: "spawn-1" },
      }),
    ).toEqual({
      kind: "subagent",
      sessionId: "parent",
      event: {
        kind: "spawned",
        sessionId: "parent",
        subagentId: "child",
        childSessionId: "child",
        parentSessionId: "parent",
        parentPromptId: "prompt",
        subagentType: "reviewer",
        description: "Review the change",
        eventId: "spawn-1",
        replay: false,
      },
    });
    expect(
      GROK_XAI_NOTIFICATIONS.liveSessionNotification.decodeParams({
        sessionId: "parent",
        update: {
          sessionUpdate: "subagent_progress",
          subagent_id: "child",
          parent_session_id: "parent",
          child_session_id: "child",
          duration_ms: 10,
          turn_count: 1,
          tool_call_count: 2,
          tokens_used: 3,
          context_window_tokens: 100,
          context_usage_pct: 3,
          tools_used: ["Read"],
          error_count: 0,
        },
      }),
    ).toMatchObject({
      kind: "subagent",
      event: { kind: "progress", replay: false, subagentId: "child" },
    });
    expect(
      GROK_XAI_NOTIFICATIONS.liveSessionNotification.decodeParams({
        sessionId: "parent",
        update: {
          sessionUpdate: "subagent_finished",
          subagent_id: "child",
          child_session_id: "child",
          status: "completed",
          tool_calls: 2,
          turns: 1,
          duration_ms: 20,
          tokens_used: 4,
          output: "done",
          will_wake: false,
        },
        _meta: { eventId: "finish-1" },
      }),
    ).toMatchObject({
      kind: "subagent",
      event: { kind: "finished", replay: false, outcome: "completed" },
    });
    expect(
      GROK_XAI_NOTIFICATIONS.replaySessionUpdate.decodeParams({
        sessionId: "parent",
        update: {
          sessionUpdate: "subagent_progress",
          subagent_id: "child",
          parent_session_id: "parent",
          child_session_id: "child",
          duration_ms: 10,
          turn_count: 1,
          tool_call_count: 2,
          tokens_used: 3,
          context_window_tokens: 100,
          context_usage_pct: 3,
          tools_used: [],
          error_count: 0,
        },
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_NOTIFICATIONS.liveSessionNotification.decodeParams({
        sessionId: "s",
        update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" },
        _meta: { eventId: "s-malformed" },
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_NOTIFICATIONS.liveSessionNotification.decodeParams({
        method: "x.ai/session_notification",
        params: {
          sessionId: "s",
          update: { sessionUpdate: "retry_state" },
        },
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_NOTIFICATIONS.replaySessionUpdate.decodeParams({
        method: "x.ai/session/update",
        params: {
          sessionId: "s",
          update: { sessionUpdate: "hook_annotation" },
        },
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_REQUESTS.renameSession.decodeRequest({
        sessionId: "s",
        title: "Manual title",
        cwd: "/workspace",
        kind: "build",
        resetToAuto: false,
        additive: true,
      }),
    ).toEqual({
      sessionId: "s",
      title: "Manual title",
      cwd: "/workspace",
      kind: "build",
      resetToAuto: false,
    });
    expect(() =>
      admitGrokAcpInitializeProfile({
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
      }),
    ).toThrow("grok_acp_initialize_profile_incompatible");
    const compatibleCapabilities = {
      loadSession: true,
      promptCapabilities: { embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, close: {} },
    } as const;
    expect(
      admitGrokAcpInitializeProfile({
        protocolVersion: 1,
        agentCapabilities: {
          ...compatibleCapabilities,
          promptCapabilities: {
            embeddedContext: true,
            image: true,
            audio: true,
          },
          sessionCapabilities: {
            ...compatibleCapabilities.sessionCapabilities,
            delete: {},
            fork: {},
            additionalDirectories: {},
          },
        },
        authMethods: [{ id: "cached_token", name: "Cached token" }],
      }),
    ).toBeDefined();
    const renameBase = {
      sessionId: "s",
      cwd: "/workspace",
      kind: "build",
      resetToAuto: false,
    } as const;
    expect(
      GROK_XAI_REQUESTS.renameSession.decodeRequest({
        ...renameBase,
        title: "a".repeat(101),
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_REQUESTS.renameSession.decodeRequest({
        ...renameBase,
        title: "\u001b".repeat(65) + "👍".repeat(100),
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_REQUESTS.renameSession.decodeRequest({
        ...renameBase,
        title: "\u001b\u0007\n\t\u009b",
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_REQUESTS.renameSession.decodeRequest({
        ...renameBase,
        cwd: "relative",
        title: "Title",
      }),
    ).toBeUndefined();
    expect(
      GROK_XAI_REQUESTS.renameSession.decodeRequest({
        ...renameBase,
        title: "  Safe\u001b title\u202e  ",
      })?.title,
    ).toBe("Safe title");
    expect(
      GROK_XAI_REQUESTS.renameSession.decodeRequest({
        ...renameBase,
        title: "\ufeffTitle\ufeff",
      })?.title,
    ).toBe("\ufeffTitle\ufeff");
    expect(
      GROK_XAI_REQUESTS.renameSession.decodeRequest({
        ...renameBase,
        title: "bad\ud800title",
      }),
    ).toBeUndefined();
    expect(() =>
      admitGrokAcpInitializeProfile({
        protocolVersion: 1,
        agentCapabilities: compatibleCapabilities,
        authMethods: [{ id: "grok.com", name: "Grok.com" }],
      }),
    ).toThrow("grok_acp_initialize_profile_incompatible");
    expect(() =>
      admitGrokAcpInitializeProfile({
        protocolVersion: 1,
        agentCapabilities: compatibleCapabilities,
        authMethods: [
          { id: "cached_token", name: "First" },
          { id: "cached_token", name: "Duplicate" },
        ],
      }),
    ).toThrow("grok_acp_initialize_profile_incompatible");
    expect(() =>
      admitGrokAcpInitializeProfile({
        protocolVersion: 1,
        agentCapabilities: compatibleCapabilities,
        authMethods: [
          {
            id: "cached_token",
            name: "Environment token",
            type: "env_var",
            vars: [],
          },
        ],
      }),
    ).toThrow("grok_acp_initialize_profile_incompatible");
  });

  it("inherits shared owned-stdio flow control, ignores startup, and routes only authorized sessions", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-peer-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const nativeHome = path.join(root, "native-home");
    const nativeGrokHome = path.join(nativeHome, ".grok");
    await Promise.all([
      mkdir(workspace),
      mkdir(nativeGrokHome, { recursive: true }),
    ]);
    const providerScope = {
      ...scope,
      backendInstanceId,
      executionEnvironmentId,
    };
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId,
      environment: { PATH: process.env.PATH },
    });
    const prepared = await channels.prepareOwnedProcess(providerScope, {
      executablePath: fixture,
      workingDirectory: workspace,
    });
    const runtime: ResolvedGrokWorkspaceRuntimeConfiguration = Object.freeze({
      scope,
      backendInstanceId,
      executionEnvironmentId,
      workspace,
      environment: Object.freeze({
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: nativeHome,
        GROK_HOME: nativeGrokHome,
      }),
      process: prepared,
      executable: Object.freeze({
        path: fixture,
        version: "1.0.4",
        build: "d846eb93d9",
        compatibilityRelease: "1.x",
        reviewedProfile: "grok-acp/1.0.4",
        newerThanTested: false,
        assessment: Object.freeze({
          observedVersion: "1.0.4",
          minimumVersion: "1.0.4",
          testedThroughVersion: "1.0.4",
          newerThanTested: false,
        }),
      }),
    });
    const factory = new GrokOwnedStdioTransportFactory({ runtime, channels });
    const transport = await factory.open(7, new AbortController().signal);
    const standard: SessionNotification[] = [];
    let markHistoryBarrierEntered!: () => void;
    const historyBarrierEntered = new Promise<void>((resolve) => {
      markHistoryBarrierEntered = resolve;
    });
    let releaseHistoryBarrier!: () => void;
    const authorizeSession = vi.fn(
      (sessionId: string) => sessionId === "session-allowed",
    );
    const connection = await GrokAcpConnection.open({
      transport,
      expectedScope: factory.scope,
      connectionGeneration: 7,
      sink: {
        notificationDisposition: () => "dispatch",
        authorizeSession,
        authorizePermissionSession: (sessionId) =>
          sessionId === "session-allowed",
        subagentEvent: () => undefined,
        sessionUpdate: async (notification) => {
          standard.push(notification);
          const update = notification.update;
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text" &&
            update.content.text === "history-barrier"
          ) {
            markHistoryBarrierEntered();
            await new Promise<void>((resolve) => {
              releaseHistoryBarrier = resolve;
            });
          }
        },
        liveTurnCompleted: () => undefined,
        replaySessionUpdate: () => undefined,
        permissionRequested: () => ({
          outcome: { outcome: "cancelled" as const },
        }),
      },
    });
    await waitFor(
      () =>
        standard.length === 3 &&
        connection.diagnostics().ignoredNotifications === 3,
    );

    expect(standard[0]?.sessionId).toBe("session-allowed");
    expect(standard[1]).toMatchObject({
      sessionId: "session-allowed",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-output-regression",
        status: "completed",
      },
    });
    expect(transport.maximumFrameBytes).toBe(MAXIMUM_PROVIDER_FRAME_BYTES);
    expect(standard[2]).toMatchObject({
      sessionId: "session-allowed",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "large-image-output-regression",
        status: "completed",
      },
    });
    const largeImageUpdate = standard[2]?.update;
    expect(
      largeImageUpdate?.sessionUpdate === "tool_call_update" &&
        largeImageUpdate.content?.[0]?.type === "content" &&
        largeImageUpdate.content[0].content.type === "image"
        ? largeImageUpdate.content[0].content.data.length
        : 0,
    ).toBe(2 * 1_024 * 1_024);
    expect(connection.diagnostics()).toMatchObject({
      initialized: true,
      ignoredNotifications: 3,
      deniedReverseRequests: 0,
      protocolFailures: 0,
    });
    expect(transport.diagnostics().inboundFramesRead).toBeGreaterThan(64);
    expect(authorizeSession).toHaveBeenCalledTimes(3);
    const historyPending = connection.readNativeHistory({
      sessionId: "session-allowed",
      cwd: workspace,
    });
    await historyBarrierEntered;
    await expect(
      Promise.race([
        historyPending.then(() => "settled" as const),
        new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), 20),
        ),
      ]),
    ).resolves.toBe("pending");
    releaseHistoryBarrier();
    const history = await historyPending;
    expect(history).toMatchObject({
      totalCount: 2,
      lastEventId: "history-2",
    });
    expect(history.updates.map((update) => update.timestamp)).toEqual([1, 2]);
    expect(connection.diagnostics().closed).toBe(false);

    const emptyCancellation = new AbortController();
    const outboundFramesBeforeEmptyHistory =
      transport.diagnostics().outboundFramesWritten;
    const emptyHistory = connection.readNativeHistory({
      sessionId: "session-allowed",
      cwd: workspace,
      offset: 777,
      signal: emptyCancellation.signal,
    });
    await waitFor(
      () =>
        transport.diagnostics().outboundFramesWritten ===
        outboundFramesBeforeEmptyHistory + 1,
    );
    emptyCancellation.abort();
    await expect(emptyHistory).rejects.toMatchObject({
      code: "grok_native_history_aborted",
    });
    await expect(
      connection.readNativeHistory({
        sessionId: "session-allowed",
        cwd: workspace,
      }),
    ).rejects.toMatchObject({ code: "grok_native_history_busy" });
    await waitFor(() => connection.diagnostics().rejectedLateResponses === 1);
    await expect(
      connection.readNativeHistory({
        sessionId: "session-allowed",
        cwd: workspace,
        offset: 778,
      }),
    ).resolves.toEqual({ updates: [], totalCount: 0, promptStarts: [] });
    expect(connection.diagnostics().closed).toBe(false);

    const diagnostics = transport.diagnostics();
    expect(diagnostics.stderrBytesRead).toBeGreaterThan(0);
    const stderrTail = diagnostics.stderrTail;
    expect(stderrTail).toBe("");
    expect(stderrTail).not.toContain(nativeGrokHome);
    expect(stderrTail).not.toContain(nativeHome);
    expect(stderrTail).not.toContain(workspace);
    await connection.close("test_complete");
    await expect(connection.closed).resolves.toMatchObject({
      reason: "test_complete",
    });
  });

  it("classifies native cached-token authentication failure without inspecting credentials", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-auth-failure-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const nativeHome = path.join(root, "native-home");
    await Promise.all([mkdir(workspace), mkdir(nativeHome)]);
    const providerScope = {
      ...scope,
      backendInstanceId,
      executionEnvironmentId,
    };
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId,
    });
    const prepared = await channels.prepareOwnedProcess(providerScope, {
      executablePath: fixture,
      workingDirectory: workspace,
    });
    const runtime: ResolvedGrokWorkspaceRuntimeConfiguration = Object.freeze({
      scope,
      backendInstanceId,
      executionEnvironmentId,
      workspace,
      environment: Object.freeze({
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: nativeHome,
        GROK_TEST_AUTH_FAILURE: "1",
      }),
      process: prepared,
      executable: Object.freeze({
        path: fixture,
        version: "1.0.4",
        build: "d846eb93d9",
        compatibilityRelease: "1.x",
        reviewedProfile: "grok-acp/1.0.4",
        newerThanTested: false,
        assessment: Object.freeze({
          observedVersion: "1.0.4",
          minimumVersion: "1.0.4",
          testedThroughVersion: "1.0.4",
          newerThanTested: false,
        }),
      }),
    });
    const factory = new GrokOwnedStdioTransportFactory({ runtime, channels });
    const transport = await factory.open(8, new AbortController().signal);

    await expect(
      GrokAcpConnection.open({
        transport,
        expectedScope: factory.scope,
        connectionGeneration: 8,
        sink: {
          notificationDisposition: () => "dispatch",
          authorizeSession: () => false,
          authorizePermissionSession: () => false,
          subagentEvent: () => undefined,
          sessionUpdate: () => undefined,
          liveTurnCompleted: () => undefined,
          replaySessionUpdate: () => undefined,
          permissionRequested: () => ({
            outcome: { outcome: "cancelled" as const },
          }),
        },
      }),
    ).rejects.toMatchObject({
      name: "GrokAuthenticationRequiredError",
      category: "unavailable",
      retryable: true,
      crossedSubmissionBoundary: false,
      backendCode: "grok_authentication_required",
      safeMessage:
        "Grok authentication is required. Log in with the native Grok installation and retry.",
    });
  });

  it("admits and compiles the exact reviewed production profile", () => {
    expect(assertGrokProductionProfileAdmitted).not.toThrow();
    expect(
      compiledBackendModuleCatalog.moduleForBackendKind("grok_build"),
    ).toMatchObject({ backendKind: "grok_build" });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("grok_fake_peer_timeout");
}
