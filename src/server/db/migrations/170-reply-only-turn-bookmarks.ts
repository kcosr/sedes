import type { DatabaseMigration } from "../migrate.js";

/**
 * A turn without a durable user prompt, such as a reply continued after
 * background work, is bookmarked by its reply. Every bookmark still needs one
 * preview to identify it.
 */
export const replyOnlyTurnBookmarksMigration: DatabaseMigration = {
  version: 170,
  name: "reply_only_turn_bookmarks",
  verifyDatabaseIntegrity: true,
  sql: `
DROP TRIGGER conversation_turn_bookmarks_capacity;
DROP INDEX conversation_turn_bookmarks_by_thread;
ALTER TABLE conversation_turn_bookmarks
  RENAME TO conversation_turn_bookmarks_previous;

CREATE TABLE conversation_turn_bookmarks (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 1 AND 160),
  user_preview TEXT CHECK (
    user_preview IS NULL OR (
      length(user_preview) BETWEEN 1 AND 1000
      AND length(CAST(user_preview AS BLOB)) <= 4000
    )
  ),
  assistant_preview TEXT CHECK (
    assistant_preview IS NULL OR (
      length(assistant_preview) BETWEEN 1 AND 1000
      AND length(CAST(assistant_preview AS BLOB)) <= 4000
    )
  ),
  response_state TEXT NOT NULL CHECK (
    response_state IN ('responded', 'no_response')
  ),
  created_at INTEGER NOT NULL CHECK (
    created_at BETWEEN 0 AND 9007199254740991
  ),
  PRIMARY KEY (tenant_id, principal_id, thread_id, turn_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id)
    ON DELETE CASCADE,
  CHECK (
    (response_state = 'responded' AND assistant_preview IS NOT NULL)
    OR (response_state = 'no_response' AND assistant_preview IS NULL)
  ),
  CHECK (user_preview IS NOT NULL OR assistant_preview IS NOT NULL)
) STRICT;

INSERT INTO conversation_turn_bookmarks(
  tenant_id, principal_id, thread_id, turn_id, user_preview,
  assistant_preview, response_state, created_at
)
SELECT tenant_id, principal_id, thread_id, turn_id, user_preview,
  assistant_preview, response_state, created_at
FROM conversation_turn_bookmarks_previous;
DROP TABLE conversation_turn_bookmarks_previous;

CREATE INDEX conversation_turn_bookmarks_by_thread
  ON conversation_turn_bookmarks(
    tenant_id, principal_id, thread_id, created_at, turn_id
  );

CREATE TRIGGER conversation_turn_bookmarks_capacity
BEFORE INSERT ON conversation_turn_bookmarks
WHEN NOT EXISTS (
  SELECT 1
  FROM conversation_turn_bookmarks AS same_bookmark
  WHERE same_bookmark.tenant_id = NEW.tenant_id
    AND same_bookmark.principal_id = NEW.principal_id
    AND same_bookmark.thread_id = NEW.thread_id
    AND same_bookmark.turn_id = NEW.turn_id
) AND (
  SELECT COUNT(*)
  FROM conversation_turn_bookmarks AS existing
  WHERE existing.tenant_id = NEW.tenant_id
    AND existing.principal_id = NEW.principal_id
    AND existing.thread_id = NEW.thread_id
) >= 500
BEGIN
  SELECT RAISE(ABORT, 'conversation_turn_bookmark_limit_reached');
END;
`,
};
