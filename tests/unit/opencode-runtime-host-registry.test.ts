import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeRuntimeHostRegistry, type OpenCodeRuntimeConfiguration } from "../../src/server/backends/opencode/opencode-runtime-host-registry.js";
import type { OpenCodeRuntime, OpenCodeRuntimeInput, OpenCodeRuntimeSnapshot } from "../../src/server/backends/opencode/opencode-runtime.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeNativeHost } from "../../src/server/backends/opencode/opencode-native-host.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";

const scope = { tenantId: "tenant", principalId: "principal" }, executionEnvironmentId = "environment";
const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
const configuration: OpenCodeRuntimeConfiguration = {
  instance: { id: "backend", ...{ tenantId: scope.tenantId }, kind: "opencode", label: "OpenCode", enabled: true, configurationRevision: 1, protocolRelease: "2.0.18" },
  connections: [{ id: "connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "template", kind: "opencode_http", backendInstanceId: "backend", executionEnvironmentId, label: "OpenCode", enabled: true, configurationRevision: 1 }],
  nativeStorePath: "/native/opencode.db", configDirectory: "/native/config",
  connection: { ownership: "owned", channel: { type: "process_stdio", executablePath: "/bin/opencode2", workingDirectory: "/workspace" } },
};
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture(createHost?: (runtimeId: string) => OpenCodeNativeHost) {
  const archive = vi.fn(async (_record: unknown) => {});
  const services = new PersistentSidecarServiceRegistry({ scope: { ...scope, installationId: "installation", executionEnvironmentId }, buildId: "build", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration: serviceConfiguration, recordAbandonment: archive });
  const epoch = services.attach(serviceConfiguration), owners: FakeRuntime[] = [];
  const controls = { beforeLaunch: undefined as ReturnType<typeof deferred> | undefined, afterLaunch: undefined as ReturnType<typeof deferred> | undefined,
    cleanupFailure: false, startupFailure: false, created: vi.fn(), launched: vi.fn(), signals: vi.fn() };
  class FakeRuntime {
    readonly runtimeId = randomUUID();
    readonly liveHost = createHost?.(this.runtimeId);
    generation = "native-generation";
    state: OpenCodeRuntimeSnapshot["state"] = "stopped";
    frozen = false; revision = 0; retained = 0; active: number | null = null; interactions: number | null = null;
    startPromise?: Promise<void>;
    readonly host = {
      freezeAdmission: () => { this.frozen = true; }, restoreAdmission: () => { this.frozen = false; }, prepareRetirement: vi.fn(async () => {}),
      retentionSnapshot: () => ({ revision: String(this.revision), threadIds: this.retained ? ["retained-thread"] : [], pendingMutationCount: 0, retainedMutationCount: this.retained,
        pendingInteractionCount: this.interactions, activeWorkCount: this.active,
        observation: { pendingEvidenceCount: 0, nativeConnected: true, currentInputCount: 0, retentionExhausted: false } }),
      snapshot: () => ({ operations: this.retained ? [{ identity: { origin: "application", applicationOperationId: "retained-operation", operationKind: "submit", step: "prompt" }, status: "unknown" }] : [] }),
    };
    constructor(readonly input: OpenCodeRuntimeInput) { controls.created(); owners.push(this); }
    get nativeHost() { return this.state === "ready" || this.state === "cleanup_unproved" ? this.liveHost ?? this.host : undefined; }
    snapshot() { return { state: this.state, ownership: this.input.connection.ownership, generation: this.state === "ready" ? this.generation : undefined, references: 0 }; }
    start() {
      this.state = "starting";
      return this.startPromise = (async () => {
        try {
          await controls.beforeLaunch?.promise;
          this.input.assertLaunchAdmission?.(); controls.launched();
          await controls.afterLaunch?.promise;
          if (controls.startupFailure) throw new Error("startup failed");
          this.state = "ready";
        } catch (cause) { this.state = controls.cleanupFailure ? "cleanup_unproved" : "stopped"; throw cause; }
      })();
    }
    async close() {
      await this.startPromise?.catch(() => undefined);
      if (this.input.connection.ownership === "owned") controls.signals();
      if (controls.cleanupFailure) { this.state = "cleanup_unproved"; throw new Error("descendants uncertain"); }
      this.liveHost?.close();
      this.state = "stopped";
      return { cleanup: "proved", nativeInterrupts: this.input.connection.ownership === "owned" ? "complete" : "not_owned" };
    }
  }
  const environmentChannel = { scope, executionEnvironmentId, resolveSecret: vi.fn(async () => ({ value: "secret", discard: vi.fn() })) } as unknown as ExecutionEnvironmentChannelProvider;
  const hosts = new OpenCodeRuntimeHostRegistry({ scope, executionEnvironmentId, environmentChannel, environment: { HOME: "/native", HOST_VALUE: "host value" }, services,
    createRuntime: input => new FakeRuntime(input) as unknown as OpenCodeRuntime });
  const serviceStop = (force: boolean) => services.stop({ expectedServiceIncarnation: services.serviceIncarnation, controllerEpoch: services.controllerEpoch,
    expectedConfiguration: serviceConfiguration, expectedResourcesFingerprint: services.status().resourcesFingerprint, force, reason: "upgrade" });
  return { services, hosts, epoch, archive, controls, owners, serviceStop };
}

describe("resident OpenCode runtime registry", () => {
  it("shares startup, makes lookup existing-only and preserves startup definitions until retirement", async () => {
    const f = fixture(); expect(await f.hosts.lookup(configuration, f.epoch)).toBeUndefined(); expect(f.controls.created).not.toHaveBeenCalled();
    f.controls.beforeLaunch = deferred();
    const first = f.hosts.ensure(configuration, f.epoch), second = f.hosts.ensure(configuration, f.epoch);
    await vi.waitFor(() => expect(f.owners).toHaveLength(1));
    let lookedUp = false;
    const lookup = f.hosts.lookup(configuration, f.epoch).then(value => { lookedUp = true; return value; });
    await Promise.resolve(); expect(lookedUp).toBe(false); f.controls.beforeLaunch.release();
    expect(await second).toBe(await first); expect(await lookup).toBe(await first); expect(f.controls.launched).toHaveBeenCalledOnce();
    const changed = { ...configuration, startupEnvironmentVariables: { HOST_VALUE: { kind: "literal" as const, value: "pending value" } } };
    expect(await f.hosts.ensure(changed, f.epoch)).toBe(await first);
    expect(f.owners[0]!.input.environment.HOST_VALUE).toBe("host value");
  });

  it("retains native identity and proof across controller detach and replacement", async () => {
    const f = fixture(), runtime = await f.hosts.ensure(configuration, f.epoch); f.owners[0]!.retained = 1;
    f.services.detach(f.epoch);
    expect(f.owners[0]!.state).toBe("ready"); expect(f.controls.signals).not.toHaveBeenCalled();
    await expect(f.hosts.lookup(configuration, f.epoch)).rejects.toThrow("controller_stale");
    const next = f.services.attach(serviceConfiguration);
    expect(await f.hosts.lookup(configuration, next)).toBe(runtime);
    expect((await f.hosts.inspect(runtime.runtimeId)).retainedThreadIds).toEqual(["retained-thread"]);
    expect(f.controls.launched).toHaveBeenCalledOnce();
  });

  it("rejects wrong scope/configuration but exposes original retained owner for administration", async () => {
    const f = fixture(), runtime = await f.hosts.ensure(configuration, f.epoch);
    for (const changed of [
      { ...configuration, instance: { ...configuration.instance, tenantId: "other" } },
      { ...configuration, connections: [{ ...configuration.connections[0]!, ownerPrincipalId: "other" }] },
      { ...configuration, connections: [configuration.connections[0]!, configuration.connections[0]!] },
    ]) await expect(f.hosts.lookup(changed, f.epoch)).rejects.toThrow("scope_denied");
    await expect(f.hosts.lookup({ ...configuration, nativeStorePath: "/different/db" }, f.epoch)).rejects.toThrow("restart_required");
    await expect(f.hosts.ensure({ ...configuration, instance: { ...configuration.instance, enabled: false } }, f.epoch)).rejects.toThrow("disabled");
    expect(await f.hosts.lookupRetained(configuration.instance.id, f.epoch)).toBe(runtime);
    expect(await f.hosts.lookup({ ...configuration, instance: { ...configuration.instance, enabled: false } }, f.epoch)).toBe(runtime);
    expect(f.controls.created).toHaveBeenCalledOnce();
  });

  it("fences a controller lost before launch without starting untracked native work", async () => {
    const f = fixture(); f.controls.beforeLaunch = deferred();
    const starting = f.hosts.ensure(configuration, f.epoch).catch(error => error);
    await vi.waitFor(() => expect(f.services.status().resources).toHaveLength(1));
    f.services.detach(f.epoch); f.controls.beforeLaunch.release();
    expect(await starting).toMatchObject({ message: "sidecar_controller_stale" });
    expect(f.controls.launched).not.toHaveBeenCalled(); expect(f.services.status().resources).toEqual([]);
  });

  it("keeps an admitted native launch after the initiating carrier disappears", async () => {
    const f = fixture(); f.controls.afterLaunch = deferred();
    const starting = f.hosts.ensure(configuration, f.epoch).catch(error => error);
    await vi.waitFor(() => expect(f.controls.launched).toHaveBeenCalledOnce());
    f.services.detach(f.epoch); f.controls.afterLaunch.release();
    expect(await starting).toMatchObject({ message: "sidecar_controller_stale" });
    expect(f.services.status().resources).toHaveLength(1); expect(f.controls.signals).not.toHaveBeenCalled();
    const next = f.services.attach(serviceConfiguration); expect(await f.hosts.lookup(configuration, next)).toBe(f.owners[0]);
  });

  it("requires current confirmation and explicit force for unknown background inventory", async () => {
    const f = fixture(), runtime = await f.hosts.ensure(configuration, f.epoch);
    const inspected = await f.hosts.inspect(runtime.runtimeId); expect(inspected.blockers).toContain("unknown_state");
    await expect(f.hosts.stop(runtime.runtimeId, inspected.revision, false)).rejects.toThrow("restart_blocked");
    expect(f.owners[0]!.frozen).toBe(false);
    await expect(f.hosts.stop(runtime.runtimeId, "another-runtime-confirmation", true)).rejects.toThrow("confirmation_stale");
    expect(f.controls.signals).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
    // Live evidence continues changing while the user's confirmation crosses
    // the carrier. It does not replace the inspected native owner.
    f.owners[0]!.revision += 100; f.owners[0]!.retained = 5; f.owners[0]!.active = 1;
    expect((await f.hosts.inspect(runtime.runtimeId)).revision).toBe(inspected.revision);
    await f.hosts.stop(runtime.runtimeId, inspected.revision, true);
    expect(f.controls.signals).toHaveBeenCalledOnce(); expect(f.services.status().resources).toEqual([]);
  });

  it.each(["owned", "external"] as const)("retires %s ownership with metadata archival and the correct native control authority", async ownership => {
    const f = fixture();
    const selected: OpenCodeRuntimeConfiguration = ownership === "owned" ? configuration : { ...configuration,
      connection: { ownership: "external", channel: { type: "http", url: "http://127.0.0.1:4096", authentication: {
        type: "basic", username: "opencode", secret: { source: "environment", variable: "SEDES_OPENCODE_PASSWORD" } } } } };
    const runtime = await f.hosts.ensure(selected, f.epoch); f.owners[0]!.retained = 1;
    await f.hosts.stop(runtime.runtimeId, (await f.hosts.inspect(runtime.runtimeId)).revision, true);
    expect(f.controls.signals).toHaveBeenCalledTimes(ownership === "owned" ? 1 : 0);
    expect(f.archive).toHaveBeenCalledTimes(2);
    expect(f.archive.mock.calls[0]![0]).toMatchObject({ kind: "opencode", evidence: { ownership,
      operations: [expect.objectContaining({ identity: expect.objectContaining({ applicationOperationId: "retained-operation" }) })] } });
    expect(await f.hosts.lookupRetained("backend", f.epoch)).toBeUndefined();
  });

  it("keeps failed cleanup registered and retries the same owner", async () => {
    const f = fixture(), runtime = await f.hosts.ensure(configuration, f.epoch); f.controls.cleanupFailure = true;
    await expect(f.hosts.stop(runtime.runtimeId, (await f.hosts.inspect(runtime.runtimeId)).revision, true)).rejects.toThrow("cleanup_unproven");
    expect(f.hosts.getRuntime(runtime.runtimeId)).toBe(runtime);
    expect((await f.hosts.inspect(runtime.runtimeId)).blockers).toContain("cleanup_unproven");
    expect(await f.hosts.ensure(configuration, f.epoch)).toBe(runtime); expect(f.controls.created).toHaveBeenCalledOnce();
    f.controls.cleanupFailure = false;
    await f.hosts.stop(runtime.runtimeId, (await f.hosts.inspect(runtime.runtimeId)).revision, true);
    expect(f.services.status().resources).toEqual([]);
  });

  it("keeps a launch cleanup failure visible instead of reporting absent", async () => {
    const f = fixture(); f.controls.startupFailure = true; f.controls.cleanupFailure = true;
    await expect(f.hosts.ensure(configuration, f.epoch)).rejects.toThrow("startup failed");
    const retained = await f.hosts.lookup(configuration, f.epoch);
    expect(retained).toBe(f.owners[0]); expect(f.services.status().resources[0]!.blockers).toContain("cleanup_unproven");
  });

  it.each(["owned", "external"] as const)("preserves confirmed service retirement of %s work while native SSE continues after detach", async ownership => {
    const wire = createOpenCodeApiFixture(), client = new OpenCodeHttpClient({
      endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: wire.fetch,
    });
    const f = fixture(runtimeId => new OpenCodeNativeHost({ ...scope, executionEnvironmentId,
      backendInstanceId: "backend", runtimeId, nativeGeneration: "native-generation" }, new OpenCodeHttpNativeAdapter(client), {
      assertCurrent: async () => {},
      installSessionEnvironment: async () => { throw new Error("unexpected environment mutation"); },
      ensureMcpRegistration: async () => { throw new Error("unexpected MCP mutation"); },
    }, client.lifetime));
    try {
      const selected: OpenCodeRuntimeConfiguration = ownership === "owned" ? configuration : { ...configuration,
        connection: { ownership: "external", channel: { type: "http", url: "http://127.0.0.1:4096", authentication: {
          type: "basic", username: "opencode", secret: { source: "environment", variable: "SEDES_OPENCODE_PASSWORD" } } } } };
      const runtime = await f.hosts.ensure(selected, f.epoch), host = f.hosts.get(runtime.runtimeId);
      const port = host.acquire({ directory: wire.directory, session: {
        applicationThreadId: "retained-thread", nativeSessionID: wire.sessionID, bindingFingerprint: "binding",
      } });
      const observer = port.observe({ purpose: "evidence" }), boundary = await observer.ready;
      wire.send({ id: "evt_delivered", created: 1, type: "session.inbox.delivered",
        durable: { aggregateID: wire.sessionID, seq: 1, version: 1 }, data: { sessionID: wire.sessionID, inboxID: "msg_current" } });
      await observer.wait();
      await observer.acknowledge({ journalId: boundary.journalId, sequence: observer.drain().at(-1)!.sequence });
      wire.setResponse("/api/session/active", 200, { data: { [wire.sessionID]: { type: "running" } } });
      expect((await f.hosts.inspect(runtime.runtimeId)).state).toBe("active");
      const confirmed = f.services.status();
      expect(confirmed.resources[0]).toMatchObject({ state: "unknown", blockers: ["unknown_state"] });

      // A native mutation receipt, followed by main closing its evidence reader,
      // changes the detailed inventory but not authority to retire this owner.
      await port.mutate("interruptSession", { sessionID: wire.sessionID }, openCodeTestMutationControl("interrupt"));
      expect(host.retentionSnapshot().retainedMutationCount).toBe(1);
      await observer.close(); host.release(port); f.services.detach(f.epoch);
      const beforeStreaming = host.retentionSnapshot().revision;
      wire.send({ id: "evt_delta", created: 2, type: "session.text.delta", data: {
        sessionID: wire.sessionID, assistantMessageID: "msg_assistant", ordinal: 0, delta: "still running",
      } });
      await vi.waitFor(() => expect(host.retentionSnapshot().revision).not.toBe(beforeStreaming));
      wire.send({ id: "evt_enqueued", created: 3, type: "session.inbox.enqueued",
        durable: { aggregateID: wire.sessionID, seq: 2, version: 1 }, data: { sessionID: wire.sessionID,
          inboxID: "msg_queued", item: { type: "user", delivery: "queue", payload: { text: "queued during detach" } } } });
      await vi.waitFor(() => expect(host.retentionSnapshot().observation.pendingEvidenceCount).toBe(1));
      expect(host.retentionSnapshot().activeWorkCount).toBeNull();
      expect(f.services.status().resourcesFingerprint).toBe(confirmed.resourcesFingerprint);

      await f.services.stop({ expectedServiceIncarnation: confirmed.serviceIncarnation, controllerEpoch: confirmed.controllerEpoch,
        expectedConfiguration: confirmed.desiredConfiguration, expectedResourcesFingerprint: confirmed.resourcesFingerprint,
        force: true, reason: "upgrade" });
      expect(f.services.status().state).toBe("stopped");
      expect(f.controls.signals).toHaveBeenCalledTimes(ownership === "owned" ? 1 : 0);
      expect(f.archive.mock.calls[0]![0]).toMatchObject({ kind: "opencode", reason: "upgrade", evidence: {
        ownership, retention: { threadIds: ["retained-thread"], retainedMutationCount: 1,
          observation: { pendingEvidenceCount: 1 } },
      } });
    } finally { client.close(); }
  });

  it("still rejects service confirmation after native owner generation or desired configuration changes", async () => {
    const f = fixture(); await f.hosts.ensure(configuration, f.epoch);
    const confirmed = f.services.status();
    const request = { expectedServiceIncarnation: confirmed.serviceIncarnation, controllerEpoch: confirmed.controllerEpoch,
      expectedConfiguration: confirmed.desiredConfiguration, expectedResourcesFingerprint: confirmed.resourcesFingerprint,
      force: true, reason: "upgrade" };
    f.owners[0]!.generation = "replaced-native-generation";
    await expect(f.services.stop(request)).rejects.toThrow("confirmation_stale");
    f.owners[0]!.generation = "native-generation";
    f.services.attach({ ...serviceConfiguration, environmentRevision: 2 });
    await expect(f.services.stop({ ...request, controllerEpoch: f.services.controllerEpoch })).rejects.toThrow("confirmation_stale");
    expect(f.controls.signals).not.toHaveBeenCalled(); expect(f.archive).not.toHaveBeenCalled();
  });

  it("participates in environment Stop/Upgrade and fences startup at the service boundary", async () => {
    const f = fixture(); f.controls.beforeLaunch = deferred();
    const starting = f.hosts.ensure(configuration, f.epoch).catch(error => error);
    await vi.waitFor(() => expect(f.services.status().resources).toHaveLength(1));
    const stopping = f.serviceStop(true);
    f.controls.beforeLaunch.release(); await starting; await stopping;
    expect(f.controls.launched).not.toHaveBeenCalled(); expect(f.services.status().state).toBe("stopped");
    const g = fixture(); await g.hosts.ensure(configuration, g.epoch);
    await expect(g.serviceStop(false)).rejects.toThrow("cleanup_unproven");
    g.controls.cleanupFailure = true; await expect(g.serviceStop(true)).rejects.toThrow("cleanup_unproven");
    expect(g.services.status().resources).toHaveLength(1);
    g.controls.cleanupFailure = false; await g.serviceStop(true);
    expect(g.services.status().state).toBe("stopped");
  });
});
