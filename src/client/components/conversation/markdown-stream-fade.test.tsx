import type { Element, Root, RootContent } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { rehypeStreamFade } from "./markdown-stream-fade.js";
import {
  MAX_ANIMATED_GRAPHEMES,
  segmentGraphemes,
  type StreamFadeState,
} from "./smooth-streaming-text.js";

function parse(source: string): Root {
  const processor = unified().use(remarkParse).use(remarkRehype);
  return processor.runSync(processor.parse(source));
}

function fadeAll(source: string, opaquePrefix = ""): StreamFadeState {
  const graphemes = segmentGraphemes(source.slice(opaquePrefix.length));
  return {
    source,
    opaquePrefix,
    graphemeCount: segmentGraphemes(source).length,
    animated: graphemes.map((grapheme, index) => ({
      index, grapheme, arrivalMs: 0, fadeDurationMs: 500, startOpacity: 0.08,
    })),
    graphemesPerSecond: 60,
    observedAtMs: 0,
  };
}

function elements(node: Root | RootContent, tagName: string): Element[] {
  return [
    ...(node.type === "element" && node.tagName === tagName ? [node] : []),
    ...("children" in node ? node.children.flatMap((child) => elements(child, tagName)) : []),
  ];
}

function text(node: Root | RootContent): string {
  return node.type === "text" ? node.value
    : "children" in node ? node.children.map(text).join("") : "";
}

describe("rehypeStreamFade code blocks", () => {
  it.each([
    ["fenced", "```js\nconst x = '&amp; <tag> \\*'; 😀é\n```"],
    ["tilde fenced", "~~~text\n<literal> &copy; \\n\n~~~"],
    ["indented fence", "  ```\n    literal\n  ```"],
    ["indented code", "    const x = 1;\n      next();\n"],
    ["nested fences and CRLF", "> - ```js\r\n>   const x = 1;\r\n>     >literal\r\n>   ```"],
    ["nested indented code", "> - item\n>\n>       const x = 1;\n>         next();"],
    ["open fence", "```js\nconst x = 1;"],
    ["open fence with final newline", "```js\nconst x = 1;\n"],
    ["blank lines", "```\n\nalpha\n\nbeta\n\n```"],
  ])("maps %s literally to the correct source graphemes", (_label, source) => {
    const tree = parse(source);
    const code = elements(tree, "code")[0]!;
    const original = text(code);
    const fade = fadeAll(source);
    rehypeStreamFade(fade)()(tree);
    expect(text(code)).toBe(original);
    const spans = elements(code, "span");
    expect(spans.map(text).join("")).toBe(original.replace(/\s/gu, ""));
    for (const span of spans) {
      const index = span.properties["data-stream-index"] as number;
      expect(fade.animated[index]?.grapheme).toBe(text(span));
    }
  });

  it("decorates only fresh code and obeys the shared span bound", () => {
    const opaquePrefix = "```js\nold\n";
    const source = `${opaquePrefix}${"x".repeat(1000)}\n\`\`\``;
    const tree = parse(source);
    rehypeStreamFade(fadeAll(source, opaquePrefix))()(tree);
    const code = elements(tree, "code")[0]!;
    expect(elements(code, "span")).toHaveLength(MAX_ANIMATED_GRAPHEMES);
    expect(code.children[0]).toEqual({ type: "text", value: "old\n" });
    expect(text(code)).toBe(`old\n${"x".repeat(1000)}\n`);
  });

  it("retains exact source indices after CRLF and repeated container markers", () => {
    const source = "> - ```\r\n>   >x\r\n>   >x\r\n>   ```";
    const tree = parse(source);
    const fade = fadeAll(source);
    rehypeStreamFade(fade)()(tree);
    const spans = elements(elements(tree, "code")[0]!, "span");
    const expectedOffsets = [
      source.indexOf(">x"), source.indexOf(">x") + 1,
      source.lastIndexOf(">x"), source.lastIndexOf(">x") + 1,
    ];
    expect(spans.map((span) => span.properties["data-stream-index"])).toEqual(
      expectedOffsets.map((offset) => segmentGraphemes(source.slice(0, offset)).length),
    );
    expect(text(elements(tree, "code")[0]!)).toBe(">x\r\n>x\n");
  });

  it("does not associate the artificial final newline with following source", () => {
    const source = "```\nalpha\n```\n\nafter";
    const tree = parse(source);
    rehypeStreamFade(fadeAll(source))()(tree);
    const code = elements(tree, "code")[0]!;
    expect(code.children.at(-1)).toEqual({ type: "text", value: "\n" });
    expect(elements(code, "span").map(text).join("")).toBe("alpha");
  });

  it("leaves Mermaid source untouched", () => {
    const source = "```mermaid\ngraph TD; A --> B\n```";
    const tree = parse(source);
    const original = structuredClone(tree);
    rehypeStreamFade(fadeAll(source))()(tree);
    expect(tree).toEqual(original);
  });

  it("leaves code opaque when a transform no longer matches its literal source", () => {
    const source = "```\n&amp;\n```";
    const tree = parse(source);
    const code = elements(tree, "code")[0]!;
    code.children = [{ type: "text", value: "&\n" }];
    rehypeStreamFade(fadeAll(source))()(tree);
    expect(code.children).toEqual([{ type: "text", value: "&\n" }]);
  });
});
