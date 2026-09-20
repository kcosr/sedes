import { describe, expect, it } from "vitest";
import viteConfig from "../../../vite.config.js";
import { pierreThemes } from "./pierre-themes-curated.js";
import { bundledLanguages } from "./shiki-curated.js";

const EXPECTED_LANGUAGES = [
  "c",
  "cpp",
  "css",
  "diff",
  "docker",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "jsx",
  "make",
  "markdown",
  "python",
  "ruby",
  "rust",
  "shellscript",
  "sql",
  "tsx",
  "typescript",
  "yaml",
] as const;

describe("curated Pierre highlighting bundle", () => {
  it("keeps the emitted grammar and theme catalogs closed", () => {
    expect(Object.keys(bundledLanguages).sort()).toEqual(EXPECTED_LANGUAGES);
    expect(pierreThemes.getThemes().map(({ name }) => name)).toEqual([
      "pierre-dark",
      "pierre-light",
    ]);
  });

  it("aliases only Pierre's exact Shiki and theme imports", () => {
    const aliases = (viteConfig.resolve?.alias ?? []) as readonly {
      readonly find: string | RegExp;
      readonly replacement: string;
    }[];
    expect(aliases.some(({ find }) => String(find) === String(/^shiki$/))).toBe(true);
    expect(
      aliases.some(({ find }) => String(find) === String(/^shiki\/wasm$/)),
    ).toBe(true);
    expect(
      aliases.some(
        ({ find }) => String(find) === String(/^@pierre\/theming\/themes$/),
      ),
    ).toBe(true);
  });
});
