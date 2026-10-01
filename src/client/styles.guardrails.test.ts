// Style guardrails for the client design system.
//
// Rule 1 (every var() without a fallback resolves) is zero-tolerance. The
// other rules are a ratchet: styles.guardrails.baseline.json records the
// offender count per rule and file, and any difference fails. A rise has to be
// fixed; a drop has to be locked in by lowering the baseline with:
//
//   UPDATE_STYLE_GUARDRAILS=1 npx vitest run src/client/styles.guardrails.test.ts
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type ChildNode, type Declaration, type Root } from "postcss";
import { describe, expect, it } from "vitest";

const CLIENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(CLIENT_DIRECTORY, "styles.guardrails.baseline.json");
const UPDATE_BASELINE = process.env.UPDATE_STYLE_GUARDRAILS === "1";
const UPDATE_COMMAND =
  "UPDATE_STYLE_GUARDRAILS=1 npx vitest run src/client/styles.guardrails.test.ts";

/**
 * Custom properties that client code sets at runtime (style.setProperty or a
 * React style object) and CSS reads without a fallback. Each entry must still
 * be both set and read; the allowlist test fails on stale entries.
 */
const RUNTIME_SET_PROPERTIES: readonly string[] = [
  // app/environment-palette.ts: the environment tint of a row or chip
  "--environment-chroma",
  "--environment-hue",
  // components/ui/dialog.tsx: the soft keyboard's height over the layout viewport
  "--keyboard-inset",
  // components/ui/toast.tsx: the measured toast placement in the workspace
  "--toast-bottom",
  "--toast-region-width",
  "--toast-swipe-end-y",
  "--toast-swipe-move-y",
  "--toast-x",
];

/** Custom properties that a library sets on its own elements at runtime. */
const LIBRARY_SET_PREFIXES = ["--radix-"] as const;

/**
 * Media features that belong to the layout system: 819/820px is the app
 * breakpoint, and dialog footers stack below 520px.
 */
const ALLOWED_MEDIA_FEATURES = new Set([
  "(max-width:819px)",
  "(min-width:820px)",
  "(max-width:519px)",
  "(pointer:coarse)",
  "(pointer:fine)",
  "(hover:none)",
  "(hover:hover)",
  "(prefers-reduced-motion:reduce)",
  "(prefers-reduced-motion:no-preference)",
]);

const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk " +
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue " +
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite " +
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen " +
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

const COLOR_PROPERTIES =
  /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|text-decoration(?:-color)?|caret-color|accent-color|fill|stroke|column-rule(?:-color)?|scrollbar-color)$/u;

const TAILWIND_PALETTE =
  /(?<![\w-])(?:[\w-]+:)*(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|decoration|divide|placeholder|caret|accent|shadow|inset-shadow|drop-shadow)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|black|white)(?:\/\d+)?(?![\w-])/gu;
const TAILWIND_ARBITRARY_TEXT_SIZE = /(?<![\w-])(?:[\w-]+:)*text-\[\d+(?:\.\d+)?px\]/gu;
const HEX_COLOR = /#[0-9a-f]{3,8}(?![\w-])/giu;
const COLOR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/giu;
const VAR_WITHOUT_FALLBACK = /var\(\s*(--[\w-]+)\s*\)/gu;
const TAILWIND_VAR_SHORTHAND = /-\((--[\w-]+)\)/gu;

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const METRICS = [
  "colorLiterals",
  "fontSizeLiterals",
  "fontWeightLiterals",
  "borderRadiusLiterals",
  "zIndexLiterals",
  "important",
  "mediaQueries",
  "tsxPaletteColors",
  "tsxArbitraryTextSizes",
  "tsxStyleHex",
] as const;
type Metric = (typeof METRICS)[number];
type Baseline = Record<Metric, Record<string, number>>;

