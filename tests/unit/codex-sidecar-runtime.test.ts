import { describe, expect, it, vi } from "vitest";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import { SidecarFrameWriteError, SidecarOperationRegistry, SidecarProtocolPeer, controlHelloOperation, registerControlV2Operations, type SidecarFrame, type SidecarFrameSendOptions, type SidecarFrameTransport, type SidecarTransportClosure } from "../../src/internal/sidecar-protocol/index.js";
import { SidecarRuntimeChannel } from "../../src/server/sidecar/runtime-channel.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import { CodexRuntimeHost } from "../../src/server/backends/codex/runtime/codex-runtime-host.js";
import type { CodexRuntimeHostRegistry } from "../../src/server/backends/codex/runtime/codex-runtime-host-registry.js";
import { CodexSidecarRuntimeConnection, codexRuntimeEnsureOperation, registerCodexRuntimeHost } from "../../src/server/backends/codex/runtime/codex-sidecar-runtime.js";
import { recoverCodexRuntimeAdministration } from "../../src/server/backends/codex/runtime/codex-runtime-administration.js";
import { BackendRuntimeControlRejectedError } from "../../src/server/backends/runtime-control.js";
import { CodexRuntimeClient } from "../../src/server/backends/codex/runtime/codex-runtime-client.js";
import { CodexInteractionBridge } from "../../src/server/backends/codex/codex-interaction-bridge.js";
import { codexC2NotificationSchemas, codexThreadStartMethod } from "../../src/server/backends/codex/codex-c2-protocol.js";
import Database from "better-sqlite3";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import { CodexRuntimeReceiptStore } from "../../src/server/backends/codex/runtime/codex-runtime-receipt-store.js";
import { CodexRpcDeliveryError, CodexRpcProtocolError, CodexRpcRemoteError } from "../../src/server/backends/codex/rpc/errors.js";
import { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import type { CodexRpcRequestReceipt } from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import { decodeCodexServerRequestParams, type OfficialCodexClientRequestResult } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import type { CodexRuntimeEvent } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";

const scope = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" };
const configuration = { environmentRevision: 1, operationsRevision: 1 };
const request = { operationId: "operation", generation: 1, method: "thread/name/set" as const, params: { threadId: "thread", name: "renamed" }, timeoutMilliseconds: 1000 };

it.each((["mcp", "command"] as const).flatMap(kind =>
  (["confirmed", "disconnected", "timed_out", "unanswered"] as const).map(ending => ({ kind, ending })),
))("handles $ending after remote $kind response settlement", async ({ kind, ending }) => {
  const f = await threadFixture();
  const proxy = new CodexRuntimeClient({ connection: f.connection, authority: f.authority, generationOffset: 41,
    receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [], reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false } });
  let settled = false;
  const attach = f.connection.attach.bind(f.connection);
  vi.spyOn(f.connection, "attach").mockImplementation((authority, listener) => attach(authority, event => {
    listener(event);
    if (event.type === "server_request_settled") settled = true;
  }));
  const bridge = new CodexInteractionBridge({ router: proxy.serverRequests, nativeThreadId: "thread-b", ownsRoute: () => true, emit: () => {}, responseConfirmationTimeoutMilliseconds: ending === "timed_out" ? 1000 : 10_000 });
  const unsubscribeLifecycle = proxy.client.subscribeLifecycle(lifecycle => {
    if (lifecycle.state !== "ready") bridge.deactivate();
  });
  const unsubscribe = proxy.client.subscribeNotifications(notification => {
    if (notification.kind === "decoded_notification" && notification.method === "serverRequest/resolved") {
      bridge.observeProviderResolved(notification.generation, codexC2NotificationSchemas["serverRequest/resolved"].parse(notification.params).requestId);
    }
  });
  const controller = new AbortController();
  try {
    await proxy.start();
    bridge.activate(42);
    const handlers = f.host.serverRequests.handlersForGeneration(1);
    const providerResponse = kind === "mcp"
      ? handlers["mcpServer/elicitation/request"]!({ generation: 1, sequence: 1, id: "approval", method: "mcpServer/elicitation/request", signal: controller.signal,
          params: decodeCodexServerRequestParams("mcpServer/elicitation/request", { threadId: "thread-b", turnId: "turn", serverName: "catalog", mode: "form", message: "Allow catalog?", requestedSchema: { type: "object", properties: {} } }) })
      : handlers["item/commandExecution/requestApproval"]!({ generation: 1, sequence: 1, id: "approval", method: "item/commandExecution/requestApproval", signal: controller.signal,
          params: decodeCodexServerRequestParams("item/commandExecution/requestApproval", { threadId: "thread-b", turnId: "turn", itemId: "item", kind: "command", startedAtMs: 1, environmentId: null, command: "pwd", cwd: "/workspace" }) });
    await vi.waitFor(() => expect(bridge.pendingCount()).toBe(1));
    if (ending === "unanswered") {
      const rejection = expect(providerResponse).rejects.toThrow();
      controller.abort();
      await rejection;
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(bridge.pendingCount()).toBe(0);
      return;
    }
    const interactionId = bridge.pendingInteractions()[0]!.backendInteractionId;
    const response = kind === "mcp"
      ? { applicationOperationId: "respond", interactionId, kind: "confirmation" as const, confirmed: true }
      : { applicationOperationId: "respond", interactionId, kind: "decision" as const, selectedActionId: "accept" };
    let outcome = "pending";
    let failure: unknown;
    const confirmation = bridge.respond(response).then(() => { outcome = "accepted"; }, error => { failure = error; outcome = "rejected"; });
    await expect(providerResponse).resolves.toEqual(kind === "mcp" ? { action: "accept", content: {}, _meta: null } : { decision: "accept" });
    await vi.waitFor(() => expect(settled).toBe(true));
    // The host has forwarded the response, but Codex has not acknowledged it.
    expect(outcome).toBe("pending");
    expect(bridge.pendingCount()).toBe(1);
    if (ending !== "confirmed") {
      if (ending === "disconnected") proxy.disconnected();
      await vi.waitFor(() => expect(outcome).toBe("rejected"), { timeout: 2000 });
      await confirmation;
      expect(failure).toMatchObject({ outcomeUnknown: true, code: ending === "disconnected"
        ? "codex_interaction_response_confirmation_lost" : "codex_interaction_response_confirmation_timeout" });
      expect(bridge.reconcile(response)).toEqual({ outcome: "unknown" });
      return;
    }
    f.native.forwardNotification(1, { kind: "decoded_notification", generation: 1, sequence: 2,
      method: "serverRequest/resolved", params: { threadId: "thread-b", requestId: "approval" } });
    await vi.waitFor(() => expect(outcome).toBe("accepted"));
    await confirmation;
    expect(bridge.reconcile(response)).toEqual({ outcome: "accepted" });
    expect(bridge.pendingCount()).toBe(0);
  } finally { controller.abort(); unsubscribe(); unsubscribeLifecycle(); bridge.close(); await proxy.close(); await f.close(); }
});

