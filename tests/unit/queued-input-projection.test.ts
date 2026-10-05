import { describe, expect, it } from "vitest";
import { projectQueuedInputPresentation, projectQueuedInputSummaries } from "../../src/server/conversations/queued-input-projection.js";
import type { QueuedInputRecord } from "../../src/server/db/repositories/queued-input-repository.js";
import { queuedInputPresentationSchema } from "../../src/shared/protocol/api.js";
import { MAXIMUM_MESSAGE_ITEM_BYTES } from "../../src/shared/protocol/payload.js";

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
    failureReason: null,
    failureAcknowledgedAt: null,
    cancellationMutationId: null,
    cancellationRequestFingerprint: null,
    ...input,
  };
}

describe("queued input projection", () => {
  it.each([65_536, 65_537, 262_144])("projects truthful composer restoration availability for %i UTF-8 bytes", bytes => {
    const text = "é".repeat(Math.floor(bytes / 2)) + (bytes % 2 ? "x" : "");
    const [summary] = projectQueuedInputSummaries([queued({ id: "large-input", sequence: 1, text })]);
    expect(summary?.restoreUnavailableReason).toEqual(bytes === 65_536 ? undefined : {
      text: "This input is too large to restore to the composer (64 KiB limit).",
    });
  });

  it("preserves full input and normalizes attached context without disclosing stored delivery details", () => {
    const text = `  ${"A longer spoken message. ".repeat(100)}\nEnd with emoji 🎤.  `;
    const item = queued({
      id: "input-full",
      sequence: 1,
      applicationThreadId: "88b72554-a697-4ebc-9d96-b2ab09343f13",
      text,
      selectedSkillId: "provider-private/skill-id",
      resolvedDeliveryMode: "submit",
      retryAnchor: "provider-private-retry-anchor",
      backendCorrelation: "provider-private-correlation",
      attachments: [{ id: "d9d3e4f5-6a7b-48c9-8def-1234567890ab", fileName: "diagram.png", kind: "image", mediaType: "image/png", byteSize: 512 }],
      contextExcerpts: [{
        id: "0d1bfa8b-dc37-4f52-8b0e-f8181ac0a7e9",
        excerpt: "Selected paragraph",
        source: { kind: "conversation_message", itemId: "message-1", itemRevision: 2 },
        locator: { kind: "text_quote", prefix: "", suffix: "" },
      }],
      taskContexts: [{
        id: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
        scope: { kind: "global" },
        title: "Selected task",
        details: "Full task details",
        pinned: false,
        files: [],
        completedAt: null,
        revision: 1,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      }],
    });
    const projected = projectQueuedInputPresentation(item, 4, item.mutationId);
    expect(projected).toMatchObject({
      threadId: item.applicationThreadId,
      threadRevision: 4,
      queuedInputId: item.id,
      deliveryOperationId: item.mutationId,
      state: "pending",
      resolvedDeliveryMode: "submit",
      origin: "user",
      content: [
        { kind: "skill", name: { text: "Selected skill" } },
        { kind: "attachment", attachment: item.attachments[0] },
        { kind: "task_context", task: { title: "Selected task", details: "Full task details" } },
        { kind: "context_excerpt", excerpt: item.contextExcerpts[0] },
        { kind: "text", text: { text } },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain("provider-private");
    expect(projected).not.toHaveProperty("tenantId");
    expect(projectQueuedInputSummaries([item])[0]!.preview.truncation?.truncated).toBe(true);
  });

  it.each(["pending", "retry_wait", "dispatching", "accepted", "uncertain", "failed", "cancelled"] as const)(
    "exposes retained %s status independently of the active queue",
    (state) => {
      const item = queued({ id: "retained", sequence: 1, applicationThreadId: "88b72554-a697-4ebc-9d96-b2ab09343f13", text: "Retained input", state });
      expect(projectQueuedInputPresentation(item, 6, "normalized-operation")).toMatchObject({
        state, threadRevision: 6, deliveryOperationId: "normalized-operation",
      });
    },
  );

  it("rejects invalid provenance and excessive aggregate content without shortening input", () => {
    const item = queued({ id: "strict", sequence: 1, applicationThreadId: "88b72554-a697-4ebc-9d96-b2ab09343f13", text: "Input" });
    const projected = projectQueuedInputPresentation(item, 1, item.mutationId);
    expect(queuedInputPresentationSchema.safeParse({ ...projected, backendCorrelation: "private" }).success).toBe(false);
    expect(queuedInputPresentationSchema.safeParse({ ...projected, origin: "agent_control" }).success).toBe(false);
    const part = { kind: "text", text: { text: "x".repeat(MAXIMUM_MESSAGE_ITEM_BYTES / 2) } };
    expect(queuedInputPresentationSchema.safeParse({ ...projected, content: [part, part] }).success).toBe(false);
    expect(() => projectQueuedInputPresentation({ ...item, text: "" }, 1, item.mutationId))
      .toThrow("queued_input_presentation_unpresentable");
  });

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

  it("projects the normalized not-sent reason only on a failed item", () => {
    const notSent = queued({
      id: "not-sent",
      sequence: 1,
      state: "failed",
      resolvedDeliveryMode: "steer",
      resolvedSteerTarget: { kind: "conversation" },
      requestedDeliveryMode: "steer",
      requestedSteerTarget: { kind: "conversation" },
      diagnostic: "Withdrawn by Stop.",
      failureReason: "not_sent",
    });
    const plainFailure = queued({
      id: "failed",
      sequence: 2,
      state: "failed",
      diagnostic: "Rejected",
    });
    const [first, second] = projectQueuedInputSummaries([notSent, plainFailure]);
    expect(first).toMatchObject({ id: "not-sent", failureReason: "not_sent" });
    expect(second).not.toHaveProperty("failureReason");
    expect(
      projectQueuedInputSummaries([
        { ...notSent, state: "cancelled", resolvedAt: notSent.createdAt + 1 },
        { ...notSent, id: "pending", sequence: 3, state: "pending" },
      ])[0],
    ).not.toHaveProperty("failureReason");
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
