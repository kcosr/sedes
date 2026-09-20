import { afterEach, describe, expect, it, vi } from "vitest";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { SidecarRuntimeOwner, type SidecarAuthorizedCapability } from "../../src/server/sidecar/sidecar-runtime.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import { SIDECAR_ARTIFACT_ID, SIDECAR_ARTIFACT_MODES, SIDECAR_MINIMUM_NODE_VERSION } from "../../src/server/sidecar/sidecar-artifact.js";
const scope = { tenantId: "tenant", principalId: "principal" };
const configuration = { environmentRevision: 1, operationsRevision: 1 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
function fixture(authorizedCapabilities: readonly SidecarAuthorizedCapability[] = [{ capabilityId: "workspace_files", majorVersion: 7 }]) {
  let enabled = true;
  let environmentRevision = 1;
  let operationsRevision = 1;
  const environmentProbe = vi.fn<() => number | Promise<number>>(() => environmentRevision);
  const registry = new PersistentSidecarServiceRegistry({ scope: { ...scope, installationId: "installation", executionEnvironmentId: "remote" },
    configuration, buildId: "fixture", artifactSha256: "a".repeat(64), runtimeWireVersion: 7 });
  const installation = { accountHome: "/home/remote", nodeExecutable: "/usr/bin/node", envExecutable: "/usr/bin/env",
    stateRoot: "/home/remote/.local/state/sedes/sidecar", environment: { HOME: "/home/remote" }, executableDirectory: "/fixture", executablePath: "/fixture/sedes" };
  const install = vi.fn(async () => installation);
  const sessions: ReturnType<typeof makeSession>[] = [];
  const stream = async (mode: "normal" | "recovery") => {
    registry.attach(configuration, mode);
    for (const session of sessions) void session.close("replaced");
    return { installation, serviceStatus: registry.status(), bytes: { async *[Symbol.asyncIterator]() {} }, closed: new Promise<{ reason: string }>(() => {}), write: async () => {}, close: async () => {} };
  };
  const launch = vi.fn(async () => stream("normal"));
  const attachExisting = vi.fn(async () => stream("recovery"));
  const negotiated: Array<readonly SidecarAuthorizedCapability[]> = [];
  const owner = new SidecarRuntimeOwner({ scope, executionEnvironmentId: "remote", environmentConfigurationRevision: 1, operationsConfigurationRevision: 1,
    authorizedCapabilities, authorizedRuntimeCapabilities: [],
    activeEnvironmentConfigurationRevision: environmentProbe, activeOperationsConfigurationRevision: () => operationsRevision, isAutomaticConnectionEnabled: () => enabled,
    artifact: { artifactId: SIDECAR_ARTIFACT_ID, modes: SIDECAR_ARTIFACT_MODES, executableDirectory: "/fixture", executablePath: "/fixture/sedes",
      artifactSha256: "a".repeat(64), artifactBytes: 1, buildId: "fixture", minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION, nativeAssets: [] },
    provisioner: { transportKind: "ssh_stdio", install, launch, attachExisting, inspect: async () => registry.status(), inspectReceipt: async () => undefined, withdrawReceipt: async () => undefined, control: async () => undefined },
    sedesOperations: new SidecarOperationRegistry(), idleMilliseconds: 20,
    startSession: async (input) => { negotiated.push(input.authorizedCapabilities); const epoch = registry.controllerEpoch; const session = makeSession(() => registry.detach(epoch)); sessions.push(session); return session; } });
  cleanups.push(() => owner.close());
  return { owner, registry, install, launch, attachExisting, sessions, negotiated, environmentProbe,
    disable: () => { enabled = false; },
    changeEnvironment: () => { environmentRevision += 1; },
    changeOperations: () => { operationsRevision += 1; },
  };
}
function makeSession(detach: () => void) {
  const listeners = new Set<(event: string) => void>();
  let resolve!: () => void;
  const closed = new Promise<void>(done => { resolve = done; });
  const close = vi.fn(async (_reason: string) => { listeners.clear(); detach(); resolve(); });
  return { negotiatedCapabilities: [], closed, close, subscribe: (listener: (event: string) => void) => { listeners.add(listener); }, emit: (event: string) => { for (const listener of listeners) listener(event); } };
}
describe("recovery attachment ownership", () => {
  it.each([1, 2, 6])("fences recovery paused at authority probe %s across disconnect and reconnect", async (probe) => {
    const value = fixture();
    let resume!: (revision: number) => void;
    const gate = new Promise<number>(resolve => { resume = resolve; });
    for (let earlier = 1; earlier < probe; earlier += 1) value.environmentProbe.mockReturnValueOnce(1);
    value.environmentProbe.mockReturnValueOnce(gate);
    const signal = new AbortController().signal;
    const pending = value.owner.acquireAutomaticRecovery(scope, "remote", signal);
    const failed = expect(pending).rejects.toThrow("sidecar_unavailable");
    await vi.waitFor(() => expect(value.environmentProbe).toHaveBeenCalledTimes(probe));
    await value.owner.disconnect();
    await value.owner.connect(signal);
    resume(1);
    await failed;
    expect(value.attachExisting).toHaveBeenCalledTimes(probe === 6 ? 1 : 0);
    const fresh = await value.owner.acquireAutomaticRecovery(scope, "remote", signal);
    expect(fresh.session).toBe(value.sessions.at(-1));
    expect(fresh.session.close).not.toHaveBeenCalled();
    fresh.release();
  });

  it("shares one recovery controller across simultaneous callers until the final release", async () => {
    const value = fixture();
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      value.owner.acquireAutomaticRecovery(scope, "remote", signal),
      value.owner.acquireAutomaticRecovery(scope, "remote", signal),
    ]);
    expect(first.session).toBe(second.session);
    expect(value.attachExisting).toHaveBeenCalledTimes(1);
    expect(value.install).toHaveBeenCalledTimes(1);
    first.release(); first.release();
    expect(second.session.close).not.toHaveBeenCalled();
    await value.owner.assertAutomaticRecoveryActive(scope, "remote");
    second.release();
    await second.session.closed;
    expect(second.session.close).toHaveBeenCalledWith("sidecar_recovery_detached");
    expect(value.launch).not.toHaveBeenCalled();
  });

  it("preserves a shared pending attachment when one caller aborts", async () => {
    const value = fixture();
    const attach = value.attachExisting.getMockImplementation()!;
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    value.attachExisting.mockImplementation(async () => { await gate; return attach(); });
    const firstController = new AbortController();
    const first = value.owner.acquireAutomaticRecovery(scope, "remote", firstController.signal);
    const firstFailure = expect(first).rejects.toThrow("caller_cancelled");
    const second = value.owner.acquireAutomaticRecovery(scope, "remote", new AbortController().signal);
    await vi.waitFor(() => expect(value.attachExisting).toHaveBeenCalledTimes(1));
    firstController.abort(new Error("caller_cancelled"));
    await firstFailure;
    resume();
    const lease = await second;
    expect(value.attachExisting).toHaveBeenCalledTimes(1);
    expect(lease.session.close).not.toHaveBeenCalled();
    lease.release();
    await lease.session.closed;
    expect(lease.session.close).toHaveBeenCalledWith("sidecar_recovery_detached");
  });

  it("replaces a closed recovery controller while old holders release independently", async () => {
    const value = fixture();
    const signal = new AbortController().signal;
    const first = await value.owner.acquireAutomaticRecovery(scope, "remote", signal);
    await first.session.close("connection_lost");
    const second = await value.owner.acquireAutomaticRecovery(scope, "remote", signal);
    expect(second.session).not.toBe(first.session);
    expect(value.attachExisting).toHaveBeenCalledTimes(2);
    first.release();
    expect(second.session.close).not.toHaveBeenCalled();
    const third = await value.owner.acquireAutomaticRecovery(scope, "remote", signal);
    expect(third.session).toBe(second.session);
    second.release();
    expect(third.session.close).not.toHaveBeenCalled();
    third.release();
  });

  it("discards abandoned late attachments and permits a later clean acquisition", async () => {
    const value = fixture();
    const attach = value.attachExisting.getMockImplementation()!;
    let resume!: () => void;
    let closedLate = false;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    value.attachExisting.mockImplementationOnce(async () => {
      await gate;
      return { ...await attach(), close: async () => { closedLate = true; } };
    });
    const controller = new AbortController();
    const pending = value.owner.acquireAutomaticRecovery(scope, "remote", controller.signal);
    const failed = expect(pending).rejects.toThrow("caller_cancelled");
    await vi.waitFor(() => expect(value.attachExisting).toHaveBeenCalledTimes(1));
    controller.abort(new Error("caller_cancelled"));
    await failed;
    resume();
    await vi.waitFor(() => expect(closedLate).toBe(true));
    expect(value.sessions).toHaveLength(0);
    const lease = await value.owner.acquireAutomaticRecovery(scope, "remote", new AbortController().signal);
    expect(value.attachExisting).toHaveBeenCalledTimes(2);
    lease.release();
  });

  it("disconnects all shared recovery holders and borrows live normal sessions without eviction", async () => {
    const value = fixture();
    const signal = new AbortController().signal;
    const operation = await value.owner.acquireOperation(scope, "remote", signal);
    const [first, second] = await Promise.all([
      value.owner.acquireAutomaticRecovery(scope, "remote", signal),
      value.owner.acquireAutomaticRecovery(scope, "remote", signal),
    ]);
    expect(first.session).toBe(operation.session);
    expect(second.session).toBe(operation.session);
    operation.release();
    expect(value.owner.activeOperationLeaseCount).toBe(1);
    first.release();
    expect(value.owner.activeOperationLeaseCount).toBe(1);
    await value.owner.disconnect();
    expect(second.session.close).toHaveBeenCalledWith("sidecar_intentionally_disconnected");
    second.release();
    expect(value.owner.activeOperationLeaseCount).toBe(0);
    expect(value.attachExisting).not.toHaveBeenCalled();
  });

  it("closes an established automatic recovery session on explicit disconnect", async () => {
    const value = fixture();
    const recovery = await value.owner.acquireAutomaticRecovery(scope, "remote", new AbortController().signal);
    await value.owner.assertAutomaticRecoveryActive(scope, "remote");
    await value.owner.disconnect();
    expect(recovery.session.close).toHaveBeenCalledWith("sidecar_intentionally_disconnected");
    await expect(value.owner.assertAutomaticRecoveryActive(scope, "remote")).rejects.toThrow("sidecar_unavailable");
    recovery.release();
    expect(value.launch).not.toHaveBeenCalled();
  });

  it.each(["borrowed", "temporary"] as const)("revalidates disabled connection and changed revisions for %s recovery", async (kind) => {
    for (const revoke of ["disable", "changeEnvironment", "changeOperations"] as const) {
      const value = fixture();
      const signal = new AbortController().signal;
      const operation = kind === "borrowed" ? await value.owner.acquireOperation(scope, "remote", signal) : undefined;
      const recovery = await value.owner.acquireAutomaticRecovery(scope, "remote", signal);
      await value.owner.assertAutomaticRecoveryActive(scope, "remote");
      value[revoke]();
      await expect(value.owner.assertAutomaticRecoveryActive(scope, "remote")).rejects.toThrow("sidecar_unavailable");
      recovery.release(); operation?.release();
    }
  });

  it("rejects wrong-scope automatic recovery validation and validation after shutdown", async () => {
    const value = fixture();
    for (const [requestScope, environmentId] of [
      [{ ...scope, tenantId: "other" }, "remote"],
      [{ ...scope, principalId: "other" }, "remote"],
      [scope, "other"],
    ] as const) {
      await expect(value.owner.assertAutomaticRecoveryActive(requestScope, environmentId)).rejects.toThrow("sidecar_unavailable");
    }
    expect(value.install).not.toHaveBeenCalled();
    await value.owner.close();
    await expect(value.owner.assertAutomaticRecoveryActive(scope, "remote")).rejects.toThrow("sidecar_unavailable");
  });

  it("borrows a live controller without disrupting events or allowing idle eviction", async () => {
    vi.useFakeTimers();
    const value = fixture();
    const signal = new AbortController().signal;
    const operation = await value.owner.acquireOperation(scope, "remote", signal);
    const events = vi.fn(); operation.session.subscribe(events);
    const first = await value.owner.acquireRecovery(scope, "remote", signal);
    const second = await value.owner.acquireRecovery(scope, "remote", signal);
    expect(first.session).toBe(operation.session);
    expect(second.serviceStatus.controllerEpoch).toBe(operation.serviceStatus.controllerEpoch);
    expect(value.registry.controllerEpoch).toBe(operation.serviceStatus.controllerEpoch);
    expect(value.install).toHaveBeenCalledTimes(1);
    expect(value.launch).toHaveBeenCalledTimes(1);
    expect(value.attachExisting).not.toHaveBeenCalled();
    operation.release(); first.release(); first.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(operation.session.close).not.toHaveBeenCalled();
    operation.session.emit("provider-output"); expect(events).toHaveBeenCalledWith("provider-output");
    second.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(operation.session.close).toHaveBeenCalledTimes(1);
  });
  it("keeps intentional disconnection intact while using a temporary recovery attachment", async () => {
    const value = fixture();
    const signal = new AbortController().signal;
    const normal = await value.owner.acquireOperation(scope, "remote", signal); normal.release();
    value.disable(); await value.owner.disconnect();
    const recovery = await value.owner.acquireRecovery(scope, "remote", signal);
    expect(recovery.session).not.toBe(normal.session);
    expect(recovery.serviceStatus.attachmentMode).toBe("recovery");
    expect(value.attachExisting).toHaveBeenCalledTimes(1);
    await expect(value.owner.acquireOperation(scope, "remote", signal)).rejects.toThrow("sidecar_unavailable");
    recovery.release(); await Promise.resolve();
    expect(recovery.session.close).toHaveBeenCalledWith("sidecar_recovery_detached");
    expect(value.launch).toHaveBeenCalledTimes(1);
  });
  it("lets explicit owner shutdown close a borrowed session and makes release idempotent", async () => {
    const value = fixture();
    const signal = new AbortController().signal;
    const operation = await value.owner.acquireOperation(scope, "remote", signal);
    const recovery = await value.owner.acquireRecovery(scope, "remote", signal);
    operation.release();
    await value.owner.close("application_shutdown");
    expect(recovery.session.close).toHaveBeenCalledWith("application_shutdown");
    recovery.release(); recovery.release();
    expect(value.owner.activeOperationLeaseCount).toBe(0);
    await expect(value.owner.acquireRecovery(scope, "remote", signal)).rejects.toThrow("sidecar_unavailable");
    expect(value.attachExisting).not.toHaveBeenCalled();
  });

  it("requests only explicit retained-work capabilities when normal grants were removed", async () => {
    const value = fixture([]); value.disable();
    const signal = new AbortController().signal;
    await expect(value.owner.acquireOperation(scope, "remote", signal)).rejects.toThrow("sidecar_unavailable");
    const required = [{ capabilityId: "workspace_files", majorVersion: 7 }, { capabilityId: "workspace_tools", majorVersion: 2 },
      { capabilityId: "workspace_context", majorVersion: 1 }, { capabilityId: "interactive_terminal", majorVersion: 2 }] as const;
    const recovery = await value.owner.acquireRecovery(scope, "remote", signal, required);
    expect(value.negotiated).toEqual([required]);
    expect(recovery.serviceStatus.attachmentMode).toBe("recovery");
    expect(value.launch).not.toHaveBeenCalled();
    recovery.release();
    await expect(value.owner.acquireOperation(scope, "remote", signal)).rejects.toThrow("sidecar_unavailable");
  });
  it("borrows only when the live session already contains every required recovery capability", async () => {
    const value = fixture([]);
    const signal = new AbortController().signal;
    const normal = await value.owner.acquireOperation(scope, "remote", signal);
    expect(value.negotiated[0]).toEqual([]);
    const recovery = await value.owner.acquireRecovery(scope, "remote", signal, [{ capabilityId: "workspace_files", majorVersion: 7 }]);
    expect(recovery.session).not.toBe(normal.session);
    expect(value.attachExisting).toHaveBeenCalledTimes(1);
    expect(value.negotiated[1]).toEqual([{ capabilityId: "workspace_files", majorVersion: 7 }]);
    expect(recovery.serviceStatus.attachmentMode).toBe("recovery");
    normal.release(); recovery.release();
  });
  it("rejects extra authority, obsolete majors, duplicates, unpaired tools and wrong scope before transport", async () => {
    const value = fixture([]);
    const signal = new AbortController().signal;
    const invalid: unknown[] = [[{ capabilityId: "agent_tools_cli", majorVersion: 3 }], [{ capabilityId: "composer_attachments", majorVersion: 1 }],
      [{ capabilityId: "workspace_files", majorVersion: 6 }], [{ capabilityId: "workspace_tools", majorVersion: 2 }],
      [{ capabilityId: "workspace_context", majorVersion: 1 }], [{ capabilityId: "workspace_files", majorVersion: 7 }, { capabilityId: "workspace_files", majorVersion: 7 }]];
    for (const required of invalid) await expect(value.owner.acquireRecovery(scope, "remote", signal, required as readonly SidecarAuthorizedCapability[])).rejects.toThrow("sidecar_recovery_capabilities_invalid");
    await expect(value.owner.acquireRecovery({ ...scope, principalId: "other" }, "remote", signal, [{ capabilityId: "workspace_files", majorVersion: 7 }])).rejects.toThrow("sidecar_unavailable");
    expect(value.install).not.toHaveBeenCalled(); expect(value.attachExisting).not.toHaveBeenCalled(); expect(value.launch).not.toHaveBeenCalled();
  });

});