it("requires explicit eviction of every remote thread and wakes the same host after idle teardown", async () => {
  let generation = 1;
  let created = 0;
  let sequence = 0;
  const native = new CodexSharedClientFacade({
    current: () => ({ generation, request: async () => undefined as never,
      requestWithReceipt: async method => ({ generation, inboundSequence: ++sequence,
        result: method.decodeResult({
          ...metadata(`thread-${++created}`), model: "gpt-5.6", modelProvider: "openai", serviceTier: "default", cwd: "/workspace",
          runtimeWorkspaceRoots: ["/workspace"], instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: { id: ":read-only", extends: null },
          reasoningEffort: "low", multiAgentMode: "explicitRequestOnly",
        }),
      }),
    }), latestGeneration: () => generation, retireGeneration: async () => {},
  });
  native.updateLifecycle({ state: "ready", generation });
  const host = new CodexRuntimeHost({ scope, runtimeId: "eviction-runtime" });
  host.bind(native);
  const park = vi.fn(async () => { native.updateLifecycle({ state: "idle", generation }); });
  const wake = vi.fn(async () => { native.updateLifecycle({ state: "ready", generation: ++generation }); });
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" },
    buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION, configuration });
  const overrides = {
    getRuntime: () => ({ supervisor: { park, wake } }),
    managedTui: { activity: () => ({ state: "idle", revision: "0", blockers: [] }),
      admissionFrozen: () => false, freezeAdmission: () => () => {} },
  } as unknown as Partial<CodexRuntimeHostRegistry>;
  const first = await attachment(host, services, overrides);
  const authority = { scope, runtimeId: host.runtimeId, controllerId: String(first.epoch) };
  await first.connection.attach(authority, () => {});
  for (const id of ["a", "b"]) {
    await first.connection.submit(authority, { ...request, operationId: id, method: "thread/start", params: {} });
    await vi.waitFor(async () => expect((await first.connection.outcome(authority, id)).status).toBe("completed"));
    await first.connection.acknowledge(authority, id);
  }
  await first.connection.evictThread(authority, "thread-1", 1);
  expect(await first.connection.idle(authority, 1)).toBe(false);
  expect(park).not.toHaveBeenCalled();
  await first.close();
  expect(park).not.toHaveBeenCalled();
  const second = await attachment(host, services, overrides);
  const replacement = { ...authority, controllerId: String(second.epoch) };
  const events: CodexRuntimeEvent[] = [];
  try {
    await second.connection.attach(replacement, event => events.push(event));
    expect(await second.connection.idle(replacement, 1)).toBe(false);
    await second.connection.evictThread(replacement, "thread-2", 1);
    expect(await second.connection.idle(replacement, 1)).toBe(true);
    expect(park).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "lifecycle", lifecycle: { state: "idle", generation: 1 } });
    await second.connection.wake(replacement);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "lifecycle", lifecycle: { state: "ready", generation: 2 } });
    await expect(second.connection.evictThread(authority, "thread-2", 1)).rejects.toThrow();
  } finally { await second.close(); }
});

it.each([
  { error: new CodexRpcRemoteError({ code: -32600, message: "thread thread is not materialized yet; thread/turns/list is unavailable before first user message", generation: 1, method: "thread/turns/list" }), expected: { name: "CodexRpcRemoteError", code: -32600, method: "thread/turns/list", message: expect.stringContaining("not materialized yet") } },
  { error: new CodexRpcDeliveryError({ code: "codex_rpc_timeout", delivery: "sent_outcome_unknown", generation: 1, method: "thread/read" }), expected: { name: "CodexRpcDeliveryError", message: "codex_rpc_timeout", delivery: "sent_outcome_unknown", method: "thread/read" } },
  { error: new CodexRpcProtocolError("codex_rpc_invalid_response", 1), expected: { name: "CodexRpcProtocolError", message: "codex_rpc_invalid_response" } },
  { error: new Error("thread not materialized yet"), expected: { name: "CodexRpcDeliveryError", message: "codex_runtime_reattach_unavailable", delivery: "sent_outcome_unknown" } },
  { error: new CodexRpcRemoteError({ code: -32600, message: "thread not materialized yet", generation: 0, method: "thread/turns/list" }), expected: { name: "CodexRpcDeliveryError", message: "codex_runtime_reattach_unavailable", delivery: "sent_outcome_unknown" } },
])("preserves reattach read errors and maps the presentation generation: $error.name", async ({ error, expected }) => {
  const native = new CodexSharedClientFacade({ current: () => undefined, latestGeneration: () => 1, retireGeneration: async () => {} });
  native.updateLifecycle({ state: "ready", generation: 1 });
  const host = new CodexRuntimeHost({ scope, runtimeId: "runtime" });
  host.bind(native);
  vi.spyOn(host, "reattachThread").mockRejectedValue(error);
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration });
  const f = await attachment(host, services);
  const database = new Database(":memory:");
  initializeEmptyBackendNormalizedDatabase(database);
  const receipts = new CodexRuntimeReceiptStore(database);
  const authority = { scope, runtimeId: host.runtimeId, controllerId: String(f.epoch) };
  const remote = new CodexRuntimeClient({ connection: f.connection, authority, receipts, generationOffset: 41 });
  try {
    await remote.start();
    const received = await remote.client.persistentSessions!.reattachThread("thread", { timeoutMilliseconds: 1000 }).catch(value => value);
    expect(received).toBeInstanceOf(expected.name === "CodexRpcDeliveryError" ? CodexRpcDeliveryError : error.constructor);
    expect(received).toMatchObject({ ...expected, generation: 42 });
    expect(receipts.pending(authority)).toEqual([]);
    expect(remote.client.lifecycleSnapshot()).toEqual({ state: "ready", generation: 42 });
  } finally { await remote.close(); await f.close(); database.close(); }
});

