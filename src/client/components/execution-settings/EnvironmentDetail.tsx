import { useEffect, useState, type ReactNode, type Ref } from "react";
import { Ellipsis } from "lucide-react";
import type { ConfiguredEnvironmentVariables } from "../../../shared/protocol/environment-variables.js";
import type { HostPairingList } from "../../../shared/protocol/host-pairing.js";
import { navigate, settingsPath } from "../../app/router.js";
import { relativeTime } from "../../lib/time.js";
import { DangerZone, DangerZoneItem } from "../settings/DangerZone.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { CountBadge } from "../ui/count-badge.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { KeyValueList, type KeyValueItem } from "../ui/key-value-list.js";
import { StatusPill } from "../ui/status-pill.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.js";
import { Tag } from "../ui/tag.js";
import { SettingsBackLink } from "../settings/SettingsPage.js";
import { SettingsDetailHeader } from "../settings/SettingsSplit.js";
import { CopyableValue } from "./detail-parts.js";
import { capabilityLabels, environmentKindNames } from "./EnvironmentEditor.js";
import { environmentBackends, EnvironmentIcon, environmentKindLabels, hostPlatform, hostPresence, runtimeFor } from "./ExecutionInventory.js";
import { RecoveredOperations } from "./RecoveredOperations.js";
import { hasAvailableRuntimeMenuItems, hasDestructiveRuntimeMenuItems, hasRuntimeMenuItems, runtimeDiagnostics, RuntimeFeedback, RuntimeHealth, RuntimeImpactDialog, RuntimeMenuItems, RuntimePrimaryAction, useRuntimeController, type RuntimeController } from "./RuntimeControls.js";
import { worstStatus } from "./runtime-presentation.js";
import type { ConfigurationSnapshot, EnvironmentDefinition } from "./types.js";
import type { ConfigurationControls } from "./useConfiguration.js";

export type DetailTab = "overview" | "related" | "activity";
type Pairing = HostPairingList["pairings"][number];

export interface DetailRuntimeProps {
  readonly controls: ConfigurationControls;
  readonly snapshot: ConfigurationSnapshot;
  /** Commands are paused while the page loads, saves or edits. */
  readonly runtimeDisabled: boolean;
  readonly pausedReason?: string;
  readonly onRuntime: RuntimeControllerUpdate;
  readonly onRefresh: () => Promise<boolean>;
}
type RuntimeControllerUpdate = Parameters<typeof useRuntimeController>[0]["onRuntime"];

/** Configured variables in words: how many of each use, and their names. */
export function variableFacts(value?: ConfiguredEnvironmentVariables): KeyValueItem[] {
  const names = (usage: "execution" | "startup") => Object.keys(value?.[usage] ?? {});
  const describe = (entries: string[]) => entries.length ? entries.join(", ") : "None";
  return [
    { label: "Tools and commands", value: describe(names("execution")), mono: names("execution").length > 0 },
    { label: "Backend startup", value: describe(names("startup")), mono: names("startup").length > 0 },
  ];
}

/** A hidden detail never keeps a confirmation or inspection open. */
export function useHiddenDetailReset(selected: boolean, controller: RuntimeController, reset?: () => void): void {
  const pendingImpact = Boolean(controller.impact);
  useEffect(() => {
    if (selected) return;
    if (pendingImpact) controller.cancelImpact();
    reset?.();
  }, [selected, pendingImpact]);
}

/**
 * The detail's actions menu; it renders nothing when it would be empty. A
 * destructive lifecycle command comes last, after a separator.
 */
export function DetailMenu({ label, controller, extra }: { readonly label: string; readonly controller: RuntimeController; readonly extra?: ReactNode }): React.JSX.Element | null {
  const runtime = hasRuntimeMenuItems(controller);
  if (!runtime && !extra) return null;
  const destructive = hasDestructiveRuntimeMenuItems(controller);
  const regular = Boolean(extra) || controller.presentation.secondary.some(entry => entry.emphasis !== "destructive");
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button type="button" variant="outline" size="icon" aria-label={`Runtime actions for ${label}`}
      disabled={!extra && !hasAvailableRuntimeMenuItems(controller)} aria-describedby={controller.describedBy}><Ellipsis /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" aria-label={`Runtime actions for ${label}`}>
      <RuntimeMenuItems controller={controller} emphasis="default" />
      {extra}
      {regular && destructive ? <DropdownMenuSeparator /> : null}
      <RuntimeMenuItems controller={controller} emphasis="destructive" />
    </DropdownMenuContent>
  </DropdownMenu>;
}

