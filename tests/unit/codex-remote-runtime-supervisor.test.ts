import { afterEach, expect, it, vi } from "vitest";
import { CodexRemoteRuntimeSupervisor } from "../../src/server/backends/codex/runtime/codex-remote-runtime-supervisor.js";
import { CodexServerRequestRouter } from "../../src/server/backends/codex/codex-server-request-router.js";
import type { CodexRuntimeConfiguration } from "../../src/server/backends/codex/runtime/codex-runtime-host-registry.js";

it("publishes reconciling and returns startup while the remote host is unreachable", async () => {
  const acquire = vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }));
  const supervisor = new CodexRemoteRuntimeSupervisor({
    scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" },
    provider: { acquire }, configuration: {} as CodexRuntimeConfiguration,
    serverRequests: new CodexServerRequestRouter(),
    receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [], reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false },
  });
  await supervisor.start();
  expect(acquire).toHaveBeenCalledOnce();
  expect(supervisor.client.lifecycleSnapshot()).toEqual({ state: "reconciling", generation: 0 });
  await supervisor.close();
  expect(supervisor.client.lifecycleSnapshot()).toEqual({ state: "closed", generation: 0 });
});

import { CodexSidecarRuntimeConnection } from "../../src/server/backends/codex/runtime/codex-sidecar-runtime.js";
import { CodexRuntimeClient } from "../../src/server/backends/codex/runtime/codex-runtime-client.js";
import { CODEX_RUNTIME_PROTOCOL_VERSION } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";
import type { SidecarRuntimeChannel } from "../../src/server/sidecar/runtime-channel.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("replaces the detached main presentation after a rejected Stop and reattaches without replaying work", async () => {
  const ensure = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "ensure").mockResolvedValue("runtime");
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "attach").mockResolvedValue({
    protocolVersion: CODEX_RUNTIME_PROTOCOL_VERSION, runtimeId: "runtime",
    lifecycle: { state: "ready", generation: 1 }, runtimeAssessment: null, outcomes: [], pendingRequests: [{
      generation: 1, sequence: 1, id: "approval", method: "item/commandExecution/requestApproval",
      params: { kind: "command", threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1, environmentId: null, availableDecisions: ["decline"] },
    }],
  });
  const stop = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "stop").mockRejectedValue(new Error("confirmation_stale"));
  const detach = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "detach").mockResolvedValue();
  const submit = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "submit");
  const retire = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "retire");
  const respond = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "respond");
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ channel: { supportsOperation: () => false } as unknown as SidecarRuntimeChannel,
    serviceIncarnation: "service", controllerEpoch: 1, closed: new Promise<void>(() => undefined), release }));
  const serverRequests = new CodexServerRequestRouter();
  const supervisor = new CodexRemoteRuntimeSupervisor({
    scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" },
    provider: { acquire }, configuration: {} as CodexRuntimeConfiguration, serverRequests,
    receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [],
      reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false },
  });
  await supervisor.attachment();
  let finishApproval!: (value: unknown) => void;
  const handle = vi.fn(() => new Promise(resolve => { finishApproval = resolve; }));
  const owner = serverRequests.claimThread({ generation: 1, nativeThreadId: "thread-1", owner: { owns: () => true, handle } });
  await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
  await expect(supervisor.administration.stop({ expectedRevision: "old", force: true })).rejects.toThrow("confirmation_stale");
  await supervisor.close();
  finishApproval({ decision: "decline" });
  owner.release("actor_cleanup_after_failed_stop");
  await new Promise(resolve => setImmediate(resolve));
  expect(stop).toHaveBeenCalledOnce();
  expect(detach).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
  expect(retire).not.toHaveBeenCalled();
  expect(respond).not.toHaveBeenCalled();
  expect(acquire).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(supervisor.client.lifecycleSnapshot()).toEqual({ state: "closed", generation: 1 });

  // Explicit Connect constructs a fresh module after the failed Stop retires
  // its closed local owner. The retained native runtime remains authoritative.
  const replacement = new CodexRemoteRuntimeSupervisor({ ...supervisor.input, serverRequests: new CodexServerRequestRouter() });
  try {
    expect((await replacement.attachment()).runtimeId).toBe("runtime");
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(replacement.client.lifecycleSnapshot()).toEqual({ state: "ready", generation: 1 });
    expect(submit).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    stop.mockResolvedValueOnce();
    await replacement.administration.stop({ expectedRevision: "current", force: true });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(replacement.client.lifecycleSnapshot()).toEqual({ state: "closed", generation: 1 });
    expect(submit).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  } finally { await replacement.close(); }
});

