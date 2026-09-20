import { mergeEnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import path from "node:path";
import { configurationDocumentSchema, type ConfigurationDocument } from "../../shared/protocol/configuration-admin.js";
import { parseCodexBackendConfiguration } from "../backends/codex/codex-backend-configuration.js";
import { parseClaudeBackendConfiguration } from "../backends/claude/claude-backend-configuration.js";
import { parseGrokBackendConfiguration } from "../backends/grok/grok-backend-configuration.js";
import { compileBackendModelPolicy } from "../backends/model-policy.js";
import type { BackendModuleConfigurationInput } from "../backends/module.js";
import { DomainError } from "../domain/errors.js";

/** Pure validation only: never contacts a provider, reads secrets, or starts work. */
export function validateConfigurationDocument(value: unknown): ConfigurationDocument {
  const document = configurationDocumentSchema.parse(value);
  for (const environment of document.executionEnvironments) {
    const pathModule = environment.kind === "outbound" ? environment.platform === "win32" ? path.win32 : path.posix : environment.kind === "ssh" ? path.posix : path;
    for (const root of environment.workspaceRoots) {
      if (!pathModule.isAbsolute(root) || pathModule.normalize(root) !== root ||
        (root !== pathModule.parse(root).root && root.endsWith(pathModule.sep))) {
        throw new DomainError("bad_request", "Workspace roots must be canonical absolute paths in their execution environment.");
      }
    }
  }
  for (const backend of document.backends) {
    if (Object.keys(backend.environmentVariables?.startup ?? {}).length > 0 && (backend.kind === "pi" || (backend.kind === "codex_app_server" && backend.moduleConfiguration.connection.ownership === "external"))) {
      throw new DomainError("bad_request", "Startup variables require a provider process launched by Sedes. Configure external provider processes at their owner.");
    }
    const targets = document.targets.filter(target => target.backendInstanceId === backend.id);
    for (const target of targets) {
      const host = document.executionEnvironments.find(item => item.id === target.executionEnvironmentId);
      mergeEnvironmentVariableOverrides(host?.environmentVariables?.execution ?? {}, backend.environmentVariables?.execution ?? {});
      if (backend.kind !== "pi" && (backend.kind !== "codex_app_server" || backend.moduleConfiguration.connection.ownership === "owned")) {
        mergeEnvironmentVariableOverrides(host?.environmentVariables?.startup ?? {}, backend.environmentVariables?.startup ?? {});
      }
    }
    const input: BackendModuleConfigurationInput = {
      backend: { ...backend, protocolRelease: "configuration-validation" },
      connections: targets,
      executionEnvironments: document.executionEnvironments,
      environment: {},
    };
    try {
      switch (backend.kind) {
        case "codex_app_server": parseCodexBackendConfiguration(input); break;
        case "claude_agent_sdk": parseClaudeBackendConfiguration(input); break;
        case "grok_build": parseGrokBackendConfiguration({ ...input, backend: { ...input.backend, kind: "grok_build" },
          connections: input.connections.map(connection => ({ ...connection, kind: "grok_acp" as const })) }); break;
        case "pi": compileBackendModelPolicy(backend.modelPolicy, "provider_model_effort"); break;
      }
    } catch {
      // Native parser exceptions may contain configuration detail. Keep the
      // administrative error bounded and free of secret paths/provider payloads.
      throw new DomainError("bad_request", `The ${backend.kind} configuration or target defaults are invalid.`);
    }
  }
  // An execution account's native default cannot be compared with explicit
  // paths without entering that environment. Require explicit identities when
  // multiple Claude backends share it, rather than admit an ambiguous alias.
  for (const environment of document.executionEnvironments) {
    const claudeBackends = document.backends.filter(backend =>
      backend.kind === "claude_agent_sdk" && backend.enabled &&
      document.targets.some(target => target.enabled && target.backendInstanceId === backend.id && target.executionEnvironmentId === environment.id));
    if (claudeBackends.length > 1 && claudeBackends.some(backend =>
      backend.kind === "claude_agent_sdk" && backend.moduleConfiguration.configDirectory === undefined)) {
      throw new DomainError("bad_request", "Set explicit configuration directories for every Claude backend when multiple enabled Claude backends share an execution environment.");
    }
  }
  return document;
}
