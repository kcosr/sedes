import { GitBranch } from "lucide-react";
import {
  useApplicationStore,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import { workspaceDisplayLabel } from "../../app/sidebar-scope-presentation.js";
import {
  PanelChrome,
  type PanelChromeControls,
} from "../../workspace-panels/PanelChrome.js";
import { SIDEBAR_NAV_MEDIA_QUERY } from "../SidebarNavTrigger.js";
import { ThreadLoading } from "../LoadingStates.js";
import { ThreadHeading, useThreadHeaderTint } from "./ThreadHeading.js";

/** Inventory identifies the selected chat while its provider snapshot loads. */
export function ThreadLoadingView({
  threadId,
  applicationStore,
  panelControls,
}: {
  readonly threadId: string;
  readonly applicationStore: ApplicationClientStore;
  readonly panelControls?: PanelChromeControls;
}): React.JSX.Element {
  const application = useApplicationStore(applicationStore);
  const inventory = application.snapshot;
  const thread = inventory?.threads.find(({ id }) => id === threadId) ??
    Object.values(application.descendantPages).flatMap(({ descendants }) =>
      descendants.map(({ thread }) => thread),
    ).find(({ id }) => id === threadId);
  const workspaces = inventory?.workspaces ?? [];
  const environments = inventory?.environments ?? [];
  const workspace = workspaces.find(({ id }) => id === thread?.workspaceId);
  const environment = environments.find(({ id }) => id === workspace?.environmentId);
  const target = inventory?.executionTargets.find(({ id }) => id === thread?.targetId);
  const tint = useThreadHeaderTint(environments, environment?.id);
  const mobile = useMediaQuery(SIDEBAR_NAV_MEDIA_QUERY);
  const worktree = thread?.preferredWorktree;
  const worktreeLabel = worktree ? worktree.branch ?? worktree.displayLabel : "Primary";

  return (
    <section className="thread-view" data-testid="thread-loading-view">
      <PanelChrome
        panelTitle="Chat"
        className="thread-header"
        controls={panelControls}
        environmentTintStyle={tint}
        leading={
          <ThreadHeading
            backend={thread?.backend}
            title={<h1>{thread ? thread.title.text || "Untitled thread" : "Opening thread"}</h1>}
            mobile={mobile}
            context={workspace && environment && thread ? {
              projectLabel: workspaceDisplayLabel({
                workspace,
                workspaces,
                environments,
                includeEnvironment: environments.length > 1 && environment.kind !== "local",
              }),
              targetLabel: target?.label.text ?? thread.backend.label.text,
              targetAvailable: target?.available,
            } : undefined}
            worktree={thread ? (
              <span className="thread-worktree-label" title={worktreeLabel}>
                <GitBranch size={12} aria-hidden="true" />
                <span>{worktreeLabel}</span>
              </span>
            ) : undefined}
          />
        }
      />
      <div className="runtime-banner" role="status">
        <strong>Loading conversation…</strong>
      </div>
      <ThreadLoading />
    </section>
  );
}
