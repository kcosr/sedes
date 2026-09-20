import { createHash, subtle } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { inspectSupportedRasterImage } from "../../images/raster-image-inspector.js";
import { MAXIMUM_OUTPUT_IMAGE_BYTES } from "../../output-artifacts/contracts.js";
import type { GrokMutableToolBlock } from "./grok-tool-projector.js";

const IMAGE_FILE_NAME = /^[1-9][0-9]*\.jpg$/u;

export interface GrokGeneratedImageCandidate {
  readonly promptId: string;
  readonly toolCallId: string;
  readonly path: string;
  readonly fileName: string;
}

export interface GrokGeneratedImageReadAuthority {
  readonly nativeHome: string;
  readonly canonicalWorkspacePath: string;
  readonly sessionId: string;
}

export type GrokGeneratedImageReadResult =
  | {
      readonly type: "decoded";
      readonly image: {
        readonly bytes: Buffer;
        readonly byteSize: number;
        readonly mediaType: "image/jpeg";
        readonly sha256: string;
      };
    }
  | {
      readonly type: "unavailable";
      readonly reason: "byte_limit" | "invalid_data" | "unavailable";
    };

/**
 * Recognizes the exact completed local Grok Build image result reviewed in the
 * owned-local 1.x source. ImageGen and ImageEdit share MediaGenOutput and the
 * same session image writer. The provider path remains private until the
 * scoped reader below has proved its session ownership and bytes.
 */
export function inspectGrokGeneratedImageCandidate(
  block: GrokMutableToolBlock,
  promptId: string | undefined,
): GrokGeneratedImageCandidate | undefined {
  if (promptId === undefined) return undefined;
  const output = inspectGrokGeneratedImageOutput(block);
  if (!output) return undefined;
  return Object.freeze({
    promptId,
    toolCallId: block.toolCallId,
    path: output.path,
    fileName: output.fileName,
  });
}

export function inspectGrokGeneratedImageOutput(
  block: GrokMutableToolBlock,
): { readonly path: string; readonly fileName: string } | undefined {
  if (block.status !== "completed") return undefined;
  return inspectCompletedGrokGeneratedImageOutput(block.rawOutput);
}

export function inspectCompletedGrokGeneratedImageOutput(
  output: unknown,
): { readonly path: string; readonly fileName: string } | undefined {
  if (!isPlainRecord(output)) return undefined;
  const keys = Object.keys(output);
  if (
    !keys.every((key) => LOCAL_IMAGE_OUTPUT_KEYS.has(key)) ||
    !LOCAL_IMAGE_OUTPUT_TYPES.has(output.type) ||
    output.session_folder !== "images" ||
    (Object.hasOwn(output, "uploaded_url") && output.uploaded_url !== null) ||
    typeof output.path !== "string" ||
    typeof output.filename !== "string" ||
    Buffer.byteLength(output.filename) > 255 ||
    Buffer.byteLength(output.path) > 8_192
  ) {
    return undefined;
  }
  return Object.freeze({
    path: output.path,
    fileName: output.filename,
  });
}

const LOCAL_IMAGE_OUTPUT_TYPES = new Set<unknown>(["ImageGen", "ImageEdit"]);
const LOCAL_IMAGE_OUTPUT_KEYS = new Set([
  "type",
  "path",
  "filename",
  "session_folder",
  // MediaGenOutput's one reviewed optional field. A non-null value denotes a
  // remote-only output and is intentionally unsupported by the local reader.
  "uploaded_url",
]);

export function grokGeneratedImagePublicationKey(
  candidate: Pick<GrokGeneratedImageCandidate, "promptId" | "toolCallId">,
): string {
  return `grok-image:v1:${createHash("sha256")
    .update(JSON.stringify([candidate.promptId, candidate.toolCallId]))
    .digest("base64url")}`;
}

