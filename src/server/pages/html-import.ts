import { createHash } from "node:crypto";
import path from "node:path";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { generate, ident, parse as parseCss, walk } from "css-tree";
import { normalizedAbsolutePath } from "../../shared/absolute-path.js";
import { PAGE_DOCUMENT_MAX_BYTES, PAGE_ESCAPED_MAX_BYTES, PAGE_MAX_IMAGES, PAGE_SOURCE_MAX_BYTES } from "../../shared/protocol/pages.js";
import type { PreparedPage } from "../db/repositories/page-repository.js";
import { DomainError } from "../domain/errors.js";
import { inspectSupportedRasterImage } from "../images/raster-image-inspector.js";
import { capturePageDocument } from "./html-policy.js";

export interface PageFileReader { read(absolutePath: string, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array>; }
const invalid = (message: string) => new DomainError("bad_request", message);

/** Capture source and raster assets without executing HTML or following network URLs. */
export async function importHtmlPage(reader: PageFileReader, absolutePath: string, signal?: AbortSignal): Promise<PreparedPage> {
  if (!normalizedAbsolutePath(absolutePath) || absolutePath.length > 4096) throw invalid("Provide a normalized absolute HTML file path.");
  const source = await reader.read(absolutePath, PAGE_SOURCE_MAX_BYTES, signal);
  return importHtmlSource(source, { reader, absolutePath }, signal);
}

/** Inline HTML has no filesystem authority. All images must already be embedded. */
export async function importInlineHtmlPage(html: string, signal?: AbortSignal): Promise<PreparedPage> {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(html)) throw invalid("HTML must contain well-formed text.");
  return importHtmlSource(Buffer.from(html, "utf8"), undefined, signal);
}

