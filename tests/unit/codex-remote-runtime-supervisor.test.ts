import { afterEach, expect, it, vi } from "vitest";
import { CodexRemoteRuntimeSupervisor } from "../../src/server/backends/codex/runtime/codex-remote-runtime-supervisor.js";
import { CodexServerRequestRouter } from "../../src/server/backends/codex/codex-server-request-router.js";
import type { CodexRuntimeConfiguration } from "../../src/server/backends/codex/runtime/codex-runtime-host-registry.js";

const configuration = { connection: { ownership: "owned" } } as CodexRuntimeConfiguration;

it("publishes reconciling and returns startup while the remote host is unreachable", async () => {
  const acquire = vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }));
  const supervisor = new CodexRemoteRuntimeSupervisor({
    scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" },
    provider: { acquireExisting: async () => { throw new Error("unused_existing_carrier_admission"); }, acquire }, configuration: configuration,
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

it.each(["offline", "missing", "ready", "policy denied", "carrier lost after lookup"] as const)(
  "checks a cold target using existing-only host evidence: %s", async condition => {
    const acquire = vi.fn();
    const release = vi.fn();
    const acquireExisting = vi.fn(async () => {
      if (condition === "offline") throw new Error("outbound_connector_offline");
      if (condition === "policy denied") throw new Error("backend_policy_denied");
      return { channel: {} as SidecarRuntimeChannel, controllerEpoch: 1, serviceIncarnation: "service",
        closed: new Promise(() => {}), release };
    });
    const lookup = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "lookup").mockResolvedValue(condition === "missing" ? undefined : "retained");
    const inspect = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "prepareThreadArchive").mockImplementation(async () => {
      if (condition === "carrier lost after lookup") throw new Error("outbound_disconnected");
      return "busy";
    });
    const ensure = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "ensure"), wake = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "wake");
    const supervisor = new CodexRemoteRuntimeSupervisor({
      scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" },
      provider: { acquire, acquireExisting }, configuration: { ...configuration, connections: [
        { id: "cp", enabled: true, templateId: "target" } as CodexRuntimeConfiguration["connections"][number],
      ] }, serverRequests: new CodexServerRequestRouter(), receipts: {
        reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [],
        reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false,
      },
    });
    const markObserved = vi.fn(), signal = AbortSignal.timeout(1000);
    try {
      const result = supervisor.client.inspectExistingArchive!({ applicationThreadId: "app", connectionProfileId: "cp",
        threadId: "native", workspace: "/workspace", signal, markObserved });
      if (condition === "carrier lost after lookup" || condition === "policy denied") await expect(result).rejects.toThrow();
      else await expect(result).resolves.toEqual({ outcome: condition === "ready" ? "busy" : "offline" });
      expect(markObserved).toHaveBeenCalledTimes(condition === "ready" || condition === "carrier lost after lookup" ? 1 : 0);
      expect(lookup).toHaveBeenCalledTimes(condition === "offline" || condition === "policy denied" ? 0 : 1);
      if (condition === "ready") expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "retained" }),
        { applicationThreadId: "app", threadId: "native", targetId: "target", workspace: "/workspace" }, signal);
      expect(acquire).not.toHaveBeenCalled();
      expect(ensure).not.toHaveBeenCalled();
      expect(wake).not.toHaveBeenCalled();
    } finally { await supervisor.close(); }
  },
);

