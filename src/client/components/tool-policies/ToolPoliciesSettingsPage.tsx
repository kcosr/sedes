import { useEffect, useRef, useState } from "react";
import { Plus, ShieldCheck } from "lucide-react";
import { toolPolicyDefinitionSchema, type ToolPolicyDefinition, type ToolPolicySet } from "../../../shared/protocol/tool-policies.js";
import type { ApiClient } from "../../api/ApiClient.js";
import { navigate, settingsPath, useRoute } from "../../app/router.js";
import { useDirtyNavigationGuard } from "../../app/use-dirty-navigation-guard.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
import { ExactToolSelector, type ExactToolGroup } from "../agents/ExactToolSelector.js";
import { DangerZone, DangerZoneItem } from "../settings/DangerZone.js";
import { EntityList, EntityRow } from "../settings/EntityList.js";
import { SaveBar } from "../settings/SaveBar.js";
import { SettingsField, SwitchField } from "../settings/SettingsField.js";
import { followLink } from "../settings/SettingsNav.js";
import { SettingsBackLink, SettingsPage } from "../settings/SettingsPage.js";
import { SettingsSearch } from "../settings/SettingsSearch.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { SettingsEditor, SettingsSplit } from "../settings/SettingsSplit.js";
import { useSettingsSplitFocus } from "../settings/use-settings-split-focus.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { DiscardChangesDialog } from "../ui/discard-changes-dialog.js";
import { EmptyState } from "../ui/empty-state.js";
import { Input } from "../ui/input.js";
import { Tag } from "../ui/tag.js";
import { ToolPolicyScopeSettings } from "./ToolPolicyScopeSettings.js";
import { describeToolPolicyScope } from "./ToolPolicySelector.js";
import "./tool-policies.css";

const listPath = settingsPath("tool_policies");
const newPath = settingsPath("tool_policies", { mode: "new" });
const policyPath = (id: string) => settingsPath("tool_policies", { mode: "view", resourceId: id });
type PolicyApi = Pick<ApiClient, "listToolPolicySets" | "createToolPolicySet" | "updateToolPolicySet" | "deleteToolPolicySet" | "getToolPolicySet" | "getToolPolicyOptions" | "listToolPolicySelections" | "setToolPolicySelection">;

