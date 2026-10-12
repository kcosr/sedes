import { parse } from "parse5";
import { describe, expect, it } from "vitest";
import { capturePageDocument, renderPageDocument } from "../../src/server/pages/html-policy.js";
import { PagePreviewBrowser } from "../../src/server/pages/preview-browser.js";

// This deliberately launches the separately installed, sandboxed Chromium.
// Ordinary unit tests do not require that optional installation or host support.
describe.runIf(process.env.SEDES_TEST_PAGE_PREVIEW_BROWSER === "1")("installed page preview browser", () => {
  it("measures a component even when authored globals shadow browser names", async () => {
    const browser = new PagePreviewBrowser();
    try {
      const html = renderPageDocument(capturePageDocument(parse(`<!doctype html>
<html><head><style>html,body{margin:0}.component{height:140px;background:lavender}</style></head>
<body><section class="component">Shadowed globals retain the correct layout.</section>
<script>
const parent = {};
let scrollY = 900000;
const innerWidth = 7;
const innerHeight = 999999;
const getComputedStyle = () => { throw new Error("shadowed getComputedStyle called"); };
const requestAnimationFrame = null;
const Promise = null;
const Math = {};
const Number = {};
</script></body></html>`)));
      const result = await browser.render({ html });
      expect(result).toMatchObject({ width: 768, height: 140, contentWidth: 768, contentHeight: 140, imageWidth: 768, imageHeight: 140 });
      expect(result.console.filter((entry) => entry.level === "error")).toEqual([]);
      expect(result.png.readUInt32BE(16)).toBe(768);
      expect(result.png.readUInt32BE(20)).toBe(140);
    } finally {
      await browser.close();
    }
  }, 25_000);
});