const METRIC_RULES: Record<Metric, string> = {
  colorLiterals: "color literal outside the § TOKENS block (use a color token)",
  fontSizeLiterals: "font-size literal (use var(--text-*))",
  fontWeightLiterals: "font-weight literal (use var(--weight-*))",
  borderRadiusLiterals: "border-radius literal (use a radius token; 0, 50% and 999px are fine)",
  zIndexLiterals: "z-index literal (use a --z-* layer; 0 and negative stack-local values are fine)",
  important: "!important",
  mediaQueries: "media query outside the layout system (use 819/820px, the density switch, pointer, hover or reduced motion)",
  tsxPaletteColors: "Tailwind palette color in TSX outside components/ui (use a semantic color)",
  tsxArbitraryTextSizes: "text-[Npx] in TSX outside components/ui (use the type ramp)",
  tsxStyleHex: "hex color in a style= prop outside components/ui (use a color token)",
};

function listFiles(directory: string, accept: (file: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(target, accept));
    else if (accept(target)) files.push(target);
  }
  return files.sort();
}

const relative = (file: string) => path.relative(CLIENT_DIRECTORY, file).split(path.sep).join("/");
const lineAt = (source: string, index: number) => source.slice(0, index).split("\n").length;
const clip = (text: string) => text.replace(/\s+/gu, " ").trim().slice(0, 140);
const isTest = (file: string) => /\.test\.tsx?$/u.test(file);

/** Top-level nodes of the `§ TOKENS AND THEME CONTRACT` section of styles.css. */
function tokenSectionNodes(root: Root): Set<ChildNode> {
  const nodes = new Set<ChildNode>();
  let inside = false;
  for (const node of root.nodes) {
    if (node.type === "comment" && node.text.includes("§ ")) {
      inside = node.text.includes("§ TOKENS");
      continue;
    }
    if (inside) nodes.add(node);
  }
  return nodes;
}

function topLevel(node: ChildNode): ChildNode {
  let current: ChildNode = node;
  while (current.parent && current.parent.type !== "root") current = current.parent as ChildNode;
  return current;
}

function withoutStringsAndUrls(value: string): string {
  return value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\)/gu, "");
}

/** The text between the parenthesis at `open` and its match. */
function balancedArguments(value: string, open: number): string {
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")" && --depth === 0) return value.slice(open + 1, index);
  }
  return value.slice(open + 1);
}

/**
 * The value with every var() reference removed but its fallback kept: a
 * fallback is a literal written in the stylesheet, and it renders whenever the
 * reference does not resolve (rule 1 only checks references without one).
 */
function withoutTokenReferences(value: string): string {
  let result = value;
  for (let start = result.indexOf("var("); start >= 0; start = result.indexOf("var(", start)) {
    const inner = balancedArguments(result, start + 3);
    let comma = -1;
    for (let index = 0, depth = 0; index < inner.length && comma < 0; index += 1) {
      if (inner[index] === "(") depth += 1;
      else if (inner[index] === ")") depth -= 1;
      else if (inner[index] === "," && depth === 0) comma = index;
    }
    // Continue at the fallback, which may hold nested references.
    result = result.slice(0, start) + (comma < 0 ? "" : ` ${inner.slice(comma + 1)} `) + result.slice(start + 4 + inner.length + 1);
  }
  return result;
}

/**
 * A color function is a literal when a channel is a number; one computed
 * from tokens (for example `oklch(var(--l) var(--c) var(--h) / 0.1)`) is not.
 */
function hasColorFunctionLiteral(value: string): boolean {
  for (const match of value.matchAll(COLOR_FUNCTION)) {
    const channels = balancedArguments(value, match.index + match[0].length - 1).split("/")[0]!;
    if (/\d/u.test(withoutTokenReferences(channels))) return true;
  }
  return false;
}

function hasColorLiteral(declaration: Declaration): boolean {
  // Mask images use black and transparent as coverage, not as colors.
  if (/^(?:-webkit-)?mask(?:-|$)/u.test(declaration.prop)) return false;
  const value = withoutStringsAndUrls(declaration.value);
  HEX_COLOR.lastIndex = 0;
  if (HEX_COLOR.test(value) || hasColorFunctionLiteral(value)) return true;
  if (!COLOR_PROPERTIES.test(declaration.prop) && !declaration.prop.startsWith("--")) return false;
  return value
    .replace(/--[\w-]+/gu, "")
    .toLowerCase()
    .split(/[^a-z]+/u)
    .some((word) => NAMED_COLORS.has(word));
}

