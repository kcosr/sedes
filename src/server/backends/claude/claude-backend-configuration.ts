import { normalizedAbsolutePath } from "../../../shared/absolute-path.js";
import { z } from "zod";
import type {
  BackendModuleConfigurationInput,
  BackendModuleConnectionConfiguration,
} from "../module.js";
import {
  compileBackendModelPolicy,
  type CompiledBackendModelPolicy,
} from "../model-policy.js";
import {
  CLAUDE_PERMISSION_MODES,
  isClaudePermissionModeAllowed,
  type ClaudePermissionMode,
  type ClaudePermissionPolicy,
} from "./claude-permission-policy.js";

const canonicalEnvironmentAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .superRefine((value, context) => {
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({
        code: "custom",
        message: "Claude environment paths cannot contain control characters.",
      });
      return;
    }
    if (!normalizedAbsolutePath(value)) {
      context.addIssue({
        code: "custom",
        message: "Claude environment paths must be canonical absolute paths.",
      });
    }
  });

const claudeBackendModuleConfigurationSchema = z
  .object({
    executablePath: canonicalEnvironmentAbsolutePathSchema.optional(),
    configDirectory: canonicalEnvironmentAbsolutePathSchema.optional(),
    initializationTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(20_000),
    permissionPolicy: z
      .object({
        allowedModes: z
          .array(z.enum(CLAUDE_PERMISSION_MODES))
          .min(1)
          .max(CLAUDE_PERMISSION_MODES.length)
          .superRefine((values, context) => {
            const seen = new Set<ClaudePermissionMode>();
            for (const [index, value] of values.entries()) {
              if (seen.has(value)) {
                context.addIssue({
                  code: "custom",
                  message:
                    "The Claude permission-mode allowlist contains a duplicate value.",
                  path: [index],
                });
              }
              seen.add(value);
            }
          }),
      })
      .strict(),
  })
  .strict();

const claudeConnectionModuleConfigurationSchema = z
  .object({
    defaults: z
      .object({
        permissionMode: z
          .enum(CLAUDE_PERMISSION_MODES)
          .refine(
            (value) => value !== "bypassPermissions",
            "Bypass permissions cannot be a Claude connection default.",
          ),
      })
      .strict(),
  })
  .strict();

export interface ClaudeBackendModuleConfiguration {
  readonly executablePath?: string;
  readonly configDirectory?: string;
  readonly initializationTimeoutMs: number;
  readonly permissionPolicy: ClaudePermissionPolicy;
}

export type ClaudeConnectionModuleConfiguration = z.infer<
  typeof claudeConnectionModuleConfigurationSchema
>;

export interface PreparedClaudeConnectionConfiguration {
  readonly id: string;
  readonly enabled: boolean;
  readonly configuration: ClaudeConnectionModuleConfiguration;
}

export interface PreparedClaudeBackendConfiguration {
  readonly backendInstanceId: string;
  readonly runtime: ClaudeBackendModuleConfiguration;
  readonly modelPolicy: CompiledBackendModelPolicy;
  readonly connections: readonly PreparedClaudeConnectionConfiguration[];
}

export function parseClaudeBackendConfiguration(
  input: BackendModuleConfigurationInput,
): PreparedClaudeBackendConfiguration {
  if (input.backend.kind !== "claude_agent_sdk") {
    throw new Error("claude_backend_configuration_invalid");
  }
  const runtime = claudeBackendModuleConfigurationSchema.parse(
    input.backend.moduleConfiguration,
  );
  const modelPolicy = compileBackendModelPolicy(
    input.backend.modelPolicy,
    "model_effort",
  );
  const connections = input.connections.map((connection) =>
    parseConnection(input.backend.id, connection),
  );
  for (const connection of connections) {
    if (
      !isClaudePermissionModeAllowed(
        connection.configuration.defaults.permissionMode,
        runtime.permissionPolicy,
      )
    ) {
      throw new Error("claude_connection_defaults_outside_backend_policy");
    }
  }
  return deepFreeze({
    backendInstanceId: input.backend.id,
    runtime,
    modelPolicy,
    connections,
  });
}

function parseConnection(
  backendInstanceId: string,
  connection: BackendModuleConnectionConfiguration,
): PreparedClaudeConnectionConfiguration {
  if (
    connection.backendInstanceId !== backendInstanceId ||
    connection.kind !== "claude_agent_sdk"
  ) {
    throw new Error("claude_connection_configuration_invalid");
  }
  return {
    id: connection.id,
    enabled: connection.enabled,
    configuration: claudeConnectionModuleConfigurationSchema.parse(
      connection.moduleConfiguration,
    ),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
