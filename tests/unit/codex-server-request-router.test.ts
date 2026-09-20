import { describe, expect, it, vi } from "vitest";
import {
  CodexServerRequestRouter,
  CodexServerRequestRoutingError,
  type CodexRoutedServerRequest,
  type CodexServerRequestRoute,
} from "../../src/server/backends/codex/codex-server-request-router.js";
import type {
  CodexInboundServerRequest,
  CodexServerRequestHandler,
  CodexServerRequestHandlers,
} from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import {
  CODEX_SERVER_REQUEST_METHODS,
  type CodexServerRequestMethod,
} from "../../src/server/backends/codex/rpc/protocol.js";
import { decodeCodexServerRequestParams } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

const requestParams = {
  "account/chatgptAuthTokens/refresh": {
    reason: "unauthorized",
    previousAccountId: null,
  },
  applyPatchApproval: {
    conversationId: "thread-1",
    callId: "legacy-file",
    fileChanges: {},
    reason: null,
    grantRoot: null,
  },
  "attestation/generate": {},
  execCommandApproval: {
    conversationId: "thread-1",
    callId: "legacy-command",
    approvalId: null,
    command: ["pwd"],
    cwd: "/workspace",
    reason: null,
    parsedCmd: [],
  },
  "item/commandExecution/requestApproval": {
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-command",
    startedAtMs: 1,
    environmentId: null,
  },
  "item/fileChange/requestApproval": {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-file",
    startedAtMs: 2,
  },
  "item/permissions/requestApproval": {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-permissions",
    environmentId: null,
    startedAtMs: 3,
    cwd: "/workspace",
    reason: null,
    permissions: { network: null, fileSystem: null },
  },
  "item/tool/call": {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-tool",
    namespace: "sedes",
    tool: "future_sedes_tool",
    arguments: {},
  },
  "item/tool/requestUserInput": {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-input",
    questions: [],
    isBlocking: true,
  },
  "mcpServer/elicitation/request": {
    threadId: "thread-1",
    turnId: null,
    serverName: "provider",
    mode: "url",
    _meta: null,
    message: "Authenticate",
    url: "https://example.test",
    elicitationId: "elicitation-1",
  },
} as const satisfies Record<CodexServerRequestMethod, unknown>;

function request(
  method: CodexServerRequestMethod,
  generation = 1,
): CodexInboundServerRequest {
  return {
    generation,
    sequence: 1,
    id: `${generation}:${method}`,
    method,
    params: decodeCodexServerRequestParams(method, requestParams[method]),
    signal: new AbortController().signal,
  };
}

function handler(
  handlers: CodexServerRequestHandlers,
  method: CodexServerRequestMethod,
): CodexServerRequestHandler {
  const selected = handlers[method] as CodexServerRequestHandler | undefined;
  if (!selected) throw new Error(`missing handler ${method}`);
  return selected;
}

