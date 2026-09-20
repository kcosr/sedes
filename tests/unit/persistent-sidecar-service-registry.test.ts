import { describe, expect, it, vi } from "vitest";
import { PersistentSidecarServiceRegistry, SidecarResourceHandoffPendingError } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";

const scope = { installationId: "install-a", tenantId: "tenant-a", principalId: "principal-a", executionEnvironmentId: "remote-a" };
const configuration = { environmentRevision: 1, operationsRevision: 2 };
function registry() {
  return new PersistentSidecarServiceRegistry({ scope, buildId: "build-a", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration });
}

describe("persistent sidecar resource ownership", () => {
  it("keeps resources alive after controller loss and fences the old controller", () => {
    const service = registry();
    const stop = vi.fn(async () => undefined);
    const onDetach = vi.fn();
    service.register({ resourceId: "terminal-a", kind: "terminal", snapshot: () => ({ state: "active", revision: "1", blockers: ["live_terminal"] }), stop, onDetach });
    const first = service.attach(configuration);
    service.assertAdmission(first);
    service.detach(first);
    expect(stop).not.toHaveBeenCalled();
    expect(onDetach).toHaveBeenCalledOnce();
    expect(service.status().resources).toHaveLength(1);
    const next = service.attach(configuration);
    expect(next).toBeGreaterThan(first);
    expect(() => service.assertAdmission(first)).toThrow("sidecar_controller_stale");
    service.detach(first);
    service.assertAdmission(next);
  });

  it("never treats a live idle shell or unknown inventory as safe upgrade idleness", async () => {
    const service = registry();
    const stop = vi.fn(async () => undefined);
    let live = true;
    service.register({ resourceId: "terminal-a", kind: "terminal", snapshot: () => ({ state: "idle", revision: live ? "1" : "2", blockers: live ? ["live_terminal"] : [] }), stop });
    const controllerEpoch = service.attach(configuration);
    const request = { expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration,
      expectedResourcesFingerprint: service.status().resourcesFingerprint, force: false, reason: "upgrade" };
    await expect(service.stop(request)).rejects.toThrow("sidecar_service_upgrade_blocked");
    expect(stop).not.toHaveBeenCalled();
    service.assertAdmission(controllerEpoch);
    // A reclaimed blocked receipt can never turn this same request into an
    // effect once its blocker disappears: its confirmed fingerprint is stale.
    live = false;
    await expect(service.stop(request)).rejects.toThrow("sidecar_service_confirmation_stale");
    expect(stop).not.toHaveBeenCalled();
    await service.stop({ ...request, expectedResourcesFingerprint: service.status().resourcesFingerprint });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("fences new work before taking the final idle snapshot and requires cleanup proof", async () => {
    const service = registry();
    const epoch = service.attach(configuration);
    let stopping = false;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let beganStop!: () => void;
    const stoppingStarted = new Promise<void>((resolve) => { beganStop = resolve; });
    service.register({ resourceId: "provider-a", kind: "provider", snapshot: () => {
      if (stopping) expect(() => service.assertAdmission(epoch)).toThrow("sidecar_service_not_accepting_work");
      return { state: "idle", revision: "1", blockers: [] };
    }, stop: async () => { beganStop(); await blocked; } });
    const expectedResourcesFingerprint = service.status().resourcesFingerprint;
    stopping = true;
    const stoppingPromise = service.stop({ expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch: epoch, expectedConfiguration: configuration, expectedResourcesFingerprint, force: false, reason: "upgrade" });
    await stoppingStarted;
    expect(service.status().state).toBe("stopping");
    expect(() => service.register({ resourceId: "new", kind: "provider", snapshot: () => ({ state: "idle", revision: "1", blockers: [] }), stop: async () => undefined })).toThrow("sidecar_service_not_accepting_work");
    release();
    await stoppingPromise;
    expect(service.status().state).toBe("stopped");
  });

  it("does not report stopped after partial cleanup failure", async () => {
    const service = registry();
    const controllerEpoch = service.attach(configuration);
    service.register({ resourceId: "provider-a", kind: "provider", snapshot: () => ({ state: "active", revision: "1", blockers: ["active_work"] }), stop: async () => { throw new Error("child still present"); } });
    await expect(service.stop({ expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration, expectedResourcesFingerprint: service.status().resourcesFingerprint, force: true, reason: "explicit_stop" })).rejects.toThrow("sidecar_service_cleanup_unproven");
    expect(service.status().state).toBe("cleanup_unproven");
    expect(service.status().resources).toHaveLength(1);
  });

  it("rejects cross-scope and stale stop confirmations", async () => {
    const service = registry();
    expect(() => service.assertScope({ ...scope, principalId: "principal-b" })).toThrow("sidecar_service_scope_mismatch");
    const old = service.attach(configuration);
    service.attach(configuration);
    await expect(service.stop({ expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch: old, expectedConfiguration: configuration, expectedResourcesFingerprint: service.status().resourcesFingerprint, force: true, reason: "stop" })).rejects.toThrow("sidecar_service_confirmation_stale");
  });

  it("does not replace cached grant authority merely because configuration changed", () => {
    const service = registry();
    service.register({ resourceId: "files", kind: "watch", snapshot: () => ({ state: "idle", revision: "1", blockers: [] }), stop: async () => undefined });
    const controllerEpoch = service.attach({ ...configuration, operationsRevision: 3 });
    expect(service.status().configurationState).toBe("pending");
    expect(service.status().effectiveConfiguration).toEqual(configuration);
    expect(() => service.assertAdmission(controllerEpoch)).toThrow("sidecar_configuration_pending");
  });

  it("reports a concurrent stop as in progress instead of unproven cleanup", async () => {
    const service = registry();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    service.register({ resourceId: "provider-a", kind: "provider", snapshot: () => ({ state: "idle", revision: "1", blockers: [] }),
      prepareRestart: () => blocked, stop: async () => undefined });
    const controllerEpoch = service.attach(configuration);
    const request = { expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration,
      expectedResourcesFingerprint: service.status().resourcesFingerprint, force: true, reason: "stop" };
    const first = service.stop(request);
    await Promise.resolve();
    expect(service.status().state).toBe("draining");
    await expect(service.stop(request)).rejects.toThrow("sidecar_service_stop_in_progress");
    release();
    await first;
    expect(service.status().state).toBe("stopped");
  });

  it("lets an explicit forced stop retry unproven cleanup until it is proven", async () => {
    const service = registry();
    let exited = false;
    service.register({ resourceId: "terminal-a", kind: "terminal", snapshot: () => ({ state: "idle", revision: "1", blockers: [] }),
      stop: async () => { if (!exited) throw new Error("terminal_exit_unconfirmed"); } });
    const controllerEpoch = service.attach(configuration);
    const request = () => ({ expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration,
      expectedResourcesFingerprint: service.status().resourcesFingerprint, reason: "stop" });
    await expect(service.stop({ ...request(), force: true })).rejects.toThrow("sidecar_service_cleanup_unproven");
    expect(service.status().state).toBe("cleanup_unproven");
    await expect(service.stop({ ...request(), force: false })).rejects.toThrow("sidecar_service_cleanup_unproven");
    await expect(service.stop({ ...request(), force: true })).rejects.toThrow("sidecar_service_cleanup_unproven");
    exited = true;
    await service.stop({ ...request(), force: true });
    expect(service.status().state).toBe("stopped");
  });

  it("rejects a forced restart when new work replaced the confirmed active turn", async () => {
    const service = registry();
    let revision = "turn-a";
    const stop = vi.fn(async () => undefined);
    service.register({ resourceId: "provider-a", kind: "provider", snapshot: () => ({ state: "active", revision, blockers: ["active_work"] }), stop });
    const controllerEpoch = service.attach(configuration);
    const expectedResourcesFingerprint = service.status().resourcesFingerprint;
    revision = "turn-b";
    await expect(service.stop({ expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration, expectedResourcesFingerprint, force: true, reason: "restart" })).rejects.toThrow("sidecar_service_confirmation_stale");
    expect(stop).not.toHaveBeenCalled();
  });

  it("accepts unknown inventory becoming proven idle during its own fenced refresh", async () => {
    const service = registry();
    let known = false;
    const stop = vi.fn(async () => undefined);
    service.register({ resourceId: "provider-a", kind: "provider",
      snapshot: () => known ? { state: "idle", revision: "native-idle", blockers: [] } : { state: "unknown", revision: "cached-unknown", blockers: ["unknown_state"] },
      prepareRestart: async () => { known = true; }, stop });
    const controllerEpoch = service.attach(configuration);
    await service.stop({ expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration,
      expectedResourcesFingerprint: service.status().resourcesFingerprint, force: false, reason: "upgrade" });
    expect(stop).toHaveBeenCalledWith("upgrade", { force: false });
    expect(service.status().state).toBe("stopped");
  });

  it("keeps explicit restart authority when its native refresh discovers activity on the confirmed resource", async () => {
    const service = registry();
    let revision = "turn-a";
    const stop = vi.fn(async () => undefined);
    service.register({ resourceId: "provider-a", kind: "provider", snapshot: () => ({ state: "active", revision, blockers: ["active_work"] }),
      prepareRestart: async () => { revision = "turn-b"; }, stop });
    const controllerEpoch = service.attach(configuration);
    await expect(service.stop({ expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration,
      expectedResourcesFingerprint: service.status().resourcesFingerprint, force: true, reason: "restart" })).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledWith("restart", { force: true });
    expect(service.status().state).toBe("stopped");
  });

  it("passes explicit interruption authority through even when refreshing native evidence fails", async () => {
    const service = registry();
    const stop = vi.fn(async () => undefined);
    service.register({ resourceId: "provider-a", kind: "provider", snapshot: () => ({ state: "active", revision: "turn-a", blockers: ["active_work"] }),
      prepareRestart: async () => { throw new Error("provider disconnected"); }, stop });
    const controllerEpoch = service.attach(configuration);
    await service.stop({ expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration,
      expectedResourcesFingerprint: service.status().resourcesFingerprint, force: true, reason: "stop" });
    expect(stop).toHaveBeenCalledWith("stop", { force: true });
    expect(service.status().state).toBe("stopped");
  });

  it("refreshes unknown status without freezing admission and shares concurrent observations", async () => {
    const service = registry();
    let known = false;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const prepareRestart = vi.fn(async () => { await pending; known = true; });
    service.register({ resourceId: "provider-a", kind: "provider",
      snapshot: () => ({ state: known ? "idle" : "unknown", revision: known ? "idle" : "unknown", blockers: known ? [] : ["unknown_state"] }),
      prepareRestart, stop: async () => undefined });
    const controllerEpoch = service.attach(configuration);
    const first = service.refreshStatus();
    const second = service.refreshStatus();
    await Promise.resolve();
    service.assertAdmission(controllerEpoch);
    expect(prepareRestart).toHaveBeenCalledOnce();
    release();
    for (const status of await Promise.all([first, second])) expect(status.resources[0]).toMatchObject({ state: "idle", blockers: [] });
    await service.refreshStatus();
    expect(prepareRestart).toHaveBeenCalledOnce();
  });

  it("bounds unavailable status observations and permits forced cleanup while their reads remain pending", async () => {
    vi.useFakeTimers();
    try {
      const service = registry();
      const stop = vi.fn(async () => undefined);
      const prepareRestart = vi.fn(() => new Promise<void>(() => undefined));
      service.register({ resourceId: "provider-a", kind: "provider", snapshot: () => ({ state: "unknown", revision: "unknown", blockers: ["unknown_state"] }), prepareRestart, stop });
      const controllerEpoch = service.attach(configuration);
      const observation = service.refreshStatus();
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await observation).resources[0]).toMatchObject({ state: "unknown" });
      service.assertAdmission(controllerEpoch);
      const stopping = service.stop({ expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration,
        expectedResourcesFingerprint: service.status().resourcesFingerprint, force: true, reason: "stop" });
      await vi.advanceTimersByTimeAsync(1_000);
      await stopping;
      expect(prepareRestart).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledWith("stop", { force: true });
    } finally { vi.useRealTimers(); }
  });

  it("lets automatic Stop finish a slow native observation after status returned promptly", async () => {
    vi.useFakeTimers();
    try {
      const service = registry();
      let known = false;
      const stop = vi.fn(async () => undefined);
      const prepareRestart = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 2_500));
        known = true;
      });
      service.register({ resourceId: "provider-a", kind: "provider",
        snapshot: () => ({ state: known ? "idle" : "unknown", revision: known ? "idle" : "unknown", blockers: known ? [] : ["unknown_state"] }), prepareRestart, stop });
      const controllerEpoch = service.attach(configuration);
      const observation = service.refreshStatus();
      await vi.advanceTimersByTimeAsync(1_000);
      const status = await observation;
      expect(status.resources[0]).toMatchObject({ state: "unknown" });
      service.assertAdmission(controllerEpoch);
      let settled = false;
      const stopping = service.stop({ expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration,
        expectedResourcesFingerprint: status.resourcesFingerprint, force: false, reason: "upgrade" }).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(settled).toBe(false);
      expect(prepareRestart).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      await stopping;
      expect(stop).toHaveBeenCalledWith("upgrade", { force: false });
      expect(service.status().state).toBe("stopped");
    } finally { vi.useRealTimers(); }
  });

  it("does not allow failed best-effort preservation to veto an explicit stop", async () => {
    const recordAbandonment = vi.fn(async () => { throw new Error("archive disk full"); });
    const service = new PersistentSidecarServiceRegistry({ scope, buildId: "build-a", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration, recordAbandonment });
    await expect(service.recordAbandonment({ resourceId: "provider-a", kind: "codex_app_server", reason: "stop", evidence: { unsettled: 1 } })).resolves.toBeUndefined();
    expect(recordAbandonment).toHaveBeenCalledOnce();
  });
  it("keeps admission fenced when a stale retry follows final-result handoff", async () => {
    const service = registry();
    let revision = "1";
    let acknowledged = false;
    service.register({ resourceId: "terminal-a", kind: "terminal", snapshot: () => ({ state: "idle", revision, blockers: acknowledged ? [] : ["unsettled_outcome"] }),
      stop: async () => { if (!acknowledged) throw new SidecarResourceHandoffPendingError(); } });
    const controllerEpoch = service.attach(configuration);
    const request = { expectedServiceIncarnation: service.serviceIncarnation, controllerEpoch, expectedConfiguration: configuration,
      expectedResourcesFingerprint: service.status().resourcesFingerprint, force: true, reason: "stop" };
    await expect(service.stop(request)).rejects.toThrow("sidecar_resource_handoff_pending");
    acknowledged = true; revision = "2";
    await expect(service.stop(request)).rejects.toThrow("sidecar_service_confirmation_stale");
    expect(service.status().state).toBe("handoff_pending");
    expect(() => service.assertAdmission(controllerEpoch)).toThrow("sidecar_service_not_accepting_work");
    await service.stop({ ...request, expectedResourcesFingerprint: service.status().resourcesFingerprint });
    expect(service.status().state).toBe("stopped");
  });

});
