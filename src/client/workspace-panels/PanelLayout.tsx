import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { parseRoute, pushHistoryEntry, replaceHistoryEntry } from "../app/router.js";
import {
  Check,
  ChevronDown,
  Files,
  MessageSquare,
  NotepadText,
  PanelTop,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type { TerminalResource } from "../../shared/index.js";
import { ApiError } from "../api/ApiClient.js";
import { Button } from "../components/ui/button.js";
import { BackendBrandIcon } from "../components/brand-icons.js";
import { TasksPanelToggle } from "../components/tasks/TasksPanelToggle.js";
import { SidebarNavTrigger } from "../components/SidebarNavTrigger.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
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
  terminalTabId,
  terminalTabPanelId,
  type TerminalPanelHandle,
  type TerminalSessionSnapshot,
  type ThreadTerminalControls,
  type ThreadTerminalMenuHandle,
} from "../terminals/index.js";
import {
  panelInstances,
  type LayoutNode,
  type PanelInstance,
  type PanelInstanceId,
  type PanelLayoutTree,
  type PanelPlacementEdge,
  type SplitNode,
  type TabStackNode,
} from "./layout-tree.js";
import { projectPanelLayout } from "./layout-presentation.js";
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
  getPanelPresentation,
  subscribePanelPresentation,
} from "../app/settings.js";
import {
  resolvePanelPresentation,
  type PanelPresentation,
} from "./panel-presentation.js";

