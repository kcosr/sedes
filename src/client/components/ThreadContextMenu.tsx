import { useKeyboardInset } from "../app/use-keyboard-inset.js";
import { usePickerFocus } from "../lib/use-picker-focus.js";
import { runThreadCreation, runThreadFork } from "../operations/thread-creation.js";
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { useMediaQuery } from "../app/use-media-query.js";
import { SIDEBAR_NAV_MEDIA_QUERY } from "./SidebarNavTrigger.js";
import { latestTurnForkDecision } from "../lineage/latest-turn-fork.js";
import {
  ArrowDownToDot,
  ArrowUpFromDot,
  Clock,
  Copy,
  CopyPlus,
  Pin,
  PinOff,
  PencilLine,
  RotateCcw,
  Split,
  Layers3,
} from "lucide-react";
import { SnoozeDialog } from "./thread/SnoozeDialog.js";
import {
  THREAD_CONFIGURATION_COPY_ACCESSIBLE_LABEL,
  THREAD_CONFIGURATION_COPY_LABEL,
  THREAD_CONFIGURATION_COPY_PENDING_ACCESSIBLE_LABEL,
  THREAD_CONFIGURATION_COPY_TITLE,
} from "./thread/thread-configuration-copy-labels.js";
import { ArchiveContextSubmenu } from "./thread/ArchiveThreadChoices.js";
import { ArchiveChoicesDialog } from "./thread/ArchiveChoicesDialog.js";
import { ForceResetDialog } from "./thread/ForceResetDialog.js";
import {
  ExecutionWorkspaceActions,
  ExecutionWorkspaceDeleteDialog,
  type IsolatedWorkspace,
} from "./thread/ExecutionWorkspaceActions.js";
import {
  SettleImpactDialog,
  settleNeedsConfirmation,
} from "./thread/SettleImpactDialog.js";
import { Button } from "@client/components/ui/button";
import { Input } from "@client/components/ui/input";
import { SearchableSelectList } from "@client/components/ui/searchable-select";
import {
  configuredPanelPresentation,
  openThreadRoute,
} from "../workspace-panels/thread-panel-navigation.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@client/components/ui/context-menu";

type InventoryContextAction =
  "settle" | "unsettle" | "wake" | "archive" | "restore";

const LONG_PRESS_MENU_DELAY_MS = 550;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const TOUCH_CONTEXT_MENU_SUPPRESSION_MS = 1_000;
// Match the 240ms dialog exit motion before installing a sibling modal root.
const SHEET_DIALOG_HANDOFF_DELAY_MS = 260;

type ThreadActionVariant = "default" | "destructive";

interface ThreadActionDefinition {
  readonly id: string;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly variant?: ThreadActionVariant;
  readonly ariaLabel?: string;
  readonly ariaDescribedBy?: string;
  readonly title?: string;
  readonly onInvoke: () => void;
  readonly onDesktopInvoke?: () => void;
  readonly deferUntilSheetCloses?: boolean;
  readonly desktopContent?: ReactNode;
}

interface ThreadActionGroup {
  readonly id: string;
  readonly actions?: readonly ThreadActionDefinition[];
  readonly supplementalContent?: ReactNode;
}

function DesktopThreadActions({
  groups,
}: {
  readonly groups: readonly ThreadActionGroup[];
}): React.JSX.Element {
  return (
    <>
      {groups.map((group, groupIndex) => (
        <Fragment key={group.id}>
          {groupIndex > 0 && <ContextMenuSeparator />}
          {group.actions?.map((action) =>
            action.desktopContent ? (
              <Fragment key={action.id}>{action.desktopContent}</Fragment>
            ) : (
              <ContextMenuItem
                key={action.id}
                disabled={action.disabled}
                variant={action.variant}
                aria-label={action.ariaLabel}
                aria-describedby={action.ariaDescribedBy}
                title={action.title}
                onSelect={action.onDesktopInvoke ?? action.onInvoke}
              >
                {action.icon}
                <span className="thread-action-label">{action.label}</span>
              </ContextMenuItem>
            ),
          )}
          {group.supplementalContent}
        </Fragment>
      ))}
    </>
  );
}

