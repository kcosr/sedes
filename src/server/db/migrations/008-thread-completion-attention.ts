import type { DatabaseMigration } from "../migrate.js";

export const threadCompletionAttentionMigration: DatabaseMigration = {
  version: 8,
  name: "thread-completion-attention",
  sql: `
    ALTER TABLE thread_principal_state
      ADD COLUMN latest_agent_completion_id TEXT
        CHECK (
          latest_agent_completion_id IS NULL
          OR length(latest_agent_completion_id) BETWEEN 1 AND 128
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN latest_agent_completion_at INTEGER
        CHECK (
          latest_agent_completion_at IS NULL
          OR latest_agent_completion_at >= 0
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN seen_agent_completion_id TEXT
        CHECK (
          seen_agent_completion_id IS NULL
          OR length(seen_agent_completion_id) BETWEEN 1 AND 128
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN automation_context_run_id TEXT
        CHECK (
          automation_context_run_id IS NULL
          OR length(automation_context_run_id) BETWEEN 1 AND 128
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN automation_context_source_thread_id TEXT
        CHECK (
          automation_context_source_thread_id IS NULL
          OR length(automation_context_source_thread_id) BETWEEN 1 AND 128
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN automation_context_at INTEGER
        CHECK (
          automation_context_at IS NULL
          OR automation_context_at >= 0
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN automation_context_outcome TEXT
        CHECK (
          automation_context_outcome IS NULL
          OR automation_context_outcome IN ('triggered', 'failed')
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN automation_context_diagnostic TEXT
        CHECK (
          automation_context_diagnostic IS NULL
          OR length(automation_context_diagnostic) BETWEEN 1 AND 500
        );

    UPDATE thread_principal_state AS target
    SET
      automation_context_run_id = source.automation_notice_run_id,
      automation_context_source_thread_id = source.thread_id,
      automation_context_at = source.automation_notice_at,
      automation_context_outcome = CASE source.automation_notice_kind
        WHEN 'ran' THEN 'triggered'
        ELSE 'failed'
      END,
      automation_context_diagnostic = source.automation_notice_diagnostic
    FROM thread_principal_state AS source
    WHERE source.tenant_id = target.tenant_id
      AND source.principal_id = target.principal_id
      AND source.automation_notice_kind IS NOT NULL
      AND target.thread_id = COALESCE(
        source.automation_notice_result_thread_id,
        source.thread_id
      );

    UPDATE thread_principal_state
    SET woke_at = NULL,
      wake_reason = NULL,
      wake_acknowledged_at = NULL
    WHERE wake_reason = 'automation';

    DROP TRIGGER thread_attention_insert;
    DROP TRIGGER thread_attention_update;

    ALTER TABLE thread_principal_state DROP COLUMN automation_notice_kind;
    ALTER TABLE thread_principal_state DROP COLUMN automation_notice_run_id;
    ALTER TABLE thread_principal_state DROP COLUMN automation_notice_at;
    ALTER TABLE thread_principal_state
      DROP COLUMN automation_notice_result_thread_id;
    ALTER TABLE thread_principal_state
      DROP COLUMN automation_notice_diagnostic;

    CREATE TRIGGER thread_wake_reason_values_insert
    BEFORE INSERT ON thread_principal_state
    WHEN NEW.wake_reason = 'automation'
    BEGIN
      SELECT RAISE(ABORT, 'thread_wake_reason_invalid');
    END;

    CREATE TRIGGER thread_wake_reason_values_update
    BEFORE UPDATE OF wake_reason ON thread_principal_state
    WHEN NEW.wake_reason = 'automation'
    BEGIN
      SELECT RAISE(ABORT, 'thread_wake_reason_invalid');
    END;

    CREATE TRIGGER thread_completion_attention_insert
    BEFORE INSERT ON thread_principal_state
    BEGIN
      SELECT CASE
        WHEN
          (NEW.latest_agent_completion_id IS NULL)
          <> (NEW.latest_agent_completion_at IS NULL)
          OR
          (NEW.automation_context_run_id IS NULL)
          <> (NEW.automation_context_source_thread_id IS NULL)
          OR
          (NEW.automation_context_run_id IS NULL)
          <> (NEW.automation_context_at IS NULL)
          OR
          (NEW.automation_context_run_id IS NULL)
          <> (NEW.automation_context_outcome IS NULL)
          OR
          (
            NEW.automation_context_run_id IS NULL
            AND NEW.automation_context_diagnostic IS NOT NULL
          )
        THEN RAISE(ABORT, 'thread_completion_attention_incomplete')
      END;
    END;

    CREATE TRIGGER thread_completion_attention_update
    BEFORE UPDATE OF
      latest_agent_completion_id, latest_agent_completion_at,
      seen_agent_completion_id, automation_context_run_id,
      automation_context_source_thread_id, automation_context_at,
      automation_context_outcome, automation_context_diagnostic
    ON thread_principal_state
    BEGIN
      SELECT CASE
        WHEN
          (NEW.latest_agent_completion_id IS NULL)
          <> (NEW.latest_agent_completion_at IS NULL)
          OR
          (NEW.automation_context_run_id IS NULL)
          <> (NEW.automation_context_source_thread_id IS NULL)
          OR
          (NEW.automation_context_run_id IS NULL)
          <> (NEW.automation_context_at IS NULL)
          OR
          (NEW.automation_context_run_id IS NULL)
          <> (NEW.automation_context_outcome IS NULL)
          OR
          (
            NEW.automation_context_run_id IS NULL
            AND NEW.automation_context_diagnostic IS NOT NULL
          )
        THEN RAISE(ABORT, 'thread_completion_attention_incomplete')
      END;
    END;
  `,
};
