import { readFile, writeFile, unlink } from "node:fs/promises";
import { ViewedImageCaptureService } from "../../src/server/output-artifacts/viewed-image-capture.js";
import { UsageService } from "../../src/server/usage/usage-service.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { EnvironmentVariablesService } from "../../src/server/environment-variables/environment-variables-service.js";
import { HostPairingRepository } from "../../src/server/host-pairing/host-pairing-repository.js";
import type { HostPairingAdministration } from "../../src/server/configuration-admin/host-pairing-routes.js";
import { registerHostRequestSchema } from "../../src/shared/protocol/host-pairing.js";
import { QuestionRequestService } from "../../src/server/domain/question-request-service.js";
import { QuestionRequestRepository } from "../../src/server/db/repositories/question-request-repository.js";
import {
  benchmarkHistory,
  benchmarkStreamItems,
} from "../performance/codex-browser-fixture.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type Database from "better-sqlite3";
import express from "express";
import { z } from "zod";
import type {
  Options as ClaudeOptions,
  Query as ClaudeQuery,
  SDKControlInitializeResponse as ClaudeInitialization,
  SDKMessage as ClaudeMessage,
  SDKUserMessage as ClaudeUserMessage,
  SessionMessage as ClaudeSessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  APPLICATION_ASSIGNED_CREATION_IDENTITY,
  BackendError,
} from "../../src/server/backends/contracts.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  BranchConversationInput,
  ConversationHandle,
  CreateConversationResult,
  RegisteredBackendActionInput,
  SteerTurnInput,
  SteerTurnResult,
} from "../../src/server/backends/contracts.js";
import type { ThreadApplicationOperation } from "../../src/shared/protocol/api.js";
import { CodexBackendThreadPersistenceAdapter } from "../../src/server/backends/codex/codex-backend-thread-persistence-adapter.js";
import { CodexSavedAgentBackendAdapter } from "../../src/server/backends/codex/codex-saved-agent-adapter.js";
import type { CodexExecutionSettingsProvider } from "../../src/server/backends/codex/codex-conversation-handle.js";
import type {
  CodexExecutionPolicyAllowlist,
  CodexExecutionPolicySelection,
} from "../../src/server/backends/codex/codex-execution-policy.js";
import { CodexThreadExecutionSettingsRepository } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import { codexForkSettingsEligibility } from "../../src/server/backends/codex/codex-fork-settings-eligibility.js";
import { CodexFastModeSessionRegistry } from "../../src/server/backends/codex/codex-fast-mode-session.js";
import { ProviderFeatureMutationRepository } from "../../src/server/db/repositories/provider-feature-mutation-repository.js";
import {
  codexThreadReadMethod,
  projectCodexThread,
  type CodexThread,
} from "../../src/server/backends/codex/codex-c1-protocol.js";
import {
  CodexSharedClientFacade,
  type CodexReadyClientGeneration,
} from "../../src/server/backends/codex/codex-client-facade.js";
import { CodexBackendDriverFactory } from "../../src/server/backends/codex/codex-driver-factory.js";
import { unavailableCodexAgentToolCliEnvironmentProvider } from "../../src/server/backends/codex/codex-agent-tool-cli-environment.js";
import { CodexServerRequestRouter } from "../../src/server/backends/codex/codex-server-request-router.js";
import { CodexThreadActionPersistence } from "../../src/server/backends/codex/codex-thread-action-persistence.js";
import { CodexThreadPresentationProvider } from "../../src/server/backends/codex/codex-thread-presentation-provider.js";
import { CodexManagedTuiController } from "../../src/server/backends/codex/codex-managed-tui-controller.js";
import type {
  CodexInboundServerRequest,
  CodexRpcMethod,
  CodexRpcRequestOptions,
  CodexRpcRequestReceipt,
  CodexServerRequestHandler,
} from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import { CodexRpcDeliveryError } from "../../src/server/backends/codex/rpc/errors.js";
import {
  decodeCodexServerNotificationParams,
  decodeCodexServerRequestParams,
  type CodexAdoptedServerNotificationMethod,
} from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import { AgentBackendRegistry } from "../../src/server/backends/registry.js";
import { SavedAgentBackendAdapterRegistry } from "../../src/server/backends/saved-agent-adapter-registry.js";
import { PiSavedAgentAdapter } from "../../src/server/backends/pi/pi-saved-agent-adapter.js";
import { PiBackendThreadPersistenceAdapter } from "../../src/server/backends/pi/pi-backend-thread-persistence-adapter.js";
import { PiConversationRepository } from "../../src/server/backends/pi/pi-conversation-repository.js";
import { InMemoryConformanceDriver } from "../../src/server/backends/testing/in-memory-conformance-driver.js";
import {
  ApplicationSnapshotPublicationBoundary,
  ApplicationSnapshotService,
  ApplicationThreadChangePublisher,
} from "../../src/server/application/application-snapshot-service.js";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { DatabaseExecutionTargetReader } from "../../src/server/application/execution-target-reader.js";
import {
  directThreadExecutionWorkspaceAllocator,
  SavedAgentApplicationService,
} from "../../src/server/application/saved-agent-application-service.js";
import { loadBootstrapConfigurationFile } from "../../src/server/config/bootstrap-configuration.js";
import { configurationDocumentSchema } from "../../src/shared/protocol/configuration-admin.js";
import { initializeDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { createConfigurationAdminFixture } from "./configuration-admin-fixture.js";
import { loadConfig } from "../../src/server/config/config.js";
import {
  ConversationActorManager,
  type AuthoritativeCompletionObserver,
} from "../../src/server/conversations/conversation-actor-manager.js";
import {
  BackendDiscoveryService,
  EXHAUSTIVE_DISCOVERY_SCAN,
} from "../../src/server/conversations/backend-discovery-service.js";
import { ConversationLifecycleService } from "../../src/server/conversations/conversation-lifecycle-service.js";
import type { BackendThreadPersistenceAdapter } from "../../src/server/conversations/conversation-lifecycle-service.js";
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
  type ThreadBackendPresentationProvider,
} from "../../src/server/conversations/database-thread-application-readers.js";
import { InteractionBroker } from "../../src/server/conversations/interaction-broker.js";
import { RuntimeBackedQueuedInputConversationGateway } from "../../src/server/conversations/queued-input-conversation-gateway.js";
import { QueuedInputDispatcher } from "../../src/server/conversations/queued-input-dispatcher.js";
import { ThreadCompletionCallbackDispatcher } from "../../src/server/conversations/thread-completion-callback-dispatcher.js";
import {
  ActorBackedThreadApplicationConversationReader,
  ThreadApplicationService,
} from "../../src/server/conversations/thread-application-service.js";
import { ThreadMutationGateway } from "../../src/server/conversations/thread-mutation-gateway.js";
import type {
  BackendActionSettingsGuard,
  ThreadActionPersistenceProvider,
} from "../../src/server/conversations/thread-mutation-gateway.js";
import {
  QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY,
  type ProviderFeatureConcurrency,
} from "../../src/server/provider-features/contracts.js";
import type { ProviderFeatureRef } from "../../src/shared/protocol/provider-feature.js";
import { ThreadHistoryService } from "../../src/server/conversations/thread-history-service.js";
import { ThreadForkService } from "../../src/server/conversations/thread-fork-service.js";
import { prepareBackendNormalizedDatabase } from "../../src/server/db/backend-normalized-startup.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { BackendCheckpointRepository } from "../../src/server/db/repositories/backend-checkpoint-repository.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConnectionSettingPreferenceRepository } from "../../src/server/db/repositories/connection-setting-preference-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ConversationCreationRepository } from "../../src/server/db/repositories/conversation-creation-repository.js";
import { ConversationDraftRepository } from "../../src/server/db/repositories/conversation-draft-repository.js";
import { DeliveryInputSnapshotRepository } from "../../src/server/db/repositories/delivery-input-snapshot-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { ComposerAttachmentRepository } from "../../src/server/db/repositories/composer-attachment-repository.js";
import { OutputImageArtifactRepository } from "../../src/server/db/repositories/output-image-artifact-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationTurnBookmarkRepository } from "../../src/server/db/repositories/conversation-turn-bookmark-repository.js";
import { CannedPromptRepository } from "../../src/server/db/repositories/canned-prompt-repository.js";
import { ThreadGroupRepository } from "../../src/server/db/repositories/thread-group-repository.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import { ThreadTemplateRepository } from "../../src/server/db/repositories/thread-template-repository.js";
import { ThreadForceResetRepository } from "../../src/server/db/repositories/thread-force-reset-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { PrincipalApplicationPreferenceRepository } from "../../src/server/db/repositories/principal-application-preference-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { ThreadCompletionCallbackRepository } from "../../src/server/db/repositories/thread-completion-callback-repository.js";
import { ComposerAttachmentBlobStore } from "../../src/server/composer-attachments/blob-store.js";
import { ComposerAttachmentDeliveryService } from "../../src/server/composer-attachments/composer-attachment-delivery-service.js";
import { LocalExecutionAttachmentStager } from "../../src/server/composer-attachments/local-execution-attachment-stager.js";
import { ComposerAttachmentService } from "../../src/server/composer-attachments/service.js";
import { OutputArtifactBlobStore } from "../../src/server/output-artifacts/blob-store.js";
import { OutputArtifactService } from "../../src/server/output-artifacts/service.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { WorkspaceFileRootRepository } from "../../src/server/db/repositories/workspace-file-root-repository.js";
import { WorkspaceFileLinkedWorktreeRepository } from "../../src/server/db/repositories/workspace-file-linked-worktree-repository.js";
import { WorkspaceDiffReviewRepository } from "../../src/server/db/repositories/workspace-diff-review-repository.js";
import { ThreadLineageRepository } from "../../src/server/db/repositories/thread-lineage-repository.js";
import { DatabaseApplicationLineageSummaryReader } from "../../src/server/application/database-application-lineage-summary-reader.js";
import { AutomationService } from "../../src/server/domain/automation-service.js";
import { NotificationRepository } from "../../src/server/db/repositories/notification-repository.js";
import { NotificationService } from "../../src/server/domain/notification-service.js";
import { NotificationLifecycleObserver } from "../../src/server/domain/notification-lifecycle-observer.js";
import { InventoryService } from "../../src/server/domain/inventory-service.js";
import { ConversationTurnBookmarkService } from "../../src/server/domain/conversation-turn-bookmark-service.js";
import { CannedPromptService } from "../../src/server/domain/canned-prompt-service.js";
import { PrincipalApplicationPreferenceService } from "../../src/server/domain/principal-application-preference-service.js";
import { TaskService } from "../../src/server/domain/task-service.js";
import { WorkpadService } from "../../src/server/domain/workpad-service.js";
import { WorkpadRepository } from "../../src/server/db/repositories/workpad-repository.js";
import { updateWorkpadRequestSchema } from "../../src/shared/protocol/workpads.js";
import { SavedAgentService } from "../../src/server/domain/saved-agent-service.js";
import { ThreadTemplateApplicationService } from "../../src/server/application/thread-template-application-service.js";
import { WorkspaceFileService } from "../../src/server/domain/workspace-file-service.js";
import { WorkspaceDiffReviewService } from "../../src/server/domain/workspace-diff-review-service.js";
import { ThreadArchiveService } from "../../src/server/domain/thread-archive-service.js";
import { ThreadBulkInventoryService } from "../../src/server/domain/thread-bulk-inventory-service.js";
import { ThreadForceResetService } from "../../src/server/domain/thread-force-reset-service.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";
import { ThreadAttentionService } from "../../src/server/domain/thread-attention-service.js";
import { ThreadGroupService } from "../../src/server/domain/thread-group-service.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import { ThreadEventPresentation } from "../../src/server/events/thread-event-presentation.js";
import {
  ScopedThreadEventHubRegistry,
  ThreadRuntimeCoordinator,
} from "../../src/server/events/thread-runtime-coordinator.js";
import { ThreadSnapshotPublisher } from "../../src/server/events/thread-snapshot-publisher.js";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";
import { LocalWorkspaceFileProvider } from "../../src/server/workspace-files/local-workspace-file-provider.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { threadAgentToolPolicyReaderDependencies } from "../support/thread-agent-tool-policy.js";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { PrincipalAgentToolClientService } from "../../src/server/agent-tools/application/principal-agent-tool-client-service.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import type { BackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { PrincipalAgentToolClientRepository } from "../../src/server/db/repositories/principal-agent-tool-client-repository.js";
import { createPrincipalAgentToolClientEligibility } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import {
  AutomationQueueRunObserver,
  LifecycleAutomationConversationGateway,
} from "../../src/server/runtime/automation-conversation-gateway.js";
import {
  ApplicationDrainController,
  LongLivedHttpConnectionRegistry,
} from "../../src/server/runtime/application-shutdown.js";
import { DeferredProductionOperations } from "../../src/server/production-application.js";
import { ConversationLifecycleAutomationFirstInput } from "../../src/server/runtime/conversation-lifecycle-automation.js";
import { AutomationDispatcher } from "../../src/server/runtime/automation-dispatcher.js";
import { AutomationPrecheckExecutor } from "../../src/server/runtime/automation-precheck-executor.js";
import { createCsrfToken } from "../../src/server/security/http-security.js";
import { boundDisplayText } from "../../src/server/conversations/payload-policy.js";
import {
  ManagedTerminalAdmissionTokens,
  attachManagedTerminalCarrier,
  type ManagedTerminalResourceAuthority,
} from "../../src/server/terminal/managed-terminal-carrier.js";
import { TerminalRepository } from "../../src/server/terminals/terminal-repository.js";
import { TerminalJournalStore } from "../../src/server/terminals/terminal-journal.js";
import { TerminalService } from "../../src/server/terminals/terminal-service.js";
import {
  TerminalAdmissionTokens,
  attachTerminalCarrier,
} from "../../src/server/terminals/terminal-carrier.js";
import { CodexTuiE2eFixture } from "./codex-tui-fixture.js";
import { TerminalE2eFixture } from "./terminal-fixture.js";
import { installE2EServerProcessLifecycle } from "./server-process-lifecycle.js";
import { ClaudeBackendThreadPersistenceAdapter } from "../../src/server/backends/claude/claude-backend-thread-persistence-adapter.js";
import { ClaudeBackendDriverFactory } from "../../src/server/backends/claude/claude-driver-factory.js";
import { ClaudeSavedAgentBackendAdapter } from "../../src/server/backends/claude/claude-saved-agent-adapter.js";
import type {
  ClaudeQueryInput,
  ClaudeSdkFacade,
} from "../../src/server/backends/claude/claude-sdk-facade.js";
import { ClaudeSdkRuntimeAdapter } from "../../src/server/backends/claude/claude-runtime-client.js";
import { ClaudeThreadActionPersistence } from "../../src/server/backends/claude/claude-thread-action-persistence.js";
import { ClaudeModelEffortCatalog } from "../../src/server/backends/claude/claude-model-effort-catalog.js";
import { ClaudeThreadPresentationProvider } from "../../src/server/backends/claude/claude-thread-presentation-provider.js";
import { CLAUDE_PERMISSION_MODES } from "../../src/server/backends/claude/claude-permission-policy.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";

const claudePermissionPolicy = Object.freeze({
  allowedModes: CLAUDE_PERMISSION_MODES,
});
const claudeModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "model_effort",
);
const codexModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "model_effort",
);
const e2eBackendAgentTools: BackendAgentToolFacade = {
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
    throw new Error("e2e_backend_agent_tool_invocation_unexpected");
  },
};

class ClaudeE2eMessageQueue implements AsyncIterable<ClaudeMessage> {
  readonly #values: ClaudeMessage[] = [];
  readonly #waiters: Array<(value: IteratorResult<ClaudeMessage>) => void> = [];
  #closed = false;

  push(value: ClaudeMessage): void {
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

  [Symbol.asyncIterator](): AsyncIterator<ClaudeMessage> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { done: false, value };
        if (this.#closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<ClaudeMessage>>((resolve) =>
          this.#waiters.push(resolve),
        );
      },
    };
  }
}

/** Official-SDK-shaped Claude fixture; it never starts a provider process. */
class ClaudeE2eSdk implements ClaudeSdkFacade {
  readonly #sessions = new Map<string, ClaudeSessionMessage[]>();
  readonly #interruptions = new Map<string, () => void>();
  readonly #steerPrompts = new Map<string, string>();
  readonly #backgroundTasks = new Map<string, { taskId: string; toolId: string }>();

  async readCliRelease(): Promise<string> {
    return "2.1.283";
  }

  async readCliAuthStatus() {
    return {
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
    } as const;
  }

