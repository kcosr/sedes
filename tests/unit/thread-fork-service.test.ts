import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { EnvironmentVariablesService } from "../../src/server/environment-variables/environment-variables-service.js";
import { describe, expect, it, vi } from "vitest";
import {
  BackendError,
  type BranchConversationInput,
} from "../../src/server/backends/contracts.js";
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
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { DeliveryInputSnapshotRepository } from "../../src/server/db/repositories/delivery-input-snapshot-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { PrincipalAgentToolClientRepository } from "../../src/server/db/repositories/principal-agent-tool-client-repository.js";
import { createPrincipalAgentToolClientEligibility } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { DatabaseThreadApplicationRecoveryReader } from "../../src/server/conversations/database-conversation-adapters.js";
import { ThreadForkService } from "../../src/server/conversations/thread-fork-service.js";
import { applicationTurnIdForBackendTurn } from "../../src/server/conversations/conversation-projector.js";
import { codexBackendTurnId } from "../../src/server/backends/codex/codex-history-projector.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";

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

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

type Branching = {
  availability: "available";
  boundaries: [
    "latest_completed",
    "selected_completed_turn",
    "latest_provider_snapshot",
  ];
  method: "provider_native";
  sourceMustBeIdle: false;
  settingsInheritance: "application_applied";
  fidelity: {
    instructions: true;
    messages: true;
    toolCalls: true;
    toolResults: true;
    compaction: true;
    attachments: true;
    settings: true;
    limitations: [];
  };
  childIdentity: "application_reserved" | "provider_assigned";
  creationRecovery:
    "idempotent" | "exactly_reconcilable" | "potentially_unknown";
};

function branching(
  childIdentity: Branching["childIdentity"] = "application_reserved",
  creationRecovery: Branching["creationRecovery"] = "idempotent",
): Branching {
  return {
    availability: "available",
    boundaries: [
      "latest_completed",
      "selected_completed_turn",
      "latest_provider_snapshot",
    ],
    method: "provider_native",
    sourceMustBeIdle: false,
    settingsInheritance: "application_applied",
    fidelity: {
      instructions: true,
      messages: true,
      toolCalls: true,
      toolResults: true,
      compaction: true,
      attachments: true,
      settings: true,
      limitations: [],
    },
    childIdentity,
    creationRecovery,
  };
}

function fixture(withEnvironmentVariables = false) {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/thread-fork-service",
      displayName: "Fork service",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const source = legacy.createThread(
    scope,
    { workspaceId: workspace.id, title: "Source" },
    110,
  ).thread;
  const secondSource = legacy.createThread(
    scope,
    { workspaceId: workspace.id, title: "Second source" },
    120,
  ).thread;
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 200,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const principalClientId = uuid(9_000);
  new PrincipalAgentToolClientRepository(
    database,
    createPrincipalAgentToolClientEligibility(),
  ).create(scope, {
    id: principalClientId,
    creationRequestId: uuid(9_001),
    name: "Fork client",
    enabled: true,
    toolIds: ["thread.fork"],
    defaultEnvironmentId: environment.id,
    allowedEnvironmentIds: [environment.id],
    credentialGeneration: 1,
    credentialVerifier: new Uint8Array(32).fill(9),
    now: 250,
  });

  const bindings = new ConversationBindingRepository(database);
  const creation = new ConversationCreationRepository(database);
  const checkpoints = new BackendCheckpointRepository(database);
  const lineage = new ThreadLineageRepository(database);
  const inventory = new InventoryRepository(database);
  bindings.bindDiscoveredConversation(scope, source.id, {
    backendConversationId: "native-source",
    now: 300,
  });
  bindings.bindDiscoveredConversation(scope, secondSource.id, {
    backendConversationId: "native-second-source",
    now: 301,
  });
  const sourceBackendTurnId = codexBackendTurnId(
    "native-source",
    "native-source-turn",
  );
  const sourceTurnId = applicationTurnIdForBackendTurn({
    backendInstanceId: "pi-primary",
    sourceApplicationThreadId: source.id,
    backendTurnId: sourceBackendTurnId,
  });
  let currentBranching = branching();
  const branchConversation = vi.fn(async (input: BranchConversationInput) => ({
    backendConversationId:
      input.requestedBackendConversationId ?? "provider-child",
    reconciliationToken: "branch-token",
    opaqueBindingDetail: "child-binding-detail",
  }));
  const target = {
    scope,
    binding: {
      ...bindings.getBinding(scope, source.id)!,
      createdAt: new Date(300).toISOString(),
    },
    workspace: {
      summary: {
        id: workspace.id,
        environmentId: environment.id,
        label: { text: "Fork service" },
        displayPath: { text: workspace.canonicalPath },
        available: true,
      },
      canonicalPath: workspace.canonicalPath,
      displayName: "Fork service",
      trustState: "trusted" as const,
    },
    opaqueBindingDetail: "source-binding-detail",
    driver: {
      connection: {
        id: bindings.findThreadDefinition(scope, source.id)!
          .connectionProfileId,
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        templateId: "local-primary",
        kind: "pi_sdk" as const,
        backendInstanceId: "pi-primary",
        executionEnvironmentId: environment.id,
        label: "Local Pi",
        enabled: true,
        configurationRevision: 0,
      },
      branchConversation,
    },
  };
  const resolved = (
    selection:
      | { readonly kind: "latest_provider_snapshot" }
      | { readonly kind: "latest_completed" }
      | {
          readonly kind: "selected_completed_turn";
          readonly turnId: string;
          readonly expectedTurnRevision: number;
        },
  ) =>
    selection.kind === "latest_provider_snapshot"
      ? {
          reference: {
            backendInstanceId: "pi-primary",
            kind: "conversation_leaf" as const,
            opaqueReference: "provider-snapshot-leaf",
          },
          boundaryKind: "provider_snapshot_at_acceptance" as const,
          sourceTurnId: null,
          sourceTurnCompletedAt: null,
          backendTurnId: null,
          effectiveSettings: { toolAccess: "full" as const },
          branching: currentBranching,
        }
      : {
          reference: {
            backendInstanceId: "pi-primary",
            kind: "conversation_leaf" as const,
            opaqueReference: "source-leaf",
          },
          boundaryKind: "completed_turn_inclusive" as const,
          sourceTurnId,
          sourceTurnCompletedAt: "2026-07-30T15:00:00.000Z",
          backendTurnId: sourceBackendTurnId,
          effectiveSettings: { toolAccess: "full" as const },
          branching: currentBranching,
        };
  const actor = {
    withBranchCheckpoint: vi.fn(async (selection, operation) =>
      operation(resolved(selection)),
    ),
    withBranchExecution: vi.fn(async (_boundaryKind, operation) =>
      operation(currentBranching),
    ),
    captureSnapshotState: vi.fn(async () => ({
      backendCapabilities: { branching: currentBranching },
    })),
  };
  const targets = { actor: vi.fn(async () => target) };
  const actors = {
    acquire: vi.fn(async () => ({ actor, release: vi.fn() })),
  };
  let failReadSettings = false;
  let failBoundDetailSave = false;
  const persistence = {
    database,
    initializeForkThread: vi.fn(),
    readForkSettings: vi.fn(() => {
      if (failReadSettings) throw new Error("settings row missing");
      return { toolAccess: "full" as const };
    }),
    saveBoundBindingDetail: vi.fn(() => {
      if (failBoundDetailSave) {
        failBoundDetailSave = false;
        throw new Error("bound detail write failed");
      }
    }),
  };
  let failPublication = false;
  const publishAuthoritativeReplacement = vi.fn(async () => {
    if (failPublication) {
      failPublication = false;
      throw new Error("application event failed");
    }
  });
  let idSequence = 1;
  const summaryReader = new DatabaseApplicationThreadSummaryReader({
    inventory,
    queue: new QueuedInputRepository(database),
    completion: new SubmissionCompletionRepository(database),
  });
  const deliveryInputSnapshots = new DeliveryInputSnapshotRepository(database);
  const collectOutputArtifactGarbage = vi.fn();
  const environmentVariables = withEnvironmentVariables ? new EnvironmentVariablesService(database, new ConfigurationRepository(database)) : undefined;
  const service = new ThreadForkService({
    environmentVariables,
    database,
    targets: targets as never,
    actors: actors as never,
    backendPersistence: new Map([["pi-primary", persistence as never]]),
    bindings,
    creation,
    checkpoints,
    lineage,
    inventory,
    operations: new ConversationOperationRepository(database),
    deliveryInputSnapshots,
    outputArtifacts: { collectGarbage: collectOutputArtifactGarbage },
    automations: new AutomationRepository(database),
    automationExecutionPolicy: { assertCanAutomate: () => undefined },
    descendantSummaries: summaryReader,
    descendantTerminalSummaries: {
      summariesByThread: (_scope, threadIds) =>
        new Map(
          threadIds.map((threadId) => [
            threadId,
            { runningCount: 1, retainedCount: 2 },
          ]),
        ),
    },
    lineageCursorSigningKey: Buffer.alloc(32, 9),
    now: () => 1_000 + idSequence,
    id: () => uuid(idSequence++),
  });
  service.bindApplicationSnapshots({
    publishAuthoritativeReplacement,
  } as never);
  service.bindDescendantRunStates({
    captureLoadedState: async () => undefined,
  });
  const manual = (mutationId = "manual-fork") => ({
    scope,
    sourceThreadId: source.id,
    boundary: "selected_completed_turn" as const,
    sourceTurnId,
    expectedTurnRevision: 4,
    mutationId,
  });
  const latestSnapshot = (mutationId = "latest-snapshot-fork") => ({
    scope,
    sourceThreadId: source.id,
    boundary: "latest_provider_snapshot" as const,
    mutationId,
  });
  const agent = (mutationId = "agent-fork") => ({
    ...manual(mutationId),
    controllerThreadId: secondSource.id,
    environmentAuthority: {
      id: "grant-1",
      callerKind: "thread_agent" as const,
      defaults: {
        kind: "thread_agent" as const,
        environmentId: environment.id,
        workspaceId: workspace.id,
        threadId: secondSource.id,
      },
      policyIdentity: {
        ownerKind: "thread" as const,
        ownerId: secondSource.id,
        revision: 1,
      },
      admittedEnvironmentIds: [environment.id],
      targetEnvironmentIds: [],
      resolvedResourceRefs: [
        {
          kind: "thread" as const,
          id: source.id,
          environmentId: environment.id,
          workspaceId: workspace.id,
        },
      ],
      canonicalInputDigest: "input-digest",
      authorityDigest: "authority-digest",
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
    },
  });
  const principal = (mutationId = "principal-client-fork") => ({
    ...manual(mutationId),
    clientId: principalClientId,
    environmentAuthority: {
      id: "grant-principal",
      callerKind: "principal_client" as const,
      defaults: {
        kind: "principal_client" as const,
        environmentId: environment.id,
      },
      policyIdentity: {
        ownerKind: "principal_client" as const,
        ownerId: principalClientId,
        revision: 1,
        credentialGeneration: 1,
      },
      admittedEnvironmentIds: [environment.id],
      targetEnvironmentIds: [],
      resolvedResourceRefs: [
        {
          kind: "thread" as const,
          id: source.id,
          environmentId: environment.id,
          workspaceId: workspace.id,
        },
      ],
      canonicalInputDigest: "principal-input-digest",
      authorityDigest: "principal-authority-digest",
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
    },
  });
  return {
    database,
    scope,
    source,
    secondSource,
    sourceTurnId,
    sourceBackendTurnId,
    binding: target.binding,
    reconciliationScope: {
      connectionProfileIds: [target.driver.connection.id],
      executionEnvironmentId: environment.id,
    },
    bindings,
    creation,
    checkpoints,
    lineage,
    inventory,
    service,
    environmentVariables,
    manual,
    latestSnapshot,
    agent,
    principal,
    branchConversation,
    targets,
    actors,
    actor,
    persistence,
    deliveryInputSnapshots,
    collectOutputArtifactGarbage,
    publishAuthoritativeReplacement,
    setBranching(value: Branching) {
      currentBranching = value;
    },
    failReadSettingsOnce() {
      failReadSettings = true;
    },
    restoreSettings() {
      failReadSettings = false;
    },
    failBoundDetailSaveOnce() {
      failBoundDetailSave = true;
    },
    failPublicationOnce() {
      failPublication = true;
    },
  };
}

