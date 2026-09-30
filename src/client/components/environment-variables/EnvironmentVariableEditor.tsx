import { useState } from "react";
import { ChevronRight, LockKeyhole, Plus } from "lucide-react";
import { environmentVariableNameSchema, environmentVariableOverridesSchema, isProtectedEnvironmentVariableName, type EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { NativeSelect } from "../ui/native-select.js";
import { Tag } from "../ui/tag.js";
import { describeIssue } from "../execution-settings/validation.js";
import { variableEntryLabel, variableRows, variableScopeLabels, type VariableEntry, type VariableLayer, type VariableScope } from "./environment-variable-presentation.js";
import "./environment-variables.css";

/** Why a new variable name cannot be added, in words; undefined when it can. */
export function variableNameProblem(name: string, existing: readonly string[]): string | undefined {
  if (!name) return "Enter a variable name.";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return "Use letters, digits and underscores, starting with a letter or underscore.";
  if (isProtectedEnvironmentVariableName(name)) return `${name} is managed by Sedes or by the provider's identity settings, so it can't be set here.`;
  if (existing.some(candidate => candidate.toUpperCase() === name.toUpperCase())) return "This variable already exists. Override its row instead.";
  const parsed = environmentVariableNameSchema.safeParse(name);
  return parsed.success ? undefined : describeIssue(parsed.error.issues[0]!);
}

export function EnvironmentVariableEditor({ scope, inherited = [], value, onChange, readOnly = false, disabled = false }: {
  readonly scope: VariableScope;
  readonly inherited?: readonly VariableLayer[];
  readonly value: EnvironmentVariableOverrides;
  readonly onChange?: (value: EnvironmentVariableOverrides) => void;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [entry, setEntry] = useState<VariableEntry>({ kind: "literal", value: "" });
  const [error, setError] = useState("");
  const layers = [...inherited, { scope, values: value }];
  const rows = variableRows(layers);
  const effectiveCount = rows.filter(row => row.entry.kind !== "unset").length;
  const unsetCount = rows.length - effectiveCount;
  const inheritedByName = new Map(variableRows(inherited).map(row => [row.name.toUpperCase(), row]));
  const change = (variable: string, next?: VariableEntry) => {
    const proposed = Object.fromEntries(Object.entries(value).filter(([key]) => key.toUpperCase() !== variable.toUpperCase()));
    if (next) Object.defineProperty(proposed, variable, { value: next, enumerable: true, writable: true, configurable: true });
    const parsed = environmentVariableOverridesSchema.safeParse(proposed);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue ? `${variable}: ${describeIssue(issue)}` : "This variable can't be saved.");
      return false;
    }
    setError("");
    onChange?.(parsed.data);
    return true;
  };
  const closeAdd = () => { setAdding(false); setName(""); setNameError(undefined); setEntry({ kind: "literal", value: "" }); };
  const add = () => {
    const problem = variableNameProblem(name, rows.map(row => row.name));
    setNameError(problem);
    if (problem) return;
    if (change(name, entry)) closeAdd();
  };
  return <div className="environment-variable-editor">
    {inherited.length ? <p className="environment-variable-inheritance" aria-label="Variable precedence">
      {layers.map((layer, index) => <span key={layer.scope}>{index > 0 && <ChevronRight aria-hidden="true" />}{variableScopeLabels[layer.scope]}</span>)}
    </p> : null}
    <div className="environment-variable-table" role="table" aria-label="Environment variables">
      {rows.length ? <div className="environment-variable-table-heading" role="row">
        <span role="columnheader">Variable</span><span role="columnheader">Value</span><span role="columnheader">{readOnly ? "Source" : "Action"}</span>
      </div> : null}
      {rows.map(row => {
        const own = row.scope === scope;
        const parent = inheritedByName.get(row.name.toUpperCase());
        const open = expanded === row.name;
        const source = row.entry.kind === "unset" ? `Excluded by ${variableScopeLabels[row.scope].toLowerCase()}`
          : own ? parent ? `Overrides ${variableScopeLabels[parent.scope].toLowerCase()}` : "Defined here"
          : `Inherited from ${variableScopeLabels[row.scope].toLowerCase()}`;
        return <div key={row.name} role="rowgroup" className="environment-variable-rowgroup">
          <div className="environment-variable-row" role="row">
            <div role="cell" className="environment-variable-name">
              <div className="environment-variable-name-line">
                <code>{row.name}</code>
                {row.history.length > 1 ? <Button type="button" variant="ghost" size="icon-xs" aria-label={`Show sources for ${row.name}`} aria-expanded={open}
                  onClick={() => setExpanded(open ? undefined : row.name)}><ChevronRight data-expanded={open || undefined} /></Button> : null}
              </div>
              <small>{source}</small>
            </div>
            <div role="cell" className="environment-variable-value">{!readOnly && own && row.entry.kind !== "unset"
              ? <VariableValueEditor name={row.name} value={row.entry} disabled={disabled} onChange={next => change(row.name, next)} />
              : <VariableValue entry={row.entry} />}</div>
            <div role="cell" className="environment-variable-action">{readOnly ? <Tag>{variableScopeLabels[row.scope]}</Tag>
              : <NativeSelect aria-label={`Action for ${row.name}`} disabled={disabled} value={own ? row.entry.kind === "unset" ? "unset" : "override" : "inherit"} onChange={event => {
                const action = event.currentTarget.value;
                if (action === "inherit" || action === "remove") change(row.name);
                else if (action === "unset") change(row.name, { kind: "unset" });
                else change(row.name, row.entry.kind === "unset" ? parent?.entry.kind !== "unset" && parent?.entry ? parent.entry : { kind: "literal", value: "" } : row.entry);
              }}>
                <option value="inherit" disabled={!parent}>{own ? "Reset to inherited" : "Inherited"}</option>
                <option value="override">{own && !parent ? "Defined here" : "Override"}</option>
                <option value="unset">Unset here</option>
                {own && !parent && <option value="remove">Remove</option>}
              </NativeSelect>}</div>
          </div>
          {open && <div className="environment-variable-history" role="row"><div role="cell" aria-label={`Sources for ${row.name}`}>
            {row.history.map(item => <p key={item.scope}><span>{variableScopeLabels[item.scope]}</span><VariableValue entry={item.entry} /></p>)}
          </div></div>}
        </div>;
      })}
      {rows.length === 0 && <p className="environment-variable-empty">No user-supplied variables.</p>}
    </div>
    <div className="environment-variable-footer">
      <small>{effectiveCount} {effectiveCount === 1 ? "variable" : "variables"}{unsetCount ? ` · ${unsetCount} explicitly unset` : ""}</small>
      {!readOnly && !adding && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { setAdding(true); setError(""); }}><Plus />Add variable</Button>}
    </div>
    {adding && !readOnly && <div className="environment-variable-add" role="group" aria-label="New variable">
      <Field label="Variable name" error={nameError ? <span role="alert">{nameError}</span> : undefined}>
        <Input aria-label="New variable name" autoComplete="off" spellCheck={false} value={name} disabled={disabled} className="font-mono"
          onChange={event => { setName(event.currentTarget.value); setNameError(undefined); }}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
      </Field>
      <VariableValueEditor name="new variable" value={entry} disabled={disabled} onChange={setEntry} />
      <div className="environment-variable-add-actions">
        <Button type="button" variant="outline" size="sm" onClick={closeAdd}>Cancel</Button>
        <Button type="button" size="sm" disabled={disabled || !name} onClick={add}>Add</Button>
      </div>
    </div>}
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
    <p className="environment-variable-help">{readOnly ? "Secret values are not shown here. Expand a variable to see its saved sources."
      : "Unset removes a variable; an empty value keeps it present. Secret references are resolved on the execution host."}</p>
  </div>;
}

