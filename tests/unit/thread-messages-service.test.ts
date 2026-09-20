import { describe, expect, it, vi } from "vitest";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import {
  createThreadMessagesToolDefinition,
} from "../../src/server/agent-tools/tools/thread-control-tools.js";
import type { ConversationActorSnapshotState } from "../../src/server/conversations/conversation-actor.js";
import {
  MAXIMUM_THREAD_MESSAGES_OUTPUT_BYTES,
  ThreadMessagesService,
} from "../../src/server/conversations/thread-messages-service.js";
import { serializedUtf8Bytes } from "../../src/shared/protocol/payload.js";
import type {
  ConversationItem,
  ConversationTurn,
  HistoryPage,
} from "../../src/shared/protocol/conversation.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import type { TrustedEnvironmentAuthorityGrant } from "../../src/server/agent-tools/environment/environment-authority.js";

const scope: RequestScope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};

const environmentAuthority: TrustedEnvironmentAuthorityGrant = Object.freeze({
  id: "grant-1",
  callerKind: "thread_agent",
  defaults: Object.freeze({
    kind: "thread_agent",
    environmentId: "environment-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
  }),
  policyIdentity: Object.freeze({
    ownerKind: "thread",
    ownerId: "thread-1",
    revision: 1,
  }),
  admittedEnvironmentIds: Object.freeze(["environment-1"]),
  targetEnvironmentIds: Object.freeze([]),
  resolvedResourceRefs: Object.freeze([
    Object.freeze({
      kind: "thread" as const,
      id: "thread-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
    }),
  ]),
  canonicalInputDigest: "input-digest",
  authorityDigest: "authority-digest",
  display: Object.freeze({
    targetEnvironmentLabels: Object.freeze([]),
    resourceLabels: Object.freeze([]),
  }),
});

function turn(
  id: string,
  status: ConversationTurn["status"] = "completed",
  revision = 0,
  itemIds: readonly string[] = [],
): ConversationTurn {
  return {
    id,
    revision,
    status,
    ...(status === "completed" ? { endedBy: "agent_settled" as const } : {}),
    startedAt: "2026-08-09T10:00:00.000Z",
    ...(status === "in_progress"
      ? {}
      : { completedAt: "2026-08-09T10:01:00.000Z" }),
    orderedItemIds: [...itemIds],
  };
}

function item(
  id: string,
  turnId: string,
  kind: "user" | "assistant",
  text: string,
  status: ConversationItem["status"] = "completed",
): ConversationItem {
  const base = {
    id,
    turnId,
    status,
    revision: 0,
  };
  return kind === "user"
    ? {
        ...base,
        kind: "user_message",
        content: [{ kind: "text", text: { text } }],
      }
    : { ...base, kind: "assistant_message", markdown: { text } };
}

function state(
  turns: readonly ConversationTurn[],
  items: readonly ConversationItem[] = [],
  input: {
    generation?: string;
    previousCursor?: string;
    branching?: boolean;
  } = {},
): ConversationActorSnapshotState {
  return {
    timeline: {
      generation: input.generation ?? "generation-1",
      orderedTurnIds: turns.map(({ id }) => id),
      turnsById: Object.fromEntries(turns.map((value) => [value.id, value])),
      itemsById: Object.fromEntries(items.map((value) => [value.id, value])),
      runState: turns.some(({ status }) => status === "in_progress")
        ? "running"
        : "idle",
      ...(turns.find(({ status }) => status === "in_progress")
        ? {
            activeTurnId: turns.find(({ status }) => status === "in_progress")!
              .id,
          }
        : {}),
    },
    backendCapabilities: {
      revision: "capabilities-1",
      actions: [],
      deliveryModes: ["submit"],
      steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      supportsHistory: Boolean(input.previousCursor),
      branching: input.branching
        ? {
            availability: "available",
            boundaries: ["selected_completed_turn"],
            method: "provider_native",
            sourceMustBeIdle: false,
            settingsInheritance: "native",
            fidelity: {
              instructions: true,
              messages: true,
              toolCalls: true,
              toolResults: true,
              compaction: true,
              attachments: true,
              settings: true,
              limitations: [],
            },
            childIdentity: "application_reserved",
            creationRecovery: "exactly_reconcilable",
          }
        : { availability: "unavailable", reason: { text: "No branching" } },
      interactionKinds: [],
      usageSections: [],
      effectiveSettings: {},
    },
    usage: {},
    history: input.previousCursor
      ? { operational: true, previousCursor: input.previousCursor }
      : { operational: false },
  };
}

