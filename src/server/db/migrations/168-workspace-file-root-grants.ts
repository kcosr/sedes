import type { DatabaseMigration } from "../migrate.js";
import { canonicalLocalRootPath } from "../../execution/local-workspace-roots.js";
import { isWithinRemoteRoot } from "../../execution/remote-path.js";

export const workspaceFileRootGrantsMigration: DatabaseMigration = {
  version: 168,
  name: "workspace_file_root_grants",
  preflight(database) {
    database.function("sedes_canonical_file_root_168", { deterministic: true }, (kind, path) =>
      typeof path !== "string" ? null : kind === "local" ? canonicalLocalRootPath(path) ?? null : path);
    database.function("sedes_file_path_within_168", { deterministic: true }, (path, root) =>
      Number(typeof path === "string" && typeof root === "string" && isWithinRemoteRoot(path, root)));
  },
  sql: ["workspace_file_roots", "workspace_file_link_roots", "workspace_file_linked_worktree_roots"].map(table => `
ALTER TABLE ${table} ADD COLUMN authority_root_id TEXT;
ALTER TABLE ${table} ADD COLUMN authority_root_generation INTEGER;
UPDATE ${table} AS f SET (authority_root_id, authority_root_generation) = (
  SELECT json_extract(r.value, '$.id'), json_extract(r.value, '$.generation')
  FROM workspaces w JOIN execution_environments e ON e.tenant_id = w.tenant_id AND e.owner_principal_id = w.owner_principal_id AND e.id = w.environment_id
  JOIN live_execution_policies p ON p.tenant_id = w.tenant_id AND p.owner_principal_id = w.owner_principal_id AND p.environment_id = w.environment_id,
    json_each(p.snapshot_json, '$.roots') AS r
  WHERE w.tenant_id = f.tenant_id AND w.owner_principal_id = f.owner_principal_id AND w.id = f.workspace_id
    AND sedes_file_path_within_168(f.canonical_path, sedes_canonical_file_root_168(e.kind, json_extract(r.value, '$.path')))
  ORDER BY length(sedes_canonical_file_root_168(e.kind, json_extract(r.value, '$.path'))) DESC, json_extract(r.value, '$.id') LIMIT 1
);`).join("\n"),
};
