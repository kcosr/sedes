// @vitest-environment jsdom

import { setEndpointProfile } from "../authentication/auth-transport.js";
import { configuredSedesServer } from "./server-endpoint.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ value: true, platform: "android" }));
const plugin = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  cancelDownload: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => native.value,
    getPlatform: () => native.platform,
  },
  registerPlugin: () => plugin,
}));

import {
  downloadWorkspaceFileInPackagedClient,
  supportsPackagedWorkspaceFileDownloads,
} from "./packaged-workspace-file-download.js";

const request = {
  serverOrigin: "https://sedes.example",
  url: "https://sedes.example/api/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/files/download?rootId=r&path=report.bin&expectedRevision=v1",
  suggestedFileName: "report.bin",
  expectedContentDisposition: 'attachment; filename="report.bin"',
  expectedContentLength: 42,
  expectedRevision: "v1",
};

beforeEach(() => {
  setEndpointProfile(configuredSedesServer(request.serverOrigin), "test-profile");
  native.value = true;
  native.platform = "android";
  plugin.downloadFile.mockReset();
  plugin.cancelDownload.mockReset();
});

describe("packaged workspace file downloads", () => {
  it("is available only in the packaged Android and Electron clients", () => {
    expect(supportsPackagedWorkspaceFileDownloads()).toBe(true);
    native.platform = "electron";
    expect(supportsPackagedWorkspaceFileDownloads()).toBe(true);
    native.platform = "ios";
    expect(supportsPackagedWorkspaceFileDownloads()).toBe(false);
    native.platform = "android";
    native.value = false;
    expect(supportsPackagedWorkspaceFileDownloads()).toBe(false);
  });

  it("passes only preflight metadata to the native streaming implementation", async () => {
    plugin.downloadFile.mockResolvedValue({ action: "saved" });

    await expect(
      downloadWorkspaceFileInPackagedClient(request),
    ).resolves.toBe("saved");
    expect(plugin.downloadFile).toHaveBeenCalledWith({
      transferId: expect.any(String),
      ...request,
      profileId: "test-profile",
    });
    expect(plugin.cancelDownload).not.toHaveBeenCalled();
  });

  it("does no work outside packaged clients and forwards cancellation", async () => {
    native.value = false;
    await expect(
      downloadWorkspaceFileInPackagedClient(request),
    ).resolves.toBe("cancelled");
    expect(plugin.downloadFile).not.toHaveBeenCalled();

    native.value = true;
    const controller = new AbortController();
    plugin.downloadFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          controller.signal.addEventListener("abort", () =>
            resolve({ action: "cancelled" }),
          );
        }),
    );
    plugin.cancelDownload.mockResolvedValue(undefined);
    const pending = downloadWorkspaceFileInPackagedClient({
      ...request,
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(plugin.cancelDownload).toHaveBeenCalledWith({
      transferId: expect.any(String),
    });
  });

  it("rejects an already-cancelled request before opening the picker", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before start"));
    await expect(
      downloadWorkspaceFileInPackagedClient({
        ...request,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled before start");
    expect(plugin.downloadFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      "download_revision_mismatch",
      "The file changed before it could be downloaded. Refresh and try again.",
    ],
    [
      "download_content_length_mismatch",
      "The downloaded file did not match the expected size. Refresh and try again.",
    ],
    [
      "download_content_type_invalid",
      "The server returned invalid file download metadata.",
    ],
    [
      "download_http_status_invalid",
      "The file is no longer available to download.",
    ],
    [
      "workspace_file_download_destination_unavailable",
      "The selected download destination is unavailable.",
    ],
  ])(
    "maps recognized native failure %s to an actionable message",
    async (code, message) => {
      plugin.downloadFile.mockRejectedValue({ code, message: "native detail" });
      await expect(
        downloadWorkspaceFileInPackagedClient(request),
      ).rejects.toThrow(message);
    },
  );

  it("preserves unrecognized native failures", async () => {
    const failure = new Error("network unavailable");
    plugin.downloadFile.mockRejectedValue(failure);
    await expect(
      downloadWorkspaceFileInPackagedClient(request),
    ).rejects.toBe(failure);
  });
});
