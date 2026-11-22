import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import { SshSidecarArtifactInstaller } from "../../src/server/sidecar/ssh-sidecar-artifact-installer.js";
import type { SidecarRuntimeLease } from "../../src/server/sidecar/runtime-channel.js";
import { AntigravityRemotePort } from "../../src/server/backends/antigravity/sidecar/remote-port.js";
import { antigravityRuntimeCapability } from "../../src/server/backends/antigravity/sidecar/wire.js";
import type { AntigravityIdentity, AntigravityRuntimeConfiguration } from "../../src/server/backends/antigravity/port.js";
import { buildProductionSidecarArtifact, productionOpenSshAvailable, startProductionSshServer, terminateChild } from "../support/production-carrier-fixture.js";
import { gate } from "./qualification.js";
import { removeAntigravityQualificationSession } from "./session-cleanup.js";

/** Genuine OpenSSH TCP connection and release sidecar. Only this test's pinned
 * host/client keys, private account home, scope and newly-created session exist. */
export async function sshFixture() {
  const selected = gate();
  if (process.env.SEDES_LIVE_ANTIGRAVITY_SSH !== "1" || !productionOpenSshAvailable) throw new Error("LIVE_ANTIGRAVITY_BLOCKER: explicit SSH gate and local OpenSSH tools are required");
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "sedes-live-agy-ssh-")));
  const home = path.join(directory, "home"), bin = path.join(directory, "bin"), cwd = path.join(directory, "workspace");
  for (const item of [home, bin, cwd]) await mkdir(item, { mode: 0o700 });
  const sshd = await startProductionSshServer({ directory, binDirectory: bin, remoteHome: home });
  let session: SidecarClientSession | undefined, lease: SidecarRuntimeLease | undefined;
  let generation = 0, identity: AntigravityIdentity | undefined;
  const configuration: AntigravityRuntimeConfiguration = { tenantId: randomUUID(), principalId: randomUUID(), backendInstanceId: randomUUID(), executionEnvironmentId: randomUUID(),
    executablePath: selected.executablePath, geminiDirectory: selected.geminiDirectory, initializationTimeoutMs: 30_000 };
  const ports: AntigravityRemotePort[] = [];
  let installer: SshSidecarArtifactInstaller | undefined;
  let serviceStarted = false;
  let recovery = false;
  async function close() {
    // Preserve private state and ownership evidence if service cleanup cannot be
    // proven. Never pattern-kill an account's providers or remove live sockets.
    const errors: unknown[] = [];
    const outcomes = await Promise.allSettled([...ports.map(port => port.close()), session?.close("live_antigravity_complete")]);
    for (const outcome of outcomes) if (outcome.status === "rejected") errors.push(outcome.reason);
    lease = undefined;
    try {
      if (installer && serviceStarted) {
        const current = await installer.inspect(AbortSignal.timeout(15_000));
        if (current) await installer.control({ mutationId: randomUUID(), operation: "stop", expectedServiceIncarnation: current.serviceIncarnation,
          controllerEpoch: current.controllerEpoch, expectedConfiguration: current.desiredConfiguration,
          expectedResourcesFingerprint: current.resourcesFingerprint, force: true }, AbortSignal.timeout(30_000));
      }
    } catch (error) { errors.push(error); }
    try { await terminateChild(sshd.child); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, `LIVE_ANTIGRAVITY_BLOCKER: cleanup unproven; private evidence retained at ${directory}`);
    if (identity) await removeAntigravityQualificationSession(configuration, identity, directory);
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const artifact = await buildProductionSidecarArtifact(path.join(directory, "artifact"));
    installer = new SshSidecarArtifactInstaller({ host: "sedes-production-fixture", artifact, sshExecutable: path.join(bin, "ssh"),
      agentToolEndpointKey: randomBytes(12).toString("hex"), testOnlyAccountHome: home,
      serviceScope: { installationId: randomUUID(), tenantId: configuration.tenantId, principalId: configuration.principalId, executionEnvironmentId: configuration.executionEnvironmentId },
      configuration: { environmentRevision: 1, operationsRevision: 1 } });
    await installer.install(AbortSignal.timeout(30_000));
    const connect = async (existing: boolean) => {
      const sessionNonce = randomBytes(32).toString("base64url"), signal = AbortSignal.timeout(30_000);
      // A lost launch response can still have started the service. Cleanup must
      // inspect this exact private scope even when no carrier was returned.
      serviceStarted = true;
      const stream = existing ? await installer!.attachExisting(++generation, sessionNonce, signal) : await installer!.launch(++generation, sessionNonce, signal);
      recovery = existing;
      session = await SidecarClientSession.start({ connectionCompression: true, transportKind: "ssh_stdio", stream, sessionNonce, carrierGeneration: generation,
        artifact, installation: stream.installation, authorizedCapabilities: [], authorizedRuntimeCapabilities: [antigravityRuntimeCapability],
        sedesOperations: new SidecarOperationRegistry(), signal });
      lease = { channel: session.runtimeChannel, closed: session.closed, controllerEpoch: stream.serviceStatus.controllerEpoch, serviceIncarnation: stream.serviceStatus.serviceIncarnation, release() {} };
    };
    await connect(false);
    const newPort = () => {
      const acquireExisting = async () => { if (!lease) throw new Error("live_antigravity_carrier_missing"); return lease; };
      const acquire = async () => {
        if (recovery) { await session?.close("live_antigravity_normal_admission"); lease = undefined; await connect(false); }
        return acquireExisting();
      };
      const port = new AntigravityRemotePort({ configuration, sidecarRuntime: { acquire, acquireExisting } }); ports.push(port); return port;
    };
    return { directory, cwd, configuration, newPort, setIdentity(value: AntigravityIdentity) { identity = value; }, close,
      get incarnation() { return lease!.serviceIncarnation; },
      async disconnect() { await session?.close("live_antigravity_ssh_loss"); lease = undefined; },
      async reconnect() { await connect(true); } };
  } catch (error) { await close(); throw error; }
}
