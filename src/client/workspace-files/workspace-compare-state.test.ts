import { describe, expect, it } from "vitest";
import type {
  WorkspaceDiffChangedFileSummary,
  WorkspaceDiffRevisionDescriptor,
} from "../../shared/protocol/workspace-diffs.js";
import {
  appendWorkspaceCompareFiles,
  defaultWorkspaceCompareSelections,
  effectiveWorkspaceComparePreferences,
  filterWorkspaceCompareFiles,
  workspaceCompareSelectionFromKey,
  workspaceCompareSelectionKey,
  workspaceCompareSupportsMergeBase,
  workspaceComparePresetSelections,
  workspaceCompareSelectionLabel,
} from "./workspace-compare-state.js";

describe("workspace compare state", () => {
  const revisions = [
    {
      revisionId: "rev-main",
      kind: "local_branch",
      label: "main",
      commitHash: "a".repeat(40),
      shortHash: "aaaaaaa",
    },
  ] as WorkspaceDiffRevisionDescriptor[];

  it("uses the first server-issued revision and working tree by default", () => {
    expect(defaultWorkspaceCompareSelections(revisions)).toEqual({
      base: { kind: "revision", revisionId: "rev-main" },
      head: { kind: "working_tree" },
    });
  });

  it("defaults to the current branch and chooses a sensible branch review base", () => {
    const current = { ...revisions[0]!, revisionId: "feature" as never, label: "feature", isCurrentBranch: true };
    const catalog = [...revisions, current];
    expect(defaultWorkspaceCompareSelections(catalog).base).toEqual({ kind: "revision", revisionId: "feature" });
    expect(workspaceComparePresetSelections("branches", catalog)).toEqual({ base: { kind: "revision", revisionId: "rev-main" }, head: { kind: "revision", revisionId: "feature" }, mode: "merge_base" });
    expect(workspaceComparePresetSelections("branches", catalog.map(revision => ({ ...revision, isCurrentBranch: revision.label === "main" })))).toEqual({ base: { kind: "revision", revisionId: "rev-main" }, head: { kind: "revision", revisionId: "feature" }, mode: "merge_base" });
    expect(workspaceComparePresetSelections("staged", catalog)).toEqual({ base: { kind: "revision", revisionId: "feature" }, head: { kind: "index" }, mode: "direct" });
    expect(workspaceComparePresetSelections("uncommitted", catalog).head).toEqual({ kind: "working_tree" });
  });

  it("uses exact detached HEAD instead of a clock-skewed ancestor and labels commit messages", () => {
    const ancestor = { ...revisions[0]!, kind: "commit" as const, summary: "Ancestor" };
    const head = { ...ancestor, revisionId: "head" as never, commitHash: "b".repeat(40), shortHash: "bbbbbbb", summary: "Checked out commit" };
    const selection = defaultWorkspaceCompareSelections([ancestor, head], head.commitHash).base;
    expect(selection).toEqual({ kind: "revision", revisionId: "head" });
    expect(workspaceCompareSelectionLabel(selection, [ancestor, head])).toBe("Checked out commit · bbbbbbb");
  });

  it("round trips only catalogued opaque revision selectors", () => {
    const key = workspaceCompareSelectionKey({
      kind: "revision",
      revisionId: revisions[0]!.revisionId,
    });
    expect(workspaceCompareSelectionFromKey(key, revisions)).toEqual({
      kind: "revision",
      revisionId: "rev-main",
    });
    expect(
      workspaceCompareSelectionFromKey("revision:HEAD~1", revisions),
    ).toBeUndefined();
  });

  it("forces unified presentation on narrow layouts without changing the preference", () => {
    const preference = { diffStyle: "split", overflow: "wrap" } as const;
    expect(effectiveWorkspaceComparePreferences(preference, true)).toEqual({
      diffStyle: "unified",
      overflow: "wrap",
    });
    expect(effectiveWorkspaceComparePreferences(preference, false)).toBe(
      preference,
    );
  });

  it("allows merge-base only between two catalogued revisions", () => {
    const revision = {
      kind: "revision",
      revisionId: revisions[0]!.revisionId,
    } as const;
    expect(workspaceCompareSupportsMergeBase(revision, revision)).toBe(true);
    expect(
      workspaceCompareSupportsMergeBase(revision, { kind: "working_tree" }),
    ).toBe(false);
    expect(workspaceCompareSupportsMergeBase({ kind: "index" }, revision)).toBe(
      false,
    );
  });

  it("deduplicates pages and filters both sides of renamed paths", () => {
    const oldFile = {
      fileId: "file-1",
      changeKind: "renamed",
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
      binary: false,
    } as WorkspaceDiffChangedFileSummary;
    const newFile = {
      fileId: "file-2",
      changeKind: "added",
      newPath: "README.md",
      binary: false,
    } as WorkspaceDiffChangedFileSummary;
    const files = appendWorkspaceCompareFiles([oldFile], [oldFile, newFile]);
    expect(files).toHaveLength(2);
    expect(filterWorkspaceCompareFiles(files, "old-name")).toEqual([oldFile]);
  });
});