describe("CodexServerRequestRouter", () => {
  it("installs every handler, rejects unsupported surfaces, and fences unowned conversations", async () => {
    const router = new CodexServerRequestRouter();
    router.activateGeneration(1);
    const handlers = router.handlersForGeneration(1);
    expect(Object.keys(handlers)).toEqual(CODEX_SERVER_REQUEST_METHODS);

    await expect(
      handler(
        handlers,
        "account/chatgptAuthTokens/refresh",
      )(request("account/chatgptAuthTokens/refresh")),
    ).rejects.toMatchObject({
      code: "codex_server_request_account_refresh_unavailable",
    });
    await expect(
      handler(
        handlers,
        "attestation/generate",
      )(request("attestation/generate")),
    ).rejects.toMatchObject({
      code: "codex_server_request_attestation_unavailable",
    });
    await expect(
      handler(handlers, "item/tool/call")(request("item/tool/call")),
    ).resolves.toEqual({ contentItems: [], success: false });

    for (const method of [
      "applyPatchApproval",
      "execCommandApproval",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
    ] as const) {
      await expect(
        handler(handlers, method)(request(method)),
      ).rejects.toMatchObject({
        code: "codex_server_request_thread_unowned",
      });
    }
  });

  it("requires one generation-qualified thread lease to prove turn and item identity", async () => {
    const router = new CodexServerRequestRouter();
    router.activateGeneration(4);
    const seen: CodexRoutedServerRequest[] = [];
    const lease = router.claimThread({
      generation: 4,
      nativeThreadId: "thread-1",
      owner: {
        owns: (route) =>
          route.nativeThreadId === "thread-1" &&
          route.nativeTurnId === "turn-1" &&
          route.nativeItemId === "item-command",
        handle: (incoming) => {
          seen.push(incoming);
          return { decision: "accept" };
        },
      },
    });
    expect(router.ownerCount()).toBe(1);
    expect(() =>
      router.claimThread({
        generation: 4,
        nativeThreadId: "thread-1",
        owner: {
          owns: () => true,
          handle: () => ({ decision: "decline" }),
        },
      }),
    ).toThrow("codex_server_request_thread_already_owned");

    const handlers = router.handlersForGeneration(4);
    await expect(
      handler(
        handlers,
        "item/commandExecution/requestApproval",
      )(request("item/commandExecution/requestApproval", 4)),
    ).resolves.toEqual({ decision: "accept" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.route).toEqual({
      nativeThreadId: "thread-1",
      nativeTurnId: "turn-1",
      nativeItemId: "item-command",
    });

    await expect(
      handler(
        handlers,
        "item/fileChange/requestApproval",
      )(request("item/fileChange/requestApproval", 4)),
    ).rejects.toMatchObject({
      code: "codex_server_request_native_identity_unowned",
    });
    lease.release();
    expect(router.ownerCount()).toBe(0);
  });

  it("preserves legacy command approval correlation on the owned thread route", async () => {
    const router = new CodexServerRequestRouter();
    router.activateGeneration(5);
    const routes: CodexServerRequestRoute[] = [];
    router.claimThread({
      generation: 5,
      nativeThreadId: "thread-1",
      owner: {
        owns: (route) => {
          routes.push(route);
          return true;
        },
        handle: () => ({ decision: "approved" }),
      },
    });

    await expect(
      handler(
        router.handlersForGeneration(5),
        "execCommandApproval",
      )({
        ...request("execCommandApproval", 5),
        params: decodeCodexServerRequestParams("execCommandApproval", {
          ...requestParams.execCommandApproval,
          approvalId: "legacy-approval",
        }),
      }),
    ).resolves.toEqual({ decision: "approved" });
    expect(routes).toHaveLength(2);
    expect(routes).toEqual(
      routes.map(() => ({
        nativeThreadId: "thread-1",
        nativeCallId: "legacy-command",
        nativeApprovalId: "legacy-approval",
      })),
    );
  });

  it("preserves write-stdin approval correlation on the owned thread route", async () => {
    const router = new CodexServerRequestRouter();
    router.activateGeneration(6);
    const routes: CodexServerRequestRoute[] = [];
    router.claimThread({
      generation: 6,
      nativeThreadId: "thread-1",
      owner: {
        owns: (route) => {
          routes.push(route);
          return true;
        },
        handle: () => ({ decision: "accept" }),
      },
    });

    await expect(
      handler(
        router.handlersForGeneration(6),
        "item/commandExecution/requestApproval",
      )({
        ...request("item/commandExecution/requestApproval", 6),
        params: decodeCodexServerRequestParams(
          "item/commandExecution/requestApproval",
          {
            ...requestParams["item/commandExecution/requestApproval"],
            kind: "writeStdin",
            approvalId: "stdin-approval",
            environmentId: "environment-1",
            reason: "Terminal input needs broader permissions",
            command: "write_stdin --session-id 42 confirm",
            cwd: "/workspace",
            commandActions: [
              {
                type: "unknown",
                command: "write_stdin --session-id 42 confirm",
              },
            ],
            availableDecisions: ["accept", "cancel"],
          },
        ),
      }),
    ).resolves.toEqual({ decision: "accept" });
    expect(routes).toHaveLength(2);
    expect(routes).toEqual(
      routes.map(() => ({
        nativeThreadId: "thread-1",
        nativeTurnId: "turn-1",
        nativeItemId: "item-command",
        nativeApprovalId: "stdin-approval",
      })),
    );
  });

  it("validates an owner's response before returning it to RPC", async () => {
    const router = new CodexServerRequestRouter();
    router.activateGeneration(2);
    router.claimThread({
      generation: 2,
      nativeThreadId: "thread-1",
      owner: {
        owns: () => true,
        handle: () => ({
          decision: "accept",
          providerOnly: "must not cross",
        }),
      },
    });
    await expect(
      handler(
        router.handlersForGeneration(2),
        "item/commandExecution/requestApproval",
      )(request("item/commandExecution/requestApproval", 2)),
    ).rejects.toThrow();
  });

  it("aborts pending routes and prevents late results after generation replacement", async () => {
    const router = new CodexServerRequestRouter();
    router.activateGeneration(7);
    let resolve!: (value: { decision: "accept" }) => void;
    const pendingHandler = vi.fn(
      (incoming: CodexRoutedServerRequest) =>
        new Promise<{ decision: "accept" }>((accept) => {
          expect(incoming.signal.aborted).toBe(false);
          resolve = accept;
        }),
    );
    router.claimThread({
      generation: 7,
      nativeThreadId: "thread-1",
      owner: {
        owns: () => true,
        handle: pendingHandler,
      },
    });
    const pending = handler(
      router.handlersForGeneration(7),
      "item/commandExecution/requestApproval",
    )(request("item/commandExecution/requestApproval", 7));
    await vi.waitFor(() => expect(pendingHandler).toHaveBeenCalledOnce());

    router.activateGeneration(8);
    await expect(pending).rejects.toMatchObject({
      code: "codex_server_request_generation_replaced",
    });
    expect(router.ownerCount()).toBe(0);
    resolve({ decision: "accept" });
    await Promise.resolve();

    await expect(
      handler(
        router.handlersForGeneration(7),
        "item/commandExecution/requestApproval",
      )(request("item/commandExecution/requestApproval", 7)),
    ).rejects.toMatchObject({
      code: "codex_server_request_stale_generation",
    });
  });

  it("aborts an in-flight route when its ownership lease is released", async () => {
    const router = new CodexServerRequestRouter();
    router.activateGeneration(9);
    const entered = vi.fn();
    const lease = router.claimThread({
      generation: 9,
      nativeThreadId: "thread-1",
      owner: {
        owns: (_route: CodexServerRequestRoute) => true,
        handle: (incoming) =>
          new Promise((_resolve, reject) => {
            entered();
            incoming.signal.addEventListener(
              "abort",
              () => reject(incoming.signal.reason),
              { once: true },
            );
          }),
      },
    });
    const pending = handler(
      router.handlersForGeneration(9),
      "item/tool/requestUserInput",
    )(request("item/tool/requestUserInput", 9));
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    lease.release("codex_interaction_owner_detached");
    await expect(pending).rejects.toMatchObject({
      code: "codex_interaction_owner_detached",
    });
  });

  it("rejects malformed owned requests before consulting the lease", async () => {
    const router = new CodexServerRequestRouter();
    router.activateGeneration(3);
    const owns = vi.fn(() => true);
    router.claimThread({
      generation: 3,
      nativeThreadId: "thread-1",
      owner: { owns, handle: () => ({ decision: "decline" }) },
    });
    await expect(
      handler(
        router.handlersForGeneration(3),
        "item/fileChange/requestApproval",
      )({
        ...request("item/fileChange/requestApproval", 3),
        params: decodeCodexServerRequestParams(
          "item/fileChange/requestApproval",
          {
            ...requestParams["item/fileChange/requestApproval"],
            unexpected: true,
          },
        ),
      }),
    ).rejects.toThrow();
    expect(owns).not.toHaveBeenCalled();
  });

  it("rejects invalid and non-monotonic generations", () => {
    const router = new CodexServerRequestRouter();
    expect(() => router.activateGeneration(0)).toThrow(
      CodexServerRequestRoutingError,
    );
    router.activateGeneration(2);
    expect(() => router.activateGeneration(1)).toThrow(
      "codex_server_request_generation_not_monotonic",
    );
  });
});