const MOBILE_QUERY = "(max-width: 819px)";
const SPLIT_HANDLE_SIZE = 5;
const MIN_PANEL_SIZE = 160;
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
  const terminalSummary = applicationState.snapshot?.threads.find(
    ({ id }) => id === threadId,
  )?.terminalSummary;
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
  const [desktop, setDesktop] = useState(
    () => !window.matchMedia(MOBILE_QUERY).matches,
  );
  const terminalClosePendingRef = useRef<symbol | undefined>(undefined);
  const [confirmTerminalTermination, setConfirmTerminalTerminationState] =
    useState(getConfirmTerminalTermination);
  const [panelPresentation, setPanelPresentationState] =
    useState(getPanelPresentation);
  const [chatTarget] = useState(() => createPortalTarget("chat", "Chat"));
  const [filesTarget] = useState(() =>
    createPortalTarget("workspace-files", "Files"),
  );
  const [filesChromeActionsTarget] = useState(createChromeActionsTarget);
  const [workpadsTarget] = useState(() => createPortalTarget("workpads", "Workpads"));
  const [workpadsChromeActionsTarget] = useState(createChromeActionsTarget);
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
  useEffect(() => subscribePanelPresentation(setPanelPresentationState), []);

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
  const terminalsPanel = panels.find((panel) => panel.kind === "terminals");
  const filesIntent = filesPanel
    ? store.intent(filesPanel.panelInstanceId)
    : undefined;
  const filesIntentWorkspaceId = objectStringField(filesIntent, "workspaceId");
  const filesIntentSequence = objectSafeIntegerField(filesIntent, "sequence");
  const selectedMobilePanel = chooseMobilePanel(
    panels,
    layoutActiveVisibleIds,
    mobilePanelId,
    focusRequest?.panelInstanceId,
  );
  const actuallyVisible = (panelInstanceId: string): boolean =>
    desktop
      ? activeVisibleIds.has(panelInstanceId)
      : selectedMobilePanel?.panelInstanceId === panelInstanceId;

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
    // preferred composer mounts. Keep the desktop request pending instead;
    // the interaction listeners below still abandon it if the user chooses a
    // different target while the thread loads.
    if (
      desktop &&
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
      const target = panelFocusTarget(
        focusRequest.panelInstanceId,
        chatTarget,
        filesTarget,
        workpadsTarget,
      );
      if (!focusInside(target, desktop)) return;
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
    desktop,
    filesTarget,
    workpadsTarget,
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
    const requestedTarget = panelFocusTarget(
      focusRequest.panelInstanceId,
      chatTarget,
      filesTarget,
      workpadsTarget,
    );
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
  }, [active, chatTarget, filesTarget, workpadsTarget, focusRequest, store, threadId]);

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
      const next = panels.find(
        ({ panelInstanceId }) =>
          panelInstanceId !== hidden && !currentCollapsed.has(panelInstanceId),
      );
      if (next) {
        store.activatePanel(next.panelInstanceId, { focus: false });
        setMobilePanelId(next.panelInstanceId);
        focusInside(
          panelFocusTarget(next.panelInstanceId, chatTarget, filesTarget, workpadsTarget),
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

  const openPanelFromControl = (panel: PanelInstance, shiftKey: boolean) => {
    const presentation = resolvePanelPresentation(panelPresentation, shiftKey);
    if (collapsed.has(panel.panelInstanceId)) {
      store.restorePanel(panel.panelInstanceId, { presentation });
    } else {
      store.activatePanel(panel.panelInstanceId, { presentation });
    }
    setMobilePanelId(panel.panelInstanceId);
  };

  const chatControls: PanelChromeControls = {
    active,
    onCollapse: () => chatPanel && collapsePanel(chatPanel),
    onClose: (invoker) => chatPanel && closePanel(chatPanel, invoker),
    onDock: (edge) =>
      chatPanel && store.dockPanel(chatPanel.panelInstanceId, edge),
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
    if (panel.kind === "files" || panel.kind === "workpads") {
      const tenant = tenants.tenant(panel.kind === "files" ? "workspace-files" : "workpads");
      if (!tenant) return null;
      const target = panel.kind === "files" ? filesTarget : workpadsTarget;
      const actionsTarget = panel.kind === "files" ? filesChromeActionsTarget : workpadsChromeActionsTarget;
      const available = tenant.availability({ snapshot, workspace: snapshot?.workspace });
      const intent = store.intent(panel.panelInstanceId);
      const status = statuses.get(panel.panelInstanceId);
      return (
        <>
          <PanelChrome
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
          />
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
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!terminal}
                  onSelect={() => terminalPanelRef.current?.clearSelection()}
                >
                  Clear selection
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
                    disabled={
                      terminalSessionState.connection !== "ready" ||
                      !terminalSessionState.caughtUp ||
                      terminalSessionState.role !== "controller"
                    }
                    onSelect={() =>
                      terminalPanelRef.current?.discardUnconfirmedInput()
                    }
                  >
                    Discard unconfirmed input
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

  const renderDesktopNode = (node: LayoutNode): React.ReactNode => {
    if (node.kind === "tabs") return renderStack(node);
    const split = node as SplitNode;
    const sizes = previewSizes.get(split.id) ?? split.sizes;
    const total =
      split.orientation === "row" ? availableSize.width : availableSize.height;
    return (
      <div
        className="workspace-panel-grid"
        data-testid="workspace-panel-split"
        data-orientation={split.orientation}
        style={{
          gridTemplateColumns:
            split.orientation === "row"
              ? `${sizes[0]}fr ${SPLIT_HANDLE_SIZE}px ${sizes[1]}fr`
              : undefined,
          gridTemplateRows:
            split.orientation === "column"
              ? `${sizes[0]}fr ${SPLIT_HANDLE_SIZE}px ${sizes[1]}fr`
              : undefined,
        }}
      >
        {renderDesktopNode(split.children[0])}
        <PaneResizeHandle
          orientation={split.orientation}
          value={Math.max(0, total * sizes[0])}
          min={MIN_PANEL_SIZE}
          max={Math.max(MIN_PANEL_SIZE, total - MIN_PANEL_SIZE)}
          resetValue={total / 2}
          ariaLabel="Resize Chat and Files panels"
          className="workspace-panel-resize-handle"
          testId="workspace-panel-resize-handle"
          onPreview={(value) => {
            const fraction = total > 0 ? value / total : sizes[0];
            setPreviewSizes((current) =>
              new Map(current).set(split.id, [fraction, 1 - fraction]),
            );
          }}
          onCommit={(value) => {
            const fraction = total > 0 ? value / total : sizes[0];
            setPreviewSizes((current) => {
              const next = new Map(current);
              next.delete(split.id);
              return next;
            });
            store.resizeSplit(split.id, [fraction, 1 - fraction]);
          }}
        />
        {renderDesktopNode(split.children[1])}
      </div>
    );
  };

  const openTerminal = (
    terminal: TerminalResource,
    presentation?: PanelPresentation,
  ) => {
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
      ...(presentation ? { presentation } : {}),
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
    onReveal: (presentation) => {
      const panel = store.terminalPanel();
      if (!panel) return false;
      store.activatePanel(panel.panelInstanceId, { presentation });
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
          <TasksPanelToggle openThreadTaskCount={openThreadTaskCount} />
          <div className="workspace-panel-open-menu">
            <div
              className="workspace-panel-open-icons"
              role="group"
              aria-label="Panel shortcuts"
            >
              {panels.map((panel) => (
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
                  onClick={(event) =>
                    openPanelFromControl(panel, event.shiftKey)
                  }
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
                className="workspace-panel-open-menu-content z-[82]"
                align="end"
                sideOffset={6}
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
                  { id: "workpads", title: "Workpads", panel: workpadsPanel, icon: <NotepadText size={16} />, available: tenants.has("workpads") },
                  { id: "terminals", title: "Terminals", panel: terminalsPanel, icon: <TerminalIcon size={16} />, available: true },
                ]).filter(({ available, panel }) => available || panel).map(({ id, title, panel, icon }) => {
                  const status = panel ? statuses.get(panel.panelInstanceId) : undefined;
                  return (
                    <DropdownMenuItem
                      key={id}
                      className="workspace-panel-open-item"
                      data-panel-open={Boolean(panel)}
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
                          terminalEntryRef.current?.open("split", openPanelsTriggerRef.current);
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
                      <span className="workspace-panel-open-item-label">
                        {panel ? panelMenuLabel(panel, terminalResources, snapshot?.thread.title.text, snapshot?.workspace.label.text) : title}
                      </span>
                      {status?.dirty ? <span className="workspace-panel-dirty" aria-label="Unsaved changes" /> : null}
                      {status?.busy ? <span className="comet-spinner workspace-panel-spinner" aria-label="Busy" /> : null}
                      {panel && collapsed.has(panel.panelInstanceId) ? <span className="sr-only">Collapsed</span> : null}
                      {panel ? <Check size={16} aria-hidden="true" /> : null}
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
                  Reset layout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <ThreadTerminalMenu active={active} ref={terminalEntryRef} threadId={threadId} triggerVariant="panel" {...terminalControls} />

      <div
        className="workspace-panel-stage"
        ref={stageRef}
        onFocusCapture={(event) => {
          const panelInstanceId =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-panel-instance-id]")
                  ?.dataset.panelInstanceId
              : undefined;
          if (panelInstanceId)
            lastInteractedPanelIdRef.current = panelInstanceId;
        }}
        onPointerDownCapture={(event) => {
          const panelInstanceId =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-panel-instance-id]")
                  ?.dataset.panelInstanceId
              : undefined;
          if (panelInstanceId)
            lastInteractedPanelIdRef.current = panelInstanceId;
        }}
      >
        {desktop ? (
          soloPanel ? (
            renderStack({
              kind: "tabs",
              id: `solo-${soloPanel.panelInstanceId}`,
              tabs: [soloPanel],
              activePanelInstanceId: soloPanel.panelInstanceId,
            })
          ) : visibleTree ? (
            renderDesktopNode(visibleTree)
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
      {panels.filter(panel => panel.kind === "files" || panel.kind === "workpads").map(panel => {
        const tenant = tenants.tenant(panel.kind === "files" ? "workspace-files" : "workpads");
        if (!tenant) return null;
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
            chromeActionsTarget={panel.kind === "files" ? filesChromeActionsTarget : workpadsChromeActionsTarget}
            onStatus={(status) => updateStatus(panel.panelInstanceId, status)}
            onConsumeIntent={(sequence) => store.consumeIntent(panel.panelInstanceId, sequence)}
            onClose={() => closePanel(panel)}
            onKeyboardMove={(edge) => store.dockPanel(panel.panelInstanceId, edge)}
          />,
          panel.kind === "files" ? filesTarget : workpadsTarget,
          panel.kind === "files" ? `workspace-files:${workspaceId ?? "none"}` : "workpads",
        );
      })}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <Dialog
        open={active && Boolean(dirtyConfirmation)}
        onOpenChange={(open) => !open && setDirtyConfirmation(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              {dirtyConfirmation?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDirtyConfirmation(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const confirmation = dirtyConfirmation;
                setDirtyConfirmation(undefined);
                confirmation?.run();
              }}
            >
              {dirtyConfirmation?.actionLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={active && Boolean(terminalLifecycleConfirmation)}
        onOpenChange={(open) =>
          !open && setTerminalLifecycleConfirmation(undefined)
        }
      >
        <DialogContent showCloseButton={false}>
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
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTerminalLifecycleConfirmation(undefined)}
            >
              Cancel
            </Button>
            <Button
              autoFocus
              onClick={() => {
                const confirmation = terminalLifecycleConfirmation;
                setTerminalLifecycleConfirmation(undefined);
                if (confirmation)
                  closeTerminalView(confirmation.terminalId, confirmation.label);
              }}
            >
              Close tab
            </Button>
            {terminalLifecycleConfirmation?.terminal &&
              terminalLifecycleConfirmation.terminal.lifecycle !== "stopping" && (
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
              )}
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
  onKeyboardMove,
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
  readonly onKeyboardMove: (edge: PanelPlacementEdge) => void;
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
    // Workpads uses route hints for its initial list, independently of its
    // global panel lifetime and the authority of the selected document.
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
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
          const edge = arrowEdge(event.key);
          if (edge) {
            event.preventDefault();
            onKeyboardMove(edge);
          }
        }
      }}
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
  chatTarget: HTMLElement,
  filesTarget: HTMLElement,
  workpadsTarget: HTMLElement,
): HTMLElement | undefined {
  if (panelInstanceId === "chat") return chatTarget;
  if (panelInstanceId === "workspace-files") return filesTarget;
  if (panelInstanceId === "workpads") return workpadsTarget;
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
  return "Terminals";
}

function panelGlyph(
  panel: PanelInstance,
  brand: React.ComponentProps<typeof BackendBrandIcon>["brand"] | undefined,
  size: number,
): React.JSX.Element {
  if (panel.kind === "files") return <Files size={size} />;
  if (panel.kind === "workpads") return <NotepadText size={size} />;
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

function arrowEdge(key: string): PanelPlacementEdge | undefined {
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowUp") return "top";
  if (key === "ArrowDown") return "bottom";
  return undefined;
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
