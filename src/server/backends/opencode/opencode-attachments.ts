import { createHash } from "node:crypto";
import { composerAttachmentArraySchema, type ComposerAttachmentDescriptor } from "../../../shared/protocol/composer-attachments.js";
import { inspectSupportedRasterImage } from "../../images/raster-image-inspector.js";
import { stagedComposerAttachmentSchema, type CanonicalComposerAttachmentEvidence, type SteerTurnInput, type SubmitTurnInput } from "../contracts.js";
import { inspectStagedAttachmentManifest, stagedAttachmentManifest } from "../staged-attachment-manifest.js";
import { openCodeConversationError } from "./opencode-conversation-context.js";
import type { OpenCodeNativePromptInput } from "./opencode-native-mutations.js";

/** Path-free operation identity comes from the authenticated attachment owner. */
export function openCodeAttachmentEvidence(input: SubmitTurnInput | SteerTurnInput): readonly CanonicalComposerAttachmentEvidence[] {
  if (!input.attachments.length) return [];
  try {
    const attachments = input.attachments.map(item => stagedComposerAttachmentSchema.parse(item));
    composerAttachmentArraySchema.parse(attachments.map(({ agentPath: _path, sha256: _digest, ...item }) => item));
    if (!input.attachmentEvidence) throw new Error();
    const facts = input.attachmentEvidence.resolve();
    if (facts.length !== attachments.length) throw new Error();
    return attachments.map((attachment, index) => {
      const { agentPath: _path, ...fact } = attachment;
      const canonical = facts[index]!;
      if (Object.keys(fact).some(key => fact[key as keyof typeof fact] !== canonical[key as keyof typeof canonical]) ||
          Object.keys(canonical).length !== Object.keys(fact).length) throw new Error();
      return fact;
    });
  } catch { throw unavailable(); }
}

export async function prepareOpenCodeAttachments(input: SubmitTurnInput | SteerTurnInput,
  options: { readonly key: Uint8Array; readonly operationId: string; readonly text: string;
    readonly acceptsImages: boolean; readonly signal?: AbortSignal }): Promise<{ text: string; files?: OpenCodeNativePromptInput["files"] }> {
  if (!input.attachments.length) return { text: options.text };
  const facts = openCodeAttachmentEvidence(input);
  const files: NonNullable<OpenCodeNativePromptInput["files"]>[number][] = [];
  try {
    for (const [index, attachment] of input.attachments.entries()) {
      options.signal?.throwIfAborted();
      if (attachment.kind !== "image") continue;
      if (!options.acceptsImages || !input.attachmentBytes) throw new Error();
      const bytes = await input.attachmentBytes.read(attachment, options.signal);
      const fact = facts[index]!;
      if (bytes.byteLength !== fact.byteSize || createHash("sha256").update(bytes).digest("hex") !== fact.sha256 ||
          inspectSupportedRasterImage(bytes)?.mediaType !== fact.mediaType) throw new Error();
      files.push({ uri: `data:${fact.mediaType};base64,${bytes.toString("base64")}`, name: fact.fileName });
    }
    options.signal?.throwIfAborted();
    const manifest = stagedAttachmentManifest({ key: options.key, correlation: options.operationId, attachments: input.attachments });
    return { text: `${manifest}\n${options.text}`, ...(files.length ? { files } : {}) };
  } catch { options.signal?.throwIfAborted(); throw unavailable(); }
}

/** Invalid/native-only carriers never expose private staging paths to browsers. */
export function inspectOpenCodeAttachmentEnvelope(text: string, key: Uint8Array | undefined, operationId: string | undefined): {
  text: string; attachments?: readonly ComposerAttachmentDescriptor[];
} {
  if (!text.startsWith("<sedes-staged-attachments")) return { text };
  const lines = text.split("\n"), prompt = lines.slice(4).join("\n");
  if (!key || !operationId) return { text: prompt };
  const result = inspectStagedAttachmentManifest(lines.slice(0, 4).join("\n"), { key, correlation: operationId });
  return result.type === "authenticated" ? { text: prompt, attachments: result.attachments } : { text: prompt };
}
function unavailable() { return openCodeConversationError("opencode_attachments_unavailable",
  "The OpenCode attachments are unavailable or incompatible with the selected model.", "invalid_state"); }
