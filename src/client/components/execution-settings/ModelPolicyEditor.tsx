import { Button } from "../ui/button.js";
import { SelectField, TextListField } from "./fields.js";
import type { ModelPolicy } from "./types.js";

export function ModelPolicyEditor({ value, onChange, supportsProviderIds }: {
  readonly value: ModelPolicy;
  readonly onChange: (value: ModelPolicy) => void;
  readonly supportsProviderIds: boolean;
}): React.JSX.Element {
  const rules = value.type === "catalog" ? [] : value.type === "allowlist" ? value.allowed : value.denied;
  const setRules = (next: typeof rules) => {
    if (value.type === "allowlist") onChange({ type: "allowlist", allowed: next });
    else if (value.type === "denylist") onChange({ type: "denylist", denied: next });
  };
  return <fieldset><legend>Model policy</legend>
    <SelectField label="Available models" value={value.type} options={[
      { value: "catalog", label: "All models in the provider catalog" },
      { value: "allowlist", label: "Only models matching these rules" },
      { value: "denylist", label: "All catalog models except these rules" },
    ]} onChange={(type) => {
      if (type === "catalog") onChange({ type });
      else if (type === "allowlist") onChange({ type, allowed: rules.length ? rules : [{}] });
      else onChange({ type, denied: rules.length ? rules : [{}] });
    }} />
    {value.type !== "catalog" ? <>
      <p className="execution-settings-muted">A model matches a rule when it matches every filled field. Enter one exact identifier per line. At least one field is required in each rule.</p>
      {rules.map((rule, index) => <fieldset key={index}><legend>Rule {index + 1}</legend>
        {supportsProviderIds ? <TextListField label="Provider identifiers" value={rule.providerIds ?? []}
          onChange={(providerIds) => setRules(rules.map((entry, position) => {
            if (position !== index) return entry;
            const { providerIds: omitted, ...rest } = entry;
            return providerIds.length ? { ...rest, providerIds } : rest;
          }))} /> : null}
        <TextListField label="Model identifiers" value={rule.modelIds ?? []}
          onChange={(modelIds) => setRules(rules.map((entry, position) => {
            if (position !== index) return entry;
            const { modelIds: omitted, ...rest } = entry;
            return modelIds.length ? { ...rest, modelIds } : rest;
          }))} />
        <TextListField label="Reasoning efforts" value={rule.reasoningEfforts ?? []}
          onChange={(reasoningEfforts) => setRules(rules.map((entry, position) => {
            if (position !== index) return entry;
            const { reasoningEfforts: omitted, ...rest } = entry;
            return reasoningEfforts.length ? { ...rest, reasoningEfforts } : rest;
          }))} />
        <Button type="button" variant="outline" size="sm" onClick={() => setRules(rules.filter((_, position) => position !== index))}>Remove rule {index + 1}</Button>
      </fieldset>)}
      <Button type="button" variant="outline" size="sm" disabled={rules.length >= 64} onClick={() => setRules([...rules, {}])}>Add model rule</Button>
    </> : null}
  </fieldset>;
}
