import { runThreadCreation, runThreadFork } from "../operations/thread-creation.js";
import { useEffect, useRef, useState } from "react";
import type {
  NormalizedApplicationThreadSummary,
  NormalizedThreadForkOrigin,
  NormalizedThreadLineagePlacement,
  OpenTaskDisposition,
  ThreadArchiveImpact,
} from "../../shared/index.js";
import { DEFAULT_THREAD_TITLE } from "../../shared/index.js";
import { navigate, threadAutomationPath } from "../app/router.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import type {
  ThreadClientState,
  ThreadClientStore,
} from "../stores/ThreadClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import { useTouchDensity } from "../app/use-touch-density.js";
import { shortRelativeTime } from "../lib/time.js";
import { latestTurnForkDecision } from "../lineage/latest-turn-fork.js";
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowDownToDot,
  ArrowUpFromDot,
  CalendarClock,
  Copy,
  CopyPlus,
  CornerUpLeft,
  GitCommitVertical,
  Hash,
  IndentDecrease,
  IndentIncrease,
  PencilLine,
  Pin,
  PinOff,
  RotateCcw,
  Server,
  Split,
} from "lucide-react";
import { SnoozeDialog } from "./thread/SnoozeDialog.js";
import {
  THREAD_CONFIGURATION_COPY_LABEL,
  THREAD_CONFIGURATION_COPY_PENDING_ACCESSIBLE_LABEL,
  THREAD_CONFIGURATION_COPY_TITLE,
} from "./thread/thread-configuration-copy-labels.js";
import { useArchiveThreadAction } from "./thread/ArchiveChoicesDialog.js";
import { ForceResetDialog } from "./thread/ForceResetDialog.js";
import {
  ExecutionWorkspaceDeleteDialog,
  type IsolatedWorkspace,
} from "./thread/ExecutionWorkspaceActions.js";
import { ExecutionWorkspaceMenu } from "./thread/ExecutionWorkspaceMenu.js";
import { contextMenuParts } from "./thread/menu-parts.js";
import {
  SettleImpactDialog,
  settleNeedsConfirmation,
} from "./thread/SettleImpactDialog.js";
import { MoveToGroupSubmenu, NewGroupDialog } from "./MoveToGroupMenu.js";
import {
  configuredPanelPresentation,
  openThreadRoute,
} from "../workspace-panels/thread-panel-navigation.js";
import { initialFocusTarget } from "@client/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuValue,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@client/components/ui/context-menu";

type InventoryContextAction =
  "settle" | "unsettle" | "wake" | "archive" | "restore";

// Match the 240ms dialog exit motion before installing a sibling modal root.
const SHEET_DIALOG_HANDOFF_DELAY_MS = 260;

