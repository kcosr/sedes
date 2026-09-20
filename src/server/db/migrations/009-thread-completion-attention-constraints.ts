import type { DatabaseMigration } from "../migrate.js";

export const threadCompletionAttentionConstraintsMigration: DatabaseMigration = {
  version: 9,
  name: "thread-completion-attention-constraints",
  sql: `
    UPDATE thread_principal_state
    SET seen_agent_completion_id = NULL
    WHERE latest_agent_completion_id IS NULL
      AND seen_agent_completion_id IS NOT NULL;

    DROP TRIGGER thread_completion_attention_insert;
    DROP TRIGGER thread_completion_attention_update;

    CREATE TRIGGER thread_completion_attention_insert
    BEFORE INSERT ON thread_principal_state
    BEGIN
      SELECT CASE
        WHEN
          (NEW.latest_agent_completion_id IS NULL)
          <> (NEW.latest_agent_completion_at IS NULL)
          OR
          (
            NEW.latest_agent_completion_id IS NULL
            AND NEW.seen_agent_completion_id IS NOT NULL
          )
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
          (
            NEW.latest_agent_completion_id IS NULL
            AND NEW.seen_agent_completion_id IS NOT NULL
          )
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
