import type {
  WorkspaceDiffChangedFileSummary,
  WorkspaceDiffRevisionDescriptor,
  WorkspaceDiffRevisionSelection,
} from "../../shared/protocol/workspace-diffs.js";

export type WorkspaceCompareDiffStyle = "unified" | "split";
export type WorkspaceCompareOverflow = "wrap" | "scroll";

export interface WorkspaceComparePreferences {
  readonly diffStyle: WorkspaceCompareDiffStyle;
  readonly overflow: WorkspaceCompareOverflow;
}

export const DEFAULT_WORKSPACE_COMPARE_PREFERENCES: WorkspaceComparePreferences =
  {
    diffStyle: "unified",
    overflow: "scroll",
  };

export function effectiveWorkspaceComparePreferences(
  preferences: WorkspaceComparePreferences,
  narrow: boolean,
): WorkspaceComparePreferences {
  return narrow && preferences.diffStyle === "split"
    ? { ...preferences, diffStyle: "unified" }
    : preferences;
}

export function defaultWorkspaceCompareSelections(
  revisions: readonly WorkspaceDiffRevisionDescriptor[],
): {
  readonly base?: WorkspaceDiffRevisionSelection;
  readonly head: WorkspaceDiffRevisionSelection;
} {
  const first = revisions[0];
  return {
    ...(first
      ? { base: { kind: "revision", revisionId: first.revisionId } as const }
      : {}),
    head: { kind: "working_tree" },
  };
}

export function workspaceCompareSupportsMergeBase(
  base: WorkspaceDiffRevisionSelection | undefined,
  head: WorkspaceDiffRevisionSelection,
): boolean {
  return base?.kind === "revision" && head.kind === "revision";
}

export function workspaceCompareSelectionKey(
  selection: WorkspaceDiffRevisionSelection,
): string {
  return selection.kind === "revision"
    ? `revision:${selection.revisionId}`
    : selection.kind;
}

export function workspaceCompareSelectionFromKey(
  key: string,
  revisions: readonly WorkspaceDiffRevisionDescriptor[],
): WorkspaceDiffRevisionSelection | undefined {
  if (key === "index") return { kind: "index" };
  if (key === "working_tree") return { kind: "working_tree" };
  const revision = revisions.find(
    (candidate) =>
      workspaceCompareSelectionKey({
        kind: "revision",
        revisionId: candidate.revisionId,
      }) === key,
  );
  return revision
    ? { kind: "revision", revisionId: revision.revisionId }
    : undefined;
}

export function workspaceCompareFilePath(
  file: WorkspaceDiffChangedFileSummary,
): string {
  return file.newPath ?? file.oldPath ?? "Unknown file";
}

export function filterWorkspaceCompareFiles(
  files: readonly WorkspaceDiffChangedFileSummary[],
  query: string,
): readonly WorkspaceDiffChangedFileSummary[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return files;
  return files.filter((file) => {
    const paths = [file.oldPath, file.newPath].filter(
      (path): path is string => path !== undefined,
    );
    return paths.some((path) => path.toLocaleLowerCase().includes(normalized));
  });
}

export function appendWorkspaceCompareFiles(
  current: readonly WorkspaceDiffChangedFileSummary[],
  incoming: readonly WorkspaceDiffChangedFileSummary[],
): readonly WorkspaceDiffChangedFileSummary[] {
  const known = new Set(current.map((file) => file.fileId));
  return [
    ...current,
    ...incoming.filter((file) => {
      if (known.has(file.fileId)) return false;
      known.add(file.fileId);
      return true;
    }),
  ];
}

export function workspaceCompareChangeLabel(
  changeKind: WorkspaceDiffChangedFileSummary["changeKind"],
): string {
  return {
    added: "Added",
    modified: "Modified",
    deleted: "Deleted",
    renamed: "Renamed",
    copied: "Copied",
    type_changed: "Type changed",
    unmerged: "Unmerged",
  }[changeKind];
}
