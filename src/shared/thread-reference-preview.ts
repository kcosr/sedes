import { readThreadReferenceBody, splitThreadReferenceText, threadReferenceDisplayText } from "./thread-references.js";

/** Short readable text for authored drafts, queued input and first-input recovery. */
export function threadReferencePreview(value: string, format: "authored" | "legacy" = "authored"): string {
  if (format === "authored") {
    const { parts, legacyReferences } = readThreadReferenceBody(value);
    return label(threadReferenceDisplayText(parts), legacyReferences);
  }
  const { text, references } = splitThreadReferenceText(value);
  return label(text, references);
}

function label(text: string, references: readonly { title: string }[]): string {
  const first = references[0];
  const trimmed = text.trim();
  if (trimmed || !first) return trimmed;
  const additional = references.length - 1;
  return `Referenced thread: ${first.title}${additional ? ` · +${additional}` : ""}`;
}
