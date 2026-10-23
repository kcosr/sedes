import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_FAILURE_RETRY_DELAY_MS } from "../../src/server/backends/model-failure-retry.js";
import type { ConversationSubmissionSource } from "../../src/server/backends/contracts.js";
import { createAutomaticModelRetryRuntime } from "../../src/server/conversations/automatic-model-retry-runtime.js";
import { AUTOMATIC_MODEL_RETRY_TEXT, type AutomaticModelRetryCompletion } from "../../src/server/conversations/automatic-model-retry-service.js";
import { applicationTurnIdForBackendTurn, type ProjectedConversationTimeline } from "../../src/server/conversations/conversation-projector.js";
import type { ConversationActor } from "../../src/server/conversations/conversation-actor.js";
import type { ConversationActorManager } from "../../src/server/conversations/conversation-actor-manager.js";
import type { InteractionBroker } from "../../src/server/conversations/interaction-broker.js";
import type { AcquiredThreadRuntime } from "../../src/server/events/thread-runtime-coordinator.js";
import { projectQueuedInputPresentation } from "../../src/server/conversations/queued-input-projection.js";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository, type QueuedInputRecord } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { ThreadCompletionCallbackRepository } from "../../src/server/db/repositories/thread-completion-callback-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import type { BackendCapabilityDocument } from "../../src/shared/protocol/backend.js";
import { insertPreProjectWorkspace, savedAgentDatabase } from "../support/saved-agent-fixture.js";

const fixtures: { close(): Promise<void> }[] = [];

