import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import {
  PiSandboxAllocationRepository,
  type PiSandboxAllocationRecord,
} from "../../src/server/pi-sandbox/pi-sandbox-allocation-repository.js";
import { PiSandboxMaterializer } from "../../src/server/pi-sandbox/pi-sandbox-materializer.js";

const roots: string[] = [];
const scope: RequestScope = { tenantId: "tenant", principalId: "principal" };
const threadId = "00000000-0000-4000-8000-000000000010";
const allocationId = "00000000-0000-4000-8000-000000000011";
const operationId = "00000000-0000-4000-8000-000000000012";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

async function sourceRepository(root: string): Promise<string> {
  const source = path.join(root, "source");
  await mkdir(source);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Sandbox Test");
  git(source, "config", "user.email", "sandbox@example.invalid");
  await writeFile(
    path.join(source, ".gitattributes"),
    "payload.txt filter=evil\n",
  );
  await writeFile(path.join(source, "payload.txt"), "payload\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "initial");
  return source;
}

class FakeRepository {
  record: PiSandboxAllocationRecord;

  constructor(record: PiSandboxAllocationRecord) {
    this.record = record;
  }

  requireForThread(): PiSandboxAllocationRecord {
    return this.record;
  }

  beginMaterialization(
    _scope: RequestScope,
    _threadId: string,
    input: { operationId: string; now: number },
  ): PiSandboxAllocationRecord {
    this.record = {
      ...this.record,
      state: "materializing",
      operationId: input.operationId,
      operationKind: "materialize",
      revision: this.record.revision + 1,
      updatedAt: input.now,
    };
    return this.record;
  }

  completeMaterialization(
    _scope: RequestScope,
    _threadId: string,
    input: {
      sourceHeadOid: string | null;
      sandboxBranch: string | null;
      now: number;
    },
  ): PiSandboxAllocationRecord {
    this.record = {
      ...this.record,
      state: "ready",
      operationId: null,
      completedDeleteOperationId: null,
      operationKind: null,
      sourceHeadOid: input.sourceHeadOid,
      sandboxBranch: input.sandboxBranch,
      readyAt: input.now,
      revision: this.record.revision + 1,
      updatedAt: input.now,
    };
    return this.record;
  }

  failMaterialization(): PiSandboxAllocationRecord {
    this.record = { ...this.record, state: "materialization_failed" };
    return this.record;
  }

  beginDeletion(
    _scope: RequestScope,
    _threadId: string,
    input: { operationId: string; now: number },
  ): PiSandboxAllocationRecord {
    this.record = {
      ...this.record,
      state: "deleting",
      retention: "delete_requested",
      operationId: input.operationId,
      operationKind: "delete",
      revision: this.record.revision + 1,
      updatedAt: input.now,
    };
    return this.record;
  }

  completeDeletion(
    _scope: RequestScope,
    _threadId: string,
    input: { operationId: string; now: number },
  ): PiSandboxAllocationRecord {
    this.record = {
      ...this.record,
      state: "deleted",
      operationId: null,
      completedDeleteOperationId: input.operationId,
      operationKind: null,
      deletedAt: input.now,
      revision: this.record.revision + 1,
      updatedAt: input.now,
    };
    return this.record;
  }

  failDeletion(): PiSandboxAllocationRecord {
    this.record = {
      ...this.record,
      state: "delete_failed",
      operationId: null,
      operationKind: null,
    };
    return this.record;
  }
}

function allocation(
  source: string,
  allocationRoot: string,
): PiSandboxAllocationRecord {
  const allocationRootPath = path.join(allocationRoot, allocationId);
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId: threadId,
    allocationId,
    executionEnvironmentId: "environment",
    sourceWorkspaceId: "workspace",
    sourceCanonicalPath: source,
    allocationRootPath,
    homePath: path.join(allocationRootPath, "home"),
    workspacePath: path.join(allocationRootPath, "home", "workspace"),
    workspaceAccess: "writable_clone",
    networkProfile: "isolated",
    state: "reserved",
    retention: "active",
    operationId: null,
    completedDeleteOperationId: null,
    operationKind: null,
    diagnosticCode: null,
    sourceHeadOid: null,
    sandboxBranch: null,
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    readyAt: null,
    retainedAt: null,
    deletedAt: null,
  };
}

