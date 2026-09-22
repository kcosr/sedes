import type { DatabaseMigration } from "../migrate.js";

export const durableUsageAccountingMigration: DatabaseMigration = {
  version: 110,
  name: "durable_usage_accounting",
  sql: `
CREATE TABLE usage_thread_state (
  tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  report_json TEXT, legacy_json TEXT,
  PRIMARY KEY (tenant_id, principal_id, thread_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT
) STRICT;
INSERT INTO usage_thread_state(tenant_id, principal_id, thread_id, legacy_json)
SELECT tenant_id, owner_principal_id, application_thread_id,
  json_object('input', CAST(input_tokens AS TEXT), 'output', CAST(output_tokens AS TEXT),
    'cacheRead', CAST(cache_read_tokens AS TEXT), 'cacheWrite', CAST(cache_write_tokens AS TEXT),
    'requests', CAST(request_count AS TEXT), 'updatedAt', updated_at)
FROM claude_usage_ledgers;
DROP TABLE claude_usage_ledgers;
CREATE TABLE usage_turn_state (
  tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL, status TEXT NOT NULL, report_json TEXT,
  origin_thread_id TEXT, origin_turn_id TEXT,
  CHECK ((origin_thread_id IS NULL) = (origin_turn_id IS NULL)),
  PRIMARY KEY (tenant_id, principal_id, thread_id, turn_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES usage_thread_state(tenant_id, principal_id, thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, principal_id, origin_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE usage_sources (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  backend_id TEXT NOT NULL, environment_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  native_namespace TEXT NOT NULL, native_session TEXT NOT NULL, epoch TEXT NOT NULL, normalization_version TEXT NOT NULL,
  baseline TEXT NOT NULL CHECK (baseline IN ('proven_zero', 'unknown')),
  capture_state TEXT NOT NULL CHECK (capture_state IN ('active', 'idle', 'disconnected', 'failed')),
  frontier TEXT,
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES usage_thread_state(tenant_id, principal_id, thread_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX usage_sources_thread ON usage_sources(tenant_id, principal_id, thread_id);
CREATE TABLE usage_observations (
  source_id TEXT NOT NULL, observation_id TEXT NOT NULL, revision TEXT NOT NULL,
  fingerprint TEXT NOT NULL, evidence_json TEXT NOT NULL, normalization_version TEXT NOT NULL,
  occurred_at TEXT, received_at TEXT NOT NULL,
  PRIMARY KEY(source_id, observation_id, revision),
  FOREIGN KEY(source_id) REFERENCES usage_sources(id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE usage_records (
  source_id TEXT NOT NULL, fact_id TEXT NOT NULL, observation_id TEXT NOT NULL,
  observation_revision TEXT NOT NULL, turn_id TEXT, fact_json TEXT NOT NULL,
  input INTEGER CHECK(input >= 0), uncachedInput INTEGER CHECK(uncachedInput >= 0),
  cacheRead INTEGER CHECK(cacheRead >= 0), cacheWrite INTEGER CHECK(cacheWrite >= 0),
  output INTEGER CHECK(output >= 0), reasoning INTEGER CHECK(reasoning >= 0),
  total INTEGER CHECK(total >= 0), requests INTEGER CHECK(requests >= 0),
  PRIMARY KEY(source_id, fact_id),
  FOREIGN KEY(source_id, observation_id, observation_revision)
    REFERENCES usage_observations(source_id, observation_id, revision) ON DELETE RESTRICT
) STRICT;
CREATE INDEX usage_records_turn ON usage_records(turn_id, source_id);
CREATE TABLE usage_gaps (
  source_id TEXT NOT NULL, reason TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', recorded_at TEXT NOT NULL,
  PRIMARY KEY(source_id, reason, subject),
  FOREIGN KEY(source_id) REFERENCES usage_sources(id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER usage_observations_immutable_update BEFORE UPDATE ON usage_observations
BEGIN SELECT RAISE(ABORT, 'Usage evidence is immutable'); END;
CREATE TRIGGER usage_observations_immutable_delete BEFORE DELETE ON usage_observations
BEGIN SELECT RAISE(ABORT, 'Usage evidence is immutable'); END;
INSERT INTO usage_sources(id,tenant_id,principal_id,thread_id,backend_id,environment_id,workspace_id,native_namespace,native_session,epoch,normalization_version,baseline,capture_state)
SELECT 'legacy:' || hex(s.tenant_id) || ':' || hex(s.principal_id) || ':' || hex(s.thread_id),
  s.tenant_id,s.principal_id,s.thread_id,t.backend_instance_id,t.environment_id,t.workspace_id,
  'legacy_claude',s.thread_id,'legacy','legacy-claude-v1','unknown','idle'
FROM usage_thread_state s JOIN application_threads t ON t.tenant_id=s.tenant_id AND t.owner_principal_id=s.principal_id AND t.id=s.thread_id
WHERE s.legacy_json IS NOT NULL;
INSERT INTO usage_observations(source_id,observation_id,revision,fingerprint,evidence_json,normalization_version,occurred_at,received_at)
SELECT u.id,'legacy_claude','1','legacy',s.legacy_json,'legacy-claude-v1',
  strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(s.legacy_json,'$.updatedAt')/1000.0,'unixepoch'),
  strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(s.legacy_json,'$.updatedAt')/1000.0,'unixepoch')
FROM usage_sources u JOIN usage_thread_state s ON s.tenant_id=u.tenant_id AND s.principal_id=u.principal_id AND s.thread_id=u.thread_id WHERE u.epoch='legacy';
`,
};
