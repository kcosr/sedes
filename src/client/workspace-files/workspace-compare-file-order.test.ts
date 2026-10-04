import { describe, expect, it } from "vitest";
import type { WorkspaceDiffChangedFileSummary } from "../../shared/protocol/workspace-diffs.js";
import {
  compareWorkspaceChangedFilePaths,
  sortWorkspaceChangedFiles,
} from "./workspace-compare-file-order.js";

function changed(
  fileId: string,
  paths: { readonly oldPath?: string; readonly newPath?: string },
): WorkspaceDiffChangedFileSummary {
  return {
    fileId,
    changeKind: paths.newPath ? (paths.oldPath ? "modified" : "added") : "deleted",
    ...paths,
    binary: false,
  } as WorkspaceDiffChangedFileSummary;
}

function sortedPaths(paths: readonly string[]): string[] {
  return [...paths].sort(compareWorkspaceChangedFilePaths);
}

describe("canonical changed-file order", () => {
  it("lists root-level files before any directory", () => {
    expect(sortedPaths(["zeta.md", "src/a.ts", "README.md"])).toEqual([
      "README.md",
      "zeta.md",
      "src/a.ts",
    ]);
  });

  it("compares directories segment by segment", () => {
    expect(
      sortedPaths(["a-b/z.ts", "a/b/y.ts", "a/x.ts", "a/b/c/w.ts", "ab/v.ts"]),
    ).toEqual(["a/x.ts", "a/b/y.ts", "a/b/c/w.ts", "a-b/z.ts", "ab/v.ts"]);
  });

  it("keeps a directory's own files before its subdirectories", () => {
    expect(sortedPaths(["src/z/a.ts", "src/b.ts", "src/a.ts"])).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/z/a.ts",
    ]);
  });

  it("orders names case-insensitively and numerically, with a total tiebreak", () => {
    expect(
      sortedPaths(["file-10.ts", "File-2.ts", "file-1.ts", "file-2.ts", "Beta.md", "alpha.md"]),
    ).toEqual(["alpha.md", "Beta.md", "file-1.ts", "File-2.ts", "file-2.ts", "file-10.ts"]);
  });

  it("sorts summaries by their displayed path and keeps equal paths stable", () => {
    const files = [
      changed("zeta", { oldPath: "zeta.md", newPath: "zeta.md" }),
      changed("renamed", { oldPath: "a.ts", newPath: "src/a.ts" }),
      changed("deleted", { oldPath: "README.md" }),
      changed("first-copy", { newPath: "docs/x.md" }),
      changed("second-copy", { newPath: "docs/x.md" }),
    ];
    const sorted = sortWorkspaceChangedFiles(files);
    expect(sorted.map((file) => file.fileId)).toEqual([
      "deleted",
      "zeta",
      "first-copy",
      "second-copy",
      "renamed",
    ]);
    expect(files.map((file) => file.fileId)).toEqual([
      "zeta",
      "renamed",
      "deleted",
      "first-copy",
      "second-copy",
    ]);
  });
});