it("preserves a newly started session's native history rejection through its real sidecar owner", async () => {
  const generation = 7;
  const calls: string[] = [];
  let sequence = 0;
  const rejection = new CodexRpcRemoteError({
    code: -32600,
    message: "thread new-thread is not materialized yet; thread/turns/list is unavailable before first user message",
    generation,
    method: "thread/turns/list",
    data: { threadId: "new-thread" },
  });
  const native = new CodexSharedClientFacade({
    current: () => ({
      generation,
      request: async () => undefined as never,
      requestWithReceipt: async (method, params) => {
        calls.push(method.method);
        if (method.method === "thread/turns/list") throw rejection;
        const result = method.method === "thread/start" ? {
          ...metadata("new-thread"), model: "gpt-5.6", modelProvider: "openai", serviceTier: "default",
          cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"], instructionSources: [],
          approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false },
          activePermissionProfile: { id: ":read-only", extends: null }, reasoningEffort: "low",
          multiAgentMode: "explicitRequestOnly",
        } : method.method === "thread/read" ? metadata((params as { threadId: string }).threadId) : undefined;
        if (!result) throw new Error(`unexpected native method: ${method.method}`);
        return { result: method.decodeResult(result), generation, inboundSequence: ++sequence };
      },
    }),
    latestGeneration: () => generation,
    retireGeneration: async () => {},
  });
  native.updateLifecycle({ state: "ready", generation });
  const host = new CodexRuntimeHost({ scope, runtimeId: "runtime" });
  host.bind(native);
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration });
  const f = await attachment(host, services);
  const database = new Database(":memory:");
  initializeEmptyBackendNormalizedDatabase(database);
  const receipts = new CodexRuntimeReceiptStore(database);
  const authority = { scope, runtimeId: host.runtimeId, controllerId: String(f.epoch) };
  const remote = new CodexRuntimeClient({ connection: f.connection, authority, receipts, generationOffset: 41 });
  try {
    await remote.start();
    await expect(remote.client.persistentSessions!.reattachThread("unknown-thread", { timeoutMilliseconds: 1000 })).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    const created = await remote.client.request(codexThreadStartMethod, {
      model: "gpt-5.6", cwd: "/workspace", approvalPolicy: "never", sandbox: "read-only", historyMode: "paginated",
    }, { timeoutMilliseconds: 1000, runtimeCorrelation: { kind: "create", applicationOperationId: "create-new-thread", applicationThreadId: "application-thread" } });
    const pendingBeforeRead = receipts.pending(authority);
    const received = await remote.client.persistentSessions!.reattachThread(created.thread.id, { timeoutMilliseconds: 1000 }).catch(error => error);
    expect(received).toBeInstanceOf(CodexRpcRemoteError);
    expect(received).toMatchObject({ code: rejection.code, message: rejection.message, method: rejection.method, data: rejection.data, generation: 48 });
    expect(rejection.generation).toBe(7);
    expect(calls).toEqual(["thread/start", "thread/read", "thread/turns/list"]);
    expect(receipts.pending(authority)).toEqual(pendingBeforeRead);
    expect(host.pendingOutcomeCount()).toBe(0);
    expect(remote.client.lifecycleSnapshot()).toEqual({ state: "ready", generation: 48 });
  } finally { await remote.close(); await f.close(); host.dispose(); database.close(); }
});

it("keeps the native operation alive across complete carrier replacement and fences the old controller", async () => {
  let settle!: (receipt: CodexRpcRequestReceipt<unknown>) => void;
  const result = new Promise<CodexRpcRequestReceipt<unknown>>(resolve => { settle = resolve; });
  const dispatch = vi.fn(async () => result);
  const client = new CodexSharedClientFacade({ current: () => ({ generation: 1, request: async () => undefined as never, requestWithReceipt: dispatch as never }), latestGeneration: () => 1, retireGeneration: async () => {} });
  client.updateLifecycle({ state: "ready", generation: 1 });
  const host = new CodexRuntimeHost({ scope, runtimeId: "runtime" });
  host.bind(client);
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration });
  const first = await attachment(host, services);
  const firstAuthority = { scope, runtimeId: host.runtimeId, controllerId: String(first.epoch) };
  await first.connection.attach(firstAuthority, () => {});
  await expect(first.connection.submit(firstAuthority, request)).resolves.toMatchObject({ status: "pending" });
  await first.close();
  settle({ result: {}, generation: 1, inboundSequence: 9 });
  const second = await attachment(host, services);
  try {
    const authority = { ...firstAuthority, controllerId: String(second.epoch) };
    const events: CodexRuntimeEvent[] = [];
    const snapshot = await second.connection.attach(authority, event => events.push(event));
    expect(snapshot.outcomes).toContainEqual({ operationId: "operation", method: "thread/name/set", status: "completed" });
    await expect(second.connection.outcome(authority, "operation")).resolves.toMatchObject({ status: "completed", receipt: { inboundSequence: 9 } });
    await second.connection.submit(authority, request);
    expect(dispatch).toHaveBeenCalledOnce();
    await expect(second.connection.acknowledge(firstAuthority, "operation")).rejects.toThrow();
    await expect(second.connection.outcome({ ...authority, scope: { ...scope, principalId: "intruder" } }, "operation")).rejects.toThrow();
    await second.connection.acknowledge(authority, "operation");
    await expect(second.connection.submit(authority, request)).resolves.toMatchObject({ status: "failed", failure: { delivery: "sent_outcome_unknown" } });
    expect(dispatch).toHaveBeenCalledOnce();
  } finally { await second.close(); }
});

