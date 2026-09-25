import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";

const tenantId = "tenant-1";
const principalId = "principal-1";
const environmentId = "environment-1";
const otherEnvironmentId = "environment-2";
const workspaceId = "workspace-1";
const threadId = "019196f7-a0a8-7bc4-a89b-8cf013978405";

describe("DatabaseAgentToolSourceAuthority", () => {
  let database: Database.Database;
  let authority: DatabaseAgentToolSourceAuthority;

  beforeEach(() => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE execution_environments (
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        id TEXT NOT NULL,
        label TEXT NOT NULL
      ) STRICT;
      CREATE TABLE workspaces (
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        removed_at INTEGER
      ) STRICT;
      CREATE TABLE agent_backend_instances (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL
      ) STRICT;
      CREATE TABLE application_threads (
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        backend_instance_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL
      ) STRICT;
      CREATE TABLE thread_principal_state (
        tenant_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        inventory_state TEXT NOT NULL
      ) STRICT;
      CREATE TABLE thread_lineage_closure (
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        ancestor_thread_id TEXT NOT NULL,
        descendant_thread_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE saved_agents (
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        name TEXT NOT NULL
      ) STRICT;
      CREATE TABLE tasks (
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        environment_id TEXT,
        workspace_id TEXT,
        thread_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL
      ) STRICT;
      INSERT INTO execution_environments(
        tenant_id, owner_principal_id, id, label
      ) VALUES ('${tenantId}', '${principalId}', '${environmentId}', 'Local');
      INSERT INTO workspaces(
        tenant_id, owner_principal_id, environment_id, id, display_name
      ) VALUES ('${tenantId}', '${principalId}', '${environmentId}', '${workspaceId}', 'Sedes');
      INSERT INTO agent_backend_instances(tenant_id, id, kind)
      VALUES ('${tenantId}', 'backend-1', 'codex_app_server');
      INSERT INTO application_threads(
        tenant_id, owner_principal_id, environment_id, workspace_id,
        backend_instance_id, id, title
      ) VALUES (
        '${tenantId}', '${principalId}', '${environmentId}', '${workspaceId}',
        'backend-1', '${threadId}', 'Source thread'
      );
      INSERT INTO thread_principal_state(
        tenant_id, principal_id, thread_id, inventory_state
      ) VALUES ('${tenantId}', '${principalId}', '${threadId}', 'active');
    `);
    authority = new DatabaseAgentToolSourceAuthority(
      database,
      new Uint8Array(32).fill(7),
    );
  });

  afterEach(() => database.close());

  it("revokes an issued source capability when its project is removed while keeping resource facts readable", () => {
    const scope = { tenantId, principalId };
    const source = authority.resolveInScope(scope, threadId, new AbortController().signal);
    const capability = authority.issue(source, "management_http", "cli");
    database.prepare("UPDATE workspaces SET removed_at = 123 WHERE id = ?").run(workspaceId);
    expect(() => authority.resolveCapabilityInScope(scope, capability, new AbortController().signal))
      .toThrow(expect.objectContaining({ code: "not_found" }));
    expect(authority.resolveWorkspace(scope, workspaceId)).toMatchObject({ id: workspaceId });
    database.prepare("UPDATE workspaces SET removed_at = NULL WHERE id = ?").run(workspaceId);
    expect(authority.resolveInScope(scope, threadId, new AbortController().signal)).toEqual(source);
  });

  it("returns only server-owned source facts in the sidecar environment", () => {
    const reference = authority.issue(
      {
        scope: { tenantId, principalId },
        sourceThreadId: threadId,
        sourceWorkspaceId: workspaceId,
        sourceEnvironmentId: environmentId,
        backendKind: "codex_app_server",
      },
      "execution_environment_sidecar",
      "cli",
    );
    expect(
      authority.resolveCapabilityInExecutionEnvironment(
        { tenantId, principalId },
        environmentId,
        reference,
        new AbortController().signal,
      ),
    ).toEqual({
      source: {
        scope: { tenantId, principalId },
        sourceThreadId: threadId,
        sourceWorkspaceId: workspaceId,
        sourceEnvironmentId: environmentId,
        backendKind: "codex_app_server",
      },
      presentation: "cli",
    });
  });

  it("resolves saved Agent identity and current revision only within principal scope", () => {
    database.prepare("INSERT INTO saved_agents VALUES (?, ?, ?, 3, 'Reviewer')")
      .run(tenantId, principalId, "agent-1");
    expect(authority.resolveSavedAgent({ tenantId, principalId }, "agent-1"))
      .toEqual({ id: "agent-1", revision: 3, label: "Reviewer" });
    expect(authority.resolveSavedAgent({ tenantId: "other", principalId }, "agent-1"))
      .toBeUndefined();
    expect(authority.resolveSavedAgent({ tenantId, principalId: "other" }, "agent-1"))
      .toBeUndefined();
    expect(authority.resolveSavedAgent({ tenantId, principalId }, "missing"))
      .toBeUndefined();
    database.prepare("UPDATE saved_agents SET revision = 4, name = 'Updated'").run();
    expect(authority.resolveSavedAgent({ tenantId, principalId }, "agent-1"))
      .toEqual({ id: "agent-1", revision: 4, label: "Updated" });
  });

  it("resolves bounded environment, workspace, thread, and task facts", () => {
    database
      .prepare(
        `INSERT INTO tasks(
          tenant_id, owner_principal_id, id, scope_kind, environment_id,
          workspace_id, thread_id, title
        ) VALUES (?, ?, ?, 'thread', NULL, NULL, ?, 'Review')`,
      )
      .run(tenantId, principalId, "task-1", threadId);
    expect(authority.listEnvironments({ tenantId, principalId })).toEqual([
      { id: environmentId, environmentId, label: "Local" },
    ]);
    expect(
      authority.resolveWorkspace({ tenantId, principalId }, workspaceId),
    ).toEqual({
      id: workspaceId,
      environmentId,
      label: "Sedes",
    });
    expect(
      authority.resolveThread({ tenantId, principalId }, threadId),
    ).toEqual({
      id: threadId,
      environmentId,
      workspaceId,
      label: "Source thread",
    });
    expect(
      authority.resolveTask({ tenantId, principalId }, "task-1"),
    ).toMatchObject({
      id: "task-1",
      scopeKind: "thread",
      environmentId,
      threadId,
      revision: 0,
    });
  });

  it.each([
    [{ tenantId: "tenant-2", principalId }, environmentId, "permission_denied"],
    [{ tenantId, principalId: "principal-2" }, environmentId, "permission_denied"],
    [{ tenantId, principalId }, otherEnvironmentId, "not_found"],
  ])(
    "does not resolve a source outside the carrier scope %#",
    (scope, carrierEnvironmentId, expectedCode) => {
      const reference = authority.issue(
        {
          scope: { tenantId, principalId },
          sourceThreadId: threadId,
          sourceWorkspaceId: workspaceId,
          sourceEnvironmentId: environmentId,
          backendKind: "codex_app_server",
        },
        "execution_environment_sidecar",
        "cli",
      );
      expect(() =>
        authority.resolveCapabilityInExecutionEnvironment(
          scope,
          carrierEnvironmentId,
          reference,
          new AbortController().signal,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: expectedCode,
        }),
      );
    },
  );

  it("preserves the existing HTTP association inside principal scope", () => {
    expect(
      authority.resolveInScope(
        { tenantId, principalId },
        threadId,
        new AbortController().signal,
      ),
    ).toMatchObject({ sourceThreadId: threadId });
  });

  it("rejects an archived thread as an invocation source", () => {
    database
      .prepare(
        `UPDATE thread_principal_state SET inventory_state = 'archived'
         WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
      )
      .run(tenantId, principalId, threadId);
    expect(() =>
      authority.resolveInScope(
        { tenantId, principalId },
        threadId,
        new AbortController().signal,
      ),
    ).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("resolves stable references issued by a reconstructed authority", () => {
    const source = {
      scope: { tenantId, principalId },
      sourceThreadId: threadId,
      sourceWorkspaceId: workspaceId,
      sourceEnvironmentId: environmentId,
      backendKind: "codex_app_server" as const,
    };
    const first = authority.issue(source, "management_http", "cli");
    const second = authority.issue(source, "management_http", "cli");
    expect(second).toBe(first);
    const restarted = new DatabaseAgentToolSourceAuthority(
      database,
      new Uint8Array(32).fill(7),
    );
    expect(
      restarted.resolveCapabilityInScope(
        source.scope,
        first,
        new AbortController().signal,
      ),
    ).toMatchObject({ source: { sourceThreadId: threadId } });
    expect(
      restarted.resolveCapabilityInScope(
        source.scope,
        second,
        new AbortController().signal,
      ),
    ).toMatchObject({ source: { sourceThreadId: threadId } });
  });

  it("re-resolves current runtime facts instead of freezing them", () => {
    const reference = authority.issue(
      {
        scope: { tenantId, principalId },
        sourceThreadId: threadId,
        sourceWorkspaceId: workspaceId,
        sourceEnvironmentId: environmentId,
        backendKind: "codex_app_server",
      },
      "management_http",
      "cli",
    );
    database
      .prepare(
        `INSERT INTO agent_backend_instances(tenant_id, id, kind)
         VALUES (?, 'backend-2', 'pi_sdk')`,
      )
      .run(tenantId);
    database
      .prepare(
        `UPDATE application_threads SET backend_instance_id = 'backend-2'
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .run(tenantId, principalId, threadId);

    expect(
      authority.resolveCapabilityInScope(
        { tenantId, principalId },
        reference,
        new AbortController().signal,
      ),
    ).toMatchObject({ source: { backendKind: "pi_sdk" } });
  });

  it("refuses to issue a capability for mismatched trusted runtime facts", () => {
    expect(() =>
      authority.issue(
        {
          scope: { tenantId, principalId },
          sourceThreadId: threadId,
          sourceWorkspaceId: "workspace-forged",
          sourceEnvironmentId: environmentId,
          backendKind: "codex_app_server",
        },
        "management_http",
        "cli",
      ),
    ).toThrowError(expect.objectContaining({ code: "permission_denied" }));
  });

  it("binds each capability to exactly one ingress transport", () => {
    const source = {
      scope: { tenantId, principalId },
      sourceThreadId: threadId,
      sourceWorkspaceId: workspaceId,
      sourceEnvironmentId: environmentId,
      backendKind: "codex_app_server" as const,
    };
    const http = authority.issue(source, "management_http", "cli");
    const sidecar = authority.issue(source, "execution_environment_sidecar", "cli");
    const signal = new AbortController().signal;

    expect(() =>
      authority.resolveCapabilityInExecutionEnvironment(
        source.scope,
        environmentId,
        http,
        signal,
      ),
    ).toThrowError(expect.objectContaining({ code: "permission_denied" }));
    expect(() =>
      authority.resolveCapabilityInScope(
        source.scope,
        sidecar,
        signal,
      ),
    ).toThrowError(expect.objectContaining({ code: "permission_denied" }));
    expect(
      authority.resolveCapabilityInScope(source.scope, http, signal),
    ).toMatchObject({ source: { sourceThreadId: threadId } });
    expect(
      authority.resolveCapabilityInExecutionEnvironment(
        source.scope,
        environmentId,
        sidecar,
        signal,
      ),
    ).toMatchObject({ source: { sourceThreadId: threadId } });
  });

  it("reports the presentation a capability was issued for", () => {
    const source = {
      scope: { tenantId, principalId },
      sourceThreadId: threadId,
      sourceWorkspaceId: workspaceId,
      sourceEnvironmentId: environmentId,
      backendKind: "codex_app_server" as const,
    };
    const signal = new AbortController().signal;
    const cli = authority.issue(source, "management_http", "cli");
    const mcp = authority.issue(source, "management_http", "mcp");
    const sidecarMcp = authority.issue(
      source,
      "execution_environment_sidecar",
      "mcp",
    );

    expect(mcp).not.toBe(cli);
    expect(
      authority.resolveCapabilityInScope(source.scope, cli, signal),
    ).toMatchObject({ presentation: "cli" });
    expect(
      authority.resolveCapabilityInScope(source.scope, mcp, signal),
    ).toMatchObject({
      source: { sourceThreadId: threadId },
      presentation: "mcp",
    });
    expect(
      authority.resolveCapabilityInExecutionEnvironment(
        source.scope,
        environmentId,
        sidecarMcp,
        signal,
      ),
    ).toMatchObject({ presentation: "mcp" });
    expect(() =>
      authority.resolveCapabilityInScope(source.scope, sidecarMcp, signal),
    ).toThrowError(expect.objectContaining({ code: "permission_denied" }));
    expect(() =>
      authority.issue(source, "management_http", "http" as never),
    ).toThrow("agent_tool_source_capability_presentation_invalid");
  });

  it("fails closed when cancellation races source resolution", () => {
    const controller = new AbortController();
    controller.abort(new Error("caller_closed"));
    expect(() =>
      authority.resolveCapabilityInExecutionEnvironment(
        { tenantId, principalId },
        environmentId,
        "a".repeat(43),
        controller.signal,
      ),
    ).toThrowError(expect.objectContaining({ code: "cancelled" }));
  });
});