it.each(["carrier offline", "busy", "released", "offline", "inconclusive"] as const)(
  "checks the operator-owned native endpoint when no external host is registered: %s", async condition => {
    const acquire = vi.fn(), ensure = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "ensure");
    const acquireExisting = vi.fn(async () => {
      if (condition === "carrier offline") throw new Error("outbound_connector_offline");
      return { channel: {} as SidecarRuntimeChannel, controllerEpoch: 1, serviceIncarnation: "service",
        closed: new Promise<void>(() => {}), release: vi.fn() };
    });
    vi.spyOn(CodexSidecarRuntimeConnection.prototype, "lookup").mockResolvedValue(undefined);
    const inspect = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "inspectUnregisteredExternalArchive")
      .mockResolvedValue(condition === "carrier offline" ? "inconclusive" : condition);
    const external = { ...configuration, connection: { ownership: "external", channel: { type: "unix_websocket", socketPath: "/configured/codex.sock" } },
      connections: [{ id: "cp", enabled: true, templateId: "target", kind: "codex_app_server", label: "Codex", configurationRevision: 1,
        tenantId: "tenant", ownerPrincipalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "remote" }] } satisfies CodexRuntimeConfiguration;
    const supervisor = new CodexRemoteRuntimeSupervisor({
      scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" },
      provider: { acquire, acquireExisting }, configuration: external, serverRequests: new CodexServerRequestRouter(), receipts: {
        reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [],
        reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false,
      },
    });
    const signal = AbortSignal.timeout(1000), markObserved = vi.fn();
    try {
      await expect(supervisor.client.inspectExistingArchive!({ applicationThreadId: "app", connectionProfileId: "cp",
        threadId: "native", workspace: "/workspace", signal, markObserved }))
        .resolves.toEqual({ outcome: condition === "carrier offline" ? "inconclusive" : condition });
      if (condition !== "carrier offline") expect(inspect).toHaveBeenCalledWith(external, "cp", "native", "/workspace", signal);
      else expect(inspect).not.toHaveBeenCalled();
      expect(markObserved).toHaveBeenCalledTimes(condition === "busy" || condition === "inconclusive" ? 1 : 0);
      expect(acquire).not.toHaveBeenCalled();
      expect(ensure).not.toHaveBeenCalled();
    } finally { await supervisor.close(); }
  },
);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("exposes only the in-flight initialization until the ready lifecycle is published", async () => {
  vi.useFakeTimers();
  let finishAttach!: () => void;
  const delayedAttach = new Promise<void>(resolve => { finishAttach = resolve; });
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "lookup").mockResolvedValue("runtime");
  const attach = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "attach").mockImplementation(async () => {
    await delayedAttach;
    return { protocolVersion: CODEX_RUNTIME_PROTOCOL_VERSION, runtimeId: "runtime",
      lifecycle: { state: "ready", generation: 1 }, runtimeAssessment: null, outcomes: [], pendingRequests: [] };
  });
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "detach").mockResolvedValue();
  const acquire = vi.fn(async () => ({ channel: { supportsOperation: () => false } as unknown as SidecarRuntimeChannel,
    serviceIncarnation: "service", controllerEpoch: 1, closed: new Promise<void>(() => {}), release: vi.fn() }))
    .mockRejectedValueOnce(new Error("sidecar_unavailable"));
  const supervisor = new CodexRemoteRuntimeSupervisor({
    scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" },
    provider: { acquire, acquireExisting: vi.fn() }, configuration: configuration,
    serverRequests: new CodexServerRequestRouter(),
    receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [],
      reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false },
  });
  const { client } = supervisor;
  const observedAtReady = vi.fn();
  const unsubscribe = client.subscribeLifecycle(snapshot => {
    if (snapshot.state === "ready") observedAtReady(client.pendingInitialization?.());
  });
  try {
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.lifecycleSnapshot()).toEqual({ state: "reconciling", generation: 0 });
    expect(client.pendingInitialization?.()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(999);
    expect(client.pendingInitialization?.()).toBeUndefined();
    expect(acquire).toHaveBeenCalledOnce();
    expect(attach).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenCalledOnce();
    expect(client.lifecycleSnapshot()).toEqual({ state: "unavailable", generation: 0 });
    const initialization = client.pendingInitialization?.();
    expect(initialization).toBeInstanceOf(Promise);
    expect(client.pendingInitialization?.()).toBe(initialization);
    const settled = vi.fn(() => client.lifecycleSnapshot());
    const settledSnapshot = initialization?.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    finishAttach();
    await expect(settledSnapshot).resolves.toEqual({ state: "ready", generation: 1 });
    expect(observedAtReady).toHaveBeenCalledExactlyOnceWith(initialization);
    expect(client.lifecycleSnapshot()).toEqual({ state: "ready", generation: 1 });
    expect(client.pendingInitialization?.()).toBeUndefined();
    expect(acquire).toHaveBeenCalledTimes(2);
  } finally { finishAttach(); unsubscribe(); await supervisor.close(); vi.useRealTimers(); }
});

