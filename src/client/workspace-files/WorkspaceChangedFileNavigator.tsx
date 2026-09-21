import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { WORKSPACE_COMPARE_FILTER_MAX_LENGTH } from "./workspace-compare-navigation.js";
import type {
  WorkspaceDiffChangedFileSummary,
  WorkspaceDiffFileId,
} from "../../shared/protocol/workspace-diffs.js";
import {
  filterWorkspaceCompareFiles,
  workspaceCompareChangeLabel,
  workspaceCompareFilePath,
} from "./workspace-compare-state.js";

const ROW_HEIGHT = 32;
type Row =
  | { kind: "directory"; path: string }
  | { kind: "file"; file: WorkspaceDiffChangedFileSummary };
export function WorkspaceChangedFileNavigator({
  files,
  currentFileId,
  reviewedFileIds,
  commentCounts,
  filter,
  onFilterChange,
  collapsedDirectories,
  onCollapsedDirectoriesChange,
  onNavigate,
  onClose,
  loading,
  truncated,
}: {
  readonly files: readonly WorkspaceDiffChangedFileSummary[];
  readonly currentFileId?: WorkspaceDiffFileId;
  readonly reviewedFileIds: ReadonlySet<WorkspaceDiffFileId>;
  readonly commentCounts: ReadonlyMap<WorkspaceDiffFileId, number>;
  readonly filter: string;
  readonly onFilterChange: (value: string) => void;
  readonly collapsedDirectories: readonly string[];
  readonly onCollapsedDirectoriesChange: (value: readonly string[]) => void;
  readonly onNavigate: (file: WorkspaceDiffChangedFileSummary) => void;
  readonly onClose?: () => void;
  readonly loading: boolean;
  readonly truncated: boolean;
}) {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const userScrollUntilRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [focused, setFocused] = useState(0);
  const filtered = useMemo(
    () => filterWorkspaceCompareFiles(files, filter),
    [files, filter],
  );
  const rows = useMemo(() => {
    const groups = new Map<string, WorkspaceDiffChangedFileSummary[]>();
    for (const file of filtered) {
      const path = workspaceCompareFilePath(file);
      const dir = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : "";
      const group = groups.get(dir) ?? [];
      group.push(file);
      groups.set(dir, group);
    }
    const result: Row[] = [];
    for (const [path, group] of groups) {
      if (path) result.push({ kind: "directory", path });
      if (!path || filter || !collapsedDirectories.includes(path))
        for (const file of group) result.push({ kind: "file", file });
    }
    return result;
  }, [filtered, filter, collapsedDirectories]);
  useEffect(() => {
    const list = listRef.current;
    if (!list || Date.now() < userScrollUntilRef.current) return;
    const index = rows.findIndex(
      (row) => row.kind === "file" && row.file.fileId === currentFileId,
    );
    if (index < 0) return;
    const top = index * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
  }, [currentFileId, rows]);
  const toggle = (path: string) =>
    onCollapsedDirectoriesChange(
      collapsedDirectories.includes(path)
        ? collapsedDirectories.filter((item) => item !== path)
        : [...collapsedDirectories, path],
    );
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8);
  const end = Math.min(
    rows.length,
    start + Math.ceil((listRef.current?.clientHeight || 600) / ROW_HEIGHT) + 16,
  );
  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setFocused(next);
    const list = listRef.current;
    if (list) {
      if (next * ROW_HEIGHT < list.scrollTop)
        list.scrollTop = next * ROW_HEIGHT;
      else if ((next + 1) * ROW_HEIGHT > list.scrollTop + list.clientHeight)
        list.scrollTop = (next + 1) * ROW_HEIGHT - list.clientHeight;
    }
  };
  return (
    <aside className="workspace-compare-sidebar" aria-label="Changed files">
      <div className="workspace-compare-navigator-search">
        <Search aria-hidden="true" />
        <input
          aria-label="Filter changed files"
          placeholder="Filter changed files"
          maxLength={WORKSPACE_COMPARE_FILTER_MAX_LENGTH}
          value={filter}
          onChange={(event) => {
            onFilterChange(event.target.value.slice(0, WORKSPACE_COMPARE_FILTER_MAX_LENGTH));
            setFocused(0);
            setScrollTop(0);
            if (listRef.current) listRef.current.scrollTop = 0;
          }}
        />
        {onClose && (
          <button
            type="button"
            aria-label="Close changed files"
            onClick={onClose}
          >
            <X />
          </button>
        )}
      </div>
      <div
        ref={listRef}
        className="workspace-compare-tree"
        role="tree"
        aria-label="Changed file tree"
        tabIndex={0}
        aria-activedescendant={
          rows[focused] && focused >= start && focused < end
            ? `${id}-${focused}`
            : undefined
        }
        onWheel={() => {
          userScrollUntilRef.current = Date.now() + 1500;
        }}
        onTouchMove={() => {
          userScrollUntilRef.current = Date.now() + 1500;
        }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={(event) => {
          const row = rows[focused];
          if (event.key === "ArrowDown") {
            event.preventDefault();
            focusRow(focused + 1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            focusRow(focused - 1);
          } else if (event.key === "Home") {
            event.preventDefault();
            focusRow(0);
          } else if (event.key === "End") {
            event.preventDefault();
            focusRow(rows.length - 1);
          } else if (row && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            row.kind === "directory" ? toggle(row.path) : onNavigate(row.file);
          } else if (
            row?.kind === "directory" &&
            (event.key === "ArrowLeft" || event.key === "ArrowRight")
          ) {
            event.preventDefault();
            if (
              (event.key === "ArrowLeft") !==
              collapsedDirectories.includes(row.path)
            )
              toggle(row.path);
          }
        }}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {rows.slice(start, end).map((row, offset) => {
            const index = start + offset;
            return row.kind === "directory" ? (
              <div
                key={row.path}
                id={`${id}-${index}`}
                role="treeitem"
                data-focused={focused === index}
                aria-level={1}
                aria-expanded={
                  !collapsedDirectories.includes(row.path) || !!filter
                }
                className="workspace-compare-directory"
                style={{ top: index * ROW_HEIGHT }}
                onClick={() => {
                  setFocused(index);
                  toggle(row.path);
                }}
              >
                {collapsedDirectories.includes(row.path) && !filter ? (
                  <ChevronRight />
                ) : (
                  <ChevronDown />
                )}
                <span>{row.path}/</span>
              </div>
            ) : (
              <div
                key={row.file.fileId}
                id={`${id}-${index}`}
                role="treeitem"
                data-focused={focused === index}
                aria-level={
                  workspaceCompareFilePath(row.file).includes("/") ? 2 : 1
                }
                aria-selected={row.file.fileId === currentFileId}
                className="workspace-compare-tree-file"
                style={{ top: index * ROW_HEIGHT }}
                onClick={() => {
                  setFocused(index);
                  onNavigate(row.file);
                }}
                title={[row.file.oldPath, row.file.newPath]
                  .filter(Boolean)
                  .join(" → ")}
              >
                <span
                  className={`workspace-compare-change is-${row.file.changeKind}`}
                  aria-label={workspaceCompareChangeLabel(row.file.changeKind)}
                >
                  {workspaceCompareChangeLabel(row.file.changeKind)[0]}
                </span>
                <span className="workspace-compare-file-path">
                  {workspaceCompareFilePath(row.file).split("/").at(-1)}
                </span>
                <span className="workspace-compare-stats">
                  {row.file.binary ? (
                    "Binary"
                  ) : (
                    <>
                      {row.file.additions !== undefined && (
                        <span className="is-addition">
                          +{row.file.additions}
                        </span>
                      )}
                      {row.file.deletions !== undefined && (
                        <span className="is-deletion">
                          −{row.file.deletions}
                        </span>
                      )}
                      {row.file.additions === undefined &&
                        row.file.deletions === undefined && (
                          <span aria-label="Change counts unavailable">—</span>
                        )}
                    </>
                  )}
                </span>
                {(commentCounts.get(row.file.fileId) ?? 0) > 0 && (
                  <span title="Comments">
                    {commentCounts.get(row.file.fileId)} ◇
                  </span>
                )}
                {reviewedFileIds.has(row.file.fileId) && (
                  <Check
                    className="workspace-compare-reviewed-icon"
                    aria-label="Reviewed"
                  />
                )}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && (
          <p>
            {filter
              ? "No changed files match this filter."
              : loading
                ? "Loading changed files…"
                : "No changed files."}
          </p>
        )}
      </div>
      <div className="workspace-compare-sidebar-footer" role="status">
        {loading
          ? "Loading file list…"
          : `${filtered.length} of ${files.length} files`}
        {truncated ? " · Result truncated" : ""}
      </div>
    </aside>
  );
}
