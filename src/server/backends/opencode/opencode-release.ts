import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export const OPENCODE_RELEASE = "2.0.18" as const;
export const OPENCODE_SOURCE_REVISION = "cd9a14a6b688d4021bee381dfd39d2cef9c0f862" as const;
export const OPENCODE_PROCESS_MARKER = "SEDES_OPENCODE_RUNTIME_OWNER";
const incompatibleProfileInputs = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLIENT", "OPENCODE_MODELS_URL"] as const;

export class OpenCodeRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OpenCodeRuntimeError"; }
}

export function admitOpenCodeRelease(version: unknown): typeof OPENCODE_RELEASE {
  if (version !== OPENCODE_RELEASE) throw new OpenCodeRuntimeError("opencode_release_incompatible");
  return OPENCODE_RELEASE;
}

/** The same native process profile is required for owned and external admission. */
export function admitOpenCodeNativeProfile(environmentEntries: readonly string[]): void {
  for (const entry of environmentEntries) {
    const equals = entry.indexOf("=");
    if (equals < 0) continue;
    const name = entry.slice(0, equals);
    const value = entry.slice(equals + 1);
    if (name === "OPENCODE_SIMULATE" && ["1", "true"].includes(value.toLowerCase())) {
      throw new OpenCodeRuntimeError("opencode_simulation_profile_rejected");
    }
    if (value && incompatibleProfileInputs.some(input => input === name)) throw new OpenCodeRuntimeError("opencode_native_profile_incompatible");
  }
}

export async function admitOpenCodeExecutable(executablePath: string): Promise<string> {
  if (!path.isAbsolute(executablePath)) throw new OpenCodeRuntimeError("opencode_executable_absolute_path_required");
  try {
    const canonical = await realpath(executablePath);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw new Error();
    await access(canonical, constants.X_OK);
    return canonical;
  } catch { throw new OpenCodeRuntimeError("opencode_executable_unavailable"); }
}

/** Preserve native provider credentials and files; remove process-mode overrides. */
export function openCodeOwnedEnvironment(input: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly nativeStorePath: string;
  readonly configDirectory: string;
  readonly password: string;
  readonly marker: string;
}): NodeJS.ProcessEnv {
  if (!path.isAbsolute(input.nativeStorePath) || !path.isAbsolute(input.configDirectory) ||
      !input.environment.HOME || !path.isAbsolute(input.environment.HOME) || !input.password || !input.marker) {
    throw new OpenCodeRuntimeError("opencode_launch_environment_invalid");
  }
  if (input.environment.OPENCODE_DB !== undefined && input.environment.OPENCODE_DB !== input.nativeStorePath) {
    throw new OpenCodeRuntimeError("opencode_native_store_override_conflict");
  }
  const environment = { ...input.environment };
  // Native provider authority belongs to this installation. Ambient Sedes
  // capabilities and other backend credentials do not belong to its tools.
  for (const name of Object.keys(environment)) {
    if (name.startsWith("SEDES_AGENT_TOOL_") || /^SEDES_OPENCODE_.*PASSWORD.*$/u.test(name) ||
        /^SEDES_CODEX_.*TOKEN.*$/u.test(name)) delete environment[name];
  }
  for (const name of ["OPENCODE_SIMULATE", ...incompatibleProfileInputs,
    "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_PTY_HANDOFF"]) delete environment[name];
  environment.OPENCODE_DB = input.nativeStorePath;
  environment.OPENCODE_CONFIG_DIR = input.configDirectory;
  environment.OPENCODE_DISABLE_AUTOUPDATE = "1";
  environment.OPENCODE_PASSWORD = input.password;
  environment[OPENCODE_PROCESS_MARKER] = input.marker;
  return environment;
}

/** The version probe is bounded and never retains stderr or a child-process error object. */
export async function probeOpenCodeRelease(executablePath: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const version = await new Promise<string>((resolve, reject) => {
    const child = spawn(executablePath, ["--version"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let failed = false;
    child.stderr.resume();
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 128) { failed = true; child.kill("SIGKILL"); return; }
      output += chunk.toString("utf8");
    });
    child.once("error", () => { clearTimeout(timer); reject(new OpenCodeRuntimeError("opencode_version_probe_failed")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new OpenCodeRuntimeError("opencode_version_probe_failed"));
      else resolve(output.trim());
    });
  });
  if (version !== `opencode v${OPENCODE_RELEASE}`) throw new OpenCodeRuntimeError("opencode_release_incompatible");
}
