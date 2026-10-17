import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), dialog: vi.fn(), getCredential: vi.fn(), openPath: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => ({ isDestroyed: () => false }) },
  dialog: { showSaveDialog: mocks.dialog }, net: { fetch: mocks.fetch }, shell: { openPath: mocks.openPath },
}));
vi.mock("@sedes/electron-client-credentials/electron/dist/plugin.mjs", () => ({ nativeCredentialStore: () => ({ getCredential: mocks.getCredential }) }));
const { WorkspaceFileDownload } = await import("../../packages/electron-workspace-file-download/electron/dist/plugin.mjs");
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const pageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const input = {
  profileId: "remote-1", transferId: "10000000-0000-4000-8000-000000000001", serverOrigin: "https://server.example",
  url: `https://server.example/api/workspaces/${workspaceId}/files/download?rootId=r&path=test.txt&expectedRevision=revision-1`,
  suggestedFileName: "test.txt", expectedContentDisposition: 'attachment; filename="test.txt"',
  expectedContentLength: 3, expectedRevision: "revision-1",
};
const pageBytes = Buffer.from('\uFEFF<!doctype html><meta charset="utf-8"><p>Saved page</p>', "utf8");
const pageInput = {
  ...input,
  url: `https://server.example/api/threads/${workspaceId}/pages/${pageId}/revisions/3/download`,
  suggestedFileName: "saved-page.html", expectedContentDisposition: 'attachment; filename="saved-page.html"',
  expectedContentLength: pageBytes.byteLength, expectedRevision: "a".repeat(64),
};
const directories = [];
async function destination(name = "test.txt") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-download-"));
  directories.push(directory);
  const filename = path.join(directory, name);
  mocks.dialog.mockResolvedValue({ canceled: false, filePath: filename });
  return { directory, filename };
}
function response(download = input, body = "abc", headers = {}, status = 200) {
  return new Response(body, { status, headers: {
    "content-type": "application/octet-stream", "content-disposition": download.expectedContentDisposition,
    "content-length": String(download.expectedContentLength), "x-sedes-download-revision": download.expectedRevision,
    ...headers,
  } });
}
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("native download authentication", () => {
  it.each([["workspace", input, "abc"], ["page revision", pageInput, pageBytes]])(
    "saves a %s using the exact profile/origin credential without opening it",
    async (_kind, download, bytes) => {
      const { filename } = await destination(download.suggestedFileName);
      mocks.getCredential.mockResolvedValue({ credential: "secret-device-token" });
      mocks.fetch.mockResolvedValue(response(download, bytes));
      await expect(new WorkspaceFileDownload().downloadFile(download)).resolves.toEqual({ action: "saved" });
      expect(mocks.getCredential).toHaveBeenCalledWith({ profileId: "remote-1", serverUrl: download.serverOrigin });
      expect(mocks.fetch).toHaveBeenCalledWith(download.url, expect.objectContaining({ redirect: "error", headers: {
        Origin: "capacitor-electron://localhost", Authorization: "Bearer secret-device-token",
        Accept: "application/octet-stream", "Accept-Encoding": "identity",
      } }));
      expect(await readFile(filename)).toEqual(Buffer.from(bytes));
      expect(mocks.openPath).not.toHaveBeenCalled();
    },
  );
  it("does not retrieve or forward credentials for another origin", async () => {
    await expect(new WorkspaceFileDownload().downloadFile({ ...pageInput, url: pageInput.url.replace("server.example", "other.example") })).rejects.toThrow("outside");
    expect(mocks.getCredential).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([input, pageInput])("honors server denial when a protected download has no saved credential ($suggestedFileName)", async (download) => {
    const { directory } = await destination(download.suggestedFileName);
    mocks.getCredential.mockResolvedValue({ credential: null });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(new WorkspaceFileDownload().downloadFile(download)).rejects.toThrow("server refused");
    expect(mocks.fetch).toHaveBeenCalledWith(download.url, expect.objectContaining({
      headers: { Origin: "capacitor-electron://localhost", Accept: "application/octet-stream", "Accept-Encoding": "identity" }, redirect: "error",
    }));
    expect(await readdir(directory)).toEqual([]);
  });
  for (const unavailable of [false, true]) it(`downloads from an auth-disabled server with ${unavailable ? "unreadable" : "missing"} credentials`, async () => {
    const { filename } = await destination();
    if (unavailable) mocks.getCredential.mockRejectedValue(new Error("OS keyring unavailable"));
    else mocks.getCredential.mockResolvedValue({ credential: null });
    mocks.fetch.mockResolvedValue(response());
    await expect(new WorkspaceFileDownload().downloadFile(input)).resolves.toEqual({ action: "saved" });
    expect(mocks.fetch).toHaveBeenCalledWith(input.url, expect.objectContaining({
      headers: { Origin: "capacitor-electron://localhost", Accept: "application/octet-stream", "Accept-Encoding": "identity" }, redirect: "error",
    }));
    expect(await readFile(filename, "utf8")).toBe("abc");
  });
});

describe("native download route authority", () => {
  it.each([
    "/api/auth/status", `/api/workspaces/${workspaceId}/files`,
    `/api/workspaces/${workspaceId}/files/../files/download`,
    `/api/workspaces/${workspaceId}/files/%2e%2e/files/download`,
    `/api/workspaces/${workspaceId}/files/download#fragment`,
    `/api/workspaces/${workspaceId}/files/download#`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/0/download`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/01/download`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/-1/download`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/1.5/download`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/9007199254740992/download`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/%33/download`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/3/render`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/3/../3/download`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/3/%2e%2e/3/download`,
    `/api/threads/invalid/pages/${pageId}/revisions/3/download`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/3/download?`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/3/download?path=secret`,
    `/api/threads/${workspaceId}/pages/${pageId}/revisions/3/download#`,
  ])("rejects unexpected download path %s before credentials or save dialog", async (suffix) => {
    await expect(new WorkspaceFileDownload().downloadFile({ ...pageInput, url: `${input.serverOrigin}${suffix}` }))
      .rejects.toMatchObject({ code: "workspace_file_download_input_invalid" });
    expect(mocks.dialog).not.toHaveBeenCalled();
    expect(mocks.getCredential).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("accepts the maximum safe page revision", async () => {
    mocks.dialog.mockResolvedValue({ canceled: true });
    await expect(new WorkspaceFileDownload().downloadFile({ ...pageInput, url: pageInput.url.replace("/3/", "/9007199254740991/") }))
      .resolves.toEqual({ action: "cancelled" });
  });
  it("bounds page downloads independently of workspace files", async () => {
    mocks.dialog.mockResolvedValue({ canceled: true });
    await expect(new WorkspaceFileDownload().downloadFile({ ...pageInput, expectedContentLength: 16 * 1024 * 1024 + 3 }))
      .resolves.toEqual({ action: "cancelled" });
    await expect(new WorkspaceFileDownload().downloadFile({ ...pageInput, expectedContentLength: 16 * 1024 * 1024 + 4 }))
      .rejects.toMatchObject({ code: "workspace_file_download_input_invalid" });
    await expect(new WorkspaceFileDownload().downloadFile({ ...input, expectedContentLength: 1024 * 1024 * 1024 }))
      .resolves.toEqual({ action: "cancelled" });
  });
});

describe("native download response validation and cleanup", () => {
  it.each([
    [{ "x-sedes-download-revision": "changed" }, "download_revision_mismatch"],
    [{ "content-length": "0" }, "download_content_length_mismatch"],
    [{ "content-length": "3e0" }, "download_content_length_mismatch"],
    [{ "content-disposition": "inline; filename=page.html" }, "download_content_disposition_mismatch"],
    [{ "content-type": "text/html" }, "download_content_disposition_mismatch"],
  ])("rejects changed metadata %j and preserves an existing destination", async (headers, code) => {
    const { directory, filename } = await destination();
    await writeFile(filename, "original");
    mocks.getCredential.mockResolvedValue({ credential: "secret" });
    mocks.fetch.mockResolvedValue(response(input, "abc", headers));
    await expect(new WorkspaceFileDownload().downloadFile(input)).rejects.toMatchObject({ code });
    expect(await readdir(directory)).toEqual(["test.txt"]);
    expect(await readFile(filename, "utf8")).toBe("original");
  });
  it("rejects the retired revision header", async () => {
    await destination();
    mocks.getCredential.mockResolvedValue({ credential: null });
    const retired = response();
    retired.headers.delete("x-sedes-download-revision");
    retired.headers.set("x-sedes-workspace-file-revision", input.expectedRevision);
    mocks.fetch.mockResolvedValue(retired);
    await expect(new WorkspaceFileDownload().downloadFile(input)).rejects.toMatchObject({ code: "download_revision_mismatch" });
  });
  it("rejects a missing content length even for an empty file", async () => {
    await destination();
    mocks.getCredential.mockResolvedValue({ credential: null });
    const missingLength = response(input, "");
    missingLength.headers.delete("content-length");
    mocks.fetch.mockResolvedValue(missingLength);
    await expect(new WorkspaceFileDownload().downloadFile({ ...input, expectedContentLength: 0 }))
      .rejects.toMatchObject({ code: "download_content_length_mismatch" });
  });
  it("rejects a redirect response without following its location", async () => {
    const { directory } = await destination();
    mocks.getCredential.mockResolvedValue({ credential: "secret" });
    mocks.fetch.mockResolvedValue(response(input, null, { Location: "https://attacker.invalid/credentials" }, 302));
    await expect(new WorkspaceFileDownload().downloadFile(input)).rejects.toMatchObject({ code: "download_http_status_invalid" });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledWith(input.url, expect.objectContaining({ redirect: "error" }));
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(["ab", "abcd"])("removes a partial download whose body has incorrect length (%s)", async (body) => {
    const { directory } = await destination();
    mocks.getCredential.mockResolvedValue({ credential: null });
    mocks.fetch.mockResolvedValue(response(input, body));
    await expect(new WorkspaceFileDownload().downloadFile(input)).rejects.toMatchObject({
      code: body.length < 3 ? "workspace_file_download_byte_size_mismatch" : "workspace_file_download_byte_size_exceeded",
    });
    expect(await readdir(directory)).toEqual([]);
  });
  it("cancels an active page transfer and removes its partial file", async () => {
    const { directory } = await destination(pageInput.suggestedFileName);
    mocks.getCredential.mockResolvedValue({ credential: null });
    let bodyCancelled = false;
    mocks.fetch.mockResolvedValue(response(pageInput, new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([0xef])); },
      cancel() { bodyCancelled = true; },
    })));
    const plugin = new WorkspaceFileDownload();
    const transfer = plugin.downloadFile(pageInput);
    const rejected = expect(transfer).rejects.toMatchObject({ code: "workspace_file_download_cancelled" });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    await plugin.cancelDownload({ transferId: pageInput.transferId });
    await rejected;
    expect(await readdir(directory)).toEqual([]);
    expect(bodyCancelled).toBe(true);
  });
});
