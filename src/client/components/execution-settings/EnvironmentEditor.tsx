import type { ReactNode, Ref } from "react";
import { Cable, Monitor, Server } from "lucide-react";
import { configurationSidecarCapabilities } from "../../../shared/protocol/configuration-admin.js";
import { settingsPath } from "../../app/router.js";
import { ConfiguredEnvironmentVariableEditor } from "../environment-variables/ConfiguredEnvironmentVariableEditor.js";
import { EntityList, EntityRow } from "../settings/EntityList.js";
import { SaveBar } from "../settings/SaveBar.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { SwitchField } from "../settings/SettingsField.js";
import { DetailHeader, EditorFrame, followLink, GeneralErrors, type EditorSection } from "./detail-parts.js";
import { hostPlatform } from "./ExecutionInventory.js";
import { CheckboxGroup, ListField, ReadOnlyField, TextField } from "./fields.js";
import type { Configuration, EnvironmentDefinition } from "./types.js";
import type { FieldErrors, MappedErrors } from "./validation.js";

type Capability = typeof configurationSidecarCapabilities[number];

export const environmentKindNames: Record<EnvironmentDefinition["kind"], string> = { local: "This machine", ssh: "SSH host", outbound: "Paired host" };

/** The fields the environment editor shows a control for, relative to the environment. */
export const environmentFields = /^(label|hostAlias|workspaceRoots(\.\d+)?|operations(\..+)?|workspaceIsolation(\..+)?|environmentVariables(\..+)?)$/u;

export const capabilityLabels: Record<Capability, string> = {
  directory_browser: "Directory browsing", workspace_files: "Files and comparisons",
  workspace_tools: "Workspace tools and context", workspace_context: "Workspace context",
  workspace_skills: "Workspace skills", composer_attachments: "Attachment staging",
  agent_tools_cli: "Sedes tools for remote agents", interactive_terminal: "Interactive terminals",
};
const defaultCapabilities: Capability[] = ["directory_browser", "workspace_files"];
const newTitles: Record<EnvironmentDefinition["kind"], string> = { local: "New local environment", ssh: "New SSH environment", outbound: "New environment" };

/** The operations a person chooses; workspace context always follows workspace tools. */
const capabilityOptions = configurationSidecarCapabilities.filter((capability) => capability !== "workspace_context")
  .map((capability) => ({ value: capability, label: capabilityLabels[capability] }));

