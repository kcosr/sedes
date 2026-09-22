import { NO_USAGE_SINK, type UsageSink, type UsageObservation } from "../../src/server/usage/contracts.js";
import { claudeTurnFailureDetailsMigration } from "../../src/server/db/migrations/109-claude-turn-failure-details.js";
import { claudeSteerOperationsMigration } from "../../src/server/db/migrations/102-claude-steer-operations.js";
import { claudeTaskLifecycleMigration } from "../../src/server/db/migrations/100-claude-task-lifecycle.js";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  EffortLevel,
  Options,
  PermissionMode,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendError,
  type ConversationBinding,
} from "../../src/server/backends/contracts.js";
import type { BackendConversationEvent } from "../../src/shared/protocol/backend.js";
import {
  ClaudeConversationHandle,
  type ClaudeEffortEvidence,
  type ClaudeModelEvidence,
  type ClaudePermissionModeEvidence,
} from "../../src/server/backends/claude/claude-conversation-handle.js";
import { isClaudePermissionMode } from "../../src/server/backends/claude/claude-permission-policy.js";
import { claudeForkContextBoundaryText } from "../../src/server/backends/claude/claude-fork-context-boundary.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../../src/server/backends/fork-context-boundary.js";
import type {
  ClaudeQueryInput,
  ClaudeSdkFacade,
} from "../../src/server/backends/claude/claude-sdk-facade.js";
import {
  ClaudeSdkRuntimeAdapter,
  type ClaudeRuntimeClient,
  type ClaudeRuntimeSessionOptions,
} from "../../src/server/backends/claude/claude-runtime-client.js";
import { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import type { BackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { renderTaskContextsForModel } from "../../src/server/conversations/delivery-input-projection.js";
import { claudeSkillId } from "../../src/server/backends/claude/claude-skills.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
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
const TASK_CONTEXT = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  scope: { kind: "global" as const },
  title: "Implement task context",
  details: "Carry the exact task identity to Claude.",
  pinned: false,
  files: [],
  completedAt: null,
  revision: 3,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};
const COMMON_TASK_PROMPT = renderTaskContextsForModel(
  [TASK_CONTEXT],
  "Explain this",
);

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
    CREATE TABLE claude_skill_invocations (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      application_thread_id TEXT NOT NULL,
      native_user_message_uuid TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(
        tenant_id, owner_principal_id, application_thread_id,
        native_user_message_uuid
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
    )
  `);
  database.exec(claudeTurnFailureDetailsMigration.sql);
  database.exec(claudeTaskLifecycleMigration.sql);
  database.exec(claudeSteerOperationsMigration.sql);
  const result = new ClaudeThreadRepository(database);
  result.initialize(
    { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId },
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
  const scope = {
    tenantId: BINDING.tenantId,
    principalId: BINDING.ownerPrincipalId,
  };
  result.confirmEffectiveModel(scope, BINDING.applicationThreadId, {
    expectedRevision: 0,
    model: "claude-sonnet-5",
    queryGeneration: 1,
    now: 2,
  });
  result.confirmEffectiveEffort(scope, BINDING.applicationThreadId, {
    expectedRevision: 1,
    effort: "low",
    queryGeneration: 1,
    now: 3,
  });
  result.confirmEffectivePermissionMode(scope, BINDING.applicationThreadId, {
    expectedRevision: 2,
    permissionMode: "default",
    classification: "recognized",
    queryGeneration: 1,
    now: 4,
  });
  return result;
}

class MessageQueue implements AsyncIterable<SDKMessage> {
  readonly #values: SDKMessage[] = [];
  readonly #waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  #closed = false;

  push(message: SDKMessage): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.#values.push(message);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0))
      waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { done: false, value };
        if (this.#closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<SDKMessage>>((resolve) =>
          this.#waiters.push(resolve),
        );
      },
    };
  }
}

function fixture(options: { readonly safeSkill?: boolean } = {}) {
  const messages = new MessageQueue();
  let queryInput: ClaudeQueryInput | undefined;
  const controls = {
    interrupt: vi.fn(async () => ({ still_queued: [] })),
    setModel: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    applyFlagSettings: vi.fn(async () => undefined),
    close: vi.fn(() => messages.close()),
  };
  const initialization = {
    commands: options.safeSkill
      ? [
          {
            name: "review",
            description: "Review changes",
            argumentHint: "[path]",
          },
        ]
      : [],
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
    readCliRelease: vi.fn(async () => "2.1.274"),
    readCliAuthStatus: vi.fn(async () => ({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
    })),
    createQuery(input: ClaudeQueryInput): Query {
      queryInput = input;
      const stream = (async function* () {
        yield {
          type: "system",
          subtype: "init",
          apiKeySource: "oauth",
          claude_code_version: "2.1.274",
          cwd: input.options.cwd!,
          tools: [],
          mcp_servers: [],
          model: "claude-sonnet-5",
          permissionMode: "default",
          slash_commands: options.safeSkill ? ["review"] : [],
          output_style: "default",
          skills: options.safeSkill ? ["review"] : [],
          plugins: [],
          uuid: crypto.randomUUID(),
          session_id: SESSION_ID,
        } satisfies SDKMessage;
        yield* messages;
      })();
      return Object.assign(stream, {
        initializationResult: async () => initialization,
        interrupt: controls.interrupt,
        setModel: controls.setModel,
        setPermissionMode: controls.setPermissionMode,
        applyFlagSettings: controls.applyFlagSettings,
        close: controls.close,
      }) as unknown as Query;
    },
    listSessions: vi.fn(),
    getSessionInfo: vi.fn(async () => undefined),
    getSessionMessages: vi.fn<ClaudeSdkFacade["getSessionMessages"]>(
      async () => [],
    ),
    renameSession: vi.fn(async () => undefined),
  } satisfies ClaudeSdkFacade;
  return {
    sdk,
    messages,
    controls,
    options: () => {
      if (!queryInput) throw new Error("query_not_started");
      return queryInput.options;
    },
    rawPrompt: () => {
      if (!queryInput) throw new Error("query_not_started");
      return queryInput.prompt as AsyncIterable<SDKUserMessage>;
    },
    prompt: () => {
      if (!queryInput) throw new Error("query_not_started");
      const input = queryInput.prompt as AsyncIterable<SDKUserMessage>;
      return {
        [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
          const iterator = input[Symbol.asyncIterator]();
          return {
            next: async () => {
              for (;;) {
                const candidate = await iterator.next();
                if (candidate.done || !candidate.value.isSynthetic) {
                  return candidate;
                }
              }
            },
          };
        },
      };
    },
  };
}

function createHandle(
  input: ReturnType<typeof fixture>,
  release = vi.fn(),
  options: {
    readonly usage?: UsageSink;
    readonly runtimeClient?: ClaudeRuntimeClient;
    readonly agentToolCliClosed?: Promise<unknown>;
    readonly agentToolCli?: import("../../src/server/backends/module.js").AgentToolCliAvailability;
    readonly settings?: ClaudeThreadRepository;
    readonly initialMessages?: readonly SessionMessage[];
    readonly loadInitialMessages?: () => Promise<readonly SessionMessage[]>;
    readonly resumeSession?: boolean;
    readonly allowDangerouslySkipPermissions?: true;
    readonly onPermissionModeEvidence?: (evidence: {
      readonly generation: number;
      readonly mode: PermissionMode;
      readonly source: "init" | "setter" | "status";
    }) => void;
    readonly onModelEvidence?: (evidence: {
      readonly generation: number;
      readonly model: string;
      readonly source: "init" | "setter";
    }) => void;
    readonly onEffortEvidence?: (evidence: {
      readonly generation: number;
      readonly effort: EffortLevel | null;
      readonly source: "setter";
    }) => void;
    readonly permissionPolicy?: {
      readonly allowedModes: readonly ("default" | "bypassPermissions")[];
    };
    readonly modelPolicy?: BackendModelPolicy;
    readonly onQueryGenerationLost?: (generation: number) => void;
    readonly onEffectiveAxisUnknown?: (
      generation: number,
      axis: "model" | "effort" | "permission",
    ) => void;
    readonly onError?: (error: unknown) => void;
  } = {},
) {
  const settings = options.settings ?? repository();
  return {
    release,
    settings,
    handle: new ClaudeConversationHandle({
      usage: options.usage ?? NO_USAGE_SINK,
      nativeNamespace: "claude-test-native",
      binding: BINDING,
      canonicalWorkspacePath: "/workspace",
      workspaceId: "workspace-a",
      opaqueBindingDetail: '{"version":1}',
      runtimeClient:
        options.runtimeClient ?? new ClaudeSdkRuntimeAdapter(input.sdk),
      ...(options.agentToolCliClosed
        ? { agentToolCliClosed: options.agentToolCliClosed }
        : {}),
      ...(options.agentToolCli
        ? {
            agentToolCli: options.agentToolCli,
            sourceCapability: "s".repeat(32),
            agentToolCliMode: "progressive" as const,
          }
        : {}),
      executablePath: "/usr/local/bin/claude",
      initializationTimeoutMs: 1_000,
      permissionPolicy: options.permissionPolicy ?? {
        allowedModes: ["default", "bypassPermissions"],
      },
      modelPolicy: compileBackendModelPolicy(
        options.modelPolicy ?? { type: "catalog" },
        "model_effort",
      ),
      queryGeneration: 1,
      attachmentProvenanceKey: new Uint8Array(32).fill(0x42),
      settings,
      forkBoundaryAuthentication: {
        installationKey: new Uint8Array(32).fill(7),
        tenantId: BINDING.tenantId,
        principalId: BINDING.ownerPrincipalId,
        backendInstanceId: BINDING.backendInstanceId,
      },
      childEnvironment: { HOME: "/home/test", PATH: "/usr/bin" },
      loadInitialMessages:
        options.loadInitialMessages ??
        (async () => options.initialMessages ?? []),
      resumeSession: options.resumeSession ?? false,
      ...(options.allowDangerouslySkipPermissions
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(options.onPermissionModeEvidence
        ? { onPermissionModeEvidence: options.onPermissionModeEvidence }
        : {}),
      ...(options.onModelEvidence
        ? { onModelEvidence: options.onModelEvidence }
        : {}),
      ...(options.onEffortEvidence
        ? { onEffortEvidence: options.onEffortEvidence }
        : {}),
      ...(options.onQueryGenerationLost
        ? { onQueryGenerationLost: options.onQueryGenerationLost }
        : {}),
      ...(options.onEffectiveAxisUnknown
        ? { onEffectiveAxisUnknown: options.onEffectiveAxisUnknown }
        : {}),
      ...(options.onError ? { onError: options.onError } : {}),
      releaseSession: release,
    }),
  };
}

function retainedRuntime(
  provider: ReturnType<typeof fixture>,
  replay: SDKMessage[],
  confirmedEffort?: EffortLevel | null,
) {
  let activeOptions: ClaudeRuntimeSessionOptions | undefined;
  let delivery = Promise.resolve();
  let detached = false;
  const runtime = new (class extends ClaudeSdkRuntimeAdapter {
    override createSession(options: ClaudeRuntimeSessionOptions) {
      activeOptions = options;
      detached = false;
      const session = super.createSession(options);
      return {
        get closed() {
          return session.closed;
        },
        get initialization() {
          return session.initialization;
        },
        get startupProbeUuid() {
          return session.startupProbeUuid;
        },
        get safeSkills() {
          return session.safeSkills;
        },
        reattached: true,
        lifetime: "persistent_service" as const,
        ...(confirmedEffort !== undefined ? { confirmedEffort } : {}),
        async start() {
          const initialization = await session.start();
          for (const message of replay) {
            delivery = delivery.then(async () => {
              await options.onMessage(message);
            });
          }
          return initialization;
        },
        flushMessages: () => delivery,
        send: session.send.bind(session),
        interrupt: session.interrupt.bind(session),
        setModel: session.setModel.bind(session),
        setEffort: session.setEffort.bind(session),
        setPermissionMode: session.setPermissionMode.bind(session),
        close() {
          detached = true;
          return session.close();
        },
      };
    }
  })(provider.sdk);
  return {
    runtime,
    async permission() {
      if (!activeOptions?.canUseTool)
        throw new Error("permission_callback_missing");
      const options = activeOptions;
      const response = await options.canUseTool!(
        "Read",
        { file_path: "/workspace/a" },
        {
          requestId: "retained-permission",
          toolUseID: "retained-tool",
          signal: new AbortController().signal,
        },
      );
      if (detached) return undefined;
      await options.onPermissionResponseDelivered?.({
        requestId: "retained-permission",
        toolUseID: "retained-tool",
      });
      return response;
    },
  };
}

describe("Claude retained turn lookup", () => {
  const nativeMessage = (
    type: "user" | "assistant",
    index: number,
    text: string,
  ): SessionMessage => ({
    type,
    uuid: `72000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: type,
      content: type === "user" ? text : [{ type: "text", text }],
      ...(type === "assistant"
        ? { usage: { input_tokens: 0, output_tokens: 0 } }
        : {}),
    },
  });
  const initialMessages = Array.from({ length: 12 }, (_, index) => [
    nativeMessage("user", index * 2 + 1, `prompt ${index}`),
    nativeMessage("assistant", index * 2 + 2, `answer ${index}`),
  ]).flat();

  it("locates a deep retained turn without rereading provider history", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), {
      initialMessages,
      resumeSession: true,
    });
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const all = await handle.history({ limit: 100 });
    const target = all.orderedBackendTurnIds[0]!;
    const candidates: string[] = [];

    const located = await handle.locateTurn({
      maximumTurnCandidates: 12,
      matchesBackendTurnId: (candidate) => {
        candidates.push(candidate);
        return candidate === target;
      },
    });

    expect(candidates).toHaveLength(12);
    expect(located).toMatchObject({
      status: "found",
      page: { orderedBackendTurnIds: [target] },
    });
    if (located.status !== "found") throw new Error("expected located turn");
    expect(located.page.previousCursor).toBeUndefined();
    expect(JSON.stringify(located.page.itemsById)).toContain("answer 0");
    expect(provider.sdk.getSessionMessages).not.toHaveBeenCalled();
    await handle.close();
  });

  it("applies a durable terminal receipt to the located singleton", async () => {
    const provider = fixture();
    const settings = repository();
    const { handle } = createHandle(provider, vi.fn(), {
      settings,
      initialMessages: [nativeMessage("user", 101, "unfinished")],
      resumeSession: true,
    });
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const target = established.snapshot.orderedBackendTurnIds[0]!;
    settings.writeTerminalReceipt(
      { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId },
      BINDING.applicationThreadId,
      {
        backendTurnId: target,
        status: "interrupted",
        providerTerminalReason: "cancelled",
        terminalAt: 2_000,
        now: 2_000,
      },
    );

    await expect(
      handle.locateTurn({
        maximumTurnCandidates: 1,
        matchesBackendTurnId: (candidate) => candidate === target,
      }),
    ).resolves.toMatchObject({
      status: "found",
      page: {
        turnsById: {
          [target]: { status: "interrupted", endedBy: "interrupted" },
        },
      },
    });
    await handle.close();
  });

  it("honors cancellation and closed-handle lifecycle fences", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), {
      initialMessages,
      resumeSession: true,
    });
    const rawEvents: BackendConversationEvent[] = [];
    handle.subscribe((event) => rawEvents.push(event));
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const controller = new AbortController();
    controller.abort(new Error("cancel lookup"));
    await expect(
      handle.locateTurn({
        maximumTurnCandidates: 1,
        matchesBackendTurnId: () => false,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancel lookup");
    await handle.close();
    expect(rawEvents).not.toContainEqual({
      type: "resnapshot_required",
      reason: "provider_handle_closed",
    });
    await expect(
      handle.locateTurn({
        maximumTurnCandidates: 1,
        matchesBackendTurnId: () => false,
      }),
    ).rejects.toMatchObject({ backendCode: "claude_handle_closed" });
  });
});

function persistEffectiveEvidence(settings: ClaudeThreadRepository) {
  const scope = {
    tenantId: BINDING.tenantId,
    principalId: BINDING.ownerPrincipalId,
  };
  let now = 10;
  return {
    onModelEvidence: (evidence: ClaudeModelEvidence) => {
      const current = settings.get(scope, BINDING.applicationThreadId);
      settings.confirmEffectiveModel(scope, BINDING.applicationThreadId, {
        expectedRevision: current.revision,
        model: evidence.model,
        queryGeneration: evidence.generation,
        now: now++,
      });
    },
    onEffortEvidence: (evidence: ClaudeEffortEvidence) => {
      const current = settings.get(scope, BINDING.applicationThreadId);
      settings.confirmEffectiveEffort(scope, BINDING.applicationThreadId, {
        expectedRevision: current.revision,
        effort: evidence.effort,
        queryGeneration: evidence.generation,
        now: now++,
      });
    },
    onPermissionModeEvidence: (evidence: ClaudePermissionModeEvidence) => {
      const current = settings.get(scope, BINDING.applicationThreadId);
      const recognized = isClaudePermissionMode(evidence.mode);
      settings.confirmEffectivePermissionMode(
        scope,
        BINDING.applicationThreadId,
        {
          expectedRevision: current.revision,
          permissionMode: recognized ? evidence.mode : null,
          classification: recognized ? "recognized" : "external_custom",
          queryGeneration: evidence.generation,
          now: now++,
        },
      );
    },
  };
}

