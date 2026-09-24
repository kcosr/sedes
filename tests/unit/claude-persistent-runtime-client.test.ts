import { afterEach, expect, it, vi } from "vitest";
import { ClaudeInteractionBridge } from "../../src/server/backends/claude/claude-interaction-bridge.js";
import { ClaudePersistentRuntimeClient } from "../../src/server/backends/claude/runtime/claude-remote-runtime-client.js";
import type { ClaudePersistentCommand, ClaudePersistentEvent } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-wire.js";
import type { SidecarRuntimeChannel } from "../../src/server/sidecar/runtime-channel.js";
import type { ClaudeRuntimeSessionOptions } from "../../src/server/backends/claude/claude-runtime-client.js";
import { createClaudeFramedCarrier } from "../helpers/persistent-claude-fixture.js";

const connectionState = vi.hoisted(() => ({ instances: [] as { ensureInputs: unknown[]; execute: ReturnType<typeof vi.fn>; listener?: (event: ClaudePersistentEvent) => void }[] }));
vi.mock("../../src/server/backends/claude/runtime/claude-sidecar-runtime.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/backends/claude/runtime/claude-sidecar-runtime.js")>(),
  ClaudeSidecarRuntimeConnection: class {
    readonly execute = vi.fn(async (command: ClaudePersistentCommand): Promise<unknown> => command.action === "open" ? opened([], connectionState.instances.length > 1) : {});
    listener?: (event: ClaudePersistentEvent) => void;
    constructor() { connectionState.instances.push(this); }
    readonly ensureInputs: unknown[] = [];
    async ensure(configuration: unknown) { this.ensureInputs.push(configuration); return "runtime"; }
    async lookup(_configuration: unknown, _epoch: number): Promise<string | undefined> { return "runtime"; }
    onEvent(_runtimeId: string, listener: (event: ClaudePersistentEvent) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
    close() {}
  },
}));
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PROBE_ID = "22222222-2222-4222-8222-222222222222";
function opened(events: ClaudePersistentEvent[] = [], reattached = false) {
  return { failureCode: null, pendingBackgroundTaskIds: [], backgroundActivity: { state: "known", agents: 0, commands: 0, other: 0 }, reattached, queryId: SESSION_ID, startupProbeUuid: PROBE_ID, initialization: { cliRelease: "2.1.274", models: [], commands: [], skillNames: [], terminalCommandNames: [], account: {}, actualPermissionMode: "default" }, events };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function setup(input: { nativeDefault?: boolean; supportsRuntime?: boolean } = {}) {
  const carriers: { lost: ReturnType<typeof deferred<void>>; release: ReturnType<typeof vi.fn> }[] = [];
  const acquire = vi.fn(async (_signal?: AbortSignal, _options?: { existingOnly?: boolean }) => {
    const lost = deferred<void>(); const release = vi.fn(); carriers.push({ lost, release });
    return { channel: { assertReady: vi.fn(), supportsOperation: () => input.supportsRuntime !== false } as unknown as SidecarRuntimeChannel, controllerEpoch: carriers.length, serviceIncarnation: "service", closed: lost.promise, release };
  });
  const client = new ClaudePersistentRuntimeClient({ scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "claude" }, sidecarRuntime: { acquire }, executablePath: "/bin/claude", ...(input.nativeDefault ? {} : { configDirectory: "/config" }), initializationTimeoutMs: 1000 });
  const options: ClaudeRuntimeSessionOptions = { executablePath: "/bin/claude", initializationTimeoutMs: 1000, sessionId: SESSION_ID, cwd: "/work", launch: "new", environment: {}, onMessage: vi.fn() };
  return { client, acquire, carriers, options };
}
afterEach(() => { connectionState.instances.length = 0; vi.useRealTimers(); vi.unstubAllEnvs(); });

