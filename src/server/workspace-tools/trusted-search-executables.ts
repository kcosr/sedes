import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat as nodeLstat, realpath as nodeRealpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { assertTrustedWindowsSearchPath } from "./trusted-search-windows.js";

export type TrustedSearchExecutableKind = "rg" | "fd";
export type TrustedSearchExecutableSource = "system_path" | "pi_managed";

const VERSION_TIMEOUT_MILLISECONDS = 2_000;
const VERSION_STDOUT_LIMIT = 4_096;
const VERSION_STDERR_LIMIT = 1_024;
const UNSAFE_WRITE_BITS = 0o022;
const EXECUTE_BITS = 0o111;

export class TrustedSearchExecutableError extends Error {
  readonly diagnosticCode: string;

  constructor(diagnosticCode: string) {
    super(diagnosticCode);
    this.name = "TrustedSearchExecutableError";
    this.diagnosticCode = diagnosticCode;
  }
}

export interface TrustedSearchExecutableEvidence {
  readonly kind: TrustedSearchExecutableKind;
  readonly source: TrustedSearchExecutableSource;
  readonly executablePath: string;
  readonly canonicalPath: string;
  readonly version: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedMilliseconds: number;
  readonly mode: number;
}

interface PathEvidence {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedMilliseconds: number;
  readonly mode: number;
}

export interface TrustedSearchFileMetadata {
  readonly uid: number;
  readonly gid?: number;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface TrustedSearchFileSystem {
  readonly lstat: (candidate: string) => Promise<TrustedSearchFileMetadata>;
  readonly realpath: (candidate: string) => Promise<string>;
}

const NODE_FILE_SYSTEM: TrustedSearchFileSystem = {
  lstat: nodeLstat,
  realpath: nodeRealpath,
};

export interface TrustedSearchExecutableDependencies {
  readonly platform?: NodeJS.Platform;
  readonly accountUid?: number;
  readonly inspectWindowsPath?: (candidate: string) => Promise<void>;
  readonly homeDirectory?: string;
  readonly environmentPath?: string;
  readonly fileSystem?: TrustedSearchFileSystem;
  readonly inspectPath?: (
    candidate: string,
    source: TrustedSearchExecutableSource,
  ) => Promise<PathEvidence>;
  readonly readVersion?: (candidate: string) => Promise<string>;
}

export class TrustedSearchExecutableResolver {
  readonly #inspectPath: (
    candidate: string,
    source: TrustedSearchExecutableSource,
  ) => Promise<PathEvidence>;
  readonly #readVersion: (candidate: string) => Promise<string>;
  readonly #homeDirectory: string;
  readonly #environmentPath: string;
  readonly #fileSystem: TrustedSearchFileSystem;
  readonly #platform: NodeJS.Platform;

  constructor(dependencies?: TrustedSearchExecutableDependencies) {
    this.#platform = dependencies?.platform ?? process.platform;
    this.#homeDirectory = dependencies?.homeDirectory ?? homedir();
    this.#environmentPath =
      dependencies?.environmentPath ?? process.env.PATH ?? "";
    this.#fileSystem = dependencies?.fileSystem ?? NODE_FILE_SYSTEM;
    this.#inspectPath =
      dependencies?.inspectPath ??
      ((candidate, source) =>
        this.#platform === "win32"
          ? inspectWindowsPath(
              candidate,
              this.#fileSystem,
              dependencies?.inspectWindowsPath ??
                assertTrustedWindowsSearchPath,
            )
          : source === "system_path"
            ? inspectSystemPath(
                candidate,
                this.#fileSystem,
                this.#platform,
                dependencies?.accountUid ?? process.getuid?.(),
              )
            : inspectPiManagedPath(
                candidate,
                this.#homeDirectory,
                this.#fileSystem,
              ));
    this.#readVersion = dependencies?.readVersion ?? readBoundedVersion;
  }