it.each(["explicit stop", "retired elsewhere"])("detaches safely after an attached runtime was %s", async retirement => {
  const host = new CodexRuntimeHost({ scope, runtimeId: "runtime" });
  const client = new CodexSharedClientFacade({ current: () => undefined, latestGeneration: () => 1, retireGeneration: async () => {} });
  host.bind(client);
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration });
  let present = true;
  const get = vi.fn(() => { if (!present) throw new Error("codex_runtime_unknown"); return host; });
  const f = await attachment(host, services, { get, stop: async () => { present = false; } });
  try {
    const authority = { scope, runtimeId: host.runtimeId, controllerId: String(f.epoch) };
    await f.connection.attach(authority, () => {});
    if (retirement === "explicit stop") await f.connection.stop(authority, "revision", false);
    else present = false;
    const lookups = get.mock.calls.length;
    expect(() => f.detach()).not.toThrow();
    if (retirement === "explicit stop") expect(get).toHaveBeenCalledTimes(lookups);
    expect(() => f.detach()).not.toThrow();
  } finally { await f.close(); }
});

it("keeps another runtime and acknowledgements responsive while preserving same-runtime notification order", async () => {
  const native = new CodexSharedClientFacade({ current: () => undefined, latestGeneration: () => 1, retireGeneration: async () => {} });
  native.updateLifecycle({ state: "ready", generation: 1 });
  const host = new CodexRuntimeHost({ scope, runtimeId: "busy" });
  host.bind(native);
  const other = new CodexRuntimeHost({ scope, runtimeId: "other" });
  other.bind(new CodexSharedClientFacade({ current: () => undefined, latestGeneration: () => 1, retireGeneration: async () => {} }));
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration });
  const f = await attachment(host, services, { get: id => id === host.runtimeId ? host : other,
    inspect: async id => ({ state: "idle", startupEnvironmentFingerprint: "a".repeat(64), incarnation: id, revision: "revision", blockers: [] }) });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const authority = { scope, runtimeId: host.runtimeId, controllerId: String(f.epoch) };
  const otherAuthority = { ...authority, runtimeId: other.runtimeId };
  try {
    await f.connection.attach(authority, () => {});
    await f.connection.attach(otherAuthority, () => {});
    const encode = f.hostChannel.encodeBody.bind(f.hostChannel);
    let entered = false;
    vi.spyOn(f.hostChannel, "encodeBody").mockImplementation(async value => {
      if ((value as { type?: string }).type === "lifecycle") { entered = true; await held; }
      return encode(value);
    });
    native.updateLifecycle({ state: "ready", generation: 2 });
    await vi.waitFor(() => expect(entered).toBe(true));
    // This command has an ordering fence; it must still wait for its own
    // runtime's preceding lifecycle notification.
    let busyDone = false;
    const busy = f.connection.attach(authority, () => {}).then(() => { busyDone = true; });
    void busy.catch(() => undefined);
    const otherResult = f.connection.attach(otherAuthority, () => {});
    const ack = f.connection.acknowledge(authority, "already-acknowledged");
    const inspect = f.connection.inspect(authority);
    let ready = false;
    const responsive = Promise.all([otherResult, ack, inspect]).then(() => { ready = true; });
    void responsive.catch(() => undefined);
    await vi.waitFor(() => expect(ready).toBe(true));
    await responsive;
    expect(busyDone).toBe(false);
    release();
    await busy;
    expect(busyDone).toBe(true);
  } finally { release(); await f.close(); }
});

function metadata(threadId: string): OfficialCodexClientRequestResult<"thread/read"> {
  return { thread: {
    id: threadId, extra: {}, sessionId: "session", forkedFromId: null, parentThreadId: null,
    preview: "A thread", ephemeral: false, section: null, sectionEnteredAt: null,
    projectId: null, historyMode: "paginated", modelProvider: "openai", model: null,
    reasoningEffort: null, createdAt: 1_700_000_000, updatedAt: 1_700_000_100,
    recencyAt: 1_700_000_100, status: { type: "idle" },
    path: "/provider/rollout.jsonl", cwd: "/workspace", cliVersion: "0.153.0",
    source: "appServer", canAcceptDirectInput: true, threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: "Fixture", turns: [],
  } };
}

async function threadFixture() {
  let sequence = 0;
  const native = new CodexSharedClientFacade({ current: () => ({ generation: 1,
    request: async () => undefined as never,
    requestWithReceipt: async (method, params) => ({ generation: 1, inboundSequence: ++sequence,
      result: method.decodeResult(method.method === "thread/read" ? metadata((params as { threadId: string }).threadId) : method.method === "model/list" ? { data: [], nextCursor: null } : {}) }),
  }), latestGeneration: () => 1, retireGeneration: async () => {} });
  native.updateLifecycle({ state: "ready", generation: 1 });
  const host = new CodexRuntimeHost({ scope, runtimeId: "shared-backend" });
  host.bind(native);
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration });
  const f = await attachment(host, services);
  const authority = { scope, runtimeId: host.runtimeId, controllerId: String(f.epoch) };
  const notify = (threadId: string, delta: string) => native.forwardNotification(1, {
    kind: "decoded_notification", generation: 1, sequence: ++sequence,
    method: "item/agentMessage/delta", params: { threadId, turnId: "turn", itemId: "item", delta },
  });
  let counter = 0;
  const read = (threadId: string) => f.connection.submit(authority, { operationId: `read-${++counter}`, generation: 1,
    method: "thread/read", params: { threadId, includeTurns: false }, timeoutMilliseconds: 1000 });
  const catalog = () => f.connection.submit(authority, { operationId: `catalog-${++counter}`, generation: 1,
    method: "model/list", params: {}, timeoutMilliseconds: 1000 });
  const holdThread = (threadId: string) => {
    let release!: () => void;
    let entered = false;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const encode = f.hostChannel.encodeBody.bind(f.hostChannel);
    vi.spyOn(f.hostChannel, "encodeBody").mockImplementation(async value => {
      const event = value as CodexRuntimeEvent;
      if (event.type === "notification" && event.notification.kind === "decoded_notification" &&
        (event.notification.params as { threadId?: string }).threadId === threadId) { entered = true; await hold; }
      return encode(value);
    });
    return { release, entered: () => entered };
  };
  return { ...f, authority, host, native, notify, read, catalog, holdThread };
}

