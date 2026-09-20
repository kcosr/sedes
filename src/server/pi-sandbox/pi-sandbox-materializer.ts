import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { RequestScope } from "../identity/identity-provider.js";
import type { PiSandboxWorkspaceAccess } from "./contracts.js";
import {
  PiSandboxAllocationRepository,
  type PiSandboxAllocationRecord,
} from "./pi-sandbox-allocation-repository.js";
import {
  PI_SANDBOX_HARDENED_GIT_ARGUMENTS,
  piSandboxHardenedGitEnvironment,
} from "./git-hardening.js";

const MAXIMUM_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 120_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type PiSandboxGitImpact = {
  readonly trackedChangeCount: number;
  readonly untrackedFileCount: number;
  readonly branch: string | null;
  readonly upstream: string | null;
  /** Null means the clone has no configured upstream. */
  readonly aheadCount: number | null;
};

export type PiSandboxCommandResult = {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

export type PiSandboxCommandRunner = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeoutMilliseconds: number;
    readonly maximumOutputBytes: number;
    readonly signal?: AbortSignal;
  },
) => Promise<PiSandboxCommandResult>;

export type PiSandboxMaterializerOptions = {
  readonly allocationRoot: string;
  readonly gitExecutable?: string;
  readonly now?: () => number;
  readonly commandRunner?: PiSandboxCommandRunner;
};

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function requireAbsoluteNormalized(value: string, code: string): string {
  if (
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0")
  ) {
    throw new Error(code);
  }
  return value;
}

