import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { workspaceCompareNewSideLine } from "./workspace-compare-reading-line.js";

// Old file: lines 1–12 ("o1".."o12"). New file: "n4" and "n5" are inserted
// after old line 3, old lines 7–8 are deleted, and old line 11 is replaced.
const patch = [
  "diff --git a/f.txt b/f.txt",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -3,0 +4,2 @@",
  "+n4",
  "+n5",
  "@@ -7,2 +8,0 @@",
  "-o7",
  "-o8",
  "@@ -10,3 +10,3 @@",
  " o10",
  "-o11",
  "+n11",
  " o12",
  "",
].join("\n");
const fileDiff = parsePatchFiles(patch, "reading-line")[0]!.files[0]!;

describe("workspaceCompareNewSideLine", () => {
  it("passes new-side lines through", () => {
    expect(workspaceCompareNewSideLine(fileDiff, 5, "additions")).toBe(5);
    expect(workspaceCompareNewSideLine(undefined, 7, undefined)).toBe(7);
  });

  it("maps unchanged old lines across inserted and deleted ranges", () => {
    expect(workspaceCompareNewSideLine(fileDiff, 1, "deletions")).toBe(1);
    expect(workspaceCompareNewSideLine(fileDiff, 3, "deletions")).toBe(3);
    expect(workspaceCompareNewSideLine(fileDiff, 4, "deletions")).toBe(6);
    expect(workspaceCompareNewSideLine(fileDiff, 6, "deletions")).toBe(8);
    expect(workspaceCompareNewSideLine(fileDiff, 9, "deletions")).toBe(9);
    expect(workspaceCompareNewSideLine(fileDiff, 10, "deletions")).toBe(10);
    expect(workspaceCompareNewSideLine(fileDiff, 12, "deletions")).toBe(12);
    expect(workspaceCompareNewSideLine(fileDiff, 40, "deletions")).toBe(40);
  });

  it("maps deleted lines to the nearest new line", () => {
    // Purely deleted lines land on the line before the deletion (old line 6).
    expect(workspaceCompareNewSideLine(fileDiff, 7, "deletions")).toBe(8);
    expect(workspaceCompareNewSideLine(fileDiff, 8, "deletions")).toBe(8);
    // A replaced line lands on its replacement.
    expect(workspaceCompareNewSideLine(fileDiff, 11, "deletions")).toBe(11);
  });

  it("keeps a deletion at the top of the file inside the file", () => {
    const head = parsePatchFiles(
      ["--- a/f.txt", "+++ b/f.txt", "@@ -1,2 +0,0 @@", "-o1", "-o2", ""].join("\n"),
      "reading-line-head",
    )[0]!.files[0]!;
    expect(workspaceCompareNewSideLine(head, 1, "deletions")).toBe(1);
    expect(workspaceCompareNewSideLine(head, 3, "deletions")).toBe(1);
  });

  it("falls back when an old-side line can't be mapped", () => {
    expect(workspaceCompareNewSideLine(undefined, 4, "deletions")).toBeUndefined();
    expect(workspaceCompareNewSideLine(fileDiff, 0, "additions")).toBeUndefined();
  });
});
