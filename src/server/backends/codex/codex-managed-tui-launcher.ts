import { homedir } from "node:os";
import type {
  EnvironmentChannelScope,
  EnvironmentOwnedPtyChannel,
  ExecutionEnvironmentChannelProvider,
} from "../../execution/environment-channel.js";
import type { CodexExecutionPolicySelection } from "./codex-execution-policy.js";
import type { VerifiedCodexRuntimeVersion } from "./codex-release-guard.js";
import {
  buildCodexLaunchEnvironment,
  verifyPreparedCodexRuntime,
  type ResolvedCodexRuntimeConfiguration,
} from "./codex-runtime-config.js";
import type {
  CodexManagedTuiBindingAuthority,
  CodexManagedTuiLauncher,
  CodexManagedTuiProcess,
} from "./codex-managed-tui-registry.js";
import {
  encodeCodexServiceTier,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";
import { parseCodexTcpEndpoint } from "./transport/tcp-websocket-transport.js";
import type { BackendModelPolicy } from "../model-policy.js";
import type { CodexLiveModelSelection } from "./codex-live-model-selection.js";

const REMOTE_TOKEN_ENVIRONMENT_NAME = "SEDES_CODEX_TUI_REMOTE_TOKEN";

// The managed terminal protocol depends on these Codex 0.160 TUI settings.
// Keep them process-local so account-owned config cannot change Stage/Send
// framing, startup mode, or the repaint surface shared by Sedes viewers.
const MANAGED_TUI_CONFIG_OVERRIDES = Object.freeze([
  "check_for_update_on_startup=false",
  "tui.auto_recap=false",
  'tui.keymap.composer.submit="enter"',
  "tui.vim_mode_default=false",
  'tui.alternate_screen="always"',
  "tui.fullscreen_transcript=false",
  "tui.raw_output_mode=false",
  "tui.disable_paste_burst=false",
]);

export function codexManagedTuiConfigArguments(
  model: string,
  selection: CodexLiveModelSelection,
): readonly string[] {
  const overrides: string[] = [...MANAGED_TUI_CONFIG_OVERRIDES];
  if (selection.upgrade !== null) {
    // Acknowledge only the selected model's authoritative live upgrade. This
    // keeps its startup prompt from consuming Stage/Send input or changing the
    // selected model, including after a provider catalog refresh.
    overrides.push(`notice.model_migrations={${tomlString(model)}=${tomlString(selection.upgrade)}}`);
  }
  return overrides.flatMap(override => ["-c", override]);
}

/**
 * A running interactive client can select a model and submit the turn before
 * Sedes observes the settings notification. Restrictive policies therefore
 * cannot be enforced at this terminal boundary and must disable managed TUI.
 */
export function codexManagedTuiModelPolicySupported(
  policy: BackendModelPolicy,
): boolean {
  return policy.type === "catalog";
}

export interface CodexManagedTuiLaunchSettings extends CodexExecutionPolicySelection {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly serviceTier: CodexServiceTierSelection;
}

/**
 * Environment-neutral launcher. Eligibility comes from explicit environment
 * capabilities for an operator executable, endpoint topology, and PTY; no
 * Sedes-host executable or socket path crosses this boundary.
 */
export class EnvironmentCodexManagedTuiLauncher implements CodexManagedTuiLauncher {
  readonly #channels: ExecutionEnvironmentChannelProvider;
  readonly #configuration: ResolvedCodexRuntimeConfiguration;
  readonly #configuredExecutablePath: string | undefined;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #settings: (
    authority: CodexManagedTuiBindingAuthority,
  ) => CodexManagedTuiLaunchSettings;
  readonly #prepareThreadSettings: (input: {
    readonly authority: CodexManagedTuiBindingAuthority;
    readonly settings: CodexManagedTuiLaunchSettings;
    readonly signal: AbortSignal;
  }) => Promise<CodexLiveModelSelection>;
  readonly #onRuntimeVersionAssessment: (
    assessment: VerifiedCodexRuntimeVersion,
  ) => void;
  readonly #assertLaunchAdmission: (() => void) | undefined;

  constructor(input: {
    readonly channels: ExecutionEnvironmentChannelProvider;
    readonly configuration: ResolvedCodexRuntimeConfiguration;
    readonly configuredExecutablePath?: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly settings: (
      authority: CodexManagedTuiBindingAuthority,
    ) => CodexManagedTuiLaunchSettings;
    readonly prepareThreadSettings: (input: {
      readonly authority: CodexManagedTuiBindingAuthority;
      readonly settings: CodexManagedTuiLaunchSettings;
      readonly signal: AbortSignal;
    }) => Promise<CodexLiveModelSelection>;
    readonly onRuntimeVersionAssessment: (
      assessment: VerifiedCodexRuntimeVersion,
    ) => void;
    readonly assertLaunchAdmission?: () => void;
  }) {
    if (
      input.configuration.connection.ownership !== "external" ||
      input.channels.resolveOwnedProcessExecutable === undefined ||
      input.channels.openOwnedPty === undefined ||
      input.channels.prepareManagedProcessEndpoint === undefined ||
      input.channels.scope.tenantId !== input.configuration.scope.tenantId ||
      input.channels.scope.principalId !==
        input.configuration.scope.principalId ||
      input.channels.executionEnvironmentId !==
        input.configuration.executionEnvironmentId
    ) {
      throw new Error("codex_tui_environment_launcher_configuration_invalid");
    }
    this.#channels = input.channels;
    this.#configuration = input.configuration;
    this.#configuredExecutablePath = input.configuredExecutablePath;
    this.#environment = buildCodexLaunchEnvironment(input.environment, {
      home: input.environment.HOME ?? homedir(),
    });
    this.#settings = input.settings;
    this.#prepareThreadSettings = input.prepareThreadSettings;
    this.#onRuntimeVersionAssessment = input.onRuntimeVersionAssessment;
    this.#assertLaunchAdmission = input.assertLaunchAdmission;
  }

  async launch(input: {
    readonly authority: CodexManagedTuiBindingAuthority;
    readonly resourceGeneration: number;
    readonly signal: AbortSignal;
  }): Promise<CodexManagedTuiProcess> {
    const { authority, signal } = input;
    this.#assertAuthority(authority);
    this.#assertLaunchAdmission?.();
    if (signal.aborted) throw signal.reason;
    const scope = Object.freeze({
      ...authority.scope,
      backendInstanceId: authority.backendInstanceId,
      executionEnvironmentId: authority.executionEnvironmentId,
    });
    const executableIdentity = await resolveCodexManagedTuiExecutable(
      this.#channels,
      scope,
      this.#configuredExecutablePath,
    );
    const executable = await this.#channels.prepareOwnedProcess(scope, {
      executablePath: executableIdentity.canonicalPath,
      workingDirectory: authority.canonicalWorkspacePath,
    });
    const assessment = await verifyPreparedCodexRuntime(
      this.#channels,
      scope,
      executable,
      this.#environment,
      signal,
    );
    this.#onRuntimeVersionAssessment(assessment);
    const settings = this.#settings(authority);
    if (!codexTuiLaunchPolicyRepresentable(settings)) {
      throw new Error("codex_tui_execution_policy_unrepresentable");
    }
    const connection = this.#configuration.connection;
    if (connection.ownership !== "external") {
      throw new Error("codex_tui_external_connection_required");
    }

    const environment: Record<string, string> = {
      ...this.#environment,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    // The non-interactive app-server intentionally runs without ANSI color,
    // but an interactive TUI must be allowed to negotiate the terminal's
    // advertised color capabilities.
    delete environment.NO_COLOR;
    const modelSelection = await this.#prepareThreadSettings({ authority, settings, signal });
    if (signal.aborted) throw signal.reason;
    const configArguments = codexManagedTuiConfigArguments(settings.model, modelSelection);
    const endpoint =
      connection.channel.type === "unix_websocket"
        ? await this.#channels.prepareManagedProcessEndpoint!(
            scope,
            {
              kind: "private_unix_websocket",
              socketPath: connection.channel.socketPath,
            },
            authority.appServerGeneration,
            signal,
          )
        : await this.#channels.prepareManagedProcessEndpoint!(
            scope,
            {
              kind: "assured_tcp_websocket",
              address: connection.channel.url,
              route: parseCodexTcpEndpoint(connection.channel.url).route,
              authentication: connection.channel.authentication.secret,
            },
            authority.appServerGeneration,
            signal,
          );
    const arguments_: string[] = ["resume", authority.backendConversationId];
    if (endpoint.authentication) {
      environment[REMOTE_TOKEN_ENVIRONMENT_NAME] =
        endpoint.authentication.value;
    }
    arguments_.push("--remote", endpoint.processAddress);
    if (endpoint.authentication) {
      arguments_.push("--remote-auth-token-env", REMOTE_TOKEN_ENVIRONMENT_NAME);
    }
    arguments_.push(
      "--strict-config",
      "-C",
      authority.canonicalWorkspacePath,
      "-m",
      settings.model,
      "-c",
      `model_reasoning_effort=${tomlString(settings.reasoningEffort)}`,
      "-c",
      `service_tier=${tomlString(encodeCodexServiceTier(settings.serviceTier))}`,
    );
    arguments_.push(...configArguments);
    let channel: EnvironmentOwnedPtyChannel;
    try {
      this.#assertLaunchAdmission?.();
      channel = await this.#channels.openOwnedPty!(
        scope,
        {
          prepared: executable,
          arguments: arguments_,
          // Environment providers may perform remote/container setup before
          // spawning. Give them an immutable value snapshot so scrubbing our
          // working object below cannot race that setup.
          environment: Object.freeze({ ...environment }),
          initialSize: { columns: 120, rows: 40 },
          terminalType: "xterm-256color",
          cleanup: {
            gracefulCloseMilliseconds: 1_000,
            terminateMilliseconds: 2_000,
            killMilliseconds: 2_000,
          },
        },
        signal,
      );
    } finally {
      // The spawned environment received its own value copy. Revoke and
      // release the short-lived resolver capability immediately.
      endpoint.authentication?.discard();
      delete environment[REMOTE_TOKEN_ENVIRONMENT_NAME];
    }
    return ptyProcess(channel, signal);
  }

  #assertAuthority(authority: CodexManagedTuiBindingAuthority): void {
    if (
      authority.scope.tenantId !== this.#configuration.scope.tenantId ||
      authority.scope.principalId !== this.#configuration.scope.principalId ||
      authority.backendInstanceId !== this.#configuration.instance.id ||
      authority.executionEnvironmentId !==
        this.#configuration.executionEnvironmentId
    ) {
      throw new Error("codex_tui_environment_launcher_scope_mismatch");
    }
  }
}

