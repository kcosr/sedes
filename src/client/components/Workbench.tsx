import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Route } from "../app/router";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../stores/ApplicationClientStore";
import {
  sameSelectedFields,
  useApplicationStoreSelector,
} from "../stores/use-application-store-selector.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry";
import { AutomationEditor } from "./automation/AutomationEditor";
import { AutomationPage } from "./automation/AutomationPage";
import { AutomationsView } from "./automation/AutomationsView";
import { Plus } from "lucide-react";
import { SedesMark } from "./brand-icons";
import { Button } from "@client/components/ui/button";
import { NewThreadControl } from "./NewThreadControl";
import { SettingsBackSlotContext } from "./settings/SettingsPage";
import { useSettingsNavInSidebar } from "./settings/settings-navigation";
import { SidebarNavTrigger } from "./SidebarNavTrigger";
import { ThreadView } from "./ThreadView";
import { PanelLayout } from "../workspace-panels/PanelLayout";
import type { PanelRegionStore } from "../workspace-panels/region-store";
import type { WorkspacePanelTenantRegistry } from "../workspace-panels/registry";
import {
  createWorkspaceFileLinkHandler,
  WorkspaceFileLinkProvider,
} from "../workspace-files/workspace-file-link-routing";
import { useSidebarInventoryScope } from "../app/use-sidebar-inventory-scope";
import { useEnvironmentColorsEnabled } from "../app/use-environment-colors-enabled";
import { openThreadRoute } from "../workspace-panels/thread-panel-navigation.js";
import { lazyView } from "./LazyView.js";

const ArchivedView = lazyView(
  "archived threads",
  async () => (await import("./ArchivedView")).ArchivedView,
);
const UsageView = lazyView(
  "usage",
  async () => (await import("../usage/UsageView")).UsageView,
);
const UsageDisabledView = lazyView(
  "usage",
  async () => (await import("../usage/UsageView")).UsageDisabledView,
);

