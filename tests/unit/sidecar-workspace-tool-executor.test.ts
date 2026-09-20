import { describe, expect, it, vi } from "vitest";
import {
  SidecarProtocolDeliveryError,
  SidecarOperationError,
  workspaceToolsFileWriteOperation,
  workspaceToolsFileReadOperation,
  workspaceToolsFileEditOperation,
  workspaceToolsDirectoryListOperation,
  workspaceToolsSearchFindOperation,
  workspaceToolsSearchGrepOperation,
  workspaceToolsMutationInspectOperation,
  workspaceToolsWorkspaceOpenOperation,
} from "../../src/internal/sidecar-protocol/index.js";
import type { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import type { SidecarRuntimeOwner } from "../../src/server/sidecar/sidecar-runtime.js";
import {
  WorkspaceToolError,
  WorkspaceToolOutcomeUnknownError,
} from "../../src/server/workspace-tools/contracts.js";
import { SidecarWorkspaceToolExecutor } from "../../src/server/workspace-tools/sidecar-workspace-tool-executor.js";
import { createPiRemoteWorkspaceToolDefinitions } from "../../src/server/backends/pi/pi-remote-workspace.js";

const pathOperations = [
  {
    name: "read",
    definition: workspaceToolsFileReadOperation,
    invoke: (executor: SidecarWorkspaceToolExecutor, path: string) =>
      executor.read({ path }),
  },
  {
    name: "write",
    definition: workspaceToolsFileWriteOperation,
    invoke: (executor: SidecarWorkspaceToolExecutor, path: string) =>
      executor.write({ path, content: "text" }),
  },
  {
    name: "edit",
    definition: workspaceToolsFileEditOperation,
    invoke: (executor: SidecarWorkspaceToolExecutor, path: string) =>
      executor.edit({ path, edits: [{ oldText: "old", newText: "new" }] }),
  },
  {
    name: "ls",
    definition: workspaceToolsDirectoryListOperation,
    invoke: (executor: SidecarWorkspaceToolExecutor, path: string) =>
      executor.list({ path }),
  },
  {
    name: "find",
    definition: workspaceToolsSearchFindOperation,
    invoke: (executor: SidecarWorkspaceToolExecutor, path: string) =>
      executor.find({ path, pattern: "*.ts" }),
  },
  {
    name: "grep",
    definition: workspaceToolsSearchGrepOperation,
    invoke: (executor: SidecarWorkspaceToolExecutor, path: string) =>
      executor.grep({ path, pattern: "text" }),
  },
];

describe("SidecarWorkspaceToolExecutor remote path encoding", () => {
  it.each([
    {
      name: "ls",
      input: { path: "." },
      definition: workspaceToolsDirectoryListOperation,
      response: { entries: [], limitReached: false },
      encoded: undefined,
    },
    {
      name: "read",
      input: { path: "/srv/workspace/README.md" },
      definition: workspaceToolsFileReadOperation,
      response: {
        path: "README.md", contentKind: "text", content: "remote", sizeBytes: 6,
        startLine: 1, outputLines: 1, totalLines: 1,
      },
      encoded: "README.md",
    },
  ])("executes the Pi $name definition through the actual wire path schema", async ({ name, input, definition, response, encoded }) => {
    const call = vi.fn(async (operation, request) => {
      operation.requestSchema.parse(request);
      if (operation === workspaceToolsWorkspaceOpenOperation)
        return { workspaceHandle: "3d931b18-4928-42a9-ab6b-2fbdc0ead849" };
      expect(operation).toBe(definition);
      return definition.responseSchema.parse(response);
    });
    const tools = createPiRemoteWorkspaceToolDefinitions({
      executor: createExecutor(call, vi.fn()),
      semanticCwd: "/srv/workspace",
      serviceCwd: "/local/pi/services",
      contextReader: { read: async () => ({ files: [], fingerprint: "empty" }) },
      environmentLabel: "SSH",
    });
    const tool = tools.find((candidate) => candidate.name === name)!;
    const result = await tool.execute(
      "call", input as never, undefined, undefined, {} as never,
    );
    expect(result.content[0]).toEqual({
      type: "text", text: name === "ls" ? "(empty directory)" : "remote",
    });
    expect(call).toHaveBeenCalledWith(
      definition, expect.objectContaining({ path: encoded }),
    );
  });

  for (const operation of pathOperations) {
    it.each([
      ["/srv/workspace/sub/file", "sub/file"],
      ["./sub/file", "sub/file"],
      ["sub/../file", "file"],
      ["@/srv/workspace/file", "file"],
      ["file:///srv/workspace/a%20file", "a file"],
      ["~/file", "file"],
      ["/srv/workspace/@file", "@file"],
      ["/srv/workspace/~/file", "~/file"],
    ])(`encodes ${operation.name} path %s at the protocol boundary`, async (input, encoded) => {
      const call = vi.fn(async (definition, request) => {
        definition.requestSchema.parse(request);
        if (definition === workspaceToolsWorkspaceOpenOperation)
          return { workspaceHandle: "3d931b18-4928-42a9-ab6b-2fbdc0ead849" };
        return {};
      });
      await operation.invoke(createExecutor(call, vi.fn()), input);
      expect(call).toHaveBeenCalledWith(
        operation.definition,
        expect.objectContaining({
          path: encoded, workspaceHandle: expect.any(String),
        }),
      );
    });

    it.each(["/srv/workspace-other/file", "../outside", "/etc/passwd"])(
      `rejects ${operation.name} outside workspace path %s before admission`,
      async (input) => {
        const call = vi.fn();
        await expect(operation.invoke(createExecutor(call, vi.fn()), input))
          .rejects.toMatchObject({
            code: "workspace_tools_path_outside_workspace",
          });
        expect(call).not.toHaveBeenCalled();
      },
    );
  }

  for (const operation of pathOperations.slice(3)) {
    it.each([".", "./", "/srv/workspace", "sub/.."])(
      `encodes ${operation.name} workspace root %s with an omitted wire path`,
      async (input) => {
        const call = vi.fn(async (definition, request) => {
          definition.requestSchema.parse(request);
          if (definition === workspaceToolsWorkspaceOpenOperation)
            return { workspaceHandle: "3d931b18-4928-42a9-ab6b-2fbdc0ead849" };
          return {};
        });
        await operation.invoke(createExecutor(call, vi.fn()), input);
        expect(call).toHaveBeenCalledWith(
          operation.definition, expect.objectContaining({ path: undefined }),
        );
      },
    );
  }

  it.each(["bad\u0000file", "bad\\file", "file:///srv/workspace/bad%00file"])(
    "rejects invalid path %s before admission",
    async (input) => {
      const call = vi.fn();
      await expect(createExecutor(call, vi.fn()).read({ path: input }))
        .rejects.toMatchObject({ code: "workspace_tools_path_invalid" });
      expect(call).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      accountHome: "/remote-account",
      code: "workspace_tools_path_outside_workspace",
    },
    { accountHome: undefined, code: "workspace_tools_unavailable" },
  ])("releases admission and never delivers a mutation with unusable remote home $accountHome", async ({ accountHome, code }) => {
    const call = vi.fn(async (operation) => {
      expect(operation).toBe(workspaceToolsWorkspaceOpenOperation);
      return { workspaceHandle: "3d931b18-4928-42a9-ab6b-2fbdc0ead849" };
    });
    const release = vi.fn();
    const executor = createExecutor(call, release, { accountHome });
    await expect(executor.write({ path: "~/note", content: "changed" }))
      .rejects.toMatchObject({ code });
    expect(call).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("SidecarWorkspaceToolExecutor mutation delivery", () => {
  it("keeps a handler timeout uncertain when inspection still shows admitted work and never acknowledges it", async () => {
    const call = vi.fn(async (definition: unknown) => {
      if (definition === workspaceToolsWorkspaceOpenOperation)
        return { workspaceHandle: "3d931b18-4928-42a9-ab6b-2fbdc0ead849" };
      if (definition === workspaceToolsMutationInspectOperation)
        return { state: "pending" };
      expect(definition).toBe(workspaceToolsFileWriteOperation);
      throw new SidecarOperationError("sidecar_request_timeout");
    });
    const executor = createExecutor(call, vi.fn());
    await expect(
      executor.write({ path: "note", content: "changed" }),
    ).rejects.toBeInstanceOf(WorkspaceToolOutcomeUnknownError);
    expect(
      call.mock.calls.filter(
        ([definition]) => definition === workspaceToolsFileWriteOperation,
      ),
    ).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(3);
  });
  it("maps uncertain workspace admission to unavailable, not mutation outcome unknown", async () => {
    const call = vi.fn(async (definition: unknown) => {
      expect(definition).toBe(workspaceToolsWorkspaceOpenOperation);
      throw uncertainDelivery();
    });
    const release = vi.fn();
    const executor = createExecutor(call, release);

    const failure = await executor
      .write({ path: "note.txt", content: "changed" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkspaceToolError);
    expect(failure).not.toBeInstanceOf(WorkspaceToolOutcomeUnknownError);
    expect(failure).toMatchObject({ code: "workspace_tools_unavailable" });
    expect(call).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports outcome unknown only when the actual mutation delivery is uncertain", async () => {
    const call = vi.fn(async (definition: unknown) => {
      if (definition === workspaceToolsWorkspaceOpenOperation) {
        return { workspaceHandle: "3d931b18-4928-42a9-ab6b-2fbdc0ead849" };
      }
      if (definition === workspaceToolsMutationInspectOperation)
        return { state: "unknown" };
      expect(definition).toBe(workspaceToolsFileWriteOperation);
      throw uncertainDelivery();
    });
    const release = vi.fn();
    const executor = createExecutor(call, release);

    await expect(
      executor.write({ path: "note.txt", content: "changed" }),
    ).rejects.toBeInstanceOf(WorkspaceToolOutcomeUnknownError);
    expect(call).toHaveBeenCalledTimes(3);
    expect(
      call.mock.calls.filter(
        ([definition]) => definition === workspaceToolsFileWriteOperation,
      ),
    ).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(2);
  });
});

function createExecutor(
  call: ReturnType<typeof vi.fn>,
  release: ReturnType<typeof vi.fn>,
  options: { accountHome?: string } = { accountHome: "/srv/workspace" },
): SidecarWorkspaceToolExecutor {
  const session = { call, accountHome: options.accountHome } as unknown as SidecarClientSession;
  let admitted = false;
  const runtime = {
    acquireAutomaticRecovery: async () => ({ session, release }),
    acquireOperation: async () => {
      if (admitted) throw new Error("recovery_must_not_admit_work");
      admitted = true;
      return { session, carrierGeneration: 1, release };
    },
  } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
  return new SidecarWorkspaceToolExecutor({
    runtime,
    scope: { tenantId: "tenant", principalId: "principal" },
    environmentId: "environment",
    declaredPath: "/srv/workspace",
    policyRootPath: "/srv",
  });
}

function uncertainDelivery(): SidecarProtocolDeliveryError {
  return new SidecarProtocolDeliveryError(
    "sidecar_transport_closed",
    "sent_outcome_unknown",
  );
}
