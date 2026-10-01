import { useMemo, type ReactNode } from "react";
import { FileCheck2, FolderOpen, GitBranch, GitCommitHorizontal, LoaderCircle, Tag } from "lucide-react";
import type { WorkspaceDiffRevisionDescriptor, WorkspaceDiffRevisionSelection } from "../../shared/protocol/workspace-diffs.js";
import { Field } from "../components/ui/field.js";
import { menuEmptyClass } from "../components/ui/floating.js";
import { SearchableSelect, type SearchableSelectOption } from "../components/ui/searchable-select.js";
import { cn } from "@client/lib/utils";
import { workspaceCompareSelectionKey, workspaceCompareSelectionLabel } from "./workspace-compare-state.js";

export interface WorkspaceRevisionPickerProps {
  readonly label: string;
  readonly selection?: WorkspaceDiffRevisionSelection;
  readonly revisions: readonly WorkspaceDiffRevisionDescriptor[];
  readonly onChange: (selection: WorkspaceDiffRevisionSelection) => void;
  readonly loading?: boolean;
  readonly truncated?: boolean;
}

const workspaceSources = [
  { kind: "working_tree", title: "Working tree", detail: "Current files, including untracked changes", icon: <FolderOpen /> },
  { kind: "index", title: "Staged changes", detail: "Files staged for the next commit", icon: <FileCheck2 /> },
] as const;

const groups: readonly (readonly [WorkspaceDiffRevisionDescriptor["kind"], string, ReactNode])[] = [
  ["local_branch", "Local branches", <GitBranch />],
  ["remote_branch", "Remote branches", <GitBranch />],
  ["tag", "Tags", <Tag />],
  ["commit", "Commits · newest first", <GitCommitHorizontal />],
];

/**
 * The picker's options, keyed by selection: the workspace states, then
 * branches (the current one first), tags, and commits newest first.
 */
function revisionOptions(revisions: readonly WorkspaceDiffRevisionDescriptor[]): {
  readonly options: readonly SearchableSelectOption[];
  readonly selections: ReadonlyMap<string, WorkspaceDiffRevisionSelection>;
} {
  const selections = new Map<string, WorkspaceDiffRevisionSelection>();
  const options: SearchableSelectOption[] = workspaceSources.map((source) => {
    selections.set(source.kind, { kind: source.kind });
    return { value: source.kind, label: source.title, description: source.detail, icon: source.icon, group: "Workspace" };
  });
  for (const [kind, title, icon] of groups) {
    const entries = revisions.filter((revision) => revision.kind === kind).sort((left, right) => kind === "commit"
      ? (Date.parse(right.committedAt ?? "") || 0) - (Date.parse(left.committedAt ?? "") || 0) || left.commitHash.localeCompare(right.commitHash)
      : Number(Boolean(right.isCurrentBranch)) - Number(Boolean(left.isCurrentBranch)) || left.label.localeCompare(right.label));
    for (const revision of entries) {
      const selection = { kind: "revision", revisionId: revision.revisionId } as const;
      const value = workspaceCompareSelectionKey(selection);
      selections.set(value, selection);
      options.push({
        value,
        label: kind === "commit" ? revision.summary || "Untitled commit" : revision.label,
        description: kind === "commit"
          ? [revision.committedAt && formatRevisionDate(revision.committedAt), revision.shortHash].filter(Boolean).join(" · ")
          : revision.isCurrentBranch ? `Current · ${revision.shortHash}` : revision.shortHash,
        icon,
        searchTerms: [revision.label, revision.summary ?? "", revision.commitHash],
        group: title,
      });
    }
  }
  return { options, selections };
}

/**
 * A comparison endpoint: the shared searchable picker over the workspace
 * states and the repository's revisions, grouped by kind.
 */
export function WorkspaceRevisionPicker({ label, selection, revisions, onChange, loading = false, truncated = false }: WorkspaceRevisionPickerProps): React.JSX.Element {
  const { options, selections } = useMemo(() => revisionOptions(revisions), [revisions]);
  const footer = loading || truncated ? (
    <div className="border-t border-border-soft">
      {loading && <p role="status" className={cn(menuEmptyClass, "m-0")}><LoaderCircle aria-hidden="true" />Loading revisions…</p>}
      {truncated && <p className="m-0 px-3 py-2 text-(length:--text-meta) leading-4 text-muted-foreground-2">Showing a limited catalog. Search filters these choices; set Commit history to a branch to narrow the commits.</p>}
    </div>
  ) : undefined;
  return (
    <Field label={label}>
      <SearchableSelect
        label={`${label} revision`}
        searchLabel={`Search ${label.toLowerCase()} revisions`}
        emptyLabel="No revisions match this search."
        value={selection ? workspaceCompareSelectionKey(selection) : ""}
        selectedLabel={workspaceCompareSelectionLabel(selection, revisions)}
        options={options}
        footer={footer}
        onValueChange={(value) => {
          const next = selections.get(value);
          if (next) onChange(next);
        }}
      />
    </Field>
  );
}

function formatRevisionDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date));
}
