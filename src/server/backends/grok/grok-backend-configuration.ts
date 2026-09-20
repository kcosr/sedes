import path from "node:path";
import { z } from "zod";
import {
  compileBackendModelPolicy,
  type BackendModelPolicy,
  type CompiledBackendModelPolicy,
} from "../model-policy.js";

const canonicalAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .superRefine((value, context) => {
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({
        code: "custom",
        message: "Grok paths cannot contain control characters.",
      });
      return;
    }
    if (!path.isAbsolute(value) || path.resolve(value) !== value) {
      context.addIssue({
        code: "custom",
        message: "Grok paths must be canonical absolute paths.",
      });
    }
  });

const modelIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const effortIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

const grokBackendModuleConfigurationSchema = z
  .object({
    connection: z
      .object({
        ownership: z.literal("owned"),
        channel: z
          .object({
            type: z.literal("process_stdio"),
            executablePath: canonicalAbsolutePathSchema.optional(),
            workingDirectoryPolicy: z.literal("workspace"),
          })
          .strict(),
      })
      .strict(),
    authentication: z
      .object({
        type: z.literal("native"),
      })
      .strict(),
    security: z
      .object({
        profile: z.literal("unrestricted_v1"),
        sandboxProfile: z.literal("off"),
        networkAccess: z.literal("enabled"),
        approvalMode: z.literal("full_access"),
      })
      .strict(),
  })
  .strict();

const grokConnectionModuleConfigurationSchema = z
  .object({
    defaults: z
      .object({
        model: z.discriminatedUnion("type", [
          z.object({ type: z.literal("catalogDefault") }).strict(),
          z
            .object({ type: z.literal("fixed"), modelId: modelIdSchema })
            .strict(),
        ]),
        reasoningEffort: z.discriminatedUnion("type", [
          z.object({ type: z.literal("modelDefault") }).strict(),
          z
            .object({ type: z.literal("fixed"), effortId: effortIdSchema })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();

export type GrokBackendModuleConfiguration = z.infer<
  typeof grokBackendModuleConfigurationSchema
>;
export type GrokConnectionModuleConfiguration = z.infer<
  typeof grokConnectionModuleConfigurationSchema
>;

export interface GrokBackendConfigurationInput {
  readonly backend: {
    readonly id: string;
    readonly kind: "grok_build";
    readonly enabled: boolean;
    readonly modelPolicy: BackendModelPolicy;
    readonly moduleConfiguration?: Readonly<Record<string, unknown>>;
  };
  readonly connections: readonly {
    readonly id: string;
    readonly kind: "grok_acp";
    readonly backendInstanceId: string;
    readonly executionEnvironmentId: string;
    readonly enabled: boolean;
    readonly moduleConfiguration?: Readonly<Record<string, unknown>>;
  }[];
  readonly executionEnvironments: readonly {
    readonly id: string;
    readonly kind: "local" | "ssh" | "outbound";
  }[];
}

export interface PreparedGrokBackendConfiguration {
  readonly backendInstanceId: string;
  readonly enabled: boolean;
  readonly runtime: GrokBackendModuleConfiguration;
  readonly modelPolicy: CompiledBackendModelPolicy;
  readonly executionEnvironmentId?: string;
  readonly connections: readonly Readonly<{
    id: string;
    enabled: boolean;
    executionEnvironmentId: string;
    configuration: GrokConnectionModuleConfiguration;
  }>[];
}

export function parseGrokBackendConfiguration(
  input: GrokBackendConfigurationInput,
): PreparedGrokBackendConfiguration {
  if (input.backend.kind !== "grok_build") {
    throw new Error("grok_backend_configuration_invalid");
  }
  const runtime = grokBackendModuleConfigurationSchema.parse(
    input.backend.moduleConfiguration,
  );
  const modelPolicy = compileBackendModelPolicy(
    input.backend.modelPolicy,
    "model_effort",
  );
  const connections = input.connections.map((connection) => {
    if (
      connection.kind !== "grok_acp" ||
      connection.backendInstanceId !== input.backend.id
    ) {
      throw new Error("grok_connection_configuration_invalid");
    }
    return {
      id: connection.id,
      enabled: connection.enabled,
      executionEnvironmentId: connection.executionEnvironmentId,
      configuration: grokConnectionModuleConfigurationSchema.parse(
        connection.moduleConfiguration,
      ),
    };
  });
  for (const connection of connections) {
    const environment = input.executionEnvironments.find(
      ({ id }) => id === connection.executionEnvironmentId,
    );
    if (!environment || environment.kind !== "local") {
      throw new Error("grok_execution_environment_invalid");
    }
    const { model, reasoningEffort } = connection.configuration.defaults;
    if (model.type === "catalogDefault" && reasoningEffort.type === "fixed") {
      throw new Error("grok_fixed_effort_requires_fixed_model");
    }
    if (
      model.type === "fixed" &&
      (reasoningEffort.type === "fixed"
        ? !modelPolicy.isSelectionAllowed({
            modelId: model.modelId,
            reasoningEffort: reasoningEffort.effortId,
          })
        : !modelPolicy.isModelWithoutReasoningEffortAllowed({
            modelId: model.modelId,
          }))
    ) {
      throw new Error("grok_connection_defaults_outside_model_policy");
    }
  }
  const enabledEnvironmentIds = new Set(
    connections
      .filter(({ enabled }) => enabled)
      .map(({ executionEnvironmentId }) => executionEnvironmentId),
  );
  const executionEnvironmentId = [...enabledEnvironmentIds][0];
  if (
    input.backend.enabled &&
    (enabledEnvironmentIds.size !== 1 || !executionEnvironmentId)
  ) {
    throw new Error("grok_execution_environment_invalid");
  }
  return deepFreeze({
    backendInstanceId: input.backend.id,
    enabled: input.backend.enabled,
    runtime,
    modelPolicy,
    ...(executionEnvironmentId ? { executionEnvironmentId } : {}),
    connections,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
