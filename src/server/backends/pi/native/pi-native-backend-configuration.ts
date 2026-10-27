import path from "node:path";
import {
  piNativeConnectionConfigurationSchema,
  piNativeModuleConfigurationSchema,
  piNativeThinkingLevelSchema,
  type PiNativeConnectionDefaults,
} from "../../../../shared/protocol/pi-configuration.js";
import { mergeEnvironmentVariableOverrides } from "../../../../shared/protocol/environment-variables.js";
import { compileBackendModelPolicy } from "../../model-policy.js";
import type { BackendModuleConfigurationInput } from "../../module.js";

/** Pure preparation shared by administration and direct module callers. */
export function parsePiNativeBackendConfiguration(input: BackendModuleConfigurationInput) {
  if (input.backend.kind !== "pi_native") throw new Error("pi_native_backend_kind_invalid");
  const moduleConfiguration = piNativeModuleConfigurationSchema.parse(input.backend.moduleConfiguration ?? {});
  const modelPolicy = compileBackendModelPolicy(input.backend.modelPolicy, "provider_model_effort");
  const defaultsByConnectionId = new Map<string, PiNativeConnectionDefaults>();
  const environmentIds = new Set<string>();
  for (const connection of input.connections) {
    if (connection.kind !== "pi_rpc" || connection.backendInstanceId !== input.backend.id ||
        defaultsByConnectionId.has(connection.id) || (connection.enabled && !input.backend.enabled)) {
      throw new Error("pi_native_connection_invalid");
    }
    const defaults = piNativeConnectionConfigurationSchema.parse(connection.moduleConfiguration ?? {}).defaults;
    if (defaults.model !== undefined) {
      const efforts = defaults.thinkingLevel === undefined ? piNativeThinkingLevelSchema.options : [defaults.thinkingLevel];
      if (!efforts.some(reasoningEffort => modelPolicy.isSelectionAllowed({
        providerId: defaults.provider, modelId: defaults.model!, reasoningEffort,
      }))) throw new Error("pi_native_default_model_forbidden");
    }
    defaultsByConnectionId.set(connection.id, defaults);
    environmentIds.add(connection.executionEnvironmentId);
  }
  // Disabled targets still determine ownership and retained-runtime administration.
  if (environmentIds.size > 1 || (input.backend.enabled && environmentIds.size !== 1)) {
    throw new Error("pi_native_execution_environment_invalid");
  }
  const executionEnvironmentId = [...environmentIds][0];
  const environments = input.executionEnvironments.filter(environment => environment.id === executionEnvironmentId);
  if (executionEnvironmentId !== undefined && environments.length !== 1) {
    throw new Error("pi_native_execution_environment_invalid");
  }
  const executionEnvironment = environments[0];
  const platform = executionEnvironment?.kind === "local" ? process.platform : executionEnvironment?.platform;
  if (input.backend.enabled && platform === "win32") throw new Error("pi_native_windows_unsupported");
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  for (const value of [moduleConfiguration.executablePath, moduleConfiguration.agentDirectory, moduleConfiguration.sessionDirectory]) {
    if (value !== undefined && (!pathModule.isAbsolute(value) || pathModule.normalize(value) !== value)) {
      throw new Error("pi_native_invalid_execution_host_path");
    }
  }
  const startupEnvironmentVariables = mergeEnvironmentVariableOverrides(
    executionEnvironment?.environmentVariables?.startup ?? {}, input.backend.environmentVariables?.startup ?? {},
  );
  return {
    moduleConfiguration, modelPolicy, defaultsByConnectionId, startupEnvironmentVariables,
    executionEnvironmentId, environmentKind: executionEnvironment?.kind,
  };
}
