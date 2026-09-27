import { z } from "zod";
import {
  opencodeModuleConfigurationSchema,
  opencodeConnectionDefaultsSchema,
  type OpenCodeModuleConfiguration,
  type OpenCodeConnectionDefaults,
} from "../../../shared/protocol/opencode-configuration.js";
import type { BackendModuleConfigurationInput } from "../module.js";
import { compileBackendModelPolicy, type CompiledBackendModelPolicy } from "../model-policy.js";

export { opencodeModuleConfigurationSchema, opencodeConnectionDefaultsSchema };
export type { OpenCodeModuleConfiguration, OpenCodeConnectionDefaults };
export interface PreparedOpenCodeBackendConfiguration extends OpenCodeModuleConfiguration {
  readonly backendInstanceId: string;
  readonly enabled: boolean;
  readonly modelPolicy: CompiledBackendModelPolicy;
  readonly defaultsByConnectionId: ReadonlyMap<string, OpenCodeConnectionDefaults>;
}

/** Pure parsing: native identity, file admission and secret resolution happen at runtime. */
export function parseOpenCodeBackendConfiguration(input: BackendModuleConfigurationInput): PreparedOpenCodeBackendConfiguration {
  if (input.backend.kind !== "opencode") throw new Error("opencode_backend_kind_invalid");
  const configuration = opencodeModuleConfigurationSchema.parse(input.backend.moduleConfiguration);
  if (input.backend.modelPolicy.type !== "catalog") {
    throw new Error("opencode_restrictive_model_policy_unsupported");
  }
  if (configuration.connection.ownership === "external" &&
      Object.keys(input.backend.environmentVariables?.startup ?? {}).length > 0) {
    throw new Error("opencode_external_startup_environment_unsupported");
  }
  const defaultsByConnectionId = new Map<string, OpenCodeConnectionDefaults>();
  for (const connection of input.connections) {
    const environment = input.executionEnvironments.find(item => item.id === connection.executionEnvironmentId);
    if (connection.kind !== "opencode_http" || connection.backendInstanceId !== input.backend.id ||
        !environment || environment.kind !== "local" || defaultsByConnectionId.has(connection.id)) {
      throw new Error("opencode_connection_authority_invalid");
    }
    const parsed = z.strictObject({ defaults: opencodeConnectionDefaultsSchema }).parse(connection.moduleConfiguration);
    defaultsByConnectionId.set(connection.id, parsed.defaults);
  }
  return { ...configuration, backendInstanceId: input.backend.id, enabled: input.backend.enabled,
    modelPolicy: compileBackendModelPolicy(input.backend.modelPolicy, "provider_model_effort"), defaultsByConnectionId };
}
