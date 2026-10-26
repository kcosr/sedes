import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PiNativeConversationDriver, serializePiNativeBindingDetail, type PiNativeDriverOptions, type PiNativeOperations } from "../../src/server/backends/pi/native/driver/driver.js";
import { PiNativeAgentToolService } from "../../src/server/backends/pi/native/agent-tools.js";
import { PiNativeError, type PiNativeAttachment, type PiNativeCatalog, type PiNativeHistory, type PiNativeOutcome, type PiNativePort } from "../../src/server/backends/pi/native/port.js";
import { companion, requestNative, rpc } from "../../src/server/backends/pi/native/driver/port-session.js";
import { PiNativeHost, type PiNativeSessionLauncher } from "../../src/server/backends/pi/native/host/native-host.js";
import { PiRpcCallError } from "../../src/server/backends/pi/native/rpc/pi-rpc-client.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import type { PiManagedOperation, PiManagedState } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";
import { BackendError, type AttachConversationInput, type ConversationHandle, type SubmitTurnInput } from "../../src/server/backends/contracts.js";
import type { BackendConversationEvent } from "../../src/shared/protocol/backend.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";

const time = "2026-10-26T00:00:00.000Z";
const native = { sessionId: "session", sessionFile: "/agent/sessions/session.jsonl", cwd: "/project" };
const attachment: PiNativeAttachment = { ...native, handleId: "handle", generation: "generation", throughSequence: 0, retainedAfterSequence: 0, retainedOperationIds: [] };
const instance = { id: "pi-native", tenantId: "tenant", kind: "pi_native" as const, label: "Pi", enabled: true, configurationRevision: 1, protocolRelease: "1.4.0" };
const connection = { id: "connection", tenantId: "tenant", ownerPrincipalId: "principal", templateId: "template", kind: "pi_rpc" as const,
  backendInstanceId: instance.id, executionEnvironmentId: "environment", label: "Pi", enabled: true, configurationRevision: 1 };
const conversation: AttachConversationInput = { scope: { tenantId: "tenant", principalId: "principal" },
  workspace: { canonicalPath: native.cwd, authorityRevision: 0, summary: { id: "workspace", environmentId: "environment", displayName: "Project", displayPath: native.cwd, availability: "available", trustState: "trusted", revision: 0 } },
  binding: { tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "thread", backendConversationId: native.sessionId, backendInstanceId: instance.id,
    connectionProfileId: connection.id, executionEnvironmentId: connection.executionEnvironmentId, createdAt: time }, opaqueBindingDetail: serializePiNativeBindingDetail(native) };
const submission = (operationId = "submit"): SubmitTurnInput => ({ applicationOperationId: operationId, mutationId: `${operationId}-mutation`, reconciliationToken: `${operationId}-token`, source: { kind: "user" }, text: "Hello", contextExcerpts: [], taskContexts: [], attachments: [] });
const user = (id: string, parentId: string | null, text = "Hello") => ({ id, parentId, type: "message" as const, timestamp: time,
  message: { role: "user" as const, timestamp: Date.parse(time), content: [{ type: "text" as const, text }] } });
const answer = (id: string, parentId: string) => ({ id, parentId, type: "message" as const, timestamp: time,
  message: { role: "assistant" as const, timestamp: Date.parse(time), content: [{ type: "text" as const, text: "Done" }], provider: "provider", model: "model", api: "openai-completions", stopReason: "stop" as const, usage: {} } });
function operationStore(): PiNativeOperations {
  const records = new Map<string, ReturnType<PiNativeOperations["prepareOperation"]>>();
  return {
    prepareOperation(_scope, _thread, input) { const prior = records.get(input.operationId); if (prior && prior.requestHash !== input.requestHash) throw new Error("operation_replay_mismatch");
      const record = prior ?? { requestHash: input.requestHash, state: "prepared", prepareAttempt: 0, dispatchStarted: false, receiptJson: null }; records.set(input.operationId, record); return record; },
    getOperation(_scope, _thread, id) { return records.get(id); },
    completeOperation(_scope, _thread, id, input) { const prior = records.get(id); if (!prior) throw new Error("operation_missing");
      const next = { ...prior, ...input }; records.set(id, next); return next; },
    markSubmissionDispatched(_scope, _thread, id, requestHash, prepareAttempt) { const prior = records.get(id);
      if (!prior || prior.state !== "sent" || prior.requestHash !== requestHash || prior.prepareAttempt !== prepareAttempt || prior.receiptJson !== null) throw new Error("operation_not_dispatchable");
      const next = { ...prior, dispatchStarted: true }; records.set(id, next); return next; },
    resetUnsentOperation(_scope, _thread, id, requestHash, prepareAttempt) { const prior = records.get(id);
      if (!prior || prior.state !== "sent" || prior.dispatchStarted || prior.requestHash !== requestHash || prior.prepareAttempt !== prepareAttempt || prior.receiptJson !== null) throw new Error("operation_not_resettable");
      const next = { ...prior, state: "prepared" as const, prepareAttempt: prior.prepareAttempt + 1 }; records.set(id, next); return next; },
  };
}
class NativeFixture {
  state: PiManagedState = { sessionId: native.sessionId, sessionFile: native.sessionFile, entries: [], leafId: null, operations: [], toolCalls: [], toolResults: [], tools: ["read", "write", "bash"].map(name => ({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } })),
    activeTools: [], isIdle: true, model: { provider: "provider", id: "model", input: ["text", "image"] }, thinkingLevel: "low" };
  commands: { id: string; type: string; command: Readonly<Record<string, unknown>> }[] = [];
  outcomes = new Map<string, PiNativeOutcome>();
  wires = new Map<string, string>();
  queue: Parameters<NonNullable<NativeFixture["push"]>>[0][] = [];
  sequence = 0;
  attachCount = 0;
  releaseCount = 0;
  abortPrompt = false;
  history(): PiNativeHistory { return { ...native, entries: this.state.entries, leafId: this.state.leafId, operations: this.state.operations, toolCalls: [], toolResults: [], inheritedEntryIds: [], inheritance: "none" }; }
  rpcState() { return { sessionId: native.sessionId, sessionFile: native.sessionFile, thinkingLevel: "low", isStreaming: !this.state.isIdle,
    isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true,
    messageCount: this.state.entries.filter(entry => entry.type === "message").length, pendingMessageCount: 0 }; }
  push(event: { kind: "rpc" | "companion" | "stream"; payload: Record<string, unknown> }): void { this.queue.push(event); }
  port: PiNativePort = {
    resolveSessionDirectory: async () => "/agent/sessions",
    catalog: async () => ({ models: [{ provider: "provider", id: "model", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: null } }], commands: [{ name: "skill:review", source: "skill" }] }),
    create: async () => native, fork: vi.fn(async input => ({ ...native, sessionId: input.childSessionId })), reconcileFork: vi.fn(async () => null), listSessions: async () => ({ sessions: [] }),
    readHistory: async () => this.history(), attach: vi.fn(async () => { this.attachCount++; return attachment; }),
    attachForDrain: vi.fn(async () => ({ ...attachment, observationGap: false, closed: false })),
    attachForControl: vi.fn(async () => attachment),
    request: async input => {
      const cached = this.outcomes.get(input.operationId); if (cached) return cached;
      const command = input.command.command; const type = String(command.type); this.commands.push({ id: input.operationId, type, command });
      let result: unknown = {};
      if (type === "snapshot") result = structuredClone(this.state);
      if (type === "get_state") result = this.rpcState();
      if (type === "get_available_models") result = { models: [{ provider: "provider", id: "model", reasoning: true }] };
      if (type === "get_commands") result = { commands: [{ name: "skill:review", source: "skill" }] };
      if (type === "set_model") this.state = { ...this.state, model: { provider: String(command.provider), id: String(command.modelId) } };
      if (type === "set_thinking_level") this.state = { ...this.state, thinkingLevel: String(command.level) };
      if (type === "set_active_tools") this.state = { ...this.state, activeTools: command.names as string[] };
      if (type === "prepare_submission") {
        const operation = { input: command.input, phase: "intent" } as PiManagedOperation;
        this.state = { ...this.state, operations: [...this.state.operations, operation] }; const wireText = `wire:${operation.input.operationId}`; this.wires.set(wireText, operation.input.operationId);
        result = { wireText, operation };
      }
      if (type === "prompt" || type === "steer") {
        if (this.abortPrompt) throw new PiNativeError("connection_closed", "sent_outcome_unknown");
        const id = this.wires.get(String(command.message));
        const operation = this.state.operations.find(item => item.input.operationId === id)!;
        if (type === "prompt") {
          const entry = user(`user:${id}`, this.state.leafId, operation.input.text);
          this.state = { ...this.state, entries: [...this.state.entries, entry], leafId: entry.id, isIdle: false,
            operations: this.state.operations.map(item => item === operation ? { ...item, phase: "accepted", userEntryId: entry.id } : item) };
        } else this.state = { ...this.state, operations: this.state.operations.map(item => item === operation ? { ...item, phase: "enqueued" } : item) };
        result = { disposition: type === "prompt" ? "started" : "queued" };
      }
      if (type === "complete_submission" && (command.disposition === "rejected" || command.disposition === "handled"))
        this.state = { ...this.state, operations: this.state.operations.map(item => item.input.operationId === command.operationId && ["intent", "enqueued"].includes(item.phase) ? { ...item, phase: "rejected" } : item) };
      if (type === "get_submission" || type === "complete_submission") result = this.state.operations.find(item => item.input.operationId === command.operationId) ?? null;
      if (type === "abort") this.state = { ...this.state, isIdle: true };
      if (type === "begin_stop") result = { ok: true };
      if (type === "end_stop") { this.state = { ...this.state, operations: this.state.operations.map(item => item.phase === "enqueued" || item.phase === "intent" ? { ...item, phase: "lost" } : item) }; result = { ok: true }; }
      const outcome = { status: "completed" as const, result }; this.outcomes.set(input.operationId, outcome); return outcome;
    },
    outcome: async input => this.outcomes.get(input.operationId) ?? { status: "failed", failure: { code: "unknown_operation", delivery: "sent_outcome_unknown" } },
    acknowledgeOperation: async input => { this.outcomes.delete(input.operationId); },
    abandonObservation: vi.fn(async input => { this.outcomes.delete(input.operationId); return "released" as const; }),
    observe: async (_input, signal) => {
      if (!this.queue.length) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 5); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
      signal?.throwIfAborted();
      const events = this.queue.splice(0).map(event => ({ ...event, sequence: ++this.sequence })); return { events, throughSequence: this.sequence, retainedAfterSequence: 0, closed: false };
    },
    acknowledgeObservationGap: vi.fn(async () => {}),
    acknowledge: async () => {}, release: async () => { this.releaseCount++; }, retireSession: vi.fn(async () => "retired" as const), inspect: async () => ({ runtimeId: "runtime", state: "idle", revision: "0", blockers: [], retainedSessions: [] }), stop: async () => {}, close: async () => {},
  };
}
const drivers: PiNativeConversationDriver[] = [];
async function subscribeProjection(handle: ConversationHandle, listener: (event: BackendConversationEvent) => void) {
  const projection = await handle.establishProjection({ signal: new AbortController().signal });
  return projection.subscribeFromNext(({ event }) => listener(event));
}
function setup(extra: Partial<PiNativeDriverOptions> = {}) {
  const fixture = new NativeFixture();
  const driver = new PiNativeConversationDriver({ instance, connection, port: fixture.port, operations: operationStore(), usage: NO_USAGE_SINK,
    settings: { getSettings: () => ({ modelProvider: "provider", modelId: "model", thinkingLevel: "low", toolMode: "full", revision: 0 }) },
    modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "provider_model_effort"), ...extra });
  drivers.push(driver); return { fixture, driver };
}
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.close(); });

