import { describe, expect, it } from "vitest";
import {
  parseClaudeBindingDetail,
  serializeClaudeBindingDetail,
} from "../../src/server/backends/claude/claude-binding-codec.js";

const sessionId = "019196f7-a0a8-7bc4-a89b-8cf013978405";

describe("Claude binding codec", () => {
  it("round trips the one canonical provider-private identity shape", () => {
    const serialized = serializeClaudeBindingDetail({ version: 1, sessionId });
    expect(serialized).toBe(`{"version":1,"sessionId":"${sessionId}"}`);
    expect(parseClaudeBindingDetail(serialized)).toEqual({
      version: 1,
      sessionId,
    });
  });

  it.each([
    "not-json",
    "{}",
    `{"version":2,"sessionId":"${sessionId}"}`,
    `{"version":1,"sessionId":"not-a-uuid"}`,
    `{"version":1,"sessionId":"${sessionId}","token":"secret"}`,
  ])("rejects invalid or expanded binding detail: %s", (value) => {
    expect(() => parseClaudeBindingDetail(value)).toThrow();
  });
});
