import { describe, expect, it } from "vitest";
import {
  backendItemSchema,
  conversationItemSchema,
  MAXIMUM_MESSAGE_ITEM_BYTES,
  MAXIMUM_MESSAGE_TEXT_BYTES,
  messageTextSchema,
  serializedUtf8Bytes,
} from "../../src/shared/index.js";
import { preserveMessageText } from "../../src/server/conversations/payload-policy.js";
import { ConversationProjector } from "../../src/server/conversations/conversation-projector.js";

const backendBase = {
  backendItemId: "message",
  backendTurnId: "turn",
  status: "completed" as const,
  sourceOrder: 0,
};
const browserBase = {
  id: "message",
  turnId: "turn",
  status: "completed" as const,
  revision: 1,
};

describe("authoritative conversation message text", () => {
  it("preserves long Unicode, escaping, and lone surrogates through projection", () => {
    const text = '界🙂\\"\n\t\ud800'.repeat(70_000) + "\n100. Final paragraph.";
    expect(preserveMessageText(text)).toEqual({ text });
    expect(messageTextSchema.parse({ text })).toEqual({ text });
    const item = backendItemSchema.parse({
      ...backendBase,
      semanticKind: "assistant_message",
      markdown: { text },
    });
    const projector = new ConversationProjector({
      backendInstanceId: "backend",
      bindingIdentity: "message-text",
    });
    const projected = projector.replace(
      {
        orderedBackendTurnIds: ["turn"],
        turnsById: {
          turn: {
            backendTurnId: "turn",
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: ["message"],
          },
        },
        itemsById: { message: item },
        runState: "idle",
      },
      -1,
    );
    expect(Object.values(projected.itemsById)[0]).toMatchObject({
      kind: "assistant_message",
      markdown: { text },
    });
    for (const schema of [backendItemSchema, conversationItemSchema]) {
      const isBackend = schema === backendItemSchema;
      expect(
        schema.parse({
          ...(isBackend ? backendBase : browserBase),
          [isBackend ? "semanticKind" : "kind"]: "user_message",
          content: [{ kind: "text", text: { text } }],
        }),
      ).toMatchObject({ content: [{ kind: "text", text: { text } }] });
    }
  });

  it("rejects truncated messages while preserving preview contracts", () => {
    const truncated = {
      text: "partial…",
      truncation: { truncated: true, retainedBytes: 10, reason: "byte_limit" },
    };
    expect(messageTextSchema.safeParse(truncated).success).toBe(false);
    expect(
      conversationItemSchema.safeParse({
        ...browserBase,
        kind: "assistant_message",
        markdown: truncated,
      }).success,
    ).toBe(false);
    expect(
      conversationItemSchema.safeParse({
        ...browserBase,
        kind: "reasoning",
        markdown: truncated,
      }).success,
    ).toBe(true);
    expect(
      conversationItemSchema.safeParse({
        ...browserBase,
        kind: "reasoning",
        markdown: { text: "x".repeat(65_537) },
      }).success,
    ).toBe(false);
  });

  it("enforces exact serialized UTF-8 text and complete item bounds", () => {
    const text = "x".repeat(
      MAXIMUM_MESSAGE_TEXT_BYTES - serializedUtf8Bytes({ text: "" }),
    );
    expect(serializedUtf8Bytes(preserveMessageText(text))).toBe(
      MAXIMUM_MESSAGE_TEXT_BYTES,
    );
    expect(messageTextSchema.safeParse({ text }).success).toBe(true);
    expect(() => preserveMessageText(text + "x")).toThrow(
      "normalized_payload_exceeds_serialized_byte_limit",
    );
    expect(messageTextSchema.safeParse({ text: text + "x" }).success).toBe(
      false,
    );
    expect(
      conversationItemSchema.safeParse({
        ...browserBase,
        kind: "assistant_message",
        markdown: { text },
      }).success,
    ).toBe(false);
    const empty = {
      ...browserBase,
      kind: "assistant_message",
      markdown: { text: "" },
    };
    const exactItem = {
      ...empty,
      markdown: {
        text: "x".repeat(
          MAXIMUM_MESSAGE_ITEM_BYTES - serializedUtf8Bytes(empty),
        ),
      },
    };
    expect(conversationItemSchema.safeParse(exactItem).success).toBe(true);
    expect(
      conversationItemSchema.safeParse({
        ...exactItem,
        markdown: { text: exactItem.markdown.text + "x" },
      }).success,
    ).toBe(false);
    const part = {
      kind: "text",
      text: { text: "x".repeat(9 * 1_024 * 1_024) },
    };
    expect(
      backendItemSchema.safeParse({
        ...backendBase,
        semanticKind: "user_message",
        content: [part, part],
      }).success,
    ).toBe(false);
  });
});
