import { describe, expect, it } from "vitest";
import type { FileChangeItem } from "../../shared/index.js";
import {
  countWholeFileLines,
  isPierrePatchCandidate,
  selectPierreFileChangeCandidate,
} from "./pierre-patch-candidate.js";

describe("isPierrePatchCandidate", () => {
  it("accepts hunk headers", () => {
    expect(isPierrePatchCandidate("@@ -1 +1 @@\n-old\n+new")).toBe(true);
    expect(
      isPierrePatchCandidate(
        "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new",
      ),
    ).toBe(true);
  });

  it("rejects header-only and bare +/- fragments without loading Pierre", () => {
    expect(isPierrePatchCandidate("+++ b/src/new.ts\n+new")).toBe(false);
    expect(isPierrePatchCandidate("+const live = true;")).toBe(false);
    expect(isPierrePatchCandidate("garbage\n?not a hunk")).toBe(false);
    expect(isPierrePatchCandidate("-  1 Hello\n+  1 World")).toBe(false);
  });
});

describe("selectPierreFileChangeCandidate", () => {
  it("selects explicit Pi and Codex whole-file write carriers", () => {
    const pi = selectPierreFileChangeCandidate(
      write({ contentPreview: { text: "+one\n-two\n@@ three\n" } }),
    );
    expect(pi).toMatchObject({
      source: {
        kind: "whole_file_write",
        content: "+one\n-two\n@@ three\n",
      },
      additions: 3,
      deletions: 0,
    });

    const codex = selectPierreFileChangeCandidate(
      write({
        diff: { text: { text: "const π = true;" } },
        additions: 1,
        deletions: 0,
      }),
    );
    expect(codex).toMatchObject({
      source: { kind: "whole_file_write", content: "const π = true;" },
      additions: 1,
      deletions: 0,
    });
  });

  it("retains explicit empty and truncated whole-file content", () => {
    expect(
      selectPierreFileChangeCandidate(write({ contentPreview: { text: "" } })),
    ).toMatchObject({
      source: { kind: "whole_file_write", content: "" },
      additions: 0,
      deletions: 0,
    });
    expect(
      selectPierreFileChangeCandidate(
        write({
          additions: 50,
          diff: {
            text: {
              text: "retained…",
              truncation: {
                truncated: true,
                retainedBytes: 11,
                reason: "byte_limit",
              },
            },
          },
        }),
      ),
    ).toMatchObject({ additions: 50, deletions: 0 });

    const uncountedTruncated = selectPierreFileChangeCandidate(
      write({
        contentPreview: {
          text: "retained…",
          truncation: {
            truncated: true,
            retainedBytes: 11,
            reason: "byte_limit",
          },
        },
      }),
    );
    expect(uncountedTruncated).toMatchObject({ deletions: 0 });
    expect(uncountedTruncated?.additions).toBeUndefined();
  });

  it("keeps ordinary unified edits on their existing candidate path", () => {
    expect(
      selectPierreFileChangeCandidate(
        write({
          operation: "edit",
          diff: { text: { text: "@@ -1 +1 @@\n-old\n+new" } },
        }),
      ),
    ).toMatchObject({ source: { kind: "unified_patch" } });
    expect(
      selectPierreFileChangeCandidate(
        write({
          operation: "delete",
          diff: { text: { text: "deleted content" } },
        }),
      ),
    ).toBeUndefined();
  });

  it("selects exact replacement text without losing final-newline state", () => {
    expect(
      selectPierreFileChangeCandidate(
        write({
          operation: "edit",
          replacement: {
            before: { text: "value" },
            after: { text: "value\n" },
          },
          additions: 1,
          deletions: 1,
        }),
      ),
    ).toEqual({
      source: {
        kind: "replacement_preview",
        oldContent: "value",
        newContent: "value\n",
      },
      value: { text: "value\n" },
      additions: 1,
      deletions: 1,
    });
  });

  it("retains a one-sided exact deletion", () => {
    expect(
      selectPierreFileChangeCandidate(
        write({
          operation: "edit",
          replacement: {
            before: { text: "deleted\n" },
            after: { text: "" },
          },
          additions: 0,
          deletions: 1,
        }),
      ),
    ).toMatchObject({
      source: {
        kind: "replacement_preview",
        oldContent: "deleted\n",
        newContent: "",
      },
    });
  });

  it.each([
    {
      path: {
        text: "src/retained…",
        truncation: {
          truncated: true as const,
          retainedBytes: 14,
          reason: "byte_limit" as const,
        },
      },
    },
    {
      range: { startLine: 8, endLine: 8 },
    },
    {
      diff: { text: { text: "@@ -1 +1 @@\n-old\n+new\n" } },
    },
    {
      contentPreview: { text: "new" },
    },
    {
      destinationPath: { text: "src/moved.ts" },
    },
    {
      replacement: {
        before: {
          text: "old…",
          truncation: {
            truncated: true as const,
            retainedBytes: 6,
            reason: "byte_limit" as const,
          },
        },
        after: { text: "new" },
      },
    },
    {
      replacement: {
        before: { text: "same" },
        after: { text: "same" },
      },
    },
  ] satisfies Array<Partial<FileChangeItem>>)(
    "fails closed for a contradictory exact replacement %#",
    (overrides) => {
      expect(
        selectPierreFileChangeCandidate(
          write({
            operation: "edit",
            replacement: {
              before: { text: "old" },
              after: { text: "new" },
            },
            ...overrides,
          }),
        ),
      ).toBeUndefined();
    },
  );

  it.each([
    { contentPreview: undefined, diff: undefined },
    {
      contentPreview: { text: "preview" },
      diff: { text: { text: "other" } },
    },
    { contentPreview: { text: "one" }, destinationPath: { text: "two.ts" } },
    {
      contentPreview: { text: "one" },
      range: { startLine: 1, endLine: 1 },
    },
    { contentPreview: { text: "one" }, deletions: 1 },
    { contentPreview: { text: "one" }, additions: 2 },
  ] satisfies Array<Partial<FileChangeItem>>)(
    "fails closed for a contradictory normalized write %#",
    (overrides) => {
      expect(selectPierreFileChangeCandidate(write(overrides))).toBeUndefined();
    },
  );

  it.each([
    "",
    "/dev/null",
    " src/a.ts",
    "src/a.ts ",
    "src/evil\n.ts",
    "src/evil\t.ts",
    "src/evil\u007f.ts",
  ])("rejects an unsafe or untruthful Pierre path %j", (path) => {
    expect(
      selectPierreFileChangeCandidate(
        write({ path: { text: path }, contentPreview: { text: "content" } }),
      ),
    ).toBeUndefined();
    expect(
      selectPierreFileChangeCandidate(
        write({
          operation: "edit",
          path: { text: path },
          replacement: {
            before: { text: "old" },
            after: { text: "new" },
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects a truncated path because the complete header path is unknown", () => {
    expect(
      selectPierreFileChangeCandidate(
        write({
          path: {
            text: "src/retained…",
            truncation: {
              truncated: true,
              retainedBytes: 14,
              reason: "byte_limit",
            },
          },
          contentPreview: { text: "content" },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("countWholeFileLines", () => {
  it.each([
    ["", 0],
    ["one", 1],
    ["one\n", 1],
    ["one\r\ntwo\r\n", 2],
    ["\n", 1],
    ["π\n雪", 2],
  ] as const)("counts %j without a phantom trailing line", (content, count) => {
    expect(countWholeFileLines(content)).toBe(count);
  });
});

function write(overrides: Partial<FileChangeItem>): FileChangeItem {
  return {
    id: "item-1",
    turnId: "turn-1",
    status: "completed",
    revision: 1,
    kind: "file_change",
    phase: "completed",
    operation: "write",
    effect: "applied",
    path: { text: "src/new.ts" },
    ...overrides,
  };
}
