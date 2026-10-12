import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { materializeToolModelContent } from "../../src/internal/agent-tool-cli-protocol/local-media-files.js";
import { maximumPreviewResult } from "../helpers/page-preview-media-fixture.js";

describe("CLI tool media files", () => {
  it("writes exact maximum PNG bytes, preserves text, and exposes explicit cleanup", async () => {
    const image = maximumPreviewResult().modelContent[0]!;
    const result = await materializeToolModelContent([{ type: "text", text: "Screenshot follows." }, image]);
    try {
      expect(result.content[0]).toEqual({ type: "text", text: "Screenshot follows." });
      const file = result.content[1]!;
      if (file.type !== "image") throw new Error("image expected");
      expect(file.byteSize).toBe(2 * 1024 * 1024);
      expect((await readFile(file.path)).equals(Buffer.from(image.data, "base64"))).toBe(true);
      expect(JSON.stringify(result.content).length).toBeLessThan(512);
      await result.cleanup();
      await expect(readFile(file.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await result.cleanup(); }
  });

  it("cancels before writing or returning any image path", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(materializeToolModelContent(maximumPreviewResult().modelContent, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
