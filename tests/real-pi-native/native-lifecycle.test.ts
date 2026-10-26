import { afterEach, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { PiNativeHost } from "../../src/server/backends/pi/native/host/native-host.js";
import { PiNativeConversationDriver, parsePiNativeBindingDetail, type PiNativeOperations } from "../../src/server/backends/pi/native/driver/driver.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import type { AttachConversationInput, ConversationHandle, SubmitTurnInput } from "../../src/server/backends/contracts.js";
import { PiNativeAgentToolService } from "../../src/server/backends/pi/native/agent-tools.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { agentContextToolDefinition } from "../../src/server/agent-tools/tools/agent-context-tool.js";
import type { BackendAgentToolFacade, BackendAgentToolInvocationInput } from "../../src/server/agent-tools/adapters/backend-facade.js";
import type { SedesToolInvocationResult } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { bundledSidecar } from "./bundled-sidecar.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { const errors: unknown[] = []; for (const action of cleanup.splice(0).reverse()) { try { await action(); } catch (error) { errors.push(error); } } if (errors.length) throw errors[0]; });
const scope = { tenantId: "offline-test", principalId: "offline-test" };
function operationStore(): PiNativeOperations {
  const records = new Map<string, ReturnType<PiNativeOperations["prepareOperation"]>>();
  return {
    prepareOperation(_scope, thread, input) { const key = `${thread}:${input.operationId}`; const prior = records.get(key); if (prior && prior.requestHash !== input.requestHash) throw new Error("operation_replay_mismatch"); const next = prior ?? { requestHash: input.requestHash, state: "prepared", prepareAttempt: 0, dispatchStarted: false, receiptJson: null }; records.set(key, next); return next; },
    getOperation(_scope, thread, id) { return records.get(`${thread}:${id}`); },
    completeOperation(_scope, thread, id, input) { const key = `${thread}:${id}`; const prior = records.get(key); if (!prior) throw new Error("operation_missing"); const next = { ...prior, ...input }; records.set(key, next); return next; },
    markSubmissionDispatched(_scope, thread, id, requestHash, prepareAttempt) { const key = `${thread}:${id}`; const prior = records.get(key);
      if (!prior || prior.state !== "sent" || prior.requestHash !== requestHash || prior.prepareAttempt !== prepareAttempt || prior.receiptJson !== null) throw new Error("operation_not_dispatchable");
      const next = { ...prior, dispatchStarted: true }; records.set(key, next); return next; },
    resetUnsentOperation(_scope, thread, id, requestHash, prepareAttempt) { const key = `${thread}:${id}`; const prior = records.get(key);
      if (!prior || prior.state !== "sent" || prior.dispatchStarted || prior.requestHash !== requestHash || prior.prepareAttempt !== prepareAttempt || prior.receiptJson !== null) throw new Error("operation_not_resettable");
      const next = { ...prior, state: "prepared" as const, prepareAttempt: prior.prepareAttempt + 1 }; records.set(key, next); return next; },
  };
}
const submission = (text: string, id = randomUUID()): SubmitTurnInput => ({ applicationOperationId: id, mutationId: `${id}:mutation`, reconciliationToken: `${id}:token`, source: { kind: "user" }, text, contextExcerpts: [], taskContexts: [], attachments: [] });

async function fixture(options: { mcp?: boolean; agentTools?: PiNativeAgentToolService; bundled?: boolean } = {}) {
  const executablePath = process.env.SEDES_REAL_PI_NATIVE_EXECUTABLE;
  if (!executablePath || !path.isAbsolute(executablePath)) throw new Error("Set SEDES_REAL_PI_NATIVE_EXECUTABLE to an isolated stock Pi 1.4.0 executable. This suite never uses PATH discovery.");
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-pi-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const agentDirectory = path.join(directory, "agent");
  const sessionDirectory = path.join(directory, "sessions");
  const workspacePath = path.join(directory, "workspace");
  await Promise.all([mkdir(agentDirectory), mkdir(sessionDirectory), mkdir(workspacePath)]);
  await mkdir(path.join(agentDirectory, "skills", "sample"), { recursive: true });
  await writeFile(path.join(agentDirectory, "skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: Offline native skill\n---\nRead fixture.txt using codemode.");
  await writeFile(path.join(workspacePath, "fixture.txt"), "native-offline-code-result");
  const mcpLog = path.join(directory, "mcp-calls.jsonl");
  await writeFile(mcpLog, "");
  if (options.mcp) {
    const mcpScript = path.join(directory, "mcp.mjs");
    await writeFile(mcpScript, `import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "offline-fixture", version: "1" } };
  else if (message.method === "tools/list") result = { tools: [{ name: "echo", description: "Offline echo fixture", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, annotations: { readOnlyHint: true } }] };
  else if (message.method === "tools/call") {
    appendFileSync(${JSON.stringify(mcpLog)}, JSON.stringify(message.params) + "\\n");
    result = { content: [{ type: "text", text: "native-mcp:" + message.params.arguments.value }] };
  } else if (message.method === "ping") result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }) + "\\n"); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`);
    await writeFile(path.join(agentDirectory, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [mcpScript], exposure: "direct" } } }));
  }
  const requests: Record<string, unknown>[] = [];
  const hanging = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const lastUser = body.messages.findLast((message: { role: string }) => message.role === "user");
    const user = JSON.stringify(lastUser?.content);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture" };
    const send = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (user.includes("hang-until-stop")) {
      send({ role: "assistant", content: "waiting" }, null); hanging.add(response); response.on("close", () => hanging.delete(response)); return;
    }
    const tool = user.includes("inspect-bootstrap") ? { name: "read", arguments: { path: "/proc/self/environ" } }
      : user.includes("mcp-code") ? { name: "codemode", arguments: { code: 'text(await tools.mcp__fixture__echo({value:"code"}));' } }
      : user.includes("mcp-direct") ? { name: "mcp__fixture__echo", arguments: { value: "direct" } }
      : user.includes("write-code") ? { name: "codemode", arguments: { code: 'text(await tools.write({path:"denied.txt",content:"unauthorized"}));' } }
      : user.includes("agent-code") ? { name: "codemode", arguments: { code: 'text(await tools.sedes_agent_context({}));' } }
      : user.includes("agent-direct") ? { name: "sedes_agent_context", arguments: {} }
      : user.includes("skill") ? { name: "codemode", arguments: { code: 'text(await tools.read({path:"fixture.txt"}));' } } : undefined;
    if (tool && body.messages.at(-1)?.role === "user") {
      send({ role: "assistant", tool_calls: [{ index: 0, id: `outer-${requests.length}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, null);
      send({}, "tool_calls");
    } else { send({ role: "assistant", content: "offline completed" }, null); send({}, "stop"); }
    response.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { for (const response of hanging) response.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address missing");
  await writeFile(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "offline-fixture-only", models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 4096 }] } } }));
  // Only these deliberate values enter the child. No operator auth state,
  // ambient cloud credentials, proxy, or provider environment is inherited.
  const environment = { PATH: process.env.PATH, HOME: directory };
  const channels = new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: "local-test", environment });
  cleanup.push(async () => channels.close());
  const runtime = { ...scope, backendInstanceId: "pi-native-test", executionEnvironmentId: "local-test", executablePath, agentDirectory, sessionDirectory, initializationTimeoutMs: 20_000, projectTrusted: false };
  const remote = options.bundled ? await bundledSidecar(runtime, environment) : undefined;
  if (remote) cleanup.push(() => remote.close());
  const authenticationKey = randomBytes(32);
  const host = remote?.port ?? new PiNativeHost({ configuration: runtime, channels, environment, authenticationKey, observationWaitMs: 10 });
  cleanup.push(() => host.close());
  const instance = { id: "pi-native-test", tenantId: scope.tenantId, kind: "pi_native" as const, label: "Pi", enabled: true, configurationRevision: 1, protocolRelease: "1.4.0" };
  const connection = { id: "connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "template", kind: "pi_rpc" as const, backendInstanceId: instance.id, executionEnvironmentId: "local-test", label: "Pi", enabled: true, configurationRevision: 1 };
  const settings = { modelProvider: "fixture", modelId: "fixture", thinkingLevel: "off", toolMode: "read_only" as "read_only" | "ask" | "full", revision: 0 };
  const driver = new PiNativeConversationDriver({ instance, connection, port: host, operations: operationStore(), usage: NO_USAGE_SINK, settings: { getSettings: () => settings }, modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "provider_model_effort"), ...(options.agentTools ? { agentTools: options.agentTools } : {}) });
  cleanup.push(() => driver.close());
  const workspace = { canonicalPath: workspacePath, authorityRevision: 0, summary: { id: "workspace", environmentId: "local-test", displayName: "Offline", displayPath: workspacePath, availability: "available" as const, trustState: "untrusted" as const, revision: 0 } };
  const created = await driver.create({ scope, applicationThreadId: "thread", applicationOperationId: randomUUID(), source: { kind: "user" }, workspace, requestedBackendConversationId: randomUUID() });
  const input: AttachConversationInput = { scope, workspace, binding: { tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId: "thread", backendConversationId: created.backendConversationId, backendInstanceId: instance.id, connectionProfileId: connection.id, executionEnvironmentId: "local-test", createdAt: new Date().toISOString() }, opaqueBindingDetail: created.opaqueBindingDetail };
  return { directory, host, driver, input, requests, hanging, mcpLog, remote, settings, authenticationKey };
}

async function completed(handle: ConversationHandle, text: string) {
  const receipt = await handle.submit(submission(text)).catch((error) => { throw new Error(`${text} submission failed: ${error.backendCode ?? error.message}`, { cause: error }); });
  await vi.waitFor(async () => expect((await handle.history({ limit: 50 })).turnsById[receipt.backendTurnId!]?.status).toBe("completed"), { timeout: 15_000, interval: 25 });
  return receipt;
}

it("runs stock RPC through the owned host and normalized driver, including native skill, code mode, Stop, resume, and detached fork history", async () => {
  const f = await fixture();
  let handle = await f.driver.attach(f.input);
  const first = await handle.submit(submission("/skill:sample execute"));
  await vi.waitFor(async () => { const history = await handle.history({ limit: 50 }); expect(history.turnsById[first.backendTurnId!]?.status).toBe("completed"); }, { timeout: 15_000, interval: 25 });
  const native = parsePiNativeBindingDetail(f.input.opaqueBindingDetail);
  const disk = await f.host.readHistory(native);
  expect(disk.operations.some(operation => operation.phase === "accepted" && operation.userEntryId === first.backendTurnId)).toBe(true);
  expect(disk.toolCalls.some(call => call.managed === "codemode")).toBe(true);
  expect(disk.toolCalls.some(call => call.toolName === "read" && call.parentToolCallId)).toBe(true);
  expect(JSON.stringify(disk.toolResults)).toContain("native-offline-code-result");
  expect(JSON.stringify(f.requests[0])).toContain("<skill name=");
  expect(JSON.stringify(await handle.history({ limit: 50 }))).toContain("native-offline-code-result");
  const firstHistory = await handle.history({ limit: 50 });
  expect(firstHistory.turnsById[first.backendTurnId!]?.throughput).toMatchObject({ outputTokens: 10 });
  expect(firstHistory.turnsById[first.backendTurnId!]?.throughput?.requestDurationMs).toBeGreaterThan(0);

  const active = await handle.submit(submission("hang-until-stop"));
  await vi.waitFor(() => expect(f.hanging.size).toBe(1), { timeout: 5_000, interval: 25 });
  const { source: _source, ...steer } = submission("queued same text");
  await handle.steer({ ...steer, target: { kind: "turn", turnId: active.backendTurnId! } });
  await handle.interrupt({ applicationOperationId: randomUUID(), deadlineAt: Date.now() + 10_000 });
  await vi.waitFor(() => expect(f.hanging.size).toBe(0));
  expect((await f.host.readHistory(native)).operations.some(operation => operation.input.operationId === steer.applicationOperationId && operation.phase === "lost")).toBe(true);

  await handle.close();
  handle = await f.driver.attach(f.input);
  const resumed = await handle.submit(submission("resume with another answer"));
  await vi.waitFor(async () => expect((await handle.history({ limit: 50 })).turnsById[resumed.backendTurnId!]?.status).toBe("completed"), { timeout: 10_000, interval: 25 });
  const inheritedSettings = (await handle.backendCapabilities()).effectiveSettings;
  await handle.close();
  const detached = await f.driver.openHistory(f.input);
  expect((await detached.history({ limit: 50 })).orderedBackendTurnIds).toContain(first.backendTurnId);
  await detached.close();
  const checkpoint = await f.driver.resolveBranchCheckpoint({ ...f.input, selection: { kind: "selected_completed_turn", backendTurnId: first.backendTurnId!, boundary: "completed_turn_inclusive" } });
  const child = await f.driver.branchConversation({ scope, workspace: f.input.workspace, sourceBinding: f.input.binding, sourceOpaqueBindingDetail: f.input.opaqueBindingDetail, sourceCheckpoint: checkpoint, requestedBackendConversationId: randomUUID(), applicationOperationId: randomUUID(), childApplicationThreadId: "child", source: { kind: "user" }, inheritedSettings });
  const childHistory = await f.host.readHistory(parsePiNativeBindingDetail(child.opaqueBindingDetail));
  expect(childHistory.toolCalls.some(call => call.toolName === "read")).toBe(true);
  expect(JSON.stringify(childHistory.entries)).toContain("native-offline-code-result");
  expect(JSON.stringify(childHistory.entries)).not.toContain("hang-until-stop");
  expect(await readFile(native.sessionFile, "utf8")).toContain("sedes.native.input.v1");
});

it.runIf(process.platform === "linux")("keeps managed secrets outside the initial native environment visible to read-only tools", async () => {
  const f = await fixture();
  const extensions = path.join(f.directory, "agent", "extensions");
  const canary = path.join(f.directory, "unmanaged-extension-ran");
  await mkdir(extensions);
  await writeFile(path.join(extensions, "unmanaged.ts"), `import { writeFileSync } from "node:fs"; export default () => writeFileSync(${JSON.stringify(canary)}, "loaded");`);
  const handle = await f.driver.attach(f.input);
  await completed(handle, "inspect-bootstrap");
  const native = await f.host.readHistory(parsePiNativeBindingDetail(f.input.opaqueBindingDetail));
  const call = native.toolCalls.find(call => call.toolName === "read" && call.arguments?.path === "/proc/self/environ");
  expect(call).toBeDefined();
  const result = native.toolResults.find(result => result.toolCallId === call!.toolCallId);
  expect(result?.isError).toBe(false);
  const text = result!.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  expect(text).not.toContain("SEDES_PI_AUTHENTICATION_KEY");
  expect(text).not.toContain("SEDES_PI_BRIDGE_TOKEN");
  expect(text).not.toContain(f.authenticationKey.toString("base64url"));
  expect(JSON.stringify(native.entries)).not.toContain(f.authenticationKey.toString("base64url"));
  const bootstrapPath = text.match(/SEDES_PI_BOOTSTRAP_FILE=([^\0\n]+)/)?.[1];
  expect(bootstrapPath).toBeDefined();
  await expect(readFile(bootstrapPath!)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(canary)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports native live context occupancy independently of cumulative usage across compaction", async () => {
  const f = await fixture();
  await writeFile(path.join(f.directory, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
  const handle = await f.driver.attach(f.input);
  expect((await handle.backendCapabilities()).usageSections).toEqual(["context", "counters"]);
  await completed(handle, "first plain answer");
  await completed(handle, "second plain answer");
  expect((await handle.usage()).context).toEqual({ windowTokens: 200_000, usedTokens: 15, percent: 15 / 200_000 * 100 });
  await handle.perform({ action: "compact", applicationOperationId: randomUUID() });
  expect((await handle.usage()).context).toEqual({ windowTokens: 200_000 });
  expect((await handle.usage()).counters?.compactions).toBe(1);
  await completed(handle, "first answer after compaction");
  expect((await handle.usage()).context).toEqual({ windowTokens: 200_000, usedTokens: 15, percent: 15 / 200_000 * 100 });
  await handle.close();
  const detached = await f.driver.openHistory(f.input);
  expect((await detached.backendCapabilities()).usageSections).toEqual(["counters"]);
  expect((await detached.usage()).context).toBeUndefined();
  await detached.close();
});

it("enforces code-mode nested tool policy and native MCP approval before any MCP call", async () => {
  const f = await fixture({ mcp: true });
  const handle = await f.driver.attach(f.input);
  await completed(handle, "write-code");
  await expect(readFile(path.join(f.input.workspace.canonicalPath, "denied.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await completed(handle, "mcp-code");
  expect(await readFile(f.mcpLog, "utf8")).toBe("");
  const deniedHistory = await handle.history({ limit: 50 });
  expect(Object.values(deniedHistory.itemsById).filter(item => item.semanticKind === "tool").every(item => item.status === "failed")).toBe(true);

  await handle.perform({ action: "set_tool_access", mode: "ask", applicationOperationId: randomUUID() });
  f.settings.toolMode = "ask"; f.settings.revision++;
  let interactionId: string | undefined;
  const unsubscribe = handle.subscribe(event => { if (event.type === "interaction_opened") interactionId = event.interaction.backendInteractionId; });
  const approved = await handle.submit(submission("mcp-code approved")).catch((error) => { throw new Error(`Ask submission failed: ${error.backendCode ?? error.message}`, { cause: error }); });
  await vi.waitFor(() => expect(interactionId).toBeDefined(), { timeout: 10_000, interval: 25 }).catch(async error => { throw new Error(`Expected MCP approval: ${JSON.stringify(await handle.history({ limit: 1 }))}`, { cause: error }); });
  expect(await readFile(f.mcpLog, "utf8")).toBe("");
  await handle.respond({ kind: "decision", interactionId: interactionId!, selectedActionId: "approve", applicationOperationId: randomUUID() });
  await vi.waitFor(async () => expect((await handle.history({ limit: 50 })).turnsById[approved.backendTurnId!]?.status).toBe("completed"), { timeout: 15_000, interval: 25 });
  unsubscribe();
  const calls = (await readFile(f.mcpLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls).toMatchObject([{ name: "echo", arguments: { value: "code" } }]);
  const native = await f.host.readHistory(parsePiNativeBindingDetail(f.input.opaqueBindingDetail));
  expect(native.toolCalls.some(call => call.managed === "mcp" && call.parentToolCallId)).toBe(true);
  expect(JSON.stringify(native.toolResults)).toContain("native-mcp:code");

  await handle.perform({ action: "set_tool_access", mode: "full", applicationOperationId: randomUUID() });
  f.settings.toolMode = "full"; f.settings.revision++;
  await completed(handle, "mcp-direct");
  expect((await readFile(f.mcpLog, "utf8")).trim().split("\n")).toHaveLength(2);
});

it("runs native Sedes tools directly and through code mode with thread scope and durable invocation identity", async () => {
  const registry = new AgentToolRegistry(); registry.register(agentContextToolDefinition);
  const artifact = registry.artifact(agentContextToolDefinition.id, agentContextToolDefinition.schemaVersion);
  const invoke = vi.fn(async (_input: BackendAgentToolInvocationInput): Promise<SedesToolInvocationResult<unknown>> => ({ invocationId: `invocation-${invoke.mock.calls.length}`, state: "completed", output: { nativeAgentResult: "scoped-result" } }));
  const facade: BackendAgentToolFacade = {
    eligibleCatalog: () => [artifact],
    readPolicy: () => ({ enabled: true, presentation: { surface: "native", mode: "individual" }, enabledToolIds: [artifact.id], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } }),
    catalogSummaries: () => [],
    describeMany: () => [{ id: artifact.id, schemaVersion: artifact.schemaVersion, label: artifact.adapters.pi!.label, description: artifact.description,
      inputSchema: artifact.inputSchema, outputSchema: artifact.outputSchema, effects: artifact.effects,
      execution: { form: artifact.execution.form, waitCeilingMilliseconds: 30_000, supportsCancellation: artifact.execution.supportsCancellation,
        idempotency: artifact.execution.idempotency, progress: artifact.execution.progress, maximumInputBytes: artifact.execution.maximumInputBytes,
        maximumOutputBytes: artifact.execution.maximumOutputBytes, uncertainExternalOutcome: artifact.execution.uncertainExternalOutcome } }],
    invoke: invoke as BackendAgentToolFacade["invoke"],
  };
  const agentTools = new PiNativeAgentToolService({ facade, cli: { availability: "unavailable", reason: "cli_unavailable" }, remote: false, sourceCapabilities: { issue: () => { throw new Error("CLI not requested"); } } });
  const f = await fixture({ agentTools });
  const handle = await f.driver.attach(f.input);
  await completed(handle, "agent-code");
  await completed(handle, "agent-direct");
  expect(invoke).toHaveBeenCalledTimes(2);
  invoke.mockResolvedValueOnce({ invocationId: "failed-invocation", state: "failed", error: { code: "internal_error", message: "offline tool failed", retryable: false } });
  await completed(handle, "agent-direct failure");
  expect(invoke).toHaveBeenCalledTimes(3);
  for (const [input] of invoke.mock.calls) expect(input).toMatchObject({ source: { scope, sourceThreadId: "thread", backendKind: "pi_native" }, adapter: "pi_rpc" });
  const native = await f.host.readHistory(parsePiNativeBindingDetail(f.input.opaqueBindingDetail));
  expect(native.toolCalls.filter(call => call.managed === "agent")).toHaveLength(3);
  expect(native.toolCalls.some(call => call.managed === "agent" && call.parentToolCallId)).toBe(true);
  expect(JSON.stringify(native.toolResults)).toContain("agentToolInvocation");
  expect(native.toolResults.some(result => result.isError && JSON.stringify(result.details).includes("failed-invocation"))).toBe(true);
  expect(JSON.stringify(await handle.history({ limit: 50 }))).toContain("invocation-2");
});

it.skipIf(process.platform === "win32")("runs the release sidecar bundle and preserves the native owner through framed-carrier replacement", async () => {
  const f = await fixture({ bundled: true });
  let handle = await f.driver.attach(f.input);
  await completed(handle, "/skill:sample bundled");
  await handle.submit(submission("hang-until-stop bundled"));
  await vi.waitFor(() => expect(f.hanging.size).toBe(1), { timeout: 10_000, interval: 25 });
  const before = await f.host.inspect();
  const service = await f.remote!.status();
  await handle.close();
  await f.remote!.reconnect();
  expect((await f.remote!.status()).serviceIncarnation).toBe(service.serviceIncarnation);
  handle = await f.driver.attach(f.input);
  const after = await f.host.inspect();
  expect(after.retainedSessions[0]?.handleId).toBe(before.retainedSessions[0]?.handleId);
  expect(after.retainedSessions[0]?.generation).toBe(before.retainedSessions[0]?.generation);
  await handle.interrupt({ applicationOperationId: randomUUID(), deadlineAt: Date.now() + 10_000 });
  await completed(handle, "completed after carrier replacement");
  expect(JSON.stringify(await handle.history({ limit: 50 }))).toContain("native-offline-code-result");
}, 60_000);
