import { executionPolicyDigest, policyReadOperation, policyStageOperation, policyApplyOperation, executionPolicyBytes, type InstalledExecutionPolicy } from "../../src/internal/sidecar-protocol/execution-policy.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import type { SidecarByteStream } from "../../src/internal/sidecar-protocol/contracts.js";
import { SidecarRuntimeOwner, type SidecarRuntimeLease as OwnerLease } from "../../src/server/sidecar/sidecar-runtime.js";
import { SIDECAR_ARTIFACT_ID, SIDECAR_ARTIFACT_MODES, SIDECAR_MINIMUM_NODE_VERSION } from "../../src/server/sidecar/sidecar-artifact.js";
import type { PersistentSidecarByteStream } from "../../src/server/sidecar/sidecar-provisioner.js";
import type { SidecarRuntimeLease, SidecarRuntimeProvider } from "../../src/server/sidecar/runtime-channel.js";
import { OpenCodeRemoteRuntime } from "../../src/server/backends/opencode/opencode-remote-runtime.js";
import type { OpenCodeMutationControl } from "../../src/server/backends/opencode/opencode-native-port.js";
import { createPersistentOpenCodeFixture } from "../helpers/persistent-opencode-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const control = (id: string): OpenCodeMutationControl => ({ identity: {
  origin: "application", applicationOperationId: id, operationKind: "submit", step: "prompt",
}, deadlineAt: null });

/** Use the production owner and framed host. Only transport provisioning is
 * substituted; each attachment receives a real new service controller epoch. */
function fixture(transportKind: string) {
  const f = createPersistentOpenCodeFixture();
  const environmentId = f.configuration.connections[0]!.executionEnvironmentId;
  const installation = { accountHome: "/remote", nodeExecutable: "/usr/bin/node", stateRoot: "/remote/state",
    environment: { HOME: "/remote" }, executableDirectory: "/remote/bin", executablePath: "/remote/bin/sedes" };
  type Carrier = Awaited<ReturnType<typeof f.attach>>;
  const streams = new WeakMap<SidecarByteStream, Carrier>(), carriers: Carrier[] = [];
  async function attach(recovery: boolean): Promise<PersistentSidecarByteStream> {
    const carrier = await f.attach({ recovery, ownerSync: true }); carriers.push(carrier);
    const stream = { installation, serviceStatus: f.services.status(), closed: carrier.lease.closed.then(() => ({ reason: "fixture_closed" })),
      bytes: (async function* () {})(), write: async () => {}, close: () => carrier.close() };
    streams.set(stream, carrier); return stream;
  }
  const launch = vi.fn(async () => attach(false)), attachExisting = vi.fn(async () => attach(true));
  let desired = f.desired;
  const owner = new SidecarRuntimeOwner({ connectionCompression: () => true, scope: f.scope, executionEnvironmentId: environmentId,
    readDesiredPolicy: () => desired,
    authorizedCapabilities: [], authorizedRuntimeCapabilities: [], isAutomaticConnectionEnabled: () => true,
    artifact: { artifactId: SIDECAR_ARTIFACT_ID, modes: SIDECAR_ARTIFACT_MODES, executableDirectory: "/fixture",
      executablePath: "/fixture/sedes", artifactSha256: "a".repeat(64), artifactBytes: 1, buildId: "test",
      minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION, nativeAssets: [] },
    sedesOperations: new SidecarOperationRegistry(),
    provisioner: { transportKind, install: async () => installation, launch, attachExisting,
      inspect: async () => f.services.status(), inspectReceipt: async () => undefined, withdrawReceipt: async () => undefined,
      control: async () => { throw new Error("unused_service_control"); } },
    startSession: async ({ stream }) => {
      const carrier = streams.get(stream)!;
      const readPolicy = () => carrier.mainPeer.call(policyReadOperation, {});
      const session = { runtimeChannel: carrier.mainChannel, closed: carrier.lease.closed, negotiatedCapabilities: [],
        readPolicy, recoveryView() { return this; },
        async applyPolicy(next: InstalledExecutionPolicy) {
          const prior = await readPolicy();
          const binding = { incarnation: prior.incarnation, controllerEpoch: prior.controllerEpoch, revision: next.revision,
            digest: next.digest, transferId: randomUUID() };
          if (prior.installed?.digest !== next.digest) {
            const bytes = executionPolicyBytes(next.snapshot);
            await carrier.mainPeer.call(policyStageOperation, { ...binding, length: bytes.length, offset: 0, block: bytes.toString("base64") });
          }
          return carrier.mainPeer.call(policyApplyOperation, { ...binding, base: prior.installed, configuration: next.configuration });
        },
        close: () => carrier.close() };
      return session;
    },
  });
  type Session = Awaited<ReturnType<typeof owner.acquireOperation>>["session"];
  function lease(value: OwnerLease<Session>): SidecarRuntimeLease {
    return { channel: value.session.runtimeChannel, closed: value.session.closed, release: value.release,
      controllerEpoch: value.serviceStatus.controllerEpoch, serviceIncarnation: value.serviceStatus.serviceIncarnation };
  }
  const provider: SidecarRuntimeProvider = {
    acquire: async signal => lease(await owner.acquireOperation(f.scope, environmentId, signal ?? new AbortController().signal)),
    acquireExisting: async signal => lease(await owner.acquireExisting(f.scope, environmentId, signal ?? new AbortController().signal)),
  };
  const clients: OpenCodeRemoteRuntime[] = [];
  function client() {
    const value = new OpenCodeRemoteRuntime({ configuration: f.configuration, provider,
      acquireRecovery: async signal => lease(await owner.acquireRetainedRecovery(f.scope, environmentId, signal ?? new AbortController().signal)) });
    clients.push(value); return value;
  }
  cleanups.push(async () => { for (const value of clients) await value.close(); await owner.close(); await f.close(); });
  return { ...f, owner, provider, client, launch, attachExisting, carriers, withdrawBackend: async () => {
    const snapshot = { ...desired.snapshot, backends: [] };
    desired = { ...desired, snapshot, revision: desired.revision + 1, digest: executionPolicyDigest(snapshot) };
    await owner.synchronizePolicy(undefined, true);
  } };
}

