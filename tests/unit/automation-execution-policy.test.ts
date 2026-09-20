import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAutomationExecutionPolicy } from "../../src/server/backends/claude/claude-automation-execution-policy.js";
import type { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { PiAutomationExecutionPolicy } from "../../src/server/backends/pi/pi-automation-execution-policy.js";
import type { PiConversationRepository } from "../../src/server/backends/pi/pi-conversation-repository.js";
import { BackendAutomationExecutionPolicyRouter } from "../../src/server/runtime/automation-execution-policy.js";

const scope = Object.freeze({ tenantId: "tenant-1", principalId: "user-1" });
const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("backend automation execution policy", () => {
  it("routes by the scoped backend instance and fails closed", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE workspaces(tenant_id TEXT, owner_principal_id TEXT, id TEXT, removed_at INTEGER);
      INSERT INTO workspaces VALUES ('tenant-1', 'user-1', 'workspace-1', NULL);
      CREATE TABLE application_threads(
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        id TEXT NOT NULL,
        backend_instance_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        PRIMARY KEY(tenant_id, owner_principal_id, id)
      );
      INSERT INTO application_threads VALUES(
        'tenant-1', 'user-1', 'thread-1', 'pi-primary', 'workspace-1'
      );
    `);
    const assertCanAutomate = vi.fn();
    const router = new BackendAutomationExecutionPolicyRouter(
      database,
      new Map([["pi-primary", { assertCanAutomate }]]),
    );

    router.assertCanAutomate(scope, "thread-1");
    expect(assertCanAutomate).toHaveBeenCalledWith(scope, "thread-1");
    expect(() =>
      router.assertCanAutomate(
        { ...scope, principalId: "user-2" },
        "thread-1",
      ),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() =>
      new BackendAutomationExecutionPolicyRouter(database, new Map()).assertCanAutomate(
        scope,
        "thread-1",
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_transition" }));
    database.exec("UPDATE workspaces SET removed_at = 123");
    assertCanAutomate.mockClear();
    expect(() => router.assertCanAutomate(scope, "thread-1"))
      .toThrow(expect.objectContaining({ code: "invalid_transition" }));
    expect(assertCanAutomate).not.toHaveBeenCalled();
  });

  it("requires Pi's complete durable provider/model/effort tuple", () => {
    const current = {
      modelProvider: "xai",
      modelId: "grok-4.5",
      thinkingLevel: "low",
    };
    const settings = {
      getSettings: vi.fn(() => current),
    } as unknown as PiConversationRepository;
    const allowed = new PiAutomationExecutionPolicy(
      settings,
      compileBackendModelPolicy(
        {
          type: "allowlist",
          allowed: [
            {
              providerIds: ["xai"],
              modelIds: ["grok-4.5"],
              reasoningEfforts: ["low"],
            },
          ],
        },
        "provider_model_effort",
      ),
    );
    expect(() => allowed.assertCanAutomate(scope, "thread-1")).not.toThrow();

    current.thinkingLevel = "high";
    expect(() => allowed.assertCanAutomate(scope, "thread-1")).toThrow(
      expect.objectContaining({ code: "invalid_transition" }),
    );
  });

  it("requires Claude's complete durable model/effort tuple", () => {
    const current = { model: "claude-opus-4-1", effort: "high" };
    const settings = {
      find: vi.fn(() => current),
    } as unknown as ClaudeThreadRepository;
    const allowed = new ClaudeAutomationExecutionPolicy(
      settings,
      compileBackendModelPolicy(
        {
          type: "allowlist",
          allowed: [
            {
              modelIds: ["claude-opus-4-1"],
              reasoningEfforts: ["high"],
            },
          ],
        },
        "model_effort",
      ),
    );
    expect(() => allowed.assertCanAutomate(scope, "thread-1")).not.toThrow();

    current.effort = "low";
    expect(() => allowed.assertCanAutomate(scope, "thread-1")).toThrow(
      expect.objectContaining({ code: "invalid_transition" }),
    );
  });
});
