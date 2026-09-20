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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
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
import { isAndroidClient } from "../app/client-platform.js";
import { Button } from "@client/components/ui/button";
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
import { SettingsView } from "./SettingsView.js";
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
  const toolClients = useMemo(
    () => ({
      api: applicationStore.api,
      endpoint: toolClientEndpoint,
      resources: {
        workspaces: (state.snapshot?.workspaces ?? []).map((workspace) => ({
          id: workspace.id,
          environmentId: workspace.environmentId,
          label: workspace.label.text,
          available: workspace.available,
        })),
        threads: (state.snapshot?.threads ?? []).map((thread) => ({
          id: thread.id,
          workspaceId: thread.workspaceId,
          title: thread.title.text,
          available: thread.available,
          archived: thread.inventoryState === "archived",
        })),
      },
    }),
    [applicationStore, state.snapshot, toolClientEndpoint],
  );
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
      selectedThreadId={route.name === "thread" ? route.threadId : undefined}
      onSelectThread={(threadId, presentation) => {
        openThreadChatPanel(panelLayoutStore, threadId, presentation);
      }}
      onNavigate={(options) => {
        if (!options?.keepDrawerOpen) setDrawerOpen(false);
      }}
      onOpenSettings={(trigger) => {
        // The drawer's Settings button disappears when the drawer closes.
        // Return to the persistent workspace trigger, even on a fast round trip.
        settingsReturnFocus.current = peekEnabled ? trigger : mobileNavigationTrigger.current;
        setDrawerOpen(false);
        navigate(settingsPath());
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
  const routedContent = (
    <>
      <Workbench
        route={workbenchRoute}
        active={!settingsActive}
        applicationStore={applicationStore}
        threadRegistry={threadRegistry}
        panelLayoutStore={routedPanelLayoutStore}
        panelTenants={panelTenants}
      />
      <TasksPanel
        active={!settingsActive}
        route={workbenchRoute}
        store={applicationStore}
        panelLayoutStore={routedPanelLayoutStore}
      />
    </>
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
        aria-label="Thread inventory"
      >
        {sidebar(true)}
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
                if (target.closest(".sidebar-nav-trigger")) {
                  // Let the persistent toggle own the state transition. If the
                  // dismissable layer closed first, the click would reopen it.
                  event.preventDefault();
                  return;
                }
                drawerDismissedFromPersistentBar.current = Boolean(
                  target.closest(".workspace-workbench-bar, .pane-nav-header"),
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
              applicationStore={applicationStore}
              page={route.page}
              onReturn={() => navigate(routePath(workspaceReturnRoute.current))}
              returnLabel={workspaceReturnRoute.current.name === "thread"
                ? "Back to chat" : "Back to workspace"}
              serverSettings={serverSettings}
              electronConnectionSettings={electronConnectionSettings}
              applicationPreferences={applicationPreferences}
              configuration={applicationStore.api}
              cannedPrompts={applicationStore.cannedPrompts}
              notifications={applicationStore.notifications}
              toolClients={toolClients}
            />
          ) : null}
        </div>
        <Dialog
          open={Boolean(workspaceNavConfirm)}
          onOpenChange={(open) => {
            if (!open) setWorkspaceNavConfirm(undefined);
          }}
        >
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Discard unsaved changes?</DialogTitle>
              <DialogDescription>
                This workspace has unsaved panel changes. Discard them and leave
                this workspace?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setWorkspaceNavConfirm(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const confirmation = workspaceNavConfirm;
                  setWorkspaceNavConfirm(undefined);
                  if (!confirmation) return;
                  panelLayoutStore.discardWorkspacePanelChanges(
                    confirmation.workspaceId,
                  );
                  confirmation.proceed();
                }}
              >
                Discard and leave
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </NavigationControlsContext.Provider>
      </div>
    </TaskDragProvider>
  );
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