it("multiplexes threads in one backend while preserving each snapshot's notification fence", async () => {
  const f = await threadFixture();
  const received: CodexRuntimeEvent[] = [];
  await f.connection.attach(f.authority, event => received.push(event));
  const held = f.holdThread("thread-a");
  const pending: Promise<unknown>[] = [];
  try {
    f.notify("thread-a", "before-a-snapshot");
    await vi.waitFor(() => expect(held.entered()).toBe(true));
    let aReadFinished = false;
    const aRead = f.read("thread-a").then(value => { aReadFinished = true; return value; });
    pending.push(aRead);
    let aReattachFinished = false;
    vi.spyOn(f.host, "reattachThread").mockResolvedValue({ generation: 1, inboundSequence: 2, result: {
      ...metadata("thread-a"), model: "gpt-5.6", modelProvider: "openai", serviceTier: "default",
      cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"], instructionSources: [],
      approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false },
      activePermissionProfile: { id: ":read-only", extends: null }, reasoningEffort: "low",
      multiAgentMode: "explicitRequestOnly", initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
      turnsBackwardsCursor: null, itemsBackwardsCursor: null,
    } });
    const aReattach = f.connection.reattachThread(f.authority, "thread-a", 1000).then(value => { aReattachFinished = true; return value; });
    pending.push(aReattach);
    f.notify("thread-b", "before-b-snapshot");
    let bReadFinished = false;
    const bPending = f.read("thread-b").then(value => { bReadFinished = true; return value; });
    pending.push(bPending);
    await vi.waitFor(() => expect(bReadFinished).toBe(true));
    const bRead = await bPending;
    expect(bRead).toMatchObject({ status: "completed", receipt: { result: { thread: { id: "thread-b" } } } });
    expect(received).toContainEqual(expect.objectContaining({ type: "notification", notification: expect.objectContaining({ params: expect.objectContaining({ threadId: "thread-b", delta: "before-b-snapshot" }) }) }));
    expect(aReadFinished).toBe(false);
    expect(aReattachFinished).toBe(false);
    await expect(f.catalog()).resolves.toMatchObject({ status: "completed", receipt: { result: { data: [] } } });
    // A later live delta must still be delivered once after B's snapshot.
    f.notify("thread-b", "after-b-snapshot");
    const renamed = await f.connection.submit(f.authority, { ...request, operationId: "rename-b", params: { threadId: "thread-b", name: "Renamed" } });
    expect(["pending", "completed"]).toContain(renamed.status);
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({ type: "outcome", outcome: expect.objectContaining({ operationId: "rename-b", status: "completed" }) })));
    await expect(f.connection.outcome(f.authority, "rename-b")).resolves.toMatchObject({ status: "completed" });
    const deltas = received.filter(event => event.type === "notification").map(event => event.notification.kind === "decoded_notification" ? (event.notification.params as { delta: string }).delta : "invalid");
    expect(deltas).toEqual(["before-b-snapshot", "after-b-snapshot"]);
    expect(aReadFinished).toBe(false);
    held.release();
    await Promise.all(pending);
    expect(aReattachFinished).toBe(true);
    expect(received.filter(event => event.type === "notification")).toHaveLength(3);
    await f.connection.acknowledge(f.authority, "rename-b");
  } finally { held.release(); await Promise.allSettled(pending); await f.close(); }
});

it("routes recovered asynchronous question replies around another thread's slow event", async () => {
  const f = await threadFixture();
  const params = decodeCodexServerRequestParams("item/tool/requestUserInput", { threadId: "thread-b", turnId: "turn", itemId: "item", questions: [], isBlocking: false });
  const controller = new AbortController();
  const response = Promise.resolve(f.host.serverRequests.handlersForGeneration(1)["item/tool/requestUserInput"]!({ generation: 1, sequence: 1,
    id: "question", method: "item/tool/requestUserInput", params, signal: controller.signal }));
  void response.catch(() => undefined);
  const held = f.holdThread("thread-a");
  let reply: Promise<void> | undefined;
  try {
    const received: CodexRuntimeEvent[] = [];
    const snapshot = await f.connection.attach(f.authority, event => received.push(event));
    expect(snapshot.pendingRequests).toHaveLength(1);
    f.notify("thread-a", "unrelated-output");
    await vi.waitFor(() => expect(held.entered()).toBe(true));
    let replied = false;
    reply = f.connection.respond(f.authority, { generation: 1, requestId: "question", result: { answers: {} } }).then(() => { replied = true; });
    await vi.waitFor(() => expect(replied).toBe(true));
    await reply;
    await expect(response).resolves.toEqual({ answers: {} });
    expect(received).toContainEqual({ type: "server_request_settled", generation: 1, requestId: "question" });
  } finally { held.release(); await reply; controller.abort(); await f.close(); }
});

it("keeps lifecycle transitions as a fence across every thread", async () => {
  const f = await threadFixture();
  const received: CodexRuntimeEvent[] = [];
  await f.connection.attach(f.authority, event => received.push(event));
  const held = f.holdThread("thread-a");
  let pending: Promise<unknown> | undefined;
  try {
    f.notify("thread-a", "old-generation-output");
    await vi.waitFor(() => expect(held.entered()).toBe(true));
    f.native.updateLifecycle({ state: "reconciling", generation: 1 });
    f.native.updateLifecycle({ state: "ready", generation: 1 });
    let finished = false;
    let catalogFinished = false;
    pending = Promise.all([
      f.read("thread-b").then(() => { finished = true; }),
      f.catalog().then(() => { catalogFinished = true; }),
    ]);
    // Inspection has no transcript fence and gives the carrier time to handle
    // both requests without releasing A's held notification.
    await f.connection.acknowledge(f.authority, "already-acknowledged");
    expect(finished).toBe(false);
    expect(catalogFinished).toBe(false);
    expect(received).toEqual([]);
    held.release();
    await pending;
    expect(received.map(event => event.type)).toEqual(["notification", "lifecycle", "lifecycle"]);
    expect(finished).toBe(true);
    expect(catalogFinished).toBe(true);
  } finally { held.release(); await pending; await f.close(); }
});

