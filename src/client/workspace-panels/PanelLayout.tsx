import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useChatAutofocus } from "../app/use-chat-autofocus.js";
import { parseRoute, pushHistoryEntry, replaceHistoryEntry } from "../app/router.js";
import {
  CheckIcon,
  ChevronDown,
  Files,
  LayoutPanelTop,
  ListChecks,
  MessageSquare,
  NotepadText,
  PanelTop,
  RotateCcw,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type { TerminalResource } from "../../shared/index.js";
import { ApiError } from "../api/ApiClient.js";
import { Button } from "../components/ui/button.js";
import { BackendBrandIcon } from "../components/brand-icons.js";
import { TasksPanelToggle } from "../components/tasks/TasksPanelToggle.js";
import { WorkbenchPanelToggle } from "../components/WorkbenchPanelToggle.js";
import {
  usePublishTasksDock,
  useTasksHost,
} from "../components/tasks/tasks-host.js";
import { SidebarNavTrigger } from "../components/SidebarNavTrigger.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { DiscardChangesDialog } from "../components/ui/discard-changes-dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuValue,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import {
  menuCheckIndicatorClass,
  menuCheckRowClass,
} from "../components/ui/floating.js";
import { cn } from "../lib/utils.js";
import { PaneResizeHandle } from "../components/PaneResizeHandle.js";
import { useComposerDraftStaging } from "../context-excerpts/coordinator.js";
import {
  useApplicationStore,
  type ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";
import {
  useThreadStore,
  type ThreadClientStore,
} from "../stores/ThreadClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import {
  isTerminalProcessLive,
  terminalTerminationLabel,
  TerminalPanel,
  TerminalTabs,
  ThreadTerminalMenu,
  terminalConnectionLabel,
  terminalTabId,
  terminalTabPanelId,
  type TerminalPanelHandle,
  type TerminalSessionSnapshot,
  type ThreadTerminalControls,
  type ThreadTerminalMenuHandle,
} from "../terminals/index.js";
import {
  panelDockEdge,
  panelInstances,
  type LayoutNode,
  type PanelInstance,
  type PanelInstanceId,
  type PanelLayoutTree,
  type SplitNode,
  type TabStackNode,
} from "./layout-tree.js";
import { projectPanelLayout } from "./layout-presentation.js";
import {
  SPLIT_HANDLE_SIZE,
  panelsToMakeRoom,
  resolveSplit,
  type PanelMinimum,
} from "./layout-fit.js";
import {
  PanelLayoutStore,
  usePanelLayout,
  type PanelFocusRequest,
} from "./panel-state.js";
import {
  PanelChrome,
  panelContentId,
  type PanelChromeControls,
  type PanelChromeStatus,
} from "./PanelChrome.js";
import type {
  WorkspacePanelContext,
  WorkspacePanelHost,
  WorkspacePanelTenant,
  WorkspacePanelTenantRegistry,
} from "./registry.js";
import { StablePaneSlot } from "./StablePaneSlot.js";
import {
  environmentTintStyle,
  resolveEnvironmentPaletteTones,
} from "../app/environment-palette.js";
import { useEnvironmentPalette } from "../app/use-environment-palette.js";
import {
  getConfirmTerminalTermination,
  subscribeConfirmTerminalTermination,
} from "../app/settings.js";

const MOBILE_QUERY = "(max-width: 819px)";
/** The divider's floor, and the minimum of panels without a declared one. */
const MIN_PANEL_SIZE = 160;
/** Chat keeps room for the transcript and the composer's controls. */
const CHAT_MIN_WIDTH = 360;
const MOBILE_TERMINAL_HISTORY_KEY = "sedesMobileTerminalPanel";

interface DirtyConfirmation {
  readonly description: string;
  readonly actionLabel: string;
  readonly run: () => void;
}

interface TerminalLifecycleConfirmation {
  readonly terminalId: string;
  readonly label: string;
  readonly terminal?: TerminalResource;
}

interface TerminalLookupFailure {
  readonly kind: "gone" | "transient";
  readonly message: string;
}

export interface PanelLayoutProps {
  readonly active?: boolean;
  readonly store: PanelLayoutStore;
  readonly tenants: WorkspacePanelTenantRegistry;
  readonly applicationStore: ApplicationClientStore;
  readonly threadRegistry: ThreadStoreRegistry;
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly environmentId?: string;
  readonly environmentIds: readonly string[];
  readonly environmentTintEnabled: boolean;
  readonly renderChat: (
    panelControls: PanelChromeControls,
    visible: boolean,
  ) => React.ReactElement;
}

export function PanelLayout(props: PanelLayoutProps): React.JSX.Element {
  const threadStore = useMemo(
    () => props.threadRegistry.get(props.threadId),
    [props.threadId, props.threadRegistry],
  );
  return <PanelLayoutReady {...props} threadStore={threadStore} />;
}

function PanelLayoutReady({
  active = true,
  store,
  tenants,
  applicationStore,
  threadRegistry,
  threadId,
  workspaceId,
  environmentId,
  environmentIds,
  environmentTintEnabled,
  renderChat,
  threadStore,
}: PanelLayoutProps & {
  readonly threadStore: ThreadClientStore;
}): React.JSX.Element {
  const activeRef = useRef(active);
  activeRef.current = active;
  const [panelsMenuOpen, setPanelsMenuOpen] = useState(false);
  const { tree, collapsed, focusRequest, soloPanelInstanceId } =
    usePanelLayout(store);
  const threadState = useThreadStore(threadStore);
  const applicationState = useApplicationStore(applicationStore);
  const { snapshot } = threadState;
  const openThreadTaskCount = useMemo(
    () =>
      (applicationState.snapshot?.tasks ?? []).filter(
        (task) =>
          task.completedAt === null &&
          task.scope.kind === "thread" &&
          task.scope.threadId === threadId,
      ).length,
    [applicationState.snapshot?.tasks, threadId],
  );
  const applicationThread = applicationState.snapshot?.threads.find(
    ({ id }) => id === threadId,
  );
  const terminalSummary = applicationThread?.terminalSummary;
  const workpadCount = active && applicationState.authoritative
    ? applicationThread?.nonArchivedWorkpadCount : undefined;
  const environmentPalette = useEnvironmentPalette();
  const tones = useMemo(
    () => resolveEnvironmentPaletteTones(environmentIds, environmentPalette),
    [environmentIds, environmentPalette],
  );
  const tone = environmentId ? tones.get(environmentId) : undefined;
  const tint =
    environmentTintEnabled && tone ? environmentTintStyle(tone) : undefined;
  const stageRef = useRef<HTMLDivElement>(null);
  const terminalEntryRef = useRef<ThreadTerminalMenuHandle>(null);
  const terminalTabMenuRef = useRef<ThreadTerminalMenuHandle>(null);
  const openPanelsTriggerRef = useRef<HTMLButtonElement>(null);
  const lastInteractedPanelIdRef = useRef<PanelInstanceId | undefined>(
    undefined,
  );
  // Panels from least to most recently used: opened, restored, focused or
  // pressed. Making room collapses the least recently used side panel.
  const panelRecencyRef = useRef<readonly PanelInstanceId[]>([]);
  const notePanelUsed = (panelInstanceId: PanelInstanceId) => {
    panelRecencyRef.current = [
      ...panelRecencyRef.current.filter((id) => id !== panelInstanceId),
      panelInstanceId,
    ];
  };
  // The panels last seen on the desktop stage, for the thread they belong to.
  const stagedPanelsRef = useRef<
    | { readonly threadId: string; readonly ids: ReadonlySet<PanelInstanceId> }
    | undefined
  >(undefined);
  const menuFocusTarget = useRef<PanelInstanceId | undefined>(undefined);
  const mobileTerminalHistoryRef = useRef<
    | {
        readonly panelInstanceId: PanelInstanceId;
        readonly token: string;
        readonly previousState: unknown;
      }
    | undefined
  >(undefined);
  const closeMobileTerminalRef = useRef<() => void>(() => undefined);
  const chatAutofocus = useChatAutofocus();
  const [desktop, setDesktop] = useState(
    () => !window.matchMedia(MOBILE_QUERY).matches,
  );
  const terminalClosePendingRef = useRef<symbol | undefined>(undefined);
  const [confirmTerminalTermination, setConfirmTerminalTerminationState] =
    useState(getConfirmTerminalTermination);
  const [chatTarget] = useState(() => createPortalTarget("chat", "Chat"));
  const [filesTarget] = useState(() =>
    createPortalTarget("workspace-files", "Files"),
  );
  const [filesChromeActionsTarget] = useState(createChromeActionsTarget);
  const [workpadsTarget] = useState(() => createPortalTarget("workpads", "Workpads"));
  const [workpadsChromeActionsTarget] = useState(createChromeActionsTarget);
  const [tasksTarget] = useState(() => createPortalTarget("tasks", "Tasks"));
  const [tasksChromeActionsTarget] = useState(createChromeActionsTarget);
  const tasksHost = useTasksHost();
  const tenantTargets = (kind: "files" | "workpads" | "tasks") =>
    kind === "files"
      ? { target: filesTarget, actionsTarget: filesChromeActionsTarget }
      : kind === "workpads"
        ? { target: workpadsTarget, actionsTarget: workpadsChromeActionsTarget }
        : { target: tasksTarget, actionsTarget: tasksChromeActionsTarget };
  const [statuses, setStatuses] = useState<
    ReadonlyMap<PanelInstanceId, PanelChromeStatus>
  >(() => new Map());
  const [terminalResources, setTerminalResources] = useState<
    ReadonlyMap<string, TerminalResource>
  >(() => new Map());
  const [terminalLookupFailures, setTerminalLookupFailures] = useState<
    ReadonlyMap<string, TerminalLookupFailure>
  >(() => new Map());
  const [terminalLookupRevision, setTerminalLookupRevision] = useState(0);
  const terminalPanelRef = useRef<TerminalPanelHandle>(null);
  const terminalLifecycleMutationIdsRef = useRef(
    new Map<
      string,
      { readonly revision: number; readonly mutationId: string }
    >(),
  );
  const terminalRenameMutationIdsRef = useRef(
    new Map<
      string,
      { readonly fingerprint: string; readonly mutationId: string }
    >(),
  );
  const [terminalSessionState, setTerminalSessionState] =
    useState<TerminalSessionSnapshot>();
  const [terminalLifecyclePendingId, setTerminalLifecyclePendingId] =
    useState<string>();
  const [terminalLifecycleError, setTerminalLifecycleError] = useState<{
    readonly terminalId: string;
    readonly message: string;
  }>();
  const [dirtyConfirmation, setDirtyConfirmation] =
    useState<DirtyConfirmation>();
  const [terminalLifecycleConfirmation, setTerminalLifecycleConfirmation] =
    useState<TerminalLifecycleConfirmation>();
  const [announcement, setAnnouncement] = useState("");
  const [availableSize, setAvailableSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [previewSizes, setPreviewSizes] = useState<
    ReadonlyMap<string, readonly [number, number]>
  >(() => new Map());
  const [mobilePanelId, setMobilePanelId] = useState<PanelInstanceId>();
  const terminalResourceThreadRef = useRef(threadId);
  const terminalInventoryGenerationRef = useRef(0);
  const pendingTerminalLookupsRef = useRef(new Set<string>());
  const terminalLookupsMountedRef = useRef(true);

  useEffect(
    () => subscribeConfirmTerminalTermination(setConfirmTerminalTerminationState),
    [],
  );

  useEffect(() => {
    terminalLookupsMountedRef.current = true;
    return () => {
      terminalLookupsMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (terminalResourceThreadRef.current === threadId) return;
    terminalResourceThreadRef.current = threadId;
    setTerminalResources(new Map());
    setTerminalLookupFailures(new Map());
    setTerminalSessionState(undefined);
    terminalLifecycleMutationIdsRef.current.clear();
    terminalRenameMutationIdsRef.current.clear();
    terminalClosePendingRef.current = undefined;
    setTerminalLifecyclePendingId(undefined);
    setTerminalLifecycleError(undefined);
    setTerminalLifecycleConfirmation(undefined);
  }, [threadId]);

  const panels = panelInstances(tree);
  const visibleTree = projectPanelLayout(tree, collapsed);
  const layoutActiveVisibleIds = useMemo(
    () => activePanelIds(visibleTree),
    [visibleTree],
  );
  const soloPanel =
    desktop && soloPanelInstanceId && !collapsed.has(soloPanelInstanceId)
      ? panels.find(
          ({ panelInstanceId }) => panelInstanceId === soloPanelInstanceId,
        )
      : undefined;
  const activeVisibleIds = useMemo(
    () =>
      soloPanel
        ? new Set<PanelInstanceId>([soloPanel.panelInstanceId])
        : layoutActiveVisibleIds,
    [layoutActiveVisibleIds, soloPanel],
  );
  const chatPanel = panels.find((panel) => panel.kind === "chat");
  const filesPanel = panels.find((panel) => panel.kind === "files");
  const workpadsPanel = panels.find((panel) => panel.kind === "workpads");
  const tasksPanel = panels.find((panel) => panel.kind === "tasks");
  const terminalsPanel = panels.find((panel) => panel.kind === "terminals");
  // Phones show Tasks as the host's bottom sheet, never as a stage panel.
  const stagePanels = desktop
    ? panels
    : panels.filter((panel) => panel.kind !== "tasks");
  const filesIntent = filesPanel
    ? store.intent(filesPanel.panelInstanceId)
    : undefined;
  const filesIntentWorkspaceId = objectStringField(filesIntent, "workspaceId");
  const filesIntentSequence = objectSafeIntegerField(filesIntent, "sequence");
  const selectedMobilePanel = chooseMobilePanel(
    stagePanels,
    layoutActiveVisibleIds,
    mobilePanelId,
    focusRequest?.panelInstanceId,
  );
  const actuallyVisible = (panelInstanceId: string): boolean =>
    desktop
      ? activeVisibleIds.has(panelInstanceId)
      : selectedMobilePanel?.panelInstanceId === panelInstanceId;
  const panelMinimum: PanelMinimum = (panel, axis) => {
    if (panel.kind === "chat")
      return axis === "width" ? CHAT_MIN_WIDTH : MIN_PANEL_SIZE;
    if (panel.kind === "terminals") return MIN_PANEL_SIZE;
    const size = tenants.tenant(tenantIdForKind(panel.kind))?.size;
    if (!size) return MIN_PANEL_SIZE;
    return axis === "width" ? size.minWidth : size.minHeight;
  };

  const removeTerminalFromClient = (
    terminalId: string,
    displayName = "Terminal",
    disposition: "ended" | "removed" | "disconnected" = "ended",
  ) => {
    if (store.terminalPanel()?.activeTerminalId === terminalId)
      setTerminalSessionState(undefined);
    setTerminalResources((current) => withoutMapKey(current, terminalId));
    setTerminalLookupFailures((current) => withoutMapKey(current, terminalId));
    store.closeTerminalTab(terminalId);
    setAnnouncement(
      `${displayName} ${disposition}. Its retained terminal history was removed.`,
    );
  };

  const closeTerminalView = (terminalId: string, label: string) => {
    if (store.terminalPanel()?.activeTerminalId === terminalId)
      setTerminalSessionState(undefined);
    if (!store.closeTerminalTab(terminalId)) return;
    setAnnouncement(`${label} tab closed. Its process was not terminated.`);
  };

  const requestTerminalClose = (terminalId: string) => {
    if (terminalClosePendingRef.current) return;
    const resource = terminalResources.get(terminalId);
    const terminal = resource?.threadId === threadId ? resource : undefined;
    if (
      getConfirmTerminalTermination() &&
      (!terminal || isTerminalProcessLive(terminal.lifecycle))
    ) {
      setTerminalLifecycleConfirmation({
        terminalId,
        label: terminal?.displayName ?? "Terminal",
        terminal,
      });
      return;
    }
    void endOrRemoveTerminal(terminalId, terminal);
  };

  const endOrRemoveTerminal = async (
    terminalId: string,
    knownTerminal?: TerminalResource,
  ) => {
    if (terminalClosePendingRef.current) return;
    const pendingToken = Symbol();
    terminalClosePendingRef.current = pendingToken;
    const actionThreadId = threadId;
    setTerminalLifecyclePendingId(terminalId);
    setTerminalLifecycleError(undefined);
    let live = true;
    try {
      const terminal =
        knownTerminal ?? await applicationStore.api.readTerminal(terminalId);
      if (terminalClosePendingRef.current !== pendingToken) return;
      if (
        terminal.threadId !== actionThreadId ||
        terminal.terminalId !== terminalId
      )
        throw new Error("The terminal is no longer available.");
      live = isTerminalProcessLive(terminal.lifecycle);
      const action = live ? "end" : "remove";
      const key = `${action}:${terminal.terminalId}`;
      const existing = terminalLifecycleMutationIdsRef.current.get(key);
      const mutationId =
        existing?.revision === terminal.lifecycleRevision
          ? existing.mutationId
          : crypto.randomUUID();
      terminalLifecycleMutationIdsRef.current.set(key, {
        revision: terminal.lifecycleRevision,
        mutationId,
      });
      const request = {
        mutationId,
        expectedRevision: terminal.lifecycleRevision,
      };
      if (live)
        await applicationStore.api.endTerminal(terminal.terminalId, request);
      else
        await applicationStore.api.deleteTerminal(terminal.terminalId, request);
      if (terminalClosePendingRef.current !== pendingToken) return;
      terminalLifecycleMutationIdsRef.current.delete(key);
      removeTerminalFromClient(
        terminal.terminalId,
        terminal.displayName,
        live
          ? terminal.terminationEffect === "disconnect_transport" ? "disconnected" : "ended"
          : "removed",
      );
    } catch (error: unknown) {
      if (terminalClosePendingRef.current !== pendingToken) return;
      const message =
        error instanceof Error
          ? error.message
          : `The terminal could not be ${live ? "ended" : "removed"}.`;
      setTerminalLifecycleError({ terminalId, message });
      setAnnouncement(message);
    } finally {
      if (terminalClosePendingRef.current === pendingToken) {
        terminalClosePendingRef.current = undefined;
        setTerminalLifecyclePendingId((current) =>
          current === terminalId ? undefined : current,
        );
      }
    }
  };

  const renameTerminal = async (terminalId: string, displayName: string) => {
    const terminal = terminalResources.get(terminalId);
    if (!terminal || terminal.threadId !== threadId)
      throw new Error("The terminal is no longer available.");
    const actionThreadId = terminal.threadId;
    const fingerprint = JSON.stringify({
      revision: terminal.lifecycleRevision,
      displayName,
    });
    const existing = terminalRenameMutationIdsRef.current.get(terminalId);
    const mutationId =
      existing?.fingerprint === fingerprint
        ? existing.mutationId
        : crypto.randomUUID();
    terminalRenameMutationIdsRef.current.set(terminalId, {
      fingerprint,
      mutationId,
    });
    try {
      const result = await applicationStore.api.renameTerminal(terminalId, {
        mutationId,
        expectedRevision: terminal.lifecycleRevision,
        displayName,
      });
      if (
        !result.terminal ||
        result.terminal.terminalId !== terminalId ||
        result.terminal.threadId !== actionThreadId
      )
        throw new Error("The renamed terminal could not be verified.");
      terminalRenameMutationIdsRef.current.delete(terminalId);
      if (terminalResourceThreadRef.current !== actionThreadId) return;
      setTerminalResource(setTerminalResources, result.terminal);
      setAnnouncement(`${result.terminal.displayName} terminal renamed.`);
    } catch (error: unknown) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      terminalRenameMutationIdsRef.current.delete(terminalId);
      try {
        const authoritative = await applicationStore.api.readTerminal(terminalId);
        if (
          terminalResourceThreadRef.current === actionThreadId &&
          authoritative.terminalId === terminalId &&
          authoritative.threadId === actionThreadId
        ) {
          setTerminalResource(setTerminalResources, authoritative);
        } else {
          throw new Error("The terminal is no longer available.");
        }
      } catch {
        throw new Error(
          "The terminal changed elsewhere, but its latest name could not be loaded. Try again to refresh it.",
        );
      }
      throw new Error(
        "The terminal changed elsewhere. Review its latest name and try again.",
      );
    }
  };

  useEffect(() => {
    if (
      !terminalSummary ||
      !applicationState.authoritative ||
      applicationState.connection !== "connected" ||
      terminalsPanel?.threadId !== threadId ||
      terminalsPanel.tabs.length === 0
    )
      return;
    const generation = ++terminalInventoryGenerationRef.current;
    let disposed = false;
    void applicationStore.api
      .listTerminals(threadId)
      .then((result) => {
        if (disposed || generation !== terminalInventoryGenerationRef.current)
          return;
        const current = result.terminals.filter(
          (terminal) => terminal.threadId === threadId,
        );
        const currentIds = new Set(
          current.map((terminal) => terminal.terminalId),
        );
        const panel = store.terminalPanel();
        const removedTabs = (
          panel?.threadId === threadId ? panel.tabs : []
        ).filter(({ terminalId }) => !currentIds.has(terminalId));
        if (
          removedTabs.some(
            ({ terminalId }) => terminalId === panel?.activeTerminalId,
          )
        )
          setTerminalSessionState(undefined);
        setTerminalResources(
          () =>
            new Map(current.map((terminal) => [terminal.terminalId, terminal])),
        );
        setTerminalLookupFailures((failures) => {
          let next = failures;
          for (const { terminalId } of removedTabs)
            next = withoutMapKey(next, terminalId);
          return next;
        });
        for (const { terminalId } of removedTabs)
          store.closeTerminalTab(terminalId);
        if (removedTabs.length > 0) {
          const first = terminalResources.get(removedTabs[0]!.terminalId);
          setAnnouncement(
            removedTabs.length === 1
              ? `${first?.displayName ?? "Terminal"} ended. Its retained terminal history was removed.`
              : `${removedTabs.length} terminals ended. Their retained terminal history was removed.`,
          );
        }
      })
      .catch(() => {
        // Summary invalidation is advisory. A failed inventory refresh must
        // not speculate that any local terminal was removed; the next summary
        // change or explicit roster refresh retries from authoritative HTTP.
      });
    return () => {
      disposed = true;
    };
  }, [
    applicationStore,
    applicationState.authoritative,
    applicationState.connection,
    terminalSummary,
    terminalsPanel?.threadId,
    terminalsPanel?.tabs.map(({ terminalId }) => terminalId).join(":"),
    threadId,
  ]);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => {
      if (media.matches) {
        const focusedPanelId = document.activeElement?.closest<HTMLElement>(
          "[data-panel-instance-id]",
        )?.dataset.panelInstanceId;
        const foregroundPanelId =
          focusedPanelId ?? lastInteractedPanelIdRef.current;
        if (foregroundPanelId) setMobilePanelId(foregroundPanelId);
      }
      setDesktop(!media.matches);
    };
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const bounds = stage.getBoundingClientRect();
      setAvailableSize({ width: bounds.width, height: bounds.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Focusing or pressing inside a panel uses it. The listeners are native,
  // on the stage element: content portaled into a panel from outside this
  // React tree (the retained Tasks body) bubbles its React events past the
  // stage, but its DOM events pass through it.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const noteUse = (event: Event) => {
      const panelInstanceId =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-panel-instance-id]")
              ?.dataset.panelInstanceId
          : undefined;
      if (!panelInstanceId) return;
      lastInteractedPanelIdRef.current = panelInstanceId;
      notePanelUsed(panelInstanceId);
    };
    stage.addEventListener("focusin", noteUse, true);
    stage.addEventListener("pointerdown", noteUse, true);
    return () => {
      stage.removeEventListener("focusin", noteUse, true);
      stage.removeEventListener("pointerdown", noteUse, true);
    };
    // notePanelUsed reads and writes refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A panel that arrives on the desktop stage (opened or restored) makes room
  // for itself: when the visible panels' minimum width no longer fits, the
  // least recently used side panels collapse (see layout-fit.ts). What a
  // thread already shows when it mounts or is switched to is left alone.
  const stagedPanelIds = desktop && !soloPanel ? layoutActiveVisibleIds : undefined;
  useLayoutEffect(() => {
    const previous = stagedPanelsRef.current;
    stagedPanelsRef.current = stagedPanelIds && { threadId, ids: stagedPanelIds };
    if (!stagedPanelIds || previous?.threadId !== threadId) return;
    const arrived = [...stagedPanelIds].filter((id) => !previous.ids.has(id));
    if (arrived.length === 0) return;
    for (const id of arrived) notePanelUsed(id);
    // An unmeasured stage (nothing laid out yet) has no room to make.
    if (availableSize.width <= 0) return;
    const room = panelsToMakeRoom({
      tree,
      collapsed,
      width: availableSize.width,
      minimum: panelMinimum,
      recency: panelRecencyRef.current,
      keep: new Set<PanelInstanceId>(["chat", ...arrived]),
    });
    const titles: string[] = [];
    for (const id of room) {
      const panel = panels.find(({ panelInstanceId }) => panelInstanceId === id);
      if (panel && store.collapsePanel(id))
        titles.push(panelTitle(panel, terminalResources));
    }
    if (titles.length > 0)
      setAnnouncement(`${titles.join(" and ")} collapsed to make room.`);
    // Runs when the staged panels change; the size and recency are read as of then.
  }, [stagedPanelIds, threadId]);

  useEffect(() => {
    if (chatPanel) return;
    threadRegistry.retainCached(threadId);
    return () => threadRegistry.releaseCached(threadId);
  }, [chatPanel, threadId, threadRegistry]);

  useEffect(() => {
    const missing = (
      terminalsPanel?.threadId === threadId ? terminalsPanel.tabs : []
    ).filter(({ terminalId }) => {
      const cached = terminalResources.get(terminalId);
      const lookupKey = `${threadId}:${terminalId}`;
      return (
        (!cached || cached.threadId !== threadId) &&
        !terminalLookupFailures.has(terminalId) &&
        !pendingTerminalLookupsRef.current.has(lookupKey)
      );
    });
    for (const tab of missing) {
      const lookupThreadId = threadId;
      const lookupKey = `${lookupThreadId}:${tab.terminalId}`;
      pendingTerminalLookupsRef.current.add(lookupKey);
      void applicationStore.api
        .readTerminal(tab.terminalId)
        .then((terminal) => {
          if (
            !terminalLookupsMountedRef.current ||
            terminalResourceThreadRef.current !== lookupThreadId
          )
            return;
          if (terminal.threadId !== lookupThreadId) {
            setTerminalLookupFailures((current) =>
              new Map(current).set(tab.terminalId, {
                kind: "gone",
                message: "That terminal belongs to a different thread.",
              }),
            );
            return;
          }
          setTerminalResources((current) => {
            const cached = current.get(terminal.terminalId);
            if (
              cached?.threadId === lookupThreadId &&
              cached.lifecycleRevision >= terminal.lifecycleRevision
            )
              return current;
            return new Map(current).set(terminal.terminalId, terminal);
          });
          setTerminalLookupFailures((current) =>
            withoutMapKey(current, terminal.terminalId),
          );
        })
        .catch((error: unknown) => {
          if (
            terminalLookupsMountedRef.current &&
            terminalResourceThreadRef.current === lookupThreadId
          ) {
            setTerminalLookupFailures((current) =>
              new Map(current).set(
                tab.terminalId,
                terminalLookupFailure(error),
              ),
            );
          }
        })
        .finally(() => {
          pendingTerminalLookupsRef.current.delete(lookupKey);
        });
    }
  }, [
    applicationStore,
    terminalsPanel?.tabs.map(({ terminalId }) => terminalId).join(":"),
    terminalLookupRevision,
    terminalResources,
  ]);

  useEffect(() => {
    if (!active || !focusRequest || !focusRequestMatchesThread(focusRequest, threadId))
      return;
    // A cold Chat route initially contains only ThreadLoading. Focusing the
    // portal target at that point would consume the request before the
    // preferred composer mounts. Keep an eligible autofocus request pending;
    // the interaction listeners below still abandon it if the user chooses a
    // different target while the thread loads.
    if (
      chatAutofocus &&
      focusRequest.panelInstanceId === "chat" &&
      threadState.status === "loading" &&
      preferredFocusTarget(chatTarget) === undefined
    )
      return;
    let cancelled = false;
    setMobilePanelId(focusRequest.panelInstanceId);
    const attemptFocus = (remainingRetries: number) => {
      if (cancelled) return;
      if (focusRequest.terminalId) {
        const focused = !desktop || terminalPanelRef.current?.focus() === true;
        if (focused) {
          store.consumeFocusRequest(focusRequest.sequence);
        } else if (remainingRetries > 0) {
          requestAnimationFrame(() => attemptFocus(remainingRetries - 1));
        }
        return;
      }
      const target = panelFocusTarget(focusRequest.panelInstanceId, {
        chat: chatTarget,
        files: filesTarget,
        workpads: workpadsTarget,
        tasks: tasksTarget,
      });
      if (
        !focusInside(
          target,
          focusRequest.panelInstanceId === "chat" ? chatAutofocus : desktop,
        )
      ) return;
      const focused = document.activeElement;
      requestAnimationFrame(() => {
        if (cancelled) return;
        if (
          focused instanceof HTMLElement &&
          focused.isConnected &&
          document.activeElement === focused &&
          store.getSnapshot().focusRequest?.sequence === focusRequest.sequence
        ) {
          store.consumeFocusRequest(focusRequest.sequence);
        } else if (
          remainingRetries > 0 &&
          store.getSnapshot().focusRequest?.sequence === focusRequest.sequence
        ) {
          attemptFocus(remainingRetries - 1);
        }
      });
    };
    requestAnimationFrame(() => {
      if (!cancelled) requestAnimationFrame(() => attemptFocus(2));
    });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    chatTarget,
    chatAutofocus,
    desktop,
    filesTarget,
    workpadsTarget,
    tasksTarget,
    focusRequest,
    store,
    threadId,
    threadState.authoritative,
    threadState.connection,
    threadState.status,
  ]);

  useEffect(() => {
    if (!active || !focusRequest || !focusRequestMatchesThread(focusRequest, threadId))
      return;
    const requestedTarget = panelFocusTarget(focusRequest.panelInstanceId, {
      chat: chatTarget,
      files: filesTarget,
      workpads: workpadsTarget,
      tasks: tasksTarget,
    });
    const abandonDeferredFocus = (event: Event) => {
      if (
        event.target instanceof Node &&
        requestedTarget?.contains(event.target)
      ) {
        return;
      }
      store.consumeFocusRequest(focusRequest.sequence);
    };
    document.addEventListener("pointerdown", abandonDeferredFocus, true);
    document.addEventListener("keydown", abandonDeferredFocus, true);
    return () => {
      document.removeEventListener("pointerdown", abandonDeferredFocus, true);
      document.removeEventListener("keydown", abandonDeferredFocus, true);
    };
  }, [active, chatTarget, filesTarget, workpadsTarget, tasksTarget, focusRequest, store, threadId]);

  useEffect(() => {
    if (
      filesIntentWorkspaceId !== undefined &&
      workspaceId !== undefined &&
      filesIntentWorkspaceId !== workspaceId &&
      filesIntentSequence !== undefined &&
      filesPanel
    ) {
      store.consumeIntent(filesPanel.panelInstanceId, filesIntentSequence);
    }
  }, [
    filesIntentSequence,
    filesIntentWorkspaceId,
    filesPanel,
    store,
    workspaceId,
  ]);

  useEffect(() => setPreviewSizes(new Map()), [tree]);
  // Files remounts with its workspace; Workpads keeps its global editor and
  // must retain its dirty/busy status across workspace navigation.
  useEffect(() => {
    setStatuses((current) => withoutMapKey(current, "workspace-files"));
  }, [workspaceId]);

  const filesDirty = Boolean(statuses.get("workspace-files")?.dirty);
  useEffect(() => {
    if (!workspaceId) return undefined;
    store.setWorkspaceTenantDirty(workspaceId, "workspace-files", filesDirty);
    return () => {
      store.setWorkspaceTenantDirty(workspaceId, "workspace-files", false);
    };
  }, [filesDirty, store, workspaceId]);

  const updateStatus = (
    panelInstanceId: PanelInstanceId,
    status: PanelChromeStatus,
  ) => {
    setStatuses((current) => {
      const next = new Map(current);
      if (status.busy || status.dirty || status.subtitle)
        next.set(panelInstanceId, status);
      else next.delete(panelInstanceId);
      return next;
    });
  };

  const focusAfterHide = (hidden: PanelInstanceId) => {
    requestAnimationFrame(() => {
      const currentCollapsed = store.getSnapshot().collapsed;
      const next = stagePanels.find(
        ({ panelInstanceId }) =>
          panelInstanceId !== hidden && !currentCollapsed.has(panelInstanceId),
      );
      if (next) {
        store.activatePanel(next.panelInstanceId, { focus: false });
        setMobilePanelId(next.panelInstanceId);
        focusInside(
          panelFocusTarget(next.panelInstanceId, {
            chat: chatTarget,
            files: filesTarget,
            workpads: workpadsTarget,
            tasks: tasksTarget,
          }),
          desktop,
        );
      } else openPanelsTriggerRef.current?.focus();
    });
  };

  const collapsePanel = (panel: PanelInstance) => {
    if (!store.collapsePanel(panel.panelInstanceId)) return;
    if (panel.kind === "terminals") setTerminalSessionState(undefined);
    setAnnouncement(`${panelTitle(panel, terminalResources)} collapsed.`);
    focusAfterHide(panel.panelInstanceId);
  };

  const closePanel = (panel: PanelInstance, invoker?: HTMLElement) => {
    const mobileHistory = mobileTerminalHistoryRef.current;
    if (
      !desktop &&
      panel.kind === "terminals" &&
      mobileHistory?.panelInstanceId === panel.panelInstanceId &&
      historyMarker(window.history.state) === mobileHistory.token
    ) {
      // The same-URL entry exists so browser and Android Back dismiss this
      // client-local viewer without navigating away from the thread.
      window.history.back();
      return;
    }
    const run = () => {
      if (!store.closePanel(panel.panelInstanceId)) return;
      if (panel.kind === "terminals") setTerminalSessionState(undefined);
      setAnnouncement(
        panel.kind === "terminals"
          ? `${panelTitle(panel, terminalResources)} panel closed. Its process was not terminated.`
          : `${panelTitle(panel, terminalResources)} panel closed.`,
      );
      requestAnimationFrame(() => {
        if (invoker?.isConnected) invoker.focus();
        else focusAfterHide(panel.panelInstanceId);
      });
    };
    if (statuses.get(panel.panelInstanceId)?.dirty) {
      setDirtyConfirmation({
        description: `Closing ${panelTitle(panel, terminalResources)} will discard its unsaved changes.`,
        actionLabel: "Discard and close",
        run,
      });
    } else run();
  };

  closeMobileTerminalRef.current = () => {
    if (selectedMobilePanel?.kind === "terminals")
      closePanel(selectedMobilePanel);
  };

  useEffect(() => {
    if (!active || desktop || selectedMobilePanel?.kind !== "terminals") return;
    const panelInstanceId = selectedMobilePanel.panelInstanceId;
    const retained = mobileTerminalHistoryRef.current;
    const reuseEntry = retained?.panelInstanceId === panelInstanceId &&
      historyMarker(window.history.state) === retained.token;
    const previousState: unknown = reuseEntry ? retained.previousState : window.history.state;
    const token = reuseEntry ? retained.token : crypto.randomUUID();
    if (!reuseEntry) pushHistoryEntry(
      withHistoryMarker(previousState, token),
      window.location.href,
    );
    mobileTerminalHistoryRef.current = {
      panelInstanceId,
      token,
      previousState,
    };

    const closeFromBack = () => {
      const current = mobileTerminalHistoryRef.current;
      const destination = parseRoute(window.location.pathname, window.location.hash);
      // Router publication precedes React's effect cleanup. A Forward into
      // Settings can reach this old listener before `active` becomes false.
      if (current?.panelInstanceId !== panelInstanceId ||
        destination.name !== "thread" || destination.threadId !== threadId ||
        historyMarker(window.history.state) === current.token) return;
      mobileTerminalHistoryRef.current = undefined;
      closeMobileTerminalRef.current();
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const targetOverlay =
        event.target instanceof Element
          ? event.target.closest(
              '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
            )
          : null;
      if (
        targetOverlay &&
        !targetOverlay.matches('[data-mobile-terminal-panel="true"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      closeMobileTerminalRef.current();
    };
    window.addEventListener("popstate", closeFromBack);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      window.removeEventListener("popstate", closeFromBack);
      document.removeEventListener("keydown", closeFromEscape);
      // Settings temporarily suspends this viewer. Keep its original entry so
      // returning with browser Back does not create another same-URL entry.
      if (!activeRef.current) return;
      const current = mobileTerminalHistoryRef.current;
      if (current?.token !== token) return;
      mobileTerminalHistoryRef.current = undefined;
      // A non-Back dismissal should not leave a stale terminal marker as the
      // current entry. (Back-driven dismissal has already popped the entry.)
      if (historyMarker(window.history.state) === token) {
        replaceHistoryEntry(previousState, window.location.href);
      }
    };
  }, [
    active,
    desktop,
    selectedMobilePanel?.kind,
    selectedMobilePanel?.panelInstanceId,
    threadId,
  ]);

  const openPanelFromControl = (panel: PanelInstance) => {
    const presentation = "split";
    if (collapsed.has(panel.panelInstanceId)) {
      store.restorePanel(panel.panelInstanceId, { presentation });
    } else {
      store.activatePanel(panel.panelInstanceId, { presentation });
    }
    setMobilePanelId(panel.panelInstanceId);
  };

  const openTasksPanel = (focus: boolean) => {
    // Tasks always docks beside the current surfaces, even under the
    // single-panel presentation preference.
    store.openPanel("tasks", {
      availableWidth: availableSize.width,
      availableHeight: availableSize.height,
      presentation: "split",
      focus,
    });
  };
  const tasksVisible =
    tasksPanel !== undefined && actuallyVisible(tasksPanel.panelInstanceId);
  const toggleTasksPanel = (invoker?: HTMLElement) => {
    if (tasksPanel && tasksVisible) closePanel(tasksPanel, invoker);
    else openTasksPanel(true);
  };
  const workpadsVisible =
    workpadsPanel !== undefined &&
    actuallyVisible(workpadsPanel.panelInstanceId);
  const toggleWorkpadsPanel = (invoker?: HTMLElement) => {
    if (workpadsPanel && workpadsVisible) {
      closePanel(workpadsPanel, invoker);
      return;
    }
    // Like Tasks, Workpads docks beside the current surfaces.
    if (
      store.openPanel("workpads", {
        availableWidth: availableSize.width,
        availableHeight: availableSize.height,
        presentation: "split",
      })
    )
      setMobilePanelId("workpads");
  };
  usePublishTasksDock(
    tenants.has("tasks")
      ? {
          present: tasksPanel !== undefined,
          visible: active && tasksVisible,
          controls: {
            active,
            onCollapse: () => tasksPanel && collapsePanel(tasksPanel),
            onClose: (invoker) => tasksPanel && closePanel(tasksPanel, invoker),
            onDock: (edge) => store.dockPanel("tasks", edge),
            dockEdge: panelDockEdge(tree, "tasks"),
          },
          ...(tint ? { environmentTintStyle: tint } : {}),
          open: ({ focus }) => openTasksPanel(focus),
          toggle: toggleTasksPanel,
          close: () => tasksPanel && closePanel(tasksPanel),
        }
      : undefined,
  );

  const chatControls: PanelChromeControls = {
    active,
    onCollapse: () => chatPanel && collapsePanel(chatPanel),
    onClose: (invoker) => chatPanel && closePanel(chatPanel, invoker),
    onDock: (edge) =>
      chatPanel && store.dockPanel(chatPanel.panelInstanceId, edge),
    dockEdge: chatPanel && panelDockEdge(tree, chatPanel.panelInstanceId),
  };

  const renderPanel = (
    panel: PanelInstance,
    visible: boolean,
  ): React.ReactNode => {
    if (panel.kind === "chat") {
      return (
        <StablePaneSlot
          className="workspace-panel-content"
          target={chatTarget}
        />
      );
    }
    if (
      panel.kind === "files" ||
      panel.kind === "workpads" ||
      panel.kind === "tasks"
    ) {
      const tenant = tenants.tenant(tenantIdForKind(panel.kind));
      if (!tenant) return null;
      const { target, actionsTarget } = tenantTargets(panel.kind);
      const available = tenant.availability({ snapshot, workspace: snapshot?.workspace });
      const intent = store.intent(panel.panelInstanceId);
      const status = statuses.get(panel.panelInstanceId);
      return (
        <>
          {tenant.header === "tenant" ? null : <PanelChrome
            tenant={tenant}
            status={status}
            environmentTintStyle={tint}
            panelActions={
              <StablePaneSlot
                className="workspace-panel-chrome-actions-slot"
                target={actionsTarget}
              />
            }
            controls={{
              active,
              onCollapse: () => collapsePanel(panel),
              onClose: (invoker) => closePanel(panel, invoker),
              onDock: (edge) => store.dockPanel(panel.panelInstanceId, edge),
              dockEdge: panelDockEdge(tree, panel.panelInstanceId),
              renderMenuItems: renderTenantMenu(tenant, {
                threadId,
                workspaceId,
                applicationStore,
                threadRegistry,
                visible: active && visible,
                intent,
                chromeActionsTarget: actionsTarget,
              }),
            }}
          />}
          <StablePaneSlot
            className="workspace-panel-content"
            id={panelContentId(tenant.id)}
            target={target}
          />
          {available && !available.available ? (
            <div className="workspace-panel-availability" role="status">
              {available.reason ?? `${tenant.title} is temporarily unavailable.`}
            </div>
          ) : null}
        </>
      );
    }
    const activeTab = panel.tabs.find(
      ({ terminalId }) => terminalId === panel.activeTerminalId,
    );
    const cachedTerminal = activeTab ? terminalResources.get(activeTab.terminalId) : undefined;
    const terminal =
      cachedTerminal?.threadId === threadId ? cachedTerminal : undefined;
    const lookupFailure = activeTab ? terminalLookupFailures.get(activeTab.terminalId) : undefined;
    const retryLookup = () => {
      if (!activeTab) return;
      setTerminalLookupFailures((current) =>
        withoutMapKey(current, activeTab.terminalId),
      );
      setTerminalLookupRevision((current) => current + 1);
    };
    const readOnly =
      terminalSessionState?.connection === "ready" &&
      terminalSessionState.caughtUp &&
      terminalSessionState.role === "observer" &&
      !terminalSessionState.controlRequestPending &&
      terminal?.lifecycle === "running";
    const discardInputBlocker = !terminalSessionState
      ? undefined
      : terminalSessionState.connection !== "ready"
        ? terminalConnectionLabel(terminalSessionState)
        : !terminalSessionState.caughtUp
          ? "Catching up"
          : terminalSessionState.role !== "controller"
            ? "Read only"
            : undefined;
    return (
      <>
        <PanelChrome
          panelTitle="Terminals"
          leading={
            <div className="terminal-panel-heading">
              <TerminalTabs
                tabs={panel.tabs.map(({ terminalId }) => {
                  const cachedResource = terminalResources.get(terminalId);
                  const resource =
                    cachedResource?.threadId === threadId
                      ? cachedResource
                      : undefined;
                  return {
                    terminalId,
                    label: resource?.displayName ?? "Terminal",
                    closeDisabled: terminalLifecyclePendingId !== undefined,
                    closeLabel: resource && !isTerminalProcessLive(resource.lifecycle)
                      ? `Remove ${resource.displayName} terminal and history`
                      : confirmTerminalTermination
                        ? `Close ${resource?.displayName ?? "Terminal"} terminal`
                        : `${resource?.terminationEffect === "disconnect_transport" ? "Disconnect" : "End"} ${resource?.displayName ?? "Terminal"} terminal and remove history`,
                    ...(resource ? { lifecycle: resource.lifecycle } : {}),
                    ...(terminalId === panel.activeTerminalId &&
                    terminalSessionState
                      ? {
                          connection: terminalSessionState.connection,
                          ...(readOnly ? { readOnly: true } : {}),
                        }
                      : {}),
                  };
                })}
                activeTerminalId={panel.activeTerminalId}
                onActivate={(terminalId) => {
                  setTerminalSessionState(undefined);
                  store.activateTerminalTab(terminalId);
                }}
                onClose={requestTerminalClose}
                onRename={renameTerminal}
              />
              <ThreadTerminalMenu
                active={active}
                ref={terminalTabMenuRef}
                threadId={threadId}
                triggerVariant="tab"
                displayedTerminalIds={
                  new Set(
                    panel.threadId === threadId
                      ? panel.tabs.map(({ terminalId }) => terminalId)
                      : [],
                  )
                }
                {...terminalControls}
              />
            </div>
          }
          panelActions={
            <div className="terminal-panel-chrome-actions">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Search terminal"
                title="Search terminal"
                disabled={!terminal}
                onClick={() => terminalPanelRef.current?.openSearch()}
              >
                <Search size={15} aria-hidden="true" />
              </Button>
            </div>
          }
          controls={{
            active,
            onCollapse: () => collapsePanel(panel),
            onClose: (invoker) => closePanel(panel, invoker),
            onDock: (edge) => store.dockPanel(panel.panelInstanceId, edge),
            dockEdge: panelDockEdge(tree, panel.panelInstanceId),
            renderMenuItems: (
              <>
                {readOnly ? (
                  <>
                    <DropdownMenuItem
                      onSelect={() => terminalPanelRef.current?.claimControl()}
                    >
                      Take control
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem
                  disabled={!terminal}
                  onSelect={() => terminalPanelRef.current?.openTranscript()}
                >
                  Transcript
                  {!terminal ? <DropdownMenuValue>No terminal</DropdownMenuValue> : null}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!terminal}
                  onSelect={() => terminalPanelRef.current?.clearSelection()}
                >
                  Clear selection
                  {!terminal ? <DropdownMenuValue>No terminal</DropdownMenuValue> : null}
                </DropdownMenuItem>
                {terminalSessionState?.retryInputAvailable ? (
                  <DropdownMenuItem
                    onSelect={() =>
                      terminalPanelRef.current?.retryNotSentInput()
                    }
                  >
                    Retry unsent input
                  </DropdownMenuItem>
                ) : null}
                {terminalSessionState?.uncertainInputSeq !== undefined ? (
                  <DropdownMenuItem
                    disabled={discardInputBlocker !== undefined}
                    onSelect={() =>
                      terminalPanelRef.current?.discardUnconfirmedInput()
                    }
                  >
                    Discard unconfirmed input
                    {discardInputBlocker !== undefined ? (
                      <DropdownMenuValue>{discardInputBlocker}</DropdownMenuValue>
                    ) : null}
                  </DropdownMenuItem>
                ) : null}
                {terminalSessionState?.connection === "reconnecting" ? (
                  <DropdownMenuItem
                    onSelect={() => terminalPanelRef.current?.retryConnection()}
                  >
                    Reconnect now
                  </DropdownMenuItem>
                ) : null}
              </>
            ),
          }}
        />
        <div
          className="workspace-panel-content"
          role={activeTab ? "tabpanel" : "region"}
          id={activeTab ? terminalTabPanelId(activeTab.terminalId) : undefined}
          aria-labelledby={activeTab ? terminalTabId(activeTab.terminalId) : undefined}
          aria-label={activeTab ? undefined : "Terminals"}
        >
          {terminalLifecycleError &&
            terminalLifecycleError.terminalId !== activeTab?.terminalId && (
              <p role="alert">{terminalLifecycleError.message}</p>
            )}
          {!activeTab ? (
            <div className="workspace-panel-availability">
              <p>No terminals open</p>
              <Button
                variant="outline"
                size="sm"
                data-workspace-primary-focus="preferred"
                onClick={(event) => terminalTabMenuRef.current?.create(event.currentTarget)}
              >
                New terminal
              </Button>
            </div>
          ) : terminal ? (
            <TerminalPanel
              key={`${terminal.terminalId}:${terminal.incarnationId}`}
              ref={terminalPanelRef}
              terminal={terminal}
              producerId={activeTab.producerId}
              api={applicationStore.api}
              visible={visible}
              active={active}
              lifecycleError={
                terminalLifecycleError?.terminalId === terminal.terminalId
                  ? terminalLifecycleError.message
                  : undefined
              }
              onStateChange={setTerminalSessionState}
              onResourceChange={(resource) =>
                setTerminalResource(setTerminalResources, resource)
              }
              onRemoved={(terminalId) =>
                removeTerminalFromClient(
                  terminalId,
                  terminal.displayName,
                  isTerminalProcessLive(terminal.lifecycle)
                    ? terminal.terminationEffect === "disconnect_transport" ? "disconnected" : "ended"
                    : "removed",
                )
              }
            />
          ) : (
            <div className="workspace-panel-availability" role="status">
              {terminalLifecycleError?.terminalId === activeTab.terminalId && (
                <p role="alert">{terminalLifecycleError.message}</p>
              )}
              {lookupFailure ? (
                <>
                  <p>
                    {lookupFailure.kind === "gone"
                      ? "This terminal is no longer available."
                      : `Couldn’t load this terminal. ${lookupFailure.message}`}
                  </p>
                  <Button variant="outline" size="sm" onClick={retryLookup}>
                    {lookupFailure.kind === "gone"
                      ? "Re-attempt lookup"
                      : "Retry"}
                  </Button>
                </>
              ) : (
                "Loading terminal…"
              )}
            </div>
          )}
        </div>
      </>
    );
  };

  const renderStack = (stack: TabStackNode): React.ReactNode => {
    const active =
      stack.tabs.find(
        ({ panelInstanceId }) =>
          panelInstanceId === stack.activePanelInstanceId,
      ) ?? stack.tabs[0];
    if (!active) return null;
    const tabPanelId = panelTabPanelId(stack.id);
    const activeTabId = panelTabId(active.panelInstanceId);
    const activateTabFromKeyboard = (
      event: React.KeyboardEvent<HTMLButtonElement>,
      currentIndex: number,
    ) => {
      let nextIndex: number | undefined;
      switch (event.key) {
        case "ArrowLeft":
          nextIndex =
            (currentIndex - 1 + stack.tabs.length) % stack.tabs.length;
          break;
        case "ArrowRight":
          nextIndex = (currentIndex + 1) % stack.tabs.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = stack.tabs.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const next = stack.tabs[nextIndex];
      if (!next) return;
      store.activatePanel(next.panelInstanceId, { focus: false });
      setMobilePanelId(next.panelInstanceId);
      document.getElementById(panelTabId(next.panelInstanceId))?.focus();
    };
    return (
      <section
        className={`workspace-panel-leaf workspace-panel-${active.kind}`}
        data-panel-id={active.panelInstanceId}
        data-panel-instance-id={active.panelInstanceId}
        aria-label={`${panelTitle(active, terminalResources)} panel`}
      >
        {stack.tabs.length > 1 ? (
          <div
            className="workspace-panel-tablist"
            role="tablist"
            aria-label="Panel tabs"
          >
            {stack.tabs.map((tab, index) => {
              const selected = tab.panelInstanceId === active.panelInstanceId;
              return (
                <div
                  className="workspace-panel-tab"
                  key={tab.panelInstanceId}
                  data-active={selected || undefined}
                >
                  <button
                    type="button"
                    role="tab"
                    id={panelTabId(tab.panelInstanceId)}
                    aria-controls={tabPanelId}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    onKeyDown={(event) => activateTabFromKeyboard(event, index)}
                    onClick={() => {
                      store.activatePanel(tab.panelInstanceId);
                      setMobilePanelId(tab.panelInstanceId);
                    }}
                  >
                    {panelGlyph(tab, snapshot?.capabilities.backend.brand, 14)}
                    <span>{panelTitle(tab, terminalResources)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${panelTitle(tab, terminalResources)} panel`}
                    onClick={(event) => closePanel(tab, event.currentTarget)}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <div
          role="tabpanel"
          id={tabPanelId}
          aria-labelledby={stack.tabs.length > 1 ? activeTabId : undefined}
          aria-label={
            stack.tabs.length === 1
              ? `${panelTitle(active, terminalResources)} panel content`
              : undefined
          }
          className="workspace-panel-surface"
        >
          {renderPanel(active, actuallyVisible(active.panelInstanceId))}
        </div>
      </section>
    );
  };

  /**
   * Renders a node into `width` x `height` pixels. A split gives each pane its
   * fraction of the space, never less than the pane's minimum (layout-fit.ts);
   * its nested splits are laid out in the space their pane resolves to.
   */
  const renderDesktopNode = (
    node: LayoutNode,
    width: number,
    height: number,
  ): React.ReactNode => {
    if (node.kind === "tabs") return renderStack(node);
    const split = node as SplitNode;
    const row = split.orientation === "row";
    const sizes = previewSizes.get(split.id) ?? split.sizes;
    const { free, minimums, sizes: resolved } = resolveSplit(
      split,
      sizes,
      row ? width : height,
      panelMinimum,
    );
    // Flex factors of at least 1 each, so a pane held at its minimum leaves
    // the other pane all the remaining space.
    // The divider position the layout holds, without a drag preview.
    const committed = resolveSplit(
      split,
      split.sizes,
      row ? width : height,
      panelMinimum,
    ).sizes[0];
    const flex = Math.min(sizes[0], sizes[1]);
    const tracks = `minmax(${minimums[0]}px, ${sizes[0] / flex}fr) ${SPLIT_HANDLE_SIZE}px minmax(${minimums[1]}px, ${sizes[1] / flex}fr)`;
    const fractionOf = (value: number) => (free > 0 ? value / free : sizes[0]);
    return (
      <div
        className="workspace-panel-grid"
        data-testid="workspace-panel-split"
        data-orientation={split.orientation}
        style={{
          gridTemplateColumns: row ? tracks : undefined,
          gridTemplateRows: row ? undefined : tracks,
        }}
      >
        {renderDesktopNode(
          split.children[0],
          row ? resolved[0] : width,
          row ? height : resolved[0],
        )}
        <PaneResizeHandle
          orientation={split.orientation}
          value={resolved[0]}
          min={minimums[0]}
          max={Math.max(minimums[0], free - minimums[1])}
          resetValue={free / 2}
          ariaLabel="Resize Chat and Files panels"
          className="workspace-panel-resize-handle"
          testId="workspace-panel-resize-handle"
          onPreview={(value) => {
            const fraction = fractionOf(value);
            // Other side panels keep their shared sizes as the divider moves.
            setPreviewSizes(
              Math.abs(value - committed) < 0.5
                ? new Map()
                : store.previewSplitResize(split.id, [fraction, 1 - fraction]),
            );
          }}
          onCommit={(value) => {
            const fraction = fractionOf(value);
            setPreviewSizes(new Map());
            // A divider released where it was, which can differ from its
            // fraction while minimums hold, must not resize every thread.
            if (Math.abs(value - committed) < 0.5) return;
            store.resizeSplit(split.id, [fraction, 1 - fraction]);
          }}
        />
        {renderDesktopNode(
          split.children[1],
          row ? resolved[1] : width,
          row ? height : resolved[1],
        )}
      </div>
    );
  };

  const openTerminal = (terminal: TerminalResource) => {
    if (terminal.threadId !== threadId) {
      setAnnouncement("That terminal belongs to a different thread.");
      return;
    }
    setTerminalResource(setTerminalResources, terminal);
    setTerminalSessionState(undefined);
    const panelInstanceId = store.openTerminalTab(terminal.terminalId, {
      availableWidth: availableSize.width,
      availableHeight: availableSize.height,
      focus: true,
    });
    if (panelInstanceId) setMobilePanelId(panelInstanceId);
    else
      setAnnouncement(
        "The terminal was created, but its panel could not be opened in this layout.",
      );
  };

  const terminalControls: ThreadTerminalControls = {
    api: applicationStore.api,
    onOpen: openTerminal,
    onRename: renameTerminal,
    onReveal: () => {
      const panel = store.terminalPanel();
      if (!panel) return false;
      store.activatePanel(panel.panelInstanceId, { presentation: "split" });
      setMobilePanelId(panel.panelInstanceId);
      return true;
    },
    onResourceChange: (terminal) => {
      setTerminalResource(setTerminalResources, terminal);
      setTerminalLookupFailures((current) =>
        withoutMapKey(current, terminal.terminalId),
      );
    },
    onDelete: (terminalId) => {
      const existing = terminalResources.get(terminalId);
      removeTerminalFromClient(
        terminalId,
        existing?.displayName,
        existing && isTerminalProcessLive(existing.lifecycle)
          ? existing.terminationEffect === "disconnect_transport" ? "disconnected" : "ended"
          : "removed",
      );
    },
  };

  return (
    <div
      className="workspace-panel-layout"
      data-testid="workspace-panel-layout"
    >
      <div
        className="workspace-workbench-bar"
        data-testid="workspace-workbench-bar"
      >
        <SidebarNavTrigger />
        <div className="workspace-workbench-actions">
          <div className="workspace-workbench-toggles">
            <TasksPanelToggle
              open={desktop ? tasksVisible : (tasksHost?.sheetOpen ?? false)}
              collapsed={desktop && tasksPanel !== undefined && !tasksVisible}
              onToggle={(invoker) =>
                desktop ? toggleTasksPanel(invoker) : tasksHost?.toggleSheet()
              }
              count={openThreadTaskCount}
            />
            {tenants.has("workpads") && (
              <WorkbenchPanelToggle
                title="Workpads"
                icon={NotepadText}
                open={workpadsVisible}
                collapsed={desktop && workpadsPanel !== undefined && !workpadsVisible}
                onToggle={toggleWorkpadsPanel}
                className="workpads-panel-toggle"
                testId="workpads-panel-toggle"
                badge={workpadCount === undefined ? undefined : {
                  count: workpadCount,
                  label: `${workpadCount} ${workpadCount === 1 ? "workpad" : "workpads"} in this thread`,
                }}
              />
            )}
          </div>
          <div className="workspace-panel-open-menu">
            <div
              className="workspace-panel-open-icons"
              role="group"
              aria-label="Panel shortcuts"
            >
              {/* The Tasks and Workpads toggles beside this group stand for them. */}
              {panels.filter((panel) => panel.kind !== "tasks" && panel.kind !== "workpads").map((panel) => (
                <Button
                  key={panel.panelInstanceId}
                  variant="ghost"
                  size="icon-sm"
                  className="workspace-panel-open-icon"
                  aria-label={`Open ${panelTitle(panel, terminalResources)} panel`}
                  data-collapsed={
                    collapsed.has(panel.panelInstanceId) || undefined
                  }
                  data-visible={
                    actuallyVisible(panel.panelInstanceId) || undefined
                  }
                  onClick={() => openPanelFromControl(panel)}
                >
                  {panelGlyph(panel, snapshot?.capabilities.backend.brand, 16)}
                </Button>
              ))}
            </div>
            <DropdownMenu open={active && panelsMenuOpen} onOpenChange={setPanelsMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={openPanelsTriggerRef}
                  variant="ghost"
                  size="icon-sm"
                  className="workspace-panel-open-trigger"
                  aria-label="Panels"
                >
                  <ChevronDown size={13} aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="min-w-[min(300px,calc(100vw-16px))]"
                align="end"
                onCloseAutoFocus={(event) => {
                  const panelInstanceId = menuFocusTarget.current;
                  if (!panelInstanceId) return;
                  menuFocusTarget.current = undefined;
                  event.preventDefault();
                }}
              >
                <DropdownMenuLabel>Panels</DropdownMenuLabel>
                {([
                  { id: "chat", title: "Chat", panel: chatPanel, icon: <MessageSquare size={16} />, available: true },
                  { id: "workspace-files", title: "Files", panel: filesPanel, icon: <Files size={16} />, available: tenants.has("workspace-files") },
                  { id: "terminals", title: "Terminals", panel: terminalsPanel, icon: <TerminalIcon size={16} />, available: true },
                ]).filter(({ available, panel }) => available || panel).map(({ id, title, panel, icon }) => {
                  const status = panel ? statuses.get(panel.panelInstanceId) : undefined;
                  return (
                    // Selecting a row opens or reveals its panel, so it stays a
                    // plain item; an open panel takes the checked row's look.
                    <DropdownMenuItem
                      key={id}
                      className={cn(menuCheckRowClass, "data-[collapsed=true]:text-muted-foreground")}
                      data-panel-open={Boolean(panel)}
                      data-state={panel ? "checked" : "unchecked"}
                      aria-description={panel ? "Open" : "Closed"}
                      data-collapsed={panel ? collapsed.has(panel.panelInstanceId) : false}
                      onSelect={() => {
                        if (panel) {
                          menuFocusTarget.current = id;
                          if (collapsed.has(panel.panelInstanceId))
                            store.restorePanel(panel.panelInstanceId, { presentation: "split" });
                          else
                            store.activatePanel(panel.panelInstanceId, { presentation: "split" });
                          setMobilePanelId(panel.panelInstanceId);
                        } else if (id === "terminals") {
                          terminalEntryRef.current?.open(undefined, openPanelsTriggerRef.current);
                        } else if (store.openPanel(id, {
                          availableWidth: availableSize.width,
                          availableHeight: availableSize.height,
                          presentation: "split",
                        })) {
                          menuFocusTarget.current = id;
                          setMobilePanelId(id);
                        }
                      }}
                    >
                      {panel ? panelGlyph(panel, snapshot?.capabilities.backend.brand, 16) : icon}
                      <span className="min-w-0 flex-1 truncate">
                        {panel ? panelMenuLabel(panel, terminalResources, snapshot?.thread.title.text, snapshot?.workspace.label.text) : title}
                      </span>
                      {status?.dirty ? <span className="workspace-panel-dirty" aria-label="Unsaved changes" /> : null}
                      {status?.busy ? <span className="comet-spinner workspace-panel-spinner" aria-label="Busy" /> : null}
                      {panel && collapsed.has(panel.panelInstanceId) ? <span className="sr-only">Collapsed</span> : null}
                      {panel ? (
                        <span className={menuCheckIndicatorClass}>
                          <CheckIcon aria-hidden="true" className="size-4 text-foreground" />
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                  );
                })}
                {desktop && collapsed.size > 1 ? (
                  <Fragment>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => {
                        store.restoreAllPanels();
                        const first =
                          panels.find((panel) => panel.kind === "chat") ??
                          panels[0];
                        if (first) {
                          menuFocusTarget.current = first.panelInstanceId;
                          store.activatePanel(first.panelInstanceId, {
                            presentation: "split",
                          });
                        }
                        setAnnouncement("All panels restored.");
                      }}
                    >
                      <LayoutPanelTop aria-hidden="true" />
                      Show all
                    </DropdownMenuItem>
                  </Fragment>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    const run = () => {
                      store.resetLayout();
                      setStatuses(new Map());
                      setMobilePanelId("chat");
                      setAnnouncement("Panel layout reset.");
                    };
                    const dirtyPanels = panels.filter(
                      (panel) => statuses.get(panel.panelInstanceId)?.dirty,
                    );
                    if (dirtyPanels.length > 0) {
                      setDirtyConfirmation({
                        description: `Resetting the layout will discard unsaved changes in ${dirtyPanels.map((panel) => panelTitle(panel, terminalResources)).join(", ")}.`,
                        actionLabel: "Discard and reset",
                        run,
                      });
                    } else run();
                  }}
                >
                  <RotateCcw aria-hidden="true" />
                  Reset layout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <ThreadTerminalMenu active={active} ref={terminalEntryRef} threadId={threadId} triggerVariant="panel" {...terminalControls} />

      <div className="workspace-panel-stage" ref={stageRef}>
        {desktop ? (
          soloPanel ? (
            renderStack({
              kind: "tabs",
              id: `solo-${soloPanel.panelInstanceId}`,
              tabs: [soloPanel],
              activePanelInstanceId: soloPanel.panelInstanceId,
            })
          ) : visibleTree ? (
            renderDesktopNode(visibleTree, availableSize.width, availableSize.height)
          ) : (
            <EmptyWorkbench collapsed={collapsed.size > 0} />
          )
        ) : selectedMobilePanel ? (
          <section
            className={`workspace-panel-leaf workspace-panel-mobile-base workspace-panel-${selectedMobilePanel.kind}`}
            data-panel-id={selectedMobilePanel.panelInstanceId}
            data-panel-instance-id={selectedMobilePanel.panelInstanceId}
            aria-label={`${panelTitle(selectedMobilePanel, terminalResources)} panel`}
            role={
              selectedMobilePanel.kind === "terminals" ? "dialog" : undefined
            }
            aria-modal={
              selectedMobilePanel.kind === "terminals" ? false : undefined
            }
            aria-describedby={
              selectedMobilePanel.kind === "terminals"
                ? mobileTerminalDescriptionId(
                    selectedMobilePanel.panelInstanceId,
                  )
                : undefined
            }
            data-state={
              active && selectedMobilePanel.kind === "terminals" ? "open" : undefined
            }
            data-mobile-terminal-panel={
              selectedMobilePanel.kind === "terminals" ? "true" : undefined
            }
          >
            {selectedMobilePanel.kind === "terminals" ? (
              <p
                id={mobileTerminalDescriptionId(
                  selectedMobilePanel.panelInstanceId,
                )}
                className="sr-only"
              >
                Closing this panel detaches this client. It does not terminate
                the terminal process.
              </p>
            ) : null}
            {renderPanel(selectedMobilePanel, true)}
          </section>
        ) : (
          <EmptyWorkbench collapsed={collapsed.size > 0} />
        )}
      </div>

      <div className="workspace-panel-parking" aria-hidden="true" inert>
        {chatPanel && !actuallyVisible(chatPanel.panelInstanceId) ? (
          <StablePaneSlot target={chatTarget} />
        ) : null}
        {filesPanel && !actuallyVisible(filesPanel.panelInstanceId) ? (
          <StablePaneSlot target={filesTarget} />
        ) : null}
        {workpadsPanel && !actuallyVisible(workpadsPanel.panelInstanceId) ? (
          <StablePaneSlot target={workpadsTarget} />
        ) : null}
        {tasksPanel && !actuallyVisible(tasksPanel.panelInstanceId) ? (
          <StablePaneSlot target={tasksTarget} />
        ) : null}
      </div>

      {chatPanel
        ? createPortal(
            renderChat(
              chatControls,
              active && actuallyVisible(chatPanel.panelInstanceId),
            ),
            chatTarget,
            `chat:${threadId}`,
          )
        : null}
      {panels.map(panel => {
        if (panel.kind !== "files" && panel.kind !== "workpads" && panel.kind !== "tasks") return null;
        const tenant = tenants.tenant(tenantIdForKind(panel.kind));
        if (!tenant) return null;
        const { target, actionsTarget } = tenantTargets(panel.kind);
        return createPortal(
          <TenantContent
            tenant={tenant}
            threadId={threadId}
            workspaceId={workspaceId}
            workspaceLabel={snapshot?.workspace.label.text}
            applicationStore={applicationStore}
            threadRegistry={threadRegistry}
            intent={store.intent(panel.panelInstanceId)}
            visible={active && actuallyVisible(panel.panelInstanceId)}
            presentation={desktop ? "dock" : "sheet"}
            chromeActionsTarget={actionsTarget}
            onStatus={(status) => updateStatus(panel.panelInstanceId, status)}
            onConsumeIntent={(sequence) => store.consumeIntent(panel.panelInstanceId, sequence)}
            onClose={() => closePanel(panel)}
          />,
          target,
          panel.kind === "files" ? `workspace-files:${workspaceId ?? "none"}` : panel.kind,
        );
      })}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <DiscardChangesDialog
        open={active && Boolean(dirtyConfirmation)}
        onOpenChange={(open) => !open && setDirtyConfirmation(undefined)}
        description={dirtyConfirmation?.description}
        discardLabel={dirtyConfirmation?.actionLabel}
        onDiscard={() => {
          const confirmation = dirtyConfirmation;
          setDirtyConfirmation(undefined);
          confirmation?.run();
        }}
      />

      <Dialog
        open={active && Boolean(terminalLifecycleConfirmation)}
        onOpenChange={(open) =>
          !open && setTerminalLifecycleConfirmation(undefined)
        }
      >
        <DialogContent showClose={false}>
          <DialogHeader>
            <DialogTitle>Close terminal?</DialogTitle>
            <DialogDescription>
              {terminalLifecycleConfirmation?.terminal &&
              terminalLifecycleConfirmation.terminal.lifecycle !== "stopping"
                ? terminalLifecycleConfirmation.terminal.terminationEffect === "disconnect_transport"
                  ? `Close ${terminalLifecycleConfirmation.label} tab and leave the terminal connected, or disconnect the SSH session and remove its history. Remote processes may continue running.`
                  : `Close ${terminalLifecycleConfirmation.label} tab and leave the terminal running, or end the terminal and delete its history.`
                : `Close ${terminalLifecycleConfirmation?.label ?? "Terminal"} tab without ending the terminal.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter
            start={
              terminalLifecycleConfirmation?.terminal &&
              terminalLifecycleConfirmation.terminal.lifecycle !== "stopping" ? (
                <Button
                  variant="destructive"
                  onClick={() => {
                    const confirmation = terminalLifecycleConfirmation;
                    setTerminalLifecycleConfirmation(undefined);
                    void endOrRemoveTerminal(
                      confirmation.terminalId,
                      confirmation.terminal,
                    );
                  }}
                >
                  {terminalTerminationLabel(terminalLifecycleConfirmation.terminal)}
                </Button>
              ) : undefined
            }
          >
            <Button
              variant="outline"
              onClick={() => setTerminalLifecycleConfirmation(undefined)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const confirmation = terminalLifecycleConfirmation;
                setTerminalLifecycleConfirmation(undefined);
                if (confirmation)
                  closeTerminalView(confirmation.terminalId, confirmation.label);
              }}
            >
              Close tab
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyWorkbench({
  collapsed,
}: {
  readonly collapsed: boolean;
}): React.JSX.Element {
  return (
    <section
      className="workspace-panel-empty"
      data-testid="workspace-panel-empty"
    >
      <PanelTop className="workspace-panel-empty-icon" aria-hidden size={28} />
      <h2>{collapsed ? "All panels are collapsed" : "No panels are open"}</h2>
      <p>
        {collapsed
          ? "Use the panels menu to restore a panel."
          : "Open Chat, Files, Workpads, or a terminal."}
      </p>
    </section>
  );
}

function TenantContent({
  tenant,
  threadId,
  workspaceId,
  workspaceLabel,
  applicationStore,
  threadRegistry,
  intent,
  visible,
  presentation,
  chromeActionsTarget,
  onStatus,
  onConsumeIntent,
  onClose,
}: {
  readonly tenant: WorkspacePanelTenant;
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly applicationStore: ApplicationClientStore;
  readonly threadRegistry: ThreadStoreRegistry;
  readonly intent?: unknown;
  readonly visible: boolean;
  readonly presentation: "dock" | "sheet";
  readonly chromeActionsTarget: HTMLElement;
  readonly onStatus: (status: PanelChromeStatus) => void;
  readonly onConsumeIntent: (sequence: number) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const contextExcerpts = useComposerDraftStaging();
  const [status, setStatus] = useState<PanelChromeStatus>({});
  const closeRef = useRef(onClose);
  const statusRef = useRef(onStatus);
  const consumeIntentRef = useRef(onConsumeIntent);
  closeRef.current = onClose;
  statusRef.current = onStatus;
  consumeIntentRef.current = onConsumeIntent;
  const host = useMemo<WorkspacePanelHost>(
    () => ({
      close: () => closeRef.current(),
      consumeIntent: (sequence) => consumeIntentRef.current(sequence),
      setBusy: (busy) => setStatus((current) => ({ ...current, busy })),
      setDirty: (dirty) => setStatus((current) => ({ ...current, dirty })),
      setSubtitle: (subtitle) =>
        setStatus((current) => ({ ...current, subtitle })),
    }),
    [],
  );
  useEffect(() => statusRef.current(status), [status]);
  useEffect(() => () => statusRef.current({}), []);
  const context: WorkspacePanelContext = {
    applicationStore,
    threadRegistry,
    host,
    visible,
    presentation,
    chromeActionsTarget,
    ...(contextExcerpts ? { contextExcerpts } : {}),
    // Workpads follows route context for its list while retaining its shared
    // panel placement and lifetime across thread navigation.
    ...(tenant.scope !== "global" || tenant.id === "workpads" ? { threadId } : {}),
    ...((tenant.scope !== "global" || tenant.id === "workpads") && workspaceId ? { workspaceId } : {}),
    ...((tenant.scope !== "global" || tenant.id === "workpads") && workspaceLabel ? { workspaceLabel } : {}),
    ...(intent !== undefined ? { intent } : {}),
  };
  return (
    <div
      className="workspace-panel-tenant"
      data-tenant-id={tenant.id}
      data-visible={visible ? "true" : "false"}
      tabIndex={-1}
    >
      {tenant.render(context)}
    </div>
  );
}

function renderTenantMenu(
  tenant: WorkspacePanelTenant,
  input: {
    readonly threadId: string;
    readonly workspaceId?: string;
    readonly applicationStore: ApplicationClientStore;
    readonly threadRegistry: ThreadStoreRegistry;
    readonly visible: boolean;
    readonly intent?: unknown;
    readonly chromeActionsTarget: HTMLElement;
  },
): React.ReactNode {
  if (!tenant.renderMenuItems) return undefined;
  const noopHost: WorkspacePanelHost = {
    close: () => undefined,
    consumeIntent: () => undefined,
    setBusy: () => undefined,
    setDirty: () => undefined,
    setSubtitle: () => undefined,
  };
  return tenant.renderMenuItems({
    applicationStore: input.applicationStore,
    threadRegistry: input.threadRegistry,
    host: noopHost,
    visible: input.visible,
    presentation: "dock",
    chromeActionsTarget: input.chromeActionsTarget,
    ...(tenant.scope === "thread" ? { threadId: input.threadId } : {}),
    ...(tenant.scope !== "global" && input.workspaceId
      ? { workspaceId: input.workspaceId }
      : {}),
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
  });
}

/** A tenant's static ⋯ items, then those its content publishes. */
function activePanelIds(tree: PanelLayoutTree): ReadonlySet<PanelInstanceId> {
  const ids = new Set<PanelInstanceId>();
  const visit = (node: LayoutNode): void => {
    if (node.kind === "tabs") {
      ids.add(node.activePanelInstanceId);
      return;
    }
    visit(node.children[0]);
    visit(node.children[1]);
  };
  if (tree) visit(tree);
  return ids;
}

function chooseMobilePanel(
  panels: readonly PanelInstance[],
  activeVisibleIds: ReadonlySet<PanelInstanceId>,
  selected?: PanelInstanceId,
  requested?: PanelInstanceId,
): PanelInstance | undefined {
  const preferred = requested ?? selected;
  const selectedPanel = preferred
    ? panels.find(
        ({ panelInstanceId }) =>
          panelInstanceId === preferred &&
          activeVisibleIds.has(panelInstanceId),
      )
    : undefined;
  return (
    selectedPanel ??
    panels.find(({ panelInstanceId }) => activeVisibleIds.has(panelInstanceId))
  );
}

function panelFocusTarget(
  panelInstanceId: PanelInstanceId,
  targets: {
    readonly chat: HTMLElement;
    readonly files: HTMLElement;
    readonly workpads: HTMLElement;
    readonly tasks: HTMLElement;
  },
): HTMLElement | undefined {
  if (panelInstanceId === "chat") return targets.chat;
  if (panelInstanceId === "workspace-files") return targets.files;
  if (panelInstanceId === "workpads") return targets.workpads;
  if (panelInstanceId === "tasks") return targets.tasks;
  return [
    ...document.querySelectorAll<HTMLElement>("[data-panel-instance-id]"),
  ].find((element) => element.dataset.panelInstanceId === panelInstanceId);
}

function focusInside(
  target: HTMLElement | undefined,
  preferInteractiveTarget = true,
): boolean {
  if (!preferInteractiveTarget) {
    target?.focus();
    return target !== undefined && document.activeElement === target;
  }
  const focusTarget =
    preferredFocusTarget(target) ??
    target?.querySelector<HTMLElement>(
      'button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
    ) ??
    target;
  if (
    (focusTarget instanceof HTMLButtonElement ||
      focusTarget instanceof HTMLInputElement ||
      focusTarget instanceof HTMLSelectElement ||
      focusTarget instanceof HTMLTextAreaElement) &&
    focusTarget.disabled
  )
    return false;
  focusTarget?.focus();
  return focusTarget !== undefined && document.activeElement === focusTarget;
}

function preferredFocusTarget(
  target: HTMLElement | undefined,
): HTMLElement | undefined {
  return (
    target?.querySelector<HTMLElement>("[data-panel-autofocus]") ??
    target?.querySelector<HTMLElement>(
      '[data-workspace-primary-focus="preferred"]',
    ) ??
    undefined
  );
}

function focusRequestMatchesThread(
  request: PanelFocusRequest,
  threadId: string,
): boolean {
  return (
    request.scope?.kind !== "thread" || request.scope.threadId === threadId
  );
}

function createPortalTarget(
  panelInstanceId: PanelInstanceId,
  title: string,
): HTMLElement {
  const target = document.createElement("div");
  target.className = "workspace-panel-portal-target";
  target.dataset.portalTarget = panelInstanceId;
  target.tabIndex = -1;
  target.setAttribute("role", "region");
  target.setAttribute("aria-label", `${title} panel content`);
  return target;
}

function createChromeActionsTarget(): HTMLElement {
  const target = document.createElement("div");
  target.className = "workspace-panel-chrome-actions-target";
  return target;
}

function panelTabId(panelInstanceId: PanelInstanceId): string {
  return `workspace-panel-tab-${domIdFragment(panelInstanceId)}`;
}

function panelTabPanelId(stackId: string): string {
  return `workspace-panel-tabpanel-${domIdFragment(stackId)}`;
}

function mobileTerminalDescriptionId(panelInstanceId: PanelInstanceId): string {
  return `mobile-terminal-description-${domIdFragment(panelInstanceId)}`;
}

function domIdFragment(value: string): string {
  return [...value]
    .map((character) => character.codePointAt(0)!.toString(16))
    .join("-");
}

function panelTitle(
  panel: PanelInstance,
  terminals: ReadonlyMap<string, TerminalResource>,
): string {
  if (panel.kind === "chat") return "Chat";
  if (panel.kind === "files") return "Files";
  if (panel.kind === "workpads") return "Workpads";
  if (panel.kind === "tasks") return "Tasks";
  return "Terminals";
}

function panelGlyph(
  panel: PanelInstance,
  brand: React.ComponentProps<typeof BackendBrandIcon>["brand"] | undefined,
  size: number,
): React.JSX.Element {
  if (panel.kind === "files") return <Files size={size} />;
  if (panel.kind === "workpads") return <NotepadText size={size} />;
  if (panel.kind === "tasks") return <ListChecks size={size} />;
  if (panel.kind === "terminals") return <TerminalIcon size={size} />;
  if (brand !== undefined)
    return <BackendBrandIcon brand={brand} size={size} />;
  return <MessageSquare size={size} />;
}

function panelMenuLabel(
  panel: PanelInstance,
  terminals: ReadonlyMap<string, TerminalResource>,
  threadTitle?: string,
  workspaceLabel?: string,
): string {
  if (panel.kind === "chat")
    return `Chat — ${threadTitle || "Untitled thread"}`;
  if (panel.kind === "files") return `Files — ${workspaceLabel || "Workspace"}`;
  if (panel.kind === "workpads") return "Workpads";
  if (panel.kind === "tasks") return "Tasks";
  if (panel.activeTerminalId === null) return "Terminals — 0 open";
  const terminal = terminals.get(panel.activeTerminalId);
  return `Terminals — ${panel.tabs.length} open · ${terminal?.displayName ?? "Loading"}`;
}

function setTerminalResource(
  setter: React.Dispatch<
    React.SetStateAction<ReadonlyMap<string, TerminalResource>>
  >,
  resource: TerminalResource,
): void {
  setter((current) => new Map(current).set(resource.terminalId, resource));
}

function terminalLookupFailure(error: unknown): TerminalLookupFailure {
  if (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 410)
  ) {
    return { kind: "gone", message: error.message };
  }
  return {
    kind: "transient",
    message: error instanceof Error ? error.message : "The request failed.",
  };
}

function withoutMapKey<K, V>(
  values: ReadonlyMap<K, V>,
  key: K,
): ReadonlyMap<K, V> {
  if (!values.has(key)) return values;
  const next = new Map(values);
  next.delete(key);
  return next;
}

function tenantIdForKind(kind: "files" | "workpads" | "tasks"): string {
  return kind === "files" ? "workspace-files" : kind;
}

function objectStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function objectSafeIntegerField(
  value: unknown,
  key: string,
): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isSafeInteger(field)
    ? field
    : undefined;
}

function historyMarker(value: unknown): string | undefined {
  return objectStringField(value, MOBILE_TERMINAL_HISTORY_KEY);
}

function withHistoryMarker(
  value: unknown,
  token: string,
): Record<string, unknown> {
  return {
    ...(typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}),
    [MOBILE_TERMINAL_HISTORY_KEY]: token,
  };
}
