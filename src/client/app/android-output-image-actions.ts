import { registerPlugin } from "@capacitor/core";
import {
  MAXIMUM_OUTPUT_IMAGE_BYTES,
  type NormalizedImage,
} from "../../shared/index.js";
import { isAndroidClient } from "./client-platform.js";

type ArtifactImageReference = Extract<
  NormalizedImage,
  { readonly representation: "artifact" }
>;

type ImageActionSelection = "save" | "copy" | "cancelled";
type ImageActionCompletion = "saved" | "copied" | "cancelled";

interface OutputImageActionsPlugin {
  presentActions(): Promise<{ readonly action: ImageActionSelection }>;
  beginTransfer(input: NativeImageTransfer): Promise<void>;
  appendTransfer(input: {
    readonly transferId: string;
    readonly index: number;
    readonly data: string;
  }): Promise<void>;
  completeTransfer(input: { readonly transferId: string }): Promise<{
    readonly action: ImageActionCompletion;
  }>;
  abortTransfer(input: { readonly transferId: string }): Promise<void>;
}

interface NativeImageTransfer {
  readonly transferId: string;
  readonly action: Exclude<ImageActionSelection, "cancelled">;
  readonly mimeType: ArtifactImageReference["mimeType"];
  readonly byteSize: number;
  readonly sha256: string;
  readonly fileName: string;
}

const outputImageActions =
  registerPlugin<OutputImageActionsPlugin>("OutputImageActions");
const NATIVE_IMAGE_TRANSFER_CHUNK_BYTES = 192 * 1_024;

export function supportsAndroidOutputImageActions(): boolean {
  return isAndroidClient();
}

export async function presentAndroidOutputImageActions(input: {
  readonly artifact: ArtifactImageReference;
  readonly content: Blob;
}): Promise<ImageActionCompletion> {
  if (!supportsAndroidOutputImageActions()) return "cancelled";
  if (
    input.content.size !== input.artifact.byteSize ||
    input.content.size > MAXIMUM_OUTPUT_IMAGE_BYTES ||
    input.content.type !== input.artifact.mimeType
  ) {
    throw new Error("output_image_action_content_mismatch");
  }

  const selection = await outputImageActions.presentActions();
  if (selection.action === "cancelled") return "cancelled";
  const transferId = crypto.randomUUID();
  const payload: NativeImageTransfer = {
    transferId,
    action: selection.action,
    mimeType: input.artifact.mimeType,
    byteSize: input.artifact.byteSize,
    sha256: input.artifact.sha256,
    fileName:
      input.artifact.fileName?.text ??
      `generated-image${extensionForMimeType(input.artifact.mimeType)}`,
  };
  let began = false;
  try {
    await outputImageActions.beginTransfer(payload);
    began = true;
    let index = 0;
    for (
      let offset = 0;
      offset < input.content.size;
      offset += NATIVE_IMAGE_TRANSFER_CHUNK_BYTES
    ) {
      const bytes = new Uint8Array(
        await input.content
          .slice(offset, offset + NATIVE_IMAGE_TRANSFER_CHUNK_BYTES)
          .arrayBuffer(),
      );
      await outputImageActions.appendTransfer({
        transferId,
        index,
        data: bytesToBase64(bytes),
      });
      index += 1;
    }
    const result = await outputImageActions.completeTransfer({ transferId });
    began = false;
    return result.action;
  } finally {
    if (began) {
      await outputImageActions
        .abortTransfer({ transferId })
        .catch(() => undefined);
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32 * 1_024) {
    let part = "";
    for (const byte of bytes.subarray(offset, offset + 32 * 1_024)) {
      part += String.fromCharCode(byte);
    }
    parts.push(part);
  }
  try {
    return btoa(parts.join(""));
  } catch {
    throw new Error("output_image_action_encode_failed");
  }
}

function extensionForMimeType(
  mimeType: ArtifactImageReference["mimeType"],
): string {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
  }
}
