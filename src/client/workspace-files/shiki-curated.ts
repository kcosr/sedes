/**
 * Browser-only curated Shiki surface shared by @pierre/diffs and Markdown.
 *
 * Pierre imports the full `shiki` bundle to discover language loaders, which
 * makes Vite emit every bundled grammar and theme even when the application
 * never requests them. Keep this export surface deliberately narrow and keep
 * its language catalog aligned with `boundedPierreLanguage`.
 */
import {
  createBundledHighlighter,
  createCssVariablesTheme,
  createSingletonShorthands,
  getTokenStyleObject,
  stringifyTokenStyle,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

export const bundledLanguages = {
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  docker: () => import("@shikijs/langs/docker"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  make: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  yaml: () => import("@shikijs/langs/yaml"),
} as const;

const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: {},
  engine: createJavaScriptRegexEngine,
});

const singleton = createSingletonShorthands(createHighlighter);
const codeToHtml = singleton.codeToHtml;
const codeToTokens = singleton.codeToTokens;

export {
  codeToHtml,
  codeToTokens,
  createCssVariablesTheme,
  createHighlighter,
  createJavaScriptRegexEngine,
  createOnigurumaEngine,
  getTokenStyleObject,
  stringifyTokenStyle,
};
