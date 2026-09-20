import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createPiSubmissionAttestation,
  findAuthenticatedPiSubmissionAttestation,
  piSubmissionAttestationType,
  readPiSubmissionAttestation,
  recoverPiTaskSubmissionAttestations,
} from "../../src/server/backends/pi/pi-submission-attestation.js";
import {
  createPiSubmissionMarker,
  piSubmissionMarkerType,
} from "../../src/server/backends/pi/pi-submission-marker.js";
import {
  createPiTaskContextMarker,
  piTaskContextMarkerType,
} from "../../src/server/backends/pi/pi-task-context-marker.js";
import { formatPiTaskContextPrompt } from "../../src/server/backends/pi/pi-task-context-message.js";

const authentication = {
  conversationId: "conversation-1",
  installationKey: new Uint8Array(32).fill(0x42),
};

function custom(id: string, customType: string, data: unknown): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType,
    data,
  } as SessionEntry;
}

const submission = createPiSubmissionMarker({
  applicationOperationId: "operation-1",
  reconciliationToken: "token-1",
  mutationId: "mutation-1",
  mode: "submit",
  text: "Hello",
  contextExcerpts: [],
  attachments: [],
  taskContexts: [],
});

describe("Pi submission attestations", () => {
  it("repairs an exact persisted task submission after the live attestation crash window", () => {
    const task = {
      id: "10000000-0000-4000-8000-000000000001",
      scope: { kind: "global" as const },
      title: "Recover this task",
      details: "The user entry already crossed the native boundary.",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 3,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T13:00:00.000Z",
    };
    const taskSubmission = createPiSubmissionMarker({
      applicationOperationId: "task-operation",
      reconciliationToken: "task-token",
      mutationId: "task-mutation",
      mode: "submit",
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [task],
    });
    const entries = [
      custom(
        "task-marker",
        piTaskContextMarkerType,
        createPiTaskContextMarker(
          {
            applicationOperationId: taskSubmission.applicationOperationId,
            requestFingerprint: taskSubmission.requestFingerprint,
            taskContexts: [task],
          },
          authentication,
        ),
      ),
      custom("task-intent", piSubmissionMarkerType, taskSubmission),
      {
        type: "message",
        id: "task-user",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "user",
          content: formatPiTaskContextPrompt([task], ""),
          timestamp: 1,
        },
      } as SessionEntry,
    ];
    const recovered: unknown[] = [];
    expect(
      recoverPiTaskSubmissionAttestations(
        entries,
        (marker) => recovered.push(marker),
        authentication,
      ),
    ).toBe(1);
    expect(recovered).toMatchObject([
      {
        applicationOperationId: "task-operation",
        requestFingerprint: taskSubmission.requestFingerprint,
        userEntryId: "task-user",
      },
    ]);
  });

  it("does not repair displaced or lookalike task carriers", () => {
    const task = {
      id: "10000000-0000-4000-8000-000000000001",
      scope: { kind: "global" as const },
      title: "Do not promote a lookalike",
      details: "",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 1,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
    };
    const marker = createPiSubmissionMarker({
      applicationOperationId: "displaced-operation",
      reconciliationToken: "displaced-token",
      mutationId: "displaced-mutation",
      mode: "submit",
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [task],
    });
    const proof = custom(
      "task-proof",
      piTaskContextMarkerType,
      createPiTaskContextMarker(
        {
          applicationOperationId: marker.applicationOperationId,
          requestFingerprint: marker.requestFingerprint,
          taskContexts: [task],
        },
        authentication,
      ),
    );
    const intent = custom("intent", piSubmissionMarkerType, marker);
    const user = {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "user",
        content: formatPiTaskContextPrompt([task], ""),
        timestamp: 1,
      },
    } as SessionEntry & {
      readonly type: "message";
      readonly message: {
        readonly role: "user";
        readonly content: string;
        readonly timestamp: number;
      };
    };
    const append = () => {
      throw new Error("unexpected attestation");
    };
    expect(
      recoverPiTaskSubmissionAttestations(
        [proof, custom("interposed", "external.entry", {}), intent, user],
        append,
        authentication,
      ),
    ).toBe(0);
    expect(
      recoverPiTaskSubmissionAttestations(
        [
          proof,
          intent,
          {
            ...user,
            message: { ...user.message, content: "lookalike" },
          } as SessionEntry,
        ],
        append,
        authentication,
      ),
    ).toBe(0);
  });

  it("authenticates the exact conversation, operation, fingerprint, and user entry", () => {
    const marker = createPiSubmissionAttestation(
      {
        applicationOperationId: submission.applicationOperationId,
        requestFingerprint: submission.requestFingerprint,
        userEntryId: "user-1",
      },
      authentication,
    );
    const markerEntry = custom(
      "attestation-1",
      piSubmissionAttestationType,
      marker,
    );
    expect(readPiSubmissionAttestation(markerEntry, authentication)).toEqual({
      status: "authenticated",
      marker,
    });
    expect(
      findAuthenticatedPiSubmissionAttestation(
        [
          custom("intent-1", piSubmissionMarkerType, submission),
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-01-01T00:00:01.000Z",
            message: { role: "user", content: "Hello", timestamp: 1 },
          } as SessionEntry,
          markerEntry,
        ],
        "user-1",
        authentication,
      ),
    ).toEqual(marker);
  });

  it("remains exact when a Steer enqueue marker follows materialization", () => {
    const steerInput = {
      applicationOperationId: "steer-operation",
      reconciliationToken: "steer-token",
      mutationId: "steer-mutation",
      mode: "steer" as const,
      text: "Change direction",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    };
    const intent = createPiSubmissionMarker(steerInput);
    const enqueued = createPiSubmissionMarker({
      ...steerInput,
      phase: "enqueued",
      backendTurnId: "active-turn",
    });
    const marker = createPiSubmissionAttestation(
      {
        applicationOperationId: intent.applicationOperationId,
        requestFingerprint: intent.requestFingerprint,
        userEntryId: "steer-user",
      },
      authentication,
    );
    expect(
      findAuthenticatedPiSubmissionAttestation(
        [
          {
            type: "message",
            id: "active-turn",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: "user", content: "Begin", timestamp: 0 },
          } as SessionEntry,
          custom("intent", piSubmissionMarkerType, intent),
          {
            type: "message",
            id: "steer-user",
            parentId: null,
            timestamp: "2026-01-01T00:00:01.000Z",
            message: {
              role: "user",
              content: "Change direction",
              timestamp: 1,
            },
          } as SessionEntry,
          custom("attestation", piSubmissionAttestationType, marker),
          custom("enqueued", piSubmissionMarkerType, enqueued),
        ],
        "steer-user",
        authentication,
      ),
    ).toEqual(marker);
  });

  it("rejects tampering, copying to another conversation, and lifecycle mismatch", () => {
    const marker = createPiSubmissionAttestation(
      {
        applicationOperationId: submission.applicationOperationId,
        requestFingerprint: submission.requestFingerprint,
        userEntryId: "user-1",
      },
      authentication,
    );
    expect(
      readPiSubmissionAttestation(
        custom("attestation-1", piSubmissionAttestationType, {
          ...marker,
          userEntryId: "user-2",
        }),
        authentication,
      ),
    ).toEqual({ status: "unauthenticated" });
    expect(
      readPiSubmissionAttestation(
        custom("attestation-1", piSubmissionAttestationType, marker),
        { ...authentication, conversationId: "conversation-2" },
      ),
    ).toEqual({ status: "unauthenticated" });
    expect(
      findAuthenticatedPiSubmissionAttestation(
        [
          custom("intent-1", piSubmissionMarkerType, submission),
          {
            type: "message",
            id: "different-user",
            parentId: null,
            timestamp: "2026-01-01T00:00:01.000Z",
            message: { role: "user", content: "Hello", timestamp: 1 },
          } as SessionEntry,
          custom("attestation-1", piSubmissionAttestationType, marker),
        ],
        "user-1",
        authentication,
      ),
    ).toBeUndefined();
  });
});
