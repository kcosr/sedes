import { ConfiguredEnvironmentVariableEditor } from "../environment-variables/ConfiguredEnvironmentVariableEditor.js";
import { Button } from "../ui/button.js";
import { TextField, SelectField, Toggle } from "./fields.js";
import { allowedEnvironments, backendEditors } from "./backend-editors.js";
import { ModelPolicyEditor } from "./ModelPolicyEditor.js";
import type { BackendDefinition, Configuration, TargetDefinition } from "./types.js";

export interface BackendDraft {
  readonly creating: boolean;
  readonly backend: BackendDefinition;
  readonly targets: TargetDefinition[];
  readonly defaultTargetId: string | null;
}

export function BackendEditor({ draft, setDraft, configuration, saving, loading, pending, onSave, onCancel }: {
  readonly draft: BackendDraft;
  readonly setDraft: (draft: BackendDraft) => void;
  readonly configuration: Configuration;
  readonly saving: boolean;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly onSave: () => Promise<void>;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const selectedEditor = backendEditors[draft.backend.kind];
  const environmentId = draft.targets[0]?.executionEnvironmentId ?? "";
  const environment = configuration.executionEnvironments.find(entry => entry.id === environmentId);
  const eligibleKinds = (Object.keys(backendEditors) as BackendDefinition["kind"][]).filter(kind =>
    environment && allowedEnvironments(backendEditors[kind].createBackend("eligibility"), [environment]).length > 0);
  const draftUnsupportedEnvironment = !eligibleKinds.includes(draft.backend.kind);
  const invalidEnvironment = !environment || (draftUnsupportedEnvironment
    && (draft.creating || draft.backend.enabled || draft.targets.some(target => target.enabled)));
  const changeKind = (kind: BackendDefinition["kind"], nextEnvironmentId: string) => {
    const editor = backendEditors[kind];
    const backend = { ...editor.createBackend(draft.backend.id), label: draft.backend.label };
    const target = editor.createTarget(crypto.randomUUID(), backend.id, nextEnvironmentId);
    const ownDefault = draft.targets.some(entry => entry.id === draft.defaultTargetId);
    setDraft({ creating: true, backend, targets: [target], defaultTargetId: ownDefault ? target.id : draft.defaultTargetId });
  };
  const chooseKind = (kind: BackendDefinition["kind"]) => {
    if (eligibleKinds.includes(kind)) changeKind(kind, environmentId);
  };
  const chooseEnvironment = (executionEnvironmentId: string) => {
    const nextEnvironment = configuration.executionEnvironments.find(entry => entry.id === executionEnvironmentId);
    if (!nextEnvironment) return;
    // Never silently change provider or host. An incompatible provider remains visible
    // with saving blocked until the user selects a supported type.
    setDraft({ ...draft, targets: draft.targets.map(entry => ({ ...entry, executionEnvironmentId })) });
  };
  return <section className="execution-settings-editor" aria-label="Backend editor"><form onSubmit={(event) => { event.preventDefault(); void onSave(); }}>
            <h4>{draft.creating ? "New backend" : `Edit ${draft.backend.label || "backend"}`}</h4>
            <fieldset disabled={saving || loading}><legend>Backend details</legend>
              <TextField autoFocus label="Backend name" value={draft.backend.label} required onChange={(label) => setDraft({ ...draft, backend: { ...draft.backend, label } })} />
              <SelectField label="Execution environment" value={environmentId} disabled={!draft.creating}
                options={[{ value: "", label: "Choose an environment", disabled: true }, ...configuration.executionEnvironments.map(entry => ({ value: entry.id, label: entry.label }))]}
                description={!draft.creating ? "An existing backend keeps its execution environment. Add a new backend to use a different host." : "All connections for this backend use this environment."}
                onChange={chooseEnvironment} />
              <SelectField label="Backend type" value={draft.backend.kind} disabled={!draft.creating}
                options={(Object.entries(backendEditors) as Array<[BackendDefinition["kind"], typeof selectedEditor]>).map(([value, editor]) => ({ value, label: editor.label, disabled: !eligibleKinds.includes(value) }))}
                onChange={chooseKind} />
              <p className="execution-settings-muted">{selectedEditor.description}</p>
              {!environment ? <p role="status">Choose an execution environment to select a supported backend type.</p>
                : draft.creating && draftUnsupportedEnvironment ? <p role="alert">This provider is not supported in {environment.label}. Choose a supported backend type.</p> : null}
              <Toggle label="Backend enabled" checked={draft.backend.enabled} disabled={draftUnsupportedEnvironment} onChange={(enabled) => {
                const ownDefault = draft.targets.some((target) => target.id === draft.defaultTargetId);
                setDraft({ ...draft, backend: { ...draft.backend, enabled }, targets: enabled ? draft.targets : draft.targets.map((target) => ({ ...target, enabled: false })),
                  defaultTargetId: !enabled && ownDefault ? null : draft.defaultTargetId });
              }} />
              <p className="execution-settings-muted">Disabling also disables its connections and clears their new-thread default. Existing history is retained.</p>
              {selectedEditor.renderBackend({ value: draft.backend, onChange: (backend) => setDraft({ ...draft, backend }) })}
              <ConfiguredEnvironmentVariableEditor scope="backend" value={draft.backend.environmentVariables} inherited={environment?.environmentVariables}
                startupUnavailableReason={draft.backend.kind === "pi" ? "Pi runs in the Sedes process and has no owned backend startup environment."
                  : draft.backend.kind === "codex_app_server" && draft.backend.moduleConfiguration.connection.ownership === "external" ? "Sedes does not start the externally owned Codex process." : undefined}
                onChange={(environmentVariables) => setDraft({ ...draft, backend: { ...draft.backend, environmentVariables } })} />
              <ModelPolicyEditor value={draft.backend.modelPolicy} supportsProviderIds={selectedEditor.supportsProviderIds}
                onChange={(modelPolicy) => setDraft({ ...draft, backend: { ...draft.backend, modelPolicy } })} />
              <fieldset className="execution-settings-form-section"><legend>Connections and defaults</legend>
                {draft.targets.map((target, index) => {
                  const eligible = allowedEnvironments(draft.backend, configuration.executionEnvironments);
                  const environment = configuration.executionEnvironments.find((entry) => entry.id === target.executionEnvironmentId);
                  const unsupported = environment && !eligible.some((entry) => entry.id === environment.id);
                  const updateTarget = (next: TargetDefinition) => setDraft({ ...draft, targets: draft.targets.map((entry) => entry.id === target.id ? next : entry) });
                  return <fieldset key={target.id}><legend>Connection {index + 1}</legend>
                    <TextField label="Connection name" value={target.label} required onChange={(label) => updateTarget({ ...target, label })} />
                    {unsupported ? <p role="alert">This retained remote connection is unsupported and must remain disabled.</p> : null}
                    <Toggle label="Connection enabled" checked={target.enabled} disabled={!draft.backend.enabled || Boolean(unsupported)} onChange={(enabled) => {
                      setDraft({ ...draft, targets: draft.targets.map((entry) => entry.id === target.id ? { ...entry, enabled } : entry), defaultTargetId: !enabled && draft.defaultTargetId === target.id ? null : draft.defaultTargetId });
                    }} />
                    <Toggle label="Default for new threads" checked={draft.defaultTargetId === target.id} disabled={!target.enabled || !draft.backend.enabled}
                      onChange={(enabled) => setDraft({ ...draft, defaultTargetId: enabled ? target.id : null })} />
                    {selectedEditor.renderTarget({ value: target, onChange: updateTarget })}
                    <Button type="button" size="sm" variant="outline" onClick={() => setDraft({ ...draft, targets: draft.targets.filter((entry) => entry.id !== target.id),
                      defaultTargetId: draft.defaultTargetId === target.id ? null : draft.defaultTargetId })} disabled={draft.targets.length === 1}>Remove connection {index + 1}</Button>
                  </fieldset>;
                })}
                <Button type="button" size="sm" variant="outline" disabled={configuration.targets.length - configuration.targets.filter((entry) => entry.backendInstanceId === draft.backend.id).length + draft.targets.length >= 64}
                  onClick={() => {
                    const environmentId = draft.targets[0]?.executionEnvironmentId ?? allowedEnvironments(draft.backend, configuration.executionEnvironments)[0]?.id ?? "";
                    const target = selectedEditor.createTarget(crypto.randomUUID(), draft.backend.id, environmentId);
                    setDraft({ ...draft, targets: [...draft.targets, { ...target, enabled: draft.backend.enabled }] });
                  }}>Add connection</Button>
              </fieldset>
            </fieldset>
            <div className="execution-settings-actions execution-settings-save-bar"><Button type="submit" size="sm" disabled={pending || invalidEnvironment}>Save backend</Button>
              <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button></div>
            <p className="execution-settings-muted">Saving does not submit model work. Disruptive changes remain pending until they can safely apply or you explicitly restart.</p>
          </form></section>;
}
