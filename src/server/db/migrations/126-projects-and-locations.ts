import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DatabaseMigration } from "../migrate.js";

type BackfillWorkspace = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly environmentId: string;
  readonly id: string;
  readonly displayName: string;
  readonly removed: 0 | 1;
};

function hasRepeatedEnvironment(workspaces: readonly BackfillWorkspace[]): boolean {
  return new Set(workspaces.map(({ environmentId }) => environmentId)).size !== workspaces.length;
}

/**
 * Groups workspaces by principal and exact display name. Within a group the
 * active workspaces decide: at most one per environment forms one project,
 * otherwise each is its own. A removed workspace joins that project only when
 * its environment has no other workspace of that name; an all-removed group
 * applies the active rule to its removed workspaces. Anything else becomes its
 * own project, because a wrong join is harder to undo than a later merge.
 */
function projectGroups(workspaces: readonly BackfillWorkspace[]): BackfillWorkspace[][] {
  const byName = new Map<string, BackfillWorkspace[]>();
  for (const workspace of workspaces) {
    const key = JSON.stringify([workspace.tenantId, workspace.ownerPrincipalId, workspace.displayName]);
    const group = byName.get(key);
    if (group) group.push(workspace);
    else byName.set(key, [workspace]);
  }
  const groups: BackfillWorkspace[][] = [];
  for (const members of byName.values()) {
    const active = members.filter(({ removed }) => removed === 0);
    const shared = active.length > 0 ? active : members;
    if (hasRepeatedEnvironment(shared)) {
      groups.push(...members.map((workspace) => [workspace]));
      continue;
    }
    const project = [...shared];
    for (const workspace of members) {
      if (shared.includes(workspace)) continue;
      const sameEnvironment = members.filter(({ environmentId }) => environmentId === workspace.environmentId);
      if (sameEnvironment.length === 1) project.push(workspace);
      else groups.push([workspace]);
    }
    groups.push(project);
  }
  return groups;
}

// Project IDs are fresh random identities, so they cannot be part of the
// checksummed SQL. The checksummed SQL consumes and drops this mapping.
function assignWorkspaceProjects(database: Database.Database): void {
  const workspaces = database.prepare(`
    SELECT tenant_id AS tenantId, owner_principal_id AS ownerPrincipalId,
      environment_id AS environmentId, id, display_name AS displayName,
      removed_at IS NOT NULL AS removed
    FROM workspaces
    ORDER BY tenant_id, owner_principal_id, display_name, environment_id, id
  `).all() as BackfillWorkspace[];
  database.exec(`
    CREATE TEMP TABLE workspace_project_backfill (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id)
    ) STRICT;
  `);
  const insert = database.prepare(`
    INSERT INTO temp.workspace_project_backfill(
      tenant_id, owner_principal_id, workspace_id, project_id
    ) VALUES (?, ?, ?, ?)
  `);
  for (const group of projectGroups(workspaces)) {
    const projectId = randomUUID();
    for (const workspace of group) {
      insert.run(workspace.tenantId, workspace.ownerPrincipalId, workspace.id, projectId);
    }
  }
}

const removedProjectGuard = `EXISTS (SELECT 1 FROM projects AS project
    WHERE project.tenant_id = NEW.tenant_id AND project.owner_principal_id = NEW.owner_principal_id
      AND project.id = NEW.project_id AND project.removed_at IS NOT NULL)`;

/**
 * Introduces principal-owned projects. Every workspace becomes a location of
 * exactly one project; same-named workspaces on different environments are
 * grouped into one project.
 */
