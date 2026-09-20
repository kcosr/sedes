import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BackendConfigurationFileError } from "./backend-configuration.js";

const absolutePath = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value), "An absolute path is required.");
/** Installation-owned settings needed before principal configuration is loaded. */
export const bootstrapConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(11),
  stateDirectory: absolutePath.optional(),
  listen: z.strictObject({
    host: z.enum(["127.0.0.1", "0.0.0.0"]).optional(),
    port: z.number().int().refine(value => value === 0 || value >= 1024 && value <= 65535).optional(),
    trustedLanHost: z.string().max(15).optional(),
  }).optional(),
  packagedClients: z.array(z.enum(["android", "electron"])).max(2).refine(value => new Set(value).size === value.length).default([]),
  allowedTailscaleHosts: z.array(z.string().min(1).max(253)).max(16).optional(),
});
export type BootstrapConfiguration = z.infer<typeof bootstrapConfigurationSchema>;

export function parseBootstrapConfiguration(value: unknown): BootstrapConfiguration {
  if (typeof value === "object" && value !== null && !Array.isArray(value) &&
    ("executionEnvironments" in value || "backends" in value || "targets" in value || "defaultTargetId" in value || "webSearch" in value || ("schemaVersion" in value && value.schemaVersion === 10))) {
    throw new BackendConfigurationFileError("Execution configuration is database-owned. Stop Sedes, run npm run configuration:import -- --file /absolute/legacy-server.json --workspace-roots /absolute/root, then replace the bootstrap file with config/server.example.json (schemaVersion 11). Import never overwrites database edits.");
  }
  const parsed = bootstrapConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join(".") || "<root>"} (${issue.code})`).join(", ");
    throw new BackendConfigurationFileError(`Server bootstrap configuration is invalid at ${issues}.`);
  }
  return parsed.data;
}

export async function loadBootstrapConfigurationFile(filename: string): Promise<BootstrapConfiguration> {
  if (!path.isAbsolute(filename)) throw new BackendConfigurationFileError("Server configuration filename must be an absolute path.");
  try {
    return parseBootstrapConfiguration(JSON.parse(await readFile(filename, "utf8")));
  } catch (error) {
    if (error instanceof BackendConfigurationFileError) throw new BackendConfigurationFileError(`Server configuration file at "${filename}": ${error.message}`, { cause: error });
    if (error instanceof SyntaxError) throw new BackendConfigurationFileError(`Server configuration file at "${filename}" is not valid JSON.`, { cause: error });
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BackendConfigurationFileError(`Server configuration file not found at "${filename}". Create it from config/server.example.json or set SEDES_CONFIG_FILE to another absolute path.`, { cause: error });
    throw error;
  }
}
