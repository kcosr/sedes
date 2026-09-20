import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { backendModelPolicySchema } from "../backends/model-policy.js";

const configuredIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);

const sshHostAliasSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);

const executionEnvironmentIdSchema = z.string().uuid();

const canonicalRemoteAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      (value === "/" || !value.endsWith("/")) &&
      !value.includes("\0") &&
      !value.includes("\\") &&
      !/[\u0001-\u001f\u007f]/u.test(value),
    "Remote paths must be canonical absolute POSIX paths with no control characters.",
  );

const sshSidecarCapabilityOrder = [
  "directory_browser",
  "workspace_files",
  "workspace_tools",
  "workspace_context",
  "workspace_skills",
  "composer_attachments",
  "agent_tools_cli",
  "interactive_terminal",
] as const;
const sshSidecarCapabilitySchema = z.enum(sshSidecarCapabilityOrder);

const sshOperationsConfigurationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("none"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sidecar"),
      deployment: z.literal("managed"),
      carrier: z
        .object({
          kind: z.literal("ssh_stdio"),
        })
        .strict(),
      enabledCapabilities: z
        .array(sshSidecarCapabilitySchema)
        .min(1)
        .max(sshSidecarCapabilityOrder.length)
        .refine(
          (capabilities) =>
            new Set(capabilities).size === capabilities.length &&
            capabilities.every(
              (capability, index) =>
                capability ===
                sshSidecarCapabilityOrder.filter((candidate) =>
                  capabilities.includes(candidate),
                )[index],
            ),
          "Sidecar capabilities must be unique and in canonical order.",
        )
        .refine(
          (capabilities) =>
            capabilities.includes("workspace_tools") ===
            capabilities.includes("workspace_context"),
          "workspace_tools and workspace_context must be enabled together.",
        ),
    })
    .strict(),
]);

const localWorkspaceIsolationSchema = z
  .object({
    kind: z.literal("bubblewrap"),
    networkProfiles: z.union([
      z.tuple([z.literal("isolated")]),
      z.tuple([z.literal("isolated"), z.literal("execution_host")]),
    ]),
  })
  .strict();

const DEFAULT_LOCAL_WORKSPACE_ISOLATION_POLICY = Object.freeze({
  kind: "bubblewrap" as const,
  networkProfiles: Object.freeze(["isolated"] as const),
});

const executionEnvironmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: executionEnvironmentIdSchema,
      kind: z.literal("local"),
      label: z.string().min(1).max(120),
      workspaceIsolation: localWorkspaceIsolationSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: executionEnvironmentIdSchema,
      kind: z.literal("ssh"),
      label: z.string().min(1).max(120),
      hostAlias: sshHostAliasSchema,
      workspaceRoots: z
        .array(canonicalRemoteAbsolutePathSchema)
        .min(1)
        .max(16)
        .refine((roots) => new Set(roots).size === roots.length),
      operations: sshOperationsConfigurationSchema,
    })
    .strict(),
]);

const moduleConfigurationSchema = z
  .record(z.string().min(1).max(128), z.json())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 16_384,
    "Module configuration exceeds the serialized byte limit.",
  );

const localAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      path.isAbsolute(value) &&
      path.normalize(value) === value &&
      !value.includes("\0") &&
      !/[\u0001-\u001f\u007f]/u.test(value),
    "Local paths must be canonical absolute paths with no control characters.",
  );

const webSearchConfigurationSchema = z
  .object({
    provider: z.literal("grok_cli"),
    grokHome: localAbsolutePathSchema.optional(),
  })
  .strict();

const packagedClientOrder = ["android", "electron"] as const;
const packagedClientsSchema = z
  .array(z.enum(packagedClientOrder))
  .max(packagedClientOrder.length)
  .refine(
    (clients) =>
      new Set(clients).size === clients.length &&
      clients.every(
        (client, index) =>
          client ===
          packagedClientOrder.filter((candidate) =>
            clients.includes(candidate),
          )[index],
      ),
    "Packaged clients must be unique and in canonical order.",
  );

const backendSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: configuredIdSchema,
      kind: z.literal("pi"),
      label: z.string().min(1).max(120),
      enabled: z.boolean(),
      modelPolicy: backendModelPolicySchema,
      moduleConfiguration: moduleConfigurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: configuredIdSchema,
      kind: z.literal("codex_app_server"),
      label: z.string().min(1).max(120),
      enabled: z.boolean(),
      modelPolicy: backendModelPolicySchema,
      moduleConfiguration: moduleConfigurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: configuredIdSchema,
      kind: z.literal("claude_agent_sdk"),
      label: z.string().min(1).max(120),
      enabled: z.boolean(),
      modelPolicy: backendModelPolicySchema,
      moduleConfiguration: moduleConfigurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: configuredIdSchema,
      kind: z.literal("grok_build"),
      label: z.string().min(1).max(120),
      enabled: z.boolean(),
      modelPolicy: backendModelPolicySchema,
      moduleConfiguration: moduleConfigurationSchema.optional(),
    })
    .strict(),
]);

const targetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: configuredIdSchema,
      kind: z.literal("pi_sdk"),
      label: z.string().min(1).max(120),
      backendInstanceId: configuredIdSchema,
      executionEnvironmentId: executionEnvironmentIdSchema,
      enabled: z.boolean(),
      moduleConfiguration: moduleConfigurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: configuredIdSchema,
      kind: z.literal("codex_app_server"),
      label: z.string().min(1).max(120),
      backendInstanceId: configuredIdSchema,
      executionEnvironmentId: executionEnvironmentIdSchema,
      enabled: z.boolean(),
      moduleConfiguration: moduleConfigurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: configuredIdSchema,
      kind: z.literal("claude_agent_sdk"),
      label: z.string().min(1).max(120),
      backendInstanceId: configuredIdSchema,
      executionEnvironmentId: executionEnvironmentIdSchema,
      enabled: z.boolean(),
      moduleConfiguration: moduleConfigurationSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: configuredIdSchema,
      kind: z.literal("grok_acp"),
      label: z.string().min(1).max(120),
      backendInstanceId: configuredIdSchema,
      executionEnvironmentId: executionEnvironmentIdSchema,
      enabled: z.boolean(),
      moduleConfiguration: moduleConfigurationSchema.optional(),
    })
    .strict(),
]);

