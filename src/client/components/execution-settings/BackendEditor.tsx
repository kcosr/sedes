import type { ReactNode, Ref } from "react";
import { Plus } from "lucide-react";
import { ConfiguredEnvironmentVariableEditor } from "../environment-variables/ConfiguredEnvironmentVariableEditor.js";
import { SaveBar } from "../settings/SaveBar.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { SwitchField } from "../settings/SettingsField.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { Tag } from "../ui/tag.js";
import { allowedEnvironments, backendEditors } from "./backend-editors.js";
import { SettingsEditor, type SettingsEditorSection } from "../settings/SettingsSplit.js";
import { GeneralErrors } from "./detail-parts.js";
import { CollapsibleItem, ReadOnlyField, SelectField, TextField } from "./fields.js";
import { ModelPolicyEditor } from "./ModelPolicyEditor.js";
import type { BackendDefinition, Configuration, TargetDefinition } from "./types.js";
import type { MappedErrors } from "./validation.js";

export interface BackendDraft {
  readonly creating: boolean;
  readonly backend: BackendDefinition;
  readonly targets: TargetDefinition[];
  readonly defaultTargetId: string | null;
}

/** The fields the backend editor shows a control for, relative to the backend. */
export const backendFields = /^(label|enabled|moduleConfiguration\..+|modelPolicy(\..+)?|environmentVariables(\..+)?|targets\.[^.]+(\..+)?)$/u;

/** Whether the draft's backend type can run in its environment; saving is blocked while it cannot. */
export function backendDraftEligibility(draft: BackendDraft, configuration: Configuration) {
  const environmentId = draft.targets[0]?.executionEnvironmentId ?? "";
  const environment = configuration.executionEnvironments.find(entry => entry.id === environmentId);
  const eligibleKinds = (Object.keys(backendEditors) as BackendDefinition["kind"][]).filter(kind =>
    environment && allowedEnvironments(backendEditors[kind].createBackend("eligibility"), [environment]).length > 0);
  const unsupported = !eligibleKinds.includes(draft.backend.kind);
  const invalid = !environment || (unsupported && (draft.creating || draft.backend.enabled || draft.targets.some(target => target.enabled)));
  return { environmentId, environment, eligibleKinds, unsupported, invalid };
}

