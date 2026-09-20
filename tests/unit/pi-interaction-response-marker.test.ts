import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { InteractionResponseInput } from "../../src/server/backends/contracts.js";
import {
  createPiInteractionResponseMarker,
  findPiInteractionResponseState,
  piInteractionResponseMarkerType,
} from "../../src/server/backends/pi/pi-interaction-response-marker.js";

const response: InteractionResponseInput = {
  applicationOperationId: "operation-1",
  interactionId: "pi-interaction-1",
  kind: "confirmation",
  confirmed: true,
};

function entry(
  phase: "started" | "completed",
  input: InteractionResponseInput = response,
): SessionEntry {
  return {
    id: `marker-${phase}`,
    parentId: null,
    timestamp: "2026-07-30T15:00:00.000Z",
    type: "custom",
    customType: piInteractionResponseMarkerType,
    data: createPiInteractionResponseMarker(input, phase),
  } as SessionEntry;
}

describe("Pi interaction response markers", () => {
  it("correlates an exact durable started/completed sequence", () => {
    expect(findPiInteractionResponseState([], response)).toEqual({
      state: "none",
    });
    expect(findPiInteractionResponseState([entry("started")], response))
      .toMatchObject({
        state: "started",
      });
    expect(
      findPiInteractionResponseState(
        [entry("started"), entry("completed")],
        response,
      ),
    ).toMatchObject({ state: "completed" });
  });

  it("rejects operation-ID reuse with a different response target or value", () => {
    expect(() =>
      findPiInteractionResponseState(
        [entry("started")],
        { ...response, confirmed: false },
      ),
    ).toThrow("replay_mismatch");
    expect(() =>
      findPiInteractionResponseState(
        [entry("started")],
        { ...response, interactionId: "pi-interaction-2" },
      ),
    ).toThrow("replay_mismatch");
  });

  it("rejects duplicate and out-of-order durable transitions", () => {
    expect(() =>
      findPiInteractionResponseState(
        [entry("started"), entry("started")],
        response,
      ),
    ).toThrow("started_marker_invalid");
    expect(() =>
      findPiInteractionResponseState([entry("completed")], response),
    ).toThrow("completed_marker_invalid");
  });
});
