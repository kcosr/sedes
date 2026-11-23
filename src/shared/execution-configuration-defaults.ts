import type { ConfigurationBackend, ConfigurationEnvironment, ConfigurationTarget } from "./protocol/configuration-admin.js";

/** One set of creation defaults for Settings and agent execution management.
 * Required host-specific values are deliberately blank until supplied. */
function commonBackend(id: string) { return { id, label: "", enabled: true, modelPolicy: { type: "catalog" as const } }; }
function commonTarget(id: string, backendInstanceId: string, executionEnvironmentId: string) {
  return { id, label: "Default connection", backendInstanceId, executionEnvironmentId, enabled: true };
}

export const executionBackendDefaults: Record<ConfigurationBackend["kind"], {
  createBackend(id: string): ConfigurationBackend;
  createTarget(id: string, backendId: string, environmentId: string): ConfigurationTarget;
}> = {
  pi_native: {
    createBackend: (id) => ({ ...commonBackend(id), kind: "pi_native", moduleConfiguration: { initializationTimeoutMs: 30_000, projectTrusted: false } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "pi_rpc", moduleConfiguration: { defaults: {} } }),
  },
  pi: {
    createBackend: (id) => ({ ...commonBackend(id), kind: "pi" }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "pi_sdk" }),
  },
  antigravity: {
    createBackend: id => ({ ...commonBackend(id), kind: "antigravity", moduleConfiguration: { initializationTimeoutMs: 30_000 } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "antigravity_acp", moduleConfiguration: { defaults: {} } }),
  },
  codex_app_server: {
    createBackend: (id) => ({ ...commonBackend(id), kind: "codex_app_server", moduleConfiguration: {
      connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectory: "" } },
      policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["on-request"], allowedApprovalReviewers: ["user"] },
    } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "codex_app_server", moduleConfiguration: {
      defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "on-request", approvalReviewer: "user", model: { type: "catalogDefault" } },
    } }),
  },
  claude_agent_sdk: {
    createBackend: (id) => ({ ...commonBackend(id), kind: "claude_agent_sdk", moduleConfiguration: {
      initializationTimeoutMs: 20_000, permissionPolicy: { allowedModes: ["default"] },
    } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "claude_agent_sdk", moduleConfiguration: { defaults: { permissionMode: "default" } } }),
  },
  grok_build: {
    createBackend: (id) => ({ ...commonBackend(id), kind: "grok_build", moduleConfiguration: {
      connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectoryPolicy: "workspace" } },
      authentication: { type: "native" }, security: { profile: "unrestricted_v1", sandboxProfile: "off", networkAccess: "enabled", approvalMode: "full_access" },
    } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "grok_acp", moduleConfiguration: { defaults: { model: { type: "catalogDefault" }, reasoningEffort: { type: "modelDefault" } } } }),
  },
  opencode: {
    createBackend: (id) => ({ ...commonBackend(id), kind: "opencode", moduleConfiguration: {
      connection: { ownership: "owned", channel: { type: "process_stdio" } },
    } }),
    createTarget: (id, backend, environment) => ({ ...commonTarget(id, backend, environment), kind: "opencode_http", moduleConfiguration: {
      defaults: { model: { type: "catalogDefault" }, variant: { type: "modelDefault" } },
    } }),
  },
};

export const defaultSidecarCapabilities = ["directory_browser", "workspace_files"] as const;

export function createExecutionEnvironment(kind: "local" | "ssh", id: string): ConfigurationEnvironment {
  return kind === "local"
    ? { id, label: "", kind: "local", workspaceRoots: [], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }
    : { id, label: "", kind: "ssh", hostAlias: "", workspaceRoots: [], connectionCompression: true, operations: { kind: "sidecar", enabledCapabilities: [...defaultSidecarCapabilities] } };
}
