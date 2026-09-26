import { describe, expect, it, vi } from "vitest";
import {
  SidecarOperationError,
  SidecarProtocolDeliveryError,
  SIDECAR_WIRE_VERSION,
  workspaceFilesDiffChangedFilesOperation,
  workspaceFilesDiffRepositoriesOperation,
  workspaceFilesDiscoverLinkedWorktreesOperation,
  workspaceFilesDownloadCancelOperation,
  workspaceFilesDownloadStartOperation,
  workspaceFilesListDirectoryOperation,
  workspaceFilesRootCloseOperation,
  workspaceFilesRootOpenOperation,
  workspaceFilesRootValidateOperation,
  workspaceFilesResolveLinkOperation,
  workspaceFilesWriteOperation,
  workspaceFilesMutationInspectOperation,
} from "../../src/internal/sidecar-protocol/index.js";
import type { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import type {
  SidecarRuntimeOwner,
  SidecarRuntimeLease,
} from "../../src/server/sidecar/sidecar-runtime.js";
import type { SidecarServiceStatus } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { workspaceFileRootIdSchema } from "../../src/shared/index.js";
import {
  workspaceDiffComparisonIdSchema,
  workspaceDiffFileIdSchema,
  workspaceDiffFingerprintSchema,
} from "../../src/shared/protocol/workspace-diffs.js";
import {
  WorkspaceFileCursorInvalidError,
  WorkspaceFileWriteOutcomeUnknownError,
  WorkspaceFileProviderUnavailableError,
  WorkspaceFileRootUnavailableError,
  WORKSPACE_FILE_LINK_CANDIDATE_ROOT_ID,
  type WorkspaceFileRootTarget,
} from "../../src/server/workspace-files/contracts.js";
import { SidecarWorkspaceFileProvider } from "../../src/server/workspace-files/sidecar-workspace-file-provider.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978406";
const serviceStatus: SidecarServiceStatus = {
  scope: {
    installationId: "installation",
    ...scope,
    executionEnvironmentId: environmentId,
  },
  serviceIncarnation: "service-1",
  buildId: "fixture-build",
  artifactSha256: "a".repeat(64),
  runtimeWireVersion: SIDECAR_WIRE_VERSION,
  controllerEpoch: 1,
  attached: true,
  attachmentMode: "normal",
  state: "ready",
  desiredConfiguration: { environmentRevision: 1, operationsRevision: 1 },
  effectiveConfiguration: { environmentRevision: 1, operationsRevision: 1 },
  configurationState: "applied",
  resources: [],
  resourcesFingerprint: "b".repeat(64),
};
const root: WorkspaceFileRootTarget = {
  workspaceId: "019196f7-a0a8-7bc4-a89b-8cf013978407",
  environmentId,
  rootId: "primary",
  canonicalPath: "/srv/worktrees/project",
};

describe("SidecarWorkspaceFileProvider", () => {
  it("recovers a candidate root admitted by an interrupted open and never waits for its close", async () => {
    const openRoots = new Set<string>();
    const handlesByAdmission = new Map<string, string>();
    let stallOpen = true;
    let closes = 0;
    const session = {
      call: vi.fn((definition: unknown, input: { admissionId?: string; rootHandle?: string },
        options?: { signal?: AbortSignal }) => {
        if (definition === workspaceFilesRootOpenOperation) {
          // The host admits the root even when the caller stops waiting.
          const rootHandle = handlesByAdmission.get(input.admissionId!) ??
            `de8e220b-0000-4000-8000-${String(handlesByAdmission.size + 1).padStart(12, "0")}`;
          handlesByAdmission.set(input.admissionId!, rootHandle);
          openRoots.add(rootHandle);
          if (!stallOpen) return Promise.resolve({ rootHandle });
          return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort",
            () => reject(new SidecarProtocolDeliveryError("cancelled", "sent_outcome_unknown")), { once: true }));
        }
        if (definition === workspaceFilesRootCloseOperation) {
          closes += 1;
          openRoots.delete(input.rootHandle!);
          return new Promise(() => undefined);
        }
        if (definition === workspaceFilesResolveLinkOperation) return Promise.resolve({ status: "resolved", path: "image.png" });
        return Promise.reject(new Error("unexpected_operation"));
      }),
    } as unknown as SidecarClientSession;
    const runtime = {
      acquireOperation: vi.fn(async () => ({ session, carrierGeneration: 1, serviceStatus, release: vi.fn() })),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = providerFor(runtime);
    const candidate = { ...root, rootId: WORKSPACE_FILE_LINK_CANDIDATE_ROOT_ID, canonicalPath: "/srv/captures/slow" };
    const reference = { kind: "absolute" as const, path: "/srv/captures/slow/image.png" };
    const aborted = new AbortController();
    const interrupted = provider.resolveFileLink(scope, candidate, reference, aborted.signal);
    await vi.waitFor(() => expect(openRoots.size).toBe(1));
    aborted.abort(new Error("capture_deadline"));
    await expect(interrupted).rejects.toThrow("capture_deadline");
    expect(openRoots.size).toBe(1);
    stallOpen = false;
    // The same admission recovers the orphaned root; its close never answers.
    await expect(provider.resolveFileLink(scope, candidate, reference)).resolves.toBe("image.png");
    expect(closes).toBe(1);
    expect(openRoots.size).toBe(0);
    await provider.close();
  });

  it("closes transient link-candidate root handles after their operations while retaining listed roots", async () => {
    // Mirrors the sidecar root table: one handle per admission until root.close.
    const openRoots = new Map<string, string>();
    const handlesByAdmission = new Map<string, string>();
    let nextHandle = 0;
    const session = {
      call: vi.fn(async (definition: unknown, input: { admissionId?: string; rootId?: string; rootHandle?: string }) => {
        if (definition === workspaceFilesRootOpenOperation) {
          const existing = handlesByAdmission.get(input.admissionId!);
          if (existing) return { rootHandle: existing };
          const rootHandle = `de8e220b-0000-4000-8000-${String(++nextHandle).padStart(12, "0")}`;
          handlesByAdmission.set(input.admissionId!, rootHandle);
          openRoots.set(rootHandle, input.rootId!);
          return { rootHandle };
        }
        if (definition === workspaceFilesRootCloseOperation) {
          openRoots.delete(input.rootHandle!);
          for (const [admission, handle] of handlesByAdmission) {
            if (handle === input.rootHandle) handlesByAdmission.delete(admission);
          }
          return { closed: true };
        }
        if (definition === workspaceFilesResolveLinkOperation) return { status: "resolved", path: "image.png" };
        throw new Error("unexpected_operation");
      }),
    } as unknown as SidecarClientSession;
    const runtime = {
      acquireOperation: vi.fn(async () => ({ session, carrierGeneration: 1, serviceStatus, release: vi.fn() })),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = providerFor(runtime);
    const candidates = ["one", "two", "three"].map(name => ({
      root: { ...root, rootId: WORKSPACE_FILE_LINK_CANDIDATE_ROOT_ID, canonicalPath: `/srv/captures/${name}` },
      reference: { kind: "absolute" as const, path: `/srv/captures/${name}/image.png` },
    }));
    for (const { root: candidate, reference } of candidates) {
      await expect(provider.resolveFileLink(scope, candidate, reference)).resolves.toBe("image.png");
    }
    await Promise.all(Array.from({ length: 3 }, () =>
      provider.resolveFileLink(scope, candidates[0]!.root, candidates[0]!.reference)));
    await provider.resolveFileLink(scope, root, { kind: "absolute", path: "/srv/worktrees/project/image.png" });
    await provider.resolveFileLink(scope, root, { kind: "absolute", path: "/srv/worktrees/project/image.png" });
    expect([...openRoots.values()]).toEqual(["primary"]);
    // Concurrent users of one candidate share its handle and close it once.
    expect(vi.mocked(session.call).mock.calls.filter(([definition]) => definition === workspaceFilesRootCloseOperation))
      .toHaveLength(4);
    await provider.close();
  });

  it("discovers linked worktrees through one bounded remote operation lease", async () => {
    const release = vi.fn();
    const expected = {
      worktrees: [
        {
          canonicalPath: "/srv/worktrees/project-feature",
          canonicalGitDir:
            "/srv/worktrees/project/.git/worktrees/project-feature",
          identityToken: "1".repeat(64),
          displayLabel: "feature/linked",
          branchRef: "refs/heads/feature/linked",
          headOid: "a".repeat(40),
        },
      ],
      truncated: false,
    };
    const session = {
      call: vi.fn(async (definition: unknown, input: unknown) => {
        if (definition === workspaceFilesRootOpenOperation) {
          return { rootHandle: "de8e220b-0000-4000-8000-000000000010" };
        }
        if (definition === workspaceFilesDiscoverLinkedWorktreesOperation) {
          expect(input).toEqual({
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
            policyRootPaths: ["/srv", "/srv/worktrees"],
          });
          return expected;
        }
        throw new Error("unexpected_operation");
      }),
    } as unknown as SidecarClientSession;
    const runtime = {
      acquireOperation: vi.fn(async () => ({
        session,
        carrierGeneration: 1,
        serviceStatus,
        release,
      })),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = providerFor(runtime);
    await expect(
      provider.discoverLinkedWorktrees(scope, root),
    ).resolves.toEqual(expected);
    expect(release).toHaveBeenCalledOnce();
    await provider.close();
  });

  it("streams exact remote bytes under one operation lease and replenishes credit after consumption", async () => {
    const release = vi.fn();
    const addCredit = vi.fn(async () => undefined);
    let onData!: (record: {
      readonly sequence: number;
      readonly channel: "data";
      readonly bytes: Uint8Array;
    }) => void;
    let onTerminal!: (terminal: {
      readonly outcome: "complete";
      readonly sizeBytes: number;
      readonly revision: string;
    }) => void;
    const bytes = Buffer.from("remote exact bytes");
    const session = {
      closed: new Promise(() => undefined),
      registerIncomingWorkspaceFileDownload: vi.fn((input) => {
        onData = input.onData;
        onTerminal = input.onTerminal;
        return { addCredit, unregister: vi.fn() };
      }),
      call: vi.fn(async (definition: unknown) => {
        if (definition === workspaceFilesRootOpenOperation) {
          return {
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
          };
        }
        if (definition === workspaceFilesDownloadStartOperation) {
          queueMicrotask(() => {
            onData({ sequence: 0, channel: "data", bytes });
            onTerminal({
              outcome: "complete",
              sizeBytes: bytes.byteLength,
              revision: "revision-1",
            });
          });
          return {
            path: "artifact.bin",
            fileName: "artifact.bin",
            sizeBytes: bytes.byteLength,
            revision: "revision-1",
          };
        }
        throw new Error("unexpected_operation");
      }),
    } as unknown as SidecarClientSession;
    const runtime = {
      acquireOperation: vi.fn(async () => ({
        session,
        carrierGeneration: 1,
        serviceStatus,
        release,
      })),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = providerFor(runtime);
    const retained: Uint8Array[] = [];

    await expect(
      provider.withDownload(
        scope,
        root,
        { path: "artifact.bin", expectedRevision: "revision-1" },
        async (source) => {
          expect(release).not.toHaveBeenCalled();
          await source.stream(async (chunk) => {
            retained.push(Uint8Array.from(chunk));
          });
        },
      ),
    ).resolves.toBeUndefined();
    expect(Buffer.concat(retained.map((chunk) => Buffer.from(chunk)))).toEqual(
      bytes,
    );
    expect(addCredit).toHaveBeenCalledWith(bytes.byteLength);
    expect(release).toHaveBeenCalledOnce();
    await provider.close();
  });

  it("does not let a consumer stream signal override provider cancellation", async () => {
    const release = vi.fn();
    const cancel = vi.fn();
    let onData!: (record: {
      readonly sequence: number;
      readonly channel: "data";
      readonly bytes: Uint8Array;
    }) => void;
    const session = {
      closed: new Promise(() => undefined),
      registerIncomingWorkspaceFileDownload: vi.fn((input) => {
        onData = input.onData;
        return {
          addCredit: vi.fn(async () => undefined),
          unregister: vi.fn(),
        };
      }),
      call: vi.fn(async (definition: unknown) => {
        if (definition === workspaceFilesRootOpenOperation) {
          return {
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
          };
        }
        if (definition === workspaceFilesDownloadStartOperation) {
          queueMicrotask(() => {
            onData({
              sequence: 0,
              channel: "data",
              bytes: Buffer.from("partial"),
            });
          });
          return {
            path: "artifact.bin",
            fileName: "artifact.bin",
            sizeBytes: 20,
            revision: "revision-1",
          };
        }
        if (definition === workspaceFilesDownloadCancelOperation) {
          cancel();
          return { cancelled: true };
        }
        throw new Error("unexpected_operation");
      }),
    } as unknown as SidecarClientSession;
    const runtime = {
      acquireOperation: vi.fn(async () => ({
        session,
        carrierGeneration: 2,
        serviceStatus,
        release,
      })),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = providerFor(runtime);
    const providerController = new AbortController();
    const consumerController = new AbortController();
    const reason = new Error("root_removed");

    await expect(
      provider.withDownload(
        scope,
        root,
        { path: "artifact.bin", expectedRevision: "revision-1" },
        async (source) =>
          source.stream(async () => {
            providerController.abort(reason);
          }, consumerController.signal),
        providerController.signal,
      ),
    ).rejects.toBe(reason);
    expect(consumerController.signal.aborted).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await provider.close();
  });

  it("fails a partial remote download and releases its generation lease when the sidecar is lost", async () => {
    const closed = deferred<void>();
    const release = vi.fn();
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const session = {
      closed: closed.promise,
      registerIncomingWorkspaceFileDownload: vi.fn(() => ({
        addCredit: vi.fn(async () => undefined),
        unregister: vi.fn(),
      })),
      call: vi.fn(async (definition: unknown) => {
        if (definition === workspaceFilesRootOpenOperation) {
          return {
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
          };
        }
        if (definition === workspaceFilesDownloadStartOperation) {
          return {
            path: "artifact.bin",
            fileName: "artifact.bin",
            sizeBytes: 10,
            revision: "revision-1",
          };
        }
        throw new Error("unexpected_operation");
      }),
    } as unknown as SidecarClientSession;
    const runtime = {
      acquireOperation: vi.fn(async () => ({
        session,
        carrierGeneration: 9,
        serviceStatus,
        release,
      })),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = providerFor(runtime);
    const pending = provider.withDownload(
      scope,
      root,
      { path: "artifact.bin", expectedRevision: "revision-1" },
      async (source) => {
        streamStarted();
        await source.stream(async () => undefined);
      },
    );
    await started;
    closed.resolve();

    await expect(pending).rejects.toBeInstanceOf(
      WorkspaceFileProviderUnavailableError,
    );
    expect(release).toHaveBeenCalledOnce();
    await provider.close();
  });

  it("cancels a remote download after a bounded idle interval", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn();
      const cancel = vi.fn();
      let streamStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        streamStarted = resolve;
      });
      const session = {
        closed: new Promise(() => undefined),
        registerIncomingWorkspaceFileDownload: vi.fn(() => ({
          addCredit: vi.fn(async () => undefined),
          unregister: vi.fn(),
        })),
        call: vi.fn(async (definition: unknown) => {
          if (definition === workspaceFilesRootOpenOperation) {
            return {
              rootHandle: "de8e220b-0000-4000-8000-000000000010",
            };
          }
          if (definition === workspaceFilesDownloadStartOperation) {
            return {
              path: "artifact.bin",
              fileName: "artifact.bin",
              sizeBytes: 10,
              revision: "revision-1",
            };
          }
          if (definition === workspaceFilesDownloadCancelOperation) {
            cancel();
            return { cancelled: true };
          }
          throw new Error("unexpected_operation");
        }),
      } as unknown as SidecarClientSession;
      const runtime = {
        acquireOperation: vi.fn(async () => ({
          session,
          carrierGeneration: 10,
          serviceStatus,
          release,
        })),
      } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
      const provider = providerFor(runtime);
      const pending = provider.withDownload(
        scope,
        root,
        { path: "artifact.bin", expectedRevision: "revision-1" },
        async (source) => {
          streamStarted();
          await source.stream(async () => undefined);
        },
      );
      await started;
      const rejected = expect(pending).rejects.toBeInstanceOf(
        WorkspaceFileProviderUnavailableError,
      );
      await vi.advanceTimersByTimeAsync(2 * 60_000);

      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      await provider.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a download whose start response has an uncertain outcome", async () => {
    const release = vi.fn();
    const cancel = vi.fn();
    const session = {
      closed: new Promise(() => undefined),
      registerIncomingWorkspaceFileDownload: vi.fn(() => ({
        addCredit: vi.fn(async () => undefined),
        unregister: vi.fn(),
      })),
      call: vi.fn(async (definition: unknown) => {
        if (definition === workspaceFilesRootOpenOperation) {
          return {
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
          };
        }
        if (definition === workspaceFilesDownloadStartOperation) {
          throw new SidecarProtocolDeliveryError(
            "terminal_lost",
            "sent_outcome_unknown",
          );
        }
        if (definition === workspaceFilesDownloadCancelOperation) {
          cancel();
          return { cancelled: true };
        }
        throw new Error("unexpected_operation");
      }),
    } as unknown as SidecarClientSession;
    const runtime = {
      acquireOperation: vi.fn(async () => ({
        session,
        carrierGeneration: 11,
        serviceStatus,
        release,
      })),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = providerFor(runtime);

    await expect(
      provider.withDownload(
        scope,
        root,
        { path: "artifact.bin", expectedRevision: "revision-1" },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(WorkspaceFileProviderUnavailableError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await provider.close();
  });

  it("routes directory pages remotely and preserves invalid-cursor semantics", async () => {
    const session = fakeSession("one");
    vi.mocked(session.call).mockImplementation(
      async (definition: unknown, request: unknown) => {
        if (definition === workspaceFilesRootOpenOperation) {
          return {
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
          } as never;
        }
        if (definition === workspaceFilesListDirectoryOperation) {
          expect(request).toEqual({
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
            directory: "src",
            cursor: "retained-page",
            pageSize: 25,
          });
          throw new SidecarOperationError("workspace_file_list_cursor_invalid");
        }
        throw new Error("unexpected_operation");
      },
    );
    const provider = providerFor(fakeRuntime([session]));

    await expect(
      provider.listDirectory(scope, root, {
        directory: "src",
        cursor: "retained-page",
        pageSize: 25,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileCursorInvalidError);
    await provider.close();
  });

  it("cancels a remote comparison call and releases its operation lease", async () => {
    const controller = new AbortController();
    const reason = new Error("http_request_closed");
    const release = vi.fn();
    let comparisonStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      comparisonStarted = resolve;
    });
    const session = {
      closed: new Promise(() => undefined),
      call: vi.fn(
        async (
          definition: unknown,
          _request: unknown,
          options?: { readonly signal?: AbortSignal },
        ) => {
          expect(options?.signal).toBe(controller.signal);
          if (definition === workspaceFilesRootOpenOperation) {
            return {
              rootHandle: "de8e220b-0000-4000-8000-000000000010",
            } as never;
          }
          if (definition === workspaceFilesDiffRepositoriesOperation) {
            comparisonStarted();
            return await new Promise((_resolve, reject) =>
              options?.signal?.addEventListener(
                "abort",
                () => reject(options.signal?.reason),
                { once: true },
              ),
            );
          }
          throw new Error("unexpected_operation");
        },
      ),
    } as unknown as SidecarClientSession;
    const runtime = {
      acquireOperation: vi.fn(async () => ({
        session,
        carrierGeneration: 1,
        serviceStatus,
        release,
      })),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = providerFor(runtime);

    const pending = provider.diffRepositories(scope, root, controller.signal);
    await started;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(runtime.acquireOperation).toHaveBeenCalledWith(
      scope,
      environmentId,
      controller.signal,
    );
    expect(release).toHaveBeenCalledOnce();
    await provider.close();
  });

  it("routes comparison reads through the admitted remote root without local fallback", async () => {
    const comparisonId = workspaceDiffComparisonIdSchema.parse(randomUuid(31));
    const fileId = workspaceDiffFileIdSchema.parse(randomUuid(32));
    const fingerprint = workspaceDiffFingerprintSchema.parse(
      "state-fingerprint-0001",
    );
    const session = fakeSession("one");
    vi.mocked(session.call).mockImplementation(
      async (definition: unknown, request: unknown) => {
        if (definition === workspaceFilesRootOpenOperation) {
          return {
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
          } as never;
        }
        if (definition === workspaceFilesDiffChangedFilesOperation) {
          expect(request).toEqual({
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
            comparisonId,
            fingerprint,
            pageSize: 25,
          });
          return {
            status: "available",
            comparisonId,
            fingerprint,
            files: [
              {
                fileId,
                changeKind: "modified",
                oldPath: "src/file.ts",
                newPath: "src/file.ts",
                binary: false,
              },
            ],
            totalFiles: 1,
            truncated: false,
          } as never;
        }
        throw new Error("unexpected_operation");
      },
    );
    const provider = providerFor(fakeRuntime([session]));

    await expect(
      provider.diffChangedFiles(scope, root, {
        comparisonId,
        fingerprint,
        pageSize: 25,
      }),
    ).resolves.toMatchObject({ status: "available", totalFiles: 1 });
    expect(session.call).toHaveBeenCalledTimes(2);
    await provider.close();
  });

  it("uses the deepest configured policy root and maps lost write outcomes", async () => {
    const calls: Array<{ definition: unknown; request: unknown }> = [];
    const session = {
      closed: new Promise(() => undefined),
      call: vi.fn(async (definition: unknown, request: unknown) => {
        calls.push({ definition, request });
        if (definition === workspaceFilesRootOpenOperation) {
          return { rootHandle: "de8e220b-0000-4000-8000-000000000001" };
        }
        if (definition === workspaceFilesWriteOperation) {
          throw new SidecarProtocolDeliveryError(
            "terminal_lost",
            "sent_outcome_unknown",
          );
        }
        if (definition === workspaceFilesMutationInspectOperation)
          return { state: "unknown" };
        throw new Error("unexpected_operation");
      }),
      registerInvalidation: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as SidecarClientSession;
    const release = vi.fn();
    const runtime = {
      acquireAutomaticRecovery: vi.fn(async () => ({ session, carrierGeneration: 2, release })),
      acquireOperation: vi.fn(async () => ({
        session,
        carrierGeneration: 1,
        serviceStatus,
        release,
      })),
      acquireWatch: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = new SidecarWorkspaceFileProvider({
      scope,
      environmentId,
      policyRoots: ["/srv", "/srv/worktrees"],
      runtime,
    });
    await expect(
      provider.write(scope, root, {
        path: "note.txt",
        content: "changed",
        expectedRevision: "revision",
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileWriteOutcomeUnknownError);
    expect(calls[0]).toEqual({
      definition: workspaceFilesRootOpenOperation,
      request: expect.objectContaining({
        declaredPath: root.canonicalPath,
        policyRootPath: "/srv/worktrees",
        rootKind: "primary",
      }),
    });
    expect(release).toHaveBeenCalledTimes(2);
    expect(runtime.acquireAutomaticRecovery).toHaveBeenCalledOnce();
    expect(runtime.acquireOperation).toHaveBeenCalledOnce();
    expect(
      calls.filter(
        ({ definition }) => definition === workspaceFilesWriteOperation,
      ),
    ).toHaveLength(1);
    expect(calls.at(-1)?.definition).toBe(
      workspaceFilesMutationInspectOperation,
    );
    await provider.close();
    expect(runtime.close).not.toHaveBeenCalled();
    await runtime.close("test_runtime_owner_shutdown");
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("does not start for wrong scope and maps a not-sent write to unavailable", async () => {
    const session = fakeSession("one");
    vi.mocked(session.call).mockImplementation(async (definition: unknown) => {
      if (definition === workspaceFilesRootOpenOperation) {
        return { rootHandle: "de8e220b-0000-4000-8000-000000000010" } as never;
      }
      throw new SidecarProtocolDeliveryError("not_sent", "not_sent");
    });
    const runtime = fakeRuntime([session]);
    const provider = providerFor(runtime);
    await expect(
      provider.read({ ...scope, principalId: "other" }, root, "note.txt"),
    ).rejects.toBeInstanceOf(WorkspaceFileProviderUnavailableError);
    expect(runtime.acquireOperation).not.toHaveBeenCalled();
    await expect(
      provider.write(scope, root, {
        path: "note.txt",
        content: "changed",
        expectedRevision: "revision",
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileProviderUnavailableError);
    await provider.close();
  });

  it("binds a root-relative link to the selected sidecar root handle", async () => {
    const session = fakeSession("one");
    vi.mocked(session.call).mockImplementation(
      async (definition: unknown, request: unknown) => {
        if (definition === workspaceFilesRootOpenOperation) {
          return {
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
          } as never;
        }
        if (definition === workspaceFilesResolveLinkOperation) {
          expect(request).toEqual({
            rootHandle: "de8e220b-0000-4000-8000-000000000010",
            reference: {
              kind: "workspace_relative",
              path: "docs/guide.md",
            },
          });
          return { status: "resolved", path: "docs/guide.md" } as never;
        }
        throw new Error("unexpected_operation");
      },
    );
    const runtime = fakeRuntime([session]);
    const provider = providerFor(runtime);

    await expect(
      provider.resolveFileLink(scope, root, {
        kind: "root_relative",
        rootId: "primary",
        path: "docs/guide.md",
      }),
    ).resolves.toBe("docs/guide.md");
    await expect(
      provider.resolveFileLink(scope, root, {
        kind: "root_relative",
        rootId: workspaceFileRootIdSchema.parse("other-root"),
        path: "docs/guide.md",
      }),
    ).resolves.toBeUndefined();
    expect(runtime.acquireOperation).toHaveBeenCalledOnce();
    await provider.close();
  });

  it("keeps a lost root-admission response classified as provider unavailable", async () => {
    const session = fakeSession("one");
    vi.mocked(session.call).mockImplementation(async (definition: unknown) => {
      if (definition === workspaceFilesRootOpenOperation) {
        throw new SidecarProtocolDeliveryError(
          "sidecar_request_timeout",
          "sent_outcome_unknown",
        );
      }
      throw new Error("unexpected_operation");
    });
    const runtime = fakeRuntime([session]);
    const provider = providerFor(runtime);

    await expect(
      provider.write(scope, root, {
        path: "note.txt",
        content: "changed",
        expectedRevision: "revision",
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileProviderUnavailableError);
    expect(session.call).toHaveBeenCalledTimes(1);
    await provider.close();
  });

  it("normalizes runtime acquisition failure for validation and link discovery", async () => {
    const runtime = {
      acquireOperation: vi.fn(async () => {
        throw new Error("carrier_down");
      }),
      acquireWatch: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = providerFor(runtime);

    await expect(
      provider.validateRoot(scope, {
        workspaceId: root.workspaceId,
        environmentId,
        rootKind: "primary",
        canonicalPath: root.canonicalPath,
      }),
    ).rejects.toBeInstanceOf(WorkspaceFileProviderUnavailableError);
    await expect(
      provider.discoverFileLinkRoot(
        scope,
        environmentId,
        `${root.canonicalPath}/note.txt`,
      ),
    ).rejects.toBeInstanceOf(WorkspaceFileProviderUnavailableError);
    await provider.close();
  });

  it("performs every root validation remotely on the current session", async () => {
    let validations = 0;
    const session = fakeSession("one");
    vi.mocked(session.call).mockImplementation(async (definition: unknown) => {
      if (definition !== workspaceFilesRootValidateOperation) {
        throw new Error("unexpected_operation");
      }
      validations += 1;
      if (validations === 2) {
        throw new SidecarOperationError("workspace_file_root_unavailable");
      }
      return { validated: true } as never;
    });
    const release = vi.fn();
    const runtime = {
      acquireOperation: vi.fn(async () => ({
        session,
        carrierGeneration: 1,
        serviceStatus,
        release,
      })),
      acquireWatch: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = providerFor(runtime);
    const target = {
      workspaceId: root.workspaceId,
      environmentId,
      rootKind: "primary" as const,
      canonicalPath: root.canonicalPath,
    };

    await expect(provider.validateRoot(scope, target)).resolves.toBeUndefined();
    await expect(provider.validateRoot(scope, target)).rejects.toBeInstanceOf(
      WorkspaceFileRootUnavailableError,
    );
    expect(session.call).toHaveBeenNthCalledWith(
      1,
      workspaceFilesRootValidateOperation,
      {
        rootKind: "primary",
        declaredPath: root.canonicalPath,
        policyRootPath: "/srv/worktrees",
      },
    );
    expect(session.call).toHaveBeenNthCalledWith(
      2,
      workspaceFilesRootValidateOperation,
      expect.any(Object),
    );
    expect(release).toHaveBeenCalledTimes(2);
    await provider.close();
  });

  it.each(["sidecar_request_timeout", "sidecar_request_cancelled"])(
    "maps a sent %s during files.write to an unknown outcome",
    async (code) => {
      const session = fakeSession("one");
      vi.mocked(session.call).mockImplementation(
        async (definition: unknown) => {
          if (definition === workspaceFilesRootOpenOperation) {
            return {
              rootHandle: "de8e220b-0000-4000-8000-000000000010",
            } as never;
          }
          if (definition === workspaceFilesWriteOperation) {
            throw new SidecarProtocolDeliveryError(
              code,
              "sent_outcome_unknown",
            );
          }
          throw new Error("unexpected_operation");
        },
      );
      const provider = providerFor(fakeRuntime([session]));

      await expect(
        provider.write(scope, root, {
          path: "note.txt",
          content: "changed",
          expectedRevision: "revision",
        }),
      ).rejects.toBeInstanceOf(WorkspaceFileWriteOutcomeUnknownError);
      await provider.close();
    },
  );

  it.each(["sidecar_request_timeout", "sidecar_request_cancelled"])(
    "maps an unsent %s during files.write to provider unavailable",
    async (code) => {
      const session = fakeSession("one");
      vi.mocked(session.call).mockImplementation(
        async (definition: unknown) => {
          if (definition === workspaceFilesRootOpenOperation) {
            return {
              rootHandle: "de8e220b-0000-4000-8000-000000000010",
            } as never;
          }
          if (definition === workspaceFilesWriteOperation) {
            throw new SidecarProtocolDeliveryError(code, "not_sent");
          }
          throw new Error("unexpected_operation");
        },
      );
      const provider = providerFor(fakeRuntime([session]));

      await expect(
        provider.write(scope, root, {
          path: "note.txt",
          content: "changed",
          expectedRevision: "revision",
        }),
      ).rejects.toBeInstanceOf(WorkspaceFileProviderUnavailableError);
      await provider.close();
    },
  );

  it("reopens a remotely failed watch on a new generation and invalidates once", async () => {
    const first = fakeSession("first");
    const second = fakeSession("second");
    const runtime = fakeRuntime([first, second]);
    const provider = providerFor(runtime);
    const listener = vi.fn();
    const subscription = await provider.watch(scope, root, listener);
    first.failWatch();
    await vi.waitFor(() =>
      expect(runtime.acquireWatch).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    let failed = false;
    void subscription.failed.then(() => {
      failed = true;
    });
    await Promise.resolve();
    expect(failed).toBe(false);
    subscription.close();
    await provider.close();
  });

  it("resolves watch failure after bounded replacement attempts fail", async () => {
    vi.useFakeTimers();
    try {
      const first = fakeSession("first");
      const runtime = fakeRuntime([first]);
      vi.mocked(runtime.acquireWatch)
        .mockResolvedValueOnce(watchLease(first, 1))
        .mockRejectedValue(new Error("carrier_down"));
      const provider = providerFor(runtime);
      const subscription = await provider.watch(scope, root, vi.fn());
      let failed = false;
      void subscription.failed.then(() => {
        failed = true;
      });
      first.failWatch();
      await vi.advanceTimersByTimeAsync(1_250);
      await Promise.resolve();
      expect(runtime.acquireWatch).toHaveBeenCalledTimes(4);
      expect(failed).toBe(true);
      subscription.close();
      await provider.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

function providerFor(runtime: SidecarRuntimeOwner<SidecarClientSession>) {
  return new SidecarWorkspaceFileProvider({
    scope,
    environmentId,
    policyRoots: ["/srv", "/srv/worktrees"],
    runtime,
  });
}

function fakeRuntime(sessions: SidecarClientSession[]) {
  let generation = 0;
  const next = async () => {
    const session = sessions[generation];
    if (!session) throw new Error("carrier_down");
    generation += 1;
    return watchLease(session, generation);
  };
  return {
    acquireOperation: vi.fn(next),
    acquireWatch: vi.fn(next),
    close: vi.fn(async () => undefined),
  } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
}

function watchLease(
  session: SidecarClientSession,
  carrierGeneration: number,
): SidecarRuntimeLease<SidecarClientSession> {
  return { session, carrierGeneration, serviceStatus, release: vi.fn() };
}

function fakeSession(label: string) {
  const closure = deferred<void>();
  const watchFailures = new Map<
    string,
    (event: { readonly subscriptionHandle: string }) => void
  >();
  let watchIndex = 0;
  const session = {
    closed: closure.promise,
    call: vi.fn(async (definition: unknown) => {
      if (definition === workspaceFilesRootOpenOperation) {
        return {
          rootHandle: `de8e220b-0000-4000-8000-${label === "first" ? "000000000011" : "000000000012"}`,
        };
      }
      if (
        (definition as { operation?: string }).operation === "files.watch_open"
      ) {
        watchIndex += 1;
        return {
          subscriptionHandle: `de8e220b-0000-4000-8000-${watchIndex === 1 ? "000000000021" : "000000000022"}`,
        };
      }
      if (
        (definition as { operation?: string }).operation === "files.watch_close"
      ) {
        return { closed: true };
      }
      throw new Error(`unexpected_operation:${label}`);
    }),
    registerInvalidation: vi.fn(() => vi.fn()),
    registerWatchFailure: vi.fn(
      (
        subscriptionHandle: string,
        listener: (event: { readonly subscriptionHandle: string }) => void,
      ) => {
        watchFailures.set(subscriptionHandle, listener);
        return () => watchFailures.delete(subscriptionHandle);
      },
    ),
    close: vi.fn(async () => closure.resolve()),
    finish: () => closure.resolve(),
    failWatch: () => {
      const [subscriptionHandle, listener] =
        [...watchFailures.entries()][0] ?? [];
      if (!subscriptionHandle || !listener) {
        throw new Error("watch_failure_listener_missing");
      }
      listener({ subscriptionHandle });
    },
  };
  return session as unknown as SidecarClientSession & {
    finish(): void;
    failWatch(): void;
  };
}

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as (value?: T | PromiseLike<T>) => void;
  });
  return { promise, resolve };
}

function randomUuid(suffix: number): string {
  return `de8e220b-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
}
