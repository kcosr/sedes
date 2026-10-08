import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../stores/ApplicationClientStore";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry";
import {
  installNavigationBlocker,
  navigate,
  routePath,
  settingsPath,
  useRoute,
  type Route,
} from "../app/router";
import { DiscardChangesDialog } from "./ui/discard-changes-dialog.js";
import {
  applySidebarWidth,
  clampSidebarWidth,
  getSidebarWidth,
  setSidebarWidth,
  sidebarWidthDefault,
  sidebarWidthMax,
  sidebarWidthMin,
} from "../app/sidebar-width";
import { InventorySidebar } from "./InventorySidebar";
import { installAndroidBackButton } from "../app/android-back.js";
import { installSidebarSearchShortcut } from "../app/sidebar-search-shortcut.js";
import { isAndroidClient } from "../app/client-platform.js";
import { FullPageError, FullPageLoading } from "./LoadingStates";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { Workbench } from "./Workbench";
import {
  MOBILE_DRAWER_CONTENT_ID,
  NavigationControlsContext,
} from "../app/navigation-controls.js";
import {
  getSidebarCollapsed,
  setSidebarCollapsed,
} from "../app/sidebar-collapsed.js";
import {
  clearActiveSidebarFilters,
  getSidebarViewPreferences,
  hasActiveSidebarFilters,
} from "../app/sidebar-view-store.js";
import { SettingsView, useSettingsPages } from "./SettingsView.js";
import { SettingsNav } from "./settings/SettingsNav.js";
import { settingsNavInSidebar } from "./settings/settings-navigation.js";
import { SIDEBAR_NAV_MEDIA_QUERY } from "./SidebarNavTrigger.js";
import { useMediaQuery } from "../app/use-media-query.js";
import { TasksPanel } from "./tasks/TasksPanel.js";
import {
  ServerSettingsForm,
  type ServerSettingsControls,
} from "./ServerSettingsForm";
import type { PanelLayoutStore } from "../workspace-panels/panel-state";
import type { WorkspacePanelTenantRegistry } from "../workspace-panels/registry";
import type { PanelPresentation } from "../workspace-panels/panel-presentation.js";
import { installThreadPanelOpenRequestListener } from "../workspace-panels/thread-panel-navigation.js";
import { ComposerDraftProvider } from "../context-excerpts/coordinator.js";
import { TaskDragProvider } from "../tasks/task-drag.js";
import {
  ElectronConnectionRecovery,
  type ElectronConnectionSettingsControls,
} from "./ElectronConnectionSettings.js";
import type { ToolClientSettingsResources } from "./tool-clients/ToolClientsSettingsPage.js";
import { describeProjectLocations } from "../app/project-locations.js";
import { VoiceControls } from "../voice/VoiceControls.js";