async function defaultCommandRunner(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeoutMilliseconds: number;
    readonly maximumOutputBytes: number;
    readonly signal?: AbortSignal;
  },
): Promise<PiSandboxCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: piSandboxHardenedGitEnvironment(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminationError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const terminate = (error: Error) => {
      if (terminationError) return;
      terminationError = error;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const timer = setTimeout(
      () => terminate(new Error("sandbox_command_timed_out")),
      options.timeoutMilliseconds,
    );
    timer.unref();
    const abort = () => terminate(new Error("sandbox_command_aborted"));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    const consume = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maximumOutputBytes) {
        terminate(new Error("sandbox_command_output_limit_exceeded"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => consume(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => consume(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (terminationError) {
        // The group leader can exit on TERM before a descendant does. Fence
        // that race with a final group kill before reporting cancellation.
        killGroup("SIGKILL");
        if (killTimer) clearTimeout(killTimer);
        reject(terminationError);
        return;
      }
      if (killTimer) clearTimeout(killTimer);
      if (outputBytes > options.maximumOutputBytes) {
        reject(new Error("sandbox_command_output_limit_exceeded"));
        return;
      }
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function trimOutput(output: Buffer): string {
  return output.toString("utf8").trim();
}

function diagnosticCode(error: unknown, fallback: string): string {
  return error instanceof Error &&
    [
      "sandbox_allocation_path_invalid",
      "sandbox_allocation_symlink_rejected",
      "sandbox_source_path_invalid",
      "sandbox_command_output_limit_exceeded",
    ].includes(error.message)
    ? error.message
    : fallback;
}

export class PiSandboxMaterializer {
  readonly #allocationRoot: string;
  readonly #gitExecutable: string;
  readonly #now: () => number;
  readonly #run: PiSandboxCommandRunner;

  constructor(
    readonly repository: PiSandboxAllocationRepository,
    options: PiSandboxMaterializerOptions,
  ) {
    this.#allocationRoot = requireAbsoluteNormalized(
      options.allocationRoot,
      "sandbox_allocation_root_invalid",
    );
    this.#gitExecutable = options.gitExecutable ?? "git";
    this.#now = options.now ?? Date.now;
    this.#run = options.commandRunner ?? defaultCommandRunner;
  }

  /** Reserves durable placement only; it performs no filesystem work. */
  reserve(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly executionEnvironmentId: string;
      readonly sourceWorkspaceId: string;
      readonly sourceCanonicalPath: string;
      readonly workspaceAccess: PiSandboxWorkspaceAccess;
      readonly networkProfile: "isolated" | "execution_host";
      readonly allocationId?: string;
      readonly now?: number;
    },
  ): PiSandboxAllocationRecord {
    const sourceCanonicalPath = requireAbsoluteNormalized(
      input.sourceCanonicalPath,
      "sandbox_source_path_invalid",
    );
    const allocationId = input.allocationId ?? randomUUID();
    const allocationRootPath = path.join(this.#allocationRoot, allocationId);
    const homePath = path.join(allocationRootPath, "home");
    const workspacePath = path.join(homePath, "workspace");
    this.#assertPlacement({
      allocationId,
      allocationRootPath,
      homePath,
      workspacePath,
    });
    return this.repository.reserve(scope, {
      ...input,
      allocationId,
      sourceCanonicalPath,
      allocationRootPath,
      homePath,
      workspacePath,
      now: input.now ?? this.#now(),
    });
  }

  async materialize(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly operationId?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<PiSandboxAllocationRecord> {
    const operationId = input.operationId ?? randomUUID();
    const allocation = this.repository.beginMaterialization(
      scope,
      applicationThreadId,
      {
        expectedRevision: input.expectedRevision,
        operationId,
        now: this.#now(),
      },
    );
    try {
      this.#assertRecordPlacement(allocation);
      await this.#ensureAllocationRoot();
      await this.#prepareEmptyWorkspace(allocation);
      if (allocation.workspaceAccess === "read_only") {
        await this.#assertReadOnlySource(allocation);
        await mkdir(allocation.workspacePath, { mode: 0o700 });
        return this.repository.completeMaterialization(
          scope,
          applicationThreadId,
          {
            operationId,
            sourceHeadOid: null,
            sandboxBranch: null,
            now: this.#now(),
          },
        );
      }
      const clone = await this.#run(
        this.#gitExecutable,
        [
          ...PI_SANDBOX_HARDENED_GIT_ARGUMENTS,
          "clone",
          "--no-checkout",
          "--no-hardlinks",
          "--local",
          "--",
          allocation.sourceCanonicalPath,
          allocation.workspacePath,
        ],
        {
          timeoutMilliseconds: DEFAULT_COMMAND_TIMEOUT_MILLISECONDS,
          maximumOutputBytes: MAXIMUM_COMMAND_OUTPUT_BYTES,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      if (clone.exitCode !== 0) throw new Error("sandbox_clone_failed");
      const sourceHeadOid = await this.#gitOptional(
        allocation.workspacePath,
        ["rev-parse", "--verify", "HEAD"],
        input.signal,
      );
      const sandboxBranch = `sedes/sandbox-${allocation.allocationId}`;
      if (sourceHeadOid) {
        await this.#git(
          allocation.workspacePath,
          ["check-ref-format", "--branch", sandboxBranch],
          input.signal,
        );
        await this.#git(
          allocation.workspacePath,
          ["branch", sandboxBranch, sourceHeadOid],
          input.signal,
        );
        const sourceUpstream = await this.#gitOptional(
          allocation.workspacePath,
          ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
          input.signal,
        );
        if (sourceUpstream) {
          await this.#git(
            allocation.workspacePath,
            ["branch", "--set-upstream-to", sourceUpstream, sandboxBranch],
            input.signal,
          );
        }
        await this.#git(
          allocation.workspacePath,
          ["symbolic-ref", "HEAD", `refs/heads/${sandboxBranch}`],
          input.signal,
        );
        await this.#git(
          allocation.workspacePath,
          ["reset", "--hard", sourceHeadOid],
          input.signal,
        );
      }
      return this.repository.completeMaterialization(
        scope,
        applicationThreadId,
        {
          operationId,
          sourceHeadOid,
          sandboxBranch: sourceHeadOid ? sandboxBranch : null,
          now: this.#now(),
        },
      );
    } catch (error) {
      let cleanupFailed = false;
      try {
        await this.#removeIncompleteAllocation(allocation);
      } catch {
        cleanupFailed = true;
      }
      this.repository.failMaterialization(scope, applicationThreadId, {
        operationId,
        diagnosticCode: cleanupFailed
          ? "sandbox_materialization_cleanup_failed"
          : diagnosticCode(error, "sandbox_materialization_failed"),
        now: this.#now(),
      });
      throw error;
    }
  }

  async inspect(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<PiSandboxGitImpact> {
    const allocation = this.repository.requireForThread(
      scope,
      applicationThreadId,
    );
    if (allocation.workspaceAccess !== "writable_clone") {
      throw new Error("sandbox_git_inspection_unavailable");
    }
    if (allocation.state !== "ready" && allocation.state !== "delete_failed") {
      throw new Error("sandbox_not_inspectable");
    }
    this.#assertRecordPlacement(allocation);
    await this.#assertExistingDirectory(allocation.allocationRootPath);
    const status = await this.#git(allocation.workspacePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    let trackedChangeCount = 0;
    let untrackedFileCount = 0;
    const entries = status.toString("utf8").split("\0");
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      const code = entry.slice(0, 2);
      if (code === "??") untrackedFileCount += 1;
      else trackedChangeCount += 1;
      if (code.includes("R") || code.includes("C")) index += 1;
    }
    const branch = await this.#gitOptional(allocation.workspacePath, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const upstream = await this.#gitOptional(allocation.workspacePath, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    const aheadRaw = upstream
      ? await this.#gitOptional(allocation.workspacePath, [
          "rev-list",
          "--count",
          "@{upstream}..HEAD",
        ])
      : null;
    const aheadCount = aheadRaw === null ? null : Number.parseInt(aheadRaw, 10);
    if (
      aheadCount !== null &&
      (!Number.isSafeInteger(aheadCount) || aheadCount < 0)
    ) {
      throw new Error("sandbox_git_status_invalid");
    }
    return {
      trackedChangeCount,
      untrackedFileCount,
      branch,
      upstream,
      aheadCount,
    };
  }

  async delete(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly operationId?: string },
  ): Promise<PiSandboxAllocationRecord> {
    const operationId = input.operationId ?? randomUUID();
    const allocation = this.repository.beginDeletion(
      scope,
      applicationThreadId,
      {
        expectedRevision: input.expectedRevision,
        operationId,
        now: this.#now(),
      },
    );
    if (allocation.state === "deleted") return allocation;
    try {
      this.#assertRecordPlacement(allocation);
      await this.#ensureAllocationRoot();
      const metadata = await lstat(allocation.allocationRootPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (metadata?.isSymbolicLink()) {
        throw new Error("sandbox_allocation_symlink_rejected");
      }
      if (metadata && !metadata.isDirectory()) {
        throw new Error("sandbox_allocation_path_invalid");
      }
      if (metadata)
        await rm(allocation.allocationRootPath, { recursive: true });
      return this.repository.completeDeletion(scope, applicationThreadId, {
        operationId,
        now: this.#now(),
      });
    } catch (error) {
      this.repository.failDeletion(scope, applicationThreadId, {
        operationId,
        diagnosticCode: diagnosticCode(error, "sandbox_deletion_failed"),
        now: this.#now(),
      });
      throw error;
    }
  }

  #assertPlacement(input: {
    readonly allocationId: string;
    readonly allocationRootPath: string;
    readonly homePath: string;
    readonly workspacePath: string;
  }): void {
    const expectedRoot = path.join(this.#allocationRoot, input.allocationId);
    if (
      !UUID_PATTERN.test(input.allocationId) ||
      input.allocationRootPath !== expectedRoot ||
      input.homePath !== path.join(expectedRoot, "home") ||
      input.workspacePath !== path.join(expectedRoot, "home", "workspace") ||
      !isWithin(this.#allocationRoot, expectedRoot) ||
      expectedRoot === this.#allocationRoot
    ) {
      throw new Error("sandbox_allocation_path_invalid");
    }
  }

  #assertRecordPlacement(allocation: PiSandboxAllocationRecord): void {
    this.#assertPlacement(allocation);
  }

  async #ensureAllocationRoot(): Promise<void> {
    await mkdir(this.#allocationRoot, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#allocationRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("sandbox_allocation_symlink_rejected");
    }
    const canonical = await realpath(this.#allocationRoot);
    if (canonical !== this.#allocationRoot) {
      throw new Error("sandbox_allocation_symlink_rejected");
    }
    await chmod(this.#allocationRoot, 0o700);
  }

  async #prepareEmptyWorkspace(
    allocation: PiSandboxAllocationRecord,
  ): Promise<void> {
    const existing = await lstat(allocation.allocationRootPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (existing?.isSymbolicLink()) {
      throw new Error("sandbox_allocation_symlink_rejected");
    }
    if (existing && !existing.isDirectory()) {
      throw new Error("sandbox_allocation_path_invalid");
    }
    if (!existing) await mkdir(allocation.allocationRootPath, { mode: 0o700 });
    const existingHome = await lstat(allocation.homePath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (existingHome?.isSymbolicLink()) {
      throw new Error("sandbox_allocation_symlink_rejected");
    }
    if (existingHome && !existingHome.isDirectory()) {
      throw new Error("sandbox_allocation_path_invalid");
    }
    if (!existingHome) await mkdir(allocation.homePath, { mode: 0o700 });
    await chmod(allocation.allocationRootPath, 0o700);
    await chmod(allocation.homePath, 0o700);
    const workspace = await lstat(allocation.workspacePath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (workspace?.isSymbolicLink()) {
      throw new Error("sandbox_allocation_symlink_rejected");
    }
    if (workspace) await rm(allocation.workspacePath, { recursive: true });
  }

  async #assertReadOnlySource(
    allocation: PiSandboxAllocationRecord,
  ): Promise<void> {
    const metadata = await lstat(allocation.sourceCanonicalPath).catch(
      () => undefined,
    );
    if (
      !metadata?.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(allocation.sourceCanonicalPath).catch(() => "")) !==
        allocation.sourceCanonicalPath ||
      isWithin(allocation.sourceCanonicalPath, allocation.allocationRootPath) ||
      isWithin(allocation.allocationRootPath, allocation.sourceCanonicalPath)
    ) {
      throw new Error("sandbox_read_only_source_invalid");
    }
  }

  async #removeIncompleteAllocation(
    allocation: PiSandboxAllocationRecord,
  ): Promise<void> {
    this.#assertRecordPlacement(allocation);
    const rootMetadata = await lstat(this.#allocationRoot).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!rootMetadata) return;
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new Error("sandbox_allocation_symlink_rejected");
    }
    if ((await realpath(this.#allocationRoot)) !== this.#allocationRoot) {
      throw new Error("sandbox_allocation_symlink_rejected");
    }
    const allocationMetadata = await lstat(allocation.allocationRootPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!allocationMetadata) return;
    if (
      allocationMetadata.isSymbolicLink() ||
      !allocationMetadata.isDirectory() ||
      (await realpath(allocation.allocationRootPath)) !==
        allocation.allocationRootPath
    ) {
      throw new Error("sandbox_allocation_symlink_rejected");
    }
    await rm(allocation.allocationRootPath, { recursive: true });
  }

  async #assertExistingDirectory(candidate: string): Promise<void> {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("sandbox_allocation_symlink_rejected");
    }
    const canonical = await realpath(candidate);
    if (canonical !== candidate || !isWithin(this.#allocationRoot, canonical)) {
      throw new Error("sandbox_allocation_symlink_rejected");
    }
  }

  async #git(
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const result = await this.#run(
      this.#gitExecutable,
      [...PI_SANDBOX_HARDENED_GIT_ARGUMENTS, ...args],
      {
        cwd,
        timeoutMilliseconds: DEFAULT_COMMAND_TIMEOUT_MILLISECONDS,
        maximumOutputBytes: MAXIMUM_COMMAND_OUTPUT_BYTES,
        ...(signal ? { signal } : {}),
      },
    );
    if (result.exitCode !== 0) throw new Error("sandbox_git_command_failed");
    return result.stdout;
  }

  async #gitOptional(
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    const result = await this.#run(
      this.#gitExecutable,
      [...PI_SANDBOX_HARDENED_GIT_ARGUMENTS, ...args],
      {
        cwd,
        timeoutMilliseconds: DEFAULT_COMMAND_TIMEOUT_MILLISECONDS,
        maximumOutputBytes: MAXIMUM_COMMAND_OUTPUT_BYTES,
        ...(signal ? { signal } : {}),
      },
    );
    return result.exitCode === 0 ? trimOutput(result.stdout) || null : null;
  }
}
