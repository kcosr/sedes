import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentSidecarManagementReceipts } from "../../src/server/sidecar/persistent-sidecar-management-receipts.js";
import { windowsSidecarPlatform } from "../../src/server/sidecar/sidecar-windows-platform.js";
const scope = { installationId: "installation", tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote" };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(capacity: number) {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-control-receipts-")); roots.push(root);
  const directory = path.join(root, "receipts");
  return { receipts: new PersistentSidecarManagementReceipts(directory, capacity), directory };
}
function receiptPath(directory: string, mutationId: string): string {
  return path.join(directory, `${createHash("sha256").update(mutationId).digest("hex")}.json`);
}
function request(requestId: string, incarnation = "incarnation-a") { return {
  managementVersion: 1 as const, requestId, scope, operation: "stop" as const, expectedServiceIncarnation: incarnation,
  controllerEpoch: 1, expectedConfiguration: { environmentRevision: 1, operationsRevision: 1 }, expectedResourcesFingerprint: "a".repeat(64), force: false,
}; }
describe("bounded durable sidecar control receipts", () => {
  it.skipIf(process.platform === "win32")("retains POSIX private modes and refuses symlink receipts", async () => {
    const { receipts, directory } = await fixture(2);
    await receipts.begin(request("a"), "incarnation-a");
    const filename = path.join(directory, (await readdir(directory))[0]!);
    await chmod(filename, 0o644);
    await expect(receipts.read("a")).rejects.toThrow("sidecar_management_receipt_invalid");
    await chmod(filename, 0o600);
    const copy = `${filename}.copy`;
    const { rename } = await import("node:fs/promises");
    await rename(filename, copy);
    await symlink(copy, filename);
    await expect(receipts.read("a")).rejects.toThrow("sidecar_management_receipt_invalid");
    await chmod(directory, 0o755);
    await expect(receipts.read("a")).rejects.toThrow("sidecar_management_receipts_namespace_invalid");
  });

  it("enforces Windows ACLs for creation, replacement, reads, and reclamation", async () => {
    const { receipts, directory } = await fixture(1);
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const privacy = vi.spyOn(windowsSidecarPlatform, "privacy").mockImplementation(async (filename, operation) => {
      if (operation === "ensure-directory") await mkdir(filename);
      // New receipt contents are not written until their ACL is secured.
      if (operation === "secure-file") expect(await readFile(filename, "utf8")).toBe("");
    });
    await receipts.begin(request("a"), "incarnation-a");
    await receipts.finish("a", "completed");
    expect(await receipts.read("a")).toMatchObject({ state: "completed" });
    await receipts.begin(request("b", "incarnation-b"), "incarnation-b");
    expect(await receipts.read("a")).toBeUndefined();
    expect(privacy).toHaveBeenCalledWith(directory, "ensure-directory");
    expect(privacy).toHaveBeenCalledWith(directory, "assert-directory");
    expect(privacy.mock.calls.filter(([, operation]) => operation === "secure-file")).toHaveLength(3);
    expect(privacy.mock.calls.filter(([, operation]) => operation === "assert-file").length).toBeGreaterThanOrEqual(3);
  });

  it("fails closed on untrusted Windows directories and receipts", async () => {
    const { receipts, directory } = await fixture(1);
    await receipts.begin(request("a"), "incarnation-a");
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const privacy = vi.spyOn(windowsSidecarPlatform, "privacy").mockRejectedValue(new Error("sidecar_windows_privacy_invalid"));
    await expect(receipts.read("a")).rejects.toThrow("sidecar_windows_privacy_invalid");
    expect(privacy).toHaveBeenCalledExactlyOnceWith(directory, "assert-directory");
    privacy.mockImplementation(async (_filename, operation) => {
      if (operation === "assert-file") throw new Error("sidecar_windows_privacy_invalid");
    });
    await expect(receipts.finish("a", "completed")).rejects.toThrow("sidecar_windows_privacy_invalid");
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("retains the admitted receipt if securing its Windows replacement fails", async () => {
    const { receipts, directory } = await fixture(1);
    await receipts.begin(request("a"), "incarnation-a");
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.spyOn(windowsSidecarPlatform, "privacy").mockImplementation(async (_filename, operation) => {
      if (operation === "secure-file") throw new Error("sidecar_windows_privacy_invalid");
    });
    await expect(receipts.finish("a", "completed")).rejects.toThrow("sidecar_windows_privacy_invalid");
    expect(await receipts.read("a")).toMatchObject({ state: "accepted" });
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("serializes concurrent admissions without evicting uncertain effects", async () => {
    const { receipts, directory } = await fixture(1);
    const attempts = await Promise.allSettled([receipts.begin(request("a"), "incarnation-a"), receipts.begin(request("b"), "incarnation-a")]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await readdir(directory)).toHaveLength(1);
    expect(await receipts.begin(request("a"), "incarnation-a")).toMatchObject({ created: false, receipt: { state: "accepted" } });
    await expect(receipts.begin(request("c", "incarnation-b"), "incarnation-b")).rejects.toThrow("sidecar_management_receipt_capacity_exceeded");
  });
  it.each(["completed", "failed"] as const)("reclaims %s receipts only from retired service incarnations", async (state) => {
    const { receipts } = await fixture(1);
    await receipts.begin(request("a"), "incarnation-a");
    await receipts.finish("a", state);
    await expect(receipts.begin(request("b"), "incarnation-a")).rejects.toThrow("sidecar_management_receipt_capacity_exceeded");
    expect(await receipts.begin(request("c", "incarnation-b"), "incarnation-b")).toMatchObject({ created: true });
    expect(await receipts.read("a")).toBeUndefined();
    expect(await receipts.read("c")).toMatchObject({ state: "accepted" });
  });
  it("preserves handoff evidence even after an incarnation changes", async () => {
    const { receipts } = await fixture(1);
    await receipts.begin(request("a"), "incarnation-a");
    await receipts.finish("a", "handoff_pending", "sidecar_resource_handoff_pending");
    await expect(receipts.begin(request("b", "incarnation-b"), "incarnation-b")).rejects.toThrow("sidecar_management_receipt_capacity_exceeded");
    expect(await receipts.read("a")).toMatchObject({ state: "handoff_pending" });
  });

  it("recovers capacity from old blocked probes without evicting partial failures", async () => {
    const { receipts } = await fixture(1);
    await receipts.begin(request("blocked"), "incarnation-a");
    await receipts.finish("blocked", "failed", "sidecar_service_upgrade_blocked");
    expect(await receipts.begin(request("stop"), "incarnation-a")).toMatchObject({ created: true });
    await receipts.finish("stop", "failed", "sidecar_service_cleanup_unproven");
    await expect(receipts.begin(request("retry"), "incarnation-a")).rejects.toThrow("sidecar_management_receipt_capacity_exceeded");
    expect(await receipts.read("stop")).toMatchObject({ state: "failed", code: "sidecar_service_cleanup_unproven" });
  });

  it("withdraws an unadmitted mutation id so a later admission of it is refused", async () => {
    const { receipts, directory } = await fixture(2);
    expect(await receipts.withdraw("late", "incarnation-a")).toMatchObject({ created: true, receipt: { mutationId: "late", state: "withdrawn", serviceIncarnation: "incarnation-a" } });
    await expect(receipts.begin(request("late"), "incarnation-a")).rejects.toThrow("sidecar_management_mutation_withdrawn");
    expect(await readdir(directory)).toHaveLength(1);
    expect(await receipts.read("late")).toMatchObject({ state: "withdrawn" });
    expect(await receipts.withdraw("late", "incarnation-a")).toMatchObject({ created: false, receipt: { state: "withdrawn" } });
  });
  it("returns an admission that raced ahead of the withdrawal unchanged", async () => {
    const { receipts } = await fixture(2);
    await receipts.begin(request("raced"), "incarnation-a");
    expect(await receipts.withdraw("raced", "incarnation-a")).toMatchObject({ created: false, receipt: { state: "accepted" } });
    await receipts.finish("raced", "completed");
    expect(await receipts.withdraw("raced", "incarnation-a")).toMatchObject({ created: false, receipt: { state: "completed" } });
    expect(await receipts.begin(request("raced"), "incarnation-a")).toMatchObject({ created: false, receipt: { state: "completed" } });
  });
  it("serializes a withdrawal behind an in-flight admission of the same id", async () => {
    const { receipts } = await fixture(2);
    const [admission, withdrawal] = await Promise.all([receipts.begin(request("same"), "incarnation-a"), receipts.withdraw("same", "incarnation-a")]);
    expect(admission).toMatchObject({ created: true, receipt: { state: "accepted" } });
    expect(withdrawal).toMatchObject({ created: false, receipt: { state: "accepted" } });
  });
  it("reclaims withdrawn receipts only from retired service incarnations", async () => {
    const { receipts } = await fixture(1);
    await receipts.withdraw("a", "incarnation-a");
    await expect(receipts.begin(request("b"), "incarnation-a")).rejects.toThrow("sidecar_management_receipt_capacity_exceeded");
    expect(await receipts.begin(request("c", "incarnation-b"), "incarnation-b")).toMatchObject({ created: true });
    expect(await receipts.read("a")).toBeUndefined();
  });

  it("never publishes a receipt whose contents were not written", async () => {
    const { receipts, directory } = await fixture(2);
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const privacy = vi.spyOn(windowsSidecarPlatform, "privacy").mockImplementation(async (filename, operation) => {
      if (operation === "ensure-directory") await mkdir(filename);
      if (operation === "secure-file") throw new Error("sidecar_windows_privacy_invalid");
    });
    await expect(receipts.begin(request("a"), "incarnation-a")).rejects.toThrow("sidecar_windows_privacy_invalid");
    expect(await readdir(directory)).toEqual([]);
    expect(await receipts.read("a")).toBeUndefined();
    privacy.mockImplementation(async () => undefined);
    expect(await receipts.withdraw("a", "incarnation-a")).toMatchObject({ created: true, receipt: { state: "withdrawn" } });
  });

  it.skipIf(process.platform === "win32")("reclaims around a torn receipt and refuses its id deterministically", async () => {
    const { receipts, directory } = await fixture(2);
    await receipts.withdraw("old", "incarnation-a");
    await writeFile(receiptPath(directory, "torn"), "", { mode: 0o600 });
    await chmod(receiptPath(directory, "torn"), 0o600);

    expect(await receipts.withdraw("new", "incarnation-b")).toMatchObject({ created: true, receipt: { state: "withdrawn" } });
    expect(await receipts.read("old")).toBeUndefined();
    await expect(receipts.read("torn")).rejects.toThrow("sidecar_management_receipt_invalid");
    await expect(receipts.withdraw("torn", "incarnation-b")).rejects.toThrow("sidecar_management_receipt_invalid");
    await expect(receipts.begin(request("torn", "incarnation-b"), "incarnation-b")).rejects.toThrow("sidecar_management_receipt_invalid");
  });

  it("does not count leftover temporaries toward capacity and removes stale ones", async () => {
    const { receipts, directory } = await fixture(1);
    await receipts.withdraw("old", "incarnation-a");
    const stale = `${receiptPath(directory, "crashed")}.10000000-0000-4000-8000-000000000001`;
    const fresh = `${receiptPath(directory, "writing")}.10000000-0000-4000-8000-000000000002`;
    await writeFile(stale, "{", { mode: 0o600 });
    await writeFile(fresh, "{", { mode: 0o600 });
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(stale, past, past);

    expect(await receipts.begin(request("current", "incarnation-b"), "incarnation-b")).toMatchObject({ created: true });
    expect((await readdir(directory)).sort()).toEqual([path.basename(fresh), path.basename(receiptPath(directory, "current"))].sort());
  });

});
