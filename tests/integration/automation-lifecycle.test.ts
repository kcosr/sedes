import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { BackendCheckpointRepository } from "../../src/server/db/repositories/backend-checkpoint-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import {
  AutomationService,
  type AutomationRunLifecycleObserver,
} from "../../src/server/domain/automation-service.js";
import { NotificationLifecycleObserver } from "../../src/server/domain/notification-lifecycle-observer.js";
import { AutomationQueueRunObserver } from "../../src/server/runtime/automation-conversation-gateway.js";
import { DomainError } from "../../src/server/domain/errors.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import {
  SingleUserIdentityProvider,
  type RequestScope,
} from "../../src/server/identity/identity-provider.js";
import { AutomationDispatcher } from "../../src/server/runtime/automation-dispatcher.js";
import type { AutomationConversationGateway } from "../../src/server/runtime/automation-conversation-gateway.js";
import type { AutomationPrecheckResult } from "../../src/server/runtime/automation-precheck-executor.js";

type AutomationDispatchInput = Parameters<
  AutomationConversationGateway["dispatch"]
>[0];
type AutomationDispatchResult = Awaited<
  ReturnType<AutomationConversationGateway["dispatch"]>
>;

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

describe("thread automation lifecycle", () => {
  let directory: string;
  let database: Database.Database;
  let scope: RequestScope;
  let inventory: InventoryRepository;
  let bindings: ConversationBindingRepository;
  let checkpoints: BackendCheckpointRepository;
  let repository: AutomationRepository;
  let service: AutomationService;
  let dispatcher: AutomationDispatcher;
  let threadId: string;
  let clock: number;
  let invokeAutomation: ReturnType<
    typeof vi.fn<
      (input: AutomationDispatchInput) => Promise<AutomationDispatchResult>
    >
  >;
  let precheckResult: AutomationPrecheckResult;
  let precheckError: Error | undefined;
  let beforePrecheckResult: (() => void) | undefined;
  let precheckCalls: number;
  let publishedThreads: string[];
  let reconcileErrors: unknown[];
  let onRunLifecycle: ReturnType<typeof vi.fn<AutomationRunLifecycleObserver>>;
  let assertCanAutomate: ReturnType<
    typeof vi.fn<(scope: RequestScope, applicationThreadId: string) => void>
  >;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "pi-automation-lifecycle-"));
    const workspacePath = path.join(directory, "workspace");
    mkdirSync(workspacePath);
    database = openOverlayDatabase(path.join(directory, "overlay.sqlite"));
    scope = new SingleUserIdentityProvider(database).getScope();
    const legacyInventory = new ThreadInventoryService(
      new OverlayRepository(database),
    );
    repository = new AutomationRepository(database);
    assertCanAutomate =
      vi.fn<(scope: RequestScope, applicationThreadId: string) => void>();
    publishedThreads = [];
    reconcileErrors = [];
    onRunLifecycle = vi.fn<AutomationRunLifecycleObserver>();
    const environment = legacyInventory.getLocalEnvironment(scope);
    const workspace = legacyInventory.rememberWorkspace(
      scope,
      {
        environmentId: environment.id,
        canonicalPath: workspacePath,
        displayName: "Workspace",
        availability: "available",
        trustState: "trusted",
      },
      100,
    );
    threadId = legacyInventory.createThread(
      scope,
      { workspaceId: workspace.id, title: "Scheduled work" },
      200,
    ).thread.id;
    applyBackendNormalizationMigration(database, {
      configuration,
      quiescentCutoverConfirmed: true,
      appliedAt: 300,
    });
    applyDatabaseMigrations(database, backendNormalizedMigrations);
    inventory = new InventoryRepository(database);
    bindings = new ConversationBindingRepository(database);
    checkpoints = new BackendCheckpointRepository(database);
    service = new AutomationService({
      repository,
      inventory,
      publisher: {
        publish: (_eventScope, applicationThreadId) => {
          publishedThreads.push(applicationThreadId);
        },
      },
      executionPolicy: { assertCanAutomate },
      onReconcileError: (error) => reconcileErrors.push(error),
      onRunLifecycle,
    });
    clock = 1_000;
    invokeAutomation = vi.fn<
      (input: AutomationDispatchInput) => Promise<AutomationDispatchResult>
    >(async (input) => ({
      status: "accepted",
      targetThreadId: input.anchorThreadId,
    }));
    precheckResult = {
      decision: "invoke",
      effectivePrompt: "Base prompt",
      durationMilliseconds: 5,
      exitCode: 0,
      stdoutBytes: 0,
      stdoutIncluded: false,
    };
    precheckError = undefined;
    beforePrecheckResult = undefined;
    precheckCalls = 0;
    dispatcher = new AutomationDispatcher({
      repository,
      inventory,
      service,
      gateway: {
        dispatch: async (input) => {
          if (input.runMode === "same_thread") {
            return invokeAutomation(input);
          }
          const anchor = inventory.getThread(scope, input.anchorThreadId);
          if (!bindings.getBinding(scope, input.anchorThreadId)) {
            bindings.bindDiscoveredConversation(scope, input.anchorThreadId, {
              backendConversationId: `anchor-${input.anchorThreadId}`,
              now: clock,
            });
          }
          const checkpoint = checkpoints.create(scope, input.anchorThreadId, {
            id: input.dispatchMutationId,
            applicationTurnId: `turn-${input.automationRunId}`,
            opaqueReference: JSON.stringify({ leaf: input.automationRunId }),
            now: clock,
          });
          const child = bindings.createUnboundThread(scope, {
            workspaceId: anchor.thread.workspaceId,
            connectionProfileId: anchor.thread.connectionProfileId,
            title: anchor.thread.title,
            now: clock,
          });
          const lineage = new ThreadLineageRepository(database);
          lineage.prepareOrigin(scope, {
            childThreadId: child.id,
            sourceThreadId: input.anchorThreadId,
            sourceTurnId: `turn-${input.automationRunId}`,
            sourceTurnCompletedAt: null,
            sourceCheckpointId: checkpoint.id,
            originKind: "automation_fork",
            initiatingPrincipalId: scope.principalId,
            sourceAutomationId: input.automationId,
            sourceAutomationRunId: input.automationRunId,
            branchMethod: "provider_native",
            creationOperationId: input.dispatchMutationId,
            now: clock,
          });
          const creation = new ConversationCreationRepository(database);
          const attemptId = `attempt-${input.automationRunId}`;
          creation.prepare(scope, child.id, {
            attemptId,
            mutationId: input.dispatchMutationId,
            expectedThreadRevision: 0,
            creationKind: "fork",
            forkChildIdentity: "application_reserved",
            forkCreationRecovery: "idempotent",
            sourceKind: "automation",
            sourceAutomationId: input.automationId,
            sourceAutomationRunId: input.automationRunId,
            initialInputText: null,
            initialAttachmentIds: [],
            backendCreationCorrelation: `fork-${input.automationRunId}`,
            now: clock,
          });
          creation.markExternalCallStarted(scope, child.id, attemptId, clock);
          creation.recordConversationIdentified(scope, child.id, attemptId, {
            backendConversationId: `clone-${input.automationRunId}`,
            opaqueBindingDetail: JSON.stringify({
              backendConversationId: `clone-${input.automationRunId}`,
            }),
            now: clock,
          });
          bindings.bindCreatedConversation(scope, child.id, {
            attemptId,
            backendConversationId: `clone-${input.automationRunId}`,
            acceptedAt: clock,
          });
          repository.bindForkChild(
            scope,
            input.automationId,
            input.automationRunId,
            {
              childThreadId: child.id,
              now: clock,
            },
          );
          expect(lineage.getOrigin(scope, child.id)).toMatchObject({
            originKind: "automation_fork",
            originState: "committed",
            sourceThreadId: input.anchorThreadId,
            sourceAutomationId: input.automationId,
            sourceAutomationRunId: input.automationRunId,
          });
          const result = await invokeAutomation(input);
          return {
            ...result,
            targetThreadId: child.id,
          };
        },
      },
      prechecks: {
        execute: async () => {
          precheckCalls += 1;
          if (precheckError) throw precheckError;
          beforePrecheckResult?.();
          return {
            result: precheckResult,
            execution: {
              kind: "exited",
              exitCode:
                (
                  precheckResult as AutomationPrecheckResult & {
                    exitCode?: number;
                  }
                ).exitCode ?? 0,
              stdoutPreview: new Uint8Array(),
              stderrPreview: new Uint8Array(),
              stdoutBytes: precheckResult.stdoutBytes,
              stderrBytes: 0,
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMilliseconds: precheckResult.durationMilliseconds,
            },
          };
        },
      },
      now: () => clock,
    });
    service.bindDispatcher(dispatcher);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function createEnabled(
    input: Parameters<AutomationService["create"]>[2],
    now: number,
  ) {
    const created = service.create(scope, threadId, input, now);
    return service.setState(
      scope,
      threadId,
      {
        action: "enable",
        expectedRevision: created.revision,
        mutationId: randomUUID(),
      },
      now,
    );
  }

  it("persists a new automation paused until an explicit enable", () => {
    const created = service.create(
      scope,
      threadId,
      {
        prompt: "Review after approval",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(2_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    expect(created).toMatchObject({ status: "paused", revision: 0 });
    expect(created).not.toHaveProperty("nextRunAt");
    expect(repository.findDefinitionForThread(scope, threadId)).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    expect(assertCanAutomate).not.toHaveBeenCalled();

    const enabled = service.setState(
      scope,
      threadId,
      {
        action: "enable",
        expectedRevision: created.revision,
        mutationId: randomUUID(),
      },
      1_100,
    );
    expect(enabled).toMatchObject({
      status: "enabled",
      nextRunAt: new Date(2_000).toISOString(),
    });
    expect(assertCanAutomate).toHaveBeenCalledOnce();
  });

  it.each(["queued", "uncertain"] as const)(
    "does not announce an automation start while submission is %s",
    async (status) => {
      createEnabled(
        {
          prompt: "Queued work",
          runMode: "same_thread",
          schedule: {
            kind: "interval",
            anchorAt: new Date(10_000).toISOString(),
            everySeconds: 300,
          },
          misfirePolicy: "coalesce",
          precheck: null,
          mutationId: randomUUID(),
        },
        1_000,
      );
      invokeAutomation.mockResolvedValue({
        status,
        targetThreadId: threadId,
        diagnostic: "Acceptance is not established",
      });

      clock = 2_000;
      const result = await service.runNow(scope, threadId, randomUUID(), clock);
      expect(result.state).toBe(status);
      expect(onRunLifecycle).not.toHaveBeenCalled();
    },
  );

  it.each(["immediate", "queued", "recovered"] as const)(
    "projects automation start at actual %s acceptance, not queue admission",
    async (mode) => {
      createEnabled(
        {
          prompt: "Private automation prompt",
          runMode: "same_thread",
          schedule: {
            kind: "interval",
            anchorAt: new Date(10_000).toISOString(),
            everySeconds: 300,
          },
          misfirePolicy: "coalesce",
          precheck: null,
          mutationId: randomUUID(),
        },
        1_000,
      );
      const emit = vi.fn<NotificationLifecycleObserver["emit"]>();
      const observer = new NotificationLifecycleObserver(inventory, emit);
      onRunLifecycle.mockImplementation((eventScope, input) =>
        observer.automation(eventScope, input),
      );
      if (mode !== "immediate")
        invokeAutomation.mockResolvedValue({
          status: "queued",
          targetThreadId: threadId,
        });
      clock = 2_000;
      const result = await service.runNow(scope, threadId, randomUUID(), clock);
      if (mode !== "immediate") {
        expect(emit).not.toHaveBeenCalled();
        const run = repository.findRunByScopedId(scope, result.id)!;
        expect(run.acceptedAt).toBe(2_000);
        const item = {
          mutationId: run.dispatchMutationId,
          state: "accepted",
        } as never;
        const queueObserver = new AutomationQueueRunObserver({
          repository,
          queue: { findByMutationId: () => item },
          publisher: service,
          now: () => clock,
        });
        clock = 3_000;
        if (mode === "recovered") queueObserver.recover();
        else queueObserver.observe(scope, threadId, item);
      }
      expect(emit).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0]![1]).toMatchObject({
        event: "automation.started",
        occurredAt: new Date(clock).toISOString(),
        thread: { id: threadId },
        automation: { runId: result.id, trigger: "manual" },
      });
      expect(emit.mock.calls[0]![1]).not.toHaveProperty("prompt");
    },
  );

  it.each(["throw", "reject"] as const)(
    "keeps accepted automation work successful when a passive observer fails by %s",
    async (failure) => {
      createEnabled(
        {
          prompt: "Accepted work",
          runMode: "same_thread",
          schedule: {
            kind: "interval",
            anchorAt: new Date(10_000).toISOString(),
            everySeconds: 300,
          },
          misfirePolicy: "coalesce",
          precheck: null,
          mutationId: randomUUID(),
        },
        1_000,
      );
      onRunLifecycle.mockImplementation(() => {
        if (failure === "throw") throw new Error("Notification failed");
        return Promise.reject(new Error("Notification failed"));
      });

      clock = 2_000;
      const result = await service.runNow(scope, threadId, randomUUID(), clock);
      expect(result.state).toBe("completed");
      expect(onRunLifecycle).toHaveBeenCalledOnce();
      expect(invokeAutomation).toHaveBeenCalledOnce();
    },
  );

  it("replays an accepted enable before applying a tightened backend policy", () => {
    const created = service.create(
      scope,
      threadId,
      {
        prompt: "Review after approval",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(2_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const mutationId = randomUUID();
    const request = {
      action: "enable" as const,
      expectedRevision: created.revision,
      mutationId,
    };
    const first = service.setState(scope, threadId, request, 1_100);
    assertCanAutomate.mockImplementation(() => {
      throw new DomainError(
        "invalid_transition",
        "The backend policy does not permit automation.",
      );
    });

    expect(service.setState(scope, threadId, request, 1_200)).toEqual(first);
    expect(() =>
      service.setState(
        scope,
        threadId,
        {
          action: "enable",
          expectedRevision: first.revision,
          mutationId: randomUUID(),
        },
        1_300,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_transition" }));
    expect(repository.findDefinitionForThread(scope, threadId)).toMatchObject({
      revision: first.revision,
      enabled: true,
    });
  });

  it("replays an accepted enabled update before applying a tightened backend policy", () => {
    const enabled = createEnabled(
      {
        prompt: "Recurring prompt",
        runMode: "same_thread",
        schedule: {
          kind: "interval",
          anchorAt: new Date(10_000).toISOString(),
          everySeconds: 300,
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const mutationId = randomUUID();
    const request = {
      prompt: "Updated recurring prompt",
      runMode: "same_thread" as const,
      schedule: {
        kind: "interval" as const,
        anchorAt: new Date(10_000).toISOString(),
        everySeconds: 600,
      },
      misfirePolicy: "coalesce" as const,
      precheck: null,
      expectedRevision: enabled.revision,
      mutationId,
    };
    const first = service.update(scope, threadId, request, 1_100);
    assertCanAutomate.mockImplementation(() => {
      throw new DomainError(
        "invalid_transition",
        "The backend policy does not permit automation.",
      );
    });

    expect(service.update(scope, threadId, request, 1_200)).toEqual(first);
    expect(() =>
      service.update(
        scope,
        threadId,
        {
          ...request,
          expectedRevision: first.revision,
          mutationId: randomUUID(),
        },
        1_300,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_transition" }));
    expect(repository.findDefinitionForThread(scope, threadId)).toMatchObject({
      revision: first.revision,
      prompt: "Updated recurring prompt",
    });
  });

  it("pages run history with an opaque query-bound keyset cursor", () => {
    service.create(
      scope,
      threadId,
      {
        prompt: "Review history",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(10_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      500,
    );
    const definition = repository.findDefinitionForThread(scope, threadId)!;
    const createFinishedRun = (runId: string, now: number) => {
      const claimToken = randomUUID();
      repository.createManualRun(scope, definition.id, {
        runId,
        occurrenceKey: `manual:${runId}`,
        scheduledFor: now,
        claimToken,
        leaseExpiresAt: now + 60_000,
        dispatchMutationId: randomUUID(),
        now,
      });
      repository.updateRunState(scope, definition.id, runId, {
        expectedState: "claimed",
        state: "failed",
        claimToken,
        errorCode: "test_failure",
        now: now + 1,
      });
    };
    const oldestRunId = "00000000-0000-4000-8000-000000000001";
    const middleRunId = "00000000-0000-4000-8000-000000000002";
    const newestRunId = "00000000-0000-4000-8000-000000000003";
    createFinishedRun(oldestRunId, 1_000);
    createFinishedRun(middleRunId, 2_000);

    const firstPage = service.listRuns(scope, threadId, { pageSize: 1 });
    expect(firstPage.items.map(({ id }) => id)).toEqual([middleRunId]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.nextCursor).not.toBe("1");

    createFinishedRun(newestRunId, 3_000);
    const secondPage = service.listRuns(scope, threadId, {
      cursor: firstPage.nextCursor!,
      pageSize: 1,
    });
    expect(secondPage.items.map(({ id }) => id)).toEqual([oldestRunId]);
    expect(secondPage.nextCursor).toBeNull();
    expect(
      service
        .listRuns(scope, threadId, { pageSize: 1 })
        .items.map(({ id }) => id),
    ).toEqual([newestRunId]);

    expect(() =>
      service.listRuns(scope, threadId, {
        cursor: "not-a-cursor",
        pageSize: 1,
      }),
    ).toThrow(expect.objectContaining({ code: "cursor_invalid" }));
    expect(() =>
      service.listRuns(scope, threadId, {
        cursor: firstPage.nextCursor!,
        pageSize: 2,
      }),
    ).toThrow(expect.objectContaining({ code: "cursor_invalid" }));

    const authorityPage = service.listRuns(scope, threadId, {
      pageSize: 1,
      environmentAuthority: {
        sourceEnvironmentId: "environment-a",
        targetEnvironmentIds: ["environment-b"],
        policyRevision: 4,
      },
    });
    expect(() =>
      service.listRuns(scope, threadId, {
        cursor: authorityPage.nextCursor!,
        pageSize: 1,
        environmentAuthority: {
          sourceEnvironmentId: "environment-a",
          targetEnvironmentIds: ["environment-b"],
          policyRevision: 5,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "cursor_invalid" }));
  });

  it("rejects a blank normalized prompt before persisting an automation", () => {
    expect(() =>
      service.create(
        scope,
        threadId,
        {
          prompt: " \n ",
          runMode: "same_thread",
          schedule: {
            kind: "date_time",
            runAt: new Date(2_000).toISOString(),
          },
          misfirePolicy: "coalesce",
          precheck: null,
          mutationId: randomUUID(),
        },
        1_000,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_transition" }));
    expect(repository.findDefinitionForThread(scope, threadId)).toBeUndefined();
    expect(publishedThreads).toEqual([]);
  });

  it("silently suppresses a recurring occurrence for the full snooze window", async () => {
    createEnabled(
      {
        prompt: "Recurring prompt",
        runMode: "same_thread",
        schedule: {
          kind: "interval",
          anchorAt: new Date(1_000).toISOString(),
          everySeconds: 300,
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: 0,
      mutationId: randomUUID(),
      change: {
        action: "snooze",
        snoozedUntil: 1_000_000,
        wakeReminderText: null,
      },
      now: 1_100,
    });

    clock = 400_000;
    await service.reconcileDue(clock);

    const stored = repository.findDefinitionForThread(scope, threadId);
    expect(stored).toMatchObject({ enabled: true });
    expect(stored!.nextRunAt).toBeGreaterThan(1_000_000);
    expect(repository.listRuns(scope, stored!.id, { limit: 10 })).toEqual([]);
    expect(invokeAutomation).not.toHaveBeenCalled();
    expect(inventory.getThread(scope, threadId).inventory).toMatchObject({
      inventoryState: "snoozed",
      automationContextRunId: null,
    });
  });

  it("silently detaches a one-shot whose time passes while snoozed", async () => {
    createEnabled(
      {
        prompt: "One shot",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(2_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: 0,
      mutationId: randomUUID(),
      change: {
        action: "snooze",
        snoozedUntil: 5_000,
        wakeReminderText: null,
      },
      now: 1_100,
    });

    clock = 2_100;
    await service.reconcileDue(clock);

    expect(repository.findDefinitionForThread(scope, threadId)).toBeUndefined();
    expect(invokeAutomation).not.toHaveBeenCalled();
    expect(inventory.getThread(scope, threadId).inventory).toMatchObject({
      inventoryState: "snoozed",
      automationContextRunId: null,
    });
    expect(publishedThreads).toContain(threadId);
  });

  it("lets snooze suppress an occurrence exactly at its wake boundary", async () => {
    createEnabled(
      {
        prompt: "Boundary one shot",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(5_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const definition = repository.findDefinitionForThread(scope, threadId)!;
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: 0,
      mutationId: randomUUID(),
      change: {
        action: "snooze",
        snoozedUntil: 5_000,
        wakeReminderText: null,
      },
      now: 1_100,
    });

    clock = 5_000;
    await service.reconcileDue(clock);

    expect(repository.findDefinitionForThread(scope, threadId)).toBeUndefined();
    expect(repository.listRuns(scope, definition.id, { limit: 10 })).toEqual(
      [],
    );
    expect(invokeAutomation).not.toHaveBeenCalled();
    expect(inventory.getThread(scope, threadId).inventory.inventoryState).toBe(
      "snoozed",
    );
  });

  it("isolates a malformed due definition and reconciles the next item", async () => {
    repository.createDefinition(scope, {
      id: "a-malformed",
      anchorThreadId: threadId,
      name: "Malformed",
      prompt: "Never runs",
      precheck: null,
      runMode: "same_thread",
      enabled: true,
      schedule: {
        kind: "cron",
        expression: "0 * * * *",
        timeZone: "Not/A-Time-Zone",
      },
      misfirePolicy: "coalesce",
      nextRunAt: 2_000,
      now: 1_000,
    });
    const anchor = inventory.getThread(scope, threadId).thread;
    const secondThreadId = bindings.createUnboundThread(scope, {
      workspaceId: anchor.workspaceId,
      connectionProfileId: anchor.connectionProfileId,
      title: "Healthy schedule",
      now: 1_200,
    }).id;
    repository.createDefinition(scope, {
      id: "z-healthy",
      anchorThreadId: secondThreadId,
      name: "Healthy",
      prompt: "Still runs",
      precheck: null,
      runMode: "same_thread",
      enabled: true,
      schedule: { kind: "date_time", runAt: 2_000 },
      misfirePolicy: "coalesce",
      nextRunAt: 2_000,
      now: 1_000,
    });

    clock = 2_000;
    await service.reconcileDue(clock);
    await vi.waitFor(() => expect(invokeAutomation).toHaveBeenCalledOnce());

    expect(reconcileErrors).toHaveLength(1);
    expect(reconcileErrors[0]).toBeInstanceOf(Error);
    expect(service.getNearestDeadline()).toBe(3_000);
    expect(invokeAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorThreadId: secondThreadId,
        prompt: "Still runs",
      }),
    );
  });

  it("detaches a successful scheduled one-shot and keeps context until dismissal", async () => {
    createEnabled(
      {
        prompt: "One shot",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(2_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );

    clock = 2_000;
    await service.reconcileDue(clock);
    await vi.waitFor(() => {
      expect(
        repository.findDefinitionForThread(scope, threadId),
      ).toBeUndefined();
    });

    const context = inventory.getThread(scope, threadId).inventory;
    expect(onRunLifecycle).toHaveBeenCalledExactlyOnceWith(scope, {
      event: "automation.started",
      run: expect.objectContaining({
        state: "completed",
        occurrenceKind: "scheduled",
      }),
      definition: expect.objectContaining({ anchorThreadId: threadId }),
    });
    expect(context).toMatchObject({
      automationContextOutcome: "triggered",
      automationContextAt: 2_000,
      automationContextSourceThreadId: threadId,
    });
    expect(context.automationContextRunId).toEqual(expect.any(String));
    inventory.dismissAutomationContext(
      scope,
      threadId,
      context.automationContextRunId!,
    );
    expect(
      inventory.getThread(scope, threadId).inventory.automationContextRunId,
    ).toBeNull();
  });

  it("keeps a settled clone anchor settled when its one-shot succeeds", async () => {
    createEnabled(
      {
        prompt: "Clone once",
        runMode: "clone",
        schedule: {
          kind: "date_time",
          runAt: new Date(2_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const definition = repository.findDefinitionForThread(scope, threadId)!;
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: 0,
      mutationId: randomUUID(),
      change: { action: "settle" },
      now: 1_500,
    });

    clock = 2_000;
    await service.reconcileDue(clock);
    await vi.waitFor(() => {
      expect(
        repository.findDefinitionForThread(scope, threadId),
      ).toBeUndefined();
    });

    const run = repository.listRuns(scope, definition.id, { limit: 10 })[0]!;
    expect(run.errorDiagnostic).toBeNull();
    expect(run).toMatchObject({
      state: "completed",
      childThreadId: expect.any(String),
    });
    expect(run.childThreadId).not.toBe(threadId);
    expect(inventory.getThread(scope, threadId).inventory).toMatchObject({
      inventoryState: "settled",
      automationContextRunId: null,
    });
    expect(
      inventory.getThread(scope, run.childThreadId!).inventory,
    ).toMatchObject({
      inventoryState: "active",
      wokeAt: null,
      wakeReason: null,
      automationContextOutcome: "triggered",
      automationContextSourceThreadId: threadId,
      automationContextRunId: run.id,
    });
  });

  it("keeps a settled clone anchor settled when its one-shot fails", async () => {
    createEnabled(
      {
        prompt: "Fail once",
        runMode: "clone",
        schedule: {
          kind: "date_time",
          runAt: new Date(2_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const definition = repository.findDefinitionForThread(scope, threadId)!;
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: 0,
      mutationId: randomUUID(),
      change: { action: "settle" },
      now: 1_500,
    });
    invokeAutomation.mockRejectedValueOnce(new Error("Backend rejected work"));

    clock = 2_000;
    await service.reconcileDue(clock);
    await vi.waitFor(() => {
      expect(
        repository.findDefinitionForThread(scope, threadId),
      ).toBeUndefined();
    });

    const run = repository.listRuns(scope, definition.id, { limit: 10 })[0]!;
    expect(run).toMatchObject({
      state: "failed",
      childThreadId: expect.any(String),
    });
    expect(inventory.getThread(scope, threadId).inventory).toMatchObject({
      inventoryState: "settled",
      automationContextRunId: null,
    });
    expect(
      inventory.getThread(scope, run.childThreadId!).inventory,
    ).toMatchObject({
      inventoryState: "active",
      wokeAt: null,
      wakeReason: null,
      automationContextOutcome: "failed",
      automationContextSourceThreadId: threadId,
      automationContextRunId: run.id,
      automationContextDiagnostic: "Backend rejected work",
    });
  });

  it("uses exit status as the pre-check gate and does not create a skip notice", async () => {
    const created = createEnabled(
      {
        prompt: "One shot",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(2_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: {
          command: "exit 3",
          timeoutSeconds: 30,
          includeStdout: true,
        },
        mutationId: randomUUID(),
      },
      1_000,
    );
    precheckResult = {
      decision: "skip",
      durationMilliseconds: 4,
      exitCode: 3,
      stdoutBytes: 12,
    };

    clock = 2_000;
    await service.reconcileDue(clock);
    await vi.waitFor(() => {
      expect(
        repository.findDefinitionForThread(scope, threadId),
      ).toBeUndefined();
    });

    expect(invokeAutomation).not.toHaveBeenCalled();
    expect(onRunLifecycle).not.toHaveBeenCalled();
    expect(
      inventory.getThread(scope, threadId).inventory.automationContextRunId,
    ).toBeNull();
    const definition = repository
      .listDefinitions(scope, { includeDeleted: true, limit: 10 })
      .find(
        ({ createdAt }) => new Date(created.createdAt).getTime() === createdAt,
      )!;
    expect(
      repository.listRuns(scope, definition.id, { limit: 10 })[0],
    ).toMatchObject({
      state: "skipped",
      precheckStatus: "skipped",
      precheckExitCode: 3,
    });
  });

  it("adds opted-in stdout to a manual run without consuming the one-shot", async () => {
    createEnabled(
      {
        prompt: "Base prompt",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(10_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: {
          command: "printf context",
          timeoutSeconds: 30,
          includeStdout: true,
        },
        mutationId: randomUUID(),
      },
      1_000,
    );
    precheckResult = {
      decision: "invoke",
      effectivePrompt:
        "Base prompt\n\n<automation-precheck-output>\ncontext\n</automation-precheck-output>",
      durationMilliseconds: 3,
      exitCode: 0,
      stdoutBytes: 7,
      stdoutIncluded: true,
    };

    clock = 2_000;
    await service.runNow(scope, threadId, randomUUID(), clock);

    expect(invokeAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("<automation-precheck-output>"),
      }),
    );
    expect(repository.findDefinitionForThread(scope, threadId)).toBeDefined();
  });

  it("records a thrown precheck provider failure without leaving checking state", async () => {
    const created = createEnabled(
      {
        prompt: "One shot",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(2_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: {
          command: "provider-owned command",
          timeoutSeconds: 30,
          includeStdout: false,
        },
        mutationId: randomUUID(),
      },
      1_000,
    );
    precheckError = new Error("provider failed before execution");

    clock = 2_000;
    await service.reconcileDue(clock);
    await vi.waitFor(() => {
      expect(
        repository.findDefinitionForThread(scope, threadId),
      ).toBeUndefined();
    });

    const definition = repository
      .listDefinitions(scope, { includeDeleted: true, limit: 10 })
      .find(
        ({ createdAt }) => new Date(created.createdAt).getTime() === createdAt,
      )!;
    expect(
      repository.listRuns(scope, definition.id, { limit: 10 })[0],
    ).toMatchObject({
      state: "failed",
      precheckStatus: "failed",
      errorCode: "automation_precheck_execution_failed",
    });
    expect(invokeAutomation).not.toHaveBeenCalled();
    expect(onRunLifecycle).toHaveBeenCalledExactlyOnceWith(scope, {
      event: "automation.failed",
      run: expect.objectContaining({ precheckStatus: "failed" }),
      definition: expect.objectContaining({ anchorThreadId: threadId }),
    });
  });

  it("lets Snooze win while a precheck is running and creates no notice", async () => {
    createEnabled(
      {
        prompt: "One shot",
        runMode: "same_thread",
        schedule: {
          kind: "date_time",
          runAt: new Date(2_000).toISOString(),
        },
        misfirePolicy: "coalesce",
        precheck: {
          command: "slow gate",
          timeoutSeconds: 30,
          includeStdout: false,
        },
        mutationId: randomUUID(),
      },
      1_000,
    );
    beforePrecheckResult = () => {
      inventory.transitionInventory(scope, threadId, {
        expectedRevision: 0,
        mutationId: randomUUID(),
        change: {
          action: "snooze",
          snoozedUntil: 5_000,
          wakeReminderText: null,
        },
        now: 2_001,
      });
    };

    clock = 2_000;
    await service.reconcileDue(clock);
    await vi.waitFor(() => {
      expect(
        repository.findDefinitionForThread(scope, threadId),
      ).toBeUndefined();
    });

    expect(invokeAutomation).not.toHaveBeenCalled();
    expect(inventory.getThread(scope, threadId).inventory).toMatchObject({
      inventoryState: "snoozed",
      automationContextRunId: null,
    });
  });

  it("suspends an automation while its thread is archived", async () => {
    createEnabled(
      {
        prompt: "Archived work",
        runMode: "same_thread",
        schedule: {
          kind: "interval",
          anchorAt: new Date(2_000).toISOString(),
          everySeconds: 300,
        },
        misfirePolicy: "coalesce",
        precheck: {
          command: "must not run",
          timeoutSeconds: 30,
          includeStdout: false,
        },
        mutationId: randomUUID(),
      },
      1_000,
    );
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: 0,
      mutationId: randomUUID(),
      change: { action: "archive" },
      now: 1_500,
    });

    clock = 2_000;
    await service.reconcileDue(clock);
    const definition = repository.findDefinitionForThread(scope, threadId)!;

    expect(definition).toMatchObject({
      enabled: true,
      nextRunAt: 2_000,
    });
    expect(repository.listRuns(scope, definition.id, { limit: 10 })).toEqual(
      [],
    );
    expect(repository.getNearestDeadline()).toBeNull();
    expect(precheckCalls).toBe(0);
    expect(invokeAutomation).not.toHaveBeenCalled();
  });

  it("rejects archive while an automation run is nonterminal", () => {
    createEnabled(
      {
        prompt: "Run now",
        runMode: "same_thread",
        schedule: {
          kind: "interval",
          anchorAt: new Date(2_000).toISOString(),
          everySeconds: 300,
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const definition = repository.findDefinitionForThread(scope, threadId)!;
    repository.createManualRun(scope, definition.id, {
      runId: randomUUID(),
      occurrenceKey: `manual:${randomUUID()}`,
      scheduledFor: 1_500,
      claimToken: randomUUID(),
      leaseExpiresAt: 61_500,
      dispatchMutationId: randomUUID(),
      now: 1_500,
    });

    expect(() =>
      inventory.transitionInventory(scope, threadId, {
        expectedRevision: 0,
        mutationId: randomUUID(),
        change: { action: "archive" },
        now: 1_600,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_transition",
        retryable: false,
      }),
    );
    expect(inventory.getThread(scope, threadId).inventory.inventoryState).toBe(
      "active",
    );
    expect(repository.findDefinitionForThread(scope, threadId)).toMatchObject({
      id: definition.id,
      enabled: true,
    });
  });

  it("re-enters an expired clone dispatch after restart instead of marking it uncertain", async () => {
    const definition = repository.createDefinition(scope, {
      id: randomUUID(),
      anchorThreadId: threadId,
      name: "Restart-safe clone",
      prompt: "Finish the clone dispatch",
      precheck: null,
      runMode: "clone",
      enabled: true,
      schedule: {
        kind: "interval",
        anchorAt: 100_000,
        everySeconds: 300,
      },
      misfirePolicy: "coalesce",
      nextRunAt: 100_000,
      now: 1_000,
    });
    const claimed = repository.createManualRun(scope, definition.id, {
      runId: randomUUID(),
      occurrenceKey: `manual:${randomUUID()}`,
      scheduledFor: 1_500,
      claimToken: randomUUID(),
      leaseExpiresAt: 2_000,
      dispatchMutationId: randomUUID(),
      now: 1_500,
    }).run;
    const dispatching = repository.updateRunState(
      scope,
      definition.id,
      claimed.id,
      {
        expectedState: "claimed",
        state: "dispatching",
        claimToken: claimed.claimToken!,
        retainPromptSnapshot: true,
        now: 1_600,
      },
    );
    const dispatch = vi
      .spyOn(dispatcher, "dispatch")
      .mockResolvedValue(dispatching);

    await service.reconcileDue(2_000);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(dispatching));

    expect(repository.getRun(scope, definition.id, claimed.id)).toMatchObject({
      state: "dispatching",
      errorCode: null,
    });
  });

  it("replays an authorized Run now after the thread is later snoozed", async () => {
    createEnabled(
      {
        prompt: "Recurring prompt",
        runMode: "same_thread",
        schedule: {
          kind: "interval",
          anchorAt: new Date(10_000).toISOString(),
          everySeconds: 300,
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const mutationId = randomUUID();
    clock = 2_000;
    const first = await service.runNow(scope, threadId, mutationId, 2_000);
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: inventory.getThread(scope, threadId).inventory
        .inventoryRevision,
      mutationId: randomUUID(),
      change: {
        action: "snooze",
        snoozedUntil: 20_000,
        wakeReminderText: null,
      },
      now: 3_000,
    });

    await expect(
      service.runNow(scope, threadId, mutationId, 4_000),
    ).resolves.toEqual(first);
    expect(invokeAutomation).toHaveBeenCalledTimes(1);
  });

  it("replays an accepted Run now before applying a tightened backend policy", async () => {
    service.create(
      scope,
      threadId,
      {
        prompt: "Manual prompt",
        runMode: "same_thread",
        schedule: {
          kind: "interval",
          anchorAt: new Date(10_000).toISOString(),
          everySeconds: 300,
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const definition = repository.findDefinitionForThread(scope, threadId)!;
    const mutationId = randomUUID();
    clock = 2_000;
    const first = await service.runNow(scope, threadId, mutationId, 2_000);
    assertCanAutomate.mockImplementation(() => {
      throw new DomainError(
        "invalid_transition",
        "The backend policy does not permit automation.",
      );
    });

    await expect(
      service.runNow(scope, threadId, mutationId, 3_000),
    ).resolves.toEqual(first);
    await expect(
      service.runNow(scope, threadId, randomUUID(), 4_000),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(
      repository.listRuns(scope, definition.id, { limit: 10 }),
    ).toHaveLength(1);
    expect(invokeAutomation).toHaveBeenCalledTimes(1);
  });

  it("rejects a new manual run while the anchor is snoozed", async () => {
    service.create(
      scope,
      threadId,
      {
        prompt: "Manual prompt",
        runMode: "same_thread",
        schedule: {
          kind: "interval",
          anchorAt: new Date(10_000).toISOString(),
          everySeconds: 300,
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const definition = repository.findDefinitionForThread(scope, threadId)!;
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: inventory.getThread(scope, threadId).inventory
        .inventoryRevision,
      mutationId: randomUUID(),
      change: {
        action: "snooze",
        snoozedUntil: 20_000,
        wakeReminderText: null,
      },
      now: 2_000,
    });

    clock = 3_000;
    await expect(
      service.runNow(scope, threadId, randomUUID(), 3_000),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(repository.listRuns(scope, definition.id, { limit: 10 })).toEqual(
      [],
    );
    expect(invokeAutomation).not.toHaveBeenCalled();
  });

  it("rejects a manual run when backend execution policy is ineligible", async () => {
    service.create(
      scope,
      threadId,
      {
        prompt: "Manual prompt",
        runMode: "same_thread",
        schedule: {
          kind: "interval",
          anchorAt: new Date(10_000).toISOString(),
          everySeconds: 300,
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const definition = repository.findDefinitionForThread(scope, threadId)!;
    assertCanAutomate.mockImplementation(() => {
      throw new DomainError(
        "invalid_transition",
        "The backend policy does not permit automation.",
      );
    });

    await expect(
      service.runNow(scope, threadId, randomUUID(), 2_000),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(repository.listRuns(scope, definition.id, { limit: 10 })).toEqual(
      [],
    );
    expect(invokeAutomation).not.toHaveBeenCalled();
  });

  it("persists an archived-anchor manual run as failed", async () => {
    service.create(
      scope,
      threadId,
      {
        prompt: "Manual prompt",
        runMode: "same_thread",
        schedule: {
          kind: "interval",
          anchorAt: new Date(10_000).toISOString(),
          everySeconds: 300,
        },
        misfirePolicy: "coalesce",
        precheck: null,
        mutationId: randomUUID(),
      },
      1_000,
    );
    const definition = repository.findDefinitionForThread(scope, threadId)!;
    inventory.transitionInventory(scope, threadId, {
      expectedRevision: inventory.getThread(scope, threadId).inventory
        .inventoryRevision,
      mutationId: randomUUID(),
      change: { action: "archive" },
      now: 2_000,
    });

    clock = 3_000;
    await expect(
      service.runNow(scope, threadId, randomUUID(), 3_000),
    ).resolves.toMatchObject({
      state: "failed",
      errorCode: "automation_anchor_archived",
    });
    expect(
      repository.listRuns(scope, definition.id, { limit: 10 })[0],
    ).toMatchObject({
      state: "failed",
      errorCode: "automation_anchor_archived",
    });
    expect(invokeAutomation).not.toHaveBeenCalled();
  });

  it("rejects UTF-8 oversized precheck commands before persistence", () => {
    expect(() =>
      service.create(
        scope,
        threadId,
        {
          prompt: "Manual prompt",
          runMode: "same_thread",
          schedule: {
            kind: "interval",
            anchorAt: new Date(10_000).toISOString(),
            everySeconds: 300,
          },
          misfirePolicy: "coalesce",
          precheck: {
            command: "😀".repeat(1_025),
            timeoutSeconds: 30,
            includeStdout: false,
          },
          mutationId: randomUUID(),
        },
        1_000,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_transition" }));
    expect(repository.findDefinitionForThread(scope, threadId)).toBeUndefined();
  });

  it("replays a resolved uncertain one-shot after its definition detaches", () => {
    const definition = repository.createDefinition(scope, {
      id: randomUUID(),
      anchorThreadId: threadId,
      name: "Uncertain one-shot",
      prompt: "Run once",
      precheck: null,
      runMode: "same_thread",
      enabled: true,
      schedule: { kind: "date_time", runAt: 2_000 },
      misfirePolicy: "coalesce",
      nextRunAt: 2_000,
      now: 1_000,
    });
    const claimed = repository.claimScheduledOccurrence(scope, definition.id, {
      runId: randomUUID(),
      occurrenceKey: "scheduled:2000",
      scheduledFor: 2_000,
      lastScheduledAt: 2_000,
      nextRunAt: null,
      coalescedCount: 0,
      claimToken: randomUUID(),
      leaseExpiresAt: 10_000,
      dispatchMutationId: randomUUID(),
      now: 2_000,
    }).run;
    const dispatching = repository.updateRunState(
      scope,
      definition.id,
      claimed.id,
      {
        expectedState: "claimed",
        state: "dispatching",
        claimToken: claimed.claimToken!,
        retainPromptSnapshot: true,
        now: 2_100,
      },
    );
    repository.markRunUncertainAndPause(scope, definition.id, claimed.id, {
      expectedState: "dispatching",
      claimToken: dispatching.claimToken!,
      errorCode: "automation_dispatch_uncertain",
      errorDiagnostic: "Acceptance could not be proven.",
      now: 2_200,
    });

    const first = service.resolveUncertainRun(
      scope,
      threadId,
      claimed.id,
      2_300,
    );
    const replay = service.resolveUncertainRun(
      scope,
      threadId,
      claimed.id,
      2_400,
    );

    expect(first).toMatchObject({
      state: "failed",
      errorCode: "automation_uncertain_resolved",
    });
    expect(replay).toEqual(first);
    expect(repository.findDefinitionForThread(scope, threadId)).toBeUndefined();
  });
});