  async resolve(
    kind: TrustedSearchExecutableKind,
  ): Promise<TrustedSearchExecutableEvidence> {
    const candidates: readonly {
      readonly path: string;
      readonly source: TrustedSearchExecutableSource;
    }[] = systemSearchExecutablePaths(
      kind,
      this.#environmentPath,
      this.#platform,
    ).map((candidate) => ({ path: candidate, source: "system_path" as const }));
    for (const candidate of candidates) {
      const admitted = await this.#admit(kind, candidate).catch(
        () => undefined,
      );
      if (admitted) return admitted;
    }
    try {
      const managed = {
        path: piManagedSearchExecutablePath(
          kind,
          this.#homeDirectory,
          this.#platform,
        ),
        source: "pi_managed" as const,
      };
      const admitted = await this.#admit(kind, managed).catch(() => undefined);
      if (admitted) return admitted;
    } catch {
      // A malformed managed home disables only the fallback source.
    }
    throw new TrustedSearchExecutableError(
      `trusted_search_${kind}_unavailable`,
    );
  }

  async #admit(
    kind: TrustedSearchExecutableKind,
    candidate: {
      readonly path: string;
      readonly source: TrustedSearchExecutableSource;
    },
  ): Promise<TrustedSearchExecutableEvidence> {
    const evidence = await this.#inspectPath(candidate.path, candidate.source);
    const version = parseVersionOutput(
      kind,
      await this.#readVersion(evidence.canonicalPath),
    );
    return {
      kind,
      source: candidate.source,
      executablePath: candidate.path,
      canonicalPath: evidence.canonicalPath,
      version,
      device: evidence.device,
      inode: evidence.inode,
      size: evidence.size,
      modifiedMilliseconds: evidence.modifiedMilliseconds,
      mode: evidence.mode,
    };
  }

  /** Revalidate the exact admission evidence immediately before direct spawn. */
  async revalidate(admitted: TrustedSearchExecutableEvidence): Promise<void> {
    let current: PathEvidence;
    let versionOutput: string;
    try {
      current = await this.#inspectPath(
        admitted.executablePath,
        admitted.source,
      );
      versionOutput = await this.#readVersion(admitted.canonicalPath);
      if (
        parseVersionOutput(admitted.kind, versionOutput) !== admitted.version
      ) {
        throw new Error("trusted_search_version_changed");
      }
    } catch {
      throw new TrustedSearchExecutableError(
        `trusted_search_${admitted.kind}_revalidation_failed`,
      );
    }
    if (
      current.canonicalPath !== admitted.canonicalPath ||
      current.device !== admitted.device ||
      current.inode !== admitted.inode ||
      current.size !== admitted.size ||
      current.modifiedMilliseconds !== admitted.modifiedMilliseconds ||
      current.mode !== admitted.mode
    ) {
      throw new TrustedSearchExecutableError(
        `trusted_search_${admitted.kind}_revalidation_failed`,
      );
    }
  }

  /**
   * The only search-process launch seam: fresh evidence, an exact executable
   * path, and direct argv. Callers cannot opt into a shell through this API.
   */
  async spawn(
    admitted: TrustedSearchExecutableEvidence,
    arguments_: readonly string[],
    input: {
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    },
  ): Promise<ChildProcessWithoutNullStreams> {
    await this.revalidate(admitted);
    return spawn(admitted.canonicalPath, [...arguments_], {
      cwd: input.cwd,
      env: input.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
}

export function systemSearchExecutablePaths(
  kind: TrustedSearchExecutableKind,
  environmentPath: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const executableName = platform === "win32" ? `${kind}.exe` : kind;
  const candidates = new Set<string>();
  for (const entry of environmentPath.split(paths.delimiter)) {
    if (
      entry.includes("\0") ||
      /[\r\n]/u.test(entry) ||
      !paths.isAbsolute(entry)
    ) {
      continue;
    }
    const directory = paths.resolve(entry);
    candidates.add(paths.join(directory, executableName));
  }
  return [...candidates];
}

export function piManagedSearchExecutablePath(
  kind: TrustedSearchExecutableKind,
  homeDirectory = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (
    !paths.isAbsolute(homeDirectory) ||
    paths.resolve(homeDirectory) !== homeDirectory ||
    homeDirectory.includes("\0")
  ) {
    throw new TrustedSearchExecutableError("trusted_search_path_invalid");
  }
  return paths.join(
    homeDirectory,
    ".pi",
    "agent",
    "bin",
    platform === "win32" ? `${kind}.exe` : kind,
  );
}

async function inspectPiManagedPath(
  candidate: string,
  homeDirectory: string,
  fileSystem: TrustedSearchFileSystem,
): Promise<PathEvidence> {
  const expectedKind = path.posix.basename(candidate);
  if (
    (expectedKind !== "rg" && expectedKind !== "fd") ||
    candidate !== piManagedSearchExecutablePath(expectedKind, homeDirectory)
  ) {
    throw new TrustedSearchExecutableError("trusted_search_path_invalid");
  }
  const accountUid = process.getuid?.();
  if (accountUid === undefined) {
    throw new TrustedSearchExecutableError("trusted_search_owner_unavailable");
  }
  if ((await fileSystem.realpath(homeDirectory)) !== homeDirectory) {
    throw new TrustedSearchExecutableError("trusted_search_path_untrusted");
  }
  for (const directory of [
    homeDirectory,
    path.posix.join(homeDirectory, ".pi"),
    path.posix.join(homeDirectory, ".pi", "agent"),
    path.posix.join(homeDirectory, ".pi", "agent", "bin"),
  ]) {
    const metadata = await fileSystem.lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== accountUid ||
      (metadata.mode & UNSAFE_WRITE_BITS) !== 0
    ) {
      throw new TrustedSearchExecutableError("trusted_search_path_untrusted");
    }
  }
  const canonicalPath = await fileSystem.realpath(candidate);
  if (canonicalPath !== candidate) {
    throw new TrustedSearchExecutableError("trusted_search_path_invalid");
  }
  const executable = await fileSystem.lstat(canonicalPath);
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    executable.uid !== accountUid ||
    (executable.mode & UNSAFE_WRITE_BITS) !== 0 ||
    (executable.mode & EXECUTE_BITS) === 0 ||
    executable.size <= 0
  ) {
    throw new TrustedSearchExecutableError(
      "trusted_search_executable_untrusted",
    );
  }
  return {
    canonicalPath,
    device: executable.dev,
    inode: executable.ino,
    size: executable.size,
    modifiedMilliseconds: executable.mtimeMs,
    mode: executable.mode,
  };
}

