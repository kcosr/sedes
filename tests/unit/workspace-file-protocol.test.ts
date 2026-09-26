import { describe, expect, it } from "vitest";
import {
  SEDES_CLIENT_PROTOCOL_VERSION,
  WORKSPACE_FILE_MAX_CONTENT_BYTES,
  WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES,
  WORKSPACE_FILE_MAX_PATH_BYTES,
  workspaceFileAbsolutePathSchema,
  workspaceFileContentResultSchema,
  workspaceFileDirectoryQuerySchema,
  workspaceFileDirectoryResultSchema,
  workspaceFileDownloadQuerySchema,
  workspaceFileLinkResolveRequestSchema,
  workspaceFileLinkResolveResultSchema,
  workspaceFileListQuerySchema,
  workspaceFileListResultSchema,
  workspaceFileRootCreateRequestSchema,
  workspaceFileRootDeleteRouteParametersSchema,
  workspaceFileRootDescriptorSchema,
  workspaceFileRootDisplayLabelSchema,
  workspaceFileRootIdSchema,
  workspaceFileRootsResultSchema,
  workspaceFileStatusResultSchema,
  workspaceFileSupplementalRootIdSchema,
  workspaceFileWriteRequestSchema,
} from "../../src/shared/index.js";

const supplementalRootId = "root-10000000-0000-4000-8000-000000000001";

