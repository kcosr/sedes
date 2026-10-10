import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatAutofocus } from "../app/use-chat-autofocus.js";
import {
  environmentTintStyle,
  resolveEnvironmentPaletteTones,
} from "../app/environment-palette.js";
import { useEnvironmentPalette } from "../app/use-environment-palette.js";
import {
  usePublishTasksDock,
  useTasksHost,
} from "../components/tasks/tasks-host.js";
import { DiscardChangesDialog } from "../components/ui/discard-changes-dialog.js";
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
  ThreadTerminalMenu,
  type ThreadTerminalControls,
  type ThreadTerminalMenuHandle,
} from "../terminals/index.js";
import {
  PanelChrome,
  panelContentId,
  type PanelChromeControls,
  type PanelChromeStatus,
  type PanelRegionControls,
} from "./PanelChrome.js";
import {
  createChromeActionsTarget,
  createPortalTarget,
  domIdFragment,
  escapeBelongsElsewhere,
  focusInside,
  objectSafeIntegerField,
  objectStringField,
  withoutMapKey,
  type PanelTargets,
} from "./panel-dom.js";
import {
  PANEL_TITLES,
  REGION_PHRASES,
  joinPanelTitles,
} from "./panel-kinds.js";
import { PanelToolbar, type PanelToolbarEntry } from "./PanelToolbar.js";
import {
  computeRegionGeometry,
  panelSizeHints,
  shareForHandleSize,
  type RegionGeometry,
  type RegionResizeHandle,
} from "./region-geometry.js";
import { EmptyWorkbench, RegionStage } from "./RegionStage.js";
import { usePanelRegions, type PanelRegionStore } from "./region-store.js";
import {
  PANEL_KINDS,
  SHARED_PANEL_KINDS,
  chooseForegroundPanel,
  isEdgeRegion,
  isPanelKind,
  panelIdForKind,
  tenantIdForKind,
  withLayout,
  type PanelKind,
  type RegionId,
  type SharedPanelKind,
} from "./regions.js";
import type { WorkspacePanelTenantRegistry } from "./registry.js";
import { StablePaneSlot } from "./StablePaneSlot.js";
import { TenantContent, renderTenantMenu } from "./TenantContent.js";
import {
  TerminalCloseDialog,
  TerminalsPanelBody,
  TerminalsPanelHeader,
} from "./TerminalsPanel.js";
import { useMobileTerminalHistory } from "./use-mobile-terminal-history.js";
import { usePanelFocusRequests } from "./use-panel-focus-requests.js";
import { useThreadTerminals } from "./use-thread-terminals.js";

/**
 * A thread's workbench: the bar, and the panels on the stage.
 *
 * On the desktop stage every panel shows in its region (see regions.ts and
 * region-geometry.ts). Phones (≤819px) show one foreground panel among the
 * shown ones, Tasks as a sheet and Terminals as a dismissible viewer.
 *
 * Every loaded panel's content lives in a retained portal target, adopted by
 * its region's slot while it is on stage and parked otherwise, so drafts,
 * scroll and editors survive hiding, moving and Maximize. Closing a panel
 * unloads it, and its content unmounts.
 */

const MOBILE_QUERY = "(max-width: 819px)";

interface DirtyConfirmation {
  readonly description: string;
  readonly actionLabel: string;
  readonly run: () => void;
}

export interface PanelLayoutProps {
  readonly active?: boolean;
  readonly store: PanelRegionStore;
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
  const snapshot = usePanelRegions(store);
  const { view, focusRequest } = snapshot;
  const threadState = useThreadStore(threadStore);
  const applicationState = useApplicationStore(applicationStore);
  const threadSnapshot = threadState.snapshot;
  const tasksHost = useTasksHost();
  const chatAutofocus = useChatAutofocus();
  const hints = useMemo(() => panelSizeHints(tenants), [tenants]);