const backendConfigurationFileSchema = z
  .object({
    schemaVersion: z.literal(10),
    packagedClients: packagedClientsSchema.default([]),
    executionEnvironments: z.array(executionEnvironmentSchema).min(1).max(16),
    backends: z.array(backendSchema).min(1).max(32),
    targets: z.array(targetSchema).min(1).max(64),
    defaultTargetId: configuredIdSchema,
    webSearch: webSearchConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((configuration, context) => {
    const duplicateEnvironmentIds = duplicateIds(
      configuration.executionEnvironments,
    );
    for (const id of duplicateEnvironmentIds) {
      context.addIssue({
        code: "custom",
        message: `Execution environment ID "${id}" is duplicated.`,
        path: ["executionEnvironments"],
      });
    }

    const localEnvironmentCount = configuration.executionEnvironments.filter(
      ({ kind }) => kind === "local",
    ).length;
    if (localEnvironmentCount !== 1) {
      context.addIssue({
        code: "custom",
        message: "Exactly one local execution environment is required.",
        path: ["executionEnvironments"],
      });
    }
    const duplicateBackendIds = duplicateIds(configuration.backends);
    for (const id of duplicateBackendIds) {
      context.addIssue({
        code: "custom",
        message: `Backend ID "${id}" is duplicated.`,
        path: ["backends"],
      });
    }

    const duplicateTargetIds = duplicateIds(configuration.targets);
    for (const id of duplicateTargetIds) {
      context.addIssue({
        code: "custom",
        message: `Target ID "${id}" is duplicated.`,
        path: ["targets"],
      });
    }

    const backendsById = new Map(
      configuration.backends.map((backend) => [backend.id, backend]),
    );
    const environmentsById = new Map(
      configuration.executionEnvironments.map((environment) => [
        environment.id,
        environment,
      ]),
    );
    for (const [index, target] of configuration.targets.entries()) {
      const backend = backendsById.get(target.backendInstanceId);
      if (!backend) {
        context.addIssue({
          code: "custom",
          message: `Target "${target.id}" references an unknown backend.`,
          path: ["targets", index, "backendInstanceId"],
        });
        continue;
      }
      if (target.enabled && !backend.enabled) {
        context.addIssue({
          code: "custom",
          message: `Enabled target "${target.id}" references a disabled backend.`,
          path: ["targets", index, "enabled"],
        });
      }
      const environment = environmentsById.get(target.executionEnvironmentId);
      if (!environment) {
        context.addIssue({
          code: "custom",
          message: `Target "${target.id}" references an unknown execution environment.`,
          path: ["targets", index, "executionEnvironmentId"],
        });
        continue;
      }
      if (target.kind === "grok_acp" && environment.kind !== "local") {
        context.addIssue({
          code: "custom",
          message: `Grok target "${target.id}" must use the local execution environment.`,
          path: ["targets", index, "executionEnvironmentId"],
        });
      }
      if ((target.kind === "grok_acp") !== (backend.kind === "grok_build")) {
        context.addIssue({
          code: "custom",
          message: `Target "${target.id}" is incompatible with backend kind "${backend.kind}".`,
          path: ["targets", index, "backendInstanceId"],
        });
      }
      if (environment.kind === "ssh") {
        if (target.kind === "pi_sdk") {
          const enabledCapabilities =
            environment.operations.kind === "sidecar"
              ? new Set(environment.operations.enabledCapabilities)
              : new Set<string>();
          if (
            backend.kind !== "pi" ||
            !enabledCapabilities.has("workspace_tools") ||
            !enabledCapabilities.has("workspace_context")
          ) {
            context.addIssue({
              code: "custom",
              message: `Pi target "${target.id}" may use SSH only with the complete managed workspace_tools and workspace_context capability bundle.`,
              path: ["targets", index, "executionEnvironmentId"],
            });
          }
        } else if (
          target.kind === "claude_agent_sdk" &&
          backend.kind === "claude_agent_sdk"
        ) {
          // The target itself authorizes Sedes's digest-verified Claude worker.
          // Optional SSH operations remain independently capability-gated.
        } else if (
          target.kind !== "codex_app_server" ||
          backend.kind !== "codex_app_server" ||
          !isExternalUnixWebSocketBackend(backend.moduleConfiguration)
        ) {
          context.addIssue({
            code: "custom",
            message: `Target "${target.id}" may use SSH only with an external Codex Unix-WebSocket backend.`,
            path: ["targets", index, "executionEnvironmentId"],
          });
        }
      }
    }

    const enabledTargets = configuration.targets.filter(
      ({ enabled }) => enabled,
    );
    if (enabledTargets.length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one connection target must be enabled.",
        path: ["targets"],
      });
    }

    for (const backend of configuration.backends) {
      const environmentIds = new Set(
        enabledTargets
          .filter((target) => target.backendInstanceId === backend.id)
          .map((target) => target.executionEnvironmentId),
      );
      if (environmentIds.size > 1) {
        context.addIssue({
          code: "custom",
          message: `Backend "${backend.id}" cannot span execution environments.`,
          path: ["targets"],
        });
      }
    }

    for (const [index, backend] of configuration.backends.entries()) {
      if (
        backend.enabled &&
        !enabledTargets.some(
          (target) => target.backendInstanceId === backend.id,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: `Enabled backend "${backend.id}" has no enabled target.`,
          path: ["backends", index, "enabled"],
        });
      }
    }

    const selected = configuration.targets.find(
      ({ id }) => id === configuration.defaultTargetId,
    );
    if (!selected) {
      context.addIssue({
        code: "custom",
        message: "The default target does not exist.",
        path: ["defaultTargetId"],
      });
    } else if (!selected.enabled) {
      context.addIssue({
        code: "custom",
        message: "The default target must be enabled.",
        path: ["defaultTargetId"],
      });
    }
  });

function isExternalUnixWebSocketBackend(
  value: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (!value) return false;
  const connection = value.connection;
  if (
    typeof connection !== "object" ||
    connection === null ||
    Array.isArray(connection)
  ) {
    return false;
  }
  const channel = (connection as Record<string, unknown>).channel;
  return (
    (connection as Record<string, unknown>).ownership === "external" &&
    typeof channel === "object" &&
    channel !== null &&
    !Array.isArray(channel) &&
    (channel as Record<string, unknown>).type === "unix_websocket"
  );
}

