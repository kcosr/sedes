import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { PrincipalAgentToolClientRepository } from "../../src/server/db/repositories/principal-agent-tool-client-repository.js";
import { createPrincipalAgentToolClientEligibility } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { ThreadCompletionCallbackRepository } from "../../src/server/db/repositories/thread-completion-callback-repository.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import {
  APPLICATION_ASSIGNED_CREATION_IDENTITY,
  BackendError,
  PROVIDER_ASSIGNED_CREATION_IDENTITY,
  type AgentBackendInstance,
  type AgentConnectionProfile,
  type ConversationBackendDriver,
  type ConversationHandle,
  type RegisteredBackendActionInput,
  type SubmitTurnInput,
  type SubmitTurnResult,
} from "../../src/server/backends/contracts.js";
import { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import {
  ConversationLifecycleService,
  type BackendThreadPersistenceAdapter,
  type ConversationLifecycleTargetResolver,
  type ResolvedLifecycleTarget,
} from "../../src/server/conversations/conversation-lifecycle-service.js";
import { ConversationActorManager } from "../../src/server/conversations/conversation-actor-manager.js";
import { DatabaseThreadApplicationRecoveryReader } from "../../src/server/conversations/database-conversation-adapters.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { ConversationLifecycleAutomationFirstInput } from "../../src/server/runtime/conversation-lifecycle-automation.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { ExecutionEnvironmentProvider } from "../../src/server/execution/contracts.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import type { BackendEffectiveSettings } from "../../src/shared/protocol/backend.js";

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
      id: "lifecycle-backend",
      kind: "pi",
      label: "Lifecycle backend",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "lifecycle-connection",
      kind: "pi_sdk",
      label: "Lifecycle connection",
      backendInstanceId: "lifecycle-backend",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "lifecycle-connection",
});

class NeutralDriver {
  readonly catalogSkills: Array<{
    id: string;
    name: string;
    reference: string;
    description?: string;
  }> = [];
  readonly create = vi.fn<ConversationBackendDriver["create"]>(
    async (input) => ({
      backendConversationId: input.requestedBackendConversationId!,
      reconciliationToken: "create-token",
      opaqueBindingDetail: "neutral-detail",
    }),
  );
  readonly submit = vi.fn<
    (input: SubmitTurnInput) => Promise<SubmitTurnResult>
  >(async (input) => ({
    accepted: true,
    reconciliationToken: input.reconciliationToken,
    completionCorrelation: input.applicationOperationId,
    backendTurnId: `backend-${input.mutationId}`,
  }));
  readonly reconcile = vi.fn<ConversationBackendDriver["reconcileSubmission"]>(
    async () => ({ status: "unresolved", diagnostic: { text: "unresolved" } }),
  );
  readonly resolveCheckpoint = vi.fn<
    ConversationBackendDriver["resolveBranchCheckpoint"]
  >(async () => ({
    backendInstanceId: this.instance.id,
    kind: "conversation_leaf",
    opaqueReference: "neutral-source-leaf",
  }));
  readonly branch = vi.fn<ConversationBackendDriver["branchConversation"]>(
    async (input) => ({
      backendConversationId: input.requestedBackendConversationId!,
      reconciliationToken: "branch-token",
      opaqueBindingDetail: "neutral-detail",
    }),
  );
  readonly attach = vi.fn<ConversationBackendDriver["attach"]>(
    async ({ binding }) => this.#handle(binding),
  );
  readonly close = vi.fn(async () => undefined);
  readonly captureAnchor = vi.fn(async () => '{"version":1,"position":"idle"}');
  readonly perform = vi.fn<ConversationHandle["perform"]>(async () => ({
    accepted: true,
  }));
  readonly reconcileAction = vi.fn<ConversationHandle["reconcileAction"]>(
    async () => ({ outcome: "not_applied" }),
  );
  onCreateBoundary: (() => void) | undefined;
  onSubmitBoundary: (() => void) | undefined;

  constructor(
    readonly instance: AgentBackendInstance,
    readonly connection: AgentConnectionProfile,
  ) {}

  asDriver(): ConversationBackendDriver {
    return {
      instance: this.instance,
      connection: this.connection,
      health: async () => ({
        available: true,
        checkedAt: new Date(0).toISOString(),
      }),
      catalog: async () => ({
        models: [],
        commands: [],
        skills: this.catalogSkills,
        notices: [],
      }),
      discover: async () => ({ conversations: [] }),
      create: async (input) => {
        this.onCreateBoundary?.();
        return this.create(input);
      },
      attach: this.attach,
      read: async () => {
        throw new Error("not used");
      },
      resolveBranchCheckpoint: this.resolveCheckpoint,
      branchConversation: this.branch,
      reconcileSubmission: (input) => this.reconcile(input),
    };
  }

  #handle(binding: ConversationHandle["binding"]): ConversationHandle {
    return {
      binding,
      establishProjection: async () => {
        return {
          handleSequence: -1,
          snapshot: {
            orderedBackendTurnIds: [],
            turnsById: {},
            itemsById: {},
            runState: "idle",
          },
          history: { operational: true },
          subscribeFromNext: () => () => undefined,
        };
      },
      history: async () => ({
        orderedBackendTurnIds: [],
        turnsById: {},
        itemsById: {},
      }),
      locateTurn: async () => ({ status: "not_found" }),
      backendCapabilities: async () => ({
        revision: "1",
        actions: [],
        deliveryModes: ["submit"],
        steerTarget: null,
        composerAttachments: { fileStaging: false, nativeImage: false },
        nonblockingQuestions: false,
        providerOutputArtifacts: { nativeImage: false },
        supportsHistory: true,
        branching: {
          availability: "unavailable",
          reason: { text: "Branching is unavailable in this fixture." },
        },
        interactionKinds: [],
        usageAccounting: "supported" as const, usageSections: [],
        effectiveSettings: {},
      }),
      usage: async () => ({}),
      captureSubmissionRetryAnchor: this.captureAnchor,
      submit: async (input) => {
        this.onSubmitBoundary?.();
        return this.submit(input);
      },
      steer: async () => ({
        status: "accepted" as const,
        reconciliationToken: "unused",
        completionCorrelation: "unused",
        backendTurnId: "unused-backend-turn",
      }),
      interrupt: async () => undefined,
      reconcileInterrupt: async () => ({ outcome: "not_applied" }),
      perform: this.perform,
      reconcileAction: this.reconcileAction,
      respond: async () => undefined,
      reconcileInteractionResponse: async () => ({
        outcome: "not_applied",
      }),
      subscribe: () => () => undefined,
      close: this.close,
    };
  }
}

class SqliteNeutralPersistence implements BackendThreadPersistenceAdapter {
  failBoundDetailSave = false;
  initializationPlan: readonly RegisteredBackendActionInput[] = [];

  constructor(readonly database: Database.Database) {
    database.exec(`
      CREATE TABLE neutral_settings(
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        PRIMARY KEY(tenant_id, principal_id, thread_id)
      ) STRICT;
      CREATE TABLE neutral_binding_details(
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        detail TEXT NOT NULL,
        PRIMARY KEY(tenant_id, principal_id, thread_id)
      ) STRICT;
      CREATE TABLE neutral_submission_intents(
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        application_operation_id TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        reconciliation_token TEXT NOT NULL,
        PRIMARY KEY(tenant_id, principal_id, thread_id, mutation_id)
      ) STRICT;
    `);
  }

  initializeThread(
    scope: RequestScope,
    applicationThreadId: string,
    _connection: AgentConnectionProfile,
  ): void {
    this.database
      .prepare("INSERT INTO neutral_settings VALUES (?, ?, ?)")
      .run(scope.tenantId, scope.principalId, applicationThreadId);
  }

  initializeNewThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): void {
    this.initializeThread(scope, applicationThreadId, connection);
  }

  initializeForkThread(
    scope: RequestScope,
    _sourceApplicationThreadId: string,
    childApplicationThreadId: string,
    connection: AgentConnectionProfile,
    _effectiveSettings: BackendEffectiveSettings,
  ): void {
    this.initializeThread(scope, childApplicationThreadId, connection);
  }

  readForkSettings(
    _scope: RequestScope,
    _childApplicationThreadId: string,
  ): BackendEffectiveSettings {
    return { toolAccess: "full" };
  }

  validateInitialization(): void {}

  initializationActions(): readonly RegisteredBackendActionInput[] {
    return this.initializationPlan;
  }

  recordSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly applicationOperationId: string;
      readonly mutationId: string;
      readonly reconciliationToken: string;
    },
  ): void {
    const current = this.database
      .prepare(
        `
          SELECT application_operation_id AS applicationOperationId,
            reconciliation_token AS reconciliationToken
          FROM neutral_submission_intents
          WHERE tenant_id = ? AND principal_id = ?
            AND thread_id = ? AND mutation_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.mutationId,
      ) as
      | {
          applicationOperationId: string;
          reconciliationToken: string;
        }
      | undefined;
    if (current) {
      if (
        current.applicationOperationId !== input.applicationOperationId ||
        current.reconciliationToken !== input.reconciliationToken
      ) {
        throw new Error("submission intent conflict");
      }
      return;
    }
    this.database
      .prepare(
        `
          INSERT INTO neutral_submission_intents(
            tenant_id, principal_id, thread_id, attempt_id,
            application_operation_id, mutation_id, reconciliation_token
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        attemptId,
        input.applicationOperationId,
        input.mutationId,
        input.reconciliationToken,
      );
  }

  hasSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    applicationOperationId: string,
  ): boolean {
    const found = this.database
      .prepare(
        `
          SELECT 1
          FROM neutral_submission_intents
          WHERE tenant_id = ? AND principal_id = ?
            AND thread_id = ? AND attempt_id = ?
            AND application_operation_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        attemptId,
        applicationOperationId,
      );
    return found !== undefined;
  }

  saveBoundBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
    opaqueBindingDetail: string,
  ): void {
    if (this.failBoundDetailSave) throw new Error("bound detail save failed");
    this.database
      .prepare("INSERT INTO neutral_binding_details VALUES (?, ?, ?, ?)")
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        opaqueBindingDetail,
      );
  }
}

type Fixture = {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly service: ConversationLifecycleService;
  readonly driver: NeutralDriver;
  readonly backendPersistence: SqliteNeutralPersistence;
  readonly workspaceId: string;
  readonly secondWorkspaceId: string;
  readonly creation: ConversationCreationRepository;
  readonly bindings: ConversationBindingRepository;
  readonly drafts: ConversationDraftRepository;
  readonly completion: SubmissionCompletionRepository;
  readonly actors: ConversationActorManager;
  readonly environments: ExecutionEnvironmentProvider;
  readonly registry: AgentBackendRegistry;
  readonly targets: ConversationLifecycleTargetResolver;
  readonly resolved: ResolvedLifecycleTarget;
};

function fixture(input?: {
  readonly creationIdentity?:
    | typeof APPLICATION_ASSIGNED_CREATION_IDENTITY
    | typeof PROVIDER_ASSIGNED_CREATION_IDENTITY;
}): Fixture {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const oldInventory = new ThreadInventoryService(
    new OverlayRepository(database),
  );
  const environment = oldInventory.getLocalEnvironment(scope);
  const workspace = oldInventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/lifecycle",
      displayName: "Lifecycle",
      availability: "available",
      trustState: "trusted",
    },
    10,
  );
  const secondWorkspace = oldInventory.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/lifecycle-second",
      displayName: "Lifecycle second",
      availability: "available",
      trustState: "trusted",
    },
    11,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 20,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const profile = new BackendConfigurationRepository(database).listProfiles(
    scope,
  )[0]!;
  const instance: AgentBackendInstance = {
    id: "lifecycle-backend",
    tenantId: scope.tenantId,
    kind: "pi",
    label: "Lifecycle backend",
    enabled: true,
    configurationRevision: 0,
    protocolRelease: "0.86.0",
  };
  const connection: AgentConnectionProfile = {
    ...profile,
    enabled: profile.enabled === 1,
  };
  const resolved: ResolvedLifecycleTarget = {
    connection,
    title: "Lifecycle draft",
    workspace: {
      canonicalPath: "/tmp/lifecycle",
      authorityRevision: 0,
      summary: {
        id: workspace.id,
        environmentId: environment.id,
        displayName: "Lifecycle",
        displayPath: "/tmp/lifecycle",
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
    },
  };
  const secondResolved: ResolvedLifecycleTarget = {
    ...resolved,
    workspace: {
      canonicalPath: "/tmp/lifecycle-second",
      authorityRevision: 0,
      summary: {
        id: secondWorkspace.id,
        environmentId: environment.id,
        displayName: "Lifecycle second",
        displayPath: "/tmp/lifecycle-second",
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
    },
  };
  const targets: ConversationLifecycleTargetResolver = {
    resolveNew: async (_scope, target) =>
      target.workspaceId === secondWorkspace.id ? secondResolved : resolved,
    resolve: async () => resolved,
  };
  const driver = new NeutralDriver(instance, connection);
  const registry = new AgentBackendRegistry();
  registry.register({
    scope,
    instance,
    connectionKinds: [connection.kind],
    supportsConversationCreation: true,
    creationIdentity:
      input?.creationIdentity ?? APPLICATION_ASSIGNED_CREATION_IDENTITY,
    create: () => driver.asDriver(),
  });
  const bindings = new ConversationBindingRepository(database);
  const creation = new ConversationCreationRepository(database);
  const drafts = new ConversationDraftRepository(database);
  const completion = new SubmissionCompletionRepository(database);
  const backendPersistence = new SqliteNeutralPersistence(database);
  const environments: ExecutionEnvironmentProvider = {
    listEnvironments: async () => [],
    directoryBrowsingAvailability: () => "unavailable",
    browseDirectories: async () => {
      throw new Error("not used");
    },
    validateWorkspace: async () => resolved.workspace,
    revalidateWorkspace: async () => resolved.workspace,
    acquireLease: async () => ({
      scope,
      environment: {
        id: environment.id,
        label: "Local",
        availability: "available",
        diagnosticCode: null,
        revision: 0,
      },
      workspace: resolved.workspace,
      release: async () => undefined,
    }),
    executeCommand: async () => {
      throw new Error("not used");
    },
  };
  const actors = new ConversationActorManager({
    environments,
    attachmentDelivery: {} as never,
    retentionMilliseconds: 0,
    runtimeBudget: 8,
  });
  let now = 1_000;
  const service = new ConversationLifecycleService({
    registry,
    targets,
    backendPersistence: new Map([[instance.id, backendPersistence]]),
    bindings,
    creation,
    drafts,
    completion,
    actors,
    now: () => ++now,
    id: () => "generated-attempt",
  });
  return {
    database,
    scope,
    service,
    driver,
    backendPersistence,
    workspaceId: workspace.id,
    secondWorkspaceId: secondWorkspace.id,
    creation,
    bindings,
    drafts,
    completion,
    actors,
    environments,
    registry,
    targets,
    resolved,
  };
}

function restartLifecycle(current: Fixture): {
  readonly service: ConversationLifecycleService;
  readonly actors: ConversationActorManager;
} {
  const actors = new ConversationActorManager({
    environments: current.environments,
    attachmentDelivery: {} as never,
    retentionMilliseconds: 0,
    runtimeBudget: 8,
  });
  let now = 10_000;
  return {
    actors,
    service: new ConversationLifecycleService({
      registry: current.registry,
      targets: current.targets,
      backendPersistence: new Map([
        [current.driver.instance.id, current.backendPersistence],
      ]),
      bindings: current.bindings,
      creation: current.creation,
      drafts: current.drafts,
      completion: current.completion,
      actors,
      now: () => ++now,
      id: () => "restarted-generated-attempt",
    }),
  };
}

async function createDraft(fixture: Fixture, id: string) {
  return fixture.service.createServerDraft(fixture.scope, {
    id,
    workspaceId: fixture.workspaceId,
    connectionProfileId: fixture.driver.connection.id,
    title: "Lifecycle draft",
    initialText: "hello from durable draft",
  });
}

describe("ConversationLifecycleService", () => {
  it("atomically records immutable Saved Agent thread provenance", async () => {
    const current = fixture();
    try {
      const created = await current.service.createServerDraft(current.scope, {
        workspaceId: current.workspaceId,
        connectionProfileId: current.driver.connection.id,
        title: "Saved Agent origin",
        savedAgentOrigin: {
          agentId: "10101010-1010-4010-8010-101010101010",
          agentRevision: 7,
          agentName: "Careful Agent",
        },
        bootstrap: {
          backendAdapter: { initializeNewThread: vi.fn() } as never,
          backendConfiguration: {} as never,
          assertDurableFences: () => undefined,
        },
      });

      expect(
        current.database
          .prepare(
            `SELECT agent_id AS agentId, agent_revision AS agentRevision,
              agent_name AS agentName
             FROM thread_saved_agent_origins
             WHERE tenant_id = ? AND owner_principal_id = ? AND thread_id = ?`,
          )
          .get(
            current.scope.tenantId,
            current.scope.principalId,
            created.applicationThreadId,
          ),
      ).toEqual({
        agentId: "10101010-1010-4010-8010-101010101010",
        agentRevision: 7,
        agentName: "Careful Agent",
      });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("atomically records tool-created draft origins on simple and bootstrap paths", async () => {
    const current = fixture();
    try {
      const source = await createDraft(
        current,
        "01010101-0101-4101-8101-010101010101",
      );
      const clientId = "02020202-0202-4202-8202-020202020202";
      const environmentId = current.resolved.connection.executionEnvironmentId;
      new PrincipalAgentToolClientRepository(
        current.database,
        createPrincipalAgentToolClientEligibility(),
      ).create(current.scope, {
        id: clientId,
        creationRequestId: "03030303-0303-4303-8303-030303030303",
        name: "Lifecycle client",
        enabled: true,
        toolIds: ["thread.create"],
        defaultEnvironmentId: environmentId,
        allowedEnvironmentIds: [environmentId],
        credentialGeneration: 1,
        credentialVerifier: new Uint8Array(32).fill(1),
        now: 1_100,
      });
      const simple = await current.service.createServerDraft(current.scope, {
        workspaceId: current.workspaceId,
        connectionProfileId: current.driver.connection.id,
        title: "Tool-created simple draft",
        toolCreationOrigin: {
          initiator: {
            kind: "thread_agent",
            sourceThreadId: source.applicationThreadId,
            sourceWorkspaceId: current.workspaceId,
          },
          mutationId: "thread-agent-create-mutation",
        },
      });
      const bootstrap = await current.service.createServerDraft(current.scope, {
        workspaceId: current.workspaceId,
        connectionProfileId: current.driver.connection.id,
        title: "Tool-created bootstrap draft",
        toolCreationOrigin: {
          initiator: { kind: "principal_client", clientId },
          mutationId: "principal-client-create-mutation",
        },
        bootstrap: {
          backendAdapter: {
            initializeNewThread: vi.fn(),
          } as never,
          backendConfiguration: {} as never,
          assertDurableFences: () => undefined,
        },
      });
      expect(
        current.database
          .prepare(
            `SELECT thread_id AS threadId, initiator_kind AS initiatorKind,
              initiating_agent_thread_id AS agentThreadId,
              initiating_tool_client_id AS clientId,
              creation_mutation_id AS mutationId
             FROM thread_tool_creation_origins
             ORDER BY creation_mutation_id`,
          )
          .all(),
      ).toEqual([
        {
          threadId: bootstrap.applicationThreadId,
          initiatorKind: "principal_client",
          agentThreadId: null,
          clientId,
          mutationId: "principal-client-create-mutation",
        },
        {
          threadId: simple.applicationThreadId,
          initiatorKind: "thread_agent",
          agentThreadId: source.applicationThreadId,
          clientId: null,
          mutationId: "thread-agent-create-mutation",
        },
      ]);
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("starts an agent-control first send without consuming the target composer draft", async () => {
    const current = fixture();
    try {
      const source = await createDraft(
        current,
        "10101010-1010-4010-8010-101010101010",
      );
      const target = await createDraft(
        current,
        "20202020-2020-4020-8020-202020202020",
      );
      const before = current.drafts.get(
        current.scope,
        target.applicationThreadId,
      );

      const result = await current.service.startAgentControlFirstSend(
        current.scope,
        target.applicationThreadId,
        {
          initiatingAgentThreadId: source.applicationThreadId,
          prompt: "agent-originated first message",
          mutationId: "agent-control-first-send",
          expectedThreadRevision: 0,
        },
      );

      expect(result.status).toBe("bound");
      expect(
        current.drafts.get(current.scope, target.applicationThreadId),
      ).toEqual(before);
      expect(
        current.creation.findByMutationId(
          current.scope,
          "agent-control-first-send",
        ),
      ).toMatchObject({
        sourceKind: "agent_control",
        initiatingAgentThreadId: source.applicationThreadId,
        initialInputText: "agent-originated first message",
        consumedDraftRevision: null,
      });
      expect(current.driver.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Agent message from Lifecycle draft:\n\nagent-originated first message",
        }),
      );
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("registers an agent-control callback in the first-send admission transaction", async () => {
    const current = fixture();
    try {
      const source = await createDraft(
        current,
        "30303030-3030-4030-8030-303030303030",
      );
      const target = await createDraft(
        current,
        "40404040-4040-4040-8040-404040404040",
      );
      const completionCallback = {
        id: "50505050-5050-4050-8050-505050505050",
        callerThreadId: source.applicationThreadId,
      };
      const input = {
        initiatingAgentThreadId: source.applicationThreadId,
        completionCallback,
        prompt: "agent-originated callback first message",
        mutationId: "agent-control-callback-first-send",
        expectedThreadRevision: 0,
      };

      await expect(
        current.service.startAgentControlFirstSend(
          current.scope,
          target.applicationThreadId,
          input,
        ),
      ).resolves.toMatchObject({ status: "bound" });

      expect(
        current.database
          .prepare(
            `SELECT id, caller_thread_id AS callerThreadId,
                    target_thread_id AS targetThreadId,
                    target_operation_id AS targetOperationId, state
             FROM thread_completion_callbacks`,
          )
          .all(),
      ).toEqual([
        {
          id: completionCallback.id,
          callerThreadId: source.applicationThreadId,
          targetThreadId: target.applicationThreadId,
          targetOperationId: input.mutationId,
          state: "registered",
        },
      ]);
      await expect(
        current.service.startAgentControlFirstSend(
          current.scope,
          target.applicationThreadId,
          input,
        ),
      ).resolves.toMatchObject({ status: "bound" });
      await expect(
        current.service.startAgentControlFirstSend(
          current.scope,
          target.applicationThreadId,
          { ...input, completionCallback: undefined },
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("rolls back first-send admission when callback registration fails", async () => {
    const current = fixture();
    try {
      const source = await createDraft(
        current,
        "60606060-6060-4060-8060-606060606060",
      );
      const target = await createDraft(
        current,
        "70707070-7070-4070-8070-707070707070",
      );

      await expect(
        current.service.startAgentControlFirstSend(
          current.scope,
          target.applicationThreadId,
          {
            initiatingAgentThreadId: source.applicationThreadId,
            completionCallback: {
              id: "invalid-callback-id",
              callerThreadId: source.applicationThreadId,
            },
            prompt: "must remain atomic",
            mutationId: "invalid-callback-first-send",
            expectedThreadRevision: 0,
          },
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(
        current.creation.findByMutationId(
          current.scope,
          "invalid-callback-first-send",
        ),
      ).toBeUndefined();
      expect(
        current.bindings.getTarget(current.scope, target.applicationThreadId),
      ).toMatchObject({ backingState: "unbound" });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("cancels callbacks in the durable abort transition and repairs an aborted replay", async () => {
    const current = fixture();
    try {
      const source = await createDraft(
        current,
        "80808080-8080-4080-8080-808080808080",
      );
      const target = await createDraft(
        current,
        "90909090-9090-4090-8090-909090909090",
      );
      const callbackId = "a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0";
      const mutationId = "agent-control-aborted-callback-send";
      const attempt = current.creation.prepare(
        current.scope,
        target.applicationThreadId,
        {
          attemptId: "aborted-callback-attempt",
          mutationId,
          expectedThreadRevision: 0,
          creationKind: "first_input",
          sourceKind: "agent_control",
          initiatingAgentThreadId: source.applicationThreadId,
          completionCallback: {
            id: callbackId,
            callerThreadId: source.applicationThreadId,
          },
          initialInputText: "abort before provider work",
          initialAttachmentIds: [],
          backendCreationCorrelation: "aborted-callback-correlation",
          now: 2_000,
        },
      );

      current.creation.abortProvenUnpersisted(
        current.scope,
        target.applicationThreadId,
        attempt.attemptId,
        { expected: "prepared", now: 2_001 },
      );
      const callback = (id: string) =>
        current.database
          .prepare(
            `SELECT state, cancellation_reason AS cancellationReason,
                    cancellation_mutation_id AS cancellationMutationId
             FROM thread_completion_callbacks WHERE id = ?`,
          )
          .get(id);
      expect(callback(callbackId)).toEqual({
        state: "cancelled",
        cancellationReason:
          "The target send aborted before authoritative acceptance.",
        cancellationMutationId: `${callbackId}:target_send_aborted`,
      });

      // Seed a valid stranded state without weakening immutable callback
      // transitions: an already-aborted legacy attempt followed by the old
      // out-of-transaction registration ordering.
      const repairTarget = await createDraft(
        current,
        "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0",
      );
      const repairCallbackId = "c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0";
      const repairMutationId = "stranded-aborted-callback-send";
      const repairAttempt = current.creation.prepare(
        current.scope,
        repairTarget.applicationThreadId,
        {
          attemptId: "stranded-aborted-callback-attempt",
          mutationId: repairMutationId,
          expectedThreadRevision: 0,
          creationKind: "first_input",
          sourceKind: "agent_control",
          initiatingAgentThreadId: source.applicationThreadId,
          initialInputText: "repair callback after aborted replay",
          initialAttachmentIds: [],
          backendCreationCorrelation: "stranded-aborted-correlation",
          now: 2_002,
        },
      );
      current.creation.abortProvenUnpersisted(
        current.scope,
        repairTarget.applicationThreadId,
        repairAttempt.attemptId,
        { expected: "prepared", now: 2_003 },
      );
      new ThreadCompletionCallbackRepository(current.database).register(
        current.scope,
        {
          id: repairCallbackId,
          callerThreadId: source.applicationThreadId,
          targetThreadId: repairTarget.applicationThreadId,
          targetOperationId: repairMutationId,
          registeredAt: 2_004,
        },
      );
      expect(callback(repairCallbackId)).toMatchObject({ state: "registered" });
      await expect(
        current.service.startAgentControlFirstSend(
          current.scope,
          repairTarget.applicationThreadId,
          {
            initiatingAgentThreadId: source.applicationThreadId,
            completionCallback: {
              id: repairCallbackId,
              callerThreadId: source.applicationThreadId,
            },
            prompt: "repair callback after aborted replay",
            mutationId: repairMutationId,
            expectedThreadRevision: 0,
          },
        ),
      ).resolves.toMatchObject({ status: "aborted" });
      expect(callback(repairCallbackId)).toMatchObject({ state: "cancelled" });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("rolls back draft creation when a Saved Agent durability fence fails", async () => {
    const current = fixture();
    const initializeNewThread = vi.fn();
    try {
      const before = current.database
        .prepare("SELECT count(*) AS count FROM application_threads")
        .get() as { count: number };

      await expect(
        current.service.createServerDraft(current.scope, {
          workspaceId: current.workspaceId,
          connectionProfileId: current.driver.connection.id,
          title: "Stale Saved Agent",
          bootstrap: {
            backendAdapter: { initializeNewThread } as never,
            backendConfiguration: {} as never,
            assertDurableFences: (transaction) => {
              transaction.assertActive();
              throw new DomainError(
                "conflict",
                "The Saved Agent changed while its thread was created.",
              );
            },
          },
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      const after = current.database
        .prepare("SELECT count(*) AS count FROM application_threads")
        .get() as { count: number };
      expect(after.count).toBe(before.count);
      expect(initializeNewThread).not.toHaveBeenCalled();
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("atomically rolls back backend and tool-policy bootstrap writes", async () => {
    const current = fixture();
    current.database.exec(
      "CREATE TABLE saved_agent_bootstrap_test (kind TEXT NOT NULL)",
    );
    try {
      await expect(
        current.service.createServerDraft(current.scope, {
          workspaceId: current.workspaceId,
          connectionProfileId: current.driver.connection.id,
          title: "Atomic Saved Agent",
          bootstrap: {
            backendAdapter: {
              initializeNewThread: ({
                transaction,
              }: {
                transaction: {
                  assertActive(): void;
                  database: Database.Database;
                };
              }) => {
                transaction.assertActive();
                transaction.database
                  .prepare(
                    "INSERT INTO saved_agent_bootstrap_test VALUES ('backend')",
                  )
                  .run();
              },
            } as never,
            backendConfiguration: {} as never,
            assertDurableFences: (transaction) => transaction.assertActive(),
            initializeAgentTools: ({ transaction }) => {
              transaction.assertActive();
              transaction.database
                .prepare(
                  "INSERT INTO saved_agent_bootstrap_test VALUES ('tools')",
                )
                .run();
              throw new Error("tool_policy_bootstrap_failed");
            },
          },
        }),
      ).rejects.toThrow("tool_policy_bootstrap_failed");

      expect(
        current.database
          .prepare("SELECT count(*) AS count FROM saved_agent_bootstrap_test")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        current.database
          .prepare(
            "SELECT count(*) AS count FROM application_threads WHERE title = ?",
          )
          .get("Atomic Saved Agent"),
      ).toEqual({ count: 0 });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("replays one blank configuration-copy draft by mutation identity", async () => {
    const current = fixture();
    const initializeNewThread = vi.fn();
    const mutationId = "30303030-3030-4030-8030-303030303030";
    try {
      const source = await createDraft(
        current,
        "40404040-4040-4040-8040-404040404040",
      );
      const input = {
        workspaceId: current.workspaceId,
        connectionProfileId: current.driver.connection.id,
        title: "New thread",
        configurationCopy: {
          sourceApplicationThreadId: source.applicationThreadId,
          mutationId,
        },
        bootstrap: {
          backendAdapter: { initializeNewThread } as never,
          backendConfiguration: {} as never,
          assertDurableFences: (transaction: { assertActive(): void }) =>
            transaction.assertActive(),
        },
      };

      const first = await current.service.createServerDraft(
        current.scope,
        input,
      );
      const replay = await current.service.createServerDraft(
        current.scope,
        input,
      );

      expect(replay.applicationThreadId).toBe(first.applicationThreadId);
      expect(initializeNewThread).toHaveBeenCalledOnce();
      expect(replay.draft).toMatchObject({ text: "", revision: 0 });
      expect(
        current.bindings.getBinding(current.scope, first.applicationThreadId),
      ).toBeUndefined();
      expect(
        current.database
          .prepare(
            "SELECT count(*) AS count FROM application_threads WHERE title = 'New thread'",
          )
          .get(),
      ).toEqual({ count: 1 });

      await current.service.moveServerDraftWorkspace(
        current.scope,
        first.applicationThreadId,
        {
          workspaceId: current.secondWorkspaceId,
          expectedThreadRevision: 0,
          mutationId: "50505050-5050-4050-8050-505050505050",
        },
      );
      expect(
        current.bindings.getTarget(current.scope, first.applicationThreadId)
          .workspaceId,
      ).toBe(current.secondWorkspaceId);
      expect(
        current.service.findThreadConfigurationCopy(current.scope, {
          sourceApplicationThreadId: source.applicationThreadId,
          title: input.title,
          mutationId,
        }),
      ).toMatchObject({
        applicationThreadId: first.applicationThreadId,
        workspaceId: current.workspaceId,
        targetId: current.driver.connection.id,
      });

      await expect(
        current.service.createServerDraft(current.scope, {
          ...input,
          title: "Different title",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("requires backend persistence to share the lifecycle database", async () => {
    const current = fixture();
    const otherDatabase = openOverlayDatabase(":memory:");
    try {
      const otherPersistence = new SqliteNeutralPersistence(otherDatabase);
      expect(
        () =>
          new ConversationLifecycleService({
            registry: current.registry,
            targets: current.targets,
            backendPersistence: new Map([
              [current.driver.instance.id, otherPersistence],
            ]),
            bindings: current.bindings,
            creation: current.creation,
            drafts: current.drafts,
            completion: current.completion,
            actors: current.actors,
          }),
      ).toThrow("must share one database");
    } finally {
      otherDatabase.close();
      await current.actors.close();
      current.database.close();
    }
  });

  it("replays server draft creation idempotently", async () => {
    const current = fixture();
    try {
      const first = await createDraft(
        current,
        "01010101-0101-4101-8101-010101010101",
      );
      const replay = await createDraft(
        current,
        "01010101-0101-4101-8101-010101010101",
      );
      expect(replay).toEqual(first);
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("rejects a draft move resolved outside the request scope", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "02020202-0202-4202-8202-020202020202",
      );
      const confused = new ConversationLifecycleService({
        registry: current.registry,
        targets: {
          ...current.targets,
          resolveNew: async () => ({
            ...current.resolved,
            connection: {
              ...current.resolved.connection,
              tenantId: "another-tenant",
            },
          }),
        },
        backendPersistence: new Map([
          [current.driver.instance.id, current.backendPersistence],
        ]),
        bindings: current.bindings,
        creation: current.creation,
        drafts: current.drafts,
        completion: current.completion,
        actors: current.actors,
      });

      await expect(
        confused.moveServerDraftWorkspace(
          current.scope,
          created.applicationThreadId,
          {
            workspaceId: current.secondWorkspaceId,
            expectedThreadRevision: 0,
            mutationId: "scope-confused-move",
          },
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("materializes an unbound automation thread through the creation lifecycle", async () => {
    const current = fixture();
    try {
      const created = await current.service.createServerDraft(current.scope, {
        id: "01919191-9191-4191-8191-919191919191",
        workspaceId: current.workspaceId,
        connectionProfileId: current.driver.connection.id,
        title: "Scheduled thread",
      });
      const adapter = new ConversationLifecycleAutomationFirstInput(
        current.service,
      );
      const automations = new AutomationRepository(current.database);
      const definition = automations.createDefinition(current.scope, {
        id: "automation-1",
        anchorThreadId: created.applicationThreadId,
        name: "One-shot",
        prompt: "run the scheduled task",
        precheck: null,
        runMode: "same_thread",
        enabled: true,
        schedule: { kind: "date_time", runAt: 5_000 },
        misfirePolicy: "coalesce",
        nextRunAt: 5_000,
        now: 1_000,
      });
      const run = automations.createManualRun(current.scope, definition.id, {
        occurrenceKey: "manual:first",
        scheduledFor: 2_000,
        claimToken: "first-claim",
        leaseExpiresAt: 3_000,
        dispatchMutationId: "automation-first-input",
        now: 2_000,
      }).run;
      const input = {
        scope: current.scope,
        applicationThreadId: created.applicationThreadId,
        automationId: definition.id,
        automationRunId: run.id,
        prompt: "run the scheduled task",
        contextExcerpts: [] as const,
        attachmentIds: [] as const,
        taskReferences: [] as const,
        mutationId: "automation-first-input",
        expectedThreadRevision: 0,
      };

      await expect(adapter.submit(input)).resolves.toEqual({
        status: "accepted",
      });
      await expect(adapter.submit(input)).resolves.toEqual({
        status: "accepted",
      });
      expect(current.driver.create).toHaveBeenCalledTimes(1);
      expect(current.driver.submit).toHaveBeenCalledTimes(1);
      expect(current.driver.create).toHaveBeenCalledWith(
        expect.objectContaining({
          source: {
            kind: "automation",
            automationId: input.automationId,
            automationRunId: input.automationRunId,
          },
        }),
      );
      expect(current.driver.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          source: {
            kind: "automation",
            automationId: input.automationId,
            automationRunId: input.automationRunId,
          },
        }),
      );
      expect(
        current.creation.findByMutationId(current.scope, input.mutationId),
      ).toMatchObject({
        sourceKind: "automation",
        sourceAutomationId: input.automationId,
        sourceAutomationRunId: input.automationRunId,
        initialInputText: input.prompt,
        phase: "bound",
      });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("persists and submits a selected skill as the complete first composer input", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "01818181-8181-4181-8181-818181818182",
      );
      current.driver.catalogSkills.push({
        id: "opaque-review-skill",
        name: "review",
        reference: "/skill:review",
      });
      const draft = current.drafts.save(
        current.scope,
        created.applicationThreadId,
        {
          text: "",
          selectedSkillId: "opaque-review-skill",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferenceIds: [],
          expectedRevision: 0,
          now: 2_000,
        },
      );

      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "first-skill-attempt",
            mutationId: "first-skill-operation",
            expectedThreadRevision: 0,
            expectedDraftRevision: draft.revision,
          },
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "",
          selectedSkillId: "opaque-review-skill",
        }),
      );
      expect(
        current.creation.findByMutationId(
          current.scope,
          "first-skill-operation",
        ),
      ).toMatchObject({
        initialInputText: "",
        initialSkillId: "opaque-review-skill",
        phase: "bound",
      });
      expect(
        current.drafts.get(current.scope, created.applicationThreadId),
      ).toMatchObject({ text: "", selectedSkillId: null, revision: 2 });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("persists and submits annotated context without ordinary prompt text", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "01818181-8181-4181-8181-818181818183",
      );
      const excerpt = {
        id: "018f47cb-5f45-7f93-8d8d-bdb808b1f012",
        excerpt: "const answer = 42;",
        note: "Explain why this value is correct.",
        source: {
          kind: "conversation_message" as const,
          itemId: "normalized-assistant-message-1",
          itemRevision: 6,
        },
        locator: {
          kind: "text_quote" as const,
          prefix: "The result is ",
          suffix: ".",
        },
      };
      const draft = current.drafts.save(
        current.scope,
        created.applicationThreadId,
        {
          text: "",
          contextExcerpts: [excerpt],
          attachmentIds: [],
          taskReferenceIds: [],
          expectedRevision: 0,
          now: 2_000,
        },
      );

      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "first-context-attempt",
            mutationId: "first-context-operation",
            expectedThreadRevision: 0,
            expectedDraftRevision: draft.revision,
          },
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.submit).toHaveBeenCalledWith(
        expect.objectContaining({ text: "", contextExcerpts: [excerpt] }),
      );
      expect(
        current.creation.findByMutationId(
          current.scope,
          "first-context-operation",
        ),
      ).toMatchObject({
        initialInputText: "",
        initialContextExcerpts: [excerpt],
        phase: "bound",
      });
      expect(
        current.drafts.get(current.scope, created.applicationThreadId),
      ).toMatchObject({ text: "", contextExcerpts: [], revision: 2 });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("binds when reconciliation proves acceptance without an exact turn", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "01414141-4141-4141-8141-414141414141",
      );
      current.driver.submit.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "outcome unknown",
        }),
      );
      await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "missing-turn-attempt",
          mutationId: "missing-turn-operation",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      current.driver.reconcile.mockResolvedValueOnce({ status: "accepted" });

      const result = await current.service.recoverFirstSend(
        current.scope,
        created.applicationThreadId,
        "missing-turn-attempt",
      );
      expect(result).toMatchObject({ status: "bound" });
      expect(
        current.bindings.getBinding(current.scope, created.applicationThreadId),
      ).toBeDefined();
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("refuses to create in a workspace that differs from the durable target", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "02020202-0202-4202-8202-020202020202",
      );
      (
        current.resolved.workspace as {
          summary: ResolvedLifecycleTarget["workspace"]["summary"];
        }
      ).summary = {
        ...current.resolved.workspace.summary,
        id: "03030303-0303-4303-8303-030303030303",
      };
      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-workspace-mismatch",
            mutationId: "operation-workspace-mismatch",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({ status: "aborted" });
      expect(current.driver.create).not.toHaveBeenCalled();
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("refuses to create when the resolved canonical workspace path drifts", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "03030303-0303-4303-8303-030303030303",
      );
      (
        current.resolved.workspace as {
          canonicalPath: string;
        }
      ).canonicalPath = "/tmp/a-different-lifecycle-path";

      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-canonical-path-mismatch",
            mutationId: "operation-canonical-path-mismatch",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({ status: "aborted" });
      expect(current.driver.create).not.toHaveBeenCalled();
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("commits prepare and submission intent before boundaries, then binds atomically", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "11111111-1111-4111-8111-111111111111",
      );
      current.driver.onCreateBoundary = () => {
        expect(
          current.creation.get(
            current.scope,
            created.applicationThreadId,
            "attempt-success",
          ).phase,
        ).toBe("external_call_started");
      };
      current.driver.onSubmitBoundary = () => {
        expect(
          current.creation.get(
            current.scope,
            created.applicationThreadId,
            "attempt-success",
          ).phase,
        ).toBe("first_submission_started");
        expect(
          current.database
            .prepare(
              `
                SELECT mutation_id AS mutationId,
                  reconciliation_token AS reconciliationToken
                FROM neutral_submission_intents
                WHERE thread_id = ?
              `,
            )
            .get(created.applicationThreadId),
        ).toEqual({
          mutationId: "operation-success",
          reconciliationToken: "operation-success",
        });
        expect(
          current.creation.get(
            current.scope,
            created.applicationThreadId,
            "attempt-success",
          ).retryAnchor,
        ).toBe('{"version":1,"position":"idle"}');
      };

      const result = await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-success",
          mutationId: "operation-success",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      expect(result).toMatchObject({
        status: "bound",
        binding: { backendConversationId: "generated-attempt" },
      });
      expect(
        current.creation.get(
          current.scope,
          created.applicationThreadId,
          "attempt-success",
        ),
      ).toMatchObject({ phase: "bound", retryAnchor: null });
      expect(
        current.drafts.find(current.scope, created.applicationThreadId),
      ).toMatchObject({ text: "", revision: 1 });
      expect(
        current.completion.get(
          current.scope,
          created.applicationThreadId,
          "operation-success",
        ).acceptedAt,
      ).toBeGreaterThan(0);
      expect(
        current.database
          .prepare(
            "SELECT detail FROM neutral_binding_details WHERE thread_id = ?",
          )
          .get(created.applicationThreadId),
      ).toEqual({ detail: "neutral-detail" });
      expect(current.driver.attach).toHaveBeenCalledTimes(1);
      expect(current.driver.close).not.toHaveBeenCalled();
      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-success",
            mutationId: "operation-success",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.create).toHaveBeenCalledTimes(1);
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("applies durable staged settings before the first submission and safely replays them", async () => {
    const current = fixture();
    let restarted: ReturnType<typeof restartLifecycle> | undefined;
    try {
      const created = await createDraft(
        current,
        "11111111-1111-4111-8111-111111111113",
      );
      const stagedAction: RegisteredBackendActionInput = {
        applicationOperationId:
          "attempt-initial-settings:initial-setting:2:model",
        action: "set_model",
        provider: "anthropic",
        modelId: "claude-sonnet",
      };
      current.backendPersistence.initializationPlan = [stagedAction];
      current.driver.reconcileAction
        .mockResolvedValueOnce({ outcome: "not_applied" })
        .mockResolvedValueOnce({ outcome: "accepted" });
      current.driver.perform.mockRejectedValueOnce(
        new BackendError({
          category: "overloaded",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "Setting application temporarily failed.",
        }),
      );
      const input = {
        attemptId: "attempt-initial-settings",
        mutationId: "operation-initial-settings",
        expectedThreadRevision: 0,
        expectedDraftRevision: 0,
      };

      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          input,
        ),
      ).resolves.toMatchObject({
        status: "recovery_required",
        retryable: true,
        attempt: {
          phase: "recovery_required",
          diagnostic: "Setting application temporarily failed.",
          retryAnchor: null,
        },
      });
      expect(current.driver.submit).not.toHaveBeenCalled();
      expect(
        current.bindings.getTarget(current.scope, created.applicationThreadId)
          .backingState,
      ).toBe("creation_unknown");

      await current.actors.close();
      restarted = restartLifecycle(current);
      await expect(
        restarted.service.recoverFirstSend(
          current.scope,
          created.applicationThreadId,
          input.attemptId,
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.perform).toHaveBeenCalledTimes(1);
      expect(current.driver.perform).toHaveBeenNthCalledWith(1, stagedAction);
      expect(current.driver.reconcileAction).toHaveBeenCalledTimes(2);
      expect(current.driver.reconcileAction).toHaveBeenNthCalledWith(
        1,
        stagedAction,
      );
      expect(current.driver.reconcileAction).toHaveBeenNthCalledWith(
        2,
        stagedAction,
      );
      expect(current.driver.submit).toHaveBeenCalledTimes(1);
      expect(
        current.driver.reconcileAction.mock.invocationCallOrder[1],
      ).toBeLessThan(current.driver.captureAnchor.mock.invocationCallOrder[0]!);
      expect(
        current.driver.captureAnchor.mock.invocationCallOrder[0],
      ).toBeLessThan(current.driver.submit.mock.invocationCallOrder[0]!);
      expect(current.driver.reconcile).not.toHaveBeenCalled();
    } finally {
      await restarted?.actors.close();
      await current.actors.close();
      current.database.close();
    }
  });

  it("persists recovery when retry-anchor capture fails before first submission", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "11111111-1111-4111-8111-111111111112",
      );
      current.driver.captureAnchor.mockRejectedValueOnce(
        new Error("history unavailable"),
      );

      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-anchor-failure",
            mutationId: "operation-anchor-failure",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({
        status: "recovery_required",
        retryable: false,
        attempt: {
          phase: "recovery_required",
          retryAnchor: null,
        },
      });
      expect(
        current.bindings.getTarget(current.scope, created.applicationThreadId)
          .backingState,
      ).toBe("creation_unknown");
      expect(current.driver.submit).not.toHaveBeenCalled();
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("coalesces concurrent replays of the same first-send mutation", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "12121212-1212-4212-8212-121212121212",
      );
      const input = {
        attemptId: "attempt-concurrent-first-send",
        mutationId: "operation-concurrent-first-send",
        expectedThreadRevision: 0,
        expectedDraftRevision: 0,
      };

      const [first, replay] = await Promise.all([
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          input,
        ),
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          input,
        ),
      ]);

      expect(first).toMatchObject({ status: "bound" });
      expect(replay).toEqual(first);
      expect(current.driver.create).toHaveBeenCalledTimes(1);
      expect(current.driver.submit).toHaveBeenCalledTimes(1);
      expect(current.driver.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          reconciliationToken: "operation-concurrent-first-send",
        }),
      );
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("does not accept a driver-invented reconciliation identity", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "13131313-1313-4313-8313-131313131313",
      );
      current.driver.submit.mockResolvedValueOnce({
        accepted: true,
        reconciliationToken: "backend-invented-token",
        completionCorrelation: "operation-token-mismatch",
      });

      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-token-mismatch",
            mutationId: "operation-token-mismatch",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({
        status: "recovery_required",
        attempt: {
          reconciliationToken: "operation-token-mismatch",
        },
      });
      expect(
        current.creation.get(
          current.scope,
          created.applicationThreadId,
          "attempt-token-mismatch",
        ),
      ).toMatchObject({
        reconciliationToken: "operation-token-mismatch",
        retryAnchor: '{"version":1,"position":"idle"}',
      });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("returns a clean create failure to unbound while preserving the draft", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "22222222-2222-4222-8222-222222222222",
      );
      current.driver.create.mockRejectedValueOnce(
        new BackendError({
          category: "rejected",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "creation rejected",
        }),
      );
      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-clean-failure",
            mutationId: "operation-clean-failure",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({ status: "aborted" });
      expect(
        current.creation.get(
          current.scope,
          created.applicationThreadId,
          "attempt-clean-failure",
        ).phase,
      ).toBe("aborted_unpersisted");
      expect(
        current.bindings.getTarget(current.scope, created.applicationThreadId)
          .backingState,
      ).toBe("unbound");
      expect(
        current.drafts.get(current.scope, created.applicationThreadId).text,
      ).toBe("hello from durable draft");
      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-clean-failure",
            mutationId: "operation-clean-failure",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({ status: "aborted" });
      expect(current.driver.create).toHaveBeenCalledTimes(1);
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("replays ambiguous creation with the durable requested conversation ID", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "23232323-2323-4232-8232-232323232323",
      );
      current.driver.create.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "create response lost",
        }),
      );
      const uncertain = await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-create-uncertain",
          mutationId: "operation-create-uncertain",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      expect(uncertain).toMatchObject({
        status: "recovery_required",
        retryable: false,
      });
      const durable = current.creation.get(
        current.scope,
        created.applicationThreadId,
        "attempt-create-uncertain",
      );
      expect(durable.backendCreationCorrelation).toBe("generated-attempt");

      await expect(
        current.service.recoverFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-create-uncertain",
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.create).toHaveBeenCalledTimes(2);
      expect(
        current.driver.create.mock.calls.map(
          ([input]) => input.requestedBackendConversationId,
        ),
      ).toEqual(["generated-attempt", "generated-attempt"]);
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("resumes a prepared attempt without creating a second durable attempt", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "26262626-2626-4262-8262-262626262626",
      );
      current.creation.prepare(current.scope, created.applicationThreadId, {
        attemptId: "attempt-prepared-restart",
        mutationId: "operation-prepared-restart",
        expectedThreadRevision: 0,
        creationKind: "first_input",
        sourceKind: "composer",
        initialInputText: "hello from durable draft",
        initialContextExcerpts: [],
        initialAttachmentIds: [],
        initialTaskReferences: [],
        expectedDraftRevision: 0,
        backendCreationCorrelation: "prepared-native",
        now: 200,
      });
      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-prepared-restart",
            mutationId: "operation-prepared-restart",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.create).toHaveBeenCalledTimes(1);
      expect(
        current.database
          .prepare(
            `
              SELECT count(*) AS count
              FROM conversation_creation_attempts
              WHERE application_thread_id = ?
            `,
          )
          .get(created.applicationThreadId),
      ).toEqual({ count: 1 });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("persists uncertain submission state and reconciles acceptance after restart", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "33333333-3333-4333-8333-333333333333",
      );
      current.driver.submit.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "submission outcome unknown",
        }),
      );
      const uncertain = await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-uncertain",
          mutationId: "operation-uncertain",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      expect(uncertain).toMatchObject({
        status: "recovery_required",
        retryable: false,
        attempt: { phase: "recovery_required" },
      });
      expect(
        current.bindings.getBinding(current.scope, created.applicationThreadId),
      ).toBeUndefined();
      expect(
        current.creation.get(
          current.scope,
          created.applicationThreadId,
          "attempt-uncertain",
        ).provisionalOpaqueBindingDetail,
      ).toBe("neutral-detail");

      current.driver.reconcile.mockResolvedValueOnce({ status: "accepted" });
      await expect(
        current.service.recoverFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-uncertain",
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({
          reconciliationToken: "operation-uncertain",
          retryAnchor: '{"version":1,"position":"idle"}',
        }),
      );
      expect(
        current.drafts.find(current.scope, created.applicationThreadId),
      ).toMatchObject({ text: "", revision: 1 });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("coalesces concurrent recovery of the same uncertain submission", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "39393939-3939-4393-8393-393939393939",
      );
      current.driver.submit.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "submission outcome unknown",
        }),
      );
      await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-concurrent-recovery",
          mutationId: "operation-concurrent-recovery",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );

      let resolveReconciliation!: (
        value: Awaited<
          ReturnType<ConversationBackendDriver["reconcileSubmission"]>
        >,
      ) => void;
      current.driver.reconcile.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReconciliation = resolve;
          }),
      );
      const first = current.service.recoverFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-concurrent-recovery",
      );
      const replay = current.service.recoverFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-concurrent-recovery",
      );
      await vi.waitFor(() => {
        expect(current.driver.reconcile).toHaveBeenCalledTimes(1);
      });
      resolveReconciliation({ status: "accepted" });

      const results = await Promise.all([first, replay]);
      expect(results).toEqual([
        expect.objectContaining({ status: "bound" }),
        expect.objectContaining({ status: "bound" }),
      ]);
      expect(current.driver.reconcile).toHaveBeenCalledTimes(1);
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("rejects a retry arriving behind plain recovery without claiming it", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "40404040-4040-4404-8404-404040404040",
      );
      current.driver.submit.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "submission outcome unknown",
        }),
      );
      await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-recovery-before-retry",
          mutationId: "operation-recovery-before-retry",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );

      let resolveReconciliation!: (
        value: Awaited<
          ReturnType<ConversationBackendDriver["reconcileSubmission"]>
        >,
      ) => void;
      current.driver.reconcile.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReconciliation = resolve;
          }),
      );
      const recovery = current.service.recoverFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-recovery-before-retry",
      );
      await vi.waitFor(() => {
        expect(current.driver.reconcile).toHaveBeenCalledTimes(1);
      });

      await expect(
        current.service.retryFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-recovery-before-retry",
          "retry-after-recovery",
        ),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "First-submission recovery is already in flight.",
      });
      expect(
        current.creation.get(
          current.scope,
          created.applicationThreadId,
          "attempt-recovery-before-retry",
        ).retryMutationId,
      ).toBeNull();
      expect(current.driver.submit).toHaveBeenCalledTimes(1);

      resolveReconciliation({ status: "not_accepted", retryable: true });
      await expect(recovery).resolves.toMatchObject({
        status: "recovery_required",
        retryable: true,
      });
      await expect(
        current.service.retryFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-recovery-before-retry",
          "retry-after-recovery",
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.submit).toHaveBeenCalledTimes(2);
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("does not permit retry until reconciliation durably proves non-acceptance", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "34343434-3434-4343-8343-343434343434",
      );
      current.driver.submit.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "submission outcome unknown",
        }),
      );
      await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-no-unsafe-retry",
          mutationId: "operation-no-unsafe-retry",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      await expect(
        current.service.retryFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-no-unsafe-retry",
          "retry-without-proof",
        ),
      ).rejects.toThrow("not been proven safe");
      expect(current.driver.submit).toHaveBeenCalledTimes(1);
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("durably preserves an authorized retry when staged settings temporarily fail", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "34343434-3434-4343-8343-343434343435",
      );
      current.backendPersistence.initializationPlan = [
        {
          applicationOperationId:
            "attempt-retry-settings:initial-setting:1:model",
          action: "set_model",
          provider: "anthropic",
          modelId: "claude-sonnet",
        },
      ];
      current.driver.submit.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "submission outcome unknown",
        }),
      );
      await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-retry-settings",
          mutationId: "operation-retry-settings",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      current.driver.reconcile.mockResolvedValueOnce({
        status: "not_accepted",
        retryable: true,
      });
      await current.service.recoverFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-retry-settings",
      );
      current.driver.perform.mockRejectedValueOnce(
        new BackendError({
          category: "overloaded",
          retryable: true,
          crossedSubmissionBoundary: false,
          safeMessage: "Setting retry temporarily failed.",
        }),
      );

      await expect(
        current.service.retryFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-retry-settings",
          "retry-settings",
        ),
      ).resolves.toMatchObject({
        status: "recovery_required",
        retryable: true,
        attempt: {
          phase: "recovery_required",
          retryAuthorizedAt: expect.any(Number),
          retryMutationId: null,
          diagnostic: "Setting retry temporarily failed.",
        },
      });

      await expect(
        current.service.retryFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-retry-settings",
          "retry-settings",
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.submit).toHaveBeenCalledTimes(2);
      expect(current.driver.perform).toHaveBeenCalledTimes(3);
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("claims one retry atomically and reconciles replay instead of resubmitting", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "35353535-3535-4353-8353-353535353535",
      );
      current.driver.submit.mockRejectedValueOnce(
        new Error("first response lost"),
      );
      await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-claimed-retry",
          mutationId: "operation-claimed-retry",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      current.driver.reconcile.mockResolvedValueOnce({
        status: "not_accepted",
        retryable: true,
      });
      await current.service.recoverFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-claimed-retry",
      );
      current.driver.submit.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "retry response lost",
        }),
      );
      await expect(
        current.service.retryFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-claimed-retry",
          "claimed-retry",
        ),
      ).resolves.toMatchObject({
        status: "recovery_required",
        retryable: false,
      });
      expect(
        current.creation.get(
          current.scope,
          created.applicationThreadId,
          "attempt-claimed-retry",
        ),
      ).toMatchObject({
        retryMutationId: "claimed-retry",
        retryReconciliationToken: "claimed-retry",
        retryAnchor: '{"version":1,"position":"idle"}',
      });
      current.driver.reconcile.mockResolvedValueOnce({
        status: "unresolved",
        diagnostic: { text: "still unknown" },
      });
      await current.service.retryFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-claimed-retry",
        "claimed-retry",
      );
      expect(current.driver.submit).toHaveBeenCalledTimes(2);
      await expect(
        current.service.retryFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-claimed-retry",
          "different-retry",
        ),
      ).rejects.toThrow("different first-submission retry");
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("does not submit twice when the same authorized retry is requested concurrently", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "38383838-3838-4383-8383-383838383838",
      );
      current.driver.submit.mockRejectedValueOnce(
        new Error("first response lost"),
      );
      await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-concurrent-retry",
          mutationId: "operation-concurrent-retry",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      current.driver.reconcile.mockResolvedValueOnce({
        status: "not_accepted",
        retryable: true,
      });
      await current.service.recoverFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-concurrent-retry",
      );

      let acceptRetry!: (value: SubmitTurnResult) => void;
      current.driver.submit.mockImplementationOnce(
        () =>
          new Promise<SubmitTurnResult>((resolve) => {
            acceptRetry = resolve;
          }),
      );
      const first = current.service.retryFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-concurrent-retry",
        "concurrent-retry",
      );
      await vi.waitFor(() => {
        expect(
          current.creation.get(
            current.scope,
            created.applicationThreadId,
            "attempt-concurrent-retry",
          ).retryMutationId,
        ).toBe("concurrent-retry");
      });
      current.driver.reconcile.mockResolvedValueOnce({
        status: "unresolved",
        diagnostic: { text: "retry remains in flight" },
      });
      const second = current.service.retryFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-concurrent-retry",
        "concurrent-retry",
      );
      let secondFinished = false;
      void second.then(() => {
        secondFinished = true;
      });
      await Promise.resolve();
      expect(secondFinished).toBe(false);
      expect(current.driver.submit).toHaveBeenCalledTimes(2);
      acceptRetry({
        accepted: true,
        reconciliationToken: "concurrent-retry",
        completionCorrelation: "operation-concurrent-retry",
      });
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toMatchObject({ status: "bound" });
      expect(secondResult).toEqual(firstResult);
      expect(current.driver.submit).toHaveBeenCalledTimes(2);
      expect(current.driver.reconcile).toHaveBeenCalledTimes(1);
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("persists accepted backend correlation and completion identity", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "36363636-3636-4363-8363-363636363636",
      );
      current.driver.submit.mockRejectedValueOnce(new Error("response lost"));
      await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-completion-anchor",
          mutationId: "operation-completion-anchor",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      current.driver.reconcile.mockResolvedValueOnce({
        status: "accepted",
        backendTurn: {
          backendTurnId: "backend-turn-99",
          status: "completed",
          orderedBackendItemIds: [],
        },
        completionIdentity: "completion-99",
      });
      await current.service.recoverFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-completion-anchor",
      );
      expect(
        current.completion.get(
          current.scope,
          created.applicationThreadId,
          "operation-completion-anchor",
        ),
      ).toMatchObject({
        backendCorrelation: "operation-completion-anchor",
        lastCompletionIdentity: "completion-99",
        attentionCreatedAt: expect.any(Number),
        acknowledgedAt: null,
      });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("allows a new composer draft after the submitted revision is consumed", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "37373737-3737-4373-8373-373737373737",
      );
      current.creation.prepare(current.scope, created.applicationThreadId, {
        attemptId: "attempt-draft-guard",
        mutationId: "operation-draft-guard",
        expectedThreadRevision: 0,
        creationKind: "first_input",
        sourceKind: "composer",
        initialInputText: "hello from durable draft",
        initialContextExcerpts: [],
        initialAttachmentIds: [],
        initialTaskReferences: [],
        expectedDraftRevision: 0,
        backendCreationCorrelation: "native-draft-guard",
        now: 200,
      });
      expect(
        current.drafts.save(current.scope, created.applicationThreadId, {
          text: "changed",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferenceIds: [],
          expectedRevision: 1,
          now: 201,
        }),
      ).toMatchObject({ text: "changed", revision: 2 });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("preserves a newer composer draft while the first send materializes", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "38383838-3838-4383-8383-383838383838",
      );
      let finishCreate!: (
        result: Awaited<ReturnType<ConversationBackendDriver["create"]>>,
      ) => void;
      current.driver.create.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCreate = resolve;
          }),
      );

      const materialization = current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-preserve-new-draft",
          mutationId: "operation-preserve-new-draft",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      await vi.waitFor(() => {
        expect(current.driver.create).toHaveBeenCalledTimes(1);
      });
      expect(
        current.drafts.get(current.scope, created.applicationThreadId),
      ).toMatchObject({ text: "", revision: 1 });
      current.drafts.save(current.scope, created.applicationThreadId, {
        text: "a later thought",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: 1,
        now: 1_001,
      });
      finishCreate({
        backendConversationId: "generated-attempt",
        reconciliationToken: "create-token",
        opaqueBindingDetail: "neutral-detail",
      });

      await expect(materialization).resolves.toMatchObject({ status: "bound" });
      expect(
        current.drafts.get(current.scope, created.applicationThreadId),
      ).toMatchObject({ text: "a later thought", revision: 2 });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("does not restore consumed text over a newer intentionally blank draft", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "38383838-3838-4383-8383-383838383839",
      );
      let failCreate!: (reason: unknown) => void;
      current.driver.create.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failCreate = reject;
          }),
      );

      const materialization = current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-preserve-blank-draft",
          mutationId: "operation-preserve-blank-draft",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      await vi.waitFor(() => {
        expect(current.driver.create).toHaveBeenCalledTimes(1);
      });
      current.drafts.save(current.scope, created.applicationThreadId, {
        text: "",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [],
        expectedRevision: 1,
        now: 1_500,
      });
      failCreate(
        new BackendError({
          category: "unavailable",
          retryable: true,
          crossedSubmissionBoundary: false,
          safeMessage: "create did not cross the backend boundary",
        }),
      );

      await expect(materialization).resolves.toMatchObject({
        status: "aborted",
      });
      expect(
        current.drafts.get(current.scope, created.applicationThreadId),
      ).toMatchObject({ text: "", revision: 2 });
      expect(
        current.creation.get(
          current.scope,
          created.applicationThreadId,
          "attempt-preserve-blank-draft",
        ).initialInputText,
      ).toBe("hello from durable draft");
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("recovers a prepared creation after its composer draft was consumed", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "38383838-3838-4383-8383-383838383840",
      );
      current.creation.prepare(current.scope, created.applicationThreadId, {
        attemptId: "attempt-prepared-restart",
        mutationId: "operation-prepared-restart",
        expectedThreadRevision: 0,
        creationKind: "first_input",
        sourceKind: "composer",
        initialInputText: "hello from durable draft",
        initialContextExcerpts: [],
        initialAttachmentIds: [],
        initialTaskReferences: [],
        expectedDraftRevision: 0,
        backendCreationCorrelation: "generated-attempt",
        now: 1_001,
      });
      expect(
        current.drafts.get(current.scope, created.applicationThreadId),
      ).toMatchObject({ text: "", revision: 1 });

      await expect(
        current.service.recoverFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-prepared-restart",
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.submit).toHaveBeenCalledWith(
        expect.objectContaining({ text: "hello from durable draft" }),
      );
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("keeps proven-not-accepted recovery durable and supports an explicit retry", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "44444444-4444-4444-8444-444444444444",
      );
      current.driver.submit.mockRejectedValueOnce(new Error("connection lost"));
      await current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-retry",
          mutationId: "operation-retry",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      current.driver.reconcile.mockResolvedValueOnce({
        status: "not_accepted",
        retryable: true,
      });
      await expect(
        current.service.recoverFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-retry",
        ),
      ).resolves.toMatchObject({
        status: "recovery_required",
        retryable: true,
      });
      await expect(
        current.service.recoverFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-retry",
        ),
      ).resolves.toMatchObject({
        status: "recovery_required",
        retryable: true,
        attempt: { retryAnchor: null },
      });
      expect(current.driver.reconcile).toHaveBeenCalledTimes(1);
      await expect(
        current.service.retryFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-retry",
          "retry-mutation",
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.submit).toHaveBeenLastCalledWith({
        applicationOperationId: "operation-retry",
        mutationId: "retry-mutation",
        reconciliationToken: "retry-mutation",
        source: { kind: "user" },
        text: "hello from durable draft",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("reconciles migrated uncertain submissions without a legacy retry anchor", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "44444444-4444-4444-8444-444444444445",
      );
      current.driver.submit.mockRejectedValueOnce(new Error("connection lost"));
      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-legacy-no-anchor",
            mutationId: "operation-legacy-no-anchor",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({ status: "recovery_required" });

      current.database
        .prepare(
          `
            UPDATE conversation_creation_attempts
            SET retry_anchor = NULL
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND attempt_id = ?
              AND phase = 'recovery_required'
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          created.applicationThreadId,
          "attempt-legacy-no-anchor",
        );
      current.driver.reconcile.mockResolvedValueOnce({
        status: "accepted",
      });

      await expect(
        current.service.recoverFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-legacy-no-anchor",
        ),
      ).resolves.toMatchObject({ status: "bound" });
      expect(current.driver.reconcile).toHaveBeenCalledWith({
        scope: current.scope,
        binding: expect.objectContaining({
          applicationThreadId: created.applicationThreadId,
        }),
        opaqueBindingDetail: "neutral-detail",
        workspace: expect.any(Object),
        applicationOperationId: "operation-legacy-no-anchor",
        reconciliationToken: "operation-legacy-no-anchor",
      });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("rolls binding and draft clearing back when bound detail persistence fails", async () => {
    const current = fixture();
    try {
      const created = await createDraft(
        current,
        "55555555-5555-4555-8555-555555555555",
      );
      current.backendPersistence.failBoundDetailSave = true;
      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-promotion",
            mutationId: "operation-promotion",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).rejects.toThrow("bound detail save failed");
      expect(
        current.creation.get(
          current.scope,
          created.applicationThreadId,
          "attempt-promotion",
        ).phase,
      ).toBe("accepted_unpersisted");
      expect(
        current.bindings.getBinding(current.scope, created.applicationThreadId),
      ).toBeUndefined();
      expect(
        current.drafts.get(current.scope, created.applicationThreadId).text,
      ).toBe("");

      current.backendPersistence.failBoundDetailSave = false;
      await expect(
        current.service.recoverFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-promotion",
        ),
      ).resolves.toMatchObject({ status: "bound" });
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("binds provider-assigned identity before the first submission", async () => {
    const current = fixture({
      creationIdentity: PROVIDER_ASSIGNED_CREATION_IDENTITY,
    });
    try {
      const created = await createDraft(
        current,
        "55555555-5555-4555-8555-555555555555",
      );
      const initialTitle: RegisteredBackendActionInput = {
        applicationOperationId: "attempt-provider-bind:initial-title",
        action: "rename",
        title: "Named before first prompt",
      };
      current.backendPersistence.initializationPlan = [initialTitle];
      let boundBeforeInitialization = false;
      let boundBeforeSubmit = false;
      let creationStillGatedBeforeSubmit = false;
      current.driver.reconcileAction.mockImplementation(async () => {
        boundBeforeInitialization =
          current.bindings.getBinding(
            current.scope,
            created.applicationThreadId,
          )?.backendConversationId === "provider-native-1";
        return { outcome: "not_applied" };
      });
      current.driver.submit.mockImplementation(async (input) => {
        const binding = current.bindings.getBinding(
          current.scope,
          created.applicationThreadId,
        );
        boundBeforeSubmit =
          binding?.backendConversationId === "provider-native-1";
        creationStillGatedBeforeSubmit =
          current.bindings.getTarget(current.scope, created.applicationThreadId)
            .backingState === "creating";
        return {
          accepted: true,
          reconciliationToken: input.reconciliationToken,
          completionCorrelation: input.applicationOperationId,
          backendTurnId: `backend-${input.mutationId}`,
        };
      });
      current.driver.create.mockImplementation(async (input) => {
        expect(input.requestedBackendConversationId).toBeUndefined();
        expect(input.creationCorrelation).toEqual(expect.any(String));
        return {
          backendConversationId: "provider-native-1",
          reconciliationToken: "provider-create-token",
          opaqueBindingDetail: "provider-detail",
        };
      });

      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-provider-bind",
            mutationId: "operation-provider-bind",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({
        status: "bound",
        binding: expect.objectContaining({
          backendConversationId: "provider-native-1",
        }),
      });
      expect(boundBeforeSubmit).toBe(true);
      expect(boundBeforeInitialization).toBe(true);
      expect(creationStillGatedBeforeSubmit).toBe(true);
      expect(current.driver.create).toHaveBeenCalledTimes(1);
      expect(current.driver.reconcileAction).toHaveBeenCalledWith(initialTitle);
      expect(current.driver.perform).toHaveBeenCalledWith(initialTitle);
      expect(current.driver.submit).toHaveBeenCalledWith(
        expect.objectContaining({ text: "hello from durable draft" }),
      );
      expect(
        current.bindings.getTarget(current.scope, created.applicationThreadId)
          .backingState,
      ).toBe("bound");
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("joins recovery to an in-flight provider create without discarding its response", async () => {
    const current = fixture({
      creationIdentity: PROVIDER_ASSIGNED_CREATION_IDENTITY,
    });
    try {
      const created = await createDraft(
        current,
        "57575757-5757-4757-8757-575757575757",
      );
      let resolveCreate!: (value: {
        readonly backendConversationId: string;
        readonly reconciliationToken: string;
        readonly opaqueBindingDetail: string;
      }) => void;
      current.driver.create.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      );
      const firstSend = current.service.startFirstSend(
        current.scope,
        created.applicationThreadId,
        {
          attemptId: "attempt-provider-concurrent-recovery",
          mutationId: "operation-provider-concurrent-recovery",
          expectedThreadRevision: 0,
          expectedDraftRevision: 0,
        },
      );
      await vi.waitFor(() => {
        expect(current.driver.create).toHaveBeenCalledTimes(1);
        expect(
          current.creation.get(
            current.scope,
            created.applicationThreadId,
            "attempt-provider-concurrent-recovery",
          ).phase,
        ).toBe("external_call_started");
      });

      const recovery = current.service.recoverFirstSend(
        current.scope,
        created.applicationThreadId,
        "attempt-provider-concurrent-recovery",
      );
      resolveCreate({
        backendConversationId: "provider-native-concurrent",
        reconciliationToken: "provider-create-concurrent-token",
        opaqueBindingDetail: "provider-concurrent-detail",
      });

      await expect(Promise.all([firstSend, recovery])).resolves.toEqual([
        expect.objectContaining({
          status: "bound",
          binding: expect.objectContaining({
            backendConversationId: "provider-native-concurrent",
          }),
        }),
        expect.objectContaining({
          status: "bound",
          binding: expect.objectContaining({
            backendConversationId: "provider-native-concurrent",
          }),
        }),
      ]);
      expect(current.driver.create).toHaveBeenCalledTimes(1);
      expect(current.driver.submit).toHaveBeenCalledTimes(1);
      expect(
        current.creation.get(
          current.scope,
          created.applicationThreadId,
          "attempt-provider-concurrent-recovery",
        ).phase,
      ).toBe("bound");
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it("never replays provider-assigned create after an uncertain start", async () => {
    const current = fixture({
      creationIdentity: PROVIDER_ASSIGNED_CREATION_IDENTITY,
    });
    try {
      const created = await createDraft(
        current,
        "66666666-6666-4666-8666-666666666666",
      );
      current.driver.create.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage: "create response lost",
        }),
      );
      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-provider-unknown",
            mutationId: "operation-provider-unknown",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({
        status: "recovery_required",
        retryable: false,
      });
      expect(
        current.bindings.getTarget(current.scope, created.applicationThreadId)
          .backingState,
      ).toBe("creation_unknown");

      await expect(
        current.service.recoverFirstSend(
          current.scope,
          created.applicationThreadId,
          "attempt-provider-unknown",
        ),
      ).resolves.toMatchObject({
        status: "recovery_required",
        retryable: false,
      });
      expect(current.driver.create).toHaveBeenCalledTimes(1);
      expect(current.driver.submit).not.toHaveBeenCalled();
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });

  it.each([
    {
      contract: "Pi application-assigned",
      creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
      recoverable: true,
    },
    {
      contract: "Codex provider-assigned",
      creationIdentity: PROVIDER_ASSIGNED_CREATION_IDENTITY,
      recoverable: false,
    },
  ] as const)(
    "derives unknown-create recovery from the $contract contract",
    async ({ creationIdentity, recoverable }) => {
      const current = fixture({ creationIdentity });
      try {
        const created = await createDraft(
          current,
          recoverable
            ? "68686868-6868-4868-8868-686868686868"
            : "69696969-6969-4969-8969-696969696969",
        );
        current.driver.create.mockRejectedValueOnce(
          new BackendError({
            category: "submission_unknown",
            retryable: false,
            crossedSubmissionBoundary: true,
            safeMessage: "create response lost",
          }),
        );
        await current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: `attempt-recovery-contract-${String(recoverable)}`,
            mutationId: `operation-recovery-contract-${String(recoverable)}`,
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        );

        const recovery = new DatabaseThreadApplicationRecoveryReader({
          creation: current.creation,
          operations: new ConversationOperationRepository(current.database),
          targets: current.targets,
          registry: current.registry,
          forks: {
            readRecovery: async () => ({ recoverable: false }),
          },
        });
        await expect(
          recovery.read(current.scope, created.applicationThreadId),
        ).resolves.toMatchObject({
          kind: "conversation_creation",
          phase: "recovery_required",
          recoverable,
        });
      } finally {
        await current.actors.close();
        current.database.close();
      }
    },
  );

  it("returns a provider draft to pre-create state when create was not sent", async () => {
    const current = fixture({
      creationIdentity: PROVIDER_ASSIGNED_CREATION_IDENTITY,
    });
    try {
      const created = await createDraft(
        current,
        "77777777-7777-4777-8777-777777777777",
      );
      current.driver.create.mockRejectedValueOnce(
        new BackendError({
          category: "unavailable",
          retryable: true,
          crossedSubmissionBoundary: false,
          safeMessage: "daemon not ready",
        }),
      );
      await expect(
        current.service.startFirstSend(
          current.scope,
          created.applicationThreadId,
          {
            attemptId: "attempt-provider-not-sent",
            mutationId: "operation-provider-not-sent",
            expectedThreadRevision: 0,
            expectedDraftRevision: 0,
          },
        ),
      ).resolves.toMatchObject({ status: "aborted" });
      expect(
        current.bindings.getTarget(current.scope, created.applicationThreadId)
          .backingState,
      ).toBe("unbound");
      expect(
        current.drafts.get(current.scope, created.applicationThreadId).text,
      ).toBe("hello from durable draft");
    } finally {
      await current.actors.close();
      current.database.close();
    }
  });
});
