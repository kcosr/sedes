import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { PrincipalAgentToolClientRepository } from "../../src/server/db/repositories/principal-agent-tool-client-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { createPrincipalAgentToolClientEligibility } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("principal tool-client provenance migration", () => {
  it("copies legacy provenance and enforces exact principal-client initiators", () => {
    const { database, scope } = savedAgentDatabase(60);
    try {
      const inventory = new InventoryRepository(database);
      const environment = inventory.getLocalEnvironment(scope);
      const workspace = inventory.upsertWorkspace(scope, {
        environmentId: environment.id,
        canonicalPath: "/tmp/principal-provenance-migration",
        displayName: "Principal provenance",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 100,
      });
      const profile = database
        .prepare(
          `SELECT id FROM agent_connection_profiles
           WHERE tenant_id = ? AND owner_principal_id = ? ORDER BY id LIMIT 1`,
        )
        .get(scope.tenantId, scope.principalId) as { readonly id: string };
      const bindings = new ConversationBindingRepository(database);
      const legacyThread = bindings.createUnboundThread(scope, {
        workspaceId: workspace.id,
        connectionProfileId: profile.id,
        title: "Legacy queue",
        now: 110,
      });
      const principalThread = bindings.createUnboundThread(scope, {
        workspaceId: workspace.id,
        connectionProfileId: profile.id,
        title: "Principal queue",
        now: 120,
      });
      database
        .prepare(
          `INSERT INTO queued_inputs(
             tenant_id, owner_principal_id, id, application_thread_id,
             sequence, mutation_id, text, state, created_at,
             context_excerpts_json, task_contexts_json, trigger_kind
           ) VALUES (?, ?, ?, ?, 1, ?, 'legacy', 'pending', 130,
             '[]', '[]', 'user')`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          "legacy-input",
          legacyThread.id,
          "legacy-mutation",
        );
      const clientId = randomUUID();
      new PrincipalAgentToolClientRepository(
        database,
        createPrincipalAgentToolClientEligibility(),
      ).create(scope, {
        id: clientId,
        creationRequestId: randomUUID(),
        name: "Provenance client",
        enabled: true,
        toolIds: ["thread.send"],
        defaultEnvironmentId: environment.id,
        allowedEnvironmentIds: [environment.id],
        credentialGeneration: 1,
        credentialVerifier: new Uint8Array(32).fill(7),
        now: 140,
      });

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      database
        .prepare(
          `UPDATE application_threads SET backing_state = 'bound'
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(scope.tenantId, scope.principalId, principalThread.id);

      expect(
        database
          .prepare(
            `SELECT initiating_agent_thread_id AS agentThreadId,
              initiating_tool_client_id AS clientId
             FROM queued_inputs WHERE id = 'legacy-input'`,
          )
          .get(),
      ).toEqual({ agentThreadId: null, clientId: null });

      const queue = new QueuedInputRepository(database);
      const queued = queue.enqueue(
        scope,
        principalThread.id,
        {
          mutationId: "principal-mutation",
          text: "principal input",
          contextExcerpts: [],
          attachmentIds: [],
          taskReferences: [],
          source: {
            kind: "principal_client_control",
            expectedThreadRevision: 0,
            initiatingToolClientId: clientId,
          },
          now: 150,
        },
      );
      expect(queued.item).toMatchObject({
        initiatingAgentThreadId: null,
        initiatingToolClientId: clientId,
      });

      database
        .prepare(
          `INSERT INTO thread_tool_creation_origins(
             tenant_id, owner_principal_id, thread_id, initiator_kind,
             initiating_tool_client_id, creation_mutation_id, created_at
           ) VALUES (?, ?, ?, 'principal_client', ?, ?, 155)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          legacyThread.id,
          clientId,
          "tool-create-mutation",
        );
      expect(() =>
        database
          .prepare(
            `UPDATE thread_tool_creation_origins SET created_at = 156
             WHERE tenant_id = ? AND owner_principal_id = ? AND thread_id = ?`,
          )
          .run(scope.tenantId, scope.principalId, legacyThread.id),
      ).toThrow(/immutable/i);

      const deletionGuardThread = bindings.createUnboundThread(scope, {
        workspaceId: workspace.id,
        connectionProfileId: profile.id,
        title: "Creation-origin cascade",
        now: 157,
      });
      database
        .prepare(
          `INSERT INTO thread_tool_creation_origins(
             tenant_id, owner_principal_id, thread_id, initiator_kind,
             initiating_tool_client_id, creation_mutation_id, created_at
           ) VALUES (?, ?, ?, 'principal_client', ?, ?, 158)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          deletionGuardThread.id,
          clientId,
          "cascade-origin-mutation",
        );
      expect(() =>
        database
          .prepare(
            `DELETE FROM thread_tool_creation_origins
             WHERE tenant_id = ? AND owner_principal_id = ? AND thread_id = ?`,
          )
          .run(scope.tenantId, scope.principalId, deletionGuardThread.id),
      ).toThrow(/immutable/i);
      expect(() =>
        database
          .prepare(
            `UPDATE queued_inputs SET initiating_agent_thread_id = ?
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .run(
            legacyThread.id,
            scope.tenantId,
            scope.principalId,
            queued.item.id,
          ),
      ).toThrow(/provenance is immutable/i);

      database
        .prepare(
          `UPDATE queued_inputs
           SET state = 'failed', resolved_at = 159, diagnostic = 'failed'
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(scope.tenantId, scope.principalId, queued.item.id);
      const retry = queue.retryFailed(
        scope,
        principalThread.id,
        queued.item.id,
        {
          id: "principal-retry",
          mutationId: "principal-retry-mutation",
          now: 160,
        },
      );
      const revision = database
        .prepare(
          `SELECT revision FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(scope.tenantId, scope.principalId, principalThread.id) as {
        readonly revision: number;
      };
      const differentCaller = queue.enqueue(scope, principalThread.id, {
        id: "agent-parent",
        mutationId: "agent-parent-mutation",
        text: "agent parent",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferences: [],
        source: {
          kind: "agent_control",
          expectedThreadRevision: revision.revision,
          initiatingAgentThreadId: legacyThread.id,
        },
        now: 161,
      });
      expect(() =>
        database
          .prepare(
            `UPDATE queued_inputs SET retry_of_id = ?
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .run(
            differentCaller.item.id,
            scope.tenantId,
            scope.principalId,
            retry.item.id,
          ),
      ).toThrow(/trigger provenance is invalid/i);

      expect(() =>
        database
          .prepare(
            `INSERT INTO aborted_thread_forks(
               tenant_id, owner_principal_id, creation_operation_id,
               reserved_child_thread_id, source_thread_id, source_turn_id,
               source_turn_revision, boundary_kind, source_kind,
               initiating_tool_client_id, diagnostic, aborted_at
             ) VALUES (?, ?, ?, ?, ?, 'turn-1', 1,
               'completed_turn_inclusive', 'principal_client', ?, 'aborted', 160)`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            "principal-abort",
            "reserved-principal-child",
            legacyThread.id,
            clientId,
          ),
      ).not.toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO aborted_thread_forks(
               tenant_id, owner_principal_id, creation_operation_id,
               reserved_child_thread_id, source_thread_id, source_turn_id,
               source_turn_revision, boundary_kind, source_kind,
               initiating_agent_thread_id, initiating_tool_client_id,
               diagnostic, aborted_at
             ) VALUES (?, ?, ?, ?, ?, 'turn-2', 1,
               'completed_turn_inclusive', 'principal_client', ?, ?, 'bad', 170)`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            "mixed-abort",
            "reserved-mixed-child",
            legacyThread.id,
            legacyThread.id,
            clientId,
          ),
      ).toThrow();

      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      database.close();
    }
  });
});
