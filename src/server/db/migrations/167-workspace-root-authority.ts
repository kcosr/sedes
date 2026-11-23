import type { DatabaseMigration } from "../migrate.js";
import { isWithinRemoteRoot } from "../../execution/remote-path.js";

export const workspaceRootAuthorityMigration: DatabaseMigration = {
  version: 167,
  name: "workspace_root_authority",
  preflight(database) {
    database.function("sedes_path_within_root_167", { deterministic: true }, (candidate, root) =>
      Number(typeof candidate === "string" && typeof root === "string" && isWithinRemoteRoot(candidate, root)));
  },
  sql: `
ALTER TABLE workspaces ADD COLUMN authority_root_id TEXT;
UPDATE workspaces AS w
SET (authority_root_id, environment_configuration_revision) = (
  SELECT json_extract(root.value, '$.id'), json_extract(root.value, '$.generation')
  FROM live_execution_policies AS p, json_each(p.snapshot_json, '$.roots') AS root
  WHERE p.tenant_id = w.tenant_id AND p.owner_principal_id = w.owner_principal_id
    AND p.environment_id = w.environment_id
    AND sedes_path_within_root_167(w.canonical_path, json_extract(root.value, '$.path'))
  ORDER BY length(json_extract(root.value, '$.path')) DESC, json_extract(root.value, '$.id') LIMIT 1
)
WHERE w.removed_at IS NULL AND EXISTS (
  SELECT 1 FROM execution_environments AS e JOIN live_execution_policies AS p
    ON p.tenant_id = e.tenant_id AND p.owner_principal_id = e.owner_principal_id AND p.environment_id = e.id,
    json_each(p.snapshot_json, '$.roots') AS root
  WHERE e.tenant_id = w.tenant_id AND e.owner_principal_id = w.owner_principal_id AND e.id = w.environment_id
    AND e.configuration_revision = w.environment_configuration_revision
    AND sedes_path_within_root_167(w.canonical_path, json_extract(root.value, '$.path'))
);

ALTER TABLE pi_sandbox_allocations ADD COLUMN source_authority_root_id TEXT;
ALTER TABLE pi_sandbox_allocations ADD COLUMN source_authority_generation INTEGER;
UPDATE pi_sandbox_allocations AS a
SET (source_authority_root_id, source_authority_generation) = (
  SELECT w.authority_root_id, w.environment_configuration_revision FROM workspaces AS w
  WHERE w.tenant_id = a.tenant_id AND w.owner_principal_id = a.owner_principal_id
    AND w.environment_id = a.execution_environment_id AND w.id = a.source_workspace_id
    AND w.canonical_path = a.source_canonical_path AND w.authority_root_id IS NOT NULL
);
`,
};
