import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import type { ProjectSummary } from "../../../shared/index.js";
import { useApplicationStore, messageFrom, type ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { AddProjectDialog } from "../AddProjectDialog.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { SearchableSelect } from "../ui/searchable-select.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../ui/dialog.js";
import "./execution-settings.css";

export function ProjectsSettingsPage({ store }: {
  readonly store: ApplicationClientStore;
}): React.JSX.Element {
  const application = useApplicationStore(store);
  const environments = application.snapshot?.environments ?? [];
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingId, setPendingId] = useState<string>();
  const [removing, setRemoving] = useState<ProjectSummary>();
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterPanelId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const filterToggle = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
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
      if (!controller.signal.aborted) setProjects(result.projects);
    } catch (cause) {
      if (!controller.signal.aborted) setError(messageFrom(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [store]);
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh, publication]);
  const mutate = async (project: ProjectSummary, action: "remove" | "restore") => {
    if (pendingId) return;
    setPendingId(project.id);
    setMutationError("");
    setNotice("");
    try {
      if (action === "remove") await store.api.removeProject(project.id, { expectedRevision: project.revision });
      else await store.reopenWorkspace(project.id);
      setRemoving(undefined);
      setNotice(action === "restore" ? `Restored project ${project.label}.` : `Removed project ${project.label}. Files and history are retained.`);
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
  return <div className="execution-settings-page" data-view="list">
    <header className="execution-settings-header"><div><h3 className="settings-page-title" tabIndex={-1}>Projects</h3><p>Manage remembered directories across your environments.</p></div>
      <div className="execution-settings-actions">
        <Button className="execution-settings-refresh" size="sm" variant="outline" disabled={loading || Boolean(pendingId)} onClick={() => void refresh()} aria-label="Refresh projects"><RefreshCw size={15} aria-hidden="true" /><span>Refresh</span></Button>
        <Button size="sm" aria-label="Add project" disabled={Boolean(pendingId) || !environments.length} onClick={() => setAddOpen(true)}><span>Add<span className="execution-settings-add-kind"> project</span></span></Button>
      </div>
    </header>
    <div className="execution-inventory-toolbar">
      <div className="execution-inventory-search"><Search size={15} aria-hidden="true" />
        <Input ref={searchInput} aria-label="Search projects" placeholder="Search projects…" value={search} onChange={event => setSearch(event.currentTarget.value)} />
      </div>
      <Button ref={filterToggle} className="execution-inventory-filter-toggle" size="sm" variant="outline"
        aria-expanded={filtersOpen} aria-controls={filterPanelId} onClick={() => setFiltersOpen(open => !open)}>
        <SlidersHorizontal size={15} aria-hidden="true" />Filters{activeFilters ? ` (${activeFilters})` : ""}
      </Button>
      <div id={filterPanelId} className="execution-inventory-filters" data-expanded={filtersOpen}>
        <div className="execution-inventory-filter"><span>Environment</span><SearchableSelect label="Project environment" searchLabel="Search environments" emptyLabel="No matching environments"
          value={filter} onValueChange={setFilter} triggerProps={{ className: "projects-settings-filter" }}
          options={[{ value: "", label: "All environments", pinned: true }, ...Array.from(environmentOptions).sort((left, right) => left[1].localeCompare(right[1])).map(([value, label]) => ({ value, label }))]} />
        </div>
        <div className="execution-inventory-filter"><span>Status</span><SearchableSelect label="Project status" searchLabel="Search project statuses" emptyLabel="No matching statuses"
          value={status} onValueChange={setStatus} triggerProps={{ className: "projects-settings-filter" }}
          options={[{ value: "all", label: "All projects", pinned: true }, { value: "active", label: "Remembered projects" }, { value: "removed", label: "Removed projects" }]} />
        </div>
        <Button className="execution-inventory-filter-done" size="sm" onClick={() => { setFiltersOpen(false); filterToggle.current?.focus(); }}>Show results</Button>
      </div>
      {search || activeFilters ? <Button size="sm" variant="ghost" className="execution-inventory-clear" onClick={() => {
        setSearch(""); setFilter(""); setStatus("all"); searchInput.current?.focus();
      }}>Clear filters</Button> : null}
    </div>
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">Loading projects…</p>}
    {error && <p role="alert" className="execution-settings-error">{error}</p>}
    {mutationError && !removing && <p role="alert" className="execution-settings-error">{mutationError}</p>}
    {!loading && !error && <p className="execution-settings-muted" role="status">{visible.length} of {projects.length} projects</p>}
    {!loading && !error && !visible.length && <p>{projects.length ? "No projects match these filters." : "No projects yet. Add a directory to start a thread."}</p>}
    <ul className="projects-settings-list">{visible.map((project) => <li key={project.id}>
      <div className="projects-settings-description"><strong>{project.label}</strong><span className="projects-settings-path">{project.path}</span><small>{project.environmentLabel} · {project.removed ? "Removed" : project.available ? "Available" : "Unavailable"}{project.removed && !project.available ? " · Unavailable" : ""} · {project.threadCount} thread{project.threadCount === 1 ? "" : "s"}</small></div>
      <Button variant="outline" size="sm" disabled={Boolean(pendingId)} aria-label={`${project.removed ? "Restore" : "Remove"} project ${project.label}`}
        onClick={() => { setMutationError(""); if (project.removed) void mutate(project, "restore"); else setRemoving(project); }}>
        {pendingId === project.id ? "Saving…" : project.removed ? "Restore" : "Remove"}
      </Button>
    </li>)}</ul>
    {addOpen && <AddProjectDialog store={store} environments={environments} initialEnvironmentId={filter || undefined}
      onClose={() => setAddOpen(false)} onAdded={(id, addedEnvironmentId) => {
        const restored = projects.find((project) => project.id === id && project.removed);
        setNotice(restored ? `Restored project ${restored.label}.` : "Project added."); setStatus("all"); setSearch("");
        if (filter && filter !== addedEnvironmentId) setFilter("");
        void refresh();
      }} />}
    <Dialog open={Boolean(removing)} onOpenChange={(open) => { if (!open && !pendingId) { setRemoving(undefined); setMutationError(""); } }}>
      <DialogContent className="projects-settings-removal"><DialogTitle>Remove project {removing?.label}?</DialogTitle>
        <DialogDescription>Hide this project and its {removing?.threadCount ?? 0} thread{removing?.threadCount === 1 ? "" : "s"} from the working inventory. Files, conversation history, and saved application data are retained. You can restore the project here. Stop running work, pause schedules, and end terminals before removal.</DialogDescription>
        {mutationError && <p role="alert" className="execution-settings-error">{mutationError}</p>}
        <div className="execution-settings-actions"><Button variant="outline" disabled={Boolean(pendingId)} onClick={() => setRemoving(undefined)}>Cancel</Button>
          <Button variant="destructive" disabled={Boolean(pendingId)} onClick={() => { if (removing) void mutate(removing, "remove"); }}>Remove project</Button></div>
      </DialogContent>
    </Dialog>
  </div>;
}