/** "sedes · Claude · updated 12m ago": the row's project, backend and age. */
function threadMetaLine(
  thread: NormalizedApplicationThreadSummary,
  projectLabel: string | undefined,
): string {
  const age = shortRelativeTime(thread.lastActivityAt);
  return [
    projectLabel,
    thread.backend.label.text,
    age === "now" ? "updated just now" : `updated ${age} ago`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Context menu for inventory thread rows (right-click, or a long press that
 * opens the same rows as a bottom sheet under the touch density). Offers
 * inventory mutations, navigation, and latest-turn forking. The fork command
 * briefly retains the normalized thread store while the menu is open because
 * summaries intentionally carry no per-turn capabilities. Other
 * open-thread-dependent actions (stats, compact, move draft) stay in the
 * thread-actions menu, which uses the same groups and order. The server
 * remains authoritative for every mutation.
 */
export function ThreadContextMenu({
  thread,
  store,
  onRename,
  disabled = false,
  onAction,
  onArchiveFamily,
  onNavigate,
  children,
  returnFocusRef,
  origin,
  sourceTitle,
  placement,
  threadRegistry,
  familyDescendantCount = 0,
  configurationCopyPending: sharedConfigurationCopyPending = false,
  onInteractionOpenChange,
}: {
  thread: NormalizedApplicationThreadSummary;
  store: ApplicationClientStore;
  /** Swaps the row title to an inline edit input (sidebar rows only). */
  onRename?: () => void;
  /** Leave native input gestures available while the row is being edited. */
  disabled?: boolean;
  /** Notified after a lifecycle action is accepted by the server. */
  onAction?: (action: InventoryContextAction) => void;
  /** Notified when archive-all accepts the complete server-resolved family. */
  onArchiveFamily?: (archivedThreadIds: readonly string[]) => void;
  onNavigate?: () => void;
  children: React.ReactNode;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  origin?: NormalizedThreadForkOrigin;
  sourceTitle?: string;
  placement?: NormalizedThreadLineagePlacement;
  /** Present for live sidebar rows; archive-only contexts cannot be forked. */
  threadRegistry?: ThreadStoreRegistry;
  /** Authoritative principal-scoped count from the application snapshot. */
  familyDescendantCount?: number;
  /** Application-store pending state shared with the header action surface. */
  configurationCopyPending?: boolean;
  /** Reports portaled menu/dialog activity to an enclosing interactive surface. */
  onInteractionOpenChange?: (open: boolean) => void;
}): React.JSX.Element {
  // Under the density switch the menu is a bottom sheet with 44px rows.
  const sheet = useTouchDensity();
  // Inventory parents already subscribe to the application store. Reading the
  // current snapshot here avoids adding a second subscription requirement to
  // this reusable menu (whose focused test stores intentionally implement only
  // the commands they exercise).
  const application =
    typeof store.getSnapshot === "function" ? store.getSnapshot() : undefined;
  const targetWorkspaceExecution = application?.snapshot?.executionTargets.find(
    ({ id }) => id === thread.targetId,
  )?.workspaceExecution.kind;
  const projectLabel = application?.snapshot?.workspaces?.find(
    ({ id }) => id === thread.workspaceId,
  )?.label.text;
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [forceResetOpen, setForceResetOpen] = useState(false);
  const [settleChoicesOpen, setSettleChoicesOpen] = useState(false);
  const [settleImpact, setSettleImpact] = useState<ThreadArchiveImpact>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [workspaceDeleteTarget, setWorkspaceDeleteTarget] =
    useState<IsolatedWorkspace>();
  const [workspaceDeletePending, setWorkspaceDeletePending] = useState(false);
  const [workspaceDeleteError, setWorkspaceDeleteError] = useState("");
  const [pendingAction, setPendingAction] = useState<InventoryContextAction>();
  const [actionError, setActionError] = useState("");
  // Archive directly when the authoritative impact leaves nothing to decide;
  // otherwise the choices dialog opens with that impact.
  const archiveAction = useArchiveThreadAction({
    thread,
    store,
    descendantCount: familyDescendantCount,
    disabled: pendingAction !== undefined,
    onPendingChange: (pending) =>
      setPendingAction(pending ? "archive" : undefined),
    onArchived: (choice, archivedThreadIds) => {
      onAction?.("archive");
      if (choice === "all") onArchiveFamily?.(archivedThreadIds);
    },
    returnFocusRef,
  });
  const [pinPending, setPinPending] = useState(false);
  // "New group…" opens the create dialog with this prefill; closed when undefined.
  const [newGroupName, setNewGroupName] = useState<string>();
  const newGroupDialogRef = useRef<HTMLDivElement>(null);
  const interactionOpen =
    menuOpen ||
    newGroupName !== undefined ||
    snoozeOpen ||
    archiveAction.open ||
    forceResetOpen ||
    settleChoicesOpen ||
    workspaceDeleteTarget !== undefined;
  useEffect(() => {
    onInteractionOpenChange?.(interactionOpen);
  }, [interactionOpen, onInteractionOpenChange]);
  const [groupPending, setGroupPending] = useState(false);
  const [placementPending, setPlacementPending] = useState(false);
  const [localConfigurationCopyPending, setConfigurationCopyPending] =
    useState(false);
  const configurationCopyPending =
    localConfigurationCopyPending || sharedConfigurationCopyPending;
  const [forkState, setForkState] = useState<ThreadClientState>();
  const forkStore = useRef<ThreadClientStore | undefined>(undefined);
  const forkUnsubscribe = useRef<(() => void) | undefined>(undefined);
  const afterSheetClose = useRef<{
    action: () => void;
    release: () => void;
  } | undefined>(undefined);
  // Rename swaps the row into an autofocused input, so it must start only
  // AFTER the menu has fully closed: entering edit mode from onSelect races
  // the menu teardown (focus restore blurs the input, and blur commits).
  const renameRequested = useRef(false);
  const performMutation = async (
    action: InventoryContextAction,
    options?: {
      readonly openTaskDisposition?: OpenTaskDisposition;
      readonly expectedOpenTaskSnapshot?: string;
      readonly expectedStashedPromptCount?: number;
    },
  ) => {
    if (pendingAction) return;
    setPendingAction(action);
    setActionError("");
    try {
      await (options
        ? store.mutateInventory(thread, action, options)
        : store.mutateInventory(thread, action));
      onAction?.(action);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The thread could not be updated.",
      );
      throw error;
    } finally {
      setPendingAction(undefined);
    }
  };
  const mutate = (action: InventoryContextAction) => {
    void performMutation(action).catch(() => undefined);
  };
  const togglePin = () => {
    if (pinPending) return;
    setPinPending(true);
    setActionError("");
    void store
      .setThreadPinned(thread, !thread.pinned)
      .catch((error: unknown) =>
        setActionError(
          error instanceof Error
            ? error.message
            : "The thread pin could not be updated.",
        ),
      )
      .finally(() => setPinPending(false));
  };
  const requestSettle = () => {
    if (pendingAction) return;
    setPendingAction("settle");
    setActionError("");
    void store
      .getThreadArchiveImpact(thread.id)
      .then(async (impact) => {
        if (!settleNeedsConfirmation(impact)) {
          await store.mutateInventory(thread, "settle", {
            expectedStashedPromptCount: 0,
          });
          onAction?.("settle");
          return;
        }
        setSettleImpact(impact);
        setSettleChoicesOpen(true);
      })
      .catch((error: unknown) =>
        setActionError(
          error instanceof Error
            ? error.message
            : "Unfinished work could not be checked.",
        ),
      )
      .finally(() => setPendingAction(undefined));
  };
  const archiveThread = () => {
    if (pendingAction) return;
    setActionError("");
    archiveAction.start();
  };
  const archived = thread.inventoryState === "archived";
  const latestFork = latestTurnForkDecision(forkState);
  const forkUnavailableDescriptionId = `sidebar-fork-unavailable-${thread.id}`;

  useEffect(() => {
    if (!menuOpen || !threadRegistry) return;
    const retained = threadRegistry.retain(thread.id);
    forkStore.current = retained;
    setForkState(retained.getSnapshot());
    forkUnsubscribe.current = retained.subscribe(() => {
      setForkState(retained.getSnapshot());
    });
    return () => {
      forkUnsubscribe.current?.();
      forkUnsubscribe.current = undefined;
      threadRegistry.release(thread.id);
      forkStore.current = undefined;
      setForkState(undefined);
    };
  }, [menuOpen, thread.id, threadRegistry]);

  useEffect(
    () => () => {
      afterSheetClose.current?.release();
      afterSheetClose.current = undefined;
    },
    [],
  );

  /**
   * On the sheet, an action that opens a dialog, an overlay or the inline
   * rename waits for the sheet to close: its row closes the sheet, and the
   * action runs once the sheet's modal layer has gone.
   */
  const afterSheet = (action: () => void) => {
    if (!sheet) {
      action();
      return;
    }
    afterSheetClose.current?.release();
    // Preserve the menu's live source until the deferred action takes ownership.
    // Otherwise an inactive sidebar thread pauses as the sheet unmounts.
    const owner = forkStore.current ? threadRegistry : undefined;
    owner?.retain(thread.id);
    let released = false;
    afterSheetClose.current = {
      action,
      release: () => {
        if (released) return;
        released = true;
        owner?.release(thread.id);
      },
    };
  };

  useEffect(() => {
    if (menuOpen || !afterSheetClose.current) return;
    const pending = afterSheetClose.current;
    afterSheetClose.current = undefined;
    // Run only after React has committed the closed state and Radix has
    // unmounted the sheet's modal guards.
    const timer = setTimeout(() => {
      try {
        pending.action();
      } finally {
        pending.release();
      }
    }, SHEET_DIALOG_HANDOFF_DELAY_MS);
    return () => {
      clearTimeout(timer);
      pending.release();
    };
  }, [menuOpen]);

  const forkLatest = () => {
    if (!threadRegistry || !latestFork.available || !latestFork.selection)
      return;
    const selection = latestFork.selection;
    void runThreadFork({
      retainSource: () => {
        threadRegistry.retain(thread.id);
        return () => threadRegistry.release(thread.id);
      },
      fork: (restart) => {
        const retained = threadRegistry.get(thread.id);
        return selection.boundary === "latest_provider_snapshot"
          ? retained.forkLatestProviderSnapshot({ restart })
          : retained.forkTurn(selection.capability, { restart });
      },
      restart: latestFork.restart,
      presentation: configuredPanelPresentation(),
      onNavigate,
    });
  };
  const createWithSameSettings = () => {
    if (configurationCopyPending) return;
    setConfigurationCopyPending(true);
    void runThreadCreation({
      message: "Creating thread…",
      create: async () => (await store.createThreadFromSettings(thread.id, {
        title: DEFAULT_THREAD_TITLE,
      })).threadId,
      presentation: configuredPanelPresentation(),
      onNavigate,
    }).finally(() => setConfigurationCopyPending(false));
  };
  const groupCatalog = application?.snapshot?.groups ?? [];
  const mutateGroup = (operation: () => Promise<unknown>) => {
    if (groupPending) return;
    setGroupPending(true);
    setActionError("");
    void operation()
      .catch((error: unknown) =>
        setActionError(
          error instanceof Error
            ? error.message
            : "The thread group could not be updated.",
        ),
      )
      .finally(() => setGroupPending(false));
  };
  /** The create dialog, prefilled with the search text or the thread's title. */
  const openNewGroup = (name: string) => {
    setActionError("");
    setNewGroupName(name || thread.title.text || "Untitled thread");
  };
  const copySessionId = (id: string) => {
    setActionError("");
    void (async () => {
      try {
        if (typeof navigator.clipboard?.writeText !== "function") {
          throw new Error("Clipboard access is unavailable.");
        }
        await navigator.clipboard.writeText(id);
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : "The session ID could not be copied.",
        );
      }
    })();
  };
  const togglePlacement = () => {
    if (!placement || placementPending || !origin?.sourceThreadId) return;
    setPlacementPending(true);
    setActionError("");
    void store
      .updateLineagePlacement(
        placement,
        placement.mode === "nested_under_source"
          ? "top_level"
          : "nested_under_source",
      )
      .catch((error: unknown) =>
        setActionError(
          error instanceof Error
            ? error.message
            : "The lineage placement could not be updated.",
        ),
      )
      .finally(() => setPlacementPending(false));
  };
  const backendSessionId = thread.backendSessionId;
  const lineage = !archived && origin && placement ? origin : undefined;
  const forkShortReason =
    latestFork.attempt?.phase === "pending"
      ? "Forking…"
      : !forkState || forkState.status === "loading" || !forkState.snapshot
        ? "Loading…"
        : "Unavailable";
  const title = thread.title.text || "Untitled thread";

  const organizeGroup = (
    <>
      {!archived && onRename && (
        <ContextMenuItem
          onSelect={
            sheet
              ? () => afterSheet(onRename)
              : () => {
                  renameRequested.current = true;
                }
          }
        >
          <PencilLine aria-hidden="true" />
          Rename
        </ContextMenuItem>
      )}
      {!archived && (
        <ContextMenuItem disabled={pinPending} onSelect={togglePin}>
          {thread.pinned ? (
            <PinOff aria-hidden="true" />
          ) : (
            <Pin aria-hidden="true" />
          )}
          {thread.pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
      )}
      <MoveToGroupSubmenu
        groups={groupCatalog}
        currentGroupId={thread.groupId}
        disabled={groupPending}
        sheet={sheet}
        onAssign={(groupId) =>
          mutateGroup(() => store.assignThreadGroup(thread, groupId))
        }
        onCreate={(name) =>
          mutateGroup(() => store.createThreadGroup(thread, name))
        }
        onNewGroup={(name) => afterSheet(() => openNewGroup(name))}
        onRemove={() => mutateGroup(() => store.removeThreadGroup(thread))}
      />
      {lineage && placement && (
        <ContextMenuItem
          disabled={placementPending || !lineage.sourceThreadId}
          onSelect={togglePlacement}
        >
          {placement.mode === "nested_under_source" ? (
            <IndentDecrease aria-hidden="true" />
          ) : (
            <IndentIncrease aria-hidden="true" />
          )}
          {placement.mode === "nested_under_source"
            ? "Show as top-level"
            : "Group under source"}
        </ContextMenuItem>
      )}
    </>
  );

  const lifecycleGroup = archived ? (
    <ContextMenuItem onSelect={() => mutate("restore")}>
      <ArchiveRestore aria-hidden="true" />
      Restore to Active
    </ContextMenuItem>
  ) : (
    <>
      {thread.inventoryState === "settled" ? (
        <ContextMenuItem onSelect={() => mutate("unsettle")}>
          <ArrowUpFromDot aria-hidden="true" />
          Unsettle
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onSelect={() => afterSheet(requestSettle)}>
          <ArrowDownToDot aria-hidden="true" />
          Settle
        </ContextMenuItem>
      )}
      {thread.inventoryState === "snoozed" ? (
        <ContextMenuItem onSelect={() => mutate("wake")}>
          <AlarmClockOff aria-hidden="true" />
          Wake now
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onSelect={() => afterSheet(() => setSnoozeOpen(true))}>
          <AlarmClock aria-hidden="true" />
          Snooze…
        </ContextMenuItem>
      )}
      {thread.automation && (
        <ContextMenuItem
          onSelect={() => {
            navigate(threadAutomationPath(thread.id));
            onNavigate?.();
          }}
        >
          <CalendarClock aria-hidden="true" />
          Automation settings…
        </ContextMenuItem>
      )}
    </>
  );

  const createGroup = (
    <>
      <ContextMenuItem
        disabled={configurationCopyPending || !thread.available}
        aria-label={
          configurationCopyPending
            ? THREAD_CONFIGURATION_COPY_PENDING_ACCESSIBLE_LABEL
            : undefined
        }
        aria-describedby={
          !thread.available
            ? `sidebar-settings-copy-unavailable-${thread.id}`
            : undefined
        }
        title={THREAD_CONFIGURATION_COPY_TITLE}
        onSelect={() => afterSheet(createWithSameSettings)}
      >
        <CopyPlus aria-hidden="true" />
        {configurationCopyPending
          ? "Creating thread…"
          : THREAD_CONFIGURATION_COPY_LABEL}
        {!thread.available && (
          <ContextMenuValue aria-hidden="true">Unavailable</ContextMenuValue>
        )}
      </ContextMenuItem>
      {threadRegistry && (
        <ContextMenuItem
          disabled={!latestFork.available}
          aria-describedby={
            !latestFork.available && latestFork.unavailableReason
              ? forkUnavailableDescriptionId
              : undefined
          }
          title={latestFork.unavailableReason}
          onSelect={() => afterSheet(forkLatest)}
        >
          <Split className="fork-split-icon" aria-hidden="true" />
          {latestFork.label}
          {!latestFork.available && (
            <ContextMenuValue aria-hidden="true">
              {forkShortReason}
            </ContextMenuValue>
          )}
        </ContextMenuItem>
      )}
      {lineage?.sourceThreadId && (
        <ContextMenuItem
          onSelect={() => {
            openThreadRoute(
              lineage.sourceThreadId!,
              configuredPanelPresentation(),
            );
            onNavigate?.();
          }}
        >
          <CornerUpLeft aria-hidden="true" />
          <span className="thread-action-label">
            Open source
            {sourceTitle ? (
              <span className="thread-action-dynamic-label">
                {` “${sourceTitle}”`}
              </span>
            ) : null}
          </span>
        </ContextMenuItem>
      )}
      {lineage?.sourceThreadId && lineage.sourceTurnId && (
        <ContextMenuItem
          onSelect={() => {
            openThreadRoute(
              lineage.sourceThreadId!,
              configuredPanelPresentation(),
              lineage.sourceTurnId!,
            );
            onNavigate?.();
          }}
        >
          <GitCommitVertical aria-hidden="true" />
          Open fork point
        </ContextMenuItem>
      )}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Copy aria-hidden="true" />
          Copy ID
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem
            title="Copy the Sedes thread ID"
            onSelect={() => copySessionId(thread.id)}
          >
            <Hash aria-hidden="true" />
            Thread ID
            <ContextMenuValue aria-hidden="true">
              {thread.id.slice(0, 8)}
            </ContextMenuValue>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!backendSessionId}
            title={
              backendSessionId
                ? "Copy the backend session ID"
                : "The backend session ID is unavailable until the thread starts"
            }
            onSelect={() => {
              if (backendSessionId) copySessionId(backendSessionId);
            }}
          >
            <Server aria-hidden="true" />
            Backend ID
            <ContextMenuValue aria-hidden="true">
              {backendSessionId ? backendSessionId.slice(0, 8) : "Unavailable"}
            </ContextMenuValue>
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {!archived && (
        <ExecutionWorkspaceMenu
          parts={contextMenuParts}
          threadId={thread.id}
          store={store}
          active={menuOpen}
          disabled={pendingAction !== undefined}
          knownDirect={targetWorkspaceExecution === "direct_only"}
          onRequestDelete={(workspace) =>
            afterSheet(() => {
              setWorkspaceDeleteError("");
              setWorkspaceDeleteTarget(workspace);
            })
          }
        />
      )}
    </>
  );

  return (
    <>
      <ContextMenu
        presentation={sheet ? "sheet" : "menu"}
        onOpenChange={(open) => {
          if (open) onInteractionOpenChange?.(true);
          setMenuOpen(open);
        }}
      >
        <ContextMenuTrigger asChild disabled={disabled}>
          <span
            className="thread-context-trigger"
            aria-busy={configurationCopyPending || undefined}
          >
            {children}
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent
          data-testid={sheet ? "thread-actions-sheet" : "thread-context-menu"}
          aria-label={`Actions for ${title}`}
          sheetTitle={title}
          sheetDescription={threadMetaLine(thread, projectLabel)}
          onCloseAutoFocus={(event) => {
            if (afterSheetClose.current) {
              // A deferred action (a dialog, the rename field) takes focus.
              event.preventDefault();
              return;
            }
            if (newGroupName !== undefined) {
              // The create dialog opened from the submenu owns focus.
              event.preventDefault();
              const dialog = newGroupDialogRef.current;
              if (dialog && !dialog.contains(document.activeElement)) {
                initialFocusTarget(dialog).focus({ preventScroll: true });
              }
              return;
            }
            if (renameRequested.current) {
              renameRequested.current = false;
              event.preventDefault();
              onRename?.();
            }
          }}
        >
          {!sheet && (
            <>
              <ContextMenuLabel
                variant="header"
                description={threadMetaLine(thread, projectLabel)}
              >
                {title}
              </ContextMenuLabel>
              <ContextMenuSeparator />
            </>
          )}
          {organizeGroup}
          <ContextMenuSeparator />
          {lifecycleGroup}
          <ContextMenuSeparator />
          {createGroup}
          {!archived && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={pendingAction !== undefined}
                onSelect={() => afterSheet(archiveThread)}
              >
                <Archive aria-hidden="true" />
                Archive
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onSelect={() => afterSheet(() => setForceResetOpen(true))}
              >
                <RotateCcw aria-hidden="true" />
                Force reset…
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <NewGroupDialog
        open={newGroupName !== undefined}
        initialName={newGroupName ?? ""}
        groups={groupCatalog}
        contentRef={newGroupDialogRef}
        returnFocusRef={returnFocusRef}
        onOpenChange={(open) => {
          if (!open) setNewGroupName(undefined);
        }}
        onCreate={(name) => store.createThreadGroup(thread, name)}
      />
      {!thread.available && (
        <span
          id={`sidebar-settings-copy-unavailable-${thread.id}`}
          className="sr-only"
        >
          The source thread target is unavailable.
        </span>
      )}
      {!latestFork.available && latestFork.unavailableReason && (
        <span id={forkUnavailableDescriptionId} className="sr-only">
          {latestFork.unavailableReason}
        </span>
      )}
      {archiveAction.dialog}
      <ForceResetDialog
        open={forceResetOpen}
        onOpenChange={setForceResetOpen}
        loadImpact={() => store.getThreadForceResetImpact(thread.id)}
        onForceReset={(impact, mutationId) =>
          store
            .forceResetThread(thread.id, impact.blockerFingerprint, mutationId)
            .then(() => undefined)
        }
        returnFocusRef={returnFocusRef}
      />
      <SettleImpactDialog
        open={settleChoicesOpen}
        onOpenChange={setSettleChoicesOpen}
        impact={settleImpact}
        loadImpact={() => store.getThreadArchiveImpact(thread.id)}
        onSettle={(options) =>
          performMutation("settle", options).then(() => undefined)
        }
        returnFocusRef={returnFocusRef}
      />
      <SnoozeDialog
        open={snoozeOpen}
        onOpenChange={setSnoozeOpen}
        onSnooze={(options) => store.mutateInventory(thread, "snooze", options)}
        onRemindNow={(wakeReminder) =>
          store.mutateInventory(thread, "remind", { wakeReminder })
        }
        returnFocusRef={returnFocusRef}
      />
      <ExecutionWorkspaceDeleteDialog
        workspace={workspaceDeleteTarget}
        returnFocusRef={returnFocusRef}
        open={workspaceDeleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setWorkspaceDeleteTarget(undefined);
        }}
        pending={workspaceDeletePending}
        error={workspaceDeleteError}
        onDelete={() => {
          if (!workspaceDeleteTarget || workspaceDeletePending) return;
          setWorkspaceDeletePending(true);
          setWorkspaceDeleteError("");
          void store
            .deleteThreadExecutionWorkspace(
              thread.id,
              workspaceDeleteTarget.allocationRevision,
            )
            .then(() => setWorkspaceDeleteTarget(undefined))
            .catch((error: unknown) =>
              setWorkspaceDeleteError(
                error instanceof Error
                  ? error.message
                  : "The isolated workspace could not be deleted.",
              ),
            )
            .finally(() => setWorkspaceDeletePending(false));
        }}
      />
      {actionError && (
        <p className="thread-row-error" role="alert">
          {actionError}
        </p>
      )}
    </>
  );
}
