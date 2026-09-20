import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./parse-unified-diff.js";

describe("parseUnifiedDiff", () => {
  it("parses a single hunk with line numbers on both sides", () => {
    const patch = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,4 @@ function f()",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " const d = 5;",
    ].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(1);
    const [hunk] = hunks!;
    expect(hunk!.header).toBe("@@ -10,3 +10,4 @@ function f()");
    expect(hunk!.rows).toEqual([
      { kind: "context", oldLine: 10, newLine: 10, text: "const a = 1;" },
      { kind: "del", oldLine: 11, text: "const b = 2;" },
      { kind: "add", newLine: 11, text: "const b = 3;" },
      { kind: "add", newLine: 12, text: "const c = 4;" },
      { kind: "context", oldLine: 12, newLine: 13, text: "const d = 5;" },
    ]);
  });

  it("parses multiple hunks and skips metadata lines", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "index 111..222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "@@ -50 +50 @@ trailing context",
      "-foo",
      "+bar",
    ].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks![0]!.rows).toEqual([
      { kind: "del", oldLine: 1, text: "old" },
      { kind: "add", newLine: 1, text: "new" },
    ]);
    expect(hunks![1]!.header).toBe("@@ -50 +50 @@ trailing context");
    expect(hunks![1]!.rows[0]).toEqual({ kind: "del", oldLine: 50, text: "foo" });
  });

  it("ignores the no-newline marker", () => {
    const patch = ["@@ -1 +1 @@", "-old", "\\ No newline at end of file", "+new"].join(
      "\n",
    );
    const hunks = parseUnifiedDiff(patch);
    expect(hunks![0]!.rows).toHaveLength(2);
  });

  it("accepts a patch truncated mid-hunk", () => {
    const patch = ["@@ -1,3 +1,3 @@", " ctx", "-cut off here"].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks![0]!.rows).toHaveLength(2);
  });

  it("returns undefined for non-patch text", () => {
    expect(parseUnifiedDiff("just some prose\nnot a diff")).toBeUndefined();
    expect(parseUnifiedDiff("")).toBeUndefined();
  });

  it("returns undefined for garbage inside a hunk", () => {
    const patch = ["@@ -1 +1 @@", "?bogus"].join("\n");
    expect(parseUnifiedDiff(patch)).toBeUndefined();
  });

  it("does not produce a phantom row for a trailing newline", () => {
    const patch = "@@ -1 +1 @@\n-old\n+new\n";
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks![0]!.rows).toEqual([
      { kind: "del", oldLine: 1, text: "old" },
      { kind: "add", newLine: 1, text: "new" },
    ]);
  });

  it("normalizes CRLF line endings", () => {
    const patch = "@@ -1 +1 @@\r\n-old\r\n+new\r\n";
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks![0]!.header).toBe("@@ -1 +1 @@");
    expect(hunks![0]!.rows).toEqual([
      { kind: "del", oldLine: 1, text: "old" },
      { kind: "add", newLine: 1, text: "new" },
    ]);
  });

  it("falls back when a second file's diff header arrives mid-hunk", () => {
    const patch = [
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/other.ts b/other.ts",
    ].join("\n");
    expect(parseUnifiedDiff(patch)).toBeUndefined();
  });

  it("keeps rows whose content begins with -- or ++", () => {
    const patch = [
      "@@ -1,3 +1,3 @@",
      " ctx",
      "----",
      "++++",
      "--x;",
      "+++y;",
    ].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks![0]!.rows).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "ctx" },
      { kind: "del", oldLine: 2, text: "---" },
      { kind: "add", newLine: 2, text: "+++" },
      { kind: "del", oldLine: 3, text: "-x;" },
      { kind: "add", newLine: 3, text: "++y;" },
    ]);
  });

  it("tracks line numbers continuously across hunks", () => {
    const patch = [
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "@@ -40,2 +40,2 @@",
      " ctx",
      "-c",
      "+d",
    ].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks![1]!.rows[0]).toEqual({
      kind: "context",
      oldLine: 40,
      newLine: 40,
      text: "ctx",
    });
    expect(hunks![1]!.rows[1]).toEqual({ kind: "del", oldLine: 41, text: "c" });
    expect(hunks![1]!.rows[2]).toEqual({ kind: "add", newLine: 41, text: "d" });
  });
});
