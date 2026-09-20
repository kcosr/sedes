import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const THREAD_ID = "0198bb10-0000-7000-8000-000000000001";

function fixture() {
  const current = savedAgentDatabase(54);
  const environment = current.database
    .prepare(
      `SELECT id FROM execution_environments
       WHERE tenant_id = ? AND owner_principal_id = ? AND kind = 'local'`,
    )
    .get(current.scope.tenantId, current.scope.principalId) as { id: string };
  const profile = current.database
    .prepare(
      `SELECT id FROM agent_connection_profiles
       WHERE tenant_id = ? AND owner_principal_id = ?`,
    )
    .get(current.scope.tenantId, current.scope.principalId) as { id: string };
  const inventory = new InventoryRepository(current.database);
  const workspace = inventory.upsertWorkspace(current.scope, {
    id: "0198bb10-0000-7000-8000-000000000002",
    environmentId: environment.id,
    canonicalPath: "/tmp/task-reference-migration-workspace",
    displayName: "Task reference migration",
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: 0,
    now: 200,
  });
  new ConversationBindingRepository(current.database).createUnboundThread(
    current.scope,
    {
      id: THREAD_ID,
      workspaceId: workspace.id,
      connectionProfileId: profile.id,
      title: "Task reference migration",
      now: 201,
    },
  );
  return current;
}

describe("composer task references migration", () => {
  it("upgrades schema 54 with bounded JSON columns and task-aware content triggers", () => {
    const current = fixture();
    try {
      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      const expectedColumns = [
        ["thread_drafts", "task_references_json"],
        ["prompt_stashes", "task_references_json"],
        ["queued_inputs", "task_contexts_json"],
        ["conversation_creation_attempts", "initial_task_contexts_json"],
        ["mutation_receipts", "task_contexts_json"],
      ] as const;
      for (const [table, column] of expectedColumns) {
        const info = current.database.pragma(`table_info(${table})`) as Array<{
          name: string;
          notnull: 0 | 1;
          dflt_value: string | null;
        }>;
        expect(info.find(({ name }) => name === column)).toMatchObject({
          notnull: 1,
          dflt_value: "'[]'",
        });
      }
      const queueInfo = current.database.pragma(
        "table_info(queued_inputs)",
      ) as Array<{ name: string; notnull: 0 | 1; dflt_value: string | null }>;
      for (const name of [
        "requested_delivery_mode",
        "requested_steer_target_json",
        "steer_fallback_at",
        "requested_thread_revision",
        "requested_draft_revision",
      ]) {
        expect(queueInfo.find((column) => column.name === name)).toMatchObject({
          notnull: 0,
          dflt_value: null,
        });
      }
      const queueTableSql = (
        current.database
          .prepare(
            `SELECT sql FROM sqlite_master
             WHERE type = 'table' AND name = 'queued_inputs'`,
          )
          .get() as { sql: string }
      ).sql;
      expect(queueTableSql).toContain("requested_delivery_mode");
      expect(queueTableSql).toContain("requested_steer_target_json");
      expect(queueTableSql).toContain("steer_fallback_at");
      expect(queueTableSql).toContain("requested_thread_revision");
      expect(queueTableSql).toContain("requested_draft_revision");
      expect(queueTableSql).toContain("trigger_kind = 'user'");
      const triggers = current.database
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'trigger' AND name IN (
             'prompt_stashes_content_insert',
             'queued_inputs_content_insert',
             'conversation_creation_attempts_content_insert'
           ) ORDER BY name`,
        )
        .all() as Array<{ name: string; sql: string }>;
      expect(triggers).toHaveLength(3);
      expect(triggers.map(({ sql }) => sql).join("\n")).toContain(
        "task_references_json",
      );
      expect(triggers.map(({ sql }) => sql).join("\n")).toContain(
        "task_contexts_json",
      );
      expect(triggers.map(({ sql }) => sql).join("\n")).toContain(
        "initial_task_contexts_json",
      );

      const task = new TaskRepository(current.database).create(current.scope, {
        title: "Only composer content",
        scope: { kind: "global" },
        mutationId: "task-reference-migration-create",
        now: 202,
      });
      const inventory = new InventoryRepository(current.database);
      const draft = inventory.saveDraft(current.scope, THREAD_ID, {
        text: "",
        contextExcerpts: [],
        attachmentIds: [],
        taskReferenceIds: [task.id],
        expectedRevision: 0,
        now: 203,
      });
      const stashed = inventory.stashDraft(current.scope, THREAD_ID, {
        expectedDraftRevision: draft.revision,
        mutationId: "task-reference-migration-stash",
        maximumStashes: 10,
        now: 204,
      });
      expect(stashed.stash.taskReferences).toEqual([
        { taskId: task.id, titleSnapshot: "Only composer content" },
      ]);

      expect(() =>
        current.database
          .prepare(
            `INSERT INTO prompt_stashes(
               tenant_id, principal_id, thread_id, id, text,
               context_excerpts_json, task_references_json, created_at
             ) VALUES (?, ?, ?, ?, '', '[]', '[]', ?)`,
          )
          .run(
            current.scope.tenantId,
            current.scope.principalId,
            THREAD_ID,
            "empty-stash",
            205,
          ),
      ).toThrow("Prompt stash content is required");
      expect(() =>
        current.database
          .prepare(
            `UPDATE thread_drafts SET task_references_json = 'not-json'
             WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
          )
          .run(current.scope.tenantId, current.scope.principalId, THREAD_ID),
      ).toThrow();
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      current.database.close();
    }
  });
});
