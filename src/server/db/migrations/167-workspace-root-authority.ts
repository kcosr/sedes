import { canonicalLocalRootPath } from "../../execution/local-workspace-roots.js";
import type { DatabaseMigration } from "../migrate.js";
import { isWithinRemoteRoot } from "../../execution/remote-path.js";

export const workspaceRootAuthorityMigration: DatabaseMigration = {
  version: 167,
  name: "workspace_root_authority",
  preflight(database) {
    database.function("sedes_root_path_167", (kind, path) =>
      typeof path !== "string" ? null : kind === "local" ? canonicalLocalRootPath(path) ?? null : path);
    database.function("sedes_path_within_root_167", { deterministic: true }, (candidate, root) =>
      Number(typeof candidate === "string" && typeof root === "string" && isWithinRemoteRoot(candidate, root)));
  },
  sql: `
ALTER TABLE workspaces ADD COLUMN authority_root_id TEXT;
WITH roots AS MATERIALIZED (
  SELECT p.tenant_id, p.owner_principal_id, p.environment_id, e.configuration_revision,
    json_extract(root.value, '$.id') AS root_id, json_extract(root.value, '$.generation') AS generation,
    sedes_root_path_167(e.kind, json_extract(root.value, '$.path')) AS root_path
  FROM live_execution_policies AS p JOIN execution_environments AS e
    ON e.tenant_id = p.tenant_id AND e.owner_principal_id = p.owner_principal_id AND e.id = p.environment_id
  CROSS JOIN json_each(p.snapshot_json, '$.roots') AS root
), matches AS (
  SELECT w.rowid AS workspace_rowid, r.root_id, r.generation,
    ROW_NUMBER() OVER (PARTITION BY w.rowid ORDER BY length(r.root_path) DESC, r.root_id) AS priority
  FROM workspaces AS w JOIN roots AS r
    ON r.tenant_id = w.tenant_id AND r.owner_principal_id = w.owner_principal_id AND r.environment_id = w.environment_id
  WHERE w.removed_at IS NULL AND w.environment_configuration_revision = r.configuration_revision
    AND sedes_path_within_root_167(w.canonical_path, r.root_path)
)
UPDATE workspaces AS w SET authority_root_id = m.root_id, environment_configuration_revision = m.generation
FROM matches AS m WHERE m.workspace_rowid = w.rowid AND m.priority = 1;

ALTER TABLE pi_sandbox_allocations ADD COLUMN source_authority_root_id TEXT;
ALTER TABLE pi_sandbox_allocations ADD COLUMN source_authority_generation INTEGER;
CREATE INDEX pi_sandbox_allocations_source_workspace ON pi_sandbox_allocations(
  tenant_id, owner_principal_id, execution_environment_id, source_workspace_id
);
UPDATE pi_sandbox_allocations AS a
SET (source_authority_root_id, source_authority_generation) = (
  SELECT w.authority_root_id, w.environment_configuration_revision FROM workspaces AS w
  WHERE w.tenant_id = a.tenant_id AND w.owner_principal_id = a.owner_principal_id
    AND w.environment_id = a.execution_environment_id AND w.id = a.source_workspace_id
    AND w.canonical_path = a.source_canonical_path AND w.authority_root_id IS NOT NULL
);
`,
};
