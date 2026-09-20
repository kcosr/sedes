import { randomUUID } from "node:crypto";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIDECAR_PROTOCOL_LIMITS,
  SIDECAR_WIRE_VERSION,
  SidecarFrameWriteError,
  SidecarOperationRegistry,
  SidecarProtocolPeer,
  controlHelloOperation,
  controlPingOperation,
  defineSidecarOperation,
  encodeSidecarEnvelope,
  registerControlV2Operations,
  sidecarAgentToolCliMetadataSchema,
  workspaceFilesInvalidatedEventSchema,
  workspaceFilesDiffCreateComparisonOperation,
  workspaceFilesDiffValidateReviewAnchorOperation,
  workspaceFilesV7Operations,
  workspaceFilesWriteOperation,
  type SidecarFrame,
  type SidecarFrameLane,
  type SidecarFrameTransport,
  type SidecarOperationHandler,
  type SidecarTransportClosure,
} from "../../src/internal/sidecar-protocol/index.js";
import {
  WORKSPACE_FILE_MAX_CONTENT_BYTES,
  WORKSPACE_FILE_WRITE_JSON_LIMIT_BYTES,
} from "../../src/shared/workspace-file-limits.js";

const sessionNonce = "n".repeat(48);
const buildId = "test-build";
const artifactSha256 = "a".repeat(64);
const workspaceCapability = Object.freeze({
  capabilityId: "workspace_files",
  majorVersion: 5,
});
const agentToolCapability = Object.freeze({
  capabilityId: "agent_tools_cli",
  majorVersion: 3,
});
const agentToolInventory = Object.freeze({
  ...agentToolCapability,
  operations: Object.freeze([
    "catalog.describe",
    "catalog.list",
    "tool.invoke",
  ]),
});
const sourceCapability = "test_source_capability_0000000000000001";

const workspaceEchoOperation = defineSidecarOperation({
  capabilityId: "workspace_files",
  majorVersion: 5,
  operation: "files.echo",
  lane: "operation",
  maximumDeadlineMilliseconds: 1_000,
  requestSchema: z.strictObject({ value: z.string() }),
  responseSchema: z.strictObject({ value: z.string() }),
});

const agentToolCatalogOperation = defineSidecarOperation({
  capabilityId: "agent_tools_cli",
  majorVersion: 3,
  operation: "catalog.list",
  lane: "operation",
  maximumDeadlineMilliseconds: 1_000,
  requestSchema: z.strictObject({ sourceCapability: z.string().min(32) }),
  responseSchema: z.strictObject({ tools: z.array(z.string()) }),
});
const agentToolDescribeOperation = defineSidecarOperation({
  capabilityId: "agent_tools_cli",
  majorVersion: 3,
  operation: "catalog.describe",
  lane: "operation",
  maximumDeadlineMilliseconds: 1_000,
  requestSchema: z.strictObject({}),
  responseSchema: z.strictObject({ done: z.literal(true) }),
});
const agentToolInvokeOperation = defineSidecarOperation({
  capabilityId: "agent_tools_cli",
  majorVersion: 3,
  operation: "tool.invoke",
  lane: "operation",
  maximumDeadlineMilliseconds: "caller_abort",
  requestSchema: z.strictObject({}),
  responseSchema: z.strictObject({ done: z.literal(true) }),
});

