import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import type { AppConfig } from "../../src/server/config/config.js";
import {
  DatabaseThreadApplicationInventoryReader,
  directThreadExecutionWorkspaceReader,
} from "../../src/server/conversations/database-thread-application-readers.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { AutomationService } from "../../src/server/domain/automation-service.js";
import type { AutomationPrecheckResult } from "../../src/server/runtime/automation-precheck-executor.js";
import type { AutomationConversationGateway } from "../../src/server/runtime/automation-conversation-gateway.js";
import { AutomationDispatcher } from "../../src/server/runtime/automation-dispatcher.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { threadAgentToolPolicyReaderDependencies } from "../support/thread-agent-tool-policy.js";

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
      label: "Local Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

type DispatchInput = Parameters<AutomationConversationGateway["dispatch"]>[0];
type DispatchResult = Awaited<
  ReturnType<AutomationConversationGateway["dispatch"]>
>;

type PrecheckExecution = {
  readonly result: AutomationPrecheckResult;
  readonly execution: {
    readonly kind: "exited";
    readonly exitCode: number;
    readonly stdoutPreview: Uint8Array;
    readonly stderrPreview: Uint8Array;
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
    readonly durationMilliseconds: number;
  };
};

function precheckExecution(
  result: AutomationPrecheckResult,
): PrecheckExecution {
  return {
    result,
    execution: {
      kind: "exited",
      exitCode: ("exitCode" in result ? result.exitCode : 0) ?? 0,
      stdoutPreview: new Uint8Array(),
      stderrPreview: new Uint8Array(),
      stdoutBytes: result.stdoutBytes,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMilliseconds: result.durationMilliseconds,
    },
  };
}

function createFixture() {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: `/tmp/c2-automation-${randomUUID()}`,
      displayName: "C2 automation",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const threadId = legacy.createThread(
    scope,
    { workspaceId: workspace.id, title: "Imported backend thread" },
    200,
  ).thread.id;
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);

  const inventory = new InventoryRepository(database);
  const bindings = new ConversationBindingRepository(database);
  bindings.bindDiscoveredConversation(scope, threadId, {
    backendConversationId: "native-bound-thread",
    now: 400,
  });
  const repository = new AutomationRepository(database);
  const queue = new QueuedInputRepository(database);
  const completions = new SubmissionCompletionRepository(database);
  const dispatches: DispatchInput[] = [];
  const publications: string[] = [];
  let clock = 1_000;
  let precheck = precheckExecution({
    decision: "invoke",
    effectivePrompt: "Automation prompt",
    durationMilliseconds: 1,
    exitCode: 0,
    stdoutBytes: 0,
    stdoutIncluded: false,
  });
  let dispatch: (input: DispatchInput) => Promise<DispatchResult> = async (
    input,
  ) => {
    dispatches.push(input);
    expect(
      bindings.getBinding(input.scope, input.anchorThreadId),
    ).toMatchObject({
      applicationThreadId: threadId,
      backendConversationId: "native-bound-thread",
    });
    completions.recordAccepted(input.scope, input.anchorThreadId, {
      operationId: input.dispatchMutationId,
      acceptedAt: clock,
      backendCorrelation: input.dispatchMutationId,
    });
    return {
      status: "accepted",
      targetThreadId: input.anchorThreadId,
    };
  };

  const createRuntime = () => {
    const service = new AutomationService({
      repository,
      inventory,
      publisher: {
        publish: (_scope, applicationThreadId) => {
          publications.push(applicationThreadId);
        },
      },
      executionPolicy: { assertCanAutomate: () => undefined },
    });
    const dispatcher = new AutomationDispatcher({
      repository,
      inventory,
      service,
      gateway: { dispatch: (input) => dispatch(input) },
      prechecks: { execute: async () => precheck },
      now: () => clock,
    });
    service.bindDispatcher(dispatcher);
    return { service, dispatcher };
  };

  return {
    database,
    scope,
    environmentId: environment.id,
    threadId,
    inventory,
    bindings,
    repository,
    queue,
    completions,
    dispatches,
    publications,
    createRuntime,
    setClock(value: number) {
      clock = value;
    },
    setPrecheck(result: AutomationPrecheckResult) {
      precheck = precheckExecution(result);
    },
    setDispatch(next: (input: DispatchInput) => Promise<DispatchResult>) {
      dispatch = next;
    },
  };
}

