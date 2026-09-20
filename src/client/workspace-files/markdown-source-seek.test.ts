// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { findMarkdownSourceSeekTarget } from "./markdown-source-seek.js";

describe("findMarkdownSourceSeekTarget", () => {
  it("prefers an exact-start, narrow rendered block containing the line", () => {
    const root = document.createElement("div");
    const outer = block("2", "8");
    const earlierNested = block("4", "6");
    const exact = block("5", "5");
    outer.append(earlierNested, exact);
    root.append(outer);

    expect(findMarkdownSourceSeekTarget(root, 5)).toEqual({
      element: exact,
      startLine: 5,
      endLine: 5,
      match: "containing",
    });
  });

  it("chooses the nearest following block for blank source lines", () => {
    const root = document.createElement("div");
    const before = block("2", "3");
    const after = block("8", "9");
    root.append(before, after);

    expect(findMarkdownSourceSeekTarget(root, 6)).toMatchObject({
      element: after,
      startLine: 8,
      match: "following",
    });
  });

  it("falls back to the nearest preceding rendered block at end of file", () => {
    const root = document.createElement("div");
    const first = block("2", "3");
    const last = block("8", "9");
    root.append(first, last);

    expect(findMarkdownSourceSeekTarget(root, 20)).toMatchObject({
      element: last,
      endLine: 9,
      match: "preceding",
    });
  });

  it("ignores malformed metadata and invalid requested lines", () => {
    const root = document.createElement("div");
    root.append(block("nope", "3"), block("8", "4"));

    expect(findMarkdownSourceSeekTarget(root, 0)).toBeUndefined();
    expect(findMarkdownSourceSeekTarget(root, 5)).toBeUndefined();
  });
});

function block(startLine: string, endLine: string): HTMLElement {
  const element = document.createElement("p");
  element.dataset.markdownBlock = "true";
  element.dataset.markdownSourceStartLine = startLine;
  element.dataset.markdownSourceEndLine = endLine;
  return element;
}