it.each([
  { stage: "event_body_decode", enabled: true },
  { stage: "event_schema_decode", enabled: true },
  { stage: "event_listener", enabled: true },
  { stage: "event_schema_decode", enabled: false },
])("identifies $stage before closing the carrier without leaking content (enabled=$enabled)", async ({ stage, enabled }) => {
  const f = await diagnosticAttachment();
  const authority = { scope, runtimeId: f.host.runtimeId, controllerId: String(f.epoch) };
  const records: Record<string, unknown>[] = [];
  const listener = vi.fn();
  let closeCompleted = false;
  try {
    await f.connection.attach(authority, listener);
    vi.stubEnv("SEDES_DEBUG_DELIVERY", enabled ? "1" : "");
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      if (!line.startsWith("[delivery-attachment] ")) return;
      records.push(JSON.parse(line.slice("[delivery-attachment] ".length)));
      // Logging failure must not prevent the requested transport closure.
      throw new Error("private-logger-failure");
    });
    if (stage === "event_body_decode") vi.spyOn(f.channel, "decodeBody").mockRejectedValue(new Error("sidecar_runtime_body_unknown", { cause: new Error("private-provider-body") }));
    if (stage === "event_schema_decode") vi.spyOn(f.channel, "decodeBody").mockResolvedValue({ type: "private-provider-body" });
    if (stage === "event_listener") listener.mockImplementation(() => { throw new Error("private-provider-body"); });
    const close = f.channel.peer.close.bind(f.channel.peer);
    vi.spyOn(f.channel.peer, "close").mockImplementation(async reason => {
      if (enabled) expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ event: "runtime_event_failed", stage })]));
      await close(reason);
      closeCompleted = true;
      throw new Error("sidecar_transport_cleanup_failed", { cause: new Error("private-close-error") });
    });
    f.native.updateLifecycle({ state: "reconciling", generation: 1 });
    await expect(f.closed).resolves.toMatchObject({ reason: "codex_runtime_event_invalid" });
    await vi.waitFor(() => {
      expect(closeCompleted).toBe(true);
      if (enabled) expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "runtime_event_failed", stage, backendInstanceId: scope.backendInstanceId,
          executionEnvironmentId: scope.executionEnvironmentId, controllerEpoch: f.epoch, requestedClose: true }),
        expect.objectContaining({ event: "runtime_event_close_failed", stage: "event_close" }),
      ]));
    });
    expect(JSON.stringify(records)).not.toMatch(/private-|runtimeId|sessionNonce/u);
    if (!enabled) expect(records).toEqual([]);
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f.close(); f.host.dispose(); }
});

it.each(["encodeBody", "call", "decodeBody"] as const)("retains a command failure and diagnoses its %s stage", async method => {
  const f = await diagnosticAttachment();
  const authority = { scope, runtimeId: f.host.runtimeId, controllerId: String(f.epoch) };
  try {
    await f.connection.attach(authority, () => {});
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("sidecar_runtime_body_expired", { cause: new Error("private-provider-result") });
    vi.spyOn(f.channel, method).mockRejectedValueOnce(error);
    await expect(f.connection.reattachThread(authority, "private-native-thread", 1000)).rejects.toBe(error);
    const stage = method === "encodeBody" ? "body_encode" : method === "call" ? "rpc_wait" : "body_decode";
    const records = log.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith("[delivery-attachment] "));
    expect(records.map(line => JSON.parse(line.slice("[delivery-attachment] ".length)))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "runtime_command_failed", stage: `command_reattach_thread_${stage}`,
        executionEnvironmentId: scope.executionEnvironmentId, controllerEpoch: f.epoch }),
    ]));
    expect(records.join("\n")).not.toContain("private-");
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f.close(); f.host.dispose(); }
});

it("separates slow response-body decoding from the command RPC wait", async () => {
  const f = await diagnosticAttachment();
  const authority = { scope, runtimeId: f.host.runtimeId, controllerId: String(f.epoch) };
  try {
    await f.connection.attach(authority, () => {});
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const decode = f.channel.decodeBody.bind(f.channel);
    vi.spyOn(f.channel, "decodeBody").mockImplementation(async body => { now += 1500; return await decode(body); });
    await expect(f.connection.reattachThread(authority, "private-native-thread", 1000)).resolves.toBeUndefined();
    const records = log.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith("[delivery-attachment] "))
      .map(line => JSON.parse(line.slice("[delivery-attachment] ".length)));
    expect(records).toEqual([expect.objectContaining({ event: "runtime_command_slow", stage: "command_reattach_thread_body_decode", durationMs: 1500 })]);
    expect(JSON.stringify(records)).not.toContain("private-");
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f.close(); f.host.dispose(); }
});

async function diagnosticAttachment() {
  const native = new CodexSharedClientFacade({ current: () => undefined, latestGeneration: () => 1, retireGeneration: async () => {} });
  native.updateLifecycle({ state: "ready", generation: 1 });
  const host = new CodexRuntimeHost({ scope, runtimeId: "private-native-runtime" });
  host.bind(native);
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId,
    executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration });
  return { ...await attachment(host, services), native, host };
}

async function attachment(host: CodexRuntimeHost, services: PersistentSidecarServiceRegistry, overrides: Partial<CodexRuntimeHostRegistry> = {}, mode: "normal" | "recovery" = "normal") {
  const pair = transportPair();
  const epoch = services.attach(configuration, mode);
  const leftRegistry = new SidecarOperationRegistry();
  const rightRegistry = new SidecarOperationRegistry();
  const sedes = new SidecarProtocolPeer({ role: "sedes", transport: pair.left, sessionNonce: "n".repeat(48), registry: leftRegistry });
  const sidecar = new SidecarProtocolPeer({ role: "sidecar", transport: pair.right, sessionNonce: "n".repeat(48), registry: rightRegistry });
  const left = new SidecarRuntimeChannel(sedes, leftRegistry);
  const right = new SidecarRuntimeChannel(sidecar, rightRegistry);
  const detach = registerCodexRuntimeHost({ registry: rightRegistry, channel: right, hosts: { get: (id: string) => { if (id !== host.runtimeId) throw new Error("unknown"); return host; }, ...overrides } as CodexRuntimeHostRegistry, services, controllerEpoch: epoch, onDetach: () => {} });
  const capabilities = rightRegistry.capabilities().map(({ capabilityId, majorVersion }) => ({ capabilityId, majorVersion }));
  registerControlV2Operations(rightRegistry, { buildId: "test", artifactSha256: "a".repeat(64), enabledSidecarCapabilities: capabilities, enabledSedesCapabilities: leftRegistry.capabilities() });
  sedes.start(); sidecar.start();
  await sedes.call(controlHelloOperation, { expectedBuildId: "test", expectedArtifactSha256: "a".repeat(64), authorizedSidecarCapabilities: capabilities, offeredSedesCapabilities: leftRegistry.capabilities() });
  return { detach, epoch, hostChannel: right, channel: left, closed: pair.left.closed, connection: new CodexSidecarRuntimeConnection(left), close: async () => { detach(); services.detach(epoch); left.close(); right.close(); await sedes.close("test_complete"); } };
}

