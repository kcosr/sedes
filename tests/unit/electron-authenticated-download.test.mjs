import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), dialog: vi.fn(), getCredential: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => ({ isDestroyed: () => false }) },
  dialog: { showSaveDialog: mocks.dialog }, net: { fetch: mocks.fetch },
}));
vi.mock("@sedes/electron-client-credentials/electron/dist/plugin.mjs", () => ({ nativeCredentialStore: () => ({ getCredential: mocks.getCredential }) }));
const { WorkspaceFileDownload } = await import("../../packages/electron-workspace-file-download/electron/dist/plugin.mjs");
const input = {
  profileId: "remote-1", transferId: "10000000-0000-4000-8000-000000000001", serverOrigin: "https://server.example",
  url: "https://server.example/api/workspaces/1/download", suggestedFileName: "test.txt",
  expectedContentDisposition: 'attachment; filename="test.txt"', expectedContentLength: 3, expectedRevision: "revision-1",
};
const directories = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
describe("native download authentication", () => {
  it("retrieves the exact profile/origin credential and disables redirects", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-download-")); directories.push(directory);
    const filename = path.join(directory, "test.txt");
    mocks.dialog.mockResolvedValue({ canceled: false, filePath: filename });
    mocks.getCredential.mockResolvedValue({ credential: "secret-device-token" });
    mocks.fetch.mockResolvedValue(new Response("abc", { headers: {
      "content-type": "application/octet-stream", "content-disposition": input.expectedContentDisposition,
      "content-length": "3", "x-sedes-workspace-file-revision": input.expectedRevision,
    } }));
    await expect(new WorkspaceFileDownload().downloadFile(input)).resolves.toEqual({ action: "saved" });
    expect(mocks.getCredential).toHaveBeenCalledWith({ profileId: "remote-1", serverUrl: input.serverOrigin });
    expect(mocks.fetch).toHaveBeenCalledWith(input.url, expect.objectContaining({ redirect: "error", headers: {
      Origin: "capacitor-electron://localhost", Authorization: "Bearer secret-device-token",
    } }));
    expect(await readFile(filename, "utf8")).toBe("abc");
  });
  it("does not retrieve or forward credentials for another origin", async () => {
    await expect(new WorkspaceFileDownload().downloadFile({ ...input, url: "https://other.example/api/download" })).rejects.toThrow("outside");
    expect(mocks.getCredential).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("honors server denial when a protected download has no saved credential", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-download-")); directories.push(directory);
    mocks.dialog.mockResolvedValue({ canceled: false, filePath: path.join(directory, "test.txt") });
    mocks.getCredential.mockResolvedValue({ credential: null });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(new WorkspaceFileDownload().downloadFile(input)).rejects.toThrow("server refused");
    expect(mocks.fetch).toHaveBeenCalledWith(input.url, expect.objectContaining({
      headers: { Origin: "capacitor-electron://localhost" }, redirect: "error",
    }));
  });
  for (const unavailable of [false, true]) it(`downloads from an auth-disabled server with ${unavailable ? "unreadable" : "missing"} credentials`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-download-")); directories.push(directory);
    const filename = path.join(directory, "test.txt");
    mocks.dialog.mockResolvedValue({ canceled: false, filePath: filename });
    if (unavailable) mocks.getCredential.mockRejectedValue(new Error("OS keyring unavailable"));
    else mocks.getCredential.mockResolvedValue({ credential: null });
    mocks.fetch.mockResolvedValue(new Response("abc", { headers: {
      "content-type": "application/octet-stream", "content-disposition": input.expectedContentDisposition,
      "content-length": "3", "x-sedes-workspace-file-revision": input.expectedRevision,
    } }));
    await expect(new WorkspaceFileDownload().downloadFile(input)).resolves.toEqual({ action: "saved" });
    expect(mocks.fetch).toHaveBeenCalledWith(input.url, expect.objectContaining({
      headers: { Origin: "capacitor-electron://localhost" }, redirect: "error",
    }));
    expect(await readFile(filename, "utf8")).toBe("abc");
  });
});
