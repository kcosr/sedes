import { useKeyboardInset } from "../../app/use-keyboard-inset.js";
import { ThreadEnvironmentVariables } from "../environment-variables/ThreadEnvironmentVariables.js";
import { runThreadArchiveCheck } from "../../operations/thread-archive.js";
import { runThreadCreation, runThreadFork } from "../../operations/thread-creation.js";
import * as Popover from "@radix-ui/react-popover";
import {
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
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
  Archive,
  ArrowDownToDot,
  ArrowUpFromDot,
  ChevronDown,
  Clock,
  CopyPlus,
  RotateCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Split,
  Wrench,
} from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@client/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { SessionStatsDialog } from "./SessionStatsDialog.js";
import { SnoozeDialog } from "./SnoozeDialog.js";
import { ThreadSettingsControls } from "./ThreadSettingsControls.js";
import {
  AgentToolSettingsDialog,
  agentToolPolicySummary,
} from "./AgentToolSettingsDialog.js";
import { latestTurnForkDecision } from "../../lineage/latest-turn-fork.js";
import { ArchiveDropdown } from "./ArchiveThreadChoices.js";
import { ArchiveChoicesDialog } from "./ArchiveChoicesDialog.js";
import {
  ExecutionWorkspaceActions,
  ExecutionWorkspaceDeleteDialog,
  type IsolatedWorkspace,
} from "./ExecutionWorkspaceActions.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import {
  openThreadRoute,
  pointerPanelPresentation,
} from "../../workspace-panels/thread-panel-navigation.js";
import type { PanelPresentation } from "../../workspace-panels/panel-presentation.js";
import { NavigationControlsContext } from "../../app/navigation-controls.js";
import { SIDEBAR_NAV_MEDIA_QUERY } from "../SidebarNavTrigger.js";
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
  THREAD_CONFIGURATION_COPY_ACCESSIBLE_LABEL,
  THREAD_CONFIGURATION_COPY_LABEL,
  THREAD_CONFIGURATION_COPY_PENDING_ACCESSIBLE_LABEL,
  THREAD_CONFIGURATION_COPY_TITLE,
} from "./thread-configuration-copy-labels.js";
import { ThreadWorktreePicker } from "./ThreadWorktreePicker.js";
import { useDelayedUnavailableConnection } from "../../app/use-delayed-connection-status.js";

const SHEET_DIALOG_HANDOFF_DELAY_MS = 260;

