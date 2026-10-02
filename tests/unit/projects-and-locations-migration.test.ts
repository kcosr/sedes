import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { projectsAndLocationsMigration } from "../../src/server/db/migrations/126-projects-and-locations.js";
import { projectRemovalAdmissionError } from "../../src/server/db/project-removal-errors.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { insertPreProjectWorkspace, savedAgentDatabase } from "../support/saved-agent-fixture.js";

type Seeded = {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly other: RequestScope;
  readonly workspaces: Readonly<Record<string, string>>;
  readonly removedThreadId: string;
};

function addEnvironment(database: Database.Database, scope: RequestScope, label: string, kind: "local" | "ssh"): string {
  const id = randomUUID();
  database.prepare(`INSERT INTO execution_environments(
      tenant_id, owner_principal_id, id, kind, label, availability, diagnostic_code, revision,
      configuration_revision, configuration_fingerprint, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, availability, NULL, 0, configuration_revision,
      configuration_fingerprint, created_at, updated_at
    FROM execution_environments WHERE kind = 'local' LIMIT 1`)
    .run(scope.tenantId, scope.principalId, id, kind, label);
  return id;
}

function seed(): Seeded {
  const { database, scope } = savedAgentDatabase(125);
  const local = new InventoryRepository(database).getLocalEnvironment(scope).id;
  const remoteA = addEnvironment(database, scope, "Remote A", "ssh");
  const remoteB = addEnvironment(database, scope, "Remote B", "ssh");
  const other: RequestScope = { tenantId: scope.tenantId, principalId: randomUUID() };
  database.prepare("INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 0)")
    .run(other.tenantId, other.principalId);
  database.prepare("INSERT INTO principal_generations(tenant_id, principal_id) VALUES (?, ?)")
    .run(other.tenantId, other.principalId);
  const otherLocal = addEnvironment(database, other, "Other local", "local");

  let clock = 1_000;
  const workspaces: Record<string, string> = {};
  const add = (key: string, owner: RequestScope, environmentId: string, displayName: string, removedAt?: number) => {
    clock += 10;
    workspaces[key] = insertPreProjectWorkspace(database, owner, {
      environmentId, canonicalPath: `/srv/${key}`, displayName, available: true, trustState: "trusted",
      environmentConfigurationRevision: 0, now: clock,
    }).id;
    if (removedAt !== undefined) {
      database.prepare("UPDATE workspaces SET removed_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(removedAt, removedAt, owner.tenantId, workspaces[key]);
    }
  };
  // Same repository on several hosts joins; a removed copy joins only without a host conflict.
  add("sedesLocal", scope, local, "sedes");
  add("sedesRemote", scope, remoteA, "sedes");
  add("sedesOtherHostRemoved", scope, remoteB, "sedes", 5_000);
  add("sedesConflictRemoved", scope, remoteA, "sedes", 5_100);
  // Two active same-named worktrees on one host split the whole name group.
  add("dupFirst", scope, local, "dup");
  add("dupSecond", scope, local, "dup");
  add("dupRemoteRemoved", scope, remoteA, "dup", 5_200);
  // An all-removed group on distinct hosts forms one removed project.
  add("goneLocal", scope, local, "gone");
  add("goneRemote", scope, remoteA, "gone", 6_500);
  // An all-removed group with a repeated host splits.
  add("twiceFirst", scope, local, "twice", 7_000);
  add("twiceSecond", scope, local, "twice", 7_100);
  // Two removed copies on one host do not join the active project.
  add("pairActive", scope, local, "pair");
  add("pairRemovedFirst", scope, remoteA, "pair", 8_000);
  add("pairRemovedSecond", scope, remoteA, "pair", 8_100);
  // Equal names never group across principals.
  add("otherSedes", other, otherLocal, "sedes");

  const profile = database.prepare("SELECT id FROM agent_connection_profiles WHERE tenant_id = ? AND owner_principal_id = ? LIMIT 1")
    .get(scope.tenantId, scope.principalId) as { id: string };
  const bindings = new ConversationBindingRepository(database);
  bindings.createUnboundThread(scope, { workspaceId: workspaces.sedesLocal!, connectionProfileId: profile.id, title: "Kept", now: 2_000 });
  // Threads are admitted before removal; triggers fence later admissions.
  const removedThreadId = bindings.createUnboundThread(scope, {
    workspaceId: workspaces.goneLocal!, connectionProfileId: profile.id, title: "Removed", now: 2_100,
  }).id;
  bindings.bindDiscoveredConversation(scope, removedThreadId, { backendConversationId: "removed-native", now: 2_200 });
  database.prepare("UPDATE workspaces SET removed_at = 6000, updated_at = 6000 WHERE tenant_id = ? AND id = ?")
    .run(scope.tenantId, workspaces.goneLocal);
  return { database, scope, other, workspaces, removedThreadId };
}

type MigratedLocation = { id: string; projectId: string; removedAt: number | null; removedWithProject: number };
type MigratedProject = {
  ownerPrincipalId: string; id: string; name: string; revision: number; membershipRevision: number;
  removedAt: number | null; createdAt: number; updatedAt: number;
};

function migrated(seeded: Seeded) {
  applyDatabaseMigrations(seeded.database, backendNormalizedMigrations);
  const locations = new Map((seeded.database.prepare(`SELECT id, project_id AS projectId, removed_at AS removedAt,
      removed_with_project AS removedWithProject FROM workspaces`).all() as MigratedLocation[])
    .map((location) => [location.id, location]));
  const projects = new Map((seeded.database.prepare(`SELECT owner_principal_id AS ownerPrincipalId, id, name, revision,
      membership_revision AS membershipRevision, removed_at AS removedAt, created_at AS createdAt,
      updated_at AS updatedAt FROM projects`).all() as MigratedProject[])
    .map((project) => [project.id, project]));
  const location = (key: string) => locations.get(seeded.workspaces[key]!)!;
  const project = (key: string) => projects.get(location(key).projectId)!;
  return { locations, projects, location, project };
}

describe("projects and locations migration", () => {
  it("groups same-named workspaces per principal and host without reusing workspace IDs", () => {
    const seeded = seed();
    try {
      const { locations, projects, location, project } = migrated(seeded);
      const groups = [
        ["sedesLocal", "sedesRemote", "sedesOtherHostRemoved"],
        ["sedesConflictRemoved"],
        ["dupFirst"], ["dupSecond"], ["dupRemoteRemoved"],
        ["goneLocal", "goneRemote"],
        ["twiceFirst"], ["twiceSecond"],
        ["pairActive"], ["pairRemovedFirst"], ["pairRemovedSecond"],
        ["otherSedes"],
      ];
      expect(projects.size).toBe(groups.length);
      expect(locations.size).toBe(groups.flat().length);
      for (const group of groups) {
        expect(new Set(group.map((key) => location(key).projectId))).toHaveLength(1);
        const members = [...locations.values()].filter((candidate) => candidate.projectId === location(group[0]!).projectId);
        expect(members.map(({ id }) => id).sort()).toEqual(group.map((key) => seeded.workspaces[key]!).sort());
      }
      for (const id of projects.keys()) expect(locations.has(id)).toBe(false);
      expect(project("sedesLocal")).toMatchObject({
        ownerPrincipalId: seeded.scope.principalId, name: "sedes", revision: 0, membershipRevision: 0,
        removedAt: null, createdAt: 1_010, updatedAt: 5_000,
      });
      expect(project("otherSedes")).toMatchObject({ ownerPrincipalId: seeded.other.principalId, name: "sedes", removedAt: null });
      expect(project("dupFirst")).toMatchObject({ name: "dup", removedAt: null });
    } finally { seeded.database.close(); }
  });

  it("removes a project only when every location was removed and marks those locations", () => {
    const seeded = seed();
    try {
      const { location, project } = migrated(seeded);
      // A removed project takes its latest location removal time.
      expect(project("goneLocal")).toMatchObject({ name: "gone", removedAt: 6_500 });
      for (const key of ["goneLocal", "goneRemote"]) expect(location(key).removedWithProject).toBe(1);
      for (const key of ["sedesConflictRemoved", "dupRemoteRemoved", "twiceFirst", "twiceSecond", "pairRemovedFirst", "pairRemovedSecond"]) {
        expect(project(key).removedAt).toBe(location(key).removedAt);
        expect(location(key).removedWithProject).toBe(1);
      }
      // A removed location inside an active project was removed on its own.
      expect(location("sedesOtherHostRemoved")).toMatchObject({ removedAt: 5_000, removedWithProject: 0 });
      for (const key of ["sedesLocal", "sedesRemote", "dupFirst", "pairActive", "otherSedes"]) {
        expect(location(key)).toMatchObject({ removedAt: null, removedWithProject: 0 });
        expect(project(key).removedAt).toBeNull();
      }
    } finally { seeded.database.close(); }
  });

  it("preserves indexes, foreign keys, and the commit-time guards on other tables", () => {
    const seeded = seed();
    const { database, scope } = seeded;
    try {
      const objects = (sql: string) => database.prepare(`SELECT name, type, tbl_name AS tableName FROM sqlite_schema
        WHERE ${sql} AND sql IS NOT NULL ORDER BY type, name`).all() as Array<{ name: string; type: string; tableName: string }>;
      const workspaceObjects = () => objects("tbl_name = 'workspaces' AND type IN ('index', 'trigger')");
      const guards = () => objects("type = 'trigger' AND tbl_name <> 'workspaces' AND sql LIKE '%workspaces%'");
      const workspaceObjectsBefore = workspaceObjects();
      const guardsBefore = guards();
      expect(workspaceObjectsBefore.map(({ name }) => name)).toEqual(["workspaces_by_owner_and_id", "workspaces_principal_last_opened"]);
      expect(guardsBefore.map(({ name }) => name)).toContain("queued_inputs_project_admission");
      expect(guardsBefore.map(({ name }) => name)).toContain("application_threads_project_admission");
      const threadWorkspaceKeys = () => database.prepare(`SELECT "from", "to" FROM pragma_foreign_key_list('application_threads')
        WHERE "table" = 'workspaces' ORDER BY seq`).all();
      const threadWorkspaceKeysBefore = threadWorkspaceKeys();

      migrated(seeded);

      expect(workspaceObjects()).toEqual([
        { name: "workspaces_by_owner_and_id", type: "index", tableName: "workspaces" },
        { name: "workspaces_by_project", type: "index", tableName: "workspaces" },
        { name: "workspaces_principal_last_opened", type: "index", tableName: "workspaces" },
        { name: "workspaces_project_active_insert", type: "trigger", tableName: "workspaces" },
        { name: "workspaces_project_active_update", type: "trigger", tableName: "workspaces" },
      ]);
      expect(guards().filter(({ tableName }) => tableName !== "projects")).toEqual(guardsBefore);
      expect(threadWorkspaceKeys()).toEqual(threadWorkspaceKeysBefore);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.prepare("SELECT name FROM sqlite_temp_schema WHERE name = 'workspace_project_backfill'").all()).toEqual([]);
      expect(() => applyDatabaseMigrations(database, backendNormalizedMigrations)).not.toThrow();

      // The 099 and 101 guards still reject new work in a removed location.
      const profile = database.prepare("SELECT id FROM agent_connection_profiles WHERE tenant_id = ? AND owner_principal_id = ? LIMIT 1")
        .get(scope.tenantId, scope.principalId) as { id: string };
      expect(() => new ConversationBindingRepository(database).createUnboundThread(scope, {
        workspaceId: seeded.workspaces.goneLocal!, connectionProfileId: profile.id, title: "Hidden", now: 9_000,
      })).toThrow("The project was removed. Restore it before starting new work.");
      const inventory = new InventoryRepository(database);
      expect(() => new QueuedInputRepository(database).enqueue(scope, seeded.removedThreadId, {
        mutationId: randomUUID(), text: "Hidden", contextExcerpts: [], attachmentIds: [], taskReferences: [],
        source: {
          kind: "agent_control", initiatingAgentThreadId: seeded.removedThreadId,
          expectedThreadRevision: inventory.getThread(scope, seeded.removedThreadId).thread.revision,
        },
        now: 9_000,
      })).toThrow(/removed/);

      // The rebuilt table enforces its project reference.
      const local = inventory.getLocalEnvironment(scope).id;
      expect(() => database.prepare(`INSERT INTO workspaces(tenant_id, owner_principal_id, environment_id, id, project_id,
          canonical_path, display_name, availability, trust_state, last_opened_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '/srv/orphan', 'orphan', 'available', 'trusted', 1, 1, 1)`)
        .run(scope.tenantId, scope.principalId, local, randomUUID(), randomUUID())).toThrow(/FOREIGN KEY/);
    } finally { database.close(); }
  });

  it("enforces that an active location never belongs to a removed project", () => {
    const seeded = seed();
    const { database, scope } = seeded;
    try {
      const { location, project } = migrated(seeded);
      const rejected = (run: () => unknown, message: string) => {
        let error: unknown;
        try { run(); } catch (caught) { error = caught; }
        expect(error).toMatchObject({ code: "SQLITE_CONSTRAINT_TRIGGER", message });
        expect(projectRemovalAdmissionError(error)).toMatchObject({ code: "invalid_transition", message });
      };
      const removedProject = "The project was removed. Restore it before adding or restoring its locations.";
      const local = new InventoryRepository(database).getLocalEnvironment(scope).id;
      const insert = (removedAt: number | null) => database.prepare(`INSERT INTO workspaces(tenant_id, owner_principal_id,
          environment_id, id, project_id, canonical_path, display_name, availability, trust_state, last_opened_at,
          created_at, updated_at, removed_at, removed_with_project)
        VALUES (?, ?, ?, ?, ?, ?, 'gone', 'available', 'trusted', 1, 1, 1, ?, ?)`)
        .run(scope.tenantId, scope.principalId, local, randomUUID(), project("goneLocal").id,
          `/srv/${randomUUID()}`, removedAt, removedAt === null ? 0 : 1);
      rejected(() => insert(null), removedProject);
      expect(() => insert(9_000)).not.toThrow();
      rejected(() => database.prepare("UPDATE workspaces SET removed_at = NULL, removed_with_project = 0 WHERE tenant_id = ? AND id = ?")
        .run(scope.tenantId, location("goneRemote").id), removedProject);
      rejected(() => database.prepare("UPDATE workspaces SET project_id = ? WHERE tenant_id = ? AND id = ?")
        .run(project("goneLocal").id, scope.tenantId, location("pairActive").id), removedProject);
      rejected(() => database.prepare("UPDATE projects SET removed_at = 9000 WHERE tenant_id = ? AND id = ?")
        .run(scope.tenantId, project("sedesLocal").id),
      "The project still has active locations. Remove them before removing the project.");
      expect(() => database.prepare("UPDATE workspaces SET removed_at = NULL WHERE tenant_id = ? AND id = ?")
        .run(scope.tenantId, location("sedesOtherHostRemoved").id)).not.toThrow();
      expect(() => database.prepare("UPDATE workspaces SET removed_with_project = 1 WHERE tenant_id = ? AND id = ?")
        .run(scope.tenantId, location("sedesLocal").id)).toThrow(/CHECK/);
    } finally { database.close(); }
  });

  it("migrates an empty inventory and keeps its checksum independent of generated project IDs", () => {
    const { database } = savedAgentDatabase(125);
    try {
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(database.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({ count: 0 });
      expect(projectsAndLocationsMigration.sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
      expect(database.prepare("SELECT name FROM schema_migrations WHERE version = 126").get())
        .toEqual({ name: "projects_and_locations" });
    } finally { database.close(); }
  });
});
