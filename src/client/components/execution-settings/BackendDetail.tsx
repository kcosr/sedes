import type { Ref } from "react";
import { navigate, settingsPath } from "../../app/router.js";
import { BackendBrandIcon } from "../brand-icons.js";
import { DangerZone, DangerZoneItem } from "../settings/DangerZone.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { CountBadge } from "../ui/count-badge.js";
import { EmptyState } from "../ui/empty-state.js";
import { KeyValueList, type KeyValueItem } from "../ui/key-value-list.js";
import { StatusPill } from "../ui/status-pill.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.js";
import { Tag } from "../ui/tag.js";
import { allowedEnvironments, backendEditors } from "./backend-editors.js";
import { followLink } from "../settings/SettingsNav.js";
import { SettingsBackLink } from "../settings/SettingsPage.js";
import { SettingsDetailHeader } from "../settings/SettingsSplit.js";
import { CopyableValue } from "./detail-parts.js";
import { DetailMenu, useHiddenDetailReset, variableFacts, type DetailRuntimeProps, type DetailTab } from "./EnvironmentDetail.js";
import { backendBrand, backendEnvironment, runtimeFor } from "./ExecutionInventory.js";
import { modelPolicyLabels, modelRules, summarizeRule } from "./ModelPolicyEditor.js";
import { runtimeDiagnostics, RuntimeFeedback, RuntimeHealth, RuntimeImpactDialog, RuntimePrimaryAction, useRuntimeController } from "./RuntimeControls.js";
import type { BackendDefinition } from "./types.js";

/**
 * One backend's detail. Every backend keeps one mounted, whether or not it
 * is shown, so its runtime controller keeps settling receipts.
 */
export function BackendDetail({ backend, selected, tab, onTab, headingRef, onRemove, ...runtimeProps }: DetailRuntimeProps & {
  readonly backend: BackendDefinition;
  readonly selected: boolean;
  readonly tab: DetailTab;
  readonly onTab: (tab: DetailTab) => void;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly onRemove: (backend: BackendDefinition) => void;
}): React.JSX.Element | null {
  const { controls, snapshot, runtimeDisabled, pausedReason, onRuntime, onRefresh } = runtimeProps;
  const configuration = snapshot.configuration;
  const environment = backendEnvironment(configuration, backend);
  const unsupported = Boolean(environment && !allowedEnvironments(backend, [environment]).length);
  const controller = useRuntimeController({ controls, revision: snapshot.revision, resourceKind: "backend", resourceId: backend.id,
    label: backend.label, runtime: runtimeFor(snapshot, "backend", backend.id), enabled: backend.enabled,
    disabled: runtimeDisabled || unsupported, disabledReason: unsupported ? "Remote execution is unsupported for this backend." : pausedReason,
    onRuntime, onRefresh });
  useHiddenDetailReset(selected, controller);
  if (!selected) return null;
  const editor = backendEditors[backend.kind];
  const targets = configuration.targets.filter(entry => entry.backendInstanceId === backend.id);
  const isDefault = targets.some(target => target.id === configuration.defaultTargetId);
  const status = controller.presentation.pill;
  const editPath = settingsPath("backends", { mode: "edit", resourceId: backend.id });
  const environmentPath = environment ? settingsPath("environments", { mode: "view", resourceId: environment.id }) : undefined;
  const rules = modelRules(backend.modelPolicy);
  const policy = editor.describePolicy?.(backend);
  const connectionFacts: KeyValueItem[] = [
    { label: "Provider", value: <span className="execution-inline-icon"><BackendBrandIcon brand={backendBrand(backend.kind)} />{editor.label}</span> },
    { label: "Environment", value: environment && environmentPath ? <a href={environmentPath} onClick={event => followLink(event, environmentPath)}>{environment.label}</a> : "Environment unavailable" },
    ...editor.describeConnection(backend),
  ];
  const runtime = controller.runtime;
  const technical: KeyValueItem[] = [
    ...runtimeDiagnostics(controller),
    ...(runtime?.incarnation ? [{ label: "Service incarnation", value: <CopyableValue value={runtime.incarnation} label="service incarnation" /> }] : []),
    { label: "Backend ID", value: <CopyableValue value={backend.id} label="backend ID" /> },
  ];
  return <section aria-label={`${backend.label} details`} className="execution-detail">
    <SettingsDetailHeader back={<SettingsBackLink stackOnly href={settingsPath("backends")} label="Backends" />}
      icon={<BackendBrandIcon brand={backendBrand(backend.kind)} />} title={backend.label} headingRef={headingRef}
      tags={<><Tag>{editor.label}</Tag>{isDefault ? <Tag>Default</Tag> : null}{backend.enabled ? null : <Tag>Disabled</Tag>}</>}
      status={<StatusPill tone={status.tone}>{status.label}</StatusPill>}
      description={environment ? `In ${environment.label}` : undefined}
      actions={<>
        <RuntimePrimaryAction controller={controller} />
        <Button type="button" variant="outline" aria-label={`Edit ${backend.label}`} onClick={() => navigate(editPath)}>Edit</Button>
        <DetailMenu label={backend.label} controller={controller} />
      </>} />
    <RuntimeFeedback controller={controller} />
    <Tabs value={tab} onValueChange={next => onTab(next as DetailTab)}>
      <TabsList aria-label="Backend sections">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="related">Connections{" "}<CountBadge count={targets.length} /></TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="execution-tab">
        <RuntimeHealth controller={controller} status={status}>
          {unsupported ? <Callout tone="warning" role="status">Remote execution is unsupported. This retained configuration cannot run here.</Callout> : null}
        </RuntimeHealth>
        <SettingsSection title="Provider and connection" card><KeyValueList className="execution-facts" items={connectionFacts} /></SettingsSection>
        {policy?.length ? <SettingsSection title="Policy" card><KeyValueList className="execution-facts" items={policy} /></SettingsSection> : null}
        <SettingsSection title="Models" card>
          <KeyValueList className="execution-facts" items={[
            { label: "Available", value: modelPolicyLabels[backend.modelPolicy.type] },
            ...rules.map((rule, index) => ({ key: `rule-${index}`, label: `Rule ${index + 1}`, value: summarizeRule(rule), mono: true })),
          ]} />
        </SettingsSection>
        <SettingsSection title="Environment variables" card><KeyValueList className="execution-facts" items={variableFacts(backend.environmentVariables)} /></SettingsSection>
        <DangerZone>
          <DangerZoneItem title="Remove backend" description="Its connections are removed too. Existing threads and history are retained. Running work may prevent removal."
            action={<Button type="button" variant="destructive-outline" aria-label={`Remove ${backend.label}`} onClick={() => onRemove(backend)}>Remove…</Button>} />
        </DangerZone>
      </TabsContent>
      <TabsContent value="related" className="execution-tab">
        {targets.length ? <ul className="execution-connection-list" aria-label={`${backend.label} connections`}>
          {targets.map(target => <li key={target.id}>
            <span className="execution-connection-title">{target.label}
              {configuration.defaultTargetId === target.id ? <Tag>Default for new threads</Tag> : null}
              {target.enabled ? null : <Tag>Disabled</Tag>}</span>
            <span className="execution-connection-summary">{editor.summarizeTarget(target)}</span>
          </li>)}
        </ul> : <EmptyState variant="inline" title="No connections." />}
      </TabsContent>
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
      </TabsContent>
    </Tabs>
    <RuntimeImpactDialog controller={controller} />
  </section>;
}
