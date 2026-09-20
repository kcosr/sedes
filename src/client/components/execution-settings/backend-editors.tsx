import { ChoiceList, SelectField, TextField } from "./fields.js";
import type { BackendDefinition, EnvironmentDefinition, TargetDefinition } from "./types.js";

type BackendKind = BackendDefinition["kind"];
type BackendOf<K extends BackendKind> = Extract<BackendDefinition, { kind: K }>;
type TargetOf<K extends TargetDefinition["kind"]> = Extract<TargetDefinition, { kind: K }>;
type BackendEditorProps = { readonly value: BackendDefinition; readonly onChange: (value: BackendDefinition) => void };
type TargetEditorProps = { readonly value: TargetDefinition; readonly onChange: (value: TargetDefinition) => void };

interface BackendEditorRegistration {
  readonly label: string;
  readonly description: string;
  readonly supportsProviderIds: boolean;
  readonly supportsRemoteWorkspace: boolean;
  createBackend(id: string): BackendDefinition;
  createTarget(id: string, backendId: string, environmentId: string): TargetDefinition;
  renderBackend(props: BackendEditorProps): React.JSX.Element;
  renderTarget(props: TargetEditorProps): React.JSX.Element;
}

const sandboxOptions = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "danger-full-access", label: "Full filesystem access" },
] as const;
const networkOptions = [{ value: "disabled", label: "Disabled" }, { value: "enabled", label: "Enabled" }] as const;
const approvalOptions = [
  { value: "untrusted", label: "Untrusted commands require approval" },
  { value: "on-request", label: "Approve on request" },
  { value: "never", label: "Never request approval" },
] as const;
const reviewerOptions = [{ value: "user", label: "User" }, { value: "auto_review", label: "Automatic review" }] as const;
const permissionOptions = [
  { value: "default", label: "Default" }, { value: "acceptEdits", label: "Accept edits" },
  { value: "dontAsk", label: "Do not ask" }, { value: "auto", label: "Automatic" },
  { value: "bypassPermissions", label: "Bypass permissions" },
] as const;

function commonBackend(id: string) { return { id, label: "", enabled: true, modelPolicy: { type: "catalog" as const } }; }
function commonTarget(id: string, backendInstanceId: string, executionEnvironmentId: string) {
  return { id, label: "Default connection", backendInstanceId, executionEnvironmentId, enabled: true };
}

/** Registered administration editors are the only browser surface that understands these typed configuration settings. */
export const backendEditors: Record<BackendKind, BackendEditorRegistration> = {
  pi: {
    label: "Pi SDK", description: "The SDK and model connection run on Sedes. A remote environment supplies workspace tools only.",
    supportsProviderIds: true, supportsRemoteWorkspace: true,
    createBackend: (id) => ({ ...commonBackend(id), kind: "pi" }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "pi_sdk" }),
    renderBackend: () => <p className="execution-settings-muted">Uses the Pi installation and authentication available to the Sedes server account.</p>,
    renderTarget: () => <p className="execution-settings-muted">Models and reasoning defaults come from the Pi catalog and thread settings.</p>,
  },
  codex_app_server: {
    label: "Codex", description: "Connect to an existing app-server, or let the execution environment manage a stdio process.",
    supportsProviderIds: false, supportsRemoteWorkspace: true,
    createBackend: (id) => ({ ...commonBackend(id), kind: "codex_app_server", moduleConfiguration: {
      connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectory: "" } },
      policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["on-request"], allowedApprovalReviewers: ["user"] },
    } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "codex_app_server", moduleConfiguration: {
      defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "on-request", approvalReviewer: "user", model: { type: "catalogDefault" } },
    } }),
    renderBackend: (props) => props.value.kind === "codex_app_server" ? <CodexBackendEditor value={props.value} onChange={props.onChange} /> : unsupportedEditor(),
    renderTarget: (props) => props.value.kind === "codex_app_server" ? <CodexTargetEditor value={props.value} onChange={props.onChange} /> : unsupportedEditor(),
  },
  claude_agent_sdk: {
    label: "Claude", description: "Uses an authenticated Claude Code installation with Node.js 24.18 or newer on a Linux or macOS execution host. SSH and outbound connections are supported; native Windows Claude is unsupported.",
    supportsProviderIds: false, supportsRemoteWorkspace: true,
    createBackend: (id) => ({ ...commonBackend(id), kind: "claude_agent_sdk", moduleConfiguration: {
      initializationTimeoutMs: 20_000, permissionPolicy: { allowedModes: ["default"] },
    } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "claude_agent_sdk", moduleConfiguration: { defaults: { permissionMode: "default" } } }),
    renderBackend: (props) => props.value.kind === "claude_agent_sdk" ? <ClaudeBackendEditor value={props.value} onChange={props.onChange} /> : unsupportedEditor(),
    renderTarget: (props) => props.value.kind === "claude_agent_sdk" ? <SelectField label="Default permission mode" value={props.value.moduleConfiguration.defaults.permissionMode}
      options={permissionOptions.filter((entry) => entry.value !== "bypassPermissions")} onChange={(permissionMode) => {
        if (props.value.kind === "claude_agent_sdk") props.onChange({ ...props.value, moduleConfiguration: { defaults: { permissionMode } } });
      }} /> : unsupportedEditor(),
  },
  grok_build: {
    label: "Grok", description: "A local Grok ACP process uses the execution account's native authentication. Remote Grok is unsupported.",
    supportsProviderIds: false, supportsRemoteWorkspace: false,
    createBackend: (id) => ({ ...commonBackend(id), kind: "grok_build", moduleConfiguration: {
      connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectoryPolicy: "workspace" } },
      authentication: { type: "native" }, security: { profile: "unrestricted_v1", sandboxProfile: "off", networkAccess: "enabled", approvalMode: "full_access" },
    } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "grok_acp", moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, reasoningEffort: { type: "modelDefault" } } } }),
    renderBackend: (props) => props.value.kind === "grok_build" ? <GrokBackendEditor value={props.value} onChange={props.onChange} /> : unsupportedEditor(),
    renderTarget: (props) => props.value.kind === "grok_acp" ? <GrokTargetEditor value={props.value} onChange={props.onChange} /> : unsupportedEditor(),
  },
};

