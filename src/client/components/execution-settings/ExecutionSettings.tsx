import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../ui/dialog.js";
import { BackendEditor, type BackendDraft } from "./BackendEditor.js";
import { EnvironmentEditor } from "./EnvironmentEditor.js";
import { BackendInventory, EnvironmentInventory, InventoryToolbar, emptyFilters, environmentDescription, hostPresence, type InventoryFilters } from "./ExecutionInventory.js";
import { RuntimeControls } from "./RuntimeControls.js";
import { RecoveredOperations } from "./RecoveredOperations.js";
import { PendingHosts, HostConnectorSetup, hostPlatform } from "./PendingHosts.js";
import { useConfiguration, type ConfigurationControls } from "./useConfiguration.js";
import { useHostPairings, type HostPairingControls } from "./useHostPairings.js";
import { allowedEnvironments, backendEditors } from "./backend-editors.js";
import { SelectField, TextField, Toggle } from "./fields.js";
import { presentRuntime } from "./runtime-presentation.js";
import type { BackendDefinition, Configuration, EnvironmentDefinition } from "./types.js";
import "./execution-settings.css";

export type ExecutionPage = "environments" | "backends";
type View =
  | { readonly section: ExecutionPage; readonly kind: "list" }
  | { readonly section: "environments"; readonly kind: "environment"; readonly id: string; readonly tab: "backends" | "runtime" }
  | { readonly section: ExecutionPage; readonly kind: "backend"; readonly id: string }
  | { readonly section: "environments"; readonly kind: "environment-editor" | "add-environment" | "pair-host" | "pending-hosts" }
  | { readonly section: ExecutionPage; readonly kind: "backend-editor" }
  | { readonly section: "backends"; readonly kind: "research" | "default" };

export interface ExecutionSettingsNavigation {
  openPage(page: ExecutionPage): void;
  requestLeave(action: () => void): void;
  blocksNavigation(): boolean;
}

/** Configuration is principal-owned. Inventory filters and navigation are client-local.
 * There is exactly one configuration snapshot and one mounted lifecycle controller
 * per resource, independent of visible inventory, filters, or detail selection. */