  createQuery(input: ClaudeQueryInput): ClaudeQuery {
    const queue = new ClaudeE2eMessageQueue();
    const close = queue.close.bind(queue);
    const sessionId = (input.options.sessionId ??
      input.options.resume ??
      crypto.randomUUID()) as string;
    queue.push(claudeSystemInit(sessionId, input.options));
    if (input.options.persistSession) {
      void this.#answerPrompts(
        sessionId,
        input.prompt as AsyncIterable<ClaudeUserMessage>,
        queue,
        input.options,
      );
    }
    const initialization = {
      commands: [
        {
          name: "review",
          description: "Review the current change",
          argumentHint: "[path]",
          aliases: [],
        },
      ],
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [
        {
          // Custom-thread creation may select only an authoritative provider
          // default. Keep the offline fixture shaped like the real Claude
          // initialization catalog instead of relying on first-row fallback.
          value: "default",
          resolvedModel: "claude-sonnet-5",
          displayName: "Claude Sonnet 5",
          description: "Offline browser fixture model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ],
      account: {
        apiProvider: "firstParty",
        subscriptionType: "Claude Max",
        tokenSource: "oauth",
      },
    } satisfies ClaudeInitialization;
    return Object.assign(queue, {
      initializationResult: async () => initialization,
      interrupt: async () => {
        this.#interruptions.get(sessionId)?.();
        return { still_queued: [] };
      },
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      applyFlagSettings: async () => undefined,
      close: () => { this.#interruptions.delete(sessionId); close(); },
    }) as unknown as ClaudeQuery;
  }

  async listSessions() {
    return [];
  }

  async getSessionInfo(sessionId: string) {
    return this.#sessions.has(sessionId)
      ? {
          sessionId,
          summary: "Claude browser fixture",
          lastModified: Date.now(),
          cwd: process.cwd(),
        }
      : undefined;
  }

  async getSessionMessages(sessionId: string) {
    return structuredClone(this.#sessions.get(sessionId) ?? []);
  }

  async hasSessionTranscript(sessionId: string) {
    return this.#sessions.has(sessionId);
  }

  async renameSession(): Promise<void> {}

  async forkSession() {
    return { sessionId: crypto.randomUUID() };
  }

  async #answerPrompts(
    sessionId: string,
    prompts: AsyncIterable<ClaudeUserMessage>,
    queue: ClaudeE2eMessageQueue,
    options: ClaudeOptions,
  ): Promise<void> {
    for await (const prompt of prompts) {
      if (prompt.isSynthetic && prompt.shouldQuery === false) continue;
      const promptText = claudePromptText(prompt);
      const parityScenario = promptText.includes("CLAUDE_PARITY_NATIVE_IMAGE");
      const skillScenario = promptText.trimStart().startsWith("/review");
      const backgroundScenario = promptText === "Start background fixture" ||
        promptText === "Complete the background fixture";
      const user = {
        ...prompt,
        parent_tool_use_id: null,
        parent_agent_id: null,
      } as ClaudeSessionMessage & ClaudeMessage;
      const assistantUuid = crypto.randomUUID();
      const messages = [...(this.#sessions.get(sessionId) ?? []), user];
      this.#sessions.set(sessionId, messages);
      queue.push(user);
      if (promptText === "Exercise Claude Steer") {
        this.#steerPrompts.set(sessionId, prompt.uuid!);
        const working = {
          type: "assistant", uuid: assistantUuid, session_id: sessionId,
          parent_tool_use_id: null, parent_agent_id: null,
          message: { id: `steer-${assistantUuid}`, role: "assistant", stop_reason: "tool_use",
            content: [{ type: "tool_use", id: `steer-tool-${prompt.uuid}`, name: "Bash",
              input: { command: "Wait for the steering input" } }] },
        } as unknown as ClaudeSessionMessage & ClaudeMessage;
        messages.push(working);
        queue.push(working);
        continue;
      }
      if (promptText === "Use the revised Claude approach") {
        const originalUuid = this.#steerPrompts.get(sessionId);
        if (!originalUuid || prompt.priority !== "next") throw new Error("claude_steer_fixture_missing_native_priority");
        this.#steerPrompts.delete(sessionId);
        const toolResult = { type: "user", uuid: crypto.randomUUID(), session_id: sessionId,
          parent_tool_use_id: null, parent_agent_id: null,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `steer-tool-${originalUuid}`,
            content: "Command completed without interruption." }] },
        } as unknown as ClaudeSessionMessage & ClaudeMessage;
        messages.push(toolResult); queue.push(toolResult);
        const answer = { type: "assistant", uuid: assistantUuid, session_id: sessionId,
          parent_tool_use_id: null, parent_agent_id: null,
          user_message_uuids: [originalUuid, prompt.uuid], user_message_uuid: prompt.uuid,
          message: { id: `steered-${assistantUuid}`, role: "assistant", stop_reason: "end_turn",
            content: [{ type: "text", text: "Claude incorporated the revised approach." }] },
        } as unknown as ClaudeSessionMessage & ClaudeMessage;
        messages.push(answer); queue.push(answer);
        queue.push({ type: "result", subtype: "success", uuid: crypto.randomUUID(),
          session_id: sessionId, duration_ms: 1, duration_api_ms: 1, is_error: false,
          num_turns: 1, result: "Claude incorporated the revised approach.", stop_reason: "end_turn",
          total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
          user_message_uuid: originalUuid, user_message_uuids: [originalUuid, prompt.uuid],
        } as unknown as ClaudeMessage);
        continue;
      }
      if (promptText === "Exercise Claude Stop") {
        const working = {
          type: "assistant", uuid: assistantUuid, session_id: sessionId,
          parent_tool_use_id: null, parent_agent_id: null,
          message: { id: `stop-${assistantUuid}`, role: "assistant", stop_reason: "tool_use",
            content: [{ type: "tool_use", id: `stop-tool-${assistantUuid}`, name: "Bash", input: { command: "sleep 20" } }] },
        } as unknown as ClaudeSessionMessage & ClaudeMessage;
        messages.push(working);
        queue.push(working);
        this.#interruptions.set(sessionId, () => {
          this.#interruptions.delete(sessionId);
          const marker = { type: "user", uuid: crypto.randomUUID(), session_id: sessionId,
            parent_tool_use_id: null, parent_agent_id: null, timestamp: new Date().toISOString(),
            message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
          } as unknown as ClaudeSessionMessage & ClaudeMessage;
          messages.push(marker);
          queue.push(marker);
          queue.push({ type: "result", subtype: "error_during_execution", uuid: crypto.randomUUID(),
            session_id: sessionId, duration_ms: 1, duration_api_ms: 1, is_error: true,
            num_turns: 1, errors: [], stop_reason: null, total_cost_usd: 0, usage: {}, modelUsage: {},
            permission_denials: [], terminal_reason: "aborted_tools", user_message_uuid: prompt.uuid,
            user_message_uuids: [prompt.uuid],
          } as unknown as ClaudeMessage);
        });
        continue;
      }
      if (options.canUseTool && !parityScenario && !skillScenario && !backgroundScenario) {
        // Let the normalized submit receipt and runtime subscription settle
        // before the provider opens its blocking permission callback.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await options.canUseTool(
          "Bash",
          { command: "npm run typecheck" },
          {
            signal: options.abortController!.signal,
            requestId: `request-${prompt.uuid}`,
            toolUseID: `tool-${prompt.uuid}`,
            title: "Run fixture command?",
            description:
              "Claude requests one temporary command permission for this offline fixture.",
            suggestions: [
              {
                type: "addRules",
                behavior: "allow",
                destination: "session",
                rules: [{ toolName: "Bash", ruleContent: "npm run typecheck" }],
              },
            ],
          },
        );
      }
      if (options.canUseTool && promptText.includes("Exercise the Claude browser integration")) {
        // Exercise provider-directed guarded approvals after the ordinary
        // session-grant path. Even supplied suggestions must stay suppressed.
        for (const [index, expected] of ["deny", "allow"].entries()) {
          const response = await options.canUseTool("Bash", { command: "printf guarded-fixture" }, {
            signal: options.abortController!.signal,
            requestId: `guarded-request-${prompt.uuid}-${index}`,
            toolUseID: `guarded-tool-${prompt.uuid}-${index}`,
            title: index === 0 ? "Run guarded fixture command?" : "Run another guarded fixture command?",
            description: "This guarded request defaults to Deny and offers no reusable grant.",
            defaultToNo: true,
            suppressAlwaysAllowRule: true,
            suggestions: [{ type: "addRules", behavior: "allow", destination: "session",
              rules: [{ toolName: "Bash", ruleContent: "printf guarded-fixture" }] }],
          });
          if (!response || response.behavior !== expected || "updatedPermissions" in response) {
            throw new Error("claude_guarded_permission_response_mismatch");
          }
        }
      }
      if (parityScenario) {
        assertClaudeParityNativeImage(prompt);
        await this.#emitParityToolActivity(
          sessionId,
          prompt.uuid!,
          assistantUuid,
          messages,
          queue,
        );
        continue;
      }
      if (skillScenario) {
        const answerUuid = crypto.randomUUID();
        const answer = {
          type: "assistant",
          uuid: answerUuid,
          session_id: sessionId,
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: {
            id: `fixture-${answerUuid}`,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [
              {
                type: "text",
                text: "Claude completed the selected review skill as an ordinary model turn.",
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 7 },
          },
        } as unknown as ClaudeSessionMessage & ClaudeMessage;
        messages.push(answer);
        this.#sessions.set(sessionId, messages);
        queue.push(answer);
        queue.push(claudeFixtureResult(sessionId, prompt.uuid!));
        queue.push({
          type: "system",
          subtype: "session_state_changed",
          state: "idle",
          uuid: crypto.randomUUID(),
          session_id: sessionId,
        });
        continue;
      }
      if (backgroundScenario) {
        const description = "Sleep 20 seconds test";
        const system = { type: "system" as const, session_id: sessionId };
        if (promptText === "Start background fixture") {
          const task = { taskId: crypto.randomUUID(), toolId: `agent-${prompt.uuid}` };
          this.#backgroundTasks.set(sessionId, task);
          const launch = {
            type: "assistant", uuid: crypto.randomUUID(), session_id: sessionId,
            parent_tool_use_id: null, parent_agent_id: null,
            message: { id: `launch-${prompt.uuid}`, type: "message", role: "assistant",
              model: "claude-sonnet-5", stop_reason: "tool_use", stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
              content: [{ type: "tool_use", id: task.toolId, name: "Agent",
                input: { description, prompt: "Wait for the fixture completion signal.",
                  subagent_type: "general-purpose", run_in_background: true } }] },
          } as unknown as ClaudeSessionMessage & ClaudeMessage;
          messages.push(launch); queue.push(launch);
          queue.push({ ...system, uuid: crypto.randomUUID(), subtype: "task_started",
            task_id: task.taskId, tool_use_id: task.toolId, description,
            task_type: "local_agent", is_backgrounded: true });
          queue.push({ ...system, uuid: crypto.randomUUID(), subtype: "background_tasks_changed",
            tasks: [{ task_id: task.taskId, task_type: "local_agent", description }] });
          const receipt = { type: "user", uuid: crypto.randomUUID(), session_id: sessionId,
            parent_tool_use_id: null, parent_agent_id: null,
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: task.toolId,
              content: "Async agent launched successfully." }] },
          } as unknown as ClaudeSessionMessage & ClaudeMessage;
          messages.push(receipt); queue.push(receipt);
        } else {
          const task = this.#backgroundTasks.get(sessionId);
          if (!task) throw new Error("claude_background_fixture_not_started");
          queue.push({ ...system, uuid: crypto.randomUUID(), subtype: "task_notification",
            task_id: task.taskId, tool_use_id: task.toolId, status: "completed",
            output_file: "/fixture/unused.output", summary: "Subagent finished." });
          queue.push({ ...system, uuid: crypto.randomUUID(), subtype: "background_tasks_changed", tasks: [] });
          this.#backgroundTasks.delete(sessionId);
        }
      }
      const assistantMessageId = `fixture-${assistantUuid}`;
      queue.push({
        type: "stream_event",
        uuid: assistantUuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: assistantMessageId,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 0 },
          },
        },
      } as unknown as ClaudeMessage);
      queue.push({
        type: "stream_event",
        uuid: assistantUuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      } as unknown as ClaudeMessage);
      queue.push({
        type: "stream_event",
        uuid: assistantUuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Claude is streaming through the normalized browser UI…",
          },
        },
      } as unknown as ClaudeMessage);
      await new Promise((resolve) => setTimeout(resolve, 700));
      queue.push({
        type: "stream_event",
        uuid: assistantUuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        event: { type: "message_stop" },
      } as unknown as ClaudeMessage);
      const assistant = {
        type: "assistant",
        uuid: assistantUuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          id: assistantMessageId,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [
            {
              type: "text",
              text: "Claude completed this offline subscription-backed browser fixture.",
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 9 },
        },
      } as unknown as ClaudeSessionMessage & ClaudeMessage;
      messages.push(assistant);
      this.#sessions.set(sessionId, messages);
      queue.push(assistant);
      queue.push(claudeFixtureResult(sessionId, prompt.uuid!));
      queue.push({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        uuid: crypto.randomUUID(),
        session_id: sessionId,
      });
    }
  }

  async #emitParityToolActivity(
    sessionId: string,
    operationId: string,
    assistantUuid: string,
    messages: ClaudeSessionMessage[],
    queue: ClaudeE2eMessageQueue,
  ): Promise<void> {
    const tools = [
      {
        id: "claude-parity-bash",
        name: "Bash",
        input: { command: "printf claude-parity" },
        result: "claude-parity",
      },
      {
        id: "claude-parity-read",
        name: "Read",
        input: { file_path: "/workspace/parity.txt", offset: 1, limit: 2 },
        result: "first line\nsecond line",
      },
      {
        id: "claude-parity-web",
        name: "WebSearch",
        input: { query: "Claude Agent SDK parity" },
        result: "One reviewed search result",
      },
      {
        id: "claude-parity-mcp",
        name: "mcp__fixture__lookup",
        input: { topic: "normalized MCP rendering" },
        result: "Fixture MCP result",
      },
      {
        id: "claude-parity-agent",
        name: "Agent",
        input: {
          description: "Audit the parity fixture",
          prompt: "Inspect the deterministic browser fixture.",
          name: "fixture-auditor",
        },
        result: "The fixture audit completed.",
      },
    ] as const;
    const toolMessage = {
      type: "assistant",
      uuid: assistantUuid,
      session_id: sessionId,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        id: `fixture-${assistantUuid}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: tools.map(({ id, name, input }) => ({
          type: "tool_use" as const,
          id,
          name,
          input,
        })),
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 13 },
      },
    } as unknown as ClaudeSessionMessage & ClaudeMessage;
    messages.push(toolMessage);
    queue.push(toolMessage);

    // Preserve an observable in-flight activity state for the browser test.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const toolResults = {
      type: "user",
      uuid: crypto.randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: "user",
        content: tools.map(({ id, result }) => ({
          type: "tool_result" as const,
          tool_use_id: id,
          content: [{ type: "text" as const, text: result }],
        })),
      },
    } as unknown as ClaudeSessionMessage & ClaudeMessage;
    messages.push(toolResults);
    queue.push(toolResults);

    const finalUuid = crypto.randomUUID();
    const final = {
      type: "assistant",
      uuid: finalUuid,
      session_id: sessionId,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        id: `fixture-${finalUuid}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [
          {
            type: "text",
            text: "Claude received the native PNG and completed semantic tool parity.",
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 17, output_tokens: 19 },
      },
    } as unknown as ClaudeSessionMessage & ClaudeMessage;
    messages.push(final);
    this.#sessions.set(sessionId, messages);
    queue.push(final);
    queue.push(claudeFixtureResult(sessionId, operationId));
    queue.push({
      type: "system",
      subtype: "session_state_changed",
      state: "idle",
      uuid: crypto.randomUUID(),
      session_id: sessionId,
    });
  }
}

function claudeFixtureResult(sessionId: string, operationId: string): ClaudeMessage {
  return { type: "result", subtype: "success", uuid: crypto.randomUUID(),
    session_id: sessionId, duration_ms: 1, duration_api_ms: 1,
    is_error: false, num_turns: 1, result: "Fixture response complete.",
    stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {},
    permission_denials: [], user_message_uuid: operationId, user_message_uuids: [operationId],
  } as unknown as ClaudeMessage;
}

function claudePromptText(prompt: ClaudeUserMessage): string {
  const content = prompt.message.content;
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is Extract<(typeof content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map(({ text }) => text)
    .join("\n");
}

function assertClaudeParityNativeImage(prompt: ClaudeUserMessage): void {
  const content = prompt.message.content;
  if (!Array.isArray(content)) throw new Error("e2e_claude_image_missing");
  const image = content.find((block) => block.type === "image");
  if (
    !image ||
    image.source.type !== "base64" ||
    image.source.media_type !== "image/png" ||
    !Buffer.from(image.source.data, "base64")
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("e2e_claude_native_png_invalid");
  }
}

function claudeSystemInit(
  sessionId: string,
  options: ClaudeOptions,
): ClaudeMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "oauth",
    claude_code_version: "2.1.283",
    cwd: options.cwd!,
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "default",
    slash_commands: ["review", "compact"],
    terminal_slash_commands: ["compact"],
    output_style: "default",
    skills: ["review"],
    plugins: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  };
}

class TestBackendPersistence implements BackendThreadPersistenceAdapter {
  readonly #submissionIntents = new Set<string>();

  constructor(readonly database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS e2e_backend_binding_details (
        tenant_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        application_thread_id TEXT NOT NULL,
        opaque_detail TEXT NOT NULL,
        PRIMARY KEY (
          tenant_id, owner_principal_id, application_thread_id
        )
      );
    `);
  }

  initializeThread(): void {}
  initializeForkThread(): void {}
  readForkSettings() {
    return { toolAccess: "full" as const };
  }

  initializeNewThread(): void {}

  validateInitialization(): void {}

  initializationActions(): readonly [] {
    return [];
  }

  recordSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: { readonly applicationOperationId: string },
  ): void {
    this.#submissionIntents.add(
      JSON.stringify([
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        attemptId,
        input.applicationOperationId,
      ]),
    );
  }

  hasSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    applicationOperationId: string,
  ): boolean {
    return this.#submissionIntents.has(
      JSON.stringify([
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        attemptId,
        applicationOperationId,
      ]),
    );
  }

  saveBoundBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
    opaqueBindingDetail: string,
  ): void {
    this.database
      .prepare(
        `
          INSERT OR REPLACE INTO e2e_backend_binding_details(
            tenant_id, owner_principal_id, application_thread_id,
            opaque_detail
          )
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        opaqueBindingDetail,
      );
  }

  getBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
  ): string | undefined {
    return (
      this.database
        .prepare(
          `
            SELECT opaque_detail AS opaqueDetail
            FROM e2e_backend_binding_details
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ?
          `,
        )
        .get(scope.tenantId, scope.principalId, applicationThreadId) as
        { readonly opaqueDetail: string } | undefined
    )?.opaqueDetail;
  }
}

const interactivePresentation: ThreadBackendPresentationProvider = {
  async read(input) {
    const catalog = input.catalog ?? {
      models: [],
      commands: [],
      skills: [],
      notices: [],
    };
    return {
      revision: `e2e-${input.backend.configurationRevision}-${testSettings(input.applicationThreadId).revision}`,
      backend: { label: boundDisplayText("Scripted agent") },
      interactionMode: "interactive",
      providerFeatureCapabilities: [],
      providerFeatureStates: [],
      settings: testSettings(input.applicationThreadId),
      settingDescriptors: [
        {
          id: "model",
          label: boundDisplayText("Model"),
          requiredForFirstSubmission: false,
          available: true,
          options: [
            {
              value: "memory/conformance-model",
              label: boundDisplayText("Conformance model"),
              available: true,
            },
          ],
        },
        {
          id: "thinking_level",
          label: boundDisplayText("Thinking"),
          requiredForFirstSubmission: false,
          available: true,
          options: [
            { value: "low", label: boundDisplayText("Low"), available: true },
            { value: "high", label: boundDisplayText("High"), available: true },
          ],
        },
        {
          id: "tool_access",
          label: boundDisplayText("Tools"),
          requiredForFirstSubmission: false,
          available: true,
          options: [
            {
              value: "read_only",
              label: boundDisplayText("Read only"),
              available: true,
            },
            {
              value: "ask",
              label: boundDisplayText("Ask before changes"),
              available: true,
            },
            {
              value: "full",
              label: boundDisplayText("Full access"),
              available: true,
            },
          ],
        },
      ],
      composerCommands: catalog.commands.map((command) => ({
        invocation: command.invocation,
        source: command.source,
        ...(command.description
          ? { description: boundDisplayText(command.description) }
          : {}),
      })),
      skills: catalog.skills.map((skill) => ({
        id: skill.id,
        name: boundDisplayText(skill.name),
        ...(skill.displayName
          ? { displayName: boundDisplayText(skill.displayName) }
          : {}),
        reference: skill.reference,
        ...(skill.description
          ? { description: boundDisplayText(skill.description) }
          : {}),
      })),
    };
  },
};

type TestSettings = {
  readonly revision: number;
  readonly values: Array<{
    readonly id: "model" | "thinking_level" | "tool_access";
    readonly desiredValue: string;
    readonly effectiveValue: string;
    readonly applicationState: "effective";
  }>;
};

const settingsByThread = new Map<string, TestSettings>();

class TestPiSavedAgentPersistence extends PiBackendThreadPersistenceAdapter {
  override initializeResolvedNewThread(
    ...input: Parameters<
      PiBackendThreadPersistenceAdapter["initializeResolvedNewThread"]
    >
  ) {
    const [scope, applicationThreadId, connection, resolved] = input;
    const record = super.initializeResolvedNewThread(
      scope,
      applicationThreadId,
      connection,
      resolved,
    );
    settingsByThread.set(applicationThreadId, {
      revision: record.revision,
      values: [
        {
          id: "model",
          desiredValue: `${resolved.modelProvider}/${resolved.modelId}`,
          effectiveValue: `${resolved.modelProvider}/${resolved.modelId}`,
          applicationState: "effective",
        },
        {
          id: "thinking_level",
          desiredValue: resolved.thinkingLevel ?? "low",
          effectiveValue: resolved.thinkingLevel ?? "low",
          applicationState: "effective",
        },
        {
          id: "tool_access",
          desiredValue: resolved.toolAccess,
          effectiveValue: resolved.toolAccess,
          applicationState: "effective",
        },
      ],
    });
    return record;
  }
}

function testSettings(threadId: string): TestSettings {
  return (
    settingsByThread.get(threadId) ?? {
      revision: 0,
      values: [
        {
          id: "model",
          desiredValue: "memory/conformance-model",
          effectiveValue: "memory/conformance-model",
          applicationState: "effective",
        },
        {
          id: "thinking_level",
          desiredValue: "low",
          effectiveValue: "low",
          applicationState: "effective",
        },
        {
          id: "tool_access",
          desiredValue: "read_only",
          effectiveValue: "read_only",
          applicationState: "effective",
        },
      ],
    }
  );
}

type TestPerformOperation = Extract<
  ThreadApplicationOperation,
  { readonly kind: "perform" }
>["operation"];

class TestActionPersistence implements ThreadActionPersistenceProvider {
  async afterInterruptAccepted(): Promise<boolean> {
    return false;
  }

  providerFeatureConcurrency(
    _feature: ProviderFeatureRef,
    _actionId: string,
  ): ProviderFeatureConcurrency {
    return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY;
  }

  async afterPersistAccepted(): Promise<void> {}

  constructor(readonly database: Database.Database) {}

  driverAction(
    operation: TestPerformOperation,
    applicationOperationId: string,
  ): RegisteredBackendActionInput {
    if (operation.action === "rename" || operation.action === "compact") {
      return { ...operation, applicationOperationId };
    }
    if (operation.action === "perform_provider_feature") {
      throw new Error("e2e_provider_feature_unsupported");
    }
    if (operation.value === null) throw new Error("e2e_setting_value_required");
    if (operation.settingId === "model") {
      const [provider, ...model] = operation.value.split("/");
      return {
        applicationOperationId,
        action: "set_model",
        provider: provider!,
        modelId: model.join("/"),
      };
    }
    if (operation.settingId === "thinking_level") {
      return {
        applicationOperationId,
        action: "set_thinking_level",
        level: operation.value,
      };
    }
    if (
      operation.value !== "read_only" &&
      operation.value !== "ask" &&
      operation.value !== "full"
    ) {
      throw new Error("e2e_tool_access_invalid");
    }
    return {
      applicationOperationId,
      action: "set_tool_access",
      mode: operation.value,
    };
  }

  persistAccepted(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedThreadRevision: number;
      readonly settingsGuard: BackendActionSettingsGuard;
      readonly operation: TestPerformOperation;
    },
  ): void {
    if (input.operation.action === "compact") return;
    if (input.operation.action === "rename") {
      const changed = this.database
        .prepare(
          `
            UPDATE application_threads
            SET title = ?, revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ?
          `,
        )
        .run(
          input.operation.title,
          Date.now(),
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.expectedThreadRevision,
        );
      if (changed.changes !== 1) throw new Error("e2e_thread_revision_changed");
      return;
    }
    const current = testSettings(applicationThreadId);
    if (
      input.settingsGuard.kind === "staged" &&
      input.settingsGuard.expectedRevision !== current.revision
    ) {
      throw new Error("e2e_settings_revision_changed");
    }
    if (input.operation.action !== "set_setting") {
      throw new Error("e2e_setting_operation_required");
    }
    const settingOperation = input.operation;
    const values = current.values.map((setting) =>
      setting.id === settingOperation.settingId
        ? {
            ...setting,
            desiredValue: settingOperation.value!,
            effectiveValue: settingOperation.value!,
          }
        : setting,
    );
    const changed = this.database
      .prepare(
        `
          UPDATE application_threads
          SET revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            AND revision = ?
        `,
      )
      .run(
        Date.now(),
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedThreadRevision,
      );
    if (changed.changes !== 1) throw new Error("e2e_thread_revision_changed");
    settingsByThread.set(applicationThreadId, {
      revision: current.revision + 1,
      values,
    });
  }
}

function backendInstance(
  record: ReturnType<BackendConfigurationRepository["getBackend"]>,
): AgentBackendInstance {
  return {
    ...record,
    enabled: record.enabled === 1,
  };
}

function connectionProfile(
  record: ReturnType<BackendConfigurationRepository["getProfile"]>,
): AgentConnectionProfile {
  return {
    ...record,
    enabled: record.enabled === 1,
  };
}

const FORBIDDEN_CODEX_ROLLOUT = "FORBIDDEN_NATIVE_ROLLOUT_6f1d7e65a77f";
const FORBIDDEN_CODEX_SESSION = "FORBIDDEN_NATIVE_SESSION_2bc9a48f1163";
const FORBIDDEN_CODEX_API_KEY = "FORBIDDEN_NATIVE_API_KEY_a71e0c84d592";
const FORBIDDEN_CODEX_UDS_SOCKET =
  "/private/FORBIDDEN_CODEX_UDS_SOCKET_5cfd39db45ed.sock";
const FORBIDDEN_CODEX_TCP_ENDPOINT = "ws://127.0.0.1:65431";
const FORBIDDEN_CODEX_TCP_SECRET_REFERENCE = "SEDES_CODEX_FORBIDDEN_E2E_TOKEN";

const E2E_INTERACTION_SCENARIOS = [
  "decision_standard",
  "mcp_invocation",
  "mcp_form",
  "questionnaire_full",
  "questionnaire_durable",
  "mixed_decision_questionnaire",
] as const;
type E2eInteractionScenario = (typeof E2E_INTERACTION_SCENARIOS)[number];

type E2eInteractionRecord = {
  readonly requestId: number;
  readonly nativeThreadId: string;
  readonly scenario: E2eInteractionScenario;
  readonly kind: "decision" | "questionnaire" | "confirmation" | "form";
  state: "pending" | "response_received" | "confirmed" | "failed";
  releaseRequested: boolean;
  safeResponse?: Readonly<Record<string, unknown>>;
  failure?: string;
  readonly controller: AbortController;
};

type E2eApplicationDecisionRecord = {
  readonly requestId: number;
  readonly applicationThreadId: string;
  state: "pending" | "resolved" | "cancelled" | "failed";
  decision?: "allow" | "deny";
  failure?: string;
  readonly controller: AbortController;
};

type E2eHeldSteerMaterialization = {
  readonly generation: number;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly item: Extract<
    CodexThread["turns"][number]["items"][number],
    { type: "userMessage" }
  >;
};

type E2eHeldSubmitMaterialization = E2eHeldSteerMaterialization;

function safeE2eInteractionResponse(
  kind: "decision" | "questionnaire" | "confirmation" | "form",
  result: unknown,
): Readonly<Record<string, unknown>> {
  if (kind === "confirmation" || kind === "form") {
    const response = result as { action?: string; content?: unknown };
    return Object.freeze({ kind, action: response.action, content: response.content });
  }
  if (kind === "decision") {
    const decision =
      typeof result === "object" &&
      result !== null &&
      "decision" in result &&
      typeof result.decision === "string"
        ? result.decision
        : "structured";
    return Object.freeze({ kind, decision });
  }
  const answers =
    typeof result === "object" &&
    result !== null &&
    "answers" in result &&
    typeof result.answers === "object" &&
    result.answers !== null
      ? Object.values(result.answers)
      : [];
  return Object.freeze({
    kind,
    answeredQuestionCount: answers.length,
    answerEntryCounts: Object.freeze(
      answers.map((answer) =>
        typeof answer === "object" &&
        answer !== null &&
        "answers" in answer &&
        Array.isArray(answer.answers)
          ? answer.answers.length
          : 0,
      ),
    ),
  });
}

