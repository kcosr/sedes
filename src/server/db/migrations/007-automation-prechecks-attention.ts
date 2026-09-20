import type { DatabaseMigration } from "../migrate.js";

export const automationPrechecksAttentionMigration: DatabaseMigration = {
  version: 7,
  name: "automation-prechecks-attention",
  sql: `
    ALTER TABLE automation_definitions
      ADD COLUMN precheck_command TEXT
        CHECK (
          precheck_command IS NULL
          OR length(CAST(precheck_command AS BLOB)) BETWEEN 1 AND 4096
        );
    ALTER TABLE automation_definitions
      ADD COLUMN precheck_timeout_seconds INTEGER
        CHECK (
          precheck_timeout_seconds IS NULL
          OR precheck_timeout_seconds BETWEEN 1 AND 60
        );
    ALTER TABLE automation_definitions
      ADD COLUMN precheck_include_stdout INTEGER
        CHECK (
          precheck_include_stdout IS NULL
          OR precheck_include_stdout IN (0, 1)
        );

    CREATE TRIGGER automation_definition_precheck_insert
    BEFORE INSERT ON automation_definitions
    BEGIN
      SELECT CASE
        WHEN
          (NEW.precheck_command IS NULL)
          <> (NEW.precheck_timeout_seconds IS NULL)
          OR
          (NEW.precheck_command IS NULL)
          <> (NEW.precheck_include_stdout IS NULL)
        THEN RAISE(ABORT, 'automation_precheck_incomplete')
      END;
    END;

    CREATE TRIGGER automation_definition_precheck_update
    BEFORE UPDATE OF
      precheck_command, precheck_timeout_seconds, precheck_include_stdout
    ON automation_definitions
    BEGIN
      SELECT CASE
        WHEN
          (NEW.precheck_command IS NULL)
          <> (NEW.precheck_timeout_seconds IS NULL)
          OR
          (NEW.precheck_command IS NULL)
          <> (NEW.precheck_include_stdout IS NULL)
        THEN RAISE(ABORT, 'automation_precheck_incomplete')
      END;
    END;

    ALTER TABLE automation_runs
      ADD COLUMN precheck_command_snapshot TEXT
        CHECK (
          precheck_command_snapshot IS NULL
          OR length(CAST(precheck_command_snapshot AS BLOB)) BETWEEN 1 AND 4096
        );
    ALTER TABLE automation_runs
      ADD COLUMN precheck_timeout_seconds INTEGER
        CHECK (
          precheck_timeout_seconds IS NULL
          OR precheck_timeout_seconds BETWEEN 1 AND 60
        );
    ALTER TABLE automation_runs
      ADD COLUMN precheck_include_stdout INTEGER
        CHECK (
          precheck_include_stdout IS NULL
          OR precheck_include_stdout IN (0, 1)
        );
    ALTER TABLE automation_runs
      ADD COLUMN precheck_status TEXT NOT NULL DEFAULT 'not_configured'
        CHECK (precheck_status IN (
          'not_configured', 'pending', 'checking', 'passed', 'skipped', 'failed'
        ));
    ALTER TABLE automation_runs
      ADD COLUMN precheck_started_at INTEGER
        CHECK (precheck_started_at IS NULL OR precheck_started_at >= claimed_at);
    ALTER TABLE automation_runs
      ADD COLUMN precheck_finished_at INTEGER
        CHECK (
          precheck_finished_at IS NULL
          OR (
            precheck_started_at IS NOT NULL
            AND precheck_finished_at >= precheck_started_at
          )
        );
    ALTER TABLE automation_runs
      ADD COLUMN precheck_exit_code INTEGER;
    ALTER TABLE automation_runs
      ADD COLUMN precheck_duration_ms INTEGER
        CHECK (precheck_duration_ms IS NULL OR precheck_duration_ms >= 0);
    ALTER TABLE automation_runs
      ADD COLUMN precheck_stdout_bytes INTEGER
        CHECK (precheck_stdout_bytes IS NULL OR precheck_stdout_bytes >= 0);
    ALTER TABLE automation_runs
      ADD COLUMN precheck_stdout_included INTEGER
        CHECK (
          precheck_stdout_included IS NULL
          OR precheck_stdout_included IN (0, 1)
        );

    CREATE TRIGGER automation_run_precheck_insert
    BEFORE INSERT ON automation_runs
    BEGIN
      SELECT CASE
        WHEN
          (NEW.precheck_command_snapshot IS NULL)
          <> (NEW.precheck_timeout_seconds IS NULL)
          OR
          (NEW.precheck_command_snapshot IS NULL)
          <> (NEW.precheck_include_stdout IS NULL)
          OR
          (
            NEW.precheck_command_snapshot IS NULL
            AND NEW.precheck_status <> 'not_configured'
          )
          OR
          (
            NEW.precheck_command_snapshot IS NOT NULL
            AND NEW.precheck_status = 'not_configured'
          )
        THEN RAISE(ABORT, 'automation_run_precheck_incomplete')
      END;
    END;

    CREATE TRIGGER automation_run_precheck_update
    BEFORE UPDATE OF
      precheck_command_snapshot, precheck_timeout_seconds,
      precheck_include_stdout, precheck_status
    ON automation_runs
    BEGIN
      SELECT CASE
        WHEN
          (NEW.precheck_command_snapshot IS NULL)
          <> (NEW.precheck_timeout_seconds IS NULL)
          OR
          (NEW.precheck_command_snapshot IS NULL)
          <> (NEW.precheck_include_stdout IS NULL)
          OR
          (
            NEW.precheck_command_snapshot IS NULL
            AND NEW.precheck_status <> 'not_configured'
          )
          OR
          (
            NEW.precheck_command_snapshot IS NOT NULL
            AND NEW.precheck_status = 'not_configured'
          )
        THEN RAISE(ABORT, 'automation_run_precheck_incomplete')
      END;
    END;

    ALTER TABLE thread_principal_state
      ADD COLUMN wake_reminder_text TEXT
        CHECK (
          wake_reminder_text IS NULL
          OR (
            length(wake_reminder_text) BETWEEN 1 AND 1000
            AND length(CAST(wake_reminder_text AS BLOB)) <= 4096
          )
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN automation_notice_kind TEXT
        CHECK (
          automation_notice_kind IS NULL
          OR automation_notice_kind IN ('ran', 'failed')
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN automation_notice_run_id TEXT
        CHECK (
          automation_notice_run_id IS NULL
          OR length(automation_notice_run_id) BETWEEN 1 AND 128
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN automation_notice_at INTEGER
        CHECK (automation_notice_at IS NULL OR automation_notice_at >= 0);
    ALTER TABLE thread_principal_state
      ADD COLUMN automation_notice_result_thread_id TEXT
        CHECK (
          automation_notice_result_thread_id IS NULL
          OR length(automation_notice_result_thread_id) BETWEEN 1 AND 128
        );
    ALTER TABLE thread_principal_state
      ADD COLUMN automation_notice_diagnostic TEXT
        CHECK (
          automation_notice_diagnostic IS NULL
          OR length(automation_notice_diagnostic) BETWEEN 1 AND 500
        );

    CREATE TRIGGER thread_attention_insert
    BEFORE INSERT ON thread_principal_state
    BEGIN
      SELECT CASE
        WHEN
          (NEW.automation_notice_kind IS NULL)
          <> (NEW.automation_notice_run_id IS NULL)
          OR
          (NEW.automation_notice_kind IS NULL)
          <> (NEW.automation_notice_at IS NULL)
          OR
          (
            NEW.automation_notice_kind IS NULL
            AND (
              NEW.automation_notice_result_thread_id IS NOT NULL
              OR NEW.automation_notice_diagnostic IS NOT NULL
            )
          )
        THEN RAISE(ABORT, 'thread_automation_notice_incomplete')
      END;
    END;

    CREATE TRIGGER thread_attention_update
    BEFORE UPDATE OF
      automation_notice_kind, automation_notice_run_id, automation_notice_at,
      automation_notice_result_thread_id, automation_notice_diagnostic
    ON thread_principal_state
    BEGIN
      SELECT CASE
        WHEN
          (NEW.automation_notice_kind IS NULL)
          <> (NEW.automation_notice_run_id IS NULL)
          OR
          (NEW.automation_notice_kind IS NULL)
          <> (NEW.automation_notice_at IS NULL)
          OR
          (
            NEW.automation_notice_kind IS NULL
            AND (
              NEW.automation_notice_result_thread_id IS NOT NULL
              OR NEW.automation_notice_diagnostic IS NOT NULL
            )
          )
        THEN RAISE(ABORT, 'thread_automation_notice_incomplete')
      END;
    END;
  `,
};
