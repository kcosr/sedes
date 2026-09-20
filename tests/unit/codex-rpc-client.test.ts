import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_RPC_UNDECODABLE_NOTIFICATION_CODE,
  CodexRpcClient,
  defineCodexRpcMethod,
  isCodexRpcUndecodableNotification,
  type CodexRpcClientOptions,
  type CodexServerRequestHandlers,
} from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import {
  CodexRpcDeliveryError,
  CodexRpcRemoteError,
} from "../../src/server/backends/codex/rpc/errors.js";
import { CodexServerRequestRouter } from "../../src/server/backends/codex/codex-server-request-router.js";
import {
  CODEX_CLIENT_REQUEST_METHODS,
  CODEX_EXPERIMENTAL_CLIENT_REQUEST_METHODS,
  CODEX_SERVER_REQUEST_METHODS,
  type CodexServerRequestMethod,
} from "../../src/server/backends/codex/rpc/protocol.js";
import {
  FrameWriteError,
  createAuthenticatedTcpAssurance,
  createOwnedProcessAssurance,
  externalTransport,
  revokeFramedTransportAssurance,
  type ProviderTransportScope,
  type ExternalFramedConnection,
  type FramedMessageTransport,
  type FramedTransportClosure,
  type InboundTextFrame,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import {
  createEnvironmentAssuredTcpStreamIdentity,
  createEnvironmentOwnedProcessIdentity,
  createEnvironmentSecretIdentity,
  revokeEnvironmentAssuredTcpStreamIdentity,
  revokeEnvironmentSecretIdentity,
  type EnvironmentAssuredTcpStreamIdentity,
} from "../../src/server/execution/environment-channel.js";

const VALID_SERVER_REQUEST_PARAMS: Record<
  CodexServerRequestMethod,
  Record<string, unknown>
> = {
  "account/chatgptAuthTokens/refresh": { reason: "unauthorized" },
  applyPatchApproval: {
    conversationId: "thread-1",
    callId: "call-1",
    fileChanges: {},
    reason: null,
    grantRoot: null,
  },
  "attestation/generate": {},
  execCommandApproval: {
    conversationId: "thread-1",
    callId: "call-2",
    approvalId: null,
    command: ["pwd"],
    cwd: "/tmp",
    reason: null,
    parsedCmd: [],
  },
  "item/commandExecution/requestApproval": {
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 1,
    environmentId: null,
    availableDecisions: ["decline"],
  },
  "item/fileChange/requestApproval": {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-2",
    startedAtMs: 1,
  },
  "item/permissions/requestApproval": {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-3",
    environmentId: null,
    startedAtMs: 1,
    cwd: "/tmp",
    reason: null,
    permissions: { network: null, fileSystem: null },
  },
  "item/tool/call": {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-3",
    namespace: null,
    tool: "sedes_tool",
    arguments: null,
  },
  "item/tool/requestUserInput": {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-4",
    questions: [],
    isBlocking: true,
    autoResolutionMs: null,
  },
  "mcpServer/elicitation/request": {
    threadId: "thread-1",
    turnId: null,
    serverName: "server",
    mode: "form",
    _meta: null,
    message: "Choose",
    requestedSchema: { type: "object", properties: {} },
  },
};

const VALID_SERVER_REQUEST_RESULTS: Record<
  CodexServerRequestMethod,
  Record<string, unknown>
> = {
  "account/chatgptAuthTokens/refresh": {
    accessToken: "opaque",
    chatgptAccountId: "account-1",
    chatgptPlanType: null,
  },
  applyPatchApproval: { decision: "approved" },
  "attestation/generate": { token: "opaque" },
  execCommandApproval: { decision: "approved" },
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "item/permissions/requestApproval": {
    permissions: {},
    scope: "turn",
  },
  "item/tool/call": { contentItems: [], success: false },
  "item/tool/requestUserInput": { answers: {} },
  "mcpServer/elicitation/request": {
    action: "decline",
    content: null,
    _meta: null,
  },
};

class AsyncFrameQueue implements AsyncIterable<InboundTextFrame> {
  readonly #frames: InboundTextFrame[] = [];
  readonly #waiters: Array<(result: IteratorResult<InboundTextFrame>) => void> =
    [];
  #ended = false;

  push(frame: InboundTextFrame): void {
    if (this.#ended) throw new Error("fake_frame_queue_ended");
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: frame });
    } else {
      this.#frames.push(frame);
    }
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<InboundTextFrame> {
    return {
      next: async () => {
        const frame = this.#frames.shift();
        if (frame) return { done: false, value: frame };
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<InboundTextFrame>>(
          (resolve) => {
            this.#waiters.push(resolve);
          },
        );
      },
    };
  }
}

class FakeFramedTransport implements FramedMessageTransport {
  readonly maximumFrameBytes = 128 * 1_024 * 1_024;
  readonly assurance;
  readonly frames;
  readonly closed: Promise<FramedTransportClosure>;
  readonly writes: string[] = [];
  #blockedDelivery?: "not_sent" | "sent_outcome_unknown";
  #closed = false;
  #delayCleanup = false;
  #pendingCloseReason: string | undefined;
  #queue = new AsyncFrameQueue();
  #resolveClosed!: (closure: FramedTransportClosure) => void;

  constructor(scope: ProviderTransportScope, connectionGeneration = 7) {
    this.assurance = createOwnedProcessAssurance(
      scope,
      connectionGeneration,
      createEnvironmentOwnedProcessIdentity({
        kind: "owned_process",
        scope,
        channelId: "fake-channel",
        executable: {
          kind: "executable",
          canonicalPath: "/usr/bin/codex",
        },
        providerProcessIdentity: {
          type: "local_process_group",
          processId: 42_424,
          processGroupId: 42_424,
        },
      }),
      "codex",
    );
    this.frames = this.#queue;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  blockNextSend(delivery: "not_sent" | "sent_outcome_unknown"): void {
    this.#blockedDelivery = delivery;
  }

  delayCleanup(): void {
    this.#delayCleanup = true;
  }

