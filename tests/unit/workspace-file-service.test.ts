import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/server/domain/errors.js";
import { WorkspaceFileService } from "../../src/server/domain/workspace-file-service.js";
import { ExecutionWorkspaceAdmissionDeniedError } from "../../src/server/execution/contracts.js";
import { workspaceFileRootIdSchema } from "../../src/shared/index.js";
import type { WorkspaceFileProvider } from "../../src/server/workspace-files/contracts.js";
import {
  WorkspaceFileAccessError,
  WorkspaceFileCursorInvalidError,
  WorkspaceFileProviderUnavailableError,
  WorkspaceFileRootUnavailableError,
  WorkspaceFileWriteOutcomeUnknownError,
} from "../../src/server/workspace-files/contracts.js";

const owner = { tenantId: "tenant-1", principalId: "principal-1" };
const primary = {
  id: "workspace-1",
  environmentId: "environment-1",
  canonicalPath: "/workspaces/one",
  displayName: "one",
  availability: "available" as const,
  revision: 9,
};

function provider(): WorkspaceFileProvider {
  return {
    supportsPrimaryRoot: vi.fn(() => true),
    supportsSupplementalRoots: vi.fn(() => true),
    supportsFileLinkRootDiscovery: vi.fn(() => true),
    supportsWatching: vi.fn(() => true),
    validateRoot: vi.fn(async () => undefined),
    discoverFileLinkRoot: vi.fn(async () => undefined),
    discoverLinkedWorktrees: vi.fn(async () => ({
      worktrees: [],
      truncated: false,
    })),
    removeLinkedWorktree: vi.fn(async () => undefined),
    resolveFileLink: vi.fn(async (_scope, root, reference) =>
      (
        reference.kind === "absolute"
          ? reference.path === `${root.canonicalPath}/README.md`
          : reference.path === "README.md"
      )
        ? "README.md"
        : undefined,
    ),
    list: vi.fn(async (_scope, root) => ({
      availability: "available" as const,
      rootId: root.rootId,
      entries: ["README.md"],
      scanTruncated: false,
    })),
    listDirectory: vi.fn(async (_scope, root, query) => ({
      availability: "available" as const,
      rootId: root.rootId,
      directory: query.directory,
      entries: [],
      scanTruncated: false,
    })),
    read: vi.fn(async (_scope, root, relativePath) => ({
      availability: "available" as const,
      rootId: root.rootId,
      path: relativePath,
      contentKind: "text" as const,
      content: "read me",
      sizeBytes: 7,
      revision: "revision-1",
      editable: true,
    })),
    withDownload: vi.fn(async (_scope, _root, input, operation) =>
      operation({
        path: input.path,
        fileName: "README.md",
        sizeBytes: 7,
        revision: input.expectedRevision,
        stream: async (write: (chunk: Uint8Array) => Promise<void>) =>
          write(Buffer.from("read me")),
      }),
    ),
    write: vi.fn(async (_scope, root, input) => ({
      availability: "available" as const,
      rootId: root.rootId,
      path: input.path,
      sizeBytes: input.content.length,
      revision: "revision-2",
    })),
    status: vi.fn(async (_scope, root) => ({
      availability: "available" as const,
      rootId: root.rootId,
      isGitRepository: false,
      entries: [],
      truncated: false,
    })),
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
}

function fixture(input?: {
  workspace?: typeof primary;
  roots?: Array<{
    rootId: string;
    canonicalPath: string;
    displayLabel: string;
    sortOrder: number;
    availability: "available" | "unavailable";
    revision: number;
  }>;
  files?: WorkspaceFileProvider;
  linkedWorktrees?: Array<{
    rootId: string;
    canonicalPath: string;
    displayLabel: string;
    branchRef: string | null;
    headOid: string;
    canonicalGitDir: string;
    identityToken: string;
    canonicalCheckoutPath: string | null;
    provenanceKind: "same" | "contained" | "unmerged" | "unknown";
    aheadCount: number | null;
    behindCount: number | null;
    availability: "available" | "unavailable";
    revision: number;
  }>;
  preferredWorktreeRootId?: string | null;
  reconciliationClearedThreadIds?: readonly string[];
}) {
  const workspace = input?.workspace ?? primary;
  const records = input?.roots ?? [];
  const inventory = {
    assertWorkspaceActive: vi.fn(),
    getWorkspace: vi.fn((scope, workspaceId) => {
      if (scope !== owner || workspaceId !== workspace.id) {
        throw new DomainError("not_found", "The workspace was not found.");
      }
      return workspace;
    }),
    listWorkspaces: vi.fn(() => [workspace]),
    getThread: vi.fn(() => ({
      thread: {
        id: "thread-1",
        workspaceId: workspace.id,
        environmentId: workspace.environmentId,
      },
      inventory: {
        preferredWorktreeRootId: input?.preferredWorktreeRootId ?? null,
        preferredWorktreeRevision: 0,
      },
    })),
  };
  const roots = {
    list: vi.fn(() => [...records]),
    findLinkRoot: vi.fn((..._arguments: unknown[]): any => undefined),
    rememberLinkRoot: vi.fn((..._arguments: unknown[]): any => undefined),
    replayCreate: vi.fn((..._arguments: unknown[]): any => undefined),
    replayRemove: vi.fn((..._arguments: unknown[]): any => undefined),
    create: vi.fn((..._arguments: unknown[]): any => undefined),
    remove: vi.fn((..._arguments: unknown[]): any => undefined),
    setAvailability: vi.fn((_scope, _workspaceId, rootId, update) => {
      const record = records.find((candidate) => candidate.rootId === rootId);
      if (!record) throw new DomainError("not_found", "missing");
      Object.assign(record, { availability: update.availability });
      return record;
    }),
  };
  const execution = {
    validateWorkspace: vi.fn(async (_scope, environmentId, candidatePath) => ({
      canonicalPath: candidatePath,
      summary: {
        id: "validated",
        environmentId,
        displayName: "validated",
        displayPath: candidatePath,
        availability: "available" as const,
        trustState: "trusted" as const,
        revision: 0,
      },
    })),
  };
  const linkedWorktrees = {
    list: vi.fn(() => input?.linkedWorktrees ?? []),
    get: vi.fn((_scope, _workspaceId, rootId) => {
      const record = input?.linkedWorktrees?.find(
        (candidate) => candidate.rootId === rootId,
      );
      if (!record) throw new DomainError("not_found", "missing");
      return record;
    }),
    replayForget: vi.fn((..._arguments: unknown[]): any => undefined),
    hasOtherWorkspaceOverlap: vi.fn(() => false),
    forget: vi.fn((_scope, _workspaceId, rootId, update) => ({
      rootId,
      outcome: update.outcome,
      clearedThreadIds: [],
    })),
    reconcileDiscovery: vi.fn(() => ({
      roots: [],
      tombstonedRootIds: [],
      clearedThreadIds: [...(input?.reconciliationClearedThreadIds ?? [])],
    })),
  };
  const files = input?.files ?? provider();
  const applicationThreads = {
    publishApplicationThreadChanges: vi.fn(async () => undefined),
  };
  return {
    inventory,
    roots,
    linkedWorktrees,
    execution,
    files,
    applicationThreads,
    service: new WorkspaceFileService(
      inventory as never,
      roots as never,
      linkedWorktrees as never,
      execution as never,
      files,
      applicationThreads,
    ),
  };
}

describe("WorkspaceFileService", () => {
  it("captures an absolute image through an authorized hidden root without refreshing Files topology", async () => {
    const files = provider();
    const current = fixture({ files, preferredWorktreeRootId: "different-worktree" });
    vi.mocked(files.discoverFileLinkRoot).mockResolvedValue({ canonicalPath: "/workspaces/captures", relativePath: "image.png" });
    vi.mocked(files.resolveFileLink).mockResolvedValue("image.png");
    vi.mocked(files.read).mockImplementation(async (_scope, target, relativePath) => ({
      availability: "available", rootId: target.rootId, path: relativePath,
      contentKind: "image", previewState: "available", mediaType: "image/png",
      contentEncoding: "base64", content: "aW1hZ2U=", sizeBytes: 5, revision: "r1", editable: false,
    }));
    const result = await current.service.readAbsoluteImage(owner, "thread-1", "/workspaces/captures/image.png");
    expect(result?.content).toBe("aW1hZ2U=");
    expect(files.read).toHaveBeenCalledWith(owner, expect.objectContaining({
      environmentId: primary.environmentId, canonicalPath: "/workspaces/captures", rootId: "link-candidate",
    }), "image.png", expect.any(AbortSignal));
    expect(current.roots.rememberLinkRoot).not.toHaveBeenCalled();
    expect(files.discoverLinkedWorktrees).not.toHaveBeenCalled();
    expect(files.list).not.toHaveBeenCalled();
    expect(current.execution.validateWorkspace).toHaveBeenCalledWith(owner, primary.environmentId, "/workspaces/captures");
  });

  it("does not probe denied or malformed absolute image paths or unavailable remote providers", async () => {
    const current = fixture();
    current.execution.validateWorkspace.mockRejectedValue(new Error("denied"));
    expect(await current.service.readAbsoluteImage(owner, "thread-1", "/tmp/private.png")).toBeUndefined();
    expect(await current.service.readAbsoluteImage(owner, "thread-1", "../image.png")).toBeUndefined();
    expect(current.files.discoverFileLinkRoot).not.toHaveBeenCalled();
    expect(current.files.read).not.toHaveBeenCalled();
    vi.mocked(current.files.supportsFileLinkRootDiscovery).mockReturnValue(false);
    current.execution.validateWorkspace.mockClear();
    expect(await current.service.readAbsoluteImage(owner, "thread-1", "/workspaces/image.png")).toBeUndefined();
    expect(current.execution.validateWorkspace).not.toHaveBeenCalled();
  });

  it("propagates capture cancellation through absolute-path discovery", async () => {
    const current = fixture();
    const controller = new AbortController();
    vi.mocked(current.files.discoverFileLinkRoot).mockImplementation(async (_scope, _environmentId, _path, signal) => {
      expect(signal).toBeDefined();
      controller.abort(new Error("capture cancelled"));
      signal!.throwIfAborted();
      return undefined;
    });
    await expect(current.service.readAbsoluteImage(owner, "thread-1", "/workspaces/image.png", controller.signal))
      .rejects.toThrow("capture cancelled");
    expect(current.files.read).not.toHaveBeenCalled();
    expect(current.roots.rememberLinkRoot).not.toHaveBeenCalled();
  });

  it("bounds uncancellable environment admission and forwards cancellation to link resolution", async () => {
    const current = fixture();
    const controller = new AbortController();
    current.execution.validateWorkspace.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = current.service.readAbsoluteImage(owner, "thread-1", "/workspaces/image.png", controller.signal);
    await vi.waitFor(() => expect(current.execution.validateWorkspace).toHaveBeenCalledOnce());
    controller.abort(new Error("capture cancelled"));
    await expect(pending).rejects.toThrow("capture cancelled");
    expect(current.files.discoverFileLinkRoot).not.toHaveBeenCalled();
    vi.mocked(current.files.discoverFileLinkRoot).mockResolvedValue({ canonicalPath: "/workspaces/captures", relativePath: "image.png" });
    await current.service.readAbsoluteImage(owner, "thread-1", "/workspaces/captures/image.png", new AbortController().signal);
    expect(current.files.resolveFileLink).toHaveBeenCalledWith(owner, expect.objectContaining({
      canonicalPath: "/workspaces/captures",
    }), { kind: "absolute", path: "/workspaces/captures/image.png" }, expect.any(AbortSignal));
  });

  it("reads a captured image inside Primary through Primary without remembering a hidden root", async () => {
    const current = fixture();
    vi.mocked(current.files.read).mockImplementation(async (_scope, target, relativePath) => ({
      availability: "available", rootId: target.rootId, path: relativePath,
      contentKind: "image", previewState: "available", mediaType: "image/png",
      contentEncoding: "base64", content: "aW1hZ2U=", sizeBytes: 5, revision: "r1", editable: false,
    }));
    const result = await current.service.readAbsoluteImage(owner, "thread-1", "/workspaces/one/README.md");
    expect(result?.rootId).toBe("primary");
    expect(current.files.validateRoot).toHaveBeenCalledWith(owner, expect.objectContaining({
      rootKind: "primary", canonicalPath: primary.canonicalPath,
    }), expect.any(AbortSignal));
    expect(current.files.read).toHaveBeenCalledWith(owner, expect.objectContaining({
      rootId: "primary", canonicalPath: primary.canonicalPath,
    }), "README.md", expect.any(AbortSignal));
    expect(current.files.discoverFileLinkRoot).not.toHaveBeenCalled();
    expect(current.roots.rememberLinkRoot).not.toHaveBeenCalled();
  });

  it("denies removed-project file operations before contacting the provider", async () => {
    const current = fixture();
    current.inventory.assertWorkspaceActive.mockImplementation(() => {
      throw new DomainError("invalid_transition", "Project removed");
    });
    await expect(current.service.listRoots(owner, primary.id)).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(current.service.read(owner, primary.id, workspaceFileRootIdSchema.parse("primary"), "README.md")).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(current.service.attachRoot(owner, primary.id, { mutationId: "12121212-1212-4212-8212-121212121212", path: "/workspaces/context" }))
      .rejects.toMatchObject({ code: "invalid_transition" });
    expect(current.files.discoverLinkedWorktrees).not.toHaveBeenCalled();
    expect(current.files.read).not.toHaveBeenCalled();
    expect(current.execution.validateWorkspace).not.toHaveBeenCalled();
  });

  it("drains admitted writes and closes watchers before a project removal commits", async () => {
    const current = fixture();
    const watch = await current.service.watch(owner, primary.id, () => undefined);
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    vi.mocked(current.files.write).mockImplementation(async (_scope, root, input) => {
      await blockedWrite;
      return { availability: "available", rootId: root.rootId, path: input.path, sizeBytes: input.content.length, revision: "revision-2" };
    });
    const request = { rootId: workspaceFileRootIdSchema.parse("primary"), path: "README.md", content: "changed", expectedRevision: "revision-1" };
    const writing = current.service.write(owner, primary.id, request);
    await vi.waitFor(() => expect(current.files.write).toHaveBeenCalledOnce());
    const commit = vi.fn(async () => "removed");
    const removing = current.service.runWithWorkspaceRetired(owner, primary.id, commit);
    await expect(watch.failed).resolves.toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    await expect(current.service.write(owner, primary.id, request)).rejects.toMatchObject({ code: "invalid_transition" });
    expect(current.files.write).toHaveBeenCalledOnce();
    releaseWrite();
    await writing;
    await expect(removing).resolves.toBe("removed");
    expect(commit).toHaveBeenCalledOnce();
  });

  it("publishes every thread whose stale worktree preference was cleared", async () => {
    const current = fixture({
      reconciliationClearedThreadIds: ["thread-1", "thread-2"],
    });

    await current.service.listRoots(owner, primary.id);

    expect(current.linkedWorktrees.reconcileDiscovery).toHaveBeenCalledOnce();
    expect(
      current.applicationThreads.publishApplicationThreadChanges,
    ).toHaveBeenCalledWith(owner, ["thread-1", "thread-2"]);
  });

  it("maps missing directories and stale listing cursors to recoverable domain errors", async () => {
    const files = provider();
    const current = fixture({ files });
    vi.mocked(files.listDirectory)
      .mockRejectedValueOnce(new WorkspaceFileAccessError())
      .mockRejectedValueOnce(new WorkspaceFileCursorInvalidError());
    vi.mocked(files.list).mockRejectedValueOnce(
      new WorkspaceFileCursorInvalidError(),
    );

    await expect(
      current.service.listDirectory(owner, primary.id, {
        rootId: "primary",
        directory: "removed",
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      current.service.listDirectory(owner, primary.id, {
        rootId: "primary",
        directory: "",
        cursor: "expired",
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(
      current.service.list(owner, primary.id, {
        rootId: "primary",
        cursor: "expired",
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
  });

  it("forwards the caller cancellation signal through root validation and comparison", async () => {
    const files = provider();
    const current = fixture({ files });
    const signal = new AbortController().signal;

    await current.service.diffRepositories(
      owner,
      primary.id,
      "primary",
      signal,
    );

    expect(files.validateRoot).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ workspaceId: primary.id }),
      signal,
    );
    expect(files.diffRepositories).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ rootId: "primary" }),
      signal,
    );
  });

  it("gates primary Files independently from supplemental roots", async () => {
    const supplemental = {
      rootId: "root-1",
      canonicalPath: "/workspaces/context",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const files = provider();
    vi.mocked(files.supportsPrimaryRoot).mockReturnValue(false);
    const current = fixture({ files, roots: [supplemental] });

    await expect(current.service.listRoots(owner, primary.id)).resolves.toEqual(
      {
        roots: [
          expect.objectContaining({
            rootId: "primary",
            availability: "unavailable",
            diagnosticCode: "workspace_files_unsupported",
          }),
          expect.objectContaining({
            rootId: "root-1",
            availability: "available",
          }),
        ],
      },
    );
  });

  it("authorizes and root-qualifies every primary operation", async () => {
    const current = fixture();
    await expect(
      current.service.list(owner, primary.id, {
        rootId: "primary",
        pageSize: 10,
      }),
    ).resolves.toMatchObject({ rootId: "primary", entries: ["README.md"] });
    await expect(
      current.service.read(owner, primary.id, "primary", "README.md"),
    ).resolves.toMatchObject({ rootId: "primary", content: "read me" });
    await expect(current.service.status(owner, primary.id)).resolves.toEqual({
      roots: [
        expect.objectContaining({
          rootId: "primary",
          availability: "available",
        }),
      ],
    });
    await expect(
      current.service.write(owner, primary.id, {
        rootId: "primary",
        path: "README.md",
        content: "changed",
        expectedRevision: "revision-1",
      }),
    ).resolves.toMatchObject({ rootId: "primary", revision: "revision-2" });
    expect(current.files.list).toHaveBeenCalledWith(
      owner,
      {
        workspaceId: primary.id,
        environmentId: primary.environmentId,
        rootId: "primary",
        canonicalPath: primary.canonicalPath,
      },
      { pageSize: 10 },
    );
  });

  it("routes every comparison operation through the authorized workspace root", async () => {
    const current = fixture();
    const unavailable = {
      status: "unavailable" as const,
      diagnosticCode: "workspace_diff_unavailable",
    };
    vi.mocked(current.files.diffRepositories).mockResolvedValue(unavailable);

    await expect(
      current.service.diffRepositories(owner, primary.id, "primary"),
    ).resolves.toEqual(unavailable);
    await expect(
      current.service.diffRefCatalog(owner, primary.id, "primary", {
        repositoryId: "repository-opaque" as never,
        pageSize: 25,
      }),
    ).resolves.toEqual(unavailable);
    await expect(
      current.service.diffCreateComparison(owner, primary.id, "primary", {
        repositoryId: "repository-opaque" as never,
        mode: "direct",
        base: { kind: "revision", revisionId: "base-opaque" as never },
        head: { kind: "working_tree" },
      }),
    ).resolves.toEqual(unavailable);
    await expect(
      current.service.diffChangedFiles(owner, primary.id, "primary", {
        comparisonId: "comparison-opaque" as never,
        fingerprint: "fingerprint-opaque" as never,
        pageSize: 25,
      }),
    ).resolves.toEqual(unavailable);
    await expect(
      current.service.diffPatch(owner, primary.id, "primary", {
        comparisonId: "comparison-opaque" as never,
        fingerprint: "fingerprint-opaque" as never,
        fileId: "file-opaque" as never,
      }),
    ).resolves.toEqual(unavailable);
    await expect(
      current.service.diffFileContent(owner, primary.id, "primary", {
        comparisonId: "comparison-opaque" as never,
        fingerprint: "fingerprint-opaque" as never,
        fileId: "file-opaque" as never,
        side: "new",
      }),
    ).resolves.toEqual(unavailable);

    expect(current.files.diffRepositories).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        workspaceId: primary.id,
        rootId: "primary",
        canonicalPath: primary.canonicalPath,
      }),
    );
    await expect(
      current.service.diffRepositories(
        owner,
        primary.id,
        "root-from-another-workspace" as never,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(current.files.diffRepositories).toHaveBeenCalledTimes(1);
  });

  it("preserves sidecar-unavailable diagnostics across every file operation", async () => {
    const files = provider();
    vi.mocked(files.validateRoot).mockRejectedValue(
      new WorkspaceFileProviderUnavailableError(),
    );
    const current = fixture({ files });
    const unavailable = {
      availability: "unavailable",
      rootId: "primary",
      diagnosticCode: "workspace_files_sidecar_unavailable",
    };

    await expect(
      current.service.list(owner, primary.id, {
        rootId: "primary",
        pageSize: 10,
      }),
    ).resolves.toEqual(unavailable);
    await expect(
      current.service.read(owner, primary.id, "primary", "README.md"),
    ).resolves.toEqual(unavailable);
    await expect(
      current.service.write(owner, primary.id, {
        rootId: "primary",
        path: "README.md",
        content: "changed",
        expectedRevision: "revision-1",
      }),
    ).resolves.toEqual(unavailable);
    await expect(current.service.status(owner, primary.id)).resolves.toEqual({
      roots: [unavailable],
    });
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: { kind: "workspace_relative", path: "README.md" },
      }),
    ).rejects.toMatchObject({ code: "runtime_unavailable", retryable: true });
  });

  it("preserves sidecar-unavailable diagnostics from admitted provider operations", async () => {
    const files = provider();
    const unavailableError = new WorkspaceFileProviderUnavailableError();
    const current = fixture({ files });
    const unavailable = {
      availability: "unavailable",
      rootId: "primary",
      diagnosticCode: "workspace_files_sidecar_unavailable",
    };

    vi.mocked(files.list).mockRejectedValueOnce(unavailableError);
    await expect(
      current.service.list(owner, primary.id, {
        rootId: "primary",
        pageSize: 10,
      }),
    ).resolves.toEqual(unavailable);
    vi.mocked(files.read).mockRejectedValueOnce(unavailableError);
    await expect(
      current.service.read(owner, primary.id, "primary", "README.md"),
    ).resolves.toEqual(unavailable);
    vi.mocked(files.write).mockRejectedValueOnce(unavailableError);
    await expect(
      current.service.write(owner, primary.id, {
        rootId: "primary",
        path: "README.md",
        content: "changed",
        expectedRevision: "revision-1",
      }),
    ).resolves.toEqual(unavailable);
    vi.mocked(files.status).mockRejectedValueOnce(unavailableError);
    await expect(current.service.status(owner, primary.id)).resolves.toEqual({
      roots: [unavailable],
    });
  });

  it("maps a remote write with unknown outcome to its exact normalized error", async () => {
    const files = provider();
    vi.mocked(files.write).mockRejectedValue(
      new WorkspaceFileWriteOutcomeUnknownError(),
    );
    const current = fixture({ files });

    await expect(
      current.service.write(owner, primary.id, {
        rootId: "primary",
        path: "README.md",
        content: "changed",
        expectedRevision: "revision-1",
      }),
    ).rejects.toMatchObject({
      code: "workspace_file_write_outcome_unknown",
      retryable: false,
    });
    expect(files.write).toHaveBeenCalledOnce();
  });

  it("does not disguise provider transport loss as a missing file link", async () => {
    const files = provider();
    vi.mocked(files.resolveFileLink).mockRejectedValue(
      new WorkspaceFileProviderUnavailableError(),
    );
    const current = fixture({ files });

    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: { kind: "workspace_relative", path: "README.md" },
      }),
    ).rejects.toMatchObject({ code: "runtime_unavailable", retryable: true });
  });

  it("projects primary first with constant revision and retains unavailable supplemental roots", async () => {
    const supplemental = {
      rootId: "root-1",
      canonicalPath: "/workspaces/context",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available" as const,
      revision: 3,
    };
    const current = fixture({ roots: [supplemental] });
    current.execution.validateWorkspace.mockImplementation(
      async (_scope, environmentId, candidatePath) => {
        if (candidatePath === supplemental.canonicalPath) {
          throw new Error("missing");
        }
        return {
          canonicalPath: candidatePath,
          summary: {
            id: "validated",
            environmentId,
            displayName: "validated",
            displayPath: candidatePath,
            availability: "available" as const,
            trustState: "trusted" as const,
            revision: 0,
          },
        };
      },
    );
    const result = await current.service.listRoots(owner, primary.id);
    expect(result.roots).toEqual([
      expect.objectContaining({ rootId: "primary", sortOrder: 0, revision: 0 }),
      expect.objectContaining({
        rootId: "root-1",
        sortOrder: 1,
        availability: "unavailable",
      }),
    ]);
    expect(current.roots.setAvailability).toHaveBeenCalledWith(
      owner,
      primary.id,
      "root-1",
      expect.objectContaining({ availability: "unavailable" }),
    );
  });

  it.each(["/workspaces", "/workspaces/one/nested"])("keeps supplemental root %s available", async (canonicalPath) => {
    const ancestor = {
      rootId: "root-home",
      canonicalPath,
      displayLabel: "Home",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const current = fixture({ roots: [ancestor] });

    await expect(current.service.listRoots(owner, primary.id)).resolves.toEqual(
      {
        roots: [
          expect.objectContaining({
            rootId: "primary",
            availability: "available",
          }),
          expect.objectContaining({
            rootId: ancestor.rootId,
            availability: "available",
          }),
        ],
      },
    );
    expect(current.roots.setAvailability).toHaveBeenCalledWith(
      owner,
      primary.id,
      ancestor.rootId,
      expect.objectContaining({ availability: "available" }),
    );
  });

  it("normalizes control characters in the primary root label", async () => {
    const current = fixture({
      workspace: { ...primary, displayName: "one\nwith\u0000controls" },
    });

    await expect(current.service.listRoots(owner, primary.id)).resolves.toEqual(
      {
        roots: [
          expect.objectContaining({
            rootId: "primary",
            displayLabel: "one�with�controls",
          }),
        ],
      },
    );
  });

  it("derives a bounded safe label from a legal POSIX directory name", async () => {
    const basename = `${"x".repeat(245)}\\name\n`;
    const canonicalPath = `/workspaces/${basename}`;
    const current = fixture();
    current.execution.validateWorkspace.mockResolvedValue({
      canonicalPath,
      summary: {
        id: "validated",
        environmentId: primary.environmentId,
        displayName: "validated",
        displayPath: "/workspaces/alias",
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
    });
    current.roots.create.mockImplementation((_scope, _workspaceId, input) => ({
      rootId: "root-derived-label",
      canonicalPath,
      displayLabel: (input as { resolvedDisplayLabel: string })
        .resolvedDisplayLabel,
      sortOrder: 0,
      availability: "available",
      revision: 1,
    }));

    const result = await current.service.attachRoot(owner, primary.id, {
      mutationId: "12121212-1212-4212-8212-121212121212",
      path: "/workspaces/alias",
    });

    expect(result.root.displayLabel).toHaveLength(240);
    expect(result.root.displayLabel).not.toMatch(/[\\\u0000-\u001f\u007f]/u);
    expect(current.roots.create).toHaveBeenCalledWith(
      owner,
      primary.id,
      expect.objectContaining({
        resolvedDisplayLabel: result.root.displayLabel,
      }),
    );
  });

  it("isolates resolver matches and rejects ambiguous post-attach overlap", async () => {
    const current = fixture({
      roots: [
        {
          rootId: "root-1",
          canonicalPath: "/workspaces/context",
          displayLabel: "Context",
          sortOrder: 0,
          availability: "available",
          revision: 1,
        },
      ],
    });
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "absolute",
          path: "/workspaces/context/README.md",
        },
      }),
    ).resolves.toEqual({
      status: "resolved",
      rootId: "root-1",
      path: "README.md",
      rootVisibility: "listed",
    });
    vi.mocked(current.files.resolveFileLink).mockResolvedValue("README.md");
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "absolute",
          path: "/workspaces/context/README.md",
        },
      }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("projects linked worktrees and resolves chat-relative links through the thread preference", async () => {
    const linked = {
      rootId: "6d67f4ea-17cf-42d5-9986-bbca3598e436",
      canonicalPath: "/worktrees/one-topic/packages/app",
      canonicalCheckoutPath: "/worktrees/one-topic",
      canonicalGitDir: "/workspaces/.git/worktrees/one-topic",
      identityToken: "1".repeat(64),
      displayLabel: "topic",
      branchRef: "refs/heads/feature/topic",
      headOid: "a".repeat(40),
      provenanceKind: "unmerged" as const,
      aheadCount: 1,
      behindCount: 0,
      availability: "available" as const,
      revision: 3,
    };
    const current = fixture({
      linkedWorktrees: [linked],
      preferredWorktreeRootId: linked.rootId,
    });

    await expect(current.service.listRoots(owner, primary.id)).resolves.toEqual(
      {
        roots: [
          expect.objectContaining({ kind: "primary", rootId: "primary" }),
          expect.objectContaining({
            kind: "linked_worktree",
            rootId: linked.rootId,
            branch: "feature/topic",
            head: linked.headOid,
            availability: "available",
            removal: {
              status: "allowed",
              displayPath: { text: linked.canonicalCheckoutPath },
            },
          }),
        ],
      },
    );
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: { kind: "workspace_relative", path: "README.md" },
      }),
    ).resolves.toEqual({
      status: "resolved",
      rootId: linked.rootId,
      path: "README.md",
      rootVisibility: "listed",
    });
    expect(current.files.resolveFileLink).toHaveBeenLastCalledWith(
      owner,
      expect.objectContaining({
        rootId: linked.rootId,
        canonicalPath: linked.canonicalPath,
      }),
      { kind: "workspace_relative", path: "README.md" },
    );
  });

  it("offers Forget only for persisted tombstones, not transient unavailability", async () => {
    const linked = {
      rootId: "6d67f4ea-17cf-42d5-9986-bbca3598e437",
      canonicalPath: "/worktrees/missing",
      canonicalCheckoutPath: null,
      canonicalGitDir: "/workspaces/.git/worktrees/missing",
      identityToken: "2".repeat(64),
      displayLabel: "missing",
      branchRef: "refs/heads/feature/missing",
      headOid: "b".repeat(40),
      provenanceKind: "unknown" as const,
      aheadCount: null,
      behindCount: null,
      availability: "unavailable" as const,
      revision: 4,
    };
    const missing = fixture({ linkedWorktrees: [linked] });
    await expect(missing.service.listRoots(owner, primary.id)).resolves.toEqual(
      {
        roots: [
          expect.objectContaining({ kind: "primary" }),
          expect.objectContaining({
            rootId: linked.rootId,
            availability: "unavailable",
            removal: { status: "forget" },
          }),
        ],
      },
    );

    const transientRecord = {
      ...linked,
      canonicalCheckoutPath: "/worktrees/transient",
      availability: "available" as const,
    };
    const transient = fixture({ linkedWorktrees: [transientRecord] });
    transient.execution.validateWorkspace.mockRejectedValue(
      new Error("execution unavailable"),
    );
    await expect(
      transient.service.listRoots(owner, primary.id),
    ).resolves.toEqual({
      roots: [
        expect.objectContaining({ kind: "primary" }),
        expect.objectContaining({
          rootId: linked.rootId,
          availability: "unavailable",
          removal: { status: "unavailable" },
        }),
      ],
    });
  });

  it("maps checkout admission failures to bounded deletion errors", async () => {
    const linked = {
      rootId: "9abdbdbd-a151-463e-88a4-ce5844a5ee80",
      canonicalPath: "/worktrees/topic",
      canonicalCheckoutPath: "/worktrees/topic",
      canonicalGitDir: "/workspaces/one/.git/worktrees/topic",
      identityToken: "3".repeat(64),
      displayLabel: "topic",
      branchRef: "refs/heads/topic",
      headOid: "c".repeat(40),
      provenanceKind: "unmerged" as const,
      aheadCount: 1,
      behindCount: 0,
      availability: "available" as const,
      revision: 2,
    };
    for (const [error, code] of [
      [new ExecutionWorkspaceAdmissionDeniedError(), "not_found"],
      [new Error("transport unavailable"), "runtime_unavailable"],
    ] as const) {
      const current = fixture({ linkedWorktrees: [linked] });
      current.execution.validateWorkspace.mockRejectedValue(error);
      await expect(
        current.service.deleteLinkedWorktree(
          owner,
          primary.id,
          linked.rootId as never,
          {
            mutationId:
              code === "not_found"
                ? "79797979-7979-4979-8979-797979797979"
                : "80808080-8080-4080-8080-808080808080",
            expectedRevision: linked.revision,
            confirmation: true,
          },
        ),
      ).rejects.toMatchObject({ code });
      expect(current.files.removeLinkedWorktree).not.toHaveBeenCalled();
    }
  });

  it("retains linked-worktree topology when candidate admission is incomplete", async () => {
    const files = provider();
    vi.mocked(files.discoverLinkedWorktrees).mockResolvedValue({
      worktrees: [
        {
          canonicalPath: "/worktrees/rejected",
          canonicalCheckoutPath: "/worktrees/rejected",
          canonicalGitDir: "/workspaces/one/.git/worktrees/rejected",
          identityToken: "2".repeat(64),
          displayLabel: "rejected",
          branchRef: "refs/heads/rejected",
          headOid: "a".repeat(40),
          provenanceKind: "unmerged",
          aheadCount: 1,
          behindCount: 0,
        },
      ],
      truncated: false,
    });
    const current = fixture({ files });
    current.execution.validateWorkspace.mockImplementation(
      async (_scope, environmentId, candidatePath) => {
        if (candidatePath === "/worktrees/rejected") {
          throw new Error("temporary execution admission failure");
        }
        return {
          canonicalPath: candidatePath,
          summary: {
            id: "validated",
            environmentId,
            displayName: "validated",
            displayPath: candidatePath,
            availability: "available" as const,
            trustState: "trusted" as const,
            revision: 0,
          },
        };
      },
    );

    await current.service.listRoots(owner, primary.id);

    expect(current.linkedWorktrees.reconcileDiscovery).toHaveBeenCalledWith(
      owner,
      primary.id,
      [],
      expect.objectContaining({ complete: false }),
    );
  });

  it("keeps definitive out-of-policy candidates from blocking complete reconciliation", async () => {
    const files = provider();
    vi.mocked(files.discoverLinkedWorktrees).mockResolvedValue({
      worktrees: [
        {
          canonicalPath: "/outside/rejected",
          canonicalCheckoutPath: "/outside/rejected",
          canonicalGitDir: "/workspaces/one/.git/worktrees/rejected",
          identityToken: "3".repeat(64),
          displayLabel: "rejected",
          branchRef: "refs/heads/rejected",
          headOid: "a".repeat(40),
          provenanceKind: "unmerged",
          aheadCount: 1,
          behindCount: 0,
        },
      ],
      truncated: false,
    });
    const current = fixture({
      files,
      reconciliationClearedThreadIds: ["thread-with-removed-root"],
    });
    current.execution.validateWorkspace.mockRejectedValue(
      new ExecutionWorkspaceAdmissionDeniedError(),
    );

    await current.service.listRoots(owner, primary.id);

    expect(current.linkedWorktrees.reconcileDiscovery).toHaveBeenCalledWith(
      owner,
      primary.id,
      [],
      expect.objectContaining({ complete: true }),
    );
    expect(
      current.applicationThreads.publishApplicationThreadChanges,
    ).toHaveBeenCalledWith(owner, ["thread-with-removed-root"]);
  });

  it("falls back to Primary on the first relative link after its preferred worktree disappears", async () => {
    const current = fixture({
      preferredWorktreeRootId: "6d67f4ea-17cf-42d5-9986-bbca3598e436",
    });

    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: { kind: "workspace_relative", path: "README.md" },
      }),
    ).resolves.toEqual({
      status: "resolved",
      rootId: "primary",
      path: "README.md",
      rootVisibility: "listed",
    });
    expect(current.files.resolveFileLink).toHaveBeenCalledExactlyOnceWith(
      owner,
      expect.objectContaining({ rootId: "primary" }),
      { kind: "workspace_relative", path: "README.md" },
    );
  });

  it("resolves an absolute link beneath a nested repository through its supplemental root", async () => {
    const nested = {
      rootId: "root-nested",
      canonicalPath: "/workspaces/one/repository",
      displayLabel: "Repository",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const files = provider();
    vi.mocked(files.resolveFileLink).mockImplementation(
      async (_scope, root, reference) => {
        if (reference.kind !== "absolute") return undefined;
        if (reference.path !== `${nested.canonicalPath}/README.md`) return undefined;
        return root.rootId === "primary" ? "repository/README.md" : "README.md";
      },
    );
    const current = fixture({ files, roots: [nested] });
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: { kind: "absolute", path: `${nested.canonicalPath}/README.md` },
      }),
    ).resolves.toEqual({
      status: "resolved",
      rootId: nested.rootId,
      path: "README.md",
      rootVisibility: "listed",
    });
  });

  it("resolves an overlapping absolute link through the most-specific root", async () => {
    const ancestor = {
      rootId: "root-home",
      canonicalPath: "/workspaces",
      displayLabel: "Home",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const files = provider();
    vi.mocked(files.resolveFileLink).mockImplementation(
      async (_scope, root, reference) => {
        if (reference.kind !== "absolute") return undefined;
        if (root.rootId === "primary") {
          return reference.path === "/workspaces/one/README.md"
            ? "README.md"
            : undefined;
        }
        if (root.rootId === ancestor.rootId) {
          if (reference.path === "/workspaces/one/README.md") {
            return "one/README.md";
          }
          return reference.path === "/workspaces/notes.md"
            ? "notes.md"
            : undefined;
        }
        return undefined;
      },
    );
    const current = fixture({ files, roots: [ancestor] });

    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "absolute",
          path: "/workspaces/one/README.md",
        },
      }),
    ).resolves.toEqual({
      status: "resolved",
      rootId: "primary",
      path: "README.md",
      rootVisibility: "listed",
    });
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: { kind: "absolute", path: "/workspaces/notes.md" },
      }),
    ).resolves.toEqual({
      status: "resolved",
      rootId: ancestor.rootId,
      path: "notes.md",
      rootVisibility: "listed",
    });
  });

  it("resolves workspace-relative links only against the primary root", async () => {
    const current = fixture({
      roots: [
        {
          rootId: "root-1",
          canonicalPath: "/workspaces/context",
          displayLabel: "Context",
          sortOrder: 0,
          availability: "available",
          revision: 1,
        },
      ],
    });

    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: { kind: "workspace_relative", path: "README.md" },
      }),
    ).resolves.toEqual({
      status: "resolved",
      rootId: "primary",
      path: "README.md",
      rootVisibility: "listed",
    });
    expect(current.files.resolveFileLink).toHaveBeenCalledExactlyOnceWith(
      owner,
      expect.objectContaining({ rootId: "primary" }),
      { kind: "workspace_relative", path: "README.md" },
    );
  });

  it("resolves root-relative links only against the workspace-owned root", async () => {
    const supplementalRootId = workspaceFileRootIdSchema.parse("root-1");
    const supplemental = {
      rootId: supplementalRootId,
      canonicalPath: "/workspaces/context",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const current = fixture({ roots: [supplemental] });
    vi.mocked(current.files.resolveFileLink).mockImplementation(
      async (_scope, root, reference) =>
        root.rootId === supplemental.rootId &&
        reference.kind === "root_relative" &&
        reference.rootId === supplemental.rootId
          ? reference.path
          : undefined,
    );

    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "root_relative",
          rootId: supplemental.rootId,
          path: "docs/guide.md",
        },
      }),
    ).resolves.toEqual({
      status: "resolved",
      rootId: supplemental.rootId,
      path: "docs/guide.md",
      rootVisibility: "listed",
    });
    expect(current.files.resolveFileLink).toHaveBeenCalledExactlyOnceWith(
      owner,
      expect.objectContaining({ rootId: supplemental.rootId }),
      {
        kind: "root_relative",
        rootId: supplemental.rootId,
        path: "docs/guide.md",
      },
    );

    vi.mocked(current.files.resolveFileLink).mockClear();
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "root_relative",
          rootId: workspaceFileRootIdSchema.parse(
            "root-from-another-workspace",
          ),
          path: "docs/guide.md",
        },
      }),
    ).resolves.toEqual({ status: "not_found" });
    expect(current.files.resolveFileLink).not.toHaveBeenCalled();
  });

  it("discovers an allowed Git worktree as a hidden root and revalidates later reads", async () => {
    const files = provider();
    vi.mocked(files.discoverFileLinkRoot).mockResolvedValue({
      canonicalPath: "/worktrees/sibling",
      relativePath: "src/index.ts",
    });
    const current = fixture({ files });
    const linkRoot = {
      rootId: "link-sibling",
      canonicalPath: "/worktrees/sibling",
      createdAt: 10,
    };
    current.roots.rememberLinkRoot.mockReturnValue(linkRoot);
    vi.mocked(files.resolveFileLink).mockImplementation(
      async (_scope, root, reference) =>
        root.canonicalPath === "/worktrees/sibling" &&
        reference.kind === "absolute" &&
        reference.path === "/worktrees/sibling/src/index.ts"
          ? "src/index.ts"
          : undefined,
    );

    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "absolute",
          path: "/aliases/sibling/src/index.ts",
        },
      }),
    ).resolves.toEqual({
      status: "resolved",
      rootId: "link-sibling",
      path: "src/index.ts",
      rootVisibility: "link_only",
    });
    await expect(current.service.listRoots(owner, primary.id)).resolves.toEqual(
      {
        roots: [expect.objectContaining({ rootId: "primary" })],
      },
    );
    expect(current.roots.rememberLinkRoot).toHaveBeenCalledWith(
      owner,
      primary.id,
      "/worktrees/sibling",
      expect.any(Number),
    );

    current.roots.findLinkRoot.mockReturnValue(linkRoot);
    await expect(
      current.service.read(
        owner,
        primary.id,
        "link-sibling" as never,
        "src/index.ts",
      ),
    ).resolves.toMatchObject({
      availability: "available",
      rootId: "link-sibling",
      path: "src/index.ts",
    });
    expect(current.execution.validateWorkspace).toHaveBeenLastCalledWith(
      owner,
      primary.environmentId,
      "/worktrees/sibling",
    );
  });

  it("fails closed at the remembered link-root cap and preserves unexpected persistence failures", async () => {
    const files = provider();
    vi.mocked(files.discoverFileLinkRoot).mockResolvedValue({
      canonicalPath: "/worktrees/sibling",
      relativePath: "src/index.ts",
    });
    const current = fixture({ files });
    vi.mocked(files.resolveFileLink).mockImplementation(async (_scope, root) =>
      root.canonicalPath === "/worktrees/sibling" ? "src/index.ts" : undefined,
    );
    current.roots.rememberLinkRoot.mockImplementation(() => {
      throw new DomainError(
        "conflict",
        "The workspace has reached its remembered file-link root limit.",
      );
    });

    const request = {
      reference: {
        kind: "absolute" as const,
        path: "/worktrees/sibling/src/index.ts",
      },
    };
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", request),
    ).resolves.toEqual({ status: "not_found" });

    current.roots.rememberLinkRoot.mockImplementation(() => {
      throw new Error("database closed");
    });
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", request),
    ).rejects.toThrow("database closed");
  });

  it("fails closed when discovered worktree authority or provider identity changes", async () => {
    const files = provider();
    vi.mocked(files.discoverFileLinkRoot).mockResolvedValue({
      canonicalPath: "/worktrees/sibling",
      relativePath: "src/index.ts",
    });
    const current = fixture({ files });
    current.execution.validateWorkspace.mockResolvedValue({
      canonicalPath: "/worktrees/other",
      summary: {
        id: "validated",
        environmentId: primary.environmentId,
        displayName: "other",
        displayPath: "/worktrees/other",
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
    });

    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "absolute",
          path: "/worktrees/sibling/src/index.ts",
        },
      }),
    ).resolves.toEqual({ status: "not_found" });
    expect(current.roots.rememberLinkRoot).not.toHaveBeenCalled();

    current.execution.validateWorkspace.mockImplementation(
      async (_scope, environmentId, candidatePath) => ({
        canonicalPath: candidatePath,
        summary: {
          id: "validated",
          environmentId,
          displayName: "validated",
          displayPath: candidatePath,
          availability: "available" as const,
          trustState: "trusted" as const,
          revision: 0,
        },
      }),
    );
    current.roots.rememberLinkRoot.mockReturnValue({
      rootId: "link-sibling",
      canonicalPath: "/worktrees/sibling",
      createdAt: 10,
    });
    vi.mocked(files.resolveFileLink).mockImplementation(async (_scope, root) =>
      root.canonicalPath === "/worktrees/sibling" ? "src/other.ts" : undefined,
    );
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "absolute",
          path: "/worktrees/sibling/src/index.ts",
        },
      }),
    ).resolves.toEqual({ status: "not_found" });
    expect(current.roots.rememberLinkRoot).not.toHaveBeenCalled();

    vi.mocked(files.discoverFileLinkRoot).mockResolvedValue({
      canonicalPath: "/worktrees/.ssh/repository",
      relativePath: "README.md",
    });
    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "absolute",
          path: "/worktrees/.ssh/repository/README.md",
        },
      }),
    ).resolves.toEqual({ status: "not_found" });
  });

  it("checks execution authority before probing an unmatched absolute file", async () => {
    const files = provider();
    const current = fixture({ files });
    current.execution.validateWorkspace.mockRejectedValue(
      new Error("workspace_not_allowed"),
    );

    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "absolute",
          path: "/outside/repository/README.md",
        },
      }),
    ).resolves.toEqual({ status: "not_found" });
    expect(files.discoverFileLinkRoot).not.toHaveBeenCalled();
    expect(current.roots.rememberLinkRoot).not.toHaveBeenCalled();
  });

  it("does not attempt worktree discovery on providers that cannot expose local roots", async () => {
    const files = provider();
    vi.mocked(files.supportsFileLinkRootDiscovery).mockReturnValue(false);
    const current = fixture({ files });

    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "absolute",
          path: "/worktrees/sibling/README.md",
        },
      }),
    ).resolves.toEqual({ status: "not_found" });
    expect(files.discoverFileLinkRoot).not.toHaveBeenCalled();
    expect(current.roots.rememberLinkRoot).not.toHaveBeenCalled();
  });

  it("does not resolve a supplemental file link after that root is deleted", async () => {
    const supplemental = {
      rootId: "root-link",
      canonicalPath: "/workspaces/context",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const records = [supplemental];
    const files = provider();
    const current = fixture({ files, roots: records });
    current.roots.remove.mockImplementation(() => {
      records.splice(0, records.length);
      return supplemental;
    });
    vi.mocked(files.resolveFileLink).mockImplementation(
      async (_scope, root) => {
        if (root.rootId === "primary") {
          await current.service.deleteRoot(
            owner,
            primary.id,
            supplemental.rootId as never,
            {
              mutationId: "34343434-3434-4434-8434-343434343434",
              expectedRevision: 1,
            },
          );
          return undefined;
        }
        return "README.md";
      },
    );

    await expect(
      current.service.resolveThreadFileLink(owner, "thread-1", {
        reference: {
          kind: "absolute",
          path: `${supplemental.canonicalPath}/README.md`,
        },
      }),
    ).resolves.toEqual({ status: "not_found" });
    expect(files.resolveFileLink).toHaveBeenCalledTimes(1);
  });

  it("keeps topology invalidation and successful watchers alive across root changes", async () => {
    const supplemental = {
      rootId: "root-new",
      canonicalPath: "/workspaces/context",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const records: (typeof supplemental)[] = [];
    const current = fixture({ roots: records });
    current.roots.create.mockImplementation(() => {
      records.push(supplemental);
      return supplemental;
    });
    const listener = vi.fn();
    const subscription = await current.service.watch(
      owner,
      primary.id,
      listener,
    );
    expect(current.files.watch).toHaveBeenCalledTimes(1);
    listener.mockClear();
    await current.service.attachRoot(owner, primary.id, {
      mutationId: "44444444-4444-4444-8444-444444444444",
      path: supplemental.canonicalPath,
      displayLabel: supplemental.displayLabel,
    });
    await vi.waitFor(() => {
      expect(current.files.watch).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalled();
    });
    subscription.close();
    current.service.close();
    expect(current.files.close).toHaveBeenCalledOnce();
  });

  it("reports a watcher start failure per root without failing the subscription", async () => {
    const files = provider();
    vi.mocked(files.watch).mockResolvedValue(undefined);
    const current = fixture({ files });
    const subscription = await current.service.watch(
      owner,
      primary.id,
      vi.fn(),
    );
    await expect(current.service.listRoots(owner, primary.id)).resolves.toEqual(
      {
        roots: [
          expect.objectContaining({ rootId: "primary", watchable: false }),
        ],
      },
    );
    subscription.close();
  });

  it("does not lose topology changes published during initial watcher setup", async () => {
    let releaseInitial!: () => void;
    const initialReady = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const files = provider();
    vi.mocked(files.watch).mockImplementation(async () => {
      if (vi.mocked(files.watch).mock.calls.length === 1) await initialReady;
      return {
        failed: new Promise<void>(() => undefined),
        close: vi.fn(),
      };
    });
    const records: any[] = [];
    const current = fixture({ files, roots: records });
    current.roots.create.mockImplementation(() => {
      const record = {
        rootId: "root-during-setup",
        canonicalPath: "/workspaces/context",
        displayLabel: "Context",
        sortOrder: 0,
        availability: "available",
        revision: 1,
      };
      records.push(record);
      return record;
    });
    const watching = current.service.watch(owner, primary.id, vi.fn());
    await vi.waitFor(() => expect(files.watch).toHaveBeenCalledTimes(1));
    await current.service.attachRoot(owner, primary.id, {
      mutationId: "55555555-5555-4555-8555-555555555555",
      path: "/workspaces/context",
      displayLabel: "Context",
    });
    releaseInitial();
    const subscription = await watching;
    expect(files.watch).toHaveBeenCalledTimes(2);
    subscription.close();
  });

  it("reuses watcher capacity by retaining unchanged roots and closing removals first", async () => {
    const oldRoot = {
      rootId: "root-old",
      canonicalPath: "/workspaces/old-context",
      displayLabel: "Old context",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const records: any[] = [oldRoot];
    const files = provider();
    let active = 0;
    let peak = 0;
    vi.mocked(files.watch).mockImplementation(async () => {
      if (active >= 2) return undefined;
      active += 1;
      peak = Math.max(peak, active);
      let subscriptionClosed = false;
      return {
        failed: new Promise<void>(() => undefined),
        close: () => {
          if (subscriptionClosed) return;
          subscriptionClosed = true;
          active -= 1;
        },
      };
    });
    const current = fixture({ files, roots: records });
    current.roots.remove.mockImplementation(() => {
      records.splice(0, records.length);
      return oldRoot;
    });
    current.roots.create.mockImplementation(() => {
      const record = {
        rootId: "root-new",
        canonicalPath: "/workspaces/new-context",
        displayLabel: "New context",
        sortOrder: 0,
        availability: "available",
        revision: 1,
      };
      records.push(record);
      return record;
    });
    const subscription = await current.service.watch(
      owner,
      primary.id,
      vi.fn(),
    );
    expect(active).toBe(2);
    await current.service.deleteRoot(
      owner,
      primary.id,
      oldRoot.rootId as never,
      {
        mutationId: "88888888-8888-4888-8888-888888888888",
        expectedRevision: 1,
      },
    );
    await vi.waitFor(() => expect(active).toBe(1));
    expect(files.watch).toHaveBeenCalledTimes(2);
    await current.service.attachRoot(owner, primary.id, {
      mutationId: "99999999-9999-4999-8999-999999999999",
      path: "/workspaces/new-context",
      displayLabel: "New context",
    });
    await vi.waitFor(() => expect(active).toBe(2));
    expect(files.watch).toHaveBeenCalledTimes(3);
    expect(peak).toBe(2);
    const roots = await current.service.listRoots(owner, primary.id);
    expect(roots.roots.at(1)).toMatchObject({
      rootId: "root-new",
      watchable: true,
    });
    subscription.close();
    expect(active).toBe(0);
  });

  it("marks a root unwatchable after an unexpected runtime watcher failure", async () => {
    let fail!: () => void;
    const failed = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const files = provider();
    vi.mocked(files.watch).mockResolvedValue({ failed, close: vi.fn() });
    const current = fixture({ files });
    const listener = vi.fn();
    const subscription = await current.service.watch(
      owner,
      primary.id,
      listener,
    );
    listener.mockClear();
    fail();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    await expect(current.service.listRoots(owner, primary.id)).resolves.toEqual(
      {
        roots: [
          expect.objectContaining({ rootId: "primary", watchable: false }),
        ],
      },
    );
    subscription.close();
  });

  it("retries root projection when a concurrent delete wins availability persistence", async () => {
    const supplemental = {
      rootId: "root-deleted",
      canonicalPath: "/workspaces/context",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const current = fixture({ roots: [supplemental] });
    current.roots.list
      .mockReturnValueOnce([supplemental])
      .mockReturnValueOnce([]);
    current.roots.setAvailability.mockImplementationOnce(() => {
      throw new DomainError("not_found", "concurrently deleted");
    });
    await expect(current.service.listRoots(owner, primary.id)).resolves.toEqual(
      {
        roots: [expect.objectContaining({ rootId: "primary" })],
      },
    );
    expect(current.roots.list).toHaveBeenCalledTimes(2);
  });

  it("replays a committed attach before inventory and mutable policy checks", async () => {
    const current = fixture();
    current.roots.replayCreate.mockReturnValue({
      rootId: "root-replayed",
      canonicalPath: "/old/location",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available",
      revision: 1,
    });
    vi.mocked(current.files.supportsSupplementalRoots).mockReturnValue(false);
    vi.mocked(current.files.supportsWatching).mockReturnValue(false);
    await expect(
      current.service.attachRoot(owner, primary.id, {
        mutationId: "11111111-1111-4111-8111-111111111111",
        path: "/old/location",
      }),
    ).resolves.toEqual({
      root: expect.objectContaining({
        rootId: "root-replayed",
        availability: "available",
        watchable: false,
      }),
    });
    expect(current.execution.validateWorkspace).not.toHaveBeenCalled();
    expect(current.roots.create).not.toHaveBeenCalled();
  });

  it("requires live provider root validation before persisting a supplemental root", async () => {
    const files = provider();
    vi.mocked(files.validateRoot).mockRejectedValue(
      new WorkspaceFileRootUnavailableError(),
    );
    const current = fixture({ files });

    await expect(
      current.service.attachRoot(owner, primary.id, {
        mutationId: "mutation-root-validation",
        path: "/workspaces/context",
        displayLabel: "Context",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(files.validateRoot).toHaveBeenCalledWith(owner, {
      workspaceId: primary.id,
      environmentId: primary.environmentId,
      rootKind: "supplemental",
      canonicalPath: "/workspaces/context",
    });
    expect(current.roots.create).not.toHaveBeenCalled();
  });

  it.each(["/workspaces", "/workspaces/one/nested"])("attaches supplemental root %s", async (canonicalPath) => {
    const current = fixture();
    current.roots.create.mockImplementation((_scope, _workspaceId, input) => ({
      rootId: "root-home",
      canonicalPath: (input as { canonicalPath: string }).canonicalPath,
      displayLabel: (input as { resolvedDisplayLabel: string })
        .resolvedDisplayLabel,
      sortOrder: 0,
      availability: "available",
      revision: 1,
    }));

    await expect(
      current.service.attachRoot(owner, primary.id, {
        mutationId: "ancestor-root-attachment",
        path: canonicalPath,
        displayLabel: "Home",
      }),
    ).resolves.toEqual({
      root: expect.objectContaining({
        rootId: "root-home",
        displayLabel: "Home",
        availability: "available",
      }),
    });
    expect(current.files.validateRoot).toHaveBeenCalledWith(owner, {
      workspaceId: primary.id,
      environmentId: primary.environmentId,
      rootKind: "supplemental",
      canonicalPath,
    });
    expect(current.roots.create).toHaveBeenCalledOnce();
  });

  it("drains an authorized write before committing root deletion", async () => {
    const supplemental = {
      rootId: "root-write",
      canonicalPath: "/workspaces/context",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const files = provider();
    let releaseWrite!: () => void;
    const writeReady = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    vi.mocked(files.write).mockImplementation(async (_scope, root, input) => {
      await writeReady;
      return {
        availability: "available",
        rootId: root.rootId,
        path: input.path,
        sizeBytes: input.content.length,
        revision: "revision-2",
      };
    });
    const current = fixture({ files, roots: [supplemental] });
    current.roots.remove.mockReturnValue(supplemental);
    const writing = current.service.write(owner, primary.id, {
      rootId: supplemental.rootId as never,
      path: "notes.md",
      content: "changed",
      expectedRevision: "revision-1",
    });
    await vi.waitFor(() => expect(files.write).toHaveBeenCalledOnce());
    const deleting = current.service.deleteRoot(
      owner,
      primary.id,
      supplemental.rootId as never,
      {
        mutationId: "66666666-6666-4666-8666-666666666666",
        expectedRevision: 1,
      },
    );
    await Promise.resolve();
    expect(current.roots.remove).not.toHaveBeenCalled();
    await expect(
      current.service.write(owner, primary.id, {
        rootId: supplemental.rootId as never,
        path: "second.md",
        content: "must not start",
        expectedRevision: "revision-1",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(files.write).toHaveBeenCalledOnce();
    releaseWrite();
    await expect(writing).resolves.toMatchObject({ revision: "revision-2" });
    await expect(deleting).resolves.toEqual({ rootId: supplemental.rootId });
    expect(current.roots.remove).toHaveBeenCalledOnce();
    expect(current.service.retainedRootOperationLifecycleCount).toBe(0);
  });

  it("cancels an exact download before draining and deleting its root", async () => {
    const supplemental = {
      rootId: "root-download",
      canonicalPath: "/workspaces/context",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const files = provider();
    let markStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    vi.mocked(files.withDownload).mockImplementation(
      async (_scope, _root, input, operation, signal) => {
        observedSignal = signal;
        return await operation({
          path: input.path,
          fileName: "notes.md",
          sizeBytes: 7,
          revision: input.expectedRevision,
          stream: async () => {
            markStreamStarted();
            await new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          },
        });
      },
    );
    const current = fixture({ files, roots: [supplemental] });
    current.roots.remove.mockReturnValue(supplemental);
    const downloading = current.service.withDownload(
      owner,
      primary.id,
      {
        rootId: supplemental.rootId as never,
        path: "notes.md",
        expectedRevision: "revision-1",
      },
      async (source) => source.stream(async () => undefined),
    );
    await streamStarted;
    const deleting = current.service.deleteRoot(
      owner,
      primary.id,
      supplemental.rootId as never,
      {
        mutationId: "67676767-6767-4676-8676-676767676767",
        expectedRevision: 1,
      },
    );
    await expect(downloading).rejects.toMatchObject({ code: "not_found" });
    expect(observedSignal?.aborted).toBe(true);
    await expect(deleting).resolves.toEqual({ rootId: supplemental.rootId });
    expect(current.roots.remove).toHaveBeenCalledOnce();
    expect(current.service.retainedRootOperationLifecycleCount).toBe(0);
  });

  it("drains an authorized linked-worktree write before removing its checkout", async () => {
    const linked = {
      rootId: "9abdbdbd-a151-463e-88a4-ce5844a5ee89",
      canonicalPath: "/worktrees/one-topic",
      canonicalCheckoutPath: "/worktrees/one-topic",
      canonicalGitDir: "/workspaces/one/.git/worktrees/one-topic",
      identityToken: "1".repeat(64),
      displayLabel: "topic",
      branchRef: "refs/heads/feature/topic",
      headOid: "a".repeat(40),
      provenanceKind: "unmerged" as const,
      aheadCount: 1,
      behindCount: 0,
      availability: "available" as const,
      revision: 3,
    };
    const files = provider();
    let releaseWrite!: () => void;
    const writeReady = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    vi.mocked(files.write).mockImplementation(async (_scope, root, input) => {
      await writeReady;
      return {
        availability: "available",
        rootId: root.rootId,
        path: input.path,
        sizeBytes: input.content.length,
        revision: "revision-2",
      };
    });
    const current = fixture({ files, linkedWorktrees: [linked] });
    const writing = current.service.write(owner, primary.id, {
      rootId: linked.rootId as never,
      path: "notes.md",
      content: "changed",
      expectedRevision: "revision-1",
    });
    await vi.waitFor(() => expect(files.write).toHaveBeenCalledOnce());

    const deleting = current.service.deleteLinkedWorktree(
      owner,
      primary.id,
      linked.rootId as never,
      {
        mutationId: "68686868-6868-4686-8686-686868686868",
        expectedRevision: linked.revision,
        confirmation: true,
      },
    );
    await vi.waitFor(() =>
      expect(
        current.linkedWorktrees.hasOtherWorkspaceOverlap,
      ).toHaveBeenCalled(),
    );
    await Promise.resolve();
    expect(files.removeLinkedWorktree).not.toHaveBeenCalled();
    await expect(
      current.service.write(owner, primary.id, {
        rootId: linked.rootId as never,
        path: "second.md",
        content: "must not start",
        expectedRevision: "revision-1",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(files.write).toHaveBeenCalledOnce();

    releaseWrite();
    await expect(writing).resolves.toMatchObject({ revision: "revision-2" });
    await expect(deleting).resolves.toEqual({
      rootId: linked.rootId,
      outcome: "removed",
      clearedThreadIds: [],
    });
    expect(files.removeLinkedWorktree).toHaveBeenCalledOnce();
    expect(current.linkedWorktrees.forget).toHaveBeenCalledOnce();
    expect(current.service.retainedRootOperationLifecycleCount).toBe(0);
  });

  it("replays a committed delete before mutable workspace validation", async () => {
    const current = fixture();
    current.roots.replayRemove.mockReturnValue({
      rootId: "root-deleted",
      canonicalPath: "/old/location",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available",
      revision: 1,
    });
    current.inventory.getWorkspace.mockImplementation(() => {
      throw new Error("workspace was deleted after the committed response");
    });
    await expect(
      current.service.deleteRoot(owner, primary.id, "root-deleted" as never, {
        mutationId: "77777777-7777-4777-8777-777777777777",
        expectedRevision: 1,
      }),
    ).resolves.toEqual({ rootId: "root-deleted" });
    expect(current.inventory.getWorkspace).not.toHaveBeenCalled();
    expect(current.roots.remove).not.toHaveBeenCalled();
  });

  it("rejects unsupported, overlapping, and sensitive attaches without persistence", async () => {
    const unsupportedFiles = provider();
    vi.mocked(unsupportedFiles.supportsSupplementalRoots).mockReturnValue(
      false,
    );
    const unsupported = fixture({ files: unsupportedFiles });
    await expect(
      unsupported.service.attachRoot(owner, primary.id, {
        mutationId: "11111111-1111-4111-8111-111111111111",
        path: "/workspaces/context",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(unsupported.roots.create).not.toHaveBeenCalled();

    const overlapping = fixture();
    await expect(
      overlapping.service.attachRoot(owner, primary.id, {
        mutationId: "22222222-2222-4222-8222-222222222222",
        path: "/workspaces/one",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(overlapping.roots.create).not.toHaveBeenCalled();

    const sensitive = fixture();
    await expect(
      sensitive.service.attachRoot(owner, primary.id, {
        mutationId: "33333333-3333-4333-8333-333333333333",
        path: "/workspaces/.ssh/context",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(sensitive.roots.create).not.toHaveBeenCalled();
  });

  it("contains a root disappearance to that root across list and status", async () => {
    const files = provider();
    vi.mocked(files.list).mockRejectedValue(
      new WorkspaceFileRootUnavailableError(),
    );
    vi.mocked(files.status).mockImplementation(async (_scope, root) => {
      if (root.rootId !== "primary") {
        throw new WorkspaceFileRootUnavailableError();
      }
      return {
        availability: "available",
        rootId: root.rootId,
        isGitRepository: false,
        entries: [],
        truncated: false,
      };
    });
    const current = fixture({
      files,
      roots: [
        {
          rootId: "root-1",
          canonicalPath: "/workspaces/context",
          displayLabel: "Context",
          sortOrder: 0,
          availability: "available",
          revision: 1,
        },
      ],
    });
    await expect(
      current.service.list(owner, primary.id, {
        rootId: "primary",
        pageSize: 10,
      }),
    ).resolves.toMatchObject({
      availability: "unavailable",
      rootId: "primary",
    });
    await expect(current.service.status(owner, primary.id)).resolves.toEqual({
      roots: [
        expect.objectContaining({
          rootId: "primary",
          availability: "available",
        }),
        expect.objectContaining({
          rootId: "root-1",
          availability: "unavailable",
        }),
      ],
    });
  });

  it("does not run status against a supplemental target removed after enumeration", async () => {
    const supplemental = {
      rootId: "root-stale-status",
      canonicalPath: "/workspaces/context",
      displayLabel: "Context",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    const current = fixture({ roots: [supplemental] });
    current.roots.list.mockReturnValueOnce([supplemental]).mockReturnValue([]);

    await expect(current.service.status(owner, primary.id)).resolves.toEqual({
      roots: [
        expect.objectContaining({
          rootId: "primary",
          availability: "available",
        }),
        expect.objectContaining({
          rootId: supplemental.rootId,
          availability: "unavailable",
        }),
      ],
    });
    expect(current.files.status).toHaveBeenCalledTimes(1);
    expect(current.files.status).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ rootId: "primary" }),
    );
  });

  it("denies a root ID from another workspace without primary fallback", async () => {
    const current = fixture();
    await expect(
      current.service.list(owner, primary.id, {
        rootId: "root-from-another-workspace" as never,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(current.files.list).not.toHaveBeenCalled();
  });

  it("does not retain operation lifecycle entries for unvalidated root IDs", async () => {
    const current = fixture();
    for (let index = 0; index < 100; index += 1) {
      await expect(
        current.service.list(owner, primary.id, {
          rootId: `garbage-root-${index}` as never,
          pageSize: 10,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    expect(current.service.retainedRootOperationLifecycleCount).toBe(0);
  });

  it("allows a legitimate dot-dot-prefixed sibling directory", async () => {
    const current = fixture();
    const record = {
      rootId: "root-dotdot-data",
      canonicalPath: "/workspaces/..data",
      displayLabel: "..data",
      sortOrder: 0,
      availability: "available" as const,
      revision: 1,
    };
    current.roots.create.mockReturnValue(record);
    await expect(
      current.service.attachRoot(owner, primary.id, {
        mutationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        path: record.canonicalPath,
      }),
    ).resolves.toEqual({
      root: expect.objectContaining({
        rootId: record.rootId,
        displayLabel: "..data",
      }),
    });
  });
});
