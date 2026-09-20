import { describe, expect, it } from "vitest";
import {
  backendDeliveryInput,
  canonicalUserMessageContent,
  renderTaskContextsForModel,
} from "../../src/server/conversations/delivery-input-projection.js";
import type { MaterializedTaskContext } from "../../src/shared/protocol/tasks.js";
import type { SubmitTurnInput } from "../../src/server/backends/contracts.js";
import type { ApplicationSubmitTurnInput } from "../../src/server/conversations/delivery-input-projection.js";

const task: MaterializedTaskContext = {
  id: "8af900ae-8495-48f7-9d3f-9e322892ada1",
  scope: { kind: "global" },
  title: "Fix history",
  details: "Keep the submitted image visible.",
  pinned: false,
  files: ["/workspace/history.ts"],
  completedAt: null,
  revision: 3,
  createdAt: "2026-08-16T10:00:00.000Z",
  updatedAt: "2026-08-16T11:00:00.000Z",
};

describe("common delivery input projection", () => {
  it("renders deterministic Task-only and mixed model input without backend security framing", () => {
    const taskOnly = renderTaskContextsForModel([task], "");
    expect(taskOnly).toContain("Sedes Tasks selected for this message:");
    expect(taskOnly).toContain(JSON.stringify({ taskContexts: [task] }));
    expect(taskOnly).not.toMatch(/hmac|authenticated|untrusted|provenance/iu);
    expect(renderTaskContextsForModel([task], "Do this")).toBe(
      `${taskOnly}\n\nDo this`,
    );

    const input = {
      applicationOperationId: "operation-1",
      mutationId: "mutation-1",
      source: { kind: "user" },
      reconciliationToken: "token-1",
      text: "Do this",
      contextExcerpts: [],
      taskContexts: [task],
      attachments: [],
    } as SubmitTurnInput;
    expect(backendDeliveryInput(input)).toMatchObject({
      text: `${taskOnly}\n\nDo this`,
      taskContexts: [],
    });
    expect(input).toMatchObject({ text: "Do this", taskContexts: [task] });
  });

  it("strips authenticated application provenance before provider delivery", () => {
    const input: ApplicationSubmitTurnInput = {
      applicationOperationId: "callback-operation",
      mutationId: "callback-operation",
      source: { kind: "user" },
      reconciliationToken: "callback-operation",
      text: "Agent result from Worker (completed):\n\nDone",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
      inputOrigin: {
        kind: "agent_result",
        callbackId: "54aa581b-1ca0-4bc9-9249-a528dfe0118b",
        sourceThreadId: "worker-thread",
        sourceThreadLabel: { text: "Worker" },
      },
    };

    expect(backendDeliveryInput(input)).toEqual({
      applicationOperationId: "callback-operation",
      mutationId: "callback-operation",
      source: { kind: "user" },
      reconciliationToken: "callback-operation",
      text: "Agent result from Worker (completed):\n\nDone",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
    });
    expect(
      backendDeliveryInput({
        applicationOperationId: "callback-steer",
        mutationId: "callback-steer",
        reconciliationToken: "callback-steer",
        target: { kind: "turn", turnId: "backend-turn" },
        text: "Continue",
        contextExcerpts: [],
        taskContexts: [],
        attachments: [],
        inputOrigin: input.inputOrigin,
      }),
    ).not.toHaveProperty("inputOrigin");
  });

  it("labels agent messages for the model while preserving application-owned content", () => {
    const input: ApplicationSubmitTurnInput = {
      applicationOperationId: "agent-message-operation",
      mutationId: "agent-message-operation",
      source: { kind: "user" },
      reconciliationToken: "agent-message-operation",
      text: "Review this independently.",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
      inputOrigin: {
        kind: "agent_message",
        sourceThreadId: "controller-thread",
        sourceThreadLabel: { text: "Main implementation" },
      },
    };

    expect(backendDeliveryInput(input)).toEqual({
      applicationOperationId: "agent-message-operation",
      mutationId: "agent-message-operation",
      source: { kind: "user" },
      reconciliationToken: "agent-message-operation",
      text: "Agent message from Main implementation:\n\nReview this independently.",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
    });
    expect(input.text).toBe("Review this independently.");
  });

  it("builds canonical browser content and ignores provider carrier text and paths", () => {
    const content = canonicalUserMessageContent({
      snapshot: {
        tenantId: "tenant-1",
        principalId: "principal-1",
        threadId: "thread-1",
        deliveryOperationId: "operation-1",
        text: "Original prompt",
        selectedSkillId: "skill-1",
        contextExcerpts: [],
        taskContexts: [task],
        attachments: [
          {
            descriptor: {
              id: "2dff386b-2f0a-4cd2-acf1-3fc220b82947",
              kind: "image",
              fileName: "photo.png",
              mediaType: "image/png",
              byteSize: 123,
            },
            sha256: "a".repeat(64),
          },
        ],
        fingerprint: "b".repeat(64),
        createdAt: 1,
      },
      providerContent: [
        { kind: "text", text: { text: "private provider carrier /tmp/x" } },
        { kind: "skill", name: { text: "Review" } },
        { kind: "image", omitted: true },
      ],
    });

    expect(content).toEqual([
      { kind: "skill", name: { text: "Review" } },
      {
        kind: "attachment",
        attachment: {
          id: "2dff386b-2f0a-4cd2-acf1-3fc220b82947",
          kind: "image",
          fileName: "photo.png",
          mediaType: "image/png",
          byteSize: 123,
        },
      },
      { kind: "task_context", task },
      { kind: "text", text: { text: "Original prompt" } },
    ]);
    expect(JSON.stringify(content)).not.toContain("private provider carrier");
    expect(JSON.stringify(content)).not.toContain("sha256");
  });

  it("retains a backend-authenticated direct skill only at an exact snapshot token boundary", () => {
    const baseSnapshot = {
      tenantId: "tenant-1",
      principalId: "principal-1",
      threadId: "thread-1",
      deliveryOperationId: "operation-1",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [],
      fingerprint: "b".repeat(64),
      createdAt: 1,
    };
    const providerContent = [
      { kind: "skill" as const, name: { text: "review" } },
      { kind: "text" as const, text: { text: "ignored" } },
    ];
    expect(
      canonicalUserMessageContent({
        snapshot: { ...baseSnapshot, text: "  /review src/server" },
        providerContent,
      }),
    ).toEqual([
      { kind: "skill", name: { text: "review" } },
      { kind: "text", text: { text: "src/server" } },
    ]);
    for (const [text, expectedText] of [
      ["/review\tsrc/server", "src/server"],
      ["/review\nsrc/server", "src/server"],
      ["/review", undefined],
    ] as const) {
      expect(
        canonicalUserMessageContent({
          snapshot: { ...baseSnapshot, text },
          providerContent,
        }),
      ).toEqual([
        { kind: "skill", name: { text: "review" } },
        ...(expectedText
          ? [{ kind: "text" as const, text: { text: expectedText } }]
          : []),
      ]);
    }
    for (const text of ["/reviewer src/server", "escaped /review src/server"]) {
      expect(
        canonicalUserMessageContent({
          snapshot: { ...baseSnapshot, text },
          providerContent,
        })[0],
      ).toMatchObject({ kind: "text", text: { text } });
    }
  });
});
