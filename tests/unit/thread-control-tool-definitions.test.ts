import { describe, expect, it, vi } from "vitest";
import type {
  AgentToolDefinition,
  TrustedToolInvocationContext,
} from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import {
  type AgentThreadControlToolServices,
  createThreadArchiveToolDefinition,
  createThreadForkToolDefinition,
  createThreadMessagesToolDefinition,
  createThreadRestoreToolDefinition,
  createThreadSendToolDefinition,
} from "../../src/server/agent-tools/tools/thread-control-tools.js";

function services(): AgentThreadControlToolServices {
  return {
    messages: {
      list: vi.fn(async () => ({
        turns: [],
        nextCursor: null,
        activeTurn: null,
      })),
    },
    send: {
      sendDirect: vi.fn(async () => ({
        status: "delivery_accepted" as const,
        operationId: "operation-1",
      })),
    },
    forks: {
      forkAgent: vi.fn(async () => ({
        status: "created" as const,
        childThreadId: "child-thread",
      })),
      forkPrincipalClient: vi.fn(async () => ({
        status: "created" as const,
        childThreadId: "child-thread",
      })),
    },
    inventory: {
      archive: vi.fn(async (_scope, input) => ({
        threadId: input.threadId,
        archivedThreadCount: input.includeDescendants ? 3 : 1,
      })),
      restore: vi.fn(async (_scope, input) => ({ threadId: input.threadId })),
    },
  };
}