function fixture(options: { source?: "user" | "automation" | "agent_control"; firstSend?: boolean; callback?: boolean } = {}) {
  const current = savedAgentDatabase(125);
  const inventory = new InventoryRepository(current.database);
  const environment = inventory.getLocalEnvironment(current.scope);
  const workspace = insertPreProjectWorkspace(current.database, current.scope, {
    environmentId: environment.id, canonicalPath: "/tmp/automatic-retry-runtime", displayName: "Retry runtime",
    available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 110,
  });
  applyDatabaseMigrations(current.database, backendNormalizedMigrations);
  const profile = current.database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
  const bindings = new ConversationBindingRepository(current.database);
  const queue = new QueuedInputRepository(current.database);
  const completions = new SubmissionCompletionRepository(current.database);
  const operations = new ConversationOperationRepository(current.database);
  const callbacks = new ThreadCompletionCallbackRepository(current.database);
  const states = new Map<string, { timeline: ProjectedConversationTimeline; owner: string; readOnly: boolean }>();
  const revision = (threadId: string) => inventory.getThread(current.scope, threadId).thread.revision;
  const createThread = () => bindings.createUnboundThread(current.scope, {
    workspaceId: workspace.id, connectionProfileId: profile.id, title: "Original failed request", initialText: "Unsent draft", now: Date.now(),
  }).id;

  function automationSource(threadId: string, mutationId: string) {
    const automation = new AutomationRepository(current.database);
    const automationId = randomUUID();
    const automationRunId = randomUUID();
    const claimToken = randomUUID();
    automation.createDefinition(current.scope, {
      id: automationId, anchorThreadId: threadId, name: "Restricted automation", prompt: "Original request",
      precheck: null, runMode: "same_thread", enabled: true,
      schedule: { kind: "date_time", runAt: Date.now() + 60_000 }, misfirePolicy: "coalesce",
      nextRunAt: Date.now() + 60_000, now: Date.now(),
    });
    automation.createManualRun(current.scope, automationId, {
      runId: automationRunId, occurrenceKey: randomUUID(), scheduledFor: Date.now(), claimToken,
      leaseExpiresAt: Date.now() + 60_000, dispatchMutationId: mutationId, now: Date.now(),
    });
    automation.checkRunAdmission(current.scope, automationId, automationRunId, { claimToken, dispatch: true, now: Date.now() });
    return { kind: "automation" as const, automationId, automationRunId, claimToken };
  }

  function failAccepted(threadId: string, operationId: string, backendTurnId: string = randomUUID()): AutomaticModelRetryCompletion {
    const binding = bindings.getBinding(current.scope, threadId)!;
    const turnId = applicationTurnIdForBackendTurn({ backendInstanceId: binding.backendInstanceId,
      sourceApplicationThreadId: threadId, backendTurnId });
    const completion = { backendTurnId, completionIdentity: `${backendTurnId}:failed`, outcome: "failed", provenance: "live" } as const;
    completions.observeCompletion(current.scope, threadId, operationId, {
      completionIdentity: completion.completionIdentity, observedAt: Date.now(), createAttention: true,
      finalized: { applicationTurnId: turnId, outcome: "failed", result: { text: "Capacity exhausted" }, classifiedResult: null },
    });
    setFailedTimeline(threadId, turnId);
    return completion;
  }

  function setFailedTimeline(threadId: string, turnId: string) {
    states.set(threadId, { owner: states.get(threadId)?.owner ?? randomUUID(), readOnly: false,
      timeline: { generation: randomUUID(), runState: "failed", orderedTurnIds: [turnId],
        turnsById: { [turnId]: { id: turnId, revision: 1, status: "failed", orderedItemIds: [] } }, itemsById: {} } });
  }

  function failUnsubmitted(threadId: string): AutomaticModelRetryCompletion {
    const binding = bindings.getBinding(current.scope, threadId)!;
    const backendTurnId = randomUUID();
    const turnId = applicationTurnIdForBackendTurn({ backendInstanceId: binding.backendInstanceId,
      sourceApplicationThreadId: threadId, backendTurnId });
    setFailedTimeline(threadId, turnId);
    return { backendTurnId, completionIdentity: `${backendTurnId}:failed`, outcome: "failed", provenance: "live",
      nativeRecovery: true };
  }

  function acceptQueued(threadId: string, item: QueuedInputRecord) {
    expect(queue.claimHead(current.scope, threadId, "exact-native-head", Date.now())?.id).toBe(item.id);
    return queue.markAccepted(current.scope, threadId, item.id, {
      expectedState: "dispatching", acceptedAt: Date.now(), backendCorrelation: item.mutationId,
    });
  }

  function seedFailed(firstSend = false, source: "user" | "automation" | "agent_control" = "user", callback = false) {
    const threadId = createThread();
    const operationId = randomUUID();
    const automation = source === "automation" ? automationSource(threadId, operationId) : undefined;
    const callerThreadId = source === "agent_control" ? createThread() : undefined;
    if (callerThreadId) bindings.bindDiscoveredConversation(current.scope, callerThreadId, { backendConversationId: randomUUID(), now: Date.now() });
    const completionCallback = callback && callerThreadId ? { id: randomUUID(), callerThreadId } : undefined;
    const executionSource: ConversationSubmissionSource = automation
      ? { kind: "automation", automationId: automation.automationId, automationRunId: automation.automationRunId }
      : { kind: "user" };
    const nativeId = randomUUID();
    if (firstSend) {
      const creation = new ConversationCreationRepository(current.database);
      const attemptId = randomUUID();
      const base = { attemptId, mutationId: operationId, expectedThreadRevision: revision(threadId),
        creationKind: "first_input" as const, initialInputText: "Original request", initialAttachmentIds: [] as const,
        backendCreationCorrelation: randomUUID(), now: Date.now() };
      creation.prepare(current.scope, threadId, automation
        ? { ...base, sourceKind: "automation", sourceAutomationId: automation.automationId, sourceAutomationRunId: automation.automationRunId }
        : callerThreadId ? { ...base, sourceKind: "agent_control", initiatingAgentThreadId: callerThreadId,
          ...(completionCallback ? { completionCallback } : {}) }
          : { ...base, sourceKind: "direct_input" });
      creation.markExternalCallStarted(current.scope, threadId, attemptId, Date.now());
      creation.recordConversationIdentified(current.scope, threadId, attemptId, {
        backendConversationId: nativeId, opaqueBindingDetail: "native-fixture", now: Date.now(),
      });
      creation.markFirstSubmissionStarted(current.scope, threadId, attemptId, {
        reconciliationToken: operationId, retryAnchor: "first-send-head", now: Date.now(),
      });
      creation.markAcceptedUnpersisted(current.scope, threadId, attemptId, {
        expected: "first_submission_started", acceptedAt: Date.now(), backendCorrelation: operationId,
      });
      bindings.bindCreatedConversation(current.scope, threadId, { attemptId, backendConversationId: nativeId, acceptedAt: Date.now() });
      completions.recordAccepted(current.scope, threadId, { operationId, backendCorrelation: operationId, acceptedAt: Date.now() });
    } else {
      bindings.bindDiscoveredConversation(current.scope, threadId, { backendConversationId: nativeId, now: Date.now() });
      const item = queue.enqueue(current.scope, threadId, {
        mutationId: operationId, text: "Original request", contextExcerpts: [], attachmentIds: [], taskReferences: [], now: Date.now(),
        source: automation ?? (callerThreadId ? { kind: "agent_control", expectedThreadRevision: revision(threadId), initiatingAgentThreadId: callerThreadId,
          ...(completionCallback ? { completionCallback } : {}) }
          : { kind: "direct_input", expectedThreadRevision: revision(threadId), resolvedDeliveryMode: "submit" }),
      }).item;
      acceptQueued(threadId, item);
    }
    return { threadId, operationId, executionSource, callerThreadId, callbackId: completionCallback?.id,
      completion: failAccepted(threadId, operationId) };
  }

  const original = seedFailed(options.firstSend, options.source, options.callback);
  const capabilities: BackendCapabilityDocument = { revision: "retry-runtime", actions: [], deliveryModes: ["submit"],
    steerTarget: null, composerAttachments: { fileStaging: false, nativeImage: false }, nonblockingQuestions: false,
    providerOutputArtifacts: { nativeImage: false }, supportsHistory: true,
    branching: { availability: "unavailable", reason: { text: "Not used by retry admission" } }, interactionKinds: [],
    usageAccounting: "unsupported", turnThroughput: "unsupported", usageSections: [], effectiveSettings: {} };
  const observeInputRuntime = vi.fn<ConversationActorManager["observeInputRuntime"]>((scope, threadId) => {
    if (scope.tenantId !== current.scope.tenantId || scope.principalId !== current.scope.principalId) return undefined;
    const state = states.get(threadId);
    return state ? { generation: state.timeline.generation, ownerGeneration: state.owner,
      authoritative: true, settled: true, runState: state.timeline.runState, reestablishing: false,
      blockingInteractionIds: [], backendCapabilities: capabilities,
    } : undefined;
  });
  const release = vi.fn();
  const recoverModelFailure = vi.fn<ConversationActor["recoverModelFailure"]>(async input => {
    expect(input.isCurrent()).toBe(true);
    input.onAdmitted();
    return "accepted";
  });
  function acquisition(threadId: string): AcquiredThreadRuntime {
    const state = states.get(threadId)!;
    return { actor: { get timeline() { return state.timeline; }, get readOnly() { return state.readOnly; },
      recoverModelFailure } as unknown as ConversationActor,
      release, hub: {} as AcquiredThreadRuntime["hub"], publishAuthoritativeReplacement: vi.fn() };
  }
  const acquire = vi.fn(async (_scope: RequestScope, threadId: string) => acquisition(threadId));
  const listPending = vi.fn<InteractionBroker["listPending"]>(() => []);
  const dispatchAdmitted = vi.fn(async (_scope: RequestScope, _threadId: string) => undefined);
  const onPendingChanged = vi.fn();
  const service = createAutomaticModelRetryRuntime({ database: current.database, bindings, inventory, queueRepository: queue,
    operations, actors: { observeInputRuntime }, runtimes: { acquire }, interactions: { listPending },
    queueDispatcher: { dispatchAdmitted }, onPendingChanged });
  const result = { ...current, ...original, queue, completions, bindings, inventory, operations, callbacks, states,
    service, observeInputRuntime, acquire, acquisition, release, listPending, dispatchAdmitted, onPendingChanged,
    seedFailed, failAccepted, failUnsubmitted, acceptQueued, revision, recoverModelFailure,
    async close() { await service.close(); current.database.close(); } };
  fixtures.push(result);
  return result;
}

