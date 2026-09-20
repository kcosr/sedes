import { useId, useState } from "react";
import { ChevronRight, LockKeyhole, Plus } from "lucide-react";
import { environmentVariableOverridesSchema, type EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { variableEntryLabel, variableRows, variableScopeLabels, type VariableEntry, type VariableLayer, type VariableScope } from "./environment-variable-presentation.js";
import "./environment-variables.css";

export function EnvironmentVariableEditor({ scope, inherited = [], value, onChange, readOnly = false, disabled = false }: {
  readonly scope: VariableScope;
  readonly inherited?: readonly VariableLayer[];
  readonly value: EnvironmentVariableOverrides;
  readonly onChange?: (value: EnvironmentVariableOverrides) => void;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const id = useId();
  const [expanded, setExpanded] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [entry, setEntry] = useState<VariableEntry>({ kind: "literal", value: "" });
  const [error, setError] = useState("");
  const layers = [...inherited, { scope, values: value }];
  const rows = variableRows(layers);
  const effectiveCount = rows.filter(row => row.entry.kind !== "unset").length;
  const inheritedByName = new Map(variableRows(inherited).map(row => [row.name.toUpperCase(), row]));
  const change = (variable: string, next?: VariableEntry) => {
    const proposed = Object.fromEntries(Object.entries(value).filter(([key]) => key.toUpperCase() !== variable.toUpperCase()));
    if (next) Object.defineProperty(proposed, variable, { value: next, enumerable: true, writable: true, configurable: true });
    const parsed = environmentVariableOverridesSchema.safeParse(proposed);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid environment variable.");
      return false;
    }
    setError("");
    onChange?.(parsed.data);
    return true;
  };
  const add = () => {
    if (rows.some(row => row.name.toUpperCase() === name.toUpperCase())) { setError("This variable already exists. Override its row instead."); return; }
    if (change(name, entry)) { setAdding(false); setName(""); setEntry({ kind: "literal", value: "" }); }
  };
  return <div className="environment-variable-editor">
    <p className="environment-variable-inheritance" aria-label="Variable precedence">
      {layers.map((layer, index) => <span key={layer.scope}>{index > 0 && <ChevronRight size={12} aria-hidden="true" />}{variableScopeLabels[layer.scope]}</span>)}
    </p>
    <div className="environment-variable-table" role="table" aria-label="Environment variables">
      <div className="environment-variable-table-heading" role="row"><span role="columnheader">Variable</span><span role="columnheader">Effective value</span><span role="columnheader">{readOnly ? "Source" : "Action"}</span></div>
      {rows.map(row => {
        const own = row.scope === scope;
        const parent = inheritedByName.get(row.name.toUpperCase());
        return <div key={row.name} role="rowgroup">
          <div className="environment-variable-row" role="row">
            <div role="cell" className="environment-variable-name"><Button type="button" variant="ghost" size="sm" aria-label={`Show sources for ${row.name}`} aria-expanded={expanded === row.name} onClick={() => setExpanded(expanded === row.name ? undefined : row.name)}><ChevronRight size={12} className={expanded === row.name ? "expanded" : ""} /><code>{row.name}</code></Button>
              <small>{row.entry.kind === "unset" ? `Excluded by ${variableScopeLabels[row.scope].toLowerCase()}` : own ? parent ? `Overrides ${variableScopeLabels[parent.scope].toLowerCase()}` : "Defined here" : `Inherited from ${variableScopeLabels[row.scope].toLowerCase()}`}</small></div>
            <div role="cell" className="environment-variable-value">{!readOnly && own && row.entry.kind !== "unset"
              ? <VariableValueEditor name={row.name} value={row.entry} disabled={disabled} onChange={next => change(row.name, next)} />
              : <VariableValue entry={row.entry} />}</div>
            <div role="cell">{readOnly ? <span className="environment-variable-source">{variableScopeLabels[row.scope]}</span> : <select aria-label={`Action for ${row.name}`} disabled={disabled} value={own ? row.entry.kind === "unset" ? "unset" : "override" : "inherit"} onChange={event => {
              if (event.target.value === "inherit" || event.target.value === "remove") change(row.name);
              else if (event.target.value === "unset") change(row.name, { kind: "unset" });
              else change(row.name, row.entry.kind === "unset" ? parent?.entry.kind !== "unset" && parent?.entry ? parent.entry : { kind: "literal", value: "" } : row.entry);
            }}>
              <option value="inherit" disabled={!parent}>{own ? "Reset to inherited" : "Inherited"}</option>
              <option value="override">{own && !parent ? "Defined here" : "Override"}</option>
              <option value="unset">Unset here</option>
              {own && !parent && <option value="remove">Remove</option>}
            </select>}</div>
          </div>
          {expanded === row.name && <div className="environment-variable-history" role="row"><div role="cell" aria-label={`Sources for ${row.name}`}>{row.history.map(item => <p key={item.scope}><strong>{variableScopeLabels[item.scope]}</strong><VariableValue entry={item.entry} /></p>)}</div></div>}
        </div>;
      })}
      {rows.length === 0 && <p className="environment-variable-empty">No user-supplied variables.</p>}
    </div>
    <div className="environment-variable-actions"><small>{effectiveCount} {effectiveCount === 1 ? "variable" : "variables"}{rows.some(row => row.entry.kind === "unset") ? ` · ${rows.filter(row => row.entry.kind === "unset").length} explicitly unset` : ""}</small>{!readOnly && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { setAdding(!adding); setError(""); }}><Plus size={14} />Add variable</Button>}</div>
    {adding && !readOnly && <div className="environment-variable-add">
      <label htmlFor={`${id}-name`}>Variable name</label><Input id={`${id}-name`} aria-label="New variable name" autoComplete="off" spellCheck={false} value={name} disabled={disabled} onChange={event => setName(event.target.value)} />
      <VariableValueEditor name="new variable" value={entry} disabled={disabled} onChange={setEntry} />
      <div className="environment-variable-actions"><Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button><Button type="button" size="sm" disabled={disabled || !name} onClick={add}>Add</Button></div>
    </div>}
    {error && <p role="alert" className="environment-variable-error">{error}</p>}
    <p className="environment-variable-help">{readOnly ? "Secret values are not shown in this editor. Expand a variable to see its saved sources." : "Unset removes a variable; an empty value keeps it present. Sedes-managed names cannot be changed. Secret references are resolved on the execution host."}</p>
  </div>;
}

