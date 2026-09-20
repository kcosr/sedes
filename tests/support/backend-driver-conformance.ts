import { describe, expect, it } from "vitest";
import {
  backendConversationSnapshotSchema,
  sequencedBackendEventSchema,
  type SequencedBackendEvent,
} from "../../src/shared/protocol/backend.js";
import { usageSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import type { ContextExcerpt } from "../../src/shared/protocol/context-excerpts.js";
import type { MaterializedTaskContext } from "../../src/shared/protocol/tasks.js";
import {
  BackendError,
  type ConversationBackendDriver,
  type ConversationBinding,
  type ConversationHandle,
  type CreateConversationResult,
} from "../../src/server/backends/contracts.js";
import type {
  ExecutionScope,
  ValidatedWorkspace,
} from "../../src/server/execution/contracts.js";

export interface BackendDriverConformanceFixture {
  readonly driver: ConversationBackendDriver;
  readonly scope: ExecutionScope;
  readonly workspace: ValidatedWorkspace;
  binding(
    created: CreateConversationResult,
    applicationThreadId?: string,
  ): ConversationBinding;
  dispose?(): Promise<void>;
}

export type BackendDriverConformanceFactory = (options?: {
  readonly completeTurns?: boolean;
}) => Promise<BackendDriverConformanceFixture>;

const EMPTY_CONTEXT_EXCERPTS = [] as const;
const EMPTY_TASK_CONTEXTS = [] as const;

const submittedContextExcerpt = {
  id: "10000000-0000-4000-8000-000000000001",
  excerpt: "export function start(): void {",
  note: "Keep this entry point stable.",
  source: {
    kind: "workspace_file",
    rootId: "primary",
    path: "src/start.ts",
    revision: "revision-submit-1",
  },
  locator: { kind: "line_range", startLine: 12, endLine: 12 },
} satisfies ContextExcerpt;

const steeredContextExcerpt = {
  id: "10000000-0000-4000-8000-000000000002",
  excerpt: "Use the normalized message behavior.",
  note: "Preserve this clarification.",
  source: {
    kind: "conversation_message",
    itemId: "normalized-message-item-1",
    itemRevision: 3,
  },
  locator: {
    kind: "text_quote",
    prefix: "Earlier context: ",
    suffix: " Continue with the request.",
  },
} satisfies ContextExcerpt;

const submittedTaskContext = {
  id: "10000000-0000-4000-8000-000000000003",
  scope: {
    kind: "workspace",
    workspaceId: "20000000-0000-4000-8000-000000000002",
  },
  title: "Implement task-context delivery",
  details: "Preserve this exact immutable Task snapshot.",
  pinned: false,
  files: ["/work/conformance/src/task-context.ts"],
  completedAt: null,
  revision: 7,
  createdAt: "2026-07-30T17:00:00.000Z",
  updatedAt: "2026-07-30T17:30:00.000Z",
} satisfies MaterializedTaskContext;

async function closeAll(
  handles: readonly ConversationHandle[],
  fixture: BackendDriverConformanceFixture,
): Promise<void> {
  await Promise.all(handles.map((handle) => handle.close()));
  await fixture.dispose?.();
}

function expectBackendError(
  value: unknown,
  category: BackendError["category"],
  backendCode?: string,
): void {
  expect(value).toBeInstanceOf(BackendError);
  expect(value).toMatchObject({
    category,
    retryable: expect.any(Boolean),
    crossedSubmissionBoundary: expect.any(Boolean),
    ...(backendCode ? { backendCode } : {}),
  });
}

async function activeBackendTurnId(
  handle: ConversationHandle,
): Promise<string> {
  const history = await handle.history({ limit: 1_000 });
  const active = history.orderedBackendTurnIds.find(
    (backendTurnId) =>
      history.turnsById[backendTurnId]?.status === "in_progress",
  );
  if (!active) throw new Error("Expected one active backend turn.");
  return active;
}

export function describeBackendDriverConformance(
  name: string,
  createFixture: BackendDriverConformanceFactory,
): void {
  describe(`${name} backend driver conformance`, () => {
    it("rejects discovery before provider work when already cancelled", async () => {
      const fixture = await createFixture();
      const cancellation = new Error("discovery cancelled");
      const controller = new AbortController();
      controller.abort(cancellation);
      try {
        await expect(
          fixture.driver.discover({
            scope: fixture.scope,
            workspace: fixture.workspace,
            signal: controller.signal,
            limit: 1,
          }),
        ).rejects.toBe(cancellation);
      } finally {
        await fixture.dispose?.();
      }
    });

    it("creates, discovers, attaches, reads, and closes conversations", async () => {
      const fixture = await createFixture();
      const { driver, scope, workspace } = fixture;
      const health = await driver.health();
      expect(health.available).toBe(true);
      const catalog = await driver.catalog({ scope, workspace });
      expect(catalog.models.length).toBeGreaterThan(0);

      const created = await driver.create({
        scope,
        workspace,
        applicationThreadId: "create-one",
        applicationOperationId: "create-one",
        source: { kind: "user" },
        title: "First conversation",
      });
      const repeated = await driver.create({
        scope,
        workspace,
        applicationThreadId: "create-one",
        applicationOperationId: "create-one",
        source: { kind: "user" },
        title: "Ignored retry title",
      });
      expect(repeated).toEqual(created);
      await driver.create({
        scope,
        workspace,
        applicationThreadId: "create-two",
        applicationOperationId: "create-two",
        source: { kind: "user" },
        title: "Second conversation",
      });

      const firstPage = await driver.discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        limit: 1,
      });
      expect(firstPage.conversations).toHaveLength(1);
      expect(firstPage.nextCursor).toBeTypeOf("string");
      const secondPage = await driver.discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        cursor: firstPage.nextCursor,
        limit: 1,
      });
      expect(secondPage.conversations).toHaveLength(1);
      expect(
        new Set(
          [...firstPage.conversations, ...secondPage.conversations].map(
            ({ backendConversationId }) => backendConversationId,
          ),
        ).size,
      ).toBe(2);

      const binding = fixture.binding(created);
      const handle = await driver.attach({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      expect(handle.binding).toEqual(binding);
      const read = await driver.read({
        scope,
        binding,
        workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      expect(() =>
        backendConversationSnapshotSchema.parse(read.snapshot),
      ).not.toThrow();
      expect(() => usageSnapshotSchema.parse(read.usage)).not.toThrow();
      expect(
        await driver.reconcileSubmission({
          scope,
          workspace,
          applicationOperationId: "create-one",
          reconciliationToken: created.reconciliationToken,
        }),
      ).toMatchObject({ status: "accepted" });

      await handle.close();
      await handle.close();
      let closedError: unknown;
      try {
        await handle.usage();
      } catch (error) {
        closedError = error;
      }
      expectBackendError(closedError, "unavailable");
      await fixture.dispose?.();
    });

    it("establishes one gap-free projection and sequences buffered live events", async () => {
      const fixture = await createFixture();
      const created = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "projection-create",
        applicationOperationId: "projection-create",
        source: { kind: "user" },
      });
      const handle = await fixture.driver.attach({
        scope: fixture.scope,
        binding: fixture.binding(created),
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const rawTypes: string[] = [];
      handle.subscribe((event) => rawTypes.push(event.type));
      const established = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(established.snapshot.runState).toBe("idle");

      await handle.submit({
        applicationOperationId: "projection-submit",
        source: { kind: "user" },
        mutationId: "projection-mutation",
        reconciliationToken: "projection-mutation",
        text: "Begin projection",
        contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
        taskContexts: EMPTY_TASK_CONTEXTS,
        attachments: [],
      });
      const sequenced: SequencedBackendEvent[] = [];
      established.subscribeFromNext((event) => sequenced.push(event));
      await handle.interrupt({
        applicationOperationId: "projection-interrupt",
        expectedBackendTurnId: await activeBackendTurnId(handle),
      });

      expect(sequenced.length).toBeGreaterThanOrEqual(7);
      expect(sequenced.map(({ handleSequence }) => handleSequence)).toEqual(
        sequenced.map((_, index) => established.handleSequence + index + 1),
      );
      for (const event of sequenced) {
        expect(() => sequencedBackendEventSchema.parse(event)).not.toThrow();
      }
      expect(rawTypes).toEqual(sequenced.map(({ event }) => event.type));
      await closeAll([handle], fixture);
    });

    it("honors projection-establishment cancellation", async () => {
      const fixture = await createFixture();
      const created = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "cancel-create",
        applicationOperationId: "cancel-create",
        source: { kind: "user" },
      });
      const handle = await fixture.driver.attach({
        scope: fixture.scope,
        binding: fixture.binding(created),
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const controller = new AbortController();
      const establishing = handle.establishProjection({
        signal: controller.signal,
      });
      controller.abort();
      let cancellation: unknown;
      try {
        await establishing;
      } catch (error) {
        cancellation = error;
      }
      expectBackendError(cancellation, "unavailable");
      const recovered = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(recovered.snapshot.runState).toBe("idle");
      await closeAll([handle], fixture);
    });

    it("enforces submit, steer, and interrupt eligibility and reconciles accepted delivery", async () => {
      const fixture = await createFixture();
      const created = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "lifecycle-create",
        applicationOperationId: "lifecycle-create",
        source: { kind: "user" },
      });
      const binding = fixture.binding(created);
      const handle = await fixture.driver.attach({
        scope: fixture.scope,
        binding,
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });

      let idleSteerError: unknown;
      try {
        await handle.steer({
          applicationOperationId: "idle-steer",
          mutationId: "idle-steer-mutation",
          reconciliationToken: "idle-steer-mutation",
          target: { kind: "turn", turnId: "no-active-turn" },
          text: "Cannot steer",
          contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
          taskContexts: EMPTY_TASK_CONTEXTS,
          attachments: [],
        });
      } catch (error) {
        idleSteerError = error;
      }
      expectBackendError(idleSteerError, "invalid_state");

      const retryAnchor = await handle.captureSubmissionRetryAnchor();
      expect(
        new TextEncoder().encode(retryAnchor).byteLength,
      ).toBeLessThanOrEqual(4_096);
      const submitted = await handle.submit({
        applicationOperationId: "submit-operation",
        source: { kind: "user" },
        mutationId: "submit-mutation",
        reconciliationToken: "submit-mutation",
        text: "Start work",
        contextExcerpts: [submittedContextExcerpt],
        taskContexts: EMPTY_TASK_CONTEXTS,
        attachments: [],
      });
      expect(submitted.reconciliationToken).toBe("submit-mutation");
      expect(
        await handle.submit({
          applicationOperationId: "submit-operation",
          source: { kind: "user" },
          mutationId: "submit-mutation",
          reconciliationToken: "submit-mutation",
          text: "Start work",
          contextExcerpts: [submittedContextExcerpt],
          taskContexts: EMPTY_TASK_CONTEXTS,
          attachments: [],
        }),
      ).toEqual(submitted);
      let replayMismatch: unknown;
      try {
        await handle.submit({
          applicationOperationId: "submit-operation",
          source: { kind: "user" },
          mutationId: "submit-mutation",
          reconciliationToken: "submit-mutation",
          text: "Start work",
          contextExcerpts: [
            { ...submittedContextExcerpt, note: "Changed replay note." },
          ],
          taskContexts: EMPTY_TASK_CONTEXTS,
          attachments: [],
        });
      } catch (error) {
        replayMismatch = error;
      }
      expectBackendError(replayMismatch, "rejected");
      let concurrentSubmitError: unknown;
      try {
        await handle.submit({
          applicationOperationId: "other-submit",
          source: { kind: "user" },
          mutationId: "other-mutation",
          reconciliationToken: "other-mutation",
          text: "Too soon",
          contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
          taskContexts: EMPTY_TASK_CONTEXTS,
          attachments: [],
        });
      } catch (error) {
        concurrentSubmitError = error;
      }
      expectBackendError(concurrentSubmitError, "invalid_state");
      let runningAnchorError: unknown;
      try {
        await handle.captureSubmissionRetryAnchor();
      } catch (error) {
        runningAnchorError = error;
      }
      expectBackendError(runningAnchorError, "invalid_state");

      await expect(handle.steer({
        applicationOperationId: "wrong-target-kind", mutationId: "wrong-target-kind",
        reconciliationToken: "wrong-target-kind", target: { kind: "conversation" },
        text: "Invalid conversation target", contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
        taskContexts: EMPTY_TASK_CONTEXTS, attachments: [],
      })).rejects.toMatchObject({ category: "invalid_state", crossedSubmissionBoundary: false });

      const steeringTarget = await activeBackendTurnId(handle);
      const steering = await handle.steer({
        applicationOperationId: "steer-operation",
        mutationId: "steer-mutation",
        reconciliationToken: "steer-mutation",
        target: { kind: "turn", turnId: steeringTarget },
        text: "Change direction",
        contextExcerpts: [steeredContextExcerpt],
        taskContexts: EMPTY_TASK_CONTEXTS,
        attachments: [],
      });
      expect(steering.reconciliationToken).toBe("steer-mutation");
      const interruptTarget = await activeBackendTurnId(handle);
      await handle.interrupt({
        applicationOperationId: "interrupt-operation",
        expectedBackendTurnId: interruptTarget,
      });
      await expect(
        handle.reconcileInterrupt({
          applicationOperationId: "interrupt-operation",
          expectedBackendTurnId: interruptTarget,
        }),
      ).resolves.toEqual({ outcome: "accepted" });
      await handle.interrupt({
        applicationOperationId: "interrupt-operation",
        expectedBackendTurnId: interruptTarget,
      });
      let idleInterruptError: unknown;
      try {
        await handle.interrupt({
          applicationOperationId: "second-interrupt",
          expectedBackendTurnId: interruptTarget,
        });
      } catch (error) {
        idleInterruptError = error;
      }
      expectBackendError(idleInterruptError, "invalid_state");

      const submittedReconciliation = await fixture.driver.reconcileSubmission({
        scope: fixture.scope,
        binding,
        workspace: fixture.workspace,
        applicationOperationId: "submit-operation",
        reconciliationToken: submitted.reconciliationToken,
      });
      const steeredReconciliation = await fixture.driver.reconcileSubmission({
        scope: fixture.scope,
        binding,
        workspace: fixture.workspace,
        applicationOperationId: "steer-operation",
        reconciliationToken: steering.reconciliationToken,
      });
      expect(submittedReconciliation).toMatchObject({
        status: "accepted",
        backendTurn: {
          status: "completed",
          endedBy: "steer",
        },
        completionIdentity: expect.any(String),
      });
      expect(steeredReconciliation).toMatchObject({
        status: "accepted",
        backendTurn: {
          status: "interrupted",
          endedBy: "interrupted",
        },
        completionIdentity: expect.any(String),
      });
      expect(
        await fixture.driver.reconcileSubmission({
          scope: fixture.scope,
          binding,
          workspace: fixture.workspace,
          applicationOperationId: "reconcile-missing",
          reconciliationToken: "missing-token",
          retryAnchor,
        }),
      ).toMatchObject({ status: "unresolved" });

      const read = await fixture.driver.read({
        scope: fixture.scope,
        binding,
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      expect(read.snapshot.runState).toBe("idle");
      expect(read.snapshot.orderedBackendTurnIds).toHaveLength(2);
      expect(
        Object.values(read.snapshot.turnsById).map(({ status }) => status),
      ).toEqual(["completed", "interrupted"]);
      const userContent = read.snapshot.orderedBackendTurnIds.map((turnId) => {
        const itemId =
          read.snapshot.turnsById[turnId]!.orderedBackendItemIds[0]!;
        const item = read.snapshot.itemsById[itemId]!;
        if (item.semanticKind !== "user_message") {
          throw new Error("expected_conformance_user_message");
        }
        return item.content;
      });
      expect(userContent).toEqual([
        [
          { kind: "context_excerpt", excerpt: submittedContextExcerpt },
          { kind: "text", text: { text: "Start work" } },
        ],
        [
          { kind: "context_excerpt", excerpt: steeredContextExcerpt },
          { kind: "text", text: { text: "Change direction" } },
        ],
      ]);
      const replayedHistory = await handle.history({ limit: 10 });
      expect(
        replayedHistory.orderedBackendTurnIds.map((turnId) => {
          const itemId =
            replayedHistory.turnsById[turnId]!.orderedBackendItemIds[0]!;
          const item = replayedHistory.itemsById[itemId]!;
          return item.semanticKind === "user_message"
            ? item.content
            : undefined;
        }),
      ).toEqual(userContent);
      await closeAll([handle], fixture);
    });

    it("accepts task-only input and projects its immutable Task snapshot", async () => {
      const fixture = await createFixture();
      const created = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "task-context-create",
        applicationOperationId: "task-context-create",
        source: { kind: "user" },
      });
      const handle = await fixture.driver.attach({
        scope: fixture.scope,
        binding: fixture.binding(created),
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const submitted = await handle.submit({
        applicationOperationId: "task-context-submit",
        source: { kind: "user" },
        mutationId: "task-context-mutation",
        reconciliationToken: "task-context-mutation",
        text: "",
        contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
        taskContexts: [submittedTaskContext],
        attachments: [],
      });
      const page = await handle.history({ limit: 10 });
      const turn = page.turnsById[submitted.backendTurnId!];
      const message = turn?.orderedBackendItemIds
        .map((itemId) => page.itemsById[itemId])
        .find((item) => item?.semanticKind === "user_message");
      expect(message).toMatchObject({
        semanticKind: "user_message",
        deliveryOperationId: "task-context-submit",
        content: [{ kind: "task_context", task: submittedTaskContext }],
      });

      let mismatch: unknown;
      try {
        await handle.submit({
          applicationOperationId: "task-context-submit",
          source: { kind: "user" },
          mutationId: "task-context-mutation",
          reconciliationToken: "task-context-mutation",
          text: "",
          contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
          taskContexts: [{ ...submittedTaskContext, revision: 8 }],
          attachments: [],
        });
      } catch (error) {
        mismatch = error;
      }
      expectBackendError(mismatch, "rejected");
      await handle.interrupt({
        applicationOperationId: "task-context-interrupt",
        expectedBackendTurnId: await activeBackendTurnId(handle),
      });
      await closeAll([handle], fixture);
    });

    it("reports capabilities, applies actions, and exposes usage and paged history", async () => {
      const fixture = await createFixture();
      const created = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "actions-create",
        applicationOperationId: "actions-create",
        source: { kind: "user" },
        title: "Before rename",
      });
      const handle = await fixture.driver.attach({
        scope: fixture.scope,
        binding: fixture.binding(created),
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const capability = await handle.backendCapabilities();
      const catalog = await fixture.driver.catalog({
        scope: fixture.scope,
        workspace: fixture.workspace,
      });
      const model = catalog.models[0];
      if (!model) {
        throw new Error("conformance_backend_model_missing");
      }
      expect(model.inputModalities).toContain("text");
      expect(capability).toMatchObject({
        deliveryModes: expect.arrayContaining(["submit", "steer"]),
        nonblockingQuestions: expect.any(Boolean),
        providerOutputArtifacts: { nativeImage: expect.any(Boolean) },
        composerAttachments: {
          fileStaging: true,
          nativeImage: expect.any(Boolean),
        },
        supportsHistory: true,
        branching: expect.objectContaining({
          availability: "available",
          boundaries: expect.arrayContaining(["selected_completed_turn"]),
        }),
      });
      expect(capability.actions).toEqual(
        expect.arrayContaining(["rename", "compact", "set_model"]),
      );

      for (const index of [1, 2]) {
        await handle.submit({
          applicationOperationId: `history-submit-${index}`,
          source: { kind: "user" },
          mutationId: `history-mutation-${index}`,
          reconciliationToken: `history-mutation-${index}`,
          text: `History turn ${index}`,
          contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
          taskContexts: EMPTY_TASK_CONTEXTS,
          attachments: [],
        });
        await handle.interrupt({
          applicationOperationId: `history-interrupt-${index}`,
          expectedBackendTurnId: await activeBackendTurnId(handle),
        });
      }
      const renameAction = {
        applicationOperationId: "conformance-rename",
        action: "rename" as const,
        title: "After rename",
      };
      await expect(handle.reconcileAction(renameAction)).resolves.toEqual({
        outcome: "not_applied",
      });
      await handle.perform(renameAction);
      await expect(handle.reconcileAction(renameAction)).resolves.toEqual({
        outcome: "accepted",
      });
      await handle.perform({
        applicationOperationId: "conformance-model",
        action: "set_model",
        provider: model.provider,
        modelId: model.id,
      });
      await handle.perform({
        applicationOperationId: "conformance-thinking",
        action: "set_thinking_level",
        level: "low",
      });
      await handle.perform({
        applicationOperationId: "conformance-tools",
        action: "set_tool_access",
        mode: "full",
      });
      await handle.perform({
        applicationOperationId: "conformance-compact",
        action: "compact",
        instructions: "Retain the decisions.",
      });

      const usage = await handle.usage();
      expect(() => usageSnapshotSchema.parse(usage)).not.toThrow();
      expect(usage.counters).toMatchObject({
        requests: 2,
        compactions: 1,
      });
      const first = await handle.history({ limit: 1 });
      expect(first.orderedBackendTurnIds).toHaveLength(1);
      expect(first.previousCursor).toBeTypeOf("string");
      const current = await fixture.driver.read({
        scope: fixture.scope,
        binding: handle.binding,
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      expect(first.orderedBackendTurnIds[0]).toBe(
        current.snapshot.orderedBackendTurnIds.at(-1),
      );
      const compaction = Object.values(current.snapshot.itemsById).find(
        (item) => item.semanticKind === "compaction",
      );
      expect(compaction).toMatchObject({ semanticKind: "compaction" });
      expect(compaction).not.toHaveProperty("summary");
      const second = await handle.history({
        cursor: first.previousCursor,
        limit: 1,
      });
      expect(second.orderedBackendTurnIds).toHaveLength(1);
      expect(second.orderedBackendTurnIds[0]).not.toBe(
        first.orderedBackendTurnIds[0],
      );
      expect(second.orderedBackendTurnIds[0]).toBe(
        current.snapshot.orderedBackendTurnIds.at(-2),
      );
      expect(
        (
          await fixture.driver.discover({
            scope: fixture.scope,
            workspace: fixture.workspace,
            signal: new AbortController().signal,
            limit: 10,
          })
        ).conversations,
      ).toContainEqual(
        expect.objectContaining({
          backendConversationId: created.backendConversationId,
          title: "After rename",
        }),
      );
      await closeAll([handle], fixture);
    });

    it("locates one exact historical turn behind an active head within an explicit candidate bound", async () => {
      const fixture = await createFixture();
      const created = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "locate-turn-create",
        applicationOperationId: "locate-turn-create",
        source: { kind: "user" },
      });
      const handle = await fixture.driver.attach({
        scope: fixture.scope,
        binding: fixture.binding(created),
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const first = await handle.submit({
        applicationOperationId: "locate-turn-first-submit",
        source: { kind: "user" },
        mutationId: "locate-turn-first-mutation",
        reconciliationToken: "locate-turn-first-mutation",
        text: "Locate this first turn.",
        contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
        taskContexts: EMPTY_TASK_CONTEXTS,
        attachments: [],
      });
      const firstTurnId = first.backendTurnId;
      if (!firstTurnId) throw new Error("conformance_located_turn_missing");
      await handle.interrupt({
        applicationOperationId: "locate-turn-first-interrupt",
        expectedBackendTurnId: firstTurnId,
      });

      const second = await handle.submit({
        applicationOperationId: "locate-turn-second-submit",
        source: { kind: "user" },
        mutationId: "locate-turn-second-mutation",
        reconciliationToken: "locate-turn-second-mutation",
        text: "Put a newer turn ahead of the first.",
        contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
        taskContexts: EMPTY_TASK_CONTEXTS,
        attachments: [],
      });
      const secondTurnId = second.backendTurnId;
      if (!secondTurnId) throw new Error("conformance_newest_turn_missing");
      const found = await handle.locateTurn({
        matchesBackendTurnId: (candidate) => candidate === firstTurnId,
        maximumTurnCandidates: 2,
      });
      expect(found).toMatchObject({
        status: "found",
        page: {
          orderedBackendTurnIds: [firstTurnId],
          turnsById: {
            [firstTurnId]: { status: "interrupted" },
          },
        },
      });
      if (found.status !== "found") {
        throw new Error("conformance_historical_turn_not_located");
      }
      expect(found.page.previousCursor).toBeUndefined();
      expect(Object.keys(found.page.turnsById)).toEqual([firstTurnId]);
      expect(
        Object.values(found.page.itemsById).every(
          ({ backendTurnId }) => backendTurnId === firstTurnId,
        ),
      ).toBe(true);
      let examined = 0;
      await expect(
        handle.locateTurn({
          matchesBackendTurnId: (candidate) => {
            examined += 1;
            return candidate === firstTurnId;
          },
          maximumTurnCandidates: 1,
        }),
      ).resolves.toEqual({ status: "search_limit_reached" });
      expect(examined).toBe(1);
      await expect(
        handle.locateTurn({
          matchesBackendTurnId: () => false,
          maximumTurnCandidates: 10,
        }),
      ).resolves.toEqual({ status: "not_found" });
      await handle.interrupt({
        applicationOperationId: "locate-turn-second-interrupt",
        expectedBackendTurnId: secondTurnId,
      });
      await closeAll([handle], fixture);
    });

    it("isolates subscribers and preserves accepted delivery when one throws", async () => {
      const fixture = await createFixture();
      const created = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "subscriber-create",
        applicationOperationId: "subscriber-create",
        source: { kind: "user" },
      });
      const binding = fixture.binding(created);
      const first = await fixture.driver.attach({
        scope: fixture.scope,
        binding,
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const second = await fixture.driver.attach({
        scope: fixture.scope,
        binding,
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      first.subscribe((event) => {
        (event as { type: string }).type = "corrupted";
        throw new Error("subscriber failure");
      });
      const firstProjection = await first.establishProjection({
        signal: new AbortController().signal,
      });
      firstProjection.subscribeFromNext(() => {
        throw new Error("projection subscriber failure");
      });
      const secondProjection = await second.establishProjection({
        signal: new AbortController().signal,
      });
      const observed: SequencedBackendEvent[] = [];
      secondProjection.subscribeFromNext((event) => observed.push(event));

      const accepted = await first.submit({
        applicationOperationId: "subscriber-submit",
        source: { kind: "user" },
        mutationId: "subscriber-mutation",
        reconciliationToken: "subscriber-mutation",
        text: "Subscriber failures cannot affect acceptance.",
        contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
        taskContexts: EMPTY_TASK_CONTEXTS,
        attachments: [],
      });
      expect(observed.length).toBeGreaterThan(0);
      expect(observed[0]?.event.type).toBe("turn_started");
      expect(
        await fixture.driver.reconcileSubmission({
          scope: fixture.scope,
          binding,
          workspace: fixture.workspace,
          applicationOperationId: "subscriber-submit",
          reconciliationToken: accepted.reconciliationToken,
        }),
      ).toMatchObject({ status: "accepted" });

      await first.interrupt({
        applicationOperationId: "subscriber-interrupt",
        expectedBackendTurnId: await activeBackendTurnId(first),
      });
      await first.close();
      await second.close();

      const reattached = await fixture.driver.attach({
        scope: fixture.scope,
        binding,
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const replacement = await reattached.establishProjection({
        signal: new AbortController().signal,
      });
      expect(replacement.snapshot.runState).toBe("idle");
      expect(replacement.snapshot.orderedBackendTurnIds).toHaveLength(1);
      await closeAll([reattached], fixture);
    });

    it("scopes idempotency and reconciliation to the originating conversation", async () => {
      const fixture = await createFixture();
      const firstCreated = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "scope-first-create",
        applicationOperationId: "scope-first-create",
        source: { kind: "user" },
      });
      const secondCreated = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "scope-second-create",
        applicationOperationId: "scope-second-create",
        source: { kind: "user" },
      });
      const firstBinding = fixture.binding(firstCreated, "scope-first-thread");
      const secondBinding = fixture.binding(
        secondCreated,
        "scope-second-thread",
      );
      const first = await fixture.driver.attach({
        scope: fixture.scope,
        binding: firstBinding,
        workspace: fixture.workspace,
        opaqueBindingDetail: firstCreated.opaqueBindingDetail,
      });
      const second = await fixture.driver.attach({
        scope: fixture.scope,
        binding: secondBinding,
        workspace: fixture.workspace,
        opaqueBindingDetail: secondCreated.opaqueBindingDetail,
      });
      const firstAccepted = await first.submit({
        applicationOperationId: "same-operation",
        source: { kind: "user" },
        mutationId: "first-mutation",
        reconciliationToken: "first-mutation",
        text: "First conversation",
        contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
        taskContexts: EMPTY_TASK_CONTEXTS,
        attachments: [],
      });
      const secondAccepted = await second.submit({
        applicationOperationId: "same-operation",
        source: { kind: "user" },
        mutationId: "second-mutation",
        reconciliationToken: "second-mutation",
        text: "Second conversation",
        contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
        taskContexts: EMPTY_TASK_CONTEXTS,
        attachments: [],
      });
      expect(secondAccepted.reconciliationToken).not.toBe(
        firstAccepted.reconciliationToken,
      );
      expect(
        await fixture.driver.reconcileSubmission({
          scope: fixture.scope,
          binding: secondBinding,
          workspace: fixture.workspace,
          applicationOperationId: "same-operation",
          reconciliationToken: firstAccepted.reconciliationToken,
        }),
      ).toMatchObject({ status: "not_accepted" });
      await first.interrupt({
        applicationOperationId: "scope-first-stop",
        expectedBackendTurnId: await activeBackendTurnId(first),
      });
      await second.interrupt({
        applicationOperationId: "scope-second-stop",
        expectedBackendTurnId: await activeBackendTurnId(second),
      });
      await closeAll([first, second], fixture);
    });

    it("resolves checkpoints and branches an independent conversation", async () => {
      const fixture = await createFixture({ completeTurns: true });
      const source = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "branch-source-create",
        applicationOperationId: "branch-source-create",
        source: { kind: "user" },
      });
      const sourceBinding = fixture.binding(source, "source-thread");
      const sourceHandle = await fixture.driver.attach({
        scope: fixture.scope,
        binding: sourceBinding,
        workspace: fixture.workspace,
        opaqueBindingDetail: source.opaqueBindingDetail,
      });
      await sourceHandle.submit({
        applicationOperationId: "branch-source-submit",
        source: { kind: "user" },
        mutationId: "branch-source-mutation",
        reconciliationToken: "branch-source-mutation",
        text: "Checkpoint content",
        contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
        taskContexts: EMPTY_TASK_CONTEXTS,
        attachments: [],
      });
      await expect
        .poll(async () => {
          const page = await sourceHandle.history({ limit: 1_000 });
          const latest = page.orderedBackendTurnIds.at(-1);
          return latest ? page.turnsById[latest]?.endedBy : undefined;
        })
        .toBe("agent_settled");
      const checkpoint = await fixture.driver.resolveBranchCheckpoint({
        scope: fixture.scope,
        binding: sourceBinding,
        workspace: fixture.workspace,
        opaqueBindingDetail: source.opaqueBindingDetail,
        selection: { kind: "latest_completed" },
      });
      const branch = await fixture.driver.branchConversation({
        scope: fixture.scope,
        applicationOperationId: "branch-create",
        childApplicationThreadId: "branch-thread",
        source: { kind: "user" },
        sourceBinding,
        sourceOpaqueBindingDetail: source.opaqueBindingDetail,
        workspace: fixture.workspace,
        sourceCheckpoint: checkpoint,
        requestedBackendConversationId: "branch-native-child",
        inheritedSettings: { toolAccess: "full" },
        title: "Branched",
      });
      const branchBinding = fixture.binding(branch, "branch-thread");
      const branchRead = await fixture.driver.read({
        scope: fixture.scope,
        binding: branchBinding,
        workspace: fixture.workspace,
        opaqueBindingDetail: branch.opaqueBindingDetail,
      });
      expect(branchRead.snapshot.orderedBackendTurnIds).toHaveLength(1);

      await sourceHandle.submit({
        applicationOperationId: "source-after-checkpoint",
        source: { kind: "user" },
        mutationId: "source-after-checkpoint-mutation",
        reconciliationToken: "source-after-checkpoint-mutation",
        text: "Only in source",
        contextExcerpts: EMPTY_CONTEXT_EXCERPTS,
        taskContexts: EMPTY_TASK_CONTEXTS,
        attachments: [],
      });
      await expect
        .poll(async () => {
          const page = await sourceHandle.history({ limit: 1_000 });
          const latest = page.orderedBackendTurnIds.at(-1);
          return latest ? page.turnsById[latest]?.endedBy : undefined;
        })
        .toBe("agent_settled");
      const unchangedBranch = await fixture.driver.read({
        scope: fixture.scope,
        binding: branchBinding,
        workspace: fixture.workspace,
        opaqueBindingDetail: branch.opaqueBindingDetail,
      });
      expect(unchangedBranch.snapshot.orderedBackendTurnIds).toHaveLength(1);

      let foreignCheckpointError: unknown;
      try {
        await fixture.driver.branchConversation({
          scope: fixture.scope,
          applicationOperationId: "foreign-branch",
          childApplicationThreadId: "foreign-branch-thread",
          source: { kind: "user" },
          sourceBinding,
          sourceOpaqueBindingDetail: source.opaqueBindingDetail,
          workspace: fixture.workspace,
          sourceCheckpoint: {
            ...checkpoint,
            backendInstanceId: "other-backend",
          },
          requestedBackendConversationId: "foreign-branch-native-child",
        });
      } catch (error) {
        foreignCheckpointError = error;
      }
      expectBackendError(foreignCheckpointError, "permission_denied");
      await closeAll([sourceHandle], fixture);
    });

    it("uses typed errors for isolation, invalid cursors, and unsupported interactions", async () => {
      const fixture = await createFixture();
      let scopeError: unknown;
      try {
        await fixture.driver.create({
          scope: {
            ...fixture.scope,
            principalId: "different-principal",
          },
          workspace: fixture.workspace,
          applicationThreadId: "wrong-scope",
          applicationOperationId: "wrong-scope",
          source: { kind: "user" },
        });
      } catch (error) {
        scopeError = error;
      }
      expectBackendError(scopeError, "permission_denied");

      const created = await fixture.driver.create({
        scope: fixture.scope,
        workspace: fixture.workspace,
        applicationThreadId: "errors-create",
        applicationOperationId: "errors-create",
        source: { kind: "user" },
      });
      let bindingError: unknown;
      try {
        await fixture.driver.attach({
          scope: fixture.scope,
          binding: fixture.binding(created),
          workspace: fixture.workspace,
          opaqueBindingDetail: "wrong-opaque-detail",
        });
      } catch (error) {
        bindingError = error;
      }
      expectBackendError(bindingError, "not_found");
      const handle = await fixture.driver.attach({
        scope: fixture.scope,
        binding: fixture.binding(created),
        workspace: fixture.workspace,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      let interactionError: unknown;
      try {
        await handle.respond({
          applicationOperationId: "unsupported-interaction-response",
          interactionId: "unsupported",
          kind: "confirmation",
          confirmed: true,
        });
      } catch (error) {
        interactionError = error;
      }
      expectBackendError(interactionError, "rejected");
      let modelError: unknown;
      try {
        await handle.perform({
          applicationOperationId: "conformance-missing-model",
          action: "set_model",
          provider: "missing",
          modelId: "missing",
        });
      } catch (error) {
        modelError = error;
      }
      expectBackendError(modelError, "rejected");
      let cursorError: unknown;
      try {
        await handle.history({ cursor: "invalid", limit: 1 });
      } catch (error) {
        cursorError = error;
      }
      expectBackendError(cursorError, "rejected");
      await closeAll([handle], fixture);
    });
  });
}