describe("automatic retry runtime admission", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-22T03:00:00Z")); });
  afterEach(async () => { for (const item of fixtures.splice(0)) await item.close(); vi.useRealTimers(); });

  it("admits one new labeled Send after ten seconds and leaves the failed original intact", async () => {
    const f = fixture();
    const original = f.queue.findByMutationId(f.scope, f.threadId, f.operationId);
    const draft = f.inventory.getDraft(f.scope, f.threadId);
    f.dispatchAdmitted.mockImplementation(async () => { expect(f.service.isPending(f.scope, f.threadId)).toBe(false); });
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS - 1);
    expect(f.queue.list(f.scope, f.threadId)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const followUp = f.queue.list(f.scope, f.threadId)[1]!;
    expect(followUp).toMatchObject({ text: AUTOMATIC_MODEL_RETRY_TEXT, state: "pending", isUserInput: 0,
      resolvedDeliveryMode: "submit", inputOrigin: { kind: "automatic_retry" }, automaticRetryExecutionSource: { kind: "user" } });
    expect(f.queue.findByMutationId(f.scope, f.threadId, f.operationId)).toEqual(original);
    expect(f.completions.get(f.scope, f.threadId, f.operationId).completionOutcome).toBe("failed");
    expect(f.inventory.getDraft(f.scope, f.threadId)).toEqual(draft);
    expect(projectQueuedInputPresentation(followUp, f.revision(f.threadId), followUp.mutationId)).toMatchObject({
      origin: "automatic_retry", inputOrigin: { kind: "automatic_retry" },
    });
    expect(f.dispatchAdmitted).toHaveBeenCalledExactlyOnceWith(f.scope, f.threadId);
    expect(f.recoverModelFailure).not.toHaveBeenCalled();
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.queue.list(f.scope, f.threadId)).toHaveLength(2);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["submitted", "autonomous"] as const)("resumes a native goal after a failed %s turn without sending a follow-up", async source => {
    const f = fixture();
    const completion = source === "autonomous" ? f.failUnsubmitted(f.threadId) : { ...f.completion, nativeRecovery: true as const };
    const originalInputs = f.queue.list(f.scope, f.threadId);
    const originalDraft = f.inventory.getDraft(f.scope, f.threadId);
    if (source === "autonomous") {
      expect(f.database.prepare("SELECT 1 FROM submission_completion_observations WHERE last_completion_identity = ?")
        .get(completion.completionIdentity)).toBeUndefined();
    }
    f.service.onCompletion(f.scope, f.threadId, completion);
    expect(f.service.isPending(f.scope, f.threadId)).toBe(true);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS - 1);
    expect(f.recoverModelFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.recoverModelFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      backendTurnId: completion.backendTurnId,
      mutationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      isCurrent: expect.any(Function), onAdmitted: expect.any(Function),
    }));
    expect(f.queue.list(f.scope, f.threadId)).toEqual(originalInputs);
    expect(f.inventory.getDraft(f.scope, f.threadId)).toEqual(originalDraft);
    expect(f.dispatchAdmitted).not.toHaveBeenCalled();
    expect(f.service.isPending(f.scope, f.threadId)).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["uncertain", "rejected"] as const)("never falls back to a message or reattempts after %s native recovery", async result => {
    const f = fixture();
    f.recoverModelFailure.mockResolvedValue(result);
    const completion = f.failUnsubmitted(f.threadId);
    const originalInputs = f.queue.list(f.scope, f.threadId);
    f.service.onCompletion(f.scope, f.threadId, completion);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.recoverModelFailure).toHaveBeenCalledOnce();
    expect(f.service.isPending(f.scope, f.threadId)).toBe(false);
    f.service.onCompletion(f.scope, f.threadId, f.failUnsubmitted(f.threadId));
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.recoverModelFailure).toHaveBeenCalledOnce();
    expect(f.queue.list(f.scope, f.threadId)).toEqual(originalInputs);
    expect(f.dispatchAdmitted).not.toHaveBeenCalled();
  });

  it("rearms native goal recovery after a fully completed turn without a submitted input", async () => {
    const f = fixture();
    f.service.onCompletion(f.scope, f.threadId, f.failUnsubmitted(f.threadId));
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    const completed = f.failUnsubmitted(f.threadId);
    f.service.onCompletion(f.scope, f.threadId, { ...completed, outcome: "completed" });
    f.service.onCompletion(f.scope, f.threadId, f.failUnsubmitted(f.threadId));
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.recoverModelFailure).toHaveBeenCalledTimes(2);
    expect(f.queue.list(f.scope, f.threadId)).toHaveLength(1);
    expect(f.dispatchAdmitted).not.toHaveBeenCalled();
  });

  it.each(["newer_head", "queued_input", "interaction", "operation", "read_only", "cancelled", "replaced_owner"] as const)(
    "does not resume a native goal after %s invalidates its failed turn", async blocker => {
      const f = fixture();
      f.service.onCompletion(f.scope, f.threadId, f.failUnsubmitted(f.threadId));
      const state = f.states.get(f.threadId)!;
      if (blocker === "newer_head") {
        state.timeline = { ...state.timeline, orderedTurnIds: [...state.timeline.orderedTurnIds, "newer-turn"],
          turnsById: { ...state.timeline.turnsById, "newer-turn": { id: "newer-turn", revision: 1, status: "failed", orderedItemIds: [] } } };
      } else if (blocker === "queued_input") {
        f.queue.enqueue(f.scope, f.threadId, { mutationId: randomUUID(), text: "Newer user work", contextExcerpts: [], attachmentIds: [], taskReferences: [],
          source: { kind: "direct_input", expectedThreadRevision: f.revision(f.threadId), resolvedDeliveryMode: "submit" }, now: Date.now() });
      } else if (blocker === "interaction") f.listPending.mockReturnValue([{
        id: "approval", threadId: f.threadId, sourceLabel: { text: "Provider" }, openedAt: new Date().toISOString(),
        secret: false, destructive: false, cancellable: true, kind: "confirmation", title: { text: "Approve work?" }, message: { text: "An answer is required." },
      }]);
      else if (blocker === "operation") vi.spyOn(f.operations, "hasBlockingThreadOperation").mockReturnValue(true);
      else if (blocker === "read_only") state.readOnly = true;
      else if (blocker === "cancelled") f.service.cancel(f.scope, f.threadId);
      else f.acquire.mockImplementationOnce(async (_scope, threadId) => {
        f.states.get(threadId)!.owner = "replacement-owner";
        return f.acquisition(threadId);
      });
      await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
      expect(f.recoverModelFailure).not.toHaveBeenCalled();
      expect(f.dispatchAdmitted).not.toHaveBeenCalled();
      expect(f.queue.list(f.scope, f.threadId).filter(item => item.inputOrigin?.kind === "automatic_retry")).toEqual([]);
      expect(f.service.isPending(f.scope, f.threadId)).toBe(false);
    },
  );

  it.each(["user", "automation"] as const)("recovers the first %s send through durable creation provenance without a queued original", async source => {
    const f = fixture({ firstSend: true, source });
    expect(f.queue.list(f.scope, f.threadId)).toEqual([]);
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    const [followUp] = f.queue.list(f.scope, f.threadId);
    expect(followUp).toMatchObject({ text: AUTOMATIC_MODEL_RETRY_TEXT, automaticRetryExecutionSource: f.executionSource,
      triggerKind: "user", sourceAutomationId: null, sourceAutomationRunId: null });
    expect(f.dispatchAdmitted).toHaveBeenCalledExactlyOnceWith(f.scope, f.threadId);
  });

  it.each([
    { firstSend: false, callbackState: "registered" },
    { firstSend: true, callbackState: "registered" },
    { firstSend: false, callbackState: "materialized" },
    { firstSend: true, callbackState: "materialized" },
  ] as const)("leaves firstSend=$firstSend work with a $callbackState completion callback to its caller", async ({ firstSend, callbackState }) => {
    const f = fixture({ source: "agent_control", firstSend, callback: true });
    const targetInputs = f.queue.list(f.scope, f.threadId);
    expect(f.callbacks.get(f.scope, f.callbackId!)).toMatchObject({ state: "registered", targetOperationId: f.operationId });
    if (callbackState === "materialized") {
      f.queue.enqueue(f.scope, f.callerThreadId!, {
        mutationId: randomUUID(), text: "The requested work failed: Capacity exhausted", contextExcerpts: [], attachmentIds: [], taskReferences: [],
        source: { kind: "completion_callback", expectedThreadRevision: f.revision(f.callerThreadId!), callbackId: f.callbackId!,
          completionIdentity: f.completion.completionIdentity, sourceThreadLabel: { text: "Worker" },
          requestedDeliveryMode: "submit", resolvedDeliveryMode: "submit" }, now: Date.now(),
      });
    }
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    expect(f.service.isPending(f.scope, f.threadId)).toBe(false);
    expect(f.onPendingChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.callbacks.get(f.scope, f.callbackId!).state).toBe(callbackState);
    expect(f.completions.get(f.scope, f.threadId, f.operationId).completionOutcome).toBe("failed");
    expect(f.queue.list(f.scope, f.threadId)).toEqual(targetInputs);
    expect(f.dispatchAdmitted).not.toHaveBeenCalled();
    expect(f.service.isPending(f.scope, f.threadId)).toBe(false);
  });

  it("preserves callback ownership when a failed submitted turn is eligible for native goal recovery", async () => {
    const f = fixture({ source: "agent_control", callback: true });
    const originalInputs = f.queue.list(f.scope, f.threadId);
    f.service.onCompletion(f.scope, f.threadId, { ...f.completion, nativeRecovery: true });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.recoverModelFailure).not.toHaveBeenCalled();
    expect(f.dispatchAdmitted).not.toHaveBeenCalled();
    expect(f.queue.list(f.scope, f.threadId)).toEqual(originalInputs);
    expect(f.service.isPending(f.scope, f.threadId)).toBe(false);
  });

  it("excludes a callback on another accepted input correlated to the same failed turn", () => {
    const f = fixture();
    const caller = f.seedFailed();
    const correlatedOperation = randomUUID();
    f.completions.recordAccepted(f.scope, f.threadId, { operationId: correlatedOperation, acceptedAt: Date.now(), backendCorrelation: correlatedOperation });
    f.failAccepted(f.threadId, correlatedOperation, f.completion.backendTurnId);
    f.callbacks.register(f.scope, { callerThreadId: caller.threadId, targetThreadId: f.threadId,
      targetOperationId: correlatedOperation, registeredAt: Date.now() });
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    expect(f.service.isPending(f.scope, f.threadId)).toBe(false);
    expect(f.onPendingChanged).not.toHaveBeenCalled();
    expect(f.queue.list(f.scope, f.threadId)).toHaveLength(1);
  });

  it("rechecks a callback registered while the retry delay is pending", async () => {
    const f = fixture();
    const caller = f.seedFailed();
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    expect(f.service.isPending(f.scope, f.threadId)).toBe(true);
    f.callbacks.register(f.scope, { callerThreadId: caller.threadId, targetThreadId: f.threadId,
      targetOperationId: f.operationId, registeredAt: Date.now() });
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.service.isPending(f.scope, f.threadId)).toBe(false);
    expect(f.queue.list(f.scope, f.threadId)).toHaveLength(1);
    expect(f.dispatchAdmitted).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("still retries a fire-and-forget agent message when another thread has a completion callback", async () => {
    const f = fixture({ source: "agent_control" });
    const unrelated = f.seedFailed(false, "agent_control", true);
    expect(f.callbacks.get(f.scope, unrelated.callbackId!).state).toBe("registered");
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.queue.list(f.scope, f.threadId)[1]).toMatchObject({ text: AUTOMATIC_MODEL_RETRY_TEXT, inputOrigin: { kind: "automatic_retry" } });
    expect(f.dispatchAdmitted).toHaveBeenCalledExactlyOnceWith(f.scope, f.threadId);
  });

  it("keeps automation execution limits when a progressed automatic follow-up later fails", async () => {
    const f = fixture({ source: "automation" });
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    const firstRetry = f.queue.list(f.scope, f.threadId)[1]!;
    expect(firstRetry.automaticRetryExecutionSource).toEqual(f.executionSource);
    f.acceptQueued(f.threadId, firstRetry);
    const laterFailure = f.failAccepted(f.threadId, firstRetry.mutationId);
    f.service.onModelFeedback(f.scope, f.threadId, "successful-inference-before-next-failure", false);
    f.service.onCompletion(f.scope, f.threadId, laterFailure);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    const secondRetry = f.queue.list(f.scope, f.threadId)[2]!;
    expect(secondRetry).toMatchObject({ automaticRetryExecutionSource: f.executionSource,
      inputOrigin: { kind: "automatic_retry" }, triggerKind: "user", sourceAutomationId: null, sourceAutomationRunId: null });
    expect(f.dispatchAdmitted).toHaveBeenCalledTimes(2);
  });

  it.each(["newer_head", "queued_input", "interaction", "operation", "read_only"] as const)("refuses automatic admission with %s", async blocker => {
    const f = fixture();
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    if (blocker === "newer_head") {
      const state = f.states.get(f.threadId)!;
      state.timeline = { ...state.timeline, orderedTurnIds: [...state.timeline.orderedTurnIds, "newer-turn"],
        turnsById: { ...state.timeline.turnsById, "newer-turn": { id: "newer-turn", revision: 1, status: "failed", orderedItemIds: [] } } };
    } else if (blocker === "queued_input") {
      f.queue.enqueue(f.scope, f.threadId, { mutationId: randomUUID(), text: "Newer user work", contextExcerpts: [], attachmentIds: [], taskReferences: [],
        source: { kind: "direct_input", expectedThreadRevision: f.revision(f.threadId), resolvedDeliveryMode: "submit" }, now: Date.now() });
    } else if (blocker === "interaction") f.listPending.mockReturnValue([{
      id: "approval", threadId: f.threadId, sourceLabel: { text: "Provider" }, openedAt: new Date().toISOString(),
      secret: false, destructive: false, cancellable: true, kind: "confirmation", title: { text: "Approve work?" }, message: { text: "An answer is required." },
    }]);
    else if (blocker === "operation") vi.spyOn(f.operations, "hasBlockingThreadOperation").mockReturnValue(true);
    else f.states.get(f.threadId)!.readOnly = true;
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.queue.list(f.scope, f.threadId).filter(item => item.inputOrigin?.kind === "automatic_retry")).toEqual([]);
    expect(f.dispatchAdmitted).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.service.isPending(f.scope, f.threadId)).toBe(false);
  });

  it("rechecks ownership after runtime acquisition before touching the queue", async () => {
    const f = fixture();
    f.acquire.mockImplementationOnce(async (_scope, threadId) => {
      await Promise.resolve();
      f.states.get(threadId)!.owner = "replacement-owner";
      return f.acquisition(threadId);
    });
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.queue.list(f.scope, f.threadId)).toHaveLength(1);
    expect(f.dispatchAdmitted).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("cancels only the matching scope and thread when newer ordinary input arrives", async () => {
    const f = fixture();
    const other = f.seedFailed();
    f.service.onCompletion(f.scope, f.threadId, f.completion);
    f.service.onCompletion(f.scope, other.threadId, other.completion);
    const incoming = f.queue.enqueue(f.scope, f.threadId, { mutationId: randomUUID(), text: "A new user request",
      contextExcerpts: [], attachmentIds: [], taskReferences: [], now: Date.now(),
      source: { kind: "direct_input", expectedThreadRevision: f.revision(f.threadId), resolvedDeliveryMode: "submit" } }).item;
    f.service.onInputChanged({ ...f.scope, principalId: "foreign-owner" }, f.threadId, incoming);
    expect(f.service.isPending(f.scope, f.threadId)).toBe(true);
    f.service.onInputChanged(f.scope, f.threadId, incoming);
    expect(f.service.isPending(f.scope, f.threadId)).toBe(false);
    expect(f.service.isPending(f.scope, other.threadId)).toBe(true);
    await vi.advanceTimersByTimeAsync(MODEL_FAILURE_RETRY_DELAY_MS);
    expect(f.dispatchAdmitted).toHaveBeenCalledExactlyOnceWith(f.scope, other.threadId);
    expect(f.queue.list(f.scope, f.threadId).filter(item => item.inputOrigin?.kind === "automatic_retry")).toEqual([]);
  });
});