function MobileThreadActions({
  groups,
  invoke,
}: {
  readonly groups: readonly ThreadActionGroup[];
  readonly invoke: (action: ThreadActionDefinition) => void;
}): React.JSX.Element {
  return (
    <>
      {groups.map((group, groupIndex) => (
        <section className="thread-action-sheet-group" key={group.id}>
          {groupIndex > 0 && <div role="separator" />}
          {group.actions?.map((action) => (
            <Button
              key={action.id}
              variant={
                action.variant === "destructive" ? "destructive" : "ghost"
              }
              disabled={action.disabled}
              aria-label={action.ariaLabel}
              aria-describedby={action.ariaDescribedBy}
              title={action.title}
              onClick={() => invoke(action)}
            >
              {action.icon}
              <span className="thread-action-label">{action.label}</span>
            </Button>
          ))}
          {group.supplementalContent}
        </section>
      ))}
    </>
  );
}

/**
 * Context menu for inventory thread rows (right-click or touch long-press).
 * Offers inventory mutations, navigation, and latest-turn forking. The fork
 * command briefly retains the normalized thread store while the menu is open
 * because summaries intentionally carry no per-turn capabilities. Other
 * open-thread-dependent actions (stats, compact, move draft) stay in the
 * thread-actions menu. The server remains authoritative for every mutation.
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
  const mobileLayout = useMediaQuery(SIDEBAR_NAV_MEDIA_QUERY);
  // Inventory parents already subscribe to the application store. Reading the
  // current snapshot here avoids adding a second subscription requirement to
  // this reusable menu (whose focused test stores intentionally implement only
  // the commands they exercise).
  const application =
    typeof store.getSnapshot === "function" ? store.getSnapshot() : undefined;
  const targetWorkspaceExecution = application?.snapshot?.executionTargets.find(
    ({ id }) => id === thread.targetId,
  )?.workspaceExecution.kind;
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [archiveChoicesOpen, setArchiveChoicesOpen] = useState(false);
  const [forceResetOpen, setForceResetOpen] = useState(false);
  const [settleChoicesOpen, setSettleChoicesOpen] = useState(false);
  const [settleImpact, setSettleImpact] = useState<ThreadArchiveImpact>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [workspaceDeleteTarget, setWorkspaceDeleteTarget] =
    useState<IsolatedWorkspace>();
  const [workspaceDeletePending, setWorkspaceDeletePending] = useState(false);
  const [workspaceDeleteError, setWorkspaceDeleteError] = useState("");
  const [pendingAction, setPendingAction] = useState<InventoryContextAction>();
  const [actionError, setActionError] = useState("");
  const [pinPending, setPinPending] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const groupKeyboardInset = useKeyboardInset(groupDialogOpen);
  const groupSearchRef = useRef<HTMLInputElement>(null);
  const groupDialogRef = useRef<HTMLDivElement>(null);
  const groupPickerFocus = usePickerFocus(groupSearchRef);
  const interactionOpen =
    menuOpen ||
    sheetOpen ||
    groupDialogOpen ||
    snoozeOpen ||
    archiveChoicesOpen ||
    forceResetOpen ||
    settleChoicesOpen ||
    workspaceDeleteTarget !== undefined;
  useEffect(() => {
    onInteractionOpenChange?.(interactionOpen);
  }, [interactionOpen, onInteractionOpenChange]);
  const [groupName, setGroupName] = useState(thread.title.text);
  const [groupPending, setGroupPending] = useState(false);
  const [placementPending, setPlacementPending] = useState(false);
  const [localConfigurationCopyPending, setConfigurationCopyPending] =
    useState(false);
  const configurationCopyPending =
    localConfigurationCopyPending || sharedConfigurationCopyPending;
  const [forkState, setForkState] = useState<ThreadClientState>();
  const forkStore = useRef<ThreadClientStore | undefined>(undefined);
  const forkUnsubscribe = useRef<(() => void) | undefined>(undefined);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const suppressClickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const longPressOrigin = useRef<{ x: number; y: number } | undefined>(
    undefined,
  );
  const suppressContextMenuUntil = useRef(0);
  const latestPointerType = useRef<string | undefined>(undefined);
  const afterSheetClose = useRef<{
    action: () => void;
    release: () => void;
  } | undefined>(undefined);
  const suppressNextClick = useRef(false);
  // Rename swaps the row into an autofocused input, so it must start only
  // AFTER the menu has fully closed: entering edit mode from onSelect races
  // the menu teardown (focus restore blurs the input, and blur commits).
  const renameRequested = useRef(false);
  const performMutation = async (
    action: InventoryContextAction,
    options?: {
      readonly openTaskDisposition?: OpenTaskDisposition;
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
        setMenuOpen(false);
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
  const archived = thread.inventoryState === "archived";
  const latestFork = latestTurnForkDecision(forkState);
  const forkUnavailableDescriptionId = `sidebar-fork-unavailable-${thread.id}`;

  const actionsOpen = menuOpen || sheetOpen;

  useEffect(() => {
    if (!actionsOpen || !threadRegistry) return;
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
  }, [actionsOpen, thread.id, threadRegistry]);

  useEffect(
    () => () => {
      afterSheetClose.current?.release();
      afterSheetClose.current = undefined;
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      if (suppressClickTimer.current) clearTimeout(suppressClickTimer.current);
    },
    [],
  );

  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = undefined;
    longPressOrigin.current = undefined;
  };

  const openActionSheet = () => {
    cancelLongPress();
    setMenuOpen(false);
    setSheetOpen(true);
  };

  const beginLongPress = (event: React.PointerEvent<HTMLElement>) => {
    latestPointerType.current = event.pointerType;
    if (
      (event.pointerType !== "touch" && event.pointerType !== "pen") ||
      event.button !== 0
    ) {
      return;
    }
    // Claim touch/pen before Radix ContextMenu's bubble handler can start its
    // separate 700ms timer. Android may also emit a synthetic contextmenu at
    // any point during the hold, including before our sheet timer completes.
    event.preventDefault();
    event.stopPropagation();
    suppressContextMenuUntil.current =
      Date.now() + TOUCH_CONTEXT_MENU_SUPPRESSION_MS;
    cancelLongPress();
    const point = { x: event.clientX, y: event.clientY };
    longPressOrigin.current = point;
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = undefined;
      longPressOrigin.current = undefined;
      suppressNextClick.current = true;
      suppressContextMenuUntil.current =
        Date.now() + TOUCH_CONTEXT_MENU_SUPPRESSION_MS;
      if (suppressClickTimer.current) clearTimeout(suppressClickTimer.current);
      suppressClickTimer.current = setTimeout(() => {
        suppressNextClick.current = false;
        suppressClickTimer.current = undefined;
      }, 1_000);
      openActionSheet();
    }, LONG_PRESS_MENU_DELAY_MS);
  };

  const moveLongPress = (event: React.PointerEvent<HTMLElement>) => {
    const origin = longPressOrigin.current;
    if (
      !origin ||
      Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <=
        LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      return;
    }
    cancelLongPress();
  };

  const closeSheetBefore = (action: () => void) => {
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
    setSheetOpen(false);
  };

  useEffect(() => {
    if (sheetOpen || !afterSheetClose.current) return;
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
  }, [sheetOpen]);

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
  const configurationCopyDefinition: ThreadActionDefinition = {
    id: "new-from-settings",
    label: configurationCopyPending
      ? "Creating thread…"
      : THREAD_CONFIGURATION_COPY_LABEL,
    icon: <CopyPlus size={18} strokeWidth={1.8} />,
    disabled: configurationCopyPending || !thread.available,
    ariaLabel: configurationCopyPending
      ? THREAD_CONFIGURATION_COPY_PENDING_ACCESSIBLE_LABEL
      : THREAD_CONFIGURATION_COPY_ACCESSIBLE_LABEL,
    ariaDescribedBy: !thread.available
      ? `sidebar-settings-copy-unavailable-${thread.id}`
      : undefined,
    title: THREAD_CONFIGURATION_COPY_TITLE,
    onInvoke: createWithSameSettings,
    deferUntilSheetCloses: true,
  };
  const archiveDefinition: ThreadActionDefinition = {
    id: "archive",
    label: "Archive",
    variant: "destructive",
    disabled: pendingAction !== undefined,
    onInvoke: () => setArchiveChoicesOpen(true),
    deferUntilSheetCloses: true,
    desktopContent: (
      <ArchiveContextSubmenu
        thread={thread}
        store={store}
        descendantCount={familyDescendantCount}
        disabled={pendingAction !== undefined}
        onPendingChange={(pending) =>
          setPendingAction(pending ? "archive" : undefined)
        }
        onArchived={(choice, archivedThreadIds) => {
          onAction?.("archive");
          if (choice === "all") onArchiveFamily?.(archivedThreadIds);
        }}
        onDismiss={() => setMenuOpen(false)}
      />
    ),
  };
  const groupCatalog = application?.snapshot?.groups ?? [];
  const mutateGroup = (operation: () => Promise<unknown>) => {
    if (groupPending) return;
    setGroupPending(true);
    setActionError("");
    void operation()
      .then(() => {
        setGroupDialogOpen(false);
      })
      .catch((error: unknown) =>
        setActionError(
          error instanceof Error
            ? error.message
            : "The thread group could not be updated.",
        ),
      )
      .finally(() => setGroupPending(false));
  };
  const openGroupDialog = () => {
    setGroupName(thread.title.text || "Untitled thread");
    setActionError("");
    setGroupDialogOpen(true);
  };
  const groupDefinition: ThreadActionDefinition = {
    id: "group",
    label: "Move to group",
    icon: <Layers3 size={18} strokeWidth={1.8} />,
    disabled: groupPending,
    deferUntilSheetCloses: true,
    onInvoke: openGroupDialog,
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
  const copyIdDefinition: ThreadActionDefinition = {
    id: "copy-id",
    label: "Copy ID",
    icon: <Copy size={18} strokeWidth={1.8} />,
    title: "Copy Sedes session ID",
    onInvoke: () => copySessionId(thread.id),
  };
  const backendSessionId = thread.backendSessionId;
  const copyBackendIdDefinition: ThreadActionDefinition = {
    id: "copy-backend-id",
    label: "Copy backend ID",
    icon: <Copy size={18} strokeWidth={1.8} />,
    title: backendSessionId
      ? "Copy backend session ID"
      : "Backend session ID is unavailable",
    disabled: !backendSessionId,
    onInvoke: () => {
      if (backendSessionId) copySessionId(backendSessionId);
    },
  };
  const lifecycleActions: readonly ThreadActionDefinition[] = archived
    ? [
        copyIdDefinition,
        copyBackendIdDefinition,
        groupDefinition,
        {
          id: "restore",
          label: "Restore to Active",
          onInvoke: () => mutate("restore"),
        },
      ]
    : [
        copyIdDefinition,
        copyBackendIdDefinition,
        {
          id: "pin",
          label: thread.pinned ? "Unpin" : "Pin",
          icon: thread.pinned ? (
            <PinOff size={18} strokeWidth={1.8} />
          ) : (
            <Pin size={18} strokeWidth={1.8} />
          ),
          disabled: pinPending,
          onInvoke: togglePin,
        },
        groupDefinition,
        ...(onRename
          ? [
              {
                id: "rename",
                label: "Rename",
                icon: <PencilLine size={18} strokeWidth={1.8} />,
                onInvoke: onRename,
                onDesktopInvoke: () => {
                  renameRequested.current = true;
                },
                deferUntilSheetCloses: true,
              } satisfies ThreadActionDefinition,
            ]
          : []),
        ...(thread.automation
          ? [
              {
                id: "automation",
                label: "Automation settings…",
                icon: <Clock size={18} strokeWidth={1.8} />,
                onInvoke: () => {
                  navigate(threadAutomationPath(thread.id));
                  onNavigate?.();
                },
              } satisfies ThreadActionDefinition,
            ]
          : []),
        thread.inventoryState === "settled"
          ? {
              id: "unsettle",
              label: "Unsettle",
              icon: <ArrowUpFromDot size={18} strokeWidth={1.8} />,
              onInvoke: () => mutate("unsettle"),
            }
          : {
              id: "settle",
              label: "Settle",
              icon: <ArrowDownToDot size={18} strokeWidth={1.8} />,
              onInvoke: requestSettle,
              deferUntilSheetCloses: true,
            },
        thread.inventoryState === "snoozed"
          ? {
              id: "wake",
              label: "Wake now",
              icon: <Clock size={18} strokeWidth={1.8} />,
              onInvoke: () => mutate("wake"),
            }
          : {
              id: "snooze",
              label: "Snooze…",
              icon: <Clock size={18} strokeWidth={1.8} />,
              onInvoke: () => setSnoozeOpen(true),
              deferUntilSheetCloses: true,
            },
      ];
  const creationActions: readonly ThreadActionDefinition[] = [
    configurationCopyDefinition,
    ...(threadRegistry
      ? [
          {
            id: "fork",
            label: "Fork",
            icon: (
              <Split className="fork-split-icon" size={18} strokeWidth={1.8} />
            ),
            disabled: !latestFork.available,
            ariaDescribedBy:
              !latestFork.available && latestFork.unavailableReason
                ? forkUnavailableDescriptionId
                : undefined,
            onInvoke: forkLatest,
            deferUntilSheetCloses: true,
          } satisfies ThreadActionDefinition,
        ]
      : []),
  ];
  const destructiveActions: readonly ThreadActionDefinition[] = archived
    ? []
    : [
        {
          id: "force-reset",
          label: "Force reset…",
          icon: <RotateCcw size={18} strokeWidth={1.8} />,
          variant: "destructive",
          onInvoke: () => setForceResetOpen(true),
          deferUntilSheetCloses: true,
        },
        archiveDefinition,
      ];
  const lineageActions: readonly ThreadActionDefinition[] =
    origin && placement
      ? [
          {
            id: "toggle-lineage-placement",
            label:
              placement.mode === "nested_under_source"
                ? "Show as top-level"
                : "Group under source",
            disabled: placementPending || !origin.sourceThreadId,
            onInvoke: () => {
              if (placementPending || !origin.sourceThreadId) return;
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
            },
          },
          ...(origin.sourceThreadId
            ? [
                {
                  id: "open-source",
                  label: (
                    <>
                      Open source
                      {sourceTitle ? (
                        <span className="thread-action-dynamic-label">
                          {` “${sourceTitle}”`}
                        </span>
                      ) : null}
                    </>
                  ),
                  onInvoke: () => {
                    openThreadRoute(
                      origin.sourceThreadId!,
                      configuredPanelPresentation(),
                    );
                    onNavigate?.();
                  },
                } satisfies ThreadActionDefinition,
              ]
            : []),
          ...(origin.sourceThreadId && origin.sourceTurnId
            ? [
                {
                  id: "open-fork-point",
                  label: "Open fork point",
                  onInvoke: () => {
                    openThreadRoute(
                      origin.sourceThreadId!,
                      configuredPanelPresentation(),
                      origin.sourceTurnId!,
                    );
                    onNavigate?.();
                  },
                } satisfies ThreadActionDefinition,
              ]
            : []),
        ]
      : [];
  const workspaceActions = archived ? null : (
    <ExecutionWorkspaceActions
      threadId={thread.id}
      store={store}
      active={actionsOpen}
      disabled={pendingAction !== undefined}
      knownDirect={targetWorkspaceExecution === "direct_only"}
      onRequestDelete={(workspace) => {
        const openDialog = () => {
          setWorkspaceDeleteError("");
          setWorkspaceDeleteTarget(workspace);
        };
        if (sheetOpen) closeSheetBefore(openDialog);
        else openDialog();
      }}
    />
  );
  const groups: readonly ThreadActionGroup[] = archived
    ? [
        { id: "creation", actions: creationActions },
        { id: "lifecycle", actions: lifecycleActions },
      ]
    : [
        { id: "lifecycle", actions: lifecycleActions },
        {
          id: "creation",
          actions: creationActions,
          supplementalContent: workspaceActions,
        },
        { id: "destructive", actions: destructiveActions },
        ...(lineageActions.length > 0
          ? [{ id: "lineage", actions: lineageActions }]
          : []),
      ];
  return (
    <>
      <ContextMenu
        open={menuOpen}
        onOpenChange={(open) => {
          if (open && mobileLayout) {
            openActionSheet();
            return;
          }
          if (
            open &&
            latestPointerType.current !== "mouse" &&
            Date.now() <= suppressContextMenuUntil.current
          ) {
            return;
          }
          if (open) onInteractionOpenChange?.(true);
          setMenuOpen(open);
        }}
      >
        <ContextMenuTrigger asChild disabled={disabled}>
          <span
            className="thread-context-trigger"
            aria-busy={configurationCopyPending || undefined}
            onPointerDownCapture={(event) => {
              if (disabled) return;
              groupPickerFocus.onPointerDown(event);
              beginLongPress(event);
            }}
            onKeyDownCapture={groupPickerFocus.onKeyDown}
            onPointerMove={moveLongPress}
            onPointerUp={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onContextMenuCapture={(event) => {
              if (disabled) return;
              if (mobileLayout) {
                event.preventDefault();
                event.stopPropagation();
                openActionSheet();
                return;
              }
              if (
                latestPointerType.current === "mouse" ||
                Date.now() > suppressContextMenuUntil.current
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
            }}
            onClickCapture={(event) => {
              if (disabled || !suppressNextClick.current) return;
              suppressNextClick.current = false;
              if (suppressClickTimer.current) {
                clearTimeout(suppressClickTimer.current);
                suppressClickTimer.current = undefined;
              }
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {children}
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent
          onPointerDownCapture={groupPickerFocus.onPointerDown}
          onKeyDownCapture={groupPickerFocus.onKeyDown}
          className="thread-context-menu min-w-[11rem]"
          data-testid="thread-context-menu"
          aria-label={`Actions for ${thread.title.text || "Untitled thread"}`}
          collisionPadding={12}
          onCloseAutoFocus={(event) => {
            if (groupDialogOpen) {
              event.preventDefault();
              if (!groupDialogRef.current?.contains(document.activeElement)) {
                groupPickerFocus.focusPicker(groupDialogRef.current);
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
          <DesktopThreadActions groups={groups} />
        </ContextMenuContent>
      </ContextMenu>
      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <DialogContent
          onPointerDownCapture={groupPickerFocus.onPointerDown}
          onKeyDownCapture={groupPickerFocus.onKeyDown}
          className="thread-actions-sheet"
          style={{ pointerEvents: "auto" }}
          overlayClassName="thread-actions-sheet-overlay"
          data-testid="thread-actions-sheet"
          aria-describedby={`thread-actions-sheet-title-${thread.id}`}
          onCloseAutoFocus={(event) => {
            if (afterSheetClose.current) {
              event.preventDefault();
              return;
            }
            const target = returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <DialogTitle>Thread actions</DialogTitle>
          <DialogDescription
            id={`thread-actions-sheet-title-${thread.id}`}
            className="thread-actions-sheet-thread-title"
            title={thread.title.text || "Untitled thread"}
          >
            {thread.title.text || "Untitled thread"}
          </DialogDescription>
          <div className="thread-actions-sheet-body">
            <MobileThreadActions
              groups={groups}
              invoke={(action) => {
                if (action.deferUntilSheetCloses) {
                  closeSheetBefore(action.onInvoke);
                  return;
                }
                action.onInvoke();
                setSheetOpen(false);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogContent
          ref={groupDialogRef}
          className="thread-group-dialog z-[101]"
          style={{ "--thread-group-keyboard-inset": `${groupKeyboardInset}px` } as CSSProperties}
          overlayClassName="z-[100]"
          data-testid="thread-group-dialog"
          onOpenAutoFocus={groupPickerFocus.onOpenAutoFocus}
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Move to group</DialogTitle>
            <DialogDescription>
              Choose a persistent group, or create one from this thread.
            </DialogDescription>
          </DialogHeader>
          <div className="thread-group-search">
            <SearchableSelectList
              label="Group"
              searchLabel="Search groups"
              emptyLabel="No matching groups"
              value={thread.groupId ?? ""}
              disabled={groupPending}
              searchInputRef={groupSearchRef}
              options={groupCatalog.map((group) => ({
                value: group.id,
                label: group.name,
                description: `${group.memberCount} ${group.memberCount === 1 ? "thread" : "threads"}`,
                icon: <Layers3 size={14} aria-hidden="true" />,
                disabled: group.id === thread.groupId,
              }))}
              onValueChange={(groupId) =>
                mutateGroup(() => store.assignThreadGroup(thread, groupId))
              }
            />
          </div>
          <label className="thread-group-create-field">
            <span>Create group</span>
            <Input
              maxLength={120}
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
            />
          </label>
          {actionError && (
            <p className="thread-row-error" role="alert">
              {actionError}
            </p>
          )}
          <DialogFooter>
            {thread.groupId !== null && (
              <Button
                type="button"
                variant="outline"
                disabled={groupPending}
                onClick={() =>
                  mutateGroup(() => store.removeThreadGroup(thread))
                }
              >
                Ungroup
              </Button>
            )}
            <Button
              type="button"
              disabled={groupPending || !groupName.trim()}
              onClick={() =>
                mutateGroup(() =>
                  store.createThreadGroup(thread, groupName.trim()),
                )
              }
            >
              {groupPending ? "Saving…" : "Create and move"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
      <ArchiveChoicesDialog
        open={archiveChoicesOpen}
        onOpenChange={setArchiveChoicesOpen}
        thread={thread}
        store={store}
        descendantCount={familyDescendantCount}
        disabled={pendingAction !== undefined}
        onPendingChange={(pending) =>
          setPendingAction(pending ? "archive" : undefined)
        }
        onArchived={(choice, archivedThreadIds) => {
          onAction?.("archive");
          if (choice === "all") onArchiveFamily?.(archivedThreadIds);
        }}
        returnFocusRef={returnFocusRef}
      />
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
      {actionError && !groupDialogOpen && (
        <p className="thread-row-error" role="alert">
          {actionError}
        </p>
      )}
    </>
  );
}
