import { createHmac } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { MaterializedTaskContext } from "../../src/server/domain/materialized-task-contexts.js";
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

// Exact bytes of a snapshot delivered while Tasks still had workspace scope.
const legacyTaskJson =
  '{"id":"10000000-0000-4000-8000-000000000002","scope":{"kind":"workspace","workspaceId":"20000000-0000-4000-8000-000000000002"},"title":"Legacy workspace task","details":"Delivered before projects existed.","pinned":false,"files":["/workspace/src/legacy.ts"],"completedAt":null,"revision":6,"createdAt":"2026-08-10T12:00:00.000Z","updatedAt":"2026-08-10T13:00:00.000Z"}';
const legacyTask = JSON.parse(legacyTaskJson) as MaterializedTaskContext;
const projectTask: MaterializedTaskContext = {
  ...task,
  scope: {
    kind: "project",
    projectId: "30000000-0000-4000-8000-000000000001",
  },
};

function entry(
  data: unknown,
  id = "marker-1",
  customType = piTaskContextMarkerType,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-08-11T15:00:00.000Z",
    customType,
    data,
  } as SessionEntry;
}

/**
 * A marker as persisted in a Pi session before project scope existed, signed
 * independently of the production serializer over its literal snapshot bytes.
 */
function historicalLegacyMarker(
  markerType: string,
  taskJson = legacyTaskJson,
): unknown {
  const authenticatedBytes = `["${markerType}","${authentication.conversationId}","operation-1","${"a".repeat(64)}",[${taskJson}]]`;
  const tag = createHmac("sha256", authentication.installationKey)
    .update(authenticatedBytes, "utf8")
    .digest("base64url");
  return JSON.parse(
    `{"version":1,"applicationOperationId":"operation-1","requestFingerprint":"${"a".repeat(64)}","taskContexts":[${taskJson}],"authentication":{"algorithm":"hmac-sha256","tag":"${tag}"}}`,
  );
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

  it.each(["sedes.task_contexts.v1", "harness.task_contexts.v1"])(
    "authenticates a historical %s marker whose snapshot has workspace scope",
    (markerType) => {
      const historical = historicalLegacyMarker(markerType);
      expect(
        readPiTaskContextMarker(
          entry(historical, "marker-1", markerType),
          authentication,
        ),
      ).toEqual({ status: "authenticated", marker: historical });
      expect(
        findPiTaskContextsForSubmission(
          [entry(historical, "marker-1", markerType)],
          "operation-1",
          "a".repeat(64),
          authentication,
        ),
      ).toEqual([legacyTask]);
    },
  );

  it("re-signs a workspace-scope snapshot to the same tag a historical marker carries", () => {
    const historical = historicalLegacyMarker(piTaskContextMarkerType) as {
      readonly authentication: { readonly tag: string };
    };
    expect(
      createPiTaskContextMarker(
        {
          applicationOperationId: "operation-1",
          requestFingerprint: "a".repeat(64),
          taskContexts: [legacyTask],
        },
        authentication,
      ),
    ).toEqual(historical);
    expect(historical.authentication.tag).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("authenticates a current project-scope marker", () => {
    const marker = createPiTaskContextMarker(
      {
        applicationOperationId: "operation-1",
        requestFingerprint: "a".repeat(64),
        taskContexts: [projectTask],
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
    ).toEqual([projectTask]);
  });

  it("fails closed for a tampered or malformed workspace-scope marker", () => {
    const historical = historicalLegacyMarker(piTaskContextMarkerType) as {
      readonly taskContexts: readonly MaterializedTaskContext[];
    };
    expect(
      readPiTaskContextMarker(
        entry({
          ...historical,
          taskContexts: [
            {
              ...legacyTask,
              scope: {
                kind: "workspace",
                workspaceId: "20000000-0000-4000-8000-000000000099",
              },
            },
          ],
        }),
        authentication,
      ),
    ).toEqual({ status: "unauthenticated" });
    // A validly signed snapshot whose legacy scope has another shape is
    // never accepted, even under its own tag.
    for (const scope of [
      '{"kind":"workspace","workspaceId":"20000000-0000-4000-8000-000000000002","projectId":"30000000-0000-4000-8000-000000000001"}',
      '{"kind":"workspace","projectId":"30000000-0000-4000-8000-000000000001"}',
      '{"kind":"workspace","workspaceId":"not-a-workspace-id"}',
    ]) {
      const malformed = historicalLegacyMarker(
        piTaskContextMarkerType,
        legacyTaskJson.replace(
          '{"kind":"workspace","workspaceId":"20000000-0000-4000-8000-000000000002"}',
          scope,
        ),
      );
      expect(readPiTaskContextMarker(entry(malformed), authentication)).toEqual(
        { status: "malformed" },
      );
      expect(
        findPiTaskContextsForSubmission(
          [entry(malformed)],
          "operation-1",
          "a".repeat(64),
          authentication,
        ),
      ).toBeUndefined();
    }
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
