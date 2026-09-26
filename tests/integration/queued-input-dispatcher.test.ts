import type { SteerTarget } from "../../src/shared/protocol/conversation.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BackendError } from "../../src/server/backends/contracts.js";
import type {
  SteerTurnInput,
  SteerTurnResult,
  SubmissionReconciliation,
  SubmitTurnResult,
} from "../../src/server/backends/contracts.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { serializePiBindingDetail } from "../../src/server/backends/pi/pi-session-store.js";
import {
  type QueueDispatchScheduler,
  type QueueEventPublisher,
  QueuedInputDispatcher,
} from "../../src/server/conversations/queued-input-dispatcher.js";
import { projectQueuedInputSummaries } from "../../src/server/conversations/queued-input-projection.js";
import type {
  QueuedInputConversation,
  QueuedInputConversationGateway,
} from "../../src/server/conversations/queued-input-conversation-gateway.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { PiConversationRepository } from "../../src/server/backends/pi/pi-conversation-repository.js";
import {
  MAXIMUM_ACTIVE_QUEUED_INPUTS,
  QueuedInputRepository,
} from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ThreadCompletionCallbackRepository } from "../../src/server/db/repositories/thread-completion-callback-repository.js";
import { ThreadCompletionCallbackDispatcher } from "../../src/server/conversations/thread-completion-callback-dispatcher.js";
import { ComposerAttachmentRepository } from "../../src/server/db/repositories/composer-attachment-repository.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { normalizedThreadEventSchema } from "../../src/shared/protocol/conversation.js";

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Primary Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "local-primary",
      kind: "pi_sdk",
      label: "Primary Local SDK",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

type Fixture = {
  readonly database: ReturnType<typeof openOverlayDatabase>;
  readonly scope: RequestScope;
  readonly threadIds: readonly [string, string];
  readonly automationSources: ReadonlyMap<
    string,
    {
      readonly automationId: string;
      sequence: number;
      currentRunId?: string;
      currentClaimToken?: string;
    }
  >;
};

function createFixture(): Fixture {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const inventory = new ThreadInventoryService(new OverlayRepository(database));
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: `/tmp/queue-dispatcher-${randomUUID()}`,
      displayName: "Queue dispatcher",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const first = inventory.createThread(
    scope,
    { workspaceId: workspace.id, title: "First" },
    200,
  );
  const second = inventory.createThread(
    scope,
    { workspaceId: workspace.id, title: "Second" },
    210,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const bindings = new ConversationBindingRepository(database);
  const pi = new PiConversationRepository(database);
  const automation = new AutomationRepository(database);
  const automationSources = new Map<
    string,
    {
      readonly automationId: string;
      sequence: number;
      currentRunId?: string;
      currentClaimToken?: string;
    }
  >();
  for (const [index, threadId] of [
    first.thread.id,
    second.thread.id,
  ].entries()) {
    bindings.bindDiscoveredConversation(scope, threadId, {
      backendConversationId: `session-${index}`,
      now: 400 + index,
    });
    const backendConversationId = `session-${index}`;
    const nativeSessionPath = `/tmp/queue-session-${index}.jsonl`;
    pi.saveBindingDetails(scope, threadId, {
      backendConversationId,
      opaqueBindingDetail: serializePiBindingDetail(
        backendConversationId,
        nativeSessionPath,
      ),
      nativeSessionPath,
    });
    const automationId = `queue-source-automation-${index}`;
    automation.createDefinition(scope, {
      id: automationId,
      anchorThreadId: threadId,
      name: `Queue source ${index}`,
      prompt: "Queue source fixture",
      precheck: null,
      runMode: "same_thread",
      enabled: true,
      schedule: { kind: "date_time", runAt: 10_000 + index },
      misfirePolicy: "coalesce",
      nextRunAt: 10_000 + index,
      now: 450 + index,
    });
    automationSources.set(threadId, { automationId, sequence: 0 });
  }
  return {
    database,
    scope,
    threadIds: [first.thread.id, second.thread.id],
    automationSources,
  };
}

function automationSource(
  fixture: Fixture,
  threadId: string,
  mutationId: string,
): { readonly automationId: string; readonly automationRunId: string } {
  const source = fixture.automationSources.get(threadId)!;
  const repository = new AutomationRepository(fixture.database);
  if (source.currentRunId && source.currentClaimToken) {
    repository.updateRunState(
      fixture.scope,
      source.automationId,
      source.currentRunId,
      {
        expectedState: "claimed",
        state: "failed",
        claimToken: source.currentClaimToken,
        errorCode: "fixture_superseded",
        errorDiagnostic: "The fixture created a newer queue dispatch.",
        now: 501 + source.sequence * 10,
      },
    );
  }
  source.sequence += 1;
  const automationRunId = `${source.automationId}-run-${source.sequence}`;
  const claimToken = `${source.automationId}-claim-${source.sequence}`;
  repository.createManualRun(fixture.scope, source.automationId, {
    runId: automationRunId,
    occurrenceKey: `${source.automationId}-occurrence-${source.sequence}`,
    scheduledFor: 500 + source.sequence * 10,
    claimToken,
    leaseExpiresAt: 20_000 + source.sequence,
    dispatchMutationId: mutationId,
    now: 500 + source.sequence * 10,
  });
  source.currentRunId = automationRunId;
  source.currentClaimToken = claimToken;
  return { automationId: source.automationId, automationRunId };
}

function revision(fixture: Fixture, threadId: string): number {
  return (
    fixture.database
      .prepare(
        `
          SELECT revision
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(fixture.scope.tenantId, fixture.scope.principalId, threadId) as {
      revision: number;
    }
  ).revision;
}

function lastActivityAt(fixture: Fixture, threadId: string): number {
  return (
    fixture.database
      .prepare(
        `
          SELECT last_activity_at AS lastActivityAt
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(fixture.scope.tenantId, fixture.scope.principalId, threadId) as {
      lastActivityAt: number;
    }
  ).lastActivityAt;
}

function enqueue(
  fixture: Fixture,
  repository: QueuedInputRepository,
  threadId: string,
  id: string,
  now: number,
  selectedSkillId?: string,
  text = `text-${id}`,
): void {
  const mutationId = `operation-${id}`;
  const source = automationSource(fixture, threadId, mutationId);
  repository.enqueue(fixture.scope, threadId, {
    id,
    mutationId,
    text,
    contextExcerpts: [],
    attachmentIds: [],
    taskReferences: [],
    ...(selectedSkillId ? { selectedSkillId } : {}),
    source: {
      kind: "automation",
      expectedThreadRevision: revision(fixture, threadId),
      ...source,
    },
    now,
  });
}

function enqueueUser(
  fixture: Fixture,
  repository: QueuedInputRepository,
  threadId: string,
  id: string,
  now: number,
  text = `text-${id}`,
): void {
  const drafts = new ConversationDraftRepository(fixture.database);
  const current = drafts.get(fixture.scope, threadId);
  const draft = drafts.save(fixture.scope, threadId, {
    text,
    contextExcerpts: [],
    attachmentIds: [],
    taskReferenceIds: [],
    expectedRevision: current.revision,
    now,
  });
  repository.enqueue(fixture.scope, threadId, {
    id,
    mutationId: `operation-${id}`,
    text,
    contextExcerpts: [],
    attachmentIds: [],
    taskReferences: [],
    source: {
      kind: "composer",
      requestedDeliveryMode: "queue",
      resolvedDeliveryMode: "queue",
      expectedThreadRevision: revision(fixture, threadId),
      expectedDraftRevision: draft.revision,
    },
    now: now + 1,
  });
}

function enqueueUserWithAttachment(
  fixture: Fixture,
  repository: QueuedInputRepository,
  threadId: string,
  id: string,
  now: number,
): void {
  const attachmentId = randomUUID();
  new ComposerAttachmentRepository(fixture.database).recordUpload(
    fixture.scope,
    threadId,
    attachmentId,
    {
      digest: "a".repeat(64),
      byteSize: 3,
      descriptor: {
        id: attachmentId,
        kind: "file",
        fileName: "fixture.bin",
        mediaType: "application/octet-stream",
        byteSize: 3,
      },
    },
    now,
  );
  const drafts = new ConversationDraftRepository(fixture.database);
  const current = drafts.get(fixture.scope, threadId);
  const draft = drafts.save(fixture.scope, threadId, {
    text: `text-${id}`,
    contextExcerpts: [],
    attachmentIds: [attachmentId],
    taskReferenceIds: [],
    expectedRevision: current.revision,
    now,
  });
  repository.enqueue(fixture.scope, threadId, {
    id,
    mutationId: `operation-${id}`,
    text: `text-${id}`,
    contextExcerpts: [],
    attachmentIds: [attachmentId],
    taskReferences: [],
    source: {
      kind: "composer",
      requestedDeliveryMode: "queue",
      resolvedDeliveryMode: "queue",
      expectedThreadRevision: revision(fixture, threadId),
      expectedDraftRevision: draft.revision,
    },
    now: now + 1,
  });
}

type SubmitBehavior = SubmitTurnResult | Error | Promise<SubmitTurnResult>;
type SteerBehavior = SteerTurnResult | Error | Promise<SteerTurnResult>;

class FakeGateway implements QueuedInputConversationGateway {
  authoritativelySettled = true;
  readonly withConversationFailures: Error[] = [];
  readonly withConversationGates: Promise<void>[] = [];
  readonly submitBehaviors: SubmitBehavior[] = [];
  readonly steerBehaviors: SteerBehavior[] = [];
  readonly steerTargetBehaviors: Array<
    SteerTarget | null | Error
  > = [];
  readonly reconciliationBehaviors: Array<SubmissionReconciliation | Error> =
    [];
  readonly calls: string[] = [];
  readonly submitted: Parameters<QueuedInputConversation["submit"]>[0][] = [];
  readonly steered: Array<
    SteerTurnInput
  > = [];
  readonly reconciled: Array<{
    readonly applicationOperationId: string;
    readonly reconciliationToken?: string;
    readonly retryAnchor?: string;
  }> = [];
  retryAnchor = '{"version":1,"position":"queue-idle"}';
  activeTurnId: string | null = "active-turn-1";
  steerAvailable = true;
  steerTargetKind: "turn" | "conversation" = "turn";
  onSubmitBoundary: (() => void) | undefined;
  onWithConversationBoundary: (() => void) | undefined;
  onSteerTargetBoundary: (() => void) | undefined;
  onReconciliation: ((result: SubmissionReconciliation) => void) | undefined;

  async withConversation<T>(
    _scope: RequestScope,
    applicationThreadId: string,
    operation: (conversation: QueuedInputConversation) => T | Promise<T>,
  ): Promise<T> {
    const acquisitionFailure = this.withConversationFailures.shift();
    if (acquisitionFailure) throw acquisitionFailure;
    this.onWithConversationBoundary?.();
    const acquisitionGate = this.withConversationGates.shift();
    if (acquisitionGate) await acquisitionGate;
    return operation({
      generation: `generation-${applicationThreadId}`,
      authoritativelySettled: this.authoritativelySettled,
      materializeAttachments: async (attachments) => ({
        attachments: attachments.map((attachment) => ({
          ...attachment,
          sha256: "a".repeat(64),
          agentPath: `/staged/${attachment.id}`,
        })),
        canonicalBytes: {
          read: async () => {
            throw new Error("unexpected_canonical_attachment_read");
          },
        },
        canonicalEvidence: { resolve: () => [] },
      }),
      captureSubmissionRetryAnchor: async () => {
        this.calls.push(`anchor:${applicationThreadId}`);
        return this.retryAnchor;
      },
      submit: async (input) => {
        this.onSubmitBoundary?.();
        this.calls.push(`submit:${input.applicationOperationId}`);
        this.submitted.push(input);
        const behavior = this.submitBehaviors.shift() ?? {
          accepted: true as const,
          reconciliationToken: input.reconciliationToken,
          completionCorrelation: input.applicationOperationId,
        };
        if (behavior instanceof Error) throw behavior;
        return await behavior;
      },
      steerTarget: async (options) => {
        this.onSteerTargetBoundary?.();
        const behavior = this.steerTargetBehaviors.shift();
        if (behavior instanceof Error) throw behavior;
        if (behavior !== undefined) return behavior;
        if (this.steerAvailable && this.steerTargetKind === "conversation" && (!this.authoritativelySettled || options?.allowSettledConversation)) return { kind: "conversation" };
        return this.steerAvailable && this.activeTurnId
          ? { kind: "turn", turnId: this.activeTurnId }
          : null;
      },
      steer: async (input) => {
        this.calls.push(`steer:${input.applicationOperationId}`);
        this.steered.push(input);
        const behavior = this.steerBehaviors.shift() ?? {
          status: "accepted" as const,
          reconciliationToken: input.reconciliationToken,
          completionCorrelation: input.applicationOperationId,
          backendTurnId: (input.target.kind === "turn" ? input.target.turnId : "conversation-receiving-turn"),
        };
        if (behavior instanceof Error) throw behavior;
        return await behavior;
      },
      replayAuthoritativeCompletions: async () => undefined,
    });
  }

  async reconcileSubmission(
    _scope: RequestScope,
    _applicationThreadId: string,
    input: {
      readonly applicationOperationId: string;
      readonly reconciliationToken?: string;
      readonly retryAnchor?: string;
    },
  ): Promise<SubmissionReconciliation> {
    this.reconciled.push(input);
    this.calls.push(
      `reconcile:${input.applicationOperationId}:${
        input.reconciliationToken ?? "no-token"
      }`,
    );
    const behavior = this.reconciliationBehaviors.shift() ?? {
      status: "unresolved" as const,
      diagnostic: { text: "unresolved" },
    };
    if (behavior instanceof Error) throw behavior;
    this.onReconciliation?.(behavior);
    return behavior;
  }
}

type Scheduled = {
  readonly delay: number;
  readonly callback: () => void;
  cancelled: boolean;
};

class ManualScheduler implements QueueDispatchScheduler {
  readonly scheduled: Scheduled[] = [];

  schedule(delayMilliseconds: number, callback: () => void): Scheduled {
    const task = { delay: delayMilliseconds, callback, cancelled: false };
    this.scheduled.push(task);
    return task;
  }

  cancel(handle: unknown): void {
    (handle as Scheduled).cancelled = true;
  }

  runLatest(): void {
    const task = [...this.scheduled]
      .reverse()
      .find(({ cancelled }) => !cancelled);
    if (!task) throw new Error("No scheduled queue retry.");
    task.cancelled = true;
    task.callback();
  }
}

function createDispatcher(
  repository: QueuedInputRepository,
  gateway: FakeGateway,
  input: {
    readonly now: { value: number };
    readonly scheduler?: ManualScheduler;
    readonly isDispatchBlocked?: (
      scope: RequestScope,
      threadId: string,
    ) => boolean;
  },
): {
  readonly dispatcher: QueuedInputDispatcher;
  readonly events: Array<{
    readonly scope: RequestScope;
    readonly threadId: string;
    readonly event: Parameters<QueueEventPublisher["publish"]>[2];
  }>;
} {
  const events: Array<{
    readonly scope: RequestScope;
    readonly threadId: string;
    readonly event: Parameters<QueueEventPublisher["publish"]>[2];
  }> = [];
  const operations = new ConversationOperationRepository(repository.database);
  return {
    dispatcher: new QueuedInputDispatcher({
      repository,
      gateway,
      publisher: {
        publish(scope, threadId, event) {
          normalizedThreadEventSchema.parse(event);
          events.push({ scope, threadId, event });
        },
      },
      retryPolicy: {
        maximumRetries: 1,
        baseDelayMilliseconds: 100,
        maximumDelayMilliseconds: 1_000,
      },
      isDispatchBlocked:
        input.isDispatchBlocked ??
        ((scope, threadId) =>
          operations.hasBlockingThreadOperation(scope, threadId)),
      clock: { now: () => input.now.value },
      ...(input.scheduler ? { scheduler: input.scheduler } : {}),
    }),
    events,
  };
}

function readyCallback(
  fixture: Fixture,
  input: {
    readonly callerThreadId: string;
    readonly targetThreadId: string;
    readonly operationId: string;
    readonly callbackId: string;
    readonly outcome?: "completed" | "interrupted" | "failed";
    readonly resultText?: string;
  },
): ThreadCompletionCallbackRepository {
  const callbacks = new ThreadCompletionCallbackRepository(fixture.database);
  const completion = new SubmissionCompletionRepository(fixture.database);
  callbacks.register(fixture.scope, {
    id: input.callbackId,
    callerThreadId: input.callerThreadId,
    targetThreadId: input.targetThreadId,
    targetOperationId: input.operationId,
    registeredAt: 600,
  });
  completion.recordAccepted(fixture.scope, input.targetThreadId, {
    operationId: input.operationId,
    acceptedAt: 610,
    backendCorrelation: input.operationId,
  });
  completion.observeBackendCompletion(fixture.scope, input.targetThreadId, {
    backendCorrelation: input.operationId,
    applicationTurnId: `turn-${input.operationId}`,
    completionIdentity: `completion-${input.operationId}`,
    outcome: input.outcome ?? "completed",
    result: { text: input.resultText ?? "Callback result" },
            classifiedResult: null,
    observedAt: 620,
  });
  return callbacks;
}

describe("ConversationOperationRepository interrupt rejection", () => {
  it.each(["prepared", "uncertain"] as const)(
    "deletes a proven-not-applied %s interrupt receipt",
    (state) => {
      const fixture = createFixture();
      try {
        const [threadId] = fixture.threadIds;
        const operations = new ConversationOperationRepository(
          fixture.database,
        );
        operations.prepareInterrupt(fixture.scope, threadId, {
          operationId: `rejected-${state}-stop`,
          expectedActiveTurnId: "turn-original",
          now: 500,
        });
        if (state === "uncertain") {
          operations.markInterruptStarted(
            fixture.scope,
            `rejected-${state}-stop`,
          );
        }

        operations.rejectInterruptProvenNotApplied(
          fixture.scope,
          `rejected-${state}-stop`,
        );

        expect(
          operations.findInterrupt(fixture.scope, `rejected-${state}-stop`),
        ).toBeUndefined();
        expect(
          operations.findUncertainThreadOperation(fixture.scope, threadId),
        ).toBeUndefined();
      } finally {
        fixture.database.close();
      }
    },
  );

  it("refuses to reject an accepted interrupt receipt", () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const operations = new ConversationOperationRepository(fixture.database);
      operations.prepareInterrupt(fixture.scope, threadId, {
        operationId: "accepted-stop",
        expectedActiveTurnId: "turn-original",
        now: 500,
      });
      operations.acceptInterrupt(fixture.scope, "accepted-stop");

      expect(() =>
        operations.rejectInterruptProvenNotApplied(
          fixture.scope,
          "accepted-stop",
        ),
      ).toThrow(/accepted interrupt cannot be rejected/i);
      expect(
        operations.getInterrupt(fixture.scope, "accepted-stop"),
      ).toMatchObject({ state: "accepted" });
    } finally {
      fixture.database.close();
    }
  });

  it("cannot reject another principal's interrupt receipt", () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const operations = new ConversationOperationRepository(fixture.database);
      operations.prepareInterrupt(fixture.scope, threadId, {
        operationId: "principal-scoped-stop",
        expectedActiveTurnId: "turn-original",
        now: 500,
      });

      expect(() =>
        operations.rejectInterruptProvenNotApplied(
          {
            tenantId: fixture.scope.tenantId,
            principalId: "another-principal",
          },
          "principal-scoped-stop",
        ),
      ).toThrow(/interrupt operation was not found/i);
      expect(
        operations.getInterrupt(fixture.scope, "principal-scoped-stop"),
      ).toMatchObject({ state: "prepared" });
    } finally {
      fixture.database.close();
    }
  });
});

