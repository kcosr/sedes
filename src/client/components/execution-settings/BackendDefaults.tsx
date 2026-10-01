import { useEffect, useId, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { SettingsSection } from "../settings/SettingsSection.js";
import { SwitchField } from "../settings/SettingsField.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { AdvancedGroup, SelectField, TextField } from "./fields.js";
import type { Configuration } from "./types.js";
import type { MappedErrors } from "./validation.js";

export interface DefaultsDraft {
  readonly defaultTargetId: string;
  readonly webSearch: Configuration["webSearch"];
}

export const defaultsFields = /^(defaultTargetId|webSearch(\..+)?)$/u;

export function defaultsOf(configuration: Configuration): DefaultsDraft {
  return { defaultTargetId: configuration.defaultTargetId ?? "", webSearch: configuration.webSearch };
}

export function connectionLabel(configuration: Configuration, targetId: string | null): string {
  const target = configuration.targets.find(entry => entry.id === targetId);
  if (!target) return "No default — choose a connection";
  const environment = configuration.executionEnvironments.find(entry => entry.id === target.executionEnvironmentId);
  const backend = configuration.backends.find(entry => entry.id === target.backendInstanceId);
  return `${environment?.label ?? "Environment unavailable"} / ${backend?.label ?? "Backend unavailable"} / ${target.label}`;
}

/**
 * Account-wide defaults pinned above the backend list: the connection new
 * threads start with, and the local research tool. Changes save together.
 */
export function BackendDefaults({ configuration, value, onChange, dirty, saving, savedAt, errors, error, disabled, onSave, onCancel }: {
  readonly configuration: Configuration;
  readonly value: DefaultsDraft;
  readonly onChange: (value: DefaultsDraft) => void;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly savedAt?: number;
  readonly errors: MappedErrors;
  /** The server's reason the last save failed. */
  readonly error?: string;
  readonly disabled: boolean;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const gridId = useId();
  useEffect(() => {
    if (savedAt === undefined) return;
    setSaved(true);
    const timer = window.setTimeout(() => setSaved(false), 2_500);
    return () => window.clearTimeout(timer);
  }, [savedAt]);
  const options = configuration.targets.filter(target => target.enabled && configuration.backends.some(backend => backend.id === target.backendInstanceId && backend.enabled));
  const general = errors.general.map(error => error.location ? `${error.location}: ${error.message}` : error.message).join(" ");
  // Narrow, the defaults fold into one summary row so the list stays in view.
  const open = expanded || dirty || saving || Boolean(error) || errors.fields.size > 0 || errors.general.length > 0;
  const summary = `New threads use ${connectionLabel(configuration, value.defaultTargetId || null)} · Research ${value.webSearch ? "on" : "off"}`;
  return <form className="execution-defaults" data-stack="list" data-open={open} aria-label="Backend defaults" noValidate onSubmit={event => { event.preventDefault(); onSave(); }}>
    <SettingsSection title="Defaults" description="These apply across all environments for this account." card
      actions={dirty || saving ? <>
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={disabled || saving}>{saving ? "Saving…" : "Save defaults"}</Button>
      </> : saved ? <span className="execution-saved" role="status"><Check aria-hidden="true" />Saved</span> : null}>
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      <button type="button" className="execution-defaults-summary" aria-expanded={open} aria-controls={gridId}
        onClick={() => setExpanded(!open)}><ChevronRight aria-hidden="true" /><span>{summary}</span></button>
      <div id={gridId} className="execution-defaults-grid">
        <SelectField label="Default connection for new threads" layout="stacked" disabled={disabled || saving} value={value.defaultTargetId}
          error={errors.fields.get("defaultTargetId") ?? (general || undefined)}
          options={[{ value: "", label: "No default — choose a connection" }, ...options.map(target => ({ value: target.id, label: connectionLabel(configuration, target.id) }))]}
          onChange={defaultTargetId => onChange({ ...value, defaultTargetId })} />
        <div className="execution-defaults-research">
          <SwitchField label="Grok CLI research" description="A local research tool on the Sedes host. Authentication stays host-managed."
            checked={value.webSearch !== null} disabled={disabled || saving}
            onCheckedChange={enabled => onChange({ ...value, webSearch: enabled ? { provider: "grok_cli" } : null })} />
          {value.webSearch ? <AdvancedGroup summary="Grok home directory" defaultOpen={Boolean(value.webSearch.grokHome)} forceOpen={Boolean(errors.fields.under("webSearch"))}>
            <TextField label="Grok home directory" layout="stacked" mono disabled={disabled || saving} value={value.webSearch.grokHome ?? ""} error={errors.fields.under("webSearch")}
              description="Optional native configuration directory on the Sedes host."
              onChange={grokHome => onChange({ ...value, webSearch: { provider: "grok_cli", grokHome: grokHome || undefined } })} />
          </AdvancedGroup> : null}
        </div>
      </div>
    </SettingsSection>
  </form>;
}