// Memoized with field-level application subscriptions: sidebar search and
// other inventory-only changes re-render the shell, not the workbench.
export const Workbench = memo(function Workbench({
  route,
  active = true,
  applicationStore,
  threadRegistry,
  panelLayoutStore,
  panelTenants,
}: {
  route: Route;
  active?: boolean;
  applicationStore: ApplicationClientStore;
  threadRegistry: ThreadStoreRegistry;
  panelLayoutStore: PanelRegionStore;
  panelTenants: WorkspacePanelTenantRegistry;
}): React.JSX.Element {
  // Only the welcome view's Continue recent follows the sidebar's search.
  const welcome = route.name === "home" || route.name === "settings";
  const selectApplication = useCallback(
    (state: ApplicationClientState) => ({
      snapshot: state.snapshot,
      experimentalUsageEnabled: state.experimentalUsageEnabled,
      recent: welcome
        ? state.visibleThreads.find(
            (thread) => thread.inventoryState === "active",
          )
        : undefined,
    }),
    [welcome],
  );
  const application = useApplicationStoreSelector(
    applicationStore,
    selectApplication,
    sameSelectedFields,
  );
  const projects = application.snapshot?.projects ?? [];
  const workspaces = application.snapshot?.workspaces ?? [];
  const environments = application.snapshot?.environments ?? [];
  const executionTargets = application.snapshot?.executionTargets ?? [];
  // The sidebar's scope as it applies to this snapshot; stale persisted
  // selections resolve to All, so creation never narrows by them.
  const { scope: sidebarScope } = useSidebarInventoryScope({
    environments,
    executionTargets,
    projects,
    workspaces,
    groups: application.snapshot?.groups ?? [],
  });
  const environmentColorsEnabled = useEnvironmentColorsEnabled();
  const lastThreadRoute = useRef<string | undefined>(
    route.name === "thread" ? route.threadId : undefined,
  );
  const selectedThreadId = route.name === "thread" ? route.threadId : undefined;
  useEffect(() => {
    if (!selectedThreadId) return;
    threadRegistry.retain(selectedThreadId);
    return () => threadRegistry.release(selectedThreadId);
  }, [selectedThreadId, threadRegistry]);
  const threadWorkspaceId =
    route.name === "thread"
      ? applicationStore.workspaceIdForThread(route.threadId)
      : undefined;
  const threadEnvironmentId = application.snapshot?.workspaces.find(
    ({ id }) => id === threadWorkspaceId,
  )?.environmentId;
  const environmentTintEnabled =
    environmentColorsEnabled &&
    (application.snapshot?.environments.length ?? 0) > 1;
  const environmentIds = useMemo(
    () => application.snapshot?.environments.map(({ id }) => id) ?? [],
    [application.snapshot?.environments],
  );
  const workspaceFileLinkHandler = useMemo(
    () =>
      threadWorkspaceId === undefined || selectedThreadId === undefined
        ? undefined
        : createWorkspaceFileLinkHandler({
            threadId: selectedThreadId,
            workspaceId: threadWorkspaceId,
            resolve: (threadId, reference, signal) =>
              applicationStore.api.resolveThreadWorkspaceFileLink(
                threadId,
                reference,
                signal,
              ),
            open: (intent) => {
              panelLayoutStore.open("files", { intent });
            },
          }),
    [applicationStore, panelLayoutStore, selectedThreadId, threadWorkspaceId],
  );
  useLayoutEffect(
    () => () => workspaceFileLinkHandler?.dispose?.(),
    [workspaceFileLinkHandler],
  );
  useLayoutEffect(() => {
    const threadId = route.name === "thread" ? route.threadId : undefined;
    const previousThreadId = lastThreadRoute.current;
    const changed = threadId !== previousThreadId;
    lastThreadRoute.current = threadId;
    if (changed && threadId) {
      panelLayoutStore.open("chat", {
        focus: true,
        focusScope: { kind: "thread", threadId },
      });
    }
  }, [panelLayoutStore, route]);

  if (route.name === "archived") {
    return (
      <main className="workbench">
        <div className="pane-host pane-host-nav-header">
          <div className="pane-nav-header">
            <SidebarNavTrigger />
          </div>
          <ArchivedView store={applicationStore} />
        </div>
      </main>
    );
  }
  if (route.name === "usage") {
    return (
      <main className="workbench">
        <div className="pane-host pane-host-nav-header">
          <div className="pane-nav-header">
            <SidebarNavTrigger />
          </div>
          {application.experimentalUsageEnabled ? <UsageView store={applicationStore} /> : <UsageDisabledView />}
        </div>
      </main>
    );
  }
  if (route.name === "automations" || route.name === "automation" || route.name === "automation-create") {
    return <AutomationsPane>
      {route.name === "automations" ? <AutomationsView key={route.threadId ?? "all"} store={applicationStore} threadId={route.threadId} />
        : route.name === "automation-create" ? <AutomationEditor key={route.threadId} store={applicationStore} threadRegistry={threadRegistry} threadId={route.threadId} />
        : route.edit ? <AutomationEditor key={route.automationId} store={applicationStore} threadRegistry={threadRegistry} automationId={route.automationId} />
        : <AutomationPage key={route.automationId} store={applicationStore} threadRegistry={threadRegistry} automationId={route.automationId} />}
    </AutomationsPane>;
  }
  if (route.name === "thread") {
    const panelLayout = (
      <main className="workbench">
        <div className="pane-host">
          <PanelLayout
            active={active}
            store={panelLayoutStore}
            tenants={panelTenants}
            applicationStore={applicationStore}
            threadRegistry={threadRegistry}
            threadId={route.threadId}
            workspaceId={threadWorkspaceId}
            environmentId={threadEnvironmentId}
            environmentIds={environmentIds}
            environmentTintEnabled={environmentTintEnabled}
            renderChat={(panelControls, visible) => (
              <ThreadView
                key={route.threadId}
                threadId={route.threadId}
                focusTurnId={route.focusTurnId}
                focusResponse={route.focusResponse}
                registry={threadRegistry}
                applicationStore={applicationStore}
                panelControls={panelControls}
                visible={visible}
              />
            )}
          />
        </div>
      </main>
    );
    return (
      <WorkspaceFileLinkProvider handler={workspaceFileLinkHandler}>
        {panelLayout}
      </WorkspaceFileLinkProvider>
    );
  }

  const recent = application.recent;

  return (
    <main className="workbench">
      <div className="pane-host pane-host-nav-header">
        <div className="pane-nav-header">
          <SidebarNavTrigger />
        </div>
        <section className="welcome">
          <div className="welcome-symbol">
            <SedesMark size={44} />
          </div>
          <h1>What should the agent work on?</h1>
          <p>
            Start a durable draft now. The agent won’t launch until you send the
            first message.
          </p>
          <div className="welcome-actions">
            <NewThreadControl
              store={applicationStore}
              environments={environments}
              projects={projects}
              workspaces={workspaces}
              executionTargets={executionTargets}
              creationScope={{
                environmentId: sidebarScope.environmentId,
                targetId: sidebarScope.targetId,
                projectId: sidebarScope.projectId,
              }}
              onCreated={(threadId) => {
                openThreadRoute(threadId);
              }}
            >
              <Plus size={18} strokeWidth={1.8} /> New thread
            </NewThreadControl>
            {recent && (
              <Button
                variant="outline"
                onClick={() => {
                  openThreadRoute(recent.id);
                }}
              >
                Continue recent
              </Button>
            )}
          </div>
          {workspaces.length === 0 && (
            <p className="notice warning">
              Add a project from the sidebar or while creating a new thread.
            </p>
          )}
        </section>
      </div>
    </main>
  );
});

/**
 * The automation pages' pane. Its bar shows where the sidebar does not
 * (phones, a collapsed sidebar), and then carries the page's "‹" link, as
 * the compact Settings header does, so the bar is the one way up.
 */
function AutomationsPane({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const barShown = !useSettingsNavInSidebar();
  const [backSlot, setBackSlot] = useState<HTMLElement | null>(null);
  return (
    <main className="workbench">
      <div className="pane-host pane-host-nav-header">
        <div className="pane-nav-header automation-pane-nav-header">
          <SidebarNavTrigger />
          <div ref={setBackSlot} className="settings-view-back-slot" />
        </div>
        <SettingsBackSlotContext.Provider value={barShown ? backSlot : null}>
          {children}
        </SettingsBackSlotContext.Provider>
      </div>
    </main>
  );
}