function fixture(
  initialState: ConversationActorSnapshotState,
  historyPages: Record<string, HistoryPage> = {},
  input: {
    now?: () => number;
    backingState?: "bound" | "unbound";
    maximumCursors?: number;
  } = {},
) {
  let currentState = initialState;
  const publish = vi.fn();
  const history = vi.fn(
    async ({ cursor }: { cursor?: string; limit: number }) => ({
      generation: currentState.timeline.generation,
      page: historyPages[cursor ?? ""]!,
    }),
  );
  const release = vi.fn();
  const acquire = vi.fn(async () => ({
    actor: { captureSnapshotState: async () => currentState, history },
    hub: { publish },
    publishAuthoritativeReplacement: vi.fn(),
    release,
  }));
  const inventory = {
    getAuthorized: vi.fn(
      async (requestScope: RequestScope, threadId: string) => ({
        tenantId: requestScope.tenantId,
        ownerPrincipalId: requestScope.principalId,
        backendInstanceId: "backend-1",
        thread: { id: threadId, backingState: input.backingState ?? "bound" },
        environment: { id: "environment-1" },
        workspace: { id: "workspace-1" },
      }),
    ),
  };
  const rawService = new ThreadMessagesService({
    inventory: inventory as never,
    runtimes: { acquire } as never,
    ...(input.now ? { now: input.now, cursorLifetimeMilliseconds: 10 } : {}),
    ...(input.maximumCursors === undefined
      ? {}
      : { maximumCursors: input.maximumCursors }),
  });
  const service = {
    list(
      requestScope: RequestScope,
      threadId: string,
      request: Omit<
        import("../../src/server/conversations/thread-messages-service.js").ThreadMessagesInput,
        "environmentAuthority"
      > = {},
    ) {
      return rawService.list(requestScope, threadId, {
        ...request,
        environmentAuthority: {
          ...environmentAuthority,
          resolvedResourceRefs: [
            {
              kind: "thread",
              id: threadId,
              environmentId: "environment-1",
              workspaceId: "workspace-1",
            },
          ],
        },
      });
    },
  };
  return {
    service,
    rawService,
    acquire,
    history,
    publish,
    release,
    inventory,
    setState(value: ConversationActorSnapshotState) {
      currentState = value;
    },
  };
}

function historyPage(
  turns: readonly ConversationTurn[],
  items: readonly ConversationItem[] = [],
  previousCursor?: string,
  forkable = false,
): HistoryPage {
  return {
    orderedTurnIds: turns.map(({ id }) => id),
    turnsById: Object.fromEntries(turns.map((value) => [value.id, value])),
    forkSource: forkable
      ? {
          selectedCompletedTurn: { available: true },
          latestProviderSnapshot: { available: true },
        }
      : {
          selectedCompletedTurn: {
            available: false,
            unavailableReason: { text: "No branching" },
          },
          latestProviderSnapshot: {
            available: false,
            unavailableReason: { text: "No branching" },
          },
        },
    forksByTurnId: Object.fromEntries(
      turns.map((value) => [
        value.id,
        forkable
          ? {
              sourceTurnId: value.id,
              expectedTurnRevision: value.revision,
              available: true,
            }
          : {
              sourceTurnId: value.id,
              expectedTurnRevision: value.revision,
              available: false,
              unavailableReason: { text: "No branching" },
            },
      ]),
    ),
    itemsById: Object.fromEntries(items.map((value) => [value.id, value])),
    ...(previousCursor ? { previousCursor } : {}),
  };
}

