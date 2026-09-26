import { UsageService } from "../../src/server/usage/usage-service.js";
import { expectBackendSessionSummary } from "../support/backend-session-summary.js";
import type {
  Options,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "../../src/server/backends/contracts.js";
import { ClaudeBackendModule } from "../../src/server/backends/claude/claude-backend-module.js";
import { ClaudeSdkRuntimeAdapter } from "../../src/server/backends/claude/claude-runtime-client.js";
import { claudeConfigDirectory } from "../../src/server/backends/claude/claude-child-environment.js";
import type {
  ClaudeQueryInput,
  ClaudeSdkFacade,
} from "../../src/server/backends/claude/claude-sdk-facade.js";
import { probeClaudeSdkDirect } from "../../src/server/backends/claude/claude-sdk-probe.js";
import { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import { LateBoundBackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import {
  DatabaseActorTargetResolver,
  DatabaseConversationTargetStore,
  DatabaseLifecycleTargetResolver,
  DatabaseThreadApplicationQueueReader,
  DatabaseThreadApplicationRecoveryReader,
} from "../../src/server/conversations/database-conversation-adapters.js";
import {
  DatabaseThreadApplicationInventoryReader,
  DatabaseThreadApplicationPresentationReader,
  directThreadExecutionWorkspaceReader,
} from "../../src/server/conversations/database-thread-application-readers.js";
import { ConversationActorManager } from "../../src/server/conversations/conversation-actor-manager.js";
import { ConversationLifecycleService } from "../../src/server/conversations/conversation-lifecycle-service.js";
import {
  ActorBackedThreadApplicationConversationReader,
  ThreadApplicationService,
} from "../../src/server/conversations/thread-application-service.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { convertLegacyConfiguration } from "../../src/server/config/legacy-configuration-import.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { unavailableEnvironmentOperations } from "../../src/server/execution/environment-operations.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { initializeBackendModuleRuntimes } from "../../src/server/runtime/backend-module-startup.js";
import { StartupResourceStack } from "../../src/server/runtime/startup-resource-stack.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

const CLAUDE_CONFIG_DIRECTORY = claudeConfigDirectory(process.env);
import { threadAgentToolPolicyReaderDependencies } from "../support/thread-agent-tool-policy.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";

const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const MUTATION_ID = "33333333-3333-4333-8333-333333333333";
const ASSISTANT_ID = "44444444-4444-4444-8444-444444444444";

class AsyncMessageQueue implements AsyncIterable<SDKMessage> {
  readonly #values: SDKMessage[] = [];
  readonly #waiters: Array<(value: IteratorResult<SDKMessage>) => void> = [];
  #closed = false;

  push(value: SDKMessage): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
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

class FakeClaudeSdk implements ClaudeSdkFacade {
  deferResult = false;
  emitDuringTurn: ((message: SDKMessage) => void) | undefined;
  finishTurn: (() => void) | undefined;
  readonly createQuery = vi.fn((input: ClaudeQueryInput): Query =>
    this.#query(input),
  );
  readonly getSessionMessages = vi.fn(
    async (sessionId: string): Promise<SessionMessage[]> =>
      structuredClone(this.#sessions.get(sessionId) ?? []),
  );
  readonly renameSession = vi.fn(async () => undefined);
  readonly #sessions = new Map<string, SessionMessage[]>();

  async readCliRelease(): Promise<string> {
    return "2.1.274";
  }

  async readCliAuthStatus() {
    return {
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
    } as const;
  }

  async listSessions() {
    return [];
  }

  async getSessionInfo(sessionId: string) {
    const messages = this.#sessions.get(sessionId);
    return messages
      ? {
          sessionId,
          summary: "Claude integration thread",
          lastModified: 1,
          cwd: process.cwd(),
        }
      : undefined;
  }

  async forkSession() {
    return { sessionId: "55555555-5555-4555-8555-555555555555" };
  }

  #query(input: ClaudeQueryInput): Query {
    const queue = new AsyncMessageQueue();
    const close = queue.close.bind(queue);
    const sessionId = (input.options.sessionId ??
      input.options.resume) as string;
    queue.push(systemInit(sessionId, input.options));
    if (input.options.persistSession) {
      void this.#answerPrompts(
        sessionId,
        input.prompt as AsyncIterable<SDKUserMessage>,
        queue,
      );
    }
    const initialization = {
      commands: [],
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [
        {
          value: "default",
          resolvedModel: "claude-sonnet-5",
          displayName: "Claude Sonnet 5",
          description: "Integration fixture model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ],
      account: {
        apiProvider: "firstParty",
        subscriptionType: "Claude Max",
        tokenSource: "oauth",
      },
    } satisfies SDKControlInitializeResponse;
    return Object.assign(queue, {
      initializationResult: async () => initialization,
      interrupt: async () => ({ still_queued: [] }),
      setModel: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      applyFlagSettings: vi.fn(async () => undefined),
      close,
    }) as unknown as Query;
  }

  async #answerPrompts(
    sessionId: string,
    prompts: AsyncIterable<SDKUserMessage>,
    queue: AsyncMessageQueue,
  ): Promise<void> {
    for await (const prompt of prompts) {
      if (prompt.isSynthetic && prompt.shouldQuery === false) continue;
      const user = {
        ...prompt,
        parent_tool_use_id: null,
        parent_agent_id: null,
      } as SessionMessage & SDKMessage;
      const assistant = {
        type: "assistant",
        uuid: ASSISTANT_ID,
        session_id: sessionId,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          id: "fixture-message",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: "Claude answered through Sedes." }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 5 },
        },
      } as unknown as SessionMessage & SDKMessage;
      this.#sessions.set(sessionId, [user, assistant]);
      queue.push(user);
      queue.push(assistant);
      this.emitDuringTurn = (message) => {
        if (message.type === "assistant" || message.type === "user") {
          this.#sessions.get(sessionId)!.push(message as unknown as SessionMessage);
        }
        queue.push(message);
      };
      this.finishTurn = () => {
        queue.push({
          type: "result", subtype: "success", uuid: crypto.randomUUID(), session_id: sessionId,
          user_message_uuid: prompt.uuid, user_message_uuids: [prompt.uuid], terminal_reason: "completed",
          num_turns: 1, result: "Claude answered through Sedes.", is_error: false,
          duration_ms: 1, duration_api_ms: 1, stop_reason: "end_turn", total_cost_usd: 0,
          usage: {}, modelUsage: {}, permission_denials: [],
        } as unknown as SDKMessage);
        queue.push({
          type: "system",
          subtype: "session_state_changed",
          state: "idle",
          uuid: crypto.randomUUID(),
          session_id: sessionId,
        });
      };
      if (!this.deferResult) this.finishTurn();
    }
  }
}

function systemInit(sessionId: string, options: Options): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "oauth",
    claude_code_version: "2.1.274",
    cwd: options.cwd!,
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId || crypto.randomUUID(),
  };
}