it("acquires lazily, reattaches the same native session after carrier loss, and detaches on main close", async () => {
  vi.useFakeTimers();
  const { client, acquire, carriers, options } = setup();
  const session = client.createSession(options);
  expect(acquire).not.toHaveBeenCalled();
  await session.start();
  const first = connectionState.instances[0]!;
  expect(first.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open", request: expect.objectContaining({ queryId: SESSION_ID, sessionId: SESSION_ID }) }));
  carriers[0]!.lost.resolve();
  await vi.advanceTimersByTimeAsync(1001);
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(session.closed).toBe(false);
  expect(connectionState.instances[1]!.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open", controllerEpoch: 2, request: expect.objectContaining({ sessionId: SESSION_ID }) }));
  await client.close();
  expect(connectionState.instances[1]!.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "detach" }));
  expect(carriers.every(carrier => carrier.release.mock.calls.length === 1)).toBe(true);
});

it("acknowledges replay only after asynchronous message application and suppresses duplicate live delivery", async () => {
  const { client, options } = setup();
  const applied = deferred<void>();
  const onMessage = vi.fn(async () => applied.promise);
  await client.createSession({ ...options, onMessage }).start();
  const connection = connectionState.instances[0]!;
  const event: ClaudePersistentEvent = { sessionId: SESSION_ID, sequence: 1, payload: { kind: "message", message: { type: "assistant", uuid: PROBE_ID, session_id: SESSION_ID, message: { content: [] } } } };
  connection.listener!(event); connection.listener!(event);
  await Promise.resolve();
  expect(onMessage).toHaveBeenCalledOnce();
  expect(connection.execute.mock.calls.some(([command]) => command.action === "acknowledge")).toBe(false);
  applied.resolve();
  await vi.waitFor(() => expect(connection.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "acknowledge", request: { sessionId: SESSION_ID, sequence: 1 } })));
  connection.listener!(event);
  expect(onMessage).toHaveBeenCalledOnce();
  await client.close();
});

it.each(["sidecar_intentionally_disconnected", "sidecar_automatic_connection_disabled", "sidecar_runtime_closed"])("ends local sessions and permission waiters when the sidecar owner reports %s", async code => {
  vi.useFakeTimers();
  const { client, acquire, carriers, options } = setup();
  const bridge = new ClaudeInteractionBridge({ emit: vi.fn() });
  const onFailure = vi.fn();
  const session = client.createSession({ ...options, canUseTool: bridge.canUseTool, onFailure });
  await session.start();
  connectionState.instances[0]!.listener!({ sessionId: SESSION_ID, sequence: 1, payload: { kind: "permission", request: {
    queryId: SESSION_ID, toolName: "Read", input: {}, options: { requestId: "stopped", toolUseID: "tool-stopped" },
  } } });
  expect(bridge.pendingCount()).toBe(1);
  const error = new Error("sidecar_unavailable", { cause: new Error(code) });
  acquire.mockRejectedValue(error);
  carriers[0]!.lost.resolve();
  await vi.advanceTimersByTimeAsync(1001);
  expect(session.closed).toBe(true);
  expect(bridge.pendingCount()).toBe(0);
  expect(onFailure).toHaveBeenCalledExactlyOnceWith(error);
  expect(acquire).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(acquire).toHaveBeenCalledTimes(2);
  await client.close();
});

it("keeps a local session alive and retries a transient SSH acquisition failure", async () => {
  vi.useFakeTimers();
  const { client, acquire, carriers, options } = setup();
  const onFailure = vi.fn();
  const session = client.createSession({ ...options, onFailure });
  await session.start();
  acquire.mockRejectedValueOnce(new Error("sidecar_unavailable", { cause: new Error("connection_reset") }));
  carriers[0]!.lost.resolve();
  await vi.advanceTimersByTimeAsync(1001);
  expect(session.closed).toBe(false);
  expect(onFailure).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1001);
  expect(acquire).toHaveBeenCalledTimes(3);
  expect(connectionState.instances[1]!.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open" }));
  expect(session.closed).toBe(false);
  await client.close();
});

