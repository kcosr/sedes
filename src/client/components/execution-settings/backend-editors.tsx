import type { ReactNode } from "react";
import { Callout } from "../ui/callout.js";
import type { KeyValueItem } from "../ui/key-value-list.js";
import { PathText } from "./detail-parts.js";
import { AdvancedGroup, CheckboxGroup, SelectField, TextField, type ChoiceOption } from "./fields.js";
import type { BackendDefinition, EnvironmentDefinition, TargetDefinition } from "./types.js";
import { FieldErrors } from "./validation.js";

type BackendKind = BackendDefinition["kind"];
type BackendOf<K extends BackendKind> = Extract<BackendDefinition, { kind: K }>;
type TargetOf<K extends TargetDefinition["kind"]> = Extract<TargetDefinition, { kind: K }>;
interface EditorProps<T> {
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** Errors keyed relative to the edited backend or connection. */
  readonly errors: FieldErrors;
  readonly disabled: boolean;
}
type BackendEditorProps = EditorProps<BackendDefinition>;
type TargetEditorProps = EditorProps<TargetDefinition>;

interface BackendEditorRegistration {
  readonly label: string;
  readonly description: string;
  readonly supportsProviderIds: boolean;
  readonly supportsRemoteWorkspace: boolean;
  createBackend(id: string): BackendDefinition;
  createTarget(id: string, backendId: string, environmentId: string): TargetDefinition;
  /** The Connection section: how Sedes reaches the provider. */
  renderConnection(props: BackendEditorProps): ReactNode;
  /** The Policy section, for providers with an execution policy. */
  renderPolicy?(props: BackendEditorProps): ReactNode;
  /** A connection's defaults for new threads. */
  renderTarget(props: TargetEditorProps): ReactNode;
  /** One line describing a connection's defaults, for its collapsed row. */
  summarizeTarget(value: TargetDefinition): string;
  /** Overview facts about the provider and its connection. */
  describeConnection(value: BackendDefinition): KeyValueItem[];
  /** Overview facts about the execution policy. */
  describePolicy?(value: BackendDefinition): KeyValueItem[];
}

const sandboxOptions = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "danger-full-access", label: "Full filesystem access", risky: true },
] as const satisfies ReadonlyArray<ChoiceOption<string>>;
const networkOptions = [{ value: "disabled", label: "Disabled" }, { value: "enabled", label: "Enabled" }] as const;
const approvalOptions = [
  { value: "untrusted", label: "Untrusted commands require approval" },
  { value: "on-request", label: "Approve on request" },
  { value: "never", label: "Never request approval", risky: true },
] as const satisfies ReadonlyArray<ChoiceOption<string>>;
const reviewerOptions = [{ value: "user", label: "User" }, { value: "auto_review", label: "Automatic review" }] as const;
const permissionOptions = [
  { value: "default", label: "Default" }, { value: "acceptEdits", label: "Accept edits" },
  { value: "dontAsk", label: "Do not ask" }, { value: "auto", label: "Automatic" },
  { value: "bypassPermissions", label: "Bypass permissions", risky: true },
] as const satisfies ReadonlyArray<ChoiceOption<string>>;
const transportLabels = { process_stdio: "Managed stdio process", unix_websocket: "External Unix socket (UDS)", tcp_websocket: "External WebSocket over TCP" } as const;