export function ApplicationShell({
  state,
  applicationStore,
  threadRegistry,
  serverSettings,
  electronConnectionSettings,
  panelLayoutStore,
  panelTenants,
  toolClientEndpoint,
}: {
  state: ApplicationClientState;
  applicationStore: ApplicationClientStore;
  threadRegistry: ThreadStoreRegistry;
  serverSettings?: ServerSettingsControls;
  electronConnectionSettings?: ElectronConnectionSettingsControls;
  panelLayoutStore: PanelLayoutStore;
  panelTenants: WorkspacePanelTenantRegistry;
  toolClientEndpoint: string;
}): React.JSX.Element {
  useEffect(() => {
    if (state.status !== "ready") return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") {
        void applicationStore.notifications.refresh();
      }
    };
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [applicationStore, state.status]);
  const route = useRoute();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Drawer contents unmount on close; retain this client-session UI state here.
  const drawerScrollPosition = useRef(0);
  // Keep the thread tree at the same React position and dimensions while Settings
  // occupies the foreground. Its providers own uploads, drafts and live terminals.
  const workspaceReturnRoute = useRef<Route>({ name: "home" });
  if (route.name !== "settings") workspaceReturnRoute.current = route;
  const settingsActive = route.name === "settings";
  const workbenchRoute: Route = settingsActive
    ? workspaceReturnRoute.current.name === "thread"
      ? workspaceReturnRoute.current
      : { name: "home" }
    : route;
  const applicationPreferences = useMemo(
    () => ({
      read: () => applicationStore.api.readApplicationPreferences(),
      update: (
        request: Parameters<
          typeof applicationStore.api.updateApplicationPreferences
        >[0],
      ) => applicationStore.api.updateApplicationPreferences(request),
    }),
    [applicationStore],
  );
  const settingsSources = {
    applicationStore,
    serverSettings,
    electronConnectionSettings,
    configuration: applicationStore.api,
    cannedPrompts: applicationStore.cannedPrompts,
    notifications: applicationStore.notifications,
  };
  const toolClients = useMemo(
    () => ({
      api: applicationStore.api,
      endpoint: toolClientEndpoint,
      resources: toolClientResources(state.snapshot),
    }),
    [applicationStore, state.snapshot, toolClientEndpoint],
  );
  const settingsPages = useSettingsPages({ ...settingsSources, toolClients });
  const settingsReturn = () => navigate(routePath(workspaceReturnRoute.current));
  const settingsReturnLabel =
    workspaceReturnRoute.current.name === "thread" ? "Back to chat" : "Back to workspace";
  const mobileNavigationTrigger = useRef<HTMLButtonElement>(null);
  const workspaceElement = useRef<HTMLDivElement>(null);
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  const previousSettingsActive = useRef(settingsActive);
  useLayoutEffect(() => {
    const wasActive = previousSettingsActive.current;
    previousSettingsActive.current = settingsActive;
    if (settingsActive && !wasActive) {
      if (!settingsReturnFocus.current && document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body) {
        settingsReturnFocus.current = document.activeElement;
      }
    } else if (!settingsActive && wasActive) {
      const returnTarget = settingsReturnFocus.current;
      settingsReturnFocus.current = null;
      // Sidebar navigation may already have placed focus at the destination.
      if (document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body &&
        !document.activeElement.closest("[inert]")) return;
      const target = [returnTarget, mobileNavigationTrigger.current, workspaceElement.current]
        .find(element => element?.isConnected && element !== document.body &&
          element.getClientRects().length > 0 &&
          !element.closest("[inert], [hidden]"));
      target?.focus({ preventScroll: true });
    }
  }, [settingsActive]);
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  const drawerDismissedFromPersistentBar = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsedState] =
    useState(getSidebarCollapsed);
  const mobileLayout = useMediaQuery(SIDEBAR_NAV_MEDIA_QUERY);
  const settingsNavVisible =
    settingsActive && settingsNavInSidebar({ mobileLayout, sidebarCollapsed });
  const settingsNav = useRef<HTMLElement>(null);
  const previousSettingsNavVisible = useRef(settingsNavVisible);
  useLayoutEffect(() => {
    const wasVisible = previousSettingsNavVisible.current;
    previousSettingsNavVisible.current = settingsNavVisible;
    // Restoring the sidebar from the compact Settings header removes that
    // header's trigger; continue from the current page in the nav.
    if (!settingsNavVisible || wasVisible || !settingsActive) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
    settingsNav.current
      ?.querySelector<HTMLElement>('[aria-current="page"], [data-slot="settings-nav-link"]')
      ?.focus({ preventScroll: true });
  }, [settingsActive, settingsNavVisible]);
  const navigationControls = useMemo(
    () => ({
      notifications: applicationStore.notifications,
      openDrawer: () => setDrawerOpen(true),
      toggleDrawer: () => setDrawerOpen((open) => !open),
      toggleSidebar: () =>
        setSidebarCollapsedState((value) => setSidebarCollapsed(!value)),
      sidebarCollapsed,
      drawerOpen,
      connection: state.connection,
      triggerRef: mobileNavigationTrigger,
    }),
    // Reattach the foreground trigger when Settings mounts/unmounts beside the
    // retained workspace; its old ref must not leave the shared target null.
    [applicationStore, drawerOpen, sidebarCollapsed, state.connection, settingsActive],
  );

  useEffect(
    () =>
      installPromptSettingsRequestListener(window, () => {
        settingsReturnFocus.current = document.activeElement instanceof HTMLElement
          ? document.activeElement : null;
        setDrawerOpen(false);
        navigate(settingsPath("prompts"));
      }),
    [],
  );

  const sidebarSearchReveal = useRef({ mobileLayout, sidebarCollapsed, settingsActive });
  sidebarSearchReveal.current = { mobileLayout, sidebarCollapsed, settingsActive };
  useEffect(
    () =>
      installSidebarSearchShortcut(window, {
        isAvailable: () => !sidebarSearchReveal.current.settingsActive,
        reveal: () => {
          const { mobileLayout, sidebarCollapsed } = sidebarSearchReveal.current;
          if (mobileLayout) setDrawerOpen(true);
          else if (sidebarCollapsed) setSidebarCollapsedState(setSidebarCollapsed(false));
        },
        drawerId: MOBILE_DRAWER_CONTENT_ID,
      }),
    [],
  );

  useEffect(() => {
    if (!isAndroidClient()) return undefined;
    return installAndroidBackButton({
      onOpenDrawer: () => setDrawerOpen(true),
      isOnDrawerRoute: () => route.name === "thread" || route.name === "home",
      isDrawerOpen: () => drawerOpenRef.current,
      isSidebarSearchActive: () =>
        applicationStore.getSnapshot().search.length > 0,
      onClearSidebarSearch: () => applicationStore.setSearch(""),
      isSidebarFiltersActive: () =>
        hasActiveSidebarFilters(getSidebarViewPreferences()),
      onClearSidebarFilters: clearActiveSidebarFilters,
      drawerReturnsToThread: () => route.name === "thread",
    });
  }, [applicationStore, route.name]);

  const [workspaceNavConfirm, setWorkspaceNavConfirm] = useState<{
    readonly workspaceId: string;
    readonly next: Route;
    readonly proceed: () => void;
  }>();

  useEffect(() => {
    const threads =
      state.status === "ready" ? state.snapshot?.threads : undefined;
    if (!threads) return undefined;
    return installNavigationBlocker(
      createWorkspacePanelNavigationBlocker(
        applicationStore.workspaceIdForThread,
        panelLayoutStore,
        {
          onBlocked: (request) => {
            setWorkspaceNavConfirm(request);
          },
        },
        () => workspaceReturnRoute.current,
      ),
    );
  }, [applicationStore, panelLayoutStore, state.status]);

  useEffect(
    () => installWorkspacePanelBeforeUnloadGuard(panelLayoutStore, window),
    [panelLayoutStore],
  );
  useEffect(
    () =>
      installThreadPanelOpenRequestListener(window, (request) => {
        openThreadChatPanel(
          panelLayoutStore,
          request.threadId,
          request.presentation,
        );
      }),
    [panelLayoutStore],
  );

  if (state.status === "loading") return <FullPageLoading />;
  if (state.status === "error") {
    return (
      <FullPageError
        message={state.error ?? "The server did not respond."}
        retry={() => void applicationStore.refresh().catch(() => undefined)}
        settings={
          electronConnectionSettings ? (
            <ElectronConnectionRecovery controls={electronConnectionSettings} />
          ) : serverSettings ? (
            <ServerSettingsForm controls={serverSettings} />
          ) : undefined
        }
      />
    );
  }
  if (!state.snapshot) return <FullPageLoading />;

  const sidebar = (peekEnabled: boolean) => (
    <InventorySidebar
      state={state}
      store={applicationStore}
      threadRegistry={threadRegistry}
      selectedThreadId={route.name === "thread" || route.name === "automation" ? route.threadId : undefined}
      onSelectThread={(threadId, presentation) => {
        openThreadChatPanel(panelLayoutStore, threadId, presentation);
      }}
      onNavigate={(options) => {
        if (!options?.keepDrawerOpen) setDrawerOpen(false);
      }}
      onOpenSettings={(trigger, page) => {
        // The drawer's Settings button disappears when the drawer closes.
        // Return to the persistent workspace trigger, even on a fast round trip.
        settingsReturnFocus.current = peekEnabled ? trigger : mobileNavigationTrigger.current;
        setDrawerOpen(false);
        navigate(settingsPath(page));
      }}
      showFooterConnectionStatus={peekEnabled && route.name !== "thread"}
      peekEnabled={peekEnabled}
      scrollPosition={peekEnabled ? undefined : drawerScrollPosition}
    />
  );

  const composerWorkspaceId = resolveComposerWorkspaceId(
    workbenchRoute,
    applicationStore.workspaceIdForThread,
  );
  const routedPanelLayoutStore =
    workbenchRoute.name === "thread"
      ? panelLayoutStore.forThread(workbenchRoute.threadId)
      : panelLayoutStore;
  // The Tasks host wraps the workbench: the workbench bar's Tasks toggle and
  // the docked `tasks` panel tenant reach the one retained Tasks body through
  // its context.
  const routedContent = (
    <TasksPanel
      active={!settingsActive}
      route={workbenchRoute}
      store={applicationStore}
      panelLayoutStore={routedPanelLayoutStore}
    >
      <Workbench
        route={workbenchRoute}
        active={!settingsActive}
        applicationStore={applicationStore}
        threadRegistry={threadRegistry}
        panelLayoutStore={routedPanelLayoutStore}
        panelTenants={panelTenants}
      />
    </TasksPanel>
  );
  const composerRoutedContent =
    workbenchRoute.name === "thread" ? (
      <ComposerDraftProvider
        threadId={workbenchRoute.threadId}
        workspaceId={composerWorkspaceId}
      >
        {routedContent}
      </ComposerDraftProvider>
    ) : (
      routedContent
    );

  return (
    <TaskDragProvider store={applicationStore} snapshot={state.snapshot}>
      <div
        className="application-shell"
        data-sidebar-collapsed={sidebarCollapsed || undefined}
      >
      <aside
        id="desktop-sidebar"
        className="desktop-sidebar"
        data-testid="desktop-sidebar"
        data-mode={settingsActive ? "settings" : "inventory"}
        aria-label={settingsActive ? "Settings" : "Thread inventory"}
      >
        {/* The inventory stays mounted under Settings so its scroll,
            disclosure and virtualization state survive the round trip. */}
        <div
          className="desktop-sidebar-inventory"
          inert={settingsActive}
          aria-hidden={settingsActive || undefined}
        >
          {sidebar(true)}
        </div>
        {settingsNavVisible ? (
          <SettingsNav
            ref={settingsNav}
            pages={settingsPages}
            page={route.page}
            returnLabel={settingsReturnLabel}
            onReturn={settingsReturn}
          />
        ) : null}
      </aside>
      <SidebarResizeHandle />
      <NavigationControlsContext.Provider value={navigationControls}>
        <DialogPrimitive.Root
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          modal={false}
        >
          <DialogPrimitive.Portal>
            <DialogPrimitive.Content
              id={MOBILE_DRAWER_CONTENT_ID}
              className="mobile-drawer"
              aria-describedby={undefined}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                if (drawerDismissedFromPersistentBar.current) {
                  drawerDismissedFromPersistentBar.current = false;
                  return;
                }
                // No Dialog.Trigger exists (the toggle lives in the persistent
                // workbench bar), so restore Escape/Back dismissal ourselves.
                mobileNavigationTrigger.current?.focus();
              }}
              onInteractOutside={(event) => {
                const target = event.target;
                if (!(target instanceof Element)) return;
                if (
                  event.detail.originalEvent.type === "focusin" &&
                  target.closest('[data-slot="dialog-content"]')
                ) {
                  // A dialog opened from the drawer (a confirmation, a
                  // blocking check) layers above it and takes focus; the
                  // drawer stays open beneath it.
                  event.preventDefault();
                  return;
                }
                if (target.closest(".sidebar-nav-trigger")) {
                  // Let the persistent toggle own the state transition. If the
                  // dismissable layer closed first, the click would reopen it.
                  event.preventDefault();
                  return;
                }
                // Persistent chrome keeps focus: the card under the drawer
                // still does what was tapped while the drawer closes.
                drawerDismissedFromPersistentBar.current = Boolean(
                  target.closest(".workspace-workbench-bar, .pane-nav-header, .voice-dock"),
                );
              }}
            >
              <DialogPrimitive.Title className="sr-only">
                Thread navigation
              </DialogPrimitive.Title>
              {sidebar(false)}
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <div className="application-main">
          {/* The voice card docks under the view on every route; the drawer
              covers the view only and ends on the card. */}
          <div
            ref={publishVoiceDockHeight}
            className="application-view"
            data-drawer-open={(drawerOpen && mobileLayout) || undefined}
          >
          <div
            ref={workspaceElement}
            className="application-workspace"
            tabIndex={-1}
            data-active={!settingsActive}
            inert={settingsActive}
            aria-hidden={settingsActive || undefined}
          >
            {composerRoutedContent}
          </div>
          {route.name === "settings" ? (
            <SettingsView
              {...settingsSources}
              page={route.page}
              onReturn={settingsReturn}
              returnLabel={settingsReturnLabel}
              applicationPreferences={applicationPreferences}
              toolClients={toolClients}
            />
          ) : null}
          </div>
          <VoiceControls threads={state.snapshot?.threads ?? []} />
        </div>
        <DiscardChangesDialog
          open={Boolean(workspaceNavConfirm)}
          onOpenChange={(open) => {
            if (!open) setWorkspaceNavConfirm(undefined);
          }}
          description="This workspace has unsaved panel changes. Discard them and leave this workspace?"
          discardLabel="Discard and leave"
          onDiscard={() => {
            const confirmation = workspaceNavConfirm;
            if (!confirmation) return;
            panelLayoutStore.discardWorkspacePanelChanges(
              confirmation.workspaceId,
            );
            confirmation.proceed();
          }}
        />
        </NavigationControlsContext.Provider>
      </div>
    </TaskDragProvider>
  );
}