function context(): TrustedToolInvocationContext {
  return {
    invocationId: "invocation-1",
    mutationId: "mutation-1",
    tenantId: "tenant-1",
    principalId: "principal-1",
    subject: {
      kind: "thread_agent",
      sourceThreadId: "controller-thread",
      backendKind: "pi",
    },
    defaults: {
      kind: "thread_agent",
      environmentId: "environment-1",
      workspaceId: "controller-workspace",
      threadId: "controller-thread",
    },
    policyIdentity: {
      ownerKind: "thread",
      ownerId: "controller-thread",
      revision: 1,
    },
    adapter: "http",
    effectiveCapabilities: [],
    hasCapability: () => false,
    environmentAuthority: {
      id: "grant-1",
      callerKind: "thread_agent",
      defaults: {
        kind: "thread_agent",
        environmentId: "environment-1",
        workspaceId: "controller-workspace",
        threadId: "controller-thread",
      },
      policyIdentity: {
        ownerKind: "thread",
        ownerId: "controller-thread",
        revision: 1,
      },
      admittedEnvironmentIds: ["environment-1"],
      targetEnvironmentIds: [],
      resolvedResourceRefs: [
        {
          kind: "thread",
          id: "thread-1",
          environmentId: "environment-1",
          workspaceId: "workspace-1",
        },
        {
          kind: "thread_family",
          id: "thread-1",
          environmentId: "environment-1",
          workspaceId: "workspace-1",
        },
      ],
      canonicalInputDigest: "input-digest",
      authorityDigest: "authority-digest",
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
    },
    requestId: "request-1",
    abortSignal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

describe("thread control tool definitions", () => {
  it("registers exactly the five canonical contracts with truthful effects", () => {
    const value = services();
    const definitions: AgentToolDefinition[] = [
      createThreadMessagesToolDefinition(value),
      createThreadSendToolDefinition(value),
      createThreadForkToolDefinition(value),
      createThreadArchiveToolDefinition(value),
      createThreadRestoreToolDefinition(value),
    ];
    const registry = new AgentToolRegistry();
    definitions.forEach((definition) => registry.register(definition));

    expect(
      registry.list().map(({ id, schemaVersion }) => [id, schemaVersion]),
    ).toEqual([
      ["thread.messages", 4],
      ["thread.send", 2],
      ["thread.fork", 1],
      ["thread.archive", 1],
      ["thread.restore", 1],
    ]);
    expect(definitions.map(({ effects }) => effects)).toEqual([
      { application: "read", modelUsage: "none", external: "none" },
      {
        application: "write",
        modelUsage: "agent_execution",
        external: "durable_side_effect",
      },
      {
        application: "write",
        modelUsage: "none",
        external: "durable_side_effect",
      },
      { application: "write", modelUsage: "none", external: "none" },
      { application: "write", modelUsage: "none", external: "none" },
    ]);
    expect(definitions[2]?.execution.adapterWaitCeilingMilliseconds).toEqual({
      pi_sdk: 90_000,
      http: 90_000,
      cli: 90_000,
    });
    expect(
      definitions
        .filter(({ id }) => id !== "thread.fork")
        .map(({ execution }) => execution.adapterWaitCeilingMilliseconds),
    ).toEqual([
      {
        pi_sdk: 30_000,
        http: 30_000,
        cli: 30_000,
      },
      {
        pi_sdk: 30_000,
        http: 30_000,
        cli: 30_000,
      },
      {
        pi_sdk: 30_000,
        http: 30_000,
        cli: 30_000,
      },
      {
        pi_sdk: 30_000,
        http: 30_000,
        cli: 30_000,
      },
    ]);
  });

  it("keeps public inputs closed and enforces the messages and send bounds", () => {
    const value = services();
    const registry = new AgentToolRegistry();
    registry.register(createThreadMessagesToolDefinition(value));
    registry.register(createThreadSendToolDefinition(value));
    registry.register(createThreadForkToolDefinition(value));
    registry.register(createThreadArchiveToolDefinition(value));
    registry.register(createThreadRestoreToolDefinition(value));

    expect(
      registry.validatesInput("thread.messages", 4, {
        threadId: "thread-1",
        pageSize: 25,
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("thread.messages", 4, {
        threadId: "thread-1",
        pageSize: 26,
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("thread.send", 2, {
        threadId: "thread-1",
        message: "",
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("thread.archive", 1, {
        threadId: "thread-1",
        includeDescendants: true,
        openTaskDisposition: "move_to_workspace",
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("thread.archive", 1, {
        threadId: "thread-1",
        openTaskDisposition: "delete",
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("thread.restore", 1, {
        threadId: "thread-1",
        expectedRevision: 4,
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("thread.fork", 1, {
        threadId: "thread-1",
        sourceTurnId: "turn-1",
        expectedTurnRevision: 0,
        mutationId: "not-public",
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("thread.send", 2, {
        threadId: "thread-1",
        message: "run",
        sourceThreadId: "not-public",
      }),
    ).toBe(false);
    expect(
      registry.validatesInput("thread.send", 2, {
        threadId: "thread-1",
        message: "run",
        callback: true,
      }),
    ).toBe(true);
    expect(
      registry.validatesInput("thread.send", 2, {
        threadId: "thread-1",
        message: "run",
        callback: "yes",
      }),
    ).toBe(false);
    expect(
      registry.validatesOutput("thread.send", 2, {
        status: "delivery_accepted",
        operationId: "operation-1",
        callbackId: "callback-1",
      }),
    ).toBe(true);
    expect(
      registry.validatesOutput("thread.messages", 4, {
        turns: [
          {
            id: "application-turn-id-up-to-one-hundred-and-sixty-characters",
            revision: 2,
            status: "completed",
            forkable: true,
            messages: [
              {
                role: "user",
                origin: {
                  kind: "agent_result",
                  callbackId: "callback-1",
                  sourceThreadId: "worker-thread",
                  sourceThreadLabel: { text: "Research agent" },
                },
                text: {
                  text: "image omitted",
                  truncation: {
                    truncated: true,
                    retainedBytes: 13,
                    reason: "binary_omitted",
                  },
                },
              },
            ],
            messagesTruncation: {
              truncated: true,
              omittedCount: 1,
              reason: "entry_limit",
            },
          },
        ],
        nextCursor: null,
        activeTurn: {
          id: "active-turn-1",
          status: "in_progress",
          startedAt: "2026-08-09T10:00:00.000Z",
          messages: [
            {
              id: "active-message-1",
              role: "assistant",
              text: { text: "Text-final commentary." },
            },
          ],
          messagesTruncation: {
            truncated: true,
            omittedCount: 2,
            reason: "entry_limit",
          },
        },
      }),
    ).toBe(true);
    expect(
      registry.validatesOutput("thread.messages", 4, {
        turns: [
          {
            id: "turn-1",
            revision: 0,
            status: "completed",
            forkable: false,
            messages: [],
            messagesTruncation: {
              truncated: true,
              omittedCount: 1,
              reason: "byte_limit",
            },
          },
        ],
        nextCursor: null,
        activeTurn: null,
      }),
    ).toBe(false);
  });

  it("describes thread message ordering, turn paging, cursor lifetime, and omitted-only text", () => {
    const definition = createThreadMessagesToolDefinition(services());
    const input = definition.inputSchema as unknown as {
      properties: {
        pageSize: { description?: string };
        cursor: { description?: string };
      };
    };
    const output = definition.outputSchema as unknown as {
      properties: {
        turns: {
          description?: string;
          items: {
            properties: {
              messages: {
                items: {
                  properties: {
                    text: {
                      properties: {
                        text: { description?: string };
                        truncation: {
                          properties: {
                            reason: { description?: string };
                          };
                        };
                      };
                    };
                  };
                };
              };
            };
          };
        };
        nextCursor: { description?: string };
        activeTurn: {
          description?: string;
          anyOf: Array<{
            properties?: {
              messages?: {
                description?: string;
                items?: { description?: string };
              };
              messagesTruncation?: {
                properties?: {
                  omittedCount?: { description?: string };
                };
              };
            };
          }>;
        };
      };
    };

    expect(input.properties.pageSize.description).toContain(
      "settled terminal turns",
    );
    expect(input.properties.pageSize.description).toContain("newest turns");
    expect(input.properties.cursor.description).toContain("single-use");
    expect(input.properties.cursor.description).toContain("server restarts");
    expect(output.properties.turns.description).toContain(
      "chronological order",
    );
    expect(output.properties.nextCursor.description).toContain("older turns");
    expect(output.properties.activeTurn.description).toContain("fresh request");
    expect(output.properties.activeTurn.description).toContain(
      "Continuation pages omit",
    );
    const activeObject = output.properties.activeTurn.anyOf.find(
      ({ properties }) => properties?.messages,
    );
    expect(activeObject?.properties?.messages?.description).toContain(
      "newest text-finalized",
    );
    expect(activeObject?.properties?.messages?.items?.description).toContain(
      "does not assert",
    );
    expect(
      activeObject?.properties?.messagesTruncation?.properties?.omittedCount
        ?.description,
    ).toContain("older");

    const text =
      output.properties.turns.items.properties.messages.items.properties.text
        .properties;
    expect(text.text.description).toContain("only omitted image");
    expect(text.truncation.properties.reason.description).toContain(
      "binary_omitted",
    );
  });

  it("distinguishes callback continuation from fire-and-forget send language", () => {
    const definition = createThreadSendToolDefinition(services());
    const input = definition.inputSchema as unknown as {
      properties: { callback: { description?: string } };
    };

    expect(input.properties.callback.description).toContain(
      "automatically receives",
    );
    expect(input.properties.callback.description).toContain(
      "returns immediately in either mode",
    );
    expect(input.properties.callback.description).toContain(
      "fire-and-forget",
    );
    expect(definition.adapters.pi?.promptSnippet).toContain(
      "Set callback true",
    );
    expect(definition.adapters.pi?.promptSnippet).toContain(
      "fire-and-forget",
    );
  });

  it("passes trusted scope, controller identity, mutation identity, and defaults only below the public contract", async () => {
    const value = services();
    const invocation = context();

    await createThreadMessagesToolDefinition(value).execute(
      { threadId: "target-thread" },
      invocation,
    );
    expect(value.messages.list).toHaveBeenCalledWith(
      { tenantId: "tenant-1", principalId: "principal-1" },
      "target-thread",
      {
        pageSize: 10,
        environmentAuthority: invocation.environmentAuthority,
      },
    );

    await createThreadSendToolDefinition(value).execute(
      { threadId: "target-thread", message: "Continue." },
      invocation,
    );
    expect(value.send.sendDirect).toHaveBeenCalledWith(
      { tenantId: "tenant-1", principalId: "principal-1" },
      {
        initiator: {
          kind: "thread_agent",
          sourceThreadId: "controller-thread",
          sourceWorkspaceId: "controller-workspace",
        },
        targetThreadId: "target-thread",
        message: "Continue.",
        callback: false,
        mutationId: "mutation-1",
        environmentAuthority: invocation.environmentAuthority,
      },
    );

    await createThreadSendToolDefinition(value).execute(
      { threadId: "target-thread", message: "Continue.", callback: true },
      invocation,
    );
    expect(value.send.sendDirect).toHaveBeenLastCalledWith(
      { tenantId: "tenant-1", principalId: "principal-1" },
      expect.objectContaining({
        initiator: expect.objectContaining({
          kind: "thread_agent",
          sourceThreadId: "controller-thread",
        }),
        callback: true,
      }),
    );

    await createThreadForkToolDefinition(value).execute(
      {
        threadId: "target-thread",
        sourceTurnId: "turn-7",
        expectedTurnRevision: 3,
      },
      invocation,
    );
    expect(value.forks.forkAgent).toHaveBeenCalledWith({
      scope: { tenantId: "tenant-1", principalId: "principal-1" },
      controllerThreadId: "controller-thread",
      sourceThreadId: "target-thread",
      sourceTurnId: "turn-7",
      expectedTurnRevision: 3,
      mutationId: "mutation-1",
      environmentAuthority: invocation.environmentAuthority,
    });

    await createThreadArchiveToolDefinition(value).execute(
      {
        threadId: "target-thread",
        includeDescendants: true,
        openTaskDisposition: "move_to_global",
      },
      invocation,
    );
    expect(value.inventory.archive).toHaveBeenCalledWith(
      { tenantId: "tenant-1", principalId: "principal-1" },
      {
        threadId: "target-thread",
        includeDescendants: true,
        openTaskDisposition: "move_to_global",
        mutationId: "mutation-1",
        environmentAuthority: invocation.environmentAuthority,
      },
    );

    await createThreadRestoreToolDefinition(value).execute(
      { threadId: "target-thread" },
      invocation,
    );
    expect(value.inventory.restore).toHaveBeenCalledWith(
      { tenantId: "tenant-1", principalId: "principal-1" },
      {
        threadId: "target-thread",
        mutationId: "mutation-1",
        environmentAuthority: invocation.environmentAuthority,
      },
    );
  });

  it("rejects a schema-valid multibyte send above the durable UTF-8 byte limit", async () => {
    const value = services();
    const canonical = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      threadControl: value,
      invocationId: () => "invocation-1",
      mutationId: () => "mutation-1",
    });
    const source = {
      scope: { tenantId: "tenant-1", principalId: "principal-1" },
      subject: context().subject,
      defaults: context().defaults,
      policyIdentity: context().policyIdentity,
      environmentAuthority: context().environmentAuthority,
      adapter: "http" as const,
      signal: new AbortController().signal,
    };

    await expect(
      canonical.invoke(
        {
          toolId: "thread.send",
          schemaVersion: 2,
          requestId: "oversized-multibyte",
          input: { threadId: "target-thread", message: "😀".repeat(20_000) },
        },
        source,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(value.send.sendDirect).not.toHaveBeenCalled();

    await expect(
      canonical.invoke(
        {
          toolId: "thread.send",
          schemaVersion: 2,
          requestId: "maximum-ascii",
          input: { threadId: "target-thread", message: "a".repeat(65_536) },
        },
        source,
      ),
    ).resolves.toMatchObject({
      state: "completed",
      output: { status: "delivery_accepted", operationId: "operation-1" },
    });
  });
});
