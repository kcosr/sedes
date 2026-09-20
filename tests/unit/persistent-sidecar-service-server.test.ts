import { chmod, mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import { PersistentSidecarServiceServer } from "../../src/server/sidecar/persistent-sidecar-service-server.js";
import { PersistentSidecarManagementReceipts } from "../../src/server/sidecar/persistent-sidecar-management-receipts.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import { readSidecarManagementRecord, writeSidecarManagementRecord } from "../../src/internal/sidecar-protocol/service-management-channel.js";
import { sidecarManagementResponseSchema, type SidecarManagementRequest } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";

const scope = { installationId: "installation-a", tenantId: "tenant-a", principalId: "principal-a", executionEnvironmentId: "ssh-a" };
const configuration = { environmentRevision: 1, operationsRevision: 2 };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(options: { readonly onStopped?: () => Promise<void>; readonly receiptsDirectory?: string } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "sd-svc-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new PersistentSidecarServiceRegistry({ scope, configuration, buildId: "build-a", artifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION });
  const receiptsDirectory = options.receiptsDirectory ?? path.join(directory, "receipts");
  const receipts = new PersistentSidecarManagementReceipts(receiptsDirectory);
  const server = new PersistentSidecarServiceServer({ registry, endpointPath: path.join(directory, "s"), receipts, onStopped: options.onStopped ?? (async () => undefined), onRuntimeAttachment: () => undefined });
  await server.listen();
  cleanups.push(async () => { if (registry.status().state !== "stopped") await server.stop(true, "test_cleanup"); });
  const open = async () => {
    const socket = connect(path.join(directory, "s"));
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return sidecarSocketByteStream(socket);
  };
  const request = async (request: SidecarManagementRequest) => {
    const stream = await open();
    try { await writeSidecarManagementRecord(stream, request); return (await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, AbortSignal.timeout(2000))).value; }
    finally { await stream.close("test_request_complete"); }
  };
  return { registry, receipts, receiptsDirectory, server, request, open };
}

