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
    diffStyle: "split",
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
  headCommitHash?: string,
): {
  readonly base?: WorkspaceDiffRevisionSelection;
  readonly head: WorkspaceDiffRevisionSelection;
} {
  const first = revisions.find((revision) => revision.isCurrentBranch)
    ?? revisions.find((revision) => revision.kind === "commit" && revision.commitHash === headCommitHash)
    ?? revisions[0];
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

export function workspaceCompareSelectionLabel(
  selection: WorkspaceDiffRevisionSelection | undefined,
  revisions: readonly WorkspaceDiffRevisionDescriptor[],
): string {
  if (!selection) return "Select a revision";
  if (selection.kind === "index") return "Staged changes";
  if (selection.kind === "working_tree") return "Working tree";
  const revision = revisions.find((candidate) => candidate.revisionId === selection.revisionId);
  if (!revision) return "Revision unavailable";
  return revision.kind === "commit"
    ? `${revision.summary || "Untitled commit"} · ${revision.shortHash}`
    : revision.label;
}

export type WorkspaceComparePreset = "uncommitted" | "staged" | "branches";

export function workspaceComparePresetSelections(
  preset: WorkspaceComparePreset,
  revisions: readonly WorkspaceDiffRevisionDescriptor[],
  headCommitHash?: string,
): { readonly base?: WorkspaceDiffRevisionSelection; readonly head: WorkspaceDiffRevisionSelection; readonly mode: "direct" | "merge_base" } {
  const defaults = defaultWorkspaceCompareSelections(revisions, headCommitHash);
  if (preset === "uncommitted") return { ...defaults, mode: "direct" };
  if (preset === "staged") return { base: defaults.base, head: { kind: "index" }, mode: "direct" };
  const branches = revisions.filter((revision) => revision.kind === "local_branch" || revision.kind === "remote_branch");
  const current = branches.find((revision) => revision.isCurrentBranch) ?? branches[0];
  const other = branches.find((revision) => revision !== current && revision.label === "main")
    ?? branches.find((revision) => revision !== current && revision.label === "master")
    ?? branches.find((revision) => revision !== current);
  const currentIsMainline = current?.label === "main" || current?.label === "master";
  const baseBranch = currentIsMainline ? current : other;
  const compareBranch = currentIsMainline ? other : current;
  return {
    ...(baseBranch ? { base: { kind: "revision" as const, revisionId: baseBranch.revisionId } } : {}),
    head: compareBranch ? { kind: "revision", revisionId: compareBranch.revisionId } : defaults.head,
    mode: baseBranch && compareBranch ? "merge_base" : "direct",
  };
}
