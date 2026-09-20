import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPiToolApprovalExtension,
  formatApprovalDetail,
  resolveExecutableToolName,
  stableJson,
  type PiToolApprovalRequester,
  type PiAgentToolApprovalResolver,
  type PiAgentToolApprovalRecorder,
} from "../../src/server/backends/pi/pi-tool-approval-extension.js";
import {
  PI_TOOL_APPROVAL_TITLE,
  PiToolAccessController,
} from "../../src/server/backends/pi/pi-tool-access.js";

type ToolCallHandler = (
  event: {
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  },
  ctx: {
    sessionManager: {
      getBranch: () => readonly unknown[];
    };
    ui: object;
  },
) => Promise<{ block: true; reason?: string } | undefined>;

function loadHandler(
  toolAccess: PiToolAccessController,
  workspacePath = "/workspace",
  requestApproval: PiToolApprovalRequester = vi.fn(),
  protectedAgentToolNames?: ReadonlySet<string>,
  resolveAgentToolApproval?: PiAgentToolApprovalResolver,
  recordAgentToolApproval?: PiAgentToolApprovalRecorder,
): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const extension = createPiToolApprovalExtension({
    toolAccess,
    workspacePath,
    requestApproval,
    protectedAgentToolNames,
    resolveAgentToolApproval,
    recordAgentToolApproval,
  });
  if (typeof extension === "function" || !("factory" in extension)) {
    throw new Error("expected named inline extension");
  }
  const api = {
    on(event: string, registered: ToolCallHandler) {
      if (event === "tool_call") handler = registered;
    },
  } as unknown as ExtensionAPI;
  extension.factory(api);
  if (!handler) throw new Error("tool_call handler was not registered");
  return handler;
}

function sessionWithToolCall(
  toolCallId: string,
  name: string,
): {
  getBranch: () => readonly unknown[];
} {
  return {
    getBranch: () => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: toolCallId, name }],
        },
      },
    ],
  };
}

