import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Plus, RefreshCw, Server } from "lucide-react";
import { acceptHostRegistrationRequestSchema } from "../../../shared/protocol/host-pairing.js";
import { historyStepsBackTo, installNavigationBlocker, navigate, settingsPath, useRoute, type Route } from "../../app/router.js";
import { settingsResourceParent, type SettingsPage as SettingsPageId, type SettingsResourceMode } from "../../app/settings-route.js";
import { EntityList } from "../settings/EntityList.js";
import { SettingsBackLink, SettingsPage } from "../settings/SettingsPage.js";
import { SettingsDetailHeader, SettingsSplit } from "../settings/SettingsSplit.js";
import { useFocusReturn } from "../settings/use-focus-return.js";
import { useSettingsSplitFocus } from "../settings/use-settings-split-focus.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { DiscardChangesDialog } from "../ui/discard-changes-dialog.js";
import { EmptyState } from "../ui/empty-state.js";
import { Skeleton } from "../ui/skeleton.js";
import { BackendDefaults, defaultsFields, defaultsOf, type DefaultsDraft } from "./BackendDefaults.js";
import { BackendDetail } from "./BackendDetail.js";
import { BackendEditor, backendFields, type BackendDraft } from "./BackendEditor.js";
import { backendEditors } from "./backend-editors.js";
import { EnvironmentChooser, EnvironmentEditor, environmentFields, newEnvironment } from "./EnvironmentEditor.js";
import { EnvironmentDetail, type DetailTab } from "./EnvironmentDetail.js";
import { BackendList, BackendRow, countLabel, emptyFilters, environmentBackends, EnvironmentList, type InventoryFilters, type RowAction } from "./ExecutionInventory.js";
import { acceptDraftFor, acceptFields, PairHostSetup, PendingHostDetail, type AcceptDraft } from "./PendingHosts.js";
import { useConfiguration, type ConfigurationControls, type SaveFailure } from "./useConfiguration.js";
import { useHostPairings, type HostPairingControls } from "./useHostPairings.js";
import type { BackendDefinition, Configuration, EnvironmentDefinition } from "./types.js";
import { mapConfigurationIssues, mapRequestIssues, noErrors, validationIssues, type MappedErrors, type ValidationIssue } from "./validation.js";
import "./execution-settings.css";

/** The execution inventories: one mounted controller serves both. */
export type ExecutionPage = "environments" | "backends";

export function isExecutionPage(page: SettingsPageId | undefined): page is ExecutionPage {
  return page === "environments" || page === "backends";
}

interface Location {
  readonly page: ExecutionPage;
  readonly resourceId?: string;
  readonly mode?: SettingsResourceMode;
}

function executionLocation(route: Route): Location | undefined {
  if (route.name !== "settings" || !isExecutionPage(route.page)) return undefined;
  return { page: route.page, ...(route.resourceId ? { resourceId: route.resourceId } : {}), ...(route.mode ? { mode: route.mode } : {}) };
}

function pathOf(location: Location): string {
  return settingsPath(location.page, location);
}

/** The editor a location opens, if any: its drafts live exactly as long as the location. */
function editorKey(location: Location | undefined): string | undefined {
  if (!location) return undefined;
  const { page, mode, resourceId } = location;
  if (mode === "edit" && resourceId) return `${page}:edit:${resourceId}`;
  if (mode === "new") return page === "backends" ? "backends:new" : resourceId === "local" || resourceId === "ssh" ? `environments:new:${resourceId}` : undefined;
  if (mode === "pending" && resourceId) return `pending:${resourceId}`;
  return undefined;
}

/** Every editor open at a location; the account defaults are open beside the backend list. */
function openEditors(location: Location | undefined): Set<string> {
  const keys = new Set<string>();
  const key = editorKey(location);
  if (key) keys.add(key);
  if (location?.page === "backends" && (!location.mode || location.mode === "view")) keys.add("defaults");
  return keys;
}

interface Draft<T> {
  readonly key: string;
  readonly value: T;
  /** The value when editing began, to tell whether it changed. */
  readonly initial: string;
}

function draftOf<T>(key: string, value: T): Draft<T> {
  return { key, value, initial: JSON.stringify(value) };
}

function changed<T>(draft: Draft<T> | undefined): boolean {
  return Boolean(draft && JSON.stringify(draft.value) !== draft.initial);
}

type ConfirmationRequest =
  | { readonly kind: "remove-environment" | "remove-backend"; readonly id: string; readonly label: string; readonly revision: number }
  | { readonly kind: "revoke" | "reapprove"; readonly environmentId: string; readonly label: string; readonly pairingId: string; readonly pairingRevision: number; readonly revision: number };