function labelOf(options: ReadonlyArray<{ readonly value: string; readonly label: string }>, value: string): string {
  return options.find(option => option.value === value)?.label ?? value;
}
function labelsOf(options: ReadonlyArray<{ readonly value: string; readonly label: string }>, values: readonly string[]): string {
  return values.map(value => labelOf(options, value)).join(", ") || "None";
}

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
    renderConnection: () => <p className="execution-muted">Uses the Pi installation and authentication available to the Sedes server account.</p>,
    renderTarget: () => <p className="execution-muted">Models and reasoning defaults come from the Pi catalog and thread settings.</p>,
    summarizeTarget: () => "Pi catalog and thread defaults",
    describeConnection: () => [{ label: "Runs", value: "In the Sedes server process" }, { label: "Authentication", value: "The Sedes server account's Pi installation" }],
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
    renderConnection: (props) => props.value.kind === "codex_app_server" ? <CodexConnectionEditor {...props} value={props.value} /> : unsupportedEditor(),
    renderPolicy: (props) => props.value.kind === "codex_app_server" ? <CodexPolicyEditor {...props} value={props.value} /> : unsupportedEditor(),
    renderTarget: (props) => props.value.kind === "codex_app_server" ? <CodexTargetEditor {...props} value={props.value} /> : unsupportedEditor(),
    summarizeTarget: (value) => {
      if (value.kind !== "codex_app_server") return "";
      const defaults = value.moduleConfiguration.defaults;
      return [labelOf(sandboxOptions, defaults.sandboxMode), `Network ${labelOf(networkOptions, defaults.networkAccess).toLowerCase()}`,
        labelOf(approvalOptions, defaults.approvalPolicy), defaults.model.type === "fixed" ? defaults.model.modelId || "Specific model" : "Catalog default model"].join(" · ");
    },
    describeConnection: (value) => {
      if (value.kind !== "codex_app_server") return [];
      const configuration = value.moduleConfiguration;
      const channel = configuration.connection.channel;
      return [
        { label: "Transport", value: transportLabels[channel.type] },
        ...(channel.type === "process_stdio" ? [
          { label: "Working directory", value: <PathText value={channel.workingDirectory} /> },
          ...(channel.executablePath ? [{ label: "Executable", value: <PathText value={channel.executablePath} /> }] : []),
          ...(channel.codexHome ? [{ label: "Codex home", value: <PathText value={channel.codexHome} /> }] : []),
        ] : channel.type === "unix_websocket" ? [{ label: "Socket", value: <PathText value={channel.socketPath} /> }] : [
          { label: "Endpoint", value: <PathText value={channel.url} /> },
          { label: "Token", value: channel.authentication.secret.source === "environment" ? `Environment variable ${channel.authentication.secret.variable}` : `File ${channel.authentication.secret.path}` },
        ]),
        ...(configuration.tuiExecutablePath ? [{ label: "TUI executable", value: <PathText value={configuration.tuiExecutablePath} /> }] : []),
      ];
    },
    describePolicy: (value) => {
      if (value.kind !== "codex_app_server") return [];
      const policy = value.moduleConfiguration.policy;
      return [
        { label: "Filesystem", value: labelsOf(sandboxOptions, policy.allowedSandboxModes) },
        { label: "Network", value: labelsOf(networkOptions, policy.allowedNetworkAccess) },
        { label: "Approval", value: labelsOf(approvalOptions, policy.allowedApprovalPolicies) },
        { label: "Reviewers", value: labelsOf(reviewerOptions, policy.allowedApprovalReviewers) },
      ];
    },
  },
  claude_agent_sdk: {
    label: "Claude", description: "Uses an authenticated Claude Code installation with Node.js 24.18 or newer on a Linux or macOS execution host. SSH and outbound connections are supported; native Windows Claude is unsupported.",
    supportsProviderIds: false, supportsRemoteWorkspace: true,
    createBackend: (id) => ({ ...commonBackend(id), kind: "claude_agent_sdk", moduleConfiguration: {
      initializationTimeoutMs: 20_000, permissionPolicy: { allowedModes: ["default"] },
    } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "claude_agent_sdk", moduleConfiguration: { defaults: { permissionMode: "default" } } }),
    renderConnection: (props) => props.value.kind === "claude_agent_sdk" ? <ClaudeConnectionEditor {...props} value={props.value} /> : unsupportedEditor(),
    renderPolicy: (props) => props.value.kind === "claude_agent_sdk" ? <ClaudePolicyEditor {...props} value={props.value} /> : unsupportedEditor(),
    renderTarget: (props) => props.value.kind === "claude_agent_sdk" ? <SelectField label="Default permission mode" layout="stacked" disabled={props.disabled}
      error={props.errors.under("moduleConfiguration.defaults.permissionMode")} value={props.value.moduleConfiguration.defaults.permissionMode}
      options={permissionOptions.filter((entry) => entry.value !== "bypassPermissions")} onChange={(permissionMode) => {
        if (props.value.kind === "claude_agent_sdk") props.onChange({ ...props.value, moduleConfiguration: { defaults: { permissionMode } } });
      }} /> : unsupportedEditor(),
    summarizeTarget: (value) => value.kind === "claude_agent_sdk" ? `Permission mode ${labelOf(permissionOptions, value.moduleConfiguration.defaults.permissionMode).toLowerCase()}` : "",
    describeConnection: (value) => {
      if (value.kind !== "claude_agent_sdk") return [];
      const configuration = value.moduleConfiguration;
      return [
        { label: "Configuration", value: configuration.configDirectory ? <PathText value={configuration.configDirectory} /> : "The account's CLAUDE_CONFIG_DIR or ~/.claude" },
        { label: "Executable", value: configuration.executablePath ? <PathText value={configuration.executablePath} /> : "Installed Claude Code" },
        { label: "Start timeout", value: `${configuration.initializationTimeoutMs / 1000} s` },
      ];
    },
    describePolicy: (value) => value.kind === "claude_agent_sdk" ? [{ label: "Permission modes", value: labelsOf(permissionOptions, value.moduleConfiguration.permissionPolicy.allowedModes) }] : [],
  },
  grok_build: {
    label: "Grok", description: "A local Grok ACP process uses the execution account's native authentication. Remote Grok is unsupported.",
    supportsProviderIds: false, supportsRemoteWorkspace: false,
    createBackend: (id) => ({ ...commonBackend(id), kind: "grok_build", moduleConfiguration: {
      connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectoryPolicy: "workspace" } },
      authentication: { type: "native" }, security: { profile: "unrestricted_v1", sandboxProfile: "off", networkAccess: "enabled", approvalMode: "full_access" },
    } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "grok_acp", moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, reasoningEffort: { type: "modelDefault" } } } }),
    renderConnection: (props) => props.value.kind === "grok_build" ? <GrokConnectionEditor {...props} value={props.value} /> : unsupportedEditor(),
    renderPolicy: () => <Callout tone="warning">Grok runs in the workspace with full access, networking enabled, and no sandbox. Authentication is managed by its native installation.</Callout>,
    renderTarget: (props) => props.value.kind === "grok_acp" ? <GrokTargetEditor {...props} value={props.value} /> : unsupportedEditor(),
    summarizeTarget: (value) => {
      if (value.kind !== "grok_acp") return "";
      const defaults = value.moduleConfiguration.defaults;
      return [defaults.model.type === "fixed" ? defaults.model.modelId || "Specific model" : "Catalog default model",
        defaults.reasoningEffort.type === "fixed" ? `Effort ${defaults.reasoningEffort.effortId}` : "Model default effort"].join(" · ");
    },
    describeConnection: (value) => value.kind === "grok_build" ? [
      { label: "Process", value: "Local ACP process in the workspace" },
      { label: "Executable", value: value.moduleConfiguration.connection.channel.executablePath ? <PathText value={value.moduleConfiguration.connection.channel.executablePath} /> : "Installed Grok" },
    ] : [],
    describePolicy: () => [{ label: "Access", value: "Full access · networking enabled · no sandbox" }],
  },
};

