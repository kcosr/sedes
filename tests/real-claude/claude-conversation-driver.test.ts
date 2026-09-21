import { claudeTurnFailureDetailsMigration } from "../../src/server/db/migrations/109-claude-turn-failure-details.js";
import { claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { claudeSteerOperationsMigration } from "../../src/server/db/migrations/102-claude-steer-operations.js";
import { claudeTaskLifecycleMigration } from "../../src/server/db/migrations/100-claude-task-lifecycle.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Query,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBinding,
} from "../../src/server/backends/contracts.js";
import { ClaudeConversationBackendDriver } from "../../src/server/backends/claude/claude-conversation-driver.js";
import {
  OfficialClaudeSdkFacade,
  type ClaudeCliAuthStatus,
  type ClaudeQueryInput,
} from "../../src/server/backends/claude/claude-sdk-facade.js";
import { verifyClaudeRuntimeVersion } from "../../src/server/backends/claude/claude-release-guard.js";
import { probeClaudeSdkDirect } from "../../src/server/backends/claude/claude-sdk-probe.js";
import { ClaudeSdkRuntimeAdapter } from "../../src/server/backends/claude/claude-runtime-client.js";
import { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import type {
  BackendConversationEvent,
  BackendItem,
} from "../../src/shared/protocol/backend.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";
import { claudeSkillInvocationsMigration } from "../../src/server/db/migrations/072-claude-skill-invocations.js";
import type { BackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";

const REQUIRED_MODEL = "claude-sonnet-5";
const REQUIRED_EFFORT = "low";
const MODEL_TURN_TIMEOUT_MS = 240_000;
const DEFAULT_EXECUTABLE = "claude";
const temporaryRoots: string[] = [];
const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;
const agentTools: BackendAgentToolFacade = {
  eligibleCatalog: () => [],
  catalogSummaries: () => [],
  describeMany: () => [],
  readPolicy: () => ({
    enabled: false,
    presentation: { surface: "cli", mode: "progressive" },
    accessBoundary: "environment",
    enabledToolIds: [],
  }),
  invoke: async () => {
    throw new Error("real_claude_agent_tools_disabled");
  },
};

const scope = {
  tenantId: "real-claude-tenant",
  principalId: "real-claude-principal",
};

const instance: AgentBackendInstance = {
  id: "real-claude-instance",
  tenantId: scope.tenantId,
  kind: "claude_agent_sdk",
  label: "Real Claude",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: "0.3.274",
};

const connection: AgentConnectionProfile = {
  id: "real-claude-connection",
  tenantId: scope.tenantId,
  ownerPrincipalId: scope.principalId,
  templateId: "real-claude-template",
  kind: "claude_agent_sdk",
  backendInstanceId: instance.id,
  executionEnvironmentId: "real-claude-environment",
  label: "Real Claude",
  enabled: true,
  configurationRevision: 1,
};

afterAll(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Safety decorator: the live gate exercises production orchestration with no tools. */
class ToolDisabledOfficialClaudeSdkFacade extends OfficialClaudeSdkFacade {
  readonly persistentQueryOptions: ClaudeQueryInput["options"][] = [];
  readonly authStatuses: ClaudeCliAuthStatus[] = [];
  readonly resultMessages: SDKResultMessage[] = [];

  override async readCliAuthStatus(
    executablePath: string,
    timeoutMs: number,
    environment?: Readonly<Record<string, string | undefined>>,
    cwd?: string,
  ): Promise<ClaudeCliAuthStatus> {
    const status = await super.readCliAuthStatus(
      executablePath,
      timeoutMs,
      environment,
      cwd,
    );
    this.authStatuses.push(status);
    return status;
  }

  override createQuery(input: ClaudeQueryInput): Query {
    const options = {
      ...input.options,
      tools: [],
      strictMcpConfig: true,
      mcpServers: {},
    } satisfies ClaudeQueryInput["options"];
    if (options.persistSession !== false) {
      this.persistentQueryOptions.push(options);
    }
    return observeQuery(super.createQuery({ ...input, options }), (message) => {
      if (message.type === "result") this.resultMessages.push(message);
    });
  }
}

describe.sequential("real Claude subscription driver", () => {
  it("streams, persists, projects usage, and reopens one disposable Sonnet 5 low-effort session", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "sedes-real-claude-driver-"),
    );
    temporaryRoots.push(root);
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const workspace: ValidatedWorkspace = {
      canonicalPath: await realpath(workspacePath),
      authorityRevision: 0,
      summary: {
        id: `real-claude-workspace-${randomUUID()}`,
        environmentId: connection.executionEnvironmentId,
        displayName: "real-claude-workspace",
        displayPath: workspacePath,
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
    };
    const executablePath =
      process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? DEFAULT_EXECUTABLE;
    const configDirectory =
      process.env.SEDES_REAL_CLAUDE_CONFIG_DIRECTORY ??
      path.join(os.homedir(), ".claude");
    const sdk = new ToolDisabledOfficialClaudeSdkFacade();
    const childEnvironment = Object.freeze({
      ...process.env,
      CLAUDE_CONFIG_DIR: configDirectory,
    });

    // This is a no-prompt initialization. Refuse to spend provider capacity
    // unless the compatible externally authenticated subscription contract
    // matches.
    const preflight = await probeClaudeSdkDirect({
      sdk,
      executablePath,
      cwd: workspace.canonicalPath,
      timeoutMs: 30_000,
      environment: childEnvironment,
    });
    expect(() =>
      verifyClaudeRuntimeVersion(preflight.cliRelease),
    ).not.toThrow();
    expect(preflight.account.apiProvider).toBe("firstParty");
    expect(preflight.account.subscriptionType).toBeTruthy();
    expect(sdk.authStatuses[0]).toMatchObject({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
    });
    expect(sdk.authStatuses[0]?.subscriptionType).toBeTruthy();
    expect(sdk.authStatuses[0]?.apiKeySource).toBeUndefined();

    const database = new Database(":memory:");
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
      ) STRICT
    `);
    // Keep the live fixture aligned with the production-owned schema used by
    // history projection, including its immutability and scope constraints.
    database.exec(claudeSkillInvocationsMigration.sql);
    database.exec(`
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
      END
    `);
    database.exec(`
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
      ) STRICT
    `);
    database.exec(`
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
        PRIMARY KEY (
          tenant_id, owner_principal_id, application_thread_id
        )
      ) STRICT
    `);
    database.exec(claudeTurnFailureDetailsMigration.sql);
    database.exec(claudeTaskLifecycleMigration.sql);
  database.exec(claudeSteerOperationsMigration.sql);
    const settings = new ClaudeThreadRepository(database);
    const driver = new ClaudeConversationBackendDriver({
      instance,
      connection,
      runtimeClient: new ClaudeSdkRuntimeAdapter(sdk),
      executablePath,
      initializationTimeoutMs: 30_000,
      probeDirectory: configDirectory,
      permissionPolicy: { allowedModes: ["dontAsk"] },
      modelPolicy: compileBackendModelPolicy(
        { type: "catalog" },
        "model_effort",
      ),
      settings,
      toolProvenanceKey: new Uint8Array(32).fill(7),
      childEnvironment,
      agentToolSourceCapabilities,
      agentTools,
      attachmentProvenanceKey: new Uint8Array(32).fill(0x43),
    });
    let firstHandle:
      | Awaited<ReturnType<ClaudeConversationBackendDriver["attach"]>>
      | undefined;
    let reopenedHandle:
      | Awaited<ReturnType<ClaudeConversationBackendDriver["attach"]>>
      | undefined;

    try {
      const catalog = await driver.catalog({ scope, workspace });
      const eligible = catalog.models.filter(
        (model) =>
          model.id === REQUIRED_MODEL &&
          model.supportedReasoningEfforts?.includes(REQUIRED_EFFORT),
      );
      if (eligible.length !== 1) {
        throw new Error(
          `REAL_CLAUDE_BLOCKER: expected exactly one ${REQUIRED_MODEL}/${REQUIRED_EFFORT} catalog entry; found ${eligible.length}.`,
        );
      }

      const applicationThreadId = randomUUID();
      const applicationOperationId = randomUUID();
      const backendConversationId = randomUUID();
      settings.initialize(
        scope,
        applicationThreadId,
        {
          backendInstanceId: instance.id,
          connectionProfileId: connection.id,
          executionEnvironmentId: connection.executionEnvironmentId,
        },
        {
          model: REQUIRED_MODEL,
          effort: REQUIRED_EFFORT,
          permissionMode: "dontAsk",
        },
        Date.now(),
      );
      const created = await driver.create({
        scope,
        workspace,
        applicationThreadId,
        applicationOperationId,
        requestedBackendConversationId: backendConversationId,
        source: { kind: "user" },
        title: "Disposable Sedes real-Claude verification",
      });
      const binding: ConversationBinding = {
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        applicationThreadId,
        backendInstanceId: instance.id,
        connectionProfileId: connection.id,
        executionEnvironmentId: connection.executionEnvironmentId,
        backendConversationId,
        createdAt: new Date().toISOString(),
      };

      firstHandle = await driver.attach({
        scope,
        workspace,
        binding,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      // The session repeats the active-credential gate against the exact child
      // environment immediately before it creates the persistent query.
      expect(sdk.authStatuses.length).toBeGreaterThanOrEqual(2);
      expect(sdk.authStatuses.at(-1)?.subscriptionType).toBeTruthy();
      expect(sdk.authStatuses.at(-1)?.apiKeySource).toBeUndefined();
      const initial = await firstHandle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(initial.snapshot.orderedBackendTurnIds).toEqual([]);
      expect(sdk.persistentQueryOptions).toHaveLength(1);
      expect(sdk.persistentQueryOptions[0]).toMatchObject({
        model: REQUIRED_MODEL,
        effort: REQUIRED_EFFORT,
        tools: [],
        disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
        strictMcpConfig: true,
        mcpServers: {},
      });
      const events: BackendConversationEvent[] = [];
      const prematureTerminalEvents: BackendConversationEvent[] = [];
      const submissionOperationId = randomUUID();
      const unsubscribe = initial.subscribeFromNext(({ event }) => {
        events.push(event);
        if ((event.type === "turn_completed" || event.type === "run_state_changed" && event.state === "idle") &&
            !sdk.resultMessages.some(message => claudeResultUserMessageIds(message).includes(submissionOperationId))) {
          prematureTerminalEvents.push(event);
        }
      });
      try {
        await firstHandle.submit({
          applicationOperationId: submissionOperationId,
          mutationId: randomUUID(),
          source: { kind: "user" },
          reconciliationToken: randomUUID(),
          text: "Reply with exactly SEDES_CLAUDE_LIVE_OK. Do not use tools.",
          contextExcerpts: [],
          attachments: [],
          taskContexts: [],
        });
        await waitFor(
          () =>
            sdk.resultMessages.some((message) => message.num_turns > 0) &&
            events.some(
              (event) =>
                event.type === "turn_completed" &&
                event.turn.status === "completed",
            ),
          () => {
            const failedResult = sdk.resultMessages.find(
              (message) => message.num_turns > 0 && message.is_error,
            );
            if (failedResult) {
              return `REAL_CLAUDE_FAILURE: provider result was ${failedResult.terminal_reason ?? failedResult.subtype}.`;
            }
            const failedRun = events.find(
              (event) =>
                event.type === "run_state_changed" && event.state === "failed",
            );
            if (failedRun) {
              return "REAL_CLAUDE_FAILURE: provider terminal result marked the run failed.";
            }
            const failed = events.find(
              (event) =>
                event.type === "turn_completed" &&
                event.turn.status !== "completed",
            );
            return failed
              ? `REAL_CLAUDE_FAILURE: terminal turn was ${failed.type === "turn_completed" ? failed.turn.status : "unknown"}.`
              : undefined;
          },
        );
      } finally {
        unsubscribe();
      }

      expect(prematureTerminalEvents).toEqual([]);
      expect(events.filter(event => event.type === "turn_completed")).toHaveLength(1);

      // Claude may deliver a short response as one complete assistant message
      // even when partial messages are requested.
      expect(
        events.some(
          (event) =>
            event.type === "item_started" ||
            event.type === "item_updated" ||
            event.type === "item_completed",
        ),
      ).toBe(true);
      const settled = await firstHandle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(settled.snapshot.runState).toBe("idle");
      expect(settled.snapshot.orderedBackendTurnIds).toHaveLength(1);
      expect(JSON.stringify(settled.snapshot.itemsById)).toContain(
        "SEDES_CLAUDE_LIVE_OK",
      );
      // The real SDK supplies native message identity; the persisted success
      // receipt must classify its complete response before turn completion.
      expect(finalAssistantText(settled.snapshot.itemsById)).toContain(
        "SEDES_CLAUDE_LIVE_OK",
      );
      const finalItemEventIndex = events.findIndex(
        (event) =>
          (event.type === "item_updated" || event.type === "item_completed") &&
          event.item.semanticKind === "assistant_message" &&
          event.item.responsePhase === "final" &&
          event.item.markdown.text.includes("SEDES_CLAUDE_LIVE_OK"),
      );
      expect(finalItemEventIndex).toBeGreaterThanOrEqual(0);
      expect(
        events.findIndex((event) => event.type === "turn_completed"),
      ).toBeGreaterThan(finalItemEventIndex);
      const history = await firstHandle.history({ limit: 10 });
      expect(history.orderedBackendTurnIds).toEqual(
        settled.snapshot.orderedBackendTurnIds,
      );
      expect(JSON.stringify(history.itemsById)).toContain(
        "SEDES_CLAUDE_LIVE_OK",
      );
      expect(finalAssistantText(history.itemsById)).toBe(
        finalAssistantText(settled.snapshot.itemsById),
      );
      const usage = await firstHandle.usage();
      expect(usage.tokens?.input).toBeGreaterThan(0);
      expect(usage.tokens?.output).toBeGreaterThan(0);
      expect(usage.counters?.assistantMessages).toBeGreaterThan(0);
      expect(sdk.persistentQueryOptions).not.toHaveLength(0);
      expect(
        sdk.persistentQueryOptions.every(
          (options) =>
            Array.isArray(options.tools) &&
            options.tools.length === 0 &&
            options.strictMcpConfig === true &&
            Object.keys(options.mcpServers ?? {}).length === 0,
        ),
      ).toBe(true);

      // The foreground turn settled before Steer reaches the provider. Native
      // next must deliver to this conversation without an invented turn fence.
      const steerId = randomUUID();
      expect(await firstHandle.steer({ applicationOperationId: steerId, mutationId: randomUUID(),
        reconciliationToken: randomUUID(), target: { kind: "conversation" },
        text: "Reply with exactly SEDES_CLAUDE_STEER_OK. Do not use tools.", contextExcerpts: [], attachments: [], taskContexts: [] }))
        .toMatchObject({ completionCorrelation: steerId });
      await waitFor(() => sdk.resultMessages.some(message => claudeResultUserMessageIds(message).includes(steerId)), () => undefined);
      const afterSteer = await firstHandle.establishProjection({ signal: new AbortController().signal });
      expect(afterSteer.snapshot.runState).toBe("idle");
      const steerTurn = Object.values(afterSteer.snapshot.turnsById).find(turn => turn.completionCorrelations?.includes(steerId));
      expect(steerTurn?.status).toBe("completed");
      expect(afterSteer.snapshot.orderedBackendTurnIds).toHaveLength(2);
      expect(finalAssistantText(afterSteer.snapshot.itemsById)).toContain(
        "SEDES_CLAUDE_STEER_OK",
      );
      await firstHandle.close();
      firstHandle = undefined;
      reopenedHandle = await driver.attach({
        scope,
        workspace,
        binding,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const reopened = await reopenedHandle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(reopened.snapshot.runState).toBe("idle");
      expect(reopened.snapshot.orderedBackendTurnIds).toEqual(
        afterSteer.snapshot.orderedBackendTurnIds,
      );
      expect(JSON.stringify(reopened.snapshot.itemsById)).toContain(
        "SEDES_CLAUDE_LIVE_OK",
      );
      expect(finalAssistantText(reopened.snapshot.itemsById)).toBe(
        finalAssistantText(afterSteer.snapshot.itemsById),
      );
      expect((await reopenedHandle.usage()).tokens?.output).toBeGreaterThan(0);
      expect(Object.values(reopened.snapshot.turnsById).find(turn => turn.completionCorrelations?.includes(steerId))?.status).toBe("completed");
    } finally {
      await firstHandle?.close();
      await reopenedHandle?.close();
      await driver.close();
      database.close();
    }
  });
});

function finalAssistantText(items: Readonly<Record<string, BackendItem>>): string {
  return Object.values(items)
    .flatMap((item) =>
      item.semanticKind === "assistant_message" && item.responsePhase === "final"
        ? [item.markdown.text]
        : [],
    )
    .join("\n\n");
}

async function waitFor(
  predicate: () => boolean,
  terminalFailure: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + MODEL_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const failure = terminalFailure();
    if (failure) throw new Error(failure);
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "REAL_CLAUDE_FAILURE: timed out waiting for the terminal turn.",
  );
}

function observeQuery(
  query: Query,
  onMessage: (message: SDKMessage) => void,
): Query {
  let observed: Query;
  observed = new Proxy(query, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return () => observed;
      if (property === "next") {
        return async (...arguments_: Parameters<Query["next"]>) => {
          const result = await target.next(...arguments_);
          if (!result.done) onMessage(result.value);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return observed;
}
