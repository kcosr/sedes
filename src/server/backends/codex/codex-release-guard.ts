import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { CODEX_APP_SERVER_RELEASE } from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

export { CODEX_APP_SERVER_RELEASE };

const VERSION_PROBE_TIMEOUT_MILLISECONDS = 5_000;
const VERSION_PROBE_CLEANUP_TIMEOUT_MILLISECONDS = 1_000;
const VERSION_PROBE_MAXIMUM_OUTPUT_BYTES = 4_096;
const VERSION_LINE_PATTERN = /^codex-cli ([^\s]+)$/u;
const SEMANTIC_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const STABLE_SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const CODEX_RUNTIME_MINIMUM_SUPPORTED_RELEASE = "0.153.0";
export const CODEX_RUNTIME_TESTED_THROUGH_RELEASE = "0.154.0";

// Add exact stable releases here when a provider regression makes an otherwise
// compatible runtime unsafe. Build metadata does not distinguish exclusions.
const CODEX_RUNTIME_EXCLUDED_RELEASES: readonly string[] = Object.freeze([]);

export interface VerifiedCodexRuntimeVersion {
  readonly version: string;
  readonly newerThanTested: boolean;
}

export interface VerifiedCodexRuntime extends VerifiedCodexRuntimeVersion {
  readonly path: string;
}

/**
 * Resolve the configured Codex executable and prove it reports a compatible
 * stable `codex-cli` version. Every admitted runtime still uses the one exact
 * generated protocol profile exported as `CODEX_APP_SERVER_RELEASE`.
 */
export async function verifyCodexRuntimeExecutable(
  configuredPath: string,
  options?: {
    readonly probeTimeoutMilliseconds?: number;
  },
): Promise<VerifiedCodexRuntime> {
  assertCodexRuntimePlatformSupported(process.platform, process.arch);
  const canonicalPath = await realpath(configuredPath);
  await access(canonicalPath, 1);
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) {
    throw new Error("codex_executable_not_regular_file");
  }
  const version = await probeCodexCliVersion(
    canonicalPath,
    options?.probeTimeoutMilliseconds ?? VERSION_PROBE_TIMEOUT_MILLISECONDS,
  );
  const verified = verifyCodexRuntimeVersion(version);
  return Object.freeze({
    path: canonicalPath,
    ...verified,
  });
}

export function assertCodexRuntimePlatformSupported(
  platform: NodeJS.Platform,
  architecture: string,
): void {
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error("codex_executable_platform_mismatch");
  }
  if (
    (platform === "linux" && architecture !== "x64") ||
    (platform === "darwin" &&
      architecture !== "arm64" &&
      architecture !== "x64") ||
    (platform === "win32" && architecture !== "arm64" && architecture !== "x64")
  ) {
    throw new Error("codex_executable_architecture_mismatch");
  }
}

export function verifyCodexRuntimeVersion(
  version: string,
): VerifiedCodexRuntimeVersion {
  if (!SEMANTIC_VERSION_PATTERN.test(version)) {
    throw new Error("codex_executable_version_invalid");
  }
  const parsed = parseStableCodexRuntimeVersion(version);
  if (
    !parsed ||
    compareVersions(
      parsed,
      parseRequiredStableVersion(CODEX_RUNTIME_MINIMUM_SUPPORTED_RELEASE),
    ) < 0 ||
    isCodexRuntimeReleaseExcluded(
      parsed.precedenceRelease,
      CODEX_RUNTIME_EXCLUDED_RELEASES,
    )
  ) {
    throw new Error("codex_executable_version_unsupported");
  }
  return Object.freeze({
    version,
    newerThanTested:
      compareVersions(
        parsed,
        parseRequiredStableVersion(CODEX_RUNTIME_TESTED_THROUGH_RELEASE),
      ) > 0,
  });
}

export function haveSameCodexRuntimeVersionPrecedence(
  left: string,
  right: string,
): boolean {
  const parsedLeft = parseStableCodexRuntimeVersion(left);
  const parsedRight = parseStableCodexRuntimeVersion(right);
  return (
    parsedLeft !== undefined &&
    parsedRight !== undefined &&
    compareVersions(parsedLeft, parsedRight) === 0
  );
}

export function isCodexRuntimeReleaseExcluded(
  release: string,
  excludedReleases: readonly string[],
): boolean {
  const parsed = parseStableCodexRuntimeVersion(release);
  return (
    parsed !== undefined && excludedReleases.includes(parsed.precedenceRelease)
  );
}