/** A confirmation belongs to the location it was opened at, and closes when navigation leaves it. */
type Confirmation = ConfirmationRequest & { readonly owner: string };

/** Configuration is principal-owned. Inventory filters, tabs and selection are client-local.
 * There is exactly one configuration snapshot and one mounted lifecycle controller
 * per resource, independent of visible inventory, filters, or detail selection. */
export function ExecutionSettings({ controls }: {
  readonly controls: ConfigurationControls & HostPairingControls;
}): React.JSX.Element {
  const route = useRoute();
  const current = executionLocation(route);
  const lastLocation = useRef<Location>(current ?? { page: "environments" });
  if (current) lastLocation.current = current;
  const location = current ?? lastLocation.current;
  const visible = Boolean(current);
  const { page, resourceId, mode } = location;
  const key = editorKey(current);
  const currentPath = current ? pathOf(current) : undefined;

  const [environmentDraft, setEnvironmentDraft] = useState<Draft<EnvironmentDefinition>>();
  const [backendDraft, setBackendDraft] = useState<Draft<BackendDraft>>();
  const [acceptDraft, setAcceptDraft] = useState<Draft<AcceptDraft>>();
  const [defaultsDraft, setDefaultsDraft] = useState<DefaultsDraft>();
  const [filters, setFilters] = useState<Record<string, InventoryFilters>>({});
  const [tabs, setTabs] = useState<Record<string, DetailTab>>({});
  const [leave, setLeave] = useState<{ readonly proceed: () => void; readonly discard: readonly string[] }>();
  const [queuedLeave, setQueuedLeave] = useState<{ readonly proceed: () => void; readonly leaving: readonly string[]; readonly mutation: "configuration" | "pairing" }>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [saveOwner, setSaveOwner] = useState<string>();
  const [acceptIssues, setAcceptIssues] = useState<readonly ValidationIssue[]>();
  const root = useRef<HTMLDivElement>(null);
  const bypass = useRef(false);
  const traversalBypass = useRef(false);
  const afterExit = useRef<(() => void) | undefined>(undefined);
  const backendSeed = useRef<string | undefined>(undefined);

  const routeEditorOpen = Boolean(key);
  const defaultsDirty = Boolean(defaultsDraft);
  const state = useConfiguration(controls, routeEditorOpen || defaultsDirty || Boolean(confirmation), visible);
  const pairing = useHostPairings(controls, state.refresh, visible);
  const snapshot = state.snapshot;
  const configuration = snapshot?.configuration;
  const pending = state.loading || state.saving || state.needsRefresh || pairing.busy;
  const registrations = pairing.hosts?.registrations ?? [];
  const registration = mode === "pending" ? registrations.find(entry => entry.id === resourceId && entry.state === "pending") : undefined;

  const dirtyKeys = new Set<string>([
    ...(changed(environmentDraft) ? [environmentDraft!.key] : []),
    ...(changed(backendDraft) ? [backendDraft!.key] : []),
    ...(changed(acceptDraft) ? [acceptDraft!.key] : []),
    ...(configuration && defaultsDraft && JSON.stringify(defaultsDraft) !== JSON.stringify(defaultsOf(configuration)) ? ["defaults"] : []),
  ]);
  const guard = useRef({ dirtyKeys, saving: state.saving, busy: pairing.busy, owner: saveOwner, queued: Boolean(queuedLeave) });
  guard.current = { dirtyKeys, saving: state.saving, busy: pairing.busy, owner: saveOwner, queued: Boolean(queuedLeave) };

  const discard = useCallback((keys: readonly string[]) => {
    for (const entry of keys) {
      if (entry === "defaults") setDefaultsDraft(undefined);
      else if (entry.startsWith("environments:")) setEnvironmentDraft(undefined);
      else if (entry.startsWith("backends:")) setBackendDraft(undefined);
      else if (entry.startsWith("pending:")) setAcceptDraft(undefined);
    }
  }, []);

  // Selection and editing are routes, so the one guard covers links, the
  // sidebar, browser and Android Back, and leaving Settings.
  useEffect(() => installNavigationBlocker((currentRoute, next, proceed) => {
    if (bypass.current) return true;
    if (traversalBypass.current) { traversalBypass.current = false; return true; }
    const staying = openEditors(executionLocation(next));
    const leaving = [...openEditors(executionLocation(currentRoute))].filter(entry => !staying.has(entry));
    if (!leaving.length) return true;
    const { dirtyKeys: dirty, saving, busy } = guard.current;
    if (saving || busy) { setQueuedLeave({ proceed, leaving, mutation: saving ? "configuration" : "pairing" }); return false; }
    const lost = leaving.filter(entry => dirty.has(entry));
    if (!lost.length) return true;
    setLeave({ proceed, discard: lost });
    return false;
  }), []);
  useEffect(() => {
    if (!queuedLeave || state.saving || pairing.busy) return;
    setQueuedLeave(undefined);
    const succeeded = queuedLeave.mutation === "configuration" ? state.lastSaveSucceeded : pairing.lastMutationSucceeded;
    if (!succeeded) { splitFocus.requestFocus(); return; }
    // The saved editor's content is kept; any other unsaved editor still asks.
    const lost = queuedLeave.leaving.filter(entry => entry !== guard.current.owner && guard.current.dirtyKeys.has(entry));
    if (lost.length) setLeave({ proceed: queuedLeave.proceed, discard: lost });
    else queuedLeave.proceed();
  }, [queuedLeave, state.saving, state.lastSaveSucceeded, pairing.busy, pairing.lastMutationSucceeded]);
  useEffect(() => {
    if (!dirtyKeys.size) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyKeys.size > 0]);

  /** Navigates after a decision already made here (a save, Cancel, a confirmed removal). */
  const go = (path: string, replace = false) => {
    bypass.current = true;
    try { navigate(path, { replace }); } finally { bypass.current = false; }
  };
  /** Leaves an editor without asking: back through history when it came down from `path`, otherwise a replace. */
  const returnTo = (path: string) => {
    const steps = historyStepsBackTo(path);
    if (steps === undefined) { go(path, true); return; }
    traversalBypass.current = true;
    window.history.go(steps);
  };

  // Drafts belong to their route: create them on entry and drop them on exit.
  useLayoutEffect(() => {
    if (!configuration) return;
    if (key?.startsWith("environments:")) {
      if (environmentDraft?.key !== key) {
        const value = mode === "edit" ? configuration.executionEnvironments.find(entry => entry.id === resourceId) : newEnvironment(resourceId === "local" ? "local" : "ssh");
        setEnvironmentDraft(value ? draftOf(key, structuredClone(value)) : undefined);
      }
    } else if (environmentDraft) setEnvironmentDraft(undefined);
    if (key?.startsWith("backends:")) {
      if (backendDraft?.key !== key) {
        if (mode === "edit") {
          const backend = configuration.backends.find(entry => entry.id === resourceId);
          setBackendDraft(backend ? draftOf(key, { creating: false, backend: structuredClone(backend),
            targets: structuredClone(configuration.targets.filter(entry => entry.backendInstanceId === backend.id)), defaultTargetId: configuration.defaultTargetId }) : undefined);
        } else {
          const seed = backendSeed.current ?? existingEnvironment(configuration, filters.backends?.environment);
          backendSeed.current = undefined;
          const backend = backendEditors.codex_app_server.createBackend(crypto.randomUUID());
          const target = backendEditors.codex_app_server.createTarget(crypto.randomUUID(), backend.id, seed ?? "");
          setBackendDraft(draftOf(key, { creating: true, backend, targets: [target], defaultTargetId: configuration.defaultTargetId ?? target.id }));
        }
      }
    } else if (backendDraft) setBackendDraft(undefined);
    if (key?.startsWith("pending:") && registration && snapshot) {
      if (acceptDraft?.key !== key) setAcceptDraft(draftOf(key, acceptDraftFor(registration, snapshot.revision)));
    } else if (!key?.startsWith("pending:") && acceptDraft) setAcceptDraft(undefined);
    if (!openEditors(current).has("defaults") && current && defaultsDraft) setDefaultsDraft(undefined);
  }, [key, Boolean(configuration), registration?.id]);

  // A new location: clear feedback that belonged to the last one; the
  // split focus hook restores the list's scroll or starts at the top, and
  // moves focus once the location's content has rendered.
  const splitFocus = useSettingsSplitFocus({
    root,
    location: current ? { path: pathOf(current), ...(current.resourceId ? { resourceId: current.resourceId } : {}), ...(current.mode ? { mode: current.mode } : {}) } : undefined,
    onArrive: () => {
      state.clearFeedback();
      setSaveOwner(undefined);
      setAcceptIssues(undefined);
      if (!editorKey(current) && afterExit.current) { const run = afterExit.current; afterExit.current = undefined; run(); }
    },
    // A dialog whose action moved to this location hands focus here as it closes.
    onDialogFocus: (target) => { confirmationFocus.returnFocusRef.current = target; leaveFocus.returnFocusRef.current = target; },
  });
  const confirmationFocus = useFocusReturn();
  const leaveFocus = useFocusReturn();
  const requestConfirmation = (request: ConfirmationRequest) => { if (currentPath) setConfirmation({ ...request, owner: currentPath }); };
  // SettingsView keeps this page mounted but hidden, while a confirmation is
  // portalled: it shows only at its own location, and closes on leaving it.
  const confirmationShown = Boolean(confirmation && confirmation.owner === currentPath);
  useEffect(() => {
    if (confirmation && !confirmationShown) setConfirmation(undefined);
  }, [confirmation, confirmationShown]);

  const currentFilters = filters[page] ?? emptyFilters;
  const setCurrentFilters = useCallback((next: InventoryFilters) => setFilters(existing => ({ ...existing, [page]: next })), [page]);
  const tabOf = (kind: ExecutionPage, id: string): DetailTab => tabs[`${kind}:${id}`] ?? "overview";
  const setTab = (kind: ExecutionPage, id: string, tab: DetailTab) => setTabs(existing => ({ ...existing, [`${kind}:${id}`]: tab }));
  const pausedReason = state.needsRefresh ? "Refresh the configuration before issuing runtime commands."
    : routeEditorOpen ? "Runtime controls are paused while configuration is being edited."
    : state.loading || state.saving ? "Runtime controls are paused while configuration is loading or saving." : undefined;
  const failureFor = (owner: string): SaveFailure | undefined => saveOwner === owner ? state.saveFailure : undefined;
  const mappedFailure = (owner: string, edited: Parameters<typeof mapConfigurationIssues>[2], fields: RegExp): MappedErrors => {
    const failure = failureFor(owner);
    return failure?.issues.length ? mapConfigurationIssues(failure.issues, failure.document, edited, fields) : noErrors;
  };
  const saveMessage = (owner: string): ReactNode => {
    const failure = failureFor(owner);
    return failure ? failure.message ?? (failure.issues.length ? "Fix the highlighted fields to save." : undefined) : undefined;
  };
  const savedAtFor = (owner: string) => saveOwner === owner ? state.savedAt : undefined;
  useEffect(() => {
    // After a failed save, take the person to the first field that needs a fix.
    if (!state.saveFailure?.issues.length) return;
    const invalid = root.current?.querySelector<HTMLElement>("[aria-invalid=true]");
    invalid?.scrollIntoView?.({ block: "center" });
    invalid?.focus({ preventScroll: true });
  }, [state.saveFailure]);

  const saveEnvironment = async () => {
    if (!configuration || !environmentDraft) return;
    const { key: owner, value } = environmentDraft;
    const creating = mode === "new";
    setSaveOwner(owner);
    const result = await state.save({ ...configuration, executionEnvironments: creating ? [...configuration.executionEnvironments, value]
      : configuration.executionEnvironments.map(entry => entry.id === value.id ? value : entry) });
    // A navigation queued behind the save takes over once it succeeds.
    if (!result.ok || guard.current.owner !== owner || guard.current.queued) return;
    if (creating) go(settingsPath("environments", { mode: "view", resourceId: value.id }), true);
    else setEnvironmentDraft(draftOf(owner, value));
  };
  const saveBackend = async () => {
    if (!configuration || !backendDraft) return;
    const { key: owner, value } = backendDraft;
    const { backend, targets, creating, defaultTargetId } = value;
    setSaveOwner(owner);
    const result = await state.save({ ...configuration,
      backends: creating ? [...configuration.backends, backend] : configuration.backends.map(entry => entry.id === backend.id ? backend : entry),
      targets: [...configuration.targets.filter(entry => entry.backendInstanceId !== backend.id), ...targets], defaultTargetId,
    });
    if (!result.ok || guard.current.owner !== owner || guard.current.queued) return;
    if (creating) go(settingsPath("backends", { mode: "view", resourceId: backend.id }), true);
    else setBackendDraft(draftOf(owner, { ...value, creating: false }));
  };
  const saveDefaults = async () => {
    if (!configuration || !defaultsDraft) return;
    setSaveOwner("defaults");
    const result = await state.save({ ...configuration, defaultTargetId: defaultsDraft.defaultTargetId || null, webSearch: defaultsDraft.webSearch });
    if (result.ok) setDefaultsDraft(undefined);
  };
  const acceptHost = async () => {
    if (!acceptDraft || !registration) return;
    const draft = acceptDraft.value;
    const parsed = acceptHostRegistrationRequestSchema.safeParse({ mutationId: crypto.randomUUID(), registrationId: draft.registrationId,
      expectedRegistrationRevision: draft.registrationRevision, expectedConfigurationRevision: draft.configurationRevision,
      label: draft.label, workspaceRoots: draft.workspaceRoots, operations: draft.operations });
    if (!parsed.success) { setAcceptIssues(validationIssues(parsed.error)); return; }
    setAcceptIssues(undefined);
    setSaveOwner(acceptDraft.key);
    const result = await pairing.mutate(() => controls.acceptHostRegistration(parsed.data), true);
    if (result.ok && !guard.current.queued) go(settingsPath("environments", { mode: "view", resourceId: result.value.pairing.executionEnvironmentId }), true);
  };
  const denyHost = async () => {
    if (!registration) return;
    const result = await pairing.mutate(() => controls.denyHostRegistration({ mutationId: crypto.randomUUID(), registrationId: registration.id, expectedRegistrationRevision: registration.revision }), false);
    if (!result.ok) throw new Error(result.error);
    go(settingsPath("environments"), true);
  };
  const confirm = async () => {
    if (!configuration || !snapshot || !confirmation) return;
    if (confirmation.kind === "revoke" || confirmation.kind === "reapprove") {
      const request = { mutationId: crypto.randomUUID(), pairingId: confirmation.pairingId, expectedPairingRevision: confirmation.pairingRevision, expectedConfigurationRevision: confirmation.revision };
      const result = await pairing.mutate(() => confirmation.kind === "revoke" ? controls.revokeHostPairing(request) : controls.reapproveHostPairing(request), true);
      if (!result.ok) throw new Error(result.error);
      return;
    }
    const removal = confirmation.kind === "remove-environment" || confirmation.kind === "remove-backend" ? confirmation : undefined;
    if (!removal) return;
    let next: Configuration;
    if (removal.kind === "remove-environment") next = { ...configuration, executionEnvironments: configuration.executionEnvironments.filter(entry => entry.id !== removal.id) };
    else {
      const removed = new Set(configuration.targets.filter(entry => entry.backendInstanceId === removal.id).map(entry => entry.id));
      next = { ...configuration, backends: configuration.backends.filter(entry => entry.id !== removal.id), targets: configuration.targets.filter(entry => !removed.has(entry.id)), defaultTargetId: removed.has(configuration.defaultTargetId ?? "") ? null : configuration.defaultTargetId };
    }
    setSaveOwner("confirmation");
    const result = await state.save(next);
    if (!result.ok) throw new Error(result.failure?.message ?? result.failure?.issues[0]?.message ?? "The configuration could not be saved. Refresh and try again.");
    // Leave the removed entity's page: back to where it was opened from, or its list.
    const removedPage: ExecutionPage = removal.kind === "remove-environment" ? "environments" : "backends";
    if (page !== removedPage || resourceId !== removal.id) return;
    const origin = splitFocus.previousPath();
    const ownPath = settingsPath(removedPage, { mode: "view", resourceId: removal.id });
    if (origin && origin !== ownPath && !origin.startsWith(`${ownPath}/`)) returnTo(origin);
    else go(settingsPath(removedPage), true);
  };
  const confirmationBlockers = (): string[] => {
    if (!confirmation || !configuration || !snapshot) return [];
    const blockers: string[] = [];
    if (confirmation.revision !== snapshot.revision) blockers.push("The configuration changed after this opened. Close this and review the latest state.");
    if (state.needsRefresh) blockers.push("The configuration changed or could not be confirmed. Close this and refresh it first.");
    if ((confirmation.kind === "revoke" || confirmation.kind === "reapprove") && pairing.stale) blockers.push("Refresh host registrations first.");
    if (confirmation.kind === "remove-environment") {
      const environmentId = confirmation.id;
      const environment = configuration.executionEnvironments.find(entry => entry.id === environmentId);
      const referencing = environmentBackends(configuration, environmentId);
      if (referencing.length) blockers.push(`Referenced by ${referencing.map(backend => backend.label).join(", ")}. Remove ${referencing.length === 1 ? "that backend" : "those backends"} first.`);
      if (environment?.kind === "outbound" && pairing.hosts?.pairings.find(entry => entry.id === environment.pairingId)?.state !== "revoked") blockers.push("Revoke the pairing first.");
    }
    return blockers;
  };

  const editPath = (kind: ExecutionPage, id: string) => settingsPath(kind, { mode: "edit", resourceId: id });
  const environmentActions = (environment: EnvironmentDefinition): RowAction[] => [
    { label: "Edit", onSelect: () => navigate(editPath("environments", environment.id)) },
    { label: "View activity", onSelect: () => { setTab("environments", environment.id, "activity"); navigate(settingsPath("environments", { mode: "view", resourceId: environment.id })); } },
    { label: "Remove…", destructive: true, disabled: !snapshot, onSelect: () => snapshot && requestConfirmation({ kind: "remove-environment", id: environment.id, label: environment.label, revision: snapshot.revision }) },
  ];
  const backendActions = (backend: BackendDefinition): RowAction[] => [
    { label: "Edit", onSelect: () => navigate(editPath("backends", backend.id)) },
    { label: "View activity", onSelect: () => { setTab("backends", backend.id, "activity"); navigate(settingsPath("backends", { mode: "view", resourceId: backend.id })); } },
    { label: "Remove…", destructive: true, disabled: !snapshot, onSelect: () => snapshot && requestConfirmation({ kind: "remove-backend", id: backend.id, label: backend.label, revision: snapshot.revision }) },
  ];
  const canAddBackend = Boolean(configuration && configuration.backends.length < 32 && configuration.executionEnvironments.length > 0);
  const addBackend = (environmentId?: string) => { backendSeed.current = environmentId; navigate(settingsPath("backends", { mode: "new" })); };
  const renderEnvironmentBackends = (environment: EnvironmentDefinition) => {
    if (!snapshot) return null;
    const backends = environmentBackends(snapshot.configuration, environment.id);
    return <div className="execution-related">
      <div className="execution-related-header">
        <p className="execution-muted">{backends.length ? `${countLabel(backends.length, "backend")} run in this environment.` : "No backends run here yet."}</p>
        <Button type="button" size="sm" variant="outline" disabled={pending || !canAddBackend} onClick={() => addBackend(environment.id)}><Plus />Add backend</Button>
      </div>
      {backends.length ? <EntityList>{backends.map(backend => <BackendRow key={backend.id} backend={backend} snapshot={snapshot} />)}</EntityList>
        : <EmptyState variant="inline" title="No backends in this environment." description="Add a backend to make a provider available." />}
    </div>;
  };
  const refresh = () => {
    if (routeEditorOpen && !state.needsRefresh) { void state.refreshRuntime(); void pairing.refresh(); return; }
    if (routeEditorOpen) { afterExit.current = () => { void state.refresh(); void pairing.refresh(); }; navigate(exitPath()); return; }
    void state.refresh(); void pairing.refresh();
  };
  /** Where an editor returns to (its "‹" link and Escape): the entity it edits, the add chooser, or its list. */
  const exitPath = () => settingsPath(page, settingsResourceParent(location));

  const selection = !mode ? "none" : mode === "view" ? "detail" : "editor";
  // Hidden, a detail shows nothing, so its menus and dialogs close with the page.
  const selectedEnvironment = visible && page === "environments" && mode === "view" ? configuration?.executionEnvironments.find(entry => entry.id === resourceId) : undefined;
  const selectedBackend = visible && page === "backends" && mode === "view" ? configuration?.backends.find(entry => entry.id === resourceId) : undefined;
  const listLabel = page === "environments" ? "Environments" : "Backends";
  const listBack = <SettingsBackLink href={settingsPath(page)} label={listLabel} />;
  const selectionMissing = Boolean(configuration && (mode === "view" || mode === "edit")
    && !(page === "environments" ? configuration.executionEnvironments : configuration.backends).some(entry => entry.id === resourceId))
    || Boolean(pairing.hosts && mode === "pending" && !registration);

  const runtimeProps = snapshot ? { controls, snapshot, runtimeDisabled: pending || routeEditorOpen, pausedReason,
    onRuntime: state.updateRuntime, onRefresh: state.refreshRuntime } : undefined;
  const detailPane = (): ReactNode => {
    if (!configuration || !snapshot || !visible) return null;
    if (!mode) return <EmptyState icon={<Server />} title={page === "environments" ? "Select an environment" : "Select a backend"}
      description={page === "environments" ? "Its status, backends and activity appear here." : "Its status, connections and activity appear here."} />;
    if (selectionMissing) return <div className="execution-detail"><SettingsDetailHeader back={listBack}
      title={mode === "pending" ? "Registration unavailable" : page === "environments" ? "Environment unavailable" : "Backend unavailable"}
      description={mode === "pending" ? "It was accepted, denied or expired." : "It may have been removed, or the link is out of date."} /></div>;
    if (mode === "new" && page === "environments" && !resourceId) return <EnvironmentChooser configuration={configuration} back={listBack} />;
    if (mode === "new" && page === "environments" && resourceId === "pair") return <PairHostSetup controls={controls} registrations={registrations}
      back={<SettingsBackLink href={exitPath()} label="Add environment" />} />;
    if (key?.startsWith("environments:") && environmentDraft && environmentDraft.key === key) {
      const draft = environmentDraft;
      const owner = draft.key;
      const creating = mode === "new";
      return <EnvironmentEditor draft={draft.value} creating={creating} setDraft={value => setEnvironmentDraft({ ...draft, value })}
        errors={mappedFailure(owner, { kind: "environment", id: environmentDraft.value.id }, environmentFields)} disabled={state.saving || state.loading}
        saving={state.saving && saveOwner === owner} dirty={changed(environmentDraft)} savedAt={savedAtFor(owner)} saveError={saveMessage(owner)}
        saveDisabled={pending}
        back={<SettingsBackLink href={exitPath()} label={creating ? "Add environment" : environmentDraft.value.label || "Environment"} />}
        onSave={() => void saveEnvironment()} onCancel={() => returnTo(exitPath())} />;
    }
    if (key?.startsWith("backends:") && backendDraft && backendDraft.key === key) {
      const draft = backendDraft;
      const owner = draft.key;
      const original = configuration.backends.find(entry => entry.id === draft.value.backend.id);
      return <BackendEditor draft={draft.value} setDraft={value => setBackendDraft({ ...draft, value })} configuration={configuration}
        errors={mappedFailure(owner, { kind: "backend", id: backendDraft.value.backend.id }, backendFields)} disabled={state.saving || state.loading}
        saving={state.saving && saveOwner === owner} dirty={changed(backendDraft)} savedAt={savedAtFor(owner)} saveError={saveMessage(owner)}
        saveDisabled={pending}
        back={<SettingsBackLink href={exitPath()} label={backendDraft.value.creating ? "Backends" : original?.label || "Backend"} />}
        onSave={() => void saveBackend()} onCancel={() => returnTo(exitPath())} />;
    }
    if (mode === "pending" && registration && acceptDraft && acceptDraft.key === key) {
      const draft = acceptDraft;
      return <PendingHostDetail registration={registration} draft={draft.value} setDraft={value => setAcceptDraft({ ...draft, value })}
        errors={acceptIssues ? mapRequestIssues(acceptIssues, acceptFields) : noErrors} disabled={pending || pairing.stale}
        saving={pairing.busy && saveOwner === draft.key} saveError={acceptIssues?.length ? "Fix the highlighted fields to accept this host." : undefined}
        back={<SettingsBackLink stackOnly href={settingsPath("environments")} label="Environments" />}
        onAccept={() => void acceptHost()} onCancel={() => returnTo(settingsPath("environments"))} onDeny={denyHost} />;
    }
    return null;
  };

  const defaultsValue = configuration ? defaultsDraft ?? defaultsOf(configuration) : undefined;
  const blockers = confirmationBlockers();
  const confirmationCopy = confirmation ? {
    "remove-environment": { title: `Remove ${confirmation.label}?`, description: "Existing sessions and history are retained. Running work may prevent removal.", confirmLabel: "Remove environment", pendingLabel: "Removing…", tone: "danger" as const },
    "remove-backend": { title: `Remove ${confirmation.label}?`, description: "Its connection definitions are removed too. Existing threads and history are retained. Running work may prevent removal.", confirmLabel: "Remove backend", pendingLabel: "Removing…", tone: "danger" as const },
    revoke: { title: `Revoke ${confirmation.label}?`, description: "This installation’s connection to Sedes is revoked. The environment and history are retained. This disconnects access but does not stop host-owned processes; stop running work first if you want it terminated.", confirmLabel: "Revoke pairing", pendingLabel: "Revoking…", tone: "danger" as const },
    reapprove: { title: `Reapprove ${confirmation.label}?`, description: "The same connector installation can reconnect with this environment’s saved roots and grants. Then create a fresh sidecar pairing code on the Sedes server and restart the connector with --pairing-code CODE --resume-pairing and the same state directory.", confirmLabel: "Reapprove pairing", pendingLabel: "Reapproving…", tone: "neutral" as const },
  }[confirmation.kind] : undefined;

  return <div ref={root} className="execution-settings" data-page={page}>
    <SettingsPage width="wide" selection={selection} title={listLabel}
      description={page === "environments" ? "Where agents run and which folders they can reach." : "Model providers available in each environment."}
      actions={<>
        <Button type="button" variant="ghost" size="icon" aria-label="Refresh" title="Refresh" disabled={state.loading || state.saving || pairing.busy} onClick={refresh}><RefreshCw /></Button>
        {page === "environments"
          ? <Button type="button" aria-label="Add environment" disabled={!configuration || pending || configuration.executionEnvironments.length >= 16}
            onClick={() => navigate(settingsPath("environments", { mode: "new" }))}><Plus />Add environment</Button>
          : <Button type="button" aria-label="Add backend" disabled={!configuration || pending || !canAddBackend}
            title={configuration && !configuration.executionEnvironments.length ? "Add an execution environment first" : undefined}
            onClick={() => addBackend(currentFilters.environment || undefined)}><Plus />Add backend</Button>}
      </>}>
      {state.loading && !snapshot ? <div className="execution-loading" role="status" aria-label="Loading execution configuration">
        <Skeleton className="h-9" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div> : null}
      {state.error ? <Callout tone={state.needsRefresh ? "warning" : "danger"} role="alert"
        action={state.needsRefresh ? <Button type="button" size="sm" variant="outline" onClick={refresh}>{routeEditorOpen ? "Discard and reload" : "Reload"}</Button> : undefined}>{state.error}</Callout> : null}
      {pairing.error ? <Callout tone="danger" role="alert">{pairing.error}</Callout> : null}
      {queuedLeave ? <Callout tone="info" role="status" action={<Button type="button" size="sm" variant="outline" onClick={() => { setQueuedLeave(undefined); splitFocus.requestFocus(); }}>Stay here</Button>}>
        Waiting for the current save to finish before leaving.</Callout> : null}
      {page === "backends" && configuration && defaultsValue && (!mode || mode === "view") ? <BackendDefaults configuration={configuration} value={defaultsValue}
        onChange={value => setDefaultsDraft(JSON.stringify(value) === JSON.stringify(defaultsOf(configuration)) ? undefined : value)}
        dirty={dirtyKeys.has("defaults")} saving={state.saving && saveOwner === "defaults"} savedAt={savedAtFor("defaults")}
        errors={mappedFailure("defaults", { kind: "document" }, defaultsFields)} error={failureFor("defaults")?.message} disabled={pending}
        onSave={() => void saveDefaults()} onCancel={() => { setDefaultsDraft(undefined); state.clearFeedback(); }} /> : null}
      {snapshot && configuration ? <SettingsSplit wide={page === "backends" && selection === "editor"}
        listLabel={page === "environments" ? "Configured environments" : "Configured backends"}
        list={!visible ? null : page === "environments"
          ? <EnvironmentList snapshot={snapshot} filters={currentFilters} onFilters={setCurrentFilters} hosts={pairing.hosts} stale={pairing.stale}
            selectedId={mode === "view" || mode === "edit" ? resourceId : undefined} selectedRegistrationId={mode === "pending" ? resourceId : undefined} actions={environmentActions} />
          : <BackendList snapshot={snapshot} filters={currentFilters} onFilters={setCurrentFilters}
            selectedId={mode === "view" || mode === "edit" ? resourceId : undefined} actions={backendActions} />}>
          {detailPane()}
          {/* Never unmount a retained resource because navigation, a filter or an editor hides it. */}
          {runtimeProps ? <>
            {configuration.executionEnvironments.map(environment => <EnvironmentDetail key={environment.id} environment={environment} {...runtimeProps}
              selected={environment.id === selectedEnvironment?.id} tab={tabOf("environments", environment.id)} onTab={tab => setTab("environments", environment.id, tab)}
              hosts={pairing.hosts} stale={pairing.stale} renderBackends={renderEnvironmentBackends}
              onRemove={entry => requestConfirmation({ kind: "remove-environment", id: entry.id, label: entry.label, revision: snapshot.revision })}
              onPairing={(entry, binding) => requestConfirmation({ kind: binding.state === "revoked" ? "reapprove" : "revoke", environmentId: entry.id, label: entry.label,
                pairingId: binding.id, pairingRevision: binding.revision, revision: snapshot.revision })} />)}
            {configuration.backends.map(backend => <BackendDetail key={backend.id} backend={backend} {...runtimeProps}
              selected={backend.id === selectedBackend?.id} tab={tabOf("backends", backend.id)} onTab={tab => setTab("backends", backend.id, tab)}
              onRemove={entry => requestConfirmation({ kind: "remove-backend", id: entry.id, label: entry.label, revision: snapshot.revision })} />)}
          </> : null}
      </SettingsSplit> : null}
    </SettingsPage>
    {confirmationCopy ? <ConfirmDialog open={confirmationShown} onOpenChange={open => { if (!open) setConfirmation(undefined); }}
      title={confirmationCopy.title} description={confirmationCopy.description} confirmLabel={confirmationCopy.confirmLabel} pendingLabel={confirmationCopy.pendingLabel}
      tone={confirmationCopy.tone} blockers={blockers} onConfirm={confirm} {...confirmationFocus} /> : null}
    <DiscardChangesDialog open={Boolean(leave)} onOpenChange={open => { if (!open) setLeave(undefined); }}
      description="Your edits have not been saved. Discard them to continue, or keep editing."
      onDiscard={() => { const request = leave; setLeave(undefined); if (request) { discard(request.discard); request.proceed(); } }} {...leaveFocus} />
  </div>;
}

function existingEnvironment(configuration: Configuration, id: string | undefined): string | undefined {
  return configuration.executionEnvironments.some(entry => entry.id === id) ? id : undefined;
}