/** Principal-owned reusable sets. A route owns its draft and the desktop/mobile settings kit owns its layout. */
export function ToolPoliciesSettingsPage({ api }: { readonly api: PolicyApi }): React.JSX.Element {
  const route = useRoute();
  const location = route.name === "settings" && route.page === "tool_policies" ? route : undefined;
  const creating = location?.mode === "new";
  const policyId = location?.mode === "view" ? location.resourceId : undefined;
  const root = useRef<HTMLDivElement>(null);
  const [policies, setPolicies] = useState<readonly ToolPolicySet[]>([]);
  const [groups, setGroups] = useState<readonly ExactToolGroup[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useSettingsSplitFocus({ root, location: location ? { path: settingsPath("tool_policies", location), ...(location.resourceId ? { resourceId: location.resourceId } : {}), ...(location.mode ? { mode: location.mode } : {}) } : undefined });
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void Promise.all([api.listToolPolicySets(controller.signal), api.getToolPolicyOptions(controller.signal)]).then(([sets, options]) => {
      if (controller.signal.aborted) return;
      setPolicies(sets.items); setGroups(options.groups.map(group => ({
        id: group.id, label: group.label.text, description: group.description.text,
        tools: group.tools.map(tool => ({ id: tool.id, label: tool.label.text, description: tool.description?.text ?? "", effects: tool.effects, available: tool.available, unavailableReason: tool.unavailableReason?.text })),
      }))); setLoading(false);
    }, cause => { if (!controller.signal.aborted) { setError(messageFrom(cause)); setLoading(false); } });
    return () => controller.abort();
  }, [api, refresh]);
  const selected = policies.find(policy => policy.id === policyId);
  const shown = policies.filter(policy => policy.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const action = <Button type="button" disabled={loading || Boolean(error)} onClick={() => navigate(newPath)}><Plus />New policy set</Button>;
  const replace = (policy: ToolPolicySet) => setPolicies(previous => [...previous.filter(item => item.id !== policy.id), policy].sort((a, b) => a.name.localeCompare(b.name)));
  return <SettingsPage ref={root} title="Tool policies" description="Reusable tool lists and access boundaries for new threads." width="wide"
    selection={creating || policyId ? "editor" : "none"} actions={<>
      {creating || policyId ? <Button type="button" variant="outline" onClick={() => navigate(listPath)}>Account default</Button> : null}
      {action}
    </>}>
    {error ? <Callout tone="danger" role="alert" action={<Button type="button" variant="outline" size="sm" onClick={() => setRefresh(value => value + 1)}>Reload</Button>}>{error}</Callout> : null}
    {loading ? <p role="status">Loading tool policies…</p> : <>
      {!creating && !policyId ? <div data-stack="list"><SettingsSection title="Account default" description="Account → Environment → Backend → Agent → Thread. The nearest explicit selection wins." card>
        <ToolPolicyScopeSettings api={api} target={{ kind: "account" }} policySets={policies} />
      </SettingsSection></div> : null}
      <SettingsSplit listLabel="Policy sets" empty={!policies.length && !creating} list={<>
        <SettingsSearch label="Search policy sets" value={search} onValueChange={setSearch} placeholder="Search policy sets…" />
        <EntityList>{shown.map(policy => <EntityRow key={policy.id} data-resource-id={policy.id} title={policy.name} icon={<ShieldCheck />} selected={policy.id === policyId}
          subtitle={`${policy.enabledToolIds.length} ${policy.enabledToolIds.length === 1 ? "tool" : "tools"} · ${describeToolPolicyScope(policy.resourceScope)}`} tags={<Tag>v{policy.revision}</Tag>} href={policyPath(policy.id)} onSelect={event => followLink(event, policyPath(policy.id))} chevron />)}</EntityList>
        {search && !shown.length ? <EmptyState variant="inline" title="No matching policies." /> : null}
      </>}>
        {creating || selected ? <PolicyEditor key={creating ? "new" : selected!.id} api={api} policy={selected} groups={groups} onSaved={policy => { replace(policy); }}
          onCreated={policy => { replace(policy); }} onDeleted={id => setPolicies(previous => previous.filter(policy => policy.id !== id))} />
          : policyId ? <div><SettingsBackLink stackOnly href={listPath} label="Tool policies" /><EmptyState title="Policy unavailable" description="It may have been deleted. Choose another policy set." action={<Button type="button" variant="outline" onClick={() => navigate(listPath)}>View policy sets</Button>} /></div>
          : !policies.length ? <EmptyState icon={<ShieldCheck />} title="Create your first policy set" description="Choose tools once, then reuse the set across environments, backends, Agents and templates." action={action} />
          : <EmptyState title="Choose a policy set" description="Edit its exact tools and project or environment access." />}
      </SettingsSplit>
    </>}
  </SettingsPage>;
}

function definitionOf(policy?: ToolPolicySet): ToolPolicyDefinition {
  return policy ? { name: policy.name, enabledToolIds: [...policy.enabledToolIds], resourceScope: { ...policy.resourceScope } }
    : { name: "", enabledToolIds: [], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } };
}

