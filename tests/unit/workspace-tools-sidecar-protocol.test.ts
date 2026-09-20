import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SidecarOperationRegistry,
  SIDECAR_WIRE_VERSION,
  WORKSPACE_CONTEXT_V1_LIMITS,
  WORKSPACE_TOOLS_SHELL_V2_LIMITS,
  WORKSPACE_TOOLS_V2_LIMITS,
  controlHelloOperation,
  registerControlV2Operations,
  registerWorkspaceContextV1Operations,
  registerWorkspaceToolsV2Operations,
  validateSidecarHelloCapabilityEvidence,
  workspaceContextReadOperation,
  workspaceContextV1Operations,
  workspaceToolsDirectoryListOperation,
  workspaceToolsFileEditOperation,
  workspaceToolsFileReadOperation,
  workspaceToolsFileWriteOperation,
  workspaceToolsSearchFindOperation,
  workspaceToolsSearchGrepOperation,
  workspaceToolsRelativePathSchema,
  workspaceToolsV2Operations,
  workspaceToolsWorkspaceOpenOperation,
} from "../../src/internal/sidecar-protocol/index.js";

const workspaceHandle = randomUUID();
const operationId = randomUUID();

describe("workspace tools sidecar protocol", () => {
  it("registers only the closed workspace_tools@2 unary inventory", () => {
    const registry = new SidecarOperationRegistry();
    const handler = vi.fn() as never;
    registerWorkspaceToolsV2Operations(registry, {
      mutationList: handler,
      mutationInspect: handler,
      mutationAcknowledge: handler,
      openWorkspace: handler,
      closeWorkspace: handler,
      readFile: handler,
      writeFile: handler,
      editFile: handler,
      listDirectory: handler,
      findFiles: handler,
      grepFiles: handler,
    });

    expect(
      workspaceToolsV2Operations.map(({ operation }) => operation),
    ).toEqual([
      "mutation.list",
      "mutation.inspect",
      "mutation.acknowledge",
      "workspace.open",
      "workspace.close",
      "file.read",
      "file.write",
      "file.edit",
      "directory.list",
      "search.find",
      "search.grep",
    ]);
    expect(registry.capabilities()).toEqual([
      {
        capabilityId: "workspace_tools",
        majorVersion: 2,
        operations: [
          "directory.list",
          "file.edit",
          "file.read",
          "file.write",
          "mutation.acknowledge",
          "mutation.inspect",
          "mutation.list",
          "search.find",
          "search.grep",
          "workspace.close",
          "workspace.open",
        ],
      },
    ]);
  });

  it("accepts canonical admission and strictly workspace-relative operation paths", () => {
    expect(
      workspaceToolsWorkspaceOpenOperation.requestSchema.safeParse({
        admissionId: randomUUID(),
        declaredPath: "/srv/projects/sedes",
        policyRootPath: "/srv/projects",
      }).success,
    ).toBe(true);
    expect(
      workspaceToolsWorkspaceOpenOperation.requestSchema.safeParse({
        admissionId: randomUUID(),
        declaredPath: "/srv/projects/../secrets",
        policyRootPath: "/srv/projects",
      }).success,
    ).toBe(false);

    for (const invalidPath of ["/etc/passwd", "../escape", "src//a.ts"]) {
      expect(
        workspaceToolsRelativePathSchema.safeParse(invalidPath).success,
      ).toBe(false);
    }
    expect(workspaceToolsRelativePathSchema.parse("src/a.ts")).toBe("src/a.ts");
  });

  it("requires operation identities only for atomic mutations", () => {
    expect(
      workspaceToolsFileWriteOperation.requestSchema.safeParse({
        workspaceHandle,
        operationId,
        path: "src/a.ts",
        content: "export {};",
      }).success,
    ).toBe(true);
    expect(
      workspaceToolsFileEditOperation.requestSchema.safeParse({
        workspaceHandle,
        operationId,
        path: "src/a.ts",
        edits: [{ oldText: "a", newText: "b" }],
      }).success,
    ).toBe(true);
    expect(
      workspaceToolsFileWriteOperation.requestSchema.safeParse({
        workspaceHandle,
        path: "src/a.ts",
        content: "export {};",
      }).success,
    ).toBe(false);
    expect(
      workspaceToolsFileReadOperation.requestSchema.safeParse({
        workspaceHandle,
        operationId,
        path: "src/a.ts",
      }).success,
    ).toBe(false);
  });
});

