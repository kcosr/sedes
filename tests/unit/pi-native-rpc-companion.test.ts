import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { compileFunction, constants } from "node:vm";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as fs from "node:fs";
import { PiManagedBridge } from "../../src/server/backends/pi/native/rpc/pi-managed-bridge.js";
import { parsePiManagedResult, verifyPiManagedOperations, type PiManagedContextUsage, type PiManagedEvent, type PiManagedInput, type PiManagedState } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";
import { parsePiNativeEntry } from "../../src/server/backends/pi/native/rpc/pi-rpc-wire.js";
import { PiNativeHost, type PiNativeSessionLauncher } from "../../src/server/backends/pi/native/host/native-host.js";
import { PiNativeConversationDriver, serializePiNativeBindingDetail, type PiNativeOperations } from "../../src/server/backends/pi/native/driver/driver.js";
import type { PiNativeHistory } from "../../src/server/backends/pi/native/port.js";
import type { AttachConversationInput } from "../../src/server/backends/contracts.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";

type RecordValue = Record<string, any>;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "sp-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const bridge = await PiManagedBridge.listen(directory, key);
  cleanups.push(() => bridge.close());
  vi.stubEnv("SEDES_PI_BOOTSTRAP_FILE", bridge.bootstrapPath);
  const handlers = new Map<string, Array<(event: RecordValue, context: RecordValue) => unknown>>();
  const entries: RecordValue[] = [];
  const tools: RecordValue[] = ["read", "grep", "find", "ls", "bash", "write", "edit"].map((name) => ({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } }));
  let activeTools = ["read", "bash"];
  const context = { mode: "rpc", model: { provider: "test", id: "model", input: ["text"] }, thinkingLevel: "low", isIdle: () => true, abort: vi.fn(), shutdown: vi.fn(), signal: new AbortController().signal,
    getContextUsage: vi.fn<() => PiManagedContextUsage | undefined>(() => undefined),
    sessionManager: { getSessionId: () => "session", getSessionFile: () => "/sessions/session.jsonl", getEntries: () => [...entries], getBranch: () => [...entries], getLeafId: () => entries.at(-1)?.id ?? null },
  };
  function append(value: RecordValue) { const entry = { id: `entry-${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...value }; entries.push(entry); return entry; }
  const api = {
    on(name: string, handler: (event: RecordValue, context: RecordValue) => unknown) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    appendEntry(customType: string, data: unknown) { append({ type: "custom", customType, data }); },
    getAllTools: () => [...tools], getActiveTools: () => [...activeTools], setActiveTools: (names: string[]) => { activeTools = names; },
    registerTool(tool: RecordValue) { const previous = tools.findIndex((candidate) => candidate.name === tool.name); if (previous >= 0) tools.splice(previous, 1); tools.push({ ...tool, sourceInfo: { source: "cli", path: "/private/companion.mjs" } }); },
  };
  // Execute the generated body in an empty global scope. This detects accidental
  // imports/closure references introduced by compiler transforms.
  const extensionSource = await readFile(new URL("../../src/server/backends/pi/native/rpc/pi-managed-extension.ts", import.meta.url), "utf8");
  const compiled = stripTypeScriptTypes(extensionSource);
  const loadModule = compileFunction("return import(url)", ["url"], { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as (url: string) => Promise<{ piManagedExtensionSource(): string }>;
  const module = await loadModule(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const source = module.piManagedExtensionSource().replace(/^import .*;$/gm, "").replace("export default (pi) => install(pi, createCodemodeExtension, createMcpExtension, createToolSearchExtension, { net, crypto, fs });", "return install;");
  const install = compileFunction(source, [], { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })() as (api: unknown, factory: unknown, mcp: unknown, toolSearch: unknown, runtime: unknown) => Promise<void>;
  const codeFactory = vi.fn((options) => (target: typeof api) => {
    expect(fs.existsSync(bridge.bootstrapPath)).toBe(false);
    expect(process.env.SEDES_PI_BOOTSTRAP_FILE).toBeUndefined();
    expect(options).toEqual({ models: false }); target.registerTool({ name: "codemode", parameters: { type: "object" } });
  });
  await install(api, codeFactory, () => (target: typeof api) => target.registerTool({ name: "mcp__test__read", parameters: {}, annotations: { readOnlyHint: true } }), () => (target: typeof api) => target.registerTool({ name: "tool_search", parameters: {} }), { net, crypto, fs });
  async function emit(name: string, event: RecordValue = {}) { let result: unknown; for (const handler of handlers.get(name) ?? []) result = await handler(event, context); return result; }
  await emit("session_start"); await bridge.ready;
  return { bridge, key, entries, append, context, emit, tools, codeFactory };
}
function input(id: string, mode: "submit" | "steer" = "submit"): PiManagedInput {
  return { operationId: id, mutationId: `mutation-${id}`, reconciliationToken: `token-${id}`, fingerprint: "a".repeat(64), text: "identical user input", mode };
}
function toolTurn(f: Awaited<ReturnType<typeof fixture>>, id = "outer", name = "codemode") {
  f.append({ type: "message", message: { role: "user", content: "run", timestamp: 1 } });
  f.append({ type: "message", message: { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id, name, arguments: {} }], api: "test", provider: "test", model: "model", stopReason: "toolUse", usage: {} } });
}
async function waitEvent(bridge: PiManagedBridge, type: PiManagedEvent["type"]): Promise<PiManagedEvent> {
  return await new Promise((resolve) => { const unsubscribe = bridge.subscribe((event) => { if (event.type === type) { unsubscribe(); resolve(event); } }); });
}

describe("Pi native companion public API boundary", () => {
  it("reads fresh native context occupancy and preserves unknown post-compaction usage", async () => {
    const f = await fixture();
    expect((await f.bridge.request({ type: "snapshot" }) as PiManagedState).contextUsage).toBeUndefined();
    f.context.getContextUsage.mockReturnValue({ tokens: 1_024, contextWindow: 4_096, percent: 25 });
    expect((await f.bridge.request({ type: "snapshot" }) as PiManagedState).contextUsage).toEqual({ tokens: 1_024, contextWindow: 4_096, percent: 25 });
    f.context.getContextUsage.mockReturnValue({ tokens: null, contextWindow: 4_096, percent: null });
    expect((await f.bridge.request({ type: "snapshot" }) as PiManagedState).contextUsage).toEqual({ tokens: null, contextWindow: 4_096, percent: null });
    f.context.getContextUsage.mockReturnValue(undefined);
    expect((await f.bridge.request({ type: "snapshot" }) as PiManagedState).contextUsage).toBeUndefined();
  });

  it("authenticates the generated extension and preserves duplicate-input identity using persisted entry references", async () => {
    const f = await fixture();
    await f.bridge.request({ type: "set_policy", policy: { mode: "read_only" } });
    const first = await f.bridge.request({ type: "prepare_submission", input: input("first") }) as { wireText: string };
    await expect(f.bridge.request({ type: "prepare_submission", input: input("overlap") })).rejects.toMatchObject({ code: "pi_managed_admission_closed" });
    expect(await f.emit("input", { source: "extension", text: first.wireText })).toEqual({ action: "handled" });
    expect(await f.emit("input", { source: "rpc", text: first.wireText })).toMatchObject({ action: "transform", text: "identical user input" });
    await f.bridge.request({ type: "complete_submission", operationId: "first", disposition: "started" });
    const second = await f.bridge.request({ type: "prepare_submission", input: input("second", "steer") }) as { wireText: string };
    expect(first.wireText).not.toBe(second.wireText);
    expect(await f.emit("input", { source: "rpc", text: second.wireText })).toMatchObject({ action: "transform", text: "identical user input" });
    await f.bridge.request({ type: "complete_submission", operationId: "second", disposition: "queued" });
    const messages = [1, 2].map(() => ({ role: "user", content: "identical user input", timestamp: 1 }));
    for (const message of messages) { await f.emit("message_start", { message }); f.append({ type: "message", message }); }
    const state = await f.bridge.request({ type: "snapshot" }) as PiManagedState;
    expect(state.operations.map((op) => [op.input.operationId, op.phase, op.userEntryId])).toEqual([["first", "accepted", "entry-4"], ["second", "accepted", "entry-5"]]);
    expect(verifyPiManagedOperations(state.entries, "session", f.key)).toEqual(state.operations);
    expect(verifyPiManagedOperations(state.entries, "other-session", f.key)).toEqual([]);
    expect(verifyPiManagedOperations(state.entries, "session", randomBytes(32))).toEqual([]);
    expect(state.tools.find((tool) => tool.name === "codemode")?.managed).toBe("codemode");
  });

  it("resolves pending approvals during stop and marks only unmaterialized queued inputs lost", async () => {
    const f = await fixture();
    await f.bridge.request({ type: "set_policy", policy: { mode: "ask" } });
    const prepared = await f.bridge.request({ type: "prepare_submission", input: input("queued", "steer") }) as { wireText: string };
    await f.emit("input", { source: "rpc", text: prepared.wireText });
    await f.bridge.request({ type: "complete_submission", operationId: "queued", disposition: "queued" });
    const requested = waitEvent(f.bridge, "tool_approval_requested");
    toolTurn(f);
    const tool = f.emit("tool_call", { toolName: "bash", toolCallId: "nested", parentToolCallId: "outer", input: { command: "write" } });
    expect(await requested).toMatchObject({ type: "tool_approval_requested", toolCallId: "nested" });
    expect(await f.bridge.request({ type: "begin_stop" })).toEqual({ ok: true });
    expect(await tool).toMatchObject({ block: true });
    expect(await f.bridge.request({ type: "end_stop" })).toEqual({ ok: true });
    expect(await f.bridge.request({ type: "get_submission", operationId: "queued" })).toMatchObject({ phase: "lost" });
  });

  it("keeps Stop acknowledgements bounded as submission history grows", async () => {
    const f = await fixture();
    await f.bridge.request({ type: "set_policy", policy: { mode: "read_only" } });
    for (let index = 0; index < 8; index++) {
      const operation = { ...input(`history-${index}`), text: `${index}:` + "private prompt ".repeat(2_048) };
      await f.bridge.request({ type: "prepare_submission", input: operation });
      await f.bridge.request({ type: "complete_submission", operationId: operation.operationId, disposition: "handled" });
    }
    for (const type of ["begin_stop", "end_stop"] as const) {
      const result = await f.bridge.request({ type });
      expect(result).toEqual({ ok: true });
      expect(Buffer.byteLength(JSON.stringify(result))).toBe(11);
      expect(() => parsePiManagedResult({ type }, { operations: [] })).toThrow();
      expect(() => parsePiManagedResult({ type }, { ok: true, operations: [] })).toThrow();
    }
    const state = await f.bridge.request({ type: "snapshot" }) as PiManagedState;
    expect(state.operations).toHaveLength(8);
    expect(state.operations.every(operation => operation.input.text.includes("private prompt"))).toBe(true);
    expect(await f.bridge.request({ type: "get_submission", operationId: "history-7" })).toEqual(state.operations[7]);
  });

  it("stops an overflowed session waiting on a real companion agent call without stopping its peer", async () => {
    const f = await fixture();
    await f.bridge.request({ type: "set_policy", policy: { mode: "full" } });
    await f.bridge.request({ type: "configure_agent_tools", tools: [{ name: "task_list", description: "List tasks", parameters: { type: "object", properties: {} }, readOnly: true }] });
    toolTurn(f);
    f.context.isIdle = () => false;
    const identity = { sessionId: "session", sessionFile: "/sessions/session.jsonl", cwd: "/project" };
    const peer = { ...identity, sessionId: "peer", sessionFile: "/sessions/peer.jsonl" };
    const commands: string[] = []; const closed: string[] = [];
    let emit!: NonNullable<Parameters<PiNativeSessionLauncher>[0]["onEvent"]>;
    let callResult!: Promise<unknown>;
    const history = (input: typeof identity): PiNativeHistory => ({ ...input,
      entries: input.sessionId === identity.sessionId ? f.entries : [], leafId: input.sessionId === identity.sessionId ? f.entries.at(-1)?.id ?? null : null,
      operations: [], toolCalls: [], toolResults: [], inheritedEntryIds: [], inheritance: "none" });
    const host = new PiNativeHost({ configuration: { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "environment", initializationTimeoutMs: 1_000, projectTrusted: false },
      channels: {} as ExecutionEnvironmentChannelProvider, environment: {}, authenticationKey: f.key, maximumEventBytes: 1_024,
      acquireWriter: async () => ({ release: async () => {} }),
      store: { resolveSessionDirectory: async () => "/sessions", create: async () => identity, fork: async () => peer,
        reconcileFork: async () => null, listSessions: async () => ({ sessions: [] }), readHistory: async input => history(input) },
      launch: (async (input: Parameters<PiNativeSessionLauncher>[0]) => {
        if (!input.session) throw new Error("Unexpected catalog launch");
        if (input.session.sessionId === peer.sessionId) return {
          rpc: { request: async () => ({ ...peer, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }), respondUI: async () => {}, closed: new Promise(() => {}) },
          bridge: { request: async () => ({ ...peer, entries: [], leafId: null, operations: [], toolCalls: [], toolResults: [], tools: [], activeTools: [], isIdle: true }), closed: new Promise(() => {}) },
          close: async () => { closed.push(peer.sessionId); }, version: "1.4.0" };
        emit = input.onEvent!;
        const unsubscribe = f.bridge.subscribe(payload => emit({ kind: "companion", payload }));
        return { rpc: { request: async (command: RecordValue) => {
          commands.push(command.type);
          if (command.type === "get_state") return { sessionId: identity.sessionId, sessionFile: identity.sessionFile,
            isStreaming: !f.context.isIdle(), isCompacting: false, pendingMessageCount: 0, messageCount: 0,
            thinkingLevel: "low", steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true };
          if (command.type === "abort") {
            expect(await callResult).toMatchObject({ message: "pi_managed_stopped" });
            f.context.isIdle = () => true; emit({ kind: "rpc", payload: { type: "agent_end" } });
          }
          return {};
        }, respondUI: async () => {}, closed: new Promise(() => {}) }, bridge: f.bridge,
        close: async () => { closed.push(identity.sessionId); unsubscribe(); await f.bridge.close(); }, version: "1.4.0" };
      }) as unknown as PiNativeSessionLauncher });
    cleanups.push(() => host.close());
    const original = await host.attach(identity); const peerHandle = await host.attach(peer);
    emit({ kind: "rpc", payload: { type: "agent_start" } });
    emit({ kind: "rpc", payload: { type: "extension_error", error: "x".repeat(2_048) } });
    await host.release({ handleId: original.handleId });
    await f.emit("tool_call", { toolName: "task_list", toolCallId: "outer/1", parentToolCallId: "outer", input: {} });
    const requested = waitEvent(f.bridge, "agent_tool_call");
    callResult = f.tools.find(tool => tool.name === "task_list")!.execute("outer/1", {}, new AbortController().signal).catch((error: unknown) => error);
    expect(await requested).toMatchObject({ type: "agent_tool_call", name: "task_list" });
    let callSettled = false; void callResult.then(() => { callSettled = true; });
    const records = new Map<string, ReturnType<PiNativeOperations["prepareOperation"]>>();
    const operations: PiNativeOperations = {
      prepareOperation: (_scope, _thread, input) => { const record = records.get(input.operationId) ?? { requestHash: input.requestHash, state: "prepared" as const, prepareAttempt: 0, dispatchStarted: false, receiptJson: null }; records.set(input.operationId, record); return record; },
      getOperation: (_scope, _thread, id) => records.get(id),
      completeOperation: (_scope, _thread, id, input) => { const record = { ...records.get(id)!, ...input }; records.set(id, record); return record; },
      resetUnsentOperation: () => { throw new Error("Unexpected submission"); },
      markSubmissionDispatched: () => { throw new Error("Unexpected submission"); },
    };
    const driver = new PiNativeConversationDriver({ port: host, operations, usage: NO_USAGE_SINK,
      instance: { id: "backend", tenantId: "tenant", kind: "pi_native", label: "Pi", enabled: true, configurationRevision: 1, protocolRelease: "1.4.0" },
      connection: { id: "connection", backendInstanceId: "backend", tenantId: "tenant", ownerPrincipalId: "principal", templateId: "template", kind: "pi_rpc", executionEnvironmentId: "environment", label: "Pi", enabled: true, configurationRevision: 1 },
      settings: { getSettings: () => ({ modelProvider: null, modelId: null, thinkingLevel: null, toolMode: "full", revision: 0 }) },
      modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "provider_model_effort") });
    cleanups.push(() => driver.close());
    const input: AttachConversationInput = { scope: { tenantId: "tenant", principalId: "principal" },
      workspace: { canonicalPath: identity.cwd, authorityRevision: 0, summary: { id: "workspace", environmentId: "environment", displayName: "Project", displayPath: identity.cwd, availability: "available", trustState: "trusted", revision: 0 } },
      binding: { tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "thread", backendConversationId: identity.sessionId,
        backendInstanceId: "backend", connectionProfileId: "connection", executionEnvironmentId: "environment", createdAt: new Date().toISOString() },
      opaqueBindingDetail: serializePiNativeBindingDetail(identity) };
    const handle = await driver.attach(input);
    expect(callSettled).toBe(false); expect(commands).toEqual([]); expect(closed).toEqual([]);
    expect(await handle.backendCapabilities()).toMatchObject({ actions: [], deliveryModes: [] });
    const stop = { applicationOperationId: "stop", deadlineAt: Date.now() + 5_000 };
    await handle.interrupt(stop);
    expect(callSettled).toBe(true); expect(commands).toEqual(["clear_queue", "abort"]);
    await expect(handle.reconcileInterrupt(stop)).resolves.toEqual({ outcome: "accepted" });
    await handle.close(); await expect(driver.releaseConversationResidency(input)).resolves.toBe("released");
    expect(closed).toEqual([identity.sessionId]);
    expect(host.snapshot().retainedSessions.map(session => session.sessionId)).toEqual([peer.sessionId]);
    await host.request({ handleId: peerHandle.handleId, operationId: "peer-read", command: { channel: "rpc", command: { type: "get_state" } }, retainOutcome: false });
    await vi.waitFor(async () => expect(await host.outcome({ handleId: peerHandle.handleId, operationId: "peer-read" })).toMatchObject({ status: "completed" }));
  });

  it("reopens admission after persisted acceptance without requiring the lost dispatch reply", async () => {
    const f = await fixture();
    await f.bridge.request({ type: "set_policy", policy: { mode: "read_only" } });
    const first = await f.bridge.request({ type: "prepare_submission", input: input("first") }) as { wireText: string };
    await f.emit("input", { source: "rpc", text: first.wireText });
    const message = { role: "user", content: "identical user input", timestamp: 1 };
    await f.emit("message_start", { message }); f.append({ type: "message", message });
    expect((await f.bridge.request({ type: "snapshot" }) as PiManagedState).operations[0]?.phase).toBe("accepted");
    await f.bridge.request({ type: "prepare_submission", input: input("second") });
    await f.bridge.request({ type: "complete_submission", operationId: "first", disposition: "started" });
    await expect(f.bridge.request({ type: "prepare_submission", input: input("third") })).rejects.toMatchObject({ code: "pi_managed_admission_closed" });
  });

  it("permits code execution but gates every nested effect by trusted tool identity", async () => {
    const f = await fixture();
    await f.bridge.request({ type: "set_policy", policy: { mode: "read_only" } });
    await f.bridge.request({ type: "set_active_tools", names: ["codemode", "read"] });
    toolTurn(f);
    expect(await f.emit("tool_call", { toolName: "codemode", toolCallId: "outer", input: { code: "x" } })).toBeUndefined();
    expect(await f.emit("tool_call", { toolName: "read", toolCallId: "outer/1", parentToolCallId: "outer", input: { path: "file" } })).toBeUndefined();
    expect(await f.emit("tool_call", { toolName: "write", toolCallId: "outer/2", parentToolCallId: "outer", input: { path: "file" } })).toMatchObject({ block: true });
    expect(await f.emit("tool_call", { toolName: "mcp__test__read", toolCallId: "outer/4", parentToolCallId: "outer", input: {} })).toMatchObject({ block: true });
    f.tools.find((tool) => tool.name === "read")!.sourceInfo = { source: "cli", path: "/untrusted" };
    expect(await f.emit("tool_call", { toolName: "read", toolCallId: "outer/3", parentToolCallId: "outer", input: { path: "file" } })).toMatchObject({ block: true });
  });

  it("registers agent tools, binds nested calls to durable identity, and returns results", async () => {
    const f = await fixture();
    await f.bridge.request({ type: "set_policy", policy: { mode: "read_only" } });
    await f.bridge.request({ type: "configure_agent_tools", tools: [{ name: "task_list", description: "List tasks", parameters: { type: "object", properties: {} }, readOnly: true }], instructions: "Use task tools." });
    expect(await f.emit("before_agent_start", { systemPrompt: "Base" })).toEqual({ systemPrompt: "Base\n\nUse task tools." });
    const user = f.append({ type: "message", message: { role: "user", content: "list", timestamp: 1 } });
    const assistant = f.append({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "x" } }], timestamp: 2, api: "test", provider: "test", model: "model", stopReason: "toolUse", usage: {} } });
    await f.emit("tool_call", { toolName: "task_list", toolCallId: "outer/1", parentToolCallId: "outer", input: {} });
    const called = waitEvent(f.bridge, "agent_tool_call");
    const result = f.tools.find((tool) => tool.name === "task_list")!.execute("outer/1", {}, new AbortController().signal);
    const call = await called;
    expect(call).toMatchObject({ name: "task_list", assistantEntryId: assistant.id, userEntryId: user.id, parentToolCallId: "outer" });
    if (call.type !== "agent_tool_call") throw new Error("wrong call");
    await f.bridge.request({ type: "resolve_agent_tool", id: call.id, result: { content: [{ type: "text", text: "[]" }] } });
    expect(await result).toEqual({ content: [{ type: "text", text: "[]" }] });
    const failedEvent = waitEvent(f.bridge, "agent_tool_call");
    const failed = f.tools.find((tool) => tool.name === "task_list")!.execute("outer/1", {}, new AbortController().signal);
    const failedCall = await failedEvent;
    if (failedCall.type !== "agent_tool_call") throw new Error("wrong call");
    const details = { agentToolInvocation: { toolId: "task.list", schemaVersion: 1, invocationId: "failed-invocation" } };
    await f.bridge.request({ type: "resolve_agent_tool", id: failedCall.id, isError: true, result: { content: [{ type: "text", text: "Failed" }], details } });
    expect(await failed).toEqual({ content: [{ type: "text", text: "Failed" }], details, isError: true });
    const state = await f.bridge.request({ type: "snapshot" }) as PiManagedState;
    for (const entry of state.entries) expect(() => parsePiNativeEntry(entry)).not.toThrow();
  });

  it("does not release a provider hook after a forbidden model or effort change", async () => {
    const f = await fixture();
    await f.bridge.request({ type: "set_policy", policy: { mode: "full", allowedModels: [{ provider: "test", modelId: "model", thinkingLevels: ["low"] }] } });
    f.context.thinkingLevel = "high";
    let released = false;
    void f.emit("before_provider_request").then(() => { released = true; });
    await f.bridge.closed;
    expect(f.context.abort).toHaveBeenCalledOnce();
    expect(f.context.shutdown).toHaveBeenCalledOnce();
    expect(released).toBe(false);
  });
});
