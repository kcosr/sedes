import { describe, expect, it } from "vitest";
import { parse } from "parse5";
import { PAGE_DOWNLOAD_MAX_BYTES, pageDownloadFileName } from "../../src/shared/page-download.js";
import { attachmentContentDisposition } from "../../src/shared/downloads.js";
import { PAGE_DOCUMENT_MAX_BYTES } from "../../src/shared/protocol/pages.js";
import { downloadPageDocument } from "../../src/server/pages/html-download.js";
import { capturePageDocument } from "../../src/server/pages/html-policy.js";

describe("page HTML download", () => {
  it.each([
    '<!doctype html><h1>世界 🌍</h1>',
    '<!doctype html><meta charset="windows-1252"><h1>Résumé 中文</h1>',
    `<!--${"long comment ".repeat(200)}--><!doctype html><h1>日本語</h1>`,
  ])("preserves captured authored HTML with a UTF-8 signature: %s", (html) => {
    const captured = capturePageDocument(parse(html));
    const document = { ...captured, page: { byteSize: Buffer.byteLength(captured.authoredHtml, "utf8") } };
    const bytes = downloadPageDocument(document);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.subarray(3).toString("utf8")).toBe(captured.authoredHtml);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(captured.authoredHtml);
    expect(bytes.byteLength).toBe(document.page.byteSize + 3);
    expect(bytes.toString("utf8")).not.toContain("sedes-page-document");
    expect(bytes.toString("utf8")).not.toContain("onSubmit");
  });

  it("bounds captured and exported payloads and rejects inconsistent saved lengths", () => {
    expect(PAGE_DOWNLOAD_MAX_BYTES).toBe(PAGE_DOCUMENT_MAX_BYTES + 3);
    expect(() => downloadPageDocument({ escapedHtml: "hi", bootstrapOffset: 0, page: { byteSize: 1 } }))
      .toThrow("page_download_document_size_invalid");
    expect(() => downloadPageDocument({ escapedHtml: "x".repeat(PAGE_DOCUMENT_MAX_BYTES + 1), bootstrapOffset: 0,
      page: { byteSize: PAGE_DOCUMENT_MAX_BYTES + 1 } })).toThrow("page_download_document_size_invalid");
  });

  it("creates safe deterministic revision filenames while retaining ordinary Unicode", () => {
    expect(pageDownloadFileName("Résumé 世界", 4)).toBe("Résumé 世界-r4.html");
    expect(pageDownloadFileName(' ../draft\\name: "a"?*\r\n', 7)).toBe('-draft-name- -a------r7.html');
    expect(pageDownloadFileName("...", 1)).toBe("page-r1.html");
    expect(pageDownloadFileName("CON", 1)).toBe("page-CON-r1.html");
    expect(pageDownloadFileName("aux.txt", 1)).toBe("page-aux.txt-r1.html");
    expect(pageDownloadFileName("LPT¹.report", 2)).toBe("page-LPT¹.report-r2.html");
    expect(pageDownloadFileName("x\u202ey\u2066z", 1)).toBe("x-y-z-r1.html");
    expect(pageDownloadFileName("\uD800", 1)).toBe("--r1.html");
    expect(() => pageDownloadFileName("a", 0)).toThrow("page_download_revision_invalid");
  });

  it.each(["x".repeat(240), "界".repeat(240), "🌍".repeat(120), "é".repeat(240)])(
    "bounds filename and percent-encoded disposition metadata: %s", (title) => {
      const fileName = pageDownloadFileName(title, Number.MAX_SAFE_INTEGER);
      expect(fileName.endsWith(`-r${Number.MAX_SAFE_INTEGER}.html`)).toBe(true);
      expect(Buffer.byteLength(fileName, "utf8")).toBeLessThanOrEqual(180);
      expect(Array.from(fileName).length).toBeLessThanOrEqual(128);
      expect(attachmentContentDisposition("attachment", fileName).length).toBeLessThanOrEqual(1024);
    },
  );
});