export function ExecutionSettings({ controls, initialPage = "environments", onPageChange, navigationRef, visible = true }: {
  readonly controls: ConfigurationControls & HostPairingControls;
  readonly initialPage?: ExecutionPage;
  readonly onPageChange?: (page: ExecutionPage) => void;
  readonly navigationRef?: Ref<ExecutionSettingsNavigation>;
  readonly visible?: boolean;
}): React.JSX.Element {
  const [view, setView] = useState<View>({ section: initialPage, kind: "list" });
  const [environmentDraft, setEnvironmentDraft] = useState<{ value: EnvironmentDefinition; creating: boolean }>();
  const [backendDraft, setBackendDraft] = useState<BackendDraft>();
  const [research, setResearch] = useState<{ value: Configuration["webSearch"] }>();
  const [defaultDraft, setDefaultDraft] = useState<string>();
  const [pairingEditing, setPairingEditing] = useState(false);
  const [pairingEpoch, setPairingEpoch] = useState(0);
  const [confirmation, setConfirmation] = useState<{ kind: "remove-environment" | "remove-backend" | "pairing"; id: string; revision: number; pairingRevision?: number; revoke?: boolean }>();
  const [leaveAction, setLeaveAction] = useState<{ run: () => void }>();
  const [queuedLeave, setQueuedLeave] = useState<{ run: () => void; mutation: "configuration" | "pairing" }>();
  const [filters, setFilters] = useState<Record<string, InventoryFilters>>({});
  const initialDraft = useRef("");
  const editorReturn = useRef<View>({ section: initialPage, kind: "list" });
  const backendReturn = useRef<View>({ section: initialPage, kind: "list" });
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const focusResource = useRef<string | undefined>(undefined);
  const previousView = useRef(view);
  const discarded = useRef(false);
  const destinationOwnsFocus = useRef(false);
  const destinationFocus = useRef<HTMLElement | null>(null);
  const confirmationElement = useRef<HTMLElement>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const restoreConfirmationFocus = useRef(false);
  const editing = Boolean(environmentDraft || backendDraft || research || defaultDraft !== undefined || pairingEditing);
  const state = useConfiguration(controls, editing || Boolean(confirmation), visible);
  const pairing = useHostPairings(controls, state.refresh, visible);
  const snapshot = state.snapshot;
  const configuration = snapshot?.configuration;
  const pending = state.loading || state.saving || state.needsRefresh || pairing.busy;
  const draftText = JSON.stringify(environmentDraft ?? backendDraft ?? research ?? defaultDraft ?? null);
  const dirty = pairingEditing || (editing && draftText !== initialDraft.current);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const viewKey = JSON.stringify(view);
  const filterKey = view.kind === "environment" ? `environment:${view.id}` : view.section;
  const currentFilters = filters[filterKey] ?? emptyFilters;
  const setCurrentFilters = (next: InventoryFilters) => setFilters(current => ({ ...current, [filterKey]: next }));

  const clearEditors = () => {
    setEnvironmentDraft(undefined); setBackendDraft(undefined); setResearch(undefined); setDefaultDraft(undefined);
    setPairingEditing(false); setPairingEpoch(value => value + 1); setConfirmation(undefined);
  };
  const go = (next: View, returnFocus?: string) => {
    destinationOwnsFocus.current = true;
    destinationFocus.current = null;
    const scroll = root.current?.closest(".settings-content");
    scrollPositions.current.set(viewKey, scroll?.scrollTop ?? 0);
    focusResource.current = returnFocus;
    setView(next); onPageChange?.(next.section);
  };
  const requestLeave = (action: () => void) => {
    if (state.saving || pairing.busy) { setQueuedLeave({ run: action, mutation: state.saving ? "configuration" : "pairing" }); return; }
    const run = () => { clearEditors(); action(); };
    if (dirty) setLeaveAction({ run }); else run();
  };
  useEffect(() => {
    if (queuedLeave && !state.saving && !pairing.busy) {
      setQueuedLeave(undefined);
      const succeeded = queuedLeave.mutation === "configuration" ? state.lastSaveSucceeded : pairing.lastMutationSucceeded;
      if (succeeded) requestLeave(queuedLeave.run);
      else heading.current?.focus({ preventScroll: true });
    }
  }, [queuedLeave, state.saving, state.lastSaveSucceeded, pairing.busy, pairing.lastMutationSucceeded]);
  const navigate = (next: View) => requestLeave(() => go(next));
  useImperativeHandle(navigationRef, () => ({
    openPage: page => navigate({ section: page, kind: "list" }),
    requestLeave,
    blocksNavigation: () => dirty || state.saving || pairing.busy,
  }));
  useLayoutEffect(() => {
    const prior = previousView.current;
    previousView.current = view;
    if (!visible) return;
    const scroll = root.current?.closest(".settings-content");
    if (scroll) scroll.scrollTop = scrollPositions.current.get(viewKey) ?? 0;
    // Environment tabs are navigation controls: activating one keeps its focus.
    if (prior.kind === "environment" && view.kind === "environment" && prior.id === view.id && prior.tab !== view.tab) return;
    const target = focusResource.current ? Array.from(root.current?.querySelectorAll<HTMLElement>("[data-resource-id]") ?? []).find(entry => entry.dataset.resourceId === focusResource.current) : undefined;
    destinationFocus.current = target ?? (!editing ? heading.current : null);
    destinationFocus.current?.focus({ preventScroll: true });
    focusResource.current = undefined;
  }, [viewKey, visible]);
  useEffect(() => {
    if (confirmation) confirmationElement.current?.focus();
    else if (restoreConfirmationFocus.current) {
      restoreConfirmationFocus.current = false;
      if (queuedLeave) return; // The queued destination owns the next focus change.
      const trigger = confirmationTrigger.current;
      if (trigger?.isConnected && !trigger.closest("[hidden]") && !trigger.matches(":disabled")) trigger.focus();
      else if (visible) heading.current?.focus({ preventScroll: true });
    }
  }, [confirmation]);
  const cancelConfirmation = () => {
    restoreConfirmationFocus.current = true;
    setConfirmation(undefined);
  };

  const openEnvironment = (environment: EnvironmentDefinition, tab: "backends" | "runtime" = "backends") => navigate({ section: "environments", kind: "environment", id: environment.id, tab });
  const openBackend = (backend: BackendDefinition) => {
    backendReturn.current = view;
    navigate({ section: view.section, kind: "backend", id: backend.id });
  };
  const editEnvironment = (environment: EnvironmentDefinition, creating = false) => {
    requestLeave(() => {
      editorReturn.current = view;
      const draft = { value: structuredClone(environment), creating };
      initialDraft.current = JSON.stringify(draft); setEnvironmentDraft(draft);
      go({ section: "environments", kind: "environment-editor" });
    });
  };
  const editBackend = (backend: BackendDefinition) => {
    if (!configuration) return;
    requestLeave(() => {
      editorReturn.current = view;
      const draft: BackendDraft = { creating: false, backend: structuredClone(backend), targets: structuredClone(configuration.targets.filter(entry => entry.backendInstanceId === backend.id)), defaultTargetId: configuration.defaultTargetId };
      initialDraft.current = JSON.stringify(draft); setBackendDraft(draft);
      go({ section: view.section, kind: "backend-editor" });
    });
  };
  const createBackend = (environmentId?: string) => {
    if (!configuration) return;
    requestLeave(() => {
      editorReturn.current = view;
      const backend = backendEditors.codex_app_server.createBackend(crypto.randomUUID());
      const target = backendEditors.codex_app_server.createTarget(crypto.randomUUID(), backend.id, environmentId ?? "");
      const draft: BackendDraft = { creating: true, backend, targets: [target], defaultTargetId: configuration.defaultTargetId ?? target.id };
      initialDraft.current = JSON.stringify(draft); setBackendDraft(draft);
      go({ section: view.section, kind: "backend-editor" });
    });
  };
  const closeEditor = (resourceId?: string) => { clearEditors(); go(editorReturn.current, resourceId); };
  const saveEnvironment = async () => {
    if (!configuration || !environmentDraft) return;
    const { value, creating } = environmentDraft;
    if (await state.save({ ...configuration, executionEnvironments: creating ? [...configuration.executionEnvironments, value] : configuration.executionEnvironments.map(entry => entry.id === value.id ? value : entry) })) {
      clearEditors(); go({ section: "environments", kind: "environment", id: value.id, tab: "backends" });
    }
  };
  const saveBackend = async () => {
    if (!configuration || !backendDraft) return;
    const { backend, targets, creating, defaultTargetId } = backendDraft;
    if (await state.save({ ...configuration,
      backends: creating ? [...configuration.backends, backend] : configuration.backends.map(entry => entry.id === backend.id ? backend : entry),
      targets: [...configuration.targets.filter(entry => entry.backendInstanceId !== backend.id), ...targets], defaultTargetId,
    })) closeEditor(backend.id);
  };
  const confirmChange = async () => {
    if (!configuration || !confirmation || confirmation.revision !== snapshot?.revision || pending) return;
    if (confirmation.kind === "pairing") {
      const request = { mutationId: crypto.randomUUID(), pairingId: confirmation.id, expectedPairingRevision: confirmation.pairingRevision!, expectedConfigurationRevision: confirmation.revision };
      if (await pairing.mutate(() => confirmation.revoke ? controls.revokeHostPairing(request) : controls.reapproveHostPairing(request), true)) cancelConfirmation();
      return;
    }
    let next: Configuration;
    if (confirmation.kind === "remove-environment") next = { ...configuration, executionEnvironments: configuration.executionEnvironments.filter(entry => entry.id !== confirmation.id) };
    else {
      const removed = new Set(configuration.targets.filter(entry => entry.backendInstanceId === confirmation.id).map(entry => entry.id));
      next = { ...configuration, backends: configuration.backends.filter(entry => entry.id !== confirmation.id), targets: configuration.targets.filter(entry => !removed.has(entry.id)), defaultTargetId: removed.has(configuration.defaultTargetId ?? "") ? null : configuration.defaultTargetId };
    }
    if (await state.save(next)) { setConfirmation(undefined); go(confirmation.kind === "remove-environment" ? { section: "environments", kind: "list" } : backendReturn.current); }
  };

  const selectedEnvironment = view.kind === "environment" ? configuration?.executionEnvironments.find(entry => entry.id === view.id) : undefined;
  const selectedBackend = view.kind === "backend" ? configuration?.backends.find(entry => entry.id === view.id) : undefined;
  const selectedBackendEnvironment = selectedBackend ? configuration?.executionEnvironments.find(entry => configuration.targets.some(target => target.backendInstanceId === selectedBackend.id && target.executionEnvironmentId === entry.id)) : undefined;
  const pendingHosts = pairing.hosts?.registrations.filter(entry => entry.state === "pending").length ?? 0;
  const title = view.kind === "list" ? (view.section === "environments" ? "Execution environments" : "Backends")
    : view.kind === "environment" ? selectedEnvironment?.label ?? "Environment unavailable"
    : view.kind === "backend" ? selectedBackend?.label ?? "Backend unavailable"
    : view.kind === "environment-editor" ? (environmentDraft?.creating ? "New environment" : `Edit ${environmentDraft?.value.label ?? "environment"}`)
    : view.kind === "backend-editor" ? (backendDraft?.creating ? "New backend" : `Edit ${backendDraft?.backend.label ?? "backend"}`)
    : view.kind === "add-environment" ? "Add environment" : view.kind === "pair-host" ? "Pair a host"
    : view.kind === "pending-hosts" ? "Pending hosts" : view.kind === "default" ? "Default connection" : "Research provider settings";
  const description = selectedEnvironment ? environmentDescription(selectedEnvironment)
    : selectedBackend ? `${backendEditors[selectedBackend.kind].label} · ${selectedBackendEnvironment?.label ?? "Environment unavailable"}`
    : view.kind === "list" && view.section === "environments" ? "Choose an environment to manage its backends and workspace access."
    : view.kind === "list" ? "Browse provider configurations across your environments." : undefined;
  const addBackendButton = (environmentId?: string) => <Button size="sm" aria-label="Add backend" disabled={!configuration || pending || configuration.backends.length >= 32 || configuration.executionEnvironments.length === 0}
    onClick={() => createBackend(environmentId)}><span>Add<span className="execution-settings-add-kind"> backend</span></span></Button>;
  const backendInventory = (environmentId?: string) => snapshot ? <>
    <InventoryToolbar kind="backends" filters={currentFilters} onChange={setCurrentFilters} environments={snapshot.configuration.executionEnvironments} scoped={Boolean(environmentId)} />
    <BackendInventory snapshot={snapshot} filters={currentFilters} disabled={pending} environmentId={environmentId} onOpen={openBackend} onEdit={editBackend} onEnvironment={openEnvironment} />
  </> : null;
  const refresh = () => {
    if (editing && !state.needsRefresh) {
      void state.refreshRuntime(); void pairing.refresh();
    } else requestLeave(() => { if (editing) go(editorReturn.current); void state.refresh(); void pairing.refresh(); });
  };
  const goBack = () => {
    if (editing) requestLeave(() => go(editorReturn.current, environmentDraft?.value.id ?? backendDraft?.backend.id));
    else if (view.kind === "backend") requestLeave(() => go(backendReturn.current, view.id));
    else if (view.kind === "environment") requestLeave(() => go({ section: "environments", kind: "list" }, view.id));
    else navigate({ section: view.section, kind: "list" });
  };
  const pausedReason = state.needsRefresh ? "Refresh the configuration before issuing runtime commands." : editing ? "Runtime controls are paused while configuration is being edited." : state.loading || state.saving ? "Runtime controls are paused while configuration is loading or saving." : undefined;

  return <div ref={root} className="execution-settings-page" data-view={view.kind}>
    {view.kind !== "list" ? <Button className="execution-settings-back" variant="ghost" size="sm" disabled={state.saving || pairing.busy} onClick={goBack}><ArrowLeft size={14} />{view.kind === "backend" && backendReturn.current.kind === "environment" ? "Back to environment" : "Back"}</Button> : null}
    <header className="execution-settings-header"><div><h3 ref={heading} tabIndex={-1} className="settings-page-title">{title}</h3>{description ? <p>{description}</p> : null}</div>
      <div className="execution-settings-actions">
        <Button className="execution-settings-refresh" size="sm" variant="outline" disabled={state.loading || state.saving || pairing.busy} onClick={refresh}><RefreshCw size={15} aria-hidden="true" /><span>Refresh</span></Button>
        {view.kind === "list" && view.section === "environments" ? <Button size="sm" aria-label="Add environment" disabled={!configuration || pending || configuration.executionEnvironments.length >= 16} onClick={() => navigate({ section: "environments", kind: "add-environment" })}><span>Add<span className="execution-settings-add-kind"> environment</span></span></Button> : null}
        {view.kind === "list" && view.section === "backends" ? addBackendButton(currentFilters.environment || undefined) : null}
        {selectedEnvironment ? <Button size="sm" variant="outline" disabled={pending} data-resource-id={selectedEnvironment.id} aria-label={`Edit ${selectedEnvironment.label}`} onClick={() => editEnvironment(selectedEnvironment)}>Edit configuration</Button> : null}
        {selectedBackend ? <Button size="sm" variant="outline" disabled={pending} data-resource-id={selectedBackend.id} aria-label={`Edit ${selectedBackend.label}`} onClick={() => editBackend(selectedBackend)}>Edit configuration</Button> : null}
      </div>
    </header>
    {state.loading ? <p role="status">Loading execution configuration…</p> : null}
    {queuedLeave ? <div className="execution-settings-actions"><p role="status">Waiting for the current save to finish before leaving.</p><Button size="sm" variant="ghost" onClick={() => { setQueuedLeave(undefined); heading.current?.focus({ preventScroll: true }); }}>Stay here</Button></div>
      : state.saving || pairing.busy ? <p role="status">Saving changes…</p> : null}
    {state.error ? <p role="alert" className="execution-settings-error">{state.error}</p> : null}
    {state.notice ? <p role="status" className="execution-settings-notice">{state.notice}</p> : null}
    {pairing.error ? <p role="alert" className="execution-settings-error">{pairing.error}</p> : null}
    {configuration && snapshot ? <>
      {view.kind === "list" && view.section === "environments" ? <>
        {pendingHosts > 0 ? <div className="execution-settings-attention"><span>{pendingHosts} host{pendingHosts === 1 ? "" : "s"} awaiting approval</span><Button size="sm" variant="link" onClick={() => navigate({ section: "environments", kind: "pending-hosts" })}>Review hosts</Button></div> : null}
        <InventoryToolbar kind="environments" filters={currentFilters} onChange={setCurrentFilters} environments={configuration.executionEnvironments} />
        <EnvironmentInventory snapshot={snapshot} filters={currentFilters} disabled={pending} hosts={pairing.hosts} stale={pairing.stale} onOpen={openEnvironment} onEdit={editEnvironment} onRuntime={environment => openEnvironment(environment, "runtime")} />
      </> : null}
      {view.kind === "list" && view.section === "backends" ? <>
        {backendInventory()}
        <section className="execution-settings-preference"><div><h4>Default connection for new threads</h4><p>{connectionLabel(configuration, configuration.defaultTargetId)}</p></div><Button size="sm" variant="outline" disabled={pending} onClick={() => {
          editorReturn.current = view; const value = configuration.defaultTargetId ?? ""; initialDraft.current = JSON.stringify(value); setDefaultDraft(value); go({ section: "backends", kind: "default" });
        }}>Change default</Button></section>
        <section className="execution-settings-preference"><div><h4>Research provider</h4><p>Local research tool on the Sedes host.</p></div><Button size="sm" variant="outline" disabled={pending} onClick={() => {
          editorReturn.current = view; const draft = { value: structuredClone(configuration.webSearch) }; initialDraft.current = JSON.stringify(draft); setResearch(draft); go({ section: "backends", kind: "research" });
        }}>Research provider settings</Button></section>
      </> : null}
      {selectedEnvironment && view.kind === "environment" ? <>
        <dl className="execution-settings-overview"><div><dt>Host connection</dt><dd>{hostPresence(selectedEnvironment, pairing.hosts, pairing.stale)}</dd></div><div><dt>Backends</dt><dd>{new Set(configuration.targets.filter(entry => entry.executionEnvironmentId === selectedEnvironment.id).map(entry => entry.backendInstanceId)).size} configured</dd></div></dl>
        <nav className="execution-settings-tabs" aria-label="Environment sections">
          <Button variant="ghost" aria-current={view.tab === "backends" ? "page" : undefined} onClick={() => navigate({ ...view, tab: "backends" })}>Backends</Button>
          <Button variant="ghost" disabled={pending} onClick={() => editEnvironment(selectedEnvironment)}>Configuration</Button>
          <Button variant="ghost" aria-current={view.tab === "runtime" ? "page" : undefined} onClick={() => navigate({ ...view, tab: "runtime" })}>Activity & diagnostics</Button>
        </nav>
        {view.tab === "backends" ? <><div className="execution-settings-subheader"><h4>Associated backends</h4>{addBackendButton(selectedEnvironment.id)}</div>{backendInventory(selectedEnvironment.id)}</> : null}
      </> : null}
      {view.kind === "add-environment" ? <div className="execution-settings-choices">
        <Choice title="Local machine" disabled={configuration.executionEnvironments.some(entry => entry.kind === "local")} onClick={() => editEnvironment({ id: crypto.randomUUID(), label: "", kind: "local", workspaceRoots: [], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }, true)}>Workspace access on the Sedes host. One local environment per account.</Choice>
        <Choice title="SSH host" onClick={() => editEnvironment({ id: crypto.randomUUID(), label: "", kind: "ssh", hostAlias: "", workspaceRoots: [], operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files"] } }, true)}>Connect using an SSH alias configured on the Sedes server.</Choice>
        <Choice title="Pair a host" onClick={() => navigate({ section: "environments", kind: "pair-host" })}>Let a remote connector connect to Sedes, then approve its workspace access.</Choice>
      </div> : null}
      {view.kind === "pair-host" ? <HostConnectorSetup controls={controls} /> : null}
      {view.kind === "pair-host" || view.kind === "pending-hosts" ? <PendingHosts key={pairingEpoch} registrations={pairing.hosts?.registrations ?? []} controls={controls} revision={snapshot.revision} disabled={pending || pairing.stale} mutate={pairing.mutate} onEditing={active => { if (active) editorReturn.current = view; setPairingEditing(active); }} /> : null}
      {environmentDraft && view.kind === "environment-editor" ? <EnvironmentEditor draft={environmentDraft.value} creating={environmentDraft.creating} setDraft={value => setEnvironmentDraft({ ...environmentDraft, value })} configuration={configuration} pending={pending} saving={state.saving} loading={state.loading} onSave={saveEnvironment} onCancel={() => closeEditor(environmentDraft.value.id)} /> : null}
      {backendDraft && view.kind === "backend-editor" ? <BackendEditor draft={backendDraft} setDraft={setBackendDraft} configuration={configuration} pending={pending} saving={state.saving} loading={state.loading} onSave={saveBackend} onCancel={() => closeEditor(backendDraft.backend.id)} /> : null}
      {view.kind === "default" && defaultDraft !== undefined ? <form className="execution-settings-editor" onSubmit={event => { event.preventDefault(); void state.save({ ...configuration, defaultTargetId: defaultDraft || null }).then(saved => { if (saved) closeEditor(); }); }}>
        <SelectField autoFocus label="Default connection for new threads" value={defaultDraft} disabled={state.saving}
          options={[{ value: "", label: "No default — choose a connection" }, ...configuration.targets.filter(target => target.enabled && configuration.backends.some(backend => backend.id === target.backendInstanceId && backend.enabled)).map(target => ({ value: target.id, label: connectionLabel(configuration, target.id) }))]} onChange={setDefaultDraft} />
        <p className="execution-settings-muted">Applies across all environments for this account.</p><SaveBar label="Save default" pending={pending} saving={state.saving} onCancel={() => closeEditor()} />
      </form> : null}
      {view.kind === "research" && research ? <form className="execution-settings-editor" onSubmit={event => { event.preventDefault(); void state.save({ ...configuration, webSearch: research.value }).then(saved => { if (saved) closeEditor(); }); }}>
        <fieldset disabled={state.saving || state.loading}><legend>Local research tool</legend><Toggle autoFocus label="Enable Grok CLI research" checked={research.value !== null} onChange={enabled => setResearch({ value: enabled ? { provider: "grok_cli" } : null })} />
          {research.value ? <TextField label="Grok home directory" value={research.value.grokHome ?? ""} description="Optional native configuration directory on the Sedes host. Authentication remains host-managed." onChange={grokHome => setResearch({ value: { provider: "grok_cli", grokHome: grokHome || undefined } })} /> : null}
        </fieldset><SaveBar label="Save research settings" pending={pending} saving={state.saving} onCancel={() => closeEditor()} />
      </form> : null}
      {/* Never unmount a retained resource because navigation or a filter hides it. */}
      {configuration.executionEnvironments.map(environment => {
        const visible = view.kind === "environment" && view.id === environment.id && view.tab === "runtime";
        const runtime = snapshot.runtimes.find(entry => entry.resourceKind === "environment" && entry.resourceId === environment.id);
        const binding = environment.kind === "outbound" ? pairing.hosts?.pairings.find(entry => entry.id === environment.pairingId) : undefined;
        const referenced = configuration.targets.some(entry => entry.executionEnvironmentId === environment.id);
        return <section key={environment.id} hidden={!visible} className="execution-settings-detail" aria-label={`${environment.label} activity`}>
          <RuntimeControls controls={controls} revision={snapshot.revision} resourceKind="environment" resourceId={environment.id} label={environment.label} runtime={runtime} showSidecar={environment.kind !== "local"} disabled={pending || editing} disabledReason={pausedReason} onRuntime={state.updateRuntime} onRefresh={state.refreshRuntime} />
          <div className="execution-settings-detail-actions">
            {environment.kind !== "local" ? <RecoveredOperations controls={controls} environmentId={environment.id} label={environment.label} disabled={pending || editing} emphasized={presentRuntime(runtime, { resourceKind: "environment", sidecar: true }).recoveryEmphasis} /> : null}
            {binding ? <Button size="sm" variant="outline" disabled={pending || pairing.stale} aria-label={`${binding.state === "revoked" ? "Reapprove" : "Revoke"} ${environment.label}`} onClick={event => { confirmationTrigger.current = event.currentTarget; setConfirmation({ kind: "pairing", id: binding.id, revision: snapshot.revision, pairingRevision: binding.revision, revoke: binding.state !== "revoked" }); }}>{binding.state === "revoked" ? "Reapprove pairing" : "Revoke pairing"}</Button> : null}
            <Button size="sm" variant="outline" disabled={pending || referenced || (environment.kind === "outbound" && binding?.state !== "revoked")} aria-label={`Remove ${environment.label}`} onClick={event => { confirmationTrigger.current = event.currentTarget; setConfirmation({ kind: "remove-environment", id: environment.id, revision: snapshot.revision }); }}>Remove environment</Button>
          </div>
          {referenced ? <p className="execution-settings-muted">Referenced by backend connections. <button className="execution-settings-inline-link" onClick={() => openEnvironment(environment)}>View associated backends</button> before removing this environment.</p> : null}
          {environment.kind === "outbound" && binding?.state !== "revoked" ? <p className="execution-settings-muted">Revoke the pairing before removing this environment.</p> : null}
          {environment.kind === "outbound" ? <section className="execution-settings-card"><h4>Host connection</h4><p>{hostPresence(environment, pairing.hosts, pairing.stale)} · {hostPlatform(environment.platform)}</p>
            {binding ? <><p>{binding.metadata.hostname} · {binding.metadata.architecture} · {binding.metadata.account} · Connector {binding.metadata.connectorVersion}</p><p>Paired installation: {binding.connectorId}</p><p>Last seen {new Date(binding.lastSeenAt).toLocaleString()}. Host presence is separate from runtime availability.</p></> : null}
          </section> : null}
        </section>;
      })}
      {configuration.backends.map(backend => {
        const runtime = snapshot.runtimes.find(entry => entry.resourceKind === "backend" && entry.resourceId === backend.id);
        const targets = configuration.targets.filter(entry => entry.backendInstanceId === backend.id);
        const environment = configuration.executionEnvironments.find(entry => entry.id === targets[0]?.executionEnvironmentId);
        const unsupported = Boolean(environment && !allowedEnvironments(backend, [environment]).length);
        return <section key={backend.id} hidden={view.kind !== "backend" || view.id !== backend.id} className="execution-settings-detail" aria-label={`${backend.label} overview`}>
          {unsupported ? <p role="status">Remote execution is unsupported. This retained configuration cannot run here.</p> : null}
          <RuntimeControls controls={controls} revision={snapshot.revision} resourceKind="backend" resourceId={backend.id} label={backend.label} runtime={runtime} enabled={backend.enabled} disabled={pending || editing || unsupported} disabledReason={unsupported ? "Remote execution is unsupported for this backend." : pausedReason} onRuntime={state.updateRuntime} onRefresh={state.refreshRuntime} />
          <section className="execution-settings-card"><h4>Connections and defaults</h4><p>{backendEditors[backend.kind].description}</p><ul className="execution-settings-connections">{targets.map(target => <li key={target.id}><strong>{target.label}</strong><span>{environment?.label} · {target.enabled ? "Enabled" : "Disabled"}{configuration.defaultTargetId === target.id ? " · Default for new threads" : ""}</span></li>)}</ul></section>
          <div className="execution-settings-detail-actions"><Button size="sm" variant="outline" disabled={pending} aria-label={`Remove ${backend.label}`} onClick={event => { confirmationTrigger.current = event.currentTarget; setConfirmation({ kind: "remove-backend", id: backend.id, revision: snapshot.revision }); }}>Remove backend</Button></div>
        </section>;
      })}
      {confirmation ? <section ref={confirmationElement} tabIndex={-1} className="execution-settings-confirmation" role="group" aria-label="Confirm configuration change">
        <p>{confirmation.kind === "pairing" ? confirmation.revoke
          ? "Revoke this installation’s connection to Sedes? The environment and history are retained. This disconnects access but does not stop host-owned processes. Stop running work first if you want it terminated."
          : "Allow this same connector installation to reconnect with this environment’s saved roots and grants? After reapproval, generate a fresh sidecar pairing code on the Sedes server, then restart the connector with --pairing-code CODE --resume-pairing and the same state directory."
          : confirmation.kind === "remove-backend" ? "Remove this backend and its connection definitions? Existing threads and history are retained. Running work may prevent removal." : "Remove this environment definition? Existing sessions and history are retained. Running work may prevent removal."}</p>
        <div className="execution-settings-actions"><Button size="sm" variant="destructive" disabled={pending || snapshot.revision !== confirmation.revision || (confirmation.kind === "pairing" && pairing.stale)} onClick={() => void confirmChange()}>Confirm {confirmation.kind === "pairing" ? confirmation.revoke ? "revocation" : "reapproval" : "removal"}</Button><Button size="sm" variant="outline" disabled={state.saving || pairing.busy} onClick={cancelConfirmation}>Cancel</Button></div>
      </section> : null}
    </> : null}
    <Dialog open={Boolean(leaveAction)} onOpenChange={open => { if (!open) setLeaveAction(undefined); }}><DialogContent className="execution-settings-leave-dialog" onCloseAutoFocus={event => {
      if (discarded.current) {
        event.preventDefault();
        // The destination rendered while the nested dialog still owned focus.
        // Reapply its target after that dialog's focus trap has been removed.
        if (destinationOwnsFocus.current) destinationFocus.current?.focus({ preventScroll: true });
      }
      discarded.current = false;
    }}><DialogTitle>Discard unsaved changes?</DialogTitle><DialogDescription>Your edits have not been saved. Discard them to continue, or keep editing.</DialogDescription><div className="execution-settings-actions"><Button variant="outline" onClick={() => setLeaveAction(undefined)}>Keep editing</Button><Button variant="destructive" onClick={() => { const action = leaveAction; discarded.current = true; destinationOwnsFocus.current = false; setLeaveAction(undefined); action?.run(); }}>Discard changes</Button></div></DialogContent></Dialog>
  </div>;
}

function connectionLabel(configuration: Configuration, targetId: string | null): string {
  const target = configuration.targets.find(entry => entry.id === targetId);
  if (!target) return "No default — choose a connection";
  const environment = configuration.executionEnvironments.find(entry => entry.id === target.executionEnvironmentId);
  const backend = configuration.backends.find(entry => entry.id === target.backendInstanceId);
  return `${environment?.label ?? "Environment unavailable"} / ${backend?.label ?? "Backend unavailable"} / ${target.label}`;
}

function SaveBar({ label, pending, saving, onCancel }: { readonly label: string; readonly pending: boolean; readonly saving: boolean; readonly onCancel: () => void }): React.JSX.Element {
  return <div className="execution-settings-actions execution-settings-save-bar"><Button type="submit" size="sm" disabled={pending}>{label}</Button><Button type="button" size="sm" variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button></div>;
}

function Choice({ title, disabled, onClick, children }: { readonly title: string; readonly disabled?: boolean; readonly onClick: () => void; readonly children: ReactNode }): React.JSX.Element {
  return <button className="execution-settings-choice" disabled={disabled} onClick={onClick}><strong>{title}</strong><span>{children}</span></button>;
}