describe("ThreadMessagesService", () => {
  it.each(["in_progress", "completed"] as const)(
    "projects question answers in a %s turn through the canonical tool output schema",
    async (status) => {
      const answer: ConversationItem = {
        id: "question-answer",
        turnId: "turn-1",
        kind: "user_message",
        status: "completed",
        revision: 0,
        origin: {
          kind: "question_response",
          requestId: "request-1",
          sourceItemId: "question-item",
          answers: [{ questionIndex: 0, question: "Proceed?", answer: "Yes" }],
        },
        content: [{ kind: "text", text: { text: "Proceed? Yes" } }],
      };
      const agentMessage: ConversationItem = {
        ...answer,
        id: "agent-message",
        origin: {
          kind: "agent_message",
          sourceThreadId: "other-thread",
          sourceThreadLabel: { text: "Research" },
        },
        content: [{ kind: "text", text: { text: "Research result" } }],
      };
      const harness = fixture(
        state(
          [turn("turn-1", status, 0, [answer.id, agentMessage.id])],
          [answer, agentMessage],
        ),
      );
      const page = await harness.service.list(scope, "thread-1");
      const messages =
        status === "in_progress"
          ? page.activeTurn!.messages
          : page.turns[0]!.messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: "user",
        text: { text: "Proceed? Yes" },
      });
      expect(messages[0]).not.toHaveProperty("origin");
      expect(messages[1]).toMatchObject({ origin: agentMessage.origin });
      const definition = createThreadMessagesToolDefinition({
        messages: harness.rawService,
        send: { sendDirect: vi.fn() },
        forks: { forkAgent: vi.fn(), forkPrincipalClient: vi.fn() },
        inventory: { archive: vi.fn(), restore: vi.fn() },
      });
      const registry = new AgentToolRegistry();
      registry.register(definition);
      expect(
        registry.validatesOutput(definition.id, definition.schemaVersion, page),
      ).toBe(true);
    },
  );

  it("returns an empty page for an unbound thread without acquiring a runtime", async () => {
    const harness = fixture(state([]), {}, { backingState: "unbound" });
    await expect(harness.service.list(scope, "thread-1")).resolves.toEqual({
      turns: [],
      nextCursor: null,
      activeTurn: null,
    });
    expect(harness.acquire).not.toHaveBeenCalled();
  });

  it("fails closed when the inventory reader returns another owner", async () => {
    const harness = fixture(state([turn("one")]));
    harness.inventory.getAuthorized.mockResolvedValueOnce({
      tenantId: scope.tenantId,
      ownerPrincipalId: "principal-other",
      backendInstanceId: "backend-1",
      thread: { id: "thread-1", backingState: "bound" },
    } as never);
    await expect(harness.service.list(scope, "thread-1")).rejects.toThrowError(
      "thread_messages_scope_mismatch",
    );
    expect(harness.acquire).not.toHaveBeenCalled();
  });

  it("projects only terminal conversational messages without publishing browser history", async () => {
    const messages: ConversationItem[] = [
      {
        id: "u1",
        turnId: "turn-1",
        kind: "user_message",
        status: "completed",
        revision: 0,
        deliveryOperationId: "operation-u1",
        origin: {
          kind: "agent_result",
          callbackId: "callback-1",
          sourceThreadId: "worker-thread",
          sourceThreadLabel: { text: "Research agent" },
        },
        content: [{ kind: "text", text: { text: "question" } }],
      },
      {
        id: "reasoning-secret",
        turnId: "turn-1",
        kind: "reasoning",
        status: "completed",
        revision: 0,
        markdown: { text: "private reasoning" },
      },
      {
        id: "tool-secret",
        turnId: "turn-1",
        kind: "command",
        status: "completed",
        revision: 0,
        phase: "completed",
        command: { text: "rm secret" },
      },
      item("a1", "turn-1", "assistant", "answer"),
      {
        id: "image-user",
        turnId: "turn-2",
        kind: "user_message",
        status: "completed",
        revision: 0,
        content: [{ kind: "image", omitted: true }],
      },
      item("active-user", "turn-active", "user", "follow up"),
      item("active-final", "turn-active", "assistant", "working update"),
      item(
        "active-streaming",
        "turn-active",
        "assistant",
        "unfinished partial",
        "streaming",
      ),
      {
        id: "active-reasoning",
        turnId: "turn-active",
        kind: "reasoning",
        status: "completed",
        revision: 0,
        markdown: { text: "active private reasoning" },
      },
    ];
    const harness = fixture(
      state(
        [
          turn("turn-1", "completed", 3, [
            "u1",
            "reasoning-secret",
            "tool-secret",
            "a1",
          ]),
          turn("turn-2", "failed", 1, ["image-user"]),
          turn("turn-active", "in_progress", 2, [
            "active-user",
            "active-final",
            "active-streaming",
            "active-reasoning",
          ]),
        ],
        messages,
        { branching: true },
      ),
    );

    const page = await harness.service.list(scope, "thread-1");
    expect(page.turns.map(({ id }) => id)).toEqual(["turn-1", "turn-2"]);
    expect(page.turns[0]).toMatchObject({
      revision: 3,
      status: "completed",
      forkable: true,
    });
    expect(page.turns[0]!.messages).toEqual([
      {
        role: "user",
        text: { text: "question" },
        origin: {
          kind: "agent_result",
          callbackId: "callback-1",
          sourceThreadId: "worker-thread",
          sourceThreadLabel: { text: "Research agent" },
        },
      },
      { role: "assistant", text: { text: "answer" } },
    ]);
    expect(page.turns[1]!.messages[0]).toMatchObject({
      role: "user",
      text: {
        text: "",
        truncation: { reason: "binary_omitted", truncated: true },
      },
    });
    expect(page.activeTurn).toEqual({
      id: "turn-active",
      status: "in_progress",
      startedAt: "2026-08-09T10:00:00.000Z",
      messages: [
        {
          id: "active-user",
          role: "user",
          text: { text: "follow up" },
        },
        {
          id: "active-final",
          role: "assistant",
          text: { text: "working update" },
        },
      ],
    });
    expect(JSON.stringify(page)).not.toMatch(
      /reasoning|private|rm secret|unfinished partial/,
    );
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("returns newest pages first and keeps turns chronological within each page", async () => {
    const activeMessage = item(
      "active-message",
      "active",
      "assistant",
      "still running",
    );
    const harness = fixture(
      state(
        [
          turn("one"),
          turn("two"),
          turn("three"),
          turn("active", "in_progress", 0, [activeMessage.id]),
        ],
        [activeMessage],
      ),
    );
    const newest = await harness.service.list(scope, "thread-1", {
      pageSize: 2,
    });
    expect(newest.turns.map(({ id }) => id)).toEqual(["two", "three"]);
    expect(newest.activeTurn).toMatchObject({
      id: "active",
      messages: [{ id: "active-message" }],
    });
    expect(newest.nextCursor).toMatch(/^thread_messages_/);

    const older = await harness.service.list(scope, "thread-1", {
      pageSize: 2,
      cursor: newest.nextCursor!,
    });
    expect(older.turns.map(({ id }) => id)).toEqual(["one"]);
    expect(older.nextCursor).toBeNull();
    expect(older).not.toHaveProperty("activeTurn");
    await expect(
      harness.service.list(scope, "thread-1", {
        pageSize: 2,
        cursor: newest.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
  });

  it("returns the newest bounded active-message tail with stable item ids", async () => {
    const messages = Array.from({ length: 18 }, (_, index) =>
      item(
        `active-${index}`,
        "active",
        index % 2 ? "assistant" : "user",
        `message ${index}`,
      ),
    );
    messages.push(
      item("active-streaming", "active", "assistant", "partial", "streaming"),
    );
    const harness = fixture(
      state(
        [
          turn(
            "active",
            "in_progress",
            0,
            messages.map(({ id }) => id),
          ),
        ],
        messages,
      ),
    );

    const page = await harness.service.list(scope, "thread-1");
    expect(page.activeTurn?.messages.map(({ id }) => id)).toEqual(
      Array.from({ length: 16 }, (_, index) => `active-${index + 2}`),
    );
    expect(page.activeTurn?.messagesTruncation).toEqual({
      truncated: true,
      omittedCount: 2,
      reason: "entry_limit",
    });
    expect(JSON.stringify(page)).not.toContain("partial");
  });

  it("keeps an active turn out of a settled cursor snapshot after it settles", async () => {
    const activeMessage = item(
      "active-message",
      "active",
      "assistant",
      "finished text",
    );
    const harness = fixture(
      state(
        [
          turn("one"),
          turn("two"),
          turn("active", "in_progress", 0, [activeMessage.id]),
        ],
        [activeMessage],
      ),
    );

    const first = await harness.service.list(scope, "thread-1", {
      pageSize: 1,
    });
    expect(first.turns.map(({ id }) => id)).toEqual(["two"]);
    expect(first.activeTurn).toMatchObject({ id: "active" });

    harness.setState(
      state(
        [
          turn("one"),
          turn("two"),
          turn("active", "completed", 1, [activeMessage.id]),
        ],
        [activeMessage],
      ),
    );
    const older = await harness.service.list(scope, "thread-1", {
      pageSize: 1,
      cursor: first.nextCursor!,
    });
    expect(older.turns.map(({ id }) => id)).toEqual(["one"]);
    expect(older).not.toHaveProperty("activeTurn");

    const refreshed = await harness.service.list(scope, "thread-1", {
      pageSize: 1,
    });
    expect(refreshed.turns.map(({ id }) => id)).toEqual(["active"]);
    expect(refreshed.activeTurn).toBeNull();
  });

  it("treats a terminal turn awaiting its run-state update as settled only", async () => {
    const terminal = state([turn("settled")]);
    const harness = fixture({
      ...terminal,
      timeline: {
        ...terminal.timeline,
        runState: "running",
        activeTurnId: "settled",
      },
    });

    await expect(
      harness.service.list(scope, "thread-1"),
    ).resolves.toMatchObject({
      turns: [{ id: "settled" }],
      activeTurn: null,
    });
  });

  it("accepts a continuation admitted from the cursor-bearing request input", async () => {
    const harness = fixture(state([turn("one"), turn("two"), turn("three")]));
    const newest = await harness.rawService.list(scope, "thread-1", {
      pageSize: 2,
      environmentAuthority: {
        ...environmentAuthority,
        id: "first-invocation-grant",
        canonicalInputDigest: "first-input-digest",
        authorityDigest: "first-invocation-authority-digest",
      },
    });

    await expect(
      harness.rawService.list(scope, "thread-1", {
        pageSize: 2,
        cursor: newest.nextCursor!,
        environmentAuthority: {
          ...environmentAuthority,
          id: "cursor-invocation-grant",
          canonicalInputDigest: "cursor-input-digest",
          authorityDigest: "cursor-invocation-authority-digest",
        },
      }),
    ).resolves.toMatchObject({ turns: [{ id: "one" }], nextCursor: null });
  });

  it("rejects continuation authority changes without duplicate entry checks", async () => {
    const harness = fixture(state([turn("one"), turn("two")]));
    const first = await harness.service.list(scope, "thread-1", {
      pageSize: 1,
    });

    for (const changedAuthority of [
      {
        ...environmentAuthority,
        admittedEnvironmentIds: ["environment-1", "environment-2"],
      },
      {
        ...environmentAuthority,
        resolvedResourceRefs: [
          ...environmentAuthority.resolvedResourceRefs,
          {
            kind: "environment" as const,
            id: "environment-2",
            environmentId: "environment-2",
          },
        ],
      },
    ]) {
      await expect(
        harness.rawService.list(scope, "thread-1", {
          cursor: first.nextCursor!,
          pageSize: 1,
          environmentAuthority: changedAuthority,
        }),
      ).rejects.toMatchObject({ code: "cursor_invalid" });
    }
  });
  it("evicts the oldest lightweight cursor when the registry is full", async () => {
    const harness = fixture(
      state([turn("one"), turn("two")]),
      {},
      {
        maximumCursors: 2,
      },
    );
    const first = await harness.service.list(scope, "thread-1", {
      pageSize: 1,
    });
    const second = await harness.service.list(scope, "thread-1", {
      pageSize: 1,
    });
    const third = await harness.service.list(scope, "thread-1", {
      pageSize: 1,
    });

    await expect(
      harness.service.list(scope, "thread-1", {
        pageSize: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(
      harness.service.list(scope, "thread-1", {
        pageSize: 1,
        cursor: second.nextCursor!,
      }),
    ).resolves.toMatchObject({ turns: [{ id: "one" }] });
    expect(third.nextCursor).toMatch(/^thread_messages_/);
  });

  it("fills a page from normalized backend history without exposing its cursor", async () => {
    const olderItems = [item("u3", "three", "user", "older")];
    const harness = fixture(
      state([turn("five")], [], { previousCursor: "native-secret-1" }),
      {
        "native-secret-1": historyPage(
          [turn("three", "completed", 0, ["u3"]), turn("four")],
          olderItems,
          "native-secret-2",
          true,
        ),
        "native-secret-2": historyPage([turn("one"), turn("two")]),
      },
    );
    const newest = await harness.service.list(scope, "thread-1", {
      pageSize: 3,
    });
    expect(newest.turns.map(({ id }) => id)).toEqual(["three", "four", "five"]);
    expect(JSON.stringify(newest)).not.toContain("native-secret");
    const oldest = await harness.service.list(scope, "thread-1", {
      pageSize: 3,
      cursor: newest.nextCursor!,
    });
    expect(oldest.turns.map(({ id }) => id)).toEqual(["one", "two"]);
    expect(oldest.nextCursor).toBeNull();
  });

  it("rejects cursor use across principal, thread, page size, generation, and expiry", async () => {
    let now = 100;
    const harness = fixture(
      state([turn("one"), turn("two")]),
      {},
      { now: () => now },
    );
    const first = await harness.service.list(scope, "thread-1", {
      pageSize: 1,
    });
    const cursor = first.nextCursor!;
    await expect(
      harness.service.list(
        { ...scope, principalId: "principal-2" },
        "thread-1",
        { cursor, pageSize: 1 },
      ),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(
      harness.service.list(scope, "thread-2", { cursor, pageSize: 1 }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(
      harness.service.list(scope, "thread-1", { cursor, pageSize: 2 }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });

    harness.setState(
      state([turn("one"), turn("two")], [], { generation: "generation-2" }),
    );
    await expect(
      harness.service.list(scope, "thread-1", { cursor, pageSize: 1 }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });

    harness.setState(state([turn("one"), turn("two")]));
    const expiring = (
      await harness.service.list(scope, "thread-1", { pageSize: 1 })
    ).nextCursor!;
    now = 111;
    await expect(
      harness.service.list(scope, "thread-1", {
        cursor: expiring,
        pageSize: 1,
      }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
  });

  it("binds cursors to the admitted environment and policy authority", async () => {
    const harness = fixture(state([turn("one"), turn("two")]));
    const first = await harness.service.list(scope, "thread-1", {
      pageSize: 1,
    });

    await expect(
      harness.rawService.list(scope, "thread-1", {
        cursor: first.nextCursor!,
        pageSize: 1,
        environmentAuthority: {
          ...environmentAuthority,
          policyIdentity: {
            ...environmentAuthority.policyIdentity,
            revision: 2,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    expect(harness.acquire).toHaveBeenCalledTimes(1);
  });

  it("bounds output and reports byte and entry truncation explicitly", async () => {
    const long = "🙂".repeat(40_000);
    const settledMessages = Array.from({ length: 20 }, (_, index) =>
      item(
        `message-${index}`,
        "turn-1",
        index % 2 ? "assistant" : "user",
        long,
      ),
    );
    const activeMessages = Array.from({ length: 20 }, (_, index) =>
      item(
        `active-message-${index}`,
        "active",
        index % 2 ? "assistant" : "user",
        long,
      ),
    );
    const messages = [...settledMessages, ...activeMessages];
    const harness = fixture(
      state(
        [
          turn(
            "turn-1",
            "completed",
            0,
            settledMessages.map(({ id }) => id),
          ),
          turn(
            "active",
            "in_progress",
            0,
            activeMessages.map(({ id }) => id),
          ),
        ],
        messages,
      ),
    );
    const page = await harness.service.list(scope, "thread-1");
    expect(serializedUtf8Bytes(page)).toBeLessThanOrEqual(
      MAXIMUM_THREAD_MESSAGES_OUTPUT_BYTES,
    );
    expect(page.turns[0]!.messages).toHaveLength(16);
    expect(page.turns[0]!.messagesTruncation).toEqual({
      truncated: true,
      omittedCount: 4,
      reason: "entry_limit",
    });
    expect(page.turns[0]!.messages[0]!.text.truncation).toMatchObject({
      truncated: true,
      reason: "byte_limit",
    });
    expect(page.activeTurn?.messages).toHaveLength(16);
    expect(page.activeTurn?.messagesTruncation).toEqual({
      truncated: true,
      omittedCount: 4,
      reason: "entry_limit",
    });
    expect(page.activeTurn?.messages[0]?.text.truncation).toMatchObject({
      truncated: true,
      reason: "byte_limit",
    });
    expect(
      Buffer.byteLength(page.turns[0]!.messages[0]!.text.text, "utf8") % 4,
    ).toBe(0);
  });

  it.each([0, 26, 1.5])("rejects invalid page size %s", async (pageSize) => {
    const harness = fixture(state([]));
    await expect(
      harness.service.list(scope, "thread-1", { pageSize }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    expect(harness.acquire).not.toHaveBeenCalled();
  });
});
