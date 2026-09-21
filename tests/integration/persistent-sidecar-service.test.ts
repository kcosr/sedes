import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { persistentSidecarPaths } from "../../src/server/sidecar/persistent-sidecar-paths.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import { readSidecarManagementRecord, writeSidecarManagementRecord } from "../../src/internal/sidecar-protocol/service-management-channel.js";
import { sidecarManagementResponseSchema, type SidecarManagementRequest } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import { loadSidecarArtifactRegistration, type SidecarArtifactRegistration } from "../../src/server/sidecar/sidecar-artifact.js";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { workspaceFilesRootOpenOperation, workspaceFilesReadOperation, workspaceFilesWriteOperation, workspaceFilesMutationInspectOperation, workspaceFilesMutationAcknowledgeOperation } from "../../src/internal/sidecar-protocol/workspace-files-v8.js";
import { terminalPrepareOperation, terminalCreateOperation, terminalAttachOperation, terminalInputOperation, terminalSnapshotChunkOperation, terminalStopOperation, terminalAcknowledgeOperation, terminalForgetOperation } from "../../src/internal/sidecar-protocol/interactive-terminal-v2.js";
import { SidecarRuntimeOwner } from "../../src/server/sidecar/sidecar-runtime.js";
import { SshSidecarArtifactInstaller } from "../../src/server/sidecar/ssh-sidecar-artifact-installer.js";
import { PersistentSidecarManagementReceipts } from "../../src/server/sidecar/persistent-sidecar-management-receipts.js";

type UnscopedRequest = SidecarManagementRequest extends infer Request ? Request extends { scope: unknown } ? Omit<Request, "scope"> : never : never;
const configuration = { environmentRevision: 1, operationsRevision: 1 };
const cleanups: Array<() => Promise<void>> = [];
let artifact: SidecarArtifactRegistration;
let buildDirectory: string;
beforeAll(async () => {
  buildDirectory = await mkdtemp(path.join(tmpdir(), "sedes-service-build-"));
  await command(process.execPath, ["scripts/build-sidecar.mjs", "--output-directory", buildDirectory]);
  artifact = await loadSidecarArtifactRegistration(path.join(buildDirectory, "manifest.json"));
}, 60_000);
afterAll(async () => { if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true }); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(nativeAssets = false, selectedArtifact = artifact) {
  const home = await mkdtemp(path.join(tmpdir(), "sedes-service-"));
  await chmod(home, 0o700);
  const scope = { installationId: randomUUID(), tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote" };
  const paths = persistentSidecarPaths(home, process.getuid!(), scope);
  await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
  const executable = path.join(home, "sedes");
  await copyFile(selectedArtifact.executablePath, executable);
  await chmod(executable, 0o500);
  if (nativeAssets) for (const target of selectedArtifact.nativeAssets) for (const file of target.files) {
    const destination = path.join(home, file.relativePath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(path.join(selectedArtifact.executableDirectory, file.relativePath), destination);
    await chmod(destination, file.mode);
  }
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
      expectedConfiguration: current.desiredConfiguration, expectedResourcesFingerprint: current.resourcesFingerprint, force: false } as UnscopedRequest);
    if (response.outcome !== "ok") throw new Error(JSON.stringify(response));
    return mutationId;
  };
  cleanups.push(async () => {
    try { await stop(); } catch (error) { if (!(error && typeof error === "object" && "code" in error && ["ENOENT", "ECONNREFUSED"].includes(String(error.code)))) throw error; }
    await rm(home, { recursive: true, force: true });
    await rm(paths.socketDirectory, { recursive: true, force: true });
  });
  const launch = async () => {
    const child = spawn(process.execPath, [executable, "service", "connect", "--expected-digest", selectedArtifact.artifactSha256,
      "--expected-build", selectedArtifact.buildId, "--service-scope", encode(scope), "--configuration", encode(configuration),
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
      expectedBuildId: selectedArtifact.buildId, expectedArtifactSha256: selectedArtifact.artifactSha256, runtimeWireVersion: SIDECAR_WIRE_VERSION,
      sessionNonce, carrierGeneration: 1, configuration, mode });
    const response = await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, signal);
    if (response.value.outcome !== "ok") throw new Error(JSON.stringify(response.value));
    return await SidecarClientSession.start({ transportKind: "ssh_stdio", stream: response.stream, sessionNonce, carrierGeneration: 1, artifact: selectedArtifact,
      installation: { accountHome: home, stateRoot: paths.stateRoot, nodeExecutable: process.execPath,
        environment: { HOME: home }, executableDirectory: home, executablePath: executable },
      authorizedCapabilities: [{ capabilityId: "workspace_files", majorVersion: 8 }, ...(nativeAssets ? [{ capabilityId: "interactive_terminal" as const, majorVersion: 2 as const }] : [])], authorizedRuntimeCapabilities: [],
      sedesOperations: new SidecarOperationRegistry(), signal });
  };
  return { home, scope, paths, request, status, stop, launch, attach };
}