class CodexE2eRpcFixture {
  readonly client: CodexSharedClientFacade;
  readonly serverRequests = new CodexServerRequestRouter();
  readonly #threads = new Map<string, CodexThread>();
  readonly #serviceTierByThread = new Map<string, string | null>();
  #readyClient: CodexReadyClientGeneration;
  #inboundSequence = 0;
  #turnOrdinal = 0;
  #createOrdinal = 0;
  #generation = 1;
  #failNextCreateWithUnknownOutcome = false;
  #failNextSubmitWithUnknownOutcome = false;
  readonly #requests: Array<{
    readonly method: string;
    readonly generation: number;
  }> = [];
  readonly #threadStarts: Array<{
    readonly generation: number;
    readonly serviceTier: string | null;
  }> = [];
  readonly #retirements: Array<{
    readonly generation: number;
    readonly reason: string;
    readonly replacementGeneration: number;
    readonly requestCountAtRetirement: number;
  }> = [];
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #interruptedTurnIds = new Set<string>();
  readonly #heldTurnCompletionIds = new Set<string>();
  readonly #interactionRecords = new Map<number, E2eInteractionRecord>();
  #holdNextTurnCompletion = false;
  #holdNextSubmitMaterialization = false;
  #heldSubmitMaterialization?: E2eHeldSubmitMaterialization;
  #steerMaterializationTarget?: {
    readonly nativeThreadId: string;
    remaining: number;
  };
  readonly #heldSteerMaterializations: E2eHeldSteerMaterialization[] = [];
  /** Unarmed steers the fixture turn drains on its next step. */
  readonly #drainingSteerMaterializations: E2eHeldSteerMaterialization[] = [];
  #drainedSteerOrdinal = 0;
  #interactionRequestOrdinal = 10_000;
  #ready = true;

  constructor() {
    this.#readyClient = this.#clientForGeneration(this.#generation);
    this.client = new CodexSharedClientFacade({
      current: () => (this.#ready ? this.#readyClient : undefined),
      latestGeneration: () => this.#generation,
      retireGeneration: (generation, reason) =>
        this.#retireGeneration(generation, reason),
    });
    this.client.updateLifecycle({
      state: "ready",
      generation: this.#generation,
    });
    this.serverRequests.activateGeneration(this.#generation);
  }

  #clientForGeneration(generation: number): CodexReadyClientGeneration {
    return {
      generation,
      request: <Params, Result>(
        specification: CodexRpcMethod<Params, Result>,
        params: Params,
        _options: CodexRpcRequestOptions,
      ) => this.#request(generation, specification, params),
      requestWithReceipt: async <Params, Result>(
        specification: CodexRpcMethod<Params, Result>,
        params: Params,
        _options: CodexRpcRequestOptions,
      ): Promise<CodexRpcRequestReceipt<Result>> => ({
        result: await this.#request(generation, specification, params),
        generation,
        inboundSequence: ++this.#inboundSequence,
      }),
    };
  }

  armNextCreateOutcomeUnknown(): void {
    if (this.#failNextCreateWithUnknownOutcome) {
      throw new Error("e2e_codex_create_fault_already_armed");
    }
    this.#failNextCreateWithUnknownOutcome = true;
  }

  armNextSubmitOutcomeUnknown(): void {
    if (this.#failNextSubmitWithUnknownOutcome) {
      throw new Error("e2e_codex_submit_fault_already_armed");
    }
    this.#failNextSubmitWithUnknownOutcome = true;
  }

  resetSubmitOutcomeUnknown(): void {
    this.#failNextSubmitWithUnknownOutcome = false;
  }

  armNextTurnCompletion(): void {
    if (this.#holdNextTurnCompletion || this.#heldTurnCompletionIds.size > 0) {
      throw new Error("e2e_codex_turn_completion_already_held");
    }
    this.#holdNextTurnCompletion = true;
  }

  releaseTurnCompletion(): void {
    const [turnId] = this.#heldTurnCompletionIds;
    if (!turnId) throw new Error("e2e_codex_turn_completion_not_held");
    this.#heldTurnCompletionIds.delete(turnId);
  }

  resetTurnCompletion(): void {
    this.#holdNextTurnCompletion = false;
    this.#heldTurnCompletionIds.clear();
  }

  emitNonblockingQuestions(nativeThreadId: string): void {
    const thread = this.#threads.get(nativeThreadId);
    const turn = thread?.turns.findLast(
      (candidate) => candidate.status === "inProgress",
    );
    if (!thread || !turn) throw new Error("e2e_question_turn_not_active");
    const batches = [
      [
        {
          title: "Which deployment region?",
          options: ["us-east-1", "eu-west-1"],
        },
        { title: "What should I keep in mind?", options: null },
      ],
      [{ title: "Should I prepare a rollout note?", options: ["Yes", "No"] }],
    ];
    for (const [index, questions] of batches.entries()) {
      const item: CodexThread["turns"][number]["items"][number] = {
        type: "agentMessage",
        id: `question-${turn.id}-${index}`,
        text: questions.map(({ title }) => title).join("\n"),
        phase: "commentary",
        memoryCitation: null,
        delivery: "async",
        questions,
      };
      turn.items.push(item);
      this.#notify(this.#generation, "item/started", {
        threadId: nativeThreadId,
        turnId: turn.id,
        item,
        startedAtMs: Date.now(),
      });
      this.#notify(this.#generation, "item/completed", {
        threadId: nativeThreadId,
        turnId: turn.id,
        item,
        completedAtMs: Date.now(),
      });
    }
  }

  async seedBrowserBenchmark(nativeThreadId: string): Promise<void> {
    const thread = this.#threads.get(nativeThreadId);
    if (!thread || thread.status.type !== "idle")
      throw new Error("benchmark_thread_not_idle");
    this.#replaceThread(benchmarkHistory(thread));
    await this.#retireGeneration(
      this.#generation,
      "e2e_browser_benchmark_seed",
    );
  }

  async streamBrowserBenchmark(nativeThreadId: string): Promise<void> {
    let thread = this.#threads.get(nativeThreadId);
    if (!thread || thread.status.type !== "idle")
      throw new Error("benchmark_thread_not_idle");
    const turn: CodexThread["turns"][number] = {
      id: "benchmark-stream-turn",
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 1_700_030_000,
      completedAt: null,
      durationMs: null,
    };
    thread = this.#replaceThread({
      ...thread,
      status: { type: "active", activeFlags: [] },
      turns: [...thread.turns, turn],
    });
    this.#notify(this.#generation, "turn/started", {
      threadId: nativeThreadId,
      turn,
    });
    for (let index = 0; index < benchmarkStreamItems; index += 1) {
      // Real provider-shaped item additions revise the normalized turn membership.
      const item: CodexThread["turns"][number]["items"][number] = {
        type: "agentMessage",
        id: `benchmark-stream-item-${index}`,
        text: `Streaming checkpoint ${index}: inspected the request lifecycle.`,
        phase: "commentary",
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      turn.items.push(item);
      this.#notify(this.#generation, "item/started", {
        threadId: nativeThreadId,
        turnId: turn.id,
        item,
        startedAtMs: 1_700_030_000_000,
      });
      this.#notify(this.#generation, "item/completed", {
        threadId: nativeThreadId,
        turnId: turn.id,
        item,
        completedAtMs: 1_700_030_000_010,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const finalItem: CodexThread["turns"][number]["items"][number] = {
      type: "agentMessage",
      id: "benchmark-stream-final",
      text: "Browser benchmark stream complete.",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    turn.items.push(finalItem);
    this.#notify(this.#generation, "item/completed", {
      threadId: nativeThreadId,
      turnId: turn.id,
      item: finalItem,
      completedAtMs: 1_700_030_003_000,
    });
    const completed = {
      ...turn,
      status: "completed" as const,
      completedAt: 1_700_030_003,
      durationMs: 3_000,
    };
    this.#replaceThread({
      ...thread,
      status: { type: "idle" },
      turns: [...thread.turns.slice(0, -1), completed],
    });
    this.#notify(this.#generation, "turn/completed", {
      threadId: nativeThreadId,
      turn: completed,
    });
  }

  async seedReadableAbandonedHistory(nativeThreadId: string): Promise<void> {
    const thread = this.#threads.get(nativeThreadId);
    if (
      !thread ||
      thread.historyMode !== "paginated" ||
      thread.status.type !== "idle"
    ) {
      throw new Error("e2e_codex_abandoned_history_thread_invalid");
    }
    const activeIndex = 11;
    const abandonedIndexes = new Set([1, 5]);
    const turns = Array.from({ length: activeIndex + 1 }, (_, index) => {
      const status =
        index === activeIndex || abandonedIndexes.has(index)
          ? ("inProgress" as const)
          : ("completed" as const);
      const text =
        index === activeIndex
          ? "Live Codex head remains active"
          : index === 5
            ? "Abandoned initial-window Codex turn"
            : index === 1
              ? "Abandoned older-page Codex turn"
              : `Completed Codex history checkpoint ${index}`;
      return {
        id: `readable-abandoned-turn-${index}`,
        items: [
          {
            type: "userMessage" as const,
            id: `readable-abandoned-item-${index}`,
            clientId: null,
            content: [
              {
                type: "text" as const,
                text,
                text_elements: [],
              },
            ],
          },
        ],
        itemsView: "full" as const,
        status,
        error: null,
        startedAt: 1_700_020_000 + index,
        completedAt: status === "completed" ? 1_700_020_100 + index : null,
        durationMs: status === "completed" ? 100_000 : null,
      };
    });
    this.#replaceThread({
      ...thread,
      status: { type: "active", activeFlags: [] },
      updatedAt: 1_700_020_100 + activeIndex,
      recencyAt: 1_700_020_100 + activeIndex,
      turns,
    });
    await this.#retireGeneration(
      this.#generation,
      "e2e_readable_abandoned_history_reattach",
    );
  }

  state(): Readonly<Record<string, unknown>> {
    const lastRetirement = this.#retirements.at(-1);
    return Object.freeze({
      generation: this.#generation,
      ready: this.#ready,
      requestCount: this.#requests.length,
      requests: Object.freeze(
        this.#requests.map((request) => Object.freeze({ ...request })),
      ),
      threadStarts: Object.freeze(
        this.#threadStarts.map((request) => Object.freeze({ ...request })),
      ),
      createFaultArmed: this.#failNextCreateWithUnknownOutcome,
      submitFaultArmed: this.#failNextSubmitWithUnknownOutcome,
      retirements: Object.freeze(
        this.#retirements.map((retirement) => Object.freeze({ ...retirement })),
      ),
      requestsAfterLastRetirement: Object.freeze(
        this.#requests
          .slice(
            lastRetirement?.requestCountAtRetirement ?? this.#requests.length,
          )
          .map((request) => Object.freeze({ ...request })),
      ),
    });
  }

  emitViewedImage(nativeThreadId: string, absolutePath: string): void {
    const thread = this.#threads.get(nativeThreadId);
    const turn = thread?.turns.find(candidate => candidate.status === "inProgress");
    if (!thread || !turn) throw new Error("e2e_viewed_image_turn_missing");
    const image: CodexThread["turns"][number]["items"][number] = {
      type: "imageView", id: `${turn.id}-viewed-image`, path: absolutePath,
    };
    const following: CodexThread["turns"][number]["items"][number] = {
      type: "agentMessage", id: `${turn.id}-after-viewed-image`,
      text: "The file was viewed; work continues while its preview is captured.",
      phase: "commentary", memoryCitation: null, delivery: null, questions: null,
    };
    this.#replaceThread({ ...thread, turns: thread.turns.map(candidate => candidate.id === turn.id
      ? { ...turn, items: [...turn.items, image, following] } : candidate) });
    for (const item of [image, following]) {
      this.#notify(this.#generation, "item/started", { threadId: nativeThreadId, turnId: turn.id, item, startedAtMs: Date.now() });
      this.#notify(this.#generation, "item/completed", { threadId: nativeThreadId, turnId: turn.id, item, completedAtMs: Date.now() });
    }
  }

  interactionState(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      records: Object.freeze(
        [...this.#interactionRecords.values()].map((record) =>
          Object.freeze({
            requestId: record.requestId,
            scenario: record.scenario,
            kind: record.kind,
            state: record.state,
            ...(record.safeResponse
              ? { safeResponse: Object.freeze({ ...record.safeResponse }) }
              : {}),
            ...(record.failure ? { failure: record.failure } : {}),
          }),
        ),
      ),
    });
  }

  openInteractionScenario(
    nativeThreadId: string,
    scenario: E2eInteractionScenario,
  ): readonly number[] {
    const thread = this.#threads.get(nativeThreadId);
    const turn = thread?.turns.find(({ status }) => status === "inProgress");
    if (!thread || !turn) throw new Error("e2e_interaction_turn_not_active");
    switch (scenario) {
      case "decision_standard":
        return [this.#openDecision(nativeThreadId, turn.id, scenario)];
      case "mcp_invocation":
        return [this.#openServerInteraction({
          scenario,
          kind: "confirmation",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: nativeThreadId,
            turnId: turn.id,
            serverName: "fixture_catalog",
            mode: "form",
            message: "Allow the fixture_catalog MCP server to run inspect_catalog?",
            requestedSchema: { type: "object", properties: {} },
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              tool_params: {
                query: { type: "text", value: "local models" },
                maxResults: 20,
                apiKey: FORBIDDEN_CODEX_API_KEY,
              },
            },
          },
        })];
      case "mcp_form":
        return [this.#openServerInteraction({
          scenario,
          kind: "form",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: nativeThreadId,
            turnId: turn.id,
            serverName: "fixture_catalog",
            mode: "form",
            message: "Catalog request details",
            requestedSchema: {
              type: "object",
              properties: {
                project: { type: "string", title: "Project", minLength: 2 },
                limit: { type: "integer", title: "Result limit", minimum: 1, maximum: 50, default: 10 },
                includeArchived: { type: "boolean", title: "Include archived", default: false },
                region: { type: "string", title: "Region", enum: ["us", "eu"], default: "us" },
                tags: { type: "array", title: "Sources", items: { type: "string", enum: ["local", "hosted"] }, minItems: 1, maxItems: 2, default: ["local"] },
                note: { type: "string", title: "Optional note" },
              },
              required: ["project", "limit"],
            },
          },
        })];
      case "questionnaire_full":
      case "questionnaire_durable":
        return [this.#openQuestionnaire(nativeThreadId, turn.id, scenario)];
      case "mixed_decision_questionnaire":
        return [
          this.#openDecision(nativeThreadId, turn.id, scenario),
          this.#openQuestionnaire(nativeThreadId, turn.id, scenario),
        ];
    }
  }

  releaseInteraction(requestId: number): void {
    const record = this.#interactionRecords.get(requestId);
    if (!record) throw new Error("e2e_interaction_request_unknown");
    if (record.state === "confirmed") return;
    record.releaseRequested = true;
    if (record.state === "response_received") this.#confirmInteraction(record);
  }

  resetInteractions(): void {
    for (const record of this.#interactionRecords.values()) {
      if (record.state === "pending" && !record.controller.signal.aborted) {
        record.controller.abort(new Error("e2e_interaction_fixture_reset"));
      }
    }
    this.#interactionRecords.clear();
  }

  armNextSubmitMaterialization(): void {
    if (
      this.#holdNextSubmitMaterialization ||
      this.#heldSubmitMaterialization !== undefined
    ) {
      throw new Error("e2e_codex_submit_materialization_already_held");
    }
    this.#holdNextSubmitMaterialization = true;
  }

  submitMaterializationState(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      armed: this.#holdNextSubmitMaterialization,
      held: this.#heldSubmitMaterialization !== undefined,
      nativeThreadId: this.#heldSubmitMaterialization?.nativeThreadId,
      nativeTurnId: this.#heldSubmitMaterialization?.nativeTurnId,
    });
  }

  releaseSubmitMaterialization(): void {
    const held = this.#heldSubmitMaterialization;
    if (!held) throw new Error("e2e_codex_submit_materialization_not_held");
    const thread = this.#threads.get(held.nativeThreadId);
    const turn = thread?.turns.find(({ id }) => id === held.nativeTurnId);
    if (!thread || !turn) {
      throw new Error("e2e_codex_submit_materialization_turn_missing");
    }
    this.#heldSubmitMaterialization = undefined;
    this.#replaceThread({
      ...thread,
      turns: thread.turns.map((candidate) =>
        candidate.id === held.nativeTurnId
          ? { ...candidate, items: [held.item, ...candidate.items] }
          : candidate,
      ),
    });
    this.#notify(held.generation, "item/started", {
      threadId: held.nativeThreadId,
      turnId: held.nativeTurnId,
      item: held.item,
      startedAtMs: Date.now(),
    });
  }

  resetSubmitMaterialization(): void {
    this.#holdNextSubmitMaterialization = false;
    this.#heldSubmitMaterialization = undefined;
  }

  armNextSteerMaterialization(nativeThreadId: string, count = 1): void {
    if (
      this.#steerMaterializationTarget !== undefined ||
      this.#heldSteerMaterializations.length > 0
    ) {
      throw new Error("e2e_codex_steer_materialization_already_armed");
    }
    if (!this.#threads.has(nativeThreadId)) {
      throw new Error("e2e_codex_steer_thread_unknown");
    }
    if (!Number.isSafeInteger(count) || count < 1 || count > 8) {
      throw new Error("e2e_codex_steer_materialization_count_invalid");
    }
    this.#steerMaterializationTarget = { nativeThreadId, remaining: count };
  }

  steerMaterializationState(): Readonly<Record<string, unknown>> {
    const firstHeld = this.#heldSteerMaterializations[0];
    return Object.freeze({
      armed: this.#steerMaterializationTarget !== undefined,
      held: this.#heldSteerMaterializations.length > 0,
      heldCount: this.#heldSteerMaterializations.length,
      nativeThreadId:
        firstHeld?.nativeThreadId ??
        this.#steerMaterializationTarget?.nativeThreadId,
      nativeTurnId: firstHeld?.nativeTurnId,
    });
  }

  releaseSteerMaterialization(): void {
    const held = this.#heldSteerMaterializations.shift();
    if (!held) throw new Error("e2e_codex_steer_materialization_not_held");
    this.#materializeSteer(held);
  }

  /** Codex records a drained steer's userMessage in its target turn. */
  #materializeSteer(held: E2eHeldSteerMaterialization): void {
    const thread = this.#threads.get(held.nativeThreadId);
    const turn = thread?.turns.find(({ id }) => id === held.nativeTurnId);
    if (!thread || !turn) {
      throw new Error("e2e_codex_steer_materialization_turn_missing");
    }
    this.#replaceThread({
      ...thread,
      turns: thread.turns.map((candidate) =>
        candidate.id === held.nativeTurnId
          ? { ...candidate, items: [...candidate.items, held.item] }
          : candidate,
      ),
    });
    this.#notify(held.generation, "item/started", {
      threadId: held.nativeThreadId,
      turnId: held.nativeTurnId,
      item: held.item,
      startedAtMs: Date.now(),
    });
  }

  resetSteerMaterialization(): void {
    this.#steerMaterializationTarget = undefined;
    this.#heldSteerMaterializations.length = 0;
    this.#drainingSteerMaterializations.length = 0;
  }

  #openDecision(
    nativeThreadId: string,
    nativeTurnId: string,
    scenario: E2eInteractionScenario,
  ): number {
    return this.#openServerInteraction({
      scenario,
      kind: "decision",
      method: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        itemId: `e2e-approval-${this.#interactionRequestOrdinal + 1}`,
        startedAtMs: Date.now(),
        environmentId: null,
        reason: "Run the bounded end-to-end approval fixture.",
        command: "npm run typecheck",
        cwd: "/workspace/e2e",
        availableDecisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: [
                "npm",
                "run",
                "an-intentionally-long-command-name-that-exercises-the-menu-boundary",
                "--with-an-equally-long-reviewed-argument-value",
              ],
            },
          },
          "acceptForSession",
          "decline",
          "cancel",
        ],
      },
    });
  }

  #openQuestionnaire(
    nativeThreadId: string,
    nativeTurnId: string,
    scenario: E2eInteractionScenario,
  ): number {
    const fullQuestions = scenario === "questionnaire_full";
    return this.#openServerInteraction({
      scenario,
      kind: "questionnaire",
      method: "item/tool/requestUserInput",
      params: {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        itemId: `e2e-questionnaire-${this.#interactionRequestOrdinal + 1}`,
        isBlocking: scenario !== "questionnaire_durable",
        questions: fullQuestions
          ? [
              {
                id: "environment",
                header: "Environment",
                question: "Where should this run?",
                isOther: true,
                isSecret: false,
                options: [
                  {
                    label: "Staging",
                    description: "Use the isolated staging environment.",
                  },
                  {
                    label: "Production",
                    description: "Use the production environment.",
                  },
                ],
              },
              {
                id: "notes",
                header: "Notes",
                question: "What should the agent keep in mind?",
                isOther: false,
                isSecret: false,
                options: null,
              },
              {
                id: "secret",
                header: "Secret",
                question: "Enter the temporary secret.",
                isOther: false,
                isSecret: true,
                options: null,
              },
            ]
          : [
              {
                id: "optional-context",
                header: "Optional context",
                question: "Add context before the fixture continues.",
                isOther: false,
                isSecret: false,
                options: null,
              },
            ],
      },
    });
  }

  #openServerInteraction(input: {
    readonly scenario: E2eInteractionScenario;
    readonly kind: "decision" | "questionnaire" | "confirmation" | "form";
    readonly method:
      "item/commandExecution/requestApproval" | "item/tool/requestUserInput" | "mcpServer/elicitation/request";
    readonly params: unknown;
  }): number {
    const params = decodeCodexServerRequestParams(input.method, input.params);
    const requestId = ++this.#interactionRequestOrdinal;
    const controller = new AbortController();
    const record: E2eInteractionRecord = {
      requestId,
      nativeThreadId:
        typeof params === "object" &&
        params !== null &&
        "threadId" in params &&
        typeof params.threadId === "string"
          ? params.threadId
          : (() => {
              throw new Error("e2e_interaction_thread_missing");
            })(),
      scenario: input.scenario,
      kind: input.kind,
      state: "pending",
      releaseRequested: false,
      controller,
    };
    this.#interactionRecords.set(requestId, record);
    const handler = this.serverRequests.handlersForGeneration(this.#generation)[
      input.method
    ] as CodexServerRequestHandler | undefined;
    if (!handler) throw new Error("e2e_interaction_handler_missing");
    const request: CodexInboundServerRequest = {
      generation: this.#generation,
      sequence: ++this.#inboundSequence,
      id: requestId,
      method: input.method,
      params,
      signal: controller.signal,
    };
    void Promise.resolve(handler(request)).then(
      (result) => {
        if (this.#interactionRecords.get(requestId) !== record) return;
        record.state = "response_received";
        record.safeResponse = safeE2eInteractionResponse(input.kind, result);
        if (record.releaseRequested) this.#confirmInteraction(record);
      },
      (error: unknown) => {
        if (this.#interactionRecords.get(requestId) !== record) return;
        record.state = "failed";
        record.failure =
          error instanceof Error ? error.message.slice(0, 240) : "unknown";
      },
    );
    return requestId;
  }

  #confirmInteraction(record: E2eInteractionRecord): void {
    if (record.state !== "response_received") return;
    record.state = "confirmed";
    this.#notify(this.#generation, "serverRequest/resolved", {
      threadId: record.nativeThreadId,
      requestId: record.requestId,
    });
  }

  async #retireGeneration(generation: number, reason: string): Promise<void> {
    if (!this.#ready || generation !== this.#generation) return;
    this.#ready = false;
    this.serverRequests.invalidateGeneration(generation, reason);
    this.client.updateLifecycle({ state: "unavailable", generation });

    const replacementGeneration = generation + 1;
    this.#retirements.push({
      generation,
      reason,
      replacementGeneration,
      requestCountAtRetirement: this.#requests.length,
    });
    this.#generation = replacementGeneration;
    this.#readyClient = this.#clientForGeneration(replacementGeneration);
    this.client.updateLifecycle({
      state: "starting",
      generation: replacementGeneration,
    });
    this.serverRequests.activateGeneration(replacementGeneration);
    this.#ready = true;
    this.client.updateLifecycle({
      state: "ready",
      generation: replacementGeneration,
    });
  }

  ensureImportedThread(workspace: ValidatedWorkspace): void {
    const id = `e2e-codex-${workspace.summary.id}`;
    if (this.#threads.has(id)) return;
    const ordinal = this.#threads.size;
    this.#threads.set(
      id,
      codexThreadReadMethod.decodeResult({
        thread: {
          id,
          extra: {},
          sessionId: FORBIDDEN_CODEX_SESSION,
          forkedFromId: null,
          parentThreadId: null,
          preview: `Imported Codex history — ${workspace.summary.displayName}`,
          ephemeral: false,
          section: null,
          sectionEnteredAt: null,
          projectId: null,
          historyMode: "legacy",
          modelProvider: "openai",
          model: null,
          reasoningEffort: null,
          createdAt: 1_700_000_000 + ordinal,
          updatedAt: 1_700_000_100 + ordinal,
          recencyAt: 1_700_000_100 + ordinal,
          status: { type: "idle" },
          path: `/private/${FORBIDDEN_CODEX_ROLLOUT}.jsonl`,
          cwd: workspace.canonicalPath,
          cliVersion: "0.153.0",
          source: "appServer",
          canAcceptDirectInput: true,
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: `Imported Codex history — ${workspace.summary.displayName}`,
          turns: [
            {
              id: `turn-${ordinal}`,
              items: [
                {
                  type: "userMessage",
                  id: `user-${ordinal}`,
                  clientId: null,
                  content: [
                    {
                      type: "text",
                      text: "Explain how this imported Codex conversation is preserved.",
                      text_elements: [],
                    },
                  ],
                },
                {
                  type: "mcpToolCall",
                  id: `mcp-${ordinal}`,
                  server: "fixture",
                  tool: "inspect_history",
                  status: "completed",
                  arguments: {
                    apiKey: FORBIDDEN_CODEX_API_KEY,
                    request: "safe fixture request",
                  },
                  appContext: null,
                  pluginId: null,
                  readOnlyHint: null,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: "Safe fixture result",
                      },
                    ],
                    structuredContent: null,
                    _meta: null,
                  },
                  error: null,
                  durationMs: 1,
                },
                {
                  type: "agentMessage",
                  id: `agent-${ordinal}`,
                  text: "Which deployment region?\n- us-east-1\n- eu-west-1\n\nWhat should I keep in mind?",
                  phase: "final_answer",
                  memoryCitation: null,
                  delivery: "async",
                  questions: [
                    {
                      title: "Which deployment region?",
                      options: ["us-east-1", "eu-west-1"],
                    },
                    {
                      title: "What should I keep in mind?",
                      options: null,
                    },
                  ],
                },
              ],
              itemsView: "full",
              status: "completed",
              error: null,
              startedAt: 1_700_000_000 + ordinal,
              completedAt: 1_700_000_001 + ordinal,
              durationMs: 1_000,
            },
          ],
        },
      }).thread,
    );
    this.#serviceTierByThread.set(id, null);
  }

  close(): void {
    this.#ready = false;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.client.updateLifecycle({
      state: "closed",
      generation: this.#generation,
    });
  }

  #notify(
    generation: number,
    method: CodexAdoptedServerNotificationMethod,
    params: unknown,
  ): void {
    if (!this.#ready || generation !== this.#generation) return;
    this.client.forwardNotification(generation, {
      kind: "decoded_notification",
      generation,
      sequence: ++this.#inboundSequence,
      method,
      params: decodeCodexServerNotificationParams(method, params),
    });
  }

  #schedule(delayMilliseconds: number, operation: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (this.#ready) operation();
    }, delayMilliseconds);
    this.#timers.add(timer);
  }

  #replaceThread(thread: CodexThread): CodexThread {
    const validated = projectCodexThread(thread);
    this.#threads.set(validated.id, validated);
    return validated;
  }

  #metadataThread(thread: CodexThread): CodexThread {
    return thread.historyMode === "paginated"
      ? { ...thread, turns: [] }
      : thread;
  }

  #paginatedTurnShell(
    turn: CodexThread["turns"][number],
  ): CodexThread["turns"][number] {
    return { ...turn, items: [], itemsView: "notLoaded" };
  }

  #encodeHistoryCursor(input: {
    readonly kind: "turns" | "items";
    readonly threadId: string;
    readonly scope: string;
    readonly direction: "asc" | "desc";
    readonly offset: number;
  }): string {
    const scopeDigest = createHash("sha256")
      .update(
        `${input.kind}\0${input.threadId}\0${input.scope}\0${input.direction}`,
        "utf8",
      )
      .digest("base64url")
      .slice(0, 16);
    return `e2e-${input.kind}-${input.direction}-${scopeDigest}-${input.offset}`;
  }

  #decodeHistoryCursor(
    cursor: unknown,
    expected: {
      readonly kind: "turns" | "items";
      readonly threadId: string;
      readonly scope: string;
      readonly direction: "asc" | "desc";
    },
  ): number {
    if (typeof cursor !== "string") {
      throw new Error("e2e_codex_history_cursor_invalid");
    }
    const scopeDigest = createHash("sha256")
      .update(
        `${expected.kind}\0${expected.threadId}\0${expected.scope}\0${expected.direction}`,
        "utf8",
      )
      .digest("base64url")
      .slice(0, 16);
    const prefix = `e2e-${expected.kind}-${expected.direction}-${scopeDigest}-`;
    const offsetText = cursor.startsWith(prefix)
      ? cursor.slice(prefix.length)
      : "";
    const offset = Number(offsetText);
    if (
      offsetText.length === 0 ||
      !/^(?:0|[1-9][0-9]*)$/u.test(offsetText) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw new Error("e2e_codex_history_cursor_invalid");
    }
    return offset;
  }

  #paginatedTurnsPage(
    thread: CodexThread,
    input: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    if (thread.historyMode !== "paginated") {
      throw new Error("e2e_codex_turns_list_requires_paginated_thread");
    }
    const direction = input.sortDirection;
    const limit = input.limit;
    if (
      (direction !== "asc" && direction !== "desc") ||
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 100 ||
      input.itemsView !== "notLoaded"
    ) {
      throw new Error("e2e_codex_turns_list_input_invalid");
    }
    const scope = "all";
    const ordered =
      direction === "desc" ? [...thread.turns].reverse() : [...thread.turns];
    const offset =
      input.cursor === undefined
        ? 0
        : this.#decodeHistoryCursor(input.cursor, {
            kind: "turns",
            threadId: thread.id,
            scope,
            direction,
          });
    const data = ordered
      .slice(offset, offset + (limit as number))
      .map((turn) => this.#paginatedTurnShell(turn));
    const nextOffset = offset + data.length;
    return {
      data,
      nextCursor:
        nextOffset < ordered.length
          ? this.#encodeHistoryCursor({
              kind: "turns",
              threadId: thread.id,
              scope,
              direction,
              offset: nextOffset,
            })
          : null,
      backwardsCursor:
        data.length > 0
          ? this.#encodeHistoryCursor({
              kind: "turns",
              threadId: thread.id,
              scope,
              direction,
              offset,
            })
          : null,
    };
  }

  #paginatedItemsPage(
    thread: CodexThread,
    input: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    if (thread.historyMode !== "paginated") {
      throw new Error("e2e_codex_items_list_requires_paginated_thread");
    }
    const direction = input.sortDirection;
    const limit = input.limit;
    const turnId = input.turnId;
    if (
      (direction !== "asc" && direction !== "desc") ||
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 100 ||
      (turnId !== undefined && typeof turnId !== "string")
    ) {
      throw new Error("e2e_codex_items_list_input_invalid");
    }
    const scope = typeof turnId === "string" ? `turn:${turnId}` : "all";
    const chronological = thread.turns.flatMap((turn) =>
      turn.id === turnId || turnId === undefined
        ? turn.items.map((item) => ({ turnId: turn.id, item }))
        : [],
    );
    const ordered =
      direction === "desc" ? [...chronological].reverse() : chronological;
    // The real 0.153 cursor is a thread-global item ordinal, so the same head
    // boundary remains valid after applying any optional turnId filter.
    const resumeBoundaryCursor = `e2e-items-resume-boundary:${thread.id}`;
    const offset =
      input.cursor === undefined
        ? 0
        : input.cursor === resumeBoundaryCursor
          ? 0
          : this.#decodeHistoryCursor(input.cursor, {
              kind: "items",
              threadId: thread.id,
              scope,
              direction,
            });
    const data = ordered.slice(offset, offset + (limit as number));
    const nextOffset = offset + data.length;
    return {
      data,
      nextCursor:
        nextOffset < ordered.length
          ? this.#encodeHistoryCursor({
              kind: "items",
              threadId: thread.id,
              scope,
              direction,
              offset: nextOffset,
            })
          : null,
      backwardsCursor:
        data.length > 0
          ? this.#encodeHistoryCursor({
              kind: "items",
              threadId: thread.id,
              scope,
              direction,
              offset,
            })
          : null,
    };
  }

  async #request<Params, Result>(
    generation: number,
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
  ): Promise<Result> {
    if (!this.#ready || generation !== this.#generation) {
      throw new CodexRpcDeliveryError({
        code: "e2e_codex_stale_generation",
        delivery: "not_sent",
        generation,
        method: specification.method,
      });
    }
    this.#requests.push({ method: specification.method, generation });
    const encoded = specification.encodeParams(params) as Record<
      string,
      unknown
    >;
    let result: unknown;
    if (specification.method === "thread/list") {
      const cwd = encoded.cwd;
      const paths =
        typeof cwd === "string"
          ? new Set([cwd])
          : new Set(Array.isArray(cwd) ? cwd : []);
      result = {
        data: [...this.#threads.values()]
          .filter((thread) => paths.has(thread.cwd))
          .map((thread) => this.#metadataThread(thread)),
        nextCursor: null,
        backwardsCursor: null,
      };
    } else if (specification.method === "model/list") {
      result = {
        data: [
          {
            id: "gpt-5.6-codex",
            model: "gpt-5.6-codex",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.6 Codex",
            description: "Interactive Codex browser fixture model",
            hidden: false,
            supportedReasoningEfforts: [
              {
                reasoningEffort: "low",
                description: "Low reasoning",
              },
            ],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
            supportsPersonality: false,
            multiAgentVersion: null,
            additionalSpeedTiers: [],
            serviceTiers: [
              {
                id: "priority",
                name: "Fast",
                description: "About 1.5x speed with higher usage",
              },
            ],
            defaultServiceTier: null,
            isDefault: true,
          },
        ],
        nextCursor: null,
      };
    } else if (specification.method === "experimentalFeature/list") {
      result = {
        data: [
          {
            name: "fast_mode",
            stage: "stable",
            displayName: "Fast mode",
            description: "About 1.5x speed with higher usage",
            announcement: null,
            enabled: true,
            defaultEnabled: false,
          },
        ],
        nextCursor: null,
      };
    } else if (specification.method === "skills/list") {
      const cwds = encoded.cwds;
      if (
        !Array.isArray(cwds) ||
        !cwds.every((cwd) => typeof cwd === "string")
      ) {
        throw new Error("e2e_codex_skill_catalog_input_invalid");
      }
      result = {
        data: cwds.map((cwd) => ({
          cwd,
          skills: [
            {
              name: "review",
              description: "Review the current changes",
              shortDescription: "Review changes",
              interface: { displayName: "Review Changes" },
              path: `${cwd}/.codex/skills/review/SKILL.md`,
              scope: "repo",
              enabled: true,
            },
            {
              name: "openai-templates:pitch-deck",
              description: "Create an OpenAI template",
              interface: { displayName: "OpenAI Template" },
              path: "/opt/openai/plugins/openai-templates/pitch-deck/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "sites:sites-building",
              description: "Build a site",
              interface: { displayName: "OpenAI Sites" },
              path: "/opt/openai/plugins/sites/sites-building/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "visualize:visualize",
              description: "Create a visualization",
              interface: { displayName: "OpenAI Visualize" },
              path: "/opt/openai/plugins/visualize/visualize/SKILL.md",
              scope: "user",
              enabled: true,
            },
          ],
          errors: [],
        })),
      };
    } else if (specification.method === "thread/start") {
      const ordinal = ++this.#createOrdinal;
      const cwd = encoded.cwd;
      const threadSource = encoded.threadSource;
      this.#threadStarts.push({
        generation,
        serviceTier:
          typeof encoded.serviceTier === "string" ? encoded.serviceTier : null,
      });
      if (
        typeof cwd !== "string" ||
        typeof threadSource !== "string" ||
        encoded.ephemeral !== false ||
        encoded.historyMode !== "paginated"
      ) {
        throw new Error("e2e_codex_create_input_invalid");
      }
      const thread = this.#replaceThread({
        id: `e2e-codex-created-${threadSource}`,
        extra: {},
        sessionId: `e2e-codex-created-session-${threadSource}`,
        forkedFromId: null,
        parentThreadId: null,
        preview: "",
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "paginated",
        modelProvider: "openai",
        model: "gpt-5.6-codex",
        reasoningEffort: "low",
        createdAt: 1_700_010_000 + ordinal,
        updatedAt: 1_700_010_000 + ordinal,
        recencyAt: 1_700_010_000 + ordinal,
        status: { type: "idle" },
        path: null,
        cwd,
        cliVersion: "0.153.0",
        source: "appServer",
        canAcceptDirectInput: true,
        threadSource,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      });
      this.#serviceTierByThread.set(
        thread.id,
        typeof encoded.serviceTier === "string" ? encoded.serviceTier : null,
      );
      this.#notify(generation, "thread/started", { thread });
      if (this.#failNextCreateWithUnknownOutcome) {
        this.#failNextCreateWithUnknownOutcome = false;
        throw new CodexRpcDeliveryError({
          code: "e2e_codex_create_response_lost",
          delivery: "sent_outcome_unknown",
          generation,
          method: "thread/start",
        });
      }
      result = {
        thread,
        model: "gpt-5.6-codex",
        modelProvider: "openai",
        serviceTier: this.#serviceTierByThread.get(thread.id) ?? null,
        cwd,
        runtimeWorkspaceRoots: [cwd],
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        activePermissionProfile: {
          id: ":read-only",
          extends: null,
        },
        reasoningEffort: "low",
        multiAgentMode: "explicitRequestOnly",
      };
    } else {
      const threadId = encoded.threadId;
      const thread =
        typeof threadId === "string" ? this.#threads.get(threadId) : undefined;
      if (!thread) throw new Error("e2e_codex_thread_missing");
      if (specification.method === "thread/read") {
        result = {
          thread:
            thread.historyMode === "paginated" || encoded.includeTurns === false
              ? { ...thread, turns: [] }
              : thread,
        };
      } else if (specification.method === "thread/resume") {
        const paginated = thread.historyMode === "paginated";
        const initialTurnsPageInput = encoded.initialTurnsPage;
        if (
          paginated &&
          (encoded.excludeTurns !== true ||
            typeof initialTurnsPageInput !== "object" ||
            initialTurnsPageInput === null)
        ) {
          throw new Error("e2e_codex_paginated_resume_input_invalid");
        }
        const initialTurnsPage = paginated
          ? this.#paginatedTurnsPage(
              thread,
              initialTurnsPageInput as Readonly<Record<string, unknown>>,
            )
          : null;
        result = {
          thread: paginated ? { ...thread, turns: [] } : thread,
          model: "gpt-5.6-codex",
          modelProvider: "openai",
          serviceTier: this.#serviceTierByThread.get(thread.id) ?? null,
          cwd: thread.cwd,
          runtimeWorkspaceRoots: [thread.cwd],
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
          activePermissionProfile: {
            id: ":read-only",
            extends: null,
          },
          reasoningEffort: "low",
          multiAgentMode: "explicitRequestOnly",
          initialTurnsPage,
          turnsBackwardsCursor:
            initialTurnsPage === null
              ? null
              : (initialTurnsPage.backwardsCursor ?? null),
          itemsBackwardsCursor:
            paginated && thread.turns.some((turn) => turn.items.length > 0)
              ? `e2e-items-resume-boundary:${thread.id}`
              : null,
        };
      } else if (specification.method === "thread/turns/list") {
        result = this.#paginatedTurnsPage(thread, encoded);
      } else if (specification.method === "thread/items/list") {
        result = this.#paginatedItemsPage(thread, encoded);
      } else if (specification.method === "thread/settings/update") {
        const serviceTier =
          typeof encoded.serviceTier === "string" ? encoded.serviceTier : null;
        this.#serviceTierByThread.set(thread.id, serviceTier);
        this.#schedule(0, () =>
          this.#notify(generation, "thread/settings/updated", {
            threadId: thread.id,
            threadSettings: {
              cwd: thread.cwd,
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandboxPolicy: { type: "readOnly", networkAccess: false },
              activePermissionProfile: { id: ":read-only", extends: null },
              model: "gpt-5.6-codex",
              modelProvider: "openai",
              serviceTier,
              effort: "low",
              summary: null,
              collaborationMode: {
                mode: "default",
                settings: {
                  model: "gpt-5.6-codex",
                  reasoning_effort: "low",
                  developer_instructions: null,
                },
              },
              multiAgentMode: "explicitRequestOnly",
              personality: null,
            },
          }),
        );
        result = {};
      } else if (specification.method === "thread/unsubscribe") {
        result = { status: "unsubscribed" };
      } else if (specification.method === "turn/start") {
        if (this.#failNextSubmitWithUnknownOutcome) {
          this.#failNextSubmitWithUnknownOutcome = false;
          throw new CodexRpcDeliveryError({
            code: "e2e_codex_submit_response_lost",
            delivery: "sent_outcome_unknown",
            generation,
            method: "turn/start",
          });
        }
        const input = Array.isArray(encoded.input) ? encoded.input : [];
        const textInput = input.find(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "text",
        ) as { text?: unknown } | undefined;
        const ordinal = ++this.#turnOrdinal;
        const turnId = `interactive-turn-${ordinal}`;
        if (this.#holdNextTurnCompletion) {
          this.#holdNextTurnCompletion = false;
          this.#heldTurnCompletionIds.add(turnId);
        }
        const now = 1_700_001_000 + ordinal;
        const userItem = {
          type: "userMessage" as const,
          id: `interactive-user-${ordinal}`,
          clientId:
            typeof encoded.clientUserMessageId === "string"
              ? encoded.clientUserMessageId
              : null,
          content: [
            {
              type: "text" as const,
              text:
                typeof textInput?.text === "string"
                  ? textInput.text
                  : "Codex browser fixture prompt",
              text_elements: [],
            },
          ],
        };
        const holdUserMaterialization = this.#holdNextSubmitMaterialization;
        this.#holdNextSubmitMaterialization = false;
        if (holdUserMaterialization) {
          this.#heldSubmitMaterialization = {
            generation,
            nativeThreadId: thread.id,
            nativeTurnId: turnId,
            item: userItem,
          };
        }
        const turn = {
          id: turnId,
          items: holdUserMaterialization ? [] : [userItem],
          itemsView: "full" as const,
          status: "inProgress" as const,
          error: null,
          startedAt: now,
          completedAt: null,
          durationMs: null,
        };
        this.#replaceThread({
          ...thread,
          status: { type: "active", activeFlags: [] },
          updatedAt: now,
          recencyAt: now,
          turns: [...thread.turns, turn],
        });
        result = { turn };
        this.#schedule(120, () => {
          if (this.#interruptedTurnIds.has(turnId)) return;
          const commandItem = {
            type: "commandExecution" as const,
            id: `interactive-command-${ordinal}`,
            pluginId: null,
            scriptPath: null,
            command: "printf normalized-codex-stream",
            cwd: thread.cwd,
            processId: `process-${ordinal}`,
            source: "agent" as const,
            status: "inProgress" as const,
            commandActions: [],
            aggregatedOutput: "Codex stream started",
            exitCode: null,
            durationMs: null,
          };
          const current = this.#threads.get(thread.id)!;
          const currentTurn = current.turns.find(({ id }) => id === turnId)!;
          this.#replaceThread({
            ...current,
            turns: current.turns.map((candidate) =>
              candidate.id === turnId
                ? { ...currentTurn, items: [...currentTurn.items, commandItem] }
                : candidate,
            ),
          });
          this.#notify(generation, "item/started", {
            threadId: thread.id,
            turnId,
            item: commandItem,
            startedAtMs: now * 1_000,
          });
        });
        this.#schedule(700, () => {
          if (this.#interruptedTurnIds.has(turnId)) return;
          const current = this.#threads.get(thread.id)!;
          const currentTurn = current.turns.find(({ id }) => id === turnId)!;
          const command = currentTurn.items.find(
            ({ type }) => type === "commandExecution",
          );
          if (!command || command.type !== "commandExecution") return;
          const delta = "\nNormalized Codex tool output";
          this.#replaceThread({
            ...current,
            turns: current.turns.map((candidate) =>
              candidate.id === turnId
                ? {
                    ...currentTurn,
                    items: currentTurn.items.map((item) =>
                      item.id === command.id
                        ? {
                            ...command,
                            aggregatedOutput: `${command.aggregatedOutput ?? ""}${delta}`,
                          }
                        : item,
                    ),
                  }
                : candidate,
            ),
          });
          this.#notify(generation, "item/commandExecution/outputDelta", {
            threadId: thread.id,
            turnId,
            itemId: command.id,
            delta,
          });
        });
        const completeFixtureCommand = () => {
          if (this.#interruptedTurnIds.has(turnId)) return;
          if (this.#heldTurnCompletionIds.has(turnId)) {
            this.#schedule(100, completeFixtureCommand);
            return;
          }
          const current = this.#threads.get(thread.id)!;
          const currentTurn = current.turns.find(({ id }) => id === turnId)!;
          const completedCommand = {
            ...(currentTurn.items.find(
              ({ type }) => type === "commandExecution",
            ) as Extract<
              CodexThread["turns"][number]["items"][number],
              { type: "commandExecution" }
            >),
            status: "completed" as const,
            exitCode: 0,
            durationMs: 180,
          };
          this.#replaceThread({
            ...current,
            turns: current.turns.map((candidate) =>
              candidate.id === turnId
                ? {
                    ...currentTurn,
                    items: currentTurn.items.map((item) =>
                      item.id === completedCommand.id ? completedCommand : item,
                    ),
                  }
                : candidate,
            ),
          });
          this.#notify(generation, "item/completed", {
            threadId: thread.id,
            turnId,
            item: completedCommand,
            completedAtMs: now * 1_000 + 180,
          });
        };
        this.#schedule(1_300, completeFixtureCommand);
        const completeFixtureTurn = () => {
          if (this.#interruptedTurnIds.has(turnId)) return;
          const interactionBlocksCompletion = [
            ...this.#interactionRecords.values(),
          ].some(
            (record) =>
              record.nativeThreadId === thread.id &&
              (record.state === "pending" ||
                record.state === "response_received"),
          );
          const steerMaterializationBlocksCompletion =
            this.#steerMaterializationTarget?.nativeThreadId === thread.id ||
            [
              ...this.#heldSteerMaterializations,
              ...this.#drainingSteerMaterializations,
            ].some(
              (held) =>
                held.nativeThreadId === thread.id &&
                held.nativeTurnId === turnId,
            );
          const submitMaterializationBlocksCompletion =
            this.#heldSubmitMaterialization?.nativeThreadId === thread.id &&
            this.#heldSubmitMaterialization.nativeTurnId === turnId;
          if (
            this.#heldTurnCompletionIds.has(turnId) ||
            interactionBlocksCompletion ||
            steerMaterializationBlocksCompletion ||
            submitMaterializationBlocksCompletion
          ) {
            this.#schedule(100, completeFixtureTurn);
            return;
          }
          const current = this.#threads.get(thread.id)!;
          const currentTurn = current.turns.find(({ id }) => id === turnId)!;
          const finalAgent = {
            type: "agentMessage" as const,
            id: `interactive-agent-${ordinal}`,
            text: "Codex is streaming a browser-neutral normalized response.",
            phase: "final_answer" as const,
            memoryCitation: null,
            delivery: null,
            questions: null,
          };
          const completedTurn = {
            ...currentTurn,
            items: [...currentTurn.items, finalAgent],
            status: "completed" as const,
            completedAt: now + 1,
            durationMs: 2_600,
          };
          this.#replaceThread({
            ...current,
            status: { type: "idle" },
            updatedAt: now + 1,
            recencyAt: now + 1,
            turns: current.turns.map((candidate) =>
              candidate.id === turnId ? completedTurn : candidate,
            ),
          });
          this.#notify(generation, "item/completed", {
            threadId: thread.id,
            turnId,
            item: finalAgent,
            completedAtMs: now * 1_000 + 2_600,
          });
          this.#notify(generation, "turn/completed", {
            threadId: thread.id,
            turn: completedTurn,
          });
        };
        this.#schedule(2_600, completeFixtureTurn);
      } else if (specification.method === "turn/steer") {
        const activeTurn = [...thread.turns]
          .reverse()
          .find(({ status }) => status === "inProgress");
        if (!activeTurn) throw new Error("e2e_codex_turn_not_active");
        const input = Array.isArray(encoded.input) ? encoded.input : [];
        const clientId = encoded.clientUserMessageId;
        if (typeof clientId !== "string") {
          throw new Error("e2e_codex_steer_client_id_missing");
        }
        // Like Codex, the response only admits the input to the turn's
        // pending input; its userMessage appears when the turn drains it.
        const armed =
          this.#steerMaterializationTarget?.nativeThreadId === thread.id;
        const pendingSteer = {
          generation,
          nativeThreadId: thread.id,
          nativeTurnId: activeTurn.id,
          item: {
            type: "userMessage" as const,
            id: armed
              ? `interactive-steer-user-${++this.#turnOrdinal}`
              : `interactive-drained-steer-user-${++this.#drainedSteerOrdinal}`,
            clientId,
            content: input,
          },
        };
        if (armed && this.#steerMaterializationTarget) {
          this.#heldSteerMaterializations.push(pendingSteer);
          this.#steerMaterializationTarget.remaining -= 1;
          if (this.#steerMaterializationTarget.remaining === 0) {
            this.#steerMaterializationTarget = undefined;
          }
        } else {
          this.#drainingSteerMaterializations.push(pendingSteer);
          this.#schedule(50, () => {
            const index =
              this.#drainingSteerMaterializations.indexOf(pendingSteer);
            if (index < 0) return;
            this.#drainingSteerMaterializations.splice(index, 1);
            this.#materializeSteer(pendingSteer);
          });
        }
        result = { turnId: activeTurn.id };
      } else if (specification.method === "turn/interrupt") {
        const turnId = encoded.turnId;
        if (typeof turnId !== "string") {
          throw new Error("e2e_codex_interrupt_turn_missing");
        }
        this.#interruptedTurnIds.add(turnId);
        const interrupted = thread.turns.find(({ id }) => id === turnId);
        if (!interrupted) throw new Error("e2e_codex_turn_missing");
        // The interrupted turn no longer needs a completion hold.
        this.#heldTurnCompletionIds.delete(turnId);
        // Codex clears the interrupted turn's pending input without an event.
        for (const pending of [
          this.#heldSteerMaterializations,
          this.#drainingSteerMaterializations,
        ]) {
          for (let index = pending.length - 1; index >= 0; index -= 1) {
            if (
              pending[index]!.nativeThreadId === thread.id &&
              pending[index]!.nativeTurnId === turnId
            ) {
              pending.splice(index, 1);
            }
          }
        }
        const completedTurn = {
          ...interrupted,
          status: "interrupted" as const,
          completedAt: 1_700_002_000,
          durationMs: 1,
        };
        this.#replaceThread({
          ...thread,
          status: { type: "idle" },
          turns: thread.turns.map((candidate) =>
            candidate.id === turnId ? completedTurn : candidate,
          ),
        });
        this.#notify(generation, "turn/completed", {
          threadId: thread.id,
          turn: completedTurn,
        });
        result = {};
      } else if (specification.method === "thread/name/set") {
        const name = encoded.name;
        if (typeof name !== "string") {
          throw new Error("e2e_codex_name_missing");
        }
        this.#replaceThread({ ...thread, name, preview: name });
        this.#notify(generation, "thread/name/updated", {
          threadId: thread.id,
          threadName: name,
        });
        result = {};
      } else if (specification.method === "thread/compact/start") {
        result = {};
      } else {
        throw new Error(`e2e_codex_rpc_unexpected:${specification.method}`);
      }
    }
    return specification.decodeResult(result);
  }
}

