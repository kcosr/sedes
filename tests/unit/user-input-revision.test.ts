import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { PrincipalAgentToolClientRepository } from "../../src/server/db/repositories/principal-agent-tool-client-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { ThreadCompletionCallbackRepository } from "../../src/server/db/repositories/thread-completion-callback-repository.js";
import { UserInputRevisionRepository } from "../../src/server/db/repositories/user-input-revision-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

function fixture(version?: number) {
  const { database, scope } = savedAgentDatabase(version);
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    id: randomUUID(), environmentId: environment.id, canonicalPath: "/tmp/user-input-revision",
    displayName: "Voice freshness", project: { kind: "new", name: "Voice freshness" },
    available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 200,
  });
  const profile = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
  const bindings = new ConversationBindingRepository(database);
  const createThread = (bound = true) => {
    const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId: profile.id, title: "Freshness", now: 201 });
    if (bound) bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: randomUUID(), now: 202 });
    return thread.id;
  };
  const threadId = createThread();
  const queue = new QueuedInputRepository(database);
  const revisions = new UserInputRevisionRepository(database);
  const revision = () => inventory.getThread(scope, threadId).thread.revision;
  const enqueue = (patch: Partial<Parameters<QueuedInputRepository["enqueue"]>[2]> = {}) => queue.enqueue(scope, threadId, {
    mutationId: randomUUID(), text: "A new message", contextExcerpts: [], attachmentIds: [], taskReferences: [],
    source: { kind: "direct_input", resolvedDeliveryMode: "queue", expectedThreadRevision: revision() }, now: 203, ...patch,
  });
  return { database, scope, environment, threadId, createThread, queue, revisions, revision, enqueue };
}

