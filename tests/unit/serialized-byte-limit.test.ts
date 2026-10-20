import { describe, expect, it } from "vitest";
import { z } from "zod";
import { conversationItemSchema } from "../../src/shared/protocol/conversation.js";
import {
  MAXIMUM_MESSAGE_ITEM_BYTES,
  MAXIMUM_MESSAGE_TEXT_BYTES,
  messageTextSchema,
  requireSerializedByteLimit,
  serializedUtf8Bytes,
} from "../../src/shared/protocol/payload.js";

const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;

const samples: unknown[] = [
  "",
  "plain ascii",
  "quotes \" and \\ backslashes",
  "\u0000\u0001\u001f control characters",
  "é ü ß 中文 ✓",
  "emoji 😀 pair",
  "lone \ud800 high and \udc00 low surrogates",
  0,
  -0.0000012345678901234567,
  -1.2345678901234567e-308,
  Number.MAX_SAFE_INTEGER,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  null,
  [],
  {},
  [undefined, () => undefined, Symbol("omitted"), null],
  { kept: 1, omitted: undefined, method: () => undefined },
  { nested: [{ deeper: ["\u0000".repeat(40), "😀".repeat(20)] }, { "kéy\u0001": "välue" }] },
  { at: new Date(0) },
  { custom: { toJSON: () => "x".repeat(100) } },
  Object.assign([1], { toJSON: () => "x".repeat(100) }),
  Array.from({ length: 600 }, (_, index) => ({ index })),
];

function limitedSchema(maximumBytes: number) {
  return z.unknown().superRefine((value, context) =>
    requireSerializedByteLimit(value, context, maximumBytes, "too large"));
}

describe("serialized byte limits", () => {
  it("measures the UTF-8 bytes of the JSON serialization", () => {
    for (const value of samples) expect(serializedUtf8Bytes(value)).toBe(encoded(value));
    expect(serializedUtf8Bytes(undefined)).toBe(0);
  });

  it("enforces every limit exactly, including values bounded without serializing", () => {
    for (const value of samples) {
      const exact = encoded(value);
      expect(limitedSchema(exact).safeParse(value).success).toBe(true);
      expect(limitedSchema(exact + 1_000_000).safeParse(value).success).toBe(true);
      if (exact > 0) expect(limitedSchema(exact - 1).safeParse(value).success).toBe(false);
    }
  });

  it("accepts message text at the byte limit and rejects one byte more", () => {
    // `{"text":"…"}` adds 11 bytes around the text.
    const ascii = "a".repeat(MAXIMUM_MESSAGE_TEXT_BYTES - 11);
    expect(messageTextSchema.safeParse({ text: ascii }).success).toBe(true);
    expect(messageTextSchema.safeParse({ text: `${ascii}a` }).success).toBe(false);
    // Each control character serializes as a six-byte escape.
    const escapes = "\u0001".repeat(Math.floor((MAXIMUM_MESSAGE_TEXT_BYTES - 11) / 6));
    const padding = "a".repeat(MAXIMUM_MESSAGE_TEXT_BYTES - 11 - escapes.length * 6);
    expect(messageTextSchema.safeParse({ text: escapes + padding }).success).toBe(true);
    expect(messageTextSchema.safeParse({ text: `${escapes}\u0001${padding}` }).success).toBe(false);
  });

  it("accepts a message item at the byte limit and rejects one byte more", () => {
    const item = { id: "item", turnId: "turn", kind: "assistant_message", status: "completed", revision: 1, markdown: { text: "" } };
    const text = "a".repeat(MAXIMUM_MESSAGE_ITEM_BYTES - encoded(item));
    expect(conversationItemSchema.safeParse({ ...item, markdown: { text } }).success).toBe(true);
    const rejected = conversationItemSchema.safeParse({ ...item, markdown: { text: `${text}a` } });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.map(issue => issue.message)).toContain("Message item exceeds the serialized byte limit.");
  });
});
