import { describe, expect, it } from "vitest";
import type { GrokStoredSessionUpdate } from "../../src/server/backends/grok/grok-acp-dialect.js";
import {
  decodeGrokNativeHistoryCursor,
  latestGrokNativeHistoryCursorsByPromptId,
  latestGrokNativeHistoryCursor,
  previousGrokNativeHistoryCursor,
  projectGrokNativeHistory,
  validateGrokNativeHistoryBoundary,
} from "../../src/server/backends/grok/grok-native-history-projection.js";
import type { GrokNativeHistoryReadResult } from "../../src/server/backends/grok/grok-native-history-reader.js";

const sessionId = "native-session";
const epoch = "A".repeat(43);

function stored(offset: number): GrokStoredSessionUpdate {
  return {
    timestamp: 0,
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `answer-${offset}` },
      },
      _meta: { eventId: `event-${offset}`, promptId: `prompt-${offset}` },
    },
  };
}

function history(
  updates: readonly GrokStoredSessionUpdate[],
  promptStarts: readonly number[],
  totalCount = updates.length,
): GrokNativeHistoryReadResult {
  return { updates, promptStarts, totalCount };
}

describe("Grok native history projection", () => {
  it("preserves the nonretryable message-size disposition through stored replay ingestion", () => {
    const oversized: GrokStoredSessionUpdate = {
      timestamp: 0, method: "session/update", params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "x".repeat(16 * 1024 * 1024) },
        },
        _meta: { eventId: "oversized", promptId: "prompt-0" },
      },
    };
    expect(() => projectGrokNativeHistory(history([oversized], [0]), {
      nativeNamespaceKey: "namespace", sessionId, retainedCompletedPromptWindow: 10,
    })).toThrowError(expect.objectContaining({
      code: "grok_message_payload_too_large", retryable: false,
    }));
  });

  it("does not mint an older cursor for exactly the retained turn count", () => {
    const updates = Array.from({ length: 10 }, (_, index) => stored(index));
    expect(
      latestGrokNativeHistoryCursor(
        history(updates, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
        {
          epoch,
          retainedTurns: 10,
        },
      ),
    ).toBeUndefined();
  });

  it("mints and validates an append-stable bounded boundary cursor", () => {
    const all = Array.from({ length: 12 }, (_, index) => stored(index));
    const promptStarts = all.map((_, index) => index);
    const cursor = latestGrokNativeHistoryCursor(
      history(all.slice(1), promptStarts, 12),
      {
        epoch,
        retainedTurns: 10,
      },
    );
    expect(cursor).toBeDefined();
    expect(Buffer.byteLength(cursor!)).toBeLessThanOrEqual(512);
    const decoded = decodeGrokNativeHistoryCursor(cursor!, epoch);
    expect(decoded).toMatchObject({
      beforeOffset: 2,
      boundaryDigest: "smHE6yyhfB_IB7hctRWb-lgVeiEIjSQ5WjkAnwQgzdo",
      promptStartsPrefixHash: "eyy5lL4Zr7tad1RXCajDS_mcq5_PzzltnvdY67enPfk",
      issuedFrontierOffset: 11,
      issuedFrontierDigest: "LpNfxkWHD81H0a3yubBq9fyNQOIuRiWBqKUgEXHk-LI",
    });
    expect(
      validateGrokNativeHistoryBoundary(
        history([all[2]!], [...promptStarts, 12], 13),
        decoded,
      ),
    ).toEqual([0, 1]);
  });

  it("keys latest cursor evidence by native prompt identity across ignored prompts", () => {
    const ignored: GrokStoredSessionUpdate = {
      timestamp: 0,
      method: "_x.ai/session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "retry_state", additive: "ignored" },
        _meta: { eventId: "ignored-event", promptId: "ignored-prompt" },
      },
    };
    const result = history([stored(0), ignored, stored(2)], [0, 1, 2]);
    const cursors = latestGrokNativeHistoryCursorsByPromptId(result, epoch);
    expect(
      decodeGrokNativeHistoryCursor(cursors["prompt-2"]!, epoch).beforeOffset,
    ).toBe(2);
  });

  it("does not let a delayed background tool identity poison the next prompt cursor", () => {
    const delayedTool: GrokStoredSessionUpdate = {
      timestamp: 0,
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "background-tool",
          status: "completed",
        },
        _meta: { eventId: "tool-event", promptId: "prompt-0" },
      },
    };
    const result = history(
      [stored(0), stored(1), delayedTool, stored(3)],
      [0, 1, 3],
    );
    const cursors = latestGrokNativeHistoryCursorsByPromptId(result, epoch);
    expect(
      decodeGrokNativeHistoryCursor(cursors["prompt-1"]!, epoch).beforeOffset,
    ).toBe(1);
    expect(
      decodeGrokNativeHistoryCursor(cursors["prompt-3"]!, epoch).beforeOffset,
    ).toBe(3);
  });

  it("invalidates epoch, boundary, and prompt-topology drift", () => {
    const all = Array.from({ length: 12 }, (_, index) => stored(index));
    const promptStarts = all.map((_, index) => index);
    const cursor = latestGrokNativeHistoryCursor(
      history(all.slice(1), promptStarts, 12),
      {
        epoch,
        retainedTurns: 10,
      },
    )!;
    expect(() => decodeGrokNativeHistoryCursor(cursor, "B".repeat(43))).toThrow(
      "grok_native_history_cursor_invalid",
    );
    const decoded = decodeGrokNativeHistoryCursor(cursor, epoch);
    expect(() =>
      validateGrokNativeHistoryBoundary(
        history([stored(99)], promptStarts, 12),
        decoded,
      ),
    ).toThrow("grok_native_history_cursor_invalid");
    expect(() =>
      validateGrokNativeHistoryBoundary(
        history(
          [all[2]!],
          promptStarts.filter((offset) => offset !== 1),
          12,
        ),
        decoded,
      ),
    ).toThrow("grok_native_history_cursor_invalid");
  });

  it("requires an earlier prompt boundary before minting another page", () => {
    const page = history([stored(4), stored(5)], [4, 5], 8);
    expect(
      previousGrokNativeHistoryCursor(page, {
        epoch,
        startOffset: 4,
        issuedFrontierOffset: 7,
        issuedFrontierDigest: "B".repeat(43),
      }),
    ).toBeUndefined();
  });

  it("rejects contradictory stored replay disposition request-locally", () => {
    const contradictory = stored(0);
    expect(() =>
      projectGrokNativeHistory(
        history(
          [
            {
              ...contradictory,
              params: {
                ...contradictory.params,
                _meta: {
                  eventId: "event-0",
                  promptId: "prompt-0",
                  isReplay: false,
                },
              },
            },
          ],
          [0],
        ),
        {
          nativeNamespaceKey: "namespace",
          sessionId,
          retainedCompletedPromptWindow: 10,
        },
      ),
    ).toThrow("grok_native_history_data_invalid");
  });
});