describe("native Pi driver", () => {
  it("claims the execution-host store identity before publishing a create or fork", async () => {
    let owned = false;
    const claimNativeSession = vi.fn(() => { if (!owned) throw new Error("ownership_conflict"); });
    const { driver, fixture } = setup({ claimNativeSession });
    const create = vi.spyOn(fixture.port, "create");
    const input = { ...conversation, applicationThreadId: "thread", applicationOperationId: "create",
      requestedBackendConversationId: "created", source: { kind: "user" as const } };
    await expect(driver.create(input)).rejects.toThrow("ownership_conflict");
    expect(create).not.toHaveBeenCalled();
    expect(claimNativeSession).toHaveBeenLastCalledWith(conversation.scope, { applicationThreadId: "thread",
      applicationOperationId: "create", sessionId: "created", sessionDirectory: "/agent/sessions" });
    owned = true;
    await driver.create(input);
    expect(create).toHaveBeenCalledOnce();
    fixture.state = { ...fixture.state, entries: [user("u", null), answer("a", "u")], leafId: "a" };
    const checkpoint = await driver.resolveBranchCheckpoint({ ...conversation,
      selection: { kind: "selected_completed_turn", backendTurnId: "u", boundary: "completed_turn_inclusive" } });
    const fork = { ...conversation, sourceBinding: conversation.binding, sourceOpaqueBindingDetail: conversation.opaqueBindingDetail,
      sourceCheckpoint: checkpoint, applicationOperationId: "fork", childApplicationThreadId: "child",
      requestedBackendConversationId: "child-native", source: { kind: "user" as const }, inheritedSettings: { toolAccess: "read_only" as const } };
    owned = false;
    await expect(driver.branchConversation(fork)).rejects.toThrow("ownership_conflict");
    expect(fixture.port.fork).not.toHaveBeenCalled();
    expect(claimNativeSession).toHaveBeenLastCalledWith(conversation.scope, { applicationThreadId: "child",
      applicationOperationId: "fork", sessionId: "child-native", sessionDirectory: "/agent/sessions" });
    owned = true;
    await driver.branchConversation(fork);
    expect(fixture.port.fork).toHaveBeenCalledOnce();
  });

  it.each([
    { delivery: "not_sent", category: "unavailable", retryable: true, crossedSubmissionBoundary: false },
    { delivery: "rejected", category: "rejected", retryable: false, crossedSubmissionBoundary: false },
    { delivery: "sent_outcome_unknown", category: "submission_unknown", retryable: false, crossedSubmissionBoundary: true },
  ] as const)("preserves authoritative $delivery creation evidence", async ({ delivery, ...expected }) => {
    const { driver, fixture } = setup(); fixture.port.create = async () => { throw new PiNativeError("native_create_failed", delivery); };
    await expect(driver.create({ ...conversation, applicationThreadId: "thread", applicationOperationId: "create", requestedBackendConversationId: "created", source: { kind: "user" } }))
      .rejects.toMatchObject({ ...expected, backendCode: "native_create_failed" });
  });
  it("does not invent non-dispatch evidence for an unclassified creation failure", async () => {
    const { driver, fixture } = setup(); const failure = new Error("unknown transport failure");
    fixture.port.create = async () => { throw failure; };
    await expect(driver.create({ ...conversation, applicationThreadId: "thread", applicationOperationId: "create", requestedBackendConversationId: "created", source: { kind: "user" } }))
      .rejects.toBe(failure);
    fixture.port.readHistory = async () => { throw new PiNativeError("history_capacity", "not_sent"); };
    await expect(driver.openHistory(conversation)).rejects.toMatchObject({ backendCode: "history_capacity", retryable: true, crossedSubmissionBoundary: false });
  });
  it("coalesces native catalog reads, refreshes explicit pickers, and preserves passive snapshots on failure", async () => {
    const { driver, fixture } = setup();
    const firstCatalog = { models: [{ provider: "provider", id: "first", reasoning: true }], commands: [{ name: "skill:first", source: "skill" }] };
    let resolveLoad!: (value: PiNativeCatalog) => void;
    fixture.port.catalog = vi.fn(async () => new Promise<PiNativeCatalog>(resolve => { resolveLoad = resolve; }));
    const first = driver.catalog(conversation); const joined = driver.catalog(conversation);
    expect(fixture.port.catalog).toHaveBeenCalledTimes(1); resolveLoad(firstCatalog);
    expect((await first).models[0]?.id).toBe("first"); expect((await joined).skills[0]?.name).toBe("first");
    await driver.catalog(conversation); expect(fixture.port.catalog).toHaveBeenCalledTimes(1);
    const refresh = driver.catalog({ ...conversation, purpose: "skill_picker" });
    const joinedRefresh = driver.catalog({ ...conversation, purpose: "skill_picker" });
    expect(fixture.port.catalog).toHaveBeenCalledTimes(2);
    expect((await driver.catalog(conversation)).models[0]?.id).toBe("first");
    resolveLoad({ models: [{ provider: "provider", id: "second", reasoning: true }], commands: [{ name: "skill:second", source: "skill" }] });
    expect((await refresh).models[0]?.id).toBe("second"); expect((await joinedRefresh).skills[0]?.name).toBe("second");
    fixture.port.catalog = vi.fn(async () => { throw new PiNativeError("temporarily_unavailable"); });
    await expect(driver.catalog({ ...conversation, purpose: "skill_picker" })).rejects.toThrow();
    expect((await driver.catalog(conversation)).models[0]?.id).toBe("second");
    expect(fixture.port.catalog).toHaveBeenCalledOnce();
  });
  it.each(["workspace", "authority"] as const)("rejects a late catalog for a superseded %s revision", async revision => {
    const { driver, fixture } = setup(); let resolveOld!: (value: PiNativeCatalog) => void;
    fixture.port.catalog = vi.fn<PiNativePort["catalog"]>().mockImplementationOnce(async () => new Promise<PiNativeCatalog>(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ models: [{ provider: "provider", id: "current" }], commands: [] });
    const old = driver.catalog(conversation);
    const rejection = expect(old).rejects.toMatchObject({ backendCode: "pi_native_catalog_context_changed", retryable: true });
    const current = { ...conversation, workspace: { ...conversation.workspace,
      ...(revision === "authority" ? { authorityRevision: 1 } : { summary: { ...conversation.workspace.summary, revision: 1 } }) } };
    expect((await driver.catalog(current)).models[0]?.id).toBe("current");
    resolveOld({ models: [{ provider: "provider", id: "old" }], commands: [] }); await rejection;
    expect((await driver.catalog(current)).models[0]?.id).toBe("current"); expect(fixture.port.catalog).toHaveBeenCalledTimes(2);
    await expect(driver.catalog(conversation)).rejects.toMatchObject({ backendCode: "pi_native_catalog_context_changed" });
    expect(fixture.port.catalog).toHaveBeenCalledTimes(2);
  });
  it("denies wrong-owner catalog reads and discards a result after driver closure", async () => {
    const { driver, fixture } = setup(); let resolveLoad!: (value: PiNativeCatalog) => void;
    fixture.port.catalog = vi.fn(async () => new Promise<PiNativeCatalog>(resolve => { resolveLoad = resolve; }));
    await expect(driver.catalog({ ...conversation, scope: { ...conversation.scope, principalId: "other" } })).rejects.toThrow();
    expect(fixture.port.catalog).not.toHaveBeenCalled();
    const pending = driver.catalog(conversation); const rejection = expect(pending).rejects.toMatchObject({ backendCode: "pi_native_scope_mismatch" });
    await driver.close(); resolveLoad({ models: [], commands: [] }); await rejection;
  });
  it("reports current native context occupancy and clears stale knowledge after compaction or disappearance", async () => {
    const { driver, fixture } = setup();
    fixture.state = { ...fixture.state, contextUsage: { tokens: 512, contextWindow: 4096, percent: 12.5 } };
    const handle = await driver.attach(conversation);
    expect((await handle.backendCapabilities()).usageSections).toEqual(["context", "counters"]);
    expect((await handle.usage()).context).toEqual({ usedTokens: 512, windowTokens: 4096, percent: 12.5 });
    fixture.state = { ...fixture.state, contextUsage: { tokens: null, contextWindow: 4096, percent: null } };
    fixture.push({ kind: "companion", payload: { type: "state_changed" } });
    await vi.waitFor(async () => expect((await handle.usage()).context).toEqual({ windowTokens: 4096 }));
    const { contextUsage: _context, ...withoutContext } = fixture.state; fixture.state = withoutContext;
    fixture.push({ kind: "companion", payload: { type: "state_changed" } });
    await vi.waitFor(async () => expect((await handle.usage()).context).toBeUndefined());
    const history = await driver.openHistory(conversation);
    expect((await history.backendCapabilities()).usageSections).toEqual(["counters"]);
    expect((await history.usage()).context).toBeUndefined(); await history.close();
  });
  it.each(["throw", "retained"] as const)("retries the same submission after proven not-sent preparation (%s)", async failure => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const request = fixture.port.request; let blocked = true;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type === "prepare_submission" && blocked) {
        blocked = false;
        if (failure === "throw") throw new PiNativeError("temporarily_unavailable", "not_sent");
        const outcome = { status: "failed" as const, failure: { code: "temporarily_unavailable", delivery: "not_sent" as const } };
        fixture.outcomes.set(input.operationId, outcome); return outcome;
      }
      return request(input, signal);
    };
    const handle = await driver.attach(conversation);
    await expect(handle.submit(submission())).rejects.toMatchObject({ retryable: true, crossedSubmissionBoundary: false });
    expect(operations.getOperation(conversation.scope, "thread", "submit")?.state).toBe("prepared");
    await handle.submit(submission());
    expect(fixture.state.operations).toHaveLength(1);
    expect(fixture.commands.filter(command => command.type === "prompt")).toHaveLength(1);
    expect(operations.getOperation(conversation.scope, "thread", "submit")?.state).toBe("completed");
  });
  it("never resends preparation after an uncertain reply, even when no receipt can be found", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const request = fixture.port.request; let preparations = 0;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type === "prepare_submission") {
        preparations++; throw new PiNativeError("connection_closed", "sent_outcome_unknown");
      }
      return request(input, signal);
    };
    const handle = await driver.attach(conversation);
    await expect(handle.submit(submission())).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(operations.getOperation(conversation.scope, "thread", "submit")?.state).toBe("sent");
    await expect(handle.submit(submission())).rejects.toMatchObject({ crossedSubmissionBoundary: true, backendCode: "pi_native_submission_unresolved" });
    expect(preparations).toBe(1);
    expect(fixture.commands.some(command => command.type === "prompt")).toBe(false);
  });
  it.each([
    { recovery: "retry", loss: "reply" }, { recovery: "reconcile", loss: "reply" }, { recovery: "restart", loss: "reply" },
    { recovery: "retry", loss: "poll" }, { recovery: "reconcile", loss: "poll" }, { recovery: "restart", loss: "poll" },
    { recovery: "drain", loss: "reply" },
  ] as const)("retires an undispatched intent through $recovery after losing its prepare $loss", async ({ recovery, loss }) => {
    const operations = operationStore(); const setupResult = setup({ operations });
    let driver = setupResult.driver; const fixture = setupResult.fixture;
    let handle = await driver.attach(conversation);
    const request = fixture.port.request, outcome = fixture.port.outcome;
    let admitting: string | undefined; let lose = true;
    fixture.port.request = async (input, signal) => {
      const command = input.command.command;
      if (command.type === "prepare_submission") {
        if (admitting) throw new PiNativeError("pi_managed_admission_closed", "rejected");
        const operationId = (command.input as PiManagedOperation["input"]).operationId;
        expect(operations.getOperation(conversation.scope, "thread", operationId)?.dispatchStarted).toBe(false);
        const result = await request(input, signal); admitting = operationId;
        if (operationId === "lost-prepare" && lose) {
          if (loss === "poll") return { status: "pending" };
          lose = false; throw new PiNativeError("pi_native_prepare_reply_lost", "sent_outcome_unknown");
        }
        return result;
      }
      if (command.type === "prompt") {
        expect(operations.getOperation(conversation.scope, "thread", admitting!)?.dispatchStarted).toBe(true);
        admitting = undefined;
      }
      const result = await request(input, signal);
      if (command.type === "complete_submission") admitting = undefined;
      return result;
    };
    fixture.port.outcome = async (input, signal) => {
      if (input.operationId === "lost-prepare:prepare:0" && lose && loss === "poll") {
        lose = false; throw new PiNativeError("pi_native_poll_refused", "not_sent");
      }
      return outcome(input, signal);
    };
    const input = submission("lost-prepare");
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)).toMatchObject({ state: "sent", dispatchStarted: false });
    expect(admitting).toBe(input.applicationOperationId);
    if (recovery === "drain") {
      await handle.close();
      fixture.port.attachForDrain = async () => ({ ...attachment, observationGap: false, closed: true, retainedOperationIds: ["lost-prepare:prepare:0"] });
      fixture.port.retireSession = async () => fixture.outcomes.has("lost-prepare:prepare:0") ? "undelivered" : "retired";
      await expect(driver.releaseConversationResidency(conversation)).resolves.toBe("released");
      expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)).toMatchObject({ state: "unknown", dispatchStarted: false });
    }
    if (recovery === "restart" || recovery === "drain") {
      await driver.close(); driver = setup({ operations, port: fixture.port }).driver;
    }
    const notSent = { status: "not_accepted", retryable: false, diagnostic: { text: "This input was not sent. Restore it to send it again." } };
    if (recovery === "retry") await expect(handle.submit(input)).rejects.toMatchObject({ category: "rejected", crossedSubmissionBoundary: false, retryable: false,
      safeMessage: notSent.diagnostic.text });
    else expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId, reconciliationToken: input.reconciliationToken }))
      .toEqual(notSent);
    expect(admitting).toBeUndefined();
    const saved = operations.getOperation(conversation.scope, "thread", input.applicationOperationId)!;
    expect(saved).toMatchObject({ state: "completed", dispatchStarted: false });
    expect(JSON.parse(saved.receiptJson!)).toMatchObject({ phase: "rejected", input: { operationId: input.applicationOperationId } });
    expect(fixture.commands.filter(command => command.type === "prepare_submission")).toHaveLength(1);
    expect(fixture.commands.filter(command => command.type === "complete_submission")).toMatchObject([{ id: "lost-prepare:complete", command: { disposition: "rejected" } }]);
    expect(fixture.commands.some(command => command.type === "prompt")).toBe(false);
    expect(fixture.outcomes.has("lost-prepare:prepare:0")).toBe(false);
    expect(fixture.outcomes.has("lost-prepare:complete")).toBe(false);
    if (recovery === "restart" || recovery === "drain") handle = await driver.attach(conversation);
    // The queue keeps this operation identity on retry. Its terminal receipt
    // must consistently stop automatic retries instead of promising delivery.
    const commandCount = fixture.commands.length;
    for (let replay = 0; replay < 3; replay++) {
      await expect(handle.submit(input)).rejects.toMatchObject({ category: "rejected", crossedSubmissionBoundary: false, retryable: false,
        safeMessage: notSent.diagnostic.text });
      expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId, reconciliationToken: input.reconciliationToken }))
        .toEqual(notSent);
    }
    expect(fixture.commands).toHaveLength(commandCount);
    await expect(handle.submit(submission("after-recovery"))).resolves.toMatchObject({ accepted: true });
    expect(operations.getOperation(conversation.scope, "thread", "after-recovery")).toMatchObject({ state: "completed", dispatchStarted: true });
    expect(fixture.state.entries).toEqual([user("user:after-recovery", null, input.text)]);
  });
  it.each(["reply", "poll"] as const)("never retires an intent once prompt dispatch is marked, including after restart (%s)", async loss => {
    const operations = operationStore(); const setupResult = setup({ operations });
    let driver = setupResult.driver; const fixture = setupResult.fixture;
    let handle = await driver.attach(conversation);
    const request = fixture.port.request, outcome = fixture.port.outcome;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type !== "prompt") return request(input, signal);
      expect(operations.getOperation(conversation.scope, "thread", "prompt-unknown")?.dispatchStarted).toBe(true);
      fixture.commands.push({ id: input.operationId, type: "prompt", command: input.command.command });
      fixture.outcomes.set(input.operationId, { status: "pending" });
      if (loss === "reply") throw new PiNativeError("pi_native_prompt_reply_lost", "sent_outcome_unknown");
      return { status: "pending" };
    };
    fixture.port.outcome = async (input, signal) => {
      if (input.operationId === "prompt-unknown:dispatch") throw new PiNativeError("pi_native_prompt_poll_refused", "not_sent");
      return outcome(input, signal);
    };
    const input = submission("prompt-unknown");
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(fixture.state.operations[0]?.phase).toBe("intent");
    expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toMatchObject({ status: "unresolved" });
    await driver.close(); driver = setup({ operations, port: fixture.port }).driver;
    expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toMatchObject({ status: "unresolved" });
    handle = await driver.attach(conversation);
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)).toMatchObject({ state: "sent", dispatchStarted: true, receiptJson: null });
    expect(fixture.commands.filter(command => command.type === "prompt")).toHaveLength(1);
    expect(fixture.commands.some(command => command.type === "complete_submission")).toBe(false);
  });
  it("recovers lost intent-retirement completion from its native rejection without repeating the mutation", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation); const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.operationId === "retirement:prepare:0" || input.operationId === "retirement:complete")
        throw new PiNativeError("pi_native_reply_lost", "sent_outcome_unknown");
      return result;
    };
    const input = submission("retirement");
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await expect(driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId }))
      .rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(fixture.state.operations[0]?.phase).toBe("rejected");
    expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toEqual({ status: "not_accepted", retryable: false,
      diagnostic: { text: "This input was not sent. Restore it to send it again." } });
    expect(fixture.commands.filter(command => command.type === "complete_submission")).toHaveLength(1);
    expect(fixture.outcomes.has("retirement:prepare:0")).toBe(false);
    expect(fixture.outcomes.has("retirement:complete")).toBe(false);
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)).toMatchObject({ state: "completed", dispatchStarted: false });
  });
  it("serializes intent recovery behind the active send before deciding whether dispatch started", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation); const request = fixture.port.request;
    let releasePrepare: (() => void) | undefined;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.command.command.type === "prepare_submission") await new Promise<void>(resolve => { releasePrepare = resolve; });
      return result;
    };
    const input = submission("in-flight-prepare");
    const sending = handle.submit(input);
    await vi.waitFor(() => expect(releasePrepare).toBeDefined());
    const reconciling = driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)?.dispatchStarted).toBe(false);
    expect(fixture.commands.some(command => command.type === "complete_submission")).toBe(false);
    releasePrepare!();
    await expect(sending).resolves.toMatchObject({ accepted: true });
    await expect(reconciling).resolves.toMatchObject({ status: "accepted" });
    expect(fixture.commands.filter(command => command.type === "complete_submission")).toMatchObject([{ command: { disposition: "started" } }]);
  });
  it.each(["attaching", "retiring", "releasing"] as const)("makes a client attach retryable while an intent-recovery handle is %s", async phase => {
    const { driver, fixture } = setup(); const initial = await driver.attach(conversation);
    const request = fixture.port.request, attach = fixture.port.attach, release = fixture.port.release;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.command.command.type === "prepare_submission") throw new PiNativeError("pi_native_reply_lost", "sent_outcome_unknown");
      return result;
    };
    const input = submission("recovering-intent");
    await expect(initial.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await initial.close(); fixture.port.request = request;
    let entered = false, resume: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    if (phase === "attaching") fixture.port.attach = async (...args) => { entered = true; await gate; return attach(...args); };
    if (phase === "retiring") fixture.port.request = async (command, signal) => {
      if (command.command.command.type === "complete_submission") { entered = true; await gate; }
      return request(command, signal);
    };
    if (phase === "releasing") fixture.port.release = async (...args) => { entered = true; await gate; return release(...args); };
    const recovering = driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId });
    await vi.waitFor(() => expect(entered).toBe(true));
    await expect(driver.attach(conversation)).rejects.toMatchObject({ category: "unavailable", retryable: true,
      crossedSubmissionBoundary: false, backendCode: "pi_native_submission_recovery_busy" });
    if (phase !== "releasing") await expect(driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId }))
      .rejects.toMatchObject({ category: "unavailable", retryable: true, backendCode: "pi_native_submission_recovery_busy" });
    resume!();
    await expect(recovering).resolves.toMatchObject({ status: "not_accepted", retryable: false });
    expect(fixture.releaseCount).toBe(2);
    const client = await driver.attach(conversation);
    await expect(driver.attach(conversation)).rejects.toMatchObject({ category: "rejected", retryable: false, backendCode: "pi_native_already_attached" });
    await expect(client.submit(submission("after-recovery"))).resolves.toMatchObject({ accepted: true });
  });
  it.each(["ready", "attaching"] as const)("preserves the client handle when it is %s during the recovery history read", async phase => {
    const { driver, fixture } = setup(); const initial = await driver.attach(conversation);
    const request = fixture.port.request, readHistory = fixture.port.readHistory, attach = fixture.port.attach;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.command.command.type === "prepare_submission") throw new PiNativeError("pi_native_reply_lost", "sent_outcome_unknown");
      return result;
    };
    const input = submission("client-owned-intent");
    await expect(initial.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await initial.close(); fixture.port.request = request;
    let resumeHistory: (() => void) | undefined;
    fixture.port.readHistory = async (...args) => {
      fixture.port.readHistory = readHistory;
      await new Promise<void>(resolve => { resumeHistory = resolve; });
      return readHistory(...args);
    };
    const recovering = driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId });
    await vi.waitFor(() => expect(resumeHistory).toBeDefined());
    let resumeAttach: (() => void) | undefined;
    if (phase === "attaching") fixture.port.attach = async (...args) => {
      await new Promise<void>(resolve => { resumeAttach = resolve; });
      return attach(...args);
    };
    const attaching = driver.attach(conversation);
    if (phase === "attaching") {
      await vi.waitFor(() => expect(resumeAttach).toBeDefined());
      await expect(driver.attach(conversation)).rejects.toMatchObject({ category: "rejected", retryable: false, backendCode: "pi_native_already_attached" });
      resumeHistory!();
      await expect(recovering).rejects.toMatchObject({ category: "unavailable", retryable: true, backendCode: "pi_native_submission_recovery_busy" });
      resumeAttach!();
    }
    const client = await attaching;
    if (phase === "ready") {
      resumeHistory!(); await expect(recovering).resolves.toMatchObject({ status: "not_accepted", retryable: false });
    } else await expect(driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId }))
      .resolves.toMatchObject({ status: "not_accepted", retryable: false });
    expect(fixture.attachCount).toBe(2);
    expect(fixture.releaseCount).toBe(1);
    await expect(client.submit(submission("client-still-open"))).resolves.toMatchObject({ accepted: true });
    await client.close(); expect(fixture.releaseCount).toBe(2);
  });
  it.each(["attaching", "retiring"] as const)("clears temporary recovery ownership when %s fails", async phase => {
    const { driver, fixture } = setup(); const initial = await driver.attach(conversation);
    const request = fixture.port.request, attach = fixture.port.attach;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.command.command.type === "prepare_submission") throw new PiNativeError("pi_native_reply_lost", "sent_outcome_unknown");
      return result;
    };
    const input = submission("failed-recovery");
    await expect(initial.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await initial.close(); fixture.port.request = request;
    if (phase === "attaching") fixture.port.attach = async () => { throw new PiNativeError("pi_native_attach_refused", "not_sent"); };
    else fixture.port.request = async (command, signal) => {
      if (command.command.command.type === "complete_submission") throw new PiNativeError("pi_native_retirement_refused", "not_sent");
      return request(command, signal);
    };
    await expect(driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).rejects.toBeInstanceOf(BackendError);
    fixture.port.attach = attach; fixture.port.request = request;
    const client = await driver.attach(conversation);
    await expect(driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId }))
      .resolves.toMatchObject({ status: "not_accepted", retryable: false });
    await expect(client.submit(submission("after-failed-recovery"))).resolves.toMatchObject({ accepted: true });
  });
  it("does not withdraw a differently owned native intent during reconciliation", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation); const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.command.command.type === "prepare_submission") throw new PiNativeError("pi_native_reply_lost", "sent_outcome_unknown");
      return result;
    };
    const input = submission("owned-intent");
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId, reconciliationToken: "different-token" }))
      .toMatchObject({ status: "unresolved" });
    expect(fixture.commands.some(command => command.type === "complete_submission")).toBe(false);
    expect(fixture.state.operations[0]?.phase).toBe("intent");
  });
  it.each(["pi_managed_not_ready", "pi_managed_policy_missing", "pi_managed_model_denied", "pi_managed_admission_closed"])("persists %s preparation rejection before acknowledging its receipt", async code => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request, acknowledge = fixture.port.acknowledgeOperation;
    let preparations = 0;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type !== "prepare_submission") return request(input, signal);
      preparations++;
      const outcome = { status: "failed" as const, failure: { code, delivery: "rejected" as const } };
      fixture.outcomes.set(input.operationId, outcome); return outcome;
    };
    fixture.port.acknowledgeOperation = async (input, signal) => {
      if (input.operationId === "rejected-prepare:prepare:0")
        expect(operations.getOperation(conversation.scope, "thread", "rejected-prepare")).toMatchObject({ state: "completed", receiptJson: JSON.stringify({ outcome: "not_applied" }) });
      return acknowledge(input, signal);
    };
    const input = submission("rejected-prepare");
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: false, retryable: false, category: "rejected", backendCode: code });
    expect(fixture.outcomes.has("rejected-prepare:prepare:0")).toBe(false);
    expect(fixture.state.operations).toEqual([]);
    const unavailable = vi.fn(async () => { throw new Error("native reads unavailable"); });
    fixture.port.request = unavailable; fixture.port.readHistory = unavailable;
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: false, backendCode: "pi_native_operation_not_applied" });
    expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toEqual({ status: "not_accepted", retryable: false });
    expect(unavailable).not.toHaveBeenCalled(); expect(preparations).toBe(1);
  });
  it.each(["pi_managed_operation_exists", "pi_managed_persistence_error"])("does not turn %s into proof of an unconsumed input", async code => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request; let preparations = 0;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type !== "prepare_submission") return request(input, signal);
      preparations++;
      const outcome = { status: "failed" as const, failure: { code, delivery: "rejected" as const } };
      fixture.outcomes.set(input.operationId, outcome); return outcome;
    };
    const input = submission("uncertain-prepare");
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true, retryable: false, backendCode: code });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)).toMatchObject({ state: "unknown", dispatchStarted: false });
    expect(fixture.outcomes.has("uncertain-prepare:prepare:0")).toBe(true);
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toMatchObject({ status: "unresolved" });
    expect(preparations).toBe(1);
  });
  it("retains an existing-operation conflict as a fence against withdrawing its native intent", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation); const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.command.command.type !== "prepare_submission") return result;
      const rejected = { status: "failed" as const, failure: { code: "pi_managed_operation_exists", delivery: "rejected" as const } };
      fixture.outcomes.set(input.operationId, rejected); return rejected;
    };
    const input = submission("existing-intent");
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await expect(driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId }))
      .rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(fixture.commands.some(command => command.type === "complete_submission")).toBe(false);
    expect(fixture.state.operations[0]?.phase).toBe("intent");
  });
  it.each(["lost_before", "lost_after"] as const)("retains rejected preparation proof across restart when acknowledgement is %s", async loss => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const original = await driver.attach(conversation);
    const request = fixture.port.request, acknowledge = fixture.port.acknowledgeOperation;
    let loseAcknowledgement = true; let preparations = 0;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type !== "prepare_submission") return request(input, signal);
      preparations++;
      const outcome = { status: "failed" as const, failure: { code: "pi_managed_admission_closed", delivery: "rejected" as const } };
      fixture.outcomes.set(input.operationId, outcome); return outcome;
    };
    fixture.port.acknowledgeOperation = async (input, signal) => {
      if (input.operationId === "rejected-prepare:prepare:0") {
        expect(operations.getOperation(conversation.scope, "thread", "rejected-prepare")?.state).toBe("completed");
        if (loseAcknowledgement) {
          if (loss === "lost_after") await acknowledge(input, signal);
          throw new PiNativeError("acknowledgement_lost");
        }
      }
      return acknowledge(input, signal);
    };
    const input = submission("rejected-prepare");
    await expect(original.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await driver.close(); loseAcknowledgement = false;
    fixture.port.attach = async () => ({ ...attachment, retainedOperationIds: [...fixture.outcomes.keys()] });
    const resumedDriver = setup({ port: fixture.port, operations }).driver;
    const resumed = await resumedDriver.attach(conversation);
    expect(fixture.outcomes.has("rejected-prepare:prepare:0")).toBe(false);
    await expect(resumed.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: false, backendCode: "pi_native_operation_not_applied" });
    expect(await resumedDriver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toEqual({ status: "not_accepted", retryable: false });
    expect(preparations).toBe(1); expect(fixture.state.operations).toEqual([]);
  });
  it("recovers existing native acceptance instead of treating operation_exists as a new rejection", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request; let preparations = 0;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type !== "prepare_submission") return request(input, signal);
      preparations++;
      const result = await request(input, signal);
      if (result.status !== "completed") throw new Error("Unexpected preparation result");
      const prepared = result.result as { wireText: string };
      await request({ handleId: attachment.handleId, operationId: "existing-dispatch", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: prepared.wireText } } });
      const outcome = { status: "failed" as const, failure: { code: "pi_managed_operation_exists", delivery: "rejected" as const } };
      fixture.outcomes.set(input.operationId, outcome); return outcome;
    };
    const input = submission("existing-input");
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true, backendCode: "pi_managed_operation_exists" });
    expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toEqual({ status: "accepted", completionIdentity: input.applicationOperationId });
    await expect(handle.submit(input)).resolves.toMatchObject({ accepted: true });
    expect(preparations).toBe(1); expect(fixture.commands.filter(command => command.type === "prompt")).toHaveLength(1);
  });
  it("releases repeated rejected native preparations so Stop retains capacity", async () => {
    const fixture = new NativeFixture(); const operations = operationStore(); let preparations = 0;
    let releaseClear: (() => void) | undefined;
    const invoke = async (channel: "rpc" | "companion", command: Readonly<Record<string, unknown>>) => {
      if (command.type === "prepare_submission") { preparations++; throw new PiRpcCallError("pi_managed_admission_closed", "rejected"); }
      if (command.type === "clear_queue") await new Promise<void>(resolve => { releaseClear = resolve; });
      const outcome = await fixture.port.request({ handleId: "native", operationId: randomUUID(), retainOutcome: false, command: { channel, command } });
      if (outcome.status !== "completed") throw new Error("Unexpected fixture outcome");
      return outcome.result;
    };
    const host = new PiNativeHost({ configuration: { tenantId: "tenant", principalId: "principal", backendInstanceId: instance.id,
      executionEnvironmentId: "environment", initializationTimeoutMs: 1000, projectTrusted: false },
      channels: {} as ExecutionEnvironmentChannelProvider, environment: {}, authenticationKey: Buffer.alloc(32, 1),
      acquireWriter: async () => ({ release: async () => {} }), observationWaitMs: 5, maximumOperations: 5,
      store: { resolveSessionDirectory: () => fixture.port.resolveSessionDirectory({ cwd: native.cwd }), create: fixture.port.create, fork: fixture.port.fork, reconcileFork: fixture.port.reconcileFork,
        listSessions: fixture.port.listSessions, readHistory: fixture.port.readHistory },
      launch: (async () => ({ rpc: { request: (command: Readonly<Record<string, unknown>>) => invoke("rpc", command),
        respondUI: async () => {}, closed: new Promise(() => {}) },
        bridge: { request: (command: Readonly<Record<string, unknown>>) => invoke("companion", command), closed: new Promise(() => {}) },
        close: async () => {}, version: "1.4.0" })) as unknown as PiNativeSessionLauncher });
    const { driver } = setup({ port: host, operations }); const handle = await driver.attach(conversation);
    for (let index = 0; index < 12; index++) {
      const input = submission(`rejection-${index}`);
      await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: false, backendCode: "pi_managed_admission_closed" });
      expect(host.snapshot().retainedSessions[0]!.retainedOperationIds).toEqual([]);
      expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toEqual({ status: "not_accepted", retryable: false });
    }
    expect(preparations).toBe(12); expect(fixture.state.operations).toEqual([]);
    fixture.state = { ...fixture.state, entries: [user("active", null)], leafId: "active", isIdle: false };
    const stop = { applicationOperationId: "stop-after-rejections", deadlineAt: Date.now() + 5_000 };
    const stopping = handle.interrupt(stop);
    await vi.waitFor(() => expect(releaseClear).toBeDefined());
    const { source: _source, ...steer } = submission("steer-during-stop");
    try {
      await expect(handle.steer({ ...steer, target: { kind: "turn", turnId: "active" } }))
        .rejects.toMatchObject({ crossedSubmissionBoundary: false, backendCode: "pi_managed_admission_closed" });
      expect(operations.getOperation(conversation.scope, "thread", steer.applicationOperationId)).toMatchObject({ state: "completed", dispatchStarted: false });
    } finally { releaseClear!(); }
    await expect(stopping).resolves.toBeUndefined();
    expect(await handle.reconcileInterrupt(stop)).toEqual({ outcome: "accepted" });
    await vi.waitFor(() => expect(host.snapshot().retainedSessions[0]!.retainedOperationIds).toEqual([]));
    expect(fixture.commands.filter(command => ["begin_stop", "clear_queue", "abort", "end_stop"].includes(command.type))).toHaveLength(4);
    await handle.close();
    await expect(driver.releaseConversationResidency(conversation)).resolves.toBe("released");
  });
  it.each(["delivered", "lost_before", "lost_after"] as const)("retries a host-retained unsent prepare with a distinct durable attempt when its ACK is %s", async acknowledgement => {
    const fixture = new NativeFixture(); const operations = operationStore(); let blocked = true;
    const invoke = async (channel: "rpc" | "companion", command: Readonly<Record<string, unknown>>) => {
      if (command.type === "prepare_submission" && blocked) throw new PiRpcCallError("pi_managed_pending_limit", "not_sent");
      const outcome = await fixture.port.request({ handleId: "native", operationId: randomUUID(), retainOutcome: false, command: { channel, command } });
      if (outcome.status !== "completed") throw new Error("Unexpected fixture outcome");
      return outcome.result;
    };
    const host = new PiNativeHost({ configuration: { tenantId: "tenant", principalId: "principal", backendInstanceId: instance.id,
      executionEnvironmentId: "environment", initializationTimeoutMs: 1000, projectTrusted: false },
      channels: {} as ExecutionEnvironmentChannelProvider, environment: {}, authenticationKey: Buffer.alloc(32, 1),
      acquireWriter: async () => ({ release: async () => {} }), observationWaitMs: 5,
      store: { resolveSessionDirectory: () => fixture.port.resolveSessionDirectory({ cwd: native.cwd }), create: fixture.port.create, fork: fixture.port.fork, reconcileFork: fixture.port.reconcileFork,
        listSessions: fixture.port.listSessions, readHistory: fixture.port.readHistory },
      launch: (async () => ({ rpc: { request: (command: Readonly<Record<string, unknown>>) => invoke("rpc", command),
        respondUI: async () => {}, closed: new Promise(() => {}) },
        bridge: { request: (command: Readonly<Record<string, unknown>>) => invoke("companion", command), closed: new Promise(() => {}) },
        close: async () => {}, version: "1.4.0" })) as unknown as PiNativeSessionLauncher });
    const acknowledge = host.acknowledgeOperation.bind(host); let loseAcknowledgement = acknowledgement !== "delivered";
    host.acknowledgeOperation = async (input, signal) => {
      if (input.operationId === "submit:prepare:0" && loseAcknowledgement) {
        loseAcknowledgement = false;
        if (acknowledgement === "lost_after") await acknowledge(input, signal);
        throw new PiNativeError("pi_native_connection_lost");
      }
      return acknowledge(input, signal);
    };
    const requests = vi.spyOn(host, "request");
    const { driver } = setup({ port: host, operations });
    let handle = await driver.attach(conversation);
    await expect(handle.submit(submission())).rejects.toMatchObject({ backendCode: "pi_managed_pending_limit", retryable: true, crossedSubmissionBoundary: false });
    expect(operations.getOperation(conversation.scope, "thread", "submit")).toMatchObject({ state: "prepared", prepareAttempt: 1 });
    if (acknowledgement === "lost_before") {
      await handle.close();
      handle = await driver.attach(conversation);
    }
    blocked = false;
    await handle.submit(submission());
    expect(requests.mock.calls.filter(([request]) => request.command.command.type === "prepare_submission").map(([request]) => request.operationId))
      .toEqual(["submit:prepare:0", "submit:prepare:1"]);
    expect(fixture.state.operations).toHaveLength(1);
    expect(fixture.commands.filter(command => command.type === "prompt")).toHaveLength(1);
    expect(operations.getOperation(conversation.scope, "thread", "submit")).toMatchObject({ state: "completed", prepareAttempt: 1 });
    const nativeHandle = host.snapshot().retainedSessions[0]!;
    await acknowledge({ handleId: nativeHandle.handleId, operationId: "submit:prepare:0" });
    await expect(host.request(requests.mock.calls.find(([request]) => request.operationId === "submit:prepare:1")![0]))
      .rejects.toMatchObject({ code: "pi_native_operation_acknowledged" });
    await handle.close();
  });
  it("denies cross-principal attachment before native side effects", async () => {
    const { driver, fixture } = setup();
    await expect(driver.attach({ ...conversation, scope: { ...conversation.scope, principalId: "other" } })).rejects.toThrow();
    expect(fixture.attachCount).toBe(0); expect(fixture.commands).toEqual([]);
  });
  it("reads detached history and reconciles exact input without loading native extensions", async () => {
    const { driver, fixture } = setup(); fixture.state = { ...fixture.state, entries: [user("u", null), answer("a", "u")], leafId: "a" };
    const reader = await driver.openHistory(conversation);
    expect((await reader.history({ limit: 10 })).orderedBackendTurnIds).toEqual(["u"]);
    await reader.close(); expect(fixture.attachCount).toBe(0); expect(fixture.commands).toEqual([]);
  });
  it("replays a completed submission without prompting again and rejects altered input", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation);
    const result = await handle.submit(submission()); expect(result.backendTurnId).toBe("user:submit");
    expect(await handle.submit(submission())).toEqual(result);
    await expect(handle.submit({ ...submission(), text: "Changed" })).rejects.toThrow("operation_replay_mismatch");
    expect(fixture.commands.filter(item => item.type === "prompt")).toHaveLength(1);
    expect(fixture.outcomes.has("submit:dispatch")).toBe(false);
  });
  it("does not re-prompt a submission whose native outcome is unknown", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation); fixture.abortPrompt = true;
    await expect(handle.submit(submission())).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    fixture.abortPrompt = false;
    await expect(handle.submit(submission())).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(fixture.commands.filter(item => item.type === "prompt")).toHaveLength(1);
  });
  it.each(["complete_submission", "get_submission", "snapshot"] as const)("keeps a dispatched submission crossed when later %s is refused", async phase => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request; let dispatched = false; let rejectPhase = true; let rejectRetrySnapshot = false;
    fixture.port.request = async (input, signal) => {
      const type = input.command.command.type;
      if (dispatched && ((rejectPhase && type === phase) || (rejectRetrySnapshot && type === "snapshot")))
        throw new PiNativeError("later_request_refused", "not_sent");
      const result = await request(input, signal);
      if (type === "prompt") dispatched = true;
      return result;
    };
    const input = submission("compound-submit");
    await expect(handle.submit(input)).rejects.toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false, backendCode: "later_request_refused" });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)?.state).toBe(phase === "snapshot" ? "completed" : "sent");
    expect(fixture.commands.some(command => command.type === "complete_submission" && command.command.disposition === "rejected")).toBe(false);
    rejectPhase = false; rejectRetrySnapshot = true;
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true, backendCode: "later_request_refused" });
    rejectRetrySnapshot = false;
    await expect(handle.submit(input)).resolves.toMatchObject({ accepted: true, completionCorrelation: input.applicationOperationId });
    expect(fixture.commands.filter(command => command.type === "prompt")).toHaveLength(1);
  });
  it.each(["compact", "rename"] as const)("keeps an applied %s crossed when its verification snapshot is refused", async action => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request; let applied = false; let rejectSnapshot = true;
    const type = action === "compact" ? "compact" : "set_session_name";
    fixture.port.request = async (input, signal) => {
      if (applied && rejectSnapshot && input.command.command.type === "snapshot") throw new PiNativeError("snapshot_refused", "not_sent");
      const result = await request(input, signal);
      if (input.command.command.type === type) applied = true;
      return result;
    };
    const input = action === "compact" ? { action, applicationOperationId: "compound-action" }
      : { action, applicationOperationId: "compound-action", title: "Renamed" };
    await expect(handle.perform(input)).rejects.toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false, backendCode: "snapshot_refused" });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)).toMatchObject({ state: "sent", receiptJson: null });
    await expect(handle.reconcileAction(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true, backendCode: "snapshot_refused" });
    rejectSnapshot = false;
    expect(await handle.reconcileAction(input)).toEqual({ outcome: "accepted" });
    await expect(handle.perform(input)).resolves.toMatchObject({ accepted: true });
    expect(fixture.commands.filter(command => command.type === type)).toHaveLength(1);
  });
  it("keeps an applied tool policy crossed when the following catalog snapshot is refused", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request; let policyApplied = false;
    fixture.port.request = async (input, signal) => {
      if (policyApplied && input.command.command.type === "snapshot") throw new PiNativeError("snapshot_refused", "not_sent");
      const result = await request(input, signal);
      if (input.operationId === "compound-policy:policy") policyApplied = true;
      return result;
    };
    const input = { action: "set_tool_access" as const, mode: "read_only", applicationOperationId: "compound-policy" };
    await expect(handle.perform(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true, backendCode: "snapshot_refused" });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)).toMatchObject({ state: "sent", receiptJson: null });
    expect(await handle.reconcileAction(input)).toEqual({ outcome: "unknown" });
    await expect(handle.perform(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(fixture.commands.filter(command => command.id === "compound-policy:policy")).toHaveLength(1);
    expect(fixture.commands.some(command => command.id === "compound-policy:tools")).toBe(false);
  });
  it.each(["submit", "action"] as const)("preserves a genuine %s preflight refusal", async kind => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type === "snapshot") throw new PiNativeError("preflight_refused", "not_sent");
      return request(input, signal);
    };
    const result = kind === "submit" ? handle.submit(submission("preflight")) : handle.perform({ action: "compact", applicationOperationId: "preflight" });
    await expect(result).rejects.toMatchObject({ crossedSubmissionBoundary: false, category: "unavailable", backendCode: "preflight_refused" });
    expect(operations.getOperation(conversation.scope, "thread", "preflight")?.state).toBe(kind === "submit" ? undefined : "prepared");
    expect(fixture.commands.some(command => command.type === "prompt" || command.type === "compact")).toBe(false);
  });
  it.each(["model", "thinking"] as const)("verifies applied settings after an older %s snapshot finishes", async stale => {
    const settings = { modelProvider: "provider", modelId: "model", thinkingLevel: "medium", toolMode: "full" as const, revision: 1 };
    const { driver, fixture } = setup({ settings: { getSettings: () => settings } });
    const handle = await driver.attach(conversation);
    fixture.commands.length = 0;
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(accept => { resolve = accept; });
      return { promise, resolve };
    };
    const snapshotStarted = deferred();
    const releaseSnapshot = deferred();
    const settingsApplied = deferred();
    const request = fixture.port.request;
    let captureSnapshot = false;
    let oldSnapshot: PiManagedState | undefined;
    const admitted: { model: PiManagedState["model"]; thinkingLevel: string | undefined }[] = [];
    fixture.port.request = async (input, signal) => {
      const type = input.command.command.type;
      if (type === "set_model") {
        // Stock Pi reapplies its native thinking default even for the same model.
        // Also cover a read captured before a different model finishes applying.
        fixture.state = { ...fixture.state, ...(stale === "thinking" ? { thinkingLevel: "xhigh" }
          : { model: { provider: "old-provider", id: "old-model" } }) };
        captureSnapshot = true;
        fixture.push({ kind: "companion", payload: { type: "state_changed" } });
        await snapshotStarted.promise;
      }
      if (type === "snapshot" && captureSnapshot && !oldSnapshot) {
        oldSnapshot = structuredClone(fixture.state);
        const result = await request(input, signal);
        snapshotStarted.resolve();
        await releaseSnapshot.promise;
        return result;
      }
      if (type === "prepare_submission") admitted.push({ model: fixture.state.model, thinkingLevel: fixture.state.thinkingLevel });
      const result = await request(input, signal);
      if (type === "set_thinking_level") settingsApplied.resolve();
      return result;
    };
    const submitting = handle.submit(submission("fresh-settings"));
    void submitting.catch(() => undefined);
    try {
      await settingsApplied.promise;
      // Drain the completed settings RPC's continuations while the older read
      // remains held, so verification must encounter that in-flight snapshot.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(fixture.state).toMatchObject({ model: { provider: "provider", id: "model" }, thinkingLevel: "medium" });
      expect(oldSnapshot).toMatchObject(stale === "thinking" ? { thinkingLevel: "xhigh" }
        : { model: { provider: "old-provider", id: "old-model" } });
      expect(admitted).toEqual([]);
      releaseSnapshot.resolve();
      await expect(submitting).resolves.toMatchObject({ backendTurnId: "user:fresh-settings" });
      expect(admitted).toEqual([{ model: { provider: "provider", id: "model" }, thinkingLevel: "medium" }]);
      expect(fixture.commands.filter(command => command.type === "prompt")).toHaveLength(1);
    } finally {
      snapshotStarted.resolve(); releaseSnapshot.resolve();
      await submitting.catch(() => undefined);
    }
  });
  it.each(["model", "thinking"] as const)("rejects a genuine applied %s mismatch before admitting a prompt", async mismatch => {
    const operations = operationStore();
    const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    fixture.commands.length = 0;
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (mismatch === "model" && input.command.command.type === "set_model")
        fixture.state = { ...fixture.state, model: { provider: "other-provider", id: "other-model" } };
      if (mismatch === "thinking" && input.command.command.type === "set_thinking_level")
        fixture.state = { ...fixture.state, thinkingLevel: "off" };
      return result;
    };
    await expect(handle.submit(submission("settings-mismatch"))).rejects.toMatchObject({
      backendCode: "pi_native_settings_not_applied", crossedSubmissionBoundary: false,
    });
    expect(operations.getOperation(conversation.scope, "thread", "settings-mismatch"))
      .toMatchObject({ state: "prepared", dispatchStarted: false });
    expect(fixture.commands.some(command => command.type === "prepare_submission" || command.type === "prompt")).toBe(false);
  });
  it.each([
    { kind: "submit", type: "snapshot" },
    { kind: "submit", type: "set_policy" },
    { kind: "submit", type: "set_model" },
    { kind: "submit", type: "set_thinking_level" },
    { kind: "slash", type: "get_commands" },
    { kind: "picker", type: "get_commands" },
    { kind: "action", type: "snapshot" },
    { kind: "tool_access", type: "get_available_models" },
  ] as const)("keeps $kind retryable when auxiliary $type completion is unknown", async ({ kind, type }) => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request; let fail = true; let auxiliaryId: string | undefined;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (fail && input.command.command.type === type) {
        auxiliaryId = input.operationId;
        throw new PiNativeError("auxiliary_reply_lost", "sent_outcome_unknown");
      }
      return result;
    };
    const acknowledge = vi.spyOn(fixture.port, "acknowledgeOperation");
    const input = { ...submission("auxiliary-failure"), ...(kind === "slash" ? { text: "/review" } : {}),
      ...(kind === "picker" ? { selectedSkillId: (await driver.catalog(conversation)).skills[0]!.id } : {}) };
    const action = kind === "tool_access"
      ? { action: "set_tool_access" as const, mode: "read_only", applicationOperationId: input.applicationOperationId }
      : { action: "compact" as const, applicationOperationId: input.applicationOperationId };
    const isAction = kind === "action" || kind === "tool_access";
    await expect(isAction ? handle.perform(action) : handle.submit(input)).rejects.toMatchObject({
      category: "unavailable", crossedSubmissionBoundary: false, retryable: true, backendCode: "auxiliary_reply_lost",
    });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)?.state)
      .toBe(kind === "submit" && type === "snapshot" ? undefined : "prepared");
    expect(fixture.commands.some(command => command.type === "prepare_submission" || command.type === "prompt" || command.type === "compact" || command.id === `${input.applicationOperationId}:policy`)).toBe(false);
    if (type.startsWith("set_")) {
      expect(fixture.outcomes.has(auxiliaryId!)).toBe(true);
      expect(acknowledge.mock.calls.some(([value]) => value.operationId === auxiliaryId)).toBe(false);
    } else expect(fixture.port.abandonObservation).toHaveBeenCalledWith({ handleId: attachment.handleId, operationId: auxiliaryId }, expect.any(AbortSignal));
    const requestsBeforeReconcile = fixture.commands.length;
    if (isAction) expect(await handle.reconcileAction(action)).toEqual({ outcome: "not_applied" });
    else expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toEqual({ status: "not_accepted", retryable: true });
    expect(fixture.commands).toHaveLength(requestsBeforeReconcile);
    fail = false;
    await expect(isAction ? handle.perform(action) : handle.submit(input)).resolves.toMatchObject({ accepted: true });
    expect(fixture.commands.filter(command => command.type === "prepare_submission" || command.type === "compact" || command.id === `${input.applicationOperationId}:policy`)).toHaveLength(1);
  });
  it("keeps a timed-out auxiliary read owned while its unsent submission remains retryable", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request; let readId: string | undefined;
    fixture.port.request = vi.fn(async (input, signal) => {
      if (input.command.command.type === "snapshot") {
        readId = input.operationId;
        throw new PiNativeError("snapshot_pending", "sent_outcome_unknown");
      }
      return request(input, signal);
    });
    fixture.port.abandonObservation = vi.fn(async () => "pending" as const);
    const input = submission("pending-auxiliary");
    await expect(handle.submit(input)).rejects.toMatchObject({ category: "unavailable", crossedSubmissionBoundary: false, retryable: true });
    await expect(handle.submit(input)).rejects.toMatchObject({ backendCode: "pi_native_observation_pending", crossedSubmissionBoundary: false, retryable: true });
    expect(fixture.port.request).toHaveBeenCalledTimes(1);
    expect(fixture.port.abandonObservation).toHaveBeenCalledTimes(2);
    expect(fixture.port.abandonObservation).toHaveBeenLastCalledWith({ handleId: attachment.handleId, operationId: readId }, expect.any(AbortSignal));
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)).toBeUndefined();
    expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toEqual({ status: "not_accepted", retryable: true });
  });
  it.each(["native", "transport"] as const)("keeps the submission unsent after a %s setup acknowledgement failure", async kind => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const acknowledge = fixture.port.acknowledgeOperation;
    fixture.port.acknowledgeOperation = async (input, signal) => {
      if (fixture.commands.find(command => command.id === input.operationId)?.type === "set_model")
        throw kind === "native" ? new PiNativeError("setup_acknowledgement_lost", "sent_outcome_unknown") : new Error("setup transport closed");
      return acknowledge(input, signal);
    };
    await expect(handle.submit(submission("setup-ack"))).rejects.toMatchObject({
      crossedSubmissionBoundary: false, retryable: true, category: "unavailable", backendCode: kind === "native" ? "setup_acknowledgement_lost" : "pi_native_operation_unknown",
    });
    expect(operations.getOperation(conversation.scope, "thread", "setup-ack")?.state).toBe("prepared");
    expect(fixture.commands.some(command => command.type === "prepare_submission")).toBe(false);
  });
  it.each(["policy", "tools"] as const)("keeps the action dispatched after its own %s reply is lost", async phase => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.operationId === `own-policy:${phase}`) throw new PiNativeError("policy_reply_lost", "sent_outcome_unknown");
      return result;
    };
    const input = { action: "set_tool_access" as const, mode: "read_only", applicationOperationId: "own-policy" };
    await expect(handle.perform(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true, retryable: false, category: "submission_unknown", backendCode: "policy_reply_lost" });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)?.state).toBe("sent");
    expect(await handle.reconcileAction(input)).toEqual({ outcome: phase === "tools" ? "accepted" : "unknown" });
    if (phase === "policy") await expect(handle.perform(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    else await expect(handle.perform(input)).resolves.toMatchObject({ accepted: true });
    expect(fixture.commands.filter(command => command.id === "own-policy:policy")).toHaveLength(1);
  });
  it("reconciles durable prepared work after reconnect without consulting unavailable native state", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type === "get_commands") throw new PiNativeError("commands_unavailable", "sent_outcome_unknown");
      return request(input, signal);
    };
    const input = { ...submission("prepared-submission"), selectedSkillId: (await driver.catalog(conversation)).skills[0]!.id };
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: false, retryable: true });
    const action = { action: "compact" as const, applicationOperationId: "prepared-action" };
    fixture.port.request = async () => { throw new PiNativeError("snapshot_unavailable", "sent_outcome_unknown"); };
    await expect(handle.perform(action)).rejects.toMatchObject({ crossedSubmissionBoundary: false, retryable: true });
    await driver.close();
    fixture.port.request = request;
    const resumed = setup({ port: fixture.port, operations }).driver;
    const resumedHandle = await resumed.attach(conversation);
    const read = vi.spyOn(fixture.port, "readHistory").mockRejectedValue(new Error("native history unavailable"));
    const nativeRequest = vi.spyOn(fixture.port, "request").mockRejectedValue(new Error("native request unavailable"));
    const outcome = vi.spyOn(fixture.port, "outcome").mockRejectedValue(new Error("native receipt unavailable"));
    expect(await resumed.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId })).toEqual({ status: "not_accepted", retryable: true });
    expect(await resumedHandle.reconcileAction(action)).toEqual({ outcome: "not_applied" });
    expect(read).not.toHaveBeenCalled(); expect(nativeRequest).not.toHaveBeenCalled(); expect(outcome).not.toHaveBeenCalled();
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)?.state).toBe("prepared");
    expect(operations.getOperation(conversation.scope, "thread", action.applicationOperationId)?.state).toBe("prepared");
  });
  it.each(["matching", "different"] as const)("checks %s no-effect evidence for a refused prompt and its replay", async identity => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation);
    const request = fixture.port.request; let prompts = 0;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type === "prompt") { prompts++; throw new PiNativeError("prompt_refused", "not_sent"); }
      const result = await request(input, signal);
      if (identity === "different" && input.command.command.type === "complete_submission" && result.status === "completed") {
        const operation = result.result as PiManagedOperation;
        return { status: "completed", result: { ...operation, input: { ...operation.input, mutationId: "other" } } };
      }
      return result;
    };
    const input = submission("refused-prompt");
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: identity === "different", backendCode: "prompt_refused" });
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: false, backendCode: "pi_native_submission_not_materialized" });
    expect(fixture.state.operations.find(operation => operation.input.operationId === input.applicationOperationId)?.phase).toBe("rejected");
    expect(prompts).toBe(1);
  });
  it("preserves authoritative no-effect evidence for the first tool-policy command", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      if (input.operationId === "refused-policy:policy") throw new PiNativeError("policy_refused", "not_sent");
      return request(input, signal);
    };
    const input = { action: "set_tool_access" as const, mode: "read_only", applicationOperationId: "refused-policy" };
    await expect(handle.perform(input)).rejects.toMatchObject({ crossedSubmissionBoundary: false, backendCode: "policy_refused" });
    expect(await handle.reconcileAction(input)).toEqual({ outcome: "not_applied" });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)).toMatchObject({ state: "completed", receiptJson: JSON.stringify({ outcome: "not_applied" }) });
  });
  it("preserves a verified rejected submission when its final snapshot is refused", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request; let settled = false;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type === "prompt") return { status: "completed", result: { disposition: "handled" } };
      if (settled && input.command.command.type === "snapshot") throw new PiNativeError("snapshot_refused", "not_sent");
      const result = await request(input, signal);
      if (input.command.command.type === "complete_submission") settled = true;
      return result;
    };
    await expect(handle.submit(submission("handled"))).rejects.toMatchObject({ crossedSubmissionBoundary: false, backendCode: "snapshot_refused" });
    expect(JSON.parse(operations.getOperation(conversation.scope, "thread", "handled")!.receiptJson!)).toMatchObject({ phase: "rejected" });
  });
  it("keeps Stop crossed when a command after accepted begin_stop is refused", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const handle = await driver.attach(conversation);
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type === "clear_queue") throw new PiNativeError("clear_refused", "not_sent");
      return request(input, signal);
    };
    const input = { applicationOperationId: "compound-stop", deadlineAt: Date.now() + 5_000 };
    await expect(handle.interrupt(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true, backendCode: "clear_refused" });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)).toMatchObject({ state: "sent", receiptJson: null });
    expect(await handle.reconcileInterrupt(input)).toEqual({ outcome: "unknown" });
  });
  it("keeps each queued Steer unresolved until Stop proves it was lost", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation); await handle.submit(submission());
    const { source: _source, ...steer } = submission("steer");
    expect(await handle.steer({ ...steer, target: { kind: "turn", turnId: "user:submit" } })).toMatchObject({ status: "pending_materialization" });
    const stop = { applicationOperationId: "stop", deadlineAt: Date.now() + 10_000 };
    await handle.interrupt(stop); expect(await handle.reconcileInterrupt(stop)).toEqual({ outcome: "accepted" }); await handle.interrupt(stop);
    expect(fixture.state.operations.find(item => item.input.operationId === "steer")?.phase).toBe("lost");
    expect(fixture.state.operations.find(item => item.input.operationId === "submit")?.phase).toBe("accepted");
    expect(fixture.commands.filter(item => item.type === "abort")).toHaveLength(1);
    await expect(handle.steer({ ...steer, target: { kind: "turn", turnId: "user:submit" } })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
  });
  it.each(["pending", "abandoned"] as const)("accepts normal Stop independently of a %s snapshot", async observation => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    const handle = await driver.attach(conversation);
    const request = fixture.port.request; let readId: string | undefined; let readCount = 0; let hold = true;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type !== "snapshot") return request(input, signal);
      readCount++; readId = input.operationId;
      const pending = { status: "pending" as const }; fixture.outcomes.set(input.operationId, pending); return pending;
    };
    fixture.port.abandonObservation = async input => {
      if (hold && input.operationId === readId) return "pending";
      fixture.outcomes.delete(input.operationId); return "released";
    };
    const controller = new AbortController();
    const reading = companion(fixture.port, attachment, { type: "snapshot" }, undefined, controller.signal);
    const settled = reading.then(value => ({ value }), error => ({ error }));
    try {
      await vi.waitFor(() => expect(readId).toBeDefined());
      if (observation === "abandoned") {
        controller.abort();
        expect(await settled).toMatchObject({ error: { crossedSubmissionBoundary: true } });
      }
      const stop = { applicationOperationId: "stop-during-read", deadlineAt: Date.now() + 500 };
      await expect(handle.interrupt(stop)).resolves.toBeUndefined();
      expect(operations.getOperation(conversation.scope, "thread", stop.applicationOperationId)).toMatchObject({ state: "completed", receiptJson: JSON.stringify({ outcome: "accepted" }) });
      expect(await handle.reconcileInterrupt(stop)).toEqual({ outcome: "accepted" });
      expect(readCount).toBe(1);
      expect(fixture.commands.filter(command => ["begin_stop", "clear_queue", "abort", "end_stop"].includes(command.type)).map(command => command.type))
        .toEqual(["begin_stop", "clear_queue", "abort", "end_stop"]);
    } finally {
      hold = false;
      if (readId) fixture.outcomes.set(readId, { status: "completed", result: fixture.state });
      await settled; await handle.close();
    }
  });
  it("keeps an accepted normal Stop successful while receipt cleanup is delayed", async () => {
    const { driver, fixture } = setup();
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    const handle = await driver.attach(conversation);
    const acknowledge = fixture.port.acknowledgeOperation;
    let release!: () => void; const delayed = new Promise<void>(resolve => { release = resolve; });
    fixture.port.acknowledgeOperation = async input => { await delayed; await acknowledge(input); };
    try {
      const stop = { applicationOperationId: "stop-delayed-cleanup", deadlineAt: Date.now() + 500 };
      await expect(handle.interrupt(stop)).resolves.toBeUndefined();
      await expect(handle.interrupt(stop)).resolves.toBeUndefined();
      expect(await handle.reconcileInterrupt(stop)).toEqual({ outcome: "accepted" });
      expect(fixture.commands.filter(command => command.type === "abort")).toHaveLength(1);
      expect(fixture.outcomes.has(`${stop.applicationOperationId}:end`)).toBe(true);
      release();
      await vi.waitFor(() => expect(fixture.outcomes.has(`${stop.applicationOperationId}:end`)).toBe(false));
    } finally { release(); await handle.close(); }
  });
  it("replays durable settings actions after detach and preserves model policy on tool access changes", async () => {
    const { driver, fixture } = setup(); let handle = await driver.attach(conversation);
    const action = { action: "set_tool_access" as const, mode: "read_only", applicationOperationId: "settings" };
    const result = await handle.perform(action); expect(fixture.state.activeTools).toEqual(["read"]);
    const policy = fixture.commands.find(item => item.id === "settings:policy")?.command.policy;
    expect(policy).toMatchObject({ mode: "read_only", allowedModels: [{ provider: "provider", modelId: "model", thinkingLevels: ["off", "minimal", "low", "medium", "high"] }] });
    await handle.close(); handle = await driver.attach(conversation); expect(await handle.perform(action)).toEqual(result);
    expect(fixture.commands.filter(item => item.id === "settings:policy")).toHaveLength(1);
  });
  it("projects in-flight text across native snapshots and later replaces transient items", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation); await handle.submit(submission());
    const events: unknown[] = []; handle.subscribe(event => events.push(event));
    fixture.push({ kind: "rpc", payload: { type: "message_start", message: { role: "assistant" } } });
    fixture.push({ kind: "stream", payload: { type: "message_snapshot", streamId: "message", semanticKind: "assistant_message", contentIndex: 0, text: "Working" } });
    fixture.push({ kind: "companion", payload: { type: "state_changed" } });
    await vi.waitFor(() => expect(JSON.stringify(events)).toContain("Working"));
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    expect(JSON.stringify(established.snapshot)).toContain("Working");
    fixture.push({ kind: "stream", payload: { type: "message_snapshot", streamId: "message", semanticKind: "assistant_message", contentIndex: 0, text: "Working more" } });
    await vi.waitFor(async () => expect(JSON.stringify((await handle.establishProjection({ signal: new AbortController().signal })).snapshot)).toContain("Working more"));
    const replaced = (await handle.establishProjection({ signal: new AbortController().signal })).snapshot;
    expect(JSON.stringify(replaced)).not.toContain("WorkingWorking");
    expect(Object.keys(replaced.itemsById).filter(id => id === "live:message:0")).toHaveLength(1);
    fixture.state = { ...fixture.state, entries: [...fixture.state.entries, answer("a", "user:submit")], leafId: "a", isIdle: true };
    fixture.push({ kind: "rpc", payload: { type: "message_end", message: { role: "assistant" } } });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "history_changed" }));
    const final = await handle.establishProjection({ signal: new AbortController().signal });
    expect(JSON.stringify(final.snapshot)).not.toContain("Working"); expect(final.snapshot.turnsById["user:submit"]?.status).toBe("completed");
  });
  it("reclaims tool steps, rejected nested calls, and delivered notices within a 64 KiB budget", async () => {
    const fixture = new NativeFixture();
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    let emit!: NonNullable<Parameters<PiNativeSessionLauncher>[0]["onEvent"]>;
    const invoke = async (channel: "rpc" | "companion", command: Readonly<Record<string, unknown>>) => {
      if (command.type === "get_state") return fixture.rpcState();
      const outcome = await fixture.port.request({ handleId: "native", operationId: randomUUID(), retainOutcome: false, command: { channel, command } });
      if (outcome.status !== "completed") throw new Error("Unexpected fixture outcome");
      return outcome.result;
    };
    const host = new PiNativeHost({ configuration: { tenantId: "tenant", principalId: "principal", backendInstanceId: instance.id,
      executionEnvironmentId: "environment", initializationTimeoutMs: 1000, projectTrusted: false },
      channels: {} as ExecutionEnvironmentChannelProvider, environment: {}, authenticationKey: Buffer.alloc(32, 1),
      acquireWriter: async () => ({ release: async () => {} }), observationWaitMs: 5, maximumEventBytes: 64 * 1024,
      store: { resolveSessionDirectory: () => fixture.port.resolveSessionDirectory({ cwd: native.cwd }), create: fixture.port.create,
        fork: fixture.port.fork, reconcileFork: fixture.port.reconcileFork, listSessions: fixture.port.listSessions, readHistory: fixture.port.readHistory },
      launch: (async (input: Parameters<PiNativeSessionLauncher>[0]) => { emit = input.onEvent!; return {
        rpc: { request: (command: Readonly<Record<string, unknown>>) => invoke("rpc", command), respondUI: async () => {}, closed: new Promise(() => {}) },
        bridge: { request: (command: Readonly<Record<string, unknown>>) => invoke("companion", command), closed: new Promise(() => {}) },
        close: async () => {}, version: "1.4.0" }; }) as unknown as PiNativeSessionLauncher });
    const acknowledgements = vi.spyOn(host, "acknowledge");
    const { driver } = setup({ port: host }); let handle = await driver.attach(conversation);
    const notices: unknown[] = []; handle.subscribe(event => { if (event.type === "notice") notices.push(event); });
    for (let step = 0; step < 32; step++) {
      const toolCallId = `tool:${step}`; const text = `${step}:` + "x".repeat(4096);
      const assistant = { ...answer(`a:${step}`, fixture.state.leafId!), message: { ...answer("unused", "unused").message,
        content: [{ type: "text" as const, text }, { type: "toolCall" as const, id: toolCallId, name: "codemode", arguments: { code: "return 1" } }], stopReason: "toolUse" as const } };
      emit({ kind: "rpc", payload: { type: "message_start", message: { role: "assistant" } } });
      emit({ kind: "rpc", payload: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } } });
      fixture.state = { ...fixture.state, entries: [...fixture.state.entries, assistant], leafId: assistant.id };
      emit({ kind: "rpc", payload: { type: "message_end", message: assistant.message } });
      emit({ kind: "companion", payload: { type: "state_changed" } });
      emit({ kind: "rpc", payload: { type: "tool_execution_start", toolCallId, toolName: "codemode", args: { code: "return 1" } } });
      for (const [index, rejection] of ["Tool missing not found", "Tool write not found", "Invalid arguments for read"].entries()) {
        const child = `${toolCallId}/${index + 1}`;
        emit({ kind: "rpc", payload: { type: "tool_execution_start", toolCallId: child, parentToolCallId: toolCallId, toolName: "read", args: {} } });
        emit({ kind: "rpc", payload: { type: "tool_execution_end", toolCallId: child, parentToolCallId: toolCallId,
          result: { content: [{ type: "text", text: rejection }] }, isError: true } });
      }
      const result = { content: [{ type: "text" as const, text: `result:${text}` }] };
      emit({ kind: "rpc", payload: { type: "tool_execution_update", toolCallId, partialResult: result } });
      const entry = { id: `r:${step}`, parentId: assistant.id, type: "message" as const, timestamp: time,
        message: { role: "toolResult" as const, toolCallId, toolName: "codemode", ...result, isError: false, timestamp: Date.parse(time) } };
      fixture.state = { ...fixture.state, entries: [...fixture.state.entries, entry], leafId: entry.id };
      emit({ kind: "rpc", payload: { type: "tool_execution_end", toolCallId, result, isError: false } });
      emit({ kind: "rpc", payload: { type: "extension_error", error: `Extension warning ${step}` } });
      emit({ kind: "companion", payload: { type: "state_changed" } });
      const through = host.snapshot().retainedSessions[0]!.throughSequence;
      await vi.waitFor(() => expect(acknowledgements.mock.calls.at(-1)?.[0].throughSequence).toBe(through));
      expect(fixture.state.isIdle).toBe(false);
      expect(host.snapshot().blockers).not.toContain("unknown_state");
    }
    expect(notices).toHaveLength(32);
    expect(fixture.state.toolCalls).toEqual([]);
    const durableThrough = acknowledgements.mock.calls.at(-1)![0].throughSequence;
    emit({ kind: "rpc", payload: { type: "message_start", message: { role: "assistant" } } });
    emit({ kind: "rpc", payload: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Trailing unpersisted answer" } } });
    emit({ kind: "companion", payload: { type: "state_changed" } });
    await vi.waitFor(async () => expect(JSON.stringify((await handle.establishProjection({ signal: new AbortController().signal })).snapshot)).toContain("Trailing unpersisted answer"));
    expect(acknowledgements.mock.calls.at(-1)![0].throughSequence).toBe(durableThrough);
    await handle.close(); handle = await driver.attach(conversation);
    await vi.waitFor(async () => expect(JSON.stringify((await handle.establishProjection({ signal: new AbortController().signal })).snapshot)).toContain("Trailing unpersisted answer"));
    expect(acknowledgements.mock.calls.at(-1)![0].throughSequence).toBe(durableThrough);
    const previousGeneration = host.snapshot().retainedSessions[0]!.generation;
    const final = { ...answer("final", fixture.state.leafId!), message: { ...answer("unused", "unused").message,
      content: [{ type: "text" as const, text: "Final saved answer" }] } };
    fixture.state = { ...fixture.state, entries: [...fixture.state.entries, final], leafId: final.id, isIdle: true };
    const gapEvents: BackendConversationEvent[] = [];
    handle.subscribe(event => gapEvents.push(event));
    emit({ kind: "rpc", payload: { type: "message_end", message: final.message } });
    emit({ kind: "rpc", payload: { type: "agent_end", messages: fixture.state.entries.filter(entry => entry.type === "message").map(entry => entry.message) } });
    expect(host.snapshot().blockers).toContain("unknown_state");
    await vi.waitFor(() => expect(gapEvents).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" }));
    expect(fixture.commands.some(command => command.type === "abort")).toBe(false);
    await handle.close(); handle = await driver.attach(conversation);
    const recovered: unknown[] = []; const unsubscribe = await subscribeProjection(handle, event => { if (event.type === "notice") recovered.push(event); });
    unsubscribe();
    expect(recovered).toEqual([expect.objectContaining({ notice: expect.objectContaining({ tone: "warning" }) })]);
    expect(host.snapshot().retainedSessions[0]!.generation).not.toBe(previousGeneration);
    expect(host.snapshot().blockers).not.toContain("unknown_state");
    expect(JSON.stringify((await handle.establishProjection({ signal: new AbortController().signal })).snapshot)).toContain("Final saved answer");
    await expect(handle.submit(submission("after-gap"))).resolves.toMatchObject({ accepted: true, completionCorrelation: "after-gap" });
    await handle.close();
  }, 30_000);
  it("pins a native fork to the selected completed turn and rejects a changed boundary", async () => {
    const { driver, fixture } = setup(); fixture.state = { ...fixture.state, entries: [user("u", null), answer("a", "u")], leafId: "a" };
    const checkpoint = await driver.resolveBranchCheckpoint({ ...conversation, selection: { kind: "selected_completed_turn", backendTurnId: "u", boundary: "completed_turn_inclusive" } });
    const input = { ...conversation, sourceBinding: conversation.binding, sourceOpaqueBindingDetail: conversation.opaqueBindingDetail,
      sourceCheckpoint: checkpoint, applicationOperationId: "fork", childApplicationThreadId: "child", requestedBackendConversationId: "child-native", source: { kind: "user" as const },
      inheritedSettings: { model: { provider: "provider", id: "model" }, thinkingLevel: "high", toolAccess: "read_only" as const } };
    expect((await driver.branchConversation(input)).backendConversationId).toBe("child-native");
    expect(fixture.port.fork).toHaveBeenCalledWith(expect.objectContaining({ sourceEntryId: "a", childSessionId: "child-native", inheritedSettings: input.inheritedSettings }));
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u" };
    await expect(driver.branchConversation(input)).rejects.toThrow();
    expect(fixture.port.fork).toHaveBeenCalledTimes(1);
  });
  it("admits new fork settings under current policy but reconciles exact existing children first", async () => {
    const policy = { ...compileBackendModelPolicy({ type: "catalog" }, "provider_model_effort"), isSelectionAllowed: vi.fn(() => false) };
    const { driver, fixture } = setup({ modelPolicy: policy });
    fixture.state = { ...fixture.state, entries: [user("u", null), answer("a", "u")], leafId: "a" };
    const checkpoint = await driver.resolveBranchCheckpoint({ ...conversation, selection: { kind: "selected_completed_turn", backendTurnId: "u", boundary: "completed_turn_inclusive" } });
    const input = { ...conversation, sourceBinding: conversation.binding, sourceOpaqueBindingDetail: conversation.opaqueBindingDetail,
      sourceCheckpoint: checkpoint, applicationOperationId: "fork", childApplicationThreadId: "child", requestedBackendConversationId: "child-native", source: { kind: "user" as const },
      inheritedSettings: { model: { provider: "provider", id: "model" }, thinkingLevel: "high", toolAccess: "read_only" as const } };
    fixture.port.readHistory = vi.fn(async () => { throw new Error("source_removed"); });
    await expect(driver.branchConversation(input)).rejects.toMatchObject({ backendCode: "pi_native_model_policy_denied" });
    expect(fixture.port.readHistory).not.toHaveBeenCalled(); expect(fixture.port.fork).not.toHaveBeenCalled();
    fixture.port.reconcileFork = vi.fn(async () => ({ ...native, sessionId: "child-native" }));
    policy.isSelectionAllowed.mockClear();
    await expect(driver.branchConversation(input)).resolves.toMatchObject({ backendConversationId: "child-native" });
    expect(policy.isSelectionAllowed).not.toHaveBeenCalled(); expect(fixture.port.readHistory).not.toHaveBeenCalled();
    expect(fixture.port.fork).not.toHaveBeenCalled();
    expect(fixture.port.reconcileFork).toHaveBeenCalledWith(expect.objectContaining({ inheritedSettings: input.inheritedSettings }));
  });
  it("awaits confirmed residency cleanup and refuses to retire a locally attached session", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation);
    await expect(driver.releaseConversationResidency(conversation)).resolves.toBe("busy");
    expect(fixture.port.retireSession).not.toHaveBeenCalled(); await handle.close();
    let complete!: () => void;
    fixture.port.retireSession = vi.fn(async () => { await new Promise<void>(resolve => { complete = resolve; }); return "retired" as const; });
    let finished = false; const release = driver.releaseConversationResidency(conversation).then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    expect(finished).toBe(false); complete(); await expect(release).resolves.toBe("released");
    expect(fixture.port.retireSession).toHaveBeenCalledWith(native);
  });
  it("drains retained native output before retrying residency retirement", async () => {
    const { driver, fixture } = setup(); const order: string[] = [];
    fixture.port.attachForDrain = vi.fn(async () => ({ ...attachment, observationGap: false, throughSequence: 1, closed: false }));
    fixture.push({ kind: "companion", payload: { type: "state_changed" } });
    fixture.port.acknowledge = vi.fn(async input => { expect(input.throughSequence).toBe(1); order.push("acknowledged"); });
    fixture.port.release = vi.fn(async () => { order.push("released"); });
    fixture.port.retireSession = vi.fn(async () => { order.push("retire"); return order.length === 1 ? "undelivered" as const : "retired" as const; });
    await expect(driver.releaseConversationResidency(conversation)).resolves.toBe("released");
    expect(order).toEqual(["retire", "acknowledged", "released", "retire"]);
  });
  it("drains a crashed session without native commands or current launch environment and then reattaches", async () => {
    const environment = vi.fn(async () => ({ CHANGED: "new" }));
    const { driver, fixture } = setup({ resolveThreadEnvironment: environment });
    const nativeAttach = fixture.port.attach;
    fixture.port.attach = vi.fn().mockRejectedValueOnce(new PiNativeError("pi_native_session_ended")).mockImplementation(nativeAttach);
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    fixture.push({ kind: "rpc", payload: { type: "extension_ui_request", id: "dead-choice", method: "confirm", title: "Dead" } });
    fixture.push({ kind: "stream", payload: { type: "message_snapshot", streamId: "partial", contentIndex: 0, semanticKind: "assistant_message", text: "Partial result" } });
    fixture.port.attachForDrain = vi.fn(async () => ({ ...attachment, observationGap: false, throughSequence: 2, closed: true }));
    let draining = false; let applied = false;
    fixture.port.retireSession = vi.fn(async () => {
      if (!draining) { draining = true; return "undelivered" as const; }
      expect(applied).toBe(true); draining = false; fixture.state = { ...fixture.state, isIdle: true }; return "retired" as const;
    });
    const nativeRequest = fixture.port.request;
    fixture.port.request = vi.fn(async (input, signal) => {
      expect(draining).toBe(false); return nativeRequest(input, signal);
    });
    fixture.port.acknowledge = vi.fn(async input => { if (draining && input.throughSequence === 2) applied = true; });
    const handle = await driver.attach(conversation);
    expect(fixture.port.attachForDrain).toHaveBeenCalledWith(native);
    expect(fixture.port.attach).toHaveBeenCalledTimes(2);
    expect(environment).toHaveBeenCalledTimes(2);
    expect(fixture.port.acknowledge).toHaveBeenCalled(); await handle.close();
  });
  it("drains retained output using the existing environment before applying a changed launch environment", async () => {
    const settings = { getSettings: () => ({ modelProvider: "provider", modelId: "model", thinkingLevel: "low", toolMode: "full" as const, revision: 0 }), syncObserved: vi.fn() };
    const { driver, fixture } = setup({ settings });
    const nativeAttach = fixture.port.attach;
    fixture.port.attach = vi.fn().mockRejectedValueOnce(new PiNativeError("pi_native_session_configuration_conflict")).mockImplementation(nativeAttach);
    fixture.push({ kind: "companion", payload: { type: "state_changed" } });
    fixture.port.attachForDrain = vi.fn(async () => ({ ...attachment, observationGap: false, throughSequence: 1, closed: false }));
    let draining = false; const nativeRequest = fixture.port.request;
    fixture.port.retireSession = vi.fn(async () => {
      if (!draining) { draining = true; return "undelivered" as const; }
      expect(settings.syncObserved).not.toHaveBeenCalled(); draining = false; return "retired" as const;
    });
    fixture.port.request = async (input, signal) => {
      if (draining) expect(input.command.command.type).toBe("snapshot");
      return nativeRequest(input, signal);
    };
    const handle = await driver.attach(conversation);
    expect(fixture.port.attachForDrain).toHaveBeenCalledWith(native); expect(settings.syncObserved).toHaveBeenCalled();
    await handle.close();
  });
  it("drains every retained page from a closed process before retirement", async () => {
    const { driver, fixture } = setup(); let acknowledged = 0;
    fixture.port.attachForDrain = vi.fn(async () => ({ ...attachment, observationGap: false, throughSequence: 600, closed: true }));
    fixture.port.retireSession = vi.fn(async () => acknowledged === 600 ? "retired" as const : "undelivered" as const);
    fixture.port.request = vi.fn(fixture.port.request);
    fixture.port.observe = vi.fn(async (input, signal) => {
      expect(signal?.aborted).toBe(false);
      const throughSequence = Math.min(input.afterSequence + 256, 600);
      return { throughSequence, retainedAfterSequence: acknowledged, closed: true,
        events: Array.from({ length: throughSequence - input.afterSequence }, (_, index) => ({
          sequence: input.afterSequence + index + 1, kind: "companion" as const, payload: { type: "state_changed" },
        })) };
    });
    fixture.port.acknowledge = vi.fn(async input => { acknowledged = input.throughSequence; });
    await expect(driver.releaseConversationResidency(conversation)).resolves.toBe("released");
    expect(fixture.port.observe).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fixture.port.observe).mock.calls.map(([input]) => input.afterSequence)).toEqual([0, 256, 512]);
    expect(vi.mocked(fixture.port.acknowledge).mock.calls.map(([input]) => input.throughSequence)).toEqual([256, 512, 600]);
    expect(fixture.port.request).not.toHaveBeenCalled();
    expect(fixture.port.retireSession).toHaveBeenCalledTimes(2);
  });
  it("acknowledges a recovered observation gap after its retained output and warns the next subscriber", async () => {
    const { driver, fixture } = setup(); const order: string[] = [];
    const nativeAttach = fixture.port.attach;
    fixture.port.attach = vi.fn().mockRejectedValueOnce(new PiNativeError("pi_native_observation_continuity_lost")).mockImplementation(nativeAttach);
    fixture.port.attachForDrain = vi.fn(async () => ({ ...attachment, closed: true, observationGap: true, throughSequence: 1 }));
    fixture.push({ kind: "companion", payload: { type: "state_changed" } });
    fixture.port.acknowledge = vi.fn(async input => { expect(input.throughSequence).toBe(1); order.push("events"); });
    fixture.port.acknowledgeObservationGap = vi.fn(async input => {
      expect(input).toEqual({ handleId: attachment.handleId, generation: attachment.generation, throughSequence: 1 });
      order.push("gap");
    });
    fixture.port.retireSession = vi.fn(async () => { order.push("retire"); return order.length === 1 ? "undelivered" as const : "retired" as const; });
    let handle = await driver.attach(conversation);
    expect(order.slice(0, 4)).toEqual(["retire", "events", "gap", "retire"]);
    // The actor's raw control subscription must not consume the warning before
    // its later sequenced projection subscription can render the notice.
    handle.subscribe(() => {});
    await handle.close(); handle = await driver.attach(conversation);
    const notices: unknown[] = []; await subscribeProjection(handle, event => { if (event.type === "notice") notices.push(event); });
    expect(notices).toEqual([expect.objectContaining({ notice: expect.objectContaining({ tone: "warning", message: { text: expect.stringContaining("some transient output may be missing") } }) })]);
    await handle.close(); handle = await driver.attach(conversation);
    await subscribeProjection(handle, event => { if (event.type === "notice") notices.push(event); });
    expect(notices).toHaveLength(1);
  });
  it.each(["before", "after"] as const)("retains the recovery warning when connection fails %s gap acknowledgement", async failure => {
    const { driver, fixture } = setup(); let gap = true; let fail = true;
    const nativeAttach = fixture.port.attach;
    fixture.port.attach = vi.fn(async input => {
      if (gap) throw new PiNativeError("pi_native_observation_continuity_lost");
      return nativeAttach(input);
    });
    fixture.port.attachForDrain = vi.fn(async () => ({ ...attachment, closed: true, observationGap: true }));
    fixture.port.retireSession = vi.fn(async () => gap ? "undelivered" as const : "retired" as const);
    fixture.port.acknowledgeObservationGap = vi.fn(async () => {
      if (fail) { fail = false; if (failure === "after") gap = false; throw new PiNativeError("pi_native_connection_lost"); }
      gap = false;
    });
    await expect(driver.attach(conversation)).rejects.toMatchObject({ backendCode: "pi_native_connection_lost" });
    expect(fixture.releaseCount).toBe(1);
    const handle = await driver.attach(conversation); const notices: unknown[] = [];
    await subscribeProjection(handle, event => { if (event.type === "notice") notices.push(event); });
    expect(notices).toHaveLength(1);
    expect(fixture.port.acknowledgeObservationGap).toHaveBeenCalledTimes(failure === "before" ? 2 : 1);
  });
  it.each(["busy", "drain_busy"] as const)("offers explicit Stop without new work when observation gap recovery is %s", async blocker => {
    const { driver, fixture } = setup();
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    fixture.port.attach = vi.fn(async () => { throw new PiNativeError("pi_native_observation_continuity_lost"); });
    fixture.port.retireSession = vi.fn(async () => blocker === "busy" ? "busy" as const : "undelivered" as const);
    fixture.port.attachForDrain = vi.fn(async () => { throw new PiNativeError("pi_native_observation_recovery_busy"); });
    fixture.port.observe = vi.fn(fixture.port.observe);
    let control!: Parameters<NonNullable<AttachConversationInput["onControlReady"]>>[0];
    const handle = await driver.attach({ ...conversation, onControlReady: value => { control = value; } });
    expect(fixture.port.attachForControl).toHaveBeenCalledWith(native);
    expect(fixture.commands.map(command => command.type)).toEqual(["snapshot"]);
    expect(fixture.port.observe).not.toHaveBeenCalled();
    expect(control.lifetime.aborted).toBe(false);
    expect(await handle.backendCapabilities()).toMatchObject({ actions: [], deliveryModes: [], interactionKinds: [], branching: { availability: "unavailable" } });
    const events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    const unsubscribe = await subscribeProjection(handle, () => {});
    expect(events).toContainEqual(expect.objectContaining({ type: "notice", notice: expect.objectContaining({ tone: "warning" }) }));
    await expect(handle.submit(submission())).rejects.toMatchObject({ backendCode: "pi_native_observation_control_only", crossedSubmissionBoundary: false });
    await expect(handle.perform({ action: "rename", title: "No", applicationOperationId: "rename" })).rejects.toMatchObject({ backendCode: "pi_native_observation_control_only" });
    await expect(handle.respond({ kind: "cancel", interactionId: "hidden", applicationOperationId: "cancel" })).rejects.toMatchObject({ backendCode: "pi_native_observation_control_only" });
    const stop = { applicationOperationId: "stop", deadlineAt: Date.now() + 5_000 };
    await expect(control.interrupt(stop)).resolves.toBeUndefined();
    expect(fixture.commands.map(command => command.type).filter(type => type !== "snapshot")).toEqual(["begin_stop", "clear_queue", "abort", "end_stop"]);
    expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" });
    expect(control.lifetime.aborted).toBe(false);
    await expect(handle.reconcileInterrupt(stop)).resolves.toEqual({ outcome: "accepted" });
    unsubscribe(); await handle.close();
  });
  it("keeps existing control alive when an attached observer loses continuity", async () => {
    const { driver, fixture } = setup(); let lost = false;
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    const observe = fixture.port.observe;
    fixture.port.observe = async (input, signal) => {
      if (lost) throw new PiNativeError("pi_native_observation_continuity_lost", "sent_outcome_unknown");
      return observe(input, signal);
    };
    let control!: Parameters<NonNullable<AttachConversationInput["onControlReady"]>>[0];
    const handle = await driver.attach({ ...conversation, onControlReady: value => { control = value; } });
    const events: BackendConversationEvent[] = []; const unsubscribe = await subscribeProjection(handle, event => events.push(event));
    fixture.push({ kind: "rpc", payload: { type: "extension_ui_request", id: "pending-dialog", method: "confirm", title: "Pending" } });
    await vi.waitFor(() => expect(events.some(event => event.type === "interaction_opened")).toBe(true));
    lost = true;
    await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "sequence_gap" }));
    expect((await handle.backendCapabilities()).deliveryModes).toEqual([]);
    expect(fixture.port.attachForControl).toHaveBeenCalledTimes(1);
    expect(control.lifetime.aborted).toBe(false);
    expect(fixture.commands.some(command => command.type === "abort")).toBe(false);
    expect(events.some(event => event.type === "interaction_resolved")).toBe(false);
    expect(events).toContainEqual({ type: "resnapshot_required", reason: "sequence_gap" });
    unsubscribe(); const recoveryEvents: BackendConversationEvent[] = [];
    await subscribeProjection(handle, event => recoveryEvents.push(event));
    expect(recoveryEvents).toContainEqual(expect.objectContaining({ type: "notice" }));
    await expect(control.interrupt({ applicationOperationId: "stop", deadlineAt: Date.now() + 5_000 })).resolves.toBeUndefined();
    expect(recoveryEvents).toContainEqual({ type: "interaction_resolved", backendInteractionId: "pending-dialog" });
    await handle.close();
  });
  it.each(["get_state", "snapshot"] as const)("keeps Stop available while one native %s read is slow", async slowType => {
    const fixture = new NativeFixture();
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    let emit!: NonNullable<Parameters<PiNativeSessionLauncher>[0]["onEvent"]>;
    let hold = false; let finishRead: (() => void) | undefined;
    const calls: string[] = [];
    const invoke = async (channel: "rpc" | "companion", command: Readonly<Record<string, unknown>>) => {
      const type = String(command.type); calls.push(type);
      if (hold && type === slowType) await new Promise<void>(resolve => { finishRead = resolve; });
      if (type === "get_state") return fixture.rpcState();
      const result = await fixture.port.request({ handleId: "native", operationId: randomUUID(), retainOutcome: false, command: { channel, command } });
      if (result.status !== "completed") throw new Error("Unexpected fixture outcome");
      return result.result;
    };
    const host = new PiNativeHost({ configuration: { tenantId: "tenant", principalId: "principal", backendInstanceId: instance.id,
      executionEnvironmentId: "environment", initializationTimeoutMs: 1000, projectTrusted: false },
      channels: {} as ExecutionEnvironmentChannelProvider, environment: {}, authenticationKey: Buffer.alloc(32, 1),
      acquireWriter: async () => ({ release: async () => {} }), observationWaitMs: 5, maximumEventBytes: 1024, maximumOperations: 5,
      store: { resolveSessionDirectory: () => fixture.port.resolveSessionDirectory({ cwd: native.cwd }), create: fixture.port.create,
        fork: fixture.port.fork, reconcileFork: fixture.port.reconcileFork, listSessions: fixture.port.listSessions, readHistory: fixture.port.readHistory },
      launch: (async (input: Parameters<PiNativeSessionLauncher>[0]) => { emit = input.onEvent!; return {
        rpc: { request: (command: Readonly<Record<string, unknown>>) => invoke("rpc", command), respondUI: async () => {}, closed: new Promise(() => {}) },
        bridge: { request: (command: Readonly<Record<string, unknown>>) => invoke("companion", command), closed: new Promise(() => {}) },
        close: async () => {}, version: "1.4.0" }; }) as unknown as PiNativeSessionLauncher });
    const abandon = vi.spyOn(host, "abandonObservation");
    const requests = vi.spyOn(host, "request");
    const { driver } = setup({ port: host });
    const handle = await driver.attach(conversation);
    const events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => timeout(milliseconds === 5_000 ? 25 : milliseconds));
    try {
      hold = true;
      if (slowType === "snapshot") fixture.state = { ...fixture.state, isIdle: true };
      emit({ kind: "rpc", payload: { type: "extension_error", error: "x".repeat(2048) } });
      await vi.waitFor(() => expect(finishRead).toBeDefined());
      const slowRequest = requests.mock.calls.findLast(([input]) => input.command.command.type === slowType)![0];
      const pending = () => host.snapshot().retainedSessions[0]!.retainedOperationIds;
      if (slowType === "get_state") {
        // Repeated monitor ticks retry cleanup, never allocate replacement reads.
        await vi.waitFor(() => expect(abandon.mock.calls.filter(([input]) => input.operationId === slowRequest.operationId).length).toBeGreaterThanOrEqual(3), { timeout: 3_000 });
      } else {
        // Full history uses the normal read deadline, not the short status budget.
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(abandon.mock.calls.some(([input]) => input.operationId === slowRequest.operationId)).toBe(false);
      }
      expect(calls.filter(type => type === "get_state")).toHaveLength(1);
      expect(calls.filter(type => type === "snapshot")).toHaveLength(slowType === "snapshot" ? 2 : 1);
      expect(pending()).toEqual([slowRequest.operationId]);
      await expect(handle.interrupt({ applicationOperationId: "stop-slow-read", deadlineAt: Date.now() + 2_000 })).resolves.toBeUndefined();
      expect(calls.filter(type => ["begin_stop", "clear_queue", "abort", "end_stop"].includes(type))).toEqual(["begin_stop", "clear_queue", "abort", "end_stop"]);
      expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" });
      await vi.waitFor(() => expect(pending()).toEqual([slowRequest.operationId]));
      await handle.close();
      expect(abandon.mock.calls.some(([input]) => input.operationId === slowRequest.operationId)).toBe(true);
      // Release alone cannot make a still-running read safe to replace.
      await expect(rpc(host, host.snapshot().retainedSessions[0]!, { type: "get_state" }))
        .rejects.toMatchObject({ backendCode: "pi_native_observation_pending", crossedSubmissionBoundary: false });
      expect(calls.filter(type => type === "get_state")).toHaveLength(1);
      finishRead!();
      await vi.waitFor(() => expect(pending()).toEqual([]));
    } finally {
      hold = false; finishRead?.(); deadline.mockRestore(); await handle.close();
    }
  });
  it("replays immediate idle recovery and does not replace unchanged blocked control attachments repeatedly", async () => {
    const { driver, fixture } = setup();
    fixture.port.attach = vi.fn(async () => { throw new PiNativeError("pi_native_observation_continuity_lost"); });
    fixture.port.retireSession = vi.fn(async () => "busy" as const);
    const first = await driver.attach(conversation);
    const raw: BackendConversationEvent[] = []; first.subscribe(event => raw.push(event));
    const sequenced: BackendConversationEvent[] = []; await subscribeProjection(first, event => sequenced.push(event));
    expect(raw).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" });
    expect(sequenced).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" });
    await first.close();
    const retry = await driver.attach(conversation);
    const events: BackendConversationEvent[] = []; retry.subscribe(event => events.push(event));
    const projection = await retry.establishProjection({ signal: new AbortController().signal });
    expect(projection.snapshot.runState).toBe("reconciling");
    projection.subscribeFromNext(() => {});
    expect(events).toContainEqual(expect.objectContaining({ type: "notice", notice: expect.objectContaining({ message: expect.objectContaining({ text: expect.stringContaining("blocked by retained work") }) }) }));
    await vi.waitFor(() => expect(fixture.commands.filter(command => command.type === "get_state").length).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    expect(fixture.commands.filter(command => command.type === "snapshot")).toHaveLength(2);
    expect(events.some(event => event.type === "resnapshot_required" && event.reason === "provider_handle_closed")).toBe(false);
    expect(fixture.port.retireSession).toHaveBeenCalledTimes(2);
    expect(fixture.commands.every(command => ["snapshot", "get_state"].includes(command.type))).toBe(true);
    // New native evidence permits a fresh attempt; the old idle evidence does not.
    fixture.state = { ...fixture.state, entries: [user("later", null)], leafId: "later" };
    await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" }), { timeout: 2_000 });
  });
  it("replaces an active control-only handle after natural completion without Stop", async () => {
    const { driver, fixture } = setup();
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    fixture.port.attach = vi.fn(async () => { throw new PiNativeError("pi_native_observation_continuity_lost"); });
    fixture.port.retireSession = vi.fn(async () => "busy" as const);
    fixture.port.observe = vi.fn(fixture.port.observe);
    const handle = await driver.attach(conversation);
    const events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    fixture.state = { ...fixture.state, entries: [...fixture.state.entries, answer("a", "u")], leafId: "a", isIdle: true };
    await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" }), { timeout: 2_000 });
    expect(fixture.commands.every(command => ["snapshot", "get_state"].includes(command.type))).toBe(true);
    expect(fixture.port.observe).not.toHaveBeenCalled();
    await handle.close();
    const reads = fixture.commands.length;
    await new Promise(resolve => setTimeout(resolve, 1_050));
    expect(fixture.commands).toHaveLength(reads);
  });
  it("rechecks unchanged idle evidence after a cooldown when host-only obligations may have settled", async () => {
    const { driver, fixture } = setup();
    fixture.port.attach = vi.fn(async () => { throw new PiNativeError("pi_native_observation_continuity_lost"); });
    fixture.port.retireSession = vi.fn(async () => "busy" as const);
    const clock = Date.now.bind(Date); let elapsed = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock() + elapsed);
    try {
      const first = await driver.attach(conversation); await first.close();
      const retry = await driver.attach(conversation);
      const events: BackendConversationEvent[] = []; retry.subscribe(event => events.push(event));
      expect(events.some(event => event.type === "resnapshot_required" && event.reason === "provider_handle_closed")).toBe(false);
      elapsed = 30_000;
      await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" }), { timeout: 2_000 });
      expect(fixture.commands.every(command => ["snapshot", "get_state"].includes(command.type))).toBe(true);
      await retry.close();
    } finally { now.mockRestore(); }
  });
  it.each(["absent", "pi_native_session_ended", "pi_native_cleanup_unproven"])("requests replacement when a live gap's control attachment is %s", async failure => {
    const { driver, fixture } = setup(); let lost = false;
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    const observe = fixture.port.observe;
    fixture.port.observe = async (input, signal) => {
      if (lost) throw new PiNativeError("pi_native_observation_continuity_lost");
      return observe(input, signal);
    };
    fixture.port.attachForControl = vi.fn(async () => {
      if (failure === "absent") return null;
      throw new PiNativeError(failure);
    });
    const handle = await driver.attach(conversation);
    const events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    fixture.push({ kind: "rpc", payload: { type: "extension_ui_request", id: "pending", method: "confirm", title: "Pending" } });
    await vi.waitFor(() => expect(events.some(event => event.type === "interaction_opened")).toBe(true));
    lost = true;
    await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" }));
    expect(events.some(event => event.type === "interaction_resolved")).toBe(false);
    expect(fixture.commands.some(command => command.type === "abort")).toBe(false);
    expect(fixture.port.attachForControl).toHaveBeenCalledTimes(1);
    const replay: BackendConversationEvent[] = []; handle.subscribe(event => replay.push(event));
    expect(replay).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" });
  });
  it.each(["absent", "pi_native_session_ended", "pi_native_cleanup_unproven"])("retries recovery once when initial control attachment becomes %s", async failure => {
    const { driver, fixture } = setup();
    const attach = fixture.port.attach;
    fixture.port.attach = vi.fn().mockRejectedValueOnce(new PiNativeError("pi_native_observation_continuity_lost")).mockImplementation(attach);
    fixture.port.retireSession = vi.fn().mockResolvedValueOnce("busy").mockResolvedValue("retired");
    fixture.port.attachForControl = vi.fn(async () => {
      if (failure === "absent") return null;
      throw new PiNativeError(failure);
    });
    const handle = await driver.attach(conversation);
    expect((await handle.backendCapabilities()).deliveryModes).toContain("submit");
    expect(fixture.port.attachForControl).toHaveBeenCalledTimes(1);
    expect(fixture.port.retireSession).toHaveBeenCalledTimes(2);
    expect(fixture.commands.some(command => command.type === "abort")).toBe(false);
  });
  it("surfaces a failed cleanup after initial control loss without retrying indefinitely", async () => {
    const { driver, fixture } = setup();
    fixture.port.attach = vi.fn(async () => { throw new PiNativeError("pi_native_observation_continuity_lost"); });
    fixture.port.attachForControl = vi.fn(async () => { throw new PiNativeError("pi_native_cleanup_unproven"); });
    fixture.port.retireSession = vi.fn().mockResolvedValueOnce("busy").mockRejectedValue(new PiNativeError("pi_native_cleanup_unproven"));
    await expect(driver.attach(conversation)).rejects.toMatchObject({ backendCode: "pi_native_cleanup_unproven" });
    expect(fixture.port.attach).toHaveBeenCalledTimes(1);
    expect(fixture.port.attachForControl).toHaveBeenCalledTimes(1);
    expect(fixture.port.retireSession).toHaveBeenCalledTimes(2);
  });
  it("releases a control attachment whose initial snapshot loses the process before recovering", async () => {
    const { driver, fixture } = setup();
    const attach = fixture.port.attach;
    fixture.port.attach = vi.fn().mockRejectedValueOnce(new PiNativeError("pi_native_observation_continuity_lost")).mockImplementation(attach);
    fixture.port.retireSession = vi.fn().mockResolvedValueOnce("busy").mockResolvedValue("retired");
    const request = fixture.port.request; let firstSnapshot = true;
    fixture.port.request = async (input, signal) => {
      if (firstSnapshot && input.command.command.type === "snapshot") {
        firstSnapshot = false; throw new PiNativeError("pi_native_session_ended");
      }
      return request(input, signal);
    };
    const lifetimes: AbortSignal[] = [];
    const handle = await driver.attach({ ...conversation, onControlReady: control => { lifetimes.push(control.lifetime); } });
    expect(lifetimes).toHaveLength(2);
    expect(lifetimes[0]!.aborted).toBe(true);
    expect(lifetimes[1]!.aborted).toBe(false);
    expect(fixture.releaseCount).toBe(1);
    expect((await handle.backendCapabilities()).deliveryModes).toContain("submit");
    expect(fixture.port.retireSession).toHaveBeenCalledTimes(2);
  });
  it("requests replacement when the process ends during control-only polling", async () => {
    const { driver, fixture } = setup();
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    fixture.port.attach = vi.fn(async () => { throw new PiNativeError("pi_native_observation_continuity_lost"); });
    fixture.port.retireSession = vi.fn(async () => "busy" as const);
    const handle = await driver.attach(conversation);
    const events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    fixture.port.request = async () => { throw new PiNativeError("pi_native_session_ended"); };
    await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" }), { timeout: 2_000 });
    expect(fixture.commands.every(command => ["snapshot", "get_state"].includes(command.type))).toBe(true);
  });
  it("cancels a pending read-only recovery poll when its handle closes", async () => {
    const { driver, fixture } = setup();
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    fixture.port.attach = vi.fn(async () => { throw new PiNativeError("pi_native_observation_continuity_lost"); });
    fixture.port.retireSession = vi.fn(async () => "busy" as const);
    const handle = await driver.attach(conversation); let pollSignal: AbortSignal | undefined;
    fixture.port.request = async (_input, signal) => new Promise((_resolve, reject) => {
      pollSignal = signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    await vi.waitFor(() => expect(pollSignal).toBeDefined(), { timeout: 2_000 });
    await handle.close();
    expect(pollSignal!.aborted).toBe(true);
    expect(fixture.releaseCount).toBe(1);
  });
  it("waits for the accepted Stop receipt before monitoring can replace an idle control handle", async () => {
    const { driver, fixture } = setup();
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    fixture.port.attach = vi.fn(async () => { throw new PiNativeError("pi_native_observation_continuity_lost"); });
    fixture.port.retireSession = vi.fn(async () => "busy" as const);
    const handle = await driver.attach(conversation);
    const events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    const request = fixture.port.request;
    let releaseStop!: () => void;
    const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type === "end_stop") await stopped;
      return request(input, signal);
    };
    const stop = handle.interrupt({ applicationOperationId: "stop", deadlineAt: Date.now() + 5_000 });
    try {
      await vi.waitFor(() => expect(fixture.commands.filter(command => command.type === "get_state")).toHaveLength(1), { timeout: 2_000 });
      expect(fixture.state.isIdle).toBe(true);
      expect(events.some(event => event.type === "resnapshot_required" && event.reason === "provider_handle_closed")).toBe(false);
    } finally { releaseStop(); }
    await expect(stop).resolves.toBeUndefined();
    expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" });
  });
  it.each(["completion", "Stop"])("preserves a pending local Sedes call until %s despite an idle control snapshot", async outcome => {
    let pending = true; let lost = false;
    const close = vi.fn(() => { pending = false; });
    const service = { prepareLaunch: async () => undefined, createBridge: () => ({
      configure: async () => [], onEvent() {}, reconcileHistory() {}, hasPendingCalls: () => pending, close,
    }) } as unknown as PiNativeAgentToolService;
    const { driver, fixture } = setup({ agentTools: service });
    fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    const observe = fixture.port.observe;
    fixture.port.observe = async (input, signal) => {
      if (lost) throw new PiNativeError("pi_native_observation_continuity_lost");
      return observe(input, signal);
    };
    const handle = await driver.attach(conversation);
    const events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    fixture.state = { ...fixture.state, isIdle: true }; lost = true;
    await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "sequence_gap" }));
    expect(close).not.toHaveBeenCalled();
    expect(events.some(event => event.type === "resnapshot_required" && event.reason === "provider_handle_closed")).toBe(false);
    const projection = await handle.establishProjection({ signal: new AbortController().signal });
    expect(projection.snapshot.runState).toBe("reconciling");
    projection.subscribeFromNext(() => {});
    expect(events).toContainEqual(expect.objectContaining({ type: "notice", notice: expect.objectContaining({ message: expect.objectContaining({ text: expect.stringContaining("blocked by retained work") }) }) }));
    if (outcome === "Stop") {
      await handle.interrupt({ applicationOperationId: "stop", deadlineAt: Date.now() + 5_000 });
      expect(close).toHaveBeenCalledOnce();
    } else {
      pending = false;
      await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" }), { timeout: 2_000 });
      expect(close).not.toHaveBeenCalled();
    }
    expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" });
  });
  it.each(["completed", "unknown"] as const)("preserves a closed session's %s action outcome before releasing its receipt", async disposition => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const action = { action: "rename" as const, title: "Preserved title", applicationOperationId: "rename" };
    const nativeRequest = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      const result = await nativeRequest(input, signal);
      if (input.command.command.type === "set_session_name") {
        if (disposition === "unknown") fixture.outcomes.set(input.operationId, { status: "failed", failure: { code: "pi_native_process_exited", delivery: "sent_outcome_unknown" } });
        throw new PiNativeError("reply_lost", "sent_outcome_unknown");
      }
      return result;
    };
    const original = await driver.attach(conversation);
    await expect(original.perform(action)).rejects.toMatchObject({ crossedSubmissionBoundary: true }); await original.close();
    fixture.port.attachForDrain = vi.fn(async () => ({ ...attachment, observationGap: false, closed: true, retainedOperationIds: ["rename"] }));
    fixture.port.retireSession = vi.fn(async () => fixture.outcomes.has("rename") ? "undelivered" as const : "retired" as const);
    await expect(driver.releaseConversationResidency(conversation)).resolves.toBe("released");
    const saved = operations.getOperation(conversation.scope, "thread", "rename");
    expect(saved?.state).toBe("unknown");
    expect(JSON.parse(saved!.receiptJson!)).toHaveProperty("nativeOutcomes.rename.status", disposition === "completed" ? "completed" : "failed");
    const resumed = await driver.attach(conversation);
    await expect(resumed.reconcileAction(action)).resolves.toEqual({ outcome: disposition === "completed" ? "accepted" : "unknown" });
    expect(fixture.commands.filter(command => command.type === "set_session_name")).toHaveLength(1);
  });
  it("does not consume a closed-session receipt without its exact scoped local operation", async () => {
    const { driver, fixture } = setup();
    fixture.outcomes.set("unowned", { status: "completed", result: {} });
    fixture.port.attachForDrain = vi.fn(async () => ({ ...attachment, observationGap: false, closed: true, retainedOperationIds: ["unowned"] }));
    fixture.port.retireSession = vi.fn(async () => "undelivered" as const);
    await expect(driver.releaseConversationResidency(conversation)).resolves.toBe("undelivered");
    expect(fixture.outcomes.has("unowned")).toBe(true);
  });
  it("keeps a proven-unsent submission retryable when its failure receipt is drained after closure", async () => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const request = fixture.port.request; const acknowledge = fixture.port.acknowledgeOperation;
    let rejectPrepare = true; let rejectAcknowledgement = true;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type === "prepare_submission" && rejectPrepare) {
        rejectPrepare = false;
        const outcome = { status: "failed" as const, failure: { code: "pi_native_temporarily_unavailable", delivery: "not_sent" as const } };
        fixture.outcomes.set(input.operationId, outcome); return outcome;
      }
      return request(input, signal);
    };
    fixture.port.acknowledgeOperation = async (input, signal) => {
      if (input.operationId === "submit:prepare:0" && rejectAcknowledgement) throw new PiNativeError("pi_native_connection_lost");
      return acknowledge(input, signal);
    };
    const original = await driver.attach(conversation);
    await expect(original.submit(submission())).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await original.close(); rejectAcknowledgement = false;
    fixture.port.attachForDrain = vi.fn(async () => ({ ...attachment, observationGap: false, closed: true, retainedOperationIds: ["submit:prepare:0"] }));
    fixture.port.retireSession = vi.fn(async () => fixture.outcomes.has("submit:prepare:0") ? "undelivered" as const : "retired" as const);
    await expect(driver.releaseConversationResidency(conversation)).resolves.toBe("released");
    expect(operations.getOperation(conversation.scope, "thread", "submit")?.state).toBe("prepared");
    const resumed = await driver.attach(conversation); await resumed.submit(submission());
    expect(fixture.commands.filter(command => command.type === "prompt")).toHaveLength(1);
  });
  it.each(["pi_managed_admission_closed", "pi_managed_operation_exists", "pi_managed_persistence_error"])("drains a lost %s preparation receipt with its exact delivery meaning", async code => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    const request = fixture.port.request, acknowledge = fixture.port.acknowledgeOperation;
    let preparations = 0;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type !== "prepare_submission") return request(input, signal);
      preparations++;
      fixture.outcomes.set(input.operationId, { status: "failed", failure: { code, delivery: "rejected" } });
      throw new PiNativeError("prepare_reply_lost", "sent_outcome_unknown");
    };
    const input = submission("drained-prepare");
    const original = await driver.attach(conversation);
    await expect(original.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)?.state).toBe("sent");
    await original.close();
    fixture.port.attachForDrain = async () => ({ ...attachment, observationGap: false, closed: true, retainedOperationIds: ["drained-prepare:prepare:0"] });
    fixture.port.retireSession = async () => fixture.outcomes.has("drained-prepare:prepare:0") ? "undelivered" : "retired";
    const rejected = code === "pi_managed_admission_closed";
    fixture.port.acknowledgeOperation = async (value, signal) => {
      if (value.operationId === "drained-prepare:prepare:0")
        expect(operations.getOperation(conversation.scope, "thread", input.applicationOperationId)?.state).toBe(rejected ? "completed" : "unknown");
      return acknowledge(value, signal);
    };
    await expect(driver.releaseConversationResidency(conversation)).resolves.toBe("released");
    const record = operations.getOperation(conversation.scope, "thread", input.applicationOperationId)!;
    expect(JSON.parse(record.receiptJson!)).toEqual(rejected ? { outcome: "not_applied" }
      : { nativeOutcomes: { "drained-prepare:prepare:0": { status: "failed", failure: { code, delivery: "rejected" } } } });
    expect(fixture.outcomes.has("drained-prepare:prepare:0")).toBe(false);
    expect(await driver.reconcileSubmission({ ...conversation, applicationOperationId: input.applicationOperationId }))
      .toMatchObject(rejected ? { status: "not_accepted", retryable: false } : { status: "unresolved" });
    const resumed = await driver.attach(conversation);
    await expect(resumed.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: !rejected });
    expect(preparations).toBe(1); expect(fixture.state.operations).toEqual([]);
  });
  it("preserves blocked residency and exposes unconfirmed cleanup", async () => {
    const { driver, fixture } = setup(); fixture.port.retireSession = vi.fn(async () => "busy" as const);
    await expect(driver.releaseConversationResidency(conversation)).resolves.toBe("busy");
    expect(fixture.port.attach).not.toHaveBeenCalled();
    fixture.port.retireSession = vi.fn(async () => { throw new PiNativeError("pi_native_cleanup_unproven"); });
    await expect(driver.releaseConversationResidency(conversation)).rejects.toMatchObject({ backendCode: "pi_native_cleanup_unproven" });
    expect(fixture.port.attach).not.toHaveBeenCalled();
  });
  it("resolves native skill selection before preparing the signed input", async () => {
    const { driver, fixture } = setup(); const skill = (await driver.catalog(conversation)).skills[0]!;
    const handle = await driver.attach(conversation); await handle.submit({ ...submission(), selectedSkillId: skill.id });
    expect(fixture.state.operations[0]?.input.text).toBe("/skill:review Hello");
    expect(fixture.state.operations[0]?.input.presentation).toMatchObject({ text: "Hello" });
  });
  it("translates resolved thread environment into explicit native overrides", async () => {
    const { driver, fixture } = setup({ resolveThreadEnvironment: async () => ({ KEEP: "value", REMOVE: null }) });
    await driver.attach(conversation);
    expect(fixture.port.attach).toHaveBeenCalledWith(expect.objectContaining({ executionEnvironment: { KEEP: { kind: "literal", value: "value" }, REMOVE: { kind: "unset" } } }));
  });
  it("advertises only explicitly mapped extended thinking levels", async () => {
    const { driver } = setup(); const catalog = await driver.catalog(conversation);
    expect(catalog.models[0]?.supportedReasoningEfforts).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });
  it("records native request duration only for fully observed turns", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation); await handle.submit(submission());
    const entry = answer("a", "user:submit"); Object.assign(entry.message, { durationMs: 250, usage: { output: 20 } });
    fixture.state = { ...fixture.state, entries: [...fixture.state.entries, entry], leafId: "a", isIdle: true };
    fixture.push({ kind: "rpc", payload: { type: "agent_settled" } });
    await vi.waitFor(async () => expect((await handle.history({ limit: 1 })).turnsById["user:submit"]?.throughput).toEqual({ outputTokens: 20, requestDurationMs: 250 }));
    await handle.close();
    const reopened = await driver.attach(conversation);
    expect((await reopened.history({ limit: 1 })).turnsById["user:submit"]?.throughput).toBeUndefined();
  });
  it("does not fabricate throughput after joining a running turn", async () => {
    const { driver, fixture } = setup(); fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    const handle = await driver.attach(conversation); const entry = answer("a", "u"); Object.assign(entry.message, { durationMs: 250, usage: { output: 20 } });
    fixture.state = { ...fixture.state, entries: [...fixture.state.entries, entry], leafId: "a", isIdle: true };
    fixture.push({ kind: "rpc", payload: { type: "agent_settled" } });
    await vi.waitFor(async () => expect((await handle.history({ limit: 1 })).turnsById.u?.status).toBe("completed"));
    expect((await handle.history({ limit: 1 })).turnsById.u?.throughput).toBeUndefined();
  });
  it("adopts native model settings on resume before applying bound preferences", async () => {
    let settings = { modelProvider: "old-provider", modelId: "old-model", thinkingLevel: "high", toolMode: "full" as const, revision: 0 };
    const { driver, fixture } = setup({ settings: { getSettings: () => settings, syncObserved: (_scope, _thread, actual) => {
      settings = { ...settings, modelProvider: actual.model!.provider, modelId: actual.model!.id, thinkingLevel: actual.thinkingLevel! };
    } } });
    await driver.attach(conversation);
    expect(fixture.commands.filter(item => item.type === "set_model").map(item => item.command)).toEqual([{ type: "set_model", provider: "provider", modelId: "model" }]);
    expect(settings.modelId).toBe("model");
  });
  it("normalizes only a unique policy-allowed native catalog default", async () => {
    const { driver, fixture } = setup(); fixture.port.catalog = async () => ({ models: [{ provider: "provider", id: "model", reasoning: true }], commands: [], defaultSelection: { provider: "provider", modelId: "model", thinkingLevel: "low" } });
    expect((await driver.catalog(conversation)).models[0]).toMatchObject({ isDefault: true, defaultReasoningEffort: "low" });
    fixture.port.catalog = async () => ({ models: [{ provider: "provider", id: "model", reasoning: true }], commands: [], defaultSelection: { provider: "provider", modelId: "missing", thinkingLevel: "low" } });
    expect((await driver.catalog({ ...conversation, purpose: "skill_picker" })).models[0]).not.toHaveProperty("isDefault");
  });
  it("omits and rejects extension commands which cannot preserve submission evidence", async () => {
    const { driver, fixture } = setup(); fixture.port.catalog = async () => ({ models: [], commands: [{ name: "mcp", source: "extension" }] });
    expect((await driver.catalog(conversation)).commands).toEqual([]);
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => input.command.command.type === "get_commands"
      ? { status: "completed", result: { commands: [{ name: "mcp", source: "extension" }] } } : request(input, signal);
    const handle = await driver.attach(conversation);
    await expect(handle.submit({ ...submission(), text: "/mcp add" })).rejects.toMatchObject({ crossedSubmissionBoundary: false, backendCode: "pi_native_extension_command_unsupported" });
    expect(fixture.commands.some(item => item.type === "prompt")).toBe(false);
  });
  it.each([
    { type: "prepare_submission", code: "pi_native_attachment_detached" },
    { type: "prompt", code: "pi_native_controller_stale" },
    { type: "compact", code: "pi_native_runtime_closed" },
    { type: "begin_stop", code: "sidecar_transport_closed" },
    { type: "extension_ui_response", code: "pi_native_attachment_detached" },
  ] as const)("keeps admitted $type unresolved when outcome polling refuses with $code", async ({ type, code }) => {
    const operations = operationStore(); const { driver, fixture } = setup({ operations });
    if (type === "begin_stop") fixture.state = { ...fixture.state, entries: [user("u", null)], leafId: "u", isIdle: false };
    const handle = await driver.attach(conversation);
    const events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    if (type === "extension_ui_response") {
      fixture.push({ kind: "rpc", payload: { type: "extension_ui_request", id: "question", method: "confirm", title: "Continue?" } });
      await vi.waitFor(() => expect(events.some(event => event.type === "interaction_opened")).toBe(true));
    }
    const request = fixture.port.request, outcome = fixture.port.outcome;
    let pendingId: string | undefined;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type !== type) return request(input, signal);
      pendingId = input.operationId;
      fixture.commands.push({ id: input.operationId, type, command: input.command.command });
      const pending = { status: "pending" as const }; fixture.outcomes.set(input.operationId, pending); return pending;
    };
    fixture.port.outcome = async (input, signal) => {
      if (input.operationId === pendingId) throw new PiNativeError(code, "not_sent");
      return outcome(input, signal);
    };
    const acknowledgements = vi.spyOn(fixture.port, "acknowledgeOperation");
    const reset = vi.spyOn(operations, "resetUnsentOperation");
    const id = "admitted-operation";
    const action = { action: "compact" as const, applicationOperationId: id };
    const stop = { applicationOperationId: id, deadlineAt: Date.now() + 5_000 };
    const response = { applicationOperationId: id, interactionId: "question", kind: "confirmation" as const, confirmed: true };
    const invoke = () => type === "compact" ? handle.perform(action) : type === "begin_stop" ? handle.interrupt(stop)
      : type === "extension_ui_response" ? handle.respond(response) : handle.submit(submission(id));
    await expect(invoke()).rejects.toMatchObject({ backendCode: code, category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false });
    expect(operations.getOperation(conversation.scope, "thread", id)).toMatchObject({ state: "sent", prepareAttempt: 0, receiptJson: null });
    expect(reset).not.toHaveBeenCalled();
    expect(acknowledgements.mock.calls.some(([input]) => input.operationId === pendingId)).toBe(false);
    expect(fixture.commands.some(command => command.type === "complete_submission" && command.command.disposition === "rejected")).toBe(false);
    if (type === "compact") expect(await handle.reconcileAction(action)).toEqual({ outcome: "unknown" });
    else if (type === "begin_stop") expect(await handle.reconcileInterrupt(stop)).toEqual({ outcome: "unknown" });
    else if (type === "extension_ui_response") {
      expect(await handle.reconcileInteractionResponse(response)).toEqual({ outcome: "unknown" });
      expect(events.some(event => event.type === "interaction_resolved")).toBe(false);
    }
    await expect(invoke()).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(fixture.commands.filter(command => command.type === type)).toHaveLength(1);
    expect(fixture.outcomes.get(pendingId!)).toEqual({ status: "pending" });
  });
  it("abandons only uncertain reads without releasing uncertain mutations", async () => {
    const { fixture } = setup(); fixture.port.acknowledgeOperation = vi.fn(async () => {});
    fixture.port.request = async () => ({ status: "failed", failure: { code: "denied", delivery: "rejected" } });
    await expect(rpc(fixture.port, attachment, { type: "get_state" })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(fixture.port.abandonObservation).not.toHaveBeenCalled();
    fixture.port.request = async () => ({ status: "failed", failure: { code: "lost", delivery: "sent_outcome_unknown" } });
    await expect(rpc(fixture.port, attachment, { type: "get_state" })).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(fixture.port.abandonObservation).toHaveBeenCalledOnce();
    await expect(rpc(fixture.port, attachment, { type: "set_session_name", name: "Unknown" })).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(fixture.port.abandonObservation).toHaveBeenCalledOnce();
    expect(fixture.port.acknowledgeOperation).not.toHaveBeenCalled();
  });
  it.each(["not_sent", "sent_outcome_unknown"] as const)("retains an uncertain read gate only after %s evidence", async delivery => {
    const { fixture } = setup();
    const request = vi.fn(async () => { throw new PiNativeError("read_failed", delivery); });
    fixture.port.request = request;
    fixture.port.abandonObservation = vi.fn(async () => { throw new PiNativeError("cleanup_lost", "sent_outcome_unknown"); });
    await expect(rpc(fixture.port, attachment, { type: "get_state" })).rejects.toMatchObject({ backendCode: "read_failed" });
    await expect(rpc(fixture.port, attachment, { type: "get_state" })).rejects.toMatchObject({ backendCode: delivery === "not_sent" ? "read_failed" : "cleanup_lost" });
    expect(request).toHaveBeenCalledTimes(delivery === "not_sent" ? 2 : 1);
    expect(fixture.port.abandonObservation).toHaveBeenCalledTimes(delivery === "not_sent" ? 0 : 2);
  });
  it("reconciles never-dispatched actions as not applied and persists a proven rejection", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation);
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type !== "set_session_name") return request(input, signal);
      const outcome = { status: "failed" as const, failure: { code: "denied", delivery: "rejected" as const } };
      fixture.outcomes.set(input.operationId, outcome); return outcome;
    };
    const action = { action: "rename" as const, title: "Name", applicationOperationId: "rename" };
    await expect(handle.perform(action)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(await handle.reconcileAction(action)).toEqual({ outcome: "not_applied" });
    await expect(handle.perform(action)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(fixture.outcomes.has("rename")).toBe(false);
    fixture.port.outcome = async () => { throw new PiNativeError("pi_native_operation_unknown", "sent_outcome_unknown"); };
    expect(await handle.reconcileAction({ ...action, applicationOperationId: "missing" })).toEqual({ outcome: "not_applied" });
  });
  it("cleans only host receipts proven completed in the scoped application journal", async () => {
    const operations = operationStore();
    operations.prepareOperation(conversation.scope, "thread", { operationId: "known", kind: "action", requestHash: "hash" });
    operations.completeOperation(conversation.scope, "thread", "known", { state: "completed", receiptJson: JSON.stringify({ accepted: true }) });
    const { driver, fixture } = setup({ operations });
    fixture.port.attach = async () => ({ ...attachment, retainedOperationIds: ["known", "other"] });
    fixture.outcomes.set("known", { status: "completed", result: {} }); fixture.outcomes.set("other", { status: "completed", result: {} });
    await driver.attach(conversation);
    expect(fixture.outcomes.has("known")).toBe(false); expect(fixture.outcomes.has("other")).toBe(true);
  });
  it("fences client controls to the originating normalized active turn, including Steers", async () => {
    let bridgeInput!: Parameters<PiNativeAgentToolService["createBridge"]>[0];
    const service = { prepareLaunch: async () => ({ environment: {} }),
      createBridge: (input: typeof bridgeInput) => { bridgeInput = input; return { configure: async () => [], onEvent() {}, reconcileHistory() {}, hasPendingCalls: () => false, close() {} }; } } as unknown as PiNativeAgentToolService;
    const { driver, fixture } = setup({ agentTools: service }); const handle = await driver.attach(conversation); await handle.submit(submission());
    const first = await bridgeInput.clientControlAuthority("user:submit").acquire(new AbortController().signal);
    expect(first.isCurrent()).toBe(true);
    fixture.state = { ...fixture.state, entries: [...fixture.state.entries, user("steered", "user:submit")], leafId: "steered",
      operations: [...fixture.state.operations, { input: { operationId: "s", mutationId: "s-mutation", reconciliationToken: "s-token", fingerprint: "a".repeat(64), mode: "steer", targetTurnId: "user:submit", text: "Follow up" }, phase: "accepted", userEntryId: "steered", targetTurnId: "user:submit" }] };
    const steered = await bridgeInput.clientControlAuthority("steered").acquire(new AbortController().signal);
    expect(steered.isCurrent()).toBe(true);
    fixture.state = { ...fixture.state, entries: [...fixture.state.entries, answer("done", "steered")], leafId: "done", isIdle: true };
    fixture.push({ kind: "companion", payload: { type: "state_changed" } });
    await vi.waitFor(() => expect(first.signal.aborted).toBe(true)); expect(steered.signal.aborted).toBe(true);
    await handle.submit(submission("next"));
    await expect(bridgeInput.clientControlAuthority("user:submit").acquire(new AbortController().signal)).rejects.toThrow("no longer active");
    const next = await bridgeInput.clientControlAuthority("user:next").acquire(new AbortController().signal); expect(next.isCurrent()).toBe(true); next.release();
  });
  it("does not acknowledge a live submission receipt before its caller consumes it", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation);
    let observed = false; handle.subscribe(event => { if (event.type === "run_state_changed") observed = true; });
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.command.command.type !== "complete_submission") return result;
      observed = false; fixture.push({ kind: "companion", payload: { type: "state_changed" } });
      await vi.waitFor(() => expect(observed).toBe(true));
      return { status: "pending" };
    };
    expect((await handle.submit(submission())).accepted).toBe(true);
  });
  it("advances the retained event cursor after signed history settles a lost agent-tool reply", async () => {
    const service = new PiNativeAgentToolService({
      facade: { eligibleCatalog: () => [], catalogSummaries: () => [], describeMany: () => [],
        readPolicy: () => ({ enabled: true, presentation: { surface: "native", mode: "progressive" }, enabledToolIds: [],
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } }),
        invoke: async () => { throw new Error("unexpected invocation"); } },
      cli: { availability: "unavailable", reason: "cli_unavailable" }, remote: false,
      sourceCapabilities: { issue: () => { throw new Error("unexpected CLI authority"); } },
    });
    const { driver, fixture } = setup({ agentTools: service });
    const event = { type: "agent_tool_call", id: "request", toolCallId: "tool-call", name: "sedes_catalog",
      arguments: { action: "list" }, assistantEntryId: "assistant", userEntryId: "user" };
    const assistant = answer("assistant", "user");
    fixture.state = { ...fixture.state, isIdle: false, entries: [user("user", null), { ...assistant,
      message: { ...assistant.message, content: [{ type: "toolCall", id: "tool-call", name: "sedes_catalog", arguments: { action: "list" } }] } }], leafId: "assistant",
      toolCalls: [{ toolCallId: event.toolCallId, toolName: event.name, assistantEntryId: event.assistantEntryId,
        userEntryId: event.userEntryId, arguments: event.arguments, managed: "agent", sourceInfo: { source: "extension", path: "/managed/extension.ts" } }] };
    const acknowledge = vi.spyOn(fixture.port, "acknowledge");
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.command.command.type === "resolve_agent_tool") throw new PiNativeError("reply_channel_lost", "sent_outcome_unknown");
      return result;
    };
    const handle = await driver.attach(conversation);
    fixture.push({ kind: "companion", payload: event });
    await vi.waitFor(() => expect(fixture.commands.filter(command => command.type === "resolve_agent_tool")).toHaveLength(1));
    let observedIdle = false;
    handle.subscribe(event => { if (event.type === "run_state_changed" && event.state === "idle") observedIdle = true; });
    fixture.state = { ...fixture.state, isIdle: true };
    fixture.push({ kind: "companion", payload: { type: "state_changed" } });
    await vi.waitFor(() => expect(observedIdle).toBe(true));
    expect(acknowledge).not.toHaveBeenCalled();
    fixture.state = { ...fixture.state, toolResults: [{ toolCallId: event.toolCallId, assistantEntryId: event.assistantEntryId,
      userEntryId: event.userEntryId, content: [{ type: "text", text: "[]" }], isError: false }] };
    fixture.push({ kind: "companion", payload: { type: "state_changed" } });
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledWith({ handleId: attachment.handleId, throughSequence: 3 }, expect.any(AbortSignal)));
    expect(fixture.commands.filter(command => command.type === "resolve_agent_tool")).toHaveLength(1);
  });
  it("releases a native attachment when early control publication throws", async () => {
    const { driver, fixture } = setup();
    await expect(driver.attach({ ...conversation, onControlReady: () => { throw new Error("control publication failed"); } })).rejects.toThrow("control publication failed");
    expect(fixture.releaseCount).toBe(1); expect(fixture.commands).toEqual([]);
  });
  it("keeps admission closed but retries a failed native release", async () => {
    const { driver, fixture } = setup(); await driver.attach(conversation);
    let attempts = 0; fixture.port.release = async () => { if (++attempts === 1) throw new Error("release unavailable"); };
    await expect(driver.close()).rejects.toThrow("could not all be released");
    await expect(driver.attach(conversation)).rejects.toThrow();
    await driver.close(); expect(attempts).toBe(2);
  });
  it("retries native handle cleanup after explicit Stop until release is proven", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation);
    const release = vi.fn<NativeFixture["port"]["release"]>()
      .mockRejectedValueOnce(new Error("release unavailable"))
      .mockRejectedValueOnce(new Error("release still unavailable"))
      .mockResolvedValue(undefined);
    fixture.port.release = release;
    await expect(handle.close()).rejects.toThrow("release unavailable");
    await expect(handle.retryCloseAfterStop!()).rejects.toThrow("release still unavailable");
    await expect(driver.attach(conversation)).rejects.toMatchObject({ backendCode: "pi_native_already_attached" });
    await expect(handle.submit(submission())).rejects.toMatchObject({ backendCode: "pi_native_handle_closed" });
    await handle.retryCloseAfterStop!();
    expect(release).toHaveBeenCalledTimes(3);
    await handle.retryCloseAfterStop!();
    expect(release).toHaveBeenCalledTimes(3);
    const replacement = await driver.attach(conversation);
    expect(replacement).not.toBe(handle);
    expect(fixture.attachCount).toBe(2);
  });
  it("retains unresolved extension UI events even when the native session is idle", async () => {
    const { driver, fixture } = setup(); fixture.port.acknowledge = vi.fn(async () => {});
    const handle = await driver.attach(conversation);
    const events: unknown[] = []; handle.subscribe(event => events.push(event));
    fixture.push({ kind: "rpc", payload: { type: "extension_ui_request", id: "question", method: "confirm", title: "Continue?", message: "Confirm" } });
    await vi.waitFor(() => expect(events.some(event => (event as {type:string}).type === "interaction_opened")).toBe(true));
    expect(fixture.port.acknowledge).not.toHaveBeenCalledWith(expect.objectContaining({ throughSequence: 1 }), expect.anything());
    await handle.respond({ applicationOperationId: "response", interactionId: "question", kind: "confirmation", confirmed: true });
    await vi.waitFor(() => expect(fixture.port.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ throughSequence: 1 }), expect.anything()));
  });
  it("replies to a selected option with its original value even when display labels are truncated", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation);
    const values = ["x".repeat(6000) + " first", "x".repeat(6000) + " second"];
    const events: { type: string }[] = []; handle.subscribe(event => events.push(event));
    fixture.push({ kind: "rpc", payload: { type: "extension_ui_request", id: "choice", method: "select", title: "Choose", options: values } });
    await vi.waitFor(() => expect(events.some(event => event.type === "interaction_opened")).toBe(true));
    expect(JSON.stringify(events)).not.toContain(values[1]);
    await handle.respond({ applicationOperationId: "choice-response", interactionId: "choice", kind: "choice", selectedOptionIds: ["1"] });
    expect(fixture.commands.find(command => command.type === "extension_ui_response")?.command).toMatchObject({ value: values[1] });
  });
  it("settles a recovered accepted UI response and keeps completed replays idempotent", async () => {
    const { driver, fixture } = setup();
    const acknowledge = vi.spyOn(fixture.port, "acknowledge");
    let handle = await driver.attach(conversation);
    const question = { kind: "rpc" as const, payload: { type: "extension_ui_request", id: "question", method: "confirm", title: "Continue?", message: "Confirm" } };
    const response = { applicationOperationId: "response", interactionId: "question", kind: "confirmation" as const, confirmed: true };
    let events: { type: string }[] = [];
    handle.subscribe(event => events.push(event));
    fixture.push(question);
    await vi.waitFor(() => expect(events.filter(event => event.type === "interaction_opened")).toHaveLength(1));
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      const result = await request(input, signal);
      if (input.command.command.type === "extension_ui_response") throw new PiNativeError("response_channel_lost", "sent_outcome_unknown");
      return result;
    };
    await expect(handle.respond(response)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(await handle.reconcileInteractionResponse(response)).toEqual({ outcome: "accepted" });
    expect(events.filter(event => event.type === "interaction_resolved")).toHaveLength(1);
    await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledWith({ handleId: attachment.handleId, throughSequence: 1 }, expect.any(AbortSignal)));
    const opened: { type: string }[] = [];
    const unsubscribe = handle.subscribe(event => opened.push(event));
    expect(opened).toEqual([]); unsubscribe();
    await handle.respond(response);
    expect(await handle.reconcileInteractionResponse(response)).toEqual({ outcome: "accepted" });
    expect(events.filter(event => event.type === "interaction_resolved")).toHaveLength(1);

    // A retained provider event may reappear after attachment replacement while
    // the application journal already proves the response was accepted.
    for (const replay of ["respond", "reconcile"] as const) {
      await handle.close();
      handle = await driver.attach(conversation);
      events = [];
      handle.subscribe(event => events.push(event));
      fixture.push(question);
      await vi.waitFor(() => expect(events.filter(event => event.type === "interaction_opened")).toHaveLength(1));
      if (replay === "respond") await handle.respond(response);
      else expect(await handle.reconcileInteractionResponse(response)).toEqual({ outcome: "accepted" });
      expect(events.filter(event => event.type === "interaction_resolved")).toHaveLength(1);
      const nextSubscriber: { type: string }[] = [];
      const remove = handle.subscribe(event => nextSubscriber.push(event));
      expect(nextSubscriber).toEqual([]); remove();
    }
    expect(fixture.commands.filter(command => command.type === "extension_ui_response")).toHaveLength(1);
  });
  it("leaves a UI interaction open when response reconciliation proves rejection", async () => {
    const { driver, fixture } = setup(); const handle = await driver.attach(conversation);
    const events: { type: string }[] = []; handle.subscribe(event => events.push(event));
    fixture.push({ kind: "rpc", payload: { type: "extension_ui_request", id: "question", method: "confirm", title: "Continue?", message: "Confirm" } });
    await vi.waitFor(() => expect(events.filter(event => event.type === "interaction_opened")).toHaveLength(1));
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => input.command.command.type === "extension_ui_response"
      ? { status: "failed", failure: { code: "rejected", delivery: "rejected" } } : request(input, signal);
    const response = { applicationOperationId: "response", interactionId: "question", kind: "confirmation" as const, confirmed: true };
    await expect(handle.respond(response)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(await handle.reconcileInteractionResponse(response)).toEqual({ outcome: "not_applied" });
    expect(events.filter(event => event.type === "interaction_resolved")).toEqual([]);
    const late: { type: string }[] = []; const remove = handle.subscribe(event => late.push(event));
    expect(late).toMatchObject([{ type: "interaction_opened" }]); remove();
  });
  it("retains definitive not-sent failure classification", async () => {
    const { fixture } = setup(); fixture.port.request = async () => { throw new PiNativeError("blocked", "not_sent"); };
    await expect(requestNative(fixture.port, attachment, { channel: "rpc", command: { type: "get_state" } })).rejects.toMatchObject({ category: "unavailable", crossedSubmissionBoundary: false, retryable: true });
  });
  it.each(["native", "normalized"] as const)("treats an uncrossed %s poll refusal as uncertainty about the admitted operation", async kind => {
    const { fixture } = setup();
    fixture.port.request = async () => ({ status: "pending" });
    fixture.port.outcome = async () => { throw kind === "native" ? new PiNativeError("poll_refused", "rejected") : new BackendError({
      category: "unavailable", retryable: true, crossedSubmissionBoundary: false, backendCode: "poll_refused", safeMessage: "Poll refused.",
    }); };
    await expect(requestNative(fixture.port, attachment, { channel: "rpc", command: { type: "compact" } }))
      .rejects.toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false, backendCode: "poll_refused" });
  });
  it.each([
    { delivery: "not_sent", category: "unavailable", crossedSubmissionBoundary: false, retryable: true },
    { delivery: "rejected", category: "rejected", crossedSubmissionBoundary: false, retryable: false },
    { delivery: "sent_outcome_unknown", category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false },
  ] as const)("preserves the operation's explicit $delivery terminal outcome after admission", async ({ delivery, ...expected }) => {
    const { fixture } = setup();
    fixture.port.request = async () => ({ status: "pending" });
    fixture.port.outcome = async () => ({ status: "failed", failure: { code: "operation_failed", delivery } });
    await expect(requestNative(fixture.port, attachment, { channel: "rpc", command: { type: "compact" } }))
      .rejects.toMatchObject({ ...expected, backendCode: "operation_failed" });
  });
  it("keeps an admitted read gate after its outcome poll is refused before dispatch", async () => {
    const { fixture } = setup(); let released = false;
    fixture.port.request = vi.fn(async () => released ? { status: "completed" as const, result: { recovered: true } } : { status: "pending" as const });
    fixture.port.outcome = async () => { throw new PiNativeError("pi_native_controller_stale", "not_sent"); };
    fixture.port.abandonObservation = vi.fn(async () => released ? "released" as const : "pending" as const);
    await expect(rpc(fixture.port, attachment, { type: "get_state" }))
      .rejects.toMatchObject({ crossedSubmissionBoundary: true, category: "submission_unknown" });
    expect(fixture.port.abandonObservation).toHaveBeenCalledOnce();
    await expect(rpc(fixture.port, attachment, { type: "get_state" }))
      .rejects.toMatchObject({ backendCode: "pi_native_observation_pending", crossedSubmissionBoundary: false });
    expect(fixture.port.request).toHaveBeenCalledOnce();
    released = true;
    await expect(rpc(fixture.port, attachment, { type: "get_state" })).resolves.toEqual({ recovered: true });
    expect(fixture.port.request).toHaveBeenCalledTimes(2);
  });
  it("waits for a 65-second compaction without reporting an unknown outcome", async () => {
    const operations = operationStore(); const { fixture, driver } = setup({ operations });
    fixture.port.observe = async (_input, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const handle = await driver.attach(conversation);
    const request = fixture.port.request;
    fixture.port.request = async (input, signal) => {
      if (input.command.command.type === "compact") await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 65_000);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return request(input, signal);
    };
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds); return controller.signal;
    });
    try {
      let settled = false;
      const action = handle.perform({ action: "compact", applicationOperationId: "compact" });
      void action.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(settled).toBe(false);
      expect(operations.getOperation(conversation.scope, "thread", "compact")?.state).toBe("sent");
      await vi.advanceTimersByTimeAsync(4_999);
      await expect(action).resolves.toMatchObject({ accepted: true });
      expect(operations.getOperation(conversation.scope, "thread", "compact")?.state).toBe("completed");
      expect(fixture.commands.filter(command => command.type === "compact")).toHaveLength(1);
    } finally { timeout.mockRestore(); vi.useRealTimers(); await handle.close(); }
  });
  it("keeps the control deadline and cancellation of unbounded retained-outcome polling", async () => {
    const { fixture } = setup();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await requestNative(fixture.port, attachment, { channel: "rpc", command: { type: "get_state" } });
    expect(timeout.mock.calls[0]?.[0]).toBeGreaterThan(59_000);
    expect(timeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(60_000); timeout.mockClear();
    fixture.port.request = async () => ({ status: "pending" });
    fixture.port.outcome = vi.fn(async () => ({ status: "pending" as const }));
    const controller = new AbortController();
    const pending = requestNative(fixture.port, attachment, { channel: "rpc", command: { type: "compact" } }, "compact", controller.signal, true, null);
    const result = expect(pending).rejects.toMatchObject({ crossedSubmissionBoundary: true, category: "submission_unknown" });
    await vi.waitFor(() => expect(fixture.port.outcome).toHaveBeenCalled());
    expect(timeout).not.toHaveBeenCalled(); controller.abort();
    await result; timeout.mockRestore();
  });
});
