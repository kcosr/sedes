import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import {
  ThreadRuntimeNotIdleError,
  ThreadRuntimeRetirementUnprovenError,
} from "../../src/server/events/thread-runtime-coordinator.js";
import type { PiSandboxAllocationRecord } from "../../src/server/pi-sandbox/pi-sandbox-allocation-repository.js";
import { PiSandboxLifecycleService } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";
import { PI_SANDBOX_HARDENED_GIT_ARGUMENTS } from "../../src/server/pi-sandbox/git-hardening.js";

const scope: RequestScope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};
const oid = "a".repeat(40);
const executeFile = promisify(execFileCallback);

function semanticGitArguments(arguments_: readonly string[]): readonly string[] {
  expect(
    arguments_.slice(0, PI_SANDBOX_HARDENED_GIT_ARGUMENTS.length),
  ).toEqual(PI_SANDBOX_HARDENED_GIT_ARGUMENTS);
  return arguments_.slice(PI_SANDBOX_HARDENED_GIT_ARGUMENTS.length);
}

async function git(repositoryPath: string, arguments_: readonly string[]) {
  return executeFile("git", ["-C", repositoryPath, ...arguments_], {
    encoding: "utf8",
  });
}

function allocation(
  overrides: Partial<PiSandboxAllocationRecord> = {},
): PiSandboxAllocationRecord {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId: "thread-1",
    allocationId: "10000000-0000-4000-8000-000000000001",
    executionEnvironmentId: "environment-1",
    sourceWorkspaceId: "workspace-1",
    sourceCanonicalPath: "/source/repository",
    allocationRootPath: "/allocations/10000000-0000-4000-8000-000000000001",
    homePath: "/allocations/10000000-0000-4000-8000-000000000001/home",
    workspacePath:
      "/allocations/10000000-0000-4000-8000-000000000001/home/workspace",
    workspaceAccess: "writable_clone",
    networkProfile: "isolated",
    state: "ready",
    retention: "active",
    operationId: null,
    completedDeleteOperationId: null,
    operationKind: null,
    diagnosticCode: null,
    sourceHeadOid: oid,
    sandboxBranch: "sedes/thread-1-10000000",
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    readyAt: 2,
    retainedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function fixture(input: {
  readonly record?: PiSandboxAllocationRecord;
  readonly getRecord?: () => PiSandboxAllocationRecord | undefined;
  readonly inspection?: {
    readonly trackedChangeCount: number;
    readonly untrackedFileCount: number;
    readonly upstream: string | null;
    readonly aheadCount: number | null;
  };
  readonly runGit?: (
    repositoryPath: string,
    arguments_: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly deleteWorkspace?: (
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly operationId: string },
  ) => Promise<PiSandboxAllocationRecord>;
  readonly runWithRuntimeRetired?: <Result>(
    scope: RequestScope,
    applicationThreadId: string,
    operation: () => Promise<Result>,
  ) => Promise<Result>;
}) {
  const record = () => input.getRecord?.() ?? input.record;
  const inspect = vi.fn(async () =>
    Promise.resolve(
      input.inspection ?? {
        trackedChangeCount: 0,
        untrackedFileCount: 0,
        upstream: "origin/main",
        aheadCount: 1,
      },
    ),
  );
  const deleteWorkspace = vi.fn(
    input.deleteWorkspace ??
      (async () =>
        Promise.resolve(
          allocation({
            state: "deleted",
            retention: "delete_requested",
            revision: 4,
          }),
        )),
  );
  const markRetained = vi.fn(() =>
    allocation({ retention: "retained", revision: 3, retainedAt: 3 }),
  );
  const runtimeRetirementCalls = vi.fn();
  const runWithRuntimeRetired = async <Result>(
    retirementScope: RequestScope,
    applicationThreadId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    runtimeRetirementCalls(retirementScope, applicationThreadId, operation);
    return input.runWithRuntimeRetired
      ? input.runWithRuntimeRetired(
          retirementScope,
          applicationThreadId,
          operation,
        )
      : operation();
  };
  return {
    inspect,
    deleteWorkspace,
    markRetained,
    runtimeRetirementCalls,
    service: new PiSandboxLifecycleService({
      allocations: {
        getForThread: () => record(),
        requireForThread: () => {
          const current = record();
          if (!current) throw new Error("missing");
          return current;
        },
        markRetained,
      },
      materializer: { inspect, delete: deleteWorkspace },
      runtimeRetirement: { runWithRuntimeRetired },
      ...(input.runGit ? { runGit: input.runGit } : {}),
    }),
  };
}

describe("PiSandboxLifecycleService", () => {
  it("projects direct and retained isolated resources without accepting paths", async () => {
    await expect(
      fixture({}).service.status(scope, "thread-1"),
    ).resolves.toEqual({
      kind: "direct",
    });

    const current = fixture({
      record: allocation({ retention: "retained", revision: 3 }),
    });
    await expect(current.service.status(scope, "thread-1")).resolves.toEqual({
      kind: "isolated",
      workspaceAccess: "writable_clone",
      state: "retained",
      allocationRevision: 3,
      networkProfile: "isolated",
      hostPaths: {
        home: "/allocations/10000000-0000-4000-8000-000000000001/home",
        workspace:
          "/allocations/10000000-0000-4000-8000-000000000001/home/workspace",
      },
      branch: "sedes/thread-1-10000000",
      gitStatus: {
        available: true,
        trackedChangeCount: 0,
        untrackedFileCount: 0,
        upstream: "origin/main",
        aheadCount: 1,
      },
    });
  });

  it("projects a read-only source without Git lifecycle authority", async () => {
    const current = fixture({
      record: allocation({
        workspaceAccess: "read_only",
        sourceCanonicalPath: "/source/plain-directory",
        sourceHeadOid: null,
        sandboxBranch: null,
      }),
    });
    await expect(current.service.status(scope, "thread-1")).resolves.toEqual({
      kind: "isolated",
      workspaceAccess: "read_only",
      state: "ready",
      allocationRevision: 2,
      networkProfile: "isolated",
      hostPaths: {
        home: "/allocations/10000000-0000-4000-8000-000000000001/home",
        workspace: "/source/plain-directory",
      },
      branch: null,
      gitStatus: {
        available: false,
        reason: "Git branch safety checks do not apply to a read-only source mount.",
      },
    });
    expect(current.inspect).not.toHaveBeenCalled();
    await expect(
      current.service.importBranch(scope, "thread-1", {
        expectedRevision: 2,
        operationId: "00000000-0000-4000-8000-000000000020",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(
      current.service.handoff(scope, "thread-1", {
        expectedRevision: 2,
        operationId: "00000000-0000-4000-8000-000000000021",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(current.markRetained).not.toHaveBeenCalled();
  });

  it("distinguishes failed provisioning from active provisioning", async () => {
    const materializing = fixture({
      record: allocation({ state: "materializing", revision: 3 }),
    });
    await expect(
      materializing.service.status(scope, "thread-1"),
    ).resolves.toMatchObject({
      kind: "isolated",
      state: "provisioning",
      allocationRevision: 3,
    });

    const failed = fixture({
      record: allocation({
        state: "materialization_failed",
        revision: 4,
        diagnosticCode: "sandbox_materialization_failed",
      }),
    });
    await expect(
      failed.service.status(scope, "thread-1"),
    ).resolves.toMatchObject({
      kind: "isolated",
      state: "provisioning_failed",
      allocationRevision: 4,
      gitStatus: {
        available: false,
        reason: "Provisioning failed before Git status became available.",
      },
    });
    await expect(
      failed.service.delete(scope, "thread-1", {
        expectedRevision: 4,
        operationId: "20000000-0000-4000-8000-000000000027",
      }),
    ).resolves.toMatchObject({ state: "deleted" });
  });

  it("preserves an unverifiable no-upstream Git state in status projection", async () => {
    const current = fixture({
      record: allocation(),
      inspection: {
        trackedChangeCount: 0,
        untrackedFileCount: 0,
        upstream: null,
        aheadCount: null,
      },
    });
    await expect(
      current.service.status(scope, "thread-1"),
    ).resolves.toMatchObject({
      kind: "isolated",
      gitStatus: {
        available: true,
        trackedChangeCount: 0,
        untrackedFileCount: 0,
        upstream: null,
        aheadCount: null,
      },
    });
  });

  it("performs exact revision-and-operation deletion through the materializer", async () => {
    const current = fixture({ record: allocation() });
    await expect(
      current.service.delete(scope, "thread-1", {
        expectedRevision: 2,
        operationId: "20000000-0000-4000-8000-000000000002",
      }),
    ).resolves.toEqual({
      state: "deleted",
      allocationRevision: 4,
      operationId: "20000000-0000-4000-8000-000000000002",
    });
    expect(current.deleteWorkspace).toHaveBeenCalledWith(scope, "thread-1", {
      expectedRevision: 2,
      operationId: "20000000-0000-4000-8000-000000000002",
    });
    expect(current.runtimeRetirementCalls).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.any(Function),
    );
  });

  it("does not start deletion until runtime retirement admits the operation", async () => {
    let admitted!: () => void;
    const retirementGate = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const current = fixture({
      record: allocation(),
      runWithRuntimeRetired: async (_scope, _threadId, operation) => {
        await retirementGate;
        return operation();
      },
    });
    const deleting = current.service.delete(scope, "thread-1", {
      expectedRevision: 2,
      operationId: "20000000-0000-4000-8000-000000000024",
    });
    await Promise.resolve();
    expect(current.deleteWorkspace).not.toHaveBeenCalled();

    admitted();
    await expect(deleting).resolves.toMatchObject({ state: "deleted" });
    expect(current.deleteWorkspace).toHaveBeenCalledOnce();
  });

  it("reports busy runtime retirement as retryable without deleting", async () => {
    const current = fixture({
      record: allocation(),
      runWithRuntimeRetired: async () => {
        throw new ThreadRuntimeNotIdleError();
      },
    });
    await expect(
      current.service.delete(scope, "thread-1", {
        expectedRevision: 2,
        operationId: "20000000-0000-4000-8000-000000000025",
      }),
    ).rejects.toMatchObject({
      code: "runtime_unavailable",
      retryable: true,
      message: expect.stringContaining("become idle"),
    });
    expect(current.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("reports unproven runtime retirement as non-retryable without deleting", async () => {
    const current = fixture({
      record: allocation(),
      runWithRuntimeRetired: async () => {
        throw new ThreadRuntimeRetirementUnprovenError(
          new Error("runtime retirement failed"),
        );
      },
    });
    await expect(
      current.service.delete(scope, "thread-1", {
        expectedRevision: 2,
        operationId: "20000000-0000-4000-8000-000000000026",
      }),
    ).rejects.toMatchObject({
      code: "operation_outcome_uncertain",
      retryable: false,
      message: expect.stringContaining("Restart Sedes"),
    });
    expect(current.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("replays an archive deletion from the durable delete-failed revision", async () => {
    const operationId = "20000000-0000-4000-8000-000000000021";
    const current = fixture({
      record: allocation({
        state: "delete_failed",
        retention: "delete_requested",
        revision: 4,
        diagnosticCode: "sandbox_deletion_failed",
      }),
    });
    await expect(
      current.service.delete(scope, "thread-1", {
        expectedRevision: 2,
        operationId,
      }),
    ).resolves.toMatchObject({ state: "deleted", operationId });
    expect(current.deleteWorkspace).toHaveBeenCalledWith(scope, "thread-1", {
      expectedRevision: 4,
      operationId,
    });
  });

  it("reports a retryable durable outcome when filesystem deletion fails", async () => {
    const failed = allocation({
      state: "delete_failed",
      retention: "delete_requested",
      revision: 4,
      diagnosticCode: "sandbox_deletion_failed",
    });
    let current = allocation();
    const fixtureValue = fixture({
      getRecord: () => current,
      deleteWorkspace: async () => {
        current = failed;
        throw new Error("filesystem failure");
      },
    });
    await expect(
      fixtureValue.service.delete(scope, "thread-1", {
        expectedRevision: 2,
        operationId: "20000000-0000-4000-8000-000000000022",
      }),
    ).rejects.toMatchObject({
      code: "operation_outcome_uncertain",
      retryable: true,
    });
  });

  it("retains an active ready clone for outside continuation", async () => {
    const current = fixture({ record: allocation() });
    await expect(
      current.service.handoff(scope, "thread-1", {
        expectedRevision: 2,
        operationId: "20000000-0000-4000-8000-000000000020",
      }),
    ).resolves.toEqual({
      state: "retained",
      allocationRevision: 3,
      workspacePath:
        "/allocations/10000000-0000-4000-8000-000000000001/home/workspace",
      branch: "sedes/thread-1-10000000",
    });
    expect(current.markRetained).toHaveBeenCalledWith(scope, "thread-1", {
      expectedRevision: 2,
      now: expect.any(Number),
    });
  });

  it("imports an active ready clean branch by local fetch and replays by exact oid", async () => {
    const runGit = vi.fn(
      async (_repositoryPath: string, arguments_: readonly string[]) => {
        const semanticArguments = semanticGitArguments(arguments_);
        if (semanticArguments[0] === "check-ref-format") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (semanticArguments[0] === "fetch") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        const sourceLookup = _repositoryPath === "/source/repository";
        const sourceLookupCount = runGit.mock.calls.filter(
          ([path, args]) =>
            path === "/source/repository" &&
            semanticGitArguments(args)[0] === "rev-parse",
        ).length;
        return sourceLookup && sourceLookupCount === 1
          ? { exitCode: 1, stdout: "", stderr: "missing" }
          : { exitCode: 0, stdout: `${oid}\n`, stderr: "" };
      },
    );
    const current = fixture({ record: allocation(), runGit });
    await expect(
      current.service.importBranch(scope, "thread-1", {
        expectedRevision: 2,
        operationId: "20000000-0000-4000-8000-000000000003",
      }),
    ).resolves.toEqual({
      branch: "sedes/thread-1-10000000",
      headOid: oid,
      sourceRepositoryPath: "/source/repository",
    });
    expect(runGit).toHaveBeenCalledWith(
      "/source/repository",
      expect.arrayContaining([
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "/allocations/10000000-0000-4000-8000-000000000001/home/workspace",
        `${oid}:refs/heads/sedes/thread-1-10000000`,
      ]),
    );
    const fetchArguments = runGit.mock.calls.find(
      ([, arguments_]) => semanticGitArguments(arguments_)[0] === "fetch",
    )?.[1];
    expect(fetchArguments).not.toContain(
      "refs/heads/sedes/thread-1-10000000:refs/heads/sedes/thread-1-10000000",
    );

    const replayGit = vi.fn(
      async (_repositoryPath: string, _arguments: readonly string[]) => ({
        exitCode: 0,
        stdout: `${oid}\n`,
        stderr: "",
      }),
    );
    await fixture({
      record: allocation(),
      runGit: replayGit,
    }).service.importBranch(scope, "thread-1", {
      expectedRevision: 2,
      operationId: "20000000-0000-4000-8000-000000000004",
    });
    expect(
      replayGit.mock.calls.some(
        ([, args]) => semanticGitArguments(args)[0] === "fetch",
      ),
    ).toBe(false);
  });

  it("imports the captured commit when the isolated branch advances before fetch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-import-oid-"));
    const source = path.join(root, "source");
    const isolated = path.join(root, "isolated");
    try {
      await mkdir(source);
      await git(source, ["init", "--initial-branch=main"]);
      await git(source, ["config", "user.name", "Sedes Test"]);
      await git(source, ["config", "user.email", "harness@example.invalid"]);
      await writeFile(path.join(source, "README.md"), "source\n");
      await git(source, ["add", "README.md"]);
      await git(source, ["commit", "-m", "source"]);
      await executeFile("git", ["clone", "--", source, isolated]);
      await git(isolated, ["config", "user.name", "Sedes Test"]);
      await git(isolated, ["config", "user.email", "harness@example.invalid"]);
      await git(isolated, ["checkout", "-b", "sedes/sandbox-test"]);
      await writeFile(path.join(isolated, "work.txt"), "captured\n");
      await git(isolated, ["add", "work.txt"]);
      await git(isolated, ["commit", "-m", "captured"]);
      const capturedHead = (
        await git(isolated, ["rev-parse", "HEAD"])
      ).stdout.trim();

      let advanced = false;
      const runGit = async (
        repositoryPath: string,
        arguments_: readonly string[],
      ) => {
        const semanticArguments = semanticGitArguments(arguments_);
        if (semanticArguments[0] === "fetch" && !advanced) {
          advanced = true;
          await writeFile(path.join(isolated, "work.txt"), "advanced\n");
          await git(isolated, ["add", "work.txt"]);
          await git(isolated, ["commit", "-m", "advanced"]);
        }
        try {
          const result = await git(repositoryPath, arguments_);
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string };
          return {
            exitCode: 1,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? "",
          };
        }
      };
      const current = fixture({
        record: allocation({
          sourceCanonicalPath: source,
          workspacePath: isolated,
          sandboxBranch: "sedes/sandbox-test",
        }),
        runGit,
      });

      await expect(
        current.service.importBranch(scope, "thread-1", {
          expectedRevision: 2,
          operationId: "20000000-0000-4000-8000-000000000024",
        }),
      ).resolves.toMatchObject({
        branch: "sedes/sandbox-test",
        headOid: capturedHead,
      });
      const advancedHead = (
        await git(isolated, ["rev-parse", "HEAD"])
      ).stdout.trim();
      const importedHead = (
        await git(source, ["rev-parse", "refs/heads/sedes/sandbox-test"])
      ).stdout.trim();
      expect(advancedHead).not.toBe(capturedHead);
      expect(importedHead).toBe(capturedHead);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("imports without executing an agent-configured clone fsmonitor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-import-hardened-"));
    const source = path.join(root, "source");
    const isolated = path.join(root, "isolated");
    const sentinel = path.join(root, "fsmonitor-ran");
    const fsmonitor = path.join(root, "malicious-fsmonitor");
    try {
      await mkdir(source);
      await git(source, ["init", "--initial-branch=main"]);
      await git(source, ["config", "user.name", "Sedes Test"]);
      await git(source, ["config", "user.email", "harness@example.invalid"]);
      await writeFile(path.join(source, "README.md"), "source\n");
      await git(source, ["add", "README.md"]);
      await git(source, ["commit", "-m", "source"]);
      await executeFile("git", ["clone", "--", source, isolated]);
      await git(isolated, ["checkout", "-b", "sedes/sandbox-hardened"]);
      await writeFile(fsmonitor, `#!/bin/sh\ntouch '${sentinel}'\nprintf '\\n'\n`);
      await chmod(fsmonitor, 0o700);
      await git(isolated, ["config", "core.fsmonitor", fsmonitor]);

      await fixture({
        record: allocation({
          sourceCanonicalPath: source,
          workspacePath: isolated,
          sandboxBranch: "sedes/sandbox-hardened",
        }),
      }).service.importBranch(scope, "thread-1", {
        expectedRevision: 2,
        operationId: "20000000-0000-4000-8000-000000000028",
      });

      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects dirty clones and branch collisions without fetching", async () => {
    const dirty = fixture({
      record: allocation(),
      inspection: {
        trackedChangeCount: 1,
        untrackedFileCount: 0,
        upstream: null,
        aheadCount: null,
      },
      runGit: vi.fn(),
    });
    await expect(
      dirty.service.importBranch(scope, "thread-1", {
        expectedRevision: 2,
        operationId: "20000000-0000-4000-8000-000000000005",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const differentOid = "b".repeat(40);
    const runGit = vi.fn(
      async (repositoryPath: string, arguments_: readonly string[]) => ({
        exitCode: 0,
        stdout:
          semanticGitArguments(arguments_)[0] === "check-ref-format"
            ? ""
            : `${repositoryPath === "/source/repository" ? differentOid : oid}\n`,
        stderr: "",
      }),
    );
    await expect(
      fixture({ record: allocation(), runGit }).service.importBranch(
        scope,
        "thread-1",
        {
          expectedRevision: 2,
          operationId: "20000000-0000-4000-8000-000000000006",
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      runGit.mock.calls.some(
        ([, args]) => semanticGitArguments(args)[0] === "fetch",
      ),
    ).toBe(false);
  });
});
