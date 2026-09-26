import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFilesSidecarHost } from "../../src/server/sidecar/workspace-files-sidecar-host.js";
import type { WorkspaceFilesEngine } from "../../src/server/workspace-files/workspace-files-engine.js";
import type { WorkspaceDiffsEngine } from "../../src/server/workspace-files/workspace-diffs-engine.js";
import { workspaceDiffRepositoryIdSchema } from "../../src/shared/protocol/workspace-diffs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WorkspaceFilesSidecarHost", () => {
  it("rechecks the checkout removal path against the declared policy root", async () => {
    const policy = await mkdtemp(
      path.join(tmpdir(), "h-sidecar-remove-policy-"),
    );
    const outside = await mkdtemp(
      path.join(tmpdir(), "h-sidecar-remove-outside-"),
    );
    roots.push(policy, outside);
    const workspace = path.join(policy, "workspace");
    const linked = path.join(policy, "linked");
    await Promise.all([mkdir(workspace), mkdir(linked)]);
    const removeLinkedWorktree = vi.fn(async () => undefined);
    const engine = {
      validateRoot: async () => undefined,
      removeLinkedWorktree,
      close: vi.fn(),
    } as unknown as WorkspaceFilesEngine;
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      engine,
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => {
        throw new Error("unexpected_download_stream");
      },
      onDownloadCleanupFailure: () => undefined,
    });
    try {
      const primary = await host.handlers.rootOpen(
        {
          admissionId: "de8e220b-0000-4000-8000-000000000060",
          rootId: "primary",
          rootKind: "primary",
          declaredPath: workspace,
          policyRootPath: policy,
        },
        context(),
      );
      const request = {
        operationId: randomUUID(),
        rootHandle: primary.rootHandle,
        canonicalCheckoutPath: linked,
        policyRootPath: policy,
        canonicalGitDir: path.join(workspace, ".git", "worktrees", "linked"),
        identityToken: "1".repeat(64),
      };
      await expect(
        host.handlers.removeLinkedWorktree(request, context()),
      ).resolves.toEqual({ removed: true });
      expect(removeLinkedWorktree).toHaveBeenCalledWith(
        expect.anything(),
        request,
        expect.any(AbortSignal),
      );

      await expect(
        host.handlers.removeLinkedWorktree(
          {
            ...request,
            operationId: randomUUID(),
            canonicalCheckoutPath: outside,
          },
          context(),
        ),
      ).rejects.toMatchObject({ code: "workspace_file_root_unavailable" });
      expect(removeLinkedWorktree).toHaveBeenCalledTimes(1);
    } finally {
      host.close();
    }
  });

  it("releases a root admitted after every request for it stopped waiting", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-abandoned-"));
    roots.push(policy);
    const workspace = path.join(policy, "workspace");
    await mkdir(workspace);
    let validation = deferred<undefined>();
    const engine = {
      validateRoot: vi.fn(() => validation.promise),
      close: vi.fn(),
    } as unknown as WorkspaceFilesEngine;
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      engine,
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => {
        throw new Error("unexpected_download_stream");
      },
      onDownloadCleanupFailure: () => undefined,
    });
    const request = {
      admissionId: "de8e220b-0000-4000-8000-000000000070",
      rootId: "primary" as const,
      rootKind: "primary" as const,
      declaredPath: workspace,
      policyRootPath: policy,
    };
    const waiter = (controller: AbortController) => ({
      requestId: randomUUID(),
      signal: controller.signal,
    });
    try {
      // The original open and its recovery both time out before admission.
      const original = new AbortController();
      const recovery = new AbortController();
      const abandoned = [
        host.handlers.rootOpen(request, waiter(original)),
        host.handlers.rootOpen(request, waiter(recovery)),
      ];
      original.abort(new Error("sidecar_request_timeout"));
      recovery.abort(new Error("sidecar_request_timeout"));
      validation.resolve(undefined);
      const [first, second] = await Promise.all(abandoned);
      expect(second).toEqual(first);
      await expect(
        host.handlers.rootClose({ rootHandle: first!.rootHandle }, context()),
      ).rejects.toThrow();

      // One request still waiting keeps the admitted root.
      validation = deferred<undefined>();
      const retry = { ...request, admissionId: "de8e220b-0000-4000-8000-000000000071" };
      const gaveUp = new AbortController();
      const kept = [
        host.handlers.rootOpen(retry, waiter(gaveUp)),
        host.handlers.rootOpen(retry, context()),
      ];
      gaveUp.abort(new Error("sidecar_request_cancelled"));
      validation.resolve(undefined);
      const [, live] = await Promise.all(kept);
      expect(live!.rootHandle).not.toBe(first!.rootHandle);
      await expect(
        host.handlers.rootClose({ rootHandle: live!.rootHandle }, context()),
      ).resolves.toEqual({ closed: true });
    } finally {
      host.close();
    }
  });

  it("discovers linked worktrees only from a primary handle and admitted policy roots", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-worktrees-"));
    roots.push(policy);
    const workspace = path.join(policy, "workspace");
    const linked = path.join(policy, "linked");
    await Promise.all([mkdir(workspace), mkdir(linked)]);
    const discoverLinkedWorktrees = vi.fn(async () => ({
      worktrees: [
        {
          canonicalPath: linked,
          canonicalGitDir: path.join(workspace, ".git", "worktrees", "linked"),
          identityToken: "1".repeat(64),
          displayLabel: "feature/linked",
          branchRef: "refs/heads/feature/linked",
          headOid: "a".repeat(40),
        },
      ],
      truncated: false,
    }));
    const engine = {
      validateRoot: async () => undefined,
      discoverLinkedWorktrees,
      close: vi.fn(),
    } as unknown as WorkspaceFilesEngine;
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      engine,
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => {
        throw new Error("unexpected_download_stream");
      },
      onDownloadCleanupFailure: () => undefined,
    });
    try {
      const primary = await host.handlers.rootOpen(
        {
          admissionId: "de8e220b-0000-4000-8000-000000000070",
          rootId: "primary",
          rootKind: "primary",
          declaredPath: workspace,
          policyRootPath: policy,
        },
        context(),
      );
      await expect(
        host.handlers.discoverLinkedWorktrees(
          {
            rootHandle: primary.rootHandle,
            policyRootPaths: [policy],
          },
          context(),
        ),
      ).resolves.toEqual({
        worktrees: [expect.objectContaining({ canonicalPath: linked })],
        truncated: false,
      });
      expect(discoverLinkedWorktrees).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(AbortSignal),
        [policy],
      );

      const supplemental = await host.handlers.rootOpen(
        {
          admissionId: "de8e220b-0000-4000-8000-000000000071",
          rootId: "de8e220b-0000-4000-8000-000000000072",
          rootKind: "supplemental",
          declaredPath: linked,
          policyRootPath: policy,
        },
        context(),
      );
      await expect(
        host.handlers.discoverLinkedWorktrees(
          {
            rootHandle: supplemental.rootHandle,
            policyRootPaths: [policy],
          },
          context(),
        ),
      ).rejects.toMatchObject({
        code: "sidecar_linked_worktree_primary_root_required",
      });
    } finally {
      host.close();
    }
  });

  it("streams revision-pinned exact bytes and emits a complete terminal", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-download-"));
    roots.push(policy);
    const workspace = path.join(policy, "workspace");
    await mkdir(workspace);
    const expected = Buffer.from("exact remote file bytes\0binary", "utf8");
    await writeFile(path.join(workspace, "artifact.bin"), expected);
    const retained: Uint8Array[] = [];
    const terminal = deferred<unknown>();
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => ({
        streamId: "de8e220b-0000-4000-8000-000000000099",
        send: async (channel, bytes) => {
          expect(channel).toBe("data");
          retained.push(Uint8Array.from(bytes));
        },
        terminal: async (payload) => terminal.resolve(payload),
      }),
      onDownloadCleanupFailure: () => undefined,
    });
    try {
      const opened = await host.handlers.rootOpen(
        {
          admissionId: "de8e220b-0000-4000-8000-000000000098",
          rootId: "primary",
          rootKind: "primary",
          declaredPath: workspace,
          policyRootPath: policy,
        },
        context(),
      );
      const preview = await host.handlers.read(
        { rootHandle: opened.rootHandle, path: "artifact.bin" },
        context(),
      );
      const metadata = await host.handlers.downloadStart(
        {
          rootHandle: opened.rootHandle,
          path: "artifact.bin",
          expectedRevision: preview.revision,
          streamId: "de8e220b-0000-4000-8000-000000000099",
          initialCreditBytes: 512 * 1024,
        },
        context(),
      );
      expect(metadata).toMatchObject({
        path: "artifact.bin",
        fileName: "artifact.bin",
        sizeBytes: expected.byteLength,
        revision: preview.revision,
      });
      await expect(terminal.promise).resolves.toEqual({
        outcome: "complete",
        sizeBytes: expected.byteLength,
        revision: preview.revision,
      });
      expect(
        Buffer.concat(retained.map((chunk) => Buffer.from(chunk))),
      ).toEqual(expected);
    } finally {
      host.close();
    }
  });

  it("acknowledges cancellation only after the terminal record is sent", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-cancel-"));
    roots.push(policy);
    const workspace = path.join(policy, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "artifact.bin"), "download");
    const sendStarted = deferred<void>();
    const terminalStarted = deferred<void>();
    const releaseTerminal = deferred<void>();
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => ({
        streamId: "de8e220b-0000-4000-8000-000000000089",
        send: async (_channel, _bytes, options) => {
          sendStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
        terminal: async () => {
          terminalStarted.resolve();
          await releaseTerminal.promise;
        },
      }),
      onDownloadCleanupFailure: () => undefined,
    });
    try {
      const opened = await host.handlers.rootOpen(
        {
          admissionId: "de8e220b-0000-4000-8000-000000000088",
          rootId: "primary",
          rootKind: "primary",
          declaredPath: workspace,
          policyRootPath: policy,
        },
        context(),
      );
      const preview = await host.handlers.read(
        { rootHandle: opened.rootHandle, path: "artifact.bin" },
        context(),
      );
      await host.handlers.downloadStart(
        {
          rootHandle: opened.rootHandle,
          path: "artifact.bin",
          expectedRevision: preview.revision,
          streamId: "de8e220b-0000-4000-8000-000000000089",
          initialCreditBytes: 512 * 1024,
        },
        context(),
      );
      await sendStarted.promise;
      let acknowledged = false;
      const cancellation = Promise.resolve(
        host.handlers.downloadCancel(
          {
            streamId: "de8e220b-0000-4000-8000-000000000089",
          },
          context(),
        ),
      ).then((result) => {
        acknowledged = true;
        return result;
      });
      await terminalStarted.promise;
      expect(acknowledged).toBe(false);
      releaseTerminal.resolve();
      await expect(cancellation).resolves.toEqual({ cancelled: true });
    } finally {
      host.close();
    }
  });

  it("binds comparison discovery to the admitted opaque root handle", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-diff-"));
    roots.push(policy);
    const workspace = path.join(policy, "workspace");
    await mkdir(workspace);
    const repositoryId = workspaceDiffRepositoryIdSchema.parse(
      "de8e220b-0000-4000-8000-000000000090",
    );
    const repositories = vi.fn(async () => ({
      status: "available" as const,
      repositories: [
        { repositoryId, repositoryKey: "repository-key-0001", rootId: "primary" as const, displayName: "workspace" },
      ],
    }));
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      diffsEngine: { repositories } as unknown as WorkspaceDiffsEngine,
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => {
        throw new Error("unexpected_download_stream");
      },
      onDownloadCleanupFailure: () => undefined,
    });
    try {
      const opened = await host.handlers.rootOpen(
        {
          admissionId: "de8e220b-0000-4000-8000-000000000091",
          rootId: "primary",
          rootKind: "primary",
          declaredPath: workspace,
          policyRootPath: policy,
        },
        context(),
      );
      await expect(
        host.handlers.diffRepositories(
          { rootHandle: opened.rootHandle },
          context(),
        ),
      ).resolves.toMatchObject({ status: "available" });
      expect(repositories).toHaveBeenCalledWith(
        expect.objectContaining({
          canonicalPath: workspace,
          durableRootKey: `primary\0primary\0${policy}\0${workspace}`,
          rootId: "primary",
          operationKey: expect.stringContaining(opened.rootHandle),
        }),
        expect.any(AbortSignal),
      );
    } finally {
      host.close();
    }
  });

  it("admits canonical policy-contained roots and runs the shared Files engine", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-host-"));
    roots.push(policy);
    const workspace = path.join(policy, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "note.txt"), "before\n");
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "a.ts"), "a\n");
    await writeFile(path.join(workspace, "src", "b.ts"), "b\n");
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => {
        throw new Error("unexpected_download_stream");
      },
      onDownloadCleanupFailure: () => undefined,
    });
    try {
      const opened = await host.handlers.rootOpen(
        {
          admissionId: "de8e220b-0000-4000-8000-000000000001",
          rootId: "primary",
          rootKind: "primary",
          declaredPath: workspace,
          policyRootPath: policy,
        },
        context(),
      );
      const listed = await host.handlers.list(
        { rootHandle: opened.rootHandle, pageSize: 100 },
        context(),
      );
      expect(listed.entries).toContain("note.txt");
      const firstDirectoryPage = await host.handlers.listDirectory(
        {
          rootHandle: opened.rootHandle,
          directory: "src",
          pageSize: 1,
        },
        context(),
      );
      expect(firstDirectoryPage).toMatchObject({
        directory: "src",
        entries: [{ path: "src/a.ts", kind: "file" }],
        nextCursor: expect.any(String),
      });
      await expect(
        host.handlers.listDirectory(
          {
            rootHandle: opened.rootHandle,
            directory: "src",
            cursor: firstDirectoryPage.nextCursor,
            pageSize: 1,
          },
          context(),
        ),
      ).resolves.toMatchObject({
        directory: "src",
        entries: [{ path: "src/b.ts", kind: "file" }],
      });
      await rm(path.join(workspace, "src"), { recursive: true });
      await expect(
        host.handlers.listDirectory(
          {
            rootHandle: opened.rootHandle,
            directory: "src",
            pageSize: 10,
          },
          context(),
        ),
      ).rejects.toMatchObject({ code: "workspace_file_not_found" });
      const read = await host.handlers.read(
        { rootHandle: opened.rootHandle, path: "note.txt" },
        context(),
      );
      expect(read).toMatchObject({
        contentKind: "text",
        content: "before\n",
      });
      const written = await host.handlers.write(
        {
          operationId: randomUUID(),
          rootHandle: opened.rootHandle,
          path: "note.txt",
          content: "after\n",
          expectedRevision: read.revision,
        },
        context(),
      );
      expect(written).toMatchObject({ path: "note.txt", sizeBytes: 6 });
      await expect(
        host.handlers.status({ rootHandle: opened.rootHandle }, context()),
      ).resolves.toMatchObject({ isGitRepository: false, entries: [] });
      await expect(
        host.handlers.resolveLink(
          {
            rootHandle: opened.rootHandle,
            reference: { kind: "workspace_relative", path: "note.txt" },
          },
          context(),
        ),
      ).resolves.toEqual({ status: "resolved", path: "note.txt" });
      await expect(
        host.handlers.discoverLinkRoot(
          {
            absolutePath: path.join(workspace, "note.txt"),
            policyRootPath: policy,
          },
          context(),
        ),
      ).resolves.toMatchObject({
        status: "discovered",
        declaredRootPath: workspace,
        relativePath: "note.txt",
      });
      const watch = await host.handlers.watchOpen(
        { rootHandle: opened.rootHandle },
        context(),
      );
      await expect(
        host.handlers.watchClose(
          { subscriptionHandle: watch.subscriptionHandle },
          context(),
        ),
      ).resolves.toEqual({ closed: true });
      await expect(
        host.handlers.rootOpen(
          {
            admissionId: "de8e220b-0000-4000-8000-000000000001",
            rootId: "primary",
            rootKind: "supplemental",
            declaredPath: workspace,
            policyRootPath: policy,
          },
          context(),
        ),
      ).rejects.toMatchObject({ code: "sidecar_root_admission_mismatch" });
    } finally {
      host.close();
    }
  });

  it("keeps the durable diff root key stable across session restarts", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-restart-"));
    roots.push(policy);
    const workspace = path.join(policy, "workspace");
    await mkdir(workspace);
    const seenRoots: Array<{
      readonly durableRootKey: string;
      readonly operationKey: string;
    }> = [];
    const repositories = vi.fn(
      async (root: {
        readonly durableRootKey: string;
        readonly operationKey: string;
      }) => {
        seenRoots.push({
          durableRootKey: root.durableRootKey,
          operationKey: root.operationKey,
        });
        return {
          status: "available" as const,
          repositories: [],
        };
      },
    );
    const openAndCall = async (sessionNonce: string) => {
      const host = new WorkspaceFilesSidecarHost({
        sessionNonce,
        diffsEngine: { repositories } as unknown as WorkspaceDiffsEngine,
        sendInvalidation: async () => undefined,
        sendWatchFailure: async () => undefined,
        openDownloadStream: () => {
          throw new Error("unexpected_download_stream");
        },
        onDownloadCleanupFailure: () => undefined,
      });
      try {
        const opened = await host.handlers.rootOpen(
          {
            admissionId: "de8e220b-0000-4000-8000-000000000094",
            rootId: "primary",
            rootKind: "primary",
            declaredPath: workspace,
            policyRootPath: policy,
          },
          context(),
        );
        await host.handlers.diffRepositories(
          { rootHandle: opened.rootHandle },
          context(),
        );
      } finally {
        host.close();
      }
    };

    await openAndCall("n".repeat(32));
    await openAndCall("m".repeat(32));

    expect(repositories).toHaveBeenCalledTimes(2);
    expect(seenRoots).toHaveLength(2);
    const [firstRoot, secondRoot] = seenRoots;
    expect(firstRoot).toEqual(
      expect.objectContaining({
        durableRootKey: `primary\0primary\0${policy}\0${workspace}`,
      }),
    );
    expect(secondRoot).toEqual(
      expect.objectContaining({
        durableRootKey: `primary\0primary\0${policy}\0${workspace}`,
      }),
    );
    expect(firstRoot?.operationKey).not.toBe(secondRoot?.operationKey);
  });

  it("denies a root outside the configured policy", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-policy-"));
    const outside = await mkdtemp(path.join(tmpdir(), "h-sidecar-outside-"));
    roots.push(policy, outside);
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => {
        throw new Error("unexpected_download_stream");
      },
      onDownloadCleanupFailure: () => undefined,
    });
    try {
      await expect(
        host.handlers.rootOpen(
          {
            admissionId: "de8e220b-0000-4000-8000-000000000002",
            rootId: "primary",
            rootKind: "primary",
            declaredPath: outside,
            policyRootPath: policy,
          },
          context(),
        ),
      ).rejects.toMatchObject({ code: "workspace_file_root_unavailable" });
    } finally {
      host.close();
    }
  });

  it("revalidates a deleted or replaced root on the same session", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-validate-"));
    roots.push(policy);
    const workspace = path.join(policy, "workspace");
    const moved = path.join(policy, "moved");
    await mkdir(workspace);
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => {
        throw new Error("unexpected_download_stream");
      },
      onDownloadCleanupFailure: () => undefined,
    });
    const request = {
      rootKind: "primary" as const,
      declaredPath: workspace,
      policyRootPath: policy,
    };
    try {
      await expect(
        host.handlers.rootValidate(request, context()),
      ).resolves.toEqual({ validated: true });

      await rename(workspace, moved);
      await expect(
        host.handlers.rootValidate(request, context()),
      ).rejects.toMatchObject({ code: "workspace_file_root_unavailable" });

      await symlink(moved, workspace, "dir");
      await expect(
        host.handlers.rootOpen(
          {
            admissionId: "de8e220b-0000-4000-8000-000000000005",
            rootId: "primary",
            ...request,
          },
          context(),
        ),
      ).rejects.toMatchObject({ code: "workspace_file_root_unavailable" });
      await expect(
        host.handlers.rootValidate(request, context()),
      ).rejects.toMatchObject({ code: "workspace_file_root_unavailable" });
    } finally {
      host.close();
    }
  });

  it("emits one path-free terminal event when an established watch fails", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-watch-"));
    roots.push(policy);
    const workspace = path.join(policy, "workspace");
    await mkdir(workspace);
    const failure = deferred<void>();
    const sendWatchFailure = vi.fn(async () => undefined);
    const subscription = {
      failed: failure.promise,
      close: vi.fn(),
    };
    const engine = {
      validateRoot: async () => undefined,
      watch: async () => subscription,
      close: vi.fn(),
    } as unknown as WorkspaceFilesEngine;
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      engine,
      sendInvalidation: async () => undefined,
      sendWatchFailure,
      openDownloadStream: () => {
        throw new Error("unexpected_download_stream");
      },
      onDownloadCleanupFailure: () => undefined,
    });
    try {
      const opened = await host.handlers.rootOpen(
        {
          admissionId: "de8e220b-0000-4000-8000-000000000004",
          rootId: "primary",
          rootKind: "primary",
          declaredPath: workspace,
          policyRootPath: policy,
        },
        context(),
      );
      const watch = await host.handlers.watchOpen(
        { rootHandle: opened.rootHandle },
        context(),
      );
      failure.resolve();
      await vi.waitFor(() =>
        expect(sendWatchFailure).toHaveBeenCalledWith(watch.subscriptionHandle),
      );
      expect(sendWatchFailure).toHaveBeenCalledTimes(1);
      await expect(
        host.handlers.watchClose(
          { subscriptionHandle: watch.subscriptionHandle },
          context(),
        ),
      ).rejects.toMatchObject({ code: "sidecar_watch_handle_invalid" });
    } finally {
      host.close();
    }
  });
});

function context() {
  return {
    requestId: "de8e220b-0000-4000-8000-000000000003",
    signal: new AbortController().signal,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