describe("sidecar private protocol", () => {
  it("exposes one closed workspace_files@7 inventory with bounded worktree discovery", () => {
    expect(
      workspaceFilesV7Operations.map((definition) => definition.majorVersion),
    ).toEqual(workspaceFilesV7Operations.map(() => 7));
    expect(
      workspaceFilesV7Operations
        .map((definition) => definition.operation)
        .sort(),
    ).toEqual([
      "diff.create",
      "diff.file_content",
      "diff.files",
      "diff.patch",
      "diff.refs",
      "diff.repositories",
      "diff.review_identity",
      "diff.review_repository_identity",
      "diff.validate_review_anchor",
      "diff.validate_reviewed_file",
      "files.discover_link_root",
      "files.download_cancel",
      "files.download_start",
      "files.list",
      "files.list_directory",
      "files.read",
      "files.resolve_link",
      "files.status",
      "files.watch_close",
      "files.watch_open",
      "files.write",
      "mutation.acknowledge",
      "mutation.inspect",
      "mutation.list",
      "root.close",
      "root.open",
      "root.validate",
      "worktrees.discover",
      "worktrees.remove",
    ]);
    expect(
      workspaceFilesDiffCreateComparisonOperation.requestSchema.safeParse({
        rootHandle: randomUUID(),
        repositoryId: randomUUID(),
        mode: "direct",
        base: { kind: "revision", revision: "HEAD^" },
        head: { kind: "working_tree" },
      }).success,
    ).toBe(false);
    expect(
      workspaceFilesDiffCreateComparisonOperation.requestSchema.safeParse({
        rootHandle: randomUUID(),
        repositoryId: randomUUID(),
        mode: "direct",
        base: { kind: "index" },
        head: { kind: "working_tree" },
        command: ["git", "diff"],
      }).success,
    ).toBe(false);
    expect(
      workspaceFilesDiffValidateReviewAnchorOperation.requestSchema.safeParse({
        rootHandle: randomUUID(),
        comparisonId: randomUUID(),
        fingerprint: "state-fingerprint-0001",
        fileId: randomUUID(),
        side: "new",
        startLine: 1,
        endLine: 501,
      }).success,
    ).toBe(false);
  });

  it("admits a legal 16 MiB text write at worst-case JSON escaping expansion", () => {
    const content = "\u0001".repeat(WORKSPACE_FILE_MAX_CONTENT_BYTES);
    const payload = workspaceFilesWriteOperation.requestSchema.parse({
      operationId: randomUUID(),
      rootHandle: randomUUID(),
      path: "large.txt",
      content,
      expectedRevision: "revision-1",
    });
    const frame = encodeSidecarEnvelope({
      wireVersion: SIDECAR_WIRE_VERSION,
      sessionNonce,
      type: "request",
      requestNamespace: "sedes",
      requestId: randomUUID(),
      capabilityId: "workspace_files",
      majorVersion: 5,
      operation: "files.write",
      deadline: { mode: "finite", milliseconds: 60_000 },
      payload,
    });
    expect(DEFAULT_SIDECAR_PROTOCOL_LIMITS.maximumFrameBytes).toBe(
      WORKSPACE_FILE_WRITE_JSON_LIMIT_BYTES,
    );
    expect(frame.byteLength).toBeGreaterThan(24 * 1024 * 1024);
    expect(frame.byteLength).toBeLessThanOrEqual(
      DEFAULT_SIDECAR_PROTOCOL_LIMITS.maximumFrameBytes,
    );
  }, 30_000);

  it("negotiates exact directional inventories and performs simultaneous duplex calls", async () => {
    const collisionId = randomUUID();
    const pair = frameTransportPair();
    const sedesRegistry = new SidecarOperationRegistry();
    const sidecarRegistry = new SidecarOperationRegistry();
    sedesRegistry.register(
      agentToolCatalogOperation,
      ({ sourceCapability: capability }) => ({
        tools: [capability],
      }),
    );
    registerRemainingAgentToolOperations(sedesRegistry);
    sidecarRegistry.register(workspaceEchoOperation, ({ value }) => ({
      value,
    }));
    registerControlV2Operations(sidecarRegistry, {
      buildId,
      artifactSha256,
      enabledSidecarCapabilities: [workspaceCapability],
      enabledSedesCapabilities: [agentToolInventory],
      prepareSedesCapabilities: () => ({
        endpoint: "unix:///tmp/sedes-agent-tools.sock",
        executableDirectory: "/tmp/sedes-sidecar",
        inheritedPath: "/usr/bin",
      }),
    });
    const sedesIds = [randomUUID(), collisionId];
    const sedes = new SidecarProtocolPeer({
      role: "sedes",
      transport: pair.left,
      sessionNonce,
      registry: sedesRegistry,
      requestIdFactory: () => sedesIds.shift()!,
    });
    const sidecar = new SidecarProtocolPeer({
      role: "sidecar",
      transport: pair.right,
      sessionNonce,
      registry: sidecarRegistry,
      requestIdFactory: () => collisionId,
    });
    expect(() => sedes.assertReady()).toThrow("sidecar_protocol_peer_not_started");
    sedes.start();
    sidecar.start();

    expect(sedes.supportsOperation(workspaceEchoOperation)).toBe(false);
    expect(() => sedes.assertReady()).toThrow("sidecar_protocol_hello_required");
    const hello = await sedes.call(controlHelloOperation, {
      expectedBuildId: buildId,
      expectedArtifactSha256: artifactSha256,
      authorizedSidecarCapabilities: [workspaceCapability],
      offeredSedesCapabilities: [agentToolInventory],
    });
    expect(hello).toMatchObject({
      wireVersion: SIDECAR_WIRE_VERSION,
      sidecarCapabilities: [
        {
          capabilityId: "control",
          majorVersion: 2,
          operations: ["go_away", "hello", "ping"],
        },
        { ...workspaceCapability, operations: ["files.echo"] },
      ],
      sedesCapabilities: [agentToolInventory],
      agentToolCli: {
        endpoint: "unix:///tmp/sedes-agent-tools.sock",
      },
    });

    expect(() => sedes.assertReady()).not.toThrow();
    expect(sedes.supportsOperation(workspaceEchoOperation)).toBe(true);
    expect(sedes.supportsOperation({ capabilityId: "interactive_terminal", majorVersion: 2, operation: "terminal.create" })).toBe(false);
    expect(sedes.supportsOperation(agentToolCatalogOperation)).toBe(false);
    expect(sidecar.supportsOperation(agentToolCatalogOperation)).toBe(true);

    const [files, tools] = await Promise.all([
      sedes.call(workspaceEchoOperation, { value: "remote" }),
      sidecar.call(agentToolCatalogOperation, { sourceCapability }),
    ]);
    expect(files).toEqual({ value: "remote" });
    expect(tools).toEqual({ tools: [sourceCapability] });
    await sedes.close("test_complete");
    expect(sedes.supportsOperation(workspaceEchoOperation)).toBe(false);
    expect(() => sedes.assertReady()).toThrow("sidecar_protocol_peer_closed");
  });

  it("waits for agent-tool ingress readiness before completing hello", async () => {
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const fixture = peerFixture({ prepare: async () => await gate });
    const pending = fixture.hello();
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    ready();
    await expect(pending).resolves.toMatchObject({
      agentToolCli: { endpoint: "unix:///tmp/sedes-agent-tools.sock" },
    });
    await fixture.sedes.close("test_complete");
  });

  it("requires metadata exactly when agent_tools_cli is accepted", async () => {
    const pair = frameTransportPair();
    const sedesRegistry = new SidecarOperationRegistry();
    sedesRegistry.register(agentToolCatalogOperation, () => ({ tools: [] }));
    registerRemainingAgentToolOperations(sedesRegistry);
    const sidecarRegistry = new SidecarOperationRegistry();
    registerControlV2Operations(sidecarRegistry, {
      buildId,
      artifactSha256,
      enabledSidecarCapabilities: [],
      enabledSedesCapabilities: [agentToolInventory],
    });
    const sedes = new SidecarProtocolPeer({
      role: "sedes",
      transport: pair.left,
      sessionNonce,
      registry: sedesRegistry,
    });
    const sidecar = new SidecarProtocolPeer({
      role: "sidecar",
      transport: pair.right,
      sessionNonce,
      registry: sidecarRegistry,
    });
    sedes.start();
    sidecar.start();
    await expect(
      sedes.call(controlHelloOperation, {
        expectedBuildId: buildId,
        expectedArtifactSha256: artifactSha256,
        authorizedSidecarCapabilities: [],
        offeredSedesCapabilities: [agentToolInventory],
      }),
    ).rejects.toMatchObject({ code: "sidecar_agent_tool_cli_not_ready" });
    await sedes.close("test_complete");
  });

  it("rejects partial and reordered Sedes capability offers", async () => {
    const fixture = peerFixture();
    for (const operations of [
      ["catalog.list"],
      ["catalog.list", "catalog.describe", "tool.invoke"],
    ]) {
      await expect(
        fixture.sedes.call(
          controlHelloOperation,
          helloRequest([{ ...agentToolCapability, operations }]),
        ),
      ).rejects.toMatchObject({
        code: "sidecar_sedes_capability_mismatch",
      });
    }
    await expect(fixture.hello()).resolves.toMatchObject({
      sedesCapabilities: [agentToolInventory],
    });
    await fixture.sedes.close("test_complete");
  });

  it("strictly bounds and canonicalizes agent-tool CLI hello metadata", () => {
    const valid = {
      endpoint: "unix:///tmp/sedes-agent-tools.sock",
      executableDirectory: "/tmp/sedes-sidecar",
      inheritedPath: "/usr/bin:/bin",
    };
    expect(sidecarAgentToolCliMetadataSchema.parse(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, endpoint: "unix:///tmp/%68arness.sock" },
      { ...valid, endpoint: "unix:///tmp/../sedes.sock" },
      { ...valid, endpoint: `unix:///tmp/${"a".repeat(100)}` },
      { ...valid, executableDirectory: "/tmp/../sedes" },
      { ...valid, executableDirectory: `/tmp/${"a".repeat(4_096)}` },
      { ...valid, inheritedPath: "/usr/bin\u007f:/bin" },
      { ...valid, inheritedPath: "a".repeat(16_385) },
    ]) {
      expect(sidecarAgentToolCliMetadataSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("delivers events for a negotiated sidecar capability", async () => {
    const fixture = peerFixture();
    await fixture.hello();
    const listener = vi.fn();
    fixture.sedes.onEvent({
      capabilityId: "workspace_files",
      majorVersion: 5,
      event: "files.invalidated",
      schema: workspaceFilesInvalidatedEventSchema,
      listener,
    });
    const subscriptionHandle = randomUUID();
    await fixture.sidecar.sendEvent({
      capabilityId: "workspace_files",
      majorVersion: 5,
      event: "files.invalidated",
      schema: workspaceFilesInvalidatedEventSchema,
      payload: { subscriptionHandle },
    });
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith({ subscriptionHandle }),
    );
    await fixture.sedes.close("test_complete");
  });

  it("tracks validated inbound activity separately from local outbound activity", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fixture = peerFixture();
    const initial = fixture.sidecar.activitySnapshot();
    expect(initial).toMatchObject({
      lastActivityAtMilliseconds: 1_000,
      lastInboundActivityAtMilliseconds: 1_000,
      lastOutboundActivityAtMilliseconds: 1_000,
    });

    now.mockReturnValue(2_000);
    await fixture.hello();
    expect(fixture.sidecar.activitySnapshot()).toMatchObject({
      lastActivityAtMilliseconds: 2_000,
      lastInboundActivityAtMilliseconds: 2_000,
      lastOutboundActivityAtMilliseconds: 1_000,
    });

    fixture.sedes.onEvent({
      capabilityId: "workspace_files",
      majorVersion: 5,
      event: "files.invalidated",
      schema: workspaceFilesInvalidatedEventSchema,
      listener: vi.fn(),
    });
    now.mockReturnValue(3_000);
    await fixture.sidecar.sendEvent({
      capabilityId: "workspace_files",
      majorVersion: 5,
      event: "files.invalidated",
      schema: workspaceFilesInvalidatedEventSchema,
      payload: { subscriptionHandle: randomUUID() },
    });
    expect(fixture.sidecar.activitySnapshot()).toMatchObject({
      lastActivityAtMilliseconds: 3_000,
      lastInboundActivityAtMilliseconds: 2_000,
      lastOutboundActivityAtMilliseconds: 3_000,
    });

    now.mockReturnValue(4_000);
    await fixture.sedes.call(controlPingOperation, { pingId: randomUUID() });
    expect(fixture.sidecar.activitySnapshot()).toMatchObject({
      lastActivityAtMilliseconds: 4_000,
      lastInboundActivityAtMilliseconds: 4_000,
      lastOutboundActivityAtMilliseconds: 3_000,
    });
    await fixture.sedes.close("test_complete");
    now.mockRestore();
  });

  it("propagates reverse cancellation to the Sedes-hosted handler", async () => {
    const cancelled = vi.fn();
    const fixture = peerFixture({
      catalogHandler: async (_request, context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener(
            "abort",
            () => {
              cancelled();
              resolve();
            },
            { once: true },
          ),
        );
        return { tools: [] };
      },
    });
    await fixture.hello();
    const controller = new AbortController();
    const pending = fixture.sidecar.call(
      agentToolCatalogOperation,
      { sourceCapability },
      { signal: controller.signal },
    );
    await vi.waitFor(() =>
      expect(fixture.sidecar.activitySnapshot().pendingOperationRequests).toBe(
        1,
      ),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      message: "sidecar_request_cancelled",
      delivery: "sent_outcome_unknown",
    });
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    await fixture.sedes.close("test_complete");
  });

  it("requires caller cancellation authority for abort-only operations", async () => {
    const fixture = peerFixture();
    await fixture.hello();
    await expect(
      fixture.sidecar.call(agentToolInvokeOperation, {}),
    ).rejects.toThrow("sidecar_caller_abort_signal_required");
    await fixture.sedes.close("test_complete");
  });

  it("fails closed on a reflected request namespace", async () => {
    const fixture = peerFixture({
      catalogHandler: () => new Promise(() => undefined),
    });
    await fixture.hello();
    await fixture.pair.right.send(
      encodeSidecarEnvelope({
        wireVersion: SIDECAR_WIRE_VERSION,
        sessionNonce,
        type: "request",
        requestNamespace: "sedes",
        requestId: randomUUID(),
        capabilityId: "agent_tools_cli",
        majorVersion: 3,
        operation: "catalog.list",
        deadline: { mode: "finite", milliseconds: 1_000 },
        payload: { sourceCapability },
      }),
      { lane: "operation" },
    );
    await expect(fixture.pair.left.closed).resolves.toMatchObject({
      reason: "sidecar_protocol_request_namespace_invalid",
    });
  });

  it("preserves not-sent and sent-outcome-unknown delivery classifications", async () => {
    const notSent = frameTransportPair();
    notSent.left.rejectNextSend = true;
    const registry = new SidecarOperationRegistry();
    const sedes = new SidecarProtocolPeer({
      role: "sedes",
      transport: notSent.left,
      sessionNonce,
      registry,
    });
    sedes.start();
    await expect(
      sedes.call(controlHelloOperation, helloRequest([])),
    ).rejects.toMatchObject({ delivery: "not_sent" });

    const fixture = peerFixture();
    await fixture.hello();
    const pending = fixture.sidecar.call(agentToolCatalogOperation, {
      sourceCapability,
    });
    await vi.waitFor(() =>
      expect(fixture.pair.right.sentLanes).toContain("operation"),
    );
    await fixture.pair.left.close("response_lost");
    await expect(pending).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
  });
});