export function SidecarCapabilities({ value, onChange, error, disabled = false }: {
  readonly value: readonly Capability[];
  readonly onChange: (value: Capability[]) => void;
  readonly error?: string;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return <CheckboxGroup label="Allowed operations" columns={2} disabled={disabled} error={error}
    value={value.filter((capability) => capability !== "workspace_context")} options={capabilityOptions}
    onChange={(selected) => {
      const next = new Set<Capability>(selected);
      if (next.has("workspace_tools")) next.add("workspace_context");
      onChange(configurationSidecarCapabilities.filter((entry) => next.has(entry)));
    }} />;
}

/** The sidecar operations of a remote host: an on/off switch and the allowed set. */
export function RemoteOperationsFields({ value, onChange, errors, disabled = false }: {
  readonly value: { readonly kind: "none" } | { readonly kind: "sidecar"; readonly enabledCapabilities: Capability[] };
  readonly onChange: (value: { kind: "none" } | { kind: "sidecar"; enabledCapabilities: Capability[] }) => void;
  readonly errors: FieldErrors;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return <>
    <SwitchField label="Enable sidecar operations" checked={value.kind === "sidecar"} disabled={disabled}
      description="A sidecar on the host serves files, tools and terminals for threads there."
      onCheckedChange={(enabled) => onChange(enabled ? { kind: "sidecar", enabledCapabilities: defaultCapabilities } : { kind: "none" })} />
    {value.kind === "sidecar" ? <SidecarCapabilities value={value.enabledCapabilities} disabled={disabled} error={errors.under("operations")}
      onChange={(enabledCapabilities) => onChange({ kind: "sidecar", enabledCapabilities })} /> : null}
  </>;
}

export function newEnvironment(kind: "local" | "ssh"): EnvironmentDefinition {
  return kind === "local"
    ? { id: crypto.randomUUID(), label: "", kind: "local", workspaceRoots: [], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }
    : { id: crypto.randomUUID(), label: "", kind: "ssh", hostAlias: "", workspaceRoots: [], operations: { kind: "sidecar", enabledCapabilities: defaultCapabilities } };
}

/** The first step of adding an environment: what kind of host it is. */
export function EnvironmentChooser({ configuration, back, headingRef }: {
  readonly configuration: Configuration;
  readonly back: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
}): React.JSX.Element {
  const hasLocal = configuration.executionEnvironments.some((entry) => entry.kind === "local");
  const choice = (kind: "local" | "ssh" | "pair") => settingsPath("environments", { mode: "new", resourceId: kind });
  return <section aria-label="Add environment" className="execution-editor">
    <DetailHeader back={back} title="Add environment" headingRef={headingRef} description="Choose where agents will run." />
    <div data-slot="settings-section-body" data-card="true">
      <EntityList aria-label="Environment kinds">
        <EntityRow icon={<Monitor />} title="Local machine" disabled={hasLocal}
          subtitle={hasLocal ? "Already added. Each account has one local environment." : "Workspace access on the Sedes host."}
          href={choice("local")} onSelect={(event) => followLink(event, choice("local"))} />
        <EntityRow icon={<Server />} title="SSH host" subtitle="Connect with an SSH alias configured on the Sedes server."
          href={choice("ssh")} onSelect={(event) => followLink(event, choice("ssh"))} />
        <EntityRow icon={<Cable />} title="Pair a host" subtitle="Run a connector on the host, then approve its workspace access."
          href={choice("pair")} onSelect={(event) => followLink(event, choice("pair"))} />
      </EntityList>
    </div>
  </section>;
}

export function EnvironmentEditor({ draft, setDraft, creating, errors, disabled, saving, dirty, savedAt, saveError, saveDisabled, back, headingRef, onSave, onCancel }: {
  readonly draft: EnvironmentDefinition;
  readonly setDraft: (draft: EnvironmentDefinition) => void;
  readonly creating: boolean;
  readonly errors: MappedErrors;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly savedAt?: number;
  readonly saveError?: ReactNode;
  readonly saveDisabled: boolean;
  readonly back: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const fields = errors.fields;
  const sections: EditorSection[] = [
    { id: "environment-general", label: "General" }, { id: "environment-access", label: "Access" },
    { id: "environment-operations", label: "Operations" }, { id: "environment-variables", label: "Variables" },
  ];
  const rootErrors = draft.workspaceRoots.map((_, index) => fields.get(`workspaceRoots.${index}`));
  return <EditorFrame label="Environment editor" back={back} headingRef={headingRef}
    title={creating ? newTitles[draft.kind] : `Edit ${draft.label || "environment"}`}
    description={creating ? undefined : "Disruptive changes stay pending until running work can retire or you restart it."}
    sections={sections} errors={<GeneralErrors errors={errors.general} />} onSubmit={onSave}
    saveBar={<SaveBar dirty={creating || dirty} saving={saving} savedAt={savedAt} error={saveError} onCancel={onCancel}
      saveLabel="Save environment" saveDisabled={saveDisabled} />}>
    <SettingsSection id="environment-general" title="General" card>
      <TextField label="Environment name" required disabled={disabled} value={draft.label} error={fields.get("label")}
        description="Shown in the sidebar and pickers." onChange={(label) => setDraft({ ...draft, label })} />
      <ReadOnlyField label="Environment type" value={environmentKindNames[draft.kind]} locked={!creating} />
      {draft.kind === "ssh" ? creating
        ? <TextField label="SSH host alias" mono required disabled={disabled} value={draft.hostAlias} error={fields.get("hostAlias")}
          description="An existing SSH alias on the Sedes server. Keys and host trust stay in its SSH configuration."
          onChange={(hostAlias) => setDraft({ ...draft, hostAlias })} />
        : <ReadOnlyField label="SSH host alias" mono value={draft.hostAlias} description="Add a new environment for a different host." /> : null}
      {draft.kind === "outbound" ? <ReadOnlyField label="Platform" value={hostPlatform(draft.platform)}
        description="The installation is fixed. Accept a new host to use a different installation." /> : null}
    </SettingsSection>
    <SettingsSection id="environment-access" title="Workspace access" card>
      <ListField label="Workspace roots" itemLabel="Workspace root" addLabel="Add root" disabled={disabled}
        placeholder={draft.kind === "outbound" && draft.platform === "win32" ? "C:\\Projects" : "/home/you/projects"}
        description={draft.kind === "outbound" && draft.platform === "win32" ? "Absolute Windows folders agents may open, for example C:\\Projects." : "Absolute folders on the execution host that agents may open."}
        value={draft.workspaceRoots} error={fields.get("workspaceRoots")} itemErrors={rootErrors}
        onChange={(workspaceRoots) => setDraft({ ...draft, workspaceRoots })} />
    </SettingsSection>
    <SettingsSection id="environment-operations" title="Operations" card>
      {draft.kind === "local" ? <SwitchField label="Allow isolated workspaces to use the host network" disabled={disabled}
        description="Isolated workspaces are offline unless this is on." error={fields.under("workspaceIsolation")}
        checked={draft.workspaceIsolation.networkProfiles.some((profile) => profile === "execution_host")}
        onCheckedChange={(enabled) => setDraft({ ...draft, workspaceIsolation: { kind: "bubblewrap", networkProfiles: enabled ? ["isolated", "execution_host"] : ["isolated"] } })} />
        : <RemoteOperationsFields value={draft.operations} disabled={disabled} errors={fields}
          onChange={(operations) => setDraft({ ...draft, operations })} />}
    </SettingsSection>
    <SettingsSection id="environment-variables" title="Environment variables" card>
      <ConfiguredEnvironmentVariableEditor scope="environment" value={draft.environmentVariables} disabled={disabled} error={fields.under("environmentVariables")}
        onChange={(environmentVariables) => setDraft({ ...draft, environmentVariables })} />
    </SettingsSection>
  </EditorFrame>;
}