export function allowedEnvironments(backend: BackendDefinition, environments: readonly EnvironmentDefinition[]): EnvironmentDefinition[] {
  return environments.filter((environment) => (backendEditors[backend.kind].supportsRemoteWorkspace || environment.kind === "local")
    && !(backend.kind === "claude_agent_sdk" && environment.kind === "outbound" && environment.platform === "win32"));
}

function unsupportedEditor(): React.JSX.Element {
  return <Callout tone="danger" role="alert">This backend's configuration editor does not support the stored connection type.</Callout>;
}

function CodexConnectionEditor({ value, onChange, errors, disabled }: EditorProps<BackendOf<"codex_app_server">> & { readonly onChange: (value: BackendDefinition) => void }): React.JSX.Element {
  const configuration = value.moduleConfiguration;
  const connection = configuration.connection;
  const update = (next: typeof configuration) => onChange({ ...value, moduleConfiguration: next });
  const channel = connection.channel;
  const error = (field: string) => errors.under(`moduleConfiguration.connection.channel.${field}`);
  const tuiError = errors.under("moduleConfiguration.tuiExecutablePath");
  const tui = <TextField label="Codex TUI executable path" path disabled={disabled} value={configuration.tuiExecutablePath ?? ""} error={tuiError}
    description="Optional absolute path for the separately admitted Codex TUI."
    onChange={(tuiExecutablePath) => update({ ...configuration, tuiExecutablePath: tuiExecutablePath || undefined })} />;
  return <>
    <SelectField label="Connection transport" disabled={disabled} value={channel.type} options={[
      { value: "process_stdio", label: transportLabels.process_stdio }, { value: "unix_websocket", label: transportLabels.unix_websocket }, { value: "tcp_websocket", label: transportLabels.tcp_websocket },
    ]} onChange={(type) => {
      const next: typeof connection = type === "process_stdio" ? { ownership: "owned", channel: { type, workingDirectory: "" } }
        : type === "unix_websocket" ? { ownership: "external", channel: { type, socketPath: "" } }
        : { ownership: "external", channel: { type, url: "", authentication: { type: "capability_token", secret: { source: "protected_file", path: "" } } } };
      update({ ...configuration, connection: next });
    }} />
    {channel.type === "process_stdio" ? <>
      <TextField label="Working directory" path required disabled={disabled} value={channel.workingDirectory} error={error("workingDirectory")}
        description="Absolute directory on the execution host where Sedes starts Codex."
        onChange={(workingDirectory) => update({ ...configuration, connection: { ownership: "owned", channel: { ...channel, workingDirectory } } })} />
      <AdvancedGroup summary="Executable, Codex home, TUI" defaultOpen={Boolean(channel.executablePath || channel.codexHome || configuration.tuiExecutablePath)}
        forceOpen={Boolean(error("executablePath") || error("codexHome") || tuiError)}>
        <TextField label="Codex executable path" path disabled={disabled} value={channel.executablePath ?? ""} error={error("executablePath")}
          description="Optional absolute path on the execution host. Leave blank to use its installed executable."
          onChange={(executablePath) => update({ ...configuration, connection: { ownership: "owned", channel: { ...channel, executablePath: executablePath || undefined } } })} />
        <TextField label="Codex home directory" path disabled={disabled} value={channel.codexHome ?? ""} error={error("codexHome")}
          description="Optional native configuration and authentication directory on the execution host."
          onChange={(codexHome) => update({ ...configuration, connection: { ownership: "owned", channel: { ...channel, codexHome: codexHome || undefined } } })} />
        {tui}
      </AdvancedGroup>
    </> : channel.type === "unix_websocket" ? <>
      <TextField label="Unix socket path" path required disabled={disabled} value={channel.socketPath} error={error("socketPath")}
        description="Absolute socket path on the selected execution host. Sedes does not own the external app-server process."
        onChange={(socketPath) => update({ ...configuration, connection: { ownership: "external", channel: { ...channel, socketPath } } })} />
      <AdvancedGroup summary="TUI" defaultOpen={Boolean(configuration.tuiExecutablePath)} forceOpen={Boolean(tuiError)}>{tui}</AdvancedGroup>
    </> : <>
      <TextField label="WebSocket endpoint" path required disabled={disabled} value={channel.url} error={error("url")}
        description="Use an explicit port. Plain ws:// is limited to literal loopback; other hosts require wss://."
        onChange={(url) => update({ ...configuration, connection: { ownership: "external", channel: { ...channel, url } } })} />
      <SelectField label="Capability token source" disabled={disabled} value={channel.authentication.secret.source}
        options={[{ value: "protected_file", label: "Protected file" }, { value: "environment", label: "Approved environment variable" }]}
        onChange={(source) => update({ ...configuration, connection: { ownership: "external", channel: { ...channel, authentication: {
          type: "capability_token", secret: source === "environment" ? { source, variable: "" } : { source, path: "" },
        } } } })} />
      {channel.authentication.secret.source === "protected_file" ? <TextField label="Token file reference" path required disabled={disabled}
        value={channel.authentication.secret.path} error={error("authentication.secret.path")}
        description="An approved protected file on the execution host; enter its path, never the token."
        onChange={(path) => update({ ...configuration, connection: { ownership: "external", channel: { ...channel, authentication: { type: "capability_token", secret: { source: "protected_file", path } } } } })} />
        : <TextField label="Token environment variable" mono required disabled={disabled}
          value={channel.authentication.secret.variable} error={error("authentication.secret.variable")}
          description="The name of an approved SEDES_CODEX_…TOKEN… variable on the execution host; never the token itself."
          onChange={(variable) => update({ ...configuration, connection: { ownership: "external", channel: { ...channel, authentication: { type: "capability_token", secret: { source: "environment", variable } } } } })} />}
      <AdvancedGroup summary="TUI" defaultOpen={Boolean(configuration.tuiExecutablePath)} forceOpen={Boolean(tuiError)}>{tui}</AdvancedGroup>
    </>}
  </>;
}