export function BackendEditor({ draft, setDraft, configuration, errors, disabled, saving, dirty, savedAt, saveError, saveDisabled, back, headingRef, onSave, onCancel }: {
  readonly draft: BackendDraft;
  readonly setDraft: (draft: BackendDraft) => void;
  readonly configuration: Configuration;
  readonly errors: MappedErrors;
  /** The form is read-only while the configuration loads or saves. */
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly savedAt?: number;
  readonly saveError?: ReactNode;
  /** Save is unavailable for a page-level reason (a stale revision, a pending read). */
  readonly saveDisabled: boolean;
  readonly back: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const selectedEditor = backendEditors[draft.backend.kind];
  const { environmentId, environment, eligibleKinds, unsupported, invalid } = backendDraftEligibility(draft, configuration);
  const fields = errors.fields;
  const changeKind = (kind: BackendDefinition["kind"]) => {
    if (!eligibleKinds.includes(kind)) return;
    const editor = backendEditors[kind];
    const backend = { ...editor.createBackend(draft.backend.id), label: draft.backend.label };
    const target = editor.createTarget(crypto.randomUUID(), backend.id, environmentId);
    const ownDefault = draft.targets.some(entry => entry.id === draft.defaultTargetId);
    setDraft({ creating: true, backend, targets: [target], defaultTargetId: ownDefault ? target.id : draft.defaultTargetId });
  };
  const chooseEnvironment = (executionEnvironmentId: string) => {
    if (!configuration.executionEnvironments.some(entry => entry.id === executionEnvironmentId)) return;
    // Never silently change provider or host. An incompatible provider remains visible
    // with saving blocked until the user selects a supported type.
    setDraft({ ...draft, targets: draft.targets.map(entry => ({ ...entry, executionEnvironmentId })) });
  };
  const policy = selectedEditor.renderPolicy?.({ value: draft.backend, onChange: backend => setDraft({ ...draft, backend }), errors: fields, disabled });
  const sections: SettingsEditorSection[] = [
    { id: "backend-general", label: "General" }, { id: "backend-connection", label: "Connection" },
    ...(policy ? [{ id: "backend-policy", label: "Policy" }] : []),
    { id: "backend-models", label: "Models" }, { id: "backend-connections", label: "Connections" }, { id: "backend-variables", label: "Variables" },
  ];
  const totalTargets = configuration.targets.length - configuration.targets.filter(entry => entry.backendInstanceId === draft.backend.id).length + draft.targets.length;
  return <SettingsEditor label="Backend editor" back={back} headingRef={headingRef} className="execution-editor-wide"
    title={draft.creating ? "New backend" : `Edit ${draft.backend.label || "backend"}`}
    description="Saving does not start model work. Disruptive changes stay pending until they can apply safely or you restart the backend."
    sections={sections} errors={<GeneralErrors errors={errors.general} />} onSubmit={onSave}
    saveBar={<SaveBar creating={draft.creating} dirty={dirty} saving={saving} savedAt={savedAt} error={saveError} onCancel={onCancel}
      saveLabel="Save backend" saveDisabled={saveDisabled || invalid} />}>
    <SettingsSection id="backend-general" title="General" card>
      <TextField label="Backend name" required disabled={disabled} value={draft.backend.label} error={fields.get("label")}
        onChange={(label) => setDraft({ ...draft, backend: { ...draft.backend, label } })} />
      {draft.creating ? <SelectField label="Execution environment" disabled={disabled} value={environmentId}
        options={[{ value: "", label: "Choose an environment", disabled: true }, ...configuration.executionEnvironments.map(entry => ({ value: entry.id, label: entry.label }))]}
        description="All connections for this backend use this environment." onChange={chooseEnvironment} />
        : <ReadOnlyField label="Execution environment" value={environment?.label ?? "Environment unavailable"}
          description="A backend keeps its environment. Add a new backend to use a different host." />}
      {draft.creating ? <SelectField label="Backend type" disabled={disabled} value={draft.backend.kind} description={selectedEditor.description}
        options={(Object.entries(backendEditors) as Array<[BackendDefinition["kind"], typeof selectedEditor]>).map(([value, editor]) => ({ value, label: editor.label, disabled: !eligibleKinds.includes(value) }))}
        onChange={changeKind} />
        : <ReadOnlyField label="Backend type" value={selectedEditor.label} description={selectedEditor.description} />}
      {!environment ? <Callout tone="info" role="status">Choose an execution environment to select a supported backend type.</Callout>
        : draft.creating && unsupported ? <Callout tone="danger" role="alert">This provider is not supported in {environment.label}. Choose a supported backend type.</Callout> : null}
      <SwitchField label="Backend enabled" checked={draft.backend.enabled} disabled={disabled || unsupported} error={fields.get("enabled")}
        description="Disabling also disables its connections and clears their new-thread default. Existing history is retained."
        onCheckedChange={(enabled) => {
          const ownDefault = draft.targets.some((target) => target.id === draft.defaultTargetId);
          setDraft({ ...draft, backend: { ...draft.backend, enabled }, targets: enabled ? draft.targets : draft.targets.map((target) => ({ ...target, enabled: false })),
            defaultTargetId: !enabled && ownDefault ? null : draft.defaultTargetId });
        }} />
    </SettingsSection>
    <SettingsSection id="backend-connection" title="Connection" description="How Sedes reaches the provider." card>
      {selectedEditor.renderConnection({ value: draft.backend, onChange: backend => setDraft({ ...draft, backend }), errors: fields, disabled })}
    </SettingsSection>
    {policy ? <SettingsSection id="backend-policy" title="Policy" description="Connection defaults and thread selections must stay within these values." card>{policy}</SettingsSection> : null}
    <SettingsSection id="backend-models" title="Models" card>
      <ModelPolicyEditor value={draft.backend.modelPolicy} supportsProviderIds={selectedEditor.supportsProviderIds} disabled={disabled}
        errors={fields.scope("modelPolicy")} onChange={(modelPolicy) => setDraft({ ...draft, backend: { ...draft.backend, modelPolicy } })} />
    </SettingsSection>
    <SettingsSection id="backend-connections" title="Connections" description="Named defaults that new threads can start with."
      actions={<Button type="button" size="sm" variant="outline" disabled={disabled || totalTargets >= 64} onClick={() => {
        const target = selectedEditor.createTarget(crypto.randomUUID(), draft.backend.id, environmentId || allowedEnvironments(draft.backend, configuration.executionEnvironments)[0]?.id || "");
        setDraft({ ...draft, targets: [...draft.targets, { ...target, label: `Connection ${draft.targets.length + 1}`, enabled: draft.backend.enabled }] });
      }}><Plus />Add connection</Button>} card>
      <div className="execution-items">
        {draft.targets.map((target, index) => {
          const eligible = allowedEnvironments(draft.backend, configuration.executionEnvironments);
          const targetEnvironment = configuration.executionEnvironments.find((entry) => entry.id === target.executionEnvironmentId);
          const retainedUnsupported = Boolean(targetEnvironment && !eligible.some((entry) => entry.id === targetEnvironment.id));
          const targetErrors = fields.scope(`targets.${target.id}`);
          const targetError = fields.get(`targets.${target.id}`);
          const updateTarget = (next: TargetDefinition) => setDraft({ ...draft, targets: draft.targets.map((entry) => entry.id === target.id ? next : entry) });
          const isDefault = draft.defaultTargetId === target.id;
          return <CollapsibleItem key={target.id} title={target.label || `Connection ${index + 1}`}
            summary={selectedEditor.summarizeTarget(target)} defaultOpen={draft.targets.length === 1 || draft.creating}
            forceOpen={Boolean(targetError || targetErrors.size)}
            tags={<>{isDefault ? <Tag>Default</Tag> : null}{target.enabled ? null : <Tag>Disabled</Tag>}</>}
            actions={<Button type="button" size="sm" variant="ghost" disabled={disabled || draft.targets.length === 1}
              onClick={() => setDraft({ ...draft, targets: draft.targets.filter((entry) => entry.id !== target.id), defaultTargetId: isDefault ? null : draft.defaultTargetId })}>Remove connection {index + 1}</Button>}>
            {targetError ? <Callout tone="danger">{targetError}</Callout> : null}
            {retainedUnsupported ? <Callout tone="warning" role="status">This retained remote connection is unsupported and must remain disabled.</Callout> : null}
            <TextField label="Connection name" required disabled={disabled} value={target.label} error={targetErrors.get("label")} onChange={(label) => updateTarget({ ...target, label })} />
            <SwitchField label="Connection enabled" checked={target.enabled} disabled={disabled || !draft.backend.enabled || retainedUnsupported} error={targetErrors.get("enabled")}
              onCheckedChange={(enabled) => setDraft({ ...draft, targets: draft.targets.map((entry) => entry.id === target.id ? { ...entry, enabled } : entry), defaultTargetId: !enabled && isDefault ? null : draft.defaultTargetId })} />
            <SwitchField label="Default for new threads" checked={isDefault} disabled={disabled || !target.enabled || !draft.backend.enabled}
              description="Used when a new thread does not choose a connection."
              onCheckedChange={(enabled) => setDraft({ ...draft, defaultTargetId: enabled ? target.id : null })} />
            {selectedEditor.renderTarget({ value: target, onChange: updateTarget, errors: targetErrors, disabled })}
          </CollapsibleItem>;
        })}
      </div>
    </SettingsSection>
    <SettingsSection id="backend-variables" title="Environment variables" card>
      <ConfiguredEnvironmentVariableEditor scope="backend" value={draft.backend.environmentVariables} inherited={environment?.environmentVariables} disabled={disabled}
        error={fields.under("environmentVariables")}
        startupUnavailableReason={draft.backend.kind === "pi" ? "Pi runs in the Sedes process and has no owned backend startup environment."
          : draft.backend.kind === "codex_app_server" && draft.backend.moduleConfiguration.connection.ownership === "external" ? "Sedes does not start the externally owned Codex process." : undefined}
        onChange={(environmentVariables) => setDraft({ ...draft, backend: { ...draft.backend, environmentVariables } })} />
    </SettingsSection>
  </SettingsEditor>;
}