async function main(): Promise<void> {
  if (!process.send) throw new Error("e2e_server_ipc_required");
  const configuredListenPort = process.env.E2E_LISTEN_PORT;
  if (!configuredListenPort || !/^\d+$/.test(configuredListenPort)) {
    throw new Error(
      "E2E_LISTEN_PORT must be 0 or an integer from 1024 to 65535.",
    );
  }
  const listenPort = Number(configuredListenPort);
  if (
    !Number.isInteger(listenPort) ||
    (listenPort !== 0 && (listenPort < 1024 || listenPort > 65_535))
  ) {
    throw new Error(
      "E2E_LISTEN_PORT must be 0 or an integer from 1024 to 65535.",
    );
  }
  const codexExecutionPolicy = {
    allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
    allowedNetworkAccess: ["disabled", "enabled"],
    allowedApprovalPolicies: ["untrusted", "on-request", "never"],
    allowedApprovalReviewers: ["user", "auto_review"],
  } as const satisfies CodexExecutionPolicyAllowlist;
  const codexDefaultExecutionPolicy = {
    sandboxMode: "read-only",
    networkAccess: "disabled",
    approvalPolicy: "never",
    approvalReviewer: "user",
  } as const satisfies CodexExecutionPolicySelection;
  const configurationFilename = process.env.SEDES_CONFIG_FILE?.trim();
  if (!configurationFilename) {
    throw new Error("SEDES_CONFIG_FILE is required.");
  }
  const bootstrapConfiguration = await loadBootstrapConfigurationFile(
    configurationFilename,
  );
  // This scripted server explicitly exercises the experimental accounting surfaces.
  const config = { ...loadConfig(process.env, bootstrapConfiguration), experimentalUsageEnabled: true };
  const fixtureWorkspaceRoots = [path.resolve(process.cwd())];
  const viewedImageFixturePath = path.join(config.stateDirectory, "viewed-image-fixture.png");
  let viewedImageReadCount = 0;
  let viewedImageReadGate: Promise<void> | undefined;
  let releaseViewedImageRead: (() => void) | undefined;
  let viewedImageCapture!: ViewedImageCaptureService;
  const configuredTarget = {
    id: "pi-sdk-local", kind: "pi_sdk" as const, label: "Pi SDK", backendInstanceId: "pi-local",
    executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405", enabled: true,
  };
  const backendConfiguration = configurationDocumentSchema.parse({
    executionEnvironments: [{ id: configuredTarget.executionEnvironmentId, kind: "local", label: "Local", workspaceRoots: fixtureWorkspaceRoots,
      workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated", "execution_host"] } }],
    defaultTargetId: configuredTarget.id,
    webSearch: { provider: "grok_cli" },
    backends: [
      { id: "pi-local", kind: "pi", label: "Pi SDK", enabled: true, modelPolicy: { type: "catalog" } },
      {
        id: "codex-import-e2e",
        kind: "codex_app_server",
        label: "Codex TCP",
        enabled: true,
        modelPolicy: codexModelPolicy.policy,
        moduleConfiguration: {
          connection: {
            ownership: "external",
            channel: {
              type: "tcp_websocket",
              url: FORBIDDEN_CODEX_TCP_ENDPOINT,
              authentication: {
                type: "capability_token",
                secret: {
                  source: "environment",
                  variable: FORBIDDEN_CODEX_TCP_SECRET_REFERENCE,
                },
              },
            },
          },
          policy: codexExecutionPolicy,
        },
      },
      {
        id: "codex-uds-e2e",
        kind: "codex_app_server",
        label: "Codex UDS",
        enabled: true,
        modelPolicy: codexModelPolicy.policy,
        moduleConfiguration: {
          connection: {
            ownership: "external",
            channel: {
              type: "unix_websocket",
              socketPath: FORBIDDEN_CODEX_UDS_SOCKET,
            },
          },
          policy: codexExecutionPolicy,
        },
      },
      {
        id: "codex-stdio-e2e",
        kind: "codex_app_server",
        label: "Codex stdio",
        enabled: true,
        modelPolicy: codexModelPolicy.policy,
        moduleConfiguration: {
          connection: {
            ownership: "owned",
            channel: {
              type: "process_stdio",
              executablePath: process.execPath,
              workingDirectory: process.cwd(),
              codexHome: path.join(config.stateDirectory, "codex-stdio-home"),
            },
          },
          policy: codexExecutionPolicy,
        },
      },
      {
        id: "claude-e2e",
        kind: "claude_agent_sdk",
        label: "Claude",
        enabled: true,
        modelPolicy: claudeModelPolicy.policy,
        moduleConfiguration: {
          executablePath: process.execPath,
          configDirectory: path.join(config.stateDirectory, "claude-home"),
          initializationTimeoutMs: 5_000,
          permissionPolicy: { allowedModes: ["default", "acceptEdits", "dontAsk", "auto", "bypassPermissions"] },
        },
      },
    ],
    targets: [
      configuredTarget,
      {
        ...configuredTarget,
        id: "pi-sdk-alternate",
        label: "Alternate scripted agent",
      },
      {
        id: "codex-import-local",
        kind: "codex_app_server",
        label: "Codex TCP external",
        backendInstanceId: "codex-import-e2e",
        executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
        enabled: true,
        moduleConfiguration: {
          defaults: {
            ...codexDefaultExecutionPolicy,
            model: { type: "fixed", modelId: "gpt-5.6-codex" },
          },
        },
      },
      {
        id: "codex-uds-local",
        kind: "codex_app_server",
        label: "Codex UDS external",
        backendInstanceId: "codex-uds-e2e",
        executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
        enabled: true,
        moduleConfiguration: {
          defaults: {
            ...codexDefaultExecutionPolicy,
            model: { type: "fixed", modelId: "gpt-5.6-codex" },
          },
        },
      },
      {
        id: "codex-stdio-local",
        kind: "codex_app_server",
        label: "Codex stdio owned",
        backendInstanceId: "codex-stdio-e2e",
        executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
        enabled: true,
        moduleConfiguration: {
          defaults: {
            ...codexDefaultExecutionPolicy,
            model: { type: "fixed", modelId: "gpt-5.6-codex" },
          },
        },
      },
      {
        id: "claude-local",
        kind: "claude_agent_sdk",
        label: "Claude subscription",
        backendInstanceId: "claude-e2e",
        executionEnvironmentId: configuredTarget.executionEnvironmentId,
        enabled: true,
        moduleConfiguration: { defaults: { permissionMode: "default" } },
      },
    ],
  });
  const startup = await prepareBackendNormalizedDatabase({
    stateDirectory: config.stateDirectory,
    locksHeld: true,
    quiescentCutoverConfirmed: true,
  });
  const database = startup.database;
  const usage = new UsageService(database, {enabled: true});
  const configurationFixture = initializeDatabaseConfigurationFixture(database, backendConfiguration, { sourceLabel: "scripted-e2e-configuration" });
  const notifications = new NotificationService({
    repository: new NotificationRepository(database),
  });
  const identity = new SingleUserIdentityProvider(database);
  const scope = identity.getScope();
  const composerAttachmentRepository = new ComposerAttachmentRepository(
    database,
  );
  const composerAttachments = new ComposerAttachmentService(
    new ComposerAttachmentBlobStore(config.stateDirectory),
    composerAttachmentRepository,
  );
  await composerAttachments.initialize();
  const outputArtifacts = new OutputArtifactService(
    new OutputArtifactBlobStore(config.stateDirectory),
    new OutputImageArtifactRepository(database),
  );
  outputArtifacts.initialize();
  const attachmentDelivery = new ComposerAttachmentDeliveryService(
    composerAttachments,
    new LocalExecutionAttachmentStager({
      scope,
      environmentId: configuredTarget.executionEnvironmentId,
      stateDirectory: config.stateDirectory,
      installationKey: new Uint8Array(32).fill(0x45),
    }),
    composerAttachmentRepository,
  );
  const configurations = new BackendConfigurationRepository(database);
  const defaultProfile = configurations.getProfileByTemplate(scope, configuredTarget.id);
  const defaultTarget = { target: { backendInstanceId: defaultProfile.backendInstanceId, connectionProfileId: defaultProfile.id, executionEnvironmentId: defaultProfile.executionEnvironmentId } };
  const backends = new Map(
    configurations
      .listBackends(scope)
      .map((record) => [record.id, backendInstance(record)]),
  );
  const backend = backends.get(defaultTarget.target.backendInstanceId);
  if (!backend) throw new Error("e2e_default_backend_missing");
  const connections = configurations
    .listProfiles(scope)
    .map((record) => connectionProfile(record));
  const connection = connections.find(
    ({ id }) => id === defaultTarget.target.connectionProfileId,
  );
  if (!connection) throw new Error("e2e_default_connection_missing");
  const codexConnection = connections.find(
    ({ templateId }) => templateId === "codex-import-local",
  );
  if (!codexConnection) throw new Error("e2e_codex_connection_missing");
  const codexBackend = backends.get(codexConnection.backendInstanceId);
  if (!codexBackend) throw new Error("e2e_codex_backend_missing");
  const codexUdsConnection = connections.find(
    ({ templateId }) => templateId === "codex-uds-local",
  );
  if (!codexUdsConnection) {
    throw new Error("e2e_codex_uds_connection_missing");
  }
  const codexUdsBackend = backends.get(codexUdsConnection.backendInstanceId);
  if (!codexUdsBackend) throw new Error("e2e_codex_uds_backend_missing");
  const codexStdioConnection = connections.find(
    ({ templateId }) => templateId === "codex-stdio-local",
  );
  if (!codexStdioConnection) {
    throw new Error("e2e_codex_stdio_connection_missing");
  }
  const codexStdioBackend = backends.get(
    codexStdioConnection.backendInstanceId,
  );
  if (!codexStdioBackend) throw new Error("e2e_codex_stdio_backend_missing");
  const claudeConnection = connections.find(
    ({ templateId }) => templateId === "claude-local",
  );
  if (!claudeConnection) throw new Error("e2e_claude_connection_missing");
  const claudeBackend = backends.get(claudeConnection.backendInstanceId);
  if (!claudeBackend) throw new Error("e2e_claude_backend_missing");
  const piConnections = connections.filter(
    ({ backendInstanceId }) => backendInstanceId === backend.id,
  );
  const piTargetAvailability = new Map<string, boolean>(
    piConnections.map(({ id }) => [id, true] as const),
  );
  let codeStages: Map<"closed" | "settled", { released: boolean; deliver?: () => void }> | undefined;
  let mermaidStages: Map<"closed" | "settled", { released: boolean; deliver?: () => void }> | undefined;
  let bookmarkStages: Map<"closed" | "settled", { released: boolean; deliver?: () => void }> | undefined;
  let piTurnResponseArmed = false;
  let piTurnResponseRelease: (() => void) | undefined;
  let piBackgroundBurst: {
    release(): Promise<void>;
    finish(): void;
  } | undefined;
  let piPendingSteerArmed = false;
  let piPendingSteerMaterialize: (() => Promise<void>) | undefined;
  const piDrivers = new Map(
    piConnections.map((candidate) => [
      candidate.id,
      new InMemoryConformanceDriver({
        usage,
        instance: backend,
        connection: candidate,
        scriptedResponses: { stepDelayMilliseconds: 800 },
      }),
    ]),
  );
  for (const [connectionProfileId, driver] of piDrivers) {
    const deliverAssistantStage = driver.deliverScriptedAssistantStage.bind(driver);
    driver.deliverScriptedAssistantStage = (input, stage, deliver) => {
      const gate = input === "Stream a Mermaid diagram progressively"
        ? mermaidStages?.get(stage)
        : input === "Stream a TypeScript code fence progressively"
          ? codeStages?.get(stage)
          : input === "Bookmark the durable identity design"
            ? bookmarkStages?.get(stage)
            : undefined;
      if (!gate || gate.released) return deliverAssistantStage(input, stage, deliver);
      gate.deliver = () => deliverAssistantStage(input, stage, deliver);
    };
    const scheduleResponse = driver.scheduleScriptedResponse.bind(driver);
    driver.scheduleScriptedResponse = (...args) => {
      const [record, turn, inputText] = args;
      if (inputText === "Fail with a visible model configuration diagnostic") {
        setTimeout(() => {
          const completedAt = driver.now();
          const failedTurn = {
            ...record.snapshot.turnsById[turn.backendTurnId]!,
            status: "failed" as const,
            endedBy: "failed" as const,
            completedAt,
            failure: { message: { text: "The configured model is unavailable. Select another model." } },
          };
          record.snapshot.turnsById[turn.backendTurnId] = failedTurn;
          record.snapshot.runState = "failed";
          delete record.snapshot.activeBackendTurnId;
          record.updatedAt = completedAt;
          record.historyRevision += 1;
          driver.updateTerminalReconciliation(record, failedTurn);
          driver.emit(record, { type: "turn_completed", turn: failedTurn });
          driver.emit(record, { type: "run_state_changed", state: "failed" });
        }, 100).unref();
        return;
      }
      if (inputText === "Accumulate a retained background response") {
        if (piBackgroundBurst) throw new Error("e2e_background_burst_busy");
        const assistant = {
          backendItemId: `memory-item-${++record.itemCounter}`,
          backendTurnId: turn.backendTurnId,
          semanticKind: "assistant_message" as const,
          sourceOrder: 1,
          startedAt: driver.now(),
          status: "streaming" as const,
          markdown: { text: "Background response ready.\n\n" },
        };
        record.snapshot.itemsById[assistant.backendItemId] = assistant;
        record.snapshot.turnsById[turn.backendTurnId] = {
          ...record.snapshot.turnsById[turn.backendTurnId]!,
          orderedBackendItemIds: [
            ...record.snapshot.turnsById[turn.backendTurnId]!.orderedBackendItemIds,
            assistant.backendItemId,
          ],
        };
        driver.emit(record, { type: "item_started", item: assistant });
        let released = false;
        let readyToFinish = false;
        piBackgroundBurst = {
          async release() {
            if (released) throw new Error("e2e_background_burst_already_released");
            released = true;
            // Small producer batches let the real actor consume each event;
            // this models an accumulated stream without overrunning its queue.
            for (let index = 0; index < 640; index += 1) {
              const line = `Background update ${String(index + 1).padStart(3, "0")}: `.padEnd(63, ".") + "\n";
              assistant.markdown = { text: assistant.markdown.text + line };
              record.snapshot.itemsById[assistant.backendItemId] = { ...assistant };
              driver.emit(record, { type: "item_updated", item: assistant });
              if (index % 16 === 15) await nextEventLoopTurn();
            }
            readyToFinish = true;
          },
          finish() {
            if (!readyToFinish) throw new Error("e2e_background_burst_not_finished");
            const completedAt = driver.now();
            const item = {
              ...assistant,
              status: "completed" as const,
              completedAt,
              markdown: { text: assistant.markdown.text + "\nBackground response complete: 界 🌍." },
            };
            record.snapshot.itemsById[item.backendItemId] = item;
            driver.emit(record, { type: "item_completed", item });
            const completedTurn = {
              ...record.snapshot.turnsById[turn.backendTurnId]!,
              status: "completed" as const,
              endedBy: "agent_settled" as const,
              completedAt,
            };
            record.snapshot.turnsById[turn.backendTurnId] = completedTurn;
            record.snapshot.runState = "idle";
            delete record.snapshot.activeBackendTurnId;
            record.updatedAt = completedAt;
            record.historyRevision += 1;
            driver.updateTerminalReconciliation(record, completedTurn);
            driver.emit(record, { type: "turn_completed", turn: completedTurn });
            driver.emit(record, { type: "run_state_changed", state: "idle" });
          },
        };
        return;
      }
      if (!piTurnResponseArmed) return scheduleResponse(...args);
      piTurnResponseArmed = false;
      piTurnResponseRelease = () => scheduleResponse(...args);
    };
    const healthy = driver.health.bind(driver);
    driver.health = async () =>
      piTargetAvailability.get(connectionProfileId) === false
        ? {
            available: false,
            checkedAt: new Date().toISOString(),
            reason: "Disabled by the saved-agent E2E fixture.",
          }
        : healthy();
    const attach = driver.attach.bind(driver);
    driver.attach = async (...args) => {
      const handle = await attach(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "steer") {
            const steer = target.steer.bind(target);
            return async (input: SteerTurnInput): Promise<SteerTurnResult> => {
              if (!piPendingSteerArmed) return steer(input);
              piPendingSteerArmed = false;
              if (piPendingSteerMaterialize) {
                throw new Error("e2e_pi_pending_steer_already_held");
              }
              piPendingSteerMaterialize = async () => {
                await steer(input);
              };
              return {
                status: "pending_materialization",
                reconciliationToken: input.reconciliationToken,
                completionCorrelation: input.applicationOperationId,
                ...(input.target.kind === "turn" ? { backendTurnId: input.target.turnId } : {}),
              };
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as ConversationHandle;
    };
  }
  type ForkControl = {
    readonly sourceThreadId: string;
    readonly mode: "hold" | "lose_response";
    entered: boolean;
    release?: () => void;
    gate?: Promise<void>;
  };
  let forkControl: ForkControl | undefined;
  for (const driver of piDrivers.values()) {
    const branch = driver.branchConversation.bind(driver);
    driver.branchConversation = async (
      input: BranchConversationInput,
    ): Promise<CreateConversationResult> => {
      const control = forkControl;
      if (
        !control ||
        control.sourceThreadId !== input.sourceBinding.applicationThreadId
      ) {
        return branch(input);
      }
      control.entered = true;
      if (control.mode === "hold") {
        await control.gate;
        const result = await branch(input);
        if (forkControl === control) forkControl = undefined;
        return result;
      }
      const result = await branch(input);
      if (forkControl === control) forkControl = undefined;
      void result;
      throw new BackendError({
        category: "submission_unknown",
        retryable: false,
        crossedSubmissionBoundary: true,
        safeMessage:
          "The test provider created the fork but lost its response.",
        backendCode: "e2e_fork_response_lost",
      });
    };
  }
  const codexRpc = new CodexE2eRpcFixture();
  const codexUdsRpc = new CodexE2eRpcFixture();
  const codexStdioRpc = new CodexE2eRpcFixture();
  const codexFastModeSessions = new CodexFastModeSessionRegistry();
  const codexUdsFastModeSessions = new CodexFastModeSessionRegistry();
  const codexStdioFastModeSessions = new CodexFastModeSessionRegistry();
  const codexTuiFixture = new CodexTuiE2eFixture();
  let codexTuiAvailable = true;
  const codexManagedTui = new CodexManagedTuiController({
    client: codexRpc.client,
    isResumable: () => codexTuiAvailable,
  });
  codexManagedTui.configure(codexTuiFixture);
  const codexUdsManagedTui = new CodexManagedTuiController({
    client: codexUdsRpc.client,
  });
  codexUdsManagedTui.configure(codexTuiFixture);
  const codexStdioManagedTui = new CodexManagedTuiController({
    client: codexStdioRpc.client,
  });
  const codexExecutionSettings = new CodexThreadExecutionSettingsRepository(
    database,
  );
  const codexExecutionSettingsProvider: CodexExecutionSettingsProvider = {
    desiredSettings: (providerScope, applicationThreadId) =>
      codexExecutionSettings.find(providerScope, applicationThreadId)
        ?.desired ?? null,
    resolveFastModeDisabled(providerScope, input) {
      const current = codexExecutionSettings.find(
        providerScope,
        input.applicationThreadId,
      );
      if (!current?.desired || current.desired.serviceTier === "standard") {
        return current?.desired ?? null;
      }
      return codexExecutionSettings.updateDesired(
        providerScope,
        input.applicationThreadId,
        {
          expectedRevision: current.revision,
          desired: { ...current.desired, serviceTier: "standard" },
          now: input.now,
        },
      ).desired;
    },
    forkSettingsEligibility: (providerScope, applicationThreadId) =>
      codexForkSettingsEligibility(
        codexExecutionSettings.find(providerScope, applicationThreadId),
        codexExecutionPolicy,
      ),
    freezeOperationSnapshot(providerScope, input) {
      const { source: _source, ...repositoryInput } = input;
      return codexExecutionSettings.freezeOperationSnapshot(
        providerScope,
        repositoryInput,
      );
    },
    observeEffective(providerScope, input) {
      if (
        input.settings.policyObservation !== "complete" ||
        !input.settings.reasoningEffort
      ) {
        return;
      }
      const current = codexExecutionSettings.find(
        providerScope,
        input.applicationThreadId,
      );
      if (!current) throw new Error("e2e_codex_settings_missing");
      codexExecutionSettings.confirmEffective(
        providerScope,
        input.applicationThreadId,
        {
          expectedRevision: current.revision,
          effective: {
            model: input.settings.model,
            reasoningEffort: input.settings.reasoningEffort,
            serviceTier: input.settings.serviceTier,
            serviceTierClassification: input.settings.serviceTierClassification,
            sandboxMode: input.settings.sandboxMode,
            sandboxClassification: input.settings.sandboxClassification,
            networkAccess: input.settings.networkAccess,
            networkClassification: input.settings.networkClassification,
            approvalPolicy: input.settings.approvalPolicy,
            approvalPolicyClassification:
              input.settings.approvalPolicyClassification,
            approvalReviewer: input.settings.approvalReviewer,
            approvalReviewerClassification:
              input.settings.approvalReviewerClassification,
          },
          daemonGeneration: input.confirmationGeneration,
          now: input.now,
        },
      );
    },
    markEffectiveUnknown: (
      providerScope: RequestScope,
      input: { applicationThreadId: string; now: number },
    ) => {
      const current = codexExecutionSettings.find(
        providerScope,
        input.applicationThreadId,
      );
      if (!current || current.effectiveConfirmationState === "unknown") return;
      codexExecutionSettings.markConfirmationUnknown(
        providerScope,
        input.applicationThreadId,
        { expectedRevision: current.revision, now: input.now },
      );
    },
  };
  const composerSkillPreferences = new PrincipalApplicationPreferenceRepository(
    database,
  );
  const codexDriverFactory = new CodexBackendDriverFactory({
    usageSink: usage, nativeNamespace: "e2e-codex",
    scope,
    instance: codexBackend,
    client: codexRpc.client,
    outputArtifacts,
    viewedImageCapture: { capture: input => viewedImageCapture.capture(input) },
    serverRequests: codexRpc.serverRequests,
    toolProvenanceKey: new Uint8Array(32).fill(0x45),
    modelPolicy: codexModelPolicy,
    executionSettings: codexExecutionSettingsProvider,
    composerSkillPreferences,
    fastModeSessions: codexFastModeSessions,
    agentToolCliEnvironment: unavailableCodexAgentToolCliEnvironmentProvider,
    managedTui: codexManagedTui,
    materializedConnections: [codexConnection],
    connections: [
      {
        id: codexConnection.templateId,
        enabled: true,
        configuration: {
          defaults: {
            ...codexDefaultExecutionPolicy,
            model: {
              type: "fixed",
              modelId: "gpt-5.6-codex",
            },
          },
        },
      },
    ],
  });
  const codexUdsDriverFactory = new CodexBackendDriverFactory({
    usageSink: usage, nativeNamespace: "e2e-codex",
    scope,
    instance: codexUdsBackend,
    client: codexUdsRpc.client,
    outputArtifacts,
    viewedImageCapture: { capture: input => viewedImageCapture.capture(input) },
    serverRequests: codexUdsRpc.serverRequests,
    toolProvenanceKey: new Uint8Array(32).fill(0x45),
    modelPolicy: codexModelPolicy,
    executionSettings: codexExecutionSettingsProvider,
    composerSkillPreferences,
    fastModeSessions: codexUdsFastModeSessions,
    agentToolCliEnvironment: unavailableCodexAgentToolCliEnvironmentProvider,
    managedTui: codexUdsManagedTui,
    materializedConnections: [codexUdsConnection],
    connections: [
      {
        id: codexUdsConnection.templateId,
        enabled: true,
        configuration: {
          defaults: {
            ...codexDefaultExecutionPolicy,
            model: {
              type: "fixed",
              modelId: "gpt-5.6-codex",
            },
          },
        },
      },
    ],
  });
  const codexStdioDriverFactory = new CodexBackendDriverFactory({
    usageSink: usage, nativeNamespace: "e2e-codex",
    scope,
    instance: codexStdioBackend,
    client: codexStdioRpc.client,
    outputArtifacts,
    viewedImageCapture: { capture: input => viewedImageCapture.capture(input) },
    serverRequests: codexStdioRpc.serverRequests,
    toolProvenanceKey: new Uint8Array(32).fill(0x45),
    modelPolicy: codexModelPolicy,
    executionSettings: codexExecutionSettingsProvider,
    composerSkillPreferences,
    fastModeSessions: codexStdioFastModeSessions,
    agentToolCliEnvironment: unavailableCodexAgentToolCliEnvironmentProvider,
    managedTui: codexStdioManagedTui,
    materializedConnections: [codexStdioConnection],
    connections: [
      {
        id: codexStdioConnection.templateId,
        enabled: true,
        configuration: {
          defaults: {
            ...codexDefaultExecutionPolicy,
            model: {
              type: "fixed",
              modelId: "gpt-5.6-codex",
            },
          },
        },
      },
    ],
  });
  const claudeSdk = new ClaudeE2eSdk();
  const claudePersistence = new ClaudeBackendThreadPersistenceAdapter({
    database,
    scope,
    backendInstanceId: claudeBackend.id,
    resolveConnectionDefaults: () => ({ permissionMode: "default" }),
  });
  const claudeDriverFactory = new ClaudeBackendDriverFactory({
      usage: NO_USAGE_SINK,
      nativeNamespace: "claude-test-native",
    scope,
    instance: claudeBackend,
    runtimeClient: new ClaudeSdkRuntimeAdapter(claudeSdk),
    executablePath: process.execPath,
    initializationTimeoutMs: 5_000,
    probeDirectory: process.cwd(),
    settings: claudePersistence.settings,
    permissionPolicy: claudePermissionPolicy,
    modelPolicy: claudeModelPolicy,
    attachmentProvenanceKey: new Uint8Array(32).fill(0x42),
    connections: [claudeConnection],
    agentToolCli: {
      availability: "unavailable",
      reason: "cli_unavailable",
    },
    toolProvenanceKey: new Uint8Array(32).fill(7),
    childEnvironment: Object.freeze({ ...process.env }),
    agentToolSourceCapabilities: {
      issue: () => "htr2_" + "a".repeat(64),
    },
    agentTools: e2eBackendAgentTools,
  });
  const registry = new AgentBackendRegistry();
  registry.register({
    scope,
    instance: backend,
    connectionKinds: ["pi_sdk"],
    supportsConversationCreation: true,
    creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
    create(candidate) {
      const selected = piDrivers.get(candidate.id);
      if (!selected) throw new Error("e2e_connection_mismatch");
      return selected;
    },
  });
  registry.register(codexDriverFactory);
  registry.register(codexUdsDriverFactory);
  registry.register(codexStdioDriverFactory);
  registry.register(claudeDriverFactory);
  if (!(await registry.driver(claudeConnection).health()).available) {
    throw new Error("e2e_claude_fixture_unhealthy");
  }

  const inventoryRepository = new InventoryRepository(database);
  const notificationLifecycle = new NotificationLifecycleObserver(
    inventoryRepository,
    (eventScope, payload, eventKey, assistantResult) =>
      notifications.emit(eventScope, payload, eventKey, assistantResult),
  );
  const threadGroupRepository = new ThreadGroupRepository(database);
  const environmentRecord = inventoryRepository.getLocalEnvironment(scope);
  const terminalFixture = new TerminalE2eFixture(environmentRecord.id);
  const terminalRepository = new TerminalRepository(database);
  let publishTerminalSummary:
    ((changedScope: RequestScope, threadId: string) => void) | undefined;
  const terminalService = new TerminalService({
    inventory: inventoryRepository,
    repository: terminalRepository,
    journal: new TerminalJournalStore({
      stateDirectory: config.stateDirectory,
    }),
    providers: new Map([[environmentRecord.id, terminalFixture]]),
    onTerminalSummaryChanged: (changedScope, threadId) => {
      if (!publishTerminalSummary) {
        throw new Error("e2e_terminal_summary_publisher_unavailable");
      }
      publishTerminalSummary(changedScope, threadId);
    },
  });
  terminalService.recover(scope);
  const terminalAdmissions = new TerminalAdmissionTokens(terminalService);
  const execution = new LocalExecutionEnvironment({
    environmentId: environmentRecord.id,
    scope,
    allowedRoots: fixtureWorkspaceRoots,
    workspaceTrusted: () => true,
    configurationRevision: environmentRecord.configurationRevision,
    activeConfigurationRevision: () =>
      inventoryRepository.getEnvironment(scope, environmentRecord.id)
        .configurationRevision,
  });
  inventoryRepository.updateEnvironmentAvailability(scope, environmentRecord.id, { available: true, now: Date.now() });
  const workspaceFileRoots = new WorkspaceFileRootRepository(database);
  const workspaceFiles = new WorkspaceFileService(
    inventoryRepository,
    workspaceFileRoots,
    new WorkspaceFileLinkedWorktreeRepository(database),
    execution,
    new LocalWorkspaceFileProvider({
      scope,
      environmentId: environmentRecord.id,
      testHooks: { afterReadMetadata: async (relativePath) => {
        if (path.basename(relativePath) !== path.basename(viewedImageFixturePath)) return;
        viewedImageReadCount += 1;
        await viewedImageReadGate;
      } },
    }),
    { publishApplicationThreadChanges: async () => undefined },
  );
  const workspaceDiffReviews = new WorkspaceDiffReviewService(
    inventoryRepository,
    workspaceFileRoots,
    new WorkspaceFileLinkedWorktreeRepository(database),
    new WorkspaceDiffReviewRepository(database),
  );
  const bindings = new ConversationBindingRepository(database);
  viewedImageCapture = new ViewedImageCaptureService({ artifacts: outputArtifacts,
    files: workspaceFiles, bindings, inventory: inventoryRepository });
  const creation = new ConversationCreationRepository(database);
  const drafts = new ConversationDraftRepository(database);
  const completion = new SubmissionCompletionRepository(database);
  const completionCallbacks = new ThreadCompletionCallbackRepository(database);
  const deliveryInputSnapshots = new DeliveryInputSnapshotRepository(database);
  const queueRepository = new QueuedInputRepository(database);
  const operationRepository = new ConversationOperationRepository(database);
  const lineageRepository = new ThreadLineageRepository(database);
  const automationRepository = new AutomationRepository(database);
  const persistence = new TestBackendPersistence(database);
  const piPreferences = new ConnectionSettingPreferenceRepository(database);
  const piSavedAgentPersistence = new TestPiSavedAgentPersistence(
    new PiConversationRepository(database),
    piPreferences,
  );
  const piSavedAgentAdapter = new PiSavedAgentAdapter({
    preferences: piPreferences,
    persistence: piSavedAgentPersistence,
  });
  const codexPersistence = new CodexBackendThreadPersistenceAdapter({
    database,
    scope,
    backendInstanceId: codexBackend.id,
    executionSettings: codexExecutionSettings,
    executionPolicy: codexExecutionPolicy,
    modelPolicy: codexModelPolicy,
    resolveConnectionDefaults: (candidate) =>
      candidate.id === codexConnection.id
        ? {
            ...codexDefaultExecutionPolicy,
            model: { type: "fixed", modelId: "gpt-5.6-codex" },
          }
        : undefined,
  });
  const codexUdsPersistence = new CodexBackendThreadPersistenceAdapter({
    database,
    scope,
    backendInstanceId: codexUdsBackend.id,
    executionSettings: codexExecutionSettings,
    executionPolicy: codexExecutionPolicy,
    modelPolicy: codexModelPolicy,
    resolveConnectionDefaults: (candidate) =>
      candidate.id === codexUdsConnection.id
        ? {
            ...codexDefaultExecutionPolicy,
            model: { type: "fixed", modelId: "gpt-5.6-codex" },
          }
        : undefined,
  });
  const codexStdioPersistence = new CodexBackendThreadPersistenceAdapter({
    database,
    scope,
    backendInstanceId: codexStdioBackend.id,
    executionSettings: codexExecutionSettings,
    executionPolicy: codexExecutionPolicy,
    modelPolicy: codexModelPolicy,
    resolveConnectionDefaults: (candidate) =>
      candidate.id === codexStdioConnection.id
        ? {
            ...codexDefaultExecutionPolicy,
            model: { type: "fixed", modelId: "gpt-5.6-codex" },
          }
        : undefined,
  });
  const backendPersistence = new Map<
    string,
    | TestBackendPersistence
    | CodexBackendThreadPersistenceAdapter
    | ClaudeBackendThreadPersistenceAdapter
  >([
    [backend.id, persistence],
    [codexBackend.id, codexPersistence],
    [codexUdsBackend.id, codexUdsPersistence],
    [codexStdioBackend.id, codexStdioPersistence],
    [claudeBackend.id, claudePersistence],
  ]);
  const actionPersistence = new TestActionPersistence(database);
  const claudeModelEfforts = new ClaudeModelEffortCatalog();
  const claudePresentation = new ClaudeThreadPresentationProvider(
    claudePersistence.settings,
    claudeModelEfforts,
    claudePermissionPolicy,
    claudeModelPolicy,
  );
  const actionPersistenceByBackend = new Map<
    string,
    ThreadActionPersistenceProvider
  >([
    [backend.id, actionPersistence],
    [
      codexBackend.id,
      new CodexThreadActionPersistence({
        database,
        scope,
        backendInstanceId: codexBackend.id,
        settings: codexExecutionSettings,
        featureMutations: new ProviderFeatureMutationRepository(database),
        executionPolicy: codexExecutionPolicy,
        modelPolicy: codexModelPolicy,
        defaultExecutionPolicyByConnectionId: new Map([
          [codexConnection.id, codexDefaultExecutionPolicy],
        ]),
        fastModeRuntime: codexFastModeSessions,
      }),
    ],
    [
      codexUdsBackend.id,
      new CodexThreadActionPersistence({
        database,
        scope,
        backendInstanceId: codexUdsBackend.id,
        settings: codexExecutionSettings,
        featureMutations: new ProviderFeatureMutationRepository(database),
        executionPolicy: codexExecutionPolicy,
        modelPolicy: codexModelPolicy,
        defaultExecutionPolicyByConnectionId: new Map([
          [codexUdsConnection.id, codexDefaultExecutionPolicy],
        ]),
        fastModeRuntime: codexUdsFastModeSessions,
      }),
    ],
    [
      codexStdioBackend.id,
      new CodexThreadActionPersistence({
        database,
        scope,
        backendInstanceId: codexStdioBackend.id,
        settings: codexExecutionSettings,
        featureMutations: new ProviderFeatureMutationRepository(database),
        executionPolicy: codexExecutionPolicy,
        modelPolicy: codexModelPolicy,
        defaultExecutionPolicyByConnectionId: new Map([
          [codexStdioConnection.id, codexDefaultExecutionPolicy],
        ]),
        fastModeRuntime: codexStdioFastModeSessions,
      }),
    ],
    [
      claudeBackend.id,
      new ClaudeThreadActionPersistence(
        database,
        scope,
        claudeBackend.id,
        claudePersistence.settings,
        claudeModelEfforts,
        claudePermissionPolicy,
        claudeModelPolicy,
      ),
    ],
  ]);
  const targets = new DatabaseConversationTargetStore({
    database,
    bindings,
    bindingDetails: backendPersistence,
    registry,
    environments: execution,
  });
  const actorTargets = new DatabaseActorTargetResolver(targets);
  const lifecycleTargets = new DatabaseLifecycleTargetResolver(targets);
  let questions: QuestionRequestService | undefined;
  let mutationsForSubmissions: ThreadMutationGateway | undefined;
  let observeAuthoritativeCompletion:
    AuthoritativeCompletionObserver | undefined;
  const actors = new ConversationActorManager({
    environments: execution,
    attachmentDelivery,
    deliveryInputSnapshots,
    retentionMilliseconds: config.conversationRetentionMilliseconds,
    runtimeBudget: config.conversationRuntimeBudget,
    onHistoricalQuestion: (eventScope, threadId, sourceItemId) =>
      questions?.remember(eventScope, threadId, sourceItemId),
    onNonblockingQuestions: (eventScope, threadId, sourceItemId, payload) =>
      questions?.observe(eventScope, threadId, sourceItemId, payload),
    // As in production, exact materialization accepts a pending Steer.
    onAuthoritativeSubmission: (eventScope, applicationThreadId, input) =>
      mutationsForSubmissions?.observeAuthoritativeSubmission(
        eventScope,
        applicationThreadId,
        input.backendCorrelation,
      ),
    onAuthoritativeCompletion: (eventScope, applicationThreadId, input) =>
      observeAuthoritativeCompletion?.(eventScope, applicationThreadId, input),
  });
  const environmentVariables = new EnvironmentVariablesService(database, configurationFixture.repository);
  const lifecycle = new ConversationLifecycleService({
    environmentVariables,
    registry,
    targets: lifecycleTargets,
    backendPersistence,
    bindings,
    creation,
    drafts,
    completion,
    actors,
    attachmentDelivery,
  });
  const applicationThreadSummaries = new DatabaseApplicationThreadSummaryReader(
    {
      inventory: inventoryRepository,
      queue: queueRepository,
      completion,
    },
  );
  const forks = new ThreadForkService({
    environmentVariables,
    database,
    targets,
    actors,
    backendPersistence,
    bindings,
    creation,
    checkpoints: new BackendCheckpointRepository(database),
    lineage: lineageRepository,
    inventory: inventoryRepository,
    operations: operationRepository,
    outputArtifacts,
    automations: automationRepository,
    automationExecutionPolicy: { assertCanAutomate: () => undefined },
    descendantSummaries: applicationThreadSummaries,
    descendantTerminalSummaries: terminalRepository,
    lineageCursorSigningKey: Buffer.alloc(32, 7),
  });
  const threadHubs = new ScopedThreadEventHubRegistry();
  const applicationHubs = new ScopedApplicationEventHubs();
  const interactions = new InteractionBroker({
    onOpened: (eventScope, interaction) =>
      notificationLifecycle.interactionOpened(eventScope, interaction),
  });
  const agentToolPolicyDependencies =
    threadAgentToolPolicyReaderDependencies(database);
  const threadInventory = new DatabaseThreadApplicationInventoryReader({
    inventory: inventoryRepository,
    queue: queueRepository,
    completion,
    ...agentToolPolicyDependencies,
    directoryBrowsingAvailability: (requestScope, environmentId) =>
      execution.directoryBrowsingAvailability(requestScope, environmentId),
    executionWorkspaces: directThreadExecutionWorkspaceReader,
  });
  const threadPresentation = new DatabaseThreadApplicationPresentationReader({
    targets,
    providers: new Map([
      [backend.id, interactivePresentation],
      [
        codexBackend.id,
        new CodexThreadPresentationProvider({
          settings: codexExecutionSettings,
          executionPolicy: codexExecutionPolicy,
          modelPolicy: codexModelPolicy,
          managedTui: codexManagedTui,
          fastModeRuntime: codexFastModeSessions,
        }),
      ],
      [
        codexUdsBackend.id,
        new CodexThreadPresentationProvider({
          settings: codexExecutionSettings,
          executionPolicy: codexExecutionPolicy,
          modelPolicy: codexModelPolicy,
          managedTui: codexUdsManagedTui,
          fastModeRuntime: codexUdsFastModeSessions,
        }),
      ],
      [
        codexStdioBackend.id,
        new CodexThreadPresentationProvider({
          settings: codexExecutionSettings,
          executionPolicy: codexExecutionPolicy,
          modelPolicy: codexModelPolicy,
          managedTui: codexStdioManagedTui,
          fastModeRuntime: codexStdioFastModeSessions,
        }),
      ],
      [claudeBackend.id, claudePresentation],
    ]),
  });
  const threads = new ThreadApplicationService({
      usage,
    inventory: threadInventory,
    conversations: new ActorBackedThreadApplicationConversationReader({
      actors,
      targets: actorTargets,
    }),
    queue: new DatabaseThreadApplicationQueueReader(queueRepository),
    presentation: threadPresentation,
    recovery: new DatabaseThreadApplicationRecoveryReader({
      creation,
      operations: operationRepository,
      targets: lifecycleTargets,
      registry,
      forks,
    }),
    interactions,
    actionPersistence: actionPersistenceByBackend,
    attachmentDelivery,
  });
  const history = new ThreadHistoryService({ usage, inventory: threadInventory });
  threads.bindHistory(history);

  let publishApplicationThread: ApplicationThreadChangePublisher | undefined;
  let queue!: QueuedInputDispatcher;
  const runtimes = new ThreadRuntimeCoordinator({
    actors,
    targets: actorTargets,
    bridge: new ConversationEventBridge(new ThreadEventPresentation(threads), (scope, threadId, turns) => usage.registerVisibleTurns(scope, threadId, turns)),
    interactions,
    hubs: threadHubs,
    retentionMilliseconds: config.conversationRetentionMilliseconds,
    onThreadChanged: (eventScope, applicationThreadId) =>
      publishApplicationThread?.publish(eventScope, applicationThreadId),
    onAuthoritativeSettled: (eventScope, applicationThreadId) =>
      queue.onAuthoritativeSettled(eventScope, applicationThreadId),
  });
  actors.bindPressureReclaimer((request) =>
    runtimes.tryReclaimOldestIdleRuntime(request),
  );
  forks.bindDescendantRunStates(runtimes);
  history.bindRuntimes(runtimes);
  usage.subscribe((scope, threadId, revision) => runtimes.publishUsageRevisionIfLoaded(scope, threadId, revision));
  const queueGateway = new RuntimeBackedQueuedInputConversationGateway({
    runtimes,
    targets: actorTargets,
    attachmentDelivery,
  });
  let observeAutomationQueue: AutomationQueueRunObserver | undefined;
  let queueThreadSnapshots: ThreadSnapshotPublisher | undefined;
  queue = new QueuedInputDispatcher({
    repository: queueRepository,
    gateway: queueGateway,
    publisher: {
      publish(eventScope, applicationThreadId, event) {
        threadHubs.thread(eventScope, applicationThreadId).publish(event);
        for (const item of queueRepository.list(
          eventScope,
          applicationThreadId,
        )) {
          observeAutomationQueue?.observe(
            eventScope,
            applicationThreadId,
            item,
          );
        }
        void publishApplicationThread
          ?.publish(eventScope, applicationThreadId)
          .catch(() => undefined);
        // As in production, a queue transition (for example, a pending steer
        // resolving) refreshes the thread's delivery capabilities.
        try {
          queueThreadSnapshots?.schedule(eventScope, applicationThreadId);
        } catch {
          // Queue state is durable and will be present in the next snapshot.
        }
      },
    },
    retryPolicy: {
      maximumRetries: 2,
      baseDelayMilliseconds: 25,
      maximumDelayMilliseconds: 100,
    },
    isDispatchBlocked: (eventScope, applicationThreadId) =>
        inventoryRepository.isWorkspaceRemoved(eventScope, inventoryRepository.getThread(eventScope, applicationThreadId).thread.workspaceId) ||
      operationRepository.hasBlockingThreadOperation(
        eventScope,
        applicationThreadId,
      ),
  });
  questions = new QuestionRequestService({
    repository: new QuestionRequestRepository(database, inventoryRepository),
    inventory: inventoryRepository,
    queue: queueRepository,
    gateway: queueGateway,
    dispatch: queue,
    publish(eventScope, threadId, result) {
      void publishApplicationThread
        ?.publish(eventScope, threadId)
        .catch(() => undefined);
      const hub = threadHubs.thread(eventScope, threadId);
      if (hub.projectionGeneration) {
        hub.publish({
          type: "questions_changed",
          generation: hub.projectionGeneration,
          ...result,
        });
      }
    },
    onOpened(eventScope, request) {
      notificationLifecycle.questionOpened(eventScope, {
        ...request,
        questionCount: request.questions.length,
      });
    },
  });
  const completionCallbackDispatcher = new ThreadCompletionCallbackDispatcher({
    callbacks: completionCallbacks,
    inventory: inventoryRepository,
    repository: queueRepository,
    gateway: queueGateway,
    queue,
  });
  const authoritativeCompletionFollowUp = new DeferredProductionOperations(
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
    },
  );
  const taskRepository = new TaskRepository(database);
  const executionTargets = new DatabaseExecutionTargetReader({
    configuration: configurations,
    registry,
    defaultTargetTemplateId: configuredTarget.id,
    // The saved-Agent fixture mutates driver health at runtime. Disable the
    // production cache here so each disposable browser test observes the
    // reset performed by the preceding test immediately.
    healthCacheMilliseconds: 0,
  });
  const savedAgentAdapters = new SavedAgentBackendAdapterRegistry([
    { backendInstanceId: backend.id, adapter: piSavedAgentAdapter },
    {
      backendInstanceId: codexBackend.id,
      adapter: new CodexSavedAgentBackendAdapter({
        executionPolicy: codexExecutionPolicy,
        modelPolicy: codexModelPolicy,
        backendInstanceId: codexBackend.id,
        resolveConnectionDefaults: (candidate) =>
          candidate.id === codexConnection.id
            ? {
                ...codexDefaultExecutionPolicy,
                model: { type: "fixed", modelId: "gpt-5.6-codex" },
              }
            : undefined,
        persistence: codexPersistence,
      }),
    },
    {
      backendInstanceId: codexUdsBackend.id,
      adapter: new CodexSavedAgentBackendAdapter({
        executionPolicy: codexExecutionPolicy,
        modelPolicy: codexModelPolicy,
        backendInstanceId: codexUdsBackend.id,
        resolveConnectionDefaults: (candidate) =>
          candidate.id === codexUdsConnection.id
            ? {
                ...codexDefaultExecutionPolicy,
                model: { type: "fixed", modelId: "gpt-5.6-codex" },
              }
            : undefined,
        persistence: codexUdsPersistence,
      }),
    },
    {
      backendInstanceId: codexStdioBackend.id,
      adapter: new CodexSavedAgentBackendAdapter({
        executionPolicy: codexExecutionPolicy,
        modelPolicy: codexModelPolicy,
        backendInstanceId: codexStdioBackend.id,
        resolveConnectionDefaults: (candidate) =>
          candidate.id === codexStdioConnection.id
            ? {
                ...codexDefaultExecutionPolicy,
                model: { type: "fixed", modelId: "gpt-5.6-codex" },
              }
            : undefined,
        persistence: codexStdioPersistence,
      }),
    },
    {
      backendInstanceId: claudeBackend.id,
      adapter: new ClaudeSavedAgentBackendAdapter({
        persistence: claudePersistence,
        permissionPolicy: claudePermissionPolicy,
        modelPolicy: claudeModelPolicy,
        resolveConnectionDefaults: () => ({ permissionMode: "default" }),
      }),
    },
  ]);
  const savedAgentRepository = new SavedAgentRepository(database);
  const savedAgents = new SavedAgentApplicationService({
    environmentVariables,
    agents: new SavedAgentService(savedAgentRepository, savedAgentAdapters),
    repository: savedAgentRepository,
    adapters: savedAgentAdapters,
    configuration: configurations,
    inventory: inventoryRepository,
    targets,
    targetHealth: executionTargets,
    registry,
    lifecycle,
    toolPolicies: agentToolPolicyDependencies.agentTools,
    toolEligibility: agentToolPolicyDependencies.agentToolEligibility,
    toolCatalog: agentToolPolicyDependencies.agentToolCatalog,
    executionWorkspaces: directThreadExecutionWorkspaceAllocator,
    publications: {
      handoffThreadChange(eventScope, applicationThreadId) {
        applicationSnapshots.handoffThreadChange(
          eventScope,
          applicationThreadId,
        );
      },
    },
  });
  const threadTemplates = new ThreadTemplateApplicationService({
    repository: new ThreadTemplateRepository(database),
    savedAgents,
  });
  const application = new ApplicationSnapshotService(
    inventoryRepository,
    applicationThreadSummaries,
    runtimes,
    executionTargets,
    new DatabaseApplicationLineageSummaryReader(lineageRepository),
    taskRepository,
    threadGroupRepository,
    (requestScope, environmentId) =>
      execution.directoryBrowsingAvailability(requestScope, environmentId),
    terminalRepository,
  );
  const applicationSnapshots = new ApplicationSnapshotPublicationBoundary(
    application,
    applicationHubs,
  );
  targets.bindWorkspacePublications(applicationSnapshots);
  publishTerminalSummary = (changedScope, threadId) =>
    applicationSnapshots.handoffThreadChange(changedScope, threadId);
  const threadGroups = new ThreadGroupService(
    threadGroupRepository,
    applicationSnapshots,
  );
  forks.bindApplicationSnapshots(applicationSnapshots);
  publishApplicationThread = new ApplicationThreadChangePublisher(
    applicationSnapshots,
  );
  const codexDiscovery = new BackendDiscoveryService({
    targets,
    inventory: inventoryRepository,
    bindings,
    lineage: lineageRepository,
    forks,
    persistence: backendPersistence,
    connectionProfileId: codexConnection.id,
    onAncestryReconciliationConflict: () => undefined,
    onForkReconciliationError: () => undefined,
    onThreadChanged: (eventScope, applicationThreadId) =>
      publishApplicationThread!.publish(eventScope, applicationThreadId),
  });
  const discoverWorkspace = async (
    eventScope: RequestScope,
    workspaceId: string,
  ): Promise<void> => {
    const discoveredTarget = await targets.discovery(eventScope, {
      connectionProfileId: codexConnection.id,
      workspaceId,
    });
    codexRpc.ensureImportedThread(discoveredTarget.workspace);
    await codexDiscovery.discoverWorkspace(
      eventScope,
      workspaceId,
      EXHAUSTIVE_DISCOVERY_SCAN,
      new AbortController().signal,
    );
  };
  const snapshots = new ThreadSnapshotPublisher(
    bindings,
    threads,
    runtimes,
    (eventScope, applicationThreadId) =>
      publishApplicationThread!.publish(eventScope, applicationThreadId),
  );
  queueThreadSnapshots = snapshots;
  const inventory = new InventoryService(
    inventoryRepository,
    {
      publishMany: (eventScope, states) => {
        applicationSnapshots.handoffStructuralThreadChanges(eventScope, states.map(({ threadId }) => threadId));
        return snapshots.publishMany(eventScope, states.map(({ threadId }) => threadId));
      },
      publishApplicationThread: (eventScope, applicationThreadId) =>
        applicationSnapshots.publishThreadChange(
          eventScope,
          applicationThreadId,
        ),
    },
    (eventScope, state) =>
      notificationLifecycle.deadlineWake(eventScope, state),
  );
  const tasks = new TaskService(taskRepository, applicationSnapshots);
  const workpads = new WorkpadService(new WorkpadRepository(database), applicationSnapshots);
  forks.bindTaskPublications(tasks);
  const threadArchives = new ThreadArchiveService({
    inventory: inventoryRepository,
    lineage: lineageRepository,
    summaries: applicationThreadSummaries,
    runtimes,
    publications: inventory,
    tasks: taskRepository,
    taskPublications: applicationSnapshots,
    executionWorkspaces: directThreadExecutionWorkspaceLifecycle,
  });
  const threadBulkInventory = new ThreadBulkInventoryService({
    inventory: inventoryRepository,
    summaries: applicationThreadSummaries,
    runtimes,
    publications: inventory,
    tasks: taskRepository,
    taskPublications: applicationSnapshots,
  });
  const threadForceResets = new ThreadForceResetService({
    repository: new ThreadForceResetRepository(database),
    interactions,
    runtimes,
    scheduleThreadPublications: (eventScope, threadIds) =>
      snapshots.scheduleMany(eventScope, threadIds),
    publishTaskChange: (eventScope, taskId) =>
      tasks.publishTaskChange(eventScope, taskId),
  });
  observeAuthoritativeCompletion = async (
    eventScope,
    applicationThreadId,
    input,
  ) => {
    const observed = await queue.onAuthoritativeCompletion(
      eventScope,
      applicationThreadId,
      input,
    );
    if (!observed) return;
    notificationLifecycle.completion(eventScope, observed);
    authoritativeCompletionFollowUp.defer(async () => {
      const failures: unknown[] = [];
      try {
        await completionCallbackDispatcher.deliverReady(eventScope);
      } catch (error) {
        failures.push(error);
      }
      try {
        await mutations.recoverThread(eventScope, applicationThreadId);
      } catch (error) {
        failures.push(error);
      }
      try {
        await inventory.wakeForRuntimeSignal(
          eventScope,
          applicationThreadId,
          "completion",
        );
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "E2E authoritative completion follow-up did not finish cleanly.",
        );
      }
    });
  };
  const attention = new ThreadAttentionService({
    inventory: inventoryRepository,
    completions: completion,
    queue,
    publish: (eventScope, applicationThreadId) =>
      snapshots.publish(eventScope, applicationThreadId),
  });
  const mutations = new ThreadMutationGateway({
    bindings,
    inventory: inventoryRepository,
    lifecycle,
    forks,
    queue,
    operations: operationRepository,
    completions: completion,
    queueGateway,
    runtimes,
    interactions,
    presentation: threadPresentation,
    agentToolPolicies: agentToolPolicyDependencies.agentTools,
    actionPersistence: actionPersistenceByBackend,
    publishThreadSnapshot: (eventScope, applicationThreadId) =>
      snapshots.publish(eventScope, applicationThreadId),
    onThreadChanged: (eventScope, applicationThreadId) =>
      publishApplicationThread!.publish(eventScope, applicationThreadId),
  });
  threads.bindMutations(mutations);
  mutationsForSubmissions = mutations;
  const automations = new AutomationService({
    onRunLifecycle: (eventScope, input) =>
      notificationLifecycle.automation(eventScope, input),
    repository: automationRepository,
    inventory: inventoryRepository,
    publisher: snapshots,
    executionPolicy: { assertCanAutomate: () => undefined },
  });
  const automationFirstInput = new ConversationLifecycleAutomationFirstInput(
    lifecycle,
  );
  const automationGateway = new LifecycleAutomationConversationGateway({
    threads: {
      read(eventScope, applicationThreadId) {
        const thread = inventoryRepository.getThread(
          eventScope,
          applicationThreadId,
        ).thread;
        return {
          backingState: thread.backingState,
          revision: thread.revision,
        };
      },
    },
    queue,
    queueRepository,
    firstInput: automationFirstInput,
    branches: forks,
    executionPolicy: { assertCanAutomate: () => undefined },
  });
  const automationDispatcher = new AutomationDispatcher({
    repository: automationRepository,
    gateway: automationGateway,
    inventory: inventoryRepository,
    service: automations,
    prechecks: new AutomationPrecheckExecutor(inventoryRepository, execution),
  });
  automations.bindDispatcher(automationDispatcher);
  observeAutomationQueue = new AutomationQueueRunObserver({
    repository: automationRepository,
    queue: queueRepository,
    publisher: automations,
  });
  await queue.recover(scope);
  await completionCallbackDispatcher.deliverReady(scope);
  await mutations.recoverUncertain(scope);
  observeAutomationQueue.recover();
  const eligibleManagedTuiControllers = [
    codexManagedTui,
    codexUdsManagedTui,
  ] as const;
  const controllerForManagedTerminal = (input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly resourceGeneration?: number;
  }) => {
    const controller = eligibleManagedTuiControllers.find((candidate) => {
      const generation = candidate.registry.runningGeneration(
        input.scope,
        input.applicationThreadId,
      );
      return (
        generation !== undefined &&
        (input.resourceGeneration === undefined ||
          generation === input.resourceGeneration)
      );
    });
    if (!controller) throw new Error("e2e_codex_tui_authority_missing");
    return controller;
  };
  const managedTerminalAuthority: ManagedTerminalResourceAuthority = {
    authorizeAdmission: (input) =>
      controllerForManagedTerminal(input).authorizeAdmission(input),
    attachViewer: (input, emit) =>
      controllerForManagedTerminal(input).attachViewer(input, emit),
  };
  const managedTerminalAdmissions = new ManagedTerminalAdmissionTokens(
    managedTerminalAuthority,
  );
  const drain = new ApplicationDrainController();
  const longLivedConnections = new LongLivedHttpConnectionRegistry();
  const app = express();
  const applicationDecisionRecords = new Map<
    number,
    E2eApplicationDecisionRecord
  >();
  let applicationDecisionOrdinal = 20_000;

  const resetApplicationDecisions = () => {
    for (const record of applicationDecisionRecords.values()) {
      if (record.state === "pending" && !record.controller.signal.aborted) {
        record.controller.abort(
          new Error("e2e_application_decision_fixture_reset"),
        );
      }
    }
    applicationDecisionRecords.clear();
  };

  app.post(
    "/__e2e/agent-completion-callbacks/send/:callerThreadId/:targetThreadId",
    async (request, response) => {
      try {
        const caller = inventoryRepository.getThread(
          scope,
          request.params.callerThreadId,
        );
        inventoryRepository.getThread(scope, request.params.targetThreadId);
        const result = await mutations.sendDirect(scope, {
          initiator: {
            kind: "thread_agent",
            sourceThreadId: caller.thread.id,
            sourceWorkspaceId: caller.thread.workspaceId,
          },
          targetThreadId: request.params.targetThreadId,
          message: "Complete the callback E2E task and report the result.",
          callback: true,
          mutationId: randomUUID(),
        });
        response.status(202).json(result);
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_completion_callback_send_failed",
        });
      }
    },
  );

  app.post(
    "/__e2e/interactions/open-application/:threadId",
    async (request, response) => {
      const applicationThreadId = request.params.threadId;
      const binding = bindings.getBinding(scope, applicationThreadId);
      if (!binding || binding.backendInstanceId !== codexBackend.id) {
        response.status(409).json({
          error: "e2e_application_decision_thread_invalid",
        });
        return;
      }
      let runtime;
      try {
        runtime = await runtimes.acquire(scope, applicationThreadId);
        if (
          runtime.actor.timeline.runState !== "running" ||
          !runtime.actor.timeline.activeTurnId
        ) {
          runtime.release();
          response.status(409).json({
            error: "e2e_application_decision_turn_not_active",
          });
          return;
        }
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_application_decision_runtime_unavailable",
        });
        return;
      }

      const requestId = ++applicationDecisionOrdinal;
      const controller = new AbortController();
      const record: E2eApplicationDecisionRecord = {
        requestId,
        applicationThreadId,
        state: "pending",
        controller,
      };
      applicationDecisionRecords.set(requestId, record);
      const generation = runtime.actor.timeline.generation;
      void interactions
        .requestApplicationDecision({
          scope,
          applicationThreadId,
          generation,
          presentation: {
            sourceLabel: { text: "Local environment" },
            title: { text: "Allow Open workspace?" },
            message: {
              text: "This tool wants to access Review environment for the review workspace.",
            },
            code: { text: "workspace.open@1 · write" },
            destructive: false,
          },
          signal: controller.signal,
        })
        .then(
          (decision) => {
            if (applicationDecisionRecords.get(requestId) !== record) return;
            record.state = "resolved";
            record.decision = decision;
          },
          (error: unknown) => {
            if (applicationDecisionRecords.get(requestId) !== record) return;
            if (controller.signal.aborted) {
              record.state = "cancelled";
              return;
            }
            record.state = "failed";
            record.failure =
              error instanceof Error ? error.message.slice(0, 240) : "unknown";
          },
        )
        .finally(() => runtime.release());
      response.status(202).json({ requestId });
    },
  );
  app.post(
    "/__e2e/interactions/cancel-application/:requestId",
    (request, response) => {
      const requestId = Number(request.params.requestId);
      const record = applicationDecisionRecords.get(requestId);
      if (!record) {
        response.status(404).json({
          error: "e2e_application_decision_request_unknown",
        });
        return;
      }
      record.controller.abort(new Error("e2e_application_decision_cancelled"));
      response.status(204).end();
    },
  );
  app.get("/__e2e/interactions/application-state", (_request, response) => {
    response.json({
      records: [...applicationDecisionRecords.values()].map((record) => ({
        requestId: record.requestId,
        applicationThreadId: record.applicationThreadId,
        state: record.state,
        ...(record.decision ? { decision: record.decision } : {}),
        ...(record.failure ? { failure: record.failure } : {}),
      })),
    });
  });
  app.post(
    "/__e2e/interactions/open/:threadId/:scenario",
    (request, response) => {
      const scenario = request.params.scenario;
      if (
        !E2E_INTERACTION_SCENARIOS.includes(scenario as E2eInteractionScenario)
      ) {
        response
          .status(400)
          .json({ error: "e2e_interaction_scenario_invalid" });
        return;
      }
      const binding = bindings.getBinding(scope, request.params.threadId);
      if (!binding || binding.backendInstanceId !== codexBackend.id) {
        response.status(409).json({ error: "e2e_interaction_thread_invalid" });
        return;
      }
      try {
        const requestIds = codexRpc.openInteractionScenario(
          binding.backendConversationId,
          scenario as E2eInteractionScenario,
        );
        response.status(202).json({ requestIds });
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_interaction_open_failed",
        });
      }
    },
  );
  app.post("/__e2e/interactions/release/:requestId", (request, response) => {
    const requestId = Number(request.params.requestId);
    if (!Number.isSafeInteger(requestId) || requestId <= 0) {
      response.status(400).json({ error: "e2e_interaction_request_invalid" });
      return;
    }
    try {
      codexRpc.releaseInteraction(requestId);
      response.status(204).end();
    } catch (error) {
      response.status(404).json({
        error:
          error instanceof Error
            ? error.message
            : "e2e_interaction_release_failed",
      });
    }
  });
  app.get("/__e2e/interactions/state", (_request, response) => {
    response.json(codexRpc.interactionState());
  });
  app.post("/__e2e/interactions/reset", (_request, response) => {
    codexRpc.resetInteractions();
    resetApplicationDecisions();
    response.status(204).end();
  });
  app.post("/__e2e/forks/arm/:sourceThreadId/:mode", (request, response) => {
    const mode = request.params.mode;
    if (mode !== "hold" && mode !== "lose_response") {
      response.status(400).json({ error: "e2e_fork_mode_invalid" });
      return;
    }
    if (forkControl) {
      response.status(409).json({ error: "e2e_fork_control_already_armed" });
      return;
    }
    let release: (() => void) | undefined;
    const gate =
      mode === "hold"
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;
    forkControl = {
      sourceThreadId: request.params.sourceThreadId,
      mode,
      entered: false,
      ...(release ? { release } : {}),
      ...(gate ? { gate } : {}),
    };
    response.status(204).end();
  });
  app.get("/__e2e/forks/state", (_request, response) => {
    response.json(
      forkControl
        ? {
            armed: true,
            sourceThreadId: forkControl.sourceThreadId,
            mode: forkControl.mode,
            entered: forkControl.entered,
          }
        : { armed: false, entered: false },
    );
  });
  app.post("/__e2e/forks/release", (_request, response) => {
    if (!forkControl?.release) {
      response.status(409).json({ error: "e2e_fork_not_held" });
      return;
    }
    const release = forkControl.release;
    forkControl.release = undefined;
    release();
    response.status(204).end();
  });
  app.post("/__e2e/forks/reset", (_request, response) => {
    forkControl?.release?.();
    forkControl = undefined;
    response.status(204).end();
  });
  app.post("/__e2e/codex/arm-create-outcome-unknown", (_request, response) => {
    codexRpc.armNextCreateOutcomeUnknown();
    response.status(204).end();
  });
  app.post("/__e2e/codex/arm-submit-outcome-unknown", (_request, response) => {
    try {
      codexRpc.armNextSubmitOutcomeUnknown();
      response.status(204).end();
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : "e2e_codex_submit_fault_arm_failed",
      });
    }
  });
  app.post(
    "/__e2e/codex/reset-submit-outcome-unknown",
    (_request, response) => {
      codexRpc.resetSubmitOutcomeUnknown();
      response.status(204).end();
    },
  );
  app.post("/__e2e/codex/viewed-image/:threadId/emit", async (request, response, next) => {
    try {
      const binding = bindings.getBinding(scope, request.params.threadId);
      if (!binding || binding.backendInstanceId !== codexBackend.id) {
        response.status(409).json({ error: "e2e_viewed_image_binding_invalid" });
        return;
      }
      const bytes = await readFile(path.join(process.cwd(), "public/sedes-mark.png"));
      await writeFile(viewedImageFixturePath, bytes);
      viewedImageReadCount = 0;
      viewedImageReadGate = new Promise(resolve => { releaseViewedImageRead = resolve; });
      codexRpc.emitViewedImage(binding.backendConversationId, viewedImageFixturePath);
      response.json({ sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length });
    } catch (error) { next(error); }
  });
  app.get("/__e2e/codex/viewed-image/state", (_request, response) => {
    response.json({ reads: viewedImageReadCount });
  });
  app.post("/__e2e/codex/viewed-image/release", (_request, response) => {
    releaseViewedImageRead?.();
    releaseViewedImageRead = undefined;
    viewedImageReadGate = undefined;
    response.status(204).end();
  });
  app.post("/__e2e/codex/viewed-image/remove", async (_request, response, next) => {
    try {
      releaseViewedImageRead?.();
      releaseViewedImageRead = undefined;
      viewedImageReadGate = undefined;
      await unlink(viewedImageFixturePath);
      response.status(204).end();
    } catch (error) { next(error); }
  });
  app.post("/__e2e/codex/questions/:threadId", (request, response) => {
    const binding = bindings.getBinding(scope, request.params.threadId);
    if (!binding || binding.backendInstanceId !== codexBackend.id) {
      response.status(409).json({ error: "e2e_question_thread_invalid" });
      return;
    }
    try {
      codexRpc.emitNonblockingQuestions(binding.backendConversationId);
      response.status(204).end();
    } catch (error) {
      response
        .status(409)
        .json({
          error:
            error instanceof Error ? error.message : "e2e_question_emit_failed",
        });
    }
  });
  app.post("/__e2e/codex/turn-completion/arm", (_request, response) => {
    try {
      codexRpc.armNextTurnCompletion();
      response.status(204).end();
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : "e2e_codex_turn_completion_arm_failed",
      });
    }
  });
  app.post("/__e2e/codex/turn-completion/release", (_request, response) => {
    try {
      codexRpc.releaseTurnCompletion();
      response.status(204).end();
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : "e2e_codex_turn_completion_release_failed",
      });
    }
  });
  app.post("/__e2e/codex/turn-completion/reset", (_request, response) => {
    codexRpc.resetTurnCompletion();
    response.status(204).end();
  });
  app.post("/__e2e/codex/submit-materialization/arm", (_request, response) => {
    try {
      codexRpc.armNextSubmitMaterialization();
      response.status(204).end();
    } catch (error) {
      response.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : "e2e_codex_submit_materialization_arm_failed",
      });
    }
  });
  app.get("/__e2e/codex/submit-materialization/state", (_request, response) => {
    response.json(codexRpc.submitMaterializationState());
  });
  app.post(
    "/__e2e/codex/submit-materialization/release",
    (_request, response) => {
      try {
        codexRpc.releaseSubmitMaterialization();
        response.status(204).end();
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_codex_submit_materialization_release_failed",
        });
      }
    },
  );
  app.post(
    "/__e2e/codex/submit-materialization/reset",
    (_request, response) => {
      codexRpc.resetSubmitMaterialization();
      response.status(204).end();
    },
  );
  app.post(
    "/__e2e/saved-agents/pi-targets/:targetTemplateId/:availability",
    (request, response) => {
      const available =
        request.params.availability === "available"
          ? true
          : request.params.availability === "unavailable"
            ? false
            : undefined;
      const connectionProfile = piConnections.find(
        ({ templateId }) => templateId === request.params.targetTemplateId,
      );
      if (available === undefined) {
        response.status(400).json({ error: "e2e_availability_invalid" });
        return;
      }
      if (!connectionProfile) {
        response.status(404).json({ error: "e2e_pi_target_unknown" });
        return;
      }
      piTargetAvailability.set(connectionProfile.id, available);
      response.status(204).end();
    },
  );
  app.post("/__e2e/saved-agents/pi-targets/reset", (_request, response) => {
    for (const connectionProfile of piConnections) {
      piTargetAvailability.set(connectionProfile.id, true);
    }
    response.status(204).end();
  });
  app.post("/__e2e/pi/bookmark/arm", (_request, response) => {
    bookmarkStages = new Map([
      ["closed", { released: false }],
      ["settled", { released: false }],
    ]);
    response.status(204).end();
  });
  app.post("/__e2e/pi/bookmark/release", (_request, response) => {
    for (const gate of bookmarkStages?.values() ?? []) {
      gate.released = true;
      gate.deliver?.();
      gate.deliver = undefined;
    }
    response.status(204).end();
  });
  app.post("/__e2e/pi/mermaid/arm", (_request, response) => {
    mermaidStages = new Map([
      ["closed", { released: false }],
      ["settled", { released: false }],
    ]);
    response.status(204).end();
  });
  app.post("/__e2e/pi/mermaid/release/:stage", (request, response) => {
    const stage = request.params.stage;
    if (stage !== "closed" && stage !== "settled") {
      response.status(400).end();
      return;
    }
    const gate = mermaidStages?.get(stage);
    if (!gate) { response.status(409).end(); return; }
    gate.released = true;
    gate.deliver?.();
    gate.deliver = undefined;
    response.status(204).end();
  });
  app.post("/__e2e/pi/code/arm", (_request, response) => {
    codeStages = new Map([
      ["closed", { released: false }],
      ["settled", { released: false }],
    ]);
    response.status(204).end();
  });
  app.post("/__e2e/pi/code/release/:stage", (request, response) => {
    const stage = request.params.stage;
    if (stage !== "closed" && stage !== "settled") {
      response.status(400).end();
      return;
    }
    const gate = codeStages?.get(stage);
    if (!gate) { response.status(409).end(); return; }
    gate.released = true;
    gate.deliver?.();
    gate.deliver = undefined;
    response.status(204).end();
  });
  app.post("/__e2e/pi/turn-response/arm", (_request, response) => {
    if (piTurnResponseArmed || piTurnResponseRelease) {
      response.status(409).json({ error: "e2e_pi_turn_response_busy" });
      return;
    }
    piTurnResponseArmed = true;
    response.status(204).end();
  });
  app.post("/__e2e/pi/background-burst/:stage", async (request, response, next) => {
    const burst = piBackgroundBurst;
    if (!burst) {
      response.status(409).json({ error: "e2e_background_burst_not_held" });
      return;
    }
    try {
      if (request.params.stage === "release") await burst.release();
      else if (request.params.stage === "finish") {
        burst.finish();
        piBackgroundBurst = undefined;
      } else {
        response.sendStatus(404);
        return;
      }
      await nextEventLoopTurn();
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  app.post("/__e2e/pi/turn-response/release", (_request, response) => {
    const release = piTurnResponseRelease;
    if (!release) {
      response.status(409).json({ error: "e2e_pi_turn_response_not_held" });
      return;
    }
    piTurnResponseRelease = undefined;
    release();
    response.status(204).end();
  });
  app.post("/__e2e/pi/pending-steer/arm", (_request, response) => {
    if (piPendingSteerArmed || piPendingSteerMaterialize) {
      response.status(409).json({ error: "e2e_pi_pending_steer_busy" });
      return;
    }
    piPendingSteerArmed = true;
    response.status(204).end();
  });
  app.post("/__e2e/pi/pending-steer/release", async (_request, response) => {
    const materialize = piPendingSteerMaterialize;
    if (!materialize) {
      response.status(409).json({ error: "e2e_pi_pending_steer_not_held" });
      return;
    }
    piPendingSteerMaterialize = undefined;
    await materialize();
    response.status(204).end();
  });
  app.post("/__e2e/pi/pending-steer/reset", (_request, response) => {
    piPendingSteerArmed = false;
    piPendingSteerMaterialize = undefined;
    response.status(204).end();
  });
  app.post(
    "/__e2e/codex/steer-materialization/arm/:threadId",
    (request, response) => {
      const binding = bindings.getBinding(scope, request.params.threadId);
      if (!binding || binding.backendInstanceId !== codexBackend.id) {
        response.status(409).json({ error: "e2e_codex_steer_thread_invalid" });
        return;
      }
      try {
        const countValue = Array.isArray(request.query.count)
          ? request.query.count[0]
          : request.query.count;
        const count =
          typeof countValue === "string" ? Number(countValue) : undefined;
        codexRpc.armNextSteerMaterialization(
          binding.backendConversationId,
          count,
        );
        response.status(204).end();
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_codex_steer_arm_failed",
        });
      }
    },
  );
  app.get("/__e2e/codex/steer-materialization/state", (_request, response) => {
    response.json(codexRpc.steerMaterializationState());
  });
  app.post(
    "/__e2e/codex/steer-materialization/release",
    (_request, response) => {
      try {
        codexRpc.releaseSteerMaterialization();
        response.status(204).end();
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_codex_steer_release_failed",
        });
      }
    },
  );
  app.post("/__e2e/codex/steer-materialization/reset", (_request, response) => {
    codexRpc.resetSteerMaterialization();
    response.status(204).end();
  });
  if (process.env.SEDES_BROWSER_BENCHMARK === "1") {
    app.post(
      "/__e2e/browser-benchmark/:threadId/:operation",
      async (request, response, next) => {
        const binding = bindings.getBinding(scope, request.params.threadId);
        if (!binding || binding.backendInstanceId !== codexBackend.id) {
          response.status(409).json({ error: "benchmark_binding_invalid" });
          return;
        }
        try {
          if (request.params.operation === "seed")
            await codexRpc.seedBrowserBenchmark(binding.backendConversationId);
          else if (request.params.operation === "stream")
            await codexRpc.streamBrowserBenchmark(
              binding.backendConversationId,
            );
          else {
            response.sendStatus(404);
            return;
          }
          response.sendStatus(204);
        } catch (error) {
          next(error);
        }
      },
    );
  }
  app.post(
    "/__e2e/codex/readable-abandoned-history/:threadId",
    async (request, response) => {
      const binding = bindings.getBinding(scope, request.params.threadId);
      if (!binding || binding.backendInstanceId !== codexBackend.id) {
        response
          .status(409)
          .json({ error: "e2e_codex_abandoned_history_binding_invalid" });
        return;
      }
      try {
        await codexRpc.seedReadableAbandonedHistory(
          binding.backendConversationId,
        );
        response.status(204).end();
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_codex_abandoned_history_seed_failed",
        });
      }
    },
  );
  app.post(
    "/__e2e/threads/:threadId/publish-authoritative-replacement",
    async (request, response, next) => {
      try {
        const published =
          await snapshots.publishAuthoritativeReplacementIfLoaded(
            scope,
            request.params.threadId,
          );
        response.json({ published });
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    "/__e2e/threads/:threadId/close-idle-runtime",
    async (request, response) => {
      let runtime: Awaited<ReturnType<typeof runtimes.acquire>> | undefined;
      try {
        runtime = await runtimes.acquire(scope, request.params.threadId);
        const actor = runtime.actor;
        runtime.release();
        runtime = undefined;
        const closed = await actor.closeIfIdle();
        if (!closed) {
          response.status(409).json({ error: "e2e_thread_runtime_not_idle" });
          return;
        }
        response.status(204).end();
      } catch (error) {
        runtime?.release();
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_thread_runtime_close_failed",
        });
      }
    },
  );
  app.get("/__e2e/codex/state", (_request, response) => {
    response.json(codexRpc.state());
  });
  app.get("/__e2e/codex-tui/state", (_request, response) => {
    response.json(codexTuiFixture.state());
  });
  app.get("/__e2e/terminals/state", (_request, response) => {
    response.json({ terminals: terminalFixture.state() });
  });
  app.post(
    "/__e2e/terminals/:terminalId/output",
    express.json({ limit: "128kb" }),
    (request, response) => {
      try {
        const body = z
          .strictObject({ text: z.string().max(64 * 1024) })
          .parse(request.body);
        terminalFixture.emit(request.params.terminalId, body.text);
        response.status(204).end();
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_terminal_output_failed",
        });
      }
    },
  );
  app.post(
    "/__e2e/terminals/:terminalId/arm-input-result",
    express.json({ limit: "4kb" }),
    (request, response) => {
      try {
        const body = z
          .strictObject({
            outcome: z.enum(["sent", "not_sent", "sent_outcome_unknown"]),
          })
          .parse(request.body);
        terminalFixture.armWriteOutcome(
          request.params.terminalId,
          body.outcome,
        );
        response.status(204).end();
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_terminal_input_result_failed",
        });
      }
    },
  );
  app.post(
    "/__e2e/terminals/:terminalId/arm-input-delay",
    express.json({ limit: "4kb" }),
    (request, response) => {
      try {
        const body = z
          .strictObject({ milliseconds: z.number().int().min(1).max(2_000) })
          .parse(request.body);
        terminalFixture.armWriteDelay(
          request.params.terminalId,
          body.milliseconds,
        );
        response.status(204).end();
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_terminal_input_delay_failed",
        });
      }
    },
  );
  app.post(
    "/__e2e/terminals/:terminalId/drop-transport",
    (request, response) => {
      try {
        terminalFixture.exit(request.params.terminalId, {
          disposition: "interrupted",
          exitCode: null,
          signal: null,
          diagnosticCode: "e2e_sidecar_transport_lost",
        });
        response.status(204).end();
      } catch (error) {
        response.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : "e2e_terminal_transport_drop_failed",
        });
      }
    },
  );
  app.post(
    "/__e2e/codex-tui/availability/:threadId/:availability",
    async (request, response, next) => {
      try {
        const availability = request.params.availability;
        if (availability !== "available" && availability !== "unavailable") {
          response.status(400).json({ error: "e2e_tui_availability_invalid" });
          return;
        }
        codexTuiAvailable = availability === "available";
        await snapshots.publish(scope, request.params.threadId);
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );
  app.get(
    "/__e2e/codex/backends/:backendInstanceId/state",
    (request, response) => {
      const fixture = new Map([
        [codexBackend.id, codexRpc],
        [codexUdsBackend.id, codexUdsRpc],
        [codexStdioBackend.id, codexStdioRpc],
      ]).get(request.params.backendInstanceId);
      if (!fixture) {
        response.status(404).json({ error: "e2e_codex_backend_unknown" });
        return;
      }
      response.json(fixture.state());
    },
  );
  // This fixture stands in for a provider invocation, while preserving the real
  // workpad service, revision checks, persistence, attribution, and publication.
  // Canonical tool authorization is covered by the tool integration suite.
  app.post("/__e2e/workpads/:workpadId/agent-edit/:threadId", express.json({ limit: "1mb" }), async (request, response, next) => {
    try {
      inventoryRepository.getThread(scope, request.params.threadId);
      const update = updateWorkpadRequestSchema.parse(request.body);
      const workpad = await workpads.update(scope, request.params.workpadId, update, {
        kind: "agent", threadId: request.params.threadId,
      });
      response.json(workpad);
    } catch (error) {
      next(error);
    }
  });
  const e2eAgentToolSourceAuthority = new DatabaseAgentToolSourceAuthority(
    database,
    Buffer.alloc(32, 19),
  );
  const e2ePrincipalToolClients = new PrincipalAgentToolClientService(
    Buffer.alloc(32, 23),
    database,
    new PrincipalAgentToolClientRepository(
      database,
      createPrincipalAgentToolClientEligibility(),
    ),
    new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
    }),
    new AgentToolEnvironmentAuthorityResolver(e2eAgentToolSourceAuthority),
    Date.now,
    {},
    agentToolPolicyDependencies.agentToolCatalog,
  );
  const e2eAgentTools = unavailableAgentToolRouterDependencies();
  Object.assign(e2eAgentTools, { clients: e2ePrincipalToolClients });
  const configurationAdmin = await createConfigurationAdminFixture({
    scope, repository: configurationFixture.repository, projection: configurationFixture.projection,
    initial: configurationFixture.snapshot,
    provisionedConfiguration: backendConfiguration,
    onReconciled: async requestScope => {
      await applicationSnapshots.publishAuthoritativeReplacement(requestScope);
    },
    activeResources: async (kind, id) => {
      const records = database.prepare(`SELECT id FROM application_threads WHERE tenant_id = ? AND owner_principal_id = ?
        AND ${kind === "environment" ? "environment_id" : "backend_instance_id"} = ?`)
        .all(scope.tenantId, scope.principalId, id) as { id: string }[];
      const loaded = await Promise.all(records.map(record => runtimes.captureLoadedRuntime(scope, record.id)));
      return loaded.filter(Boolean).length;
    },
  });
  // Real scoped pairing persistence and administration; only connector presence is scripted.
  const hostPairings = new HostPairingRepository(database, configurationFixture.repository, {
    project: (requestScope, document) => configurationFixture.projection.project(requestScope, document),
  });
  const connectedHosts = new Set<string>();
  const hostPairingAdmin: HostPairingAdministration = {
    async list(requestScope) {
      const result = hostPairings.list(requestScope);
      return { registrations: result.registrations.map(entry => ({ ...entry, connected: connectedHosts.has(entry.connectorId) })),
        pairings: result.pairings.map(entry => ({ ...entry, connected: entry.state === "accepted" && connectedHosts.has(entry.connectorId) })) };
    },
    async accept(requestScope, request) { const result = hostPairings.accept(requestScope, request); return { ...result, configuration: await configurationAdmin.get(requestScope) }; },
    async deny(requestScope, request) { return hostPairings.deny(requestScope, request); },
    async revoke(requestScope, request) { const result = hostPairings.revoke(requestScope, request); return { ...result, configuration: await configurationAdmin.get(requestScope) }; },
    async reapprove(requestScope, request) { const result = hostPairings.reapprove(requestScope, request); return { ...result, configuration: await configurationAdmin.get(requestScope) }; },
  };
  app.post("/__e2e/host-registrations", express.json({ limit: "16kb" }), (request, response, next) => {
    try {
      const input = registerHostRequestSchema.parse(request.body);
      const registration = hostPairings.register(scope, input);
      connectedHosts.add(input.connectorId);
      response.json(registration);
    } catch (error) { next(error); }
  });
  app.post("/__e2e/host-presence", express.json({ limit: "1kb" }), (request, response, next) => {
    try {
      const input = z.strictObject({ connectorId: z.string().uuid(), connected: z.boolean() }).parse(request.body);
      if (input.connected) connectedHosts.add(input.connectorId); else connectedHosts.delete(input.connectorId);
      response.json({ connected: input.connected });
    } catch (error) { next(error); }
  });
  app.use(
    createNormalizedApp({
      usage,
      environmentVariables,
      ...{ configurationAdmin, hostPairingAdmin },
      notifications,
      questions,
      cannedPrompts: new CannedPromptService(
        new CannedPromptRepository(database),
      ),
      turnBookmarks: new ConversationTurnBookmarkService(
        new ConversationTurnBookmarkRepository(database, inventoryRepository),
        {
          handoffThreadChange: (eventScope, threadId) =>
            applicationSnapshots.handoffThreadChange(eventScope, threadId),
        },
      ),
      tasks,
      workpads,
      workspaceFiles,
      workspaceDiffReviews,
      config,
      csrfToken: createCsrfToken(),
      identity,
      agentTools: e2eAgentTools,
      drain,
      longLivedConnections,
      managedTerminalAdmissions,
      terminals: {
        service: terminalService,
        admissions: terminalAdmissions,
      },
      executionTargets: application.executionTargets,
      savedAgents,
      threadTemplates,
      applicationSnapshots,
      principalPreferences: new PrincipalApplicationPreferenceService({
        repository: new PrincipalApplicationPreferenceRepository(database),
      }),
      threads,
      history,
      threadRuntimes: runtimes,
      threadSnapshots: snapshots,
      lifecycle,
      threadForceResets,
      inventory,
      threadGroups,
      composerAttachments,
      outputArtifacts,
      threadArchives,
      threadBulkInventory,
      threadExecutionWorkspaces: directThreadExecutionWorkspaceLifecycle,
      attention,
      execution,
      automations,
      lineage: forks,
      automationPrechecks: new AutomationPrecheckExecutor(
        inventoryRepository,
        execution,
      ),
      discoverWorkspace,
      clientDirectory: path.resolve("dist/client"),
    }),
  );
  const server = app.listen(listenPort, config.host);
  const managedTerminalCarrier = attachManagedTerminalCarrier(server, {
    config,
    identity,
    admissions: managedTerminalAdmissions,
    authority: managedTerminalAuthority,
    connections: longLivedConnections,
    drain,
  });
  const terminalCarrier = attachTerminalCarrier(server, {
    config,
    identity,
    admissions: terminalAdmissions,
    service: terminalService,
    connections: longLivedConnections,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("e2e_server_tcp_address_required");
  }
  const origin = `http://${config.host}:${address.port}`;

  let closing: Promise<void> | undefined;
  const close = async () => {
    closing ??= (async () => {
      drain.beginDrain();
      await terminalCarrier.close();
      await managedTerminalCarrier.close();
      await longLivedConnections.closeAll();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await automationDispatcher.dispose();
      await authoritativeCompletionFollowUp.close();
      await completionCallbackDispatcher.close();
      await mutations.close();
      releaseViewedImageRead?.();
      await viewedImageCapture.close();
      await runtimes.close();
      await queue.close();
      await interactions.close();
      await actors.close();
      await codexManagedTui.close();
      await codexUdsManagedTui.close();
      await codexStdioManagedTui.close();
      await claudeDriverFactory.close();
      codexRpc.close();
      codexUdsRpc.close();
      codexStdioRpc.close();
      await terminalService.close();
      execution.close();
      await notifications.close();
      database.close();
    })();
    await closing;
  };
  installE2EServerProcessLifecycle(
    {
      once: (event, listener) => process.once(event, listener),
      exit: (code) => process.exit(code),
      writeError: (message) => process.stderr.write(message),
    },
    close,
  );

  try {
    await new Promise<void>((resolve, reject) => {
      process.send?.({ type: "sedes-e2e-ready", origin }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  } catch (error) {
    await close();
    throw error;
  }
  process.stdout.write(`Normalized E2E server listening on ${origin}\n`);
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