function CodexPolicyEditor({ value, onChange, errors, disabled }: EditorProps<BackendOf<"codex_app_server">> & { readonly onChange: (value: BackendDefinition) => void }): React.JSX.Element {
  const configuration = value.moduleConfiguration;
  const policy = configuration.policy;
  const update = (next: Partial<typeof policy>) => onChange({ ...value, moduleConfiguration: { ...configuration, policy: { ...policy, ...next } } });
  const error = (field: string) => errors.under(`moduleConfiguration.policy.${field}`);
  return <div className="execution-policy-grid">
    <CheckboxGroup label="Filesystem access" disabled={disabled} value={policy.allowedSandboxModes} options={sandboxOptions} error={error("allowedSandboxModes")}
      onChange={(allowedSandboxModes) => update({ allowedSandboxModes })} />
    <CheckboxGroup label="Network access" disabled={disabled} value={policy.allowedNetworkAccess} options={networkOptions} error={error("allowedNetworkAccess")}
      onChange={(allowedNetworkAccess) => update({ allowedNetworkAccess })} />
    <CheckboxGroup label="Approval policies" disabled={disabled} value={policy.allowedApprovalPolicies} options={approvalOptions} error={error("allowedApprovalPolicies")}
      onChange={(allowedApprovalPolicies) => update({ allowedApprovalPolicies })} />
    <CheckboxGroup label="Approval reviewers" disabled={disabled} value={policy.allowedApprovalReviewers} options={reviewerOptions} error={error("allowedApprovalReviewers")}
      onChange={(allowedApprovalReviewers) => update({ allowedApprovalReviewers })} />
  </div>;
}