async function inspectSystemPath(
  candidate: string,
  fileSystem: TrustedSearchFileSystem,
  platform: NodeJS.Platform,
  accountUid: number | undefined,
): Promise<PathEvidence> {
  const expectedKind = path.posix.basename(candidate);
  if (
    (expectedKind !== "rg" && expectedKind !== "fd") ||
    !path.posix.isAbsolute(candidate) ||
    path.posix.resolve(candidate) !== candidate ||
    candidate.includes("\0")
  ) {
    throw new TrustedSearchExecutableError("trusted_search_path_invalid");
  }
  // Homebrew is an explicit operator installation boundary. Other PATH
  // entries continue to require root-owned, non-writable directory chains.
  const brewPrefix =
    platform === "darwin" && accountUid !== undefined
      ? ["/opt/homebrew", "/usr/local"].find(
          (prefix) => candidate === `${prefix}/bin/${expectedKind}`,
        )
      : undefined;
  const trustedMetadata = (
    metadata: TrustedSearchFileMetadata,
    candidatePath: string,
  ): boolean => {
    const inBrew =
      brewPrefix !== undefined &&
      (candidatePath === brewPrefix ||
        candidatePath.startsWith(`${brewPrefix}/`));
    return (
      (metadata.uid === 0 || (inBrew && metadata.uid === accountUid)) &&
      (metadata.mode & 0o002) === 0 &&
      ((metadata.mode & 0o020) === 0 || (inBrew && metadata.gid === 80))
    );
  };
  const candidateDirectory = await fileSystem.realpath(
    path.posix.dirname(candidate),
  );
  await validateRootOwnedDirectoryChain(
    candidateDirectory,
    fileSystem,
    trustedMetadata,
  );
  const canonicalPath = await fileSystem.realpath(candidate);
  await validateRootOwnedDirectoryChain(
    path.posix.dirname(canonicalPath),
    fileSystem,
    trustedMetadata,
  );
  const executable = await fileSystem.lstat(canonicalPath);
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    !trustedMetadata(executable, canonicalPath) ||
    (executable.mode & EXECUTE_BITS) === 0 ||
    executable.size <= 0
  ) {
    throw new TrustedSearchExecutableError(
      "trusted_search_executable_untrusted",
    );
  }
  return {
    canonicalPath,
    device: executable.dev,
    inode: executable.ino,
    size: executable.size,
    modifiedMilliseconds: executable.mtimeMs,
    mode: executable.mode,
  };
}

