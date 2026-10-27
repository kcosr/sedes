import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiNativeHost, type PiNativeSessionLauncher } from "../../src/server/backends/pi/native/host/native-host.js";
import { PiNativeError, type PiNativeRuntimeConfiguration, type PiNativeSessionIdentity } from "../../src/server/backends/pi/native/port.js";
import { PiSessionWriterCleanupRequiredError } from "../../src/server/backends/pi/pi-session-writer-lock.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";

const configuration: PiNativeRuntimeConfiguration = { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend",
  executionEnvironmentId: "environment", initializationTimeoutMs: 1000, projectTrusted: false };
const identity: PiNativeSessionIdentity = { sessionId: "native-session", sessionFile: "/workspace/session.jsonl", cwd: "/workspace" };
const idleState = { ...identity, isStreaming: false, isCompacting: false, pendingMessageCount: 0, isIdle: true };
const hosts: PiNativeHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close().catch(() => undefined); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options: Partial<ConstructorParameters<typeof PiNativeHost>[0]> = {}) {
  const ended = deferred<never>();
  const requests = vi.fn(async (command: unknown, _options?: unknown): Promise<unknown> => (command as { type: string }).type === "get_state" ? idleState : { ok: true });
  const bridgeRequests = vi.fn(async (command: unknown): Promise<unknown> => (command as { type: string }).type === "snapshot" ? idleState : { ok: true });
  const close = vi.fn(async () => {});
  const respondUI = vi.fn(async () => {});
  const releaseWriter = vi.fn(async () => {});
  let event: Parameters<PiNativeSessionLauncher>[0]["onEvent"];
  const launch = vi.fn(async (input: Parameters<PiNativeSessionLauncher>[0]) => {
    event = input.onEvent;
    return { rpc: { request: requests, respondUI, closed: ended.promise },
      bridge: { request: bridgeRequests, closed: ended.promise }, close, version: "1.4.0" } as unknown as Awaited<ReturnType<PiNativeSessionLauncher>>;
  });
  const store = {
    resolveSessionDirectory: vi.fn(async (): Promise<string> => "/canonical/sessions"),
    create: vi.fn(async () => identity), fork: vi.fn(async () => identity), reconcileFork: vi.fn(async (): Promise<PiNativeSessionIdentity | null> => null), listSessions: vi.fn(async () => ({ sessions: [] })),
    readHistory: vi.fn(async () => ({ ...identity, entries: [], leafId: null, operations: [], toolCalls: [], toolResults: [], inheritedEntryIds: [], inheritance: "none" as const })),
  };
  const host = new PiNativeHost({ configuration, channels: {} as ExecutionEnvironmentChannelProvider, environment: {},
    authenticationKey: Buffer.alloc(32, 1), launch, store, acquireWriter: async () => ({ release: releaseWriter }),
    observationWaitMs: 1, ...options });
  hosts.push(host);
  return { host, launch, requests, bridgeRequests, close, respondUI, releaseWriter, store, ended,
    emit(payload: Record<string, unknown>, kind: "rpc" | "companion" = "rpc") { event?.({ kind, payload }); } };
}
async function settled(host: PiNativeHost, handleId: string, operationId: string) {
  await vi.waitFor(async () => { expect((await host.outcome({ handleId, operationId })).status).not.toBe("pending"); });
  return host.outcome({ handleId, operationId });
}