/** Reads one exact provider-owned local session image without following it. */
export async function readGrokGeneratedImage(
  candidate: GrokGeneratedImageCandidate,
  authority: GrokGeneratedImageReadAuthority,
): Promise<GrokGeneratedImageReadResult> {
  if (
    !path.isAbsolute(authority.nativeHome) ||
    path.resolve(authority.nativeHome) !== authority.nativeHome ||
    !path.isAbsolute(authority.canonicalWorkspacePath) ||
    path.resolve(authority.canonicalWorkspacePath) !==
      authority.canonicalWorkspacePath ||
    !safeSegment(authority.sessionId) ||
    !IMAGE_FILE_NAME.test(candidate.fileName) ||
    path.basename(candidate.fileName) !== candidate.fileName
  ) {
    return { type: "unavailable", reason: "invalid_data" };
  }
  const relativeDirectory = path.join(
    "sessions",
    encodeURIComponent(authority.canonicalWorkspacePath),
    authority.sessionId,
    "images",
  );
  const expectedPath = path.join(
    authority.nativeHome,
    relativeDirectory,
    candidate.fileName,
  );
  if (
    !path.isAbsolute(candidate.path) ||
    path.resolve(candidate.path) !== candidate.path ||
    candidate.path !== expectedPath
  ) {
    return { type: "unavailable", reason: "invalid_data" };
  }

  try {
    const realNativeHome = await realpath(authority.nativeHome);
    const realImageDirectory = await realpath(path.dirname(candidate.path));
    if (realImageDirectory !== path.join(realNativeHome, relativeDirectory)) {
      return { type: "unavailable", reason: "invalid_data" };
    }
  } catch {
    return { type: "unavailable", reason: "unavailable" };
  }

  let descriptor;
  try {
    descriptor = await open(
      candidate.path,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    );
  } catch (error) {
    return {
      type: "unavailable",
      reason:
        (error as NodeJS.ErrnoException).code === "ELOOP"
          ? "invalid_data"
          : "unavailable",
    };
  }
  try {
    const before = await descriptor.stat();
    if (!before.isFile() || before.size <= 0) {
      return { type: "unavailable", reason: "invalid_data" };
    }
    if (before.size > MAXIMUM_OUTPUT_IMAGE_BYTES) {
      return { type: "unavailable", reason: "byte_limit" };
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await descriptor.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead <= 0) return { type: "unavailable", reason: "unavailable" };
      offset += bytesRead;
    }
    const after = await descriptor.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      return { type: "unavailable", reason: "unavailable" };
    }
    const inspection = inspectSupportedRasterImage(bytes);
    if (inspection?.mediaType !== "image/jpeg") {
      return { type: "unavailable", reason: "invalid_data" };
    }
    return {
      type: "decoded",
      image: {
        bytes,
        byteSize: bytes.byteLength,
        mediaType: "image/jpeg",
        sha256: Buffer.from(
          await subtle.digest("SHA-256", bytes as Buffer<ArrayBuffer>),
        ).toString("hex"),
      },
    };
  } catch {
    return { type: "unavailable", reason: "unavailable" };
  } finally {
    await descriptor.close();
  }
}

export function removeGrokGeneratedImageMarkdownReferences(
  markdown: string,
  fileNames: ReadonlySet<string>,
): string {
  let sanitized = markdown;
  for (const fileName of fileNames) {
    const target = escapeRegExp(`images/${fileName}`);
    sanitized = sanitized.replace(
      new RegExp(
        `!\\[[^\\]\\r\\n]*\\]\\(${target}(?:\\s+\"[^\"\\r\\n]*\")?\\)`,
        "gu",
      ),
      "",
    );
    const literalTarget = `images/${fileName}`;
    let imageStart = sanitized.indexOf("![");
    while (imageStart >= 0) {
      const destinationStart = sanitized.indexOf("](", imageStart + 2);
      if (destinationStart < 0) break;
      const lineEnd = sanitized.indexOf("\n", destinationStart + 2);
      const end = lineEnd < 0 ? sanitized.length : lineEnd;
      const partialDestination = sanitized.slice(destinationStart + 2, end);
      if (
        partialDestination.length > 0 &&
        (literalTarget.startsWith(partialDestination) ||
          partialDestination.startsWith(literalTarget))
      ) {
        sanitized = sanitized.slice(0, imageStart) + sanitized.slice(end);
        imageStart = sanitized.indexOf("![", imageStart);
      } else {
        imageStart = sanitized.indexOf("![", destinationStart + 2);
      }
    }
  }
  return sanitized.replace(/\n{3,}/gu, "\n\n").trim();
}

function safeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value) <= 1_024 &&
    value !== "." &&
    value !== ".." &&
    path.basename(value) === value &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