describe("ThreadCompletionCallbackDispatcher", () => {
  it("blocks snoozing a caller while its callback obligation is registered", () => {
    const fixture = createFixture();
    try {
      const [callerThreadId, targetThreadId] = fixture.threadIds;
      const callbacks = new ThreadCompletionCallbackRepository(
        fixture.database,
      );
      callbacks.register(fixture.scope, {
        callerThreadId,
        targetThreadId,
        targetOperationId: "pending-callback-operation",
        registeredAt: 600,
      });
      const inventory = new InventoryRepository(fixture.database);
      const state = inventory.getInventory(fixture.scope, callerThreadId);

      expect(() =>
        inventory.transitionInventory(fixture.scope, callerThreadId, {
          expectedRevision: state.inventoryRevision,
          mutationId: "snooze-awaiting-callback",
          change: { action: "snooze", snoozedUntil: 10_000 },
          now: 700,
        }),
      ).toThrow(/awaiting an agent result cannot be snoozed/i);
    } finally {
      fixture.database.close();
    }
  });

  it("durably queues a ready callback while its bound caller is unavailable", async () => {
    const fixture = createFixture();
    try {
      const [callerThreadId, targetThreadId] = fixture.threadIds;
      fixture.database
        .prepare(
          `UPDATE application_threads SET availability = 'missing'
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(fixture.scope.tenantId, fixture.scope.principalId, callerThreadId);
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      const now = { value: 700 };
      const { dispatcher: queue } = createDispatcher(repository, gateway, {
        now,
      });
      await queue.recover(fixture.scope);
      const callbackId = "369690fd-72a2-48b0-b599-8a486d9ecb0b";
      const callbacks = readyCallback(fixture, {
        callerThreadId,
        targetThreadId,
        operationId: "callback-operation-unavailable",
        callbackId,
      });
      const dispatcher = new ThreadCompletionCallbackDispatcher({
        callbacks,
        inventory: new InventoryRepository(fixture.database),
        repository,
        gateway,
        queue,
        now: () => now.value,
      });

      gateway.withConversationFailures.push(
        new Error("caller unavailable"),
        new Error("caller unavailable"),
      );
      await dispatcher.deliverReady(fixture.scope);

      expect(
        repository.get(fixture.scope, callerThreadId, callbackId),
      ).toMatchObject({
        completionCallbackId: callbackId,
        state: "pending",
        resolvedDeliveryMode: "queue",
      });
      expect(gateway.calls).toEqual([]);
      await dispatcher.close();
      await queue.close();
    } finally {
      fixture.database.close();
    }
  });

  it("materializes duplicate delivery attempts exactly once and Steers the current turn", async () => {
    const fixture = createFixture();
    try {
      const [callerThreadId, targetThreadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      const now = { value: 700 };
      const { dispatcher: queue } = createDispatcher(repository, gateway, {
        now,
      });
      await queue.recover(fixture.scope);
      const callbackId = "1ea98d3e-50d2-4c51-91fd-b15c0b3d42ca";
      const callbacks = readyCallback(fixture, {
        callerThreadId,
        targetThreadId,
        operationId: "callback-operation-one",
        callbackId,
      });
      const dispatcher = new ThreadCompletionCallbackDispatcher({
        callbacks,
        inventory: new InventoryRepository(fixture.database),
        repository,
        gateway,
        queue,
        now: () => now.value,
      });

      await Promise.all([
        dispatcher.deliverReady(fixture.scope),
        dispatcher.deliverReady(fixture.scope),
      ]);

      const rows = repository.list(fixture.scope, callerThreadId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: callbackId,
        completionCallbackId: callbackId,
        inputOrigin: {
          kind: "agent_result",
          callbackId,
          sourceThreadId: targetThreadId,
          sourceThreadLabel: { text: "Second" },
        },
      });
      expect(gateway.steered).toHaveLength(1);
      expect(gateway.steered[0]).toMatchObject({
        inputOrigin: {
          kind: "agent_result",
          callbackId,
        },
      });
      expect(callbacks.get(fixture.scope, callbackId).state).toBe(
        "materialized",
      );
      await queue.close();
    } finally {
      fixture.database.close();
    }
  });

  it("immediately submits a new turn when the caller is authoritatively idle", async () => {
    const fixture = createFixture();
    try {
      const [callerThreadId, targetThreadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      gateway.steerAvailable = false;
      gateway.authoritativelySettled = true;
      const now = { value: 700 };
      const { dispatcher: queue } = createDispatcher(repository, gateway, {
        now,
      });
      await queue.recover(fixture.scope);
      const callbackId = "c872bd86-bba7-4cda-b9de-c445d5c27437";
      const callbacks = readyCallback(fixture, {
        callerThreadId,
        targetThreadId,
        operationId: "callback-operation-idle",
        callbackId,
        outcome: "failed",
        resultText: "",
      });
      const dispatcher = new ThreadCompletionCallbackDispatcher({
        callbacks,
        inventory: new InventoryRepository(fixture.database),
        repository,
        gateway,
        queue,
        now: () => now.value,
      });

      await dispatcher.deliverReady(fixture.scope);

      expect(gateway.submitted).toHaveLength(1);
      expect(gateway.submitted[0]).toMatchObject({
        applicationOperationId: callbackId,
        text: "Agent result from Second (failed):\n\nNo assistant text was produced.",
        inputOrigin: {
          kind: "agent_result",
          callbackId,
          sourceThreadId: targetThreadId,
          sourceThreadLabel: { text: "Second" },
        },
      });
      expect(
        repository.get(fixture.scope, callerThreadId, callbackId).state,
      ).toBe("accepted");
      expect(callbacks.get(fixture.scope, callbackId).state).toBe(
        "materialized",
      );
      await dispatcher.close();
      await queue.close();
    } finally {
      fixture.database.close();
    }
  });

  it("appends behind an existing user queue head instead of bypassing it with Steer", async () => {
    const fixture = createFixture();
    try {
      const [callerThreadId, targetThreadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      enqueueUser(fixture, repository, callerThreadId, "existing-user", 650);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      const now = { value: 700 };
      const { dispatcher: queue } = createDispatcher(repository, gateway, {
        now,
      });
      await queue.recover(fixture.scope);
      const callbackId = "351f3800-0145-44c4-984c-f2379169700a";
      const callbacks = readyCallback(fixture, {
        callerThreadId,
        targetThreadId,
        operationId: "callback-operation-two",
        callbackId,
      });
      const dispatcher = new ThreadCompletionCallbackDispatcher({
        callbacks,
        inventory: new InventoryRepository(fixture.database),
        repository,
        gateway,
        queue,
        now: () => now.value,
      });

      await dispatcher.deliverReady(fixture.scope);

      expect(
        repository
          .list(fixture.scope, callerThreadId)
          .map(({ id, resolvedDeliveryMode }) => ({
            id,
            resolvedDeliveryMode,
          })),
      ).toEqual([
        { id: "existing-user", resolvedDeliveryMode: "queue" },
        { id: callbackId, resolvedDeliveryMode: "queue" },
      ]);
      expect(gateway.steered).toHaveLength(0);
      await queue.close();
    } finally {
      fixture.database.close();
    }
  });

  it("retries a Steer plan invalidated by a concurrent queue insert and continues later callbacks", async () => {
    const fixture = createFixture();
    try {
      const [firstThreadId, secondThreadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      const now = { value: 700 };
      const { dispatcher: queue } = createDispatcher(repository, gateway, {
        now,
      });
      await queue.recover(fixture.scope);
      const firstCallbackId = "110f7240-5170-469a-99fe-c33af3c68b76";
      const secondCallbackId = "fb6f9068-f963-416b-881a-74164eb10c79";
      const callbacks = readyCallback(fixture, {
        callerThreadId: firstThreadId,
        targetThreadId: secondThreadId,
        operationId: "callback-operation-raced-steer",
        callbackId: firstCallbackId,
      });
      readyCallback(fixture, {
        callerThreadId: secondThreadId,
        targetThreadId: firstThreadId,
        operationId: "callback-operation-later-caller",
        callbackId: secondCallbackId,
      });
      gateway.onSteerTargetBoundary = () => {
        gateway.onSteerTargetBoundary = undefined;
        enqueueUser(fixture, repository, firstThreadId, "concurrent-user", 680);
      };
      const retryScheduler = new ManualScheduler();
      const dispatcher = new ThreadCompletionCallbackDispatcher({
        callbacks,
        inventory: new InventoryRepository(fixture.database),
        repository,
        gateway,
        queue,
        now: () => now.value,
        retryScheduler,
        retryDelayMilliseconds: 100,
      });

      await dispatcher.deliverReady(fixture.scope);

      expect(callbacks.get(fixture.scope, firstCallbackId).state).toBe(
        "registered",
      );
      await vi.waitFor(() =>
        expect(callbacks.get(fixture.scope, secondCallbackId).state).toBe(
          "materialized",
        ),
      );
      expect(retryScheduler.scheduled).toHaveLength(1);

      retryScheduler.runLatest();
      await vi.waitFor(() =>
        expect(callbacks.get(fixture.scope, firstCallbackId).state).toBe(
          "materialized",
        ),
      );
      expect(
        repository
          .list(fixture.scope, firstThreadId)
          .map(({ id, state }) => ({ id, state })),
      ).toEqual([
        { id: "concurrent-user", state: "accepted" },
        { id: firstCallbackId, state: "pending" },
      ]);

      gateway.steerAvailable = false;
      gateway.authoritativelySettled = true;
      await queue.onAuthoritativeSettled(fixture.scope, firstThreadId);
      expect(
        gateway.submitted.map(
          ({ applicationOperationId }) => applicationOperationId,
        ),
      ).toEqual(["operation-concurrent-user", firstCallbackId]);
      expect(
        repository.get(fixture.scope, firstThreadId, firstCallbackId).state,
      ).toBe("accepted");

      await dispatcher.close();
      await queue.close();
    } finally {
      fixture.database.close();
    }
  });
});

describe("QueuedInputDispatcher", () => {
  it("starts with pending input on an unavailable backend and retries without losing it", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const [threadId] = fixture.threadIds;
    enqueue(fixture, repository, threadId, "offline-startup", 800);
    const gateway = new FakeGateway();
    gateway.withConversationFailures.push(new Error("backend unavailable"));
    const scheduler = new ManualScheduler();
    const { dispatcher } = createDispatcher(repository, gateway, {
      now: { value: 810 }, scheduler,
    });
    try {
      await expect(dispatcher.recover(fixture.scope)).resolves.toBeUndefined();
      expect(repository.get(fixture.scope, threadId, "offline-startup").state).toBe("pending");
      expect(gateway.submitted).toEqual([]);
      expect(scheduler.scheduled.at(-1)?.delay).toBe(100);
      scheduler.runLatest();
      await vi.waitFor(() => expect(repository.get(fixture.scope, threadId, "offline-startup").state).toBe("accepted"));
      expect(gateway.submitted).toHaveLength(1);
    } finally {
      await dispatcher.close();
      fixture.database.close();
    }
  });

  it("admits question responses independently of the composer and submits once after settling", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const [threadId] = fixture.threadIds;
    const gateway = new FakeGateway();
    gateway.authoritativelySettled = false;
    const { dispatcher, events } = createDispatcher(repository, gateway, {
      now: { value: 700 },
      scheduler: new ManualScheduler(),
    });
    try {
      await dispatcher.recover(fixture.scope);
      const drafts = new ConversationDraftRepository(fixture.database);
      const draft = drafts.save(fixture.scope, threadId, {
        text: "Keep my unfinished message",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: drafts.get(fixture.scope, threadId).revision,
        now: 500,
      });
      const input = {
        mutationId: "question:request-1",
        text: "Use the blue option.",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "question_response" as const,
          resolvedDeliveryMode: "queue" as const,
          inputOrigin: {
            kind: "question_response" as const,
            requestId: "request-1",
            sourceItemId: "question-item-1",
            answers: [
              { questionIndex: 0, question: "Which color?", answer: "Blue" },
            ],
          },
          expectedThreadRevision: revision(fixture, threadId),
        },
        now: 600,
      };
      const admitted = repository.enqueue(fixture.scope, threadId, input);
      expect(admitted.item).toMatchObject({
        triggerKind: "user",
        resolvedDeliveryMode: "queue",
        inputOrigin: input.source.inputOrigin,
        initiatingAgentThreadId: null,
        initiatingToolClientId: null,
        sourceAutomationId: null,
        state: "pending",
      });
      expect(repository.enqueue(fixture.scope, threadId, input)).toMatchObject({
        replayed: true,
        item: { id: admitted.item.id },
      });
      expect(() =>
        repository.enqueue(fixture.scope, threadId, {
          ...input,
          text: "A different response",
        }),
      ).toThrow("reused with different input");
      expect(() =>
        repository.enqueue(fixture.scope, threadId, {
          ...input,
          source: {
            ...input.source,
            inputOrigin: {
              ...input.source.inputOrigin,
              sourceItemId: "different-source",
            },
          },
        }),
      ).toThrow("reused with different input");
      expect(
        new QueuedInputRepository(fixture.database).get(
          fixture.scope,
          threadId,
          admitted.item.id,
        ).inputOrigin,
      ).toEqual(input.source.inputOrigin);
      expect(
        projectQueuedInputSummaries(
          repository.list(fixture.scope, threadId),
        )[0],
      ).toMatchObject({
        origin: "user",
        inputOrigin: input.source.inputOrigin,
      });
      expect(() =>
        repository.enqueue(
          { ...fixture.scope, principalId: "other" },
          threadId,
          input,
        ),
      ).toThrow("thread was not found");
      await dispatcher.dispatchAdmitted(fixture.scope, threadId);
      expect(events.some(({ event }) => event.type === "queue_changed")).toBe(
        true,
      );
      expect(gateway.submitted).toHaveLength(0);
      expect(drafts.get(fixture.scope, threadId)).toEqual(draft);

      gateway.authoritativelySettled = true;
      await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);
      await dispatcher.dispatchAdmitted(fixture.scope, threadId);
      expect(gateway.submitted).toHaveLength(1);
      expect(gateway.submitted[0]?.inputOrigin).toEqual(
        input.source.inputOrigin,
      );
      expect(
        repository.get(fixture.scope, threadId, admitted.item.id).state,
      ).toBe("accepted");
      expect(drafts.get(fixture.scope, threadId)).toEqual(draft);
    } finally {
      await dispatcher.close();
      fixture.database.close();
    }
  });

  it("preserves question provenance through failed delivery and explicit retry", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const [threadId] = fixture.threadIds;
    const gateway = new FakeGateway();
    const now = { value: 600 };
    const { dispatcher } = createDispatcher(repository, gateway, { now });
    const inputOrigin = {
      kind: "question_response" as const,
      requestId: "retry-question",
      sourceItemId: "question-source",
      answers: [{ questionIndex: 0, question: "Proceed?", answer: "Yes" }],
    };
    try {
      repository.enqueue(fixture.scope, threadId, {
        id: "failed-question",
        mutationId: "failed-question-operation",
        text: "User responded to a question: Question: Proceed? Answer: Yes",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "question_response",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: revision(fixture, threadId),
          inputOrigin,
        },
        now: 500,
      });
      gateway.submitBehaviors.push(
        new BackendError({
          category: "rejected",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "Request rejected.",
        }),
      );
      await dispatcher.recover(fixture.scope);
      expect(
        repository.get(fixture.scope, threadId, "failed-question").state,
      ).toBe("failed");
      now.value = 620;
      await dispatcher.retryFailed(fixture.scope, threadId, "failed-question", {
        id: "retried-question",
        mutationId: "retried-question-operation",
        now: 620,
      });
      expect(gateway.submitted).toHaveLength(2);
      expect(gateway.submitted.map((input) => input.inputOrigin)).toEqual([
        inputOrigin,
        inputOrigin,
      ]);
      expect(
        new QueuedInputRepository(fixture.database).get(
          fixture.scope,
          threadId,
          "retried-question",
        ),
      ).toMatchObject({
        inputOrigin,
        retryOfId: "failed-question",
        state: "accepted",
      });
    } finally {
      await dispatcher.close();
      fixture.database.close();
    }
  });

  it("keeps a conversation Steer admitted without a turn until exact materialization, then recovers without resend", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const operations = new ConversationOperationRepository(fixture.database);
    const drafts = new ConversationDraftRepository(fixture.database);
    const gateway = new FakeGateway();
    gateway.authoritativelySettled = false;
    gateway.steerTargetKind = "conversation";
    const { dispatcher } = createDispatcher(repository, gateway, { now: { value: 900 } });
    const [threadId] = fixture.threadIds;
    try {
      await dispatcher.recover(fixture.scope);
      const draft = drafts.save(fixture.scope, threadId, {
        text: "Use the new requirement", contextExcerpts: [], attachmentIds: [], taskReferenceIds: [],
        expectedRevision: drafts.get(fixture.scope, threadId).revision, now: 810,
      });
      gateway.steerBehaviors.push({ status: "pending_materialization",
        reconciliationToken: "conversation-steer-op", completionCorrelation: "conversation-steer-op" });
      // The turn ends between durable admission and dispatch. Conversation delivery remains valid.
      gateway.activeTurnId = null;
      gateway.authoritativelySettled = true;
      await dispatcher.enqueue(fixture.scope, threadId, {
        id: "conversation-steer", mutationId: "conversation-steer-op", text: draft.text,
        contextExcerpts: [], attachmentIds: [], taskReferences: [],
        source: { kind: "composer", requestedDeliveryMode: "steer", resolvedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "conversation" }, resolvedSteerTarget: { kind: "conversation" },
          expectedThreadRevision: revision(fixture, threadId), expectedDraftRevision: draft.revision }, now: 811,
      });
      await vi.waitFor(() => expect(operations.getSteer(fixture.scope, "conversation-steer-op")).toMatchObject({
        state: "pending_materialization", target: { kind: "conversation" },
      }));
      expect(gateway.steered).toHaveLength(1);
      expect(gateway.steered[0]?.target).toEqual({ kind: "conversation" });
      expect(repository.get(fixture.scope, threadId, "conversation-steer").state).toBe("dispatching");
      await dispatcher.close();
      const replacementGateway = new FakeGateway();
      replacementGateway.reconciliationBehaviors.push({ status: "accepted", backendTurn: { backendTurnId: "actual-receiving-turn", status: "in_progress", completionCorrelations: ["conversation-steer-op"], orderedBackendItemIds: [] } });
      const replacement = createDispatcher(repository, replacementGateway, { now: { value: 950 } }).dispatcher;
      try {
        await replacement.recover(fixture.scope);
        expect(repository.get(fixture.scope, threadId, "conversation-steer").state).toBe("accepted");
        expect(replacementGateway.steered).toEqual([]);
        expect(replacementGateway.submitted).toEqual([]);
        expect(operations.getSteer(fixture.scope, "conversation-steer-op").target).toEqual({ kind: "conversation" });
      } finally { await replacement.close(); }
    } finally { await dispatcher.close(); fixture.database.close(); }
  });

  it.each(["admission", "submission"] as const)(
    "falls back to ordinary queue when conversation steering becomes unavailable at %s",
    async (boundary) => {
      const fixture = createFixture();
      const repository = new QueuedInputRepository(fixture.database);
      const operations = new ConversationOperationRepository(fixture.database);
      const drafts = new ConversationDraftRepository(fixture.database);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      gateway.steerTargetKind = "conversation";
      gateway.steerAvailable = false;
      if (boundary === "submission") gateway.steerTargetBehaviors.push({ kind: "conversation" });
      const { dispatcher } = createDispatcher(repository, gateway, { now: { value: 900 } });
      const [threadId] = fixture.threadIds;
      try {
        await dispatcher.recover(fixture.scope);
        const draft = drafts.save(fixture.scope, threadId, {
          text: "Keep this input when Steer is unavailable", contextExcerpts: [], attachmentIds: [], taskReferenceIds: [],
          expectedRevision: drafts.get(fixture.scope, threadId).revision, now: 810,
        });
        await dispatcher.enqueue(fixture.scope, threadId, {
          id: "unavailable-conversation-steer", mutationId: "unavailable-conversation-steer-op", text: draft.text,
          contextExcerpts: [], attachmentIds: [], taskReferences: [],
          source: { kind: "composer", requestedDeliveryMode: "steer", resolvedDeliveryMode: "steer",
            requestedSteerTarget: { kind: "conversation" }, resolvedSteerTarget: { kind: "conversation" },
            expectedThreadRevision: revision(fixture, threadId), expectedDraftRevision: draft.revision }, now: 811,
        });
        await vi.waitFor(() => expect(repository.get(fixture.scope, threadId, "unavailable-conversation-steer")).toMatchObject({
          state: "pending", resolvedDeliveryMode: "queue", diagnostic: null, steerFallbackAt: 900,
        }));
        expect(operations.findSteer(fixture.scope, "unavailable-conversation-steer-op")).toBeUndefined();
        expect(gateway.steered).toEqual([]);
        expect(gateway.submitted).toEqual([]);
        gateway.authoritativelySettled = true;
        await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);
        expect(repository.get(fixture.scope, threadId, "unavailable-conversation-steer").state).toBe("accepted");
        expect(gateway.submitted).toHaveLength(1);
      } finally { await dispatcher.close(); fixture.database.close(); }
    },
  );

  it("steers an ordinary queued input with a conversation target without requiring a turn ID", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const gateway = new FakeGateway();
    gateway.authoritativelySettled = false;
    gateway.steerTargetKind = "conversation";
    gateway.activeTurnId = null;
    const { dispatcher } = createDispatcher(repository, gateway, { now: { value: 900 } });
    const [threadId] = fixture.threadIds;
    try {
      enqueueUser(fixture, repository, threadId, "conversation-queue", 810);
      await dispatcher.recover(fixture.scope);
      await expect(dispatcher.steerUserInput(fixture.scope, threadId, "conversation-queue", {
        mutationId: "conversation-queue-steer", expectedThreadRevision: revision(fixture, threadId),
      })).resolves.toMatchObject({ status: "accepted" });
      expect(gateway.steered[0]?.target).toEqual({ kind: "conversation" });
      expect(repository.get(fixture.scope, threadId, "conversation-queue").state).toBe("accepted");
    } finally { await dispatcher.close(); fixture.database.close(); }
  });

  it("admits multiple target-bound Steers immediately and delivers them sequentially", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const drafts = new ConversationDraftRepository(fixture.database);
    const gateway = new FakeGateway();
    gateway.authoritativelySettled = false;
    const now = { value: 800 };
    const { dispatcher } = createDispatcher(repository, gateway, { now });
    const [threadId] = fixture.threadIds;
    let acceptFirst!: (result: SteerTurnResult) => void;
    const firstAcceptance = new Promise<SteerTurnResult>((resolve) => {
      acceptFirst = resolve;
    });
    gateway.steerBehaviors.push(firstAcceptance);

    try {
      await dispatcher.recover(fixture.scope);
      const enqueueSteer = async (id: string, text: string, at: number) => {
        const current = drafts.get(fixture.scope, threadId);
        const draft = drafts.save(fixture.scope, threadId, {
          text,
          contextExcerpts: [],
          attachmentIds: [],
          taskReferenceIds: [],
          expectedRevision: current.revision,
          now: at,
        });
        return dispatcher.enqueue(fixture.scope, threadId, {
          id,
          mutationId: `operation-${id}`,
          text,
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "composer",
            requestedDeliveryMode: "steer",
            resolvedDeliveryMode: "steer",
            requestedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
            resolvedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
            expectedThreadRevision: revision(fixture, threadId),
            expectedDraftRevision: draft.revision,
          },
          now: at + 1,
        });
      };

      await expect(
        enqueueSteer("steer-1", "First steer", 810),
      ).resolves.toMatchObject({
        item: { state: "pending", requestedDeliveryMode: "steer" },
      });
      await vi.waitFor(() => expect(gateway.steered).toHaveLength(1));
      await expect(
        enqueueSteer("steer-2", "Second steer", 820),
      ).resolves.toMatchObject({
        item: { state: "pending", requestedDeliveryMode: "steer" },
      });
      expect(repository.list(fixture.scope, threadId)).toMatchObject([
        { id: "steer-1", state: "dispatching", deliveryMode: "steer" },
        {
          id: "steer-2",
          state: "pending",
          requestedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
          resolvedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
        },
      ]);
      expect(gateway.steered).toHaveLength(1);

      acceptFirst({
        status: "accepted",
        reconciliationToken: "operation-steer-1",
        completionCorrelation: "operation-steer-1",
        backendTurnId: "active-turn-1",
      });
      await vi.waitFor(() => expect(gateway.steered).toHaveLength(2));
      await vi.waitFor(() =>
        expect(repository.list(fixture.scope, threadId)).toMatchObject([
          { id: "steer-1", state: "accepted" },
          { id: "steer-2", state: "accepted" },
        ]),
      );
      expect(
        gateway.steered.map(
          ({ applicationOperationId }) => applicationOperationId,
        ),
      ).toEqual(["operation-steer-1", "operation-steer-2"]);
      expect(
        gateway.steered.every(
          ({ target }) =>
            target.kind === "turn" && target.turnId === "active-turn-1",
        ),
      ).toBe(true);
      expect(gateway.submitted).toEqual([]);
    } finally {
      await dispatcher.close();
      fixture.database.close();
    }
  });

  it("resumes a durable target-bound Steer after restart without submitting it as a new turn", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const drafts = new ConversationDraftRepository(fixture.database);
    const [threadId] = fixture.threadIds;
    const currentDraft = drafts.get(fixture.scope, threadId);
    const draft = drafts.save(fixture.scope, threadId, {
      text: "Resume this Steer after restart",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferenceIds: [],
      expectedRevision: currentDraft.revision,
      now: 790,
    });
    const requestedThreadRevision = revision(fixture, threadId);
    repository.enqueue(fixture.scope, threadId, {
      id: "restart-steer",
      mutationId: "operation-restart-steer",
      text: draft.text,
      contextExcerpts: draft.contextExcerpts,
      attachmentIds: draft.attachments.map(({ id }) => id),
      taskReferences: draft.taskReferences,
      source: {
        kind: "composer",
        requestedDeliveryMode: "steer",
        resolvedDeliveryMode: "steer",
        requestedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
        resolvedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
        expectedThreadRevision: requestedThreadRevision,
        expectedDraftRevision: draft.revision,
      },
      now: 800,
    });
    const gateway = new FakeGateway();
    const { dispatcher } = createDispatcher(repository, gateway, {
      now: { value: 810 },
    });

    try {
      await dispatcher.recover(fixture.scope);
      await vi.waitFor(() =>
        expect(
          repository.get(fixture.scope, threadId, "restart-steer").state,
        ).toBe("accepted"),
      );
      expect(gateway.steered).toMatchObject([
        {
          applicationOperationId: "operation-restart-steer",
          target: { kind: "turn", turnId: "active-turn-1" },
        },
      ]);
      expect(gateway.submitted).toEqual([]);
    } finally {
      await dispatcher.close();
      fixture.database.close();
    }
  });

  it("retries a durable target-bound Steer after transient conversation acquisition failure", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const drafts = new ConversationDraftRepository(fixture.database);
    const [threadId] = fixture.threadIds;
    const currentDraft = drafts.get(fixture.scope, threadId);
    const draft = drafts.save(fixture.scope, threadId, {
      text: "Retry this Steer after runtime acquisition recovers",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferenceIds: [],
      expectedRevision: currentDraft.revision,
      now: 790,
    });
    repository.enqueue(fixture.scope, threadId, {
      id: "transient-acquire-steer",
      mutationId: "operation-transient-acquire-steer",
      text: draft.text,
      contextExcerpts: [],
      attachmentIds: [],
      taskReferences: [],
      source: {
        kind: "composer",
        requestedDeliveryMode: "steer",
        resolvedDeliveryMode: "steer",
        requestedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
        resolvedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
        expectedThreadRevision: revision(fixture, threadId),
        expectedDraftRevision: draft.revision,
      },
      now: 800,
    });
    const gateway = new FakeGateway();
    gateway.authoritativelySettled = false;
    gateway.withConversationFailures.push(
      new Error("temporary runtime acquisition failure"),
    );
    const scheduler = new ManualScheduler();
    const { dispatcher } = createDispatcher(repository, gateway, {
      now: { value: 810 },
      scheduler,
    });

    try {
      await dispatcher.recover(fixture.scope);
      await vi.waitFor(() =>
        expect(scheduler.scheduled.at(-1)?.delay).toBe(100),
      );
      expect(
        repository.get(fixture.scope, threadId, "transient-acquire-steer"),
      ).toMatchObject({
        state: "pending",
        requestedDeliveryMode: "steer",
        resolvedDeliveryMode: "steer",
        steerFallbackAt: null,
        diagnostic: null,
      });
      expect(gateway.steered).toEqual([]);
      expect(gateway.submitted).toEqual([]);

      scheduler.runLatest();
      await vi.waitFor(() =>
        expect(
          repository.get(fixture.scope, threadId, "transient-acquire-steer"),
        ).toMatchObject({ state: "accepted" }),
      );
      expect(gateway.steered).toMatchObject([
        {
          applicationOperationId: "operation-transient-acquire-steer",
          target: { kind: "turn", turnId: "active-turn-1" },
        },
      ]);
      expect(gateway.submitted).toEqual([]);
    } finally {
      await dispatcher.close();
      fixture.database.close();
    }
  });

  it("defers a recovered requested Steer when dispatch becomes blocked before reservation", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const drafts = new ConversationDraftRepository(fixture.database);
    const [threadId] = fixture.threadIds;
    const currentDraft = drafts.get(fixture.scope, threadId);
    const draft = drafts.save(fixture.scope, threadId, {
      text: "Wait for the uncertain operation",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferenceIds: [],
      expectedRevision: currentDraft.revision,
      now: 790,
    });
    repository.enqueue(fixture.scope, threadId, {
      id: "blocked-recovery-steer",
      mutationId: "operation-blocked-recovery-steer",
      text: draft.text,
      contextExcerpts: [],
      attachmentIds: [],
      taskReferences: [],
      source: {
        kind: "composer",
        requestedDeliveryMode: "steer",
        resolvedDeliveryMode: "steer",
        requestedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
        resolvedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
        expectedThreadRevision: revision(fixture, threadId),
        expectedDraftRevision: draft.revision,
      },
      now: 800,
    });
    const gateway = new FakeGateway();
    gateway.authoritativelySettled = false;
    const scheduler = new ManualScheduler();
    let blockingChecks = 0;
    const { dispatcher } = createDispatcher(repository, gateway, {
      now: { value: 810 },
      scheduler,
      // Recovery first checks ordinary dispatch and then the requested-Steer
      // scheduler. Simulate an uncertainty appearing after those checks but
      // before steerUserInput enters its serialized reservation boundary.
      isDispatchBlocked: () => ++blockingChecks === 3,
    });

    try {
      await dispatcher.recover(fixture.scope);
      await vi.waitFor(() =>
        expect(scheduler.scheduled.at(-1)?.delay).toBe(100),
      );
      expect(
        repository.get(fixture.scope, threadId, "blocked-recovery-steer"),
      ).toMatchObject({
        state: "pending",
        requestedDeliveryMode: "steer",
        resolvedDeliveryMode: "steer",
        steerFallbackAt: null,
        diagnostic: null,
      });
      expect(gateway.steered).toEqual([]);
      expect(gateway.submitted).toEqual([]);

      scheduler.runLatest();
      await vi.waitFor(() =>
        expect(
          repository.get(fixture.scope, threadId, "blocked-recovery-steer"),
        ).toMatchObject({ state: "accepted" }),
      );
      expect(gateway.steered).toMatchObject([
        {
          applicationOperationId: "operation-blocked-recovery-steer",
          target: { kind: "turn", turnId: "active-turn-1" },
        },
      ]);
      expect(gateway.submitted).toEqual([]);
    } finally {
      await dispatcher.close();
      fixture.database.close();
    }
  });

  it("reads server-owned Steer revision after entering the delivery mailbox", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const drafts = new ConversationDraftRepository(fixture.database);
    const [threadId] = fixture.threadIds;
    const currentDraft = drafts.get(fixture.scope, threadId);
    const draft = drafts.save(fixture.scope, threadId, {
      text: "Keep this Steer valid across an unrelated revision bump",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferenceIds: [],
      expectedRevision: currentDraft.revision,
      now: 790,
    });
    repository.enqueue(fixture.scope, threadId, {
      id: "revision-race-steer",
      mutationId: "operation-revision-race-steer",
      text: draft.text,
      contextExcerpts: draft.contextExcerpts,
      attachmentIds: draft.attachments.map(({ id }) => id),
      taskReferences: draft.taskReferences,
      source: {
        kind: "composer",
        requestedDeliveryMode: "steer",
        resolvedDeliveryMode: "steer",
        requestedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
        resolvedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
        expectedThreadRevision: revision(fixture, threadId),
        expectedDraftRevision: draft.revision,
      },
      now: 800,
    });
    const gateway = new FakeGateway();
    gateway.onSteerTargetBoundary = () => {
      gateway.onSteerTargetBoundary = undefined;
      fixture.database
        .prepare(
          `UPDATE application_threads
           SET revision = revision + 1
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(fixture.scope.tenantId, fixture.scope.principalId, threadId);
    };
    const { dispatcher } = createDispatcher(repository, gateway, {
      now: { value: 810 },
    });

    try {
      await dispatcher.recover(fixture.scope);
      await vi.waitFor(() =>
        expect(
          repository.get(fixture.scope, threadId, "revision-race-steer"),
        ).toMatchObject({ state: "accepted" }),
      );
      expect(gateway.steered).toHaveLength(1);
      expect(gateway.submitted).toEqual([]);
    } finally {
      await dispatcher.close();
      fixture.database.close();
    }
  });

  it.each([false, true])("recovers stale question Steer without spinning when fallback fails: %s", async (failFallback) => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const [threadId] = fixture.threadIds;
    const gateway = new FakeGateway();
    gateway.authoritativelySettled = false;
    gateway.activeTurnId = "later-turn";
    const scheduler = new ManualScheduler();
    const { dispatcher } = createDispatcher(repository, gateway, {
      now: { value: 810 }, scheduler,
    });
    const inputOrigin = {
      kind: "question_response" as const, requestId: "stale-question",
      sourceItemId: "question-source",
      answers: [{ questionIndex: 0, question: "Proceed?", answer: "Yes" }],
    };
    repository.enqueue(fixture.scope, threadId, {
      id: "stale-question", mutationId: "stale-question-operation", text: "Yes",
      contextExcerpts: [], attachmentIds: [], taskReferences: [],
      source: { kind: "question_response", inputOrigin,
        resolvedDeliveryMode: "steer", resolvedSteerTarget: { kind: "turn", turnId: "previous-turn" },
        expectedThreadRevision: revision(fixture, threadId) }, now: 800,
    });
    const fallback = vi.spyOn(repository, "demotePendingRequestedSteer");
    if (failFallback) fallback.mockImplementation(() => { throw new Error("durable fallback failed"); });
    try {
      await dispatcher.recover(fixture.scope);
      await vi.waitFor(() => expect(fallback).toHaveBeenCalledTimes(1));
      if (failFallback) {
        await vi.waitFor(() => expect(scheduler.scheduled.at(-1)?.delay).toBe(100));
        expect(repository.get(fixture.scope, threadId, "stale-question")).toMatchObject({
          state: "pending", resolvedDeliveryMode: "steer",
        });
        fallback.mockRestore();
        scheduler.runLatest();
      }
      await vi.waitFor(() => expect(repository.get(fixture.scope, threadId, "stale-question")).toMatchObject({
        state: "pending", resolvedDeliveryMode: "queue", resolvedSteerTarget: null,
        requestedDeliveryMode: null, steerFallbackAt: null, inputOrigin,
      }));
      expect(gateway.steered).toEqual([]);
      expect(gateway.submitted).toEqual([]);
    } finally {
      fallback.mockRestore();
      await dispatcher.close();
      fixture.database.close();
    }
  });

  it("demotes a restarted stale Steer to next-turn queue work without retargeting", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const drafts = new ConversationDraftRepository(fixture.database);
    const [threadId] = fixture.threadIds;
    const currentDraft = drafts.get(fixture.scope, threadId);
    const draft = drafts.save(fixture.scope, threadId, {
      text: "Do not retarget this stale Steer",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferenceIds: [],
      expectedRevision: currentDraft.revision,
      now: 790,
    });
    const requestedThreadRevision = revision(fixture, threadId);
    repository.enqueue(fixture.scope, threadId, {
      id: "stale-restart-steer",
      mutationId: "operation-stale-restart-steer",
      text: draft.text,
      contextExcerpts: draft.contextExcerpts,
      attachmentIds: draft.attachments.map(({ id }) => id),
      taskReferences: draft.taskReferences,
      source: {
        kind: "composer",
        requestedDeliveryMode: "steer",
        resolvedDeliveryMode: "steer",
        requestedSteerTarget: { kind: "turn", turnId: "previous-active-turn" },
        resolvedSteerTarget: { kind: "turn", turnId: "previous-active-turn" },
        expectedThreadRevision: requestedThreadRevision,
        expectedDraftRevision: draft.revision,
      },
      now: 800,
    });
    const gateway = new FakeGateway();
    gateway.authoritativelySettled = false;
    gateway.activeTurnId = "later-active-turn";
    const now = { value: 810 };
    const { dispatcher } = createDispatcher(repository, gateway, {
      now,
    });

    try {
      await dispatcher.recover(fixture.scope);
      await vi.waitFor(() =>
        expect(
          repository.get(fixture.scope, threadId, "stale-restart-steer"),
        ).toMatchObject({
          state: "pending",
          requestedDeliveryMode: "steer",
          resolvedDeliveryMode: "queue",
          requestedSteerTarget: { kind: "turn", turnId: "previous-active-turn" },
          resolvedSteerTarget: null,
          steerFallbackAt: 810,
          diagnostic: null,
        }),
      );
      expect(gateway.steered).toEqual([]);
      expect(gateway.submitted).toEqual([]);
      expect(
        projectQueuedInputSummaries(repository.list(fixture.scope, threadId)),
      ).toMatchObject([
        {
          id: "stale-restart-steer",
          requestedDeliveryMode: "steer",
          resolvedDeliveryMode: "queue",
          state: "pending",
        },
      ]);
      expect(
        dispatcher.findComposerDeliveryReplay(fixture.scope, threadId, {
          mutationId: "operation-stale-restart-steer",
          requestedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn", turnId: "previous-active-turn" },
          expectedThreadRevision: requestedThreadRevision,
          expectedDraftRevision: draft.revision,
        }),
      ).toMatchObject({ id: "stale-restart-steer", steerFallbackAt: 810 });

      gateway.authoritativelySettled = true;
      gateway.activeTurnId = null;
      now.value = 820;
      await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);
      await vi.waitFor(() =>
        expect(
          repository.get(fixture.scope, threadId, "stale-restart-steer"),
        ).toMatchObject({ state: "accepted", deliveryMode: null }),
      );
      expect(gateway.submitted).toMatchObject([
        {
          applicationOperationId: "operation-stale-restart-steer",
          text: "Do not retarget this stale Steer",
        },
      ]);
    } finally {
      await dispatcher.close();
      fixture.database.close();
    }
  });

  it("demotes an adapter-proven stale Steer but fails closed for other rejections", async () => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const drafts = new ConversationDraftRepository(fixture.database);
    const [threadId] = fixture.threadIds;
    const gateway = new FakeGateway();
    gateway.authoritativelySettled = false;
    gateway.steerBehaviors.push(
      new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "turn ended",
        steerRejectionReason: "target_no_longer_active",
      }),
    );
    const now = { value: 900 };
    const { dispatcher } = createDispatcher(repository, gateway, { now });

    try {
      const current = drafts.get(fixture.scope, threadId);
      const draft = drafts.save(fixture.scope, threadId, {
        text: "Deliver this after the active turn",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: current.revision,
        now: 890,
      });
      repository.enqueue(fixture.scope, threadId, {
        id: "remote-stale-steer",
        mutationId: "operation-remote-stale-steer",
        text: draft.text,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "steer",
          resolvedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
          resolvedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
          expectedThreadRevision: revision(fixture, threadId),
          expectedDraftRevision: draft.revision,
        },
        now: 895,
      });

      await dispatcher.recover(fixture.scope);
      await vi.waitFor(() =>
        expect(
          repository.get(fixture.scope, threadId, "remote-stale-steer"),
        ).toMatchObject({ state: "pending", steerFallbackAt: 900 }),
      );
      expect(gateway.steered).toHaveLength(1);
      expect(gateway.submitted).toEqual([]);

      gateway.authoritativelySettled = true;
      gateway.activeTurnId = null;
      now.value = 910;
      await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);
      await vi.waitFor(() =>
        expect(
          repository.get(fixture.scope, threadId, "remote-stale-steer").state,
        ).toBe("accepted"),
      );
      expect(gateway.submitted).toHaveLength(1);
    } finally {
      await dispatcher.close();
      fixture.database.close();
    }

    const genericFixture = createFixture();
    const genericRepository = new QueuedInputRepository(
      genericFixture.database,
    );
    const genericDrafts = new ConversationDraftRepository(
      genericFixture.database,
    );
    const [genericThreadId] = genericFixture.threadIds;
    const genericGateway = new FakeGateway();
    genericGateway.authoritativelySettled = false;
    genericGateway.steerBehaviors.push(
      new BackendError({
        category: "rejected",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "generic rejection",
      }),
    );
    const { dispatcher: genericDispatcher } = createDispatcher(
      genericRepository,
      genericGateway,
      { now: { value: 920 } },
    );
    try {
      const current = genericDrafts.get(genericFixture.scope, genericThreadId);
      const draft = genericDrafts.save(genericFixture.scope, genericThreadId, {
        text: "Do not silently fallback",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: current.revision,
        now: 915,
      });
      genericRepository.enqueue(genericFixture.scope, genericThreadId, {
        id: "generic-rejection-steer",
        mutationId: "operation-generic-rejection-steer",
        text: draft.text,
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "steer",
          resolvedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
          resolvedSteerTarget: { kind: "turn", turnId: "active-turn-1" },
          expectedThreadRevision: revision(genericFixture, genericThreadId),
          expectedDraftRevision: draft.revision,
        },
        now: 916,
      });
      await genericDispatcher.recover(genericFixture.scope);
      await vi.waitFor(() =>
        expect(
          genericRepository.get(
            genericFixture.scope,
            genericThreadId,
            "generic-rejection-steer",
          ),
        ).toMatchObject({
          state: "failed",
          steerFallbackAt: null,
          diagnostic: "generic rejection",
        }),
      );
      expect(genericGateway.submitted).toEqual([]);
    } finally {
      await genericDispatcher.close();
      genericFixture.database.close();
    }
  });

  it("preserves a selected skill through durable queue dispatch", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(
        fixture,
        repository,
        threadId,
        "skill",
        500,
        "opaque-review-skill",
        "",
      );
      expect(repository.get(fixture.scope, threadId, "skill")).toMatchObject({
        text: "",
        selectedSkillId: "opaque-review-skill",
      });
      const gateway = new FakeGateway();
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 600 },
      });

      await dispatcher.recover(fixture.scope);

      expect(gateway.submitted).toContainEqual(
        expect.objectContaining({
          text: "",
          selectedSkillId: "opaque-review-skill",
        }),
      );
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("preserves annotated context-only composer input through durable dispatch", async () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const excerpt = {
        id: "018f47cb-5f45-7f93-8d8d-bdb808b1f013",
        excerpt: "const answer = 42;",
        note: "Explain this value.",
        source: {
          kind: "conversation_message" as const,
          itemId: "normalized-assistant-message-2",
          itemRevision: 8,
        },
        locator: {
          kind: "text_quote" as const,
          prefix: "Before ",
          suffix: " after.",
        },
      };
      const drafts = new ConversationDraftRepository(fixture.database);
      const draft = drafts.save(fixture.scope, threadId, {
        text: "",
        contextExcerpts: [excerpt],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: 0,
        now: 500,
      });
      const repository = new QueuedInputRepository(fixture.database);
      repository.enqueue(fixture.scope, threadId, {
        id: "context-only",
        mutationId: "operation-context-only",
        text: "",
        contextExcerpts: [excerpt],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: revision(fixture, threadId),
          expectedDraftRevision: draft.revision,
        },
        now: 510,
      });
      expect(
        repository.get(fixture.scope, threadId, "context-only"),
      ).toMatchObject({
        text: "",
        contextExcerpts: [excerpt],
      });
      const gateway = new FakeGateway();
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 600 },
      });
      await dispatcher.recover(fixture.scope);
      expect(gateway.submitted).toContainEqual(
        expect.objectContaining({ text: "", contextExcerpts: [excerpt] }),
      );
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("dispatches the immutable task snapshot accepted by the queue", async () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const tasks = new TaskRepository(fixture.database);
      const task = tasks.create(fixture.scope, {
        title: "Original task title",
        details: "Original task details",
        scope: { kind: "global" },
        mutationId: "create-queued-task-context",
        now: 500,
      });
      const drafts = new ConversationDraftRepository(fixture.database);
      const draft = drafts.save(fixture.scope, threadId, {
        text: "",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [task.id],
        expectedRevision: 0,
        now: 510,
      });
      const repository = new QueuedInputRepository(fixture.database);
      repository.enqueue(fixture.scope, threadId, {
        id: "task-only",
        mutationId: "operation-task-only",
        text: "",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: draft.taskReferences,
        source: {
          kind: "composer",
          requestedDeliveryMode: "queue",
          resolvedDeliveryMode: "queue",
          expectedThreadRevision: revision(fixture, threadId),
          expectedDraftRevision: draft.revision,
        },
        now: 520,
      });
      tasks.update(fixture.scope, task.id, {
        title: "Renamed after queue acceptance",
        details: "Changed after queue acceptance",
        expectedRevision: task.revision,
        mutationId: "rename-queued-task-context",
        now: 530,
      });

      const gateway = new FakeGateway();
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 600 },
      });
      await dispatcher.recover(fixture.scope);

      expect(gateway.submitted).toContainEqual(
        expect.objectContaining({
          text: "",
          taskContexts: [
            expect.objectContaining({
              id: task.id,
              title: "Original task title",
              details: "Original task details",
              revision: task.revision,
            }),
          ],
        }),
      );
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("persists and replays an interrupt receipt across repository instances", () => {
    const fixture = createFixture();
    try {
      const [threadId, otherThreadId] = fixture.threadIds;
      const operations = new ConversationOperationRepository(fixture.database);
      expect(
        operations.prepareInterrupt(fixture.scope, threadId, {
          operationId: "durable-stop",
          expectedActiveTurnId: "turn-original",
          now: 500,
        }),
      ).toMatchObject({
        state: "prepared",
        expectedActiveTurnId: "turn-original",
      });
      operations.markInterruptStarted(fixture.scope, "durable-stop");

      const reopened = new ConversationOperationRepository(fixture.database);
      expect(
        reopened.findUncertainThreadOperation(fixture.scope, threadId),
      ).toMatchObject({
        mutationId: "durable-stop",
        operationKind: "conversation_interrupt",
        category: "interrupt",
      });
      expect(
        reopened.getInterrupt(fixture.scope, "durable-stop"),
      ).toMatchObject({
        state: "uncertain",
        expectedActiveTurnId: "turn-original",
      });
      expect(
        reopened.acceptInterrupt(fixture.scope, "durable-stop"),
      ).toMatchObject({ state: "accepted" });
      expect(
        reopened.prepareInterrupt(fixture.scope, threadId, {
          operationId: "durable-stop",
          expectedActiveTurnId: "ignored-on-replay",
          now: 900,
        }),
      ).toMatchObject({
        state: "accepted",
        expectedActiveTurnId: "turn-original",
      });
      expect(() =>
        reopened.prepareInterrupt(fixture.scope, otherThreadId, {
          operationId: "durable-stop",
          expectedActiveTurnId: "turn-other",
          now: 901,
        }),
      ).toThrow(/another operation/i);
    } finally {
      fixture.database.close();
    }
  });

  it("persists a backend-action uncertainty barrier and accepted replay", () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const operations = new ConversationOperationRepository(fixture.database);
      operations.prepareBackendAction(fixture.scope, threadId, {
        mutationId: "durable-compact",
        expectedThreadRevision: revision(fixture, threadId),
        operation: {
          action: "compact",
          instructions: "Keep the decisions.",
        },
        now: 500,
      });
      operations.markBackendActionStarted(fixture.scope, "durable-compact");

      const reopened = new ConversationOperationRepository(fixture.database);
      expect(
        reopened.findUncertainThreadOperation(fixture.scope, threadId),
      ).toMatchObject({
        mutationId: "durable-compact",
        operationKind: "conversation_compact",
        category: "compaction",
      });
      expect(
        reopened.acceptBackendAction(fixture.scope, "durable-compact"),
      ).toMatchObject({ state: "accepted", action: "compact" });
      expect(
        reopened.prepareBackendAction(fixture.scope, threadId, {
          mutationId: "durable-compact",
          expectedThreadRevision: revision(fixture, threadId),
          operation: {
            action: "compact",
            instructions: "Keep the decisions.",
          },
          now: 900,
        }),
      ).toMatchObject({
        state: "accepted",
        applicationOperationId: "durable-compact",
      });
      expect(() =>
        reopened.prepareBackendAction(fixture.scope, threadId, {
          mutationId: "durable-compact",
          expectedThreadRevision: revision(fixture, threadId),
          operation: {
            action: "compact",
            instructions: "Different request.",
          },
          now: 901,
        }),
      ).toThrow(/another operation/i);
    } finally {
      fixture.database.close();
    }
  });

  it("does not claim a queued head while any thread operation is uncertain", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "blocked", 500);
      fixture.database
        .prepare(
          `
            INSERT INTO mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id,
              operation_kind, request_fingerprint, result_code, result_json,
              replayable, created_at
            )
            VALUES (?, ?, ?, 'uncertain-interrupt',
              'conversation_interrupt', ?, 'uncertain', ?, 0, 550)
          `,
        )
        .run(
          fixture.scope.tenantId,
          fixture.scope.principalId,
          threadId,
          "0".repeat(64),
          JSON.stringify({
            diagnostic: "The stop operation may already have completed.",
          }),
        );
      const gateway = new FakeGateway();
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 600 },
      });

      await dispatcher.recover(fixture.scope);
      expect(gateway.submitted).toEqual([]);
      expect(repository.get(fixture.scope, threadId, "blocked")).toMatchObject({
        state: "pending",
      });

      fixture.database
        .prepare(
          `
            DELETE FROM mutation_receipts
            WHERE tenant_id = ? AND principal_id = ?
              AND mutation_id = 'uncertain-interrupt'
          `,
        )
        .run(fixture.scope.tenantId, fixture.scope.principalId);
      await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);
      expect(gateway.submitted.map(({ text }) => text)).toEqual([
        "text-blocked",
      ]);
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("recovers before dispatch, preserves head order, anchors acceptance, and emits normalized queue events", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const completion = new SubmissionCompletionRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "one", 500);
      enqueue(fixture, repository, threadId, "two", 510);
      const gateway = new FakeGateway();
      gateway.onSubmitBoundary = () => {
        expect(repository.get(fixture.scope, threadId, "one")).toMatchObject({
          state: "dispatching",
          reconciliationToken: "operation-one",
          retryAnchor: gateway.retryAnchor,
        });
      };
      const now = { value: 600 };
      const { dispatcher, events } = createDispatcher(repository, gateway, {
        now,
      });

      await expect(
        dispatcher.onAuthoritativeSettled(fixture.scope, threadId),
      ).rejects.toThrow("scope_not_recovered");
      await dispatcher.recover(fixture.scope);

      expect(gateway.submitted.map(({ text }) => text)).toEqual(["text-one"]);
      expect(gateway.submitted[0]?.source).toEqual({
        kind: "automation",
        automationId: fixture.automationSources.get(threadId)!.automationId,
        automationRunId: `${
          fixture.automationSources.get(threadId)!.automationId
        }-run-1`,
      });
      gateway.onSubmitBoundary = undefined;
      expect(repository.list(fixture.scope, threadId)).toMatchObject([
        { id: "one", state: "accepted" },
        { id: "two", state: "pending" },
      ]);
      expect(
        completion.get(fixture.scope, threadId, "operation-one"),
      ).toMatchObject({
        acceptedAt: 600,
        backendCorrelation: "operation-one",
      });
      expect(events.at(-1)?.event).toMatchObject({
        type: "queue_changed",
        items: [{ id: "two", state: "pending" }],
      });

      now.value = 700;
      await Promise.all([
        dispatcher.onAuthoritativeSettled(fixture.scope, threadId),
        dispatcher.onAuthoritativeSettled(fixture.scope, threadId),
      ]);
      expect(gateway.submitted.map(({ text }) => text)).toEqual([
        "text-one",
        "text-two",
      ]);
      expect(repository.list(fixture.scope, threadId)[1]).toMatchObject({
        state: "accepted",
        acceptedAt: 700,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("defers next-head runtime acquisition until durable completion observation returns", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "headless-one", 500);
      enqueue(fixture, repository, threadId, "headless-two", 510);
      const gateway = new FakeGateway();
      const scheduler = new ManualScheduler();
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });

      await dispatcher.recover(fixture.scope);
      expect(gateway.submitted.map(({ text }) => text)).toEqual([
        "text-headless-one",
      ]);

      let releaseAcquisition!: () => void;
      const acquisitionMayFinish = new Promise<void>((resolve) => {
        releaseAcquisition = resolve;
      });
      let observeAcquisition!: () => void;
      const acquisitionStarted = new Promise<void>((resolve) => {
        observeAcquisition = resolve;
      });
      gateway.withConversationGates.push(acquisitionMayFinish);
      gateway.onWithConversationBoundary = observeAcquisition;
      now.value = 700;
      await expect(
        Promise.race([
          dispatcher.onAuthoritativeCompletion(fixture.scope, threadId, {
            backendCorrelation: "operation-headless-one",
            backendTurnId: "turn-headless-one",
            applicationTurnId: "turn-headless-one",
            completionIdentity: "turn-headless-one:completed",
            outcome: "completed",
            result: { text: "Done" },
            classifiedResult: null,
          }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("completion_observer_reacquired_runtime")),
              100,
            ),
          ),
        ]),
      ).resolves.toMatchObject({
        lastCompletionIdentity: "turn-headless-one:completed",
      });
      expect(gateway.submitted.map(({ text }) => text)).toEqual([
        "text-headless-one",
      ]);

      scheduler.runLatest();
      await acquisitionStarted;
      releaseAcquisition();
      await vi.waitFor(() =>
        expect(gateway.submitted.map(({ text }) => text)).toEqual([
          "text-headless-one",
          "text-headless-two",
        ]),
      );
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("retries a pending durable enqueue after transient conversation acquisition failure", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      const gateway = new FakeGateway();
      const scheduler = new ManualScheduler();
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });
      await dispatcher.recover(fixture.scope);
      gateway.withConversationFailures.push(
        new Error("snapshot publication unavailable"),
        new Error("actor acquisition unavailable"),
      );

      await expect(
        dispatcher.enqueue(fixture.scope, threadId, {
          id: "transient-acquire",
          mutationId: "operation-transient-acquire",
          text: "queued durably",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "automation",
            expectedThreadRevision: revision(fixture, threadId),
            ...automationSource(
              fixture,
              threadId,
              "operation-transient-acquire",
            ),
          },
          now: now.value,
        }),
      ).resolves.toMatchObject({
        item: { id: "transient-acquire", state: "pending" },
      });
      expect(scheduler.scheduled.at(-1)?.delay).toBe(100);

      now.value = 700;
      scheduler.runLatest();
      await vi.waitFor(() => expect(gateway.submitted).toHaveLength(1));
      expect(
        repository.get(fixture.scope, threadId, "transient-acquire"),
      ).toMatchObject({ state: "accepted" });
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("retries a pending durable enqueue when authoritative settlement trails the idle projection", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      const scheduler = new ManualScheduler();
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });
      await dispatcher.recover(fixture.scope);

      await expect(
        dispatcher.enqueue(fixture.scope, threadId, {
          id: "settlement-lag",
          mutationId: "operation-settlement-lag",
          text: "preserve this pending input",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "automation",
            expectedThreadRevision: revision(fixture, threadId),
            ...automationSource(fixture, threadId, "operation-settlement-lag"),
          },
          now: now.value,
        }),
      ).resolves.toMatchObject({
        item: { id: "settlement-lag", state: "pending" },
      });
      expect(gateway.submitted).toEqual([]);
      expect(scheduler.scheduled.at(-1)?.delay).toBe(100);

      gateway.authoritativelySettled = true;
      now.value = 700;
      scheduler.runLatest();
      await vi.waitFor(() => expect(gateway.submitted).toHaveLength(1));
      expect(
        repository.get(fixture.scope, threadId, "settlement-lag"),
      ).toMatchObject({ state: "accepted" });
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("resumes a boundary-crossing retry after reconciliation clears the actor latch", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "latched", 500);
      const gateway = new FakeGateway();
      const scheduler = new ManualScheduler();
      const now = { value: 600 };
      gateway.onSubmitBoundary = () => {
        gateway.authoritativelySettled = false;
      };
      gateway.submitBehaviors.push(
        new BackendError({
          category: "overloaded",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "Submission outcome is unknown.",
        }),
      );
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });
      await dispatcher.recover(fixture.scope);
      gateway.onSubmitBoundary = undefined;
      gateway.reconciliationBehaviors.push({
        status: "not_accepted",
        retryable: true,
      });
      gateway.onReconciliation = (result) => {
        if (result.status === "not_accepted") {
          gateway.authoritativelySettled = true;
        }
      };

      await dispatcher.reconcileUncertain(fixture.scope, threadId, "latched");
      expect(repository.get(fixture.scope, threadId, "latched")).toMatchObject({
        state: "retry_wait",
        nextAttemptAt: 700,
      });

      now.value = 700;
      scheduler.runLatest();
      await vi.waitFor(() => expect(gateway.submitted).toHaveLength(2));
      expect(repository.get(fixture.scope, threadId, "latched")).toMatchObject({
        state: "accepted",
      });
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("requeues one invalid-state race without spending retry budget, then applies bounded backoff without spinning", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "race", 500);
      const invalidState = () =>
        new BackendError({
          category: "invalid_state",
          retryable: true,
          crossedSubmissionBoundary: false,
          safeMessage: "Actor became busy.",
        });
      const gateway = new FakeGateway();
      gateway.submitBehaviors.push(invalidState(), invalidState(), {
        accepted: true,
        reconciliationToken: "operation-race",
        completionCorrelation: "operation-race",
      });
      const now = { value: 600 };
      const scheduler = new ManualScheduler();
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });

      await dispatcher.recover(fixture.scope);
      expect(repository.get(fixture.scope, threadId, "race")).toMatchObject({
        state: "pending",
        invalidStateRequeues: 1,
        retryCount: 0,
      });
      expect(gateway.submitted).toHaveLength(1);
      expect(scheduler.scheduled).toHaveLength(0);

      now.value = 700;
      await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);
      expect(repository.get(fixture.scope, threadId, "race")).toMatchObject({
        state: "retry_wait",
        invalidStateRequeues: 1,
        retryCount: 1,
        nextAttemptAt: 800,
      });
      expect(scheduler.scheduled.at(-1)?.delay).toBe(100);
      expect(gateway.submitted).toHaveLength(2);

      now.value = 800;
      scheduler.runLatest();
      await new Promise((resolve) => setImmediate(resolve));
      expect(gateway.submitted).toHaveLength(3);
      expect(repository.get(fixture.scope, threadId, "race")).toMatchObject({
        state: "accepted",
        retryCount: 1,
      });
    } finally {
      fixture.database.close();
    }
  });

  // Formerly the head stayed uncertain forever: only force reset cleared it.
  // Terminal tracking now hands the decision to the user, as for a Steer.
  it.each(["restore", "acknowledge"] as const)(
    "fails an ordinary submission whose tracking ended unknown for the user to %s, never resending it",
    async (resolution) => {
      const fixture = createFixture();
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      const { dispatcher } = createDispatcher(repository, gateway, { now: { value: 600 } });
      const [threadId] = fixture.threadIds;
      try {
        enqueueUser(fixture, repository, threadId, "unknown-submit", 500);
        enqueueUser(fixture, repository, threadId, "later-submit", 510);
        gateway.submitBehaviors.push(new Error("transport lost after submission"));
        await dispatcher.recover(fixture.scope);
        expect(repository.get(fixture.scope, threadId, "unknown-submit")).toMatchObject({ state: "uncertain", deliveryMode: "submit" });
        // The automatic dispatch check recognizes only acceptance.
        gateway.reconciliationBehaviors.push({ status: "failed_unknown", diagnostic: { text: "Tracking ended" } });
        await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);
        expect(repository.get(fixture.scope, threadId, "unknown-submit")).toMatchObject({ state: "uncertain", deliveryMode: "submit" });
        gateway.reconciliationBehaviors.push({ status: "failed_unknown", diagnostic: { text: "Tracking ended" } });
        await dispatcher.reconcileUncertain(fixture.scope, threadId, "unknown-submit");
        expect(repository.get(fixture.scope, threadId, "unknown-submit")).toMatchObject({
          state: "failed", deliveryMode: null, failureAcknowledgedAt: null, retryCount: 0,
          diagnostic: expect.stringMatching(/Delivery outcome is unknown.*may already have received.*Tracking ended/su),
        });
        // The unacknowledged failure still holds later input until the user decides.
        expect(repository.get(fixture.scope, threadId, "later-submit").state).toBe("pending");
        expect(gateway.submitted).toHaveLength(1);
        if (resolution === "restore") {
          const draft = new ConversationDraftRepository(fixture.database).get(fixture.scope, threadId);
          await expect(dispatcher.restoreUserInput(fixture.scope, threadId, "unknown-submit", {
            mutationId: "restore-unknown-submit", expectedThreadRevision: revision(fixture, threadId),
            expectedDraftRevision: draft.revision, now: 610,
          })).resolves.toMatchObject({ item: { state: "cancelled" }, draft: { text: "text-unknown-submit" } });
        } else {
          await expect(dispatcher.acknowledgeFailure(fixture.scope, threadId, "unknown-submit", 610))
            .resolves.toMatchObject({ state: "failed", failureAcknowledgedAt: 610 });
        }
        await vi.waitFor(() => expect(gateway.submitted).toHaveLength(2));
        expect(gateway.submitted[1]).toMatchObject({ applicationOperationId: "operation-later-submit" });
        expect(repository.get(fixture.scope, threadId, "later-submit").state).toBe("accepted");
        expect(gateway.steered).toEqual([]);
      } finally { await dispatcher.close(); fixture.database.close(); }
    },
  );

  it.each(["settled", "later-dispatch"] as const)("accepts late ordinary history on %s without resending the uncertain head", async trigger => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const gateway = new FakeGateway();
    const { dispatcher } = createDispatcher(repository, gateway, { now: { value: 600 } });
    const [threadId] = fixture.threadIds;
    try {
      enqueueUser(fixture, repository, threadId, "slow-head", 500);
      gateway.submitBehaviors.push(new BackendError({ category: "submission_unknown", retryable: false,
        crossedSubmissionBoundary: true, safeMessage: "Acknowledgment timed out" }));
      await dispatcher.recover(fixture.scope);
      expect(repository.get(fixture.scope, threadId, "slow-head").state).toBe("uncertain");
      enqueueUser(fixture, repository, threadId, "later-message", 700);
      gateway.reconciliationBehaviors.push({ status: "accepted", completionIdentity: "native-terminal-slow-head" });
      if (trigger === "settled") await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);
      else await dispatcher.dispatchAdmitted(fixture.scope, threadId);
      expect(repository.get(fixture.scope, threadId, "slow-head").state).toBe("accepted");
      expect(repository.get(fixture.scope, threadId, "later-message").state).toBe("accepted");
      expect(gateway.submitted.map(input => input.applicationOperationId)).toEqual(["operation-slow-head", "operation-later-message"]);
      expect(gateway.reconciled).toHaveLength(1);
    } finally { await dispatcher.close(); fixture.database.close(); }
  });

  it.each(["unresolved", "not_accepted"] as const)("keeps automatic %s reconciliation read-only and blocks later input", async status => {
    const fixture = createFixture();
    const repository = new QueuedInputRepository(fixture.database);
    const gateway = new FakeGateway();
    const { dispatcher } = createDispatcher(repository, gateway, { now: { value: 600 } });
    const [threadId] = fixture.threadIds;
    try {
      enqueueUser(fixture, repository, threadId, "unknown-head", 500);
      gateway.submitBehaviors.push(new Error("acknowledgment lost"));
      await dispatcher.recover(fixture.scope);
      enqueueUser(fixture, repository, threadId, "blocked-later", 700);
      gateway.reconciliationBehaviors.push(status === "not_accepted" ? { status, retryable: true } : { status, diagnostic: { text: "No proof yet" } });
      await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);
      expect(repository.get(fixture.scope, threadId, "unknown-head").state).toBe("uncertain");
      expect(repository.get(fixture.scope, threadId, "blocked-later").state).toBe("pending");
      expect(gateway.submitted.map(input => input.applicationOperationId)).toEqual(["operation-unknown-head"]);
      expect(gateway.reconciled).toHaveLength(1);
    } finally { await dispatcher.close(); fixture.database.close(); }
  });

  it("treats unknown and crossed-boundary outcomes as uncertainty and reconciles before later heads after restart", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "unknown", 500);
      enqueue(fixture, repository, threadId, "later", 510);
      const firstGateway = new FakeGateway();
      firstGateway.submitBehaviors.push(new Error("socket vanished"));
      const now = { value: 600 };
      const first = createDispatcher(repository, firstGateway, { now });
      await first.dispatcher.recover(fixture.scope);
      expect(repository.get(fixture.scope, threadId, "unknown")).toMatchObject({
        state: "uncertain",
        reconciliationToken: "operation-unknown",
      });
      expect(firstGateway.submitted).toHaveLength(1);

      const crossedThreadId = fixture.threadIds[1];
      firstGateway.submitBehaviors.push(
        new BackendError({
          category: "overloaded",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "The connection closed after submission began.",
        }),
      );
      await first.dispatcher.enqueue(fixture.scope, crossedThreadId, {
        id: "crossed",
        mutationId: "operation-crossed",
        text: "crossed-boundary",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "automation",
          expectedThreadRevision: revision(fixture, crossedThreadId),
          ...automationSource(fixture, crossedThreadId, "operation-crossed"),
        },
        now: 620,
      });
      expect(
        repository.get(fixture.scope, crossedThreadId, "crossed"),
      ).toMatchObject({
        state: "uncertain",
        diagnostic: "The connection closed after submission began.",
      });
      firstGateway.reconciliationBehaviors.push({ status: "accepted" });
      await first.dispatcher.reconcileUncertain(
        fixture.scope,
        crossedThreadId,
        "crossed",
      );
      await first.dispatcher.close();

      const secondGateway = new FakeGateway();
      secondGateway.reconciliationBehaviors.push({ status: "accepted" });
      const second = createDispatcher(repository, secondGateway, { now });
      await second.dispatcher.recover(fixture.scope);
      expect(secondGateway.calls).toEqual([
        "reconcile:operation-unknown:operation-unknown",
        `anchor:${threadId}`,
        "submit:operation-later",
      ]);
      expect(repository.list(fixture.scope, threadId)).toMatchObject([
        { id: "unknown", state: "accepted" },
        { id: "later", state: "accepted" },
      ]);
      expect(
        new SubmissionCompletionRepository(fixture.database).get(
          fixture.scope,
          threadId,
          "operation-unknown",
        ),
      ).toMatchObject({ backendCorrelation: "operation-unknown" });
    } finally {
      fixture.database.close();
    }
  });

  it("does not claim while the actor is busy and leaves unresolved uncertainty blocking later input", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "busy", 500);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, { now });
      await dispatcher.recover(fixture.scope);
      expect(repository.get(fixture.scope, threadId, "busy").state).toBe(
        "pending",
      );
      expect(gateway.submitted).toEqual([]);

      gateway.authoritativelySettled = true;
      gateway.submitBehaviors.push(new Error("unknown outcome"));
      await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);
      enqueue(fixture, repository, threadId, "blocked", 610);
      gateway.reconciliationBehaviors.push({
        status: "unresolved",
        diagnostic: { text: "still unknown" },
      });
      await dispatcher.reconcileUncertain(fixture.scope, threadId, "busy");
      await dispatcher.onAuthoritativeSettled(fixture.scope, threadId);

      expect(repository.list(fixture.scope, threadId)).toMatchObject([
        { id: "busy", state: "uncertain" },
        { id: "blocked", state: "pending" },
      ]);
      expect(gateway.submitted).toHaveLength(1);
    } finally {
      fixture.database.close();
    }
  });

  it("reconciles a crash-left dispatching row from its durable pre-submission anchor", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "crash", 500);
      repository.claimHead(
        fixture.scope,
        threadId,
        '{"version":1,"position":"crash"}',
        550,
      );
      const gateway = new FakeGateway();
      gateway.reconciliationBehaviors.push({
        status: "not_accepted",
        retryable: true,
      });
      const now = { value: 600 };
      const scheduler = new ManualScheduler();
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });

      await dispatcher.recover(fixture.scope);
      expect(gateway.calls[0]).toBe(
        "reconcile:operation-crash:operation-crash",
      );
      expect(gateway.reconciled[0]).toEqual({
        applicationOperationId: "operation-crash",
        reconciliationToken: "operation-crash",
        retryAnchor: '{"version":1,"position":"crash"}',
      });
      expect(repository.get(fixture.scope, threadId, "crash")).toMatchObject({
        state: "retry_wait",
        retryCount: 1,
        nextAttemptAt: 700,
        retryAnchor: null,
      });
      expect(scheduler.scheduled.at(-1)?.delay).toBe(100);
    } finally {
      fixture.database.close();
    }
  });

  it("does not create completion attention when recovery proves only active-turn acceptance", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "active-recovery", 500);
      repository.claimHead(
        fixture.scope,
        threadId,
        '{"version":1,"position":"active-recovery"}',
        510,
      );
      repository.markUncertain(fixture.scope, threadId, "active-recovery", {
        now: 511,
        reconciliationToken: "operation-active-recovery",
        diagnostic: "requires reconciliation",
      });
      const gateway = new FakeGateway();
      gateway.reconciliationBehaviors.push({
        status: "accepted",
        backendTurn: {
          backendTurnId: "backend-turn-active-recovery",
          completionCorrelations: ["operation-active-recovery"],
          status: "in_progress",
          orderedBackendItemIds: [],
        },
      });
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 600 },
      });

      await dispatcher.recover(fixture.scope);

      expect(
        repository.get(fixture.scope, threadId, "active-recovery"),
      ).toMatchObject({ state: "accepted" });
      expect(
        new SubmissionCompletionRepository(fixture.database).get(
          fixture.scope,
          threadId,
          "operation-active-recovery",
        ),
      ).toMatchObject({
        lastCompletionIdentity: null,
        completionObservedAt: null,
        attentionCreatedAt: null,
      });
    } finally {
      fixture.database.close();
    }
  });

  it("retains accepted submission correlations and creates attention for a completion first observed during recovery", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "persist", 500);
      const originalMarkAccepted = repository.markAccepted.bind(repository);
      vi.spyOn(repository, "markAccepted")
        .mockImplementationOnce(() => {
          throw new Error("simulated acceptance write failure");
        })
        .mockImplementation(originalMarkAccepted);
      const gateway = new FakeGateway();
      gateway.submitBehaviors.push({
        accepted: true,
        reconciliationToken: "operation-persist",
        completionCorrelation: "operation-persist",
        backendTurnId: "backend-turn-persist",
      });
      const now = { value: 600 };
      const first = createDispatcher(repository, gateway, { now });
      await first.dispatcher.recover(fixture.scope);
      expect(repository.get(fixture.scope, threadId, "persist")).toMatchObject({
        state: "uncertain",
        reconciliationToken: "operation-persist",
        backendCorrelation: "operation-persist",
        diagnostic:
          "The backend accepted the submission, but its durable acceptance record could not be completed.",
      });
      await first.dispatcher.close();

      const recoveryGateway = new FakeGateway();
      recoveryGateway.reconciliationBehaviors.push({
        status: "accepted",
        backendTurn: {
          backendTurnId: "backend-turn-persist",
          completionCorrelations: ["operation-persist"],
          status: "completed",
          endedBy: "agent_settled",
          orderedBackendItemIds: [],
        },
        completionIdentity: "completion-persist",
      });
      now.value = 700;
      const second = createDispatcher(repository, recoveryGateway, { now });
      await second.dispatcher.recover(fixture.scope);

      expect(repository.get(fixture.scope, threadId, "persist")).toMatchObject({
        state: "accepted",
        reconciliationToken: null,
        backendCorrelation: "operation-persist",
      });
      expect(
        new SubmissionCompletionRepository(fixture.database).get(
          fixture.scope,
          threadId,
          "operation-persist",
        ),
      ).toMatchObject({
        backendCorrelation: "operation-persist",
        lastCompletionIdentity: "completion-persist",
        completionObservedAt: 700,
        attentionCreatedAt: 700,
      });

      const backendTurnOnlyThreadId = fixture.threadIds[1];
      enqueue(
        fixture,
        repository,
        backendTurnOnlyThreadId,
        "backend-turn-only",
        710,
      );
      repository.claimHead(
        fixture.scope,
        backendTurnOnlyThreadId,
        '{"version":1,"position":"backend-turn-only"}',
        720,
      );
      repository.markUncertain(
        fixture.scope,
        backendTurnOnlyThreadId,
        "backend-turn-only",
        {
          now: 721,
          reconciliationToken: "reconcile-backend-turn-only",
          diagnostic: "requires reconciliation",
        },
      );
      recoveryGateway.reconciliationBehaviors.push({
        status: "accepted",
        backendTurn: {
          backendTurnId: "completion-from-backend-turn",
          completionCorrelations: ["operation-backend-turn-only"],
          status: "completed",
          endedBy: "agent_settled",
          orderedBackendItemIds: [],
        },
      });
      now.value = 730;
      await second.dispatcher.reconcileUncertain(
        fixture.scope,
        backendTurnOnlyThreadId,
        "backend-turn-only",
      );
      expect(
        new SubmissionCompletionRepository(fixture.database).get(
          fixture.scope,
          backendTurnOnlyThreadId,
          "operation-backend-turn-only",
        ),
      ).toMatchObject({
        lastCompletionIdentity: null,
        attentionCreatedAt: null,
      });
      now.value = 740;
      await expect(
        second.dispatcher.onAuthoritativeCompletion(
          fixture.scope,
          backendTurnOnlyThreadId,
          {
            backendCorrelation: "operation-backend-turn-only",
            backendTurnId: "completion-from-backend-turn",
            applicationTurnId: "completion-from-backend-turn",
            completionIdentity: "completion-from-backend-turn:completed",
            outcome: "completed",
            result: { text: "Done" },
            classifiedResult: null,
          },
        ),
      ).resolves.toMatchObject({
        lastCompletionIdentity: "completion-from-backend-turn:completed",
        attentionCreatedAt: 740,
      });
      expect(lastActivityAt(fixture, backendTurnOnlyThreadId)).toBe(740);
      const completedRevision = revision(fixture, backendTurnOnlyThreadId);
      await expect(
        second.dispatcher.onAuthoritativeCompletion(
          fixture.scope,
          backendTurnOnlyThreadId,
          {
            backendCorrelation: "operation-backend-turn-only",
            backendTurnId: "completion-from-backend-turn",
            applicationTurnId: "completion-from-backend-turn",
            completionIdentity: "completion-from-backend-turn:completed",
            outcome: "completed",
            result: { text: "Done" },
            classifiedResult: null,
            observedAt: 800,
          },
        ),
      ).resolves.toMatchObject({
        completionObservedAt: 740,
        attentionCreatedAt: 740,
      });
      expect(revision(fixture, backendTurnOnlyThreadId)).toBe(
        completedRevision,
      );
      expect(lastActivityAt(fixture, backendTurnOnlyThreadId)).toBe(740);
      await expect(
        second.dispatcher.onAuthoritativeCompletion(
          fixture.scope,
          backendTurnOnlyThreadId,
          {
            backendCorrelation: "imported-history-turn",
            backendTurnId: "imported-history-turn",
            applicationTurnId: "imported-history-turn",
            completionIdentity: "imported-history-turn:completed",
            outcome: "completed",
            result: { text: "Imported" },
            classifiedResult: null,
          },
        ),
      ).resolves.toBeUndefined();
      expect(lastActivityAt(fixture, backendTurnOnlyThreadId)).toBe(740);
    } finally {
      fixture.database.close();
    }
  });

  it("quarantines a driver that does not echo the durable reconciliation identity", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "identity-mismatch", 500);
      const gateway = new FakeGateway();
      gateway.submitBehaviors.push({
        accepted: true,
        reconciliationToken: "wrong-token",
        completionCorrelation: "operation-identity-mismatch",
        backendTurnId: "backend-turn-mismatch",
      });
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, { now });

      await dispatcher.recover(fixture.scope);

      expect(gateway.submitted[0]?.reconciliationToken).toBe(
        "operation-identity-mismatch",
      );
      expect(
        repository.get(fixture.scope, threadId, "identity-mismatch"),
      ).toMatchObject({
        state: "uncertain",
        reconciliationToken: "operation-identity-mismatch",
        backendCorrelation: "operation-identity-mismatch",
        diagnostic:
          "The backend accepted the submission with an invalid reconciliation identity.",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("distinguishes clean terminal failure and supports acknowledge, explicit retry, and cancellation", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "failed", 500);
      enqueue(fixture, repository, threadId, "cancel", 510);
      const gateway = new FakeGateway();
      gateway.submitBehaviors.push(
        new BackendError({
          category: "rejected",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "Request rejected.",
        }),
      );
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, { now });
      await dispatcher.recover(fixture.scope);
      expect(repository.get(fixture.scope, threadId, "failed")).toMatchObject({
        state: "failed",
        failureAcknowledgedAt: null,
      });
      expect(repository.getFailureAttention(fixture.scope, threadId)).toEqual({
        queuedInputId: "failed",
        failedAt: 600,
        diagnostic: "Request rejected.",
      });
      expect(gateway.submitted).toHaveLength(1);

      await dispatcher.cancel(fixture.scope, threadId, "cancel", { now: 610 });
      now.value = 620;
      await dispatcher.retryFailed(fixture.scope, threadId, "failed", {
        id: "explicit-retry",
        mutationId: "operation-explicit-retry",
        now: 620,
      });
      expect(repository.get(fixture.scope, threadId, "failed")).toMatchObject({
        failureAcknowledgedAt: 620,
      });
      expect(
        repository.getFailureAttention(fixture.scope, threadId),
      ).toBeUndefined();
      expect(repository.get(fixture.scope, threadId, "cancel")).toMatchObject({
        state: "cancelled",
      });
      expect(
        repository.get(fixture.scope, threadId, "explicit-retry"),
      ).toMatchObject({
        retryOfId: "failed",
        retryCount: 0,
        state: "accepted",
      });
      const acknowledgedRevision = revision(fixture, threadId);
      await expect(
        dispatcher.acknowledgeFailure(fixture.scope, threadId, "failed", 625),
      ).resolves.toMatchObject({ failureAcknowledgedAt: 620 });
      expect(revision(fixture, threadId)).toBe(acknowledgedRevision);
      await expect(
        dispatcher.retryFailed(fixture.scope, threadId, "failed", {
          id: "duplicate-explicit-retry",
          mutationId: "operation-duplicate-explicit-retry",
          now: 630,
        }),
      ).rejects.toThrow("unacknowledged failed queued input");
    } finally {
      fixture.database.close();
    }
  });

  it("keeps recovery and serialization isolated by owner scope", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, { now });
      const foreignScope = {
        tenantId: "foreign-tenant",
        principalId: "foreign-principal",
      };
      await dispatcher.recover(foreignScope);
      expect(gateway.calls).toEqual([]);
      await dispatcher.onAuthoritativeSettled(
        foreignScope,
        fixture.threadIds[0],
      );
      expect(gateway.submitted).toEqual([]);
      expect(repository.list(fixture.scope, fixture.threadIds[0])).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });

  it("closes idempotently only after draining an in-flight durable dispatch", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      const gateway = new FakeGateway();
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, { now });
      await dispatcher.recover(fixture.scope);

      let releaseSubmission!: () => void;
      gateway.submitBehaviors.push(
        new Promise<SubmitTurnResult>((resolve) => {
          releaseSubmission = () =>
            resolve({
              accepted: true,
              reconciliationToken: "operation-close",
              completionCorrelation: "operation-close",
            });
        }),
      );
      const enqueuePromise = dispatcher.enqueue(fixture.scope, threadId, {
        id: "close",
        mutationId: "operation-close",
        text: "wait during close",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "automation",
          expectedThreadRevision: revision(fixture, threadId),
          ...automationSource(fixture, threadId, "operation-close"),
        },
        now: 610,
      });
      await vi.waitFor(() => expect(gateway.submitted).toHaveLength(1));

      const firstClose = dispatcher.close();
      const secondClose = dispatcher.close();
      expect(secondClose).toBe(firstClose);
      let closeFinished = false;
      void firstClose.then(() => {
        closeFinished = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(closeFinished).toBe(false);

      releaseSubmission();
      await expect(enqueuePromise).resolves.toMatchObject({
        item: { id: "close", state: "accepted" },
      });
      await firstClose;
      expect(closeFinished).toBe(true);
      expect(repository.get(fixture.scope, threadId, "close").state).toBe(
        "accepted",
      );
      await expect(
        dispatcher.onAuthoritativeSettled(fixture.scope, threadId),
      ).rejects.toThrow("dispatcher_closed");
    } finally {
      fixture.database.close();
    }
  });

  it("reschedules a due retry after transient conversation acquisition failure", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "timer-retry", 500);
      repository.claimHead(
        fixture.scope,
        threadId,
        '{"version":1,"position":"timer"}',
        510,
      );
      repository.handleCleanFailure(fixture.scope, threadId, "timer-retry", {
        expectedState: "dispatching",
        retryable: true,
        diagnostic: "temporary",
        now: 520,
        retryPolicy: {
          maximumRetries: 1,
          baseDelayMilliseconds: 100,
          maximumDelayMilliseconds: 1_000,
        },
      });
      const gateway = new FakeGateway();
      const now = { value: 620 };
      const scheduler = new ManualScheduler();
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });
      await dispatcher.recover(fixture.scope);
      gateway.withConversationFailures.push(
        new Error("temporary actor acquisition failure"),
      );

      scheduler.runLatest();
      await vi.waitFor(() => {
        expect(scheduler.scheduled).toHaveLength(2);
      });
      expect(scheduler.scheduled[1]).toMatchObject({
        delay: 100,
        cancelled: false,
      });
      expect(repository.get(fixture.scope, threadId, "timer-retry").state).toBe(
        "retry_wait",
      );

      scheduler.runLatest();
      await vi.waitFor(() => {
        expect(
          repository.get(fixture.scope, threadId, "timer-retry").state,
        ).toBe("accepted");
      });
    } finally {
      fixture.database.close();
    }
  });

  it("does not lose a head retry timer when cancelling a later item races actor acquisition failure", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "retry-head", 500);
      enqueue(fixture, repository, threadId, "cancel-later", 510);
      repository.claimHead(
        fixture.scope,
        threadId,
        '{"version":1,"position":"retry"}',
        520,
      );
      repository.handleCleanFailure(fixture.scope, threadId, "retry-head", {
        expectedState: "dispatching",
        retryable: true,
        diagnostic: "temporary",
        now: 530,
        retryPolicy: {
          maximumRetries: 1,
          baseDelayMilliseconds: 100,
          maximumDelayMilliseconds: 1_000,
        },
      });
      const gateway = new FakeGateway();
      const now = { value: 530 };
      const scheduler = new ManualScheduler();
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });
      await dispatcher.recover(fixture.scope);
      const retryTimer = scheduler.scheduled.at(-1)!;
      gateway.withConversationFailures.push(
        new Error("snapshot acquisition failed"),
        new Error("dispatch acquisition failed"),
      );

      await expect(
        dispatcher.cancel(fixture.scope, threadId, "cancel-later", {
          now: 540,
        }),
      ).resolves.toMatchObject({
        id: "cancel-later",
        state: "cancelled",
      });
      expect(retryTimer.cancelled).toBe(false);
      expect(
        repository.get(fixture.scope, threadId, "cancel-later").state,
      ).toBe("cancelled");

      now.value = 630;
      retryTimer.callback();
      await vi.waitFor(() => {
        expect(
          repository.get(fixture.scope, threadId, "retry-head").state,
        ).toBe("accepted");
      });
    } finally {
      fixture.database.close();
    }
  });

  it("returns a durable explicit retry and schedules it after actor acquisition failure", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "failed-for-retry", 500);
      repository.claimHead(
        fixture.scope,
        threadId,
        '{"version":1,"position":"failed"}',
        510,
      );
      repository.handleCleanFailure(
        fixture.scope,
        threadId,
        "failed-for-retry",
        {
          expectedState: "dispatching",
          retryable: false,
          diagnostic: "terminal",
          now: 520,
          retryPolicy: {
            maximumRetries: 1,
            baseDelayMilliseconds: 100,
            maximumDelayMilliseconds: 1_000,
          },
        },
      );
      const gateway = new FakeGateway();
      const scheduler = new ManualScheduler();
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });
      await dispatcher.recover(fixture.scope);
      gateway.withConversationFailures.push(
        new Error("snapshot acquisition failed"),
        new Error("dispatch acquisition failed"),
      );

      await expect(
        dispatcher.retryFailed(fixture.scope, threadId, "failed-for-retry", {
          id: "durable-retry",
          mutationId: "operation-durable-retry",
          now: 610,
        }),
      ).resolves.toMatchObject({
        replayed: false,
        item: { id: "durable-retry", state: "pending" },
      });
      expect(scheduler.scheduled.at(-1)).toMatchObject({
        delay: 100,
        cancelled: false,
      });

      now.value = 710;
      scheduler.runLatest();
      await vi.waitFor(() =>
        expect(
          repository.get(fixture.scope, threadId, "durable-retry").state,
        ).toBe("accepted"),
      );
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("returns a durable acknowledgement and schedules the newly exposed pending head", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      enqueue(fixture, repository, threadId, "failed-for-ack", 500);
      enqueue(fixture, repository, threadId, "after-ack", 510);
      repository.claimHead(
        fixture.scope,
        threadId,
        '{"version":1,"position":"failed"}',
        520,
      );
      repository.handleCleanFailure(fixture.scope, threadId, "failed-for-ack", {
        expectedState: "dispatching",
        retryable: false,
        diagnostic: "terminal",
        now: 530,
        retryPolicy: {
          maximumRetries: 1,
          baseDelayMilliseconds: 100,
          maximumDelayMilliseconds: 1_000,
        },
      });
      const gateway = new FakeGateway();
      const scheduler = new ManualScheduler();
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });
      await dispatcher.recover(fixture.scope);
      gateway.withConversationFailures.push(
        new Error("snapshot acquisition failed"),
        new Error("dispatch acquisition failed"),
      );

      await expect(
        dispatcher.acknowledgeFailure(
          fixture.scope,
          threadId,
          "failed-for-ack",
          610,
        ),
      ).resolves.toMatchObject({
        id: "failed-for-ack",
        failureAcknowledgedAt: 610,
      });
      expect(scheduler.scheduled.at(-1)).toMatchObject({
        delay: 100,
        cancelled: false,
      });

      now.value = 710;
      scheduler.runLatest();
      await vi.waitFor(() =>
        expect(repository.get(fixture.scope, threadId, "after-ack").state).toBe(
          "accepted",
        ),
      );
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("returns durable uncertainty reconciliation and schedules the next pending head", async () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      const gateway = new FakeGateway();
      const scheduler = new ManualScheduler();
      const now = { value: 600 };
      const { dispatcher } = createDispatcher(repository, gateway, {
        now,
        scheduler,
      });
      await dispatcher.recover(fixture.scope);
      enqueue(fixture, repository, threadId, "uncertain-before-next", 610);
      enqueue(fixture, repository, threadId, "after-reconcile", 620);
      repository.claimHead(
        fixture.scope,
        threadId,
        '{"version":1,"position":"uncertain"}',
        630,
      );
      repository.markUncertain(
        fixture.scope,
        threadId,
        "uncertain-before-next",
        {
          now: 631,
          diagnostic: "unknown",
        },
      );
      gateway.reconciliationBehaviors.push({ status: "accepted" });
      gateway.withConversationFailures.push(
        new Error("snapshot acquisition failed"),
        new Error("dispatch acquisition failed"),
      );

      await expect(
        dispatcher.reconcileUncertain(
          fixture.scope,
          threadId,
          "uncertain-before-next",
        ),
      ).resolves.toMatchObject({
        id: "uncertain-before-next",
        state: "accepted",
      });
      expect(scheduler.scheduled.at(-1)).toMatchObject({
        delay: 100,
        cancelled: false,
      });

      now.value = 730;
      scheduler.runLatest();
      await vi.waitFor(() =>
        expect(
          repository.get(fixture.scope, threadId, "after-reconcile").state,
        ).toBe("accepted"),
      );
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("restores queued input under queue serialization and publishes its removal", async () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      const now = { value: 690 };
      const { dispatcher, events } = createDispatcher(repository, gateway, {
        now,
      });
      await dispatcher.recover(fixture.scope);
      enqueueUser(
        fixture,
        repository,
        threadId,
        "restore-to-draft",
        700,
        "return this to the composer",
      );
      const drafts = new ConversationDraftRepository(fixture.database);
      const empty = drafts.get(fixture.scope, threadId);
      const expectedThreadRevision = revision(fixture, threadId);
      now.value = 710;

      const result = await dispatcher.restoreUserInput(
        fixture.scope,
        threadId,
        "restore-to-draft",
        {
          mutationId: "restore-to-draft-operation",
          expectedThreadRevision,
          expectedDraftRevision: empty.revision,
          now: now.value,
        },
      );

      expect(result).toMatchObject({
        replayed: false,
        item: { id: "restore-to-draft", state: "cancelled" },
        draft: {
          text: "return this to the composer",
          revision: empty.revision + 1,
        },
        queue: [],
      });
      expect(result.threadRevision).toBe(expectedThreadRevision + 1);
      expect(events.at(-1)?.event).toMatchObject({
        type: "queue_changed",
        threadRevision: expectedThreadRevision + 1,
        items: [],
      });
      await expect(
        dispatcher.restoreUserInput(
          fixture.scope,
          threadId,
          "restore-to-draft",
          {
            mutationId: "restore-to-draft-operation",
            expectedThreadRevision,
            expectedDraftRevision: empty.revision,
            now: 999,
          },
        ),
      ).resolves.toMatchObject({
        replayed: true,
        draft: { revision: empty.revision + 1 },
        queue: [],
      });
      expect(events).toHaveLength(1);
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("steers the exact durable user head without changing the current draft", async () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      const now = { value: 700 };
      const { dispatcher, events } = createDispatcher(repository, gateway, {
        now,
      });
      await dispatcher.recover(fixture.scope);
      enqueueUser(
        fixture,
        repository,
        threadId,
        "steer-head",
        710,
        "queued payload",
      );
      const drafts = new ConversationDraftRepository(fixture.database);
      const empty = drafts.get(fixture.scope, threadId);
      const currentDraft = drafts.save(fixture.scope, threadId, {
        text: "keep this draft",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: empty.revision,
        now: 712,
      });
      const expectedThreadRevision = revision(fixture, threadId);

      const result = await dispatcher.steerUserInput(
        fixture.scope,
        threadId,
        "steer-head",
        {
          mutationId: "queued-steer-operation",
          expectedThreadRevision,
        },
      );

      expect(result.status).toBe("accepted");
      expect(gateway.steered).toEqual([
        expect.objectContaining({
          applicationOperationId: "queued-steer-operation",
          mutationId: "queued-steer-operation",
          target: { kind: "turn", turnId: "active-turn-1" },
          text: "queued payload",
          contextExcerpts: [],
        }),
      ]);
      expect(
        repository.get(fixture.scope, threadId, "steer-head"),
      ).toMatchObject({
        state: "accepted",
        deliveryMode: null,
      });
      expect(drafts.get(fixture.scope, threadId)).toEqual(currentDraft);
      const completion = new SubmissionCompletionRepository(fixture.database);
      expect(
        completion.get(fixture.scope, threadId, "queued-steer-operation")
          .operationId,
      ).toBe("queued-steer-operation");
      expect(() =>
        completion.get(fixture.scope, threadId, "operation-steer-head"),
      ).toThrow("not found");
      expect(
        events.some(({ event }) =>
          event.items.some(
            (item) =>
              item.id === "steer-head" &&
              item.state === "dispatching" &&
              item.deliveryMode === "steer",
          ),
        ),
      ).toBe(true);
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("restores a queued Steer after proven local rejection", async () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      gateway.steerBehaviors.push(
        new BackendError({
          category: "invalid_state",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "turn changed",
        }),
      );
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 800 },
      });
      await dispatcher.recover(fixture.scope);
      enqueueUser(fixture, repository, threadId, "restore-head", 810);
      const expectedThreadRevision = revision(fixture, threadId);

      await expect(
        dispatcher.steerUserInput(fixture.scope, threadId, "restore-head", {
          mutationId: "restore-steer-operation",
          expectedThreadRevision,
        }),
      ).rejects.toThrow("turn changed");

      expect(
        repository.get(fixture.scope, threadId, "restore-head"),
      ).toMatchObject({
        state: "pending",
        deliveryMode: null,
      });
      expect(
        new ConversationOperationRepository(fixture.database).findSteer(
          fixture.scope,
          "restore-steer-operation",
        ),
      ).toBeUndefined();
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("restores a prepared queued Steer when the pre-provider target recheck fails", async () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      gateway.steerTargetBehaviors.push(
        { kind: "turn", turnId: "active-turn-1" },
        new Error("target recheck failed"),
      );
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 850 },
      });
      await dispatcher.recover(fixture.scope);
      enqueueUser(fixture, repository, threadId, "target-recheck", 860);

      await expect(
        dispatcher.steerUserInput(fixture.scope, threadId, "target-recheck", {
          mutationId: "target-recheck-operation",
          expectedThreadRevision: revision(fixture, threadId),
        }),
      ).rejects.toThrow("target recheck failed");

      expect(
        repository.get(fixture.scope, threadId, "target-recheck"),
      ).toMatchObject({
        state: "pending",
        deliveryMode: null,
      });
      expect(
        new ConversationOperationRepository(fixture.database).findSteer(
          fixture.scope,
          "target-recheck-operation",
        ),
      ).toBeUndefined();
      expect(gateway.steered).toEqual([]);
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("restores a prepared queued Steer when marking submission start fails", async () => {
    const fixture = createFixture();
    const markStarted = vi
      .spyOn(
        ConversationOperationRepository.prototype,
        "markSteerSubmissionStarted",
      )
      .mockImplementationOnce(() => {
        throw new Error("mark start failed");
      });
    try {
      const [threadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 880 },
      });
      await dispatcher.recover(fixture.scope);
      enqueueUser(fixture, repository, threadId, "mark-start", 890);

      await expect(
        dispatcher.steerUserInput(fixture.scope, threadId, "mark-start", {
          mutationId: "mark-start-operation",
          expectedThreadRevision: revision(fixture, threadId),
        }),
      ).rejects.toThrow("mark start failed");

      expect(
        repository.get(fixture.scope, threadId, "mark-start"),
      ).toMatchObject({
        state: "pending",
        deliveryMode: null,
      });
      expect(
        new ConversationOperationRepository(fixture.database).findSteer(
          fixture.scope,
          "mark-start-operation",
        ),
      ).toBeUndefined();
      expect(gateway.steered).toEqual([]);
      await dispatcher.close();
    } finally {
      markStarted.mockRestore();
      fixture.database.close();
    }
  });

  it("reconciles an uncertain queued Steer without a second provider call", async () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      gateway.steerBehaviors.push(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "response lost",
        }),
      );
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 900 },
      });
      await dispatcher.recover(fixture.scope);
      enqueueUserWithAttachment(
        fixture,
        repository,
        threadId,
        "uncertain-steer",
        910,
      );
      const expectedThreadRevision = revision(fixture, threadId);

      await expect(
        dispatcher.steerUserInput(fixture.scope, threadId, "uncertain-steer", {
          mutationId: "uncertain-steer-operation",
          expectedThreadRevision,
        }),
      ).resolves.toMatchObject({ status: "recovery_required" });
      expect(
        repository.get(fixture.scope, threadId, "uncertain-steer"),
      ).toMatchObject({
        state: "uncertain",
        deliveryMode: "steer",
      });
      gateway.reconciliationBehaviors.push({ status: "accepted" });

      await expect(
        dispatcher.steerUserInput(fixture.scope, threadId, "uncertain-steer", {
          mutationId: "uncertain-steer-operation",
          expectedThreadRevision,
        }),
      ).resolves.toMatchObject({ status: "accepted" });
      expect(gateway.steered).toHaveLength(1);
      expect(gateway.steered[0]?.attachments).toHaveLength(1);
      expect(
        repository.get(fixture.scope, threadId, "uncertain-steer").state,
      ).toBe("accepted");
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("accepts a queued Steer with immutable attachment links", async () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 930 },
      });
      await dispatcher.recover(fixture.scope);
      enqueueUserWithAttachment(
        fixture,
        repository,
        threadId,
        "attachment-steer",
        940,
      );

      await expect(
        dispatcher.steerUserInput(fixture.scope, threadId, "attachment-steer", {
          mutationId: "attachment-steer-operation",
          expectedThreadRevision: revision(fixture, threadId),
        }),
      ).resolves.toMatchObject({ status: "accepted" });
      expect(gateway.steered[0]?.attachments).toEqual([
        expect.objectContaining({
          sha256: "a".repeat(64),
          agentPath: expect.stringContaining("/staged/"),
        }),
      ]);
      expect(
        new SubmissionCompletionRepository(fixture.database).find(
          fixture.scope,
          threadId,
          "attachment-steer-operation",
        ),
      ).toMatchObject({ backendCorrelation: "attachment-steer-operation" });
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("keeps a Pi-enqueued Steer dispatching until live materialization", async () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      gateway.steerBehaviors.push({
        status: "pending_materialization",
        reconciliationToken: "live-observed-steer-operation",
        completionCorrelation: "live-observed-steer-operation",
        backendTurnId: "active-turn-1",
      });
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 950 },
      });
      await dispatcher.recover(fixture.scope);
      enqueueUser(fixture, repository, threadId, "live-observed-steer", 960);
      const drafts = new ConversationDraftRepository(fixture.database);
      const before = drafts.get(fixture.scope, threadId);
      const currentDraft = drafts.save(fixture.scope, threadId, {
        text: "keep this live-observation draft",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: before.revision,
        now: 962,
      });
      const expectedThreadRevision = revision(fixture, threadId);

      await expect(
        dispatcher.steerUserInput(
          fixture.scope,
          threadId,
          "live-observed-steer",
          {
            mutationId: "live-observed-steer-operation",
            expectedThreadRevision,
          },
        ),
      ).resolves.toMatchObject({ status: "pending_materialization" });
      expect(
        repository.get(fixture.scope, threadId, "live-observed-steer"),
      ).toMatchObject({ state: "dispatching", deliveryMode: "steer" });
      expect(
        new ConversationOperationRepository(fixture.database).getSteer(
          fixture.scope,
          "live-observed-steer-operation",
        ),
      ).toMatchObject({ state: "pending_materialization" });
      await expect(
        dispatcher.observeAuthoritativeSubmission(
          fixture.scope,
          threadId,
          "live-observed-steer-operation",
        ),
      ).resolves.toBe(true);

      expect(
        repository.get(fixture.scope, threadId, "live-observed-steer"),
      ).toMatchObject({ state: "accepted", deliveryMode: null });
      expect(drafts.get(fixture.scope, threadId)).toEqual(currentDraft);
      const operations = new ConversationOperationRepository(fixture.database);
      expect(
        operations.getSteer(fixture.scope, "live-observed-steer-operation"),
      ).toMatchObject({ source: "queued_input", state: "accepted" });
      const completions = new SubmissionCompletionRepository(fixture.database);
      expect(
        completions.find(
          fixture.scope,
          threadId,
          "live-observed-steer-operation",
        ),
      ).toMatchObject({
        backendCorrelation: "live-observed-steer-operation",
      });
      await expect(
        dispatcher.observeAuthoritativeSubmission(
          fixture.scope,
          threadId,
          "live-observed-steer-operation",
        ),
      ).resolves.toBe(false);
      expect(
        fixture.database
          .prepare(
            `
              SELECT count(*) AS count
              FROM submission_completion_observations
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND application_thread_id = ? AND operation_id = ?
            `,
          )
          .get(
            fixture.scope.tenantId,
            fixture.scope.principalId,
            threadId,
            "live-observed-steer-operation",
          ),
      ).toEqual({ count: 1 });
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("restores a prepared queued Steer on startup without provider reconciliation", async () => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      enqueueUser(fixture, repository, threadId, "prepared-steer", 1_010);
      const expectedThreadRevision = revision(fixture, threadId);
      const reservation = repository.reserveHeadForSteer(
        fixture.scope,
        threadId,
        "prepared-steer",
        {
          steerOperationId: "prepared-steer-operation",
          expectedThreadRevision,
          now: 1_020,
        },
      );
      const operations = new ConversationOperationRepository(fixture.database);
      operations.prepareQueuedInputSteer(fixture.scope, threadId, {
        mutationId: "prepared-steer-operation",
        queuedInputId: "prepared-steer",
        text: reservation.item.text,
        contextExcerpts: reservation.item.contextExcerpts,
        attachmentIds: reservation.item.attachments.map(({ id }) => id),
        taskContexts: reservation.item.taskContexts,
        expectedThreadRevision,
        priorQueueState: reservation.priorState,
        priorNextAttemptAt: reservation.priorNextAttemptAt,
        priorDiagnostic: reservation.priorDiagnostic,
        now: 1_020,
      });
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 1_030 },
      });

      await dispatcher.recover(fixture.scope);

      expect(
        repository.get(fixture.scope, threadId, "prepared-steer"),
      ).toMatchObject({
        state: "pending",
        deliveryMode: null,
      });
      expect(
        operations.findSteer(fixture.scope, "prepared-steer-operation"),
      ).toBeUndefined();
      expect(gateway.reconciled).toEqual([]);
      expect(gateway.steered).toEqual([]);
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it.each([
    ["turn", "not_accepted"],
    ["turn", "unresolved"],
    ["conversation", "unresolved"],
    ["conversation", "error"],
    ["conversation", "failed_unknown_restore"],
    ["conversation", "failed_unknown_ack"],
    ["conversation", "failed_unknown_recover"],
    ["conversation", "failed_unknown_late_proof"],
    ["turn", "failed_unknown"],
  ] as const)("recovers pending %s Steer after %s reconciliation without repeating it", async (kind, outcome) => {
    const fixture = createFixture();
    try {
      const [threadId] = fixture.threadIds;
      const repository = new QueuedInputRepository(fixture.database);
      enqueueUser(fixture, repository, threadId, "pending-steer", 1_040);
      const expectedThreadRevision = revision(fixture, threadId);
      const reservation = repository.reserveHeadForSteer(
        fixture.scope,
        threadId,
        "pending-steer",
        {
          steerOperationId: "pending-steer-operation",
          expectedThreadRevision,
          now: 1_050,
        },
      );
      const operations = new ConversationOperationRepository(fixture.database);
      operations.prepareQueuedInputSteer(fixture.scope, threadId, {
        mutationId: "pending-steer-operation",
        queuedInputId: "pending-steer",
        text: reservation.item.text,
        contextExcerpts: reservation.item.contextExcerpts,
        attachmentIds: reservation.item.attachments.map(({ id }) => id),
        taskContexts: reservation.item.taskContexts,
        expectedThreadRevision,
        priorQueueState: reservation.priorState,
        priorNextAttemptAt: reservation.priorNextAttemptAt,
        priorDiagnostic: reservation.priorDiagnostic,
        now: 1_050,
      });
      operations.markSteerSubmissionStarted(
        fixture.scope,
        "pending-steer-operation",
        kind === "turn" ? { kind, turnId: "active-turn-1" } : { kind },
      );
      operations.markSteerPendingMaterialization(
        fixture.scope,
        "pending-steer-operation",
        1_051,
      );
      const gateway = new FakeGateway();
      gateway.authoritativelySettled = false;
      gateway.reconciliationBehaviors.push(
        outcome === "error" ? new Error("owner unavailable")
          : outcome === "not_accepted" ? { status: "not_accepted", retryable: true }
          : outcome.startsWith("failed_unknown") && outcome !== "failed_unknown_recover" ? { status: "failed_unknown", diagnostic: { text: "The original delivery tracker ended." } }
          : { status: "unresolved", diagnostic: { text: "Native consumption is unknown" } },
      );
      const { dispatcher } = createDispatcher(repository, gateway, {
        now: { value: 1_060 },
      });

      await dispatcher.recover(fixture.scope);

      expect(gateway.reconciled).toEqual([
        {
          applicationOperationId: "pending-steer-operation",
          reconciliationToken: "pending-steer-operation",
        },
      ]);
      expect(gateway.steered).toEqual([]);
      expect(gateway.submitted).toEqual([]);
      if (outcome === "failed_unknown_recover") {
        expect(operations.getSteer(fixture.scope, "pending-steer-operation").state).toBe("uncertain");
        expect(operations.hasBlockingThreadOperation(fixture.scope, threadId)).toBe(true);
        gateway.reconciliationBehaviors.push({ status: "failed_unknown", diagnostic: { text: "The original delivery tracker ended." } });
        await expect(dispatcher.steerUserInput(fixture.scope, threadId, "pending-steer", {
          mutationId: "pending-steer-operation", expectedThreadRevision,
        })).rejects.toThrow("Delivery outcome is unknown");
      }
      if (outcome === "not_accepted") {
        expect(repository.get(fixture.scope, threadId, "pending-steer")).toMatchObject({
          state: "pending", deliveryMode: null,
        });
        expect(operations.findSteer(fixture.scope, "pending-steer-operation")).toBeUndefined();
      } else if (kind === "conversation" && outcome.startsWith("failed_unknown")) {
        expect(repository.get(fixture.scope, threadId, "pending-steer")).toMatchObject({
          state: "failed", deliveryMode: null, retryCount: 0,
          diagnostic: expect.stringContaining("Delivery outcome is unknown"),
        });
        expect(operations.getSteer(fixture.scope, "pending-steer-operation")).toMatchObject({
          state: "failed_unknown", failureDiagnostic: expect.stringContaining("may already have received"),
        });
        expect(operations.hasBlockingThreadOperation(fixture.scope, threadId)).toBe(false);
        expect(() => operations.failSteerUnknown({ ...fixture.scope, principalId: "another-principal" },
          "pending-steer-operation", "unknown", 1061)).toThrow();
        await expect(dispatcher.steerUserInput(fixture.scope, threadId, "pending-steer", {
          mutationId: "pending-steer-operation", expectedThreadRevision,
        })).rejects.toThrow("Delivery outcome is unknown");
        expect(new SubmissionCompletionRepository(fixture.database).find(fixture.scope, threadId, "pending-steer-operation")).toBeUndefined();
        if (outcome === "failed_unknown_late_proof") {
          await expect(dispatcher.observeAuthoritativeSubmission(fixture.scope, threadId, "pending-steer-operation"))
            .resolves.toBe(true);
          expect(repository.get(fixture.scope, threadId, "pending-steer")).toMatchObject({ state: "accepted", diagnostic: null });
          expect(operations.getSteer(fixture.scope, "pending-steer-operation")).toMatchObject({ state: "accepted" });
          expect(operations.getSteer(fixture.scope, "pending-steer-operation").failureDiagnostic).toBeUndefined();
          await expect(dispatcher.observeAuthoritativeSubmission(fixture.scope, threadId, "pending-steer-operation"))
            .resolves.toBe(false);
        } else if (outcome !== "failed_unknown_ack") {
          const draft = new ConversationDraftRepository(fixture.database).get(fixture.scope, threadId);
          await expect(dispatcher.restoreUserInput(fixture.scope, threadId, "pending-steer", {
            mutationId: "restore-unknown-steer", expectedThreadRevision: revision(fixture, threadId),
            expectedDraftRevision: draft.revision, now: 1062,
          })).resolves.toMatchObject({ item: { state: "cancelled" }, draft: { text: reservation.item.text }, queue: [] });
        } else {
          await expect(dispatcher.acknowledgeFailure(fixture.scope, threadId, "pending-steer", 1062))
            .resolves.toMatchObject({ state: "failed", failureAcknowledgedAt: 1062 });
          expect(repository.listActiveHeads(fixture.scope)).toEqual([]);
        }
        if (outcome !== "failed_unknown_late_proof") {
          await expect(dispatcher.observeAuthoritativeSubmission(fixture.scope, threadId, "pending-steer-operation"))
            .resolves.toBe(false);
          expect(operations.getSteer(fixture.scope, "pending-steer-operation").state).toBe("failed_unknown");
        }
        expect(gateway.steered).toEqual([]);
        expect(gateway.submitted).toEqual([]);
      } else {
        const expectedState = kind === "conversation" ? "uncertain" : "dispatching";
        expect(repository.get(fixture.scope, threadId, "pending-steer")).toMatchObject({
          state: expectedState, deliveryMode: "steer",
        });
        expect(operations.getSteer(fixture.scope, "pending-steer-operation").state)
          .toBe(kind === "conversation" ? "uncertain" : "pending_materialization");
        if (kind === "conversation") {
          expect(operations.findUncertainThreadOperation(fixture.scope, threadId))
            .toMatchObject({ mutationId: "pending-steer-operation" });
        }
        await expect(dispatcher.observeAuthoritativeSubmission(fixture.scope, threadId, "pending-steer-operation"))
          .resolves.toBe(true);
        expect(repository.get(fixture.scope, threadId, "pending-steer").state).toBe("accepted");
        expect(operations.getSteer(fixture.scope, "pending-steer-operation").state).toBe("accepted");
        expect(gateway.steered).toEqual([]);
        expect(gateway.submitted).toEqual([]);
      }
      await dispatcher.close();
    } finally {
      fixture.database.close();
    }
  });

  it("caps active queue state at the normalized event payload limit", () => {
    const fixture = createFixture();
    try {
      const repository = new QueuedInputRepository(fixture.database);
      const [threadId] = fixture.threadIds;
      for (let index = 0; index < MAXIMUM_ACTIVE_QUEUED_INPUTS; index += 1) {
        enqueue(
          fixture,
          repository,
          threadId,
          `capacity-${index}`,
          500 + index,
        );
      }
      expect(repository.listActiveHeads(fixture.scope)).toHaveLength(1);
      expect(() =>
        enqueue(fixture, repository, threadId, "over-capacity", 2_000),
      ).toThrow("active-item limit");
    } finally {
      fixture.database.close();
    }
  });
});