it("recovers administration after proxy close without ensuring a provider, and distinguishes absent from unavailable", async () => {
  const database = new Database(":memory:");
  initializeEmptyBackendNormalizedDatabase(database);
  const receipts = new CodexRuntimeReceiptStore(database);
  const native = new CodexSharedClientFacade({ current: () => ({ generation: 1, request: async () => undefined as never,
    requestWithReceipt: async () => { throw new CodexRpcRemoteError({ code: -32000, message: "native refused", generation: 1, method: "turn/start" }); } }), latestGeneration: () => 1, retireGeneration: async () => {} });
  native.updateLifecycle({ state: "ready", generation: 1 });
  const host = new CodexRuntimeHost({ scope, runtimeId: "retained" });
  host.bind(native);
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration });
  let present = true;
  const ensure = vi.fn(async () => { throw new Error("recovery_must_not_ensure"); });
  const stop = vi.fn(async (_id: string, revision: string) => { expect(revision).toBe("confirmed"); present = false; });
  const f = await attachment(host, services, {
    ensure,
    lookup: async config => {
      if (config.connection.ownership !== "external" || config.connection.channel.type !== "unix_websocket" || config.connection.channel.socketPath !== "/provider/codex.sock") throw new Error("configuration_mismatch");
      return present ? host : undefined;
    },
    inspect: async () => ({ state: "idle", startupEnvironmentFingerprint: "a".repeat(64), incarnation: host.runtimeId, revision: "confirmed", blockers: [] }),
    stop,
  });
  const runtimeConfiguration = {
    instance: { id: scope.backendInstanceId, tenantId: scope.tenantId, kind: "codex_app_server" as const, label: "Codex", enabled: false, configurationRevision: 0, protocolRelease: "0.153.0" as const },
    connections: [{ id: "connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "template", kind: "codex_app_server" as const, backendInstanceId: scope.backendInstanceId, executionEnvironmentId: scope.executionEnvironmentId, label: "Codex", enabled: false, configurationRevision: 0 }],
    connection: { ownership: "external" as const, channel: { type: "unix_websocket" as const, socketPath: "/provider/codex.sock" } },
  };
  const context = { database, scope: { tenantId: scope.tenantId, principalId: scope.principalId }, instance: runtimeConfiguration.instance, connections: runtimeConfiguration.connections,
    sidecarRuntime: { acquireRecovery: vi.fn(async () => ({ channel: f.channel, closed: f.closed, controllerEpoch: f.epoch, serviceIncarnation: services.serviceIncarnation, release: () => {} })) },
  };
  try {
    expect(() => codexRuntimeEnsureOperation.requestSchema.parse({ configuration: { ...runtimeConfiguration, instance: { ...runtimeConfiguration.instance, enabled: true } } })).not.toThrow();
    const proxy = new CodexRuntimeClient({ connection: f.connection, authority: { scope, runtimeId: host.runtimeId, controllerId: String(f.epoch) }, receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [], reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false } });
    await proxy.start();
    await proxy.close();
    const authority = { scope, runtimeId: host.runtimeId, controllerId: String(f.epoch) };
    receipts.reserve(authority, { operationId: "critical", method: "turn/start", requestFingerprint: "a".repeat(64), correlation: { kind: "start", applicationOperationId: "app-operation", applicationThreadId: "app-thread" } });
    await f.connection.attach(authority, () => {});
    await f.connection.submit(authority, { operationId: "critical", generation: 1, method: "turn/start", params: { threadId: "native-thread", input: [{ type: "text", text: "hello", text_elements: [] }] }, timeoutMilliseconds: 1000 });
    await f.connection.detach(authority);
    const admin = await recoverCodexRuntimeAdministration({ context, configuration: runtimeConfiguration });
    expect(host.pendingOutcomeCount()).toBe(0);
    expect(receipts.pending(authority)).toMatchObject([{ state: "recorded", outcome: { status: "failed" } }]);
    await expect(admin!.inspect()).resolves.toMatchObject({ state: "idle", incarnation: "retained" });
    const observed: CodexRuntimeEvent[] = [];
    await f.connection.attach(authority, event => observed.push(event));
    await admin!.inspect();
    native.updateLifecycle({ state: "ready", generation: 2 });
    await vi.waitFor(() => expect(observed).toContainEqual({ type: "lifecycle", lifecycle: { state: "ready", generation: 2 } }));
    await expect(recoverCodexRuntimeAdministration({ context, configuration: { ...runtimeConfiguration, connection: { ownership: "external", channel: { type: "unix_websocket", socketPath: "/wrong.sock" } } } })).rejects.toThrow();
    const staleContext = { ...context, sidecarRuntime: { acquireRecovery: async () => ({ ...await context.sidecarRuntime.acquireRecovery(), controllerEpoch: f.epoch - 1 }) } };
    await expect(recoverCodexRuntimeAdministration({ context: staleContext, configuration: runtimeConfiguration })).rejects.toThrow();
    for (const [code, reason] of [
      ["codex_runtime_confirmation_stale", "confirmation_stale"],
      ["codex_runtime_restart_blocked", "blocked"],
      ["codex_runtime_outcomes_unacknowledged", "blocked"],
      ["codex_runtime_cleanup_unproven", "cleanup_unproven"],
    ]) {
      stop.mockRejectedValueOnce(new Error(code));
      await expect(f.connection.stop(authority, "confirmed", false)).rejects.toMatchObject({
        name: "BackendRuntimeControlRejectedError", reason, cause: { code },
      });
      stop.mockRejectedValueOnce(new Error(code));
      await expect(admin!.stop({ expectedRevision: "confirmed", force: false })).rejects.toMatchObject({
        name: "BackendRuntimeControlRejectedError", reason, cause: { code },
      });
    }
    stop.mockRejectedValueOnce(new Error("native_child_exit_unproven"));
    const cleanupError = await admin!.stop({ expectedRevision: "confirmed", force: false }).catch(error => error);
    expect(cleanupError).toBeInstanceOf(Error);
    expect(cleanupError).not.toBeInstanceOf(BackendRuntimeControlRejectedError);
    stop.mockClear();
    await admin!.stop({ expectedRevision: "confirmed", force: false });
    expect(stop).toHaveBeenCalledOnce();
    await expect(recoverCodexRuntimeAdministration({ context, configuration: runtimeConfiguration })).resolves.toBeUndefined();
    await admin!.stop({ expectedRevision: "confirmed", force: false });
    expect(stop).toHaveBeenCalledOnce();
    await expect(recoverCodexRuntimeAdministration({ context: { ...context, sidecarRuntime: { acquireRecovery: async () => { throw new Error("host_unavailable"); } } }, configuration: runtimeConfiguration })).rejects.toThrow("host_unavailable");
    expect(ensure).not.toHaveBeenCalled();
  } finally { await f.close(); database.close(); }
});

