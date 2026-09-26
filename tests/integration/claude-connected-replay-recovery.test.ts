import Database from "better-sqlite3";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import { ClaudeConversationHandle } from "../../src/server/backends/claude/claude-conversation-handle.js";
import { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";

import type { EnvironmentVariableOverrides } from "../../src/shared/protocol/environment-variables.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { randomUUID } from "node:crypto";
import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeRuntimeSessionOptions } from "../../src/server/backends/claude/claude-runtime-client.js";
import { ClaudePersistentRuntimeClient } from "../../src/server/backends/claude/runtime/claude-remote-runtime-client.js";
import { ClaudePersistentRuntimeRegistry } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-registry.js";
import { claudePersistentAttachmentSchema, type ClaudePersistentEvent } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-wire.js";
import { ClaudeSidecarRuntimeConnection, registerClaudePersistentRuntimeHost } from "../../src/server/backends/claude/runtime/claude-sidecar-runtime.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { SidecarRuntimeLease, SidecarRuntimeProvider } from "../../src/server/sidecar/runtime-channel.js";
import { createClaudeFramedCarrier, createFakePersistentClaudeRuntime } from "../helpers/persistent-claude-fixture.js";

const scope = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "ssh-environment", backendInstanceId: "claude-remote" };
const configuration = { ...scope, executablePath: "/provider/claude", configDirectory: "/provider/.claude", initializationTimeoutMs: 5_000 };
const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const native = createFakePersistentClaudeRuntime();
  const archive = vi.fn(async (_record: unknown) => {});
  const services = new PersistentSidecarServiceRegistry({
    scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64),
    runtimeWireVersion: 1, configuration: serviceConfiguration, recordAbandonment: archive,
  });
  const createRuntime = vi.fn(() => native.runtime);
  const hosts = new ClaudePersistentRuntimeRegistry({
    scope, executionEnvironmentId: scope.executionEnvironmentId,
    environmentChannel: {} as ExecutionEnvironmentChannelProvider, environment: {}, services,
    artifact: async () => { throw new Error("test_provider_must_not_launch_artifact"); },
    createRuntime,
  });
  let current: SidecarRuntimeLease | undefined;
  const sidecarRuntime: SidecarRuntimeProvider = {
    acquire: vi.fn(async signal => {
      signal?.throwIfAborted();
      if (!current) throw new Error("test_carrier_unavailable");
      return current;
    }),
  };
  const clients: ClaudePersistentRuntimeClient[] = [];
  const carriers: { close(): Promise<void> }[] = [];
  async function attach() {
    const carrier = await createClaudeFramedCarrier();
    const controllerEpoch = services.attach(serviceConfiguration);
    const detach = registerClaudePersistentRuntimeHost({
      registry: carrier.hostRegistry, channel: carrier.hostChannel, hosts, controllerEpoch,
      onDetach: () => services.detach(controllerEpoch),
    });
    await carrier.start();
    let disconnected!: () => void;
    const lease: SidecarRuntimeLease = {
      channel: carrier.mainChannel, controllerEpoch, serviceIncarnation: services.serviceIncarnation,
      closed: new Promise<void>(resolve => { disconnected = resolve; }), release: vi.fn(),
    };
    current = lease;
    const attached = {
      ...carrier, lease,
      connection: new ClaudeSidecarRuntimeConnection(carrier.mainChannel),
      async close() {
        if (current === lease) current = undefined;
        detach();
        disconnected();
        await carrier.close();
      },
    };
    carriers.push(attached);
    return attached;
  }
  function client(startupEnvironmentVariables?: EnvironmentVariableOverrides) {
    const value = new ClaudePersistentRuntimeClient({ ...configuration, scope, sidecarRuntime, startupEnvironmentVariables });
    clients.push(value);
    return value;
  }
  async function stop(force: boolean) {
    const status = services.status();
    await services.stop({
      expectedServiceIncarnation: status.serviceIncarnation, controllerEpoch: status.controllerEpoch,
      expectedConfiguration: serviceConfiguration, expectedResourcesFingerprint: status.resourcesFingerprint,
      force, reason: "test_explicit_service_stop",
    });
  }
  cleanups.push(async () => {
    for (const client of clients) await client.close();
    for (const carrier of carriers) await carrier.close();
    await native.runtime.close();
  });
  return { ...native, services, hosts, attach, client, stop, archive, createRuntime };
}