async function validateRootOwnedDirectoryChain(
  directory: string,
  fileSystem: TrustedSearchFileSystem,
  trustedMetadata: (
    metadata: TrustedSearchFileMetadata,
    path: string,
  ) => boolean,
): Promise<void> {
  if (
    !path.posix.isAbsolute(directory) ||
    path.posix.resolve(directory) !== directory
  ) {
    throw new TrustedSearchExecutableError("trusted_search_path_invalid");
  }
  const components = directory.split("/").filter(Boolean);
  let current = "/";
  validateRootOwnedDirectory(
    await fileSystem.lstat(current),
    trustedMetadata,
    current,
  );
  for (const component of components) {
    current = path.posix.join(current, component);
    validateRootOwnedDirectory(
      await fileSystem.lstat(current),
      trustedMetadata,
      current,
    );
  }
}

function validateRootOwnedDirectory(
  metadata: TrustedSearchFileMetadata,
  trustedMetadata: (
    metadata: TrustedSearchFileMetadata,
    path: string,
  ) => boolean,
  candidatePath: string,
): void {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !trustedMetadata(metadata, candidatePath)
  ) {
    throw new TrustedSearchExecutableError("trusted_search_path_untrusted");
  }
}

async function inspectWindowsPath(
  candidate: string,
  fileSystem: TrustedSearchFileSystem,
  assertAuthority: (candidate: string) => Promise<void>,
): Promise<PathEvidence> {
  if (
    !["rg.exe", "fd.exe"].includes(
      path.win32.basename(candidate).toLowerCase(),
    ) ||
    !path.win32.isAbsolute(candidate) ||
    path.win32.normalize(candidate) !== candidate
  ) {
    throw new TrustedSearchExecutableError("trusted_search_path_invalid");
  }
  await assertAuthority(candidate);
  const canonicalPath = await fileSystem.realpath(candidate);
  if (canonicalPath !== candidate) await assertAuthority(canonicalPath);
  const executable = await fileSystem.lstat(canonicalPath);
  if (
    !executable.isFile() ||
    executable.isSymbolicLink() ||
    executable.size <= 0 ||
    executable.ino === 0
  ) {
    throw new TrustedSearchExecutableError(
      "trusted_search_executable_untrusted",
    );
  }
  return {
    canonicalPath,
    device: executable.dev,
    inode: executable.ino,
    size: executable.size,
    modifiedMilliseconds: executable.mtimeMs,
    mode: executable.mode,
  };
}

function parseVersionOutput(
  kind: TrustedSearchExecutableKind,
  output: string,
): string {
  if (Buffer.byteLength(output, "utf8") > VERSION_STDOUT_LIMIT) {
    throw new TrustedSearchExecutableError("trusted_search_version_invalid");
  }
  const firstLine = output.split("\n", 1)[0]?.replace(/\r$/u, "") ?? "";
  const match =
    kind === "fd"
      ? /^fd ([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(firstLine)
      : /^ripgrep ([0-9]+\.[0-9]+\.[0-9]+)(?: \(rev [0-9a-f]{7,40}\))?$/u.exec(
          firstLine,
        );
  if (!match?.[1]) {
    throw new TrustedSearchExecutableError("trusted_search_version_invalid");
  }
  return match[1];
}

async function readBoundedVersion(candidate: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(candidate, ["--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(Buffer.concat(stdout).toString("utf8"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("trusted_search_version_timeout"));
    }, VERSION_TIMEOUT_MILLISECONDS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > VERSION_STDOUT_LIMIT) {
        child.kill("SIGKILL");
        finish(new Error("trusted_search_version_output_exceeded"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > VERSION_STDERR_LIMIT) {
        child.kill("SIGKILL");
        finish(new Error("trusted_search_version_output_exceeded"));
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0 || stderrBytes !== 0) {
        finish(new Error("trusted_search_version_failed"));
      } else {
        finish();
      }
    });
  });
}