/**
 * Resolve the operator account's ordinary Codex command. The first executable
 * on PATH has normal shell precedence; if it is incompatible, managed TUI is
 * unavailable instead of silently selecting a different installation.
 */
export async function resolveCodexManagedTuiExecutable(
  channels: ExecutionEnvironmentChannelProvider,
  scope: EnvironmentChannelScope,
  configuredPath?: string,
): Promise<Readonly<{ kind: "executable"; canonicalPath: string }>> {
  const resolveExecutable = channels.resolveOwnedProcessExecutable;
  if (!resolveExecutable) {
    throw new Error("codex_tui_executable_resolution_unsupported");
  }
  return await resolveExecutable.call(channels, scope, {
    commandName: "codex",
    ...(configuredPath ? { configuredPath } : {}),
  });
}

export function codexTuiLaunchPolicyRepresentable(
  settings: CodexManagedTuiLaunchSettings,
): boolean {
  return !(
    (settings.sandboxMode === "read-only" &&
      settings.networkAccess !== "disabled") ||
    (settings.sandboxMode === "danger-full-access" &&
      settings.networkAccess !== "enabled")
  );
}

function ptyProcess(
  channel: EnvironmentOwnedPtyChannel,
  signal: AbortSignal,
): CodexManagedTuiProcess {
  return {
    output: channel.bytes,
    closed: channel.closed.then(({ exitCode, signal }) => ({
      exitCode,
      signal,
    })),
    write: async (bytes) => await channel.write(bytes, { signal }),
    resize: async (columns, rows) => channel.resize({ columns, rows }),
    close: async (reason) => await channel.close(reason),
  };
}

function tomlString(value: string): string {
  if (/[\uD800-\uDFFF]/u.test(value)) throw new Error("codex_tui_config_string_invalid");
  return JSON.stringify(value).replace(/\u007f/gu, "\\u007f");
}