function sessionOptions(sessionId: string, overrides: Partial<ClaudeRuntimeSessionOptions> = {}): ClaudeRuntimeSessionOptions {
  return { executablePath: configuration.executablePath, initializationTimeoutMs: 5_000,
    sessionId, cwd: "/workspace", launch: "new", environment: {}, onMessage: vi.fn(), ...overrides };
}
function delta(sessionId: string, text: string): SDKMessage {
  return { type: "stream_event", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } };
}
function acceptedInput(sessionId: string, operation: { operationId: string; content: string }) {
  return { type: "user", uuid: operation.operationId, session_id: sessionId,
    parent_tool_use_id: null, message: { role: "user", content: operation.content } };
}


function completed(sessionId: string, index: number): SDKMessage {
  return { type: "assistant", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
    message: { id: `assistant-${index}`, type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: [{ type: "text", text: `Completed work ${index}` }], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as SDKMessage;
}

function stream(sessionId: string, event: unknown): SDKMessage {
  return { type: "stream_event", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, event } as SDKMessage;
}

describe("connected Claude replay reclamation recovery", () => {
  it.each([false, true])("reads multiple history pages through the remote carrier (stopped=%s)", async stopped => {
    const f = await fixture();
    const carrier = await f.attach();
    const client = f.client();
    const sessionId = randomUUID();
    const runtimeId = await carrier.connection.ensure(configuration);
    carrier.connection.onEvent(runtimeId, () => {});
    await carrier.connection.execute({ runtimeId, controllerEpoch: carrier.lease.controllerEpoch,
      action: "open", replay: "full", request: { queryId: sessionId, sessionId, cwd: "/workspace",
        launch: "new", environment: {}, enableCanUseTool: false } });
    const history = Array.from({ length: 3 }, (_, index) => ({
      type: "assistant", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null,
      message: { id: `paged-${index}`, role: "assistant", content: [{ type: "text", text: `${index}:` + "x".repeat(2 * 1024 * 1024) }] },
    } as SessionMessage));
    f.runtime.getSessionInfo.mockResolvedValue({ sessionId, lastModified: 1, fileSize: 1 } as never);
    f.runtime.getSessionMessages.mockResolvedValue(history);
    if (stopped) {
      const native = f.sessions[0]!;
      // A late unadopted output keeps the intentionally stopped host available
      // for the existing recovery handoff, after its worker is gone.
      f.runtime.close.mockImplementationOnce(async () => {
        await native.emit(delta(sessionId, "late output"));
        await native.close();
      });
      await expect(f.hosts.get(runtimeId).stop()).rejects.toThrow("sidecar_resource_handoff_pending");
      expect(native.closed).toBe(true);
      f.runtime.getSessionMessages.mockRejectedValue(new Error("worker has stopped"));
      f.runtime.getSessionMessagesPage.mockRejectedValue(new Error("worker has stopped"));
    }
    const changed = history.map((message, index) => ({ ...message,
      message: { ...(message.message as Record<string, unknown>), content: [{ type: "text", text: `rewritten-${index}` }] } }));
    const readPage = client.getSessionMessagesPage.bind(client);
    let rewritten = false;
    vi.spyOn(client, "getSessionMessagesPage").mockImplementation(async (...args) => {
      const page = await readPage(...args);
      if (!stopped && !rewritten && page.nextCursor) {
        rewritten = true;
        f.runtime.getSessionMessages.mockResolvedValue(changed);
      }
      return page;
    });
    // Even a native prefix rewrite after page one cannot splice the captured
    // acquisition. A later acquisition observes the new provider history.
    await expect(client.getSessionMessages(sessionId, { dir: "/workspace" }, {})).resolves.toEqual(history);
    if (!stopped) {
      expect(f.runtime.getSessionMessagesPage.mock.calls.length).toBeGreaterThan(1);
      await expect(client.getSessionMessages(sessionId, { dir: "/workspace" }, {})).resolves.toEqual(changed);
    }
  }, 30_000);

  it.each([false, true])("reports native transcript presence through the remote carrier (stopped=%s)", async stopped => {
    const f = await fixture();
    const carrier = await f.attach();
    const client = f.client();
    const sessionId = randomUUID();
    const runtimeId = await carrier.connection.ensure(configuration);
    carrier.connection.onEvent(runtimeId, () => {});
    await carrier.connection.execute({ runtimeId, controllerEpoch: carrier.lease.controllerEpoch,
      action: "open", replay: "full", request: { queryId: sessionId, sessionId, cwd: "/workspace",
        launch: "new", environment: {}, enableCanUseTool: false } });
    // Only Sedes' startup message was persisted, so the SDK reports no metadata.
    f.runtime.getSessionInfo.mockResolvedValue(undefined);
    f.runtime.hasSessionTranscript.mockResolvedValue(true);
    if (stopped) {
      const native = f.sessions[0]!;
      f.runtime.close.mockImplementationOnce(async () => {
        await native.emit(delta(sessionId, "late output"));
        await native.close();
      });
      await expect(f.hosts.get(runtimeId).stop()).rejects.toThrow("sidecar_resource_handoff_pending");
      f.runtime.hasSessionTranscript.mockRejectedValue(new Error("worker has stopped"));
    }
    await expect(client.hasSessionTranscript(sessionId, { dir: "/workspace" }, {})).resolves.toBe(true);
    expect(f.runtime.hasSessionTranscript).toHaveBeenCalledWith(sessionId, { dir: "/workspace" }, {});
    if (stopped) {
      await expect(client.hasSessionTranscript(sessionId, { dir: "/elsewhere" }, {}))
        .rejects.toThrow();
    } else {
      f.runtime.hasSessionTranscript.mockResolvedValue(false);
      await expect(client.hasSessionTranscript(randomUUID(), { dir: "/workspace" }, {})).resolves.toBe(false);
    }
  }, 30_000);

  it.each([false, true])("hydrates reclaimed history and an unfinished response after main replacement (usage=%s)", async enabled => {
    const f = await fixture();
    const firstCarrier = await f.attach();
    const firstClient = f.client();
    const sessionId = randomUUID();
    const received: SDKMessage[] = [];
    const first = firstClient.createSession(sessionOptions(sessionId, {
      canUseTool: async () => ({ behavior: "deny", message: "No tool request expected in this fixture." }),
      onMessage: message => { received.push(message); },
    }));
    await first.start();
    const native = f.sessions[0]!;
    const operation = { operationId: randomUUID(), content: "Continue working through many steps" };
    await first.send(operation);
    const user = acceptedInput(sessionId, operation) as SDKMessage;
    const history: SessionMessage[] = [{ ...user, parent_agent_id: null } as SessionMessage];
    f.runtime.getSessionMessages.mockImplementation(async () => [...history]);
    // Complete native content is available in history before each live frame,
    // but no foreground terminal result arrives during this whole test.
    for (let index = 0; index < 1100; index++) {
      const message = completed(sessionId, index);
      history.push({ ...message, parent_agent_id: null } as SessionMessage);
      await native.emit(message);
      if (index % 50 === 0) await vi.waitFor(() =>
        expect(received.filter(message => message.type === "assistant")).toHaveLength(index + 1),
      { timeout: 5000, interval: 5 });
    }
    await vi.waitFor(() => expect(received.filter(message => message.type === "assistant")).toHaveLength(1100), { timeout: 5000 });
    await vi.waitFor(() => expect(f.runtime.getSessionMessages).toHaveBeenCalled(), { timeout: 7000 });
    await native.emit(stream(sessionId, { type: "message_start", message: { id: "unfinished" } }));
    await native.emit(stream(sessionId, { type: "content_block_start", index: 0, content_block: { type: "text", text: "Unfinished " } }));
    await native.emit(delta(sessionId, "prefix"));
    await vi.waitFor(() => expect(f.services.status().resources[0]!.blockers).toEqual(["active_work"]));
    const runtimeId = f.services.status().resources[0]!.resourceId;
    await firstClient.close();
    await firstCarrier.close();
    expect(native.closed).toBe(false);

    const secondCarrier = await f.attach();
    const attachment = claudePersistentAttachmentSchema.parse(await secondCarrier.connection.execute({
      runtimeId, controllerEpoch: secondCarrier.lease.controllerEpoch, action: "attach", replay: "full", request: { sessionId },
    }));
    expect(attachment.events.filter(event => event.payload.kind === "message" && event.payload.message.uuid === history[1]!.uuid)).toEqual([]);
    expect(attachment.events.some(event => event.payload.kind === "message" && event.payload.message.type === "stream_event")).toBe(true);

    const database = new Database(":memory:");
    initializeEmptyBackendNormalizedDatabase(database);
    // Only provider settings are under test; application inventory is not used.
    database.pragma("foreign_keys = OFF");
    cleanups.push(async () => { database.close(); });
    const settings = new ClaudeThreadRepository(database);
    const binding = { ...scope, ownerPrincipalId: scope.principalId, applicationThreadId: "thread", connectionProfileId: "profile",
      backendConversationId: sessionId, createdAt: "2026-09-24T00:00:00.000Z" };
    settings.initialize(scope, binding.applicationThreadId, binding,
      { model: "claude-sonnet-4-6", effort: "low", permissionMode: "default" }, 1);
    const client = f.client();
    const handle = new ClaudeConversationHandle({
      usage: { ...NO_USAGE_SINK, enabled }, nativeNamespace: "test", binding, canonicalWorkspacePath: "/workspace", workspaceId: "workspace",
      opaqueBindingDetail: '{"version":1}', runtimeClient: client, executablePath: configuration.executablePath, initializationTimeoutMs: 5000,
      permissionPolicy: { allowedModes: ["default"] }, modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
      queryGeneration: 2, attachmentProvenanceKey: new Uint8Array(32).fill(1), settings,
      forkBoundaryAuthentication: { installationKey: new Uint8Array(32).fill(2), ...scope }, childEnvironment: {},
      loadInitialMessages: () => client.getSessionMessages(sessionId, { dir: "/workspace" }, {}), resumeSession: true, releaseSession: () => {},
    });
    cleanups.push(async () => { await handle.close(); });
    const restored = await handle.establishProjection({ signal: new AbortController().signal });
    const items = Object.values(restored.snapshot.itemsById);
    expect(items.filter(item => item.semanticKind === "assistant_message" && item.markdown.text.startsWith("Completed work "))).toHaveLength(1100);
    expect(items.filter(item => "markdown" in item && item.markdown.text === "Completed work 0")).toHaveLength(1);
    expect(items.filter(item => "markdown" in item && item.markdown.text === "Unfinished prefix")).toHaveLength(1);
    expect(restored.snapshot.runState).toBe("running");
    await native.emit(delta(sessionId, " continues"));
    await vi.waitFor(async () => {
      const updated = await handle.establishProjection({ signal: new AbortController().signal });
      expect(Object.values(updated.snapshot.itemsById).filter(item => "markdown" in item && item.markdown.text === "Unfinished prefix continues")).toHaveLength(1);
    });
    // Same-main reconnect must replay only the missing suffix, preserving its
    // already-restored history and partial text without duplicating either.
    await secondCarrier.close();
    await native.emit(delta(sessionId, " after reconnect"));
    await f.attach();
    await client.attachment();
    await vi.waitFor(async () => {
      const updated = await handle.establishProjection({ signal: new AbortController().signal });
      const items = Object.values(updated.snapshot.itemsById);
      expect(items.filter(item => "markdown" in item && item.markdown.text === "Unfinished prefix continues after reconnect")).toHaveLength(1);
      expect(items.filter(item => item.semanticKind === "assistant_message" && item.markdown.text.startsWith("Completed work "))).toHaveLength(1100);
    }, { timeout: 5000 });
    expect(f.runtime.createSession).toHaveBeenCalledTimes(1);
    expect(native.send).toHaveBeenCalledTimes(1);
    expect(native.closed).toBe(false);
  }, 30_000);
});

function lifecycle(sessionId: string, operationId: string, state: "queued" | "started" | "cancelled"): SDKMessage {
  return { type: "command_lifecycle", command_uuid: operationId, state, uuid: randomUUID(), session_id: sessionId } as unknown as SDKMessage;
}

describe("Stop after main replacement", () => {
  it("withdraws a steer only the replaced main sent, before interrupting, so it never runs after the Stop", async () => {
    const f = await fixture();
    const firstCarrier = await f.attach();
    const firstClient = f.client();
    const sessionId = randomUUID();
    // The same query authority a Claude handle opens with.
    const first = firstClient.createSession(sessionOptions(sessionId, {
      canUseTool: async () => ({ behavior: "deny", message: "No tool request expected in this fixture." }),
    }));
    await first.start();
    const native = f.sessions[0]!;
    const turn = { operationId: randomUUID(), content: "Run the long task." };
    const steer = { operationId: randomUUID(), content: "Also check the lexer.", priority: "next" as const };
    await first.send(turn);
    await native.emit({ type: "system", subtype: "session_state_changed", state: "running", uuid: randomUUID(), session_id: sessionId } as SDKMessage);
    await native.emit(lifecycle(sessionId, turn.operationId, "started"));
    await first.send(steer);
    await native.emit(lifecycle(sessionId, steer.operationId, "queued"));
    f.runtime.getSessionMessages.mockResolvedValue([{ ...acceptedInput(sessionId, turn), parent_agent_id: null } as SessionMessage]);
    // Main restarts while Claude still holds the steer.
    await firstClient.close();
    await firstCarrier.close();

    await f.attach();
    const database = new Database(":memory:");
    initializeEmptyBackendNormalizedDatabase(database);
    // Only provider settings are under test; application inventory is not used.
    database.pragma("foreign_keys = OFF");
    cleanups.push(async () => { database.close(); });
    const settings = new ClaudeThreadRepository(database);
    const binding = { ...scope, ownerPrincipalId: scope.principalId, applicationThreadId: "thread", connectionProfileId: "profile",
      backendConversationId: sessionId, createdAt: "2026-09-26T00:00:00.000Z" };
    settings.initialize(scope, binding.applicationThreadId, binding,
      { model: "claude-sonnet-4-6", effort: "low", permissionMode: "default" }, 1);
    const client = f.client();
    const handle = new ClaudeConversationHandle({
      usage: NO_USAGE_SINK, nativeNamespace: "test", binding, canonicalWorkspacePath: "/workspace", workspaceId: "workspace",
      opaqueBindingDetail: '{"version":1}', runtimeClient: client, executablePath: configuration.executablePath, initializationTimeoutMs: 5000,
      permissionPolicy: { allowedModes: ["default"] }, modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
      queryGeneration: 2, attachmentProvenanceKey: new Uint8Array(32).fill(1), settings,
      forkBoundaryAuthentication: { installationKey: new Uint8Array(32).fill(2), ...scope }, childEnvironment: {},
      loadInitialMessages: () => client.getSessionMessages(sessionId, { dir: "/workspace" }, {}), resumeSession: true, releaseSession: () => {},
    });
    cleanups.push(async () => { await handle.close(); });
    const restored = await handle.establishProjection({ signal: new AbortController().signal });
    expect(restored.snapshot.runState).toBe("running");
    native.cancelQueuedInput.mockImplementation(async operationId => {
      await native.emit(lifecycle(sessionId, operationId, "cancelled"));
      return true;
    });
    await handle.interrupt({ applicationOperationId: randomUUID(), expectedBackendTurnId: restored.snapshot.activeBackendTurnId! });
    // Claude's owner withdrew it exactly once; this handle never knew it.
    expect(native.cancelQueuedInput.mock.calls).toEqual([[steer.operationId]]);
    expect(native.interrupt).toHaveBeenCalledOnce();
    expect(native.cancelQueuedInput.mock.invocationCallOrder[0]).toBeLessThan(native.interrupt.mock.invocationCallOrder[0]!);
    expect(handle.withdrewSubmission(steer.operationId)).toBe(false);
    await expect(client.submissionDisposition({ sessionId, cwd: "/workspace", operationId: steer.operationId })).resolves.toBe("cancelled");
    expect(f.runtime.createSession).toHaveBeenCalledOnce();
  }, 30_000);
});

describe("steer placement over the persistent owner", () => {
  function threadSettings(sessionId: string) {
    const database = new Database(":memory:");
    initializeEmptyBackendNormalizedDatabase(database);
    // Only provider settings are under test; application inventory is not used.
    database.pragma("foreign_keys = OFF");
    cleanups.push(async () => { database.close(); });
    const settings = new ClaudeThreadRepository(database);
    const binding = { ...scope, ownerPrincipalId: scope.principalId, applicationThreadId: "thread", connectionProfileId: "profile",
      backendConversationId: sessionId, createdAt: "2026-09-26T00:00:00.000Z" };
    settings.initialize(scope, binding.applicationThreadId, binding,
      { model: "claude-sonnet-4-6", effort: "low", permissionMode: "default" }, 1);
    // This query generation already applied and confirmed every setting.
    settings.confirmEffectiveModel(scope, binding.applicationThreadId, { expectedRevision: 0, model: "claude-sonnet-4-6", queryGeneration: 2, now: 2 });
    settings.confirmEffectiveEffort(scope, binding.applicationThreadId, { expectedRevision: 1, effort: "low", queryGeneration: 2, now: 3 });
    settings.confirmEffectivePermissionMode(scope, binding.applicationThreadId, { expectedRevision: 2, permissionMode: "default",
      classification: "recognized", queryGeneration: 2, now: 4 });
    return { settings, binding };
  }
  function claudeHandle(client: ClaudePersistentRuntimeClient, thread: ReturnType<typeof threadSettings>, resumeSession: boolean) {
    const handle = new ClaudeConversationHandle({
      usage: NO_USAGE_SINK, nativeNamespace: "test", binding: thread.binding, canonicalWorkspacePath: "/workspace", workspaceId: "workspace",
      opaqueBindingDetail: '{"version":1}', runtimeClient: client, executablePath: configuration.executablePath, initializationTimeoutMs: 5000,
      permissionPolicy: { allowedModes: ["default"] }, modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
      queryGeneration: 2, attachmentProvenanceKey: new Uint8Array(32).fill(1), settings: thread.settings,
      forkBoundaryAuthentication: { installationKey: new Uint8Array(32).fill(2), ...scope }, childEnvironment: {},
      loadInitialMessages: () => client.getSessionMessages(thread.binding.backendConversationId, { dir: "/workspace" }, {}),
      resumeSession, releaseSession: () => {},
    });
    cleanups.push(async () => { await handle.close(); });
    return handle;
  }
  const snapshot = async (handle: ClaudeConversationHandle) => (await handle.establishProjection({ signal: new AbortController().signal })).snapshot;
  const items = (value: Awaited<ReturnType<typeof snapshot>>) => value.orderedBackendTurnIds.map(turnId =>
    value.turnsById[turnId]!.orderedBackendItemIds.map(id => {
      const item = value.itemsById[id]!;
      return item.semanticKind === "user_message" ? `user:${item.deliveryOperationId}` : item.semanticKind;
    }));

  it("shows a steer in place when Claude starts it, and a replacement main keeps that placement", async () => {
    const f = await fixture();
    const firstCarrier = await f.attach();
    const sessionId = randomUUID();
    const thread = threadSettings(sessionId);
    const first = randomUUID(), steer = randomUUID();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    cleanups.push(async () => { warn.mockRestore(); });
    f.runtime.getSessionMessages.mockResolvedValue([]);
    const firstClient = f.client();
    const handle = claudeHandle(firstClient, thread, false);
    await snapshot(handle);
    const native = f.sessions[0]!;
    const submitted = handle.submit({ applicationOperationId: first, mutationId: "first", reconciliationToken: "first-receipt",
      source: { kind: "user" }, text: "Run the long task.", contextExcerpts: [], taskContexts: [], attachments: [] });
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(1));
    await native.emit({ type: "system", subtype: "session_state_changed", state: "running", uuid: randomUUID(), session_id: sessionId } as SDKMessage);
    await native.emit(lifecycle(sessionId, first, "started"));
    await submitted;
    const call = { type: "assistant", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
      message: { id: "msg-tool", type: "message", role: "assistant", model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", id: "toolu-fold", name: "Bash", input: { command: "true" } }], stop_reason: "tool_use", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage;
    const toolResult = { type: "user", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu-fold", content: "done" }] } } as unknown as SDKMessage;
    const answer = { type: "assistant", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
      message: { id: "msg-final", type: "message", role: "assistant", model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Done with the correction." }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage;
    await native.emit(call);
    await expect(handle.steer({ applicationOperationId: steer, mutationId: "steer", reconciliationToken: "steer-receipt",
      target: { kind: "conversation" }, text: "Use the revised approach", contextExcerpts: [], taskContexts: [], attachments: [] }))
      .resolves.toMatchObject({ status: "pending_materialization" });
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(2));
    await native.emit(lifecycle(sessionId, steer, "queued"));
    await native.emit(toolResult);
    await native.emit(lifecycle(sessionId, steer, "started"));
    // Shown where Claude took it, while the turn still runs.
    await vi.waitFor(async () => expect(items(await snapshot(handle))).toEqual([[`user:${first}`, "command", `user:${steer}`]]));
    const turnId = (await snapshot(handle)).orderedBackendTurnIds[0]!;
    expect(await snapshot(handle)).toMatchObject({ runState: "running", activeBackendTurnId: turnId });
    expect(handle.hasUnconfirmedSubmission(steer)).toBe(false);
    expect(thread.settings.listSteerOperations(scope, thread.binding.applicationThreadId).get(steer)).toBe(first);

    // Main is replaced before the turn ends; Claude answers meanwhile.
    await handle.close();
    await firstClient.close();
    await firstCarrier.close();
    await native.emit(answer);
    await f.attach();
    const history = [
      { ...acceptedInput(sessionId, { operationId: first, content: "Run the long task." }), parent_agent_id: null },
      { ...call, parent_agent_id: null }, { ...toolResult, parent_agent_id: null },
      { ...acceptedInput(sessionId, { operationId: steer, content: "Use the revised approach" }), parent_agent_id: null, isQueuedCommand: true },
      { ...answer, parent_agent_id: null },
    ] as unknown as SessionMessage[];
    f.runtime.getSessionMessages.mockResolvedValue(history);
    const replacement = claudeHandle(f.client(), thread, true);
    const restored = await snapshot(replacement);
    expect(items(restored)).toEqual([[`user:${first}`, "command", `user:${steer}`, "assistant_message"]]);
    expect(restored).toMatchObject({ runState: "running", activeBackendTurnId: turnId });
    await native.emit({ type: "result", subtype: "success", uuid: randomUUID(), session_id: sessionId,
      user_message_uuid: steer, user_message_uuids: [first, steer], num_turns: 2, terminal_reason: "completed",
      result: "Done", is_error: false, usage: {}, modelUsage: {}, permission_denials: [] } as unknown as SDKMessage);
    await vi.waitFor(async () => expect((await snapshot(replacement)).runState).toBe("idle"));
    const settled = await snapshot(replacement);
    expect(items(settled)).toEqual([[`user:${first}`, "command", `user:${steer}`, "assistant_message"]]);
    expect(settled.turnsById[turnId]).toMatchObject({ status: "completed", completionCorrelations: [first, steer] });
    expect(warn.mock.calls.filter(([code]) => code === "claude_steer_placement_conflict")).toEqual([]);
    expect(native.send).toHaveBeenCalledTimes(2);
  }, 30_000);
});