it("keeps the session and permission pending when recovery acquires an already closed framed channel", async () => {
  const closedCarrier = await createClaudeFramedCarrier();
  try { await closedCarrier.start(); } finally { await closedCarrier.close(); }
  vi.useFakeTimers();
  const { client, acquire, carriers, options } = setup();
  try {
    const bridge = new ClaudeInteractionBridge({ emit: vi.fn() });
    const onFailure = vi.fn();
    const session = client.createSession({ ...options, canUseTool: bridge.canUseTool, onFailure });
    await session.start();
    const permission: ClaudePersistentEvent = { sessionId: SESSION_ID, sequence: 1, payload: { kind: "permission", request: {
      queryId: SESSION_ID, toolName: "Read", input: {}, options: { requestId: "retained", toolUseID: "retained-tool" },
    } } };
    connectionState.instances[0]!.listener!(permission);
    expect(bridge.pendingCount()).toBe(1);
    const release = vi.fn();
    acquire.mockResolvedValueOnce({ channel: closedCarrier.mainChannel, controllerEpoch: 2,
      serviceIncarnation: "service", closed: Promise.resolve(), release });
    carriers[0]!.lost.resolve();
    await vi.advanceTimersByTimeAsync(1001);
    expect(release).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(connectionState.instances).toHaveLength(1);
    expect(session.closed).toBe(false);
    expect(bridge.pendingCount()).toBe(1);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    expect(acquire).toHaveBeenCalledTimes(3);
    const recovered = connectionState.instances[1]!;
    expect(recovered.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open", runtimeId: "runtime",
      replay: "unacknowledged", request: expect.objectContaining({ sessionId: SESSION_ID }) }));
    recovered.listener!(permission);
    expect(session.closed).toBe(false);
    expect(bridge.pendingCount()).toBe(1);
    expect(onFailure).not.toHaveBeenCalled();
    expect(recovered.execute.mock.calls.some(([command]) => command.action === "respond_permission")).toBe(false);
  } finally { await client.close(); }
});

it("keeps permission waits across carrier loss and commits delivery only after the retained provider acknowledgement", async () => {
  vi.useFakeTimers();
  const { client, acquire, carriers, options } = setup();
  const decision = deferred<{ behavior: "allow"; updatedInput: Record<string, unknown>; toolUseID: string }>();
  const canUseTool = vi.fn(async () => decision.promise);
  const deliveredGate = deferred<void>(); const onPermissionResponseDelivered = vi.fn(async () => deliveredGate.promise);
  const onFailure = vi.fn();
  const session = client.createSession({ ...options, canUseTool, onPermissionResponseDelivered, onFailure });
  await session.start();
  const permission: ClaudePersistentEvent = { sessionId: SESSION_ID, sequence: 1, payload: { kind: "permission", request: { queryId: SESSION_ID, toolName: "Read", input: {}, options: { requestId: "permission-1", toolUseID: "tool-1" } } } };
  connectionState.instances[0]!.listener!(permission);
  expect(canUseTool).toHaveBeenCalledOnce();
  acquire.mockRejectedValueOnce(new Error("sidecar_unavailable", { cause: new Error("sidecar_transport_unavailable") }));
  carriers[0]!.lost.resolve(); await vi.advanceTimersByTimeAsync(1001);
  expect(session.closed).toBe(false);
  expect(onFailure).not.toHaveBeenCalled();
  expect(connectionState.instances).toHaveLength(1);
  expect(canUseTool).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1001);
  const second = connectionState.instances[1]!;
  expect(second.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open", runtimeId: "runtime", replay: "unacknowledged" }));
  second.listener!(permission);
  expect(canUseTool).toHaveBeenCalledOnce();
  decision.resolve({ behavior: "allow", updatedInput: {}, toolUseID: "tool-1" });
  await vi.advanceTimersByTimeAsync(0);
  expect(second.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "respond_permission", controllerEpoch: 2 }));
  expect(onPermissionResponseDelivered).not.toHaveBeenCalled();
  second.listener!({ sessionId: SESSION_ID, sequence: 2, payload: { kind: "permission_delivered", requestId: "permission-1", toolUseID: "tool-1" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(onPermissionResponseDelivered).toHaveBeenCalledOnce();
  expect(second.execute.mock.calls.some(([command]) => command.action === "acknowledge" && command.request.sequence === 2)).toBe(false);
  deliveredGate.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(second.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "acknowledge", request: { sessionId: SESSION_ID, sequence: 2 } }));
  await client.close();
});

