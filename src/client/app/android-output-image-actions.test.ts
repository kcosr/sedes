// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ value: true, platform: "android" }));
const plugin = vi.hoisted(() => ({
  presentActions: vi.fn(),
  beginTransfer: vi.fn(),
  appendTransfer: vi.fn(),
  completeTransfer: vi.fn(),
  abortTransfer: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => native.value,
    getPlatform: () => native.platform,
  },
  registerPlugin: () => plugin,
}));

import {
  presentAndroidOutputImageActions,
  supportsAndroidOutputImageActions,
} from "./android-output-image-actions.js";

const artifact = {
  representation: "artifact" as const,
  artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  mimeType: "image/png" as const,
  byteSize: 8,
  sha256: "a".repeat(64),
  fileName: { text: "chart.png" },
};
const png = new Blob(
  [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  { type: "image/png" },
);

beforeEach(() => {
  native.value = true;
  native.platform = "android";
  plugin.presentActions.mockReset();
  plugin.beginTransfer.mockReset();
  plugin.appendTransfer.mockReset();
  plugin.completeTransfer.mockReset();
  plugin.abortTransfer.mockReset();
});

describe("Android output image actions", () => {
  it("is available only inside the packaged Android client", () => {
    expect(supportsAndroidOutputImageActions()).toBe(true);
    native.platform = "ios";
    expect(supportsAndroidOutputImageActions()).toBe(false);
    native.platform = "android";
    native.value = false;
    expect(supportsAndroidOutputImageActions()).toBe(false);
  });

  it("opens the menu before encoding and saves the exact verified payload", async () => {
    plugin.presentActions.mockResolvedValue({ action: "save" });
    plugin.beginTransfer.mockResolvedValue(undefined);
    plugin.appendTransfer.mockResolvedValue(undefined);
    plugin.completeTransfer.mockResolvedValue({ action: "saved" });

    await expect(
      presentAndroidOutputImageActions({ artifact, content: png }),
    ).resolves.toBe("saved");
    expect(plugin.presentActions).toHaveBeenCalledOnce();
    expect(plugin.beginTransfer).toHaveBeenCalledWith({
      transferId: expect.any(String),
      action: "save",
      mimeType: "image/png",
      byteSize: 8,
      sha256: "a".repeat(64),
      fileName: "chart.png",
    });
    const transferId = plugin.beginTransfer.mock.calls[0]?.[0].transferId;
    expect(plugin.appendTransfer).toHaveBeenCalledWith({
      transferId,
      index: 0,
      data: "iVBORw0KGgo=",
    });
    expect(plugin.completeTransfer).toHaveBeenCalledWith({ transferId });
    expect(plugin.abortTransfer).not.toHaveBeenCalled();
  });

  it("copies with a canonical fallback name and does no byte work when cancelled", async () => {
    plugin.presentActions.mockResolvedValueOnce({ action: "cancelled" });
    await expect(
      presentAndroidOutputImageActions({
        artifact: { ...artifact, fileName: undefined },
        content: png,
      }),
    ).resolves.toBe("cancelled");
    expect(plugin.beginTransfer).not.toHaveBeenCalled();

    plugin.presentActions.mockResolvedValueOnce({ action: "copy" });
    plugin.beginTransfer.mockResolvedValue(undefined);
    plugin.appendTransfer.mockResolvedValue(undefined);
    plugin.completeTransfer.mockResolvedValue({ action: "copied" });
    await expect(
      presentAndroidOutputImageActions({
        artifact: { ...artifact, fileName: undefined },
        content: png,
      }),
    ).resolves.toBe("copied");
    expect(plugin.beginTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "copy",
        fileName: "generated-image.png",
      }),
    );
  });

  it("streams large images in bounded ordered chunks and aborts failed transfers", async () => {
    const large = new Blob([new Uint8Array(192 * 1_024 + 3)], {
      type: "image/png",
    });
    plugin.presentActions.mockResolvedValue({ action: "copy" });
    plugin.beginTransfer.mockResolvedValue(undefined);
    plugin.appendTransfer
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("native unavailable"));
    plugin.abortTransfer.mockResolvedValue(undefined);

    await expect(
      presentAndroidOutputImageActions({
        artifact: { ...artifact, byteSize: large.size },
        content: large,
      }),
    ).rejects.toThrow("native unavailable");
    expect(plugin.appendTransfer).toHaveBeenCalledTimes(2);
    expect(plugin.appendTransfer.mock.calls[0]?.[0]).toMatchObject({
      index: 0,
      data: expect.stringMatching(/^[A-Za-z0-9+/]+$/u),
    });
    expect(plugin.appendTransfer.mock.calls[0]?.[0].data).toHaveLength(
      256 * 1_024,
    );
    expect(plugin.appendTransfer.mock.calls[1]?.[0]).toMatchObject({
      index: 1,
      data: "AAAA",
    });
    expect(plugin.abortTransfer).toHaveBeenCalledWith({
      transferId: expect.any(String),
    });
    expect(plugin.completeTransfer).not.toHaveBeenCalled();
  });

  it("rejects content that no longer matches the normalized descriptor", async () => {
    await expect(
      presentAndroidOutputImageActions({
        artifact: { ...artifact, byteSize: 9 },
        content: png,
      }),
    ).rejects.toThrow("output_image_action_content_mismatch");
    expect(plugin.presentActions).not.toHaveBeenCalled();
  });
});
