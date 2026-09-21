import { describe, expect, it } from "vitest";
import { turnFailure, GENERIC_TURN_FAILURE } from "../../src/server/backends/turn-failure.js";
import { backendTurnSchema } from "../../src/shared/protocol/backend.js";
import { conversationTurnSchema } from "../../src/shared/protocol/conversation.js";

describe("turn failure diagnostics", () => {
  it("keeps actionable text while stripping terminal escapes and common credentials", () => {
    const failure = turnFailure("\x1b[31mUnknown model\x1b[0m\nBearer secret-token https://user:password@host/path?api_key=secret&token=other sk-abc123\0");
    expect(failure.message.text).toBe("Unknown model\nBearer [redacted] https://[redacted]@host/path?api_key=[redacted]&token=[redacted] [redacted]");
  });

  it("bounds multibyte diagnostics and never serializes objects or stacks", () => {
    const failure = turnFailure("模型".repeat(1000));
    expect(Buffer.byteLength(failure.message.text)).toBeLessThanOrEqual(1024);
    expect(failure.message.truncation).toBeDefined();
    for (const input of [undefined, null, {}, new Error("private"), " \n\x1b[0m"]) {
      expect(turnFailure(input).message.text).toBe(GENERIC_TURN_FAILURE);
    }
  });

  it("requires browser failed-turn detail and rejects detail on successful turns", () => {
    const browser = { id: "turn-1", revision: 0, status: "failed", orderedItemIds: [] };
    expect(conversationTurnSchema.safeParse(browser).success).toBe(false);
    expect(conversationTurnSchema.safeParse({ ...browser, failure: turnFailure("Unknown model") }).success).toBe(true);
    expect(conversationTurnSchema.safeParse({ ...browser, status: "completed", failure: turnFailure("old") }).success).toBe(false);
    const backend = { backendTurnId: "native-turn", status: "failed", orderedBackendItemIds: [] };
    expect(backendTurnSchema.safeParse(backend).success).toBe(true);
    expect(backendTurnSchema.safeParse({ ...backend, status: "interrupted", failure: turnFailure("old") }).success).toBe(false);
  });
});
