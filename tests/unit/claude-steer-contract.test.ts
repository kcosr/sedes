import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { claudeTurnFailureDetailsMigration } from "../../src/server/db/migrations/109-claude-turn-failure-details.js";
import { claudeSteerOperationsMigration } from "../../src/server/db/migrations/102-claude-steer-operations.js";
import { claudeForkChildrenMigration } from "../../src/server/db/migrations/117-claude-fork-children.js";
import { claudeTaskLifecycleMigration } from "../../src/server/db/migrations/100-claude-task-lifecycle.js";
import Database from "better-sqlite3";
import type {
  Query,
  SDKControlInitializeResponse,
  SDKControlInterruptResponse,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendError,
  type ConversationBinding,
} from "../../src/server/backends/contracts.js";
import { ClaudeConversationHandle } from "../../src/server/backends/claude/claude-conversation-handle.js";
import type {
  ClaudeQueryInput,
  ClaudeSdkFacade,
} from "../../src/server/backends/claude/claude-sdk-facade.js";
import { ClaudeSdkRuntimeAdapter } from "../../src/server/backends/claude/claude-runtime-client.js";
import { ClaudeSdkSession } from "../../src/server/backends/claude/claude-sdk-session.js";
import { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const STEER_OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const TARGET_TURN_ID = "claude-turn:target";
const BINDING: ConversationBinding = {
  tenantId: "tenant-a",
  ownerPrincipalId: "principal-a",
  applicationThreadId: "thread-a",
  backendInstanceId: "claude-backend",
  connectionProfileId: "claude-local",
  executionEnvironmentId: "local",
  backendConversationId: SESSION_ID,
  createdAt: "2026-08-08T00:00:00.000Z",
};

const databases: Database.Database[] = [];

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
      PRIMARY KEY(tenant_id, owner_principal_id, application_thread_id)
    );
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
      PRIMARY KEY(
        tenant_id, owner_principal_id, application_thread_id, backend_turn_id
      )
    );
    CREATE TABLE claude_operation_settings_snapshots (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      application_thread_id TEXT NOT NULL,
      application_operation_id TEXT NOT NULL,
      settings_revision INTEGER NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(
        tenant_id, owner_principal_id, application_thread_id,
        application_operation_id
      )
    );
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
      PRIMARY KEY(tenant_id, owner_principal_id, application_thread_id)
    );
  `);
  database.exec(claudeTurnFailureDetailsMigration.sql);
  database.exec(claudeTaskLifecycleMigration.sql);
  database.exec(claudeSteerOperationsMigration.sql);
  database.exec(claudeForkChildrenMigration.sql);
  const settings = new ClaudeThreadRepository(database);
  const scope = {
    tenantId: BINDING.tenantId,
    principalId: BINDING.ownerPrincipalId,
  };
  settings.initialize(
    scope,
    BINDING.applicationThreadId,
    {
      backendInstanceId: BINDING.backendInstanceId,
      connectionProfileId: BINDING.connectionProfileId,
      executionEnvironmentId: BINDING.executionEnvironmentId,
    },
    {
      model: "claude-sonnet-5",
      effort: "low",
      permissionMode: "default",
    },
    1,
  );
  settings.confirmEffectiveModel(scope, BINDING.applicationThreadId, {
    expectedRevision: 0,
    model: "claude-sonnet-5",
    queryGeneration: 1,
    now: 2,
  });
  settings.confirmEffectiveEffort(scope, BINDING.applicationThreadId, {
    expectedRevision: 1,
    effort: "low",
    queryGeneration: 1,
    now: 3,
  });
  settings.confirmEffectivePermissionMode(scope, BINDING.applicationThreadId, {
    expectedRevision: 2,
    permissionMode: "default",
    classification: "recognized",
    queryGeneration: 1,
    now: 4,
  });
  return settings;
}

function provider(
  interruptReceipt: SDKControlInterruptResponse = {
    still_queued: [],
  },
  cliRelease = "2.1.283",
) {
  let input: ClaudeQueryInput | undefined;
  let releaseStream!: () => void;
  const streamClosed = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const interrupt = vi.fn(async () => interruptReceipt);
  const initialization = {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [],
    account: {
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
      tokenSource: "oauth",
    },
  } satisfies SDKControlInitializeResponse;
  const sdk = {
    readCliRelease: vi.fn(async () => cliRelease),
    readCliAuthStatus: vi.fn(async () => ({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
    })),
    createQuery(queryInput: ClaudeQueryInput): Query {
      input = queryInput;
      const stream = (async function* (): AsyncGenerator<SDKMessage, void> {
        yield {
          type: "system",
          subtype: "init",
          apiKeySource: "oauth",
          claude_code_version: cliRelease,
          cwd: queryInput.options.cwd!,
          tools: [],
          mcp_servers: [],
          model: "claude-sonnet-5",
          permissionMode: "default",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
          capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"],
          uuid: crypto.randomUUID(),
          session_id: SESSION_ID,
        };
        await streamClosed;
      })();
      return Object.assign(stream, {
        initializationResult: async () => initialization,
        interrupt,
        setModel: vi.fn(async () => undefined),
        setPermissionMode: vi.fn(async () => undefined),
        applyFlagSettings: vi.fn(async () => undefined),
        close: vi.fn(() => releaseStream()),
      }) as unknown as Query;
    },
    listSessions: vi.fn(),
    getSessionInfo: vi.fn(),
    getSessionMessages: vi.fn(async () => []),
    hasSessionTranscript: vi.fn(async () => false),
    renameSession: vi.fn(),
  } satisfies ClaudeSdkFacade;
  return {
    sdk,
    runtimeClient: new ClaudeSdkRuntimeAdapter(sdk),
    interrupt,
    queryInput: () => {
      if (!input) throw new Error("claude_query_not_started");
      return input;
    },
  };
}

function handle(runtimeClient: ClaudeSdkRuntimeAdapter): ClaudeConversationHandle {
  return new ClaudeConversationHandle({
      usage: NO_USAGE_SINK,
      nativeNamespace: "claude-test-native",
    binding: BINDING,
    canonicalWorkspacePath: "/workspace",
    workspaceId: "workspace-a",
    opaqueBindingDetail: '{"version":1}',
    runtimeClient,
    executablePath: "/usr/local/bin/claude",
    initializationTimeoutMs: 1_000,
    settings: repository(),
    permissionPolicy: { allowedModes: ["default"] },
    modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
    attachmentProvenanceKey: new Uint8Array(32).fill(0x42),
    childEnvironment: { HOME: "/home/test", PATH: "/usr/bin" },
    forkBoundaryAuthentication: {
      installationKey: new Uint8Array(32).fill(7),
      tenantId: BINDING.tenantId,
      principalId: BINDING.ownerPrincipalId,
      backendInstanceId: BINDING.backendInstanceId,
    },
    loadInitialMessages: async () => [],
    queryGeneration: 1,
    releaseSession: () => undefined,
  });
}

describe("Claude conversation-target Steer contract", () => {
  it("advertises conversation Steer independently from interrupt receipts", async () => {
    const fake = provider();
    const conversation = handle(fake.runtimeClient);
    await expect(conversation.backendCapabilities()).resolves.toMatchObject({
      deliveryModes: ["submit", "steer"],
      steerTarget: "conversation",
    });
    expect(
      (await conversation.backendCapabilities()).deliveryModes,
    ).toContain("steer");
    await conversation.close();
  });

  it("rejects direct Steer before the provider boundary without stale-target semantics", async () => {
    const fake = provider();
    const conversation = handle(fake.runtimeClient);
    await conversation.backendCapabilities();

    let rejection: unknown;
    try {
      await conversation.steer({
        applicationOperationId: STEER_OPERATION_ID,
        mutationId: "steer-mutation",
        reconciliationToken: "steer-reconciliation",
        target: { kind: "turn", turnId: TARGET_TURN_ID },
        text: "Change direction",
        contextExcerpts: [],
        taskContexts: [],
        attachments: [],
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(BackendError);
    expect(rejection).toMatchObject({
      category: "rejected",
      backendCode: "claude_steer_target_invalid",
      crossedSubmissionBoundary: false,
    });
    expect((rejection as BackendError).steerRejectionReason).toBeUndefined();
    expect(fake.interrupt).not.toHaveBeenCalled();
    await conversation.close();
  });

  it("rejects an older runtime before exposing a conversation or steering", async () => {
    const fake = provider(undefined, "2.1.241"); const conversation = handle(fake.runtimeClient);
    await expect(conversation.backendCapabilities()).rejects.toThrow("claude_cli_release_below_minimum");
    expect(fake.interrupt).not.toHaveBeenCalled();
    await conversation.close();
  });

  it("preserves queued UUIDs only as volatile interrupt receipt evidence", async () => {
    const receipt = {
      still_queued: [STEER_OPERATION_ID],
    } satisfies SDKControlInterruptResponse;
    const fake = provider(receipt);
    const session = new ClaudeSdkSession({
      sdk: fake.sdk,
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      sessionId: SESSION_ID,
      cwd: "/workspace",
      launch: "new",
      model: "claude-sonnet-5",
      effort: "low",
      permissionMode: "default",
      environment: { HOME: "/home/test" },
      onMessage: () => undefined,
    });
    await session.start();

    await expect(session.interrupt()).resolves.toEqual(receipt);
    expect(fake.interrupt).toHaveBeenCalledWith();
    expect(fake.queryInput().options).not.toHaveProperty("expectedTurnId");

    await session.close();
  });
});
