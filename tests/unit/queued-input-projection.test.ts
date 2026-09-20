import { describe, expect, it } from "vitest";
import { projectQueuedInputSummaries } from "../../src/server/conversations/queued-input-projection.js";
import type { QueuedInputRecord } from "../../src/server/db/repositories/queued-input-repository.js";

function queued(
  input: Partial<QueuedInputRecord> &
    Pick<QueuedInputRecord, "id" | "sequence">,
): QueuedInputRecord {
  return {
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
    applicationThreadId: "thread-1",
    mutationId: `mutation-${input.id}`,
    text: "",
    selectedSkillId: null,
    contextExcerpts: [],
    attachments: [],
    taskContexts: [],
    requestedDeliveryMode: null,
    requestedSteerTarget: null,
    steerFallbackAt: null,
    resolvedDeliveryMode: "queue",
    resolvedSteerTarget: null,
    requestedThreadRevision: null,
    requestedDraftRevision: null,
    triggerKind: "user",
    sourceAutomationId: null,
    sourceAutomationRunId: null,
    initiatingAgentThreadId: null,
    initiatingToolClientId: null,
    completionCallbackId: null,
    inputOrigin: null,
    state: "pending",
    deliveryMode: null,
    retryOfId: null,
    createdAt: Date.parse("2026-08-07T07:00:00.000Z"),
    dispatchStartedAt: null,
    acceptedAt: null,
    resolvedAt: null,
    reconciliationToken: null,
    retryAnchor: null,
    backendCorrelation: null,
    retryCount: 0,
    invalidStateRequeues: 0,
    nextAttemptAt: null,
    diagnostic: null,
    failureAcknowledgedAt: null,
    cancellationMutationId: null,
    cancellationRequestFingerprint: null,
    ...input,
  };
}

