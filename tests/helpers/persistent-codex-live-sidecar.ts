import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { persistentSidecarPaths } from "../../src/server/sidecar/persistent-sidecar-paths.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import { readSidecarManagementRecord, writeSidecarManagementRecord } from "../../src/internal/sidecar-protocol/service-management-channel.js";
import { sidecarManagementResponseSchema, type SidecarManagementRequest } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import { loadSidecarArtifactRegistration } from "../../src/server/sidecar/sidecar-artifact.js";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";

type UnscopedRequest = SidecarManagementRequest extends infer Request ? Request extends { scope: unknown } ? Omit<Request, "scope"> : never : never;

/** Real bundled service in a private HOME; loopback Unix transport replaces only
 * the outer SSH byte carrier. Provider hosting and management are production code. */
export async function createPersistentCodexLiveSidecar() {
  const buildDirectory = await mkdtemp(path.join(tmpdir(), "sedes-codex-live-build-"));
  const cleanups: Array<() => Promise<void>> = [];
  try {
    await command(process.execPath, ["scripts/build-sidecar.mjs", "--output-directory", buildDirectory]);
    const manifest = JSON.parse(await readFile(path.join(buildDirectory, "manifest.json"), "utf8")) as { sha256: string; buildId: string };
    const artifact = await loadSidecarArtifactRegistration(path.join(buildDirectory, "manifest.json"));
    const configuration = { environmentRevision: 1, operationsRevision: 1 };
    async function fixture() {
      const home = await mkdtemp(path.join(tmpdir(), "sedes-service-"));
      await chmod(home, 0o700);
      const scope = { installationId: randomUUID(), tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote" };
      const paths = persistentSidecarPaths(home, process.getuid!(), scope);
      await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
      const executable = path.join(home, "sedes");
      await copyFile(artifact.executablePath, executable);
      await chmod(executable, 0o500);
      const request = async (input: UnscopedRequest) => {
        const socket = connect(paths.endpointPath);
        await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
        const stream = sidecarSocketByteStream(socket);
        try {
          await writeSidecarManagementRecord(stream, { ...input, scope });
          return (await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, AbortSignal.timeout(5_000))).value;
        } finally { await stream.close("test_request_complete"); }
      };
      const status = async () => {
        const response = await request({ managementVersion: 1, requestId: randomUUID(), operation: "status" });
        if (response.outcome !== "ok") throw new Error(JSON.stringify(response));
        return response.status;
      };
      const stop = async () => {
        const current = await status();
        const mutationId = randomUUID();
        const response = await request({ managementVersion: 1, requestId: mutationId, operation: "stop",
          expectedServiceIncarnation: current.serviceIncarnation, controllerEpoch: current.controllerEpoch,
          expectedConfiguration: current.desiredConfiguration, expectedResourcesFingerprint: current.resourcesFingerprint, force: true } as UnscopedRequest);
        if (response.outcome !== "ok") throw new Error(JSON.stringify(response));
        return mutationId;
      };
      cleanups.push(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await stop(); break; }
          catch (error) {
            if (error && typeof error === "object" && "code" in error && ["ENOENT", "ECONNREFUSED"].includes(String(error.code))) break;
            if (attempt === 2 || !(error instanceof Error) || !error.message.includes("confirmation_stale")) throw error;
          }
        }
        await rm(home, { recursive: true, force: true });
        await rm(paths.socketDirectory, { recursive: true, force: true });
      });
      const launch = async () => {
        const child = spawn(process.execPath, [executable, "service", "connect", "--expected-digest", manifest.sha256,
          "--expected-build", manifest.buildId, "--service-scope", encode(scope), "--configuration", encode(configuration),
          "--agent-tool-endpoint-key", "1234567890abcdef12345678"], { env: { HOME: home, PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", bytes => { stderr += String(bytes); });
        const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
        child.stdin.write(JSON.stringify({ managementVersion: 1, requestId: randomUUID(), scope, operation: "status" }) + "\n");
        let output = "";
        for await (const chunk of child.stdout) output += String(chunk);
        const exitCode = await closed;
        if (exitCode !== 0) throw new Error(`service_connect_failed:${stderr}`);
        const response = sidecarManagementResponseSchema.parse(JSON.parse(output));
        if (response.outcome !== "ok") throw new Error(JSON.stringify(response));
        return response.status;
      };
      const attach = async (mode: "normal" | "recovery" = "normal") => {
        const socket = connect(paths.endpointPath);
        await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
        const stream = sidecarSocketByteStream(socket);
        const sessionNonce = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
        const signal = AbortSignal.timeout(10_000);
        await writeSidecarManagementRecord(stream, { managementVersion: 1, requestId: randomUUID(), operation: "attach", scope,
          expectedBuildId: artifact.buildId, expectedArtifactSha256: artifact.artifactSha256, runtimeWireVersion: SIDECAR_WIRE_VERSION,
          sessionNonce, carrierGeneration: 1, configuration, mode });
        const response = await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, signal);
        if (response.value.outcome !== "ok") throw new Error(JSON.stringify(response.value));
        const session = await SidecarClientSession.start({ transportKind: "ssh_stdio", stream: response.stream, sessionNonce, carrierGeneration: 1, artifact,
          installation: { accountHome: home, stateRoot: paths.stateRoot, nodeExecutable: process.execPath,
            environment: { HOME: home }, executableDirectory: home, executablePath: executable },
          authorizedCapabilities: [], authorizedRuntimeCapabilities: [{ capabilityId: "codex_runtime", majorVersion: 1, operations: ["runtime.ensure", "runtime.lookup", "runtime.execute"] }],
          sedesOperations: new SidecarOperationRegistry(), signal });
        return { session, status: response.value.status };
      };
      return { home, scope, paths, request, status, stop, launch, attach };
    }

    const service = await fixture();
    await service.launch();
    return { ...service, close: async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
      await rm(buildDirectory, { recursive: true, force: true });
    } };
  } catch (error) {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await rm(buildDirectory, { recursive: true, force: true });
    throw error;
  }
}
function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
async function command(executable: string, args: string[]): Promise<void> {
  const child = spawn(executable, args, { env: { ...process.env, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(output))); });
}