async function importHtmlSource(source: Uint8Array, files: { reader: PageFileReader; absolutePath: string } | undefined, signal?: AbortSignal): Promise<PreparedPage> {
  signal?.throwIfAborted();
  if (source.byteLength === 0 || source.byteLength > PAGE_SOURCE_MAX_BYTES) throw invalid("The HTML file is empty or exceeds 1 MiB.");
  let sourceHtml: string;
  try { sourceHtml = new TextDecoder("utf-8", { fatal: true }).decode(source); }
  catch { throw invalid("The HTML file must contain valid UTF-8 text."); }
  if (sourceHtml.includes("\0")) throw invalid("The HTML file contains a null character.");
  const document = parse(sourceHtml);
  const assets = new Map<string, string>();
  let totalBytes = source.byteLength;

  const image = async (reference: string): Promise<string> => {
    signal?.throwIfAborted();
    const value = reference.trim();
    if (!value || value.startsWith("#")) return value;
    const cached = assets.get(value);
    if (cached) return cached;
    if (assets.size >= PAGE_MAX_IMAGES) throw invalid("A page can capture at most 64 image references.");
    let bytes: Uint8Array;
    if (value.startsWith("data:")) {
      const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
      if (!match) throw invalid("Embedded images must be base64 PNG, JPEG, GIF, or WebP.");
      bytes = Buffer.from(match[1]!, "base64");
      if (Buffer.from(bytes).toString("base64") !== match[1]) throw invalid("An embedded image is not canonical base64.");
    } else {
      if (!files) throw invalid("Inline HTML must be self-contained. Embed images as data URLs or publish a file to capture local image references.");
      bytes = await files.reader.read(resolveLocalImagePath(files.absolutePath, value), PAGE_DOCUMENT_MAX_BYTES, signal);
    }
    const inspected = inspectSupportedRasterImage(bytes);
    if (!inspected) throw invalid("A referenced image is not a supported PNG, JPEG, GIF, or WebP.");
    totalBytes += Math.ceil(bytes.byteLength / 3) * 4;
    if (totalBytes > PAGE_DOCUMENT_MAX_BYTES) throw invalid("The captured page exceeds 16 MiB.");
    const result = `data:${inspected.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
    assets.set(value, result);
    return result;
  };
  const css = async (value: string, context: "stylesheet" | "declarationList" | "value"): Promise<string> => {
    let ast;
    try { ast = parseCss(value, { context, parseCustomProperty: true }); }
    catch { throw invalid("A page contains invalid CSS."); }
    const resources: Array<{ value: string }> = [];
    walk(ast, node => {
      if (node.type === "Atrule" && ["import", "namespace"].includes(ident.decode(node.name).toLowerCase())) {
        throw invalid("External CSS imports are unsupported; put styles inline.");
      }
      if (node.type === "Url") resources.push(node);
      if (node.type === "Function" && ["image", "image-set", "-webkit-image-set"].includes(ident.decode(node.name).toLowerCase())) {
        // These image functions allow a direct string as a resource URL.
        // Nested type("image/png") strings are descriptors, not resources.
        node.children.forEach(child => { if (child.type === "String") resources.push(child); });
      }
    });
    // Capture serially: the common image-count and byte budgets must settle
    // before another source read starts, including across CSS and HTML.
    for (const resource of resources) resource.value = await image(resource.value);
    return generate(ast);
  };
  const pending: Array<{ node: DefaultTreeAdapterTypes.Node; depth: number }> = [{ node: document, depth: 0 }];
  let nodeCount = 0;
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (++nodeCount > 100_000 || depth > 128) throw invalid("The HTML document is too complex.");
    if ("tagName" in node) {
      const tag = node.tagName.toLowerCase();
      if (["base", "iframe", "frame", "frameset", "object", "embed"].includes(tag)) throw invalid("Embedded browsing contexts and base URLs are unsupported.");
      if (tag === "meta" && node.attrs.some(attr => attr.name === "http-equiv")) throw invalid("HTML http-equiv directives are unsupported.");
      for (const attr of node.attrs) {
        if (attr.name === "href" && tag === "script") throw invalid("Script resources are unsupported; put JavaScript inline.");
        if (attr.name === "href" && ["use", "pattern", "lineargradient", "radialgradient", "filter", "textpath", "mpath"].includes(tag) && attr.value.trim() !== "" && !attr.value.trim().startsWith("#")) {
          throw invalid("External SVG resource references are unsupported; reference an element in the same document.");
        }
        if (attr.name === "style") attr.value = await css(attr.value, "declarationList");
        if (["fill", "stroke", "filter", "mask", "clip-path", "marker", "marker-start", "marker-mid", "marker-end", "cursor"].includes(attr.name)) {
          attr.value = await css(attr.value, "value");
        }
        if (attr.name === "srcset") {
          // Data URL commas are ambiguous in srcset. Inline data images belong in src.
          if (attr.value.includes("data:")) throw invalid("Use src for an embedded data image; srcset accepts local image files.");
          const entries = attr.value.split(",");
          const captured: string[] = [];
          // Do not parallelize: completing one capture reserves its budget
          // before admission of the next srcset candidate.
          for (const entry of entries) {
            const match = /^\s*(\S+)(?:\s+(\d+(?:\.\d+)?[wx]))?\s*$/.exec(entry);
            if (!match) throw invalid("A page contains an invalid image srcset.");
            captured.push(`${await image(match[1]!)}${match[2] ? ` ${match[2]}` : ""}`);
          }
          attr.value = captured.join(", ");
        }
        const svgImage = tag === "image" || tag === "feimage";
        const backgroundImage = attr.name === "background" && ["body", "table", "tr", "td", "th"].includes(tag);
        if (attr.name === "src" || attr.name === "poster" || (attr.name === "href" && svgImage) || backgroundImage) {
          if (tag !== "img" && !svgImage && tag !== "source" && attr.name !== "poster" && !backgroundImage) throw invalid("Only image resources can be imported; inline scripts and styles are supported.");
          attr.value = await image(attr.value);
        }
        if (attr.name === "href" && tag === "link") throw invalid("Linked resources are unsupported; put styles inline and use img for images.");
      }
      if (tag === "style") for (const child of node.childNodes) if (child.nodeName === "#text" && "value" in child) child.value = await css(child.value, "stylesheet");
      if ("content" in node) pending.push({ node: (node as DefaultTreeAdapterTypes.Template).content, depth: depth + 1 });
    }
    if ("childNodes" in node) for (const child of node.childNodes) pending.push({ node: child, depth: depth + 1 });
  }
  const { authoredHtml, escapedHtml, bootstrapOffset } = capturePageDocument(document);
  const byteSize = Buffer.byteLength(authoredHtml, "utf8");
  if (byteSize > PAGE_DOCUMENT_MAX_BYTES) throw invalid("The captured page exceeds 16 MiB.");
  if (Buffer.byteLength(escapedHtml, "utf8") > PAGE_ESCAPED_MAX_BYTES) throw invalid("The encoded page exceeds 32 MiB.");
  return { sourceHtml, escapedHtml, bootstrapOffset, byteSize, sha256: createHash("sha256").update(authoredHtml).digest("hex") };
}

export function resolveLocalImagePath(sourcePath: string, reference: string): string {
  const windows = /^[a-z]:\\/i.test(sourcePath) || sourcePath.startsWith("\\\\");
  const paths = windows ? path.win32 : path.posix;
  let value = reference;
  if (/^file:/i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw invalid("A file image URL is invalid."); }
    if (url.username || url.password || url.port || url.search) throw invalid("A file image URL is invalid.");
    try { value = decodeURIComponent(url.pathname); } catch { throw invalid("An image path contains invalid escapes."); }
    if (windows) value = url.hostname && url.hostname !== "localhost" ? `\\\\${url.hostname}${value.replaceAll("/", "\\")}` : value.replace(/^\/(?=[a-z]:)/i, "").replaceAll("/", "\\");
    else if (url.hostname && url.hostname !== "localhost") throw invalid("Network image URLs are unsupported.");
  } else {
    if (value.startsWith("//") || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !(windows && /^[a-z]:\\/i.test(value)))) throw invalid("Network image URLs are unsupported; use local image files.");
    try { value = decodeURIComponent(value.split(/[?#]/, 1)[0]!); } catch { throw invalid("An image path contains invalid escapes."); }
    if (windows) value = value.replaceAll("/", "\\");
  }
  const resolved = paths.resolve(paths.dirname(sourcePath), value);
  if (!normalizedAbsolutePath(resolved) || resolved.length > 4096) throw invalid("An image path is invalid.");
  return resolved;
}