describe("workspace context sidecar protocol", () => {
  it("uses policy-root-relative provenance and enforces aggregate bounds", () => {
    const file = {
      policyRelativePath: "team/AGENTS.md",
      content: "context",
      sizeBytes: 7,
      sha256: "a".repeat(64),
    };
    expect(
      workspaceContextReadOperation.responseSchema.safeParse({
        files: [file],
        fingerprint: "b".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      workspaceContextReadOperation.responseSchema.safeParse({
        files: [{ ...file, path: file.policyRelativePath }],
        fingerprint: "b".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      workspaceContextReadOperation.responseSchema.safeParse({
        files: Array.from({ length: 5 }, (_, index) => ({
          ...file,
          policyRelativePath: `team-${index}/AGENTS.md`,
          content: "x",
          sizeBytes: WORKSPACE_CONTEXT_V1_LIMITS.maximumFileBytes,
        })),
        fingerprint: "b".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("registers the one closed data-only operation", () => {
    const registry = new SidecarOperationRegistry();
    registerWorkspaceContextV1Operations(registry, {
      readContext: vi.fn() as never,
    });
    expect(workspaceContextV1Operations).toEqual([
      workspaceContextReadOperation,
    ]);
    expect(registry.capabilities()).toEqual([
      {
        capabilityId: "workspace_context",
        majorVersion: 1,
        operations: ["context.read"],
      },
    ]);
  });
});

describe("sidecar hello capability evidence", () => {
  const toolsEvidence = {
    capabilityId: "workspace_tools" as const,
    majorVersion: 2 as const,
    limits: WORKSPACE_TOOLS_V2_LIMITS,
    ...WORKSPACE_TOOLS_SHELL_V2_LIMITS,
  };
  const contextEvidence = {
    capabilityId: "workspace_context" as const,
    majorVersion: 1 as const,
    limits: WORKSPACE_CONTEXT_V1_LIMITS,
  };

  it("accepts the static tools/context capability evidence pair", () => {
    expect(() =>
      registerControlV2Operations(registeredCapabilityRegistry(), {
        buildId: "build",
        artifactSha256: "a".repeat(64),
        enabledSidecarCapabilities: [
          { capabilityId: "workspace_tools", majorVersion: 2 },
          { capabilityId: "workspace_context", majorVersion: 1 },
        ],
        enabledSedesCapabilities: [],
        runtime: { os: "linux", architecture: "x64" },
        capabilityEvidence: [toolsEvidence, contextEvidence],
      }),
    ).not.toThrow();
  });

  it("advertises tools/context without probing search executables", async () => {
    const registry = registeredCapabilityRegistry();
    registerControlV2Operations(registry, {
      buildId: "build",
      artifactSha256: "a".repeat(64),
      enabledSidecarCapabilities: [
        { capabilityId: "workspace_tools", majorVersion: 2 },
        { capabilityId: "workspace_context", majorVersion: 1 },
      ],
      enabledSedesCapabilities: [],
      runtime: { os: "linux", architecture: "x64" },
      capabilityEvidence: [toolsEvidence, contextEvidence],
    });

    const filesOnly = await invokeHello(registry, []);
    expect(filesOnly.capabilityEvidence).toEqual([]);

    const tools = await invokeHello(registry, [
      { capabilityId: "workspace_tools", majorVersion: 2 },
      { capabilityId: "workspace_context", majorVersion: 1 },
    ]);
    expect(tools.capabilityEvidence).toEqual([contextEvidence, toolsEvidence]);
  });

  it("fails the atomic tools/context demand when static evidence is absent", async () => {
    const registry = registeredCapabilityRegistry();
    registerControlV2Operations(registry, {
      buildId: "build",
      artifactSha256: "a".repeat(64),
      enabledSidecarCapabilities: [
        { capabilityId: "workspace_tools", majorVersion: 2 },
        { capabilityId: "workspace_context", majorVersion: 1 },
      ],
      enabledSedesCapabilities: [],
    });
    await expect(
      invokeHello(registry, [
        { capabilityId: "workspace_tools", majorVersion: 2 },
        { capabilityId: "workspace_context", majorVersion: 1 },
      ]),
    ).rejects.toMatchObject({
      code: "sidecar_capability_mismatch",
    });
  });

  it("rejects obsolete executable evidence, inexact limits, and runtime evidence", () => {
    const response = {
      wireVersion: SIDECAR_WIRE_VERSION,
      buildId: "build",
      artifactSha256: "a".repeat(64),
      runtime: { os: "linux", architecture: "x64" },
      sidecarCapabilities: [],
      capabilityEvidence: [toolsEvidence, contextEvidence],
      sedesCapabilities: [],
    };
    expect(
      controlHelloOperation.responseSchema.safeParse(response).success,
    ).toBe(true);
    for (const os of ["darwin", "win32"]) {
      expect(controlHelloOperation.responseSchema.safeParse({...response, runtime: {os, architecture: "x64"}}).success).toBe(true);
    }
    expect(
      controlHelloOperation.responseSchema.safeParse({
        ...response,
        capabilityEvidence: [
          {
            ...toolsEvidence,
            searchExecutables: {
              ripgrep: {
                command: "rg",
                canonicalPath: "/usr/bin/rg",
                version: "15.1.0",
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      controlHelloOperation.responseSchema.safeParse({
        ...response,
        runtime: { os: "unsupported", architecture: "x64" },
      }).success,
    ).toBe(false);
  });

  it("validates exact authorized evidence without duplicates or extras", () => {
    const authorized = [
      { capabilityId: "workspace_tools", majorVersion: 2 },
      { capabilityId: "workspace_context", majorVersion: 1 },
    ];
    const hello = {
      runtime: { os: "linux" as const, architecture: "x64" as const },
      sidecarCapabilities: authorized.map((capability) => ({
        ...capability,
        operations: ["operation"],
      })),
      capabilityEvidence: [toolsEvidence, contextEvidence],
    };
    expect(() =>
      validateSidecarHelloCapabilityEvidence(hello, authorized),
    ).not.toThrow();
    expect(() =>
      validateSidecarHelloCapabilityEvidence(
        { ...hello, capabilityEvidence: [toolsEvidence, toolsEvidence] },
        authorized,
      ),
    ).toThrow("sidecar_capability_mismatch");
    expect(() =>
      validateSidecarHelloCapabilityEvidence(
        { ...hello, capabilityEvidence: [contextEvidence] },
        authorized,
      ),
    ).toThrow("sidecar_capability_mismatch");
  });
});

function registeredCapabilityRegistry(): SidecarOperationRegistry {
  const registry = new SidecarOperationRegistry();
  const handler = vi.fn() as never;
  registerWorkspaceToolsV2Operations(registry, {
    mutationList: handler,
    mutationInspect: handler,
    mutationAcknowledge: handler,
    openWorkspace: handler,
    closeWorkspace: handler,
    readFile: handler,
    writeFile: handler,
    editFile: handler,
    listDirectory: handler,
    findFiles: handler,
    grepFiles: handler,
  });
  registerWorkspaceContextV1Operations(registry, { readContext: handler });
  return registry;
}

async function invokeHello(
  registry: SidecarOperationRegistry,
  authorizedSidecarCapabilities: readonly {
    readonly capabilityId: string;
    readonly majorVersion: number;
  }[],
) {
  const registered = registry.resolve(controlHelloOperation)!;
  const value = await registered.handler(
    {
      expectedBuildId: "build",
      expectedArtifactSha256: "a".repeat(64),
      authorizedSidecarCapabilities,
      offeredSedesCapabilities: [],
    },
    { requestId: randomUUID(), signal: new AbortController().signal },
  );
  return controlHelloOperation.responseSchema.parse(value);
}
