import { usePickerFocus } from "../../lib/use-picker-focus.js";
import {
  Check,
  ChevronDown,
  GitBranch,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  workspaceFileLinkedWorktreeRootIdSchema,
  type NormalizedApplicationThreadSummary,
  type WorkspaceFileRootDescriptor,
} from "../../../shared/index.js";
import type { ApiClient } from "../../api/ApiClient.js";
import { useTouchDensity } from "@client/app/use-touch-density";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import { ConfirmDialog } from "@client/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@client/components/ui/dialog";
import {
  menuDescriptionClass,
  menuEmptyClass,
  menuListRowClass,
  menuRowActionClass,
  menuRowClass,
  menuShortcutClass,
} from "@client/components/ui/floating";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@client/components/ui/popover";
import { SearchableSelectSearch } from "@client/components/ui/searchable-select";
import { moveListFocus } from "@client/lib/list-focus";
import { cn } from "@client/lib/utils";

type LinkedWorktree = WorkspaceFileRootDescriptor & {
  readonly kind: "linked_worktree";
};

interface PendingPreference {
  readonly rootId: ReturnType<
    typeof workspaceFileLinkedWorktreeRootIdSchema.parse
  > | null;
  readonly revision: number;
}

const DESCRIPTION = "Used by Files, Compare, and relative file links.";

/**
 * The thread worktree picker: a header, the plain search row and worktree
 * rows in the menu row anatomy, the current one marked with a trailing
 * check. A popover from the header, or the shared bottom sheet under the
 * density switch. Removable rows carry a muted trailing remove action that
 * asks for confirmation.
 */
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
  const mobile = useTouchDensity();
  const [open, setOpen] = useState(false);
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
  const requestSequence = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pickerFocus = usePickerFocus(searchRef);
  const titleId = useId();

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
  // Rows keep one column for status and check when any row can be removed.
  const removable = (root: LinkedWorktree) =>
    root.removal.status === "allowed" || root.removal.status === "forget";
  const actionColumn = visibleLinked.some(removable);

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

  // ConfirmDialog owns the pending state and shows a rejection inline.
  const deleteWorktree = async () => {
    if (!deleteTarget || !removable(deleteTarget)) return;
    let result: Awaited<ReturnType<typeof api.deleteLinkedWorktree>>;
    try {
      result = await api.deleteLinkedWorktree(
        workspaceId,
        workspaceFileLinkedWorktreeRootIdSchema.parse(deleteTarget.rootId),
        {
          expectedRevision: deleteTarget.revision,
          mutationId: crypto.randomUUID(),
          confirmation: true,
        },
      );
    } catch (cause) {
      throw new Error(messageFor(cause));
    }
    if (result.clearedThreadIds.includes(thread.id)) {
      setPendingPreference({
        rootId: null,
        revision: preferredRevision + 1,
      });
    }
    void loadRoots(true);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
      void loadRoots(roots.length > 0);
    }
  };
  const rowButtons = () =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLElement>(
        '[data-slot="worktree-option"]',
      ) ?? [],
    );
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
  const nothingVisible = !primaryVisible && visibleLinked.length === 0;
  const choices = (
    <>
      <SearchableSelectSearch
        ref={searchRef}
        role="searchbox"
        enterKeyHint="search"
        value={query}
        aria-label="Search worktrees"
        placeholder="Search worktrees"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          if (moveListFocus(rowButtons(), event.key, null)) {
            event.preventDefault();
          }
        }}
      />
      <div
        ref={listRef}
        role="list"
        aria-label="Worktrees"
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain",
          // In the sheet the rows reach into its inset so their icons line
          // up with the title and the search icon.
          mobile ? "-mx-2" : "p-(--menu-panel-padding)",
        )}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (moveListFocus(rowButtons(), event.key)) event.preventDefault();
        }}
      >
        {primaryVisible && (
          <WorktreeRow
            root={primary}
            current={preferredRootId === null}
            disabled={saving}
            actionColumn={actionColumn}
            onSelect={() => void selectRoot(primary)}
          />
        )}
        {visibleLinked.map((root) => (
          <WorktreeRow
            key={root.rootId}
            root={root}
            current={root.rootId === preferredRootId}
            disabled={saving}
            actionColumn={actionColumn}
            onSelect={() => void selectRoot(root)}
            onDelete={
              removable(root)
                ? () => {
                    setOpen(false);
                    setDeleteTarget(root);
                  }
                : undefined
            }
          />
        ))}
        {nothingVisible && loading && (
          <p role="status" className={cn(menuEmptyClass, "m-0")}>
            <LoaderCircle aria-hidden="true" /> Loading worktrees…
          </p>
        )}
        {nothingVisible && !loading && !error && (
          <p className={cn(menuEmptyClass, "m-0")}>
            {normalizedQuery ? "No matching worktrees." : "No linked worktrees."}
          </p>
        )}
      </div>
      {error && (
        <Callout
          tone="danger"
          role="alert"
          className={cn("shrink-0", !mobile && "mx-1 mb-1")}
          action={
            <Button
              variant="outline"
              size="xs"
              disabled={loading}
              onClick={() => void loadRoots(false)}
            >
              Retry
            </Button>
          }
        >
          {error}
        </Callout>
      )}
    </>
  );

  return (
    <>
      {mobile ? (
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>{trigger}</DialogTrigger>
          <DialogContent
            layout="sheet"
            size="md"
            className="searchable-select-sheet"
            onOpenAutoFocus={pickerFocus.onOpenAutoFocus}
          >
            <DialogHeader>
              <DialogTitle>Thread worktree</DialogTitle>
              <DialogDescription>{DESCRIPTION}</DialogDescription>
            </DialogHeader>
            {choices}
          </DialogContent>
        </Dialog>
      ) : (
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent
            align="start"
            aria-labelledby={titleId}
            className="max-h-[min(var(--radix-popover-content-available-height),520px)] w-[min(390px,calc(100vw-16px))] gap-0 overflow-hidden p-0"
            onOpenAutoFocus={pickerFocus.onOpenAutoFocus}
          >
            <div className="flex shrink-0 flex-col gap-0.5 px-3 pt-2.5 pb-2">
              <PopoverTitle id={titleId} className="m-0 leading-5">
                Thread worktree
              </PopoverTitle>
              <PopoverDescription className={cn(menuDescriptionClass, "m-0")}>
                {DESCRIPTION}
              </PopoverDescription>
            </div>
            {choices}
          </PopoverContent>
        </Popover>
      )}

      <ConfirmDialog
        open={deleteTarget !== undefined}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(undefined);
        }}
        tone="danger"
        title={
          deleteTarget?.removal.status === "allowed"
            ? "Remove linked worktree?"
            : "Forget missing worktree?"
        }
        description={
          deleteTarget?.removal.status === "allowed" ? (
            <>
              Remove <strong>{worktreeName(deleteTarget)}</strong> at{" "}
              <code>{deleteTarget.removal.displayPath.text}</code> from disk
              and from this project’s worktree list? This worktree is{" "}
              {linkedStatus(deleteTarget).toLocaleLowerCase()} (
              {worktreeCounts(deleteTarget)}). The Git branch and commits are
              kept. Only a clean worktree can be removed. Ignored files and
              build output inside the checkout may still be deleted.
            </>
          ) : (
            <>
              Forget <strong>{deleteTarget && worktreeName(deleteTarget)}</strong>{" "}
              at <code>{deleteTarget?.displayPath.text}</code> from this
              project’s worktree list? Its directory is already missing.
            </>
          )
        }
        confirmLabel={
          deleteTarget?.removal.status === "allowed"
            ? "Remove worktree"
            : "Forget worktree"
        }
        pendingLabel={
          deleteTarget?.removal.status === "allowed"
            ? "Removing…"
            : "Forgetting…"
        }
        onConfirm={deleteWorktree}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus({ preventScroll: true });
        }}
      />
    </>
  );
}

