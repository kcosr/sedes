import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Route } from "../app/router";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore";
import { useApplicationStore } from "../stores/ApplicationClientStore";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry";
import { ArchivedView } from "./ArchivedView";
import { AutomationEditor } from "./automation/AutomationEditor";
import { AutomationPage } from "./automation/AutomationPage";
import { AutomationsView } from "./automation/AutomationsView";
import { Plus } from "lucide-react";
import { SedesMark } from "./brand-icons";
import { Button } from "@client/components/ui/button";
import { NewThreadControl } from "./NewThreadControl";
import { SidebarNavTrigger } from "./SidebarNavTrigger";
import { ThreadView } from "./ThreadView";
import { PanelLayout } from "../workspace-panels/PanelLayout";
import type { PanelLayoutStore } from "../workspace-panels/panel-state";
import type { WorkspacePanelTenantRegistry } from "../workspace-panels/registry";
import {
  createWorkspaceFileLinkHandler,
  WorkspaceFileLinkProvider,
} from "../workspace-files/workspace-file-link-routing";
import { UsageView } from "../usage/UsageView";
import { useSidebarInventoryScope } from "../app/use-sidebar-inventory-scope";
import { useEnvironmentColorsEnabled } from "../app/use-environment-colors-enabled";
import {
  configuredPanelPresentation,
  openThreadRoute,
  pointerPanelPresentation,
} from "../workspace-panels/thread-panel-navigation.js";

export function Workbench({
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
  panelLayoutStore: PanelLayoutStore;
  panelTenants: WorkspacePanelTenantRegistry;
}): React.JSX.Element {
  const application = useApplicationStore(applicationStore);
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
            open: (intent, presentation) => {
              panelLayoutStore.openPanel("workspace-files", {
                intent,
                presentation,
              });
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
      panelLayoutStore.openPanel("chat", {
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
          {application.experimentalUsageEnabled ? <UsageView store={applicationStore} /> : <p>Experimental usage accounting is disabled on this server.</p>}
        </div>
      </main>
    );
  }
  if (route.name === "automations" || route.name === "automation") {
    return (
      <main className="workbench">
        <div className="pane-host pane-host-nav-header">
          <div className="pane-nav-header">
            <SidebarNavTrigger />
          </div>
          {route.name === "automations" ? (
            <AutomationsView store={applicationStore} />
          ) : route.edit ? (
            <AutomationEditor store={applicationStore} threadId={route.threadId} />
          ) : (
            <AutomationPage store={applicationStore} threadId={route.threadId} />
          )}
        </div>
      </main>
    );
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
                automationOpen={route.automationOpen}
                focusTurnId={route.focusTurnId}
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

  const recent = application.visibleThreads.find(
    (thread) => thread.inventoryState === "active",
  );

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
                openThreadRoute(threadId, configuredPanelPresentation());
              }}
            >
              <Plus size={18} strokeWidth={1.8} /> New thread
            </NewThreadControl>
            {recent && (
              <Button
                variant="outline"
                onClick={(event) => {
                  openThreadRoute(recent.id, pointerPanelPresentation(event));
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
}
