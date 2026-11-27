import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { ConversationProjector } from "../../src/server/conversations/conversation-projector.js";
import type { BackendConversationEvent } from "../../src/shared/protocol/backend.js";
import type { AgentBackendInstance, AgentConnectionProfile, AttachConversationInput, SubmitTurnInput } from "../../src/server/backends/contracts.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { ANTIGRAVITY_PROTOCOL_RELEASE } from "../../src/server/backends/antigravity/release-profile.js";
import { AntigravityDriver } from "../../src/server/backends/antigravity/driver.js";
import { AntigravityError, type AntigravityAttachment, type AntigravityEvent, type AntigravityOutcome, type AntigravityPort } from "../../src/server/backends/antigravity/port.js";
import type { AntigravityNativeHistory } from "../../src/server/backends/antigravity/native-schema.js";
import { compileBackendModelPolicy, type BackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { buildAntigravityPrompt } from "../../src/server/backends/antigravity/submission.js";
import * as historyProjection from "../../src/server/backends/antigravity/history.js";
import { NO_USAGE_CAPTURE, NO_USAGE_SINK, type UsageSink } from "../../src/server/usage/contracts.js";
import { antigravityHistoryReadSchema } from "../../src/server/backends/antigravity/sidecar/wire.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); vi.restoreAllMocks(); });
const scope = { tenantId: "tenant", principalId: "principal" };
const identity = { sessionId: "4c8ece79-6741-451f-8aa5-e01d576ed055", cwd: "/workspace" };
const submit: SubmitTurnInput = { applicationOperationId: "send", mutationId: "mutation", reconciliationToken: "private-token", source: { kind: "user" },
  text: "  exact input\n", attachments: [], contextExcerpts: [], taskContexts: [] };

function fixture(policy: BackendModelPolicy = { type: "catalog" }, usage?: UsageSink) {
  const instance: AgentBackendInstance = { id: "backend", tenantId: scope.tenantId, kind: "antigravity", label: "Antigravity", enabled: true, configurationRevision: 0, protocolRelease: ANTIGRAVITY_PROTOCOL_RELEASE };
  const connection: AgentConnectionProfile = { id: "connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, backendInstanceId: instance.id,
    templateId: "template", executionEnvironmentId: "environment", kind: "antigravity_acp", label: "Antigravity", enabled: true, configurationRevision: 0 };
  const workspace: ValidatedWorkspace = { canonicalPath: identity.cwd, authorityRevision: 0, summary: { id: "workspace", environmentId: "environment",
    displayName: "Workspace", displayPath: identity.cwd, availability: "available", trustState: "trusted", revision: 0 } };
  const native: AntigravityNativeHistory = { revision: "a".repeat(64), steps: [], executions: [] };
  let nativeContents = JSON.stringify({ steps: native.steps, executions: native.executions });
  const attachment: AntigravityAttachment = { ...identity, handleId: "handle", generation: "generation", retainedAfterSequence: 0, throughSequence: 0,
    retainedOperationIds: [], activePromptIds: [], pendingPermissions: [], createdByOperationId: "creation", setup: { initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      session: { configOptions: [
        { type: "select", category: "model", id: "opaque-model", name: "Model", currentValue: "model", options: [{ value: "model", name: "Model" }, { value: "other", name: "Other" }] },
        { type: "select", category: "thought_level", id: "opaque-effort", name: "Effort", currentValue: "low", options: [{ value: "low", name: "Low" }] },
      ] } } };
  const events: AntigravityEvent[] = [], receipts = new Map<string, AntigravityOutcome>();
  let sequence = 0;
  const emit = (event: AntigravityEvent extends infer E ? E extends AntigravityEvent ? Omit<E, "sequence"> : never : never) => events.push({ ...event, sequence: ++sequence });
  const port: AntigravityPort = {
    connect: vi.fn(async () => ({ runtimeId: "runtime", version: "1.5.14" })), catalog: vi.fn(async () => attachment.setup),
    create: vi.fn(async () => identity), acknowledgeCreation: vi.fn(async () => {}), listSessions: vi.fn(async () => ({ sessions: [] })),
    readHistory: vi.fn(async input => {
      const contents = JSON.stringify({ steps: native.steps, executions: native.executions });
      if (contents !== nativeContents) { native.revision = createHash("sha256").update(contents).digest("hex"); nativeContents = contents; }
      return input.knownRevision === native.revision ? null : { ...identity, native: structuredClone(native) };
    }), attach: vi.fn(async () => attachment),
    attachExisting: vi.fn(async () => attachment),
    request: vi.fn(async ({ operationId, command }) => {
      if (command.type !== "prompt") throw new Error("Unexpected fixture operation");
      const first = command.prompt[0]; if (first?.type !== "text") throw new Error();
      native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: first.text }, executionId: "execution" },
        { index: 1, type: 15, status: 3, hasSubtrajectory: false, response: { text: "Answer", thinking: "", stopReason: 2, toolCalls: [] }, executionId: "execution" });
      const outcome: AntigravityOutcome = { status: "completed", result: { stopReason: "end_turn" } };
      receipts.set(operationId, outcome); emit({ kind: "operation", operationId, outcome }); return outcome;
    }),
    outcome: vi.fn(async ({ operationId }) => receipts.get(operationId) ?? { status: "pending" as const }), acknowledgeOperation: vi.fn(async () => {}),
    observe: vi.fn(async ({ afterSequence }, signal) => { await delay(10, undefined, { signal });
      return { events: events.filter(event => event.sequence > afterSequence), throughSequence: sequence, retainedAfterSequence: 0, activePromptIds: [], closed: false }; }),
    acknowledge: vi.fn(async () => {}), release: vi.fn(async () => {}), retireSession: vi.fn(async () => "retired" as const),
    inspect: vi.fn(async () => ({ runtimeId: "runtime", state: "idle" as const, revision: "revision", blockers: [], retainedSessions: [] })),
    stop: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  const desired = { backendInstanceId: instance.id, connectionProfileId: connection.id, executionEnvironmentId: connection.executionEnvironmentId,
    revision: 0, modelId: "model", thinkingLevel: "low", modeId: null };
  const driver = new AntigravityDriver({ instance, connection, scope, port, settings: { get: () => desired, assertConnection: vi.fn() },
    modelPolicy: compileBackendModelPolicy(policy, "model_effort"), nativeNamespaceKey: "namespace", correlationKey: Buffer.alloc(32, 7), usage });
  disposals.push(() => driver.close());
  const attached: AttachConversationInput = { scope, workspace, binding: { tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
    applicationThreadId: "thread", backendInstanceId: instance.id, connectionProfileId: connection.id, executionEnvironmentId: connection.executionEnvironmentId,
    backendConversationId: identity.sessionId, createdAt: "2026-11-22T00:00:00Z" },
    opaqueBindingDetail: JSON.stringify(driver.nativeBinding(identity.sessionId, identity.cwd)) };
  return { driver, attached, port, native, attachment, receipts, desired, emit };
}