interface StableVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly precedenceRelease: string;
}

function parseStableCodexRuntimeVersion(
  version: string,
): StableVersion | undefined {
  const match = STABLE_SEMANTIC_VERSION_PATTERN.exec(version);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return Object.freeze({
    major,
    minor,
    patch,
    precedenceRelease: `${String(major)}.${String(minor)}.${String(patch)}`,
  });
}

function parseRequiredStableVersion(version: string): StableVersion {
  const parsed = parseStableCodexRuntimeVersion(version);
  if (!parsed) throw new Error("codex_runtime_version_policy_invalid");
  return parsed;
}

function compareVersions(left: StableVersion, right: StableVersion): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

export function decodeCodexRuntimeVersionProbe(
  stdout: Uint8Array,
  stderr: Uint8Array,
): string {
  if (
    stdout.byteLength > VERSION_PROBE_MAXIMUM_OUTPUT_BYTES ||
    stderr.byteLength > 0
  ) {
    throw new Error(
      stderr.byteLength > 0
        ? "codex_executable_version_probe_unexpected_stderr"
        : "codex_executable_version_probe_output_too_large",
    );
  }
  const text = Buffer.from(stdout).toString("utf8");
  if (text.includes("\0")) {
    throw new Error("codex_executable_version_malformed");
  }
  const trimmed = text.replace(/\r?\n$/u, "");
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("codex_executable_version_malformed");
  }
  const match = VERSION_LINE_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error("codex_executable_version_malformed");
  }
  return match[1]!;
}

async function probeCodexCliVersion(
  executablePath: string,
  timeoutMilliseconds: number,
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("codex_executable_version_probe_timeout_invalid");
  }
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let failureCode: string | undefined;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = spawn(executablePath, ["--version"], {
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const settleFailure = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      reject(new Error(code));
    };

    const killProbeProcessGroup = () => {
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
          return;
        } catch {
          // The group can disappear between observation and signaling. The
          // direct-child fallback also covers spawn failures without a PID.
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Cleanup completion is decided by `close` or the bounded fallback.
      }
    };

    const failAfterCleanup = (code: string) => {
      if (settled || failureCode) return;
      failureCode = code;
      clearTimeout(timer);
      killProbeProcessGroup();
      cleanupTimer = setTimeout(() => {
        killProbeProcessGroup();
        child.stdout?.destroy();
        child.stderr?.destroy();
        settleFailure(code);
      }, VERSION_PROBE_CLEANUP_TIMEOUT_MILLISECONDS);
    };

    const timer = setTimeout(() => {
      failAfterCleanup("codex_executable_version_probe_timeout");
    }, timeoutMilliseconds);
    let cleanupTimer: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (failureCode) return;
      if (
        stdout.byteLength + chunk.byteLength >
        VERSION_PROBE_MAXIMUM_OUTPUT_BYTES
      ) {
        failAfterCleanup("codex_executable_version_probe_output_too_large");
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (failureCode) return;
      if (
        stderr.byteLength + chunk.byteLength >
        VERSION_PROBE_MAXIMUM_OUTPUT_BYTES
      ) {
        failAfterCleanup("codex_executable_version_probe_output_too_large");
        return;
      }
      stderr = Buffer.concat([stderr, chunk]);
    });
    child.once("error", () => {
      failAfterCleanup("codex_executable_version_probe_failed");
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      if (failureCode) {
        settleFailure(failureCode);
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      if (exitCode !== 0) {
        reject(new Error("codex_executable_version_probe_nonzero_exit"));
        return;
      }
      if (stderr.byteLength > 0) {
        reject(new Error("codex_executable_version_probe_unexpected_stderr"));
        return;
      }
      const text = stdout.toString("utf8");
      if (text.includes("\0")) {
        reject(new Error("codex_executable_version_malformed"));
        return;
      }
      const trimmed = text.replace(/\r?\n$/u, "");
      if (trimmed.includes("\n") || trimmed.includes("\r")) {
        reject(new Error("codex_executable_version_malformed"));
        return;
      }
      const match = VERSION_LINE_PATTERN.exec(trimmed);
      if (!match) {
        reject(new Error("codex_executable_version_malformed"));
        return;
      }
      resolve(match[1]!);
    });
  });
}
