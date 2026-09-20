import { configuredEnvironmentVariablesSchema } from "./environment-variables.js";
import { z } from "zod";
import { normalizedAbsolutePath } from "../absolute-path.js";
import { requireSerializedByteLimit } from "./payload.js";

/**
 * Dedicated, registered administration contract. Provider connection settings
 * belong here, never on normalized conversation/runtime browser contracts.
 * These are references to protected credentials, never credential values.
 * Provider modules additionally validate their own policy and native settings.
 */
export const configurationIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
export const configurationRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const label = z.string().min(1).max(120).refine(value => !/\p{Cc}/u.test(value));
const absolutePath = z.string().min(1).max(4096).refine(value =>
  !/[\u0000-\u001f\u007f]/u.test(value) &&
  (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)),
"An absolute execution-environment path is required.");
const remotePath = absolutePath.refine(value => value.startsWith("/") && !value.includes("\\"));
export const configurationOutboundWorkspaceRootsSchema = z.array(
  z.string().min(1).max(4096).refine(normalizedAbsolutePath, "A canonical absolute path on the execution host is required."),
).min(1).max(16).refine(values => new Set(values).size === values.length);
export const configurationWorkspaceRootsSchema = z.array(absolutePath).min(1).max(16).refine(values => new Set(values).size === values.length);
const opaqueId = z.string().min(1).max(240).refine(value => !/\p{Cc}/u.test(value));
const identifiers = z.array(opaqueId).min(1).max(64).refine(values => new Set(values).size === values.length);
const matcher = z.strictObject({ providerIds: identifiers.optional(), modelIds: identifiers.optional(), reasoningEfforts: identifiers.optional() })
  .refine(value => Object.keys(value).length > 0, "A matcher must select at least one dimension.");
export const configurationModelPolicySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("catalog") }),
  z.strictObject({ type: z.literal("allowlist"), allowed: z.array(matcher).min(1).max(64) }),
  z.strictObject({ type: z.literal("denylist"), denied: z.array(matcher).min(1).max(64) }),
]);
export const configurationSidecarCapabilities = ["directory_browser", "workspace_files", "workspace_tools", "workspace_context", "workspace_skills", "composer_attachments", "agent_tools_cli", "interactive_terminal"] as const;
const sidecarCapabilities = z.array(z.enum(configurationSidecarCapabilities)).min(1).max(8)
  .refine(values => new Set(values).size === values.length, "Capabilities must be unique.")
  .refine(values => values.includes("workspace_tools") === values.includes("workspace_context"), "Workspace tools and context are enabled together.");