function PolicyEditor({ api, policy, groups, onSaved, onCreated, onDeleted }: {
  readonly api: PolicyApi;
  readonly policy?: ToolPolicySet;
  readonly groups: readonly ExactToolGroup[];
  readonly onSaved: (policy: ToolPolicySet) => void;
  readonly onCreated: (policy: ToolPolicySet) => void;
  readonly onDeleted: (id: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => definitionOf(policy));
  const [base, setBase] = useState(policy);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<number>();
  const [removing, setRemoving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(definitionOf(base));
  const guard = useDirtyNavigationGuard(dirty || saving);
  const parsed = toolPolicyDefinitionSchema.safeParse(draft);
  const nameError = attempted && !draft.name.trim() ? "Enter a name for this policy set." : undefined;
  const knownIds = new Set(groups.flatMap(group => group.tools.map(tool => tool.id)));
  const unavailable = draft.enabledToolIds.filter(id => !knownIds.has(id));
  const save = async () => {
    setAttempted(true);
    if (!parsed.success || saving) return;
    setSaving(true); setError("");
    try {
      const result = base ? await api.updateToolPolicySet(base.id, { ...parsed.data, expectedRevision: base.revision }) : await api.createToolPolicySet(parsed.data);
      setBase(result.policySet); setDraft(definitionOf(result.policySet)); setSavedAt(Date.now());
      if (base) onSaved(result.policySet);
      else { onCreated(result.policySet); guard.proceed(policyPath(result.policySet.id), { replace: true }); }
    } catch (cause) { setError(messageFrom(cause)); }
    finally { setSaving(false); }
  };
  return <>
    <SettingsEditor label={base ? `Edit ${base.name}` : "Create tool policy set"} title={base ? base.name : "New policy set"}
      back={<SettingsBackLink stackOnly href={listPath} label="Tool policies" />}
      description={base ? `Revision ${base.revision}. Changes apply to future threads; existing threads keep their snapshot.` : "Start with no tools and access limited to this project and environment."}
      className="tool-policy-editor" onSubmit={() => void save()}
      errors={error && base ? <Callout tone="danger" role="alert" action={<Button type="button" variant="outline" size="sm" onClick={() => setReloading(true)}>Reload latest</Button>}>{error}</Callout> : undefined}
      saveBar={<SaveBar dirty={dirty} creating={!base} saving={saving} savedAt={savedAt} error={error || undefined} onCancel={() => {
        if (!base) guard.proceed(listPath, { up: true });
        else { setDraft(definitionOf(base)); setError(""); setAttempted(false); }
      }} saveLabel={base ? "Save changes" : "Create policy set"} saveDisabled={!parsed.success && attempted} />}>
      <SettingsSection title="Details" card><SettingsField label="Name" error={nameError} description="A clear name for this reusable tool list."><Input value={draft.name} maxLength={160} disabled={saving} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} placeholder="For example, Everyday" /></SettingsField></SettingsSection>
      <div className="tool-policy-editor-summary" aria-label="Policy summary">
        <div className="tool-policy-stat"><strong>{draft.enabledToolIds.length} {draft.enabledToolIds.length === 1 ? "tool" : "tools"} selected</strong><span>Exact list; nothing is added by inheritance.</span></div>
        <div className="tool-policy-stat"><strong>{describeToolPolicyScope(draft.resourceScope)}</strong><span>Lists are filtered. Direct requests outside the boundary are denied.</span></div>
      </div>
      <SettingsSection title="Resource access" description="Both boundaries must allow a resource. Shared project data belongs to the project as a whole." card>
        <SwitchField label="Allow other environments" description="Access this project on other execution hosts." checked={draft.resourceScope.allowOtherEnvironments} disabled={saving}
          onCheckedChange={allowOtherEnvironments => setDraft(previous => ({ ...previous, resourceScope: { ...previous.resourceScope, allowOtherEnvironments } }))} />
        <SwitchField label="Allow other projects" description="Access other projects within the allowed environments." checked={draft.resourceScope.allowOtherProjects} disabled={saving}
          onCheckedChange={allowOtherProjects => setDraft(previous => ({ ...previous, resourceScope: { ...previous.resourceScope, allowOtherProjects } }))} />
      </SettingsSection>
      <SettingsSection title="Sedes tools" description="Select only the tools this policy should expose. Backend presentation is chosen separately." card>
        <ExactToolSelector groups={groups} selectedToolIds={draft.enabledToolIds} unavailableToolIds={unavailable} disabled={saving} showEffects
          onChange={enabledToolIds => setDraft(previous => ({ ...previous, enabledToolIds: [...enabledToolIds] }))} />
      </SettingsSection>
      {base ? <DangerZone><DangerZoneItem title="Delete policy set" description="Defaults, Agents and templates using this policy will need a replacement before creating threads. Existing threads keep their snapshot."
        action={<Button type="button" variant="destructive-outline" disabled={saving || dirty} onClick={() => setRemoving(true)}>Delete policy set…</Button>} /></DangerZone> : null}
    </SettingsEditor>
    <DiscardChangesDialog open={Boolean(guard.pendingRoute)} confirmDisabled={saving} onOpenChange={open => { if (!open) guard.cancel(); }} onDiscard={guard.discardAndContinue} />
    {base ? <DiscardChangesDialog open={reloading} onOpenChange={setReloading} title="Reload the latest policy?" description="Your unsaved edits will be discarded." discardLabel="Discard and reload" onDiscard={async () => {
      const latest = await api.getToolPolicySet(base.id);
      setBase(latest); setDraft(definitionOf(latest)); onSaved(latest); setError(""); setAttempted(false);
    }} /> : null}
    {base ? <ConfirmDialog open={removing} onOpenChange={setRemoving} title={`Delete ${base.name}?`} description="Defaults, Agents and templates using this set will show Needs attention and cannot create threads until you select a replacement. Existing threads keep their saved tools."
      tone="danger" confirmLabel="Delete policy set" onConfirm={async () => { await api.deleteToolPolicySet(base.id, { expectedRevision: base.revision }); onDeleted(base.id); guard.proceed(listPath, { up: true }); }} /> : null}
  </>;
}
