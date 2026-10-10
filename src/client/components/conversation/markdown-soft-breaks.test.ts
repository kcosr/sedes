import { describe, expect, it } from "vitest";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkSoftBreaks } from "./markdown-soft-breaks.js";

interface Node { type: string; value?: string; position?: { start: { offset?: number; line?: number; column?: number }; end: { offset?: number } }; children?: Node[] }

function transform(source: string): Node {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkSoftBreaks);
  return processor.runSync(processor.parse(source), source) as unknown as Node;
}
function first(node: Node, type: string): Node | undefined {
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const found = first(child, type);
    if (found) return found;
  }
  return undefined;
}
const inline = (node: Node | undefined) => (node?.children ?? []).map(child => child.type === "text" ? child.value : `<${child.type}>`);

describe("remarkSoftBreaks", () => {
  it("turns a single newline inside a paragraph into a break, and leaves blank-line paragraphs alone", () => {
    const tree = transform("One\nTwo\r\nThree\n\nFour");
    expect(tree.children?.map(child => child.type)).toEqual(["paragraph", "paragraph"]);
    expect(inline(tree.children?.[0])).toEqual(["One", "<break>", "Two", "<break>", "Three"]);
    expect(inline(tree.children?.[1])).toEqual(["Four"]);
  });

  it("gives each fragment its exact source position", () => {
    const source = "Intro\nalpha **bold**\n  beta";
    const tree = transform(source);
    const texts: Node[] = [];
    const collect = (node: Node) => { if (node.type === "text") texts.push(node); node.children?.forEach(collect); };
    collect(tree);
    for (const text of texts) {
      const start = text.position!.start.offset!;
      expect(source.slice(start, text.position!.end.offset)).toBe(text.value);
    }
    const beta = texts.find(text => text.value === "beta")!;
    expect(beta.position!.start).toMatchObject({ line: 3, column: 3 });
  });

  it("splits list items and table-free inline text but never code", () => {
    const tree = transform("- [ ] first\n  continued\n\n```\nkeep\nlines\n```\n\nuse `a` then\nnext");
    expect(inline(first(first(tree, "listItem")!, "paragraph"))).toEqual(["first", "<break>", "continued"]);
    expect(first(tree, "code")?.value).toBe("keep\nlines");
    expect(inline(tree.children?.[2])).toEqual(["use ", "<inlineCode>", " then", "<break>", "next"]);
  });

  it("keeps the whole text position for fragments that do not occur verbatim in the source", () => {
    const source = "a &amp; b\nc";
    const tree = transform(source);
    const paragraph = tree.children?.[0];
    expect(inline(paragraph)).toEqual(["a & b", "<break>", "c"]);
    const decoded = paragraph!.children![0]!;
    expect(decoded.position?.start.offset).toBe(0);
    const c = paragraph!.children![2]!;
    expect(source.slice(c.position!.start.offset, c.position!.end.offset)).toBe("c");
  });
});