export function allowedEnvironments(backend: BackendDefinition, environments: readonly EnvironmentDefinition[]): EnvironmentDefinition[] {
  return environments.filter((environment) => (backendEditors[backend.kind].supportsRemoteWorkspace || environment.kind === "local")
    && !(backend.kind === "claude_agent_sdk" && environment.kind === "outbound" && environment.platform === "win32"));
}

function unsupportedEditor(): React.JSX.Element { return <p role="alert">This backend's configuration editor does not support the stored connection type.</p>; }

function CodexBackendEditor({ value, onChange }: { readonly value: BackendOf<"codex_app_server">; readonly onChange: (value: BackendDefinition) => void }): React.JSX.Element {
  const configuration = value.moduleConfiguration;
  const connection = configuration.connection;
  const update = (next: typeof configuration) => onChange({ ...value, moduleConfiguration: next });
  const channel = connection.channel;
  return <>
    <fieldset><legend>App-server connection</legend>
      <SelectField label="Connection transport" value={channel.type} options={[
        { value: "process_stdio", label: "Managed stdio process" }, { value: "unix_websocket", label: "External Unix socket (UDS)" }, { value: "tcp_websocket", label: "External WebSocket over TCP" },
      ]} onChange={(type) => {
        const next: typeof connection = type === "process_stdio" ? { ownership: "owned", channel: { type, workingDirectory: "" } }
          : type === "unix_websocket" ? { ownership: "external", channel: { type, socketPath: "" } }
          : { ownership: "external", channel: { type, url: "", authentication: { type: "capability_token", secret: { source: "protected_file", path: "" } } } };
        update({ ...configuration, connection: next });
      }} />
      {channel.type === "process_stdio" ? <>
        <TextField label="Working directory" value={channel.workingDirectory} required onChange={(workingDirectory) => update({ ...configuration, connection: { ownership: "owned", channel: { ...channel, workingDirectory } } })} />
        <TextField label="Codex executable path" value={channel.executablePath ?? ""} description="Optional absolute path on the execution host. Leave blank to use its installed executable."
          onChange={(executablePath) => update({ ...configuration, connection: { ownership: "owned", channel: { ...channel, executablePath: executablePath || undefined } } })} />
        <TextField label="Codex home directory" value={channel.codexHome ?? ""} description="Optional native configuration and authentication directory on the execution host."
          onChange={(codexHome) => update({ ...configuration, connection: { ownership: "owned", channel: { ...channel, codexHome: codexHome || undefined } } })} />
      </> : channel.type === "unix_websocket" ? <TextField label="Unix socket path" value={channel.socketPath} required
        description="Absolute socket path on the selected execution host. Sedes does not own the external app-server process."
        onChange={(socketPath) => update({ ...configuration, connection: { ownership: "external", channel: { ...channel, socketPath } } })} /> : <>
        <TextField label="WebSocket endpoint" value={channel.url} required description="Use an explicit port. Plain ws:// is limited to literal loopback; other hosts require wss://."
          onChange={(url) => update({ ...configuration, connection: { ownership: "external", channel: { ...channel, url } } })} />
        <SelectField label="Capability token source" value={channel.authentication.secret.source}
          options={[{ value: "protected_file", label: "Protected file" }, { value: "environment", label: "Approved environment variable" }]}
          onChange={(source) => update({ ...configuration, connection: { ownership: "external", channel: { ...channel, authentication: {
            type: "capability_token", secret: source === "environment" ? { source, variable: "" } : { source, path: "" },
          } } } })} />
        {channel.authentication.secret.source === "protected_file" ? <TextField label="Token file reference" value={channel.authentication.secret.path} required
          description="An approved protected file on the execution host; enter its path, never the token."
          onChange={(path) => update({ ...configuration, connection: { ownership: "external", channel: { ...channel, authentication: { type: "capability_token", secret: { source: "protected_file", path } } } } })} />
          : <TextField label="Token environment variable" value={channel.authentication.secret.variable} required
            description="An approved SEDES_CODEX_…TOKEN… variable on the execution host; enter its name, never the token."
            onChange={(variable) => update({ ...configuration, connection: { ownership: "external", channel: { ...channel, authentication: { type: "capability_token", secret: { source: "environment", variable } } } } })} />}
      </>}
      <TextField label="Codex TUI executable path" value={configuration.tuiExecutablePath ?? ""} description="Optional absolute path for the separately admitted Codex TUI."
        onChange={(tuiExecutablePath) => update({ ...configuration, tuiExecutablePath: tuiExecutablePath || undefined })} />
    </fieldset>
    <fieldset><legend>Execution policy</legend>
      <p className="execution-settings-muted">Connection defaults and thread selections must stay within these allowed values.</p>
      <ChoiceList label="Allowed filesystem access" value={configuration.policy.allowedSandboxModes} options={sandboxOptions}
        onChange={(allowedSandboxModes) => update({ ...configuration, policy: { ...configuration.policy, allowedSandboxModes } })} />
      <ChoiceList label="Allowed network access" value={configuration.policy.allowedNetworkAccess} options={networkOptions}
        onChange={(allowedNetworkAccess) => update({ ...configuration, policy: { ...configuration.policy, allowedNetworkAccess } })} />
      <ChoiceList label="Allowed approval policies" value={configuration.policy.allowedApprovalPolicies} options={approvalOptions}
        onChange={(allowedApprovalPolicies) => update({ ...configuration, policy: { ...configuration.policy, allowedApprovalPolicies } })} />
      <ChoiceList label="Allowed approval reviewers" value={configuration.policy.allowedApprovalReviewers} options={reviewerOptions}
        onChange={(allowedApprovalReviewers) => update({ ...configuration, policy: { ...configuration.policy, allowedApprovalReviewers } })} />
    </fieldset>
  </>;
}

function CodexTargetEditor({ value, onChange }: { readonly value: TargetOf<"codex_app_server">; readonly onChange: (value: TargetDefinition) => void }): React.JSX.Element {
  const defaults = value.moduleConfiguration.defaults;
  const update = (next: typeof defaults) => onChange({ ...value, moduleConfiguration: { defaults: next } });
  return <>
    <SelectField label="Default filesystem access" value={defaults.sandboxMode} options={sandboxOptions} onChange={(sandboxMode) => update({ ...defaults, sandboxMode })} />
    <SelectField label="Default network access" value={defaults.networkAccess} options={networkOptions} onChange={(networkAccess) => update({ ...defaults, networkAccess })} />
    <SelectField label="Default approval policy" value={defaults.approvalPolicy} options={approvalOptions} onChange={(approvalPolicy) => update({ ...defaults, approvalPolicy })} />
    <SelectField label="Default approval reviewer" value={defaults.approvalReviewer} options={reviewerOptions} onChange={(approvalReviewer) => update({ ...defaults, approvalReviewer })} />
    <DefaultModelEditor value={defaults.model} onChange={(model) => update({ ...defaults, model })} />
  </>;
}

function ClaudeBackendEditor({ value, onChange }: { readonly value: BackendOf<"claude_agent_sdk">; readonly onChange: (value: BackendDefinition) => void }): React.JSX.Element {
  const configuration = value.moduleConfiguration;
  const update = (next: typeof configuration) => onChange({ ...value, moduleConfiguration: next });
  return <fieldset><legend>Claude installation</legend>
    <TextField label="Claude configuration directory" value={configuration.configDirectory ?? ""} description="Optional absolute directory on the execution host. Leave blank to use that account's CLAUDE_CONFIG_DIR or ~/.claude, locally, over SSH, or through an outbound connection."
      onChange={(configDirectory) => {
        const { configDirectory: _previous, ...remaining } = configuration;
        update(configDirectory ? { ...remaining, configDirectory } : remaining);
      }} />
    <TextField label="Claude executable path" value={configuration.executablePath ?? ""} description="Optional absolute path on the execution host. Leave blank to use its installed executable."
      onChange={(executablePath) => update({ ...configuration, executablePath: executablePath || undefined })} />
    <TextField label="Initialization timeout (milliseconds)" type="number" value={String(configuration.initializationTimeoutMs)}
      onChange={(timeout) => update({ ...configuration, initializationTimeoutMs: Number(timeout) })} />
    <ChoiceList label="Allowed permission modes" value={configuration.permissionPolicy.allowedModes} options={permissionOptions}
      onChange={(allowedModes) => update({ ...configuration, permissionPolicy: { allowedModes } })} />
  </fieldset>;
}

function GrokBackendEditor({ value, onChange }: { readonly value: BackendOf<"grok_build">; readonly onChange: (value: BackendDefinition) => void }): React.JSX.Element {
  const configuration = value.moduleConfiguration;
  return <fieldset><legend>Local ACP process</legend>
    <TextField label="Grok executable path" value={configuration.connection.channel.executablePath ?? ""} description="Optional absolute path on the Sedes host."
      onChange={(executablePath) => onChange({ ...value, moduleConfiguration: { ...configuration, connection: { ownership: "owned", channel: { ...configuration.connection.channel, executablePath: executablePath || undefined } } } })} />
    <p className="execution-settings-muted">Grok runs in the workspace with full access, networking enabled, and no sandbox. Authentication is managed by its native installation.</p>
  </fieldset>;
}

function GrokTargetEditor({ value, onChange }: { readonly value: TargetOf<"grok_acp">; readonly onChange: (value: TargetDefinition) => void }): React.JSX.Element {
  const defaults = value.moduleConfiguration.defaults;
  const update = (next: typeof defaults) => onChange({ ...value, moduleConfiguration: { defaults: next } });
  return <>
    <DefaultModelEditor value={defaults.model} onChange={(model) => update({ ...defaults, model })} />
    <SelectField label="Default reasoning effort" value={defaults.reasoningEffort.type}
      options={[{ value: "modelDefault", label: "Model default" }, { value: "fixed", label: "Specific effort" }]}
      onChange={(type) => update({ ...defaults, reasoningEffort: type === "modelDefault" ? { type } : { type, effortId: "" } })} />
    {defaults.reasoningEffort.type === "fixed" ? <TextField label="Reasoning effort identifier" value={defaults.reasoningEffort.effortId} required
      onChange={(effortId) => update({ ...defaults, reasoningEffort: { type: "fixed", effortId } })} /> : null}
  </>;
}

function DefaultModelEditor({ value, onChange }: {
  readonly value: { type: "catalogDefault" } | { type: "fixed"; modelId: string };
  readonly onChange: (value: { type: "catalogDefault" } | { type: "fixed"; modelId: string }) => void;
}): React.JSX.Element {
  return <>
    <SelectField label="Default model" value={value.type} options={[{ value: "catalogDefault", label: "Provider catalog default" }, { value: "fixed", label: "Specific model" }]}
      onChange={(type) => onChange(type === "catalogDefault" ? { type } : { type, modelId: "" })} />
    {value.type === "fixed" ? <TextField label="Default model identifier" value={value.modelId} required onChange={(modelId) => onChange({ type: "fixed", modelId })} /> : null}
  </>;
}