it("rejects runtime identity and environment overrides before acquiring SSH", async () => {
  const { client, acquire, options } = setup();
  expect(() => client.createSession({ ...options, executablePath: "/another/claude" })).toThrow("identity_mismatch");
  expect(() => client.createSession({ ...options, environment: { ANTHROPIC_API_KEY: "unexpected" } })).toThrow();
  await expect(client.listSessions({}, { HOME: "/other" })).rejects.toThrow("environment_invalid");
  await expect(client.probe({ executablePath: "/bin/claude", timeoutMs: 1000, cwd: "/work", environment: { PATH: "/other" } })).rejects.toThrow("environment_invalid");
  expect(acquire).not.toHaveBeenCalled();
  await client.close();
});

it("retains a message whose application fails and stops delivering later frames", async () => {
  const { client, options } = setup();
  const onMessage = vi.fn(async () => { throw new Error("application_commit_failed"); });
  const onFailure = vi.fn();
  const session = client.createSession({ ...options, onMessage, onFailure });
  await session.start();
  const connection = connectionState.instances[0]!;
  const message = { type: "assistant", uuid: PROBE_ID, session_id: SESSION_ID, message: { content: [] } };
  connection.listener!({ sessionId: SESSION_ID, sequence: 1, payload: { kind: "message", message } });
  connection.listener!({ sessionId: SESSION_ID, sequence: 2, payload: { kind: "message", message } });
  await expect(session.flushMessages!()).rejects.toThrow("application_commit_failed");
  expect(onMessage).toHaveBeenCalledOnce();
  expect(onFailure).toHaveBeenCalledOnce();
  expect(connection.execute.mock.calls.some(([command]) => command.action === "acknowledge")).toBe(false);
  expect(session.closed).toBe(true);
  await client.close();
});

it("detaches a pending permission on shutdown without forwarding an abort denial to the provider", async () => {
  const { client, options } = setup();
  const canUseTool: NonNullable<ClaudeRuntimeSessionOptions["canUseTool"]> = async (_tool, _input, { signal }) => await new Promise(resolve => {
    signal.addEventListener("abort", () => resolve({ behavior: "deny", message: "Local bridge closed." }), { once: true });
  });
  const session = client.createSession({ ...options, canUseTool });
  await session.start();
  const connection = connectionState.instances[0]!;
  connection.listener!({ sessionId: SESSION_ID, sequence: 1, payload: { kind: "permission", request: { queryId: SESSION_ID, toolName: "Read", input: {}, options: { requestId: "permission-1", toolUseID: "tool-1" } } } });
  await session.close();
  await Promise.resolve();
  expect(connection.execute.mock.calls.some(([command]) => command.action === "respond_permission")).toBe(false);
  expect(connection.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "detach" }));
  await client.close();
});

it("fences existing session identity when the sidecar runtime is replaced", async () => {
  vi.useFakeTimers();
  const { client, carriers, options } = setup();
  const onFailure = vi.fn();
  const session = client.createSession({ ...options, onFailure });
  await session.start();
  const { ClaudeSidecarRuntimeConnection } = await import("../../src/server/backends/claude/runtime/claude-sidecar-runtime.js");
  const ensure = vi.spyOn(ClaudeSidecarRuntimeConnection.prototype, "ensure").mockResolvedValue("replacement-runtime");
  try {
    carriers[0]!.lost.resolve(); await vi.advanceTimersByTimeAsync(1001);
    expect(connectionState.instances[1]!.execute.mock.calls.some(([command]) => command.action === "open")).toBe(false);
    expect(session.closed).toBe(true);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "claude_persistent_runtime_replaced" }));
  } finally { ensure.mockRestore(); await client.close(); }
});