it("logs the first rejected lease cause before discard and preserves the retry schedule", async () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "ensure").mockResolvedValue("runtime");
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "attach").mockResolvedValue({
    protocolVersion: CODEX_RUNTIME_PROTOCOL_VERSION, runtimeId: "runtime",
    lifecycle: { state: "ready", generation: 1 }, runtimeAssessment: null, outcomes: [], pendingRequests: [],
  });
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "detach").mockResolvedValue();
  let rejectLease!: (error: Error) => void;
  const closed = new Promise<never>((_, reject) => { rejectLease = reject; });
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ channel: { supportsOperation: () => true } as unknown as SidecarRuntimeChannel,
    controllerEpoch: 9, serviceIncarnation: "private-service-incarnation", closed, release }));
  const supervisor = new CodexRemoteRuntimeSupervisor({
    scope: { tenantId: "private-tenant", principalId: "private-principal", executionEnvironmentId: "remote", backendInstanceId: "backend" },
    provider: { acquire }, configuration: {} as CodexRuntimeConfiguration, serverRequests: new CodexServerRequestRouter(),
    receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [],
      reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false },
  });
  try {
    await supervisor.attachment();
    const cause = new Error("sidecar_protocol_invalid", { cause: new Error("private-frame-content") });
    rejectLease(cause);
    await new Promise(resolve => setImmediate(resolve));
    const records = log.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith("[delivery-attachment] "))
      .map(line => JSON.parse(line.slice("[delivery-attachment] ".length)));
    const lost = records.findIndex(record => record.event === "attachment_lost");
    expect(records[lost]).toMatchObject({ reason: "lease_rejected", backendInstanceId: "backend", executionEnvironmentId: "remote",
      generation: 1, attachmentAttempt: 1, controllerEpoch: 9, errors: [{ name: "Error", code: "sidecar_protocol_invalid" }, { name: "Error" }] });
    expect(records[lost + 1]).toMatchObject({ event: "attachment_discard", reason: "lease_rejected" });
    expect(records[lost]).not.toHaveProperty("carrierGeneration");
    expect(JSON.stringify(records)).not.toContain("private");
    expect(release).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledOnce();
    expect(supervisor.client.lifecycleSnapshot().state).toBe("reconciling");
  } finally { await supervisor.close(); }
});

