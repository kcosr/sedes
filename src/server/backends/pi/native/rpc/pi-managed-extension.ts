import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import type { PiManagedCommand, PiManagedContextUsage, PiManagedOperation, PiManagedPolicy } from "./pi-managed-protocol.js";

// Deliberately structural public-hook types: the installed CLI owns its types
// and runtime. No embedded SDK module is loaded by this companion.
type NativeRecord = Record<string, any>;
interface PublicPiContext {
  mode: string;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined; getEntries(): NativeRecord[]; getBranch(): NativeRecord[]; getLeafId(): string | null };
  model?: NativeRecord;
  thinkingLevel?: string;
  isIdle(): boolean;
  getContextUsage(): PiManagedContextUsage | undefined;
  abort(): void;
  shutdown(): void;
  signal?: AbortSignal;
}
interface PublicPiAPI {
  on(name: string, handler: (event: NativeRecord, context: PublicPiContext) => unknown): unknown;
  appendEntry(type: string, data: unknown): void;
  getAllTools(): NativeRecord[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  registerTool(tool: NativeRecord): void;
}

/** This function is serialized after compilation. Keep all runtime dependencies
 * and helpers inside it so the companion is independent of Sedes' installation. */
export async function piManagedExtension(pi: PublicPiAPI,
  createCodemodeExtension: (options: { models: boolean }) => (api: PublicPiAPI) => unknown,
  createMcpExtension: () => (api: PublicPiAPI) => unknown,
  createToolSearchExtension: () => (api: PublicPiAPI) => unknown,
  runtime: { net: typeof import("node:net"); crypto: typeof import("node:crypto"); fs: typeof import("node:fs") }): Promise<void> {
  const { createConnection } = runtime.net;
  const { createHmac, randomUUID, timingSafeEqual } = runtime.crypto;
  const fs = runtime.fs;
  const bootstrapPath = process.env.SEDES_PI_BOOTSTRAP_FILE;
  delete process.env.SEDES_PI_BOOTSTRAP_FILE;
  const maximum = 128 * 1024 * 1024;
  const marker = "sedes.native.input.v1";
  if (!bootstrapPath || !bootstrapPath.startsWith("/") || bootstrapPath.includes("\0")) throw new Error("pi_managed_launch_missing");
  // This synchronous bootstrap precedes our first await and every native
  // extension factory. Only its pathname survives in the initial environment.
  const directory = fs.lstatSync(bootstrapPath.slice(0, bootstrapPath.lastIndexOf("/")));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) throw new Error("pi_managed_bootstrap_directory_invalid");
  const descriptor = fs.openSync(bootstrapPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bootstrapText: string;
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 4096 || (before.mode & 0o077) !== 0 || before.uid !== directory.uid) throw new Error("pi_managed_bootstrap_invalid");
    const bytes = Buffer.alloc(4097);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count !== before.size) throw new Error("pi_managed_bootstrap_changed");
    bootstrapText = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
    bytes.fill(0);
    const after = fs.lstatSync(bootstrapPath);
    if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("pi_managed_bootstrap_changed");
    fs.unlinkSync(bootstrapPath);
  } finally { fs.closeSync(descriptor); }
  const bootstrap = JSON.parse(bootstrapText) as { version?: unknown; socketPath?: unknown; token?: unknown };
  if (!bootstrap || Object.keys(bootstrap).length !== 3 || bootstrap.version !== 2 || typeof bootstrap.socketPath !== "string" ||
      !bootstrap.socketPath.startsWith("/") || Buffer.byteLength(bootstrap.socketPath) > 103 || typeof bootstrap.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(bootstrap.token)) throw new Error("pi_managed_bootstrap_invalid");
  const { socketPath, token } = bootstrap;
  let key = Buffer.alloc(0);
  let resolveInitialization!: () => void;
  let rejectInitialization!: (error: Error) => void;
  const initialized = new Promise<void>((resolve, reject) => { resolveInitialization = resolve; rejectInitialization = reject; });
  void initialized.catch(() => undefined);
  let context: PublicPiContext | undefined;
  let stopping = false;
  let failed = false;
  let policy: PiManagedPolicy | undefined;
  let admitting: string | undefined;
  const operations = new Map<string, PiManagedOperation>();
  const prepared = new Map<string, string>();
  const acceptedInputs: string[] = [];
  const materializing = new Map<object, string>();
  const approvals = new Map<string, (approved: boolean) => void>();
  const agentTools = new Map<string, { readOnly: boolean; active: boolean }>();
  const mcpTools = new Set<string>();
  const agentCalls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const callParents = new Map<string, string>();
  const toolCalls = new Map<string, NativeRecord>();
  const toolResults = new Map<string, NativeRecord>();
  const activeCalls = new Map<string, NativeRecord>();
  let instructions = "";
  const socket = createConnection(socketPath);
  socket.once("connect", () => write({ type: "hello", version: 2, token }));

  function stable(value: any): any {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)]));
    return value;
  }
  function sign(operation: PiManagedOperation): string {
    return createHmac("sha256", key).update(JSON.stringify(stable([marker, context!.sessionManager.getSessionId(), operation]))).digest("base64url");
  }
  function write(value: unknown): void {
    if (socket.destroyed) return;
    const line = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(line) > maximum || socket.writableLength + Buffer.byteLength(line) > maximum) { fail("pi_managed_outbound_limit"); return; }
    socket.write(line);
  }
  function event(value: unknown): void { write({ type: "event", event: value }); }
  function fail(code: string): void {
    if (failed) return;
    failed = true; stopping = true;
    rejectInitialization(new Error(code));
    for (const resolve of approvals.values()) resolve(false);
    approvals.clear();
    for (const call of agentCalls.values()) call.reject(new Error("pi_managed_controller_closed"));
    context?.abort();
    socket.destroy();
    // Loss of the authenticated controller must stop this owned process.
    context?.shutdown();
  }
  function persist(operation: PiManagedOperation): void {
    pi.appendEntry(marker, { version: 1, operation, authentication: sign(operation) });
    operations.set(operation.input.operationId, operation);
    event({ type: "operation_changed", operation });
  }
  function flush(): void {
    if (!context || !materializing.size) return;
    for (const entry of context.sessionManager.getEntries()) {
      if (entry.type !== "message") continue;
      const operationId = materializing.get(entry.message);
      if (!operationId) continue;
      const operation = operations.get(operationId)!;
      materializing.delete(entry.message);
      persist({ ...operation, phase: "accepted", userEntryId: entry.id,
        targetTurnId: operation.input.targetTurnId ?? entry.id });
      // Persisted native identity proves input normalization and FIFO binding
      // finished, even if the controller lost the dispatch response.
      if (admitting === operationId) admitting = undefined;
    }
  }
  function snapshot(): unknown {
    if (!context) throw new Error("pi_managed_not_ready");
    flush();
    const model = context.model;
    const contextUsage = context.getContextUsage();
    return {
      sessionId: context.sessionManager.getSessionId(), sessionFile: context.sessionManager.getSessionFile(),
      entries: context.sessionManager.getEntries(), leafId: context.sessionManager.getLeafId(),
      operations: [...operations.values()],
      toolCalls: [...toolCalls.values()], toolResults: [...toolResults.values()],
      tools: pi.getAllTools().map(({ name, description, parameters, sourceInfo, exposure }) => ({ name, description, parameters, sourceInfo, exposure,
        ...(name === "codemode" ? { managed: "codemode" } : name === "tool_search" ? { managed: "tool_search" } : mcpTools.has(name) ? { managed: "mcp" } : agentTools.get(name)?.active ? { managed: "agent" } : {}) })),
      activeTools: pi.getActiveTools(), isIdle: context.isIdle(),
      ...(model ? { model: { provider: model.provider, id: model.id, input: model.input } } : {}),
      thinkingLevel: context.thinkingLevel,
      ...(contextUsage ? { contextUsage } : {}),
    };
  }
  function builtin(toolName: string): boolean {
    const tool = pi.getAllTools().find((tool) => tool.name === toolName);
    return tool?.sourceInfo?.source === "builtin" && tool?.sourceInfo?.path === `builtin:${toolName}`;
  }
  function safeTool(toolName: string): boolean { return ["read", "grep", "find", "ls"].includes(toolName) && builtin(toolName); }
  function admittedTool(name: string): boolean { return name === "codemode" || name === "tool_search" || mcpTools.has(name) || builtin(name) || agentTools.get(name)?.active === true; }
  function readOnlyTool(name: string): boolean { return name === "codemode" || name === "tool_search" || safeTool(name) || (agentTools.get(name)?.active === true && agentTools.get(name)?.readOnly === true); }
  function callIdentity(toolCallId: string): { assistantEntryId: string; userEntryId: string; parentToolCallId?: string } {
    let root = toolCallId;
    const seen = new Set<string>();
    while (callParents.has(root)) {
      if (seen.has(root)) throw new Error("pi_managed_call_cycle");
      seen.add(root); root = callParents.get(root)!;
    }
    const branch = context!.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index]!;
      if (entry.type !== "message" || entry.message.role !== "assistant" || !entry.message.content.some((part: NativeRecord) => part.type === "toolCall" && part.id === root)) continue;
      for (let previous = index - 1; previous >= 0; previous--) {
        const user = branch[previous]!;
        if (user.type === "message" && user.message.role === "user") return { assistantEntryId: entry.id, userEntryId: user.id,
          ...(callParents.has(toolCallId) ? { parentToolCallId: callParents.get(toolCallId)! } : {}) };
      }
    }
    throw new Error("pi_managed_call_identity_unavailable");
  }
  function attestTool(call: NativeRecord): void {
    const identity = callIdentity(call.toolCallId);
    const tool = pi.getAllTools().find((tool) => tool.name === call.toolName);
    if (!tool?.sourceInfo) throw new Error("pi_managed_tool_source_missing");
    const { source, path, scope, origin } = tool.sourceInfo;
    const nativeCall = { ...identity, toolCallId: call.toolCallId, toolName: call.toolName,
      sourceInfo: { source, path, ...(scope ? { scope } : {}), ...(origin ? { origin } : {}) }, arguments: call.input,
      ...(call.toolName === "codemode" ? { managed: "codemode" } : call.toolName === "tool_search" ? { managed: "tool_search" } : mcpTools.has(call.toolName) ? { managed: "mcp" } : agentTools.get(call.toolName)?.active ? { managed: "agent" } : {}) };
    const marker = "sedes.native.tool.v1";
    const authentication = createHmac("sha256", key).update(JSON.stringify(stable([marker, context!.sessionManager.getSessionId(), nativeCall]))).digest("base64url");
    pi.appendEntry(marker, { version: 1, call: nativeCall, authentication });
    toolCalls.set(`${identity.assistantEntryId}\0${call.toolCallId}`, nativeCall);
    activeCalls.set(call.toolCallId, nativeCall);
  }
  function enforceModel(): void {
    if (!policy) throw new Error("pi_managed_policy_missing");
    if (policy.allowedModels && !policy.allowedModels.some(({ provider, modelId, thinkingLevels }) => provider === context?.model?.provider && modelId === context?.model?.id && (!thinkingLevels || thinkingLevels.includes(context?.thinkingLevel ?? "off")))) throw new Error("pi_managed_model_denied");
  }
  async function command(command: PiManagedCommand): Promise<unknown> {
    if (!context || failed) throw new Error("pi_managed_not_ready");
    flush();
    switch (command.type) {
      case "snapshot": return snapshot();
      case "get_submission": return operations.get(command.operationId) ?? null;
      case "set_policy": policy = command.policy; return {};
      case "set_active_tools": {
        if (!policy || command.names.some((name) => !admittedTool(name) || (policy!.mode === "read_only" && !readOnlyTool(name)))) throw new Error("pi_managed_tool_denied");
        pi.setActiveTools(command.names); return {};
      }
      case "prepare_submission": {
        enforceModel();
        if (stopping || admitting || prepared.size + acceptedInputs.length + materializing.size >= 128) throw new Error("pi_managed_admission_closed");
        const old = operations.get(command.input.operationId);
        if (old) throw new Error("pi_managed_operation_exists");
        const wireText = `sedes-input:${randomUUID()}`;
        const operation: PiManagedOperation = { input: command.input, phase: "intent" };
        persist(operation); prepared.set(wireText, command.input.operationId); admitting = command.input.operationId;
        return { wireText, operation };
      }
      case "complete_submission": {
        const old = operations.get(command.operationId);
        if (!old) throw new Error("pi_managed_operation_unknown");
        if (admitting === command.operationId) admitting = undefined;
        if (["accepted", "lost", "rejected"].includes(old.phase)) return old;
        const rejected = command.disposition === "handled" || command.disposition === "rejected";
        if (rejected) {
          for (const [wire, operationId] of prepared) if (operationId === command.operationId) prepared.delete(wire);
          const index = acceptedInputs.indexOf(command.operationId);
          if (index >= 0) acceptedInputs.splice(index, 1);
        }
        const operation: PiManagedOperation = { ...old, phase: rejected ? "rejected" : "enqueued" };
        persist(operation); return operation;
      }
      case "begin_stop": {
        stopping = true;
        for (const resolve of approvals.values()) resolve(false);
        for (const [id, call] of agentCalls) { event({ type: "agent_tool_cancelled", id }); call.reject(new Error("pi_managed_stopped")); }
        return { ok: true };
      }
      case "end_stop": {
        if (!context.isIdle()) throw new Error("pi_managed_stop_not_idle");
        flush();
        if (materializing.size) throw new Error("pi_managed_acceptance_unresolved");
        for (const operationId of [...prepared.values(), ...acceptedInputs]) {
          const operation = operations.get(operationId)!;
          if (operation.phase === "intent" || operation.phase === "enqueued") persist({ ...operation, phase: "lost" });
        }
        prepared.clear(); acceptedInputs.length = 0; admitting = undefined; stopping = false;
        return { ok: true };
      }
      case "resolve_tool_approval": {
        const resolve = approvals.get(command.id);
        if (!resolve) throw new Error("pi_managed_approval_unknown");
        resolve(command.approved); return {};
      }
      case "configure_agent_tools": {
        if (!context.isIdle() || agentCalls.size) throw new Error("pi_managed_tools_busy");
        const names = new Set(command.tools.map((tool) => tool.name));
        if (names.size !== command.tools.length || command.tools.some((tool) => ["codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(tool.name) || tool.name.startsWith("mcp__") || builtin(tool.name))) throw new Error("pi_managed_tool_name_conflict");
        for (const state of agentTools.values()) state.active = false;
        instructions = command.instructions ?? "";
        for (const tool of command.tools) {
          agentTools.set(tool.name, { readOnly: tool.readOnly, active: true });
          pi.registerTool({ name: tool.name, label: tool.label ?? tool.name, description: tool.description,
            parameters: tool.parameters, defaultActive: false,
            async execute(toolCallId: string, args: unknown, signal?: AbortSignal) {
              if (!agentTools.get(tool.name)?.active || failed || stopping || agentCalls.size >= 128) throw new Error("pi_managed_agent_tool_unavailable");
              const identity = callIdentity(toolCallId);
              const id = randomUUID();
              return await new Promise((resolve, reject) => {
                const cleanup = () => { agentCalls.delete(id); signal?.removeEventListener("abort", abort); };
                const abort = () => { cleanup(); event({ type: "agent_tool_cancelled", id }); reject(new Error("pi_managed_agent_tool_aborted")); };
                agentCalls.set(id, { resolve(value) { cleanup(); resolve(value); }, reject(error) { cleanup(); reject(error); } });
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted) abort(); else event({ type: "agent_tool_call", id, toolCallId, name: tool.name, arguments: args, ...identity });
              });
            },
          });
        }
        return {};
      }
      case "resolve_agent_tool": {
        const call = agentCalls.get(command.id);
        if (!call) throw new Error("pi_managed_agent_tool_unknown");
        // Native tool results support isError directly. Throwing would make
        // Pi replace the result and discard its durable invocation identity.
        call.resolve({ ...command.result, ...(command.isError ? { isError: true } : {}) });
        return {};
      }
    }
  }
  let buffered = Buffer.alloc(0);
  let chain = Promise.resolve();
  socket.on("data", (chunk: Buffer) => {
    if (buffered.length + chunk.length > maximum) { fail("pi_managed_inbound_limit"); return; }
    buffered = Buffer.concat([buffered, chunk]);
    let index: number;
    while ((index = buffered.indexOf(10)) >= 0) {
      const raw = buffered.subarray(0, index); buffered = buffered.subarray(index + 1);
      let request: { type: string; id: string; command: PiManagedCommand; version?: unknown; authenticationKey?: unknown };
      try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
      catch { fail("pi_managed_frame_invalid"); return; }
      if (!request || typeof request !== "object" || Array.isArray(request)) { fail("pi_managed_frame_invalid"); return; }
      if (!key.byteLength) {
        if (request.type !== "initialize" || request.version !== 2 || Object.keys(request).length !== 3 ||
            typeof request.authenticationKey !== "string" || request.authenticationKey.length > 5462 || !/^[A-Za-z0-9_-]+$/.test(request.authenticationKey)) { fail("pi_managed_initialization_invalid"); return; }
        key = Buffer.from(request.authenticationKey, "base64url");
        if (key.byteLength < 32 || key.toString("base64url") !== request.authenticationKey) { fail("pi_managed_key_invalid"); return; }
        request.authenticationKey = ""; raw.fill(0);
        resolveInitialization(); continue;
      }
      if (request.type !== "request" || typeof request.id !== "string" || !request.command) { fail("pi_managed_request_invalid"); return; }
      chain = chain.then(async () => {
        try { write({ type: "response", id: request.id, success: true, data: await command(request.command) }); }
        catch (error) { write({ type: "response", id: request.id, success: false, code: error instanceof Error ? error.message : "pi_managed_command_failed" }); }
      });
    }
  });
  socket.on("error", () => fail("pi_managed_socket_failed"));
  socket.on("close", () => fail("pi_managed_socket_closed"));
  await initialized;
  if (failed) throw new Error("pi_managed_initialization_failed");
  // These factories come from the running CLI's public extension module,
  // never from Sedes' embedded SDK. Their hooks run before the final gate.
  await createCodemodeExtension({ models: false })(pi);
  await createToolSearchExtension()(pi);
  await createMcpExtension()(new Proxy(pi, { get(target, property, receiver) {
    if (property !== "registerTool") return Reflect.get(target, property, receiver);
    return (tool: NativeRecord) => {
      mcpTools.add(tool.name); target.registerTool(tool);
      if (context && !failed) event({ type: "state_changed" });
    };
  } }));
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (ctx.mode !== "rpc") throw new Error("pi_managed_mode_invalid");
    const entries = ctx.sessionManager.getEntries();
    const known = new Map(entries.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      if (entry.type === "custom" && ["sedes.native.tool.v1", "sedes.native.tool-result.v1"].includes(entry.customType) && entry.data?.version === 1) {
        const payload = entry.customType === "sedes.native.tool.v1" ? entry.data.call : entry.data.result;
        if (!payload || typeof entry.data.authentication !== "string") continue;
        const expected = Buffer.from(createHmac("sha256", key).update(JSON.stringify(stable([entry.customType, ctx.sessionManager.getSessionId(), payload]))).digest("base64url"));
        const actual = Buffer.from(entry.data.authentication);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) continue;
        if (known.get(payload.assistantEntryId)?.message?.role !== "assistant" || known.get(payload.userEntryId)?.message?.role !== "user") continue;
        const id = `${payload.assistantEntryId}\0${payload.toolCallId}`;
        if (entry.customType === "sedes.native.tool.v1") toolCalls.set(id, payload);
        else if (toolCalls.has(id)) toolResults.set(id, payload);
        continue;
      }
      if (entry.type !== "custom" || entry.customType !== marker || entry.data?.version !== 1 || !entry.data.operation) continue;
      const operation = entry.data.operation as PiManagedOperation;
      if (operation.phase === "accepted" && known.get(operation.userEntryId)?.message?.role !== "user") continue;
      if (typeof entry.data.authentication !== "string") continue;
      const expected = Buffer.from(sign(operation)); const actual = Buffer.from(entry.data.authentication);
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) operations.set(operation.input.operationId, operation);
    }
    write({ type: "ready", state: snapshot() });
    // Keep the socket referenced while the CLI awaits this factory's private
    // key handshake. RPC has not started reading stdin during that bootstrap.
    socket.unref();
  });
  pi.on("input", (event, ctx) => {
    context = ctx;
    const operationId = prepared.get(event.text);
    if (failed || stopping || event.source !== "rpc" || !operationId) return { action: "handled" };
    enforceModel();
    prepared.delete(event.text); acceptedInputs.push(operationId);
    return { action: "transform", text: operations.get(operationId)!.input.text, images: event.images };
  });
  pi.on("before_agent_start", (event, ctx) => { context = ctx; return instructions ? { systemPrompt: `${event.systemPrompt}\n\n${instructions}` } : undefined; });
  pi.on("message_start", (event, ctx) => {
    context = ctx;
    if (event.message.role !== "user") return;
    const operationId = acceptedInputs.shift();
    if (!operationId) { fail("pi_managed_unowned_input"); return; }
    materializing.set(event.message, operationId);
  });
  // Pi catches thrown extension-hook errors and continues. On a policy breach
  // close the controller (which kills the owned process) and never release the
  // request hook, so no provider request can pass through that catch behavior.
  for (const name of ["context", "before_provider_request"]) pi.on(name, async (_event, ctx) => {
    context = ctx; flush();
    try { enforceModel(); } catch { fail("pi_managed_model_denied"); await new Promise<never>(() => {}); }
  });
  for (const name of ["message_end", "turn_end", "agent_settled", "entry_appended", "model_select", "thinking_level_select", "session_compact"]) {
    pi.on(name, (_event, ctx) => { context = ctx; setImmediate(() => { if (!failed) { flush(); event({ type: "state_changed" }); } }); });
  }
  for (const name of ["session_before_switch", "session_before_fork", "session_before_tree"]) pi.on(name, () => ({ cancel: true }));
  pi.on("user_bash", () => ({ result: { output: "Managed sessions do not permit direct shell commands.", exitCode: 1, cancelled: false, truncated: false } }));
  pi.on("tool_call", async (call, ctx) => {
    context = ctx;
    if (call.parentToolCallId) {
      if (callParents.size >= 16_384) return { block: true, reason: "Managed nested call limit reached." };
      callParents.set(call.toolCallId, call.parentToolCallId);
    }
    const deny = { block: true, reason: "Tool execution is not authorized by Sedes." };
    if (failed || stopping || !policy || !admittedTool(call.toolName)) return deny;
    try { attestTool(call); } catch { return { block: true, reason: "Tool call has no authoritative native history identity." }; }
    if (policy.mode === "read_only") return readOnlyTool(call.toolName) ? undefined : deny;
    if (policy.mode === "full" || readOnlyTool(call.toolName)) return;
    if (approvals.size >= 128) return deny;
    const id = randomUUID();
    const approved = await new Promise<boolean>((resolve) => {
      const abort = () => finish(false);
      const finish = (value: boolean) => { approvals.delete(id); ctx.signal?.removeEventListener("abort", abort); event({ type: "tool_approval_closed", id }); resolve(value); };
      approvals.set(id, finish); ctx.signal?.addEventListener("abort", abort, { once: true });
      event({ type: "tool_approval_requested", id, toolCallId: call.toolCallId, toolName: call.toolName, parameters: call.input });
      if (ctx.signal?.aborted) finish(false);
    });
    return approved && !failed && !stopping ? undefined : deny;
  });
  pi.on("agent_settled", () => callParents.clear());
  pi.on("tool_execution_end", (event, ctx) => {
    context = ctx;
    const call = activeCalls.get(event.toolCallId);
    if (!call) return;
    const result = { toolCallId: event.toolCallId, assistantEntryId: call.assistantEntryId, userEntryId: call.userEntryId,
      content: event.result.content, ...(event.result.details === undefined ? {} : { details: event.result.details }), isError: event.isError };
    const marker = "sedes.native.tool-result.v1";
    const authentication = createHmac("sha256", key).update(JSON.stringify(stable([marker, ctx.sessionManager.getSessionId(), result]))).digest("base64url");
    pi.appendEntry(marker, { version: 1, result, authentication });
    toolResults.set(`${call.assistantEntryId}\0${event.toolCallId}`, result); activeCalls.delete(event.toolCallId);
  });
  pi.on("turn_end", (event, ctx) => {
    context = ctx;
    const message = event.message;
    if (message?.role !== "assistant" || !Number.isFinite(message.durationMs) || message.durationMs < 0 || !Number.isSafeInteger(message.usage?.output) || message.usage.output < 0) return;
    const entry = ctx.sessionManager.getEntries().find((entry) => entry.id === event.messageEntryId && entry.type === "message" && entry.message === message);
    if (entry) eventUsage(entry.id, message.usage.output, message.durationMs);
  });
  function eventUsage(assistantEntryId: string, outputTokens: number, requestDurationMs: number): void {
    event({ type: "request_usage", assistantEntryId, outputTokens, requestDurationMs });
  }
  pi.on("session_shutdown", () => { failed = true; for (const resolve of approvals.values()) resolve(false); socket.destroy(); });
}

export function piManagedExtensionSource(): string {
  return `// Sedes managed Pi companion. Generated from reviewed public-hook code.\nimport { createCodemodeExtension, createMcpExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";\nimport * as net from "node:net";\nimport * as crypto from "node:crypto";\nimport * as fs from "node:fs";\nconst install = ${piManagedExtension.toString()};\nexport default (pi) => install(pi, createCodemodeExtension, createMcpExtension, createToolSearchExtension, { net, crypto, fs });\n`;
}

export async function installPiManagedExtension(directory: string): Promise<string> {
  const source = piManagedExtensionSource();
  const digest = createHash("sha256").update(source).digest("hex");
  const filename = path.join(directory, `sedes-${digest}.mjs`);
  const file = await open(filename, "wx", 0o600);
  try { await file.writeFile(source, "utf8"); await file.sync(); }
  finally { await file.close(); }
  return filename;
}
