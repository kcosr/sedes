import { describe, expect, it } from "vitest";
import {
  applicationTurnIdForBackendTurn,
  ConversationProjector,
} from "../../src/server/conversations/conversation-projector.js";
import { deriveConnectionProfileId } from "../../src/server/db/connection-profile-id.js";

describe("stable application identities", () => {
  it("keeps the persisted conversation turn and item hash family stable", () => {
    expect(
      applicationTurnIdForBackendTurn({
        backendInstanceId: "backend-a",
        sourceApplicationThreadId: "thread-a",
        backendTurnId: "native-turn-a",
      }),
    ).toBe("turn_Uv5IF6oWn8cQEIVOBWFCIJcVVdJpafzw");

    const timeline = new ConversationProjector({
      backendInstanceId: "backend-a",
      bindingIdentity: "thread-a",
    }).replace(
      {
        orderedBackendTurnIds: ["native-turn-a"],
        turnsById: {
          "native-turn-a": {
            backendTurnId: "native-turn-a",
            status: "completed",
            endedBy: "agent_settled",
            orderedBackendItemIds: ["native-item-a"],
          },
        },
        itemsById: {
          "native-item-a": {
            backendItemId: "native-item-a",
            backendTurnId: "native-turn-a",
            semanticKind: "assistant_message",
            status: "completed",
            sourceOrder: 0,
            markdown: { text: "Stable" },
          },
        },
        runState: "idle",
      },
      -1,
    );
    expect(timeline.orderedTurnIds).toEqual([
      "turn_Uv5IF6oWn8cQEIVOBWFCIJcVVdJpafzw",
    ]);
    expect(Object.keys(timeline.itemsById)).toEqual([
      "item_pTbNvSbzIkfKQNMerzQ2kJ8TzHmqrv7-",
    ]);
  });

  it("keeps deterministic connection profile IDs stable", () => {
    expect(
      deriveConnectionProfileId("tenant-a", "principal-a", "template-a"),
    ).toBe("a709a85c-f457-5da2-98c0-4164c4d4456a");
  });
});