describe("Antigravity driver authority and projection", () => {
  it("finishes the native turn once while its prompt callback holds admission across child work", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    const events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    const child = { sessionId: "a174e3ca-a552-40b7-9832-630a5a0c2b20", state: "active" as const };
    vi.mocked(f.port.request).mockImplementationOnce(async ({ command, operationId }) => {
      if (command.type !== "prompt" || command.prompt[0]?.type !== "text") throw new Error("Expected prompt");
      const step = { status: 3, executionId: "foreground", hasSubtrajectory: false };
      f.native.steps.push(
        { ...step, index: 0, type: 14, user: { text: command.prompt[0].text } },
        { ...step, index: 1, type: 132, subagents: [child] },
        { ...step, index: 2, type: 15, response: { text: "Initial reply", thinking: "", stopReason: 2, toolCalls: [] } });
      f.receipts.set(operationId, { status: "pending" });
      return { status: "pending" };
    });
    await handle.submit(submit);
    const projection = () => handle.establishProjection({ signal: new AbortController().signal });
    expect((await projection()).snapshot).toMatchObject({ runState: "running", backgroundActivity: { agents: 1 },
      turnsById: { "input:0": { status: "completed" } } });
    expect((await projection()).snapshot.activeBackendTurnId).toBeUndefined();
    await expect(handle.captureSubmissionRetryAnchor()).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(handle.submit({ ...submit, applicationOperationId: "later" })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.port.request).toHaveBeenCalledTimes(1);

    vi.mocked(f.port.request).mockImplementationOnce(async ({ command }) => {
      expect(command.type).toBe("cancel");
      f.native.steps[1]!.subagents = [{ ...child, state: "cancelled" }];
      const cancelled = { status: "completed" as const, result: { stopReason: "cancelled" } };
      f.receipts.set("send", cancelled);
      f.emit({ kind: "operation", operationId: "send", outcome: cancelled });
      return { status: "completed", result: {} };
    });
    await handle.interrupt({ applicationOperationId: "stop", deadlineAt: Date.now() + 1000 });
    await vi.waitFor(async () => expect((await projection()).snapshot).toMatchObject({ runState: "idle", backgroundActivity: { agents: 0 } }));
    expect(events.filter(event => event.type === "turn_completed")).toHaveLength(1);
    await expect(handle.captureSubmissionRetryAnchor()).resolves.toBe(f.native.revision);
  });
  it("restores held prompt admission on a cold attach and releases it after every prompt settles", async () => {
    const f = fixture();
    f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "Existing input" } },
      { index: 1, type: 15, status: 3, hasSubtrajectory: false, response: { text: "Initial reply", thinking: "", stopReason: 2, toolCalls: [] } });
    // An unrelated pending operation is retained too. Only ACP prompts hold Send.
    vi.mocked(f.port.attach).mockResolvedValue({ ...f.attachment, retainedOperationIds: ["first", "steer", "setter"],
      activePromptIds: ["first", "steer"] });
    const handle = await f.driver.attach(f.attached);
    const snapshot = async () => (await handle.establishProjection({ signal: new AbortController().signal })).snapshot;
    expect(await snapshot()).toMatchObject({ runState: "running", turnsById: { "input:0": { status: "completed" } } });
    // The child wakes the planner before it streams another chunk. The
    // callback still owns the session, so Stop and conversation Steer remain
    // available while the new native turn materializes.
    f.native.steps.push({ index: 2, type: 101, status: 3, hasSubtrajectory: false,
      continuation: { id: "wake", sender: "child", recipient: identity.sessionId, kind: "agent_message", content: "Finished" } });
    expect(await snapshot()).toMatchObject({ runState: "running", turnsById: { "continuation:2": { status: "in_progress" } } });
    f.native.steps.push({ index: 3, type: 15, status: 3, hasSubtrajectory: false,
      response: { text: "Child complete", thinking: "", stopReason: 2, toolCalls: [] } });
    for (const [id, state] of [["first", "running"], ["steer", "idle"]] as const) {
      const outcome = { status: "completed" as const, result: { stopReason: "end_turn" } };
      f.receipts.set(id, outcome); f.emit({ kind: "operation", operationId: id, outcome });
      await vi.waitFor(() => expect(f.port.acknowledge).toHaveBeenCalledWith(
        { handleId: "handle", throughSequence: id === "first" ? 1 : 2 }, expect.any(AbortSignal)));
      expect((await snapshot()).runState).toBe(state);
    }
    expect(f.port.request).not.toHaveBeenCalled();
  });
  it("recovers active prompt inventory after an event gap without reviving a settled callback on replay", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    const projection = async () => (await handle.establishProjection({ signal: new AbortController().signal })).snapshot;
    vi.mocked(f.port.observe).mockImplementation(async ({ afterSequence }, signal) => {
      await delay(10, undefined, { signal });
      return { events: [], retainedAfterSequence: 1, throughSequence: Math.max(afterSequence, 1),
        activePromptIds: ["other-controller"], closed: false };
    });
    f.receipts.set("other-controller", { status: "pending" });
    await vi.waitFor(async () => expect((await projection()).runState).toBe("running"));
    // A detached controller's terminal event was lost. Its retained receipt
    // wins even if an older prompt inventory is in transit.
    f.receipts.set("other-controller", { status: "completed", result: { stopReason: "end_turn" } });
    await vi.waitFor(async () => expect((await projection()).runState).toBe("idle"), { timeout: 2500 });
    expect((await projection()).runState).toBe("idle");
  });
  it("keeps a background daemon independent of prompt admission", async () => {
    const f = fixture();
    f.native.steps.push({ index: 0, type: 132, status: 2, hasSubtrajectory: false,
      task: { id: "server", title: "Dev server", description: "", daemon: true },
      command: { command: "serve", cwd: identity.cwd, output: "", persistent: true, commandId: "server" } });
    const handle = await f.driver.attach(f.attached);
    expect((await handle.establishProjection({ signal: new AbortController().signal })).snapshot)
      .toMatchObject({ runState: "idle", backgroundActivity: { commands: 1 } });
    await expect(handle.captureSubmissionRetryAnchor()).resolves.toBe(f.native.revision);
  });
  it.each([false, true])("reads fresh Steer evidence after a permission wakes the throttled wait (consumed: %s)", async consumed => {
    const f = fixture();
    const pending = { requestId: "permission", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
      toolCall: { toolCallId: "tool", title: "Permission" }, options: [{ optionId: "deny", name: "Deny", kind: "reject_once" as const }] } };
    let text: string | undefined, written = false;
    const read = vi.mocked(f.port.readHistory).getMockImplementation()!;
    vi.mocked(f.port.readHistory).mockImplementation(async input => {
      const result = await read(input);
      if (text && !written) {
        written = true;
        f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, executionId: "steered", user: { text } });
        if (consumed) f.native.steps.push({ index: 1, type: 15, status: 2, hasSubtrajectory: false, executionId: "steered",
          response: { text: "Following steer", thinking: "", stopReason: 0, toolCalls: [] } });
        f.emit({ kind: "permission", ...pending });
      }
      return result;
    });
    const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockImplementationOnce(async ({ command }) => {
      if (command.type !== "steer" || command.prompt[0]?.type !== "text") throw new Error("Expected steer");
      text = command.prompt[0].text; return { status: "pending" };
    });
    await expect(handle.steer({ ...submit, target: { kind: "conversation" } })).resolves.toMatchObject({
      status: consumed ? "accepted" : "pending_materialization",
    });
    expect(f.port.readHistory).toHaveBeenCalledTimes(3);
  });
  it("makes one fresh final Steer read before declaring the deadline uncertain", async () => {
    const f = fixture(); let now = 1_000_000, text: string | undefined, written = false;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = vi.mocked(f.port.readHistory).getMockImplementation()!;
    vi.mocked(f.port.readHistory).mockImplementation(async input => {
      const result = await read(input);
      if (text && !written) {
        written = true; now += 1001;
        f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text } });
      }
      return result;
    });
    const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockImplementationOnce(async ({ command }) => {
      if (command.type !== "steer" || command.prompt[0]?.type !== "text") throw new Error("Expected steer");
      text = command.prompt[0].text; return { status: "pending" };
    });
    await expect(handle.steer({ ...submit, target: { kind: "conversation" } })).resolves.toMatchObject({ status: "pending_materialization" });
    expect(f.port.readHistory).toHaveBeenCalledTimes(3);
  });
  it("refreshes terminal history before Stop returns inside the ordinary throttle interval", async () => {
    const f = fixture();
    f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "input" } },
      { index: 1, type: 15, status: 2, hasSubtrajectory: false, response: { text: "working", thinking: "", stopReason: 0, toolCalls: [] } });
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    vi.mocked(f.port.request).mockImplementationOnce(async () => {
      f.native.steps[1] = { ...f.native.steps[1]!, status: 6, response: { text: "interrupted", thinking: "", stopReason: 16, toolCalls: [] } };
      return { status: "completed", result: {} };
    });
    await handle.interrupt({ applicationOperationId: "stop", deadlineAt: Date.now() + 1000 });
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed", turn: expect.objectContaining({ status: "interrupted" }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: "run_state_changed", state: "idle" }));
  });
  it("does not resurrect a permission resolved during a retained attachment read", async () => {
    const f = fixture();
    const pending = { requestId: "permission", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
      toolCall: { toolCallId: "tool", title: "Permission" }, options: [{ optionId: "deny", name: "Deny", kind: "reject_once" as const }] } };
    const attachment = { ...f.attachment, pendingPermissions: [pending] };
    vi.mocked(f.port.attach).mockResolvedValue(attachment);
    let finish!: (value: AntigravityAttachment) => void;
    vi.mocked(f.port.attachExisting).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(f.port.observe).mockRejectedValueOnce(new Error("transient"));
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    await vi.waitFor(() => expect(f.port.attachExisting).toHaveBeenCalledOnce());
    vi.mocked(f.port.request).mockResolvedValueOnce({ status: "completed", result: {} });
    await handle.respond({ applicationOperationId: "deny", interactionId: pending.requestId, kind: "cancel" });
    finish(attachment);
    await vi.waitFor(() => expect(vi.mocked(f.port.observe).mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    expect(events.filter(event => event.type === "interaction_resolved")).toHaveLength(1);
    expect(events.filter(event => event.type === "interaction_opened")).toHaveLength(0);
    await expect(handle.respond({ applicationOperationId: "duplicate", interactionId: pending.requestId, kind: "cancel" }))
      .rejects.toMatchObject({ category: "invalid_state" });
  });
  it("keeps background work revealed while disconnected fenced after its service is replaced", async () => {
    const f = fixture();
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    const port = f.port as AntigravityPort & { serviceReplaced?: boolean };
    let finish!: () => void;
    vi.mocked(f.port.observe).mockRejectedValue(new Error("carrier lost"));
    vi.mocked(f.port.attachExisting).mockImplementation(() => new Promise((_resolve, reject) => {
      finish = () => { port.serviceReplaced = true; reject(new Error("antigravity_runtime_incarnation_changed")); };
    }));
    await vi.waitFor(() => expect(f.port.attachExisting).toHaveBeenCalledOnce());
    // A history read during retained recovery reveals a background child agent.
    f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "Delegate" }, executionId: "execution",
      subagents: [{ sessionId: "child", state: "active" }] } as AntigravityNativeHistory["steps"][number]);
    await handle.establishProjection({ signal: new AbortController().signal });
    finish();
    await vi.waitFor(() => expect(handle.providerServiceReplacementSafe).toBe(false));
    expect(events.filter(event => event.type === "background_activity_changed").at(-1)).toMatchObject({ activity: { state: "unknown" } });
    await handle.close();
  });
  it.each(["replaced", "permission", "carrier"] as const)("stops recovering a retired runtime and vouches for replacement retirement only when settled (%s)", async disposition => {
    const f = fixture();
    const pending = { requestId: "permission", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
      toolCall: { toolCallId: "tool", title: "Permission" }, options: [{ optionId: "deny", name: "Deny", kind: "reject_once" as const }] } };
    if (disposition === "permission") vi.mocked(f.port.attach).mockResolvedValue({ ...f.attachment, pendingPermissions: [pending] });
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    expect(handle.providerServiceReplacementSafe).toBe(disposition === "permission" ? false : undefined);
    const port = f.port as AntigravityPort & { serviceReplaced?: boolean };
    vi.mocked(f.port.observe).mockRejectedValue(new Error("carrier lost"));
    vi.mocked(f.port.attachExisting).mockImplementation(async () => {
      if (disposition !== "carrier") port.serviceReplaced = true;
      throw new Error("antigravity_runtime_incarnation_changed");
    });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "run_state_changed", state: "disconnected" })));
    await vi.waitFor(() => expect(f.port.attachExisting).toHaveBeenCalled());
    await delay(1_200);
    if (disposition === "carrier") {
      // An unproven owner keeps polling and its background stays unknown.
      expect(vi.mocked(f.port.attachExisting).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(handle.providerServiceReplacementSafe).toBeUndefined();
      expect(events.filter(event => event.type === "background_activity_changed").at(-1)).toMatchObject({ activity: { state: "unknown" } });
    } else {
      // The retired owner can never return: stop polling it.
      expect(f.port.attachExisting).toHaveBeenCalledOnce();
      expect(handle.providerServiceReplacementSafe).toBe(disposition === "replaced");
      // Background confirmed idle before the disconnect is settled by the retirement.
      expect(events.filter(event => event.type === "background_activity_changed").at(-1))
        .toMatchObject({ activity: { state: "known", agents: 0, commands: 0, other: 0 } });
    }
    await handle.close();
    expect(f.port.release).toHaveBeenCalledOnce();
  });
  it("acknowledges accepted ACP events even when passive history fails, without replaying permissions", async () => {
    const f = fixture();
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    const pending = { requestId: "permission", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
      toolCall: { toolCallId: "tool", title: "Permission" }, options: [{ optionId: "deny", name: "Deny", kind: "reject_once" as const }] } };
    vi.mocked(f.port.attachExisting).mockResolvedValue({ ...f.attachment, throughSequence: 1, pendingPermissions: [pending] });
    vi.mocked(f.port.readHistory).mockRejectedValue(new AntigravityError("antigravity_history_worker_backoff"));
    f.emit({ kind: "permission", ...pending });
    await vi.waitFor(() => expect(f.port.attachExisting).toHaveBeenCalled(), { timeout: 2000 });
    expect(f.port.acknowledge).toHaveBeenCalledWith({ handleId: "handle", throughSequence: 1 }, expect.any(AbortSignal));
    await vi.waitFor(() => expect(vi.mocked(f.port.attachExisting).mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2500 });
    expect(events.filter(event => event.type === "interaction_opened")).toHaveLength(1);
    expect(vi.mocked(f.port.observe).mock.calls.at(-1)?.[0].afterSequence).toBe(1);
  });
  it.each([false, true])("only releases terminal retained receipts abandoned by this application thread (abandoned: %s)", async abandoned => {
    const f = fixture();
    Object.assign(f.driver.input, { isOperationAbandoned: (threadId: string, operationId: string) => abandoned && threadId === "thread" && operationId === "withdrawn" });
    vi.mocked(f.port.attach).mockResolvedValue({ ...f.attachment, retainedOperationIds: ["withdrawn", "still-pending"] });
    f.receipts.set("withdrawn", { status: "completed", result: { stopReason: "cancelled" }, cancelledAtNativeRevision: f.native.revision });
    const handle = await f.driver.attach(f.attached);
    await handle.close();
    expect(f.port.acknowledgeOperation).toHaveBeenCalledTimes(abandoned ? 1 : 0);
    if (abandoned) expect(f.port.acknowledgeOperation).toHaveBeenCalledWith({ handleId: "handle", operationId: "withdrawn" }, expect.any(AbortSignal));
  });
  it("clears an explicitly abandoned synthetic receipt before polling the missing host operation", async () => {
    const f = fixture(); let abandoned = false;
    Object.assign(f.driver.input, { isOperationAbandoned: (_threadId: string, operationId: string) => abandoned && operationId === "send" });
    const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockRejectedValue(new AntigravityError("antigravity_sidecar_unavailable", "sent_outcome_unknown"));
    vi.mocked(f.port.outcome).mockRejectedValue(new AntigravityError("antigravity_operation_unknown", "sent_outcome_unknown"));
    await expect(handle.submit(submit)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    abandoned = true;
    await expect(handle.establishProjection({ signal: new AbortController().signal })).resolves.toBeDefined();
    expect(f.port.outcome).toHaveBeenCalledWith({ handleId: "handle", operationId: "send" }, expect.any(AbortSignal));
    expect(f.port.acknowledgeOperation).not.toHaveBeenCalled();
    await handle.close(); expect(f.port.release).toHaveBeenCalled();
  });
  it("releases a closed handle even when abandoned-receipt cleanup loses the carrier", async () => {
    const f = fixture(); let abandoned = false;
    Object.assign(f.driver.input, { isOperationAbandoned: () => abandoned });
    vi.mocked(f.port.attach).mockResolvedValue({ ...f.attachment, retainedOperationIds: ["withdrawn"] });
    f.receipts.set("withdrawn", { status: "completed", result: { stopReason: "cancelled" } });
    const handle = await f.driver.attach(f.attached); abandoned = true;
    vi.mocked(f.port.outcome).mockRejectedValue(new AntigravityError("antigravity_sidecar_unavailable", "sent_outcome_unknown"));
    await expect(handle.close()).resolves.toBeUndefined();
    expect(f.port.release).toHaveBeenCalled(); expect(f.driver.handles.size).toBe(0);
    expect(f.port.acknowledgeOperation).not.toHaveBeenCalled();
  });
  it("throttles pending abandoned outcomes across streaming chunks and normalizes projection read failures", async () => {
    const f = fixture();
    Object.assign(f.driver.input, { isOperationAbandoned: () => true });
    vi.mocked(f.port.attach).mockResolvedValue({ ...f.attachment, retainedOperationIds: ["pending"] });
    const handle = await f.driver.attach(f.attached);
    await vi.waitFor(() => expect(vi.mocked(f.port.outcome).mock.calls.length).toBeGreaterThanOrEqual(2));
    const before = vi.mocked(f.port.outcome).mock.calls.length;
    for (let index = 1; index <= 3; index++) {
      f.emit({ kind: "update", notification: { sessionId: identity.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "chunk" } } } });
      await vi.waitFor(() => expect(f.port.acknowledge).toHaveBeenCalledWith({ handleId: "handle", throughSequence: index }, expect.any(AbortSignal)));
    }
    expect(vi.mocked(f.port.outcome).mock.calls.length).toBe(before);
    vi.mocked(f.port.outcome).mockRejectedValue(new AntigravityError("antigravity_sidecar_unavailable", "sent_outcome_unknown"));
    await expect(handle.establishProjection({ signal: new AbortController().signal })).rejects.toMatchObject({
      category: "unavailable", crossedSubmissionBoundary: false, backendCode: "antigravity_sidecar_unavailable",
    });
  });
  it("polls idle native changes without reprojecting or accounting unchanged history", async () => {
    const project = vi.spyOn(historyProjection, "projectAntigravityHistory");
    const capture = { ...NO_USAGE_CAPTURE, registerTurns: vi.fn(), reconcile: vi.fn(() => true) };
    const f = fixture({ type: "catalog" }, { ...NO_USAGE_SINK, open: () => capture });
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    await delay(550);
    expect(f.port.observe).toHaveBeenCalled();
    expect(vi.mocked(f.port.readHistory).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(f.port.readHistory).mock.calls.length).toBeLessThanOrEqual(4);
    expect(project).toHaveBeenCalledOnce(); expect(capture.registerTurns).toHaveBeenCalledOnce(); expect(capture.reconcile).toHaveBeenCalledOnce();
    f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "External input without ACP events" } },
      { index: 1, type: 15, status: 3, hasSubtrajectory: false, response: { text: "External answer", thinking: "", stopReason: 2, toolCalls: [] } });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed", turn: expect.objectContaining({ status: "completed" }) })));
    expect(project).toHaveBeenCalledTimes(2); expect(capture.reconcile).toHaveBeenCalledTimes(2);
    await handle.close(); project.mockRestore();
  });
  it("publishes permission and context events promptly while native history is unchanged", async () => {
    const project = vi.spyOn(historyProjection, "projectAntigravityHistory");
    const f = fixture();
    f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "Ongoing input" } });
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    for (let index = 0; index < 30; index++) f.emit({ kind: "update", notification: { sessionId: identity.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Streaming" } } } });
    f.emit({ kind: "update", notification: { sessionId: identity.sessionId,
      update: { sessionUpdate: "usage_update", used: 100, size: 1000 } } });
    f.emit({ kind: "permission", requestId: "permission", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
      toolCall: { toolCallId: "tool", title: "Run command" }, options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }] } });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "interaction_opened" })), { timeout: 200, interval: 10 });
    expect(events).toContainEqual(expect.objectContaining({ type: "usage_changed", usage: expect.objectContaining({ context: { usedTokens: 100, windowTokens: 1000, percent: 10 } }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: "run_state_changed", state: "running" }));
    expect(project).toHaveBeenCalledOnce();
    await handle.close(); project.mockRestore();
  });
  it("flushes a coalesced final update while the next observation is still waiting", async () => {
    const f = fixture();
    let first = true;
    vi.mocked(f.port.observe).mockImplementation(async ({ afterSequence }, signal) => {
      // Hold the next observation until close aborts it. This proves the
      // trailing refresh is independent of another provider poll, without a
      // wall-clock race against the test host's scheduling load.
      await delay(first ? 20 : 60_000, undefined, { signal }); first = false;
      return { events: afterSequence === 0 ? [{ sequence: 1, kind: "update", notification: { sessionId: identity.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Final answer" } } } }] : [],
        throughSequence: 1, retainedAfterSequence: 0, activePromptIds: [], closed: false };
    });
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "External input" } },
      { index: 1, type: 15, status: 3, hasSubtrajectory: false, response: { text: "Final answer", thinking: "", stopReason: 2, toolCalls: [] } });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed" })), { timeout: 3000 });
    expect(f.port.observe).toHaveBeenCalledTimes(2); await handle.close();
    const reads = vi.mocked(f.port.readHistory).mock.calls.length;
    await delay(300); expect(f.port.readHistory).toHaveBeenCalledTimes(reads);
  });
  it("retries failed usage reconciliation without requiring a new native revision", async () => {
    const capture = { ...NO_USAGE_CAPTURE, reconcile: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) };
    const f = fixture({ type: "catalog" }, { ...NO_USAGE_SINK, open: () => capture });
    const handle = await f.driver.attach(f.attached);
    await vi.waitFor(() => expect(capture.reconcile).toHaveBeenCalledTimes(2));
    await delay(300); expect(capture.reconcile).toHaveBeenCalledTimes(2); await handle.close();
  });
  it("cancels a pending trailing refresh when the handle closes", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    f.emit({ kind: "update", notification: { sessionId: identity.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Chunk" } } } });
    await vi.waitFor(() => expect(f.port.acknowledge).toHaveBeenCalled());
    await handle.close(); const reads = vi.mocked(f.port.readHistory).mock.calls.length;
    await delay(300); expect(f.port.readHistory).toHaveBeenCalledTimes(reads);
  });
  it("marks failed trailing reads disconnected instead of retaining a ready snapshot", async () => {
    const f = fixture(); let first = true;
    vi.mocked(f.port.observe).mockImplementation(async (_, signal) => {
      await delay(first ? 20 : 60_000, undefined, { signal }); first = false;
      return { events: [], throughSequence: 0, retainedAfterSequence: 0, activePromptIds: [], closed: false };
    });
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    vi.mocked(f.port.readHistory).mockRejectedValueOnce(new Error("native read failed"));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "run_state_changed", state: "disconnected" })), { timeout: 3000 });
    expect(f.port.attachExisting).not.toHaveBeenCalled(); await handle.close();
  });
  it("acknowledges a late prompt outcome against an unchanged terminal native snapshot", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockImplementationOnce(async ({ command, operationId }) => {
      if (command.type !== "prompt" || command.prompt[0]?.type !== "text") throw new Error("Expected prompt");
      f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: command.prompt[0].text } },
        { index: 1, type: 15, status: 3, hasSubtrajectory: false, response: { text: "Answer", thinking: "", stopReason: 2, toolCalls: [] } });
      const pending = { status: "pending" as const }; f.receipts.set(operationId, pending); return pending;
    });
    await expect(handle.submit(submit)).resolves.toMatchObject({ accepted: true });
    expect(f.port.acknowledgeOperation).not.toHaveBeenCalled();
    const outcome = { status: "completed" as const, result: { stopReason: "end_turn" } };
    f.receipts.set(submit.applicationOperationId, outcome); f.emit({ kind: "operation", operationId: submit.applicationOperationId, outcome });
    await vi.waitFor(() => expect(f.port.acknowledgeOperation).toHaveBeenCalledWith({ handleId: "handle", operationId: submit.applicationOperationId }, expect.any(AbortSignal)));
    await handle.close();
  });
  it("discovers timestamped native sessions without loading their transcripts", async () => {
    const f = fixture();
    vi.mocked(f.port.listSessions).mockResolvedValue({ sessions: [{ ...identity, updatedAt: "2026-11-22T00:00:00Z", title: "Native session" }] });
    expect(await f.driver.discover({ scope, workspace: f.attached.workspace, signal: new AbortController().signal, limit: 50 }))
      .toMatchObject({ conversations: [{ backendConversationId: identity.sessionId, title: "Native session" }] });
    expect(f.port.readHistory).not.toHaveBeenCalled();
    vi.mocked(f.port.listSessions).mockRejectedValue(new Error("sensitive-native-path"));
    await expect(f.driver.discover({ scope, workspace: f.attached.workspace, signal: new AbortController().signal, limit: 50 }))
      .rejects.toMatchObject({ category: "unavailable", crossedSubmissionBoundary: false });
  });
  it("derives missing timestamps for titled sessions through the strict history identity contract", async () => {
    const f = fixture();
    vi.mocked(f.port.listSessions).mockResolvedValue({ sessions: [{ ...identity, title: "Native title" }] });
    vi.mocked(f.port.readHistory).mockImplementation(async input => {
      const parsed = antigravityHistoryReadSchema.parse(input);
      return { sessionId: parsed.sessionId, cwd: parsed.cwd, native: { ...f.native, steps: [
        { index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "Native input" }, createdAt: "2026-11-22T00:00:00Z" },
      ] } };
    });
    await expect(f.driver.discover({ scope, workspace: f.attached.workspace, signal: new AbortController().signal, limit: 50 }))
      .resolves.toMatchObject({ conversations: [{ backendConversationId: identity.sessionId, title: "Native title", updatedAt: "2026-11-22T00:00:00Z" }] });
    expect(f.port.readHistory).toHaveBeenCalledExactlyOnceWith(identity, expect.any(AbortSignal));
  });
  it("pages every missing-timestamp session within the fallback budget and rejects cross-workspace cursors", async () => {
    const f = fixture();
    const sessions = Array.from({ length: 6 }, (_, index) => ({ ...identity, sessionId: `4c8ece79-6741-451f-8aa5-e01d576ed05${index}` }));
    vi.mocked(f.port.listSessions).mockResolvedValue({ sessions });
    vi.mocked(f.port.readHistory).mockImplementation(async value => ({ ...value, native: { ...f.native, steps: [
      { index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "Native input" }, createdAt: "2026-11-22T00:00:00Z" },
    ] } }));
    const request = { scope, workspace: f.attached.workspace, signal: new AbortController().signal, limit: 50 };
    const first = await f.driver.discover(request);
    expect(first.conversations).toHaveLength(4); expect(f.port.readHistory).toHaveBeenCalledTimes(4);
    await expect(f.driver.discover({ ...request, cursor: first.nextCursor, workspace: { ...request.workspace, canonicalPath: "/other" } }))
      .rejects.toMatchObject({ category: "unavailable" });
    const second = await f.driver.discover({ ...request, cursor: first.nextCursor, limit: 1 });
    const third = await f.driver.discover({ ...request, cursor: second.nextCursor });
    expect([...first.conversations, ...second.conversations, ...third.conversations].map(value => value.backendConversationId))
      .toEqual(sessions.map(value => value.sessionId));
    expect(third.nextCursor).toBeUndefined(); expect(f.port.listSessions).toHaveBeenCalledTimes(1);
  });
  it("keeps older unresolved turns outside a valid bounded snapshot page", async () => {
    const f = fixture();
    f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "Unresolved old input" } });
    for (let index = 1; index <= 60; index++) f.native.steps.push(
      { index: index * 2, type: 14, status: 3, hasSubtrajectory: false, user: { text: `Later input ${index}` } },
      { index: index * 2 + 1, type: 15, status: 3, hasSubtrajectory: false, response: { text: "Settled", thinking: "", stopReason: 2, toolCalls: [] } },
    );
    const handle = await f.driver.attach(f.attached);
    const live = await handle.establishProjection({ signal: new AbortController().signal });
    expect(live.snapshot.orderedBackendTurnIds).toHaveLength(50);
    expect(live.snapshot.activeBackendTurnId).toBeUndefined();
    expect(live.snapshot.runState).toBe("reconciling");
    const reader = await f.driver.openHistory(f.attached);
    const passive = await reader.readSnapshot({ signal: new AbortController().signal });
    expect(passive.snapshot).toEqual(live.snapshot); await reader.close();
  });
  it("preserves a proved rejection when its receipt acknowledgement is unavailable", async () => {
    const f = fixture(); const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockResolvedValueOnce({ status: "failed", failure: { code: "rejected", delivery: "not_sent" } });
    vi.mocked(f.port.acknowledgeOperation).mockRejectedValueOnce(new AntigravityError("carrier_lost", "sent_outcome_unknown"));
    await expect(handle.submit(submit)).rejects.toMatchObject({ category: "rejected", crossedSubmissionBoundary: false, retryable: true });
    vi.mocked(f.port.readHistory).mockRejectedValue(new Error("private native path"));
    await expect(handle.establishProjection({ signal: new AbortController().signal })).rejects.toMatchObject({ category: "unavailable", crossedSubmissionBoundary: false });
  });
  it("acknowledges definite failed controls while retaining uncertain effects", async () => {
    const f = fixture(); const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockResolvedValueOnce({ status: "failed", failure: { code: "native_rejected", delivery: "rejected" } });
    await expect(handle.perform({ applicationOperationId: "definite", action: "set_model", provider: "connection", modelId: "other" }))
      .rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.port.acknowledgeOperation).toHaveBeenCalledWith({ handleId: "handle", operationId: "definite" }, expect.any(AbortSignal));
    vi.mocked(f.port.request).mockResolvedValueOnce({ status: "failed", failure: { code: "carrier_lost", delivery: "sent_outcome_unknown" } });
    await expect(handle.perform({ applicationOperationId: "uncertain", action: "set_model", provider: "connection", modelId: "other" }))
      .rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(vi.mocked(f.port.acknowledgeOperation).mock.calls.some(([input]) => input.operationId === "uncertain")).toBe(false);
    expect(handle.retirementBlocked).toBe(true);
  });
  it("wakes control waits from retained operation events without rapid receipt polling", async () => {
    const f = fixture(); const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockResolvedValue({ status: "pending" });
    const action = handle.perform({ applicationOperationId: "control", action: "set_model", provider: "connection", modelId: "other" });
    await vi.waitFor(() => expect(f.port.outcome).toHaveBeenCalledTimes(1));
    f.emit({ kind: "operation", operationId: "control", outcome: { status: "completed", result: {} } });
    await expect(action).resolves.toEqual({ accepted: true });
    expect(f.port.outcome).toHaveBeenCalledTimes(1);
  });
  it("does not attribute later unobserved completions to an earlier live stream", async () => {
    const f = fixture(); const handle = await f.driver.attach(f.attached);
    const events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    await handle.submit(submit);
    expect(events.find(event => event.type === "turn_completed")).not.toHaveProperty("completionProvenance");
    f.native.steps.push(
      { index: 2, type: 14, status: 3, hasSubtrajectory: false, user: { text: "External input" }, executionId: "external" },
      { index: 3, type: 15, status: 3, hasSubtrajectory: false, response: { text: "Unobserved answer", thinking: "", stopReason: 2, toolCalls: [] }, executionId: "external" },
    );
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed", completionProvenance: "recovered",
      turn: expect.objectContaining({ backendTurnId: "input:2" }) })));
  });
  it("marks completions recovered across a replay gap even when buffered chunks arrive", async () => {
    const f = fixture(); const handle = await f.driver.attach(f.attached);
    const events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    await handle.submit(submit);
    f.native.steps.push(
      { index: 2, type: 14, status: 3, hasSubtrajectory: false, user: { text: "External input" }, executionId: "external" },
      { index: 3, type: 15, status: 3, hasSubtrajectory: false, response: { text: "Recovered answer", thinking: "", stopReason: 2, toolCalls: [] }, executionId: "external" },
    );
    vi.mocked(f.port.observe).mockImplementation(async (_, signal) => { await delay(10, undefined, { signal }); return {
      events: [{ sequence: 11, kind: "update", notification: { sessionId: identity.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Buffered answer" } } } }],
      throughSequence: 11, retainedAfterSequence: 10, activePromptIds: [], closed: false,
    }; });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "resnapshot_required", reason: "sequence_gap" })));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed", completionProvenance: "recovered",
      turn: expect.objectContaining({ backendTurnId: "input:2" }) }));
  });
  it("keeps passive history and wrong-scope reads away from provider launch", async () => {
    const f = fixture();
    const reader = await f.driver.openHistory(f.attached);
    expect((await reader.readSnapshot({ signal: new AbortController().signal })).snapshot.runState).toBe("idle");
    expect(f.port.attach).not.toHaveBeenCalled(); expect(f.port.connect).not.toHaveBeenCalled();
    await expect(f.driver.openHistory({ ...f.attached, scope: { ...scope, principalId: "other" } })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.port.readHistory).toHaveBeenCalledTimes(1);
    await reader.close(); await expect(reader.usage()).rejects.toMatchObject({ category: "unavailable" });
  });
  it("acknowledges creation only after binding and preserves exact live/passive identities", async () => {
    const f = fixture();
    await f.driver.create({ scope, workspace: f.attached.workspace, applicationThreadId: "thread", applicationOperationId: "creation", creationCorrelation: "create-token", source: { kind: "user" } });
    expect(f.port.acknowledgeCreation).not.toHaveBeenCalled();
    const handle = await f.driver.attach(f.attached);
    expect(f.port.acknowledgeCreation).toHaveBeenCalledWith({ ...identity, operationId: "creation" });
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    const events: BackendConversationEvent[] = [];
    handle.subscribe(() => { throw new Error("broken consumer"); }); handle.subscribe(event => events.push(event));
    const accepted = await handle.submit(submit);
    expect(accepted).toMatchObject({ backendTurnId: "input:0", completionCorrelation: "send" });
    const replay: number[] = []; const unsubscribe = established.subscribeFromNext(event => replay.push(event.handleSequence));
    expect(replay).toEqual(replay.map((_, index) => index + established.handleSequence + 1)); unsubscribe();
    expect(events.filter(event => event.type === "turn_completed")).toHaveLength(1);
    const reader = await f.driver.openHistory(f.attached);
    const passive = await reader.readSnapshot({ signal: new AbortController().signal });
    expect(passive.snapshot.itemsById["step:0:user"]).toMatchObject({ deliveryOperationId: "send", content: [{ kind: "text", text: { text: submit.text } }] });
    expect(await f.driver.reconcileSubmission({ ...f.attached, applicationOperationId: "send", reconciliationToken: submit.reconciliationToken })).toMatchObject({ status: "accepted", backendTurn: { backendTurnId: "input:0" } });
    await reader.close(); await handle.close(); await expect(handle.usage()).rejects.toMatchObject({ category: "unavailable" });
  });
  it("checks model policy before any new provider effect, including direct action invocation", async () => {
    const f = fixture({ type: "allowlist", allowed: [{ modelIds: ["other"] }] });
    const handle = await f.driver.attach(f.attached);
    await expect(handle.submit(submit)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(handle.perform({ applicationOperationId: "model-change", action: "set_model", provider: "connection", modelId: "model" })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(handle.steer({ ...submit, target: { kind: "conversation" } })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.port.request).not.toHaveBeenCalled();
  });
  it("keeps proven pre-dispatch failures retryable without a phantom pending send", async () => {
    const f = fixture(); const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockRejectedValueOnce(new AntigravityError("antigravity_session_busy"));
    await expect(handle.submit(submit)).rejects.toMatchObject({ category: "rejected", crossedSubmissionBoundary: false });
    await expect(handle.submit(submit)).resolves.toMatchObject({ accepted: true });
  });
  it("retains uncertain acceptance without replay when the provider write may have happened", async () => {
    const f = fixture(); const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockRejectedValueOnce(new AntigravityError("carrier_lost", "sent_outcome_unknown"));
    await expect(handle.submit(submit)).rejects.toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true });
    expect(handle.retirementBlocked).toBe(true);
    await expect(handle.submit(submit)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.port.request).toHaveBeenCalledTimes(1);
    await expect(f.driver.reconcileSubmission({ ...f.attached, applicationOperationId: "send", reconciliationToken: submit.reconciliationToken })).resolves.toMatchObject({ status: "unresolved" });
  });
  it("returns unconsumed Stop inputs only after exact host drain proof, including absent native rows", async () => {
    const f = fixture();
    const request = { ...f.attached, applicationOperationId: "send", reconciliationToken: submit.reconciliationToken, steerTarget: { kind: "conversation" as const } };
    f.receipts.set("send", { status: "completed", result: { stopReason: "cancelled" } });
    expect(await f.driver.reconcileSubmission(request)).toMatchObject({ status: "unresolved" });
    f.receipts.set("send", { status: "completed", result: { stopReason: "cancelled" }, cancelledAtNativeRevision: f.native.revision });
    expect(await f.driver.reconcileSubmission(request)).toMatchObject({ status: "not_accepted", retryable: false });
    expect(f.port.acknowledgeOperation).toHaveBeenCalledWith({ handleId: "handle", operationId: "send" });
    expect(f.port.request).not.toHaveBeenCalled();
  });
  it("gives fresh native consumption precedence over a cancelled queued callback", async () => {
    const f = fixture();
    const prompt = await buildAntigravityPrompt({ binding: f.driver.nativeBinding(identity.sessionId, identity.cwd), key: Buffer.alloc(32, 7) }, submit, "", "steer");
    if (prompt[0]?.type !== "text") throw new Error();
    const consumed: AntigravityNativeHistory = { ...f.native, steps: [
      { index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: prompt[0].text }, executionId: "escaped" },
      { index: 1, type: 15, status: 6, hasSubtrajectory: false, response: { text: "Started then interrupted", thinking: "", stopReason: 16, toolCalls: [] }, executionId: "escaped" },
    ] };
    // The first acquisition precedes provider settlement. Drain receipt lookup
    // must be followed by a fresh native acquisition before claiming withdrawal.
    vi.mocked(f.port.readHistory).mockResolvedValueOnce({ ...identity, native: f.native }).mockResolvedValueOnce({ ...identity, native: consumed });
    f.receipts.set("send", { status: "completed", result: { stopReason: "cancelled" }, cancelledAtNativeRevision: f.native.revision });
    expect(await f.driver.reconcileSubmission({ ...f.attached, applicationOperationId: "send", reconciliationToken: submit.reconciliationToken }))
      .toMatchObject({ status: "accepted", backendTurn: { status: "interrupted", completionCorrelations: ["send"] } });
  });
  it.each(["submit", "steer"] as const)("keeps a %s unknown after dispatch when native history cannot be read", async kind => {
    const f = fixture();
    if (kind === "steer") f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "Ongoing input" } },
      { index: 1, type: 15, status: 2, hasSubtrajectory: false, response: { text: "Streaming", thinking: "", stopReason: 0, toolCalls: [] } });
    const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockImplementationOnce(async () => {
      vi.mocked(f.port.readHistory).mockRejectedValue(new Error("private native path")); return { status: "pending" };
    });
    const work = kind === "submit" ? handle.submit(submit) : handle.steer({ ...submit, target: { kind: "conversation" } });
    await expect(work).rejects.toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false });
    expect(f.port.request).toHaveBeenCalledOnce(); expect(handle.retirementBlocked).toBe(true);
    expect(f.port.acknowledgeOperation).not.toHaveBeenCalled();
  });
  it("does not hold a native permission behind an unmaterialized Steer or replay that Steer", async () => {
    const f = fixture();
    f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "Ongoing input" } },
      { index: 1, type: 15, status: 2, hasSubtrajectory: false, response: { text: "Streaming", thinking: "", stopReason: 0, toolCalls: [] } });
    const handle = await f.driver.attach(f.attached);
    const events: BackendConversationEvent[] = [];
    const projection = await handle.establishProjection({ signal: new AbortController().signal });
    const unsubscribe = projection.subscribeFromNext(event => events.push(event.event));
    vi.mocked(f.port.request).mockImplementation(async ({ operationId, command }) => {
      if (command.type === "steer") {
        f.receipts.set(operationId, { status: "pending" });
        setTimeout(() => f.emit({ kind: "permission", requestId: "permission", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
          toolCall: { toolCallId: "native-tool", title: "Run command" }, options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }] } }), 100);
        return { status: "pending" };
      }
      expect(command).toEqual({ type: "permission", requestId: "permission", response: { outcome: { outcome: "cancelled" } } });
      const outcome: AntigravityOutcome = { status: "completed", result: {} };
      f.receipts.set(operationId, outcome); return outcome;
    });
    // The acceptance wait ends when permission arrives, before its full window.
    const startedAt = Date.now();
    await expect(handle.steer({ ...submit, target: { kind: "conversation" } })).rejects.toMatchObject({
      category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false,
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "interaction_opened" }));
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(handle.respond({ applicationOperationId: "deny", interactionId: "permission", kind: "cancel" })).resolves.toBeUndefined();
    expect(handle.retirementBlocked).toBe(true);
    await expect(f.driver.reconcileSubmission({ ...f.attached, applicationOperationId: submit.applicationOperationId,
      reconciliationToken: submit.reconciliationToken, steerTarget: { kind: "conversation" } })).resolves.toMatchObject({ status: "unresolved" });
    expect(vi.mocked(f.port.request).mock.calls.filter(([request]) => request.command.type === "steer")).toHaveLength(1);
    expect(f.port.acknowledgeOperation).not.toHaveBeenCalledWith({ handleId: "handle", operationId: submit.applicationOperationId }, expect.anything());
    unsubscribe();
  }, 2000);
  it.each([false, true])("waits briefly for asynchronous exact Steer evidence (consumed: %s)", async consumed => {
    const f = fixture();
    f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "Ongoing input" } },
      { index: 1, type: 15, status: 2, hasSubtrajectory: false, response: { text: "Streaming", thinking: "", stopReason: 0, toolCalls: [] } });
    const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockImplementationOnce(async ({ command }) => {
      if (command.type !== "steer" || command.prompt[0]?.type !== "text") throw new Error("Expected steer");
      const text = command.prompt[0].text;
      setTimeout(() => {
        f.native.steps.push({ index: 2, type: 14, status: 3, hasSubtrajectory: false, user: { text }, executionId: "steered" });
        if (consumed) f.native.steps.push({ index: 3, type: 15, status: 2, hasSubtrajectory: false, executionId: "steered",
          response: { text: "Following the steer", thinking: "", stopReason: 0, toolCalls: [] } });
      }, 100);
      return { status: "pending" };
    });
    await expect(handle.steer({ ...submit, target: { kind: "conversation" } })).resolves.toMatchObject({
      status: consumed ? "accepted" : "pending_materialization", completionCorrelation: submit.applicationOperationId,
    });
    expect(f.port.request).toHaveBeenCalledOnce();
    expect(vi.mocked(f.port.readHistory).mock.calls.length).toBeLessThanOrEqual(6);
    expect(f.port.acknowledgeOperation).not.toHaveBeenCalled();
  });
  it.each([false, true])("prefers fresh exact Steer evidence over a pending permission mirror (consumed: %s)", async consumed => {
    const f = fixture();
    vi.mocked(f.port.attach).mockResolvedValue({ ...f.attachment, pendingPermissions: [{ requestId: "permission",
      openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
        toolCall: { toolCallId: "tool", title: "Pending permission" }, options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }] } }] });
    const handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockImplementationOnce(async ({ command }) => {
      if (command.type !== "steer" || command.prompt[0]?.type !== "text") throw new Error("Expected steer");
      f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, executionId: "steered", user: { text: command.prompt[0].text } });
      if (consumed) f.native.steps.push({ index: 1, type: 15, status: 2, hasSubtrajectory: false, executionId: "steered",
        response: { text: "Following the steer", thinking: "", stopReason: 0, toolCalls: [] } });
      return { status: "pending" };
    });
    await expect(handle.steer({ ...submit, target: { kind: "conversation" } })).resolves.toMatchObject({
      status: consumed ? "accepted" : "pending_materialization", completionCorrelation: submit.applicationOperationId,
    });
    expect(f.port.request).toHaveBeenCalledOnce();
    expect(f.port.acknowledgeOperation).not.toHaveBeenCalled();
  });
  it("ends the bounded Steer acceptance wait as unknown without replay when evidence never arrives", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockResolvedValueOnce({ status: "pending" });
    const startedAt = Date.now();
    await expect(handle.steer({ ...submit, target: { kind: "conversation" } })).rejects.toMatchObject({
      category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(f.port.request).toHaveBeenCalledOnce();
    expect(f.port.acknowledgeOperation).not.toHaveBeenCalled();
    expect(handle.retirementBlocked).toBe(true);
  }, 2500);
  it("keeps a dispatched control unknown when its outcome lookup fails", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockResolvedValueOnce({ status: "pending" });
    vi.mocked(f.port.outcome).mockRejectedValue(new AntigravityError("antigravity_sidecar_unavailable", "not_sent"));
    await expect(handle.perform({ applicationOperationId: "control", action: "set_model", provider: "connection", modelId: "other" }))
      .rejects.toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false });
    expect(f.port.request).toHaveBeenCalledOnce(); expect(handle.retirementBlocked).toBe(true);
  });
  it("preserves a completed control across failed acknowledgement and retries that acknowledgement", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    const configOptions = f.attachment.setup.session.configOptions!.map(option => option.category === "model" && option.type === "select" ? { ...option, currentValue: "other" } : option);
    vi.mocked(f.port.request).mockResolvedValueOnce({ status: "completed", result: { configOptions } });
    vi.mocked(f.port.acknowledgeOperation).mockRejectedValueOnce(new AntigravityError("antigravity_sidecar_unavailable", "sent_outcome_unknown"));
    await expect(handle.perform({ applicationOperationId: "control", action: "set_model", provider: "connection", modelId: "other" })).resolves.toEqual({ accepted: true });
    expect(handle.retirementBlocked).toBe(true);
    await vi.waitFor(() => expect(f.port.acknowledgeOperation).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(handle.retirementBlocked).toBe(false); expect(f.port.request).toHaveBeenCalledOnce();
  });
  it("never reapplies an old setter while acknowledgement or explicit reconciliation retries", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    const original = f.attachment.setup.session.configOptions!;
    const changed = original.map(option => option.category === "model" && option.type === "select" ? { ...option, currentValue: "other" } : option);
    vi.mocked(f.port.attachExisting).mockResolvedValue({ ...f.attachment, setup: { ...f.attachment.setup, session: { configOptions: changed } } });
    const action = { applicationOperationId: "old-setting", action: "set_model" as const, provider: "connection", modelId: "other" };
    vi.mocked(f.port.request).mockResolvedValue({ status: "completed", result: { configOptions: changed } });
    vi.mocked(f.port.acknowledgeOperation).mockRejectedValue(new AntigravityError("antigravity_sidecar_unavailable", "sent_outcome_unknown"));
    await expect(handle.perform(action)).resolves.toEqual({ accepted: true });
    f.emit({ kind: "update", notification: { sessionId: identity.sessionId, update: { sessionUpdate: "config_option_update", configOptions: original } } });
    await vi.waitFor(async () => expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("model"));
    const count = events.filter(event => event.type === "capabilities_changed").length; expect(count).toBe(2);
    for (let index = 0; index < 3; index++) await handle.establishProjection({ signal: new AbortController().signal });
    await expect(handle.reconcileAction(action)).resolves.toEqual({ outcome: "accepted" });
    await expect(handle.perform(action)).resolves.toEqual({ accepted: true });
    expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("model");
    expect(events.filter(event => event.type === "capabilities_changed")).toHaveLength(count);
  });
  it("applies a newer setter once while an older acknowledgement remains pending", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    vi.mocked(f.port.acknowledgeOperation).mockRejectedValue(new AntigravityError("antigravity_sidecar_unavailable", "sent_outcome_unknown"));
    let configOptions = f.attachment.setup.session.configOptions!;
    vi.mocked(f.port.attachExisting).mockImplementation(async () => ({ ...f.attachment, setup: { ...f.attachment.setup, session: { configOptions } } }));
    vi.mocked(f.port.request).mockImplementation(async input => {
      configOptions = configOptions.map(option => option.category === "model" && option.type === "select" && input.command.type === "set_config" ? { ...option, currentValue: input.command.value } : option);
      return { status: "completed", result: { configOptions } };
    });
    await handle.perform({ applicationOperationId: "first", action: "set_model", provider: "connection", modelId: "other" });
    await handle.perform({ applicationOperationId: "second", action: "set_model", provider: "connection", modelId: "model" });
    for (let index = 0; index < 3; index++) await handle.establishProjection({ signal: new AbortController().signal });
    expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("model");
    expect(events.filter(event => event.type === "capabilities_changed")).toHaveLength(2);
  });
  it("preserves a newer native observation when an older setter result arrives", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    handle.subscribe(event => events.push(event));
    vi.mocked(f.port.request).mockResolvedValue({ status: "pending" });
    const work = handle.perform({ applicationOperationId: "setting", action: "set_model", provider: "connection", modelId: "model" });
    await vi.waitFor(() => expect(f.port.outcome).toHaveBeenCalledOnce());
    const configOptions = f.attachment.setup.session.configOptions!.map(option => option.category === "model" && option.type === "select" ? { ...option, currentValue: "other" } : option);
    f.emit({ kind: "update", notification: { sessionId: identity.sessionId, update: { sessionUpdate: "config_option_update", configOptions } } });
    f.emit({ kind: "operation", operationId: "setting", outcome: { status: "completed", result: { configOptions: f.attachment.setup.session.configOptions } } });
    await expect(work).resolves.toEqual({ accepted: true });
    expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("other");
    expect(events.filter(event => event.type === "capabilities_changed")).toHaveLength(1);
  });
  it("keeps the current attach baseline when reconciling a previous controller's setter", async () => {
    const f = fixture(), original = f.attachment.setup.session.configOptions!;
    f.attachment.setup.session.configOptions = original.map(option => option.category === "model" && option.type === "select" ? { ...option, currentValue: "other" } : option);
    f.receipts.set("old-setting", { status: "completed", result: { configOptions: original } });
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    await expect(handle.reconcileAction({ applicationOperationId: "old-setting", action: "set_model", provider: "connection", modelId: "model" })).resolves.toEqual({ outcome: "accepted" });
    expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("other");
    expect(events.filter(event => event.type === "capabilities_changed")).toHaveLength(0); expect(f.port.request).not.toHaveBeenCalled();
  });
  it("emits no capability changes for repeated identical native configuration", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = []; handle.subscribe(event => events.push(event));
    for (let index = 0; index < 3; index++) f.emit({ kind: "update", notification: { sessionId: identity.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: f.attachment.setup.session.configOptions! } } });
    await vi.waitFor(() => expect(f.port.acknowledge).toHaveBeenCalledWith({ handleId: "handle", throughSequence: 3 }, expect.any(AbortSignal)));
    expect(events.filter(event => event.type === "capabilities_changed")).toHaveLength(0);
  });
  it("preserves a proved Stop when subsequent projection and acknowledgement are unavailable", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockImplementationOnce(async () => {
      vi.mocked(f.port.readHistory).mockRejectedValue(new Error("private native path"));
      const outcome: AntigravityOutcome = { status: "completed", result: { settledOperationIds: [], nativeRevision: f.native.revision } };
      f.receipts.set("stop", outcome); return outcome;
    });
    vi.mocked(f.port.acknowledgeOperation).mockRejectedValueOnce(new AntigravityError("antigravity_sidecar_unavailable", "sent_outcome_unknown"));
    await expect(handle.interrupt({ applicationOperationId: "stop", deadlineAt: Date.now() + 1000 })).resolves.toBeUndefined();
    expect(f.port.request).toHaveBeenCalledOnce();
    await expect(handle.reconcileInterrupt({ applicationOperationId: "stop", deadlineAt: Date.now() + 1000 })).resolves.toEqual({ outcome: "accepted" });
  });
  it("continues configuration after a confirmed setter despite acknowledgement loss", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached), send = vi.mocked(f.port.request).getMockImplementation()!;
    f.desired.modelId = "other";
    const configOptions = f.attachment.setup.session.configOptions!.map(option => option.category === "model" && option.type === "select" ? { ...option, currentValue: "other" } : option);
    vi.mocked(f.port.attachExisting).mockResolvedValue({ ...f.attachment, setup: { ...f.attachment.setup, session: { configOptions } } });
    vi.mocked(f.port.request).mockImplementation(async (input, signal) => input.command.type === "set_config" ? { status: "completed", result: { configOptions } } : send(input, signal));
    vi.mocked(f.port.acknowledgeOperation).mockRejectedValueOnce(new AntigravityError("antigravity_sidecar_unavailable", "sent_outcome_unknown"));
    await expect(handle.submit(submit)).resolves.toMatchObject({ accepted: true });
    expect(vi.mocked(f.port.request).mock.calls.map(([input]) => input.command.type)).toEqual(["set_config", "prompt"]);
  });
  it("does not send a prompt when its successful setter has not confirmed the requested value", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached); f.desired.modelId = "other";
    vi.mocked(f.port.request).mockResolvedValueOnce({ status: "completed", result: {} });
    await expect(handle.submit(submit)).rejects.toMatchObject({ category: "unavailable", crossedSubmissionBoundary: false });
    expect(vi.mocked(f.port.request).mock.calls.map(([input]) => input.command.type)).toEqual(["set_config"]);
  });
  it("confirms a setter from the retained host when an earlier configuration notification arrives during it", async () => {
    const f = fixture(), send = vi.mocked(f.port.request).getMockImplementation()!;
    f.desired.modelId = "other";
    f.attachment.setup.session.configOptions = f.attachment.setup.session.configOptions!.map(option => option.category === "thought_level" && option.type === "select"
      ? { ...option, currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] } : option);
    const handle = await f.driver.attach(f.attached);
    let throughSequence = 0;
    vi.mocked(f.port.attachExisting).mockImplementation(async () => structuredClone({ ...f.attachment, throughSequence }));
    vi.mocked(f.port.request).mockImplementation(async (input, signal) => {
      if (input.command.type !== "set_config") return send(input, signal);
      if (input.command.configId === "opaque-effort") {
        f.emit({ kind: "update", notification: { sessionId: identity.sessionId, update: { sessionUpdate: "config_option_update",
          configOptions: structuredClone(f.attachment.setup.session.configOptions!) } } });
        await vi.waitFor(() => expect(f.port.acknowledge).toHaveBeenCalledWith({ handleId: "handle", throughSequence: 1 }, expect.any(AbortSignal)));
        throughSequence = 1;
      }
      const command = input.command;
      f.attachment.setup.session.configOptions = f.attachment.setup.session.configOptions!.map(option => option.id === command.configId && option.type === "select" ? { ...option, currentValue: command.value } : option);
      return { status: "completed", result: { configOptions: structuredClone(f.attachment.setup.session.configOptions) } };
    });
    await expect(handle.submit(submit)).resolves.toMatchObject({ accepted: true });
    expect(vi.mocked(f.port.request).mock.calls.map(([input]) => input.command.type)).toEqual(["set_config", "set_config", "prompt"]);
  });
  it.each(["attach", "setter"] as const)("fences old configuration replay at the fresh %s snapshot and accepts later updates", async source => {
    const f = fixture(), original = f.attachment.setup.session.configOptions!;
    const configOptions = original.map(option => option.category === "model" && option.type === "select" ? { ...option, currentValue: "other" } : option);
    const retained = { ...f.attachment, throughSequence: 5, setup: { ...f.attachment.setup, session: { configOptions } } };
    if (source === "attach") vi.mocked(f.port.attach).mockResolvedValue(retained);
    const handle = await f.driver.attach(f.attached);
    if (source === "setter") {
      vi.mocked(f.port.attachExisting).mockResolvedValue(retained);
      vi.mocked(f.port.request).mockResolvedValue({ status: "completed", result: { configOptions } });
      await handle.perform({ applicationOperationId: "setter", action: "set_model", provider: "connection", modelId: "other" });
    }
    for (let index = 0; index < 5; index++) f.emit({ kind: "update", notification: { sessionId: identity.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: original } } });
    await vi.waitFor(() => expect(f.port.acknowledge).toHaveBeenCalledWith({ handleId: "handle", throughSequence: 5 }, expect.any(AbortSignal)));
    expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("other");
    f.emit({ kind: "update", notification: { sessionId: identity.sessionId, update: { sessionUpdate: "config_option_update", configOptions: original } } });
    await vi.waitFor(async () => expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("model"));
  });
  it("preserves a configuration event newer than the in-flight retained snapshot", async () => {
    const f = fixture(), observe = vi.mocked(f.port.observe).getMockImplementation()!;
    let releaseObservation!: () => void;
    const observation = new Promise<void>(resolve => { releaseObservation = resolve; });
    vi.mocked(f.port.observe).mockImplementationOnce(async (input, signal) => { await observation; return observe(input, signal); });
    const handle = await f.driver.attach(f.attached);
    let finish!: (snapshot: AntigravityAttachment) => void;
    vi.mocked(f.port.attachExisting).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(f.port.request).mockResolvedValue({ status: "completed", result: {} });
    const work = handle.perform({ applicationOperationId: "setter", action: "set_model", provider: "connection", modelId: "model" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const configOptions = f.attachment.setup.session.configOptions!.map(option => option.category === "model" && option.type === "select" ? { ...option, currentValue: "other" } : option);
    f.emit({ kind: "update", notification: { sessionId: identity.sessionId, update: { sessionUpdate: "config_option_update", configOptions } } });
    releaseObservation();
    try { await vi.waitFor(async () => expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("other")); }
    finally { finish({ ...f.attachment, throughSequence: 0 }); }
    await expect(work).resolves.toEqual({ accepted: true });
    expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("other");
  });
  it("retains a confirmed setter through snapshot failure and reconciles without resending it", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockResolvedValue({ status: "completed", result: {} });
    vi.mocked(f.port.attachExisting).mockRejectedValue(new Error("temporary retained read failure"));
    const action = { applicationOperationId: "setter", action: "set_model" as const, provider: "connection", modelId: "other" };
    await expect(handle.perform(action)).resolves.toEqual({ accepted: true });
    await expect(handle.reconcileAction(action)).resolves.toEqual({ outcome: "accepted" });
    expect(f.port.acknowledgeOperation).not.toHaveBeenCalled();
    expect(handle.retirementBlocked).toBe(true);
    f.desired.modelId = "other";
    await expect(handle.submit(submit)).rejects.toMatchObject({ category: "unavailable", crossedSubmissionBoundary: false });
    expect(f.port.request).toHaveBeenCalledOnce();
    const configOptions = f.attachment.setup.session.configOptions!.map(option => option.category === "model" && option.type === "select" ? { ...option, currentValue: "other" } : option);
    vi.mocked(f.port.attachExisting).mockResolvedValue({ ...f.attachment, setup: { ...f.attachment.setup, session: { configOptions } } });
    await expect(handle.reconcileAction(action)).resolves.toEqual({ outcome: "accepted" });
    expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("other");
    expect(f.port.request).toHaveBeenCalledOnce();
  });
  it("waits for fresh setter proof before another submit instead of replaying uncertain configuration", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached), send = vi.mocked(f.port.request).getMockImplementation()!;
    f.desired.modelId = "other";
    vi.mocked(f.port.request).mockResolvedValueOnce({ status: "failed", failure: { code: "antigravity_delivery_unknown", delivery: "sent_outcome_unknown" } });
    await expect(handle.submit(submit)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    await expect(handle.submit(submit)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(f.port.request).toHaveBeenCalledOnce();
    const operationId = vi.mocked(f.port.request).mock.calls[0]![0].operationId;
    const configOptions = f.attachment.setup.session.configOptions!.map(option => option.category === "model" && option.type === "select" ? { ...option, currentValue: "other" } : option);
    const outcome: AntigravityOutcome = { status: "completed", result: { configOptions } };
    vi.mocked(f.port.attachExisting).mockResolvedValue({ ...f.attachment, throughSequence: 1, setup: { ...f.attachment.setup, session: { configOptions } } });
    f.receipts.set(operationId, outcome); f.emit({ kind: "operation", operationId, outcome });
    await vi.waitFor(() => expect(handle.retirementBlocked).toBe(false));
    vi.mocked(f.port.request).mockImplementation(send);
    await expect(handle.submit(submit)).resolves.toMatchObject({ accepted: true });
    expect(vi.mocked(f.port.request).mock.calls.map(([input]) => input.command.type)).toEqual(["set_config", "prompt"]);
  });
  it("reconciles fresh retained control proof instead of a cached unknown result", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    const action = { applicationOperationId: "control", action: "set_model" as const, provider: "connection", modelId: "other" };
    vi.mocked(f.port.request).mockResolvedValueOnce({ status: "failed", failure: { code: "antigravity_delivery_unknown", delivery: "sent_outcome_unknown" } });
    await expect(handle.perform(action)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    f.receipts.set("control", { status: "completed", result: { configOptions: f.attachment.setup.session.configOptions } });
    await expect(handle.reconcileAction(action)).resolves.toEqual({ outcome: "accepted" });
    expect(f.port.request).toHaveBeenCalledOnce(); expect(handle.retirementBlocked).toBe(false);
  });
  it("never acknowledges a completed prompt callback without native consumption evidence", async () => {
    const f = fixture(), handle = await f.driver.attach(f.attached);
    vi.mocked(f.port.request).mockImplementationOnce(async () => {
      vi.mocked(f.port.readHistory).mockRejectedValueOnce(new Error("private native path")); return { status: "completed", result: { stopReason: "end_turn" } };
    });
    await expect(handle.submit(submit)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    await delay(30);
    expect(f.port.acknowledgeOperation).not.toHaveBeenCalled(); expect(f.port.request).toHaveBeenCalledOnce();
  });
  it("presents an early load decision, fences Send, then applies the full settings returned after the answer", async () => {
    const f = fixture(), pending = { requestId: "early", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
      toolCall: { toolCallId: "tool", title: "Review" }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" as const }] } };
    const partial = { ...f.attachment, loading: true as const, setup: { initialize: f.attachment.setup.initialize, session: {} }, pendingPermissions: [pending] };
    vi.mocked(f.port.attach).mockResolvedValue(partial);
    const handle = await f.driver.attach(f.attached);
    const events: BackendConversationEvent[] = [];
    const projection = await handle.establishProjection({ signal: new AbortController().signal });
    const stop = projection.subscribeFromNext(value => events.push(value.event));
    expect(projection.snapshot.runState).toBe("running");
    expect(events).toContainEqual(expect.objectContaining({ type: "interaction_opened", interaction: expect.objectContaining({ backendInteractionId: "early" }) }));
    expect((await handle.backendCapabilities()).actions).toEqual([]);
    await expect(handle.submit(submit)).rejects.toThrow();
    expect(f.port.request).not.toHaveBeenCalled();
    f.emit({ kind: "permission_resolved", requestId: "early" });
    await vi.waitFor(async () => expect((await handle.establishProjection({ signal: new AbortController().signal })).snapshot.runState).toBe("reconciling"));
    f.emit({ kind: "session_loaded", session: f.attachment.setup.session });
    await vi.waitFor(async () => expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("model"));
    expect((await handle.establishProjection({ signal: new AbortController().signal })).snapshot.runState).toBe("idle");
    stop(); await handle.close();
  });
  it("projects an already closed retained generation as disconnected before its first observation and withholds Stop control", async () => {
    const f = fixture(), onControlReady = vi.fn();
    vi.mocked(f.port.attach).mockResolvedValue({ ...f.attachment, closed: true });
    let deliverClosed!: () => void;
    const firstObservation = new Promise<void>(resolve => { deliverClosed = resolve; });
    vi.mocked(f.port.observe).mockImplementationOnce(async () => {
      await firstObservation;
      return { events: [], activePromptIds: [], retainedAfterSequence: 0, throughSequence: 0, closed: true };
    });
    try {
      const handle = await f.driver.attach({ ...f.attached, onControlReady });
      const initial = await handle.establishProjection({ signal: new AbortController().signal });
      expect(f.port.observe).toHaveBeenCalledOnce();
      expect(initial.snapshot.runState).toBe("disconnected");
      expect(onControlReady).not.toHaveBeenCalled();
      await expect(handle.captureSubmissionRetryAnchor()).rejects.toThrow();
      expect(f.port.request).not.toHaveBeenCalled();
    } finally { deliverClosed(); }
  });
  describe("bound load recovery without replay of the answer or load result", () => {
    const pending = { requestId: "early", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
      toolCall: { toolCallId: "tool", title: "Review" }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" as const }] } };
    async function openLoadingHandle() {
      const f = fixture(), signal = new AbortController().signal;
      vi.mocked(f.port.attach).mockResolvedValue({ ...f.attachment, loading: true,
        setup: { initialize: f.attachment.setup.initialize, session: {} }, pendingPermissions: [pending] });
      const handle = await f.driver.attach(f.attached);
      const initial = await handle.establishProjection({ signal });
      const events: BackendConversationEvent[] = [];
      initial.subscribeFromNext(({ event }) => events.push(event));
      expect(initial.snapshot.runState).toBe("running");
      expect((await handle.backendCapabilities()).actions).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ type: "interaction_opened", interaction: expect.objectContaining({ backendInteractionId: "early" }) }));
      return { f, handle, events, signal };
    }
    function finishWhileUnobserved(f: ReturnType<typeof fixture>, cause: "replay gap" | "disconnect", owner = f.attachment) {
      // The answer and session_loaded both fell out of replay. Only the retained
      // attachment can establish which permissions and settings are current.
      vi.mocked(f.port.attachExisting).mockResolvedValue({ ...owner, retainedAfterSequence: 2, throughSequence: 2 });
      if (cause === "disconnect") vi.mocked(f.port.observe).mockRejectedValueOnce(new AntigravityError("carrier_lost", "not_sent"));
      vi.mocked(f.port.observe).mockImplementation(async (_input, signal) => {
        await delay(10, undefined, { signal });
        return { events: [], retainedAfterSequence: 2, throughSequence: 2, activePromptIds: [], closed: false };
      });
    }
    it.each(["replay gap", "disconnect"] as const)("finishes the same retained load after a %s", async cause => {
      const { f, handle, events, signal } = await openLoadingHandle();
      finishWhileUnobserved(f, cause);
      await vi.waitFor(() => expect(events).toContainEqual({ type: "run_state_changed", state: "idle" }), { timeout: 3000 });
      expect(events).toContainEqual(cause === "replay gap"
        ? { type: "resnapshot_required", reason: "sequence_gap" }
        : { type: "run_state_changed", state: "disconnected" });
      expect(f.port.attachExisting).toHaveBeenCalledExactlyOnceWith(identity, expect.any(AbortSignal));
      expect(f.port.attach).toHaveBeenCalledOnce();
      expect(f.port.request).not.toHaveBeenCalled();
      expect(events.filter(event => event.type === "interaction_resolved")).toEqual([{ type: "interaction_resolved", backendInteractionId: pending.requestId }]);
      expect((await handle.backendCapabilities()).effectiveSettings.model?.id).toBe("model");
      const recovered = await handle.establishProjection({ signal }), replay: BackendConversationEvent[] = [];
      expect(recovered.snapshot.runState).toBe("idle");
      recovered.subscribeFromNext(({ event }) => replay.push(event))();
      expect(replay.filter(event => event.type === "interaction_opened")).toEqual([]);
      await expect(handle.captureSubmissionRetryAnchor()).resolves.toBe(f.native.revision);
    });
    it.each([
      { cause: "replay gap", mismatch: "handleId" },
      { cause: "disconnect", mismatch: "generation" },
    ] as const)("refuses retained load results from a different $mismatch after a $cause", async ({ cause, mismatch }) => {
      const { f, handle, events } = await openLoadingHandle();
      finishWhileUnobserved(f, cause, { ...f.attachment, [mismatch]: "replacement" });
      await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" }));
      expect(f.port.attachExisting).toHaveBeenCalledWith(identity, expect.any(AbortSignal));
      expect(events.some(event => event.type === "capabilities_changed" || event.type === "interaction_resolved")).toBe(false);
      await expect(handle.captureSubmissionRetryAnchor()).rejects.toThrow();
      expect(f.port.attach).toHaveBeenCalledOnce();
    });
  });
  it("restores pending permissions independently of replay and resolves them when Stop cancels the reverse request", async () => {
    const f = fixture();
    const pending = { requestId: "permission", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId, toolCall: { toolCallId: "native-tool", title: "Run command" },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" as const }, { optionId: "deny", name: "Deny", kind: "reject_once" as const }] } };
    vi.mocked(f.port.attach).mockResolvedValue({ ...f.attachment, pendingPermissions: [pending], retainedAfterSequence: 9, throughSequence: 9 });
    const handle = await f.driver.attach(f.attached);
    const events: BackendConversationEvent[] = [];
    const projection = await handle.establishProjection({ signal: new AbortController().signal });
    const stop = projection.subscribeFromNext(event => events.push(event.event));
    expect(events).toContainEqual(expect.objectContaining({ type: "interaction_opened", interaction: expect.objectContaining({ backendInteractionId: "permission" }) }));
    // The fixture has already acknowledged nine unrelated provider events.
    for (let index = 0; index < 10; index++) f.emit({ kind: "permission_resolved", requestId: "permission" });
    await vi.waitFor(() => expect(events).toContainEqual({ type: "interaction_resolved", backendInteractionId: "permission" }));
    expect(events.filter(event => event.type === "interaction_resolved")).toHaveLength(1);
    stop();
  });
  it("preserves the exact permission identity through projection replacement and retained reconnect", async () => {
    const f = fixture();
    const pending = { requestId: "permission", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
      toolCall: { toolCallId: "native-tool", title: "Run command" }, options: [{ optionId: "deny", name: "Deny", kind: "reject_once" as const }] } };
    const attachment = { ...f.attachment, pendingPermissions: [pending] };
    vi.mocked(f.port.attach).mockResolvedValue(attachment); vi.mocked(f.port.attachExisting).mockResolvedValue(attachment);
    const handle = await f.driver.attach(f.attached), events: BackendConversationEvent[] = [];
    const first = await handle.establishProjection({ signal: new AbortController().signal });
    const unsubscribeFirst = first.subscribeFromNext(event => events.push(event.event));
    const original = events.find(event => event.type === "interaction_opened");
    expect(original).toMatchObject({ interaction: { backendInteractionId: pending.requestId, openedAt: pending.openedAt } });
    const replacement = await handle.establishProjection({ signal: new AbortController().signal });
    const unsubscribeReplacement = replacement.subscribeFromNext(event => events.push(event.event));
    vi.mocked(f.port.observe).mockRejectedValueOnce(new AntigravityError("carrier_lost", "not_sent"));
    await vi.waitFor(() => expect(f.port.attachExisting).toHaveBeenCalled());
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "run_state_changed", state: "idle" })));
    expect(events).toContainEqual(expect.objectContaining({ type: "run_state_changed", state: "disconnected" }));
    expect(events.filter(event => event.type === "interaction_opened").length).toBeGreaterThan(2);
    for (const event of events.filter(event => event.type === "interaction_opened")) expect(event).toEqual(original);
    expect(events.some(event => event.type === "interaction_resolved")).toBe(false); expect(f.port.request).not.toHaveBeenCalled();
    unsubscribeFirst(); unsubscribeReplacement();
  });
  it.each([
    // Application composition refines running + permission into waiting_for_approval.
    { pending: true, terminal: false, closed: false, expected: "running" },
    { pending: false, terminal: false, closed: false, expected: "reconciling" },
    { pending: true, terminal: true, closed: false, expected: "idle" },
    { pending: true, terminal: false, closed: true, expected: "disconnected" },
  ] as const)("cold attach uses exact permission authority without inventing foreground progress: $expected", async ({ pending, terminal, closed, expected }) => {
    const f = fixture();
    f.native.steps.push({ index: 0, type: 14, status: 3, hasSubtrajectory: false, user: { text: "Existing native input" } },
      { index: 1, type: 15, status: terminal ? 3 : 2, hasSubtrajectory: false,
        response: { text: "Existing native response", thinking: "", stopReason: terminal ? 2 : 0, toolCalls: [] } });
    vi.mocked(f.port.attach).mockResolvedValue({ ...f.attachment, pendingPermissions: pending ? [{
      requestId: "permission", openedAt: "2026-11-22T00:00:00.000Z", request: { sessionId: identity.sessionId,
        toolCall: { toolCallId: "native-tool", title: "Run command" },
        options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }] },
    }] : [] });
    if (closed) vi.mocked(f.port.observe).mockResolvedValue({ events: [], throughSequence: 0, retainedAfterSequence: 0, activePromptIds: [], closed: true });
    const handle = await f.driver.attach(f.attached);
    await vi.waitFor(async () => {
      const projection = await handle.establishProjection({ signal: new AbortController().signal });
      expect(projection.snapshot.runState).toBe(expected);
      expect(projection.snapshot.turnsById["input:0"]?.status).toBe(terminal ? "completed" : "in_progress");
    });
    expect(f.port.request).not.toHaveBeenCalled();
  });
});