  const stageRef = useRef<HTMLDivElement>(null);
  const panelsTriggerRef = useRef<HTMLButtonElement>(null);
  const terminalEntryRef = useRef<ThreadTerminalMenuHandle>(null);
  const terminalTabMenuRef = useRef<ThreadTerminalMenuHandle>(null);
  const lastUsedKindRef = useRef<PanelKind | undefined>(undefined);
  const [desktop, setDesktop] = useState(
    () => !window.matchMedia(MOBILE_QUERY).matches,
  );
  const [mobileKind, setMobileKind] = useState<PanelKind>();
  const [announcement, setAnnouncement] = useState("");
  const [statuses, setStatuses] = useState<
    ReadonlyMap<PanelKind, PanelChromeStatus>
  >(() => new Map());
  const [dirtyConfirmation, setDirtyConfirmation] =
    useState<DirtyConfirmation>();
  const [preview, setPreview] = useState<RegionGeometry>();
  const [targets] = useState<PanelTargets>(() => ({
    chat: createPortalTarget("chat", PANEL_TITLES.chat),
    files: createPortalTarget("files", PANEL_TITLES.files),
    workpads: createPortalTarget("workpads", PANEL_TITLES.workpads),
    tasks: createPortalTarget("tasks", PANEL_TITLES.tasks),
    terminals: createPortalTarget("terminals", PANEL_TITLES.terminals),
  }));
  const [actionsTargets] = useState<Readonly<Record<SharedPanelKind, HTMLElement>>>(
    () => ({
      files: createChromeActionsTarget(),
      workpads: createChromeActionsTarget(),
      tasks: createChromeActionsTarget(),
    }),
  );

  const applicationThread = applicationState.snapshot?.threads.find(
    ({ id }) => id === threadId,
  );
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
  const workpadCount =
    active && applicationState.authoritative
      ? applicationThread?.nonArchivedWorkpadCount
      : undefined;
  const environmentPalette = useEnvironmentPalette();
  const tones = useMemo(
    () => resolveEnvironmentPaletteTones(environmentIds, environmentPalette),
    [environmentIds, environmentPalette],
  );
  const tone = environmentId ? tones.get(environmentId) : undefined;
  const tint =
    environmentTintEnabled && tone ? environmentTintStyle(tone) : undefined;

  const terminalsPanel = snapshot.terminals;
  const terminals = useThreadTerminals({
    store,
    threadId,
    applicationStore,
    authoritative: applicationState.authoritative,
    connected: applicationState.connection === "connected",
    terminalSummary: applicationThread?.terminalSummary,
    panel: terminalsPanel,
    announce: setAnnouncement,
  });

  const available = (kind: PanelKind): boolean =>
    kind === "chat" ||
    kind === "terminals" ||
    tenants.has(tenantIdForKind(kind));
  const loaded = (kind: PanelKind): boolean => snapshot.loaded.includes(kind);
  // Phones show one foreground panel; Tasks is a sheet there, never on stage.
  const foreground = desktop
    ? undefined
    : chooseForegroundPanel(view, {
        ...(mobileKind ? { selected: mobileKind } : {}),
        ...(focusRequest ? { requested: focusRequest.kind } : {}),
      });
  const onStage = (kind: PanelKind): boolean =>
    desktop ? snapshot.visible.includes(kind) : foreground === kind;
  // Before the stage is measured, lay out as if it filled the window.
  const geometry = useMemo(
    () =>
      snapshot.geometry ??
      computeRegionGeometry(
        view,
        { width: window.innerWidth, height: window.innerHeight },
        hints,
      ),
    [hints, snapshot.geometry, view],
  );

