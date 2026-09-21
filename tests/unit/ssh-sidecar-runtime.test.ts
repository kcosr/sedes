import { SshInteractiveTerminalProvider } from "../../src/server/execution/ssh-interactive-terminal-provider.js";
import { describe, expect, it, vi } from "vitest";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import type { SidecarServiceStatus } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import {
  SidecarRuntimeOwner,
  SidecarSessionCleanupError,
  SidecarUnavailableError,
  type SidecarRuntimeSession,
} from "../../src/server/sidecar/sidecar-runtime.js";
import {
  SIDECAR_ARTIFACT_ID,
  SIDECAR_ARTIFACT_MODES,
  SIDECAR_MINIMUM_NODE_VERSION,
} from "../../src/server/sidecar/sidecar-artifact.js";
import { SshSidecarArtifactCleanupError } from "../../src/server/sidecar/ssh-sidecar-artifact-installer.js";
import { type SidecarArtifactInstallation, type PersistentSidecarByteStream, type SidecarProvisioner, type SidecarServiceControlBoundary } from "../../src/server/sidecar/sidecar-provisioner.js";
import { SidecarServiceManagementError } from "../../src/server/sidecar/sidecar-provisioner.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978406";
const artifact = Object.freeze({
  artifactId: SIDECAR_ARTIFACT_ID,
  modes: SIDECAR_ARTIFACT_MODES,
  executableDirectory: "/fixture",
  executablePath: "/fixture/sedes",
  artifactSha256: "a".repeat(64),
  artifactBytes: 100,
  buildId: "fixture-build",
  minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION,
  nativeAssets: [],
});
const installation = Object.freeze({
  accountHome: "/home/remote",
  nodeExecutable: "/usr/bin/node",
  envExecutable: "/usr/bin/env",
  stateRoot: "/home/remote/.local/state/sedes/sidecar",
  environment: Object.freeze({ HOME: "/home/remote", PATH: "/usr/bin:/bin" }),
  executableDirectory: "/remote/fixture",
  executablePath: "/remote/fixture/sedes",
});

function fixture(
  options: {
    readonly idleMilliseconds?: number;
    readonly sessionCloseError?: Error;
    readonly sessionCloseGate?: Promise<void>;
    readonly agentTools?: boolean;
    readonly terminal?: boolean;
    readonly terminalSupported?: boolean;
    readonly isTransportAvailable?: () => boolean;
    readonly launchError?: Error;
    readonly startError?: Error;
    readonly recoveryStatus?: SidecarServiceStatus;
    readonly servingInstallation?: SidecarArtifactInstallation;
    readonly transportKind?: string;
  } = {},
) {
  let environmentRevision = 3;
  let operationsRevision = 7;
  const install = vi.fn(async () => installation);
  const launch = vi.fn(async () => {
    if (options.launchError) throw options.launchError;
    return { ...fakeStream(), installation: options.servingInstallation ?? installation };
  });
  const onBackgroundError = vi.fn();
  const onLifecycleEvidence = vi.fn();
  const sessions: FakeSession[] = [];
  const startSession = vi.fn(async () => {
    if (options.startError) throw options.startError;
    const session = new FakeSession(
      options.sessionCloseError,
      options.sessionCloseGate,
      options.terminalSupported === true,
    );
    sessions.push(session);
    return session;
  });
  const management = { transportKind: options.transportKind ?? "ssh_stdio", ...managementInstaller(), install, launch, attachExisting: vi.fn(async () => ({ ...fakeStream(), serviceStatus: options.recoveryStatus ?? serviceStatus() })) };
  const owner = new SidecarRuntimeOwner({
    scope,
    executionEnvironmentId: environmentId,
    environmentConfigurationRevision: environmentRevision,
    operationsConfigurationRevision: operationsRevision,
    authorizedRuntimeCapabilities: [],
    isAutomaticConnectionEnabled: () => true,
    isTransportAvailable: options.isTransportAvailable,
    authorizedCapabilities: [
      { capabilityId: "workspace_files", majorVersion: 8 },
      ...(options.terminal ? [{ capabilityId: "interactive_terminal" as const, majorVersion: 2 as const }] : []),
      ...(options.agentTools
        ? ([{ capabilityId: "agent_tools_cli", majorVersion: 3 }] as const)
        : []),
    ],
    activeEnvironmentConfigurationRevision: () => environmentRevision,
    activeOperationsConfigurationRevision: () => operationsRevision,
    artifact,
    provisioner: management,
    sedesOperations: new SidecarOperationRegistry(),
    startSession,
    onLifecycleEvidence,
    onBackgroundError,
    ...(options.idleMilliseconds
      ? { idleMilliseconds: options.idleMilliseconds }
      : {}),
  });
  return {
    owner,
    provisioner: management,
    install,
    launch,
    startSession,
    onBackgroundError,
    onLifecycleEvidence,
    sessions,
    setEnvironmentRevision(value: number) {
      environmentRevision = value;
    },
    setOperationsRevision(value: number) {
      operationsRevision = value;
    },
  };
}

