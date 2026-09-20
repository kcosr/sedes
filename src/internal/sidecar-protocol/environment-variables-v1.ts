import { z } from "zod";
import { ENVIRONMENT_VARIABLE_MAX_BYTES, ENVIRONMENT_VARIABLE_MAX_ENTRIES, environmentVariableNameSchema, environmentVariableOverridesSchema, type EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import type { SidecarOperationDefinition } from "./operation-registry.js";

export const resolvedEnvironmentVariablesSchema = z.record(environmentVariableNameSchema, z.union([z.string().max(16_384).refine(value => !value.includes("\0")), z.null()])).refine(value => Object.keys(value).length <= ENVIRONMENT_VARIABLE_MAX_ENTRIES && new TextEncoder().encode(JSON.stringify(value)).byteLength <= ENVIRONMENT_VARIABLE_MAX_BYTES);
export const environmentVariablesResolveOperation: SidecarOperationDefinition<
  { overrides: EnvironmentVariableOverrides },
  { values: Readonly<Record<string, string | null>> }
> = {
  capabilityId: "environment_variables", majorVersion: 1, operation: "variables.resolve",
  requestSchema: z.strictObject({ overrides: environmentVariableOverridesSchema }),
  responseSchema: z.strictObject({ values: resolvedEnvironmentVariablesSchema }),
  lane: "operation", maximumDeadlineMilliseconds: 30_000,
};
