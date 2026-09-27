import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModelInfo } from "@opencode/client";
import type { RequestScope } from "../../identity/identity-provider.js";
import { inspectSupportedRasterImage } from "../../images/raster-image-inspector.js";
import { displayFileName } from "../../output-artifacts/display-file-name.js";
import { MAXIMUM_OUTPUT_IMAGE_BYTES, type OutputArtifactPublisher, type OutputImageArtifactDescriptor, type OutputImageMediaType } from "../../output-artifacts/contracts.js";
import type { OpenCodeNativeMessage } from "./opencode-native-api.js";
import { qualifiedOpenCodeModelId } from "./opencode-model-selection.js";

type Assistant = Extract<OpenCodeNativeMessage, { type: "assistant" }>;
type Tool = Extract<Assistant["content"][number], { type: "tool" }>;
const args = z.strictObject({ path: z.string().min(1).max(4_096).refine(value => !/[\x00-\x1f]/u.test(value)),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional() });
const raster = /\.(png|jpe?g|gif|webp)$/iu;
const types = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export interface OpenCodeViewedImage {
  readonly fileName?: ReturnType<typeof displayFileName>;
  readonly artifact?: OutputImageArtifactDescriptor;
}
export function openCodeViewedImageCoordinate(messageId: string, contentIndex: number): string { return `${messageId}:${contentIndex}`; }

/** Contract recognition only: stock does not attest whether a plugin replaced read. */
export function classifyOpenCodeRead(part: Tool): { kind: "ordinary" | "hold" } | {
  kind: "viewed"; path: string; uri?: string; mime?: string;
} {
  if (part.name !== "read") return { kind: "ordinary" };
  const parsed = args.safeParse(part.state.input);
  const terminal = part.state.status === "completed" || part.state.status === "error";
  if (!parsed.success) return { kind: terminal ? "ordinary" : "hold" };
  const content = part.state.status === "completed" ? part.state.content : undefined;
  const image = content?.length === 2 && content[0]?.type === "text" && content[0].text === "Image read successfully" &&
    content[1]?.type === "file" && types.has(content[1].mime) && content[1].name === parsed.data.path ? content[1] : undefined;
  if (image) return { kind: "viewed", path: parsed.data.path, uri: image.uri, mime: image.mime };
  if (raster.test(parsed.data.path)) return { kind: "viewed", path: parsed.data.path };
  return { kind: terminal ? "ordinary" : "hold" };
}