function VariableValue({ entry }: { readonly entry: VariableEntry }) {
  return entry.kind === "secret" ? <span className="environment-variable-secret"><LockKeyhole aria-hidden="true" /><span><span aria-label="Secret value hidden">••••••••</span><small>{variableEntryLabel(entry)}</small></span></span>
    : <code className="environment-variable-literal" data-kind={entry.kind}>{variableEntryLabel(entry)}</code>;
}

function VariableValueEditor({ name, value, disabled, onChange }: { readonly name: string; readonly value: VariableEntry; readonly disabled: boolean; readonly onChange: (entry: VariableEntry) => void }) {
  const kind = value.kind === "secret" ? value.source.kind : "literal";
  const text = value.kind === "literal" ? value.value : value.kind === "secret" ? value.source.kind === "environment" ? value.source.name : value.source.path : "";
  return <div className="environment-variable-value-editor">
    <NativeSelect aria-label={`Value type for ${name}`} value={kind} disabled={disabled} onChange={event => {
      const next = event.currentTarget.value;
      onChange(next === "literal" ? { kind: "literal", value: "" } : next === "environment" ? { kind: "secret", source: { kind: "environment", name: "SECRET_NAME" } } : { kind: "secret", source: { kind: "protected_file", path: "/path/to/secret" } });
    }}>
      <option value="literal">Literal value</option><option value="environment">Environment reference</option><option value="protected_file">Protected file</option>
    </NativeSelect>
    <Input aria-label={`${kind === "literal" ? "Value" : "Secret reference"} for ${name}`} disabled={disabled} value={text} autoComplete="off" spellCheck={false} className="font-mono"
      onChange={event => {
        const next = event.currentTarget.value;
        onChange(kind === "literal" ? { kind: "literal", value: next } : kind === "environment" ? { kind: "secret", source: { kind, name: next } } : { kind: "secret", source: { kind, path: next } });
      }} />
  </div>;
}