describe("Pi tool approval extension", () => {
  it("discloses the remote OpenSSH account and unsandboxed Bash boundary", () => {
    expect(
      formatApprovalDetail(
        "bash",
        { command: "make test" },
        "/srv/project",
        "Build host",
      ),
    ).toContain(
      "environment: Build host (remote account resolved by OpenSSH configuration)",
    );
    expect(
      formatApprovalDetail(
        "bash",
        { command: "make test" },
        "/srv/project",
        "Build host",
      ),
    ).toContain(
      "This command is not filesystem-, process-, or network-sandboxed.",
    );
  });

  it("does not prompt outside ask mode", async () => {
    const requestApproval = vi.fn();
    const handler = loadHandler(
      new PiToolAccessController("full"),
      "/workspace",
      requestApproval,
    );
    await expect(
      handler(
        {
          toolName: "bash",
          toolCallId: "call-1",
          input: { command: "rm -rf /" },
        },
        {
          sessionManager: sessionWithToolCall("call-1", "bash"),
          ui: {},
        },
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("does not prompt for read-only tools in ask mode", async () => {
    const requestApproval = vi.fn();
    const handler = loadHandler(
      new PiToolAccessController("ask"),
      "/workspace",
      requestApproval,
    );
    await expect(
      handler(
        {
          toolName: "read",
          toolCallId: "call-2",
          input: { path: "README.md" },
        },
        {
          sessionManager: sessionWithToolCall("call-2", "read"),
          ui: {},
        },
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("prompts with fixed title and detail for bash/write/edit", async () => {
    const toolAccess = new PiToolAccessController("ask");
    const requestApproval = vi
      .fn()
      .mockResolvedValueOnce("approve_once")
      .mockResolvedValueOnce("deny")
      .mockResolvedValueOnce(undefined);
    const handler = loadHandler(toolAccess, "/tmp/project", requestApproval);

    await expect(
      handler(
        {
          toolName: "bash",
          toolCallId: "bash-1",
          input: { command: "npm test" },
        },
        {
          sessionManager: sessionWithToolCall("bash-1", "bash"),
          ui: {},
        },
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        title: PI_TOOL_APPROVAL_TITLE,
        detail: expect.stringContaining("npm test"),
      }),
    );
    expect(requestApproval.mock.calls[0]![0].detail).toContain("/tmp/project");

    await expect(
      handler(
        {
          toolName: "write",
          toolCallId: "write-1",
          input: { path: "out.txt", content: "hello" },
        },
        {
          sessionManager: sessionWithToolCall("write-1", "write"),
          ui: {},
        },
      ),
    ).resolves.toEqual({
      block: true,
      reason: "Tool call denied by user.",
    });

    await expect(
      handler(
        {
          toolName: "edit",
          toolCallId: "edit-1",
          input: {
            path: "src/a.ts",
            edits: [{ oldText: "const a = 1", newText: "const a = 2" }],
          },
        },
        {
          sessionManager: sessionWithToolCall("edit-1", "edit"),
          ui: {},
        },
      ),
    ).resolves.toEqual({
      block: true,
      reason: "Tool call denied: approval was cancelled.",
    });
  });

  it("gates only exact trusted non-read-only Sedes tool names", async () => {
    const requestApproval = vi.fn().mockResolvedValueOnce("approve_once");
    const handler = loadHandler(
      new PiToolAccessController("ask"),
      "/workspace",
      requestApproval,
      new Set(["sedes_task_create"]),
    );
    await expect(
      handler(
        {
          toolName: "ignored-event-name",
          toolCallId: "task-create-1",
          input: { title: "Follow up" },
        },
        {
          sessionManager: sessionWithToolCall(
            "task-create-1",
            "sedes_task_create",
          ),
          ui: {},
        },
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledWith({
      title: PI_TOOL_APPROVAL_TITLE,
      detail: "sedes_task_create: approval required",
    });

    await expect(
      handler(
        {
          toolName: "sedes_task_create_similar",
          toolCallId: "similar-1",
          input: { title: "No prompt" },
        },
        {
          sessionManager: sessionWithToolCall(
            "similar-1",
            "sedes_task_create_similar",
          ),
          ui: {},
        },
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it("uses one resolver for progressive action rendering and post-approval recheck", async () => {
    const requestApproval = vi.fn().mockResolvedValue("approve_once");
    let fingerprint = "first";
    const resolveApproval = vi.fn(() => ({
      fingerprint,
      title: "Approve Update task",
      detail: 'task.update@1\ninput: {"completed":true}',
    }));
    const recordApproval = vi.fn();
    const handler = loadHandler(
      new PiToolAccessController("ask"),
      "/workspace",
      requestApproval,
      new Set(["sedes_act"]),
      resolveApproval,
      recordApproval,
    );
    await expect(
      handler(
        {
          toolName: "sedes_act",
          toolCallId: "act-1",
          input: { toolId: "task.update", schemaVersion: 1, input: {} },
        },
        {
          sessionManager: sessionWithToolCall("act-1", "sedes_act"),
          ui: {},
        },
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledWith({
      title: "Approve Update task",
      detail: 'task.update@1\ninput: {"completed":true}',
    });
    expect(resolveApproval).toHaveBeenCalledTimes(2);
    expect(recordApproval).toHaveBeenCalledWith({
      toolCallId: "act-1",
      toolName: "sedes_act",
      fingerprint: "first",
    });

    const changedRequest = vi.fn(async () => {
      fingerprint = "changed";
      return "approve_once" as const;
    });
    const changedHandler = loadHandler(
      new PiToolAccessController("ask"),
      "/workspace",
      changedRequest,
      new Set(["sedes_act"]),
      resolveApproval,
      recordApproval,
    );
    fingerprint = "before";
    await expect(
      changedHandler(
        {
          toolName: "sedes_act",
          toolCallId: "act-2",
          input: { toolId: "task.update", schemaVersion: 1, input: {} },
        },
        {
          sessionManager: sessionWithToolCall("act-2", "sedes_act"),
          ui: {},
        },
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("changed after the approval prompt"),
    });
  });

  it("uses assistant toolCall identity when event.toolName was renamed", async () => {
    const toolAccess = new PiToolAccessController("ask");
    const requestApproval = vi.fn().mockResolvedValue("approve_once");
    const handler = loadHandler(toolAccess, "/workspace", requestApproval);
    await expect(
      handler(
        {
          toolName: "read",
          toolCallId: "spoofed-bash",
          input: { command: "rm -rf /tmp/x" },
        },
        {
          sessionManager: sessionWithToolCall("spoofed-bash", "bash"),
          ui: {},
        },
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledOnce();
  });

  it("does not gate a custom tool with bash-shaped arguments", async () => {
    const requestApproval = vi.fn();
    const handler = loadHandler(
      new PiToolAccessController("ask"),
      "/workspace",
      requestApproval,
    );
    await expect(
      handler(
        {
          toolName: "deploy",
          toolCallId: "deploy-1",
          input: { command: "npm run deploy" },
        },
        {
          sessionManager: sessionWithToolCall("deploy-1", "deploy"),
          ui: {},
        },
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    {
      condition: "session history cannot be read",
      sessionManager: {
        getBranch: () => {
          throw new Error("history unavailable");
        },
      },
    },
    {
      condition: "the current assistant message has no matching call ID",
      sessionManager: sessionWithToolCall("different-call", "bash"),
    },
    {
      condition: "the current assistant message has an ambiguous call ID",
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "bash-unverified", name: "bash" },
                { type: "toolCall", id: "bash-unverified", name: "read" },
              ],
            },
          },
        ],
      },
    },
  ])("fails closed when $condition", async ({ sessionManager }) => {
    const requestApproval = vi.fn();
    const handler = loadHandler(
      new PiToolAccessController("ask"),
      "/workspace",
      requestApproval,
    );

    await expect(
      handler(
        {
          toolName: "bash",
          toolCallId: "bash-unverified",
          input: { command: "touch outside-workspace" },
        },
        { sessionManager, ui: {} },
      ),
    ).resolves.toEqual({
      block: true,
      reason:
        "Tool call denied: executable tool identity could not be verified.",
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("denies when arguments change after the prompt", async () => {
    const toolAccess = new PiToolAccessController("ask");
    const event = {
      toolName: "bash",
      toolCallId: "bash-3",
      input: { command: "echo one" },
    };
    const requestApproval = vi.fn().mockImplementation(async () => {
      event.input.command = "echo two";
      return "approve_once";
    });
    const handler = loadHandler(toolAccess, "/workspace", requestApproval);

    await expect(
      handler(event, {
        sessionManager: sessionWithToolCall("bash-3", "bash"),
        ui: {},
      }),
    ).resolves.toEqual({
      block: true,
      reason:
        "Tool call denied: call identity or arguments changed after the approval prompt.",
    });
  });

  it("formats real Pi edit schema hunks in the approval detail", () => {
    const detail = formatApprovalDetail(
      "edit",
      {
        path: "src/a.ts",
        edits: [
          { oldText: "const a = 1", newText: "const a = 2" },
          { oldText: "const b = 1", newText: "const b = 2" },
        ],
      },
      "/workspace",
    );
    expect(detail).toContain("edit: src/a.ts");
    expect(detail).toContain("hunks: 2");
    expect(detail).toContain("const a = 1");
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
    expect(
      resolveExecutableToolName(
        { toolCallId: "t1" },
        {
          sessionManager: sessionWithToolCall("t1", "bash") as never,
        },
      ),
    ).toBe("bash");
  });
});
