import { describe, expect, it } from "vitest";
import {
  NONBLOCKING_QUESTIONS_MAXIMUM_OPTIONS,
  NONBLOCKING_QUESTIONS_MAXIMUM_OPTION_BYTES,
  NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS,
  NONBLOCKING_QUESTIONS_MAXIMUM_TITLE_BYTES,
} from "../../src/shared/protocol/questions.js";
import { ConversationProjector } from "../../src/server/conversations/conversation-projector.js";
import { projectConversationItemActivity } from "../../src/server/conversations/thread-activity-projection.js";
import {
  refineCodexThreadItem,
  type CodexThreadItem,
  type CodexTurn,
} from "../../src/server/backends/codex/codex-c1-protocol.js";
import { projectCodexItemSlice } from "../../src/server/backends/codex/codex-history-projector.js";
import {
  backendItemSchema,
  conversationItemSchema,
} from "../../src/shared/index.js";

const questions = [
  {
    title: "Which path should I take?",
    options: ["Use the recommended path", "Keep the existing path"],
  },
  { title: "Anything else I should account for?", options: null },
] as const;

function agentMessage(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    type: "agentMessage",
    id: "async-question-item",
    text: [
      questions[0].title,
      ...questions[0].options,
      "",
      questions[1].title,
    ].join("\n"),
    phase: "final_answer",
    memoryCitation: null,
    delivery: "async",
    questions,
    ...overrides,
  };
}

function decodeItem(value: unknown): CodexThreadItem {
  return refineCodexThreadItem(value as CodexThreadItem);
}

function turn(item: CodexThreadItem): CodexTurn {
  return {
    id: "native-turn",
    items: [item],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: 1_700_000_000,
    completedAt: 1_700_000_001,
    durationMs: 1_000,
  };
}

function projectedItem(
  streaming: boolean,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const item = decodeItem(agentMessage(overrides));
  return projectCodexItemSlice(
    "native-thread",
    turn(item),
    item,
    "backend-turn",
    0,
    0,
    streaming,
    {
      toolProvenanceKey: new Uint8Array(32).fill(0x31),
      tenantId: "tenant",
      principalId: "principal",
      backendInstanceId: "codex",
      nativeThreadId: "native-thread",
      correlationAncestorThreadIds: [],
    },
    undefined,
    undefined,
    {
      scope: { tenantId: "tenant", principalId: "principal" },
      applicationThreadId: "application-thread",
      outputArtifacts: {
        findImage: () => undefined,
        publishImage: async () => {
          throw new Error("unexpected image publication");
        },
      },
      verifiedPublicationKeys: new Set(),
    },
    [],
  )[0]!;
}