const GLOBAL_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

/**
 * The components of a value outside var() references, fallbacks included:
 * numbers (with their unit), identifiers and function names.
 */
function componentsOutsideTokens(value: string): string[] {
  return withoutTokenReferences(withoutStringsAndUrls(value.toLowerCase())).match(
    /[a-z-]+\(|[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z]+|%)?|[a-z][\w-]*/gu,
  ) ?? [];
}

const isFunction = (component: string) => component.endsWith("(");
const isNumber = (component: string) => /^[+-]?[\d.]/u.test(component);
const unitOf = (component: string) => component.replace(/^[+-]?[\d.]+/u, "");

function isFontSizeLiteral(declaration: Declaration): boolean {
  const value = declaration.value.trim().toLowerCase();
  if (GLOBAL_KEYWORDS.has(value)) return false;
  const selector = declaration.parent?.type === "rule" ? declaration.parent.selector : "";
  // Markdown scales with its container on purpose.
  const relativeAllowed = /\.markdown(?![\w-])/u.test(selector);
  return componentsOutsideTokens(value).some((component) => {
    if (isFunction(component)) return false;
    if (!isNumber(component)) {
      // In the `font` shorthand, words are families and styles; elsewhere
      // they are size keywords such as `small`.
      return declaration.prop !== "font";
    }
    const unit = unitOf(component);
    // Unitless numbers are calc() factors (or the shorthand's weight).
    if (unit === "") return false;
    return !(relativeAllowed && (unit === "em" || unit === "%"));
  });
}

function isFontWeightLiteral(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (GLOBAL_KEYWORDS.has(normalized)) return false;
  return componentsOutsideTokens(normalized).some((component) => !isFunction(component));
}

/** Splits a value on top-level whitespace and slashes. */
function topLevelComponents(value: string): string[] {
  const components: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth === 0 && /[\s/]/u.test(character)) {
      if (current) components.push(current);
      current = "";
    } else current += character;
  }
  if (current) components.push(current);
  return components;
}

const ALLOWED_RADIUS_LITERALS = new Set(["0", "0px", "50%", "999px", "9999px"]);
/** Nested-radius geometry: inner = outer - inset (or outer = inner + inset). */
const RADIUS_GEOMETRY = /^calc\(var\(--radius-[\w-]+\)[+-]\d+(?:\.\d+)?px\)$/u;

function isBorderRadiusLiteral(declaration: Declaration): boolean {
  const value = declaration.value.trim().toLowerCase();
  if (GLOBAL_KEYWORDS.has(value)) return false;
  return topLevelComponents(value).some((component) => {
    if (ALLOWED_RADIUS_LITERALS.has(component)) return false;
    if (RADIUS_GEOMETRY.test(component.replace(/\s+/gu, ""))) return false;
    return componentsOutsideTokens(component).some((part) => !isFunction(part));
  });
}

/** A layer, or a layer plus or minus a whole offset. */
const Z_LAYER = /^(?:var\(--z-[\w-]+\)|calc\(var\(--z-[\w-]+\)[+-]\d+\))$/u;

function isZIndexLiteral(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || GLOBAL_KEYWORDS.has(normalized)) return false;
  if (Z_LAYER.test(normalized.replace(/\s+/gu, ""))) return false;
  // 0 and negative values order things inside one stacking context.
  return !/^-?\d+$/u.test(normalized) || Number(normalized) > 0;
}

function isAllowedMediaQuery(params: string): boolean {
  return params.split(",").every((alternative) =>
    alternative
      .trim()
      .toLowerCase()
      .split(/\s+and\s+/u)
      .every((feature) => ALLOWED_MEDIA_FEATURES.has(feature.replace(/\s+/gu, ""))),
  );
}

