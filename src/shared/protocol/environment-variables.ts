import { z } from "zod";
import { requireSerializedByteLimit } from "./payload.js";

export const ENVIRONMENT_VARIABLE_MAX_ENTRIES = 64;
export const ENVIRONMENT_VARIABLE_MAX_BYTES = 32 * 1024;
const protectedNames = new Set([
  "HOME", "USER", "LOGNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "PI_CODING_AGENT_DIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "TERM", "COLORTERM",
]);

/** Names which select identity, load code into managed workers, or carry authority. */
export function isProtectedEnvironmentVariableName(name: string): boolean {
  const normalized = name.toUpperCase();
  return protectedNames.has(normalized) || normalized.startsWith("SEDES_") ||
    normalized.startsWith("DYLD_") || normalized.startsWith("BASH_FUNC_");
}

export const environmentVariableNameSchema = z.string().max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine(name => !isProtectedEnvironmentVariableName(name), "This variable is managed by Sedes or provider identity settings.");
const literal = z.string().max(8192).refine(value => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value), "Variable values must be well-formed text without NUL.");
export const environmentVariableBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), value: literal }),
  z.strictObject({ kind: z.literal("secret"), source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("environment"), name: environmentVariableNameSchema }),
    z.strictObject({ kind: z.literal("protected_file"), path: z.string().min(1).max(4096)
      .refine(value => !/[\u0000-\u001f\u007f]/u.test(value) && (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)), "A protected file must use an absolute path on the execution host.") }),
  ]) }),
  z.strictObject({ kind: z.literal("unset") }),
]);
export const environmentVariableOverridesSchema = z.record(environmentVariableNameSchema, environmentVariableBindingSchema)
  .superRefine((entries, context) => {
    if (Object.keys(entries).length > ENVIRONMENT_VARIABLE_MAX_ENTRIES) context.addIssue({ code: "custom", message: "Too many environment variables." });
    const seen = new Set<string>();
    for (const key of Object.keys(entries)) {
      const canonical = key.toUpperCase();
      if (seen.has(canonical)) context.addIssue({ code: "custom", path: [key], message: "Variable names must be unique without regard to case." });
      seen.add(canonical);
    }
    requireSerializedByteLimit(entries, context, ENVIRONMENT_VARIABLE_MAX_BYTES, "Environment variables exceed their byte limit.");
  });
export type EnvironmentVariableBinding = z.infer<typeof environmentVariableBindingSchema>;
export type EnvironmentVariableOverrides = z.infer<typeof environmentVariableOverridesSchema>;

export const configuredEnvironmentVariablesSchema = z.strictObject({
  execution: environmentVariableOverridesSchema,
  startup: environmentVariableOverridesSchema,
});
export type ConfiguredEnvironmentVariables = z.infer<typeof configuredEnvironmentVariablesSchema>;
export const environmentVariablesSnapshotSchema = z.strictObject({
  version: z.literal(1),
  layers: z.strictObject({
    environment: environmentVariableOverridesSchema,
    backend: environmentVariableOverridesSchema,
    agent: environmentVariableOverridesSchema,
    thread: environmentVariableOverridesSchema,
  }),
});
export type EnvironmentVariablesSnapshot = z.infer<typeof environmentVariablesSnapshotSchema>;
export const environmentVariablesRevisionSchema = z.strictObject({
  configurationRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  agentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type EnvironmentVariablesRevision = z.infer<typeof environmentVariablesRevisionSchema>;
export const environmentVariablesPreviewQuerySchema = z.strictObject({
  targetId: z.string().min(1).max(160), agentId: z.string().uuid().optional(),
});
export const environmentVariablesPreviewResultSchema = z.strictObject({
  snapshot: environmentVariablesSnapshotSchema,
  revision: environmentVariablesRevisionSchema,
  startup: z.strictObject({ supported: z.boolean(), reason: z.string().min(1).max(512).optional() }),
});
export type EnvironmentVariablesPreviewQuery = z.infer<typeof environmentVariablesPreviewQuerySchema>;
export type EnvironmentVariablesPreviewResult = z.infer<typeof environmentVariablesPreviewResultSchema>;
export const threadEnvironmentVariablesResultSchema = z.strictObject({
  snapshot: environmentVariablesSnapshotSchema, editable: z.literal(false),
});
export type ThreadEnvironmentVariablesResult = z.infer<typeof threadEnvironmentVariablesResultSchema>;

/** Uppercase equivalence prevents a different meaning when sent to Windows. */
export function mergeEnvironmentVariableOverrides(...layers: readonly EnvironmentVariableOverrides[]): EnvironmentVariableOverrides {
  const entries = new Map<string, readonly [string, EnvironmentVariableBinding]>();
  for (const layer of layers) for (const [name, binding] of Object.entries(layer)) entries.set(name.toUpperCase(), [name, binding]);
  return environmentVariableOverridesSchema.parse(Object.fromEntries(entries.values()));
}
export function effectiveEnvironmentVariables(snapshot: EnvironmentVariablesSnapshot): EnvironmentVariableOverrides {
  return mergeEnvironmentVariableOverrides(snapshot.layers.environment, snapshot.layers.backend, snapshot.layers.agent, snapshot.layers.thread);
}
export function emptyEnvironmentVariablesSnapshot(): EnvironmentVariablesSnapshot {
  return { version: 1, layers: { environment: {}, backend: {}, agent: {}, thread: {} } };
}
