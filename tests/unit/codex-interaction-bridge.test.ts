import { describe, expect, it, vi } from "vitest";
import type { BackendConversationEvent } from "../../src/shared/protocol/backend.js";
import {
  CodexInteractionBridge,
  CodexInteractionBridgeError,
} from "../../src/server/backends/codex/codex-interaction-bridge.js";
import { CodexServerRequestRouter } from "../../src/server/backends/codex/codex-server-request-router.js";
import type {
  CodexInboundServerRequest,
  CodexServerRequestHandler,
} from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import type { CodexServerRequestMethod } from "../../src/server/backends/codex/rpc/protocol.js";
import { decodeCodexServerRequestParams } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

type InteractionEvent = Extract<
  BackendConversationEvent,
  { readonly type: "interaction_opened" | "interaction_resolved" }
>;

function request<Method extends CodexServerRequestMethod>(
  method: Method,
  id: number,
  params: unknown,
  generation = 1,
  signal: AbortSignal = new AbortController().signal,
): CodexInboundServerRequest<Method> {
  return {
    generation,
    sequence: id,
    id,
    method,
    params: decodeCodexServerRequestParams(method, params),
    signal,
  };
}

function fixture(input?: {
  readonly responseConfirmationTimeoutMilliseconds?: number;
}) {
  const router = new CodexServerRequestRouter();
  router.activateGeneration(1);
  const events: InteractionEvent[] = [];
  const bridge = new CodexInteractionBridge({
    router,
    nativeThreadId: "thread-1",
    ownsRoute: (route) =>
      route.nativeThreadId === "thread-1" &&
      (route.nativeTurnId === undefined || route.nativeTurnId === "turn-1") &&
      (route.nativeItemId === undefined ||
        route.nativeItemId.startsWith("item-")),
    emit: (event) => events.push(event),
    now: () => Date.parse("2026-07-31T00:00:00.000Z"),
    ...(input?.responseConfirmationTimeoutMilliseconds === undefined
      ? {}
      : {
          responseConfirmationTimeoutMilliseconds:
            input.responseConfirmationTimeoutMilliseconds,
        }),
  });
  bridge.activate(1);
  const handlers = router.handlersForGeneration(1);
  const invoke = (
    method: CodexServerRequestMethod,
    id: number,
    params: unknown,
    signal?: AbortSignal,
  ) => {
    const handler = handlers[method] as CodexServerRequestHandler | undefined;
    if (!handler) throw new Error(`missing handler ${method}`);
    return handler(request(method, id, params, 1, signal));
  };
  const opened = () => {
    const event = events.at(-1);
    if (event?.type !== "interaction_opened") {
      throw new Error("interaction was not opened");
    }
    return event.interaction;
  };
  return { router, bridge, events, invoke, opened };
}

