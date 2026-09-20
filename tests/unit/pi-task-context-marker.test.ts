import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { MaterializedTaskContext } from "../../src/shared/protocol/tasks.js";
import {
  createPiTaskContextMarker,
  findPiTaskContextsForSubmission,
  piTaskContextMarkerType,
  readPiTaskContextMarker,
} from "../../src/server/backends/pi/pi-task-context-marker.js";

const authentication = {
  conversationId: "conversation-1",
  installationKey: new Uint8Array(32).fill(0x42),
};
const task: MaterializedTaskContext = {
  id: "10000000-0000-4000-8000-000000000001",
  scope: { kind: "global" },
  title: "Authenticated task",
  details: "Keep the immutable snapshot.",
  pinned: true,
  files: [],
  completedAt: "2026-08-11T14:00:00.000Z",
  revision: 4,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T14:00:00.000Z",
};

function entry(data: unknown, id = "marker-1"): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-08-11T15:00:00.000Z",
    customType: piTaskContextMarkerType,
    data,
  } as SessionEntry;
}

describe("Pi task-context markers", () => {
  it("authenticates the exact ordered task snapshots", () => {
    const marker = createPiTaskContextMarker(
      {
        applicationOperationId: "operation-1",
        requestFingerprint: "a".repeat(64),
        taskContexts: [task],
      },
      authentication,
    );
    expect(readPiTaskContextMarker(entry(marker), authentication)).toEqual({
      status: "authenticated",
      marker,
    });
    expect(
      findPiTaskContextsForSubmission(
        [entry(marker)],
        "operation-1",
        "a".repeat(64),
        authentication,
      ),
    ).toEqual([task]);
  });

  it("rejects tampering, another conversation, and duplicate proof", () => {
    const marker = createPiTaskContextMarker(
      {
        applicationOperationId: "operation-1",
        requestFingerprint: "a".repeat(64),
        taskContexts: [task],
      },
      authentication,
    );
    expect(
      readPiTaskContextMarker(
        entry({ ...marker, taskContexts: [{ ...task, revision: 5 }] }),
        authentication,
      ),
    ).toEqual({ status: "unauthenticated" });
    expect(
      readPiTaskContextMarker(entry(marker), {
        ...authentication,
        conversationId: "conversation-2",
      }),
    ).toEqual({ status: "unauthenticated" });
    expect(
      findPiTaskContextsForSubmission(
        [entry(marker), entry(marker, "marker-2")],
        "operation-1",
        "a".repeat(64),
        authentication,
      ),
    ).toBeUndefined();
  });

  it("rejects malformed and empty marker payloads", () => {
    expect(readPiTaskContextMarker(entry({}), authentication)).toEqual({
      status: "malformed",
    });
    expect(() =>
      createPiTaskContextMarker(
        {
          applicationOperationId: "operation-1",
          requestFingerprint: "a".repeat(64),
          taskContexts: [],
        },
        authentication,
      ),
    ).toThrow("pi_task_context_marker_invalid");
  });
});
