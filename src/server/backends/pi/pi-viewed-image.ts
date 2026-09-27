import { createHash } from "node:crypto";
import type {
  BackendConversationSnapshot,
  BackendItem,
} from "../../../shared/protocol/backend.js";
import type {
  BoundedDisplayText,
  SafeItemError,
} from "../../../shared/protocol/payload.js";
import { inspectSupportedRasterImage } from "../../images/raster-image-inspector.js";
import {
  MAXIMUM_OUTPUT_IMAGE_BYTES,
  OUTPUT_IMAGE_MEDIA_TYPES,
  type OutputImageArtifactDescriptor,
  type OutputImageMediaType,
} from "../../output-artifacts/contracts.js";
import { displayFileName } from "../../output-artifacts/display-file-name.js";
import type { PiToolIdentity } from "./pi-tool-identities.js";

/**
 * Pi's built-in `read` returns an image as an in-band result part. Sedes shows
 * such a read as a `viewed_image` row, followed by the exact bytes the model
 * received as a separate `image` child in the next reserved source order.
 */

const viewedImageExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
]);

/**
 * Pi's read tool appends this note when the selected model cannot see images;
 * the image part is then dropped from the request, so no child is shown.
 */
export const PI_NON_VISION_IMAGE_NOTE =
  "[Current model does not support images. The image will be omitted from this request.]";

/** Native errors can carry absolute paths, so Sedes writes its own text. */
export const PI_VIEWED_IMAGE_READ_FAILED: SafeItemError = {
  category: "unavailable",
  message: { text: "Pi could not read this image." },
  code: "pi_viewed_image_read_failed",
};

export interface PiViewedImageClassification {
  readonly fileName?: BoundedDisplayText;
}

/** Everything needed to add one child image to one projection generation. */
export interface PiViewedImageChildTarget {
  readonly backendItemId: string;
  readonly backendTurnId: string;
  readonly sourceOrder: number;
  readonly viewedItemId: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly fileName?: BoundedDisplayText;
}

/** A persisted image read whose child still needs its artifact. */
export interface PiViewedImageCandidate {
  readonly child: PiViewedImageChildTarget;
  readonly assistantEntryId: string;
  readonly toolCallId: string;
  /** Locator of the image part inside the persisted tool result. */
  readonly toolResultEntryId: string;
  readonly imageIndex: number;
}

export interface PiViewedImagePart {
  /** Index of the image part inside the tool result content. */
  readonly imageIndex: number;
  readonly mimeType: unknown;
  readonly data: unknown;
}

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function isPiBuiltinRead(identity: PiToolIdentity | undefined): boolean {
  return (
    identity?.origin === "pi_builtin" &&
    identity.canonicalKind === "read" &&
    identity.registrationId === "pi:builtin:read"
  );
}

/**
 * A trusted built-in read of a path with an image extension is a viewed
 * image; any other call keeps its ordinary tool presentation.
 */
export function classifyPiViewedImage(
  identity: PiToolIdentity | undefined,
  argumentsValue: unknown,
): PiViewedImageClassification | undefined {
  if (!isPiBuiltinRead(identity)) return undefined;
  const path = own(argumentsValue, "path");
  if (typeof path !== "string") return undefined;
  const extension = /\.([^./\\]+)$/u.exec(path)?.[1]?.toLowerCase();
  if (!extension || !viewedImageExtensions.has(extension)) return undefined;
  const fileName = displayFileName(path);
  return fileName ? { fileName } : {};
}

/**
 * The first image part of a read result, unless Pi noted that the current
 * model will not receive it.
 */
export function piViewedImageResultPart(
  result: unknown,
): PiViewedImagePart | undefined {
  const content = own(result, "content");
  if (!Array.isArray(content)) return undefined;
  let image: PiViewedImagePart | undefined;
  for (let index = 0; index < content.length; index += 1) {
    const part = own(content, String(index));
    const type = own(part, "type");
    const text = own(part, "text");
    if (
      type === "text" &&
      typeof text === "string" &&
      text.includes(PI_NON_VISION_IMAGE_NOTE)
    ) {
      return undefined;
    }
    if (type === "image" && image === undefined) {
      image = {
        imageIndex: index,
        mimeType: own(part, "mimeType"),
        data: own(part, "data"),
      };
    }
  }
  return image;
}

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/u;
const maximumBase64Length = Math.ceil(MAXIMUM_OUTPUT_IMAGE_BYTES / 3) * 4;

