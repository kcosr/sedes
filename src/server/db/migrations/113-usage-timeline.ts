import type { DatabaseMigration } from "../migrate.js";

/**
 * Derived analytics projection. Each row is one accepted increase of a
 * source's canonical session selection, with the dimensions and time evidence
 * known at capture. Existing sources are rebuilt by a bounded replay.
 */
export const usageTimelineMigration: DatabaseMigration = {
  version: 113,
  name: "usage_timeline",
  sql: `
CREATE TABLE usage_increments (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  source_id TEXT NOT NULL, fact_id TEXT NOT NULL,
  observation_id TEXT NOT NULL, observation_revision TEXT NOT NULL,
  turn_id TEXT,
  backend_id TEXT NOT NULL, backend_kind TEXT NOT NULL,
  environment_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  agent_role TEXT NOT NULL CHECK(agent_role IN ('main', 'subagent')),
  activity TEXT NOT NULL,
  provider TEXT, model TEXT, effort TEXT,
  placement TEXT NOT NULL CHECK(placement IN ('reported', 'observed', 'interval', 'unplaced')),
  occurred_at TEXT NOT NULL,
  interval_start TEXT,
  input INTEGER CHECK(input >= 0), uncached_input INTEGER CHECK(uncached_input >= 0),
  cache_read INTEGER CHECK(cache_read >= 0), cache_write INTEGER CHECK(cache_write >= 0),
  output INTEGER CHECK(output >= 0), reasoning INTEGER CHECK(reasoning >= 0),
  requests INTEGER CHECK(requests >= 0),
  cost_units INTEGER CHECK(cost_units >= 0), currency TEXT, cost_kind TEXT CHECK(cost_kind IN ('estimated', 'reported')),
  -- Whether cost for this row's work is recorded on this row or a sibling cost summary.
  costed INTEGER NOT NULL CHECK(costed IN (0, 1)),
  CHECK((placement = 'interval') = (interval_start IS NOT NULL)),
  CHECK((cost_units IS NULL) = (currency IS NULL) AND (cost_units IS NULL) = (cost_kind IS NULL)),
  UNIQUE(source_id, fact_id, observation_id, observation_revision),
  FOREIGN KEY(source_id) REFERENCES usage_sources(id) ON DELETE RESTRICT,
  FOREIGN KEY(source_id, observation_id, observation_revision)
    REFERENCES usage_observations(source_id, observation_id, revision) ON DELETE RESTRICT
) STRICT;
CREATE INDEX usage_increments_time ON usage_increments(tenant_id, principal_id, occurred_at);
CREATE INDEX usage_increments_thread ON usage_increments(tenant_id, principal_id, thread_id);
ALTER TABLE usage_sources ADD COLUMN timeline_state TEXT NOT NULL DEFAULT 'current'
  CHECK(timeline_state IN ('current', 'backfill'));
-- Receipt of the latest checkpoint this source's series accepted or confirmed.
ALTER TABLE usage_sources ADD COLUMN timeline_receipt TEXT;
UPDATE usage_sources SET timeline_state='backfill';
`,
};
