import { describe, expect, it } from "vitest";
import {
  SEDES_CLIENT_PROTOCOL_VERSION,
  MAXIMUM_COMPOSER_INPUT_BYTES,
  MAXIMUM_COMPOSER_TASK_REFERENCES,
  apiErrorCodeSchema,
  backendItemSchema,
  composerTaskReferenceIdsSchema,
  composerTaskReferencesSchema,
  composerInputUtf8Bytes,
  hasDeliverableComposerInput,
  materializedTaskContextsSchema,
  normalizedDraftSchema,
  normalizedStashSchema,
  queuedInputSummarySchema,
  saveDraftRequestSchema,
  userMessageItemSchema,
  type MaterializedTaskContext,
} from "../../src/shared/index.js";

const task = {
  id: "10000000-0000-4000-8000-000000000001",
  scope: {
    kind: "workspace",
    workspaceId: "20000000-0000-4000-8000-000000000001",
  },
  title: "Implement composer Task references",
  details: "Preserve exact task identity and revision.",
  pinned: true,
  files: ["/work/sedes/src/shared/protocol/tasks.ts"],
  completedAt: null,
  revision: 7,
  createdAt: "2026-08-11T18:00:00.000Z",
  updatedAt: "2026-08-11T19:00:00.000Z",
} satisfies MaterializedTaskContext;

const reference = { taskId: task.id, titleSnapshot: task.title };

describe("composer Task reference protocol", () => {
  it("uses the current protocol version for the atomic normalized cutover", () => {
    expect(SEDES_CLIENT_PROTOCOL_VERSION).toBe(117);
  });

  it("bounds ordered draft references and rejects duplicate Task ids", () => {
    expect(composerTaskReferencesSchema.parse([reference])).toEqual([
      reference,
    ]);
    expect(
      composerTaskReferencesSchema.safeParse([reference, reference]).success,
    ).toBe(false);
    expect(
      composerTaskReferenceIdsSchema.safeParse(
        Array.from(
          { length: MAXIMUM_COMPOSER_TASK_REFERENCES + 1 },
          (_, index) => `task-${index}`,
        ),
      ).success,
    ).toBe(false);
  });

  it("requires task references in strict draft, stash, and save shapes", () => {
    const draft = {
      text: "",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [reference],
      revision: 2,
    };
    expect(normalizedDraftSchema.parse(draft)).toEqual(draft);
    expect(
      normalizedDraftSchema.safeParse({ ...draft, taskReferences: undefined })
        .success,
    ).toBe(false);
    expect(
      normalizedStashSchema.parse({
        id: "stash-1",
        text: draft.text,
        contextExcerpts: draft.contextExcerpts,
        attachments: draft.attachments,
        taskReferences: draft.taskReferences,
        createdAt: "2026-08-11T20:00:00.000Z",
      }),
    ).toMatchObject({ taskReferences: [reference] });
    expect(
      saveDraftRequestSchema.parse({
        text: "",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [task.id],
        expectedRevision: 2,
      }),
    ).toMatchObject({ taskReferenceIds: [task.id] });
    expect(hasDeliverableComposerInput(draft)).toBe(true);
  });

  it("validates immutable contexts and counts them in semantic input bytes", () => {
    expect(materializedTaskContextsSchema.parse([task])).toEqual([task]);
    expect(materializedTaskContextsSchema.safeParse([task, task]).success).toBe(
      false,
    );
    expect(
      normalizedDraftSchema.safeParse({
        text: "x".repeat(MAXIMUM_COMPOSER_INPUT_BYTES),
        contextExcerpts: [],
        attachments: [],
        taskReferences: [reference],
        revision: 0,
      }).success,
    ).toBe(true);
    expect(
      composerInputUtf8Bytes({
        text: "x".repeat(MAXIMUM_COMPOSER_INPUT_BYTES),
        contextExcerpts: [],
        taskContexts: [task],
      }),
    ).toBeGreaterThan(MAXIMUM_COMPOSER_INPUT_BYTES);
  });

  it("requires authenticated delivery identity for normalized Task cards", () => {
    const normalized = {
      id: "message-1",
      turnId: "turn-1",
      kind: "user_message" as const,
      status: "completed" as const,
      revision: 0,
      deliveryOperationId: "operation-1",
      content: [{ kind: "task_context" as const, task }],
    };
    expect(userMessageItemSchema.parse(normalized)).toEqual(normalized);
    expect(
      userMessageItemSchema.safeParse({
        ...normalized,
        deliveryOperationId: undefined,
      }).success,
    ).toBe(false);
    expect(
      backendItemSchema.parse({
        backendItemId: "backend-message-1",
        backendTurnId: "backend-turn-1",
        semanticKind: "user_message",
        status: "completed",
        sourceOrder: 0,
        deliveryOperationId: "operation-1",
        content: [{ kind: "task_context", task }],
      }),
    ).toMatchObject({ content: [{ kind: "task_context", task }] });
    expect(
      userMessageItemSchema.safeParse({
        ...normalized,
        content: [
          { kind: "task_context", task },
          { kind: "task_context", task },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires bounded task counts and exposes closed delivery errors", () => {
    expect(
      queuedInputSummarySchema.parse({
        id: "queued-1",
        deliveryOperationId: "queued-operation-1",
        sequence: 1,
        origin: "user",
        isHead: true,
        state: "pending",
        resolvedDeliveryMode: "queue",
        attachmentCount: 0,
        taskCount: 1,
        preview: { text: task.title },
        createdAt: "2026-08-11T20:00:00.000Z",
      }),
    ).toMatchObject({ taskCount: 1 });
    expect(apiErrorCodeSchema.parse("task_reference_unresolved")).toBe(
      "task_reference_unresolved",
    );
    expect(apiErrorCodeSchema.parse("task_context_too_large")).toBe(
      "task_context_too_large",
    );
  });
});