function ThreadActionsSurface({
  mobile,
  open,
  onOpenChange,
  triggerRef,
  handoffPending,
  threadId,
  threadTitle,
  children,
}: {
  readonly mobile: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly handoffPending: boolean;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const keyboardInset = useKeyboardInset(mobile && open);
  const trigger = (
    <Button
      ref={triggerRef}
      variant="ghost"
      size="icon-sm"
      className="thread-settings-button"
      aria-label="Thread actions"
      title="Thread settings and actions"
    >
      <Settings2 size={16} strokeWidth={1.8} />
    </Button>
  );

  if (mobile) {
    const descriptionId = `thread-settings-sheet-title-${threadId}`;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent
          className="thread-settings-sheet"
          style={{ "--thread-settings-keyboard-inset": `${keyboardInset}px` } as CSSProperties}
          overlayClassName="thread-settings-sheet-overlay"
          data-testid="thread-settings-sheet"
          aria-describedby={descriptionId}
          onCloseAutoFocus={(event) => {
            if (handoffPending) {
              event.preventDefault();
              return;
            }
            if (!triggerRef.current?.isConnected) return;
            event.preventDefault();
            triggerRef.current.focus();
          }}
        >
          <DialogTitle>Thread settings</DialogTitle>
          <DialogDescription
            id={descriptionId}
            className="thread-settings-sheet-thread-title"
            title={threadTitle}
          >
            {threadTitle}
          </DialogDescription>
          <div className="thread-settings-sheet-body">{children}</div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="menu-popover thread-actions-popover"
          data-testid="thread-actions-menu"
          align="end"
          sideOffset={8}
          aria-label="Thread actions"
          onFocusOutside={(event) => {
            const target = event.detail.originalEvent.target;
            if (
              target instanceof Element &&
              target.closest(
                '[data-slot="select-content"], [data-model-picker-content]',
              )
            ) {
              event.preventDefault();
            }
          }}
        >
          {children}
          <Popover.Arrow className="popover-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
  // Touch devices at any viewport width and any narrow viewport take the
  // modal archive choices; desktop/fine-pointer wide viewports keep the
  // dropdown (or direct archive when there are no descendants).
  const mobileShell = useMediaQuery("(pointer: coarse), (max-width: 819px)");
  const mobileLayout = useMediaQuery(SIDEBAR_NAV_MEDIA_QUERY);
  const navigationControls = useContext(NavigationControlsContext);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(snapshot.thread.title.text);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  useEffect(() => {
    if (findOpen) setMobileToolsOpen(true);
  }, [findOpen]);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [forceResetOpen, setForceResetOpen] = useState(false);
  const [archiveChoicesOpen, setArchiveChoicesOpen] = useState(false);
  const [archiveInitialImpact, setArchiveInitialImpact] = useState<ThreadArchiveImpact>();
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

  const closeActionsBefore = (action: () => void) => {
    if (!mobileShell) {
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
                mobile={mobileShell}
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
              <ThreadActionsSurface
                mobile={mobileShell}
                open={active && actionsOpen}
                onOpenChange={setActionsOpen}
                triggerRef={actionsTrigger}
                handoffPending={afterActionsClose.current !== undefined}
                threadId={snapshot.thread.id}
                threadTitle={snapshot.thread.title.text || "Untitled thread"}
              >
                <p className="menu-label">Thread actions</p>
                {mobileLayout && (
                  <p className="text-xs text-muted-foreground">
                    Execution target: <span className="text-foreground">{executionTargetLabel}{executionTarget?.available === false ? " · Unavailable" : ""}</span>
                  </p>
                )}
                <ThreadSettingsControls
                  store={store}
                  snapshot={snapshot}
                  disabled={disabled}
                  mobile
                />
                <Button
                  variant="ghost"
                  className="agent-tool-menu-item"
                  aria-label={`Agent tools… ${agentToolPolicySummary(snapshot.agentTools)}`}
                  onClick={() => {
                    closeActionsBefore(() => setAgentToolsOpen(true));
                  }}
                >
                  <span className="agent-tool-menu-label">
                    <Wrench size={18} strokeWidth={1.8} /> Agent tools…
                  </span>
                  <span className="agent-tool-menu-summary">
                    {agentToolPolicySummary(snapshot.agentTools)}
                  </span>
                </Button>
                <Button variant="ghost" className="agent-tool-menu-item" onClick={() => closeActionsBefore(() => setEnvironmentVariablesOpen(true))}>
                  <span className="agent-tool-menu-label"><SlidersHorizontal size={18} strokeWidth={1.8} /> Environment variables…</span>
                  <span className="agent-tool-menu-summary">Saved tools and commands snapshot</span>
                </Button>
                <ProviderFeatureThreadDetails
                  store={store}
                  snapshot={snapshot}
                  disabled={disabled}
                  mobile
                />
                {snapshot.thread.backingState === "unbound" &&
                  workspaces.length > 1 && (
                    <label className="draft-location">
                      <span>Draft workspace</span>
                      <Select
                        value={snapshot.workspace.id}
                        disabled={disabled || moveDraft?.available !== true}
                        onValueChange={(workspaceId) =>
                          void store
                            .moveDraft(workspaceId)
                            .then(() => setActionsOpen(false))
                            .catch(() => undefined)
                        }
                      >
                        <SelectTrigger size="sm" aria-label="Draft workspace">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          {workspaces.map((workspace) => (
                            <SelectItem
                              key={workspace.id}
                              value={workspace.id}
                              disabled={!workspace.available}
                            >
                              {workspace.label.text}
                              {showEnvironmentLabel &&
                              environments.find(
                                ({ id }) => id === workspace.environmentId,
                              )?.kind !== "local"
                                ? ` · ${
                                    environments.find(
                                      ({ id }) =>
                                        id === workspace.environmentId,
                                    )?.label.text ?? "Unknown environment"
                                  }`
                                : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  )}
                {snapshot.capabilities.automation.available && (
                  <Button
                    variant="ghost"
                    disabled={
                      disabled ||
                      (!snapshot.thread.automation &&
                        attachAutomation?.available !== true)
                    }
                    onClick={() => {
                      setActionsOpen(false);
                      navigate(threadAutomationPath(snapshot.thread.id));
                    }}
                  >
                    <Clock size={18} strokeWidth={1.8} />{" "}
                    {snapshot.thread.automation
                      ? "Automation settings…"
                      : "Automate…"}
                  </Button>
                )}
                {snapshot.thread.inventoryState === "settled" ? (
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      void mutateInventory("unsettle").catch(() => undefined)
                    }
                  >
                    <ArrowUpFromDot size={18} strokeWidth={1.8} /> Unsettle
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={disabled || settle?.available !== true}
                    title={settle?.unavailableReason?.text}
                    onClick={() => void requestSettle()}
                  >
                    <ArrowDownToDot size={18} strokeWidth={1.8} /> Settle
                  </Button>
                )}
                {snapshot.thread.inventoryState === "snoozed" ? (
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      void mutateInventory("wake").catch(() => undefined)
                    }
                  >
                    <Clock size={18} strokeWidth={1.8} /> Wake now
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={disabled || snooze?.available !== true}
                    title={snooze?.unavailableReason?.text}
                    onClick={() => {
                      closeActionsBefore(() => setSnoozeOpen(true));
                    }}
                  >
                    <Clock size={18} strokeWidth={1.8} /> Snooze…
                  </Button>
                )}
                <div className="thread-actions-separator" role="separator" />
                {snapshot.executionWorkspace.kind === "isolated" && (
                  <>
                    <ExecutionWorkspaceActions
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
                    <div
                      className="thread-actions-separator"
                      role="separator"
                    />
                  </>
                )}
                <Button
                  variant="ghost"
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
                      : THREAD_CONFIGURATION_COPY_ACCESSIBLE_LABEL
                  }
                  title={THREAD_CONFIGURATION_COPY_TITLE}
                  onClick={(event) =>
                    createFromSettings(pointerPanelPresentation(event))
                  }
                >
                  <CopyPlus size={18} strokeWidth={1.8} />
                  {configurationCopyPending
                    ? "Creating thread…"
                    : THREAD_CONFIGURATION_COPY_LABEL}
                </Button>
                {!snapshot.thread.available && (
                  <span
                    id={`header-settings-copy-unavailable-${snapshot.thread.id}`}
                    className="sr-only"
                  >
                    The source thread target is unavailable.
                  </span>
                )}
                <Button
                  variant="ghost"
                  disabled={disabled || !latestFork.available}
                  aria-describedby={
                    latestForkUnavailableReason
                      ? latestForkUnavailableDescriptionId
                      : undefined
                  }
                  onClick={(event) => {
                    if (!latestFork.selection || !latestFork.available) return;
                    const presentation = pointerPanelPresentation(event);
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
                  <Split
                    className="fork-split-icon"
                    size={18}
                    strokeWidth={1.8}
                  />
                  Fork
                </Button>
                {latestForkUnavailableReason && (
                  <span
                    className="sr-only"
                    id={latestForkUnavailableDescriptionId}
                  >
                    {latestForkUnavailableReason}
                  </span>
                )}
                <Button
                  variant="ghost"
                  onClick={() => {
                    closeActionsBefore(() => setSessionStatsOpen(true));
                  }}
                >
                  Session stats
                </Button>
                {compact && (
                  <Button
                    variant="ghost"
                    disabled={disabled || !compact.available}
                    title={compact.unavailableReason?.text}
                    onClick={() =>
                      void store
                        .perform({ action: "compact" })
                        .then(() => setActionsOpen(false))
                        .catch(() => undefined)
                    }
                  >
                    Compact context
                  </Button>
                )}
                <div className="thread-actions-separator" role="separator" />
                <Button
                  variant="destructive"
                  className="danger"
                  disabled={forceResetDisabled}
                  onClick={() => {
                    closeActionsBefore(() => setForceResetOpen(true));
                  }}
                >
                  <RotateCcw size={18} strokeWidth={1.8} /> Force reset…
                </Button>
                {snapshot.thread.inventoryState === "archived" ? (
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      void mutateInventory("restore").catch(() => undefined)
                    }
                  >
                    Restore to Active
                  </Button>
                ) : mobileShell ? (
                  // Small screens / coarse pointers cannot place the choice
                  // flyout reliably, so archiving always confirms through a
                  // modal — even when there are no descendants.
                  <Button
                    variant="destructive"
                    className="danger"
                    disabled={disabled || archive?.available !== true}
                    title={archive?.unavailableReason?.text}
                    onClick={() => {
                      closeActionsBefore(() => setArchiveChoicesOpen(true));
                    }}
                  >
                    <Archive size={18} strokeWidth={1.8} /> Archive
                  </Button>
                ) : familyDescendantCount === 0 ? (
                  // Desktop with no fork descendants archives immediately —
                  // unless the thread still has open tasks, which must be
                  // dispositioned through the archive choices modal first.
                  <Button
                    variant="destructive"
                    className="danger"
                    disabled={disabled || archive?.available !== true}
                    title={archive?.unavailableReason?.text}
                    onClick={() => {
                      setActionsOpen(false);
                      void runThreadArchiveCheck({
                        thread: applicationThreadSummary,
                        store: applicationStore,
                        onChoices: (impact) => {
                          setArchiveInitialImpact(impact);
                          setArchiveChoicesOpen(true);
                        },
                        onArchived: () => navigate("/"),
                      });
                    }}
                  >
                    <Archive size={18} strokeWidth={1.8} /> Archive
                  </Button>
                ) : (
                  <ArchiveDropdown
                    thread={applicationThreadSummary}
                    store={applicationStore}
                    descendantCount={familyDescendantCount}
                    disabled={disabled || archive?.available !== true}
                    onPendingChange={setInventoryPending}
                    onArchived={() => {
                      setActionsOpen(false);
                      navigate("/");
                    }}
                  >
                    <Button
                      variant="destructive"
                      className="danger"
                      title={archive?.unavailableReason?.text}
                    >
                      <Archive size={18} strokeWidth={1.8} /> Archive
                    </Button>
                  </ArchiveDropdown>
                )}
                {inventoryError && (
                  <p className="menu-error" role="alert">
                    {inventoryError}
                  </p>
                )}

              </ThreadActionsSurface>
            <Button
              variant={mobileToolsOpen ? "secondary" : "ghost"}
              size="icon-sm"
              className="thread-tools-toggle"
              aria-label={
                mobileToolsOpen ? "Hide thread toolbar" : "Show thread toolbar"
              }
              aria-expanded={mobileToolsOpen}
              aria-controls={`thread-toolbar-${snapshot.thread.id}`}
              onClick={() => {
                if (mobileToolsOpen) onFindOpenChange(false);
                setMobileToolsOpen((open) => !open);
              }}
            >
              <ChevronDown size={16} strokeWidth={1.8} />
            </Button>
          </div>
        }
      />
      {active && environmentVariablesOpen && <ThreadEnvironmentVariables key={snapshot.thread.id} api={applicationStore.api} threadId={snapshot.thread.id}
        title={snapshot.thread.title.text || "Untitled thread"} onClose={() => setEnvironmentVariablesOpen(false)} restoreFocus={() => actionsTrigger.current?.focus()}
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
      <ArchiveChoicesDialog
        open={active && archiveChoicesOpen}
        initialImpact={archiveInitialImpact}
        onOpenChange={(next) => {
          setArchiveChoicesOpen(next);
          if (!next) setArchiveInitialImpact(undefined);
        }}
        thread={applicationThreadSummary}
        store={applicationStore}
        descendantCount={familyDescendantCount}
        disabled={disabled || archive?.available !== true}
        onPendingChange={setInventoryPending}
        onArchived={() => {
          setActionsOpen(false);
          navigate("/");
          if (mobileLayout) navigationControls?.openDrawer();
        }}
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