function duplicateIds(
  values: ReadonlyArray<{ readonly id: string }>,
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of values) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

export type BackendConfigurationFile = z.infer<
  typeof backendConfigurationFileSchema
>;

export type PackagedClient = z.infer<typeof packagedClientsSchema>[number];

export type ResolvedBackendConfigurationFile = Omit<
  BackendConfigurationFile,
  "backends"
> & {
  readonly backends: ReadonlyArray<
    BackendConfigurationFile["backends"][number] & {
      /** Compiled backend profile; never supplied by operator configuration. */
      readonly protocolRelease: string;
    }
  >;
};

export type SshOperationsConfiguration = z.infer<
  typeof sshOperationsConfigurationSchema
>;

export type LocalWorkspaceIsolationPolicy = z.infer<
  typeof localWorkspaceIsolationSchema
>;

export function localWorkspaceIsolationPolicy(input: {
  readonly kind: "local";
  readonly workspaceIsolation?: LocalWorkspaceIsolationPolicy;
}): LocalWorkspaceIsolationPolicy {
  return (
    input.workspaceIsolation ?? {
      kind: DEFAULT_LOCAL_WORKSPACE_ISOLATION_POLICY.kind,
      networkProfiles: [
        ...DEFAULT_LOCAL_WORKSPACE_ISOLATION_POLICY.networkProfiles,
      ],
    }
  );
}

export function parseBackendConfiguration(
  value: unknown,
): BackendConfigurationFile {
  return backendConfigurationFileSchema.parse(value);
}

export class BackendConfigurationFileError extends Error {}

export function resolveBackendConfigurationFilename(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configuredFilename = environment.SEDES_CONFIG_FILE?.trim();
  if (configuredFilename) {
    if (!path.isAbsolute(configuredFilename)) {
      throw new BackendConfigurationFileError(
        "SEDES_CONFIG_FILE must be an absolute path.",
      );
    }
    return path.resolve(configuredFilename);
  }

  const configuredXdgHome = environment.XDG_CONFIG_HOME?.trim();
  if (configuredXdgHome && !path.isAbsolute(configuredXdgHome)) {
    throw new BackendConfigurationFileError(
      "XDG_CONFIG_HOME must be an absolute path.",
    );
  }
  const configuredHome = environment.HOME?.trim();
  if (
    !configuredXdgHome &&
    configuredHome &&
    !path.isAbsolute(configuredHome)
  ) {
    throw new BackendConfigurationFileError(
      "HOME must be an absolute path when XDG_CONFIG_HOME is unset.",
    );
  }
  const configHome = configuredXdgHome
    ? path.resolve(configuredXdgHome)
    : path.join(
        configuredHome ? path.resolve(configuredHome) : os.homedir(),
        ".config",
      );
  return path.join(configHome, "sedes", "server.json");
}

export async function loadBackendConfigurationFile(
  filename: string,
): Promise<BackendConfigurationFile> {
  if (!path.isAbsolute(filename)) {
    throw new BackendConfigurationFileError(
      "Server configuration filename must be an absolute path.",
    );
  }
  const canonicalFilename = path.resolve(filename);
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(canonicalFilename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BackendConfigurationFileError(
        `Server configuration file at "${canonicalFilename}" is not valid JSON.`,
        { cause: error },
      );
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BackendConfigurationFileError(
        `Server configuration file not found at "${canonicalFilename}". Create it from a checked-in example or set SEDES_CONFIG_FILE to another absolute path.`,
        { cause: error },
      );
    }
    throw error;
  }
  return parseBackendConfiguration(decoded);
}

export function defaultBackendConfiguration(
  configuration: BackendConfigurationFile | ResolvedBackendConfigurationFile,
) {
  const target = configuration.targets.find(
    ({ id }) => id === configuration.defaultTargetId,
  );
  const backend = configuration.backends.find(
    ({ id }) => id === target?.backendInstanceId,
  );
  if (!backend || !target) {
    throw new Error("The backend configuration was not fully validated.");
  }
  return { backend, target } as const;
}

export { loadBootstrapConfigurationFile, parseBootstrapConfiguration } from "./bootstrap-configuration.js";
export { resolveDatabaseBackendConfiguration } from "./database-backend-configuration.js";
