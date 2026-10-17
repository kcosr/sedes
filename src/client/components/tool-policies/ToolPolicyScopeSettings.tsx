import { useEffect, useState } from "react";
import type { ToolPolicySelection, ToolPolicySelectionSetting, ToolPolicySelectionTarget, ToolPolicySet } from "../../../shared/protocol/tool-policies.js";
import type { ApiClient } from "../../api/ApiClient.js";
import { useDirtyNavigationGuard } from "../../app/use-dirty-navigation-guard.js";
import { DiscardChangesDialog } from "../ui/discard-changes-dialog.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { SaveBar } from "../settings/SaveBar.js";
import { ToolPolicySelector, type ToolPolicyPreview } from "./ToolPolicySelector.js";

export type ToolPolicySettingsApi = Pick<ApiClient, "listToolPolicySets" | "listToolPolicySelections" | "setToolPolicySelection">;
const inherit: ToolPolicySelection = { kind: "inherit" };
const disabledPreview: ToolPolicyPreview = { enabled: false, enabledToolIds: [], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } };

export function sameToolPolicyTarget(left: ToolPolicySelectionTarget, right: ToolPolicySelectionTarget): boolean {
  return left.kind === right.kind && (left.kind === "account" || left.kind === "environment" && right.kind === "environment" && left.executionEnvironmentId === right.executionEnvironmentId || left.kind === "backend" && right.kind === "backend" && left.backendId === right.backendId);
}

/** Principal-owned defaults save independently of operator execution configuration; changing them never restarts a backend. */
export function ToolPolicyScopeSettings({ api, target, environmentId, policySets }: {
  readonly api: ToolPolicySettingsApi;
  readonly target: ToolPolicySelectionTarget;
  readonly environmentId?: string;
  readonly policySets?: readonly ToolPolicySet[];
}): React.JSX.Element {
  const key = JSON.stringify(target);
  const [fetchedPolicies, setPolicies] = useState<readonly ToolPolicySet[]>([]);
  const [settings, setSettings] = useState<readonly ToolPolicySelectionSetting[]>([]);
  const [value, setValue] = useState<ToolPolicySelection>(inherit);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [savedAt, setSavedAt] = useState<number>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(""); setLoadError("");
    void Promise.all([api.listToolPolicySets(abort.signal), api.listToolPolicySelections(abort.signal)]).then(([sets, selections]) => {
      if (abort.signal.aborted) return;
      setPolicies(sets.items); setSettings(selections.items);
      setValue(selections.items.find(item => sameToolPolicyTarget(item.target, target))?.selection ?? inherit);
      setLoading(false);
    }, cause => { if (!abort.signal.aborted) { setLoadError(messageFrom(cause)); setLoading(false); } });
    return () => abort.abort();
  }, [api, key, attempt]);
  const policies = policySets ?? fetchedPolicies;
  const current = settings.find(item => sameToolPolicyTarget(item.target, target));
  const dirty = JSON.stringify(value) !== JSON.stringify(current?.selection ?? inherit);
  const guard = useDirtyNavigationGuard(dirty || saving);
  const parents: ToolPolicySelectionTarget[] = [{ kind: "account" }];
  if (target.kind === "backend" && environmentId) parents.push({ kind: "environment", executionEnvironmentId: environmentId });
  const inherited = target.kind === "account" ? undefined : [...parents].reverse().map(parent => settings.find(item => sameToolPolicyTarget(item.target, parent)))
    .find(item => item && item.selection.kind !== "inherit");
  const inheritedSet = inherited?.selection.kind === "policy_set" ? policies.find(policy => inherited.selection.kind === "policy_set" && policy.id === inherited.selection.policySetId) : undefined;
  const inheritedLabel = inherited ? inherited.target.kind === "account" ? "account defaults" : "environment defaults" : "built-in defaults";
  const inheritedPreview = inheritedSet ? { ...inheritedSet, enabled: true, policySet: { name: inheritedSet.name, revision: inheritedSet.revision } } : !inherited || inherited.selection.kind === "disabled" ? disabledPreview : undefined;
  const save = async () => {
    setSaving(true); setError("");
    try {
      const result = await api.setToolPolicySelection({ target, selection: value, expectedRevision: current?.revision ?? 0 });
      setSettings(previous => [...previous.filter(item => !sameToolPolicyTarget(item.target, target)), result.setting]);
      setSavedAt(Date.now());
    } catch (cause) { setError(messageFrom(cause)); }
    finally { setSaving(false); }
  };
  return <div className="tool-policy-scope-settings">
    {loading ? <p className="tool-policy-hint" role="status">Loading tool policy…</p> : loadError ? <Callout tone="danger" role="alert" action={<Button type="button" size="sm" variant="outline" onClick={() => setAttempt(previous => previous + 1)}>Retry loading policy</Button>}>{loadError}</Callout> : <>
      <ToolPolicySelector value={value} onChange={setValue} policySets={policies} disabled={saving}
        label={target.kind === "account" ? "Default tool policy" : "Tool policy"} inheritedLabel={inheritedLabel} inheritedPolicy={inheritedPreview}
        description="Applies to new threads. Agents and individual threads can override this selection." />
      <SaveBar dirty={dirty} saving={saving} savedAt={savedAt} onSave={() => void save()} onCancel={() => { setValue(current?.selection ?? inherit); setError(""); }}
        saveLabel="Save default" placement="pane" />
    </>}
    {!loading && !loadError && inherited?.selection.kind === "policy_set" && !inheritedSet && value.kind === "inherit" ? <Callout tone="warning">Needs attention: the inherited policy set is unavailable. Choose a policy here or repair the parent default before creating threads.</Callout> : null}
    <DiscardChangesDialog open={Boolean(guard.pendingRoute)} confirmDisabled={saving} onOpenChange={open => { if (!open) guard.cancel(); }} onDiscard={guard.discardAndContinue} />
    {error ? <Callout tone="danger" role="alert" action={<Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setAttempt(previous => previous + 1)}>{dirty ? "Discard and reload" : "Reload"}</Button>}>{error}</Callout> : null}
  </div>;
}
