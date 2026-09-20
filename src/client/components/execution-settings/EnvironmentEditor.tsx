import { ConfiguredEnvironmentVariableEditor } from "../environment-variables/ConfiguredEnvironmentVariableEditor.js";
import { Button } from "../ui/button.js";
import { TextField, TextListField, SelectField, Toggle } from "./fields.js";
import { SidecarCapabilitiesField } from "./SidecarCapabilitiesField.js";
import { hostPlatform } from "./PendingHosts.js";
import type { Configuration, EnvironmentDefinition } from "./types.js";

export function EnvironmentEditor({ draft, setDraft, creating, configuration, saving, loading, pending, onSave, onCancel }: {
  readonly draft: EnvironmentDefinition;
  readonly setDraft: (draft: EnvironmentDefinition) => void;
  readonly creating: boolean;
  readonly configuration: Configuration;
  readonly saving: boolean;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly onSave: () => Promise<void>;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return <section className="execution-settings-editor" aria-label="Environment editor"><form onSubmit={(event) => { event.preventDefault(); void onSave(); }}>
          <h4>{creating ? "New environment" : `Edit ${draft.label || "environment"}`}</h4>
          <fieldset disabled={saving || loading}>
            <legend>Environment details</legend>
            <TextField autoFocus label="Environment name" value={draft.label} required onChange={(label) => setDraft({ ...draft, label })} />
            <SelectField label="Environment type" value={draft.kind} disabled={!creating} options={[
              { value: "local", label: "Local machine", disabled: creating && configuration.executionEnvironments.some((entry) => entry.kind === "local") },
              { value: "ssh", label: "Remote host over SSH" },
              ...(draft.kind === "outbound" ? [{ value: "outbound" as const, label: "Paired outbound host" }] : []),
            ]} onChange={(kind) => {
              if (kind === "outbound") return;
              const common = { id: draft.id, label: draft.label, workspaceRoots: [] };
              setDraft(kind === "ssh" ? { ...common, kind, hostAlias: "", operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files"] } }
                : { ...common, kind, workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } });
            }} />
            {draft.kind === "ssh" ? <TextField label="SSH host alias" required disabled={!creating} value={draft.hostAlias}
              description="An existing SSH alias on the Sedes server. Keys and host trust stay in its SSH configuration. Use a new environment for a different host."
              onChange={(hostAlias) => setDraft({ ...draft, hostAlias })} /> : null}
            {draft.kind === "outbound" ? <p className="execution-settings-muted">Pairing {draft.pairingId} · {hostPlatform(draft.platform)}. Installation identity is fixed; accept a new host to use a different installation.</p> : null}
            <TextListField label="Workspace roots" value={draft.workspaceRoots} onChange={(workspaceRoots) => setDraft({ ...draft, workspaceRoots })}
              description="One allowed absolute directory per line, on the selected execution host." />
            <ConfiguredEnvironmentVariableEditor scope="environment" value={draft.environmentVariables} onChange={(environmentVariables) => setDraft({ ...draft, environmentVariables })} />
            {draft.kind === "local" ? <Toggle label="Allow isolated workspaces to use the execution host network"
              checked={draft.workspaceIsolation.networkProfiles.some((profile) => profile === "execution_host")}
              onChange={(enabled) => setDraft({ ...draft, workspaceIsolation: { kind: "bubblewrap", networkProfiles: enabled ? ["isolated", "execution_host"] : ["isolated"] } })} /> : <>
              <Toggle label="Enable sidecar operations" checked={draft.operations.kind === "sidecar"}
                onChange={(enabled) => setDraft({ ...draft, operations: enabled ? { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files"] } : { kind: "none" } })} />
              {draft.operations.kind === "sidecar" ? <SidecarCapabilitiesField value={draft.operations.enabledCapabilities}
                onChange={(enabledCapabilities) => setDraft({ ...draft, operations: { kind: "sidecar", enabledCapabilities } })} /> : null}
            </>}
          </fieldset>
          <div className="execution-settings-actions execution-settings-save-bar"><Button type="submit" size="sm" disabled={pending}>Save environment</Button>
            <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onCancel}>Cancel</Button></div>
          {!creating ? <p className="execution-settings-muted">Disruptive changes remain pending until running work can safely retire or you explicitly restart it.</p> : null}
        </form></section>;
}
