import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_FILE_MAX_CONTENT_BYTES,
  WORKSPACE_FILE_MAX_DOWNLOAD_BYTES,
  WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES,
  WORKSPACE_FILE_PRIMARY_ROOT_ID,
  workspaceFileRootIdSchema,
} from "../../src/shared/protocol/workspace-files.js";
import {
  LocalWorkspaceFileProvider,
  type LocalWorkspaceFileProviderTestHooks,
} from "../../src/server/workspace-files/local-workspace-file-provider.js";
import {
  WorkspaceFileAccessError,
  WorkspaceFileCursorInvalidError,
  WorkspaceFileDownloadTooLargeError,
  WorkspaceFileRevisionConflictError,
  WorkspaceFileRootUnavailableError,
  WorkspaceLinkedWorktreeDirtyError,
} from "../../src/server/workspace-files/contracts.js";
import { LocalWorkspaceFileWatcherRegistry } from "../../src/server/workspace-files/local-workspace-file-watcher.js";
import { WorkspaceFilesEngine } from "../../src/server/workspace-files/workspace-files-engine.js";

const execFile = promisify(execFileCallback);
const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const environmentId = "environment-1";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(testHooks?: LocalWorkspaceFileProviderTestHooks) {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-workspace-files-"));
  temporaryDirectories.push(root);
  const workspace = {
    workspaceId: "workspace-1",
    environmentId,
    rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
    canonicalPath: root,
  };
  return {
    root,
    workspace,
    provider: new LocalWorkspaceFileProvider({
      scope,
      environmentId,
      testHooks,
    }),
  };
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87A_SIGNATURE = Buffer.from("GIF87a", "ascii");
const GIF89A_SIGNATURE = Buffer.from("GIF89a", "ascii");
const WEBP_SIGNATURE = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe("LocalWorkspaceFileProvider", () => {
  it("streams exact saved bytes through a descriptor without using preview limits", async () => {
    const current = await fixture();
    const bytes = Buffer.alloc(17 * 1_024 * 1_024 + 37, 0x5a);
    bytes[0] = 0;
    const filename = path.join(current.root, "large-binary.dat");
    await writeFile(filename, bytes);
    const preview = await current.provider.read(
      scope,
      current.workspace,
      "large-binary.dat",
    );
    if (preview.availability !== "available") {
      throw new Error("expected available preview metadata");
    }
    const downloadedHash = createHash("sha256");
    let downloadedBytes = 0;
    const metadata = await current.provider.withDownload(
      scope,
      current.workspace,
      { path: "large-binary.dat", expectedRevision: preview.revision },
      async (source) => {
        expect(source).toMatchObject({
          path: "large-binary.dat",
          fileName: "large-binary.dat",
          sizeBytes: bytes.byteLength,
          revision: preview.revision,
        });
        await source.stream(async (chunk) => {
          downloadedHash.update(chunk);
          downloadedBytes += chunk.byteLength;
        });
        return source;
      },
    );
    expect(metadata.sizeBytes).toBe(bytes.byteLength);
    expect(downloadedBytes).toBe(bytes.byteLength);
    expect(downloadedHash.digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });

  it("requires the displayed revision and rejects target symlinks", async () => {
    const current = await fixture();
    await writeFile(path.join(current.root, "actual.txt"), "saved");
    const read = await current.provider.read(
      scope,
      current.workspace,
      "actual.txt",
    );
    if (read.availability !== "available") throw new Error("expected read");
    await expect(
      current.provider.withDownload(
        scope,
        current.workspace,
        { path: "actual.txt", expectedRevision: "stale-revision" },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceFileRevisionConflictError);
    await symlink("actual.txt", path.join(current.root, "linked.txt"));
    await expect(
      current.provider.withDownload(
        scope,
        current.workspace,
        { path: "linked.txt", expectedRevision: read.revision },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
  });

  it("withholds the final chunk when the opened file changes during download", async () => {
    let filename = "";
    const current = await fixture({
      beforeDownloadFinalValidation: async () => {
        await writeFile(filename, Buffer.alloc(300 * 1_024, 0x62));
      },
    });
    filename = path.join(current.root, "racing.dat");
    await writeFile(filename, Buffer.alloc(300 * 1_024, 0x61));
    const read = await current.provider.read(
      scope,
      current.workspace,
      "racing.dat",
    );
    if (read.availability !== "available") throw new Error("expected read");
    const emitted: Buffer[] = [];
    await expect(
      current.provider.withDownload(
        scope,
        current.workspace,
        { path: "racing.dat", expectedRevision: read.revision },
        async (source) =>
          source.stream(async (chunk) => {
            emitted.push(Buffer.from(chunk));
          }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
    expect(Buffer.concat(emitted).byteLength).toBe(256 * 1_024);
  });

  it("stops a real descriptor stream after cancellation following its first chunk", async () => {
    const current = await fixture();
    const filename = path.join(current.root, "cancelled.dat");
    await writeFile(filename, Buffer.alloc(600 * 1_024, 0x61));
    const read = await current.provider.read(
      scope,
      current.workspace,
      "cancelled.dat",
    );
    if (read.availability !== "available") throw new Error("expected read");
    const providerController = new AbortController();
    const consumerController = new AbortController();
    const reason = new Error("download_cancelled_by_test");
    let emittedBytes = 0;
    await expect(
      current.provider.withDownload(
        scope,
        current.workspace,
        { path: "cancelled.dat", expectedRevision: read.revision },
        async (source) =>
          source.stream(async (chunk) => {
            emittedBytes += chunk.byteLength;
            providerController.abort(reason);
          }, consumerController.signal),
        providerController.signal,
      ),
    ).rejects.toBe(reason);
    expect(consumerController.signal.aborted).toBe(false);
    expect(emittedBytes).toBe(256 * 1_024);
  });

  it("does not release the held final chunk after provider cancellation", async () => {
    const providerController = new AbortController();
    const consumerController = new AbortController();
    const reason = new Error("root_removed_during_final_validation");
    const current = await fixture({
      beforeDownloadFinalValidation: () => {
        providerController.abort(reason);
      },
    });
    const filename = path.join(current.root, "final-cancelled.dat");
    await writeFile(filename, Buffer.alloc(100 * 1_024, 0x61));
    const read = await current.provider.read(
      scope,
      current.workspace,
      "final-cancelled.dat",
    );
    if (read.availability !== "available") throw new Error("expected read");
    let emittedBytes = 0;

    await expect(
      current.provider.withDownload(
        scope,
        current.workspace,
        { path: "final-cancelled.dat", expectedRevision: read.revision },
        async (source) =>
          source.stream(async (chunk) => {
            emittedBytes += chunk.byteLength;
          }, consumerController.signal),
        providerController.signal,
      ),
    ).rejects.toBe(reason);
    expect(consumerController.signal.aborted).toBe(false);
    expect(emittedBytes).toBe(0);
  });

  it("rejects sparse files above the exact download ceiling", async () => {
    const current = await fixture();
    const filename = path.join(current.root, "too-large.dat");
    await writeFile(filename, "");
    await truncate(filename, WORKSPACE_FILE_MAX_DOWNLOAD_BYTES + 1);
    const metadata = await current.provider.read(
      scope,
      current.workspace,
      "too-large.dat",
    );
    if (metadata.availability !== "available") {
      throw new Error("expected metadata");
    }
    await expect(
      current.provider.withDownload(
        scope,
        current.workspace,
        { path: "too-large.dat", expectedRevision: metadata.revision },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceFileDownloadTooLargeError);
  });

  it("honors cancellation for local file and comparison reads", async () => {
    const { provider, workspace } = await fixture();
    const controller = new AbortController();
    const reason = new Error("http_request_closed");
    controller.abort(reason);

    await expect(
      provider.list(scope, workspace, { pageSize: 10 }, controller.signal),
    ).rejects.toBe(reason);
    await expect(
      provider.listDirectory(
        scope,
        workspace,
        { directory: "", pageSize: 10 },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    await expect(
      provider.read(scope, workspace, "note.txt", controller.signal),
    ).rejects.toBe(reason);
    await expect(
      provider.status(scope, workspace, controller.signal),
    ).rejects.toBe(reason);
    await expect(
      provider.diffRepositories(scope, workspace, controller.signal),
    ).rejects.toBe(reason);
    provider.close();
  });

  it("binds repository comparison discovery to the exact principal and root", async () => {
    const current = await fixture();
    await writeFile(path.join(current.root, "tracked.txt"), "one\n");
    await execFile("git", ["init", "-q", current.root]);
    await execFile("git", ["-C", current.root, "config", "user.name", "Test"]);
    await execFile("git", [
      "-C",
      current.root,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await execFile("git", ["-C", current.root, "add", "tracked.txt"]);
    await execFile("git", ["-C", current.root, "commit", "-qm", "initial"]);

    await expect(
      current.provider.diffRepositories(scope, current.workspace),
    ).resolves.toMatchObject({
      status: "available",
      repositories: [
        expect.objectContaining({
          rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
          head: expect.objectContaining({ label: expect.any(String) }),
        }),
      ],
    });
    expect(() =>
      current.provider.diffRepositories(
        { ...scope, principalId: "principal-2" },
        current.workspace,
      ),
    ).toThrow("workspace_file_environment_unavailable");
  });

  it("compares a nested supplemental repository beneath a non-repository Primary", async () => {
    const current = await fixture();
    const directory = path.join(current.root, "repository");
    await mkdir(directory);
    await execFile("git", ["init", "-q", directory]);
    await writeFile(path.join(directory, "tracked.txt"), "before\n");
    await execFile("git", ["-C", directory, "add", "tracked.txt"]);
    await execFile("git", [
      "-C", directory, "-c", "user.name=Test",
      "-c", "user.email=test@example.invalid", "commit", "-qm", "initial",
    ]);
    await writeFile(path.join(directory, "tracked.txt"), "after\n");
    const nested = {
      ...current.workspace,
      rootId: workspaceFileRootIdSchema.parse("nested-repository"),
      canonicalPath: directory,
    };
    await expect(
      current.provider.diffRepositories(scope, current.workspace),
    ).resolves.toEqual({ status: "available", repositories: [] });
    const catalog = await current.provider.diffRepositories(scope, nested);
    if (catalog.status !== "available") throw new Error("repository unavailable");
    const repository = catalog.repositories[0]!;
    expect(repository.rootId).toBe(nested.rootId);
    const refs = await current.provider.diffRefCatalog(scope, nested, {
      repositoryId: repository.repositoryId,
      pageSize: 20,
    });
    if (refs.status !== "available") throw new Error("revisions unavailable");
    const base = refs.revisions.find((revision) => revision.kind === "local_branch")!;
    const created = await current.provider.diffCreateComparison(scope, nested, {
      repositoryId: repository.repositoryId,
      mode: "direct",
      base: { kind: "revision", revisionId: base.revisionId },
      head: { kind: "working_tree" },
    });
    if (created.status !== "available") throw new Error("comparison unavailable");
    const comparison = {
      comparisonId: created.comparison.comparisonId,
      fingerprint: created.comparison.fingerprint,
    };
    const changed = await current.provider.diffChangedFiles(scope, nested, {
      ...comparison,
      pageSize: 20,
    });
    expect(changed).toMatchObject({
      status: "available",
      totalFiles: 1,
      files: [expect.objectContaining({ newPath: "tracked.txt", changeKind: "modified" })],
    });
    if (changed.status !== "available") throw new Error("changed files unavailable");
    await expect(current.provider.diffPatch(scope, nested, {
      ...comparison,
      fileId: changed.files[0]!.fileId,
    })).resolves.toMatchObject({
      status: "available",
      patch: expect.stringContaining("+after"),
    });
    current.provider.close();
  });

  it("keeps list, read, write, and Git status independent per root", async () => {
    const primary = await fixture();
    const supplementalRoot = await mkdtemp(
      path.join(tmpdir(), "sedes-workspace-files-supplemental-"),
    );
    temporaryDirectories.push(supplementalRoot);
    const supplemental = {
      ...primary.workspace,
      rootId: workspaceFileRootIdSchema.parse("supplemental-1"),
      canonicalPath: supplementalRoot,
    };
    await writeFile(path.join(primary.root, "shared.txt"), "primary\n");
    await writeFile(
      path.join(supplementalRoot, "shared.txt"),
      "supplemental\n",
    );
    await writeFile(path.join(supplementalRoot, "extra.txt"), "extra\n");
    await execFile("git", ["init", "-q", primary.root]);

    await expect(
      primary.provider.list(scope, primary.workspace, { pageSize: 20 }),
    ).resolves.toMatchObject({ entries: ["shared.txt"] });
    await expect(
      primary.provider.list(scope, supplemental, { pageSize: 20 }),
    ).resolves.toMatchObject({ entries: ["extra.txt", "shared.txt"] });
    await expect(
      primary.provider.status(scope, primary.workspace),
    ).resolves.toMatchObject({ isGitRepository: true });
    await expect(primary.provider.status(scope, supplemental)).resolves.toEqual(
      {
        availability: "available",
        rootId: workspaceFileRootIdSchema.parse("supplemental-1"),
        isGitRepository: false,
        entries: [],
        truncated: false,
      },
    );

    const [primaryOpened, supplementalOpened] = await Promise.all([
      primary.provider.read(scope, primary.workspace, "shared.txt"),
      primary.provider.read(scope, supplemental, "shared.txt"),
    ]);
    if (
      primaryOpened.availability !== "available" ||
      supplementalOpened.availability !== "available"
    ) {
      throw new Error("expected files");
    }
    await Promise.all([
      primary.provider.write(scope, primary.workspace, {
        path: "shared.txt",
        content: "changed primary\n",
        expectedRevision: primaryOpened.revision,
      }),
      primary.provider.write(scope, supplemental, {
        path: "shared.txt",
        content: "changed supplemental\n",
        expectedRevision: supplementalOpened.revision,
      }),
    ]);
    await expect(
      readFile(path.join(primary.root, "shared.txt"), "utf8"),
    ).resolves.toBe("changed primary\n");
    await expect(
      readFile(path.join(supplementalRoot, "shared.txt"), "utf8"),
    ).resolves.toBe("changed supplemental\n");
  });

  it("resolves only canonical safe regular files beneath the selected root", async () => {
    const current = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "sedes-files-outside-"));
    temporaryDirectories.push(outside);
    await mkdir(path.join(current.root, "src"));
    await writeFile(path.join(current.root, "src", "file.ts"), "safe\n");
    await writeFile(path.join(current.root, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(outside, "outside.ts"), "outside\n");
    await symlink(
      path.join(current.root, "src", "file.ts"),
      path.join(current.root, "file-link.ts"),
    );

    await expect(
      current.provider.resolveFileLink(scope, current.workspace, {
        kind: "absolute",
        path: path.join(current.root, "src", "file.ts"),
      }),
    ).resolves.toBe("src/file.ts");
    await expect(
      current.provider.resolveFileLink(scope, current.workspace, {
        kind: "workspace_relative",
        path: "src/file.ts",
      }),
    ).resolves.toBe("src/file.ts");
    await expect(
      current.provider.resolveFileLink(scope, current.workspace, {
        kind: "root_relative",
        rootId: current.workspace.rootId,
        path: "src/file.ts",
      }),
    ).resolves.toBe("src/file.ts");
    await expect(
      current.provider.resolveFileLink(scope, current.workspace, {
        kind: "root_relative",
        rootId: workspaceFileRootIdSchema.parse("other-root"),
        path: "src/file.ts",
      }),
    ).resolves.toBeUndefined();
    for (const denied of [
      current.root,
      path.join(current.root, ".env"),
      path.join(current.root, "file-link.ts"),
      path.join(outside, "outside.ts"),
      path.join(current.root, "missing.ts"),
    ]) {
      await expect(
        current.provider.resolveFileLink(scope, current.workspace, {
          kind: "absolute",
          path: denied,
        }),
      ).resolves.toBeUndefined();
    }
    for (const denied of ["src", ".env", "file-link.ts", "missing.ts"]) {
      await expect(
        current.provider.resolveFileLink(scope, current.workspace, {
          kind: "workspace_relative",
          path: denied,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("discovers a Git worktree or safe containing directory for absolute files", async () => {
    const current = await fixture();
    await mkdir(path.join(current.root, ".git"));
    await writeFile(path.join(current.root, "README.md"), "root\n");
    const nested = path.join(current.root, "packages", "nested");
    await mkdir(path.join(nested, ".git"), { recursive: true });
    await mkdir(path.join(nested, "src"));
    await writeFile(path.join(nested, "src", "index.ts"), "nested\n");
    await writeFile(path.join(nested, ".git", "config"), "sensitive\n");
    await symlink(
      path.join(nested, "src", "index.ts"),
      path.join(nested, "linked.ts"),
    );
    const outside = await mkdtemp(path.join(tmpdir(), "sedes-no-worktree-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "plain.txt"), "plain\n");

    await expect(
      current.provider.discoverFileLinkRoot(
        scope,
        environmentId,
        path.join(current.root, "README.md"),
      ),
    ).resolves.toEqual({
      canonicalPath: current.root,
      relativePath: "README.md",
    });
    await expect(
      current.provider.discoverFileLinkRoot(
        scope,
        environmentId,
        path.join(nested, "src", "index.ts"),
      ),
    ).resolves.toEqual({
      canonicalPath: nested,
      relativePath: "src/index.ts",
    });
    await expect(
      current.provider.discoverFileLinkRoot(
        scope,
        environmentId,
        path.join(outside, "plain.txt"),
      ),
    ).resolves.toEqual({
      canonicalPath: outside,
      relativePath: "plain.txt",
    });
    for (const denied of [
      nested,
      path.join(nested, ".git", "config"),
      path.join(nested, "linked.ts"),
      path.join(nested, "missing.ts"),
    ]) {
      await expect(
        current.provider.discoverFileLinkRoot(scope, environmentId, denied),
      ).resolves.toBeUndefined();
    }
    await expect(
      current.provider.discoverFileLinkRoot(
        { ...scope, principalId: "other" },
        environmentId,
        path.join(nested, "src", "index.ts"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      current.provider.discoverFileLinkRoot(
        scope,
        "other-environment",
        path.join(nested, "src", "index.ts"),
      ),
    ).resolves.toBeUndefined();
  });

  it("discovers live linked worktrees and preserves a project subdirectory", async () => {
    const current = await fixture();
    const project = path.join(current.root, "packages", "app");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "index.ts"), "main\n");
    await execFile("git", ["init", "-q", current.root]);
    await execFile("git", ["-C", current.root, "config", "user.name", "Test"]);
    await execFile("git", [
      "-C",
      current.root,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await execFile("git", ["-C", current.root, "add", "."]);
    await execFile("git", ["-C", current.root, "commit", "-qm", "initial"]);
    const linked = `${current.root}-linked`;
    temporaryDirectories.push(linked);
    await execFile("git", [
      "-C",
      current.root,
      "worktree",
      "add",
      "-q",
      "-b",
      "feature/linked",
      linked,
    ]);
    const primary = { ...current.workspace, canonicalPath: project };
    const result = await current.provider.discoverLinkedWorktrees(
      scope,
      primary,
    );
    const { stdout: gitDirectory } = await execFile("git", [
      "-C",
      linked,
      "rev-parse",
      "--absolute-git-dir",
    ]);
    expect(result).toEqual({
      worktrees: [
        {
          canonicalPath: path.join(linked, "packages", "app"),
          canonicalCheckoutPath: linked,
          canonicalGitDir: gitDirectory.trim(),
          identityToken: expect.stringMatching(/^[0-9a-f]{64}$/u),
          displayLabel: "feature/linked",
          branchRef: "refs/heads/feature/linked",
          headOid: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
          provenanceKind: "same",
          aheadCount: 0,
          behindCount: 0,
        },
      ],
      truncated: false,
    });

    const discovered = result.worktrees[0]!;
    const dirtyPath = path.join(linked, "untracked.txt");
    await writeFile(dirtyPath, "dirty\n");
    await expect(
      current.provider.removeLinkedWorktree(scope, {
        primaryRoot: primary,
        canonicalCheckoutPath: discovered.canonicalCheckoutPath,
        canonicalGitDir: discovered.canonicalGitDir,
        identityToken: discovered.identityToken,
      }),
    ).rejects.toBeInstanceOf(WorkspaceLinkedWorktreeDirtyError);
    await rm(dirtyPath);
    await current.provider.removeLinkedWorktree(scope, {
      primaryRoot: primary,
      canonicalCheckoutPath: discovered.canonicalCheckoutPath,
      canonicalGitDir: discovered.canonicalGitDir,
      identityToken: discovered.identityToken,
    });
    await expect(
      current.provider.discoverLinkedWorktrees(scope, primary),
    ).resolves.toEqual({ worktrees: [], truncated: false });

    await execFile("git", [
      "-C",
      current.root,
      "worktree",
      "add",
      "-q",
      "--detach",
      linked,
    ]);
    const replacement = await current.provider.discoverLinkedWorktrees(
      scope,
      primary,
    );
    expect(replacement.worktrees[0]).toMatchObject({
      canonicalGitDir: gitDirectory.trim(),
      canonicalPath: path.join(linked, "packages", "app"),
    });
    expect(replacement.worktrees[0]!.identityToken).not.toBe(
      result.worktrees[0]!.identityToken,
    );
  });

  it("applies linked-worktree policy before the discovery limit", async () => {
    const current = await fixture();
    await writeFile(path.join(current.root, "tracked.txt"), "main\n");
    await execFile("git", ["init", "-q", current.root]);
    await execFile("git", ["-C", current.root, "config", "user.name", "Test"]);
    await execFile("git", [
      "-C",
      current.root,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await execFile("git", ["-C", current.root, "add", "."]);
    await execFile("git", ["-C", current.root, "commit", "-qm", "initial"]);
    const container = await mkdtemp(
      path.join(tmpdir(), "sedes-worktree-policy-limit-"),
    );
    temporaryDirectories.push(container);
    for (let index = 0; index < 32; index += 1) {
      await execFile("git", [
        "-C",
        current.root,
        "worktree",
        "add",
        "-q",
        "--detach",
        path.join(container, `outside-${index.toString().padStart(2, "0")}`),
      ]);
    }
    const policy = path.join(container, "policy");
    await mkdir(policy);
    const admitted = path.join(policy, "zz-admitted");
    await execFile("git", [
      "-C",
      current.root,
      "worktree",
      "add",
      "-q",
      "--detach",
      admitted,
    ]);
    const engine = new WorkspaceFilesEngine();
    try {
      await expect(
        engine.discoverLinkedWorktrees(
          { canonicalPath: current.root, operationKey: "policy-limit" },
          undefined,
          [policy],
        ),
      ).resolves.toMatchObject({
        worktrees: [{ canonicalPath: admitted }],
        truncated: false,
      });
    } finally {
      engine.close();
    }
  });

  it("refuses removal when the primary repository is rebound after the clean check", async () => {
    let primaryPath = "";
    let originalPath = "";
    const current = await fixture({
      beforeLinkedWorktreeRemovalIdentityValidation: async () => {
        await rename(primaryPath, originalPath);
        await mkdir(primaryPath);
        await execFile("git", ["init", "-q", primaryPath]);
      },
    });
    primaryPath = current.root;
    originalPath = `${current.root}-original`;
    temporaryDirectories.push(originalPath);
    await writeFile(path.join(current.root, "tracked.txt"), "main\n");
    await execFile("git", ["init", "-q", current.root]);
    await execFile("git", ["-C", current.root, "config", "user.name", "Test"]);
    await execFile("git", [
      "-C",
      current.root,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await execFile("git", ["-C", current.root, "add", "."]);
    await execFile("git", ["-C", current.root, "commit", "-qm", "initial"]);
    const linked = `${current.root}-linked-rebind`;
    temporaryDirectories.push(linked);
    await execFile("git", [
      "-C",
      current.root,
      "worktree",
      "add",
      "-q",
      "--detach",
      linked,
    ]);
    const discovered = (
      await current.provider.discoverLinkedWorktrees(scope, current.workspace)
    ).worktrees[0]!;

    await expect(
      current.provider.removeLinkedWorktree(scope, {
        primaryRoot: current.workspace,
        canonicalCheckoutPath: discovered.canonicalCheckoutPath,
        canonicalGitDir: discovered.canonicalGitDir,
        identityToken: discovered.identityToken,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileRootUnavailableError);
    await expect(
      readFile(path.join(linked, "tracked.txt"), "utf8"),
    ).resolves.toBe("main\n");
  });

  it("revalidates root identity on every operation", async () => {
    const current = await fixture();
    await writeFile(path.join(current.root, "file.txt"), "content\n");
    await expect(
      current.provider.read(scope, current.workspace, "file.txt"),
    ).resolves.toMatchObject({ availability: "available" });
    const moved = `${current.root}-moved`;
    temporaryDirectories.push(moved);
    await rename(current.root, moved);

    await expect(
      current.provider.list(scope, current.workspace, { pageSize: 10 }),
    ).rejects.toBeInstanceOf(WorkspaceFileRootUnavailableError);
    await expect(
      current.provider.resolveFileLink(scope, current.workspace, {
        kind: "absolute",
        path: path.join(current.root, "file.txt"),
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileRootUnavailableError);
  });

  it("keeps content operations available when another root exhausts watch capacity", async () => {
    const current = await fixture();
    const supplementalRoot = await mkdtemp(
      path.join(tmpdir(), "sedes-workspace-files-watched-supplemental-"),
    );
    temporaryDirectories.push(supplementalRoot);
    const supplemental = {
      ...current.workspace,
      rootId: workspaceFileRootIdSchema.parse("supplemental-1"),
      canonicalPath: supplementalRoot,
    };
    await writeFile(path.join(supplementalRoot, "file.txt"), "content\n");
    const watchers = new LocalWorkspaceFileWatcherRegistry({
      maximumActiveRoots: 1,
    });
    const provider = new LocalWorkspaceFileProvider({
      scope,
      environmentId,
      watchers,
    });
    const primarySubscription = await provider.watch(
      scope,
      current.workspace,
      () => undefined,
    );

    await expect(
      provider.watch(scope, supplemental, () => undefined),
    ).rejects.toThrow("workspace_file_watcher_capacity_exceeded");
    await expect(
      provider.read(scope, supplemental, "file.txt"),
    ).resolves.toMatchObject({
      availability: "available",
      content: "content\n",
    });
    primarySubscription.close();
    provider.close();
  });

  it("denies repository metadata and credential files on read and write", async () => {
    const current = await fixture();
    await writeFile(path.join(current.root, "a.ts"), "a\n");
    await writeFile(path.join(current.root, ".git-credentials"), "secret\n");
    await mkdir(path.join(current.root, ".env"), { recursive: true });
    await writeFile(path.join(current.root, ".env", "production"), "TOKEN=1\n");
    await execFile("git", ["init", "-q", current.root]);

    for (const denied of [
      ".git/config",
      ".git/hooks/pre-commit",
      ".git-credentials",
      ".env/production",
    ]) {
      await expect(
        current.provider.read(scope, current.workspace, denied),
      ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
      await expect(
        current.provider.write(scope, current.workspace, {
          path: denied,
          content: "owned\n",
          expectedRevision: "any",
        }),
      ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
    }

    const listed = await current.provider.list(scope, current.workspace, {
      pageSize: 100,
    });
    expect(listed).toMatchObject({ availability: "available" });
    if (listed.availability !== "available") throw new Error("unavailable");
    expect(listed.entries).not.toContain(".git-credentials");
    expect(listed.entries.some((entry) => entry.startsWith(".git/"))).toBe(
      false,
    );
    expect(listed.entries.some((entry) => entry.startsWith(".env/"))).toBe(
      false,
    );
    expect(
      await readFile(path.join(current.root, ".git-credentials"), "utf8"),
    ).toBe("secret\n");
  });

  it("denies orphaned atomic-write temporaries by requested and canonical path", async () => {
    const current = await fixture();
    const temporary =
      ".sedes-edit.txt-11111111-1111-4111-8111-111111111111.tmp";
    await writeFile(path.join(current.root, temporary), "orphaned\n");
    await mkdir(path.join(current.root, "actual"));
    await writeFile(path.join(current.root, "actual", temporary), "orphaned\n");
    await symlink(
      path.join(current.root, "actual"),
      path.join(current.root, "alias"),
    );

    for (const denied of [temporary, `alias/${temporary}`]) {
      await expect(
        current.provider.read(scope, current.workspace, denied),
      ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
      await expect(
        current.provider.write(scope, current.workspace, {
          path: denied,
          content: "replacement\n",
          expectedRevision: "revision",
        }),
      ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
    }
    await execFile("git", ["init", "-q", current.root]);
    const status = await current.provider.status(scope, current.workspace);
    expect(status.availability).toBe("available");
    if (status.availability !== "available") throw new Error("expected status");
    expect(status.entries.map(({ path: entryPath }) => entryPath)).not.toEqual(
      expect.arrayContaining([expect.stringContaining(".sedes-")]),
    );
  });

  it("keeps listing readable subtrees when one directory cannot be opened", async () => {
    const current = await fixture();
    await writeFile(path.join(current.root, "visible.ts"), "a\n");
    await mkdir(path.join(current.root, "locked"), { recursive: true });
    await writeFile(path.join(current.root, "locked", "hidden.ts"), "b\n");
    await chmod(path.join(current.root, "locked"), 0o000);

    try {
      const listed = await current.provider.list(scope, current.workspace, {
        pageSize: 100,
      });
      expect(listed).toMatchObject({ availability: "available" });
      if (listed.availability !== "available") throw new Error("unavailable");
      expect(listed.entries).toContain("visible.ts");
      expect(listed.entries).not.toContain("locked/hidden.ts");
    } finally {
      await chmod(path.join(current.root, "locked"), 0o700);
    }
  });

  it("bounds non-Git traversal depth and reports truncation", async () => {
    const current = await fixture();
    let directory = current.root;
    for (let depth = 0; depth < 66; depth += 1) {
      directory = path.join(directory, "d");
    }
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "too-deep.txt"), "hidden\n");

    const listed = await current.provider.list(scope, current.workspace, {
      pageSize: 100,
    });
    expect(listed).toMatchObject({
      availability: "available",
      entries: [],
      scanTruncated: true,
    });
  });

  it("retains one filesystem snapshot across bounded cursor pages", async () => {
    const current = await fixture();
    await writeFile(path.join(current.root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(current.root, "a.ts"), "a\n");
    await writeFile(path.join(current.root, "b.ts"), "b\n");
    await writeFile(path.join(current.root, "ignored.txt"), "ignored\n");
    await execFile("git", ["init", "-q", current.root]);

    const first = await current.provider.list(scope, current.workspace, {
      pageSize: 1,
    });
    expect(first).toMatchObject({
      availability: "available",
      entries: [".gitignore"],
      scanTruncated: false,
    });
    if (first.availability !== "available" || !first.nextCursor) return;
    await writeFile(path.join(current.root, "aa-added-after-page.ts"), "new\n");
    await expect(
      current.provider.list(scope, current.workspace, {
        pageSize: 10,
        cursor: first.nextCursor,
      }),
    ).resolves.toMatchObject({ entries: ["a.ts", "b.ts", "ignored.txt"] });
  });

  it("lists only immediate directory children and loads descendants on demand", async () => {
    const current = await fixture();
    await mkdir(path.join(current.root, "src", "nested"), { recursive: true });
    await writeFile(path.join(current.root, "README.md"), "read me\n");
    await writeFile(path.join(current.root, "src", "index.ts"), "export {};\n");
    await writeFile(
      path.join(current.root, "src", "nested", "deep.ts"),
      "export {};\n",
    );

    await expect(
      current.provider.listDirectory(scope, current.workspace, {
        directory: "",
        pageSize: 100,
      }),
    ).resolves.toMatchObject({
      availability: "available",
      directory: "",
      entries: [
        { path: "README.md", kind: "file" },
        { path: "src", kind: "directory" },
      ],
    });
    await expect(
      current.provider.listDirectory(scope, current.workspace, {
        directory: "src",
        pageSize: 100,
      }),
    ).resolves.toMatchObject({
      availability: "available",
      directory: "src",
      entries: [
        { path: "src/index.ts", kind: "file" },
        { path: "src/nested", kind: "directory" },
      ],
    });
  });

  it("rejects invalid retained listing cursors with a typed error", async () => {
    const current = await fixture();

    await expect(
      current.provider.list(scope, current.workspace, {
        cursor: "missing-cursor",
        pageSize: 10,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileCursorInvalidError);
    await expect(
      current.provider.listDirectory(scope, current.workspace, {
        directory: "",
        cursor: "missing-cursor",
        pageSize: 10,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileCursorInvalidError);
  });

  it.each(["primary", "supplemental"] as const)(
    "applies containment and sensitivity independently to the %s root",
    async (rootKind) => {
      const current = await fixture();
      const selectedRoot =
        rootKind === "primary"
          ? current.root
          : await mkdtemp(
              path.join(tmpdir(), "sedes-workspace-files-supplemental-policy-"),
            );
      if (rootKind === "supplemental") temporaryDirectories.push(selectedRoot);
      const target =
        rootKind === "primary"
          ? current.workspace
          : {
              ...current.workspace,
              rootId: workspaceFileRootIdSchema.parse("supplemental-policy"),
              canonicalPath: selectedRoot,
            };
      const outside = await mkdtemp(
        path.join(tmpdir(), "sedes-files-outside-"),
      );
      temporaryDirectories.push(outside);
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(
        path.join(outside, "secret.txt"),
        path.join(selectedRoot, "target-link"),
      );
      await symlink(outside, path.join(selectedRoot, "parent-link"));
      await mkdir(path.join(selectedRoot, ".aws"));
      await writeFile(path.join(selectedRoot, ".aws", "credentials"), "key\n");
      await mkdir(path.join(selectedRoot, ".aws", "private"));
      await writeFile(
        path.join(selectedRoot, ".aws", "private", "credentials"),
        "nested key\n",
      );
      await symlink(
        path.join(selectedRoot, ".aws"),
        path.join(selectedRoot, "sensitive-alias"),
        "dir",
      );

      for (const relativePath of [
        "../secret.txt",
        "target-link",
        "parent-link/secret.txt",
        "/etc/passwd",
        "sensitive-alias/credentials",
      ]) {
        await expect(
          current.provider.read(scope, target, relativePath),
        ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
      }

      for (const relativePath of [
        "parent-link/secret.txt",
        "sensitive-alias/credentials",
      ]) {
        await expect(
          current.provider.write(scope, target, {
            path: relativePath,
            content: "escaped",
            expectedRevision: "revision",
          }),
        ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
      }
      await expect(
        current.provider.listDirectory(scope, target, {
          directory: "sensitive-alias/private",
          pageSize: 100,
        }),
      ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
      await expect(
        current.provider.resolveFileLink(scope, target, {
          kind: "absolute",
          path: path.join(outside, "secret.txt"),
        }),
      ).resolves.toBeUndefined();
      await expect(
        readFile(path.join(outside, "secret.txt"), "utf8"),
      ).resolves.toBe("secret");
    },
  );

  it("allows legitimate path components beginning with two dots", async () => {
    const current = await fixture();
    await mkdir(path.join(current.root, "..data"));
    await writeFile(path.join(current.root, "..data", "file.txt"), "before");

    const listed = await current.provider.list(scope, current.workspace, {
      pageSize: 100,
    });
    expect(listed).toMatchObject({ entries: ["..data/file.txt"] });
    const opened = await current.provider.read(
      scope,
      current.workspace,
      "..data/file.txt",
    );
    if (opened.availability !== "available") throw new Error("expected file");
    await current.provider.write(scope, current.workspace, {
      path: "..data/file.txt",
      content: "after",
      expectedRevision: opened.revision,
    });
    await expect(
      readFile(path.join(current.root, "..data", "file.txt"), "utf8"),
    ).resolves.toBe("after");
  });

  it("does not traverse a directory replaced by a symlink during a non-Git scan", async () => {
    const current = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "sedes-files-outside-"));
    temporaryDirectories.push(outside);
    await mkdir(path.join(current.root, "swap"));
    await writeFile(path.join(current.root, "swap", "inside.txt"), "inside");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    let swapped = false;
    const provider = new LocalWorkspaceFileProvider({
      scope,
      environmentId,
      testHooks: {
        beforeWalkDirectoryOpen: async (relativePath) => {
          if (relativePath !== "swap" || swapped) return;
          swapped = true;
          await rename(
            path.join(current.root, "swap"),
            path.join(current.root, "moved"),
          );
          await symlink(outside, path.join(current.root, "swap"), "dir");
        },
      },
    });

    const listed = await provider.list(scope, current.workspace, {
      pageSize: 100,
    });
    expect(swapped).toBe(true);
    expect(listed).toMatchObject({ availability: "available" });
    if (listed.availability !== "available") throw new Error("unavailable");
    expect(listed.entries).not.toContain("swap/secret.txt");
    expect(listed.entries).not.toContain("swap/inside.txt");
    provider.close();
  });

  it("applies the explicit sensitive-file denylist to list and read", async () => {
    const current = await fixture();
    await mkdir(path.join(current.root, ".ssh"));
    await writeFile(path.join(current.root, ".ssh", "config"), "host private");
    await writeFile(path.join(current.root, ".env"), "TOKEN=x");
    await writeFile(path.join(current.root, ".env.local"), "TOKEN=x");
    await writeFile(path.join(current.root, "server.pem"), "private");
    await writeFile(path.join(current.root, ".env.example"), "TOKEN=");
    await writeFile(path.join(current.root, "safe.txt"), "safe");
    await mkdir(path.join(current.root, ".SSH"));
    await writeFile(path.join(current.root, ".SSH", "config"), "private");
    await writeFile(path.join(current.root, ".ENV.Local"), "TOKEN=x");
    await writeFile(path.join(current.root, "ID_RSA"), "private");
    await writeFile(path.join(current.root, "SERVER.PEM"), "private");
    await writeFile(path.join(current.root, ".ENV.Example"), "TOKEN=");

    const listed = await current.provider.list(scope, current.workspace, {
      pageSize: 100,
    });
    expect(listed).toMatchObject({
      entries: [".ENV.Example", ".env.example", "safe.txt"],
    });
    for (const relativePath of [
      ".ssh/config",
      ".SSH/config",
      ".env",
      ".env.local",
      ".ENV.Local",
      "ID_RSA",
      "server.pem",
      "SERVER.PEM",
    ]) {
      await expect(
        current.provider.read(scope, current.workspace, relativePath),
      ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
    }
    await expect(
      current.provider.write(scope, current.workspace, {
        path: ".env",
        content: "TOKEN=replaced",
        expectedRevision: "revision",
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
  });

  it("returns bounded UTF-8 content, binary refusal, and revision changes", async () => {
    const current = await fixture();
    const filename = path.join(current.root, "large.txt");
    await writeFile(
      filename,
      "a".repeat(WORKSPACE_FILE_MAX_CONTENT_BYTES + 20),
    );
    const large = await current.provider.read(
      scope,
      current.workspace,
      "large.txt",
    );
    expect(large).toMatchObject({
      availability: "available",
      contentKind: "text",
      editable: false,
      sizeBytes: WORKSPACE_FILE_MAX_CONTENT_BYTES + 20,
      truncation: {
        truncated: true,
        retainedBytes: WORKSPACE_FILE_MAX_CONTENT_BYTES,
        reason: "byte_limit",
      },
    });

    await writeFile(
      path.join(current.root, "binary.dat"),
      Buffer.from([0, 1, 2]),
    );
    await expect(
      current.provider.read(scope, current.workspace, "binary.dat"),
    ).resolves.toMatchObject({
      contentKind: "binary",
      content: "",
      editable: false,
    });

    await writeFile(filename, "same");
    const before = await current.provider.read(
      scope,
      current.workspace,
      "large.txt",
    );
    await writeFile(filename, "size");
    const after = await current.provider.read(
      scope,
      current.workspace,
      "large.txt",
    );
    expect(before.availability).toBe("available");
    expect(after.availability).toBe("available");
    if (
      before.availability === "available" &&
      after.availability === "available"
    ) {
      expect(after.revision).not.toBe(before.revision);
    }
  });

  it.each([
    ["pixel.PNG", "image/png", PNG_SIGNATURE],
    ["photo.jpg", "image/jpeg", JPEG_SIGNATURE],
    ["photo.JPEG", "image/jpeg", JPEG_SIGNATURE],
    ["legacy.gif", "image/gif", GIF87A_SIGNATURE],
    ["animated.GIF", "image/gif", GIF89A_SIGNATURE],
    ["sample.WebP", "image/webp", WEBP_SIGNATURE],
  ] as const)(
    "previews complete %s bytes only when signature and extension agree",
    async (relativePath, mediaType, signature) => {
      const current = await fixture();
      const bytes = Buffer.concat([signature, Buffer.from("verified-payload")]);
      await writeFile(path.join(current.root, relativePath), bytes);

      const result = await current.provider.read(
        scope,
        current.workspace,
        relativePath,
      );
      expect(result).toMatchObject({
        availability: "available",
        contentKind: "image",
        previewState: "available",
        mediaType,
        contentEncoding: "base64",
        editable: false,
        sizeBytes: bytes.byteLength,
      });
      if (
        result.availability !== "available" ||
        result.contentKind !== "image" ||
        result.previewState !== "available"
      ) {
        throw new Error("expected previewable image");
      }
      expect(Buffer.from(result.content, "base64")).toEqual(bytes);
    },
  );

  it("keeps mismatched, spoofed, truncated, extensionless, and SVG content binary", async () => {
    const current = await fixture();
    const cases = [
      ["png-as.jpg", PNG_SIGNATURE],
      ["jpeg-as.png", JPEG_SIGNATURE],
      ["gif-as.txt", GIF89A_SIGNATURE],
      ["webp-as.bin", WEBP_SIGNATURE],
      ["extensionless", GIF87A_SIGNATURE],
      ["spoof.png", Buffer.from("plain UTF-8 pretending to be PNG")],
      ["spoof.jpeg", Buffer.from("plain UTF-8 pretending to be JPEG")],
      ["truncated.png", PNG_SIGNATURE.subarray(0, PNG_SIGNATURE.length - 1)],
      ["truncated.jpg", JPEG_SIGNATURE.subarray(0, JPEG_SIGNATURE.length - 1)],
      ["spoof.gif", GIF89A_SIGNATURE.subarray(0, GIF89A_SIGNATURE.length - 1)],
      ["spoof.webp", WEBP_SIGNATURE.subarray(0, WEBP_SIGNATURE.length - 1)],
      ["spoofed.svg", Buffer.from("<svg><script>alert(1)</script></svg>")],
    ] as const;

    for (const [relativePath, bytes] of cases) {
      await writeFile(path.join(current.root, relativePath), bytes);
      await expect(
        current.provider.read(scope, current.workspace, relativePath),
      ).resolves.toMatchObject({
        contentKind: "binary",
        content: "",
        editable: false,
      });
    }
  });

  it("returns exact-cap images and a payload-free too-large image state", async () => {
    const current = await fixture();
    const exact = Buffer.alloc(WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES, 0x61);
    PNG_SIGNATURE.copy(exact);
    await writeFile(path.join(current.root, "exact.png"), exact);
    const preview = await current.provider.read(
      scope,
      current.workspace,
      "exact.png",
    );
    if (
      preview.availability !== "available" ||
      preview.contentKind !== "image" ||
      preview.previewState !== "available"
    ) {
      throw new Error("expected exact-limit preview");
    }
    expect(preview.sizeBytes).toBe(WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES);
    const decoded = Buffer.from(preview.content, "base64");
    expect(decoded.byteLength).toBe(exact.byteLength);
    expect(decoded.compare(exact)).toBe(0);

    const oversized = Buffer.alloc(
      WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES + 1,
      0x61,
    );
    PNG_SIGNATURE.copy(oversized);
    await writeFile(path.join(current.root, "oversized.png"), oversized);
    const tooLarge = await current.provider.read(
      scope,
      current.workspace,
      "oversized.png",
    );
    expect(tooLarge).toMatchObject({
      contentKind: "image",
      previewState: "too_large",
      mediaType: "image/png",
      sizeBytes: WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES + 1,
      editable: false,
    });
    expect("content" in tooLarge).toBe(false);
    expect("contentEncoding" in tooLarge).toBe(false);
    expect("truncation" in tooLarge).toBe(false);

    await writeFile(
      path.join(current.root, "oversized-spoof.png"),
      Buffer.alloc(WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES + 1, 0x61),
    );
    await expect(
      current.provider.read(scope, current.workspace, "oversized-spoof.png"),
    ).resolves.toMatchObject({
      contentKind: "binary",
      content: "",
      editable: false,
      truncation: { retainedBytes: 0 },
    });
  });

  it("fails a read when the held descriptor changes after its metadata snapshot", async () => {
    for (const replacement of ["short", "longer contents", "same-size-data"]) {
      let filename = "";
      const current = await fixture({
        afterReadMetadata: async () => {
          const before = await stat(filename);
          await writeFile(filename, replacement);
          // Same-size writes within one filesystem clock tick can retain both
          // timestamps. Make this fixture's metadata change deterministic.
          await utimes(filename, before.atime, new Date(before.mtimeMs + 1_000));
        },
      });
      filename = path.join(current.root, "racing.png");
      await writeFile(
        filename,
        Buffer.concat([PNG_SIGNATURE, Buffer.from("before")]),
      );
      await expect(
        current.provider.read(scope, current.workspace, "racing.png"),
      ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
    }
  });

  it("strips only an incomplete UTF-8 boundary and rejects internal invalid bytes", async () => {
    const current = await fixture();
    const boundary = Buffer.concat([
      Buffer.alloc(WORKSPACE_FILE_MAX_CONTENT_BYTES - 1, 0x61),
      Buffer.from("😀", "utf8"),
      Buffer.from("tail"),
    ]);
    await writeFile(path.join(current.root, "boundary.txt"), boundary);
    await expect(
      current.provider.read(scope, current.workspace, "boundary.txt"),
    ).resolves.toMatchObject({
      contentKind: "text",
      editable: false,
      truncation: {
        retainedBytes: WORKSPACE_FILE_MAX_CONTENT_BYTES - 1,
      },
    });

    const internallyInvalid = Buffer.concat([
      Buffer.from("prefix"),
      Buffer.from([0xff]),
      Buffer.alloc(WORKSPACE_FILE_MAX_CONTENT_BYTES + 20, 0x61),
    ]);
    await writeFile(
      path.join(current.root, "internal-invalid.txt"),
      internallyInvalid,
    );
    await expect(
      current.provider.read(scope, current.workspace, "internal-invalid.txt"),
    ).resolves.toMatchObject({
      contentKind: "binary",
      content: "",
      editable: false,
      truncation: { retainedBytes: 0 },
    });
  });

  it("atomically saves an existing UTF-8 file with revision CAS", async () => {
    const current = await fixture();
    const filename = path.join(current.root, "edit.txt");
    await writeFile(filename, "before");
    const read = await current.provider.read(
      scope,
      current.workspace,
      "edit.txt",
    );
    if (read.availability !== "available") throw new Error("expected file");

    const saved = await current.provider.write(scope, current.workspace, {
      path: "edit.txt",
      content: "after",
      expectedRevision: read.revision,
    });

    expect(saved).toMatchObject({
      availability: "available",
      path: "edit.txt",
      sizeBytes: 5,
      revision: expect.any(String),
    });
    expect(saved.availability === "available" && saved.revision).not.toBe(
      read.revision,
    );
    await expect(readFile(filename, "utf8")).resolves.toBe("after");
  });

  it("never overwrites existing binary or invalid UTF-8 files", async () => {
    const current = await fixture();
    const fixtures = [
      { path: "nul.bin", bytes: Buffer.from([0x61, 0x00, 0x62]) },
      { path: "invalid.bin", bytes: Buffer.from([0xc3, 0x28]) },
    ];

    for (const fixtureFile of fixtures) {
      const filename = path.join(current.root, fixtureFile.path);
      await writeFile(filename, fixtureFile.bytes);
      const read = await current.provider.read(
        scope,
        current.workspace,
        fixtureFile.path,
      );
      if (read.availability !== "available") throw new Error("expected file");
      expect(read).toMatchObject({ contentKind: "binary", editable: false });

      await expect(
        current.provider.write(scope, current.workspace, {
          path: fixtureFile.path,
          content: "replacement text",
          expectedRevision: read.revision,
        }),
      ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
      await expect(readFile(filename)).resolves.toEqual(fixtureFile.bytes);
    }
  });

  it("never overwrites image signatures, raster-name spoofs, or SVG text", async () => {
    const current = await fixture();
    const fixtures = [
      {
        path: "renamed.txt",
        bytes: Buffer.concat([GIF89A_SIGNATURE, Buffer.from("body")]),
      },
      { path: "spoof.png", bytes: Buffer.from("editable-looking UTF-8") },
      { path: "vector.svg", bytes: Buffer.from("<svg><rect /></svg>") },
    ];

    for (const fixtureFile of fixtures) {
      const filename = path.join(current.root, fixtureFile.path);
      await writeFile(filename, fixtureFile.bytes);
      const read = await current.provider.read(
        scope,
        current.workspace,
        fixtureFile.path,
      );
      if (read.availability !== "available") throw new Error("expected file");
      expect(read).toMatchObject({ contentKind: "binary", editable: false });
      await expect(
        current.provider.write(scope, current.workspace, {
          path: fixtureFile.path,
          content: "replacement text",
          expectedRevision: read.revision,
        }),
      ).rejects.toBeInstanceOf(WorkspaceFileAccessError);
      await expect(readFile(filename)).resolves.toEqual(fixtureFile.bytes);
    }
  });

  it("detects rapid same-size rewrites and serializes concurrent saves", async () => {
    const current = await fixture();
    const filename = path.join(current.root, "edit.txt");
    await writeFile(filename, "aaaa");
    const initial = await current.provider.read(
      scope,
      current.workspace,
      "edit.txt",
    );
    if (initial.availability !== "available") throw new Error("expected file");
    await writeFile(filename, "bbbb");
    await expect(
      current.provider.write(scope, current.workspace, {
        path: "edit.txt",
        content: "cccc",
        expectedRevision: initial.revision,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileRevisionConflictError);
    await expect(readFile(filename, "utf8")).resolves.toBe("bbbb");

    const fresh = await current.provider.read(
      scope,
      current.workspace,
      "edit.txt",
    );
    if (fresh.availability !== "available") throw new Error("expected file");
    const attempts = await Promise.allSettled([
      current.provider.write(scope, current.workspace, {
        path: "edit.txt",
        content: "1111",
        expectedRevision: fresh.revision,
      }),
      current.provider.write(scope, current.workspace, {
        path: "edit.txt",
        content: "2222",
        expectedRevision: fresh.revision,
      }),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
  });

  it.each(["ancestor", "descendant"] as const)("serializes saves across Primary and a supplemental %s", async (relationship) => {
    const current = await fixture();
    const projectRoot = path.join(current.root, "project");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "edit.txt"), "before");
    const innerRoot = {
      ...current.workspace,
      rootId: relationship === "ancestor"
        ? WORKSPACE_FILE_PRIMARY_ROOT_ID
        : workspaceFileRootIdSchema.parse("nested-root"),
      canonicalPath: projectRoot,
    };
    const outerRoot = {
      ...current.workspace,
      rootId: relationship === "ancestor"
        ? workspaceFileRootIdSchema.parse("home-root")
        : WORKSPACE_FILE_PRIMARY_ROOT_ID,
    };
    const initial = await current.provider.read(scope, innerRoot, "edit.txt");
    if (initial.availability !== "available") throw new Error("expected file");

    const attempts = await Promise.allSettled([
      current.provider.write(scope, innerRoot, {
        path: "edit.txt",
        content: "primary",
        expectedRevision: initial.revision,
      }),
      current.provider.write(scope, outerRoot, {
        path: "project/edit.txt",
        content: "ancestor",
        expectedRevision: initial.revision,
      }),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    expect(
      attempts.find((attempt) => attempt.status === "rejected"),
    ).toMatchObject({
      reason: expect.any(WorkspaceFileRevisionConflictError),
    });
  });

  it("conflicts without creating or following deleted and symlink-replaced targets", async () => {
    const current = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "sedes-files-outside-"));
    temporaryDirectories.push(outside);
    const filename = path.join(current.root, "edit.txt");
    await writeFile(filename, "before");
    const initial = await current.provider.read(
      scope,
      current.workspace,
      "edit.txt",
    );
    if (initial.availability !== "available") throw new Error("expected file");
    await rm(filename);
    await expect(
      current.provider.write(scope, current.workspace, {
        path: "edit.txt",
        content: "after",
        expectedRevision: initial.revision,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileRevisionConflictError);
    await expect(readFile(filename, "utf8")).rejects.toThrow();

    const outsideFile = path.join(outside, "outside.txt");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, filename);
    await expect(
      current.provider.write(scope, current.workspace, {
        path: "edit.txt",
        content: "escaped",
        expectedRevision: initial.revision,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileRevisionConflictError);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside");
  });

  it("keeps final write commit and cleanup on the held parent descriptor", async () => {
    const current = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "sedes-files-outside-"));
    temporaryDirectories.push(outside);
    await mkdir(path.join(current.root, "sub"));
    await writeFile(path.join(current.root, "sub", "edit.txt"), "before");
    await writeFile(path.join(outside, "edit.txt"), "outside");
    const initial = await current.provider.read(
      scope,
      current.workspace,
      "sub/edit.txt",
    );
    if (initial.availability !== "available") throw new Error("expected file");
    let swapped = false;
    const provider = new LocalWorkspaceFileProvider({
      scope,
      environmentId,
      testHooks: {
        beforeWriteCommit: async () => {
          swapped = true;
          await rename(
            path.join(current.root, "sub"),
            path.join(current.root, "moved"),
          );
          await symlink(outside, path.join(current.root, "sub"), "dir");
        },
      },
    });

    await expect(
      provider.write(scope, current.workspace, {
        path: "sub/edit.txt",
        content: "replacement",
        expectedRevision: initial.revision,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileRevisionConflictError);
    expect(swapped).toBe(true);
    await expect(
      readFile(path.join(outside, "edit.txt"), "utf8"),
    ).resolves.toBe("outside");
    await expect(
      readFile(path.join(current.root, "moved", "edit.txt"), "utf8"),
    ).resolves.toBe("before");
    expect(
      (await readdir(path.join(current.root, "moved"))).some((name) =>
        name.startsWith(".sedes-"),
      ),
    ).toBe(false);
    provider.close();
  });

  it("leaves the original file unchanged when the atomic write cannot start", async () => {
    const current = await fixture();
    const directory = path.join(current.root, "locked");
    await mkdir(directory);
    const filename = path.join(directory, "edit.txt");
    await writeFile(filename, "before");
    const initial = await current.provider.read(
      scope,
      current.workspace,
      "locked/edit.txt",
    );
    if (initial.availability !== "available") throw new Error("expected file");
    await chmod(directory, 0o500);
    try {
      await expect(
        current.provider.write(scope, current.workspace, {
          path: "locked/edit.txt",
          content: "after",
          expectedRevision: initial.revision,
        }),
      ).rejects.toThrow();
      await expect(readFile(filename, "utf8")).resolves.toBe("before");
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("maps git status and reports a truthful non-git capability", async () => {
    const current = await fixture();
    await writeFile(path.join(current.root, "tracked.txt"), "base\n");
    await writeFile(path.join(current.root, "deleted.txt"), "delete\n");
    await execFile("git", ["init", "-q", current.root]);
    await execFile("git", ["-C", current.root, "add", "."]);
    await execFile("git", [
      "-C",
      current.root,
      "-c",
      "user.name=Sedes Test",
      "-c",
      "user.email=harness@example.invalid",
      "commit",
      "-qm",
      "initial",
    ]);
    await writeFile(path.join(current.root, "tracked.txt"), "changed\n");
    await rm(path.join(current.root, "deleted.txt"));
    await writeFile(path.join(current.root, "added.txt"), "added\n");
    await execFile("git", ["-C", current.root, "add", "added.txt"]);
    await writeFile(path.join(current.root, "untracked.txt"), "new\n");

    await expect(
      current.provider.status(scope, current.workspace),
    ).resolves.toMatchObject({
      availability: "available",
      isGitRepository: true,
      entries: [
        { path: "added.txt", status: "added" },
        { path: "deleted.txt", status: "deleted" },
        { path: "tracked.txt", status: "modified" },
        { path: "untracked.txt", status: "untracked" },
      ],
      truncated: false,
    });

    const nonGit = await fixture();
    await expect(
      nonGit.provider.status(scope, nonGit.workspace),
    ).resolves.toEqual({
      availability: "available",
      rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
      isGitRepository: false,
      entries: [],
      truncated: false,
    });
  });

  it("degrades oversized Git output to bounded list and status results", async () => {
    const current = await fixture();
    const filenames = Array.from(
      { length: 8 },
      (_, index) => `long-workspace-file-${index}-for-buffer-coverage.txt`,
    );
    await Promise.all(
      filenames.map((filename) =>
        writeFile(path.join(current.root, filename), "initial\n"),
      ),
    );
    await execFile("git", ["init", "-q", current.root]);
    await execFile("git", ["-C", current.root, "add", "."]);
    await execFile("git", [
      "-C",
      current.root,
      "-c",
      "user.name=Sedes Test",
      "-c",
      "user.email=harness@example.invalid",
      "commit",
      "-qm",
      "initial",
    ]);
    await Promise.all(
      filenames.map((filename) =>
        writeFile(path.join(current.root, filename), "changed\n"),
      ),
    );
    const provider = new LocalWorkspaceFileProvider({
      scope,
      environmentId,
      testHooks: { maximumGitOutputBytes: 64 },
    });

    await expect(
      provider.list(scope, current.workspace, { pageSize: 100 }),
    ).resolves.toMatchObject({
      availability: "available",
      entries: filenames.sort(),
      scanTruncated: false,
    });
    await expect(provider.status(scope, current.workspace)).resolves.toEqual({
      availability: "available",
      rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
      isGitRepository: true,
      entries: [],
      truncated: true,
    });
    provider.close();
  });

  it("rewrites repository-root git paths for a workspace subdirectory", async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), "sedes-workspace-files-repository-"),
    );
    temporaryDirectories.push(repository);
    const root = path.join(repository, "nested", "workspace");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(repository, "outside.txt"), "outside\n");
    await writeFile(path.join(root, "inside.txt"), "inside\n");
    await execFile("git", ["init", "-q", repository]);
    await execFile("git", ["-C", repository, "add", "."]);
    await execFile("git", [
      "-C",
      repository,
      "-c",
      "user.name=Sedes Test",
      "-c",
      "user.email=harness@example.invalid",
      "commit",
      "-qm",
      "initial",
    ]);
    await writeFile(path.join(repository, "outside.txt"), "changed outside\n");
    await writeFile(path.join(root, "inside.txt"), "changed inside\n");
    await writeFile(path.join(root, "untracked.txt"), "new\n");
    const provider = new LocalWorkspaceFileProvider({ scope, environmentId });
    const workspace = {
      workspaceId: "nested-workspace",
      environmentId,
      rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
      canonicalPath: root,
    };

    await expect(
      provider.list(scope, workspace, { pageSize: 20 }),
    ).resolves.toMatchObject({
      entries: ["inside.txt", "untracked.txt"],
    });
    await expect(provider.status(scope, workspace)).resolves.toMatchObject({
      isGitRepository: true,
      entries: [
        { path: "inside.txt", status: "modified" },
        { path: "untracked.txt", status: "untracked" },
      ],
    });
  });

  it("keeps deterministic git pagination while filtering symlinks", async () => {
    const current = await fixture();
    await execFile("git", ["init", "-q", current.root]);
    for (let index = 0; index < 40; index += 1) {
      await writeFile(
        path.join(current.root, `file-${String(index).padStart(3, "0")}.txt`),
        String(index),
      );
    }
    await symlink("file-000.txt", path.join(current.root, "file-015-link.txt"));
    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await current.provider.list(scope, current.workspace, {
        pageSize: 7,
        ...(cursor ? { cursor } : {}),
      });
      if (page.availability !== "available") throw new Error("expected files");
      collected.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    expect(collected).toHaveLength(40);
    expect(new Set(collected).size).toBe(40);
    expect(collected).toEqual([...collected].sort());
    expect(collected).not.toContain("file-015-link.txt");
  });

  it("fails closed for another principal or environment", async () => {
    const current = await fixture();
    await expect(
      current.provider.list(
        { ...scope, principalId: "principal-2" },
        current.workspace,
        { pageSize: 10 },
      ),
    ).rejects.toThrow("workspace_file_environment_unavailable");
    await expect(
      current.provider.list(
        scope,
        { ...current.workspace, environmentId: "environment-2" },
        { pageSize: 10 },
      ),
    ).rejects.toThrow("workspace_file_environment_unavailable");
    await expect(
      current.provider.list(
        scope,
        { ...current.workspace, rootId: "" as never },
        { pageSize: 10 },
      ),
    ).rejects.toThrow("workspace_file_environment_unavailable");
  });
});