function backendInstance(
  record: ReturnType<BackendConfigurationRepository["getBackend"]>,
): AgentBackendInstance {
  return { ...record, enabled: record.enabled === 1 };
}

function connectionProfile(
  record: ReturnType<BackendConfigurationRepository["getProfile"]>,
): AgentConnectionProfile {
  return { ...record, enabled: record.enabled === 1 };
}

describe("Claude production application integration", () => {
  it("creates, submits, persists, projects, and fails closed through normalized application services", async () => {
    const database = openOverlayDatabase(":memory:");
    const resources = new StartupResourceStack();
    const sdk = new FakeClaudeSdk();
    sdk.deferResult = true;
    let actors: ConversationActorManager | undefined;
    let releaseObservedActor: (() => void) | undefined;
    let execution: LocalExecutionEnvironment | undefined;
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      const legacyInventory = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = legacyInventory.getLocalEnvironment(scope);
      const workspace = legacyInventory.rememberWorkspace(
        scope,
        {
          environmentId: environment.id,
          canonicalPath: process.cwd(),
          displayName: "Claude integration workspace",
          availability: "available",
          trustState: "trusted",
        },
        100,
      );
      const configuration = parseResolvedBackendConfiguration({
        schemaVersion: 10,
        executionEnvironments: [
          { id: environment.id, kind: "local", label: "Local" },
        ],
        backends: [
          {
            id: "pi-cutover",
            kind: "pi",
            label: "Pi",
            enabled: true,
            modelPolicy: { type: "catalog" },
          },
          {
            id: "claude-primary",
            kind: "claude_agent_sdk",
            label: "Claude",
            enabled: true,
            modelPolicy: { type: "catalog" },
            moduleConfiguration: {
              executablePath: process.execPath,
              configDirectory: CLAUDE_CONFIG_DIRECTORY,
              permissionPolicy: {
                allowedModes: [
                  "default",
                  "acceptEdits",
                  "dontAsk",
                  "auto",
                  "bypassPermissions",
                ],
              },
            },
          },
        ],
        targets: [
          {
            id: "pi-local",
            kind: "pi_sdk",
            label: "Local Pi",
            backendInstanceId: "pi-cutover",
            executionEnvironmentId: environment.id,
            enabled: true,
          },
          {
            id: "claude-local",
            kind: "claude_agent_sdk",
            label: "Local Claude",
            backendInstanceId: "claude-primary",
            executionEnvironmentId: environment.id,
            enabled: true,
            moduleConfiguration: {
              defaults: { permissionMode: "default" },
            },
          },
        ],
        defaultTargetId: "pi-local",
      });
      applyBackendNormalizationMigration(database, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 200,
      });
      applyDatabaseMigrations(database, backendNormalizedMigrations);

      const configurationRepository = new BackendConfigurationRepository(
        database,
      );
      const converted = convertLegacyConfiguration({
        configuration,
        localWorkspaceRoots: [process.cwd()],
        sourceLabel: "Claude integration fixture",
      });
      const catalog = compiledBackendModuleCatalog;
      const projection = new ConfigurationProjection(database, {
        pi: catalog.protocolReleaseForBackendKind("pi"),
        codex_app_server: catalog.protocolReleaseForBackendKind("codex_app_server"),
        claude_agent_sdk: catalog.protocolReleaseForBackendKind("claude_agent_sdk"),
        grok_build: catalog.protocolReleaseForBackendKind("grok_build"),
      }, () => 300);
      new ConfigurationRepository(database, () => 300).initialize(scope,
        converted.document,
        { sourceFingerprint: converted.sourceFingerprint, sourceLabel: "Claude integration fixture" },
        () => {
          projection.adoptLegacyOwnership(scope);
          projection.project(scope, converted.document);
        },
      );
      const inventory = new InventoryRepository(database);
      const currentEnvironment = inventory.updateEnvironmentAvailability(scope,
        environment.id, { available: true, now: 300 });
      inventory.upsertWorkspace(scope, {
        id: workspace.id,
        environmentId: environment.id,
        canonicalPath: process.cwd(),
        displayName: "Claude integration workspace",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision:
          currentEnvironment.configurationRevision,
        now: 301,
      });
      const instance = backendInstance(
        configurationRepository.getBackend(scope, "claude-primary"),
      );
      const connection = connectionProfile(
        configurationRepository.getProfileByTemplate(scope, "claude-local"),
      );
      const configuredBackend = configuration.backends.find(
        ({ id }) => id === "claude-primary",
      )!;
      const runtimeClient = new ClaudeSdkRuntimeAdapter(sdk);
      const prepared = new ClaudeBackendModule({
        createRuntimeClient: () => ({
          client: runtimeClient,
          close: () => undefined,
        }),
      }).prepare({
        backend: configuredBackend,
        connections: configuration.targets.filter(
          ({ backendInstanceId }) => backendInstanceId === "claude-primary",
        ),
        executionEnvironments: [{ id: environment.id, kind: "local" }],
        environment: process.env,
      });
      execution = new LocalExecutionEnvironment({
        environmentId: environment.id,
        scope,
        allowedRoots: [process.cwd()],
        workspaceTrusted: () => true,
        configurationRevision: currentEnvironment.configurationRevision,
        activeConfigurationRevision: () =>
          currentEnvironment.configurationRevision,
      });
      const registry = new AgentBackendRegistry();
      const usage = new UsageService(database, {enabled: true});
      const runtimeModules = await initializeBackendModuleRuntimes({
        usage,
        preparedModules: [prepared],
        database,
        scope,
        instances: [instance],
        connections: [connection],
        environmentChannels: new Map([
          [
            environment.id,
            new LocalEnvironmentChannelProvider({
              scope,
              executionEnvironmentId: environment.id,
            }),
          ],
        ]),
        environmentOperations: new Map([
          [
            environment.id,
            unavailableEnvironmentOperations({
              environmentId: environment.id,
              environmentKind: "local",
              environmentLabel: environment.label,
            }),
          ],
        ]),
        toolProvenanceKey: new Uint8Array(32),
        agentTools: new LateBoundBackendAgentToolFacade(),
        outputArtifacts: {} as never,
        viewedImageCapture: {} as never,
        agentToolSourceCapabilities,
        agentToolCli: new Map([
          [
            environment.id,
            { availability: "unavailable", reason: "cli_unavailable" },
          ],
        ]),
        registry,
        resources,
      });
      expect(registry.supportsConversationCreation(connection)).toBe(true);
      expect(registry.creationIdentity(connection).assignment).toBe(
        "application",
      );

      const bindings = new ConversationBindingRepository(database);
      const targets = new DatabaseConversationTargetStore({
        database,
        bindings,
        bindingDetails: runtimeModules.bindingDetails,
        registry,
        environments: execution,
      });
      targets.bindWorkspacePublications({
        handoffAuthoritativeReplacement: () => undefined,
      });
      actors = new ConversationActorManager({
        environments: execution,
        attachmentDelivery: {} as never,
        retentionMilliseconds: 60_000,
        runtimeBudget: 8,
      });
      const drafts = new ConversationDraftRepository(database);
      const completion = new SubmissionCompletionRepository(database);
      const lifecycle = new ConversationLifecycleService({
        registry,
        targets: new DatabaseLifecycleTargetResolver(targets),
        backendPersistence: runtimeModules.threadPersistence,
        bindings,
        creation: new ConversationCreationRepository(database),
        drafts,
        completion,
        actors,
        now: (() => {
          let now = 1_000;
          return () => ++now;
        })(),
        id: () => SESSION_ID,
      });
      const resolvedTarget = await new DatabaseLifecycleTargetResolver(
        targets,
      ).resolveNew(scope, {
        workspaceId: workspace.id,
        connectionProfileId: connection.id,
      });
      await probeClaudeSdkDirect({
        sdk,
        executablePath: process.execPath,
        cwd: resolvedTarget.workspace.canonicalPath,
        timeoutMs: 1_000,
        environment: {},
      });
      expect(
        await registry.driver(connection).catalog({
          scope,
          workspace: resolvedTarget.workspace,
        }),
      ).toMatchObject({
        models: [
          expect.objectContaining({
            id: "claude-sonnet-5",
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "low",
          }),
        ],
      });
      const created = await lifecycle.createServerDraft(scope, {
        id: THREAD_ID,
        workspaceId: workspace.id,
        connectionProfileId: connection.id,
        title: "Subscription-backed Claude",
        initialText: "Answer through the normalized lifecycle.",
      });
      expect(created.draft.revision).toBe(0);

      await expect(
        lifecycle.startFirstSend(scope, created.applicationThreadId, {
          attemptId: "claude-first-attempt",
          mutationId: MUTATION_ID,
          expectedThreadRevision: 0,
          expectedDraftRevision: created.draft.revision,
        }),
      ).resolves.toMatchObject({
        status: "bound",
        binding: { backendConversationId: SESSION_ID },
      });
      expect(
        runtimeModules.bindingDetails
          .get(instance.id)!
          .getBindingDetail(scope, created.applicationThreadId),
      ).toBe(`{"version":1,"sessionId":"${SESSION_ID}"}`);

      const queue = new QueuedInputRepository(database);
      const threads = new ThreadApplicationService({
    usage,
        inventory: new DatabaseThreadApplicationInventoryReader({
          inventory,
          queue,
          completion,
          ...threadAgentToolPolicyReaderDependencies(database),
          directoryBrowsingAvailability: () => "unavailable",
          executionWorkspaces: directThreadExecutionWorkspaceReader,
        }),
        conversations: new ActorBackedThreadApplicationConversationReader({
          actors,
          targets: new DatabaseActorTargetResolver(targets),
        }),
        queue: new DatabaseThreadApplicationQueueReader(queue),
        presentation: new DatabaseThreadApplicationPresentationReader({
          targets,
          providers: runtimeModules.presentation,
        }),
        recovery: new DatabaseThreadApplicationRecoveryReader({
          creation: new ConversationCreationRepository(database),
          operations: new ConversationOperationRepository(database),
          targets: new DatabaseLifecycleTargetResolver(targets),
          registry,
          forks: { readRecovery: async () => ({ recoverable: false }) },
        }),
        interactions: { listPending: () => [] },
        actionPersistence: runtimeModules.actionPersistence,
        attachmentDelivery: { supports: () => false },
      });
      const observed = await actors.acquire(
        await new DatabaseActorTargetResolver(targets).resolve(scope, created.applicationThreadId),
        { idleRelease: "retain" },
      );
      releaseObservedActor = observed.release;
      const activeGeneration = observed.actor.timeline.generation;
      const assertActiveControls = async () => {
        const current = await threads.snapshot(scope, created.applicationThreadId);
        expect(observed.actor.timeline.generation).toBe(activeGeneration);
        expect(current.runState).toBe("running");
        expect(current.capabilities.deliveryModes).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "steer", available: true }),
          expect.objectContaining({ id: "queue", available: true }),
        ]));
        expect(current.capabilities.operations).toContainEqual(expect.objectContaining({ id: "interrupt", available: true }));
        return current;
      };
      await assertActiveControls();
      sdk.emitDuringTurn!({ type: "system", subtype: "background_tasks_changed",
        uuid: crypto.randomUUID(), session_id: SESSION_ID,
        tasks: [{ task_id: "background-agent", task_type: "local_agent", description: "Background check" }],
      } as SDKMessage);
      const idlePulse = () => sdk.emitDuringTurn!({ type: "system", subtype: "session_state_changed",
        state: "idle", uuid: crypto.randomUUID(), session_id: SESSION_ID });
      const assistantFrame = (content: unknown[], stop_reason: string) => ({
        type: "assistant", uuid: crypto.randomUUID(), session_id: SESSION_ID,
        parent_tool_use_id: null, parent_agent_id: null,
        message: { id: crypto.randomUUID(), role: "assistant", content, stop_reason,
          type: "message", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 }, stop_sequence: null },
      }) as unknown as SDKMessage;
      // Background child traffic must not invalidate the main projection.
      sdk.emitDuringTurn!({ ...assistantFrame([{ type: "text", text: "Child-only work" }], "end_turn"),
        parent_tool_use_id: "background-agent-launch", subagent_type: "general-purpose",
      } as SDKMessage);
      sdk.emitDuringTurn!({ type: "user", uuid: crypto.randomUUID(), session_id: SESSION_ID,
        parent_tool_use_id: "background-agent-launch", message: { role: "user", content: "Child-only input" },
      } as SDKMessage);
      // Assistant frames and SDK scheduler idle pulses do not end the request.
      idlePulse();
      sdk.emitDuringTurn!(assistantFrame([{ type: "tool_use", id: "read-active", name: "Read", input: { file_path: "/workspace/file" } }], "tool_use"));
      sdk.emitDuringTurn!({ type: "user", uuid: crypto.randomUUID(), session_id: SESSION_ID, parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-active", content: "File read complete" }] },
      } as SDKMessage);
      idlePulse();
      sdk.emitDuringTurn!(assistantFrame([{ type: "text", text: "Still checking the active request." }], "end_turn"));
      idlePulse();
      await vi.waitFor(async () => {
        const current = await assertActiveControls();
        expect(JSON.stringify(current.itemsById)).toContain("Still checking the active request.");
        expect(current.backgroundActivity).toMatchObject({ state: "known", agents: 1 });
        expect(JSON.stringify(current.itemsById)).not.toContain("Child-only");
      });
      sdk.finishTurn!();
      await vi.waitFor(async () => expect((await threads.snapshot(scope, created.applicationThreadId)).runState).toBe("idle"));
      expectBackendSessionSummary(database, scope, created.applicationThreadId, SESSION_ID);
      const snapshot = await threads.snapshot(scope, created.applicationThreadId);
      expect(observed.actor.timeline.generation).toBe(activeGeneration);
      expect(snapshot.backgroundActivity).toMatchObject({ state: "known", agents: 1 });
      expect(snapshot.capabilities.operations).toContainEqual(expect.objectContaining({ id: "interrupt", available: false }));
      expect(snapshot).toMatchObject({
        backendSessionId: SESSION_ID,
        thread: {
          title: { text: "Subscription-backed Claude" },
          backingState: "bound",
        },
        orderedTurnIds: [expect.any(String)],
        capabilities: {
          backend: { label: { text: "Claude" }, brand: "claude" },
          deliveryModes: expect.arrayContaining([
            expect.objectContaining({ id: "submit", available: true }),
          ]),
          settings: expect.arrayContaining([
            expect.objectContaining({ id: "model", available: true }),
            expect.objectContaining({ id: "thinking_level", available: true }),
          ]),
        },
        settings: {
          values: [
            expect.objectContaining({
              id: "model",
              desiredValue: "claude-sonnet-5",
              effectiveValue: "claude-sonnet-5",
              applicationState: "effective",
            }),
            expect.objectContaining({
              id: "thinking_level",
              desiredValue: "low",
              effectiveValue: "low",
              applicationState: "effective",
            }),
          ],
        },
      });
      expect(Object.values(snapshot.itemsById)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "assistant_message",
            markdown: { text: "Claude answered through Sedes." },
          }),
        ]),
      );
      expect(snapshot.capabilities.operations.map(({ id }) => id)).toContain(
        "rename",
      );
      expect(snapshot.capabilities.operations.map(({ id }) => id)).toContain(
        "attach_automation",
      );
      expect(
        snapshot.capabilities.operations.map(({ id }) => id),
      ).not.toContain("clone");
      expect(
        snapshot.capabilities.deliveryModes.map(({ id }) => id),
      ).toContain("steer");
      expect(snapshot.capabilities.providerFeatures).toEqual([
        expect.objectContaining({
          ref: { featureId: "claude.permissions", schemaVersion: 1 },
          availability: "available",
        }),
      ]);
      expect(snapshot.providerFeatures).toEqual([
        expect.objectContaining({
          ref: { featureId: "claude.permissions", schemaVersion: 1 },
          state: expect.objectContaining({ kind: "object" }),
        }),
      ]);
      expect(sdk.createQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            pathToClaudeCodeExecutable: process.execPath,
            permissionMode: "default",
            allowDangerouslySkipPermissions: true,
          }),
        }),
      );
    } finally {
      releaseObservedActor?.();
      await actors?.close().catch(() => undefined);
      await resources.dispose().catch(() => undefined);
      execution?.close();
      database.close();
    }
  });
});