/**
 * Tool client default choices. A location reads "Project · path": the
 * choices are limited to the client's default environment, so the path
 * tells them apart.
 */
export function toolClientResources(
  snapshot: ApplicationClientState["snapshot"],
): ToolClientSettingsResources {
  if (!snapshot) return { workspaces: [], threads: [] };
  const projectLocations = describeProjectLocations(snapshot);
  return {
    workspaces: snapshot.workspaces.map((workspace) => ({
      id: workspace.id,
      environmentId: workspace.environmentId,
      label:
        projectLocations.projectPathLabel(workspace.id) ??
        workspace.displayPath.text,
      available: workspace.available,
    })),
    threads: snapshot.threads.map((thread) => ({
      id: thread.id,
      workspaceId: thread.workspaceId,
      title: thread.title.text,
      available: thread.available,
      archived: thread.inventoryState === "archived",
    })),
  };
}

export function openThreadChatPanel(
  panelLayoutStore: Pick<PanelLayoutStore, "forThread">,
  threadId: string,
  presentation: PanelPresentation,
): boolean {
  return panelLayoutStore
    .forThread(threadId)
    .openPanel("chat", { focus: true, presentation });
}

export function installPromptSettingsRequestListener(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  onRequest: () => void,
): () => void {
  target.addEventListener("sedes-open-settings-prompts", onRequest);
  return () =>
    target.removeEventListener("sedes-open-settings-prompts", onRequest);
}