it("recovers retained work under pending revisions without granting ordinary operation admission", async () => {
  const value = fixture();
  const signal = new AbortController().signal;
  const normal = await value.owner.acquireOperation(scope, "remote", signal);
  value.changeEnvironment(); value.changeOperations();
  await value.owner.disconnectTransport("test_carrier_lost");
  normal.release();
  await expect(value.owner.acquireOperation(scope, "remote", signal)).rejects.toMatchObject({ cause: { message: "sidecar_revision_changed" } });
  const [first, second] = await Promise.all([
    value.owner.acquireRetainedRecovery(scope, "remote", signal),
    value.owner.acquireRetainedRecovery(scope, "remote", signal),
  ]);
  expect(first.session).toBe(second.session);
  expect(value.attachExisting).toHaveBeenCalledOnce();
  expect(value.launch).toHaveBeenCalledOnce();
  expect(() => value.registry.assertController(first.serviceStatus.controllerEpoch)).not.toThrow();
  expect(() => value.registry.assertAdmission(first.serviceStatus.controllerEpoch)).toThrow("sidecar_recovery_attachment_read_only");
  await expect(value.owner.acquireOperation(scope, "remote", signal)).rejects.toMatchObject({ cause: { message: "sidecar_revision_changed" } });
  await expect(value.owner.acquireRetainedRecovery({ ...scope, principalId: "other" }, "remote", signal)).rejects.toThrow();
  await value.owner.disconnect();
  await expect(value.owner.acquireRetainedRecovery(scope, "remote", signal)).rejects.toMatchObject({ cause: { message: "sidecar_intentionally_disconnected" } });
  first.release(); second.release();
});