export function decodeOpenCodeRaster(uri: string, mime: string): { bytes: Buffer; mediaType: OutputImageMediaType; sha256: string } | undefined {
  if (!types.has(mime) || uri.length > Math.ceil(MAXIMUM_OUTPUT_IMAGE_BYTES / 3) * 4 + 128) return;
  const prefix = `data:${mime};base64,`;
  if (!uri.startsWith(prefix)) return;
  const encoded = uri.slice(prefix.length);
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAXIMUM_OUTPUT_IMAGE_BYTES || bytes.toString("base64") !== encoded ||
      inspectSupportedRasterImage(bytes)?.mediaType !== mime) return;
  return { bytes, mediaType: mime as OutputImageMediaType, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Qualify the stock final request's omission rules without fetching any file.
 * Opaque provider checkpoints and >25MiB context remain unavailable. Native
 * context hooks/model reconfiguration have no persisted media-lineage attestation.
 */
export async function materializeOpenCodeViewedImages(input: {
  readonly messages: readonly OpenCodeNativeMessage[]; readonly nativeNamespaceKey: string; readonly sessionID: string;
  readonly scope: RequestScope; readonly threadId: string; readonly publisher: OutputArtifactPublisher;
  readonly models: ReadonlyMap<string, ModelInfo>; readonly signal?: AbortSignal; readonly assertCurrent: () => Promise<void>;
}): Promise<ReadonlyMap<string, OpenCodeViewedImage>> {
  const result = new Map<string, OpenCodeViewedImage>();
  const pending: { coordinate: string; message: Assistant; part: Tool; index: number; image: Extract<ReturnType<typeof classifyOpenCodeRead>, { kind: "viewed" }> }[] = [];
  let imageBytes = 0, opaqueContext = false;
  const qualified = new Set<string>();
  const publicationKey = (message: Assistant, part: Tool, index: number) => `opencode-viewed:${createHash("sha256").update(JSON.stringify([
    input.nativeNamespaceKey, input.sessionID, message.id, part.id, index, 1])).digest("hex")}`;
  for (const message of input.messages) {
    input.signal?.throwIfAborted();
    if (message.type === "compaction" && message.status === "completed") {
      // A local summary discards prior media. Provider checkpoints can instead
      // embed canonical media under route provenance that HTTP does not expose.
      pending.length = 0; imageBytes = 0; opaqueContext = message.providerContext !== undefined;
    }
    if (message.type === "user") for (const file of message.files ?? []) {
      if (file.mime.toLowerCase().startsWith("image/")) imageBytes += Buffer.byteLength(file.data);
    }
    if (message.type !== "assistant") continue;
    const received = message.time.streamed !== undefined && (message.content.some(part => part.type === "tool" || part.text.length > 0) ||
      !message.error && message.finish !== undefined && message.finish !== "error");
    const vision = input.models.get(qualifiedOpenCodeModelId(message.model))?.capabilities.input.includes("image") === true;
    if (received && vision && !opaqueContext && imageBytes <= 25 * 1_024 * 1_024) {
      for (let index = pending.length - 1; index >= 0; index--) {
        const item = pending[index]!;
        if (item.part.time.completed !== undefined && item.part.time.completed <= message.time.created) {
          qualified.add(item.coordinate); pending.splice(index, 1);
        }
      }
    }
    for (const [index, part] of message.content.entries()) {
      if (part.type !== "tool") continue;
      if ("content" in part.state) for (const content of part.state.content ?? []) {
        if (content.type === "file" && content.mime.toLowerCase().startsWith("image/")) imageBytes += Buffer.byteLength(content.uri);
      }
      const image = classifyOpenCodeRead(part);
      if (image.kind !== "viewed") continue;
      const coordinate = openCodeViewedImageCoordinate(message.id, index);
      result.set(coordinate, { fileName: displayFileName(image.path) });
      if (image.uri && image.mime && part.state.status === "completed") {
        if (pending.length < 4_096) pending.push({ coordinate, message, part, index, image });
        else opaqueContext = true;
      }
      const retained = input.publisher.findImage(input.scope, input.threadId, publicationKey(message, part, index));
      if (retained) {
        const native = image.uri && image.mime ? decodeOpenCodeRaster(image.uri, image.mime) : undefined;
        // Retained association wins when source bytes disappear; conflicting
        // bytes at one stable coordinate cannot replace the original artifact.
        if (!image.uri || native && native.sha256 === retained.sha256 && native.mediaType === retained.mediaType && native.bytes.byteLength === retained.byteSize) {
          result.set(coordinate, { fileName: displayFileName(image.path), artifact: retained });
        }
      }
    }
  }
  // A qualified coordinate can precede later compaction. It remains published
  // evidence of that earlier provider request, independent of current context.
  for (const message of input.messages) {
    if (message.type !== "assistant") continue;
    for (const [index, part] of message.content.entries()) {
      if (part.type !== "tool") continue;
      const coordinate = openCodeViewedImageCoordinate(message.id, index);
      if (!qualified.has(coordinate) || result.get(coordinate)?.artifact) continue;
      const image = classifyOpenCodeRead(part);
      if (image.kind !== "viewed" || !image.uri || !image.mime) continue;
      const decoded = decodeOpenCodeRaster(image.uri, image.mime); if (!decoded) continue;
      input.signal?.throwIfAborted(); await input.assertCurrent(); input.signal?.throwIfAborted();
      try {
        const artifact = await input.publisher.publishImage({ scope: input.scope, threadId: input.threadId,
          publicationKey: publicationKey(message, part, index), bytes: decoded.bytes, mediaType: decoded.mediaType,
          expectedByteSize: decoded.bytes.byteLength, expectedSha256: decoded.sha256 });
        await input.assertCurrent(); input.signal?.throwIfAborted();
        result.set(coordinate, { fileName: displayFileName(image.path), artifact });
      } catch { input.signal?.throwIfAborted(); /* Keep a truthful unavailable viewed row. */ }
    }
  }
  return result;
}