export function resolveComposerWorkspaceId(
  route: Route,
  workspaceIdForThread: (threadId: string) => string | undefined,
): string | undefined {
  return route.name === "thread"
    ? workspaceIdForThread(route.threadId)
    : undefined;
}

export interface WorkspacePanelNavigationBlockHandlers {
  /** Called when navigation is blocked so the shell can open its confirm dialog. */
  readonly onBlocked: (request: {
    readonly workspaceId: string;
    readonly next: Route;
    readonly proceed: () => void;
  }) => void;
}

export function createWorkspacePanelNavigationBlocker(
  workspaceForThread: (threadId: string) => string | undefined,
  panelLayoutStore: Pick<
    PanelLayoutStore,
    "hasDirtyWorkspacePanels" | "discardWorkspacePanelChanges"
  >,
  handlers: WorkspacePanelNavigationBlockHandlers,
  retainedRoute: () => Route | undefined = () => undefined,
): (current: Route, next: Route, proceed: () => void) => boolean {
  const workspaceFor = (candidate: Route): string | undefined =>
    candidate.name === "thread"
      ? workspaceForThread(candidate.threadId)
      : undefined;
  return (current, next, proceed) => {
    if (next.name === "settings") return true;
    const currentWorkspaceId = workspaceFor(
      current.name === "settings" ? retainedRoute() ?? current : current,
    );
    const nextWorkspaceId = workspaceFor(next);
    if (
      !currentWorkspaceId ||
      currentWorkspaceId === nextWorkspaceId ||
      !panelLayoutStore.hasDirtyWorkspacePanels(currentWorkspaceId)
    ) {
      return true;
    }
    handlers.onBlocked({ workspaceId: currentWorkspaceId, next, proceed });
    return false;
  };
}

