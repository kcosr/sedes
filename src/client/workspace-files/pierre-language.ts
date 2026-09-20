import type { SupportedLanguages } from "@pierre/diffs";

const LANGUAGES_BY_EXTENSION: Readonly<Record<string, SupportedLanguages>> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  patch: "diff",
  rb: "ruby",
  rs: "rust",
  sh: "shellscript",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
};

const LANGUAGES_BY_FILENAME: Readonly<Record<string, SupportedLanguages>> = {
  Dockerfile: "docker",
  Makefile: "make",
};

/**
 * Map a workspace/path basename to the curated Shiki language catalog.
 * Unknown extensions fall back to plain `text` so Pierre never attempts to
 * load an unbundled grammar.
 */
export function boundedPierreLanguage(path: string): SupportedLanguages {
  const filename = path.split("/").at(-1) ?? path;
  const exact = LANGUAGES_BY_FILENAME[filename];
  if (exact) return exact;
  const extension = filename.includes(".")
    ? filename.split(".").at(-1)?.toLowerCase()
    : undefined;
  return (extension && LANGUAGES_BY_EXTENSION[extension]) || "text";
}
