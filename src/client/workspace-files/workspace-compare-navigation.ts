import type {
  WorkspaceDiffChangedFileSummary,
  WorkspaceDiffRevisionDescriptor,
  WorkspaceDiffRevisionSelection,
} from "../../shared/protocol/workspace-diffs.js";
import type { WorkspaceComparePreferences } from "./workspace-compare-state.js";

export const WORKSPACE_COMPARE_FILTER_MAX_LENGTH = 1024;

export type WorkspaceCompareEndpointIntent =
  | { readonly kind: "working_tree" }
  | { readonly kind: "index" }
  | {
      readonly kind: "ref";
      readonly refKind: "local_branch" | "remote_branch" | "tag";
      readonly label: string;
    }
  | { readonly kind: "commit"; readonly commitHash: string };
export interface WorkspaceCompareNavigation {
  readonly repository: {
    readonly repositoryKey: string;
    readonly displayName: string;
    readonly pathPrefix?: string;
  };
  readonly base: WorkspaceCompareEndpointIntent;
  readonly head: WorkspaceCompareEndpointIntent;
  readonly mode: "direct" | "merge_base";
  readonly fingerprint?: string;
  readonly file?: {
    readonly oldPath?: string;
    readonly newPath?: string;
    readonly changeKind: WorkspaceDiffChangedFileSummary["changeKind"];
    readonly line?: number;
    readonly side?: "deletions" | "additions";
    readonly offset?: number;
  };
  readonly returnLocations?: readonly NonNullable<
    WorkspaceCompareNavigation["file"]
  >[];
  readonly filter: string;
  readonly navigatorWidth: number;
  readonly collapsedDirectories: readonly string[];
  readonly preferences: WorkspaceComparePreferences;
}
export function compareEndpointIntent(
  selection: WorkspaceDiffRevisionSelection | undefined,
  revisions: readonly WorkspaceDiffRevisionDescriptor[],
): WorkspaceCompareEndpointIntent | undefined {
  if (!selection || selection.kind !== "revision") return selection;
  const revision = revisions.find(
    (item) => item.revisionId === selection.revisionId,
  );
  if (!revision) return undefined;
  return revision.kind === "commit"
    ? { kind: "commit", commitHash: revision.commitHash }
    : { kind: "ref", refKind: revision.kind, label: revision.label };
}
export function compareEndpointSelection(
  intent: WorkspaceCompareEndpointIntent,
  revisions: readonly WorkspaceDiffRevisionDescriptor[],
): WorkspaceDiffRevisionSelection | undefined {
  if (intent.kind === "working_tree" || intent.kind === "index") return intent;
  const revision = revisions.find((item) =>
    intent.kind === "commit"
      ? item.kind === "commit" && item.commitHash === intent.commitHash
      : item.kind === intent.refKind && item.label === intent.label,
  );
  return revision
    ? { kind: "revision", revisionId: revision.revisionId }
    : undefined;
}