/** Strictly decodes an in-band image; anything unexpected yields no child. */
export function decodePiViewedImage(
  part: PiViewedImagePart,
): { readonly mediaType: OutputImageMediaType; readonly bytes: Uint8Array } | undefined {
  const mediaType = part.mimeType;
  const data = part.data;
  if (
    typeof mediaType !== "string" ||
    !(OUTPUT_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType) ||
    typeof data !== "string" ||
    data.length === 0 ||
    data.length % 4 !== 0 ||
    data.length > maximumBase64Length ||
    !base64Pattern.test(data)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAXIMUM_OUTPUT_IMAGE_BYTES ||
    inspectSupportedRasterImage(bytes)?.mediaType !== mediaType
  ) {
    return undefined;
  }
  return { mediaType: mediaType as OutputImageMediaType, bytes };
}

/**
 * Stable across live observation, history, pagination and reattachment. The
 * tool result entry ID is not known live, so it is not part of the key.
 */
export function piViewedImagePublicationKey(input: {
  readonly sessionId: string;
  readonly assistantEntryId: string;
  readonly toolCallId: string;
  readonly imageIndex: number;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.sessionId,
        input.assistantEntryId,
        input.toolCallId,
        input.imageIndex,
      ]),
    )
    .digest("hex");
  return `pi-viewed-image:${digest}`;
}

export function piViewedImageItem(input: {
  readonly backendItemId: string;
  readonly backendTurnId: string;
  readonly sourceOrder: number;
  readonly status: BackendItem["status"];
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly fileName?: BoundedDisplayText;
  readonly error?: SafeItemError;
}): BackendItem {
  return {
    backendItemId: input.backendItemId,
    backendTurnId: input.backendTurnId,
    semanticKind: "viewed_image",
    status: input.status,
    sourceOrder: input.sourceOrder,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.fileName ? { fileName: input.fileName } : {}),
  };
}

export function piViewedImageChildItem(
  target: PiViewedImageChildTarget,
  descriptor: OutputImageArtifactDescriptor,
): BackendItem {
  return {
    backendItemId: target.backendItemId,
    backendTurnId: target.backendTurnId,
    semanticKind: "image",
    status: "completed",
    sourceOrder: target.sourceOrder,
    ...(target.startedAt ? { startedAt: target.startedAt } : {}),
    ...(target.completedAt ? { completedAt: target.completedAt } : {}),
    origin: { kind: "viewed", capture: "provider_input" },
    image: {
      representation: "artifact",
      artifactId: descriptor.artifactId,
      mimeType: descriptor.mediaType,
      byteSize: descriptor.byteSize,
      sha256: descriptor.sha256,
      ...(target.fileName ? { fileName: target.fileName } : {}),
    },
  };
}

/**
 * Adds each already-published child directly after its viewed item and
 * returns the candidates that still lack an artifact. Only candidates in
 * `turnIds` are looked up.
 */
export function fillPiViewedImageChildren(
  snapshot: BackendConversationSnapshot,
  candidates: readonly PiViewedImageCandidate[],
  turnIds: ReadonlySet<string>,
  find: (candidate: PiViewedImageCandidate) => OutputImageArtifactDescriptor | undefined,
): {
  readonly snapshot: BackendConversationSnapshot;
  readonly missing: readonly PiViewedImageCandidate[];
} {
  const missing: PiViewedImageCandidate[] = [];
  let itemsById: BackendConversationSnapshot["itemsById"] | undefined;
  let turnsById: BackendConversationSnapshot["turnsById"] | undefined;
  for (const candidate of candidates) {
    const { child } = candidate;
    const turn = (turnsById ?? snapshot.turnsById)[child.backendTurnId];
    if (
      !turnIds.has(child.backendTurnId) ||
      !turn ||
      snapshot.itemsById[child.viewedItemId] === undefined ||
      (itemsById ?? snapshot.itemsById)[child.backendItemId] !== undefined
    ) {
      continue;
    }
    let descriptor: OutputImageArtifactDescriptor | undefined;
    try {
      descriptor = find(candidate);
    } catch {
      descriptor = undefined;
    }
    if (!descriptor) {
      missing.push(candidate);
      continue;
    }
    itemsById ??= { ...snapshot.itemsById };
    turnsById ??= { ...snapshot.turnsById };
    itemsById[child.backendItemId] = piViewedImageChildItem(child, descriptor);
    const ordered = [...turn.orderedBackendItemIds];
    const viewedIndex = ordered.indexOf(child.viewedItemId);
    ordered.splice(
      viewedIndex < 0 ? ordered.length : viewedIndex + 1,
      0,
      child.backendItemId,
    );
    turnsById[child.backendTurnId] = {
      ...turn,
      orderedBackendItemIds: ordered,
    };
  }
  return {
    snapshot:
      itemsById && turnsById ? { ...snapshot, itemsById, turnsById } : snapshot,
    missing,
  };
}
