import type { DatabaseMigration } from "../migrate.js";
import { canonicalLocalRootPath, isWithinLocalWorkspaceRoot } from "../../execution/local-workspace-roots.js";
import { isWithinRemoteRoot } from "../../execution/remote-path.js";

export const workspaceFileRootGrantsMigration: DatabaseMigration = {
  version: 168,
  name: "workspace_file_root_grants",
  preflight(database) {
    database.function("sedes_canonical_file_root_168", (kind, path) =>
      typeof path !== "string" ? null : kind === "local" ? canonicalLocalRootPath(path) ?? null : path);
    database.function("sedes_file_path_within_168", { deterministic: true }, (kind, path, root) =>
      Number(typeof path === "string" && typeof root === "string" &&
        (kind === "local" ? isWithinLocalWorkspaceRoot(path, root) : isWithinRemoteRoot(path, root))));
  },
  sql: ["workspace_file_roots", "workspace_file_link_roots", "workspace_file_linked_worktree_roots"].map(table => `
ALTER TABLE ${table} ADD COLUMN authority_root_id TEXT;
ALTER TABLE ${table} ADD COLUMN authority_root_generation INTEGER;
WITH roots AS MATERIALIZED (
  SELECT p.tenant_id, p.owner_principal_id, p.environment_id, e.kind, json_extract(r.value, '$.id') AS id,
    json_extract(r.value, '$.generation') AS generation, sedes_canonical_file_root_168(e.kind, json_extract(r.value, '$.path')) AS path
  FROM live_execution_policies p JOIN execution_environments e
    ON e.tenant_id = p.tenant_id AND e.owner_principal_id = p.owner_principal_id AND e.id = p.environment_id
  CROSS JOIN json_each(p.snapshot_json, '$.roots') r
), matches AS (
  SELECT f.rowid AS file_rowid, r.id, r.generation, ROW_NUMBER() OVER (
    PARTITION BY f.rowid ORDER BY length(r.path) DESC, r.id) AS priority
  FROM ${table} f JOIN workspaces w ON w.tenant_id = f.tenant_id AND w.owner_principal_id = f.owner_principal_id AND w.id = f.workspace_id
  JOIN roots primary_root ON primary_root.tenant_id = w.tenant_id AND primary_root.owner_principal_id = w.owner_principal_id
    AND primary_root.environment_id = w.environment_id AND primary_root.id = w.authority_root_id
    AND primary_root.generation = w.environment_configuration_revision
  JOIN roots r ON r.tenant_id = w.tenant_id AND r.owner_principal_id = w.owner_principal_id AND r.environment_id = w.environment_id
  WHERE w.removed_at IS NULL AND w.availability = 'available'
    ${table === "workspace_file_link_roots" ? "" : "AND f.availability = 'available'"}
    AND sedes_file_path_within_168(primary_root.kind, w.canonical_path, primary_root.path)
    AND sedes_file_path_within_168(r.kind, f.canonical_path, r.path)
)
UPDATE ${table} AS f SET authority_root_id = m.id, authority_root_generation = m.generation
FROM matches m WHERE f.rowid = m.file_rowid AND m.priority = 1;`).join("\n"),
};
