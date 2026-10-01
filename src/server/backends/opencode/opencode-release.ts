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

export async function admitOpenCodeExecutable(executablePath: string | undefined, environment: Readonly<NodeJS.ProcessEnv>, workingDirectory = process.cwd()): Promise<string> {
  if (executablePath !== undefined && !path.isAbsolute(executablePath)) throw new OpenCodeRuntimeError("opencode_executable_absolute_path_required");
  const candidates = executablePath === undefined
    ? (environment.PATH ?? "/usr/bin:/bin").split(path.delimiter).map(directory => path.resolve(workingDirectory, directory, "opencode2"))
    : [executablePath];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const metadata = await stat(canonical);
      if (!metadata.isFile()) continue;
      await access(canonical, constants.X_OK);
      return canonical;
    } catch { /* Unusable PATH entries do not shadow later executables. */ }
  }
  throw new OpenCodeRuntimeError("opencode_executable_unavailable");
}

/** Preserve native provider credentials and files; remove process-mode overrides. */
export function openCodeOwnedEnvironment(input: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly nativeStorePath?: string;
  readonly configDirectory?: string;
  readonly password: string;
  readonly marker: string;
}): NodeJS.ProcessEnv {
  if ((input.nativeStorePath !== undefined && !path.isAbsolute(input.nativeStorePath)) ||
      (input.configDirectory !== undefined && !path.isAbsolute(input.configDirectory)) ||
      !input.environment.HOME || !path.isAbsolute(input.environment.HOME) || !input.password || !input.marker) {
    throw new OpenCodeRuntimeError("opencode_launch_environment_invalid");
  }
  const environment = { ...input.environment };
  // Native provider authority belongs to this installation. Ambient Sedes
  // capabilities and other backend credentials do not belong to its tools.
  for (const name of Object.keys(environment)) {
    if (name.startsWith("SEDES_")) delete environment[name];
  }
  for (const name of ["OPENCODE_SIMULATE", ...incompatibleProfileInputs,
    "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_PTY_HANDOFF"]) delete environment[name];
  if (input.nativeStorePath !== undefined) environment.OPENCODE_DB = input.nativeStorePath;
  if (input.configDirectory !== undefined) environment.OPENCODE_CONFIG_DIR = input.configDirectory;
  environment.OPENCODE_DISABLE_AUTOUPDATE = "1";
  environment.OPENCODE_PASSWORD = input.password;
  environment[OPENCODE_PROCESS_MARKER] = input.marker;
  return environment;
}

/** The version probe is bounded and never retains stderr or a child-process error object. */
export async function probeOpenCodeRelease(executablePath: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new OpenCodeRuntimeError("opencode_request_aborted");
  const version = await new Promise<string>((resolve, reject) => {
    const child = spawn(executablePath, ["--version"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let failed = false;
    child.stderr.resume();
    const finishFailure = (code: string) => {
      failed = true; child.kill("SIGKILL"); clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      // The owning launcher drains its marked process cleanup before releasing
      // its lease, including descendants retaining these stdio descriptors.
      reject(new OpenCodeRuntimeError(code));
    };
    const aborted = () => finishFailure("opencode_request_aborted");
    const timer = setTimeout(() => finishFailure("opencode_version_probe_failed"), 10_000);
    signal?.addEventListener("abort", aborted, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return;
      if (Buffer.byteLength(output) + chunk.length > 128) { finishFailure("opencode_version_probe_failed"); return; }
      output += chunk.toString("utf8");
    });
    child.once("error", () => finishFailure("opencode_version_probe_failed"));
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (failed || code !== 0) reject(new OpenCodeRuntimeError("opencode_version_probe_failed"));
      else resolve(output.trim());
    });
  });
  if (version !== `opencode v${OPENCODE_RELEASE}`) throw new OpenCodeRuntimeError("opencode_release_incompatible");
}
