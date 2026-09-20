import { describe, expect, it } from "vitest";
import type {
  BackendConversationSnapshot,
  BackendItem,
  BackendTurn,
} from "../../src/shared/protocol/backend.js";
import {
  selectPiHistoryPage,
  selectPiSnapshotWindow,
} from "../../src/server/backends/pi/pi-conversation-driver.js";
import { serializedUtf8Bytes } from "../../src/shared/protocol/payload.js";

const LARGE_TEXT = "x".repeat(65_536);

function timeline(
  turnCount: number,
  itemsPerTurn: number,
  text = LARGE_TEXT,
): BackendConversationSnapshot {
  const turns: BackendTurn[] = [];
  const items: BackendItem[] = [];
  for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
    const backendTurnId = `turn-${turnIndex}`;
    const turnItems: BackendItem[] = Array.from(
      { length: itemsPerTurn },
      (_, itemIndex) => ({
        backendItemId: `${backendTurnId}-item-${itemIndex}`,
        backendTurnId,
        semanticKind: "assistant_message" as const,
        status: "completed" as const,
        sourceOrder: itemIndex,
        markdown: { text },
      }),
    );
    items.push(...turnItems);
    turns.push({
      backendTurnId,
      status: "completed",
      endedBy: "agent_settled",
      orderedBackendItemIds: turnItems.map(
        ({ backendItemId }) => backendItemId,
      ),
    });
  }
  return {
    orderedBackendTurnIds: turns.map(({ backendTurnId }) => backendTurnId),
    turnsById: Object.fromEntries(
      turns.map((turn) => [turn.backendTurnId, turn]),
    ),
    itemsById: Object.fromEntries(
      items.map((item) => [item.backendItemId, item]),
    ),
    runState: "idle",
  };
}

describe("Pi aggregate timeline selection", () => {
  it("selects a contiguous whole-turn suffix under both count and byte caps", () => {
    const full = timeline(3, 32);
    const selected = selectPiSnapshotWindow(full, 100, "leaf");

    expect(selected.orderedBackendTurnIds).toEqual(["turn-2"]);
    expect(Object.keys(selected.turnsById)).toEqual(["turn-2"]);
    expect(Object.keys(selected.itemsById)).toHaveLength(32);
    expect(
      Object.values(selected.itemsById).every(
        ({ backendTurnId }) => backendTurnId === "turn-2",
      ),
    ).toBe(true);
  });

  it("returns exact previous cursors for byte-limited history pages", () => {
    const full = timeline(3, 32);
    const first = selectPiHistoryPage(full, "leaf", 3, 100);
    expect(first.orderedBackendTurnIds).toEqual(["turn-2"]);
    expect(first.previousCursor).toBe("pi-history:leaf:2");

    const second = selectPiHistoryPage(full, "leaf", 2, 100);
    expect(second.orderedBackendTurnIds).toEqual(["turn-1"]);
    expect(second.previousCursor).toBe("pi-history:leaf:1");

    const third = selectPiHistoryPage(full, "leaf", 1, 100);
    expect(third.orderedBackendTurnIds).toEqual(["turn-0"]);
    expect(third.previousCursor).toBeUndefined();
  });

  it("targets a responsive byte window while preserving a contiguous suffix", () => {
    const full = timeline(100, 1);
    const selected = selectPiSnapshotWindow(full, 100, "leaf");
    const selectedIds = selected.orderedBackendTurnIds;

    expect(selectedIds.length).toBeGreaterThan(1);
    expect(selectedIds.length).toBeLessThan(100);
    expect(selectedIds).toEqual(
      full.orderedBackendTurnIds.slice(-selectedIds.length),
    );
    expect(serializedUtf8Bytes(selected)).toBeLessThanOrEqual(256 * 1_024);

    const page = selectPiHistoryPage(full, "leaf", 100, 100);
    expect(page.orderedBackendTurnIds).toEqual(selectedIds);
    expect(page.previousCursor).toBe(
      `pi-history:leaf:${100 - selectedIds.length}`,
    );
  });

  it("fails explicitly rather than splitting an oversized turn", () => {
    const oversized = timeline(1, 65);
    expect(() => selectPiSnapshotWindow(oversized, 100, "leaf")).toThrowError(
      expect.objectContaining({ backendCode: "pi_turn_payload_too_large" }),
    );
    expect(() => selectPiHistoryPage(oversized, "leaf", 1, 100)).toThrowError(
      expect.objectContaining({ backendCode: "pi_turn_payload_too_large" }),
    );

    const tooManyItems = timeline(1, 1_001, "x");
    expect(() =>
      selectPiSnapshotWindow(tooManyItems, 100, "leaf"),
    ).toThrowError(
      expect.objectContaining({ backendCode: "pi_turn_payload_too_large" }),
    );
    expect(() =>
      selectPiHistoryPage(tooManyItems, "leaf", 1, 100),
    ).toThrowError(
      expect.objectContaining({ backendCode: "pi_turn_payload_too_large" }),
    );
  });
});