it.each(["same snapshot", "later snapshot"])("settles a quota failure once when the notice arrives in the %s", async timing => {
  const f = fixture();
  const base = { executionId: "execution", status: 3, hasSubtrajectory: false };
  f.native.steps.push(
    { ...base, index: 0, type: 14, user: { text: "Review" } },
    { ...base, index: 1, type: 132, tool: { name: "read_file", id: "call", argumentsJson: "{}" } },
  );
  const signal = new AbortController().signal;
  const handle = await f.driver.attach(f.attached);
  const binding = f.attached.binding;
  const projector = new ConversationProjector({ backendInstanceId: binding.backendInstanceId, bindingIdentity: binding.applicationThreadId });
  const initial = await handle.establishProjection({ signal });
  const [turnId] = projector.replace(initial.snapshot, initial.handleSequence).orderedTurnIds;
  const events: BackendConversationEvent[] = [];
  const updates: string[] = [];
  const unsubscribe = initial.subscribeFromNext(event => {
    events.push(event.event);
    updates.push(projector.apply(event).kind);
  });

  f.native.executions.push({ executionId: base.executionId, lastStepIndex: 1, terminationReason: 1, proceededWithAutoContinue: false });
  if (timing === "later snapshot") await handle.establishProjection({ signal });
  const error = "Individual quota reached.";
  f.native.steps.push({ index: 2, type: 17, status: 3, hasSubtrajectory: false, standaloneSystemDiagnostic: true, error });
  await handle.establishProjection({ signal });
  expect(updates).not.toContain("resnapshot_required");
  const completions = events.filter(event => event.type === "turn_completed");
  expect(completions).toHaveLength(1);
  if (timing === "same snapshot") expect(completions[0]!.turn.failure?.message.text).toBe(error);
  expect(projector.timeline().turnsById[turnId!]).toMatchObject({ status: "failed", failure: { message: { text: error } } });
  expect(projector.runState).toBe("idle");
  unsubscribe();

  await handle.close();
  const reattached = await f.driver.attach(f.attached);
  const replay: BackendConversationEvent[] = [];
  reattached.subscribe(event => replay.push(event));
  const { snapshot } = await reattached.establishProjection({ signal });
  expect(snapshot.runState).toBe("idle");
  expect(snapshot.turnsById["input:0"]).toMatchObject({ status: "failed", failure: { message: { text: error } } });
  expect(replay.filter(event => event.type === "turn_completed")).toHaveLength(0);
});
