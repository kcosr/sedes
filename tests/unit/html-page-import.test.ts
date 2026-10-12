import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { importHtmlPage, importInlineHtmlPage, resolveLocalImagePath } from "../../src/server/pages/html-import.js";
import { PAGE_SOURCE_MAX_BYTES } from "../../src/shared/protocol/pages.js";
import { renderPageDocument } from "../../src/server/pages/html-policy.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/i8AAAAASUVORK5CYII=", "base64");
function renderedInner(html: string): string {
  const nodes: DefaultTreeAdapterTypes.Node[] = [parse(html)];
  while (nodes.length) {
    const node = nodes.pop()!;
    if ("tagName" in node && node.tagName === "script" && node.attrs.some(attr => attr.name === "id" && attr.value === "sedes-page-document")) {
      return JSON.parse(node.childNodes.map(child => "value" in child ? child.value : "").join("")) as string;
    }
    if ("childNodes" in node) nodes.push(...node.childNodes);
  }
  throw new Error("Missing isolated authored document.");
}
function reader(html: string, extra: Record<string, Uint8Array> = {}) {
  const files = { "/workspace/page.html": Buffer.from(html), "/workspace/images/logo.png": png, ...extra };
  const reads: string[] = [];
  return { reads, async read(path: string) { reads.push(path); const bytes = files[path as keyof typeof files]; if (!bytes) throw new Error("missing file"); return bytes; } };
}

function inner(page: { escapedHtml: string }): string { return JSON.parse(`"${page.escapedHtml}"`) as string; }

