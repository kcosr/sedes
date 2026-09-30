import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Cable, Ellipsis, Link2, Monitor, Server, SlidersHorizontal } from "lucide-react";
import type { ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";
import type { HostPairingList, HostRegistration } from "../../../shared/protocol/host-pairing.js";
import { settingsPath } from "../../app/router.js";
import { BackendBrandIcon } from "../brand-icons.js";
import { EntityList, EntityRow } from "../settings/EntityList.js";
import { SettingsSearch } from "../settings/SettingsSearch.js";
import { Button } from "../ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { EmptyState } from "../ui/empty-state.js";
import { NativeSelect } from "../ui/native-select.js";
import { StatusPill } from "../ui/status-pill.js";
import { useTouchDensity } from "../../app/use-touch-density.js";
import { backendEditors } from "./backend-editors.js";
import { followLink } from "../settings/SettingsNav.js";
import { presentRuntime, worstStatus, type StatusPresentation } from "./runtime-presentation.js";
import type { BackendDefinition, Configuration, ConfigurationSnapshot, EnvironmentDefinition } from "./types.js";

export interface InventoryFilters {
  readonly search: string;
  readonly environment: string;
  readonly provider: string;
  readonly status: string;
}
export const emptyFilters: InventoryFilters = { search: "", environment: "", provider: "", status: "" };

export function needsAttention(runtime?: ConfigurationRuntimeState, enabled = true): boolean {
  return Boolean(runtime && (runtime.lastError || runtime.lifecycleOperation?.state === "unknown"
    || (!enabled && runtime.connectionState === "connected")
    || ["unreachable", "recovery_required"].includes(runtime.connectionState)
    || runtime.applyState !== "applied" || ["pending", "required"].includes(runtime.upgradeState)));
}

export const environmentKindLabels: Record<EnvironmentDefinition["kind"], string> = { local: "Local", ssh: "SSH", outbound: "Paired" };

export function EnvironmentIcon({ kind }: { readonly kind: EnvironmentDefinition["kind"] }): React.JSX.Element {
  return kind === "local" ? <Monitor /> : kind === "ssh" ? <Server /> : <Cable />;
}

export function backendBrand(kind: BackendDefinition["kind"]) {
  return ({ pi: "pi", codex_app_server: "codex", claude_agent_sdk: "claude", grok_build: "grok" } as const)[kind];
}

export function hostPlatform(platform: string): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
}

/** Where an environment runs, in words: "This machine", "SSH · build", "Paired · macOS". */
export function environmentDescription(environment: EnvironmentDefinition): string {
  return environment.kind === "ssh" ? `SSH · ${environment.hostAlias}`
    : environment.kind === "outbound" ? `Paired · ${hostPlatform(environment.platform)}` : "This machine";
}

/** A paired host's connection to Sedes; other kinds have no separate presence. */
export function hostPresence(environment: EnvironmentDefinition, hosts?: HostPairingList, stale = false): StatusPresentation | undefined {
  if (environment.kind !== "outbound") return undefined;
  const pairing = hosts?.pairings.find(entry => entry.id === environment.pairingId);
  if (stale || !pairing) return { label: "Presence unknown", tone: "neutral" };
  if (pairing.state === "revoked") return { label: "Pairing revoked", tone: "danger" };
  return pairing.connected ? { label: "Host online", tone: "success" } : { label: "Host offline", tone: "warning" };
}

export function runtimeFor(snapshot: ConfigurationSnapshot, kind: "environment" | "backend", id: string): ConfigurationRuntimeState | undefined {
  return snapshot.runtimes.find(entry => entry.resourceKind === kind && entry.resourceId === id);
}

/** One pill for an environment: its host presence or runtime, whichever needs more attention. */
export function environmentStatus(environment: EnvironmentDefinition, snapshot: ConfigurationSnapshot, hosts?: HostPairingList, stale = false): StatusPresentation {
  const runtime = presentRuntime(runtimeFor(snapshot, "environment", environment.id), { resourceKind: "environment", sidecar: environment.kind !== "local" });
  return worstStatus(hostPresence(environment, hosts, stale), runtime.pill);
}

