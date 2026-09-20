import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiHistoryProjector } from "../../src/server/backends/pi/pi-history-projector.js";
import { projectPiUserMessageContent } from "../../src/server/backends/pi/pi-skill-message.js";
import { backendItemSchema } from "../../src/shared/protocol/backend.js";
import { MAXIMUM_MESSAGE_TEXT_BYTES } from "../../src/shared/protocol/payload.js";

describe("Pi ordinary conversation text", () => {
  it("preserves long Unicode history and text parts beyond the former preview limit", () => {
    const text = "message 雪🙂\n".repeat(10_000);
    const userParts = Array.from({ length: 125 }, (_, index) => ({ type: "text", text: `${index}:` }));
    userParts.push({ type: "text", text });
    const branch = [
      { type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: userParts, timestamp: 0 } },
      { type: "message", id: "assistant", parentId: "user", timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1, stopReason: "stop" } },
    ] as unknown as SessionEntry[];
    const { snapshot } = new PiHistoryProjector({}).project(branch);
    const user = snapshot.itemsById["user:user"]!;
    const assistant = snapshot.itemsById["assistant:0"]!;
    expect(user).toMatchObject({ content: [{ kind: "text", text: { text: userParts.map((part) => part.text).join("") } }] });
    expect(assistant).toMatchObject({ markdown: { text } });
    expect(backendItemSchema.safeParse(user).success).toBe(true);
    expect(backendItemSchema.safeParse(assistant).success).toBe(true);
  });

  it("rejects unsupported user text instead of returning a clipped prefix", () => {
    expect(() => projectPiUserMessageContent("x".repeat(MAXIMUM_MESSAGE_TEXT_BYTES)))
      .toThrow("normalized_payload_exceeds_serialized_byte_limit");
  });
});
