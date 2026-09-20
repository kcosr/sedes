import type { ComposerAttachmentDescriptor } from "../../../shared/protocol/composer-attachments.js";
import type { StagedComposerAttachment } from "../contracts.js";
import {
  inspectStagedAttachmentManifest,
  stagedAttachmentManifest,
} from "../staged-attachment-manifest.js";

export function claudeAttachmentEnvelope(input: {
  readonly key: Uint8Array;
  readonly operationId: string;
  readonly attachments: readonly StagedComposerAttachment[];
  readonly prompt: string;
}): string {
  if (input.attachments.length === 0) return input.prompt;
  return `${stagedAttachmentManifest({
    key: input.key,
    correlation: input.operationId,
    attachments: input.attachments,
  })}\n${input.prompt}`;
}

export function inspectClaudeAttachmentEnvelope(
  value: string,
  input: { readonly key: Uint8Array; readonly operationId: string },
):
  | { readonly type: "ordinary"; readonly prompt: string }
  | {
      readonly type: "authenticated";
      readonly prompt: string;
      readonly attachments: readonly ComposerAttachmentDescriptor[];
    }
  | { readonly type: "invalid"; readonly prompt: string } {
  if (!isClaudeAttachmentEnvelopeText(value)) {
    return { type: "ordinary", prompt: value };
  }
  const lines = value.split("\n");
  if (lines.length < 4) return { type: "invalid", prompt: "" };
  const carrier = lines.slice(0, 4).join("\n");
  const prompt = lines.slice(4).join("\n");
  const inspection = inspectStagedAttachmentManifest(
    carrier,
    {
      key: input.key,
      correlation: input.operationId,
    },
    { acceptLegacyHarness: true },
  );
  return inspection.type === "authenticated"
    ? { type: "authenticated", attachments: inspection.attachments, prompt }
    : { type: "invalid", prompt };
}

export function isClaudeAttachmentEnvelopeText(value: string): boolean {
  return (
    value.startsWith("<sedes-staged-attachments") ||
    value.startsWith("<harness-staged-attachments")
  );
}
