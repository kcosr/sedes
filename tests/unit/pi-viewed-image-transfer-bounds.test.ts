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

const maximumPiSnapshotOrPageBytes = 4 * 1_024 * 1_024;

interface TurnShape {
  /** Assistant text items before the viewed images. */
  readonly texts?: number;
  readonly textBytes?: number;
  readonly viewed?: number;
  readonly children?: boolean;
}

function turnItems(backendTurnId: string, shape: TurnShape): BackendItem[] {
  const items: BackendItem[] = [];
  let sourceOrder = 0;
  const text = "x".repeat(shape.textBytes ?? 8);
  for (let index = 0; index < (shape.texts ?? 0); index += 1) {
    items.push({
      backendItemId: `${backendTurnId}:text:${index}`,
      backendTurnId,
      semanticKind: "assistant_message",
      responsePhase: "unclassified",
      status: "completed",
      sourceOrder: sourceOrder++,
      markdown: { text },
    });
  }
  for (let index = 0; index < (shape.viewed ?? 0); index += 1) {
    const viewedItemId = `${backendTurnId}:viewed:${index}`;
    items.push({
      backendItemId: viewedItemId,
      backendTurnId,
      semanticKind: "viewed_image",
      status: "completed",
      sourceOrder: sourceOrder++,
      fileName: { text: `shot-${index}.png` },
    });
    const childOrder = sourceOrder++;
    if (shape.children === false) continue;
    items.push({
      backendItemId: `${viewedItemId}:image`,
      backendTurnId,
      semanticKind: "image",
      status: "completed",
      sourceOrder: childOrder,
      origin: { kind: "viewed", capture: "provider_input" },
      image: {
        representation: "artifact",
        artifactId: "5f0c6b8e-4a1d-4c3b-8e2f-9a7d6c5b4a3f",
        mimeType: "image/png",
        byteSize: 70,
        sha256: "a".repeat(64),
        fileName: { text: `shot-${index}.png` },
      },
    });
  }
  return items;
}

function timeline(shapes: readonly TurnShape[]): BackendConversationSnapshot {
  const turns: BackendTurn[] = [];
  const items: BackendItem[] = [];
  for (const [index, shape] of shapes.entries()) {
    const backendTurnId = `turn-${index}`;
    const own = turnItems(backendTurnId, shape);
    items.push(...own);
    turns.push({
      backendTurnId,
      status: "completed",
      endedBy: "agent_settled",
      orderedBackendItemIds: own.map(({ backendItemId }) => backendItemId),
    });
  }
  return {
    orderedBackendTurnIds: turns.map(({ backendTurnId }) => backendTurnId),
    turnsById: Object.fromEntries(turns.map((turn) => [turn.backendTurnId, turn])),
    itemsById: Object.fromEntries(items.map((item) => [item.backendItemId, item])),
    runState: "idle",
  };
}

function children(snapshot: { readonly itemsById: Record<string, BackendItem> }) {
  return Object.values(snapshot.itemsById).filter((item) => item.semanticKind === "image");
}

describe("Pi transfer bounds with viewed-image children", () => {
  it("keeps children out of Pi's per-turn item bound", () => {
    // 262 assistant texts and 520 image reads: 782 counted items, 1302 with children.
    const full = timeline([{ texts: 262, viewed: 520 }]);
    expect(full.turnsById["turn-0"]!.orderedBackendItemIds).toHaveLength(1_302);

    const window = selectPiSnapshotWindow(full, 10, "session");
    expect(window.turnsById["turn-0"]!.orderedBackendItemIds).toHaveLength(1_302);
    expect(children(window)).toHaveLength(520);
    const page = selectPiHistoryPage(full, "session", 1, 10);
    expect(page.turnsById["turn-0"]!.orderedBackendItemIds).toHaveLength(1_302);

    // The bound itself is unchanged for counted items.
    expect(() =>
      selectPiSnapshotWindow(timeline([{ texts: 1_001 }]), 10, "session"),
    ).toThrow(expect.objectContaining({ backendCode: "pi_turn_payload_too_large" }));
  });

  it("selects the same turns with or without children", () => {
    const shapes = Array.from({ length: 12 }, () => ({
      texts: 1,
      textBytes: 20_000,
      viewed: 40,
    }));
    const withChildren = timeline(shapes);
    const withoutChildren = timeline(shapes.map((shape) => ({ ...shape, children: false })));
    const expected = selectPiSnapshotWindow(withoutChildren, 10, "session");
    // The children alone would push this window past the byte target.
    expect(serializedUtf8Bytes(withChildren) - serializedUtf8Bytes(withoutChildren)).toBeGreaterThan(
      256 * 1_024 - serializedUtf8Bytes(expected),
    );

    const window = selectPiSnapshotWindow(withChildren, 10, "session");
    expect(window.orderedBackendTurnIds).toEqual(expected.orderedBackendTurnIds);
    expect(children(window)).toHaveLength(40 * window.orderedBackendTurnIds.length);
    const page = selectPiHistoryPage(withChildren, "session", 12, 10);
    expect(page.orderedBackendTurnIds).toEqual(
      selectPiHistoryPage(withoutChildren, "session", 12, 10).orderedBackendTurnIds,
    );
  });

  it("returns the rows without their children when the children would exceed the byte ceiling", () => {
    const rowsOnly = timeline([{ texts: 1, viewed: 200, children: false }]);
    const filler = maximumPiSnapshotOrPageBytes - serializedUtf8Bytes(rowsOnly) - 2_048;
    const full = timeline([{ texts: 1, textBytes: filler, viewed: 200 }]);
    expect(serializedUtf8Bytes(full)).toBeGreaterThan(maximumPiSnapshotOrPageBytes);

    const window = selectPiSnapshotWindow(full, 10, "session");
    expect(children(window)).toEqual([]);
    expect(
      Object.values(window.itemsById).filter((item) => item.semanticKind === "viewed_image"),
    ).toHaveLength(200);
    expect(window.turnsById["turn-0"]!.orderedBackendItemIds).toHaveLength(201);
    const page = selectPiHistoryPage(full, "session", 1, 10);
    expect(children(page)).toEqual([]);
    expect(page.turnsById["turn-0"]!.orderedBackendItemIds).toHaveLength(201);
  });
});
