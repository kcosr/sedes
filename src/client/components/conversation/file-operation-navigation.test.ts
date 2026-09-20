import { describe, expect, it } from "vitest";
import type { FileChangeItem } from "../../../shared/index.js";
import { fileChangeNavigation } from "./file-operation-navigation.js";

const base: FileChangeItem = {
  id: "change-1",
  turnId: "turn-1",
  kind: "file_change",
  status: "completed",
  revision: 1,
  phase: "completed",
  operation: "edit",
  effect: "applied",
  path: { text: "src/current.ts" },
};

describe("fileChangeNavigation", () => {
  it("uses the current-file side of an applied patch", () => {
    expect(
      fileChangeNavigation({
        ...base,
        diff: { text: { text: "@@ -12,2 +18,3 @@\n-old\n+new" } },
      }),
    ).toEqual({ path: "src/current.ts", lineNumber: 18 });
  });

  it("uses the historical side when a proposed change was not applied", () => {
    expect(
      fileChangeNavigation({
        ...base,
        effect: "not_applied",
        diff: { text: { text: "@@ -12,2 +18,3 @@\n-old\n+new" } },
      }),
    ).toEqual({ path: "src/current.ts", lineNumber: 12 });
  });

  it("uses the destination path for an applied move", () => {
    expect(
      fileChangeNavigation({
        ...base,
        operation: "move",
        destinationPath: { text: "src/moved.ts" },
        diff: { text: { text: "@@ -4 +9 @@\n-old\n+new" } },
      }),
    ).toEqual({ path: "src/moved.ts", lineNumber: 9 });
  });

  it("omits an applied deletion because no current file can be opened", () => {
    expect(
      fileChangeNavigation({ ...base, operation: "delete" }),
    ).toBeUndefined();
  });

  it("falls back truthfully for whole-file writes and malformed patches", () => {
    expect(
      fileChangeNavigation(
        { ...base, operation: "write" },
        {
          source: { kind: "whole_file_write", content: "new contents" },
          value: { text: "new contents" },
          additions: 1,
          deletions: 0,
        },
      ),
    ).toEqual({ path: "src/current.ts", lineNumber: 1 });
    expect(
      fileChangeNavigation({
        ...base,
        range: { startLine: 44, endLine: 45 },
        diff: { text: { text: "not a unified patch" } },
      }),
    ).toEqual({ path: "src/current.ts", lineNumber: 44 });
  });

  it("opens a replacement preview at the top because it has no file offset", () => {
    expect(
      fileChangeNavigation(
        {
          ...base,
          replacement: {
            before: { text: "old\n" },
            after: { text: "new\n" },
          },
          additions: 1,
          deletions: 1,
        },
        {
          source: {
            kind: "replacement_preview",
            oldContent: "old\n",
            newContent: "new\n",
          },
          value: { text: "new\n" },
          additions: 1,
          deletions: 1,
        },
      ),
    ).toEqual({ path: "src/current.ts", lineNumber: 1 });
  });
});