describe("user input admission revision", () => {
  it.each(["composer", "direct_input", "question_response", "page_response"] as const)("counts a fresh %s input once and rolls back with its admission", kind => {
    const f = fixture();
    try {
      const text = "A new message";
      const draft = new ConversationDraftRepository(f.database).save(f.scope, f.threadId, {
        text, contextExcerpts: [], attachmentIds: [], taskReferenceIds: [], expectedRevision: 0, now: 202,
      });
      const source = kind === "composer" ? {
        kind, requestedDeliveryMode: "queue" as const, resolvedDeliveryMode: "queue" as const,
        expectedThreadRevision: f.revision(), expectedDraftRevision: draft.revision,
      } : kind === "question_response" ? {
        kind, resolvedDeliveryMode: "queue" as const, expectedThreadRevision: f.revision(),
        inputOrigin: { kind: "question_response" as const, requestId: "request", sourceItemId: "item",
          answers: [{ questionIndex: 0, question: "Where?", answer: "Here" }] },
      } : kind === "page_response" ? {
        kind, resolvedDeliveryMode: "queue" as const, expectedThreadRevision: f.revision(),
        inputOrigin: { kind: "page_response" as const, pageId: randomUUID(), revision: 1, title: "Review form" },
      } : { kind, resolvedDeliveryMode: "queue" as const, expectedThreadRevision: f.revision() };
      const request = { mutationId: randomUUID(), text, source };
      const admitted = f.enqueue(request);
      expect(admitted.item.isUserInput).toBe(1);
      expect(f.revisions.capture(f.scope, f.threadId, [])).toEqual({ userInputRevision: 1, superseded: true });
      expect(f.enqueue(request).replayed).toBe(true);
      expect(f.revisions.capture(f.scope, f.threadId, []).userInputRevision).toBe(1);
      expect(() => f.database.transaction(() => {
        f.enqueue();
        throw new Error("rollback_admission");
      })()).toThrow("rollback_admission");
      expect(f.revisions.capture(f.scope, f.threadId, []).userInputRevision).toBe(1);
    } finally { f.database.close(); }
  });

  it("counts first input preparation once, independently of backend acceptance", () => {
    const f = fixture();
    try {
      const id = f.createThread(false);
      const creations = new ConversationCreationRepository(f.database);
      const input = { attemptId: randomUUID(), mutationId: randomUUID(), expectedThreadRevision: 0,
        creationKind: "first_input" as const, sourceKind: "direct_input" as const, initialInputText: "First input",
        initialAttachmentIds: [] as const, backendCreationCorrelation: randomUUID(), now: 203 };
      creations.prepare(f.scope, id, input);
      expect(f.revisions.capture(f.scope, id, [])).toEqual({ userInputRevision: 1, superseded: false });
      creations.prepare(f.scope, id, input);
      expect(f.revisions.capture(f.scope, id, []).userInputRevision).toBe(1);
    } finally { f.database.close(); }
  });

  it("counts a composer first input once while preserving idempotency", () => {
    const f = fixture();
    try {
      const id = f.createThread(false);
      const drafts = new ConversationDraftRepository(f.database);
      const draft = drafts.save(f.scope, id, { text: "First composer input", contextExcerpts: [],
        attachmentIds: [], taskReferenceIds: [], expectedRevision: 0, now: 202 });
      const creations = new ConversationCreationRepository(f.database);
      const input = { attemptId: randomUUID(), mutationId: randomUUID(), expectedThreadRevision: 0,
        creationKind: "first_input" as const, sourceKind: "composer" as const, initialInputText: draft.text,
        initialAttachmentIds: [], initialContextExcerpts: [], initialTaskReferences: [], expectedDraftRevision: draft.revision,
        backendCreationCorrelation: randomUUID(), now: 203 };
      creations.prepare(f.scope, id, input);
      creations.prepare(f.scope, id, input);
      expect(f.revisions.capture(f.scope, id, [])).toEqual({ userInputRevision: 1, superseded: false });
    } finally { f.database.close(); }
  });

  it.each(["cancel", "restore"] as const)("does not advance the input revision on %s or make the withdrawn row supersede a response", action => {
    const f = fixture();
    try {
      const item = f.enqueue().item;
      const mutation = { mutationId: randomUUID(), expectedThreadRevision: f.revision(), now: 204 };
      if (action === "cancel") f.queue.cancelIdempotently(f.scope, f.threadId, item.id, mutation);
      else f.queue.restoreIdempotently(f.scope, f.threadId, item.id, { ...mutation, expectedDraftRevision: 0 });
      expect(f.revisions.capture(f.scope, f.threadId, [])).toEqual({ userInputRevision: 1, superseded: false });
    } finally { f.database.close(); }
  });

  it.each(["automation", "principal_client_control", "completion_callback"] as const)("excludes %s from both the revision and pending-input supersession", kind => {
    const f = fixture();
    try {
      const mutationId = randomUUID();
      const source = (() => {
        if (kind === "automation") {
          const automation = new AutomationRepository(f.database);
          const automationId = randomUUID(), automationRunId = randomUUID();
          automation.createDefinition(f.scope, { id: automationId, anchorThreadId: f.threadId, name: "Automation",
            prompt: "Automated work", precheck: null, runMode: "same_thread", enabled: true,
            schedule: { kind: "date_time", runAt: 10_000 }, misfirePolicy: "coalesce", nextRunAt: 10_000, now: 202 });
          automation.createManualRun(f.scope, automationId, { runId: automationRunId, occurrenceKey: randomUUID(),
            scheduledFor: 203, claimToken: randomUUID(), leaseExpiresAt: 10_000, dispatchMutationId: mutationId, now: 203 });
          return { kind, expectedThreadRevision: f.revision(), automationId, automationRunId };
        }
        if (kind === "principal_client_control") {
          const client = new PrincipalAgentToolClientRepository(f.database, { eligibleToolIds: new Set(["thread.send"]) }).create(f.scope, {
            id: randomUUID(), creationRequestId: randomUUID(), name: "Tool client", enabled: true,
            toolIds: ["thread.send"], defaultEnvironmentId: f.environment.id, allowedEnvironmentIds: [f.environment.id],
            credentialGeneration: 1, credentialVerifier: new Uint8Array(32).fill(7), now: 202,
          });
          return { kind, expectedThreadRevision: f.revision(), initiatingToolClientId: client.id };
        }
        const target = f.createThread(), targetOperationId = randomUUID(), completionIdentity = randomUUID();
        new ThreadCompletionCallbackRepository(f.database).register(f.scope, { id: mutationId, callerThreadId: f.threadId,
          targetThreadId: target, targetOperationId, registeredAt: 202 });
        const completions = new SubmissionCompletionRepository(f.database);
        completions.recordAccepted(f.scope, target, { operationId: targetOperationId, acceptedAt: 203, backendCorrelation: targetOperationId });
        completions.observeBackendCompletion(f.scope, target, { backendCorrelation: targetOperationId, applicationTurnId: "turn-callback",
          completionIdentity, outcome: "completed", result: { text: "Agent result" }, classifiedResult: null, observedAt: 204 });
        return { kind, expectedThreadRevision: f.revision(), callbackId: mutationId, completionIdentity,
          sourceThreadLabel: { text: "Freshness" }, requestedDeliveryMode: "queue" as const, resolvedDeliveryMode: "queue" as const };
      })();
      const item = f.enqueue({ mutationId, source }).item;
      expect(item.isUserInput).toBe(0);
      expect(f.revisions.capture(f.scope, f.threadId, [])).toEqual({ userInputRevision: 0, superseded: false });
    } finally { f.database.close(); }
  });

  it.each(["dispatching", "uncertain"] as const)("distinguishes %s steers by the completing turn's exact correlations", state => {
    const f = fixture();
    try {
      const item = f.enqueue().item;
      const operation = randomUUID();
      f.queue.reserveHeadForSteer(f.scope, f.threadId, item.id, { steerOperationId: operation, expectedThreadRevision: f.revision(), now: 204 });
      if (state === "uncertain") f.queue.markSteerUncertain(f.scope, f.threadId, item.id, { steerOperationId: operation, diagnostic: "Uncertain", now: 205 });
      expect(f.revisions.capture(f.scope, f.threadId, [operation])).toEqual({ userInputRevision: 1, superseded: false });
      expect(f.revisions.capture(f.scope, f.threadId, [randomUUID()])).toEqual({ userInputRevision: 1, superseded: true });
    } finally { f.database.close(); }
  });

  it("excludes in-flight submit and preserves classification without counting an explicit retry", () => {
    const f = fixture();
    try {
      const item = f.enqueue().item;
      f.queue.claimHead(f.scope, f.threadId, "anchor", 204);
      expect(f.revisions.capture(f.scope, f.threadId, [])).toEqual({ userInputRevision: 1, superseded: false });
      f.queue.markUncertain(f.scope, f.threadId, item.id, { diagnostic: "Uncertain", now: 205 });
      expect(f.revisions.capture(f.scope, f.threadId, []).superseded).toBe(false);
      f.queue.handleCleanFailure(f.scope, f.threadId, item.id, { expectedState: "uncertain", retryable: false,
        diagnostic: "Not delivered", now: 206, retryPolicy: { maximumRetries: 0, baseDelayMilliseconds: 1, maximumDelayMilliseconds: 1 } });
      const retried = f.queue.retryFailed(f.scope, f.threadId, item.id, { mutationId: randomUUID(), now: 207 });
      expect(retried.item.isUserInput).toBe(1);
      expect(f.revisions.capture(f.scope, f.threadId, [])).toEqual({ userInputRevision: 1, superseded: true });
    } finally { f.database.close(); }
  });

  it("excludes an agent's queued input and rejects wrong-scope capture", () => {
    const f = fixture();
    try {
      const agent = f.createThread();
      const item = f.enqueue({ source: { kind: "agent_control", expectedThreadRevision: f.revision(), initiatingAgentThreadId: agent } }).item;
      expect(item.isUserInput).toBe(0);
      expect(f.revisions.capture(f.scope, f.threadId, [])).toEqual({ userInputRevision: 0, superseded: false });
      for (const scope of [{ ...f.scope, principalId: randomUUID() }, { ...f.scope, tenantId: randomUUID() }]) {
        expect(() => f.revisions.capture(scope, f.threadId, [])).toThrow("unavailable");
      }
      expect(() => f.revisions.advance(f.scope, f.threadId)).toThrow("admission_transaction");
    } finally { f.database.close(); }
  });

  it("classifies existing user rows on upgrade without changing deployed migration history", () => {
    const f = fixture(140);
    try {
      const id = randomUUID();
      f.database.prepare(`INSERT INTO queued_inputs (tenant_id, owner_principal_id, id, application_thread_id,
        sequence, mutation_id, text, state, created_at) VALUES (?, ?, ?, ?, 1, ?, 'Historical user input', 'pending', 203)`)
        .run(f.scope.tenantId, f.scope.principalId, id, f.threadId, randomUUID());
      const previous = f.database.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version").all();
      applyDatabaseMigrations(f.database, backendNormalizedMigrations);
      expect(f.database.prepare("SELECT version, checksum FROM schema_migrations WHERE version <= 140 ORDER BY version").all()).toEqual(previous);
      expect(f.queue.get(f.scope, f.threadId, id).isUserInput).toBe(1);
      expect(f.revisions.capture(f.scope, f.threadId, [])).toEqual({ userInputRevision: 0, superseded: true });
      expect(() => f.database.prepare("UPDATE queued_inputs SET is_user_input = 0 WHERE id = ?").run(id)).toThrow("immutable");
      expect(f.database.pragma("foreign_key_check")).toEqual([]);
    } finally { f.database.close(); }
  });
});