describe("CodexInteractionBridge", () => {
  it("routes a structured MCP form through typed answers and confirmation", async () => {
    const current = fixture();
    const pending = current.invoke("mcpServer/elicitation/request", 401, {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "test",
      mode: "form",
      _meta: null,
      message: "Choose settings",
      requestedSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          count: { type: "integer", minimum: 0 },
          region: {
            type: "string",
            oneOf: [{ const: "us-east", title: "East" }],
          },
        },
        required: ["enabled", "count", "region"],
      },
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    expect(interaction.kind).toBe("form");
    expect(() =>
      current.bridge.respond({
        applicationOperationId: "invalid",
        interactionId: interaction.backendInteractionId,
        kind: "form",
        answers: [],
      }),
    ).toThrow();
    const confirmation = current.bridge.respond({
      applicationOperationId: "valid",
      interactionId: interaction.backendInteractionId,
      kind: "form",
      answers: [
        { fieldId: "field:0", value: false },
        { fieldId: "field:1", value: 0 },
        { fieldId: "field:2", value: "field:2:option:0" },
      ],
    });
    await expect(pending).resolves.toEqual({
      action: "accept",
      content: { enabled: false, count: 0, region: "us-east" },
      _meta: null,
    });
    current.bridge.observeProviderResolved(1, 401);
    await confirmation;
  });

  it("keeps overlapping MCP approval arguments on their exact requests and out of responses", async () => {
    const current = fixture();
    const invoke = (id: number, query: string) =>
      current.invoke("mcpServer/elicitation/request", id, {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "search",
        mode: "form",
        message: "Allow search?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_params: {
            query,
            nested: { access_token: "secret-value" },
          },
        },
      });
    const first = invoke(201, "first query");
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const firstInteraction = current.opened();
    const second = invoke(202, "second query");
    await vi.waitFor(() => expect(current.events).toHaveLength(2));
    const secondInteraction = current.opened();
    for (const [interaction, query] of [
      [firstInteraction, "first query"],
      [secondInteraction, "second query"],
    ] as const) {
      expect(interaction).toMatchObject({
        kind: "confirmation",
        confirmLabel: { text: "Allow" },
        cancelLabel: { text: "Cancel" },
        invocation: {
          arguments: {
            kind: "object",
            entries: [
              { key: { text: "query" }, value: { text: query } },
              {
                key: { text: "nested" },
                value: {
                  kind: "object",
                  entries: [
                    {
                      key: { text: "access_token" },
                      value: { kind: "redacted", reason: "sensitive_key" },
                    },
                  ],
                },
              },
            ],
          },
        },
      });
      expect(JSON.stringify(interaction)).not.toContain("secret-value");
      expect(JSON.stringify(interaction)).not.toContain("codex_approval_kind");
    }
    const secondConfirmation = current.bridge.respond({
      applicationOperationId: "second",
      interactionId: secondInteraction.backendInteractionId,
      kind: "confirmation",
      confirmed: true,
    });
    await expect(second).resolves.toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
    current.bridge.observeProviderResolved(1, 202);
    await secondConfirmation;
    const firstConfirmation = current.bridge.respond({
      applicationOperationId: "first",
      interactionId: firstInteraction.backendInteractionId,
      kind: "cancel",
    });
    await expect(first).resolves.toEqual({
      action: "cancel",
      content: null,
      _meta: null,
    });
    current.bridge.observeProviderResolved(1, 201);
    await firstConfirmation;
  });

  it.each([
    null,
    {},
    { tool_params: { query: "unrelated" } },
    { codex_approval_kind: "tool_suggestion", tool_params: {} },
    { codex_approval_kind: "mcp_tool_call" },
  ])(
    "omits invocation details when exact approval metadata is absent: %j",
    async (_meta) => {
      const current = fixture();
      const pending = current.invoke("mcpServer/elicitation/request", 203, {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "search",
        mode: "form",
        message: "Allow search?",
        requestedSchema: { type: "object", properties: {} },
        _meta,
      });
      await vi.waitFor(() => expect(current.events).toHaveLength(1));
      const interaction = current.opened();
      expect(interaction.invocation).toBeUndefined();
      const confirmation = current.bridge.respond({
        applicationOperationId: "no-context",
        interactionId: interaction.backendInteractionId,
        kind: "cancel",
      });
      await pending;
      current.bridge.observeProviderResolved(1, 203);
      await confirmation;
    },
  );

  it("bounds large MCP invocation values before presentation", async () => {
    const current = fixture();
    const pending = current.invoke("mcpServer/elicitation/request", 204, {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "search",
      mode: "form",
      message: "Allow search?",
      requestedSchema: { type: "object", properties: {} },
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_params: { query: "x".repeat(100_000) },
      },
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    expect(JSON.stringify(interaction.invocation)).toContain(
      '"truncated":true',
    );
    expect(JSON.stringify(interaction.invocation).length).toBeLessThan(20_000);
    const confirmation = current.bridge.respond({
      applicationOperationId: "bounded",
      interactionId: interaction.backendInteractionId,
      kind: "cancel",
    });
    await pending;
    current.bridge.observeProviderResolved(1, 204);
    await confirmation;
  });

  it("routes legacy command and patch approvals through the normalized dialog", async () => {
    const current = fixture();
    const command = current.invoke("execCommandApproval", 90, {
      conversationId: "thread-1",
      callId: "legacy-command",
      approvalId: "legacy-approval",
      command: ["install", "source", "/home/user/testfile"],
      cwd: "/workspace",
      reason: "Write outside the workspace",
      parsedCmd: [],
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const commandInteraction = current.opened();
    expect(commandInteraction).toMatchObject({
      kind: "decision",
      destructive: true,
      title: { text: "Command approval" },
      message: { text: expect.stringContaining("Write outside the workspace") },
      actions: [
        {
          backendActionId: "accept",
          role: "primary",
          label: { text: "Approve once" },
        },
        {
          backendActionId: "acceptForSession",
          role: "alternative",
          label: { text: "Approve for session" },
        },
        { backendActionId: "decline", role: "reject", label: { text: "Deny" } },
      ],
    });
    const commandConfirmation = current.bridge.respond({
      applicationOperationId: "legacy-command-operation",
      interactionId: commandInteraction.backendInteractionId,
      kind: "decision",
      selectedActionId: "accept",
    });
    await expect(command).resolves.toEqual({ decision: "approved" });
    current.bridge.observeProviderResolved(1, 90);
    await expect(commandConfirmation).resolves.toBeUndefined();

    const patch = current.invoke("applyPatchApproval", 91, {
      conversationId: "thread-1",
      callId: "legacy-patch",
      fileChanges: {},
      reason: "Write outside the workspace",
      grantRoot: "/home/user",
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(3));
    const patchInteraction = current.opened();
    const patchConfirmation = current.bridge.respond({
      applicationOperationId: "legacy-patch-operation",
      interactionId: patchInteraction.backendInteractionId,
      kind: "decision",
      selectedActionId: "decline",
    });
    await expect(patch).resolves.toEqual({
      decision: { denied: { rejection: "Denied by the user." } },
    });
    current.bridge.observeProviderResolved(1, 91);
    await expect(patchConfirmation).resolves.toBeUndefined();
  });

  it("routes command and file approvals through bounded choices", async () => {
    const current = fixture();
    const command = current.invoke("item/commandExecution/requestApproval", 1, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-command",
      kind: "command",
      startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
      environmentId: null,
      command: "npm test",
      cwd: "/workspace",
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const commandInteraction = current.opened();
    expect(commandInteraction).toMatchObject({
      kind: "decision",
      destructive: true,
      actions: [
        { backendActionId: "accept", role: "primary" },
        { backendActionId: "acceptForSession", role: "alternative" },
        { backendActionId: "decline", role: "reject" },
        {
          backendActionId: "cancel",
          role: "reject",
          label: { text: "Cancel turn" },
        },
      ],
    });
    const commandConfirmation = current.bridge.respond({
      applicationOperationId: "operation-command",
      interactionId: commandInteraction.backendInteractionId,
      kind: "decision",
      selectedActionId: "acceptForSession",
    });
    await expect(command).resolves.toEqual({
      decision: "acceptForSession",
    });
    expect(current.events).toHaveLength(1);
    current.bridge.observeProviderResolved(1, 1);
    await expect(commandConfirmation).resolves.toBeUndefined();

    const file = current.invoke("item/fileChange/requestApproval", 2, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-file",
      startedAtMs: Date.parse("2026-07-31T00:00:01.000Z"),
      reason: null,
      grantRoot: null,
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(3));
    const fileInteraction = current.opened();
    expect(fileInteraction).toMatchObject({
      kind: "decision",
      cancellable: false,
      actions: expect.arrayContaining([
        expect.objectContaining({
          backendActionId: "cancel",
          role: "reject",
        }),
      ]),
    });
    const fileConfirmation = current.bridge.respond({
      applicationOperationId: "operation-file",
      interactionId: fileInteraction.backendInteractionId,
      kind: "decision",
      selectedActionId: "decline",
    });
    await expect(file).resolves.toEqual({ decision: "decline" });
    current.bridge.observeProviderResolved(1, 2);
    await expect(fileConfirmation).resolves.toBeUndefined();
  });

  it("presents and answers a correlated write-stdin approval without treating it as a new command", async () => {
    const current = fixture();

    const pending = current.invoke("item/commandExecution/requestApproval", 3, {
      kind: "writeStdin",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-existing-terminal",
      startedAtMs: Date.parse("2026-07-31T00:00:02.000Z"),
      approvalId: "stdin-approval",
      environmentId: "local-environment",
      reason: "Terminal input needs broader permissions",
      command: "write_stdin --session-id 42 confirm",
      cwd: "/workspace",
      commandActions: [
        {
          type: "unknown",
          command: "write_stdin --session-id 42 confirm",
        },
      ],
      additionalPermissions: {
        fileSystem: {
          write: ["/outside-workspace"],
        },
      },
      availableDecisions: ["accept", "cancel"],
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      kind: "decision",
      title: { text: "Terminal input approval" },
      message: {
        text: expect.stringContaining(
          "Terminal input needs broader permissions",
        ),
      },
      code: { text: "write_stdin --session-id 42 confirm" },
      destructive: true,
      cancellable: false,
      actions: [
        {
          backendActionId: "accept",
          role: "primary",
          label: { text: "Approve once" },
        },
        {
          backendActionId: "cancel",
          role: "reject",
          label: { text: "Cancel turn" },
        },
      ],
    });
    if (interaction.kind !== "decision") {
      throw new Error("expected write-stdin decision interaction");
    }
    expect(interaction.message?.text).toContain(
      "Working directory: /workspace",
    );
    expect(interaction.message?.text).toContain('"/outside-workspace"');

    const confirmation = current.bridge.respond({
      applicationOperationId: "operation-write-stdin",
      interactionId: interaction.backendInteractionId,
      kind: "decision",
      selectedActionId: "accept",
    });
    await expect(pending).resolves.toEqual({ decision: "accept" });
    current.bridge.observeProviderResolved(1, 3);
    await expect(confirmation).resolves.toBeUndefined();

    const cancelPending = current.invoke(
      "item/commandExecution/requestApproval",
      4,
      {
        kind: "writeStdin",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-existing-terminal",
        startedAtMs: Date.parse("2026-07-31T00:00:03.000Z"),
        approvalId: "stdin-approval-cancel",
        environmentId: "local-environment",
        reason: "Terminal input needs broader permissions",
        command: "write_stdin --session-id 42 stop",
        cwd: "/workspace",
        commandActions: [
          {
            type: "unknown",
            command: "write_stdin --session-id 42 stop",
          },
        ],
        availableDecisions: ["accept", "cancel"],
      },
    );
    await vi.waitFor(() => expect(current.events).toHaveLength(3));
    const cancelInteraction = current.opened();
    const cancelConfirmation = current.bridge.respond({
      applicationOperationId: "operation-write-stdin-cancel",
      interactionId: cancelInteraction.backendInteractionId,
      kind: "decision",
      selectedActionId: "cancel",
    });
    await expect(cancelPending).resolves.toEqual({ decision: "cancel" });
    current.bridge.observeProviderResolved(1, 4);
    await expect(cancelConfirmation).resolves.toBeUndefined();
  });

  it("fails closed on a write-stdin approval that omits its exact decisions", async () => {
    const current = fixture();
    await expect(
      current.invoke("item/commandExecution/requestApproval", 4, {
        kind: "writeStdin",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-existing-terminal",
        startedAtMs: Date.parse("2026-07-31T00:00:02.000Z"),
        approvalId: "stdin-approval-without-decisions",
        environmentId: "local-environment",
        reason: "Terminal input needs broader permissions",
        command: "write_stdin --session-id 42 confirm",
        cwd: "/workspace",
        commandActions: [
          {
            type: "unknown",
            command: "write_stdin --session-id 42 confirm",
          },
        ],
      }),
    ).rejects.toThrow("write_stdin_approval_shape_invalid");
    expect(current.events).toEqual([]);
    expect(current.bridge.pendingCount()).toBe(0);
  });

  it("answers a file approval when internal cleanup cancels it", async () => {
    const current = fixture();
    const pending = current.invoke("item/fileChange/requestApproval", 15, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-expiring-file",
      startedAtMs: Date.parse("2026-07-31T00:00:04.000Z"),
      reason: "Exercise internal cleanup",
      grantRoot: null,
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      kind: "decision",
      cancellable: false,
    });

    const confirmation = current.bridge.respond({
      applicationOperationId: "cleanup:file-expiry",
      interactionId: interaction.backendInteractionId,
      kind: "cancel",
    });
    await expect(pending).resolves.toEqual({ decision: "cancel" });
    current.bridge.observeProviderResolved(1, 15);
    await expect(confirmation).resolves.toBeUndefined();
  });

  it("honors the exact command decisions exposed by Codex", async () => {
    const current = fixture();
    const pending = current.invoke(
      "item/commandExecution/requestApproval",
      10,
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-code-mode-command",
        kind: "command",
        startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
        environmentId: null,
        command: "install source /home/user/testfile",
        cwd: "/workspace",
        availableDecisions: ["accept", "cancel"],
      },
    );
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      kind: "decision",
      cancellable: false,
      actions: [
        {
          backendActionId: "accept",
          role: "primary",
          label: { text: "Approve once" },
        },
        {
          backendActionId: "cancel",
          role: "reject",
          label: { text: "Cancel turn" },
        },
      ],
    });
    const confirmation = current.bridge.respond({
      applicationOperationId: "operation-code-mode-command",
      interactionId: interaction.backendInteractionId,
      kind: "decision",
      selectedActionId: "cancel",
    });
    await expect(pending).resolves.toEqual({ decision: "cancel" });
    current.bridge.observeProviderResolved(1, 10);
    await expect(confirmation).resolves.toBeUndefined();

    const amendment = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["npm", "test"],
      },
    } as const;
    const amended = current.invoke(
      "item/commandExecution/requestApproval",
      11,
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-amended-command",
        kind: "command",
        startedAtMs: Date.parse("2026-07-31T00:00:01.000Z"),
        environmentId: null,
        command: "npm test",
        cwd: "/workspace",
        availableDecisions: [amendment, "decline"],
      },
    );
    await vi.waitFor(() => expect(current.events).toHaveLength(3));
    const amendedInteraction = current.opened();
    expect(amendedInteraction).toMatchObject({
      kind: "decision",
      cancellable: false,
      actions: [
        {
          backendActionId: "acceptWithExecpolicyAmendment:0",
          role: "alternative",
          label: { text: "Approve and remember similar commands" },
          description: { text: 'Remember commands matching: "npm" "test"' },
        },
        { backendActionId: "decline", role: "reject", label: { text: "Deny" } },
      ],
    });
    const amendedConfirmation = current.bridge.respond({
      applicationOperationId: "operation-amended-command",
      interactionId: amendedInteraction.backendInteractionId,
      kind: "decision",
      selectedActionId: "acceptWithExecpolicyAmendment:0",
    });
    await expect(amended).resolves.toEqual({ decision: amendment });
    current.bridge.observeProviderResolved(1, 11);
    await expect(amendedConfirmation).resolves.toBeUndefined();

    const proposedNetwork = current.invoke(
      "item/commandExecution/requestApproval",
      13,
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-network-policy-command",
        kind: "command",
        startedAtMs: Date.parse("2026-07-31T00:00:02.000Z"),
        environmentId: null,
        commandActions: [
          {
            type: "unknown",
            command: "curl https://blocked.example",
          },
        ],
        cwd: "/workspace",
        proposedNetworkPolicyAmendments: [
          { host: "blocked.example", action: "deny" },
        ],
      },
    );
    await vi.waitFor(() => expect(current.events).toHaveLength(5));
    const networkInteraction = current.opened();
    expect(networkInteraction).toMatchObject({
      kind: "decision",
      code: {
        text: expect.stringContaining("curl https://blocked.example"),
      },
      actions: expect.arrayContaining([
        expect.objectContaining({ backendActionId: "decline", role: "reject" }),
        expect.objectContaining({ backendActionId: "cancel", role: "reject" }),
        expect.objectContaining({
          backendActionId: "applyNetworkPolicyAmendment:4",
          role: "reject",
          description: {
            text: "Block network access to host: blocked.example",
          },
        }),
      ]),
    });
    const networkConfirmation = current.bridge.respond({
      applicationOperationId: "operation-network-policy-command",
      interactionId: networkInteraction.backendInteractionId,
      kind: "decision",
      selectedActionId: "applyNetworkPolicyAmendment:4",
    });
    await expect(proposedNetwork).resolves.toEqual({
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "blocked.example",
            action: "deny",
          },
        },
      },
    });
    current.bridge.observeProviderResolved(1, 13);
    await expect(networkConfirmation).resolves.toBeUndefined();

    const emptyExecPolicy = current.invoke(
      "item/commandExecution/requestApproval",
      14,
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-empty-exec-policy-command",
        kind: "command",
        startedAtMs: Date.parse("2026-07-31T00:00:03.000Z"),
        environmentId: null,
        command: "npm test",
        cwd: "/workspace",
        proposedExecpolicyAmendment: [],
      },
    );
    await vi.waitFor(() => expect(current.events).toHaveLength(7));
    const emptyExecPolicyInteraction = current.opened();
    expect(emptyExecPolicyInteraction).toMatchObject({
      kind: "decision",
      actions: [
        expect.objectContaining({ backendActionId: "accept" }),
        expect.objectContaining({ backendActionId: "acceptForSession" }),
        expect.objectContaining({ backendActionId: "decline" }),
        expect.objectContaining({ backendActionId: "cancel" }),
      ],
    });
    const emptyExecPolicyConfirmation = current.bridge.respond({
      applicationOperationId: "operation-empty-exec-policy-command",
      interactionId: emptyExecPolicyInteraction.backendInteractionId,
      kind: "decision",
      selectedActionId: "decline",
    });
    await expect(emptyExecPolicy).resolves.toEqual({ decision: "decline" });
    current.bridge.observeProviderResolved(1, 14);
    await expect(emptyExecPolicyConfirmation).resolves.toBeUndefined();
  });

  it("presents a cancel-only command request as a valid explicit choice", async () => {
    const current = fixture();
    const pending = current.invoke(
      "item/commandExecution/requestApproval",
      12,
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-cancel-only-command",
        kind: "command",
        startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
        environmentId: null,
        command: "npm test",
        cwd: "/workspace",
        availableDecisions: ["cancel"],
      },
    );
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      kind: "decision",
      cancellable: false,
      actions: [
        {
          backendActionId: "cancel",
          role: "reject",
          label: { text: "Cancel turn" },
        },
      ],
    });
    const confirmation = current.bridge.respond({
      applicationOperationId: "operation-cancel-only-command",
      interactionId: interaction.backendInteractionId,
      kind: "decision",
      selectedActionId: "cancel",
    });
    await expect(pending).resolves.toEqual({ decision: "cancel" });
    current.bridge.observeProviderResolved(1, 12);
    await expect(confirmation).resolves.toBeUndefined();
  });

  it("routes permission grants and confirms them only from native resolution", async () => {
    const current = fixture();
    const pending = current.invoke("item/permissions/requestApproval", 11, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-permissions",
      environmentId: null,
      startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
      cwd: "/workspace",
      reason: "Needs network",
      permissions: {
        network: { enabled: true },
        fileSystem: null,
      },
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    const response = {
      applicationOperationId: "operation-permissions",
      interactionId: interaction.backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "turn",
    };
    expect(current.bridge.reconcile(response)).toEqual({
      outcome: "not_applied",
    });
    const confirmation = current.bridge.respond(response);
    await expect(pending).resolves.toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
    });
    expect(current.bridge.reconcile(response)).toEqual({
      outcome: "unknown",
    });
    expect(current.events).toHaveLength(1);
    current.bridge.observeProviderResolved(1, 11);
    await expect(confirmation).resolves.toBeUndefined();
    expect(current.bridge.reconcile(response)).toEqual({
      outcome: "accepted",
    });
  });

  it("presents explicit permission denial and maps it to least privilege", async () => {
    const current = fixture();
    const pending = current.invoke("item/permissions/requestApproval", 12, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-permissions-cancel",
      environmentId: null,
      startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
      cwd: "/workspace",
      reason: "Needs workspace write access",
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/workspace"],
          write: ["/workspace"],
        },
      },
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      cancellable: false,
      destructive: true,
      kind: "decision",
      actions: [
        expect.objectContaining({ backendActionId: "turn", role: "primary" }),
        expect.objectContaining({
          backendActionId: "session",
          role: "alternative",
        }),
        expect.objectContaining({
          backendActionId: "deny",
          role: "reject",
          label: { text: "Deny" },
        }),
      ],
    });
    const response = {
      applicationOperationId: "cleanup:permission-expiry",
      interactionId: interaction.backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "deny",
    };
    const confirmation = current.bridge.respond(response);
    await expect(pending).resolves.toEqual({
      permissions: {},
      scope: "turn",
    });
    expect(current.events).toHaveLength(1);
    current.bridge.observeProviderResolved(1, 12);
    await expect(confirmation).resolves.toBeUndefined();
    expect(current.bridge.reconcile(response)).toEqual({
      outcome: "accepted",
    });
  });

  it("maps nonblocking freeform Codex input to a questionnaire", async () => {
    const current = fixture();
    const pending = current.invoke("item/tool/requestUserInput", 21, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-question",
      questions: [
        {
          id: "question-1",
          header: "Environment",
          question: "Which environment?",
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
      isBlocking: false,
      autoResolutionMs: 1,
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      kind: "questionnaire",
      title: { text: "Questions" },
      questions: [
        {
          backendQuestionId: "question-1",
          header: { text: "Environment" },
          prompt: { text: "Which environment?" },
          input: { kind: "text", multiline: true },
        },
      ],
    });
    expect(interaction).not.toHaveProperty("expiresAt");
    expect(interaction).not.toHaveProperty("resolutionPolicy");
    const confirmation = current.bridge.respond({
      applicationOperationId: "operation-question",
      interactionId: interaction.backendInteractionId,
      kind: "questionnaire",
      answers: [
        {
          questionId: "question-1",
          answer: { kind: "text", value: "staging" },
        },
      ],
    });
    await expect(pending).resolves.toEqual({
      answers: { "question-1": { answers: ["user_note: staging"] } },
    });
    current.bridge.observeProviderResolved(1, 21);
    await expect(confirmation).resolves.toBeUndefined();
  });

  it("maps positional choices, Other, notes, secrets, and unanswered answers", async () => {
    const current = fixture();
    const pending = current.invoke("item/tool/requestUserInput", 22, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-structured-questions",
      questions: [
        {
          id: "environment",
          header: "Environment",
          question: "Which environment?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Staging", description: "Shared test services" },
            { label: "Production", description: "Live services" },
          ],
        },
        {
          id: "credential",
          header: "Credential",
          question: "Provide the temporary credential",
          isOther: false,
          isSecret: true,
          options: null,
        },
        {
          id: "region",
          header: "Region",
          question: "Which region?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "US", description: "United States" },
            { label: "EU", description: "European Union" },
          ],
        },
      ],
      isBlocking: true,
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      kind: "questionnaire",
      secret: true,
      questions: [
        {
          backendQuestionId: "environment",
          input: {
            kind: "single_choice",
            allowNote: true,
            options: [
              {
                backendOptionId: "question:0:option:0",
                label: { text: "Staging" },
              },
              {
                backendOptionId: "question:0:option:1",
                label: { text: "Production" },
              },
            ],
            other: {
              backendOptionId: "question:0:other",
              label: { text: "None of the above" },
            },
          },
        },
        {
          backendQuestionId: "credential",
          secret: true,
          input: { kind: "text" },
        },
        {
          backendQuestionId: "region",
          input: {
            kind: "single_choice",
            options: [
              { backendOptionId: "question:2:option:0" },
              { backendOptionId: "question:2:option:1" },
            ],
          },
        },
      ],
    });
    const confirmation = current.bridge.respond({
      applicationOperationId: "operation-structured-questions",
      interactionId: interaction.backendInteractionId,
      kind: "questionnaire",
      answers: [
        {
          questionId: "environment",
          answer: {
            kind: "single_choice",
            selectedOptionId: "question:0:other",
            note: "Use the isolated preview environment",
          },
        },
        {
          questionId: "credential",
          answer: { kind: "text", value: "temporary-secret" },
        },
        { questionId: "region", answer: { kind: "unanswered" } },
      ],
    });
    await expect(pending).resolves.toEqual({
      answers: {
        environment: {
          answers: [
            "None of the above",
            "user_note: Use the isolated preview environment",
          ],
        },
        credential: { answers: ["user_note: temporary-secret"] },
        region: { answers: [] },
      },
    });
    current.bridge.observeProviderResolved(1, 22);
    await expect(confirmation).resolves.toBeUndefined();
  });

  it("maps an explicit unanswered questionnaire response", async () => {
    const current = fixture();
    const pending = current.invoke("item/tool/requestUserInput", 23, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-auto-question",
      questions: [
        {
          id: "environment",
          header: "Environment",
          question: "Which environment?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Staging", description: "Test services" }],
        },
      ],
      isBlocking: false,
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    const confirmation = current.bridge.respond({
      applicationOperationId: "operation-unanswered-questionnaire",
      interactionId: interaction.backendInteractionId,
      kind: "questionnaire",
      answers: [{ questionId: "environment", answer: { kind: "unanswered" } }],
    });
    await expect(pending).resolves.toEqual({
      answers: { environment: { answers: [] } },
    });
    current.bridge.observeProviderResolved(1, 23);
    await expect(confirmation).resolves.toBeUndefined();
  });

  it("encodes prototype-sensitive native question IDs as own answer properties", async () => {
    const current = fixture();
    const questionIds = ["__proto__", "constructor", "prototype"] as const;
    const pending = current.invoke("item/tool/requestUserInput", 24, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-prototype-question-ids",
      questions: questionIds.map((id) => ({
        id,
        header: id,
        question: `Answer ${id}`,
        isOther: false,
        isSecret: false,
        options: null,
      })),
      isBlocking: true,
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    const confirmation = current.bridge.respond({
      applicationOperationId: "operation-prototype-question-ids",
      interactionId: interaction.backendInteractionId,
      kind: "questionnaire",
      answers: questionIds.map((questionId, index) => ({
        questionId,
        answer: { kind: "text" as const, value: `value-${index}` },
      })),
    });
    const providerResponse = (await pending) as {
      readonly answers: Record<string, { readonly answers: readonly string[] }>;
    };
    for (const id of questionIds) {
      expect(Object.hasOwn(providerResponse.answers, id)).toBe(true);
    }
    expect(JSON.stringify(providerResponse)).toBe(
      '{"answers":{"__proto__":{"answers":["user_note: value-0"]},"constructor":{"answers":["user_note: value-1"]},"prototype":{"answers":["user_note: value-2"]}}}',
    );
    current.bridge.observeProviderResolved(1, 24);
    await expect(confirmation).resolves.toBeUndefined();
  });

  it("keeps approval and user-input authority on one generation-qualified controller while a concurrent observer stays passive", async () => {
    const current = fixture();
    const observerEvents: InteractionEvent[] = [];
    const observer = new CodexInteractionBridge({
      router: current.router,
      nativeThreadId: "thread-1",
      ownsRoute: () => true,
      emit: (event) => observerEvents.push(event),
      now: () => Date.parse("2026-07-31T00:00:00.000Z"),
    });

    expect(() => observer.activate(1)).toThrow(
      "codex_server_request_thread_already_owned",
    );
    expect(current.router.ownerCount()).toBe(1);

    const approval = current.invoke(
      "item/commandExecution/requestApproval",
      51,
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-observed-command",
        kind: "command",
        startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
        environmentId: null,
        command: "npm test",
        cwd: "/workspace",
      },
    );
    const userInput = current.invoke("item/tool/requestUserInput", 52, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-observed-input",
      questions: [
        {
          id: "environment",
          header: "Environment",
          question: "Which environment?",
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
      isBlocking: true,
    });
    await vi.waitFor(() =>
      expect(
        current.events.filter(({ type }) => type === "interaction_opened"),
      ).toHaveLength(2),
    );
    const opened = current.events.flatMap((event) =>
      event.type === "interaction_opened" ? [event.interaction] : [],
    );
    const approvalInteraction = opened.find(({ kind }) => kind === "decision");
    const inputInteraction = opened.find(
      ({ kind }) => kind === "questionnaire",
    );
    if (!approvalInteraction || !inputInteraction) {
      throw new Error("codex_observer_authority_fixture_invalid");
    }

    expect(() =>
      observer.respond({
        applicationOperationId: "observer-approval-attempt",
        interactionId: approvalInteraction.backendInteractionId,
        kind: "decision",
        selectedActionId: "accept",
      }),
    ).toThrow("codex_interaction_not_pending");
    expect(() =>
      observer.respond({
        applicationOperationId: "observer-input-attempt",
        interactionId: inputInteraction.backendInteractionId,
        kind: "questionnaire",
        answers: [
          {
            questionId: "environment",
            answer: { kind: "text", value: "observer answer" },
          },
        ],
      }),
    ).toThrow("codex_interaction_not_pending");

    const approvalConfirmation = current.bridge.respond({
      applicationOperationId: "authoritative-approval",
      interactionId: approvalInteraction.backendInteractionId,
      kind: "decision",
      selectedActionId: "accept",
    });
    const inputConfirmation = current.bridge.respond({
      applicationOperationId: "authoritative-input",
      interactionId: inputInteraction.backendInteractionId,
      kind: "questionnaire",
      answers: [
        {
          questionId: "environment",
          answer: { kind: "text", value: "staging" },
        },
      ],
    });
    await expect(approval).resolves.toEqual({ decision: "accept" });
    await expect(userInput).resolves.toEqual({
      answers: { environment: { answers: ["user_note: staging"] } },
    });
    expect(observerEvents).toEqual([]);
    expect(
      current.events.filter(({ type }) => type === "interaction_opened"),
    ).toHaveLength(2);

    current.bridge.observeProviderResolved(1, 51);
    current.bridge.observeProviderResolved(1, 52);
    await expect(approvalConfirmation).resolves.toBeUndefined();
    await expect(inputConfirmation).resolves.toBeUndefined();
    expect(
      current.events.filter(({ type }) => type === "interaction_resolved"),
    ).toHaveLength(2);
    observer.close();
  });

  it("routes MCP URL elicitation through confirmation", async () => {
    const current = fixture();
    const pending = current.invoke("mcpServer/elicitation/request", 31, {
      threadId: "thread-1",
      turnId: null,
      serverName: "github",
      mode: "url",
      _meta: null,
      message: "Authenticate GitHub",
      url: "https://example.test/auth",
      elicitationId: "elicitation-1",
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      kind: "confirmation",
      message: {
        text: "Authenticate GitHub\n\nhttps://example.test/auth",
      },
    });
    const confirmation = current.bridge.respond({
      applicationOperationId: "operation-mcp",
      interactionId: interaction.backendInteractionId,
      kind: "confirmation",
      confirmed: false,
    });
    await expect(pending).resolves.toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
    current.bridge.observeProviderResolved(1, 31);
    await expect(confirmation).resolves.toBeUndefined();
  });

  it("represents multiple Codex questions as one structured questionnaire", async () => {
    const current = fixture();
    const questions = current.invoke("item/tool/requestUserInput", 41, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-questions",
      questions: [
        {
          id: "first",
          header: "First",
          question: "First answer?",
          isOther: false,
          isSecret: false,
          options: null,
        },
        {
          id: "second",
          header: "Second",
          question: "Second answer?",
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
      isBlocking: true,
    });
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const questionInteraction = current.opened();
    expect(questionInteraction).toMatchObject({
      kind: "questionnaire",
      questions: [
        { backendQuestionId: "first", input: { kind: "text" } },
        { backendQuestionId: "second", input: { kind: "text" } },
      ],
    });
    const questionConfirmation = current.bridge.respond({
      applicationOperationId: "operation-questions",
      interactionId: questionInteraction.backendInteractionId,
      kind: "questionnaire",
      answers: [
        { questionId: "first", answer: { kind: "text", value: "one" } },
        { questionId: "second", answer: { kind: "unanswered" } },
      ],
    });
    await expect(questions).resolves.toEqual({
      answers: {
        first: { answers: ["user_note: one"] },
        second: { answers: [] },
      },
    });
    current.bridge.observeProviderResolved(1, 41);
    await expect(questionConfirmation).resolves.toBeUndefined();

    await expect(
      current.invoke("mcpServer/elicitation/request", 42, {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "provider",
        mode: "openai/form",
        _meta: null,
        message: "Provider form",
        requestedSchema: { type: "object" },
      }),
    ).rejects.toThrow("codex_mcp_openai_elicitation_unadvertised");
  });

  it("aborts visibly on generation loss and rejects late responses", async () => {
    const current = fixture();
    const pending = current.invoke(
      "item/commandExecution/requestApproval",
      51,
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-command",
        kind: "command",
        startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
        environmentId: null,
      },
    );
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    current.router.activateGeneration(2);
    await expect(pending).rejects.toMatchObject({
      code: "codex_server_request_generation_replaced",
    });
    expect(current.events.at(-1)).toEqual({
      type: "interaction_resolved",
      backendInteractionId: interaction.backendInteractionId,
    });
    expect(() =>
      current.bridge.respond({
        applicationOperationId: "operation-late",
        interactionId: interaction.backendInteractionId,
        kind: "decision",
        selectedActionId: "accept",
      }),
    ).toThrow(CodexInteractionBridgeError);
  });

  it("keeps submitted responses unknown across generation replacement and request ID reuse", async () => {
    const current = fixture();
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-command-generation-one",
      kind: "command",
      startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
      environmentId: null,
      command: "npm test",
      cwd: "/workspace",
    };
    const firstProviderRequest = current.invoke(
      "item/commandExecution/requestApproval",
      61,
      params,
    );
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const firstInteraction = current.opened();
    const firstResponse = {
      applicationOperationId: "operation-generation-one",
      interactionId: firstInteraction.backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "accept",
    };
    const firstConfirmation = current.bridge.respond(firstResponse);
    await expect(firstProviderRequest).resolves.toEqual({
      decision: "accept",
    });

    current.router.activateGeneration(2);
    current.bridge.activate(2);
    const firstError = await firstConfirmation.catch((error: unknown) => error);
    expect(firstError).toMatchObject({
      code: "codex_interaction_response_confirmation_lost",
      outcomeUnknown: true,
    });
    expect(firstError).toBeInstanceOf(CodexInteractionBridgeError);
    if (!(firstError instanceof CodexInteractionBridgeError)) {
      throw new Error("expected Codex interaction error");
    }
    await expect(firstError.lateMutationReconciliation).resolves.toEqual({
      outcome: "unknown",
    });
    expect(current.bridge.reconcile(firstResponse)).toEqual({
      outcome: "unknown",
    });

    const secondHandler =
      current.router.handlersForGeneration(2)[
        "item/commandExecution/requestApproval"
      ]!;
    const secondProviderRequest = secondHandler(
      request(
        "item/commandExecution/requestApproval",
        61,
        { ...params, itemId: "item-command-generation-two" },
        2,
      ),
    );
    await vi.waitFor(() => expect(current.events).toHaveLength(3));
    const secondInteraction = current.opened();
    const secondResponse = {
      applicationOperationId: "operation-generation-two",
      interactionId: secondInteraction.backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "decline",
    };
    const secondConfirmation = current.bridge.respond(secondResponse);
    await expect(secondProviderRequest).resolves.toEqual({
      decision: "decline",
    });
    current.bridge.observeProviderResolved(2, 61);
    await expect(secondConfirmation).resolves.toBeUndefined();
    expect(current.bridge.reconcile(secondResponse)).toEqual({
      outcome: "accepted",
    });
    expect(current.bridge.reconcile(firstResponse)).toEqual({
      outcome: "unknown",
    });
  });

  it("times out confirmation as crossed-boundary unknown without hiding it as accepted", async () => {
    vi.useFakeTimers();
    try {
      const current = fixture({
        responseConfirmationTimeoutMilliseconds: 25,
      });
      const pending = current.invoke("item/fileChange/requestApproval", 71, {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-timeout",
        startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
        reason: "Update generated output",
        grantRoot: null,
      });
      await vi.waitFor(() => expect(current.events).toHaveLength(1));
      const interaction = current.opened();
      const response = {
        applicationOperationId: "operation-timeout",
        interactionId: interaction.backendInteractionId,
        kind: "decision" as const,
        selectedActionId: "accept",
      };
      const confirmation = current.bridge.respond(response);
      await expect(pending).resolves.toEqual({ decision: "accept" });
      expect(current.events).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(25);
      await expect(confirmation).rejects.toMatchObject({
        code: "codex_interaction_response_confirmation_timeout",
        outcomeUnknown: true,
      });
      expect(current.events.at(-1)).toEqual({
        type: "interaction_resolved",
        backendInteractionId: interaction.backendInteractionId,
      });
      expect(current.bridge.reconcile(response)).toEqual({
        outcome: "unknown",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a bounded late confirmation after a submitted request is aborted", async () => {
    const current = fixture({
      responseConfirmationTimeoutMilliseconds: 25,
    });
    const controller = new AbortController();
    const providerRequest = current.invoke(
      "item/commandExecution/requestApproval",
      72,
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-interrupted-after-response",
        kind: "command",
        startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
        environmentId: null,
        command: "npm test",
        cwd: "/workspace",
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(current.events).toHaveLength(1));
    const interaction = current.opened();
    const response = {
      applicationOperationId: "operation-interrupted-after-response",
      interactionId: interaction.backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "accept",
    };
    const confirmation = current.bridge.respond(response);
    await expect(providerRequest).resolves.toEqual({ decision: "accept" });

    controller.abort(new Error("turn interrupted"));
    const error = await confirmation.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "codex_interaction_response_confirmation_lost",
      outcomeUnknown: true,
    });
    expect(error).toBeInstanceOf(CodexInteractionBridgeError);
    if (!(error instanceof CodexInteractionBridgeError)) {
      throw new Error("expected Codex interaction error");
    }
    expect(current.bridge.reconcile(response)).toEqual({ outcome: "unknown" });

    current.bridge.observeProviderResolved(1, 72);
    await expect(error.lateMutationReconciliation).resolves.toEqual({
      outcome: "accepted",
    });
    expect(current.bridge.reconcile(response)).toEqual({ outcome: "accepted" });
  });
});
