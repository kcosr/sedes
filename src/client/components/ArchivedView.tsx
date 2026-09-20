import type { NormalizedApplicationThreadSummary } from "../../shared/index.js";
import { navigate } from "../app/router.js";
import {
  useApplicationStore,
  type ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";
import { Archive, Box, ChevronRight, Search } from "lucide-react";
import { ThreadContextMenu } from "./ThreadContextMenu.js";
import { Button } from "@client/components/ui/button";
import { Input } from "@client/components/ui/input";
import { ForkProvenanceButton } from "./lineage/ForkProvenanceButton.js";
import {
  targetDisplayLabel,
  workspaceDisplayLabel,
} from "../app/sidebar-scope-presentation.js";
import {
  openThreadRoute,
  pointerPanelPresentation,
} from "../workspace-panels/thread-panel-navigation.js";

export function ArchivedView({
  store,
}: {
  store: ApplicationClientStore;
}): React.JSX.Element {
  const state = useApplicationStore(store);
  const archived = state.visibleThreads.filter(
    ({ inventoryState }) => inventoryState === "archived",
  );
  const workspaces = new Map(
    state.snapshot?.workspaces.map((workspace) => [workspace.id, workspace]) ??
      [],
  );
  const workspaceCatalog = state.snapshot?.workspaces ?? [];
  const environments = state.snapshot?.environments ?? [];
  const executionTargets = state.snapshot?.executionTargets ?? [];
  const restore = async (thread: NormalizedApplicationThreadSummary) => {
    await store.mutateInventory(thread, "restore");
  };

  return (
    <section className="archive-view">
      <header className="archive-header">
        <button className="back-button" onClick={() => navigate("/")}>
          <ChevronRight className="back-chevron" size={18} strokeWidth={1.8} />{" "}
          Back
        </button>
        <div>
          <p className="eyebrow">Thread inventory</p>
          <h1>Archived</h1>
          <p>Hidden from your daily workspace, never deleted.</p>
        </div>
        <label className="search-box archive-search">
          <Search size={18} strokeWidth={1.8} />
          <span className="sr-only">Search archived threads</span>
          <Input
            type="search"
            className="border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            placeholder="Search archive"
            value={state.search}
            onChange={(event) => store.setSearch(event.target.value)}
          />
        </label>
      </header>
      <div className="archive-list">
        {archived.map((thread) => {
          const workspace = workspaces.get(thread.workspaceId);
          const environment = workspace
            ? environments.find(({ id }) => id === workspace.environmentId)
            : undefined;
          const target = executionTargets.find(
            ({ id }) => id === thread.targetId,
          );
          const workspaceLabel = workspace
            ? workspaceDisplayLabel({
                workspace,
                workspaces: workspaceCatalog,
                environments,
                includeEnvironment:
                  environments.length > 1 && environment?.kind !== "local",
              })
            : "Workspace";
          const targetLabel = target
            ? targetDisplayLabel({
                target,
                targets: executionTargets,
                environments,
                includeEnvironment: false,
              })
            : thread.backend.label.text;
          const origin = state.snapshot?.forkOrigins.find(
            ({ childThreadId }) => childThreadId === thread.id,
          );
          const placement = state.snapshot?.lineagePlacements.find(
            ({ childThreadId }) => childThreadId === thread.id,
          );
          const sourceTitle = origin?.sourceThreadId
            ? state.snapshot?.threads.find(
                ({ id }) => id === origin.sourceThreadId,
              )?.title.text
            : undefined;
          return (
            <ThreadContextMenu
              key={thread.id}
              thread={thread}
              store={store}
              origin={origin}
              placement={placement}
              sourceTitle={sourceTitle}
              configurationCopyPending={state.pendingThreadConfigurationCopySourceIds.includes(
                thread.id,
              )}
            >
              <article
                className="archive-row"
                data-testid="archive-row"
                data-thread-id={thread.id}
              >
                <button
                  className="archive-row-title"
                  onClick={(event) =>
                    openThreadRoute(thread.id, pointerPanelPresentation(event))
                  }
                >
                  <Archive size={14} strokeWidth={1.8} />
                  <strong>{thread.title.text || "Untitled thread"}</strong>
                  <small>
                    {workspaceLabel}
                    {workspace?.available === false
                      ? " · Project unavailable"
                      : ""}
                    {environment?.available === false
                      ? " · Environment unavailable"
                      : ""}
                    <span className="archive-row-target">
                      <Box size={12} strokeWidth={1.8} aria-hidden="true" />
                      {targetLabel}
                      {target?.available === false ? " · Unavailable" : ""}
                    </span>
                  </small>
                </button>
                {origin && (
                  <ForkProvenanceButton
                    origin={origin}
                    sourceTitle={sourceTitle}
                  />
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void restore(thread).catch(() => undefined)}
                >
                  Restore
                </Button>
              </article>
            </ThreadContextMenu>
          );
        })}
        {archived.length === 0 && (
          <div className="large-empty">
            <Archive size={22} strokeWidth={1.8} />
            <h2>No archived threads</h2>
            <p>
              {state.search
                ? "Nothing matches this search."
                : "Threads you archive will appear here."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
