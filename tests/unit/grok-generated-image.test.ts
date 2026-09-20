import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectGrokGeneratedImageCandidate,
  readGrokGeneratedImage,
  removeGrokGeneratedImageMarkdownReferences,
} from "../../src/server/backends/grok/grok-generated-image.js";
import { MAXIMUM_OUTPUT_IMAGE_BYTES } from "../../src/server/output-artifacts/contracts.js";
import type { GrokMutableToolBlock } from "../../src/server/backends/grok/grok-tool-projector.js";

const roots: string[] = [];
const workspace = "/workspace/project";
const sessionId = "01a00c12-97d4-7630-9b44-270fd8ec9cdb";
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01,
  0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Grok generated image authority", () => {
  it.each(["ImageGen", "ImageEdit"])(
    "recognizes the exact completed local %s result",
    (type) => {
      const candidate = inspectGrokGeneratedImageCandidate(
        block({
          type,
          path: "/native/image.jpg",
          filename: "1.jpg",
          session_folder: "images",
        }),
        "prompt-1",
      );
      expect(candidate).toEqual({
        promptId: "prompt-1",
        toolCallId: "tool-1",
        path: "/native/image.jpg",
        fileName: "1.jpg",
      });
    },
  );

  it("rejects video, remote-only, and unreviewed additive output fields", () => {
    for (const rawOutput of [
      {
        type: "ImageToVideo",
        path: "/native/video.mp4",
        filename: "1.mp4",
        session_folder: "videos",
      },
      {
        type: "ImageEdit",
        path: "",
        filename: "",
        session_folder: "",
        uploaded_url: "https://files.example/image.jpg",
      },
      {
        type: "ImageGen",
        path: "/native/image.jpg",
        filename: "1.jpg",
        session_folder: "images",
        future_field: true,
      },
    ]) {
      expect(
        inspectGrokGeneratedImageCandidate(block(rawOutput), "prompt-1"),
      ).toBeUndefined();
    }
  });

  it("accepts only the reviewed null form of optional uploaded_url", () => {
    expect(
      inspectGrokGeneratedImageCandidate(
        block({
          type: "ImageEdit",
          path: "/native/image.jpg",
          filename: "1.jpg",
          session_folder: "images",
          uploaded_url: null,
        }),
        "prompt-1",
      ),
    ).toMatchObject({ path: "/native/image.jpg", fileName: "1.jpg" });
    expect(
      inspectGrokGeneratedImageCandidate(
        { ...block({}), status: "in_progress" },
        "prompt-1",
      ),
    ).toBeUndefined();
  });

  it("reads exact local session bytes without following a final symlink", async () => {
    const fixture = imageFixture();
    writeFileSync(fixture.imagePath, jpeg);
    expect(
      await readGrokGeneratedImage(fixture.candidate, fixture.authority),
    ).toMatchObject({
      type: "decoded",
      image: { mediaType: "image/jpeg", byteSize: jpeg.byteLength },
    });

    rmSync(fixture.imagePath);
    writeFileSync(fixture.outsidePath, jpeg);
    symlinkSync(fixture.outsidePath, fixture.imagePath);
    expect(
      await readGrokGeneratedImage(fixture.candidate, fixture.authority),
    ).toEqual({
      type: "unavailable",
      reason: "invalid_data",
    });
  });

  it("fails closed for wrong scope, missing, oversized, and non-JPEG bytes", async () => {
    const fixture = imageFixture();
    writeFileSync(fixture.imagePath, jpeg);
    expect(
      await readGrokGeneratedImage(
        { ...fixture.candidate, path: fixture.outsidePath },
        fixture.authority,
      ),
    ).toEqual({ type: "unavailable", reason: "invalid_data" });

    rmSync(fixture.imagePath);
    expect(
      await readGrokGeneratedImage(fixture.candidate, fixture.authority),
    ).toEqual({
      type: "unavailable",
      reason: "unavailable",
    });

    writeFileSync(fixture.imagePath, Buffer.from("not an image"));
    expect(
      await readGrokGeneratedImage(fixture.candidate, fixture.authority),
    ).toEqual({
      type: "unavailable",
      reason: "invalid_data",
    });

    truncateSync(fixture.imagePath, MAXIMUM_OUTPUT_IMAGE_BYTES + 1);
    expect(
      await readGrokGeneratedImage(fixture.candidate, fixture.authority),
    ).toEqual({
      type: "unavailable",
      reason: "byte_limit",
    });
  });

  it("removes only recognized provider-private image Markdown targets", () => {
    expect(
      removeGrokGeneratedImageMarkdownReferences(
        "Here it is:\n\n![Cat](images/1.jpg)\n\nDone.",
        new Set(["1.jpg"]),
      ),
    ).toBe("Here it is:\n\nDone.");
    expect(
      removeGrokGeneratedImageMarkdownReferences(
        "![Other](images/2.jpg)",
        new Set(["1.jpg"]),
      ),
    ).toBe("![Other](images/2.jpg)");
    expect(
      removeGrokGeneratedImageMarkdownReferences(
        "Here it is:\n\n![Cat](images/1.j",
        new Set(["1.jpg"]),
      ),
    ).toBe("Here it is:");
  });
});

function block(rawOutput: unknown): GrokMutableToolBlock {
  return {
    kind: "tool",
    backendItemId: "tool-item",
    sourceOrder: 0,
    toolCallId: "tool-1",
    status: "completed",
    rawOutput,
  };
}

function imageFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "sedes-grok-image-"));
  roots.push(root);
  const nativeHome = path.join(root, ".grok");
  const imageDirectory = path.join(
    nativeHome,
    "sessions",
    encodeURIComponent(workspace),
    sessionId,
    "images",
  );
  mkdirSync(imageDirectory, { recursive: true });
  const imagePath = path.join(imageDirectory, "1.jpg");
  return {
    imagePath,
    outsidePath: path.join(root, "outside.jpg"),
    candidate: {
      promptId: "prompt-1",
      toolCallId: "tool-1",
      path: imagePath,
      fileName: "1.jpg",
    },
    authority: { nativeHome, canonicalWorkspacePath: workspace, sessionId },
  } as const;
}