/** The `{…}` expression of each JSX `style` attribute in a TSX source. */
function styleExpressions(source: string): Array<{ readonly index: number; readonly text: string }> {
  const expressions: Array<{ index: number; text: string }> = [];
  // JSX allows whitespace, newlines and comments around the `=`.
  for (const match of source.matchAll(/(?<![\w$.-])style\s*(?:\/\*[\s\S]*?\*\/\s*)*=\s*(?:\/\*[\s\S]*?\*\/\s*)*\{/gu)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        expressions.push({ index: start, text: source.slice(start, index + 1) });
        break;
      }
    }
  }
  return expressions;
}

interface Scan {
  readonly unresolved: Offender[];
  readonly staleAllowlist: string[];
  readonly metrics: Record<Metric, Offender[]>;
}

function scan(): Scan {
  const cssFiles = listFiles(CLIENT_DIRECTORY, (file) => file.endsWith(".css"));
  const sourceFiles = listFiles(CLIENT_DIRECTORY, (file) => /\.tsx?$/u.test(file) && !isTest(file));
  const metrics = Object.fromEntries(METRICS.map((metric) => [metric, []])) as unknown as Record<Metric, Offender[]>;
  const defined = new Set<string>();
  const references: Array<Offender & { readonly name: string }> = [];

  for (const file of cssFiles) {
    const name = relative(file);
    const root = postcss.parse(readFileSync(file, "utf8"), { from: file });
    const tokenNodes = name === "styles.css" ? tokenSectionNodes(root) : new Set<ChildNode>();
    root.walkAtRules("media", (rule) => {
      if (!isAllowedMediaQuery(rule.params)) {
        metrics.mediaQueries.push({ file: name, line: rule.source?.start?.line ?? 0, text: `@media ${rule.params}` });
      }
    });
    root.walkDecls((declaration) => {
      const offender = {
        file: name,
        line: declaration.source?.start?.line ?? 0,
        text: clip(`${declaration.prop}: ${declaration.value}${declaration.important ? " !important" : ""}`),
      };
      if (declaration.prop.startsWith("--")) defined.add(declaration.prop);
      for (const match of declaration.value.matchAll(VAR_WITHOUT_FALLBACK)) {
        references.push({ ...offender, name: match[1]! });
      }
      if (declaration.important) metrics.important.push(offender);
      if (!tokenNodes.has(topLevel(declaration)) && hasColorLiteral(declaration)) {
        metrics.colorLiterals.push(offender);
      }
      const property = declaration.prop.toLowerCase();
      if ((property === "font-size" || property === "font") && isFontSizeLiteral(declaration)) {
        metrics.fontSizeLiterals.push(offender);
      }
      if (property === "font-weight" && isFontWeightLiteral(declaration.value)) {
        metrics.fontWeightLiterals.push(offender);
      }
      if (/^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/u.test(property) && isBorderRadiusLiteral(declaration)) {
        metrics.borderRadiusLiterals.push(offender);
      }
      if (property === "z-index" && isZIndexLiteral(declaration.value)) metrics.zIndexLiterals.push(offender);
    });
  }

  let runtimeSource = "";
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    const name = relative(file);
    runtimeSource += source;
    for (const pattern of [VAR_WITHOUT_FALLBACK, TAILWIND_VAR_SHORTHAND]) {
      for (const match of source.matchAll(pattern)) {
        references.push({ file: name, line: lineAt(source, match.index), text: clip(match[0]), name: match[1]! });
      }
    }
    if (!file.endsWith(".tsx") || name.startsWith("components/ui/")) continue;
    for (const [metric, pattern] of [
      ["tsxPaletteColors", TAILWIND_PALETTE],
      ["tsxArbitraryTextSizes", TAILWIND_ARBITRARY_TEXT_SIZE],
    ] as const) {
      for (const match of source.matchAll(pattern)) {
        metrics[metric].push({ file: name, line: lineAt(source, match.index), text: match[0] });
      }
    }
    for (const expression of styleExpressions(source)) {
      for (const match of expression.text.matchAll(HEX_COLOR)) {
        metrics.tsxStyleHex.push({
          file: name,
          line: lineAt(source, expression.index + match.index),
          text: clip(`style=${expression.text}`),
        });
      }
    }
  }

  const runtimeSet = (property: string) =>
    RUNTIME_SET_PROPERTIES.includes(property) ||
    LIBRARY_SET_PREFIXES.some((prefix) => property.startsWith(prefix));
  const unresolved = references
    .filter((reference) => !defined.has(reference.name) && !runtimeSet(reference.name))
    .map(({ file, line, text }) => ({ file, line, text }));
  const staleAllowlist = RUNTIME_SET_PROPERTIES.filter(
    (property) =>
      defined.has(property) ||
      !references.some((reference) => reference.name === property) ||
      !new RegExp(`["'\`]${property}["'\`]`, "u").test(runtimeSource),
  );
  return { unresolved, staleAllowlist, metrics };
}

