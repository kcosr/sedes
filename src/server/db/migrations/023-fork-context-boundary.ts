import type { DatabaseMigration } from "../migrate.js";

export const forkContextBoundaryMigration: DatabaseMigration = {
  version: 23,
  name: "fork-context-boundary",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE fork_context_boundary_migration_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
) STRICT;

CREATE TRIGGER fork_context_boundary_migration_requires_quiescence
BEFORE INSERT ON fork_context_boundary_migration_guard
WHEN EXISTS (
  SELECT 1 FROM conversation_creation_attempts
  WHERE creation_kind = 'fork'
    AND source_kind = 'user_fork'
    AND phase NOT IN ('bound', 'aborted_unpersisted')
)
BEGIN
  SELECT RAISE(ABORT,
    'Resolve active user forks before schema-23 migration');
END;

INSERT INTO fork_context_boundary_migration_guard(singleton) VALUES (1);
DROP TRIGGER fork_context_boundary_migration_requires_quiescence;
DROP TABLE fork_context_boundary_migration_guard;

ALTER TABLE conversation_creation_attempts
  ADD COLUMN fork_context_boundary_version INTEGER
    CHECK (fork_context_boundary_version IS NULL OR fork_context_boundary_version = 1);

ALTER TABLE conversation_creation_attempts
  ADD COLUMN fork_context_boundary_state TEXT
    CHECK (fork_context_boundary_state IS NULL OR fork_context_boundary_state IN (
      'pending', 'applying', 'applied', 'unknown'
    ));

CREATE TRIGGER conversation_creation_attempts_boundary_pair_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN ((NEW.fork_context_boundary_version IS NULL) !=
      (NEW.fork_context_boundary_state IS NULL))
  OR (NEW.fork_context_boundary_version IS NOT NULL AND NOT (
    NEW.creation_kind = 'fork' AND NEW.source_kind = 'user_fork'
  ))
BEGIN
  SELECT RAISE(ABORT, 'Invalid fork context boundary state');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_pair_update
BEFORE UPDATE OF fork_context_boundary_version, fork_context_boundary_state,
  creation_kind, source_kind ON conversation_creation_attempts
WHEN ((NEW.fork_context_boundary_version IS NULL) !=
      (NEW.fork_context_boundary_state IS NULL))
  OR (NEW.fork_context_boundary_version IS NOT NULL AND NOT (
    NEW.creation_kind = 'fork' AND NEW.source_kind = 'user_fork'
  ))
  OR NEW.fork_context_boundary_version IS NOT OLD.fork_context_boundary_version
BEGIN
  SELECT RAISE(ABORT, 'Invalid fork context boundary state');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_transition
BEFORE UPDATE OF fork_context_boundary_state ON conversation_creation_attempts
WHEN OLD.fork_context_boundary_version = 1
  AND NEW.fork_context_boundary_state IS NOT OLD.fork_context_boundary_state
  AND NOT (
    (OLD.fork_context_boundary_state = 'pending' AND NEW.fork_context_boundary_state = 'applying')
    OR (OLD.fork_context_boundary_state = 'applying' AND NEW.fork_context_boundary_state IN ('pending', 'applied', 'unknown'))
    OR (OLD.fork_context_boundary_state IN ('pending', 'applying', 'unknown') AND NEW.fork_context_boundary_state = 'applied')
  )
BEGIN
  SELECT RAISE(ABORT, 'Invalid fork context boundary transition');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_bound_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN NEW.phase = 'bound'
  AND NEW.creation_kind = 'fork'
  AND NEW.source_kind = 'user_fork'
  AND (NEW.fork_context_boundary_version IS NOT 1
    OR NEW.fork_context_boundary_state IS NOT 'applied')
BEGIN
  SELECT RAISE(ABORT, 'Fork context boundary must be applied before binding');
END;

CREATE TRIGGER conversation_creation_attempts_boundary_bound_update
BEFORE UPDATE OF phase, fork_context_boundary_state
ON conversation_creation_attempts
WHEN NEW.phase = 'bound'
  AND NEW.creation_kind = 'fork'
  AND NEW.source_kind = 'user_fork'
  AND (NEW.fork_context_boundary_version IS NOT 1
    OR NEW.fork_context_boundary_state IS NOT 'applied')
BEGIN
  SELECT RAISE(ABORT, 'Fork context boundary must be applied before binding');
END;
`,
};