function CodexTargetEditor({ value, onChange, errors, disabled }: EditorProps<TargetOf<"codex_app_server">> & { readonly onChange: (value: TargetDefinition) => void }): React.JSX.Element {
  const defaults = value.moduleConfiguration.defaults;
  const update = (next: typeof defaults) => onChange({ ...value, moduleConfiguration: { defaults: next } });
  const error = (field: string) => errors.under(`moduleConfiguration.defaults.${field}`);
  return <div className="execution-field-grid">
    <SelectField label="Default filesystem access" layout="stacked" disabled={disabled} value={defaults.sandboxMode} options={sandboxOptions} error={error("sandboxMode")} onChange={(sandboxMode) => update({ ...defaults, sandboxMode })} />
    <SelectField label="Default network access" layout="stacked" disabled={disabled} value={defaults.networkAccess} options={networkOptions} error={error("networkAccess")} onChange={(networkAccess) => update({ ...defaults, networkAccess })} />
    <SelectField label="Default approval policy" layout="stacked" disabled={disabled} value={defaults.approvalPolicy} options={approvalOptions} error={error("approvalPolicy")} onChange={(approvalPolicy) => update({ ...defaults, approvalPolicy })} />
    <SelectField label="Default approval reviewer" layout="stacked" disabled={disabled} value={defaults.approvalReviewer} options={reviewerOptions} error={error("approvalReviewer")} onChange={(approvalReviewer) => update({ ...defaults, approvalReviewer })} />
    <DefaultModelEditor value={defaults.model} disabled={disabled} error={error("model")} onChange={(model) => update({ ...defaults, model })} />
  </div>;
}

function ClaudeConnectionEditor({ value, onChange, errors, disabled }: EditorProps<BackendOf<"claude_agent_sdk">> & { readonly onChange: (value: BackendDefinition) => void }): React.JSX.Element {
  const configuration = value.moduleConfiguration;
  const update = (next: typeof configuration) => onChange({ ...value, moduleConfiguration: next });
  const error = (field: string) => errors.under(`moduleConfiguration.${field}`);
  return <>
    <p className="execution-muted">Uses the Claude Code installation and authentication of the execution host's account.</p>
    <AdvancedGroup summary="Configuration directory, executable, start timeout"
      defaultOpen={Boolean(configuration.configDirectory || configuration.executablePath || configuration.initializationTimeoutMs !== 20_000)}
      forceOpen={Boolean(error("configDirectory") || error("executablePath") || error("initializationTimeoutMs"))}>
      <TextField label="Claude configuration directory" path disabled={disabled} value={configuration.configDirectory ?? ""} error={error("configDirectory")}
        description="Optional absolute directory on the execution host. Leave blank to use that account's CLAUDE_CONFIG_DIR or ~/.claude, locally, over SSH, or through an outbound connection."
        onChange={(configDirectory) => {
          const { configDirectory: _previous, ...remaining } = configuration;
          update(configDirectory ? { ...remaining, configDirectory } : remaining);
        }} />
      <TextField label="Claude executable path" path disabled={disabled} value={configuration.executablePath ?? ""} error={error("executablePath")}
        description="Optional absolute path on the execution host. Leave blank to use its installed executable."
        onChange={(executablePath) => update({ ...configuration, executablePath: executablePath || undefined })} />
      <TextField label="Initialization timeout" type="number" suffix="ms" disabled={disabled} value={String(configuration.initializationTimeoutMs)} error={error("initializationTimeoutMs")}
        description="How long Sedes waits for Claude to start, from 1000 to 120000 ms."
        onChange={(timeout) => update({ ...configuration, initializationTimeoutMs: Number(timeout) })} />
    </AdvancedGroup>
  </>;
}