function countByFile(offenders: readonly Offender[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const offender of offenders) counts[offender.file] = (counts[offender.file] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function readBaseline(): Baseline {
  const parsed = existsSync(BASELINE_FILE)
    ? (JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Partial<Baseline>)
    : {};
  return Object.fromEntries(METRICS.map((metric) => [metric, parsed[metric] ?? {}])) as Baseline;
}

const format = (offender: Offender) => `  ${offender.file}:${offender.line}  ${offender.text}`;

const result = scan();
const baseline = readBaseline();
const current = Object.fromEntries(
  METRICS.map((metric) => [metric, countByFile(result.metrics[metric])]),
) as Baseline;

function comparison(metric: Metric) {
  const files = new Set([...Object.keys(current[metric]), ...Object.keys(baseline[metric])]);
  const rises: string[] = [];
  const drops: string[] = [];
  for (const file of [...files].sort()) {
    const now = current[metric][file] ?? 0;
    const allowed = baseline[metric][file] ?? 0;
    if (now > allowed) rises.push(file);
    else if (now < allowed) drops.push(`${file} ${allowed} -> ${now}`);
  }
  return { rises, drops };
}

// Update mode only ever lowers an existing baseline: with any rise it writes
// nothing and the rising rule still fails below.
if (UPDATE_BASELINE) {
  if (!existsSync(BASELINE_FILE) || METRICS.every((metric) => comparison(metric).rises.length === 0)) {
    writeFileSync(
      BASELINE_FILE,
      `${JSON.stringify(
        {
          $comment: `Ratchet for src/client/styles.guardrails.test.ts: offender counts per rule and file may only go down. After removing offenders run ${UPDATE_COMMAND}`,
          ...current,
        },
        null,
        2,
      )}\n`,
    );
  }
}

describe("client style guardrails", () => {
  it("resolves every var() without a fallback", () => {
    expect(
      result.unresolved,
      [
        "These var() references have no fallback and no definition in client CSS.",
        "Define the property, add a fallback, or (for a property set at runtime)",
        "add it to RUNTIME_SET_PROPERTIES in src/client/styles.guardrails.test.ts:",
        ...result.unresolved.map(format),
      ].join("\n"),
    ).toEqual([]);
  });

  it("keeps the runtime-set allowlist current", () => {
    expect(
      result.staleAllowlist,
      "Remove these RUNTIME_SET_PROPERTIES entries: they are defined in CSS, no longer read without a fallback, or no longer set by client code.",
    ).toEqual([]);
  });

  it.each(METRICS)("matches the %s baseline", (metric) => {
    const { rises, drops } = comparison(metric);
    const details = rises.flatMap((file) => {
      const offenders = result.metrics[metric].filter((offender) => offender.file === file);
      const shown = offenders.slice(0, 60).map(format);
      if (offenders.length > shown.length) shown.push(`  … and ${offenders.length - shown.length} more`);
      return [
        `${file}: ${offenders.length} (baseline ${baseline[metric][file] ?? 0}). Offenders in this file:`,
        ...shown,
      ];
    });
    expect(
      rises,
      [
        `New ${METRIC_RULES[metric]}.`,
        ...details,
        "Fix the new offender. The baseline only goes down; do not raise it to pass.",
      ].join("\n"),
    ).toEqual([]);
    // Update mode has just written the lower counts.
    if (UPDATE_BASELINE) return;
    expect(
      drops,
      [
        `Style guardrail "${metric}" is below its baseline, so the spare allowance would let new offenders in:`,
        ...drops.map((drop) => `  ${drop}`),
        `Lock in the improvement (this only ever lowers counts): ${UPDATE_COMMAND}`,
      ].join("\n"),
    ).toEqual([]);
  });
});

describe("style guardrail detectors", () => {
  const declaration = (text: string, selector = ".component") => {
    let found: Declaration | undefined;
    postcss.parse(`${selector} { ${text} }`).walkDecls((node) => {
      found = node;
    });
    return found!;
  };

  it("recognizes color literals but not token-derived colors or masks", () => {
    for (const literal of ["color: #fff", "box-shadow: 0 1px 2px rgb(0 0 0 / 20%)", "background: oklch(0.5 0.1 250)", "border-color: white", "--series: #123456"]) {
      expect(hasColorLiteral(declaration(literal)), literal).toBe(true);
    }
    for (const mixed of ["color: var(--x, #fff)", "background: oklch(var(--l) 0.1 var(--h))", "border: 1px solid var(--border, black)"]) {
      expect(hasColorLiteral(declaration(mixed)), mixed).toBe(true);
    }
    for (const token of ["color: var(--red-accent)", "border-color: var(--usage-white)", "color: var(--foreground)", "background: oklch(var(--l) var(--c) var(--h) / 0.1)", "mask: radial-gradient(#000, transparent)", "background: color-mix(in oklch, var(--success) 12%, transparent)", "border: 1px solid currentColor", "font-family: Inter"]) {
      expect(hasColorLiteral(declaration(token)), token).toBe(false);
    }
  });

  it("allows the layer, radius and media vocabulary and flags literals", () => {
    expect(isZIndexLiteral("calc(var(--z-dialog) + 1)")).toBe(false);
    expect(isZIndexLiteral("0")).toBe(false);
    expect(isZIndexLiteral("-2")).toBe(false);
    expect(isZIndexLiteral("5")).toBe(true);
    expect(isBorderRadiusLiteral(declaration("border-radius: var(--radius-lg) var(--radius-lg) 0 0"))).toBe(false);
    expect(isBorderRadiusLiteral(declaration("border-radius: 999px"))).toBe(false);
    expect(isBorderRadiusLiteral(declaration("border-radius: 6px"))).toBe(true);
    expect(isAllowedMediaQuery("(max-width: 819px), (pointer: coarse)")).toBe(true);
    expect(isAllowedMediaQuery("(min-width:820px) and (hover: hover)")).toBe(true);
    expect(isAllowedMediaQuery("(max-width: 519px)")).toBe(true);
    expect(isAllowedMediaQuery("(max-width: 760px)")).toBe(false);
  });

  it("flags literals mixed with tokens in font sizes and weights", () => {
    for (const literal of [
      "font-size: clamp(11px, 2vw, var(--text-ui))",
      "font-size: max(var(--text-meta), 11px)",
      "font-size: small",
      "font-size: 0.9em",
      "font: 11px var(--font-mono)",
      "font: 600 11.5px/1.5 var(--font-mono)",
    ]) {
      expect(isFontSizeLiteral(declaration(literal)), literal).toBe(true);
    }
    for (const token of [
      "font-size: var(--text-ui)",
      "font-size: calc(var(--text-ui) * 1.1)",
      "font-size: inherit",
      "font: var(--weight-medium) var(--text-meta) / 1.4 var(--font-mono)",
    ]) {
      expect(isFontSizeLiteral(declaration(token)), token).toBe(false);
    }
    // Markdown sizes relative to its container, but only markdown itself.
    expect(isFontSizeLiteral(declaration("font-size: 0.9em", ".markdown code"))).toBe(false);
    expect(isFontSizeLiteral(declaration("font-size: 0.9em", ".markdown-card"))).toBe(true);
    for (const literal of ["max(var(--weight-medium), 650)", "calc(var(--weight-medium) + 50)", "bold", "600"]) {
      expect(isFontWeightLiteral(literal), literal).toBe(true);
    }
    for (const token of ["var(--weight-semibold)", "inherit"]) {
      expect(isFontWeightLiteral(token), token).toBe(false);
    }
  });

  it("inspects var() fallbacks, which render when the reference does not resolve", () => {
    for (const literal of [
      "font-size: var(--x-undefined, 123px)",
      "font-size: var(--text-ui, var(--x, 13px))",
      "font: var(--x, 12px) var(--font-mono)",
      "border-radius: var(--x, 23px)",
      "border-radius: calc(var(--radius-ctl, 8px) - 2px)",
    ]) {
      const declared = declaration(literal);
      const flagged = declared.prop.includes("radius") ? isBorderRadiusLiteral(declared) : isFontSizeLiteral(declared);
      expect(flagged, literal).toBe(true);
    }
    expect(isFontWeightLiteral("var(--x, 650)")).toBe(true);
    expect(isZIndexLiteral("var(--z-dialog, 80)")).toBe(true);
    expect(hasColorLiteral(declaration("background: oklch(var(--l, 0.5) var(--c) var(--h))"))).toBe(true);
    // A fallback that is itself a token is fine.
    expect(isFontSizeLiteral(declaration("font-size: var(--x, var(--text-ui))"))).toBe(false);
    expect(isBorderRadiusLiteral(declaration("border-radius: var(--x, var(--radius-card))"))).toBe(false);
  });

  it("flags literals mixed with tokens in radii and z-indexes", () => {
    for (const literal of [
      "border-radius: var(--radius-ctl) 100px",
      "border-radius: min(var(--radius-card), 7px)",
      "border-radius: var(--radius-lg) / 4px",
      "border-top-left-radius: 6px",
    ]) {
      expect(isBorderRadiusLiteral(declaration(literal)), literal).toBe(true);
    }
    for (const token of [
      "border-radius: var(--radius-lg) var(--radius-lg) 0 0",
      "border-radius: calc(var(--radius-ctl) - 2px)",
      "border-radius: calc(var(--radius-card) + 1.5px)",
      "border-radius: 50%",
    ]) {
      expect(isBorderRadiusLiteral(declaration(token)), token).toBe(false);
    }
    for (const literal of ["max(var(--z-dialog), 90)", "calc(var(--z-dialog) + var(--offset))", "var(--offset)", "calc(var(--z-dialog) * 2)"]) {
      expect(isZIndexLiteral(literal), literal).toBe(true);
    }
    expect(isZIndexLiteral("calc( var(--z-dialog) - 1 )")).toBe(false);
  });

  it("finds palette colors, pixel text sizes and style hexes in TSX", () => {
    const source = [
      '<div className="hover:bg-red-500 text-white/80 text-[13px] md:text-[11.5px]" />',
      '<span className="bg-background text-muted-foreground border-border-soft" />',
      '<i style={{ color: "#fff", "--x": `${1}px` }} />',
      '<b style = {{ background: "#123" }} />',
      '<em style\n  ={\n    { borderColor: "#abcdef" }} data-style={{ color: "#999" }} />',
    ].join("\n");
    expect([...source.matchAll(TAILWIND_PALETTE)].map((match) => match[0])).toEqual(["hover:bg-red-500", "text-white/80"]);
    expect([...source.matchAll(TAILWIND_ARBITRARY_TEXT_SIZE)].map((match) => match[0])).toEqual(["text-[13px]", "md:text-[11.5px]"]);
    expect(styleExpressions(source).flatMap((expression) => [...expression.text.matchAll(HEX_COLOR)].map((match) => match[0]))).toEqual(["#fff", "#123", "#abcdef"]);
  });
});
