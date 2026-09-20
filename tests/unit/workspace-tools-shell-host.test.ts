import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SidecarOutboundStream } from "../../src/internal/sidecar-protocol/index.js";
import { WorkspaceToolsShellHost } from "../../src/server/sidecar/workspace-tools-shell-host.js";

describe("workspace tools shell host", () => {
  it("applies per-shell variables and explicit unsets without leaking to another shell", async () => {
    const fixture = shellFixture();
    try {
      const first = { ...request('printf "%s|%s" "$TASK_VALUE" "${LANG-unset}"'), environmentIdentity: randomUUID(), environmentVariables: { TASK_VALUE: "first", LANG: null } };
      const second = { ...request('printf "%s|%s" "${TASK_VALUE-unset}" "$LANG"') };
      await Promise.all([fixture.host.handlers.start(first, context()), fixture.host.handlers.start(second, context())]);
      await vi.waitFor(() => expect(fixture.host.activeProcessCount()).toBe(0));
      const a = await fixture.host.handlers.inspect({ streamId: first.streamId }, context());
      const b = await fixture.host.handlers.inspect({ streamId: second.streamId }, context());
      expect(Buffer.from(a.stdoutBase64, "base64").toString()).toBe("first|unset");
      expect(Buffer.from(b.stdoutBase64, "base64").toString()).toBe("unset|C");
      expect(JSON.stringify(fixture.host.abandonmentEvidence())).not.toContain("TASK_VALUE");
      expect(fixture.admissionPayloads[0]).toMatchObject({ environmentIdentity: first.environmentIdentity, environmentNames: ["LANG", "TASK_VALUE"] });
      expect(fixture.admissionPayloads[0]).not.toHaveProperty("environmentVariables");
      expect(JSON.stringify(fixture.admissionPayloads)).not.toContain('"first"');
      // A repeated identity recovers its original operation without hashing rotated values.
      await fixture.host.handlers.start({ ...first, environmentVariables: { TASK_VALUE: "rotated-secret", LANG: null } }, context());
      await expect(fixture.host.handlers.start({ ...first, environmentIdentity: randomUUID() }, context())).rejects.toThrow("operation_id_reused");
    } finally { await fixture.host.close(); }
  });

  it("forced stop terminates admitted commands and preserves outcome identity without awaiting acknowledgement", async () => {
    const fixture = shellFixture();
    const shell = request("sleep 30");
    await fixture.host.handlers.start(shell, context());
    await fixture.host.stop(true);
    expect(fixture.host.activeProcessCount()).toBe(0);
    expect(fixture.host.abandonmentEvidence()).toMatchObject({ operations: [expect.objectContaining({ operationId: shell.operationId, streamId: shell.streamId,
      terminal: expect.objectContaining({ outcome: "cancelled" }) })] });
    expect(JSON.stringify(fixture.host.abandonmentEvidence())).not.toContain("sleep 30");
  });
  it("keeps the command alive and retains a bounded result after carrier loss without output credit", async () => {
    const fixture = shellFixture({ blockOutput: true });
    const controller = new AbortController();
    const shell = request(
      "printf before; sleep 0.05; printf after; head -c 100000 /dev/zero",
      1,
    );
    await fixture.host.handlers.start(shell, context(controller));
    await vi.waitFor(() => expect(fixture.sendStarted).toBe(true));
    fixture.host.detach();
    controller.abort(new Error("sidecar_protocol_peer_closed"));
    await vi.waitFor(() => expect(fixture.host.activeProcessCount()).toBe(0), {
      timeout: 2000,
    });
    const result = await fixture.host.handlers.inspect(
      { streamId: shell.streamId },
      context(),
    );
    expect(result).toMatchObject({
      state: "completed",
      terminal: { outcome: "exited", exitCode: 0, truncated: true },
    });
    expect(
      Buffer.from(result.stdoutBase64, "base64").subarray(0, 11).toString(),
    ).toBe("beforeafter");
    expect(Buffer.from(result.stdoutBase64, "base64").byteLength).toBe(65536);
    expect(result.previewOmittedBytes).toBe(100011 - 65536);
    expect(fixture.terminals).toHaveLength(0);
    expect(fixture.host.snapshot().blockers).toContain("unsettled_outcome");
    const revision = fixture.host.snapshot().revision;
    await expect(
      fixture.host.handlers.acknowledge(
        { streamId: shell.streamId },
        context(),
      ),
    ).resolves.toEqual({ acknowledged: true });
    expect(fixture.host.snapshot()).toMatchObject({
      state: "idle",
      blockers: [],
    });
    expect(fixture.host.snapshot().revision).not.toBe(revision);
    fixture.releaseOutput();
    await fixture.host.close();
  });

  it("does not acknowledge a running command and keeps explicit cancellation working after detach", async () => {
    const fixture = shellFixture();
    const shell = request("sleep 30");
    await fixture.host.handlers.start(shell, context());
    fixture.host.detach();
    await expect(
      fixture.host.handlers.acknowledge(
        { streamId: shell.streamId },
        context(),
      ),
    ).resolves.toEqual({ acknowledged: false });
    await fixture.host.handlers.cancel({ streamId: shell.streamId }, context());
    await vi.waitFor(() => expect(fixture.host.activeProcessCount()).toBe(0));
    await expect(
      fixture.host.handlers.inspect({ streamId: shell.streamId }, context()),
    ).resolves.toMatchObject({
      state: "completed",
      terminal: { outcome: "cancelled" },
    });
    await expect(fixture.host.stop()).rejects.toThrow(
      "sidecar_resource_handoff_pending",
    );
    await fixture.host.handlers.acknowledge(
      { streamId: shell.streamId },
      context(),
    );
    await expect(fixture.host.stop()).resolves.toBeUndefined();
  });

  it("rejects a stale admission after resolving the remote cwd without launching", async () => {
    let current = true;
    const host = new WorkspaceToolsShellHost({
      resolveWorkspace: async () => {
        current = false;
        return "/tmp";
      },
      captureAdmission: () => () => {
        if (!current) throw new Error("sidecar_controller_stale");
      },
      openStream: () => {
        throw new Error("must_not_open_stream");
      },
      admitOperation: async (_workspace, _operation, _payload, operation) =>
        await operation(),
    });
    await expect(
      host.handlers.start(request("printf never"), context()),
    ).rejects.toThrow("sidecar_controller_stale");
    expect(host.activeProcessCount()).toBe(0);
  });
  it("cleans remaining process-group members before normal terminal", async () => {
    const fixture = shellFixture();
    await fixture.host.handlers.start(
      request("sleep 30 >/dev/null 2>&1 & child=$!; echo $child; exit 0"),
      context(),
    );
    await vi.waitFor(() => expect(fixture.terminals).toHaveLength(1), {
      timeout: 2_000,
    });
    const pid = Number(Buffer.concat(fixture.bytes).toString("utf8").trim());
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(fixture.terminals[0]).toMatchObject({ outcome: "exited" });
    expect(fixture.releases).toBe(1);
  });

  it("emits terminal without receive credit after cancellation", async () => {
    const fixture = shellFixture({ blockOutput: true });
    const shell = request("trap '' TERM; printf x; sleep 30", 1);
    await fixture.host.handlers.start(shell, context());
    await vi.waitFor(() => expect(fixture.sendStarted).toBe(true));
    await fixture.host.handlers.cancel({ streamId: shell.streamId }, context());
    await vi.waitFor(() => expect(fixture.terminals).toHaveLength(1), {
      timeout: 2_000,
    });
    expect(fixture.terminals[0]).toMatchObject({
      outcome: "cancelled",
      truncated: true,
    });
    expect(fixture.releases).toBe(1);
  });

  it("flushes credit-paced output before a graceful terminal", async () => {
    const fixture = shellFixture({ blockOutput: true });
    await fixture.host.handlers.start(request("printf buffered"), context());
    await vi.waitFor(() => expect(fixture.sendStarted).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.terminals).toHaveLength(0);
    fixture.releaseOutput();
    await vi.waitFor(() => expect(fixture.terminals).toHaveLength(1), {
      timeout: 2_000,
    });
    expect(Buffer.concat(fixture.bytes).toString("utf8")).toBe("buffered");
    expect(fixture.terminals[0]).toMatchObject({
      outcome: "exited",
      emittedBytes: 8,
      omittedBytes: 0,
    });
  });

  it("terminates and settles active processes on host close", async () => {
    const fixture = shellFixture();
    await fixture.host.handlers.start(request("sleep 30"), context());
    await fixture.host.close();
    expect(fixture.terminals).toHaveLength(1);
    expect(fixture.terminals[0]).toMatchObject({ outcome: "cancelled" });
    expect(fixture.host.activeProcessCount()).toBe(0);
  });

  it("deduplicates the same operation and rejects payload reuse", async () => {
    const fixture = shellFixture();
    const shell = request("printf once");
    const first = await fixture.host.handlers.start(shell, context());
    const duplicate = await fixture.host.handlers.start(shell, context());
    expect(duplicate).toEqual(first);
    expect(fixture.openedStreams).toBe(1);
    await expect(
      fixture.host.handlers.start(
        { ...shell, command: "printf different" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "workspace_tools_operation_id_reused" });
    await fixture.host.close();
  });

  it("fails shell admission when the shared operation ledger is full", async () => {
    const fixture = shellFixture({ operationCapacity: 0 });
    await expect(
      fixture.host.handlers.start(request("printf never"), context()),
    ).rejects.toMatchObject({ code: "workspace_tools_unavailable" });
    expect(fixture.openedStreams).toBe(0);
  });

  it("retains the start abort signal through terminal settlement", async () => {
    const fixture = shellFixture();
    const controller = new AbortController();
    await fixture.host.handlers.start(
      request("trap '' TERM; sleep 30"),
      context(controller),
    );
    controller.abort();
    await vi.waitFor(() => expect(fixture.terminals).toHaveLength(1), {
      timeout: 2_000,
    });
    expect(fixture.terminals[0]).toMatchObject({ outcome: "cancelled" });
    expect(fixture.releases).toBe(1);
  });

  it("cleans a process when abort races spawn admission", async () => {
    const controller = new AbortController();
    const fixture = shellFixture({ abortOnLease: controller });
    await fixture.host.handlers.start(
      request("trap '' TERM; sleep 30"),
      context(controller),
    );
    await vi.waitFor(() => expect(fixture.terminals).toHaveLength(1), {
      timeout: 2_000,
    });
    expect(fixture.terminals[0]).toMatchObject({ outcome: "cancelled" });
    expect(fixture.host.activeProcessCount()).toBe(0);
  });

  it("observes cleanup-proof rejection on every fire-and-forget path", async () => {
    const fixture = shellFixture({
      processGroupExited: async () => false,
    });
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    const shell = request("trap '' TERM; sleep 30");
    await fixture.host.handlers.start(shell, context());
    await fixture.host.handlers.cancel({ streamId: shell.streamId }, context());
    await vi.waitFor(() => expect(fixture.cleanupFailures).toHaveLength(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
    expect(fixture.terminals).toHaveLength(0);
    await expect(fixture.host.close()).rejects.toThrow(
      "workspace_tools_shell_cleanup_unproven",
    );
    process.removeListener("unhandledRejection", unhandled);
  });
});

function shellFixture(options?: {
  readonly blockOutput?: boolean;
  readonly operationCapacity?: number;
  readonly abortOnLease?: AbortController;
  readonly processGroupExited?: (
    pid: number | undefined,
    maximumMilliseconds: number,
  ) => Promise<boolean>;
}) {
  const bytes: Buffer[] = [];
  const terminals: unknown[] = [];
  const admissionPayloads: unknown[] = [];
  let releases = 0;
  let sendStarted = false;
  let openedStreams = 0;
  const cleanupFailures: Error[] = [];
  let releaseOutput!: () => void;
  const outputGate = new Promise<void>((resolve) => {
    releaseOutput = resolve;
  });
  const operations = new Map<
    string,
    { readonly fingerprint: string; readonly settlement: Promise<unknown> }
  >();
  const stream: SidecarOutboundStream = {
    streamId: "unused",
    send: async (_channel, chunk) => {
      sendStarted = true;
      if (options?.blockOutput) {
        await outputGate;
      }
      bytes.push(Buffer.from(chunk));
    },
    terminal: async (payload) => {
      terminals.push(payload);
    },
  };
  const host = new WorkspaceToolsShellHost({
    resolveWorkspace: () => "/tmp",
    openStream: () => {
      openedStreams += 1;
      return stream;
    },
    admitOperation: async (
      workspaceHandle,
      operationId,
      payload,
      operation,
    ) => {
      admissionPayloads.push(payload);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ workspaceHandle, payload }))
        .digest("hex");
      const prior = operations.get(operationId);
      if (
        prior?.fingerprint !== undefined &&
        prior.fingerprint !== fingerprint
      ) {
        throw Object.assign(new Error("workspace_tools_operation_id_reused"), {
          code: "workspace_tools_operation_id_reused",
        });
      }
      if (prior)
        return (await prior.settlement) as Awaited<
          ReturnType<typeof operation>
        >;
      if (operations.size >= (options?.operationCapacity ?? 65_536)) {
        throw Object.assign(new Error("workspace_tools_unavailable"), {
          code: "workspace_tools_unavailable",
        });
      }
      const settlement = operation();
      operations.set(operationId, { fingerprint, settlement });
      return await settlement;
    },
    retainLease: () => {
      options?.abortOnLease?.abort();
      return () => {
        releases += 1;
      };
    },
    environment: { HOME: "/tmp", PATH: "/usr/bin:/bin", LANG: "C" },
    limits: {
      terminationGraceMilliseconds: 30,
      drainMilliseconds: 30,
    },
    processGroupExited: options?.processGroupExited,
    onCleanupFailure: (error) => cleanupFailures.push(error),
  });
  return {
    host,
    bytes,
    terminals,
    admissionPayloads,
    cleanupFailures,
    get releases() {
      return releases;
    },
    get sendStarted() {
      return sendStarted;
    },
    get openedStreams() {
      return openedStreams;
    },
    releaseOutput,
  };
}

function request(command: string, initialCreditBytes = 1024) {
  return {
    workspaceHandle: randomUUID(),
    operationId: randomUUID(),
    streamId: randomUUID(),
    command,
    initialCreditBytes,
    timeoutMilliseconds: 5_000,
  };
}

function context(controller = new AbortController()) {
  return {
    requestId: randomUUID(),
    signal: controller.signal,
  };
}
