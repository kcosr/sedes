import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AntigravityHost } from "../../src/server/backends/antigravity/host/native-host.js";
import { AntigravityAcpConnection } from "../../src/server/backends/antigravity/acp-connection.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import type { AntigravityEvent, AntigravityHistory, AntigravityRuntimeConfiguration } from "../../src/server/backends/antigravity/port.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { antigravityAttachmentSchema, antigravityCommandSchema, antigravityHistorySchema } from "../../src/server/backends/antigravity/sidecar/wire.js";
import { AcpDeliveryError, AcpRemoteError } from "../../src/server/provider-protocol/bindings/acp-v1/index.js";

const roots: string[] = [], hosts: AntigravityHost[] = [];
const realSetTimeout = globalThis.setTimeout;
afterEach(async () => { vi.restoreAllMocks(); for (const host of hosts.splice(0)) await host.close().catch(() => undefined); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(cancellationDrainTimeoutMs = 1000) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sedes-antigravity-host-test-"))); roots.push(cwd);
  const executablePath = path.join(cwd, "agy");
  await copyFile(fileURLToPath(new URL("../fixtures/antigravity/fake-antigravity-acp-peer.mjs", import.meta.url)), executablePath); await chmod(executablePath, 0o755);
  const configuration: AntigravityRuntimeConfiguration = { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "environment", executablePath, initializationTimeoutMs: 1000 };
  const channels = new LocalEnvironmentChannelProvider({ scope: { tenantId: configuration.tenantId, principalId: configuration.principalId }, executionEnvironmentId: configuration.executionEnvironmentId, environment: process.env });
  const readHistory = vi.fn(async (identity: { sessionId: string; cwd: string }): Promise<AntigravityHistory> => ({ ...identity, native: { steps: [], executions: [], revision: "a".repeat(64) } }));
  let emit: ((notification: SessionNotification) => void) | undefined;
  const host = new AntigravityHost({ configuration, channels, environment: process.env, readHistory, observationWaitMs: 5, cancellationPollIntervalMs: 5, cancellationDrainTimeoutMs,
    launch: async input => { emit = input.update; return AntigravityAcpConnection.open(input); } }); hosts.push(host);
  return { cwd, host, configuration, channels, readHistory, emit: (notification: SessionNotification) => emit!(notification) };
}
async function settled(host: AntigravityHost, handleId: string, operationId: string) {
  await vi.waitFor(async () => expect((await host.outcome({ handleId, operationId })).status).not.toBe("pending"));
  return host.outcome({ handleId, operationId });
}
async function drain(host: AntigravityHost, handleId: string): Promise<AntigravityEvent[]> {
  const observed = await host.observe({ handleId, afterSequence: 0 });
  await host.acknowledge({ handleId, throughSequence: observed.throughSequence }); return [...observed.events];
}
describe("Antigravity execution host", () => {
  it("retains accepted work across detach and restores the exact handle without replay", async () => {
    const { host, cwd } = await fixture();
    const identity = await host.create({ cwd, operationId: "creation" });
    expect(await host.create({ cwd, operationId: "creation" })).toEqual(identity);
    const attachment = await host.attach(identity);
    const request = { handleId: attachment.handleId, operationId: "send", command: { type: "prompt" as const, prompt: [{ type: "text" as const, text: "hello" }] } };
    await host.request(request); host.detach();
    const outcome = await settled(host, attachment.handleId, "send");
    expect(outcome).toMatchObject({ status: "completed", result: { stopReason: "end_turn" } });
    expect(await host.request(request)).toEqual(outcome);
    expect(await host.attachExisting(identity)).toMatchObject({ handleId: attachment.handleId, generation: attachment.generation });
    const events = await drain(host, attachment.handleId);
    expect(events.filter(event => event.kind === "operation")).toHaveLength(1);
    await expect(host.request({ ...request, command: { type: "prompt", prompt: [{ type: "text", text: "different" }] } })).rejects.toMatchObject({ code: "antigravity_operation_conflict" });
  });
  it("keeps background command work active after the foreground prompt response", async () => {
    const { host, cwd } = await fixture(); const identity = await host.create({ cwd, operationId: "creation" }); const { handleId } = await host.attach(identity);
    await host.request({ handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "background" }] } });
    await settled(host, handleId, "send");
    expect(host.snapshot().blockers).toContain("active_work");
    await expect(host.retireSession(identity)).resolves.toBe("busy");
    await expect(host.stop({ expectedRevision: host.snapshot().revision, force: false })).rejects.toMatchObject({ code: "antigravity_runtime_busy" });
    await vi.waitFor(() => expect(host.snapshot().blockers).not.toContain("active_work"));
    expect(host.snapshot().blockers).toContain("unsettled_outcome");
    expect(await host.retireSession(identity)).toBe("undelivered");
    await host.acknowledgeOperation({ handleId, operationId: "send" }); await drain(host, handleId);
    expect(await host.retireSession(identity)).toBe("retired");
  });
  it("does not retire ACP tool work from a native response that still calls tools", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" });
    const { handleId } = await f.host.attach(identity);
    const native: AntigravityHistory["native"] = { revision: "b".repeat(64), executions: [], steps: [{
      index: 0, type: 15, status: 3, hasSubtrajectory: false,
      response: { text: "", thinking: "", stopReason: 2, toolCalls: [{ id: "background", name: "run_command", argumentsJson: "{}" }] },
    }] };
    vi.spyOn(AntigravityAcpConnection.prototype, "prompt").mockImplementationOnce(async (_id, _prompt, settle) => {
      f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "background", kind: "execute", title: "Command", status: "in_progress" } });
      f.readHistory.mockResolvedValue({ ...identity, native });
      const result = { stopReason: "end_turn" as const }; settle(result); return result;
    });
    await f.host.request({ handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } });
    await settled(f.host, handleId, "send"); await f.host.readHistory(identity);
    expect(f.host.snapshot().blockers).toContain("active_work");
    expect(await f.host.retireSession(identity)).toBe("busy");
    native.steps.push({ index: 1, type: 15, status: 3, hasSubtrajectory: false,
      response: { text: "Finished", thinking: "", stopReason: 2, toolCalls: [] } });
    native.revision = "c".repeat(64); await f.host.readHistory(identity);
    expect(f.host.snapshot().blockers).not.toContain("active_work");
    await f.host.acknowledgeOperation({ handleId, operationId: "send" }); await drain(f.host, handleId);
    expect(await f.host.retireSession(identity)).toBe("retired");
  });
  it("keeps Stop serviceable during a long running prompt and retains the exact terminal", async () => {
    const { host, cwd } = await fixture(); const identity = await host.create({ cwd, operationId: "creation" }); const { handleId } = await host.attach(identity);
    expect(await host.request({ handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "wait" }] } })).toEqual({ status: "pending" });
    await expect(host.request({ handleId, operationId: "second", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } })).rejects.toMatchObject({ code: "antigravity_session_busy" });
    await host.request({ handleId, operationId: "stop", command: { type: "cancel" } });
    expect(await settled(host, handleId, "send")).toMatchObject({ status: "completed", result: { stopReason: "cancelled" } });
  });
  it("preserves permissions on detach and denies allow decisions through retained-only authority", async () => {
    const { host, cwd } = await fixture(); const identity = await host.create({ cwd, operationId: "creation" }); const { handleId } = await host.attach(identity);
    await host.request({ handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "permission" }] } });
    await vi.waitFor(() => expect(host.snapshot().blockers).toContain("pending_interaction")); host.detach();
    const observation = await host.observe({ handleId, afterSequence: 0 }); const event = observation.events.find(event => event.kind === "permission");
    if (!event || event.kind !== "permission") throw new Error("Missing permission");
    const authority = { assertCurrent() {}, assertAdmission() { throw new Error("denied"); } };
    await expect(host.request({ handleId, operationId: "allow", command: { type: "permission", requestId: event.requestId, response: { outcome: { outcome: "selected", optionId: "allow" } } } }, undefined, authority)).rejects.toThrow("denied");
    await host.request({ handleId, operationId: "deny", command: { type: "permission", requestId: event.requestId, response: { outcome: { outcome: "selected", optionId: "reject" } } } }, undefined, authority);
    expect(await settled(host, handleId, "send")).toMatchObject({ status: "completed" });
  });
  it("uses passive native history without opening a provider process and rejects wrong scope", async () => {
    const { host, cwd, readHistory, channels, configuration } = await fixture(); const identity = { sessionId: "native-session", cwd };
    expect(await host.readHistory(identity)).toMatchObject({ native: { steps: [] } }); expect(readHistory).toHaveBeenCalledOnce();
    expect(host.runtimeVersion).toBeNull();
    expect(() => new AntigravityHost({ configuration: { ...configuration, principalId: "wrong" }, channels, environment: {}, readHistory })).toThrow("antigravity_runtime_scope_denied");
  });
  it("validates exact prompt and native-history wire schemas", () => {
    expect(antigravityCommandSchema.parse({ type: "prompt", prompt: [{ type: "text", text: "hello" }] })).toEqual({ type: "prompt", prompt: [{ type: "text", text: "hello" }] });
    expect(antigravityCommandSchema.safeParse({ type: "prompt", prompt: [{ type: "bogus", text: "hello" }] }).success).toBe(false);
    expect(antigravityHistorySchema.safeParse({ sessionId: "native", cwd: "/workspace", native: { steps: [], executions: [], revision: "a".repeat(64) } }).success).toBe(true);
  });
  it("keeps confirmation revision stable across tokens and checks the captured revision before refreshing native state", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    await f.host.request({ handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "wait" }] } });
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } } });
    const before = f.host.snapshot();
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second" } } });
    expect(f.host.snapshot().revision).toBe(before.revision);
    f.readHistory.mockResolvedValue({ ...identity, native: { steps: [], executions: [], revision: "b".repeat(64) } });
    await expect(f.host.stop({ expectedRevision: before.revision, force: true })).resolves.toBeUndefined();
    expect(f.host.snapshot().retainedSessions).toHaveLength(0);
  });
  it("drains a create crossing forced Stop and cannot register a late owned session", async () => {
    const f = await fixture(); const create = AntigravityAcpConnection.prototype.create;
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    vi.spyOn(AntigravityAcpConnection.prototype, "create").mockImplementationOnce(async function (this: AntigravityAcpConnection, ...args) { entered = true; await hold; return create.apply(this, args); });
    const creating = f.host.create({ cwd: f.cwd, operationId: "creation" }); const rejected = expect(creating).rejects.toMatchObject({ code: "antigravity_create_unavailable", delivery: "sent_outcome_unknown" });
    await vi.waitFor(() => expect(entered).toBe(true)); expect(f.host.snapshot().blockers).toContain("active_work");
    const stopping = f.host.stop({ expectedRevision: f.host.snapshot().revision, force: true }); release(); await stopping; await rejected;
    expect(f.host.snapshot().retainedSessions).toHaveLength(0); expect(f.host.runtimeVersion).toBeNull();
  });
  it("retains acknowledged operation outcomes and exact creation origins without replay", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const attached = await f.host.attach(identity);
    expect(attached.createdByOperationId).toBe("creation"); await f.host.acknowledgeCreation({ ...identity, operationId: attached.createdByOperationId! });
    expect(await f.host.create({ cwd: f.cwd, operationId: "creation" })).toEqual(identity);
    const command = { handleId: attached.handleId, operationId: "send", command: { type: "prompt" as const, prompt: [{ type: "text" as const, text: "hello" }] } };
    await f.host.request(command); const outcome = await settled(f.host, attached.handleId, "send");
    await f.host.acknowledgeOperation({ handleId: attached.handleId, operationId: "send" });
    expect(await f.host.outcome({ handleId: attached.handleId, operationId: "send" })).toEqual(outcome);
    expect(await f.host.request(command)).toEqual(outcome);
  });
  it("cancels every pending reverse permission request and restores it after observed-event acknowledgement", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    await f.host.request({ handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "permission" }] } });
    await vi.waitFor(() => expect(f.host.snapshot().blockers).toContain("pending_interaction"));
    const observed = await f.host.observe({ handleId, afterSequence: 0 }); await f.host.acknowledge({ handleId, throughSequence: observed.throughSequence });
    const event = observed.events.find(event => event.kind === "permission");
    if (!event || event.kind !== "permission") throw new Error("Missing permission");
    expect(new Date(event.openedAt).toISOString()).toBe(event.openedAt);
    expect((await f.host.attachExisting(identity))?.pendingPermissions).toEqual([{ requestId: event.requestId, openedAt: event.openedAt, request: event.request }]);
    await f.host.release({ handleId });
    expect((await f.host.attachExisting(identity))?.pendingPermissions).toEqual([{ requestId: event.requestId, openedAt: event.openedAt, request: event.request }]);
    await f.host.request({ handleId, operationId: "cancel", command: { type: "cancel" } }); await settled(f.host, handleId, "send");
    expect((await f.host.attachExisting(identity))?.pendingPermissions).toHaveLength(0);
    expect(f.host.snapshot().blockers).not.toContain("pending_interaction");
  });
  it("keeps the actual ACP permission wire alive through a human decision after thirty seconds", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    const waitForIo = async (predicate: () => Promise<boolean> | boolean) => {
      for (let index = 0; index < 200; index++) {
        if (await predicate()) return;
        await new Promise(resolve => realSetTimeout(resolve, 5));
      }
      throw new Error("antigravity_permission_wire_wait_failed");
    };
    // Install the virtual timeout clock before the peer's reverse request so
    // omitting Antigravity's registration opt-in would fire the real30s policy.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await f.host.request({ handleId, operationId: "send", command: { type: "prompt", prompt: [{ type: "text", text: "permission" }] } });
      await waitForIo(() => f.host.snapshot().blockers.includes("pending_interaction"));
      await vi.advanceTimersByTimeAsync(31_000);
      expect(f.host.snapshot().retainedSessions[0]?.closed).toBe(false);
      expect((await f.host.attachExisting(identity))?.pendingPermissions).toHaveLength(1);
      const observed = await f.host.observe({ handleId, afterSequence: 0 }), permission = observed.events.find(event => event.kind === "permission");
      if (!permission || permission.kind !== "permission") throw new Error("Missing permission");
      await f.host.request({ handleId, operationId: "answer", command: { type: "permission", requestId: permission.requestId,
        response: { outcome: { outcome: "selected", optionId: "reject" } } } });
      await waitForIo(async () => (await f.host.outcome({ handleId, operationId: "send" })).status !== "pending");
      expect(await f.host.outcome({ handleId, operationId: "send" })).toMatchObject({ status: "completed", result: { stopReason: "end_turn" } });
      expect(f.host.snapshot().retainedSessions[0]?.closed).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("admits conversation steering through concurrent native prompts without an exclusive response cutover", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    await f.host.request({ handleId, operationId: "first", command: { type: "prompt", prompt: [{ type: "text", text: "wait" }] } });
    await f.host.request({ handleId, operationId: "steer", command: { type: "steer", prompt: [{ type: "text", text: "hello" }] } });
    expect(await settled(f.host, handleId, "steer")).toMatchObject({ status: "completed", result: { stopReason: "end_turn" } });
    expect(await f.host.outcome({ handleId, operationId: "first" })).toEqual({ status: "pending" });
    expect(f.host.snapshot().blockers).toContain("active_work");
    await f.host.request({ handleId, operationId: "cancel", command: { type: "cancel" } });
    expect(await settled(f.host, handleId, "first")).toMatchObject({ status: "completed", result: { stopReason: "cancelled" } });
    await settled(f.host, handleId, "cancel");
    await expect(f.host.request({ handleId, operationId: "late", command: { type: "steer", prompt: [{ type: "text", text: "late" }] } })).rejects.toMatchObject({ code: "antigravity_steering_target_unavailable" });
  });
  it("fences admission while Stop drains every captured steer and retains each exact cancellation outcome", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    const replies: (() => void)[] = [];
    const prompt = vi.spyOn(AntigravityAcpConnection.prototype, "prompt").mockImplementation(async (_session, _prompt, settle) => new Promise(resolve => {
      replies.push(() => { const result = { stopReason: "cancelled" as const }; settle(result); resolve(result); });
    }));
    const cancel = vi.spyOn(AntigravityAcpConnection.prototype, "cancel").mockImplementation(async () => { replies.shift()?.(); });
    const operations = ["primary", "steer1", "steer2"];
    for (const operationId of operations) await f.host.request({ handleId, operationId, command: { type: operationId === "primary" ? "prompt" : "steer", prompt: [{ type: "text", text: operationId }] } });
    await f.host.request({ handleId, operationId: "stop", command: { type: "cancel" } });
    expect(await f.host.outcome({ handleId, operationId: "primary" })).toMatchObject({ status: "completed", result: { stopReason: "cancelled" } });
    expect(await f.host.outcome({ handleId, operationId: "primary" })).not.toHaveProperty("cancelledAtNativeRevision");
    await expect(f.host.request({ handleId, operationId: "adjacent", command: { type: "prompt", prompt: [{ type: "text", text: "later" }] } })).rejects.toMatchObject({ code: "antigravity_cancel_in_progress" });
    expect(await settled(f.host, handleId, "stop")).toMatchObject({ status: "completed", result: { settledOperationIds: operations } });
    expect(cancel.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const operationId of operations) {
      expect(await f.host.outcome({ handleId, operationId })).toMatchObject({ status: "completed", result: { stopReason: "cancelled" }, cancelledAtNativeRevision: "a".repeat(64) });
      await f.host.acknowledgeOperation({ handleId, operationId });
      expect(await f.host.outcome({ handleId, operationId })).toMatchObject({ status: "completed", result: { stopReason: "cancelled" }, cancelledAtNativeRevision: "a".repeat(64) });
    }
    expect(prompt).toHaveBeenCalledTimes(3);
  });
  it("distinguishes child uncertainty from an unreadable foreground native store", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    f.readHistory.mockRejectedValueOnce(new Error("store unavailable"));
    await expect(f.host.request({ handleId, operationId: "unavailable", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } })).rejects.toMatchObject({ code: "antigravity_native_state_unavailable" });
    await f.host.request({ handleId, operationId: "recovered", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } });
    expect(await settled(f.host, handleId, "recovered")).toMatchObject({ status: "completed" });
    f.readHistory.mockResolvedValue({ ...identity, native: { revision: "b".repeat(64), executions: [], steps: [{ index: 0, type: 132, status: 3, hasSubtrajectory: false,
      subagents: [{ sessionId: "8a54e222-1000-4000-8000-000000000002", state: "unknown" }] }] } });
    await f.host.request({ handleId, operationId: "child-uncertain", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } });
    expect(await settled(f.host, handleId, "child-uncertain")).toMatchObject({ status: "completed" });
    expect(await f.host.retireSession(identity)).toBe("busy");
  });
  it("refreshes native blockers under an admission fence after validating a nonforced Stop revision", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" });
    await f.host.acknowledgeCreation({ ...identity, operationId: "creation" });
    const before = f.host.snapshot(); expect(before.blockers).toEqual([]);
    f.readHistory.mockResolvedValue({ ...identity, native: { revision: "b".repeat(64), executions: [], steps: [{ index: 0, type: 132, status: 2, hasSubtrajectory: false,
      task: { id: "background", title: "command", description: "", daemon: false }, command: { command: "sleep", cwd: f.cwd, commandId: "background", output: "", persistent: false } }] } });
    f.readHistory.mockClear();
    await expect(f.host.stop({ expectedRevision: "stale", force: false })).rejects.toMatchObject({ code: "antigravity_runtime_revision_changed" });
    expect(f.readHistory).not.toHaveBeenCalled();
    await expect(f.host.stop({ expectedRevision: before.revision, force: false })).rejects.toMatchObject({ code: "antigravity_runtime_busy" });
    expect(f.readHistory).toHaveBeenCalledOnce(); expect(f.host.snapshot().blockers).toContain("active_work");
    expect(await f.host.attachExisting(identity)).not.toBeNull();
  });
  it("never replays unidentified crossed creation and clears uncertainty only through proven forced retirement", async () => {
    const f = await fixture(), create = vi.spyOn(AntigravityAcpConnection.prototype, "create").mockRejectedValueOnce(new Error("reply_lost_after_dispatch"));
    const input = { cwd: f.cwd, operationId: "uncertain" };
    await expect(f.host.create(input)).rejects.toMatchObject({ code: "antigravity_create_unavailable", delivery: "sent_outcome_unknown" });
    await expect(f.host.create(input)).rejects.toMatchObject({ code: "antigravity_create_unavailable", delivery: "sent_outcome_unknown" });
    expect(create).toHaveBeenCalledOnce(); expect(f.host.snapshot().blockers).toContain("unsettled_outcome");
    await expect(f.host.acknowledgeCreation({ ...input, sessionId: "unverified" })).rejects.toMatchObject({ code: "antigravity_creation_identity_mismatch" });
    await expect(f.host.stop({ expectedRevision: f.host.snapshot().revision, force: false })).rejects.toMatchObject({ code: "antigravity_runtime_busy" });
    await f.host.stop({ expectedRevision: f.host.snapshot().revision, force: true });
    expect(f.host.snapshot().blockers).toEqual([]);
    await expect(f.host.create(input)).rejects.toMatchObject({ code: "antigravity_runtime_closed", delivery: "not_sent" });
  });
  it("bounds acknowledged identities without replay and reserves capacity for Stop", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    const configure = vi.spyOn(AntigravityAcpConnection.prototype, "setConfig").mockResolvedValue({ configOptions: [] });
    const input = (index: number) => ({ handleId, operationId: `setting:${index}`, command: { type: "set_config" as const, configId: "model", value: "fixture" } });
    for (let index = 0; index < 4096; index++) { await f.host.request(input(index)); await f.host.acknowledgeOperation({ handleId, operationId: input(index).operationId }); }
    await expect(f.host.request(input(4096))).rejects.toMatchObject({ code: "antigravity_operation_receipt_capacity", delivery: "not_sent" });
    expect(await f.host.request(input(0))).toMatchObject({ status: "completed" }); expect(configure).toHaveBeenCalledTimes(4096);
    await f.host.request({ handleId, operationId: "cleanup", command: { type: "cancel" } });
    expect(await settled(f.host, handleId, "cleanup")).toMatchObject({ status: "completed" });
    await f.host.acknowledgeOperation({ handleId, operationId: "cleanup" });
    expect(await f.host.request(input(0))).toMatchObject({ status: "completed" }); expect(configure).toHaveBeenCalledTimes(4096);
  });
  it("recovers an uncertain Stop from later native quiescence and retains the exact refreshed receipts", async () => {
    const f = await fixture(20), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    await f.host.request({ handleId, operationId: "primary", command: { type: "prompt", prompt: [{ type: "text", text: "wait" }] } });
    f.readHistory.mockResolvedValue({ ...identity, native: { revision: "a".repeat(64), executions: [], steps: [{ index: 1, type: 132, status: 2, hasSubtrajectory: false,
      command: { command: "sleep", cwd: f.cwd, commandId: "background", output: "", persistent: false } }] } });
    await f.host.request({ handleId, operationId: "stop", command: { type: "cancel" } });
    expect(await settled(f.host, handleId, "stop")).toMatchObject({ status: "failed", failure: { code: "antigravity_cancel_unproven" } });
    await expect(f.host.request({ handleId, operationId: "before-proof", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } })).rejects.toMatchObject({ code: "antigravity_cancel_in_progress" });
    const terminal: AntigravityHistory = { ...identity, native: { revision: "b".repeat(64), executions: [], steps: [{ index: 1, type: 15, status: 6, hasSubtrajectory: false,
      response: { text: "", thinking: "", stopReason: 16, toolCalls: [] } }] } };
    f.readHistory.mockResolvedValue(terminal); await f.host.readHistory(identity);
    expect(await f.host.outcome({ handleId, operationId: "stop" })).toMatchObject({ status: "completed", result: { settledOperationIds: ["primary"], nativeRevision: "b".repeat(64) } });
    expect(await f.host.outcome({ handleId, operationId: "primary" })).toMatchObject({ cancelledAtNativeRevision: "b".repeat(64) });
    expect(f.host.snapshot().blockers).not.toContain("unknown_state");
    await f.host.acknowledgeOperation({ handleId, operationId: "stop" });
    expect(await f.host.outcome({ handleId, operationId: "stop" })).toMatchObject({ status: "completed" });
    await f.host.request({ handleId, operationId: "after-proof", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } });
    expect(await settled(f.host, handleId, "after-proof")).toMatchObject({ status: "completed" });
  });
  it("requires a native read started after captured prompt settlement before clearing failed Stop", async () => {
    const f = await fixture(20), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    let reply!: () => void;
    vi.spyOn(AntigravityAcpConnection.prototype, "prompt").mockImplementation(async (_id, _prompt, settle) => new Promise(resolve => {
      reply = () => { const result = { stopReason: "cancelled" as const }; settle(result); resolve(result); };
    }));
    vi.spyOn(AntigravityAcpConnection.prototype, "cancel").mockResolvedValue(undefined);
    await f.host.request({ handleId, operationId: "primary", command: { type: "prompt", prompt: [{ type: "text", text: "wait" }] } });
    await f.host.request({ handleId, operationId: "stop", command: { type: "cancel" } });
    expect(await settled(f.host, handleId, "stop")).toMatchObject({ status: "failed" });
    let oldRead!: (value: AntigravityHistory) => void, freshRead!: (value: AntigravityHistory) => void;
    f.readHistory.mockImplementationOnce(async () => new Promise(resolve => { oldRead = resolve; }))
      .mockImplementationOnce(async () => new Promise(resolve => { freshRead = resolve; }));
    const reading = f.host.readHistory(identity); reply();
    const terminal = { ...identity, native: { revision: "b".repeat(64), executions: [], steps: [] } };
    oldRead(terminal); await reading;
    expect(await f.host.outcome({ handleId, operationId: "stop" })).toMatchObject({ status: "failed" });
    expect(await f.host.outcome({ handleId, operationId: "primary" })).not.toHaveProperty("cancelledAtNativeRevision");
    freshRead(terminal);
    await vi.waitFor(async () => expect(await f.host.outcome({ handleId, operationId: "stop" })).toMatchObject({ status: "completed" }));
  });
  it("settles an uncertain config setter only after a fresh exact native postcondition", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }), attachment = await f.host.attach(identity), { handleId } = attachment;
    vi.spyOn(AntigravityAcpConnection.prototype, "setConfig").mockRejectedValueOnce(new AcpDeliveryError("acp_binding_request_deadline", "sent_outcome_unknown"));
    const command = { type: "set_config" as const, configId: "model", value: "fixture-model" };
    await f.host.request({ handleId, operationId: "setting", command });
    expect(await settled(f.host, handleId, "setting")).toMatchObject({ status: "failed", failure: { delivery: "sent_outcome_unknown" } });
    // A cached value equal to the postcondition is not a new observation.
    await f.host.readHistory(identity); expect(await f.host.outcome({ handleId, operationId: "setting" })).toMatchObject({ status: "failed" });
    const options = attachment.setup.session.configOptions!;
    const publish = (value: string) => f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "config_option_update",
      configOptions: options.map(option => option.id === "model" && option.type === "select" ? { ...option, currentValue: value } : option) } });
    publish("fixture-alt"); expect(await f.host.outcome({ handleId, operationId: "setting" })).toMatchObject({ status: "failed" });
    publish("fixture-model"); expect(await f.host.outcome({ handleId, operationId: "setting" })).toMatchObject({ status: "completed" });
    await f.host.acknowledgeOperation({ handleId, operationId: "setting" });
    expect(await f.host.request({ handleId, operationId: "setting", command })).toMatchObject({ status: "completed" });
    expect((await f.host.attachExisting(identity))?.setup.session.configOptions).toEqual(options);
  });
  it("recovers cleanup receipts beyond the ordinary unacknowledged operation capacity", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }), { handleId } = await f.host.attach(identity);
    vi.spyOn(AntigravityAcpConnection.prototype, "setConfig").mockResolvedValue({ configOptions: [] });
    for (let index = 0; index < 512; index++) await f.host.request({ handleId, operationId: `setting:${index}`, command: { type: "set_config", configId: "model", value: "fixture" } });
    await expect(f.host.request({ handleId, operationId: "overflow", command: { type: "set_config", configId: "model", value: "fixture" } })).rejects.toMatchObject({ code: "antigravity_operation_capacity" });
    await f.host.request({ handleId, operationId: "stop", command: { type: "cancel" } }); await settled(f.host, handleId, "stop");
    const attachment = await f.host.attachExisting(identity);
    expect(attachment?.retainedOperationIds).toHaveLength(513); expect(antigravityAttachmentSchema.safeParse(attachment).success).toBe(true);
  });
  it("uses exact native mode observations and preserves definite setter rejection", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }), { handleId } = await f.host.attach(identity);
    vi.spyOn(AntigravityAcpConnection.prototype, "setMode").mockRejectedValueOnce(new AcpDeliveryError("acp_binding_request_deadline", "sent_outcome_unknown"));
    await f.host.request({ handleId, operationId: "mode", command: { type: "set_mode", modeId: "plan" } });
    expect(await settled(f.host, handleId, "mode")).toMatchObject({ status: "failed" });
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "default" } });
    expect(await f.host.outcome({ handleId, operationId: "mode" })).toMatchObject({ status: "failed" });
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } });
    expect(await f.host.outcome({ handleId, operationId: "mode" })).toMatchObject({ status: "completed" });
    expect((await f.host.attachExisting(identity))?.setup.session.modes?.currentModeId).toBe("plan");
    vi.spyOn(AntigravityAcpConnection.prototype, "setConfig").mockRejectedValueOnce(new AcpRemoteError(-32602));
    await f.host.request({ handleId, operationId: "rejected", command: { type: "set_config", configId: "model", value: "fixture-model" } });
    expect(await settled(f.host, handleId, "rejected")).toMatchObject({ status: "failed", failure: { delivery: "rejected" } });
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "config_option_update", configOptions: (await f.host.attachExisting(identity))!.setup.session.configOptions! } });
    expect(await f.host.outcome({ handleId, operationId: "rejected" })).toMatchObject({ status: "failed", failure: { delivery: "rejected" } });
  });
});
