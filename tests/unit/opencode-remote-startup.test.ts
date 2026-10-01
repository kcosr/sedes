import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidecarRuntimeChannel, SidecarRuntimeLease } from "../../src/server/sidecar/runtime-channel.js";
import type { SidecarRuntimeBody } from "../../src/server/sidecar/runtime-body-channel.js";
import { OpenCodeRemoteRuntime } from "../../src/server/backends/opencode/opencode-remote-runtime.js";
import { openCodeRuntimeNamespaceKey } from "../../src/server/backends/opencode/opencode-runtime.js";
import type { OpenCodeRuntimeConfiguration } from "../../src/server/backends/opencode/opencode-runtime-configuration.js";
import type { OpenCodeRuntimeCommand, OpenCodeRuntimeInfo } from "../../src/server/backends/opencode/opencode-runtime-wire.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function untilAbort<T>(signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

function fixture(enabled = true) {
  const configuration: OpenCodeRuntimeConfiguration = {
    instance: { id: "backend", tenantId: "tenant", kind: "opencode", label: "OpenCode", enabled,
      configurationRevision: 1, protocolRelease: "2.0.18" },
    connections: [{ id: "connection", tenantId: "tenant", ownerPrincipalId: "principal", templateId: "template",
      kind: "opencode_http", backendInstanceId: "backend", executionEnvironmentId: "remote", label: "OpenCode", enabled,
      configurationRevision: 1 }],
    connection: { ownership: "owned", channel: { type: "process_stdio" } },
  };
  const info: OpenCodeRuntimeInfo = { runtimeId: "native-owner", nativeNamespaceKey: openCodeRuntimeNamespaceKey("remote", "/native/opencode.db"),
    snapshot: { state: "ready", ownership: "owned", generation: "native-generation", references: 0,
      identity: { pid: 123, startTime: "start", uid: 1000, executablePath: "/bin/opencode2", executable: { device: "1", inode: "2" },
        nativeStorePath: "/native/opencode.db", store: { device: "1", inode: "3" }, storeObservation: "open_file" } } };
  const respond = vi.fn(async (command: OpenCodeRuntimeCommand, _signal?: AbortSignal): Promise<unknown> => {
    if (command.action === "lookup" || command.action === "lookup_recovery" || command.action === "ensure") return info;
    if (command.action === "assert_current") return { ok: true };
    throw new Error(`Unexpected command: ${command.action}`);
  });
  const channel = {
    assertReady: vi.fn(), supportsOperation: () => true,
    encodeBody: async (value: unknown): Promise<SidecarRuntimeBody> => ({ type: "inline", value }),
    decodeBody: async (body: SidecarRuntimeBody) => { if (body.type !== "inline") throw new Error("Unexpected streamed body"); return body.value; },
    call: async (_definition: unknown, body: SidecarRuntimeBody, options?: { signal?: AbortSignal }): Promise<SidecarRuntimeBody> => {
      if (body.type !== "inline") throw new Error("Unexpected streamed body");
      return { type: "inline", value: { status: "ok", value: await respond(body.value as OpenCodeRuntimeCommand, options?.signal) } };
    },
  } as unknown as SidecarRuntimeChannel;
  const leases: SidecarRuntimeLease[] = [];
  const lease = (): SidecarRuntimeLease => {
    const value: SidecarRuntimeLease = { channel, controllerEpoch: 1, serviceIncarnation: "service", closed: new Promise(() => {}), release: vi.fn() };
    leases.push(value);
    return value;
  };
  const acquire = vi.fn(async (signal?: AbortSignal) => { signal?.throwIfAborted(); return lease(); });
  const acquireExisting = vi.fn(async (signal?: AbortSignal) => { signal?.throwIfAborted(); return lease(); });
  const acquireRecovery = vi.fn(async (signal?: AbortSignal) => { signal?.throwIfAborted(); return lease(); });
  const runtime = new OpenCodeRemoteRuntime({ configuration, provider: { acquire, acquireExisting }, acquireRecovery });
  cleanups.push(() => runtime.close());
  return { runtime, acquire, acquireExisting, acquireRecovery, lease, leases, respond, info,
    actions: () => respond.mock.calls.map(([command]) => command.action) };
}