it("replaces the detached main presentation after a rejected Stop and reattaches without replaying work", async () => {
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "lookup").mockResolvedValueOnce(undefined).mockResolvedValue("runtime");
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
    provider: { acquireExisting: async () => { throw new Error("unused_existing_carrier_admission"); }, acquire }, configuration: configuration, serverRequests,
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
    expect(ensure).toHaveBeenCalledOnce();
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
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "lookup").mockResolvedValueOnce(undefined).mockResolvedValue("runtime");
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
    provider: { acquireExisting: async () => { throw new Error("unused_existing_carrier_admission"); }, acquire }, configuration: configuration, serverRequests: new CodexServerRequestRouter(),
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
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "lookup").mockResolvedValue(undefined);
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
    provider: { acquireExisting: async () => { throw new Error("unused_existing_carrier_admission"); }, acquire }, configuration: configuration,
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
  const lookup = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "lookup").mockResolvedValueOnce(undefined).mockResolvedValue(disposition === "missing" ? undefined : "runtime");
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
    provider: { acquireExisting: async () => { throw new Error("unused_existing_carrier_admission"); }, acquire }, configuration: configuration, serverRequests: new CodexServerRequestRouter(),
    receipts: { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked", pending: () => [],
      reconcileRecordedApplicationState: () => 0, compactRetiredRuntime: () => 0, releaseRejected: () => false },
  });
  try {
    await supervisor.attachment();
    stale = true; lose();
    await vi.advanceTimersByTimeAsync(1001);
    expect(acquire).toHaveBeenCalledWith(expect.any(AbortSignal), { existingOnly: true });
    expect(ensure).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledTimes(2);
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

it.each(["replaced", "carrier"] as const)("after a %s reconnect, stops retrying a runtime retired with its service but reattaches to a surviving one", async disposition => {
  vi.useFakeTimers();
  // The successor service's registry starts empty; the same service still holds the runtime.
  const lookup = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "lookup").mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(disposition === "replaced" ? undefined : "runtime");
  const ensure = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "ensure").mockResolvedValue("runtime");
  const attach = vi.spyOn(CodexSidecarRuntimeConnection.prototype, "attach").mockResolvedValue({
    protocolVersion: CODEX_RUNTIME_PROTOCOL_VERSION, runtimeId: "runtime",
    lifecycle: { state: "ready", generation: 1 }, runtimeAssessment: null, outcomes: [], pendingRequests: [] });
  vi.spyOn(CodexSidecarRuntimeConnection.prototype, "detach").mockResolvedValue();
  let closeCarrier!: () => void;
  const lease = (serviceIncarnation: string, closed = new Promise<void>(() => {})) => ({
    channel: { supportsOperation: () => false } as unknown as SidecarRuntimeChannel,
    serviceIncarnation, controllerEpoch: 1, closed, release: vi.fn() });
  const acquire = vi.fn()
    .mockResolvedValueOnce(lease("first-service", new Promise<void>(resolve => { closeCarrier = resolve; })))
    .mockResolvedValue(lease(disposition === "replaced" ? "successor-service" : "first-service"));
  const pending = [{ operationId: "send", method: "turn/start" as const, requestFingerprint: "f", state: "reserved" as const, outcome: null,
    correlation: { kind: "start" as const, applicationOperationId: "send", applicationThreadId: "uncertain-thread" } }];
  const receipts = { reserve: () => { throw new Error("unused"); }, recordOutcome: () => "untracked" as const,
    pending: vi.fn(() => pending), reconcileRecordedApplicationState: vi.fn(() => 0), compactRetiredRuntime: vi.fn(() => 0), releaseRejected: () => false };
  const supervisor = new CodexRemoteRuntimeSupervisor({
    scope: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote", backendInstanceId: "backend" },
    provider: { acquire, acquireExisting: vi.fn() }, configuration: configuration,
    serverRequests: new CodexServerRequestRouter(), receipts });
  try {
    await supervisor.attachment();
    expect(supervisor.client.lifecycleSnapshot()).toEqual({ state: "ready", generation: 1 });
    expect(ensure).toHaveBeenCalledOnce();
    closeCarrier();
    await vi.advanceTimersByTimeAsync(1_000);
    if (disposition === "replaced") {
      expect(supervisor.client.lifecycleSnapshot()).toEqual({ state: "unavailable", generation: 1, unavailableReason: "provider_service_replaced" });
      expect(receipts.reconcileRecordedApplicationState).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "runtime" }));
      expect(supervisor.client.replacedServiceReceiptsPending("uncertain-thread")).toBe(true);
      expect(supervisor.client.replacedServiceReceiptsPending("settled-thread")).toBe(false);
      // The retained identity never ensures a runtime on the successor, and stops retrying.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(ensure).toHaveBeenCalledOnce();
      expect(receipts.compactRetiredRuntime).not.toHaveBeenCalled();
      await expect(supervisor.attachment()).rejects.toThrow("codex_runtime_service_replaced");
    } else {
      expect(supervisor.client.lifecycleSnapshot()).toMatchObject({ state: "ready" });
      expect(attach).toHaveBeenCalledTimes(2);
      expect(ensure).toHaveBeenCalledOnce();
      expect(supervisor.client.replacedServiceReceiptsPending("uncertain-thread")).toBe(false);
    }
    expect(lookup).toHaveBeenCalledTimes(2);
  } finally { await supervisor.close(); vi.useRealTimers(); }
});
