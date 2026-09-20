import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  correlatePiSubmissions,
  createPiSubmissionMarker,
  piSubmissionMarkerType,
} from "../../src/server/backends/pi/pi-submission-marker.js";

function custom(
  id: string,
  data: ReturnType<typeof createPiSubmissionMarker>,
): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: piSubmissionMarkerType,
    data,
  };
}

function user(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 1,
    },
  };
}

const input = {
  applicationOperationId: "operation-1",
  mutationId: "mutation-1",
  reconciliationToken: "token-1",
  mode: "steer" as const,
  text: "Use the exact durable input",
  contextExcerpts: [],
  attachments: [],
  taskContexts: [],
};

describe("Pi submission markers", () => {
  it("preserves the deployed v1 steer shape and fingerprint", () => {
    expect(createPiSubmissionMarker(input)).toEqual({
      version: 1,
      applicationOperationId: "operation-1",
      mutationId: "mutation-1",
      reconciliationToken: "token-1",
      mode: "steer",
      requestFingerprint:
        "1bf71f3e81683fd09e62ca5ad912e7de4b64f9a4fd9f918e73b3bfc49a182c33",
      textFingerprint:
        "7b8249fcb56579557ba9c8490fd2b0b97cbbd0ef40fd5027c54a5d1e703582a7",
      phase: "intent",
    });
  });

  it("fingerprints the exact ordered context excerpt snapshot", () => {
    const contextExcerpt = {
      id: "0d1bfa8b-dc37-4f52-8b0e-f8181ac0a7e9",
      excerpt: "selected text",
      source: {
        kind: "workspace_file" as const,
        rootId: "primary" as const,
        path: "README.md",
        revision: "revision-1",
      },
      locator: { kind: "line_range" as const, startLine: 1, endLine: 1 },
    };
    const first = createPiSubmissionMarker({
      ...input,
      contextExcerpts: [contextExcerpt],
    });
    const changed = createPiSubmissionMarker({
      ...input,
      contextExcerpts: [{ ...contextExcerpt, note: "Explain this." }],
    });
    expect(first.requestFingerprint).not.toBe(changed.requestFingerprint);
    expect(first.textFingerprint).toBe(changed.textFingerprint);
  });

  it("fingerprints the exact staged attachment snapshot", () => {
    const attachment = {
      id: "20000000-0000-4000-8000-000000000002",
      kind: "file" as const,
      fileName: "notes.bin",
      mediaType: "application/octet-stream" as const,
      byteSize: 5,
      sha256: "a".repeat(64),
      agentPath: "/var/lib/sedes/staged/notes.bin",
    };
    const first = createPiSubmissionMarker({
      ...input,
      attachments: [attachment],
    });
    const changed = createPiSubmissionMarker({
      ...input,
      attachments: [{ ...attachment, sha256: "b".repeat(64) }],
    });
    expect(first.requestFingerprint).not.toBe(changed.requestFingerprint);
    expect(first.textFingerprint).toBe(changed.textFingerprint);
  });

  it("fingerprints the exact ordered task-context snapshot", () => {
    const task = {
      id: "10000000-0000-4000-8000-000000000001",
      scope: { kind: "global" as const },
      title: "Exact task",
      details: "Use this revision.",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 2,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T13:00:00.000Z",
    };
    const first = createPiSubmissionMarker({
      ...input,
      taskContexts: [task],
    });
    const changed = createPiSubmissionMarker({
      ...input,
      taskContexts: [{ ...task, revision: 3 }],
    });
    expect(first.requestFingerprint).not.toBe(changed.requestFingerprint);
    expect(first.textFingerprint).toBe(changed.textFingerprint);
  });

  it("correlates the next user entry when Pi persists transformed input", () => {
    const entries = [
      custom("marker", createPiSubmissionMarker(input)),
      user("accepted", "Transformed durable input"),
    ];
    expect(
      correlatePiSubmissions(entries).get(input.applicationOperationId),
    ).toMatchObject({ userEntryId: "accepted" });
  });

  it("fails closed when a steer has no preceding provider root", () => {
    expect(
      correlatePiSubmissions([
        custom("marker", createPiSubmissionMarker(input)),
        user("orphan", input.text),
      ]).get(input.applicationOperationId),
    ).toMatchObject({
      userEntryId: "orphan",
      invalid: "orphan_steer",
    });
  });

  it("invalidates a steer displaced by the next true submit", () => {
    const submit = {
      ...input,
      applicationOperationId: "next-submit",
      mutationId: "next-submit",
      reconciliationToken: "next-submit",
      mode: "submit" as const,
    };
    const correlations = correlatePiSubmissions([
      user("root", "Root"),
      custom("steer", createPiSubmissionMarker(input)),
      custom("submit", createPiSubmissionMarker(submit)),
      user("next-root", "Next root"),
    ]);

    expect(correlations.get(input.applicationOperationId)).toMatchObject({
      invalid: "displaced_steer",
    });
    expect(correlations.get(submit.applicationOperationId)).toMatchObject({
      userEntryId: "next-root",
      providerTurnId: "next-root",
    });
  });

  it("does not trust an optional v1 backendTurnId hint over position", () => {
    const hinted = { ...input, backendTurnId: "arbitrary-user" };
    expect(
      correlatePiSubmissions([
        user("root", "Root"),
        custom("marker", createPiSubmissionMarker(hinted)),
        user("actual-steer", hinted.text),
      ]).get(input.applicationOperationId),
    ).toMatchObject({
      userEntryId: "actual-steer",
      providerTurnId: "root",
    });
  });

  it("leaves a handled input without a user entry unaccepted", () => {
    expect(
      correlatePiSubmissions([
        custom("marker", createPiSubmissionMarker(input)),
      ]).get(input.applicationOperationId),
    ).toMatchObject({
      marker: { phase: "intent" },
      rejected: false,
    });
  });

  it("records enqueue evidence on the exact positional provider turn", () => {
    const enqueued = createPiSubmissionMarker({
      ...input,
      phase: "enqueued",
      backendTurnId: "root",
    });
    expect(
      correlatePiSubmissions([
        user("root", "Root"),
        custom("intent", createPiSubmissionMarker(input)),
        custom("enqueued", enqueued),
      ]).get(input.applicationOperationId),
    ).toMatchObject({
      marker: { phase: "enqueued", backendTurnId: "root" },
      providerTurnId: "root",
      rejected: false,
    });
  });

  it("materializes transformed input after enqueue evidence", () => {
    const result = correlatePiSubmissions([
      user("root", "Root"),
      custom("intent", createPiSubmissionMarker(input)),
      custom(
        "enqueued",
        createPiSubmissionMarker({
          ...input,
          phase: "enqueued",
          backendTurnId: "root",
        }),
      ),
      user("materialized", "Transformed by Pi"),
    ]).get(input.applicationOperationId);

    expect(result).toMatchObject({
      marker: { phase: "enqueued" },
      userEntryId: "materialized",
      providerTurnId: "root",
    });
  });

  it("closes an enqueued steer as lost without capturing later input", () => {
    const result = correlatePiSubmissions([
      user("root", "Root"),
      custom("intent", createPiSubmissionMarker(input)),
      custom(
        "enqueued",
        createPiSubmissionMarker({
          ...input,
          phase: "enqueued",
          backendTurnId: "root",
        }),
      ),
      custom(
        "lost",
        createPiSubmissionMarker({
          ...input,
          phase: "lost",
          backendTurnId: "root",
        }),
      ),
      user("later", "Unrelated input"),
    ]).get(input.applicationOperationId);

    expect(result).toMatchObject({
      marker: { phase: "lost" },
      invalid: "lost_steer",
      rejected: true,
    });
    expect(result).not.toHaveProperty("userEntryId");
  });

  it("rejects enqueue evidence for another provider turn", () => {
    expect(() =>
      correlatePiSubmissions([
        user("root", "Root"),
        custom("intent", createPiSubmissionMarker(input)),
        custom(
          "enqueued",
          createPiSubmissionMarker({
            ...input,
            phase: "enqueued",
            backendTurnId: "other-root",
          }),
        ),
      ]),
    ).toThrow("pi_submission_enqueue_marker_target_mismatch");
  });

  it("rejects a pre-boundary rejection marker after enqueue acknowledgement", () => {
    expect(() =>
      correlatePiSubmissions([
        user("root", "Root"),
        custom("intent", createPiSubmissionMarker(input)),
        custom(
          "enqueued",
          createPiSubmissionMarker({
            ...input,
            phase: "enqueued",
            backendTurnId: "root",
          }),
        ),
        custom(
          "rejected",
          createPiSubmissionMarker({ ...input, phase: "rejected" }),
        ),
      ]),
    ).toThrow("pi_submission_rejection_marker_invalid");
  });

  it("retains durable rejection evidence without capturing a later user", () => {
    const entries = [
      custom("intent", createPiSubmissionMarker(input)),
      custom(
        "rejected",
        createPiSubmissionMarker({ ...input, phase: "rejected" }),
      ),
      user("later", input.text),
    ];
    expect(
      correlatePiSubmissions(entries).get(input.applicationOperationId),
    ).toMatchObject({
      marker: { phase: "rejected" },
      rejected: true,
    });
  });

  it("rejects duplicate live intents for one operation identity", () => {
    expect(() =>
      correlatePiSubmissions([
        custom("one", createPiSubmissionMarker(input)),
        custom("two", createPiSubmissionMarker(input)),
      ]),
    ).toThrow("pi_submission_intent_marker_duplicate");
  });

  it("accepts repeated rejection evidence and a fresh superseding intent", () => {
    const rotated = {
      ...input,
      mutationId: "mutation-2",
      reconciliationToken: "token-2",
    };
    const result = correlatePiSubmissions([
      custom("intent", createPiSubmissionMarker(input)),
      custom(
        "rejected-1",
        createPiSubmissionMarker({ ...input, phase: "rejected" }),
      ),
      custom(
        "rejected-2",
        createPiSubmissionMarker({ ...input, phase: "rejected" }),
      ),
      custom("fresh-intent", createPiSubmissionMarker(rotated)),
      user("fresh-user", "Transformed retry input"),
    ]).get(input.applicationOperationId);

    expect(result).toMatchObject({
      marker: {
        phase: "intent",
        mutationId: "mutation-2",
        reconciliationToken: "token-2",
      },
      userEntryId: "fresh-user",
      rejected: false,
    });
  });

  it("accepts a fresh superseding intent after a lost enqueue", () => {
    const rotated = {
      ...input,
      mutationId: "mutation-2",
      reconciliationToken: "token-2",
    };
    const result = correlatePiSubmissions([
      user("root", "Root"),
      custom("intent-1", createPiSubmissionMarker(input)),
      custom(
        "enqueued-1",
        createPiSubmissionMarker({
          ...input,
          phase: "enqueued",
          backendTurnId: "root",
        }),
      ),
      custom(
        "lost-1",
        createPiSubmissionMarker({
          ...input,
          phase: "lost",
          backendTurnId: "root",
        }),
      ),
      custom("intent-2", createPiSubmissionMarker(rotated)),
      custom(
        "enqueued-2",
        createPiSubmissionMarker({
          ...rotated,
          phase: "enqueued",
          backendTurnId: "root",
        }),
      ),
      user("fresh-user", "Transformed retry input"),
    ]).get(input.applicationOperationId);

    expect(result).toMatchObject({
      marker: {
        phase: "enqueued",
        mutationId: "mutation-2",
        reconciliationToken: "token-2",
      },
      userEntryId: "fresh-user",
      rejected: false,
    });
  });
});
