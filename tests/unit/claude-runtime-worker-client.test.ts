import { afterEach, describe, expect, it, vi } from "vitest";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/index.js";
import {
  ClaudeRuntimeWorkerClient,
  type ClaudeRuntimeWorkerClientPeer,
} from "../../src/server/backends/claude/claude-runtime-worker-client.js";
import type { ClaudeRuntimeSessionOptions } from "../../src/server/backends/claude/claude-runtime-client.js";
import {
  claudeRuntimeCanUseToolOperation,
  claudeRuntimePermissionResponseAckOperation,
} from "../../src/server/backends/claude/worker/claude-runtime-v1.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const STARTUP_UUID = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.useRealTimers());

describe("ClaudeRuntimeWorkerClient query-open cleanup", () => {
  it("resolves startup secrets on the owner host before the sanitized worker initializes", async () => {
    vi.stubEnv("PROJECT_PROVIDER_SECRET", "owner-secret");
    let request: unknown;
    const peer = fakePeer(async (operation, _signal, value) => {
      expect(operation).toBe("runtime.initialize"); request = value;
      return { initialized: true, configDirectory: "/config" };
    });
    const client = new ClaudeRuntimeWorkerClient({ peer, hostRegistry: new SidecarOperationRegistry(),
      executablePath: "/bin/claude", configDirectory: "/config", initializationTimeoutMs: 1_000,
      startupEnvironmentVariables: { PROVIDER_KEY: { kind: "secret", source: { kind: "environment", name: "PROJECT_PROVIDER_SECRET" } }, REMOVED: { kind: "unset" } },
    });
    try {
      await client.initialize();
      expect(request).toMatchObject({ startupEnvironment: { PROVIDER_KEY: "owner-secret", REMOVED: null }, startupEnvironmentVariables: { PROVIDER_KEY: { kind: "secret" } } });
      expect(process.env.PROJECT_PROVIDER_SECRET).toBe("owner-secret");
    } finally { await client.close(); vi.unstubAllEnvs(); }
  });

  it("commits a permission response only through an exact worker ACK", async () => {
    const registry = new SidecarOperationRegistry();
    const deliveredGate = deferred<void>();
    const delivered = vi.fn(async () => await deliveredGate.promise);
    let queryId = "";
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      throw new Error(`unexpected:${operation}`);
    });
    const client = new ClaudeRuntimeWorkerClient({
      peer,
      hostRegistry: registry,
      executablePath: "/bin/claude",
      configDirectory: "/config",
      initializationTimeoutMs: 1_000,
    });
    const session = client.createSession(
      sessionOptions({
        canUseTool: vi.fn(async () => ({
          behavior: "allow" as const,
          toolUseID: "tool-1",
          decisionClassification: "user_temporary" as const,
        })),
        onPermissionResponseDelivered: delivered,
      }),
    );
    await session.start();
    const canUseTool = registry.resolve(claudeRuntimeCanUseToolOperation)!
      .handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const acknowledge = registry.resolve(
      claudeRuntimePermissionResponseAckOperation,
    )!.handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;

    await expect(
      canUseTool(
        {
          queryId,
          toolName: "Read",
          input: {},
          options: {
            requestId: "permission-1",
            toolUseID: "tool-1",
          },
        },
        operationContext(),
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(delivered).not.toHaveBeenCalled();
    await expect(
      acknowledge(
        {
          queryId,
          requestId: "permission-1",
          toolUseID: "wrong-tool",
          adopted: true,
        },
        operationContext(),
      ),
    ).rejects.toThrow("claude_permission_response_ack_unmatched");

    const acknowledged = acknowledge(
      {
        queryId,
        requestId: "permission-1",
        toolUseID: "tool-1",
        adopted: true,
      },
      operationContext(),
    );
    let settled = false;
    void acknowledged.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    await expect(
      acknowledge(
        {
          queryId,
          requestId: "permission-1",
          toolUseID: "tool-1",
          adopted: false,
        },
        operationContext(),
      ),
    ).rejects.toThrow("claude_permission_response_ack_already_committing");
    deliveredGate.resolve();
    await expect(acknowledged).resolves.toEqual({ acknowledged: true });
  });

  it("rejects a prompt mutation promptly when Claude reports it was not adopted", async () => {
    const registry = new SidecarOperationRegistry();
    const failedGate = deferred<void>();
    const deliveryFailed = vi.fn(async () => await failedGate.promise);
    let queryId = "";
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      if (operation === "query.close") return { closed: true };
      throw new Error(`unexpected:${operation}`);
    });
    const client = new ClaudeRuntimeWorkerClient({
      peer,
      hostRegistry: registry,
      executablePath: "/bin/claude",
      configDirectory: "/config",
      initializationTimeoutMs: 1_000,
    });
    const session = client.createSession(
      sessionOptions({
        canUseTool: vi.fn(async () => ({
          behavior: "allow" as const,
          toolUseID: "tool-1",
          decisionClassification: "user_temporary" as const,
        })),
        onPermissionResponseDeliveryFailed: deliveryFailed,
      }),
    );
    await session.start();
    const canUseTool = registry.resolve(claudeRuntimeCanUseToolOperation)!
      .handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const acknowledge = registry.resolve(
      claudeRuntimePermissionResponseAckOperation,
    )!.handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const identity = {
      queryId,
      requestId: "permission-not-adopted",
      toolUseID: "tool-1",
    };
    await canUseTool(
      {
        queryId,
        toolName: "Read",
        input: {},
        options: {
          requestId: identity.requestId,
          toolUseID: identity.toolUseID,
        },
      },
      operationContext(),
    );

    await expect(
      acknowledge(
        { ...identity, toolUseID: "wrong-tool", adopted: false },
        operationContext(),
      ),
    ).rejects.toThrow("claude_permission_response_ack_unmatched");
    const rejected = acknowledge(
      { ...identity, adopted: false },
      operationContext(),
    );
    await vi.waitFor(() => expect(deliveryFailed).toHaveBeenCalledOnce());
    let ackSettled = false;
    void rejected.then(() => {
      ackSettled = true;
    });
    await Promise.resolve();
    expect(ackSettled).toBe(false);
    failedGate.resolve();
    await expect(rejected).resolves.toEqual({ acknowledged: true });
    await expect(session.close()).resolves.toBeUndefined();
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("accepts static no-session deny ACKs without fencing the generation", async () => {
    const registry = new SidecarOperationRegistry();
    const peer = fakePeer(async () => {
      throw new Error("unexpected_outbound_call");
    });
    new ClaudeRuntimeWorkerClient({
      peer,
      hostRegistry: registry,
      executablePath: "/bin/claude",
      configDirectory: "/config",
      initializationTimeoutMs: 1_000,
    });
    const canUseTool = registry.resolve(claudeRuntimeCanUseToolOperation)!
      .handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const acknowledge = registry.resolve(
      claudeRuntimePermissionResponseAckOperation,
    )!.handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const identity = {
      queryId: "99999999-9999-4999-8999-999999999999",
      requestId: "permission-static-deny",
      toolUseID: "tool-static",
    };

    await expect(
      canUseTool(
        {
          queryId: identity.queryId,
          toolName: "Read",
          input: {},
          options: {
            requestId: identity.requestId,
            toolUseID: identity.toolUseID,
          },
        },
        operationContext(),
      ),
    ).resolves.toMatchObject({ behavior: "deny" });
    await expect(
      acknowledge({ ...identity, adopted: true }, operationContext()),
    ).resolves.toEqual({ acknowledged: true });
    await expect(
      acknowledge(
        { ...identity, requestId: "never-recorded", adopted: false },
        operationContext(),
      ),
    ).resolves.toEqual({ acknowledged: true });
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("rejects a negative ACK when bridge failure settlement cannot complete", async () => {
    const registry = new SidecarOperationRegistry();
    let queryId = "";
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      throw new Error(`unexpected:${operation}`);
    });
    const client = new ClaudeRuntimeWorkerClient({
      peer,
      hostRegistry: registry,
      executablePath: "/bin/claude",
      configDirectory: "/config",
      initializationTimeoutMs: 1_000,
    });
    const session = client.createSession(
      sessionOptions({
        canUseTool: vi.fn(async () => ({
          behavior: "allow" as const,
          toolUseID: "tool-1",
          decisionClassification: "user_temporary" as const,
        })),
        onPermissionResponseDeliveryFailed: vi.fn(async () => {
          throw new Error("bridge_settlement_failed");
        }),
      }),
    );
    await session.start();
    const canUseTool = registry.resolve(claudeRuntimeCanUseToolOperation)!
      .handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const acknowledge = registry.resolve(
      claudeRuntimePermissionResponseAckOperation,
    )!.handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const identity = {
      queryId,
      requestId: "permission-failure-rejected",
      toolUseID: "tool-1",
    };
    await canUseTool(
      {
        queryId,
        toolName: "Read",
        input: {},
        options: {
          requestId: identity.requestId,
          toolUseID: identity.toolUseID,
        },
      },
      operationContext(),
    );

    await expect(
      acknowledge({ ...identity, adopted: false }, operationContext()),
    ).rejects.toThrow("bridge_settlement_failed");
    client.close();
  });

  it("keeps a closing session addressable until its exact permission ACK commits", async () => {
    const registry = new SidecarOperationRegistry();
    const calls: string[] = [];
    let queryId = "";
    const delivered = vi.fn();
    const peer = fakePeer(async (operation, _signal, request) => {
      calls.push(operation);
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      if (operation === "query.close") return { closed: true };
      throw new Error(`unexpected:${operation}`);
    });
    const client = new ClaudeRuntimeWorkerClient({
      peer,
      hostRegistry: registry,
      executablePath: "/bin/claude",
      configDirectory: "/config",
      initializationTimeoutMs: 1_000,
    });
    const session = client.createSession(
      sessionOptions({
        canUseTool: vi.fn(async () => ({
          behavior: "allow" as const,
          toolUseID: "tool-1",
          decisionClassification: "user_temporary" as const,
        })),
        onPermissionResponseDelivered: delivered,
      }),
    );
    await session.start();
    const canUseTool = registry.resolve(claudeRuntimeCanUseToolOperation)!
      .handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const acknowledge = registry.resolve(
      claudeRuntimePermissionResponseAckOperation,
    )!.handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const identity = {
      queryId,
      requestId: "permission-close-race",
      toolUseID: "tool-1",
    };
    await canUseTool(
      {
        ...identity,
        toolName: "Read",
        input: {},
        options: {
          requestId: identity.requestId,
          toolUseID: identity.toolUseID,
        },
      },
      operationContext(),
    );

    const closing = session.close();
    await Promise.resolve();
    expect(calls).not.toContain("query.close");
    await expect(
      acknowledge({ ...identity, adopted: true }, operationContext()),
    ).resolves.toEqual({
      acknowledged: true,
    });
    await closing;

    expect(delivered).toHaveBeenCalledWith({
      requestId: identity.requestId,
      toolUseID: identity.toolUseID,
    });
    expect(calls).toContain("query.close");
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("drains a permission response that wins while remote close is in flight", async () => {
    const registry = new SidecarOperationRegistry();
    const permission = deferred<{
      behavior: "allow";
      toolUseID: string;
      decisionClassification: "user_temporary";
    }>();
    const remoteClose = deferred<void>();
    let queryId = "";
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      if (operation === "query.close") {
        await remoteClose.promise;
        return { closed: true };
      }
      throw new Error(`unexpected:${operation}`);
    });
    const client = new ClaudeRuntimeWorkerClient({
      peer,
      hostRegistry: registry,
      executablePath: "/bin/claude",
      configDirectory: "/config",
      initializationTimeoutMs: 1_000,
    });
    const session = client.createSession(
      sessionOptions({
        canUseTool: vi.fn(async () => await permission.promise),
      }),
    );
    await session.start();
    const canUseTool = registry.resolve(claudeRuntimeCanUseToolOperation)!
      .handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const acknowledge = registry.resolve(
      claudeRuntimePermissionResponseAckOperation,
    )!.handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const identity = {
      queryId,
      requestId: "permission-during-close",
      toolUseID: "tool-1",
    };
    const response = canUseTool(
      {
        ...identity,
        toolName: "Read",
        input: {},
        options: {
          requestId: identity.requestId,
          toolUseID: identity.toolUseID,
        },
      },
      operationContext(),
    );

    const closing = session.close();
    await vi.waitFor(() =>
      expect(peer.call).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "query.close" }),
        { queryId },
        undefined,
      ),
    );
    permission.resolve({
      behavior: "allow",
      toolUseID: "tool-1",
      decisionClassification: "user_temporary",
    });
    await expect(response).resolves.toMatchObject({ behavior: "allow" });
    remoteClose.resolve();
    await Promise.resolve();
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    await expect(
      acknowledge({ ...identity, adopted: true }, operationContext()),
    ).resolves.toEqual({
      acknowledged: true,
    });
    await closing;
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("fails and fences a permission response whose ACK remains uncertain at close", async () => {
    vi.useFakeTimers();
    const registry = new SidecarOperationRegistry();
    let queryId = "";
    const deliveryFailed = vi.fn();
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      if (operation === "query.close") return { closed: true };
      throw new Error(`unexpected:${operation}`);
    });
    const client = new ClaudeRuntimeWorkerClient({
      peer,
      hostRegistry: registry,
      executablePath: "/bin/claude",
      configDirectory: "/config",
      initializationTimeoutMs: 1_000,
    });
    const session = client.createSession(
      sessionOptions({
        canUseTool: vi.fn(async () => ({
          behavior: "allow" as const,
          toolUseID: "tool-1",
          decisionClassification: "user_temporary" as const,
        })),
        onPermissionResponseDeliveryFailed: deliveryFailed,
      }),
    );
    await session.start();
    const canUseTool = registry.resolve(claudeRuntimeCanUseToolOperation)!
      .handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    await canUseTool(
      {
        queryId,
        toolName: "Read",
        input: {},
        options: {
          requestId: "permission-timeout",
          toolUseID: "tool-1",
        },
      },
      operationContext(),
    );

    const closing = session.close();
    await vi.advanceTimersByTimeAsync(30_000);
    await closing;

    expect(deliveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "permission-timeout",
        toolUseID: "tool-1",
      }),
    );
    expect(peer.close).toHaveBeenCalledWith(
      "claude_runtime_permission_ack_cleanup_unconfirmed",
    );
  });

  it("fails an unacknowledged permission response when the peer is lost", async () => {
    const registry = new SidecarOperationRegistry();
    const carrierClosed = deferred<void>();
    const deliveryFailed = vi.fn();
    let queryId = "";
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      throw new Error(`unexpected:${operation}`);
    });
    const client = new ClaudeRuntimeWorkerClient({
      peer,
      hostRegistry: registry,
      executablePath: "/bin/claude",
      configDirectory: "/config",
      initializationTimeoutMs: 1_000,
      closed: carrierClosed.promise,
    });
    const session = client.createSession(
      sessionOptions({
        canUseTool: vi.fn(async () => ({
          behavior: "allow" as const,
          toolUseID: "tool-1",
          decisionClassification: "user_temporary" as const,
        })),
        onPermissionResponseDeliveryFailed: deliveryFailed,
      }),
    );
    await session.start();
    const canUseTool = registry.resolve(claudeRuntimeCanUseToolOperation)!
      .handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    await canUseTool(
      {
        queryId,
        toolName: "Read",
        input: {},
        options: {
          requestId: "permission-peer-loss",
          toolUseID: "tool-1",
        },
      },
      operationContext(),
    );

    carrierClosed.resolve();
    await vi.waitFor(() => expect(deliveryFailed).toHaveBeenCalledOnce());
    expect(deliveryFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "permission-peer-loss",
        toolUseID: "tool-1",
      }),
    );
    await session.close();
  });

  it("does not record an ACK expectation after the reverse caller cancels", async () => {
    const registry = new SidecarOperationRegistry();
    let queryId = "";
    const permission = deferred<{
      behavior: "allow";
      toolUseID: string;
      decisionClassification: "user_temporary";
    }>();
    const deliveryFailed = vi.fn();
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      if (operation === "query.close") return { closed: true };
      throw new Error(`unexpected:${operation}`);
    });
    const client = new ClaudeRuntimeWorkerClient({
      peer,
      hostRegistry: registry,
      executablePath: "/bin/claude",
      configDirectory: "/config",
      initializationTimeoutMs: 1_000,
    });
    const session = client.createSession(
      sessionOptions({
        canUseTool: vi.fn(async () => await permission.promise),
        onPermissionResponseDeliveryFailed: deliveryFailed,
      }),
    );
    await session.start();
    const canUseTool = registry.resolve(claudeRuntimeCanUseToolOperation)!
      .handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const acknowledge = registry.resolve(
      claudeRuntimePermissionResponseAckOperation,
    )!.handler as never as (
      request: unknown,
      context: ReturnType<typeof operationContext>,
    ) => Promise<unknown>;
    const controller = new AbortController();
    const identity = {
      queryId,
      requestId: "permission-cancelled",
      toolUseID: "tool-1",
    };
    const response = canUseTool(
      {
        ...identity,
        toolName: "Read",
        input: {},
        options: {
          requestId: identity.requestId,
          toolUseID: identity.toolUseID,
        },
      },
      operationContext(controller.signal),
    );
    controller.abort(new Error("reverse_request_cancelled"));
    permission.resolve({
      behavior: "allow",
      toolUseID: "tool-1",
      decisionClassification: "user_temporary",
    });

    await expect(response).rejects.toThrow("reverse_request_cancelled");
    await expect(
      acknowledge({ ...identity, adopted: false }, operationContext()),
    ).resolves.toEqual({ acknowledged: true });
    expect(deliveryFailed).toHaveBeenCalledOnce();
    await session.close();
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("best-effort closes a remote query after post-open validation fails", async () => {
    const calls: string[] = [];
    const peer = fakePeer(async (operation) => {
      calls.push(operation);
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") return openedResponse("invalid");
      if (operation === "query.close") return { closed: true };
      throw new Error(`unexpected:${operation}`);
    });
    const client = clientFor(peer);
    const session = client.createSession(sessionOptions());

    await expect(session.start()).rejects.toThrow(
      "claude_runtime_query_identity_mismatch",
    );

    expect(calls).toEqual(["runtime.initialize", "query.open", "query.close"]);
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("closes a query when close races an in-flight open", async () => {
    const calls: string[] = [];
    const peer = fakePeer(async (operation, signal) => {
      calls.push(operation);
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        return await new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          });
        });
      }
      if (operation === "query.close") return { closed: true };
      throw new Error(`unexpected:${operation}`);
    });
    const client = clientFor(peer);
    const session = client.createSession(sessionOptions());
    const started = session.start();
    const rejected = expect(started).rejects.toThrow(
      "claude_runtime_session_closed",
    );
    await vi.waitFor(() => expect(calls).toContain("query.open"));

    await session.close();
    await rejected;

    expect(
      calls.filter((operation) => operation === "query.close"),
    ).toHaveLength(1);
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("fences the peer when cleanup after an indeterminate open cannot be confirmed", async () => {
    const peer = fakePeer(async (operation) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") return openedResponse("invalid");
      if (operation === "query.close") throw new Error("transport_closed");
      throw new Error(`unexpected:${operation}`);
    });
    const client = clientFor(peer);
    const session = client.createSession(sessionOptions());

    await expect(session.start()).rejects.toThrow(
      "claude_runtime_query_identity_mismatch",
    );

    expect(peer.close).toHaveBeenCalledWith(
      "claude_runtime_query_open_cleanup_unconfirmed",
    );
  });

  it("retries runtime initialization after a shared attempt rejects", async () => {
    let initializationCalls = 0;
    const peer = fakePeer(async (operation) => {
      if (operation !== "runtime.initialize")
        throw new Error(`unexpected:${operation}`);
      initializationCalls += 1;
      if (initializationCalls === 1) throw new Error("temporary_failure");
      return { initialized: true, configDirectory: "/config" };
    });
    const client = clientFor(peer);

    const first = client.initialize();
    const concurrent = client.initialize();
    await expect(first).rejects.toThrow("temporary_failure");
    await expect(concurrent).rejects.toThrow("temporary_failure");
    expect(initializationCalls).toBe(1);
    await expect(client.initialize()).resolves.toBeUndefined();
    expect(initializationCalls).toBe(2);
  });

  it("best-effort closes a failed query and close waits for that cleanup", async () => {
    const cleanup = deferred<void>();
    let queryId = "";
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      if (operation === "query.close") {
        await cleanup.promise;
        return { closed: true };
      }
      throw new Error(`unexpected:${operation}`);
    });
    const client = clientFor(peer);
    const session = client.createSession(
      sessionOptions({
        onMessage: async () => {
          throw new Error("message_delivery_failed");
        },
      }),
    );
    await session.start();

    peer.emit("query.message", {
      queryId,
      message: { type: "assistant" },
    });
    const closed = session.close();
    let settled = false;
    void closed.then(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(peer.call).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "query.close" }),
        { queryId },
        undefined,
      ),
    );
    expect(settled).toBe(false);
    cleanup.resolve();
    await closed;
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("fences a healthy peer when failed-query cleanup cannot be confirmed", async () => {
    let queryId = "";
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      if (operation === "query.close") throw new Error("cleanup_failed");
      throw new Error(`unexpected:${operation}`);
    });
    const client = clientFor(peer);
    const session = client.createSession(
      sessionOptions({
        onMessage: async () => {
          throw new Error("message_delivery_failed");
        },
      }),
    );
    await session.start();

    peer.emit("query.message", {
      queryId,
      message: { type: "assistant" },
    });
    await vi.waitFor(() =>
      expect(peer.close).toHaveBeenCalledWith(
        "claude_runtime_query_failure_cleanup_unconfirmed",
      ),
    );
  });

  it("does not re-close a query after its remote failure", async () => {
    let queryId = "";
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      throw new Error(`unexpected:${operation}`);
    });
    const client = clientFor(peer);
    const session = client.createSession(sessionOptions());
    await session.start();

    peer.emit("query.failed", {
      queryId,
      code: "claude_runtime_query_failed",
    });
    await vi.waitFor(() => expect(session.closed).toBe(true));
    await session.close();
    expect(
      vi
        .mocked(peer.call)
        .mock.calls.some(
          ([definition]) => definition.operation === "query.close",
        ),
    ).toBe(false);
    expect(peer.close).not.toHaveBeenCalled();
  });

  it("does not send cleanup over a peer whose carrier already closed", async () => {
    const carrierClosed = deferred<void>();
    let queryId = "";
    const peer = fakePeer(async (operation, _signal, request) => {
      if (operation === "runtime.initialize") {
        return { initialized: true, configDirectory: "/config" };
      }
      if (operation === "query.open") {
        queryId = (request as { queryId: string }).queryId;
        return openedResponse("2.1.274", queryId);
      }
      throw new Error(`unexpected:${operation}`);
    });
    const client = new ClaudeRuntimeWorkerClient({
      peer,
      hostRegistry: new SidecarOperationRegistry(),
      executablePath: "/bin/claude",
      configDirectory: "/config",
      initializationTimeoutMs: 1_000,
      closed: carrierClosed.promise,
    });
    const session = client.createSession(sessionOptions());
    await session.start();

    carrierClosed.resolve();
    await vi.waitFor(() => expect(session.closed).toBe(true));
    await session.close();
    expect(
      vi
        .mocked(peer.call)
        .mock.calls.some(
          ([definition]) => definition.operation === "query.close",
        ),
    ).toBe(false);
    expect(queryId).not.toBe("");
  });
});

