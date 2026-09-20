import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { linkedWorktreeFilesRootsMigration } from "../../src/server/db/migrations/083-linked-worktree-files-roots.js";
import { threadWorktreePreferenceMigration } from "../../src/server/db/migrations/084-thread-worktree-preference.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("thread worktree preference migrations", () => {
  it("moves the preference to thread vocabulary and guards its workspace scope", () => {
    const value = savedAgentDatabase(82);
    try {
      const inventory = new InventoryRepository(value.database);
      const environment = inventory.getLocalEnvironment(value.scope);
      const workspace = inventory.upsertWorkspace(value.scope, {
        environmentId: environment.id,
        canonicalPath: "/projects/main",
        displayName: "Main",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 100,
      });
      const profile = value.database
        .prepare(
          `SELECT id FROM agent_connection_profiles
           WHERE tenant_id = ? AND owner_principal_id = ? LIMIT 1`,
        )
        .get(value.scope.tenantId, value.scope.principalId) as {
        readonly id: string;
      };
      const thread = new ConversationBindingRepository(
        value.database,
      ).createUnboundThread(value.scope, {
        workspaceId: workspace.id,
        connectionProfileId: profile.id,
        title: "Existing",
        now: 110,
      });

      applyDatabaseMigrations(
        value.database,
        backendNormalizedMigrations.filter(
          (migration) =>
            migration.version <= linkedWorktreeFilesRootsMigration.version,
        ),
      );

      const rootId = randomUUID();
      value.database
        .prepare(
          `INSERT INTO workspace_file_linked_worktree_roots(
             tenant_id, owner_principal_id, workspace_id, root_id,
             canonical_path, canonical_git_dir, identity_token, display_label, branch_ref,
             head_oid, availability, revision, first_seen_at, last_seen_at,
             unavailable_at
           ) VALUES (?, ?, ?, ?, '/projects/feature', '/projects/main/.git/worktrees/feature',
             ?, 'feature', 'refs/heads/feature', ?, 'available', 1, 120, 120, NULL)`,
        )
        .run(
          value.scope.tenantId,
          value.scope.principalId,
          workspace.id,
          rootId,
          "1".repeat(64),
          "a".repeat(40),
        );
      expect(() =>
        value.database
          .prepare(
            `UPDATE thread_principal_state
             SET preferred_files_root_id = ?, preferred_files_root_revision = 7
             WHERE thread_id = ?`,
          )
          .run(rootId, thread.id),
      ).not.toThrow();

      const policyIdentity = [
        value.scope.tenantId,
        value.scope.principalId,
        thread.id,
      ] as const;
      const insertPolicy = value.database.prepare(
        `INSERT INTO thread_agent_tool_policy_entries(
           tenant_id, owner_principal_id, application_thread_id, tool_id
         ) VALUES (?, ?, ?, ?)`,
      );
      insertPolicy.run(...policyIdentity, "files.worktree_list");
      insertPolicy.run(...policyIdentity, "thread.worktree_list");
      insertPolicy.run(...policyIdentity, "files.worktree_set");
      insertPolicy.run(...policyIdentity, "files.worktree_clear");
      value.database
        .prepare(
          `INSERT INTO mutation_receipts(
             tenant_id, principal_id, thread_id, mutation_id, operation_kind,
             request_fingerprint, result_code, result_json, replayable, created_at
           ) VALUES (?, ?, ?, ?, 'set_preferred_files_root', ?, 'completed',
             '{"preference":{"rootId":null,"revision":0}}', 1, 120)`,
        )
        .run(
          value.scope.tenantId,
          value.scope.principalId,
          thread.id,
          "88888888-8888-4888-8888-888888888888",
          "f".repeat(64),
        );
      const savedAgentId = "99999999-9999-4999-8999-999999999999";
      value.database
        .prepare(
          `INSERT INTO saved_agents(
             tenant_id, owner_principal_id, id, name, description,
             backend_type_id, backend_overrides_schema_version,
             backend_overrides_json, sedes_tools_json, revision,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'Legacy worktree tools', '', 'pi', 1, '[]', ?, 0, 120, 120)`,
        )
        .run(
          value.scope.tenantId,
          value.scope.principalId,
          savedAgentId,
          JSON.stringify({
            enabled: true,
            enabledToolIds: [
              "files.worktree_list",
              "files.worktree_set",
              "files.worktree_clear",
            ],
            presentationMode: "native_individual",
            environmentAccess: { otherEnvironments: "ask" },
          }),
        );

      applyDatabaseMigrations(
        value.database,
        backendNormalizedMigrations.filter(
          (migration) =>
            migration.version <= threadWorktreePreferenceMigration.version,
        ),
      );

      expect(
        value.database
          .prepare(
            `SELECT preferred_worktree_root_id AS rootId,
              preferred_worktree_revision AS revision
             FROM thread_principal_state WHERE thread_id = ?`,
          )
          .get(thread.id),
      ).toEqual({ rootId, revision: 7 });
      expect(
        value.database
          .prepare(
            `SELECT tool_id AS toolId FROM thread_agent_tool_policy_entries
             WHERE application_thread_id = ? ORDER BY tool_id`,
          )
          .all(thread.id),
      ).toEqual([
        { toolId: "thread.worktree_clear" },
        { toolId: "thread.worktree_list" },
        { toolId: "thread.worktree_set" },
      ]);
      expect(
        value.database
          .prepare(
            "SELECT sedes_tools_json AS value FROM saved_agents WHERE id = ?",
          )
          .get(savedAgentId),
      ).toEqual({
        value: JSON.stringify({
          enabled: true,
          enabledToolIds: [
            "thread.worktree_list",
            "thread.worktree_set",
            "thread.worktree_clear",
          ],
          presentationMode: "native_individual",
          environmentAccess: { otherEnvironments: "ask" },
        }),
      });
      expect(
        value.database
          .prepare(
            `SELECT count(*) AS count FROM mutation_receipts
             WHERE operation_kind = 'set_preferred_files_root'`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(() =>
        value.database
          .prepare(
            `UPDATE thread_principal_state SET preferred_worktree_root_id = ?
             WHERE thread_id = ?`,
          )
          .run(randomUUID(), thread.id),
      ).toThrow(/preferred worktree is not available/u);
      expect(value.database.pragma("foreign_key_check")).toEqual([]);
      expect(value.database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      value.database.close();
    }
  });
});
