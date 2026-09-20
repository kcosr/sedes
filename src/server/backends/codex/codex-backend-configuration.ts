import path from "node:path";
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
  CODEX_APPROVAL_POLICIES,
  CODEX_APPROVAL_REVIEWERS,
  CODEX_NETWORK_ACCESS_VALUES,
  CODEX_SANDBOX_MODES,
  assertCodexExecutionPolicySelection,
  hasAllowedCodexExecutionPolicySelection,
  isCodexExecutionPolicyAllowed,
} from "./codex-execution-policy.js";
import { CODEX_APP_SERVER_RELEASE } from "./codex-release-guard.js";

const absoluteCanonicalPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .superRefine((value, context) => {
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({
        code: "custom",
        message: "Codex paths cannot contain control characters.",
      });
      return;
    }
    if (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)) {
      context.addIssue({
        code: "custom",
        message: "Codex paths must be absolute.",
      });
      return;
    }
    if (!normalizedAbsolutePath(value)) {
      context.addIssue({
        code: "custom",
        message: "Codex paths must be lexically canonical.",
      });
    }
  });

const unixSocketPathSchema = absoluteCanonicalPathSchema.refine(
  (value) => value.startsWith("/") && Buffer.byteLength(value, "utf8") <= 107,
  "Codex Unix socket paths exceed the Linux filesystem-socket limit.",
);

const modelIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

const environmentVariableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^SEDES_CODEX_[A-Z0-9_]*TOKEN[A-Z0-9_]*$/);

const secretReferenceSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("environment"),
      variable: environmentVariableNameSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("protected_file"),
      path: absoluteCanonicalPathSchema,
    })
    .strict(),
]);

const tcpWebSocketUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    if (/[^\u0021-\u007e]/u.test(value) || value.includes("\\")) {
      context.addIssue({
        code: "custom",
        message:
          "Codex TCP WebSocket URLs must contain only visible ASCII URL characters.",
      });
      return;
    }
    const match = /^(wss?):\/\/(\[[^\]]+\]|[^:/?#]+):([0-9]{1,5})$/u.exec(
      value,
    );
    if (match === null) {
      context.addIssue({
        code: "custom",
        message:
          "Codex TCP WebSocket URLs require ws or wss, an explicit port, and no userinfo, path, query, or fragment.",
      });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Codex TCP WebSocket URL is invalid.",
      });
      return;
    }

    const rawHost = match[2]!;
    const port = Number(match[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      context.addIssue({
        code: "custom",
        message: "Codex TCP WebSocket URL port is invalid.",
      });
    }

    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Codex TCP WebSocket URLs cannot contain userinfo, a path, a query, or a fragment.",
      });
    }

    if (
      rawHost.includes("%") ||
      rawHost.endsWith(".") ||
      parsed.hostname !== rawHost ||
      String(port) !== match[3]
    ) {
      context.addIssue({
        code: "custom",
        message: "Codex TCP WebSocket host must use its canonical spelling.",
      });
    }

    if (
      parsed.protocol === "ws:" &&
      rawHost !== "127.0.0.1" &&
      rawHost !== "[::1]"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Plaintext Codex WebSocket URLs must use a literal loopback host.",
      });
    }
  });

const sandboxModeSchema = z.enum(CODEX_SANDBOX_MODES);
const networkAccessSchema = z.enum(CODEX_NETWORK_ACCESS_VALUES);
const approvalPolicySchema = z.enum(CODEX_APPROVAL_POLICIES);
const approvalReviewerSchema = z.enum(CODEX_APPROVAL_REVIEWERS);

function uniqueNonEmptyArray<T extends z.ZodType>(
  valueSchema: T,
  label: string,
) {
  return z
    .array(valueSchema)
    .min(1)
    .max(64)
    .superRefine((values, context) => {
      const seen = new Set<unknown>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            message: `${label} contains a duplicate value.`,
            path: [index],
          });
        }
        seen.add(value);
      }
    });
}

const codexExecutionPolicySchema = z
  .object({
    allowedSandboxModes: uniqueNonEmptyArray(
      sandboxModeSchema,
      "Allowed sandbox modes",
    ),
    allowedNetworkAccess: uniqueNonEmptyArray(
      networkAccessSchema,
      "Allowed network access values",
    ),
    allowedApprovalPolicies: uniqueNonEmptyArray(
      approvalPolicySchema,
      "Allowed approval policies",
    ),
    allowedApprovalReviewers: uniqueNonEmptyArray(
      approvalReviewerSchema,
      "Allowed approval reviewers",
    ),
  })
  .strict()
  .superRefine((policy, context) => {
    if (!hasAllowedCodexExecutionPolicySelection(policy)) {
      context.addIssue({
        code: "custom",
        message: "The Codex execution policy allows no valid setting tuple.",
      });
    }
  });