function VariableValue({ entry }: { readonly entry: VariableEntry }) {
  return entry.kind === "secret" ? <span className="environment-variable-secret"><LockKeyhole size={12} aria-hidden="true" /><span><span aria-label="Secret value hidden">••••••••</span><small>{variableEntryLabel(entry)}</small></span></span> : <code>{variableEntryLabel(entry)}</code>;
}

function VariableValueEditor({ name, value, disabled, onChange }: { readonly name: string; readonly value: VariableEntry; readonly disabled: boolean; readonly onChange: (entry: VariableEntry) => void }) {
  const kind = value.kind === "secret" ? value.source.kind : "literal";
  const text = value.kind === "literal" ? value.value : value.kind === "secret" ? value.source.kind === "environment" ? value.source.name : value.source.path : "";
  return <div className="environment-variable-value-editor">
    <select aria-label={`Value type for ${name}`} value={kind} disabled={disabled} onChange={event => onChange(event.target.value === "literal" ? { kind: "literal", value: "" } : event.target.value === "environment" ? { kind: "secret", source: { kind: "environment", name: "SECRET_NAME" } } : { kind: "secret", source: { kind: "protected_file", path: "/path/to/secret" } })}>
      <option value="literal">Literal value</option><option value="environment">Environment reference</option><option value="protected_file">Protected file reference</option>
    </select>
    <Input aria-label={`${kind === "literal" ? "Value" : "Secret reference"} for ${name}`} disabled={disabled} value={text} autoComplete="off" spellCheck={false} onChange={event => onChange(kind === "literal" ? { kind: "literal", value: event.target.value } : kind === "environment" ? { kind: "secret", source: { kind, name: event.target.value } } : { kind: "secret", source: { kind, path: event.target.value } })} />
  </div>;
}
