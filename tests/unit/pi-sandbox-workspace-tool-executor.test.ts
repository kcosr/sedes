import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { workspaceToolsWorkspaceOpenOperation } from "../../src/internal/sidecar-protocol/index.js";
import { PI_SANDBOX_HOME } from "../../src/server/pi-sandbox/contracts.js";
import { PiSandboxWorkspaceToolExecutor } from "../../src/server/pi-sandbox/pi-sandbox-workspace-executor.js";
import type { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";

describe("Pi sandbox workspace tool paths", () => {
  it.each([
    {
      operation: "read",
      path: `${PI_SANDBOX_HOME}/workspace/@note`,
      expected: "workspace/@note",
    },
    { operation: "read", path: "~/workspace/note", expected: "workspace/note" },
    {
      operation: "write",
      path: `${PI_SANDBOX_HOME}/workspace/note`,
      expected: "workspace/note",
    },
    { operation: "edit", path: "./workspace/note", expected: "workspace/note" },
    { operation: "list", path: ".", expected: undefined },
    { operation: "find", path: PI_SANDBOX_HOME, expected: undefined },
    { operation: "grep", path: "~", expected: undefined },
  ])(
    "translates $operation path $path for the worker protocol",
    async ({ operation, path, expected }) => {
      const { executor, call, release } = fixture();
      if (operation === "read") await executor.read({ path });
      else if (operation === "write")
        await executor.write({ path, content: "updated" });
      else if (operation === "edit")
        await executor.edit({
          path,
          edits: [{ oldText: "old", newText: "new" }],
        });
      else if (operation === "list") await executor.list({ path });
      else if (operation === "find")
        await executor.find({ path, pattern: "*.ts" });
      else await executor.grep({ path, pattern: "needle" });
      expect(call).toHaveBeenCalledTimes(2);
      expect(call.mock.calls[0]![1]).toMatchObject({
        declaredPath: PI_SANDBOX_HOME,
      });
      expect(call.mock.calls[1]![1].path).toBe(expected);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("rejects host paths without admitting a worker operation", async () => {
    const { executor, call, acquireOperation } = fixture();
    await expect(
      executor.read({ path: "/home/operator/projects/example/README.md" }),
    ).rejects.toMatchObject({ code: "workspace_tools_path_outside_workspace" });
    expect(acquireOperation).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
});

function fixture() {
  const call = vi.fn(
    async (
      definition: { requestSchema: { parse(input: unknown): unknown } },
      request: Record<string, unknown>,
    ) => {
      definition.requestSchema.parse(request);
      return definition === workspaceToolsWorkspaceOpenOperation
        ? { workspaceHandle: randomUUID() }
        : {};
    },
  );
  const release = vi.fn();
  const acquireOperation = vi.fn(async () => ({
    session: { call } as unknown as SidecarClientSession,
    carrierGeneration: 1,
    release,
  }));
  return {
    executor: new PiSandboxWorkspaceToolExecutor({ acquireOperation }),
    call,
    release,
    acquireOperation,
  };
}