  finishCleanup(closure?: FramedTransportClosure): void {
    this.#resolveClosed(
      closure ?? {
        reason: this.#pendingCloseReason ?? "fake_transport_closed",
      },
    );
  }

  cleanupPending(): boolean {
    return this.#pendingCloseReason !== undefined;
  }

  async send(
    text: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly disposition: "sent" }> {
    if (this.#closed) {
      throw new FrameWriteError("fake_transport_closed", "not_sent");
    }
    const blockedDelivery = this.#blockedDelivery;
    this.#blockedDelivery = undefined;
    if (!blockedDelivery) {
      this.writes.push(text);
      return { disposition: "sent" };
    }
    if (blockedDelivery === "sent_outcome_unknown") {
      this.writes.push(text);
    }
    return await new Promise((_, reject) => {
      const fail = () => {
        reject(
          new FrameWriteError("fake_transport_send_aborted", blockedDelivery),
        );
      };
      if (options?.signal?.aborted) {
        fail();
      } else {
        options?.signal?.addEventListener("abort", fail, {
          once: true,
        });
      }
    });
  }

  emit(value: unknown): void {
    const text = JSON.stringify(value);
    this.#queue.push({
      text,
      byteLength: Buffer.byteLength(text, "utf8"),
    });
  }

  emitText(text: string, byteLength = Buffer.byteLength(text, "utf8")): void {
    this.#queue.push({ text, byteLength });
  }

  async close(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.end();
    this.#pendingCloseReason = reason;
    if (!this.#delayCleanup) this.#resolveClosed({ reason });
  }
}

const scope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
  backendInstanceId: "codex-1",
  executionEnvironmentId: "environment-1",
} satisfies ProviderTransportScope;

function assuredTcpIdentity(
  identityScope: ProviderTransportScope,
  connectionGeneration: number,
  label: string,
): EnvironmentAssuredTcpStreamIdentity {
  const authenticationIdentity = createEnvironmentSecretIdentity({
    kind: "environment_secret",
    scope: identityScope,
    connectionGeneration,
    secretIdentity: `secret-${label}`,
  });
  return createEnvironmentAssuredTcpStreamIdentity({
    kind: "assured_tcp_stream",
    scope: identityScope,
    channelId: `channel-${label}`,
    connectionGeneration,
    authenticationIdentity,
    routeIdentity: `route-${label}`,
    transportSecurity: {
      type: "loopback_plaintext",
      loopbackVerified: true,
    },
  });
}

function authenticatedExternalTransport(input: {
  readonly scope: ProviderTransportScope;
  readonly generation: number;
  readonly label: string;
  readonly connection: ExternalFramedConnection;
}): FramedMessageTransport {
  const identity = assuredTcpIdentity(
    input.scope,
    input.generation,
    input.label,
  );
  const revokingConnection: ExternalFramedConnection = {
    maximumFrameBytes: 128 * 1_024 * 1_024,
    frames: input.connection.frames,
    closed: input.connection.closed,
    send: input.connection.send.bind(input.connection),
    closeClient: async (reason) => {
      try {
        await input.connection.closeClient(reason);
      } finally {
        revokeEnvironmentAssuredTcpStreamIdentity(identity);
      }
    },
    destroyClient: (reason) => {
      try {
        input.connection.destroyClient(reason);
      } finally {
        revokeEnvironmentAssuredTcpStreamIdentity(identity);
      }
    },
  };
  return externalTransport(
    createAuthenticatedTcpAssurance(
      input.scope,
      input.generation,
      identity,
      "codex",
    ),
    revokingConnection,
    "codex",
  );
}

const echoMethod = defineCodexRpcMethod<{ readonly value: string }, string>({
  method: "thread/read",
  encodeParams: (params) => params,
  decodeResult: (result) => {
    if (
      typeof result !== "object" ||
      result === null ||
      !("value" in result) ||
      typeof result.value !== "string"
    ) {
      throw new Error("invalid_echo_result");
    }
    return result.value;
  },
});

const liveClients: CodexRpcClient[] = [];

function createClient(
  overrides: Partial<Omit<CodexRpcClientOptions, "transport">> & {
    readonly transport?: FakeFramedTransport;
  } = {},
): {
  readonly client: CodexRpcClient;
  readonly transport: FakeFramedTransport;
} {
  const transport = overrides.transport ?? new FakeFramedTransport(scope);
  const client = new CodexRpcClient({
    transport,
    expectedScope: scope,
    generation: 7,
    runtimeNonce: "runtime",
    ...overrides,
  });
  client.start();
  liveClients.push(client);
  return { client, transport };
}

function parsedWrite(
  transport: FakeFramedTransport,
  index: number,
): Record<string, unknown> {
  return JSON.parse(transport.writes[index]!) as Record<string, unknown>;
}

async function waitForWrites(
  transport: FakeFramedTransport,
  count: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(transport.writes).toHaveLength(count);
  });
}

afterEach(async () => {
  await Promise.all(
    liveClients
      .splice(0)
      .map((client) => client.close().catch(() => undefined)),
  );
});

