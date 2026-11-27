import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, copyFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AntigravityHost } from "../../src/server/backends/antigravity/host/native-host.js";
import { AntigravityAcpConnection } from "../../src/server/backends/antigravity/acp-connection.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import type { AntigravityEvent, AntigravityHistory, AntigravityRuntimeConfiguration } from "../../src/server/backends/antigravity/port.js";
import type { SessionNotification, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { antigravityAttachmentSchema, antigravityCommandSchema, antigravityHistorySchema } from "../../src/server/backends/antigravity/sidecar/wire.js";
import { AcpDeliveryError, AcpRemoteError } from "../../src/server/provider-protocol/bindings/acp-v1/index.js";
import * as nativeActivity from "../../src/server/backends/antigravity/host/native-activity.js";
import { buildAntigravityPrompt } from "../../src/server/backends/antigravity/submission.js";
import { projectAntigravityHistory } from "../../src/server/backends/antigravity/history.js";

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
  const history = { read: readHistory, forget: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  const removeProbe = vi.fn(async (_identity: { sessionId: string; cwd: string }) => undefined);
  let emit: ((notification: SessionNotification) => void) | undefined;
  let permission: ((request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>) | undefined;
  const host = new AntigravityHost({ configuration, channels, environment: process.env, history, removeProbe, observationWaitMs: 5, cancellationPollIntervalMs: 5, cancellationDrainTimeoutMs,
    launch: async input => { emit = input.update; permission = input.permission; return AntigravityAcpConnection.open(input); } }); hosts.push(host);
  return { cwd, host, configuration, channels, readHistory, history, removeProbe, emit: (notification: SessionNotification) => emit!(notification),
    permission: (request: RequestPermissionRequest) => permission!(request, new AbortController().signal) };
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
  function replayInput(cwd: string, behavior: string) {
    return { sessionId: "4c8ece79-6741-451f-8aa5-e01d576ed055", cwd,
      executionEnvironment: { AGY_FIXTURE_LOAD_PERMISSION: { kind: "literal" as const, value: behavior } } };
  }
  it("attaches to the exact replayed approval while load waits for an answer, then publishes its settings", async () => {
    const f = await fixture(), input = replayInput(f.cwd, "wait");
    const [a, concurrent] = await Promise.all([f.host.attach(input), f.host.attach(input),
      expect(f.host.attach({ sessionId: input.sessionId, cwd: input.cwd })).rejects.toMatchObject({ code: "antigravity_execution_environment_restart_required" })]);
    expect(concurrent.handleId).toBe(a.handleId);
    expect(a).toMatchObject({ loading: true, setup: { session: {} }, pendingPermissions: [{ request: { sessionId: input.sessionId } }] });
    await expect(f.host.request({ handleId: a.handleId, operationId: "too-early", command: { type: "prompt", prompt: [] } }))
      .rejects.toMatchObject({ code: "antigravity_session_loading", delivery: "not_sent" });
    // The normal 1s load budget must not cap a human decision.
    await new Promise(resolve => realSetTimeout(resolve, 1100));
    const held = await f.host.attachExisting(input);
    expect(held?.pendingPermissions).toEqual(a.pendingPermissions);
    const command = { type: "permission" as const, requestId: a.pendingPermissions[0]!.requestId,
      response: { outcome: { outcome: "selected" as const, optionId: "allow" } } };
    expect(await f.host.request({ handleId: a.handleId, operationId: "answer", command })).toMatchObject({ status: "completed" });
    await vi.waitFor(async () => {
      const loaded = await f.host.attachExisting(input);
      expect(loaded?.loading).toBeUndefined();
      expect(loaded?.setup.session.configOptions).not.toHaveLength(0);
      expect(loaded?.pendingPermissions).toEqual([]);
    });
    expect(await drain(f.host, a.handleId)).toContainEqual(expect.objectContaining({ kind: "session_loaded" }));
  });
  it.each(["stall", "fail"] as const)("closes a %s following a load decision and retains the answer until delivery", async behavior => {
    const f = await fixture(), input = replayInput(f.cwd, behavior);
    const a = await f.host.attach(input);
    expect(a.loading).toBe(true);
    const command = { type: "permission" as const, requestId: a.pendingPermissions[0]!.requestId, response: { outcome: { outcome: "cancelled" as const } } };
    await f.host.request({ handleId: a.handleId, operationId: "answer", command });
    await vi.waitFor(() => expect(f.host.snapshot().retainedSessions).toContainEqual(expect.objectContaining({ handleId: a.handleId, closed: true })),
      { timeout: 5000 });
    expect(await f.host.outcome({ handleId: a.handleId, operationId: "answer" })).toMatchObject({ status: "completed" });
    expect(await drain(f.host, a.handleId)).toContainEqual(expect.objectContaining({ kind: "failure" }));
    await f.host.acknowledgeOperation({ handleId: a.handleId, operationId: "answer" });
    await f.host.release({ handleId: a.handleId });
    expect(await f.host.attachExisting(input)).toBeNull();
  });
  it("reopens a failed bound load after delivering its receipts even while native history still shows active work", async () => {
    const f = await fixture(), input = replayInput(f.cwd, "wait");
    f.readHistory.mockResolvedValue({ ...input, native: { revision: "b".repeat(64), executions: [], steps: [
      { index: 0, type: 132, status: 2, hasSubtrajectory: false, tool: { id: "read", name: "read_file", argumentsJson: "{}" } },
    ] } });
    const first = await f.host.attach(input);
    await f.host.request({ handleId: first.handleId, operationId: "deny", command: { type: "permission",
      requestId: first.pendingPermissions[0]!.requestId, response: { outcome: { outcome: "cancelled" } } } });
    await vi.waitFor(() => expect(f.host.snapshot().retainedSessions[0]?.closed).toBe(true));
    await f.host.release({ handleId: first.handleId });
    expect(await f.host.retireSession(input)).toBe("busy");
    // A reconnect can still consume the closed generation's permission result and failure.
    expect(antigravityAttachmentSchema.parse(await f.host.attach(input))).toMatchObject({ handleId: first.handleId, closed: true });
    expect(await f.host.outcome({ handleId: first.handleId, operationId: "deny" })).toMatchObject({ status: "completed" });
    await f.host.acknowledgeOperation({ handleId: first.handleId, operationId: "deny" });
    expect(await drain(f.host, first.handleId)).toContainEqual(expect.objectContaining({ kind: "failure" }));
    f.readHistory.mockRejectedValueOnce(new Error("Replacement cannot read the native session"));
    await expect(f.host.attach(input)).rejects.toMatchObject({ code: "antigravity_session_load_unavailable" });
    expect((await f.host.attachExisting(input))?.handleId).toBe(first.handleId);
    const [retry, joined] = await Promise.all([f.host.attach(input), f.host.attach(input)]);
    expect(retry.handleId).not.toBe(first.handleId);
    expect(joined.generation).toBe(retry.generation);
    expect(retry.retainedOperationIds).toEqual([]);
    expect(await f.host.outcome({ handleId: retry.handleId, operationId: "deny" })).toMatchObject({ status: "completed" });
    await f.host.release({ handleId: first.handleId });
    expect(f.host.snapshot().retainedSessions).toEqual([expect.objectContaining({ handleId: retry.handleId, closed: false })]);
    await f.host.request({ handleId: retry.handleId, operationId: "allow", command: { type: "permission",
      requestId: retry.pendingPermissions[0]!.requestId, response: { outcome: { outcome: "selected", optionId: "allow" } } } });
    await vi.waitFor(async () => expect((await f.host.attachExisting(input))?.setup.session.configOptions?.length).toBeGreaterThan(0));
    expect(await f.host.retireSession(input)).toBe("busy");
  });
  it("rejects another session's early approval and requires verified native history before exposing the bound one", async () => {
    const f = await fixture();
    const foreign = await f.host.attach(replayInput(f.cwd, "wrong_session"));
    expect(foreign.pendingPermissions).toEqual([]);
    expect(foreign.loading).toBeUndefined();
    const input = { ...replayInput(f.cwd, "wait"), sessionId: "7f093f32-f035-4796-93d3-cb0f4cfc4928" };
    f.readHistory.mockRejectedValueOnce(new Error("identity mismatch"));
    await expect(f.host.attach(input)).rejects.toMatchObject({ code: "antigravity_session_load_unavailable" });
    expect(await f.host.attachExisting(input)).toBeNull();
  });
  it("allows Stop to cancel a replayed approval but keeps its outcome uncertain while load has not finished replay", async () => {
    const f = await fixture(25), input = replayInput(f.cwd, "stall");
    const a = await f.host.attach(input);
    expect(a.pendingPermissions).toHaveLength(1);
    await f.host.request({ handleId: a.handleId, operationId: "stop", command: { type: "cancel" } });
    expect(await settled(f.host, a.handleId, "stop")).toMatchObject({ status: "failed", failure: { code: "antigravity_cancel_unproven" } });
    expect((await f.host.attachExisting(input))?.pendingPermissions).toEqual([]);
  });
  it("recovers an unacknowledged Stop across a failed load without dispatching it to the replacement", async () => {
    const f = await fixture(25), input = replayInput(f.cwd, "fail");
    const first = await f.host.attach(input);
    const cancel = { operationId: "stop", command: { type: "cancel" as const } };
    await f.host.request({ handleId: first.handleId, ...cancel });
    const original = await settled(f.host, first.handleId, cancel.operationId);
    expect(original).toMatchObject({ status: "failed", failure: { delivery: "sent_outcome_unknown" } });
    await vi.waitFor(() => expect(f.host.snapshot().retainedSessions[0]?.closed).toBe(true));
    expect(await drain(f.host, first.handleId)).toContainEqual(expect.objectContaining({ kind: "failure" }));
    await f.host.release({ handleId: first.handleId });
    const retry = await f.host.attach(input);
    expect(retry.generation).not.toBe(first.generation);
    expect(retry.retainedOperationIds).toContain(cancel.operationId);
    expect(await f.host.request({ handleId: retry.handleId, ...cancel })).toEqual(original);
    expect((await f.host.attachExisting(input))?.pendingPermissions).toHaveLength(1);
    await f.host.acknowledgeOperation({ handleId: retry.handleId, operationId: cancel.operationId });
    expect(await f.host.outcome({ handleId: retry.handleId, operationId: cancel.operationId })).toEqual(original);
  });
  it("retains an unanswered permission when load immediately supplies its settings", async () => {
    const f = await fixture(), input = replayInput(f.cwd, "immediate");
    const a = await f.host.attach(input);
    await vi.waitFor(async () => {
      const retained = await f.host.attachExisting(input);
      expect(retained).toMatchObject({ handleId: a.handleId, pendingPermissions: [{ request: { sessionId: input.sessionId } }] });
      expect(retained?.loading).toBeUndefined();
    });
    await f.host.close();
    expect(f.host.snapshot().retainedSessions).toEqual([]);
  });
  it("retires a proven-closed native session despite passive cache eviction failure", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "create" });
    const { handleId } = await f.host.attach(identity);
    await f.host.acknowledgeCreation({ ...identity, operationId: "create" }); await drain(f.host, handleId);
    f.history.forget.mockRejectedValueOnce(new Error("passive_cache_capacity"));
    expect(await f.host.retireSession(identity)).toBe("retired");
    expect(f.host.snapshot().retainedSessions).toHaveLength(0);
    expect(f.host.snapshot().blockers).not.toContain("cleanup_unproven");
    expect(await f.host.attachExisting(identity)).toBeNull();
  });
  it("bounds a stalled passive cache eviction without retaining proven-closed native ownership", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "create" });
    const { handleId } = await f.host.attach(identity);
    await f.host.acknowledgeCreation({ ...identity, operationId: "create" }); await drain(f.host, handleId);
    f.history.forget.mockImplementationOnce(async () => new Promise(() => {}));
    expect(await f.host.retireSession(identity)).toBe("retired");
    expect(f.host.snapshot().retainedSessions).toHaveLength(0);
    expect(f.host.snapshot().blockers).not.toContain("cleanup_unproven");
  });
  it("cleans a catalog probe after proven peer closure when passive cache eviction fails", async () => {
    const f = await fixture(); f.history.forget.mockRejectedValueOnce(new Error("passive_cache_post_message_failed"));
    await expect(f.host.catalog({ cwd: f.cwd })).resolves.toMatchObject({ initialize: { protocolVersion: 1 } });
    expect(f.removeProbe).toHaveBeenCalledOnce();
    await expect(stat(f.removeProbe.mock.calls[0]![0].cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.host.snapshot().blockers).not.toContain("cleanup_unproven");
  });
  it("reconciles late ACP tool IDs from unchanged cached native terminal evidence", async () => {
    const activity = vi.spyOn(nativeActivity, "antigravityNativeActivity");
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "create" });
    const { handleId } = await f.host.attach(identity);
    activity.mockClear();
    const native: AntigravityHistory["native"] = { revision: "b".repeat(64), executions: [], steps: [
      { index: 0, type: 132, status: 3, hasSubtrajectory: false, tool: { id: "native-tool", name: "read_file", argumentsJson: "{}" } },
    ] };
    f.readHistory.mockResolvedValue({ ...identity, native });
    await f.host.readHistory(identity); expect(activity).toHaveBeenCalledOnce();
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "native-tool", title: "Read", status: "in_progress" } });
    expect(f.host.snapshot().blockers).toContain("active_work");
    await expect(f.host.readHistory({ ...identity, knownRevision: native.revision })).resolves.toBeNull();
    expect(activity).toHaveBeenCalledOnce(); expect(f.host.snapshot().blockers).not.toContain("active_work");
    await f.host.acknowledgeCreation({ ...identity, operationId: "create" }); await drain(f.host, handleId);
    expect(await f.host.retireSession(identity)).toBe("retired"); expect(activity).toHaveBeenCalledOnce();
  });
  it("settles a late prompt callback and unmatched ACP tool from unchanged cached final-response evidence", async () => {
    const activity = vi.spyOn(nativeActivity, "antigravityNativeActivity");
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "create" });
    const { handleId } = await f.host.attach(identity);
    let reply!: () => void;
    vi.spyOn(AntigravityAcpConnection.prototype, "prompt").mockImplementationOnce(async (_id, _prompt, settle) => new Promise(resolve => {
      reply = () => { const result = { stopReason: "end_turn" as const }; settle(result); resolve(result); };
    }));
    await f.host.request({ handleId, operationId: "prompt", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } });
    const native: AntigravityHistory["native"] = { revision: "b".repeat(64), executions: [], steps: [
      { index: 0, type: 15, status: 3, hasSubtrajectory: false, response: { text: "Done", thinking: "", stopReason: 2, toolCalls: [] } },
    ] };
    f.readHistory.mockResolvedValue({ ...identity, native }); await f.host.readHistory(identity);
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp-only-tool", title: "Read", status: "in_progress" } });
    await f.host.readHistory({ ...identity, knownRevision: native.revision });
    expect(f.host.snapshot().blockers).toContain("active_work"); expect(activity).toHaveBeenCalledTimes(2);
    reply(); await settled(f.host, handleId, "prompt");
    await vi.waitFor(() => expect(f.host.snapshot().blockers).not.toContain("active_work"));
    await f.host.acknowledgeOperation({ handleId, operationId: "prompt" });
    await f.host.acknowledgeCreation({ ...identity, operationId: "create" }); await drain(f.host, handleId);
    expect(await f.host.retireSession(identity)).toBe("retired"); expect(activity).toHaveBeenCalledTimes(2);
  });
  it("returns no unchanged snapshot after reading native activity and rechecking authority", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "create" });
    const native: AntigravityHistory["native"] = { revision: "b".repeat(64), executions: [], steps: [
      { index: 0, type: 132, status: 2, hasSubtrajectory: false, command: { commandId: "background", persistent: true, command: "sleep 1", cwd: f.cwd, output: "" } },
    ] };
    f.readHistory.mockResolvedValue({ ...identity, native });
    await expect(f.host.readHistory({ ...identity, knownRevision: native.revision })).resolves.toBeNull();
    expect(f.readHistory).toHaveBeenLastCalledWith(identity, undefined);
    expect(f.host.snapshot().blockers).toContain("active_work");
    await expect(f.host.readHistory({ ...identity, knownRevision: "c".repeat(64) })).resolves.toMatchObject({ native });
    let current = true;
    f.readHistory.mockImplementationOnce(async () => { current = false; return { ...identity, native }; });
    await expect(f.host.readHistory({ ...identity, knownRevision: native.revision }, undefined, {
      assertAdmission() {}, assertCurrent() { if (!current) throw new Error("stale_authority"); },
    })).rejects.toThrow("stale_authority");
  });
  it("forgets retired history and closes its reader only after Stop enters native cleanup", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "create" });
    await expect(f.host.stop({ expectedRevision: f.host.snapshot().revision, force: false }))
      .rejects.toMatchObject({ code: "antigravity_runtime_busy" });
    expect(f.history.close).not.toHaveBeenCalled();
    await f.host.acknowledgeCreation({ ...identity, operationId: "create" });
    expect(await f.host.retireSession(identity)).toBe("retired");
    expect(f.history.forget).toHaveBeenCalledWith(identity);
    expect(f.history.close).not.toHaveBeenCalled();
    await f.host.close(); expect(f.history.close).toHaveBeenCalledOnce();
    await expect(f.host.readHistory(identity)).rejects.toMatchObject({ code: "antigravity_runtime_closed" });
  });
  it("closes its reader while retaining an unproven native owner for forced cleanup retry", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "create" });
    vi.spyOn(AntigravityAcpConnection.prototype, "close").mockRejectedValueOnce(new Error("cleanup_unproven"));
    await expect(f.host.close()).rejects.toMatchObject({ code: "antigravity_cleanup_unproven" });
    expect(f.history.close).toHaveBeenCalledOnce();
    expect(f.host.snapshot().blockers).toContain("cleanup_unproven");
    await expect(f.host.readHistory(identity)).rejects.toMatchObject({ code: "antigravity_runtime_closed" });
    await f.host.close(); expect(f.history.close).toHaveBeenCalledOnce();
    expect(f.history.forget).toHaveBeenCalledWith(identity);
  });
  it("retains the session on owned process cleanup failure and retries that channel on forced Stop", async () => {
    const f = await fixture();
    const opened = vi.spyOn(f.channels, "openOwnedProcess");
    const identity = await f.host.create({ cwd: f.cwd, operationId: "create" });
    await f.host.acknowledgeCreation({ ...identity, operationId: "create" });
    const channel = await opened.mock.results[0]!.value;
    const close = vi.spyOn(channel, "close").mockRejectedValue(new Error("process cleanup failed"));
    await expect(f.host.retireSession(identity)).rejects.toMatchObject({ code: "antigravity_cleanup_unproven" });
    await expect(f.host.close()).rejects.toMatchObject({ code: "antigravity_cleanup_unproven" });
    expect(f.host.snapshot()).toMatchObject({ blockers: expect.arrayContaining(["cleanup_unproven"]),
      retainedSessions: [expect.objectContaining({ ...identity, closed: true })] });
    expect(f.history.forget).not.toHaveBeenCalled();
    close.mockRestore();
    await f.host.close();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(f.host.snapshot().retainedSessions).toEqual([]);
    expect(f.history.forget).toHaveBeenCalledWith(identity);
  });
  it("fences failed-load replacement with unsettled ACP continuations but can force-stop the proven-closed process", async () => {
    const f = await fixture(), input = replayInput(f.cwd, "fail");
    const open = AntigravityAcpConnection.open;
    const launch = vi.spyOn(AntigravityAcpConnection, "open").mockImplementationOnce(async options => {
      const peer = await open(options);
      const report = peer.binding.closed.then(closure => ({ ...closure, continuations: "unsettled" as const }));
      vi.spyOn(peer.binding, "closed", "get").mockReturnValue(report);
      return peer;
    });
    const a = await f.host.attach(input);
    await f.host.request({ handleId: a.handleId, operationId: "decision", command: { type: "permission",
      requestId: a.pendingPermissions[0]!.requestId, response: { outcome: { outcome: "cancelled" } } } });
    await vi.waitFor(() => expect(f.host.snapshot().blockers).toContain("cleanup_unproven"));
    await f.host.acknowledgeOperation({ handleId: a.handleId, operationId: "decision" });
    await drain(f.host, a.handleId);
    await expect(f.host.attach(input)).rejects.toMatchObject({ code: "antigravity_cleanup_unproven" });
    expect(launch).toHaveBeenCalledOnce();
    await f.host.close();
    expect(f.host.snapshot().retainedSessions).toEqual([]);
  });
  it("settles admitted history reads through worker shutdown without accepting new reads", async () => {
    const f = await fixture(), identity = { sessionId: "native-session", cwd: f.cwd };
    let rejectRead!: (error: Error) => void;
    f.readHistory.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const reading = expect(f.host.readHistory(identity)).rejects.toThrow("reader_closed");
    f.history.close.mockImplementationOnce(async () => { rejectRead(new Error("reader_closed")); });
    await f.host.close(); await reading;
    expect(f.history.close).toHaveBeenCalledOnce();
    await expect(f.host.readHistory(identity)).rejects.toMatchObject({ code: "antigravity_runtime_closed" });
  });
  it("retains a cleanup blocker when the reader worker cannot prove shutdown", async () => {
    const f = await fixture(); f.history.close.mockRejectedValueOnce(new Error("worker_cleanup_unproven"));
    await expect(f.host.close()).rejects.toMatchObject({ code: "antigravity_cleanup_unproven" });
    expect(f.host.snapshot().blockers).toContain("cleanup_unproven");
    await expect(f.host.create({ cwd: f.cwd, operationId: "replacement" }))
      .rejects.toMatchObject({ code: "antigravity_cleanup_unproven", delivery: "not_sent" });
    await f.host.close();
    expect(f.history.close).toHaveBeenCalledTimes(2);
    expect(f.host.snapshot().blockers).not.toContain("cleanup_unproven");
    await expect(f.host.create({ cwd: f.cwd, operationId: "still-closed" })).rejects.toMatchObject({ code: "antigravity_runtime_closed" });
  });
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
    expect((await host.attachExisting(identity))?.activePromptIds).toEqual(["send"]);
    expect((await host.observe({ handleId, afterSequence: 0 })).activePromptIds).toEqual(["send"]);
    await expect(host.request({ handleId, operationId: "second", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } })).rejects.toMatchObject({ code: "antigravity_session_busy" });
    await host.request({ handleId, operationId: "stop", command: { type: "cancel" } });
    expect(await settled(host, handleId, "send")).toMatchObject({ status: "completed", result: { stopReason: "cancelled" } });
    expect((await host.observe({ handleId, afterSequence: 0 })).activePromptIds).toEqual([]);
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
    expect(() => new AntigravityHost({ configuration: { ...configuration, principalId: "wrong" }, channels, environment: {}, history: { read: readHistory, forget: async () => undefined, close: async () => undefined } })).toThrow("antigravity_runtime_scope_denied");
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
  it("reconciles permission-rejected prompts and unmatched tools from executor proof without an explicit Stop", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" });
    const { handleId } = await f.host.attach(identity), replies: (() => void)[] = [];
    vi.spyOn(AntigravityAcpConnection.prototype, "prompt").mockImplementation(async (_id, _prompt, settle) => new Promise(resolve => {
      replies.push(() => { const result = { stopReason: "cancelled" as const }; settle(result); resolve(result); });
    }));
    const cancel = vi.spyOn(AntigravityAcpConnection.prototype, "cancel");
    for (const operationId of ["primary", "queued-steer"]) await f.host.request({ handleId, operationId,
      command: { type: operationId === "primary" ? "prompt" : "steer", prompt: [{ type: "text", text: operationId }] } });
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp-only", title: "Run", status: "in_progress" } });
    const permission = f.permission({ sessionId: identity.sessionId, toolCall: { toolCallId: "acp-only", title: "Run" },
      options: [{ optionId: "deny", name: "Deny", kind: "reject_once" }] });
    const requestId = (await f.host.attachExisting(identity))!.pendingPermissions[0]!.requestId;
    await f.host.request({ handleId, operationId: "deny", command: { type: "permission", requestId,
      response: { outcome: { outcome: "selected", optionId: "deny" } } } });
    await permission;
    const native: AntigravityHistory["native"] = { revision: "b".repeat(64), executions: [], steps: [
      { index: 0, type: 14, status: 3, hasSubtrajectory: false, executionId: "execution", user: { text: "Primary" } },
      { index: 1, type: 15, status: 3, hasSubtrajectory: false, executionId: "execution", response: { text: "", thinking: "", stopReason: 2,
        toolCalls: [{ id: "native-only", name: "run_command", argumentsJson: "{}" }] } },
      { index: 2, type: 132, status: 6, hasSubtrajectory: false, executionId: "execution", tool: { id: "native-only", name: "run_command", argumentsJson: "{}" } },
    ] };
    f.readHistory.mockResolvedValue({ ...identity, native });
    for (const reply of replies) reply();
    await f.host.readHistory(identity);
    expect(await f.host.outcome({ handleId, operationId: "queued-steer" })).not.toHaveProperty("cancelledAtNativeRevision");
    expect(f.host.snapshot().blockers).toContain("active_work");
    native.executions.push({ executionId: "execution", lastStepIndex: 2, terminationReason: 2, proceededWithAutoContinue: false });
    native.revision = "c".repeat(64);
    await f.host.readHistory(identity);
    for (const operationId of ["primary", "queued-steer"]) {
      expect(await f.host.outcome({ handleId, operationId })).toMatchObject({ status: "completed", cancelledAtNativeRevision: native.revision });
    }
    expect(f.host.snapshot().blockers).not.toContain("active_work");
    expect(f.host.snapshot().blockers).toContain("unsettled_outcome");
    expect(cancel).not.toHaveBeenCalled();
    for (const operationId of ["primary", "queued-steer", "deny"]) await f.host.acknowledgeOperation({ handleId, operationId });
    await f.host.acknowledgeCreation({ ...identity, operationId: "creation" }); await drain(f.host, handleId);
    expect(await f.host.retireSession(identity)).toBe("retired");
  });
  it("requires a native read begun after cancelled callback settlement even without explicit Stop", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    let reply!: () => void;
    vi.spyOn(AntigravityAcpConnection.prototype, "prompt").mockImplementationOnce(async (_id, _prompt, settle) => new Promise(resolve => {
      reply = () => { const result = { stopReason: "cancelled" as const }; settle(result); resolve(result); };
    }));
    await f.host.request({ handleId, operationId: "primary", command: { type: "prompt", prompt: [{ type: "text", text: "wait" }] } });
    let oldRead!: (value: AntigravityHistory) => void, freshRead!: (value: AntigravityHistory) => void;
    f.readHistory.mockImplementationOnce(async () => new Promise(resolve => { oldRead = resolve; }))
      .mockImplementationOnce(async () => new Promise(resolve => { freshRead = resolve; }));
    const reading = f.host.readHistory(identity); reply();
    const terminal = { ...identity, native: { revision: "b".repeat(64), executions: [], steps: [] } };
    oldRead(terminal); await reading;
    expect(await f.host.outcome({ handleId, operationId: "primary" })).not.toHaveProperty("cancelledAtNativeRevision");
    freshRead(terminal);
    await vi.waitFor(async () => expect(await f.host.outcome({ handleId, operationId: "primary" })).toMatchObject({ cancelledAtNativeRevision: terminal.native.revision }));
  });
  it("retires unmatched ACP tools when the active native step present at Steer dispatch is cancelled in place", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" });
    const { handleId } = await f.host.attach(identity), replies: (() => void)[] = [];
    vi.spyOn(AntigravityAcpConnection.prototype, "prompt").mockImplementation(async (_id, _prompt, settle) => new Promise(resolve => {
      replies.push(() => { const result = { stopReason: "cancelled" as const }; settle(result); resolve(result); });
    }));
    await f.host.request({ handleId, operationId: "primary", command: { type: "prompt", prompt: [{ type: "text", text: "Primary" }] } });
    const native: AntigravityHistory["native"] = { revision: "b".repeat(64), executions: [], steps: [
      { index: 0, type: 14, status: 3, hasSubtrajectory: false, executionId: "execution", user: { text: "Primary" } },
      { index: 1, type: 15, status: 3, hasSubtrajectory: false, executionId: "execution", response: { text: "", thinking: "", stopReason: 2,
        toolCalls: [{ id: "native-only", name: "run_command", argumentsJson: "{}" }] } },
      { index: 2, type: 132, status: 2, hasSubtrajectory: false, executionId: "execution", tool: { id: "native-only", name: "run_command", argumentsJson: "{}" } },
    ] };
    f.readHistory.mockResolvedValue({ ...identity, native });
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp-only", title: "Run", status: "in_progress" } });
    await f.host.request({ handleId, operationId: "steer", command: { type: "steer", prompt: [{ type: "text", text: "Queued input" }] } });
    // Cancellation changes the existing head, without appending another step.
    native.steps[2]!.status = 6;
    native.executions.push({ executionId: "execution", lastStepIndex: 2, terminationReason: 2, proceededWithAutoContinue: false });
    native.revision = "c".repeat(64);
    for (const reply of replies) reply();
    await f.host.readHistory(identity);

    for (const operationId of ["primary", "steer"]) {
      expect(await f.host.outcome({ handleId, operationId })).toMatchObject({ status: "completed", cancelledAtNativeRevision: native.revision });
      await f.host.acknowledgeOperation({ handleId, operationId });
    }
    expect(f.host.snapshot().blockers).not.toContain("active_work");
    await f.host.acknowledgeCreation({ ...identity, operationId: "creation" }); await drain(f.host, handleId);
    expect(await f.host.retireSession(identity)).toBe("retired");
  });
  it("does not prove cancelled input withdrawal while a child or new prompt is still active", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    const replies: (() => void)[] = [];
    vi.spyOn(AntigravityAcpConnection.prototype, "prompt").mockImplementation(async (_id, _prompt, settle) => new Promise(resolve => {
      replies.push(() => { const result = { stopReason: "cancelled" as const }; settle(result); resolve(result); });
    }));
    for (const operationId of ["primary", "steer"]) await f.host.request({ handleId, operationId,
      command: { type: operationId === "primary" ? "prompt" : "steer", prompt: [{ type: "text", text: operationId }] } });
    replies[0]!(); await f.host.readHistory(identity);
    expect(await f.host.outcome({ handleId, operationId: "primary" })).not.toHaveProperty("cancelledAtNativeRevision");
    f.readHistory.mockResolvedValue({ ...identity, native: { revision: "b".repeat(64), executions: [], steps: [
      { index: 0, type: 132, status: 3, hasSubtrajectory: false, subagents: [{ sessionId: "8a54e222-1000-4000-8000-000000000002", state: "active" }] },
    ] } });
    replies[1]!(); await f.host.readHistory(identity);
    expect(await f.host.outcome({ handleId, operationId: "primary" })).not.toHaveProperty("cancelledAtNativeRevision");
    expect(f.host.snapshot().blockers).toContain("active_work");
  });
  it.each(["primary_first", "steer_first"] as const)("keeps the original prompt frontier when Steer arrives after durable cancellation (%s)", async order => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" });
    const { handleId } = await f.host.attach(identity), replies: (() => void)[] = [];
    const native: AntigravityHistory["native"] = { revision: "b".repeat(64), executions: [], steps: [
      { index: 0, type: 14, status: 3, hasSubtrajectory: false, executionId: "previous", user: { text: "Previous input" } },
      { index: 1, type: 15, status: 3, hasSubtrajectory: false, executionId: "previous", response: { text: "Done", thinking: "", stopReason: 2, toolCalls: [] } },
    ] };
    f.readHistory.mockResolvedValue({ ...identity, native });
    vi.spyOn(AntigravityAcpConnection.prototype, "prompt").mockImplementation(async (_id, _prompt, settle) => new Promise(resolve => {
      replies.push(() => { const result = { stopReason: "cancelled" as const }; settle(result); resolve(result); });
    }));
    await f.host.request({ handleId, operationId: "primary", command: { type: "prompt", prompt: [{ type: "text", text: "Primary" }] } });
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "acp-only", title: "Run", status: "in_progress" } });
    native.steps.push(
      { index: 2, type: 14, status: 3, hasSubtrajectory: false, executionId: "current", user: { text: "Primary" } },
      { index: 3, type: 15, status: 3, hasSubtrajectory: false, executionId: "current", response: { text: "", thinking: "", stopReason: 2,
        toolCalls: [{ id: "native-only", name: "run_command", argumentsJson: "{}" }] } },
      { index: 4, type: 132, status: 6, hasSubtrajectory: false, executionId: "current", tool: { id: "native-only", name: "run_command", argumentsJson: "{}" } },
    );
    native.executions.push({ executionId: "current", lastStepIndex: 4, terminationReason: 2, proceededWithAutoContinue: false });
    native.revision = "c".repeat(64);
    // The executor outcome is already durable, but its primary ACP callback
    // has not settled. A concurrent Steer still belongs to that prompt set.
    await f.host.request({ handleId, operationId: "steer", command: { type: "steer", prompt: [{ type: "text", text: "Queued input" }] } });
    expect(await f.host.outcome({ handleId, operationId: "primary" })).toEqual({ status: "pending" });
    expect(f.host.snapshot().blockers).toContain("active_work");
    for (const index of order === "primary_first" ? [0, 1] : [1, 0]) replies[index]!();
    await f.host.readHistory(identity);
    for (const operationId of ["primary", "steer"]) {
      expect(await f.host.outcome({ handleId, operationId })).toMatchObject({ status: "completed", cancelledAtNativeRevision: native.revision });
      await f.host.acknowledgeOperation({ handleId, operationId });
    }
    expect(f.host.snapshot().blockers).not.toContain("active_work");
    await f.host.acknowledgeCreation({ ...identity, operationId: "creation" }); await drain(f.host, handleId);
    expect(await f.host.retireSession(identity)).toBe("retired");
  });
  it.each([
    { execution: "same", outcome: "completed" }, { execution: "interrupting", outcome: "completed" },
    { execution: "continued", outcome: "completed" },
    { execution: "same", outcome: "cancelled" }, { execution: "interrupting", outcome: "cancelled" },
  ] as const)("settles a child continuation after a consumed $execution-execution Steer is $outcome", async ({ execution, outcome }) => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" });
    const { handleId } = await f.host.attach(identity), childId = "8a54e222-1000-4000-8000-000000000002";
    const scope = { key: Buffer.alloc(32, 1), binding: { version: 1 as const, ...f.configuration,
      sessionId: identity.sessionId, canonicalWorkspacePath: f.cwd, connectionProfileId: "test", nativeNamespaceKey: "test" } };
    const prompt = await buildAntigravityPrompt(scope, { applicationOperationId: "steer", mutationId: "steer",
      reconciliationToken: "receipt", source: { kind: "user" }, text: "Continue", contextExcerpts: [], taskContexts: [], attachments: [] }, "", "steer");
    if (prompt[0]?.type !== "text") throw new Error("missing_steer_text");
    const executionId = execution === "same" ? "continuation" : execution === "continued" ? "auto-continued" : "interrupted-continuation";
    const precedingExecutionId = execution === "continued" ? executionId : "continuation";
    const native: AntigravityHistory["native"] = { revision: "b".repeat(64), executions: [], steps: [
      { index: 0, type: 132, status: 3, hasSubtrajectory: false, subagents: [{ sessionId: childId, state: "terminal" }] },
      { index: 1, type: 101, status: 3, hasSubtrajectory: false, executionId: "continuation", continuation: { id: "receipt", sender: childId,
        recipient: identity.sessionId, kind: "agent_message", content: "Child finished" } },
      { index: 2, type: 15, status: 3, hasSubtrajectory: false, executionId: precedingExecutionId, response: { text: "", thinking: "", stopReason: 2,
        toolCalls: [{ id: "tool", name: "run_command", argumentsJson: "{}" }] } },
      { index: 3, type: 132, status: 3, hasSubtrajectory: false, executionId: precedingExecutionId, tool: { id: "tool", name: "run_command", argumentsJson: "{}" } },
      { index: 4, type: 14, status: 3, hasSubtrajectory: false, executionId, user: { text: prompt[0].text },
        ...(outcome === "cancelled" || execution === "interrupting" ? { isInterruptingStep: true as const,
          startedAt: "2026-11-22T00:00:01.000Z", completedAt: "2026-11-22T00:00:01.001Z" } : {}) },
    ] };
    if (outcome === "completed") native.steps.push({ index: 5, type: 15, status: 3, hasSubtrajectory: false, executionId,
      response: { text: "Finished", thinking: "", stopReason: 2, toolCalls: [] } });
    else {
      native.steps.push({ index: 5, type: 132, status: 6, hasSubtrajectory: false, executionId });
      native.executions.push({ executionId, lastStepIndex: 5, terminationReason: 2, proceededWithAutoContinue: false });
    }
    expect(nativeActivity.antigravityNativeActivity(native)).toEqual({ active: false, unknown: false, foregroundActive: false,
      pendingContinuations: false, agents: 0, commands: 0, other: 0 });
    const projection = projectAntigravityHistory(native, scope);
    expect(projection.snapshot.runState).toBe("idle");
    expect(projection.snapshot.turnsById["continuation:1"]).toMatchObject({
      status: outcome === "completed" ? "completed" : "interrupted", completionCorrelations: ["steer"],
    });
    f.readHistory.mockResolvedValue({ ...identity, native }); await f.host.readHistory(identity);
    expect(f.host.snapshot().blockers).not.toContain("active_work");
    await f.host.request({ handleId, operationId: "next", command: { type: "prompt", prompt: [{ type: "text", text: "hello" }] } });
    expect(await settled(f.host, handleId, "next")).toMatchObject({ status: "completed" });
    await f.host.acknowledgeOperation({ handleId, operationId: "next" });
    await f.host.acknowledgeCreation({ ...identity, operationId: "creation" }); await drain(f.host, handleId);
    expect(await f.host.retireSession(identity)).toBe("retired");
  });
  it.each([1, 2, 3, 6, 11])("settles child continuations and retires unmatched ACP tools from executor reason %s", async terminationReason => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" }); const { handleId } = await f.host.attach(identity);
    const childId = "8a54e222-1000-4000-8000-000000000002";
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "continuation-tool", title: "Continue", status: "in_progress" } });
    const native: AntigravityHistory["native"] = { revision: "b".repeat(64), executions: [], steps: [
      { index: 0, type: 132, status: 3, hasSubtrajectory: false, subagents: [{ sessionId: childId, state: "terminal" }] },
      { index: 1, type: 101, status: 3, hasSubtrajectory: false, executionId: "continuation", continuation: { id: "receipt", sender: childId,
        recipient: identity.sessionId, kind: "agent_message", content: "Child finished" } },
      { index: 2, type: 132, status: terminationReason === 2 ? 6 : 7, hasSubtrajectory: false, executionId: "continued-execution", error: "tool did not finish", tool: { id: "native-tool", name: "run_command", argumentsJson: "{}" } },
    ] };
    f.readHistory.mockResolvedValue({ ...identity, native }); await f.host.readHistory(identity);
    expect(nativeActivity.antigravityNativeActivity(native)).toMatchObject({ active: true, pendingContinuations: true });
    native.executions.push({ executionId: "continued-execution", lastStepIndex: 2, terminationReason, proceededWithAutoContinue: false });
    native.revision = "c".repeat(64); await f.host.readHistory(identity);
    expect(nativeActivity.antigravityNativeActivity(native)).toMatchObject({ active: false, unknown: false, foregroundActive: false, pendingContinuations: false, agents: 0 });
    expect(f.host.snapshot().blockers).not.toContain("active_work");
    await f.host.acknowledgeCreation({ ...identity, operationId: "creation" }); await drain(f.host, handleId);
    expect(await f.host.retireSession(identity)).toBe("retired");
  });
  it.each([true, false])("does not settle a continuation using a later independent input's cancelled execution (planner response: %s)", hasPlanner => {
    const native: AntigravityHistory["native"] = { revision: "a".repeat(64), executions: [
      { executionId: "later", lastStepIndex: 3, terminationReason: 2, proceededWithAutoContinue: false },
    ], steps: [
      { index: 0, type: 101, status: 3, hasSubtrajectory: false, executionId: "earlier", continuation: { id: "receipt", sender: "child",
        recipient: "parent", kind: "agent_message", content: "Child finished" } },
      { index: 1, type: 14, status: 3, hasSubtrajectory: false, executionId: "later", user: { text: "Independent input" } },
      { index: 2, type: 15, status: 3, hasSubtrajectory: false, executionId: "later", response: { text: "", thinking: "", stopReason: 2,
        toolCalls: [{ id: "tool", name: "run_command", argumentsJson: "{}" }] } },
      { index: 3, type: 132, status: 6, hasSubtrajectory: false, executionId: "later" },
    ] };
    if (!hasPlanner) {
      native.steps.splice(2);
      native.executions[0]!.lastStepIndex = 1;
    }
    expect(nativeActivity.antigravityNativeActivity(native)).toMatchObject({ active: true, foregroundActive: true, pendingContinuations: true });
  });
  it("does not retire a new autonomous tool using a previously cached cancelled execution", async () => {
    const f = await fixture(), identity = await f.host.create({ cwd: f.cwd, operationId: "creation" });
    const native: AntigravityHistory["native"] = { revision: "b".repeat(64), executions: [
      { executionId: "previous", lastStepIndex: 0, terminationReason: 2, proceededWithAutoContinue: false },
    ], steps: [{ index: 0, type: 132, status: 6, hasSubtrajectory: false, executionId: "previous" }] };
    f.readHistory.mockResolvedValue({ ...identity, native }); await f.host.readHistory(identity);
    f.emit({ sessionId: identity.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "new-autonomous-tool", title: "Continue", status: "in_progress" } });
    await f.host.readHistory(identity);
    expect(f.host.snapshot().blockers).toContain("active_work");
    native.steps.push({ index: 1, type: 132, status: 6, hasSubtrajectory: false, executionId: "new-execution" });
    native.executions.push({ executionId: "new-execution", lastStepIndex: 1, terminationReason: 2, proceededWithAutoContinue: false });
    native.revision = "c".repeat(64); await f.host.readHistory(identity);
    expect(f.host.snapshot().blockers).not.toContain("active_work");
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
    f.readHistory.mockResolvedValue({ ...identity, native: { revision: "c".repeat(64), executions: [], steps: [{ index: 1, type: 132, status: 2, hasSubtrajectory: false,
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
