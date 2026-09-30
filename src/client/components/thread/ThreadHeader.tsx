import { ThreadEnvironmentVariables } from "../environment-variables/ThreadEnvironmentVariables.js";
import { runThreadCreation, runThreadFork } from "../../operations/thread-creation.js";
import {
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  NormalizedThreadSnapshot,
  OpenTaskDisposition,
  ThreadArchiveImpact,
} from "../../../shared/index.js";
import { DEFAULT_THREAD_TITLE } from "../../../shared/index.js";
import { navigate, threadAutomationPath } from "../../app/router.js";
import type { ConnectionState } from "../../api/EventStreamTransport.js";
import {
  useApplicationStore,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import type {
  ThreadClientStore,
  ThreadClientState,
  TurnForkAttempt,
} from "../../stores/ThreadClientStore.js";
import { ProviderFeatureThreadDetails } from "../../provider-features/registry.js";
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowDownToDot,
  ArrowUpFromDot,
  Braces,
  CalendarClock,
  ChartColumn,
  ChevronDown,
  Clock,
  CopyPlus,
  FolderInput,
  PanelTop,
  RotateCcw,
  Search,
  Settings2,
  Shrink,
  Split,
  Wrench,
} from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemDescription,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuValue,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import { menuDescriptionClass } from "@client/components/ui/floating";
import { cn } from "@client/lib/utils";
import { useTouchDensity } from "../../app/use-touch-density.js";
import { SessionStatsDialog } from "./SessionStatsDialog.js";
import { SnoozeDialog } from "./SnoozeDialog.js";
import {
  ThreadModelPickerSheet,
  ThreadSettingsMenuItems,
} from "./ThreadSettingsControls.js";
import {
  AgentToolSettingsDialog,
  agentToolPolicySummary,
} from "./AgentToolSettingsDialog.js";
import { latestTurnForkDecision } from "../../lineage/latest-turn-fork.js";
import { useArchiveThreadAction } from "./ArchiveChoicesDialog.js";
import {
  ExecutionWorkspaceDeleteDialog,
  type IsolatedWorkspace,
} from "./ExecutionWorkspaceActions.js";
import { ExecutionWorkspaceMenu } from "./ExecutionWorkspaceMenu.js";
import { dropdownMenuParts } from "./menu-parts.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import { pointerPanelPresentation } from "../../workspace-panels/thread-panel-navigation.js";
import type { PanelPresentation } from "../../workspace-panels/panel-presentation.js";
import { NavigationControlsContext } from "../../app/navigation-controls.js";
import { SIDEBAR_NAV_MEDIA_QUERY } from "../SidebarNavTrigger.js";

/**
 * Below this width a phone header gives its toolbar toggle to Thread
 * actions, so the title keeps its room beside the touch-sized buttons.
 */
const NARROW_HEADER_MEDIA_QUERY = "(max-width: 419px)";
import {
  SettleImpactDialog,
  settleNeedsConfirmation,
} from "./SettleImpactDialog.js";
import { ForceResetDialog } from "./ForceResetDialog.js";
import { TurnBookmarksMenu } from "./TurnBookmarksMenu.js";
import { workspaceDisplayLabel } from "../../app/sidebar-scope-presentation.js";
import {
  PanelChrome,
  type PanelChromeControls,
} from "../../workspace-panels/PanelChrome.js";
import { ThreadHeading, useThreadHeaderTint } from "./ThreadHeading.js";
import {
  THREAD_CONFIGURATION_COPY_LABEL,
  THREAD_CONFIGURATION_COPY_PENDING_ACCESSIBLE_LABEL,
  THREAD_CONFIGURATION_COPY_TITLE,
} from "./thread-configuration-copy-labels.js";
import { ThreadWorktreePicker } from "./ThreadWorktreePicker.js";
import { useDelayedUnavailableConnection } from "../../app/use-delayed-connection-status.js";

const SHEET_DIALOG_HANDOFF_DELAY_MS = 260;

/** A disabled row's short reason; the row's title carries the full one. */
function ReasonShortcut({ reason }: { readonly reason: string }) {
  return (
    <DropdownMenuValue aria-hidden="true">{reason}</DropdownMenuValue>
  );
}

/** A non-focusable status line inside the menu, e.g. a failed action. */
function MenuNote({ children }: { readonly children: ReactNode }) {
  return (
    <p
      role="alert"
      className={cn(menuDescriptionClass, "m-0 px-2 py-1.5 text-destructive")}
    >
      {children}
    </p>
  );
}

