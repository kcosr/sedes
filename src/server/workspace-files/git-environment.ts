import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const gitVariable = process.platform === "win32"
      ? key.toUpperCase().startsWith("GIT_")
      : key.startsWith("GIT_");
    if (!gitVariable && value !== undefined)
      environment[key] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    LC_ALL: "C",
  };
}

export async function checkoutGitEnvironment(
  checkout: string,
  signal?: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  const environment = gitEnvironment();
  if (process.platform !== "win32") return environment;
  // Git for Windows commonly configures CRLF conversion at system scope.
  // Inspect only inert checkout settings, then carry their effective values
  // into the otherwise system-config-free command. A config read does not
  // execute hooks, filters, or filesystem monitors.
  const inspectionEnvironment = { ...environment };
  delete inspectionEnvironment.GIT_CONFIG_NOSYSTEM;
  let output: string;
  try {
    ({ stdout: output } = await executeFile(
      "git",
      [
        "-C", checkout, "config", "--type=bool-or-str", "--null",
        "--get-regexp", "^core\\.(autocrlf|eol|symlinks)$",
      ],
      {
        encoding: "utf8",
        env: inspectionEnvironment,
        maxBuffer: 16 * 1_024,
        windowsHide: true,
        timeout: 10_000,
        killSignal: "SIGKILL",
        ...(signal ? { signal } : {}),
      },
    ));
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    // git config exits 1 when none of these optional settings are defined.
    if ((error as { readonly code?: unknown }).code === 1) return environment;
    throw error;
  }
  const allowedValues: Readonly<Record<string, readonly string[]>> = {
    "core.autocrlf": ["true", "false", "input"],
    "core.eol": ["native", "lf", "crlf"],
    "core.symlinks": ["true", "false"],
  };
  const settings = new Map<string, string>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\n");
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1).toLowerCase();
    if (separator < 0 || !allowedValues[key]?.includes(value))
      throw new Error("workspace_file_git_checkout_configuration_invalid");
    settings.set(key, value);
  }
  environment.GIT_CONFIG_COUNT = String(settings.size);
  let index = 0;
  for (const [key, value] of settings) {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
    index += 1;
  }
  return environment;
}
