import { PAGE_DOWNLOAD_MAX_BYTES } from "../../shared/page-download.js";
import { PAGE_DOCUMENT_MAX_BYTES, PAGE_ESCAPED_MAX_BYTES } from "../../shared/protocol/pages.js";
import type { CapturedPageDocument } from "./html-policy.js";

/** Export immutable captured authored HTML, without the rendering wrapper or
 * Sedes runtime. The UTF-8 signature takes precedence over authored charset
 * declarations when the saved file is reopened without HTTP headers. */
export function downloadPageDocument(document: CapturedPageDocument & { readonly page: { readonly byteSize: number } }): Buffer {
  if (Buffer.byteLength(document.escapedHtml, "utf8") > PAGE_ESCAPED_MAX_BYTES) {
    throw new Error("page_download_document_too_large");
  }
  const authoredHtml: unknown = JSON.parse(`"${document.escapedHtml}"`);
  if (typeof authoredHtml !== "string") throw new Error("page_download_document_invalid");
  const bytes = Buffer.from(`\uFEFF${authoredHtml}`, "utf8");
  if (document.page.byteSize > PAGE_DOCUMENT_MAX_BYTES || bytes.byteLength > PAGE_DOWNLOAD_MAX_BYTES ||
      bytes.byteLength !== document.page.byteSize + 3) {
    throw new Error("page_download_document_size_invalid");
  }
  return bytes;
}