describe("ClaudeConversationHandle", () => {
  it("publishes transient Claude operational notices without duplicating them", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    const notices: unknown[] = [];
    handle.subscribe((event) => {
      if (event.type === "notice") notices.push(event.notice);
    });
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const message = {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning" },
      uuid: "abababab-abab-4bab-8bab-abababababab",
      session_id: SESSION_ID,
    } as unknown as SDKMessage;

    provider.messages.push(message);
    provider.messages.push(message);

    await vi.waitFor(() => {
      expect(notices).toEqual([
        expect.objectContaining({
          id: "claude-notice:abababab-abab-4bab-8bab-abababababab",
          tone: "warning",
          message: {
            text: "Claude usage is approaching its current limit.",
          },
        }),
      ]);
    });
    await handle.close();
  });

  it("applies desired settings and accepts a submit only after its exact UUID is observed", async () => {
    const provider = fixture();
    const modelEvidence = vi.fn();
    const effortEvidence = vi.fn();
    const { handle, release } = createHandle(provider, vi.fn(), {
      onModelEvidence: modelEvidence,
      onEffortEvidence: effortEvidence,
    });
    const controller = new AbortController();
    const established = await handle.establishProjection({
      signal: controller.signal,
    });
    const events: SDKMessage[] = [];
    const projected: unknown[] = [];
    established.subscribeFromNext((event) => projected.push(event));

    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-a",
      source: { kind: "user" },
      reconciliationToken: "reconcile-a",
      text: COMMON_TASK_PROMPT,
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    expect(prompt.value).toMatchObject({ uuid: OPERATION_ID });
    const nativePrompt = (prompt.value as SDKUserMessage).message.content;
    expect(typeof nativePrompt).toBe("string");
    expect(nativePrompt).toBe(COMMON_TASK_PROMPT);
    provider.messages.push(prompt.value as SDKMessage);
    events.push(prompt.value as SDKMessage);

    await expect(submitted).resolves.toEqual({
      accepted: true,
      reconciliationToken: "reconcile-a",
      completionCorrelation: OPERATION_ID,
    });
    await expect(
      handle.submit({
        applicationOperationId: OPERATION_ID,
        mutationId: "mutation-a",
        source: { kind: "user" },
        reconciliationToken: "reconcile-a",
        text: renderTaskContextsForModel(
          [{ ...TASK_CONTEXT, revision: 4 }],
          "Explain this",
        ),
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    ).rejects.toMatchObject({
      backendCode: "claude_submission_replay_mismatch",
    });
    expect(provider.controls.setModel).toHaveBeenCalledWith("claude-sonnet-5");
    expect(provider.controls.applyFlagSettings).toHaveBeenCalledWith({
      effortLevel: "low",
    });
    expect(provider.controls.setPermissionMode).toHaveBeenCalledWith("default");
    expect(modelEvidence).toHaveBeenCalledTimes(1);
    expect(modelEvidence).toHaveBeenCalledWith({
      generation: 1,
      model: "claude-sonnet-5",
      source: "init",
    });
    expect(effortEvidence).toHaveBeenCalledWith({
      generation: 1,
      effort: "low",
      source: "setter",
    });
    expect(projected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ type: "turn_started" }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "run_state_changed",
            state: "running",
          }),
        }),
      ]),
    );

    const streamUuid = "33333333-3333-4333-8333-333333333333";
    provider.messages.push({
      type: "stream_event",
      uuid: streamUuid,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: {
          id: "msg-a",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
    } as unknown as SDKMessage);
    provider.messages.push({
      type: "stream_event",
      uuid: streamUuid,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    } as unknown as SDKMessage);
    provider.messages.push({
      type: "stream_event",
      uuid: streamUuid,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Do" },
      },
    } as unknown as SDKMessage);
    await vi.waitFor(() => {
      expect(projected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              type: "item_updated",
              item: expect.objectContaining({
                semanticKind: "assistant_message",
                status: "streaming",
                markdown: { text: "Do" },
              }),
            }),
          }),
        ]),
      );
    });

    provider.messages.push({
      type: "assistant",
      uuid: "34333333-3333-4333-8333-333333333333",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      timestamp: "2026-08-16T20:15:30.000Z",
      message: {
        id: "msg-a",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Do" }],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    } as unknown as SDKMessage);
    await vi.waitFor(async () => {
      const history = await handle.history({ limit: 10 });
      expect(history.turnsById[history.orderedBackendTurnIds[0]!]?.status).toBe(
        "in_progress",
      );
      const projectionEvents = projected as Array<{
        event: { type: string; item?: Record<string, any> };
      }>;
      const started = projectionEvents.find(
        ({ event }) =>
          event.type === "item_started" &&
          event.item?.semanticKind === "assistant_message",
      );
      const completed = projectionEvents.find(
        ({ event }) =>
          event.type === "item_completed" &&
          event.item?.semanticKind === "assistant_message" &&
          (event.item.markdown as { text?: string } | undefined)?.text === "Do",
      );
      expect(completed?.event.item?.backendItemId).toBe(
        started?.event.item?.backendItemId,
      );
    });
    provider.messages.push({
      type: "result",
      subtype: "success",
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      result: "Do",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {},
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 3,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
      },
      permission_denials: [],
      user_message_uuid: OPERATION_ID,
      uuid: "35333333-3333-4333-8333-333333333333",
      session_id: SESSION_ID,
    } as unknown as SDKMessage);
    provider.messages.push({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    });
    await vi.waitFor(async () => {
      expect(projected).toEqual(expect.arrayContaining([expect.objectContaining({event: expect.objectContaining({type: "turn_completed"})})]));
      expect(await handle.usage()).not.toHaveProperty("tokens");
    });
    const history = await handle.history({ limit: 10 });
    expect(history.orderedBackendTurnIds).toHaveLength(1);
    expect(history.turnsById[history.orderedBackendTurnIds[0]!]).toMatchObject({
      status: "completed",
      endedBy: "agent_settled",
    });
    expect(
      Object.values(history.itemsById).filter(
        ({ semanticKind }) => semanticKind === "assistant_message",
      ),
    ).toEqual([
      expect.objectContaining({
        semanticKind: "assistant_message",
        markdown: { text: "Do" },
        responsePhase: "final",
      }),
    ]);
    const completionEvents = projected as Array<{ event: BackendConversationEvent }>;
    const classifiedIndex = completionEvents.findIndex(({ event }) =>
      (event.type === "item_updated" || event.type === "item_completed") &&
      event.item.semanticKind === "assistant_message" && event.item.responsePhase === "final");
    const terminalIndex = completionEvents.findIndex(({ event }) => event.type === "turn_completed");
    expect(classifiedIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(classifiedIndex);
    expect(JSON.stringify(history.itemsById)).toContain(
      "Sedes Tasks selected for this message:",
    );

    await handle.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed when accumulated live text exceeds the complete message limit", async () => {
    const provider = fixture();
    const onError = vi.fn();
    const { handle, release } = createHandle(provider, vi.fn(), { onError });
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    provider.messages.push({
      type: "user", message: { role: "user", content: "prompt" },
      parent_tool_use_id: null, uuid: OPERATION_ID, session_id: SESSION_ID,
      origin: { kind: "human" },
    } as SDKMessage);
    const pushStream = (event: unknown) => provider.messages.push({
      type: "stream_event", uuid: crypto.randomUUID(), session_id: SESSION_ID,
      parent_tool_use_id: null, event,
    } as SDKMessage);
    pushStream({ type: "message_start", message: { id: "oversized-assistant" } });
    pushStream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "safe prefix" } });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "item_started", item: expect.objectContaining({ markdown: { text: "safe prefix" } }),
    })));
    pushStream({ type: "content_block_delta", index: 0, delta: {
      type: "text_delta", text: "x".repeat(16 * 1024 * 1024),
    } });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "claude_message_payload_too_large",
    })));
    expect(events).toContainEqual({ type: "resnapshot_required", reason: "provider_handle_closed" });
    expect(events.some((event) =>
      (event.type === "item_updated" || event.type === "item_completed") &&
      event.item.semanticKind === "assistant_message",
    )).toBe(false);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    await handle.close();
  });

  it("preserves long ordinary text through live deltas, terminal replacement, history and reattachment", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const prompt = "User 😀漢字\n".repeat(10_000);
    const prefix = "Starting text\n".repeat(2_000);
    const delta = "Assistant 😀漢字 e\u0301\n".repeat(40_000);
    const streamed = prefix + delta;
    const finalText = streamed + "\nExact final suffix.";
    expect(prefix.length).toBeGreaterThan(16_384);
    expect(streamed.length).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(streamed)).toBeGreaterThan(512 * 1024);
    const nativeUser = {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      uuid: OPERATION_ID,
      session_id: SESSION_ID,
      origin: { kind: "human" },
    } as SDKMessage;
    provider.messages.push(nativeUser);
    const pushStream = (event: unknown) => provider.messages.push({
      type: "stream_event",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      event,
    } as SDKMessage);
    pushStream({ type: "message_start", message: { id: "long-assistant" } });
    pushStream({ type: "content_block_start", index: 0, content_block: { type: "text", text: prefix } });
    pushStream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } });
    await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "item_started", item: expect.objectContaining({ markdown: { text: prefix } }) }),
      expect.objectContaining({ type: "item_updated", item: expect.objectContaining({ markdown: { text: streamed } }) }),
    ])));
    const started = events.find((event) => event.type === "item_started" && event.item.semanticKind === "assistant_message");
    if (started?.type !== "item_started") throw new Error("missing live item");
    const liveItemId = started.item.backendItemId;
    const nativeAssistant = {
      type: "assistant",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        id: "long-assistant",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: finalText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as SDKMessage;
    provider.messages.push(nativeAssistant);
    await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "item_completed",
        item: expect.objectContaining({ backendItemId: liveItemId, markdown: { text: finalText } }),
      }),
    ])));
    const history = await handle.history({ limit: 10 });
    expect(history.itemsById[liveItemId]).toMatchObject({ markdown: { text: finalText } });
    expect(Object.values(history.itemsById).find((item) => item.semanticKind === "user_message")).toMatchObject({
      content: [{ kind: "text", text: { text: prompt } }],
    });
    await handle.close();
    const replacement = createHandle(fixture(), vi.fn(), {
      initialMessages: [nativeUser, nativeAssistant].map((message) => ({
        ...message,
        parent_agent_id: null,
      })) as SessionMessage[],
    }).handle;
    const reattached = await replacement.establishProjection({ signal: new AbortController().signal });
    expect(reattached.snapshot.itemsById[liveItemId]).toMatchObject({ markdown: { text: finalText } });
    expect(Object.values(reattached.snapshot.itemsById).find((item) => item.semanticKind === "user_message")).toMatchObject({
      content: [{ kind: "text", text: { text: prompt } }],
    });
    await replacement.close();
  });

  it("orders each later streamed assistant segment after durable items in the active turn", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: Array<{
      event: {
        type: string;
        state?: string;
        item?: {
          backendItemId: string;
          semanticKind: string;
          sourceOrder: number;
          markdown?: { text: string };
        };
      };
    }> = [];
    established.subscribeFromNext((event) => events.push(event as never));
    provider.messages.push({
      type: "user",
      message: { role: "user", content: "Inspect and continue." },
      parent_tool_use_id: null,
      uuid: OPERATION_ID,
      session_id: SESSION_ID,
      origin: { kind: "human" },
    });

    const pushPartial = (
      messageId: string,
      blocks: readonly {
        readonly type: "text" | "thinking";
        readonly text: string;
      }[],
    ) => {
      const streamUuid = crypto.randomUUID();
      provider.messages.push({
        type: "stream_event",
        uuid: streamUuid,
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      } as unknown as SDKMessage);
      for (const [index, block] of blocks.entries()) {
        provider.messages.push({
          type: "stream_event",
          uuid: streamUuid,
          session_id: SESSION_ID,
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index,
            content_block:
              block.type === "text"
                ? { type: "text", text: "" }
                : { type: "thinking", thinking: "", signature: "" },
          },
        } as unknown as SDKMessage);
        provider.messages.push({
          type: "stream_event",
          uuid: streamUuid,
          session_id: SESSION_ID,
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index,
            delta:
              block.type === "text"
                ? { type: "text_delta", text: block.text }
                : { type: "thinking_delta", thinking: block.text },
          },
        } as unknown as SDKMessage);
      }
      provider.messages.push({
        type: "stream_event",
        uuid: streamUuid,
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        event: { type: "message_stop" },
      } as unknown as SDKMessage);
    };
    const pushDurable = (messageId: string, content: readonly unknown[]) => {
      provider.messages.push({
        type: "assistant",
        uuid: crypto.randomUUID(),
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        timestamp: "2026-08-23T23:00:00.000Z",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      } as unknown as SDKMessage);
    };

    pushPartial("msg-first", [
      { type: "thinking", text: "Consider the file." },
      { type: "text", text: "First segment" },
    ]);
    pushDurable("msg-first", [
      {
        type: "thinking",
        thinking: "Consider the file.",
        signature: "signature",
      },
      { type: "text", text: "First segment" },
      {
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: { file_path: "/workspace/example.ts" },
      },
    ]);
    await vi.waitFor(async () => {
      expect(JSON.stringify(await handle.history({ limit: 10 }))).toContain(
        "First segment",
      );
    });
    provider.messages.push({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    });
    await vi.waitFor(() => {
      expect(
        events.filter(({ event }) => event.type === "run_state_changed").at(-1)
          ?.event.state,
      ).toBe("running");
    });
    provider.messages.push({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "export const example = true;",
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
      origin: { kind: "human" },
    } as unknown as SDKMessage);

    pushPartial("msg-second", [{ type: "text", text: "Second segment" }]);
    await vi.waitFor(() => {
      expect(
        events.some(
          ({ event }) =>
            event.type === "item_updated" &&
            event.item?.markdown?.text === "Second segment",
        ),
      ).toBe(true);
    });
    const first = events.find(
      ({ event }) =>
        event.type === "item_completed" &&
        event.item?.markdown?.text === "First segment",
    )!.event.item!;
    const secondStreaming = [...events]
      .reverse()
      .find(
        ({ event }) =>
          event.type === "item_updated" &&
          event.item?.markdown?.text === "Second segment",
      )!.event.item!;
    expect(secondStreaming.sourceOrder).toBeGreaterThan(first.sourceOrder);
    const tool = [...events]
      .reverse()
      .find(
        ({ event }) =>
          event.type === "item_completed" &&
          event.item?.semanticKind === "file_read",
      )!.event.item!;
    expect(secondStreaming.sourceOrder).toBeGreaterThan(tool.sourceOrder);

    pushDurable("msg-second", [{ type: "text", text: "Second segment" }]);
    await vi.waitFor(() => {
      const secondCompleted = events.find(
        ({ event }) =>
          event.type === "item_completed" &&
          event.item?.markdown?.text === "Second segment",
      )?.event.item;
      expect(secondCompleted).toMatchObject({
        backendItemId: secondStreaming.backendItemId,
        sourceOrder: secondStreaming.sourceOrder,
      });
    });
    await handle.close();
  });

  it("delivers one selected skill with authenticated file, native image, and context", async () => {
    const provider = fixture({ safeSkill: true });
    const { handle } = createHandle(provider);
    await handle.establishProjection({ signal: new AbortController().signal });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      composerAttachments: { fileStaging: true, nativeImage: true },
    });

    const bytes = Buffer.alloc(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
    bytes.writeUInt32BE(1, 16);
    bytes.writeUInt32BE(1, 20);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const imageAttachment = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "image" as const,
      fileName: "diagram.png",
      mediaType: "image/png" as const,
      byteSize: bytes.byteLength,
      sha256,
      agentPath: "/workspace/.sedes-attachments/diagram.png",
    };
    const fileAttachment = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      kind: "file" as const,
      fileName: "notes.txt",
      mediaType: "application/octet-stream" as const,
      byteSize: 12,
      sha256: createHash("sha256").update("file contents").digest("hex"),
      agentPath: "/workspace/.sedes-attachments/notes.txt",
    };
    const contextExcerpt = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      excerpt: "Keep the image comparison exact.",
      note: "Review this constraint.",
      source: {
        kind: "conversation_message" as const,
        itemId: "message-item-1",
        itemRevision: 2,
      },
      locator: {
        kind: "text_quote" as const,
        prefix: "Before. ",
        suffix: " After.",
      },
    };
    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-image",
      source: { kind: "user" },
      reconciliationToken: "reconcile-image",
      text: "Inspect the diagram.",
      selectedSkillId: claudeSkillId("review"),
      contextExcerpts: [contextExcerpt],
      taskContexts: [],
      attachments: [fileAttachment, imageAttachment],
      attachmentBytes: { read: vi.fn(async () => bytes) },
      attachmentEvidence: {
        resolve: () => [
          {
            id: fileAttachment.id,
            kind: fileAttachment.kind,
            fileName: fileAttachment.fileName,
            mediaType: fileAttachment.mediaType,
            byteSize: fileAttachment.byteSize,
            sha256: fileAttachment.sha256,
          },
          {
            id: imageAttachment.id,
            kind: imageAttachment.kind,
            fileName: imageAttachment.fileName,
            mediaType: imageAttachment.mediaType,
            byteSize: imageAttachment.byteSize,
            sha256: imageAttachment.sha256,
          },
        ],
      },
    });
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    const content = (prompt.value as SDKUserMessage).message.content;
    expect(content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("<sedes-staged-attachments"),
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: bytes.toString("base64"),
        },
      },
    ]);
    expect(JSON.stringify(content)).toContain("Inspect the diagram.");
    const providerText = (content as Array<{ text?: string }>)[0]?.text;
    expect(providerText).toMatch(/^\/review <sedes-staged-attachments/u);
    expect(providerText).toContain('<sedes-context-excerpts version="2">');
    expect(providerText).toContain("Keep the image comparison exact.");
    provider.messages.push(prompt.value as SDKMessage);
    await expect(submitted).resolves.toMatchObject({ accepted: true });
    const history = await handle.history({ limit: 10 });
    const userItem = Object.values(history.itemsById).find(
      (item) => item.semanticKind === "user_message",
    );
    expect(userItem).toMatchObject({
      semanticKind: "user_message",
      content: [
        { kind: "skill", name: { text: "review" } },
        { kind: "attachment", attachment: { id: fileAttachment.id } },
        { kind: "attachment", attachment: { id: imageAttachment.id } },
        { kind: "context_excerpt", excerpt: contextExcerpt },
        { kind: "text", text: { text: "Inspect the diagram." } },
      ],
    });
    expect(
      userItem?.semanticKind === "user_message" ? userItem.content : [],
    ).not.toContainEqual({ kind: "image", omitted: true });
    await handle.close();
  });

  it("submits and projects a task after an authenticated native-fork boundary", async () => {
    const provider = fixture();
    const authentication = {
      installationKey: new Uint8Array(32).fill(7),
      tenantId: BINDING.tenantId,
      principalId: BINDING.ownerPrincipalId,
      backendInstanceId: BINDING.backendInstanceId,
    };
    const boundaryOperationId = "44444444-4444-4444-8444-444444444444";
    const boundary = {
      type: "user" as const,
      uuid: "55555555-5555-4555-8555-555555555555",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: "user" as const,
        content: claudeForkContextBoundaryText(
          boundaryOperationId,
          USER_FORK_CONTEXT_BOUNDARY,
          authentication,
        ),
      },
    } satisfies SessionMessage;
    const { handle } = createHandle(provider, vi.fn(), {
      initialMessages: [boundary],
      resumeSession: true,
    });
    await handle.establishProjection({ signal: new AbortController().signal });

    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-after-fork",
      source: { kind: "user" },
      reconciliationToken: "reconcile-after-fork",
      text: renderTaskContextsForModel(
        [TASK_CONTEXT],
        "Continue from the fork.",
      ),
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    expect(String((prompt.value as SDKUserMessage).message.content)).toBe(
      renderTaskContextsForModel([TASK_CONTEXT], "Continue from the fork."),
    );
    provider.messages.push(prompt.value as SDKMessage);
    await expect(submitted).resolves.toMatchObject({ accepted: true });

    const history = await handle.history({ limit: 10 });
    expect(history.orderedBackendTurnIds).toHaveLength(1);
    expect(JSON.stringify(history.itemsById)).toContain(
      "Sedes Tasks selected for this message:",
    );
    expect(JSON.stringify(history.itemsById)).not.toContain(
      "sedes-task-contexts",
    );
    await handle.close();
  });

  it("keeps local history usable after an oversized older whole-turn page", async () => {
    const nativeMessage = (
      type: "user" | "assistant",
      index: number,
      text: string,
    ): SessionMessage => ({
      type,
      uuid: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: type,
        content: type === "user" ? text : [{ type: "text", text }],
        ...(type === "assistant"
          ? { usage: { input_tokens: 0, output_tokens: 0 } }
          : {}),
      },
    });
    const largeTurn = [
      nativeMessage("user", 1, "large older turn"),
      ...Array.from({ length: 1_100 }, (_, index) =>
        nativeMessage("assistant", index + 2, "x".repeat(65_536)),
      ),
    ];
    const recentTurns = Array.from({ length: 10 }, (_, index) => [
      nativeMessage("user", 10_000 + index * 2, `recent ${index}`),
      nativeMessage("assistant", 10_001 + index * 2, `answer ${index}`),
    ]).flat();
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), {
      initialMessages: [...largeTurn, ...recentTurns],
      resumeSession: true,
    });
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(established.history.previousCursor).toBeTypeOf("string");
    await expect(
      handle.history({
        cursor: established.history.previousCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      backendCode: "history_too_large",
      retryable: true,
    });
    await expect(handle.history({ limit: 10 })).resolves.toMatchObject({
      orderedBackendTurnIds: expect.any(Array),
    });
    expect(provider.sdk.getSessionMessages).not.toHaveBeenCalled();
    await handle.close();
  });

  it("keeps an issued local history boundary stable across live appends", async () => {
    const nativeMessage = (
      type: "user" | "assistant",
      index: number,
      text: string,
    ): SessionMessage =>
      ({
        type,
        uuid: `71000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          role: type,
          content: type === "user" ? text : [{ type: "text", text }],
          ...(type === "assistant"
            ? { usage: { input_tokens: 0, output_tokens: 0 } }
            : {}),
        },
      }) as SessionMessage;
    const initialMessages = Array.from({ length: 13 }, (_, index) => [
      nativeMessage("user", index * 2 + 1, `prompt ${index}`),
      nativeMessage("assistant", index * 2 + 2, `answer ${index}`),
    ]).flat();
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), {
      initialMessages,
      resumeSession: true,
    });
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const cursor = established.history.previousCursor;
    expect(cursor).toBeTypeOf("string");

    provider.messages.push(
      nativeMessage("user", 100, "appended prompt") as SDKMessage,
    );
    provider.messages.push(
      nativeMessage("assistant", 101, "appended answer") as SDKMessage,
    );
    await vi.waitFor(async () => {
      const latest = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(JSON.stringify(latest.snapshot)).toContain("appended answer");
    });

    const older = await handle.history({ cursor, limit: 3 });
    expect(older.orderedBackendTurnIds).toHaveLength(3);
    expect(JSON.stringify(older)).toContain("prompt 0");
    expect(JSON.stringify(older)).not.toContain("appended answer");
    await handle.close();
  });

  it("keeps the live handle healthy when the current turn exceeds the transfer window", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), {
      initialMessages: [],
      resumeSession: true,
    });
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    provider.messages.push({
      type: "user",
      uuid: "70000000-0000-4000-8000-000000030001",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { role: "user", content: "large live turn" },
    } as unknown as SDKMessage);
    provider.messages.push({
      type: "assistant",
      uuid: "70000000-0000-4000-8000-000000030002",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: "assistant",
        content: Array.from({ length: 1_100 }, (_, index) => ({
          type: "text",
          text: `${index}:`.padEnd(65_536, "x"),
        })),
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } as unknown as SDKMessage);

    let refreshed!: Awaited<ReturnType<typeof handle.establishProjection>>;
    await vi.waitFor(
      async () => {
        refreshed = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        expect(JSON.stringify(refreshed.snapshot)).toContain(
          "oversized current turn",
        );
      },
      { timeout: 10_000 },
    );
    expect(JSON.stringify(refreshed.snapshot)).toContain(
      "oversized current turn",
    );
    expect(provider.controls.close).not.toHaveBeenCalled();
    await handle.close();
  });

  it("launches the durable mode, enables allowlisted bypass, and reports ordered permission evidence", async () => {
    const provider = fixture();
    const evidence = vi.fn();
    const generationLost = vi.fn();
    const { handle } = createHandle(provider, vi.fn(), {
      allowDangerouslySkipPermissions: true,
      onPermissionModeEvidence: evidence,
      onQueryGenerationLost: generationLost,
    });
    await handle.establishProjection({ signal: new AbortController().signal });

    expect(provider.options()).toMatchObject({
      permissionMode: "default",
      allowDangerouslySkipPermissions: true,
      canUseTool: expect.any(Function),
    });
    expect(evidence).toHaveBeenCalledWith({
      generation: 1,
      mode: "default",
      source: "init",
    });

    provider.messages.push({
      type: "system",
      subtype: "status",
      status: null,
      permissionMode: "acceptEdits",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    });
    await vi.waitFor(() => {
      expect(evidence).toHaveBeenLastCalledWith({
        generation: 1,
        mode: "acceptEdits",
        source: "status",
      });
    });
    await handle.close();
    expect(generationLost).toHaveBeenCalledWith(1);
  });

  it("omits a revoked durable mode on attach so the thread can recover", async () => {
    const provider = fixture();
    const settings = repository();
    settings.updateDesired(
      { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId },
      BINDING.applicationThreadId,
      {
        expectedRevision: settings.get(
          { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId },
          BINDING.applicationThreadId,
        ).revision,
        desired: {
          model: "claude-sonnet-5",
          effort: "low",
          permissionMode: "bypassPermissions",
        },
        now: 5,
      },
    );
    const { handle } = createHandle(provider, vi.fn(), {
      settings,
      permissionPolicy: { allowedModes: ["default"] },
    });

    await handle.establishProjection({ signal: new AbortController().signal });

    expect(provider.options()).not.toHaveProperty("permissionMode");
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      deliveryModes: [],
      branching: {
        availability: "unavailable",
        reason: {
          text: "The selected Claude permission mode is no longer allowed.",
        },
      },
    });
    await handle.close();
  });

  it("attaches an unresolved imported thread without advertising delivery or branching", async () => {
    const provider = fixture();
    const settings = repository();
    settings.database
      .prepare(
        `
      UPDATE claude_thread_settings
      SET desired_permission_mode = NULL,
        effective_permission_mode = NULL,
        effective_permission_classification = NULL,
        effective_permission_state = 'unconfirmed',
        effective_permission_generation = NULL
    `,
      )
      .run();
    const { handle } = createHandle(provider, vi.fn(), { settings });
    await handle.establishProjection({ signal: new AbortController().signal });

    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      deliveryModes: [],
      branching: {
        availability: "unavailable",
        reason: {
          text: "Select a Claude permission mode before sending or branching.",
        },
      },
    });
    await expect(
      handle.submit({
        applicationOperationId: OPERATION_ID,
        mutationId: "mutation-unresolved",
        source: { kind: "user" },
        reconciliationToken: "reconcile-unresolved",
        text: "Do not send",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    ).rejects.toMatchObject({
      backendCode: "claude_permission_mode_unresolved",
      crossedSubmissionBoundary: false,
    });
    await handle.close();
  });

  it("allows submit to reconfirm an unknown tuple while withholding branching", async () => {
    const provider = fixture();
    const settings = repository();
    const { handle } = createHandle(provider, vi.fn(), {
      settings,
      ...persistEffectiveEvidence(settings),
    });
    await handle.establishProjection({ signal: new AbortController().signal });
    settings.markEffectiveUnknown(
      { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId },
      BINDING.applicationThreadId,
      {
        expectedRevision: settings.get(
          { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId },
          BINDING.applicationThreadId,
        ).revision,
        now: 5,
      },
    );

    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      deliveryModes: ["submit"],
      branching: {
        availability: "unavailable",
        reason: {
          text: "Claude has not confirmed the complete execution settings for this session.",
        },
      },
    });
    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-unconfirmed",
      source: { kind: "user" },
      reconciliationToken: "reconcile-unconfirmed",
      text: "Reconfirm and send",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push(prompt.value as SDKMessage);
    await expect(submitted).resolves.toMatchObject({ accepted: true });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      deliveryModes: ["submit", "steer"],
      branching: { availability: "available" },
    });
    await handle.close();
  });

  it("advertises submit and native branching only for the exact confirmed current-generation tuple", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    await handle.establishProjection({ signal: new AbortController().signal });

    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      deliveryModes: ["submit", "steer"],
      branching: { availability: "available" },
    });
    await handle.close();
  });

  it("marks the failed effective axis unknown after an uncertain settings apply", async () => {
    const provider = fixture();
    const axisUnknown = vi.fn();
    provider.controls.setPermissionMode.mockRejectedValueOnce(
      new Error("control response lost"),
    );
    const { handle } = createHandle(provider, vi.fn(), {
      onEffectiveAxisUnknown: axisUnknown,
    });
    await handle.establishProjection({ signal: new AbortController().signal });

    await expect(
      handle.submit({
        applicationOperationId: OPERATION_ID,
        mutationId: "mutation-settings-failed",
        source: { kind: "user" },
        reconciliationToken: "reconcile-settings-failed",
        text: "Do not send",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(axisUnknown).toHaveBeenCalledWith(1, "permission");
    await handle.close();
  });

  it("accepts the SDK's exact result user-message receipt when no user frame is echoed", async () => {
    const provider = fixture();
    const onError = vi.fn();
    const { handle } = createHandle(provider, vi.fn(), { onError });
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-a",
      source: { kind: "user" },
      reconciliationToken: "reconcile-a",
      text: "Acknowledge from the result",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push({
      type: "result",
      subtype: "success",
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      user_message_uuid: OPERATION_ID,
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    } as unknown as SDKMessage);

    await expect(submitted).resolves.toMatchObject({
      accepted: true,
      completionCorrelation: OPERATION_ID,
    });
    expect(onError).not.toHaveBeenCalled();
    const history = await handle.history({ limit: 10 });
    const turnId = history.orderedBackendTurnIds.at(-1)!;
    expect(history.turnsById[turnId]).toMatchObject({
      status: "completed",
      endedBy: "agent_settled",
      completionCorrelations: [OPERATION_ID],
    });
    await handle.close();
  });

  it("does not accept or materialize a result correlated to another user message", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-a",
      source: { kind: "user" },
      reconciliationToken: "reconcile-a",
      text: "Do not accept another operation's result",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push({
      type: "result",
      subtype: "success",
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      result: "unrelated",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      user_message_uuid: "77777777-7777-4777-8777-777777777777",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    } as unknown as SDKMessage);

    await vi.waitFor(async () => {
      expect(
        (await handle.history({ limit: 10 })).orderedBackendTurnIds,
      ).toEqual([]);
    });
    await handle.close();
    await expect(submitted).rejects.toMatchObject({
      crossedSubmissionBoundary: true,
    });
  });

  it.each(["success", "error_during_execution"] as const)(
    "preserves the foreground turn across background receipts before a legitimate zero-turn %s",
    async (subtype) => {
      const provider = fixture();
      const { handle, settings } = createHandle(provider);
      await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const submitted = handle.submit({
        applicationOperationId: OPERATION_ID,
        mutationId: "background-receipts",
        source: { kind: "user" },
        reconciliationToken: "background-receipts",
        text: "Keep this foreground turn running",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      });
      const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
      provider.messages.push(prompt.value as SDKMessage);
      await submitted;
      const history = await handle.history({ limit: 10 });
      const turnId = history.orderedBackendTurnIds.at(-1)!;
      const writeTerminal = vi.spyOn(settings, "writeTerminalReceipt");
      const result = (overrides: Record<string, unknown>): SDKMessage =>
        ({
          type: "result",
          subtype: "success",
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: false,
          num_turns: 0,
          result: "",
          stop_reason: null,
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: crypto.randomUUID(),
          session_id: SESSION_ID,
          ...overrides,
        }) as unknown as SDKMessage;
      provider.messages.push(
        result({ origin: { kind: "task-notification" }, result_index: 1 }),
      );
      for (const metadata of [
        { stop_reason: "end_turn" },
        { terminal_reason: "completed" },
        { stop_reason: "end_turn", terminal_reason: "completed" },
      ]) {
        provider.messages.push(
          result({ origin: { kind: "task-notification" }, ...metadata }),
        );
      }
      provider.messages.push(
        result({
          user_message_uuid: crypto.randomUUID(),
          num_turns: 1,
          result: "Another queued task",
        }),
      );
      // This later assistant frame provides a deterministic consumption barrier.
      provider.messages.push({
        type: "assistant",
        uuid: crypto.randomUUID(),
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        message: {
          id: "foreground-answer",
          role: "assistant",
          stop_reason: null,
          content: [{ type: "text", text: "Foreground still working" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      } as unknown as SDKMessage);
      await vi.waitFor(async () => {
        expect(JSON.stringify(await handle.history({ limit: 10 }))).toContain(
          "Foreground still working",
        );
      });
      expect(writeTerminal).not.toHaveBeenCalled();
      expect(
        (await handle.history({ limit: 10 })).turnsById[turnId]!.status,
      ).toBe("in_progress");
      provider.messages.push(
        result({
          subtype,
          is_error: subtype !== "success",
          errors: ["foreground failed"],
          user_message_uuid: OPERATION_ID,
          result_index: 3,
        }),
      );
      await vi.waitFor(() => expect(writeTerminal).toHaveBeenCalledOnce());
      expect(writeTerminal).toHaveBeenCalledWith(
        expect.anything(),
        BINDING.applicationThreadId,
        expect.objectContaining({
          backendTurnId: turnId,
          status: subtype === "success" ? "completed" : "failed",
        }),
      );
      await handle.close();
    },
  );

  it("materializes a pending user before an assistant frame when Claude emits no running state", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-a",
      source: { kind: "user" },
      reconciliationToken: "reconcile-a",
      text: "Project the answer without a user echo",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push({
      type: "assistant",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        id: "msg-no-running-state",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Done without a running frame" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    } as unknown as SDKMessage);

    await expect(submitted).resolves.toMatchObject({
      accepted: true,
      completionCorrelation: OPERATION_ID,
    });
    await vi.waitFor(async () => {
      const history = await handle.history({ limit: 10 });
      const turnId = history.orderedBackendTurnIds.at(-1)!;
      expect(history.turnsById[turnId]).toMatchObject({
        status: "completed",
        completionCorrelations: [OPERATION_ID],
      });
    });
    await handle.close();
  });

  it("materializes the exact pending user UUID from Claude's authoritative running state", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-a",
      source: { kind: "user" },
      reconciliationToken: "reconcile-a",
      text: "Materialize the live turn",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push({
      type: "system",
      subtype: "session_state_changed",
      state: "running",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    });

    await expect(submitted).resolves.toMatchObject({
      accepted: true,
      completionCorrelation: OPERATION_ID,
    });
    await vi.waitFor(async () => {
      const history = await handle.history({ limit: 10 });
      const turnId = history.orderedBackendTurnIds.at(-1)!;
      expect(history.turnsById[turnId]).toMatchObject({
        status: "in_progress",
        completionCorrelations: [OPERATION_ID],
      });
    });
    await handle.close();
  });

  it("interrupts only the exact active turn and fails closed for unsupported actions", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    let activeTurnId: string | undefined;
    established.subscribeFromNext(({ event }) => {
      if (event.type === "turn_started")
        activeTurnId = event.turn.backendTurnId;
    });
    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-a",
      source: { kind: "user" },
      reconciliationToken: "reconcile-a",
      text: "Keep working",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push(prompt.value as SDKMessage);
    await submitted;
    expect(activeTurnId).toBeTruthy();
    await handle.interrupt({
      applicationOperationId: "44444444-4444-4444-8444-444444444444",
      expectedBackendTurnId: activeTurnId!,
    });
    expect(provider.controls.interrupt).toHaveBeenCalledOnce();
    await expect(
      handle.steer({
        applicationOperationId: "55555555-5555-4555-8555-555555555555",
        mutationId: "mutation-b",
        reconciliationToken: "reconcile-b",
        target: { kind: "turn", turnId: activeTurnId! },
        text: "change",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    ).rejects.toMatchObject({ backendCode: "claude_steer_target_invalid" });
    await expect(
      handle.perform({
        applicationOperationId: "66666666-6666-4666-8666-666666666666",
        action: "compact",
      }),
    ).rejects.toBeInstanceOf(BackendError);
    await handle.close();
  });

  it("applies a newly desired tuple before crossing the submission boundary", async () => {
    const provider = fixture();
    const settings = repository();
    const { handle } = createHandle(provider, vi.fn(), {
      settings,
      allowDangerouslySkipPermissions: true,
      ...persistEffectiveEvidence(settings),
    });
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    settings.updateDesired(
      { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId },
      BINDING.applicationThreadId,
      {
        expectedRevision: settings.get(
          { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId },
          BINDING.applicationThreadId,
        ).revision,
        desired: {
          model: "claude-opus-5",
          effort: "high",
          permissionMode: "bypassPermissions",
        },
        now: 5,
      },
    );
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      deliveryModes: ["submit"],
      branching: { availability: "unavailable" },
      effectiveSettings: {
        model: { id: "claude-sonnet-5" },
        thinkingLevel: "low",
      },
    });
    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-a",
      source: { kind: "user" },
      reconciliationToken: "reconcile-a",
      text: "Do work",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push(prompt.value as SDKMessage);
    await expect(submitted).resolves.toMatchObject({ accepted: true });

    const afterApply = await handle.backendCapabilities();
    expect(afterApply).toMatchObject({
      deliveryModes: ["submit", "steer"],
      branching: { availability: "available" },
      effectiveSettings: {
        model: { id: "claude-opus-5" },
        thinkingLevel: "high",
      },
    });
    expect(provider.controls.setModel).toHaveBeenLastCalledWith(
      "claude-opus-5",
    );
    expect(provider.controls.setPermissionMode).toHaveBeenLastCalledWith(
      "bypassPermissions",
    );
    expect(provider.controls.applyFlagSettings).toHaveBeenLastCalledWith({
      effortLevel: "high",
    });
    await handle.close();
  });

  it("confirms the frozen tuple when live desired settings change during apply", async () => {
    const provider = fixture();
    let resolveModel!: () => void;
    provider.controls.setModel.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveModel = resolve;
      });
    });
    const settings = repository();
    const scope = {
      tenantId: BINDING.tenantId,
      principalId: BINDING.ownerPrincipalId,
    };
    const { handle } = createHandle(provider, vi.fn(), {
      settings,
      allowDangerouslySkipPermissions: true,
      ...persistEffectiveEvidence(settings),
    });
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    settings.updateDesired(scope, BINDING.applicationThreadId, {
      expectedRevision: settings.get(scope, BINDING.applicationThreadId)
        .revision,
      desired: {
        model: "claude-opus-5",
        effort: "high",
        permissionMode: "bypassPermissions",
      },
      now: 20,
    });

    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-frozen-settings",
      source: { kind: "user" },
      reconciliationToken: "reconcile-frozen-settings",
      text: "Use the admitted settings",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    await vi.waitFor(() => expect(resolveModel).toBeTypeOf("function"));
    settings.updateDesired(scope, BINDING.applicationThreadId, {
      expectedRevision: settings.get(scope, BINDING.applicationThreadId)
        .revision,
      desired: {
        model: "claude-sonnet-5",
        effort: "low",
        permissionMode: "default",
      },
      now: 21,
    });
    resolveModel();
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push(prompt.value as SDKMessage);

    await expect(submitted).resolves.toMatchObject({ accepted: true });
    expect(
      settings.findOperationSnapshot(scope, {
        applicationThreadId: BINDING.applicationThreadId,
        applicationOperationId: OPERATION_ID,
      }),
    ).toMatchObject({
      model: "claude-opus-5",
      effort: "high",
      permissionMode: "bypassPermissions",
    });
    expect(settings.get(scope, BINDING.applicationThreadId)).toMatchObject({
      model: "claude-sonnet-5",
      effort: "low",
      permissionMode: "default",
      effectiveModel: "claude-opus-5",
      effectiveEffort: "high",
      effectivePermissionMode: "bypassPermissions",
    });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      deliveryModes: ["submit"],
      branching: { availability: "unavailable" },
    });
    await handle.close();
  });

  it("reserves submission admission before awaiting provider settings controls", async () => {
    const provider = fixture();
    let resolveModel!: () => void;
    provider.controls.setModel.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveModel = resolve;
      });
      return undefined;
    });
    const { handle } = createHandle(provider);
    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    const first = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-first",
      source: { kind: "user" },
      reconciliationToken: "reconcile-first",
      text: "First prompt",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    await vi.waitFor(() => {
      expect(provider.controls.setModel).toHaveBeenCalledOnce();
    });
    await expect(
      handle.submit({
        applicationOperationId: "99999999-9999-4999-8999-999999999999",
        mutationId: "mutation-second",
        source: { kind: "user" },
        reconciliationToken: "reconcile-second",
        text: "Second prompt",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    ).rejects.toMatchObject({ backendCode: "claude_turn_already_active" });

    resolveModel();
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push(prompt.value as SDKMessage);
    await expect(first).resolves.toMatchObject({ accepted: true });
    await handle.close();
  });

  it.each(["error_during_execution", "success", "error_max_turns", "startup_failure", "multiline_diagnostic", "stack_only"])("retains failed terminal evidence after Claude's trailing idle signal (%s)", async (subtype) => {
    const expectedFailure = subtype === "error_max_turns" ? "Claude reached the configured turn limit."
      : subtype === "startup_failure" ? "Claude proxy configuration is invalid."
      : subtype === "stack_only" ? "The provider reported a failure but supplied no explanation."
      : "provider failed";
    const provider = fixture();
    const { handle, settings } = createHandle(provider);
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const projected: unknown[] = [];
    established.subscribeFromNext((event) => projected.push(event));
    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-a",
      source: { kind: "user" },
      reconciliationToken: "reconcile-a",
      text: "Fail safely",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push(prompt.value as SDKMessage);
    await submitted;
    provider.messages.push({
      type: "result",
      subtype: ["startup_failure", "multiline_diagnostic", "stack_only"].includes(subtype) ? "error_during_execution" : subtype,
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: {},
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 11,
          outputTokens: 7,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          webSearchRequests: 0,
          costUSD: 0,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
      },
      permission_denials: [],
      ...(subtype === "success" ? { result: "provider failed" }
        : subtype === "startup_failure" ? { startup_failure_reason: "proxy_invalid", errors: ["private startup stderr that must not be retained"] }
        : subtype === "multiline_diagnostic" ? { errors: ["  at privateStack (/private/file:1:2)\nError:\nprovider failed\n  at otherPrivateStack (/private/other:3:4)", "second unrelated diagnostic"] }
        : subtype === "stack_only" ? { errors: ["Error:\n  at privateStack (/private/file:1:2)"] }
        : { errors: subtype === "error_max_turns" ? [] : ["provider failed"] }),
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    } as unknown as SDKMessage);
    provider.messages.push({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    });
    await vi.waitFor(async () => {
      expect(await handle.usage()).not.toHaveProperty("tokens");
      expect(projected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: { type: "run_state_changed", state: "failed" },
          }),
        ]),
      );
    });
    const history = await handle.history({ limit: 10 });
    expect(Object.values(history.turnsById)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", endedBy: "failed", failure: { message: { text: expectedFailure } } }),
      ]),
    );
    await expect(handle.captureSubmissionRetryAnchor()).resolves.toContain(
      '"version":1',
    );
    await handle.close();

    const persistedUser = {
      type: "user",
      uuid: OPERATION_ID,
      session_id: SESSION_ID,
      message: (prompt.value as SDKUserMessage).message,
      parent_tool_use_id: null,
      parent_agent_id: null,
    } satisfies SessionMessage;
    const reopenedProvider = fixture();
    const reopened = createHandle(reopenedProvider, vi.fn(), {
      settings,
      initialMessages: [persistedUser],
      resumeSession: true,
    }).handle;
    const recovered = await reopened.establishProjection({
      signal: new AbortController().signal,
    });
    const recoveredTurnId = recovered.snapshot.orderedBackendTurnIds.at(-1)!;
    expect(recovered.snapshot).toMatchObject({ runState: "failed" });
    expect(recovered.snapshot.turnsById[recoveredTurnId]).toMatchObject({
      status: "failed",
      endedBy: "failed",
      failure: { message: { text: expectedFailure } },
    });
    await reopened.close();
  });

  it.each(["aborted_streaming", "aborted_tools", "result_before_ack"])("persists a native interrupted turn with marker (%s)", async (scenario) => {
    const provider = fixture();
    const { handle, settings } = createHandle(provider);
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const runStates: string[] = [];
    const unsubscribe = handle.subscribe((event) => {
      if (event.type === "run_state_changed") runStates.push(event.state);
    });
    const submitted = handle.submit({
      applicationOperationId: OPERATION_ID,
      mutationId: "mutation-a",
      source: { kind: "user" },
      reconciliationToken: "reconcile-a",
      text: "Stop this turn",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
    });
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push(prompt.value as SDKMessage);
    await submitted;
    provider.messages.push({
      type: "assistant",
      uuid: "33333333-3333-4333-8333-333333333333",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-before-interrupt",
            name: "Read",
            input: { file_path: "/workspace/file.ts" },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as unknown as SDKMessage);
    await vi.waitFor(async () => {
      expect(
        Object.values((await handle.history({ limit: 10 })).itemsById),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            semanticKind: "file_read",
            status: "streaming",
          }),
        ]),
      );
    });
    const active = await handle.history({ limit: 10 });
    const backendTurnId = active.orderedBackendTurnIds.at(-1)!;
    let acknowledge!: () => void;
    if (scenario === "result_before_ack") provider.controls.interrupt.mockImplementationOnce(
      () => new Promise(resolve => { acknowledge = () => resolve({ still_queued: [] }); }),
    );
    const interrupt = handle.interrupt({
      applicationOperationId: "33333333-3333-4333-8333-333333333333",
      expectedBackendTurnId: backendTurnId,
    });
    if (scenario !== "result_before_ack") await interrupt;
    const marker = {
      type: "user" as const,
      uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as const,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      timestamp: "2026-09-17T07:16:01.463Z",
      message: { role: "user" as const, content: [{ type: "text" as const,
        text: scenario === "aborted_tools" ? "[Request interrupted by user for tool use]" : "[Request interrupted by user]" }] },
    };
    provider.messages.push(marker);
    provider.messages.push({
      type: "result",
      user_message_uuid: OPERATION_ID,
      user_message_uuids: [OPERATION_ID],
      subtype: "error_during_execution",
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: true,
      num_turns: 1,
      result: "",
      stop_reason: null,
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      terminal_reason: scenario === "aborted_tools" ? "aborted_tools" : "aborted_streaming",
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
    } as unknown as SDKMessage);
    await vi.waitFor(async () => {
      const history = await handle.history({ limit: 10 });
      expect(history.turnsById[backendTurnId]).toMatchObject({
        status: "interrupted",
        endedBy: "interrupted",
      });
      expect(Object.values(history.itemsById)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            semanticKind: "file_read",
            status: "interrupted",
            phase: "interrupted",
          }),
        ]),
      );
    });
    if (scenario === "result_before_ack") { acknowledge(); await interrupt; }
    expect(runStates.at(-1)).toBe("idle");
    const stopped = await handle.establishProjection({ signal: new AbortController().signal });
    expect(stopped.snapshot.runState).toBe("idle");
    expect(stopped.snapshot.activeBackendTurnId).toBeUndefined();
    expect(stopped.snapshot.orderedBackendTurnIds).toEqual([backendTurnId]);
    expect(JSON.stringify(stopped.snapshot)).not.toContain("[Request interrupted");
    provider.messages.push({
      type: "user",
      message: { role: "user", content: "A later external prompt" },
      parent_tool_use_id: null,
      uuid: "44444444-4444-4444-8444-444444444444",
      session_id: SESSION_ID,
      origin: { kind: "human" },
    });
    provider.messages.push({
      type: "assistant",
      uuid: "55555555-5555-4555-8555-555555555555",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Later response" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as unknown as SDKMessage);
    await vi.waitFor(async () => {
      const history = await handle.history({ limit: 10 });
      expect(history.turnsById[backendTurnId]).toMatchObject({
        status: "interrupted",
        endedBy: "interrupted",
      });
      expect(Object.values(history.itemsById)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            semanticKind: "file_read",
            status: "interrupted",
            phase: "interrupted",
          }),
        ]),
      );
    });
    unsubscribe();
    await handle.close();

    const persistedUser = {
      type: "user",
      uuid: OPERATION_ID,
      session_id: SESSION_ID,
      message: (prompt.value as SDKUserMessage).message,
      parent_tool_use_id: null,
      parent_agent_id: null,
    } satisfies SessionMessage;
    const reopenedProvider = fixture();
    const reopened = createHandle(reopenedProvider, vi.fn(), {
      settings,
      initialMessages: [persistedUser, { ...marker, parent_agent_id: null }],
      resumeSession: true,
    }).handle;
    const recovered = await reopened.establishProjection({
      signal: new AbortController().signal,
    });
    expect(recovered.snapshot.runState).toBe("idle");
    expect(recovered.snapshot.turnsById[backendTurnId]).toMatchObject({
      status: "interrupted",
      endedBy: "interrupted",
    });
    await reopened.close();
  });

  it("terminates an attached query when action metadata changes native session", async () => {
    const provider = fixture();
    (provider.sdk as ClaudeSdkFacade).getSessionInfo = vi.fn(async () => ({
      sessionId: "99999999-9999-4999-8999-999999999999",
      summary: "Foreign session",
      lastModified: Date.now(),
      cwd: "/workspace",
    }));
    const release = vi.fn();
    const { handle } = createHandle(provider, release);
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    await expect(
      handle.reconcileAction({
        action: "rename",
        applicationOperationId: "77777777-7777-4777-8777-777777777777",
        title: "Expected title",
      }),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "claude_session_identity_mismatch",
    });
    await vi.waitFor(() => {
      expect(provider.controls.close).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    });
    await handle.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it("invalidates the handle and pending interaction on live session identity drift", async () => {
    const initialMessage = {
      type: "user",
      message: { role: "user", content: "Valid bound history" },
      parent_tool_use_id: null,
      parent_agent_id: null,
      uuid: OPERATION_ID,
      session_id: SESSION_ID,
    } satisfies SessionMessage;
    const provider = fixture();
    const release = vi.fn();
    const { handle } = createHandle(provider, release, {
      initialMessages: [initialMessage],
      resumeSession: true,
    });
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(1);
    const events: unknown[] = [];
    established.subscribeFromNext((event) => events.push(event));
    const canUseTool = provider.options().canUseTool;
    if (!canUseTool) throw new Error("permission_callback_missing");
    const pendingPermission = canUseTool(
      "Read",
      {},
      {
        signal: new AbortController().signal,
        requestId: "request-session-drift",
        toolUseID: "tool-session-drift",
      },
    );

    provider.messages.push({
      type: "assistant",
      uuid: "88888888-8888-4888-8888-888888888888",
      session_id: "99999999-9999-4999-8999-999999999999",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Foreign transcript content" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as unknown as SDKMessage);

    await expect(pendingPermission).resolves.toMatchObject({
      behavior: "deny",
    });
    await vi.waitFor(() => {
      expect(provider.controls.close).toHaveBeenCalledOnce();
      expect(provider.options().abortController?.signal.aborted).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    });
    expect(JSON.stringify(events)).not.toContain("Foreign transcript content");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: { type: "resnapshot_required", reason: "contradictory_state" },
        }),
        expect.objectContaining({
          event: { type: "run_state_changed", state: "disconnected" },
        }),
      ]),
    );
    await expect(handle.history({ limit: 10 })).rejects.toMatchObject({
      backendCode: "claude_projection_invalidated",
    });
    await handle.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it("terminates the handle and releases admission when the provider session ends", async () => {
    const provider = fixture();
    const release = vi.fn();
    const { handle } = createHandle(provider, release);
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const rawEvents: BackendConversationEvent[] = [];
    handle.subscribe((event) => rawEvents.push(event));
    const events: unknown[] = [];
    established.subscribeFromNext((event) => events.push(event));
    const canUseTool = provider.options().canUseTool;
    if (!canUseTool) throw new Error("permission_callback_missing");
    const pendingPermission = canUseTool(
      "Read",
      {},
      {
        signal: new AbortController().signal,
        requestId: "request-provider-ended",
        toolUseID: "tool-provider-ended",
      },
    );

    provider.messages.close();

    await expect(pendingPermission).resolves.toMatchObject({
      behavior: "deny",
    });
    await vi.waitFor(() => {
      expect(provider.controls.close).toHaveBeenCalledOnce();
      expect(provider.options().abortController?.signal.aborted).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: { type: "run_state_changed", state: "disconnected" },
        }),
        expect.objectContaining({
          event: {
            type: "resnapshot_required",
            reason: "provider_handle_closed",
          },
        }),
      ]),
    );
    expect(
      rawEvents.filter(
        (event) =>
          event.type === "resnapshot_required" &&
          event.reason === "provider_handle_closed",
      ),
    ).toHaveLength(1);
    await expect(handle.history({ limit: 10 })).rejects.toMatchObject({
      backendCode: "claude_handle_closed",
    });
    await handle.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not duplicate an interaction opened after the projection fence", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const canUseTool = provider.options().canUseTool;
    if (!canUseTool) throw new Error("permission_callback_missing");
    const pending = canUseTool(
      "Read",
      {},
      {
        signal: new AbortController().signal,
        requestId: "request-a",
        toolUseID: "tool-a",
      },
    );
    const events: unknown[] = [];
    established.subscribeFromNext((event) => events.push(event));
    expect(
      events.filter(
        (candidate) =>
          (candidate as { event?: { type?: string } }).event?.type ===
          "interaction_opened",
      ),
    ).toHaveLength(1);
    await handle.close();
    await pending;
  });

  it.each([
    {
      name: "conversation reset",
      message: {
        type: "conversation_reset",
        new_conversation_id: "88888888-8888-4888-8888-888888888888",
        uuid: "99999999-9999-4999-8999-999999999999",
        session_id: SESSION_ID,
      },
      backendCode: "claude_conversation_reset_unsupported",
    },
    {
      name: "local command output",
      message: {
        type: "system",
        subtype: "local_command_output",
        content: "Local-only command output",
        uuid: "99999999-9999-4999-8999-999999999999",
        session_id: SESSION_ID,
      },
      backendCode: "claude_local_command_output_unsupported",
    },
  ])(
    "fails closed on unsupported SDK $name",
    async ({ message, backendCode }) => {
      const provider = fixture();
      const { handle } = createHandle(provider);
      const established = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const rawEvents: BackendConversationEvent[] = [];
      handle.subscribe((event) => rawEvents.push(event));
      const events: unknown[] = [];
      established.subscribeFromNext((event) => events.push(event));
      const submitted = handle.submit({
        applicationOperationId: OPERATION_ID,
        mutationId: "mutation-reset",
        source: { kind: "user" },
        reconciliationToken: "reconcile-reset",
        text: "Trigger unsupported state",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      });
      await provider.prompt()[Symbol.asyncIterator]().next();
      provider.messages.push(message as unknown as SDKMessage);
      await expect(submitted).rejects.toMatchObject({
        backendCode,
        crossedSubmissionBoundary: true,
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: {
              type: "resnapshot_required",
              reason: "contradictory_state",
            },
          }),
          expect.objectContaining({
            event: { type: "run_state_changed", state: "disconnected" },
          }),
          expect.objectContaining({
            event: {
              type: "resnapshot_required",
              reason: "provider_handle_closed",
            },
          }),
        ]),
      );
      expect(
        rawEvents.filter(
          (event) =>
            event.type === "resnapshot_required" &&
            event.reason === "provider_handle_closed",
        ),
      ).toHaveLength(1);
      await expect(handle.history({ limit: 10 })).rejects.toMatchObject({
        backendCode: "claude_projection_invalidated",
      });
      await handle.close();
      await expect(handle.history({ limit: 10 })).rejects.toMatchObject({
        backendCode: "claude_handle_closed",
      });
      expect(() => handle.subscribe(() => undefined)).toThrow(
        "The Claude conversation is closed.",
      );
    },
  );

  it.each(["  /review src/server", "/compact summarize briefly", "/clear"])(
    "rejects unsupported Claude slash command %s before crossing the submission boundary",
    async (text) => {
      const provider = fixture();
      const { handle } = createHandle(provider);
      await handle.establishProjection({
        signal: new AbortController().signal,
      });
      provider.controls.applyFlagSettings.mockClear();

      await expect(
        handle.submit({
          applicationOperationId: OPERATION_ID,
          mutationId: "mutation-slash-command",
          source: { kind: "user" },
          reconciliationToken: "reconcile-slash-command",
          text,
          contextExcerpts: [],
          attachments: [],
          taskContexts: [],
        }),
      ).rejects.toMatchObject({
        backendCode: "claude_slash_commands_unavailable",
        crossedSubmissionBoundary: false,
      });
      expect(provider.controls.setModel).not.toHaveBeenCalled();
      expect(provider.controls.applyFlagSettings).not.toHaveBeenCalled();
      await handle.close();
    },
  );

  it.each([
    {
      name: "selected skill",
      selectedSkillId: claudeSkillId("review"),
      text: "src/server",
    },
    {
      name: "direct safe invocation",
      selectedSkillId: undefined,
      text: "  /review src/server",
    },
  ])(
    "delivers a classified Claude $name as an ordinary model turn",
    async (input) => {
      const provider = fixture({ safeSkill: true });
      const { handle } = createHandle(provider);
      await handle.establishProjection({
        signal: new AbortController().signal,
      });

      const submitted = handle.submit({
        applicationOperationId: OPERATION_ID,
        mutationId: "mutation-safe-skill",
        source: { kind: "user" },
        reconciliationToken: "reconcile-safe-skill",
        text: input.text,
        ...(input.selectedSkillId
          ? { selectedSkillId: input.selectedSkillId }
          : {}),
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      });
      const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
      expect((prompt.value as SDKUserMessage).message.content).toBe(
        "/review src/server",
      );
      provider.messages.push(prompt.value as SDKMessage);
      await expect(submitted).resolves.toMatchObject({ accepted: true });
      const history = await handle.history({ limit: 10 });
      const userItem = Object.values(history.itemsById).find(
        (item) => item.semanticKind === "user_message",
      );
      expect(userItem).toMatchObject({
        semanticKind: "user_message",
        deliveryOperationId: OPERATION_ID,
        content: [
          { kind: "skill", name: { text: "review" } },
          { kind: "text", text: { text: "src/server" } },
        ],
      });
      await handle.close();
    },
  );

  it("rejects a stale Claude skill selection before crossing the boundary", async () => {
    const provider = fixture({ safeSkill: true });
    const { handle } = createHandle(provider);
    await handle.establishProjection({ signal: new AbortController().signal });

    await expect(
      handle.submit({
        applicationOperationId: OPERATION_ID,
        mutationId: "mutation-stale-skill",
        source: { kind: "user" },
        reconciliationToken: "reconcile-stale-skill",
        text: "review this",
        selectedSkillId: claudeSkillId("removed"),
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    ).rejects.toMatchObject({
      backendCode: "claude_skill_unavailable",
      crossedSubmissionBoundary: false,
    });
    expect(provider.controls.setModel).not.toHaveBeenCalled();
    await handle.close();
  });

  it("keeps history attach available but rejects a denied tuple before provider settings or send", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), {
      modelPolicy: {
        type: "denylist",
        denied: [
          {
            modelIds: ["claude-sonnet-5"],
            reasoningEfforts: ["low"],
          },
        ],
      },
    });
    await expect(
      handle.establishProjection({ signal: new AbortController().signal }),
    ).resolves.toBeDefined();
    provider.controls.setModel.mockClear();
    provider.controls.applyFlagSettings.mockClear();

    await expect(
      handle.submit({
        applicationOperationId: OPERATION_ID,
        mutationId: "mutation-policy-denied",
        source: { kind: "user" },
        reconciliationToken: "reconcile-policy-denied",
        text: "Explain this",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
      }),
    ).rejects.toMatchObject({
      backendCode: "model_policy_rejected",
      crossedSubmissionBoundary: false,
      retryable: false,
    });
    expect(provider.controls.setModel).not.toHaveBeenCalled();
    expect(provider.controls.applyFlagSettings).not.toHaveBeenCalled();
    await handle.close();
  });

  it("evicts superseded content, clears partials, and adopts a session fallback model", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: Array<{ event: { type: string; [key: string]: unknown } }> =
      [];
    established.subscribeFromNext((event) => events.push(event));
    provider.messages.push({
      type: "user",
      message: { role: "user", content: "Original request" },
      parent_tool_use_id: null,
      uuid: OPERATION_ID,
      session_id: SESSION_ID,
      origin: { kind: "human" },
    });
    const staleUuid = "33333333-3333-4333-8333-333333333333";
    provider.messages.push({
      type: "assistant",
      uuid: staleUuid,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Stale refusal" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as unknown as SDKMessage);
    const partialUuid = "44444444-4444-4444-8444-444444444444";
    provider.messages.push({
      type: "stream_event",
      uuid: partialUuid,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "partial" },
      },
    } as unknown as SDKMessage);
    await vi.waitFor(async () => {
      expect(JSON.stringify(await handle.history({ limit: 10 }))).toContain(
        "Stale refusal",
      );
    });
    provider.messages.push({
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      scope: "session",
      original_model: "claude-sonnet-5",
      fallback_model: "claude-opus-5",
      request_id: "request-fallback",
      retracted_message_uuids: [staleUuid],
      refused_user_message_uuid: OPERATION_ID,
      content: "Retrying with Claude Opus 5",
      uuid: "55555555-5555-4555-8555-555555555555",
      session_id: SESSION_ID,
    } as unknown as SDKMessage);
    const updatesBeforeTrailingDelta = events.filter(
      ({ event }) => event.type === "item_updated",
    ).length;
    provider.messages.push({
      type: "stream_event",
      uuid: partialUuid,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " ignored" },
      },
    } as unknown as SDKMessage);
    await vi.waitFor(async () => {
      const history = await handle.history({ limit: 10 });
      expect(JSON.stringify(history)).not.toContain("Stale refusal");
      expect(await handle.backendCapabilities()).toMatchObject({
        effectiveSettings: { model: { id: "claude-opus-5" } },
      });
      expect(
        events.some(
          ({ event }) =>
            event.type === "resnapshot_required" &&
            event.reason === "contradictory_state",
        ),
      ).toBe(true);
      expect(
        events.filter(({ event }) => event.type === "item_updated"),
      ).toHaveLength(updatesBeforeTrailingDelta);
    });
    await handle.close();
  });

  it("forces resnapshot when an assistant frame supersedes prior content", async () => {
    const provider = fixture();
    const staleUuid = "33333333-3333-4333-8333-333333333333";
    const initialMessages: SessionMessage[] = [
      {
        type: "user",
        uuid: OPERATION_ID,
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: "user", content: "Retry this" },
      },
      {
        type: "assistant",
        uuid: staleUuid,
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Retracted answer" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
    provider.sdk.getSessionMessages = vi.fn(async (_id, options) => {
      const offset = options.offset ?? 0;
      const limit = options.limit ?? initialMessages.length;
      return initialMessages.slice(offset, offset + limit);
    });
    const { handle } = createHandle(provider, vi.fn(), {
      initialMessages,
      resumeSession: true,
    });
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: Array<{ event: { type: string } }> = [];
    established.subscribeFromNext((event) => events.push(event));
    provider.messages.push({
      type: "assistant",
      uuid: "66666666-6666-4666-8666-666666666666",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      supersedes: [staleUuid],
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Replacement answer" }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    } as unknown as SDKMessage);
    await vi.waitFor(async () => {
      const serialized = JSON.stringify(await handle.history({ limit: 10 }));
      expect(serialized).not.toContain("Retracted answer");
      expect(serialized).toContain("Replacement answer");
      expect(
        events.some(({ event }) => event.type === "resnapshot_required"),
      ).toBe(true);
    });
    await handle.close();
  });

  it("merges live cutover events with one authoritative attachment read", async () => {
    const provider = fixture();
    const staleUuid = "33333333-3333-4333-8333-333333333333";
    const initialMessages: SessionMessage[] = [
      {
        type: "user",
        uuid: OPERATION_ID,
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: "user", content: "Retry during attachment" },
      },
      {
        type: "assistant",
        uuid: staleUuid,
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Stale attachment answer" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let startupProbeUuid: string | undefined;
    const loadInitialMessages = vi.fn(async () => {
      const startupProbe = await provider
        .rawPrompt()
        [Symbol.asyncIterator]()
        .next();
      if (startupProbe.done || !startupProbe.value.uuid) {
        throw new Error("startup_probe_missing");
      }
      startupProbeUuid = startupProbe.value.uuid;
      markReadStarted();
      await readReleased;
      return [
        {
          type: "user",
          uuid: startupProbe.value.uuid,
          session_id: SESSION_ID,
          parent_tool_use_id: startupProbe.value.parent_tool_use_id,
          parent_agent_id: null,
          message: startupProbe.value.message,
        } satisfies SessionMessage,
        ...initialMessages,
      ];
    });
    const { handle } = createHandle(provider, vi.fn(), {
      loadInitialMessages,
      resumeSession: true,
    });
    let markRetractionObserved!: () => void;
    const retractionObserved = new Promise<void>((resolve) => {
      markRetractionObserved = resolve;
    });
    handle.subscribe((event) => {
      if (
        event.type === "resnapshot_required" &&
        event.reason === "contradictory_state"
      ) {
        markRetractionObserved();
      }
    });
    const establishing = handle.establishProjection({
      signal: new AbortController().signal,
    });
    await readStarted;
    provider.messages.push({
      type: "assistant",
      uuid: "66666666-6666-4666-8666-666666666666",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      supersedes: [staleUuid],
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Cutover replacement answer" }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    } as unknown as SDKMessage);
    await retractionObserved;
    releaseRead();

    const established = await establishing;
    const serialized = JSON.stringify(established.snapshot);
    expect(serialized).toContain("Retry during attachment");
    expect(serialized).toContain("Cutover replacement answer");
    expect(serialized).not.toContain("Stale attachment answer");
    expect(serialized).not.toContain(startupProbeUuid);
    expect(loadInitialMessages).toHaveBeenCalledTimes(1);
    await expect(handle.history({ limit: 10 })).resolves.toBeDefined();
    expect(loadInitialMessages).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it("captures only the new live message and retries accounting after duplicate native replay", async () => {
    const provider = fixture();
    let durable = true;
    const batches: readonly UsageObservation[][] = [];
    const captured = batches as UsageObservation[][];
    const usage: UsageSink = {open: () => ({registerTurns: () => {}, capture: observations => {captured.push([...observations]);return durable;},gap:()=>{},reconcile:()=>true,seal:()=>{}})};
    const user:SessionMessage={type:"user",uuid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",session_id:SESSION_ID,parent_tool_use_id:null,parent_agent_id:null,message:{role:"user",content:"Earlier"}};
    const assistant=(uuid:string,id:string):SessionMessage=>({type:"assistant",uuid,session_id:SESSION_ID,parent_tool_use_id:null,parent_agent_id:null,message:{id,role:"assistant",content:[{type:"text",text:"Answer"}],stop_reason:"end_turn",usage:{input_tokens:5,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0}}});
    const initial=assistant("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","history");
    const {handle}=createHandle(provider,vi.fn(),{usage,initialMessages:[user,initial],resumeSession:true});
    await handle.establishProjection({signal:new AbortController().signal});
    expect(captured).toHaveLength(1);expect(captured[0]!.map(o=>o.id)).toEqual(["history:message"]);
    const live=assistant("cccccccc-cccc-4ccc-8ccc-cccccccccccc","live");
    durable=false;provider.messages.push(live as SDKMessage);
    await vi.waitFor(()=>expect(captured).toHaveLength(2));
    expect(captured[1]!.map(o=>o.id)).toEqual(["live:message"]);
    durable=true;provider.messages.push(live as SDKMessage);
    await vi.waitFor(()=>expect(captured).toHaveLength(3));
    expect(captured[2]!.map(o=>o.id)).toEqual(["live:message"]);
    await handle.close();
  });

  it("captures pipeline results independently of history without transient token authority", async () => {
    const captured: UsageObservation[] = [];
    const usage: UsageSink = {open: () => ({registerTurns: () => {}, capture: (entries) => { captured.push(...entries); return true; }, gap: () => {}, reconcile: () => true, seal: () => {}})};
    const provider = fixture();
    const initialMessages: SessionMessage[] = [
      {
        type: "user",
        uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: "user", content: "Earlier" },
      },
      {
        type: "assistant",
        uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Earlier answer" }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ];
    provider.sdk.getSessionMessages = vi.fn(async (_id, options) => {
      const offset = options.offset ?? 0;
      const limit = options.limit ?? initialMessages.length;
      return initialMessages.slice(offset, offset + limit);
    });
    const { handle, settings } = createHandle(provider, vi.fn(), {
      usage,
      initialMessages,
      resumeSession: true,
    });
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const pushUsage = (
      inputTokens: number,
      outputTokens: number,
      numTurns: number,
    ) => {
      provider.messages.push({
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: numTurns,
        result: "ok",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {},
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens,
            outputTokens,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
          },
        },
        permission_denials: [],
        uuid: crypto.randomUUID(),
        session_id: SESSION_ID,
      } as unknown as SDKMessage);
    };
    pushUsage(10, 4, 1);
    await vi.waitFor(async () => {
      expect(await handle.usage()).not.toHaveProperty("tokens");
      expect(captured.filter((o) => o.replaceCheckpoint)).toHaveLength(1);
    });
    pushUsage(15, 6, 2);
    await vi.waitFor(async () => {
      expect(await handle.usage()).not.toHaveProperty("tokens");
      expect(captured.filter((o) => o.replaceCheckpoint)).toHaveLength(2);
    });
    pushUsage(12, 5, 1);
    await vi.waitFor(async () => {
      expect(await handle.usage()).not.toHaveProperty("tokens");
      expect(captured.filter((o) => o.replaceCheckpoint)).toHaveLength(3);
    });
    await handle.close();

    const resumed = createHandle(fixture(), vi.fn(), {
      settings,
      usage,
      initialMessages,
      resumeSession: true,
    }).handle;
    await resumed.establishProjection({
      signal: new AbortController().signal,
    });
    expect(await resumed.usage()).not.toHaveProperty("tokens");
    expect(captured.filter((o) => o.replaceCheckpoint).map((o) => o.facts[0]!.tokens.uncachedInput)).toEqual(["10", "15", "12"]);
    await resumed.close();
  });

  it("renames through the SDK and reconciles from native session metadata", async () => {
    const provider = fixture();
    (provider.sdk as ClaudeSdkFacade).getSessionInfo = vi.fn(async () => ({
      sessionId: SESSION_ID,
      summary: "Renamed",
      customTitle: "Renamed",
      lastModified: 1,
    }));
    const { handle } = createHandle(provider);
    await handle.establishProjection({ signal: new AbortController().signal });
    await expect(
      handle.perform({
        applicationOperationId: OPERATION_ID,
        action: "rename",
        title: "Renamed",
      }),
    ).resolves.toEqual({ accepted: true });
    expect(provider.sdk.renameSession).toHaveBeenCalledWith(
      SESSION_ID,
      "Renamed",
      { dir: "/workspace" },
      { HOME: "/home/test", PATH: "/usr/bin" },
    );
    await expect(
      handle.reconcileAction({
        applicationOperationId: "77777777-7777-4777-8777-777777777777",
        action: "rename",
        title: "Renamed",
      }),
    ).resolves.toEqual({ outcome: "accepted" });
    await handle.close();
  });
});

describe("Claude retained remote handle recovery", () => {
  it.each([false, true])(
    "preserves service-owned CLI sessions across carrier loss: %s",
    async (persistent) => {
      const provider = fixture();
      let loseCarrier!: () => void;
      const agentToolCliClosed = new Promise<void>((resolve) => {
        loseCarrier = resolve;
      });
      const release = vi.fn();
      const retained = retainedRuntime(provider, []);
      const { handle } = createHandle(provider, release, {
        ...(persistent ? { runtimeClient: retained.runtime } : {}),
        agentToolCliClosed,
        agentToolCli: {
          availability: "available",
          endpoint: "unix:///tmp/retained-sedes.sock",
          executableDirectory: "/provider/bin",
          inheritedPath: "/usr/bin",
        },
      });
      await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(provider.options().env?.SEDES_AGENT_TOOL_ENDPOINT).toBe(
        "unix:///tmp/retained-sedes.sock",
      );
      const events: BackendConversationEvent[] = [];
      handle.subscribe((event) => events.push(event));
      loseCarrier();
      await agentToolCliClosed;
      if (persistent) {
        provider.messages.push({
          type: "user",
          uuid: OPERATION_ID,
          session_id: SESSION_ID,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: "Output after carrier replacement",
          },
        } as SDKMessage);
        await vi.waitFor(() =>
          expect(events.some((event) => event.type === "turn_started")).toBe(
            true,
          ),
        );
        expect(release).not.toHaveBeenCalled();
        expect(provider.controls.close).not.toHaveBeenCalled();
        // Genuine runtime loss still closes the service-owned attachment.
        provider.messages.close();
      }
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      await expect(handle.history({ limit: 10 })).rejects.toMatchObject({
        backendCode: "claude_handle_closed",
      });
      await handle.close();
    },
  );

  it("does not count a persisted terminal result again when its acknowledgement was lost", async () => {
    const settings = repository();
    const user = {
      type: "user",
      uuid: OPERATION_ID,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { role: "user", content: "Retained request" },
    } as SDKMessage;
    const result = {
      type: "result",
      subtype: "success",
      uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      session_id: SESSION_ID,
      is_error: false,
      num_turns: 1,
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 4,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    } as unknown as SDKMessage;
    const firstProvider = fixture();
    const firstRuntime = retainedRuntime(firstProvider, [user, result]);
    const first = createHandle(firstProvider, vi.fn(), {
      settings,
      runtimeClient: firstRuntime.runtime,
    }).handle;
    await first.establishProjection({ signal: new AbortController().signal });
    const usage = await first.usage();
    expect(usage).not.toHaveProperty("tokens");
    expect(usage.counters).not.toHaveProperty("requests");
    await first.close();
    const replacementProvider = fixture();
    const replacementRuntime = retainedRuntime(replacementProvider, [
      user,
      result,
    ]);
    const replacement = createHandle(replacementProvider, vi.fn(), {
      settings,
      runtimeClient: replacementRuntime.runtime,
      initialMessages: [{ ...user, parent_agent_id: null } as SessionMessage],
    }).handle;
    const projection = await replacement.establishProjection({
      signal: new AbortController().signal,
    });
    expect(projection.snapshot.runState).toBe("idle");
    expect(await replacement.usage()).toEqual(usage);
    await replacement.close();
  });

  it("hydrates native history before retained input and streaming replay without changing active effort", async () => {
    const provider = fixture();
    const historicalUser = {
      type: "user",
      uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { role: "user", content: "Previous turn" },
    } as SessionMessage;
    const retainedInput = {
      type: "user",
      uuid: OPERATION_ID,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { role: "user", content: "Exact retained input" },
    } as SDKMessage;
    const replay = [
      retainedInput,
      {
        type: "stream_event",
        uuid: crypto.randomUUID(),
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        event: { type: "message_start", message: { id: "retained-assistant" } },
      },
      {
        type: "stream_event",
        uuid: crypto.randomUUID(),
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "Still " },
        },
      },
      {
        type: "stream_event",
        uuid: crypto.randomUUID(),
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "working remotely" },
        },
      },
    ] as SDKMessage[];
    const retained = retainedRuntime(provider, replay, "high");
    const onEffortEvidence = vi.fn();
    const { handle } = createHandle(provider, vi.fn(), {
      runtimeClient: retained.runtime,
      onEffortEvidence,
      initialMessages: [historicalUser],
    });
    const projection = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(projection.snapshot.runState).toBe("running");
    expect(projection.snapshot.orderedBackendTurnIds).toHaveLength(2);
    const active = projection.snapshot.activeBackendTurnId!;
    expect(active).toBe(projection.snapshot.orderedBackendTurnIds[1]);
    expect(Object.values(projection.snapshot.itemsById)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semanticKind: "assistant_message",
          status: "streaming",
          backendTurnId: active,
          markdown: { text: "Still working remotely" },
        }),
        expect.objectContaining({
          semanticKind: "user_message",
          deliveryOperationId: OPERATION_ID,
        }),
      ]),
    );
    expect(provider.controls.applyFlagSettings).not.toHaveBeenCalled();
    expect(onEffortEvidence).toHaveBeenCalledWith({
      generation: 1,
      effort: "high",
      source: "setter",
    });
    await handle.close();
  });

  it("detaches before local permission settlement and reopens the retained request on a replacement handle", async () => {
    const settings = repository();
    const firstProvider = fixture();
    const firstRuntime = retainedRuntime(firstProvider, []);
    const first = createHandle(firstProvider, vi.fn(), {
      settings,
      runtimeClient: firstRuntime.runtime,
    }).handle;
    await first.establishProjection({ signal: new AbortController().signal });
    const firstPermission = firstRuntime.permission();
    await first.close();
    await expect(firstPermission).resolves.toBeUndefined();

    const replacementProvider = fixture();
    const replacementRuntime = retainedRuntime(replacementProvider, []);
    const replacement = createHandle(replacementProvider, vi.fn(), {
      settings,
      runtimeClient: replacementRuntime.runtime,
    }).handle;
    await replacement.establishProjection({
      signal: new AbortController().signal,
    });
    const pendingPermission = replacementRuntime.permission();
    const projection = await replacement.establishProjection({
      signal: new AbortController().signal,
    });
    const events: BackendConversationEvent[] = [];
    projection.subscribeFromNext(({ event }) => events.push(event));
    const opened = events.find((event) => event.type === "interaction_opened");
    expect(opened?.type).toBe("interaction_opened");
    if (opened?.type !== "interaction_opened")
      throw new Error("permission_not_replayed");
    await replacement.respond({
      applicationOperationId: OPERATION_ID,
      kind: "decision",
      interactionId: opened.interaction.backendInteractionId,
      selectedActionId: "allow_once",
    });
    await expect(pendingPermission).resolves.toMatchObject({
      behavior: "allow",
    });
    await replacement.close();
  });
});


describe("Claude outstanding background activity and subagent bookends", () => {
  const native = (type: "user" | "assistant", uuid: string, content: unknown): SessionMessage => ({
    type, uuid, session_id: SESSION_ID, parent_tool_use_id: null, parent_agent_id: null,
    message: { role: type, content },
  });
  const initialMessages = [
    native("user", OPERATION_ID, "Start a background subagent"),
    native("assistant", "40000000-0000-4000-8000-000000000001", [{
      type: "tool_use", id: "agent-launch", name: "Agent",
      input: { description: "Sleep 20 seconds test", prompt: "Sleep and report back", run_in_background: true },
    }]),
    native("user", "40000000-0000-4000-8000-000000000002", [{
      type: "tool_result", tool_use_id: "agent-launch", content: "Async agent launched successfully. Child content must not replace the launch.",
    }]),
  ];
  const finalMessage = native("assistant", "40000000-0000-4000-8000-000000000003", [{ type: "text", text: "I will report back." }]);
  const system = (body: Record<string, unknown>): SDKMessage => ({ type: "system", uuid: crypto.randomUUID(), session_id: SESSION_ID, ...body }) as SDKMessage;
  const started = () => system({ subtype: "task_started", task_id: "child", tool_use_id: "agent-launch",
    task_type: "local_agent", description: "Sleep 20 seconds test", is_backgrounded: true });
  const inventory = (tasks: unknown[]) => system({ subtype: "background_tasks_changed", tasks });
  const snapshot = async (handle: ClaudeConversationHandle) => (await handle.establishProjection({ signal: new AbortController().signal })).snapshot;

  it("keeps provider task notifications hidden live and after reopening while retaining the assistant response and outcome row", async () => {
    const provider = fixture();
    const { handle, settings } = createHandle(provider, vi.fn(), { initialMessages: [...initialMessages, finalMessage] });
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    provider.messages.push(started());
    provider.messages.push(system({ subtype: "task_notification", task_id: "child", tool_use_id: "agent-launch",
      status: "completed", output_file: "/private", summary: "Finished" }));
    await vi.waitFor(() => expect(events.some(event => event.type === "item_completed" && event.item.semanticKind === "collaboration")).toBe(true));
    events.length = 0;
    const notification = { ...native("user", "40000000-0000-4000-8000-000000000004",
      "<task-notification>\n<task-id>child</task-id>\n<status>completed</status>\n</task-notification>"), origin: { kind: "task-notification" } };
    provider.messages.push(notification as SDKMessage);
    await vi.waitFor(() => expect(events.some(event => event.type === "usage_changed")).toBe(true));
    expect((await snapshot(handle)).runState).toBe("idle");
    const response = native("assistant", "40000000-0000-4000-8000-000000000005", "The subagent finished.");
    provider.messages.push(response as SDKMessage);
    await vi.waitFor(async () => expect(JSON.stringify(await snapshot(handle))).toContain("The subagent finished."));
    const live = await snapshot(handle);
    expect(JSON.stringify(live)).not.toContain("<task-notification>");
    expect(Object.values(live.itemsById).filter(item => item.semanticKind === "collaboration")).toHaveLength(2);
    await handle.close();
    const reopened = createHandle(fixture(), vi.fn(), { settings, resumeSession: true,
      initialMessages: [...initialMessages, finalMessage, notification, response] }).handle;
    const restored = await snapshot(reopened);
    expect(restored.orderedBackendTurnIds).toEqual(live.orderedBackendTurnIds);
    expect(restored.itemsById).toEqual(live.itemsById);
    expect(restored.runState).toBe("idle");
    await reopened.close();
  });

  it.each(["completed", "failed", "stopped"] as const)("keeps Send independent and persists exactly one %s bookend across reopen", async status => {
    const provider = fixture();
    const { handle, settings } = createHandle(provider, vi.fn(), { initialMessages });
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    provider.messages.push(inventory([
      { task_id: "child", task_type: "local_agent", description: "Sleep 20 seconds test" },
      { task_id: "shell", task_type: "local_bash", description: "Sleep 10 seconds" },
      { task_id: "ambient", task_type: "local_agent", description: "Watcher", ambient: true },
    ]));
    provider.messages.push(started());
    provider.messages.push(finalMessage as unknown as SDKMessage);
    provider.messages.push({ type: "result", subtype: "success", result: "I will report back.",
      num_turns: 1, stop_reason: "end_turn", duration_ms: 1, duration_api_ms: 1,
      is_error: false, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
      uuid: crypto.randomUUID(), session_id: SESSION_ID,
    } as unknown as SDKMessage);
    await vi.waitFor(() => expect(events).toContainEqual({ type: "run_state_changed", state: "idle" }));
    const active = await snapshot(handle);
    expect(active).toMatchObject({ runState: "idle", backgroundActivity: { state: "known", agents: 1, commands: 1, other: 0 } });
    expect(Object.values(active.itemsById).filter(item => item.semanticKind === "collaboration")).toMatchObject([
      { action: "spawn", summary: { text: "Started subagent · Sleep 20 seconds test" }, status: "completed" },
    ]);
    // Replacement levels can precede edge notifications; the edge must never
    // add a stale task back or erase the unrelated running shell.
    provider.messages.push(inventory([{ task_id: "shell", task_type: "local_bash", description: "Sleep 10 seconds" }]));
    const completion = system({ subtype: "task_notification", task_id: "child", tool_use_id: "agent-launch",
      status, output_file: "/private/child-transcript", summary: "Private child text should not be displayed" });
    provider.messages.push(completion);
    provider.messages.push(completion);
    await vi.waitFor(async () => {
      const page = await handle.history({ limit: 10 });
      expect(Object.values(page.itemsById).filter(item => item.semanticKind === "collaboration")).toHaveLength(2);
    });
    const completed = await snapshot(handle);
    expect(completed.backgroundActivity).toMatchObject({ state: "known", agents: 0, commands: 1 });
    const rows = Object.values(completed.itemsById).filter(item => item.semanticKind === "collaboration");
    expect(rows[1]).toMatchObject({ summary: { text: `Subagent ${status} · Sleep 20 seconds test` },
      status: status === "stopped" ? "interrupted" : status });
    expect(JSON.stringify(rows)).not.toContain("Private child text");
    expect(events.filter(event => event.type === "turn_completed")).toHaveLength(1);
    // The next ordinary submission remains legal while the command runs.
    const submission = handle.submit({ applicationOperationId: "99999999-9999-4999-8999-999999999999",
      mutationId: "next", source: { kind: "user" }, reconciliationToken: "next", text: "Next message",
      contextExcerpts: [], attachments: [], taskContexts: [] });
    const prompt = await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push(prompt.value as SDKMessage);
    await expect(submission).resolves.toMatchObject({ accepted: true });
    await handle.close();
    const reopened = createHandle(fixture(), vi.fn(), { settings, initialMessages: [...initialMessages, finalMessage], resumeSession: true }).handle;
    const recovered = await snapshot(reopened);
    expect(recovered.backgroundActivity).toMatchObject({ state: "known", agents: 0, commands: 0 });
    expect(Object.values(recovered.itemsById).filter(item => item.semanticKind === "collaboration")).toEqual(rows);
    await reopened.close();
  });

  it.each([
    { terminalEvent: "task_updated", is_backgrounded: true },
    { terminalEvent: "task_notification", is_backgrounded: true },
    { terminalEvent: "task_updated", is_backgrounded: false },
    { terminalEvent: "task_notification", is_backgrounded: false },
  ])("holds idle retirement until durable $terminalEvent with initially backgrounded=$is_backgrounded", async ({ terminalEvent, is_backgrounded }) => {
    const provider = fixture();
    const { handle, settings } = createHandle(provider, vi.fn(), { initialMessages: [...initialMessages, finalMessage] });
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    const observed: { blocked: boolean; terminal: string | null | undefined }[] = [];
    established.subscribeFromNext(({ event }) => {
      if (event.type === "background_activity_changed") observed.push({ blocked: handle.retirementBlocked,
        terminal: settings.listTaskLifecycleReceipts({ tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId }, BINDING.applicationThreadId, SESSION_ID)[0]?.terminalStatus });
    });
    provider.messages.push(inventory([{ task_id: "child", task_type: "local_agent", description: "Sleep" }]));
    provider.messages.push({ ...started(), is_backgrounded } as SDKMessage);
    if (!is_backgrounded) provider.messages.push(system({ subtype: "task_updated", task_id: "child", patch: { is_backgrounded: true } }));
    provider.messages.push(inventory([]));
    await vi.waitFor(() => expect(handle.retirementBlocked).toBe(true));
    expect(observed.at(-1)).toMatchObject({ blocked: true });
    provider.messages.push(terminalEvent === "task_updated"
      ? system({ subtype: "task_updated", task_id: "child", patch: { status: "completed" } })
      : system({ subtype: "task_notification", task_id: "child", tool_use_id: "agent-launch", status: "completed", output_file: "/private", summary: "Done" }));
    await vi.waitFor(() => expect(handle.retirementBlocked).toBe(false));
    expect(observed.at(-1)).toEqual({ blocked: false, terminal: "completed" });
    expect((await snapshot(handle)).backgroundActivity).toEqual({ state: "known", agents: 0, commands: 0, other: 0 });
    await handle.close();
  });

  it("invalidates loaded historical pages when a child finishes outside the latest window", async () => {
    const settings = repository();
    settings.writeTaskStarted({ tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId }, BINDING.applicationThreadId, SESSION_ID,
      { nativeTaskId: "child", nativeToolUseId: "agent-launch", description: "Sleep 20 seconds test", now: 1 });
    const messages = [...initialMessages, finalMessage, ...Array.from({ length: 15 }, (_, index) => [
      native("user", `51000000-0000-4000-8000-${String(index * 2).padStart(12, "0")}`, `Later prompt ${index}`),
      native("assistant", `51000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, "0")}`, [{ type: "text", text: `Later answer ${index}` }]),
    ]).flat()];
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), { settings, initialMessages: messages });
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    expect(JSON.stringify(established.snapshot)).not.toContain("Sleep 20 seconds test");
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    provider.messages.push(system({ subtype: "task_notification", task_id: "child", tool_use_id: "agent-launch",
      status: "completed", output_file: "/private", summary: "Done" }));
    await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "history_changed" }));
    const historical = await handle.history({ limit: 100 });
    expect(Object.values(historical.itemsById)).toContainEqual(expect.objectContaining({
      semanticKind: "collaboration", summary: { text: "Subagent completed · Sleep 20 seconds test" },
    }));
    expect(events.some(event => event.type === "turn_completed")).toBe(false);
    await handle.close();
  });

  it("projects foreground task_updated completion and ignores unknown task evidence", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), { initialMessages: [...initialMessages, finalMessage] });
    await snapshot(handle);
    provider.messages.push(started());
    provider.messages.push(system({ subtype: "task_updated", task_id: "unrelated", patch: { status: "completed" } }));
    provider.messages.push(system({ subtype: "task_updated", task_id: "child", patch: { status: "completed" } }));
    await vi.waitFor(async () => expect(Object.values((await handle.history({ limit: 10 })).itemsById).filter(item => item.semanticKind === "collaboration")).toHaveLength(2));
    expect((await snapshot(handle)).backgroundActivity).toMatchObject({ agents: 0, commands: 0 });
    await handle.close();
  });
});


describe("Claude asynchronous send admission", () => {
  const input = {
    applicationOperationId: OPERATION_ID, mutationId: "mutation-admission",
    source: { kind: "user" as const }, reconciliationToken: "admission-reconciliation",
    text: "follow up", contextExcerpts: [], attachments: [], taskContexts: [],
  };

  it("preserves a busy refusal as not sent and keeps the handle connected", async () => {
    const provider = fixture(); const retained = retainedRuntime(provider, []);
    const create = retained.runtime.createSession.bind(retained.runtime);
    vi.spyOn(retained.runtime, "createSession").mockImplementation(options => {
      const session = create(options);
      session.send = async () => {
        await options.onMessage({ type: "stream_event", uuid: "33333333-3333-4333-8333-333333333333",
          session_id: SESSION_ID, parent_tool_use_id: null,
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "older turn output" } },
        });
        throw new BackendError({
          category: "invalid_state", retryable: true, crossedSubmissionBoundary: false,
          backendCode: "claude_persistent_query_busy", safeMessage: "Still working",
        });
      };
      return session;
    });
    const release = vi.fn();
    const { handle } = createHandle(provider, release, { runtimeClient: retained.runtime });
    await handle.establishProjection({ signal: new AbortController().signal });
    await expect(handle.submit(input)).rejects.toMatchObject({
      category: "invalid_state", crossedSubmissionBoundary: false,
    });
    const projection = await handle.establishProjection({ signal: new AbortController().signal });
    expect(projection.snapshot.runState).toBe("running");
    expect(JSON.stringify(projection.snapshot)).not.toContain(input.text);
    expect(release).not.toHaveBeenCalled();
    await handle.close();
  });

  it("does not reactivate older work when its terminal result races a busy refusal", async () => {
    const provider = fixture(); const retained = retainedRuntime(provider, []);
    const oldId = "44444444-4444-4444-8444-444444444444";
    const initialMessages = [
      { type: "user", uuid: oldId, session_id: SESSION_ID, parent_tool_use_id: null, parent_agent_id: null,
        message: { role: "user", content: "older request" } },
      { type: "assistant", uuid: "55555555-5555-4555-8555-555555555555", session_id: SESSION_ID, parent_tool_use_id: null, parent_agent_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "older answer" }], stop_reason: "end_turn" } },
    ] as SessionMessage[];
    const create = retained.runtime.createSession.bind(retained.runtime);
    vi.spyOn(retained.runtime, "createSession").mockImplementation(options => {
      const session = create(options);
      session.send = async () => {
        await options.onMessage({ type: "result", subtype: "success", session_id: SESSION_ID,
          uuid: "66666666-6666-4666-8666-666666666666", user_message_uuid: oldId,
          result: "older answer", num_turns: 1, is_error: false,
          modelUsage: {}, usage: {}, permission_denials: [],
        } as unknown as SDKMessage);
        throw new BackendError({ category: "invalid_state", retryable: true,
          crossedSubmissionBoundary: false, backendCode: "claude_persistent_query_busy", safeMessage: "Busy" });
      };
      return session;
    });
    const { handle } = createHandle(provider, vi.fn(), { runtimeClient: retained.runtime, initialMessages });
    await handle.establishProjection({ signal: new AbortController().signal });
    await expect(handle.submit(input)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    const projection = await handle.establishProjection({ signal: new AbortController().signal });
    expect(projection.snapshot.runState).toBe("idle");
    expect(JSON.stringify(projection.snapshot)).not.toContain(input.text);
    await handle.close();
  });

  it("accepts a persisted ordinary input after the acknowledgment budget without waiting for first model output", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    await handle.establishProjection({ signal: new AbortController().signal });
    vi.useFakeTimers();
    try {
      const submitted = handle.submit(input);
      const native = await provider.prompt()[Symbol.asyncIterator]().next();
      provider.sdk.getSessionMessages.mockResolvedValue([{ ...native.value, parent_agent_id: null } as SessionMessage]);
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(submitted).resolves.toMatchObject({ accepted: true, completionCorrelation: OPERATION_ID });
      const snapshot = (await handle.establishProjection({ signal: new AbortController().signal })).snapshot;
      expect(snapshot.runState).toBe("running");
      expect(Object.values(snapshot.itemsById).filter(item => item.semanticKind === "user_message")).toHaveLength(1);
      await expect(handle.submit(input)).resolves.toMatchObject({ accepted: true });
      expect(provider.controls.setModel).toHaveBeenCalledTimes(1);
      expect(provider.sdk.getSessionMessages).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); await handle.close(); }
  });

  it.each(["missing", "unavailable", "wrong-session", "stalled"] as const)("keeps %s history uncertain and accepts later exact native input evidence without a resend", async history => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    await handle.establishProjection({ signal: new AbortController().signal });
    vi.useFakeTimers();
    try {
      const submitted = expect(handle.submit(input)).rejects.toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true });
      const native = await provider.prompt()[Symbol.asyncIterator]().next();
      if (history === "unavailable") provider.sdk.getSessionMessages.mockRejectedValue(new Error("temporary_history_failure"));
      if (history === "wrong-session") provider.sdk.getSessionMessages.mockResolvedValue([{ ...native.value, session_id: crypto.randomUUID(), parent_agent_id: null } as SessionMessage]);
      if (history === "stalled") provider.sdk.getSessionMessages.mockImplementation(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(35_001);
      await submitted;
      expect(handle.retirementBlocked).toBe(true);
      await expect(handle.submit(input)).rejects.toMatchObject({ category: "submission_unknown" });
      vi.useRealTimers();
      provider.messages.push({ type: "result", subtype: "success", uuid: crypto.randomUUID(), session_id: SESSION_ID,
        user_message_uuid: OPERATION_ID, user_message_uuids: [OPERATION_ID], num_turns: 1, terminal_reason: "completed",
        result: "Late response", is_error: false, usage: {}, modelUsage: {}, permission_denials: [] } as unknown as SDKMessage);
      await vi.waitFor(async () => expect(await handle.submit(input)).toMatchObject({ accepted: true }));
      const snapshot = (await handle.establishProjection({ signal: new AbortController().signal })).snapshot;
      expect(snapshot.runState).toBe("idle");
      expect(Object.values(snapshot.itemsById).filter(item => item.semanticKind === "user_message")).toHaveLength(1);
      expect(handle.retirementBlocked).toBe(false);
      expect(provider.controls.setModel).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); await handle.close(); }
  });

  it("clears an ordinary timed-out waiter only with exact non-admission proof and admits one explicit retry", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider);
    await handle.establishProjection({ signal: new AbortController().signal });
    const nativeInputs = provider.prompt()[Symbol.asyncIterator]();
    vi.useFakeTimers();
    try {
      const submitted = expect(handle.submit(input)).rejects.toMatchObject({ category: "submission_unknown" });
      expect((await nativeInputs.next()).value?.uuid).toBe(OPERATION_ID);
      await vi.advanceTimersByTimeAsync(30_001);
      await submitted;
      expect(handle.retirementBlocked).toBe(true);
      await expect(handle.submit(input)).rejects.toMatchObject({ category: "submission_unknown" });
      expect(provider.controls.setModel).toHaveBeenCalledTimes(1);
      expect(handle.forgetProvenUnsentSubmission(OPERATION_ID)).toBe(true);
      expect(handle.retirementBlocked).toBe(false);
      const retried = handle.submit(input);
      const retryNative = await nativeInputs.next();
      expect(retryNative.value?.uuid).toBe(OPERATION_ID);
      vi.useRealTimers();
      provider.messages.push(retryNative.value!);
      await expect(retried).resolves.toMatchObject({ accepted: true });
      await expect(handle.submit(input)).resolves.toMatchObject({ accepted: true });
      expect(handle.forgetProvenUnsentSubmission(OPERATION_ID)).toBe(false);
      expect(provider.controls.setModel).toHaveBeenCalledTimes(2);
      await handle.close();
      expect(await nativeInputs.next()).toMatchObject({ done: true });
    } finally { vi.useRealTimers(); await handle.close(); }
  });

  it("bounds the send RPC itself and keeps a missing response uncertain", async () => {
    const provider = fixture(); const retained = retainedRuntime(provider, []);
    const create = retained.runtime.createSession.bind(retained.runtime);
    vi.spyOn(retained.runtime, "createSession").mockImplementation(options => {
      const session = create(options);
      session.send = () => new Promise<void>(() => {});
      return session;
    });
    const { handle } = createHandle(provider, vi.fn(), { runtimeClient: retained.runtime });
    await handle.establishProjection({ signal: new AbortController().signal });
    vi.useFakeTimers();
    try {
      const pending = expect(handle.submit(input)).rejects.toMatchObject({
        category: "submission_unknown", crossedSubmissionBoundary: true,
        backendCode: "claude_submission_acknowledgement_timeout",
      });
      await vi.advanceTimersByTimeAsync(30_001);
      await pending;
    } finally { vi.useRealTimers(); await handle.close(); }
  });
});

describe("Claude conversation-scoped native next delivery", () => {
  const steerId = "77777777-7777-4777-8777-777777777777";
  const steerInput = {
    applicationOperationId: steerId, mutationId: "steer-native-next", reconciliationToken: "next-receipt",
    target: { kind: "conversation" as const }, text: "Use the revised approach", contextExcerpts: [], taskContexts: [], attachments: [],
  };
  const initialUser = { type: "user", uuid: OPERATION_ID, session_id: SESSION_ID,
    parent_tool_use_id: null, parent_agent_id: null, message: { role: "user", content: "Original request" } } as SessionMessage;
  const snapshot = async (handle: ClaudeConversationHandle) => (await handle.establishProjection({ signal: new AbortController().signal })).snapshot;
  const result = (ids: string[]) => ({ type: "result", subtype: "success", uuid: crypto.randomUUID(), session_id: SESSION_ID,
    user_message_uuid: ids.at(-1), user_message_uuids: ids, terminal_reason: "completed", num_turns: 1,
    result: "Done", is_error: false, usage: {}, modelUsage: {}, permission_denials: [] }) as unknown as SDKMessage;

  it("ignores explicitly child-owned output without requesting a parent resnapshot or accepting a queued steer", async () => {
    const provider = fixture();
    const { handle, settings } = createHandle(provider, vi.fn(), { initialMessages: [initialUser] });
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    await handle.steer(steerInput);
    await provider.prompt()[Symbol.asyncIterator]().next();
    const baseline = events.length;
    for (const childIdentity of [{ parent_tool_use_id: "child-agent-launch" }, { parent_tool_use_id: null, subagent_type: "Explore" }]) {
      provider.messages.push({ type: "assistant", uuid: crypto.randomUUID(), session_id: SESSION_ID, ...childIdentity,
        user_message_uuids: [OPERATION_ID, steerId], supersedes: [OPERATION_ID],
        message: { role: "assistant", content: [{ type: "tool_use", id: "child-read", name: "Read", input: { file_path: "/workspace/child-only" } }], stop_reason: "tool_use", usage: {} },
      } as unknown as SDKMessage);
      provider.messages.push({ type: "user", uuid: crypto.randomUUID(), session_id: SESSION_ID, ...childIdentity,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "child-read", content: "Child-only output" }] },
      } as unknown as SDKMessage);
      provider.messages.push({ type: "stream_event", uuid: crypto.randomUUID(), session_id: SESSION_ID, ...childIdentity,
        user_message_uuids: [OPERATION_ID, steerId], event: { type: "message_start", message: { id: "child-partial" } },
      } as unknown as SDKMessage);
    }
    // This main-thread inventory is a processing barrier after all child frames.
    provider.messages.push({ type: "system", subtype: "background_tasks_changed", uuid: crypto.randomUUID(),
      session_id: SESSION_ID, tasks: [] } as SDKMessage);
    await vi.waitFor(() => expect(events.slice(baseline).some(event => event.type === "background_activity_changed")).toBe(true));
    expect(events.slice(baseline).map(event => event.type)).toEqual(["background_activity_changed"]);
    expect((await snapshot(handle)).runState).toBe("running");
    expect(JSON.stringify(await snapshot(handle))).not.toContain("Child-only");
    expect(settings.listSteerOperations({ tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId }, BINDING.applicationThreadId).get(steerId)).toBeNull();
    expect(await handle.steer(steerInput)).toMatchObject({ status: "pending_materialization" });
    // A malformed main-thread frame still requests a fresh projection.
    provider.messages.push({ type: "assistant", session_id: SESSION_ID, parent_tool_use_id: null,
      message: { role: "assistant", content: [] } } as unknown as SDKMessage);
    await vi.waitFor(() => expect(events).toContainEqual({ type: "resnapshot_required", reason: "ambiguous_correlation" }));
    await handle.close();
  });

  it.each([false, true])("keeps live controls active between assistant/tool blocks until the native result (steered=%s)", async steering => {
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), { initialMessages: [initialUser] });
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    if (steering) {
      await handle.steer(steerInput);
      await provider.prompt()[Symbol.asyncIterator]().next();
    }
    const assistant = (content: unknown, stopReason?: string) => ({ type: "assistant", uuid: crypto.randomUUID(),
      session_id: SESSION_ID, parent_tool_use_id: null, message: { role: "assistant", content,
        ...(stopReason ? { stop_reason: stopReason } : {}), usage: {} } }) as SDKMessage;
    const idlePulse = () => provider.messages.push({ type: "system", subtype: "session_state_changed",
      state: "idle", session_id: SESSION_ID, uuid: crypto.randomUUID() } as SDKMessage);
    provider.messages.push(assistant([{ type: "text", text: "Checking a file" }]));
    idlePulse();
    await vi.waitFor(async () => expect(JSON.stringify(await snapshot(handle))).toContain("Checking a file"));
    expect((await snapshot(handle)).runState).toBe("running");
    expect(events.filter(event => event.type === "turn_completed")).toHaveLength(0);
    provider.messages.push(assistant([{ type: "tool_use", id: "active-read", name: "Read", input: { file_path: "/workspace/file" } }], "tool_use"));
    provider.messages.push({ type: "user", uuid: crypto.randomUUID(), session_id: SESSION_ID, parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "active-read", content: "Read complete" }] } } as SDKMessage);
    idlePulse();
    provider.messages.push(assistant([{ type: "text", text: "Finished reviewing" }], "end_turn"));
    idlePulse();
    await vi.waitFor(async () => expect(JSON.stringify(await snapshot(handle))).toContain("Finished reviewing"));
    expect((await snapshot(handle)).runState).toBe("running");
    expect(events.filter(event => event.type === "turn_completed")).toHaveLength(0);
    expect(events.filter(event => event.type === "run_state_changed" && event.state === "idle")).toHaveLength(0);
    if (steering) expect(await handle.steer(steerInput)).toMatchObject({ status: "pending_materialization" });
    provider.messages.push(result(steering ? [OPERATION_ID, steerId] : [OPERATION_ID]));
    await vi.waitFor(async () => expect((await snapshot(handle)).runState).toBe("idle"));
    expect(events.filter(event => event.type === "turn_completed")).toHaveLength(1);
    expect(events.filter(event => event.type === "run_state_changed" && event.state === "idle")).toHaveLength(1);
    await handle.close();
  });

  it("does not accept old output, then joins exact consumed UUIDs once and survives reopen", async () => {
    const provider = fixture();
    const { handle, settings } = createHandle(provider, vi.fn(), { initialMessages: [initialUser] });
    const initial = await snapshot(handle);
    const originalTurn = initial.orderedBackendTurnIds[0]!;
    const input = provider.prompt()[Symbol.asyncIterator]();
    const admitted = await handle.steer(steerInput);
    expect(admitted).toEqual({ status: "pending_materialization", reconciliationToken: "next-receipt", completionCorrelation: steerId });
    const native = await input.next();
    expect(native.value).toMatchObject({ uuid: steerId, priority: "next" });
    expect(provider.controls.interrupt).not.toHaveBeenCalled();
    expect(provider.controls.setModel).not.toHaveBeenCalled();
    provider.messages.push({ type: "stream_event", uuid: crypto.randomUUID(), session_id: SESSION_ID, parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Still original" } } } as SDKMessage);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(JSON.stringify(await snapshot(handle))).not.toContain(steerInput.text);
    expect(await handle.steer(steerInput)).toEqual(admitted);
    provider.messages.push(result([OPERATION_ID, steerId]));
    await vi.waitFor(async () => expect((await snapshot(handle)).runState).toBe("idle"));
    const settled = await snapshot(handle);
    expect(settled.orderedBackendTurnIds).toEqual([originalTurn]);
    expect(settled.turnsById[originalTurn]!.completionCorrelations).toEqual([OPERATION_ID, steerId]);
    expect(Object.values(settled.itemsById).filter(item => item.semanticKind === "user_message")).toHaveLength(2);
    expect(await handle.steer(steerInput)).toMatchObject({ status: "accepted", backendTurnId: originalTurn });
    expect(handle.forgetProvenUnsentSubmission(steerId)).toBe(false);
    expect(settings.listSteerOperations({ tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId }, BINDING.applicationThreadId).get(steerId)).toBe(OPERATION_ID);
    await handle.close();
    const restored = createHandle(fixture(), vi.fn(), { settings, resumeSession: true,
      initialMessages: [initialUser, { ...native.value, parent_agent_id: null } as SessionMessage] }).handle;
    const restoredSnapshot = await snapshot(restored);
    expect(restoredSnapshot.orderedBackendTurnIds).toEqual([originalTurn]);
    expect(restoredSnapshot.turnsById[originalTurn]!.completionCorrelations).toEqual([OPERATION_ID, steerId]);
    expect(restoredSnapshot.runState).toBe("idle");
    await restored.close();
  });

  it("keeps a queued steer pending when the older turn finishes, then observes its new turn", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), { initialMessages: [initialUser] });
    await snapshot(handle);
    await handle.steer(steerInput);
    const native = await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push(result([OPERATION_ID]));
    await vi.waitFor(async () => expect((await snapshot(handle)).runState).toBe("idle"));
    expect(JSON.stringify(await snapshot(handle))).not.toContain(steerInput.text);
    expect(handle.retirementBlocked).toBe(true);
    provider.messages.push(result([steerId]));
    await vi.waitFor(async () => expect((await snapshot(handle)).orderedBackendTurnIds).toHaveLength(2));
    const settled = await snapshot(handle);
    expect(settled.turnsById[settled.orderedBackendTurnIds[1]!]!.completionCorrelations).toEqual([steerId]);
    expect(native.value.priority).toBe("next");
    expect(handle.retirementBlocked).toBe(false);
    await handle.close();
  });

  it("holds an uncertain transport send until consumption and never retries the native input", async () => {
    const provider = fixture(); const runtime = new ClaudeSdkRuntimeAdapter(provider.sdk);
    const create = runtime.createSession.bind(runtime);
    vi.spyOn(runtime, "createSession").mockImplementation(options => {
      const session = create(options); const send = session.send.bind(session);
      session.send = async input => { send(input); throw new Error("transport_response_lost"); };
      return session;
    });
    const { handle } = createHandle(provider, vi.fn(), { runtimeClient: runtime, initialMessages: [initialUser] });
    await snapshot(handle);
    await expect(handle.steer(steerInput)).rejects.toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true });
    const native = await provider.prompt()[Symbol.asyncIterator]().next();
    expect(native.value.priority).toBe("next");
    expect(handle.retirementBlocked).toBe(true);
    await expect(handle.steer(steerInput)).rejects.toMatchObject({ category: "submission_unknown" });
    provider.messages.push(result([OPERATION_ID, steerId]));
    await vi.waitFor(async () => expect((await snapshot(handle)).runState).toBe("idle"));
    expect(handle.retirementBlocked).toBe(false);
    expect(await handle.steer(steerInput)).toMatchObject({ status: "accepted" });
    await handle.close();
  });

  it("removes pre-boundary steering metadata before an ordinary retry reuses the operation UUID", async () => {
    const provider = fixture(); const runtime = new ClaudeSdkRuntimeAdapter(provider.sdk);
    const create = runtime.createSession.bind(runtime);
    vi.spyOn(runtime, "createSession").mockImplementation(options => {
      const session = create(options); const send = session.send.bind(session);
      session.send = input => {
        if (input.priority === "next") throw new BackendError({ category: "invalid_state", retryable: true,
          crossedSubmissionBoundary: false, backendCode: "test_known_refusal", safeMessage: "Not admitted" });
        send(input);
      };
      return session;
    });
    const { handle, settings } = createHandle(provider, vi.fn(), { runtimeClient: runtime });
    await snapshot(handle);
    await expect(handle.steer(steerInput)).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    const scope = { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId };
    expect(settings.listSteerOperations(scope, BINDING.applicationThreadId).has(steerId)).toBe(false);
    expect(handle.retirementBlocked).toBe(false);
    const submitted = handle.submit({ ...steerInput, source: { kind: "user" } });
    const native = await provider.prompt()[Symbol.asyncIterator]().next();
    provider.messages.push(native.value as SDKMessage);
    await expect(submitted).resolves.toMatchObject({ accepted: true, completionCorrelation: steerId });
    provider.messages.push(result([steerId]));
    await vi.waitFor(async () => expect((await snapshot(handle)).runState).toBe("idle"));
    const settled = await snapshot(handle);
    expect(Object.values(settled.turnsById).some(turn => turn.completionCorrelations?.includes(steerId))).toBe(true);
    expect(JSON.stringify(settled)).toContain(steerInput.text);
    await handle.close();
  });

  it("ends a lost delivery observation without erasing evidence or silently sending it again", async () => {
    const provider = fixture();
    const { handle, settings } = createHandle(provider);
    await snapshot(handle);
    await handle.steer(steerInput);
    await provider.prompt()[Symbol.asyncIterator]().next();
    expect(handle.hasPendingSubmissionObservation(steerId)).toBe(true);
    expect(handle.retirementBlocked).toBe(true);
    expect(handle.endSubmissionObservation(steerId)).toBe(true);
    expect(handle.hasPendingSubmissionObservation(steerId)).toBe(false);
    expect(handle.retirementBlocked).toBe(false);
    const scope = { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId };
    expect(settings.listSteerOperations(scope, BINDING.applicationThreadId).get(steerId)).toBeNull();
    await expect(handle.steer(steerInput)).rejects.toMatchObject({ category: "submission_unknown", crossedSubmissionBoundary: true });
    // A late exact consumption stamp remains authoritative despite the loss.
    provider.messages.push(result([steerId]));
    await vi.waitFor(async () => expect(await handle.steer(steerInput)).toMatchObject({ status: "accepted" }));
    expect(handle.endSubmissionObservation(steerId)).toBe(false);
    expect(settings.listSteerOperations(scope, BINDING.applicationThreadId).get(steerId)).toBe(steerId);
    await handle.close();
  });

  it("releases the retirement hold only after exact driver non-admission proof", async () => {
    const provider = fixture(); const runtime = new ClaudeSdkRuntimeAdapter(provider.sdk);
    const create = runtime.createSession.bind(runtime);
    vi.spyOn(runtime, "createSession").mockImplementation(options => {
      const session = create(options);
      session.send = async () => { throw new Error("transport_response_lost"); };
      return session;
    });
    const { handle, settings } = createHandle(provider, vi.fn(), { runtimeClient: runtime });
    await snapshot(handle);
    await expect(handle.steer(steerInput)).rejects.toMatchObject({ crossedSubmissionBoundary: true });
    expect(handle.retirementBlocked).toBe(true);
    const scope = { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId };
    expect(settings.listSteerOperations(scope, BINDING.applicationThreadId).get(steerId)).toBeNull();
    // Production calls this only after runtime submissionDisposition=not_sent.
    handle.forgetProvenUnsentSubmission(steerId);
    expect(handle.retirementBlocked).toBe(false);
    expect(settings.listSteerOperations(scope, BINDING.applicationThreadId).has(steerId)).toBe(false);
    await handle.close();
  });

  it("keeps a persisted enqueue echo unaccepted across restart until native consumption is recorded", async () => {
    const settings = repository();
    const scope = { tenantId: BINDING.tenantId, principalId: BINDING.ownerPrincipalId };
    settings.recordSteerOperation(scope, BINDING.applicationThreadId, steerId);
    const queuedUser = { ...initialUser, uuid: steerId, message: { role: "user", content: steerInput.text } } as SessionMessage;
    const first = createHandle(fixture(), vi.fn(), { settings, resumeSession: true, initialMessages: [initialUser, queuedUser] }).handle;
    const pending = await snapshot(first);
    expect(pending.orderedBackendTurnIds).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain(steerInput.text);
    expect(Object.values(pending.turnsById).flatMap(turn => turn.completionCorrelations ?? [])).not.toContain(steerId);
    await first.close();
    settings.associateSteerOperation(scope, BINDING.applicationThreadId, steerId, OPERATION_ID);
    const consumed = createHandle(fixture(), vi.fn(), { settings, resumeSession: true, initialMessages: [initialUser, queuedUser] }).handle;
    const observed = await snapshot(consumed);
    expect(observed.orderedBackendTurnIds).toHaveLength(1);
    expect(observed.turnsById[observed.orderedBackendTurnIds[0]!]!.completionCorrelations).toEqual([OPERATION_ID, steerId]);
    expect(JSON.stringify(observed)).toContain(steerInput.text);
    expect(settings.listSteerOperations({ ...scope, principalId: "wrong-owner" }, BINDING.applicationThreadId).size).toBe(0);
    await consumed.close();
  });

  it("does not treat an interrupt acknowledgment as steer materialization or replay it", async () => {
    const provider = fixture();
    const { handle } = createHandle(provider, vi.fn(), { initialMessages: [initialUser] });
    const original = await snapshot(handle);
    await handle.steer(steerInput);
    await provider.prompt()[Symbol.asyncIterator]().next();
    await handle.interrupt({ applicationOperationId: crypto.randomUUID(), expectedBackendTurnId: original.orderedBackendTurnIds[0]! });
    expect(await handle.steer(steerInput)).toMatchObject({ status: "pending_materialization" });
    expect(JSON.stringify(await snapshot(handle))).not.toContain(steerInput.text);
    expect(provider.controls.interrupt).toHaveBeenCalledOnce();
    await handle.close();
  });
});
