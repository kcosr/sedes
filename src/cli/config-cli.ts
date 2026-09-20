import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  BackendConfigurationFileError,
  resolveBackendConfigurationFilename,
} from "../server/config/backend-configuration.js";
import {
  bootstrapConfigurationSchema,
  loadBootstrapConfigurationFile,
} from "../server/config/bootstrap-configuration.js";
import { loadConfig } from "../server/config/config.js";
import type { SedesCliIo } from "./sedes-cli.js";

const usage = `Usage:
  sedes config validate [--file PATH] [--state-directory PATH]

Validates the startup configuration exactly as the server reads it: the
bootstrap file (--file, else SEDES_CONFIG_FILE, else the XDG default
$XDG_CONFIG_HOME/sedes/server.json) together with the startup environment
variables of the invoking shell. Run it as the server's operating-system
account with the same environment as the running Sedes server.

The command never opens the database, starts a provider, binds a port, or
writes anything, so database-owned execution configuration (execution
environments, backends, targets, admitted workspace roots, and executable
paths) is still validated when the server starts.

Exit codes: 0 valid, 1 invalid configuration, 2 usage error.
`;

class ConfigCliUsageError extends Error {}

/** Startup uses the same zod schema; this only renders its issues per line. */
function issueLines(error: z.ZodError): readonly string[] {
  return error.issues.flatMap((issue) => {
    const label = (segments: readonly (string | number | symbol)[]): string =>
      segments.map(String).join(".") || "<root>";
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => `${label([...issue.path, key])}: Unrecognized key.`);
    }
    return [`${label(issue.path)}: ${issue.message}`];
  });
}

async function bootstrapSchemaIssueLines(filename: string): Promise<readonly string[]> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(filename, "utf8"));
  } catch {
    return [];
  }
  const parsed = bootstrapConfigurationSchema.safeParse(decoded);
  return parsed.success ? [] : issueLines(parsed.error);
}

export async function runConfigCli(args: readonly string[], dependencies: {
  environment?: NodeJS.ProcessEnv;
  io?: SedesCliIo;
} = {}): Promise<number> {
  const io = dependencies.io ?? process;
  const environment = dependencies.environment ?? process.env;
  try {
    if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
      io.stdout.write(usage);
      return 0;
    }
    const [command, ...options] = args;
    if (command !== "validate") throw new ConfigCliUsageError("Unknown config command.");
    if (options.length === 1 && ["--help", "-h"].includes(options[0]!)) {
      io.stdout.write(usage);
      return 0;
    }
    let values: { file?: string; "state-directory"?: string };
    try {
      values = parseArgs({
        args: [...options],
        options: { file: { type: "string" }, "state-directory": { type: "string" } },
        strict: true,
        allowPositionals: false,
      }).values;
    } catch (error) {
      throw new ConfigCliUsageError(error instanceof Error ? error.message : "Invalid config options.");
    }
    if (values.file !== undefined && values.file.trim() === "") {
      throw new ConfigCliUsageError("--file requires a path.");
    }
    const stateDirectoryOverride = values["state-directory"];
    try {
      if (stateDirectoryOverride !== undefined && !path.isAbsolute(stateDirectoryOverride)) {
        throw new BackendConfigurationFileError("--state-directory must be an absolute path.");
      }
      const filename = values.file
        ? path.resolve(values.file)
        : resolveBackendConfigurationFilename(environment);
      let bootstrap;
      try {
        bootstrap = await loadBootstrapConfigurationFile(filename);
      } catch (error) {
        if (!(error instanceof BackendConfigurationFileError)) throw error;
        const detailed = error.message.includes("Server bootstrap configuration is invalid at")
          ? await bootstrapSchemaIssueLines(filename)
          : [];
        io.stderr.write(`${(detailed.length > 0 ? detailed : [error.message]).join("\n")}\n`);
        return 1;
      }
      if (
        stateDirectoryOverride !== undefined &&
        bootstrap.stateDirectory !== undefined &&
        path.resolve(bootstrap.stateDirectory) !== path.resolve(stateDirectoryOverride)
      ) {
        io.stderr.write(
          `stateDirectory: the bootstrap file sets "${bootstrap.stateDirectory}", which takes precedence at startup over --state-directory "${stateDirectoryOverride}". Remove the flag or change the file.\n`,
        );
        return 1;
      }
      const config = loadConfig(
        stateDirectoryOverride === undefined
          ? environment
          : { ...environment, APP_STATE_DIR: stateDirectoryOverride },
        bootstrap,
      );
      io.stdout.write(
        `Valid Sedes configuration at "${filename}" (schemaVersion ${bootstrap.schemaVersion}): startup would listen on ${config.host}:${config.port} with state directory "${config.stateDirectory}". Database-owned execution configuration (execution environments, backends, targets, admitted workspace roots, and executable paths) is validated when the server starts; no database was opened.\n`,
      );
      return 0;
    } catch (error) {
      if (error instanceof ConfigCliUsageError) throw error;
      const lines = error instanceof z.ZodError
        ? issueLines(error)
        : [error instanceof Error ? error.message : "Configuration validation failed."];
      io.stderr.write(`${lines.join("\n")}\n`);
      return 1;
    }
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : "Unknown config command."}\n${usage}`);
    return 2;
  }
}