function clientFor(peer: ClaudeRuntimeWorkerClientPeer) {
  return new ClaudeRuntimeWorkerClient({
    peer,
    hostRegistry: new SidecarOperationRegistry(),
    executablePath: "/bin/claude",
    configDirectory: "/config",
    initializationTimeoutMs: 1_000,
  });
}

function sessionOptions(
  overrides: Partial<ClaudeRuntimeSessionOptions> = {},
): ClaudeRuntimeSessionOptions {
  return {
    executablePath: "/bin/claude",
    initializationTimeoutMs: 1_000,
    sessionId: SESSION_ID,
    cwd: "/workspace",
    launch: "new" as const,
    environment: {},
    onMessage: vi.fn(),
    ...overrides,
  };
}

function openedResponse(
  cliRelease: string,
  queryId = "33333333-3333-4333-8333-333333333333",
) {
  return {
    queryId,
    startupProbeUuid: STARTUP_UUID,
    initialization: {
      models: [],
      commands: [],
      skillNames: [],
      terminalCommandNames: [],
      account: {},
      actualPermissionMode: "default",
      cliRelease,
    },
  };
}

function fakePeer(
  implementation: (
    operation: string,
    signal?: AbortSignal,
    request?: unknown,
  ) => Promise<unknown>,
): ClaudeRuntimeWorkerClientPeer & {
  readonly close: ReturnType<typeof vi.fn>;
  readonly emit: (event: string, payload: unknown) => void;
} {
  const listeners = new Map<string, (payload: never) => void>();
  return {
    call: vi.fn(
      async (definition, request, options) =>
        await implementation(definition.operation, options?.signal, request),
    ) as ClaudeRuntimeWorkerClientPeer["call"],
    onEvent: vi.fn((input) => {
      listeners.set(input.event, input.listener as (payload: never) => void);
      return () => listeners.delete(input.event);
    }) as ClaudeRuntimeWorkerClientPeer["onEvent"],
    close: vi.fn(async () => undefined),
    emit: (event, payload) => listeners.get(event)?.(payload as never),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function operationContext(signal = new AbortController().signal) {
  return {
    requestId: "test-sidecar-request",
    signal,
  };
}
