import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { projectRemovalAdmissionError } from "../../src/server/db/project-removal-errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

type Keyed = Record<string, string>;
type Row = Record<string, unknown>;
type SeededScope =
  | { readonly kind: "global" }
  | { readonly kind: "workspace"; readonly workspace: string }
  | { readonly kind: "thread"; readonly thread: string };

const ISO = "2026-09-01T10:00:00.000Z";
const addedMessage = "The project was removed. Restore it before adding saved work.";
const movedMessage = "The project was removed. Restore it before moving saved work into it.";

const sha256 = (parts: readonly unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

function migrate(database: Database.Database): void {
  applyDatabaseMigrations(database, backendNormalizedMigrations.filter(({ version }) => version <= 127));
}

function addEnvironment(database: Database.Database, owner: RequestScope, label: string, kind: "local" | "ssh"): string {
  const id = randomUUID();
  database.prepare(`INSERT INTO execution_environments(
      tenant_id, owner_principal_id, id, kind, label, availability, diagnostic_code, revision,
      configuration_revision, configuration_fingerprint, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, availability, NULL, 0, configuration_revision,
      configuration_fingerprint, created_at, updated_at
    FROM execution_environments WHERE kind = 'local' LIMIT 1`)
    .run(owner.tenantId, owner.principalId, id, kind, label);
  return id;
}

/** Seeds every shape migration 127 maps at schema 126, with foreign keys on. */
function seed() {
  const { database, scope } = savedAgentDatabase(126);
  database.pragma("foreign_keys = ON");
  const run = (sql: string, ...params: unknown[]) => database.prepare(sql).run(...params);
  const profile = database.prepare(`SELECT id, backend_instance_id AS backendInstanceId,
      execution_environment_id AS environmentId
    FROM agent_connection_profiles WHERE tenant_id = ? AND owner_principal_id = ? LIMIT 1`)
    .get(scope.tenantId, scope.principalId) as { id: string; backendInstanceId: string; environmentId: string };
  const local = profile.environmentId;
  const remote = addEnvironment(database, scope, "Remote", "ssh");
  const other: RequestScope = { tenantId: scope.tenantId, principalId: randomUUID() };
  run("INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 0)", other.tenantId, other.principalId);
  run("INSERT INTO principal_generations(tenant_id, principal_id) VALUES (?, ?)", other.tenantId, other.principalId);
  const otherLocal = addEnvironment(database, other, "Other local", "local");

  const projects: Keyed = {};
  for (const [key, owner] of [["alpha", scope], ["beta", scope], ["gone", scope], ["other", other]] as const) {
    projects[key] = randomUUID();
    run(`INSERT INTO projects(tenant_id, owner_principal_id, id, name, revision, membership_revision,
        removed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, NULL, 1, 1)`,
    owner.tenantId, owner.principalId, projects[key], key);
  }
  const workspaces: Keyed = {};
  const environmentOf: Keyed = {};
  const projectOf: Keyed = {};
  const addWorkspace = (key: string, owner: RequestScope, environmentId: string, project: string) => {
    const id = randomUUID();
    workspaces[key] = id;
    environmentOf[id] = environmentId;
    projectOf[id] = projects[project]!;
    run(`INSERT INTO workspaces(tenant_id, owner_principal_id, environment_id, id, project_id, canonical_path,
        display_name, availability, trust_state, last_opened_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'available', 'trusted', 1, 1, 1)`,
    owner.tenantId, owner.principalId, environmentId, id, projects[project], `/srv/${key}`, project);
  };
  // One project on two hosts, plus a retired location of the same project.
  addWorkspace("alphaLocal", scope, local, "alpha");
  addWorkspace("alphaRemote", scope, remote, "alpha");
  addWorkspace("alphaRetired", scope, local, "alpha");
  addWorkspace("betaLocal", scope, local, "beta");
  addWorkspace("goneLocal", scope, local, "gone");
  addWorkspace("otherWorkspace", other, otherLocal, "other");

  const threads: Keyed = {};
  const addThread = (key: string, workspace: string) => {
    threads[key] = randomUUID();
    run(`INSERT INTO application_threads(tenant_id, id, owner_principal_id, environment_id, workspace_id,
        backend_instance_id, connection_profile_id, backing_state, title, availability, last_activity_at,
        revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'unbound', ?, 'available', 1, 0, 1, 1)`,
    scope.tenantId, threads[key], scope.principalId, local, workspaces[workspace],
    profile.backendInstanceId, profile.id, key);
    run(`INSERT INTO thread_principal_state(tenant_id, principal_id, thread_id, inventory_state,
        state_changed_at, inventory_revision) VALUES (?, ?, ?, 'active', 1, 0)`,
    scope.tenantId, scope.principalId, threads[key]);
  };
  addThread("main", "alphaLocal");
  addThread("gone", "goneLocal");

  const tasks: Keyed = {};
  let clock = 1_000;
  const addTask = (key: string, owner: RequestScope, target: SeededScope) => {
    tasks[key] = randomUUID();
    clock += 10;
    const workspaceId = target.kind === "workspace" ? workspaces[target.workspace]! : null;
    run(`INSERT INTO tasks(tenant_id, owner_principal_id, id, scope_kind, environment_id, workspace_id,
        thread_id, title, details, pinned, files_json, completed_at, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    owner.tenantId, owner.principalId, tasks[key], target.kind,
    workspaceId === null ? null : environmentOf[workspaceId], workspaceId,
    target.kind === "thread" ? threads[target.thread] : null,
    `Task ${key}`, `Details for ${key}: "quoted" café`, key.length % 2,
    // Unusual spacing proves the stored bytes are copied verbatim.
    `[ "/srv/${key}/a.ts",  "/srv/${key}/b.ts" ]`,
    key.startsWith("alpha") ? clock + 5 : null, key.length, clock, clock + 7);
  };
  addTask("alphaLocal", scope, { kind: "workspace", workspace: "alphaLocal" });
  addTask("alphaRemote", scope, { kind: "workspace", workspace: "alphaRemote" });
  addTask("alphaRetired", scope, { kind: "workspace", workspace: "alphaRetired" });
  addTask("beta", scope, { kind: "workspace", workspace: "betaLocal" });
  addTask("gone", scope, { kind: "workspace", workspace: "goneLocal" });
  addTask("global", scope, { kind: "global" });
  addTask("thread", scope, { kind: "thread", thread: "main" });
  addTask("goneThread", scope, { kind: "thread", thread: "gone" });
  addTask("otherWorkspace", other, { kind: "workspace", workspace: "otherWorkspace" });
  addTask("otherGlobal", other, { kind: "global" });

  // A force reset promoted two tasks; RESTRICT keys must survive the rebuild.
  const resetMutationId = randomUUID();
  run(`INSERT INTO thread_force_reset_receipts(tenant_id, principal_id, thread_id, mutation_id,
      request_fingerprint, blocker_fingerprint, blocker_summary_json, reset_at)
    VALUES (?, ?, ?, ?, ?, ?, '[]', 3000)`,
  scope.tenantId, scope.principalId, threads.main, resetMutationId, "a".repeat(64), "b".repeat(64));
  for (const key of ["alphaLocal", "global"]) {
    run(`INSERT INTO thread_force_reset_promoted_tasks(tenant_id, principal_id, reset_mutation_id, task_id)
      VALUES (?, ?, ?, ?)`, scope.tenantId, scope.principalId, resetMutationId, tasks[key]);
  }

  const workpads: Keyed = {};
  const scopeJson = (target: SeededScope) => target.kind === "global" ? { kind: "global" }
    : target.kind === "workspace" ? { kind: "workspace", workspaceId: workspaces[target.workspace]! }
      : { kind: "thread", threadId: threads[target.thread]! };
  const addWorkpad = (key: string, owner: RequestScope, revisions: readonly SeededScope[]) => {
    const id = randomUUID();
    workpads[key] = id;
    const current = revisions.at(-1)!;
    const revision = revisions.length - 1;
    const document = {
      id, title: `Pad ${key}`, scope: scopeJson(current), content: `Notes for ${key} — "draft"`, revision,
      createdAt: ISO, updatedAt: ISO, archivedAt: null, author: { kind: "user" }, attribution: [],
    };
    run(`INSERT INTO workpads(tenant_id, owner_principal_id, id, scope_kind, workspace_id, thread_id, title,
        revision, archived_at, created_at, updated_at, document_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    owner.tenantId, owner.principalId, id, current.kind,
    current.kind === "workspace" ? workspaces[current.workspace] : null,
    current.kind === "thread" ? threads[current.thread] : null,
    document.title, revision, ISO, ISO, JSON.stringify(document));
    revisions.forEach((target, index) => run(`INSERT INTO workpad_revisions(tenant_id, owner_principal_id,
        workpad_id, revision, document_json) VALUES (?, ?, ?, ?, ?)`,
    owner.tenantId, owner.principalId, id, index, JSON.stringify({
      workpadId: id, revision: index, title: document.title, content: `Revision ${index}`, scope: scopeJson(target),
      archivedAt: null, author: { kind: "user" }, attribution: [], changes: [], createdAt: ISO,
    })));
    run(`INSERT INTO workpad_drafts(tenant_id, owner_principal_id, workpad_id, revision, base_revision,
        content, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)`,
    owner.tenantId, owner.principalId, id, revision, `Draft of ${key}`, ISO);
  };
  // Moved from global to beta to alpha: each revision keeps its own scope.
  addWorkpad("alpha", scope, [
    { kind: "global" }, { kind: "workspace", workspace: "betaLocal" }, { kind: "workspace", workspace: "alphaRemote" },
  ]);
  addWorkpad("gone", scope, [{ kind: "workspace", workspace: "goneLocal" }]);
  addWorkpad("global", scope, [{ kind: "global" }]);
  addWorkpad("thread", scope, [{ kind: "workspace", workspace: "alphaLocal" }, { kind: "thread", thread: "main" }]);
  addWorkpad("other", other, [{ kind: "workspace", workspace: "otherWorkspace" }]);

  // Task mutation receipts carry the committed TaskRecord.
  const receipts: Keyed = {};
  const records: Record<string, Row> = {};
  const addReceipt = (key: string, owner: RequestScope, operationKind: string, target: SeededScope, fingerprint?: string) => {
    const workspaceId = target.kind === "workspace" ? workspaces[target.workspace]! : null;
    const record = {
      tenantId: owner.tenantId, ownerPrincipalId: owner.principalId, id: randomUUID(), scopeKind: target.kind,
      environmentId: workspaceId === null ? null : environmentOf[workspaceId], workspaceId,
      threadId: target.kind === "thread" ? threads[target.thread]! : null,
      title: `Receipt ${key}`, details: `Receipt "${key}" café`, pinned: key.length % 2 === 0,
      files: [`/srv/${key}.md`], completedAt: null, revision: 2, createdAt: 1_500, updatedAt: 1_600,
    };
    const scopeParts = workspaceId !== null ? ["workspace", workspaceId]
      : record.threadId !== null ? ["thread", record.threadId] : ["global"];
    receipts[key] = randomUUID();
    records[key] = record;
    run(`INSERT INTO task_mutation_receipts(tenant_id, principal_id, mutation_id, operation_kind,
        request_fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, 1700)`,
    owner.tenantId, owner.principalId, receipts[key], operationKind,
    fingerprint ?? sha256(["create_task", record.title, record.details, record.pinned, record.files, ...scopeParts]),
    JSON.stringify({ version: 1, record }));
  };
  addReceipt("createWorkspace", scope, "create_task", { kind: "workspace", workspace: "alphaRemote" });
  addReceipt("createGlobal", scope, "create_task", { kind: "global" });
  addReceipt("createThread", scope, "create_task", { kind: "thread", thread: "main" });
  addReceipt("updateWorkspace", scope, "update_task", { kind: "workspace", workspace: "betaLocal" }, "1".repeat(64));
  addReceipt("moveWorkspace", scope, "move_task", { kind: "workspace", workspace: "alphaLocal" }, "2".repeat(64));
  addReceipt("updateGlobal", scope, "update_task", { kind: "global" }, "3".repeat(64));
  addReceipt("moveThread", scope, "move_task", { kind: "thread", thread: "main" }, "4".repeat(64));
  addReceipt("unrelated", scope, "delete_task", { kind: "workspace", workspace: "alphaLocal" }, "5".repeat(64));
  addReceipt("otherCreate", other, "create_task", { kind: "workspace", workspace: "otherWorkspace" });

  // Delivered task contexts are whole Task snapshots.
  const context = (key: string, scopeValue: Row) => ({
    id: tasks[key] ?? randomUUID(), scope: scopeValue, title: `Task ${key}`, details: `Context "${key}" café`,
    pinned: false, files: [], completedAt: null, revision: 1, createdAt: ISO, updatedAt: ISO,
  });
  const contextsBefore = [
    context("global", { kind: "global" }),
    context("alphaLocal", { kind: "workspace", workspaceId: workspaces.alphaLocal }),
    context("thread", { kind: "thread", threadId: threads.main }),
    context("beta", { kind: "workspace", workspaceId: workspaces.betaLocal }),
  ];
  const contextsJson = JSON.stringify(contextsBefore);
  const projectContextsJson = JSON.stringify(contextsBefore.map((item) => item.scope.kind === "workspace"
    ? { ...item, scope: { kind: "project", projectId: projectOf[item.scope.workspaceId as string] } } : item));
  const unscopedContextsJson = JSON.stringify([contextsBefore[0], contextsBefore[2]]);

  const queuedInputs: Keyed = {};
  const queuedStates: Record<string, Row> = {
    pendingFresh: { state: "pending" },
    pendingUnscoped: { state: "pending" },
    pendingRetried: { state: "pending", retry_count: 1 },
    pendingRequeued: { state: "pending", invalid_state_requeues: 1 },
    retryWait: { state: "retry_wait", retry_count: 1, next_attempt_at: 9_000 },
    dispatching: { state: "dispatching", dispatch_started_at: 5, reconciliation_token: "token", retry_anchor: "anchor", delivery_mode: "submit" },
    uncertain: { state: "uncertain", dispatch_started_at: 5, reconciliation_token: "token", retry_anchor: "anchor", delivery_mode: "steer" },
    accepted: { state: "accepted", dispatch_started_at: 5, accepted_at: 6, resolved_at: 6 },
    failed: { state: "failed", resolved_at: 6, diagnostic: "The input failed." },
    cancelled: { state: "cancelled", resolved_at: 6 },
  };
  Object.entries(queuedStates).forEach(([key, values], index) => {
    queuedInputs[key] = randomUUID();
    const row: Row = {
      tenant_id: scope.tenantId, owner_principal_id: scope.principalId, id: queuedInputs[key],
      application_thread_id: threads.main, sequence: index + 1, mutation_id: randomUUID(), text: `Input ${key}`,
      created_at: 4, task_contexts_json: key === "pendingUnscoped" ? unscopedContextsJson : contextsJson, ...values,
    };
    run(`INSERT INTO queued_inputs(${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`,
      ...Object.values(row));
  });

  const attempts: Keyed = {};
  const identified = { external_call_started_at: 2, provisional_backend_conversation_id: "native", provisional_opaque_binding_detail: "{}" };
  const attemptPhases: Record<string, Row> = {
    prepared: { phase: "prepared" },
    external_call_started: { phase: "external_call_started", external_call_started_at: 2 },
    conversation_identified: { phase: "conversation_identified", ...identified },
    first_submission_started: { phase: "first_submission_started", ...identified, retry_anchor: "anchor" },
    accepted_unpersisted: { phase: "accepted_unpersisted", ...identified, accepted_at: 3 },
    bound: { phase: "bound", ...identified, accepted_at: 3, reconciled_at: 4 },
    aborted_unpersisted: { phase: "aborted_unpersisted" },
    recovery_required: { phase: "recovery_required", external_call_started_at: 2 },
    forceReset: { phase: "conversation_identified", ...identified, force_reset_at: 5, force_reset_mutation_id: randomUUID() },
  };
  for (const [key, values] of Object.entries(attemptPhases)) {
    addThread(`attempt-${key}`, "betaLocal");
    attempts[key] = randomUUID();
    const row: Row = {
      tenant_id: scope.tenantId, owner_principal_id: scope.principalId, application_thread_id: threads[`attempt-${key}`],
      attempt_id: attempts[key], mutation_id: randomUUID(), backend_instance_id: profile.backendInstanceId,
      connection_profile_id: profile.id, execution_environment_id: local, creation_kind: "first_input",
      source_kind: "composer", initial_input_text: `Start ${key}`, consumed_draft_revision: 1,
      backend_creation_correlation: `correlation-${key}`, prepared_at: 1, initial_task_contexts_json: contextsJson, ...values,
    };
    run(`INSERT INTO conversation_creation_attempts(${Object.keys(row).join(", ")})
      VALUES (${Object.keys(row).map(() => "?").join(", ")})`, ...Object.values(row));
  }

  // Accepted deliveries and unrelated inventory receipts stay as they were.
  run(`INSERT INTO mutation_receipts(tenant_id, principal_id, thread_id, mutation_id, operation_kind,
      request_fingerprint, result_code, result_json, replayable, created_at, task_contexts_json)
    VALUES (?, ?, ?, ?, 'submit_input', ?, 'accepted', '{}', 1, 10, ?)`,
  scope.tenantId, scope.principalId, threads.main, randomUUID(), "c".repeat(64), contextsJson);
  run(`INSERT INTO mutation_receipts(tenant_id, principal_id, thread_id, mutation_id, operation_kind,
      request_fingerprint, result_code, result_json, replayable, created_at)
    VALUES (?, ?, ?, ?, 'archive_thread', ?, 'archived', ?, 1, 11)`,
  scope.tenantId, scope.principalId, threads.main, randomUUID(), "d".repeat(64),
  JSON.stringify({ openTaskDisposition: "move_to_workspace", workspaceId: workspaces.alphaLocal }));
  run(`INSERT INTO delivery_input_snapshots(tenant_id, owner_principal_id, application_thread_id,
      application_operation_id, original_text, selected_skill_id, context_excerpts_json, task_contexts_json,
      attachments_json, fingerprint, created_at)
    VALUES (?, ?, ?, ?, 'Delivered', NULL, '[]', ?, '[]', ?, 12)`,
  scope.tenantId, scope.principalId, threads.main, randomUUID(), contextsJson, "e".repeat(64));

  // Remove a location of an active project, and a whole project, after
  // their saved work was admitted.
  run("UPDATE workspaces SET removed_at = 5000 WHERE tenant_id = ? AND id = ?", scope.tenantId, workspaces.alphaRetired);
  run("UPDATE workspaces SET removed_at = 6000, removed_with_project = 1 WHERE tenant_id = ? AND id = ?",
    scope.tenantId, workspaces.goneLocal);
  run("UPDATE projects SET removed_at = 6000 WHERE tenant_id = ? AND id = ?", scope.tenantId, projects.gone);

  return {
    database, scope, other, projects, workspaces, projectOf, threads, tasks, workpads, receipts, records,
    queuedInputs, attempts, contextsJson, projectContextsJson, unscopedContextsJson,
  };
}

type Seeded = ReturnType<typeof seed>;

function rows(database: Database.Database, sql: string, ...params: unknown[]): Row[] {
  return database.prepare(sql).all(...params) as Row[];
}

function rejected(run: () => unknown, message: string): void {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: "SQLITE_CONSTRAINT_TRIGGER", message });
  expect(projectRemovalAdmissionError(error)).toMatchObject({
    code: "invalid_transition",
    message: message === addedMessage
      ? "This project or location was removed. Restore it before adding saved work."
      : "This project or location was removed. Restore it before moving saved work into it.",
  });
}