describe("PiSandboxMaterializer", () => {
  it("prepares a writable home for a read-only non-Git source without copying it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-sandbox-read-only-"));
    roots.push(root);
    const source = path.join(root, "plain-source");
    const allocationRoot = path.join(root, "allocations");
    await mkdir(source);
    await writeFile(path.join(source, "original.txt"), "original\n");
    const record = {
      ...allocation(source, allocationRoot),
      workspaceAccess: "read_only" as const,
    };
    const repository = new FakeRepository(record);
    const materializer = new PiSandboxMaterializer(
      repository as unknown as PiSandboxAllocationRepository,
      {
        allocationRoot,
        now: () => 90,
        commandRunner: async () => {
          throw new Error("git_must_not_run");
        },
      },
    );

    const ready = await materializer.materialize(scope, threadId, {
      expectedRevision: 0,
      operationId,
    });
    expect(ready).toMatchObject({
      state: "ready",
      workspaceAccess: "read_only",
      sourceHeadOid: null,
      sandboxBranch: null,
    });
    await expect(access(ready.workspacePath)).resolves.toBeUndefined();
    await writeFile(path.join(ready.homePath, "notes.txt"), "writable home\n");
    await expect(
      readFile(path.join(ready.homePath, "notes.txt"), "utf8"),
    ).resolves.toBe("writable home\n");
    await expect(
      readFile(path.join(source, "original.txt"), "utf8"),
    ).resolves.toBe("original\n");
    await expect(materializer.inspect(scope, threadId)).rejects.toThrow(
      "sandbox_git_inspection_unavailable",
    );
  });

  it("creates an independent hardened clone on a unique branch and reports Git impact", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pi-sandbox-materializer-"),
    );
    roots.push(root);
    const source = await sourceRepository(root);
    const allocationRoot = path.join(root, "allocations");
    const marker = path.join(root, "malicious-filter-ran");
    const hookMarker = path.join(root, "malicious-hook-ran");
    const hooks = path.join(root, "malicious-hooks");
    const globalConfig = path.join(root, "malicious.gitconfig");
    await mkdir(hooks);
    for (const hook of ["post-checkout", "reference-transaction"]) {
      const hookPath = path.join(hooks, hook);
      await writeFile(hookPath, `#!/bin/sh\ntouch '${hookMarker}'\n`);
      await chmod(hookPath, 0o700);
    }
    execFileSync("git", [
      "config",
      "--file",
      globalConfig,
      "filter.evil.smudge",
      `sh -c 'touch ${marker}; cat'`,
    ]);
    execFileSync("git", [
      "config",
      "--file",
      globalConfig,
      "core.hooksPath",
      hooks,
    ]);
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const repository = new FakeRepository(allocation(source, allocationRoot));
      const sourceBytesBefore = await readFile(
        path.join(source, "payload.txt"),
      );
      const sourceStatusBefore = git(source, "status", "--porcelain=v1");
      const materializer = new PiSandboxMaterializer(
        repository as unknown as PiSandboxAllocationRepository,
        { allocationRoot, now: () => 100 },
      );
      const ready = await materializer.materialize(scope, threadId, {
        expectedRevision: 0,
        operationId,
      });
      expect(ready).toMatchObject({
        state: "ready",
        sandboxBranch: `sedes/sandbox-${allocationId}`,
      });
      expect(
        await readFile(path.join(ready.workspacePath, "payload.txt"), "utf8"),
      ).toBe("payload\n");
      await expect(access(marker)).rejects.toThrow();
      await expect(access(hookMarker)).rejects.toThrow();
      expect(await readFile(path.join(source, "payload.txt"))).toEqual(
        sourceBytesBefore,
      );
      expect(git(source, "status", "--porcelain=v1")).toBe(sourceStatusBefore);

      const oid = git(source, "rev-parse", "HEAD");
      const sourceObject = path.join(
        source,
        ".git",
        "objects",
        oid.slice(0, 2),
        oid.slice(2),
      );
      const cloneObject = path.join(
        ready.workspacePath,
        ".git",
        "objects",
        oid.slice(0, 2),
        oid.slice(2),
      );
      expect((await stat(cloneObject)).ino).not.toBe(
        (await stat(sourceObject)).ino,
      );

      expect(await materializer.inspect(scope, threadId)).toEqual({
        trackedChangeCount: 0,
        untrackedFileCount: 0,
        branch: `sedes/sandbox-${allocationId}`,
        upstream: "origin/main",
        aheadCount: 0,
      });
      const fsmonitorMarker = path.join(root, "clone-fsmonitor-ran");
      const fsmonitor = path.join(root, "malicious-fsmonitor");
      await writeFile(
        fsmonitor,
        `#!/bin/sh\ntouch '${fsmonitorMarker}'\nprintf '\\n'\n`,
      );
      await chmod(fsmonitor, 0o700);
      git(ready.workspacePath, "config", "core.fsmonitor", fsmonitor);
      await materializer.inspect(scope, threadId);
      await expect(access(fsmonitorMarker)).rejects.toThrow();
      await writeFile(
        path.join(ready.workspacePath, "payload.txt"),
        "changed\n",
      );
      await writeFile(path.join(ready.workspacePath, "untracked.txt"), "new\n");
      expect(await materializer.inspect(scope, threadId)).toMatchObject({
        trackedChangeCount: 1,
        untrackedFileCount: 1,
      });
    } finally {
      if (previousGlobalConfig === undefined)
        delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }
  });

  it("removes a partial failed clone without touching sibling allocations", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "pi-sandbox-failed-clone-"),
    );
    roots.push(root);
    const source = await sourceRepository(root);
    const allocationRoot = path.join(root, "allocations");
    const record = allocation(source, allocationRoot);
    const sibling = path.join(allocationRoot, "sibling-allocation");
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(sibling, "preserved.txt"), "preserve\n");
    const repository = new FakeRepository(record);
    const materializer = new PiSandboxMaterializer(
      repository as unknown as PiSandboxAllocationRepository,
      {
        allocationRoot,
        now: () => 150,
        commandRunner: async (_executable, args) => {
          expect(args).toContain("--no-hardlinks");
          await mkdir(record.workspacePath, { recursive: true });
          await writeFile(
            path.join(record.workspacePath, "partial"),
            "partial\n",
          );
          return {
            exitCode: 1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          };
        },
      },
    );

    await expect(
      materializer.materialize(scope, threadId, {
        expectedRevision: 0,
        operationId,
      }),
    ).rejects.toThrow(/clone/i);
    expect(repository.record.state).toBe("materialization_failed");
    await expect(access(record.allocationRootPath)).rejects.toThrow();
    await expect(
      readFile(path.join(sibling, "preserved.txt"), "utf8"),
    ).resolves.toBe("preserve\n");
  });

  it("deletes only the exact allocation and rejects an allocation-root symlink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-sandbox-delete-"));
    roots.push(root);
    const source = await sourceRepository(root);
    const allocationRoot = path.join(root, "allocations");
    const record = allocation(source, allocationRoot);
    const sibling = path.join(allocationRoot, "sibling");
    await mkdir(record.allocationRootPath, { recursive: true });
    await mkdir(sibling);
    const repository = new FakeRepository({
      ...record,
      state: "ready",
      readyAt: 2,
    });
    const materializer = new PiSandboxMaterializer(
      repository as unknown as PiSandboxAllocationRepository,
      { allocationRoot, now: () => 200 },
    );
    const deleted = await materializer.delete(scope, threadId, {
      expectedRevision: 0,
      operationId,
    });
    expect(deleted.state).toBe("deleted");
    await expect(access(record.allocationRootPath)).rejects.toThrow();
    await expect(access(sibling)).resolves.toBeUndefined();

    const external = path.join(root, "external");
    await mkdir(external);
    await symlink(external, record.allocationRootPath);
    repository.record = { ...record, state: "ready", readyAt: 2 };
    await expect(
      materializer.delete(scope, threadId, {
        expectedRevision: 0,
        operationId,
      }),
    ).rejects.toThrow(/symlink/i);
    await expect(access(external)).resolves.toBeUndefined();
  });
});
