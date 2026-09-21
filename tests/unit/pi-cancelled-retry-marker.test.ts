import { expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cancelledPiRetryEntries, createPiCancelledRetryMarker, piCancelledRetryMarkerType } from "../../src/server/backends/pi/pi-cancelled-retry-marker.js";

it("accepts only scoped cancellation evidence following the matching errored attempt", () => {
  const authentication = { conversationId: "conversation", installationKey: new Uint8Array(32).fill(7) };
  const error = { type: "message", id: "assistant", message: { role: "assistant", stopReason: "error" } } as SessionEntry;
  const marker = { type: "custom", id: "marker", customType: piCancelledRetryMarkerType,
    data: createPiCancelledRetryMarker(error.id, authentication) } as SessionEntry;
  expect([...cancelledPiRetryEntries([error, marker], authentication)]).toEqual([error.id]);
  expect(cancelledPiRetryEntries([error, marker])).toHaveProperty("size", 0);
  expect(cancelledPiRetryEntries([error, marker], { ...authentication, conversationId: "other" })).toHaveProperty("size", 0);
  expect(cancelledPiRetryEntries([error, marker], { ...authentication, installationKey: new Uint8Array(32).fill(8) })).toHaveProperty("size", 0);
  expect(cancelledPiRetryEntries([marker, error], authentication)).toHaveProperty("size", 0);
  const user = { type: "message", id: "next-user", message: { role: "user" } } as SessionEntry;
  expect(cancelledPiRetryEntries([error, user, marker], authentication)).toHaveProperty("size", 0);
  for (const data of [null, {}, { assistantEntryId: error.id, tag: "fake" }, { ...(marker as Extract<SessionEntry, {type: "custom"}>).data as object, extra: true }]) {
    expect(cancelledPiRetryEntries([error, { ...marker, data } as SessionEntry], authentication)).toHaveProperty("size", 0);
  }
});
