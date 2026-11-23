import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { workspaceRootAuthorityMigration } from "../../src/server/db/migrations/167-workspace-root-authority.js";

it("binds only previously current workspaces to their deepest scoped grant and preserves unproven rows", () => {
  const database = new Database(":memory:");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sedes-root-migration-")));
  const localRoot = join(directory, "real");
  const alias = join(directory, "long-root-alias");
  const innerAlias = join(directory, "b");
  mkdirSync(join(localRoot, "inner", "repo"), {recursive: true});
  symlinkSync(localRoot, alias);
  symlinkSync(join(localRoot, "inner"), innerAlias);
  try {
    database.exec(`
      CREATE TABLE workspaces(id TEXT PRIMARY KEY, tenant_id TEXT, owner_principal_id TEXT, environment_id TEXT,
        canonical_path TEXT, environment_configuration_revision INTEGER NOT NULL, removed_at INTEGER);
      CREATE TABLE pi_sandbox_allocations(tenant_id TEXT, owner_principal_id TEXT, execution_environment_id TEXT, source_workspace_id TEXT, source_canonical_path TEXT);
      CREATE TABLE execution_environments(tenant_id TEXT, owner_principal_id TEXT, id TEXT, configuration_revision INTEGER, kind TEXT);
      CREATE TABLE live_execution_policies(tenant_id TEXT, owner_principal_id TEXT, environment_id TEXT, snapshot_json TEXT);
      INSERT INTO execution_environments VALUES ('t','owner','host',7,'ssh'), ('t','owner','local',3,'local');
      INSERT INTO workspaces VALUES
        ('current','t','owner','host','/srv/group/repo',7,NULL),
        ('stale','t','owner','host','/srv/group/repo2',6,NULL),
        ('removed','t','owner','host','/srv/group/gone',7,1),
        ('outside','t','owner','host','/srv2/repo',7,NULL),
        ('other','t','another-owner','host','/srv/group/repo',7,NULL);
    `);
    database.prepare("INSERT INTO live_execution_policies VALUES ('t','owner','host',?)").run(JSON.stringify({roots: [
      { id: "outer", path: "/srv", generation: 10 }, { id: "inner", path: "/srv/group", generation: 11 },
    ]}));
    database.prepare("INSERT INTO live_execution_policies VALUES ('t','owner','local',?)").run(JSON.stringify({roots: [
      { id: "outer-link", path: alias, generation: 20 }, { id: "inner-link", path: innerAlias, generation: 21 },
      { id: "missing", path: join(directory, "removed"), generation: 22 },
    ]}));
    const workspace = database.prepare("INSERT INTO workspaces VALUES (?, 't','owner','local', ?,3,NULL)");
    workspace.run("linked", join(localRoot, "inner", "repo"));
    workspace.run("unresolved", join(directory, "removed", "repo"));
    database.prepare("INSERT INTO pi_sandbox_allocations VALUES ('t','owner','local','linked',?)").run(join(localRoot, "inner", "repo"));
    workspaceRootAuthorityMigration.preflight!(database);
    database.exec(workspaceRootAuthorityMigration.sql);
    const rows = database.prepare("SELECT id, authority_root_id, environment_configuration_revision FROM workspaces ORDER BY id").raw().all();
    expect(rows).toEqual([
      ["current", "inner", 11], ["linked", "inner-link", 21], ["other", null, 7], ["outside", null, 7], ["removed", null, 7], ["stale", null, 6], ["unresolved", null, 3],
    ]);
    expect(database.prepare("SELECT source_authority_root_id, source_authority_generation FROM pi_sandbox_allocations").raw().get())
      .toEqual(["inner-link", 21]);
  } finally {
    database.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
