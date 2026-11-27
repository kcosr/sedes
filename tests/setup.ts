import "@testing-library/jest-dom/vitest";

// jsdom has no layout engine. Return its empty geometry for DOM selections so
// contenteditable scrolling follows the same path as other off-screen elements.
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects ??= () => document.documentElement.getClientRects();
  Range.prototype.getBoundingClientRect ??= () => document.documentElement.getBoundingClientRect();
}
if (typeof document !== "undefined") {
  document.elementFromPoint ??= () => null;
}
