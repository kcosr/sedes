import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { PiNativeHost } from "../../src/server/backends/pi/native/host/native-host.js";
import { PiNativeConversationDriver, parsePiNativeBindingDetail, type PiNativeOperations } from "../../src/server/backends/pi/native/driver/driver.js";
import { companion } from "../../src/server/backends/pi/native/driver/port-session.js";
import { piManagedStateSchema } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import type { AttachConversationInput, ConversationHandle } from "../../src/server/backends/contracts.js";
import { evaluateModelEligibility } from "../support/model-eligibility.js";

const provider = "aw-qwen-3-8-27b";
const modelId = "aw-qwen-3-8-27b";
const thinkingLevel = "low";
const scope = { tenantId: "live-native-pi", principalId: "live-native-pi" };
const readonlyTools = new Set(["read", "grep", "find", "ls", "codemode", "tool_search"]);
function requireGate(allowed: boolean, message: string): asserts allowed {
  if (!allowed) throw new Error(`LIVE_PI_NATIVE_BLOCKER: ${message}`);
}
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

it("qualifies the approved live model through stock native Pi, read-only code mode, and resume", async () => {
  requireGate(process.env.SEDES_RUN_LIVE_PI_NATIVE === "1", "explicit SEDES_RUN_LIVE_PI_NATIVE=1 opt-in is required");
  const executablePath = process.env.SEDES_LIVE_PI_NATIVE_EXECUTABLE;
  requireGate(Boolean(executablePath && path.isAbsolute(executablePath)), "select an absolute isolated Pi 1.4.0 executable with SEDES_LIVE_PI_NATIVE_EXECUTABLE");
  const sourceDirectory = await realpath(process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"));
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-live-pi-"));
  const agentDirectory = path.join(directory, "agent");
  const sessionDirectory = path.join(directory, "sessions");
  const workspacePath = path.join(directory, "workspace");
  let host: PiNativeHost | undefined;
  let driver: PiNativeConversationDriver | undefined;
  let channels: LocalEnvironmentChannelProvider | undefined;
  try {
    await Promise.all([mkdir(agentDirectory, { mode: 0o700 }), mkdir(sessionDirectory, { mode: 0o700 }), mkdir(workspacePath, { mode: 0o700 })]);
    // Reference existing credential/model files without reading or copying their
    // contents. Do not load operator extensions, MCP servers, skills, or settings.
    for (const filename of ["models.json", "auth.json"]) {
      const source = path.join(sourceDirectory, filename);
      requireGate((await stat(source)).isFile(), `native ${filename} must exist`);
      await symlink(source, path.join(agentDirectory, filename), "file");
    }
    requireGate((await readdir(sessionDirectory)).length === 0, "session directory must be fresh");
    const environment = { ...process.env, PI_CODING_AGENT_DIR: agentDirectory };
    channels = new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: "live-local", environment });
    host = new PiNativeHost({ configuration: { ...scope, backendInstanceId: "live-native", executionEnvironmentId: "live-local", executablePath,
      agentDirectory, sessionDirectory, initializationTimeoutMs: 20_000, projectTrusted: false }, channels, environment, authenticationKey: randomBytes(32), observationWaitMs: 10 });
    const instance = { id: "live-native", tenantId: scope.tenantId, kind: "pi_native" as const, label: "Pi", enabled: true, configurationRevision: 1, protocolRelease: "1.4.0" };
    const connection = { id: "live-connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "live-template", kind: "pi_rpc" as const,
      backendInstanceId: instance.id, executionEnvironmentId: "live-local", label: "Pi", enabled: true, configurationRevision: 1 };
    driver = new PiNativeConversationDriver({ instance, connection, port: host, operations: operationStore(), usage: NO_USAGE_SINK,
      settings: { getSettings: () => ({ modelProvider: provider, modelId, thinkingLevel, toolMode: "read_only", revision: 0 }) },
      modelPolicy: compileBackendModelPolicy({ type: "allowlist", allowed: [{ providerIds: [provider], modelIds: [modelId], reasoningEfforts: [thinkingLevel] }] }, "provider_model_effort") });
    const workspace = { canonicalPath: workspacePath, authorityRevision: 0, summary: { id: "live-workspace", environmentId: "live-local", displayName: "Live fixture", displayPath: workspacePath,
      availability: "available" as const, trustState: "untrusted" as const, revision: 0 } };
    const catalog = await driver.catalog({ scope, workspace });
    const candidates = catalog.models.filter(model => model.provider === provider && model.id === modelId);
    requireGate(candidates.length === 1, "expected exactly one authenticated aw-qwen-3-8-27b/aw-qwen-3-8-27b catalog candidate");
    const created = await driver.create({ scope, workspace, applicationThreadId: "live-thread", applicationOperationId: randomUUID(), requestedBackendConversationId: randomUUID(), source: { kind: "user" } });
    const input: AttachConversationInput = { scope, workspace, opaqueBindingDetail: created.opaqueBindingDetail,
      binding: { tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId: "live-thread", backendConversationId: created.backendConversationId,
        backendInstanceId: instance.id, connectionProfileId: connection.id, executionEnvironmentId: "live-local", createdAt: new Date().toISOString() } };
    let handle = await driver.attach(input);
    const native = parsePiNativeBindingDetail(created.opaqueBindingDetail);
    const inspect = async () => {
      const attachment = (await host!.inspect()).retainedSessions.find(session => session.sessionId === native.sessionId);
      requireGate(Boolean(attachment), "owned native attachment is missing");
      const state = piManagedStateSchema.parse(await companion(host!, attachment!, { type: "snapshot" }));
      requireGate(state.model?.provider === provider && state.model.id === modelId && state.thinkingLevel === thinkingLevel, "effective model or reasoning is not approved");
      requireGate(state.isIdle && state.activeTools.includes("read") && state.activeTools.includes("codemode") && state.activeTools.every(name => readonlyTools.has(name)), "effective tool set is not exclusively reviewed read-only tools");
      return state;
    };
    const eligibility = await evaluateModelEligibility({ catalog: candidates, requiredProvider: provider, requiredModelId: modelId, requiredThinkingLevel: thinkingLevel,
      inspect: async () => { const state = await inspect(); requireGate(!state.entries.some(entry => entry.type === "message"), "fresh session unexpectedly contains messages"); return {
        kind: "effective_state", provider: state.model!.provider, id: state.model!.id, thinkingLevel: state.thinkingLevel, additionalSafetyChecksPassed: true }; } });
    requireGate(eligibility.eligible.length === 1, "exact authenticated model and effective-state gate did not pass");
    process.stdout.write("Live native Pi 1.4.0: exact AW Qwen model, low reasoning, fresh session, and read-only tools verified.\n");
    const runRead = async (current: ConversationHandle, filename: string) => {
      const token = `NATIVE_PI_${randomUUID().replaceAll("-", "")}`;
      await writeFile(path.join(workspacePath, filename), `${token}\n`, { mode: 0o600 });
      await inspect();
      const operationId = randomUUID();
      const receipt = await current.submit({ applicationOperationId: operationId, mutationId: randomUUID(), reconciliationToken: randomUUID(), source: { kind: "user" },
        contextExcerpts: [], taskContexts: [], attachments: [],
        text: `Call codemode once with this code: text(await tools.read({path:${JSON.stringify(filename)}})); Then reply with only the exact token read from the file. Use no other tools.` });
      requireGate(typeof receipt.backendTurnId === "string", "submission has no native turn identity");
      await vi.waitFor(async () => {
        const history = await current.history({ limit: 20 });
        const turn = history.turnsById[receipt.backendTurnId!];
        requireGate(turn?.status !== "failed" && turn?.status !== "interrupted", "native provider turn failed or was interrupted");
        expect(turn?.status).toBe("completed");
      }, { timeout: 90_000, interval: 100 });
      const history = await current.history({ limit: 20 });
      requireGate(Object.values(history.itemsById).some(item => item.backendTurnId === receipt.backendTurnId && item.semanticKind === "assistant_message" && item.markdown.text.includes(token)), "final response did not contain the unseen fixture token");
      const disk = await host!.readHistory(native);
      requireGate(disk.toolCalls.some(call => call.userEntryId === receipt.backendTurnId && call.managed === "codemode"), "no signed native code-mode call was recorded");
      requireGate(disk.toolCalls.some(call => call.userEntryId === receipt.backendTurnId && call.toolName === "read" && Boolean(call.parentToolCallId)), "no signed nested native read was recorded");
      requireGate(disk.toolCalls.every(call => readonlyTools.has(call.toolName)), "unexpected tool execution was recorded");
      requireGate(disk.entries.filter(entry => entry.type === "message" && (entry.message as { role?: string }).role === "assistant").every(entry => {
        const message = entry.message as { provider?: string; model?: string }; return message.provider === provider && message.model === modelId;
      }), "history includes an unapproved model");
      return receipt.backendTurnId;
    };
    const firstTurn = await runRead(handle, "sentinel.txt");
    await handle.close();
    handle = await driver.attach(input);
    requireGate((await handle.history({ limit: 20 })).orderedBackendTurnIds.includes(firstTurn), "resumed history lost the first turn");
    await runRead(handle, "resumed-sentinel.txt");
    await handle.close();
    process.stdout.write("Live native Pi: code-mode reads, signed provenance, and detach/resume passed.\n");
  } finally {
    // Keep native files available if child cleanup cannot be proved.
    await driver?.close();
    await host?.close();
    channels?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
