import { PAGE_DOCUMENT_MAX_BYTES } from "./protocol/pages.js";

/** Exported HTML starts with a three-byte UTF-8 signature. */
export const PAGE_DOWNLOAD_MAX_BYTES = PAGE_DOCUMENT_MAX_BYTES + 3;

/** A 180-byte basename keeps both filename disposition parameters together
 * below the packaged clients' 1,024-character metadata limit, including the
 * worst-case expansion of UTF-8 percent encoding. */
const MAX_FILENAME_BYTES = 180;
// Android preserves at most 128 code points when preparing its save dialog.
const MAX_FILENAME_CODE_POINTS = 128;

export function pageDownloadFileName(title: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("page_download_revision_invalid");
  }
  const suffix = `-r${revision}.html`;
  let normalized = title.normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "-")
    .replace(/^[.\s]+|[.\s]+$/gu, "");
  // Windows device names remain reserved even when followed by an extension.
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(normalized)) {
    normalized = `page-${normalized}`;
  }
  const encoder = new TextEncoder();
  let basename = "";
  let bytes = encoder.encode(suffix).byteLength;
  let codePoints = suffix.length;
  for (const character of normalized) {
    // Titles may be accepted from JSON with isolated UTF-16 surrogates.
    const safeCharacter = /^[\uD800-\uDFFF]$/u.test(character) ? "-" : character;
    const size = encoder.encode(safeCharacter).byteLength;
    if (bytes + size > MAX_FILENAME_BYTES || codePoints >= MAX_FILENAME_CODE_POINTS) break;
    basename += safeCharacter;
    bytes += size;
    codePoints += 1;
  }
  basename = basename.replace(/[.\s]+$/gu, "");
  return `${basename || "page"}${suffix}`;
}
