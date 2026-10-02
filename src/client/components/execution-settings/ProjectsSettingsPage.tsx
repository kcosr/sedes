import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Folder, Plus, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { ProjectLocation } from "../../../shared/index.js";
import { useApplicationStore, messageFrom, type ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { AddProjectDialog } from "../AddProjectDialog.js";
import { SettingsPage } from "../settings/SettingsPage.js";
import { SettingsSearch } from "../settings/SettingsSearch.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { EmptyState } from "../ui/empty-state.js";
import { SearchableSelect } from "../ui/searchable-select.js";
import { Skeleton } from "../ui/skeleton.js";
import { StatusPill } from "../ui/status-pill.js";
import { Tag } from "../ui/tag.js";
import { useFocusReturn } from "../settings/use-focus-return.js";
import { countLabel } from "./ExecutionInventory.js";
import "./execution-settings.css";

/** Remembered directories across environments: remove hides a project, restore brings it back. */
export function ProjectsSettingsPage({ store }: {
  readonly store: ApplicationClientStore;
}): React.JSX.Element {
  const application = useApplicationStore(store);
  const environments = application.snapshot?.environments ?? [];
  // Each row is still one location; the two-level project list arrives with
  // the project settings redesign.
  const [projects, setProjects] = useState<readonly ProjectLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingId, setPendingId] = useState<string>();
  const [removing, setRemoving] = useState<ProjectLocation>();
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterPanelId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const filterToggle = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const focusReturn = useFocusReturn();
  // Refetch on catalog/identity changes, without issuing requests for streaming tokens.
  const publication = JSON.stringify([
    application.snapshot?.workspaces,
    application.snapshot?.environments,
    application.snapshot?.threads.map(({ id, workspaceId }) => ({ id, workspaceId }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  ]);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await store.api.listProjects(controller.signal);
      if (!controller.signal.aborted) { setProjects(result.projects.flatMap(({ locations }) => locations)); setLoaded(true); }
    } catch (cause) {
      if (!controller.signal.aborted) setError(messageFrom(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [store]);
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh, publication]);
  const remove = async (project: ProjectLocation) => {
    setPendingId(project.id);
    setNotice("");
    try {
      await store.api.removeLocation(project.id, { expectedRevision: project.revision });
      setNotice(`Removed project ${project.label}. Files and history are retained.`);
      await refresh();
    } catch (cause) {
      await refresh();
      throw new Error(messageFrom(cause));
    } finally {
      setPendingId(undefined);
    }
  };
  const restore = async (project: ProjectLocation) => {
    if (pendingId) return;
    setPendingId(project.id);
    setMutationError("");
    setNotice("");
    try {
      await store.reopenWorkspace(project.id);
      setNotice(`Restored project ${project.label}.`);
      await refresh();
    } catch (cause) {
      setMutationError(messageFrom(cause));
      await refresh();
    } finally {
      setPendingId(undefined);
    }
  };
  const environmentOptions = new Map(environments.map(({ id, label }) => [id, label.text]));
  for (const project of projects) {
    if (!environmentOptions.has(project.environmentId)) environmentOptions.set(project.environmentId, `${project.environmentLabel} (unavailable)`);
  }
  const visible = projects.filter((project) => (!filter || project.environmentId === filter)
    && (status === "all" || (status === "removed" ? project.removed : !project.removed))
    && `${project.label} ${project.path} ${project.environmentLabel}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const activeFilters = Number(Boolean(filter)) + Number(status !== "all");
  const filtered = Boolean(search || activeFilters);
  const clear = () => { setSearch(""); setFilter(""); setStatus("all"); searchInput.current?.focus(); };
  return <SettingsPage width="wide" className="projects-settings" title="Projects" description="Directories remembered across your environments."
    actions={<>
      <Button type="button" variant="ghost" size="icon" aria-label="Refresh projects" title="Refresh" disabled={loading || Boolean(pendingId)} onClick={() => void refresh()}><RefreshCw /></Button>
      <Button type="button" aria-label="Add project" disabled={Boolean(pendingId) || !environments.length} onClick={() => setAddOpen(true)}><Plus />Add project</Button>
    </>}>
    {notice ? <Callout tone="success" role="status">{notice}</Callout> : null}
    {error ? <Callout tone="danger" role="alert" action={<Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>Retry</Button>}>{error}</Callout> : null}
    {mutationError ? <Callout tone="danger" role="alert">{mutationError}</Callout> : null}
    <section className="projects-list" aria-label="Remembered projects">
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
            value={status} onValueChange={setStatus}
            options={[{ value: "all", label: "All projects", pinned: true }, { value: "active", label: "Remembered projects" }, { value: "removed", label: "Removed projects" }]} />
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
        action={environments.length ? <Button type="button" variant="outline" onClick={() => setAddOpen(true)}><Plus />Add project</Button> : undefined} /> : null}
      {loaded && projects.length && !visible.length ? <EmptyState variant="inline" title="No projects match these filters." /> : null}
      {visible.length ? <ul className="projects-rows">{visible.map((project) => <li key={project.id} className="projects-row" data-removed={project.removed || undefined}>
        <span className="projects-row-icon" aria-hidden="true"><Folder /></span>
        <span className="projects-row-text">
          <span className="projects-row-title">{project.label}{project.removed ? <Tag>Removed</Tag> : null}</span>
          <span className="projects-row-path" title={project.path}>{project.path}</span>
          <span className="projects-row-meta">{project.environmentLabel} · {countLabel(project.threadCount, "thread")}</span>
        </span>
        <span className="projects-row-status">{project.available
          ? <StatusPill tone="success">Available</StatusPill> : <StatusPill tone="warning">Unavailable</StatusPill>}</span>
        <span className="projects-row-actions">
          <Button type="button" variant="outline" size="sm" disabled={Boolean(pendingId)} aria-label={`${project.removed ? "Restore" : "Remove"} project ${project.label}`}
            onClick={() => { setMutationError(""); if (project.removed) void restore(project); else setRemoving(project); }}>
            {pendingId === project.id ? "Saving…" : project.removed ? "Restore" : "Remove"}
          </Button>
        </span>
      </li>)}</ul> : null}
    </section>
    {addOpen && <AddProjectDialog store={store} environments={environments} initialEnvironmentId={filter || undefined}
      onClose={() => setAddOpen(false)} onAdded={(id, addedEnvironmentId) => {
        const restored = projects.find((project) => project.id === id && project.removed);
        setNotice(restored ? `Restored project ${restored.label}.` : "Project added."); setStatus("all"); setSearch("");
        if (filter && filter !== addedEnvironmentId) setFilter("");
        void refresh();
      }} />}
    <ConfirmDialog open={Boolean(removing)} onOpenChange={(open) => { if (!open) setRemoving(undefined); }}
      title={`Remove project ${removing?.label ?? ""}?`} confirmLabel="Remove project" pendingLabel="Removing…"
      description={`Hide this project and its ${countLabel(removing?.threadCount ?? 0, "thread")} from the working inventory. Files, conversation history, and saved application data are retained, and you can restore the project here. Stop running work, pause schedules, and end terminals before removal.`}
      onConfirm={async () => { if (removing) await remove(removing); }} {...focusReturn} />
  </SettingsPage>;
}
