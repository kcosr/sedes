import type { DatabaseMigration } from "../migrate.js";

export const claudeLocalTitleMigration: DatabaseMigration = {
  version: 173,
  name: "claude_local_title",
  sql: `
ALTER TABLE claude_thread_settings
  ADD COLUMN local_title_override INTEGER NOT NULL DEFAULT 0 CHECK (local_title_override IN (0, 1));

-- The draft and bound rename paths record successful titles in different receipts.
-- Use insertion order to break ties between requests made in the same millisecond.
CREATE TEMP TABLE claude_title_backfill AS
WITH successful_renames AS (
  SELECT r.tenant_id, r.principal_id, r.thread_id, r.result_json, r.created_at, r.rowid AS receipt_order,
    CASE r.operation_kind WHEN 'rename_thread' THEN '$.title' ELSE '$.operation.title' END AS title_path
  FROM mutation_receipts AS r
  JOIN claude_thread_settings AS settings
    ON (settings.tenant_id, settings.owner_principal_id, settings.application_thread_id)
       = (r.tenant_id, r.principal_id, r.thread_id)
  JOIN agent_backend_instances AS backend
    ON backend.tenant_id = settings.tenant_id AND backend.id = settings.backend_instance_id
       AND backend.kind = 'claude_agent_sdk'
  WHERE (r.operation_kind = 'rename_thread' AND r.result_code = 'completed')
     OR (r.operation_kind = 'conversation_rename' AND r.result_code = 'accepted')
), ranked_titles AS (
  SELECT tenant_id, principal_id, thread_id, json_extract(result_json, title_path) AS title,
    json_type(result_json, title_path) AS title_type,
    row_number() OVER (
      PARTITION BY tenant_id, principal_id, thread_id ORDER BY created_at DESC, receipt_order DESC
    ) AS rank
  FROM successful_renames
)
SELECT r.tenant_id, r.principal_id, r.thread_id, r.title, thread.title <> r.title AS changed
FROM ranked_titles AS r
JOIN application_threads AS thread
  ON (thread.tenant_id, thread.owner_principal_id, thread.id) = (r.tenant_id, r.principal_id, r.thread_id)
-- A newer successful rename supersedes all previous names even if its title was lost.
WHERE r.rank = 1 AND r.title_type = 'text' AND length(r.title) BETWEEN 1 AND 240 AND trim(r.title) <> '';

UPDATE claude_thread_settings SET local_title_override = 1
WHERE (tenant_id, owner_principal_id, application_thread_id) IN
  (SELECT tenant_id, principal_id, thread_id FROM claude_title_backfill);

UPDATE application_threads AS thread
SET title = restored.title, revision = thread.revision + 1,
  updated_at = max(thread.updated_at, CAST(round(unixepoch('subsec') * 1000) AS INTEGER))
FROM claude_title_backfill AS restored
WHERE (thread.tenant_id, thread.owner_principal_id, thread.id) = (restored.tenant_id, restored.principal_id, restored.thread_id)
  AND restored.changed;

UPDATE principal_generations SET inventory_generation = inventory_generation + 1
WHERE (tenant_id, principal_id) IN
  (SELECT tenant_id, principal_id FROM claude_title_backfill WHERE changed);

DROP TABLE temp.claude_title_backfill;

-- Draft rename is available without a running backend. Its completed receipt
-- is written in the same transaction as the application title.
CREATE TRIGGER claude_draft_rename_override AFTER INSERT ON mutation_receipts
WHEN NEW.operation_kind = 'rename_thread' AND NEW.result_code = 'completed'
  AND EXISTS (
    SELECT 1 FROM application_threads AS thread
    JOIN agent_backend_instances AS backend
      ON backend.tenant_id = thread.tenant_id AND backend.id = thread.backend_instance_id
    WHERE (thread.tenant_id, thread.owner_principal_id, thread.id) = (NEW.tenant_id, NEW.principal_id, NEW.thread_id)
      AND backend.kind = 'claude_agent_sdk'
  )
BEGIN
  UPDATE claude_thread_settings SET local_title_override = 1, updated_at = max(updated_at, NEW.created_at)
  WHERE (tenant_id, owner_principal_id, application_thread_id) = (NEW.tenant_id, NEW.principal_id, NEW.thread_id);
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'claude_thread_settings_missing') END;
END;
`,
};