it("restarts through the same carrier, closes the old client, and retires only confirmed settled receipts", async () => {
  let incarnation = 0;
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "ensure").mockImplementation(async () => `runtime-${++incarnation}`);
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "attach").mockImplementation(async authority => ({
    protocolVersion: CODEX_RUNTIME_PROTOCOL_VERSION, runtimeId: authority.runtimeId,
    lifecycle: { state: "ready", generation: 1 }, runtimeAssessment: null, outcomes: [], pendingRequests: [],
  }));
  const stop = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "stop").mockResolvedValue();
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "detach").mockRejectedValue(new Error("runtime_retired"));
  const close = vi.spyOn(CodexRuntimeClient.prototype, "close");
  const release = vi.fn();
  let tuiSupported = false;
  const channel = { supportsOperation: () => tuiSupported } as unknown as SidecarRuntimeChannel;
  const acquire = vi.fn(async () => ({ channel, serviceIncarnation: "service", controllerEpoch: 1, closed: new Promise(() => {}), release }));
  const compactRetiredRuntime = vi.fn(() => 0);
  const supervisor = new CodexRemoteRuntimeSupervisor({
    scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" },
    provider: { acquire }, configuration: {} as CodexRuntimeConfiguration,
    serverRequests: new CodexServerRequestRouter(),
    receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [],
      reconcileRecordedApplicationState: () => 0, compactRetiredRuntime, releaseRejected: () => false },
  });
  try {
    expect((await supervisor.attachment()).runtimeId).toBe("runtime-1");
    expect(supervisor.managedTuiAvailable()).toBe(false);
    tuiSupported = true;
    expect(supervisor.managedTuiAvailable()).toBe(true);
    stop.mockRejectedValueOnce(new Error("revision_conflict"));
    await expect(supervisor.administration.restart!({ expectedRevision: "stale", force: false })).rejects.toThrow("revision_conflict");
    expect(compactRetiredRuntime).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await supervisor.administration.restart!({ expectedRevision: "confirmed", force: false });
    expect(close).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    expect((await supervisor.attachment()).runtimeId).toBe("runtime-2");
    expect(supervisor.client.lifecycleSnapshot()).toEqual({ state: "ready", generation: 2 });
    expect(compactRetiredRuntime).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "runtime-1" }), expect.objectContaining({
      disposition: "confirmed_retired", runtimeId: "runtime-1", retirementOperationId: expect.any(String), retiredAt: expect.any(Number),
    }));
  } finally { await supervisor.close(); }
});

it.each(["retained", "missing", "replaced_service"] as const)("recovers only the exact retained Codex runtime under a pending revision: %s", async disposition => {
  vi.useFakeTimers();
  const ensure = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "ensure").mockResolvedValue("runtime");
  const lookup = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "lookup").mockResolvedValue(disposition === "missing" ? undefined : "runtime");
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "attach").mockImplementation(async authority => ({
    protocolVersion: CODEX_RUNTIME_PROTOCOL_VERSION, runtimeId: authority.runtimeId,
    lifecycle: { state: "ready", generation: 1 }, runtimeAssessment: null, outcomes: [], pendingRequests: [],
  }));
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "detach").mockResolvedValue();
  let lose!: () => void;
  const lost = new Promise<void>(resolve => { lose = resolve; });
  let stale = false;
  const release = vi.fn();
  const acquire = vi.fn(async (_signal?: AbortSignal, options?: { existingOnly?: boolean }) => {
    if (stale && !options?.existingOnly) throw new Error("sidecar_unavailable", { cause: new Error("sidecar_revision_changed") });
    return { channel: { supportsOperation: () => true } as unknown as SidecarRuntimeChannel,
      controllerEpoch: stale ? 2 : 1, serviceIncarnation: stale && disposition === "replaced_service" ? "replacement" : "service",
      closed: stale ? new Promise(() => {}) : lost, release };
  });
  const supervisor = new CodexRemoteRuntimeSupervisor({
    scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" },
    provider: { acquire }, configuration: {} as CodexRuntimeConfiguration, serverRequests: new CodexServerRequestRouter(),
    receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [],
      reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false },
  });
  try {
    await supervisor.attachment();
    stale = true; lose();
    await vi.advanceTimersByTimeAsync(1001);
    expect(acquire).toHaveBeenCalledWith(expect.any(AbortSignal), { existingOnly: true });
    expect(ensure).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
    if (disposition === "retained") {
      expect((await supervisor.attachment()).runtimeId).toBe("runtime");
      expect(supervisor.client.lifecycleSnapshot().state).toBe("ready");
    } else {
      expect(supervisor.client.lifecycleSnapshot()).toMatchObject({ state: "unavailable", unavailableReason: "runtime_configuration_unavailable" });
      const calls = acquire.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(acquire).toHaveBeenCalledTimes(calls);
    }
  } finally { await supervisor.close(); vi.useRealTimers(); }
});