export function backendStatus(backend: BackendDefinition, snapshot: ConfigurationSnapshot): StatusPresentation {
  return presentRuntime(runtimeFor(snapshot, "backend", backend.id), { resourceKind: "backend", sidecar: false, enabled: backend.enabled }).pill;
}

export function backendEnvironment(configuration: Configuration, backend: BackendDefinition): EnvironmentDefinition | undefined {
  const target = configuration.targets.find(entry => entry.backendInstanceId === backend.id);
  return configuration.executionEnvironments.find(entry => entry.id === target?.executionEnvironmentId);
}

export function environmentBackends(configuration: Configuration, environmentId: string): BackendDefinition[] {
  const ids = new Set(configuration.targets.filter(target => target.executionEnvironmentId === environmentId).map(target => target.backendInstanceId));
  return sorted(configuration.backends.filter(backend => ids.has(backend.id)));
}

export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function sorted<T extends { readonly label: string; readonly id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

function matchesStatus(runtime: ConfigurationRuntimeState | undefined, filter: string, enabled = true): boolean {
  switch (filter) {
    case "attention": return needsAttention(runtime, enabled);
    case "connected": return runtime?.connectionState === "connected";
    case "stopped": return runtime?.connectionState === "stopped";
    case "disabled": return !enabled;
    default: return true;
  }
}

function existingEnvironmentFilter(filters: InventoryFilters, environments: readonly EnvironmentDefinition[]): string {
  return environments.some(environment => environment.id === filters.environment) ? filters.environment : "";
}

export interface RowAction {
  readonly label: string;
  readonly onSelect: () => void;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}

/** A row's kebab: its menu opens below the trigger and never covers it. */
export function RowActions({ label, actions }: { readonly label: string; readonly actions: readonly RowAction[] }): React.JSX.Element {
  const touch = useTouchDensity();
  const regular = actions.filter(action => !action.destructive);
  const destructive = actions.filter(action => action.destructive);
  return <DropdownMenu presentation={touch && actions.length > 6 ? "sheet" : "menu"}>
    <DropdownMenuTrigger asChild><Button type="button" size="icon-sm" variant="ghost" aria-label={`Actions for ${label}`}><Ellipsis /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" side="bottom" avoidCollisions sheetTitle={label} aria-label={`Actions for ${label}`}>
      {regular.map(action => <DropdownMenuItem key={action.label} disabled={action.disabled} onSelect={action.onSelect}>{action.label}</DropdownMenuItem>)}
      {regular.length && destructive.length ? <DropdownMenuSeparator /> : null}
      {destructive.map(action => <DropdownMenuItem key={action.label} variant="destructive" disabled={action.disabled} onSelect={action.onSelect}>{action.label}</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/**
 * A row's one live state. Where the row is narrow (the split list pane, a
 * phone) the pill shrinks to its dot so the name keeps the width; the label
 * stays its accessible text and its tooltip.
 */
function RowStatus({ status }: { readonly status: StatusPresentation }): React.JSX.Element {
  return <StatusPill tone={status.tone} title={status.label} className="execution-row-status">
    <span className="execution-row-status-label">{status.label}</span>
  </StatusPill>;
}

/** Keeps a row without a kebab (a pending host) on the rows' status column. */
const noRowActions = <span className="execution-row-actions-spacer" aria-hidden="true" />;

function StatusFilter({ kind, value, onChange }: { readonly kind: "environments" | "backends"; readonly value: string; readonly onChange: (value: string) => void }): React.JSX.Element {
  return <NativeSelect aria-label="Filter by status" value={value} onChange={event => onChange(event.currentTarget.value)}>
    <option value="">All statuses</option><option value="attention">Needs attention</option><option value="connected">Connected</option>
    <option value="stopped">Stopped</option>{kind === "backends" ? <option value="disabled">Disabled</option> : null}
  </NativeSelect>;
}

/** A group of rows under a light header with a labeled count (none while a filter counts the results). */
export function InventoryGroup({ label, title, count, children }: { readonly label: string; readonly title: ReactNode; readonly count?: string; readonly children: ReactNode }): React.JSX.Element {
  const id = useId();
  return <section aria-label={label} className="execution-group">
    <div className="execution-group-header"><h3 id={id}>{title}</h3>{count ? <span>{count}</span> : null}</div>
    {children}
  </section>;
}

function ResultCount({ shown, total, noun, onClear }: { readonly shown: number; readonly total: number; readonly noun: string; readonly onClear?: () => void }): React.JSX.Element {
  return <div className="execution-list-count">
    <p role="status">{shown === total ? countLabel(total, noun) : `${shown} of ${countLabel(total, noun)}`}</p>
    {onClear ? <Button type="button" variant="link" size="xs" onClick={onClear}>Clear filters</Button> : null}
  </div>;
}

export function EnvironmentList({ snapshot, filters, onFilters, hosts, stale, selectedId, selectedRegistrationId, actions }: {
  readonly snapshot: ConfigurationSnapshot;
  readonly filters: InventoryFilters;
  readonly onFilters: (filters: InventoryFilters) => void;
  readonly hosts?: HostPairingList;
  readonly stale: boolean;
  readonly selectedId?: string;
  readonly selectedRegistrationId?: string;
  readonly actions: (environment: EnvironmentDefinition) => readonly RowAction[];
}): React.JSX.Element {
  const configuration = snapshot.configuration;
  const search = useRef<HTMLInputElement>(null);
  const term = filters.search.trim().toLocaleLowerCase();
  const filtered = Boolean(term || filters.status);
  const entries = sorted(configuration.executionEnvironments).filter(environment => {
    const text = [environment.label, environmentDescription(environment), ...environmentBackends(configuration, environment.id).map(backend => `${backend.label} ${backendEditors[backend.kind].label}`)].join(" ").toLocaleLowerCase();
    return text.includes(term) && matchesStatus(runtimeFor(snapshot, "environment", environment.id), filters.status);
  });
  const pending = (hosts?.registrations ?? []).filter(registration => registration.state === "pending"
    && [registration.metadata.hostname, registration.correlationCode, hostPlatform(registration.metadata.platform)].join(" ").toLocaleLowerCase().includes(term));
  const clear = () => { onFilters(emptyFilters); search.current?.focus(); };
  const rows = <EntityList>{entries.map(environment => {
    const backends = environmentBackends(configuration, environment.id).length;
    const status = environmentStatus(environment, snapshot, hosts, stale);
    const path = settingsPath("environments", { mode: "view", resourceId: environment.id });
    return <EntityRow key={environment.id} data-resource-id={environment.id} icon={<EnvironmentIcon kind={environment.kind} />}
      title={environment.label} subtitle={`${environmentDescription(environment)} · ${countLabel(backends, "backend")}`}
      status={<RowStatus status={status} />} selected={environment.id === selectedId}
      href={path} onSelect={event => followLink(event, path)}
      actions={<RowActions label={environment.label} actions={actions(environment)} />} />;
  })}</EntityList>;
  return <>
    {configuration.executionEnvironments.length ? <div className="execution-toolbar">
      <SettingsSearch ref={search} label="Search environments" value={filters.search} onValueChange={value => onFilters({ ...filters, search: value })} />
      <StatusFilter kind="environments" value={filters.status} onChange={status => onFilters({ ...filters, status })} />
    </div> : null}
    {pending.length ? <InventoryGroup label="Awaiting approval" title="Awaiting approval" count={countLabel(pending.length, "host")}>
      <EntityList>{pending.map(registration => <PendingHostRow key={registration.id} registration={registration} selected={registration.id === selectedRegistrationId} />)}</EntityList>
    </InventoryGroup> : null}
    {!configuration.executionEnvironments.length ? <EmptyState icon={<Server />} title="No execution environments"
      description="Add this machine, an SSH host, or pair a host to choose where agents run." />
      : pending.length ? <InventoryGroup label="Environments" title="Environments" count={filtered ? undefined : countLabel(entries.length, "environment")}>
        {filtered ? <ResultCount shown={entries.length} total={configuration.executionEnvironments.length} noun="environment" onClear={clear} /> : null}
        {rows}
      </InventoryGroup>
      : <><ResultCount shown={entries.length} total={configuration.executionEnvironments.length} noun="environment" onClear={filtered ? clear : undefined} />{rows}</>}
    {configuration.executionEnvironments.length && !entries.length ? <EmptyState variant="inline" title="No environments match these filters." /> : null}
  </>;
}

function PendingHostRow({ registration, selected }: { readonly registration: HostRegistration & { readonly connected?: boolean }; readonly selected: boolean }): React.JSX.Element {
  const path = settingsPath("environments", { mode: "pending", resourceId: registration.id });
  return <EntityRow data-resource-id={registration.id} icon={<Link2 />} title={registration.metadata.hostname}
    subtitle={`Code ${registration.correlationCode} · ${hostPlatform(registration.metadata.platform)} ${registration.metadata.architecture}`}
    status={<RowStatus status={registration.connected ? { label: "Host online", tone: "success" } : { label: "Host offline", tone: "warning" }} />}
    selected={selected} href={path} onSelect={event => followLink(event, path)} actions={noRowActions} />;
}

/** Pending registrations as rows, for places other than the environment list. */
export function PendingHostList({ registrations }: { readonly registrations: HostPairingList["registrations"] }): React.JSX.Element {
  const pending = registrations.filter(registration => registration.state === "pending");
  return pending.length ? <EntityList>{pending.map(registration => <PendingHostRow key={registration.id} registration={registration} selected={false} />)}</EntityList>
    : <EmptyState variant="inline" title="No hosts are waiting for approval." description="Run the connector on the host; its request appears here." />;
}

export function BackendRow({ backend, snapshot, selected, actions }: {
  readonly backend: BackendDefinition; readonly snapshot: ConfigurationSnapshot; readonly selected?: boolean; readonly actions?: readonly RowAction[];
}): React.JSX.Element {
  const configuration = snapshot.configuration;
  const targets = configuration.targets.filter(entry => entry.backendInstanceId === backend.id);
  const status = backendStatus(backend, snapshot);
  const path = settingsPath("backends", { mode: "view", resourceId: backend.id });
  const isDefault = targets.some(target => target.id === configuration.defaultTargetId);
  return <EntityRow data-resource-id={backend.id} icon={<BackendBrandIcon brand={backendBrand(backend.kind)} />}
    title={backend.label}
    // Fixed attributes read in the subtitle, so the name keeps the width beside the status.
    subtitle={[backendEditors[backend.kind].label, countLabel(targets.length, "connection"), isDefault ? "Default" : undefined, backend.enabled ? undefined : "Disabled"]
      .filter(Boolean).join(" · ")}
    status={<RowStatus status={status} />} selected={selected}
    href={path} onSelect={event => followLink(event, path)}
    actions={actions ? <RowActions label={backend.label} actions={actions} /> : undefined} />;
}

export function BackendList({ snapshot, filters, onFilters, selectedId, actions }: {
  readonly snapshot: ConfigurationSnapshot;
  readonly filters: InventoryFilters;
  readonly onFilters: (filters: InventoryFilters) => void;
  readonly selectedId?: string;
  readonly actions: (backend: BackendDefinition) => readonly RowAction[];
}): React.JSX.Element {
  const configuration = snapshot.configuration;
  const search = useRef<HTMLInputElement>(null);
  const filterToggle = useRef<HTMLButtonElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const panelId = useId();
  const environmentFilter = existingEnvironmentFilter(filters, configuration.executionEnvironments);
  useEffect(() => {
    // A removed environment no longer filters the list.
    if (filters.environment !== environmentFilter) onFilters({ ...filters, environment: environmentFilter });
  }, [filters, environmentFilter, onFilters]);
  const term = filters.search.trim().toLocaleLowerCase();
  const activeFilters = [environmentFilter, filters.provider, filters.status].filter(Boolean).length;
  const filtered = Boolean(term || activeFilters);
  const backends = sorted(configuration.backends).filter(backend => {
    const targets = configuration.targets.filter(entry => entry.backendInstanceId === backend.id);
    const environment = backendEnvironment(configuration, backend);
    const text = [backend.label, backendEditors[backend.kind].label, environment?.label, environment ? environmentDescription(environment) : "", ...targets.map(entry => entry.label)].join(" ").toLocaleLowerCase();
    return (!environmentFilter || environment?.id === environmentFilter) && (!filters.provider || backend.kind === filters.provider)
      && text.includes(term) && matchesStatus(runtimeFor(snapshot, "backend", backend.id), filters.status, backend.enabled);
  });
  const clear = () => { onFilters(emptyFilters); search.current?.focus(); };
  if (!configuration.backends.length) {
    return <EmptyState icon={<Server />} title="No backends"
      description={configuration.executionEnvironments.length === 0 ? "Add an execution environment first, then add a backend to make a provider available." : "Add a backend to make a provider available to new threads."} />;
  }
  return <>
    <div className="execution-toolbar" data-filters={filtersOpen ? "open" : "closed"}>
      <SettingsSearch ref={search} label="Search backends" value={filters.search} onValueChange={value => onFilters({ ...filters, search: value })} />
      <Button ref={filterToggle} type="button" variant="outline" className="execution-filter-toggle" aria-expanded={filtersOpen} aria-controls={panelId}
        onClick={() => setFiltersOpen(open => !open)}><SlidersHorizontal />Filters{activeFilters ? ` (${activeFilters})` : ""}</Button>
      <div id={panelId} className="execution-filters">
        <label className="execution-filter"><span className="execution-filter-label">Environment</span>
          <NativeSelect aria-label="Filter by environment" value={environmentFilter} onChange={event => onFilters({ ...filters, environment: event.currentTarget.value })}>
            <option value="">All environments</option>{sorted(configuration.executionEnvironments).map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </NativeSelect></label>
        <label className="execution-filter"><span className="execution-filter-label">Provider</span>
          <NativeSelect aria-label="Filter by provider" value={filters.provider} onChange={event => onFilters({ ...filters, provider: event.currentTarget.value })}>
            <option value="">All providers</option>{Object.entries(backendEditors).map(([value, editor]) => <option key={value} value={value}>{editor.label}</option>)}
          </NativeSelect></label>
        <label className="execution-filter"><span className="execution-filter-label">Status</span>
          <StatusFilter kind="backends" value={filters.status} onChange={status => onFilters({ ...filters, status })} /></label>
        <Button type="button" className="execution-filter-done" onClick={() => { setFiltersOpen(false); filterToggle.current?.focus(); }}>Show results</Button>
      </div>
    </div>
    {filtered ? <ResultCount shown={backends.length} total={configuration.backends.length} noun="backend" onClear={clear} /> : null}
    {!backends.length ? <EmptyState variant="inline" title="No backends match these filters." /> : null}
    {sorted(configuration.executionEnvironments).map(environment => {
      const group = backends.filter(backend => backendEnvironment(configuration, backend)?.id === environment.id);
      if (!group.length) return null;
      return <InventoryGroup key={environment.id} label={`${environment.label} backends`} title={environment.label} count={countLabel(group.length, "backend")}>
        <EntityList>{group.map(backend => <BackendRow key={backend.id} backend={backend} snapshot={snapshot} selected={backend.id === selectedId} actions={actions(backend)} />)}</EntityList>
      </InventoryGroup>;
    })}
  </>;
}