export const configurationRemoteOperationsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("sidecar"), enabledCapabilities: sidecarCapabilities }),
]);
export const configurationHostPlatformSchema = z.enum(["linux", "darwin", "win32"]);
export const configurationEnvironmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: z.string().uuid(), kind: z.literal("local"), label, environmentVariables: configuredEnvironmentVariablesSchema.optional(), workspaceRoots: configurationWorkspaceRootsSchema,
    workspaceIsolation: z.strictObject({ kind: z.literal("bubblewrap"), networkProfiles: z.union([
      z.tuple([z.literal("isolated")]), z.tuple([z.literal("isolated"), z.literal("execution_host")]),
    ]) }),
  }),
  z.strictObject({
    id: z.string().uuid(), kind: z.literal("ssh"), label, environmentVariables: configuredEnvironmentVariablesSchema.optional(),
    hostAlias: z.string().min(1).max(255).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
    workspaceRoots: z.array(remotePath).min(1).max(16).refine(values => new Set(values).size === values.length),
    operations: configurationRemoteOperationsSchema,
  }),
  z.strictObject({
    id: z.string().uuid(), kind: z.literal("outbound"), label, environmentVariables: configuredEnvironmentVariablesSchema.optional(),
    pairingId: z.string().uuid(), platform: configurationHostPlatformSchema,
    workspaceRoots: configurationOutboundWorkspaceRootsSchema,
    operations: configurationRemoteOperationsSchema,
  }),
]);
const sandbox = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const network = z.enum(["disabled", "enabled"]);
const approval = z.enum(["untrusted", "on-request", "never"]);
const reviewer = z.enum(["user", "auto_review"]);
const permission = z.enum(["default", "acceptEdits", "dontAsk", "auto", "bypassPermissions"]);
const catalogModel = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("catalogDefault") }),
  z.strictObject({ type: z.literal("fixed"), modelId: opaqueId }),
]);
export const configurationSecretReferenceSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("environment"), variable: z.string().max(128).regex(/^SEDES_CODEX_[A-Z0-9_]*TOKEN[A-Z0-9_]*$/) }),
  z.strictObject({ source: z.literal("protected_file"), path: absolutePath }),
]);
const codexModule = z.strictObject({
  tuiExecutablePath: absolutePath.optional(),
  connection: z.discriminatedUnion("ownership", [
    z.strictObject({ ownership: z.literal("owned"), channel: z.strictObject({
      type: z.literal("process_stdio"), executablePath: absolutePath.optional(), workingDirectory: absolutePath, codexHome: absolutePath.optional(),
    }) }),
    z.strictObject({ ownership: z.literal("external"), channel: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("unix_websocket"), socketPath: absolutePath }),
      z.strictObject({ type: z.literal("tcp_websocket"), url: z.string().min(1).max(2048), authentication: z.strictObject({ type: z.literal("capability_token"), secret: configurationSecretReferenceSchema }) }),
    ]) }),
  ]),
  policy: z.strictObject({ allowedSandboxModes: z.array(sandbox).min(1).max(3), allowedNetworkAccess: z.array(network).min(1).max(2), allowedApprovalPolicies: z.array(approval).min(1).max(3), allowedApprovalReviewers: z.array(reviewer).min(1).max(2) }),
});
const backendFields = { environmentVariables: configuredEnvironmentVariablesSchema.optional(), id: configurationIdSchema, label, enabled: z.boolean(), modelPolicy: configurationModelPolicySchema };
export const configurationBackendSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...backendFields, kind: z.literal("pi") }),
  z.strictObject({ ...backendFields, kind: z.literal("codex_app_server"), moduleConfiguration: codexModule }),
  z.strictObject({ ...backendFields, kind: z.literal("claude_agent_sdk"), moduleConfiguration: z.strictObject({
    executablePath: absolutePath.optional(), configDirectory: absolutePath.optional(), initializationTimeoutMs: z.number().int().min(1000).max(120000),
    permissionPolicy: z.strictObject({ allowedModes: z.array(permission).min(1).max(5) }),
  }) }),
  z.strictObject({ ...backendFields, kind: z.literal("grok_build"), moduleConfiguration: z.strictObject({
    connection: z.strictObject({ ownership: z.literal("owned"), channel: z.strictObject({ type: z.literal("process_stdio"), executablePath: absolutePath.optional(), workingDirectoryPolicy: z.literal("workspace") }) }),
    authentication: z.strictObject({ type: z.literal("native") }),
    security: z.strictObject({ profile: z.literal("unrestricted_v1"), sandboxProfile: z.literal("off"), networkAccess: z.literal("enabled"), approvalMode: z.literal("full_access") }),
  }) }),
]);
const targetFields = { id: configurationIdSchema, label, backendInstanceId: configurationIdSchema, executionEnvironmentId: z.string().uuid(), enabled: z.boolean() };
export const configurationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...targetFields, kind: z.literal("pi_sdk") }),
  z.strictObject({ ...targetFields, kind: z.literal("codex_app_server"), moduleConfiguration: z.strictObject({ defaults: z.strictObject({ sandboxMode: sandbox, networkAccess: network, approvalPolicy: approval, approvalReviewer: reviewer, model: catalogModel }) }) }),
  z.strictObject({ ...targetFields, kind: z.literal("claude_agent_sdk"), moduleConfiguration: z.strictObject({ defaults: z.strictObject({ permissionMode: z.enum(["default", "acceptEdits", "dontAsk", "auto"]) }) }) }),
  z.strictObject({ ...targetFields, kind: z.literal("grok_acp"), moduleConfiguration: z.strictObject({ defaults: z.strictObject({ model: catalogModel, reasoningEffort: z.discriminatedUnion("type", [ z.strictObject({ type: z.literal("modelDefault") }), z.strictObject({ type: z.literal("fixed"), effortId: opaqueId }) ]) }) }) }),
]);
export const configurationDocumentSchema = z.strictObject({
  executionEnvironments: z.array(configurationEnvironmentSchema).max(16),
  backends: z.array(configurationBackendSchema).max(32),
  targets: z.array(configurationTargetSchema).max(64),
  defaultTargetId: configurationIdSchema.nullable(),
  webSearch: z.strictObject({ provider: z.literal("grok_cli"), grokHome: absolutePath.optional() }).nullable(),
}).superRefine((document, context) => {
  requireSerializedByteLimit(document, context, 512 * 1024, "Configuration exceeds its byte limit.");
  for (const field of ["executionEnvironments", "backends", "targets"] as const) {
    if (new Set(document[field].map(item => item.id)).size !== document[field].length) context.addIssue({ code: "custom", path: [field], message: "Definition IDs must be unique." });
  }
  if (document.executionEnvironments.filter(item => item.kind === "local").length > 1) context.addIssue({ code: "custom", path: ["executionEnvironments"], message: "Only one local environment is supported." });
  const backends = new Map(document.backends.map(item => [item.id, item]));
  const environments = new Map(document.executionEnvironments.map(item => [item.id, item]));
  const targetBackendKinds = { pi_sdk: "pi", codex_app_server: "codex_app_server", claude_agent_sdk: "claude_agent_sdk", grok_acp: "grok_build" } as const;
  for (const [index, target] of document.targets.entries()) {
    const backend = backends.get(target.backendInstanceId);
    const environment = environments.get(target.executionEnvironmentId);
    if (!backend || backend.kind !== targetBackendKinds[target.kind] || !environment) context.addIssue({ code: "custom", path: ["targets", index], message: "Target must reference a compatible backend and an existing environment." });
    if (target.enabled && !backend?.enabled) context.addIssue({ code: "custom", path: ["targets", index, "enabled"], message: "Enable the backend before enabling this target." });
    if (environment !== undefined && environment.kind !== "local" && target.kind === "grok_acp") context.addIssue({ code: "custom", path: ["targets", index], message: "Grok requires a local environment." });
    if (environment?.kind === "outbound" && environment.platform === "win32" && target.kind === "claude_agent_sdk" && (target.enabled || backend?.enabled)) context.addIssue({ code: "custom", path: ["targets", index], message: "Claude requires a macOS or Linux execution host." });
    if (environment !== undefined && environment.kind !== "local" && target.enabled && target.kind === "pi_sdk" &&
      (environment.operations.kind !== "sidecar" || !environment.operations.enabledCapabilities.includes("workspace_tools"))) context.addIssue({ code: "custom", path: ["targets", index], message: "Remote Pi requires workspace tools and context capabilities." });
  }
  for (const backend of document.backends) {
    if (!document.targets.some(target => target.backendInstanceId === backend.id)) context.addIssue({ code: "custom", path: ["targets"], message: "A configured backend requires a target that fixes its execution environment." });
    if (new Set(document.targets.filter(target => target.backendInstanceId === backend.id).map(target => target.executionEnvironmentId)).size > 1) context.addIssue({ code: "custom", path: ["targets"], message: "A configured backend belongs to one execution environment." });
  }
  const selected = document.targets.find(target => target.id === document.defaultTargetId);
  if (document.defaultTargetId !== null && (!selected?.enabled || !backends.get(selected.backendInstanceId)?.enabled)) context.addIssue({ code: "custom", path: ["defaultTargetId"], message: "The default target must exist and be enabled." });
});

