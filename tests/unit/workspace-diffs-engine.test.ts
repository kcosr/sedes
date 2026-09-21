import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_FILE_PRIMARY_ROOT_ID,
} from "../../src/shared/protocol/workspace-files.js";
import {
  compareWorkspaceDiffRevisionDescriptors,
  WorkspaceDiffsEngine,
  type WorkspaceDiffsEngineRoot,
} from "../../src/server/workspace-files/workspace-diffs-engine.js";
import {
  workspaceDiffRevisionIdSchema,
  type WorkspaceDiffRevisionDescriptor,
} from "../../src/shared/protocol/workspace-diffs.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execFile("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Sedes Test",
      GIT_AUTHOR_EMAIL: "harness@example.invalid",
      GIT_COMMITTER_NAME: "Sedes Test",
      GIT_COMMITTER_EMAIL: "harness@example.invalid",
    },
  })).stdout;
}

async function fixture(
  engine = new WorkspaceDiffsEngine(),
): Promise<{
  directory: string;
  engine: WorkspaceDiffsEngine;
  root: WorkspaceDiffsEngineRoot;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-diffs-"));
  temporaryDirectories.push(directory);
  await git(directory, "init", "-q", "-b", "main");
  await writeFile(path.join(directory, "file.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  await writeFile(path.join(directory, ".env"), "SECRET=initial\n");
  await git(directory, "add", "file.txt", ".env");
  await git(directory, "commit", "-qm", "initial");
  const root = {
    canonicalPath: directory,
    durableRootKey: "tenant-1\0principal-1\0workspace-1\0primary",
    operationKey: "tenant-1\0principal-1\0workspace-1\0primary",
    rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
  } as const;
  return { directory, engine, root };
}

async function catalog(current: Awaited<ReturnType<typeof fixture>>) {
  const repositories = await current.engine.repositories(current.root);
  expect(repositories.status).toBe("available");
  if (repositories.status !== "available") throw new Error("repository unavailable");
  const repository = repositories.repositories[0]!;
  const refs = await current.engine.refCatalog(current.root, {
    repositoryId: repository.repositoryId,
    pageSize: 100,
  });
  expect(refs.status).toBe("available");
  if (refs.status !== "available") throw new Error("refs unavailable");
  return { repository, refs: refs.revisions };
}

describe("WorkspaceDiffsEngine", () => {
  it("keeps revision kinds grouped and orders commits newest first", () => {
    const revision = (
      kind: WorkspaceDiffRevisionDescriptor["kind"],
      label: string,
      commitHash: string,
      committedAt?: string,
    ): WorkspaceDiffRevisionDescriptor => ({
      revisionId: workspaceDiffRevisionIdSchema.parse(crypto.randomUUID()),
      kind,
      label,
      commitHash,
      shortHash: commitHash.slice(0, 12),
      ...(committedAt ? { committedAt } : {}),
    });
    const revisions = [
      revision("local_branch", "main", "a".repeat(40)),
      revision("commit", "missing-date", "b".repeat(40)),
      revision("commit", "older", "c".repeat(40), "2026-08-10T12:00:00.000Z"),
      revision("tag", "v1", "d".repeat(40)),
      revision("commit", "newer-z", "e".repeat(40), "2026-08-11T12:00:00.000Z"),
      revision("commit", "newer-a", "f".repeat(40), "2026-08-11T12:00:00.000Z"),
    ];

    expect(revisions.sort(compareWorkspaceDiffRevisionDescriptors).map(
      ({ kind, label }) => `${kind}:${label}`,
    )).toEqual([
      "local_branch:main",
      "tag:v1",
      "commit:newer-a",
      "commit:newer-z",
      "commit:older",
      "commit:missing-date",
    ]);
  });

  it("scopes recent commits to HEAD or a selected branch, with explicit all-branch history", async () => {
    const current = await fixture();
    await git(current.directory, "switch", "-qc", "feature");
    await git(current.directory, "commit", "--allow-empty", "-qm", "feature only");
    const featureHash = (await git(current.directory, "rev-parse", "HEAD")).trim();
    await git(current.directory, "switch", "-q", "main");
    await git(current.directory, "commit", "--allow-empty", "-qm", "main only");
    const { repository, refs } = await catalog(current);
    expect(refs.find((ref) => ref.kind === "local_branch" && ref.isCurrentBranch)?.label).toBe("main");
    expect(refs.filter((ref) => ref.kind === "commit").map((ref) => ref.summary)).toEqual(expect.arrayContaining(["initial", "main only"]));
    expect(refs.some((ref) => ref.kind === "commit" && ref.commitHash === featureHash)).toBe(false);
    const feature = refs.find((ref) => ref.kind === "local_branch" && ref.label === "feature")!;
    const scoped = await current.engine.refCatalog(current.root, { repositoryId: repository.repositoryId, pageSize: 100, history: `revision:${feature.revisionId}` });
    expect(scoped.status).toBe("available");
    if (scoped.status !== "available") throw new Error("history unavailable");
    expect(scoped.revisions.filter((ref) => ref.kind === "commit").map((ref) => ref.summary)).toEqual(expect.arrayContaining(["initial", "feature only"]));
    expect(scoped.revisions.some((ref) => ref.kind === "commit" && ref.summary === "main only")).toBe(false);
    const all = await current.engine.refCatalog(current.root, { repositoryId: repository.repositoryId, pageSize: 100, history: "all" });
    expect(all.status).toBe("available");
    if (all.status !== "available") throw new Error("history unavailable");
    expect(all.revisions.filter((ref) => ref.kind === "commit").map((ref) => ref.summary)).toEqual(expect.arrayContaining(["initial", "main only", "feature only"]));
    await expect(current.engine.refCatalog(current.root, { repositoryId: repository.repositoryId, pageSize: 100, history: "revision:unknown" })).resolves.toEqual({ status: "unavailable", diagnosticCode: "workspace_diff_revision_unavailable" });
  });

  it("isolates history IDs and exposes restart-stable root-scoped repository identity", async () => {
    const engine = new WorkspaceDiffsEngine();
    const first = await fixture(engine);
    const second = await fixture(engine);
    const left = await catalog(first);
    const right = await catalog(second);
    expect(left.repository.repositoryKey).not.toBe(right.repository.repositoryKey);
    const restarted = await catalog({ ...first, engine: new WorkspaceDiffsEngine() });
    expect(restarted.repository.repositoryKey).toBe(left.repository.repositoryKey);
    expect(restarted.repository.repositoryId).not.toBe(left.repository.repositoryId);
    const scoped = await first.engine.refCatalog(first.root, { repositoryId: left.repository.repositoryId, pageSize: 100, history: `revision:${right.refs[0]!.revisionId}` });
    expect(scoped).toEqual({ status: "unavailable", diagnosticCode: "workspace_diff_revision_unavailable" });
    const wrongPrincipal = await first.engine.repositories({ ...first.root, durableRootKey: "tenant-1\0principal-2\0workspace-1\0primary", operationKey: "tenant-1\0principal-2\0workspace-1\0primary" });
    if (wrongPrincipal.status !== "available") throw new Error("repository unavailable");
    expect(wrongPrincipal.repositories[0]!.repositoryKey).not.toBe(left.repository.repositoryKey);
  });

  it("resolves exact named refs and pinned commits outside a bounded catalog without revision expressions", async () => {
    const current = await fixture();
    const initial = (await git(current.directory, "rev-parse", "HEAD")).trim();
    await git(current.directory, "branch", "zzz-old");
    await git(current.directory, "commit", "--allow-empty", "-qm", "new head");
    const { repository } = await catalog(current);
    const resolve = (extra: { resolveCommit?: string; resolveRef?: string }) => current.engine.refCatalog(current.root, { repositoryId: repository.repositoryId, pageSize: 1, ...extra });
    const pinned = await resolve({ resolveCommit: initial });
    expect(pinned).toMatchObject({ status: "available", revisions: [{ kind: "commit", commitHash: initial, summary: "initial" }], truncated: true });
    const named = await resolve({ resolveRef: "refs/heads/zzz-old" });
    expect(named).toMatchObject({ status: "available", revisions: [{ kind: "local_branch", label: "zzz-old", commitHash: initial }], truncated: true });
    await expect(resolve({ resolveRef: "refs/heads/zzz-old~1" })).resolves.toMatchObject({ status: "unavailable" });
    await expect(resolve({ resolveRef: "refs/heads/missing" })).resolves.toMatchObject({ status: "unavailable" });
    await expect(resolve({ resolveCommit: "f".repeat(40) })).resolves.toMatchObject({ status: "unavailable" });
  });

  it("pins the exact ref snapshot when its name disappears before commit peeling", async () => {
    const current = await fixture();
    const original = (await git(current.directory, "rev-parse", "HEAD")).trim();
    await git(current.directory, "branch", "target");
    await git(current.directory, "commit", "--allow-empty", "-qm", "replacement");
    const replacement = (await git(current.directory, "rev-parse", "HEAD")).trim();
    const { repository } = await catalog(current);
    const realGit = (await execFile("which", ["git"], { encoding: "utf8" })).stdout.trim();
    const shimDirectory = path.join(current.directory, "git-shim");
    await mkdir(shimDirectory);
    const shim = path.join(shimDirectory, "git");
    await writeFile(shim, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const git = ${JSON.stringify(realGit)};
const repository = ${JSON.stringify(current.directory)};
const args = process.argv.slice(2);
const result = spawnSync(git, args, { encoding: "utf8" });
if (result.status === 0 && args.includes("show-ref") && args.at(-1) === "refs/heads/target") {
  spawnSync(git, ["-C", repository, "update-ref", "-d", "refs/heads/target"]);
  spawnSync(git, ["-C", repository, "update-ref", "refs/heads/refs/heads/target", ${JSON.stringify(replacement)}]);
}
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`);
    await chmod(shim, 0o700);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${shimDirectory}:${previousPath ?? ""}`;
      const result = await current.engine.refCatalog(current.root, { repositoryId: repository.repositoryId, pageSize: 1, resolveRef: "refs/heads/target" });
      expect(result).toMatchObject({ status: "available", revisions: [{ kind: "local_branch", label: "target", commitHash: original }] });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("keeps a listed revision pinned while resolving a named branch again at its new tip", async () => {
    const current = await fixture();
    const { repository, refs } = await catalog(current);
    const original = refs.find((ref) => ref.isCurrentBranch)!;
    await git(current.directory, "commit", "--allow-empty", "-qm", "advanced branch");
    const resolved = await current.engine.refCatalog(current.root, { repositoryId: repository.repositoryId, pageSize: 100, resolveRef: "refs/heads/main" });
    if (resolved.status !== "available") throw new Error("resolution unavailable");
    const updated = resolved.revisions.find((ref) => ref.kind === "local_branch" && ref.label === "main")!;
    expect(updated.commitHash).not.toBe(original.commitHash);
    const comparison = await current.engine.createComparison(current.root, { repositoryId: repository.repositoryId, mode: "direct", base: { kind: "revision", revisionId: original.revisionId }, head: { kind: "revision", revisionId: updated.revisionId } });
    expect(comparison).toMatchObject({ status: "available", comparison: { base: { commitHash: original.commitHash }, head: { commitHash: updated.commitHash } } });
  });

  it("compares only opaque catalog revisions and returns bounded patches and sides", async () => {
    const current = await fixture();
    await git(current.directory, "switch", "-qc", "feature");
    await writeFile(path.join(current.directory, "file.txt"), "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    await git(current.directory, "commit", "-qam", "feature");
    const { repository, refs } = await catalog(current);
    const main = refs.find((ref) => ref.kind === "local_branch" && ref.label === "main")!;
    const feature = refs.find((ref) => ref.kind === "local_branch" && ref.label === "feature")!;

    const created = await current.engine.createComparison(current.root, {
      repositoryId: repository.repositoryId,
      mode: "direct",
      base: { kind: "revision", revisionId: main.revisionId },
      head: { kind: "revision", revisionId: feature.revisionId },
    });
    expect(created.status).toBe("available");
    if (created.status !== "available") throw new Error("comparison unavailable");
    const changed = await current.engine.changedFiles(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      pageSize: 20,
    });
    expect(changed).toMatchObject({
      status: "available",
      totalFiles: 1,
      files: [{ changeKind: "modified", oldPath: "file.txt", newPath: "file.txt", additions: 1, deletions: 1, binary: false }],
    });
    if (changed.status !== "available") throw new Error("files unavailable");
    const file = changed.files[0]!;
    await expect(current.engine.patch(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      fileId: file.fileId,
    })).resolves.toMatchObject({ status: "available", patch: expect.stringContaining("+TWO") });
    await expect(current.engine.fileContent(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      fileId: file.fileId,
      side: "old",
    })).resolves.toMatchObject({ status: "available", content: expect.stringContaining("two") });

    const forged = await current.engine.createComparison(current.root, {
      repositoryId: repository.repositoryId,
      mode: "direct",
      base: { kind: "revision", revisionId: "main" as never },
      head: { kind: "revision", revisionId: feature.revisionId },
    });
    expect(forged).toEqual({ status: "unavailable", diagnosticCode: "workspace_diff_revision_unavailable" });
  });

  it("includes untracked files with a real patch and invalidates mutable comparisons", async () => {
    const current = await fixture();
    const { repository, refs } = await catalog(current);
    const main = refs.find((ref) => ref.kind === "local_branch" && ref.label === "main")!;
    await writeFile(path.join(current.directory, "new.txt"), "new line\n");
    const created = await current.engine.createComparison(current.root, {
      repositoryId: repository.repositoryId,
      mode: "direct",
      base: { kind: "revision", revisionId: main.revisionId },
      head: { kind: "working_tree" },
    });
    if (created.status !== "available") throw new Error("comparison unavailable");
    const changed = await current.engine.changedFiles(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      pageSize: 20,
    });
    expect(changed).toMatchObject({ status: "available", files: [{ newPath: "new.txt", changeKind: "added" }] });
    if (changed.status !== "available") throw new Error("files unavailable");
    await expect(current.engine.patch(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      fileId: changed.files[0]!.fileId,
    })).resolves.toMatchObject({ status: "available", patch: expect.stringContaining("+new line") });
    const reviewed = await current.engine.validateReviewedFile(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      fileId: changed.files[0]!.fileId,
    });
    expect(reviewed).toMatchObject({
      status: "available",
      file: { path: "new.txt", binary: false, eligible: true },
    });
    await expect(current.engine.validateReviewAnchor(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      fileId: changed.files[0]!.fileId,
      side: "new",
      startLine: 1,
      endLine: 1,
    })).resolves.toMatchObject({
      status: "available",
      anchor: { oldContentId: null, selectedText: "new line" },
    });
    await expect(current.engine.reviewRepositoryIdentity(current.root, {
      repositoryId: repository.repositoryId,
    })).resolves.toMatchObject({
      status: "available",
      repositoryKey: reviewed.status === "available"
        ? reviewed.file.repositoryKey
        : expect.any(String),
    });

    await writeFile(path.join(current.directory, "new.txt"), "changed again\n");
    await expect(current.engine.changedFiles(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      pageSize: 20,
    })).resolves.toMatchObject({ status: "stale" });
  });

  it("filters a nested authorized root and denies sensitive old and new paths", async () => {
    const current = await fixture();
    await mkdir(path.join(current.directory, "packages", "app"), { recursive: true });
    await writeFile(path.join(current.directory, "packages", "app", "safe.ts"), "old\n");
    await git(current.directory, "add", ".");
    await git(current.directory, "commit", "-qm", "nested base");
    await writeFile(path.join(current.directory, "packages", "app", "safe.ts"), "new\n");
    await writeFile(path.join(current.directory, "file.txt"), "outside\n");
    await writeFile(path.join(current.directory, ".env"), "SECRET=changed\n");
    const nestedRoot = {
      ...current.root,
      canonicalPath: path.join(current.directory, "packages", "app"),
      durableRootKey: `${current.root.durableRootKey}\0nested`,
      operationKey: `${current.root.operationKey}\0nested`,
    };
    const nested = { ...current, root: nestedRoot };
    const { repository, refs } = await catalog(nested);
    const head = refs.find((ref) => ref.kind === "local_branch" && ref.label === "main")!;
    const created = await nested.engine.createComparison(nested.root, {
      repositoryId: repository.repositoryId,
      mode: "direct",
      base: { kind: "revision", revisionId: head.revisionId },
      head: { kind: "working_tree" },
    });
    if (created.status !== "available") throw new Error("comparison unavailable");
    const changed = await nested.engine.changedFiles(nested.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      pageSize: 20,
    });
    expect(changed).toMatchObject({ status: "available", files: [{ oldPath: "safe.ts", newPath: "safe.ts" }] });
    if (changed.status === "available") expect(changed.files).toHaveLength(1);
  });

  it("distinguishes feature changes from direct differences between diverged branch tips", async () => {
    const current = await fixture();
    const ancestor = (await git(current.directory, "rev-parse", "HEAD")).trim();
    await git(current.directory, "switch", "-qc", "feature");
    await writeFile(path.join(current.directory, "feature.txt"), "feature only\n");
    await git(current.directory, "add", "feature.txt");
    await git(current.directory, "commit", "-qm", "feature work");
    await git(current.directory, "switch", "-q", "main");
    await writeFile(path.join(current.directory, "main.txt"), "main only\n");
    await git(current.directory, "add", "main.txt");
    await git(current.directory, "commit", "-qm", "main work");
    const { repository, refs } = await catalog(current);
    const main = refs.find((ref) => ref.kind === "local_branch" && ref.label === "main")!;
    const feature = refs.find((ref) => ref.kind === "local_branch" && ref.label === "feature")!;
    const compare = async (mode: "direct" | "merge_base") => {
      const created = await current.engine.createComparison(current.root, { repositoryId: repository.repositoryId, mode, base: { kind: "revision", revisionId: main.revisionId }, head: { kind: "revision", revisionId: feature.revisionId } });
      if (created.status !== "available") throw new Error("comparison unavailable");
      const changed = await current.engine.changedFiles(current.root, { comparisonId: created.comparison.comparisonId, fingerprint: created.comparison.fingerprint, pageSize: 20 });
      if (changed.status !== "available") throw new Error("files unavailable");
      return { comparison: created.comparison, files: changed.files };
    };
    const direct = await compare("direct");
    expect(direct.files.map((file) => [file.changeKind, file.newPath ?? file.oldPath])).toEqual([["added", "feature.txt"], ["deleted", "main.txt"]]);
    const review = await compare("merge_base");
    expect(review.comparison.mergeBaseCommitHash).toBe(ancestor);
    expect(review.files.map((file) => [file.changeKind, file.newPath ?? file.oldPath])).toEqual([["added", "feature.txt"]]);
  });

  it("requires immutable revisions for merge-base and anchors only displayed hunk lines", async () => {
    const current = await fixture();
    const { repository, refs } = await catalog(current);
    const main = refs.find((ref) => ref.kind === "local_branch" && ref.label === "main")!;
    await writeFile(path.join(current.directory, "file.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    const rejected = await current.engine.createComparison(current.root, {
      repositoryId: repository.repositoryId,
      mode: "merge_base",
      base: { kind: "revision", revisionId: main.revisionId },
      head: { kind: "working_tree" },
    });
    expect(rejected).toEqual({ status: "unavailable", diagnosticCode: "workspace_diff_merge_base_unavailable" });

    const created = await current.engine.createComparison(current.root, {
      repositoryId: repository.repositoryId,
      mode: "direct",
      base: { kind: "revision", revisionId: main.revisionId },
      head: { kind: "working_tree" },
    });
    if (created.status !== "available") throw new Error("comparison unavailable");
    const changed = await current.engine.changedFiles(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      pageSize: 20,
    });
    if (changed.status !== "available") throw new Error("files unavailable");
    const request = {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      fileId: changed.files[0]!.fileId,
      side: "new" as const,
    };
    await expect(current.engine.validateReviewAnchor(current.root, {
      ...request, startLine: 1, endLine: 1,
    })).resolves.toMatchObject({
      status: "available",
      anchor: { selectedText: "ONE", oldPath: "file.txt", newPath: "file.txt" },
    });
    await expect(current.engine.validateReviewAnchor(current.root, {
      ...request, startLine: 10, endLine: 10,
    })).resolves.toEqual({ status: "line_unavailable" });
    await expect(current.engine.validateReviewAnchor(current.root, {
      ...request,
      startLine: 1,
      endLine: 1 + 500,
    })).resolves.toEqual({ status: "line_unavailable" });
  });

  it("reports tracked binary files truthfully and disables configured diff programs", async () => {
    const current = await fixture();
    const marker = path.join(current.directory, "external-diff-ran");
    const external = path.join(current.directory, "external-diff.sh");
    await writeFile(external, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    await git(current.directory, "config", "diff.external", external);
    await git(current.directory, "switch", "-qc", "binary");
    await writeFile(path.join(current.directory, "asset.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(current.directory, ".env"), "SECRET=changed\n");
    await git(current.directory, "add", "asset.bin", ".env");
    await git(current.directory, "commit", "-qm", "binary and sensitive");
    const { repository, refs } = await catalog(current);
    const main = refs.find((ref) => ref.kind === "local_branch" && ref.label === "main")!;
    const binary = refs.find((ref) => ref.kind === "local_branch" && ref.label === "binary")!;
    const created = await current.engine.createComparison(current.root, {
      repositoryId: repository.repositoryId,
      mode: "direct",
      base: { kind: "revision", revisionId: main.revisionId },
      head: { kind: "revision", revisionId: binary.revisionId },
    });
    if (created.status !== "available") throw new Error("comparison unavailable");
    const changed = await current.engine.changedFiles(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      pageSize: 20,
    });
    expect(changed).toMatchObject({
      status: "available",
      files: [{ newPath: "asset.bin", changeKind: "added", binary: true }],
    });
    if (changed.status !== "available") throw new Error("files unavailable");
    expect(changed.files).toHaveLength(1);
    await expect(current.engine.patch(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      fileId: changed.files[0]!.fileId,
    })).resolves.toEqual({ status: "binary" });
    await expect(current.engine.fileContent(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      fileId: changed.files[0]!.fileId,
      side: "new",
    })).resolves.toEqual({ status: "binary" });
    await expect(access(marker)).rejects.toThrow();
  });

  it("cancels Git subprocesses through the optional request signal", async () => {
    const current = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(current.engine.repositories(current.root, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("anchors the present old side of a deleted file with a null new content identity", async () => {
    const current = await fixture();
    const { repository, refs } = await catalog(current);
    const main = refs.find((ref) =>
      ref.kind === "local_branch" && ref.label === "main"
    )!;
    await git(current.directory, "switch", "-qc", "deleted");
    await git(current.directory, "rm", "file.txt");
    await git(current.directory, "commit", "-qm", "delete file");
    const refreshed = await current.engine.refCatalog(current.root, {
      repositoryId: repository.repositoryId,
      pageSize: 100,
    });
    if (refreshed.status !== "available") throw new Error("refs unavailable");
    const deleted = refreshed.revisions.find((ref) =>
      ref.kind === "local_branch" && ref.label === "deleted"
    )!;
    const created = await current.engine.createComparison(current.root, {
      repositoryId: repository.repositoryId,
      mode: "direct",
      base: { kind: "revision", revisionId: main.revisionId },
      head: { kind: "revision", revisionId: deleted.revisionId },
    });
    if (created.status !== "available") throw new Error("comparison unavailable");
    const changed = await current.engine.changedFiles(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      pageSize: 20,
    });
    if (changed.status !== "available") throw new Error("files unavailable");
    await expect(current.engine.validateReviewAnchor(current.root, {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
      fileId: changed.files[0]!.fileId,
      side: "old",
      startLine: 1,
      endLine: 1,
    })).resolves.toMatchObject({
      status: "available",
      anchor: {
        oldPath: "file.txt",
        newContentId: null,
        selectedText: "one",
      },
    });
  });

  it("keeps review identities stable across a reopened runtime root", async () => {
    const current = await fixture();
    const { repository, refs } = await catalog(current);
    const main = refs.find((ref) =>
      ref.kind === "local_branch" && ref.label === "main"
    )!;
    await writeFile(path.join(current.directory, "file.txt"), "changed\n");
    const create = async (root: WorkspaceDiffsEngineRoot) => {
      const repositories = await current.engine.repositories(root);
      expect(repositories.status).toBe("available");
      if (repositories.status !== "available") throw new Error("repository unavailable");
      const reopenedRepository = repositories.repositories[0]!;
      const refreshed = await current.engine.refCatalog(root, {
        repositoryId: reopenedRepository.repositoryId,
        pageSize: 100,
      });
      expect(refreshed.status).toBe("available");
      if (refreshed.status !== "available") throw new Error("refs unavailable");
      const reopenedMain = refreshed.revisions.find((ref) =>
        ref.kind === "local_branch" && ref.label === "main"
      )!;
      const created = await current.engine.createComparison(root, {
        repositoryId: reopenedRepository.repositoryId,
        mode: "direct",
        base: { kind: "revision", revisionId: reopenedMain.revisionId },
        head: { kind: "working_tree" },
      });
      expect(created.status).toBe("available");
      if (created.status !== "available") throw new Error("comparison unavailable");
      const changed = await current.engine.changedFiles(root, {
        comparisonId: created.comparison.comparisonId,
        fingerprint: created.comparison.fingerprint,
        pageSize: 20,
      });
      expect(changed.status).toBe("available");
      if (changed.status !== "available") throw new Error("files unavailable");
      const fileId = changed.files[0]!.fileId;
      const reviewed = await current.engine.validateReviewedFile(root, {
        comparisonId: created.comparison.comparisonId,
        fingerprint: created.comparison.fingerprint,
        fileId,
      });
      expect(reviewed.status).toBe("available");
      if (reviewed.status !== "available") throw new Error("reviewed file unavailable");
      const identity = await current.engine.reviewIdentity(root, {
        comparisonId: created.comparison.comparisonId,
        fingerprint: created.comparison.fingerprint,
      });
      expect(identity.status).toBe("available");
      if (identity.status !== "available") throw new Error("identity unavailable");
      return {
        comparison: created.comparison,
        reviewed: reviewed.file,
        identity: identity.identity,
        repositoryId: reopenedRepository.repositoryId,
      };
    };

    const first = await create(current.root);
    expect(first.repositoryId).toBe(repository.repositoryId);
    const reopenedRoot = {
      ...current.root,
      operationKey: `${current.root.operationKey}\0reopened`,
    };
    const reopened = await create(reopenedRoot);

    expect(reopened.comparison.fingerprint).toBe(first.comparison.fingerprint);
    expect(reopened.reviewed.repositoryKey).toBe(first.reviewed.repositoryKey);
    expect(reopened.reviewed.reviewFileIdentity).toBe(
      first.reviewed.reviewFileIdentity,
    );
    expect(reopened.identity).toEqual(first.identity);
  });

  it("deduplicates a live identical comparison and expires its opaque cursors after idle TTL", async () => {
    let now = 1_000;
    const current = await fixture(new WorkspaceDiffsEngine({
      testHooks: {
        clock: () => now,
        comparisonIdleTtlMs: 100,
      },
    }));
    const { repository, refs } = await catalog(current);
    const main = refs.find((ref) =>
      ref.kind === "local_branch" && ref.label === "main"
    )!;
    await writeFile(path.join(current.directory, "file.txt"), "changed\n");
    const request = {
      repositoryId: repository.repositoryId,
      mode: "direct" as const,
      base: { kind: "revision" as const, revisionId: main.revisionId },
      head: { kind: "working_tree" as const },
    };
    const first = await current.engine.createComparison(current.root, request);
    const duplicate = await current.engine.createComparison(current.root, request);
    expect(duplicate).toEqual(first);
    if (first.status !== "available") throw new Error("comparison unavailable");
    const files = await current.engine.changedFiles(current.root, {
      comparisonId: first.comparison.comparisonId,
      fingerprint: first.comparison.fingerprint,
      pageSize: 1,
    });
    if (files.status !== "available") throw new Error("files unavailable");
    const fileId = files.files[0]!.fileId;

    now += 100;
    await expect(current.engine.patch(current.root, {
      comparisonId: first.comparison.comparisonId,
      fingerprint: first.comparison.fingerprint,
      fileId,
    })).resolves.toEqual({
      status: "unavailable",
      diagnosticCode: "workspace_diff_comparison_unavailable",
    });
  });

  it("evicts the least-recently-used comparison at the live cap", async () => {
    let now = 1_000;
    const current = await fixture(new WorkspaceDiffsEngine({
      testHooks: {
        clock: () => now,
        maximumComparisons: 2,
      },
    }));
    const { repository, refs } = await catalog(current);
    const main = refs.find((ref) =>
      ref.kind === "local_branch" && ref.label === "main"
    )!;
    const create = async (
      base: { kind: "revision"; revisionId: typeof main.revisionId } | { kind: "index" },
      head: { kind: "index" } | { kind: "working_tree" },
    ) => current.engine.createComparison(current.root, {
      repositoryId: repository.repositoryId,
      mode: "direct",
      base,
      head,
    });
    const first = await create(
      { kind: "revision", revisionId: main.revisionId },
      { kind: "index" },
    );
    now += 1;
    await writeFile(path.join(current.directory, "file.txt"), "changed\n");
    const second = await create(
      { kind: "revision", revisionId: main.revisionId },
      { kind: "working_tree" },
    );
    if (first.status !== "available" || second.status !== "available") {
      throw new Error("comparison unavailable");
    }
    const secondFiles = await current.engine.changedFiles(current.root, {
      comparisonId: second.comparison.comparisonId,
      fingerprint: second.comparison.fingerprint,
      pageSize: 20,
    });
    if (secondFiles.status !== "available") throw new Error("files unavailable");
    now += 1;
    await current.engine.changedFiles(current.root, {
      comparisonId: first.comparison.comparisonId,
      fingerprint: first.comparison.fingerprint,
      pageSize: 20,
    });
    now += 1;
    const third = await create({ kind: "index" }, { kind: "working_tree" });
    expect(third.status).toBe("available");

    await expect(current.engine.patch(current.root, {
      comparisonId: second.comparison.comparisonId,
      fingerprint: second.comparison.fingerprint,
      fileId: secondFiles.files[0]!.fileId,
    })).resolves.toEqual({
      status: "unavailable",
      diagnosticCode: "workspace_diff_comparison_unavailable",
    });
    await expect(current.engine.changedFiles(current.root, {
      comparisonId: first.comparison.comparisonId,
      fingerprint: first.comparison.fingerprint,
      pageSize: 20,
    })).resolves.toMatchObject({ status: "available" });
  });
});
