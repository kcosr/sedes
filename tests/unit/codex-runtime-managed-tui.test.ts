import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { SidecarOperationRegistry, type SidecarOperationDefinition } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import type { CodexManagedTuiBindingAuthority, CodexManagedTuiProcess, CodexManagedTuiLauncher } from "../../src/server/backends/codex/codex-managed-tui-registry.js";
import {
  CodexRuntimeManagedTuiHosts, CodexRuntimeManagedTuiLauncher, CodexRuntimeManagedTuiRegistry,
  codexManagedTuiCapability, codexManagedTuiControlOperation, codexManagedTuiOperation,
  registerCodexManagedTuiHost, type CodexManagedTuiHostRuntime,
} from "../../src/server/backends/codex/runtime/codex-runtime-managed-tui.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { SidecarRuntimeChannel } from "../../src/server/sidecar/runtime-channel.js";
import type { SidecarRuntimeBody } from "../../src/server/sidecar/runtime-body-channel.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const authority: CodexManagedTuiBindingAuthority = {
  scope, applicationThreadId: "thread", backendInstanceId: "backend", connectionProfileId: "connection",
  executionEnvironmentId: "remote", backendConversationId: "native-thread", workspaceId: "workspace",
  canonicalWorkspacePath: "/remote/workspace", opaqueBindingDetail: "native-binding", runtimeLeaseId: "main-lease", appServerGeneration: 3,
};
const settings = { model: "model", reasoningEffort: "low", sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user", serviceTier: "standard" } as const;
const configuration = { environmentRevision: 1, operationsRevision: 1 };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function processFixture() {
  const output = new PassThrough();
  const exit = deferred<{ exitCode: number | null; signal: string | null }>();
  const process = {
    output, closed: exit.promise, write: vi.fn(async (_bytes: Uint8Array) => {}), resize: vi.fn(async (_columns: number, _rows: number) => {}),
    close: vi.fn(async (_reason: string) => { output.end(); exit.resolve({ exitCode: 0, signal: null }); }),
  } satisfies CodexManagedTuiProcess;
  return { process, output, exit };
}

function fixture() {
  const services = new PersistentSidecarServiceRegistry({
    scope: { installationId: "installation", ...scope, executionEnvironmentId: "remote" },
    buildId: "build", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration,
  });
  const client = new CodexSharedClientFacade({ current: () => ({ generation: 3, request: vi.fn() as never, requestWithReceipt: vi.fn() as never }), latestGeneration: () => 3, retireGeneration: async () => {} });
  client.updateLifecycle({ state: "ready", generation: 3 });
  const runtime: CodexManagedTuiHostRuntime = {
    configuration: { scope, instance: { tenantId: scope.tenantId, id: "backend", kind: "codex_app_server", label: "Codex", enabled: true, configurationRevision: 1, protocolRelease: "0.153.0" },
      executionEnvironmentId: "remote", connection: { ownership: "external", channel: { type: "unix_websocket", socketPath: "/remote/provider.sock" } } },
    environmentChannel: {} as never, environment: { HOME: "/remote/account", PATH: "/remote/bin" }, supervisor: { client },
  };
  const processes: ReturnType<typeof processFixture>[] = [];
  const createLauncher = vi.fn((_input: unknown): CodexManagedTuiLauncher => ({ launch: vi.fn(async () => {
    const process = processFixture(); processes.push(process); return process.process;
  }) }));
  const hosts = new CodexRuntimeManagedTuiHosts({ services,
    getRuntime: id => { if (id !== "incarnation") throw new Error("unknown_runtime"); return runtime; }, createLauncher,
  });
  cleanup.push(async () => {
    for (const { output, exit } of processes) { output.end(); exit.resolve({ exitCode: 0, signal: null }); }
    await hosts.stopRuntime("incarnation");
  });
  const launcher = new CodexRuntimeManagedTuiLauncher({ settings: () => settings, validateModelSelection: vi.fn(async () => {}) });
  async function attach(offset = 0) {
    const epoch = services.attach(configuration);
    const operations = new SidecarOperationRegistry();
    const listeners = new Set<(event: unknown) => void>();
    const closed = deferred<unknown>();
    let blockedSend: Promise<void> | undefined;
    const channel = {
      supportsOperation: (definition: SidecarOperationDefinition<unknown, unknown>) => operations.resolve(definition) !== undefined,
      peer: { sendEvent: async ({ payload }: { payload: unknown }) => {
        if (blockedSend) await blockedSend;
        for (const listener of listeners) listener(payload);
      } },
      encodeBody: async (value: unknown) => ({ type: "inline", value: JSON.parse(JSON.stringify(value)) } as SidecarRuntimeBody),
      decodeBody: async (body: SidecarRuntimeBody) => { if (body.type !== "inline") throw new Error("test_body_type"); return body.value; },
      call: async <Request, Response>(definition: SidecarOperationDefinition<Request, Response>, request: Request): Promise<Response> => {
        const handler = operations.resolve(definition);
        if (!handler) throw new Error("test_operation_missing");
        const response = await handler.handler(definition.requestSchema.parse(request), { requestId: "request", signal: new AbortController().signal });
        return definition.responseSchema.parse(response);
      },
      onEvent: ({ schema, listener }: { schema: z.ZodType; listener(value: unknown): void }) => {
        const wrapped = (value: unknown) => listener(schema.parse(value));
        listeners.add(wrapped); return () => { listeners.delete(wrapped); };
      },
    } as unknown as SidecarRuntimeChannel;
    const detachHost = registerCodexManagedTuiHost({ hosts, services, registry: operations, channel, controllerEpoch: epoch });
    const attachment = { channel, runtimeId: "incarnation", controllerEpoch: epoch, providerGeneration: 3, generationOffset: offset, closed: closed.promise };
    const errors: unknown[] = [];
    const assessment = vi.fn();
    const registry = new CodexRuntimeManagedTuiRegistry({ connect: async () => attachment, onError: error => errors.push(error), onRuntimeVersionAssessment: assessment });
    await registry.connect();
    cleanup.push(async () => { detachHost(); closed.resolve(undefined); await registry.close().catch(() => {}); });
    return { registry, epoch, channel, operations, errors, assessment, attachment,
      lose: () => { detachHost(); services.detach(epoch); closed.resolve(undefined); },
      blockEvents: (waiting: Promise<void> | undefined) => { blockedSend = waiting; },
    };
  }
  return { services, client, runtime, hosts, launcher, processes, createLauncher, attach };
}

describe("persistent Codex managed TUI", () => {
  it("does not let idle cleanup release a later operator Stop fence", () => {
    const host = fixture();
    const releaseIdleFence = host.hosts.freezeAdmission("incarnation");
    host.hosts.freezeAdmission("incarnation");
    releaseIdleFence();
    expect(host.hosts.admissionFrozen("incarnation")).toBe(true);
    host.hosts.restoreAdmission("incarnation");
    expect(host.hosts.admissionFrozen("incarnation")).toBe(false);
  });

  it("rejects an attachment without negotiated TUI operations before subscribing or invoking", async () => {
    const onEvent = vi.fn();
    const call = vi.fn();
    const registry = new CodexRuntimeManagedTuiRegistry({ connect: async () => ({
      channel: { supportsOperation: () => false, onEvent, call } as unknown as SidecarRuntimeChannel,
      runtimeId: "runtime", controllerEpoch: 1, providerGeneration: 1, generationOffset: 0, closed: new Promise(() => {}),
    }) });
    await expect(registry.connect()).rejects.toThrow("codex_tui_runtime_unavailable");
    expect(onEvent).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    await registry.close();
  });

  it("retains one native TUI across main detach/restart and translates generation without respawning", async () => {
    const host = fixture();
    const first = await host.attach();
    const initial = await first.registry.start(authority, host.launcher);
    expect(initial.lifecycle).toBe("running");
    expect(host.createLauncher.mock.calls[0]?.[0]).toMatchObject({ configuration: host.runtime.configuration, environment: host.runtime.environment });
    const native = host.processes[0]!;
    await first.registry.releaseRuntime(authority);
    await first.registry.fenceAppServerGeneration(0);
    await first.registry.close();
    expect(native.process.close).not.toHaveBeenCalled();
    first.lose();
    const second = await host.attach(100);
    const rebound = { ...authority, runtimeLeaseId: "new-main-lease", appServerGeneration: 103 };
    expect(second.registry.state(rebound)).toEqual(initial);
    expect(second.registry.runningAuthority(scope, "thread")?.appServerGeneration).toBe(103);
    await second.registry.start(rebound, host.launcher);
    expect(host.processes).toHaveLength(1);
    await second.registry.stop(rebound);
    expect(native.process.close).toHaveBeenCalledOnce();
  });

  it("refreshes an existing registry after its runtime attachment changes without carrier closure", async () => {
    const host = fixture();
    const first = await host.attach();
    let attachment = first.attachment;
    const registry = new CodexRuntimeManagedTuiRegistry({ connect: async () => attachment });
    cleanup.push(async () => { await registry.close().catch(() => {}); });
    await registry.start(authority, host.launcher);
    attachment = { ...first.attachment, generationOffset: 100 };
    await registry.connect();
    const rebound = { ...authority, runtimeLeaseId: "new-main-lease", appServerGeneration: 103 };
    expect(registry.runningAuthority(scope, "thread")?.appServerGeneration).toBe(103);
    await registry.stop(rebound);
    expect(host.processes[0]!.process.close).toHaveBeenCalledOnce();
  });

  it("streams only to attached viewers and preserves existing repaint/resize/input framing", async () => {
    const host = fixture();
    const remote = await host.attach();
    const state = await remote.registry.start(authority, host.launcher);
    const output = vi.fn();
    const viewer = remote.registry.attachScopedViewer(scope, "thread", state.resourceGeneration!, { viewerId: "viewer", output, stateChanged: vi.fn() });
    await viewer.resize(100, 30);
    await viewer.input(Buffer.from("hello\r"));
    expect(host.processes[0]!.process.write).toHaveBeenCalledWith(Uint8Array.from(Buffer.from("hello\r")));
    expect(await viewer.requestSync()).toEqual({ columns: 100, rows: 30 });
    expect(host.processes[0]!.process.resize.mock.calls).toEqual([[100, 30], [101, 30], [100, 30]]);
    host.processes[0]!.output.write(Buffer.from("\x1b[2Jscreen"));
    await vi.waitFor(() => expect(output).toHaveBeenCalledWith(Buffer.from("\x1b[2Jscreen")));
    viewer.detach();
    await expect(viewer.input(Buffer.from("bad"))).rejects.toThrow("detached");
    expect(host.processes[0]!.process.close).not.toHaveBeenCalled();
  });

  it.each(["tenantId", "principalId"] as const)("denies a wrong %s binding", async axis => {
    const host = fixture();
    const remote = await host.attach();
    await expect(remote.registry.start({ ...authority, scope: { ...scope, [axis]: "other" } }, host.launcher)).rejects.toThrow("binding_denied");
    expect(host.processes).toHaveLength(0);
  });

  it.each(["backendInstanceId", "executionEnvironmentId"] as const)("denies a wrong %s binding", async axis => {
    const host = fixture();
    const remote = await host.attach();
    await expect(remote.registry.start({ ...authority, [axis]: "other" }, host.launcher)).rejects.toThrow("binding_denied");
    expect(host.processes).toHaveLength(0);
  });

  it("fences stale controller input and wrong runtime generations without killing surviving work", async () => {
    const host = fixture();
    const old = await host.attach();
    const state = await old.registry.start(authority, host.launcher);
    const viewer = old.registry.attachViewer(authority, state.resourceGeneration!, { viewerId: "viewer", output: vi.fn(), stateChanged: vi.fn() });
    await viewer.resize(100, 30);
    await host.attach(100);
    await expect(viewer.input(Buffer.from("stale"))).rejects.toThrow("controller_stale");
    expect(host.processes[0]!.process.write).not.toHaveBeenCalled();
    expect(host.processes[0]!.process.close).not.toHaveBeenCalled();
    await expect(old.registry.start({ ...authority, appServerGeneration: 4 }, host.launcher)).rejects.toThrow("controller_stale");
  });

  it("blocks safe service upgrade for a live TUI, even when main has detached", async () => {
    const host = fixture();
    const remote = await host.attach();
    await remote.registry.start(authority, host.launcher);
    remote.lose();
    const epoch = host.services.attach(configuration);
    const status = host.services.status();
    expect(status.resources[0]?.blockers).toContain("live_terminal");
    await expect(host.services.stop({ controllerEpoch: epoch, expectedServiceIncarnation: status.serviceIncarnation,
      expectedConfiguration: configuration, expectedResourcesFingerprint: status.resourcesFingerprint, force: false, reason: "upgrade" })).rejects.toThrow("upgrade_blocked");
    expect(host.processes[0]!.process.close).not.toHaveBeenCalled();
    await host.hosts.stopRuntime("incarnation");
    expect(host.processes[0]!.process.close).toHaveBeenCalled();
    expect(host.services.status().resources).toEqual([]);
  });

  it("keeps startup in the upgrade blocker inventory before a native process exists", async () => {
    const host = fixture();
    const opening = deferred<CodexManagedTuiProcess>();
    const process = processFixture();
    host.createLauncher.mockImplementation(() => ({ launch: vi.fn(async () => opening.promise) }));
    const remote = await host.attach();
    const start = remote.registry.start(authority, host.launcher);
    await vi.waitFor(() => expect(host.services.status().resources[0]?.blockers).toContain("live_terminal"));
    opening.resolve(process.process);
    await start;
    await remote.registry.stop(authority);
  });

  it("detaches a slow output consumer at bounded capacity without stopping the PTY", async () => {
    const host = fixture();
    const remote = await host.attach();
    const state = await remote.registry.start(authority, host.launcher);
    const viewer = remote.registry.attachViewer(authority, state.resourceGeneration!, { viewerId: "slow", output: vi.fn(), stateChanged: vi.fn() });
    await viewer.resize(100, 30);
    const release = deferred<void>();
    remote.blockEvents(release.promise);
    for (let index = 0; index < 40; index++) {
      host.processes[0]!.output.write(Buffer.alloc(20 * 1024, "x"));
      await new Promise(resolve => setImmediate(resolve));
    }
    await expect(viewer.input(Buffer.from("unsent"))).rejects.toThrow("attachment_detached");
    expect(host.processes[0]!.process.close).not.toHaveBeenCalled();
    expect(host.hosts.registry("incarnation").snapshot()[0]?.state.lifecycle).toBe("running");
    release.resolve();
  });

  it("declares exact closed operation inventory and retains a dedicated control lane", async () => {
    const host = fixture();
    const remote = await host.attach();
    expect(remote.operations.capabilities()).toEqual([{ ...codexManagedTuiCapability, operations: [...codexManagedTuiCapability.operations].sort() }]);
    expect(codexManagedTuiControlOperation.lane).toBe("control");
    const invalid = await remote.channel.encodeBody({ runtimeId: "incarnation", controllerEpoch: remote.epoch, action: "exec", command: "shell" });
    await expect(remote.channel.call(codexManagedTuiOperation, invalid)).rejects.toThrow();
    const wrongLane = await remote.channel.encodeBody({ runtimeId: "incarnation", controllerEpoch: remote.epoch, action: "start", authority: { ...authority, runtimeLeaseId: "incarnation" }, settings });
    await expect(remote.channel.call(codexManagedTuiControlOperation, wrongLane)).rejects.toThrow("lane_mismatch");
    expect(host.processes).toHaveLength(0);
  });

  it("rejects oversized input and malformed geometry before native controls", async () => {
    const host = fixture();
    const remote = await host.attach();
    const state = await remote.registry.start(authority, host.launcher);
    const viewer = remote.registry.attachViewer(authority, state.resourceGeneration!, { viewerId: "viewer", output: vi.fn(), stateChanged: vi.fn() });
    await expect(viewer.input(Buffer.alloc(64 * 1024 + 1))).rejects.toThrow("input_invalid");
    await expect(viewer.resize(513, 20)).rejects.toThrow();
    expect(host.processes[0]!.process.write).not.toHaveBeenCalled();
    expect(host.processes[0]!.process.resize).not.toHaveBeenCalled();
  });

  it("forwards admitted TUI executable drift and restores it from the host snapshot", async () => {
    const host = fixture();
    const remote = await host.attach();
    await remote.registry.start(authority, host.launcher);
    const input = host.createLauncher.mock.calls[0]![0] as { onRuntimeVersionAssessment(value: { version: string; newerThanTested: boolean }): void };
    input.onRuntimeVersionAssessment({ version: "0.155.0", newerThanTested: true });
    await vi.waitFor(() => expect(remote.assessment).toHaveBeenCalledWith({ version: "0.155.0", newerThanTested: true }));
    remote.lose();
    const next = await host.attach(100);
    expect(next.assessment).toHaveBeenCalledWith({ version: "0.155.0", newerThanTested: true });
  });

  it("rechecks controller authority when queued input reaches the native write boundary", async () => {
    const host = fixture();
    const remote = await host.attach();
    const state = await remote.registry.start(authority, host.launcher);
    const viewer = remote.registry.attachViewer(authority, state.resourceGeneration!, { viewerId: "viewer", output: vi.fn(), stateChanged: vi.fn() });
    await viewer.resize(100, 30);
    const blocked = deferred<void>();
    host.processes[0]!.process.write.mockImplementationOnce(async () => blocked.promise);
    const first = viewer.input(Buffer.from("first"));
    await vi.waitFor(() => expect(host.processes[0]!.process.write).toHaveBeenCalledOnce());
    const second = viewer.input(Buffer.from("queued"));
    const rejected = expect(second).rejects.toThrow("controller_stale");
    await new Promise(resolve => setImmediate(resolve));
    await host.attach(100);
    blocked.resolve();
    await first;
    await rejected;
    expect(host.processes[0]!.process.write).toHaveBeenCalledOnce();
  });

  it("never reports positive runtime cleanup when native PTY termination fails", async () => {
    const host = fixture();
    const remote = await host.attach();
    await remote.registry.start(authority, host.launcher);
    host.processes[0]!.process.close.mockRejectedValue(new Error("native_cleanup_failed"));
    await expect(host.hosts.stopRuntime("incarnation")).rejects.toThrow("native_cleanup_failed");
    expect(host.services.status().resources[0]?.blockers).toContain("live_terminal");
    expect(host.hosts.activity("incarnation")).toMatchObject({ state: "unknown", blockers: ["live_terminal", "cleanup_unproven"] });
    host.processes[0]!.exit.resolve({ exitCode: 0, signal: null });
  });

  it("reads absent-host activity without creating resources and fences creation until restored", async () => {
    const host = fixture();
    const before = host.hosts.activity("incarnation");
    expect(before).toEqual({ state: "idle", revision: "0", blockers: [] });
    expect(host.services.status().resources).toEqual([]);
    host.hosts.freezeAdmission("incarnation");
    expect(host.hosts.activity("incarnation")).toEqual(before);
    await expect(host.attach()).rejects.toThrow("admission_frozen");
    expect(host.services.status().resources).toEqual([]);
    host.hosts.restoreAdmission("incarnation");
    const remote = await host.attach();
    await remote.registry.start(authority, host.launcher);
    expect(host.hosts.activity("incarnation")).toMatchObject({ state: "active", blockers: ["live_terminal"] });
  });

  it("fences awaited launches, closes a late process, and preserves positive cleanup inventory", async () => {
    const host = fixture();
    const opening = deferred<CodexManagedTuiProcess>();
    const process = processFixture();
    host.createLauncher.mockImplementation(() => ({ launch: async () => opening.promise }));
    const remote = await host.attach();
    const start = remote.registry.start(authority, host.launcher);
    const failed = expect(start).resolves.toMatchObject({ lifecycle: "failed", streamAvailable: false });
    await vi.waitFor(() => expect(host.hosts.activity("incarnation").state).toBe("active"));
    const revision = host.hosts.activity("incarnation").revision;
    host.hosts.freezeAdmission("incarnation");
    expect(host.hosts.activity("incarnation").revision).toBe(revision);
    const launchInput = host.createLauncher.mock.calls[0]![0] as { assertLaunchAdmission(): void };
    expect(() => launchInput.assertLaunchAdmission()).toThrow("admission_frozen");
    opening.resolve(process.process);
    await failed;
    expect(process.process.close).toHaveBeenCalledWith("codex_tui_launch_admission_fenced");
    expect(host.hosts.activity("incarnation").state).toBe("idle");
  });

  it("fences native viewer controls together with backend admission", async () => {
    const host = fixture();
    const remote = await host.attach();
    const state = await remote.registry.start(authority, host.launcher);
    const viewer = remote.registry.attachViewer(authority, state.resourceGeneration!, { viewerId: "viewer", output: vi.fn(), stateChanged: vi.fn() });
    await viewer.resize(100, 30);
    const before = host.hosts.activity("incarnation");
    host.hosts.freezeAdmission("incarnation");
    expect(host.hosts.activity("incarnation")).toEqual(before);
    await expect(viewer.input(Buffer.from("blocked"))).rejects.toThrow("admission_frozen");
    await expect(viewer.resize(110, 35)).rejects.toThrow("admission_frozen");
    expect(host.processes[0]!.process.write).not.toHaveBeenCalled();
    host.hosts.restoreAdmission("incarnation");
    await viewer.input(Buffer.from("allowed"));
    expect(host.processes[0]!.process.write).toHaveBeenCalledOnce();
  });
});