function ClaudePolicyEditor({ value, onChange, errors, disabled }: EditorProps<BackendOf<"claude_agent_sdk">> & { readonly onChange: (value: BackendDefinition) => void }): React.JSX.Element {
  const configuration = value.moduleConfiguration;
  return <CheckboxGroup label="Allowed permission modes" columns={2} disabled={disabled} value={configuration.permissionPolicy.allowedModes} options={permissionOptions}
    error={errors.under("moduleConfiguration.permissionPolicy")}
    onChange={(allowedModes) => onChange({ ...value, moduleConfiguration: { ...configuration, permissionPolicy: { allowedModes } } })} />;
}

function GrokConnectionEditor({ value, onChange, errors, disabled }: EditorProps<BackendOf<"grok_build">> & { readonly onChange: (value: BackendDefinition) => void }): React.JSX.Element {
  const configuration = value.moduleConfiguration;
  const error = errors.under("moduleConfiguration.connection.channel.executablePath");
  return <>
    <p className="execution-muted">Sedes starts a local Grok ACP process in each workspace.</p>
    <AdvancedGroup summary="Executable" defaultOpen={Boolean(configuration.connection.channel.executablePath)} forceOpen={Boolean(error)}>
      <TextField label="Grok executable path" path disabled={disabled} value={configuration.connection.channel.executablePath ?? ""} error={error}
        description="Optional absolute path on the Sedes host."
        onChange={(executablePath) => onChange({ ...value, moduleConfiguration: { ...configuration, connection: { ownership: "owned", channel: { ...configuration.connection.channel, executablePath: executablePath || undefined } } } })} />
    </AdvancedGroup>
  </>;
}

function GrokTargetEditor({ value, onChange, errors, disabled }: EditorProps<TargetOf<"grok_acp">> & { readonly onChange: (value: TargetDefinition) => void }): React.JSX.Element {
  const defaults = value.moduleConfiguration.defaults;
  const update = (next: typeof defaults) => onChange({ ...value, moduleConfiguration: { defaults: next } });
  const effort = defaults.reasoningEffort;
  return <div className="execution-field-grid">
    <DefaultModelEditor value={defaults.model} disabled={disabled} error={errors.under("moduleConfiguration.defaults.model")} onChange={(model) => update({ ...defaults, model })} />
    <SelectField label="Default reasoning effort" layout="stacked" disabled={disabled} value={effort.type}
      options={[{ value: "modelDefault", label: "Model default" }, { value: "fixed", label: "Specific effort" }]}
      onChange={(type) => update({ ...defaults, reasoningEffort: type === "modelDefault" ? { type } : { type, effortId: "" } })} />
    {effort.type === "fixed" ? <TextField label="Reasoning effort identifier" layout="stacked" mono required disabled={disabled} value={effort.effortId}
      error={errors.under("moduleConfiguration.defaults.reasoningEffort")}
      onChange={(effortId) => update({ ...defaults, reasoningEffort: { type: "fixed", effortId } })} /> : null}
  </div>;
}

function DefaultModelEditor({ value, onChange, disabled, error }: {
  readonly value: { type: "catalogDefault" } | { type: "fixed"; modelId: string };
  readonly onChange: (value: { type: "catalogDefault" } | { type: "fixed"; modelId: string }) => void;
  readonly disabled: boolean;
  readonly error?: string;
}): React.JSX.Element {
  return <>
    <SelectField label="Default model" layout="stacked" disabled={disabled} value={value.type} options={[{ value: "catalogDefault", label: "Provider catalog default" }, { value: "fixed", label: "Specific model" }]}
      onChange={(type) => onChange(type === "catalogDefault" ? { type } : { type, modelId: "" })} />
    {value.type === "fixed" ? <TextField label="Default model identifier" layout="stacked" mono required disabled={disabled} value={value.modelId} error={error}
      onChange={(modelId) => onChange({ type: "fixed", modelId })} /> : null}
  </>;
}