describe("Codex nonblocking questions", () => {
  it("validates the native async shape and producer invariants exactly", () => {
    expect(decodeItem(agentMessage())).toMatchObject({ questions });
    expect(
      decodeItem(agentMessage({ questions: null, delivery: null })),
    ).toMatchObject({ questions: null });

    for (const invalid of [
      agentMessage({ questions: undefined }),
      agentMessage({ delivery: null }),
      agentMessage({ questions: [] }),
      agentMessage({ questions: [{ title: "   ", options: null }] }),
      agentMessage({ questions: [{ title: "Question", options: [] }] }),
      agentMessage({
        questions: [{ title: "Question", options: null, native: true }],
      }),
      agentMessage({
        questions: [
          {
            title: "Question",
            options: ["   "],
          },
        ],
      }),
    ]) {
      expect(() => decodeItem(invalid)).toThrow();
    }
  });

  it("retains fallback text when valid native questions exceed the normalized question limits", () => {
    const nativeOnlyQuestionSets = [
      Array.from(
        { length: NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS + 1 },
        (_, index) => ({ title: `Question ${index}`, options: null }),
      ),
      [
        {
          title: "Question",
          options: Array.from(
            { length: NONBLOCKING_QUESTIONS_MAXIMUM_OPTIONS + 1 },
            (_, index) => `Option ${index}`,
          ),
        },
      ],
      [
        {
          title: "x".repeat(NONBLOCKING_QUESTIONS_MAXIMUM_TITLE_BYTES + 1),
          options: null,
        },
      ],
      [
        {
          title: "Question",
          options: ["x".repeat(NONBLOCKING_QUESTIONS_MAXIMUM_OPTION_BYTES + 1)],
        },
      ],
      Array.from(
        { length: NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS },
        (_, questionIndex) => ({
          title: `${questionIndex}: ${"t".repeat(4_000)}`,
          options: Array.from(
            { length: NONBLOCKING_QUESTIONS_MAXIMUM_OPTIONS },
            (_, optionIndex) => `${optionIndex}: ${"o".repeat(512)}`,
          ),
        }),
      ),
    ];

    for (const nativeQuestions of nativeOnlyQuestionSets) {
      expect(() =>
        decodeItem(agentMessage({ questions: nativeQuestions })),
      ).not.toThrow();
      for (const streaming of [false, true]) {
        const projected = backendItemSchema.parse(
          projectedItem(streaming, { questions: nativeQuestions }),
        );
        expect(projected).toMatchObject({
          semanticKind: "assistant_message",
          markdown: { text: expect.stringContaining("Which path") },
        });
        expect(projected).not.toHaveProperty("nonblockingQuestions");
      }
    }
  });

  it("retains typed questions across live, history, normalized and summary projection", () => {
    const history = backendItemSchema.parse(projectedItem(false));
    const live = backendItemSchema.parse(projectedItem(true));
    expect(history).toMatchObject({
      nonblockingQuestions: { questions },
      status: "completed",
    });
    expect(live).toMatchObject({
      nonblockingQuestions: { questions },
      status: "streaming",
    });
    expect(history).not.toHaveProperty("providerFeatures");
    const projector = new ConversationProjector({
      backendInstanceId: "codex",
      bindingIdentity: "binding",
    });
    const normalized = projector.replace(
      {
        orderedBackendTurnIds: [history.backendTurnId],
        turnsById: {
          [history.backendTurnId]: {
            backendTurnId: history.backendTurnId,
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: [history.backendItemId],
          },
        },
        itemsById: { [history.backendItemId]: history },
        runState: "idle",
      },
      -1,
    );
    const item = Object.values(normalized.itemsById)[0]!;
    expect(item).toMatchObject({
      kind: "assistant_message",
      nonblockingQuestions: { questions },
    });
    expect(projectConversationItemActivity(item, "summary")).toEqual(item);
    expect(projectConversationItemActivity(item, "full")).toEqual(item);
  });

  it("keeps identity when native persistence rewrites the item identifier", () => {
    expect(
      projectedItem(false, { id: "persisted-native-item" }).backendItemId,
    ).toBe(projectedItem(true, { id: "live-native-item" }).backendItemId);
  });

  it("keeps question source identity across first arrival, native rewrite and reattach", () => {
    const projector = new ConversationProjector({
      backendInstanceId: "codex",
      bindingIdentity: "binding",
    });
    const live = projectedItem(true, { id: "live-native" });
    projector.replace(
      {
        orderedBackendTurnIds: [live.backendTurnId],
        turnsById: {
          [live.backendTurnId]: {
            backendTurnId: live.backendTurnId,
            status: "in_progress",
            orderedBackendItemIds: [],
          },
        },
        itemsById: {},
        runState: "running",
        activeBackendTurnId: live.backendTurnId,
      },
      -1,
    );
    const { nonblockingQuestions: _questions, ...ordinary } = live as Extract<
      typeof live,
      { semanticKind: "assistant_message" }
    >;
    projector.apply({
      handleSequence: 0,
      event: { type: "item_started", item: ordinary },
    });
    projector.apply({
      handleSequence: 1,
      event: { type: "item_updated", item: live },
    });
    const liveItem = Object.values(projector.timeline().itemsById)[0]!;
    const history = projectedItem(false, { id: "persisted-native" });
    const snapshot = {
      orderedBackendTurnIds: [history.backendTurnId],
      turnsById: {
        [history.backendTurnId]: {
          backendTurnId: history.backendTurnId,
          status: "completed" as const,
          endedBy: "agent_settled" as const,
          orderedBackendItemIds: [history.backendItemId],
        },
      },
      itemsById: { [history.backendItemId]: history },
      runState: "idle" as const,
    };
    const persistedItem = Object.values(
      projector.replace(snapshot, 1).itemsById,
    )[0]!;
    expect(liveItem.kind).toBe("assistant_message");
    expect(persistedItem.kind).toBe("assistant_message");
    if (
      liveItem.kind !== "assistant_message" ||
      persistedItem.kind !== "assistant_message"
    )
      throw new Error("wrong item kind");
    expect(liveItem.id).not.toBe(persistedItem.id);
    expect(liveItem.nonblockingQuestions?.sourceItemId).toBe(persistedItem.id);
    expect(liveItem.nonblockingQuestions).toEqual(
      persistedItem.nonblockingQuestions,
    );
  });

  it("rejects malformed question facets and facets on non-assistant items", () => {
    const valid = projectedItem(false);
    for (const nonblockingQuestions of [
      { questions: [] },
      { questions: [{ title: "Question", options: [], nativeId: "secret" }] },
      { questions, nativeId: "secret" },
    ]) {
      expect(
        backendItemSchema.safeParse({ ...valid, nonblockingQuestions }).success,
      ).toBe(false);
    }
    expect(
      backendItemSchema.safeParse({ ...valid, semanticKind: "reasoning" })
        .success,
    ).toBe(false);
    expect(
      conversationItemSchema.safeParse({
        id: "item",
        turnId: "turn",
        revision: 0,
        status: "completed",
        kind: "reasoning",
        markdown: { text: "Question" },
        nonblockingQuestions: { questions },
      }).success,
    ).toBe(false);
  });
});