export const configurationResourceKindSchema = z.enum(["environment", "backend"]);
export const configurationLifecycleActionSchema = z.enum(["connect", "disconnect", "start", "stop", "restart", "upgrade"]);
export const configurationRuntimeStateSchema = z.strictObject({
  resourceKind: configurationResourceKindSchema, resourceId: configurationIdSchema,
  desiredRevision: configurationRevisionSchema, effectiveRevision: configurationRevisionSchema.nullable(),
  applyState: z.enum(["pending", "applied", "rejected", "unavailable"]),
  startupEnvironmentPending: z.boolean().optional(),
  preference: z.enum(["automatic", "disconnected", "stopped"]),
  connectionState: z.enum(["unknown", "connected", "disconnected", "unreachable", "recovery_required", "stopped", "reconciling"]),
  incarnation: z.string().min(1).max(256).nullable(),
  softwareVersion: z.string().min(1).max(128).nullable(),
  upgradeState: z.enum(["unknown", "current", "pending", "required"]),
  activeResources: z.number().int().nonnegative(),
  supportedActions: z.array(configurationLifecycleActionSchema).max(6),
  lastError: z.string().min(1).max(1024).nullable(),
  /** Present while this resource has a durable command awaiting a confirmed outcome. */
  lifecycleOperation: z.strictObject({
    mutationId: z.string().uuid(), action: configurationLifecycleActionSchema,
    state: z.enum(["pending", "unknown"]),
  }).optional(),
});
export const configurationSnapshotSchema = z.strictObject({ revision: configurationRevisionSchema, configuration: configurationDocumentSchema, runtimes: z.array(configurationRuntimeStateSchema).max(128) });
export const saveConfigurationRequestSchema = z.strictObject({ mutationId: z.string().uuid(), expectedRevision: configurationRevisionSchema, configuration: configurationDocumentSchema });
export const configurationLifecycleImpactRequestSchema = z.strictObject({ resourceKind: configurationResourceKindSchema, resourceId: configurationIdSchema, action: configurationLifecycleActionSchema, expectedRevision: configurationRevisionSchema });
export const configurationLifecycleImpactSchema = z.strictObject({
  token: z.string().min(1).max(512), resourceKind: configurationResourceKindSchema, resourceId: configurationIdSchema, action: configurationLifecycleActionSchema,
  configurationRevision: configurationRevisionSchema, incarnation: z.string().min(1).max(256).nullable(),
  activeResources: z.number().int().nonnegative(), interruptions: z.array(z.string().min(1).max(512)).max(128),
  expiresAt: z.string().datetime(),
});
export const configurationLifecycleRequestSchema = z.strictObject({
  mutationId: z.string().uuid(), expectedRevision: configurationRevisionSchema,
  resourceKind: configurationResourceKindSchema, resourceId: configurationIdSchema, action: configurationLifecycleActionSchema,
  expectedIncarnation: z.string().min(1).max(256).nullable(), impactToken: z.string().min(1).max(512).nullable(),
});
export const configurationLifecycleResultSchema = z.strictObject({
  mutationId: z.string().uuid(), state: z.enum(["pending", "applied", "rejected", "unavailable", "unknown"]),
  runtime: configurationRuntimeStateSchema,
});
export type ConfigurationDocument = z.infer<typeof configurationDocumentSchema>;
export type ConfigurationEnvironment = z.infer<typeof configurationEnvironmentSchema>;
export type ConfigurationBackend = z.infer<typeof configurationBackendSchema>;
export type ConfigurationTarget = z.infer<typeof configurationTargetSchema>;
export type ConfigurationSnapshot = z.infer<typeof configurationSnapshotSchema>;
export type ConfigurationRuntimeState = z.infer<typeof configurationRuntimeStateSchema>;
export type SaveConfigurationRequest = z.infer<typeof saveConfigurationRequestSchema>;
export type ConfigurationLifecycleRequest = z.infer<typeof configurationLifecycleRequestSchema>;
export type ConfigurationLifecycleImpactRequest = z.infer<typeof configurationLifecycleImpactRequestSchema>;
export type ConfigurationLifecycleImpact = z.infer<typeof configurationLifecycleImpactSchema>;
export type ConfigurationLifecycleResult = z.infer<typeof configurationLifecycleResultSchema>;