export const projectsAndLocationsMigration: DatabaseMigration = {
  version: 126,
  name: "projects_and_locations",
  // Triggers on other tables name workspaces; keep them bound across the rebuild.
  requiresForeignKeysDisabled: true,
  requiresLegacyAlterTable: true,
  verifyDatabaseIntegrity: true,
  preflight: assignWorkspaceProjects,
  sql: `
CREATE TABLE projects (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  membership_revision INTEGER NOT NULL DEFAULT 0 CHECK (membership_revision >= 0),
  removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_principal_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

-- A project is removed only when every one of its locations is removed.
INSERT INTO projects(
  tenant_id, owner_principal_id, id, name, revision, membership_revision,
  removed_at, created_at, updated_at
)
SELECT backfill.tenant_id, backfill.owner_principal_id, backfill.project_id,
  min(workspace.display_name), 0, 0,
  CASE WHEN count(workspace.removed_at) = count(*) THEN max(workspace.removed_at) END,
  min(workspace.created_at), max(workspace.updated_at)
FROM temp.workspace_project_backfill AS backfill
JOIN workspaces AS workspace
  ON workspace.tenant_id = backfill.tenant_id
  AND workspace.owner_principal_id = backfill.owner_principal_id
  AND workspace.id = backfill.workspace_id
GROUP BY backfill.tenant_id, backfill.owner_principal_id, backfill.project_id;

CREATE TABLE workspaces_v126 (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL CHECK (length(canonical_path) BETWEEN 1 AND 4096),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 240),
  availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
  trust_state TEXT NOT NULL CHECK (trust_state IN ('trusted', 'untrusted')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_opened_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  environment_configuration_revision INTEGER NOT NULL DEFAULT 0
    CHECK (environment_configuration_revision >= 0),
  removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= 0),
  -- Marks locations taken by their project's removal, so a project restore
  -- can offer exactly those locations again.
  removed_with_project INTEGER NOT NULL DEFAULT 0
    CHECK (removed_with_project IN (0, 1)),
  CHECK (removed_with_project = 0 OR removed_at IS NOT NULL),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, owner_principal_id, environment_id, id),
  UNIQUE (tenant_id, environment_id, canonical_path),
  FOREIGN KEY (tenant_id, owner_principal_id, environment_id)
    REFERENCES execution_environments(tenant_id, owner_principal_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, project_id)
    REFERENCES projects(tenant_id, owner_principal_id, id) ON DELETE RESTRICT
) STRICT;

-- An unmapped workspace yields a NULL project and aborts the migration.
INSERT INTO workspaces_v126(
  tenant_id, owner_principal_id, environment_id, id, project_id,
  canonical_path, display_name, availability, trust_state, revision,
  last_opened_at, created_at, updated_at, environment_configuration_revision,
  removed_at, removed_with_project
)
SELECT workspace.tenant_id, workspace.owner_principal_id, workspace.environment_id,
  workspace.id, backfill.project_id, workspace.canonical_path,
  workspace.display_name, workspace.availability, workspace.trust_state,
  workspace.revision, workspace.last_opened_at, workspace.created_at,
  workspace.updated_at, workspace.environment_configuration_revision,
  workspace.removed_at, project.removed_at IS NOT NULL
FROM workspaces AS workspace
LEFT JOIN temp.workspace_project_backfill AS backfill
  ON backfill.tenant_id = workspace.tenant_id
  AND backfill.owner_principal_id = workspace.owner_principal_id
  AND backfill.workspace_id = workspace.id
LEFT JOIN projects AS project
  ON project.tenant_id = backfill.tenant_id
  AND project.owner_principal_id = backfill.owner_principal_id
  AND project.id = backfill.project_id;

DROP TABLE temp.workspace_project_backfill;
DROP TABLE workspaces;
ALTER TABLE workspaces_v126 RENAME TO workspaces;

CREATE UNIQUE INDEX workspaces_by_owner_and_id
  ON workspaces(tenant_id, owner_principal_id, id);
CREATE INDEX workspaces_principal_last_opened
  ON workspaces(
    tenant_id, owner_principal_id, last_opened_at DESC, id
  );
CREATE INDEX workspaces_by_project
  ON workspaces(tenant_id, owner_principal_id, project_id);

-- An active location never belongs to a removed project.
CREATE TRIGGER workspaces_project_active_insert BEFORE INSERT ON workspaces
WHEN NEW.removed_at IS NULL AND ${removedProjectGuard}
BEGIN
  SELECT RAISE(ABORT, 'The project was removed. Restore it before adding or restoring its locations.');
END;
CREATE TRIGGER workspaces_project_active_update
BEFORE UPDATE OF removed_at, project_id ON workspaces
WHEN NEW.removed_at IS NULL AND ${removedProjectGuard}
BEGIN
  SELECT RAISE(ABORT, 'The project was removed. Restore it before adding or restoring its locations.');
END;
CREATE TRIGGER projects_active_locations_remove BEFORE UPDATE OF removed_at ON projects
WHEN NEW.removed_at IS NOT NULL AND EXISTS (SELECT 1 FROM workspaces AS workspace
  WHERE workspace.tenant_id = NEW.tenant_id AND workspace.owner_principal_id = NEW.owner_principal_id
    AND workspace.project_id = NEW.id AND workspace.removed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'The project still has active locations. Remove them before removing the project.');
END;
`,
};