function WorktreeRow({
  root,
  current,
  disabled,
  actionColumn,
  onSelect,
  onDelete,
}: {
  readonly root: WorkspaceFileRootDescriptor;
  readonly current: boolean;
  readonly disabled: boolean;
  /** Reserve the trailing action column so status and check line up. */
  readonly actionColumn: boolean;
  readonly onSelect: () => void;
  readonly onDelete?: () => void;
}): React.JSX.Element {
  const name = root.kind === "primary" ? "Primary" : worktreeName(root);
  const status = worktreeStatus(root);
  const unavailable = root.availability !== "available";
  const pathDescriptionId = useId();
  const statusDescriptionId = useId();
  const removal =
    root.kind === "linked_worktree" && root.removal.status === "allowed"
      ? "Remove"
      : "Forget";
  return (
    <div role="listitem" className={menuListRowClass}>
      <button
        type="button"
        data-slot="worktree-option"
        className={cn(menuRowClass, "w-auto min-w-0 flex-1")}
        disabled={disabled || unavailable}
        data-disabled={unavailable || undefined}
        aria-current={current ? "true" : undefined}
        aria-label={`Select ${name}`}
        aria-describedby={
          status === undefined
            ? pathDescriptionId
            : `${pathDescriptionId} ${statusDescriptionId}`
        }
        title={worktreeDetails(root)}
        onClick={onSelect}
      >
        <GitBranch aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{name}</span>
          <span
            id={pathDescriptionId}
            data-slot="worktree-item-description"
            className={cn(menuDescriptionClass, "truncate")}
          >
            {root.displayPath.text}
          </span>
        </span>
        {status !== undefined && (
          <span id={statusDescriptionId} className={cn(menuShortcutClass, "mt-0.5")}>
            {status}
          </span>
        )}
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          {current && <Check className="text-foreground" aria-hidden="true" />}
        </span>
      </button>
      {onDelete ? (
        <button
          type="button"
          data-variant="destructive"
          className={menuRowActionClass}
          aria-label={`${removal} ${name}`}
          title={`${removal} worktree`}
          disabled={disabled}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" />
        </button>
      ) : (
        actionColumn && (
          <span aria-hidden="true" className="size-(--menu-row-height) shrink-0" />
        )
      )}
    </div>
  );
}

function worktreeName(root: WorkspaceFileRootDescriptor): string {
  return root.kind === "linked_worktree"
    ? (root.branch ?? root.displayLabel)
    : root.displayLabel;
}

/** A linked worktree's state next to its name; the check marks the current one. */
function worktreeStatus(root: WorkspaceFileRootDescriptor): string | undefined {
  return root.kind === "linked_worktree" ? linkedStatus(root) : undefined;
}

function linkedStatus(root: LinkedWorktree): string {
  if (root.availability === "unavailable") {
    return root.removal.status === "forget" ? "Missing" : "Unavailable";
  }
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