const codexBackendModuleConfigurationSchema = z
  .object({
    tuiExecutablePath: absoluteCanonicalPathSchema.optional(),
    connection: z.discriminatedUnion("ownership", [
      z
        .object({
          ownership: z.literal("owned"),
          channel: z
            .object({
              type: z.literal("process_stdio"),
              executablePath: absoluteCanonicalPathSchema.optional(),
              workingDirectory: absoluteCanonicalPathSchema,
              codexHome: absoluteCanonicalPathSchema.optional(),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          ownership: z.literal("external"),
          channel: z.discriminatedUnion("type", [
            z
              .object({
                type: z.literal("unix_websocket"),
                socketPath: unixSocketPathSchema,
              })
              .strict(),
            z
              .object({
                type: z.literal("tcp_websocket"),
                url: tcpWebSocketUrlSchema,
                authentication: z
                  .object({
                    type: z.literal("capability_token"),
                    secret: secretReferenceSchema,
                  })
                  .strict(),
              })
              .strict(),
          ]),
        })
        .strict(),
    ]),
    policy: codexExecutionPolicySchema,
  })
  .strict();

const codexConnectionModuleConfigurationSchema = z
  .object({
    defaults: z
      .object({
        sandboxMode: sandboxModeSchema,
        networkAccess: networkAccessSchema,
        approvalPolicy: approvalPolicySchema,
        approvalReviewer: approvalReviewerSchema,
        model: z.discriminatedUnion("type", [
          z.object({ type: z.literal("catalogDefault") }).strict(),
          z
            .object({
              type: z.literal("fixed"),
              modelId: modelIdSchema,
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();

export const codexRuntimeConnectionSchema = codexBackendModuleConfigurationSchema.shape.connection;

export type CodexBackendModuleConfiguration = z.infer<
  typeof codexBackendModuleConfigurationSchema
>;
export type CodexConnectionModuleConfiguration = z.infer<
  typeof codexConnectionModuleConfigurationSchema
>;

export interface PreparedCodexConnectionConfiguration {
  readonly id: string;
  readonly enabled: boolean;
  readonly configuration: CodexConnectionModuleConfiguration;
}

export interface PreparedCodexBackendConfiguration {
  readonly backendInstanceId: string;
  readonly protocolRelease: string;
  readonly configuration: CodexBackendModuleConfiguration;
  readonly modelPolicy: CompiledBackendModelPolicy;
  readonly connections: readonly PreparedCodexConnectionConfiguration[];
}

export function parseCodexBackendConfiguration(
  input: BackendModuleConfigurationInput,
): PreparedCodexBackendConfiguration {
  if (input.backend.kind !== "codex_app_server") {
    throw new Error("codex_backend_release_configuration_invalid");
  }

  const configuration = codexBackendModuleConfigurationSchema.parse(
    input.backend.moduleConfiguration,
  );
  if (input.backend.modelPolicy.type !== "catalog") {
    const matchers =
      input.backend.modelPolicy.type === "allowlist"
        ? input.backend.modelPolicy.allowed
        : input.backend.modelPolicy.denied;
    for (const matcher of matchers) {
      for (const modelId of matcher.modelIds ?? [])
        modelIdSchema.parse(modelId);
    }
  }
  const modelPolicy = compileBackendModelPolicy(
    input.backend.modelPolicy,
    "model_effort",
  );
  const connections = input.connections.map((connection) =>
    parseConnection(input.backend.id, connection),
  );
  for (const connection of connections) {
    assertDefaultsAllowed(configuration, modelPolicy, connection);
  }

  return deepFreeze({
    backendInstanceId: input.backend.id,
    protocolRelease: CODEX_APP_SERVER_RELEASE,
    configuration,
    modelPolicy,
    connections,
  });
}

function parseConnection(
  backendInstanceId: string,
  connection: BackendModuleConnectionConfiguration,
): PreparedCodexConnectionConfiguration {
  if (
    connection.kind !== "codex_app_server" ||
    connection.backendInstanceId !== backendInstanceId
  ) {
    throw new Error("codex_connection_configuration_invalid");
  }
  return {
    id: connection.id,
    enabled: connection.enabled,
    configuration: codexConnectionModuleConfigurationSchema.parse(
      connection.moduleConfiguration,
    ),
  };
}

function assertDefaultsAllowed(
  backend: CodexBackendModuleConfiguration,
  modelPolicy: CompiledBackendModelPolicy,
  connection: PreparedCodexConnectionConfiguration,
): void {
  const defaults = connection.configuration.defaults;
  try {
    assertCodexExecutionPolicySelection(defaults);
  } catch {
    throw new Error("codex_connection_defaults_invalid");
  }
  if (!isCodexExecutionPolicyAllowed(defaults, backend.policy)) {
    throw new Error("codex_connection_defaults_outside_backend_policy");
  }
  if (modelPolicy.policy.type === "allowlist") {
    if (defaults.model.type !== "fixed") {
      throw new Error("codex_connection_defaults_outside_backend_policy");
    }
    const fixedModelId = defaults.model.modelId;
    if (
      !modelPolicy.policy.allowed.some(
        ({ modelIds }) =>
          modelIds === undefined || modelIds.includes(fixedModelId),
      )
    ) {
      throw new Error("codex_connection_defaults_outside_backend_policy");
    }
  } else if (
    modelPolicy.policy.type === "denylist" &&
    defaults.model.type === "fixed"
  ) {
    const fixedModelId = defaults.model.modelId;
    if (
      modelPolicy.policy.denied.some(
        ({ modelIds, providerIds, reasoningEfforts }) =>
          providerIds === undefined &&
          reasoningEfforts === undefined &&
          modelIds?.includes(fixedModelId) === true,
      )
    ) {
      throw new Error("codex_connection_defaults_outside_backend_policy");
    }
  }
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
