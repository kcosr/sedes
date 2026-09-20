import type { ResolvedEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { normalizedAbsolutePath } from "../../../shared/absolute-path.js";
import { isAgentToolCliEndpoint } from "../../../internal/agent-tool-cli-protocol/local-endpoint.js";
import { pathForRemoteRoot } from "../../execution/remote-path.js";
import type Database from "better-sqlite3";
import type { ExecutionScope } from "../../execution/contracts.js";
import type {
  AgentToolCliAvailability,
  AgentToolCliRuntimeProvider,
  AgentToolCliRuntimeResolution,
} from "../module.js";
import type { CodexJsonValue } from "./codex-c2-protocol.js";
import type {
  AgentToolSourceCapabilityIssuer,
  AgentToolSourceCapabilityTransport,
} from "../../agent-tools/application/database-agent-tool-source-authority.js";
import type { BackendAgentToolFacade } from "../../agent-tools/adapters/backend-facade.js";
import type { AgentToolPresentationMode } from "../../../shared/protocol/conversation.js";

const SEDES_AGENT_TOOL_ENDPOINT_VARIABLE = "SEDES_AGENT_TOOL_ENDPOINT";
const SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE =
  "SEDES_AGENT_TOOL_SOURCE_CAPABILITY";
const SEDES_AGENT_TOOL_CLIENT_TOKEN_VARIABLE = "SEDES_AGENT_TOOL_CLIENT_TOKEN";
const SEDES_AGENT_TOOL_CLI_MODE_VARIABLE = "SEDES_AGENT_TOOL_CLI_MODE";
const PATH_VARIABLE = "PATH";
const NEVER_CLOSED = new Promise<never>(() => undefined);

export type CodexAgentToolCliEnvironmentUnavailableReason =
  | "imported_thread"
  | "remote_environment"
  | "network_disabled"
  | "presentation_unavailable"
  | "unverifiable_thread_context"
  | "cli_unavailable"
  | "sidecar_unavailable";

export type CodexAgentToolCliEnvironmentResolution =
  | ((Extract<
      AgentToolCliRuntimeResolution,
      { readonly availability: "available" }
    > & { readonly sourceCapability: string }) & {
      readonly mode: AgentToolPresentationMode;
    })
  | Readonly<{
      availability: "unavailable";
      reason: CodexAgentToolCliEnvironmentUnavailableReason;
    }>;

/**
 * Trusted Codex composition seam for one application thread. Implementations
 * derive eligibility from server-owned runtime, environment, and thread facts;
 * the provider-native thread and model never supply any of these values.
 */
export interface CodexAgentToolCliEnvironmentProvider {
  acquire(
    scope: ExecutionScope,
    applicationThreadId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CodexAgentToolCliEnvironmentResolution>;
}

export const unavailableCodexAgentToolCliEnvironmentProvider: CodexAgentToolCliEnvironmentProvider =
  Object.freeze({
    acquire: async () =>
      Object.freeze({
        availability: "unavailable" as const,
        reason: "unverifiable_thread_context" as const,
      }),
  });

/**
 * Principal-scoped eligibility for Codex agent-tool CLI injection. A durable
 * Sedes creation attempt distinguishes local application-created threads
 * from imported native threads. Network-disabled policy remains unavailable
 * for every endpoint until the remote Unix-socket sandbox behavior is live
 * verified.
 */
export class DatabaseCodexAgentToolCliEnvironmentProvider implements CodexAgentToolCliEnvironmentProvider {
  readonly #database: Database.Database;
  readonly #backendInstanceId: string;
  readonly #runtime: AgentToolCliRuntimeProvider;
  readonly #appliedOwnedPath: (() => Promise<string>) | undefined;
  readonly #runtimeUnavailableReason:
    "remote_environment" | "cli_unavailable" | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #sourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly #agentTools: Pick<BackendAgentToolFacade, "readPolicy">;
  readonly #sourceCapabilityTransport: AgentToolSourceCapabilityTransport;

  constructor(input: {
    readonly database: Database.Database;
    readonly backendInstanceId: string;
    readonly runtime: AgentToolCliAvailability;
    readonly sourceCapabilities: AgentToolSourceCapabilityIssuer;
    readonly agentTools: Pick<BackendAgentToolFacade, "readPolicy">;
    readonly onError?: (error: unknown) => void;
    readonly appliedOwnedPath?: () => Promise<string>;
  }) {
    this.#database = input.database;
    this.#appliedOwnedPath = input.appliedOwnedPath;
    this.#backendInstanceId = input.backendInstanceId;
    this.#onError = input.onError ?? (() => undefined);
    this.#sourceCapabilities = input.sourceCapabilities;
    this.#agentTools = input.agentTools;
    this.#sourceCapabilityTransport =
      input.runtime.availability === "managed"
        ? "execution_environment_sidecar"
        : "management_http";
    this.#runtimeUnavailableReason =
      input.runtime.availability === "unavailable"
        ? input.runtime.reason
        : undefined;
    this.#runtime = this.#runtimeUnavailableReason
      ? staticUnavailableRuntime(this.#runtimeUnavailableReason)
      : input.runtime.availability === "managed"
        ? input.runtime.provider
        : staticRuntime(input.runtime);
  }

  async acquire(
    scope: ExecutionScope,
    applicationThreadId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CodexAgentToolCliEnvironmentResolution> {
    assertApplicationThreadId(applicationThreadId);
    if (this.#runtimeUnavailableReason) {
      return Object.freeze({
        availability: "unavailable",
        reason: this.#runtimeUnavailableReason,
      });
    }
    const row = this.#database
      .prepare(
        `
          SELECT settings.desired_network_access AS networkAccess,
            thread.workspace_id AS workspaceId,
            thread.environment_id AS environmentId,
            EXISTS (
              SELECT 1
              FROM conversation_creation_attempts AS attempt
              WHERE attempt.tenant_id = thread.tenant_id
                AND attempt.owner_principal_id = thread.owner_principal_id
                AND attempt.application_thread_id = thread.id
                AND attempt.backend_instance_id = thread.backend_instance_id
                AND attempt.creation_kind IN ('first_input', 'fork')
                AND attempt.force_reset_at IS NULL
                AND attempt.phase <> 'aborted_unpersisted'
            ) AS sedesCreated
          FROM application_threads AS thread
          JOIN codex_thread_execution_settings AS settings
            ON settings.tenant_id = thread.tenant_id
            AND settings.owner_principal_id = thread.owner_principal_id
            AND settings.application_thread_id = thread.id
          WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
            AND thread.id = ? AND thread.backend_instance_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        this.#backendInstanceId,
      ) as
      | {
          readonly networkAccess: "disabled" | "enabled" | null;
          readonly sedesCreated: 0 | 1;
          readonly workspaceId: string;
          readonly environmentId: string;
        }
      | undefined;
    if (!row || row.sedesCreated !== 1) {
      return Object.freeze({
        availability: "unavailable",
        reason: row ? "imported_thread" : "unverifiable_thread_context",
      });
    }
    if (row.networkAccess !== "enabled") {
      return Object.freeze({
        availability: "unavailable",
        reason: "network_disabled",
      });
    }
    const policy = this.#agentTools.readPolicy({
      scope: Object.freeze({ ...scope }),
      sourceThreadId: applicationThreadId,
      sourceWorkspaceId: row.workspaceId,
      sourceEnvironmentId: row.environmentId,
      backendKind: "codex_app_server",
    });
    if (policy.presentation.surface !== "cli") {
      return Object.freeze({
        availability: "unavailable",
        reason: "presentation_unavailable",
      });
    }
    let runtimeResolution: AgentToolCliRuntimeResolution | undefined;
    try {
      runtimeResolution = await this.#runtime.acquire(options);
      if (runtimeResolution.availability !== "available") {
        return runtimeResolution;
      }
      const sourceCapability = this.#sourceCapabilities.issue(
        {
          scope: Object.freeze({ ...scope }),
          sourceThreadId: applicationThreadId,
          sourceWorkspaceId: row.workspaceId,
          sourceEnvironmentId: row.environmentId,
          backendKind: "codex_app_server",
        },
        this.#sourceCapabilityTransport,
      );
      const activeRuntimeResolution = runtimeResolution;
      const inheritedPath = this.#appliedOwnedPath ? await this.#appliedOwnedPath() : runtimeResolution.inheritedPath;
      let released = false;
      return Object.freeze({
        ...runtimeResolution,
        sourceCapability,
        mode: policy.presentation.mode,
        endpoint: canonicalAgentToolEndpoint(runtimeResolution.endpoint),
        executableDirectory: absoluteDirectory(
          runtimeResolution.executableDirectory,
        ),
        inheritedPath: inheritedPath
          ? boundedEnvironmentValue(
              inheritedPath,
              "codex_agent_tool_cli_path_invalid",
            )
          : "",
        release: () => {
          if (released) return;
          released = true;
          activeRuntimeResolution.release();
        },
      });
    } catch (error) {
      if (runtimeResolution?.availability === "available") {
        runtimeResolution.release();
      }
      try {
        this.#onError(error);
      } catch {
        // Diagnostics never replace fail-closed CLI unavailability.
      }
      return Object.freeze({
        availability: "unavailable",
        reason: "sidecar_unavailable",
      });
    }
  }
}

/** Adds isolated CLI context without discarding provider configuration. */
export function withCodexAgentToolCliEnvironment(
  config: Readonly<Record<string, CodexJsonValue | undefined>>,
  input: {
    readonly resolution: CodexAgentToolCliEnvironmentResolution;
    readonly executionEnvironment?: ResolvedEnvironmentVariables;
    readonly applicationThreadId: string;
  },
): Readonly<Record<string, CodexJsonValue>> {
  const base = definedConfig(config);
  const existingPolicy = optionalRecord(
    base.shell_environment_policy,
    "codex_shell_environment_policy_invalid",
  );
  const existingSet = optionalStringRecord(
    existingPolicy.set,
    "codex_shell_environment_policy_set_invalid",
  );
  delete existingSet[SEDES_AGENT_TOOL_ENDPOINT_VARIABLE];
  delete existingSet[SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE];
  delete existingSet[SEDES_AGENT_TOOL_CLIENT_TOKEN_VARIABLE];
  delete existingSet[SEDES_AGENT_TOOL_CLI_MODE_VARIABLE];
  const existingExclude = optionalStringArray(
    existingPolicy.exclude,
    "codex_shell_environment_policy_exclude_invalid",
  );
  const sensitiveVariables = [
    SEDES_AGENT_TOOL_ENDPOINT_VARIABLE,
    SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE,
    SEDES_AGENT_TOOL_CLIENT_TOKEN_VARIABLE,
    SEDES_AGENT_TOOL_CLI_MODE_VARIABLE,
  ];
  const includeOnly = existingPolicy.include_only;
  const sanitizedIncludeOnly = (() => {
    if (includeOnly === undefined) return undefined;
    if (
      !Array.isArray(includeOnly) ||
      includeOnly.some((entry) => typeof entry !== "string")
    ) {
      throw new Error("codex_shell_environment_policy_include_only_invalid");
    }
    return (includeOnly as string[]).filter(
      (name) => !sensitiveVariables.includes(name),
    );
  })();
  if (input.resolution.availability !== "available") {
    return Object.freeze({
      ...base,
      shell_environment_policy: Object.freeze({
        ...existingPolicy,
        exclude: [...new Set([...existingExclude, ...sensitiveVariables])],
        ...(Object.keys(existingSet).length > 0 ? { set: existingSet } : {}),
        ...(sanitizedIncludeOnly ? { include_only: sanitizedIncludeOnly } : {}),
      }),
    });
  }
  assertApplicationThreadId(input.applicationThreadId);
  assertSourceCapability(input.resolution.sourceCapability);
  assertCliMode(input.resolution.mode);
  const endpoint = canonicalAgentToolEndpoint(input.resolution.endpoint);
  const executableDirectory = absoluteDirectory(
    input.resolution.executableDirectory,
  );
  const configuredPath = Object.entries(input.executionEnvironment ?? {}).find(([name]) => name.toUpperCase() === "PATH");
  const desiredPath = configuredPath ? configuredPath[1] ?? "" : input.resolution.inheritedPath;
  const inheritedPath =
    desiredPath.length === 0
      ? ""
      : boundedEnvironmentValue(
          desiredPath,
          "codex_agent_tool_cli_path_invalid",
        );
  if (pathForRemoteRoot(executableDirectory).sep === "\\") {
    for (const key of Object.keys(existingSet)) if (key.toUpperCase() === PATH_VARIABLE) delete existingSet[key];
  }
  const set = Object.freeze({
    ...existingSet,
    [SEDES_AGENT_TOOL_ENDPOINT_VARIABLE]: endpoint,
    [SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE]:
      input.resolution.sourceCapability,
    [SEDES_AGENT_TOOL_CLI_MODE_VARIABLE]: input.resolution.mode,
    [PATH_VARIABLE]: inheritedPath
      ? `${executableDirectory}${pathForRemoteRoot(executableDirectory).delimiter}${inheritedPath}`
      : executableDirectory,
  });
  const shellEnvironmentPolicy: Record<string, CodexJsonValue> = {
    ...existingPolicy,
    exclude: [...new Set([...existingExclude, ...sensitiveVariables])],
    set,
  };
  if (sanitizedIncludeOnly !== undefined) {
    shellEnvironmentPolicy.include_only = [
      ...new Set([
        ...sanitizedIncludeOnly,
        SEDES_AGENT_TOOL_ENDPOINT_VARIABLE,
        SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE,
        SEDES_AGENT_TOOL_CLI_MODE_VARIABLE,
        PATH_VARIABLE,
      ]),
    ];
  }
  return Object.freeze({
    ...base,
    shell_environment_policy: Object.freeze(shellEnvironmentPolicy),
  });
}

function assertSourceCapability(value: string): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(value)) {
    throw new Error("codex_agent_tool_cli_source_capability_invalid");
  }
}

function assertCliMode(value: AgentToolPresentationMode): void {
  if (value !== "progressive" && value !== "individual") {
    throw new Error("codex_agent_tool_cli_mode_invalid");
  }
}

function staticRuntime(
  availability: AgentToolCliAvailability,
): AgentToolCliRuntimeProvider {
  if (availability.availability === "managed") return availability.provider;
  if (availability.availability === "unavailable") {
    return staticUnavailableRuntime(availability.reason);
  }
  const environment = Object.freeze({
    endpoint: canonicalAgentToolEndpoint(availability.endpoint),
    executableDirectory: absoluteDirectory(availability.executableDirectory),
    inheritedPath: availability.inheritedPath
      ? boundedEnvironmentValue(
          availability.inheritedPath,
          "codex_agent_tool_cli_path_invalid",
        )
      : "",
  });
  return Object.freeze({
    acquire: async () =>
      Object.freeze({
        availability: "available" as const,
        ...environment,
        closed: NEVER_CLOSED,
        release: () => undefined,
      }),
  });
}

function staticUnavailableRuntime(
  reason: CodexAgentToolCliEnvironmentUnavailableReason,
): AgentToolCliRuntimeProvider {
  return Object.freeze({
    acquire: async () => Object.freeze({ availability: "unavailable", reason }),
  }) as AgentToolCliRuntimeProvider;
}

function definedConfig(
  config: Readonly<Record<string, CodexJsonValue | undefined>>,
): Record<string, CodexJsonValue> {
  return Object.fromEntries(
    Object.entries(config).filter(
      (entry): entry is [string, CodexJsonValue] => entry[1] !== undefined,
    ),
  );
}

function optionalRecord(
  value: CodexJsonValue | undefined,
  code: string,
): Record<string, CodexJsonValue> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return definedConfig(value);
}

function optionalStringRecord(
  value: CodexJsonValue | undefined,
  code: string,
): Record<string, string> {
  const record = optionalRecord(value, code);
  if (Object.values(record).some((entry) => typeof entry !== "string")) {
    throw new Error(code);
  }
  return record as Record<string, string>;
}

function optionalStringArray(
  value: CodexJsonValue | undefined,
  code: string,
): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(code);
  }
  return [...value] as string[];
}

function canonicalAgentToolEndpoint(value: string): string {
  const bounded = boundedEnvironmentValue(
    value,
    "codex_agent_tool_cli_endpoint_invalid",
  );
  if (isAgentToolCliEndpoint(bounded)) return bounded;
  let parsed: URL;
  try {
    parsed = new URL(bounded);
  } catch (error) {
    throw new Error("codex_agent_tool_cli_endpoint_invalid", { cause: error });
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("codex_agent_tool_cli_endpoint_invalid");
  }
  if (
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    parsed.port.length > 0 &&
    parsed.pathname === "/" &&
    parsed.origin === bounded
  ) {
    return parsed.origin;
  }
  throw new Error("codex_agent_tool_cli_endpoint_invalid");
}

function absoluteDirectory(value: string): string {
  const bounded = boundedEnvironmentValue(
    value,
    "codex_agent_tool_cli_directory_invalid",
  );
  if (!normalizedAbsolutePath(bounded)) {
    throw new Error("codex_agent_tool_cli_directory_invalid");
  }
  return bounded;
}

function boundedEnvironmentValue(value: string, code: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 16_384 ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function assertApplicationThreadId(value: string): void {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("codex_agent_tool_cli_source_thread_invalid");
  }
}

/** Applies only tool-process variables; external daemon startup is unchanged. */
export function withCodexExecutionEnvironment(config: Readonly<Record<string, CodexJsonValue | undefined>>, variables: ResolvedEnvironmentVariables): Readonly<Record<string, CodexJsonValue>> {
  const base = definedConfig(config);
  if (Object.keys(variables).length === 0) return base;
  const policy = optionalRecord(base.shell_environment_policy, "codex_shell_environment_policy_invalid");
  const set = optionalStringRecord(policy.set, "codex_shell_environment_policy_set_invalid");
  const exclude = optionalStringArray(policy.exclude, "codex_shell_environment_policy_exclude_invalid");
  for (const [name, value] of Object.entries(variables)) {
    for (const existing of Object.keys(set)) if (existing.toUpperCase() === name.toUpperCase()) delete set[existing];
    exclude.push(name);
    if (value !== null) set[name] = value;
  }
  return Object.freeze({ ...base, shell_environment_policy: { ...policy, exclude: [...new Set(exclude)], set } });
}