describe("workspace-file root protocol", () => {
  it("uses one root-qualified addressing shape", () => {
    expect(workspaceFileRootIdSchema.parse("primary")).toBe("primary");
    expect(workspaceFileRootIdSchema.parse(supplementalRootId)).toBe(
      supplementalRootId,
    );
    expect(
      workspaceFileSupplementalRootIdSchema.safeParse("primary").success,
    ).toBe(false);

    expect(
      workspaceFileListQuerySchema.parse({ rootId: supplementalRootId }),
    ).toEqual({
      rootId: supplementalRootId,
      pageSize: 1_000,
    });
    expect(workspaceFileListQuerySchema.safeParse({}).success).toBe(false);
    expect(
      workspaceFileDirectoryQuerySchema.parse({ rootId: supplementalRootId }),
    ).toEqual({
      rootId: supplementalRootId,
      directory: "",
      pageSize: 1_000,
    });
    expect(
      workspaceFileDirectoryResultSchema.parse({
        availability: "available",
        rootId: supplementalRootId,
        directory: "src",
        entries: [
          { path: "src/components", kind: "directory" },
          { path: "src/index.ts", kind: "file" },
        ],
        scanTruncated: false,
      }),
    ).toMatchObject({ directory: "src" });
    expect(
      workspaceFileWriteRequestSchema.safeParse({
        path: "notes/design.md",
        content: "# Design\n",
        expectedRevision: "revision-1",
      }).success,
    ).toBe(false);
    expect(
      workspaceFileDownloadQuerySchema.parse({
        rootId: supplementalRootId,
        path: "notes/design.md",
        expectedRevision: "revision-1",
      }),
    ).toEqual({
      rootId: supplementalRootId,
      path: "notes/design.md",
      expectedRevision: "revision-1",
    });
    expect(
      workspaceFileDownloadQuerySchema.safeParse({
        rootId: supplementalRootId,
        path: "notes/design.md",
      }).success,
    ).toBe(false);
    expect(
      workspaceFileListResultSchema.parse({
        availability: "available",
        rootId: supplementalRootId,
        entries: ["notes/design.md"],
        scanTruncated: false,
      }),
    ).toMatchObject({ rootId: supplementalRootId });
  });

  it("exposes display paths without canonical internals and keeps watcher state per root", () => {
    const descriptor = {
      kind: "supplemental" as const,
      rootId: supplementalRootId,
      displayLabel: "Agent context",
      displayPath: { text: "/home/person/agent-context/repos/sedes" },
      sortOrder: 1,
      revision: 1,
      availability: "available" as const,
      watchable: false,
    };
    expect(workspaceFileRootDescriptorSchema.parse(descriptor)).toEqual(
      descriptor,
    );
    expect(
      workspaceFileRootDescriptorSchema.safeParse({
        ...descriptor,
        canonicalPath: "/home/person/agent-context/repo",
      }).success,
    ).toBe(false);
    expect(
      workspaceFileRootsResultSchema.safeParse({ roots: [descriptor] }).success,
    ).toBe(false);
    expect(
      workspaceFileRootDescriptorSchema.parse({
        kind: "primary",
        rootId: "primary",
        displayLabel: "/",
        displayPath: { text: "/" },
        sortOrder: 0,
        revision: 0,
        availability: "available",
        watchable: true,
      }),
    ).toMatchObject({
      rootId: "primary",
      displayLabel: "/",
      displayPath: { text: "/" },
    });
    expect(
      workspaceFileRootDescriptorSchema.safeParse({
        ...descriptor,
        availability: "unavailable",
        diagnosticCode: "workspace_file_root_missing",
        watchable: true,
      }).success,
    ).toBe(false);
    expect(
      workspaceFileRootDescriptorSchema.parse({
        kind: "linked_worktree",
        rootId: "6d67f4ea-17cf-42d5-9986-bbca3598e437",
        displayLabel: "missing",
        displayPath: { text: "/worktrees/missing" },
        sortOrder: 2,
        revision: 4,
        branch: "feature/missing",
        head: "a".repeat(40),
        provenance: { kind: "unknown", ahead: null, behind: null },
        removal: { status: "forget" },
        availability: "unavailable",
        watchable: false,
        diagnosticCode: "workspace_file_root_unavailable",
      }),
    ).toMatchObject({ removal: { status: "forget" } });
  });

  it("enforces the supplemental label grammar", () => {
    expect(workspaceFileRootDisplayLabelSchema.parse("Agent context")).toBe(
      "Agent context",
    );
    expect(workspaceFileRootDisplayLabelSchema.parse("x".repeat(240))).toBe(
      "x".repeat(240),
    );
    for (const invalid of [
      "",
      ".",
      "..",
      "a/b",
      "a\\b",
      "a\0b",
      "a\nb",
      "a\u007fb",
      "x".repeat(241),
    ]) {
      expect(
        workspaceFileRootDisplayLabelSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });

  it("accepts only bounded normalized absolute platform paths at attach", () => {
    const request = {
      mutationId: "10000000-0000-4000-8000-000000000001",
      path: "/home/person/agent-context/repos/sedes",
      displayLabel: "Agent context",
    };
    expect(workspaceFileRootCreateRequestSchema.parse(request)).toEqual(
      request,
    );
    for (const absolutePath of [
      "C:\\repo",
      "C:\\",
      "\\\\server\\share\\repo",
      "\\\\server\\share\\",
    ]) {
      expect(
        workspaceFileRootCreateRequestSchema.safeParse({
          ...request,
          path: absolutePath,
        }).success,
      ).toBe(true);
    }
    for (const invalidPath of [
      "relative/path",
      "/home//repo",
      "/home/../repo",
      "/home/./repo",
      "C:repo",
      "C:\\repo\\..\\escape",
      "C:\\repo\\file:stream",
      "C:\\repo\\NUL.txt",
      "C:\\repo\\trailing.",
      "\\\\?\\C:\\repo",
      "\\\\server",
      "\\\\server\\share",
      `/home/${"é".repeat(WORKSPACE_FILE_MAX_PATH_BYTES / 2)}`,
    ]) {
      expect(
        workspaceFileRootCreateRequestSchema.safeParse({
          ...request,
          path: invalidPath,
        }).success,
      ).toBe(false);
    }
  });

  it("forbids deleting the projected primary root", () => {
    const workspaceId = "20000000-0000-4000-8000-000000000001";
    expect(
      workspaceFileRootDeleteRouteParametersSchema.safeParse({
        workspaceId,
        rootId: "primary",
      }).success,
    ).toBe(false);
    expect(
      workspaceFileRootDeleteRouteParametersSchema.safeParse({
        workspaceId,
        rootId: supplementalRootId,
      }).success,
    ).toBe(true);
  });

  it("returns aggregate, independently unavailable root status", () => {
    const result = {
      roots: [
        {
          availability: "available" as const,
          rootId: "primary",
          isGitRepository: true,
          entries: [
            {
              rootId: "primary",
              path: "src/index.ts",
              status: "modified" as const,
            },
          ],
          truncated: false,
        },
        {
          availability: "unavailable" as const,
          rootId: supplementalRootId,
          diagnosticCode: "workspace_file_root_missing",
        },
      ],
    };
    expect(workspaceFileStatusResultSchema.parse(result)).toEqual(result);
    expect(
      workspaceFileStatusResultSchema.safeParse({
        roots: [
          {
            ...result.roots[0],
            entries: [
              {
                rootId: supplementalRootId,
                path: "src/index.ts",
                status: "modified",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      workspaceFileStatusResultSchema.safeParse({
        availability: "unavailable",
        diagnosticCode: "one_root_failed",
      }).success,
    ).toBe(false);
  });

  it("accepts status for more than eight non-primary roots", () => {
    const roots = [
      {
        availability: "available" as const,
        rootId: "primary",
        isGitRepository: true,
        entries: [],
        truncated: false,
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        availability: "available" as const,
        rootId: `linked-worktree-${index + 1}`,
        isGitRepository: true,
        entries: [],
        truncated: false,
      })),
    ];

    expect(workspaceFileStatusResultSchema.parse({ roots })).toEqual({ roots });
  });
});

describe("workspace-file content protocol", () => {
  const common = {
    availability: "available" as const,
    rootId: "primary" as const,
    path: "assets/pixel.png",
    sizeBytes: 8,
    revision: "revision-1",
  };
  const content = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]).toString("base64");

  it("accepts only complete canonical image payloads and explicit oversized state", () => {
    const available = {
      ...common,
      contentKind: "image" as const,
      previewState: "available" as const,
      mediaType: "image/png" as const,
      contentEncoding: "base64" as const,
      content,
      editable: false as const,
    };
    expect(workspaceFileContentResultSchema.parse(available)).toEqual(
      available,
    );

    const tooLarge = {
      ...common,
      sizeBytes: WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES + 1,
      contentKind: "image" as const,
      previewState: "too_large" as const,
      mediaType: "image/png" as const,
      editable: false as const,
    };
    expect(workspaceFileContentResultSchema.parse(tooLarge)).toEqual(tooLarge);

    for (const invalid of [
      { ...available, content: content.replace(/=$/u, "") },
      { ...available, content: "aGVsbG8_" },
      { ...available, content: `${content}\n` },
      { ...available, contentEncoding: "base64url" },
      { ...available, mediaType: "image/svg+xml" },
      { ...available, sizeBytes: common.sizeBytes + 1 },
      { ...available, editable: true },
      {
        ...available,
        truncation: { truncated: true, retainedBytes: 8, reason: "byte_limit" },
      },
      {
        ...available,
        content: Buffer.alloc(
          WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES + 1,
        ).toString("base64"),
        sizeBytes: WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES + 1,
      },
      { ...tooLarge, sizeBytes: WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES },
      { ...tooLarge, contentEncoding: "base64", content },
      { ...tooLarge, editable: true },
      {
        ...tooLarge,
        truncation: { truncated: true, retainedBytes: 0, reason: "byte_limit" },
      },
    ]) {
      expect(workspaceFileContentResultSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("strictly separates text and generic binary branches", () => {
    const text = {
      ...common,
      path: "notes/readme.md",
      contentKind: "text" as const,
      content: "# Readme",
      editable: true,
    };
    const binary = {
      ...common,
      path: "assets/unknown.bin",
      contentKind: "binary" as const,
      content: "" as const,
      editable: false as const,
    };
    expect(workspaceFileContentResultSchema.parse(text)).toEqual(text);
    expect(workspaceFileContentResultSchema.parse(binary)).toEqual(binary);
    for (const invalid of [
      { ...text, mediaType: "image/png" },
      { ...text, previewState: "available" },
      { ...text, contentEncoding: "base64" },
      { ...binary, content: "AA==" },
      { ...binary, editable: true },
      { ...binary, mediaType: "image/png" },
      { ...binary, previewState: "too_large" },
      { ...binary, contentEncoding: "base64" },
    ]) {
      expect(workspaceFileContentResultSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });
});

describe("workspace-file Markdown link resolver protocol", () => {
  it("keeps link references in a strict POST body and returns root-relative identity", () => {
    const request = {
      reference: {
        kind: "absolute" as const,
        path: "/home/person/repo/specs/design.md",
      },
    };
    expect(workspaceFileLinkResolveRequestSchema.parse(request)).toEqual(
      request,
    );
    expect(
      workspaceFileLinkResolveRequestSchema.parse({
        reference: { kind: "workspace_relative", path: "specs/design.md" },
      }),
    ).toEqual({
      reference: { kind: "workspace_relative", path: "specs/design.md" },
    });
    expect(
      workspaceFileLinkResolveRequestSchema.parse({
        reference: {
          kind: "root_relative",
          rootId: "supplemental-root",
          path: "specs/design.md",
        },
      }),
    ).toEqual({
      reference: {
        kind: "root_relative",
        rootId: "supplemental-root",
        path: "specs/design.md",
      },
    });
    expect(
      workspaceFileLinkResolveRequestSchema.safeParse({
        path: "/home/person/repo/specs/design.md",
      }).success,
    ).toBe(false);
    expect(
      workspaceFileLinkResolveResultSchema.parse({
        status: "resolved",
        rootId: "primary",
        path: "specs/design.md",
        rootVisibility: "listed",
      }),
    ).toEqual({
      status: "resolved",
      rootId: "primary",
      path: "specs/design.md",
      rootVisibility: "listed",
    });
    expect(
      workspaceFileLinkResolveResultSchema.parse({ status: "not_found" }),
    ).toEqual({ status: "not_found" });
    expect(
      workspaceFileLinkResolveResultSchema.safeParse({
        status: "resolved",
        rootId: "primary",
        path: "/home/person/repo/specs/design.md",
        rootVisibility: "listed",
      }).success,
    ).toBe(false);
  });

  it("bumps the atomic browser protocol revision", () => {
    expect(SEDES_CLIENT_PROTOCOL_VERSION).toBe(123);
    expect(
      workspaceFileAbsolutePathSchema.safeParse("/repo/file.md").success,
    ).toBe(true);
  });
});