describe("SidecarRuntimeOwner", () => {
  it("does not enter the actor boundary or retire a live carrier when provisioner staging fails", async () => {
    const value = fixture();
    const lease = await value.owner.acquireOperation(scope, environmentId, new AbortController().signal);
    const failure = new Error("sidecar_service_staging_failed");
    value.provisioner.control.mockRejectedValueOnce(failure);
    const boundary = vi.fn<SidecarServiceControlBoundary>(effect => effect());
    const current = serviceStatus();
    await expect(value.owner.controlService({ mutationId: "restart", operation: "restart", expectedServiceIncarnation: current.serviceIncarnation,
      controllerEpoch: current.controllerEpoch, expectedConfiguration: current.desiredConfiguration, expectedResourcesFingerprint: current.resourcesFingerprint, force: true },
    new AbortController().signal, boundary)).rejects.toBe(failure);
    expect(boundary).not.toHaveBeenCalled();
    expect(value.sessions[0]!.close).not.toHaveBeenCalled();
    lease.release();
    await value.owner.close();
  });

  it.each([true, false])("retires the attachment before releasing control admission (explicit boundary=%s)", async explicit => {
    const gate = deferred<void>();
    const value = fixture({ sessionCloseGate: gate.promise });
    const lease = await value.owner.acquireOperation(scope, environmentId, new AbortController().signal);
    let completed = false;
    const boundary = vi.fn<SidecarServiceControlBoundary>(async effect => {
      const result = await effect(); completed = true; return result;
    });
    const current = serviceStatus();
    const control = value.owner.controlService({ mutationId: "restart", operation: "restart", expectedServiceIncarnation: current.serviceIncarnation,
      controllerEpoch: current.controllerEpoch, expectedConfiguration: current.desiredConfiguration, expectedResourcesFingerprint: current.resourcesFingerprint, force: true },
    new AbortController().signal, explicit ? boundary : undefined);
    await vi.waitFor(() => expect(value.sessions[0]!.close).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    gate.resolve();
    await expect(control).resolves.toEqual(current);
    expect(boundary).toHaveBeenCalledTimes(explicit ? 1 : 0);
    expect(completed).toBe(explicit);
    lease.release();
    await value.owner.close();
  });
  it("keeps automatic recovery eligible through transport loss without clearing explicit disconnect", async () => {
    let connected = true;
    const value = fixture({ isTransportAvailable: () => connected });
    const signal = new AbortController().signal;
    const first = await value.owner.acquireOperation(scope, environmentId, signal);
    connected = false;
    const transportFailure = expect.objectContaining({ cause: expect.objectContaining({ message: "sidecar_transport_unavailable" }) });
    // Presence gates admission even before its queued retirement callback runs.
    await expect(value.owner.assertAutomaticRecoveryActive(scope, environmentId)).rejects.toEqual(transportFailure);
    await value.owner.disconnectTransport("outbound_connection_lost");
    expect(first.session.close).toHaveBeenCalledWith("outbound_connection_lost");
    await expect(value.owner.acquireAutomaticRecovery(scope, environmentId, signal)).rejects.toEqual(transportFailure);
    expect(value.provisioner.attachExisting).not.toHaveBeenCalled();
    connected = true;
    const recovered = await value.owner.acquireAutomaticRecovery(scope, environmentId, signal);
    expect(recovered.session).not.toBe(first.session);
    recovered.release(); first.release();
    await value.owner.disconnect();
    await value.owner.disconnectTransport("outbound_connection_lost");
    await expect(value.owner.assertAutomaticRecoveryActive(scope, environmentId)).rejects.toMatchObject({ cause: { message: "sidecar_intentionally_disconnected" } });
    await value.owner.close();
  });

  it("passes the serving installation and outbound carrier identity without rewriting foreign paths", async () => {
    const serving = { ...installation, accountHome: "C:\\Users\\remote", stateRoot: "C:\\Sedes", executableDirectory: "C:\\Sedes\\artifacts\\old", executablePath: "C:\\Sedes\\artifacts\\old\\sedes" };
    const value = fixture({ servingInstallation: serving, transportKind: "outbound_websocket" });
    const lease = await value.owner.acquireOperation(scope, environmentId, new AbortController().signal);
    expect(value.startSession).toHaveBeenCalledWith(expect.objectContaining({ installation: serving, transportKind: "outbound_websocket" }));
    lease.release();
    await value.owner.close();
  });

  it("handshakes recovery against the observed old artifact identity", async () => {
    const oldStatus = { ...serviceStatus(), buildId: "old-build", artifactSha256: "c".repeat(64), attachmentMode: "recovery" as const };
    const value = fixture({ recoveryStatus: oldStatus });
    const lease = await value.owner.acquireRecovery(scope, environmentId, AbortSignal.timeout(2000));
    expect(value.startSession).toHaveBeenCalledWith(expect.objectContaining({ artifact: oldStatus }));
    expect(value.launch).not.toHaveBeenCalled();
    lease.release();
    await value.owner.close();
  });

  it("exposes only the current negotiated capability inventory", async () => {
    const value = fixture();
    expect(value.owner.negotiatedCapabilities).toEqual([]);
    const lease = await value.owner.acquireOperation(scope, environmentId, new AbortController().signal);
    expect(value.owner.negotiatedCapabilities).toEqual(lease.session.negotiatedCapabilities);
    expect(value.owner.negotiatedCapabilities.some(capability => capability.capabilityId === "interactive_terminal")).toBe(false);
    lease.release();
    await value.owner.disconnect();
    expect(value.owner.negotiatedCapabilities).toEqual([]);
    await value.owner.close();
  });

  it.each([true, false])("retains verified PTY capability through idle and gates explicit disconnect (PTY=%s)", async terminalSupported => {
    vi.useFakeTimers();
    let connected = true;
    const value = fixture({ idleMilliseconds: 5000, terminal: true, terminalSupported, isTransportAvailable: () => connected });
    const provider = new SshInteractiveTerminalProvider({ scope, environmentId, enabled: true, configurationRevision: 3, activeConfigurationRevision: () => 3,
      runtime: value.owner as unknown as ConstructorParameters<typeof SshInteractiveTerminalProvider>[0]["runtime"] });
    try {
      expect(provider.availability(scope, environmentId)).toBe("available");
      expect(value.owner.canAcquireCapability("interactive_terminal", 2)).toBe(true);
      expect(value.owner.canAcquireCapability("interactive_terminal", 99)).toBe(false);
      const first = await value.owner.acquireOperation(scope, environmentId, new AbortController().signal);
      expect(value.owner.canAcquireCapability("interactive_terminal", 2)).toBe(terminalSupported);
      // Registry presence disappears synchronously, before the queued owner
      // disconnect has retired this still-live session.
      connected = false;
      expect(provider.availability(scope, environmentId)).toBe("unavailable");
      expect(value.owner.negotiatedCapabilities).toEqual([]);
      await expect(value.owner.acquireOperation(scope, environmentId, new AbortController().signal)).rejects.toThrow("sidecar_unavailable");
      expect(value.sessions[0]!.close).not.toHaveBeenCalled();
      connected = true;
      first.release();
      await vi.advanceTimersByTimeAsync(5000);
      expect(value.sessions[0]!.close).toHaveBeenCalledWith("sidecar_idle_expired");
      expect(value.owner.negotiatedCapabilities).toEqual(first.session.negotiatedCapabilities);
      expect(value.owner.canAcquireCapability("interactive_terminal", 2)).toBe(terminalSupported);
      expect(provider.availability(scope, environmentId)).toBe(terminalSupported ? "available" : "unavailable");
      connected = false;
      expect(provider.availability(scope, environmentId)).toBe("unavailable");
      expect(value.owner.negotiatedCapabilities).toEqual([]);
      connected = true;
      const second = await value.owner.acquireOperation(scope, environmentId, new AbortController().signal);
      expect(second.carrierGeneration).toBe(2);
      second.release();
      await value.owner.disconnect();
      expect(value.owner.canAcquireCapability("interactive_terminal", 2)).toBe(false);
      await expect(value.owner.acquireOperation(scope, environmentId, new AbortController().signal)).rejects.toThrow("sidecar_unavailable");
    } finally { await value.owner.close(); vi.useRealTimers(); }
  });

  it.each(["held", "released"])("joins %s recovery retirement before normal acquisition", async disposition => {
    const gate = deferred<void>();
    const value = fixture({ sessionCloseGate: gate.promise, transportKind: "outbound_websocket" });
    const recovery = await value.owner.acquireRecovery(scope, environmentId, new AbortController().signal);
    if (disposition === "released") recovery.release();
    const normal = value.owner.acquireOperation(scope, environmentId, new AbortController().signal);
    await vi.waitFor(() => expect(recovery.session.close).toHaveBeenCalledTimes(1));
    expect(value.launch).not.toHaveBeenCalled();
    gate.resolve();
    const lease = await normal;
    expect(lease.carrierGeneration).toBe(2);
    expect(value.launch).toHaveBeenCalledTimes(1);
    recovery.release();
    expect(recovery.session.close).toHaveBeenCalledTimes(1);
    lease.release();
    await value.owner.close();
  });

  it("retains recovery cleanup failure as a normal-admission barrier", async () => {
    const value = fixture({ sessionCloseError: new Error("recovery_cleanup_failed") });
    const recovery = await value.owner.acquireRecovery(scope, environmentId, new AbortController().signal);
    recovery.release();
    await expect(value.owner.acquireOperation(scope, environmentId, new AbortController().signal)).rejects.toThrow();
    expect(value.launch).not.toHaveBeenCalled();
    await expect(value.owner.close()).rejects.toThrow();
  });

  it("emits one ready observation per admitted carrier generation", async () => {
    const value = fixture();
    const first = await value.owner.acquireOperation(
      scope,
      environmentId,
      new AbortController().signal,
    );
    const second = await value.owner.acquireOperation(
      scope,
      environmentId,
      new AbortController().signal,
    );

    expect(value.onLifecycleEvidence.mock.calls).toEqual([
      [{ availability: "available" }],
    ]);
    first.release();
    second.release();
    await value.owner.close();
  });

  it("emits unavailable after an unexpected clean session settlement", async () => {
    const value = fixture();
    const lease = await value.owner.acquireOperation(
      scope,
      environmentId,
      new AbortController().signal,
    );
    lease.release();
    value.sessions[0]!.settle();

    await vi.waitFor(() =>
      expect(value.onLifecycleEvidence).toHaveBeenLastCalledWith({
        availability: "unavailable",
        diagnosticCode: "sidecar_session_failed",
      }),
    );
    await value.owner.close();
  });

  it("does not emit unavailable for idle retirement or shutdown", async () => {
    vi.useFakeTimers();
    try {
      const value = fixture({ idleMilliseconds: 5_000 });
      const lease = await value.owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      );
      lease.release();
      await vi.advanceTimersByTimeAsync(5_000);
      await value.owner.close("application_shutdown");

      expect(value.onLifecycleEvidence.mock.calls).toEqual([
        [{ availability: "available" }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits carrier failure when managed SSH launch fails", async () => {
    const value = fixture({ launchError: new Error("ssh_spawn_failed") });

    await expect(
      value.owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SidecarUnavailableError);
    expect(value.onLifecycleEvidence).toHaveBeenCalledWith({
      availability: "unavailable",
      diagnosticCode: "sidecar_carrier_failed",
    });
    await value.owner.close();
  });

  it("replaces a compatible outdated service automatically once connect observes it idle", async () => {
    const value = fixture();
    const outdated: SidecarServiceStatus = { ...serviceStatus(), serviceIncarnation: "service-old", buildId: "old-build", artifactSha256: "c".repeat(64) };
    const installer = value.provisioner;
    installer.inspect.mockResolvedValueOnce(outdated);
    const status = await value.owner.connect(new AbortController().signal);
    expect(installer.control).toHaveBeenCalledOnce();
    expect(installer.control).toHaveBeenCalledWith(expect.objectContaining({ operation: "upgrade", force: false, expectedServiceIncarnation: "service-old", controllerEpoch: outdated.controllerEpoch }), expect.anything());
    expect(status.serviceIncarnation).toBe("service-1");
    expect(value.startSession).toHaveBeenCalledTimes(2);
    await value.owner.close();
  });

  it("keeps serving through a compatible outdated service that still owns work", async () => {
    const value = fixture();
    const busy: SidecarServiceStatus = { ...serviceStatus(), serviceIncarnation: "service-old", buildId: "old-build", artifactSha256: "c".repeat(64),
      resources: [{ resourceId: "terminal", kind: "terminal", state: "active", revision: "1", blockers: ["live_terminal"] }] };
    value.provisioner.inspect.mockResolvedValue(busy);
    const status = await value.owner.connect(new AbortController().signal);
    expect(value.provisioner.control).not.toHaveBeenCalled();
    expect(status.buildId).toBe("old-build");
    expect(value.startSession).toHaveBeenCalledOnce();
    await value.owner.close();
  });

  it("does not report a refused or deferred admission as a carrier failure", async () => {
    const value = fixture({ launchError: new SidecarServiceManagementError("sidecar_service_upgrade_blocked") });

    const failure = await value.owner.acquireOperation(scope, environmentId, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SidecarUnavailableError);
    expect((failure as Error).cause).toBeInstanceOf(SidecarServiceManagementError);
    expect(value.onLifecycleEvidence).not.toHaveBeenCalled();
    await value.owner.close();
  });

  it("does not turn a sidecar-local handshake rejection into environment evidence", async () => {
    const value = fixture({
      startError: new Error("sidecar_capability_mismatch"),
    });

    await expect(
      value.owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SidecarUnavailableError);
    expect(value.onLifecycleEvidence).not.toHaveBeenCalled();
    await value.owner.close();
  });

  it("joins concurrent first operations into one install, carrier, and session", async () => {
    const value = fixture();
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      value.owner.acquireOperation(scope, environmentId, signal),
      value.owner.acquireOperation(scope, environmentId, signal),
    ]);
    expect(value.install).toHaveBeenCalledTimes(1);
    expect(value.launch).toHaveBeenCalledTimes(1);
    expect(value.startSession).toHaveBeenCalledTimes(1);
    expect(first.session).toBe(second.session);
    expect(first.carrierGeneration).toBe(1);
    expect(first.serviceStatus).toEqual(serviceStatus());
    expect(value.owner.activeOperationLeaseCount).toBe(2);
    first.release();
    second.release();
    await value.owner.close();
  });

  it("evicts only after both operation and watch leases reach zero", async () => {
    vi.useFakeTimers();
    try {
      const value = fixture({ idleMilliseconds: 5_000 });
      const signal = new AbortController().signal;
      const operation = await value.owner.acquireOperation(
        scope,
        environmentId,
        signal,
      );
      const watch = await value.owner.acquireWatch(
        scope,
        environmentId,
        signal,
      );
      operation.release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(value.sessions[0]?.close).not.toHaveBeenCalled();
      watch.release();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(value.sessions[0]?.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(value.sessions[0]?.close).toHaveBeenCalledWith(
        "sidecar_idle_expired",
      );
      await value.owner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for idle retirement before starting a replacement generation", async () => {
    vi.useFakeTimers();
    try {
      const closeGate = deferred<void>();
      const value = fixture({
        idleMilliseconds: 5_000,
        sessionCloseGate: closeGate.promise,
      });
      const signal = new AbortController().signal;
      const first = await value.owner.acquireOperation(
        scope,
        environmentId,
        signal,
      );
      first.release();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(value.sessions[0]?.close).toHaveBeenCalledWith(
        "sidecar_idle_expired",
      );

      const replacement = value.owner.acquireOperation(
        scope,
        environmentId,
        signal,
      );
      await Promise.resolve();
      expect(value.install).toHaveBeenCalledTimes(1);
      closeGate.resolve();
      const second = await replacement;
      expect(value.install).toHaveBeenCalledTimes(2);
      expect(second.carrierGeneration).toBe(2);
      expect(second.serviceStatus.serviceIncarnation).toBe(first.serviceStatus.serviceIncarnation);
      second.release();
      await value.owner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the generation while an agent-tool lease is active", async () => {
    vi.useFakeTimers();
    try {
      const value = fixture({ idleMilliseconds: 5_000, agentTools: true });
      const signal = new AbortController().signal;
      const operation = await value.owner.acquireOperation(
        scope,
        environmentId,
        signal,
      );
      const agentTools = await value.owner.acquireAgentTools(
        scope,
        environmentId,
        signal,
      );
      operation.release();
      expect(value.owner.activeOperationLeaseCount).toBe(0);
      expect(value.owner.activeAgentToolLeaseCount).toBe(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(value.sessions[0]?.close).not.toHaveBeenCalled();

      agentTools.release();
      expect(value.owner.activeAgentToolLeaseCount).toBe(0);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(value.sessions[0]?.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(value.sessions[0]?.close).toHaveBeenCalledWith(
        "sidecar_idle_expired",
      );
      await value.owner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when agent tools are not an authorized capability", async () => {
    const value = fixture();
    await expect(
      value.owner.acquireAgentTools(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SidecarUnavailableError);
    expect(value.install).not.toHaveBeenCalled();
    expect(value.owner.activeAgentToolLeaseCount).toBe(0);
    await value.owner.close();
  });

  it("fences environment and operations revisions without a fallback", async () => {
    const value = fixture();
    value.setOperationsRevision(8);
    await expect(
      value.owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SidecarUnavailableError);
    expect(value.install).not.toHaveBeenCalled();

    const other = fixture();
    other.setEnvironmentRevision(4);
    await expect(
      other.owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      diagnosticCode: "sidecar_unavailable",
    });
    expect(other.launch).not.toHaveBeenCalled();
  });

  it("closes and evicts the admitted generation when its revision becomes stale", async () => {
    const value = fixture();
    const watch = await value.owner.acquireWatch(
      scope,
      environmentId,
      new AbortController().signal,
    );
    value.setOperationsRevision(8);

    await expect(
      value.owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SidecarUnavailableError);
    expect(value.sessions[0]?.close).toHaveBeenCalledWith(
      "sidecar_revision_changed",
    );
    expect(value.onLifecycleEvidence.mock.calls).toEqual([
      [{ availability: "available" }],
    ]);

    watch.release();
    await value.owner.close();
  });

  it("propagates ownership-critical session cleanup failures", async () => {
    const cleanupFailure = new Error("session_cleanup_failed");
    const value = fixture({ sessionCloseError: cleanupFailure });
    const lease = await value.owner.acquireOperation(
      scope,
      environmentId,
      new AbortController().signal,
    );

    await expect(value.owner.close("application_shutdown")).rejects.toBe(
      cleanupFailure,
    );
    lease.release();
  });

  it("retains a failed idle retirement as a terminal ownership failure", async () => {
    vi.useFakeTimers();
    try {
      const cleanupFailure = new Error("idle_cleanup_failed");
      const value = fixture({
        idleMilliseconds: 5_000,
        sessionCloseError: cleanupFailure,
      });
      const lease = await value.owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      );
      lease.release();

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() =>
        expect(value.onBackgroundError).toHaveBeenCalledWith(cleanupFailure),
      );
      await expect(
        value.owner.acquireOperation(
          scope,
          environmentId,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ cause: cleanupFailure });
      expect(value.startSession).toHaveBeenCalledTimes(1);
      await expect(value.owner.close("application_shutdown")).rejects.toBe(
        cleanupFailure,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains failed startup cleanup and denies retry and clean shutdown", async () => {
    const cleanupFailure = new Error("startup_stream_cleanup_failed");
    const install = vi.fn(async () => installation);
    const stream = fakeStream();
    const close = vi.fn(async () => {
      throw cleanupFailure;
    });
    const owner = new SidecarRuntimeOwner({
      scope,
      executionEnvironmentId: environmentId,
      environmentConfigurationRevision: 3,
      operationsConfigurationRevision: 7,
      authorizedRuntimeCapabilities: [],
      isAutomaticConnectionEnabled: () => true,
      authorizedCapabilities: [
        { capabilityId: "workspace_files", majorVersion: 8 },
      ],
      activeEnvironmentConfigurationRevision: () => 3,
      activeOperationsConfigurationRevision: () => 7,
      artifact,
      provisioner: { transportKind: "ssh_stdio",
        ...managementInstaller(),
        install,
        launch: vi.fn(async () => ({ ...stream, close })),
      },
      sedesOperations: new SidecarOperationRegistry(),
      startSession: vi.fn(async () => {
        throw new Error("hello_failed");
      }),
    });

    await expect(
      owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ cause: cleanupFailure });
    await expect(
      owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ cause: cleanupFailure });
    expect(install).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(owner.close("application_shutdown")).rejects.toBe(
      cleanupFailure,
    );
  });

  it("terminalizes artifact bootstrap cleanup-proof failure", async () => {
    const cleanupFailure = new SshSidecarArtifactCleanupError({
      cause: new Error("bootstrap_child_survived"),
    });
    const install = vi.fn(async () => {
      throw cleanupFailure;
    });
    const owner = new SidecarRuntimeOwner({
      scope,
      executionEnvironmentId: environmentId,
      environmentConfigurationRevision: 3,
      operationsConfigurationRevision: 7,
      authorizedRuntimeCapabilities: [],
      isAutomaticConnectionEnabled: () => true,
      authorizedCapabilities: [
        { capabilityId: "workspace_files", majorVersion: 8 },
      ],
      activeEnvironmentConfigurationRevision: () => 3,
      activeOperationsConfigurationRevision: () => 7,
      artifact,
      provisioner: { transportKind: "ssh_stdio", ...managementInstaller(), install, launch: vi.fn() },
      sedesOperations: new SidecarOperationRegistry(),
      startSession: vi.fn(),
    });

    await expect(
      owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ cause: cleanupFailure });
    await expect(
      owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ cause: cleanupFailure });
    expect(install).toHaveBeenCalledTimes(1);
    await expect(owner.close("application_shutdown")).rejects.toBe(
      cleanupFailure,
    );
  });

  it("terminalizes autonomous session cleanup-proof failure", async () => {
    const value = fixture();
    const first = await value.owner.acquireOperation(
      scope,
      environmentId,
      new AbortController().signal,
    );
    first.release();
    const cleanupFailure = new SidecarSessionCleanupError({
      cause: new Error("autonomous_child_survived"),
    });
    value.sessions[0]!.fail(cleanupFailure);
    await vi.waitFor(() =>
      expect(value.onBackgroundError).toHaveBeenCalledWith(cleanupFailure),
    );

    await expect(
      value.owner.acquireOperation(
        scope,
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ cause: cleanupFailure });
    expect(value.startSession).toHaveBeenCalledTimes(1);
    await expect(value.owner.close("application_shutdown")).rejects.toBe(
      cleanupFailure,
    );
    expect(value.onLifecycleEvidence.mock.calls).toEqual([
      [{ availability: "available" }],
    ]);
  });

  it("retries after ordinary autonomous session failure with proven cleanup", async () => {
    const value = fixture();
    const first = await value.owner.acquireOperation(
      scope,
      environmentId,
      new AbortController().signal,
    );
    first.release();
    value.sessions[0]!.fail(new Error("remote_protocol_failed"));
    await vi.waitFor(() => expect(value.startSession).toHaveBeenCalledTimes(1));

    const second = await value.owner.acquireOperation(
      scope,
      environmentId,
      new AbortController().signal,
    );
    expect(value.startSession).toHaveBeenCalledTimes(2);
    second.release();
    await value.owner.close();
  });

  it("treats an aborted in-flight start as expected shutdown", async () => {
    const install = vi.fn(
      async (signal: AbortSignal) =>
        await new Promise<SidecarArtifactInstallation>(
          (_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          },
        ),
    );
    const owner = new SidecarRuntimeOwner({
      scope,
      executionEnvironmentId: environmentId,
      environmentConfigurationRevision: 3,
      operationsConfigurationRevision: 7,
      authorizedRuntimeCapabilities: [],
      isAutomaticConnectionEnabled: () => true,
      authorizedCapabilities: [
        { capabilityId: "workspace_files", majorVersion: 8 },
      ],
      activeEnvironmentConfigurationRevision: () => 3,
      activeOperationsConfigurationRevision: () => 7,
      artifact,
      provisioner: { transportKind: "ssh_stdio", ...managementInstaller(), install, launch: vi.fn() },
      sedesOperations: new SidecarOperationRegistry(),
      startSession: vi.fn(),
    });
    const acquisition = owner.acquireOperation(
      scope,
      environmentId,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());

    await expect(owner.close("application_shutdown")).resolves.toBeUndefined();
    await expect(acquisition).rejects.toBeInstanceOf(
      SidecarUnavailableError,
    );
  });

  it("rejects wrong scope and closes an admitted session immediately", async () => {
    const value = fixture();
    await expect(
      value.owner.acquireOperation(
        { ...scope, principalId: "other" },
        environmentId,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SidecarUnavailableError);
    const lease = await value.owner.acquireOperation(
      scope,
      environmentId,
      new AbortController().signal,
    );
    await value.owner.close("application_shutdown");
    expect(value.sessions[0]?.close).toHaveBeenCalledWith(
      "application_shutdown",
    );
    lease.release();
  });
});

class FakeSession implements SidecarRuntimeSession {
  readonly negotiatedCapabilities: SidecarRuntimeSession["negotiatedCapabilities"];
  readonly #closed = deferred<void>();
  readonly #closeError: Error | undefined;
  readonly #closeGate: Promise<void> | undefined;
  readonly closed = this.#closed.promise;
  readonly close = vi.fn(async () => {
    await this.#closeGate;
    this.#closed.resolve();
    if (this.#closeError) throw this.#closeError;
  });

  constructor(closeError?: Error, closeGate?: Promise<void>, terminalSupported = false) {
    this.negotiatedCapabilities = [{ capabilityId: "workspace_files", majorVersion: 8, operations: ["root.open"] }, ...(terminalSupported ? [{ capabilityId: "interactive_terminal", majorVersion: 2, operations: ["terminal.prepare"] }] : [])];
    this.#closeError = closeError;
    this.#closeGate = closeGate;
  }

  fail(error: Error): void {
    this.#closed.reject(error);
  }

  settle(): void {
    this.#closed.resolve();
  }
}

function fakeStream(): PersistentSidecarByteStream {
  return {
    installation,
    serviceStatus: serviceStatus(),
    bytes: (async function* () {})(),
    closed: new Promise(() => undefined),
    write: async () => undefined,
    close: async () => undefined,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function serviceStatus(): SidecarServiceStatus {
  return {
    scope: { installationId: "installation", ...scope, executionEnvironmentId: environmentId },
    serviceIncarnation: "service-1", buildId: artifact.buildId,
    artifactSha256: artifact.artifactSha256, runtimeWireVersion: SIDECAR_WIRE_VERSION,
    controllerEpoch: 1, attached: true, attachmentMode: "normal", state: "ready",
    desiredConfiguration: { environmentRevision: 3, operationsRevision: 7 },
    effectiveConfiguration: { environmentRevision: 3, operationsRevision: 7 },
    configurationState: "applied", resources: [], resourcesFingerprint: "b".repeat(64),
  };
}

function managementInstaller() {
  return {
    inspect: vi.fn(async () => serviceStatus()),
    inspectReceipt: vi.fn(async () => undefined),
    withdrawReceipt: vi.fn(async () => undefined),
    attachExisting: vi.fn(async () => fakeStream()),
    control: vi.fn<SidecarProvisioner["control"]>(async (_input, _signal, boundary = effect => effect()) => await boundary(async () => serviceStatus())),
  };
}
