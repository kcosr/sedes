import { useId, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, GitCommitHorizontal, Search } from "lucide-react";
import type { WorkspaceDiffRevisionDescriptor, WorkspaceDiffRevisionSelection } from "../../shared/protocol/workspace-diffs.js";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import { workspaceCompareSelectionKey, workspaceCompareSelectionLabel } from "./workspace-compare-state.js";
import "./workspace-revision-picker.css";

export interface WorkspaceRevisionPickerProps {
  readonly label: string;
  readonly selection?: WorkspaceDiffRevisionSelection;
  readonly revisions: readonly WorkspaceDiffRevisionDescriptor[];
  readonly onChange: (selection: WorkspaceDiffRevisionSelection) => void;
  readonly historyScope?: string;
  readonly onHistoryScopeChange?: (scope: string) => void;
  readonly loading?: boolean;
  readonly truncated?: boolean;
}

const groups = [
  ["local_branch", "Local branches"],
  ["remote_branch", "Remote branches"],
  ["tag", "Tags"],
  ["commit", "Commits · newest first"],
] as const;

export function WorkspaceRevisionPicker({ label, selection, revisions, onChange, historyScope = "head", onHistoryScopeChange, loading = false, truncated = false }: WorkspaceRevisionPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const selectedKey = selection && workspaceCompareSelectionKey(selection);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(normalized);
  const filtered = revisions.filter((revision) => matches(`${revision.label} ${revision.summary ?? ""} ${revision.commitHash}`));
  const choose = (next: WorkspaceDiffRevisionSelection) => { onChange(next); setOpen(false); };
  const mutable = [
    { kind: "working_tree", title: "Working tree", detail: "Current files, including untracked changes" },
    { kind: "index", title: "Staged changes", detail: "Files staged for the next commit" },
  ] as const;
  const focusOption = (index: number) => {
    const options = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    if (options?.length) options[(index + options.length) % options.length]?.focus();
  };
  return (
    <div className="workspace-revision-picker">
      <span id={`${id}-label`} className="workspace-revision-label">{label}</span>
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setQuery(""); }}>
        <PopoverTrigger asChild>
          <button type="button" className="workspace-revision-trigger" aria-label={`${label} revision`} aria-expanded={open}>
            <span>{workspaceCompareSelectionLabel(selection, revisions)}</span><ChevronDown aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="workspace-revision-popover" align="start" role="dialog" aria-label={`Choose ${label.toLowerCase()} revision`}>
          <div className="workspace-revision-search"><Search aria-hidden="true" />
            <input autoFocus aria-label={`Search ${label.toLowerCase()} revisions`} placeholder="Search branches, messages, or hashes…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); focusOption(0); } }} />
          </div>
          {onHistoryScopeChange && <label className="workspace-revision-history">Commit history
            <select aria-label={`${label} commit history`} value={historyScope} onChange={(event) => onHistoryScopeChange(event.target.value)}>
              <option value="head">Current branch (HEAD)</option>
              {revisions.filter((revision) => revision.kind === "local_branch" || revision.kind === "remote_branch").map((revision) => <option key={revision.revisionId} value={`revision:${revision.revisionId}`}>{revision.label}</option>)}
              <option value="all">All branches</option>
            </select>
          </label>}
          <div ref={listRef} className="workspace-revision-options" role="listbox" aria-label={`${label} sources`} aria-busy={loading} onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const options = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
            const index = options.indexOf(document.activeElement as HTMLButtonElement);
            focusOption(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1));
          }}>
            {mutable.some((entry) => matches(`${entry.title} ${entry.detail}`)) && <div role="group" aria-label="Workspace"><p className="workspace-revision-group-title">Workspace</p>{mutable.filter((entry) => matches(`${entry.title} ${entry.detail}`)).map((entry) => <button type="button" role="option" aria-selected={selectedKey === entry.kind} key={entry.kind} onClick={() => choose({ kind: entry.kind })}><span className="workspace-revision-option-copy"><strong>{entry.title}</strong><small>{entry.detail}</small></span>{selectedKey === entry.kind && <Check aria-hidden="true" />}</button>)}</div>}
            {groups.map(([kind, title]) => {
              const entries = filtered.filter((revision) => revision.kind === kind).sort((left, right) => kind === "commit"
                ? (Date.parse(right.committedAt ?? "") || 0) - (Date.parse(left.committedAt ?? "") || 0) || left.commitHash.localeCompare(right.commitHash)
                : Number(Boolean(right.isCurrentBranch)) - Number(Boolean(left.isCurrentBranch)) || left.label.localeCompare(right.label));
              if (!entries.length) return null;
              return <div role="group" aria-label={title} key={kind}><p className="workspace-revision-group-title">{title}</p>{entries.map((revision) => {
                const value = { kind: "revision", revisionId: revision.revisionId } as const;
                const selected = selectedKey === workspaceCompareSelectionKey(value);
                return <button type="button" role="option" aria-selected={selected} key={revision.revisionId} onClick={() => choose(value)}>
                  {kind === "commit" ? <GitCommitHorizontal aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
                  <span className="workspace-revision-option-copy"><strong>{kind === "commit" ? revision.summary || "Untitled commit" : revision.label}{revision.isCurrentBranch && <em>Current</em>}</strong><small>{kind === "commit" && revision.committedAt && <><time dateTime={revision.committedAt}>{formatRevisionDate(revision.committedAt)}</time><span> · </span></>}<code>{revision.shortHash}</code></small></span>
                  {selected && <Check aria-hidden="true" />}
                </button>;
              })}</div>;
            })}
            {loading && <p role="status">Loading revisions…</p>}
            {!loading && !filtered.length && !mutable.some((entry) => matches(`${entry.title} ${entry.detail}`)) && <p role="status">No revisions match this search.</p>}
          </div>
          {truncated && <p className="workspace-revision-limit">Showing a limited catalog. Search filters these choices; select a branch to narrow commit history.</p>}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function formatRevisionDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date));
}
