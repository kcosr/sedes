import { describe, expect, it, vi } from "vitest";
import type { SidecarOperationDefinition } from "../../src/internal/sidecar-protocol/index.js";
import { PiSandboxWorkspaceToolExecutor } from "../../src/server/pi-sandbox/pi-sandbox-workspace-executor.js";
import type { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";

describe("Pi sandbox shell recovery boundary", () => {
  it("reports a lost ephemeral worker without waiting for or starting another worker", async () => {
    let disconnect!: () => void;
    const closed = new Promise<void>((resolve) => { disconnect = resolve; });
    const release = vi.fn();
    const unregister = vi.fn();
    const call = vi.fn(async (operation: SidecarOperationDefinition<unknown, unknown>, request: unknown) => {
      if (operation.operation === "workspace.open") {
        return { workspaceHandle: "sandbox-workspace-handle-0000000001" };
      }
      if (operation.operation === "shell.start") {
        return { streamId: (request as { streamId: string }).streamId, admitted: true };
      }
      throw new Error("Unexpected operation against a lost sandbox worker.");
    });
    const session = {
      closed,
      call,
      registerIncomingShellStream: () => ({ addCredit: async () => undefined, unregister }),
    } as unknown as SidecarClientSession;
    const acquireOperation = vi.fn(async () => ({ session, carrierGeneration: 1, release }));
    const executor = new PiSandboxWorkspaceToolExecutor({ acquireOperation });
    const shell = await executor.startShell({
      command: "sleep 60",
      timeoutMilliseconds: 60_000,
      initialCreditBytes: 1024,
      onData: () => undefined,
    });
    const result = expect(shell.terminal).rejects.toMatchObject({
      diagnosticCode: "workspace_tools_shell_outcome_unknown",
    });
    disconnect();
    await result;
    expect(acquireOperation).toHaveBeenCalledTimes(1);
    expect(call.mock.calls.map(([operation]) => operation.operation)).toEqual(["workspace.open", "shell.start"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalled();
  });
});