const fixtures: ReturnType<typeof createFixture>[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
  }
});

function fixture() {
  const created = createFixture();
  fixtures.push(created);
  return created;
}

function createRecurring(
  subject: ReturnType<typeof createFixture>,
  service: AutomationService,
  input?: {
    readonly prompt?: string;
    readonly precheck?: {
      readonly command: string;
      readonly timeoutSeconds: number;
      readonly includeStdout: boolean;
    } | null;
  },
) {
  const created = service.create(
    subject.scope,
    subject.threadId,
    {
      prompt: input?.prompt ?? "Automation prompt",
      runMode: "same_thread",
      schedule: {
        kind: "interval",
        anchorAt: new Date(2_000).toISOString(),
        everySeconds: 300,
      },
      misfirePolicy: "coalesce",
      precheck: input?.precheck ?? null,
      mutationId: randomUUID(),
    },
    1_000,
  );
  service.setState(
    subject.scope,
    subject.threadId,
    {
      action: "enable",
      expectedRevision: created.revision,
      mutationId: randomUUID(),
    },
    1_000,
  );
  return subject.repository.findDefinitionForThread(
    subject.scope,
    subject.threadId,
  )!;
}

describe("C2 same-thread automation acceptance", () => {
  it("dispatches scheduled and Run Now work to one bound thread without cloning and projects completion attention", async () => {
    const subject = fixture();
    const { service } = subject.createRuntime();
    const definition = createRecurring(subject, service);
    const initialThreadCount = subject.inventory.listThreadIdsForEnvironment(
      subject.scope,
      subject.environmentId,
    ).length;

    subject.setClock(2_000);
    await service.reconcileDue(2_000);
    await vi.waitFor(() => {
      expect(
        subject.repository.listRuns(subject.scope, definition.id, {
          limit: 10,
        }),
      ).toHaveLength(1);
      expect(
        subject.repository.listRuns(subject.scope, definition.id, {
          limit: 10,
        })[0],
      ).toMatchObject({
        occurrenceKind: "scheduled",
        runMode: "same_thread",
        state: "completed",
        anchorThreadId: subject.threadId,
        childThreadId: null,
      });
    });

    subject.setClock(3_000);
    const manual = await service.runNow(
      subject.scope,
      subject.threadId,
      "manual-same-thread",
      3_000,
    );
    expect(manual).toMatchObject({
      occurrence: "manual",
      state: "completed",
      resultThreadId: subject.threadId,
    });
    expect(subject.dispatches).toHaveLength(2);
    expect(subject.dispatches).toEqual([
      expect.objectContaining({
        anchorThreadId: subject.threadId,
        runMode: "same_thread",
      }),
      expect.objectContaining({
        anchorThreadId: subject.threadId,
        runMode: "same_thread",
        dispatchMutationId: "manual-same-thread",
      }),
    ]);
    expect(
      subject.inventory.listThreadIdsForEnvironment(
        subject.scope,
        subject.environmentId,
      ),
    ).toHaveLength(initialThreadCount);
    expect(
      subject.database
        .prepare("SELECT count(*) AS count FROM backend_checkpoints")
        .get(),
    ).toEqual({ count: 0 });

    const scheduled = subject.repository
      .listRuns(subject.scope, definition.id, { limit: 10 })
      .find(({ occurrenceKind }) => occurrenceKind === "scheduled")!;
    subject.completions.observeCompletion(
      subject.scope,
      subject.threadId,
      scheduled.dispatchMutationId,
      {
        completionIdentity: "native-scheduled-turn:completed",
        observedAt: 4_000,
        createAttention: true,
      },
    );
    const projected = await new DatabaseThreadApplicationInventoryReader({
      inventory: subject.inventory,
      queue: subject.queue,
      completion: subject.completions,
      ...threadAgentToolPolicyReaderDependencies(subject.database),
      directoryBrowsingAvailability: () => "unavailable",
      executionWorkspaces: directThreadExecutionWorkspaceReader,
    }).getAuthorized(subject.scope, subject.threadId);
    expect(projected.attention).toMatchObject({
      automationContext: {
        runId: scheduled.id,
        sourceThreadId: subject.threadId,
        outcome: "triggered",
      },
      unseenCompletion: {
        operationId: scheduled.dispatchMutationId,
      },
    });
  });

  it("runs an invoking precheck with its effective prompt and skips a nonzero precheck without backend dispatch", async () => {
    const invoked = fixture();
    const invokedRuntime = invoked.createRuntime();
    const invokedDefinition = createRecurring(invoked, invokedRuntime.service, {
      precheck: {
        command: "printf context",
        timeoutSeconds: 10,
        includeStdout: true,
      },
    });
    invoked.setPrecheck({
      decision: "invoke",
      effectivePrompt:
        "Automation prompt\n\n<automation-precheck-output>\ncontext\n</automation-precheck-output>",
      durationMilliseconds: 2,
      exitCode: 0,
      stdoutBytes: 7,
      stdoutIncluded: true,
    });
    invoked.setClock(2_000);
    await invokedRuntime.service.reconcileDue(2_000);
    await vi.waitFor(() => expect(invoked.dispatches).toHaveLength(1));
    expect(invoked.dispatches[0]).toMatchObject({
      prompt: expect.stringContaining("<automation-precheck-output>"),
    });
    expect(
      invoked.repository.listRuns(invoked.scope, invokedDefinition.id, {
        limit: 10,
      })[0],
    ).toMatchObject({
      state: "completed",
      precheckStatus: "passed",
      precheckStdoutIncluded: true,
    });

    const skipped = fixture();
    const skippedRuntime = skipped.createRuntime();
    const skippedDefinition = createRecurring(skipped, skippedRuntime.service, {
      precheck: {
        command: "exit 3",
        timeoutSeconds: 10,
        includeStdout: false,
      },
    });
    skipped.setPrecheck({
      decision: "skip",
      durationMilliseconds: 2,
      exitCode: 3,
      stdoutBytes: 0,
    });
    skipped.setClock(2_000);
    await skippedRuntime.service.reconcileDue(2_000);
    await vi.waitFor(() => {
      expect(
        skipped.repository.listRuns(skipped.scope, skippedDefinition.id, {
          limit: 10,
        })[0],
      ).toMatchObject({
        state: "skipped",
        precheckStatus: "skipped",
        precheckExitCode: 3,
      });
    });
    expect(skipped.dispatches).toEqual([]);
  });

  it("suppresses scheduled work throughout snooze without invoking the bound backend", async () => {
    const subject = fixture();
    const { service } = subject.createRuntime();
    const definition = createRecurring(subject, service);
    subject.inventory.transitionInventory(subject.scope, subject.threadId, {
      expectedRevision: 0,
      mutationId: randomUUID(),
      change: {
        action: "snooze",
        snoozedUntil: 500_000,
        wakeReminderText: null,
      },
      now: 1_500,
    });

    subject.setClock(300_000);
    await service.reconcileDue(300_000);

    expect(subject.dispatches).toEqual([]);
    expect(
      subject.repository.listRuns(subject.scope, definition.id, {
        limit: 10,
      }),
    ).toEqual([]);
    expect(
      subject.repository.getDefinition(subject.scope, definition.id).nextRunAt,
    ).toBeGreaterThan(500_000);
    expect(
      subject.inventory.getThread(subject.scope, subject.threadId).inventory,
    ).toMatchObject({
      inventoryState: "snoozed",
      automationContextRunId: null,
    });
  });

  it("reclaims a pre-boundary claimed run after restart but never repeats a dispatching run", async () => {
    const reclaimed = fixture();
    const initial = reclaimed.createRuntime();
    const definition = createRecurring(reclaimed, initial.service);
    const claimed = reclaimed.repository.claimScheduledOccurrence(
      reclaimed.scope,
      definition.id,
      {
        runId: "restart-claimed-run",
        occurrenceKey: "scheduled:2000",
        scheduledFor: 2_000,
        lastScheduledAt: 2_000,
        nextRunAt: 302_000,
        coalescedCount: 0,
        claimToken: "expired-claim",
        leaseExpiresAt: 2_500,
        dispatchMutationId: "restart-claimed-dispatch",
        now: 2_000,
      },
    ).run;
    expect(claimed.state).toBe("claimed");
    await initial.dispatcher.dispose();

    reclaimed.setClock(3_000);
    const restarted = reclaimed.createRuntime();
    await restarted.service.reconcileDue(3_000);
    await vi.waitFor(() => {
      expect(
        reclaimed.repository.getRun(reclaimed.scope, definition.id, claimed.id),
      ).toMatchObject({
        state: "completed",
        claimAttemptCount: 2,
      });
    });
    expect(reclaimed.dispatches).toHaveLength(1);

    const uncertain = fixture();
    const uncertainInitial = uncertain.createRuntime();
    const uncertainDefinition = createRecurring(
      uncertain,
      uncertainInitial.service,
    );
    const dispatching = uncertain.repository.claimScheduledOccurrence(
      uncertain.scope,
      uncertainDefinition.id,
      {
        runId: "restart-dispatching-run",
        occurrenceKey: "scheduled:2000",
        scheduledFor: 2_000,
        lastScheduledAt: 2_000,
        nextRunAt: 302_000,
        coalescedCount: 0,
        claimToken: "expired-dispatch",
        leaseExpiresAt: 2_500,
        dispatchMutationId: "restart-dispatching-mutation",
        now: 2_000,
      },
    ).run;
    uncertain.repository.updateRunState(
      uncertain.scope,
      uncertainDefinition.id,
      dispatching.id,
      {
        expectedState: "claimed",
        state: "dispatching",
        claimToken: "expired-dispatch",
        retainPromptSnapshot: true,
        now: 2_100,
      },
    );
    await uncertainInitial.dispatcher.dispose();

    uncertain.setClock(3_000);
    const uncertainRestart = uncertain.createRuntime();
    await uncertainRestart.service.reconcileDue(3_000);
    expect(
      uncertain.repository.getRun(
        uncertain.scope,
        uncertainDefinition.id,
        dispatching.id,
      ),
    ).toMatchObject({
      state: "uncertain",
      errorCode: "automation_dispatch_uncertain",
    });
    expect(uncertain.dispatches).toEqual([]);
  });

  it("rejects clone automation at the normalized API when backend capability exposes no fork support", async () => {
    const subject = fixture();
    const { service } = subject.createRuntime();
    const config: AppConfig = {
      authenticationRequired: true,
      host: "127.0.0.1",
      port: 4783,
      stateDirectory: "/tmp/c2-automation-api",
      allowedTailscaleHosts: [],
      packagedClientOrigins: [],
        conversationRetentionMilliseconds: 600_000,
        conversationRuntimeBudget: 8,
    };
    const app = createNormalizedApp({
    workpads: {} as never,
      turnBookmarks: unavailableTurnBookmarks(),
      config,
      csrfToken: "c2-automation-csrf",
      identity: { resolve: async () => subject.scope },
      agentTools: unavailableAgentToolRouterDependencies(),
      threads: {
        snapshot: async () => ({
          capabilities: {
            automation: {
              available: true,
              canAttach: true,
              canRunNow: true,
              canCloneOnRun: false,
            },
          },
        }),
      },
      automations: service,
    } as never);
    const mutate = (test: request.Test) =>
      test
        .set("Host", "127.0.0.1:4783")
        .set("X-CSRF-Token", "c2-automation-csrf");
    const base = {
      prompt: "Stay on the imported thread",
      schedule: {
        kind: "date_time" as const,
        runAt: "2099-07-30T12:00:00.000Z",
      },
      misfirePolicy: "coalesce" as const,
      precheck: null,
    };

    await mutate(
      request(app).post(`/api/threads/${subject.threadId}/automation`),
    )
      .send({
        ...base,
        runMode: "clone",
        mutationId: randomUUID(),
      })
      .expect(400)
      .expect({
        error: {
          code: "invalid_transition",
          message: "Clone-mode automation is not available for this thread.",
          retryable: false,
        },
      });
    expect(
      subject.repository.findDefinitionForThread(
        subject.scope,
        subject.threadId,
      ),
    ).toBeUndefined();

    const sameThread = await mutate(
      request(app).post(`/api/threads/${subject.threadId}/automation`),
    )
      .send({
        ...base,
        runMode: "same_thread",
        mutationId: randomUUID(),
      })
      .expect(201);
    expect(sameThread.body).toMatchObject({ runMode: "same_thread" });

    await mutate(
      request(app).patch(`/api/threads/${subject.threadId}/automation`),
    )
      .send({
        ...base,
        runMode: "clone",
        expectedRevision: sameThread.body.revision,
        mutationId: randomUUID(),
      })
      .expect(400);
    expect(
      subject.repository.findDefinitionForThread(
        subject.scope,
        subject.threadId,
      ),
    ).toMatchObject({ runMode: "same_thread" });
    expect(
      subject.inventory.listThreadIdsForEnvironment(
        subject.scope,
        subject.environmentId,
      ),
    ).toHaveLength(1);
  });
});