it("replaces a cached normal-controller observation before issuing retained-only recovery", async () => {
  const value = fixture();
  const signal = new AbortController().signal;
  const normal = await value.owner.acquireOperation(scope, "remote", signal);
  const observer = await value.owner.acquireAutomaticRecovery(scope, "remote", signal);
  expect(observer.session).toBe(normal.session);
  const retained = await value.owner.acquireRetainedRecovery(scope, "remote", signal);
  expect(retained.session).not.toBe(normal.session);
  expect(() => value.registry.assertAdmission(retained.serviceStatus.controllerEpoch)).toThrow("sidecar_recovery_attachment_read_only");
  normal.release(); observer.release(); retained.release();
});

it("shares retained recovery with manual inspection without replacing its controller or closing its peer", async () => {
  const value = fixture();
  value.changeEnvironment();
  const signal = new AbortController().signal;
  const retained = await value.owner.acquireRetainedRecovery(scope, "remote", signal);
  const epoch = retained.serviceStatus.controllerEpoch;
  for (let inspection = 0; inspection < 3; inspection++) {
    const manual = await value.owner.acquireRecovery(scope, "remote", signal, [{ capabilityId: "workspace_files", majorVersion: 7 }]);
    expect(manual.session).toBe(retained.session);
    expect(manual.serviceStatus.controllerEpoch).toBe(epoch);
    manual.release(); manual.release();
    expect(retained.session.close).not.toHaveBeenCalled();
    expect(() => value.registry.assertController(epoch)).not.toThrow();
  }
  expect(value.attachExisting).toHaveBeenCalledOnce();
  expect(value.install).toHaveBeenCalledOnce();
  expect(value.launch).not.toHaveBeenCalled();
  retained.release();
  await retained.session.closed;
  expect(retained.session.close).toHaveBeenCalledOnce();
});

