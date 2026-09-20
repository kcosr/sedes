import type { CSSProperties } from "react";
import type { bundledLanguages } from "../../workspace-files/shiki-curated.js";

export type MarkdownSyntaxLanguage = keyof typeof bundledLanguages;

export type MarkdownSyntaxToken = {
  readonly content: string;
  readonly style: CSSProperties;
};

export type MarkdownSyntaxLines = readonly (readonly MarkdownSyntaxToken[])[];

const MAX_HIGHLIGHTED_CODE_UNITS = 100_000;
const MAX_CACHED_HIGHLIGHTS = 128;
const MAX_CACHED_HIGHLIGHT_WEIGHT = 2_000_000;
const CACHED_TOKEN_WEIGHT = 32;

const LANGUAGES_BY_FENCE: Readonly<Record<string, MarkdownSyntaxLanguage>> = {
  bash: "shellscript",
  c: "c",
  "c++": "cpp",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  diff: "diff",
  docker: "docker",
  dockerfile: "docker",
  go: "go",
  golang: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "jsx",
  make: "make",
  makefile: "make",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  patch: "diff",
  py: "python",
  python: "python",
  rb: "ruby",
  rs: "rust",
  ruby: "ruby",
  rust: "rust",
  sh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  xml: "html",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shellscript",
};

type CuratedShikiModule = typeof import("../../workspace-files/shiki-curated.js");
type SyntaxTools = {
  readonly codeToTokens: CuratedShikiModule["codeToTokens"];
  readonly getTokenStyleObject: CuratedShikiModule["getTokenStyleObject"];
  readonly theme: ReturnType<CuratedShikiModule["createCssVariablesTheme"]>;
};

let syntaxToolsPromise: Promise<SyntaxTools> | undefined;
type CachedHighlight = {
  readonly lines: MarkdownSyntaxLines;
  readonly weight: number;
};

const highlightCache = new Map<string, CachedHighlight>();
const pendingHighlights = new Map<
  string,
  Promise<MarkdownSyntaxLines | undefined>
>();
let cachedHighlightWeight = 0;

export function markdownSyntaxLanguage(
  className: string | undefined,
): MarkdownSyntaxLanguage | undefined {
  const languageClass = className
    ?.split(/\s+/u)
    .find((candidate) => candidate.startsWith("language-"));
  if (!languageClass) return undefined;
  return LANGUAGES_BY_FENCE[languageClass.slice("language-".length).toLowerCase()];
}

export function cachedMarkdownHighlight(
  code: string,
  language: MarkdownSyntaxLanguage,
): MarkdownSyntaxLines | undefined {
  if (code.length > MAX_HIGHLIGHTED_CODE_UNITS) return undefined;
  return highlightCache.get(highlightCacheKey(code, language))?.lines;
}

export function highlightMarkdownCode(
  code: string,
  language: MarkdownSyntaxLanguage,
): Promise<MarkdownSyntaxLines | undefined> {
  if (code.length > MAX_HIGHLIGHTED_CODE_UNITS) {
    return Promise.resolve(undefined);
  }
  const cached = cachedMarkdownHighlight(code, language);
  if (cached) {
    touchMarkdownHighlight(highlightCacheKey(code, language));
    return Promise.resolve(cached);
  }

  const key = highlightCacheKey(code, language);
  const pending = pendingHighlights.get(key);
  if (pending) return pending;

  const highlighting = loadSyntaxTools()
    .then(async (tools) => {
      const result = await tools.codeToTokens(code, {
        lang: language,
        theme: tools.theme,
        tokenizeMaxLineLength: 10_000,
        tokenizeTimeLimit: 100,
      });
      const lines = result.tokens.map((line) =>
        line.map((token) => ({
          content: token.content,
          style: reactTokenStyle(
            token.htmlStyle ?? tools.getTokenStyleObject(token),
          ),
        })),
      );
      cacheMarkdownHighlight(key, code, lines);
      return lines;
    })
    .finally(() => pendingHighlights.delete(key));
  pendingHighlights.set(key, highlighting);
  return highlighting;
}

function touchMarkdownHighlight(key: string): void {
  const cached = highlightCache.get(key);
  if (!cached) return;
  highlightCache.delete(key);
  highlightCache.set(key, cached);
}

function highlightCacheKey(
  code: string,
  language: MarkdownSyntaxLanguage,
): string {
  return `${language}\0${code}`;
}

function cacheMarkdownHighlight(
  key: string,
  code: string,
  lines: MarkdownSyntaxLines,
): void {
  const tokenCount = lines.reduce((count, line) => count + line.length, 0);
  const weight = code.length + tokenCount * CACHED_TOKEN_WEIGHT;
  if (weight > MAX_CACHED_HIGHLIGHT_WEIGHT) return;

  const previous = highlightCache.get(key);
  if (previous) cachedHighlightWeight -= previous.weight;
  highlightCache.delete(key);
  highlightCache.set(key, { lines, weight });
  cachedHighlightWeight += weight;

  while (
    highlightCache.size > MAX_CACHED_HIGHLIGHTS ||
    cachedHighlightWeight > MAX_CACHED_HIGHLIGHT_WEIGHT
  ) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = highlightCache.get(oldestKey);
    highlightCache.delete(oldestKey);
    if (oldest) cachedHighlightWeight -= oldest.weight;
  }
}

function loadSyntaxTools() {
  if (syntaxToolsPromise) return syntaxToolsPromise;
  const loading = import("../../workspace-files/shiki-curated.js").then(
    (shiki) => ({
      codeToTokens: shiki.codeToTokens,
      getTokenStyleObject: shiki.getTokenStyleObject,
      theme: shiki.createCssVariablesTheme({
        fontStyle: true,
        name: "sedes-markdown-code",
        variablePrefix: "--syntax-",
      }),
    }),
  );
  const retryable = loading.catch((error: unknown) => {
    if (syntaxToolsPromise === retryable) syntaxToolsPromise = undefined;
    throw error;
  });
  syntaxToolsPromise = retryable;
  return syntaxToolsPromise;
}

function reactTokenStyle(style: Record<string, string>): CSSProperties {
  return {
    color: style.color,
    backgroundColor: style["background-color"],
    fontStyle: style["font-style"] as CSSProperties["fontStyle"],
    fontWeight: style["font-weight"] as CSSProperties["fontWeight"],
    textDecoration: style["text-decoration"],
  };
}
