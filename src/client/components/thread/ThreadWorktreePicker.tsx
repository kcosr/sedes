import { useKeyboardInset } from "../../app/use-keyboard-inset.js";
import { usePickerFocus } from "../../lib/use-picker-focus.js";
import * as Popover from "@radix-ui/react-popover";
import {
  ChevronDown,
  GitBranch,
  LoaderCircle,
  Search,
  Trash2,
} from "lucide-react";
import {
  type CSSProperties,
  useContext,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  workspaceFileLinkedWorktreeRootIdSchema,
  type NormalizedApplicationThreadSummary,
  type WorkspaceFileRootDescriptor,
} from "../../../shared/index.js";
import type { ApiClient } from "../../api/ApiClient.js";
import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogPortalContainerContext,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog.js";
import { Input } from "../ui/input.js";
import { useMediaQuery } from "../../app/use-media-query.js";

type LinkedWorktree = WorkspaceFileRootDescriptor & {
  readonly kind: "linked_worktree";
};

interface PendingPreference {
  readonly rootId: ReturnType<
    typeof workspaceFileLinkedWorktreeRootIdSchema.parse
  > | null;
  readonly revision: number;
}

export function ThreadWorktreePicker({
  api,
  thread,
  workspaceId,
  disabled = false,
}: {
  readonly api: Pick<
    ApiClient,
    | "listWorkspaceFileRoots"
    | "updateThreadPreferredWorktree"
    | "deleteLinkedWorktree"
  >;
  readonly thread: NormalizedApplicationThreadSummary;
  readonly workspaceId: string;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const mobile = useMediaQuery("(pointer: coarse), (max-width: 819px)");
  const [open, setOpen] = useState(false);
  const keyboardInset = useKeyboardInset(mobile && open);
  const dialogContainer = useContext(DialogPortalContainerContext);
  const [roots, setRoots] = useState<readonly WorkspaceFileRootDescriptor[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingPreference, setPendingPreference] =
    useState<PendingPreference>();
  const [deleteTarget, setDeleteTarget] = useState<LinkedWorktree>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const requestSequence = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pickerFocus = usePickerFocus(searchRef);

  const preferredRootId =
    pendingPreference !== undefined
      ? pendingPreference.rootId
      : (thread.preferredWorktree?.rootId ?? null);
  const preferredRevision =
    pendingPreference !== undefined
      ? pendingPreference.revision
      : thread.preferredWorktreeRevision;

  useEffect(() => {
    if (!pendingPreference) return;
    const publishedRootId = thread.preferredWorktree?.rootId ?? null;
    if (
      thread.preferredWorktreeRevision > pendingPreference.revision ||
      (thread.preferredWorktreeRevision === pendingPreference.revision &&
        publishedRootId === pendingPreference.rootId)
    ) {
      setPendingPreference(undefined);
    }
  }, [pendingPreference, thread]);

  const loadRoots = useCallback(
    async (background = false) => {
      const sequence = ++requestSequence.current;
      if (!background) setLoading(true);
      setError("");
      try {
        const result = await api.listWorkspaceFileRoots(workspaceId);
        if (requestSequence.current === sequence) setRoots(result.roots);
      } catch (cause) {
        if (requestSequence.current === sequence) setError(messageFor(cause));
      } finally {
        if (requestSequence.current === sequence) setLoading(false);
      }
    },
    [api, workspaceId],
  );

  useEffect(() => {
    setOpen(false);
    setRoots([]);
    setPendingPreference(undefined);
    setQuery("");
    setLoading(false);
    setError("");
    return () => {
      requestSequence.current += 1;
    };
  }, [thread.id, workspaceId]);

  const primary = roots.find((root) => root.kind === "primary");
  const linked = roots.filter(
    (root): root is LinkedWorktree => root.kind === "linked_worktree",
  );
  const activeRoot = preferredRootId
    ? linked.find((root) => root.rootId === preferredRootId)
    : primary;
  const activeLabel =
    activeRoot?.kind === "linked_worktree"
      ? worktreeName(activeRoot)
      : preferredRootId
        ? (thread.preferredWorktree?.branch ??
          thread.preferredWorktree?.displayLabel ??
          "Worktree")
        : "Primary";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const primaryVisible =
    primary !== undefined &&
    (normalizedQuery.length === 0 ||
      ["Primary", primary.displayLabel, primary.displayPath.text].some(
        (value) => value.toLocaleLowerCase().includes(normalizedQuery),
      ));
  const visibleLinked = useMemo(
    () =>
      normalizedQuery.length === 0
        ? linked
        : linked.filter((root) =>
            [root.branch, root.displayLabel, root.displayPath.text].some(
              (value) => value?.toLocaleLowerCase().includes(normalizedQuery),
            ),
          ),
    [linked, normalizedQuery],
  );

  const selectRoot = async (root: WorkspaceFileRootDescriptor) => {
    if (saving || root.availability !== "available") return;
    if (root.kind !== "primary" && root.kind !== "linked_worktree") return;
    const rootId =
      root.kind === "primary"
        ? null
        : workspaceFileLinkedWorktreeRootIdSchema.parse(root.rootId);
    if (rootId === preferredRootId) {
      setOpen(false);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await api.updateThreadPreferredWorktree(thread.id, {
        rootId,
        expectedRevision: preferredRevision,
        mutationId: crypto.randomUUID(),
      });
      setPendingPreference(result.preference);
      setOpen(false);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSaving(false);
    }
  };

  const deleteWorktree = async () => {
    if (
      !deleteTarget ||
      deleteTarget.removal.status === "unavailable" ||
      deleting
    )
      return;
    setDeleting(true);
    setDeleteError("");
    try {
      const result = await api.deleteLinkedWorktree(
        workspaceId,
        workspaceFileLinkedWorktreeRootIdSchema.parse(deleteTarget.rootId),
        {
          expectedRevision: deleteTarget.revision,
          mutationId: crypto.randomUUID(),
          confirmation: true,
        },
      );
      if (result.clearedThreadIds.includes(thread.id)) {
        setPendingPreference({
          rootId: null,
          revision: preferredRevision + 1,
        });
      }
      setDeleteTarget(undefined);
      await loadRoots(true);
    } catch (cause) {
      setDeleteError(messageFor(cause));
    } finally {
      setDeleting(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      void loadRoots(roots.length > 0);
    }
  };
  const trigger = (
    <button
      ref={triggerRef}
      onPointerDown={pickerFocus.onPointerDown}
      onKeyDown={pickerFocus.onKeyDown}
      type="button"
      className="thread-worktree-trigger"
      aria-label={`Thread worktree: ${activeLabel}`}
      title={`Change thread worktree (${activeLabel})`}
      disabled={disabled}
    >
      <GitBranch size={12} strokeWidth={1.8} aria-hidden="true" />
      <span>{activeLabel}</span>
      <ChevronDown
        className="thread-worktree-chevron"
        size={12}
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </button>
  );
  const pickerContent = (
    <>
      <div className="thread-worktree-popover-heading">
        <div>
          <strong>Thread worktree</strong>
          <span>Used by Files, Compare, and relative file links.</span>
        </div>
        {loading && <LoaderCircle className="animate-spin" size={15} />}
      </div>
      <label className="thread-worktree-search">
        <Search size={14} strokeWidth={1.8} aria-hidden="true" />
        <Input
          type="search"
          value={query}
          aria-label="Search worktrees"
          placeholder="Search worktrees"
          ref={searchRef}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="thread-worktree-list" role="list" aria-label="Worktrees">
        {primaryVisible && (
          <WorktreeRow
            root={primary}
            current={preferredRootId === null}
            disabled={saving}
            onSelect={() => void selectRoot(primary)}
          />
        )}
        {visibleLinked.map((root) => (
          <WorktreeRow
            key={root.rootId}
            root={root}
            current={root.rootId === preferredRootId}
            disabled={saving}
            onSelect={() => void selectRoot(root)}
            onDelete={
              root.removal.status === "allowed" ||
              root.removal.status === "forget"
                ? () => {
                    setDeleteError("");
                    setOpen(false);
                    setDeleteTarget(root);
                  }
                : undefined
            }
          />
        ))}
        {!loading &&
          !error &&
          !primaryVisible &&
          visibleLinked.length === 0 && (
            <p className="thread-worktree-empty">
              {normalizedQuery
                ? "No matching worktrees."
                : "No linked worktrees."}
            </p>
          )}
      </div>
      {error && (
        <div className="thread-worktree-error" role="alert">
          <span>{error}</span>
          <Button
            variant="outline"
            size="xs"
            disabled={loading}
            onClick={() => void loadRoots(false)}
          >
            Retry
          </Button>
        </div>
      )}
    </>
  );

  return (
    <>
      {mobile ? (
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>{trigger}</DialogTrigger>
          <DialogContent
            onOpenAutoFocus={pickerFocus.onOpenAutoFocus}
            className="thread-settings-sheet thread-worktree-sheet"
            style={{ "--thread-settings-keyboard-inset": `${keyboardInset}px` } as CSSProperties}
            overlayClassName="thread-settings-sheet-overlay"
          >
            <DialogTitle className="sr-only">Thread worktree</DialogTitle>
            <DialogDescription className="sr-only">
              Choose the worktree used by Files, Compare, and relative file
              links.
            </DialogDescription>
            {pickerContent}
          </DialogContent>
        </Dialog>
      ) : (
        <Popover.Root open={open} onOpenChange={handleOpenChange}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
          <Popover.Portal container={dialogContainer}>
            <Popover.Content
              onOpenAutoFocus={pickerFocus.onOpenAutoFocus}
              className="thread-worktree-popover"
              align="start"
              sideOffset={7}
              collisionPadding={8}
              collisionBoundary={dialogContainer ?? undefined}
              aria-label="Choose thread worktree"
            >
              {pickerContent}
              <Popover.Arrow className="popover-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}

      <Dialog
        open={deleteTarget !== undefined}
        onOpenChange={(next) => {
          if (!next && !deleting) setDeleteTarget(undefined);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.removal.status === "allowed"
                ? "Remove linked worktree?"
                : "Forget missing worktree?"}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.removal.status === "allowed" ? (
                <>
                  Remove{" "}
                  <strong>{deleteTarget && worktreeName(deleteTarget)}</strong>{" "}
                  at <code>{removalDisplayPath(deleteTarget)}</code> from disk
                  and from this project’s worktree list? This worktree is{" "}
                  {deleteTarget &&
                    worktreeStatus(deleteTarget, false).toLocaleLowerCase()}
                  {deleteTarget ? ` (${worktreeCounts(deleteTarget)})` : ""}.
                  The Git branch and commits are kept. Only a clean worktree can
                  be removed. Ignored files and build output inside the checkout
                  may still be deleted.
                </>
              ) : (
                <>
                  Forget{" "}
                  <strong>{deleteTarget && worktreeName(deleteTarget)}</strong>{" "}
                  at <code>{deleteTarget?.displayPath.text}</code> from this
                  project’s worktree list? Its directory is already missing.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="thread-worktree-error" role="alert">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => setDeleteTarget(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void deleteWorktree()}
            >
              {deleting
                ? "Working…"
                : deleteTarget?.removal.status === "allowed"
                  ? "Remove worktree"
                  : "Forget worktree"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function removalDisplayPath(root: LinkedWorktree | undefined): string {
  if (!root) return "";
  return root.removal.status === "allowed"
    ? root.removal.displayPath.text
    : root.displayPath.text;
}

function WorktreeRow({
  root,
  current,
  disabled,
  onSelect,
  onDelete,
}: {
  readonly root: WorkspaceFileRootDescriptor;
  readonly current: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
  readonly onDelete?: () => void;
}): React.JSX.Element {
  const status = worktreeStatus(root, current);
  const title = worktreeDetails(root);
  const pathDescriptionId = useId();
  const statusDescriptionId = useId();
  return (
    <div
      className="thread-worktree-row"
      role="listitem"
      data-current={current || undefined}
    >
      <button
        type="button"
        className="thread-worktree-select"
        disabled={disabled || root.availability !== "available"}
        aria-current={current ? "true" : undefined}
        aria-label={`Select ${root.kind === "primary" ? "Primary" : worktreeName(root)}`}
        aria-describedby={`${pathDescriptionId} ${statusDescriptionId}`}
        title={title}
        onClick={onSelect}
      >
        <GitBranch size={15} strokeWidth={1.8} aria-hidden="true" />
        <span className="thread-worktree-row-copy">
          <strong>
            {root.kind === "primary" ? "Primary" : worktreeName(root)}
          </strong>
          <small id={pathDescriptionId}>{root.displayPath.text}</small>
        </span>
        <span id={statusDescriptionId} className="thread-worktree-status">
          {status}
        </span>
      </button>
      {onDelete && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="thread-worktree-delete"
          aria-label={`${root.kind === "linked_worktree" && root.removal.status === "allowed" ? "Remove" : "Forget"} ${worktreeName(root)}`}
          title={`${root.kind === "linked_worktree" && root.removal.status === "allowed" ? "Remove" : "Forget"} worktree`}
          disabled={disabled}
          onClick={onDelete}
        >
          <Trash2 size={14} strokeWidth={1.8} />
        </Button>
      )}
    </div>
  );
}

function worktreeName(root: WorkspaceFileRootDescriptor): string {
  return root.kind === "linked_worktree"
    ? (root.branch ?? root.displayLabel)
    : root.displayLabel;
}

function worktreeStatus(
  root: WorkspaceFileRootDescriptor,
  current: boolean,
): string {
  if (root.kind === "linked_worktree" && root.availability === "unavailable") {
    return root.removal.status === "forget" ? "Missing" : "Unavailable";
  }
  if (current) return "Current";
  if (root.kind === "primary") return "Primary";
  if (root.kind !== "linked_worktree") return "Unknown";
  switch (root.provenance.kind) {
    case "same":
    case "contained":
      return "Merged";
    case "unmerged":
      return "Unmerged";
    case "unknown":
      return "Unknown";
  }
}

function worktreeDetails(root: WorkspaceFileRootDescriptor): string {
  if (root.kind === "primary") return "Primary project directory";
  if (root.kind !== "linked_worktree") return root.displayPath.text;
  if (root.availability === "unavailable") {
    return root.removal.status === "forget"
      ? "Worktree directory is missing"
      : "Worktree is temporarily unavailable";
  }
  const counts = worktreeCounts(root);
  return counts !== "comparison unavailable"
    ? `Compared with Primary: ${counts}`
    : "Compared with Primary";
}

function worktreeCounts(root: WorkspaceFileRootDescriptor): string {
  if (root.kind !== "linked_worktree") return "comparison unavailable";
  const parts = [
    root.provenance.ahead === null
      ? undefined
      : `${root.provenance.ahead} ahead`,
    root.provenance.behind === null
      ? undefined
      : `${root.provenance.behind} behind`,
  ].filter((part): part is string => part !== undefined);
  return parts.join(", ") || "comparison unavailable";
}

function messageFor(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The worktree could not be updated.";
}
