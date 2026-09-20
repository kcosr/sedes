import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type {
  DeleteThreadExecutionWorkspaceResult,
  HandoffThreadExecutionWorkspaceResult,
  ImportThreadExecutionWorkspaceResult,
  ThreadExecutionWorkspaceResource,
} from "../../shared/protocol/api.js";
import { DomainError } from "../domain/errors.js";
import {
  ThreadRuntimeNotIdleError,
  type ThreadRuntimeRetirement,
  ThreadRuntimeRetirementUnprovenError,
} from "../events/thread-runtime-coordinator.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  PiSandboxAllocationRecord,
  PiSandboxAllocationRepository,
} from "./pi-sandbox-allocation-repository.js";
import { piSandboxEffectiveWorkspacePath } from "./pi-sandbox-allocation-repository.js";
import {
  PI_SANDBOX_HARDENED_GIT_ARGUMENTS,
  piSandboxHardenedGitEnvironment,
} from "./git-hardening.js";

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MILLISECONDS = 30_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;

export interface PiSandboxInspection {
  readonly trackedChangeCount: number;
  readonly untrackedFileCount: number;
  readonly upstream: string | null;
  readonly aheadCount: number | null;
}

export interface PiSandboxLifecycleMaterializer {
  inspect(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<PiSandboxInspection>;
  delete(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly operationId: string },
  ): Promise<PiSandboxAllocationRecord>;
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PiSandboxLifecycleServiceInput {
  readonly allocations: Pick<
    PiSandboxAllocationRepository,
    "getForThread" | "requireForThread" | "markRetained"
  >;
  readonly materializer: PiSandboxLifecycleMaterializer;
  readonly runtimeRetirement: ThreadRuntimeRetirement;
  readonly runGit?: (
    repositoryPath: string,
    arguments_: readonly string[],
  ) => Promise<GitResult>;
}

/** Explicit no-allocation implementation for installations and test fixtures. */
export const directThreadExecutionWorkspaceLifecycle = Object.freeze({
  async status(): Promise<ThreadExecutionWorkspaceResource> {
    return { kind: "direct" };
  },
  async delete(): Promise<never> {
    throw new DomainError(
      "invalid_transition",
      "A direct thread has no isolated workspace to delete.",
    );
  },
  async importBranch(): Promise<never> {
    throw new DomainError(
      "invalid_transition",
      "A direct thread has no isolated branch to import.",
    );
  },
  async handoff(): Promise<never> {
    throw new DomainError(
      "invalid_transition",
      "A direct thread has no isolated workspace to hand off.",
    );
  },
});

/**
 * Principal-scoped lifecycle and host handoff boundary for one thread's
 * server-generated clone. Every filesystem target comes from the allocation
 * row; browser-supplied paths and ref names are deliberately absent.
 */
export class PiSandboxLifecycleService {
  readonly #runGit: NonNullable<PiSandboxLifecycleServiceInput["runGit"]>;

  constructor(readonly input: PiSandboxLifecycleServiceInput) {
    const executeGit = input.runGit ?? runGit;
    this.#runGit = (repositoryPath, arguments_) =>
      executeGit(repositoryPath, [
        ...PI_SANDBOX_HARDENED_GIT_ARGUMENTS,
        ...arguments_,
      ]);
  }

