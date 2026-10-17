import type { ReactNode } from "react";
import type { ToolPolicySelection, ToolPolicySet } from "../../../shared/protocol/tool-policies.js";
import type { AgentToolResourceScope } from "../../../shared/protocol/conversation.js";
import { SettingsField } from "../settings/SettingsField.js";
import { Callout } from "../ui/callout.js";
import { NativeSelect } from "../ui/native-select.js";
import "./tool-policies.css";

export interface ToolPolicyPreview {
  readonly enabled: boolean;
  readonly enabledToolIds: readonly string[];
  readonly resourceScope: AgentToolResourceScope;
}

export function describeToolPolicyScope(scope: AgentToolResourceScope): string {
  if (scope.allowOtherEnvironments && scope.allowOtherProjects) return "All projects across all environments";
  if (scope.allowOtherEnvironments) return "This project across all environments";
  if (scope.allowOtherProjects) return "All projects in this environment";
  return "This project in this environment";
}

/** A complete selection. Inherit and Disabled are distinct; selecting a set never merges it with its parent. */
export function ToolPolicySelector({ value, onChange, policySets, label = "Tool policy", inheritedLabel = "the previous level", inheritedPolicy,
  disabled = false, allowInherit = true, description, layout = "row" }: {
  readonly value: ToolPolicySelection;
  readonly onChange: (value: ToolPolicySelection) => void;
  readonly policySets: readonly ToolPolicySet[];
  readonly label?: string;
  readonly inheritedLabel?: string;
  readonly inheritedPolicy?: ToolPolicyPreview;
  readonly disabled?: boolean;
  readonly allowInherit?: boolean;
  readonly description?: ReactNode;
  readonly layout?: "row" | "stacked";
}): React.JSX.Element {
  const selected = value.kind === "policy_set" ? policySets.find(policy => policy.id === value.policySetId) : undefined;
  const missing = value.kind === "policy_set" && !selected;
  const preview = value.kind === "inherit" ? inheritedPolicy : value.kind === "disabled" ? undefined : selected ? { ...selected, enabled: true } : undefined;
  const choice = value.kind === "policy_set" ? value.policySetId : value.kind;
  return <div className="tool-policy-selector">
    <SettingsField label={label} layout={layout} description={description ?? "The nearest selection replaces the whole policy. Tools are never merged."}
      error={missing ? "Needs attention: this policy set was deleted or is unavailable. Choose another policy or inherit." : undefined}>
      <NativeSelect value={choice} disabled={disabled} onChange={event => {
        const next = event.target.value;
        onChange(next === "inherit" || next === "disabled" ? { kind: next } : { kind: "policy_set", policySetId: next });
      }}>
        {allowInherit || value.kind === "inherit" ? <option value="inherit">Inherit</option> : null}
        <option value="disabled">Disabled — no Sedes tools</option>
        {missing && value.kind === "policy_set" ? <option value={value.policySetId}>Needs attention — missing policy set</option> : null}
        {policySets.map(policy => <option key={policy.id} value={policy.id}>{policy.name}</option>)}
      </NativeSelect>
    </SettingsField>
    {!missing ? <div className="tool-policy-preview" aria-live="polite">
      <span className="tool-policy-preview-source">{value.kind === "inherit" ? `Inherited from ${inheritedLabel}` : value.kind === "disabled" ? "Explicitly disabled" : `${selected!.name} · revision ${selected!.revision}`}</span>
      {value.kind === "disabled" || preview?.enabled === false ? <p>No Sedes tools are exposed.</p> : preview ? <p>{preview.enabledToolIds.length} {preview.enabledToolIds.length === 1 ? "tool" : "tools"} · {describeToolPolicyScope(preview.resourceScope)}</p> : <p>The effective policy is resolved when a thread is created.</p>}
      {preview?.enabled && preview.enabledToolIds.length > 0 ? <details className="tool-policy-tool-preview"><summary>View selected tools ({preview.enabledToolIds.length})</summary><ul>{preview.enabledToolIds.map(id => <li key={id}><code>{id}</code></li>)}</ul></details> : null}
    </div> : null}
    {missing ? <Callout tone="warning">New threads cannot use this selection until you replace it. Existing threads keep their saved tool settings.</Callout> : null}
  </div>;
}