/**
 * One environment's detail. Every environment keeps one mounted, whether
 * or not it is shown, so its runtime controller keeps settling receipts.
 */
export function EnvironmentDetail({ environment, selected, tab, onTab, hosts, stale, headingRef, renderBackends, onRemove, onPairing, ...runtimeProps }: DetailRuntimeProps & {
  readonly environment: EnvironmentDefinition;
  readonly selected: boolean;
  readonly tab: DetailTab;
  readonly onTab: (tab: DetailTab) => void;
  readonly hosts?: HostPairingList;
  readonly stale: boolean;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly renderBackends: (environment: EnvironmentDefinition) => ReactNode;
  readonly onRemove: (environment: EnvironmentDefinition) => void;
  readonly onPairing: (environment: EnvironmentDefinition, pairing: Pairing) => void;
}): React.JSX.Element | null {
  const { controls, snapshot, runtimeDisabled, pausedReason, onRuntime, onRefresh } = runtimeProps;
  const remote = environment.kind !== "local";
  const controller = useRuntimeController({ controls, revision: snapshot.revision, resourceKind: "environment", resourceId: environment.id,
    label: environment.label, runtime: runtimeFor(snapshot, "environment", environment.id), showSidecar: remote,
    disabled: runtimeDisabled, disabledReason: pausedReason, onRuntime, onRefresh });
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  useHiddenDetailReset(selected, controller, () => setRecoveryOpen(false));
  if (!selected) return null;
  const configuration = snapshot.configuration;
  const binding = environment.kind === "outbound" ? hosts?.pairings.find(entry => entry.id === environment.pairingId) : undefined;
  const presence = hostPresence(environment, hosts, stale);
  const status = worstStatus(presence, controller.presentation.pill);
  const backends = environmentBackends(configuration, environment.id);
  const editPath = settingsPath("environments", { mode: "edit", resourceId: environment.id });
  const runtime = controller.runtime;
  const hostFacts: KeyValueItem[] = [
    { label: "Type", value: environmentKindNames[environment.kind] },
    ...(environment.kind === "ssh" ? [{ label: "SSH alias", value: environment.hostAlias, mono: true }] : []),
    ...(environment.kind === "local" ? [{ label: "Isolated workspaces", value: environment.workspaceIsolation.networkProfiles.some(profile => profile === "execution_host") ? "Can use the host network" : "Offline" }] : []),
    ...(environment.kind === "outbound" ? [
      { label: "Presence", value: <>{presence?.label}{binding ? <span className="execution-muted"> · seen <time dateTime={binding.lastSeenAt} title={new Date(binding.lastSeenAt).toLocaleString()}>{relativeTime(binding.lastSeenAt)}</time></span> : null}</> },
      { label: "Platform", value: binding ? `${hostPlatform(binding.metadata.platform)} · ${binding.metadata.architecture}` : hostPlatform(environment.platform) },
      ...(binding ? [{ label: "Account", value: binding.metadata.account }, { label: "Connector", value: binding.metadata.connectorVersion, mono: true }] : []),
    ] : []),
  ];
  const capabilities = environment.kind === "local" ? [] : environment.operations.kind === "sidecar" ? environment.operations.enabledCapabilities.filter(entry => entry !== "workspace_context") : [];
  const accessFacts: KeyValueItem[] = [
    { label: "Roots", value: environment.workspaceRoots.length ? <ul className="execution-plain-list">{environment.workspaceRoots.map(root => <li key={root}>{root}</li>)}</ul> : "None", mono: true },
    ...(environment.kind === "local" ? [] : [{ label: "Operations", value: environment.operations.kind === "sidecar"
      ? `${capabilities.map(entry => capabilityLabels[entry]).join(", ")} (${capabilities.length} of 7)` : "Sidecar operations off" }]),
  ];
  const technical: KeyValueItem[] = [
    ...runtimeDiagnostics(controller),
    ...(runtime?.incarnation ? [{ label: "Service incarnation", value: <CopyableValue value={runtime.incarnation} label="service incarnation" /> }] : []),
    ...(binding ? [
      { label: "Installation ID", value: <CopyableValue value={binding.connectorId} label="installation ID" /> },
      { label: "Pairing ID", value: <CopyableValue value={binding.id} label="pairing ID" /> },
    ] : []),
    { label: "Environment ID", value: <CopyableValue value={environment.id} label="environment ID" /> },
  ];
  const revoked = binding?.state === "revoked";
  return <section aria-label={`${environment.label} details`} className="execution-detail">
    <SettingsDetailHeader back={<SettingsBackLink stackOnly href={settingsPath("environments")} label="Environments" />}
      icon={<EnvironmentIcon kind={environment.kind} />} title={environment.label} headingRef={headingRef}
      tags={environmentKindLabels[environment.kind] === environment.label ? undefined : <Tag>{environmentKindLabels[environment.kind]}</Tag>} status={<StatusPill tone={status.tone}>{status.label}</StatusPill>}
      actions={<>
        <RuntimePrimaryAction controller={controller} />
        <Button type="button" variant="outline" aria-label={`Edit ${environment.label}`} onClick={() => navigate(editPath)}>Edit</Button>
        <DetailMenu label={environment.label} controller={controller}
          extra={remote ? <DropdownMenuItem onSelect={() => setRecoveryOpen(true)}>Recovered operations…</DropdownMenuItem> : undefined} />
      </>} />
    <RuntimeFeedback controller={controller} />
    <Tabs value={tab} onValueChange={next => onTab(next as DetailTab)}>
      <TabsList aria-label="Environment sections">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="related">Backends{" "}<CountBadge count={backends.length} /></TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="execution-tab">
        <RuntimeHealth controller={controller} status={status}>
          {remote && controller.presentation.recoveryEmphasis ? <Callout tone="warning"
            action={<Button type="button" size="sm" variant="outline" onClick={() => setRecoveryOpen(true)}>Review</Button>}>
            Retained results may need recovery before lifecycle actions can succeed.</Callout> : null}
        </RuntimeHealth>
        <SettingsSection title="Host" card><KeyValueList className="execution-facts" items={hostFacts} /></SettingsSection>
        <SettingsSection title="Workspace access" card><KeyValueList className="execution-facts" items={accessFacts} /></SettingsSection>
        <SettingsSection title="Environment variables" card><KeyValueList className="execution-facts" items={variableFacts(environment.environmentVariables)} /></SettingsSection>
        <DangerZone>
          {binding ? <DangerZoneItem title={revoked ? "Reapprove pairing" : "Revoke pairing"}
            description={revoked ? "Let the same connector installation reconnect with this environment's saved access." : "Disconnect this installation. The environment and its history are kept."}
            action={<Button key="pairing" type="button" variant={revoked ? "outline" : "destructive"} aria-label={`${revoked ? "Reapprove" : "Revoke"} ${environment.label}`}
              onClick={() => onPairing(environment, binding)}>{revoked ? "Reapprove…" : "Revoke…"}</Button>} /> : null}
          <DangerZoneItem title="Remove environment"
            description={backends.length ? `Referenced by ${backends.length === 1 ? "1 backend" : `${backends.length} backends`}; remove ${backends.length === 1 ? "it" : "them"} first.`
              : environment.kind === "outbound" && !revoked ? "Revoke the pairing first. Existing sessions and history are retained."
              : "Existing sessions and history are retained."}
            action={<Button type="button" variant="destructive" aria-label={`Remove ${environment.label}`} onClick={() => onRemove(environment)}>Remove…</Button>} />
        </DangerZone>
      </TabsContent>
      <TabsContent value="related" className="execution-tab">{renderBackends(environment)}</TabsContent>
      <TabsContent value="activity" className="execution-tab">
        <SettingsSection title="Runtime" card>
          <div className="execution-runtime-summary">
            <div className="execution-health-status">
              <StatusPill tone={controller.presentation.headlineTone}>{controller.presentation.headline}</StatusPill>
              {controller.presentation.qualifier ? <StatusPill tone={controller.presentation.qualifierTone}>{controller.presentation.qualifier}</StatusPill> : null}
            </div>
            <p className="execution-health-detail">{controller.presentation.detail}</p>
          </div>
        </SettingsSection>
        <SettingsSection title="Technical details" card><KeyValueList className="execution-facts" items={technical} /></SettingsSection>
        {remote ? <SettingsSection title="Recovered operations" description="Results the host kept after a connection loss. Inspect them before releasing."
          actions={<Button type="button" size="sm" variant={controller.presentation.recoveryEmphasis ? "default" : "outline"} onClick={() => setRecoveryOpen(true)}>Recovered operations</Button>} /> : null}
      </TabsContent>
    </Tabs>
    <RuntimeImpactDialog controller={controller} />
    {remote ? <RecoveredOperations controls={controls} environmentId={environment.id} label={environment.label} open={recoveryOpen} onOpenChange={setRecoveryOpen} /> : null}
  </section>;
}