  async status(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ThreadExecutionWorkspaceResource> {
    const allocation = this.input.allocations.getForThread(
      scope,
      applicationThreadId,
    );
    if (!allocation) return { kind: "direct" };

    let gitStatus: Extract<
      ThreadExecutionWorkspaceResource,
      { kind: "isolated" }
    >["gitStatus"];
    if (allocation.workspaceAccess === "read_only") {
      gitStatus = {
        available: false,
        reason: "Git branch safety checks do not apply to a read-only source mount.",
      };
    } else if (
      allocation.state === "ready" ||
      allocation.state === "delete_failed"
    ) {
      try {
        const inspection = await this.input.materializer.inspect(
          scope,
          applicationThreadId,
        );
        gitStatus = {
          available: true,
          trackedChangeCount: inspection.trackedChangeCount,
          untrackedFileCount: inspection.untrackedFileCount,
          upstream: inspection.upstream,
          aheadCount: inspection.aheadCount,
        };
      } catch {
        gitStatus = {
          available: false,
          reason: "Git status is temporarily unavailable.",
        };
      }
    } else {
      gitStatus = {
        available: false,
        reason:
          allocation.state === "deleted"
            ? "The isolated workspace has been deleted."
            : allocation.state === "materialization_failed"
              ? "Provisioning failed before Git status became available."
              : "Git status is unavailable while the isolated workspace is changing.",
      };
    }

    return {
      kind: "isolated",
      workspaceAccess: allocation.workspaceAccess,
      state: projectedState(allocation),
      allocationRevision: allocation.revision,
      networkProfile: allocation.networkProfile,
      hostPaths: {
        home: allocation.homePath,
        workspace: piSandboxEffectiveWorkspacePath(allocation),
      },
      branch: allocation.sandboxBranch,
      gitStatus,
    };
  }

  async delete(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly operationId: string },
  ): Promise<DeleteThreadExecutionWorkspaceResult> {
    try {
      return await this.input.runtimeRetirement.runWithRuntimeRetired(
        scope,
        applicationThreadId,
        () => this.#deleteRetired(scope, applicationThreadId, input),
      );
    } catch (error) {
      if (error instanceof ThreadRuntimeNotIdleError) {
        throw new DomainError(
          "runtime_unavailable",
          "Wait for the thread runtime to become idle, then retry deleting its isolated workspace.",
          true,
          { cause: error },
        );
      }
      if (error instanceof ThreadRuntimeRetirementUnprovenError) {
        throw new DomainError(
          "operation_outcome_uncertain",
          "Sedes could not prove that the thread runtime stopped, so the isolated workspace was not deleted. Restart Sedes before retrying deletion.",
          false,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #deleteRetired(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly operationId: string },
  ): Promise<DeleteThreadExecutionWorkspaceResult> {
    const current = this.input.allocations.requireForThread(
      scope,
      applicationThreadId,
    );
    const expectedRevision =
      current.state === "delete_failed" &&
      current.retention === "delete_requested" &&
      current.revision > input.expectedRevision
        ? current.revision
        : input.expectedRevision;
    let deleted: PiSandboxAllocationRecord;
    try {
      deleted = await this.input.materializer.delete(
        scope,
        applicationThreadId,
        { ...input, expectedRevision },
      );
    } catch (error) {
      const failed = this.input.allocations.getForThread(
        scope,
        applicationThreadId,
      );
      if (failed?.state === "delete_failed") {
        throw new DomainError(
          "operation_outcome_uncertain",
          "The isolated workspace could not be fully deleted. Its allocation remains recorded and the same deletion can be retried.",
          true,
          { cause: error },
        );
      }
      throw error;
    }
    if (deleted.state !== "deleted") {
      throw new DomainError(
        "operation_outcome_uncertain",
        "The isolated workspace deletion outcome is unresolved.",
        true,
      );
    }
    return {
      state: "deleted",
      allocationRevision: deleted.revision,
      operationId: input.operationId,
    };
  }

  async importBranch(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly operationId: string },
  ): Promise<ImportThreadExecutionWorkspaceResult> {
    const allocation = this.input.allocations.requireForThread(
      scope,
      applicationThreadId,
    );
    if (allocation.workspaceAccess !== "writable_clone") {
      throw new DomainError(
        "invalid_transition",
        "A read-only source mount has no isolated branch to import.",
      );
    }
    if (allocation.revision !== input.expectedRevision) {
      throw new DomainError(
        "conflict",
        "The isolated workspace changed before its branch was imported.",
      );
    }
    if (allocation.state !== "ready" || !allocation.sandboxBranch) {
      throw new DomainError(
        "invalid_transition",
        "Only a ready isolated workspace can import its branch.",
      );
    }

    const inspection = await this.input.materializer.inspect(
      scope,
      applicationThreadId,
    );
    if (
      inspection.trackedChangeCount > 0 ||
      inspection.untrackedFileCount > 0
    ) {
      throw new DomainError(
        "conflict",
        "Commit or discard all isolated workspace changes before importing its branch.",
      );
    }

    const branch = allocation.sandboxBranch;
    const ref = `refs/heads/${branch}`;
    const checked = await this.#runGit(allocation.workspacePath, [
      "check-ref-format",
      ref,
    ]);
    if (checked.exitCode !== 0) {
      throw new DomainError(
        "materialization_unresolved",
        "The isolated workspace branch is invalid.",
      );
    }
    const isolatedHead = await this.#requiredOid(allocation.workspacePath, ref);
    const existing = await this.#optionalOid(
      allocation.sourceCanonicalPath,
      ref,
    );
    if (existing !== null && existing !== isolatedHead) {
      throw new DomainError(
        "conflict",
        "The source repository already has a different branch with this name.",
      );
    }
    if (existing === null) {
      const fetched = await this.#runGit(allocation.sourceCanonicalPath, [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--",
        allocation.workspacePath,
        `${isolatedHead}:${ref}`,
      ]);
      if (fetched.exitCode !== 0) {
        throw new DomainError(
          "operation_outcome_uncertain",
          "The isolated workspace branch could not be imported into the source repository.",
          true,
        );
      }
    }
    const importedHead = await this.#requiredOid(
      allocation.sourceCanonicalPath,
      ref,
    );
    if (importedHead !== isolatedHead) {
      throw new DomainError(
        "operation_outcome_uncertain",
        "The imported branch did not resolve to the isolated workspace commit.",
        true,
      );
    }
    return {
      branch,
      headOid: importedHead,
      sourceRepositoryPath: allocation.sourceCanonicalPath,
    };
  }

  async handoff(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly operationId: string },
  ): Promise<HandoffThreadExecutionWorkspaceResult> {
    const current = this.input.allocations.requireForThread(
      scope,
      applicationThreadId,
    );
    if (current.workspaceAccess !== "writable_clone") {
      throw new DomainError(
        "invalid_transition",
        "A read-only source mount cannot be retained for outside use.",
      );
    }
    if (current.state !== "ready" || !current.sandboxBranch) {
      throw new DomainError(
        "invalid_transition",
        "Only a ready isolated workspace can be handed off.",
      );
    }
    const retained = this.input.allocations.markRetained(
      scope,
      applicationThreadId,
      { expectedRevision: input.expectedRevision, now: Date.now() },
    );
    return {
      state: "retained",
      allocationRevision: retained.revision,
      workspacePath: retained.workspacePath,
      branch: retained.sandboxBranch ?? current.sandboxBranch,
    };
  }

  async #requiredOid(repositoryPath: string, ref: string): Promise<string> {
    const result = await this.#runGit(repositoryPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      ref,
    ]);
    const oid = parseOid(result.stdout);
    if (result.exitCode !== 0 || !oid) {
      throw new DomainError(
        "materialization_unresolved",
        "The isolated workspace branch commit could not be resolved.",
      );
    }
    return oid;
  }

  async #optionalOid(
    repositoryPath: string,
    ref: string,
  ): Promise<string | null> {
    const result = await this.#runGit(repositoryPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      ref,
    ]);
    if (result.exitCode !== 0) return null;
    const oid = parseOid(result.stdout);
    if (!oid) {
      throw new DomainError(
        "materialization_unresolved",
        "The source repository branch could not be resolved.",
      );
    }
    return oid;
  }
}