it("uses the unsettled journal on reconnect after more than a full deduplication window", async () => {
  vi.useFakeTimers();
  const { client, carriers, options } = setup();
  const onMessage = vi.fn(); const session = client.createSession({ ...options, onMessage });
  await session.start();
  const first = connectionState.instances[0]!;
  expect(first.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open", replay: "full" }));
  for (let sequence = 1; sequence <= 8200; sequence++) {
    first.listener!({ sessionId: SESSION_ID, sequence, payload: { kind: "message", message: { type: "stream_event", uuid: PROBE_ID, session_id: SESSION_ID, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } } } });
    await session.flushMessages!();
  }
  expect(onMessage).toHaveBeenCalledTimes(8200);
  carriers[0]!.lost.resolve(); await vi.advanceTimersByTimeAsync(1001);
  expect(connectionState.instances[1]!.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open", replay: "unacknowledged" }));
  expect(onMessage).toHaveBeenCalledTimes(8200);
  await client.close();
});

it("applies full compact replay once when live events precede the first open response", async () => {
  const { client, options } = setup();
  await client.attachment();
  const connection = connectionState.instances[0]!;
  const message = (text: string) => ({ type: "stream_event", uuid: PROBE_ID, session_id: SESSION_ID, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  connection.execute.mockImplementation(async (command: ClaudePersistentCommand) => {
    if (command.action !== "open") return {};
    connection.listener!({ sessionId: SESSION_ID, sequence: 1, payload: { kind: "message", message: message("a") } });
    connection.listener!({ sessionId: SESSION_ID, sequence: 2, payload: { kind: "message", message: message("b") } });
    return opened([{ sessionId: SESSION_ID, sequence: 2, payload: { kind: "message", message: message("ab") } }]);
  });
  const onMessage = vi.fn(); const session = client.createSession({ ...options, onMessage });
  await session.start(); await session.flushMessages!();
  expect(onMessage).toHaveBeenCalledExactlyOnceWith(message("ab"));
  await client.close();
});

it("keeps an applied event pinned when its ACK fails beyond the recent deduplication window", async () => {
  const { client, options } = setup();
  const onMessage = vi.fn(); const session = client.createSession({ ...options, onMessage });
  await session.start(); const connection = connectionState.instances[0]!;
  connection.execute.mockImplementation(async (command: ClaudePersistentCommand) => {
    if (command.action === "acknowledge" && command.request.sequence === 1) throw new Error("ack_failed");
    return {};
  });
  const event = (sequence: number): ClaudePersistentEvent => ({ sessionId: SESSION_ID, sequence, payload: { kind: "message", message: { type: "assistant", uuid: PROBE_ID, session_id: SESSION_ID, message: { content: [] } } } });
  for (let sequence = 1; sequence <= 8200; sequence++) { connection.listener!(event(sequence)); await session.flushMessages!(); }
  connection.listener!(event(1)); await session.flushMessages!();
  expect(onMessage).toHaveBeenCalledTimes(8200);
  await client.close();
});

it("propagates reachable idle-detach cleanup failures while releasing the main carrier", async () => {
  const { client, carriers, options } = setup();
  await client.createSession(options).start();
  connectionState.instances[0]!.execute.mockImplementation(async (command: ClaudePersistentCommand) => {
    if (command.action === "detach") throw new Error("cleanup_unproven");
    return {};
  });
  await expect(client.close()).rejects.toThrow("cleanup_unproven");
  expect(carriers[0]!.release).toHaveBeenCalledOnce();
});


it.each(["permission_failed", "permission_delivered"] as const)("settles an unanswered local permission on provider %s without closing the query", async (kind) => {
  const { client, options } = setup();
  const bridge = new ClaudeInteractionBridge({ emit: vi.fn() });
  const onFailure = vi.fn();
  const session = client.createSession({
    ...options, canUseTool: bridge.canUseTool, onFailure,
    onPermissionResponseDelivered: identity => bridge.permissionResponseDelivered(identity),
    onPermissionResponseDeliveryFailed: identity => bridge.permissionResponseDeliveryFailed(identity),
  });
  await session.start();
  const connection = connectionState.instances[0]!;
  connection.execute.mockImplementation(async (command: ClaudePersistentCommand) => command.action === "send" ? { accepted: true } : {});
  const permission: ClaudePersistentEvent = { sessionId: SESSION_ID, sequence: 1, payload: { kind: "permission", request: {
    queryId: SESSION_ID, toolName: "Read", input: {}, options: { requestId: "provider-cancelled", toolUseID: "tool-cancelled" },
  } } };
  connection.listener!(permission);
  expect(bridge.pendingCount()).toBe(1);
  connection.listener!({ sessionId: SESSION_ID, sequence: 2, payload: { kind, requestId: "provider-cancelled", toolUseID: "tool-cancelled" } });
  await session.flushMessages!();
  expect(bridge.pendingCount()).toBe(0);
  expect(session.closed).toBe(false);
  expect(onFailure).not.toHaveBeenCalled();
  expect(connection.execute.mock.calls.some(([command]) => command.action === "respond_permission")).toBe(false);
  await vi.waitFor(() => expect(connection.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "acknowledge", request: { sessionId: SESSION_ID, sequence: 1 } })));
  // A request queued before its settlement acknowledgement cannot reopen UI.
  connection.listener!({ ...permission, sequence: 3 });
  await vi.waitFor(() => expect(connection.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "acknowledge", request: { sessionId: SESSION_ID, sequence: 3 } })));
  expect(bridge.pendingCount()).toBe(0);

  session.send({ operationId: PROBE_ID, content: "Continue after provider cancellation" });
  await vi.waitFor(() => expect(connection.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "send" })));
  connection.listener!({ sessionId: SESSION_ID, sequence: 4, payload: { kind: "message", message: { type: "assistant", uuid: PROBE_ID, session_id: SESSION_ID, message: { content: [] } } } });
  await session.flushMessages!();
  expect(options.onMessage).toHaveBeenCalledOnce();
  expect(onFailure).not.toHaveBeenCalled();
  expect(session.closed).toBe(false);
  await client.close();
});

