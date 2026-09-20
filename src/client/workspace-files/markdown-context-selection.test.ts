// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { captureMarkdownContextSelection } from "./markdown-context-selection.js";

const OPTIONS = {
  maximumAffixBytes: 12,
  maximumHeadingEntries: 16,
  maximumHeadingBytes: 240,
};

describe("captureMarkdownContextSelection", () => {
  it("captures rendered text, source lines, affixes, and the nearest heading trail", () => {
    const root = markdownRoot(`
      <h1 data-markdown-block data-markdown-heading-level="1" data-markdown-source-start-line="1" data-markdown-source-end-line="1">Guide</h1>
      <h2 data-markdown-block data-markdown-heading-level="2" data-markdown-source-start-line="3" data-markdown-source-end-line="3">Details</h2>
      <p data-markdown-block data-markdown-source-start-line="5" data-markdown-source-end-line="5">Before <strong>bold <a>linked</a></strong> after</p>
    `);
    const bold = root.querySelector("strong")!.firstChild!;
    const linked = root.querySelector("a")!.firstChild!;
    const range = document.createRange();
    range.setStart(bold, 0);
    range.setEnd(linked, 6);

    expect(captureMarkdownContextSelection(root, range, OPTIONS)).toEqual({
      excerpt: "bold linked",
      locator: {
        kind: "text_quote",
        prefix: "Before ",
        suffix: " after",
        headingTrail: ["Guide", "Details"],
        sourceStartLine: 5,
        sourceEndLine: 5,
      },
    });
  });

  it("captures cross-block visible text and the outer source line range", () => {
    const root = markdownRoot(`
      <h1 data-markdown-block data-markdown-heading-level="1" data-markdown-source-start-line="1" data-markdown-source-end-line="1">Guide</h1>
      <p data-markdown-block data-markdown-source-start-line="3" data-markdown-source-end-line="3">Alpha &amp; beta</p>
      <pre data-markdown-block data-markdown-source-start-line="5" data-markdown-source-end-line="7"><code>gamma\nemoji 😀</code></pre>
    `);
    const start = root.querySelector("p")!.firstChild!;
    const end = root.querySelector("code")!.firstChild!;
    const range = document.createRange();
    range.setStart(start, 6);
    range.setEnd(end, 5);

    const captured = captureMarkdownContextSelection(root, range, OPTIONS);
    expect(captured?.excerpt).toContain("& beta");
    expect(captured?.excerpt).toContain("gamma");
    expect(captured?.locator).toMatchObject({
      headingTrail: ["Guide"],
      sourceStartLine: 3,
      sourceEndLine: 7,
    });
  });

  it("bounds quote context by UTF-8 bytes without splitting emoji", () => {
    const root = markdownRoot(
      '<p data-markdown-block data-markdown-source-start-line="2" data-markdown-source-end-line="2">abcdefgh😀SELECTijklmnop😀</p>',
    );
    const text = root.querySelector("p")!.firstChild!;
    const value = text.textContent!;
    const range = document.createRange();
    range.setStart(text, value.indexOf("SELECT"));
    range.setEnd(text, value.indexOf("SELECT") + "SELECT".length);

    const captured = captureMarkdownContextSelection(root, range, {
      ...OPTIONS,
      maximumAffixBytes: 6,
    });
    expect(captured?.locator.prefix).toBe("gh😀");
    expect(captured?.locator.suffix).toBe("ijklmn");
  });

  it("rejects collapsed, whitespace-only, outside, and unpositioned selections", () => {
    const root = markdownRoot(
      '<p data-markdown-block data-markdown-source-start-line="1" data-markdown-source-end-line="1">text   </p><div>outside-ish</div>',
    );
    const text = root.querySelector("p")!.firstChild!;
    const collapsed = document.createRange();
    collapsed.setStart(text, 1);
    collapsed.collapse(true);
    expect(
      captureMarkdownContextSelection(root, collapsed, OPTIONS),
    ).toBeUndefined();

    const whitespace = document.createRange();
    whitespace.setStart(text, 4);
    whitespace.setEnd(text, 7);
    expect(
      captureMarkdownContextSelection(root, whitespace, OPTIONS),
    ).toBeUndefined();

    const unpositioned = root.querySelector("div")!.firstChild!;
    const unpositionedRange = document.createRange();
    unpositionedRange.selectNodeContents(unpositioned);
    expect(
      captureMarkdownContextSelection(root, unpositionedRange, OPTIONS),
    ).toBeUndefined();

    const other = document.createElement("p");
    other.textContent = "other";
    document.body.append(other);
    const outside = document.createRange();
    outside.selectNodeContents(other);
    expect(
      captureMarkdownContextSelection(root, outside, OPTIONS),
    ).toBeUndefined();
    other.remove();
  });

  it("omits source lines when either endpoint has no truthful pair", () => {
    const root = markdownRoot(
      '<p data-markdown-block data-markdown-source-start-line="2" data-markdown-source-end-line="2">first</p><p data-markdown-block>second</p>',
    );
    const range = document.createRange();
    range.setStart(root.firstElementChild!.firstChild!, 0);
    range.setEnd(root.lastElementChild!.firstChild!, 6);
    expect(
      captureMarkdownContextSelection(root, range, OPTIONS)?.locator,
    ).not.toHaveProperty("sourceStartLine");
  });
});

function markdownRoot(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