function projectedState(
  allocation: PiSandboxAllocationRecord,
): Extract<ThreadExecutionWorkspaceResource, { kind: "isolated" }>["state"] {
  if (allocation.state === "ready") {
    return allocation.retention === "retained" ? "retained" : "ready";
  }
  if (allocation.state === "deleting") return "deleting";
  if (allocation.state === "delete_failed") return "deletion_failed";
  if (allocation.state === "deleted") return "deleted";
  if (allocation.state === "materialization_failed") {
    return "provisioning_failed";
  }
  return "provisioning";
}

function parseOid(value: string): string | undefined {
  const oid = value.trim();
  return /^[0-9a-f]{40,64}$/u.test(oid) ? oid : undefined;
}

async function runGit(
  repositoryPath: string,
  arguments_: readonly string[],
): Promise<GitResult> {
  try {
    const result = await execFile(
      "git",
      [
        ...arguments_.slice(0, PI_SANDBOX_HARDENED_GIT_ARGUMENTS.length),
        "-C",
        repositoryPath,
        ...arguments_.slice(PI_SANDBOX_HARDENED_GIT_ARGUMENTS.length),
      ],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MILLISECONDS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
        env: piSandboxHardenedGitEnvironment(),
      },
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!error || typeof error !== "object") throw error;
    const failure = error as {
      readonly code?: number | string;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}
