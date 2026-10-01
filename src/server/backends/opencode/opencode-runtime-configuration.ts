import { z } from "zod";
import { environmentVariableOverridesSchema } from "../../../shared/protocol/environment-variables.js";
import { opencodeModuleConfigurationSchema } from "../../../shared/protocol/opencode-configuration.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ExecutionEnvironmentChannelProvider } from "../../execution/environment-channel.js";
import { mergeResolvedEnvironment, resolveEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { OPENCODE_RELEASE, OpenCodeRuntimeError } from "./opencode-release.js";
import type { OpenCodeRuntimeInput } from "./opencode-runtime.js";

const id = z.string().min(1).max(256);
const instanceSchema = z.strictObject({ id, tenantId: id, kind: z.literal("opencode"),
  label: z.string().min(1).max(512), enabled: z.boolean(), configurationRevision: z.number().int().nonnegative(),
  protocolRelease: z.literal(OPENCODE_RELEASE) });
const connectionSchema = z.strictObject({ id, tenantId: id, ownerPrincipalId: id, templateId: id,
  kind: z.literal("opencode_http"), backendInstanceId: id, executionEnvironmentId: id,
  label: z.string().min(1).max(512), enabled: z.boolean(), configurationRevision: z.number().int().nonnegative() });

/** Definitions and execution-host paths only. Resolved credentials never cross
 * the main/host boundary. Local composition uses this same contract. */
export const openCodeRuntimeConfigurationSchema = opencodeModuleConfigurationSchema.extend({
  instance: instanceSchema,
  connections: z.array(connectionSchema).min(1).max(256),
  startupEnvironmentVariables: environmentVariableOverridesSchema.optional(),
});
export type OpenCodeRuntimeConfiguration = z.infer<typeof openCodeRuntimeConfigurationSchema>;

export function admitOpenCodeRuntimeConfiguration(configuration: unknown, scope: RequestScope,
  executionEnvironmentId: string): OpenCodeRuntimeConfiguration {
  let parsed: OpenCodeRuntimeConfiguration;
  try { parsed = openCodeRuntimeConfigurationSchema.parse(configuration); }
  catch { throw new OpenCodeRuntimeError("opencode_runtime_configuration_invalid"); }
  if (parsed.instance.tenantId !== scope.tenantId ||
      new Set(parsed.connections.map(item => item.id)).size !== parsed.connections.length ||
      new Set(parsed.connections.map(item => item.templateId)).size !== parsed.connections.length ||
      parsed.connections.some(item => item.tenantId !== scope.tenantId || item.ownerPrincipalId !== scope.principalId ||
        item.executionEnvironmentId !== executionEnvironmentId || item.backendInstanceId !== parsed.instance.id)) {
    throw new OpenCodeRuntimeError("opencode_runtime_configuration_scope_denied");
  }
  if (parsed.connection.ownership === "external" && Object.keys(parsed.startupEnvironmentVariables ?? {}).length) {
    throw new OpenCodeRuntimeError("opencode_external_environment_unsupported");
  }
  return parsed;
}

export async function resolveOpenCodeRuntimeInput(input: {
  readonly configuration: OpenCodeRuntimeConfiguration;
  readonly scope: RequestScope;
  readonly executionEnvironmentId: string;
  readonly hostIncarnation: string;
  readonly environmentChannel: ExecutionEnvironmentChannelProvider;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly agentTools?: OpenCodeRuntimeInput["agentTools"];
}): Promise<OpenCodeRuntimeInput> {
  const configuration = admitOpenCodeRuntimeConfiguration(input.configuration, input.scope, input.executionEnvironmentId);
  if (input.environmentChannel.executionEnvironmentId !== input.executionEnvironmentId ||
      input.environmentChannel.scope.tenantId !== input.scope.tenantId ||
      input.environmentChannel.scope.principalId !== input.scope.principalId ||
      !id.safeParse(input.hostIncarnation).success) throw new OpenCodeRuntimeError("opencode_runtime_configuration_scope_denied");
  const baseline = { ...input.environment };
  const environment = configuration.connection.ownership === "owned"
    ? mergeResolvedEnvironment(baseline, await resolveEnvironmentVariables(configuration.startupEnvironmentVariables ?? {}, baseline))
    : baseline;
  const authority = { ...input.scope, backendInstanceId: configuration.instance.id, executionEnvironmentId: input.executionEnvironmentId };
  const connection = configuration.connection;
  let secretGeneration = 0;
  return {
    authority, hostIncarnation: input.hostIncarnation,
    ...(configuration.nativeStorePath ? { nativeStorePath: configuration.nativeStorePath } : {}),
    ...(configuration.configDirectory ? { configDirectory: configuration.configDirectory } : {}),
    environment,
    ...(input.agentTools ? { agentTools: input.agentTools } : {}),
    connection: connection.ownership === "owned" ? connection
      : { ownership: "external", channel: { type: "http", url: connection.channel.url } },
    ...(connection.ownership === "external" ? { externalPassword: async () => {
      const secret = await input.environmentChannel.resolveSecret(authority, connection.channel.authentication.secret,
        ++secretGeneration, AbortSignal.timeout(10_000), "http_basic_password");
      try { return secret.value; } finally { secret.discard(); }
    } } : {}),
  };
}
