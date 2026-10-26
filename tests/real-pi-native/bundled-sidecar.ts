import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { buildProductionSidecarArtifact, terminateChild } from "../support/production-carrier-fixture.js";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import { sidecarManagementResponseSchema, type SidecarManagementRequest } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { readSidecarManagementRecord, writeSidecarManagementRecord } from "../../src/internal/sidecar-protocol/service-management-channel.js";
import { persistentSidecarPaths } from "../../src/server/sidecar/persistent-sidecar-paths.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import type { SidecarRuntimeLease } from "../../src/server/sidecar/runtime-channel.js";
import { PiNativeRemotePort } from "../../src/server/backends/pi/native/sidecar/remote-port.js";
import { piNativeRuntimeCapability } from "../../src/server/backends/pi/native/sidecar/wire.js";
import type { PiNativeRuntimeConfiguration } from "../../src/server/backends/pi/native/port.js";

type UnscopedRequest = SidecarManagementRequest extends infer Request ? Request extends { scope: unknown } ? Omit<Request, "scope"> : never : never;

/** Release bundle, actual persistent-service entry point, and production framed
 * carrier. The private local socket stands in for SSH's authenticated bytes. */
export async function bundledSidecar(configuration: PiNativeRuntimeConfiguration, environment: Readonly<Record<string, string | undefined>>) {
  const home = environment.HOME!;
  const artifact = await buildProductionSidecarArtifact(path.join(home, "sidecar-artifact"));
  const serviceScope = { installationId: randomUUID(), tenantId: configuration.tenantId, principalId: configuration.principalId, executionEnvironmentId: configuration.executionEnvironmentId };
  const revision = { environmentRevision: 1, operationsRevision: 1 };
  const paths = persistentSidecarPaths(home, process.getuid!(), serviceScope);
  await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const child = spawn(process.execPath, [artifact.executablePath, "service", "daemon", "--expected-digest", artifact.artifactSha256,
    "--expected-build", artifact.buildId, "--service-scope", encode(serviceScope), "--configuration", encode(revision), "--agent-tool-endpoint-key", "1234567890abcdef12345678"],
    { env: environment, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
  async function stream() {
    const socket = connect(paths.endpointPath);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return sidecarSocketByteStream(socket);
  }
  async function request(input: UnscopedRequest) {
    const connection = await stream();
    try {
      await writeSidecarManagementRecord(connection, { ...input, scope: serviceScope });
      return (await readSidecarManagementRecord(connection, sidecarManagementResponseSchema, AbortSignal.timeout(10_000))).value;
    } finally { await connection.close("fixture_request_complete"); }
  }
  async function status() {
    const response = await request({ managementVersion: 1, requestId: randomUUID(), operation: "status" });
    if (response.outcome !== "ok") throw new Error(JSON.stringify(response));
    return response.status;
  }
  let session: SidecarClientSession | undefined;
  let lease: SidecarRuntimeLease | undefined;
  let generation = 0;
  async function attach() {
    const connection = await stream();
    const sessionNonce = encode(randomUUID() + randomUUID());
    const signal = AbortSignal.timeout(10_000);
    await writeSidecarManagementRecord(connection, { managementVersion: 1, requestId: randomUUID(), operation: "attach", scope: serviceScope,
      expectedBuildId: artifact.buildId, expectedArtifactSha256: artifact.artifactSha256, runtimeWireVersion: SIDECAR_WIRE_VERSION,
      sessionNonce, carrierGeneration: ++generation, configuration: revision, mode: "normal" });
    const response = await readSidecarManagementRecord(connection, sidecarManagementResponseSchema, signal);
    if (response.value.outcome !== "ok") { await connection.close("fixture_attach_failed"); throw new Error(JSON.stringify(response.value)); }
    session = await SidecarClientSession.start({ connectionCompression: true, transportKind: "ssh_stdio", stream: response.stream, sessionNonce, carrierGeneration: generation, artifact,
      installation: { accountHome: home, stateRoot: paths.stateRoot, nodeExecutable: process.execPath, environment: { HOME: home }, executableDirectory: artifact.executableDirectory, executablePath: artifact.executablePath },
      authorizedCapabilities: [], authorizedRuntimeCapabilities: [piNativeRuntimeCapability], sedesOperations: new SidecarOperationRegistry(), signal });
    lease = { channel: session.runtimeChannel, closed: session.closed, controllerEpoch: response.value.status.controllerEpoch, serviceIncarnation: response.value.status.serviceIncarnation, release() {} };
  }
  const port = new PiNativeRemotePort({ configuration, sidecarRuntime: { acquire: async () => { if (!lease) throw new Error("fixture_carrier_missing"); return lease; }, acquireExisting: async () => { if (!lease) throw new Error("fixture_carrier_missing"); return lease; } } });
  async function close() {
    try {
      await port.close();
      await session?.close("fixture_complete");
      if (child.exitCode === null && child.signalCode === null) {
        const current = await status();
        const response = await request({ managementVersion: 1, requestId: randomUUID(), operation: "stop", expectedServiceIncarnation: current.serviceIncarnation,
          controllerEpoch: current.controllerEpoch, expectedConfiguration: current.desiredConfiguration, expectedResourcesFingerprint: current.resourcesFingerprint, force: true });
        if (response.outcome !== "ok") throw new Error(JSON.stringify(response));
      }
    } finally { await terminateChild(child); await rm(paths.socketDirectory, { recursive: true, force: true }); }
  }
  try {
    await vi.waitFor(async () => { if (child.exitCode !== null) throw new Error(`Bundled sidecar exited: ${stderr}`); await status(); }, { timeout: 15_000, interval: 25 });
    await attach();
    return { port, status, close, async reconnect() { await session?.close("fixture_carrier_replaced"); lease = undefined; await attach(); } };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