function localInstaller(service: { home: string; scope: Awaited<ReturnType<typeof fixture>>["scope"] }, selectedArtifact = artifact) {
  return new SshSidecarArtifactInstaller({ host: "fixture-host", artifact: selectedArtifact, serviceScope: service.scope, configuration,
      agentToolEndpointKey: "1234567890abcdef12345678", testOnlyAccountHome: service.home,
      spawnProcess: (_executable, args) => args.includes("-G")
        ? spawn(process.execPath, ["-e", "process.stdout.write('clearallforwardings yes\\nforwardagent no\\n')"], { stdio: ["pipe", "pipe", "pipe"] })
        : spawn("/bin/sh", ["-c", args.at(-1)!], { stdio: ["pipe", "pipe", "pipe"] }),
    });
}

async function command(executable: string, args: string[]): Promise<void> {
  const child = spawn(executable, args, { env: { ...process.env, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(output))); });
}
function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

describe("bundled persistent sidecar service", () => {
  it("upgrades a live service whose clean shutdown writes the previous ownership format", async () => {
    const currentSource = await readFile(artifact.executablePath, "utf8");
    const writer = "JSON.stringify(descriptor)";
    expect(currentSource.split(writer)).toHaveLength(2);
    // Reproduce the exact pre-lifetime descriptor written by the deployed
    // predecessor; retain the real daemon, resource cleanup and management path.
    const previousSource = currentSource.replace(writer,
      "JSON.stringify({scope:descriptor.scope,state:descriptor.state,process:{pid:descriptor.process.pid,startTime:descriptor.process.startTime,bootId:descriptor.process.bootId},serviceIncarnation:descriptor.serviceIncarnation})");
    const executableDirectory = path.join(buildDirectory, "previous-ownership");
    await mkdir(executableDirectory);
    const executablePath = path.join(executableDirectory, "sedes");
    await writeFile(executablePath, previousSource, { mode: 0o500 });
    const previousArtifact = { ...artifact, executableDirectory, executablePath,
      artifactSha256: createHash("sha256").update(previousSource).digest("hex"), artifactBytes: Buffer.byteLength(previousSource) };
    const service = await fixture(false, previousArtifact);
    const first = await service.launch();
    expect(JSON.parse(await readFile(service.paths.descriptorPath, "utf8"))).not.toHaveProperty("version");
    const installer = localInstaller(service);
    const replacement = await installer.control({ mutationId: randomUUID(), operation: "upgrade", expectedServiceIncarnation: first.serviceIncarnation,
      controllerEpoch: first.controllerEpoch, expectedConfiguration: first.desiredConfiguration, expectedResourcesFingerprint: first.resourcesFingerprint, force: false }, AbortSignal.timeout(20_000));
    expect(replacement?.serviceIncarnation).not.toBe(first.serviceIncarnation);
    expect(replacement?.artifactSha256).toBe(artifact.artifactSha256);
    expect(JSON.parse(await readFile(service.paths.descriptorPath, "utf8"))).toMatchObject({ version: 3, serviceIncarnation: replacement?.serviceIncarnation });
  }, 30_000);

  it("concurrent ensures start one incarnation and SSH EOF leaves it running", async () => {
    const service = await fixture();
    const results = await Promise.all([service.launch(), service.launch(), service.launch()]);
    expect(new Set(results.map(result => result.serviceIncarnation)).size).toBe(1);
    const reconnect = await service.launch();
    expect(reconnect.serviceIncarnation).toBe(results[0]!.serviceIncarnation);
    expect(reconnect.resources.map(resource => resource.resourceId)).toContain("workspace-files");
    expect(reconnect.attached).toBe(false);
  }, 30_000);

  it("incompatible runtime still supports passive inventory and durable stop then clean replacement", async () => {
    const service = await fixture();
    const first = await service.launch();
    const response = await service.request({ managementVersion: 1, requestId: randomUUID(), operation: "attach",
      expectedBuildId: "future-build", expectedArtifactSha256: "f".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION + 1,
      sessionNonce: "n".repeat(32), carrierGeneration: 1, configuration, mode: "normal" } as UnscopedRequest);
    expect(response).toMatchObject({ outcome: "error", code: "sidecar_runtime_upgrade_required" });
    expect((await service.status()).serviceIncarnation).toBe(first.serviceIncarnation);
    const mutationId = await service.stop();
    const receipts = new PersistentSidecarManagementReceipts(path.join(service.paths.serviceDirectory, "management-receipts"));
    expect(await receipts.read(mutationId)).toMatchObject({ state: "completed", serviceIncarnation: first.serviceIncarnation });
    const replacement = await service.launch();
    expect(replacement.serviceIncarnation).not.toBe(first.serviceIncarnation);
  }, 30_000);
  it("recovers and acknowledges retained mutations after a main restart removes normal file grants", async () => {
    const service = await fixture();
    await service.launch();
    const workspace = path.join(service.home, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "note.txt"), "before");
    const first = await service.attach();
    const root = await first.runtimeChannel.call(workspaceFilesRootOpenOperation, { admissionId: randomUUID(), rootId: "primary", rootKind: "primary", declaredPath: workspace, policyRootPath: service.home });
    const before = await first.runtimeChannel.call(workspaceFilesReadOperation, { rootHandle: root.rootHandle, path: "note.txt" });
    const operationId = randomUUID();
    await first.runtimeChannel.call(workspaceFilesWriteOperation, { operationId, rootHandle: root.rootHandle, path: "note.txt", content: "after", expectedRevision: before.revision });
    await first.close("main_process_stopped");
    const detached = await service.status();
    expect(detached.resources.find(resource => resource.resourceId === "workspace-files")?.blockers).toContain("unsettled_outcome");
    const installer = localInstaller(service);
    const owner = new SidecarRuntimeOwner({ scope: { tenantId: service.scope.tenantId, principalId: service.scope.principalId },
      executionEnvironmentId: service.scope.executionEnvironmentId, environmentConfigurationRevision: 1, operationsConfigurationRevision: 1,
      authorizedCapabilities: [], authorizedRuntimeCapabilities: [], isAutomaticConnectionEnabled: () => false,
      activeEnvironmentConfigurationRevision: () => 1, activeOperationsConfigurationRevision: () => 1,
      artifact, provisioner: installer, sedesOperations: new SidecarOperationRegistry(), startSession: (input) => SidecarClientSession.start(input) });
    cleanups.push(() => owner.close());
    const authority = { tenantId: service.scope.tenantId, principalId: service.scope.principalId };
    const signal = AbortSignal.timeout(15_000);
    await expect(owner.acquireOperation(authority, service.scope.executionEnvironmentId, signal)).rejects.toThrow("sidecar_unavailable");
    const recovered = await owner.acquireRecovery(authority, service.scope.executionEnvironmentId, signal, [{ capabilityId: "workspace_files", majorVersion: 8 }]);
    const recovery = recovered.session;
    expect(recovered.serviceStatus.attachmentMode).toBe("recovery");
    expect(await recovery.runtimeChannel.call(workspaceFilesMutationInspectOperation, { operationId })).toMatchObject({ state: "succeeded", result: { path: "note.txt" } });
    await expect(recovery.runtimeChannel.call(workspaceFilesRootOpenOperation, { admissionId: randomUUID(), rootId: "primary", rootKind: "primary", declaredPath: workspace, policyRootPath: service.home })).rejects.toMatchObject({ code: "sidecar_operation_failed" });
    expect(await recovery.runtimeChannel.call(workspaceFilesMutationAcknowledgeOperation, { operationId })).toEqual({ acknowledged: true });
    recovered.release(); await recovery.closed;
    await expect(owner.acquireOperation(authority, service.scope.executionEnvironmentId, signal)).rejects.toThrow("sidecar_unavailable");
    expect(await readFile(path.join(workspace, "note.txt"), "utf8")).toBe("after");
    expect((await service.status()).resources.find(resource => resource.resourceId === "workspace-files")?.blockers).toEqual([]);
  }, 30_000);

  it("keeps an actual packaged PTY and screen alive when its controller disappears", async () => {
    const service = await fixture(true);
    await service.launch();
    const identity = { terminalId: randomUUID(), incarnationId: randomUUID() };
    let created = false;
    try {
      const first = await service.attach();
      const prepared = await first.runtimeChannel.call(terminalPrepareOperation, { ...identity, initialCwd: service.home, rows: 24, columns: 80 });
      await first.runtimeChannel.call(terminalCreateOperation, prepared);
      created = true;
      const attached = await first.runtimeChannel.call(terminalAttachOperation, identity);
      expect(await first.runtimeChannel.call(terminalInputOperation, { ...identity, controllerToken: attached.controllerToken, controlSeq: 1,
        data: Buffer.from("printf 'persistent-pty-marker\\n'\n").toString("base64url") })).toEqual({ outcome: "sent" });
      await first.close("main_process_stopped");
      expect((await service.status()).resources.some(resource => resource.blockers.includes("live_terminal"))).toBe(true);
      const second = await service.attach();
      await vi.waitFor(async () => {
        const restored = await second.runtimeChannel.call(terminalAttachOperation, identity);
        const screen = await second.runtimeChannel.call(terminalSnapshotChunkOperation, { ...identity, controllerToken: restored.controllerToken, snapshotId: restored.snapshot.snapshotId, offset: 0 });
        expect(Buffer.from(screen.data, "base64url").toString("utf8")).toContain("persistent-pty-marker");
      });
      await second.close("viewer_detached");
    } finally {
      if (created) {
        const newDirectory = path.join(service.home, "new-client");
        await cp(buildDirectory, newDirectory, { recursive: true });
        const newExecutable = path.join(newDirectory, "sedes");
        const originalSource = await readFile(newExecutable, "utf8");
        const nextBuildId = "next-client-build";
        expect(originalSource).toContain(JSON.stringify(artifact.buildId));
        const newBytes = Buffer.from(originalSource.replaceAll(JSON.stringify(artifact.buildId), JSON.stringify(nextBuildId)));
        await chmod(newExecutable, 0o600);
        await writeFile(newExecutable, newBytes);
        await chmod(newExecutable, 0o500);
        // Update the actual compiled identifier with its descriptor so the
        // replacement is launchable after the old service has been stopped.
        const nextArtifact = { ...artifact, buildId: nextBuildId, artifactSha256: createHash("sha256").update(newBytes).digest("hex"),
          artifactBytes: newBytes.length, executableDirectory: newDirectory, executablePath: newExecutable };
        const installer = localInstaller(service, nextArtifact);
        const owner = new SidecarRuntimeOwner({ scope: { tenantId: service.scope.tenantId, principalId: service.scope.principalId },
          executionEnvironmentId: service.scope.executionEnvironmentId, environmentConfigurationRevision: 1, operationsConfigurationRevision: 1,
          authorizedCapabilities: [{ capabilityId: "interactive_terminal", majorVersion: 2 }], authorizedRuntimeCapabilities: [], isAutomaticConnectionEnabled: () => true,
          activeEnvironmentConfigurationRevision: () => 1, activeOperationsConfigurationRevision: () => 1,
          artifact: nextArtifact, provisioner: installer, sedesOperations: new SidecarOperationRegistry(), startSession: (input) => SidecarClientSession.start(input) });
        cleanups.push(() => owner.close());
        const authority = { tenantId: service.scope.tenantId, principalId: service.scope.principalId };
        const signal = AbortSignal.timeout(15_000);
        const retained = await owner.acquireOperation(authority, service.scope.executionEnvironmentId, signal);
        expect(retained.serviceStatus!.artifactSha256).toBe(artifact.artifactSha256);
        retained.release();
        const current = await service.status();
        expect(await service.request({ managementVersion: 1, requestId: randomUUID(), operation: "restart",
          expectedServiceIncarnation: current.serviceIncarnation, controllerEpoch: current.controllerEpoch,
          expectedConfiguration: current.desiredConfiguration, expectedResourcesFingerprint: current.resourcesFingerprint, force: true })).toMatchObject({
            outcome: "ok", status: { state: "stopped", resources: [] } });
        await retained.session.closed;
        // Explicit interruption releases final PTY history without requiring a
        // compatible viewer to adopt it before the new artifact can start.
        const replacement = await owner.acquireOperation(authority, service.scope.executionEnvironmentId, signal);
        expect((await installer.inspect(signal))!.artifactSha256).toBe(nextArtifact.artifactSha256);
        replacement.release();
        await owner.close();
      }
    }
  }, 30_000);

  it("does not spawn a replacement after an unconfirmed supervisor death", async () => {
    const service = await fixture();
    const first = await service.launch();
    const descriptor = JSON.parse(await readFile(service.paths.descriptorPath, "utf8"));
    expect(descriptor.serviceIncarnation).toBe(first.serviceIncarnation);
    process.kill(descriptor.process.pid, "SIGKILL");
    await vi.waitFor(async () => { await expect(service.status()).rejects.toMatchObject({ code: "ECONNREFUSED" }); });
    await expect(service.launch()).rejects.toThrow("sidecar_service_orphan_cleanup_unproven");
    expect(JSON.parse(await readFile(service.paths.descriptorPath, "utf8")).serviceIncarnation).toBe(first.serviceIncarnation);
  }, 30_000);

  it("installs the native bundle and replays completed controls without stopping their replacement", async () => {
    const service = await fixture();
    const installer = localInstaller(service);
    const signal = AbortSignal.timeout(20_000);
    await installer.install(signal);
    const stream = await installer.launch(1, "n".repeat(48), signal);
    const first = stream.serviceStatus;
    await stream.close("main_process_stopped");
    const input = { mutationId: randomUUID(), operation: "restart" as const, expectedServiceIncarnation: first.serviceIncarnation,
      controllerEpoch: first.controllerEpoch, expectedConfiguration: first.desiredConfiguration, expectedResourcesFingerprint: first.resourcesFingerprint, force: false };
    const replacement = await installer.control(input, signal);
    expect(replacement!.serviceIncarnation).not.toBe(first.serviceIncarnation);
    expect((await installer.control(input, signal))!.serviceIncarnation).toBe(replacement!.serviceIncarnation);
    const stopping = { ...input, mutationId: randomUUID(), operation: "stop" as const,
      expectedServiceIncarnation: replacement!.serviceIncarnation, controllerEpoch: replacement!.controllerEpoch,
      expectedConfiguration: replacement!.desiredConfiguration, expectedResourcesFingerprint: replacement!.resourcesFingerprint };
    // A withdrawn id fences a late arrival of its control through the same
    // management path; the fenced service keeps running.
    const fenced = { ...stopping, mutationId: randomUUID() };
    expect(await installer.withdrawReceipt(fenced.mutationId, replacement!.serviceIncarnation, signal)).toMatchObject({ mutationId: fenced.mutationId, state: "withdrawn", serviceIncarnation: replacement!.serviceIncarnation });
    await expect(installer.control(fenced, signal)).rejects.toMatchObject({ code: "sidecar_management_mutation_withdrawn", outcome: "rejected" });
    expect((await installer.inspect(signal))!.serviceIncarnation).toBe(replacement!.serviceIncarnation);
    expect(await installer.inspectReceipt(fenced.mutationId, signal)).toMatchObject({ state: "withdrawn" });
    expect(await installer.control(stopping, signal)).toBeUndefined();
    expect(await installer.control(stopping, signal)).toBeUndefined();
    expect(await installer.inspectReceipt(stopping.mutationId, signal)).toMatchObject({ state: "completed" });
    // Withdrawal has nothing to fence once the service is durably gone.
    expect(await installer.withdrawReceipt(randomUUID(), replacement!.serviceIncarnation, signal)).toBeUndefined();
  }, 30_000);

});