function peerFixture(input?: {
  readonly prepare?: () => Promise<void>;
  readonly catalogHandler?: SidecarOperationHandler<
    z.infer<typeof agentToolCatalogOperation.requestSchema>,
    z.infer<typeof agentToolCatalogOperation.responseSchema>
  >;
}) {
  const pair = frameTransportPair();
  const sedesRegistry = new SidecarOperationRegistry();
  sedesRegistry.register(
    agentToolCatalogOperation,
    input?.catalogHandler ?? (() => ({ tools: [] })),
  );
  registerRemainingAgentToolOperations(sedesRegistry);
  const sidecarRegistry = new SidecarOperationRegistry();
  sidecarRegistry.register(workspaceEchoOperation, ({ value }) => ({ value }));
  registerControlV2Operations(sidecarRegistry, {
    buildId,
    artifactSha256,
    enabledSidecarCapabilities: [workspaceCapability],
    enabledSedesCapabilities: [agentToolInventory],
    prepareSedesCapabilities: async () => {
      await input?.prepare?.();
      return {
        endpoint: "unix:///tmp/sedes-agent-tools.sock",
        executableDirectory: "/tmp/sedes-sidecar",
        inheritedPath: "/usr/bin",
      };
    },
  });
  const sedes = new SidecarProtocolPeer({
    role: "sedes",
    transport: pair.left,
    sessionNonce,
    registry: sedesRegistry,
  });
  const sidecar = new SidecarProtocolPeer({
    role: "sidecar",
    transport: pair.right,
    sessionNonce,
    registry: sidecarRegistry,
  });
  sedes.start();
  sidecar.start();
  return {
    pair,
    sedes,
    sidecar,
    hello: () =>
      sedes.call(controlHelloOperation, helloRequest([agentToolInventory])),
  };
}