class Queue implements AsyncIterable<SidecarFrame> {
  readonly values: SidecarFrame[] = [];
  readonly waiters: ((result: IteratorResult<SidecarFrame>) => void)[] = [];
  ended = false;
  push(value: SidecarFrame) {
    const waiter = this.waiters.shift();
    waiter ? waiter({ value, done: false }) : this.values.push(value);
  }
  end() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SidecarFrame> {
    return {
      next: async () => {
        const value = this.values.shift();
        return value
          ? { value, done: false }
          : this.ended
            ? { value: undefined, done: true }
            : await new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class Transport implements SidecarFrameTransport {
  readonly sizes: number[] = [];
  readonly assurance = { kind: "memory", carrierGeneration: 1 };
  readonly queue = new Queue();
  readonly frames = this.queue;
  readonly closed: Promise<SidecarTransportClosure>;
  resolve!: (closure: SidecarTransportClosure) => void;
  peer?: Transport;
  constructor() {
    this.closed = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
  async send(bytes: Uint8Array, _options: SidecarFrameSendOptions) {
    if (!this.peer) throw new SidecarFrameWriteError("closed", "not_sent");
    this.sizes.push(bytes.byteLength);
    this.peer.queue.push({ bytes: Uint8Array.from(bytes) });
    return { disposition: "sent" as const };
  }
  async close(reason: string) {
    this.queue.end();
    this.resolve({ reason });
    if (this.peer) {
      this.peer.queue.end();
      this.peer.resolve({ reason });
    }
  }
}
function transportPair() {
  const left = new Transport();
  const right = new Transport();
  left.peer = right;
  right.peer = left;
  return { left, right };
}

it("permits existing Codex reads and exact pending replies during recovery while rejecting new work", async () => {
  let sequence = 0;
  const calls: string[] = [];
  const retainedMetadata = { thread: { ...metadata("retained").thread, historyMode: "legacy" } };
  const native = new CodexSharedClientFacade({ current: () => ({ generation: 1,
    request: async () => undefined as never,
    requestWithReceipt: async (method) => {
      calls.push(method.method);
      const result = method.method === "thread/start" ? {
        ...retainedMetadata, model: "gpt-5.6", modelProvider: "openai", serviceTier: "default", cwd: "/workspace",
        runtimeWorkspaceRoots: ["/workspace"], instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: { id: ":read-only", extends: null },
        reasoningEffort: "low", multiAgentMode: "explicitRequestOnly",
      } : retainedMetadata;
      return { generation: 1, inboundSequence: ++sequence, result: method.decodeResult(result) };
    },
  }), latestGeneration: () => 1, retireGeneration: async () => {} });
  native.updateLifecycle({ state: "ready", generation: 1 });
  const host = new CodexRuntimeHost({ scope, runtimeId: "retained-runtime" }); host.bind(native);
  const original = { scope, runtimeId: host.runtimeId, controllerId: "original" };
  await host.attach(original, () => {});
  await host.submit(original, { operationId: "start-existing", generation: 1, method: "thread/start", params: {}, timeoutMilliseconds: 1000 });
  await vi.waitFor(async () => expect(await host.outcome(original, "start-existing")).toMatchObject({ status: "completed" }));
  const services = new PersistentSidecarServiceRegistry({ scope: { tenantId: scope.tenantId, principalId: scope.principalId, executionEnvironmentId: scope.executionEnvironmentId, installationId: "installation" }, buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration });
  const f = await attachment(host, services, {}, "recovery");
  const authority = { scope, runtimeId: host.runtimeId, controllerId: String(f.epoch) };
  try {
    await f.connection.attach(authority, () => {});
    expect(await f.connection.reattachThread(authority, "retained", 1000)).toBeDefined();
    expect(await f.connection.reattachThread(authority, "unknown", 1000)).toBeUndefined();
    await expect(f.connection.submit(authority, { operationId: "retained-read", generation: 1, method: "thread/read", params: { threadId: "retained", includeTurns: false }, timeoutMilliseconds: 1000 })).resolves.toMatchObject({ status: "completed" });
    await expect(f.connection.submit(authority, { ...request, method: "thread/read", params: { threadId: "unknown", includeTurns: false } })).rejects.toThrow();
    await expect(f.connection.submit(authority, request)).rejects.toThrow();
    const params = decodeCodexServerRequestParams("item/tool/requestUserInput", { threadId: "retained", turnId: "turn", itemId: "item", questions: [], isBlocking: false });
    const response = Promise.resolve(host.serverRequests.handlersForGeneration(1)["item/tool/requestUserInput"]!({ generation: 1, sequence: 1,
      id: "question", method: "item/tool/requestUserInput", params, signal: new AbortController().signal }));
    await f.connection.respond(authority, { generation: 1, requestId: "question", result: { answers: {} } });
    await expect(response).resolves.toEqual({ answers: {} });
    await expect(f.connection.respond(authority, { generation: 1, requestId: "unknown", result: { answers: {} } })).rejects.toThrow();
    expect(calls.every(method => method === "thread/start" || method === "thread/read")).toBe(true);
    expect(calls.filter(method => method === "thread/start")).toHaveLength(1);
  } finally { await f.close(); }
});
