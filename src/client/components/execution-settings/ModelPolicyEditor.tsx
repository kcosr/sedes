import { Plus } from "lucide-react";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { CollapsibleItem, SelectField, TokenListField } from "./fields.js";
import type { ModelPolicy } from "./types.js";
import { FieldErrors } from "./validation.js";

type Rule = { providerIds?: string[]; modelIds?: string[]; reasoningEfforts?: string[] };
type Dimension = keyof Rule;

export const modelPolicyLabels: Record<ModelPolicy["type"], string> = {
  catalog: "All models in the provider catalog",
  allowlist: "Only models matching these rules",
  denylist: "All catalog models except these rules",
};

/** A rule in one line: "gpt-5, gpt-5-mini · effort high". */
export function summarizeRule(rule: Rule): string {
  return [rule.providerIds?.length ? `provider ${rule.providerIds.join(", ")}` : "", rule.modelIds?.join(", ") ?? "",
    rule.reasoningEfforts?.length ? `effort ${rule.reasoningEfforts.join(", ")}` : ""].filter(Boolean).join(" · ") || "Empty rule";
}

export function modelRules(value: ModelPolicy): Rule[] {
  return value.type === "catalog" ? [] : value.type === "allowlist" ? value.allowed : value.denied;
}

export function ModelPolicyEditor({ value, onChange, supportsProviderIds, errors, disabled = false }: {
  readonly value: ModelPolicy;
  readonly onChange: (value: ModelPolicy) => void;
  readonly supportsProviderIds: boolean;
  /** Errors relative to the model policy. */
  readonly errors: FieldErrors;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const rules = modelRules(value);
  const listKey = value.type === "denylist" ? "denied" : "allowed";
  const setRules = (next: Rule[]) => {
    if (value.type === "allowlist") onChange({ type: "allowlist", allowed: next });
    else if (value.type === "denylist") onChange({ type: "denylist", denied: next });
  };
  const setDimension = (index: number, dimension: Dimension, entries: string[]) => setRules(rules.map((entry, position) => {
    if (position !== index) return entry;
    const { [dimension]: _omitted, ...rest } = entry;
    return entries.length ? { ...rest, [dimension]: entries } : rest;
  }));
  const listError = errors.get(listKey);
  return <>
    <SelectField label="Available models" disabled={disabled} value={value.type} options={(Object.keys(modelPolicyLabels) as ModelPolicy["type"][]).map(type => ({ value: type, label: modelPolicyLabels[type] }))}
      error={errors.get("type")} onChange={(type) => {
        if (type === "catalog") onChange({ type });
        else if (type === "allowlist") onChange({ type, allowed: rules.length ? rules : [{}] });
        else onChange({ type, denied: rules.length ? rules : [{}] });
      }} />
    {value.type !== "catalog" ? <div className="execution-rules">
      <p className="execution-muted">A model matches a rule when it matches every filled field. Each rule needs at least one field.</p>
      {listError ? <Callout tone="danger">{listError}</Callout> : null}
      {rules.map((rule, index) => {
        const ruleErrors = errors.scope(`${listKey}.${index}`);
        const ruleError = errors.get(`${listKey}.${index}`);
        const empty = !rule.modelIds?.length && !rule.providerIds?.length && !rule.reasoningEfforts?.length;
        return <CollapsibleItem key={index} title={`Rule ${index + 1}`} summary={summarizeRule(rule)} defaultOpen={empty || rules.length === 1}
          forceOpen={Boolean(ruleError || ruleErrors.size)}
          actions={<Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setRules(rules.filter((_, position) => position !== index))}>Remove rule {index + 1}</Button>}>
          {ruleError ? <Callout tone="danger">{ruleError}</Callout> : null}
          {supportsProviderIds ? <TokenListField label="Provider identifiers" disabled={disabled} value={rule.providerIds ?? []} error={ruleErrors.under("providerIds")}
            placeholder="Type an identifier and press Enter" onChange={(entries) => setDimension(index, "providerIds", entries)} /> : null}
          <TokenListField label="Model identifiers" disabled={disabled} value={rule.modelIds ?? []} error={ruleErrors.under("modelIds")}
            placeholder="Type an identifier and press Enter" onChange={(entries) => setDimension(index, "modelIds", entries)} />
          <TokenListField label="Reasoning efforts" disabled={disabled} value={rule.reasoningEfforts ?? []} error={ruleErrors.under("reasoningEfforts")}
            placeholder="For example low, medium or high" onChange={(entries) => setDimension(index, "reasoningEfforts", entries)} />
        </CollapsibleItem>;
      })}
      <Button type="button" variant="outline" size="sm" className="execution-add-item" disabled={disabled || rules.length >= 64} onClick={() => setRules([...rules, {}])}><Plus />Add model rule</Button>
    </div> : null}
  </>;
}