export function installWorkspacePanelBeforeUnloadGuard(
  panelLayoutStore: Pick<
    PanelLayoutStore,
    "hasAnyDirtyWorkspacePanels" | "subscribeWorkspaceDirty"
  >,
  target: Pick<Window, "addEventListener" | "removeEventListener">,
): () => void {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = true;
  };
  let installed = false;
  const sync = () => {
    const shouldInstall = panelLayoutStore.hasAnyDirtyWorkspacePanels();
    if (shouldInstall === installed) return;
    installed = shouldInstall;
    if (installed) target.addEventListener("beforeunload", beforeUnload);
    else target.removeEventListener("beforeunload", beforeUnload);
  };
  sync();
  const unsubscribe = panelLayoutStore.subscribeWorkspaceDirty(sync);
  return () => {
    unsubscribe();
    if (installed) target.removeEventListener("beforeunload", beforeUnload);
  };
}

/**
 * Publishes the band under the application view as `--voice-dock-height` on
 * the document root, where full-height mobile surfaces portalled to the body
 * (the drawer) read it to end above the voice card instead of covering it.
 * The card is the main column's only in-flow child after the view, so the
 * view's shortfall is the card's height: 0px when it does not render.
 */
export function installVoiceDockHeight(
  main: HTMLElement,
  view: HTMLElement,
  root: HTMLElement = document.documentElement,
): () => void {
  const publish = () => {
    const height = main.getBoundingClientRect().bottom - view.getBoundingClientRect().bottom;
    root.style.setProperty("--voice-dock-height", `${Math.max(0, height)}px`);
  };
  // The view shrinks as the card appears or grows; both resize with the viewport.
  const observer = new ResizeObserver(publish);
  observer.observe(main);
  observer.observe(view);
  publish();
  return () => {
    observer.disconnect();
    root.style.removeProperty("--voice-dock-height");
  };
}

function publishVoiceDockHeight(view: HTMLDivElement | null): (() => void) | undefined {
  return view?.parentElement ? installVoiceDockHeight(view.parentElement, view) : undefined;
}

/**
 * Drag handle on the sidebar/main boundary. Drives the `--sidebar-width`
 * custom property consumed by the `.application-shell` grid — DOM writes are
 * batched through requestAnimationFrame and persistence happens once at the
 * end of a gesture, so the shell never remounts or thrashes layout.
 */
function SidebarResizeHandle(): React.JSX.Element {
  const widthRef = useRef(0);
  if (widthRef.current === 0) widthRef.current = getSidebarWidth();

  return (
    <PaneResizeHandle
      className="sidebar-resize-handle"
      orientation="row"
      value={widthRef.current}
      min={sidebarWidthMin}
      max={sidebarWidthMax}
      resetValue={sidebarWidthDefault}
      ariaLabel="Resize sidebar"
      normalizeValue={clampSidebarWidth}
      onPreview={(width) => {
        widthRef.current = width;
        applySidebarWidth(width);
      }}
      onCommit={(width) => {
        widthRef.current = setSidebarWidth(width);
      }}
    />
  );
}