describe("persistent sidecar management service", () => {
  it("keeps management usable when the runtime version is incompatible", async () => {
    const { request } = await setup();
    const response = await request({ managementVersion: 1, requestId: randomUUID(), scope, operation: "attach", expectedBuildId: "new-build", expectedArtifactSha256: "b".repeat(64), runtimeWireVersion: 999, sessionNonce: "n".repeat(32), carrierGeneration: 1, configuration, mode: "normal" });
    expect(response.outcome).toBe("error");
    if (response.outcome === "error") expect(response.code).toBe("sidecar_runtime_upgrade_required");
    const status = await request({ managementVersion: 1, requestId: randomUUID(), scope, operation: "status" });
    expect(status.outcome).toBe("ok");
  });

  it("refreshes unknown resources through stable management and stops after an incompatible runtime attach", async () => {
    const { request, registry } = await setup();
    let known = false;
    const stop = vi.fn(async () => undefined);
    registry.register({ resourceId: "provider-a", kind: "provider",
      snapshot: () => ({ state: known ? "idle" : "unknown", revision: known ? "idle" : "unknown", blockers: known ? [] : ["unknown_state"] }),
      prepareRestart: async () => { known = true; }, stop });
    expect(await request({ managementVersion: 1, requestId: randomUUID(), scope, operation: "attach", expectedBuildId: "new-build",
      expectedArtifactSha256: "b".repeat(64), runtimeWireVersion: 999, sessionNonce: "n".repeat(32), carrierGeneration: 1, configuration, mode: "normal" }))
      .toMatchObject({ outcome: "error", code: "sidecar_runtime_upgrade_required" });
    const response = await request({ managementVersion: 1, requestId: randomUUID(), scope, operation: "status" });
    expect(response).toMatchObject({ outcome: "ok", status: { resources: [{ resourceId: "provider-a", state: "idle", blockers: [] }] } });
    const status = registry.status();
    expect(await request({ managementVersion: 1, requestId: randomUUID(), scope, operation: "stop", expectedServiceIncarnation: status.serviceIncarnation,
      controllerEpoch: status.controllerEpoch, expectedConfiguration: configuration, expectedResourcesFingerprint: status.resourcesFingerprint, force: true }))
      .toMatchObject({ outcome: "ok", status: { state: "stopped" } });
    expect(stop).toHaveBeenCalledWith("sidecar_service_explicit_stop", { force: true });
  });

  it("admits a compatible different build for normal and recovery attachment while gating the wire version", async () => {
    const { request, registry } = await setup();
    const attach = { managementVersion: 1 as const, requestId: randomUUID(), scope, operation: "attach" as const,
      expectedBuildId: "new-build", expectedArtifactSha256: "b".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION,
      sessionNonce: "n".repeat(32), carrierGeneration: 1, configuration };
    expect(await request({ ...attach, mode: "normal", runtimeWireVersion: SIDECAR_WIRE_VERSION + 1 })).toMatchObject({ outcome: "error", code: "sidecar_runtime_upgrade_required" });
    // The service reports its own build; the runtime handshake verifies it.
    expect(await request({ ...attach, mode: "normal" })).toMatchObject({ outcome: "ok", status: { buildId: "build-a", attachmentMode: "normal" } });
    expect(await request({ ...attach, mode: "recovery", runtimeWireVersion: SIDECAR_WIRE_VERSION + 1 })).toMatchObject({ outcome: "error", code: "sidecar_runtime_upgrade_required" });
    expect(await request({ ...attach, mode: "recovery" })).toMatchObject({ outcome: "ok", status: { buildId: "build-a", attachmentMode: "recovery" } });
    expect(() => registry.assertAdmission(registry.controllerEpoch)).toThrow();
  });

  it("does not disclose service inventory to the wrong principal", async () => {
    const { request } = await setup();
    const response = await request({ managementVersion: 1, requestId: randomUUID(), scope: { ...scope, principalId: "other" }, operation: "status" });
    expect(response).toMatchObject({ outcome: "error", code: "sidecar_service_scope_mismatch" });
    expect(response).not.toHaveProperty("status");
  });

  it("detaches an EOF without stopping admitted resources and fences recovery mode", async () => {
    const { registry, open } = await setup();
    const stop = vi.fn(async () => undefined);
    registry.register({ resourceId: "provider-a", kind: "provider", snapshot: () => ({ state: "idle", revision: "1", blockers: [] }), stop });
    const stream = await open();
    await writeSidecarManagementRecord(stream, { managementVersion: 1, requestId: randomUUID(), scope, operation: "attach", expectedBuildId: "build-a", expectedArtifactSha256: "a".repeat(64), runtimeWireVersion: SIDECAR_WIRE_VERSION, sessionNonce: "n".repeat(32), carrierGeneration: 1, configuration, mode: "recovery" });
    const response = (await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, AbortSignal.timeout(2000))).value;
    expect(response.outcome).toBe("ok");
    registry.assertController(registry.controllerEpoch);
    expect(() => registry.assertAdmission(registry.controllerEpoch)).toThrow("sidecar_recovery_attachment_read_only");
    await stream.close("test_upstream_lost");
    await vi.waitFor(() => expect(registry.attached).toBe(false));
    expect(stop).not.toHaveBeenCalled();
  });

  it("retires the endpoint even when the requester vanished before reading its response", async () => {
    const { registry, server, receipts, open } = await setup();
    let stopStarted!: () => void;
    const started = new Promise<void>((resolve) => { stopStarted = resolve; });
    registry.register({ resourceId: "slow", kind: "operation", snapshot: () => ({ state: "idle", revision: "1", blockers: [] }),
      stop: () => { stopStarted(); return new Promise((resolve) => setTimeout(resolve, 300)); } });
    const status = registry.status();
    const mutationId = randomUUID();
    const stream = await open();
    await writeSidecarManagementRecord(stream, { managementVersion: 1, requestId: mutationId, scope, operation: "restart", expectedServiceIncarnation: status.serviceIncarnation,
      controllerEpoch: status.controllerEpoch, expectedConfiguration: configuration, expectedResourcesFingerprint: status.resourcesFingerprint, force: true });
    await started;
    await stream.close("requester_vanished");
    await expect(Promise.race([server.closed.then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("still listening"), 3_000))])).resolves.toBe("closed");
    expect(registry.status().state).toBe("stopped");
    expect(await receipts.read(mutationId)).toMatchObject({ mutationId, state: "completed" });
  });

  it("keeps the exact completed control receipt after the service endpoint exits", async () => {
    const { registry, request, server, receipts } = await setup();
    const status = registry.status();
    const mutationId = randomUUID();
    const response = await request({ managementVersion: 1, requestId: mutationId, scope, operation: "stop", expectedServiceIncarnation: status.serviceIncarnation,
      controllerEpoch: status.controllerEpoch, expectedConfiguration: configuration, expectedResourcesFingerprint: status.resourcesFingerprint, force: false });
    expect(response.outcome).toBe("ok");
    await server.closed;
    expect(await receipts.read(mutationId)).toMatchObject({ mutationId, state: "completed", serviceIncarnation: status.serviceIncarnation });
  });

  it("settles a retirement that fails after its resources stopped as failed, answers with the code, and still retires the endpoint", async () => {
    const code = "sidecar_service_process_identity_unavailable";
    const onStopped = vi.fn(async () => { throw new Error(code); });
    const { registry, request, server, receipts, receiptsDirectory } = await setup({ onStopped });
    const status = registry.status();
    const mutationId = randomUUID();
    const control: SidecarManagementRequest = { managementVersion: 1, requestId: mutationId, scope, operation: "stop", expectedServiceIncarnation: status.serviceIncarnation,
      controllerEpoch: status.controllerEpoch, expectedConfiguration: configuration, expectedResourcesFingerprint: status.resourcesFingerprint, force: false };
    expect(await request(control)).toMatchObject({ outcome: "error", code, status: { state: "stopped" } });
    expect(onStopped).toHaveBeenCalledTimes(1);
    // The resources are gone, so the daemon must exit instead of listening on
    // their behalf, even though the retirement itself could not be recorded.
    await expect(Promise.race([server.closed.then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("still listening"), 3_000))])).resolves.toBe("closed");
    expect(await receipts.read(mutationId)).toMatchObject({ mutationId, state: "failed", code, serviceIncarnation: status.serviceIncarnation });
    // A replacement service sharing the ledger answers the replay with the
    // recorded failure rather than pending forever or retiring itself.
    const replacementStopped = vi.fn(async () => undefined);
    const replacement = await setup({ receiptsDirectory, onStopped: replacementStopped });
    expect(await replacement.request(control)).toMatchObject({ outcome: "receipt", receipt: { mutationId, state: "failed", code } });
    expect(replacement.registry.status().state).toBe("ready");
    expect(replacementStopped).not.toHaveBeenCalled();
  });

  it("retires the endpoint when the completed receipt cannot be written after a recorded retirement", async () => {
    let receiptsDirectory = "";
    const onStopped = vi.fn(async () => { await chmod(receiptsDirectory, 0o500); });
    const fixture = await setup({ onStopped });
    ({ receiptsDirectory } = fixture);
    cleanups.push(() => chmod(receiptsDirectory, 0o700));
    const { registry, request, server, receipts } = fixture;
    const status = registry.status();
    const mutationId = randomUUID();
    const response = await request({ managementVersion: 1, requestId: mutationId, scope, operation: "stop", expectedServiceIncarnation: status.serviceIncarnation,
      controllerEpoch: status.controllerEpoch, expectedConfiguration: configuration, expectedResourcesFingerprint: status.resourcesFingerprint, force: false });
    expect(response).toMatchObject({ outcome: "error", code: "sidecar_management_receipt_unsettled", status: { state: "stopped" } });
    expect(onStopped).toHaveBeenCalledTimes(1);
    await expect(Promise.race([server.closed.then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("still listening"), 3_000))])).resolves.toBe("closed");
    await chmod(receiptsDirectory, 0o700);
    // The ledger never learned the outcome, and the receipt says exactly that.
    expect(await receipts.read(mutationId)).toMatchObject({ mutationId, state: "accepted", serviceIncarnation: status.serviceIncarnation });
  });

  it("withdraws an unadmitted control id and refuses that command when it arrives later", async () => {
    const { registry, request, receipts } = await setup();
    const stop = vi.fn(async () => undefined);
    registry.register({ resourceId: "provider-a", kind: "provider", snapshot: () => ({ state: "idle", revision: "1", blockers: [] }), stop });
    const status = registry.status();
    const mutationId = randomUUID();
    expect(await request({ managementVersion: 1, requestId: randomUUID(), scope, operation: "withdraw", mutationId, expectedServiceIncarnation: "replaced-service" }))
      .toMatchObject({ outcome: "error", code: "sidecar_service_confirmation_stale" });
    expect(await receipts.read(mutationId)).toBeUndefined();
    expect(await request({ managementVersion: 1, requestId: randomUUID(), scope, operation: "withdraw", mutationId, expectedServiceIncarnation: status.serviceIncarnation }))
      .toMatchObject({ outcome: "receipt", receipt: { mutationId, state: "withdrawn", serviceIncarnation: status.serviceIncarnation } });
    expect(await request({ managementVersion: 1, requestId: mutationId, scope, operation: "stop", expectedServiceIncarnation: status.serviceIncarnation,
      controllerEpoch: status.controllerEpoch, expectedConfiguration: configuration, expectedResourcesFingerprint: status.resourcesFingerprint, force: true }))
      .toMatchObject({ outcome: "error", code: "sidecar_management_mutation_withdrawn" });
    expect(stop).not.toHaveBeenCalled();
    expect(registry.status().state).toBe("ready");
    expect(await receipts.read(mutationId)).toMatchObject({ state: "withdrawn" });
    expect(await request({ managementVersion: 1, requestId: randomUUID(), scope, operation: "withdraw", mutationId, expectedServiceIncarnation: status.serviceIncarnation }))
      .toMatchObject({ outcome: "receipt", receipt: { state: "withdrawn" } });
  });

  it("returns an admission that already exists instead of withdrawing it", async () => {
    const { registry, request, receipts, open } = await setup();
    let releaseStop!: () => void;
    const held = new Promise<void>((resolve) => { releaseStop = resolve; });
    let stopStarted!: () => void;
    const started = new Promise<void>((resolve) => { stopStarted = resolve; });
    registry.register({ resourceId: "slow", kind: "operation", snapshot: () => ({ state: "idle", revision: "1", blockers: [] }), stop: () => { stopStarted(); return held; } });
    const status = registry.status();
    const mutationId = randomUUID();
    const stream = await open();
    await writeSidecarManagementRecord(stream, { managementVersion: 1, requestId: mutationId, scope, operation: "stop", expectedServiceIncarnation: status.serviceIncarnation,
      controllerEpoch: status.controllerEpoch, expectedConfiguration: configuration, expectedResourcesFingerprint: status.resourcesFingerprint, force: true });
    await started;
    expect(await request({ managementVersion: 1, requestId: randomUUID(), scope, operation: "withdraw", mutationId, expectedServiceIncarnation: status.serviceIncarnation }))
      .toMatchObject({ outcome: "receipt", receipt: { mutationId, state: "accepted" } });
    releaseStop();
    expect((await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, AbortSignal.timeout(2000))).value.outcome).toBe("ok");
    await stream.close("test_request_complete");
    expect(await receipts.read(mutationId)).toMatchObject({ state: "completed" });
  });

  it("does not begin a control whose requester ended before its admission completed", async () => {
    const { registry, request, receipts, open } = await setup();
    const stop = vi.fn(async () => undefined);
    registry.register({ resourceId: "provider-a", kind: "provider", snapshot: () => ({ state: "idle", revision: "1", blockers: [] }), stop });
    const status = registry.status();
    const mutationId = randomUUID();
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => { admit = resolve; });
    const begin = receipts.begin.bind(receipts);
    vi.spyOn(receipts, "begin").mockImplementation(async (...args) => { await admitted; return begin(...args); });
    const stream = await open();
    await writeSidecarManagementRecord(stream, { managementVersion: 1, requestId: mutationId, scope, operation: "stop", expectedServiceIncarnation: status.serviceIncarnation,
      controllerEpoch: status.controllerEpoch, expectedConfiguration: configuration, expectedResourcesFingerprint: status.resourcesFingerprint, force: true });
    await stream.close("requester_vanished");
    await new Promise((resolve) => setTimeout(resolve, 50));
    admit();
    await vi.waitFor(async () => expect(await receipts.read(mutationId)).toMatchObject({ state: "failed", code: "sidecar_management_requester_gone" }));
    expect(stop).not.toHaveBeenCalled();
    expect(registry.status().state).toBe("ready");
    expect((await request({ managementVersion: 1, requestId: randomUUID(), scope, operation: "status" })).outcome).toBe("ok");
  });
});