it.each(["new", "fork"] as const)("resumes an established %s identity when the detached idle worker has retired", async (launch) => {
  vi.useFakeTimers();
  const { client, carriers, options } = setup();
  const session = client.createSession({ ...options, launch, title: "Original title", model: "original-model", effort: "low", permissionMode: "default",
    ...(launch === "fork" ? { sourceSessionId: "33333333-3333-4333-8333-333333333333", resumeSessionAt: PROBE_ID } : {}),
  });
  await session.start();
  const first = connectionState.instances[0]!;
  expect(first.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open", request: expect.objectContaining({ launch }) }));
  first.execute.mockImplementation(async (command: ClaudePersistentCommand) => command.action.startsWith("set_") ? { updated: true } : {});
  await session.setModel("confirmed-model");
  await session.setEffort("high");
  await session.setPermissionMode("acceptEdits");
  const message = (text: string): ClaudePersistentEvent => ({ sessionId: SESSION_ID, sequence: 1, payload: { kind: "message", message: {
    type: "assistant", uuid: PROBE_ID, session_id: SESSION_ID, message: { content: [{ type: "text", text }] },
  } } });
  first.listener!(message("Earlier worker output"));
  await session.flushMessages!();
  const execute = client.execute.bind(client);
  vi.spyOn(client, "execute").mockImplementation(async (...args) => {
    const response = await execute(...args);
    if (args[0].action === "open") {
      // A fresh worker can publish sequence 1 before its open response arrives.
      connectionState.instances.at(-1)!.listener!(message("Resumed worker output"));
      return { ...(response as object), reattached: false };
    }
    return response;
  });
  carriers[0]!.lost.resolve();
  await vi.advanceTimersByTimeAsync(1001);
  const reopened = connectionState.instances[1]!.execute.mock.calls.find(([command]) => command.action === "open")?.[0];
  expect(reopened).toMatchObject({ action: "open", request: { launch: "resume", sessionId: SESSION_ID, queryId: SESSION_ID, model: "confirmed-model", effort: "high", permissionMode: "acceptEdits" } });
  expect(reopened.request).not.toHaveProperty("sourceSessionId");
  expect(reopened.request).not.toHaveProperty("resumeSessionAt");
  expect(reopened.request).not.toHaveProperty("title");
  await session.flushMessages!();
  expect(options.onMessage).toHaveBeenCalledTimes(2);
  expect(options.onMessage).toHaveBeenLastCalledWith(expect.objectContaining({ message: { content: [{ type: "text", text: "Resumed worker output" }] } }));
  // Fresh-worker responses omit confirmedEffort. Preserve the last successful
  // selection across another retirement instead of restoring original low.
  carriers[1]!.lost.resolve();
  await vi.advanceTimersByTimeAsync(1001);
  const third = connectionState.instances[2]!;
  expect(third.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open", request: expect.objectContaining({ effort: "high" }) }));
  third.execute.mockImplementation(async (command: ClaudePersistentCommand) => command.action.startsWith("set_") ? { updated: true } : {});
  await session.setEffort(undefined);
  carriers[2]!.lost.resolve();
  await vi.advanceTimersByTimeAsync(1001);
  const reset = connectionState.instances[3]!.execute.mock.calls.find(([command]) => command.action === "open")?.[0];
  expect(reset.request).not.toHaveProperty("effort");
  expect(session.confirmedEffort).toBeNull();
  expect(session.closed).toBe(false);
  await client.close();
});


it("does not report requested effort as confirmed when an existing host has no effort evidence", async () => {
  vi.useFakeTimers();
  const { client, carriers, options } = setup();
  await client.attachment();
  connectionState.instances[0]!.execute.mockImplementation(async (command: ClaudePersistentCommand) => command.action === "open" ? opened([], true) : {});
  const session = client.createSession({ ...options, effort: "high" });
  await session.start();
  expect(session.reattached).toBe(true);
  expect(session.confirmedEffort).toBeUndefined();
  const execute = client.execute.bind(client);
  vi.spyOn(client, "execute").mockImplementation(async (...args) => {
    const response = await execute(...args);
    return args[0].action === "open" ? { ...(response as object), reattached: false } : response;
  });
  carriers[0]!.lost.resolve();
  await vi.advanceTimersByTimeAsync(1001);
  expect(connectionState.instances[1]!.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open", request: expect.objectContaining({ launch: "resume", effort: "high" }) }));
  expect(session.reattached).toBe(false);
  expect(session.confirmedEffort).toBe("high");
  await client.close();
});


it("leaves the omitted SSH native store unresolved despite main-server environment defaults", async () => {
  vi.stubEnv("HOME", "/main-account-home");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/main-only-native-store");
  const { client, options } = setup({ nativeDefault: true });
  await client.createSession(options).start();
  expect(connectionState.instances[0]!.ensureInputs).toEqual([{
    tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "claude",
    executablePath: "/bin/claude", configDirectory: undefined, initializationTimeoutMs: 1000,
  }]);
  await client.close();
});

it("fails closed and releases the lease when the remote host omits Claude runtime support", async () => {
  const { client, carriers, options } = setup({ supportsRuntime: false });
  await expect(client.createSession(options).start()).rejects.toThrow("claude_remote_runtime_unsupported");
  expect(connectionState.instances).toHaveLength(0);
  expect(carriers[0]!.release).toHaveBeenCalledOnce();
  await client.close();
});

it.each(["retained", "missing", "replaced"] as const)("uses existing-only lookup after a revision change and carrier loss: %s", async disposition => {
  vi.useFakeTimers();
  const { client, acquire, carriers, options } = setup();
  const originalAcquire = acquire.getMockImplementation()!;
  const onFailure = vi.fn();
  const session = client.createSession({ ...options, onFailure });
  await session.start();
  const { ClaudeSidecarRuntimeConnection } = await import("../../src/server/backends/claude/runtime/claude-sidecar-runtime.js");
  const lookup = vi.spyOn(ClaudeSidecarRuntimeConnection.prototype, "lookup")
    .mockResolvedValue(disposition === "missing" ? undefined : disposition === "replaced" ? "other-runtime" : "runtime");
  acquire.mockImplementation(async (signal, acquisition) => {
    if (!acquisition?.existingOnly) throw new Error("sidecar_unavailable", { cause: new Error("sidecar_revision_changed") });
    return originalAcquire(signal, acquisition);
  });
  carriers[0]!.lost.resolve();
  await vi.advanceTimersByTimeAsync(1001);
  expect(acquire).toHaveBeenCalledWith(expect.any(AbortSignal), { existingOnly: true });
  expect(lookup).toHaveBeenCalledOnce();
  expect(connectionState.instances[1]!.ensureInputs).toEqual([]);
  if (disposition === "retained") {
    expect(session.closed).toBe(false);
    expect(connectionState.instances[1]!.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "open", request: expect.objectContaining({ sessionId: SESSION_ID }) }));
  } else {
    expect(session.closed).toBe(true);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "claude_persistent_retained_runtime_unavailable" }));
    expect(connectionState.instances[1]!.execute).not.toHaveBeenCalled();
  }
  await client.close(); lookup.mockRestore();
});


