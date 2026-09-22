import { claudeTurnFailureDetailsMigration } from "../../src/server/db/migrations/109-claude-turn-failure-details.js";
import { claudeSteerOperationsMigration } from "../../src/server/db/migrations/102-claude-steer-operations.js";
import { claudeTaskLifecycleMigration } from "../../src/server/db/migrations/100-claude-task-lifecycle.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";

const databases: Database.Database[] = [];
const scope = { tenantId: "tenant", principalId: "principal" };
const target = {
  backendInstanceId: "claude-backend",
  connectionProfileId: "claude-connection",
  executionEnvironmentId: "environment",
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function repository(): ClaudeThreadRepository {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE claude_thread_settings (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      application_thread_id TEXT NOT NULL,
      backend_instance_id TEXT NOT NULL,
      connection_profile_id TEXT NOT NULL,
      execution_environment_id TEXT NOT NULL,
      desired_model TEXT,
      desired_effort TEXT,
      desired_permission_mode TEXT,
      effective_model TEXT,
      effective_model_state TEXT NOT NULL,
      effective_model_generation INTEGER,
      effective_effort TEXT,
      effective_effort_state TEXT NOT NULL,
      effective_effort_generation INTEGER,
      effective_permission_mode TEXT,
      effective_permission_classification TEXT,
      effective_permission_state TEXT NOT NULL,
      effective_permission_generation INTEGER,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id)
    ) STRICT;
    CREATE TABLE claude_operation_settings_snapshots (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      application_thread_id TEXT NOT NULL,
      application_operation_id TEXT NOT NULL,
      settings_revision INTEGER NOT NULL,
      model TEXT NOT NULL,
      effort TEXT,
      permission_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (
        tenant_id, owner_principal_id, application_thread_id,
        application_operation_id
      )
    ) STRICT;
    CREATE TRIGGER claude_operation_settings_snapshots_immutable_update
    BEFORE UPDATE ON claude_operation_settings_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'Claude operation settings snapshots are immutable');
    END;
    CREATE TRIGGER claude_operation_settings_snapshots_immutable_delete
    BEFORE DELETE ON claude_operation_settings_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'Claude operation settings snapshots are immutable');
    END;
    CREATE TABLE claude_skill_invocations (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      application_thread_id TEXT NOT NULL,
      native_user_message_uuid TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (
        tenant_id, owner_principal_id, application_thread_id,
        native_user_message_uuid
      )
    ) STRICT;
    CREATE TRIGGER claude_skill_invocations_immutable_update
    BEFORE UPDATE ON claude_skill_invocations
    BEGIN
      SELECT RAISE(ABORT, 'Claude skill invocations are immutable');
    END;
    CREATE TRIGGER claude_skill_invocations_immutable_delete
    BEFORE DELETE ON claude_skill_invocations
    BEGIN
      SELECT RAISE(ABORT, 'Claude skill invocations are immutable');
    END;
    CREATE TABLE claude_turn_terminal_receipts (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      application_thread_id TEXT NOT NULL,
      backend_turn_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('completed', 'interrupted', 'failed')
      ),
      provider_terminal_reason TEXT,
      provider_result_uuid TEXT,
      terminal_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (
        tenant_id, owner_principal_id, application_thread_id, backend_turn_id
      )
    ) STRICT;
    CREATE TABLE claude_usage_ledgers (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      application_thread_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      request_count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id)
    ) STRICT;
  `);
  database.exec(claudeTurnFailureDetailsMigration.sql);
  database.exec(claudeTaskLifecycleMigration.sql);
  database.exec(claudeSteerOperationsMigration.sql);
  return new ClaudeThreadRepository(database);
}

describe("Claude thread repository", () => {
  it("scopes task receipts to principal, thread and native session and preserves the first terminal observation", () => {
    const settings = repository();
    settings.initialize(scope, "thread", target, { model: "claude-haiku-4-5", effort: null, permissionMode: "default" }, 1);
    settings.writeTaskStarted(scope, "thread", "session", { nativeTaskId: "child", nativeToolUseId: "call", description: "Audit", now: 2 });
    for (const wrongScope of [{ ...scope, tenantId: "other" }, { ...scope, principalId: "other" }]) {
      settings.writeTaskTerminal(wrongScope, "thread", "session", { nativeTaskId: "child", status: "failed", now: 3 });
      expect(settings.listTaskLifecycleReceipts(wrongScope, "thread", "session")).toEqual([]);
    }
    settings.writeTaskTerminal(scope, "other-thread", "session", { nativeTaskId: "child", status: "failed", now: 3 });
    settings.writeTaskTerminal(scope, "thread", "other-session", { nativeTaskId: "child", status: "failed", now: 3 });
    expect(settings.listTaskLifecycleReceipts(scope, "thread", "session")[0]!.terminalStatus).toBeNull();
    settings.writeTaskTerminal(scope, "thread", "session", { nativeTaskId: "child", nativeToolUseId: "call", status: "completed", now: 4 });
    settings.writeTaskTerminal(scope, "thread", "session", { nativeTaskId: "child", status: "failed", now: 5 });
    settings.writeTaskStarted(scope, "thread", "session", { nativeTaskId: "child", nativeToolUseId: "call", description: "Replayed", now: 6 });
    expect(settings.listTaskLifecycleReceipts(scope, "thread", "session")).toEqual([{
      nativeTaskId: "child", nativeToolUseId: "call", description: "Audit", startedAt: 2, terminalStatus: "completed", terminalAt: 4,
    }]);
  });

  it("copies only retained tool receipts into the exact scoped fork session", () => {
    const settings = repository();
    const otherScope = { ...scope, principalId: "other" };
    for (const owner of [scope, otherScope]) for (const thread of ["source", "child"]) {
      settings.initialize(owner, thread, target, { model: "claude-sonnet-5", effort: null, permissionMode: "default" }, 1);
    }
    const start = { nativeTaskId: "agent", nativeToolUseId: "kept", description: "Audit", now: 2 };
    settings.writeTaskStarted(scope, "source", "source-session", start);
    settings.writeTaskTerminal(scope, "source", "source-session", { nativeTaskId: "agent", status: "completed", now: 3 });
    settings.writeTaskStarted(scope, "source", "source-session", { ...start, nativeTaskId: "later", nativeToolUseId: "excluded" });
    settings.writeTaskStarted(scope, "source", "other-session", { ...start, nativeTaskId: "wrong-session" });
    settings.writeTaskStarted(otherScope, "source", "source-session", { ...start, nativeTaskId: "wrong-owner" });
    const input = { sourceApplicationThreadId: "source", sourceNativeSessionId: "source-session",
      childApplicationThreadId: "child", childNativeSessionId: "child-session", nativeToolUseIds: ["kept"] };
    settings.copyTaskLifecycleReceiptsForFork(scope, input);
    settings.copyTaskLifecycleReceiptsForFork(scope, input);
    expect(settings.listTaskLifecycleReceipts(scope, "child", "child-session")).toEqual([{
      nativeTaskId: "agent", nativeToolUseId: "kept", description: "Audit", startedAt: 2, terminalStatus: "completed", terminalAt: 3,
    }]);
    expect(settings.listTaskLifecycleReceipts(scope, "child", "source-session")).toEqual([]);
    expect(settings.listTaskLifecycleReceipts(otherScope, "child", "child-session")).toEqual([]);
    expect(() => settings.copyTaskLifecycleReceiptsForFork({ ...scope, tenantId: "other" }, input)).toThrow();
    expect(() => settings.copyTaskLifecycleReceiptsForFork(scope, { ...input, childApplicationThreadId: "missing" })).toThrow();
  });

  it("persists and confirms an execution tuple with no effort axis", () => {
    const settings = repository();
    let record = settings.initialize(
      scope,
      "thread-effortless",
      target,
      { model: "claude-haiku-4-5", effort: null, permissionMode: "default" },
      100,
    );
    record = settings.confirmEffectiveEffort(scope, "thread-effortless", {
      expectedRevision: record.revision,
      effort: null,
      queryGeneration: 1,
      now: 101,
    });
    expect(record).toMatchObject({
      model: "claude-haiku-4-5",
      effort: null,
      effectiveEffort: null,
      effectiveEffortState: "confirmed",
      effectiveEffortGeneration: 1,
    });
    expect(
      settings.freezeOperationSettings(scope, "thread-effortless", {
        applicationOperationId: "operation-effortless",
        now: 102,
      }),
    ).toMatchObject({ model: "claude-haiku-4-5", effort: null });
  });
  it("initializes idempotently and fences desired-setting updates", () => {
    const settings = repository();
    expect(
      settings.initialize(
        scope,
        "thread",
        target,
        { model: "claude-sonnet-5", effort: "low", permissionMode: "default" },
        100,
      ),
    ).toMatchObject({
      ...target,
      model: "claude-sonnet-5",
      effort: "low",
      revision: 0,
    });
    expect(
      settings.initialize(
        scope,
        "thread",
        target,
        { model: "ignored-replay", effort: "high", permissionMode: "auto" },
        200,
      ),
    ).toMatchObject({ model: "claude-sonnet-5", effort: "low", revision: 0 });
    expect(
      settings.updateDesired(scope, "thread", {
        expectedRevision: 0,
        desired: {
          model: "claude-sonnet-5",
          effort: "medium",
          permissionMode: "acceptEdits",
        },
        now: 300,
      }),
    ).toMatchObject({ effort: "medium", revision: 1, updatedAt: 300 });
    expect(() =>
      settings.updateDesired(scope, "thread", {
        expectedRevision: 0,
        desired: {
          model: "claude-sonnet-5",
          effort: "high",
          permissionMode: "dontAsk",
        },
        now: 400,
      }),
    ).toThrow("claude_thread_settings_revision_changed");
  });

  it("does not read another principal's settings", () => {
    const settings = repository();
    settings.initialize(
      scope,
      "thread",
      target,
      { model: null, effort: null, permissionMode: null },
      100,
    );
    expect(
      settings.find(
        { tenantId: scope.tenantId, principalId: "different" },
        "thread",
      ),
    ).toBeUndefined();
  });

  it("persists per-axis generation-fenced effective evidence", () => {
    const settings = repository();
    let record = settings.initialize(
      scope,
      "thread-effective",
      target,
      { model: "claude-sonnet-5", effort: "medium", permissionMode: "auto" },
      100,
    );
    record = settings.confirmEffectiveModel(scope, "thread-effective", {
      expectedRevision: record.revision,
      model: "claude-sonnet-5",
      queryGeneration: 2,
      now: 110,
    });
    record = settings.confirmEffectiveEffort(scope, "thread-effective", {
      expectedRevision: record.revision,
      effort: "medium",
      queryGeneration: 2,
      now: 120,
    });
    record = settings.confirmEffectivePermissionMode(
      scope,
      "thread-effective",
      {
        expectedRevision: record.revision,
        permissionMode: "auto",
        classification: "recognized",
        queryGeneration: 2,
        now: 130,
      },
    );
    expect(record).toMatchObject({
      effectiveModel: "claude-sonnet-5",
      effectiveModelState: "confirmed",
      effectiveModelGeneration: 2,
      effectiveEffort: "medium",
      effectiveEffortState: "confirmed",
      effectiveEffortGeneration: 2,
      effectivePermissionMode: "auto",
      effectivePermissionClassification: "recognized",
      effectivePermissionState: "confirmed",
      effectivePermissionGeneration: 2,
    });
    record = settings.markEffectiveAxisUnknown(scope, "thread-effective", {
      expectedRevision: record.revision,
      axis: "effort",
      queryGeneration: 2,
      now: 135,
    });
    expect(record).toMatchObject({
      effectiveModelState: "confirmed",
      effectiveEffortState: "unknown",
      effectiveEffortGeneration: null,
      effectivePermissionState: "confirmed",
    });
    expect(
      settings.markEffectiveUnknown(scope, "thread-effective", {
        expectedRevision: record.revision,
        now: 140,
      }),
    ).toMatchObject({
      effectiveModel: "claude-sonnet-5",
      effectiveModelState: "unknown",
      effectiveModelGeneration: null,
      effectivePermissionMode: "auto",
      effectivePermissionState: "unknown",
      effectivePermissionGeneration: null,
    });
  });

  it("CAS-adopts one recognized imported permission mode", () => {
    const settings = repository();
    const unresolved = settings.initialize(
      scope,
      "thread-imported",
      target,
      { model: null, effort: null, permissionMode: null },
      100,
    );
    const adopted = settings.adoptImportedPermissionMode(
      scope,
      "thread-imported",
      {
        expectedRevision: unresolved.revision,
        permissionMode: "dontAsk",
        queryGeneration: 1,
        now: 110,
      },
    );
    expect(adopted).toMatchObject({
      model: null,
      effort: null,
      permissionMode: "dontAsk",
      effectivePermissionMode: "dontAsk",
      effectivePermissionState: "confirmed",
      effectivePermissionGeneration: 1,
    });
    expect(() =>
      settings.adoptImportedPermissionMode(scope, "thread-imported", {
        expectedRevision: adopted.revision,
        permissionMode: "default",
        queryGeneration: 2,
        now: 120,
      }),
    ).toThrow("claude_thread_settings_revision_changed");
  });

  it("invalidates only this principal's confirmed backend generations", () => {
    const settings = repository();
    let record = settings.initialize(
      scope,
      "thread-restart",
      target,
      { model: "claude-sonnet-5", effort: "low", permissionMode: "default" },
      100,
    );
    record = settings.confirmEffectivePermissionMode(scope, "thread-restart", {
      expectedRevision: record.revision,
      permissionMode: "default",
      classification: "recognized",
      queryGeneration: 4,
      now: 110,
    });

    expect(
      settings.invalidateConfirmedForBackend(
        { tenantId: scope.tenantId, principalId: "other" },
        target.backendInstanceId,
        120,
      ),
    ).toBe(0);
    expect(
      settings.invalidateConfirmedForBackend(
        scope,
        target.backendInstanceId,
        130,
      ),
    ).toBe(1);
    expect(settings.get(scope, "thread-restart")).toMatchObject({
      effectivePermissionMode: "default",
      effectivePermissionState: "unknown",
      effectivePermissionGeneration: null,
    });
  });

  it("freezes immutable idempotent operation snapshots", () => {
    const settings = repository();
    settings.initialize(
      scope,
      "thread-snapshot",
      target,
      {
        model: "claude-sonnet-5",
        effort: "medium",
        permissionMode: "acceptEdits",
      },
      100,
    );
    const first = settings.freezeOperationSnapshot(scope, {
      applicationThreadId: "thread-snapshot",
      applicationOperationId: "operation-1",
      now: 110,
    });
    settings.updateDesired(scope, "thread-snapshot", {
      expectedRevision: 0,
      desired: {
        model: "claude-opus-5",
        effort: "high",
        permissionMode: "bypassPermissions",
      },
      now: 120,
    });
    expect(
      settings.freezeOperationSnapshot(scope, {
        applicationThreadId: "thread-snapshot",
        applicationOperationId: "operation-1",
        now: 130,
      }),
    ).toEqual(first);
    expect(first).toMatchObject({
      settingsRevision: 0,
      model: "claude-sonnet-5",
      effort: "medium",
      permissionMode: "acceptEdits",
    });
    expect(() =>
      settings.database
        .prepare(
          "UPDATE claude_operation_settings_snapshots SET effort = 'low'",
        )
        .run(),
    ).toThrow("Claude operation settings snapshots are immutable");
  });

  it("copies only consumed retained steer associations with the fork native UUID mapping", () => {
    const settings = repository();
    for (const thread of ["source-thread", "child-thread"]) settings.initialize(scope, thread, target,
      { model: "claude-sonnet-5", effort: "medium", permissionMode: "default" }, 100);
    settings.recordSteerOperation(scope, "source-thread", "steer");
    settings.associateSteerOperation(scope, "source-thread", "steer", "root");
    settings.recordSteerOperation(scope, "source-thread", "pending");
    settings.recordSteerOperation(scope, "source-thread", "later");
    settings.associateSteerOperation(scope, "source-thread", "later", "later-root");
    settings.copySteerOperationsForFork(scope, { sourceApplicationThreadId: "source-thread", childApplicationThreadId: "child-thread",
      nativeUserMessageMappings: [{ sourceUuid: "root", childUuid: "child-root" }, { sourceUuid: "steer", childUuid: "child-steer" }, { sourceUuid: "pending", childUuid: "child-pending" }] });
    expect([...settings.listSteerOperations(scope, "child-thread")]).toEqual([["child-steer", "child-root"]]);
    expect(settings.listSteerOperations({ ...scope, principalId: "wrong" }, "child-thread").size).toBe(0);
  });

  it("copies only selected operation evidence to a native fork", () => {
    const settings = repository();
    for (const applicationThreadId of ["source-thread", "child-thread"]) {
      settings.initialize(
        scope,
        applicationThreadId,
        target,
        {
          model: "claude-sonnet-5",
          effort: "medium",
          permissionMode: "default",
        },
        100,
      );
    }
    for (const applicationOperationId of [
      "retained-operation",
      "later-operation",
    ]) {
      settings.freezeOperationSnapshot(scope, {
        applicationThreadId: "source-thread",
        applicationOperationId,
        now: 110,
      });
    }

    settings.copyOperationSnapshotsForFork(scope, {
      sourceApplicationThreadId: "source-thread",
      childApplicationThreadId: "child-thread",
      applicationOperationIds: ["retained-operation"],
    });

    expect(
      settings.hasOperationSnapshot(scope, {
        applicationThreadId: "child-thread",
        applicationOperationId: "retained-operation",
      }),
    ).toBe(true);
    expect(
      settings.hasOperationSnapshot(scope, {
        applicationThreadId: "child-thread",
        applicationOperationId: "later-operation",
      }),
    ).toBe(false);
    expect(
      settings.findOperationSnapshot(scope, {
        applicationThreadId: "child-thread",
        applicationOperationId: "retained-operation",
      }),
    ).toMatchObject({
      applicationThreadId: "child-thread",
      applicationOperationId: "retained-operation",
    });
  });

  it("stores scoped immutable skill evidence and copies UUID-remapped forks", () => {
    const settings = repository();
    for (const threadId of ["skill-source", "skill-child"]) {
      settings.initialize(
        scope,
        threadId,
        target,
        {
          model: "claude-sonnet-5",
          effort: "medium",
          permissionMode: "default",
        },
        100,
      );
    }
    const source = settings.recordSkillInvocation(scope, "skill-source", {
      nativeUserMessageUuid: "source-user-uuid",
      skillName: "review",
      now: 110,
    });
    expect(
      settings.recordSkillInvocation(scope, "skill-source", {
        nativeUserMessageUuid: "source-user-uuid",
        skillName: "review",
        now: 120,
      }),
    ).toEqual(source);
    expect(() =>
      settings.recordSkillInvocation(scope, "skill-source", {
        nativeUserMessageUuid: "source-user-uuid",
        skillName: "other",
        now: 120,
      }),
    ).toThrow("claude_skill_invocation_replay_mismatch");
    expect(
      settings.findSkillInvocation(
        { tenantId: scope.tenantId, principalId: "other-principal" },
        "skill-source",
        "source-user-uuid",
      ),
    ).toBeUndefined();

    settings.copySkillInvocationsForFork(scope, {
      sourceApplicationThreadId: "skill-source",
      childApplicationThreadId: "skill-child",
      nativeUserMessageMappings: [
        { sourceUuid: "source-user-uuid", childUuid: "child-user-uuid" },
      ],
    });
    expect(
      settings.findSkillInvocation(scope, "skill-child", "child-user-uuid"),
    ).toMatchObject({ skillName: "review" });
    settings.recordSkillInvocation(scope, "skill-child", {
      nativeUserMessageUuid: "orphan-child-user-uuid",
      skillName: "review",
      now: 130,
    });
    expect(() =>
      settings.copySkillInvocationsForFork(scope, {
        sourceApplicationThreadId: "skill-source",
        childApplicationThreadId: "skill-child",
        nativeUserMessageMappings: [
          {
            sourceUuid: "source-user-without-evidence",
            childUuid: "orphan-child-user-uuid",
          },
        ],
      }),
    ).toThrow("claude_skill_invocation_fork_mismatch");
    expect(() =>
      settings.database
        .prepare("UPDATE claude_skill_invocations SET skill_name = 'other'")
        .run(),
    ).toThrow("Claude skill invocations are immutable");
  });

  it("looks up and streams exact operation evidence beyond 20,000 durable snapshots", () => {
    const settings = repository();
    for (const applicationThreadId of ["large-source", "large-child"]) {
      settings.initialize(
        scope,
        applicationThreadId,
        target,
        {
          model: "claude-sonnet-5",
          effort: "medium",
          permissionMode: "default",
        },
        100,
      );
    }
    const insert = settings.database.prepare(`
      INSERT INTO claude_operation_settings_snapshots(
        tenant_id, owner_principal_id, application_thread_id,
        application_operation_id, settings_revision, model, effort,
        permission_mode, created_at
      ) VALUES (?, ?, ?, ?, 0, 'claude-sonnet-5', 'medium', 'default', ?)
    `);
    settings.database.transaction(() => {
      for (let index = 0; index < 20_001; index += 1) {
        insert.run(
          scope.tenantId,
          scope.principalId,
          "large-source",
          `operation-${index}`,
          110 + index,
        );
      }
    })();

    expect(
      settings.hasOperationSnapshot(scope, {
        applicationThreadId: "large-source",
        applicationOperationId: "operation-20000",
      }),
    ).toBe(true);
    expect(
      settings.hasOperationSnapshot(
        { tenantId: scope.tenantId, principalId: "other-principal" },
        {
          applicationThreadId: "large-source",
          applicationOperationId: "operation-20000",
        },
      ),
    ).toBe(false);

    function* exactOperationIds(): IterableIterator<string> {
      for (let index = 0; index < 20_001; index += 1) {
        yield `operation-${index}`;
      }
    }
    settings.copyOperationSnapshotsForFork(scope, {
      sourceApplicationThreadId: "large-source",
      childApplicationThreadId: "large-child",
      applicationOperationIds: exactOperationIds(),
    });

    expect(
      settings.hasOperationSnapshot(scope, {
        applicationThreadId: "large-child",
        applicationOperationId: "operation-20000",
      }),
    ).toBe(true);
    expect(
      settings.database
        .prepare(
          `SELECT count(*) AS count
           FROM claude_operation_settings_snapshots
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND application_thread_id = ?`,
        )
        .get(scope.tenantId, scope.principalId, "large-child"),
    ).toEqual({ count: 20_001 });
  });

  it("writes terminal receipts idempotently and rejects a conflicting status", () => {
    const settings = repository();
    const receipt = settings.writeTerminalReceipt(scope, "thread", {
      backendTurnId: "claude-turn:one",
      status: "failed",
      providerTerminalReason: "error_during_execution",
      failureMessage: "Invalid model configuration",
      providerResultUuid: "00000000-0000-4000-8000-000000000001",
      terminalAt: 200,
      now: 201,
    });
    expect(receipt).toMatchObject({
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      applicationThreadId: "thread",
      backendTurnId: "claude-turn:one",
      status: "failed",
      providerTerminalReason: "error_during_execution",
      failureMessage: "Invalid model configuration",
      terminalAt: 200,
    });
    expect(
      settings.writeTerminalReceipt(scope, "thread", {
        backendTurnId: "claude-turn:one",
        status: "failed",
        providerTerminalReason: "a replay cannot replace the first evidence",
        failureMessage: "A replay cannot replace the original diagnostic",
        terminalAt: 300,
        now: 301,
      }),
    ).toEqual(receipt);
    expect(() =>
      settings.writeTerminalReceipt(scope, "thread", {
        backendTurnId: "claude-turn:one",
        status: "interrupted",
        terminalAt: 400,
        now: 401,
      }),
    ).toThrow("claude_terminal_receipt_status_conflict");
  });

  it("rejects diagnostic text outside failed turns or the UTF-8 limit", () => {
    const settings = repository();
    for (const input of [
      { status: "completed" as const, failureMessage: "Should not appear" },
      { status: "failed" as const, failureMessage: "界".repeat(342) },
    ]) {
      expect(() => settings.writeTerminalReceipt(scope, "thread", {
        backendTurnId: "turn", terminalAt: 1, now: 1, ...input,
      })).toThrow();
    }
  });

  it("lists terminal receipts only inside the exact principal and thread", () => {
    const settings = repository();
    settings.writeTerminalReceipt(scope, "thread-a", {
      backendTurnId: "claude-turn:later",
      status: "interrupted",
      terminalAt: 300,
      now: 300,
    });
    settings.writeTerminalReceipt(scope, "thread-a", {
      backendTurnId: "claude-turn:earlier",
      status: "failed",
      terminalAt: 200,
      now: 200,
    });
    settings.writeTerminalReceipt(scope, "thread-b", {
      backendTurnId: "claude-turn:other-thread",
      status: "failed",
      terminalAt: 100,
      now: 100,
    });
    settings.writeTerminalReceipt(
      { tenantId: scope.tenantId, principalId: "other-principal" },
      "thread-a",
      {
        backendTurnId: "claude-turn:other-principal",
        status: "failed",
        terminalAt: 100,
        now: 100,
      },
    );

    expect(
      settings
        .listTerminalReceipts(scope, "thread-a")
        .map(({ backendTurnId }) => backendTurnId),
    ).toEqual(["claude-turn:earlier", "claude-turn:later"]);
    expect(
      settings.listTerminalReceipts(
        { tenantId: scope.tenantId, principalId: "missing" },
        "thread-a",
      ),
    ).toEqual([]);
    expect(
      settings.findTerminalReceipt(scope, {
        applicationThreadId: "thread-a",
        backendTurnId: "claude-turn:earlier",
      }),
    ).toMatchObject({
      applicationThreadId: "thread-a",
      backendTurnId: "claude-turn:earlier",
      status: "failed",
    });
    expect(
      settings.findTerminalReceipt(scope, {
        applicationThreadId: "thread-b",
        backendTurnId: "claude-turn:earlier",
      }),
    ).toBeUndefined();
  });

  it("rejects unbounded provider terminal evidence", () => {
    const settings = repository();
    expect(() =>
      settings.writeTerminalReceipt(scope, "thread", {
        backendTurnId: "claude-turn:one",
        status: "failed",
        providerTerminalReason: "x".repeat(2_049),
        terminalAt: 100,
        now: 100,
      }),
    ).toThrow("claude_terminal_receipt_provider_terminal_reason_invalid");
  });

});
