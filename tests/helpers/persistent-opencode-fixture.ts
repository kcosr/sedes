import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { OpenCodeRuntimeHostRegistry } from "../../src/server/backends/opencode/opencode-runtime-host-registry.js";
import { OpenCodeRemoteRuntime } from "../../src/server/backends/opencode/opencode-remote-runtime.js";
import { openCodeToolInvokeOperation } from "../../src/server/backends/opencode/opencode-tool-relay-wire.js";
import { OpenCodeNativeHost } from "../../src/server/backends/opencode/opencode-native-host.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { openCodeRuntimeNamespaceKey, type OpenCodeRuntime, type OpenCodeRuntimeInput, type OpenCodeRuntimeSnapshot } from "../../src/server/backends/opencode/opencode-runtime.js";
import type { OpenCodeRuntimeConfiguration } from "../../src/server/backends/opencode/opencode-runtime-configuration.js";
import { registerOpenCodeRuntimeHost } from "../../src/server/backends/opencode/opencode-sidecar-runtime.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { SidecarRuntimeLease, SidecarRuntimeProvider } from "../../src/server/sidecar/runtime-channel.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { createSidecarFramedCarrier } from "./persistent-sidecar-framed-fixture.js";

export function createPersistentOpenCodeFixture(ownership: "owned" | "external" = "owned") {
  const scope = { tenantId: "tenant", principalId: "principal" }, executionEnvironmentId = "remote-environment";
  const wire = createOpenCodeApiFixture();
  const configuration: OpenCodeRuntimeConfiguration = {
    instance: { id: "opencode", tenantId: scope.tenantId, kind: "opencode", label: "OpenCode", enabled: true, configurationRevision: 1, protocolRelease: "2.0.18" },
    connections: [{ id: "profile", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "template",
      kind: "opencode_http", backendInstanceId: "opencode", executionEnvironmentId, label: "OpenCode", enabled: true, configurationRevision: 1 }],
    nativeStorePath: "/native/opencode.db", configDirectory: "/native/config",
    connection: ownership === "owned" ? { ownership, channel: { type: "process_stdio", executablePath: "/native/opencode2", workingDirectory: wire.directory } }
      : { ownership, channel: { type: "http", url: "http://127.0.0.1:4096", authentication: { type: "basic", username: "opencode",
        secret: { source: "environment", variable: "SEDES_OPENCODE_PASSWORD" } } } },
  };
  const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
  const archive = vi.fn(async (_record: unknown) => {});
  const services = new PersistentSidecarServiceRegistry({ scope: { ...scope, executionEnvironmentId, installationId: "installation" },
    buildId: "test", artifactSha256: "a".repeat(64), runtimeWireVersion: 1, configuration: serviceConfiguration, recordAbandonment: archive });
  let promptCount = 0;
  let promptResponseGate: { entered(): void; wait: Promise<void> } | undefined;
  const nativeClient = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith("/prompt") && init?.method === "POST") {
      promptCount++;
      const prompt = JSON.parse(String(init.body));
      if (promptResponseGate) { promptResponseGate.entered(); await promptResponseGate.wait; }
      return Response.json({ data: { id: prompt.id, sessionID: wire.sessionID, type: "user", payload: { text: prompt.text },
        delivery: prompt.delivery, time: { created: 1 } } });
    }
    if (pathname.endsWith("/interrupt") && init?.method === "POST") return Response.json({ interrupted: true });
    return wire.fetch(url, init);
  } });
  const adapter = new OpenCodeHttpNativeAdapter(nativeClient);
  const owners: FakeRuntime[] = [];
  class FakeRuntime {
    readonly runtimeId = randomUUID();
    readonly generation = randomUUID();
    readonly nativeNamespaceKey = openCodeRuntimeNamespaceKey(executionEnvironmentId, configuration.nativeStorePath);
    readonly nativeHost: OpenCodeNativeHost;
    state: OpenCodeRuntimeSnapshot["state"] = "stopped";
    constructor(readonly input: OpenCodeRuntimeInput) {
      this.nativeHost = new OpenCodeNativeHost({ ...input.authority, runtimeId: this.runtimeId, nativeGeneration: this.generation }, adapter,
        { assertCurrent: async () => {}, installSessionEnvironment: async () => {}, ensureMcpRegistration: async () => {} }, nativeClient.lifetime);
      owners.push(this);
    }
    readonly start = vi.fn(async () => { this.input.assertLaunchAdmission?.(); this.state = "ready"; });
    readonly close = vi.fn(async () => { this.nativeHost.close(); this.state = "stopped";
      return { cleanup: "proved", nativeInterrupts: ownership === "owned" ? "complete" : "not_owned" }; });
    async assertCurrent() { if (this.state !== "ready") throw new Error("not ready"); }
    snapshot(): OpenCodeRuntimeSnapshot { return { state: this.state, ownership, generation: this.generation, references: 0,
      identity: { pid: process.pid, startTime: "1", uid: process.getuid!(), executablePath: "/native/opencode2", executable: { device: "1", inode: "2" },
        nativeStorePath: configuration.nativeStorePath, store: { device: "1", inode: "3" }, storeObservation: "open_file" } }; }
  }
  const hosts = new OpenCodeRuntimeHostRegistry({ scope, executionEnvironmentId, environment: { HOME: "/native" }, services,
    environmentChannel: { scope, executionEnvironmentId, resolveSecret: async () => ({ value: "host-secret", discard() {} }) } as unknown as ExecutionEnvironmentChannelProvider,
    createRuntime: input => new FakeRuntime(input) as unknown as OpenCodeRuntime });
  let current: SidecarRuntimeLease | undefined;
  let normalError: Error | undefined;
  const acquireRecovery = vi.fn(async () => { if (!current) throw new Error("fixture_carrier_missing"); return current; });
  const acquireExisting = vi.fn(async () => { if (!current) throw new Error("fixture_carrier_missing"); return current; });
  const provider: SidecarRuntimeProvider = { acquireExisting, acquire: vi.fn(async () => {
    if (normalError) throw normalError;
    if (!current) throw new Error("fixture_carrier_missing"); return current;
  }) };
  const carriers: { close(): Promise<void> }[] = [], clients: OpenCodeRemoteRuntime[] = [];
  async function attach(options: { recovery?: boolean; environmentRevision?: number; openCodeTools?: boolean } = {}) {
    const carrier = await createSidecarFramedCarrier(), controllerEpoch = services.attach(
      { ...serviceConfiguration, environmentRevision: options.environmentRevision ?? serviceConfiguration.environmentRevision }, options.recovery ? "recovery" : "normal");
    const detach = registerOpenCodeRuntimeHost({ registry: carrier.hostRegistry, channel: carrier.hostChannel, hosts, services, controllerEpoch });
    if (options.openCodeTools) carrier.mainRegistry.register(openCodeToolInvokeOperation, () => { throw new Error("unexpected_fixture_tool_invocation"); });
    await carrier.start();
    let disconnect!: () => void, closed = false;
    const lease: SidecarRuntimeLease = { channel: carrier.mainChannel, controllerEpoch, serviceIncarnation: services.serviceIncarnation,
      closed: new Promise<void>(resolve => { disconnect = resolve; }), release: vi.fn() };
    current = lease;
    const attached = { ...carrier, lease, async close() {
      if (closed) return; closed = true;
      if (current === lease) current = undefined;
      detach(); services.detach(controllerEpoch); disconnect(); await carrier.close();
    } };
    carriers.push(attached); return attached;
  }
  return { scope, configuration, services, hosts, wire, adapter, archive, owners, provider, acquireRecovery, acquireExisting, attach,
    setNormalError(error?: Error) { normalError = error; },
    holdPromptResponse() {
      let release!: () => void, entered!: () => void;
      const observed = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      promptResponseGate = { entered, wait };
      return { entered: observed, release: () => { promptResponseGate = undefined; release(); } };
    },
    promptCount: () => promptCount,
    target: { directory: wire.directory, session: { applicationThreadId: "thread", nativeSessionID: wire.sessionID, bindingFingerprint: "b".repeat(64) } },
    client(desired = configuration) { const client = new OpenCodeRemoteRuntime({ configuration: desired, provider, acquireRecovery }); clients.push(client); return client; },
    async close() {
      await Promise.all(clients.map(client => client.close()));
      for (const carrier of carriers) await carrier.close();
      for (const owner of owners) await owner.close();
      nativeClient.close();
    },
  };
}
