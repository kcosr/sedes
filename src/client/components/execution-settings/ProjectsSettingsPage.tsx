import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Folder, Folders, Plus, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { ProjectLocation, ProjectSummary } from "../../../shared/index.js";
import { describeProjectLocations } from "../../app/project-locations.js";
import { environmentDisplayLabel } from "../../app/sidebar-scope-presentation.js";
import { useApplicationStore, messageFrom, type ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { AddProjectDialog } from "../AddProjectDialog.js";
import { SettingsPage } from "../settings/SettingsPage.js";
import { SettingsSearch } from "../settings/SettingsSearch.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { EmptyState } from "../ui/empty-state.js";
import { SearchableSelect } from "../ui/searchable-select.js";
import { Skeleton } from "../ui/skeleton.js";
import { StatusPill } from "../ui/status-pill.js";
import { Tag } from "../ui/tag.js";
import { countLabel, RowActions, type RowAction } from "./ExecutionInventory.js";
import {
  MergeProjectDialog,
  MoveLocationDialog,
  RemoveLocationDialog,
  RemoveProjectDialog,
  RenameProjectDialog,
  RestoreProjectDialog,
  locationName,
  type ProjectDialogContext,
} from "./ProjectSettingsDialogs.js";
import {
  duplicateProjectNames,
  filterProjects,
  type ProjectStatusFilter,
} from "./projects-settings-model.js";
import "./execution-settings.css";

type ProjectDialog =
  | { readonly kind: "add"; readonly projectId?: string }
  | { readonly kind: "rename" | "remove-project" | "restore-project"; readonly project: ProjectSummary }
  | { readonly kind: "merge"; readonly sources: readonly ProjectSummary[]; readonly sourceId: string; readonly targetId?: string }
  | { readonly kind: "remove-location" | "move-location"; readonly project: ProjectSummary; readonly location: ProjectLocation };

/**
 * Projects and their locations (one directory on one environment) across
 * every environment: rename, add locations, move, merge, remove, restore.
 */
export function ProjectsSettingsPage({ store }: {
  readonly store: ApplicationClientStore;
}): React.JSX.Element {
  const application = useApplicationStore(store);
  const snapshot = application.snapshot;
  const environments = useMemo(() => snapshot?.environments ?? [], [snapshot?.environments]);
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [pendingId, setPendingId] = useState<string>();
  const [dialog, setDialog] = useState<ProjectDialog & { readonly key: number }>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ProjectStatusFilter>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterPanelId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const filterToggle = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const latestLoad = useRef<Promise<readonly ProjectSummary[] | undefined>>(undefined);
  const openings = useRef(0);
  // Refetch on catalog/identity changes, without issuing requests for streaming tokens.
  const publication = JSON.stringify([
    snapshot?.projects,
    snapshot?.workspaces,
    snapshot?.environments,
    snapshot?.threads.map(({ id, workspaceId }) => ({ id, workspaceId }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    snapshot?.tasks.filter(({ scope }) => scope.kind === "project")
      .map(({ id, scope }) => ({ id, scope })).sort((left, right) => left.id.localeCompare(right.id)),
  ]);
  /** Reloads the list and resolves to it, or to undefined when it cannot be loaded. */
  const refresh = useCallback((): Promise<readonly ProjectSummary[] | undefined> => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    const load = (async (): Promise<readonly ProjectSummary[] | undefined> => {
      try {
        const result = await store.api.listProjects(controller.signal);
        if (!controller.signal.aborted) {
          setProjects(result.projects);
          setLoaded(true);
          return result.projects;
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(messageFrom(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
      // A newer load replaced this one; its list is the current one.
      return request.current === controller ? undefined : latestLoad.current;
    })();
    latestLoad.current = load;
    return load;
  }, [store]);
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh, publication]);
  useEffect(() => {
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = store.normalized.subscribeWorkpadChanges((change) => {
      if (change?.change === "draft" || scheduled !== undefined) return;
      // Coalesce bursts; document changes can create, archive, or move a workpad.
      scheduled = setTimeout(() => { scheduled = undefined; void refresh(); }, 0);
    });
    return () => { unsubscribe(); clearTimeout(scheduled); };
  }, [store, refresh]);

  const projectLocations = useMemo(() => describeProjectLocations({
    projects: snapshot?.projects ?? [], workspaces: snapshot?.workspaces ?? [], environments,
  }), [environments, snapshot?.projects, snapshot?.workspaces]);
  const environmentById = useMemo(() => new Map(environments.map((environment) => [environment.id, environment])), [environments]);
  const threadTitles = useMemo(() => new Map((snapshot?.threads ?? []).map(({ id, title }) => [id, title.text])), [snapshot?.threads]);
  const environmentLabel = (location: ProjectLocation) => {
    const environment = environmentById.get(location.environmentId);
    return environment ? environmentDisplayLabel(environment, environments) : location.environmentLabel;
  };
  const context: ProjectDialogContext = {
    api: store.api,
    projects,
    projectChoice: (project) => projectLocations.projectChoice(project.id) ?? { label: project.name },
    environmentLabel,
    environmentAvailable: (environmentId) => environmentById.get(environmentId)?.available === true,
    threadTitle: (threadId) => threadTitles.get(threadId) || undefined,
    refresh,
  };
  const open = (next: ProjectDialog) => {
    setMutationError("");
    openings.current += 1;
    const opening = openings.current;
    setDialog({ ...next, key: opening });
    setDialogOpen(true);
  };
  const restoreLocation = async (location: ProjectLocation) => {
    if (pendingId) return;
    setPendingId(location.id);
    setMutationError("");
    try {
      await store.reopenWorkspace(location.id);
    } catch (cause) {
      setMutationError(messageFrom(cause));
    } finally {
      await refresh();
      setPendingId(undefined);
    }
  };

  const environmentOptions = new Map(environments.map((environment) => [environment.id, environmentDisplayLabel(environment, environments)]));
  for (const location of projects.flatMap(({ locations }) => locations)) {
    if (!environmentOptions.has(location.environmentId)) environmentOptions.set(location.environmentId, `${location.environmentLabel} (unavailable)`);
  }
  const visible = filterProjects(projects, { environmentId: filter, status, search });
  const duplicates = duplicateProjectNames(projects);
  const activeFilters = Number(Boolean(filter)) + Number(status !== "all");
  const filtered = Boolean(search || activeFilters);
  const clear = () => { setSearch(""); setFilter(""); setStatus("all"); searchInput.current?.focus(); };
  const busy = Boolean(pendingId);

  const projectActions = (project: ProjectSummary): RowAction[] => project.removed ? [
    { label: "Restore project…", disabled: busy, onSelect: () => open({ kind: "restore-project", project }) },
    { label: "Merge into…", disabled: busy, onSelect: () => open({ kind: "merge", sources: [project], sourceId: project.id }) },
  ] : [
    { label: "Rename…", disabled: busy, onSelect: () => open({ kind: "rename", project }) },
    { label: "Add location…", disabled: busy || !environments.length, onSelect: () => open({ kind: "add", projectId: project.id }) },
    { label: "Merge into…", disabled: busy, onSelect: () => open({ kind: "merge", sources: [project], sourceId: project.id }) },
    { label: "Remove project…", destructive: true, disabled: busy, onSelect: () => open({ kind: "remove-project", project }) },
  ];
  const locationActions = (project: ProjectSummary, location: ProjectLocation): RowAction[] => [
    ...(location.removed && !project.removed
      ? [{ label: "Restore location", disabled: busy, onSelect: () => void restoreLocation(location) }] : []),
    { label: "Move to project…", disabled: busy, onSelect: () => open({ kind: "move-location", project, location }) },
    ...(location.removed ? [] : [{
      label: "Remove location…", destructive: true, disabled: busy,
      onSelect: () => open({ kind: "remove-location", project, location }),
    }]),
  ];
  const mergeDuplicates = (named: readonly ProjectSummary[]) => {
    // Merge into the project holding the most locations.
    const target = [...named].sort((left, right) => right.locations.length - left.locations.length)[0]!;
    const source = named.find(({ id }) => id !== target.id)!;
    open({ kind: "merge", sources: named, sourceId: source.id, targetId: target.id });
  };

  return <SettingsPage width="wide" className="projects-settings" title="Projects"
    description="Projects group the directories you work in, across your environments."
    actions={<>
      <Button type="button" variant="ghost" size="icon" aria-label="Refresh projects" title="Refresh" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw /></Button>
      <Button type="button" aria-label="Add project" disabled={busy || !environments.length} onClick={() => open({ kind: "add" })}><Plus />Add project</Button>
    </>}>
    {error ? <Callout tone="danger" role="alert" action={<Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>Retry</Button>}>{error}</Callout> : null}
    {mutationError ? <Callout tone="danger" role="alert">{mutationError}</Callout> : null}
    {duplicates.size > 0 ? <Callout tone="info" title="Some projects share a name" className="projects-duplicates">
      <p>Merge projects that are the same work, so their locations and threads appear together.</p>
      <ul aria-label="Project names used more than once">
        {[...duplicates].map(([name, named]) => <li key={name}>
          <span>“{name}” · {countLabel(named.length, "project")}</span>
          <Button type="button" size="xs" variant="outline" disabled={busy} aria-label={`Merge projects named ${name}`}
            onClick={() => mergeDuplicates(named)}>Merge…</Button>
        </li>)}
      </ul>
    </Callout> : null}
    <section className="projects-list" aria-label="Projects and locations">
      <div className="execution-toolbar projects-toolbar" data-filters={filtersOpen ? "open" : "closed"}>
        <SettingsSearch ref={searchInput} label="Search projects" placeholder="Search projects…" value={search} onValueChange={setSearch} />
        <Button ref={filterToggle} type="button" variant="outline" className="execution-filter-toggle" aria-expanded={filtersOpen} aria-controls={filterPanelId}
          onClick={() => setFiltersOpen(open => !open)}><SlidersHorizontal />Filters{activeFilters ? ` (${activeFilters})` : ""}</Button>
        <div id={filterPanelId} className="execution-filters">
          <div className="execution-filter"><span className="execution-filter-label">Environment</span><SearchableSelect label="Project environment" searchLabel="Search environments" emptyLabel="No matching environments"
            value={filter} onValueChange={setFilter}
            options={[{ value: "", label: "All environments", pinned: true }, ...Array.from(environmentOptions).sort((left, right) => left[1].localeCompare(right[1])).map(([value, label]) => ({ value, label }))]} />
          </div>
          <div className="execution-filter"><span className="execution-filter-label">Status</span><SearchableSelect label="Project status" searchLabel="Search project statuses" emptyLabel="No matching statuses"
            value={status} onValueChange={(value) => setStatus(value as ProjectStatusFilter)}
            options={[{ value: "all", label: "All statuses", pinned: true }, { value: "active", label: "Active" }, { value: "removed", label: "Removed" }]} />
          </div>
          <Button type="button" className="execution-filter-done" onClick={() => { setFiltersOpen(false); filterToggle.current?.focus(); }}>Show results</Button>
        </div>
      </div>
      {loading && !loaded ? <div className="execution-loading" role="status" aria-label="Loading projects"><Skeleton className="h-14" /><Skeleton className="h-14" /></div> : null}
      {loaded ? <div className="execution-list-count">
        <p role="status">{visible.length === projects.length ? countLabel(projects.length, "project") : `${visible.length} of ${countLabel(projects.length, "project")}`}</p>
        {filtered ? <Button type="button" variant="link" size="xs" onClick={clear}>Clear filters</Button> : null}
      </div> : null}
      {loaded && !projects.length ? <EmptyState icon={<Folder />} title="No projects yet" description="Add a directory to start a thread in it."
        action={environments.length ? <Button type="button" variant="outline" onClick={() => open({ kind: "add" })}><Plus />Add project</Button> : undefined} /> : null}
      {loaded && projects.length && !visible.length ? <EmptyState variant="inline" title="No projects match these filters." /> : null}
      {visible.length ? <ul className="projects-rows" aria-label="Projects">{visible.map(({ project, locations }) => {
        const removedLocations = project.locations.filter(({ removed }) => removed).length;
        return <li key={project.id} className="projects-project" data-removed={project.removed || undefined} data-testid="project-settings-row">
          <div className="projects-row projects-project-row">
            <span className="projects-row-icon" aria-hidden="true"><Folders /></span>
            <span className="projects-row-text">
              <span className="projects-row-title"><span>{project.name}</span>{project.removed ? <Tag>Removed</Tag> : null}</span>
              <span className="projects-row-meta">{countLabel(project.locations.length, "location")}{removedLocations > 0 && !project.removed ? ` · ${removedLocations} removed` : ""} · {countLabel(project.taskCount, "task")} · {countLabel(project.workpadCount, "workpad")}</span>
            </span>
            <span className="projects-row-actions"><RowActions label={projectLocations.projectLabel(project.id) ?? project.name} actions={projectActions(project)} /></span>
          </div>
          {locations.length ? <ul className="projects-locations" aria-label={`Locations of ${project.name}`}>{locations.map((location) =>
            <li key={location.id} className="projects-row projects-location-row" data-removed={location.removed || undefined} data-testid="location-settings-row">
              <span className="projects-row-icon" aria-hidden="true"><Folder /></span>
              <span className="projects-row-text">
                <span className="projects-row-title"><span>{environmentLabel(location)}</span>{location.removed ? <Tag>Removed</Tag> : null}</span>
                <span className="projects-row-path" title={location.path}>{location.path}</span>
                <span className="projects-row-meta">{countLabel(location.threadCount, "thread")}</span>
              </span>
              <span className="projects-row-status">{location.available
                ? <StatusPill tone="success">Available</StatusPill> : <StatusPill tone="warning">Unavailable</StatusPill>}</span>
              <span className="projects-row-actions">{pendingId === location.id
                ? <span className="projects-row-meta" role="status">Restoring…</span>
                : <RowActions label={locationName(context, location)} actions={locationActions(project, location)} />}</span>
            </li>)}
          </ul> : null}
        </li>;
      })}</ul> : null}
    </section>
    {dialog?.kind === "add" && dialogOpen ? <AddProjectDialog key={dialog.key} store={store} environments={environments}
      projects={snapshot?.projects ?? []} workspaces={snapshot?.workspaces ?? []}
      initialEnvironmentId={filter || undefined} {...(dialog.projectId === undefined ? {} : { projectId: dialog.projectId })}
      onClose={() => setDialogOpen(false)} onAdded={(_added, addedEnvironmentId) => {
        setStatus("all"); setSearch("");
        if (filter && filter !== addedEnvironmentId) setFilter("");
        void refresh();
      }} /> : null}
    {dialog?.kind === "rename" ? <RenameProjectDialog key={dialog.key} open={dialogOpen} onOpenChange={setDialogOpen} context={context} project={dialog.project} /> : null}
    {dialog?.kind === "remove-project" ? <RemoveProjectDialog key={dialog.key} open={dialogOpen} onOpenChange={setDialogOpen} context={context} project={dialog.project} /> : null}
    {dialog?.kind === "restore-project" ? <RestoreProjectDialog key={dialog.key} open={dialogOpen} onOpenChange={setDialogOpen} context={context} project={dialog.project} /> : null}
    {dialog?.kind === "merge" ? <MergeProjectDialog key={dialog.key} open={dialogOpen} onOpenChange={setDialogOpen} context={context}
      sources={dialog.sources} initialSourceId={dialog.sourceId} {...(dialog.targetId === undefined ? {} : { initialTargetId: dialog.targetId })} /> : null}
    {dialog?.kind === "remove-location" ? <RemoveLocationDialog key={dialog.key} open={dialogOpen} onOpenChange={setDialogOpen} context={context}
      project={dialog.project} location={dialog.location} /> : null}
    {dialog?.kind === "move-location" ? <MoveLocationDialog key={dialog.key} open={dialogOpen} onOpenChange={setDialogOpen} context={context}
      project={dialog.project} location={dialog.location} /> : null}
  </SettingsPage>;
}
