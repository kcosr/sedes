import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ContextExcerpt } from "../../src/shared/protocol/context-excerpts.js";
import {
  createPiContextExcerptMarker,
  piContextExcerptMarkerType,
  readPiContextExcerptMarker,
} from "../../src/server/backends/pi/pi-context-excerpt-marker.js";

const authentication = {
  conversationId: "conversation-1",
  installationKey: new Uint8Array(32).fill(0x42),
};
const excerpt: ContextExcerpt = {
  id: "0d1bfa8b-dc37-4f52-8b0e-f8181ac0a7e9",
  excerpt: "selected text",
  source: {
    kind: "conversation_message",
    itemId: "normalized-message-item-1",
    itemRevision: 2,
  },
  locator: {
    kind: "text_quote",
    prefix: "prefix ",
    suffix: " suffix",
  },
};

function entry(data: unknown): SessionEntry {
  return {
    type: "custom",
    id: "marker-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: piContextExcerptMarkerType,
    data,
  } as SessionEntry;
}

describe("Pi context excerpt markers", () => {
  it("authenticates the exact ordered excerpt snapshot", () => {
    const marker = createPiContextExcerptMarker(
      {
        applicationOperationId: "operation-1",
        requestFingerprint: "a".repeat(64),
        contextExcerpts: [excerpt],
      },
      authentication,
    );
    expect(readPiContextExcerptMarker(entry(marker), authentication)).toEqual({
      status: "authenticated",
      marker,
    });
  });

  it("rejects tampering and another conversation identity", () => {
    const marker = createPiContextExcerptMarker(
      {
        applicationOperationId: "operation-1",
        requestFingerprint: "a".repeat(64),
        contextExcerpts: [excerpt],
      },
      authentication,
    );
    expect(
      readPiContextExcerptMarker(
        entry({
          ...marker,
          contextExcerpts: [{ ...excerpt, excerpt: "changed" }],
        }),
        authentication,
      ),
    ).toEqual({ status: "unauthenticated" });
    expect(
      readPiContextExcerptMarker(entry(marker), {
        ...authentication,
        conversationId: "conversation-2",
      }),
    ).toEqual({ status: "unauthenticated" });
  });

  it("rejects malformed and empty marker payloads", () => {
    expect(readPiContextExcerptMarker(entry({}), authentication)).toEqual({
      status: "malformed",
    });
    expect(() =>
      createPiContextExcerptMarker(
        {
          applicationOperationId: "operation-1",
          requestFingerprint: "a".repeat(64),
          contextExcerpts: [],
        },
        authentication,
      ),
    ).toThrow("pi_context_excerpt_marker_invalid");
  });
});