it("preserves unknown delivery when the send response is lost", async () => {
  const { client, options } = setup(); const onFailure = vi.fn();
  const session = client.createSession({ ...options, onFailure });
  await session.start();
  const connection = connectionState.instances[0]!;
  connection.execute.mockImplementationOnce(async () => { throw new Error("response_lost"); });
  await expect(session.send({ operationId: PROBE_ID, content: "do not replay" })).rejects.toThrow("response_lost");
  expect(onFailure).toHaveBeenCalledOnce();
  await client.close();
});

it.each(["claude_persistent_query_closed", "claude_persistent_input_capacity_exceeded", "claude_persistent_operation_capacity_exceeded"])("preserves the known pre-send refusal %s", async code => {
  const { client, options } = setup(); const onFailure = vi.fn();
  const session = client.createSession({ ...options, onFailure }); await session.start();
  connectionState.instances[0]!.execute.mockResolvedValueOnce({ accepted: false, code });
  await expect(session.send({ operationId: PROBE_ID, content: "refused" })).rejects.toMatchObject({
    category: "unavailable", crossedSubmissionBoundary: false, backendCode: code,
  });
  expect(onFailure).toHaveBeenCalledTimes(code === "claude_persistent_query_closed" ? 1 : 0);
  await client.close();
});