describe("ThreadForkService", () => {

  it("keeps variable retry identity with durable forks and preserves concurrent recovery", async () => {
    const current = fixture(true);
    try {
      let resolveBranch!: (value: { backendConversationId: string; reconciliationToken: string; opaqueBindingDetail: string }) => void;
      current.branchConversation.mockImplementation(() => new Promise(resolve => { resolveBranch = resolve; }));
      const request = { ...current.manual("variables-bound"), environmentVariables: { API_TOKEN: { kind: "secret" as const, source: { kind: "environment" as const, name: "HOST_TOKEN" } }, REMOVE_ME: { kind: "unset" as const } } };
      const first = current.service.forkManual(request);
      expect(current.service.forkManual({ ...request, environmentVariables: { REMOVE_ME: request.environmentVariables.REMOVE_ME, API_TOKEN: request.environmentVariables.API_TOKEN } })).toBe(first);
      await expect(Promise.resolve().then(() => current.service.forkManual({ ...request, environmentVariables: {} }))).rejects.toMatchObject({ code: "conflict" });
      await vi.waitFor(() => expect(current.branchConversation).toHaveBeenCalledOnce());
      const attempt = current.creation.findByMutationId(current.scope, request.mutationId)!;
      expect(current.service.recoverActive(current.scope, attempt.applicationThreadId)).toBe(first);
      resolveBranch({ backendConversationId: attempt.backendCreationCorrelation!, reconciliationToken: "variables-token", opaqueBindingDetail: "variables-detail" });
      const created = await first;
      expect(current.environmentVariables!.get(current.scope, created.childThreadId).layers.thread).toEqual(request.environmentVariables);
      const restarted = new ThreadForkService(current.service.input);
      restarted.bindApplicationSnapshots({ publishAuthoritativeReplacement: current.publishAuthoritativeReplacement } as never);
      await expect(restarted.forkManual(request)).resolves.toEqual(created);
      await expect(Promise.resolve().then(() => restarted.forkManual({ ...request, environmentVariables: {} }))).rejects.toMatchObject({ code: "conflict" });
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally { current.database.close(); }
  });

  it.each(["selected_completed_turn", "latest_provider_snapshot"] as const)("retains variable identity after a %s fork is aborted and its child deleted", async boundary => {
    const current = fixture(true);
    try {
      current.branchConversation.mockRejectedValue(new BackendError({ category: "rejected", retryable: false, crossedSubmissionBoundary: false, safeMessage: "provider rejected branch" }));
      const request = { ...(boundary === "selected_completed_turn" ? current.manual("variables-aborted") : current.latestSnapshot("variables-aborted")), environmentVariables: { PROJECT_MODE: { kind: "literal" as const, value: "test" } } };
      const aborted = await current.service.forkManual(request);
      expect(aborted.status).toBe("aborted");
      expect(current.creation.findByMutationId(current.scope, request.mutationId)).toBeUndefined();
      const restarted = new ThreadForkService(current.service.input);
      await expect(restarted.forkManual(request)).resolves.toEqual(aborted);
      await expect(Promise.resolve().then(() => restarted.forkManual({ ...request, environmentVariables: {} }))).rejects.toMatchObject({ code: "conflict" });
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally { current.database.close(); }
  });

  it("allows a new fork after more than 10,000 rejected requests without retaining reservations", async () => {
    const current = fixture(true);
    try {
      current.database.prepare(`INSERT INTO queued_inputs(
        tenant_id, owner_principal_id, id, application_thread_id, sequence, mutation_id, text, trigger_kind, state, created_at
      ) VALUES (?, ?, ?, ?, 1, 'blocked-input', 'queued', 'user', 'pending', 500)`)
        .run(current.scope.tenantId, current.scope.principalId, uuid(900), current.source.id);
      for (let index = 0; index < 10_001; index++) {
        await expect(current.service.forkManual({ ...current.manual(`blocked-${index}`), environmentVariables: { MODE: { kind: "literal", value: "test" } } })).rejects.toMatchObject({ code: "invalid_transition" });
      }
      expect(current.branchConversation).not.toHaveBeenCalled();
      expect(current.database.prepare("SELECT count(*) AS count FROM conversation_creation_attempts").get()).toEqual({ count: 0 });
      expect(current.database.prepare("SELECT count(*) AS count FROM aborted_thread_forks").get()).toEqual({ count: 0 });
      current.database.prepare("UPDATE queued_inputs SET state = 'cancelled', resolved_at = 1000 WHERE id = ?").run(uuid(900));
      await expect(current.service.forkManual(current.manual("unblocked-fork"))).resolves.toMatchObject({ status: "created" });
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally { current.database.close(); }
  }, 20_000); // Exercises every request across the former 10,000-entry lifetime limit.
  it("refuses forks from a removed project before consulting the provider", async () => {
    const current = fixture();
    try {
      current.database.exec("UPDATE workspaces SET removed_at = 123");
      await expect(current.service.forkPrincipalClient(current.principal()))
        .rejects.toMatchObject({ code: "invalid_transition" });
      expect(current.branchConversation).not.toHaveBeenCalled();
    } finally { current.database.close(); }
  });

  it("creates a version-one principal-client fork with durable client provenance", async () => {
    const current = fixture();
    try {
      const request = current.principal();
      const result = await current.service.forkPrincipalClient(request);
      expect(result.status).toBe("created");
      expect(
        current.creation.findByMutationId(current.scope, request.mutationId),
      ).toMatchObject({
        applicationThreadId: result.childThreadId,
        sourceKind: "principal_client",
        initiatingAgentThreadId: null,
        initiatingToolClientId: request.clientId,
        phase: "bound",
      });
      expect(
        current.lineage.getOrigin(current.scope, result.childThreadId),
      ).toMatchObject({
        originKind: "principal_client_fork",
        initiatingAgentThreadId: null,
        initiatingToolClientId: request.clientId,
        boundaryKind: "completed_turn_inclusive",
        originState: "committed",
      });
      new PrincipalAgentToolClientRepository(
        current.database,
        createPrincipalAgentToolClientEligibility(),
      ).revoke(current.scope, request.clientId, {
        expectedRevision: 1,
        now: 2_000,
      });
      expect(
        current.lineage.getOrigin(current.scope, result.childThreadId),
      ).toMatchObject({ initiatingToolClientId: request.clientId });
    } finally {
      current.database.close();
    }
  });

  it("creates an exact agent fork with durable controller provenance", async () => {
    const current = fixture();
    try {
      const request = current.agent();
      const result = await current.service.forkAgent(request);
      expect(result.status).toBe("created");
      const childThreadId = result.childThreadId;

      expect(current.actor.withBranchCheckpoint).toHaveBeenCalledWith(
        {
          kind: "selected_completed_turn",
          turnId: request.sourceTurnId,
          expectedTurnRevision: request.expectedTurnRevision,
        },
        expect.any(Function),
      );
      expect(current.branchConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          childApplicationThreadId: childThreadId,
          source: { kind: "user" },
        }),
      );

      expect(
        current.creation.findByMutationId(current.scope, request.mutationId),
      ).toMatchObject({
        applicationThreadId: childThreadId,
        creationKind: "fork",
        sourceKind: "agent_control",
        initiatingAgentThreadId: request.controllerThreadId,
        initialInputText: null,
        phase: "bound",
      });
      expect(
        current.lineage.getOrigin(current.scope, childThreadId),
      ).toMatchObject({
        childThreadId,
        sourceThreadId: request.sourceThreadId,
        sourceTurnId: request.sourceTurnId,
        sourceTurnRevision: request.expectedTurnRevision,
        originKind: "agent_fork",
        initiatingPrincipalId: current.scope.principalId,
        initiatingAgentThreadId: request.controllerThreadId,
        originState: "committed",
      });
    } finally {
      current.database.close();
    }
  });

  it("rejects agent-fork replay with a different trusted controller", async () => {
    const current = fixture();
    try {
      const request = current.agent("agent-fork-replay");
      await expect(current.service.forkAgent(request)).resolves.toMatchObject({
        status: "created",
      });
      await expect(
        current.service.forkAgent({
          ...request,
          controllerThreadId: current.source.id,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      current.database.close();
    }
  });

  it("preserves agent controller provenance when a proven-uncreated fork aborts", async () => {
    const current = fixture();
    try {
      const request = current.agent("agent-fork-aborted");
      current.branchConversation.mockRejectedValueOnce(
        new BackendError({
          category: "unavailable",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "Provider rejected the fork.",
        }),
      );

      const result = await current.service.forkAgent(request);
      expect(result).toMatchObject({
        status: "aborted",
        diagnostic: "Provider rejected the fork.",
      });
      expect(
        current.lineage.findAbortedOperation(current.scope, request.mutationId),
      ).toMatchObject({
        sourceThreadId: request.sourceThreadId,
        sourceTurnId: request.sourceTurnId,
        sourceTurnRevision: request.expectedTurnRevision,
        sourceKind: "agent_control",
        initiatingAgentThreadId: request.controllerThreadId,
      });
      await expect(current.service.forkAgent(request)).resolves.toEqual(result);
    } finally {
      current.database.close();
    }
  });

  it("returns the existing non-retryable recovery outcome for an uncertain agent fork", async () => {
    const current = fixture();
    try {
      const request = current.agent("agent-fork-unknown");
      current.setBranching(
        branching("provider_assigned", "potentially_unknown"),
      );
      current.branchConversation.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "Fork outcome unknown.",
        }),
      );

      const result = await current.service.forkAgent(request);
      expect(result).toMatchObject({
        status: "recovery_required",
        retryable: false,
        uncertaintyKind: "fork_unknown",
      });
      expect(
        current.lineage.getOrigin(current.scope, result.childThreadId),
      ).toMatchObject({
        originKind: "agent_fork",
        initiatingAgentThreadId: request.controllerThreadId,
        originState: "prepared",
      });
      await expect(current.service.forkAgent(request)).resolves.toEqual(result);
    } finally {
      current.database.close();
    }
  });

  it("creates a promptless manual child and rejects full-request mutation reuse", async () => {
    const current = fixture();
    try {
      const request = current.manual();
      current.deliveryInputSnapshots.prepare(current.scope, current.source.id, {
        applicationOperationId: "source-delivery-operation",
        text: "Canonical source prompt",
        contextExcerpts: [],
        taskContexts: [
          {
            id: "10000000-0000-4000-8000-000000000099",
            scope: { kind: "global" },
            title: "Forked Task",
            details: "Preserve structured fork history.",
            pinned: false,
            files: [],
            completedAt: null,
            revision: 2,
            createdAt: "2026-08-16T20:00:00.000Z",
            updatedAt: "2026-08-16T21:00:00.000Z",
          },
        ],
        attachments: [
          {
            descriptor: {
              id: "20000000-0000-4000-8000-000000000099",
              kind: "image",
              fileName: "fork.png",
              mediaType: "image/png",
              byteSize: 64,
            },
            sha256: "a".repeat(64),
          },
        ],
        createdAt: 999,
      });
      const result = await current.service.forkManual(request);
      expect(result.status).toBe("created");
      const childThreadId = result.childThreadId;
      expect(
        current.deliveryInputSnapshots.find(
          current.scope,
          childThreadId,
          "source-delivery-operation",
        ),
      ).toMatchObject({
        deliveryOperationId: "source-delivery-operation",
        text: "Canonical source prompt",
        taskContexts: [{ title: "Forked Task", revision: 2 }],
        attachments: [
          {
            descriptor: { kind: "image", fileName: "fork.png" },
            sha256: "a".repeat(64),
          },
        ],
      });
      expect(current.branchConversation).toHaveBeenCalledOnce();
      const providerInput = current.branchConversation.mock.calls[0]![0];
      expect(providerInput).not.toHaveProperty("prompt");
      expect(providerInput).not.toHaveProperty("forkContextBoundary");
      expect(
        current.database
          .prepare(
            `
          SELECT text FROM thread_drafts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        `,
          )
          .get(
            current.scope.tenantId,
            current.scope.principalId,
            childThreadId,
          ),
      ).toEqual({ text: "" });
      expect(
        current.database
          .prepare(
            `
          SELECT count(*) AS count FROM queued_inputs
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
        `,
          )
          .get(
            current.scope.tenantId,
            current.scope.principalId,
            childThreadId,
          ),
      ).toEqual({ count: 0 });
      expect(
        current.lineage.getOrigin(current.scope, childThreadId),
      ).toMatchObject({
        sourceTurnCompletedAt: Date.parse("2026-07-30T15:00:00.000Z"),
      });
      await expect(current.service.forkManual(request)).resolves.toEqual(
        result,
      );
      current.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET inventory_state = 'archived', state_changed_at = 2000
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.source.id,
        );
      await expect(current.service.forkManual(request)).resolves.toEqual(
        result,
      );
      await expect(
        current.service.forkManual({
          ...request,
          mutationId: "new-fork-after-source-archived",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      expect(current.branchConversation).toHaveBeenCalledOnce();
      for (const changed of [
        { sourceThreadId: current.secondSource.id },
        { sourceTurnId: "another-turn" },
        { expectedTurnRevision: request.expectedTurnRevision + 1 },
      ]) {
        await expect(
          current.service.forkManual({ ...request, ...changed }),
        ).rejects.toMatchObject({ code: "conflict" });
      }
    } finally {
      current.database.close();
    }
  });

  it("creates a manual fork from the provider snapshot accepted by the backend", async () => {
    const current = fixture();
    try {
      const request = current.latestSnapshot();
      const result = await current.service.forkManual(request);
      expect(result).toMatchObject({ status: "created" });
      const childThreadId = result.childThreadId;

      expect(current.actor.withBranchCheckpoint).toHaveBeenCalledWith(
        { kind: "latest_provider_snapshot" },
        expect.any(Function),
      );
      expect(current.branchConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          childApplicationThreadId: childThreadId,
          sourceCheckpoint: expect.objectContaining({
            opaqueReference: "provider-snapshot-leaf",
          }),
          source: { kind: "user" },
        }),
      );
      expect(
        current.checkpoints.get(current.scope, request.mutationId),
      ).toMatchObject({
        applicationThreadId: request.sourceThreadId,
        applicationTurnId: null,
        boundaryKind: "provider_snapshot_at_acceptance",
        opaqueReference: "provider-snapshot-leaf",
      });
      expect(
        current.lineage.getOrigin(current.scope, childThreadId),
      ).toMatchObject({
        sourceThreadId: request.sourceThreadId,
        sourceTurnId: null,
        sourceTurnRevision: null,
        sourceTurnCompletedAt: null,
        boundaryKind: "provider_snapshot_at_acceptance",
        originKind: "user_fork",
        originState: "committed",
      });
    } finally {
      current.database.close();
    }
  });

  it("replays the same provider snapshot mutation and rejects exact-turn reuse", async () => {
    const current = fixture();
    try {
      const request = current.latestSnapshot("snapshot-replay");
      const created = await current.service.forkManual(request);
      await expect(current.service.forkManual(request)).resolves.toEqual(
        created,
      );
      await expect(
        current.service.forkManual({
          ...current.manual(request.mutationId),
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("records and replays a pre-submission provider snapshot rejection", async () => {
    const current = fixture();
    try {
      const request = current.latestSnapshot("snapshot-aborted");
      current.branchConversation.mockRejectedValueOnce(
        new BackendError({
          category: "invalid_state",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "Provider rejected the snapshot fork.",
        }),
      );

      const aborted = await current.service.forkManual(request);
      expect(aborted).toMatchObject({
        status: "aborted",
        diagnostic: "Provider rejected the snapshot fork.",
      });
      expect(
        current.lineage.findAbortedOperation(current.scope, request.mutationId),
      ).toMatchObject({
        sourceThreadId: request.sourceThreadId,
        sourceTurnId: null,
        sourceTurnRevision: null,
        boundaryKind: "provider_snapshot_at_acceptance",
        sourceKind: "user_fork",
      });
      await expect(current.service.forkManual(request)).resolves.toEqual(
        aborted,
      );
      await expect(
        current.service.forkManual(current.manual(request.mutationId)),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("recovers a prepared idempotent fork from its persisted provider snapshot boundary", async () => {
    const current = fixture();
    try {
      const request = current.latestSnapshot("snapshot-prepared-recovery");
      current.failReadSettingsOnce();
      await expect(current.service.forkManual(request)).rejects.toThrow(
        "settings row missing",
      );
      const prepared = current.creation.findByMutationId(
        current.scope,
        request.mutationId,
      )!;
      expect(prepared.phase).toBe("prepared");
      expect(
        current.lineage.getOrigin(current.scope, prepared.applicationThreadId),
      ).toMatchObject({
        boundaryKind: "provider_snapshot_at_acceptance",
        sourceTurnId: null,
        sourceTurnRevision: null,
      });
      current.restoreSettings();

      const recovered = current.service.recoverActive(
        current.scope,
        prepared.applicationThreadId,
      );
      await expect(recovered).resolves.toMatchObject({
        status: "created",
        childThreadId: prepared.applicationThreadId,
      });
      expect(current.actor.withBranchCheckpoint).toHaveBeenCalledOnce();
      expect(current.actor.withBranchExecution).toHaveBeenCalledWith(
        "provider_snapshot_at_acceptance",
        expect.any(Function),
      );
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("coalesces only concurrent mutation replays with the same source boundary", async () => {
    const current = fixture();
    try {
      let resolveBranch!: (value: {
        readonly backendConversationId: string;
        readonly reconciliationToken: string;
        readonly opaqueBindingDetail: string;
      }) => void;
      let requestedBackendConversationId = "";
      current.branchConversation.mockImplementation(
        (input) =>
          new Promise((resolve) => {
            requestedBackendConversationId =
              input.requestedBackendConversationId!;
            resolveBranch = resolve;
          }),
      );
      const request = current.manual("concurrent-fork-mutation");
      const first = current.service.forkManual(request);
      const exactReplay = current.service.forkManual(request);
      expect(exactReplay).toBe(first);
      await vi.waitFor(() =>
        expect(requestedBackendConversationId).not.toBe(""),
      );
      const active = current.creation.findByMutationId(
        current.scope,
        request.mutationId,
      );
      expect(active).toBeDefined();
      const concurrentRecovery = current.service.recoverActive(
        current.scope,
        active!.applicationThreadId,
      );
      expect(concurrentRecovery).toBe(first);
      await expect(
        current.service.forkManual({
          ...request,
          sourceTurnId: "different-concurrent-turn",
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      resolveBranch({
        backendConversationId: requestedBackendConversationId,
        reconciliationToken: "concurrent-token",
        opaqueBindingDetail: "concurrent-detail",
      });
      await expect(first).resolves.toMatchObject({ status: "created" });
      await expect(exactReplay).resolves.toMatchObject({ status: "created" });
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("coalesces an in-flight agent fork with recovery of its durable exact boundary", async () => {
    const current = fixture();
    try {
      let resolveBranch!: (value: {
        readonly backendConversationId: string;
        readonly reconciliationToken: string;
        readonly opaqueBindingDetail: string;
      }) => void;
      current.branchConversation.mockImplementation(
        (_input) =>
          new Promise((resolve) => {
            resolveBranch = resolve;
          }),
      );
      const request = current.agent("concurrent-agent-recovery");
      const first = current.service.forkAgent(request);
      await vi.waitFor(() =>
        expect(current.branchConversation).toHaveBeenCalledOnce(),
      );
      const active = current.creation.findByMutationId(
        current.scope,
        request.mutationId,
      )!;
      const concurrentRecovery = current.service.recoverActive(
        current.scope,
        active.applicationThreadId,
      )!;
      const observedRecovery = concurrentRecovery.catch((error) => error);

      resolveBranch({
        backendConversationId: active.backendCreationCorrelation!,
        reconciliationToken: "concurrent-agent-token",
        opaqueBindingDetail: "concurrent-agent-detail",
      });
      await expect(first).resolves.toMatchObject({ status: "created" });
      expect(concurrentRecovery).toBe(first);
      await expect(observedRecovery).resolves.toMatchObject({
        status: "created",
      });
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("coalesces an in-flight provider snapshot fork with recovery of its durable unanchored boundary", async () => {
    const current = fixture();
    try {
      let resolveBranch!: (value: {
        readonly backendConversationId: string;
        readonly reconciliationToken: string;
        readonly opaqueBindingDetail: string;
      }) => void;
      current.branchConversation.mockImplementation(
        (_input) =>
          new Promise((resolve) => {
            resolveBranch = resolve;
          }),
      );
      const request = current.latestSnapshot("concurrent-snapshot-recovery");
      const first = current.service.forkManual(request);
      await vi.waitFor(() =>
        expect(current.branchConversation).toHaveBeenCalledOnce(),
      );
      const active = current.creation.findByMutationId(
        current.scope,
        request.mutationId,
      )!;
      expect(
        current.lineage.getOrigin(current.scope, active.applicationThreadId),
      ).toMatchObject({
        boundaryKind: "provider_snapshot_at_acceptance",
        sourceTurnId: null,
        sourceTurnRevision: null,
      });
      const concurrentRecovery = current.service.recoverActive(
        current.scope,
        active.applicationThreadId,
      )!;
      const observedRecovery = concurrentRecovery.catch((error) => error);

      resolveBranch({
        backendConversationId: active.backendCreationCorrelation!,
        reconciliationToken: "concurrent-snapshot-token",
        opaqueBindingDetail: "concurrent-snapshot-detail",
      });
      await expect(first).resolves.toMatchObject({ status: "created" });
      expect(concurrentRecovery).toBe(first);
      await expect(observedRecovery).resolves.toMatchObject({
        status: "created",
      });
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("rechecks source eligibility atomically after checkpoint capture", async () => {
    const current = fixture();
    try {
      const originalCapture =
        current.actor.withBranchCheckpoint.getMockImplementation()!;
      current.actor.withBranchCheckpoint.mockImplementationOnce(
        async (selection, operation) => {
          current.inventory.transitionInventory(
            current.scope,
            current.source.id,
            {
              expectedRevision: 0,
              mutationId: "archive-during-checkpoint-capture",
              change: { action: "archive" },
              now: 999,
            },
          );
          return originalCapture(selection, operation);
        },
      );
      const before = current.database
        .prepare("SELECT count(*) AS count FROM application_threads")
        .get() as { readonly count: number };

      await expect(
        current.service.forkManual(current.manual("archive-race-fork")),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      expect(current.branchConversation).not.toHaveBeenCalled();
      expect(
        current.database
          .prepare("SELECT count(*) AS count FROM application_threads")
          .get(),
      ).toEqual(before);
    } finally {
      current.database.close();
    }
  });

  it("keeps pre-provider local failure prepared and safely recoverable for a non-idempotent provider", async () => {
    const current = fixture();
    try {
      current.setBranching(
        branching("provider_assigned", "potentially_unknown"),
      );
      current.branchConversation.mockResolvedValue({
        backendConversationId: "provider-child",
        reconciliationToken: "provider-token",
        opaqueBindingDetail: "provider-detail",
      });
      current.failReadSettingsOnce();
      const request = current.manual("pre-call-failure");
      await expect(current.service.forkManual(request)).rejects.toThrow(
        "settings row missing",
      );
      const prepared = current.creation.findByMutationId(
        current.scope,
        request.mutationId,
      )!;
      expect(prepared.phase).toBe("prepared");
      expect(current.branchConversation).not.toHaveBeenCalled();
      await expect(
        current.service.readRecovery(
          current.scope,
          prepared.applicationThreadId,
        ),
      ).resolves.toEqual({ recoverable: true });

      current.restoreSettings();
      await expect(current.service.forkManual(request)).resolves.toMatchObject({
        status: "created",
      });
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("retains response-known provider identity/detail across pre-binding persistence failure", async () => {
    const current = fixture();
    try {
      current.setBranching(
        branching("provider_assigned", "potentially_unknown"),
      );
      current.branchConversation.mockResolvedValue({
        backendConversationId: "provider-response-known",
        reconciliationToken: "provider-token",
        opaqueBindingDetail: "provider-response-detail",
      });
      current.failBoundDetailSaveOnce();
      const request = current.manual("response-known-failure");
      const first = await current.service.forkManual(request);
      expect(first).toMatchObject({
        status: "recovery_required",
        retryable: true,
      });
      const attempt = current.creation.findByMutationId(
        current.scope,
        request.mutationId,
      )!;
      expect(attempt).toMatchObject({
        phase: "recovery_required",
        provisionalBackendConversationId: "provider-response-known",
        provisionalOpaqueBindingDetail: "provider-response-detail",
      });
      await expect(
        current.service.reconcileDiscoveredFork(current.scope, {
          applicationOperationId: request.mutationId,
          backendInstanceId: "pi-primary",
          ...current.reconciliationScope,
          backendConversationId: "different-provider-child",
          parentBackendConversationId: "native-source",
          sourceBackendTurnId: current.sourceBackendTurnId,
          childIdentity: "provider_assigned",
          creationRecovery: "exactly_reconcilable",
          method: "provider_native",
          opaqueBindingDetail: "different-detail",
        }),
      ).resolves.toBeUndefined();
      const actorCalls = current.actors.acquire.mock.calls.length;

      await expect(current.service.forkManual(request)).resolves.toMatchObject({
        status: "created",
      });
      expect(current.branchConversation).toHaveBeenCalledOnce();
      expect(current.actors.acquire).toHaveBeenCalledTimes(actorCalls);
      expect(
        current.bindings.getBinding(current.scope, attempt.applicationThreadId),
      ).toMatchObject({ backendConversationId: "provider-response-known" });
    } finally {
      current.database.close();
    }
  });

  it.each(["before_commit", "after_commit"] as const)(
    "records a provider response idempotently when the first attempt write faults %s",
    async (fault) => {
      const current = fixture();
      try {
        current.setBranching(
          branching("provider_assigned", "potentially_unknown"),
        );
        current.branchConversation.mockResolvedValue({
          backendConversationId: `provider-${fault}`,
          reconciliationToken: `token-${fault}`,
          opaqueBindingDetail: `detail-${fault}`,
        });
        const original = current.creation.recordConversationIdentified.bind(
          current.creation,
        );
        const write = vi.spyOn(
          current.creation,
          "recordConversationIdentified",
        );
        if (fault === "before_commit") {
          write
            .mockImplementationOnce(() => {
              throw new Error("attempt response write failed");
            })
            .mockImplementation(original);
        } else {
          write
            .mockImplementationOnce((...args) => {
              original(...args);
              throw new Error("attempt response commit acknowledgement failed");
            })
            .mockImplementation(original);
        }
        const request = current.manual(`response-write-${fault}`);
        await expect(
          current.service.forkManual(request),
        ).resolves.toMatchObject({
          status: "created",
        });
        expect(current.branchConversation).toHaveBeenCalledOnce();
        expect(
          current.creation.findByMutationId(current.scope, request.mutationId),
        ).toMatchObject({
          phase: "bound",
          provisionalBackendConversationId: `provider-${fault}`,
          provisionalOpaqueBindingDetail: `detail-${fault}`,
        });
      } finally {
        current.database.close();
      }
    },
  );

  it("repairs publication after binding without recreating the provider child", async () => {
    const current = fixture();
    try {
      current.failPublicationOnce();
      const request = current.manual("publication-failure");
      await expect(current.service.forkManual(request)).rejects.toThrow(
        "application event failed",
      );
      expect(
        current.creation.findByMutationId(current.scope, request.mutationId),
      ).toMatchObject({ phase: "bound" });

      await expect(current.service.forkManual(request)).resolves.toMatchObject({
        status: "created",
      });
      expect(current.branchConversation).toHaveBeenCalledOnce();
      expect(current.publishAuthoritativeReplacement).toHaveBeenCalledTimes(2);
    } finally {
      current.database.close();
    }
  });

  it("replays an application-reserved lost response with one stable provider identity", async () => {
    const current = fixture();
    try {
      const requestedIds: string[] = [];
      current.branchConversation
        .mockImplementationOnce(async (input) => {
          requestedIds.push(input.requestedBackendConversationId!);
          throw new BackendError({
            category: "submission_unknown",
            retryable: false,
            crossedSubmissionBoundary: true,
            safeMessage: "branch response lost",
          });
        })
        .mockImplementationOnce(async (input) => {
          requestedIds.push(input.requestedBackendConversationId!);
          return {
            backendConversationId: input.requestedBackendConversationId!,
            reconciliationToken: "replayed-branch",
            opaqueBindingDetail: "replayed-detail",
          };
        });
      const request = current.manual("reserved-lost-response");
      const uncertain = await current.service.forkManual(request);
      expect(uncertain).toMatchObject({
        status: "recovery_required",
        retryable: true,
      });
      const attempt = current.creation.findByMutationId(
        current.scope,
        request.mutationId,
      );
      expect(attempt).toMatchObject({ phase: "recovery_required" });
      expect(
        current.lineage.findOrigin(current.scope, uncertain.childThreadId),
      ).toMatchObject({ originState: "prepared" });
      expect(
        current.bindings.findThreadDefinition(
          current.scope,
          uncertain.childThreadId,
        ),
      ).toMatchObject({ backingState: "creation_unknown" });
      await expect(current.service.forkManual(request)).resolves.toMatchObject({
        status: "created",
      });
      expect(requestedIds).toHaveLength(2);
      expect(new Set(requestedIds).size).toBe(1);
    } finally {
      current.database.close();
    }
  });

  it("never retries or heuristically adopts potentially-unknown provider creation", async () => {
    const current = fixture();
    try {
      current.setBranching(
        branching("provider_assigned", "potentially_unknown"),
      );
      current.branchConversation.mockRejectedValue(
        new BackendError({
          category: "submission_unknown",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage: "provider outcome unknown",
        }),
      );
      const request = current.manual("provider-potentially-unknown");
      const first = await current.service.forkManual(request);
      expect(first).toMatchObject({
        status: "recovery_required",
        retryable: false,
        uncertaintyKind: "fork_unknown",
        diagnostic: expect.stringMatching(/full native fork.*orphan/iu),
      });
      expect(
        current.creation.findByMutationId(current.scope, request.mutationId),
      ).toMatchObject({
        phase: "recovery_required",
        forkChildIdentity: "provider_assigned",
        forkCreationRecovery: "potentially_unknown",
        forkUncertaintyKind: "fork_unknown",
      });
      const recoveryReader = new DatabaseThreadApplicationRecoveryReader({
        creation: current.creation,
        operations: new ConversationOperationRepository(current.database),
        targets: {} as never,
        registry: {} as never,
        forks: current.service,
      });
      await expect(
        recoveryReader.read(current.scope, first.childThreadId),
      ).resolves.toMatchObject({
        kind: "conversation_creation",
        creationType: "fork",
        phase: "recovery_required",
        submissionMayHaveBeenAccepted: true,
        forkUncertainty: "fork_unknown",
        possibleProviderOrphan: "full_native_copy",
        recoverable: false,
      });
      current.targets.actor.mockRejectedValueOnce(
        new Error("replacement daemon is unavailable"),
      );
      await expect(current.service.forkManual(request)).resolves.toEqual(first);
      expect(current.branchConversation).toHaveBeenCalledOnce();
      expect(current.targets.actor).toHaveBeenCalledOnce();
      await expect(
        current.service.readRecovery(current.scope, first.childThreadId),
      ).resolves.toEqual({ recoverable: false });
      const foreignScope = {
        tenantId: current.scope.tenantId,
        principalId: "foreign-principal",
      };
      await expect(
        current.service.readRecovery(foreignScope, first.childThreadId),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(
        current.service.recoverActive(foreignScope, first.childThreadId),
      ).toBeUndefined();
      await expect(
        current.service.reconcileDiscoveredFork(current.scope, {
          applicationOperationId: request.mutationId,
          backendInstanceId: "pi-primary",
          ...current.reconciliationScope,
          backendConversationId: "verified-provider-child",
          parentBackendConversationId: "native-source",
          sourceBackendTurnId: "native-source-turn",
          childIdentity: "provider_assigned",
          creationRecovery: "potentially_unknown",
          method: "provider_native",
          opaqueBindingDetail: "verified-detail",
        }),
      ).resolves.toBeUndefined();
      await expect(
        current.service.reconcileDiscoveredFork(current.scope, {
          applicationOperationId: request.mutationId,
          backendInstanceId: "pi-primary",
          ...current.reconciliationScope,
          backendConversationId: "verified-provider-child",
          parentBackendConversationId: "native-source",
          sourceBackendTurnId: current.sourceBackendTurnId,
          childIdentity: "provider_assigned",
          creationRecovery: "potentially_unknown",
          method: "provider_native",
          opaqueBindingDetail: "verified-detail",
        }),
      ).resolves.toBe(first.childThreadId);
      expect(
        current.creation.findByMutationId(current.scope, request.mutationId),
      ).toMatchObject({ phase: "bound", forkUncertaintyKind: null });
      expect(
        current.bindings.getBinding(current.scope, first.childThreadId),
      ).toMatchObject({ backendConversationId: "verified-provider-child" });
    } finally {
      current.database.close();
    }
  });

  it("keeps a potentially-unknown provider snapshot nonrecoverable and non-adoptable", async () => {
    const current = fixture();
    try {
      current.setBranching(
        branching("provider_assigned", "potentially_unknown"),
      );
      current.branchConversation.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage: "snapshot outcome unknown",
        }),
      );
      const request = current.latestSnapshot("snapshot-fork-unknown");
      const result = await current.service.forkManual(request);
      expect(result).toMatchObject({
        status: "recovery_required",
        retryable: false,
        uncertaintyKind: "fork_unknown",
      });
      expect(
        current.lineage.getOrigin(current.scope, result.childThreadId),
      ).toMatchObject({
        boundaryKind: "provider_snapshot_at_acceptance",
        sourceTurnId: null,
        sourceTurnRevision: null,
      });
      await expect(
        current.service.readRecovery(current.scope, result.childThreadId),
      ).resolves.toEqual({ recoverable: false });

      const evidence = {
        applicationOperationId: request.mutationId,
        backendInstanceId: "pi-primary",
        ...current.reconciliationScope,
        backendConversationId: "correlated-snapshot-orphan",
        parentBackendConversationId: "native-source",
        childIdentity: "provider_assigned" as const,
        creationRecovery: "potentially_unknown" as const,
        method: "provider_native" as const,
        opaqueBindingDetail: "correlated-snapshot-detail",
      };
      await expect(
        current.service.reconcileDiscoveredFork(current.scope, evidence),
      ).resolves.toBeUndefined();
      await expect(
        current.service.reconcileDiscoveredFork(current.scope, {
          ...evidence,
          sourceBackendTurnId: current.sourceBackendTurnId,
        }),
      ).resolves.toBeUndefined();
      expect(
        current.bindings.getBinding(current.scope, result.childThreadId),
      ).toBeUndefined();
      await expect(current.service.forkManual(request)).resolves.toEqual(
        result,
      );
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("adopts provider-assigned exactly-reconcilable creation only from exact evidence", async () => {
    const current = fixture();
    try {
      current.setBranching(
        branching("provider_assigned", "exactly_reconcilable"),
      );
      current.branchConversation.mockRejectedValue(
        new BackendError({
          category: "submission_unknown",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage: "exact provider response lost",
        }),
      );
      const request = current.manual("provider-exact-reconcile");
      const first = await current.service.forkManual(request);
      expect(first).toMatchObject({
        status: "recovery_required",
        retryable: false,
      });
      const evidence = {
        applicationOperationId: request.mutationId,
        backendInstanceId: "pi-primary",
        ...current.reconciliationScope,
        backendConversationId: "exact-provider-child",
        parentBackendConversationId: "native-source",
        sourceBackendTurnId: current.sourceBackendTurnId,
        childIdentity: "provider_assigned" as const,
        creationRecovery: "exactly_reconcilable" as const,
        method: "provider_native" as const,
        opaqueBindingDetail: "exact-provider-detail",
      };
      await expect(
        current.service.reconcileDiscoveredFork(current.scope, {
          ...evidence,
          parentBackendConversationId: "wrong-parent",
        }),
      ).resolves.toBeUndefined();
      await expect(
        current.service.reconcileDiscoveredFork(current.scope, {
          ...evidence,
          executionEnvironmentId: "foreign-environment",
        }),
      ).resolves.toBeUndefined();
      await expect(
        current.service.reconcileDiscoveredFork(current.scope, {
          ...evidence,
          connectionProfileIds: ["outside-native-namespace"],
        }),
      ).resolves.toBeUndefined();
      await expect(
        current.service.reconcileDiscoveredFork(
          {
            tenantId: current.scope.tenantId,
            principalId: "foreign-principal",
          },
          evidence,
        ),
      ).resolves.toBeUndefined();
      await expect(
        current.service.reconcileDiscoveredFork(current.scope, evidence),
      ).resolves.toBe(first.childThreadId);
      expect(current.branchConversation).toHaveBeenCalledOnce();
      expect(
        current.bindings.getBinding(current.scope, first.childThreadId),
      ).toMatchObject({ backendConversationId: "exact-provider-child" });
    } finally {
      current.database.close();
    }
  });

  it("removes a proven-uncreated child and replays its tombstone", async () => {
    const current = fixture();
    try {
      current.branchConversation.mockRejectedValue(
        new BackendError({
          category: "rejected",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "provider rejected branch",
        }),
      );
      const request = current.manual("proven-uncreated");
      const result = await current.service.forkManual(request);
      expect(result).toMatchObject({ status: "aborted" });
      expect(
        current.bindings.findThreadDefinition(
          current.scope,
          result.childThreadId,
        ),
      ).toBeUndefined();
      expect(
        current.creation.findByMutationId(current.scope, request.mutationId),
      ).toBeUndefined();
      expect(
        current.lineage.findOrigin(current.scope, result.childThreadId),
      ).toBeUndefined();
      expect(
        current.lineage.findAbortedOperation(current.scope, request.mutationId),
      ).toMatchObject({
        reservedChildThreadId: result.childThreadId,
        sourceTurnRevision: request.expectedTurnRevision,
      });
      expect(current.collectOutputArtifactGarbage).toHaveBeenCalledOnce();
      current.collectOutputArtifactGarbage.mockRejectedValueOnce(
        new Error("temporary artifact cleanup failure"),
      );
      await expect(current.service.forkManual(request)).resolves.toEqual(
        result,
      );
      expect(current.collectOutputArtifactGarbage).toHaveBeenCalledTimes(2);
      await expect(
        current.service.forkManual({
          ...request,
          expectedTurnRevision: request.expectedTurnRevision + 1,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(current.branchConversation).toHaveBeenCalledOnce();
    } finally {
      current.database.close();
    }
  });

  it("records a futile abort, quarantines its reserved child, and logs the cause", async () => {
    const current = fixture();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      let reserved: string | undefined;
      current.branchConversation.mockImplementation(async (input) => {
        reserved = input.requestedBackendConversationId;
        throw new BackendError({
          category: "invalid_state", retryable: false, crossedSubmissionBoundary: false,
          safeMessage: "Claude created the fork, but its history does not match the selected turn.",
          backendCode: "claude_fork_history_mismatch", forkRestart: "futile",
        }, { cause: new Error("claude_fork_history_mismatch: expected 4 retained messages, found 3") });
      });
      const request = current.manual("futile-abort");
      const result = await current.service.forkManual(request);
      expect(result).toMatchObject({ status: "aborted", restartable: false,
        diagnostic: "Claude created the fork, but its history does not match the selected turn." });
      await expect(current.service.forkManual(request)).resolves.toEqual(result);
      expect(current.lineage.isReservedForkChild(current.scope, {
        backendInstanceId: current.binding.backendInstanceId, backendConversationId: reserved!,
      })).toBe(true);
      expect(current.lineage.isReservedForkChild(current.scope, {
        backendInstanceId: current.binding.backendInstanceId, backendConversationId: uuid(77_777),
      })).toBe(false);
      const logged = stderr.mock.calls.map(([line]) => String(line)).join("");
      expect(logged).toContain(`Fork ${result.childThreadId} creation (aborted, claude_fork_history_mismatch) failed: Claude created the fork`);
      expect(logged).toContain("cause: claude_fork_history_mismatch: expected 4 retained messages, found 3");
    } finally {
      stderr.mockRestore();
      current.database.close();
    }
  });

  it("keeps a retried fork recoverable after a transient definite failure, since an earlier call may have created it", async () => {
    const current = fixture();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      current.branchConversation
        .mockRejectedValueOnce(new BackendError({ category: "submission_unknown", retryable: false,
          crossedSubmissionBoundary: true, safeMessage: "outcome unknown" }))
        .mockRejectedValueOnce(new BackendError({ category: "unavailable", retryable: true,
          crossedSubmissionBoundary: false, safeMessage: "Claude session data is temporarily unavailable." }));
      const request = current.manual("retry-transient");
      await expect(current.service.forkManual(request)).resolves.toMatchObject({ status: "recovery_required", retryable: true });
      const retried = await current.service.forkManual(request);
      expect(retried).toMatchObject({ status: "recovery_required", retryable: true,
        diagnostic: "Claude session data is temporarily unavailable." });
      expect(current.bindings.findThreadDefinition(current.scope, retried.childThreadId)).toBeDefined();
      expect(current.lineage.isReservedForkChild(current.scope, {
        backendInstanceId: current.binding.backendInstanceId,
        backendConversationId: current.branchConversation.mock.calls[0]![0].requestedBackendConversationId!,
      })).toBe(true);
    } finally {
      stderr.mockRestore();
      current.database.close();
    }
  });

  it("recovers only crash-interrupted forks at startup and never discards one automatically", async () => {
    const current = fixture();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      current.branchConversation.mockRejectedValueOnce(new BackendError({ category: "submission_unknown", retryable: false,
        crossedSubmissionBoundary: true, safeMessage: "outcome unknown" }));
      const awaiting = await current.service.forkManual(current.manual("awaiting-user"));
      expect(awaiting).toMatchObject({ status: "recovery_required" });
      // A crash left this attempt with its provider call started.
      let interruptedId!: string;
      current.branchConversation.mockImplementationOnce(async (input) => {
        interruptedId = input.childApplicationThreadId;
        throw new Error("process_crashed_before_response");
      });
      const crashed = await current.service.forkManual(current.manual("crash-interrupted"));
      expect(crashed).toMatchObject({ status: "recovery_required" });
      current.database.prepare(`UPDATE conversation_creation_attempts SET phase = 'external_call_started', diagnostic = NULL,
        fork_uncertainty_kind = NULL WHERE application_thread_id = ?`).run(interruptedId);
      current.branchConversation.mockClear();
      current.branchConversation.mockRejectedValue(new BackendError({ category: "invalid_state", retryable: false,
        crossedSubmissionBoundary: false, safeMessage: "Claude did not start the fork: this Claude Code version is not supported.",
        backendCode: "claude_fork_launch_refused_version", forkRestart: "futile" }));
      await current.service.recoverInterruptedForks(current.scope);
      expect(current.branchConversation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ childApplicationThreadId: interruptedId }));
      expect(current.creation.findActiveForThread(current.scope, interruptedId)).toMatchObject({
        phase: "recovery_required", diagnostic: "Claude did not start the fork: this Claude Code version is not supported." });
      expect(current.bindings.findThreadDefinition(current.scope, interruptedId)).toBeDefined();
      expect(current.creation.findActiveForThread(current.scope, awaiting.childThreadId)).toMatchObject({ phase: "recovery_required" });
      expect(warn).toHaveBeenCalledWith("thread_fork_startup_recovery", expect.objectContaining({
        childThreadId: interruptedId, outcome: "recovery_required" }));
    } finally {
      stderr.mockRestore();
      warn.mockRestore();
      current.database.close();
    }
  });

  it("discards an unfinished fork on request without another provider call and quarantines its child", async () => {
    const current = fixture();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      current.branchConversation.mockRejectedValueOnce(new BackendError({ category: "submission_unknown", retryable: false,
        crossedSubmissionBoundary: true, safeMessage: "outcome unknown" }));
      const request = current.manual("discard-me");
      const stuck = await current.service.forkManual(request);
      expect(stuck).toMatchObject({ status: "recovery_required" });
      const reserved = current.branchConversation.mock.calls[0]![0].requestedBackendConversationId!;
      const discarded = await current.service.discardActive(current.scope, stuck.childThreadId);
      expect(discarded).toEqual({ status: "aborted", childThreadId: stuck.childThreadId,
        diagnostic: "The fork was discarded.", restartable: true });
      expect(current.branchConversation).toHaveBeenCalledOnce();
      expect(current.bindings.findThreadDefinition(current.scope, stuck.childThreadId)).toBeUndefined();
      expect(current.lineage.isReservedForkChild(current.scope, {
        backendInstanceId: current.binding.backendInstanceId, backendConversationId: reserved })).toBe(true);
      // Replaying the original fork request reports the discard.
      await expect(current.service.forkManual(request)).resolves.toEqual(discarded);
      await expect(current.service.discardActive(current.scope, stuck.childThreadId)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      stderr.mockRestore();
      current.database.close();
    }
  });

  it("refuses to discard a fork that is still being created or whose child the provider returned", async () => {
    const current = fixture();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let childThreadId!: string;
      current.branchConversation.mockImplementationOnce(async (input) => {
        childThreadId = input.childApplicationThreadId;
        await gate;
        throw new BackendError({ category: "submission_unknown", retryable: false, crossedSubmissionBoundary: true, safeMessage: "unknown" });
      });
      const forking = current.service.forkManual(current.manual("in-flight"));
      await vi.waitFor(() => expect(childThreadId).toBeDefined());
      await expect(current.service.discardActive(current.scope, childThreadId)).rejects.toMatchObject({
        code: "invalid_transition", message: "This fork is still being created. Wait for it to finish before discarding it." });
      release();
      await forking;

      current.setBranching(branching("provider_assigned", "potentially_unknown"));
      current.branchConversation.mockResolvedValue({ backendConversationId: "provider-returned",
        reconciliationToken: "token", opaqueBindingDetail: "detail" });
      current.failBoundDetailSaveOnce();
      const returned = await current.service.forkManual(current.manual("provider-returned"));
      await expect(current.service.discardActive(current.scope, returned.childThreadId)).rejects.toMatchObject({
        code: "invalid_transition" });
      expect(current.bindings.findThreadDefinition(current.scope, returned.childThreadId)).toBeDefined();
    } finally {
      stderr.mockRestore();
      current.database.close();
    }
  });

  it("rejects queued source work before actor or provider acquisition", async () => {
    const current = fixture();
    try {
      current.database
        .prepare(
          `
        INSERT INTO queued_inputs(
          tenant_id, owner_principal_id, id, application_thread_id,
          sequence, mutation_id, text, trigger_kind, state, created_at
        ) VALUES (?, ?, ?, ?, 1, ?, 'queued', 'user', 'pending', 500)
      `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          uuid(900),
          current.source.id,
          "queued-source-input",
        );
      await expect(
        current.service.forkManual(current.manual("queued-source-fork")),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      expect(current.targets.actor).not.toHaveBeenCalled();
      expect(current.branchConversation).not.toHaveBeenCalled();
    } finally {
      current.database.close();
    }
  });

  it("recovers a migrated automation fork from an unresolved normalized turn and durable provider leaf", async () => {
    const current = fixture();
    try {
      const automations = new AutomationRepository(current.database);
      automations.createDefinition(current.scope, {
        id: "migrated-clone",
        anchorThreadId: current.source.id,
        name: "Migrated clone",
        prompt: "continue",
        precheck: null,
        runMode: "clone",
        enabled: true,
        schedule: {
          kind: "interval",
          anchorAt: 1_000,
          everySeconds: 3_600,
        },
        misfirePolicy: "coalesce",
        nextRunAt: 4_600,
        now: 1_000,
      });
      automations.createManualRun(current.scope, "migrated-clone", {
        runId: "migrated-clone-run",
        occurrenceKey: "manual:migrated-clone-run",
        scheduledFor: 1_001,
        claimToken: "migrated-claim",
        leaseExpiresAt: 9_000,
        dispatchMutationId: "migrated-clone-operation",
        now: 1_001,
      });
      const request = {
        scope: current.scope,
        anchorThreadId: current.source.id,
        automationId: "migrated-clone",
        automationRunId: "migrated-clone-run",
        mutationId: "migrated-clone-operation",
      };
      current.failReadSettingsOnce();
      await expect(current.service.forkAutomation(request)).rejects.toThrow(
        "settings row missing",
      );
      const attempt = current.creation.findByMutationId(
        current.scope,
        request.mutationId,
      )!;
      current.database.exec(
        `DROP TRIGGER thread_fork_origins_immutable_update;
         DROP TRIGGER thread_fork_origins_fork_point_immutable;`,
      );
      current.database
        .prepare(
          `
        UPDATE thread_fork_origins
        SET source_turn_state = 'unresolved', source_turn_id = NULL,
          source_turn_completed_at = NULL
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND child_thread_id = ?
      `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          attempt.applicationThreadId,
        );
      current.database
        .prepare(
          `
        UPDATE backend_checkpoints SET application_turn_id = NULL
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
      `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          request.mutationId,
        );
      current.restoreSettings();
      current.branchConversation.mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage: "migrated fork outcome unknown",
        }),
      );
      await expect(
        current.service.forkAutomation(request),
      ).resolves.toMatchObject({
        status: "recovery_required",
        retryable: true,
      });
      expect(current.branchConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceCheckpoint: expect.objectContaining({
            opaqueReference: "source-leaf",
          }),
        }),
      );
    } finally {
      current.database.close();
    }
  });

  it("does not expose source creation or child placement across principals", async () => {
    const current = fixture();
    try {
      const foreignScope = {
        tenantId: current.scope.tenantId,
        principalId: "foreign-principal",
      };
      await expect(
        current.service.forkManual({
          ...current.manual("foreign-source-fork"),
          scope: foreignScope,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      const created = await current.service.forkManual(
        current.manual("foreign-placement-child"),
      );
      await expect(
        current.service.updatePlacement({
          scope: foreignScope,
          childThreadId: created.childThreadId,
          mode: "top_level",
          expectedRevision: 0,
          mutationId: "foreign-placement",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      current.database.close();
    }
  });

  it("signs descendant cursors without principal disclosure and rejects tamper, source reuse, and foreign scope", async () => {
    const current = fixture();
    try {
      await current.service.forkManual(current.manual("cursor-child-1"));
      await current.service.forkManual(current.manual("cursor-child-2"));
      const first = await current.service.listDescendants({
        scope: current.scope,
        sourceThreadId: current.source.id,
        pageSize: 1,
      });
      expect(first.nextCursor).toBeDefined();
      expect(first.descendants[0]?.thread.terminalSummary).toEqual({
        runningCount: 1,
        retainedCount: 2,
      });
      const cursor = first.nextCursor!;
      expect(cursor).not.toContain(current.scope.tenantId);
      expect(cursor).not.toContain(current.scope.principalId);
      const payload = Buffer.from(
        cursor.split(".")[0]!,
        "base64url",
      ).toString();
      expect(payload).not.toContain(current.scope.tenantId);
      expect(payload).not.toContain(current.scope.principalId);
      await expect(
        current.service.listDescendants({
          scope: current.scope,
          sourceThreadId: current.source.id,
          cursor,
          pageSize: 1,
        }),
      ).resolves.toMatchObject({ descendants: [expect.any(Object)] });
      const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
      await expect(
        current.service.listDescendants({
          scope: current.scope,
          sourceThreadId: current.source.id,
          cursor: tampered,
          pageSize: 1,
        }),
      ).rejects.toMatchObject({ code: "cursor_invalid" });
      await expect(
        current.service.listDescendants({
          scope: current.scope,
          sourceThreadId: current.secondSource.id,
          cursor,
          pageSize: 1,
        }),
      ).rejects.toMatchObject({ code: "cursor_invalid" });
      await expect(
        current.service.listDescendants({
          scope: {
            tenantId: current.scope.tenantId,
            principalId: "foreign-principal",
          },
          sourceThreadId: current.source.id,
          cursor,
          pageSize: 1,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      current.database.close();
    }
  });
});
