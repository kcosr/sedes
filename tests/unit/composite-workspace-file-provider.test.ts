import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_FILE_PRIMARY_ROOT_ID } from "../../src/shared/protocol/workspace-files.js";
import { CompositeWorkspaceFileProvider } from "../../src/server/workspace-files/composite-workspace-file-provider.js";
import {
  UnsupportedWorkspaceFileProvider,
  type WorkspaceFileProvider,
} from "../../src/server/workspace-files/contracts.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const workspace = {
  workspaceId: "workspace-1",
  environmentId: "environment-1",
  rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
  canonicalPath: "/workspace",
};

describe("CompositeWorkspaceFileProvider", () => {
  it("updates live routing without accepting another principal's changes", () => {
    const composite = new CompositeWorkspaceFileProvider({
      scope,
      providers: new Map(),
    });
    const first = {
      supportsPrimaryRoot: vi.fn(() => true),
    } as unknown as WorkspaceFileProvider;
    const next = {
      supportsPrimaryRoot: vi.fn(() => false),
    } as unknown as WorkspaceFileProvider;
    composite.set(scope, "env", first);
    expect(composite.supportsPrimaryRoot(scope, "env")).toBe(true);
    composite.set(scope, "env", next);
    expect(composite.supportsPrimaryRoot(scope, "env")).toBe(false);
    expect(first.supportsPrimaryRoot).toHaveBeenCalledOnce();
    expect(next.supportsPrimaryRoot).toHaveBeenCalledOnce();
    const foreign = { ...scope, principalId: "foreign" };
    expect(() => composite.set(foreign, "env", first)).toThrow(
      "workspace_file_environment_unavailable",
    );
    expect(() => composite.remove(foreign, "env")).toThrow(
      "workspace_file_environment_unavailable",
    );
    composite.remove(scope, "env");
    expect(() => composite.supportsPrimaryRoot(scope, "env")).toThrow(
      "workspace_file_environment_unavailable",
    );
  });

  it("routes only by the exact principal-scoped environment ID", async () => {
    const selected: WorkspaceFileProvider = {
      supportsPrimaryRoot: vi.fn(() => true),
      supportsSupplementalRoots: vi.fn(() => true),
      supportsFileLinkRootDiscovery: vi.fn(() => true),
      supportsWatching: vi.fn(() => true),
      validateRoot: vi.fn(async () => undefined),
      discoverFileLinkRoot: vi.fn(async () => ({
        canonicalPath: "/workspace",
        relativePath: "file.txt",
      })),
      discoverLinkedWorktrees: vi.fn(async () => ({
        worktrees: [],
        truncated: false,
      })),
      removeLinkedWorktree: vi.fn(async () => undefined),
      resolveFileLink: vi.fn(async () => "file.txt"),
      list: vi.fn(async () => ({
        availability: "available" as const,
        rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
        entries: [],
        scanTruncated: false,
      })),
      listDirectory: vi.fn(async (_scope, root, query) => ({
        availability: "available" as const,
        rootId: root.rootId,
        directory: query.directory,
        entries: [],
        scanTruncated: false,
      })),
      read: vi.fn(),
      withDownload: vi.fn(async (_scope, _root, input, operation) =>
        operation({
          path: input.path,
          fileName: "file.txt",
          sizeBytes: 0,
          revision: input.expectedRevision,
          stream: async () => undefined,
        }),
      ),
      write: vi.fn(),
      status: vi.fn(),
      diffRepositories: vi.fn(async () => ({
        status: "unavailable" as const,
        diagnosticCode: "workspace_diff_unavailable",
      })),
      diffRefCatalog: vi.fn(async () => ({
        status: "unavailable" as const,
        diagnosticCode: "workspace_diff_unavailable",
      })),
      diffCreateComparison: vi.fn(async () => ({
        status: "unavailable" as const,
        diagnosticCode: "workspace_diff_unavailable",
      })),
      diffChangedFiles: vi.fn(async () => ({
        status: "unavailable" as const,
        diagnosticCode: "workspace_diff_unavailable",
      })),
      diffPatch: vi.fn(async () => ({
        status: "unavailable" as const,
        diagnosticCode: "workspace_diff_unavailable",
      })),
      diffFileContent: vi.fn(async () => ({
        status: "unavailable" as const,
        diagnosticCode: "workspace_diff_unavailable",
      })),
      diffReviewIdentity: vi.fn(async () => ({
        status: "unavailable" as const,
        diagnosticCode: "workspace_diff_unavailable",
      })),
      diffValidateReviewAnchor: vi.fn(async () => ({
        status: "unavailable" as const,
        diagnosticCode: "workspace_diff_unavailable",
      })),
      diffValidateReviewedFile: vi.fn(async () => ({
        status: "unavailable" as const,
        diagnosticCode: "workspace_diff_unavailable",
      })),
      diffReviewRepositoryIdentity: vi.fn(async () => ({
        status: "unavailable" as const,
        diagnosticCode: "workspace_diff_unavailable",
      })),
      watch: vi.fn(async () => ({
        failed: new Promise<void>(() => undefined),
        close: vi.fn(),
      })),
      close: vi.fn(),
    };
    const composite = new CompositeWorkspaceFileProvider({
      scope,
      providers: new Map([[workspace.environmentId, selected]]),
    });
    await composite.list(scope, workspace, { pageSize: 10 });
    await composite.diffRepositories(scope, workspace);
    await composite.diffRefCatalog(scope, workspace, {
      repositoryId: "repository-opaque" as never,
      pageSize: 25,
    });
    await composite.diffCreateComparison(scope, workspace, {
      repositoryId: "repository-opaque" as never,
      mode: "direct",
      base: { kind: "revision", revisionId: "base-revision" as never },
      head: { kind: "working_tree" },
    });
    await composite.diffChangedFiles(scope, workspace, {
      comparisonId: "comparison-opaque" as never,
      fingerprint: "fingerprint-opaque" as never,
      pageSize: 25,
    });
    await composite.diffPatch(scope, workspace, {
      comparisonId: "comparison-opaque" as never,
      fingerprint: "fingerprint-opaque" as never,
      fileId: "file-opaque" as never,
    });
    await composite.diffFileContent(scope, workspace, {
      comparisonId: "comparison-opaque" as never,
      fingerprint: "fingerprint-opaque" as never,
      fileId: "file-opaque" as never,
      side: "new",
    });
    expect(composite.supportsPrimaryRoot(scope, workspace.environmentId)).toBe(
      true,
    );
    expect(
      composite.supportsSupplementalRoots(scope, workspace.environmentId),
    ).toBe(true);
    expect(
      composite.supportsFileLinkRootDiscovery(scope, workspace.environmentId),
    ).toBe(true);
    expect(composite.supportsWatching(scope, workspace)).toBe(true);
    await expect(
      composite.validateRoot(scope, { ...workspace, rootKind: "primary" }),
    ).resolves.toBeUndefined();
    await expect(
      composite.discoverFileLinkRoot(
        scope,
        workspace.environmentId,
        "/workspace/file.txt",
      ),
    ).resolves.toEqual({
      canonicalPath: "/workspace",
      relativePath: "file.txt",
    });
    await expect(
      composite.resolveFileLink(scope, workspace, {
        kind: "absolute",
        path: "/workspace/file.txt",
      }),
    ).resolves.toBe("file.txt");
    const subscription = await composite.watch(scope, workspace, vi.fn());
    expect(selected.list).toHaveBeenCalledOnce();
    expect(selected.diffRepositories).toHaveBeenCalledOnce();
    expect(selected.diffRefCatalog).toHaveBeenCalledOnce();
    expect(selected.diffCreateComparison).toHaveBeenCalledOnce();
    expect(selected.diffChangedFiles).toHaveBeenCalledOnce();
    expect(selected.diffPatch).toHaveBeenCalledOnce();
    expect(selected.diffFileContent).toHaveBeenCalledOnce();
    expect(selected.supportsPrimaryRoot).toHaveBeenCalledOnce();
    expect(selected.supportsSupplementalRoots).toHaveBeenCalledOnce();
    expect(selected.supportsFileLinkRootDiscovery).toHaveBeenCalledOnce();
    expect(selected.supportsWatching).toHaveBeenCalledOnce();
    expect(selected.validateRoot).toHaveBeenCalledOnce();
    expect(selected.discoverFileLinkRoot).toHaveBeenCalledOnce();
    expect(selected.resolveFileLink).toHaveBeenCalledOnce();
    expect(selected.watch).toHaveBeenCalledOnce();
    subscription?.close();
    expect(() =>
      composite.list({ ...scope, principalId: "principal-2" }, workspace, {
        pageSize: 10,
      }),
    ).toThrow("workspace_file_environment_unavailable");
    composite.close();
    expect(selected.close).toHaveBeenCalledOnce();
    expect(() =>
      composite.list(
        scope,
        { ...workspace, environmentId: "missing" },
        { pageSize: 10 },
      ),
    ).toThrow("workspace_file_environment_unavailable");
  });

  it("reports the explicit SSH unsupported disposition", async () => {
    const provider = new UnsupportedWorkspaceFileProvider();
    expect(provider.supportsPrimaryRoot(scope, workspace.environmentId)).toBe(
      false,
    );
    expect(
      provider.supportsSupplementalRoots(scope, workspace.environmentId),
    ).toBe(false);
    expect(
      provider.supportsFileLinkRootDiscovery(scope, workspace.environmentId),
    ).toBe(false);
    expect(provider.supportsWatching(scope, workspace)).toBe(false);
    await expect(
      provider.discoverFileLinkRoot(
        scope,
        workspace.environmentId,
        "/workspace/file.txt",
      ),
    ).resolves.toBeUndefined();
    await expect(
      provider.resolveFileLink(scope, workspace, {
        kind: "absolute",
        path: "/workspace/file.txt",
      }),
    ).resolves.toBeUndefined();
    await expect(
      provider.list(scope, workspace, { pageSize: 10 }),
    ).resolves.toEqual({
      availability: "unavailable",
      rootId: "primary",
      diagnosticCode: "workspace_files_unsupported",
    });
    await expect(provider.read(scope, workspace, "file.txt")).resolves.toEqual({
      availability: "unavailable",
      rootId: "primary",
      diagnosticCode: "workspace_files_unsupported",
    });
    await expect(
      provider.write(scope, workspace, {
        path: "file.txt",
        content: "content",
        expectedRevision: "revision",
      }),
    ).resolves.toEqual({
      availability: "unavailable",
      rootId: "primary",
      diagnosticCode: "workspace_files_unsupported",
    });
    await expect(provider.status(scope, workspace)).resolves.toEqual({
      availability: "unavailable",
      rootId: "primary",
      diagnosticCode: "workspace_files_unsupported",
    });
    await expect(provider.diffRepositories(scope, workspace)).resolves.toEqual({
      status: "unavailable",
      diagnosticCode: "workspace_files_unsupported",
    });
    await expect(
      provider.watch(scope, workspace, () => undefined),
    ).resolves.toBeUndefined();
  });
});