it("retains an exact accounting-failed event without blocking later delivery and retries its existing replay", async () => {
  const { client, options } = setup();
  let storageAvailable = false;
  const onFailure = vi.fn();
  const onMessage = vi.fn<ClaudeRuntimeSessionOptions["onMessage"]>((message) =>
    message.uuid === PROBE_ID && !storageAvailable ? false : undefined);
  const session = client.createSession({...options, onMessage, onFailure});
  await session.start();
  const connection = connectionState.instances[0]!;
  const original: ClaudePersistentEvent = {sessionId:SESSION_ID,sequence:1,payload:{kind:"message",message:{type:"assistant",uuid:PROBE_ID,session_id:SESSION_ID,message:{content:[]}}}};
  const later: ClaudePersistentEvent = {sessionId:SESSION_ID,sequence:2,payload:{kind:"message",message:{type:"assistant",uuid:SESSION_ID,session_id:SESSION_ID,message:{content:[]}}}};
  connection.listener!(original);
  await session.flushMessages?.();
  const acked = () => connection.execute.mock.calls.flatMap(([command]) => command.action === "acknowledge" ? [command.request.sequence] : []);
  expect(acked()).not.toContain(1);
  connection.listener!(later);
  await session.flushMessages?.();
  expect(acked()).toContain(2);expect(acked()).not.toContain(1);
  expect(onFailure).not.toHaveBeenCalled();expect(session.closed).toBe(false);
  // The original remains in the existing host journal. Replayed originals
  // must retry accounting instead of entering the delivered-event ACK fast path.
  storageAvailable = true;
  connection.listener!(original);
  await session.flushMessages?.();
  expect(onMessage).toHaveBeenCalledTimes(3);expect(acked()).toContain(1);
  connection.listener!(original);
  await session.flushMessages?.();
  expect(onMessage).toHaveBeenCalledTimes(3);
  await client.close();
});
