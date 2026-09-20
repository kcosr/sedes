import { useEffect, useId, useRef, useState } from "react";
import { Search, MoreHorizontal, SlidersHorizontal } from "lucide-react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import type { ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";
import type { HostPairingList } from "../../../shared/protocol/host-pairing.js";
import { backendEditors } from "./backend-editors.js";
import { presentRuntime, type RuntimePresentationOptions } from "./runtime-presentation.js";
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

export function environmentDescription(environment: EnvironmentDefinition): string {
  return environment.kind === "ssh" ? `SSH · ${environment.hostAlias}`
    : environment.kind === "outbound" ? "Paired outbound host" : "Local execution";
}

export function hostPresence(environment: EnvironmentDefinition, hosts?: HostPairingList, stale = false): string {
  if (environment.kind !== "outbound") return environment.kind === "local" ? "This machine" : "Via SSH";
  const pairing = hosts?.pairings.find(entry => entry.id === environment.pairingId);
  return stale || !pairing ? "Presence unknown" : pairing.state === "revoked" ? "Pairing revoked" : pairing.connected ? "Host online" : "Host offline";
}

export function RuntimeSummary({ runtime, options }: { readonly runtime?: ConfigurationRuntimeState; readonly options: RuntimePresentationOptions }): React.JSX.Element {
  const presentation = presentRuntime(runtime, options);
  // Backend inventories have a separate configuration column. Keep runtime-only
  // qualifiers here, including disabled backends and unconfirmed operations.
  const configurationQualifier = presentation.qualifier === "Pending restart" || presentation.qualifier === "Changes pending" || presentation.qualifier === "Configuration not applied";
  const qualifier = runtime?.lifecycleOperation?.state === "unknown" ? "Outcome unknown"
    : options.resourceKind === "backend" && configurationQualifier ? undefined : presentation.qualifier;
  return <div className="execution-inventory-status">
    <span className="execution-settings-connection" data-tone={presentation.tone}>{presentation.headline}</span>
    {qualifier ? <span className="execution-inventory-qualifier">{qualifier}</span> : null}
  </div>;
}

