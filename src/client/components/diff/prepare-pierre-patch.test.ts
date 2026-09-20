import { describe, expect, it } from "vitest";
import {
  preparePierrePatch,
  synthesizeFileHeaders,
  synthesizeWholeFileWritePatch,
} from "./prepare-pierre-patch.js";

describe("preparePierrePatch", () => {
  it("accepts a Pi-style same-path unified patch", () => {
    const result = preparePierrePatch({
      kind: "unified_patch",
      path: "src/a.ts",
      text: "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileDiff.lang).toBe("typescript");
    expect(result.fileDiff.hunks).toHaveLength(1);
    expect(result.fileDiff.additionLines.join("")).toContain("new");
    expect(result.fileDiff.deletionLines.join("")).toContain("old");
  });

  it("synthesizes headers for bare hunks using the known path", () => {
    const result = preparePierrePatch({
      kind: "unified_patch",
      path: "src/old.ts",
      text: "@@ -1 +1 @@\n-old\n+new",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileDiff.lang).toBe("typescript");
    expect(result.fileDiff.hunks.length).toBeGreaterThan(0);
  });

  it("uses destinationPath on the +++ side for moves", () => {
    const synthesized = synthesizeFileHeaders(
      "@@ -1 +1 @@\n-old\n+new",
      "src/old.ts",
      "src/new.ts",
    );
    expect(synthesized).toBe(
      "--- src/old.ts\n+++ src/new.ts\n@@ -1 +1 @@\n-old\n+new",
    );
    const result = preparePierrePatch({
      kind: "unified_patch",
      path: "src/old.ts",
      destinationPath: "src/new.ts",
      text: "@@ -1 +1 @@\n-old\n+new",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileDiff.lang).toBe("typescript");
  });

  it("rejects paths that contain control characters", () => {
    expect(
      synthesizeFileHeaders("@@ -1 +1 @@\n-old\n+new", "src/evil\n.ts"),
    ).toBeUndefined();
    expect(
      synthesizeFileHeaders("@@ -1 +1 @@\n-old\n+new", "src/evil\t.ts"),
    ).toBeUndefined();
    const result = preparePierrePatch({
      kind: "unified_patch",
      path: "src/evil\n.ts",
      text: "@@ -1 +1 @@\n-old\n+new",
    });
    expect(result).toEqual({ ok: false, reason: "file_count" });
  });

  it("rejects Codex fragments and multi-file patches", () => {
    expect(
      preparePierrePatch({
        kind: "unified_patch",
        path: "src/x.ts",
        text: "+const live = true;",
      }).ok,
    ).toBe(false);
    expect(
      preparePierrePatch({
        kind: "unified_patch",
        path: "src/x.ts",
        text: "+++ b/src/new.ts\n+new",
      }).ok,
    ).toBe(false);
    expect(
      preparePierrePatch({
        kind: "unified_patch",
        path: "a.ts",
        text:
          "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+A\n--- b.ts\n+++ b.ts\n@@ -1 +1 @@\n-b\n+B",
      }).ok,
    ).toBe(false);
  });

  it("accepts truncated patches that still have headers and a hunk", () => {
    const result = preparePierrePatch({
      kind: "unified_patch",
      path: "src/x.ts",
      text: "--- src/x.ts\n+++ src/x.ts\n@@ -1,5 +1,5 @@\n context\n-cut off mid",
    });
    expect(result.ok).toBe(true);
  });

  it("forces curated language fallback for uncurated extensions", () => {
    const result = preparePierrePatch({
      kind: "unified_patch",
      path: "infra/main.tf",
      text: "--- infra/main.tf\n+++ infra/main.tf\n@@ -1 +1 @@\n-old\n+new",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileDiff.lang).toBe("text");
  });

  it("constructs and strictly parses a truthful new-file patch in memory", () => {
    const content =
      "+literal plus\n-literal minus\n@@ literal hunk\n雪 = 'π';\n";
    const synthesized = synthesizeWholeFileWritePatch(content, "src/新しい.ts");
    expect(synthesized).toEqual({
      patch: [
        "--- /dev/null",
        "+++ src/新しい.ts",
        "@@ -0,0 +1,4 @@",
        "++literal plus",
        "+-literal minus",
        "+@@ literal hunk",
        "+雪 = 'π';",
        "",
      ].join("\n"),
      additionCount: 4,
      emptyFile: false,
    });

    const result = preparePierrePatch({
      kind: "whole_file_write",
      content,
      path: "src/新しい.ts",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emptyFile).toBe(false);
    expect(result.fileDiff).toMatchObject({
      name: "src/新しい.ts",
      type: "new",
      lang: "typescript",
      deletionLines: [],
    });
    expect(result.fileDiff.additionLines).toEqual([
      "+literal plus\n",
      "-literal minus\n",
      "@@ literal hunk\n",
      "雪 = 'π';\n",
    ]);
    expect(result.fileDiff.hunks[0]).toMatchObject({
      deletionStart: 0,
      deletionCount: 0,
      additionStart: 1,
      additionCount: 4,
    });
  });

  it("preserves CRLF and distinguishes a missing final newline", () => {
    const crlf = preparePierrePatch({
      kind: "whole_file_write",
      content: "first\r\nsecond\r\n",
      path: "notes.md",
    });
    expect(crlf.ok).toBe(true);
    if (!crlf.ok) return;
    expect(crlf.fileDiff.additionLines).toEqual(["first\r\n", "second\r\n"]);
    expect(crlf.fileDiff.hunks[0]!.noEOFCRAdditions).toBe(false);

    const noFinalNewline = synthesizeWholeFileWritePatch(
      "first\r\nsecond",
      "notes.md",
    );
    expect(noFinalNewline?.patch).toBe(
      "--- /dev/null\n+++ notes.md\n@@ -0,0 +1,2 @@\n+first\r\n+second\n\\ No newline at end of file\n",
    );
    const parsed = preparePierrePatch({
      kind: "whole_file_write",
      content: "first\r\nsecond",
      path: "notes.md",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fileDiff.additionLines).toEqual(["first\r\n", "second"]);
    expect(parsed.fileDiff.hunks[0]!.noEOFCRAdditions).toBe(true);
  });

  it("represents an explicit empty file without inventing an added line", () => {
    expect(synthesizeWholeFileWritePatch("", "empty.txt")).toEqual({
      patch: "--- /dev/null\n+++ empty.txt\n@@ -0,0 +1,0 @@\n",
      additionCount: 0,
      emptyFile: true,
    });
    const result = preparePierrePatch({
      kind: "whole_file_write",
      content: "",
      path: "empty.txt",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emptyFile).toBe(true);
    expect(result.fileDiff.additionLines).toEqual([]);
    expect(result.fileDiff.deletionLines).toEqual([]);
    expect(result.fileDiff.hunks[0]).toMatchObject({
      additionCount: 0,
      deletionCount: 0,
    });
  });

  it.each([
    "",
    "/dev/null",
    " src/new.ts",
    "src/new.ts ",
    "src/evil\0.ts",
    "src/evil\n.ts",
    "src/evil\r.ts",
    "src/evil\t.ts",
    "src/evil\u007f.ts",
  ])("rejects an unsafe new-file header path %j", (path) => {
    expect(synthesizeWholeFileWritePatch("content", path)).toBeUndefined();
    expect(
      preparePierrePatch({
        kind: "whole_file_write",
        content: "content",
        path,
      }),
    ).toEqual({ ok: false, reason: "unsafe_path" });
  });
});
