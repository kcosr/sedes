import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { WorkspaceFileAccessError } from "../../src/server/workspace-files/contracts.js";
import { WorkspaceFilesEngine } from "../../src/server/workspace-files/workspace-files-engine.js";
import { WorkspaceDiffsEngine } from "../../src/server/workspace-files/workspace-diffs-engine.js";
import { WORKSPACE_FILE_PRIMARY_ROOT_ID } from "../../src/shared/protocol/workspace-files.js";

const execFile = promisify(execFileCallback);

it.skipIf(process.platform !== "win32")(
  "refuses native final-file symlinks for Files reads, downloads, and links",
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sedes-windows-links-"),
    );
    const root = await realpath(directory);
    const files = new WorkspaceFilesEngine();
    try {
      const target = { canonicalPath: root, operationKey: "native-links" };
      await writeFile(path.join(root, "actual.txt"), "saved");
      await symlink("actual.txt", path.join(root, "linked.txt"), "file");
      const actual = await files.read(target, "actual.txt");
      await expect(files.read(target, "linked.txt")).rejects.toBeInstanceOf(
        WorkspaceFileAccessError,
      );
      await expect(
        files.withDownload(
          target,
          { path: "linked.txt", expectedRevision: actual.revision },
          async () => undefined,
        ),
      ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
      await expect(
        files.resolveFileLink(target, {
          kind: "workspace_relative", path: "linked.txt",
        }),
      ).resolves.toBeUndefined();
      await expect(
        files.discoverFileLinkRoot(path.join(root, "linked.txt")),
      ).resolves.toBeUndefined();
    } finally {
      files.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "discovers, compares, and removes a native Git worktree with system checkout settings",
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sedes-windows-worktrees-"),
    );
    const root = await realpath(directory);
    const linked = `${root}-linked`;
    const files = new WorkspaceFilesEngine();
    try {
      const primary = path.join(root, "project");
      await mkdir(primary);
      await writeFile(path.join(primary, "tracked.txt"), "tracked\n");
      await execFile("git", ["-C", root, "init", "-q"]);
      await execFile("git", ["-C", root, "add", "."]);
      await execFile("git", [
        "-C", root, "-c", "user.name=Test", "-c",
        "user.email=test@example.invalid", "commit", "-qm", "initial",
      ]);
      await execFile("git", [
        "-C", root, "worktree", "add", "-q", "--detach", linked,
      ]);
      const { stdout: nativeStatus } = await execFile("git", [
        "-C", linked, "status", "--porcelain=v1",
      ]);
      expect(nativeStatus).toBe("");
      const primaryRoot = {
        canonicalPath: primary, operationKey: "native-worktrees",
      };
      const discovered = await files.discoverLinkedWorktrees(primaryRoot);
      expect(discovered).toMatchObject({
        truncated: false,
        worktrees: [{
          canonicalPath: path.join(linked, "project"),
          canonicalCheckoutPath: linked,
        }],
      });
      const worktree = discovered.worktrees[0]!;
      const diffs = new WorkspaceDiffsEngine();
      const diffRoot = {
        canonicalPath: worktree.canonicalPath,
        operationKey: "native-compare",
        durableRootKey: "native-compare",
        rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
      };
      const repositories = await diffs.repositories(diffRoot);
      if (repositories.status !== "available") throw new Error("repository unavailable");
      const repository = repositories.repositories[0]!;
      const refs = await diffs.refCatalog(diffRoot, {
        repositoryId: repository.repositoryId, pageSize: 100,
      });
      if (refs.status !== "available") throw new Error("refs unavailable");
      const revision = refs.revisions.find((item) => item.kind === "commit")!;
      const compare = async () => {
        const created = await diffs.createComparison(diffRoot, {
          repositoryId: repository.repositoryId,
          mode: "direct",
          base: { kind: "revision", revisionId: revision.revisionId },
          head: { kind: "working_tree" },
        });
        if (created.status !== "available") throw new Error("comparison unavailable");
        const identity = {
          comparisonId: created.comparison.comparisonId,
          fingerprint: created.comparison.fingerprint,
        };
        const changed = await diffs.changedFiles(diffRoot, { ...identity, pageSize: 100 });
        return { identity, changed };
      };
      // A native CRLF checkout must remain clean in Compare. Suppressing the
      // system autocrlf setting would falsely report the tracked file changed.
      expect((await compare()).changed).toMatchObject({
        status: "available", totalFiles: 0, files: [],
      });
      await writeFile(path.join(worktree.canonicalPath, "tracked.txt"), "changed\r\n");
      const edited = await compare();
      expect(edited.changed).toMatchObject({
        status: "available", totalFiles: 1,
        files: [{ newPath: "tracked.txt", changeKind: "modified" }],
      });
      if (edited.changed.status !== "available") throw new Error("files unavailable");
      await expect(diffs.patch(diffRoot, {
        ...edited.identity, fileId: edited.changed.files[0]!.fileId,
      })).resolves.toMatchObject({
        status: "available", patch: expect.stringContaining("+changed"),
      });
      await execFile("git", ["-C", linked, "checkout", "--", "project/tracked.txt"]);
      await files.removeLinkedWorktree(primaryRoot, {
        canonicalCheckoutPath: worktree.canonicalCheckoutPath,
        canonicalGitDir: worktree.canonicalGitDir,
        identityToken: worktree.identityToken,
      });
      await expect(realpath(linked)).rejects.toThrow();
    } finally {
      files.close();
      await rm(linked, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
