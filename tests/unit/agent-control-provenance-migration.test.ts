import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

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

describe("agent-control provenance migration", () => {
  it("preserves legacy attempts and enforces principal-scoped initiating threads", () => {
    const database = openOverlayDatabase(":memory:");
    const scope = new SingleUserIdentityProvider(database).getScope();
    const legacy = new ThreadInventoryService(new OverlayRepository(database));
    const environment = legacy.getLocalEnvironment(scope);
    const workspace = legacy.rememberWorkspace(
      scope,
      {
        environmentId: environment.id,
        canonicalPath: "/tmp/agent-control-migration",
        displayName: "Agent control migration",
        availability: "available",
        trustState: "trusted",
      },
      10,
    );
    const source = legacy.createThread(
      scope,
      { workspaceId: workspace.id, title: "Controller" },
      20,
    );
    const target = legacy.createThread(
      scope,
      { workspaceId: workspace.id, title: "Target" },
      30,
    );
    legacy.saveDraft(
      scope,
      source.thread.id,
      { text: "legacy composer input", expectedRevision: 0 },
      40,
    );
    applyBackendNormalizationMigration(database, {
      configuration,
      quiescentCutoverConfirmed: true,
      appliedAt: 50,
    });
    applyDatabaseMigrations(
      database,
      backendNormalizedMigrations.filter(({ version }) => version <= 49),
    );
    const sourceTarget = database
      .prepare(
        `SELECT backend_instance_id AS backendInstanceId,
          connection_profile_id AS connectionProfileId,
          environment_id AS environmentId
        FROM application_threads
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.principalId, source.thread.id) as {
      backendInstanceId: string;
      connectionProfileId: string;
      environmentId: string;
    };
    database
      .prepare(
        `INSERT INTO conversation_creation_attempts(
          tenant_id, owner_principal_id, application_thread_id, attempt_id,
          mutation_id, backend_instance_id, connection_profile_id,
          execution_environment_id, creation_kind, source_kind,
          initial_input_text, consumed_draft_revision,
          backend_creation_correlation, phase, prepared_at,
          initial_context_excerpts_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'first_input', 'composer',
          ?, 2, ?, 'prepared', ?, '[]')`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        source.thread.id,
        "legacy-attempt",
        "legacy-mutation",
        sourceTarget.backendInstanceId,
        sourceTarget.connectionProfileId,
        sourceTarget.environmentId,
        "legacy composer input",
        "legacy-correlation",
        60,
      );

    applyDatabaseMigrations(database, backendNormalizedMigrations);
    const creation = new ConversationCreationRepository(database);

    expect(creation.findByMutationId(scope, "legacy-mutation")).toMatchObject({
      sourceKind: "composer",
      initiatingAgentThreadId: null,
      initialInputText: "legacy composer input",
    });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("integrity_check")).toEqual([
      { integrity_check: "ok" },
    ]);

    const targetDraftBefore = new ConversationDraftRepository(database).get(
      scope,
      target.thread.id,
    );
    const agentAttempt = creation.prepare(scope, target.thread.id, {
      attemptId: "agent-attempt",
      mutationId: "agent-mutation",
      expectedThreadRevision: 0,
      creationKind: "first_input",
      sourceKind: "agent_control",
      initiatingAgentThreadId: source.thread.id,
      initialInputText: "delegated input",
      initialAttachmentIds: [],
      backendCreationCorrelation: "agent-correlation",
      now: 70,
    });
    expect(agentAttempt).toMatchObject({
      sourceKind: "agent_control",
      initiatingAgentThreadId: source.thread.id,
      consumedDraftRevision: null,
    });
    expect(
      new ConversationDraftRepository(database).get(scope, target.thread.id),
    ).toEqual(targetDraftBefore);

    expect(() =>
      database
        .prepare(
          `INSERT INTO queued_inputs(
            tenant_id, owner_principal_id, id, application_thread_id,
            sequence, mutation_id, text, context_excerpts_json, trigger_kind,
            initiating_agent_thread_id, state, created_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, '[]', 'user', ?, 'pending', ?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          "bad-agent-input",
          target.thread.id,
          "bad-agent-mutation",
          "bad source",
          "missing-controller",
          80,
        ),
    ).toThrow(/Agent-control queue source thread is invalid/);
    expect(
      new QueuedInputRepository(database).list(scope, target.thread.id),
    ).toEqual([]);

    const abortedInsert = database.prepare(
      `INSERT INTO aborted_thread_forks(
        tenant_id, owner_principal_id, creation_operation_id,
        reserved_child_thread_id, source_thread_id, source_turn_id,
        source_turn_revision, boundary_kind, source_kind, initiating_agent_thread_id,
        diagnostic, aborted_at
      ) VALUES (?, ?, ?, ?, ?, 'turn-1', 1, 'completed_turn_inclusive',
        'agent_control', ?, ?, ?)`,
    );
    expect(() =>
      abortedInsert.run(
        scope.tenantId,
        scope.principalId,
        "agent-abort-without-source",
        "reserved-child-1",
        target.thread.id,
        null,
        "aborted",
        90,
      ),
    ).toThrow();
    expect(() =>
      abortedInsert.run(
        scope.tenantId,
        scope.principalId,
        "agent-abort",
        "reserved-child-2",
        target.thread.id,
        source.thread.id,
        "aborted",
        91,
      ),
    ).not.toThrow();
    expect(
      database
        .prepare(
          `SELECT source_kind AS sourceKind,
            initiating_agent_thread_id AS initiatingAgentThreadId
          FROM aborted_thread_forks WHERE creation_operation_id = ?`,
        )
        .get("agent-abort"),
    ).toEqual({
      sourceKind: "agent_control",
      initiatingAgentThreadId: source.thread.id,
    });
    database.close();
  });
});