describe("Codex RPC client", () => {
  it("closes an external connection without emitting a late approval denial or shutdown request", async () => {
    const connection = new FakeFramedTransport(scope, 7);
    const closeClient = vi.fn(connection.close.bind(connection));
    const transport = authenticatedExternalTransport({ scope, generation: 7, label: "external-stop-approval", connection: {
      maximumFrameBytes: connection.maximumFrameBytes, frames: connection.frames, closed: connection.closed,
      send: connection.send.bind(connection), closeClient, destroyClient: reason => { void connection.close(reason); },
    } });
    const router = new CodexServerRequestRouter();
    router.activateGeneration(7);
    const owner = vi.fn((request: { signal: AbortSignal }) => new Promise<never>((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }));
    const lease = router.claimThread({ generation: 7, nativeThreadId: "thread-1", owner: { owns: () => true, handle: owner } });
    const client = new CodexRpcClient({ transport, expectedScope: scope, generation: 7, handlers: router.handlersForGeneration(7) });
    client.start();
    liveClients.push(client);
    connection.emit({ id: "pending-approval", method: "item/commandExecution/requestApproval", params: VALID_SERVER_REQUEST_PARAMS["item/commandExecution/requestApproval"] });
    await vi.waitFor(() => expect(owner).toHaveBeenCalledOnce());
    await client.close("operator_stop_external_connection");
    lease.release("conversation_cleanup_after_disconnect");
    await new Promise(resolve => setImmediate(resolve));
    expect(closeClient).toHaveBeenCalledOnce();
    expect(connection.writes).toEqual([]);
  });

  it("rejects a transport whose authenticated scope is different", () => {
    const transport = new FakeFramedTransport(
      {
        ...scope,
        principalId: "principal-2",
      },
      1,
    );
    expect(
      () =>
        new CodexRpcClient({
          transport,
          expectedScope: scope,
          generation: 1,
        }),
    ).toThrow("codex_rpc_transport_scope_mismatch");
  });

  it("rejects an assurance minted for another connection generation", () => {
    const transport = new FakeFramedTransport(scope, 2);
    expect(
      () =>
        new CodexRpcClient({
          transport,
          expectedScope: scope,
          generation: 1,
        }),
    ).toThrow("codex_rpc_transport_generation_mismatch");
  });

  it("rejects forged socket assurance and accepts branded TCP assurance", () => {
    const forged = new FakeFramedTransport(scope, 1);
    Object.defineProperty(forged, "assurance", {
      value: {
        kind: "authenticated_tcp",
        ownership: "external",
        channel: "tcp_websocket",
        scope,
        connectionGeneration: 1,
        environmentChannelIdentity: {
          kind: "assured_tcp_stream",
          scope,
          channelId: "forged-channel",
          connectionGeneration: 1,
          authenticationIdentity: {
            kind: "environment_secret",
            scope,
            connectionGeneration: 1,
            secretIdentity: "forged-secret",
          },
          routeIdentity: "forged-route",
          transportSecurity: {
            type: "loopback_plaintext",
            loopbackVerified: true,
          },
        },
        authentication: "capability_token",
        websocketUpgradeVerified: true,
      },
    });
    expect(
      () =>
        new CodexRpcClient({
          transport: forged,
          expectedScope: scope,
          generation: 1,
        }),
    ).toThrow("codex_rpc_transport_assurance_invalid");

    const connection = new FakeFramedTransport(scope);
    const transport = authenticatedExternalTransport({
      scope,
      generation: 1,
      label: "accepted",
      connection: {
        maximumFrameBytes: connection.maximumFrameBytes,
        frames: connection.frames,
        closed: connection.closed,
        send: connection.send.bind(connection),
        closeClient: connection.close.bind(connection),
        destroyClient: (reason) => {
          void connection.close(reason);
        },
      },
    });
    const client = new CodexRpcClient({
      transport,
      expectedScope: scope,
      generation: 1,
    });
    expect(() => client.start()).not.toThrow();
    liveClients.push(client);
  });

  it("rejects forged, stale, wrong-scope, and wrong-generation TCP authentication identities", () => {
    const forgedSecret = {
      kind: "environment_secret" as const,
      scope,
      connectionGeneration: 1,
      secretIdentity: "forged-secret",
    };
    expect(() =>
      createEnvironmentAssuredTcpStreamIdentity({
        kind: "assured_tcp_stream",
        scope,
        channelId: "forged-secret-channel",
        connectionGeneration: 1,
        authenticationIdentity: forgedSecret,
        routeIdentity: "forged-secret-route",
        transportSecurity: {
          type: "loopback_plaintext",
          loopbackVerified: true,
        },
      }),
    ).toThrow("environment_assured_tcp_stream_identity_invalid");

    const otherScope = { ...scope, principalId: "principal-2" };
    const wrongScopeSecret = createEnvironmentSecretIdentity({
      kind: "environment_secret",
      scope: otherScope,
      connectionGeneration: 1,
      secretIdentity: "wrong-scope-secret",
    });
    expect(() =>
      createEnvironmentAssuredTcpStreamIdentity({
        kind: "assured_tcp_stream",
        scope,
        channelId: "wrong-scope-secret-channel",
        connectionGeneration: 1,
        authenticationIdentity: wrongScopeSecret,
        routeIdentity: "wrong-scope-secret-route",
        transportSecurity: {
          type: "loopback_plaintext",
          loopbackVerified: true,
        },
      }),
    ).toThrow("environment_assured_tcp_stream_identity_invalid");
    revokeEnvironmentSecretIdentity(wrongScopeSecret);

    const wrongGenerationSecret = createEnvironmentSecretIdentity({
      kind: "environment_secret",
      scope,
      connectionGeneration: 2,
      secretIdentity: "wrong-generation-secret",
    });
    expect(() =>
      createEnvironmentAssuredTcpStreamIdentity({
        kind: "assured_tcp_stream",
        scope,
        channelId: "wrong-generation-secret-channel",
        connectionGeneration: 1,
        authenticationIdentity: wrongGenerationSecret,
        routeIdentity: "wrong-generation-secret-route",
        transportSecurity: {
          type: "loopback_plaintext",
          loopbackVerified: true,
        },
      }),
    ).toThrow("environment_assured_tcp_stream_identity_invalid");
    revokeEnvironmentSecretIdentity(wrongGenerationSecret);

    const wrongScopeIdentity = assuredTcpIdentity(otherScope, 1, "wrong-scope");
    expect(() =>
      createAuthenticatedTcpAssurance(scope, 1, wrongScopeIdentity, "codex"),
    ).toThrow("codex_authenticated_tcp_assurance_invalid");
    revokeEnvironmentAssuredTcpStreamIdentity(wrongScopeIdentity);

    const wrongGenerationIdentity = assuredTcpIdentity(
      scope,
      2,
      "wrong-generation",
    );
    expect(() =>
      createAuthenticatedTcpAssurance(
        scope,
        1,
        wrongGenerationIdentity,
        "codex",
      ),
    ).toThrow("codex_authenticated_tcp_assurance_invalid");
    revokeEnvironmentAssuredTcpStreamIdentity(wrongGenerationIdentity);

    const staleIdentity = assuredTcpIdentity(scope, 1, "stale");
    const staleTransport = new FakeFramedTransport(scope, 1);
    Object.defineProperty(staleTransport, "assurance", {
      value: createAuthenticatedTcpAssurance(scope, 1, staleIdentity, "codex"),
    });
    revokeEnvironmentAssuredTcpStreamIdentity(staleIdentity);
    expect(
      () =>
        new CodexRpcClient({
          transport: staleTransport,
          expectedScope: scope,
          generation: 1,
        }),
    ).toThrow("codex_rpc_transport_assurance_invalid");
  });

  it("rejects a genuine owned-process assurance after its generation retires", () => {
    const transport = new FakeFramedTransport(scope, 1);
    revokeFramedTransportAssurance(transport.assurance);

    expect(
      () =>
        new CodexRpcClient({
          transport,
          expectedScope: scope,
          generation: 1,
        }),
    ).toThrow("codex_rpc_transport_assurance_invalid");
  });

  it("bounds and idempotently hard-closes a stuck external client", async () => {
    vi.useFakeTimers();
    try {
      let rejectGracefulClose!: (error: Error) => void;
      const closeClient = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectGracefulClose = reject;
          }),
      );
      const destroyClient = vi.fn(() => {
        rejectGracefulClose(new Error("client_destroyed_after_deadline"));
      });
      const transport = authenticatedExternalTransport({
        scope,
        generation: 1,
        label: "bounded-close",
        connection: {
          maximumFrameBytes: 128 * 1_024 * 1_024,
          frames: { [Symbol.asyncIterator]: async function* () {} },
          closed: new Promise<FramedTransportClosure>(() => undefined),
          send: async () => ({ disposition: "sent" as const }),
          closeClient,
          destroyClient,
        },
      });
      const first = transport.close("bounded_external_close");
      const second = transport.close("duplicate_external_close");
      expect(second).toBe(first);
      const firstRejection = expect(first).rejects.toThrow(
        "codex_external_client_close_deadline_exceeded",
      );
      const secondRejection = expect(second).rejects.toThrow(
        "codex_external_client_close_deadline_exceeded",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await firstRejection;
      await secondRejection;
      expect(closeClient).toHaveBeenCalledOnce();
      expect(destroyClient).toHaveBeenCalledExactlyOnceWith(
        "bounded_external_close:forced",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins the stable inventory, explicitly adopts reviewed experiments, and rejects unknown methods", async () => {
    const { client, transport } = createClient();
    expect(CODEX_CLIENT_REQUEST_METHODS).toHaveLength(24);
    expect(CODEX_CLIENT_REQUEST_METHODS).toContain("thread/loaded/list");
    expect(CODEX_EXPERIMENTAL_CLIENT_REQUEST_METHODS).toEqual([
      "thread/settings/update",
    ]);
    const unsupported = {
      method: "thread/search",
      encodeParams: (params: Record<string, never>) => params,
      decodeResult: (result: unknown) => result,
    } as unknown as Parameters<typeof client.request>[0];

    await expect(
      client.request(unsupported, {}, { timeoutMilliseconds: 1_000 }),
    ).rejects.toMatchObject({
      message: "codex_rpc_method_unsupported",
      delivery: "not_sent",
    });
    expect(transport.writes).toHaveLength(0);
  });

  it("correlates concurrent out-of-order responses and routes notifications", async () => {
    const { client, transport } = createClient();
    const notifications: unknown[] = [];
    client.subscribeNotifications((notification) => {
      notifications.push(notification);
    });

    const first = client.request(
      echoMethod,
      { value: "first" },
      { timeoutMilliseconds: 1_000 },
    );
    const second = client.request(
      echoMethod,
      { value: "second" },
      { timeoutMilliseconds: 1_000 },
    );
    await waitForWrites(transport, 2);
    const firstEnvelope = parsedWrite(transport, 0);
    const secondEnvelope = parsedWrite(transport, 1);
    expect(firstEnvelope).not.toHaveProperty("jsonrpc");
    expect(firstEnvelope.id).toMatch(/^sedes:runtime:7:\d+$/);

    transport.emit({ id: secondEnvelope.id, result: { value: "two" } });
    transport.emit({ id: firstEnvelope.id, result: { value: "one" } });
    await expect(second).resolves.toBe("two");
    await expect(first).resolves.toBe("one");

    transport.emit({
      method: "warning",
      params: { message: "bounded warning" },
      emittedAtMs: 123,
    });
    await vi.waitFor(() => {
      expect(notifications).toEqual([
        {
          kind: "decoded_notification",
          generation: 7,
          sequence: 3,
          method: "warning",
          params: { message: "bounded warning" },
          emittedAtMs: 123,
        },
      ]);
    });
  });

  it("routes authentication recovery and contains malformed payloads to the attributable thread", async () => {
    const { client, transport } = createClient();
    const notifications: unknown[] = [];
    client.subscribeNotifications((notification) => {
      notifications.push(notification);
    });
    const request = client.request(
      echoMethod,
      { value: "pending" },
      { timeoutMilliseconds: 1_000 },
    );
    await waitForWrites(transport, 1);

    transport.emit({
      method: "modelProvider/authRecoveryStarted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        provider: "openai",
        message: "Authentication recovery started.",
      },
    });
    transport.emit({
      method: "modelProvider/authRecoveryCompleted",
      params: {
        threadId: "thread-1",
        turnId: "turn-private",
        provider: 42,
        message: "private malformed recovery detail",
      },
    });
    transport.emit({
      id: parsedWrite(transport, 0).id,
      result: { value: "settled" },
    });

    await expect(request).resolves.toBe("settled");
    expect(notifications).toEqual([
      {
        kind: "decoded_notification",
        generation: 7,
        sequence: 1,
        method: "modelProvider/authRecoveryStarted",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          provider: "openai",
          message: "Authentication recovery started.",
        },
      },
      {
        kind: "undecodable_notification",
        generation: 7,
        sequence: 2,
        method: "modelProvider/authRecoveryCompleted",
        nativeThreadId: "thread-1",
        code: CODEX_RPC_UNDECODABLE_NOTIFICATION_CODE,
      },
    ]);
    expect(JSON.stringify(notifications)).not.toContain("turn-private");
    expect(JSON.stringify(notifications)).not.toContain(
      "private malformed recovery detail",
    );
  });

  it("returns a response receipt in the sequence shared by all inbound envelopes", async () => {
    const { client, transport } = createClient();
    const notifications: number[] = [];
    client.subscribeNotifications(({ sequence }) => {
      notifications.push(sequence);
    });
    const request = client.requestWithReceipt(
      echoMethod,
      { value: "receipt" },
      { timeoutMilliseconds: 1_000 },
    );
    await waitForWrites(transport, 1);

    transport.emit({
      method: "warning",
      params: { message: "bounded warning" },
    });
    transport.emit({
      id: parsedWrite(transport, 0).id,
      result: { value: "authoritative" },
    });

    await expect(request).resolves.toEqual({
      result: "authoritative",
      generation: 7,
      inboundSequence: 2,
    });
    expect(notifications).toEqual([1]);
  });

  it("classifies definitive overload errors separately from delivery uncertainty", async () => {
    const { client, transport } = createClient();
    const request = client.request(
      echoMethod,
      { value: "x" },
      { timeoutMilliseconds: 1_000 },
    );
    await waitForWrites(transport, 1);
    transport.emit({
      id: parsedWrite(transport, 0).id,
      error: {
        code: -32001,
        message: "Server overloaded; retry later.",
      },
    });

    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexRpcRemoteError);
    expect(error).toMatchObject({
      code: -32001,
      disposition: "rejected_not_accepted",
      generation: 7,
      method: "thread/read",
    });
  });

  it.each([
    ["not_sent", "not_sent"],
    ["sent_outcome_unknown", "sent_outcome_unknown"],
  ] as const)(
    "preserves %s when a timed-out send is aborted",
    async (transportDelivery, expectedDelivery) => {
      const { client, transport } = createClient();
      transport.blockNextSend(transportDelivery);
      const request = client.request(
        echoMethod,
        { value: "x" },
        { timeoutMilliseconds: 10 },
      );

      const error = await request.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CodexRpcDeliveryError);
      expect(error).toMatchObject({
        message: "codex_rpc_request_timeout",
        delivery: expectedDelivery,
        generation: 7,
      });
    },
  );

  it("ignores one late response after uncertain timeout and rejects a duplicate", async () => {
    const { client, transport } = createClient();
    const request = client.request(
      echoMethod,
      { value: "x" },
      { timeoutMilliseconds: 10 },
    );
    await waitForWrites(transport, 1);
    const id = parsedWrite(transport, 0).id;
    await expect(request).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });

    transport.emit({ id, result: { value: "late" } });
    await new Promise((resolve) => setImmediate(resolve));
    transport.emit({ id, result: { value: "duplicate" } });
    await expect(client.closed).resolves.toMatchObject({
      reason: "codex_rpc_duplicate_response",
      generation: 7,
    });
  });

  it("distinguishes abort before admission from abort after send", async () => {
    const { client, transport } = createClient();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      client.request(
        echoMethod,
        { value: "not-sent" },
        {
          timeoutMilliseconds: 1_000,
          signal: alreadyAborted.signal,
        },
      ),
    ).rejects.toMatchObject({
      message: "codex_rpc_request_aborted",
      delivery: "not_sent",
    });
    expect(transport.writes).toHaveLength(0);

    const afterSend = new AbortController();
    const request = client.request(
      echoMethod,
      { value: "sent" },
      { timeoutMilliseconds: 1_000, signal: afterSend.signal },
    );
    await waitForWrites(transport, 1);
    afterSend.abort();
    await expect(request).rejects.toMatchObject({
      message: "codex_rpc_request_aborted",
      delivery: "sent_outcome_unknown",
    });
  });

  it("rejects pending-capacity overflow before transport admission", async () => {
    const { client, transport } = createClient({
      limits: { maxPendingRequests: 1 },
    });
    transport.blockNextSend("not_sent");
    const first = client.request(
      echoMethod,
      { value: "held" },
      { timeoutMilliseconds: 1_000 },
    );
    await expect(
      client.request(
        echoMethod,
        { value: "overflow" },
        { timeoutMilliseconds: 1_000 },
      ),
    ).rejects.toMatchObject({
      message: "codex_rpc_pending_capacity_exceeded",
      delivery: "not_sent",
    });
    await client.close();
    await expect(first).rejects.toMatchObject({
      delivery: "not_sent",
    });
  });

  it("preserves queued not-sent classification across transport close while sent stays unknown", async () => {
    const queued = createClient();
    queued.transport.blockNextSend("not_sent");
    const queuedRequest = queued.client.request(
      echoMethod,
      { value: "queued" },
      { timeoutMilliseconds: 1_000 },
    );
    await queued.transport.close("peer_closed");
    await expect(queuedRequest).rejects.toMatchObject({
      message: "codex_rpc_connection_lost",
      delivery: "not_sent",
    });
    await expect(queued.client.closed).resolves.toMatchObject({
      reason: "peer_closed",
    });

    const sent = createClient();
    const sentRequest = sent.client.request(
      echoMethod,
      { value: "sent" },
      { timeoutMilliseconds: 1_000 },
    );
    await waitForWrites(sent.transport, 1);
    await sent.transport.close("peer_closed");
    await expect(sentRequest).rejects.toMatchObject({
      message: "codex_rpc_connection_lost",
      delivery: "sent_outcome_unknown",
    });
  });

  it("classifies requests racing a closed shared generation as not sent", async () => {
    const { client, transport } = createClient();
    await transport.close("peer_closed");
    await client.closed;

    let failure: unknown;
    try {
      await client.request(
        echoMethod,
        { value: "after-close" },
        { timeoutMilliseconds: 1_000 },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CodexRpcDeliveryError);
    expect(failure).toMatchObject({
      message: "codex_rpc_client_closed",
      delivery: "not_sent",
      generation: 7,
      method: "thread/read",
    });
  });

  it("handles every pinned server-request method exactly once", async () => {
    const calls: CodexServerRequestMethod[] = [];
    const handlers = Object.fromEntries(
      CODEX_SERVER_REQUEST_METHODS.map((method) => [
        method,
        async () => {
          calls.push(method);
          return VALID_SERVER_REQUEST_RESULTS[method];
        },
      ]),
    ) as CodexServerRequestHandlers;
    const { client: _client, transport } = createClient({ handlers });
    for (const [index, method] of CODEX_SERVER_REQUEST_METHODS.entries()) {
      transport.emit({
        method,
        id: index + 1,
        params: VALID_SERVER_REQUEST_PARAMS[method],
      });
    }

    await waitForWrites(transport, CODEX_SERVER_REQUEST_METHODS.length);
    expect(calls).toEqual(CODEX_SERVER_REQUEST_METHODS);
    expect(
      transport.writes.map((_, index) => parsedWrite(transport, index)),
    ).toEqual(
      CODEX_SERVER_REQUEST_METHODS.map((method, index) => ({
        id: index + 1,
        result: VALID_SERVER_REQUEST_RESULTS[method],
      })),
    );

    const invalidResults = createClient({
      handlers: Object.fromEntries(
        CODEX_SERVER_REQUEST_METHODS.map((method) => [
          method,
          async () => ({ invalid: method }),
        ]),
      ) as CodexServerRequestHandlers,
    });
    for (const [index, method] of CODEX_SERVER_REQUEST_METHODS.entries()) {
      invalidResults.transport.emit({
        method,
        id: index + 1,
        params: VALID_SERVER_REQUEST_PARAMS[method],
      });
    }
    await waitForWrites(
      invalidResults.transport,
      CODEX_SERVER_REQUEST_METHODS.length,
    );
    expect(
      invalidResults.transport.writes.map((_, index) =>
        parsedWrite(invalidResults.transport, index),
      ),
    ).toEqual(
      CODEX_SERVER_REQUEST_METHODS.map((_, index) => ({
        id: index + 1,
        error: {
          code: -32603,
          message: "Sedes server request failed",
        },
      })),
    );

    const invalidParamsHandler = vi.fn();
    const invalidParams = createClient({
      handlers: Object.fromEntries(
        CODEX_SERVER_REQUEST_METHODS.map((method) => [
          method,
          invalidParamsHandler,
        ]),
      ) as CodexServerRequestHandlers,
    });
    for (const [index, method] of CODEX_SERVER_REQUEST_METHODS.entries()) {
      invalidParams.transport.emit({
        method,
        id: index + 1,
        params: method === "attestation/generate" ? null : {},
      });
    }
    await waitForWrites(
      invalidParams.transport,
      CODEX_SERVER_REQUEST_METHODS.length,
    );
    expect(invalidParamsHandler).not.toHaveBeenCalled();
    expect(
      invalidParams.transport.writes.map((_, index) =>
        parsedWrite(invalidParams.transport, index),
      ),
    ).toEqual(
      CODEX_SERVER_REQUEST_METHODS.map((_, index) => ({
        id: index + 1,
        error: { code: -32602, message: "Invalid params" },
      })),
    );
  });

  it("admits valid non-adopted notifications and rejects malformed ones", async () => {
    const valid = createClient();
    const notifications: unknown[] = [];
    valid.client.subscribeNotifications((notification) => {
      notifications.push(notification);
    });
    valid.transport.emit({
      method: "mcpServer/oauthLogin/completed",
      params: { name: "server-1", threadId: null, success: true },
    });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]).toMatchObject({
      method: "mcpServer/oauthLogin/completed",
      params: { name: "server-1", threadId: null, success: true },
    });

    const malformed = createClient();
    malformed.transport.emit({
      method: "mcpServer/oauthLogin/completed",
      params: { name: 1, threadId: null, success: true },
    });
    await expect(malformed.client.closed).resolves.toMatchObject({
      reason: "codex_rpc_invalid_notification",
    });
  });

  it("publishes a redacted attributable marker and continues notifications and pending requests", async () => {
    const { client, transport } = createClient();
    const notifications: unknown[] = [];
    client.subscribeNotifications((notification) => {
      notifications.push(notification);
    });
    const request = client.requestWithReceipt(
      echoMethod,
      { value: "pending" },
      { timeoutMilliseconds: 1_000 },
    );
    await waitForWrites(transport, 1);

    transport.emit({
      method: "turn/started",
      params: {
        threadId: "thread-safe",
        turn: {
          id: "redact-turn",
          status: "definitely-not-official",
          secret: "must-not-escape",
        },
      },
      emittedAtMs: 999,
    });
    transport.emit({
      method: "warning",
      params: { message: "still connected" },
    });
    transport.emit({
      id: parsedWrite(transport, 0).id,
      result: { value: "settled" },
    });

    await vi.waitFor(() => expect(notifications).toHaveLength(2));
    const marker = notifications[0];
    expect(marker).toEqual({
      kind: "undecodable_notification",
      generation: 7,
      sequence: 1,
      method: "turn/started",
      nativeThreadId: "thread-safe",
      code: CODEX_RPC_UNDECODABLE_NOTIFICATION_CODE,
    });
    expect(JSON.stringify(marker)).not.toContain("redact-turn");
    expect(JSON.stringify(marker)).not.toContain("must-not-escape");
    expect(
      isCodexRpcUndecodableNotification(
        marker as Parameters<typeof isCodexRpcUndecodableNotification>[0],
      ),
    ).toBe(true);
    expect(notifications[1]).toMatchObject({
      kind: "decoded_notification",
      sequence: 2,
      method: "warning",
      params: { message: "still connected" },
    });
    await expect(request).resolves.toEqual({
      result: "settled",
      generation: 7,
      inboundSequence: 3,
    });
  });

  it("uses the selected experimental thread.id route without accepting a top-level alias", async () => {
    const attributable = createClient();
    const notifications: unknown[] = [];
    attributable.client.subscribeNotifications((notification) => {
      notifications.push(notification);
    });
    attributable.transport.emit({
      method: "thread/started",
      params: { thread: { id: "native-thread", status: 42 } },
    });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]).toMatchObject({
      kind: "undecodable_notification",
      method: "thread/started",
      nativeThreadId: "native-thread",
    });

    const alias = createClient();
    alias.transport.emit({
      method: "thread/started",
      params: { threadId: "native-thread", thread: { status: 42 } },
    });
    await expect(alias.client.closed).resolves.toMatchObject({
      reason: "codex_rpc_invalid_notification",
    });
  });

  it("uses the selected experimental direct threadId route", async () => {
    const { client, transport } = createClient();
    const notifications: unknown[] = [];
    client.subscribeNotifications((notification) => {
      notifications.push(notification);
    });
    transport.emit({
      method: "thread/settings/updated",
      params: { threadId: "native-thread", threadSettings: 42 },
    });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]).toMatchObject({
      kind: "undecodable_notification",
      method: "thread/settings/updated",
      nativeThreadId: "native-thread",
    });
  });

  it("bounds attributable native thread routes in UTF-16 code units", async () => {
    const exactBoundary = "😀".repeat(256);
    expect(exactBoundary.length).toBe(512);
    const attributable = createClient();
    const notifications: unknown[] = [];
    attributable.client.subscribeNotifications((notification) => {
      notifications.push(notification);
    });
    attributable.transport.emit({
      method: "turn/started",
      params: { threadId: exactBoundary, turn: { status: "invalid" } },
    });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]).toMatchObject({
      kind: "undecodable_notification",
      nativeThreadId: exactBoundary,
    });

    const overBoundary = "😀".repeat(257);
    expect(overBoundary.length).toBe(514);
    const fatal = createClient();
    fatal.transport.emit({
      method: "turn/started",
      params: { threadId: overBoundary, turn: { status: "invalid" } },
    });
    await expect(fatal.client.closed).resolves.toMatchObject({
      reason: "codex_rpc_invalid_notification",
    });
  });

  it.each([
    [{ turn: {} }, "missing"],
    [{ threadId: "", turn: {} }, "empty"],
    [{ threadId: "x".repeat(513), turn: {} }, "oversized"],
    [{ threadId: 42, turn: {} }, "non-string"],
  ])(
    "keeps an invalid route connection-fatal: %s",
    async (params, _disposition) => {
      const { client, transport } = createClient();
      transport.emit({ method: "turn/started", params });
      await expect(client.closed).resolves.toMatchObject({
        reason: "codex_rpc_invalid_notification",
      });
    },
  );

  it("keeps bounded snapshot failure connection-fatal even with a safe route", async () => {
    const { client, transport } = createClient();
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 70; index += 1) {
      nested = { nested };
    }
    transport.emit({
      method: "turn/started",
      params: { threadId: "thread-safe", turn: nested },
    });
    await expect(client.closed).resolves.toMatchObject({
      reason: "codex_rpc_invalid_notification",
    });
  });

  it("does not treat an undeclared thread-like member as a notification route", async () => {
    const { client, transport } = createClient();
    transport.emit({
      method: "account/updated",
      params: { threadId: "thread-safe", authMode: 42 },
    });
    await expect(client.closed).resolves.toMatchObject({
      reason: "codex_rpc_invalid_notification",
    });
  });

  it("coalesces a semantic replay with fresh trace metadata", async () => {
    let resolveApproval!: (result: { readonly decision: string }) => void;
    const approval = new Promise<{ readonly decision: string }>((resolve) => {
      resolveApproval = resolve;
    });
    const handler = vi.fn(() => approval);
    const { client, transport } = createClient({
      handlers: {
        "item/commandExecution/requestApproval": handler,
      },
    });
    const request = {
      method: "item/commandExecution/requestApproval",
      id: "approval-1",
      params:
        VALID_SERVER_REQUEST_PARAMS["item/commandExecution/requestApproval"],
      trace: { source: "resume" },
    };

    transport.emit(request);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    transport.emit({
      ...structuredClone(request),
      trace: { source: "fresh-resume-trace" },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).toHaveBeenCalledOnce();
    expect(transport.writes).toHaveLength(0);

    resolveApproval({ decision: "decline" });
    await waitForWrites(transport, 1);
    expect(parsedWrite(transport, 0)).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });

    const followUp = client.request(
      echoMethod,
      { value: "still-open" },
      { timeoutMilliseconds: 1_000 },
    );
    await waitForWrites(transport, 2);
    const followUpId = parsedWrite(transport, 1).id;
    transport.emit({ id: followUpId, result: { value: "still-open" } });
    await expect(followUp).resolves.toBe("still-open");
  });

  it("fails an unsolicited openai elicitation form without reaching an owner or closing RPC", async () => {
    const router = new CodexServerRequestRouter();
    router.activateGeneration(7);
    const handle = vi.fn();
    const owns = vi.fn(() => true);
    router.claimThread({
      generation: 7,
      nativeThreadId: "thread-1",
      owner: { owns, handle },
    });
    const { client, transport } = createClient({
      handlers: router.handlersForGeneration(7),
    });

    transport.emit({
      method: "mcpServer/elicitation/request",
      id: "unnegotiated-elicitation",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "provider",
        mode: "openaiForm",
        _meta: null,
        message: "Configure the provider",
        requestedSchema: {
          type: "object",
          properties: { account: { type: "string" } },
        },
      },
    });
    await waitForWrites(transport, 1);
    expect(parsedWrite(transport, 0)).toEqual({
      id: "unnegotiated-elicitation",
      error: {
        code: -32603,
        message: "Sedes server request failed",
      },
    });
    expect(owns).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();

    const followUp = client.request(
      echoMethod,
      { value: "still-open" },
      { timeoutMilliseconds: 1_000 },
    );
    await waitForWrites(transport, 2);
    const followUpId = parsedWrite(transport, 1).id;
    transport.emit({ id: followUpId, result: { value: "still-open" } });
    await expect(followUp).resolves.toBe("still-open");
  });

  it("fails closed when a replay reuses an active request ID with different content", async () => {
    const handler = vi.fn(
      async ({ signal }: { readonly signal: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const { client, transport } = createClient({
      handlers: {
        "item/commandExecution/requestApproval": handler,
      },
    });
    transport.emit({
      method: "item/commandExecution/requestApproval",
      id: "approval-1",
      params:
        VALID_SERVER_REQUEST_PARAMS["item/commandExecution/requestApproval"],
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    transport.emit({
      method: "item/commandExecution/requestApproval",
      id: "approval-1",
      params: {
        ...VALID_SERVER_REQUEST_PARAMS["item/commandExecution/requestApproval"],
        itemId: "item-2",
      },
    });

    await expect(client.closed).resolves.toMatchObject({
      reason: "codex_rpc_duplicate_server_request",
      generation: 7,
    });
  });

  it("uses safe errors for unknown, malformed, unhandled, and failed server requests", async () => {
    const { client: _client, transport } = createClient({
      handlers: {
        "attestation/generate": async () => {
          throw new Error("secret details");
        },
      },
    });
    transport.emit({ method: "future/request", id: 1, params: {} });
    transport.emit({
      method: "item/tool/call",
      id: 2,
      params: {},
    });
    transport.emit({
      method: "execCommandApproval",
      id: 3,
      params: VALID_SERVER_REQUEST_PARAMS.execCommandApproval,
    });
    transport.emit({
      method: "attestation/generate",
      id: 4,
      params: {},
    });
    transport.emit({
      method: "turn/started",
      id: 5,
      params: {},
      result: {},
    });

    await waitForWrites(transport, 5);
    expect(
      transport.writes
        .map((_, index) => parsedWrite(transport, index))
        .sort((left, right) => Number(left.id) - Number(right.id)),
    ).toEqual([
      { id: 1, error: { code: -32601, message: "Method not found" } },
      { id: 2, error: { code: -32602, message: "Invalid params" } },
      { id: 3, error: { code: -32601, message: "Method not found" } },
      {
        id: 4,
        error: {
          code: -32603,
          message: "Sedes server request failed",
        },
      },
      { id: 5, error: { code: -32600, message: "Invalid Request" } },
    ]);
  });

  it("turns an unserializable handler result into one safe error", async () => {
    const { client: _client, transport } = createClient({
      handlers: {
        "attestation/generate": async () => ({ value: 1n }),
      },
    });
    transport.emit({
      method: "attestation/generate",
      id: "server-1",
      params: {},
    });
    await waitForWrites(transport, 1);
    expect(parsedWrite(transport, 0)).toEqual({
      id: "server-1",
      error: {
        code: -32603,
        message: "Sedes server request failed",
      },
    });
    transport.emit({
      method: "attestation/generate",
      id: "server-2",
      params: {},
    });
    await waitForWrites(transport, 2);
    expect(parsedWrite(transport, 1)).toMatchObject({
      id: "server-2",
      error: { code: -32603 },
    });
  });

  it("rejects behavioral server results and safely replaces oversized results", async () => {
    let serializations = 0;
    const stateful = createClient({
      handlers: {
        "attestation/generate": async () => ({
          toJSON() {
            serializations += 1;
            if (serializations > 1) throw new Error("serialized twice");
            return { token: "opaque" };
          },
        }),
      },
    });
    stateful.transport.emit({
      method: "attestation/generate",
      id: 1,
      params: {},
    });
    await waitForWrites(stateful.transport, 1);
    expect(serializations).toBe(0);
    expect(parsedWrite(stateful.transport, 0)).toEqual({
      id: 1,
      error: {
        code: -32603,
        message: "Sedes server request failed",
      },
    });

    const oversized = createClient({
      handlers: {
        "attestation/generate": async () => ({
          token: "x".repeat(1_000),
        }),
      },
      limits: { maxFrameBytes: 256 },
    });
    oversized.transport.emit({
      method: "attestation/generate",
      id: 2,
      params: {},
    });
    await waitForWrites(oversized.transport, 1);
    expect(parsedWrite(oversized.transport, 0)).toEqual({
      id: 2,
      error: {
        code: -32603,
        message: "Sedes server request failed",
      },
    });
  });

  it.each([
    [
      { jsonrpc: "2.0", method: "turn/started", params: {} },
      "codex_rpc_invalid_envelope",
    ],
    [{ id: 99, result: {} }, "codex_rpc_unknown_response"],
    [
      { method: "future/notification", params: {} },
      "codex_rpc_invalid_notification",
    ],
    [
      { method: "turn/started", params: {}, extra: true },
      "codex_rpc_invalid_notification",
    ],
  ])(
    "invalidates malformed or uncorrelated input %#",
    async (frame, reason) => {
      const { client, transport } = createClient();
      transport.emit(frame);
      await expect(client.closed).resolves.toMatchObject({ reason });
    },
  );

  it("does not expose protocol invalidation as closed until transport cleanup settles", async () => {
    const transport = new FakeFramedTransport(scope);
    transport.delayCleanup();
    const { client } = createClient({ transport });
    let settled = false;
    void client.closed.then(() => {
      settled = true;
    });

    transport.emit({ jsonrpc: "2.0", method: "turn/started", params: {} });
    await vi.waitFor(() => {
      expect(transport.cleanupPending()).toBe(true);
    });
    expect(settled).toBe(false);

    transport.finishCleanup({ reason: "codex_rpc_invalid_envelope" });
    await expect(client.closed).resolves.toMatchObject({
      reason: "codex_rpc_invalid_envelope",
    });
  });

  it("rejects explicit close when transport cleanup reports an orphan", async () => {
    const transport = new FakeFramedTransport(scope);
    transport.delayCleanup();
    const { client } = createClient({ transport });
    const closing = client.close("test_close");
    await vi.waitFor(() => {
      expect(transport.cleanupPending()).toBe(true);
    });
    transport.finishCleanup({
      reason: "orphaned_process_group",
      cause: new Error("codex_owned_stdio_process_group_survived"),
    });

    await expect(closing).rejects.toThrow("orphaned_process_group");
    await expect(client.closed).resolves.toMatchObject({
      reason: "orphaned_process_group",
    });
  });

  it("evicts old settled request tombstones and stays usable beyond the bound", async () => {
    const { client, transport } = createClient({
      limits: { maxTombstones: 2 },
    });
    for (let index = 0; index < 8; index += 1) {
      const value = `value-${index}`;
      const request = client.request(
        echoMethod,
        { value },
        { timeoutMilliseconds: 1_000 },
      );
      await waitForWrites(transport, index + 1);
      transport.emit({
        id: parsedWrite(transport, index).id,
        result: { value },
      });
      await expect(request).resolves.toBe(value);
    }
    expect(
      await client
        .request(
          echoMethod,
          { value: "still-open" },
          {
            timeoutMilliseconds: 1_000,
            signal: AbortSignal.abort(),
          },
        )
        .catch((error: unknown) => error),
    ).toMatchObject({ delivery: "not_sent" });
  });

  it("fails closed when tombstone capacity contains only unresolved late responses", async () => {
    const { client, transport } = createClient({
      limits: { maxTombstones: 2 },
    });
    for (let index = 0; index < 3; index += 1) {
      const request = client.request(
        echoMethod,
        { value: `late-${index}` },
        { timeoutMilliseconds: 1 },
      );
      await waitForWrites(transport, index + 1);
      await expect(request).rejects.toMatchObject({
        delivery: "sent_outcome_unknown",
      });
    }
    await expect(client.closed).resolves.toMatchObject({
      reason: "codex_rpc_request_tombstone_capacity_exceeded",
    });
  });

  it("rejects oversized and dishonest frame bounds before parsing", async () => {
    const { client, transport } = createClient({
      limits: { maxFrameBytes: 16 },
    });
    transport.emitText("{}", 3);
    await expect(client.closed).resolves.toMatchObject({
      reason: "codex_rpc_inbound_frame_size_invalid",
    });
  });
});
