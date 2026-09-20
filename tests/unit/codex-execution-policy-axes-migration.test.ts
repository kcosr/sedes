import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { codexExecutionPolicyAxesMigration } from "../../src/server/db/migrations/018-codex-execution-policy-axes.js";

describe("Codex execution policy axes migration", () => {
  it("rebuilds populated schema-17 settings and snapshots without bundled columns", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      database.exec(`
        CREATE TABLE application_threads (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, owner_principal_id, id)
        ) STRICT;
        INSERT INTO application_threads VALUES
          ('tenant', 'principal', 'thread'),
          ('tenant', 'principal', 'imported'),
          ('tenant', 'principal', 'read-only'),
          ('tenant', 'principal', 'workspace');
        CREATE TABLE codex_thread_execution_settings (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          application_thread_id TEXT NOT NULL,
          desired_model TEXT,
          desired_reasoning_effort TEXT,
          desired_permission_profile TEXT,
          effective_model TEXT,
          effective_reasoning_effort TEXT,
          effective_permission_profile TEXT,
          effective_permission_classification TEXT,
          effective_daemon_generation INTEGER,
          effective_confirmation_state TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id)
        ) STRICT;
        CREATE TABLE codex_execution_settings_snapshots (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          application_thread_id TEXT NOT NULL,
          application_operation_id TEXT NOT NULL,
          settings_revision INTEGER NOT NULL,
          model TEXT NOT NULL,
          reasoning_effort TEXT NOT NULL,
          permission_profile TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id,
            application_operation_id)
        ) STRICT;
        CREATE TRIGGER codex_execution_settings_snapshots_immutable_update
        BEFORE UPDATE ON codex_execution_settings_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'Codex execution settings snapshots are immutable');
        END;
        CREATE TRIGGER codex_execution_settings_snapshots_immutable_delete
        BEFORE DELETE ON codex_execution_settings_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'Codex execution settings snapshots are immutable');
        END;
        INSERT INTO codex_thread_execution_settings VALUES (
          'tenant', 'principal', 'thread', 'gpt', 'high', 'unrestricted',
          'gpt', 'high', 'workspace', 'recognized', 3, 'confirmed', 4, 10, 11
        );
        INSERT INTO codex_thread_execution_settings VALUES (
          'tenant', 'principal', 'imported', NULL, NULL, NULL,
          'native-model', 'medium', NULL, 'external_custom', 4, 'confirmed',
          2, 12, 13
        );
        INSERT INTO codex_thread_execution_settings VALUES (
          'tenant', 'principal', 'read-only', 'gpt', 'low', 'read_only',
          'gpt', 'low', 'read_only', 'recognized', 5, 'confirmed', 3, 14, 15
        );
        INSERT INTO codex_thread_execution_settings VALUES (
          'tenant', 'principal', 'workspace', 'gpt', 'medium', 'workspace',
          NULL, NULL, NULL, NULL, NULL, 'unconfirmed', 1, 16, 17
        );
        INSERT INTO codex_execution_settings_snapshots VALUES
          ('tenant', 'principal', 'thread', 'unrestricted-operation', 4,
            'gpt', 'high', 'unrestricted', 18),
          ('tenant', 'principal', 'read-only', 'read-only-operation', 3,
            'gpt', 'low', 'read_only', 19),
          ('tenant', 'principal', 'workspace', 'workspace-operation', 1,
            'gpt', 'medium', 'workspace', 20);
      `);

      database.transaction(() => {
        database.exec(codexExecutionPolicyAxesMigration.sql);
      })();

      expect(database.prepare(`
        SELECT desired_sandbox_mode AS sandboxMode,
          desired_network_access AS networkAccess,
          desired_approval_policy AS approvalPolicy,
          desired_approval_reviewer AS approvalReviewer,
          effective_sandbox_mode AS effectiveSandbox,
          effective_network_access AS effectiveNetwork
        FROM codex_thread_execution_settings
        WHERE application_thread_id = 'thread'
      `).get()).toEqual({
        sandboxMode: "danger-full-access",
        networkAccess: "enabled",
        approvalPolicy: "never",
        approvalReviewer: "user",
        effectiveSandbox: "workspace-write",
        effectiveNetwork: "disabled",
      });
      expect(database.prepare(`
        SELECT application_thread_id AS threadId,
          desired_model AS model,
          desired_reasoning_effort AS reasoningEffort,
          desired_sandbox_mode AS sandboxMode,
          desired_network_access AS networkAccess,
          desired_approval_policy AS approvalPolicy,
          desired_approval_reviewer AS approvalReviewer
        FROM codex_thread_execution_settings
        ORDER BY application_thread_id
      `).all()).toEqual([
        {
          threadId: "imported",
          model: null,
          reasoningEffort: null,
          sandboxMode: null,
          networkAccess: null,
          approvalPolicy: null,
          approvalReviewer: null,
        },
        {
          threadId: "read-only",
          model: "gpt",
          reasoningEffort: "low",
          sandboxMode: "read-only",
          networkAccess: "disabled",
          approvalPolicy: "never",
          approvalReviewer: "user",
        },
        {
          threadId: "thread",
          model: "gpt",
          reasoningEffort: "high",
          sandboxMode: "danger-full-access",
          networkAccess: "enabled",
          approvalPolicy: "never",
          approvalReviewer: "user",
        },
        {
          threadId: "workspace",
          model: "gpt",
          reasoningEffort: "medium",
          sandboxMode: "workspace-write",
          networkAccess: "disabled",
          approvalPolicy: "on-request",
          approvalReviewer: "user",
        },
      ]);
      expect(database.prepare(`
        SELECT effective_sandbox_mode AS sandboxMode,
          effective_sandbox_classification AS sandboxClassification,
          effective_network_access AS networkAccess,
          effective_network_classification AS networkClassification,
          effective_approval_policy AS approvalPolicy,
          effective_approval_policy_classification AS approvalPolicyClassification,
          effective_approval_reviewer AS approvalReviewer,
          effective_approval_reviewer_classification AS approvalReviewerClassification
        FROM codex_thread_execution_settings
        WHERE application_thread_id = 'imported'
      `).get()).toEqual({
        sandboxMode: null,
        sandboxClassification: "external_custom",
        networkAccess: null,
        networkClassification: "external_custom",
        approvalPolicy: null,
        approvalPolicyClassification: "external_custom",
        approvalReviewer: null,
        approvalReviewerClassification: "external_custom",
      });
      expect(database.prepare(`
        SELECT application_thread_id AS threadId,
          sandbox_mode AS sandboxMode, network_access AS networkAccess,
          approval_policy AS approvalPolicy,
          approval_reviewer AS approvalReviewer
        FROM codex_execution_settings_snapshots
        ORDER BY application_thread_id
      `).all()).toEqual([
        {
          threadId: "read-only",
          sandboxMode: "read-only",
          networkAccess: "disabled",
          approvalPolicy: "never",
          approvalReviewer: "user",
        },
        {
          threadId: "thread",
          sandboxMode: "danger-full-access",
          networkAccess: "enabled",
          approvalPolicy: "never",
          approvalReviewer: "user",
        },
        {
          threadId: "workspace",
          sandboxMode: "workspace-write",
          networkAccess: "disabled",
          approvalPolicy: "on-request",
          approvalReviewer: "user",
        },
      ]);
      expect(database.prepare(`
        SELECT sandbox_mode AS sandboxMode, network_access AS networkAccess,
          approval_policy AS approvalPolicy,
          approval_reviewer AS approvalReviewer
        FROM codex_execution_settings_snapshots
        WHERE application_thread_id = 'thread'
      `).get()).toEqual({
        sandboxMode: "danger-full-access",
        networkAccess: "enabled",
        approvalPolicy: "never",
        approvalReviewer: "user",
      });
      expect(database.prepare(`
        SELECT name FROM pragma_table_info('codex_thread_execution_settings')
        WHERE name LIKE '%permission_profile%'
      `).all()).toEqual([]);
      expect(() => database.prepare(`
        UPDATE codex_execution_settings_snapshots SET model = 'changed'
      `).run()).toThrow(/immutable/i);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      database.close();
    }
  });
});
