import type { MermaidConfig } from "mermaid";

export type MermaidAppearance = "light" | "dark";

const MERMAID_CONFIG_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "htmlLabels",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "logLevel",
  "theme",
  "themeVariables",
  "themeCSS",
  "dompurifyConfig",
] as const;

let mermaidImport: Promise<(typeof import("mermaid"))["default"]> | undefined;
let renderQueue: Promise<void> = Promise.resolve();
let nextRenderId = 1;

/**
 * Mermaid keeps configuration in module-global state. Serialize configuration
 * and rendering together so diagrams using different app themes cannot race.
 */
export function renderMermaid(
  source: string,
  appearance: MermaidAppearance,
): Promise<string> {
  const rendering = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize(mermaidConfig(appearance));
    const id = `sedes-mermaid-${nextRenderId++}`;
    const { svg } = await mermaid.render(id, source);
    return validateRenderedSvg(svg);
  });
  renderQueue = rendering.then(
    () => undefined,
    () => undefined,
  );
  return rendering;
}

function loadMermaid(): Promise<(typeof import("mermaid"))["default"]> {
  mermaidImport ??= import("mermaid")
    .then((module) => module.default)
    .catch((error: unknown) => {
      mermaidImport = undefined;
      throw error;
    });
  return mermaidImport;
}

function mermaidConfig(appearance: MermaidAppearance): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    // Keep labels in the SVG namespace. The insertion-boundary validator
    // rejects foreignObject and all foreign namespaces rather than trusting
    // browser-specific HTML parsing inside generated diagrams.
    htmlLabels: false,
    secure: [...MERMAID_CONFIG_KEYS],
    suppressErrorRendering: true,
    // Invalid model-authored definitions use the in-app fallback; they must
    // not surface as browser console errors or trigger E2E page diagnostics.
    logLevel: "fatal",
    theme: appearance === "dark" ? "dark" : "default",
    maxTextSize: 50_000,
    maxEdges: 500,
  };
}

/**
 * Mermaid's strict mode sanitizes generated markup. Validate the returned SVG
 * again at the insertion boundary and fail closed on executable elements,
 * event handlers, or remote resource references.
 */
function validateRenderedSvg(value: string): string {
  const document = new DOMParser().parseFromString(value, "image/svg+xml");
  const root = document.documentElement;
  if (
    root.localName !== "svg" ||
    root.namespaceURI !== "http://www.w3.org/2000/svg" ||
    document.querySelector("parsererror")
  ) {
    throw new Error("Mermaid returned invalid SVG markup.");
  }

  const forbiddenElements = new Set([
    "animate",
    "animatemotion",
    "animatetransform",
    "foreignobject",
    "script",
    "iframe",
    "object",
    "set",
    "embed",
    "audio",
    "video",
  ]);
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (element.namespaceURI !== "http://www.w3.org/2000/svg") {
      throw new Error("Mermaid returned foreign SVG markup.");
    }
    if (forbiddenElements.has(element.localName.toLowerCase())) {
      throw new Error("Mermaid returned unsafe SVG markup.");
    }
    for (const attribute of element.getAttributeNames()) {
      const name = attribute.toLowerCase();
      const attributeValue = element.getAttribute(attribute) ?? "";
      if (name.startsWith("on") || name === "src" || name === "xml:base") {
        throw new Error("Mermaid returned unsafe SVG markup.");
      }
      if (
        (name === "href" || name === "xlink:href") &&
        !attributeValue.startsWith("#")
      ) {
        throw new Error("Mermaid returned an external SVG reference.");
      }
      validateCssUrls(attributeValue);
    }
    if (element.localName.toLowerCase() === "style") {
      const css = element.textContent ?? "";
      if (/@import\b/i.test(css)) {
        throw new Error("Mermaid returned unsafe SVG styles.");
      }
      validateCssUrls(css);
    }
  }
  return new XMLSerializer().serializeToString(root);
}

function validateCssUrls(value: string): void {
  for (const match of value.matchAll(/url\(\s*([^)]+?)\s*\)/gi)) {
    const target = match[1]?.replace(/^['"]|['"]$/g, "").trim();
    if (!target?.startsWith("#")) {
      throw new Error("Mermaid returned an external SVG resource.");
    }
  }
}
