import { describe, expect, it } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import {
  captureFileLineSelection,
  captureUnifiedDiffLineSelection,
} from "./pierre-selection.js";

describe("captureFileLineSelection", () => {
  it("preserves original line endings and normalizes reverse drags", () => {
    expect(
      captureFileLineSelection("one\r\ntwo\rthree\nfour", {
        start: 3,
        end: 2,
      }),
    ).toEqual({
      ok: true,
      value: { excerpt: "two\rthree\n", startLine: 2, endLine: 3 },
    });
  });

  it("preserves a selected final line without inventing a newline", () => {
    expect(captureFileLineSelection("one\ntwo", { start: 2, end: 2 })).toEqual({
      ok: true,
      value: { excerpt: "two", startLine: 2, endLine: 2 },
    });
  });

  it("rejects empty, side-bearing, and out-of-bounds selections", () => {
    expect(captureFileLineSelection("one\n", { start: 2, end: 2 })).toEqual({
      ok: false,
      reason: "empty_excerpt",
    });
    expect(
      captureFileLineSelection("one", {
        start: 1,
        end: 1,
        side: "additions",
      }),
    ).toEqual({ ok: false, reason: "invalid_range" });
    expect(captureFileLineSelection("one", { start: 2, end: 2 })).toEqual({
      ok: false,
      reason: "invalid_range",
    });
  });

  it("rejects a selection beyond the context excerpt byte limit", () => {
    expect(
      captureFileLineSelection("x".repeat(16 * 1_024 + 1), {
        start: 1,
        end: 1,
      }),
    ).toEqual({ ok: false, reason: "excerpt_too_large" });
  });
});

describe("captureUnifiedDiffLineSelection", () => {
  const diff = parseDiff(
    [
      "--- a.ts",
      "+++ a.ts",
      "@@ -1,4 +1,4 @@",
      " context",
      "-old one",
      "-old two",
      "+new one",
      "+new two",
      " tail",
    ].join("\n"),
  );

  it("captures same-side rows in unified visual order", () => {
    expect(
      captureUnifiedDiffLineSelection(diff, {
        start: 2,
        end: 3,
        side: "deletions",
      }),
    ).toEqual({
      ok: true,
      value: {
        excerpt: "old one\nold two\n",
        start: { side: "old", line: 2 },
        end: { side: "old", line: 3 },
      },
    });
  });

  it("normalizes same-side reverse drags for the strict locator", () => {
    expect(
      captureUnifiedDiffLineSelection(diff, {
        start: 3,
        end: 2,
        side: "deletions",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        excerpt: "old one\nold two\n",
        start: { side: "old", line: 2 },
        end: { side: "old", line: 3 },
      },
    });
  });

  it("preserves cross-side drag endpoints while capturing top-to-bottom", () => {
    expect(
      captureUnifiedDiffLineSelection(diff, {
        start: 3,
        end: 2,
        side: "additions",
        endSide: "deletions",
      }),
    ).toEqual({
      ok: true,
      value: {
        excerpt: "old one\nold two\nnew one\nnew two\n",
        start: { side: "new", line: 3 },
        end: { side: "old", line: 2 },
      },
    });
  });

  it("resolves either side of a context row", () => {
    expect(
      captureUnifiedDiffLineSelection(diff, {
        start: 1,
        end: 4,
        side: "deletions",
        endSide: "additions",
      }),
    ).toMatchObject({
      ok: true,
      value: { excerpt: "context\nold one\nold two\nnew one\nnew two\ntail" },
    });
  });

  it("rejects unresolved and cross-hunk ranges", () => {
    expect(
      captureUnifiedDiffLineSelection(diff, {
        start: 99,
        end: 99,
        side: "additions",
      }),
    ).toEqual({ ok: false, reason: "unresolved_diff_range" });

    const twoHunks = parseDiff(
      [
        "--- a.ts",
        "+++ a.ts",
        "@@ -1 +1 @@",
        "-one",
        "+ONE",
        "@@ -10 +10 @@",
        "-ten",
        "+TEN",
      ].join("\n"),
    );
    expect(
      captureUnifiedDiffLineSelection(twoHunks, {
        start: 1,
        end: 10,
        side: "additions",
      }),
    ).toEqual({ ok: false, reason: "cross_hunk_range" });
  });
});

function parseDiff(text: string): FileDiffMetadata {
  return parsePatchFiles(text)[0]!.files[0]!;
}