describe("OpenCode recovery through the production sidecar owner", () => {
  it.each([false, true])("ordinary startup waits for retained admission then promotes or ensures, missing=%s", async missing => {
    const f = fixture("ssh_stdio");
    if (!missing) await f.client().start();
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const acquireExisting = f.provider.acquireExisting;
    vi.spyOn(f.provider, "acquireExisting").mockImplementation(async signal => {
      entered(); await wait; return acquireExisting(signal);
    });
    const recovered = f.client();
    const retained = recovered.startRetained();
    const retainedResult = retained.catch(error => error);
    await arrived;
    const ordinary = recovered.start();
    release(); await retainedResult; await ordinary;
    const normal = recovered.acquire(f.target);
    await expect(normal.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_overlap", text: "overlap", delivery: "queue", resume: true }, control("overlap")))
      .resolves.toMatchObject({ id: "msg_overlap" });
    expect(f.promptCount()).toBe(1); expect(f.owners).toHaveLength(1); expect(f.owners[0]!.start).toHaveBeenCalledOnce();
    normal.release();
  });

  it.each(["ssh_stdio", "outbound_websocket"])("borrows a pending-revision %s invocation carrier without cancelling its response path", async kind => {
    const f = fixture(kind), original = f.client(); await original.start();
    const normal = original.acquire(f.target);
    await normal.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_pending", text: "pending", delivery: "queue", resume: true }, control("pending"));
    const carrier = f.carriers[0]!;
    let closed = false; void carrier.lease.closed.then(() => { closed = true; });
    await f.withdrawBackend();
    const recovered = f.client(); await recovered.startRetained();
    const narrow = recovered.acquire(f.target);
    await expect(narrow.client.read("getSession", { sessionID: f.wire.sessionID })).resolves.toMatchObject({ id: f.wire.sessionID });
    expect(closed).toBe(false); expect(f.attachExisting).not.toHaveBeenCalled(); expect(f.launch).toHaveBeenCalledOnce();
    await expect(recovered.start()).rejects.toBeDefined();
    await expect(normal.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_stale", text: "denied", delivery: "queue", resume: true }, control("stale"))).rejects.toBeDefined();
    expect(f.promptCount()).toBe(1); expect(f.owners[0]!.start).toHaveBeenCalledOnce();
    narrow.release(); normal.release();
  });

  it.each(["ssh_stdio", "outbound_websocket"])("recovers a tool on its existing %s carrier without replacing normal authority", async kind => {
    const f = fixture(kind), original = f.client(); await original.start();
    const normal = original.acquire(f.target);
    await normal.client.read("getSession", { sessionID: f.wire.sessionID });
    const reverseCarrier = f.carriers[0]!;
    let closed = false; void reverseCarrier.lease.closed.then(() => { closed = true; });
    const recovered = f.client(); await recovered.startRetained();
    const narrow = recovered.acquire(f.target);
    await expect(narrow.client.read("getSession", { sessionID: f.wire.sessionID })).resolves.toMatchObject({ id: f.wire.sessionID });
    expect(closed).toBe(false);
    expect(f.attachExisting).not.toHaveBeenCalled(); expect(f.launch).toHaveBeenCalledOnce();
    expect(f.owners[0]!.start).toHaveBeenCalledOnce();
    await expect(narrow.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_denied", text: "denied", delivery: "queue", resume: true }, control("denied"))).rejects.toBeDefined();
    await expect(recovered.admitToolSession(f.target, { sourceCapability: "new-source", catalog: [] })).rejects.toBeDefined();
    const unknown = recovered.acquire({ ...f.target, session: { ...f.target.session, applicationThreadId: "foreign" } });
    await expect(unknown.client.read("getSession", { sessionID: f.wire.sessionID })).rejects.toBeDefined();
    // lookup_recovery must not downgrade other borrowers of the same channel.
    await expect(normal.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_normal", text: "normal", delivery: "queue", resume: true }, control("normal"))).resolves.toMatchObject({ id: "msg_normal" });
    expect(f.promptCount()).toBe(1);
    unknown.release(); narrow.release(); normal.release();
  });

  it.each(["ssh_stdio", "outbound_websocket"])("promotes a retained %s carrier once through a new controller epoch", async kind => {
    const f = fixture(kind), original = f.client(); await original.start();
    const initial = original.acquire(f.target);
    await initial.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_initial", text: "initial", delivery: "queue", resume: true }, control("initial"));
    await f.owner.disconnectTransport("fixture_detach");
    const recovered = f.client(); await recovered.startRetained();
    const narrow = recovered.acquire(f.target);
    await narrow.client.read("getSession", { sessionID: f.wire.sessionID });
    const retainedEpoch = f.carriers.at(-1)!.lease.controllerEpoch;
    const first = recovered.start(), second = recovered.start();
    await Promise.all([first, second]);
    expect(f.carriers.at(-1)!.lease.controllerEpoch).toBeGreaterThan(retainedEpoch);
    expect(f.attachExisting).toHaveBeenCalledOnce(); expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.owners).toHaveLength(1); expect(f.owners[0]!.start).toHaveBeenCalledOnce();
    expect(narrow.client.lifetime.aborted).toBe(true);
    await expect(narrow.client.read("getSession", { sessionID: f.wire.sessionID })).rejects.toBeDefined();
    const normal = recovered.acquire(f.target);
    await expect(normal.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_promoted", text: "promoted", delivery: "queue", resume: true }, control("promoted"))).resolves.toMatchObject({ id: "msg_promoted" });
    expect(f.promptCount()).toBe(2);
    initial.release(); narrow.release(); normal.release();
  });

  it("refuses changed native identity during promotion and its subsequent ordinary retry", async () => {
    const f = fixture("ssh_stdio"), original = f.client(); await original.start();
    await f.owner.disconnectTransport("fixture_detach");
    const recovered = f.client(); await recovered.startRetained();
    const runtime = f.owners[0]!, snapshot = runtime.snapshot.bind(runtime);
    vi.spyOn(runtime, "snapshot").mockImplementation(() => {
      const value = snapshot();
      return { ...value, identity: { ...value.identity!, store: { device: "1", inode: "replacement" } } };
    });
    await expect(recovered.start()).rejects.toBeDefined();
    await expect(recovered.start()).rejects.toBeDefined();
    expect(f.owners).toHaveLength(1); expect(runtime.start).toHaveBeenCalledOnce();
    expect(f.promptCount()).toBe(0);
  });
});