describe("HTML page capture", () => {
  it("accepts self-contained inline HTML without filesystem authority", async () => {
    const inline = `<h1>Inline mockup</h1><img src="data:image/png;base64,${png.toString("base64")}"><script>document.title='demo'</script>`;
    const result = await importInlineHtmlPage(inline);
    expect(inner(result)).toContain("Inline mockup");
    expect(inner(result)).toContain("data:image/png;base64,");
    await expect(importInlineHtmlPage('<img src="/secrets/image.png">')).rejects.toThrow("self-contained");
    await expect(importInlineHtmlPage('<img src="https://example.test/image.png">')).rejects.toThrow("self-contained");
  });
  it("captures HTML image attributes and escaped CSS URLs while preserving inline interaction", async () => {
    const files = reader(`<style>.logo { background:url(images\\2f logo.png) }</style><img src="images/logo.png"><svg><image href="file:///workspace/images/logo.png"/></svg><script>document.body.onclick=()=>document.body.dataset.clicked='yes'</script>`);
    const result = await importHtmlPage(files, "/workspace/page.html");
    expect(inner(result)).toContain("data:image/png;base64,");
    expect(inner(result)).not.toContain("file:///workspace");
    expect(inner(result)).not.toContain("images/logo.png");
    expect(inner(result)).toContain("document.body.onclick");
    expect(result.sourceHtml).toContain("images/logo.png");
    expect(result.byteSize).toBe(Buffer.byteLength(inner(result)));
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(inner(result)).toContain("<head>");
  });

  it.each(["image-set", "-webkit-image-set", "image\\2d set", "image"])("captures direct image strings in CSS %s without treating type descriptors as URLs", async name => {
    const argumentsText = name === "image" ? '"images/logo.png",blue' : '"images/logo.png" 1x type("image/png")';
    const files = reader(`<style>.image { background-image:${name}(${argumentsText}); } .caption::after { content:"harmless local.png"; }</style>`);
    const result = await importHtmlPage(files, "/workspace/page.html");
    expect(inner(result)).toContain("data:image/png;base64,");
    expect(inner(result)).not.toContain("images/logo.png");
    if (name !== "image") expect(inner(result)).toContain('type("image/png")');
    expect(inner(result)).toContain('content:"harmless local.png"');
    expect(files.reads).toEqual(["/workspace/page.html", "/workspace/images/logo.png"]);
  });

  it.each(["image-set", "-webkit-image-set", "image\\2d set"])("rejects network string alternatives in CSS %s without fetching", async name => {
    const files = reader(`<style>.image { background:${name}("https://example.test/image.png" 1x) }</style>`);
    await expect(importHtmlPage(files, "/workspace/page.html")).rejects.toThrow("Network");
    expect(files.reads).toEqual(["/workspace/page.html"]);
  });

  it("requires embedded images for inline CSS image-set strings", async () => {
    await expect(importInlineHtmlPage('<style>.image{background:image-set("local.png" 1x)}</style>')).rejects.toThrow("self-contained");
    const html = `<style>.image{background:image-set("data:image/png;base64,${png.toString("base64")}" 1x)}</style>`;
    expect(inner(await importInlineHtmlPage(html))).toContain("data:image/png;base64,");
  });

  it.each([
    `<img src="https://example.test/image.png">`, `<img src="//example.test/image.png">`,
    `<style>a{background:url(https://example.test/image.png)}</style>`,
    `<style>@import "https://example.test/style.css";</style>`,
    `<style>@\\69mport "https://example.test/style.css";</style>`,
    `<style>@\\6e amespace svg url("https://example.test/svg");</style>`,
    `<script src="local.js"></script>`, `<link rel="stylesheet" href="local.css">`,
    `<svg><script href="https://example.test/code.js"></script></svg>`,
    `<svg><script xlink:href="local.js"></script></svg>`,
    `<svg><use href="https://example.test/shapes.svg#shape"></use></svg>`,
    `<svg><use xlink:href="local.svg#shape"></use></svg>`,
    `<body background="https://example.test/image.png">content</body>`,
    `<iframe srcdoc="hello"></iframe>`, `<meta http-equiv="refresh" content="0;https://example.test">`,
  ])("rejects external resources and unsupported resource loading: %s", async html => {
    const files = reader(html);
    await expect(importHtmlPage(files, "/workspace/page.html")).rejects.toThrow();
    expect(files.reads).toEqual(["/workspace/page.html"]);
  });

  it("captures legacy backgrounds and SVG filter images while preserving same-document SVG use", async () => {
    const files = reader(`<body background="images/logo.png"><table background="images/logo.png"><tr background="images/logo.png"><th background="images/logo.png">Header</th><td background="images/logo.png">Cell</td></tr></table><svg><defs><path id="shape" d="M0 0"/><filter id="filter"><feImage href="images/logo.png"/></filter></defs><use href="#shape"/><use xlink:href="#shape"/></svg></body>`);
    const result = await importHtmlPage(files, "/workspace/page.html");
    expect(inner(result)).not.toContain("images/logo.png");
    expect(inner(result).match(/background="data:image\/png;base64,/g)).toHaveLength(5);
    expect(inner(result)).toContain('<feImage href="data:image/png;base64,');
    expect(inner(result)).toContain('href="#shape"');
    expect(inner(result)).toContain('xlink:href="#shape"');
    expect(files.reads).toEqual(["/workspace/page.html", "/workspace/images/logo.png"]);
  });

  it.each(["pattern", "linearGradient", "radialGradient", "filter", "textPath", "mpath"])("keeps %s references within the same SVG document", async tag => {
    await expect(importInlineHtmlPage(`<svg><${tag} href="https://example.test/other.svg#id"/></svg>`)).rejects.toThrow("External SVG resource");
    await expect(importInlineHtmlPage(`<svg><${tag} xlink:href="local.svg#id"/></svg>`)).rejects.toThrow("External SVG resource");
    expect(inner(await importInlineHtmlPage(`<svg><${tag} href="#id"/></svg>`))).toContain('href="#id"');
  });

  it.each(["fill", "stroke", "filter", "mask", "clip-path", "marker", "marker-start", "marker-mid", "marker-end", "cursor"])("checks CSS resources in SVG %s presentation attributes", async attribute => {
    await expect(importInlineHtmlPage(`<svg><path ${attribute}="url(https://example.test/image.png)"/></svg>`)).rejects.toThrow("self-contained");
    expect(inner(await importInlineHtmlPage(`<svg><path ${attribute}="url(#local)"/></svg>`))).toContain("url(#local)");
  });

  it("captures a local cursor image from a presentation attribute", async () => {
    const files = reader('<svg><path cursor="url(images/logo.png), auto" fill="red"/></svg>');
    const result = await importHtmlPage(files, "/workspace/page.html");
    expect(inner(result)).toContain("data:image/png;base64,");
    expect(inner(result)).toContain('fill="red"');
  });

  it("fails the whole import when an image is missing or is not a raster image", async () => {
    await expect(importHtmlPage(reader('<img src="missing.png">'), "/workspace/page.html")).rejects.toThrow("missing file");
    await expect(importHtmlPage(reader('<img src="images/logo.png">', { "/workspace/images/logo.png": Buffer.from("not an image") }), "/workspace/page.html")).rejects.toThrow("supported PNG");
  });

  it("bounds source and image count and accepts only complete UTF-8", async () => {
    await expect(importHtmlPage(reader("x".repeat(PAGE_SOURCE_MAX_BYTES + 1)), "/workspace/page.html")).rejects.toThrow("exceeds 1 MiB");
    await expect(importHtmlPage({ read: async () => new Uint8Array([0xc0, 0x80]) }, "/workspace/page.html")).rejects.toThrow("UTF-8");
    const images = Array.from({ length: 65 }, (_, index) => `<img src="images/${index}.png">`).join("");
    const files = reader(images, Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`/workspace/images/${index}.png`, png])));
    await expect(importHtmlPage(files, "/workspace/page.html")).rejects.toThrow("64 image");
  });

  it.each(["srcset", "css"])("enforces the image budget before reading a 65th %s candidate", async mode => {
    const references = Array.from({ length: 65 }, (_, index) => `images/${index}.png`);
    const html = mode === "srcset"
      ? `<img srcset="${references.map((reference, index) => `${reference} ${index + 1}w`).join(", ")}">`
      : `<style>${references.map((reference, index) => `.image${index}{background:url(${reference})}`).join("")}</style>`;
    const files = reader(html, Object.fromEntries(references.map(reference => [`/workspace/${reference}`, png])));
    let active = 0;
    let maximumActive = 0;
    const capture = { read: async (path: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      try { return await files.read(path); } finally { active -= 1; }
    } };
    await expect(importHtmlPage(capture, "/workspace/page.html")).rejects.toThrow("64 image");
    expect(maximumActive).toBe(1);
    expect(files.reads).toHaveLength(65); // One HTML source plus 64 images.
    expect(files.reads).not.toContain("/workspace/images/64.png");
  });

  it("shares one image budget between CSS and srcset references", async () => {
    const references = Array.from({ length: 65 }, (_, index) => `images/${index}.png`);
    const html = `<style>.hero{background:url(${references[0]})}</style><img srcset="${references.slice(1).map((reference, index) => `${reference} ${index + 1}w`).join(", ")}">`;
    const files = reader(html, Object.fromEntries(references.map(reference => [`/workspace/${reference}`, png])));
    await expect(importHtmlPage(files, "/workspace/page.html")).rejects.toThrow("64 image");
    expect(files.reads).toHaveLength(65);
  });

  it("retains each captured image after its source bytes change", async () => {
    const files = reader('<img src="images/logo.png">');
    const first = await importHtmlPage(files, "/workspace/page.html");
    const second = await importHtmlPage(reader('<img src="images/logo.png">'), "/workspace/page.html");
    expect(second.escapedHtml).toBe(first.escapedHtml);
    expect(second.sha256).toBe(first.sha256);
  });

  it("stores authored content only and adds the current isolation code when rendering", async () => {
    const source = '<h1>Mock-up</h1><script>window.authored=true</script>';
    const result = await importInlineHtmlPage(source);
    const authoredDocument = inner(result);
    const rendered = renderPageDocument(result);
    const renderedDocument = renderedInner(rendered);
    expect(result.sourceHtml).toBe(source);
    expect(rendered).toContain('id="sedes-page-document"');
    expect(authoredDocument).not.toContain("sedes:page-size");
    expect(result.escapedHtml).not.toContain("sedes:page-size");
    expect(renderedDocument.match(/type:"sedes:page-size"/g)).toHaveLength(1);
    expect(renderedDocument.indexOf('type:"sedes:page-size"')).toBeLessThan(renderedDocument.indexOf("window.authored=true"));
    expect(result.byteSize).toBe(Buffer.byteLength(inner(result)));
    expect(result.sha256).toBe(createHash("sha256").update(authoredDocument).digest("hex"));
  });

  it("resolves local relative paths in POSIX and Windows namespaces without platform leakage", () => {
    expect(resolveLocalImagePath("/work/page.html", "../images/a%20b.png")).toBe("/images/a b.png");
    expect(resolveLocalImagePath("C:\\work\\page.html", "images/logo.png")).toBe("C:\\work\\images\\logo.png");
    expect(resolveLocalImagePath("C:\\work\\page.html", "file:///C:/assets/logo.png")).toBe("C:\\assets\\logo.png");
    expect(() => resolveLocalImagePath("/work/page.html", "file://host/share/logo.png")).toThrow("Network");
    expect(() => resolveLocalImagePath("/work/page.html", "https://example.test/logo.png")).toThrow("Network");
  });
});
