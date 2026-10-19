// Text inputs follow the density switch: under a coarse pointer they are at
// least 16px (`--text-input`), so iOS does not zoom the page on focus. A rule
// that sizes a text input either uses `--text-input` or is overridden with it
// in a touch-density media block.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const CLIENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/** The composer keeps its owner-approved 14.5px (a reference surface). */
const EXEMPT_SELECTORS = new Set([".composer textarea"]);

function cssFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    // The vendored UI kit has its own verification.
    if (target === path.join(CLIENT_DIRECTORY, "workbench")) continue;
    if (entry.isDirectory()) files.push(...cssFiles(target));
    else if (target.endsWith(".css")) files.push(target);
  }
  return files.sort();
}

const TEXT_INPUT = /(?:^|[^\w-])(?:input|textarea)(?![\w-])|[\w]-input(?![\w-])/u;
const NOT_TEXT = /::|\[type=["']?(?:checkbox|radio|range|file|color)/u;

function isTouchMedia(rule: Rule): boolean {
  for (let node = rule.parent; node; node = node.parent) {
    if (node.type === "atrule" && (node as AtRule).name === "media") {
      return (node as AtRule).params.replace(/\s+/gu, "").includes("(pointer:coarse)");
    }
  }
  return false;
}

/** The size a rule gives its text inputs, or nothing when it inherits. */
function fontSize(rule: Rule): string | undefined {
  let size: string | undefined;
  rule.walkDecls(/^font(?:-size)?$/u, (declaration) => {
    size = declaration.value.trim();
  });
  return size === "inherit" ? undefined : size;
}

describe("text input sizes under touch density", () => {
  it("are 16px under the density switch", () => {
    const sized = new Map<string, string>();
    const touchSized = new Set<string>();
    for (const file of cssFiles(CLIENT_DIRECTORY)) {
      const relative = path.relative(CLIENT_DIRECTORY, file).split(path.sep).join("/");
      postcss.parse(readFileSync(file, "utf8")).walkRules((rule) => {
        const size = fontSize(rule);
        if (!size) return;
        for (const raw of rule.selectors) {
          const selector = raw.replace(/\s+/gu, " ").trim();
          if (!TEXT_INPUT.test(selector) || NOT_TEXT.test(selector)) continue;
          if (EXEMPT_SELECTORS.has(selector)) continue;
          if (isTouchMedia(rule)) {
            if (size.includes("var(--text-input)")) touchSized.add(selector);
          } else if (!size.includes("var(--text-input)")) {
            sized.set(selector, `${relative}: ${selector} { font-size: ${size} }`);
          }
        }
      });
    }
    const offenders = [...sized]
      .filter(([selector]) => !touchSized.has(selector))
      .map(([, description]) => description);
    expect(offenders).toEqual([]);
  });
});