describe("native Pi host ownership", () => {
  it("admits 32 concurrent session snapshots alongside prepare, Send, settings, and all Stop phases", async () => {
    const f = fixture(), snapshots = Array.from({ length: 32 }, () => deferred<unknown>());
    let snapshotIndex = 0;
    f.bridgeRequests.mockImplementation(async command => (command as { type: string }).type === "snapshot"
      ? snapshots[snapshotIndex++]!.promise : { operations: [] });
    const sessions = [];
    for (let index = 0; index < 32; index++) {
      const session = await f.host.attach({ ...identity, sessionId: `session-${index}`, sessionFile: `/workspace/session-${index}.jsonl` });
      sessions.push(session);
      await f.host.request({ handleId: session.handleId, operationId: "snapshot", retainOutcome: false,
        command: { channel: "companion", command: { type: "snapshot" } } });
    }
    const { handleId } = sessions[31]!;
    const commands = [
      { channel: "companion" as const, command: { type: "prepare_submission", input: { operationId: "send", mutationId: "mutation", reconciliationToken: "token",
        fingerprint: "a".repeat(64), mode: "submit", text: "work" } } },
      { channel: "rpc" as const, command: { type: "prompt", message: "work" } },
      { channel: "companion" as const, command: { type: "set_policy", policy: { mode: "read_only" } } },
      { channel: "companion" as const, command: { type: "begin_stop" } },
      { channel: "rpc" as const, command: { type: "clear_queue" } },
      { channel: "rpc" as const, command: { type: "abort" } },
      { channel: "companion" as const, command: { type: "end_stop" } },
    ];
    for (const command of commands) {
      await f.host.request({ handleId, operationId: command.command.type, retainOutcome: true, command });
      expect(await settled(f.host, handleId, command.command.type)).toMatchObject({ status: "completed" });
    }
    for (const session of sessions) expect(await f.host.outcome({ handleId: session.handleId, operationId: "snapshot" })).toEqual({ status: "pending" });
    expect(snapshotIndex).toBe(32);
    expect(f.launch).toHaveBeenCalledTimes(32);
    for (const command of commands) await f.host.acknowledgeOperation({ handleId, operationId: command.command.type });
    for (let index = 0; index < sessions.length; index++) {
      const read = { handleId: sessions[index]!.handleId, operationId: "snapshot" };
      expect(await f.host.abandonObservation(read)).toBe("pending");
      snapshots[index]!.resolve({ entries: [] });
      await vi.waitFor(async () => expect(await f.host.abandonObservation(read)).toBe("released"));
    }
  });

  it("bounds actual retained read results while reserving ordinary Send and Stop capacity", async () => {
    const f = fixture({ maximumOperationBytes: 1024 * 1024 }), snapshots = Array.from({ length: 4 }, () => deferred<unknown>());
    let snapshotIndex = 0;
    f.bridgeRequests.mockImplementation(async command => (command as { type: string }).type === "snapshot"
      ? snapshots[snapshotIndex++]!.promise : { operations: [] });
    const sessions = [];
    for (let index = 0; index < 4; index++) {
      const session = await f.host.attach({ ...identity, sessionId: `session-${index}`, sessionFile: `/workspace/session-${index}.jsonl` });
      sessions.push(session);
      await f.host.request({ handleId: session.handleId, operationId: "snapshot", retainOutcome: true,
        command: { channel: "companion", command: { type: "snapshot" } } });
    }
    for (let index = 0; index < 4; index++) {
      snapshots[index]!.resolve({ text: "x".repeat(200 * 1024) });
      const result = await settled(f.host, sessions[index]!.handleId, "snapshot");
      expect(result).toMatchObject(index < 3 ? { status: "completed" } : { status: "failed",
        failure: { code: "pi_native_outcome_capacity", delivery: "sent_outcome_unknown" } });
    }
    const { handleId } = sessions[3]!, pending = deferred<unknown>();
    f.requests.mockImplementation(async command => (command as { type: string }).type === "prompt" ? pending.promise : { ok: true });
    await f.host.request({ handleId, operationId: "send", retainOutcome: true,
      command: { channel: "rpc", command: { type: "prompt", message: "x".repeat(300 * 1024) } } });
    for (const [channel, type] of [["companion", "begin_stop"], ["rpc", "clear_queue"], ["rpc", "abort"], ["companion", "end_stop"]] as const) {
      await f.host.request({ handleId, operationId: type, retainOutcome: true, command: { channel, command: { type } } });
      expect(await settled(f.host, handleId, type)).toMatchObject({ status: "completed" });
    }
    expect(await f.host.outcome({ handleId, operationId: "send" })).toEqual({ status: "pending" });
    pending.resolve({ disposition: "started" });
    expect(await settled(f.host, handleId, "send")).toMatchObject({ status: "completed" });
    for (const session of sessions) await f.host.acknowledgeOperation({ handleId: session.handleId, operationId: "snapshot" });
    f.bridgeRequests.mockResolvedValue({ text: "x".repeat(200 * 1024) });
    await f.host.request({ handleId, operationId: "fresh", retainOutcome: true, command: { channel: "companion", command: { type: "snapshot" } } });
    expect(await settled(f.host, handleId, "fresh")).toMatchObject({ status: "completed" });
  });

  it("isolates one session's retained read budget from other sessions", async () => {
    const f = fixture({ maximumOperationBytes: 1024 * 1024 }), first = await f.host.attach(identity);
    f.bridgeRequests.mockResolvedValue({ text: "x".repeat(110 * 1024) });
    for (const operationId of ["first", "second"]) {
      await f.host.request({ handleId: first.handleId, operationId, retainOutcome: true, command: { channel: "companion", command: { type: "snapshot" } } });
      expect(await settled(f.host, first.handleId, operationId)).toMatchObject({ status: "completed" });
    }
    await expect(f.host.request({ handleId: first.handleId, operationId: "third", retainOutcome: true,
      command: { channel: "companion", command: { type: "snapshot" } } })).rejects.toMatchObject({ code: "pi_native_operation_capacity", delivery: "not_sent" });
    const second = await f.host.attach({ ...identity, sessionId: "second", sessionFile: "/workspace/second.jsonl" });
    await f.host.request({ handleId: second.handleId, operationId: "peer", retainOutcome: true, command: { channel: "companion", command: { type: "snapshot" } } });
    expect(await settled(f.host, second.handleId, "peer")).toMatchObject({ status: "completed" });
    await f.host.acknowledgeOperation({ handleId: first.handleId, operationId: "first" });
    await f.host.request({ handleId: first.handleId, operationId: "third", retainOutcome: true, command: { channel: "companion", command: { type: "snapshot" } } });
    expect(await settled(f.host, first.handleId, "third")).toMatchObject({ status: "completed" });
  });

  it("retains oversized mutation outcomes as uncertain and counts command bytes before admission", async () => {
    const f = fixture({ maximumOperationBytes: 1024 * 1024 }), { handleId } = await f.host.attach(identity);
    f.requests.mockResolvedValue({ text: "x".repeat(2 * 1024 * 1024) });
    const input = { handleId, operationId: "mutation", retainOutcome: true,
      command: { channel: "rpc" as const, command: { type: "set_model", provider: "provider", modelId: "model" } } };
    await f.host.request(input);
    const outcome = await settled(f.host, handleId, input.operationId);
    expect(outcome).toEqual({ status: "failed", failure: { code: "pi_native_outcome_capacity", delivery: "sent_outcome_unknown" } });
    expect(await f.host.request(input)).toEqual(outcome);
    expect(f.requests).toHaveBeenCalledTimes(1);
    await expect(f.host.abandonObservation(input)).rejects.toThrow("pi_native_observation_abandon_denied");
    await expect(f.host.request({ handleId, operationId: "large-input", retainOutcome: true,
      command: { channel: "rpc", command: { type: "prompt", message: "x".repeat(2 * 1024 * 1024) } } }))
      .rejects.toMatchObject({ code: "pi_native_operation_capacity", delivery: "not_sent" });
    expect(f.requests).toHaveBeenCalledTimes(1);
    await f.host.acknowledgeOperation(input);
    f.requests.mockResolvedValue({ disposition: "started" });
    await f.host.request({ handleId, operationId: "small-send", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "work" } } });
    expect(await settled(f.host, handleId, "small-send")).toMatchObject({ status: "completed" });
  });

  it("releases cancelled observation storage after settlement while preserving Stop capacity across repeated slow reads", async () => {
    const f = fixture({ maximumOperations: 5 }), { handleId } = await f.host.attach(identity);
    for (let index = 0; index < 12; index++) {
      const pending = deferred<unknown>(), cancellation = new AbortController();
      f.bridgeRequests.mockImplementation(async command => (command as { type: string }).type === "snapshot" ? pending.promise : { operations: [] });
      const read = { handleId, operationId: `read-${index}`, retainOutcome: false,
        command: { channel: "companion" as const, command: { type: "snapshot" } } };
      await f.host.request(read, cancellation.signal);
      cancellation.abort();
      expect(await f.host.abandonObservation(read)).toBe("pending");
      expect(await f.host.abandonObservation(read)).toBe("pending");
      expect(await f.host.outcome(read)).toEqual({ status: "pending" });
      const stopIds: string[] = [];
      for (const [channel, type] of [["companion", "begin_stop"], ["rpc", "clear_queue"], ["rpc", "abort"], ["companion", "end_stop"]] as const) {
        const operationId = `stop-${index}-${type}`; stopIds.push(operationId);
        await f.host.request({ handleId, operationId, retainOutcome: true, command: { channel, command: { type } } });
        expect(await settled(f.host, handleId, operationId)).toMatchObject({ status: "completed" });
      }
      for (const operationId of stopIds) await f.host.acknowledgeOperation({ handleId, operationId });
      pending.resolve({ entries: ["large completed snapshot".repeat(1000)] });
      await vi.waitFor(async () => expect(await f.host.abandonObservation(read)).toBe("released"));
      expect(await f.host.abandonObservation(read)).toBe("released");
      await expect(f.host.outcome(read)).rejects.toThrow("pi_native_operation_unknown");
      await expect(f.host.request(read)).rejects.toThrow("pi_native_operation_acknowledged");
    }
    expect(f.bridgeRequests).toHaveBeenCalledTimes(36);
    expect(f.host.snapshot().blockers).not.toContain("unsettled_outcome");
  });

  it("immediately releases a settled observation and fences requests abandoned before admission", async () => {
    const f = fixture(), { handleId } = await f.host.attach(identity);
    const read = { handleId, operationId: "read", retainOutcome: false,
      command: { channel: "rpc" as const, command: { type: "get_state" } } };
    await f.host.request(read);
    await vi.waitFor(async () => expect((await f.host.request(read)).status).toBe("completed"));
    expect(await f.host.abandonObservation(read)).toBe("released");
    expect(await f.host.abandonObservation(read)).toBe("released");
    const missing = { handleId, operationId: "missing" };
    expect(await f.host.abandonObservation(missing)).toBe("released");
    expect(await f.host.abandonObservation(missing)).toBe("released");
    const commands = [
      { channel: "rpc" as const, command: { type: "get_state" } },
      { channel: "rpc" as const, command: { type: "prompt", message: "late mutation" } },
      { channel: "companion" as const, command: { type: "begin_stop" } },
    ];
    for (const command of commands) for (const retainOutcome of [false, true])
      await expect(f.host.request({ ...missing, retainOutcome, command }))
        .rejects.toMatchObject({ code: "pi_native_operation_abandoned", delivery: "sent_outcome_unknown" });
    expect(f.requests).toHaveBeenCalledTimes(1);
    expect(f.bridgeRequests).not.toHaveBeenCalled();
    expect(f.host.snapshot().blockers).not.toContain("unsettled_outcome");
  });

  it("keeps unknown-read cancellation markers bounded without evicting late-request fences", async () => {
    const f = fixture(), { handleId } = await f.host.attach(identity);
    for (let index = 0; index < 4096; index++)
      expect(await f.host.abandonObservation({ handleId, operationId: `missing-${index}` })).toBe("released");
    await expect(f.host.abandonObservation({ handleId, operationId: "overflow" }))
      .rejects.toMatchObject({ code: "pi_native_observation_abandon_capacity", delivery: "sent_outcome_unknown" });
    expect(await f.host.abandonObservation({ handleId, operationId: "missing-0" })).toBe("released");
    await expect(f.host.request({ handleId, operationId: "missing-0", retainOutcome: false,
      command: { channel: "rpc", command: { type: "get_state" } } })).rejects.toThrow("pi_native_operation_abandoned");
    const read = { handleId, operationId: "actual-read", retainOutcome: false,
      command: { channel: "rpc" as const, command: { type: "get_state" } } };
    await f.host.request(read);
    await vi.waitFor(async () => expect((await f.host.request(read)).status).toBe("completed"));
    expect(await f.host.abandonObservation(read)).toBe("released");
    await f.host.release({ handleId });
    expect(["retired", "absent"]).toContain(await f.host.retireSession(identity));
    const replacement = await f.host.attach(identity);
    expect(replacement.handleId).not.toBe(handleId);
    await expect(f.host.request({ ...read, operationId: "missing-0" })).rejects.toThrow("pi_native_session_unknown");
    expect(await f.host.abandonObservation({ handleId: replacement.handleId, operationId: "fresh" })).toBe("released");
  });

  it("requires current authority and valid IDs before fencing unknown observations", async () => {
    const f = fixture(), { handleId } = await f.host.attach(identity);
    const lost = { assertCurrent: () => { throw new Error("authority lost"); }, assertAdmission() {} };
    await expect(f.host.abandonObservation({ handleId, operationId: "read" }, undefined, lost)).rejects.toThrow("authority lost");
    for (const operationId of ["", "x".repeat(513)])
      await expect(f.host.abandonObservation({ handleId, operationId })).rejects.toThrow("pi_native_operation_identity_invalid");
    const read = { handleId, operationId: "read", retainOutcome: false,
      command: { channel: "rpc" as const, command: { type: "get_state" } } };
    await f.host.request(read);
    await vi.waitFor(async () => expect((await f.host.request(read)).status).toBe("completed"));
    expect(await f.host.outcome(read)).toMatchObject({ status: "completed" });
    expect(f.requests).toHaveBeenCalledTimes(1);
  });

  it.each(["retained_read", "retained_mutation", "nonretained_mutation"] as const)("never abandons %s through observation cleanup", async kind => {
    const f = fixture(), pending = deferred<unknown>(), { handleId } = await f.host.attach(identity);
    f.bridgeRequests.mockImplementation(() => pending.promise);
    const input = { handleId, operationId: "protected", retainOutcome: kind !== "nonretained_mutation",
      command: { channel: "companion" as const, command: kind === "retained_read" ? { type: "snapshot" } : { type: "set_policy", policy: { mode: "ask" } } } };
    await f.host.request(input);
    await expect(f.host.abandonObservation(input)).rejects.toThrow("pi_native_observation_abandon_denied");
    expect(await f.host.outcome(input)).toEqual({ status: "pending" });
    pending.resolve({ accepted: true });
    await vi.waitFor(async () => expect((await f.host.request(input)).status).toBe("completed"));
    await expect(f.host.abandonObservation(input)).rejects.toThrow("pi_native_observation_abandon_denied");
    expect(await f.host.outcome(input)).toEqual({ status: "completed", result: { accepted: true } });
    await f.host.acknowledgeOperation(input);
    await expect(f.host.abandonObservation(input)).rejects.toThrow("pi_native_observation_abandon_denied");
  });

  it("attaches to an exact live observation gap for controls without starting, cancelling, or observing work", async () => {
    const f = fixture({ maximumEventBytes: 1024 });
    expect(await f.host.attachForControl(identity)).toBeNull();
    expect(f.launch).not.toHaveBeenCalled();
    const session = await f.host.attach(identity);
    await expect(f.host.attachForControl(identity)).rejects.toThrow("pi_native_observation_recovery_not_required");
    f.emit({ type: "agent_start" });
    f.emit({ type: "session_info_changed", name: "overflow".repeat(200) });
    await expect(f.host.attachForControl({ ...identity, sessionId: "wrong" })).rejects.toThrow("pi_native_session_identity_mismatch");
    expect(await f.host.attachForControl(identity)).toMatchObject({ handleId: session.handleId, generation: session.generation });
    expect(f.requests).not.toHaveBeenCalled();
    expect(f.bridgeRequests).not.toHaveBeenCalled();
    expect(f.respondUI).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    const denied = [
      { channel: "rpc" as const, command: { type: "prompt", message: "new work" } },
      { channel: "rpc" as const, command: { type: "extension_ui_response", id: "ui", value: "yes" } },
      { channel: "companion" as const, command: { type: "resolve_tool_approval", id: "approval", approved: true } },
      { channel: "companion" as const, command: { type: "resolve_agent_tool", id: "call", result: { content: [] } } },
      { channel: "companion" as const, command: { type: "set_policy", policy: { mode: "full" } } },
      { channel: "companion" as const, command: { type: "configure_agent_tools", tools: [] } },
    ];
    for (const [index, command] of denied.entries()) await expect(f.host.request({ handleId: session.handleId, operationId: `deny-${index}`, retainOutcome: true, command }))
      .rejects.toMatchObject({ code: "pi_native_recovery_control_only", delivery: "not_sent" });
    await f.host.request({ handleId: session.handleId, operationId: "snapshot", retainOutcome: true, command: { channel: "companion", command: { type: "snapshot" } } });
    expect(await settled(f.host, session.handleId, "snapshot")).toMatchObject({ status: "completed" });
    await expect(f.host.observe({ handleId: session.handleId, afterSequence: 0 })).rejects.toThrow("pi_native_observation_continuity_lost");
    await f.host.release({ handleId: session.handleId });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.respondUI).not.toHaveBeenCalled();
  });

  it("cancels gap-hidden waits only for an explicit Stop, then permits session-specific draining", async () => {
    const f = fixture({ maximumEventBytes: 1024 }), session = await f.host.attach(identity);
    f.emit({ type: "agent_start" });
    f.emit({ type: "session_info_changed", name: "overflow".repeat(200) });
    f.emit({ type: "extension_ui_request", id: "dialog", method: "input", title: "Value" });
    f.emit({ type: "tool_approval_requested", id: "approval", toolName: "read", parameters: {} }, "companion");
    f.emit({ type: "agent_tool_call", id: "call", toolCallId: "tool", name: "sedes", arguments: {}, assistantEntryId: "assistant", userEntryId: "user" }, "companion");
    await f.host.release({ handleId: session.handleId });
    expect(await f.host.retireSession(identity)).toBe("busy");
    await expect(f.host.attachForDrain(identity)).rejects.toThrow("pi_native_observation_recovery_busy");
    await f.host.attachForControl(identity);
    expect(f.respondUI).not.toHaveBeenCalled();
    expect(f.bridgeRequests).not.toHaveBeenCalled();
    f.bridgeRequests.mockImplementation(async command => {
      if ((command as { type: string }).type === "begin_stop") {
        f.emit({ type: "tool_approval_closed", id: "approval" }, "companion");
        f.emit({ type: "agent_tool_cancelled", id: "call" }, "companion");
      }
      return idleState;
    });
    f.requests.mockImplementation(async command => {
      if ((command as { type: string }).type === "abort") f.emit({ type: "agent_end", messages: [], willRetry: false });
      return idleState;
    });
    for (const [channel, type] of [["companion", "begin_stop"], ["rpc", "clear_queue"], ["rpc", "abort"], ["companion", "end_stop"]] as const) {
      await f.host.request({ handleId: session.handleId, operationId: type, retainOutcome: true, command: { channel, command: { type } } });
      expect(await settled(f.host, session.handleId, type)).toMatchObject({ status: "completed" });
      await f.host.acknowledgeOperation({ handleId: session.handleId, operationId: type });
    }
    expect(f.respondUI).toHaveBeenCalledExactlyOnceWith({ type: "extension_ui_response", id: "dialog", cancelled: true });
    expect(f.host.snapshot().blockers).not.toContain("pending_interaction");
    expect(f.host.snapshot().blockers).not.toContain("active_work");
    expect(f.host.snapshot().blockers).toContain("unknown_state");
    expect(f.close).not.toHaveBeenCalled();
    await f.host.release({ handleId: session.handleId });
    expect(await f.host.attachForDrain(identity)).toMatchObject({ closed: true, observationGap: true });
    const page = await f.host.observe({ handleId: session.handleId, afterSequence: 0 });
    await f.host.acknowledge({ handleId: session.handleId, throughSequence: page.throughSequence });
    await f.host.acknowledgeObservationGap({ handleId: session.handleId, generation: session.generation, throughSequence: page.throughSequence });
    await f.host.release({ handleId: session.handleId });
    expect(await f.host.retireSession(identity)).toBe("retired");
    expect(f.launch).toHaveBeenCalledTimes(1);
  });

  it("preserves cancellation uncertainty and the pending dialog when explicit Stop loses its UI reply", async () => {
    const f = fixture({ maximumEventBytes: 128 }), session = await f.host.attach(identity);
    f.emit({ type: "session_info_changed", name: "overflow".repeat(200) });
    f.emit({ type: "extension_ui_request", id: "dialog", method: "input", title: "Value" });
    await f.host.attachForControl(identity);
    f.respondUI.mockRejectedValueOnce(new Error("UI transport failed"));
    await f.host.request({ handleId: session.handleId, operationId: "stop", retainOutcome: true, command: { channel: "companion", command: { type: "begin_stop" } } });
    expect(await settled(f.host, session.handleId, "stop")).toMatchObject({ status: "failed", failure: { delivery: "sent_outcome_unknown" } });
    expect(f.host.snapshot().blockers).toContain("pending_interaction");
    await f.host.release({ handleId: session.handleId });
    await expect(f.host.attachForDrain(identity)).rejects.toThrow("pi_native_observation_recovery_busy");
    expect(f.close).not.toHaveBeenCalled();
  });

  it("recovers a closed observation gap only after applying its retained prefix, without consuming operation outcomes", async () => {
    const f = fixture({ maximumEventBytes: 1024 }), pending = deferred<unknown>();
    const session = await f.host.attach(identity);
    f.requests.mockImplementation(() => pending.promise);
    await f.host.request({ handleId: session.handleId, operationId: "uncertain", retainOutcome: true,
      command: { channel: "rpc", command: { type: "prompt", message: "work" } } });
    f.emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "retained partial" } });
    f.emit({ type: "extension_ui_request", id: "choice", method: "confirm", title: "Choose" });
    f.emit({ type: "session_info_changed", name: "overflow".repeat(200) });
    const gap = { handleId: session.handleId, generation: session.generation, throughSequence: 2 };
    await expect(f.host.acknowledgeObservationGap(gap)).rejects.toThrow("pi_native_observation_recovery_not_ready");
    await f.host.release(session);
    f.ended.reject(new Error("native process exited"));
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    const drain = await f.host.attachForDrain(identity);
    expect(drain).toMatchObject({ ...gap, closed: true, observationGap: true, retainedOperationIds: ["uncertain"] });
    expect(f.host.snapshot().blockers).toContain("unknown_state");
    expect(f.host.snapshot().blockers).not.toContain("pending_interaction");
    await expect(f.host.acknowledgeObservationGap({ ...gap, generation: "wrong" })).rejects.toThrow("pi_native_session_identity_mismatch");
    await expect(f.host.acknowledgeObservationGap(gap)).rejects.toThrow("pi_native_observation_recovery_unapplied");
    const page = await f.host.observe({ handleId: session.handleId, afterSequence: 0 });
    expect(page.events.map(event => event.payload.type)).toEqual(["message_snapshot", "extension_ui_request"]);
    expect(page.events[0]?.payload.text).toBe("retained partial");
    await f.host.acknowledge({ handleId: session.handleId, throughSequence: page.throughSequence });
    await expect(f.host.acknowledgeObservationGap({ ...gap, throughSequence: 1 })).rejects.toThrow("pi_native_observation_recovery_unapplied");
    await f.host.acknowledgeObservationGap(gap);
    expect(f.host.snapshot().blockers).not.toContain("unknown_state");
    expect(await f.host.outcome({ handleId: session.handleId, operationId: "uncertain" })).toEqual({ status: "failed",
      failure: { code: "pi_native_session_ended", delivery: "sent_outcome_unknown" } });
    await f.host.release(session);
    expect(await f.host.retireSession(identity)).toBe("undelivered");
    await f.host.acknowledgeOperation({ handleId: session.handleId, operationId: "uncertain" });
    expect(await f.host.retireSession(identity)).toBe("retired");
    expect(f.launch).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true });
  });

  it("proves an overflowed live session idle and closes only that session before exposing gap recovery", async () => {
    const f = fixture({ maximumEventBytes: 1024 });
    const session = await f.host.attach(identity), firstEvents = f.launch.mock.calls[0]![0].onEvent!;
    const otherIdentity = { ...identity, sessionId: "other", sessionFile: "/workspace/other.jsonl" };
    const other = await f.host.attach(otherIdentity);
    firstEvents({ kind: "rpc", payload: { type: "session_info_changed", name: "retained" } });
    firstEvents({ kind: "rpc", payload: { type: "session_info_changed", name: "overflow".repeat(200) } });
    await f.host.release(session);
    await expect(f.host.attach(identity)).rejects.toThrow("pi_native_observation_continuity_lost");
    const drain = await f.host.attachForDrain(identity);
    expect(drain).toMatchObject({ handleId: session.handleId, closed: true, observationGap: true });
    expect(f.requests).toHaveBeenCalledWith({ type: "get_state" }, { signal: undefined });
    expect(f.bridgeRequests).toHaveBeenCalledWith({ type: "snapshot" }, { signal: undefined });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
    f.emit({ type: "session_info_changed", name: "peer still observed" });
    expect((await f.host.observe({ handleId: other.handleId, afterSequence: 0 })).events[0]?.payload.name).toBe("peer still observed");
    await f.host.request({ handleId: other.handleId, operationId: "peer", retainOutcome: true,
      command: { channel: "rpc", command: { type: "prompt", message: "continue" } } });
    expect(await settled(f.host, other.handleId, "peer")).toMatchObject({ status: "completed" });
    const page = await f.host.observe({ handleId: session.handleId, afterSequence: 0 });
    await f.host.acknowledge({ handleId: session.handleId, throughSequence: page.throughSequence });
    await f.host.acknowledgeObservationGap({ handleId: session.handleId, generation: session.generation, throughSequence: page.throughSequence });
    await f.host.release(session);
    expect(await f.host.retireSession(identity)).toBe("retired");
    expect(f.close).toHaveBeenCalledTimes(1);
    expect((await f.host.attach(identity)).handleId).not.toBe(session.handleId);
    expect(f.launch).toHaveBeenCalledTimes(3);
  });

  it.each(["active", "interaction", "pending_operation", "queued", "streaming", "compacting", "companion_busy", "late_interaction"] as const)(
    "refuses live gap recovery while native work is %s", async reason => {
      const f = fixture({ maximumEventBytes: 1024 }), pending = deferred<unknown>();
      const session = await f.host.attach(identity);
      if (reason === "active") f.emit({ type: "agent_start" });
      if (reason === "interaction") f.emit({ type: "tool_approval_requested", id: "approval", toolName: "read", parameters: {} }, "companion");
      if (reason === "pending_operation") {
        f.requests.mockImplementation(() => pending.promise);
        await f.host.request({ handleId: session.handleId, operationId: "pending", retainOutcome: true,
          command: { channel: "rpc", command: { type: "prompt", message: "work" } } });
      }
      if (reason === "queued") f.requests.mockResolvedValue({ ...idleState, pendingMessageCount: 1 });
      if (reason === "streaming") f.requests.mockResolvedValue({ ...idleState, isStreaming: true });
      if (reason === "compacting") f.requests.mockResolvedValue({ ...idleState, isCompacting: true });
      if (reason === "companion_busy") f.bridgeRequests.mockResolvedValue({ ...idleState, isIdle: false });
      if (reason === "late_interaction") f.requests.mockImplementation(async () => {
        f.emit({ type: "tool_approval_requested", id: "late", toolName: "read", parameters: {} }, "companion");
        return idleState;
      });
      f.emit({ type: "session_info_changed", name: "overflow".repeat(200) });
      await f.host.release(session);
      await expect(f.host.attachForDrain(identity)).rejects.toThrow("pi_native_observation_recovery_busy");
      expect(f.close).not.toHaveBeenCalled();
      expect(f.releaseWriter).not.toHaveBeenCalled();
      expect(f.host.snapshot().blockers).toContain("unknown_state");
      await expect(f.host.observe({ handleId: session.handleId, afterSequence: 0 })).rejects.toThrow("pi_native_observation_continuity_lost");
      pending.resolve({ ok: true });
    });

  it("retains a gap when process cleanup fails and retries recovery only after cleanup is proven", async () => {
    const f = fixture({ maximumEventBytes: 128 }), session = await f.host.attach(identity);
    f.emit({ type: "session_info_changed", name: "overflow".repeat(200) });
    await f.host.release(session);
    f.close.mockRejectedValueOnce(new Error("process still alive"));
    await expect(f.host.attachForDrain(identity)).rejects.toThrow("pi_native_cleanup_unproven");
    await expect(f.host.acknowledgeObservationGap({ handleId: session.handleId, generation: session.generation, throughSequence: 0 }))
      .rejects.toThrow("pi_native_observation_recovery_not_ready");
    expect(f.releaseWriter).not.toHaveBeenCalled();
    expect(await f.host.attachForDrain(identity)).toMatchObject({ closed: true, observationGap: true, throughSequence: 0 });
    await f.host.acknowledgeObservationGap({ handleId: session.handleId, generation: session.generation, throughSequence: 0 });
    await f.host.release(session);
    expect(await f.host.retireSession(identity)).toBe("retired");
  });

  it("budgets unfinished stream accumulators independently for each native session", async () => {
    const f = fixture({ maximumEventBytes: 1024 });
    const first = await f.host.attach(identity);
    f.emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a".repeat(300) } });
    const second = await f.host.attach({ ...identity, sessionId: "second", sessionFile: "/workspace/second.jsonl" });
    f.emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b".repeat(300) } });
    expect((await f.host.observe({ handleId: first.handleId, afterSequence: 0 })).events[0]?.payload.text).toBe("a".repeat(300));
    expect((await f.host.observe({ handleId: second.handleId, afterSequence: 0 })).events[0]?.payload.text).toBe("b".repeat(300));
    expect(f.host.snapshot().blockers).not.toContain("unknown_state");
  });

  it("does not let another session's retained output consume this session's observation budget", async () => {
    const f = fixture({ maximumEventBytes: 1024 });
    const first = await f.host.attach(identity);
    const firstEvents = f.launch.mock.calls[0]![0].onEvent!;
    firstEvents({ kind: "rpc", payload: { type: "session_info_changed", name: "a".repeat(650) } });
    const secondIdentity = { ...identity, sessionId: "second", sessionFile: "/workspace/second.jsonl" };
    const second = await f.host.attach(secondIdentity);
    f.emit({ type: "session_info_changed", name: "b".repeat(400) });
    const page = await f.host.observe({ handleId: second.handleId, afterSequence: 0 });
    expect(page.events).toHaveLength(1);
    firstEvents({ kind: "rpc", payload: { type: "session_info_changed", name: "overflow".repeat(200) } });
    await expect(f.host.observe({ handleId: first.handleId, afterSequence: 0 })).rejects.toThrow("pi_native_observation_continuity_lost");
    f.emit({ type: "session_info_changed", name: "still usable" });
    const next = await f.host.observe({ handleId: second.handleId, afterSequence: page.throughSequence });
    expect(next.events[0]?.payload.name).toBe("still usable");
    await f.host.acknowledge({ handleId: second.handleId, throughSequence: next.throughSequence });
    await f.host.request({ handleId: second.handleId, operationId: "send", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "works" } } });
    expect(await settled(f.host, second.handleId, "send")).toMatchObject({ status: "completed" });
    await f.host.acknowledgeOperation({ handleId: second.handleId, operationId: "send" });
    f.requests.mockResolvedValue({ ...idleState, ...secondIdentity });
    f.bridgeRequests.mockResolvedValue({ ...idleState, ...secondIdentity });
    await f.host.release({ handleId: second.handleId });
    expect(await f.host.retireSession(secondIdentity)).toBe("retired");
    expect(await f.host.retireSession(identity)).toBe("busy");
  });

  it("keeps Stop confirmation stable while nonretained snapshot reads are pending, complete, and consumed", async () => {
    const f = fixture(), pending = deferred<unknown>();
    const { handleId } = await f.host.attach(identity);
    f.bridgeRequests.mockImplementation(() => pending.promise);
    const before = f.host.snapshot();
    const input = { handleId, operationId: "observe", retainOutcome: false,
      command: { channel: "companion" as const, command: { type: "snapshot" } } };
    await f.host.request(input);
    expect(f.host.snapshot()).toMatchObject({ revision: before.revision, state: "idle", blockers: [] });
    pending.resolve(idleState);
    await vi.waitFor(async () => expect((await f.host.request(input)).status).toBe("completed"));
    expect(f.host.snapshot()).toMatchObject({ revision: before.revision, state: "idle", blockers: [] });
    expect(await f.host.outcome(input)).toMatchObject({ status: "completed" });
    expect(f.host.snapshot().revision).toBe(before.revision);
    await f.host.stop({ expectedRevision: before.revision, force: false });
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it.each(["retained_read", "unretained_mutation"] as const)("keeps %s in Stop confirmation obligations", async kind => {
    const f = fixture(), pending = deferred<unknown>();
    const { handleId } = await f.host.attach(identity);
    f.requests.mockImplementation(() => pending.promise);
    const before = f.host.snapshot();
    await f.host.request({ handleId, operationId: "obligation", retainOutcome: kind === "retained_read",
      command: { channel: "rpc", command: { type: kind === "retained_read" ? "get_state" : "abort" } } });
    expect(f.host.snapshot().revision).not.toBe(before.revision);
    expect(f.host.snapshot().blockers).toContain("unsettled_outcome");
    await expect(f.host.stop({ expectedRevision: before.revision, force: true })).rejects.toThrow("pi_native_confirmation_stale");
    pending.resolve({ ok: true });
  });

  it("resolves the execution-host session directory without admitting or launching native work", async () => {
    const f = fixture();
    f.host.freezeAdmission();
    expect(await f.host.resolveSessionDirectory({ cwd: identity.cwd })).toBe("/canonical/sessions");
    expect(f.store.resolveSessionDirectory).toHaveBeenCalledWith(identity.cwd, undefined);
    expect(f.store.create).not.toHaveBeenCalled();
    expect(f.store.readHistory).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("rechecks directory-read authority after asynchronous filesystem resolution", async () => {
    const f = fixture(), resolved = deferred<string>();
    f.store.resolveSessionDirectory.mockImplementation(() => resolved.promise);
    let current = true;
    const reading = f.host.resolveSessionDirectory({ cwd: identity.cwd }, undefined, {
      assertCurrent() { if (!current) throw new PiNativeError("pi_native_controller_stale"); }, assertAdmission() { throw new Error("not a mutation"); },
    });
    current = false; resolved.resolve("/canonical/sessions");
    await expect(reading).rejects.toThrow("pi_native_controller_stale");
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("keeps Stop confirmation stable during one stream while distinguishing a later run", async () => {
    const f = fixture();
    await f.host.attach(identity);
    f.emit({ type: "agent_start" });
    f.emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first" } });
    const first = f.host.snapshot();
    for (let index = 0; index < 100; index++)
      f.emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next" } });
    expect(f.host.snapshot().revision).toBe(first.revision);
    f.emit({ type: "agent_end", messages: [], willRetry: false });
    f.emit({ type: "agent_start" });
    expect(f.host.snapshot().revision).not.toBe(first.revision);
    const beforeClose = vi.fn(async () => {});
    await expect(f.host.stop({ expectedRevision: first.revision, force: true }, undefined, undefined, beforeClose)).rejects.toThrow("pi_native_confirmation_stale");
    expect(beforeClose).not.toHaveBeenCalled();
    const next = f.host.snapshot();
    f.emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "more" } });
    await f.host.stop({ expectedRevision: next.revision, force: true }, undefined, undefined, beforeClose);
    expect(beforeClose).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it.each(["session", "operation", "interaction"] as const)("invalidates Stop confirmation for newly owned %s", async reason => {
    const f = fixture(), { handleId } = await f.host.attach(identity);
    const before = f.host.snapshot();
    if (reason === "session") await f.host.attach({ ...identity, sessionId: "second", sessionFile: "/workspace/second.jsonl" });
    if (reason === "operation") await f.host.request({ handleId, operationId: "new", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "work" } } });
    if (reason === "interaction") f.emit({ type: "tool_approval_requested", id: "new", toolName: "read", parameters: {} }, "companion");
    expect(f.host.snapshot().revision).not.toBe(before.revision);
    const beforeClose = vi.fn(async () => {});
    await expect(f.host.stop({ expectedRevision: before.revision, force: true }, undefined, undefined, beforeClose)).rejects.toThrow("pi_native_confirmation_stale");
    expect(beforeClose).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it("preserves actionable writer cleanup failures as definitely unsent startup", async () => {
    const cause = new PiSessionWriterCleanupRequiredError();
    const f = fixture({ acquireWriter: async () => { throw cause; } });
    await expect(f.host.attach(identity)).rejects.toMatchObject({ code: cause.code, delivery: "not_sent", cause });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.host.snapshot().retainedSessions).toEqual([]);
  });

  it("drains retained evidence by exact identity after execution environment changes without relaunching", async () => {
    const f = fixture();
    expect(await f.host.attachForDrain(identity)).toBeNull();
    expect(f.launch).not.toHaveBeenCalled();
    const { handleId } = await f.host.attach({ ...identity, executionEnvironment: { MODE: { kind: "literal", value: "old" } } });
    f.emit({ type: "state_changed" }, "companion");
    await f.host.release({ handleId });
    await expect(f.host.attach({ ...identity, executionEnvironment: { MODE: { kind: "literal", value: "new" } } })).rejects.toThrow("pi_native_session_configuration_conflict");
    await expect(f.host.attachForDrain({ ...identity, cwd: "/other" })).rejects.toThrow("pi_native_session_identity_mismatch");
    const drain = await f.host.attachForDrain(identity);
    expect(drain).toMatchObject({ handleId, closed: false });
    await expect(f.host.request({ handleId, operationId: "mutation", retainOutcome: true,
      command: { channel: "rpc", command: { type: "prompt", message: "no" } } })).rejects.toMatchObject({ code: "pi_native_drain_read_only", delivery: "not_sent" });
    await f.host.request({ handleId, operationId: "snapshot", retainOutcome: true, command: { channel: "companion", command: { type: "snapshot" } } });
    expect(await settled(f.host, handleId, "snapshot")).toMatchObject({ status: "completed" });
    await f.host.acknowledgeOperation({ handleId, operationId: "snapshot" });
    const page = await f.host.observe({ handleId, afterSequence: 0 });
    expect(page.events).toHaveLength(1);
    await f.host.acknowledge({ handleId, throughSequence: page.throughSequence });
    await f.host.release({ handleId });
    expect(await f.host.retireSession(identity)).toBe("retired");
    await f.host.attach({ ...identity, executionEnvironment: { MODE: { kind: "literal", value: "new" } } });
    expect(f.launch).toHaveBeenCalledTimes(2);
  });

  it("awaits cleanup before closed drainage and preserves terminal evidence while clearing dead interactions", async () => {
    const f = fixture(), closing = deferred<void>(), pending = deferred<unknown>();
    const { handleId } = await f.host.attach(identity);
    f.close.mockImplementation(() => closing.promise);
    f.requests.mockImplementation(() => pending.promise);
    await f.host.request({ handleId, operationId: "accepted", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "work" } } });
    f.emit({ type: "extension_ui_request", id: "choice", method: "confirm", title: "Choose" });
    await f.host.release({ handleId });
    f.ended.reject(new Error("child exited"));
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    let drained = false;
    const drainage = f.host.attachForDrain(identity).then(value => { drained = true; return value; });
    await Promise.resolve();
    expect(drained).toBe(false);
    closing.resolve();
    expect(await drainage).toMatchObject({ handleId, closed: true, retainedOperationIds: ["accepted"] });
    expect(f.host.snapshot().blockers).not.toContain("pending_interaction");
    expect(await f.host.outcome({ handleId, operationId: "accepted" })).toEqual({ status: "failed", failure: { code: "pi_native_session_ended", delivery: "sent_outcome_unknown" } });
    const page = await f.host.observe({ handleId, afterSequence: 0 });
    expect(page.closed).toBe(true);
    expect(page.events.map(event => event.payload.type)).toEqual(["extension_ui_request", "failure"]);
    await f.host.acknowledge({ handleId, throughSequence: page.throughSequence });
    await f.host.acknowledgeOperation({ handleId, operationId: "accepted" });
    await f.host.release({ handleId });
    expect(await f.host.retireSession(identity)).toBe("retired");
    pending.resolve({ disposition: "started" });
    await Promise.resolve();
    expect(f.host.snapshot().retainedSessions).toEqual([]);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });

  it("coalesces long text, reasoning, and tool streams without advancing acknowledgement or losing durable events", async () => {
    const f = fixture(), { handleId } = await f.host.attach(identity);
    f.emit({ type: "agent_start" });
    f.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    const stream = (from: number, count: number) => {
      for (let index = from; index < from + count; index++) {
        for (const [contentIndex, type, delta] of [[0, "text_delta", index % 2 ? "\udc9a" : "\ud83d"], [1, "thinking_delta", "β"], [2, "toolcall_delta", "x"]] as const)
          f.emit({ type: "message_update", usage: {}, assistantMessageEvent: { type, contentIndex, delta } });
      }
    };
    stream(0, 10000);
    f.emit({ type: "tool_approval_requested", id: "approval", toolName: "read", parameters: {} }, "companion");
    await expect(f.host.acknowledge({ handleId, throughSequence: 30002 })).rejects.toThrow("pi_native_acknowledgement_invalid");
    const first = await f.host.observe({ handleId, afterSequence: 0 });
    expect(first.events).toHaveLength(6);
    expect(first.retainedAfterSequence).toBe(0);
    stream(10000, 10000);
    await f.host.acknowledge({ handleId, throughSequence: first.throughSequence });
    const second = await f.host.observe({ handleId, afterSequence: first.throughSequence });
    expect(second.events).toHaveLength(3);
    expect(second.events.every(event => event.kind === "stream")).toBe(true);
    expect(second.events.map(event => event.payload.text)).toEqual(["💚".repeat(10000), "β".repeat(20000), "x".repeat(20000)]);
    expect(f.host.snapshot().blockers).not.toContain("unknown_state");
    expect(f.host.snapshot().blockers).toContain("pending_interaction");
    f.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "complete" }] } });
    const terminal = await f.host.observe({ handleId, afterSequence: second.throughSequence });
    expect(terminal.events.map(event => event.payload.type)).toEqual(["message_end"]);
    await f.host.acknowledge({ handleId, throughSequence: terminal.throughSequence });
    f.emit({ type: "tool_approval_closed", id: "approval" }, "companion");
    f.emit({ type: "agent_end", messages: [], willRetry: false });
    const final = await f.host.observe({ handleId, afterSequence: terminal.throughSequence });
    await f.host.acknowledge({ handleId, throughSequence: final.throughSequence });
    await f.host.request({ handleId, operationId: "next", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "next" } } });
    expect(await settled(f.host, handleId, "next")).toMatchObject({ status: "completed" });
    await f.host.acknowledgeOperation({ handleId, operationId: "next" });
    await f.host.release({ handleId });
    expect(await f.host.retireSession(identity)).toBe("retired");
  });

  it("coalesces tool progress and bash output while preserving their final evidence", async () => {
    const f = fixture(), { handleId } = await f.host.attach(identity);
    f.emit({ type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: {} });
    for (let index = 0; index < 20000; index++) {
      f.emit({ type: "tool_execution_update", toolCallId: "tool", toolName: "read", args: {}, partialResult: { text: String(index) } });
      f.emit({ type: "bash_execution_update", id: "bash", delta: "x" });
    }
    f.emit({ type: "tool_execution_end", toolCallId: "tool", toolName: "read", result: { text: "done" }, isError: false });
    const first = await f.host.observe({ handleId, afterSequence: 0 });
    expect(first.events.map(event => event.payload.type)).toEqual(["tool_execution_start", "tool_execution_update", "bash_snapshot", "tool_execution_end"]);
    expect(first.events[1]?.payload.partialResult).toEqual({ text: "19999" });
    expect(first.events[2]?.payload.text).toBe("x".repeat(20000));
    await f.host.acknowledge({ handleId, throughSequence: first.throughSequence });
    f.emit({ type: "bash_execution_update", id: "bash", delta: "next" });
    const second = await f.host.observe({ handleId, afterSequence: first.throughSequence });
    expect(second.events[0]?.payload.text).toBe("next");
    expect(second.events[0]?.payload.streamId).not.toBe(first.events[2]?.payload.streamId);
  });

  it("classifies malformed native commands as unsent before reserving an operation", async () => {
    const f = fixture(), { handleId } = await f.host.attach(identity);
    await expect(f.host.request({ handleId, operationId: "invalid", retainOutcome: true,
      command: { channel: "rpc", command: { type: "prompt", message: 3 } } })).rejects.toMatchObject({ code: "pi_native_command_invalid", delivery: "not_sent" });
    expect((await f.host.attach(identity)).retainedOperationIds).toEqual([]);
    expect(f.requests).not.toHaveBeenCalled();
  });

  it("proves absent residency without launching and rejects conflicting native identities", async () => {
    const f = fixture();
    expect(await f.host.retireSession(identity)).toBe("absent");
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.store.readHistory).not.toHaveBeenCalled();
    await f.host.attach(identity);
    await expect(f.host.retireSession({ ...identity, cwd: "/different" })).rejects.toThrow("pi_native_session_identity_mismatch");
    await expect(f.host.retireSession({ ...identity, sessionFile: "/different.jsonl" })).rejects.toThrow("pi_native_session_identity_mismatch");
    expect(await f.host.retireSession(identity)).toBe("busy");
    expect(f.close).not.toHaveBeenCalled();
  });

  it("awaits native process and writer retirement before reporting success", async () => {
    const f = fixture(), closing = deferred<void>();
    const { handleId } = await f.host.attach(identity);
    f.close.mockImplementation(() => closing.promise);
    await f.host.release({ handleId });
    let retired = false;
    const retirement = f.host.retireSession(identity).then(result => { retired = true; return result; });
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    expect(retired).toBe(false);
    expect(f.releaseWriter).not.toHaveBeenCalled();
    closing.resolve();
    expect(await retirement).toBe("retired");
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
    expect(await f.host.retireSession(identity)).toBe("absent");
    expect(f.host.snapshot().retainedSessions).toEqual([]);
  });

  it.each(["active", "interaction", "pending"] as const)("does not retire %s provider work", async reason => {
    const f = fixture(), pending = deferred<unknown>();
    const { handleId } = await f.host.attach(identity);
    if (reason === "active") f.emit({ type: "agent_start" });
    if (reason === "interaction") f.emit({ type: "extension_ui_request", id: "choice", method: "confirm", title: "Choose" });
    if (reason === "pending") {
      f.requests.mockImplementation(() => pending.promise);
      await f.host.request({ handleId, operationId: "active", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "work" } } });
    }
    await f.host.release({ handleId });
    expect(await f.host.retireSession(identity)).toBe("busy");
    expect(f.close).not.toHaveBeenCalled();
    pending.resolve({ accepted: true });
  });

  it.each(["output", "receipt"] as const)("keeps unapplied %s available for residency drain", async reason => {
    const f = fixture();
    const { handleId } = await f.host.attach(identity);
    if (reason === "output") f.emit({ type: "state_changed" }, "companion");
    else {
      await f.host.request({ handleId, operationId: "done", retainOutcome: true, command: { channel: "rpc", command: { type: "get_state" } } });
      await settled(f.host, handleId, "done");
    }
    await f.host.release({ handleId });
    expect(await f.host.retireSession(identity)).toBe("undelivered");
    expect(f.close).not.toHaveBeenCalled();
    expect((await f.host.attach(identity)).handleId).toBe(handleId);
  });

  it("checks native queued work before retiring an otherwise idle host", async () => {
    const f = fixture();
    const { handleId } = await f.host.attach(identity);
    f.requests.mockResolvedValue({ ...idleState, pendingMessageCount: 1 });
    await f.host.release({ handleId });
    expect(await f.host.retireSession(identity)).toBe("busy");
    expect(f.close).not.toHaveBeenCalled();
    f.requests.mockResolvedValue(idleState);
    expect(await f.host.retireSession(identity)).toBe("retired");
  });

  it("fences new mutations and rechecks output arriving during the native idle probe", async () => {
    const f = fixture(), probe = deferred<unknown>();
    const { handleId } = await f.host.attach(identity);
    f.requests.mockImplementation(() => probe.promise);
    await f.host.release({ handleId });
    const retirement = f.host.retireSession(identity);
    await vi.waitFor(() => expect(f.requests).toHaveBeenCalledTimes(1));
    await expect(f.host.request({ handleId, operationId: "racing", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "later" } } })).rejects.toThrow("pi_native_session_retiring");
    f.emit({ type: "state_changed" }, "companion");
    probe.resolve(idleState);
    expect(await retirement).toBe("undelivered");
    expect(f.close).not.toHaveBeenCalled();
  });

  it("preserves failed residency cleanup and retries the same native owner", async () => {
    const f = fixture();
    const { handleId } = await f.host.attach(identity);
    f.close.mockRejectedValueOnce(new Error("child survived"));
    await f.host.release({ handleId });
    await expect(f.host.retireSession(identity)).rejects.toThrow("pi_native_cleanup_unproven");
    expect(f.releaseWriter).not.toHaveBeenCalled();
    expect(f.host.snapshot().blockers).toContain("cleanup_unproven");
    expect(await f.host.retireSession(identity)).toBe("retired");
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
  });

  it("retains final output discovered while the process is closing", async () => {
    const f = fixture();
    const { handleId } = await f.host.attach(identity);
    f.close.mockImplementation(async () => { f.emit({ type: "state_changed" }, "companion"); });
    await f.host.release({ handleId });
    expect(await f.host.retireSession(identity)).toBe("undelivered");
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
    const page = await f.host.observe({ handleId, afterSequence: 0 });
    expect(page.closed).toBe(true);
    expect(page.events).toHaveLength(1);
    await f.host.acknowledge({ handleId, throughSequence: page.throughSequence });
    expect(await f.host.retireSession(identity)).toBe("retired");
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("waits for successful retirement before attaching a replacement process", async () => {
    const f = fixture(), closing = deferred<void>();
    const first = await f.host.attach(identity);
    f.close.mockImplementation(() => closing.promise);
    await f.host.release({ handleId: first.handleId });
    const replacement = f.host.attach(identity);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    expect(f.launch).toHaveBeenCalledTimes(1);
    closing.resolve();
    expect((await replacement).handleId).not.toBe(first.handleId);
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit execution variables separate from the sanitized baseline", async () => {
    const environment = { PATH: "/bin", PRIVATE_INHERITED: "private", REMOVE: "baseline" };
    const f = fixture({ environment });
    await f.host.attach({ ...identity, executionEnvironment: { CUSTOM: { kind: "literal", value: "explicit" }, REMOVE: { kind: "unset" } } });
    expect(f.launch.mock.calls[0]?.[0]).toMatchObject({ environment, executionEnvironment: { CUSTOM: "explicit", REMOVE: null } });
  });

  it.each(["inherited", "explicit", "tilde", "home"] as const)("uses the same %s agent directory for native storage and child launch", async mode => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-native-directory-"));
    try {
      const environment = { HOME: path.join(directory, "home"),
        ...(mode !== "home" ? { PI_CODING_AGENT_DIR: mode === "tilde" ? "~/native" : path.join(directory, "inherited") } : {}) };
      const agentDirectory = mode === "explicit" ? path.join(directory, "explicit") : undefined;
      const expected = agentDirectory ?? (mode === "home" ? path.join(environment.HOME, ".pi", "agent") : mode === "tilde" ? path.join(environment.HOME, "native") : environment.PI_CODING_AGENT_DIR!);
      const f = fixture({ environment, store: undefined, configuration: { ...configuration, ...(agentDirectory ? { agentDirectory } : {}) } });
      const created = await f.host.create({ cwd: directory, sessionId: "directory-session", operationId: "create-directory-session" });
      expect(created.sessionFile.startsWith(`${expected}/sessions/`)).toBe(true);
      await f.host.attach(created);
      expect(f.launch.mock.calls[0]?.[0].runtime.agentDirectory).toBe(expected);
      f.requests.mockResolvedValue({ models: [], commands: [] });
      await f.host.catalog({ cwd: directory });
      expect(f.launch.mock.calls[1]?.[0].runtime.agentDirectory).toBe(expected);
      await f.host.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps trusted tool authority separate from user variables and validates its keys", async () => {
    const f = fixture();
    const agentToolEnvironment = { SEDES_AGENT_TOOL_ENDPOINT: null, SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "trusted", PATH: "/tools:/bin" };
    await f.host.attach({ ...identity, executionEnvironment: { CUSTOM: { kind: "literal", value: "custom" } }, agentToolEnvironment });
    expect(f.launch.mock.calls[0]?.[0].executionEnvironment).toEqual({ CUSTOM: "custom", ...agentToolEnvironment });
    await expect(f.host.attach({ ...identity, agentToolEnvironment: { ...agentToolEnvironment, NODE_OPTIONS: "--inspect" } as typeof agentToolEnvironment })).rejects.toThrow();
    await expect(f.host.attach({ ...identity, executionEnvironment: { SEDES_AGENT_TOOL_ENDPOINT: { kind: "literal", value: "untrusted" } } })).rejects.toThrow();
  });

  it("rejects cwd-relative agent roots and thread-owned native store changes", async () => {
    expect(() => fixture({ environment: { PI_CODING_AGENT_DIR: "relative" } })).toThrow("pi_native_agent_directory_invalid");
    const f = fixture();
    await expect(f.host.attach({ ...identity, executionEnvironment: { PI_CODING_AGENT_DIR: { kind: "literal", value: "/other" } } })).rejects.toThrow("pi_native_agent_directory_scope_invalid");
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("reports only the fresh native session's chosen default model and thinking level", async () => {
    const f = fixture();
    f.requests.mockImplementation(async command => {
      if ((command as { type: string }).type === "get_available_models") return { models: [{ provider: "other", id: "first" }, { provider: "native", id: "chosen" }] };
      if ((command as { type: string }).type === "get_commands") return { commands: [] };
      return { model: { provider: "native", id: "chosen" }, thinkingLevel: "high" };
    });
    expect((await f.host.catalog({ cwd: "/workspace" })).defaultSelection).toEqual({ provider: "native", modelId: "chosen", thinkingLevel: "high" });
    f.requests.mockImplementation(async command => (command as { type: string }).type === "get_available_models" ? { models: [{ provider: "only", id: "model" }] } : { commands: [] });
    expect((await f.host.catalog({ cwd: "/workspace" })).defaultSelection).toBeUndefined();
  });

  it("coalesces catalog readers while cancellation ends only one wait", async () => {
    const f = fixture(), response = deferred<unknown>(), controller = new AbortController();
    f.requests.mockImplementation(() => response.promise);
    const first = f.host.catalog({ cwd: "/workspace" }, controller.signal);
    const cancelled = expect(first).rejects.toThrow("reader_cancelled");
    const second = f.host.catalog({ cwd: "/workspace" });
    await vi.waitFor(() => expect(f.requests).toHaveBeenCalledTimes(3));
    controller.abort(new Error("reader_cancelled"));
    await cancelled;
    expect(f.launch).toHaveBeenCalledOnce();
    response.resolve({ models: [], commands: [] });
    expect(await second).toEqual({ models: [], commands: [] });
    expect(f.close).toHaveBeenCalledOnce();
    await f.host.catalog({ cwd: "/workspace" });
    expect(f.launch).toHaveBeenCalledTimes(2);
  });

  it("serializes distinct catalog workspaces and refuses queued work during Stop", async () => {
    const f = fixture(), response = deferred<unknown>();
    f.requests.mockImplementation(() => response.promise);
    const first = f.host.catalog({ cwd: "/one" });
    const second = f.host.catalog({ cwd: "/two" });
    const refused = expect(second).rejects.toThrow("pi_native_admission_frozen");
    await vi.waitFor(() => expect(f.requests).toHaveBeenCalledTimes(3));
    expect(f.launch).toHaveBeenCalledOnce();
    const closing = f.host.close();
    response.resolve({ models: [], commands: [] });
    await first;
    await refused;
    await closing;
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("fences catalog results and queued probes after authority changes", async () => {
    const f = fixture(), response = deferred<unknown>();
    let current = true;
    const authority = { assertCurrent() { if (!current) throw new Error("stale_owner"); }, assertAdmission() {} };
    f.requests.mockImplementation(() => response.promise);
    const first = f.host.catalog({ cwd: "/one" }, undefined, authority);
    const rejected = expect(first).rejects.toThrow("stale_owner");
    const second = f.host.catalog({ cwd: "/two" }, undefined, authority);
    const queued = expect(second).rejects.toThrow("stale_owner");
    await vi.waitFor(() => expect(f.requests).toHaveBeenCalledTimes(3));
    current = false;
    response.resolve({ models: [], commands: [] });
    await rejected;
    await queued;
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("joins concurrent attaches to one locked native process", async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.host.attach(identity), f.host.attach(identity)]);
    expect(first.handleId).toBe(second.handleId);
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.releaseWriter).not.toHaveBeenCalled();
    await f.host.close();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
  });

  it("releases only its known handles after confirmed host retirement", async () => {
    const f = fixture(), attached = await f.host.attach(identity);
    await f.host.stop({ expectedRevision: f.host.snapshot().revision, force: true });
    await expect(f.host.release({ handleId: attached.handleId })).resolves.toBeUndefined();
    await expect(f.host.release({ handleId: attached.handleId })).resolves.toBeUndefined();
    await expect(f.host.release({ handleId: "unknown-handle" })).rejects.toThrow("pi_native_session_unknown");
    await expect(f.host.release({ handleId: attached.handleId }, undefined, {
      assertCurrent() { throw new Error("stale-controller"); }, assertAdmission() {},
    })).rejects.toThrow("stale-controller");
    await expect(f.host.inspect()).rejects.toThrow("pi_native_runtime_closed");
    await expect(f.host.attach(identity)).rejects.toThrow("pi_native_runtime_closed");
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
  });

  it("retains exact release receipts after idle session cleanup and later host retirement", async () => {
    const f = fixture(), attached = await f.host.attach(identity);
    await f.host.release({ handleId: attached.handleId });
    await vi.waitFor(() => expect(f.host.snapshot().retainedSessions).toEqual([]));
    await expect(f.host.release({ handleId: attached.handleId })).resolves.toBeUndefined();
    await expect(f.host.release({ handleId: "unknown-handle" })).rejects.toThrow("pi_native_session_unknown");
    await f.host.close();
    expect(f.host.retiredHandleIds()).toContain(attached.handleId);
    await expect(f.host.release({ handleId: attached.handleId })).resolves.toBeUndefined();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
  });

  it("retains accepted work on detach and deduplicates exact operation retries", async () => {
    const f = fixture(), pending = deferred<unknown>();
    f.requests.mockImplementation(() => pending.promise as Promise<{ ok: boolean }>);
    const { handleId } = await f.host.attach(identity);
    const command = { channel: "rpc" as const, command: { type: "prompt", message: "hello" } };
    expect(await f.host.request({ handleId, operationId: "send-1", retainOutcome: true, command })).toEqual({ status: "pending" });
    command.command.message = "mutated after admission";
    f.host.detach();
    await f.host.release({ handleId });
    expect(f.close).not.toHaveBeenCalled();
    expect(await f.host.request({ handleId, operationId: "send-1", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "hello" } } })).toEqual({ status: "pending" });
    await expect(f.host.request({ handleId, operationId: "send-1", retainOutcome: true, command })).rejects.toThrow("pi_native_operation_identity_conflict");
    expect(f.requests).toHaveBeenCalledTimes(1);
    expect(f.requests.mock.calls[0]?.[0]).toEqual({ type: "prompt", message: "hello" });
    pending.resolve({ accepted: true });
    expect(await settled(f.host, handleId, "send-1")).toEqual({ status: "completed", result: { accepted: true } });
    expect(f.close).not.toHaveBeenCalled();
    f.requests.mockResolvedValue(idleState);
    await f.host.acknowledgeOperation({ handleId, operationId: "send-1" });
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
  });

  it("keeps a rejected native outcome exact without replaying the command", async () => {
    const f = fixture();
    f.requests.mockRejectedValue(new PiNativeError("pi_rpc_command_rejected", "rejected"));
    const { handleId } = await f.host.attach(identity);
    const input = { handleId, operationId: "send", retainOutcome: true, command: { channel: "rpc" as const, command: { type: "prompt", message: "hello" } } };
    await f.host.request(input);
    const outcome = await settled(f.host, handleId, "send");
    expect(outcome).toEqual({ status: "failed", failure: { code: "pi_rpc_command_rejected", delivery: "rejected" } });
    expect(await f.host.request(input)).toEqual(outcome);
    expect(f.requests).toHaveBeenCalledTimes(1);
    expect((await f.host.attach(identity)).retainedOperationIds).toEqual(["send"]);
    await f.host.acknowledgeOperation({ handleId, operationId: "send" });
    expect((await f.host.attach(identity)).retainedOperationIds).toEqual([]);
  });

  it("consumes transient terminal outcomes and allows the explicit acknowledgement", async () => {
    const f = fixture();
    f.requests.mockRejectedValue(new PiNativeError("pi_rpc_command_rejected", "rejected"));
    const { handleId } = await f.host.attach(identity);
    await f.host.request({ handleId, operationId: "read", retainOutcome: false, command: { channel: "rpc", command: { type: "get_state" } } });
    let outcome;
    await vi.waitFor(async () => {
      outcome = await f.host.outcome({ handleId, operationId: "read" });
      expect(outcome.status).toBe("failed");
    });
    expect(outcome).toEqual({ status: "failed", failure: { code: "pi_rpc_command_rejected", delivery: "rejected" } });
    await f.host.acknowledgeOperation({ handleId, operationId: "read" });
    expect(f.host.snapshot().blockers).not.toContain("unsettled_outcome");
    await expect(f.host.request({ handleId, operationId: "read", retainOutcome: false, command: { channel: "rpc", command: { type: "get_state" } } })).rejects.toThrow("pi_native_operation_acknowledged");
  });

  it("forgets transient work abandoned by the old controller even after a new attachment", async () => {
    const f = fixture(), pending = deferred<unknown>();
    f.requests.mockImplementation(() => pending.promise);
    const { handleId } = await f.host.attach(identity);
    await f.host.request({ handleId, operationId: "read", retainOutcome: false, command: { channel: "rpc", command: { type: "get_state" } } });
    await expect(f.host.request({ handleId, operationId: "read", retainOutcome: true, command: { channel: "rpc", command: { type: "get_state" } } })).rejects.toThrow("pi_native_operation_identity_conflict");
    f.host.detach();
    await f.host.attach(identity);
    pending.resolve({ ok: true });
    await vi.waitFor(async () => {
      await expect(f.host.outcome({ handleId, operationId: "read" })).rejects.toThrow("pi_native_operation_unknown");
    });
    expect(f.host.snapshot().blockers).not.toContain("unsettled_outcome");
  });

  it("does not acknowledge unseen output or silently skip an expired cursor", async () => {
    const f = fixture();
    const { handleId } = await f.host.attach(identity);
    f.emit({ type: "agent_start" });
    f.emit({ type: "agent_end" });
    await expect(f.host.acknowledge({ handleId, throughSequence: 2 })).rejects.toThrow("pi_native_acknowledgement_invalid");
    const page = await f.host.observe({ handleId, afterSequence: 0 });
    expect(page.events.map(event => event.sequence)).toEqual([1, 2]);
    await f.host.acknowledge({ handleId, throughSequence: page.throughSequence });
    await expect(f.host.observe({ handleId, afterSequence: 0 })).rejects.toThrow("pi_native_observation_continuity_lost");
    expect((await f.host.attach(identity)).retainedAfterSequence).toBe(2);
  });

  it("leaves the native process running when observation retention is exhausted", async () => {
    const f = fixture({ maximumEventBytes: 80 });
    const { handleId } = await f.host.attach(identity);
    f.emit({ type: "agent_start", text: "x".repeat(200) });
    await expect(f.host.observe({ handleId, afterSequence: 0 })).rejects.toThrow("pi_native_observation_continuity_lost");
    expect(f.close).not.toHaveBeenCalled();
    await expect(f.host.request({ handleId, operationId: "next", retainOutcome: true, command: { channel: "rpc", command: { type: "prompt", message: "next" } } })).rejects.toThrow("pi_native_observation_continuity_lost");
    expect((await f.host.request({ handleId, operationId: "stop", retainOutcome: true, command: { channel: "rpc", command: { type: "abort" } } })).status).toBe("pending");
  });

  it("does not coalesce durable events or forgive real event-count overflow", async () => {
    const f = fixture(), { handleId } = await f.host.attach(identity);
    for (let index = 0; index <= 16384; index++) f.emit({ type: "entry_appended", entry: { id: String(index) } });
    expect(f.host.snapshot().blockers).toContain("unknown_state");
    await expect(f.host.observe({ handleId, afterSequence: 0 })).rejects.toThrow("pi_native_observation_continuity_lost");
    expect(f.close).not.toHaveBeenCalled();
  });

  it("permits settling an admitted agent-tool call after admission freezes", async () => {
    const f = fixture();
    const { handleId } = await f.host.attach(identity);
    f.emit({ type: "agent_tool_call", id: "call", toolCallId: "native-call", name: "tool", arguments: {}, assistantEntryId: "assistant", userEntryId: "user" }, "companion");
    expect(f.host.snapshot().blockers).toContain("pending_interaction");
    f.host.freezeAdmission();
    await f.host.request({ handleId, operationId: "reply", retainOutcome: true, command: { channel: "companion", command: { type: "resolve_agent_tool", id: "call", result: { content: [{ type: "text", text: "done" }] } } } });
    await settled(f.host, handleId, "reply");
    expect(f.host.snapshot().blockers).not.toContain("pending_interaction");
  });

  it("rechecks controller authority after async history before launch", async () => {
    const f = fixture(), reading = deferred<Awaited<ReturnType<typeof f.store.readHistory>>>();
    f.store.readHistory.mockImplementation(() => reading.promise);
    let current = true;
    const authority = { assertCurrent() { if (!current) throw new Error("stale"); }, assertAdmission() { if (!current) throw new Error("stale"); } };
    const attaching = f.host.attach(identity, undefined, authority);
    current = false;
    reading.resolve({ ...identity, entries: [], leafId: null, operations: [], toolCalls: [], toolResults: [], inheritedEntryIds: [], inheritance: "none" });
    await expect(attaching).rejects.toThrow("stale");
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("preserves the writer lease when cleanup is unproven, and permits explicit retry", async () => {
    const f = fixture();
    await f.host.attach(identity);
    f.close.mockRejectedValueOnce(new Error("child survived"));
    await expect(f.host.close()).rejects.toThrow("pi_native_cleanup_unproven");
    expect(f.releaseWriter).not.toHaveBeenCalled();
    expect(f.host.snapshot().blockers).toContain("cleanup_unproven");
    await f.host.close();
    expect(f.releaseWriter).toHaveBeenCalledTimes(1);
  });

  it("never releases a writer when failed initialization lost the surviving process handle", async () => {
    let directory: string | undefined;
    const f = fixture({ launch: async input => { directory = input.bridgeDirectory; throw new PiNativeError("pi_native_cleanup_unproven", "sent_outcome_unknown"); } });
    try {
      await expect(f.host.attach(identity)).rejects.toThrow("pi_native_cleanup_unproven");
      await expect(f.host.close()).rejects.toThrow("pi_native_cleanup_unproven");
      expect(f.releaseWriter).not.toHaveBeenCalled();
      expect(f.host.snapshot().blockers).toContain("cleanup_unproven");
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  });

  it("retains a failed catalog cleanup for inspection and explicit retry", async () => {
    const f = fixture();
    f.requests.mockImplementation(async command => (command as { type: string }).type === "get_available_models" ? { models: [] } : { commands: [] });
    f.close.mockRejectedValueOnce(new Error("child survived"));
    await expect(f.host.catalog({ cwd: "/workspace" })).rejects.toThrow("pi_native_cleanup_unproven");
    expect(f.host.snapshot().blockers).toContain("cleanup_unproven");
    await expect(f.host.catalog({ cwd: "/other" })).rejects.toThrow("pi_native_cleanup_unproven");
    expect(f.launch).toHaveBeenCalledOnce();
    await f.host.close();
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it("does not finish host shutdown before an admitted file mutation settles", async () => {
    const f = fixture(), creating = deferred<PiNativeSessionIdentity>();
    f.store.create.mockImplementation(() => creating.promise);
    const operation = f.host.create({ cwd: "/workspace", sessionId: "new", operationId: "create" });
    expect(f.host.snapshot().blockers).toContain("active_work");
    let closed = false;
    const closing = f.host.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    creating.resolve(identity);
    await operation;
    await closing;
    expect(closed).toBe(true);
  });

  it("keeps handle identity stable and refuses session-switching native commands", async () => {
    const f = fixture();
    const { handleId } = await f.host.attach(identity);
    await expect(f.host.attach({ ...identity, sessionId: "different" })).rejects.toThrow("pi_native_session_configuration_conflict");
    await expect(f.host.request({ handleId, operationId: "switch", retainOutcome: true, command: { channel: "rpc", command: { type: "switch_session", sessionPath: "/other" } } })).rejects.toThrow("pi_native_session_command_denied");
    expect(f.requests).not.toHaveBeenCalled();
  });
});
