import { z } from "zod";
import { ENVIRONMENT_VARIABLE_MAX_BYTES, ENVIRONMENT_VARIABLE_MAX_ENTRIES, environmentVariableNameSchema, environmentVariableOverridesSchema, type EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import {defineSidecarOperation,type SidecarOperationDefinition } from "./operation-registry.js";

export const resolvedEnvironmentVariablesSchema = z.record(environmentVariableNameSchema, z.union([z.string().max(16_384).refine(value => !value.includes("\0")), z.null()])).refine(value => Object.keys(value).length <= ENVIRONMENT_VARIABLE_MAX_ENTRIES && new TextEncoder().encode(JSON.stringify(value)).byteLength <= ENVIRONMENT_VARIABLE_MAX_BYTES);
const owner = z.strictObject({backendInstanceId:z.string().min(1).max(256),threadId:z.string().min(1).max(256)});
export const authorizeVariableResolutionOperation = defineSidecarOperation({
  capabilityId:"control",majorVersion:3,operation:"policy.authorize_variables",lane:"control",maximumDeadlineMilliseconds:10_000,
  requestSchema:owner.extend({digest:z.string().regex(/^[0-9a-f]{64}$/u)}),
  responseSchema:z.strictObject({ticket:z.uuid()}),
});
export const environmentVariablesResolveOperation: SidecarOperationDefinition<
  { backendInstanceId:string; threadId:string; ticket:string; overrides: EnvironmentVariableOverrides },
  { values: Readonly<Record<string, string | null>> }
> = {
  capabilityId: "environment_variables", majorVersion: 1, operation: "variables.resolve",
  requestSchema: owner.extend({ticket:z.uuid(),overrides: environmentVariableOverridesSchema }),
  responseSchema: z.strictObject({ values: resolvedEnvironmentVariablesSchema }),
  lane: "operation", maximumDeadlineMilliseconds: 30_000,
};