function helloRequest(
  offeredSedesCapabilities: readonly {
    readonly capabilityId: string;
    readonly majorVersion: number;
    readonly operations: readonly string[];
  }[],
) {
  return {
    expectedBuildId: buildId,
    expectedArtifactSha256: artifactSha256,
    authorizedSidecarCapabilities: [workspaceCapability],
    offeredSedesCapabilities,
  };
}

function registerRemainingAgentToolOperations(
  registry: SidecarOperationRegistry,
): void {
  registry.register(agentToolDescribeOperation, () => ({ done: true }));
  registry.register(agentToolInvokeOperation, () => ({ done: true }));
}

class AsyncFrameQueue implements AsyncIterable<SidecarFrame> {
  readonly #values: SidecarFrame[] = [];
  readonly #waiters: Array<(result: IteratorResult<SidecarFrame>) => void> = [];
  #ended = false;

  push(frame: SidecarFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: frame, done: false });
    else this.#values.push(frame);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SidecarFrame> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { value, done: false };
        if (this.#ended) return { value: undefined, done: true };
        return await new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class MemoryFrameTransport implements SidecarFrameTransport {
  readonly assurance = Object.freeze({ kind: "memory", carrierGeneration: 1 });
  readonly frames: AsyncIterable<SidecarFrame>;
  readonly closed: Promise<SidecarTransportClosure>;
  readonly sentLanes: SidecarFrameLane[] = [];
  rejectNextSend = false;
  peer?: MemoryFrameTransport;
  readonly #queue = new AsyncFrameQueue();
  readonly #resolveClosed: (closure: SidecarTransportClosure) => void;
  #isClosed = false;

  constructor() {
    this.frames = this.#queue;
    let resolveClosed!: (closure: SidecarTransportClosure) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  async send(
    bytes: Uint8Array,
    options: { readonly lane: SidecarFrameLane; readonly signal?: AbortSignal },
  ): Promise<{ readonly disposition: "sent" }> {
    if (this.rejectNextSend) {
      this.rejectNextSend = false;
      throw new SidecarFrameWriteError("test_not_sent", "not_sent");
    }
    if (this.#isClosed || !this.peer || options.signal?.aborted) {
      throw new SidecarFrameWriteError("memory_transport_closed", "not_sent");
    }
    this.sentLanes.push(options.lane);
    this.peer.#queue.push({ bytes: Uint8Array.from(bytes) });
    return { disposition: "sent" };
  }

  async close(reason: string): Promise<void> {
    this.#finish(reason);
    if (this.peer) this.peer.#finish(reason);
  }

  #finish(reason: string): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#queue.end();
    this.#resolveClosed({ reason });
  }
}

function frameTransportPair(): {
  readonly left: MemoryFrameTransport;
  readonly right: MemoryFrameTransport;
} {
  const left = new MemoryFrameTransport();
  const right = new MemoryFrameTransport();
  left.peer = right;
  right.peer = left;
  return { left, right };
}