it("does not revive shared retained authority after Disconnect while manual readers still hold it", async () => {
  const value = fixture();
  value.changeOperations();
  const signal = new AbortController().signal;
  const retained = await value.owner.acquireRetainedRecovery(scope, "remote", signal);
  const manual = await value.owner.acquireRecovery(scope, "remote", signal);
  retained.release();
  expect(manual.session.close).not.toHaveBeenCalled();
  await value.owner.disconnect();
  await manual.session.closed;
  manual.release();
  await expect(value.owner.acquireRetainedRecovery(scope, "remote", signal)).rejects.toMatchObject({ cause: { message: "sidecar_intentionally_disconnected" } });
  expect(value.attachExisting).toHaveBeenCalledOnce();
  expect(value.launch).not.toHaveBeenCalled();
});

it("does not borrow a retained attachment for capabilities it did not grant", async () => {
  const value = fixture();
  value.changeEnvironment();
  const signal = new AbortController().signal;
  const retained = await value.owner.acquireRetainedRecovery(scope, "remote", signal);
  const manual = await value.owner.acquireRecovery(scope, "remote", signal, [{ capabilityId: "interactive_terminal", majorVersion: 2 }]);
  expect(manual.session).not.toBe(retained.session);
  expect(value.attachExisting).toHaveBeenCalledTimes(2);
  expect(value.negotiated.at(-1)).toContainEqual({ capabilityId: "interactive_terminal", majorVersion: 2 });
  retained.release(); manual.release();
});

it("joins a starting retained controller for inspection and fences both acquisitions across Disconnect", async () => {
  const value = fixture();
  const install = value.install.getMockImplementation()!;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  value.install.mockImplementationOnce(async () => { await gate; return install(); });
  value.changeEnvironment();
  const signal = new AbortController().signal;
  const retained = value.owner.acquireRetainedRecovery(scope, "remote", signal);
  const rejectedRetained = expect(retained).rejects.toThrow();
  await vi.waitFor(() => expect(value.install).toHaveBeenCalledOnce());
  const manual = value.owner.acquireRecovery(scope, "remote", signal);
  const rejectedManual = expect(manual).rejects.toThrow();
  await value.owner.disconnect();
  finish();
  await Promise.all([rejectedRetained, rejectedManual]);
  expect(value.install).toHaveBeenCalledOnce();
  expect(value.attachExisting).not.toHaveBeenCalled();
  expect(value.launch).not.toHaveBeenCalled();
});