describe("queued input projection", () => {
  it("centralizes origin, head identity, delivery mode, and nonblank fallbacks", () => {
    const contextExcerpt = {
      id: "0d1bfa8b-dc37-4f52-8b0e-f8181ac0a7e9",
      excerpt: "selected text",
      source: {
        kind: "conversation_message" as const,
        itemId: "message-1",
        itemRevision: 2,
      },
      locator: { kind: "text_quote" as const, prefix: "", suffix: "" },
    };
    const result = projectQueuedInputSummaries([
      queued({ id: "terminal", sequence: 0, state: "cancelled" }),
      queued({
        id: "skill",
        sequence: 1,
        selectedSkillId: "review",
        triggerKind: "automation",
      }),
      queued({
        id: "context",
        sequence: 2,
        contextExcerpts: [contextExcerpt],
        attachments: [
          {
            id: "d9d3e4f5-6a7b-48c9-8def-1234567890ab",
            fileName: "diagram.png",
            kind: "image",
            mediaType: "image/png",
            byteSize: 512,
          },
        ],
        state: "dispatching",
        deliveryMode: "steer",
      }),
      queued({ id: "text", sequence: 3, text: "  Follow up  " }),
      queued({
        id: "tasks",
        sequence: 4,
        taskContexts: [
          {
            id: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
            scope: { kind: "global" },
            title: "Add prompt from tasks should include ID",
            details: "",
            pinned: false,
            files: [],
            completedAt: null,
            revision: 1,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
          },
        ],
      }),
    ]);

    expect(result).toMatchObject([
      {
        id: "skill",
        deliveryOperationId: "mutation-skill",
        origin: "automation",
        isHead: true,
        preview: { text: "Selected skill" },
      },
      {
        id: "context",
        deliveryOperationId: "mutation-context",
        origin: "user",
        isHead: false,
        deliveryMode: "steer",
        attachmentCount: 1,
        preview: { text: "1 context excerpt" },
      },
      {
        id: "text",
        deliveryOperationId: "mutation-text",
        isHead: false,
        preview: { text: "Follow up" },
      },
      {
        id: "tasks",
        deliveryOperationId: "mutation-tasks",
        isHead: false,
        taskCount: 1,
        preview: { text: "Add prompt from tasks should include ID" },
      },
    ]);
    expect(result.every(({ preview }) => preview.text.length > 0)).toBe(true);
  });

  it("projects durable agent-control provenance distinctly from composer input", () => {
    expect(
      projectQueuedInputSummaries([
        queued({
          id: "agent-control",
          sequence: 1,
          text: "delegated work",
          initiatingAgentThreadId: "controller-thread",
          inputOrigin: {
            kind: "agent_message",
            sourceThreadId: "controller-thread",
            sourceThreadLabel: { text: "Main implementation" },
          },
        }),
      ])[0],
    ).toMatchObject({
      origin: "agent_control",
      deliveryOperationId: "mutation-agent-control",
      initiatingAgentThreadId: "controller-thread",
      inputOrigin: {
        kind: "agent_message",
        sourceThreadId: "controller-thread",
        sourceThreadLabel: { text: "Main implementation" },
      },
    });
  });

  it("projects principal-client provenance without a synthetic controller", () => {
    const initiatingToolClientId = "10000000-0000-4000-8000-000000000099";
    expect(
      projectQueuedInputSummaries([
        queued({
          id: "principal-client",
          sequence: 1,
          text: "external work",
          initiatingToolClientId,
        }),
      ])[0],
    ).toMatchObject({
      origin: "principal_client_control",
      deliveryOperationId: "mutation-principal-client",
      initiatingToolClientId,
    });
  });

  it("keeps a nonblank preview when stored task display text is whitespace", () => {
    const task = {
      id: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
      scope: { kind: "global" as const },
      title: "   ",
      details: "",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const [summary] = projectQueuedInputSummaries([
      queued({ id: "whitespace-task", sequence: 1, taskContexts: [task] }),
    ]);

    expect(summary).toMatchObject({
      taskCount: 1,
      preview: { text: "1 attached task" },
    });
  });

  it("keeps an unacknowledged failed head and omits it after acknowledgement", () => {
    const failed = queued({
      id: "failed",
      sequence: 1,
      state: "failed",
      diagnostic: "Rejected",
    });
    const later = queued({ id: "later", sequence: 2, text: "Later" });
    expect(projectQueuedInputSummaries([failed, later])[0]).toMatchObject({
      id: "failed",
      isHead: true,
    });
    expect(
      projectQueuedInputSummaries([
        { ...failed, failureAcknowledgedAt: failed.createdAt + 1 },
        later,
      ])[0],
    ).toMatchObject({ id: "later", isHead: true });
  });

  it("projects durable Steer intent and its active delivery operation", () => {
    expect(
      projectQueuedInputSummaries([
        queued({
          id: "steer",
          sequence: 1,
          mutationId: "admission-operation",
          requestedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn", turnId: "turn-1" },
          resolvedDeliveryMode: "steer",
          resolvedSteerTarget: { kind: "turn", turnId: "turn-1" },
          state: "dispatching",
          deliveryMode: "steer",
          dispatchStartedAt: 2,
          reconciliationToken: "steer-operation",
          retryAnchor: "steer-operation",
        }),
      ]),
    ).toMatchObject([
      {
        requestedDeliveryMode: "steer",
        deliveryMode: "steer",
        deliveryOperationId: "steer-operation",
      },
    ]);
  });

  it("projects a proven-unsent stale Steer as ordinary queue work", () => {
    expect(
      projectQueuedInputSummaries([
        queued({
          id: "fallback",
          sequence: 1,
          requestedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn", turnId: "turn-1" },
          steerFallbackAt: 3,
          resolvedDeliveryMode: "queue",
        }),
      ]),
    ).toMatchObject([
      {
        requestedDeliveryMode: "steer",
        resolvedDeliveryMode: "queue",
        deliveryOperationId: "mutation-fallback",
        state: "pending",
      },
    ]);
  });
});