describe("shared project tasks migration", () => {
  it("maps workspace tasks to their project and preserves every other column", () => {
    const seeded = seed();
    const { database, projectOf } = seeded;
    try {
      const before = rows(database, "SELECT * FROM tasks ORDER BY owner_principal_id, id");
      migrate(database);
      const columns = rows(database, "SELECT name FROM pragma_table_info('tasks') ORDER BY cid").map(({ name }) => name);
      expect(columns).toEqual([
        "tenant_id", "owner_principal_id", "id", "scope_kind", "project_id", "thread_id", "title", "details",
        "pinned", "files_json", "completed_at", "revision", "created_at", "updated_at",
      ]);
      const after = rows(database, "SELECT * FROM tasks ORDER BY owner_principal_id, id");
      expect(after).toEqual(before.map(({ environment_id: _environment, workspace_id: workspaceId, ...task }) => ({
        ...task,
        scope_kind: task.scope_kind === "workspace" ? "project" : task.scope_kind,
        project_id: workspaceId === null ? null : projectOf[workspaceId as string],
      })));

      const projectOfTask = (key: string) => (database.prepare("SELECT project_id AS projectId FROM tasks WHERE id = ?")
        .get(seeded.tasks[key]) as { projectId: string | null }).projectId;
      // Both hosts and the retired location share their one project.
      for (const key of ["alphaLocal", "alphaRemote", "alphaRetired"]) expect(projectOfTask(key)).toBe(seeded.projects.alpha);
      expect(projectOfTask("beta")).toBe(seeded.projects.beta);
      expect(projectOfTask("gone")).toBe(seeded.projects.gone);
      expect(projectOfTask("otherWorkspace")).toBe(seeded.projects.other);
      expect(database.prepare("SELECT owner_principal_id AS owner FROM tasks WHERE project_id = ?").all(seeded.projects.other))
        .toEqual([{ owner: seeded.other.principalId }]);
      for (const key of ["global", "thread", "goneThread", "otherGlobal"]) expect(projectOfTask(key)).toBeNull();
      expect(database.prepare("SELECT files_json AS files FROM tasks WHERE id = ?").get(seeded.tasks.beta))
        .toEqual({ files: '[ "/srv/beta/a.ts",  "/srv/beta/b.ts" ]' });
    } finally { database.close(); }
  });

  it("keeps force-reset promotions bound while the runner disables foreign keys itself", () => {
    const { database, tasks } = seed();
    try {
      const promoted = rows(database, "SELECT * FROM thread_force_reset_promoted_tasks ORDER BY task_id");
      expect(promoted).toHaveLength(2);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      migrate(database);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(rows(database, "SELECT * FROM thread_force_reset_promoted_tasks ORDER BY task_id")).toEqual(promoted);
      expect(rows(database, `SELECT task.scope_kind AS scopeKind FROM thread_force_reset_promoted_tasks AS promoted
          JOIN tasks AS task ON task.tenant_id = promoted.tenant_id AND task.owner_principal_id = promoted.principal_id
            AND task.id = promoted.task_id ORDER BY task.scope_kind`)).toEqual([{ scopeKind: "global" }, { scopeKind: "project" }]);
      expect(() => database.prepare("DELETE FROM tasks WHERE id = ?").run(tasks.alphaLocal)).toThrow(/FOREIGN KEY/);
    } finally { database.close(); }
  });

  it("rewrites workpad and revision scopes without cascading into revisions or drafts", () => {
    const seeded = seed();
    const { database, workpads, projects } = seeded;
    try {
      const pad = (key: string) => database.prepare("SELECT * FROM workpads WHERE id = ?").get(workpads[key]) as Row;
      const revisionDocuments = (key: string) => rows(database,
        "SELECT document_json AS document FROM workpad_revisions WHERE workpad_id = ? ORDER BY revision", workpads[key])
        .map(({ document }) => document as string);
      const before = Object.fromEntries(Object.keys(workpads).map((key) => [key, pad(key)]));
      const revisionsBefore = Object.fromEntries(Object.keys(workpads).map((key) => [key, revisionDocuments(key)]));
      const drafts = rows(database, "SELECT * FROM workpad_drafts ORDER BY workpad_id");
      const revisionCount = database.prepare("SELECT count(*) AS count FROM workpad_revisions").get();
      expect(drafts).toHaveLength(5);

      migrate(database);

      expect(rows(database, "SELECT * FROM workpad_drafts ORDER BY workpad_id")).toEqual(drafts);
      expect(database.prepare("SELECT count(*) AS count FROM workpad_revisions").get()).toEqual(revisionCount);
      const asProject = (json: string, projectId: string) =>
        JSON.stringify({ ...JSON.parse(json) as Row, scope: { kind: "project", projectId } });
      const { workspace_id: _workspace, ...alphaBefore } = before.alpha!;
      expect(pad("alpha")).toEqual({
        ...alphaBefore, scope_kind: "project", project_id: projects.alpha,
        document_json: asProject(alphaBefore.document_json as string, projects.alpha!),
      });
      // Pin the exact serialized key order the application writes.
      expect(pad("alpha").document_json).toBe(`{"id":"${workpads.alpha}","title":"Pad alpha","scope":{"kind":"project",`
        + `"projectId":"${projects.alpha}"},"content":"Notes for alpha — \\"draft\\"","revision":2,"createdAt":"${ISO}",`
        + `"updatedAt":"${ISO}","archivedAt":null,"author":{"kind":"user"},"attribution":[]}`);
      expect(revisionDocuments("alpha")).toEqual([
        revisionsBefore.alpha![0],
        asProject(revisionsBefore.alpha![1]!, projects.beta!),
        asProject(revisionsBefore.alpha![2]!, projects.alpha!),
      ]);
      expect(pad("gone")).toMatchObject({ scope_kind: "project", project_id: projects.gone });
      expect(revisionDocuments("gone")).toEqual([asProject(revisionsBefore.gone![0]!, projects.gone!)]);
      expect(pad("other")).toMatchObject({ owner_principal_id: seeded.other.principalId, project_id: projects.other });
      expect(revisionDocuments("other")).toEqual([asProject(revisionsBefore.other![0]!, projects.other!)]);
      for (const key of ["global", "thread"]) {
        const { workspace_id: _unused, ...unchanged } = before[key]!;
        expect(pad(key)).toEqual({ ...unchanged, project_id: null });
      }
      expect(revisionsBefore.global).toEqual(revisionDocuments("global"));
      // A thread workpad's older workspace revision still maps to its project.
      expect(revisionDocuments("thread")).toEqual([
        asProject(revisionsBefore.thread![0]!, projects.alpha!), revisionsBefore.thread![1],
      ]);
    } finally { database.close(); }
  });

  it("rewrites task receipts and re-fingerprints only workspace create receipts", () => {
    const seeded = seed();
    const { database, receipts, records, projects } = seeded;
    try {
      const receipt = (key: string) => database.prepare(`SELECT operation_kind AS operationKind,
          request_fingerprint AS fingerprint, result_json AS result FROM task_mutation_receipts WHERE mutation_id = ?`)
        .get(receipts[key]) as { operationKind: string; fingerprint: string; result: string };
      const before = Object.fromEntries(Object.keys(receipts).map((key) => [key, receipt(key)]));

      migrate(database);

      const expectedRecord = (key: string, projectId: string | null) => {
        const { environmentId: _environment, workspaceId: _workspace, ...record } = records[key]!;
        return {
          ...record, scopeKind: projectId === null ? record.scopeKind : "project", projectId,
        } as unknown as Row & { title: string; details: string; pinned: boolean; files: string[] };
      };
      const projectFor: Record<string, string | null> = {
        createWorkspace: projects.alpha!, updateWorkspace: projects.beta!, moveWorkspace: projects.alpha!,
        otherCreate: projects.other!, createGlobal: null, createThread: null, updateGlobal: null, moveThread: null,
      };
      for (const [key, projectId] of Object.entries(projectFor)) {
        expect(receipt(key).result).toBe(JSON.stringify({ version: 1, record: expectedRecord(key, projectId) }));
      }
      for (const key of ["createWorkspace", "otherCreate"]) {
        const record = expectedRecord(key, projectFor[key]!);
        expect(receipt(key).fingerprint).toBe(sha256([
          "create_task", record.title, record.details, record.pinned, record.files, "project", projectFor[key],
        ]));
        expect(receipt(key).fingerprint).not.toBe(before[key]!.fingerprint);
      }
      for (const key of ["createGlobal", "createThread", "updateWorkspace", "moveWorkspace", "updateGlobal", "moveThread"]) {
        expect(receipt(key).fingerprint).toBe(before[key]!.fingerprint);
      }
      expect(receipt("unrelated")).toEqual(before.unrelated);
    } finally { database.close(); }
  });

  it("rewrites stored task contexts only where no provider has received them", () => {
    const seeded = seed();
    const { database, queuedInputs, attempts, contextsJson, projectContextsJson, unscopedContextsJson } = seeded;
    try {
      const receiptsBefore = rows(database, "SELECT * FROM mutation_receipts ORDER BY mutation_id");
      const snapshotsBefore = rows(database, "SELECT * FROM delivery_input_snapshots");
      expect(receiptsBefore.some(({ result_json: result }) => String(result).includes("move_to_workspace"))).toBe(true);
      migrate(database);

      const queued = (key: string) => (database.prepare("SELECT task_contexts_json AS contexts FROM queued_inputs WHERE id = ?")
        .get(queuedInputs[key]) as { contexts: string }).contexts;
      expect(queued("pendingFresh")).toBe(projectContextsJson);
      expect(queued("pendingUnscoped")).toBe(unscopedContextsJson);
      for (const key of ["pendingRetried", "pendingRequeued", "retryWait", "dispatching", "uncertain", "accepted", "failed", "cancelled"]) {
        expect(queued(key), key).toBe(contextsJson);
      }

      const attempt = (key: string) => (database.prepare(`SELECT initial_task_contexts_json AS contexts
          FROM conversation_creation_attempts WHERE attempt_id = ?`).get(attempts[key]) as { contexts: string }).contexts;
      for (const key of ["prepared", "external_call_started", "conversation_identified"]) {
        expect(attempt(key), key).toBe(projectContextsJson);
      }
      for (const key of ["first_submission_started", "accepted_unpersisted", "bound", "aborted_unpersisted", "recovery_required", "forceReset"]) {
        expect(attempt(key), key).toBe(contextsJson);
      }

      expect(rows(database, "SELECT * FROM mutation_receipts ORDER BY mutation_id")).toEqual(receiptsBefore);
      expect(rows(database, "SELECT * FROM delivery_input_snapshots")).toEqual(snapshotsBefore);
    } finally { database.close(); }
  });

  it("replaces the workspace guards and indexes with project-scoped ones", () => {
    const seeded = seed();
    const { database, scope, projects, threads, tasks, workpads } = seeded;
    try {
      migrate(database);
      expect(database.prepare("SELECT name FROM schema_migrations WHERE version = 127").get())
        .toEqual({ name: "shared_project_tasks" });
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(rows(database, `SELECT type, name, tbl_name AS tableName FROM sqlite_schema
          WHERE tbl_name IN ('tasks', 'workpads') AND type IN ('index', 'trigger') AND sql IS NOT NULL
          ORDER BY tbl_name, type, name`)).toEqual([
        { type: "index", name: "tasks_by_project", tableName: "tasks" },
        { type: "index", name: "tasks_by_thread", tableName: "tasks" },
        { type: "trigger", name: "tasks_project_create", tableName: "tasks" },
        { type: "trigger", name: "tasks_project_move", tableName: "tasks" },
        { type: "index", name: "workpads_scope", tableName: "workpads" },
        { type: "trigger", name: "workpads_project_create", tableName: "workpads" },
        { type: "trigger", name: "workpads_project_move", tableName: "workpads" },
      ]);
      expect(rows(database, "SELECT name FROM sqlite_schema WHERE name LIKE '%_v127' OR name = 'tasks_by_workspace'")).toEqual([]);
      expect(rows(database, "SELECT name FROM pragma_index_info('workpads_scope') ORDER BY seqno").map(({ name }) => name))
        .toEqual(["tenant_id", "owner_principal_id", "scope_kind", "project_id", "thread_id", "archived_at", "updated_at", "id"]);

      const insertTask = (scopeKind: string, projectId: string | null, threadId: string | null) => database.prepare(`
          INSERT INTO tasks(tenant_id, owner_principal_id, id, scope_kind, project_id, thread_id, title,
            created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'New', 9000, 9000)`)
        .run(scope.tenantId, scope.principalId, randomUUID(), scopeKind, projectId, threadId);
      rejected(() => insertTask("project", projects.gone!, null), addedMessage);
      rejected(() => insertTask("thread", null, threads.gone!), addedMessage);
      expect(() => insertTask("project", projects.alpha!, null)).not.toThrow();
      expect(() => insertTask("thread", null, threads.main!)).not.toThrow();
      expect(() => insertTask("project", randomUUID(), null)).toThrow(/FOREIGN KEY/);
      expect(() => insertTask("project", null, null)).toThrow(/CHECK/);
      const moveTask = (id: string, scopeKind: string, projectId: string | null, threadId: string | null) =>
        database.prepare("UPDATE tasks SET scope_kind = ?, project_id = ?, thread_id = ? WHERE id = ?")
          .run(scopeKind, projectId, threadId, id);
      rejected(() => moveTask(tasks.beta!, "project", projects.gone!, null), movedMessage);
      rejected(() => moveTask(tasks.global!, "thread", null, threads.gone!), movedMessage);
      expect(() => moveTask(tasks.beta!, "project", projects.alpha!, null)).not.toThrow();
      // Work already in a removed project stays editable in place.
      expect(() => database.prepare("UPDATE tasks SET title = 'Renamed' WHERE id = ?").run(tasks.gone)).not.toThrow();

      const insertWorkpad = (scopeKind: string, projectId: string | null) => database.prepare(`
          INSERT INTO workpads(tenant_id, owner_principal_id, id, scope_kind, project_id, thread_id, title,
            revision, archived_at, created_at, updated_at, document_json)
          VALUES (?, ?, ?, ?, ?, NULL, 'New', 0, NULL, ?, ?, '{}')`)
        .run(scope.tenantId, scope.principalId, randomUUID(), scopeKind, projectId, ISO, ISO);
      rejected(() => insertWorkpad("project", projects.gone!), addedMessage);
      expect(() => insertWorkpad("project", projects.alpha!)).not.toThrow();
      expect(() => insertWorkpad("project", randomUUID())).toThrow(/FOREIGN KEY/);
      rejected(() => database.prepare("UPDATE workpads SET scope_kind = 'project', project_id = ? WHERE id = ?")
        .run(projects.gone, workpads.global), movedMessage);
      rejected(() => database.prepare("UPDATE workpads SET scope_kind = 'thread', project_id = NULL, thread_id = ? WHERE id = ?")
        .run(threads.gone, workpads.alpha), movedMessage);
    } finally { database.close(); }
  });

  it.each([
    ["a task receipt", (seeded: Seeded) => seeded.database.prepare(`INSERT INTO task_mutation_receipts(tenant_id, principal_id,
        mutation_id, operation_kind, request_fingerprint, result_json, created_at) VALUES (?, ?, ?, 'move_task', ?, ?, 1)`)
      .run(seeded.scope.tenantId, seeded.scope.principalId, randomUUID(), "f".repeat(64),
        JSON.stringify({ version: 1, record: { scopeKind: "workspace", workspaceId: randomUUID() } }))],
    ["a workpad revision", (seeded: Seeded) => seeded.database.prepare(`INSERT INTO workpad_revisions(tenant_id,
        owner_principal_id, workpad_id, revision, document_json) VALUES (?, ?, ?, 9, ?)`)
      .run(seeded.scope.tenantId, seeded.scope.principalId, seeded.workpads.global,
        JSON.stringify({ scope: { kind: "workspace", workspaceId: randomUUID() } }))],
    ["a fresh queued input", (seeded: Seeded) => seeded.database.prepare(
      "UPDATE queued_inputs SET task_contexts_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: randomUUID(), scope: { kind: "workspace", workspaceId: randomUUID() } }]),
        seeded.queuedInputs.pendingUnscoped)],
    ["a prepared creation attempt", (seeded: Seeded) => seeded.database.prepare(
      "UPDATE conversation_creation_attempts SET initial_task_contexts_json = ? WHERE attempt_id = ?")
      .run(JSON.stringify([{ id: randomUUID(), scope: { kind: "workspace", workspaceId: randomUUID() } }]),
        seeded.attempts.prepared)],
  ])("fails closed when %s names a missing location", (_label, corrupt) => {
    const seeded = seed();
    const { database } = seeded;
    try {
      corrupt(seeded);
      expect(() => migrate(database)).toThrow("Database migration 127 found saved work whose location no longer exists.");
      expect(database.prepare("SELECT max(version) AS version FROM schema_migrations").get()).toEqual({ version: 126 });
      expect(rows(database, "SELECT name FROM pragma_table_info('tasks') WHERE name = 'workspace_id'")).toHaveLength(1);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { database.close(); }
  });

  it("leaves a missing location in an already delivered context untouched", () => {
    const seeded = seed();
    const { database, queuedInputs } = seeded;
    try {
      const orphaned = JSON.stringify([{ id: randomUUID(), scope: { kind: "workspace", workspaceId: randomUUID() } }]);
      database.prepare("UPDATE queued_inputs SET task_contexts_json = ? WHERE id = ?").run(orphaned, queuedInputs.accepted);
      migrate(database);
      expect(database.prepare("SELECT task_contexts_json AS contexts FROM queued_inputs WHERE id = ?").get(queuedInputs.accepted))
        .toEqual({ contexts: orphaned });
    } finally { database.close(); }
  });
});
