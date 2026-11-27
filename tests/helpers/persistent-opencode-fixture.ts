import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import { executionPolicyDigest, policyReadOperation, policyStageOperation, policyApplyOperation, type InstalledExecutionPolicy } from "../../src/internal/sidecar-protocol/execution-policy.js";
import { runtimeLaunchDigest } from "../../src/server/backends/provider-launch-digest.js";
import { attachFixturePolicy } from "./execution-policy-fixture.js";
import { OPENCODE_RELEASE } from "../../src/server/backends/opencode/opencode-release.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { OpenCodeRuntimeHostRegistry } from "../../src/server/backends/opencode/opencode-runtime-host-registry.js";
import { OpenCodeRemoteRuntime } from "../../src/server/backends/opencode/opencode-remote-runtime.js";
import { openCodeToolInvokeOperation } from "../../src/server/backends/opencode/opencode-tool-relay-wire.js";
import { OpenCodeNativeHost } from "../../src/server/backends/opencode/opencode-native-host.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { openCodeRuntimeNamespaceKey, OpenCodeRuntime, type OpenCodeRuntimeInput, type OpenCodeRuntimeSnapshot } from "../../src/server/backends/opencode/opencode-runtime.js";
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
  const actualNativeStorePath = "/native/opencode.db";
  const configuration: OpenCodeRuntimeConfiguration = {
    instance: { id: "opencode", tenantId: scope.tenantId, kind: "opencode", label: "OpenCode", enabled: true, configurationRevision: 1, protocolRelease: OPENCODE_RELEASE },
    connections: [{ id: "profile", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "template",
      kind: "opencode_http", backendInstanceId: "opencode", executionEnvironmentId, label: "OpenCode", enabled: true, configurationRevision: 1 }],
    nativeStorePath: "/native/opencode.db", configDirectory: "/native/config",
    connection: ownership === "owned" ? { ownership, channel: { type: "process_stdio", executablePath: "/native/opencode2", workingDirectory: wire.directory } }
      : { ownership, channel: { type: "http", url: "http://127.0.0.1:4096", authentication: { type: "basic", username: "opencode",
        secret: { source: "environment", variable: "SEDES_OPENCODE_PASSWORD" } } } },
  };
  const serviceConfiguration = { environmentRevision: 1, operationsRevision: 1 };
  const snapshot = { roots: [], capabilities: [], backends: [{ id: configuration.instance.id, kind: "opencode", generation: 1,
    launchDigest: runtimeLaunchDigest.opencode(configuration), targets: [{ id: "template", generation: 1 }] }] };
  const desired: InstalledExecutionPolicy = { revision: 1, snapshot, configuration: serviceConfiguration, digest: executionPolicyDigest(snapshot) };
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
  const controls = { startupFailure: false, cleanupFailure: false };
  class FakeRuntime {
    readonly runtimeId = randomUUID();
    readonly generation = randomUUID();
    readonly nativeNamespaceKey = openCodeRuntimeNamespaceKey(executionEnvironmentId, actualNativeStorePath);
    readonly nativeHost: OpenCodeNativeHost;
    state: OpenCodeRuntimeSnapshot["state"] = "stopped";
    constructor(readonly input: OpenCodeRuntimeInput) {
      this.nativeHost = new OpenCodeNativeHost({ ...input.authority, runtimeId: this.runtimeId, nativeGeneration: this.generation }, adapter,
        { assertCurrent: async () => {}, installSessionEnvironment: async () => {}, ensureMcpRegistration: async () => {} }, nativeClient.lifetime);
      owners.push(this);
    }
    readonly start = vi.fn(async () => {
      this.input.assertLaunchAdmission?.();
      if (controls.startupFailure) { this.state = controls.cleanupFailure ? "cleanup_unproved" : "stopped"; throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved"); }
      this.state = "ready";
    });
    readonly close = vi.fn(async () => {
      if (controls.cleanupFailure) { this.state = "cleanup_unproved"; throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved"); }
      this.nativeHost.close(); this.state = "stopped";
      return { cleanup: "proved", nativeInterrupts: ownership === "owned" ? "complete" : "not_owned" }; });
    async assertCurrent() { if (this.state !== "ready") throw new Error("not ready"); }
    snapshot(): OpenCodeRuntimeSnapshot { return { state: this.state, runtimeVersion: OPENCODE_RELEASE, ownership, generation: this.generation, references: 0,
      identity: { pid: process.pid, startTime: "1", uid: process.getuid!(), executablePath: "/native/opencode2", executable: { device: "1", inode: "2" },
        nativeStorePath: actualNativeStorePath, store: { device: "1", inode: "3" }, storeObservation: "open_file" } }; }
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
  async function attach(options: { recovery?: boolean; environmentRevision?: number; openCodeTools?: boolean; authorizedConfiguration?: OpenCodeRuntimeConfiguration; ownerSync?: boolean } = {}) {
    const carrier = await createSidecarFramedCarrier();
    const pair = { ...serviceConfiguration, environmentRevision: options.environmentRevision ?? serviceConfiguration.environmentRevision };
    const mode = options.recovery ? "recovery" : "normal";
    const installed = options.authorizedConfiguration ? { ...snapshot, backends: snapshot.backends.map(backend => ({
      ...backend, launchDigest: runtimeLaunchDigest.opencode(options.authorizedConfiguration!),
    })) } : snapshot;
    const controllerEpoch = options.ownerSync ? services.attach(pair, mode) : attachFixturePolicy(services, pair, mode, options.openCodeTools
      ? { ...installed, capabilities: [{ id: "agent_tools_cli", generation: 1 }] } : installed);
    const readPolicy = () => services.readPolicy(controllerEpoch, () => "ready");
    carrier.hostRegistry.register(policyReadOperation, readPolicy);
    carrier.hostRegistry.register(policyStageOperation, request => services.stagePolicy(controllerEpoch, request));
    carrier.hostRegistry.register(policyApplyOperation, request => { services.applyPolicy(controllerEpoch, request); return readPolicy(); });
    const detach = registerOpenCodeRuntimeHost({ registry: carrier.hostRegistry, channel: carrier.hostChannel, hosts, services, controllerEpoch, getExecutionPolicy: () => services.executionPolicy(controllerEpoch), isRecoveryController: () => services.recoveryController });
    if (options.openCodeTools) carrier.mainRegistry.register(openCodeToolInvokeOperation, () => { throw new Error("unexpected_fixture_tool_invocation"); });
    await carrier.start();
    let disconnect!: () => void, closed = false;
    const lease: SidecarRuntimeLease = { channel: carrier.mainChannel, controllerEpoch, serviceIncarnation: services.serviceIncarnation,
      ...(options.openCodeTools && !options.recovery ? { acquireOpenCodeRoute: async () => 1 } : {}),
      closed: new Promise<void>(resolve => { disconnect = resolve; }), release: vi.fn() };
    current = lease;
    const attached = { ...carrier, lease, async close() {
      if (closed) return; closed = true;
      if (current === lease) current = undefined;
      detach(); services.detach(controllerEpoch); disconnect(); await carrier.close();
    } };
    carriers.push(attached); return attached;
  }
  return { desired, scope, configuration, services, hosts, wire, adapter, archive, owners, controls, provider, acquireRecovery, acquireExisting, attach,
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

/** Real provider host/management lifecycle, with credentials and ownership storage confined to the test. */
export async function startExternalOpenCodeSidecar(input: { ownershipDirectory: string; nativeStorePath: string; endpoint: string; password: string }) {
  const scope = { tenantId: "tenant", principalId: "principal" }, executionEnvironmentId = "remote";
  const configuration = { environmentRevision: 1, operationsRevision: 1 };
  const services = new PersistentSidecarServiceRegistry({ scope: { ...scope, executionEnvironmentId, installationId: "installation" },
    buildId: "build", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION, configuration });
  const epoch = attachFixturePolicy(services, configuration);
  const hosts = new OpenCodeRuntimeHostRegistry({ services, scope, executionEnvironmentId, environment: {},
    environmentChannel: { scope, executionEnvironmentId, resolveSecret: async () => ({ value: input.password, discard() {} }) } as unknown as ExecutionEnvironmentChannelProvider,
    createRuntime: runtimeInput => new OpenCodeRuntime({ ...runtimeInput, ownershipDirectory: input.ownershipDirectory }),
    agentTools: { cli: () => ({ endpoint: "http://127.0.0.1:4784", executableDirectory: "/host/bin" }), invoke: vi.fn() },
  });
  const runtime = await hosts.ensure({
    instance: { id: "backend", tenantId: "tenant", kind: "opencode", label: "OpenCode", enabled: true, configurationRevision: 1, protocolRelease: OPENCODE_RELEASE },
    connections: [{ id: "profile", tenantId: "tenant", ownerPrincipalId: "principal", templateId: "template",
      kind: "opencode_http", backendInstanceId: "backend", executionEnvironmentId, label: "OpenCode", enabled: true, configurationRevision: 1 }],
    nativeStorePath: input.nativeStorePath, connection: { ownership: "external", channel: { type: "http", url: input.endpoint,
      authentication: { type: "basic", username: "opencode", secret: { source: "environment", variable: "SEDES_OPENCODE_PASSWORD" } } } },
  }, epoch);
  const stop = () => services.stop({ expectedServiceIncarnation: services.serviceIncarnation, controllerEpoch: epoch,
    expectedConfiguration: configuration, expectedResourcesFingerprint: services.status().resourcesFingerprint, force: false, reason: "upgrade" });
  return { runtime, services, epoch, stop };
}