  // ------------------------------------------------------------------------
  // The stage: its size, and which panels are used.

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => {
      if (media.matches) {
        const focused = document.activeElement?.closest<HTMLElement>(
          "[data-panel-kind]",
        )?.dataset.panelKind;
        const kind = isPanelKind(focused) ? focused : lastUsedKindRef.current;
        if (kind) setMobileKind(kind);
      }
      setDesktop(!media.matches);
    };
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);

  // Make-room and geometry follow the measured stage. A hidden stage (under
  // Settings) keeps its last size; phones have no stage geometry.
  useLayoutEffect(() => {
    if (!desktop) {
      store.setStageSize(undefined);
      return undefined;
    }
    const stage = stageRef.current;
    if (!stage) return undefined;
    const update = () => {
      const bounds = stage.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0)
        store.setStageSize({ width: bounds.width, height: bounds.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [desktop, store]);

  // Maximize is a desktop arrangement; phones show one panel anyway.
  useEffect(() => {
    if (!desktop && snapshot.maximized !== null) store.restore();
  }, [desktop, snapshot.maximized, store]);

  // Focusing or pressing inside a panel uses it: make-room hides the least
  // recently used edge regions first. The listeners are native, on the
  // stage: content portaled into a panel from outside this React tree (the
  // retained Tasks body) bubbles its React events past the stage, but its
  // DOM events pass through it.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const noteUse = (event: Event) => {
      const kind =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-panel-kind]")?.dataset
              .panelKind
          : undefined;
      if (!isPanelKind(kind)) return;
      lastUsedKindRef.current = kind;
      store.touch(kind);
    };
    stage.addEventListener("focusin", noteUse, true);
    stage.addEventListener("pointerdown", noteUse, true);
    return () => {
      stage.removeEventListener("focusin", noteUse, true);
      stage.removeEventListener("pointerdown", noteUse, true);
    };
  }, [store]);

  // Announce what make-room hides or brings back as the stage changes. What
  // a thread shows when it mounts or is switched to is left unannounced.
  const madeRoomRef = useRef<
    { readonly threadId: string; readonly hidden: readonly PanelKind[] } | undefined
  >(undefined);
  const madeRoomKey =
    desktop && snapshot.stage
      ? [...snapshot.hiddenByMakeRoom].sort().join()
      : undefined;
  useEffect(() => {
    if (madeRoomKey === undefined) return;
    const hidden = snapshot.hiddenByMakeRoom;
    const previous = madeRoomRef.current;
    madeRoomRef.current = { threadId, hidden };
    if (previous?.threadId !== threadId) return;
    const ordered = (kinds: readonly PanelKind[]) =>
      PANEL_KINDS.filter((kind) => kinds.includes(kind));
    const newlyHidden = ordered(
      hidden.filter((kind) => !previous.hidden.includes(kind)),
    );
    const returned = ordered(
      previous.hidden.filter(
        (kind) => !hidden.includes(kind) && snapshot.visible.includes(kind),
      ),
    );
    const parts = [
      ...(newlyHidden.length > 0
        ? [`${joinPanelTitles(newlyHidden)} hidden to make room.`]
        : []),
      ...(returned.length > 0 ? [`${joinPanelTitles(returned)} shown again.`] : []),
    ];
    if (parts.length > 0) setAnnouncement(parts.join(" "));
    // Runs when the set make-room hides changes; the rest is read as of then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [madeRoomKey, threadId]);

  // A terminal off stage disconnects its renderer; its session state goes
  // with it, so showing it again does not show a stale connection.
  const terminalsOnStage = onStage("terminals");
  const setTerminalSessionState = terminals.setSessionState;
  useEffect(() => {
    if (!terminalsOnStage) setTerminalSessionState(undefined);
  }, [setTerminalSessionState, terminalsOnStage]);

  // A divider's live preview ends with any layout change.
  useEffect(() => setPreview(undefined), [view.layout]);

  usePanelFocusRequests({
    active,
    desktop,
    focusRequest,
    store,
    threadId,
    targets,
    terminalRef: terminals.panelRef,
    chatAutofocus,
    threadState,
    onFocusPanel: setMobileKind,
  });

  /** After a panel hides, focus the next panel on stage, else ▾. */
  const focusAfterHide = (hidden: PanelKind) => {
    requestAnimationFrame(() => {
      const latest = store.getSnapshot();
      const next = desktop
        ? latest.visible.find((kind) => kind !== hidden)
        : chooseForegroundPanel(latest.view, { exclude: ["tasks", hidden] });
      if (next) {
        setMobileKind(next);
        focusInside(targets[next], desktop);
      } else panelsTriggerRef.current?.focus();
    });
  };

  // ------------------------------------------------------------------------
  // Files and Workpads status

  const filesIntent = store.intent("files");
  const filesIntentWorkspaceId = objectStringField(filesIntent, "workspaceId");
  const filesIntentSequence = objectSafeIntegerField(filesIntent, "sequence");
  const filesLoaded = loaded("files");
  useEffect(() => {
    if (
      filesIntentWorkspaceId !== undefined &&
      workspaceId !== undefined &&
      filesIntentWorkspaceId !== workspaceId &&
      filesIntentSequence !== undefined &&
      filesLoaded
    )
      store.consumeIntent("files", filesIntentSequence);
  }, [filesIntentSequence, filesIntentWorkspaceId, filesLoaded, store, workspaceId]);

  // Files remounts with its workspace; Workpads keeps its global editor and
  // must retain its dirty/busy status across workspace navigation.
  useEffect(() => {
    setStatuses((current) => withoutMapKey(current, "files"));
  }, [workspaceId]);

  const filesDirty = Boolean(statuses.get("files")?.dirty);
  useEffect(() => {
    if (!workspaceId) return undefined;
    store.setWorkspaceTenantDirty(workspaceId, "workspace-files", filesDirty);
    return () => {
      store.setWorkspaceTenantDirty(workspaceId, "workspace-files", false);
    };
  }, [filesDirty, store, workspaceId]);

  const updateStatus = (kind: PanelKind, status: PanelChromeStatus) => {
    setStatuses((current) => {
      const next = new Map(current);
      if (status.busy || status.dirty || status.subtitle) next.set(kind, status);
      else next.delete(kind);
      return next;
    });
  };

  // ------------------------------------------------------------------------
  // Panel actions

  const closePanel = (kind: PanelKind, invoker?: HTMLElement) => {
    if (kind === "terminals" && dismissMobileTerminalThroughHistory()) return;
    const title = PANEL_TITLES[kind];
    const run = () => {
      if (!store.close(kind)) return;
      if (kind === "terminals") terminals.setSessionState(undefined);
      setAnnouncement(
        kind === "chat"
          ? "Chat panel hidden."
          : kind === "terminals"
            ? "Terminals panel closed. Its process was not terminated."
            : `${title} panel closed.`,
      );
      // A header retained with its content (Chat's, Tasks') is parked, and
      // inert, while its panel is hidden.
      requestAnimationFrame(() => {
        if (invoker?.isConnected && !invoker.closest("[inert]")) invoker.focus();
        else focusAfterHide(kind);
      });
    };
    // Chat's ✕ only hides it, so nothing is lost.
    if (kind !== "chat" && statuses.get(kind)?.dirty) {
      setDirtyConfirmation({
        description: `Closing ${title} will discard its unsaved changes.`,
        actionLabel: "Discard and close",
        run,
      });
    } else run();
  };

  const dismissMobileTerminalThroughHistory = useMobileTerminalHistory({
    active,
    enabled: !desktop && foreground === "terminals",
    threadId,
    dismiss: () => closePanel("terminals"),
  });

  const regionControls = (kind: PanelKind): PanelRegionControls | undefined => {
    if (!desktop) return undefined;
    const region = view.layout.placement[kind];
    const title = PANEL_TITLES[kind];
    return {
      region,
      maximized: snapshot.maximized === kind,
      ...(isEdgeRegion(region) ? { extended: store.isExtended(region) } : {}),
      onMaximize: () => {
        if (store.maximize(kind)) setAnnouncement(`${title} panel maximized.`);
      },
      onRestore: () => {
        if (store.restore()) setAnnouncement("Panel layout restored.");
      },
      onMove: (target) => {
        if (store.move(kind, target))
          setAnnouncement(`${title} panel moved to the ${target}.`);
      },
      onExtend: (on) => {
        if (isEdgeRegion(region)) store.setExtend(region, on);
      },
    };
  };

  const controlsFor = (kind: PanelKind): PanelChromeControls => {
    const region = regionControls(kind);
    return {
      active,
      onClose: (invoker) => closePanel(kind, invoker),
      ...(kind === "chat" ? { closeAction: "hide" as const } : {}),
      ...(region ? { region } : {}),
    };
  };

  // Escape restores a maximized layout, unless something else owns the key.
  useEffect(() => {
    if (!active || !desktop || snapshot.maximized === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        escapeBelongsElsewhere(event)
      )
        return;
      event.preventDefault();
      if (store.restore()) setAnnouncement("Panel layout restored.");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, desktop, snapshot.maximized, store]);

  /**
   * Phones: the Tasks sheet. It leaves the device layout alone, so opening
   * it on a phone does not replace the panel the Right shows elsewhere.
   */
  const showTasksSheet = (show: boolean) => {
    if (tasksHost && tasksHost.sheetOpen !== show) tasksHost.toggleSheet();
  };

  const togglePanel = (kind: PanelKind) => {
    if (kind === "tasks" && !desktop) {
      showTasksSheet(!(tasksHost?.sheetOpen ?? false));
      return;
    }
    if (!desktop && foreground !== kind) {
      if (store.open(kind)) setMobileKind(kind);
      return;
    }
    const wasOnStage = onStage(kind);
    // A keyboard toggle (Ctrl+Shift+L) hides the panel holding focus.
    const focused = document.activeElement;
    const focusWasInside =
      focused instanceof Element &&
      (targets[kind].contains(focused) ||
        focused.closest<HTMLElement>("[data-panel-kind]")?.dataset.panelKind === kind);
    if (!store.toggle(kind)) return;
    if (wasOnStage) {
      setAnnouncement(`${PANEL_TITLES[kind]} panel hidden.`);
      if (focusWasInside) focusAfterHide(kind);
    } else setMobileKind(kind);
  };

  const openFromMenu = (kind: PanelKind, region: RegionId | undefined): boolean => {
    if (kind === "terminals") {
      terminalEntryRef.current?.open(region, panelsTriggerRef.current);
      return false;
    }
    if (kind === "tasks" && !desktop) {
      showTasksSheet(true);
      return true;
    }
    if (!store.open(kind, region ? { region } : {})) return false;
    setMobileKind(kind);
    return true;
  };

  const resetLayout = () => {
    const run = () => {
      store.resetLayout();
      setStatuses(new Map());
      setMobileKind("chat");
      setAnnouncement("Panel layout reset.");
    };
    const dirty = PANEL_KINDS.filter(
      (kind) => loaded(kind) && statuses.get(kind)?.dirty,
    );
    if (dirty.length > 0) {
      setDirtyConfirmation({
        description: `Resetting the layout will discard unsaved changes in ${dirty
          .map((kind) => PANEL_TITLES[kind])
          .join(", ")}.`,
        actionLabel: "Discard and reset",
        run,
      });
    } else run();
  };

  usePublishTasksDock(
    tenants.has("tasks")
      ? {
          present: loaded("tasks"),
          visible: active && desktop && onStage("tasks"),
          controls: controlsFor("tasks"),
          ...(tint ? { environmentTintStyle: tint } : {}),
          open: ({ focus }) => store.open("tasks", { focus }),
          toggle: () => togglePanel("tasks"),
          close: () => closePanel("tasks"),
        }
      : undefined,
  );

  const terminalControls: ThreadTerminalControls = {
    api: applicationStore.api,
    onOpen: (terminal, region) => {
      if (terminals.open(terminal, region)) setMobileKind("terminals");
    },
    onRename: terminals.rename,
    onReveal: (region) => {
      if (!store.terminalPanel()) return false;
      store.open("terminals", region ? { region } : {});
      setMobileKind("terminals");
      return true;
    },
    onResourceChange: terminals.noteResource,
    onDelete: (terminalId) => {
      const existing = terminals.resources.get(terminalId);
      terminals.removeFromClient(
        terminalId,
        existing?.displayName,
        terminals.dispositionOf(existing),
      );
    },
  };

  // ------------------------------------------------------------------------
  // The bar

  const toolbarEntries: PanelToolbarEntry[] = PANEL_KINDS.filter(available).map(
    (kind) => {
      const sheetOpen =
        kind === "tasks" && !desktop && (tasksHost?.sheetOpen ?? false);
      const state = sheetOpen || onStage(kind)
        ? "visible"
        : loaded(kind)
          ? "hidden"
          : "closed";
      const stateLabel =
        state === "closed"
          ? undefined
          : state === "hidden"
            ? "Loaded, hidden"
            : !desktop
              ? "Showing"
              : snapshot.maximized === kind
                ? "Maximized"
                : REGION_PHRASES[view.layout.placement[kind]];
      const badge =
        kind === "tasks"
          ? {
              count: openThreadTaskCount,
              label: `${openThreadTaskCount} open ${openThreadTaskCount === 1 ? "task" : "tasks"}`,
            }
          : kind === "workpads" && workpadCount !== undefined
            ? {
                count: workpadCount,
                label: `${workpadCount} ${workpadCount === 1 ? "workpad" : "workpads"} in this thread`,
              }
            : undefined;
      const status = statuses.get(kind);
      return {
        kind,
        state,
        placement: view.layout.placement[kind],
        ...(stateLabel ? { stateLabel } : {}),
        ...(badge ? { badge } : {}),
        ...(kind === "tasks" ? { controls: "tasks-panel" } : {}),
        ...(status ? { status } : {}),
      };
    },
  );

  // ------------------------------------------------------------------------
  // Panels

  const renderTenantSurface = (kind: SharedPanelKind): React.ReactNode => {
    const tenant = tenants.tenant(tenantIdForKind(kind));
    if (!tenant) return null;
    const availability = tenant.availability({
      snapshot: threadSnapshot,
      workspace: threadSnapshot?.workspace,
    });
    const actionsTarget = actionsTargets[kind];
    return (
      <>
        {tenant.header === "tenant" ? null : (
          <PanelChrome
            tenant={tenant}
            status={statuses.get(kind)}
            environmentTintStyle={tint}
            panelActions={
              <StablePaneSlot
                className="workspace-panel-chrome-actions-slot"
                target={actionsTarget}
              />
            }
            controls={{
              ...controlsFor(kind),
              renderMenuItems: renderTenantMenu(tenant, {
                threadId,
                workspaceId,
                applicationStore,
                threadRegistry,
                visible: active && onStage(kind),
                intent: store.intent(kind),
                chromeActionsTarget: actionsTarget,
              }),
            }}
          />
        )}
        <StablePaneSlot
          className="workspace-panel-content"
          id={panelContentId(tenant.id)}
          target={targets[kind]}
        />
        {availability && !availability.available ? (
          <div className="workspace-panel-availability" role="status">
            {availability.reason ?? `${tenant.title} is temporarily unavailable.`}
          </div>
        ) : null}
      </>
    );
  };

  const renderPanelSurface = (kind: PanelKind): React.ReactNode => {
    if (kind === "chat")
      return <StablePaneSlot className="workspace-panel-content" target={targets.chat} />;
    if (kind === "terminals") {
      if (!terminalsPanel) return null;
      return (
        <>
          <TerminalsPanelHeader
            active={active}
            threadId={threadId}
            panel={terminalsPanel}
            terminals={terminals}
            controls={controlsFor("terminals")}
            tabMenuRef={terminalTabMenuRef}
            terminalControls={terminalControls}
          />
          <StablePaneSlot className="workspace-panel-content" target={targets.terminals} />
        </>
      );
    }
    return renderTenantSurface(kind);
  };

  const renderRegionPanel = (kind: PanelKind, region: RegionId) => (
    <section
      className={`workspace-panel-leaf workspace-panel-${kind}`}
      data-panel-kind={kind}
      data-panel-instance-id={panelIdForKind(kind)}
      data-region={region}
      aria-label={`${PANEL_TITLES[kind]} panel`}
    >
      {renderPanelSurface(kind)}
    </section>
  );

  const renderMobilePanel = (kind: PanelKind) => {
    const terminal = kind === "terminals";
    const descriptionId = `mobile-terminal-description-${domIdFragment(threadId)}`;
    return (
      <section
        className={`workspace-panel-leaf workspace-panel-mobile-base workspace-panel-${kind}`}
        data-panel-kind={kind}
        data-panel-instance-id={panelIdForKind(kind)}
        aria-label={`${PANEL_TITLES[kind]} panel`}
        role={terminal ? "dialog" : undefined}
        aria-modal={terminal ? false : undefined}
        aria-describedby={terminal ? descriptionId : undefined}
        data-state={active && terminal ? "open" : undefined}
        data-mobile-terminal-panel={terminal ? "true" : undefined}
      >
        {terminal ? (
          <p id={descriptionId} className="sr-only">
            Closing this panel detaches this client. It does not terminate the
            terminal process.
          </p>
        ) : null}
        {renderPanelSurface(kind)}
      </section>
    );
  };

  /** A divider's double-click: the panel's default size on this stage. */
  const defaultHandleSize = (handle: RegionResizeHandle): number => {
    const stage = snapshot.stage;
    const sizes = view.layout.sizes[handle.kind];
    if (!stage || sizes?.[handle.axis] === undefined) return handle.size;
    const rest = { ...sizes };
    delete rest[handle.axis];
    const layout = withLayout(view.layout, {
      sizes: { ...view.layout.sizes, [handle.kind]: rest },
    });
    return (
      computeRegionGeometry({ ...view, layout }, stage, hints).handles.find(
        ({ region }) => region === handle.region,
      )?.size ?? handle.size
    );
  };

  const parked = PANEL_KINDS.filter((kind) => loaded(kind) && !onStage(kind));

  return (
    <div className="workspace-panel-layout" data-testid="workspace-panel-layout">
      <PanelToolbar
        active={active}
        entries={toolbarEntries}
        brand={threadSnapshot?.capabilities.backend.brand}
        places={desktop}
        triggerRef={panelsTriggerRef}
        onToggle={(kind) => togglePanel(kind)}
        onOpen={openFromMenu}
        onReset={resetLayout}
      />

      <ThreadTerminalMenu
        active={active}
        ref={terminalEntryRef}
        threadId={threadId}
        triggerVariant="panel"
        {...terminalControls}
      />

      <div
        className="workspace-panel-stage"
        ref={stageRef}
        data-layout={desktop ? "regions" : "single"}
        data-maximized={desktop ? (snapshot.maximized ?? undefined) : undefined}
        data-panels={desktop ? geometry.panels.length : undefined}
      >
        {desktop ? (
          <RegionStage
            geometry={preview ?? geometry}
            renderPanel={renderRegionPanel}
            onResizePreview={(handle, size) => {
              const committed = geometry.handles.find(
                ({ region }) => region === handle.region,
              );
              setPreview(
                committed && Math.abs(size - committed.size) < 0.5
                  ? undefined
                  : store.previewResize(
                      handle.kind,
                      handle.axis,
                      shareForHandleSize(handle, size),
                    ),
              );
            }}
            onResizeCommit={(handle, size) => {
              setPreview(undefined);
              // A divider released where it was must not resize every thread.
              const committed = geometry.handles.find(
                ({ region }) => region === handle.region,
              );
              if (committed && Math.abs(size - committed.size) < 0.5) return;
              store.resize(handle.kind, handle.axis, shareForHandleSize(handle, size));
            }}
            resetSize={defaultHandleSize}
          />
        ) : foreground ? (
          renderMobilePanel(foreground)
        ) : (
          <EmptyWorkbench />
        )}
      </div>

      <div className="workspace-panel-parking" aria-hidden="true" inert>
        {parked.map((kind) => (
          <StablePaneSlot key={kind} target={targets[kind]} />
        ))}
      </div>

      {createPortal(
        renderChat(controlsFor("chat"), active && onStage("chat")),
        targets.chat,
        `chat:${threadId}`,
      )}
      {SHARED_PANEL_KINDS.map((kind) => {
        if (!loaded(kind)) return null;
        const tenant = tenants.tenant(tenantIdForKind(kind));
        if (!tenant) return null;
        return createPortal(
          <TenantContent
            tenant={tenant}
            threadId={threadId}
            workspaceId={workspaceId}
            workspaceLabel={threadSnapshot?.workspace.label.text}
            applicationStore={applicationStore}
            threadRegistry={threadRegistry}
            intent={store.intent(kind)}
            visible={active && onStage(kind)}
            presentation={desktop ? "dock" : "sheet"}
            chromeActionsTarget={actionsTargets[kind]}
            onStatus={(status) => updateStatus(kind, status)}
            onConsumeIntent={(sequence) => store.consumeIntent(kind, sequence)}
            onClose={() => closePanel(kind)}
          />,
          targets[kind],
          kind === "files" ? `files:${workspaceId ?? "none"}` : kind,
        );
      })}
      {terminalsPanel
        ? createPortal(
            <TerminalsPanelBody
              active={active}
              visible={active && onStage("terminals")}
              panel={terminalsPanel}
              terminals={terminals}
              applicationStore={applicationStore}
              onCreate={(invoker) => terminalTabMenuRef.current?.create(invoker)}
            />,
            targets.terminals,
            `terminals:${threadId}`,
          )
        : null}

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

      <TerminalCloseDialog active={active} terminals={terminals} />
    </div>
  );
}
