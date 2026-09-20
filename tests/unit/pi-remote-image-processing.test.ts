import { describe, expect, it, vi } from "vitest";
import { processRemotePiImage } from "../../src/server/backends/pi/pi-remote-image-processing.js";

describe("remote Pi image processing", () => {
  it("passes only received bytes and media type to Pi's in-memory processor", async () => {
    const processor = vi.fn(async (bytes: Uint8Array, mimeType: string) => ({
      ok: true as const,
      data: Buffer.from(bytes).toString("base64"),
      mimeType: "image/png",
      hints: [`converted ${mimeType}`],
    }));
    await expect(
      processRemotePiImage(
        { contentBase64: "Qk0BAg==", mediaType: "image/bmp" },
        { autoResizeImages: true },
        processor,
      ),
    ).resolves.toEqual({
      ok: true,
      data: "Qk0BAg==",
      mimeType: "image/png",
      hints: ["converted image/bmp"],
    });
    expect(processor).toHaveBeenCalledWith(
      Buffer.from("Qk0BAg==", "base64"),
      "image/bmp",
      { autoResizeImages: true },
    );
  });

  it("propagates Pi's omission result without inventing an attachment", async () => {
    await expect(
      processRemotePiImage(
        { contentBase64: "AA==", mediaType: "image/bmp" },
        { autoResizeImages: true },
        async () => ({ ok: false, message: "omitted" }),
      ),
    ).resolves.toEqual({ ok: false, message: "omitted" });
  });

  it("passes the effective disabled auto-resize setting to Pi's byte processor", async () => {
    const processor = vi.fn(async () => ({
      ok: true as const,
      data: "AA==",
      mimeType: "image/png",
      hints: [],
    }));
    await processRemotePiImage(
      { contentBase64: "AA==", mediaType: "image/png" },
      { autoResizeImages: false },
      processor,
    );
    expect(processor).toHaveBeenCalledWith(
      Buffer.from("AA==", "base64"),
      "image/png",
      { autoResizeImages: false },
    );
  });
});