// Memoized: all props are stable references (or primitives) across
// unrelated thread-store updates, so composer/draft/notice churn should not
// re-render the header.
export const ThreadHeader = memo(function ThreadHeader({
  active = true,
  store,
  applicationStore,
  snapshot,
  connection,
  authoritative,
  forkAttempts,
  actionPending,
  panelControls,
  findOpen,
  findButtonRef,
  onFindOpenChange,
  bookmarks,
  bookmarkStatus,
  bookmarkRevision,
  bookmarkError,
  pendingBookmarkTurnIds,
  onSelectBookmarkTurn,
}: {
  active?: boolean;
  store: ThreadClientStore;
  applicationStore: ApplicationClientStore;
  snapshot: NormalizedThreadSnapshot;
  connection: ConnectionState;
  authoritative: boolean;
  forkAttempts: Readonly<Record<string, TurnForkAttempt>>;
  actionPending: boolean;
  panelControls?: PanelChromeControls;
  findOpen: boolean;
  findButtonRef: RefObject<HTMLButtonElement | null>;
  onFindOpenChange: (open: boolean) => void;
  bookmarks: ThreadClientState["bookmarks"];
  bookmarkStatus: ThreadClientState["bookmarkStatus"];
  bookmarkRevision: number;
  bookmarkError?: string;
  pendingBookmarkTurnIds: ThreadClientState["pendingBookmarkTurnIds"];
  onSelectBookmarkTurn: (turnId: string) => boolean;
}): React.JSX.Element {
  const application = useApplicationStore(applicationStore);
  // Under the density switch Thread actions is a bottom sheet with 44px
  // rows, and it also carries the thread settings the composer hides.
  const sheet = useTouchDensity();
  const mobileLayout = useMediaQuery(SIDEBAR_NAV_MEDIA_QUERY);
  const narrowHeader = useMediaQuery(NARROW_HEADER_MEDIA_QUERY);
  const navigationControls = useContext(NavigationControlsContext);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(snapshot.thread.title.text);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  useEffect(() => {
    if (findOpen) setMobileToolsOpen(true);
  }, [findOpen]);
  const setToolbarOpen = (open: boolean) => {
    if (!open) onFindOpenChange(false);
    setMobileToolsOpen(open);
  };
  const [actionsOpen, setActionsOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearchFirst, setModelSearchFirst] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [forceResetOpen, setForceResetOpen] = useState(false);
  const [settleImpact, setSettleImpact] = useState<ThreadArchiveImpact>();
  const [settleChoicesOpen, setSettleChoicesOpen] = useState(false);
  const [sessionStatsOpen, setSessionStatsOpen] = useState(false);
  const [agentToolsOpen, setAgentToolsOpen] = useState(false);
  const [environmentVariablesOpen, setEnvironmentVariablesOpen] = useState(false);
  const [workspaceDeleteTarget, setWorkspaceDeleteTarget] =
    useState<IsolatedWorkspace>();
  const [workspaceDeletePending, setWorkspaceDeletePending] = useState(false);
  const [workspaceDeleteError, setWorkspaceDeleteError] = useState("");
  const [inventoryPending, setInventoryPending] = useState(false);
  const [inventoryError, setInventoryError] = useState("");
  const [localConfigurationCopyPending, setConfigurationCopyPending] =
    useState(false);
  const configurationCopyPending =
    localConfigurationCopyPending ||
    application.pendingThreadConfigurationCopySourceIds.includes(
      snapshot.thread.id,
    );
  const showUnavailableConnection = useDelayedUnavailableConnection(connection);
  const renameRequest = useRef<Promise<void> | undefined>(undefined);
  const cancelRename = useRef(false);
  /** Focus target when the snooze / session-stats dialogs close — they are
      opened from menu rows that unmount with the menu. */
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const titleTrigger = useRef<HTMLButtonElement>(null);
  const restoreTitleFocus = useRef(false);
  const afterActionsClose = useRef<(() => void) | undefined>(undefined);
  // Shift-selecting a creating row opens its thread in the other presentation.
  const shiftSelect = useRef(false);
  const selectedPresentation = (): PanelPresentation => {
    const presentation = pointerPanelPresentation({
      shiftKey: shiftSelect.current,
    });
    shiftSelect.current = false;
    return presentation;
  };
  const disabled =
    connection !== "connected" ||
    !snapshot.thread.available ||
    snapshot.runState === "disconnected" ||
    snapshot.runState === "reconciling" ||
    inventoryPending ||
    actionPending;
  const forceResetDisabled =
    connection !== "connected" ||
    !snapshot.thread.available ||
    inventoryPending ||
    actionPending;
  // The short reason a row is disabled by the thread's state, not by its
  // own capability.
  const busyReason =
    connection !== "connected" || snapshot.runState === "disconnected"
      ? "Offline"
      : !snapshot.thread.available
        ? "Unavailable"
        : snapshot.runState === "reconciling"
          ? "Syncing"
          : "Busy";
  const rename = snapshot.capabilities.operations.find(
    ({ id }) => id === "rename",
  );
  const attachAutomation = snapshot.capabilities.operations.find(
    ({ id }) => id === "attach_automation",
  );
  const compact = snapshot.capabilities.operations.find(
    ({ id }) => id === "compact",
  );
  const moveDraft = snapshot.capabilities.operations.find(
    ({ id }) => id === "move_draft",
  );
  const settle = snapshot.capabilities.operations.find(
    ({ id }) => id === "settle",
  );
  const snooze = snapshot.capabilities.operations.find(
    ({ id }) => id === "snooze",
  );
  const archive = snapshot.capabilities.operations.find(
    ({ id }) => id === "archive",
  );
  const workspaces = (application.snapshot?.workspaces ?? []).filter(
    ({ environmentId }) => environmentId === snapshot.environment.id,
  );
  const environments = application.snapshot?.environments ?? [];
  const showEnvironmentLabel = environments.length > 1;
  const draftWorkspaceLabel = (workspaceId: string): string => {
    const workspace = workspaces.find(({ id }) => id === workspaceId);
    if (!workspace) return snapshot.workspace.label.text;
    const environment = environments.find(
      ({ id }) => id === workspace.environmentId,
    );
    return showEnvironmentLabel && environment?.kind !== "local"
      ? `${workspace.label.text} · ${environment?.label.text ?? "Unknown environment"}`
      : workspace.label.text;
  };
  const headerEnvironmentTintStyle = useThreadHeaderTint(
    environments,
    snapshot.environment.id,
  );
  const workspaceCatalog = application.snapshot?.workspaces ?? [];
  const applicationWorkspace =
    workspaceCatalog.find(({ id }) => id === snapshot.workspace.id) ??
    snapshot.workspace;
  const projectContextLabel = workspaceDisplayLabel({
    workspace: applicationWorkspace,
    workspaces: workspaceCatalog,
    environments,
    includeEnvironment:
      showEnvironmentLabel && snapshot.environment.kind !== "local",
  });
  const executionTargets = application.snapshot?.executionTargets ?? [];
  const executionTarget = executionTargets.find(
    ({ id }) => id === snapshot.thread.targetId,
  );
  const executionTargetLabel =
    executionTarget?.label.text ?? snapshot.capabilities.backend.label.text;
  const familyDescendantCount =
    application.snapshot?.lineageFamilies.find(
      ({ sourceThreadId }) => sourceThreadId === snapshot.thread.id,
    )?.descendantCount ?? 0;
  const applicationPin = application.snapshot?.threads.find(
    ({ id }) => id === snapshot.thread.id,
  );
  useEffect(() => {
    if (applicationPin) {
      store.observePublishedBookmarkRevision(applicationPin.bookmarkRevision);
    }
  }, [applicationPin?.bookmarkRevision, store]);
  const applicationThreadSummary = {
    ...snapshot.thread,
    // A freshly created thread can render before its first application
    // upsert. Its principal-owned pin state starts at the durable defaults.
    pinned: applicationPin?.pinned ?? false,
    pinRevision: applicationPin?.pinRevision ?? 0,
    preferredWorktreeRevision: applicationPin?.preferredWorktreeRevision ?? 0,
    preferredWorktree: applicationPin?.preferredWorktree ?? null,
    groupId: applicationPin?.groupId ?? null,
    groupAssignmentRevision: applicationPin?.groupAssignmentRevision ?? 0,
    bookmarkRevision: applicationPin?.bookmarkRevision ?? bookmarkRevision,
    turnBookmarkCount: applicationPin?.turnBookmarkCount ?? bookmarks.length,
    terminalSummary: applicationPin?.terminalSummary ?? {
      runningCount: 0,
      retainedCount: 0,
    },
    stashedPromptCount: snapshot.stashes.length,
    pendingQuestionCount: applicationPin?.pendingQuestionCount ?? 0,
    attention: {
      wake: Boolean(snapshot.attention.wake),
      automationContext: snapshot.attention.automationContext?.outcome ?? null,
      unseenCompletion: false,
      queueFailure: Boolean(snapshot.attention.queueFailure),
    },
  };
  // Archive directly when the authoritative impact leaves nothing to decide;
  // otherwise the choices dialog opens with that impact.
  const archiveAction = useArchiveThreadAction({
    thread: applicationThreadSummary,
    store: applicationStore,
    descendantCount: familyDescendantCount,
    disabled: disabled || archive?.available !== true,
    onPendingChange: setInventoryPending,
    onArchived: () => {
      setActionsOpen(false);
      navigate("/");
      if (mobileLayout) navigationControls?.openDrawer();
    },
    returnFocusRef: actionsTrigger,
  });
  const latestFork = latestTurnForkDecision({
    status: "ready",
    connection,
    authoritative,
    snapshot,
    forkAttempts,
  });
  const latestForkUnavailableReason =
    disabled && latestFork.available
      ? "Wait for the current thread action to finish."
      : latestFork.unavailableReason;
  const variableForkNeedsRecovery = latestFork.attempt?.phase === "request_failed" || latestFork.attempt?.phase === "recovery_required";
  const latestForkUnavailableDescriptionId = `latest-fork-unavailable-${snapshot.thread.id}`;
  useEffect(() => {
    if (!renaming) setTitle(snapshot.thread.title.text);
  }, [renaming, snapshot.thread.title.text]);

  useEffect(() => {
    if (renaming || !restoreTitleFocus.current) return;
    restoreTitleFocus.current = false;
    titleTrigger.current?.focus();
  }, [renaming]);

  const submitRename = (): Promise<void> => {
    if (cancelRename.current) {
      cancelRename.current = false;
      return Promise.resolve();
    }
    if (renameRequest.current) return renameRequest.current;
    const next = title.trim();
    const request = (async () => {
      if (next && next !== snapshot.thread.title.text) {
        await store.perform({ action: "rename", title: next });
      }
      setRenaming(false);
    })();
    renameRequest.current = request;
    void request
      .finally(() => {
        if (renameRequest.current === request)
          renameRequest.current = undefined;
      })
      .catch(() => undefined);
    return request;
  };

  const mutateInventory = async (
    action:
      | "settle"
      | "unsettle"
      | "snooze"
      | "remind"
      | "wake"
      | "archive"
      | "restore",
    options?: {
      readonly snoozedUntil?: string;
      readonly wakeReminder?: string;
      readonly openTaskDisposition?: OpenTaskDisposition;
      readonly expectedOpenTaskSnapshot?: string;
      readonly expectedStashedPromptCount?: number;
    },
  ) => {
    setInventoryPending(true);
    setInventoryError("");
    try {
      await applicationStore.mutateInventory(
        applicationThreadSummary,
        action,
        options,
      );
      setActionsOpen(false);
      if (action === "archive") navigate("/");
    } catch (error) {
      setInventoryError(
        error instanceof Error
          ? error.message
          : "The thread could not be updated.",
      );
      throw error;
    } finally {
      setInventoryPending(false);
    }
  };

  // Rows whose action reports back (inventory changes, compact) keep the menu
  // open until it succeeds, so a failure stays readable beside them.
  const keepOpen = (action: () => void) => (event: Event) => {
    event.preventDefault();
    action();
  };

  const closeActionsBefore = (action: () => void) => {
    if (!sheet) {
      setActionsOpen(false);
      action();
      return;
    }
    afterActionsClose.current = action;
    setActionsOpen(false);
  };

  useEffect(() => {
    if (actionsOpen || !afterActionsClose.current) return;
    const pending = afterActionsClose.current;
    afterActionsClose.current = undefined;
    const timer = setTimeout(pending, SHEET_DIALOG_HANDOFF_DELAY_MS);
    return () => clearTimeout(timer);
  }, [actionsOpen]);

  const requestSettle = async () => {
    setInventoryPending(true);
    setInventoryError("");
    try {
      const impact = await applicationStore.getThreadArchiveImpact(
        snapshot.thread.id,
      );
      if (!settleNeedsConfirmation(impact)) {
        await mutateInventory("settle", { expectedStashedPromptCount: 0 });
        return;
      }
      closeActionsBefore(() => {
        setSettleImpact(impact);
        setSettleChoicesOpen(true);
      });
    } catch (error) {
      setInventoryError(
        error instanceof Error
          ? error.message
          : "Unfinished work could not be checked.",
      );
    } finally {
      setInventoryPending(false);
    }
  };

  const createFromSettings = (presentation: PanelPresentation) => {
    if (configurationCopyPending || !snapshot.thread.available) return;
    setConfigurationCopyPending(true);
    closeActionsBefore(() => {
      void runThreadCreation({
        message: "Creating thread…",
        create: async () => (await applicationStore.createThreadFromSettings(
          snapshot.thread.id, { title: DEFAULT_THREAD_TITLE },
        )).threadId,
        presentation,
      }).finally(() => setConfigurationCopyPending(false));
    });
  };

  const sharedPanelControls: PanelChromeControls | undefined = panelControls
    ? {
        onCollapse: panelControls.onCollapse,
        onClose: panelControls.onClose,
        onDock: panelControls.onDock,
        ...(panelControls.dockEdge !== undefined
          ? { dockEdge: panelControls.dockEdge }
          : {}),
        ...(panelControls.renderMenuItems !== undefined
          ? { renderMenuItems: panelControls.renderMenuItems }
          : {}),
      }
    : undefined;

  return (
    <>
      <PanelChrome
        className="thread-header"
        panelTitle="Chat"
        controls={sharedPanelControls}
        environmentTintStyle={headerEnvironmentTintStyle}
        leading={
          <ThreadHeading
            backend={snapshot.capabilities.backend}
            mobile={mobileLayout}
            title={renaming ? (
              <form
                className="rename-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  restoreTitleFocus.current = true;
                  void submitRename().catch(() => undefined);
                }}
              >
                <label className="sr-only" htmlFor="thread-title">
                  Thread title
                </label>
                <input
                  id="thread-title"
                  autoFocus
                  maxLength={240}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => void submitRename().catch(() => undefined)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      cancelRename.current = true;
                      setTitle(snapshot.thread.title.text);
                      restoreTitleFocus.current = true;
                      setRenaming(false);
                    }
                  }}
                />
              </form>
            ) : rename ? (
              <button
                ref={titleTrigger}
                className="title-button"
                disabled={disabled || !rename.available}
                title={rename.unavailableReason?.text}
                onClick={() => {
                  cancelRename.current = false;
                  setRenaming(true);
                }}
              >
                <h1>{snapshot.thread.title.text || "Untitled thread"}</h1>
              </button>
            ) : (
              <h1>{snapshot.thread.title.text || "Untitled thread"}</h1>
            )}
            status={showUnavailableConnection ? (
              <span
                className={`connection-dot ${connection}`}
                role="img"
                aria-label={`Thread ${connection}`}
                title={connection}
              />
            ) : null}
            context={
              renaming
                ? undefined
                : {
                    projectLabel: projectContextLabel,
                    targetLabel: executionTargetLabel,
                    targetAvailable: executionTarget?.available,
                  }
            }
            worktree={
              <ThreadWorktreePicker
                api={applicationStore.api}
                thread={applicationThreadSummary}
                workspaceId={snapshot.workspace.id}
              />
            }
          />
        }
        panelActions={
          <div
            className="thread-tools-shell"
            data-mobile-open={mobileToolsOpen}
          >
            <div
              id={`thread-toolbar-${snapshot.thread.id}`}
              className="thread-controls"
              data-testid="thread-controls"
              hidden={mobileLayout && !mobileToolsOpen}
            >
              <Button
                ref={findButtonRef}
                variant={findOpen ? "secondary" : "ghost"}
                size="icon"
                className="thread-find-trigger"
                aria-label="Find in thread"
                aria-expanded={findOpen}
                aria-controls={`thread-find-${snapshot.thread.id}`}
                title="Find in thread"
                onClick={() => onFindOpenChange(!findOpen)}
              >
                <Search size={16} strokeWidth={1.8} />
              </Button>
              {mobileLayout && (
                <ThreadWorktreePicker
                  api={applicationStore.api}
                  thread={applicationThreadSummary}
                  workspaceId={snapshot.workspace.id}
                />
              )}
            </div>
              <TurnBookmarksMenu
                bookmarks={bookmarks}
                status={bookmarkStatus}
                error={bookmarkError}
                pendingTurnIds={pendingBookmarkTurnIds}
                store={store}
                mobile={sheet}
                onSelectTurn={onSelectBookmarkTurn}
              />
              {snapshot.thread.automation &&
                snapshot.capabilities.automation.available && (
                  <button
                    className="automation-thread-button"
                    aria-label="Automation settings"
                    title={
                      snapshot.thread.automation.status === "enabled"
                        ? "Automation enabled"
                        : "Automation paused"
                    }
                    data-status={snapshot.thread.automation.status}
                    onClick={() =>
                      navigate(threadAutomationPath(snapshot.thread.id))
                    }
                  >
                    <Clock size={18} strokeWidth={1.8} />
                  </button>
                )}
              <DropdownMenu
                presentation={sheet ? "sheet" : "menu"}
                open={active && actionsOpen}
                onOpenChange={setActionsOpen}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    ref={actionsTrigger}
                    variant="ghost"
                    size="icon-sm"
                    className="thread-settings-button"
                    aria-label="Thread actions"
                    title="Thread settings and actions"
                  >
                    <Settings2 size={16} strokeWidth={1.8} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  data-testid={sheet ? "thread-settings-sheet" : "thread-actions-menu"}
                  aria-label="Thread actions"
                  sheetTitle={snapshot.thread.title.text || "Untitled thread"}
                  sheetDescription={[
                    projectContextLabel,
                    `${executionTargetLabel}${executionTarget?.available === false ? " (unavailable)" : ""}`,
                  ].join(" · ")}
                  onCloseAutoFocus={(event) => {
                    // A dialog opened from the sheet takes focus once it opens.
                    if (afterActionsClose.current) event.preventDefault();
                  }}
                >
                  {narrowHeader && (
                    <>
                      <DropdownMenuCheckboxItem
                        checked={mobileToolsOpen}
                        aria-controls={`thread-toolbar-${snapshot.thread.id}`}
                        onCheckedChange={setToolbarOpen}
                      >
                        <PanelTop aria-hidden="true" />
                        Show thread toolbar
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {sheet && snapshot.capabilities.settings.length > 0 && (
                    <>
                      <ThreadSettingsMenuItems
                        store={store}
                        snapshot={snapshot}
                        disabled={disabled}
                        onChooseModel={(viaKeyboard) =>
                          closeActionsBefore(() => {
                            setModelSearchFirst(viaKeyboard);
                            setModelPickerOpen(true);
                          })
                        }
                      />
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem
                    aria-label={`Agent tools… ${agentToolPolicySummary(snapshot.agentTools)}`}
                    onSelect={() =>
                      closeActionsBefore(() => setAgentToolsOpen(true))
                    }
                  >
                    <Wrench aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      Agent tools…{" "}
                      <DropdownMenuItemDescription>
                        {agentToolPolicySummary(snapshot.agentTools)}
                      </DropdownMenuItemDescription>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    aria-label="Environment variables…"
                    onSelect={() =>
                      closeActionsBefore(() => setEnvironmentVariablesOpen(true))
                    }
                  >
                    <Braces aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      Environment variables…{" "}
                      <DropdownMenuItemDescription>
                        Saved tools and commands snapshot
                      </DropdownMenuItemDescription>
                    </span>
                  </DropdownMenuItem>
                  <ProviderFeatureThreadDetails
                    store={store}
                    snapshot={snapshot}
                    disabled={disabled}
                    mobile={sheet}
                  />
                  {snapshot.thread.backingState === "unbound" &&
                    workspaces.length > 1 && (
                      <DropdownMenuSub>
                        {/* A workspace label is long by nature: the
                            current one is the checked row inside. */}
                        <DropdownMenuSubTrigger
                          disabled={disabled || moveDraft?.available !== true}
                        >
                          <FolderInput aria-hidden="true" />
                          Draft workspace
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuRadioGroup
                            value={snapshot.workspace.id}
                            onValueChange={(workspaceId) => {
                              if (workspaceId === snapshot.workspace.id) return;
                              void store
                                .moveDraft(workspaceId)
                                .then(() => setActionsOpen(false))
                                .catch(() => undefined);
                            }}
                          >
                            {workspaces.map((workspace) => (
                              <DropdownMenuRadioItem
                                key={workspace.id}
                                value={workspace.id}
                                disabled={!workspace.available}
                              >
                                <span className="min-w-0 truncate">
                                  {draftWorkspaceLabel(workspace.id)}
                                </span>
                                {!workspace.available && (
                                  <DropdownMenuValue aria-hidden="true">
                                    Unavailable
                                  </DropdownMenuValue>
                                )}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}
                  <DropdownMenuSeparator />
                  {snapshot.thread.inventoryState === "archived" && (
                    <DropdownMenuItem
                      disabled={disabled}
                      onSelect={keepOpen(() =>
                        void mutateInventory("restore").catch(() => undefined),
                      )}
                    >
                      <ArchiveRestore aria-hidden="true" />
                      Restore to Active
                      {disabled && <ReasonShortcut reason={busyReason} />}
                    </DropdownMenuItem>
                  )}
                  {snapshot.thread.inventoryState === "settled" ? (
                    <DropdownMenuItem
                      disabled={disabled}
                      onSelect={keepOpen(() =>
                        void mutateInventory("unsettle").catch(() => undefined),
                      )}
                    >
                      <ArrowUpFromDot aria-hidden="true" />
                      Unsettle
                      {disabled && <ReasonShortcut reason={busyReason} />}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      disabled={disabled || settle?.available !== true}
                      title={settle?.unavailableReason?.text}
                      onSelect={keepOpen(() => void requestSettle())}
                    >
                      <ArrowDownToDot aria-hidden="true" />
                      Settle
                      {(disabled || settle?.available !== true) && (
                        <ReasonShortcut reason={disabled ? busyReason : "Unavailable"} />
                      )}
                    </DropdownMenuItem>
                  )}
                  {snapshot.thread.inventoryState === "snoozed" ? (
                    <DropdownMenuItem
                      disabled={disabled}
                      onSelect={keepOpen(() =>
                        void mutateInventory("wake").catch(() => undefined),
                      )}
                    >
                      <AlarmClockOff aria-hidden="true" />
                      Wake now
                      {disabled && <ReasonShortcut reason={busyReason} />}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      disabled={disabled || snooze?.available !== true}
                      title={snooze?.unavailableReason?.text}
                      onSelect={() =>
                        closeActionsBefore(() => setSnoozeOpen(true))
                      }
                    >
                      <AlarmClock aria-hidden="true" />
                      Snooze…
                      {(disabled || snooze?.available !== true) && (
                        <ReasonShortcut reason={disabled ? busyReason : "Unavailable"} />
                      )}
                    </DropdownMenuItem>
                  )}
                  {snapshot.capabilities.automation.available && (
                    <DropdownMenuItem
                      disabled={
                        disabled ||
                        (!snapshot.thread.automation &&
                          attachAutomation?.available !== true)
                      }
                      title={
                        snapshot.thread.automation
                          ? undefined
                          : attachAutomation?.unavailableReason?.text
                      }
                      onSelect={() => {
                        setActionsOpen(false);
                        navigate(threadAutomationPath(snapshot.thread.id));
                      }}
                    >
                      <CalendarClock aria-hidden="true" />
                      {snapshot.thread.automation
                        ? "Automation settings…"
                        : "Automate…"}
                      {disabled && <ReasonShortcut reason={busyReason} />}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={
                      configurationCopyPending || !snapshot.thread.available
                    }
                    aria-busy={configurationCopyPending || undefined}
                    aria-describedby={
                      !snapshot.thread.available
                        ? `header-settings-copy-unavailable-${snapshot.thread.id}`
                        : undefined
                    }
                    aria-label={
                      configurationCopyPending
                        ? THREAD_CONFIGURATION_COPY_PENDING_ACCESSIBLE_LABEL
                        : undefined
                    }
                    title={THREAD_CONFIGURATION_COPY_TITLE}
                    onClick={(event) => {
                      shiftSelect.current = event.shiftKey;
                    }}
                    onSelect={() => createFromSettings(selectedPresentation())}
                  >
                    <CopyPlus aria-hidden="true" />
                    {configurationCopyPending
                      ? "Creating thread…"
                      : THREAD_CONFIGURATION_COPY_LABEL}
                    {!snapshot.thread.available && (
                      <ReasonShortcut reason="Unavailable" />
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={disabled || !latestFork.available}
                    aria-describedby={
                      latestForkUnavailableReason
                        ? latestForkUnavailableDescriptionId
                        : undefined
                    }
                    title={latestForkUnavailableReason}
                    onClick={(event) => {
                      shiftSelect.current = event.shiftKey;
                    }}
                    onSelect={() => {
                      if (!latestFork.selection || !latestFork.available) return;
                      const presentation = selectedPresentation();
                      const selection = latestFork.selection;
                      closeActionsBefore(() => {
                        void runThreadFork({
                          fork: (restart) => selection.boundary === "latest_provider_snapshot"
                            ? store.forkLatestProviderSnapshot({ restart })
                            : store.forkTurn(selection.capability, { restart }),
                          restart: latestFork.restart,
                          presentation,
                        });
                      });
                    }}
                  >
                    <Split className="fork-split-icon" aria-hidden="true" />
                    {latestFork.label}
                    {(disabled || !latestFork.available) && (
                      <ReasonShortcut
                        reason={
                          disabled && latestFork.available
                            ? busyReason
                            : latestFork.attempt?.phase === "pending"
                              ? "Forking…"
                              : "Unavailable"
                        }
                      />
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      closeActionsBefore(() => setSessionStatsOpen(true))
                    }
                  >
                    <ChartColumn aria-hidden="true" />
                    Session stats
                  </DropdownMenuItem>
                  {compact && (
                    <DropdownMenuItem
                      disabled={disabled || !compact.available}
                      title={compact.unavailableReason?.text}
                      onSelect={keepOpen(() =>
                        void store
                          .perform({ action: "compact" })
                          .then(() => setActionsOpen(false))
                          .catch(() => undefined),
                      )}
                    >
                      <Shrink aria-hidden="true" />
                      Compact context
                      {(disabled || !compact.available) && (
                        <ReasonShortcut reason={disabled ? busyReason : "Unavailable"} />
                      )}
                    </DropdownMenuItem>
                  )}
                  {snapshot.executionWorkspace.kind === "isolated" && (
                    <ExecutionWorkspaceMenu
                      parts={dropdownMenuParts}
                      threadId={snapshot.thread.id}
                      store={applicationStore}
                      active={actionsOpen}
                      disabled={disabled}
                      onRequestDelete={(workspace) => {
                        closeActionsBefore(() => {
                          setWorkspaceDeleteError("");
                          setWorkspaceDeleteTarget(workspace);
                        });
                      }}
                    />
                  )}
                  <DropdownMenuSeparator />
                  {snapshot.thread.inventoryState !== "archived" && (
                    <DropdownMenuItem
                      disabled={disabled || archive?.available !== true}
                      title={archive?.unavailableReason?.text}
                      onSelect={() => closeActionsBefore(archiveAction.start)}
                    >
                      <Archive aria-hidden="true" />
                      Archive
                      {(disabled || archive?.available !== true) && (
                        <ReasonShortcut reason={disabled ? busyReason : "Unavailable"} />
                      )}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={forceResetDisabled}
                    onSelect={() =>
                      closeActionsBefore(() => setForceResetOpen(true))
                    }
                  >
                    <RotateCcw aria-hidden="true" />
                    Force reset…
                    {forceResetDisabled && <ReasonShortcut reason={busyReason} />}
                  </DropdownMenuItem>
                  {inventoryError && <MenuNote>{inventoryError}</MenuNote>}
                </DropdownMenuContent>
              </DropdownMenu>
              {!snapshot.thread.available && (
                <span
                  id={`header-settings-copy-unavailable-${snapshot.thread.id}`}
                  className="sr-only"
                >
                  The source thread target is unavailable.
                </span>
              )}
              {latestForkUnavailableReason && (
                <span className="sr-only" id={latestForkUnavailableDescriptionId}>
                  {latestForkUnavailableReason}
                </span>
              )}
            {!narrowHeader && (
              <Button
                variant={mobileToolsOpen ? "secondary" : "ghost"}
                size="icon-sm"
                className="thread-tools-toggle"
                aria-label={
                  mobileToolsOpen ? "Hide thread toolbar" : "Show thread toolbar"
                }
                aria-expanded={mobileToolsOpen}
                aria-controls={`thread-toolbar-${snapshot.thread.id}`}
                onClick={() => setToolbarOpen(!mobileToolsOpen)}
              >
                <ChevronDown size={16} strokeWidth={1.8} />
              </Button>
            )}
          </div>
        }
      />
      {active && environmentVariablesOpen && <ThreadEnvironmentVariables key={snapshot.thread.id} api={applicationStore.api} threadId={snapshot.thread.id}
        title={snapshot.thread.title.text || "Untitled thread"} onClose={() => setEnvironmentVariablesOpen(false)} returnFocusRef={actionsTrigger}
        forkUnavailableReason={variableForkNeedsRecovery ? "Resolve the existing fork attempt before forking with changed variables." : disabled ? "The thread must be connected and available to fork." : !latestFork.available ? latestForkUnavailableReason ?? "This thread cannot be forked right now." : undefined}
        onFork={environmentVariables => {
          if (disabled || variableForkNeedsRecovery || !latestFork.available || !latestFork.selection) return;
          const selection = latestFork.selection;
          setEnvironmentVariablesOpen(false);
          void runThreadFork({
            fork: restart => selection.boundary === "latest_provider_snapshot"
              ? store.forkLatestProviderSnapshot({ restart, environmentVariables })
              : store.forkTurn(selection.capability, { restart, environmentVariables }),
            restart: latestFork.restart,
            presentation: "single",
          });
        }} />}
      <AgentToolSettingsDialog
        store={store}
        snapshot={snapshot}
        authoritative={authoritative}
        disabled={disabled}
        open={active && agentToolsOpen}
        onOpenChange={setAgentToolsOpen}
        returnFocusRef={actionsTrigger}
      />
      <ExecutionWorkspaceDeleteDialog
        workspace={workspaceDeleteTarget}
        returnFocusRef={actionsTrigger}
        open={active && (workspaceDeleteTarget !== undefined)}
        onOpenChange={(open) => {
          if (!open) setWorkspaceDeleteTarget(undefined);
        }}
        pending={workspaceDeletePending}
        error={workspaceDeleteError}
        onDelete={() => {
          if (!workspaceDeleteTarget || workspaceDeletePending) return;
          setWorkspaceDeletePending(true);
          setWorkspaceDeleteError("");
          void applicationStore
            .deleteThreadExecutionWorkspace(
              snapshot.thread.id,
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
      {active && archiveAction.dialog}
      <ThreadModelPickerSheet
        store={store}
        snapshot={snapshot}
        disabled={disabled}
        open={active && modelPickerOpen}
        searchFirst={modelSearchFirst}
        onOpenChange={setModelPickerOpen}
        returnFocusRef={actionsTrigger}
      />
      <ForceResetDialog
        open={active && forceResetOpen}
        onOpenChange={setForceResetOpen}
        loadImpact={() =>
          applicationStore.getThreadForceResetImpact(snapshot.thread.id)
        }
        onForceReset={(impact, mutationId) =>
          applicationStore
            .forceResetThread(
              snapshot.thread.id,
              impact.blockerFingerprint,
              mutationId,
            )
            .then(() => undefined)
        }
        returnFocusRef={actionsTrigger}
      />
      <SettleImpactDialog
        open={active && settleChoicesOpen}
        onOpenChange={setSettleChoicesOpen}
        impact={settleImpact}
        loadImpact={() =>
          applicationStore.getThreadArchiveImpact(snapshot.thread.id)
        }
        onSettle={(options) => mutateInventory("settle", options)}
        returnFocusRef={actionsTrigger}
      />
      <SnoozeDialog
        open={active && snoozeOpen}
        onOpenChange={setSnoozeOpen}
        onSnooze={(options) => mutateInventory("snooze", options)}
        onRemindNow={(wakeReminder) =>
          mutateInventory("remind", { wakeReminder })
        }
        returnFocusRef={actionsTrigger}
      />
      <SessionStatsDialog
        open={active && sessionStatsOpen}
        onOpenChange={setSessionStatsOpen}
        sedesThreadId={snapshot.thread.id}
        backendSessionId={snapshot.backendSessionId}
        createdWithAgent={snapshot.createdWithAgent}
        executionWorkspace={snapshot.executionWorkspace}
        environmentKind={snapshot.environment.kind}
        usageCache={store.usage}
        liveAvailable={connection === "connected" && authoritative}
        usage={snapshot.usage}
        returnFocusRef={actionsTrigger}
      />
    </>
  );
});
