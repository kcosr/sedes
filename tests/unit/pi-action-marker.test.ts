import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  createPiActionMarker,
  findPiActionState,
  piActionMarkerType,
} from "../../src/server/backends/pi/pi-action-marker.js";

const action = {
  applicationOperationId: "compact-operation",
  action: "compact" as const,
  instructions: "Keep the decisions.",
};

function marker(
  id: string,
  phase: "started" | "completed",
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-07-30T12:00:00.000Z",
    customType: piActionMarkerType,
    data: createPiActionMarker(action, phase),
  } as SessionEntry;
}

describe("Pi durable backend-action markers", () => {
  it("distinguishes retryable start, durable compaction evidence, and completion", () => {
    expect(findPiActionState([], action)).toEqual({ state: "none" });
    expect(findPiActionState([marker("start", "started")], action)).toMatchObject(
      {
        state: "started",
        startedIndex: 0,
        compactObserved: false,
      },
    );
    const compaction = {
      type: "compaction",
      id: "compaction",
      parentId: "start",
      timestamp: "2026-07-30T12:00:01.000Z",
      summary: "Summary",
      firstKeptEntryId: "start",
      tokensBefore: 10,
    } as SessionEntry;
    expect(
      findPiActionState(
        [marker("start", "started"), compaction],
        action,
      ),
    ).toMatchObject({
      state: "started",
      startedIndex: 0,
      compactObserved: true,
    });
    expect(
      findPiActionState(
        [
          marker("start", "started"),
          compaction,
          marker("complete", "completed"),
        ],
        action,
      ),
    ).toMatchObject({
      state: "completed",
      compactObserved: true,
    });
  });

  it("rejects a reused operation identity with another request", () => {
    expect(() =>
      findPiActionState([marker("start", "started")], {
        ...action,
        instructions: "Different request.",
      }),
    ).toThrow("pi_action_replay_mismatch");
  });
});
