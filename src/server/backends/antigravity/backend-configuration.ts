import path from "node:path";
import { antigravityConnectionConfigurationSchema, antigravityModuleConfigurationSchema, type AntigravityConnectionConfiguration } from "../../../shared/protocol/antigravity-configuration.js";
import { mergeEnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { compileBackendModelPolicy } from "../model-policy.js";
import type { BackendModuleConfigurationInput } from "../module.js";

export function parseAntigravityBackendConfiguration(input: BackendModuleConfigurationInput) {
  if (input.backend.kind !== "antigravity") throw new Error("antigravity_backend_kind_invalid");
  const moduleConfiguration = antigravityModuleConfigurationSchema.parse(input.backend.moduleConfiguration ?? {});
  const modelPolicy = compileBackendModelPolicy(input.backend.modelPolicy, "model_effort");
  const defaultsByConnectionId = new Map<string, AntigravityConnectionConfiguration["defaults"]>();
  const environmentIds = new Set<string>();
  for (const connection of input.connections) {
    if (connection.kind !== "antigravity_acp" || connection.backendInstanceId !== input.backend.id ||
        defaultsByConnectionId.has(connection.id) || (connection.enabled && !input.backend.enabled)) {
      throw new Error("antigravity_connection_invalid");
    }
    const defaults = antigravityConnectionConfigurationSchema.parse(connection.moduleConfiguration ?? {}).defaults;
    if (defaults.modelId && defaults.thinkingLevel && !modelPolicy.isSelectionAllowed({
      modelId: defaults.modelId, reasoningEffort: defaults.thinkingLevel,
    })) throw new Error("antigravity_default_model_forbidden");
    defaultsByConnectionId.set(connection.id, defaults);
    environmentIds.add(connection.executionEnvironmentId);
  }
  if (environmentIds.size > 1 || (input.backend.enabled && environmentIds.size !== 1)) {
    throw new Error("antigravity_execution_environment_invalid");
  }
  const executionEnvironmentId = [...environmentIds][0];
  const environments = input.executionEnvironments.filter(value => value.id === executionEnvironmentId);
  if (executionEnvironmentId !== undefined && environments.length !== 1) throw new Error("antigravity_execution_environment_invalid");
  const environment = environments[0];
  const platform = environment?.kind === "local" ? process.platform : environment?.platform;
  if (input.backend.enabled && platform === "win32") throw new Error("antigravity_windows_unsupported");
  const paths = platform === "win32" ? path.win32 : path.posix;
  for (const value of [moduleConfiguration.executablePath, moduleConfiguration.geminiDirectory]) {
    if (value !== undefined && (!paths.isAbsolute(value) || paths.normalize(value) !== value)) {
      throw new Error("antigravity_invalid_execution_host_path");
    }
  }
  const startupEnvironmentVariables = mergeEnvironmentVariableOverrides(
    environment?.environmentVariables?.startup ?? {}, input.backend.environmentVariables?.startup ?? {},
  );
  return { moduleConfiguration, modelPolicy, defaultsByConnectionId, startupEnvironmentVariables,
    executionEnvironmentId, environmentKind: environment?.kind };
}