describe("OpenCode remote startup cancellation", () => {
  it.each(["normal", "retained", "disabled", "revision"] as const)("cancels %s carrier acquisition and permits a fresh retry", async mode => {
    const f = fixture(mode !== "disabled"), entered = deferred<AbortSignal>(), controller = new AbortController();
    if (mode === "revision") f.acquire.mockRejectedValueOnce(new Error("sidecar_revision_changed"));
    const acquire = mode === "retained" ? f.acquireExisting : mode === "disabled" || mode === "revision" ? f.acquireRecovery : f.acquire;
    acquire.mockImplementationOnce(async signal => { entered.resolve(signal!); return untilAbort(signal!); });
    const start = () => mode === "retained" ? f.runtime.startRetained(controller.signal) : f.runtime.start(controller.signal);
    const cancelled = start().catch(error => error);
    const acquisition = await entered.promise;
    const reason = new Error("management startup cancelled");
    controller.abort(reason);
    expect(await cancelled).toBe(reason);
    expect(acquisition.aborted).toBe(true);
    expect(f.actions()).toEqual([]);
    await (mode === "retained" ? f.runtime.startRetained() : f.runtime.start());
    expect(f.runtime.snapshot().state).toBe("ready");
    expect(f.actions()).not.toContain("ensure");
    expect(f.actions()).not.toContain("stop");
  });

  it("close aborts pending acquisition before draining startup without stopping a daemon", async () => {
    const f = fixture(), entered = deferred<AbortSignal>();
    f.acquire.mockImplementationOnce(async signal => { entered.resolve(signal!); return untilAbort(signal!); });
    const start = f.runtime.start().catch(error => error);
    const signal = await entered.promise;
    await expect(f.runtime.close()).resolves.toEqual({ cleanup: "proved", nativeInterrupts: "not_owned" });
    expect(signal.aborted).toBe(true);
    expect(await start).toBe(signal.reason);
    expect(f.actions()).toEqual([]);
    await expect(f.runtime.start()).rejects.toThrow("opencode_runtime_unavailable");
    expect(f.acquire).toHaveBeenCalledOnce();
  });

  it.each(["lookup", "ensure"] as const)("cancels the %s wire request and releases only its attachment", async action => {
    const f = fixture(), entered = deferred<AbortSignal>(), controller = new AbortController();
    f.respond.mockImplementation(async (command, signal) => {
      if (command.action === "lookup" && action === "ensure") return null;
      expect(command.action).toBe(action);
      entered.resolve(signal!);
      return untilAbort(signal!);
    });
    const start = f.runtime.start(controller.signal).catch(error => error);
    const signal = await entered.promise;
    controller.abort(new Error("stop waiting"));
    expect(await start).toBe(controller.signal.reason);
    await f.runtime.close();
    expect(signal.aborted).toBe(true);
    expect(f.leases[0]!.release).toHaveBeenCalledOnce();
    expect(f.actions()).toEqual(action === "lookup" ? ["lookup"] : ["lookup", "ensure"]);
  });

  it("never ensures after cancellation races a missing-owner lookup", async () => {
    const f = fixture(), controller = new AbortController();
    const reason = new Error("cancelled lookup");
    f.respond.mockImplementationOnce(async () => { controller.abort(reason); return null; });
    await expect(f.runtime.start(controller.signal)).rejects.toBe(reason);
    await f.runtime.close();
    expect(f.actions()).toEqual(["lookup"]);
    expect(f.leases[0]!.release).toHaveBeenCalledOnce();
  });

  it("releases a late acquisition after cancellation and starts a fresh attempt", async () => {
    const f = fixture(), entered = deferred<void>(), pending = deferred<SidecarRuntimeLease>(), controller = new AbortController();
    f.acquire.mockImplementationOnce(async () => { entered.resolve(); return pending.promise; });
    const first = f.runtime.start(controller.signal).catch(error => error);
    await entered.promise;
    controller.abort(new Error("cancelled acquisition"));
    expect(await first).toBe(controller.signal.reason);
    const late = f.lease();
    const retry = f.runtime.start();
    pending.resolve(late);
    await retry;
    expect(late.release).toHaveBeenCalledOnce();
    expect(f.acquire).toHaveBeenCalledTimes(2);
    expect(f.actions()).toEqual(["lookup"]);
    expect(f.runtime.snapshot().state).toBe("ready");
  });

  it.each([0, 1])("cancelling shared caller %s preserves the other caller's startup", async cancelledIndex => {
    const f = fixture(), entered = deferred<AbortSignal>(), pending = deferred<SidecarRuntimeLease>();
    f.acquire.mockImplementationOnce(async signal => { entered.resolve(signal!); return pending.promise; });
    const controllers = [new AbortController(), new AbortController()];
    const starts = controllers.map(controller => f.runtime.start(controller.signal));
    const cancelled = starts[cancelledIndex]!.catch(error => error);
    const signal = await entered.promise;
    controllers[cancelledIndex]!.abort(new Error("only this caller"));
    expect(await cancelled).toBe(controllers[cancelledIndex]!.signal.reason);
    expect(signal.aborted).toBe(false);
    pending.resolve(f.lease());
    await starts[1 - cancelledIndex];
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.runtime.snapshot().state).toBe("ready");
    expect(f.leases[0]!.release).not.toHaveBeenCalled();
    expect(f.actions()).toEqual(["lookup"]);
  });

  it("keeps a retained attachment valid when promotion is cancelled and permits retry", async () => {
    const f = fixture(), entered = deferred<AbortSignal>(), controller = new AbortController();
    await f.runtime.startRetained();
    f.acquire.mockImplementationOnce(async signal => { entered.resolve(signal!); return untilAbort(signal!); });
    const promotion = f.runtime.start(controller.signal).catch(error => error);
    const signal = await entered.promise;
    controller.abort(new Error("cancel promotion"));
    expect(await promotion).toBe(controller.signal.reason);
    expect(signal.aborted).toBe(true);
    await f.runtime.startRetained();
    await f.runtime.start();
    expect(f.runtime.snapshot().state).toBe("ready");
    expect(f.acquireExisting).toHaveBeenCalledOnce();
    expect(f.acquire).toHaveBeenCalledTimes(2);
    expect(f.actions()).toEqual(["lookup_recovery", "assert_current", "lookup"]);
  });

  it("retains ordinary promotion when the retained caller cancels during shared acquisition", async () => {
    const f = fixture(), entered = deferred<AbortSignal>(), pending = deferred<SidecarRuntimeLease>(), controller = new AbortController();
    f.acquireExisting.mockImplementationOnce(async signal => { entered.resolve(signal!); return pending.promise; });
    const retained = f.runtime.startRetained(controller.signal).catch(error => error);
    const signal = await entered.promise;
    const normal = f.runtime.start();
    controller.abort(new Error("retained caller left"));
    expect(await retained).toBe(controller.signal.reason);
    expect(signal.aborted).toBe(false);
    pending.resolve(f.lease());
    await normal;
    expect(f.acquireExisting).toHaveBeenCalledOnce();
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.actions()).toEqual(["lookup_recovery", "lookup"]);
  });

  it.each([false, true])("bounds startup without a caller signal, retained=%s", async retained => {
    const f = fixture(), deadline = new AbortController(), entered = deferred<AbortSignal>();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    (retained ? f.acquireExisting : f.acquire).mockImplementationOnce(async signal => { entered.resolve(signal!); return untilAbort(signal!); });
    const start = (retained ? f.runtime.startRetained() : f.runtime.start()).catch(error => error);
    const signal = await entered.promise;
    const reason = new DOMException("Startup deadline exceeded", "TimeoutError");
    deadline.abort(reason);
    expect(await start).toBe(reason);
    expect(timeout).toHaveBeenCalledWith(45_000);
    expect(signal.aborted).toBe(true);
    expect(f.actions()).toEqual([]);
  });

  it("rejects an already aborted caller before acquiring any carrier", async () => {
    const f = fixture(), controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(f.runtime.start(controller.signal)).rejects.toBe(controller.signal.reason);
    await expect(f.runtime.startRetained(controller.signal)).rejects.toBe(controller.signal.reason);
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.acquireExisting).not.toHaveBeenCalled();
    expect(f.actions()).toEqual([]);
  });
});
