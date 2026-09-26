import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../src/client/api/ApiClient.js";
import {
  SEDES_CLIENT_PROTOCOL_VERSION,
  workspaceFileSupplementalRootIdSchema,
} from "../../src/shared/index.js";
import { SEDES_VERSION } from "../../src/shared/version.js";
import { BrowserEventStreamTransport } from "../../src/client/api/EventStreamTransport.js";
import type { ConnectionState } from "../../src/client/api/EventStreamTransport.js";
import { configuredSedesServer } from "../../src/client/app/server-endpoint.js";
import {
  clearDiagnostics,
  readDiagnostics,
} from "../../src/client/app/diagnostics.js";

const environmentId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const threadId = "10000000-0000-4000-8000-000000000003";
const hubId = "10000000-0000-4000-8000-000000000004";
const supplementalRootId = workspaceFileSupplementalRootIdSchema.parse(
  "root-10000000-0000-4000-8000-000000000005",
);

function session(csrfToken = "a".repeat(32)) {
  return {
    clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
    version: SEDES_VERSION,
    csrfToken,
    providerPulseEnabled: true, experimentalUsageEnabled: false,
  };
}

afterEach(() => {
  clearDiagnostics();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ApiClient normalized contract", () => {
  it("uses the strict saved-Agent thread-create request and result", async () => {
    const agentId = "20000000-0000-4000-8000-000000000010";
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === "/api/application/session") {
          return Response.json(session("d".repeat(32)));
        }
        expect(String(input)).toBe("/api/threads");
        expect(init).toMatchObject({
          method: "POST",
          headers: expect.objectContaining({
            "X-CSRF-Token": "d".repeat(32),
          }),
          body: JSON.stringify({
            workspaceId,
            title: "Review build",
            executionWorkspace: { kind: "direct" },
            configuration: { kind: "saved_agent", agentId },
          }),
        });
        return Response.json({
          threadId,
          workspaceId,
          targetId: "target-1",
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.session();

    await expect(
      client.createThread({
        workspaceId,
        title: "Review build",
        executionWorkspace: { kind: "direct" },
        configuration: { kind: "saved_agent", agentId },
      }),
    ).resolves.toEqual({ threadId, workspaceId, targetId: "target-1" });
  });

  it("submits an idempotent same-settings creation request against its source", async () => {
    const mutationId = "50000000-0000-4000-8000-000000000001";
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === "/api/application/session") {
          return Response.json(session("e".repeat(32)));
        }
        expect(String(input)).toBe(
          `/api/threads/${threadId}/configuration-copies`,
        );
        expect(init).toMatchObject({
          method: "POST",
          headers: expect.objectContaining({
            "X-CSRF-Token": "e".repeat(32),
          }),
          body: JSON.stringify({ title: "New thread", mutationId }),
        });
        return Response.json({
          threadId: "60000000-0000-4000-8000-000000000001",
          workspaceId,
          targetId: "target-1",
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.session();

    await expect(
      client.createThreadFromSettings(threadId, {
        title: "New thread",
        mutationId,
      }),
    ).resolves.toEqual({
      threadId: "60000000-0000-4000-8000-000000000001",
      workspaceId,
      targetId: "target-1",
    });
  });

  it("includes durable context excerpts when saving a draft", async () => {
    const excerpt = {
      id: "20000000-0000-4000-8000-000000000001",
      excerpt: "const answer = 42;",
      note: "Explain this value.",
      source: {
        kind: "workspace_file" as const,
        rootId: "primary" as const,
        path: "src/answer.ts",
        revision: "revision-1",
      },
      locator: {
        kind: "line_range" as const,
        startLine: 7,
        endLine: 7,
      },
    };
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === "/api/application/session") {
          return Response.json(session("b".repeat(32)));
        }
        expect(String(input)).toBe(`/api/threads/${threadId}/draft`);
        expect(init).toMatchObject({
          method: "PUT",
          headers: expect.objectContaining({
            "X-CSRF-Token": "b".repeat(32),
          }),
          body: JSON.stringify({
            text: "Please review this.",
            contextExcerpts: [excerpt],
            attachmentIds: [],
            taskReferenceIds: [],
            expectedRevision: 7,
          }),
        });
        return Response.json({
          text: "Please review this.",
          contextExcerpts: [excerpt],
          taskReferences: [],
          attachments: [],
          revision: 8,
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.session();

    await expect(
      client.saveDraft(threadId, {
        text: "Please review this.",
        contextExcerpts: [excerpt],
        taskReferences: [],
        attachments: [],
        revision: 7,
      }),
    ).resolves.toEqual({
      text: "Please review this.",
      contextExcerpts: [excerpt],
      taskReferences: [],
      attachments: [],
      revision: 8,
    });
  });

  it("uploads immutable bytes separately and fetches preview content through the API transport", async () => {
    const attachmentId = "20000000-0000-4000-8000-000000000020";
    const file = new File(["binary"], "notes & plans.bin", {
      type: "application/x-notes",
    });
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/application/session") {
          return Response.json(session("u".repeat(32)));
        }
        if (path.endsWith(`/${attachmentId}/content`)) {
          expect(init).toMatchObject({
            method: "GET",
            credentials: "same-origin",
            redirect: "error",
            headers: {
              Accept: "image/png, image/jpeg, image/gif, image/webp",
            },
          });
          return new Response("preview", {
            headers: { "Content-Type": "image/png" },
          });
        }
        expect(path).toBe(
          `/api/threads/${threadId}/composer-attachments/${attachmentId}?fileName=notes+%26+plans.bin&declaredMediaType=application%2Fx-notes`,
        );
        expect(init).toMatchObject({
          method: "PUT",
          body: file,
          headers: expect.objectContaining({
            "Content-Type": "application/octet-stream",
            "X-CSRF-Token": "u".repeat(32),
          }),
        });
        return Response.json({
          attachment: {
            id: attachmentId,
            fileName: file.name,
            kind: "file",
            mediaType: "application/octet-stream",
            byteSize: file.size,
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.session();

    await expect(
      client.uploadComposerAttachment(threadId, attachmentId, file),
    ).resolves.toMatchObject({ id: attachmentId, fileName: file.name });
    const preview = await client.loadComposerAttachmentContent(
      threadId,
      attachmentId,
    );
    expect(preview).toMatchObject({ size: 7, type: "image/png" });
  });

  it("uses normalized workspace-file list, content, status, and write routes", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/application/session") {
          return Response.json(session("c".repeat(32)));
        }
        if (path.endsWith("/files/content") && init?.method === "PUT") {
          return Response.json({
            availability: "available",
            rootId: supplementalRootId,
            path: "src/file name.ts",
            sizeBytes: 10,
            revision: "revision-2",
          });
        }
        if (path.includes("/content?")) {
          return Response.json({
            availability: "available",
            rootId: supplementalRootId,
            path: "src/file name.ts",
            contentKind: "text",
            content: "export {};",
            sizeBytes: 10,
            revision: "revision-1",
            editable: true,
          });
        }
        if (path.endsWith("/status")) {
          return Response.json({
            roots: [
              {
                availability: "available",
                rootId: "primary",
                isGitRepository: false,
                entries: [],
                truncated: false,
              },
              {
                availability: "available",
                rootId: supplementalRootId,
                isGitRepository: true,
                entries: [
                  {
                    rootId: supplementalRootId,
                    path: "src/file name.ts",
                    status: "modified",
                  },
                ],
                truncated: false,
              },
            ],
          });
        }
        return Response.json({
          availability: "available",
          rootId: supplementalRootId,
          entries: ["src/file name.ts"],
          nextCursor: "00000000-0000-4000-8000-000000000002",
          scanTruncated: false,
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.session();

    await expect(
      client.listWorkspaceFiles(workspaceId, {
        rootId: supplementalRootId,
        cursor: "00000000-0000-4000-8000-000000000001",
        pageSize: 250,
      }),
    ).resolves.toMatchObject({ entries: ["src/file name.ts"] });
    await expect(
      client.readWorkspaceFile(
        workspaceId,
        supplementalRootId,
        "src/file name.ts",
      ),
    ).resolves.toMatchObject({ revision: "revision-1" });
    await expect(
      client.workspaceFileStatus(workspaceId),
    ).resolves.toMatchObject({
      roots: [
        { rootId: "primary" },
        { rootId: supplementalRootId, isGitRepository: true },
      ],
    });
    await expect(
      client.saveWorkspaceFile(workspaceId, {
        rootId: supplementalRootId,
        path: "src/file name.ts",
        content: "export {};",
        expectedRevision: "revision-1",
      }),
    ).resolves.toMatchObject({ revision: "revision-2" });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/application/session",
      `/api/workspaces/${workspaceId}/files?rootId=${encodeURIComponent(supplementalRootId)}&cursor=00000000-0000-4000-8000-000000000001&pageSize=250`,
      `/api/workspaces/${workspaceId}/files/content?rootId=${encodeURIComponent(supplementalRootId)}&path=src%2Ffile+name.ts`,
      `/api/workspaces/${workspaceId}/files/status`,
      `/api/workspaces/${workspaceId}/files/content`,
    ]);
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ "X-CSRF-Token": "c".repeat(32) }),
      body: JSON.stringify({
        rootId: supplementalRootId,
        path: "src/file name.ts",
        content: "export {};",
        expectedRevision: "revision-1",
      }),
    });
  });

  it("preflights exact workspace downloads without reading their body", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init).toMatchObject({
          method: "HEAD",
          credentials: "omit",
          redirect: "error",
          headers: { Accept: "application/octet-stream" },
        });
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition":
              "attachment; filename=\"file.txt\"; filename*=UTF-8''file.txt",
            "Content-Length": "1234",
            "X-Sedes-Workspace-File-Revision": "revision-1",
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient(
      configuredSedesServer("https://sedes.example"),
    );

    await expect(
      client.prepareWorkspaceFileDownload(workspaceId, {
        rootId: "primary",
        path: "folder/file.txt",
        expectedRevision: "revision-1",
      }),
    ).resolves.toEqual({
      url: `https://sedes.example/api/workspaces/${workspaceId}/files/download?rootId=primary&path=folder%2Ffile.txt&expectedRevision=revision-1`,
      serverOrigin: "https://sedes.example",
      contentDisposition:
        "attachment; filename=\"file.txt\"; filename*=UTF-8''file.txt",
      contentLength: 1234,
      revision: "revision-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails a stale workspace download preflight before navigation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 409 })),
    );
    const client = new ApiClient(
      configuredSedesServer("https://sedes.example"),
    );

    await expect(
      client.prepareWorkspaceFileDownload(workspaceId, {
        rootId: "primary",
        path: "file.txt",
        expectedRevision: "stale-revision",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workspace_file_revision_conflict",
      retryable: false,
    });
  });

  it("rejects invalid workspace download metadata before navigation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 200,
            headers: {
              "Content-Type": "text/plain",
              "Content-Disposition": 'attachment; filename="file.txt"',
              "Content-Length": "1073741825",
              "X-Sedes-Workspace-File-Revision": "revision-1",
            },
          }),
      ),
    );
    const client = new ApiClient(
      configuredSedesServer("https://sedes.example"),
    );

    await expect(
      client.prepareWorkspaceFileDownload(workspaceId, {
        rootId: "primary",
        path: "file.txt",
        expectedRevision: "revision-1",
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "invalid_response",
      retryable: true,
    });
  });

  it("serializes scoped comparison history and exact restoration queries", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({ status: "unavailable", diagnosticCode: "workspace_diff_unavailable" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.listWorkspaceDiffRefs(workspaceId, supplementalRootId, { repositoryId: "repository-1" as never, pageSize: 50, history: "revision:branch-1", resolveRef: "refs/heads/feature/layout" });
    const namedUrl = new URL(String(fetchMock.mock.calls[0]![0]), "https://localhost");
    expect(namedUrl.searchParams.get("history")).toBe("revision:branch-1");
    expect(namedUrl.searchParams.get("resolveRef")).toBe("refs/heads/feature/layout");
    await client.listWorkspaceDiffRefs(workspaceId, supplementalRootId, { repositoryId: "repository-1" as never, pageSize: 50, history: "all", resolveCommit: "a".repeat(40) });
    const commitUrl = new URL(String(fetchMock.mock.calls[1]![0]), "https://localhost");
    expect(commitUrl.searchParams.get("history")).toBe("all");
    expect(commitUrl.searchParams.get("resolveCommit")).toBe("a".repeat(40));
  });

  it("uses root-qualified strict workspace comparison routes", async () => {
    const fingerprint = "fingerprint-0001";
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === "/api/application/session") {
          return Response.json(session("e".repeat(32)));
        }
        if (String(input).endsWith("/diff/comparisons")) {
          expect(init).toMatchObject({
            method: "POST",
            headers: expect.objectContaining({
              "X-CSRF-Token": "e".repeat(32),
            }),
            body: JSON.stringify({
              repositoryId: "repository-1",
              mode: "direct",
              base: { kind: "revision", revisionId: "revision-1" },
              head: { kind: "working_tree" },
            }),
          });
        }
        return Response.json({
          status: "unavailable",
          diagnosticCode: "workspace_diff_unavailable",
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.session();

    await client.listWorkspaceDiffRepositories(workspaceId, supplementalRootId);
    await client.listWorkspaceDiffRefs(workspaceId, supplementalRootId, {
      repositoryId: "repository-1" as never,
      pageSize: 50,
    });
    await client.createWorkspaceDiffComparison(
      workspaceId,
      supplementalRootId,
      {
        repositoryId: "repository-1" as never,
        mode: "direct",
        base: { kind: "revision", revisionId: "revision-1" as never },
        head: { kind: "working_tree" },
      },
    );
    await client.listWorkspaceDiffChangedFiles(
      workspaceId,
      supplementalRootId,
      {
        comparisonId: "comparison-1" as never,
        fingerprint: fingerprint as never,
        after: "file-1" as never,
        pageSize: 75,
      },
    );
    await client.readWorkspaceDiffPatch(workspaceId, supplementalRootId, {
      comparisonId: "comparison-1" as never,
      fingerprint: fingerprint as never,
      fileId: "file-2" as never,
    });
    await client.readWorkspaceDiffFileContent(workspaceId, supplementalRootId, {
      comparisonId: "comparison-1" as never,
      fingerprint: fingerprint as never,
      fileId: "file-2" as never,
      side: "old",
    });

    const prefix = `/api/workspaces/${workspaceId}/file-roots/${encodeURIComponent(supplementalRootId)}/diff`;
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/application/session",
      `${prefix}/repositories`,
      `${prefix}/refs?repositoryId=repository-1&pageSize=50`,
      `${prefix}/comparisons`,
      `${prefix}/files?comparisonId=comparison-1&fingerprint=${fingerprint}&pageSize=75&after=file-1`,
      `${prefix}/patch?comparisonId=comparison-1&fingerprint=${fingerprint}&fileId=file-2`,
      `${prefix}/content?comparisonId=comparison-1&fingerprint=${fingerprint}&fileId=file-2&side=old`,
    ]);
  });

  it("uses trusted root-qualified workspace review and annotation routes", async () => {
    const reviewId = "30000000-0000-4000-8000-000000000001";
    const commentId = "30000000-0000-4000-8000-000000000002";
    const mutationId = "30000000-0000-4000-8000-000000000003";
    const fingerprint = "fingerprint-0001";
    const review = {
      id: reviewId,
      workspaceId,
      rootId: supplementalRootId,
      title: "Review",
      summary: "Summary",
      state: "open" as const,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const comment = {
      id: commentId,
      reviewId,
      fileIdentity: "file-identity-0001",
      oldPath: "src/file.ts",
      newPath: "src/file.ts",
      side: "new" as const,
      startLine: 2,
      endLine: 3,
      selectedText: "changed",
      body: "Please review",
      state: "draft" as const,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const reviewedFile = {
      reviewId,
      fileIdentity: "file-identity-0001",
      filePath: "src/file.ts",
      contentFingerprint: "content-fingerprint-0001",
      reviewed: true,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/application/session") {
          return Response.json(session("f".repeat(32)));
        }
        if (url.endsWith("/comments") && init?.method === "POST") {
          return Response.json({ review, comment });
        }
        if (url.endsWith("/reviewed-files") && init?.method === "PUT") {
          return Response.json({ review, file: reviewedFile });
        }
        if (url.endsWith("/comments")) return Response.json({ comments: [] });
        if (url.endsWith("/reviewed-files")) {
          return Response.json({ files: [] });
        }
        if (url.includes("review-history?") || url.includes("/reviews?")) {
          return Response.json({ reviews: [] });
        }
        if (url.includes("/comments/") && init?.method) {
          return Response.json({ review, comment });
        }
        return Response.json(review);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.session();

    await client.listWorkspaceDiffReviewHistory(
      workspaceId,
      supplementalRootId,
      { repositoryId: "repository-1" as never },
    );
    await client.listWorkspaceDiffReviews(workspaceId, supplementalRootId, {
      comparisonId: "comparison-1" as never,
      fingerprint: fingerprint as never,
    });
    await client.openWorkspaceDiffReview(workspaceId, supplementalRootId, {
      comparisonId: "comparison-1" as never,
      fingerprint: fingerprint as never,
      title: "Review",
      summary: "Summary",
      mutationId,
    });
    await client.updateWorkspaceDiffReview(reviewId, {
      title: "Review",
      summary: "Summary",
      state: "open",
      expectedRevision: 1,
      mutationId,
    });
    await client.listWorkspaceDiffReviewComments(reviewId);
    await client.createWorkspaceDiffReviewComment(
      workspaceId,
      supplementalRootId,
      reviewId,
      {
        comparisonId: "comparison-1" as never,
        fingerprint: fingerprint as never,
        fileId: "file-1" as never,
        side: "new",
        startLine: 2,
        endLine: 3,
        body: "Please review",
        expectedReviewRevision: 1,
        mutationId,
      },
    );
    await client.updateWorkspaceDiffReviewComment(reviewId, commentId, {
      body: "Updated",
      state: "published",
      expectedReviewRevision: 1,
      expectedCommentRevision: 1,
      mutationId,
    });
    await client.deleteWorkspaceDiffReviewComment(reviewId, commentId, {
      expectedReviewRevision: 1,
      expectedCommentRevision: 1,
      mutationId,
    });
    await client.listWorkspaceDiffReviewedFiles(reviewId);
    await client.setWorkspaceDiffReviewedFile(
      workspaceId,
      supplementalRootId,
      reviewId,
      {
        comparisonId: "comparison-1" as never,
        fingerprint: fingerprint as never,
        fileId: "file-1" as never,
        reviewed: true,
        expectedReviewRevision: 1,
        expectedFileRevision: null,
        mutationId,
      },
    );

    const rootPrefix = `/api/workspaces/${workspaceId}/file-roots/${encodeURIComponent(supplementalRootId)}/diff`;
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/application/session",
      `${rootPrefix}/review-history?repositoryId=repository-1`,
      `${rootPrefix}/reviews?comparisonId=comparison-1&fingerprint=${fingerprint}`,
      `${rootPrefix}/reviews`,
      `/api/workspace-diff-reviews/${reviewId}`,
      `/api/workspace-diff-reviews/${reviewId}/comments`,
      `${rootPrefix}/reviews/${reviewId}/comments`,
      `/api/workspace-diff-reviews/${reviewId}/comments/${commentId}`,
      `/api/workspace-diff-reviews/${reviewId}/comments/${commentId}`,
      `/api/workspace-diff-reviews/${reviewId}/reviewed-files`,
      `${rootPrefix}/reviews/${reviewId}/reviewed-files`,
    ]);
  });

  it("accepts strict image branches and rejects malformed workspace image responses", async () => {
    const pngContent = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const requestPath = String(input);
        if (requestPath === "/api/application/session") {
          return Response.json(session("e".repeat(32)));
        }
        const common = {
          availability: "available",
          rootId: "primary",
          path: "available.png",
          contentKind: "image",
          mediaType: "image/png",
          editable: false,
          revision: "revision-image",
        };
        if (requestPath.includes("path=available.png")) {
          return Response.json({
            ...common,
            previewState: "available",
            contentEncoding: "base64",
            content: pngContent,
            sizeBytes: 8,
          });
        }
        if (requestPath.includes("path=large.png")) {
          return Response.json({
            ...common,
            path: "large.png",
            previewState: "too_large",
            sizeBytes: 16 * 1_024 * 1_024 + 1,
          });
        }
        if (requestPath.includes("path=cross-branch.txt")) {
          return Response.json({
            ...common,
            path: "cross-branch.txt",
            contentKind: "text",
            content: "plain text",
            sizeBytes: 10,
            editable: true,
            previewState: "available",
          });
        }
        return Response.json({
          ...common,
          path: "malformed.png",
          previewState: "available",
          contentEncoding: "base64",
          content: "not_base64",
          sizeBytes: 8,
        });
      }),
    );
    const client = new ApiClient();
    await client.session();

    await expect(
      client.readWorkspaceFile(workspaceId, "primary", "available.png"),
    ).resolves.toMatchObject({
      contentKind: "image",
      previewState: "available",
      content: pngContent,
    });
    await expect(
      client.readWorkspaceFile(workspaceId, "primary", "large.png"),
    ).resolves.toMatchObject({
      contentKind: "image",
      previewState: "too_large",
    });
    for (const path of ["cross-branch.txt", "malformed.png"]) {
      await expect(
        client.readWorkspaceFile(workspaceId, "primary", path),
      ).rejects.toMatchObject({
        code: "invalid_response",
        status: 502,
      } satisfies Partial<ApiError>);
    }
  });

  it("uses strict workspace file-root CRUD and absolute-link resolution routes", async () => {
    const attachMutationId = "20000000-0000-4000-8000-000000000001";
    const removeMutationId = "20000000-0000-4000-8000-000000000002";
    const root = {
      rootId: supplementalRootId,
      kind: "supplemental" as const,
      displayLabel: "Agent context",
      displayPath: { text: "/home/person/agent-context/repos/sedes" },
      sortOrder: 1,
      revision: 3,
      availability: "available" as const,
      watchable: true,
    };
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/application/session") {
          return Response.json(session("d".repeat(32)));
        }
        if (path.endsWith("/file-roots") && init?.method === "POST") {
          return Response.json({ root });
        }
        if (path.endsWith(`/file-roots/${supplementalRootId}`)) {
          return Response.json({ rootId: supplementalRootId });
        }
        if (path.endsWith("/file-links/resolve")) {
          return Response.json({
            status: "resolved",
            rootId: supplementalRootId,
            path: "notes/design.md",
            rootVisibility: "listed",
          });
        }
        return Response.json({
          roots: [
            {
              rootId: "primary",
              kind: "primary",
              displayLabel: "Workspace",
              displayPath: { text: "/workspace" },
              sortOrder: 0,
              revision: 0,
              availability: "available",
              watchable: true,
            },
            root,
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.session();

    await expect(
      client.listWorkspaceFileRoots(workspaceId),
    ).resolves.toMatchObject({
      roots: [{ rootId: "primary" }, { rootId: supplementalRootId }],
    });
    await expect(
      client.attachWorkspaceFileRoot(workspaceId, {
        mutationId: attachMutationId,
        path: "/home/person/agent-context/repos/sedes",
        displayLabel: "Agent context",
      }),
    ).resolves.toEqual({ root });
    await expect(
      client.removeWorkspaceFileRoot(workspaceId, supplementalRootId, {
        mutationId: removeMutationId,
        expectedRevision: 3,
      }),
    ).resolves.toEqual({ rootId: supplementalRootId });
    await expect(
      client.resolveWorkspaceFileLink(workspaceId, {
        kind: "absolute",
        path: "/home/person/agent-context/repos/sedes/notes/design.md",
      }),
    ).resolves.toEqual({
      status: "resolved",
      rootId: supplementalRootId,
      path: "notes/design.md",
      rootVisibility: "listed",
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/application/session",
      `/api/workspaces/${workspaceId}/file-roots`,
      `/api/workspaces/${workspaceId}/file-roots`,
      `/api/workspaces/${workspaceId}/file-roots/${supplementalRootId}`,
      `/api/workspaces/${workspaceId}/file-links/resolve`,
    ]);
    expect(fetchMock.mock.calls.slice(2).map(([, init]) => init)).toMatchObject(
      [
        {
          method: "POST",
          headers: expect.objectContaining({ "X-CSRF-Token": "d".repeat(32) }),
          body: JSON.stringify({
            mutationId: attachMutationId,
            path: "/home/person/agent-context/repos/sedes",
            displayLabel: "Agent context",
          }),
        },
        {
          method: "DELETE",
          body: JSON.stringify({
            mutationId: removeMutationId,
            expectedRevision: 3,
          }),
        },
        {
          method: "POST",
          body: JSON.stringify({
            reference: {
              kind: "absolute",
              path: "/home/person/agent-context/repos/sedes/notes/design.md",
            },
          }),
        },
      ],
    );
  });

  it("mints terminal admission through the existing CSRF mutation transport", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/application/session") {
        return Response.json(session("c".repeat(32)));
      }
      return Response.json(
        {
          token: "a".repeat(43),
          expiresAt: "2026-08-04T12:00:00.000Z",
          resourceGeneration: 7,
        },
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();

    await expect(client.createCodexTuiAdmission(threadId)).resolves.toEqual({
      token: "a".repeat(43),
      expiresAt: "2026-08-04T12:00:00.000Z",
      resourceGeneration: 7,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/threads/${threadId}/provider-features/codex.tui/terminal-admission`,
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({ "X-CSRF-Token": "c".repeat(32) }),
      }),
    );
  });

  it("uses an absolute configured endpoint without cross-origin credentials", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/content")
        ? new Response("preview", {
            headers: { "Content-Type": "image/png" },
          })
        : Response.json(session()),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient(
      configuredSedesServer("http://192.168.1.20:4783"),
    );

    await client.session();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.20:4783/api/application/session",
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );

    await client.loadComposerAttachmentContent(threadId, "attachment-1");
    expect(fetchMock).toHaveBeenLastCalledWith(
      `http://192.168.1.20:4783/api/threads/${threadId}/composer-attachments/attachment-1/content`,
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "error",
      }),
    );

    await client.loadOutputArtifactContent(
      threadId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      `http://192.168.1.20:4783/api/threads/${threadId}/output-artifacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content`,
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        headers: expect.objectContaining({
          Accept: "image/png, image/jpeg, image/gif, image/webp",
        }),
      }),
    );
  });

  it("parses the archive-family impact from its normalized route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === "/api/application/session") {
          return Response.json(session());
        }
        return Response.json({
          descendantCount: 3,
          pendingQuestions: { root: 0, descendants: 0 },
          stashedPrompts: { root: 1, descendants: 2 },
          openTasks: {
            root: { items: [], total: 0, omitted: 0 },
            descendants: { items: [], total: 0, omitted: 0 },
          },
          executionWorkspace: { kind: "direct" },
          archiveOnly: { available: true },
          archiveAll: {
            available: false,
            unavailableReason:
              "A descendant is running and cannot be archived.",
          },
        });
      }),
    );
    const client = new ApiClient();
    await client.session();

    await expect(client.getThreadArchiveImpact(threadId)).resolves.toEqual({
      descendantCount: 3,
      pendingQuestions: { root: 0, descendants: 0 },
      stashedPrompts: { root: 1, descendants: 2 },
      openTasks: {
        root: { items: [], total: 0, omitted: 0 },
        descendants: { items: [], total: 0, omitted: 0 },
      },
      executionWorkspace: { kind: "direct" },
      archiveOnly: { available: true },
      archiveAll: {
        available: false,
        unavailableReason: "A descendant is running and cannot be archived.",
      },
    });
    expect(fetch).toHaveBeenLastCalledWith(
      `/api/threads/${threadId}/inventory/archive-impact`,
      expect.any(Object),
    );
  });

  it("uses the isolated workspace lifecycle routes and normalized contracts", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/application/session") {
          return Response.json(session());
        }
        if (path.endsWith("/import")) {
          return Response.json({
            branch: "sedes/thread-1",
            headOid: "a".repeat(40),
            sourceRepositoryPath: "/repo",
          });
        }
        if (path.endsWith("/handoff")) {
          return Response.json({
            state: "retained",
            allocationRevision: 4,
            workspacePath: "/sandboxes/thread-1/repo",
            branch: "sedes/thread-1",
          });
        }
        if (init?.method === "DELETE") {
          return Response.json({
            state: "deleted",
            allocationRevision: 5,
            operationId: "10000000-0000-4000-8000-000000000006",
          });
        }
        return Response.json({
          kind: "isolated",
          workspaceAccess: "writable_clone",
          state: "provisioning_failed",
          allocationRevision: 3,
          networkProfile: "isolated",
          hostPaths: {
            home: "/sandboxes/thread-1",
            workspace: "/sandboxes/thread-1/repo",
          },
          branch: "sedes/thread-1",
          gitStatus: {
            available: true,
            trackedChangeCount: 0,
            untrackedFileCount: 0,
            upstream: "origin/main",
            aheadCount: 0,
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.session();
    await expect(
      client.getThreadExecutionWorkspace(threadId),
    ).resolves.toMatchObject({
      kind: "isolated",
      workspaceAccess: "writable_clone",
      state: "provisioning_failed",
      allocationRevision: 3,
    });

    const request = {
      expectedRevision: 3,
      operationId: "10000000-0000-4000-8000-000000000006",
    };
    await expect(
      client.importThreadExecutionWorkspace(threadId, request),
    ).resolves.toMatchObject({ branch: "sedes/thread-1" });
    await expect(
      client.handoffThreadExecutionWorkspace(threadId, request),
    ).resolves.toMatchObject({ state: "retained" });
    await expect(
      client.deleteThreadExecutionWorkspace(threadId, request),
    ).resolves.toMatchObject({ state: "deleted" });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/threads/${threadId}/execution-workspace/import`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/threads/${threadId}/execution-workspace/handoff`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(request),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/threads/${threadId}/execution-workspace`,
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify(request),
      }),
    );
  });

  it("parses authoritative archive-family membership from the mutation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === "/api/application/session") {
          return Response.json(session());
        }
        return Response.json({ archivedThreadIds: [threadId] });
      }),
    );
    const client = new ApiClient();
    await client.session();

    await expect(
      client.archiveThreads(threadId, {
        action: "archive_family",
        expectedRevision: 0,
        expectedStashedPromptCount: 0,
        executionWorkspaceDisposition: { kind: "keep" },
        mutationId: "10000000-0000-4000-8000-000000000005",
      }),
    ).resolves.toEqual({ archivedThreadIds: [threadId] });
  });

  it("previews and submits a force reset through its dedicated normalized routes", async () => {
    const blockerFingerprint = "d".repeat(64);
    const impact = {
      blockerFingerprint,
      resettable: true,
      blockers: [{ kind: "conversation_operation" as const, count: 2 }],
      affectedThreads: [{ threadId, title: "Thread" }],
      warnings: [
        {
          code: "provider_side_effects_may_remain" as const,
          message: "Provider-side effects may remain.",
        },
      ],
    };
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/application/session") {
          return Response.json(session("e".repeat(32)));
        }
        if (path.endsWith("/force-reset-impact")) return Response.json(impact);
        expect(init).toMatchObject({
          method: "POST",
          headers: expect.objectContaining({ "X-CSRF-Token": "e".repeat(32) }),
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedBlockerFingerprint: blockerFingerprint,
          mutationId: "10000000-0000-4000-8000-000000000006",
        });
        return Response.json({
          resetAt: 1_786_210_800_000,
          blockerFingerprint,
          resetBlockers: impact.blockers,
          affectedThreadIds: [threadId],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await client.session();

    await expect(client.getThreadForceResetImpact(threadId)).resolves.toEqual(
      impact,
    );
    await expect(
      client.forceResetThread(
        threadId,
        blockerFingerprint,
        "10000000-0000-4000-8000-000000000006",
      ),
    ).resolves.toMatchObject({ blockerFingerprint });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      `/api/threads/${threadId}/force-reset`,
    );
  });

  it("rejects the removed inventory bootstrap shape as session metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          csrfToken: "a".repeat(32),
          environments: [],
          workspaces: [],
          threads: [],
          counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
        }),
      ),
    );

    await expect(new ApiClient().session()).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    } satisfies Partial<ApiError>);
  });

  it("reports a dedicated error for an incompatible client protocol version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...session(),
          clientProtocolVersion: 69,
        }),
      ),
    );

    await expect(new ApiClient().session()).rejects.toMatchObject({
      code: "client_protocol_mismatch",
      status: 502,
      retryable: false,
      message: `This app (Sedes ${SEDES_VERSION}) and the Sedes server (Sedes ${SEDES_VERSION}) use incompatible protocol versions. Update the app or server so their versions match.`,
      details: {
        expected: SEDES_CLIENT_PROTOCOL_VERSION,
        received: 69,
        clientVersion: SEDES_VERSION,
        serverVersion: SEDES_VERSION,
      },
    } satisfies Partial<ApiError>);
  });

  it("posts the neutral operation shape and refreshes CSRF once", async () => {
    const calls: Array<{
      path: string;
      token: string | null;
      body?: unknown;
    }> = [];
    let sessionCount = 0;
    let mutationCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        const headers = new Headers(init?.headers);
        calls.push({
          path,
          token: headers.get("X-CSRF-Token"),
          ...(init?.body
            ? { body: JSON.parse(String(init.body)) as unknown }
            : {}),
        });
        if (path === "/api/application/session") {
          sessionCount += 1;
          return Response.json(
            session(sessionCount === 1 ? "a".repeat(32) : "b".repeat(32)),
          );
        }
        mutationCount += 1;
        if (mutationCount === 1) {
          return Response.json(
            {
              error: {
                code: "csrf_token_invalid",
                message: "Refresh session.",
                retryable: false,
              },
            },
            { status: 403 },
          );
        }
        return Response.json({
          status: "accepted",
          operationId: "operation-1",
        });
      }),
    );
    const client = new ApiClient();
    const mutationId = "20000000-0000-4000-8000-000000000001";

    await expect(
      client.operateThread(threadId, {
        kind: "perform",
        mutationId,
        expectedThreadRevision: 7,
        expectedSettingsRevision: 3,
        operation: {
          action: "set_setting",
          settingId: "model",
          value: "model-option-1",
        },
      }),
    ).resolves.toEqual({
      status: "accepted",
      operationId: "operation-1",
    });
    expect(calls).toEqual([
      { path: "/api/application/session", token: null },
      {
        path: `/api/threads/${threadId}/operations`,
        token: "a".repeat(32),
        body: {
          kind: "perform",
          mutationId,
          expectedThreadRevision: 7,
          expectedSettingsRevision: 3,
          operation: {
            action: "set_setting",
            settingId: "model",
            value: "model-option-1",
          },
        },
      },
      { path: "/api/application/session", token: null },
      {
        path: `/api/threads/${threadId}/operations`,
        token: "b".repeat(32),
        body: {
          kind: "perform",
          mutationId,
          expectedThreadRevision: 7,
          expectedSettingsRevision: 3,
          operation: {
            action: "set_setting",
            settingId: "model",
            value: "model-option-1",
          },
        },
      },
    ]);
  });

  it("posts a strict queued-input action and parses its authoritative projection", async () => {
    const calls: unknown[] = [];
    const mutationId = "20000000-0000-4000-8000-000000000001";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/application/session") {
          return Response.json(session());
        }
        calls.push(JSON.parse(String(init?.body)) as unknown);
        return Response.json({
          status: "queue_cancelled",
          queuedInputId: "queued-1",
          mutationId,
          threadRevision: 8,
          queue: [
            {
              id: "queued-2",
              deliveryOperationId: "queued-operation-2",
              sequence: 2,
              origin: "user",
              isHead: true,
              state: "pending",
              resolvedDeliveryMode: "queue",
              attachmentCount: 0,
              taskCount: 0,
              preview: { text: "Next input" },
              createdAt: "2026-08-07T07:00:00.000Z",
            },
          ],
        });
      }),
    );
    const client = new ApiClient();
    await expect(
      client.operateThread(threadId, {
        kind: "cancel_queued_input",
        queuedInputId: "queued-1",
        mutationId,
        expectedThreadRevision: 7,
      }),
    ).resolves.toMatchObject({
      status: "queue_cancelled",
      threadRevision: 8,
      queue: [{ id: "queued-2", isHead: true }],
    });
    expect(calls).toEqual([
      {
        kind: "cancel_queued_input",
        queuedInputId: "queued-1",
        mutationId,
        expectedThreadRevision: 7,
      },
    ]);
  });

  it("preserves normalized retryability and treats malformed errors as uncertain", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === "/api/application/session") {
          return Response.json(session());
        }
        requestCount += 1;
        if (requestCount === 1) {
          return Response.json(
            {
              error: {
                code: "conflict",
                message: "Fork prerequisites changed.",
                retryable: false,
              },
            },
            { status: 409 },
          );
        }
        return Response.json(
          { error: { code: "conflict", message: "Missing retryability." } },
          { status: 409 },
        );
      }),
    );
    const client = new ApiClient();
    const request = {
      boundary: "selected_completed_turn" as const,
      sourceTurnId: "turn-1",
      expectedTurnRevision: 2,
      mutationId: "20000000-0000-4000-8000-000000000002",
    };

    await expect(client.forkThread(threadId, request)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      retryable: false,
      message: "Fork prerequisites changed.",
    } satisfies Partial<ApiError>);
    await expect(client.forkThread(threadId, request)).rejects.toMatchObject({
      status: 409,
      code: "invalid_response",
      retryable: true,
    } satisfies Partial<ApiError>);
  });

  it("returns admitted tool-client metadata for an ambiguous create without retrying", async () => {
    const clientId = "10000000-0000-4000-8000-000000000099";
    const admitted = {
      id: clientId,
      creationRequestId: "20000000-0000-4000-8000-000000000099",
      name: "External client",
      state: "enabled" as const,
      availability: "available" as const,
      toolIds: ["thread.status"],
      tools: [{ id: "thread.status", available: true }],
      defaultEnvironmentId: environmentId,
      allowedEnvironmentIds: [environmentId],
      environments: [{ id: environmentId, available: true }],
      defaultWorkspaceId: null,
      defaultWorkspaceAvailable: null,
      defaultThreadId: null,
      defaultThreadAvailable: null,
      policyRevision: 1,
      credentialGeneration: 1,
      createdAt: "2026-08-15T12:00:00.000Z",
      updatedAt: "2026-08-15T12:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/application/session") {
        return Response.json(session());
      }
      return Response.json(
        {
          error: {
            code: "conflict",
            message: "The tool client creation request was already accepted.",
            retryable: false,
          },
          client: admitted,
        },
        { status: 409 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();

    await expect(
      client.createToolClient({
        requestId: admitted.creationRequestId,
        name: admitted.name,
        toolIds: admitted.toolIds,
        defaultEnvironmentId: environmentId,
        allowedEnvironmentIds: [environmentId],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      retryable: false,
      details: { client: admitted },
    } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the normalized application-draining response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === "/api/application/session") {
          return Response.json(session());
        }
        return Response.json(
          {
            error: {
              code: "application_draining",
              message: "The application is shutting down.",
              retryable: true,
            },
          },
          { status: 503 },
        );
      }),
    );
    const client = new ApiClient();

    await expect(
      client.forkThread(threadId, {
        boundary: "selected_completed_turn",
        sourceTurnId: "turn-1",
        expectedTurnRevision: 2,
        mutationId: "20000000-0000-4000-8000-000000000003",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "application_draining",
      retryable: true,
      message: "The application is shutting down.",
    } satisfies Partial<ApiError>);
  });

  it("seeks a normalized turn without accepting a provider cursor", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        calls.push({
          path,
          ...(init?.body
            ? { body: JSON.parse(String(init.body)) as unknown }
            : {}),
        });
        if (path === "/api/application/session") {
          return Response.json(session());
        }
        const requestedTurnId = JSON.parse(String(init?.body)).turnId as string;
        return Response.json({
          status: "found",
          targetTurnId:
            requestedTurnId === "turn-mismatch" ? "turn-old" : requestedTurnId,
          page: {
            orderedTurnIds: ["turn-old"],
            turnsById: {
              "turn-old": {
                id: "turn-old",
                revision: 2,
                status: "completed",
                endedBy: "agent_settled",
                orderedItemIds: [],
              },
            },
            forkSource: {
              selectedCompletedTurn: { available: true },
              latestProviderSnapshot: {
                available: false,
                unavailableReason: {
                  text: "Provider snapshots are unavailable.",
                },
              },
            },
            forksByTurnId: {
              "turn-old": {
                sourceTurnId: "turn-old",
                expectedTurnRevision: 2,
                available: true,
              },
            },
            itemsById: {},
          },
        });
      }),
    );

    const api = new ApiClient();
    const result = await api.seekHistoryTurn(threadId, "turn-old", "summary");

    expect(result).toMatchObject({
      status: "found",
      targetTurnId: "turn-old",
    });
    await expect(
      api.seekHistoryTurn(threadId, "turn-mismatch", "summary"),
    ).rejects.toThrow("did not match the requested turn");
    expect(calls).toEqual([
      { path: "/api/application/session" },
      {
        path: `/api/threads/${threadId}/history/seek`,
        body: { turnId: "turn-old", activityDetail: "summary" },
      },
      {
        path: `/api/threads/${threadId}/history/seek`,
        body: { turnId: "turn-mismatch", activityDetail: "summary" },
      },
    ]);
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, (event: { data: string }) => void>();
  onopen?: () => void;
  onerror?: () => void;
  closed = false;
  readyState = 0;

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListener): void {
    this.listeners.set(
      name,
      listener as unknown as (event: { data: string }) => void,
    );
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(name: string, value: unknown): void {
    this.listeners.get(name)?.({ data: JSON.stringify(value) });
  }

  emitRaw(name: string, data: string): void {
    this.listeners.get(name)?.({ data });
  }
}

describe("BrowserEventStreamTransport", () => {
  it("delivers checkpoints separately and preserves checkpoint, event, live ordering", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const order: string[] = [];
    const onCheckpoint = vi.fn(() => {
      order.push("checkpoint");
    });
    const transport = new BrowserEventStreamTransport();
    transport.subscribeThread(threadId, {
      activityDetail: "full",
      onCheckpoint,
      onEnvelope: () => { order.push("event"); },
      onLive: () => { order.push("live"); },
      onConnection: (state) => { order.push(state); },
    });
    const source = FakeEventSource.instances[0]!;
    const checkpoint = {
      eventId: `${hubId}.10`,
      projectionGeneration: "projection-1",
    };
    source.emit("thread-checkpoint", checkpoint);
    source.emit("thread", { event: { type: "usage_changed" } });
    source.emit("thread-live", {});
    expect(onCheckpoint).toHaveBeenCalledWith(checkpoint);
    expect(order).toEqual(["checkpoint", "event", "live", "connected"]);
    transport.closeAll();
  });

  it("reopens on malformed checkpoints and ignores the abandoned source", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const onCheckpoint = vi.fn();
    const onProtocolError = vi.fn();
    const transport = new BrowserEventStreamTransport();
    transport.subscribeThread(threadId, {
      activityDetail: "full",
      onCheckpoint,
      onProtocolError,
      onEnvelope: () => undefined,
      onConnection: () => undefined,
    });
    const first = FakeEventSource.instances[0]!;
    first.emitRaw("thread-checkpoint", "not JSON");
    expect(first.closed).toBe(true);
    expect(onProtocolError).toHaveBeenCalledOnce();
    expect(FakeEventSource.instances).toHaveLength(2);
    first.emit("thread-checkpoint", {});
    expect(onCheckpoint).not.toHaveBeenCalled();
    transport.closeAll();
  });

  it("delivers a classified thread load error and stops native retries", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const onLoadError = vi.fn();
    const transport = new BrowserEventStreamTransport();
    transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: () => undefined,
      onEnvelope: () => undefined,
      onLoadError,
    });
    const source = FakeEventSource.instances[0]!;

    source.emit("thread-load-error", {
      format: "sedes-thread-load-error-v1",
      requestId: "request-1",
      error: {
        code: "workspace_missing",
        message: "The workspace directory was moved or removed.",
        retryable: false,
      },
    });

    expect(source.closed).toBe(true);
    expect(onLoadError).toHaveBeenCalledWith({
      format: "sedes-thread-load-error-v1",
      requestId: "request-1",
      error: {
        code: "workspace_missing",
        message: "The workspace directory was moved or removed.",
        retryable: false,
      },
    });
    transport.reconnectAll();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("fails closed without retrying a malformed thread load error", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const onLoadError = vi.fn();
    const onTerminalProtocolError = vi.fn();
    const transport = new BrowserEventStreamTransport();
    transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: () => undefined,
      onEnvelope: () => undefined,
      onLoadError,
      onTerminalProtocolError,
    });
    const source = FakeEventSource.instances[0]!;

    source.emitRaw("thread-load-error", "{not-json");

    expect(source.closed).toBe(true);
    expect(onLoadError).not.toHaveBeenCalled();
    expect(onTerminalProtocolError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Invalid normalized thread load error.",
      }),
    );
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("records content-free item arrival cadence without changing delivery", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "sedes-diagnostics-streaming" ? "true" : null,
    });
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const onEnvelope = vi.fn();
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: () => undefined,
      onEnvelope,
    });
    const source = FakeEventSource.instances[0]!;
    const itemEnvelope = (sequence: number, markdown: string) => ({
      eventId: `${hubId}.${sequence}`,
      projectionGeneration: "projection-1",
      event: {
        type: "item_upsert",
        generation: "projection-1",
        item: {
          id: "assistant-1",
          turnId: "turn-1",
          kind: "assistant_message",
          status: "streaming",
          revision: sequence,
          markdown: { text: markdown },
        },
      },
    });

    source.emit("thread", itemEnvelope(1, "private first delta"));
    source.emit("thread", itemEnvelope(2, "private second delta"));

    expect(onEnvelope).toHaveBeenCalledTimes(2);
    expect(readDiagnostics()).toHaveLength(2);
    expect(readDiagnostics()[1]).toMatchObject({
      category: "streaming",
      event: "sse_item_received",
      details: {
        arrivalGapMilliseconds: expect.any(Number),
        eventDataCharacters: expect.any(Number),
        eventType: "item_upsert",
        itemKind: "assistant_message",
        itemStatus: "streaming",
      },
    });
    expect(JSON.stringify(readDiagnostics())).not.toContain("private");
    subscription.close();
  });

  it("opts a thread stream into bounded load timing without affecting envelopes", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const onEventSourceCreated = vi.fn();
    const onResponseHeadersReceived = vi.fn();
    const onEnvelopeParsed = vi.fn();
    const onServerDiagnostic = vi.fn();
    const onReplayDiagnostic = vi.fn();
    const onHandshakeDiagnostic = vi.fn();
    const onLive = vi.fn();
    const onEnvelope = vi.fn();
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: () => undefined,
      onEnvelope,
      loadDiagnostics: {
        onEventSourceCreated,
        onResponseHeadersReceived,
        onEnvelopeParsed,
        onServerDiagnostic,
        onReplayDiagnostic,
        onHandshakeDiagnostic,
        onLive,
      },
    });
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(
      `/api/threads/${threadId}/events?activityDetail=full&diagnostics=thread_load`,
    );
    expect(onEventSourceCreated).toHaveBeenCalledOnce();

    source.onopen?.();
    const handshakeDiagnostic = {
      format: "sedes-thread-handshake-server-v1",
      requestId: "00000000-0000-4000-8000-000000000001",
      routeSetupMilliseconds: 4,
      runtimeAcquireMilliseconds: 6300,
      requestToHeadersMilliseconds: 6400,
    };
    source.emit("thread-handshake-diagnostic", handshakeDiagnostic);
    expect(onHandshakeDiagnostic).toHaveBeenCalledWith(handshakeDiagnostic);
    source.emit("thread-handshake-diagnostic", {
      ...handshakeDiagnostic,
      requestId: "PRIVATE_TOKEN",
    });
    source.emit("thread-handshake-diagnostic", {
      ...handshakeDiagnostic,
      runtimeAcquireMilliseconds: -1,
    });
    source.emit("thread-handshake-diagnostic", {
      ...handshakeDiagnostic,
      extra: "PRIVATE_PAYLOAD",
    });
    source.emitRaw("thread-handshake-diagnostic", "not json");
    expect(onHandshakeDiagnostic).toHaveBeenCalledOnce();

    const envelope = {
      eventId: `${hubId}.1`,
      event: { type: "snapshot", generation: "projection-1" },
    };
    source.emit("thread", envelope);
    source.emit("thread-load-diagnostic", {
      format: "sedes-thread-load-server-v1",
      handshake: "current_checkpoint",
      routeSetupMilliseconds: 1,
      runtimeAcquireMilliseconds: 2,
      requestToSnapshotWriteMilliseconds: 3,
      snapshotCaptureMilliseconds: 0,
      snapshotEncodeMilliseconds: 4,
      snapshotSummaryMilliseconds: 0.5,
      snapshotWriteMilliseconds: 5,
      snapshotFrameBytes: 1_024,
      turnCount: 10,
      itemCount: 20,
      largestTurnItemCount: 8,
    });
    source.emit("thread-replay-diagnostic", {
      format: "sedes-thread-replay-server-v1",
      cursorSource: "explicit_query",
      outcome: "replayed",
      replayedEventCount: 3,
    });
    source.emit("thread-live", {});

    expect(onResponseHeadersReceived).toHaveBeenCalledOnce();
    expect(onEnvelope).toHaveBeenCalledWith(envelope);
    expect(onEnvelopeParsed).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope,
        eventDataCharacters: expect.any(Number),
        durationMilliseconds: expect.any(Number),
      }),
    );
    expect(onServerDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotFrameBytes: 1_024 }),
    );
    expect(onReplayDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "replayed", replayedEventCount: 3 }),
    );
    expect(onLive).toHaveBeenCalledOnce();
    source.emitRaw("thread-load-diagnostic", "not json");
    source.emit("thread-load-diagnostic", { format: "wrong" });
    source.emit("thread", envelope);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(onEnvelope).toHaveBeenCalledTimes(2);
    subscription.close();
  });

  it("contains throwing load observers without reopening the normalized stream", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const onEnvelope = vi.fn();
    const onConnection = vi.fn();
    const onProtocolError = vi.fn();
    const throws = () => {
      throw new Error("diagnostic observer failed");
    };
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection,
      onEnvelope,
      onProtocolError,
      loadDiagnostics: {
        onEventSourceCreated: throws,
        onResponseHeadersReceived: throws,
        onEnvelopeParsed: throws,
        onHandshakeDiagnostic: throws,
        onServerDiagnostic: throws,
        onReplayDiagnostic: throws,
        onLive: throws,
      },
    });
    const source = FakeEventSource.instances[0]!;

    source.onopen?.();
    source.emit("thread-handshake-diagnostic", {
      format: "sedes-thread-handshake-server-v1",
      requestId: null,
      routeSetupMilliseconds: 1,
      runtimeAcquireMilliseconds: 2,
      requestToHeadersMilliseconds: 3,
    });
    source.emit("thread", {
      eventId: `${hubId}.1`,
      event: { type: "snapshot", generation: "projection-1" },
    });
    source.emit("thread-load-diagnostic", {
      format: "sedes-thread-load-server-v1",
      handshake: "current_checkpoint",
      routeSetupMilliseconds: 1,
      runtimeAcquireMilliseconds: 2,
      requestToSnapshotWriteMilliseconds: 3,
      snapshotCaptureMilliseconds: 0,
      snapshotEncodeMilliseconds: 4,
      snapshotSummaryMilliseconds: 0.5,
      snapshotWriteMilliseconds: 5,
      snapshotFrameBytes: 1_024,
      turnCount: 10,
      itemCount: 20,
      largestTurnItemCount: 8,
    });
    source.emit("thread-live", {});

    expect(onEnvelope).toHaveBeenCalledOnce();
    expect(onConnection).toHaveBeenCalledWith("connected");
    expect(onProtocolError).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
    subscription.close();
  });

  it("immediately reopens a native-suspended CONNECTING stream", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const states: ConnectionState[] = [];
    const transport = new BrowserEventStreamTransport();
    let replayCursor: string | undefined;
    const subscription = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: (state) => states.push(state),
      onEnvelope: () => undefined,
      getReplayCursor: () => replayCursor,
    });
    const first = FakeEventSource.instances[0]!;
    first.readyState = 0;
    replayCursor = `${hubId}.7`;
    transport.markAllNativeSuspended();
    expect(first.closed).toBe(true);
    transport.reconnectAll();
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.instances[1]!;
    expect(second.url).toBe(
      `/api/threads/${threadId}/events?activityDetail=full&replayCursor=${encodeURIComponent(replayCursor)}`,
    );
    second.readyState = 1;
    second.emit("thread-live", {});
    expect(states).toEqual(["disconnected", "reconnecting", "connected"]);
    subscription.close();
  });

  it("reevaluates the application cursor when reopening a suspended stream", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    let replayCursor: string | undefined;
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeApplication({
      onConnection: () => undefined,
      onEnvelope: () => undefined,
      getReplayCursor: () => replayCursor,
    });
    expect(FakeEventSource.instances[0]?.url).toBe("/api/application/events");

    replayCursor = `${hubId}.42`;
    transport.markAllNativeSuspended();
    transport.reconnectAll();

    expect(FakeEventSource.instances[1]?.url).toBe(
      `/api/application/events?replayCursor=${encodeURIComponent(replayCursor)}`,
    );
    subscription.close();
  });

  it("uses an authoritative replacement handshake only for the first source", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    let replayCursor = `${hubId}.7`;
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeApplication({
      onConnection: () => undefined,
      onEnvelope: () => undefined,
      getReplayCursor: () => replayCursor,
      initialHandshake: "authoritative_replacement",
    });

    expect(FakeEventSource.instances[0]?.url).toBe(
      "/api/application/events?handshake=authoritative_replacement",
    );

    replayCursor = `${hubId}.8`;
    transport.markAllNativeSuspended();
    transport.reconnectAll();

    expect(FakeEventSource.instances[1]?.url).toBe(
      `/api/application/events?replayCursor=${encodeURIComponent(replayCursor)}`,
    );
    subscription.close();
  });

  it("composes replay and diagnostics queries and reevaluates the cursor for every explicit source", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    let replayCursor: string | undefined;
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: () => undefined,
      onEnvelope: () => undefined,
      getReplayCursor: () => replayCursor,
      loadDiagnostics: {
        onEventSourceCreated: () => undefined,
        onResponseHeadersReceived: () => undefined,
        onEnvelopeParsed: () => undefined,
        onHandshakeDiagnostic: () => undefined,
        onServerDiagnostic: () => undefined,
        onReplayDiagnostic: () => undefined,
        onLive: () => undefined,
      },
    });
    expect(FakeEventSource.instances[0]?.url).toBe(
      `/api/threads/${threadId}/events?activityDetail=full&diagnostics=thread_load`,
    );

    replayCursor = `${hubId}.42`;
    transport.markAllNativeSuspended();
    transport.reconnectAll();
    expect(FakeEventSource.instances[1]?.url).toBe(
      `/api/threads/${threadId}/events?activityDetail=full&diagnostics=thread_load&replayCursor=${encodeURIComponent(replayCursor)}`,
    );
    subscription.close();
  });

  it.each([
    ["malformed", "not-a-thread-event-id"],
    ["oversized", `${hubId}.${"1".repeat(241)}`],
  ])("omits a %s replay cursor returned by the client store", (_, cursor) => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const onEventSourceCreated = vi.fn();
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: () => undefined,
      onEnvelope: () => undefined,
      getReplayCursor: () => cursor,
      loadDiagnostics: {
        onEventSourceCreated,
        onResponseHeadersReceived: () => undefined,
        onEnvelopeParsed: () => undefined,
        onHandshakeDiagnostic: () => undefined,
        onServerDiagnostic: () => undefined,
        onReplayDiagnostic: () => undefined,
        onLive: () => undefined,
      },
    });

    expect(FakeEventSource.instances[0]?.url).toBe(
      `/api/threads/${threadId}/events?activityDetail=full&diagnostics=thread_load`,
    );
    expect(onEventSourceCreated).toHaveBeenCalledWith({
      cursorAvailable: false,
    });
    subscription.close();
  });

  it("does not report connected when the thread store rejects the replay suffix", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const states: ConnectionState[] = [];
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: (state) => states.push(state),
      onEnvelope: () => undefined,
      onLive: () => false,
    });

    FakeEventSource.instances[0]?.emit("thread-live", {});
    expect(states).not.toContain("connected");
    subscription.close();
  });

  it("uses authenticated fetch for configured streams without cross-origin cookies", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new BrowserEventStreamTransport(
      configuredSedesServer("http://192.168.1.20:4783"),
    );
    const subscription = transport.subscribeApplication({
      onConnection: () => undefined,
      onEnvelope: () => undefined,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.20:4783/api/application/events",
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    expect(FakeEventSource.instances).toHaveLength(0);
    transport.reconnectAll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    subscription.close();
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("keeps healthy streams open when a visible tab resumes", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeApplication({
      onConnection: () => undefined,
      onEnvelope: () => undefined,
    });
    const source = FakeEventSource.instances[0]!;
    source.readyState = 1;

    transport.reconnectAll();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source.closed).toBe(false);
    subscription.close();
  });

  it("keeps a connecting stream on its cursor-preserving native retry", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeApplication({
      onConnection: () => undefined,
      onEnvelope: () => undefined,
    });
    const source = FakeEventSource.instances[0]!;
    source.readyState = 0;

    transport.reconnectAll();

    expect(source.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    subscription.close();
  });

  it("reports an application EventSource that closes permanently", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const onTerminalError = vi.fn();
    const states: ConnectionState[] = [];
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeApplication({
      onConnection: (state) => states.push(state),
      onEnvelope: () => undefined,
      onTerminalError,
    });
    const source = FakeEventSource.instances[0]!;
    source.readyState = 2;

    source.onerror?.();

    expect(states.at(-1)).toBe("reconnecting");
    expect(onTerminalError).toHaveBeenCalledOnce();
    expect(onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "The application event stream closed permanently.",
      }),
    );
    subscription.close();
  });

  it("keeps an offline CONNECTING stream on its cursor-preserving native retry", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: false });
    const windowTarget = new EventTarget();
    vi.stubGlobal("window", windowTarget);
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeApplication({
      onConnection: () => undefined,
      onEnvelope: () => undefined,
    });
    const source = FakeEventSource.instances[0]!;
    source.readyState = 0;

    windowTarget.dispatchEvent(new Event("offline"));
    transport.reconnectAll();

    expect(source.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    subscription.close();
  });

  it("reopens a native-suspended OPEN stream while preserving healthy peers", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const transport = new BrowserEventStreamTransport();
    const application = transport.subscribeApplication({
      onConnection: () => undefined,
      onEnvelope: () => undefined,
    });
    const source = FakeEventSource.instances[0]!;
    source.readyState = 1;

    transport.markAllNativeSuspended();
    transport.reconnectAll();

    expect(source.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    application.close();
  });

  it("re-establishes an OPEN stream after the browser marked it offline", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const windowTarget = new EventTarget();
    vi.stubGlobal("window", windowTarget);
    const states: ConnectionState[] = [];
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: (state) => states.push(state),
      onEnvelope: () => undefined,
    });
    const source = FakeEventSource.instances[0]!;
    source.readyState = 1;

    windowTarget.dispatchEvent(new Event("offline"));
    expect(states.at(-1)).toBe("disconnected");
    transport.reconnectAll();

    expect(source.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(states.at(-1)).toBe("reconnecting");
    subscription.close();
  });

  it("keeps a cursor-preserving source after native retry clears its stale mark", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const windowTarget = new EventTarget();
    vi.stubGlobal("window", windowTarget);
    const states: ConnectionState[] = [];
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: (state) => states.push(state),
      onEnvelope: () => undefined,
    });
    const source = FakeEventSource.instances[0]!;
    source.readyState = 1;

    windowTarget.dispatchEvent(new Event("offline"));
    source.readyState = 0;
    source.onerror?.();
    transport.reconnectAll();
    expect(source.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    source.readyState = 1;
    source.emit("thread-live", {});
    expect(states.at(-1)).toBe("connected");

    transport.reconnectAll();

    expect(source.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    subscription.close();
  });

  it("reopens only terminally closed streams without replacing healthy peers", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const transport = new BrowserEventStreamTransport();
    const application = transport.subscribeApplication({
      onConnection: () => undefined,
      onEnvelope: () => undefined,
    });
    const thread = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: () => undefined,
      onEnvelope: () => undefined,
    });
    const applicationSource = FakeEventSource.instances[0]!;
    const threadSource = FakeEventSource.instances[1]!;
    applicationSource.readyState = 2;
    threadSource.readyState = 1;

    transport.reconnectAll();

    expect(applicationSource.closed).toBe(true);
    expect(threadSource.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(3);
    application.close();
    thread.close();
  });

  it("owns normalized named streams and replaces a malformed JSON stream", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const states: string[] = [];
    const envelopes: unknown[] = [];
    const errors: Error[] = [];
    const transport = new BrowserEventStreamTransport();

    let replayCursor: string | undefined = `${hubId}.7`;
    const subscription = transport.subscribeThread(threadId, {
      onCheckpoint: vi.fn(),
      activityDetail: "full",
      onConnection: (state) => states.push(state),
      onEnvelope: (envelope) => envelopes.push(envelope),
      getReplayCursor: () => replayCursor,
      onProtocolError: (error) => {
        errors.push(error);
        replayCursor = undefined;
      },
    });
    const first = FakeEventSource.instances[0]!;
    expect(first.url).toBe(
      `/api/threads/${threadId}/events?activityDetail=full&replayCursor=${encodeURIComponent(`${hubId}.7`)}`,
    );
    expect(first.options).toEqual({ withCredentials: true });

    first.onopen?.();
    expect(states).not.toContain("connected");
    first.emit("thread-live", {});
    expect(states).toContain("connected");
    const envelope = {
      eventId: `${hubId}.8`,
      projectionGeneration: "projection-1",
      event: {
        type: "notice",
        generation: "projection-1",
        notice: {
          id: "notice-1",
          tone: "info",
          message: { text: "Connected" },
          createdAt: "2026-07-30T15:00:00.000Z",
        },
      },
    };
    first.emit("thread", envelope);
    expect(envelopes).toEqual([envelope]);

    first.emitRaw("thread", "{invalid");
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances[1]?.url).toBe(
      `/api/threads/${threadId}/events?activityDetail=full`,
    );
    expect(states).toContain("reconnecting");
    expect(errors).toHaveLength(1);

    const stateCount = states.length;
    const envelopeCount = envelopes.length;
    first.emit("thread-live", {});
    first.onerror?.();
    first.emit("thread", envelope);
    expect(states).toHaveLength(stateCount);
    expect(envelopes).toHaveLength(envelopeCount);

    subscription.close();
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
  });

  it("uses the normalized application stream path and event name", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeApplication({
      onConnection: () => undefined,
      onEnvelope: () => undefined,
    });

    expect(FakeEventSource.instances[0]?.url).toBe("/api/application/events");
    expect(FakeEventSource.instances[0]?.listeners.has("application")).toBe(
      true,
    );
    expect(
      FakeEventSource.instances[0]?.listeners.has("application-live"),
    ).toBe(true);
    subscription.close();
  });

  it("owns a workspace-scoped path-free file invalidation stream", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("navigator", { onLine: true });
    const invalidated = vi.fn();
    const states: ConnectionState[] = [];
    const transport = new BrowserEventStreamTransport();
    const subscription = transport.subscribeWorkspaceFiles("workspace/one", {
      onInvalidate: invalidated,
      onConnection: (state) => states.push(state),
    });

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/workspaces/workspace%2Fone/files/events");
    expect(source.listeners.has("workspace-files-invalidated")).toBe(true);
    expect(source.listeners.has("workspace-files-live")).toBe(true);
    source.emit("workspace-files-invalidated", {});
    source.emit("workspace-files-live", {});
    expect(invalidated).toHaveBeenCalledOnce();
    expect(states).toEqual(["connected"]);

    source.readyState = 0;
    transport.markAllNativeSuspended();
    transport.reconnectAll();
    expect(source.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    subscription.close();
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
  });
});