export function InventoryToolbar({ kind, filters, onChange, environments, scoped = false }: {
  readonly kind: "backends" | "environments";
  readonly filters: InventoryFilters;
  readonly onChange: (filters: InventoryFilters) => void;
  readonly environments: readonly EnvironmentDefinition[];
  readonly scoped?: boolean;
}): React.JSX.Element {
  const searchInput = useRef<HTMLInputElement>(null);
  const filterToggle = useRef<HTMLButtonElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterPanelId = useId();
  const environmentFilter = existingEnvironmentFilter(filters, environments);
  const activeFilters = [!scoped && environmentFilter, kind === "backends" && filters.provider, filters.status].filter(Boolean).length;
  useEffect(() => {
    if (filters.environment !== environmentFilter) onChange({ ...filters, environment: environmentFilter });
  }, [filters, environmentFilter, onChange]);
  return <div className="execution-inventory-toolbar">
    <div className="execution-inventory-search"><Search size={15} aria-hidden="true" />
      <Input ref={searchInput} aria-label={`Search ${kind}`} placeholder={`Search ${kind}…`} value={filters.search}
        onChange={event => onChange({ ...filters, search: event.currentTarget.value })} />
    </div>
    <Button ref={filterToggle} className="execution-inventory-filter-toggle" size="sm" variant="outline"
      aria-expanded={filtersOpen} aria-controls={filterPanelId} onClick={() => setFiltersOpen(open => !open)}>
      <SlidersHorizontal size={15} aria-hidden="true" />Filters{activeFilters ? ` (${activeFilters})` : ""}
    </Button>
    <div id={filterPanelId} className="execution-inventory-filters" data-expanded={filtersOpen}>
      {kind === "backends" && !scoped ? <label className="execution-inventory-filter"><span>Environment</span><select className="settings-native-select" aria-label="Filter by environment" value={environmentFilter}
        onChange={event => onChange({ ...filters, environment: event.currentTarget.value })}>
        <option value="">All environments</option>{sorted(environments).map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select></label> : null}
      {kind === "backends" ? <label className="execution-inventory-filter"><span>Provider</span><select className="settings-native-select" aria-label="Filter by provider" value={filters.provider}
        onChange={event => onChange({ ...filters, provider: event.currentTarget.value })}>
        <option value="">All providers</option>{Object.entries(backendEditors).map(([value, editor]) => <option key={value} value={value}>{editor.label}</option>)}
      </select></label> : null}
      <label className="execution-inventory-filter"><span>Status</span><select className="settings-native-select" aria-label="Filter by status" value={filters.status}
        onChange={event => onChange({ ...filters, status: event.currentTarget.value })}>
        <option value="">All statuses</option><option value="attention">Needs attention</option><option value="connected">Connected</option>
        <option value="stopped">Stopped</option>{kind === "backends" ? <option value="disabled">Disabled</option> : null}
      </select></label>
      <Button className="execution-inventory-filter-done" size="sm" onClick={() => { setFiltersOpen(false); filterToggle.current?.focus(); }}>Show results</Button>
    </div>
    {[filters.search, environmentFilter, filters.provider, filters.status].some(Boolean) ? <Button size="sm" variant="ghost" className="execution-inventory-clear" onClick={() => {
      onChange(emptyFilters); searchInput.current?.focus();
    }}>Clear filters</Button> : null}
  </div>;
}

function existingEnvironmentFilter(filters: InventoryFilters, environments: readonly EnvironmentDefinition[]): string {
  return environments.some(environment => environment.id === filters.environment) ? filters.environment : "";
}

function sorted<T extends { readonly label: string; readonly id: string }>(entries: readonly T[]): T[] {
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

function ResourceActions({ label, disabled, onOpen, onEdit }: {
  readonly label: string; readonly disabled: boolean; readonly onOpen: () => void; readonly onEdit: () => void;
}): React.JSX.Element {
  return <div className="execution-inventory-actions">
    <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={`Edit ${label}`} onClick={onEdit}>Edit</Button>
    <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`Actions for ${label}`}><MoreHorizontal size={16} /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="execution-settings-menu z-[100]">
        <DropdownMenuItem onSelect={onOpen}>Runtime and actions</DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onSelect={onEdit}>Edit configuration</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

interface InventoryProps {
  readonly snapshot: ConfigurationSnapshot;
  readonly filters: InventoryFilters;
  readonly disabled: boolean;
}

export function BackendInventory({ snapshot, filters, disabled, environmentId, onOpen, onEdit, onEnvironment }: InventoryProps & {
  readonly environmentId?: string;
  readonly onOpen: (backend: BackendDefinition) => void;
  readonly onEdit: (backend: BackendDefinition) => void;
  readonly onEnvironment: (environment: EnvironmentDefinition) => void;
}): React.JSX.Element {
  const configuration = snapshot.configuration;
  const term = filters.search.trim().toLocaleLowerCase();
  const scope = environmentId ?? existingEnvironmentFilter(filters, configuration.executionEnvironments);
  const hasFilters = Boolean(term || filters.provider || filters.status);
  const backends = sorted(configuration.backends).filter(backend => {
    const targets = configuration.targets.filter(entry => entry.backendInstanceId === backend.id);
    const environment = configuration.executionEnvironments.find(entry => entry.id === targets[0]?.executionEnvironmentId);
    const runtime = snapshot.runtimes.find(entry => entry.resourceKind === "backend" && entry.resourceId === backend.id);
    const search = [backend.label, backendEditors[backend.kind].label, environment?.label, environment ? environmentDescription(environment) : "", ...targets.map(entry => entry.label)].join(" ").toLocaleLowerCase();
    return (!scope || environment?.id === scope) && (!filters.provider || backend.kind === filters.provider)
      && search.includes(term) && matchesStatus(runtime, filters.status, backend.enabled);
  });
  return <section className="execution-inventory" aria-label="Configured backends">
    <p className="execution-settings-muted" role="status">{backends.length} backend{backends.length === 1 ? "" : "s"}{environmentId ? " in this environment" : " across environments"}</p>
    {!backends.length ? <p className="execution-inventory-empty">{configuration.executionEnvironments.length === 0
      ? "No backends configured. Add an execution environment first."
      : hasFilters ? "No backends match these filters."
      : scope ? "No backends in this environment. Add a backend to make a provider available."
      : "No backends configured. Add a backend to make a provider available."}</p> : null}
    {sorted(configuration.executionEnvironments).map(environment => {
      const group = backends.filter(backend => configuration.targets.some(target => target.backendInstanceId === backend.id && target.executionEnvironmentId === environment.id));
      if (!group.length) return null;
      return <section key={environment.id} aria-label={`${environment.label} backends`}>
        {!environmentId ? <div className="execution-inventory-group"><Button variant="link" onClick={() => onEnvironment(environment)}>{environment.label}</Button><span className="execution-inventory-group-description">{environmentDescription(environment)} · {group.length}</span><span className="execution-inventory-group-compact">{environment.kind === "ssh" ? "SSH" : environment.kind === "local" ? "Local" : "Paired"} · {group.length}</span></div> : null}
        <table role="table" className="execution-inventory-table" data-kind="backends"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Backend</th><th role="columnheader" scope="col">Provider</th><th role="columnheader" scope="col">Runtime</th><th role="columnheader" scope="col">Configuration</th><th role="columnheader" scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody role="rowgroup">
          {group.map(backend => {
            const targets = configuration.targets.filter(entry => entry.backendInstanceId === backend.id);
            const runtime = snapshot.runtimes.find(entry => entry.resourceKind === "backend" && entry.resourceId === backend.id);
            return <tr role="row" key={backend.id}>
              <td role="cell" className="execution-inventory-identity"><button type="button" className="execution-inventory-name" data-resource-id={backend.id} aria-label={`${backend.label} details`} onClick={() => onOpen(backend)}>{backend.label}</button>
                {targets.some(target => target.id === configuration.defaultTargetId) ? <span className="execution-inventory-default">Default</span> : null}
                <span className="execution-inventory-description">{targets.length} connection{targets.length === 1 ? "" : "s"}{backend.enabled ? "" : " · Disabled"}{runtime?.applyState === "applied" ? <span className="execution-inventory-applied-compact" aria-hidden="true"> · Config applied</span> : null}</span></td>
              <td role="cell" data-label="Provider">{backendEditors[backend.kind].label}</td>
              <td role="cell" data-label="Runtime"><RuntimeSummary runtime={runtime} options={{ resourceKind: "backend", sidecar: false, enabled: backend.enabled }} /></td>
              <td role="cell" data-label="Configuration" data-applied={runtime?.applyState === "applied"}><span className="execution-inventory-apply" data-attention={runtime && runtime.applyState !== "applied"}><span className="execution-inventory-config-label">Configuration: </span>{runtime ? { applied: "Applied", pending: runtime.startupEnvironmentPending ? "Pending restart" : "Changes pending", rejected: "Rejected", unavailable: "Not applied" }[runtime.applyState] : "Not reported"}</span></td>
              <td role="cell"><ResourceActions label={backend.label} disabled={disabled} onOpen={() => onOpen(backend)} onEdit={() => onEdit(backend)} /></td>
            </tr>;
          })}
        </tbody></table>
      </section>;
    })}
  </section>;
}

export function EnvironmentInventory({ snapshot, filters, disabled, hosts, stale, onOpen, onEdit, onRuntime }: InventoryProps & {
  readonly hosts?: HostPairingList;
  readonly stale: boolean;
  readonly onOpen: (environment: EnvironmentDefinition) => void;
  readonly onEdit: (environment: EnvironmentDefinition) => void;
  readonly onRuntime: (environment: EnvironmentDefinition) => void;
}): React.JSX.Element {
  const configuration: Configuration = snapshot.configuration;
  const term = filters.search.trim().toLocaleLowerCase();
  const entries = sorted(configuration.executionEnvironments).filter(environment => {
    const backendIds = new Set(configuration.targets.filter(target => target.executionEnvironmentId === environment.id).map(target => target.backendInstanceId));
    const search = [environment.label, environmentDescription(environment), ...configuration.backends.filter(backend => backendIds.has(backend.id)).map(backend => `${backend.label} ${backendEditors[backend.kind].label}`)].join(" ").toLocaleLowerCase();
    const runtime = snapshot.runtimes.find(entry => entry.resourceKind === "environment" && entry.resourceId === environment.id);
    return search.includes(term) && matchesStatus(runtime, filters.status);
  });
  return <section className="execution-inventory" aria-label="Configured environments">
    <p className="execution-settings-muted" role="status">{entries.length} of {configuration.executionEnvironments.length} environments</p>
    {!entries.length ? <p className="execution-inventory-empty">{configuration.executionEnvironments.length ? "No environments match these filters." : "No execution environments configured. Add a local environment, an SSH host, or pair an outbound host to begin."}</p> : <table role="table" className="execution-inventory-table" data-kind="environments"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Environment</th><th role="columnheader" scope="col">Host connection</th><th role="columnheader" scope="col">Runtime</th><th role="columnheader" scope="col">Backends</th><th role="columnheader" scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody role="rowgroup">
      {entries.map(environment => {
        const count = new Set(configuration.targets.filter(target => target.executionEnvironmentId === environment.id).map(target => target.backendInstanceId)).size;
        return <tr role="row" key={environment.id}>
          <td role="cell" className="execution-inventory-identity"><button type="button" className="execution-inventory-name" data-resource-id={environment.id} aria-label={`${environment.label} details`} onClick={() => onOpen(environment)}>{environment.label}</button><span className="execution-inventory-description">{environmentDescription(environment)}</span></td>
          <td role="cell" data-label="Host connection">{hostPresence(environment, hosts, stale)}</td>
          <td role="cell" data-label="Runtime"><RuntimeSummary runtime={snapshot.runtimes.find(entry => entry.resourceKind === "environment" && entry.resourceId === environment.id)} options={{ resourceKind: "environment", sidecar: environment.kind !== "local" }} /></td>
          <td role="cell" data-label="Backends"><Button variant="link" size="sm" onClick={() => onOpen(environment)}>{count} backend{count === 1 ? "" : "s"}</Button></td>
          <td role="cell"><ResourceActions label={environment.label} disabled={disabled} onOpen={() => onRuntime(environment)} onEdit={() => onEdit(environment)} /></td>
        </tr>;
      })}
    </tbody></table>}
  </section>;
}
