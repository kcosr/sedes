// Touch density in client CSS. Text inputs follow the density switch: under
// a coarse pointer they are at least 16px (`--text-input`), so iOS does not
// zoom the page on focus. A rule that sizes a text input either uses
// `--text-input` or is overridden with it in a touch-density media block.
// Small controls that keep their visual size take a 44px hit area there.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const CLIENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DENSITY = "(max-width:819px),(pointer:coarse)";

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
  let node: postcss.Node | undefined = rule.parent;
  for (; node; node = node.parent) {
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

/** Declarations by `media|selector|property`, media without whitespace. */
function declarations(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of cssFiles(CLIENT_DIRECTORY)) {
    postcss.parse(readFileSync(file, "utf8")).walkRules((rule) => {
      const parent = rule.parent;
      const media =
        parent?.type === "atrule" && (parent as AtRule).name === "media"
          ? (parent as AtRule).params.replace(/\s+/gu, "")
          : "";
      rule.walkDecls((declaration) => {
        for (const selector of rule.selectors) {
          found.set(
            `${media}|${selector.replace(/\s+/gu, " ").trim()}|${declaration.prop}`,
            declaration.value.replace(/\s+/gu, " "),
          );
        }
      });
    });
  }
  return found;
}

describe("touch targets under touch density", () => {
  const found = declarations();
  const touch = (selector: string, property: string) =>
    found.get(`${DENSITY}|${selector}|${property}`);
  const HIT_AREA = "calc((100% - var(--control-touch)) / 2)";

  it("fills the Tasks and Workpads search rows with Close search", () => {
    for (const row of [".tasks-search", ".workpads-search"]) {
      expect(touch(`${row} > button`, "width")).toBe("var(--control-touch)");
      expect(touch(`${row} > button`, "height")).toBe("var(--control-touch)");
    }
  });

  it("gives small controls a centred 44px hit area", () => {
    for (const control of [
      ".tasks-alert-dismiss",
      ".workpads-alert-dismiss",
      ".usage-filter-chips li:not(.usage-chip-clear) button",
    ]) {
      expect(touch(`${control}::before`, "content"), control).toBe('""');
      expect(touch(`${control}::before`, "inset"), control).toBe(HIT_AREA);
    }
    expect(touch(".view-filter-chip::before", "inset-block")).toBe(HIT_AREA);
  });

  it("keeps hit areas off neighbouring controls", () => {
    // Checklist lines sit closer than 44px: the box widens only sideways.
    const checklist = ".workpad-document .markdown-checklist-control::before";
    expect(touch(checklist, "inset-block")).toBe("0");
    expect(touch(checklist, "inset-inline")).toBe(HIT_AREA);
    // Wrapped chip rows leave room for both rows' areas.
    expect(touch(".view-filters", "row-gap")).toBe("calc(var(--control-touch) - var(--control-md))");
    expect(touch(".usage-filter-chips", "row-gap")).toBe("var(--space-4)");
    // An error's message and action stay clear of its dismiss's area.
    for (const alert of [".tasks-alert", ".workpads-alert"]) {
      expect(touch(`${alert} > [data-slot="callout"]`, "padding-right"), alert).toBe(
        "calc(var(--control-touch) + var(--space-1))",
      );
    }
    // A squeezed file tab would leave only its 44px close button to tap.
    expect(touch(".workspace-files-tab", "flex")).toBe("none");
    // Notice actions keep their callouts compact.
    for (const surface of [".terminal-panel-callout", ".workspace-compare-callout", ".question-inbox-panel", ".usage-callout"]) {
      const action = `${surface} [data-slot="callout-action"] button`;
      expect(touch(action, "position"), surface).toBe("relative");
      expect(touch(`${action}::before`, "inset-block"), surface).toBe(HIT_AREA);
    }
  });

  it("lets the voice chevron win near misses over the open-thread overlay", () => {
    const chevron = ".voice-card-target::before";
    expect(touch(chevron, "inset-block")).toBe(HIT_AREA);
    // 44px wide, reaching 16px into the title and 4px (the card gap) right.
    expect(touch(chevron, "inset-inline-start")).toBe(
      "calc(100% - var(--control-touch) + var(--space-1))",
    );
    expect(touch(chevron, "inset-inline-end")).toBe("calc(-1 * var(--space-1))");
  });

  it("sizes the scoped lists' section headings with the density switch", () => {
    expect(found.get("|.list-heading|min-height")).toBe("var(--control-default)");
  });

  it("sizes Files tabs and Changes controls for touch", () => {
    for (const [selector, property, value] of [
      [".workspace-files-tab", "min-height", "var(--control-touch)"],
      [".workspace-files-tab-close", "width", "var(--control-touch)"],
      [".workspace-files-tab-close", "height", "var(--control-touch)"],
      [".workspace-files-root-tab", "min-height", "var(--control-touch)"],
      [".workspace-files-root-switcher > button", "height", "var(--control-touch)"],
      [".workspace-files-editor-toolbar > div > button", "height", "var(--bar-control)"],
      [".workspace-compare-toolbar-button", "min-height", "var(--bar-control)"],
      [".workspace-compare-source-trigger", "min-height", "var(--bar-control)"],
      [".workspace-compare-header-action", "height", "var(--control-touch)"],
      [".workspace-compare-file-navigation button", "height", "var(--control-touch)"],
      [".workspace-compare-navigator-search button", "height", "var(--control-touch)"],
    ] as const) {
      expect(touch(selector, property), `${selector} ${property}`).toBe(value);
    }
  });
});
