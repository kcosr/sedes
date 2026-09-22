import Database from "better-sqlite3";
import { durableUsageAccountingMigration } from "../../src/server/db/migrations/110-durable-usage-accounting.js";
import { usageGapSessionScopeMigration } from "../../src/server/db/migrations/111-usage-gap-session-scope.js";
import { UsageService } from "../../src/server/usage/usage-service.js";
import { applicationTurnIdForBackendTurn } from "../../src/server/conversations/conversation-projector.js";
import { type UsageSink, type UsageObservation, NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { RetainedRuntimeLifecycle } from "../../src/server/backends/retained-runtime-lifecycle.js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type {
  BackendConversationEvent,
  SequencedBackendEvent,
} from "../../src/shared/protocol/backend.js";
import { serializedUtf8Bytes } from "../../src/shared/protocol/payload.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBinding,
  ConversationHandle,
} from "../../src/server/backends/contracts.js";
import { BackendError } from "../../src/server/backends/contracts.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../../src/server/backends/fork-context-boundary.js";
import {
  CODEX_C1_MAX_ITEMS_PER_TURN,
  codexThreadReadMethod,
  codexThreadResumeMethod,
  type CodexThread,
  type CodexTurn,
} from "../../src/server/backends/codex/codex-c1-protocol.js";
import {
  CodexSharedClientFacade,
  type CodexPersistentSessionAccess,
  type CodexReadyClientGeneration,
} from "../../src/server/backends/codex/codex-client-facade.js";
import {
  CodexConversationBackendDriver,
  CodexConversationOwnershipRegistry,
} from "../../src/server/backends/codex/codex-conversation-driver.js";
import {
  CodexConversationHandle,
  codexObservedExecutionSettings,
  serializeCodexSubmissionRetryAnchor,
  type CodexExecutionSettingsProvider,
  type CodexExecutionSettingsTuple,
} from "../../src/server/backends/codex/codex-conversation-handle.js";
import type { CodexForkSettingsEligibility } from "../../src/server/backends/codex/codex-fork-settings-eligibility.js";
import {
  codexClientUserMessageId,
  codexForkContextBoundaryHookRunId,
  codexForkCreationMarker,
  codexSubmissionReconciliationClientUserMessageIds,
} from "../../src/server/backends/codex/codex-submission-correlation.js";
import { codexBackendTurnId } from "../../src/server/backends/codex/codex-history-projector.js";
import { CodexBackendDriverFactory } from "../../src/server/backends/codex/codex-driver-factory.js";
import {
  compileBackendModelPolicy,
  type BackendModelPolicy,
  type CompiledBackendModelPolicy,
} from "../../src/server/backends/model-policy.js";
import { CodexServerRequestRouter } from "../../src/server/backends/codex/codex-server-request-router.js";
import { CodexGoalSessionRegistry } from "../../src/server/backends/codex/codex-goal-session.js";
import { CodexFastModeSessionRegistry } from "../../src/server/backends/codex/codex-fast-mode-session.js";
import { CodexManagedTuiController } from "../../src/server/backends/codex/codex-managed-tui-controller.js";
import {
  codexSkillId,
  type CodexComposerSkillPreferenceReader,
} from "../../src/server/backends/codex/codex-skills.js";
import { inspectCodexContextExcerptCarrier } from "../../src/server/backends/codex/codex-context-excerpts.js";
import { inspectStagedAttachmentManifest } from "../../src/server/backends/staged-attachment-manifest.js";
import {
  parseCodexBindingDetail,
  serializeCodexBindingDetail,
} from "../../src/server/backends/codex/codex-binding-codec.js";
import type {
  CodexInboundServerRequest,
  CodexRpcMethod,
  CodexRpcRequestOptions,
  CodexRpcRequestReceipt,
  CodexRpcUndecodableNotification,
} from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import { CODEX_RPC_UNDECODABLE_NOTIFICATION_CODE } from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import {
  CodexRpcDeliveryError,
  CodexRpcProtocolError,
  CodexRpcRemoteError,
} from "../../src/server/backends/codex/rpc/errors.js";
import { ConversationProjector } from "../../src/server/conversations/conversation-projector.js";
import type { OutputArtifactPublisher } from "../../src/server/output-artifacts/contracts.js";
import { renderTaskContextsForModel } from "../../src/server/conversations/delivery-input-projection.js";
import {
  unavailableCodexAgentToolCliEnvironmentProvider,
  type CodexAgentToolCliEnvironmentProvider,
} from "../../src/server/backends/codex/codex-agent-tool-cli-environment.js";
import {
  CodexAppServerBindingError,
  decodeCodexServerNotificationParams,
  decodeCodexServerRequestParams,
  type CodexServerRequestMethod,
} from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const instance: AgentBackendInstance = {
  id: "codex-1",
  tenantId: scope.tenantId,
  kind: "codex_app_server",
  label: "Codex",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: "0.153.0",
};
const toolProvenanceKey = new Uint8Array(32).fill(0x43);
const agentToolSourceCapability =
  "m3-test-capability-7Qx2P9vK4nR8sT6wY1aD5fH0jL3cB";
const scrubbedAgentToolShellEnvironmentPolicy = {
  exclude: [
    "SEDES_AGENT_TOOL_ENDPOINT",
    "SEDES_AGENT_TOOL_SOURCE_CAPABILITY",
    "SEDES_AGENT_TOOL_CLIENT_TOKEN",
    "SEDES_AGENT_TOOL_CLI_MODE",
  ],
};
const catalogModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "model_effort",
);
const taskContext = {
  id: "84f9a3b0-9c14-456d-b08d-58d325d869d0",
  scope: { kind: "global" as const },
  title: "Add prompt from tasks should include ID",
  details: "Preserve exact task identity.",
  pinned: false,
  files: ["/workspace/src/client/components/tasks/TasksPanel.tsx"],
  completedAt: null,
  revision: 7,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T13:00:00.000Z",
};
const stagedAttachment = {
  id: "a66788c8-d80d-49f5-846d-e18dc8e925a4",
  kind: "file" as const,
  fileName: "task-notes.txt",
  mediaType: "application/octet-stream" as const,
  byteSize: 128,
  sha256: "a".repeat(64),
  agentPath: "/workspace/.sedes-attachments/task-notes.txt",
};
const generatedPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const changedGeneratedPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const connection = connectionProfile("profile-1", "template-1");
const workspace = {
  authorityRevision: 1,
  summary: {
    id: "workspace-1",
    environmentId: "environment-1",
    displayName: "Workspace",
    displayPath: "/workspace",
    availability: "available" as const,
    trustState: "trusted" as const,
    revision: 1,
  },
  canonicalPath: "/workspace",
};

function connectionProfile(
  id: string,
  templateId: string,
): AgentConnectionProfile {
  return {
    id,
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    templateId,
    kind: "codex_app_server",
    backendInstanceId: instance.id,
    executionEnvironmentId: "environment-1",
    label: id,
    enabled: true,
    configurationRevision: 1,
  };
}

function nativeTurn(index: number) {
  return {
    id: `turn-${index}`,
    items: [
      {
        type: "userMessage" as const,
        id: `item-${index}`,
        clientId: null,
        content: [
          {
            type: "text" as const,
            text: `message ${index}`,
            text_elements: [],
          },
        ],
      },
    ],
    itemsView: "full" as const,
    status: "completed" as const,
    error: null,
    startedAt: 1_700_000_000 + index,
    completedAt: 1_700_000_001 + index,
    durationMs: 1_000,
  };
}

function nativeCommandTurn(index: number) {
  return {
    ...nativeTurn(index),
    items: [
      ...nativeTurn(index).items,
      {
        type: "commandExecution" as const,
        id: `command-${index}`,
        pluginId: null,
        scriptPath: null,
        command: "npm test",
        cwd: "/workspace",
        processId: "4242",
        source: "agent" as const,
        status: "completed" as const,
        commandActions: [],
        aggregatedOutput: "all tests passed",
        exitCode: 0,
        durationMs: 250,
      },
    ],
  };
}

function nativeGeneratedImage(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    type: "imageGeneration" as const,
    id: "generated-image-1",
    status: "completed" as const,
    revisedPrompt: "A tiny blue square",
    result: generatedPngBase64,
    transparentBackground: false,
    failure: null,
    savedPath: "/provider/private/generated.png",
    ...overrides,
  };
}

function nativeThread(
  overrides: Readonly<Record<string, unknown>> = {},
): CodexThread {
  return codexThreadReadMethod.decodeResult({
    thread: {
      id: "thread-1",
      extra: {},
      sessionId: "session-1",
      forkedFromId: null,
      parentThreadId: null,
      preview: "A thread",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "legacy",
      modelProvider: "openai",
      model: null,
      reasoningEffort: null,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      recencyAt: 1_700_000_100,
      status: { type: "idle" },
      path: "/private/rollout.jsonl",
      cwd: "/workspace",
      cliVersion: "0.153.0",
      source: "appServer",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: "Fixture",
      turns: [nativeTurn(0)],
      ...overrides,
    },
  }).thread;
}

function legacySubmissionRetryAnchor(thread: CodexThread): string {
  const current = serializeCodexSubmissionRetryAnchor(thread);
  const prefix = "codex-retry-anchor:";
  const anchor = JSON.parse(
    Buffer.from(current.slice(prefix.length), "base64url").toString("utf8"),
  ) as { terminalIdentityDigest: string };
  const terminal = thread.turns.at(-1);
  const hash = createHash("sha256").update(
    "harness.codex-terminal-identity.v1\0",
  );
  if (!terminal) {
    anchor.terminalIdentityDigest = hash.update("empty").digest("base64url");
  } else {
    hash
      .update(terminal.id)
      .update("\0")
      .update(terminal.status)
      .update("\0")
      .update(terminal.error?.message ?? "");
    for (const item of terminal.items) {
      hash
        .update("\0")
        .update(item.type)
        .update("\0")
        .update(item.id)
        .update("\0");
      if ("status" in item && typeof item.status === "string") {
        hash.update(item.status);
      }
    }
    anchor.terminalIdentityDigest = hash.digest("base64url");
  }
  return `${prefix}${Buffer.from(JSON.stringify(anchor), "utf8").toString("base64url")}`;
}

function overLimitNativeThread(): CodexThread {
  return nativeThread({
    turns: Array.from({ length: 1_001 }, (_, turnIndex) => ({
      ...nativeTurn(turnIndex),
      items: Array.from({ length: 11 }, (_, itemIndex) => ({
        ...nativeTurn(turnIndex).items[0],
        id: `item-${turnIndex}-${itemIndex}`,
        content: [
          {
            type: "text" as const,
            text: `${turnIndex}:${itemIndex}:${"x".repeat(1_400)}`,
            text_elements: [],
          },
        ],
      })),
    })),
  });
}

function resumeResult(thread = nativeThread()) {
  return {
    thread,
    model: "gpt-5.6",
    modelProvider: "openai",
    serviceTier: "default",
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd],
    instructionSources: [],
    approvalPolicy: "never" as const,
    approvalsReviewer: "user" as const,
    sandbox: { type: "readOnly" as const, networkAccess: false },
    activePermissionProfile: {
      id: ":read-only",
      extends: null,
    },
    reasoningEffort: "low",
    multiAgentMode: "explicitRequestOnly" as const,
    initialTurnsPage: null,
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

function paginatedThread(
  overrides: Readonly<Record<string, unknown>> = {},
): CodexThread {
  return nativeThread({ historyMode: "paginated", turns: [], ...overrides });
}

function notLoadedTurn(index: number) {
  return { ...nativeTurn(index), items: [], itemsView: "notLoaded" as const };
}

function paginatedResumeResult(input: {
  readonly shells: readonly CodexTurn[];
  readonly nextCursor?: string | null;
  readonly thread?: CodexThread;
  readonly itemsBackwardsCursor?: string | null;
}) {
  const thread = input.thread ?? paginatedThread();
  const hasDurableHistory = input.shells.some(
    ({ status }) => status !== "inProgress",
  );
  const backwardsCursor = hasDurableHistory ? "turns-head" : null;
  return {
    ...resumeResult(thread),
    thread,
    initialTurnsPage: {
      data: input.shells,
      nextCursor: input.nextCursor ?? null,
      backwardsCursor,
    },
    turnsBackwardsCursor: backwardsCursor,
    itemsBackwardsCursor:
      input.itemsBackwardsCursor === undefined
        ? hasDurableHistory
          ? "item-head"
          : null
        : input.itemsBackwardsCursor,
  };
}

function paginatedItems(index: number) {
  return {
    data: nativeTurn(index).items.map((item) => ({
      turnId: `turn-${index}`,
      item,
    })),
    nextCursor: null,
    backwardsCursor: "item-head",
  };
}

function hiddenBoundaryTurn(index: number): CodexTurn {
  return {
    ...notLoadedTurn(index),
    id: `hidden-boundary-${index}`,
  };
}

function hiddenBoundaryItems(index: number) {
  return {
    data: [
      {
        turnId: `hidden-boundary-${index}`,
        item: {
          type: "hookPrompt" as const,
          id: `hidden-boundary-item-${index}`,
          fragments: [
            {
              text: USER_FORK_CONTEXT_BOUNDARY.content,
              hookRunId: codexForkContextBoundaryHookRunId({
                toolProvenanceKey,
                tenantId: scope.tenantId,
                principalId: scope.principalId,
                backendInstanceId: instance.id,
                nativeThreadId: "thread-1",
                correlationAncestorThreadIds: [],
                applicationOperationId: `hidden-boundary-${index}`,
              }),
            },
          ],
        },
      },
    ],
    nextCursor: null,
    backwardsCursor: "item-head",
  };
}

function enqueueCompleteLegacyRead(
  harness: RpcHarness,
  thread: CodexThread,
): void {
  harness.enqueue(
    "thread/read",
    { thread: { ...thread, turns: [] } },
    { thread },
  );
}

function threadStartResult(thread = paginatedThread()) {
  const {
    initialTurnsPage: _initialTurnsPage,
    turnsBackwardsCursor: _turnsBackwardsCursor,
    itemsBackwardsCursor: _itemsBackwardsCursor,
    ...result
  } = resumeResult(thread);
  return result;
}

function attestedServerRequest<Method extends CodexServerRequestMethod>(
  request: Omit<CodexInboundServerRequest<Method>, "params"> & {
    readonly params: unknown;
  },
): CodexInboundServerRequest<Method> {
  return {
    ...request,
    params: decodeCodexServerRequestParams(request.method, request.params),
  };
}

function nativeModel(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "gpt-5.6",
    model: "gpt-5.6",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "GPT-5.6",
    description: "General-purpose model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "high", description: "Thorough" },
    ],
    defaultReasoningEffort: "low",
    inputModalities: ["text"],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
    ...overrides,
  };
}

function binding(
  profile = connection,
  threadId = "thread-1",
): ConversationBinding {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId: `application-${profile.id}`,
    backendConversationId: threadId,
    backendInstanceId: instance.id,
    connectionProfileId: profile.id,
    executionEnvironmentId: profile.executionEnvironmentId,
    createdAt: "2026-07-31T00:00:00.000Z",
  };
}

type QueuedResponse =
  | unknown
  | ((params: unknown, harness: RpcHarness) => unknown | Promise<unknown>);

class RpcHarness {
  generation = 1;
  sequence = 0;
  readonly calls: { method: string; params: unknown }[] = [];
  readonly requestOptions: {
    method: string;
    options: CodexRpcRequestOptions;
  }[] = [];
  readonly queues = new Map<string, QueuedResponse[]>();
  readonly afterReceipt = new Map<
    string,
    ((receiptSequence: number) => void)[]
  >();
  readonly retirements: number[] = [];
  readonly facade: CodexSharedClientFacade;
  readonly serverRequests = new CodexServerRequestRouter();
  readonly readyClient: CodexReadyClientGeneration;

  constructor(persistentSessions?: CodexPersistentSessionAccess, residency?: RetainedRuntimeLifecycle) {
    const harness = this;
    this.readyClient = {
      get generation() {
        return harness.generation;
      },
      async request<Params, Result>(
        specification: CodexRpcMethod<Params, Result>,
        params: Params,
        options: CodexRpcRequestOptions,
      ): Promise<Result> {
        harness.requestOptions.push({ method: specification.method, options });
        const generation = harness.generation;
        return await harness.execute(specification, params, generation);
      },
      async requestWithReceipt<Params, Result>(
        specification: CodexRpcMethod<Params, Result>,
        params: Params,
        options: CodexRpcRequestOptions,
      ): Promise<CodexRpcRequestReceipt<Result>> {
        harness.requestOptions.push({ method: specification.method, options });
        const generation = harness.generation;
        const result = await harness.execute(specification, params, generation);
        const inboundSequence = ++harness.sequence;
        harness.afterReceipt.get(specification.method)?.shift()?.(
          inboundSequence,
        );
        return { result, generation, inboundSequence };
      },
    };
    this.facade = new CodexSharedClientFacade({
      ...(residency ? { residency } : {}),
      ...(persistentSessions ? { persistentSessions } : {}),
      current: () => this.readyClient,
      latestGeneration: () => this.generation,
      retireGeneration: async (generation) => {
        this.retirements.push(generation);
        if (generation === this.generation) {
          this.lifecycle("unavailable", generation);
        }
      },
    });
    this.facade.updateLifecycle({
      state: "ready",
      generation: this.generation,
    });
    this.serverRequests.activateGeneration(this.generation);
  }

  enqueue(method: string, ...responses: QueuedResponse[]): void {
    const queue = this.queues.get(method) ?? [];
    queue.push(...responses);
    this.queues.set(method, queue);
  }

  after(method: string, callback: (receiptSequence: number) => void): void {
    const queue = this.afterReceipt.get(method) ?? [];
    queue.push(callback);
    this.afterReceipt.set(method, queue);
  }

  lifecycle(
    state:
      | "unavailable"
      | "starting"
      | "reconciling"
      | "ready"
      | "circuit_open"
      | "closing"
      | "closed",
    generation = this.generation,
  ): void {
    const previousGeneration = this.generation;
    if (state === "ready" && generation > previousGeneration) {
      this.serverRequests.activateGeneration(generation);
    } else if (
      state === "unavailable" ||
      state === "circuit_open" ||
      state === "closing" ||
      state === "closed"
    ) {
      this.serverRequests.invalidateGeneration(
        previousGeneration,
        "fake_codex_generation_unavailable",
      );
    }
    this.generation = generation;
    this.facade.updateLifecycle({ state, generation });
  }

  notify(
    method:
      | "thread/tokenUsage/updated"
      | "thread/status/changed"
      | "thread/settings/updated"
      | "warning"
      | "modelProvider/authRecoveryStarted"
      | "modelProvider/authRecoveryCompleted"
      | "thread/goal/cleared"
      | "thread/goal/updated"
      | "skills/changed"
      | "mcpServer/startupStatus/updated"
      | "thread/started"
      | "turn/started"
      | "turn/completed"
      | "turn/diff/updated"
      | "turn/plan/updated"
      | "item/started"
      | "item/completed"
      | "item/agentMessage/delta"
      | "item/plan/delta"
      | "item/commandExecution/outputDelta"
      | "item/fileChange/outputDelta"
      | "item/fileChange/patchUpdated"
      | "item/mcpToolCall/progress"
      | "item/reasoning/summaryPartAdded"
      | "item/reasoning/summaryTextDelta"
      | "item/reasoning/textDelta"
      | "error"
      | "serverRequest/resolved",
    params: unknown,
    sequence = ++this.sequence,
    attest = true,
  ): void {
    let attestedParams = params;
    try {
      if (!attest) throw new Error("test_fixture_unattested");
      attestedParams = decodeCodexServerNotificationParams(method, params);
    } catch {
      // Deliberately malformed fixtures still reach the semantic consumer so
      // tests can prove missing structural attestation fails closed.
    }
    this.facade.forwardNotification(this.generation, {
      kind: "decoded_notification",
      generation: this.generation,
      sequence,
      method,
      params: attestedParams,
    });
  }

  notifyUndecodable(
    method: CodexRpcUndecodableNotification["method"],
    nativeThreadId: string,
    sequence = ++this.sequence,
  ): void {
    this.facade.forwardNotification(this.generation, {
      kind: "undecodable_notification",
      generation: this.generation,
      sequence,
      method,
      nativeThreadId,
      code: CODEX_RPC_UNDECODABLE_NOTIFICATION_CODE,
    });
  }

  async execute<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    generation: number,
  ): Promise<Result> {
    if (generation !== this.generation) {
      throw new CodexRpcDeliveryError({
        code: "codex_generation_closed",
        delivery: "sent_outcome_unknown",
        generation,
        method: specification.method,
      });
    }
    const encoded = specification.encodeParams(params);
    this.calls.push({ method: specification.method, params: encoded });
    const queued = this.queues.get(specification.method)?.shift();
    if (queued instanceof Error) throw queued;
    if (queued === undefined && specification.method === "model/list") {
      return specification.decodeResult({
        data: [nativeModel()],
        nextCursor: null,
      });
    }
    if (queued === undefined && specification.method === "skills/list") {
      return specification.decodeResult({
        data: [{ cwd: "/workspace", skills: [], errors: [] }],
      });
    }
    if (queued === undefined) {
      throw new Error(`missing_fake_response:${specification.method}`);
    }
    const raw =
      typeof queued === "function" ? await queued(encoded, this) : queued;
    return specification.decodeResult(raw);
  }
}

function executionSettingsProvider(
  overrides: Partial<CodexExecutionSettingsProvider> = {},
): CodexExecutionSettingsProvider {
  const desiredSettings =
    overrides.desiredSettings ?? (() => executionSettingsTuple());
  const resolveFastModeDisabled =
    overrides.resolveFastModeDisabled ??
    ((providerScope, input) => {
      const desired = desiredSettings(providerScope, input.applicationThreadId);
      return desired?.serviceTier === "fast"
        ? { ...desired, serviceTier: "standard" }
        : desired;
    });
  return {
    forkSettingsEligibility: () => ({
      availability: "available",
      settingsRevision: 1,
      settings: executionSettingsTuple(),
    }),
    freezeOperationSnapshot: () => ({
      settings: executionSettingsTuple(),
    }),
    observeEffective: () => undefined,
    markEffectiveUnknown: () => undefined,
    ...overrides,
    desiredSettings,
    resolveFastModeDisabled,
  };
}

function executionSettingsTuple(
  overrides: Partial<CodexExecutionSettingsTuple> = {},
): CodexExecutionSettingsTuple {
  return {
    model: "gpt-5.6",
    reasoningEffort: "low",
    serviceTier: "standard",
    sandboxMode: "read-only",
    networkAccess: "disabled",
    approvalPolicy: "never",
    approvalReviewer: "user",
    ...overrides,
  };
}

function driver(
  harness: RpcHarness,
  profile = connection,
  ownership = new CodexConversationOwnershipRegistry(),
  modelPolicy:
    BackendModelPolicy | CompiledBackendModelPolicy = catalogModelPolicy,
  settingsProvider = executionSettingsProvider(),
  goalSessions?: CodexGoalSessionRegistry,
  managedTui?: CodexManagedTuiController,
  agentToolCliEnvironment: CodexAgentToolCliEnvironmentProvider = unavailableCodexAgentToolCliEnvironmentProvider,
  fastModeSessions = new CodexFastModeSessionRegistry(),
  composerSkillPreferences?: CodexComposerSkillPreferenceReader,
  onError?: (error: unknown) => void,
  outputArtifacts = createInMemoryOutputArtifactPublisher(),
  usageSink: UsageSink = NO_USAGE_SINK,
) {
  return new CodexConversationBackendDriver({
    usageSink,
    nativeNamespace: "test-codex-store",
    instance,
    connection: profile,
    client: harness.facade,
    serverRequests: harness.serverRequests,
    ownership,
    toolProvenanceKey,
    modelPolicy:
      "isSelectionAllowed" in modelPolicy
        ? modelPolicy
        : compileBackendModelPolicy(modelPolicy, "model_effort"),
    executionSettings: settingsProvider,
    outputArtifacts,
    fastModeSessions,
    agentToolCliEnvironment,
    ...(composerSkillPreferences ? { composerSkillPreferences } : {}),
    ...(goalSessions ? { goalSessions } : {}),
    ...(managedTui ? { managedTui } : {}),
    ...(onError ? { onError } : {}),
    now: () => "2026-07-31T00:00:00.000Z",
  });
}

function driverWithOutputArtifacts(
  harness: RpcHarness,
  outputArtifacts: OutputArtifactPublisher,
) {
  return driver(
    harness,
    connection,
    new CodexConversationOwnershipRegistry(),
    catalogModelPolicy,
    executionSettingsProvider(),
    undefined,
    undefined,
    unavailableCodexAgentToolCliEnvironmentProvider,
    new CodexFastModeSessionRegistry(),
    undefined,
    undefined,
    outputArtifacts,
  );
}

function driverWithComposerSkillPreferences(
  harness: RpcHarness,
  composerSkillPreferences: CodexComposerSkillPreferenceReader,
) {
  return driver(
    harness,
    connection,
    new CodexConversationOwnershipRegistry(),
    { type: "catalog" },
    executionSettingsProvider(),
    undefined,
    undefined,
    unavailableCodexAgentToolCliEnvironmentProvider,
    new CodexFastModeSessionRegistry(),
    composerSkillPreferences,
  );
}

function availableAgentToolCliEnvironment(): CodexAgentToolCliEnvironmentProvider {
  return {
    acquire: async (_scope, _applicationThreadId) => ({
      availability: "available",
      endpoint: "http://127.0.0.1:4784",
      executableDirectory: "/opt/sedes/bin",
      inheritedPath: "/usr/bin",
      sourceCapability: agentToolSourceCapability,
      mode: "progressive",
      closed: new Promise(() => undefined),
      release: () => undefined,
    }),
  };
}

function attachInput(profile = connection, threadId = "thread-1") {
  return {
    scope,
    binding: binding(profile, threadId),
    workspace,
    opaqueBindingDetail: serializeCodexBindingDetail({
      threadId,
      sessionId: null,
      nativeAncestry: null,
      correlationAncestorThreadIds: [],
    }),
  };
}

function expectBackendError(
  error: unknown,
  category: BackendError["category"],
  backendCode: string,
): void {
  expect(error).toBeInstanceOf(BackendError);
  expect(error).toMatchObject({ category, backendCode });
}

async function attachIdle(
  harness: RpcHarness,
  target = driver(harness),
): Promise<CodexConversationHandle> {
  return (await target.attach(
    attachInput(target.connection),
  )) as CodexConversationHandle;
}

async function establish(
  harness: RpcHarness,
  handle: ConversationHandle,
  thread = nativeThread(),
) {
  harness.enqueue("thread/read", {
    thread: nativeThread({
      id: thread.id,
      cwd: thread.cwd,
      ephemeral: thread.ephemeral,
      parentThreadId: thread.parentThreadId,
      source: thread.source,
      turns: [],
    }),
  });
  harness.enqueue("thread/resume", resumeResult(thread));
  return await handle.establishProjection({
    signal: new AbortController().signal,
  });
}

describe("CodexConversationBackendDriver", () => {
  it("gracefully interrupts only the cached active turn during owned runtime Stop without rereading inventory", async () => {
    const harness = new RpcHarness();
    const ownership = new CodexConversationOwnershipRegistry();
    const handle = await attachIdle(harness, driver(harness, connection, ownership));
    await establish(harness, handle, nativeThread({ status: { type: "active", activeFlags: [] }, turns: [{ ...nativeTurn(1), status: "inProgress", completedAt: null }] }));
    harness.calls.length = 0;
    harness.enqueue("turn/interrupt", {});
    await ownership.interruptOwnedActiveTurns();
    expect(harness.calls).toEqual([{ method: "turn/interrupt", params: { threadId: "thread-1", turnId: nativeTurn(1).id } }]);
    expect(harness.requestOptions.at(-1)).toMatchObject({ method: "turn/interrupt", options: { timeoutMilliseconds: 1_000 } });
    harness.lifecycle("closed", harness.generation);
    await handle.close();
  });

  it.each(["idle", "stale_generation"] as const)("does not interrupt %s cached work during owned runtime Stop", async state => {
    const harness = new RpcHarness();
    const ownership = new CodexConversationOwnershipRegistry();
    const handle = await attachIdle(harness, driver(harness, connection, ownership));
    await establish(harness, handle, state === "idle" ? nativeThread() : nativeThread({ status: { type: "active", activeFlags: [] }, turns: [{ ...nativeTurn(1), status: "inProgress", completedAt: null }] }));
    if (state === "stale_generation") harness.lifecycle("ready", harness.generation + 1);
    harness.calls.length = 0;
    await ownership.interruptOwnedActiveTurns();
    expect(harness.calls).toEqual([]);
    harness.lifecycle("closed", harness.generation);
    await handle.close();
  });

  it("validates consumed thread fields while ignoring additive response metadata", () => {
    const actualShape = resumeResult();
    expect(codexThreadResumeMethod.decodeResult(actualShape)).toMatchObject({
      thread: {
        extra: {},
        historyMode: "legacy",
        canAcceptDirectInput: true,
      },
      runtimeWorkspaceRoots: ["/workspace"],
      activePermissionProfile: { id: ":read-only", extends: null },
      multiAgentMode: "explicitRequestOnly",
    });
    expect(
      codexThreadResumeMethod.decodeResult({
        ...actualShape,
        futureResponseMetadata: true,
        thread: {
          ...actualShape.thread,
          futureThreadMetadata: { revision: 2 },
        },
      }),
    ).toEqual(actualShape);
    expect(
      codexThreadResumeMethod.decodeResult({
        ...actualShape,
        thread: { ...actualShape.thread, historyMode: "paginated" },
      }).thread.historyMode,
    ).toBe("paginated");
  });

  it("accepts nullable image detail from the Codex 0.147 thread history contract", () => {
    const actualShape = resumeResult();
    const decoded = codexThreadResumeMethod.decodeResult({
      ...actualShape,
      thread: {
        ...actualShape.thread,
        turns: [
          {
            ...nativeTurn(0),
            items: [
              {
                ...nativeTurn(0).items[0],
                content: [
                  {
                    type: "image",
                    detail: null,
                    url: "https://example.invalid/image.png",
                  },
                  {
                    type: "localImage",
                    detail: null,
                    path: "/workspace/image.png",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(decoded.thread.turns[0]?.items[0]).toMatchObject({
      type: "userMessage",
      content: [
        { type: "image", detail: null },
        { type: "localImage", detail: null },
      ],
    });
  });

  it("reads a bounded visible model catalog from stable model/list pagination", async () => {
    const harness = new RpcHarness();
    harness.enqueue("model/list", {
      data: [
        nativeModel({ futureModelMetadata: { family: "codex" } }),
        nativeModel({
          id: "hidden-model",
          model: "hidden-model",
          displayName: "Hidden",
          hidden: true,
          isDefault: false,
        }),
      ],
      nextCursor: "models-page-2",
      futureResponseMetadata: { revision: 2 },
    });
    harness.enqueue("model/list", {
      data: [
        nativeModel({
          id: "gpt-5.6-codex",
          model: "gpt-5.6-codex",
          displayName: "C".repeat(5_000),
          isDefault: false,
        }),
      ],
      nextCursor: null,
    });

    const catalog = await driver(harness).catalog({ scope, workspace });

    expect(catalog.commands).toEqual([]);
    expect(catalog.notices).toEqual([]);
    expect(catalog.models).toEqual([
      {
        provider: connection.id,
        id: "gpt-5.6",
        label: "GPT-5.6",
        isDefault: true,
        inputModalities: ["text"],
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      },
      {
        provider: connection.id,
        id: "gpt-5.6-codex",
        label: expect.stringMatching(/^C+…$/u),
        inputModalities: ["text"],
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      },
    ]);
    expect(
      Buffer.byteLength(catalog.models[1]!.label, "utf8"),
    ).toBeLessThanOrEqual(4_096);
    expect(harness.calls).toEqual([
      {
        method: "model/list",
        params: {
          limit: 1_000,
          includeHidden: false,
        },
      },
      {
        method: "model/list",
        params: {
          cursor: "models-page-2",
          limit: 998,
          includeHidden: false,
        },
      },
      {
        method: "skills/list",
        params: { cwds: ["/workspace"] },
      },
    ]);
  });

  it("accepts an absolute Windows workspace path", async () => {
    const harness = new RpcHarness();
    harness.enqueue("model/list", {
      data: [nativeModel()],
      nextCursor: null,
    });

    await expect(
      driver(harness).catalog({
        scope,
        workspace: {
          ...workspace,
          summary: {
            ...workspace.summary,
            displayPath: "C:\\",
          },
          canonicalPath: "C:\\",
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ models: expect.any(Array) }));
  });

  it("normalizes only Fast from the Codex 0.153 service-tier catalog", async () => {
    const harness = new RpcHarness();
    harness.enqueue("model/list", {
      data: [
        nativeModel({
          serviceTiers: [
            {
              id: "priority",
              name: "Fast",
              description: " Faster responses with higher usage. ",
            },
            {
              id: "ultrafast",
              name: "Ultrafast",
              description: "The fastest available responses.",
            },
          ],
          defaultServiceTier: "priority",
        }),
      ],
      nextCursor: null,
    });

    const catalog = await driver(harness).catalog({ scope, workspace });

    expect(catalog.models).toEqual([
      {
        provider: connection.id,
        id: "gpt-5.6",
        label: "GPT-5.6",
        isDefault: true,
        inputModalities: ["text"],
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
        fastMode: {
          supported: true,
          defaultSelection: "fast",
          description: "Faster responses with higher usage.",
        },
      },
    ]);
  });

  it("rejects duplicate and unknown catalog service tiers", async () => {
    const invalidModels = [
      {
        serviceTiers: [
          { id: "priority", name: "Fast", description: "Fast" },
          { id: "priority", name: "Fast again", description: "Fast" },
        ],
        defaultServiceTier: "priority",
        backendCode: "codex_model_catalog_service_tier_duplicate",
      },
      {
        serviceTiers: [{ id: "flex", name: "Flex", description: "Flexible" }],
        defaultServiceTier: "flex",
        backendCode: "codex_model_catalog_service_tier_unknown",
      },
    ] as const;

    for (const invalid of invalidModels) {
      const harness = new RpcHarness();
      harness.enqueue("model/list", {
        data: [
          nativeModel({
            serviceTiers: invalid.serviceTiers,
            defaultServiceTier: invalid.defaultServiceTier,
          }),
        ],
        nextCursor: null,
      });
      await expect(
        driver(harness).catalog({ scope, workspace }),
      ).rejects.toMatchObject({
        category: "incompatible_protocol",
        backendCode: invalid.backendCode,
      });
    }
  });

  it("treats an unrecognized catalog default as Standard", async () => {
    const harness = new RpcHarness();
    harness.enqueue("model/list", {
      data: [
        nativeModel({
          serviceTiers: [{ id: "priority", name: "Fast", description: "Fast" }],
          defaultServiceTier: "future-default",
        }),
      ],
      nextCursor: null,
    });

    await expect(
      driver(harness).catalog({ scope, workspace }),
    ).resolves.toMatchObject({
      models: [
        expect.objectContaining({
          fastMode: expect.objectContaining({
            supported: true,
            defaultSelection: "standard",
          }),
        }),
      ],
    });
  });

  it("normalizes enabled non-system workspace skills without exposing native metadata and refreshes on invalidation", async () => {
    const harness = new RpcHarness();
    harness.enqueue("skills/list", {
      data: [
        {
          cwd: "/workspace",
          skills: [
            {
              name: "review",
              description: "Review the current changes",
              shortDescription: "Review changes",
              interface: { displayName: "Review Changes" },
              path: "/private/codex/skills/review/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "repository-review",
              description: "Review this repository",
              path: "/workspace/.agents/skills/repository-review/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            {
              name: "admin-policy",
              description: "Apply the administrator policy",
              path: "/etc/codex/skills/admin-policy/SKILL.md",
              scope: "admin",
              enabled: true,
            },
            {
              name: "openai-templates:pitch-deck",
              description: "Create an OpenAI template",
              path: "/private/plugins/openai-templates/pitch-deck/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "sites:sites-building",
              description: "Build a site",
              path: "/private/plugins/sites/sites-building/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "visualize:visualize",
              description: "Create a visualization",
              path: "/private/plugins/visualize/visualize/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "acme:review",
              description: "Review with a third-party plugin",
              path: "/private/plugins/acme/review/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "skill-creator",
              description: "Create Codex skills",
              path: "/private/codex/skills/.system/skill-creator/SKILL.md",
              scope: "system",
              enabled: true,
            },
            {
              name: "disabled-user-skill",
              description: "A disabled user skill",
              path: "/private/codex/skills/disabled/SKILL.md",
              scope: "user",
              enabled: false,
            },
          ],
          errors: [],
        },
      ],
    });
    const target = driver(harness);

    const first = await target.catalog({ scope, workspace });
    expect(first.skills).toEqual([
      {
        id: expect.stringMatching(/^codex_skill_/u),
        name: "review",
        displayName: "Review Changes",
        reference: "$review",
        description: "Review changes",
      },
      {
        id: expect.stringMatching(/^codex_skill_/u),
        name: "repository-review",
        reference: "$repository-review",
        description: "Review this repository",
      },
      {
        id: expect.stringMatching(/^codex_skill_/u),
        name: "admin-policy",
        reference: "$admin-policy",
        description: "Apply the administrator policy",
      },
      {
        id: expect.stringMatching(/^codex_skill_/u),
        name: "acme:review",
        reference: "$acme:review",
        description: "Review with a third-party plugin",
      },
    ]);
    expect(JSON.stringify(first)).not.toContain("/private/");
    expect(JSON.stringify(first)).not.toContain("/etc/codex/");
    expect(JSON.stringify(first)).not.toContain('"scope"');

    harness.enqueue("model/list", {
      data: [nativeModel()],
      nextCursor: null,
    });
    harness.enqueue("skills/list", {
      data: [
        {
          cwd: "/workspace",
          skills: [],
          errors: [],
        },
      ],
    });
    harness.notify("skills/changed", {});
    const refreshed = await target.catalog({ scope, workspace });
    expect(refreshed.skills).toEqual([]);
    expect(
      harness.calls.filter(({ method }) => method === "skills/list"),
    ).toHaveLength(2);
  });

  it("invalidates the catalog cache when the principal enables OpenAI composer skills", async () => {
    const harness = new RpcHarness();
    let preferences = {
      showOpenAIComposerSkills: false,
      revision: 0,
    };
    const preferenceReader = { read: () => preferences };
    const nativeSkills = [
      {
        name: "review",
        description: "Review changes",
        path: "/private/codex/skills/review/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "openai-templates:pitch-deck",
        description: "Create an OpenAI template",
        path: "/private/plugins/openai-templates/pitch-deck/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "sites:sites-building",
        description: "Build a site",
        path: "/private/plugins/sites/sites-building/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "visualize:visualize",
        description: "Create a visualization",
        path: "/private/plugins/visualize/visualize/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ];
    harness.enqueue("skills/list", {
      data: [{ cwd: "/workspace", skills: nativeSkills, errors: [] }],
    });
    const target = driverWithComposerSkillPreferences(
      harness,
      preferenceReader,
    );

    const hidden = await target.catalog({ scope, workspace });
    expect(hidden.skills.map(({ name }) => name)).toEqual(["review"]);

    preferences = { showOpenAIComposerSkills: true, revision: 1 };
    harness.enqueue("model/list", { data: [nativeModel()], nextCursor: null });
    harness.enqueue("skills/list", {
      data: [{ cwd: "/workspace", skills: nativeSkills, errors: [] }],
    });
    const shown = await target.catalog({ scope, workspace });
    expect(shown.skills.map(({ name }) => name)).toEqual([
      "review",
      "openai-templates:pitch-deck",
      "sites:sites-building",
      "visualize:visualize",
    ]);
    expect(
      harness.calls.filter(({ method }) => method === "skills/list"),
    ).toHaveLength(2);
  });

  it("keeps models available and retries when Codex skill discovery fails", async () => {
    const harness = new RpcHarness();
    harness.enqueue(
      "skills/list",
      new Error("skills temporarily unavailable"),
      {
        data: [
          {
            cwd: "/workspace",
            skills: [
              {
                name: "review",
                description: "Review the current changes",
                shortDescription: "Review changes",
                interface: { displayName: "Review Changes" },
                path: "/private/codex/skills/review/SKILL.md",
                scope: "user",
                enabled: true,
              },
            ],
            errors: [],
          },
        ],
      },
    );
    const target = driver(harness);

    const catalog = await target.catalog({ scope, workspace });

    expect(catalog.models).toHaveLength(1);
    expect(catalog.skills).toEqual([]);
    expect(catalog.notices).toEqual([
      { text: "Codex skills are temporarily unavailable." },
    ]);

    const recovered = await target.catalog({ scope, workspace });
    expect(recovered.skills).toEqual([
      expect.objectContaining({
        name: "review",
        displayName: "Review Changes",
      }),
    ]);
    expect(
      harness.calls.filter(({ method }) => method === "skills/list"),
    ).toHaveLength(2);
  });

  it("rejects a generation race during Codex skill discovery", async () => {
    const harness = new RpcHarness();
    harness.after("skills/list", () => harness.lifecycle("ready", 2));

    await expect(
      driver(harness).catalog({ scope, workspace }),
    ).rejects.toMatchObject({
      category: "unavailable",
      backendCode: "codex_generation_changed",
      retryable: true,
    });
  });

  it("intersects the provider catalog with the configured model allowlist without substitution", async () => {
    const harness = new RpcHarness();
    harness.enqueue("model/list", {
      data: [
        nativeModel(),
        nativeModel({
          id: "gpt-5.6-codex",
          model: "gpt-5.6-codex",
          displayName: "GPT-5.6 Codex",
          isDefault: false,
        }),
      ],
      nextCursor: null,
    });

    const catalog = await driver(
      harness,
      connection,
      new CodexConversationOwnershipRegistry(),
      {
        type: "allowlist",
        allowed: [
          { modelIds: ["gpt-5.6-codex", "configured-but-unavailable"] },
        ],
      },
    ).catalog({ scope, workspace });

    expect(catalog.models).toEqual([
      {
        provider: connection.id,
        id: "gpt-5.6-codex",
        label: "GPT-5.6 Codex",
        inputModalities: ["text"],
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      },
    ]);
    expect(catalog.models).not.toContainEqual(
      expect.objectContaining({ id: "configured-but-unavailable" }),
    );
  });

  it("rejects malformed, duplicate, cyclic, and oversized model catalogs", async () => {
    const malformed = new RpcHarness();
    const invalidModel = nativeModel();
    delete (invalidModel as { description?: unknown }).description;
    malformed.enqueue("model/list", {
      data: [invalidModel],
      nextCursor: null,
    });
    await expect(
      driver(malformed).catalog({ scope, workspace }),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_c1_protocol_invalid",
    });

    const duplicate = new RpcHarness();
    duplicate.enqueue("model/list", {
      data: [nativeModel()],
      nextCursor: "next",
    });
    duplicate.enqueue("model/list", {
      data: [nativeModel()],
      nextCursor: null,
    });
    await expect(
      driver(duplicate).catalog({ scope, workspace }),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_model_catalog_duplicate_id",
    });

    const cyclic = new RpcHarness();
    cyclic.enqueue("model/list", {
      data: [],
      nextCursor: "same",
    });
    cyclic.enqueue("model/list", {
      data: [],
      nextCursor: "same",
    });
    await expect(
      driver(cyclic).catalog({ scope, workspace }),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_model_catalog_cursor_invalid",
    });

    const oversized = new RpcHarness();
    oversized.enqueue("model/list", {
      data: Array.from({ length: 1_000 }, (_unused, index) =>
        nativeModel({
          id: `model-${index}`,
          model: `model-${index}`,
          displayName: `Model ${index}`,
          isDefault: index === 0,
        }),
      ),
      nextCursor: "overflow",
    });
    await expect(
      driver(oversized).catalog({ scope, workspace }),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_model_catalog_too_large",
    });
  });

  it("rejects a model catalog response when the daemon generation changes", async () => {
    const harness = new RpcHarness();
    harness.enqueue("model/list", {
      data: [nativeModel()],
      nextCursor: null,
    });
    harness.after("model/list", () => harness.lifecycle("ready", 2));

    await expect(
      driver(harness).catalog({ scope, workspace }),
    ).rejects.toMatchObject({
      category: "unavailable",
      backendCode: "codex_generation_changed",
      retryable: true,
    });
  });

  it("caches the model catalog within one daemon lifecycle generation", async () => {
    const harness = new RpcHarness();
    harness.enqueue("model/list", {
      data: [nativeModel()],
      nextCursor: null,
    });
    const target = driver(harness);

    const first = await target.catalog({ scope, workspace });
    const second = await target.catalog({ scope, workspace });

    expect(second).toEqual(first);
    expect(
      harness.calls.filter(({ method }) => method === "model/list"),
    ).toHaveLength(1);
  });

  it("refetches the model catalog when the daemon lifecycle generation changes", async () => {
    const harness = new RpcHarness();
    harness.enqueue("model/list", {
      data: [nativeModel()],
      nextCursor: null,
    });
    harness.enqueue("model/list", {
      data: [
        nativeModel({
          id: "gpt-5.6-codex",
          model: "gpt-5.6-codex",
          displayName: "GPT-5.6 Codex",
          isDefault: true,
        }),
      ],
      nextCursor: null,
    });
    const target = driver(harness);

    const first = await target.catalog({ scope, workspace });
    harness.lifecycle("ready", harness.generation + 1);
    const second = await target.catalog({ scope, workspace });

    expect(first.models[0]?.id).toBe("gpt-5.6");
    expect(second.models[0]?.id).toBe("gpt-5.6-codex");
    expect(
      harness.calls.filter(({ method }) => method === "model/list"),
    ).toHaveLength(2);
  });

  it("does not cache a failed model catalog fetch", async () => {
    const harness = new RpcHarness();
    harness.enqueue(
      "model/list",
      new CodexRpcDeliveryError({
        code: "codex_rpc_request_timeout",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "model/list",
      }),
    );
    const target = driver(harness);

    await expect(target.catalog({ scope, workspace })).rejects.toMatchObject({
      category: "unavailable",
    });

    harness.enqueue("model/list", {
      data: [nativeModel()],
      nextCursor: null,
    });
    const catalog = await target.catalog({ scope, workspace });
    expect(catalog.models).toHaveLength(1);
    expect(
      harness.calls.filter(({ method }) => method === "model/list"),
    ).toHaveLength(2);
  });

  it("shares one in-flight model catalog fetch between concurrent callers", async () => {
    const harness = new RpcHarness();
    let release!: () => void;
    harness.enqueue("model/list", async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { data: [nativeModel()], nextCursor: null };
    });
    const target = driver(harness);

    const first = target.catalog({ scope, workspace });
    const second = target.catalog({ scope, workspace });
    release();

    const [firstCatalog, secondCatalog] = await Promise.all([first, second]);
    expect(secondCatalog).toEqual(firstCatalog);
    expect(
      harness.calls.filter(({ method }) => method === "model/list"),
    ).toHaveLength(1);
  });

  it("does not issue a discovery RPC when cancellation is already requested", async () => {
    const harness = new RpcHarness();
    const cancellation = new Error("shutdown");
    const controller = new AbortController();
    controller.abort(cancellation);

    await expect(
      driver(harness).discover({
        scope,
        workspace,
        signal: controller.signal,
        limit: 20,
      }),
    ).rejects.toBe(cancellation);
    expect(harness.calls).toEqual([]);
  });

  it("scopes discovery to the workspace and filters child, ephemeral, and custom sources", async () => {
    const harness = new RpcHarness();
    harness.enqueue("thread/list", {
      data: [
        nativeThread(),
        nativeThread({
          id: "native-fork",
          forkedFromId: "native-parent",
          sessionId: "native-session-tree",
        }),
        nativeThread({ id: "child", parentThreadId: "thread-1" }),
        nativeThread({ id: "ephemeral", ephemeral: true }),
        nativeThread({ id: "wrong-cwd", cwd: "/other" }),
        nativeThread({ id: "subagent", source: { subAgent: "review" } }),
        nativeThread({ id: "custom", source: { custom: "integration" } }),
      ],
      nextCursor: "provider-page-2",
      backwardsCursor: null,
    });

    const page = await driver(harness).discover({
      scope,
      workspace,
      signal: new AbortController().signal,
      limit: 20,
    });

    expect(page.conversations).toHaveLength(2);
    expect(page.conversations[0]).toMatchObject({
      backendConversationId: "thread-1",
      canonicalWorkspacePath: "/workspace",
      title: "Fixture",
    });
    expect(page.conversations[1]).toMatchObject({
      backendConversationId: "native-fork",
      nativeAncestry: {
        method: "provider_native",
        parentBackendConversationId: "native-parent",
      },
    });
    expect(
      parseCodexBindingDetail(page.conversations[1]!.opaqueBindingDetail),
    ).toEqual({
      version: 2,
      threadId: "native-fork",
      sessionId: "native-session-tree",
      nativeAncestry: {
        forkedFromThreadId: "native-parent",
        sourceTurnId: null,
      },
      correlationAncestorThreadIds: ["native-parent"],
    });
    expect(harness.calls[0]).toEqual({
      method: "thread/list",
      params: expect.objectContaining({
        cwd: "/workspace",
        archived: false,
        useStateDbOnly: true,
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      }),
    });
    expect(page.nextCursor).toMatch(/^codex-discovery:/u);
  });

  it("normalizes discovered titles to the durable 240-character boundary", async () => {
    const harness = new RpcHarness();
    harness.enqueue("thread/list", {
      data: [
        nativeThread({ id: "oversized-title", name: "a".repeat(300) }),
        nativeThread({
          id: "surrogate-boundary-title",
          name: `${"b".repeat(239)}😀tail`,
        }),
        nativeThread({
          id: "normalized-title",
          name: "  first line\r\nsecond line  ",
        }),
        nativeThread({
          id: "preview-title",
          name: " \n ",
          preview: "  preview title  ",
        }),
      ],
      nextCursor: null,
      backwardsCursor: null,
    });

    const page = await driver(harness).discover({
      scope,
      workspace,
      signal: new AbortController().signal,
      limit: 20,
    });

    expect(page.conversations.map(({ title }) => title)).toEqual([
      "a".repeat(240),
      "b".repeat(239),
      "first line second line",
      "preview title",
    ]);
    for (const title of page.conversations.map(({ title }) => title)) {
      expect(title).toBeDefined();
      expect(title!.length).toBeLessThanOrEqual(240);
      expect(title).not.toMatch(/[\uD800-\uDFFF]$/u);
    }
  });

  it("recovers an authenticated native fork across a renumbered inherited boundary but not an ordinary turn", async () => {
    const harness = new RpcHarness();
    const operationId = "recover-unknown-fork";
    const marker = codexForkCreationMarker({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "native-parent",
      correlationAncestorThreadIds: [],
      applicationOperationId: operationId,
    });
    const inheritedBoundary = {
      ...nativeTurn(99),
      id: "parent-inherited-boundary",
      items: [
        {
          type: "hookPrompt" as const,
          id: "inherited-boundary-item",
          fragments: [
            {
              text: USER_FORK_CONTEXT_BOUNDARY.content,
              hookRunId: codexForkContextBoundaryHookRunId({
                toolProvenanceKey,
                tenantId: scope.tenantId,
                principalId: scope.principalId,
                backendInstanceId: instance.id,
                nativeThreadId: "native-parent",
                correlationAncestorThreadIds: [],
                applicationOperationId: "prior-fork-boundary",
              }),
            },
          ],
        },
      ],
    };
    const parent = nativeThread({
      id: "native-parent",
      turns: [
        nativeTurn(0),
        { ...nativeTurn(1), status: "interrupted" as const },
        nativeTurn(2),
        inheritedBoundary,
        nativeTurn(3),
      ],
    });
    const child = nativeThread({
      id: "native-recovered-child",
      forkedFromId: parent.id,
      threadSource: marker,
      turns: [
        nativeTurn(0),
        { ...nativeTurn(1), status: "interrupted" as const },
        nativeTurn(2),
        { ...inheritedBoundary, id: "child-inherited-boundary" },
        { ...nativeTurn(3), id: "renumbered-ordinary-turn" },
      ],
    });
    harness.enqueue("thread/list", {
      data: [child],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.enqueue(
      "thread/read",
      { thread: { ...child, turns: [] } },
      { thread: { ...parent, turns: [] } },
      { thread: child },
      { thread: parent },
    );

    const discoveryController = new AbortController();
    const page = await driver(harness).discover({
      scope,
      workspace,
      signal: discoveryController.signal,
      limit: 20,
    });

    expect(page.conversations).toEqual([
      expect.objectContaining({
        backendConversationId: child.id,
        nativeAncestry: {
          method: "provider_native",
          parentBackendConversationId: parent.id,
          sourceBackendTurnId: codexBackendTurnId(parent.id, "turn-2"),
          applicationOperationId: operationId,
          childIdentity: "provider_assigned",
          creationRecovery: "potentially_unknown",
        },
      }),
    ]);
    expect(
      parseCodexBindingDetail(page.conversations[0]!.opaqueBindingDetail),
    ).toMatchObject({
      nativeAncestry: {
        forkedFromThreadId: parent.id,
        sourceTurnId: "turn-2",
      },
    });
    const readSignals = harness.requestOptions
      .filter(({ method }) => method === "thread/read")
      .map(({ options }) => options.signal);
    expect(readSignals).toHaveLength(4);
    for (const signal of readSignals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });

  it("preserves authenticated operation evidence when an active snapshot has no completed source turn", async () => {
    const harness = new RpcHarness();
    const operationId = "quarantine-active-snapshot-orphan";
    const parentTurn = {
      ...nativeTurn(0),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const parent = nativeThread({
      id: "active-snapshot-parent",
      status: { type: "active", activeFlags: [] },
      turns: [parentTurn],
    });
    const child = nativeThread({
      id: "active-snapshot-orphan",
      forkedFromId: parent.id,
      threadSource: codexForkCreationMarker({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: parent.id,
        correlationAncestorThreadIds: [],
        applicationOperationId: operationId,
      }),
      turns: [{ ...parentTurn, status: "interrupted" as const }],
    });
    harness.enqueue("thread/list", {
      data: [child],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.enqueue(
      "thread/read",
      { thread: { ...child, turns: [] } },
      { thread: { ...parent, turns: [] } },
      { thread: child },
      { thread: parent },
    );

    const page = await driver(harness).discover({
      scope,
      workspace,
      signal: new AbortController().signal,
      limit: 20,
    });

    expect(page.conversations[0]?.nativeAncestry).toEqual({
      method: "provider_native",
      parentBackendConversationId: parent.id,
      applicationOperationId: operationId,
      childIdentity: "provider_assigned",
      creationRecovery: "potentially_unknown",
    });
    expect(page.conversations[0]?.nativeAncestry).not.toHaveProperty(
      "sourceBackendTurnId",
    );
    expect(
      parseCodexBindingDetail(page.conversations[0]!.opaqueBindingDetail),
    ).toMatchObject({
      nativeAncestry: {
        forkedFromThreadId: parent.id,
        sourceTurnId: null,
      },
    });
  });

  it("stops native ancestry reads when discovery is cancelled between hops", async () => {
    const harness = new RpcHarness();
    const controller = new AbortController();
    const cancellation = new Error("shutdown");
    const parent = nativeThread({
      id: "cancel-parent",
      forkedFromId: "cancel-ancestor-a",
    });
    const child = nativeThread({
      id: "cancel-child",
      forkedFromId: parent.id,
      threadSource: codexForkCreationMarker({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: parent.id,
        correlationAncestorThreadIds: [],
        applicationOperationId: "cancelled-fork-inspection",
      }),
    });
    const ancestorA = nativeThread({
      id: "cancel-ancestor-a",
      forkedFromId: "cancel-ancestor-b",
      turns: [],
    });
    harness.enqueue("thread/list", {
      data: [child],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.enqueue(
      "thread/read",
      { thread: { ...child, turns: [] } },
      { thread: { ...parent, turns: [] } },
      () => {
        controller.abort(cancellation);
        return { thread: ancestorA };
      },
    );

    await expect(
      driver(harness).discover({
        scope,
        workspace,
        signal: controller.signal,
        limit: 20,
      }),
    ).rejects.toBe(cancellation);
    expect(
      harness.calls.filter(({ method }) => method === "thread/read"),
    ).toHaveLength(3);
  });

  it("recovers deep native fork ancestry with coalesced authenticated boundaries", async () => {
    const harness = new RpcHarness();
    const ancestorA = nativeThread({ id: "ancestor-a", turns: [] });
    const ancestorB = nativeThread({
      id: "ancestor-b",
      forkedFromId: ancestorA.id,
      turns: [],
    });
    const parent = nativeThread({
      id: "deep-parent",
      forkedFromId: ancestorB.id,
      turns: [],
    });
    const operationIds = ["boundary-b", "boundary-c", "boundary-d"];
    const boundaryItems = operationIds.map((applicationOperationId, index) => ({
      type: "hookPrompt" as const,
      id: `deep-boundary-${index}`,
      fragments: [
        {
          text: USER_FORK_CONTEXT_BOUNDARY.content,
          hookRunId: codexForkContextBoundaryHookRunId({
            toolProvenanceKey,
            tenantId: scope.tenantId,
            principalId: scope.principalId,
            backendInstanceId: instance.id,
            nativeThreadId: [ancestorB.id, parent.id, "deep-child"][index]!,
            correlationAncestorThreadIds: [],
            applicationOperationId,
          }),
        },
      ],
    }));
    const visibleTurn = nativeTurn(0);
    const parentBoundaryTurn = {
      ...nativeTurn(99),
      id: "deep-boundary-turn",
      items: boundaryItems.slice(0, 2),
    };
    const parentWithHistory = {
      ...parent,
      turns: [visibleTurn, parentBoundaryTurn],
    };
    const childOperationId = operationIds[2]!;
    const child = nativeThread({
      id: "deep-child",
      forkedFromId: parent.id,
      threadSource: codexForkCreationMarker({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: parent.id,
        correlationAncestorThreadIds: [],
        applicationOperationId: childOperationId,
      }),
      turns: [visibleTurn, { ...parentBoundaryTurn, items: boundaryItems }],
    });
    harness.enqueue("thread/list", {
      data: [child],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.enqueue(
      "thread/read",
      { thread: { ...child, turns: [] } },
      { thread: { ...parentWithHistory, turns: [] } },
      { thread: ancestorB },
      { thread: ancestorA },
      { thread: child },
      { thread: parentWithHistory },
    );

    const page = await driver(harness).discover({
      scope,
      workspace,
      signal: new AbortController().signal,
      limit: 20,
    });

    expect(page.conversations[0]?.nativeAncestry).toMatchObject({
      parentBackendConversationId: parent.id,
      sourceBackendTurnId: codexBackendTurnId(parent.id, visibleTurn.id),
      applicationOperationId: childOperationId,
    });
    expect(
      parseCodexBindingDetail(page.conversations[0]!.opaqueBindingDetail)
        .correlationAncestorThreadIds,
    ).toEqual([ancestorA.id, ancestorB.id, parent.id]);
  });

  it("isolates oversized fork history while discovering the rest of the workspace", async () => {
    const harness = new RpcHarness();
    const operationId = "recover-oversized-fork";
    const parent = nativeThread({
      id: "oversized-parent",
      turns: Array.from({ length: 1_001 }, (_, index) => nativeTurn(index)),
    });
    const child = nativeThread({
      id: "oversized-child",
      forkedFromId: parent.id,
      threadSource: codexForkCreationMarker({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: parent.id,
        correlationAncestorThreadIds: [],
        applicationOperationId: operationId,
      }),
      turns: [
        ...parent.turns,
        {
          ...nativeTurn(1_001),
          id: "oversized-boundary",
          items: [
            {
              type: "hookPrompt" as const,
              id: "oversized-boundary-item",
              fragments: [
                {
                  text: USER_FORK_CONTEXT_BOUNDARY.content,
                  hookRunId: codexForkContextBoundaryHookRunId({
                    toolProvenanceKey,
                    tenantId: scope.tenantId,
                    principalId: scope.principalId,
                    backendInstanceId: instance.id,
                    nativeThreadId: "oversized-child",
                    correlationAncestorThreadIds: [],
                    applicationOperationId: operationId,
                  }),
                },
              ],
            },
          ],
        },
      ],
    });
    const ordinary = nativeThread({ id: "ordinary-thread" });
    harness.enqueue("thread/list", {
      data: [child, ordinary],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.enqueue(
      "thread/read",
      { thread: { ...child, turns: [] } },
      { thread: { ...parent, turns: [] } },
      { thread: child },
      { thread: parent },
    );

    const page = await driver(harness).discover({
      scope,
      workspace,
      signal: new AbortController().signal,
      limit: 20,
    });

    expect(page.conversations).toHaveLength(2);
    expect(page.conversations[0]?.nativeAncestry).toMatchObject({
      parentBackendConversationId: parent.id,
      sourceBackendTurnId: codexBackendTurnId(parent.id, "turn-1000"),
      applicationOperationId: operationId,
    });
    expect(page.conversations[1]?.backendConversationId).toBe(ordinary.id);
  });

  it("binds discovery cursors to profile, workspace, and daemon generation", async () => {
    const harness = new RpcHarness();
    harness.enqueue("thread/list", {
      data: [],
      nextCursor: "native",
      backwardsCursor: null,
    });
    const target = driver(harness);
    const first = await target.discover({
      scope,
      workspace,
      signal: new AbortController().signal,
      limit: 1,
    });
    expect(first.nextCursor).toBeDefined();

    await expect(
      target.discover({
        scope,
        workspace: { ...workspace, canonicalPath: "/other" },
        signal: new AbortController().signal,
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => (
        expectBackendError(error, "rejected", "codex_discovery_cursor_invalid"),
        true
      ),
    );
    harness.lifecycle("ready", 2);
    await expect(
      target.discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      backendCode: "codex_discovery_cursor_invalid",
    });
  });

  it("rejects a generation race rather than returning a stale discovery page", async () => {
    const harness = new RpcHarness();
    harness.enqueue("thread/list", {
      data: [nativeThread()],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.after("thread/list", () => harness.lifecycle("ready", 2));
    await expect(
      driver(harness).discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      backendCode: "codex_generation_changed",
    });
  });

  it("enforces binding scope and excludes unsafe native thread classes on read", async () => {
    const targetHarness = new RpcHarness();
    const target = driver(targetHarness);
    await expect(
      target.read({
        ...attachInput(),
        scope: { ...scope, principalId: "other" },
      }),
    ).rejects.toMatchObject({
      category: "permission_denied",
      backendCode: "codex_thread_binding_mismatch",
    });
    await expect(
      target.read({
        ...attachInput(),
        opaqueBindingDetail: "{bad",
      }),
    ).rejects.toMatchObject({
      category: "permission_denied",
      backendCode: "codex_thread_binding_mismatch",
    });

    for (const unsafe of [
      nativeThread({ ephemeral: true }),
      nativeThread({ parentThreadId: "parent" }),
      nativeThread({ source: { subAgent: "review" } }),
    ]) {
      targetHarness.enqueue("thread/read", { thread: unsafe });
      await expect(target.read(attachInput())).rejects.toMatchObject({
        category: "permission_denied",
        backendCode: "codex_thread_binding_mismatch",
      });
    }
  });

  it("attaches an active thread and establishes its truthful running projection", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const liveAgentItem = {
      type: "agentMessage" as const,
      id: "live-agent-item",
      text: "partial answer",
      phase: "commentary" as const,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          ...nativeTurn(0),
          items: [...nativeTurn(0).items, liveAgentItem],
          status: "inProgress",
          completedAt: null,
        },
      ],
    });
    const handle = (await target.attach(
      attachInput(),
    )) as CodexConversationHandle;
    const established = await establish(harness, handle, activeThread);
    expect(established.snapshot).toMatchObject({
      runState: "running",
      activeBackendTurnId: expect.any(String),
    });
    expect(
      Object.values(established.snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "assistant_message",
      ),
    ).toMatchObject({ status: "streaming" });

    harness.notify("thread/status/changed", {
      threadId: activeThread.id,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    expect(
      Object.values((await handle.readCurrent()).snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "assistant_message",
      ),
    ).toMatchObject({ status: "streaming" });
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    harness.notify("error", {
      threadId: activeThread.id,
      turnId: activeThread.turns[0]!.id,
      willRetry: true,
      error: {
        message: "The provider will retry.",
        codexErrorInfo: null,
        additionalDetails: null,
      },
    });
    expect(
      Object.values((await handle.readCurrent()).snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "assistant_message",
      ),
    ).toMatchObject({ status: "streaming" });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "item_completed" }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "run_state_changed", state: "failed" }),
    );
    harness.notify("item/agentMessage/delta", {
      threadId: activeThread.id,
      turnId: activeThread.turns[0]!.id,
      itemId: liveAgentItem.id,
      delta: " after retry",
    });
    expect(
      Object.values((await handle.readCurrent()).snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "assistant_message",
      ),
    ).toMatchObject({
      status: "streaming",
      markdown: expect.objectContaining({ text: "partial answer after retry" }),
    });
    harness.notify("error", {
      threadId: activeThread.id,
      turnId: activeThread.turns[0]!.id,
      willRetry: false,
      error: {
        message: "The turn failed.",
        codexErrorInfo: null,
        additionalDetails: null,
      },
    });
    expect(events).toContainEqual({
      type: "run_state_changed",
      state: "reconciling",
    });
    expect(events).toContainEqual({
      type: "resnapshot_required",
      reason: "contradictory_state",
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "item_completed" }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "run_state_changed", state: "failed" }),
    );

    const authoritativeFailedThread = {
      ...activeThread,
      status: { type: "systemError" as const },
      turns: activeThread.turns.map((turn) => ({
        ...turn,
        status: "failed" as const,
        completedAt: 1_700_000_003,
        items: turn.items.map((item) =>
          item.id === liveAgentItem.id
            ? { ...liveAgentItem, text: "authoritative failure text" }
            : item,
        ),
      })),
    };
    const recovered = await establish(
      harness,
      handle,
      authoritativeFailedThread,
    );
    expect(recovered.snapshot.runState).toBe("failed");
    expect(
      Object.values(recovered.snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "assistant_message",
      ),
    ).toMatchObject({
      status: "completed",
      markdown: expect.objectContaining({
        text: "authoritative failure text",
      }),
    });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      branching: {
        availability: "available",
        method: "provider_native",
        sourceMustBeIdle: false,
        childIdentity: "provider_assigned",
        creationRecovery: "potentially_unknown",
        fidelity: {
          limitations: [
            {
              text: expect.stringMatching(
                /archive.*descendants.*delete.*permanently delete.*top-level/iu,
              ),
            },
          ],
        },
      },
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("invalidates live projection when accumulated JSON-escaped text exceeds the message limit", async () => {
    const harness = new RpcHarness();
    const liveAgentItem = {
      type: "agentMessage" as const, id: "live-oversized-agent", text: "safe prefix",
      phase: "commentary" as const, memoryCitation: null, delivery: null, questions: null,
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [{ ...nativeTurn(0), items: [...nativeTurn(0).items, liveAgentItem],
        status: "inProgress", completedAt: null }],
    });
    const handle = (await driver(harness).attach(attachInput())) as CodexConversationHandle;
    const established = await establish(harness, handle, activeThread);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    // Every provider frame fits. JSON escaping makes the accumulated text
    // exceed the normalized limit during the live overlay's projection flush.
    for (let index = 0; index < 3; index += 1) {
      harness.notify("item/agentMessage/delta", {
        threadId: activeThread.id, turnId: activeThread.turns[0]!.id,
        itemId: liveAgentItem.id, delta: "\u0000".repeat(1024 * 1024),
      });
    }
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "resnapshot_required",
    })));
    expect(events.filter((event) => event.type === "item_updated").every((event) =>
      Buffer.byteLength(JSON.stringify(event.item)) <= 16 * 1024 * 1024,
    )).toBe(true);
    const count = events.length;
    harness.notify("item/agentMessage/delta", {
      threadId: activeThread.id, turnId: activeThread.turns[0]!.id,
      itemId: liveAgentItem.id, delta: "late text",
    });
    expect(events.slice(count).some((event) => event.type === "item_updated")).toBe(false);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("installs and fences a bounded local failure after error recovery stays noisy", async () => {
    const harness = new RpcHarness();
    const liveAgentItem = {
      type: "agentMessage" as const,
      id: "live-agent-item",
      text: "partial answer",
      phase: "commentary" as const,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    const liveCommandItem = {
      ...nativeCommandTurn(0).items[1]!,
      id: "live-command-item",
      status: "inProgress" as const,
      aggregatedOutput: "partial output",
      exitCode: null,
      durationMs: null,
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          ...nativeTurn(0),
          items: [...nativeTurn(0).items, liveCommandItem, liveAgentItem],
          status: "inProgress",
          completedAt: null,
        },
      ],
    });
    const handle = (await driver(harness).attach(
      attachInput(),
    )) as CodexConversationHandle;
    const established = await establish(harness, handle, activeThread);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));

    harness.notify("item/agentMessage/delta", {
      threadId: activeThread.id,
      turnId: activeThread.turns[0]!.id,
      itemId: liveAgentItem.id,
      delta: " with visible progress",
    });
    harness.notify("error", {
      threadId: activeThread.id,
      turnId: activeThread.turns[0]!.id,
      willRetry: false,
      error: {
        message: "The turn failed.",
        codexErrorInfo: null,
        additionalDetails: null,
      },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      harness.enqueue("thread/read", { thread: activeThread });
      harness.enqueue("thread/resume", resumeResult(activeThread));
      harness.after("thread/resume", (receiptSequence) => {
        harness.notify(
          "item/agentMessage/delta",
          {
            threadId: activeThread.id,
            turnId: activeThread.turns[0]!.id,
            itemId: liveAgentItem.id,
            delta: " ignored recovery race",
          },
          receiptSequence + 1,
        );
      });
    }
    const fallback = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(fallback.snapshot.runState).toBe("failed");
    expect(Object.values(fallback.snapshot.turnsById)).toEqual([
      expect.objectContaining({ status: "failed", endedBy: "failed", failure: { message: { text: "The turn failed." } } }),
    ]);
    expect(
      Object.values(fallback.snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "assistant_message",
      ),
    ).toMatchObject({
      status: "interrupted",
      markdown: expect.objectContaining({
        text: "partial answer with visible progress",
      }),
    });
    expect(
      Object.values(fallback.snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "command",
      ),
    ).toMatchObject({
      status: "failed",
      phase: "failed",
      output: expect.objectContaining({ text: "partial output" }),
    });

    const fencedEvents: BackendConversationEvent[] = [];
    fallback.subscribeFromNext(({ event }) => fencedEvents.push(event));
    harness.notify("item/agentMessage/delta", {
      threadId: activeThread.id,
      turnId: activeThread.turns[0]!.id,
      itemId: liveAgentItem.id,
      delta: " forbidden",
    });
    expect(fencedEvents).toEqual([
      { type: "run_state_changed", state: "reconciling" },
      { type: "resnapshot_required", reason: "contradictory_state" },
    ]);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("hydrates every inferable active overlay and accepts progress without repeated starts", async () => {
    const harness = new RpcHarness();
    const command = {
      ...nativeCommandTurn(0).items[1]!,
      id: "attached-command",
      status: "inProgress" as const,
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const file = {
      type: "fileChange" as const,
      id: "attached-file",
      changes: [
        {
          path: "src/attached.ts",
          kind: { type: "delete" as const },
          diff: "initial file\n",
        },
      ],
      status: "inProgress" as const,
    };
    const mcp = {
      type: "mcpToolCall" as const,
      id: "attached-mcp",
      server: "files",
      tool: "inspect",
      status: "inProgress" as const,
      arguments: { path: "src/attached.ts" },
      appContext: null,
      pluginId: null,
      readOnlyHint: null,
      result: null,
      error: null,
      durationMs: null,
    };
    const reasoning = {
      type: "reasoning" as const,
      id: "attached-reasoning",
      summary: Array.from(
        { length: 250 },
        (_unused, index) => `summary part ${index}`,
      ),
      content: [] as string[],
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          ...nativeTurn(0),
          items: [...nativeTurn(0).items, command, file, mcp, reasoning],
          status: "inProgress",
          completedAt: null,
        },
      ],
    });
    const handle = (await driver(harness).attach(
      attachInput(),
    )) as CodexConversationHandle;
    const established = await establish(harness, handle, activeThread);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const turnId = activeThread.turns[0]!.id;

    harness.notify("thread/status/changed", {
      threadId: activeThread.id,
      status: { type: "active", activeFlags: [] },
    });
    expect(
      Object.values((await handle.readCurrent()).snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "command",
      ),
    ).toMatchObject({ phase: "preflight_or_executing" });
    expect(
      Object.values((await handle.readCurrent()).snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "command",
      ),
    ).not.toHaveProperty("output");

    harness.notify("item/commandExecution/outputDelta", {
      threadId: activeThread.id,
      turnId,
      itemId: command.id,
      delta: " plus output",
    });
    harness.notify("item/fileChange/patchUpdated", {
      threadId: activeThread.id,
      turnId,
      itemId: file.id,
      changes: [{ ...file.changes[0]!, diff: "replacement file\n" }],
    });
    harness.notify("item/mcpToolCall/progress", {
      threadId: activeThread.id,
      turnId,
      itemId: mcp.id,
      message: "attached MCP progress",
    });
    harness.notify("item/reasoning/textDelta", {
      threadId: activeThread.id,
      turnId,
      itemId: reasoning.id,
      contentIndex: 0,
      delta: "attached detail",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 75));

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );
    const items = Object.values(
      (await handle.readCurrent()).snapshot.itemsById,
    );
    expect(
      items.find(({ semanticKind }) => semanticKind === "command"),
    ).toMatchObject({
      output: expect.objectContaining({ text: " plus output" }),
    });
    expect(
      items.find(({ semanticKind }) => semanticKind === "file_change"),
    ).toMatchObject({
      diff: expect.objectContaining({
        text: expect.objectContaining({ text: "replacement file\n" }),
      }),
    });
    expect(
      items.find(({ semanticKind }) => semanticKind === "mcp"),
    ).toMatchObject({ result: expect.anything() });
    const projectedReasoning = items.find(
      ({ semanticKind }) => semanticKind === "reasoning",
    );
    expect(projectedReasoning).toMatchObject({
      markdown: expect.objectContaining({
        text: "attached detail",
      }),
    });
    if (
      projectedReasoning?.semanticKind !== "reasoning" ||
      !projectedReasoning.summaryParts
    ) {
      throw new Error("live reasoning summaries missing");
    }
    expect(projectedReasoning.summaryParts).toHaveLength(250);
    expect(projectedReasoning.summaryParts[0]).toEqual({
      text: "summary part 0",
    });
    expect(projectedReasoning.summaryParts.at(-1)).toEqual({
      text: "summary part 249",
    });

    harness.notify("item/completed", {
      threadId: activeThread.id,
      turnId,
      item: {
        ...command,
        status: "completed",
        aggregatedOutput: " plus output",
        exitCode: 0,
        durationMs: 100,
      },
      completedAtMs: 1_700_000_002_500,
    });
    expect(
      Object.values((await handle.readCurrent()).snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "command",
      ),
    ).toMatchObject({
      status: "completed",
      output: expect.objectContaining({ text: " plus output" }),
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("publishes complete assistant progress beyond the former preview ceiling", async () => {
    const harness = new RpcHarness();
    const liveAgentItem = {
      type: "agentMessage" as const,
      id: "bounded-agent",
      text: "Unicode 雪🙂 paragraph.\n\n".repeat(4_000),
      phase: "commentary" as const,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          ...nativeTurn(0),
          items: [...nativeTurn(0).items, liveAgentItem],
          status: "inProgress",
          completedAt: null,
        },
      ],
    });
    const handle = (await driver(harness).attach(
      attachInput(),
    )) as CodexConversationHandle;
    const established = await establish(harness, handle, activeThread);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));

    harness.notify("item/agentMessage/delta", {
      threadId: activeThread.id,
      turnId: activeThread.turns[0]!.id,
      itemId: liveAgentItem.id,
      delta: "The final paragraph remains visible.",
    });

    const expectedText = `${liveAgentItem.text}The final paragraph remains visible.`;
    expect(events).toEqual([
      expect.objectContaining({
        type: "item_updated",
        item: expect.objectContaining({ markdown: { text: expectedText } }),
      }),
    ]);
    expect(
      Object.values((await handle.readCurrent()).snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "assistant_message",
      ),
    ).toMatchObject({
      markdown: { text: expectedText },
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("advertises native forking only while effective settings are inheritable", async () => {
    const harness = new RpcHarness();
    let eligibility: CodexForkSettingsEligibility = {
      availability: "unavailable",
      settingsRevision: 4,
      reason: "confirmation_unavailable",
    };
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider({
          forkSettingsEligibility: () => eligibility,
        }),
      ),
    );

    const unconfirmed = await handle.backendCapabilities();
    expect(unconfirmed.branching).toEqual({
      availability: "unavailable",
      reason: {
        text: "Wait for Codex to confirm this thread's effective settings before forking.",
      },
    });

    eligibility = {
      availability: "available",
      settingsRevision: 5,
      settings: executionSettingsTuple(),
    };
    const available = await handle.backendCapabilities();
    expect(available.branching).toMatchObject({
      availability: "available",
      boundaries: [
        "latest_completed",
        "selected_completed_turn",
        "latest_provider_snapshot",
      ],
      method: "provider_native",
      settingsInheritance: "application_applied",
    });
    expect(available.revision).not.toBe(unconfirmed.revision);

    eligibility = {
      availability: "unavailable",
      settingsRevision: 6,
      reason: "external_custom",
    };
    const custom = await handle.backendCapabilities();
    expect(custom.branching).toEqual({
      availability: "unavailable",
      reason: {
        text: "This Codex thread uses execution settings Sedes cannot safely inherit.",
      },
    });
    expect(custom.revision).not.toBe(available.revision);
    await handle.close();
  });

  it("normalizes stale in-progress turns behind the live resumed turn", async () => {
    const harness = new RpcHarness();
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      turns: [
        {
          ...nativeTurn(0),
          status: "inProgress",
          completedAt: null,
          durationMs: null,
        },
        nativeTurn(1),
        {
          ...nativeTurn(2),
          status: "inProgress",
          completedAt: null,
          durationMs: null,
        },
      ],
    });
    const handle = await driver(harness).attach(attachInput());
    const established = await establish(harness, handle, activeThread);
    const [staleTurnId, completedTurnId, activeTurnId] =
      established.snapshot.orderedBackendTurnIds;

    expect(established.snapshot.turnsById[staleTurnId!]).toMatchObject({
      status: "interrupted",
      endedBy: "interrupted",
    });
    expect(established.snapshot.turnsById[completedTurnId!]).toMatchObject({
      status: "completed",
      endedBy: "agent_settled",
    });
    expect(established.snapshot.turnsById[activeTurnId!]).toMatchObject({
      status: "in_progress",
    });
    expect(established.snapshot).toMatchObject({
      runState: "running",
      activeBackendTurnId: activeTurnId,
    });
    expect(activeThread.turns[0]?.status).toBe("inProgress");

    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    harness.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    expect(events).toContainEqual({
      type: "run_state_changed",
      state: "running",
      activeBackendTurnId: activeTurnId,
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not authorize a historical in-progress turn as the live turn", async () => {
    const harness = new RpcHarness();
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          ...nativeTurn(0),
          status: "inProgress",
          completedAt: null,
          durationMs: null,
        },
        nativeTurn(1),
      ],
    });
    const handle = await driver(harness).attach(attachInput());
    const established = await establish(harness, handle, activeThread);
    const [staleTurnId, completedTurnId] =
      established.snapshot.orderedBackendTurnIds;

    expect(established.snapshot).toMatchObject({ runState: "running" });
    expect(established.snapshot.activeBackendTurnId).toBeUndefined();
    expect(established.snapshot.turnsById[staleTurnId!]).toMatchObject({
      status: "interrupted",
    });
    expect(established.snapshot.turnsById[completedTurnId!]).toMatchObject({
      status: "completed",
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("maps delivery, released-method, protocol, and overload failures to typed BackendError", async () => {
    const cases = [
      {
        error: new CodexRpcDeliveryError({
          code: "closed",
          delivery: "not_sent",
          generation: 1,
          method: "thread/read",
        }),
        category: "unavailable",
        code: "closed",
      },
      {
        error: new CodexRpcRemoteError({
          code: -32001,
          message: "busy",
          generation: 1,
          method: "thread/read",
        }),
        category: "overloaded",
        code: "codex_remote_overloaded",
      },
      {
        error: new CodexRpcRemoteError({
          code: -32602,
          message: "invalid",
          generation: 1,
          method: "thread/read",
        }),
        category: "incompatible_protocol",
        code: "codex_remote_-32602",
      },
      {
        error: new CodexRpcProtocolError("bad_frame", 1),
        category: "incompatible_protocol",
        code: "bad_frame",
      },
    ] as const;
    for (const candidate of cases) {
      const harness = new RpcHarness();
      harness.enqueue("thread/read", candidate.error);
      await expect(driver(harness).read(attachInput())).rejects.toSatisfy(
        (error: unknown) => (
          expectBackendError(error, candidate.category, candidate.code),
          true
        ),
      );
    }
  });

  it("keeps a load raced by shared RPC generation closure retryable", async () => {
    const harness = new RpcHarness();
    harness.enqueue(
      "thread/read",
      new CodexRpcDeliveryError({
        code: "codex_rpc_client_closed",
        delivery: "not_sent",
        generation: 1,
        method: "thread/read",
      }),
    );

    await expect(driver(harness).read(attachInput())).rejects.toMatchObject({
      category: "unavailable",
      backendCode: "codex_rpc_client_closed",
      retryable: true,
    });
  });

  it("reconciles submissions by durable client identity without blind retry", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const baseline = nativeThread();
    const retryAnchor = serializeCodexSubmissionRetryAnchor(baseline);
    const reconcileInput = {
      scope,
      binding: binding(),
      opaqueBindingDetail: attachInput().opaqueBindingDetail,
      workspace,
      applicationOperationId: "submit-operation",
      reconciliationToken: "submit-token",
      retryAnchor,
    };
    enqueueCompleteLegacyRead(harness, baseline);
    await expect(target.reconcileSubmission(reconcileInput)).resolves.toEqual({
      status: "not_accepted",
      retryable: true,
    });

    const clientId = codexClientUserMessageId({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "thread-1",
      correlationAncestorThreadIds: [],
      applicationOperationId: "submit-operation",
      reconciliationToken: "submit-token",
    });
    const accepted = nativeThread({
      turns: [
        nativeTurn(0),
        {
          ...nativeTurn(1),
          items: [{ ...nativeTurn(1).items[0], clientId }],
        },
      ],
    });
    enqueueCompleteLegacyRead(harness, accepted);
    const terminalReconciliation =
      await target.reconcileSubmission(reconcileInput);
    expect(terminalReconciliation).toMatchObject({
      status: "accepted",
      backendTurn: { status: "completed" },
    });
    if (
      terminalReconciliation.status !== "accepted" ||
      !terminalReconciliation.backendTurn
    ) {
      throw new Error("expected terminal Codex reconciliation");
    }
    expect(terminalReconciliation).toMatchObject({
      completionIdentity: `${terminalReconciliation.backendTurn.backendTurnId}:completed`,
    });
    enqueueCompleteLegacyRead(harness, accepted);
    await expect(target.reconcileSubmission(reconcileInput)).resolves.toEqual(
      terminalReconciliation,
    );

    const active = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [
        nativeTurn(0),
        {
          ...nativeTurn(1),
          status: "inProgress",
          completedAt: null,
          durationMs: null,
          items: [{ ...nativeTurn(1).items[0], clientId }],
        },
      ],
    });
    enqueueCompleteLegacyRead(harness, active);
    const activeReconciliation =
      await target.reconcileSubmission(reconcileInput);
    expect(activeReconciliation).toMatchObject({
      status: "accepted",
      backendTurn: { status: "in_progress" },
    });
    expect("completionIdentity" in activeReconciliation).toBe(false);

    const anotherTokenClientId = codexClientUserMessageId({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "thread-1",
      correlationAncestorThreadIds: [],
      applicationOperationId: "submit-operation",
      reconciliationToken: "another-submit-token",
    });
    enqueueCompleteLegacyRead(
      harness,
      nativeThread({
        turns: [
          nativeTurn(0),
          {
            ...nativeTurn(1),
            items: [
              {
                ...nativeTurn(1).items[0],
                clientId: anotherTokenClientId,
              },
            ],
          },
        ],
      }),
    );
    await expect(
      target.reconcileSubmission(reconcileInput),
    ).resolves.toMatchObject({
      status: "unresolved",
      diagnostic: expect.objectContaining({
        text: expect.stringContaining("diverged"),
      }),
    });

    enqueueCompleteLegacyRead(
      harness,
      nativeThread({ turns: [nativeTurn(0), nativeTurn(2)] }),
    );
    await expect(
      target.reconcileSubmission(reconcileInput),
    ).resolves.toMatchObject({
      status: "unresolved",
      diagnostic: expect.objectContaining({
        text: expect.stringContaining("diverged"),
      }),
    });
  });

  it("reconciles exact pre-rename client identities and retry anchors", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const baseline = nativeThread();
    const reconcileInput = {
      scope,
      binding: binding(),
      opaqueBindingDetail: attachInput().opaqueBindingDetail,
      workspace,
      applicationOperationId: "historical-submit-operation",
      reconciliationToken: "historical-submit-token",
      retryAnchor: legacySubmissionRetryAnchor(baseline),
    };
    enqueueCompleteLegacyRead(harness, baseline);
    await expect(target.reconcileSubmission(reconcileInput)).resolves.toEqual({
      status: "not_accepted",
      retryable: true,
    });

    const [currentClientId, legacyClientId] =
      codexSubmissionReconciliationClientUserMessageIds({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: "thread-1",
        correlationAncestorThreadIds: [],
        applicationOperationId: reconcileInput.applicationOperationId,
        reconciliationToken: reconcileInput.reconciliationToken,
      });
    const accepted = nativeThread({
      turns: [
        nativeTurn(0),
        {
          ...nativeTurn(1),
          items: [{ ...nativeTurn(1).items[0], clientId: legacyClientId }],
        },
      ],
    });
    enqueueCompleteLegacyRead(harness, accepted);
    await expect(
      target.reconcileSubmission(reconcileInput),
    ).resolves.toMatchObject({
      status: "accepted",
      backendTurn: { status: "completed" },
    });

    const ambiguous = nativeThread({
      turns: [
        {
          ...nativeTurn(0),
          items: [{ ...nativeTurn(0).items[0], clientId: currentClientId }],
        },
        {
          ...nativeTurn(1),
          items: [{ ...nativeTurn(1).items[0], clientId: legacyClientId }],
        },
      ],
    });
    enqueueCompleteLegacyRead(harness, ambiguous);
    await expect(
      target.reconcileSubmission(reconcileInput),
    ).resolves.toMatchObject({ status: "unresolved" });
  });

  it("reconciles paginated submissions through exact global item evidence without a complete read", async () => {
    const clientId = codexClientUserMessageId({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "thread-1",
      correlationAncestorThreadIds: [],
      applicationOperationId: "paginated-submit-operation",
      reconciliationToken: "paginated-submit-token",
    });
    const reconcileInput = {
      scope,
      binding: binding(),
      opaqueBindingDetail: attachInput().opaqueBindingDetail,
      workspace,
      applicationOperationId: "paginated-submit-operation",
      reconciliationToken: "paginated-submit-token",
      retryAnchor: serializeCodexSubmissionRetryAnchor(
        paginatedThread({ turns: [nativeTurn(0)] }),
      ),
    };
    const harness = new RpcHarness();
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/turns/list",
      {
        data: [notLoadedTurn(0)],
        nextCursor: null,
        backwardsCursor: "turns-head",
      },
      {
        data: [notLoadedTurn(0)],
        nextCursor: null,
        backwardsCursor: "turns-head",
      },
    );
    harness.enqueue(
      "thread/items/list",
      paginatedItems(0),
      {
        data: [
          {
            turnId: "turn-1",
            item: { ...nativeTurn(1).items[0], clientId },
          },
        ],
        nextCursor: null,
        backwardsCursor: "global-head",
      },
      paginatedItems(0),
      {
        data: [
          {
            turnId: "turn-1",
            item: { ...nativeTurn(1).items[0], clientId },
          },
        ],
        nextCursor: null,
        backwardsCursor: "global-head",
      },
    );

    await expect(
      driver(harness).reconcileSubmission(reconcileInput),
    ).resolves.toEqual({ status: "accepted" });
    expect(
      harness.calls.filter(
        ({ method, params }) =>
          method === "thread/read" &&
          (params as { includeTurns?: boolean }).includeTurns === true,
      ),
    ).toEqual([]);
    const globalScans = harness.calls.filter(
      ({ method, params }) =>
        method === "thread/items/list" &&
        !("turnId" in (params as Record<string, unknown>)),
    );
    expect(globalScans).toHaveLength(2);
    expect(globalScans[0]?.params).toEqual({
      threadId: "thread-1",
      limit: 100,
      sortDirection: "desc",
    });
  });

  it("rejects a repeated paginated item coordinate beyond the cursor-cycle window", async () => {
    const clientId = codexClientUserMessageId({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "thread-1",
      correlationAncestorThreadIds: [],
      applicationOperationId: "paginated-duplicate-operation",
      reconciliationToken: "paginated-duplicate-token",
    });
    const repeated = {
      turnId: "turn-1",
      item: { ...nativeTurn(1).items[0], clientId },
    };
    const harness = new RpcHarness();
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "turns-head",
    });
    harness.enqueue(
      "thread/items/list",
      paginatedItems(0),
      ...Array.from({ length: 10 }, (_, index) => ({
        data: [
          index === 0 || index === 9
            ? repeated
            : {
                turnId: `turn-${index + 10}`,
                item: nativeTurn(index + 10).items[0],
              },
        ],
        nextCursor: index === 9 ? null : `global-page-${index + 1}`,
        backwardsCursor: `global-head-${index}`,
      })),
    );

    await expect(
      driver(harness).reconcileSubmission({
        scope,
        binding: binding(),
        opaqueBindingDetail: attachInput().opaqueBindingDetail,
        workspace,
        applicationOperationId: "paginated-duplicate-operation",
        reconciliationToken: "paginated-duplicate-token",
        retryAnchor: serializeCodexSubmissionRetryAnchor(
          paginatedThread({ turns: [nativeTurn(0)] }),
        ),
      }),
    ).resolves.toMatchObject({
      status: "unresolved",
      diagnostic: {
        text: expect.stringContaining("history is unavailable"),
      },
    });
    expect(
      harness.calls.filter(
        ({ method, params }) =>
          method === "thread/items/list" &&
          !("turnId" in (params as Record<string, unknown>)),
      ),
    ).toHaveLength(10);
  });

  it("keeps paginated submission absence unresolved while metadata remains active", async () => {
    const activeMetadata = paginatedThread({
      status: { type: "active", activeFlags: [] },
    });
    const harness = new RpcHarness();
    harness.enqueue(
      "thread/read",
      { thread: activeMetadata },
      { thread: activeMetadata },
    );
    harness.enqueue(
      "thread/turns/list",
      {
        data: [notLoadedTurn(0)],
        nextCursor: null,
        backwardsCursor: "active-head",
      },
      {
        data: [notLoadedTurn(0)],
        nextCursor: null,
        backwardsCursor: "active-head",
      },
    );
    harness.enqueue(
      "thread/items/list",
      paginatedItems(0),
      paginatedItems(0),
      paginatedItems(0),
      paginatedItems(0),
    );
    const reconciliation = await driver(harness).reconcileSubmission({
      scope,
      binding: binding(),
      opaqueBindingDetail: attachInput().opaqueBindingDetail,
      workspace,
      applicationOperationId: "write-lag-submit-operation",
      reconciliationToken: "write-lag-submit-token",
      retryAnchor: serializeCodexSubmissionRetryAnchor(
        paginatedThread({ turns: [nativeTurn(0)] }),
      ),
    });
    expect(reconciliation).toMatchObject({ status: "unresolved" });
    expect(reconciliation).not.toMatchObject({ status: "not_accepted" });
    expect(
      harness.calls.some(
        ({ method, params }) =>
          method === "thread/read" &&
          (params as { includeTurns?: boolean }).includeTurns === true,
      ),
    ).toBe(false);
  });

  it("restarts paginated submission absence when persistence lands between stable cuts", async () => {
    const clientId = codexClientUserMessageId({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "thread-1",
      correlationAncestorThreadIds: [],
      applicationOperationId: "cut-race-submit-operation",
      reconciliationToken: "cut-race-submit-token",
    });
    const oldTurnsPage = {
      data: [notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "old-head",
    };
    const newTurnsPage = {
      data: [notLoadedTurn(1)],
      nextCursor: null,
      backwardsCursor: "new-head",
    };
    const newItemsPage = {
      data: [
        {
          turnId: "turn-1",
          item: { ...nativeTurn(1).items[0], clientId },
        },
      ],
      nextCursor: null,
      backwardsCursor: "new-item-head",
    };
    const harness = new RpcHarness();
    harness.enqueue(
      "thread/read",
      { thread: paginatedThread() },
      { thread: paginatedThread() },
      { thread: paginatedThread() },
    );
    harness.enqueue(
      "thread/turns/list",
      oldTurnsPage,
      oldTurnsPage,
      newTurnsPage,
      newTurnsPage,
      newTurnsPage,
    );
    harness.enqueue(
      "thread/items/list",
      paginatedItems(0),
      paginatedItems(0),
      paginatedItems(0),
      paginatedItems(0),
      newItemsPage,
      newItemsPage,
      newItemsPage,
      newItemsPage,
      newItemsPage,
      newItemsPage,
    );

    await expect(
      driver(harness).reconcileSubmission({
        scope,
        binding: binding(),
        opaqueBindingDetail: attachInput().opaqueBindingDetail,
        workspace,
        applicationOperationId: "cut-race-submit-operation",
        reconciliationToken: "cut-race-submit-token",
        retryAnchor: serializeCodexSubmissionRetryAnchor(
          paginatedThread({ turns: [nativeTurn(0)] }),
        ),
      }),
    ).resolves.toEqual({ status: "accepted" });
    expect(
      harness.calls.filter(
        ({ method, params }) =>
          method === "thread/items/list" &&
          !("turnId" in (params as Record<string, unknown>)),
      ),
    ).toHaveLength(5);
    expect(
      harness.calls.map(({ method, params }) =>
        method === "thread/items/list"
          ? "turnId" in (params as Record<string, unknown>)
            ? "turn-items"
            : "global-items"
          : method,
      ),
    ).toEqual([
      "thread/read",
      "thread/turns/list",
      "turn-items",
      "global-items",
      "thread/read",
      "thread/turns/list",
      "turn-items",
      "global-items",
      "thread/read",
      "thread/turns/list",
      "turn-items",
      "global-items",
      "thread/turns/list",
      "turn-items",
      "global-items",
      "thread/turns/list",
      "turn-items",
      "global-items",
    ]);
  });

  it("resolves and forks a paginated completed checkpoint without full history reads", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "checkpoint-head",
    });
    harness.enqueue("thread/items/list", paginatedItems(0));
    const checkpoint = await target.resolveBranchCheckpoint({
      ...attachInput(),
      selection: {
        kind: "selected_completed_turn",
        backendTurnId: codexBackendTurnId("thread-1", "turn-0"),
        boundary: "completed_turn_inclusive",
      },
    });

    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "checkpoint-head",
    });
    harness.enqueue("thread/items/list", paginatedItems(0));
    const forkMarker = codexForkCreationMarker({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "thread-1",
      correlationAncestorThreadIds: [],
      applicationOperationId: "paginated-fork-operation",
    });
    harness.enqueue(
      "thread/fork",
      resumeResult(
        paginatedThread({
          id: "paginated-child",
          sessionId: "paginated-child-session",
          forkedFromId: "thread-1",
          threadSource: forkMarker,
        }),
      ),
    );
    await expect(
      target.branchConversation({
        scope,
        childApplicationThreadId: "paginated-application-child",
        applicationOperationId: "paginated-fork-operation",
        source: { kind: "user" },
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: attachInput().opaqueBindingDetail,
        workspace,
        sourceCheckpoint: checkpoint,
        creationCorrelation: "paginated-fork-correlation",
      }),
    ).resolves.toMatchObject({ backendConversationId: "paginated-child" });
    expect(
      harness.calls.find(({ method }) => method === "thread/fork")?.params,
    ).toMatchObject({
      threadId: "thread-1",
      lastTurnId: "turn-0",
      excludeTurns: true,
    });
    expect(
      harness.calls.filter(
        ({ method, params }) =>
          method === "thread/read" &&
          (params as { includeTurns?: boolean }).includeTurns === true,
      ),
    ).toEqual([]);
  });

  it.each(["interrupted", "inProgress"] as const)(
    "skips a newer %s paginated turn when resolving latest completed",
    async (newerStatus) => {
      const harness = new RpcHarness();
      harness.enqueue("thread/read", { thread: paginatedThread() });
      const newer = {
        ...notLoadedTurn(1),
        status: newerStatus,
        ...(newerStatus === "inProgress"
          ? { completedAt: null, durationMs: null }
          : {}),
      };
      harness.enqueue("thread/turns/list", {
        data: [newer, notLoadedTurn(0)],
        nextCursor: null,
        backwardsCursor: "latest-completed-head",
      });
      harness.enqueue(
        "thread/items/list",
        paginatedItems(1),
        paginatedItems(0),
      );

      await expect(
        driver(harness).resolveBranchCheckpoint({
          ...attachInput(),
          selection: { kind: "latest_completed" },
        }),
      ).resolves.toMatchObject({ kind: "conversation_leaf" });
    },
  );

  it("allows a finite multi-page completed-turn scan to exceed one RPC deadline in aggregate", async () => {
    vi.useFakeTimers();
    try {
      const harness = new RpcHarness();
      harness.enqueue("thread/read", { thread: paginatedThread() });
      harness.enqueue(
        "thread/turns/list",
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  data: [
                    {
                      ...notLoadedTurn(1),
                      status: "interrupted",
                    },
                  ],
                  nextCursor: "completed-page",
                  backwardsCursor: "scan-head",
                }),
              6_000,
            );
          }),
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  data: [notLoadedTurn(0)],
                  nextCursor: null,
                  backwardsCursor: "completed-head",
                }),
              6_000,
            );
          }),
      );
      harness.enqueue(
        "thread/items/list",
        paginatedItems(1),
        paginatedItems(0),
      );
      const pending = driver(harness).resolveBranchCheckpoint({
        ...attachInput(),
        selection: { kind: "latest_completed" },
      });
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(6_001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(pending).resolves.toMatchObject({
        kind: "conversation_leaf",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrates only the exact selected turn from a full paginated checkpoint shell page", async () => {
    const harness = new RpcHarness();
    const targetIndex = 0;
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue("thread/turns/list", {
      data: Array.from({ length: 100 }, (_, index) =>
        notLoadedTurn(99 - index),
      ),
      nextCursor: null,
      backwardsCursor: "full-checkpoint-shell-page",
    });
    harness.enqueue("thread/items/list", paginatedItems(targetIndex));

    await expect(
      driver(harness).resolveBranchCheckpoint({
        ...attachInput(),
        selection: {
          kind: "selected_completed_turn",
          backendTurnId: codexBackendTurnId("thread-1", `turn-${targetIndex}`),
          boundary: "completed_turn_inclusive",
        },
      }),
    ).resolves.toMatchObject({ kind: "conversation_leaf" });
    expect(
      harness.calls.filter(({ method }) => method === "thread/items/list"),
    ).toHaveLength(1);
  });

  it("treats the metadata-only native fork response as copy authority", async () => {
    const boundaryHookRunId = codexForkContextBoundaryHookRunId({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "thread-1",
      correlationAncestorThreadIds: [],
      applicationOperationId: "source-boundary",
    });
    const boundaryTurn = {
      ...nativeTurn(99),
      id: "source-boundary-turn",
      items: [
        {
          type: "hookPrompt" as const,
          id: "source-boundary-item",
          fragments: [
            {
              text: USER_FORK_CONTEXT_BOUNDARY.content,
              hookRunId: boundaryHookRunId,
            },
          ],
        },
      ],
    };
    const source = nativeThread({
      turns: [nativeTurn(0), boundaryTurn, nativeTurn(1)],
    });
    const invalidCopies = [
      {
        name: "ordinary turn wrapper identity",
        turns: [
          { ...nativeTurn(0), id: "renumbered-ordinary-turn" },
          boundaryTurn,
          nativeTurn(1),
        ],
      },
      {
        name: "boundary item identity",
        turns: [
          nativeTurn(0),
          {
            ...boundaryTurn,
            items: [{ ...boundaryTurn.items[0]!, id: "changed-boundary-item" }],
          },
          nativeTurn(1),
        ],
      },
      {
        name: "boundary content",
        turns: [
          nativeTurn(0),
          {
            ...boundaryTurn,
            items: [
              {
                ...boundaryTurn.items[0]!,
                fragments: [
                  {
                    ...boundaryTurn.items[0]!.fragments[0]!,
                    text: "Changed boundary content",
                  },
                ],
              },
            ],
          },
          nativeTurn(1),
        ],
      },
      {
        name: "boundary signature",
        turns: [
          nativeTurn(0),
          {
            ...boundaryTurn,
            items: [
              {
                ...boundaryTurn.items[0]!,
                fragments: [
                  {
                    ...boundaryTurn.items[0]!.fragments[0]!,
                    hookRunId: codexForkContextBoundaryHookRunId({
                      toolProvenanceKey,
                      tenantId: scope.tenantId,
                      principalId: scope.principalId,
                      backendInstanceId: instance.id,
                      nativeThreadId: "unrelated-thread",
                      correlationAncestorThreadIds: [],
                      applicationOperationId: "source-boundary",
                    }),
                  },
                ],
              },
            ],
          },
          nativeTurn(1),
        ],
      },
    ];

    for (const [index, invalidCopy] of invalidCopies.entries()) {
      const harness = new RpcHarness();
      const target = driver(harness);
      enqueueCompleteLegacyRead(harness, source);
      const checkpoint = await target.resolveBranchCheckpoint({
        ...attachInput(),
        selection: { kind: "latest_completed" },
      });
      const applicationOperationId = `invalid-copy-${index}`;
      const forkMarker = codexForkCreationMarker({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: source.id,
        correlationAncestorThreadIds: [],
        applicationOperationId,
      });
      const child = nativeThread({
        id: `invalid-copy-child-${index}`,
        sessionId: `invalid-copy-session-${index}`,
        forkedFromId: source.id,
        threadSource: forkMarker,
        turns: invalidCopy.turns,
      });
      enqueueCompleteLegacyRead(harness, source);
      harness.enqueue(
        "thread/fork",
        resumeResult({ ...child, turns: [], status: { type: "idle" } }),
      );

      await expect(
        target.branchConversation({
          scope,
          childApplicationThreadId: `invalid-copy-application-${index}`,
          applicationOperationId,
          source: { kind: "user" },
          sourceBinding: binding(),
          sourceOpaqueBindingDetail: attachInput().opaqueBindingDetail,
          workspace,
          sourceCheckpoint: checkpoint,
          creationCorrelation: `invalid-copy-correlation-${index}`,
        }),
        invalidCopy.name,
      ).resolves.toMatchObject({
        backendConversationId: child.id,
      });
      expect(harness.retirements, invalidCopy.name).toEqual([]);
    }
  });

  it("forks an explicit earlier completed turn while a later Codex turn is active", async () => {
    const inheritedBoundaryHookRunId = codexForkContextBoundaryHookRunId({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "thread-1",
      correlationAncestorThreadIds: [],
      applicationOperationId: "inherited-source-boundary",
    });
    const inheritedBoundaryTurn = {
      ...nativeTurn(99),
      id: "inherited-boundary-turn",
      items: [
        {
          type: "hookPrompt" as const,
          id: "inherited-boundary-item",
          fragments: [
            {
              text: USER_FORK_CONTEXT_BOUNDARY.content,
              hookRunId: inheritedBoundaryHookRunId,
            },
          ],
        },
      ],
    };
    const source = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [
        nativeTurn(0),
        inheritedBoundaryTurn,
        {
          ...nativeTurn(1),
          status: "inProgress",
          completedAt: null,
          durationMs: null,
        },
      ],
    });
    const discoveryHarness = new RpcHarness();
    const discoveryDriver = driver(discoveryHarness);
    discoveryHarness.enqueue(
      "thread/read",
      { thread: { ...source, turns: [] } },
      { thread: source },
    );
    const sourceRead = await discoveryDriver.read(attachInput());
    const selectedBackendTurnId = sourceRead.snapshot.orderedBackendTurnIds[0]!;

    const harness = new RpcHarness();
    const target = driver(harness);
    enqueueCompleteLegacyRead(harness, source);
    const checkpoint = await target.resolveBranchCheckpoint({
      ...attachInput(),
      selection: {
        kind: "selected_completed_turn",
        backendTurnId: selectedBackendTurnId,
        boundary: "completed_turn_inclusive",
      },
    });
    const forkMarker = codexForkCreationMarker({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: source.id,
      correlationAncestorThreadIds: [],
      applicationOperationId: "fork-active-source",
    });
    const child = nativeThread({
      id: "active-source-child",
      sessionId: "active-source-child-session",
      forkedFromId: source.id,
      threadSource: forkMarker,
      turns: [nativeTurn(0), inheritedBoundaryTurn],
    });
    enqueueCompleteLegacyRead(harness, source);
    harness.enqueue("thread/fork", resumeResult({ ...child, turns: [] }));

    await expect(
      target.branchConversation({
        scope,
        childApplicationThreadId: "application-active-source-child",
        applicationOperationId: "fork-active-source",
        source: { kind: "user" },
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: attachInput().opaqueBindingDetail,
        workspace,
        sourceCheckpoint: checkpoint,
        creationCorrelation: "fork-active-source-correlation",
      }),
    ).resolves.toMatchObject({ backendConversationId: child.id });
    expect(
      harness.calls.find(({ method }) => method === "thread/fork")?.params,
    ).toMatchObject({
      threadId: source.id,
      lastTurnId: "turn-0",
      threadSource: forkMarker,
    });
  });

  it.each([
    { capturedStatus: "interrupted" as const, sourceAdvanced: false },
    { capturedStatus: "completed" as const, sourceAdvanced: true },
  ])(
    "forks the latest provider snapshot with a $capturedStatus captured leaf",
    async ({ capturedStatus, sourceAdvanced }) => {
      const activeTurn = {
        ...nativeTurn(1),
        status: "inProgress" as const,
        completedAt: null,
        durationMs: null,
      };
      const source = nativeThread({
        status: { type: "active", activeFlags: [] },
        turns: [nativeTurn(0), activeTurn],
      });
      const harness = new RpcHarness();
      const target = driver(harness);
      harness.enqueue("thread/read", { thread: { ...source, turns: [] } });
      const checkpoint = await target.resolveBranchCheckpoint({
        ...attachInput(),
        selection: { kind: "latest_provider_snapshot" },
      });
      const applicationOperationId = `fork-latest-snapshot-${capturedStatus}`;
      const forkMarker = codexForkCreationMarker({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: source.id,
        correlationAncestorThreadIds: [],
        applicationOperationId,
      });
      const persistedAfterRead = {
        type: "agentMessage" as const,
        id: "latest-snapshot-persisted-agent-item",
        text: "persisted after the checkpoint read",
        phase: "commentary" as const,
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      const child = nativeThread({
        id: "latest-snapshot-child",
        sessionId: "latest-snapshot-child-session",
        forkedFromId: source.id,
        threadSource: forkMarker,
        turns: [
          nativeTurn(0),
          {
            ...activeTurn,
            items: [
              ...activeTurn.items,
              ...(sourceAdvanced ? [persistedAfterRead] : []),
            ],
            status: capturedStatus,
            completedAt: 1_700_000_003,
            durationMs: 2_000,
          },
        ],
      });
      harness.enqueue("thread/read", { thread: { ...source, turns: [] } });
      harness.enqueue(
        "thread/fork",
        resumeResult({ ...child, turns: [], status: { type: "idle" } }),
      );

      const created = await target.branchConversation({
        scope,
        childApplicationThreadId: "application-latest-snapshot-child",
        applicationOperationId,
        source: { kind: "user" },
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: attachInput().opaqueBindingDetail,
        workspace,
        sourceCheckpoint: checkpoint,
        creationCorrelation: "fork-latest-snapshot-correlation",
      });

      expect(
        harness.calls.find(({ method }) => method === "thread/fork")?.params,
      ).toEqual(expect.not.objectContaining({ lastTurnId: expect.anything() }));
      expect(
        harness.calls.some(({ method }) => method === "turn/interrupt"),
      ).toBe(false);
      expect(
        parseCodexBindingDetail(created.opaqueBindingDetail),
      ).toMatchObject({
        nativeAncestry: {
          forkedFromThreadId: source.id,
          sourceTurnId: null,
        },
      });
    },
  );

  it("rejects a latest provider snapshot response that leaves the child active", async () => {
    const activeTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const source = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [nativeTurn(0), activeTurn],
    });
    const harness = new RpcHarness();
    const target = driver(harness);
    enqueueCompleteLegacyRead(harness, source);
    const checkpoint = await target.resolveBranchCheckpoint({
      ...attachInput(),
      selection: { kind: "latest_provider_snapshot" },
    });
    const forkMarker = codexForkCreationMarker({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: source.id,
      correlationAncestorThreadIds: [],
      applicationOperationId: "fork-malformed-latest-snapshot",
    });
    const malformedChild = nativeThread({
      id: "malformed-latest-snapshot-child",
      sessionId: "malformed-latest-snapshot-child-session",
      forkedFromId: source.id,
      threadSource: forkMarker,
      status: { type: "active", activeFlags: [] },
      turns: [nativeTurn(0), activeTurn],
    });
    enqueueCompleteLegacyRead(harness, source);
    harness.enqueue("thread/fork", resumeResult(malformedChild));

    await expect(
      target.branchConversation({
        scope,
        childApplicationThreadId: "application-malformed-latest-snapshot",
        applicationOperationId: "fork-malformed-latest-snapshot",
        source: { kind: "user" },
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: attachInput().opaqueBindingDetail,
        workspace,
        sourceCheckpoint: checkpoint,
        creationCorrelation: "fork-malformed-latest-snapshot-correlation",
      }),
    ).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "codex_fork_response_invalid",
      crossedSubmissionBoundary: true,
    });
    expect(harness.retirements).toEqual([1]);
  });

  it("classifies lost and malformed fork responses as uncertain and retires the daemon generation", async () => {
    for (const [index, forkResponse] of [
      new CodexRpcDeliveryError({
        code: "fork_unknown",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "thread/fork",
      }),
      resumeResult(
        nativeThread({
          id: "ambiguous-child",
          forkedFromId: null,
          threadSource: "fork-ambiguous",
        }),
      ),
      {
        thread: nativeThread({
          id: "malformed-child",
          forkedFromId: "thread-1",
          threadSource: "fork-ambiguous",
        }),
      },
      new CodexRpcRemoteError({
        code: -32603,
        message: "internal failure after dispatch",
        generation: 1,
        method: "thread/fork",
      }),
      new CodexRpcRemoteError({
        code: -32099,
        message: "unrecognized provider failure",
        generation: 1,
        method: "thread/fork",
      }),
    ].entries()) {
      const harness = new RpcHarness();
      const target = driver(harness);
      enqueueCompleteLegacyRead(harness, nativeThread());
      const checkpoint = await target.resolveBranchCheckpoint({
        ...attachInput(),
        selection: { kind: "latest_completed" },
      });
      enqueueCompleteLegacyRead(harness, nativeThread());
      harness.enqueue("thread/fork", forkResponse);
      await expect(
        target.branchConversation({
          scope,
          childApplicationThreadId: `application-uncertain-${index}`,
          applicationOperationId: `fork-uncertain-${index}`,
          source: { kind: "user" },
          sourceBinding: binding(),
          sourceOpaqueBindingDetail: attachInput().opaqueBindingDetail,
          workspace,
          sourceCheckpoint: checkpoint,
          creationCorrelation: index === 0 ? "fork-lost" : "fork-ambiguous",
        }),
      ).rejects.toMatchObject({
        category: "submission_unknown",
        crossedSubmissionBoundary: true,
      });
      expect(harness.facade.lifecycleSnapshot()).toEqual({
        state: "unavailable",
        generation: 1,
      });
    }
  });

  it("fails closed without retrying when a sent native fork reaches its operation-specific timeout", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const source = nativeThread();
    enqueueCompleteLegacyRead(harness, source);
    const checkpoint = await target.resolveBranchCheckpoint({
      ...attachInput(),
      selection: { kind: "latest_completed" },
    });
    enqueueCompleteLegacyRead(harness, source);
    harness.enqueue(
      "thread/fork",
      new CodexRpcDeliveryError({
        code: "codex_rpc_request_timeout",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "thread/fork",
      }),
    );

    await expect(
      target.branchConversation({
        scope,
        childApplicationThreadId: "application-timeout-child",
        applicationOperationId: "fork-timeout",
        source: { kind: "user" },
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: attachInput().opaqueBindingDetail,
        workspace,
        sourceCheckpoint: checkpoint,
        creationCorrelation: "fork-timeout",
      }),
    ).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "codex_rpc_request_timeout",
      crossedSubmissionBoundary: true,
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/fork"),
    ).toHaveLength(1);
    expect(
      harness.requestOptions.find(({ method }) => method === "thread/fork")
        ?.options,
    ).toEqual({ timeoutMilliseconds: 60_000, runtimeCorrelation: {
      kind: "fork", applicationOperationId: "fork-timeout", applicationThreadId: "application-timeout-child",
    } });
    expect(harness.retirements).toEqual([1]);
    expect(harness.facade.lifecycleSnapshot()).toEqual({
      state: "unavailable",
      generation: 1,
    });
  });

  it("fences a fork across daemon replacement and retires the generation that carried it", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const source = nativeThread();
    enqueueCompleteLegacyRead(harness, source);
    const checkpoint = await target.resolveBranchCheckpoint({
      ...attachInput(),
      selection: { kind: "latest_completed" },
    });
    const forkMarker = codexForkCreationMarker({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: source.id,
      correlationAncestorThreadIds: [],
      applicationOperationId: "fork-generation-fence",
    });
    harness.enqueue(
      "thread/read",
      { thread: { ...source, turns: [] } },
      { thread: source },
    );
    harness.enqueue("thread/fork", {
      ...resumeResult(
        nativeThread({
          id: "fork-generation-child",
          forkedFromId: source.id,
          threadSource: forkMarker,
        }),
      ),
      reasoningEffort: "low",
    });
    harness.after("thread/fork", () => harness.lifecycle("ready", 3));

    await expect(
      target.branchConversation({
        scope,
        childApplicationThreadId: "application-generation-child",
        applicationOperationId: "fork-generation-fence",
        source: { kind: "user" },
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: attachInput().opaqueBindingDetail,
        workspace,
        sourceCheckpoint: checkpoint,
        creationCorrelation: "fork-generation-fence",
      }),
    ).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "codex_fork_generation_changed",
      crossedSubmissionBoundary: true,
    });
    expect(harness.retirements).toEqual([1]);
    expect(harness.facade.lifecycleSnapshot()).toEqual({
      state: "ready",
      generation: 3,
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/fork"),
    ).toHaveLength(1);
  });

  it("treats an explicit invalid-params fork rejection as definitely not created", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    enqueueCompleteLegacyRead(harness, nativeThread());
    const checkpoint = await target.resolveBranchCheckpoint({
      ...attachInput(),
      selection: { kind: "latest_completed" },
    });
    enqueueCompleteLegacyRead(harness, nativeThread());
    harness.enqueue(
      "thread/fork",
      new CodexRpcRemoteError({
        code: -32602,
        message: "invalid params",
        generation: 1,
        method: "thread/fork",
      }),
    );

    await expect(
      target.branchConversation({
        scope,
        childApplicationThreadId: "application-rejected-child",
        applicationOperationId: "fork-rejected",
        source: { kind: "user" },
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: attachInput().opaqueBindingDetail,
        workspace,
        sourceCheckpoint: checkpoint,
        creationCorrelation: "fork-rejected",
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      crossedSubmissionBoundary: false,
    });
    expect(harness.facade.lifecycleSnapshot()).toEqual({
      state: "ready",
      generation: 1,
    });
  });
});

describe("CodexConversationHandle", () => {
  it("classifies native execution axes independently", () => {
    expect(
      codexObservedExecutionSettings(
        "gpt-5.6",
        "low",
        "default",
        "on-request",
        "user",
        {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      ),
    ).toEqual({
      model: "gpt-5.6",
      reasoningEffort: "low",
      serviceTier: "standard",
      serviceTierClassification: "recognized",
      sandboxMode: "workspace-write",
      sandboxClassification: "recognized",
      networkAccess: "disabled",
      networkClassification: "recognized",
      approvalPolicy: "on-request",
      approvalPolicyClassification: "recognized",
      approvalReviewer: "user",
      approvalReviewerClassification: "recognized",
      policyObservation: "complete",
    });

    expect(
      codexObservedExecutionSettings(
        "gpt-5.6",
        "high",
        "default",
        {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: true,
            request_permissions: true,
            mcp_elicitations: true,
          },
        },
        "guardian_subagent",
        {
          type: "workspaceWrite",
          writableRoots: ["/tmp"],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      ),
    ).toEqual({
      model: "gpt-5.6",
      reasoningEffort: "high",
      serviceTier: "standard",
      serviceTierClassification: "recognized",
      sandboxMode: null,
      sandboxClassification: "external_custom",
      networkAccess: "enabled",
      networkClassification: "recognized",
      approvalPolicy: null,
      approvalPolicyClassification: "external_custom",
      approvalReviewer: null,
      approvalReviewerClassification: "external_custom",
      policyObservation: "complete",
    });

    expect(
      codexObservedExecutionSettings(
        "gpt-5.6",
        "low",
        "default",
        "on-request",
        "auto_review",
        { type: "externalSandbox", networkAccess: "enabled" },
      ),
    ).toEqual({
      model: "gpt-5.6",
      reasoningEffort: "low",
      serviceTier: "standard",
      serviceTierClassification: "recognized",
      sandboxMode: null,
      sandboxClassification: "external_custom",
      networkAccess: "enabled",
      networkClassification: "recognized",
      approvalPolicy: "on-request",
      approvalPolicyClassification: "recognized",
      approvalReviewer: "auto_review",
      approvalReviewerClassification: "recognized",
      policyObservation: "complete",
    });

    expect(
      codexObservedExecutionSettings("gpt-5.6", "low", null, "never", "user", {
        type: "readOnly",
        networkAccess: false,
      }),
    ).toMatchObject({
      serviceTier: null,
      serviceTierClassification: "external_custom",
    });
  });

  it("establishes from one metadata read and projects only the resumed history", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const resumedThread = nativeThread({
      turns: [nativeTurn(0), nativeTurn(1)],
    });
    harness.enqueue("thread/read", {
      thread: nativeThread({ turns: [] }),
    });
    harness.enqueue("thread/resume", resumeResult(resumedThread));

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(2);
    const reads = harness.calls.filter(
      ({ method }) => method === "thread/read",
    );
    expect(reads).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
    ]);
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(
      reads.filter(
        ({ params }) =>
          (params as { includeTurns?: boolean }).includeTurns === true,
      ),
    ).toEqual([]);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("revalidates metadata before resume when the daemon changes during CLI acquisition", async () => {
    const harness = new RpcHarness();
    let acquisitionCount = 0;
    const acquire = vi.fn(async () => {
      acquisitionCount += 1;
      if (acquisitionCount === 1) {
        expect(
          harness.calls
            .filter(
              ({ method }) =>
                method === "thread/read" || method === "thread/resume",
            )
            .map(({ method }) => method),
        ).toEqual(["thread/read"]);
        harness.lifecycle("ready", 2);
      }
      return {
        availability: "unavailable" as const,
        reason: "network_disabled" as const,
      };
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider(),
        undefined,
        undefined,
        { acquire },
      ),
    );
    harness.enqueue(
      "thread/read",
      { thread: nativeThread({ turns: [] }) },
      { thread: nativeThread({ turns: [] }) },
    );
    harness.enqueue("thread/resume", resumeResult());

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(1);
    expect(
      harness.calls
        .filter(
          ({ method }) =>
            method === "thread/read" || method === "thread/resume",
        )
        .map(({ method, params }) => ({ method, params })),
    ).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
      {
        method: "thread/resume",
        params: {
          threadId: "thread-1",
          serviceTier: "default",
          config: {
            shell_environment_policy: scrubbedAgentToolShellEnvironmentPolicy,
          },
        },
      },
    ]);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(harness.facade.lifecycleSnapshot()).toEqual({
      state: "ready",
      generation: 2,
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("rejects every unsafe native binding before resume", async () => {
    const unsafeThreads = [
      nativeThread({ id: "another-thread" }),
      nativeThread({ cwd: "/other-workspace" }),
      nativeThread({ ephemeral: true }),
      nativeThread({ parentThreadId: "parent-thread" }),
      nativeThread({ source: { custom: "integration" } }),
      nativeThread({ source: { subAgent: "review" } }),
    ];

    for (const unsafeThread of unsafeThreads) {
      const harness = new RpcHarness();
      const target = driver(harness);
      const handle = await attachIdle(harness, target);
      harness.enqueue("thread/read", { thread: unsafeThread });

      await expect(
        handle.establishProjection({
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        category: "permission_denied",
        backendCode: "codex_thread_binding_mismatch",
      });
      expect(harness.calls).toEqual([
        {
          method: "thread/read",
          params: { threadId: "thread-1", includeTurns: false },
        },
      ]);
      expect(
        harness.calls.some(({ method }) => method === "thread/resume"),
      ).toBe(false);

      await handle.close();
      const replacement = await target.attach(attachInput());
      await replacement.close();
    }
  });

  it("branches exactly on Codex history mode and hydrates paginated history privately", async () => {
    const metadataHarness = new RpcHarness();
    const metadataHandle = await attachIdle(metadataHarness);
    metadataHarness.enqueue("thread/read", {
      thread: paginatedThread(),
    });
    metadataHarness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        shells: [notLoadedTurn(1), notLoadedTurn(0)],
      }),
    );
    metadataHarness.enqueue(
      "thread/items/list",
      paginatedItems(1),
      paginatedItems(0),
    );
    const established = await metadataHandle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(established.snapshot.orderedBackendTurnIds).toEqual([
      codexBackendTurnId("thread-1", "turn-0"),
      codexBackendTurnId("thread-1", "turn-1"),
    ]);
    expect(
      metadataHarness.calls.filter(({ method }) =>
        [
          "thread/read",
          "thread/resume",
          "thread/turns/list",
          "thread/items/list",
        ].includes(method),
      ),
    ).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
      {
        method: "thread/resume",
        params: {
          threadId: "thread-1",
          serviceTier: "default",
          config: {
            shell_environment_policy: scrubbedAgentToolShellEnvironmentPolicy,
          },
          excludeTurns: true,
          initialTurnsPage: {
            limit: 10,
            sortDirection: "desc",
            itemsView: "notLoaded",
          },
        },
      },
      {
        method: "thread/items/list",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          cursor: "item-head",
          limit: 100,
          sortDirection: "desc",
        },
      },
      {
        method: "thread/items/list",
        params: {
          threadId: "thread-1",
          turnId: "turn-0",
          cursor: "item-head",
          limit: 100,
          sortDirection: "desc",
        },
      },
    ]);
    expect(
      metadataHarness.calls.some(
        ({ method }) => method === "thread/turns/list",
      ),
    ).toBe(false);
    metadataHarness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await metadataHandle.close();

    const changedHarness = new RpcHarness();
    const changedHandle = await attachIdle(changedHarness);
    changedHarness.enqueue("thread/read", { thread: nativeThread() });
    changedHarness.enqueue("thread/resume", {
      ...resumeResult(),
      thread: paginatedThread(),
    });
    await expect(
      changedHandle.establishProjection({
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_history_mode_changed",
    });
    changedHarness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await changedHandle.close();

    const reverseHarness = new RpcHarness();
    const reverseHandle = await attachIdle(reverseHarness);
    reverseHarness.enqueue("thread/read", { thread: paginatedThread() });
    reverseHarness.enqueue("thread/resume", resumeResult());
    await expect(
      reverseHandle.establishProjection({
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_history_mode_changed",
    });
    reverseHarness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await reverseHandle.close();
  });

  it("hydrates a paginated resume from its inclusive item boundary in normalized order", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const items = ["oldest", "middle", "boundary"].map((label) => ({
      ...nativeTurn(0).items[0],
      id: `item-${label}`,
      content: [
        {
          type: "text" as const,
          text: label,
          text_elements: [],
        },
      ],
    }));
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        shells: [notLoadedTurn(0)],
        itemsBackwardsCursor: "item-boundary",
      }),
    );
    harness.enqueue(
      "thread/items/list",
      {
        data: [items[2], items[1]].map((item) => ({
          turnId: "turn-0",
          item,
        })),
        nextCursor: "older-items",
        backwardsCursor: "item-boundary",
      },
      {
        data: [{ turnId: "turn-0", item: items[0] }],
        nextCursor: null,
        backwardsCursor: "older-items",
      },
    );

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const turn =
      established.snapshot.turnsById[codexBackendTurnId("thread-1", "turn-0")]!;
    expect(
      turn.orderedBackendItemIds.flatMap((itemId) => {
        const item = established.snapshot.itemsById[itemId]!;
        return item.semanticKind === "user_message"
          ? item.content.flatMap((part) =>
              part.kind === "text" ? [part.text.text] : [],
            )
          : [];
      }),
    ).toEqual(["oldest", "middle", "boundary"]);
    expect(
      harness.calls
        .filter(({ method }) => method === "thread/items/list")
        .map(({ params }) => params),
    ).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-0",
        cursor: "item-boundary",
        limit: 100,
        sortDirection: "desc",
      },
      {
        threadId: "thread-1",
        turnId: "turn-0",
        cursor: "older-items",
        limit: 100,
        sortDirection: "desc",
      },
    ]);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not read items when a paginated resume has no durable item boundary", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        shells: [notLoadedTurn(0)],
        itemsBackwardsCursor: null,
      }),
    );

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const turn =
      established.snapshot.turnsById[codexBackendTurnId("thread-1", "turn-0")]!;
    expect(turn.orderedBackendItemIds).toEqual([]);
    expect(
      harness.calls.some(({ method }) => method === "thread/items/list"),
    ).toBe(false);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("locates one legacy turn outside the retained snapshot without provider reads", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const thread = nativeThread({
      turns: Array.from({ length: 12 }, (_, index) => nativeTurn(index)),
    });
    await establish(harness, handle, thread);
    const callsAfterEstablishment = harness.calls.length;
    const targetBackendTurnId = codexBackendTurnId("thread-1", "turn-0");

    await expect(
      handle.locateTurn({
        matchesBackendTurnId: (candidate) => candidate === targetBackendTurnId,
        maximumTurnCandidates: 12,
      }),
    ).resolves.toMatchObject({
      status: "found",
      page: { orderedBackendTurnIds: [targetBackendTurnId] },
    });
    expect(harness.calls).toHaveLength(callsAfterEstablishment);
    await expect(
      handle.locateTurn({
        matchesBackendTurnId: (candidate) => candidate === targetBackendTurnId,
        maximumTurnCandidates: 11,
      }),
    ).resolves.toEqual({ status: "search_limit_reached" });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("scans paginated turn shells and hydrates only the located turn", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from(
      { length: 10 },
      (_, offset) => 11 - offset,
    );
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    await handle.establishProjection({ signal: new AbortController().signal });
    const itemReadsAfterEstablishment = harness.calls.filter(
      ({ method }) => method === "thread/items/list",
    ).length;
    const abandonedLocatedTurn = {
      ...notLoadedTurn(0),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    harness.enqueue(
      "thread/turns/list",
      {
        data: initialIndexes.map(notLoadedTurn),
        nextCursor: "older-turns",
        backwardsCursor: "turns-head",
      },
      {
        data: [notLoadedTurn(1), abandonedLocatedTurn],
        nextCursor: null,
        backwardsCursor: "older-turns",
      },
    );
    harness.enqueue("thread/items/list", paginatedItems(0));
    const targetBackendTurnId = codexBackendTurnId("thread-1", "turn-0");

    await expect(
      handle.locateTurn({
        matchesBackendTurnId: (candidate) => candidate === targetBackendTurnId,
        maximumTurnCandidates: 12,
      }),
    ).resolves.toMatchObject({
      status: "found",
      page: {
        orderedBackendTurnIds: [targetBackendTurnId],
        turnsById: {
          [targetBackendTurnId]: {
            status: "interrupted",
            endedBy: "interrupted",
          },
        },
      },
    });
    expect(
      harness.calls
        .filter(({ method }) => method === "thread/turns/list")
        .slice(-2)
        .map(({ params }) => params),
    ).toEqual([
      {
        threadId: "thread-1",
        limit: 12,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
      {
        threadId: "thread-1",
        cursor: "older-turns",
        limit: 2,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
    ]);
    expect(
      harness.calls.filter(({ method }) => method === "thread/items/list"),
    ).toHaveLength(itemReadsAfterEstablishment + 1);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("reports a paginated locate bound without hydrating candidates", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from(
      { length: 10 },
      (_, offset) => 9 - offset,
    );
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    await handle.establishProjection({ signal: new AbortController().signal });
    const itemReadsAfterEstablishment = harness.calls.filter(
      ({ method }) => method === "thread/items/list",
    ).length;
    harness.enqueue("thread/turns/list", {
      data: initialIndexes.slice(0, 3).map(notLoadedTurn),
      nextCursor: "older-turns",
      backwardsCursor: "turns-head",
    });

    await expect(
      handle.locateTurn({
        matchesBackendTurnId: () => false,
        maximumTurnCandidates: 3,
      }),
    ).resolves.toEqual({ status: "search_limit_reached" });
    expect(
      harness.calls.filter(({ method }) => method === "thread/items/list"),
    ).toHaveLength(itemReadsAfterEstablishment);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("distinguishes paginated absence from a non-progressing provider cursor", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 2 }, (_, offset) => 1 - offset);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    await handle.establishProjection({ signal: new AbortController().signal });
    const itemReadsAfterEstablishment = harness.calls.filter(
      ({ method }) => method === "thread/items/list",
    ).length;
    harness.enqueue("thread/turns/list", {
      data: initialIndexes.map(notLoadedTurn),
      nextCursor: null,
      backwardsCursor: "turns-head",
    });
    await expect(
      handle.locateTurn({
        matchesBackendTurnId: () => false,
        maximumTurnCandidates: 10,
      }),
    ).resolves.toEqual({ status: "not_found" });

    harness.enqueue(
      "thread/turns/list",
      {
        data: [notLoadedTurn(1)],
        nextCursor: "stalled",
        backwardsCursor: "turns-head",
      },
      {
        data: [notLoadedTurn(0)],
        nextCursor: "stalled",
        backwardsCursor: "stalled",
      },
    );
    await expect(
      handle.locateTurn({
        matchesBackendTurnId: () => false,
        maximumTurnCandidates: 10,
      }),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_paginated_turn_cursor_no_progress",
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/items/list"),
    ).toHaveLength(itemReadsAfterEstablishment);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("hydrates a paginated turn beyond the former 2,000-item ceiling", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const items = Array.from({ length: 2_001 }, (_, index) => ({
      type: "agentMessage" as const,
      id: `long-running-item-${index}`,
      text: "progress",
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    }));
    const itemPages = Array.from(
      { length: Math.ceil(items.length / 100) },
      (_, pageIndex) => {
        const data = items
          .slice(pageIndex * 100, (pageIndex + 1) * 100)
          .map((item) => ({ turnId: "turn-0", item }));
        return {
          data,
          nextCursor:
            pageIndex === Math.ceil(items.length / 100) - 1
              ? null
              : `long-running-items-${pageIndex + 1}`,
          backwardsCursor: "long-running-items-head",
        };
      },
    );

    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: [notLoadedTurn(0)] }),
    );
    harness.enqueue("thread/items/list", ...itemPages);

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const turn =
      established.snapshot.turnsById[
        established.snapshot.orderedBackendTurnIds[0]!
      ]!;
    expect(turn.orderedBackendItemIds).toHaveLength(items.length);
    expect(established.snapshot.runState).toBe("idle");

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("distinguishes and hydrates a durable active paginated head", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const active = {
      ...notLoadedTurn(1),
      status: "inProgress" as const,
      completedAt: null,
    };
    const activeThread = paginatedThread({
      status: { type: "active", activeFlags: [] },
    });
    harness.enqueue("thread/read", { thread: activeThread });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        thread: activeThread,
        shells: [active, notLoadedTurn(0)],
      }),
    );
    harness.enqueue("thread/turns/list", {
      data: [active],
      nextCursor: "after-active",
      backwardsCursor: "turns-head",
    });
    harness.enqueue("thread/items/list", paginatedItems(1), paginatedItems(0));

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const newest = await handle.history({ limit: 1 });
    expect(newest.orderedBackendTurnIds).toEqual([
      codexBackendTurnId("thread-1", "turn-1"),
    ]);
    expect(newest.previousCursor).toBeDefined();

    harness.enqueue("thread/turns/list", {
      data: [active, notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "turns-head",
    });
    harness.enqueue("thread/items/list", paginatedItems(0));
    const durableNewest = await handle.history({
      limit: 1,
      cursor: newest.previousCursor,
    });
    expect(durableNewest.orderedBackendTurnIds).toEqual([
      codexBackendTurnId("thread-1", "turn-0"),
    ]);
    expect(durableNewest.previousCursor).toBeUndefined();
    expect(established.snapshot.runState).toBe("running");

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("projects abandoned paginated turns behind the live head as interrupted", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const abandoned = {
      ...notLoadedTurn(0),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const live = {
      ...notLoadedTurn(2),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const activeThread = paginatedThread({
      status: { type: "active", activeFlags: [] },
    });
    harness.enqueue("thread/read", { thread: activeThread });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        thread: activeThread,
        shells: [live, notLoadedTurn(1), abandoned],
      }),
    );
    harness.enqueue("thread/turns/list", {
      data: [live],
      nextCursor: "after-live",
      backwardsCursor: "turns-head",
    });
    harness.enqueue(
      "thread/items/list",
      paginatedItems(2),
      paginatedItems(1),
      paginatedItems(0),
    );

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const abandonedTurnId = codexBackendTurnId("thread-1", "turn-0");
    const liveTurnId = codexBackendTurnId("thread-1", "turn-2");
    expect(established.snapshot.turnsById[abandonedTurnId]).toMatchObject({
      status: "interrupted",
      endedBy: "interrupted",
    });
    expect(established.snapshot.turnsById[liveTurnId]).toMatchObject({
      status: "in_progress",
    });
    expect(established.snapshot).toMatchObject({
      runState: "running",
      activeBackendTurnId: liveTurnId,
    });
    expect(abandoned.status).toBe("inProgress");
    expect(
      harness.calls.some(
        ({ method, params }) =>
          method === "thread/read" &&
          (params as { includeTurns?: boolean }).includeTurns === true,
      ),
    ).toBe(false);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("projects an attached idle paginated head of abandoned turns as interrupted", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const abandoned = [1, 0].map((index) => ({
      ...notLoadedTurn(index),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    }));
    const resumed = paginatedResumeResult({ shells: abandoned });
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue("thread/resume", {
      ...resumed,
      initialTurnsPage: {
        ...resumed.initialTurnsPage,
        backwardsCursor: "turns-head",
      },
      turnsBackwardsCursor: "turns-head",
    });
    harness.enqueue("thread/items/list", paginatedItems(1), paginatedItems(0));

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(established.snapshot.runState).toBe("idle");
    expect(established.snapshot.activeBackendTurnId).toBeUndefined();
    expect(
      established.snapshot.orderedBackendTurnIds.map(
        (turnId) => established.snapshot.turnsById[turnId]?.status,
      ),
    ).toEqual(["interrupted", "interrupted"]);
    expect(
      harness.calls.some(({ method }) => method === "thread/turns/list"),
    ).toBe(false);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("retries an overlay-only active paginated resume without item hydration", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const activeThread = paginatedThread({
      status: { type: "active", activeFlags: [] },
    });
    harness.enqueue("thread/read", { thread: activeThread });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        thread: activeThread,
        shells: [
          {
            ...notLoadedTurn(0),
            status: "inProgress",
            completedAt: null,
          },
        ],
      }),
    );
    harness.enqueue("thread/turns/list", {
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });

    await expect(
      handle.establishProjection({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      category: "unavailable",
      retryable: true,
      backendCode: "codex_paginated_active_overlay_unavailable",
    });
    expect(
      harness.calls.some(({ method }) => method === "thread/items/list"),
    ).toBe(false);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("treats a running paginated head-cursor mismatch as retryable reconciliation", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const active = {
      ...notLoadedTurn(0),
      status: "inProgress" as const,
      completedAt: null,
    };
    const activeThread = paginatedThread({
      status: { type: "active", activeFlags: [] },
    });
    harness.enqueue("thread/read", { thread: activeThread });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ thread: activeThread, shells: [active] }),
    );
    harness.enqueue("thread/turns/list", {
      data: [active],
      nextCursor: null,
      backwardsCursor: "raced-head",
    });

    await expect(
      handle.establishProjection({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      category: "unavailable",
      retryable: true,
      backendCode: "codex_history_reconciliation_required",
    });
    expect(
      harness.calls.some(({ method }) => method === "thread/items/list"),
    ).toBe(false);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("publishes a 10-turn snapshot while paging the complete history by the requested limit", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const handle = await attachIdle(harness, target);
    const thread = nativeThread({
      turns: Array.from({ length: 125 }, (_, index) => nativeTurn(index)),
    });
    const established = await establish(harness, handle, thread);
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(established.history).toEqual({
      operational: true,
      previousCursor: expect.stringMatching(/^codex-history:/u),
    });
    const immediatelyOlder = await handle.history({
      limit: 10,
      cursor: established.history.previousCursor,
    });
    expect(immediatelyOlder.orderedBackendTurnIds).toHaveLength(10);
    expect(immediatelyOlder.orderedBackendTurnIds.at(-1)).not.toBe(
      established.snapshot.orderedBackendTurnIds[0],
    );

    const newest = await handle.history({ limit: 7 });
    expect(newest.orderedBackendTurnIds).toHaveLength(7);
    expect(newest.previousCursor).toBeDefined();
    const older = await handle.history({
      limit: 10,
      cursor: newest.previousCursor,
    });
    expect(older.orderedBackendTurnIds).toHaveLength(10);
    expect(
      new Set([...newest.orderedBackendTurnIds, ...older.orderedBackendTurnIds])
        .size,
    ).toBe(17);
    await expect(
      handle.history({ limit: 1, cursor: "codex-history:stale:1" }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "codex_history_cursor_invalid",
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("pages older paginated turns through request-local item hydration", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 11 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        shells: initialIndexes.map(notLoadedTurn),
        nextCursor: "older-page",
      }),
    );
    harness.enqueue(
      "thread/items/list",
      ...initialIndexes.map(paginatedItems),
      paginatedItems(1),
    );
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(1)],
      nextCursor: null,
      backwardsCursor: "older-head",
    });

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(established.history.previousCursor).toMatch(
      /^codex-paginated-history:v1:/u,
    );
    expect(established.history.previousCursor).not.toContain("older-page");

    const abandonedOlderTurn = {
      ...notLoadedTurn(0),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(1), abandonedOlderTurn],
      nextCursor: null,
      backwardsCursor: "older-head",
    });
    harness.enqueue("thread/items/list", paginatedItems(1), paginatedItems(0));
    const older = await handle.history({
      limit: 2,
      cursor: established.history.previousCursor,
    });
    expect(older.orderedBackendTurnIds).toEqual([
      codexBackendTurnId("thread-1", "turn-0"),
      codexBackendTurnId("thread-1", "turn-1"),
    ]);
    expect(
      older.turnsById[codexBackendTurnId("thread-1", "turn-0")],
    ).toMatchObject({ status: "interrupted", endedBy: "interrupted" });
    expect(older.previousCursor).toBeUndefined();
    expect(
      harness.calls
        .filter(({ method }) => method === "thread/turns/list")
        .map(({ params }) => params),
    ).toEqual([
      {
        threadId: "thread-1",
        cursor: "older-page",
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
      {
        threadId: "thread-1",
        cursor: "older-page",
        limit: 2,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
    ]);
    expect((await handle.readCurrent()).snapshot).toEqual(established.snapshot);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("suppresses a paginated previous cursor after exhausting hidden-only older turns", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 10 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        shells: initialIndexes.map(notLoadedTurn),
        nextCursor: "hidden-only",
      }),
    );
    harness.enqueue("thread/turns/list", {
      data: [hiddenBoundaryTurn(0)],
      nextCursor: null,
      backwardsCursor: "hidden-only-head",
    });
    harness.enqueue(
      "thread/items/list",
      ...initialIndexes.map(paginatedItems),
      hiddenBoundaryItems(0),
    );
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(established.history.previousCursor).toBeUndefined();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("suppresses a refreshed previous cursor after exhausting a hidden-only older tail", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 9 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    await handle.establishProjection({ signal: new AbortController().signal });

    const refreshedIndexes = Array.from(
      { length: 10 },
      (_, offset) => 10 - offset,
    );
    harness.enqueue(
      "thread/turns/list",
      {
        data: refreshedIndexes.map(notLoadedTurn),
        nextCursor: "hidden-refresh-tail",
        backwardsCursor: "refreshed-head",
      },
      {
        data: [hiddenBoundaryTurn(0)],
        nextCursor: null,
        backwardsCursor: "hidden-refresh-head",
      },
    );
    harness.enqueue(
      "thread/items/list",
      ...refreshedIndexes.map(paginatedItems),
      hiddenBoundaryItems(0),
    );
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: nativeTurn(10),
    });
    await vi.waitFor(async () => {
      expect(
        harness.calls.filter(({ method }) => method === "thread/turns/list"),
      ).toHaveLength(2);
      const history = await handle.history({ limit: 10 });
      expect(history.orderedBackendTurnIds.at(-1)).toBe(
        codexBackendTurnId("thread-1", "turn-10"),
      );
      expect(history.previousCursor).toBeUndefined();
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("rejects an over-returned completion lookahead before hydration or cursor installation", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 9 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: SequencedBackendEvent[] = [];
    const unsubscribe = established.subscribeFromNext((event) =>
      events.push(event),
    );

    const refreshedIndexes = Array.from(
      { length: 10 },
      (_, offset) => 10 - offset,
    );
    const lookaheadIndexes = Array.from({ length: 100 }, (_, index) => -index);
    harness.enqueue(
      "thread/turns/list",
      {
        data: refreshedIndexes.map(notLoadedTurn),
        nextCursor: "full-lookahead",
        backwardsCursor: "refreshed-head",
      },
      {
        data: lookaheadIndexes.map(notLoadedTurn),
        nextCursor: "after-full-lookahead",
        backwardsCursor: "full-lookahead-head",
      },
    );
    harness.enqueue(
      "thread/items/list",
      ...refreshedIndexes.map(paginatedItems),
    );
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: nativeTurn(10),
    });
    await vi.waitFor(() =>
      expect(events.map(({ event }) => event.type)).toContain(
        "resnapshot_required",
      ),
    );
    expect(
      harness.calls.filter(({ method }) => method === "thread/items/list"),
    ).toHaveLength(20);
    expect(
      harness.calls.filter(({ method }) => method === "thread/turns/list")[1]
        ?.params,
    ).toMatchObject({ cursor: "full-lookahead", limit: 1 });
    expect((await handle.readCurrent()).snapshot).toEqual(established.snapshot);

    unsubscribe();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("hydrates one compliant visible completion lookahead shell", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 9 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    await handle.establishProjection({ signal: new AbortController().signal });

    const refreshedIndexes = Array.from(
      { length: 10 },
      (_, offset) => 10 - offset,
    );
    harness.enqueue(
      "thread/turns/list",
      {
        data: refreshedIndexes.map(notLoadedTurn),
        nextCursor: "one-lookahead",
        backwardsCursor: "refreshed-head",
      },
      {
        data: [notLoadedTurn(0)],
        nextCursor: null,
        backwardsCursor: "one-lookahead-head",
      },
    );
    harness.enqueue(
      "thread/items/list",
      ...refreshedIndexes.map(paginatedItems),
      paginatedItems(0),
    );
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: nativeTurn(10),
    });
    await vi.waitFor(async () =>
      expect(
        (await handle.history({ limit: 10 })).orderedBackendTurnIds.at(-1),
      ).toBe(codexBackendTurnId("thread-1", "turn-10")),
    );
    expect(
      harness.calls.filter(({ method }) => method === "thread/items/list"),
    ).toHaveLength(21);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("bounds a stalled paginated completion refresh and requests replacement", async () => {
    vi.useFakeTimers();
    try {
      const harness = new RpcHarness();
      const handle = await attachIdle(harness);
      const initialIndexes = Array.from(
        { length: 10 },
        (_, index) => 9 - index,
      );
      harness.enqueue("thread/read", { thread: paginatedThread() });
      harness.enqueue(
        "thread/resume",
        paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
      );
      harness.enqueue(
        "thread/items/list",
        ...initialIndexes.map(paginatedItems),
      );
      const established = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const events: SequencedBackendEvent[] = [];
      const unsubscribe = established.subscribeFromNext((event) =>
        events.push(event),
      );
      let resolveRefresh!: (value: unknown) => void;
      harness.enqueue(
        "thread/turns/list",
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      harness.notify("turn/completed", {
        threadId: "thread-1",
        turn: nativeTurn(10),
      });

      await vi.advanceTimersByTimeAsync(1_001);
      await vi.waitFor(() =>
        expect(events.map(({ event }) => event.type)).toContain(
          "resnapshot_required",
        ),
      );
      const eventCountAfterTimeout = events.length;
      const callCountAfterTimeout = harness.calls.length;
      resolveRefresh({
        data: [],
        nextCursor: null,
        backwardsCursor: null,
      });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(events).toHaveLength(eventCountAfterTimeout);
      expect(harness.calls).toHaveLength(callCountAfterTimeout);
      expect((await handle.readCurrent()).snapshot).toEqual(
        established.snapshot,
      );
      unsubscribe();
      harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
      await handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reanchors paginated history after more than one live window of completed turns", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 9 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    await handle.establishProjection({ signal: new AbortController().signal });
    for (let index = 10; index <= 20; index += 1) {
      const refreshedIndexes = Array.from(
        { length: 10 },
        (_, offset) => index - offset,
      );
      harness.enqueue(
        "thread/turns/list",
        {
          data: refreshedIndexes.map(notLoadedTurn),
          nextCursor: `older-${index}`,
          backwardsCursor: `head-${index}`,
        },
        {
          data: [notLoadedTurn(index - 10)],
          nextCursor: `older-${index - 1}`,
          backwardsCursor: `older-head-${index}`,
        },
      );
      harness.enqueue(
        "thread/items/list",
        ...refreshedIndexes.map(paginatedItems),
        paginatedItems(index - 10),
      );
      harness.notify("turn/completed", {
        threadId: "thread-1",
        turn: nativeTurn(index),
      });
      await vi.waitFor(async () =>
        expect(
          (await handle.history({ limit: 10 })).orderedBackendTurnIds.at(-1),
        ).toBe(codexBackendTurnId("thread-1", `turn-${index}`)),
      );
    }
    const newest = await handle.history({ limit: 10 });
    expect(newest.orderedBackendTurnIds[0]).toBe(
      codexBackendTurnId("thread-1", "turn-11"),
    );
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(10)],
      nextCursor: "older-10",
      backwardsCursor: "turn-10-head",
    });
    harness.enqueue("thread/items/list", paginatedItems(10));
    const immediatelyOlder = await handle.history({
      limit: 1,
      cursor: newest.previousCursor,
    });
    expect(immediatelyOlder.orderedBackendTurnIds).toEqual([
      codexBackendTurnId("thread-1", "turn-10"),
    ]);
    expect(
      new Set([
        ...immediatelyOlder.orderedBackendTurnIds,
        ...newest.orderedBackendTurnIds,
      ]).size,
    ).toBe(11);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("serializes a held paginated refresh before the following turn start", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 9 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    await handle.establishProjection({ signal: new AbortController().signal });

    let releaseRefresh!: (value: unknown) => void;
    harness.enqueue(
      "thread/turns/list",
      () =>
        new Promise((resolve) => {
          releaseRefresh = resolve;
        }),
    );
    const refreshedIndexes = Array.from(
      { length: 10 },
      (_, offset) => 10 - offset,
    );
    harness.enqueue(
      "thread/items/list",
      ...refreshedIndexes.map(paginatedItems),
    );
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: nativeTurn(10),
    });
    const next = {
      ...nativeTurn(11),
      status: "inProgress" as const,
      completedAt: null,
    };
    harness.notify("turn/started", { threadId: "thread-1", turn: next });
    await vi.waitFor(() =>
      expect(
        harness.calls.some(({ method }) => method === "thread/turns/list"),
      ).toBe(true),
    );
    releaseRefresh({
      data: refreshedIndexes.map(notLoadedTurn),
      nextCursor: "older-10",
      backwardsCursor: "head-10",
    });
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: "older-0",
      backwardsCursor: "older-head-10",
    });
    harness.enqueue("thread/items/list", paginatedItems(0));
    await vi.waitFor(async () =>
      expect((await handle.readCurrent()).snapshot).toMatchObject({
        runState: "running",
        activeBackendTurnId: codexBackendTurnId("thread-1", "turn-11"),
      }),
    );

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not install a held paginated refresh after close and fails refresh request-locally", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 9 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    await handle.establishProjection({ signal: new AbortController().signal });
    let releaseRefresh!: (value: unknown) => void;
    harness.enqueue(
      "thread/turns/list",
      () =>
        new Promise((resolve) => {
          releaseRefresh = resolve;
        }),
    );
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: nativeTurn(10),
    });
    await vi.waitFor(() =>
      expect(
        harness.calls.some(({ method }) => method === "thread/turns/list"),
      ).toBe(true),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const closing = handle.close();
    releaseRefresh({
      data: [notLoadedTurn(10)],
      nextCursor: null,
      backwardsCursor: "head-10",
    });
    await expect(closing).resolves.toBeUndefined();

    const failedHarness = new RpcHarness();
    const failedHandle = await attachIdle(failedHarness);
    failedHarness.enqueue("thread/read", { thread: paginatedThread() });
    failedHarness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    failedHarness.enqueue(
      "thread/items/list",
      ...initialIndexes.map(paginatedItems),
    );
    await failedHandle.establishProjection({
      signal: new AbortController().signal,
    });
    failedHarness.enqueue(
      "thread/turns/list",
      new CodexRpcRemoteError({
        code: -32603,
        message: "refresh failed",
        generation: 1,
        method: "thread/turns/list",
      }),
    );
    failedHarness.notify("turn/completed", {
      threadId: "thread-1",
      turn: nativeTurn(10),
    });
    await vi.waitFor(
      async () =>
        await expect(failedHandle.history({ limit: 1 })).rejects.toMatchObject({
          backendCode: "codex_history_reconciliation_required",
        }),
    );
    failedHarness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await failedHandle.close();
  });

  it("requests an atomic replacement when terminal refresh discovers the next active head", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 9 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: SequencedBackendEvent[] = [];
    const unsubscribe = established.subscribeFromNext((event) =>
      events.push(event),
    );
    const activeShell = {
      ...notLoadedTurn(11),
      status: "inProgress" as const,
      completedAt: null,
    };
    const refreshed = [
      activeShell,
      notLoadedTurn(10),
      ...Array.from({ length: 8 }, (_, offset) => notLoadedTurn(9 - offset)),
    ];
    harness.enqueue("thread/turns/list", {
      data: refreshed,
      nextCursor: "older-active",
      backwardsCursor: "head-active",
    });
    harness.enqueue(
      "thread/items/list",
      paginatedItems(11),
      paginatedItems(10),
      ...Array.from({ length: 8 }, (_, offset) => paginatedItems(9 - offset)),
    );
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: nativeTurn(10),
    });
    await vi.waitFor(() =>
      expect(events.map(({ event }) => event.type)).toEqual([
        "resnapshot_required",
      ]),
    );
    const applicationProjector = new ConversationProjector({
      backendInstanceId: instance.id,
      bindingIdentity: binding().applicationThreadId,
    });
    applicationProjector.replace(
      established.snapshot,
      established.handleSequence,
    );
    expect(applicationProjector.apply(events[0]!)).toMatchObject({
      kind: "resnapshot_required",
      reason: "contradictory_state",
    });
    unsubscribe();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("keeps a completed paginated refresh idle despite an abandoned older turn", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 9 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: initialIndexes.map(notLoadedTurn) }),
    );
    harness.enqueue("thread/items/list", ...initialIndexes.map(paginatedItems));
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: SequencedBackendEvent[] = [];
    const unsubscribe = established.subscribeFromNext((event) =>
      events.push(event),
    );
    const abandoned = {
      ...notLoadedTurn(1),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const refreshed: CodexTurn[] = [
      ...Array.from({ length: 9 }, (_, offset) => notLoadedTurn(10 - offset)),
      abandoned,
    ];
    harness.enqueue(
      "thread/turns/list",
      {
        data: refreshed,
        nextCursor: "older-refresh",
        backwardsCursor: "refreshed-head",
      },
      {
        data: [notLoadedTurn(0)],
        nextCursor: null,
        backwardsCursor: "older-refresh-head",
      },
    );
    harness.enqueue(
      "thread/items/list",
      ...Array.from({ length: 9 }, (_, offset) => paginatedItems(10 - offset)),
      paginatedItems(1),
      paginatedItems(0),
    );

    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: nativeTurn(10),
    });
    await vi.waitFor(async () => {
      const snapshot = (await handle.readCurrent()).snapshot;
      expect(snapshot.runState).toBe("idle");
      expect(snapshot.activeBackendTurnId).toBeUndefined();
      expect(
        snapshot.turnsById[codexBackendTurnId("thread-1", "turn-1")],
      ).toMatchObject({ status: "interrupted", endedBy: "interrupted" });
      expect(snapshot.orderedBackendTurnIds.at(-1)).toBe(
        codexBackendTurnId("thread-1", "turn-10"),
      );
    });
    expect(events.map(({ event }) => event.type)).not.toContain(
      "resnapshot_required",
    );
    expect(abandoned.status).toBe("inProgress");

    unsubscribe();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not issue a cursor into a same-segment hidden-only tail", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 10 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        shells: initialIndexes.map(notLoadedTurn),
        nextCursor: "mixed-tail",
      }),
    );
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: "hidden-tail",
      backwardsCursor: "mixed-tail-head",
    });
    harness.enqueue(
      "thread/items/list",
      ...initialIndexes.map(paginatedItems),
      paginatedItems(0),
      paginatedItems(0),
      hiddenBoundaryItems(0),
    );
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0), hiddenBoundaryTurn(0)],
      nextCursor: null,
      backwardsCursor: "mixed-tail-head",
    });
    const older = await handle.history({
      limit: 2,
      cursor: established.history.previousCursor,
    });
    expect(older.orderedBackendTurnIds).toEqual([
      codexBackendTurnId("thread-1", "turn-0"),
    ]);
    expect(older.previousCursor).toBeUndefined();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("continues native paginated reads beyond the provider page maximum", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from(
      { length: 10 },
      (_, index) => 209 - index,
    );
    const firstIndexes = Array.from({ length: 100 }, (_, index) => 199 - index);
    const secondIndexes = Array.from({ length: 25 }, (_, index) => 99 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        shells: initialIndexes.map(notLoadedTurn),
        nextCursor: "page-a",
      }),
    );
    harness.enqueue(
      "thread/turns/list",
      {
        data: [notLoadedTurn(199)],
        nextCursor: "page-b",
        backwardsCursor: "page-a-head",
      },
      {
        data: firstIndexes.map(notLoadedTurn),
        nextCursor: "page-b",
        backwardsCursor: "page-a-head",
      },
      {
        data: secondIndexes.map(notLoadedTurn),
        nextCursor: null,
        backwardsCursor: "page-b-head",
      },
    );
    harness.enqueue(
      "thread/items/list",
      ...initialIndexes
        .concat([199], firstIndexes, secondIndexes)
        .map(paginatedItems),
    );

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const older = await handle.history({
      limit: 125,
      cursor: established.history.previousCursor,
    });
    expect(older.orderedBackendTurnIds).toHaveLength(125);
    expect(older.previousCursor).toBeUndefined();
    expect(
      harness.calls
        .filter(({ method }) => method === "thread/turns/list")
        .map(({ params }) => params),
    ).toEqual([
      {
        threadId: "thread-1",
        cursor: "page-a",
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
      {
        threadId: "thread-1",
        cursor: "page-a",
        limit: 100,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
      {
        threadId: "thread-1",
        cursor: "page-b",
        limit: 25,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
    ]);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("discards a cross-page hidden-boundary plateau while seeking one visible turn", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 20 - index);
    const hiddenIndexes = Array.from({ length: 120 }, (_, index) => index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        shells: initialIndexes.map(notLoadedTurn),
        nextCursor: "hidden-a",
      }),
    );
    harness.enqueue(
      "thread/turns/list",
      {
        data: [hiddenBoundaryTurn(0)],
        nextCursor: "hidden-b",
        backwardsCursor: "hidden-a-head",
      },
      {
        data: hiddenIndexes.slice(1, 101).map(hiddenBoundaryTurn),
        nextCursor: "hidden-c",
        backwardsCursor: "hidden-b-head",
      },
      {
        data: hiddenIndexes
          .slice(101)
          .map(hiddenBoundaryTurn)
          .concat(notLoadedTurn(0)),
        nextCursor: null,
        backwardsCursor: "hidden-c-head",
      },
      {
        data: [hiddenBoundaryTurn(0)],
        nextCursor: "hidden-b",
        backwardsCursor: "hidden-a-head",
      },
      {
        data: hiddenIndexes.slice(1, 101).map(hiddenBoundaryTurn),
        nextCursor: "hidden-c",
        backwardsCursor: "hidden-b-head",
      },
      {
        data: hiddenIndexes
          .slice(101)
          .map(hiddenBoundaryTurn)
          .concat(notLoadedTurn(0)),
        nextCursor: null,
        backwardsCursor: "hidden-c-head",
      },
    );
    harness.enqueue(
      "thread/items/list",
      ...initialIndexes.map(paginatedItems),
      ...hiddenIndexes.map(hiddenBoundaryItems),
      paginatedItems(0),
      ...hiddenIndexes.map(hiddenBoundaryItems),
      paginatedItems(0),
    );

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const older = await handle.history({
      limit: 1,
      cursor: established.history.previousCursor,
    });
    expect(older.orderedBackendTurnIds).toEqual([
      codexBackendTurnId("thread-1", "turn-0"),
    ]);
    expect(older.previousCursor).toBeUndefined();
    expect(
      harness.calls
        .filter(({ method }) => method === "thread/turns/list")
        .map(({ params }) => (params as { limit: number }).limit),
    ).toEqual([1, 100, 100, 1, 100, 100]);
    expect((await handle.readCurrent()).snapshot).toEqual(established.snapshot);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("loads cold paginated history through slow metadata, resume and multiple item reads", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const slowRead =
      (value: unknown) => (_params: unknown, activeHarness: RpcHarness) => {
        const options = activeHarness.requestOptions.at(-1)!.options;
        expect(options.timeoutMilliseconds).toBe(60_000);
        return new Promise((resolve, reject) => {
          const signal = options.signal;
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", aborted);
            resolve(value);
          }, 12_000);
          const aborted = () => {
            clearTimeout(timer);
            reject(signal!.reason);
          };
          signal?.addEventListener("abort", aborted, { once: true });
        });
      };
    harness.enqueue("thread/read", slowRead({ thread: paginatedThread() }));
    harness.enqueue(
      "thread/resume",
      slowRead(
        paginatedResumeResult({ shells: [notLoadedTurn(1), notLoadedTurn(0)] }),
      ),
    );
    harness.enqueue(
      "thread/items/list",
      slowRead(paginatedItems(1)),
      slowRead(paginatedItems(0)),
    );
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const establishing = handle.establishProjection({
        signal: controller.signal,
      });
      const completed = expect(establishing).resolves.toMatchObject({
        snapshot: {
          orderedBackendTurnIds: [
            codexBackendTurnId("thread-1", "turn-0"),
            codexBackendTurnId("thread-1", "turn-1"),
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(48_000);
      await completed;
      expect(
        harness.requestOptions.filter(
          ({ method }) =>
            method === "thread/read" ||
            method === "thread/resume" ||
            method === "thread/items/list",
        ),
      ).toHaveLength(4);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
      harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
      await handle.close();
    }
  });

  it.each(["legacy", "paginated"] as const)(
    "bounds cold %s establishment across sequential reads by one deadline",
    async (historyMode) => {
      const harness = new RpcHarness();
      const handle = await attachIdle(harness);
      let resumedSignal: AbortSignal | undefined;
      harness.enqueue("thread/read", () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ thread: nativeThread({ historyMode }) }), 40_000),
        ),
      );
      harness.enqueue(
        "thread/resume",
        (_params: unknown, activeHarness: RpcHarness) => {
          resumedSignal = activeHarness.requestOptions.at(-1)!.options.signal;
          return new Promise((_resolve, reject) =>
            resumedSignal!.addEventListener(
              "abort",
              () => reject(resumedSignal!.reason),
              { once: true },
            ),
          );
        },
      );
      vi.useFakeTimers();
      try {
        const caller = new AbortController();
        const establishing = handle.establishProjection({ signal: caller.signal });
        const rejected = expect(establishing).rejects.toMatchObject({
          category: "unavailable",
          backendCode: "codex_establishment_deadline",
          retryable: true,
        });
        await vi.advanceTimersByTimeAsync(59_999);
        expect(resumedSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(resumedSignal?.aborted).toBe(true);
        expect(caller.signal.aborted).toBe(false);
        expect(harness.calls.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
        expect(harness.calls.some(({ method }) => method === "thread/items/list")).toBe(false);
      } finally {
        vi.useRealTimers();
        await handle.close();
      }
    },
  );

  it("keeps one cold-load deadline across history stabilization retries", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    let secondReadSignal: AbortSignal | undefined;
    harness.enqueue(
      "thread/read",
      () => new Promise((resolve) =>
        setTimeout(() => resolve({ thread: nativeThread() }), 25_000),
      ),
      (_params: unknown, activeHarness: RpcHarness) => {
        secondReadSignal = activeHarness.requestOptions.at(-1)!.options.signal;
        return new Promise((_resolve, reject) =>
          secondReadSignal!.addEventListener(
            "abort", () => reject(secondReadSignal!.reason), { once: true },
          ),
        );
      },
    );
    harness.enqueue("thread/resume", () => new Promise((resolve) =>
      setTimeout(() => resolve(resumeResult()), 25_000),
    ));
    harness.after("thread/resume", (receiptSequence) => {
      harness.notify(
        "turn/completed",
        { threadId: "thread-1", turn: nativeTurn(1) },
        receiptSequence + 1,
      );
    });
    vi.useFakeTimers();
    try {
      const establishing = handle.establishProjection({ signal: new AbortController().signal });
      const rejected = expect(establishing).rejects.toMatchObject({
        backendCode: "codex_establishment_deadline",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(secondReadSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(secondReadSignal?.aborted).toBe(true);
      expect(harness.calls.filter(({ method }) => method === "thread/read")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
      await handle.close();
    }
  });

  it("cancels a slow cold metadata read without waiting for its larger deadline", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    let readSignal: AbortSignal | undefined;
    harness.enqueue(
      "thread/read",
      (_params: unknown, activeHarness: RpcHarness) => {
        const options = activeHarness.requestOptions.at(-1)!.options;
        expect(options.timeoutMilliseconds).toBe(60_000);
        readSignal = options.signal;
        if (!readSignal) throw new Error("missing_cold_load_signal");
        return new Promise((_resolve, reject) =>
          readSignal!.addEventListener(
            "abort",
            () => reject(readSignal!.reason),
            { once: true },
          ),
        );
      },
    );
    const controller = new AbortController();
    const establishing = handle.establishProjection({
      signal: controller.signal,
    });
    const rejected = expect(establishing).rejects.toBeDefined();
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    controller.abort(new Error("cancel_cold_load"));
    await rejected;
    expect(readSignal!.aborted).toBe(true);
    expect(harness.calls.some(({ method }) => method === "thread/resume")).toBe(
      false,
    );
    await handle.close();
  });

  it("bounds one paginated history acquisition by one deadline and keeps current state healthy", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 10 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        shells: initialIndexes.map(notLoadedTurn),
        nextCursor: "deadline-page",
      }),
    );
    harness.enqueue(
      "thread/items/list",
      ...initialIndexes.map(paginatedItems),
      paginatedItems(0),
    );
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "deadline-page-head",
    });
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    harness.enqueue(
      "thread/turns/list",
      (_params: unknown, activeHarness: RpcHarness) =>
        new Promise((_, reject) => {
          const signal = activeHarness.requestOptions.at(-1)?.options.signal;
          if (!signal) throw new Error("missing paginated deadline signal");
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    vi.useFakeTimers();
    try {
      const pending = handle.history({
        limit: 1,
        cursor: established.history.previousCursor,
      });
      let settled = false;
      void pending.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      const rejected = expect(pending).rejects.toMatchObject({
        category: "unavailable",
        retryable: true,
        backendCode: "codex_paginated_history_deadline",
      });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
    await expect(handle.readCurrent()).resolves.toMatchObject({
      snapshot: established.snapshot,
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("reads a detached paginated head without a full compatibility drain", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const indexes = Array.from({ length: 10 }, (_, index) => 9 - index);
    harness.enqueue("thread/read", {
      thread: paginatedThread({ status: { type: "notLoaded" } }),
    });
    harness.enqueue("thread/turns/list", {
      data: indexes.map(notLoadedTurn),
      nextCursor: "older",
      backwardsCursor: "turns-head",
    });
    harness.enqueue("thread/items/list", ...indexes.map(paginatedItems));

    const read = await target.read(attachInput());
    expect(read.snapshot.orderedBackendTurnIds).toEqual(
      indexes
        .slice()
        .reverse()
        .map((index) => codexBackendTurnId("thread-1", `turn-${index}`)),
    );
    expect(
      harness.calls.filter(({ method }) => method === "thread/read"),
    ).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
    ]);
    expect(
      harness.calls.find(({ method }) => method === "thread/turns/list"),
    ).toEqual({
      method: "thread/turns/list",
      params: {
        threadId: "thread-1",
        limit: 10,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
    });

    const activeHarness = new RpcHarness();
    activeHarness.enqueue("thread/read", {
      thread: paginatedThread({
        status: { type: "active", activeFlags: [] },
      }),
    });
    await expect(
      driver(activeHarness).read(attachInput()),
    ).rejects.toMatchObject({
      category: "unavailable",
      retryable: true,
      backendCode: "codex_paginated_detached_active",
    });
    expect(
      activeHarness.calls.some(
        ({ method }) =>
          method === "thread/turns/list" || method === "thread/items/list",
      ),
    ).toBe(false);

    const systemErrorHarness = new RpcHarness();
    systemErrorHarness.enqueue("thread/read", {
      thread: paginatedThread({ status: { type: "systemError" } }),
    });
    await expect(
      driver(systemErrorHarness).read(attachInput()),
    ).rejects.toMatchObject({
      category: "unavailable",
      retryable: true,
      backendCode: "codex_paginated_detached_system_error",
    });
    expect(
      systemErrorHarness.calls.some(
        ({ method }) =>
          method === "thread/turns/list" || method === "thread/items/list",
      ),
    ).toBe(false);

    const missingRouteHarness = new RpcHarness();
    missingRouteHarness.enqueue("thread/read", {
      thread: paginatedThread({ status: { type: "notLoaded" } }),
    });
    missingRouteHarness.enqueue(
      "thread/turns/list",
      new CodexRpcRemoteError({
        code: -32601,
        message: "Method not found",
        generation: 1,
        method: "thread/turns/list",
      }),
    );
    await expect(
      driver(missingRouteHarness).read(attachInput()),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      retryable: false,
      backendCode: "codex_remote_-32601",
    });

    const rolloverHarness = new RpcHarness();
    const storedArtifacts = createInMemoryOutputArtifactPublisher();
    const rolloverArtifacts: OutputArtifactPublisher = {
      findImage: (...args) => storedArtifacts.findImage(...args),
      publishImage: async (input) => {
        const published = await storedArtifacts.publishImage(input);
        rolloverHarness.lifecycle("ready", 2);
        return published;
      },
    };
    rolloverHarness.enqueue("thread/read", {
      thread: paginatedThread({ status: { type: "notLoaded" } }),
    });
    rolloverHarness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "turns-head",
    });
    rolloverHarness.enqueue("thread/items/list", {
      data: [{ turnId: "turn-0", item: nativeGeneratedImage() }],
      nextCursor: null,
      backwardsCursor: "item-head",
    });
    await expect(
      driverWithOutputArtifacts(rolloverHarness, rolloverArtifacts).read(
        attachInput(),
      ),
    ).rejects.toMatchObject({
      category: "unavailable",
      retryable: true,
      backendCode: "codex_history_reconciliation_required",
    });
  });

  it.each(["idle", "notLoaded"] as const)(
    "keeps a detached %s paginated head idle when durable turns were abandoned",
    async (status) => {
      const harness = new RpcHarness();
      const abandoned = [1, 0].map((index) => ({
        ...notLoadedTurn(index),
        status: "inProgress" as const,
        completedAt: null,
        durationMs: null,
      }));
      harness.enqueue("thread/read", {
        thread: paginatedThread({ status: { type: status } }),
      });
      harness.enqueue("thread/turns/list", {
        data: abandoned,
        nextCursor: null,
        backwardsCursor: "turns-head",
      });
      harness.enqueue(
        "thread/items/list",
        paginatedItems(1),
        paginatedItems(0),
      );

      const read = await driver(harness).read(attachInput());
      expect(read.snapshot).toMatchObject({ runState: "idle" });
      expect(read.snapshot.activeBackendTurnId).toBeUndefined();
      expect(
        read.snapshot.orderedBackendTurnIds.map(
          (turnId) => read.snapshot.turnsById[turnId]?.status,
        ),
      ).toEqual(["interrupted", "interrupted"]);
    },
  );

  it("keeps paginated actions and pending reconciliation paths off complete reads", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: [notLoadedTurn(0)] }),
    );
    harness.enqueue("thread/items/list", paginatedItems(0));
    await handle.establishProjection({ signal: new AbortController().signal });

    const rename = {
      applicationOperationId: "paginated-rename",
      action: "rename" as const,
      title: "Paginated title",
    };
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue("thread/name/set", {});
    await expect(handle.perform(rename)).resolves.toEqual({ accepted: true });
    harness.enqueue("thread/read", {
      thread: paginatedThread({ name: rename.title }),
    });
    await expect(handle.reconcileAction(rename)).resolves.toEqual({
      outcome: "accepted",
    });
    harness.enqueue("thread/read", { thread: paginatedThread() });
    await expect(
      handle.reconcileInterrupt({
        applicationOperationId: "paginated-interrupt-reconcile",
        expectedBackendTurnId: "not-active",
      }),
    ).resolves.toEqual({ outcome: "accepted" });
    expect(
      harness.calls.some(
        ({ method, params }) =>
          method === "thread/read" &&
          (params as { includeTurns?: boolean }).includeTurns === true,
      ),
    ).toBe(false);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();

    const driverHarness = new RpcHarness();
    driverHarness.enqueue("thread/read", { thread: paginatedThread() });
    driverHarness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "paginated-checkpoint-head",
    });
    driverHarness.enqueue("thread/items/list", paginatedItems(0));
    await expect(
      driver(driverHarness).resolveBranchCheckpoint({
        ...attachInput(),
        selection: { kind: "latest_completed" },
      }),
    ).resolves.toMatchObject({ kind: "conversation_leaf" });
    expect(
      driverHarness.calls.filter(({ method }) => method === "thread/read"),
    ).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
    ]);
  });

  it("does not complete-read mixed-mode fork discovery evidence", async () => {
    const harness = new RpcHarness();
    const parent = paginatedThread({ id: "mixed-mode-parent" });
    const child = nativeThread({
      id: "mixed-mode-child",
      forkedFromId: parent.id,
      threadSource: codexForkCreationMarker({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: parent.id,
        correlationAncestorThreadIds: [],
        applicationOperationId: "mixed-mode-fork",
      }),
    });
    harness.enqueue("thread/list", {
      data: [child],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.enqueue(
      "thread/read",
      { thread: { ...child, turns: [] } },
      { thread: parent },
    );

    await expect(
      driver(harness).discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        limit: 20,
      }),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_history_mode_changed",
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/read"),
    ).toEqual([
      {
        method: "thread/read",
        params: { threadId: child.id, includeTurns: false },
      },
      {
        method: "thread/read",
        params: { threadId: parent.id, includeTurns: false },
      },
    ]);
  });

  it("discovers paginated native fork evidence through targeted turn hydration", async () => {
    const harness = new RpcHarness();
    const parentId = "paginated-discovery-parent";
    const childId = "paginated-discovery-child";
    const applicationOperationId = "paginated-discovery-fork";
    const marker = codexForkCreationMarker({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: parentId,
      correlationAncestorThreadIds: [],
      applicationOperationId,
    });
    const parent = paginatedThread({ id: parentId });
    const child = paginatedThread({
      id: childId,
      forkedFromId: parentId,
      threadSource: marker,
    });
    const boundaryHookRunId = codexForkContextBoundaryHookRunId({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: childId,
      correlationAncestorThreadIds: [parentId],
      applicationOperationId,
    });
    harness.enqueue("thread/list", {
      data: [child],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.enqueue("thread/read", { thread: child }, { thread: parent });
    harness.enqueue(
      "thread/turns/list",
      {
        data: [notLoadedTurn(0)],
        nextCursor: null,
        backwardsCursor: "child-visible-head",
      },
      {
        data: [notLoadedTurn(0)],
        nextCursor: null,
        backwardsCursor: "parent-visible-head",
      },
      {
        data: [{ ...notLoadedTurn(1), id: "discovery-boundary-turn" }],
        nextCursor: null,
        backwardsCursor: "child-boundary-head",
      },
    );
    harness.enqueue("thread/items/list", paginatedItems(0), paginatedItems(0), {
      data: [
        {
          turnId: "discovery-boundary-turn",
          item: {
            type: "hookPrompt" as const,
            id: "discovery-boundary-item",
            fragments: [
              {
                text: USER_FORK_CONTEXT_BOUNDARY.content,
                hookRunId: boundaryHookRunId,
              },
            ],
          },
        },
      ],
      nextCursor: null,
      backwardsCursor: "child-boundary-item-head",
    });

    const page = await driver(harness).discover({
      scope,
      workspace,
      signal: new AbortController().signal,
      limit: 20,
    });
    expect(page.conversations[0]?.nativeAncestry).toMatchObject({
      parentBackendConversationId: parentId,
      sourceBackendTurnId: codexBackendTurnId(parentId, "turn-0"),
      applicationOperationId,
    });
    expect(
      harness.calls.some(
        ({ method, params }) =>
          method === "thread/read" &&
          (params as { includeTurns?: boolean }).includeTurns === true,
      ),
    ).toBe(false);
  });

  it("rejects a daemon rollover during native fork ancestry discovery", async () => {
    const harness = new RpcHarness();
    const parent = nativeThread({
      id: "rollover-parent",
      forkedFromId: "rollover-ancestor",
      turns: [],
    });
    const child = nativeThread({
      id: "rollover-child",
      forkedFromId: parent.id,
      threadSource: codexForkCreationMarker({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: parent.id,
        correlationAncestorThreadIds: [],
        applicationOperationId: "rollover-ancestry",
      }),
    });
    harness.enqueue("thread/list", {
      data: [child],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.enqueue(
      "thread/read",
      { thread: { ...child, turns: [] } },
      { thread: parent },
      () => {
        harness.lifecycle("ready", 2);
        return {
          thread: nativeThread({ id: "rollover-ancestor", turns: [] }),
        };
      },
    );

    await expect(
      driver(harness).discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        limit: 20,
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      backendCode: "codex_generation_changed",
    });
  });

  it("rejects a daemon rollover during complete legacy fork evidence", async () => {
    const harness = new RpcHarness();
    const parent = nativeThread({ id: "legacy-rollover-parent" });
    const child = nativeThread({
      id: "legacy-rollover-child",
      forkedFromId: parent.id,
      threadSource: codexForkCreationMarker({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: parent.id,
        correlationAncestorThreadIds: [],
        applicationOperationId: "legacy-rollover-evidence",
      }),
    });
    harness.enqueue("thread/list", {
      data: [child],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.enqueue(
      "thread/read",
      { thread: { ...child, turns: [] } },
      { thread: { ...parent, turns: [] } },
      () => {
        harness.lifecycle("ready", 2);
        return { thread: child };
      },
      { thread: parent },
    );

    await expect(
      driver(harness).discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        limit: 20,
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      backendCode: "codex_generation_changed",
    });
  });

  it("rejects a stale discovery page when missing fork evidence rolls the daemon generation", async () => {
    const harness = new RpcHarness();
    const parent = nativeThread({ id: "missing-rollover-parent" });
    const child = nativeThread({
      id: "missing-rollover-child",
      forkedFromId: parent.id,
      threadSource: codexForkCreationMarker({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: parent.id,
        correlationAncestorThreadIds: [],
        applicationOperationId: "missing-rollover-evidence",
      }),
    });
    harness.enqueue("thread/list", {
      data: [child],
      nextCursor: null,
      backwardsCursor: null,
    });
    harness.enqueue(
      "thread/read",
      () => {
        harness.lifecycle("ready", 2);
        throw new BackendError({
          category: "not_found",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "The fork child disappeared.",
          backendCode: "codex_thread_not_found",
        });
      },
      { thread: { ...parent, turns: [] } },
    );

    await expect(
      driver(harness).discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        limit: 20,
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      backendCode: "codex_generation_changed",
    });
  });

  it("bounds the entire native fork ancestry discovery by one deadline", async () => {
    vi.useFakeTimers();
    try {
      const harness = new RpcHarness();
      const parent = nativeThread({
        id: "deadline-parent",
        forkedFromId: "deadline-ancestor",
        turns: [],
      });
      const child = nativeThread({
        id: "deadline-child",
        forkedFromId: parent.id,
        threadSource: codexForkCreationMarker({
          toolProvenanceKey,
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          backendInstanceId: instance.id,
          nativeThreadId: parent.id,
          correlationAncestorThreadIds: [],
          applicationOperationId: "deadline-ancestry",
        }),
      });
      harness.enqueue("thread/list", {
        data: [child],
        nextCursor: null,
        backwardsCursor: null,
      });
      harness.enqueue(
        "thread/read",
        { thread: { ...child, turns: [] } },
        { thread: parent },
        () => new Promise(() => undefined),
      );
      const pending = driver(harness).discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        limit: 20,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        category: "unavailable",
        retryable: true,
        backendCode: "codex_discovery_deadline",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails malformed paginated filters and cursors request-locally", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const initialIndexes = Array.from({ length: 10 }, (_, index) => 10 - index);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        shells: initialIndexes.map(notLoadedTurn),
        nextCursor: "older-page",
      }),
    );
    harness.enqueue(
      "thread/items/list",
      ...initialIndexes.map(paginatedItems),
      paginatedItems(0),
    );
    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "older-head",
    });
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const cursor = established.history.previousCursor!;

    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: "older-page",
      backwardsCursor: "older-head",
    });
    await expect(handle.history({ limit: 1, cursor })).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_paginated_turn_cursor_no_progress",
    });
    await expect(
      handle.history({ limit: 1, cursor: "malformed" }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "codex_history_cursor_invalid",
    });
    expect((await handle.readCurrent()).snapshot).toEqual(established.snapshot);

    harness.enqueue("thread/turns/list", {
      data: [notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "older-head",
    });
    harness.enqueue("thread/items/list", {
      data: nativeTurn(0).items.map((item) => ({ turnId: "wrong-turn", item })),
      nextCursor: null,
      backwardsCursor: "item-head",
    });
    await expect(handle.history({ limit: 1, cursor })).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_paginated_item_filter_invalid",
    });
    expect((await handle.readCurrent()).snapshot).toEqual(established.snapshot);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not shrink away an oversized message when establishing the latest window", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const turns: ReturnType<typeof nativeThread>["turns"] =
      Array.from({ length: 12 }, (_, index) => nativeTurn(index));
    turns[2] = { ...turns[2]!, items: [{
      type: "agentMessage", id: "oversized-message",
      text: "\u0000".repeat(3 * 1024 * 1024), phase: null,
      memoryCitation: null, delivery: null, questions: null,
    }] };
    await expect(establish(harness, handle, nativeThread({ turns }))).rejects.toMatchObject({
      category: "incompatible_protocol", retryable: false,
      backendCode: "codex_message_payload_too_large",
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("shrinks a local page at whole-turn boundaries and fails only the single oversized turn", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const oversizedTurn = {
      ...nativeTurn(0),
      items: Array.from({ length: 1_000 }, (_, itemIndex) => ({
        type: "agentMessage" as const,
        id: `oversized-agent-message-${itemIndex}`,
        text: "x".repeat(20_000),
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      })),
    };
    const thread = nativeThread({
      turns: [
        oversizedTurn,
        ...Array.from({ length: 11 }, (_, index) => nativeTurn(index + 1)),
      ],
    });
    const established = await establish(harness, handle, thread);
    const callsAfterAttach = harness.calls.length;

    const adapted = await handle.history({
      limit: 10,
      cursor: established.history.previousCursor,
    });
    expect(adapted.orderedBackendTurnIds).toHaveLength(1);
    expect(adapted.previousCursor).toBeDefined();
    await expect(
      handle.history({ limit: 10, cursor: adapted.previousCursor }),
    ).rejects.toMatchObject({
      category: "unavailable",
      backendCode: "history_too_large",
    });
    expect(harness.calls).toHaveLength(callsAfterAttach);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  }, 30_000);

  it("maps a malformed older boundary request-locally and keeps the attached handle healthy", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const handle = await attachIdle(harness, target);
    const validHookRunId = codexForkContextBoundaryHookRunId({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "thread-1",
      correlationAncestorThreadIds: [],
      applicationOperationId: "malformed-older-boundary",
    });
    const malformedBoundary = {
      ...nativeTurn(0),
      items: [
        {
          type: "hookPrompt" as const,
          id: "malformed-older-boundary-item",
          fragments: [
            {
              text: USER_FORK_CONTEXT_BOUNDARY.content,
              hookRunId: `${validHookRunId.slice(0, -1)}${
                validHookRunId.endsWith("A") ? "B" : "A"
              }`,
            },
          ],
        },
      ],
    };
    const thread = nativeThread({
      turns: [
        malformedBoundary,
        nativeTurn(1),
        ...Array.from({ length: 10 }, (_, index) => nativeTurn(index + 2)),
      ],
    });
    const established = await establish(harness, handle, thread);
    const callsAfterAttach = harness.calls.length;

    await expect(
      handle.history({
        limit: 10,
        cursor: established.history.previousCursor,
      }),
    ).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_history_invalid",
    });
    await expect(handle.history({ limit: 1 })).resolves.toMatchObject({
      orderedBackendTurnIds: [expect.any(String)],
    });
    await expect(handle.readCurrent()).resolves.toMatchObject({
      snapshot: { runState: "idle" },
    });
    expect(harness.calls).toHaveLength(callsAfterAttach);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
    harness.enqueue(
      "thread/read",
      { thread: { ...thread, turns: [] } },
      { thread: { ...thread, turns: thread.turns.slice(0, 10) } },
    );
    await expect(target.read(attachInput())).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "codex_history_invalid",
    });
  });

  it("retains an older generated-image artifact reference without exposing native image data through history pagination", async () => {
    const harness = new RpcHarness();
    const outputArtifacts = createInMemoryOutputArtifactPublisher();
    const handle = await attachIdle(
      harness,
      driverWithOutputArtifacts(harness, outputArtifacts),
    );
    const oldestImageTurn = {
      ...nativeTurn(0),
      items: [nativeGeneratedImage()],
    };
    const thread = nativeThread({
      turns: [
        oldestImageTurn,
        ...Array.from({ length: 11 }, (_, index) => nativeTurn(index + 1)),
      ],
    });
    const established = await establish(harness, handle, thread);
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(
      Object.values(established.snapshot.itemsById).some(
        ({ semanticKind }) => semanticKind === "image",
      ),
    ).toBe(false);

    const older = await handle.history({
      limit: 10,
      cursor: established.history.previousCursor,
    });
    const olderImage = Object.values(older.itemsById).find(
      ({ semanticKind }) => semanticKind === "image",
    );
    expect(olderImage).toMatchObject({
      semanticKind: "image",
      image: {
        representation: "artifact",
        mimeType: "image/png",
        byteSize: Buffer.from(generatedPngBase64, "base64").byteLength,
      },
    });
    const newestPage = await handle.history({ limit: 12 });
    expect(
      Object.values(newestPage.itemsById).find(
        ({ semanticKind }) => semanticKind === "image",
      ),
    ).toEqual(olderImage);
    const serialized = JSON.stringify({ older, newestPage });
    expect(serialized).not.toContain(generatedPngBase64);
    expect(serialized).not.toContain("/provider/private/generated.png");

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("captures native accounting before presentation and registers visible turns", async () => {
    const observations: UsageObservation[] = [];
    const registerTurns = vi.fn();
    const sink: UsageSink = { open: vi.fn(() => ({ registerTurns,
      capture: (entries: readonly UsageObservation[]) => { observations.push(...entries); return true; }, reconcile: () => true, gap: vi.fn(), seal: vi.fn() })) };
    const harness = new RpcHarness();
    const target = driver(harness, connection, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, sink);
    const handle = await attachIdle(harness, target);
    await establish(harness, handle);
    for (const total of [100, 150]) {
      harness.notify("thread/tokenUsage/updated", {
        threadId: "thread-1", turnId: "turn-0", tokenUsage: {
          total: { inputTokens: total, outputTokens: 0, totalTokens: total,
            cachedInputTokens: 5, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
          last: { inputTokens: 20, outputTokens: 0, totalTokens: 20,
            cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
          modelContextWindow: 1000,
        },
      });
    }
    expect(registerTurns).toHaveBeenCalled();
    expect(observations).toHaveLength(2);
    expect(observations[1]!.facts).toContainEqual(expect.objectContaining({ kind: "turn_aggregate",
      sessionContribution: "none", tokens: expect.objectContaining({ input: "50" }) }));
    harness.notify("turn/completed", { threadId: "thread-1", turn: nativeTurn(0) });
    harness.notify("turn/started", { threadId: "thread-1", turn: { ...nativeTurn(1), status: "inProgress", completedAt: null } });
    for (const total of [170, 200]) harness.notify("thread/tokenUsage/updated", {
      threadId: "thread-1", turnId: "turn-1", tokenUsage: {
        total: { inputTokens: total, outputTokens: 0, totalTokens: total, cachedInputTokens: 5, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
        last: { inputTokens: 20, outputTokens: 0, totalTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
        modelContextWindow: 1000,
      },
    });
    await vi.waitFor(() => expect(observations).toHaveLength(4));
    expect(observations.slice(2).flatMap(observation => observation.facts.filter(fact => fact.kind === "turn_aggregate").map(fact => fact.tokens.input))).toEqual(["20", "30"]);
    expect(await handle.usage()).toEqual({ context: { usedTokens: 20, windowTokens: 1000, percent: 2 } });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it.each([false, true])("persists the first reply after idle resume replay without reopening (rate-limit replay=%s)", async rateLimitReplay => {
    const database = new Database(":memory:");
    // Minimal application authority plus the actual production usage migrations.
    database.exec(`
      CREATE TABLE application_threads(tenant_id TEXT, owner_principal_id TEXT, id TEXT, backend_instance_id TEXT, environment_id TEXT, workspace_id TEXT, PRIMARY KEY(tenant_id,owner_principal_id,id));
      CREATE TABLE agent_backend_instances(tenant_id TEXT,id TEXT,kind TEXT);
      CREATE TABLE conversation_bindings(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,backend_instance_id TEXT,execution_environment_id TEXT,backend_conversation_id TEXT,connection_profile_id TEXT);
      CREATE TABLE claude_usage_ledgers(tenant_id TEXT,owner_principal_id TEXT,application_thread_id TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,request_count INTEGER,updated_at INTEGER);
      INSERT INTO application_threads VALUES('tenant-1','principal-1','application-profile-1','codex-1','environment-1','workspace-1');
      INSERT INTO agent_backend_instances VALUES('tenant-1','codex-1','codex_app_server');
      INSERT INTO conversation_bindings VALUES('tenant-1','principal-1','application-profile-1','codex-1','environment-1','thread-1','profile-1');
    `);
    database.exec(durableUsageAccountingMigration.sql);
    database.exec(usageGapSessionScopeMigration.sql);
    const usage = new UsageService(database);
    const harness = new RpcHarness();
    const target = driver(harness, connection, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, usage);
    const handle = await attachIdle(harness, target);
    const counts = (input: number, output: number) => ({ inputTokens: input, outputTokens: output,
      totalTokens: input + output, cachedInputTokens: 5, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 });
    const notify = (turnId: string, input: number, output: number) => harness.notify("thread/tokenUsage/updated", {
      threadId: "thread-1", turnId, tokenUsage: { total: counts(input, output), last: counts(20, 3), modelContextWindow: 1000 },
    });
    try {
      // The pinned app-server replies to resume, then replays restored counters.
      // The transport delivers replay BEFORE the awaiting resume continuation.
      harness.after("thread/resume", () => notify("turn-0", 100, 10));
      const established = await establish(harness, handle);
      const projector = new ConversationProjector({ backendInstanceId: instance.id, bindingIdentity: binding().applicationThreadId });
      projector.replace(established.snapshot, established.handleSequence);
      established.subscribeFromNext(event => {
        const projected = projector.apply(event);
        if (projected.kind === "events") for (const changed of projected.events) {
          if (changed.type === "turn_upsert") usage.registerVisibleTurns(scope, binding().applicationThreadId, [changed.turn]);
        }
      });
      harness.notify("turn/started", { threadId: "thread-1", turn: { ...nativeTurn(1), status: "inProgress", completedAt: null } });
      if (rateLimitReplay) notify("turn-1", 100, 10); // Rate-limit update repeats the old call under the new turn ID.
      notify("turn-1", 120, 13);
      notify("turn-1", 120, 13); // Repeated notifications must not double charge.
      harness.notify("turn/completed", { threadId: "thread-1", turn: nativeTurn(1) });
      await vi.waitFor(() => expect(database.prepare("SELECT count(*) AS n FROM usage_observations").get()).toEqual({ n: rateLimitReplay ? 4 : 3 }));
      const turnId = applicationTurnIdForBackendTurn({ backendInstanceId: instance.id,
        sourceApplicationThreadId: binding().applicationThreadId, backendTurnId: codexBackendTurnId("thread-1", "turn-1") });
      const report = usage.read(scope, binding().applicationThreadId, turnId);
      expect(usage.availability(scope, binding().applicationThreadId, [turnId]).turns).toEqual([{ turnId, available: true }]);
      expect(report.summary.metrics.input.value).toBe("20");
      expect(report.summary.metrics.output.value).toBe("3");
      expect(report.summary.reasons).not.toContain("unknown_baseline");
      expect(usage.read(scope, binding().applicationThreadId).summary.metrics.input.value).toBe("120");
      expect(usage.read(scope, binding().applicationThreadId).summary.reasons).not.toContain("capture_failed");
    } finally {
      harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
      await handle.close();
      database.close();
    }
  });

  it("keeps warm paginated resume without native replay unallocated rather than charging earlier turns", async () => {
    const observations: UsageObservation[] = [];
    const sink: UsageSink = { open: () => ({ registerTurns: () => undefined,
      capture: entries => { observations.push(...entries); return true; }, reconcile: () => true,
      gap: () => undefined, seal: () => undefined }) };
    const harness = new RpcHarness();
    const handle = await attachIdle(harness, driver(harness, connection, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sink));
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue("thread/resume", paginatedResumeResult({ shells: [notLoadedTurn(0)] }));
    harness.enqueue("thread/items/list", paginatedItems(0));
    try {
      await handle.establishProjection({ signal: new AbortController().signal });
      expect(harness.calls.find(call => call.method === "thread/resume")?.params).toMatchObject({ excludeTurns: true });
      // Pinned warm metadata-only resume skips token replay even with initialTurnsPage.
      harness.notify("turn/started", { threadId: "thread-1", turn: { ...nativeTurn(1), status: "inProgress", completedAt: null } });
      const counts = { inputTokens: 120, outputTokens: 13, totalTokens: 133,
        cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 };
      harness.notify("thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1",
        tokenUsage: { total: counts, last: counts, modelContextWindow: 1000 } });
      harness.notify("turn/completed", { threadId: "thread-1", turn: nativeTurn(1) });
      await vi.waitFor(() => expect(observations).toHaveLength(1));
      expect(observations[0]!.facts[0]!.tokens.input).toBe("120");
      expect(observations.flatMap(observation => observation.facts).filter(fact => fact.turn !== null)).toEqual([]);
    } finally {
      harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
      await handle.close();
    }
  });

  it("retains token usage replayed immediately after the resume response", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", resumeResult());
    harness.after("thread/resume", () => {
      harness.notify("thread/tokenUsage/updated", {
        threadId: "thread-1",
        turnId: "turn-0",
        tokenUsage: {
          total: {
            totalTokens: 30,
            inputTokens: 20,
            cachedInputTokens: 5,
            cacheWriteInputTokens: 2,
            outputTokens: 10,
            reasoningOutputTokens: 3,
          },
          last: {
            totalTokens: 12,
            inputTokens: 8,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 4,
            reasoningOutputTokens: 1,
          },
          modelContextWindow: 100,
        },
      });
    });
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);
    const expectedUsage = {
      context: { usedTokens: 12, windowTokens: 100, percent: 12 },
    };
    expect((await handle.readCurrent()).usage).toMatchObject(expectedUsage);
    expect(await handle.usage()).toMatchObject(expectedUsage);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("publishes thread warnings as notices without invalidating the projection", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));

    harness.notify("warning", {
      threadId: "thread-1",
      message: "Code mode is unavailable.",
    });

    expect(events).toEqual([
      {
        type: "notice",
        notice: {
          id: expect.stringMatching(/^codex-warning:1:/u),
          tone: "warning",
          message: { text: "Code mode is unavailable." },
          createdAt: "2026-07-31T00:00:00.000Z",
        },
      },
    ]);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("routes authentication recovery to one thread as provider-private transient notices", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const threadA = nativeThread({ id: "thread-a", sessionId: "session-a" });
    const threadB = nativeThread({ id: "thread-b", sessionId: "session-b" });
    const handleA = (await target.attach(
      attachInput(connection, threadA.id),
    )) as CodexConversationHandle;
    const handleB = (await target.attach(
      attachInput(connection, threadB.id),
    )) as CodexConversationHandle;
    const establishedA = await establish(harness, handleA, threadA);
    const establishedB = await establish(harness, handleB, threadB);
    const snapshotBeforeRecovery = await handleA.readCurrent();
    const eventsA: BackendConversationEvent[] = [];
    const eventsB: BackendConversationEvent[] = [];
    establishedA.subscribeFromNext(({ event }) => eventsA.push(event));
    establishedB.subscribeFromNext(({ event }) => eventsB.push(event));

    harness.notify("modelProvider/authRecoveryStarted", {
      threadId: threadA.id,
      turnId: "turn-private",
      provider: "private-provider-id",
      message: "private provider recovery detail",
    });
    harness.notify("modelProvider/authRecoveryCompleted", {
      threadId: threadA.id,
      turnId: "turn-private",
      provider: "private-provider-id",
      message: "private provider recovery completion detail",
    });

    expect(eventsA).toEqual([
      {
        type: "notice",
        notice: {
          id: expect.stringMatching(/^codex-auth-recovery:1:/u),
          tone: "warning",
          message: {
            text: "Codex is recovering model provider authentication.",
          },
          createdAt: "2026-07-31T00:00:00.000Z",
        },
      },
      {
        type: "notice",
        notice: {
          id: expect.stringMatching(/^codex-auth-recovery:1:/u),
          tone: "success",
          message: {
            text: "Codex recovered model provider authentication.",
          },
          createdAt: "2026-07-31T00:00:00.000Z",
        },
      },
    ]);
    expect(eventsB).toEqual([]);
    const serializedEvents = JSON.stringify(eventsA);
    expect(serializedEvents).not.toContain("private-provider-id");
    expect(serializedEvents).not.toContain("turn-private");
    expect(serializedEvents).not.toContain("private provider recovery detail");
    expect(serializedEvents).not.toContain(
      "private provider recovery completion detail",
    );
    expect(await handleA.readCurrent()).toEqual(snapshotBeforeRecovery);
    expect(harness.facade.lifecycleSnapshot()).toEqual({
      state: "ready",
      generation: 1,
    });
    expect(harness.retirements).toEqual([]);

    harness.enqueue(
      "thread/unsubscribe",
      { status: "unsubscribed" },
      { status: "unsubscribed" },
    );
    await handleA.close();
    await handleB.close();
  });

  it("recovers only the matching thread from an attributable undecodable notification", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const threadA = nativeThread({ id: "thread-a", sessionId: "session-a" });
    const threadB = nativeThread({ id: "thread-b", sessionId: "session-b" });

    const handleA = (await target.attach(
      attachInput(connection, threadA.id),
    )) as CodexConversationHandle;
    const handleB = (await target.attach(
      attachInput(connection, threadB.id),
    )) as CodexConversationHandle;
    const establishedA = await establish(harness, handleA, threadA);
    const establishedB = await establish(harness, handleB, threadB);
    const eventsA: BackendConversationEvent[] = [];
    const eventsB: BackendConversationEvent[] = [];
    establishedA.subscribeFromNext(({ event }) => eventsA.push(event));
    establishedB.subscribeFromNext(({ event }) => eventsB.push(event));

    harness.notifyUndecodable("turn/started", threadA.id);
    expect(eventsA).toEqual([
      { type: "resnapshot_required", reason: "contradictory_state" },
    ]);
    expect(eventsB).toEqual([]);
    expect(harness.facade.lifecycleSnapshot()).toEqual({
      state: "ready",
      generation: 1,
    });
    expect(harness.retirements).toEqual([]);

    harness.notify("warning", {
      threadId: threadB.id,
      message: "Thread B remains connected.",
    });
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toEqual([
      expect.objectContaining({
        type: "notice",
        notice: expect.objectContaining({
          message: { text: "Thread B remains connected." },
        }),
      }),
    ]);

    harness.enqueue(
      "thread/unsubscribe",
      { status: "unsubscribed" },
      { status: "unsubscribed" },
    );
    await handleA.close();
    await handleB.close();
  });

  it("adopts a settings notification that follows resume without retrying stable history", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const settings = executionSettingsProvider({
      observeEffective,
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        settings,
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", resumeResult());
    harness.after("thread/resume", () => {
      harness.notify("mcpServer/startupStatus/updated", {
        threadId: "thread-1",
      });
      harness.notify("thread/settings/updated", {
        threadId: "thread-1",
        threadSettings: {
          cwd: workspace.canonicalPath,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          activePermissionProfile: null,
          model: "gpt-5.6",
          modelProvider: "openai",
          serviceTier: "default",
          effort: "high",
          summary: null,
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.6",
              reasoning_effort: "high",
              developer_instructions: null,
            },
          },
          multiAgentMode: "explicitRequestOnly",
          personality: null,
        },
      });
      harness.notify(
        "thread/goal/cleared",
        decodeCodexServerNotificationParams("thread/goal/cleared", {
          threadId: "thread-1",
        }),
      );
    });

    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(observeEffective).toHaveBeenLastCalledWith(
      scope,
      expect.objectContaining({
        confirmationGeneration: 1,
        initializeDesired: {
          model: "gpt-5.6",
          reasoningEffort: "high",
          serviceTier: "standard",
          sandboxMode: "danger-full-access",
          networkAccess: "enabled",
          approvalPolicy: "never",
          approvalReviewer: "user",
        },
        settings: expect.objectContaining({
          model: "gpt-5.6",
          reasoningEffort: "high",
          serviceTier: "standard",
          serviceTierClassification: "recognized",
          sandboxMode: "danger-full-access",
          policyObservation: "complete",
        }),
      }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("uses an imported YOLO tuple unchanged for the first Sedes turn", async () => {
    const harness = new RpcHarness();
    let desired: CodexExecutionSettingsTuple | undefined;
    const settings = executionSettingsProvider({
      observeEffective: (_scope, observation) => {
        if (observation.initializeDesired) {
          desired = observation.initializeDesired;
        }
      },
      freezeOperationSnapshot: () => {
        if (!desired) throw new Error("expected_imported_desired_settings");
        return { settings: desired };
      },
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        settings,
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", {
      ...resumeResult(),
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
    });
    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(desired).toEqual({
      model: "gpt-5.6",
      reasoningEffort: "low",
      serviceTier: "standard",
      sandboxMode: "danger-full-access",
      networkAccess: "enabled",
      approvalPolicy: "never",
      approvalReviewer: "user",
    });

    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    await handle.submit({
      applicationOperationId: "imported-yolo-submit",
      source: { kind: "user" },
      mutationId: "imported-yolo-mutation",
      reconciliationToken: "imported-yolo-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "continue",
    });

    expect(
      harness.calls.find(({ method }) => method === "turn/start")?.params,
    ).toMatchObject({
      model: "gpt-5.6",
      effort: "low",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("replays a durable Fast tier after resume when the loaded thread enables fast_mode", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const fastSettings = executionSettingsTuple({ serviceTier: "fast" });
    const settings = executionSettingsProvider({
      desiredSettings: () => fastSettings,
      freezeOperationSnapshot: () => ({ settings: fastSettings }),
      observeEffective,
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        settings,
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", resumeResult());
    harness.enqueue("experimentalFeature/list", {
      data: [
        {
          name: "fast_mode",
          stage: "stable",
          displayName: "Fast mode",
          description: null,
          announcement: null,
          enabled: true,
          defaultEnabled: false,
        },
      ],
      nextCursor: null,
    });
    harness.enqueue("thread/settings/update", {});
    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(
      harness.calls.find(({ method }) => method === "experimentalFeature/list")
        ?.params,
    ).toEqual({ threadId: "thread-1", limit: 1_000 });
    expect(
      harness.calls.find(({ method }) => method === "thread/resume")?.params,
    ).toMatchObject({ serviceTier: "priority" });
    expect(
      harness.calls.find(({ method }) => method === "thread/settings/update")
        ?.params,
    ).toEqual({ threadId: "thread-1", serviceTier: "priority" });
    expect(observeEffective).toHaveBeenLastCalledWith(
      scope,
      expect.objectContaining({
        initializeDesired: expect.objectContaining({ serviceTier: "fast" }),
        settings: expect.objectContaining({ serviceTier: "standard" }),
      }),
    );
    harness.enqueue("model/list", {
      data: [
        nativeModel({
          serviceTiers: [{ id: "priority", name: "Fast", description: "Fast" }],
        }),
      ],
      nextCursor: null,
    });
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    await handle.submit({
      applicationOperationId: "fast-submit",
      source: { kind: "user" },
      mutationId: "fast-submit-mutation",
      reconciliationToken: "fast-submit-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "continue quickly",
    });
    expect(
      harness.calls.find(({ method }) => method === "turn/start")?.params,
    ).toMatchObject({ serviceTier: "priority" });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not replay a durable Fast tier when the loaded thread disables fast_mode", async () => {
    const harness = new RpcHarness();
    const syncSettings = vi.fn(async () => undefined);
    const managedTui = {
      registry: { subscribeState: () => () => undefined },
      syncSettings,
      releaseRuntime: vi.fn(async () => undefined),
    } as unknown as CodexManagedTuiController;
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider({
          desiredSettings: () =>
            executionSettingsTuple({ serviceTier: "fast" }),
        }),
        undefined,
        managedTui,
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", resumeResult());
    harness.enqueue("experimentalFeature/list", {
      data: [
        {
          name: "fast_mode",
          stage: "stable",
          displayName: "Fast mode",
          description: null,
          announcement: null,
          enabled: false,
          defaultEnabled: true,
        },
      ],
      nextCursor: null,
    });

    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(
      harness.calls.some(({ method }) => method === "thread/settings/update"),
    ).toBe(false);
    expect(syncSettings).toHaveBeenCalledWith(
      scope,
      "application-profile-1",
      expect.objectContaining({ serviceTier: "standard" }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("converges app-server and managed-TUI tiers when recovery discovers fast_mode disabled", async () => {
    const harness = new RpcHarness();
    let desired = executionSettingsTuple({ serviceTier: "fast" });
    const resolveFastModeDisabled = vi.fn(() => {
      if (resolveFastModeDisabled.mock.calls.length === 1) {
        throw new Error("simulated settings revision conflict");
      }
      desired = { ...desired, serviceTier: "standard" };
      return desired;
    });
    const syncSettings = vi.fn(async () => {
      if (syncSettings.mock.calls.length === 1) {
        desired = { ...desired, reasoningEffort: "high" };
      }
    });
    const managedTui = {
      registry: { subscribeState: () => () => undefined },
      syncSettings,
      releaseRuntime: vi.fn(async () => undefined),
    } as unknown as CodexManagedTuiController;
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider({
          desiredSettings: () => desired,
          resolveFastModeDisabled,
        }),
        undefined,
        managedTui,
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", {
      ...resumeResult(),
      serviceTier: "priority",
    });

    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    harness.enqueue("experimentalFeature/list", {
      data: [
        {
          name: "fast_mode",
          stage: "stable",
          displayName: "Fast mode",
          description: null,
          announcement: null,
          enabled: false,
          defaultEnabled: true,
        },
      ],
      nextCursor: null,
    });
    harness.enqueue("thread/settings/update", {});

    await vi.waitFor(
      () =>
        expect(
          harness.calls.find(
            ({ method }) => method === "thread/settings/update",
          )?.params,
        ).toEqual({ threadId: "thread-1", serviceTier: "default" }),
      { timeout: 1_000 },
    );
    expect(syncSettings).toHaveBeenCalledWith(
      scope,
      "application-profile-1",
      expect.objectContaining({ serviceTier: "standard" }),
    );
    expect(resolveFastModeDisabled).toHaveBeenCalledTimes(2);
    expect(syncSettings).toHaveBeenLastCalledWith(
      scope,
      "application-profile-1",
      expect.objectContaining({
        serviceTier: "standard",
        reasoningEffort: "high",
      }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not write Standard after disabled recovery is superseded by a newer Fast selection", async () => {
    const harness = new RpcHarness();
    let desired = executionSettingsTuple({ serviceTier: "fast" });
    let resolveStandardSync!: () => void;
    const standardSync = new Promise<void>((resolve) => {
      resolveStandardSync = resolve;
    });
    const syncSettings = vi
      .fn()
      .mockImplementationOnce(async () => await standardSync)
      .mockResolvedValue(undefined);
    const managedTui = {
      registry: { subscribeState: () => () => undefined },
      syncSettings,
      releaseRuntime: vi.fn(async () => undefined),
    } as unknown as CodexManagedTuiController;
    const fastModeSessions = new CodexFastModeSessionRegistry({
      recoveryDelaysMilliseconds: [0],
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider({
          desiredSettings: () => desired,
          resolveFastModeDisabled: () => {
            desired = { ...desired, serviceTier: "standard" };
            return desired;
          },
        }),
        undefined,
        managedTui,
        unavailableCodexAgentToolCliEnvironmentProvider,
        fastModeSessions,
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", {
      ...resumeResult(),
      serviceTier: "priority",
    });
    harness.enqueue(
      "experimentalFeature/list",
      () => {
        throw new Error("temporary feature discovery failure");
      },
      {
        data: [
          {
            name: "fast_mode",
            stage: "stable",
            displayName: "Fast mode",
            description: null,
            announcement: null,
            enabled: false,
            defaultEnabled: true,
          },
        ],
        nextCursor: null,
      },
    );

    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(syncSettings).toHaveBeenCalledTimes(1));

    desired = { ...desired, serviceTier: "fast" };
    harness.enqueue("experimentalFeature/list", {
      data: [
        {
          name: "fast_mode",
          stage: "stable",
          displayName: "Fast mode",
          description: null,
          announcement: null,
          enabled: true,
          defaultEnabled: false,
        },
      ],
      nextCursor: null,
    });
    await fastModeSessions.refresh({
      scope,
      applicationThreadId: "application-profile-1",
      nativeThreadId: "thread-1",
      connectionGeneration: 1,
      client: harness.facade,
    });
    harness.enqueue("thread/settings/update", {});
    resolveStandardSync();

    await vi.waitFor(() =>
      expect(
        harness.calls.find(
          ({ method, params }) =>
            method === "thread/settings/update" &&
            (params as { serviceTier?: string }).serviceTier === "priority",
        )?.params,
      ).toEqual({ threadId: "thread-1", serviceTier: "priority" }),
    );
    expect(
      harness.calls.some(
        ({ method, params }) =>
          method === "thread/settings/update" &&
          (params as { serviceTier?: string }).serviceTier === "default",
      ),
    ).toBe(false);
    expect(syncSettings).toHaveBeenLastCalledWith(
      scope,
      "application-profile-1",
      expect.objectContaining({ serviceTier: "fast" }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not write Standard when the handle closes during disabled recovery", async () => {
    const harness = new RpcHarness();
    let desired = executionSettingsTuple({ serviceTier: "fast" });
    let resolveSync!: () => void;
    const sync = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });
    const syncSettings = vi.fn(async () => await sync);
    const managedTui = {
      registry: { subscribeState: () => () => undefined },
      syncSettings,
      releaseRuntime: vi.fn(async () => undefined),
    } as unknown as CodexManagedTuiController;
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider({
          desiredSettings: () => desired,
          resolveFastModeDisabled: () => {
            desired = { ...desired, serviceTier: "standard" };
            return desired;
          },
        }),
        undefined,
        managedTui,
        unavailableCodexAgentToolCliEnvironmentProvider,
        new CodexFastModeSessionRegistry({
          recoveryDelaysMilliseconds: [0],
        }),
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", {
      ...resumeResult(),
      serviceTier: "priority",
    });
    harness.enqueue(
      "experimentalFeature/list",
      () => {
        throw new Error("temporary feature discovery failure");
      },
      {
        data: [
          {
            name: "fast_mode",
            stage: "stable",
            displayName: "Fast mode",
            description: null,
            announcement: null,
            enabled: false,
            defaultEnabled: true,
          },
        ],
        nextCursor: null,
      },
    );

    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(syncSettings).toHaveBeenCalledTimes(1));
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const close = handle.close();
    resolveSync();
    await close;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(
      harness.calls.some(({ method }) => method === "thread/settings/update"),
    ).toBe(false);
  });

  it("does not import an unset native service tier as Standard", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider({
          desiredSettings: () => null,
          observeEffective,
        }),
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", {
      ...resumeResult(),
      serviceTier: null,
    });
    harness.enqueue("experimentalFeature/list", {
      data: [
        {
          name: "fast_mode",
          stage: "stable",
          displayName: "Fast mode",
          description: null,
          announcement: null,
          enabled: true,
          defaultEnabled: false,
        },
      ],
      nextCursor: null,
    });

    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    const observation = observeEffective.mock.calls.at(-1)?.[1];
    expect(observation).toMatchObject({
      settings: {
        serviceTier: null,
        serviceTierClassification: "external_custom",
      },
    });
    expect(observation).not.toHaveProperty("initializeDesired");
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("uses the catalog default for imported desired reasoning while preserving an observed null effort", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider({
          observeEffective,
        }),
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", {
      ...resumeResult(),
      reasoningEffort: null,
    });

    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(observeEffective).toHaveBeenLastCalledWith(
      scope,
      expect.objectContaining({
        initializeDesired: expect.objectContaining({
          model: "gpt-5.6",
          reasoningEffort: "low",
        }),
        settings: expect.objectContaining({
          model: "gpt-5.6",
          reasoningEffort: null,
        }),
      }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("drains a settings notification that arrives during post-resume Goal refresh", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const settings = executionSettingsProvider({
      observeEffective,
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        settings,
        new CodexGoalSessionRegistry(),
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", resumeResult());
    harness.enqueue(
      "thread/goal/get",
      (_params: unknown, activeHarness: RpcHarness) => {
        activeHarness.notify("thread/settings/updated", {
          threadId: "thread-1",
          threadSettings: {
            cwd: workspace.canonicalPath,
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "dangerFullAccess" },
            activePermissionProfile: null,
            model: "gpt-5.6",
            modelProvider: "openai",
            serviceTier: "default",
            effort: "high",
            summary: null,
            collaborationMode: {
              mode: "default",
              settings: {
                model: "gpt-5.6",
                reasoning_effort: "high",
                developer_instructions: null,
              },
            },
            multiAgentMode: "explicitRequestOnly",
            personality: null,
          },
        });
        return { goal: null };
      },
    );

    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(observeEffective).toHaveBeenLastCalledWith(
      scope,
      expect.objectContaining({
        confirmationGeneration: 1,
        settings: expect.objectContaining({
          model: "gpt-5.6",
          reasoningEffort: "high",
          serviceTier: "standard",
          serviceTierClassification: "recognized",
          sandboxMode: "danger-full-access",
          policyObservation: "complete",
        }),
      }),
    );
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("retries history when a turn completes during post-resume Goal refresh", async () => {
    const harness = new RpcHarness();
    const activeTurn = {
      ...nativeTurn(0),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [activeTurn],
    });
    const completedThread = nativeThread();
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider(),
        new CodexGoalSessionRegistry(),
      ),
    );
    harness.enqueue(
      "thread/read",
      { thread: activeThread },
      { thread: completedThread },
    );
    harness.enqueue(
      "thread/resume",
      resumeResult(activeThread),
      resumeResult(completedThread),
    );
    harness.enqueue(
      "thread/goal/get",
      (_params: unknown, activeHarness: RpcHarness) => {
        activeHarness.notify("turn/completed", {
          threadId: "thread-1",
          turn: nativeTurn(0),
        });
        return { goal: null };
      },
      { goal: null },
    );

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(established.snapshot.runState).toBe("idle");
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(2);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("rereads Goal when a Goal notification races establishment refresh", async () => {
    const harness = new RpcHarness();
    const goalSessions = new CodexGoalSessionRegistry();
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider(),
        goalSessions,
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", resumeResult());
    harness.enqueue(
      "thread/goal/get",
      (_params: unknown, activeHarness: RpcHarness) => {
        activeHarness.notify(
          "thread/goal/cleared",
          decodeCodexServerNotificationParams("thread/goal/cleared", {
            threadId: "thread-1",
          }),
        );
        return {
          goal: {
            threadId: "thread-1",
            objective: "Stale goal",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        };
      },
      { goal: null },
    );

    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(
      harness.calls.filter(({ method }) => method === "thread/goal/get"),
    ).toHaveLength(2);
    expect(
      goalSessions.projection(scope, binding().applicationThreadId)?.state,
    ).toEqual({ state: "unset" });
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("fails closed on unattested and nested-invalid Goal notifications", async () => {
    const harness = new RpcHarness();
    const goalSessions = new CodexGoalSessionRegistry();
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider(),
        goalSessions,
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", resumeResult());
    harness.enqueue("thread/goal/get", { goal: null });

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const goalReadsBefore = harness.calls.filter(
      ({ method }) => method === "thread/goal/get",
    ).length;

    harness.notify(
      "thread/goal/cleared",
      {
        threadId: "thread-1",
      },
      undefined,
      false,
    );
    harness.notify(
      "thread/goal/updated",
      decodeCodexServerNotificationParams("thread/goal/updated", {
        threadId: "thread-1",
        turnId: null,
        goal: {
          threadId: "thread-1",
          objective: "Reject malformed Goal notification",
          status: "active",
          tokenBudget: null,
          tokensUsed: Number.MAX_SAFE_INTEGER + 1,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    );

    expect(
      harness.calls.filter(({ method }) => method === "thread/goal/get"),
    ).toHaveLength(goalReadsBefore);
    expect(
      events.filter(
        (event) =>
          event.type === "resnapshot_required" &&
          event.reason === "contradictory_state",
      ),
    ).toHaveLength(2);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("retries imported desired initialization without resnapshotting when the live catalog changes", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const settings = executionSettingsProvider({
      observeEffective,
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        settings,
      ),
    );
    const unresolvedResume = {
      ...resumeResult(),
      model: "unavailable-model",
    };
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", unresolvedResume);
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    harness.enqueue("model/list", {
      data: [
        nativeModel({
          id: "unavailable-model",
          model: "unavailable-model",
          displayName: "Now available",
        }),
      ],
      nextCursor: null,
    });
    const notification = {
      threadId: "thread-1",
      threadSettings: {
        cwd: workspace.canonicalPath,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        model: "unavailable-model",
        modelProvider: "openai",
        serviceTier: "default",
        effort: "low",
        summary: null,
        collaborationMode: {
          mode: "default",
          settings: {
            model: "unavailable-model",
            reasoning_effort: "low",
            developer_instructions: null,
          },
        },
        multiAgentMode: "explicitRequestOnly",
        personality: null,
      },
    };

    harness.notify("thread/settings/updated", notification);

    await vi.waitFor(() =>
      expect(observeEffective).toHaveBeenLastCalledWith(
        scope,
        expect.objectContaining({
          initializeDesired: expect.objectContaining({
            model: "unavailable-model",
            reasoningEffort: "low",
          }),
        }),
      ),
    );

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not confirm imported desired settings after the daemon generation becomes unavailable", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider({
          observeEffective,
        }),
      ),
    );
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", {
      ...resumeResult(),
      model: "later-model",
    });
    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let catalogStarted!: () => void;
    const catalogStartedPromise = new Promise<void>((resolve) => {
      catalogStarted = resolve;
    });
    harness.enqueue("model/list", async () => {
      catalogStarted();
      await catalogGate;
      return {
        data: [
          nativeModel({
            id: "later-model",
            model: "later-model",
            displayName: "Later model",
          }),
        ],
        nextCursor: null,
      };
    });
    harness.notify("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: {
        cwd: workspace.canonicalPath,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        model: "later-model",
        modelProvider: "openai",
        serviceTier: "default",
        effort: "low",
        summary: null,
        collaborationMode: {
          mode: "default",
          settings: {
            model: "later-model",
            reasoning_effort: "low",
            developer_instructions: null,
          },
        },
        multiAgentMode: "explicitRequestOnly",
        personality: null,
      },
    });
    await catalogStartedPromise;
    observeEffective.mockClear();
    harness.lifecycle("unavailable", 1);
    releaseCatalog();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(observeEffective).not.toHaveBeenCalled();
    await handle.close();
  });

  it("confirms complete current-generation settings notifications and invalidates them on generation loss", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const markEffectiveUnknown = vi.fn();
    const settings = executionSettingsProvider({
      observeEffective,
      markEffectiveUnknown,
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        settings,
      ),
    );
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    observeEffective.mockClear();

    harness.notify("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: {
        cwd: workspace.canonicalPath,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
        activePermissionProfile: null,
        model: "gpt-5.6",
        modelProvider: "openai",
        serviceTier: "default",
        effort: "high",
        summary: null,
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.6",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
        multiAgentMode: "explicitRequestOnly",
        personality: null,
      },
    });
    expect(observeEffective).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        confirmationGeneration: 1,
        settings: {
          model: "gpt-5.6",
          reasoningEffort: "high",
          serviceTier: "standard",
          serviceTierClassification: "recognized",
          sandboxMode: "danger-full-access",
          sandboxClassification: "recognized",
          networkAccess: "enabled",
          networkClassification: "recognized",
          approvalPolicy: "never",
          approvalPolicyClassification: "recognized",
          approvalReviewer: "user",
          approvalReviewerClassification: "recognized",
          policyObservation: "complete",
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "capabilities_changed" }),
    );

    harness.lifecycle("unavailable", 1);
    expect(markEffectiveUnknown).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        applicationThreadId: binding().applicationThreadId,
      }),
    );
    await handle.close();
  });

  it("publishes capabilities_changed when a managed TUI exits asynchronously", async () => {
    const harness = new RpcHarness();
    const managedTui = new CodexManagedTuiController({
      client: harness.facade,
    });
    const output = new PassThrough();
    let resolveClosed!: (status: {
      exitCode: number | null;
      signal: string | null;
    }) => void;
    const closed = new Promise<{
      exitCode: number | null;
      signal: string | null;
    }>((resolve) => {
      resolveClosed = resolve;
    });
    const launcher = {
      launch: async () => ({
        output,
        closed,
        write: async () => undefined,
        resize: async () => undefined,
        close: async () => undefined,
      }),
    };
    managedTui.configure(launcher);
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider(),
        undefined,
        managedTui,
      ),
    );
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    await managedTui.registry.start(
      {
        scope,
        applicationThreadId: binding().applicationThreadId,
        backendInstanceId: binding().backendInstanceId,
        connectionProfileId: binding().connectionProfileId,
        executionEnvironmentId: binding().executionEnvironmentId,
        backendConversationId: binding().backendConversationId,
        workspaceId: workspace.summary.id,
        canonicalWorkspacePath: workspace.canonicalPath,
        opaqueBindingDetail: attachInput().opaqueBindingDetail,
        runtimeLeaseId: "test-runtime-lease",
        appServerGeneration: 1,
      },
      launcher,
    );
    events.length = 0;

    output.end();
    resolveClosed({ exitCode: 17, signal: null });

    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "capabilities_changed",
        }),
      ),
    );
    expect(
      managedTui.presentation(scope, binding().applicationThreadId).state,
    ).toMatchObject({
      lifecycle: "exited",
      resourceGeneration: 1,
      streamAvailable: false,
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
    await managedTui.close();
  });

  it("records a detailed custom workspace resume as a complete observation", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider({ observeEffective }),
      ),
    );
    const thread = nativeThread();
    harness.enqueue("thread/read", { thread });
    harness.enqueue("thread/resume", {
      ...resumeResult(thread),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: ["/tmp"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });

    await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(observeEffective).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        confirmationGeneration: 1,
        settings: {
          model: "gpt-5.6",
          reasoningEffort: "low",
          serviceTier: "standard",
          serviceTierClassification: "recognized",
          sandboxMode: null,
          sandboxClassification: "external_custom",
          networkAccess: "disabled",
          networkClassification: "recognized",
          approvalPolicy: "on-request",
          approvalPolicyClassification: "recognized",
          approvalReviewer: "user",
          approvalReviewerClassification: "recognized",
          policyObservation: "complete",
        },
      }),
    );
    expect(observeEffective.mock.lastCall?.[1]).not.toHaveProperty(
      "initializeDesired",
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("emits context compaction started and completed with matching normalized identity", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const startedTurn = {
      ...nativeTurn(1),
      items: [],
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const compactionItem = {
      type: "contextCompaction" as const,
      id: "compaction-1",
    };

    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: startedTurn,
    });
    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: compactionItem,
      startedAtMs: 1_700_000_002_000,
    });
    await vi.waitFor(() => {
      expect(
        events.find(
          (event) =>
            event.type === "item_started" &&
            event.item.semanticKind === "compaction",
        ),
      ).toMatchObject({
        type: "item_started",
        item: { semanticKind: "compaction", status: "streaming" },
      });
    });

    harness.notify("item/completed", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: compactionItem,
      completedAtMs: 1_700_000_002_500,
    });
    await vi.waitFor(() => {
      expect(
        events.find(
          (event) =>
            event.type === "item_completed" &&
            event.item.semanticKind === "compaction",
        ),
      ).toMatchObject({
        type: "item_completed",
        item: { semanticKind: "compaction", status: "completed" },
      });
    });

    const compactionEvents = events.flatMap((event) =>
      (event.type === "item_started" || event.type === "item_completed") &&
      event.item.semanticKind === "compaction"
        ? [{ type: event.type, backendItemId: event.item.backendItemId }]
        : [],
    );
    expect(compactionEvents.map(({ type }) => type)).toEqual([
      "item_started",
      "item_completed",
    ]);
    expect(compactionEvents[0]?.backendItemId).toBe(
      compactionEvents[1]?.backendItemId,
    );

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("projects stable turn, item, and delta notifications without duplicate authoritative state", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: unknown[] = [];
    established.subscribeFromNext((event) => events.push(event));
    const startedTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
    };
    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: startedTurn,
    });
    const agentItem = {
      type: "agentMessage" as const,
      id: "agent-1",
      text: "hello",
      phase: "commentary" as const,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: agentItem,
      startedAtMs: 1_700_000_002_000,
    });
    const streamingSeed = (await handle.readCurrent()).snapshot;
    const streamingSeedSequence = (events.at(-1) as SequencedBackendEvent)
      .handleSequence;
    const streamingUpdateOffset = events.length;
    harness.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      delta: " world",
    });
    harness.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { ...agentItem, text: "authoritative final" },
      completedAtMs: 1_700_000_002_500,
    });
    harness.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        ...startedTurn,
        status: "completed",
        completedAt: 1_700_000_003,
        items: [
          ...startedTurn.items,
          { ...agentItem, text: "authoritative final" },
        ],
      },
    });

    await vi.waitFor(async () => {
      const snapshot = (await handle.readCurrent()).snapshot;
      const turn = snapshot.turnsById[snapshot.orderedBackendTurnIds.at(-1)!]!;
      expect(turn.status).toBe("completed");
    });
    const current = (await handle.readCurrent()).snapshot;
    expect(current.runState).toBe("idle");
    expect(current.orderedBackendTurnIds).toHaveLength(2);
    expect(new Set(current.orderedBackendTurnIds).size).toBe(2);
    expect(Object.values(current.itemsById)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semanticKind: "assistant_message",
          markdown: expect.objectContaining({ text: "authoritative final" }),
        }),
      ]),
    );
    const projectedEvents = events.map(
      (entry) =>
        (
          entry as {
            readonly event: BackendConversationEvent;
          }
        ).event,
    );
    const assistantLifecycle = projectedEvents.filter(
      (event) =>
        (event.type === "item_started" ||
          event.type === "item_updated" ||
          event.type === "item_completed") &&
        event.item.semanticKind === "assistant_message",
    );
    expect(assistantLifecycle).toEqual([
      expect.objectContaining({
        type: "item_started",
        item: expect.objectContaining({
          status: "streaming",
          markdown: expect.objectContaining({ text: "hello" }),
        }),
      }),
      expect.objectContaining({
        type: "item_updated",
        item: expect.objectContaining({
          status: "streaming",
          markdown: expect.objectContaining({ text: "hello world" }),
        }),
      }),
      expect.objectContaining({
        type: "item_completed",
        item: expect.objectContaining({
          status: "completed",
          markdown: expect.objectContaining({ text: "authoritative final" }),
        }),
      }),
    ]);
    expect(projectedEvents).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );
    const applicationProjector = new ConversationProjector({
      backendInstanceId: instance.id,
      bindingIdentity: binding().applicationThreadId,
    });
    applicationProjector.replace(streamingSeed, streamingSeedSequence);
    for (const event of events.slice(
      streamingUpdateOffset,
    ) as SequencedBackendEvent[]) {
      expect(
        applicationProjector.apply(event),
        `application projector rejected ${event.event.type}`,
      ).not.toMatchObject({ kind: "resnapshot_required" });
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "run_state_changed",
            state: "running",
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({ type: "item_updated" }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "turn_completed",
            turn: expect.objectContaining({ status: "completed" }),
          }),
        }),
        expect.objectContaining({
          event: { type: "run_state_changed", state: "idle" },
        }),
      ]),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("expands a live Codex image generation into one ordered tool and artifact image without resnapshotting", async () => {
    const harness = new RpcHarness();
    const stored = createInMemoryOutputArtifactPublisher();
    let releasePublication!: () => void;
    let publicationStarted!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publicationStart = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const outputArtifacts: OutputArtifactPublisher = {
      findImage: vi.fn(stored.findImage),
      publishImage: vi.fn(async (input) => {
        publicationStarted();
        await publicationGate;
        return await stored.publishImage(input);
      }),
    };
    const handle = await attachIdle(
      harness,
      driverWithOutputArtifacts(harness, outputArtifacts),
    );
    const established = await establish(harness, handle);
    const events: SequencedBackendEvent[] = [];
    established.subscribeFromNext((event) => events.push(event));
    const startedTurn = {
      ...nativeTurn(1),
      items: [],
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const startedImage = nativeGeneratedImage({
      status: "in_progress",
      revisedPrompt: null,
      result: "",
      transparentBackground: null,
      savedPath: null,
    });
    // Codex can complete with valid in-band bytes even when its convenience
    // copy could not be saved. Sedes must not depend on savedPath.
    const completedImage = nativeGeneratedImage({ savedPath: null });

    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: startedTurn,
    });
    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: startedImage,
      startedAtMs: 1_700_000_002_000,
    });
    await vi.waitFor(async () => {
      const snapshot = (await handle.readCurrent()).snapshot;
      expect(
        Object.values(snapshot.itemsById).some(
          (item) =>
            item.semanticKind === "tool" &&
            item.toolName.text === "image_generation",
        ),
      ).toBe(true);
    });
    const streaming = (await handle.readCurrent()).snapshot;
    const streamingTurn =
      streaming.turnsById[streaming.orderedBackendTurnIds.at(-1)!]!;
    expect(
      streamingTurn.orderedBackendItemIds.map(
        (itemId) => streaming.itemsById[itemId]!.semanticKind,
      ),
    ).toEqual(["tool"]);

    harness.notify("item/completed", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: completedImage,
      completedAtMs: 1_700_000_002_500,
    });
    harness.notify("item/completed", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: completedImage,
      completedAtMs: 1_700_000_002_500,
    });
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        ...startedTurn,
        status: "completed",
        completedAt: 1_700_000_003,
        items: [completedImage],
        itemsView: "summary",
      },
    });

    await publicationStart;
    const whilePublishing = (await handle.readCurrent()).snapshot;
    const whilePublishingTurn =
      whilePublishing.turnsById[whilePublishing.orderedBackendTurnIds.at(-1)!]!;
    expect(
      whilePublishingTurn.orderedBackendItemIds.map(
        (itemId) => whilePublishing.itemsById[itemId]!.semanticKind,
      ),
    ).toEqual(["tool"]);
    expect(
      events.some(
        ({ event }) =>
          (event.type === "item_started" ||
            event.type === "item_updated" ||
            event.type === "item_completed") &&
          event.item.semanticKind === "image",
      ),
    ).toBe(false);
    releasePublication();
    await vi.waitFor(async () => {
      const snapshot = (await handle.readCurrent()).snapshot;
      expect(
        Object.values(snapshot.itemsById).some(
          (item) =>
            item.semanticKind === "image" &&
            item.image.representation === "artifact",
        ),
      ).toBe(true);
    });

    const completed = (await handle.readCurrent()).snapshot;
    const completedTurn =
      completed.turnsById[completed.orderedBackendTurnIds.at(-1)!]!;
    expect(
      completedTurn.orderedBackendItemIds.map(
        (itemId) => completed.itemsById[itemId]!.semanticKind,
      ),
    ).toEqual(["tool", "image"]);
    const image = completed.itemsById[completedTurn.orderedBackendItemIds[1]!]!;
    expect(image).toMatchObject({
      semanticKind: "image",
      status: "completed",
      image: {
        representation: "artifact",
        mimeType: "image/png",
        byteSize: Buffer.from(generatedPngBase64, "base64").byteLength,
      },
    });
    expect(outputArtifacts.publishImage).toHaveBeenCalledTimes(1);
    expect(
      events.flatMap(({ event }) => {
        if (
          event.type !== "item_started" &&
          event.type !== "item_updated" &&
          event.type !== "item_completed"
        ) {
          return [];
        }
        if (
          event.item.semanticKind === "tool" &&
          event.item.toolName.text === "image_generation"
        ) {
          return [`${event.type}:tool`];
        }
        return event.item.semanticKind === "image"
          ? [`${event.type}:image`]
          : [];
      }),
    ).toEqual([
      "item_started:tool",
      "item_completed:tool",
      "item_completed:image",
    ]);
    expect(
      events.filter(
        ({ event }) =>
          (event.type === "item_started" ||
            event.type === "item_updated" ||
            event.type === "item_completed") &&
          event.item.semanticKind === "image",
      ),
    ).toHaveLength(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: "resnapshot_required" }),
      }),
    );
    const serialized = JSON.stringify({ events, streaming, completed });
    expect(serialized).not.toContain(generatedPngBase64);
    expect(serialized).not.toContain("/provider/private/generated.png");

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("keeps failed and completed-without-data Codex generations truthful without publishing an artifact", async () => {
    const fixtures = [
      {
        label: "failed",
        native: nativeGeneratedImage({
          status: "failed",
          revisedPrompt: null,
          result: "",
          transparentBackground: null,
          savedPath: null,
        }),
        expectedToolStatus: "failed",
        expectedImage: undefined,
      },
      {
        label: "completed without data",
        native: nativeGeneratedImage({
          result: "",
          savedPath: null,
        }),
        expectedToolStatus: "completed",
        expectedImage: {
          representation: "omitted",
          reason: "invalid_data",
        },
      },
    ] as const;

    for (const fixture of fixtures) {
      const harness = new RpcHarness();
      const stored = createInMemoryOutputArtifactPublisher();
      const outputArtifacts: OutputArtifactPublisher = {
        findImage: vi.fn(stored.findImage),
        publishImage: vi.fn(stored.publishImage),
      };
      const handle = await attachIdle(
        harness,
        driverWithOutputArtifacts(harness, outputArtifacts),
      );
      const established = await establish(
        harness,
        handle,
        nativeThread({
          turns: [
            {
              ...nativeTurn(0),
              items: [fixture.native],
            },
          ],
        }),
      );
      const projected = Object.values(established.snapshot.itemsById);
      expect(
        projected.find(({ semanticKind }) => semanticKind === "tool"),
        fixture.label,
      ).toMatchObject({
        semanticKind: "tool",
        status: fixture.expectedToolStatus,
      });
      const image = projected.find(
        ({ semanticKind }) => semanticKind === "image",
      );
      if (fixture.expectedImage) {
        expect(image, fixture.label).toMatchObject({
          semanticKind: "image",
          image: fixture.expectedImage,
        });
      } else {
        expect(image, fixture.label).toBeUndefined();
      }
      expect(outputArtifacts.publishImage).not.toHaveBeenCalled();
      expect(JSON.stringify(established)).not.toContain(
        "/provider/private/generated.png",
      );

      harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
      await handle.close();
    }
  });

  it("keeps a completed Codex generation readable when artifact storage fails", async () => {
    const harness = new RpcHarness();
    const outputArtifacts: OutputArtifactPublisher = {
      findImage: vi.fn(() => undefined),
      publishImage: vi.fn(() => {
        throw new Error("private-output-storage-failure");
      }),
    };
    const handle = await attachIdle(
      harness,
      driverWithOutputArtifacts(harness, outputArtifacts),
    );
    const established = await establish(
      harness,
      handle,
      nativeThread({
        turns: [
          {
            ...nativeTurn(0),
            items: [nativeGeneratedImage({ savedPath: null })],
          },
        ],
      }),
    );
    expect(Object.values(established.snapshot.itemsById)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semanticKind: "tool",
          status: "completed",
        }),
        expect.objectContaining({
          semanticKind: "image",
          image: expect.objectContaining({
            representation: "omitted",
            reason: "unavailable",
          }),
        }),
      ]),
    );
    expect(outputArtifacts.publishImage).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(established);
    expect(serialized).not.toContain(generatedPngBase64);
    expect(serialized).not.toContain("private-output-storage-failure");

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("settles a cancelled image generation from terminal turn evidence when no item completion arrives", async () => {
    const harness = new RpcHarness();
    const stored = createInMemoryOutputArtifactPublisher();
    const outputArtifacts: OutputArtifactPublisher = {
      findImage: vi.fn(stored.findImage),
      publishImage: vi.fn(stored.publishImage),
    };
    const handle = await attachIdle(
      harness,
      driverWithOutputArtifacts(harness, outputArtifacts),
    );
    const established = await establish(harness, handle);
    const events: SequencedBackendEvent[] = [];
    established.subscribeFromNext((event) => events.push(event));
    const startedTurn = {
      ...nativeTurn(1),
      items: [],
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const startedImage = nativeGeneratedImage({
      status: "in_progress",
      revisedPrompt: null,
      result: "",
      transparentBackground: null,
      savedPath: null,
    });
    const cancelledImage = nativeGeneratedImage({
      status: "failed",
      revisedPrompt: null,
      result: "",
      transparentBackground: null,
      savedPath: null,
    });
    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: startedTurn,
    });
    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: startedImage,
      startedAtMs: 1_700_000_002_000,
    });
    // The pinned extension can terminate a cancelled generation through the
    // turn without a separate item/completed notification.
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        ...startedTurn,
        status: "interrupted",
        completedAt: 1_700_000_003,
        items: [cancelledImage],
        itemsView: "full",
      },
    });

    await vi.waitFor(async () => {
      const snapshot = (await handle.readCurrent()).snapshot;
      const turn = snapshot.turnsById[snapshot.orderedBackendTurnIds.at(-1)!]!;
      expect(turn.status).toBe("interrupted");
    });
    const current = (await handle.readCurrent()).snapshot;
    const currentTurn =
      current.turnsById[current.orderedBackendTurnIds.at(-1)!]!;
    expect(currentTurn.status).toBe("interrupted");
    expect(
      currentTurn.orderedBackendItemIds.map(
        (itemId) => current.itemsById[itemId]!.semanticKind,
      ),
    ).toEqual(["tool"]);
    expect(
      current.itemsById[currentTurn.orderedBackendItemIds[0]!],
    ).toMatchObject({
      semanticKind: "tool",
      status: "failed",
    });
    expect(outputArtifacts.publishImage).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: "resnapshot_required" }),
      }),
    );
    expect(
      events.flatMap(({ event }) => {
        if (event.type !== "item_started" && event.type !== "item_completed") {
          return [];
        }
        return event.item.semanticKind === "tool" &&
          event.item.toolName.text === "image_generation"
          ? [`${event.type}:${event.item.status}`]
          : [];
      }),
    ).toEqual(["item_started:streaming", "item_completed:failed"]);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("revalidates durable Codex image publications across replacement and fresh-handle replay", async () => {
    const harness = new RpcHarness();
    const stored = createInMemoryOutputArtifactPublisher();
    const outputArtifacts: OutputArtifactPublisher = {
      findImage: vi.fn(stored.findImage),
      publishImage: vi.fn(stored.publishImage),
    };
    const completedTurn = {
      ...nativeTurn(0),
      items: [nativeGeneratedImage()],
    };
    const originalThread = nativeThread({ turns: [completedTurn] });
    const handle = await attachIdle(
      harness,
      driverWithOutputArtifacts(harness, outputArtifacts),
    );
    const first = await establish(harness, handle, originalThread);
    const firstImage = Object.values(first.snapshot.itemsById).find(
      ({ semanticKind }) => semanticKind === "image",
    );
    expect(firstImage).toMatchObject({
      semanticKind: "image",
      image: { representation: "artifact" },
    });

    const exactReplacement = await establish(harness, handle, originalThread);
    const replacementImage = Object.values(
      exactReplacement.snapshot.itemsById,
    ).find(({ semanticKind }) => semanticKind === "image");
    expect(replacementImage).toEqual(firstImage);

    const changedThread = nativeThread({
      turns: [
        {
          ...completedTurn,
          items: [
            nativeGeneratedImage({
              result: changedGeneratedPngBase64,
              revisedPrompt: "A changed red square",
              savedPath: "/provider/private/changed.png",
            }),
          ],
        },
      ],
    });
    const changedReplacement = await establish(harness, handle, changedThread);
    expect(
      Object.values(changedReplacement.snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "image",
      ),
    ).toMatchObject({
      semanticKind: "image",
      image: { representation: "omitted", reason: "unavailable" },
    });
    expect(JSON.stringify(changedReplacement)).not.toContain(
      changedGeneratedPngBase64,
    );
    expect(JSON.stringify(changedReplacement)).not.toContain(
      "/provider/private/changed.png",
    );

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();

    const freshHandle = await attachIdle(
      harness,
      driverWithOutputArtifacts(harness, outputArtifacts),
    );
    const replayed = await establish(harness, freshHandle, originalThread);
    expect(
      Object.values(replayed.snapshot.itemsById).find(
        ({ semanticKind }) => semanticKind === "image",
      ),
    ).toEqual(firstImage);
    expect(JSON.stringify(replayed)).not.toContain(generatedPngBase64);
    expect(JSON.stringify(replayed)).not.toContain(
      "/provider/private/generated.png",
    );

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await freshHandle.close();
  });

  it("pins the exact golden event stream for a scripted turn lifecycle", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));

    const startedTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
    };
    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: startedTurn,
    });
    const agentItem = {
      type: "agentMessage" as const,
      id: "agent-1",
      text: "",
      phase: "commentary" as const,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: agentItem,
      startedAtMs: 1_700_000_002_000,
    });
    harness.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      delta: "hello",
    });
    harness.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      delta: " world",
    });
    harness.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { ...agentItem, text: "hello world" },
      completedAtMs: 1_700_000_002_500,
    });
    harness.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        ...startedTurn,
        status: "completed",
        completedAt: 1_700_000_003,
        items: [...startedTurn.items, { ...agentItem, text: "hello world" }],
      },
    });

    // Golden pin: the exact normalized event stream for the terminal
    // sequence. Projection-cost work must never reorder, drop, or
    // duplicate these.
    expect(events.map((event) => event.type)).toEqual([
      "turn_started",
      "item_completed",
      "run_state_changed",
      "item_started",
      "turn_updated",
      "item_updated",
      "item_completed",
      "turn_completed",
      "run_state_changed",
    ]);
    const assistantEvents = events.filter(
      (event) =>
        (event.type === "item_started" ||
          event.type === "item_updated" ||
          event.type === "item_completed") &&
        event.item.semanticKind === "assistant_message",
    );
    expect(
      assistantEvents.map((event) =>
        event.type === "item_started" ||
        event.type === "item_updated" ||
        event.type === "item_completed"
          ? {
              type: event.type,
              status: event.item.status,
              text:
                "markdown" in event.item ? event.item.markdown.text : undefined,
            }
          : undefined,
      ),
    ).toEqual([
      { type: "item_started", status: "streaming", text: "" },
      { type: "item_updated", status: "streaming", text: "hello" },
      { type: "item_completed", status: "completed", text: "hello world" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run_state_changed",
      state: "idle",
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("merges an identity-only turn/start receipt over earlier user-item notifications", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const startedTurn = {
      ...nativeTurn(1),
      items: [],
      itemsView: "notLoaded" as const,
      status: "inProgress" as const,
      completedAt: null,
    };
    harness.enqueue(
      "turn/start",
      (params: unknown, activeHarness: RpcHarness) => {
        const clientUserMessageId = (
          params as { readonly clientUserMessageId: string }
        ).clientUserMessageId;
        activeHarness.notify("turn/started", {
          threadId: "thread-1",
          turn: startedTurn,
        });
        activeHarness.notify("item/started", {
          threadId: "thread-1",
          turnId: startedTurn.id,
          item: {
            type: "userMessage",
            id: "own-user-live",
            clientId: clientUserMessageId,
            content: [{ type: "text", text: "hello", text_elements: [] }],
          },
          startedAtMs: 1_700_000_002_000,
        });
        return { turn: startedTurn };
      },
    );

    const submitted = await handle.submit({
      applicationOperationId: "racing-submit-operation",
      source: { kind: "user" },
      mutationId: "racing-submit-mutation",
      reconciliationToken: "racing-submit-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "hello",
    });

    const current = (await handle.readCurrent()).snapshot;
    const userItems = Object.values(current.itemsById).filter(
      ({ semanticKind }) => semanticKind === "user_message",
    );
    expect(userItems).toHaveLength(2);
    expect(userItems.at(-1)).toMatchObject({
      content: [{ kind: "text", text: { text: "hello" } }],
    });
    expect(events.filter(({ type }) => type === "turn_started")).toHaveLength(
      1,
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );
    expect(submitted.backendTurnId).toBe(current.activeBackendTurnId);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("fences a submit receipt before a later paginated projection failure", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    harness.enqueue("thread/read", { thread: paginatedThread() });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: [notLoadedTurn(0)] }),
    );
    harness.enqueue("thread/items/list", paginatedItems(0));
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    harness.enqueue("turn/start", {
      turn: {
        ...notLoadedTurn(1),
        status: "inProgress",
        completedAt: null,
        durationMs: null,
      },
    });
    harness.after("turn/start", () => {
      // A transient lifecycle invalidation can clear paginated authority after
      // Codex accepted the turn but before the receipt-derived turn installs.
      harness.lifecycle("reconciling");
      harness.lifecycle("ready");
    });

    const submission = {
      applicationOperationId: "post-receipt-projection-operation",
      source: { kind: "user" as const },
      mutationId: "post-receipt-projection-mutation",
      reconciliationToken: "post-receipt-projection-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "hello",
    };
    await expect(handle.submit(submission)).rejects.toMatchObject({
      category: "invalid_state",
      backendCode: "codex_history_not_established",
      crossedSubmissionBoundary: true,
    });
    await expect(handle.submit(submission)).rejects.toMatchObject({
      category: "submission_unknown",
      crossedSubmissionBoundary: true,
    });
    expect(
      harness.calls.filter(({ method }) => method === "turn/start"),
    ).toHaveLength(1);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("streams an externally initiated user and assistant turn from notifications only", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const startedTurn = {
      ...nativeTurn(1),
      items: [],
      itemsView: "notLoaded" as const,
      status: "inProgress" as const,
      completedAt: null,
    };
    const externalUser = {
      type: "userMessage" as const,
      id: "external-user-live",
      clientId: null,
      content: [
        { type: "text" as const, text: "external hello", text_elements: [] },
      ],
    };
    const assistant = {
      type: "agentMessage" as const,
      id: "external-assistant-live",
      text: "external answer",
      phase: "final_answer" as const,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: startedTurn,
    });
    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: externalUser,
      startedAtMs: 1_700_000_002_000,
    });
    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: assistant,
      startedAtMs: 1_700_000_002_100,
    });
    const streaming = (await handle.readCurrent()).snapshot;
    const liveTurn = streaming.turnsById[streaming.activeBackendTurnId!]!;
    const liveItemIds = [...liveTurn.orderedBackendItemIds];
    harness.notify("item/completed", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: externalUser,
      completedAtMs: 1_700_000_002_200,
    });
    harness.notify("item/completed", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: assistant,
      completedAtMs: 1_700_000_002_300,
    });
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        ...startedTurn,
        status: "completed",
        completedAt: 1_700_000_003,
        items: [],
        itemsView: "summary",
      },
    });

    const completed = (await handle.readCurrent()).snapshot;
    const completedTurn = completed.turnsById[liveTurn.backendTurnId]!;
    expect(completed.runState).toBe("idle");
    expect(completedTurn.status).toBe("completed");
    expect(completedTurn.orderedBackendItemIds).toEqual(liveItemIds);
    expect(
      completedTurn.orderedBackendItemIds.map(
        (itemId) => completed.itemsById[itemId]!.semanticKind,
      ),
    ).toEqual(["user_message", "assistant_message"]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("projects reasoning, file, and MCP progress incrementally through terminal completion", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    const sequencedEvents: SequencedBackendEvent[] = [];
    established.subscribeFromNext((entry) => {
      sequencedEvents.push(entry);
      events.push(entry.event);
    });
    const startedTurn = {
      ...nativeTurn(1),
      items: [],
      itemsView: "notLoaded" as const,
      status: "inProgress" as const,
      completedAt: null,
    };
    const reasoning = {
      type: "reasoning" as const,
      id: "reasoning-live",
      summary: [] as string[],
      content: [] as string[],
    };
    const fileChange = {
      type: "fileChange" as const,
      id: "file-live",
      changes: [
        {
          path: "src/live.ts",
          kind: { type: "delete" as const },
          diff: "",
        },
      ],
      status: "inProgress" as const,
    };
    const mcp = {
      type: "mcpToolCall" as const,
      id: "mcp-live",
      server: "files",
      tool: "inspect",
      status: "inProgress" as const,
      arguments: { path: "src/live.ts" },
      appContext: null,
      pluginId: null,
      readOnlyHint: null,
      result: null,
      error: null,
      durationMs: null,
    };
    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: startedTurn,
    });
    for (const item of [reasoning, fileChange, mcp]) {
      harness.notify("item/started", {
        threadId: "thread-1",
        turnId: startedTurn.id,
        item,
        startedAtMs: 1_700_000_002_000,
      });
    }

    harness.notify("item/fileChange/patchUpdated", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      itemId: fileChange.id,
      changes: fileChange.changes,
    });
    const earlyFileChange = Object.values(
      (await handle.readCurrent()).snapshot.itemsById,
    ).find((item) => item.semanticKind === "file_change");
    expect(earlyFileChange).not.toHaveProperty("additions");
    expect(earlyFileChange).not.toHaveProperty("deletions");

    harness.notify("item/reasoning/summaryPartAdded", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      itemId: reasoning.id,
      summaryIndex: 0,
    });
    harness.notify("item/reasoning/summaryTextDelta", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      itemId: reasoning.id,
      summaryIndex: 0,
      delta: "Checking the code",
    });
    harness.notify("item/reasoning/summaryPartAdded", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      itemId: reasoning.id,
      summaryIndex: 1,
    });
    harness.notify("item/reasoning/summaryTextDelta", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      itemId: reasoning.id,
      summaryIndex: 1,
      delta: "Preparing the result",
    });
    harness.notify("item/reasoning/textDelta", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      itemId: reasoning.id,
      contentIndex: 0,
      delta: "Detailed reasoning",
    });
    harness.notify("item/fileChange/patchUpdated", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      itemId: fileChange.id,
      changes: [
        {
          ...fileChange.changes[0],
          diff: "const live = true;\nexport {};\n",
        },
      ],
    });
    harness.notify("item/fileChange/outputDelta", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      itemId: fileChange.id,
      delta: "Applied patch",
    });
    harness.notify("item/mcpToolCall/progress", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      itemId: mcp.id,
      message: "Inspecting src/live.ts",
    });
    harness.notify("turn/diff/updated", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      diff: "+const live = true;",
    });
    harness.notify("turn/plan/updated", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      explanation: "Validated aggregate plan hint",
      plan: [{ step: "Inspect the file", status: "inProgress" }],
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );

    const progress = (await handle.readCurrent()).snapshot;
    const progressItems = Object.values(progress.itemsById).filter((item) =>
      ["reasoning", "file_change", "mcp"].includes(item.semanticKind),
    );
    expect(progressItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semanticKind: "reasoning",
          status: "streaming",
          summaryParts: [
            { text: "Checking the code" },
            { text: "Preparing the result" },
          ],
          markdown: expect.objectContaining({
            text: "Detailed reasoning",
          }),
        }),
        expect.objectContaining({
          semanticKind: "file_change",
          status: "streaming",
          additions: 0,
          deletions: 2,
          diff: expect.objectContaining({
            text: expect.objectContaining({
              text: "const live = true;\nexport {};\n",
            }),
          }),
        }),
        expect.objectContaining({
          semanticKind: "mcp",
          status: "streaming",
          result: expect.anything(),
        }),
      ]),
    );
    const progressIds = new Map(
      progressItems.map((item) => [item.semanticKind, item.backendItemId]),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "item_updated" &&
          ["reasoning", "file_change", "mcp"].includes(event.item.semanticKind),
      ),
    ).toHaveLength(4);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );

    const terminalItems = [
      {
        ...reasoning,
        summary: ["Checking the code", "Preparing the result"],
        content: ["Detailed reasoning"],
      },
      {
        ...fileChange,
        status: "completed" as const,
        changes: [
          {
            ...fileChange.changes[0],
            diff: "const live = true;\nexport {};\n",
          },
        ],
      },
      {
        ...mcp,
        status: "completed" as const,
        result: {
          content: [{ type: "text", text: "Inspection complete" }],
          structuredContent: null,
          _meta: null,
        },
        durationMs: 25,
      },
    ];
    for (const item of terminalItems) {
      harness.notify("item/completed", {
        threadId: "thread-1",
        turnId: startedTurn.id,
        item,
        completedAtMs: 1_700_000_002_500,
      });
    }
    const terminalOnlyAssistant = {
      type: "agentMessage" as const,
      id: "terminal-only-assistant",
      text: "Done",
      phase: "final_answer" as const,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        ...startedTurn,
        status: "completed",
        completedAt: 1_700_000_003,
        // The terminal full view rewrites MCP output, reorders live items, and
        // adds one item. Published live order/identities must remain stable and
        // only the genuinely new item may append.
        items: [
          {
            ...terminalItems[2],
            result: {
              content: [{ type: "text", text: "Rewritten terminal output" }],
              structuredContent: null,
              _meta: null,
            },
          },
          terminalItems[1],
          terminalItems[0],
          terminalOnlyAssistant,
        ],
        itemsView: "full",
      },
    });

    const completed = (await handle.readCurrent()).snapshot;
    for (const item of Object.values(completed.itemsById).filter((item) =>
      ["reasoning", "file_change", "mcp"].includes(item.semanticKind),
    )) {
      expect(item.backendItemId).toBe(progressIds.get(item.semanticKind));
      expect(item.status).toBe("completed");
    }
    expect(
      Object.values(completed.itemsById).find(
        (item) => item.semanticKind === "file_change",
      ),
    ).toMatchObject({ additions: 0, deletions: 2 });
    const completedTurn =
      completed.turnsById[completed.orderedBackendTurnIds.at(-1)!]!;
    expect(completedTurn.orderedBackendItemIds.slice(0, 3)).toEqual(
      progressItems.map((item) => item.backendItemId),
    );
    expect(
      completed.itemsById[completedTurn.orderedBackendItemIds.at(-1)!],
    ).toMatchObject({
      semanticKind: "assistant_message",
      markdown: { text: "Done" },
    });
    expect(
      Object.values(completed.itemsById).find(
        (item) => item.semanticKind === "mcp",
      ),
    ).toMatchObject({
      result: {
        content: [
          { kind: "text", value: { text: "Rewritten terminal output" } },
        ],
      },
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );
    const applicationProjector = new ConversationProjector({
      backendInstanceId: instance.id,
      bindingIdentity: binding().applicationThreadId,
    });
    applicationProjector.replace(
      established.snapshot,
      established.handleSequence,
    );
    for (const event of sequencedEvents) {
      expect(
        applicationProjector.apply(event),
        `application projector rejected ${event.event.type}`,
      ).not.toMatchObject({ kind: "resnapshot_required" });
    }

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("keeps path-native image delivery unchanged without reading canonical bytes", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    harness.enqueue("model/list", {
      data: [nativeModel({ inputModalities: ["text", "image"] })],
      nextCursor: null,
    });
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    const imageAttachment = {
      ...stagedAttachment,
      kind: "image" as const,
      fileName: "diagram.png",
      mediaType: "image/png" as const,
      agentPath: "/remote/workspace/.sedes-attachments/diagram.png",
    };
    const read = vi.fn(async () => Buffer.from("unexpected"));

    await handle.submit({
      applicationOperationId: "path-native-image-submit",
      source: { kind: "user" },
      mutationId: "path-native-image-submit",
      reconciliationToken: "path-native-image-submit",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [imageAttachment],
      attachmentBytes: { read },
      text: "inspect",
    });

    const params = harness.calls.find(({ method }) => method === "turn/start")!
      .params as {
      readonly input: readonly {
        readonly type: string;
        readonly path?: string;
      }[];
    };
    expect(params.input).toEqual(
      expect.arrayContaining([
        { type: "localImage", path: imageAttachment.agentPath },
      ]),
    );
    expect(JSON.stringify(params.input)).not.toContain(
      "sedes-staged-attachments",
    );
    expect(read).not.toHaveBeenCalled();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("retains the staged image path for text-only Codex submit and steer", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    harness.enqueue("model/list", {
      data: [nativeModel({ inputModalities: ["text"] })],
      nextCursor: null,
    });
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    const imageAttachment = {
      ...stagedAttachment,
      kind: "image" as const,
      fileName: "diagram.png",
      mediaType: "image/png" as const,
      agentPath: "/remote/workspace/.sedes-attachments/diagram.png",
    };

    const submitted = await handle.submit({
      applicationOperationId: "text-only-image-submit",
      source: { kind: "user" },
      mutationId: "text-only-image-submit",
      reconciliationToken: "text-only-image-submit",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [imageAttachment],
      text: "",
    });
    harness.enqueue("turn/steer", { turnId: "turn-1" });
    await handle.steer({
      applicationOperationId: "text-only-image-steer",
      mutationId: "text-only-image-steer",
      reconciliationToken: "text-only-image-steer",
      target: { kind: "turn", turnId: submitted.backendTurnId! },
      taskContexts: [],
      contextExcerpts: [],
      attachments: [imageAttachment],
      text: "",
    });

    for (const method of ["turn/start", "turn/steer"] as const) {
      const params = harness.calls.find(
        ({ method: called }) => called === method,
      )!.params as {
        readonly clientUserMessageId: string;
        readonly input: readonly {
          readonly type: string;
          readonly text?: string;
        }[];
      };
      expect(params.input).toHaveLength(1);
      expect(params.input[0]?.type).toBe("text");
      expect(
        inspectStagedAttachmentManifest(params.input[0]!.text!, {
          key: toolProvenanceKey,
          correlation: params.clientUserMessageId,
        }),
      ).toMatchObject({
        type: "authenticated",
        attachments: [
          expect.objectContaining({
            id: imageAttachment.id,
            kind: "image",
            fileName: "diagram.png",
          }),
        ],
      });
      expect(params.input.some(({ type }) => type === "localImage")).toBe(
        false,
      );
    }
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it.each([
    {
      name: "empty-to-one",
      initialPaths: [] as string[],
      nextPaths: ["src/a.ts"],
      laterItem: false,
      invalidates: true,
    },
    {
      name: "turn-tail growth",
      initialPaths: ["src/a.ts"],
      nextPaths: ["src/a.ts", "src/b.ts"],
      laterItem: false,
      invalidates: false,
    },
    {
      name: "growth before a later item",
      initialPaths: ["src/a.ts"],
      nextPaths: ["src/a.ts", "src/b.ts"],
      laterItem: true,
      invalidates: true,
    },
    {
      name: "shrink",
      initialPaths: ["src/a.ts", "src/b.ts"],
      nextPaths: ["src/a.ts"],
      laterItem: false,
      invalidates: true,
    },
    {
      name: "reorder",
      initialPaths: ["src/a.ts", "src/b.ts"],
      nextPaths: ["src/b.ts", "src/a.ts"],
      laterItem: false,
      invalidates: true,
    },
  ])(
    "handles live file slice shape: $name",
    async ({ initialPaths, nextPaths, laterItem, invalidates }) => {
      const harness = new RpcHarness();
      const handle = await attachIdle(harness);
      const established = await establish(harness, handle);
      const events: BackendConversationEvent[] = [];
      established.subscribeFromNext(({ event }) => events.push(event));
      const activeTurn = {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded" as const,
        status: "inProgress" as const,
        completedAt: null,
      };
      const changes = (paths: readonly string[]) =>
        paths.map((path) => ({
          path,
          kind: { type: "update" as const, move_path: null },
          diff: `+${path}\n`,
        }));
      const file = {
        type: "fileChange" as const,
        id: "file-shape",
        changes: changes(initialPaths),
        status: "inProgress" as const,
      };
      harness.notify("turn/started", {
        threadId: "thread-1",
        turn: activeTurn,
      });
      harness.notify("item/started", {
        threadId: "thread-1",
        turnId: activeTurn.id,
        item: file,
        startedAtMs: 1_700_000_002_000,
      });
      if (laterItem) {
        harness.notify("item/started", {
          threadId: "thread-1",
          turnId: activeTurn.id,
          item: {
            type: "agentMessage",
            id: "later-assistant",
            text: "",
            phase: "final_answer",
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
          startedAtMs: 1_700_000_002_001,
        });
      }
      const beforePatch = events.length;
      harness.notify("item/fileChange/patchUpdated", {
        threadId: "thread-1",
        turnId: activeTurn.id,
        itemId: file.id,
        changes: changes(nextPaths),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const patchEvents = events.slice(beforePatch);

      expect(
        patchEvents.some(({ type }) => type === "resnapshot_required"),
      ).toBe(invalidates);
      if (!invalidates) {
        const current = (await handle.readCurrent()).snapshot;
        const fileItems = Object.values(current.itemsById).filter(
          (item) => item.semanticKind === "file_change",
        );
        expect(fileItems.map(({ sourceOrder }) => sourceOrder)).toEqual([0, 1]);
        expect(
          Object.values(current.itemsById).flatMap((item) =>
            item.semanticKind === "file_change" ? [item.path.text] : [],
          ),
        ).toEqual(nextPaths);
        expect(patchEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "item_started" }),
            expect.objectContaining({ type: "turn_updated" }),
          ]),
        );
      }
      harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
      await handle.close();
    },
  );

  it("keeps the exact live snapshot ledger through tail growth and repeated replacements", async () => {
    const harness = new RpcHarness();
    const errors: unknown[] = [];
    const target = driver(
      harness,
      connection,
      new CodexConversationOwnershipRegistry(),
      catalogModelPolicy,
      executionSettingsProvider(),
      undefined,
      undefined,
      unavailableCodexAgentToolCliEnvironmentProvider,
      new CodexFastModeSessionRegistry(),
      undefined,
      (error) => errors.push(error),
    );
    const handle = await attachIdle(harness, target);
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const activeTurn = {
      ...nativeTurn(1),
      items: [],
      itemsView: "notLoaded" as const,
      status: "inProgress" as const,
      completedAt: null,
    };
    const file = {
      type: "fileChange" as const,
      id: "file-ledger",
      changes: [
        {
          path: "src/a.ts",
          kind: { type: "update" as const, move_path: null },
          diff: "+initial\n",
        },
      ],
      status: "inProgress" as const,
    };
    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: activeTurn,
    });
    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: activeTurn.id,
      item: file,
      startedAtMs: 1_700_000_002_000,
    });
    harness.notify("item/fileChange/patchUpdated", {
      threadId: "thread-1",
      turnId: activeTurn.id,
      itemId: file.id,
      changes: [
        file.changes[0],
        {
          path: "src/b.ts",
          kind: { type: "add" as const },
          diff: "+tail\n",
        },
      ],
    });
    harness.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "active", activeFlags: [] },
    });
    for (let index = 0; index < 64; index += 1) {
      harness.notify("item/fileChange/patchUpdated", {
        threadId: "thread-1",
        turnId: activeTurn.id,
        itemId: file.id,
        changes: [
          { ...file.changes[0], diff: `+replacement-${index}\n` },
          {
            path: "src/b.ts",
            kind: { type: "add" as const },
            diff: `+tail-${index}\n`,
          },
        ],
      });
      // Each active lifecycle boundary verifies the exact incremental byte
      // ledger before reinstalling the complete authoritative candidate.
      harness.notify("thread/status/changed", {
        threadId: "thread-1",
        status: { type: "active", activeFlags: [] },
      });
    }

    // This lifecycle install compares the incrementally maintained ledger to
    // the complete private snapshot before it can publish the new item.
    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: activeTurn.id,
      item: {
        type: "agentMessage",
        id: "ledger-assistant",
        text: "",
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
      startedAtMs: 1_700_000_002_001,
    });

    expect(errors).toEqual([]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );
    const snapshot = (await handle.readCurrent()).snapshot;
    expect(
      Object.values(snapshot.itemsById).filter(
        ({ semanticKind }) => semanticKind === "file_change",
      ),
    ).toHaveLength(2);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it.each([0, 20, 100, 217, 1_000])(
    "coalesces a delta storm independently of %i settled items",
    async (settledItemCount) => {
      const harness = new RpcHarness();
      const activeTurn = {
        ...nativeTurn(2),
        items: [
          {
            type: "agentMessage" as const,
            id: "storm-assistant",
            text: "",
            phase: "final_answer" as const,
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
        ],
        status: "inProgress" as const,
        completedAt: null,
      };
      const settledTurn = {
        ...nativeTurn(1),
        items: Array.from({ length: settledItemCount }, (_, index) => ({
          ...nativeTurn(1).items[0]!,
          id: `settled-item-${index}`,
          content: [
            {
              type: "text" as const,
              text: `settled ${index}`,
              text_elements: [],
            },
          ],
        })),
      };
      const activeThread = nativeThread({
        status: { type: "active", activeFlags: [] },
        turns:
          settledItemCount === 0 ? [activeTurn] : [settledTurn, activeTurn],
      });
      const handle = (await driver(harness).attach(
        attachInput(),
      )) as CodexConversationHandle;
      const established = await establish(harness, handle, activeThread);
      const events: BackendConversationEvent[] = [];
      established.subscribeFromNext(({ event }) => events.push(event));
      const callsBeforeStorm = harness.calls.length;

      for (let index = 0; index < 100; index += 1) {
        harness.notify("item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: activeTurn.id,
          itemId: "storm-assistant",
          delta: "x",
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(harness.calls).toHaveLength(callsBeforeStorm);
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "resnapshot_required" }),
      );
      expect(
        events.filter(
          (event) =>
            event.type === "item_updated" &&
            event.item.semanticKind === "assistant_message",
        ),
      ).toHaveLength(2);
      expect(
        Object.values((await handle.readCurrent()).snapshot.itemsById).find(
          ({ semanticKind }) => semanticKind === "assistant_message",
        ),
      ).toMatchObject({ markdown: { text: "x".repeat(100) } });
      harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
      await handle.close();
    },
  );

  it("publishes a correlated active-turn update after a steering user item", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const startedTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
    };
    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: startedTurn,
    });
    const steeringClientId = codexClientUserMessageId({
      toolProvenanceKey,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      backendInstanceId: instance.id,
      nativeThreadId: "thread-1",
      correlationAncestorThreadIds: [],
      applicationOperationId: "steer-operation",
      reconciliationToken: "steer-token",
    });

    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: {
        type: "userMessage",
        id: "steer-message",
        clientId: steeringClientId,
        content: [
          {
            type: "text",
            text: "clarification",
            text_elements: [],
          },
        ],
      },
      startedAtMs: 1_700_000_002_000,
    });

    const itemIndex = events.findIndex(
      (event) =>
        event.type === "item_completed" &&
        event.item.backendItemId !== undefined,
    );
    const updateIndex = events.findIndex(
      (event) => event.type === "turn_updated",
    );
    expect(itemIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(itemIndex);
    expect(events[updateIndex]).toMatchObject({
      type: "turn_updated",
      turn: {
        status: "in_progress",
        completionCorrelations: ["steer-operation"],
      },
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("merges a partial terminal turn after its item identities were confirmed", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: unknown[] = [];
    established.subscribeFromNext((event) => events.push(event));
    const startedTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
    };
    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: startedTurn,
    });
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        ...startedTurn,
        status: "interrupted",
        completedAt: 1_700_000_003,
        items: [startedTurn.items[0]],
        itemsView: "summary",
      },
    });

    const current = (await handle.readCurrent()).snapshot;
    const terminalTurn =
      current.turnsById[current.orderedBackendTurnIds.at(-1)!]!;
    expect(current.runState).toBe("idle");
    expect(terminalTurn).toMatchObject({
      status: "interrupted",
      endedBy: "interrupted",
    });
    expect(terminalTurn.orderedBackendItemIds).toHaveLength(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ type: "resnapshot_required" }),
      }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not fabricate a streamed tool omitted by an interrupted terminal summary", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const startedTurn = {
      ...nativeTurn(1),
      items: [],
      itemsView: "notLoaded" as const,
      status: "inProgress" as const,
      completedAt: null,
    };
    const provisionalCommand = {
      ...nativeCommandTurn(1).items[1],
      status: "inProgress" as const,
      aggregatedOutput: "partial output",
      exitCode: null,
      durationMs: null,
    };
    harness.notify("turn/started", {
      threadId: "thread-1",
      turn: startedTurn,
    });
    harness.notify("item/started", {
      threadId: "thread-1",
      turnId: startedTurn.id,
      item: provisionalCommand,
      startedAtMs: 1_700_000_002_000,
    });
    // Codex may announce transport-level idle before the interrupted terminal
    // summary. Idle alone is not item-retention evidence.
    harness.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        ...startedTurn,
        status: "interrupted",
        completedAt: 1_700_000_003,
        items: [],
        itemsView: "summary",
      },
    });

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "resnapshot_required",
        reason: "contradictory_state",
      });
    });
    await expect(
      handle.locateTurn({
        matchesBackendTurnId: () => false,
        maximumTurnCandidates: 10,
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      retryable: true,
      backendCode: "codex_history_reconciliation_required",
    });
    const unresolved = (await handle.readCurrent()).snapshot;
    expect(unresolved.runState).toBe("running");
    expect(
      Object.values(unresolved.itemsById).find(
        (item) => item.semanticKind === "command",
      ),
    ).toMatchObject({ status: "streaming" });
    expect(
      Object.values(unresolved.turnsById).find(
        (turn) => turn.backendTurnId === unresolved.activeBackendTurnId,
      ),
    ).toMatchObject({ status: "in_progress" });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("retries an authoritative snapshot when a history mutation races the resume response", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const updated = nativeThread({
      turns: [nativeTurn(0), nativeTurn(1)],
    });
    harness.enqueue(
      "thread/read",
      { thread: nativeThread() },
      { thread: updated },
    );
    harness.enqueue("thread/resume", resumeResult(), resumeResult(updated));
    harness.after("thread/resume", (receiptSequence) => {
      harness.notify(
        "turn/completed",
        { threadId: "thread-1", turn: nativeTurn(1) },
        receiptSequence + 1,
      );
    });
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(2);
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(2);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("replays paginated transcript notifications that race boundary hydration without resuming again", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const events: BackendConversationEvent[] = [];
    const active = {
      ...notLoadedTurn(1),
      status: "inProgress" as const,
      completedAt: null,
    };
    const activeThread = paginatedThread({
      status: { type: "active", activeFlags: [] },
    });
    const agentItem = {
      type: "agentMessage" as const,
      id: "agent-during-hydration",
      text: "",
      phase: "commentary" as const,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    harness.enqueue("thread/read", { thread: activeThread });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        thread: activeThread,
        shells: [active, notLoadedTurn(0)],
      }),
    );
    harness.enqueue("thread/turns/list", {
      data: [active],
      nextCursor: "after-active",
      backwardsCursor: "turns-head",
    });
    harness.enqueue(
      "thread/items/list",
      (_params: unknown, activeHarness: RpcHarness) => {
        activeHarness.notify("item/started", {
          threadId: "thread-1",
          turnId: active.id,
          item: agentItem,
          startedAtMs: 1_700_000_002_000,
        });
        activeHarness.notify("item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: active.id,
          itemId: agentItem.id,
          delta: "during hydration",
        });
        return paginatedItems(1);
      },
      paginatedItems(0),
    );

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    harness.notify("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: active.id,
      itemId: agentItem.id,
      delta: " and gap",
    });
    const unsubscribe = established.subscribeFromNext(({ event }) =>
      events.push(event),
    );
    await vi.waitFor(async () => {
      const assistant = Object.values(
        (await handle.readCurrent()).snapshot.itemsById,
      ).find(({ semanticKind }) => semanticKind === "assistant_message");
      expect(assistant).toMatchObject({
        semanticKind: "assistant_message",
        markdown: { text: "during hydration and gap" },
      });
    });

    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(
      events
        .filter(({ type }) =>
          ["item_started", "turn_updated", "item_updated"].includes(type),
        )
        .map(({ type }) => type),
    ).toEqual(["item_started", "turn_updated", "item_updated", "item_updated"]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );

    unsubscribe();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("fails paginated establishment retryably when an undecodable notification races boundary hydration", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const thread = paginatedThread();
    const resumed = paginatedResumeResult({ shells: [notLoadedTurn(0)] });
    harness.enqueue("thread/read", { thread });
    harness.enqueue("thread/resume", resumed);
    harness.enqueue("thread/items/list", paginatedItems(0));
    harness.after("thread/items/list", () => {
      harness.notifyUndecodable("turn/started", thread.id);
    });

    await expect(
      handle.establishProjection({
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      retryable: true,
      backendCode: "codex_paginated_catch_up_unavailable",
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("fails paginated establishment retryably when its bounded catch-up journal overflows", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const thread = paginatedThread();
    const resumed = paginatedResumeResult({ shells: [notLoadedTurn(0)] });
    harness.enqueue("thread/read", { thread });
    harness.enqueue("thread/resume", resumed);
    harness.enqueue(
      "thread/items/list",
      (_params: unknown, activeHarness: RpcHarness) => {
        for (let index = 0; index < 1_001; index += 1) {
          activeHarness.notify("thread/status/changed", {
            threadId: thread.id,
            status: { type: "active", activeFlags: [] },
          });
        }
        return paginatedItems(0);
      },
    );

    await expect(
      handle.establishProjection({
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      retryable: true,
      backendCode: "codex_paginated_catch_up_unavailable",
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("discards catch-up overflow that the paginated resume boundary supersedes", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const thread = paginatedThread();
    harness.enqueue("thread/read", { thread });
    harness.after("thread/read", () => {
      for (let index = 0; index < 1_001; index += 1) {
        harness.notify("thread/status/changed", {
          threadId: thread.id,
          status: { type: "active", activeFlags: [] },
        });
      }
    });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({ shells: [notLoadedTurn(0)] }),
    );
    harness.enqueue("thread/items/list", paginatedItems(0));

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: BackendConversationEvent[] = [];
    const unsubscribe = established.subscribeFromNext(({ event }) =>
      events.push(event),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "resnapshot_required" }),
    );
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);

    unsubscribe();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("retries establishment when an attributable undecodable notification races the resume receipt", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const thread = nativeThread();
    harness.enqueue("thread/read", { thread }, { thread });
    harness.enqueue(
      "thread/resume",
      resumeResult(thread),
      resumeResult(thread),
    );
    harness.after("thread/resume", () => {
      harness.notifyUndecodable("turn/started", thread.id);
    });

    await expect(
      handle.establishProjection({
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ snapshot: { runState: "idle" } });
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(2);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("refuses pagination evidence without publishing a partial legacy projection", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", {
      ...resumeResult(),
      initialTurnsPage: {
        data: [{ ...nativeTurn(0), items: [], itemsView: "notLoaded" }],
        nextCursor: null,
        backwardsCursor: "older-turns",
      },
      turnsBackwardsCursor: "older-turns",
      itemsBackwardsCursor: null,
    });

    await expect(
      handle.establishProjection({
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => (
        expectBackendError(
          error,
          "incompatible_protocol",
          "codex_history_incomplete",
        ),
        true
      ),
    );
    await expect(handle.history({ limit: 1 })).rejects.toMatchObject({
      category: "invalid_state",
      backendCode: "codex_history_not_established",
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("attaches, pages, submits, and stops beyond the former cumulative history ceilings without rereading", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const handle = await attachIdle(harness, target);
    const overLimit = overLimitNativeThread();
    expect(serializedUtf8Bytes(overLimit)).toBeGreaterThan(14 * 1024 * 1024);
    const established = await establish(harness, handle, overLimit);
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(10);
    const older = await handle.history({
      limit: 500,
      cursor: established.history.previousCursor,
    });
    expect(older.orderedBackendTurnIds).toHaveLength(500);

    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1_001),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    const submitted = await handle.submit({
      applicationOperationId: "large-history-submit",
      source: { kind: "user" },
      mutationId: "large-history-submit-mutation",
      reconciliationToken: "large-history-submit-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "continue",
    });
    harness.enqueue("turn/interrupt", {});
    await handle.interrupt({
      applicationOperationId: "large-history-stop",
      expectedBackendTurnId: submitted.backendTurnId!,
    });

    expect(
      harness.calls.filter(({ method }) => method === "thread/read"),
    ).toHaveLength(1);
    expect(
      harness.calls.filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(
      harness.calls.some(
        ({ method }) =>
          method === "thread/turns/list" || method === "thread/items/list",
      ),
    ).toBe(false);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
    harness.enqueue(
      "thread/read",
      { thread: { ...overLimit, turns: [] } },
      { thread: overLimit },
    );
    const detached = await target.read(attachInput());
    expect(detached.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(
      harness.calls.some(
        ({ method }) =>
          method === "thread/turns/list" || method === "thread/items/list",
      ),
    ).toBe(false);
  }, 30_000);

  it("projects disconnect and replacement-generation lifecycle without stale idle or usage", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: unknown[] = [];
    established.subscribeFromNext((event) => events.push(event));
    harness.notify("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-0",
      tokenUsage: {
        total: {
          totalTokens: 1,
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 1,
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 100,
      },
    });
    harness.lifecycle("unavailable", 1);
    expect((await handle.readCurrent()).snapshot.runState).toBe("disconnected");
    harness.lifecycle("ready", 2);
    const current = await handle.readCurrent();
    expect(current.snapshot.runState).toBe("reconciling");
    expect(current.usage).toEqual({});
    expect(await handle.usage()).toEqual({});
    await expect(handle.history({ limit: 1 })).rejects.toMatchObject({
      backendCode: "codex_history_reconciliation_required",
      retryable: true,
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: { type: "run_state_changed", state: "disconnected" },
        }),
        expect.objectContaining({
          event: { type: "run_state_changed", state: "reconciling" },
        }),
        expect.objectContaining({
          event: {
            type: "resnapshot_required",
            reason: "sequence_gap",
          },
        }),
      ]),
    );
    const replacement = nativeThread();
    harness.enqueue("thread/read", { thread: replacement });
    harness.enqueue("thread/resume", resumeResult(replacement));
    const reestablished = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(reestablished.snapshot).toEqual(established.snapshot);
    expect(new Set(reestablished.snapshot.orderedBackendTurnIds).size).toBe(
      reestablished.snapshot.orderedBackendTurnIds.length,
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("makes projection subscriptions one-shot and rejects stale subscription closures", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const first = await establish(harness, handle);
    const unsubscribe = first.subscribeFromNext(() => undefined);
    expect(() => first.subscribeFromNext(() => undefined)).toThrow(
      expect.objectContaining({
        backendCode: "codex_projection_subscription_claimed",
      }),
    );
    unsubscribe();
    const second = await establish(harness, handle);
    expect(() => first.subscribeFromNext(() => undefined)).toThrow(
      expect.objectContaining({
        backendCode: "codex_projection_subscription_claimed",
      }),
    );
    second.subscribeFromNext(() => undefined)();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("submits, steers, interrupts, renames, and compacts with durable correlation", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle);
    const events: unknown[] = [];
    established.subscribeFromNext((event) => events.push(event));
    harness.enqueue("thread/read", { thread: nativeThread() });
    const retryAnchor = await handle.captureSubmissionRetryAnchor();
    expect(retryAnchor).toMatch(/^codex-retry-anchor:/u);

    harness.enqueue("turn/start", () => {
      return {
        turn: {
          ...nativeTurn(1),
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          completedAt: null,
        },
      };
    });
    const submitted = await handle.submit({
      applicationOperationId: "submit-operation",
      source: { kind: "user" },
      mutationId: "mutation",
      reconciliationToken: "submit-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "hello",
    });
    expect(submitted).toMatchObject({
      accepted: true,
      reconciliationToken: "submit-token",
      completionCorrelation: "submit-operation",
      backendTurnId: expect.any(String),
    });
    const startCall = harness.calls.find(
      ({ method }) => method === "turn/start",
    );
    expect(startCall?.params).toMatchObject({
      threadId: "thread-1",
      clientUserMessageId: codexClientUserMessageId({
        toolProvenanceKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId: instance.id,
        nativeThreadId: "thread-1",
        correlationAncestorThreadIds: [],
        applicationOperationId: "submit-operation",
        reconciliationToken: "submit-token",
      }),
      input: [{ type: "text", text: "hello", text_elements: [] }],
      model: "gpt-5.6",
      effort: "low",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });

    harness.enqueue("turn/steer", (params: unknown) => ({
      turnId: (params as { expectedTurnId: string }).expectedTurnId,
    }));
    await expect(
      handle.steer({
        applicationOperationId: "steer-operation",
        mutationId: "mutation-2",
        reconciliationToken: "steer-token",
        target: { kind: "turn", turnId: submitted.backendTurnId! },
        taskContexts: [],
        contextExcerpts: [],
        attachments: [],
        text: "clarification",
      }),
    ).resolves.toMatchObject({
      status: "accepted",
      reconciliationToken: "steer-token",
    });
    harness.enqueue("turn/interrupt", {});
    await handle.interrupt({
      applicationOperationId: "interrupt-operation",
      expectedBackendTurnId: submitted.backendTurnId!,
    });
    await handle.interrupt({
      applicationOperationId: "interrupt-operation",
      expectedBackendTurnId: submitted.backendTurnId!,
    });
    expect(
      harness.calls.filter(({ method }) => method === "turn/interrupt"),
    ).toHaveLength(1);
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/name/set", {});
    await expect(
      handle.perform({
        applicationOperationId: "rename-operation",
        action: "rename",
        title: "Renamed",
      }),
    ).resolves.toEqual({ accepted: true });
    harness.enqueue("thread/compact/start", {});
    await expect(
      handle.perform({
        applicationOperationId: "compact-operation",
        action: "compact",
      }),
    ).resolves.toEqual({ accepted: true });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ type: "turn_started" }),
        }),
        expect.objectContaining({
          event: {
            type: "run_state_changed",
            state: "running",
            activeBackendTurnId: expect.any(String),
          },
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: "run_state_changed",
            state: "stopping",
          }),
        }),
      ]),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not overwrite terminal idle when a turn completes before the interrupt receipt", async () => {
    const harness = new RpcHarness();
    const activeTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [activeTurn],
    });
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle, activeThread);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const input = {
      applicationOperationId: "interrupt-completion-wins",
      expectedBackendTurnId: established.snapshot.activeBackendTurnId!,
    };
    harness.enqueue("turn/interrupt", () => {
      harness.notify("turn/completed", {
        threadId: activeThread.id,
        turn: {
          ...activeTurn,
          status: "interrupted",
          completedAt: 1_700_000_003,
          durationMs: 2_000,
        },
      });
      return {};
    });

    await expect(handle.interrupt(input)).resolves.toBeUndefined();

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "run_state_changed", state: "stopping" }),
    );
    expect(events.at(-1)).toEqual({
      type: "run_state_changed",
      state: "idle",
    });
    const current = (await handle.readCurrent()).snapshot;
    expect(current.runState).toBe("idle");
    expect(current).not.toHaveProperty("activeBackendTurnId");

    await expect(handle.interrupt(input)).resolves.toBeUndefined();
    await expect(handle.reconcileInterrupt(input)).resolves.toEqual({
      outcome: "accepted",
    });
    expect(
      harness.calls.filter(({ method }) => method === "turn/interrupt"),
    ).toHaveLength(1);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("publishes stopping before terminal idle when the interrupt receipt wins", async () => {
    const harness = new RpcHarness();
    const activeTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [activeTurn],
    });
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle, activeThread);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    harness.enqueue("turn/interrupt", {});

    await handle.interrupt({
      applicationOperationId: "interrupt-receipt-wins",
      expectedBackendTurnId: established.snapshot.activeBackendTurnId!,
    });

    expect(events.at(-1)).toEqual({
      type: "run_state_changed",
      state: "stopping",
      activeBackendTurnId: established.snapshot.activeBackendTurnId,
    });
    harness.notify("turn/completed", {
      threadId: activeThread.id,
      turn: {
        ...activeTurn,
        status: "interrupted",
        completedAt: 1_700_000_003,
        durationMs: 2_000,
      },
    });
    const stoppingIndex = events.findIndex(
      (event) =>
        event.type === "run_state_changed" && event.state === "stopping",
    );
    const idleIndex = events.findIndex(
      (event) => event.type === "run_state_changed" && event.state === "idle",
    );
    expect(stoppingIndex).toBeGreaterThanOrEqual(0);
    expect(idleIndex).toBeGreaterThan(stoppingIndex);
    expect((await handle.readCurrent()).snapshot.runState).toBe("idle");

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("converges a queued paginated completion after publishing stopping", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const activeTurn = {
      ...notLoadedTurn(1),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const activeThread = paginatedThread({
      status: { type: "active", activeFlags: [] },
    });
    harness.enqueue("thread/read", { thread: activeThread });
    harness.enqueue(
      "thread/resume",
      paginatedResumeResult({
        thread: activeThread,
        shells: [activeTurn, notLoadedTurn(0)],
      }),
    );
    harness.enqueue("thread/turns/list", {
      data: [activeTurn],
      nextCursor: "after-active",
      backwardsCursor: "turns-head",
    });
    harness.enqueue("thread/items/list", paginatedItems(1), paginatedItems(0));
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const turnsListCallsBeforeInterrupt = harness.calls.filter(
      ({ method }) => method === "thread/turns/list",
    ).length;
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const completedTurn = {
      ...activeTurn,
      status: "interrupted" as const,
      completedAt: 1_700_000_003,
      durationMs: 2_000,
    };
    let releaseRefresh!: (value: unknown) => void;
    harness.enqueue(
      "thread/turns/list",
      () =>
        new Promise((resolve) => {
          releaseRefresh = resolve;
        }),
    );
    harness.enqueue("thread/items/list", paginatedItems(1), paginatedItems(0));
    harness.enqueue("turn/interrupt", () => {
      harness.notify("turn/completed", {
        threadId: activeThread.id,
        turn: completedTurn,
      });
      return {};
    });

    await handle.interrupt({
      applicationOperationId: "interrupt-queued-completion",
      expectedBackendTurnId: established.snapshot.activeBackendTurnId!,
    });

    expect(events.at(-1)).toEqual({
      type: "run_state_changed",
      state: "stopping",
      activeBackendTurnId: established.snapshot.activeBackendTurnId,
    });
    await vi.waitFor(() => {
      expect(
        harness.calls.filter(({ method }) => method === "thread/turns/list"),
      ).toHaveLength(turnsListCallsBeforeInterrupt + 1);
    });
    releaseRefresh({
      data: [completedTurn, notLoadedTurn(0)],
      nextCursor: null,
      backwardsCursor: "completed-head",
    });
    await vi.waitFor(async () => {
      expect((await handle.readCurrent()).snapshot.runState).toBe("idle");
    });
    const stoppingIndex = events.findIndex(
      (event) =>
        event.type === "run_state_changed" && event.state === "stopping",
    );
    const idleIndex = events.findIndex(
      (event) => event.type === "run_state_changed" && event.state === "idle",
    );
    expect(stoppingIndex).toBeGreaterThanOrEqual(0);
    expect(idleIndex).toBeGreaterThan(stoppingIndex);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not label a replacement active turn as stopping", async () => {
    const harness = new RpcHarness();
    const interruptedTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [interruptedTurn],
    });
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle, activeThread);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    const replacementTurn = {
      ...nativeTurn(2),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    harness.enqueue("turn/interrupt", () => {
      harness.notify("turn/completed", {
        threadId: activeThread.id,
        turn: {
          ...interruptedTurn,
          status: "interrupted",
          completedAt: 1_700_000_003,
          durationMs: 2_000,
        },
      });
      harness.notify("turn/started", {
        threadId: activeThread.id,
        turn: replacementTurn,
      });
      return {};
    });
    const input = {
      applicationOperationId: "interrupt-replacement-turn",
      expectedBackendTurnId: established.snapshot.activeBackendTurnId!,
    };

    await handle.interrupt(input);

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "run_state_changed", state: "stopping" }),
    );
    expect(events.at(-1)).toEqual({
      type: "run_state_changed",
      state: "running",
      activeBackendTurnId: codexBackendTurnId(
        activeThread.id,
        replacementTurn.id,
      ),
    });
    expect((await handle.readCurrent()).snapshot).toMatchObject({
      runState: "running",
      activeBackendTurnId: codexBackendTurnId(
        activeThread.id,
        replacementTurn.id,
      ),
    });
    await expect(handle.interrupt(input)).resolves.toBeUndefined();
    await expect(handle.reconcileInterrupt(input)).resolves.toEqual({
      outcome: "accepted",
    });
    expect(
      harness.calls.filter(({ method }) => method === "turn/interrupt"),
    ).toHaveLength(1);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("does not publish stopping after the projection invalidates during interrupt", async () => {
    const harness = new RpcHarness();
    const activeTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [activeTurn],
    });
    const handle = await attachIdle(harness);
    const established = await establish(harness, handle, activeThread);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    harness.enqueue("turn/interrupt", () => {
      harness.notify("error", {
        threadId: activeThread.id,
        turnId: activeTurn.id,
        willRetry: false,
        error: {
          message: "The turn failed while interrupting.",
          codexErrorInfo: null,
          additionalDetails: null,
        },
      });
      return {};
    });
    const input = {
      applicationOperationId: "interrupt-invalidated-projection",
      expectedBackendTurnId: established.snapshot.activeBackendTurnId!,
    };

    await expect(handle.interrupt(input)).resolves.toBeUndefined();

    expect(events).toEqual([
      { type: "run_state_changed", state: "reconciling" },
      { type: "resnapshot_required", reason: "contradictory_state" },
    ]);
    await expect(handle.interrupt(input)).resolves.toBeUndefined();
    await expect(handle.reconcileInterrupt(input)).resolves.toEqual({
      outcome: "accepted",
    });
    expect(
      harness.calls.filter(({ method }) => method === "turn/interrupt"),
    ).toHaveLength(1);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("sends signed context, untouched prompt, and native skill as ordered structured input", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    const path = "/private/codex/skills/review/SKILL.md";
    harness.enqueue("skills/list", {
      data: [
        {
          cwd: "/workspace",
          skills: [
            {
              name: "review",
              description: "Review changes",
              path,
              scope: "user",
              enabled: true,
            },
          ],
          errors: [],
        },
      ],
    });
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });

    await handle.submit({
      applicationOperationId: "skill-submit-operation",
      source: { kind: "user" },
      mutationId: "skill-submit-mutation",
      reconciliationToken: "skill-submit-token",
      taskContexts: [],
      contextExcerpts: [
        {
          id: "6757ef12-f5d9-4c31-80c6-4d7460b4ebbd",
          excerpt: "return legacyValue;",
          note: "Replace this legacy path.",
          source: {
            kind: "conversation_message",
            itemId: "normalized-assistant-item-1",
            itemRevision: 5,
          },
          locator: {
            kind: "text_quote",
            prefix: "Before ",
            suffix: " after.",
          },
        },
      ],
      attachments: [stagedAttachment],
      selectedSkillId: codexSkillId("review", path),
      text: renderTaskContextsForModel([taskContext], "please inspect"),
    });

    expect(
      harness.calls.find(({ method }) => method === "skills/list")?.params,
    ).toEqual({ cwds: ["/workspace"], forceReload: true });
    const turnStart = harness.calls.find(
      ({ method }) => method === "turn/start",
    )?.params as {
      readonly clientUserMessageId: string;
      readonly input: readonly {
        readonly type: string;
        readonly text?: string;
        readonly text_elements?: readonly unknown[];
        readonly name?: string;
        readonly path?: string;
      }[];
    };
    expect(turnStart.input).toHaveLength(4);
    expect(turnStart.input[0]).toEqual({
      type: "skill",
      name: "review",
      path,
    });
    expect(
      inspectStagedAttachmentManifest(turnStart.input[1]!.text!, {
        key: toolProvenanceKey,
        correlation: turnStart.clientUserMessageId,
      }),
    ).toMatchObject({
      type: "authenticated",
      attachments: [
        {
          id: stagedAttachment.id,
          fileName: stagedAttachment.fileName,
          kind: "file",
        },
      ],
    });
    expect(
      inspectCodexContextExcerptCarrier(turnStart.input[2]!.text!, {
        toolProvenanceKey,
        clientUserMessageId: turnStart.clientUserMessageId,
      }),
    ).toMatchObject({
      type: "authenticated",
      contextExcerpts: [
        expect.objectContaining({
          excerpt: "return legacyValue;",
          note: "Replace this legacy path.",
        }),
      ],
    });
    expect(turnStart.input[3]).toEqual({
      type: "text",
      text: renderTaskContextsForModel([taskContext], "please inspect"),
      text_elements: [],
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it.each([
    ["with text", "please inspect", true],
    ["without text", "", false],
    ["with whitespace-only text", " \n ", false],
  ] as const)(
    "resolves a selected skill immediately before submit %s and sends native structured input",
    async (_label, text, includesText) => {
      const harness = new RpcHarness();
      const handle = await attachIdle(harness);
      await establish(harness, handle);
      const path = "/private/codex/skills/review/SKILL.md";
      harness.enqueue("skills/list", {
        data: [
          {
            cwd: "/workspace",
            skills: [
              {
                name: "review",
                description: "Review changes",
                path,
                scope: "user",
                enabled: true,
              },
            ],
            errors: [],
          },
        ],
      });
      harness.enqueue("turn/start", {
        turn: {
          ...nativeTurn(1),
          items: [],
          itemsView: "notLoaded",
          status: "inProgress",
          completedAt: null,
        },
      });

      await handle.submit({
        applicationOperationId: `skill-submit-${_label}`,
        source: { kind: "user" },
        mutationId: `skill-submit-${_label}`,
        reconciliationToken: `skill-submit-${_label}`,
        taskContexts: [],
        contextExcerpts: [],
        attachments: [],
        selectedSkillId: codexSkillId("review", path),
        text,
      });

      expect(
        harness.calls.find(({ method }) => method === "turn/start")?.params,
      ).toMatchObject({
        input: [
          { type: "skill", name: "review", path },
          ...(includesText ? [{ type: "text", text, text_elements: [] }] : []),
        ],
      });
      harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
      await handle.close();
    },
  );

  it("rejects a selected system skill before sending a native turn", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    const path = "/private/codex/skills/.system/skill-creator/SKILL.md";
    harness.enqueue("skills/list", {
      data: [
        {
          cwd: "/workspace",
          skills: [
            {
              name: "skill-creator",
              description: "Create Codex skills",
              path,
              scope: "system",
              enabled: true,
            },
          ],
          errors: [],
        },
      ],
    });

    await expect(
      handle.submit({
        applicationOperationId: "system-skill-submit-operation",
        source: { kind: "user" },
        mutationId: "system-skill-submit-mutation",
        reconciliationToken: "system-skill-submit-token",
        taskContexts: [],
        contextExcerpts: [],
        attachments: [],
        selectedSkillId: codexSkillId("skill-creator", path),
        text: "Use the selected skill",
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "codex_skill_unavailable",
    });
    expect(harness.calls.some(({ method }) => method === "turn/start")).toBe(
      false,
    );

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("rejects a stale hidden OpenAI skill selection before sending a native turn", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    const path = "/private/plugins/visualize/visualize/SKILL.md";
    harness.enqueue("skills/list", {
      data: [
        {
          cwd: "/workspace",
          skills: [
            {
              name: "visualize:visualize",
              description: "Create a visualization",
              path,
              scope: "user",
              enabled: true,
            },
          ],
          errors: [],
        },
      ],
    });

    await expect(
      handle.submit({
        applicationOperationId: "hidden-skill-submit-operation",
        source: { kind: "user" },
        mutationId: "hidden-skill-submit-mutation",
        reconciliationToken: "hidden-skill-submit-token",
        taskContexts: [],
        contextExcerpts: [],
        attachments: [],
        selectedSkillId: codexSkillId("visualize:visualize", path),
        text: "Use the selected skill",
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "codex_skill_unavailable",
    });
    expect(harness.calls.some(({ method }) => method === "turn/start")).toBe(
      false,
    );

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("omits an empty native text part for an excerpt-only submission", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });

    await handle.submit({
      applicationOperationId: "excerpt-only-submit-operation",
      source: { kind: "user" },
      mutationId: "excerpt-only-submit-mutation",
      reconciliationToken: "excerpt-only-submit-token",
      taskContexts: [],
      contextExcerpts: [
        {
          id: "daac8c45-363a-40be-8626-3994a54da854",
          excerpt: "const legacyValue = readLegacy();",
          note: "Replace this path.",
          source: {
            kind: "workspace_file",
            rootId: "primary",
            path: "src/value.ts",
            revision: "revision-3",
          },
          locator: { kind: "line_range", startLine: 12, endLine: 12 },
        },
      ],
      attachments: [],
      text: "",
    });

    const turnStart = harness.calls.find(
      ({ method }) => method === "turn/start",
    )?.params as {
      readonly clientUserMessageId: string;
      readonly input: readonly {
        readonly type: string;
        readonly text?: string;
      }[];
    };
    expect(turnStart.input).toHaveLength(1);
    expect(
      inspectCodexContextExcerptCarrier(turnStart.input[0]!.text!, {
        toolProvenanceKey,
        clientUserMessageId: turnStart.clientUserMessageId,
      }),
    ).toMatchObject({
      type: "authenticated",
      contextExcerpts: [
        expect.objectContaining({ note: "Replace this path." }),
      ],
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("omits an empty native text part for excerpt-only steering", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    const submitted = await handle.submit({
      applicationOperationId: "excerpt-only-steer-submit-operation",
      source: { kind: "user" },
      mutationId: "excerpt-only-steer-submit-mutation",
      reconciliationToken: "excerpt-only-steer-submit-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "Start the work.",
    });
    harness.enqueue("turn/steer", { turnId: "turn-1" });

    await handle.steer({
      applicationOperationId: "excerpt-only-steer-operation",
      mutationId: "excerpt-only-steer-mutation",
      reconciliationToken: "excerpt-only-steer-token",
      target: { kind: "turn", turnId: submitted.backendTurnId! },
      taskContexts: [],
      contextExcerpts: [
        {
          id: "004dbbb3-f00a-4dbe-b341-c8070b1e32f5",
          excerpt: "return legacyValue;",
          note: "Apply this clarification.",
          source: {
            kind: "conversation_message",
            itemId: "normalized-user-item-2",
            itemRevision: 6,
          },
          locator: {
            kind: "text_quote",
            prefix: "Earlier: ",
            suffix: " Continue.",
          },
        },
      ],
      attachments: [],
      text: "",
    });

    const turnSteer = harness.calls.find(
      ({ method }) => method === "turn/steer",
    )?.params as {
      readonly clientUserMessageId: string;
      readonly input: readonly {
        readonly type: string;
        readonly text?: string;
      }[];
    };
    expect(turnSteer.input).toHaveLength(1);
    expect(
      inspectCodexContextExcerptCarrier(turnSteer.input[0]!.text!, {
        toolProvenanceKey,
        clientUserMessageId: turnSteer.clientUserMessageId,
      }),
    ).toMatchObject({
      type: "authenticated",
      contextExcerpts: [
        expect.objectContaining({ note: "Apply this clarification." }),
      ],
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("classifies only exact Codex stale-target Steer rejections for queue fallback", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    const submitted = await handle.submit({
      applicationOperationId: "stale-steer-submit-operation",
      source: { kind: "user" },
      mutationId: "stale-steer-submit-mutation",
      reconciliationToken: "stale-steer-submit-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "Start the work.",
    });
    const staleCases = [
      {
        message: "no active turn to steer",
        backendCode: "codex_steer_no_active_turn",
      },
      {
        message: "expected active turn id `turn-1` but found `turn-2`",
        backendCode: "codex_steer_expected_turn_mismatch",
      },
    ] as const;

    for (const [index, expected] of staleCases.entries()) {
      harness.enqueue(
        "turn/steer",
        new CodexRpcRemoteError({
          code: -32600,
          message: expected.message,
          generation: 1,
          method: "turn/steer",
        }),
      );
      const rejected = await handle
        .steer({
          applicationOperationId: `stale-steer-operation-${index}`,
          mutationId: `stale-steer-mutation-${index}`,
          reconciliationToken: `stale-steer-token-${index}`,
          target: { kind: "turn", turnId: submitted.backendTurnId! },
          taskContexts: [],
          contextExcerpts: [],
          attachments: [],
          text: "Clarify the active work.",
        })
        .catch((error: unknown) => error);
      expect(rejected).toMatchObject({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        backendCode: expected.backendCode,
        steerRejectionReason: "target_no_longer_active",
      });
    }

    const genericCases = [
      {
        code: -32600,
        method: "turn/steer",
        message: "input must not be empty",
      },
      {
        code: -32600,
        method: "turn/steer",
        message: "expected active turn id `a` but found `b` extra",
      },
      {
        code: -32600,
        method: "turn/steer",
        message: "expected active turn id `a` but found `b\ncontinued`",
      },
      {
        code: -32602,
        method: "turn/steer",
        message: "no active turn to steer",
      },
      {
        code: -32600,
        method: "turn/start",
        message: "no active turn to steer",
      },
    ] as const;

    for (const [index, genericCase] of genericCases.entries()) {
      harness.enqueue(
        "turn/steer",
        new CodexRpcRemoteError({
          ...genericCase,
          generation: 1,
        }),
      );
      const generic = await handle
        .steer({
          applicationOperationId: `generic-steer-operation-${index}`,
          mutationId: `generic-steer-mutation-${index}`,
          reconciliationToken: `generic-steer-token-${index}`,
          target: { kind: "turn", turnId: submitted.backendTurnId! },
          taskContexts: [],
          contextExcerpts: [],
          attachments: [],
          text: "Still nonempty.",
        })
        .catch((error: unknown) => error);
      expect(generic).toMatchObject({
        category: "rejected",
        crossedSubmissionBoundary: false,
        backendCode: `codex_remote_${genericCase.code}`,
      });
      expect((generic as BackendError).steerRejectionReason).toBeUndefined();
    }

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("rejects a fully empty submit before crossing the Codex boundary", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);

    await expect(
      handle.submit({
        applicationOperationId: "empty-submit-operation",
        source: { kind: "user" },
        mutationId: "empty-submit-mutation",
        reconciliationToken: "empty-submit-token",
        taskContexts: [],
        contextExcerpts: [],
        attachments: [],
        text: " \n ",
      }),
    ).rejects.toMatchObject({ backendCode: "codex_submission_empty" });
    expect(harness.calls.some(({ method }) => method === "turn/start")).toBe(
      false,
    );

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("sends trims-to-empty skill steering as one native structured input", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    const submitted = await handle.submit({
      applicationOperationId: "skill-steer-start",
      source: { kind: "user" },
      mutationId: "skill-steer-start",
      reconciliationToken: "skill-steer-start",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "start",
    });
    const path = "/private/codex/skills/review/SKILL.md";
    harness.enqueue("skills/list", {
      data: [
        {
          cwd: "/workspace",
          skills: [
            {
              name: "review",
              description: "Review changes",
              path,
              scope: "user",
              enabled: true,
            },
          ],
          errors: [],
        },
      ],
    });
    harness.enqueue("turn/steer", { turnId: "turn-1" });

    await handle.steer({
      applicationOperationId: "skill-steer-operation",
      mutationId: "skill-steer-mutation",
      reconciliationToken: "skill-steer-token",
      target: { kind: "turn", turnId: submitted.backendTurnId! },
      selectedSkillId: codexSkillId("review", path),
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: " \n ",
    });

    expect(
      harness.calls.find(({ method }) => method === "turn/steer")?.params,
    ).toMatchObject({
      input: [{ type: "skill", name: "review", path }],
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("sends the exact workspace model, effort, approval, and sandbox tuple", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const settings = executionSettingsProvider({
      freezeOperationSnapshot: () => ({
        settings: executionSettingsTuple({
          reasoningEffort: "high",
          sandboxMode: "workspace-write",
          networkAccess: "enabled",
          approvalPolicy: "on-request",
        }),
      }),
      observeEffective,
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        settings,
      ),
    );
    await establish(harness, handle);
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });

    await handle.submit({
      applicationOperationId: "workspace-submit",
      source: { kind: "user" },
      mutationId: "workspace-mutation",
      reconciliationToken: "workspace-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "work",
    });
    expect(
      harness.calls.find(({ method }) => method === "turn/start")?.params,
    ).toMatchObject({
      model: "gpt-5.6",
      effort: "high",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    });
    expect(observeEffective).toHaveBeenLastCalledWith(
      scope,
      expect.objectContaining({
        settings: {
          model: "gpt-5.6",
          reasoningEffort: "high",
          serviceTier: "standard",
          serviceTierClassification: "recognized",
          sandboxMode: "workspace-write",
          sandboxClassification: "recognized",
          networkAccess: "enabled",
          networkClassification: "recognized",
          approvalPolicy: "on-request",
          approvalPolicyClassification: "recognized",
          approvalReviewer: "user",
          approvalReviewerClassification: "recognized",
          policyObservation: "complete",
        },
      }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("publishes receipt-confirmed execution settings that enable branching", async () => {
    const harness = new RpcHarness();
    let acceptReceiptConfirmation = false;
    let confirmed = false;
    let settingsRevision = 1;
    const confirmedSettings = executionSettingsTuple();
    const settings = executionSettingsProvider({
      forkSettingsEligibility: () =>
        confirmed
          ? {
              availability: "available" as const,
              settingsRevision,
              settings: confirmedSettings,
            }
          : {
              availability: "unavailable" as const,
              settingsRevision,
              reason: "confirmation_unavailable" as const,
            },
      observeEffective: () => {
        if (!acceptReceiptConfirmation) return;
        confirmed = true;
        settingsRevision = 2;
      },
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        settings,
      ),
    );
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));
    expect((await handle.backendCapabilities()).branching).toMatchObject({
      availability: "unavailable",
    });

    acceptReceiptConfirmation = true;
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    await handle.submit({
      applicationOperationId: "receipt-confirmed-submit",
      source: { kind: "user" },
      mutationId: "receipt-confirmed-mutation",
      reconciliationToken: "receipt-confirmed-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "work",
    });

    expect(
      events.filter(({ type }) => type === "capabilities_changed"),
    ).toEqual([
      expect.objectContaining({
        type: "capabilities_changed",
        capabilities: expect.objectContaining({
          revision: expect.stringContaining(":available:2"),
          branching: expect.objectContaining({ availability: "available" }),
        }),
      }),
    ]);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("prefers a full settings notification that races an accepted turn receipt", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const settings = executionSettingsProvider({
      freezeOperationSnapshot: () => ({
        settings: executionSettingsTuple({
          reasoningEffort: "high",
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
        }),
      }),
      observeEffective,
    });
    const handle = await attachIdle(
      harness,
      driver(
        harness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        settings,
      ),
    );
    await establish(harness, handle);
    observeEffective.mockClear();
    harness.enqueue(
      "turn/start",
      (_params: unknown, activeHarness: RpcHarness) => {
        activeHarness.notify("thread/settings/updated", {
          threadId: "thread-1",
          threadSettings: {
            cwd: workspace.canonicalPath,
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "dangerFullAccess" },
            activePermissionProfile: null,
            model: "gpt-5.6",
            modelProvider: "openai",
            serviceTier: "default",
            effort: "high",
            summary: null,
            collaborationMode: {
              mode: "default",
              settings: {
                model: "gpt-5.6",
                reasoning_effort: "high",
                developer_instructions: null,
              },
            },
            multiAgentMode: "explicitRequestOnly",
            personality: null,
          },
        });
        return {
          turn: {
            ...nativeTurn(1),
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            completedAt: null,
          },
        };
      },
    );

    await handle.submit({
      applicationOperationId: "racing-settings-submit",
      source: { kind: "user" },
      mutationId: "racing-settings-mutation",
      reconciliationToken: "racing-settings-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "work",
    });

    // The plain effective confirmation is followed by the desired
    // reconciliation: the recognized native tuple is always offered as an
    // import candidate now, not only when the durable row is empty.
    expect(observeEffective).toHaveBeenCalledTimes(2);
    expect(observeEffective).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        settings: {
          model: "gpt-5.6",
          reasoningEffort: "high",
          serviceTier: "standard",
          serviceTierClassification: "recognized",
          sandboxMode: "danger-full-access",
          sandboxClassification: "recognized",
          networkAccess: "enabled",
          networkClassification: "recognized",
          approvalPolicy: "never",
          approvalPolicyClassification: "recognized",
          approvalReviewer: "user",
          approvalReviewerClassification: "recognized",
          policyObservation: "complete",
        },
      }),
    );
    expect(observeEffective).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        initializeDesired: {
          model: "gpt-5.6",
          reasoningEffort: "high",
          serviceTier: "standard",
          sandboxMode: "danger-full-access",
          networkAccess: "enabled",
          approvalPolicy: "never",
          approvalReviewer: "user",
        },
      }),
    );
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("correlates submit and steer completion across a fresh projection", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(
      harness,
      driverWithComposerSkillPreferences(harness, {
        read: () => ({ showOpenAIComposerSkills: true, revision: 1 }),
      }),
    );
    const established = await establish(harness, handle);
    const events: BackendConversationEvent[] = [];
    established.subscribeFromNext(({ event }) => events.push(event));

    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    const submitted = await handle.submit({
      applicationOperationId: "submit-operation",
      source: { kind: "user" },
      mutationId: "submit-mutation",
      reconciliationToken: "submit-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "hello",
    });
    const steerExcerpt = {
      id: "c43be720-4f91-4bdd-ae1c-f0119462943e",
      excerpt: "old implementation",
      note: "Use this clarification.",
      source: {
        kind: "conversation_diff" as const,
        itemId: "file-change-1",
        itemRevision: 3,
        path: "src/value.ts",
      },
      locator: {
        kind: "diff_line_range" as const,
        start: { side: "old" as const, line: 4 },
        end: { side: "new" as const, line: 5 },
      },
    };
    const steerSkillPath = "/private/plugins/visualize/visualize/SKILL.md";
    harness.enqueue("skills/list", {
      data: [
        {
          cwd: "/workspace",
          skills: [
            {
              name: "visualize:visualize",
              description: "Create a visualization",
              path: steerSkillPath,
              scope: "user",
              enabled: true,
            },
          ],
          errors: [],
        },
      ],
    });
    harness.enqueue("turn/steer", { turnId: "turn-1" });
    await handle.steer({
      applicationOperationId: "steer-operation",
      mutationId: "steer-mutation",
      reconciliationToken: "steer-token",
      target: { kind: "turn", turnId: submitted.backendTurnId! },
      selectedSkillId: codexSkillId("visualize:visualize", steerSkillPath),
      taskContexts: [],
      contextExcerpts: [steerExcerpt],
      attachments: [stagedAttachment],
      text: renderTaskContextsForModel([taskContext], "clarification"),
    });

    const submissionClientId = (
      harness.calls.find(({ method }) => method === "turn/start")!.params as {
        clientUserMessageId: string;
      }
    ).clientUserMessageId;
    const steeringParams = harness.calls.find(
      ({ method }) => method === "turn/steer",
    )!.params as {
      clientUserMessageId: string;
      input: Extract<
        CodexThread["turns"][number]["items"][number],
        {
          type: "userMessage";
        }
      >["content"];
    };
    const steeringClientId = steeringParams.clientUserMessageId;
    expect(steeringParams.input).toHaveLength(4);
    expect(steeringParams.input[0]).toEqual({
      type: "skill",
      name: "visualize:visualize",
      path: steerSkillPath,
    });
    const attachmentCarrier = steeringParams.input[1]!;
    if (attachmentCarrier.type !== "text") {
      throw new Error("steering attachment carrier missing");
    }
    expect(
      inspectStagedAttachmentManifest(attachmentCarrier.text, {
        key: toolProvenanceKey,
        correlation: steeringClientId,
      }),
    ).toMatchObject({
      type: "authenticated",
      attachments: [
        {
          id: stagedAttachment.id,
          fileName: stagedAttachment.fileName,
          kind: "file",
        },
      ],
    });
    const excerptCarrier = steeringParams.input[2]!;
    if (excerptCarrier.type !== "text") {
      throw new Error("steering excerpt carrier missing");
    }
    expect(
      inspectCodexContextExcerptCarrier(excerptCarrier.text, {
        toolProvenanceKey,
        clientUserMessageId: steeringClientId,
      }),
    ).toMatchObject({
      type: "authenticated",
      contextExcerpts: [steerExcerpt],
    });
    expect(steeringParams.input[3]).toEqual({
      type: "text",
      text: renderTaskContextsForModel([taskContext], "clarification"),
      text_elements: [],
    });
    harness.notify("turn/completed", {
      threadId: "thread-1",
      turn: {
        ...nativeTurn(1),
        items: [
          {
            type: "userMessage",
            id: "submit-message",
            clientId: submissionClientId,
            content: [{ type: "text", text: "hello", text_elements: [] }],
          },
          {
            type: "userMessage",
            id: "steer-message",
            clientId: steeringClientId,
            content: steeringParams.input,
          },
        ],
      },
    });

    expect(events).toContainEqual({
      type: "turn_completed",
      turn: expect.objectContaining({
        completionCorrelations: ["submit-operation", "steer-operation"],
      }),
    });
    const current = (await handle.readCurrent()).snapshot;
    expect(
      current.turnsById[current.orderedBackendTurnIds.at(-1)!]!
        .completionCorrelations,
    ).toEqual(["submit-operation", "steer-operation"]);
    expect(
      Object.values(current.itemsById).find(
        (item) =>
          item.semanticKind === "user_message" &&
          item.content.some((part) => part.kind === "context_excerpt"),
      ),
    ).toMatchObject({
      semanticKind: "user_message",
      deliveryOperationId: "steer-operation",
      content: [
        { kind: "skill", name: { text: "visualize:visualize" } },
        {
          kind: "attachment",
          attachment: {
            id: stagedAttachment.id,
            fileName: stagedAttachment.fileName,
            kind: "file",
          },
        },
        { kind: "context_excerpt", excerpt: steerExcerpt },
        {
          kind: "text",
          text: {
            text: renderTaskContextsForModel([taskContext], "clarification"),
          },
        },
      ],
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("classifies a lost submit response as crossed-boundary unknown and never retries", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    harness.enqueue(
      "turn/start",
      new CodexRpcDeliveryError({
        code: "codex_generation_closed",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "turn/start",
      }),
    );
    const input = {
      applicationOperationId: "submit-operation",
      mutationId: "mutation",
      source: { kind: "user" as const },
      reconciliationToken: "submit-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "hello",
    };
    await expect(handle.submit(input)).rejects.toMatchObject({
      category: "submission_unknown",
      crossedSubmissionBoundary: true,
      retryable: true,
    });
    await expect(
      handle.submit({
        ...input,
        taskContexts: [taskContext],
        attachments: [],
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "codex_submission_replay_mismatch",
    });
    await expect(handle.submit(input)).rejects.toMatchObject({
      category: "submission_unknown",
      crossedSubmissionBoundary: true,
      retryable: true,
    });
    expect(
      harness.calls.filter(({ method }) => method === "turn/start"),
    ).toHaveLength(1);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("reconciles a lost rename from authoritative title without repeating it", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue(
      "thread/name/set",
      new CodexRpcDeliveryError({
        code: "codex_response_lost",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "thread/name/set",
      }),
    );
    const action = {
      applicationOperationId: "lost-rename",
      action: "rename" as const,
      title: "Renamed despite lost response",
    };

    await expect(handle.perform(action)).rejects.toMatchObject({
      crossedSubmissionBoundary: true,
    });
    harness.enqueue("thread/read", {
      thread: nativeThread({ name: action.title }),
    });
    await expect(handle.reconcileAction(action)).resolves.toEqual({
      outcome: "accepted",
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/name/set"),
    ).toHaveLength(1);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("proves a rename not applied when the authoritative title differs", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    const action = {
      applicationOperationId: "pending-rename",
      action: "rename" as const,
      title: "Desired title",
    };
    harness.enqueue("thread/read", {
      thread: nativeThread({ name: "Current title" }),
    });

    await expect(handle.reconcileAction(action)).resolves.toEqual({
      outcome: "not_applied",
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("keeps lost compaction unknown across reattach without repeating it", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const first = await attachIdle(harness, target);
    await establish(harness, first);
    harness.enqueue(
      "thread/compact/start",
      new CodexRpcDeliveryError({
        code: "codex_response_lost",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "thread/compact/start",
      }),
    );
    const action = {
      applicationOperationId: "lost-compact",
      action: "compact" as const,
    };

    await expect(first.perform(action)).rejects.toMatchObject({
      crossedSubmissionBoundary: true,
    });
    await expect(first.reconcileAction(action)).resolves.toEqual({
      outcome: "unknown",
    });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await first.close();

    const second = await attachIdle(harness, target);
    await establish(harness, second);
    await expect(second.reconcileAction(action)).resolves.toEqual({
      outcome: "unknown",
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/compact/start"),
    ).toHaveLength(1);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await second.close();
  });

  it("keeps a lost interrupt unknown while the exact target remains active", async () => {
    const harness = new RpcHarness();
    const activeTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: [] },
      turns: [activeTurn],
    });
    const handle = (await driver(harness).attach(
      attachInput(),
    )) as CodexConversationHandle;
    const established = await establish(harness, handle, activeThread);
    const input = {
      applicationOperationId: "lost-interrupt",
      expectedBackendTurnId: established.snapshot.activeBackendTurnId!,
    };
    harness.enqueue(
      "turn/interrupt",
      new CodexRpcDeliveryError({
        code: "codex_response_lost",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "turn/interrupt",
      }),
    );

    await expect(handle.interrupt(input)).rejects.toMatchObject({
      crossedSubmissionBoundary: true,
    });
    harness.enqueue("thread/read", { thread: activeThread });
    await expect(handle.reconcileInterrupt(input)).resolves.toEqual({
      outcome: "unknown",
    });
    expect(
      harness.calls.filter(({ method }) => method === "turn/interrupt"),
    ).toHaveLength(1);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("captures the submission retry anchor from established state without a thread read", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);
    const callsBefore = harness.calls.length;

    const retryAnchor = await handle.captureSubmissionRetryAnchor();

    // The anchor is computed from the established authoritative thread —
    // no thread/read RPC, and identical bytes to a fresh-read anchor.
    expect(retryAnchor).toBe(
      serializeCodexSubmissionRetryAnchor(nativeThread()),
    );
    expect(harness.calls.slice(callsBefore)).toEqual([]);

    // Submitting through this handle marks the cached thread active; the
    // anchor then fails closed from cached state, again without a read.
    harness.enqueue("turn/start", () => ({
      turn: {
        ...nativeTurn(2),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    }));
    const submitted = await handle.submit({
      applicationOperationId: "anchor-active-submit",
      source: { kind: "user" },
      mutationId: "anchor-active-mutation",
      reconciliationToken: "anchor-active-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "start work",
    });
    expect(submitted.backendTurnId).toBe(
      codexBackendTurnId("thread-1", "turn-2"),
    );
    const callsAfterSubmit = harness.calls.length;
    await expect(handle.captureSubmissionRetryAnchor()).rejects.toMatchObject({
      backendCode: "codex_submission_anchor_thread_active",
    });
    expect(harness.calls.slice(callsAfterSubmit)).toEqual([]);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("rejects unknown interactions and every operation after close", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const response = {
      applicationOperationId: "operation",
      interactionId: "interaction",
      kind: "cancel" as const,
    };
    await expect(handle.respond(response)).rejects.toMatchObject({
      backendCode: "codex_interaction_not_pending",
      crossedSubmissionBoundary: false,
    });
    await expect(
      handle.reconcileInteractionResponse(response),
    ).resolves.toEqual({ outcome: "unknown" });
    await handle.close();
    await expect(handle.captureSubmissionRetryAnchor()).rejects.toMatchObject({
      backendCode: "codex_conversation_closed",
    });
  });

  it("owns active native requests and resolves them through the interaction boundary", async () => {
    const harness = new RpcHarness();
    const activeTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
      items: [
        {
          type: "commandExecution" as const,
          id: "item-command",
          pluginId: null,
          scriptPath: null,
          command: "npm test",
          cwd: "/workspace",
          processId: null,
          source: "agent" as const,
          status: "inProgress" as const,
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      ],
    };
    const activeThread = nativeThread({
      status: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
      turns: [activeTurn],
    });
    const handle = await driver(harness).attach(attachInput());
    harness.enqueue("thread/read", { thread: activeThread });
    harness.enqueue("thread/resume", resumeResult(activeThread));
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: BackendConversationEvent[] = [];
    handle.subscribe((event) => events.push(event));

    const serverHandler =
      harness.serverRequests.handlersForGeneration(1)[
        "item/commandExecution/requestApproval"
      ]!;
    const pending = serverHandler(
      attestedServerRequest({
        generation: 1,
        sequence: 20,
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: activeTurn.id,
          itemId: "item-command",
          startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
          environmentId: null,
          command: "npm test",
          cwd: "/workspace",
          availableDecisions: ["accept", "cancel"],
        },
        signal: new AbortController().signal,
      } satisfies CodexInboundServerRequest),
    );
    await vi.waitFor(() =>
      expect(events.some(({ type }) => type === "interaction_opened")).toBe(
        true,
      ),
    );
    const opened = events.find((event) => event.type === "interaction_opened");
    if (opened?.type !== "interaction_opened") {
      throw new Error("codex interaction did not open");
    }
    const response = {
      applicationOperationId: "approval-operation",
      interactionId: opened.interaction.backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "accept",
    };
    const confirmation = handle.respond(response);
    await expect(pending).resolves.toEqual({ decision: "accept" });
    expect(events).not.toContainEqual({
      type: "interaction_resolved",
      backendInteractionId: opened.interaction.backendInteractionId,
    });
    await expect(
      handle.reconcileInteractionResponse(response),
    ).resolves.toEqual({ outcome: "unknown" });

    harness.notify("serverRequest/resolved", {
      threadId: "thread-1",
      requestId: "approval-1",
    });
    await expect(confirmation).resolves.toBeUndefined();
    await expect(
      handle.reconcileInteractionResponse(response),
    ).resolves.toEqual({ outcome: "accepted" });
    expect(events).toContainEqual({
      type: "interaction_resolved",
      backendInteractionId: opened.interaction.backendInteractionId,
    });
    expect(await handle.backendCapabilities()).toMatchObject({
      nonblockingQuestions: true,
      providerOutputArtifacts: { nativeImage: true },
      interactionKinds: [
        "choice",
        "confirmation",
        "text_input",
        "editor",
        "decision",
        "questionnaire",
        "form",
      ],
      effectiveSettings: {
        model: {
          provider: connection.id,
          id: "gpt-5.6",
        },
      },
    });

    const interruptedRequest = new AbortController();
    const lostProviderRequest = serverHandler(
      attestedServerRequest({
        generation: 1,
        sequence: 21,
        id: "approval-2",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: activeTurn.id,
          itemId: "item-command",
          startedAtMs: Date.parse("2026-07-31T00:00:01.000Z"),
          environmentId: null,
          command: "npm test",
          cwd: "/workspace",
        },
        signal: interruptedRequest.signal,
      } satisfies CodexInboundServerRequest),
    );
    await vi.waitFor(() =>
      expect(
        events.filter(({ type }) => type === "interaction_opened"),
      ).toHaveLength(2),
    );
    const lostOpened = events.filter(
      (event) => event.type === "interaction_opened",
    )[1];
    if (lostOpened?.type !== "interaction_opened") {
      throw new Error("second Codex interaction did not open");
    }
    const lostResponse = {
      applicationOperationId: "approval-operation-lost",
      interactionId: lostOpened.interaction.backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "decline",
    };
    const lostConfirmation = handle.respond(lostResponse);
    await expect(lostProviderRequest).resolves.toEqual({
      decision: "decline",
    });
    interruptedRequest.abort(new Error("turn interrupted"));
    const lostError = await lostConfirmation.catch((error: unknown) => error);
    expect(lostError).toMatchObject({
      crossedSubmissionBoundary: true,
      backendCode: "codex_interaction_response_confirmation_lost",
    });
    expect(lostError).toBeInstanceOf(BackendError);
    if (!(lostError instanceof BackendError)) {
      throw new Error("expected mapped backend error");
    }
    harness.notify("serverRequest/resolved", {
      threadId: "thread-1",
      requestId: "approval-2",
    });
    await expect(lostError.lateMutationReconciliation).resolves.toEqual({
      outcome: "accepted",
    });
    await expect(
      handle.reconcileInteractionResponse(lostResponse),
    ).resolves.toEqual({ outcome: "accepted" });
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("replays a pending approval opened while replacing the projection", async () => {
    const harness = new RpcHarness();
    const staleTurn = {
      ...nativeTurn(0),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
    };
    const activeTurn = {
      ...nativeTurn(2),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
      items: [
        {
          type: "commandExecution" as const,
          id: "item-command",
          pluginId: null,
          scriptPath: null,
          command: "npm test",
          cwd: "/workspace",
          processId: null,
          source: "agent" as const,
          status: "inProgress" as const,
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      ],
    };
    const activeThread = nativeThread({
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      turns: [staleTurn, nativeTurn(1), activeTurn],
    });
    const handle = await driver(harness).attach(attachInput());
    const initial = await establish(harness, handle, activeThread);
    const unsubscribeInitial = initial.subscribeFromNext(() => undefined);
    const serverHandler =
      harness.serverRequests.handlersForGeneration(1)[
        "item/commandExecution/requestApproval"
      ]!;
    let pending: Promise<unknown> | undefined;
    harness.after("thread/resume", () => {
      pending = Promise.resolve(
        serverHandler(
          attestedServerRequest({
            generation: 1,
            sequence: 20,
            id: "approval-during-resume",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: activeTurn.id,
              itemId: "item-command",
              startedAtMs: Date.parse("2026-07-31T00:00:00.000Z"),
              environmentId: null,
              command: "npm test",
              cwd: "/workspace",
              availableDecisions: ["accept", "decline"],
            },
            signal: new AbortController().signal,
          } satisfies CodexInboundServerRequest),
        ),
      );
    });

    const replacement = await establish(harness, handle, activeThread);
    unsubscribeInitial();
    const replacementEvents: BackendConversationEvent[] = [];
    replacement.subscribeFromNext(({ event }) => replacementEvents.push(event));

    const opened = replacementEvents.find(
      (event) => event.type === "interaction_opened",
    );
    expect(opened).toMatchObject({ type: "interaction_opened" });
    if (opened?.type !== "interaction_opened" || !pending) {
      throw new Error("pending approval was not replayed");
    }
    const confirmation = handle.respond({
      applicationOperationId: "resume-approval-response",
      interactionId: opened.interaction.backendInteractionId,
      kind: "decision",
      selectedActionId: "decline",
    });
    await expect(pending).resolves.toEqual({ decision: "decline" });
    harness.notify("serverRequest/resolved", {
      threadId: "thread-1",
      requestId: "approval-during-resume",
    });
    await expect(confirmation).resolves.toBeUndefined();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("rejects a legacy approval when the owned thread has no active turn", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    await establish(harness, handle);

    await expect(
      harness.serverRequests.handlersForGeneration(1)["execCommandApproval"]!(
        attestedServerRequest({
          generation: 1,
          sequence: 21,
          id: "idle-legacy-exec-approval",
          method: "execCommandApproval",
          params: {
            conversationId: "thread-1",
            callId: "idle-exec-call",
            approvalId: "idle-exec-approval",
            command: ["touch", "/home/example/testfile"],
            cwd: "/workspace",
            reason: "Write outside the workspace",
            parsedCmd: [],
          },
          signal: new AbortController().signal,
        } satisfies CodexInboundServerRequest),
      ),
    ).rejects.toMatchObject({
      code: "codex_server_request_native_identity_unowned",
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("opens an approval that arrives before its native item is projected", async () => {
    const harness = new RpcHarness();
    const activeTurn = {
      ...nativeTurn(1),
      status: "inProgress" as const,
      completedAt: null,
      durationMs: null,
      items: [],
    };
    const activeThread = nativeThread({
      status: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
      turns: [activeTurn],
    });
    const handle = await driver(harness).attach(attachInput());
    harness.enqueue("thread/read", { thread: activeThread });
    harness.enqueue("thread/resume", resumeResult(activeThread));
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: BackendConversationEvent[] = [];
    handle.subscribe((event) => events.push(event));

    const pending = harness.serverRequests.handlersForGeneration(1)[
      "item/permissions/requestApproval"
    ]!(
      attestedServerRequest({
        generation: 1,
        sequence: 22,
        id: "permission-approval-before-item",
        method: "item/permissions/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: activeTurn.id,
          itemId: "nested-custom-tool-item",
          environmentId: null,
          startedAtMs: Date.parse("2026-07-31T00:00:02.000Z"),
          cwd: "/workspace",
          reason: "Write outside the workspace",
          permissions: {
            network: null,
            fileSystem: {
              read: [],
              write: ["/home/example/testfile"],
            },
          },
        },
        signal: new AbortController().signal,
      } satisfies CodexInboundServerRequest),
    );

    await vi.waitFor(() =>
      expect(events.some(({ type }) => type === "interaction_opened")).toBe(
        true,
      ),
    );
    const opened = events.find((event) => event.type === "interaction_opened");
    if (opened?.type !== "interaction_opened") {
      throw new Error("Codex permission interaction did not open");
    }
    const response = {
      applicationOperationId: "deny-before-item-operation",
      interactionId: opened.interaction.backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "deny",
    };
    const confirmation = handle.respond(response);
    await expect(pending).resolves.toEqual({
      permissions: {},
      scope: "turn",
    });
    harness.notify("serverRequest/resolved", {
      threadId: "thread-1",
      requestId: "permission-approval-before-item",
    });
    await expect(confirmation).resolves.toBeUndefined();

    const legacyPending = harness.serverRequests.handlersForGeneration(1)[
      "execCommandApproval"
    ]!(
      attestedServerRequest({
        generation: 1,
        sequence: 23,
        id: "legacy-exec-approval",
        method: "execCommandApproval",
        params: {
          conversationId: "thread-1",
          callId: "nested-exec-call",
          approvalId: "nested-exec-approval",
          command: ["install", "source", "/home/example/testfile"],
          cwd: "/workspace",
          reason: "Write outside the workspace",
          parsedCmd: [],
        },
        signal: new AbortController().signal,
      } satisfies CodexInboundServerRequest),
    );
    await vi.waitFor(() =>
      expect(
        events.filter(({ type }) => type === "interaction_opened"),
      ).toHaveLength(2),
    );
    const legacyOpened = events.filter(
      (event) => event.type === "interaction_opened",
    )[1];
    if (legacyOpened?.type !== "interaction_opened") {
      throw new Error("Legacy Codex command interaction did not open");
    }
    const legacyResponse = {
      applicationOperationId: "legacy-exec-approval-operation",
      interactionId: legacyOpened.interaction.backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "accept",
    };
    const legacyConfirmation = handle.respond(legacyResponse);
    await expect(legacyPending).resolves.toEqual({ decision: "approved" });
    harness.notify("serverRequest/resolved", {
      threadId: "thread-1",
      requestId: "legacy-exec-approval",
    });
    await expect(legacyConfirmation).resolves.toBeUndefined();
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("reconciles an uncertain unsubscribe before releasing cross-profile ownership", async () => {
    const harness = new RpcHarness();
    const ownership = new CodexConversationOwnershipRegistry();
    const firstDriver = driver(harness, connection, ownership);
    const other = connectionProfile("profile-2", "template-2");
    const secondDriver = driver(harness, other, ownership);
    const first = await attachIdle(harness, firstDriver);

    harness.enqueue("thread/read", { thread: nativeThread() });
    await expect(secondDriver.attach(attachInput(other))).rejects.toMatchObject(
      {
        category: "invalid_state",
        backendCode: "codex_thread_already_attached",
      },
    );
    await first.close();

    const second = await secondDriver.attach(attachInput(other));
    await establish(harness, second);
    harness.enqueue(
      "thread/unsubscribe",
      new CodexRpcDeliveryError({
        code: "unsubscribe_lost",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "thread/unsubscribe",
      }),
      { status: "notSubscribed" },
    );
    await second.close();

    expect(
      harness.calls.filter(({ method }) => method === "thread/unsubscribe"),
    ).toHaveLength(2);
    expect(harness.retirements).toEqual([]);
    expect(ownership.size()).toBe(0);

    const replacement = await firstDriver.attach(attachInput());
    await replacement.close();
  });

  it("releases ownership without retiring siblings after bounded unsubscribe uncertainty", async () => {
    const harness = new RpcHarness();
    const ownership = new CodexConversationOwnershipRegistry();
    const reported: unknown[] = [];
    const target = driver(
      harness,
      connection,
      ownership,
      { type: "catalog" },
      executionSettingsProvider(),
      undefined,
      undefined,
      unavailableCodexAgentToolCliEnvironmentProvider,
      new CodexFastModeSessionRegistry(),
      undefined,
      (error) => reported.push(error),
    );
    const handle = await attachIdle(harness, target);
    await establish(harness, handle);
    const unsubscribeFailure = () =>
      new CodexRpcDeliveryError({
        code: "unsubscribe_lost",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "thread/unsubscribe",
      });
    harness.enqueue(
      "thread/unsubscribe",
      unsubscribeFailure(),
      unsubscribeFailure(),
    );

    await handle.close();

    expect(
      harness.calls.filter(({ method }) => method === "thread/unsubscribe"),
    ).toHaveLength(2);
    expect(harness.retirements).toEqual([]);
    expect(ownership.size()).toBe(0);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      category: "unavailable",
      backendCode: "codex_unsubscribe_reconciliation_unproven",
      retryable: true,
    });

    const replacement = await target.attach(attachInput());
    await replacement.close();
  });

  it("releases ownership when the subscribed generation is lost during unsubscribe", async () => {
    const harness = new RpcHarness();
    const ownership = new CodexConversationOwnershipRegistry();
    const target = driver(harness, connection, ownership);
    const handle = await attachIdle(harness, target);
    await establish(harness, handle);
    harness.enqueue(
      "thread/unsubscribe",
      (_params: unknown, activeHarness: RpcHarness) => {
        activeHarness.lifecycle("unavailable", 1);
        throw new CodexRpcDeliveryError({
          code: "unsubscribe_lost",
          delivery: "sent_outcome_unknown",
          generation: 1,
          method: "thread/unsubscribe",
        });
      },
    );

    await handle.close();

    expect(
      harness.calls.filter(({ method }) => method === "thread/unsubscribe"),
    ).toHaveLength(1);
    expect(harness.retirements).toEqual([]);
    expect(ownership.size()).toBe(0);
  });

  it("waits for an in-flight resume and unsubscribes before releasing ownership", async () => {
    const harness = new RpcHarness();
    const ownership = new CodexConversationOwnershipRegistry();
    const target = driver(harness, connection, ownership);
    const handle = await attachIdle(harness, target);
    let resolveResume!: (value: unknown) => void;
    const resumed = new Promise<unknown>((resolve) => {
      resolveResume = resolve;
    });
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", () => resumed);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    const establishment = handle.establishProjection({
      signal: new AbortController().signal,
    });
    await vi.waitFor(() =>
      expect(
        harness.calls.some(({ method }) => method === "thread/resume"),
      ).toBe(true),
    );
    const closing = handle.close();
    resolveResume(resumeResult());
    await expect(establishment).rejects.toMatchObject({
      backendCode: "codex_conversation_closed",
    });
    await closing;
    expect(harness.calls.at(-1)?.method).toBe("thread/unsubscribe");
    const replacement = await target.attach(attachInput());
    await replacement.close();
  });

  it("creates a provider-assigned thread without a prompt and single-flights concurrent starts", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const started = paginatedThread({
      id: "created-thread",
      threadSource: "create-correlation-1",
      turns: [],
    });
    let resolveStart!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    harness.enqueue("thread/start", () => pending);

    const first = target.create({
      scope,
      applicationThreadId: "application-create-1",
      applicationOperationId: "mutation-create-1",
      source: { kind: "user" },
      workspace,
      creationCorrelation: "create-correlation-1",
      title: "New thread",
    });
    const second = target.create({
      scope,
      applicationThreadId: "application-create-1",
      applicationOperationId: "mutation-create-1",
      source: { kind: "user" },
      workspace,
      creationCorrelation: "create-correlation-1",
      title: "New thread",
    });
    await vi.waitFor(() =>
      expect(
        harness.calls.some(({ method }) => method === "thread/start"),
      ).toBe(true),
    );
    expect(
      harness.calls.filter(({ method }) => method === "thread/start"),
    ).toHaveLength(1);
    expect(
      harness.calls.find(({ method }) => method === "thread/start")?.params,
    ).toEqual({
      model: "gpt-5.6",
      serviceTier: "default",
      cwd: workspace.canonicalPath,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      config: {
        model_reasoning_effort: "low",
        shell_environment_policy: scrubbedAgentToolShellEnvironmentPolicy,
      },
      ephemeral: false,
      historyMode: "paginated",
      threadSource: "create-correlation-1",
    });
    resolveStart({
      ...threadStartResult(started),
      futureResponseMetadata: { revision: 2 },
      thread: {
        ...started,
        futureThreadMetadata: { family: "codex" },
      },
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        backendConversationId: "created-thread",
        opaqueBindingDetail: serializeCodexBindingDetail({
          threadId: "created-thread",
          sessionId: started.sessionId,
          nativeAncestry: null,
          correlationAncestorThreadIds: [],
        }),
      }),
      expect.objectContaining({
        backendConversationId: "created-thread",
      }),
    ]);
    expect(
      harness.calls.filter(({ method }) => method === "thread/start"),
    ).toHaveLength(1);
    expect(
      harness.calls.filter(({ method }) => method === "thread/name/set"),
    ).toHaveLength(0);
  });

  it("does not retry or fall back when Codex rejects paginated thread creation", async () => {
    const harness = new RpcHarness();
    harness.enqueue(
      "thread/start",
      new CodexRpcRemoteError({
        code: -32602,
        message: "paginated history is unavailable for this store",
        generation: 1,
        method: "thread/start",
      }),
    );

    await expect(
      driver(harness).create({
        scope,
        applicationThreadId: "application-create-paginated-rejected",
        applicationOperationId: "mutation-create-paginated-rejected",
        source: { kind: "user" },
        workspace,
        creationCorrelation: "create-paginated-rejected-correlation",
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "codex_remote_-32602",
      crossedSubmissionBoundary: false,
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/start"),
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ historyMode: "paginated" }),
      }),
    ]);
    expect(harness.retirements).toEqual([]);
  });

  it("treats a matching create notification followed by remote rejection as an unknown outcome", async () => {
    const harness = new RpcHarness();
    const correlation = "create-notified-then-rejected-correlation";
    harness.enqueue(
      "thread/start",
      (_params: unknown, activeHarness: RpcHarness) => {
        activeHarness.notify("thread/started", {
          thread: nativeThread({
            id: "create-notified-then-rejected",
            threadSource: correlation,
            turns: [],
          }),
        });
        throw new CodexRpcRemoteError({
          code: -32602,
          message: "store rejected creation",
          generation: 1,
          method: "thread/start",
        });
      },
    );

    await expect(
      driver(harness).create({
        scope,
        applicationThreadId: "application-create-notified-then-rejected",
        applicationOperationId: "mutation-create-notified-then-rejected",
        source: { kind: "user" },
        workspace,
        creationCorrelation: correlation,
      }),
    ).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "codex_create_notification_without_response",
      crossedSubmissionBoundary: true,
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/start"),
    ).toHaveLength(1);
    expect(harness.retirements).toEqual([1]);
  });

  it("treats a matching create notification followed by not-sent delivery as an unknown outcome", async () => {
    const harness = new RpcHarness();
    const correlation = "create-notified-then-not-sent-correlation";
    harness.enqueue(
      "thread/start",
      (_params: unknown, activeHarness: RpcHarness) => {
        activeHarness.notify("thread/started", {
          thread: paginatedThread({
            id: "create-notified-then-not-sent",
            threadSource: correlation,
            turns: [],
          }),
        });
        throw new CodexRpcDeliveryError({
          code: "create_not_sent_after_notification",
          delivery: "not_sent",
          generation: 1,
          method: "thread/start",
        });
      },
    );

    await expect(
      driver(harness).create({
        scope,
        applicationThreadId: "application-create-notified-then-not-sent",
        applicationOperationId: "mutation-create-notified-then-not-sent",
        source: { kind: "user" },
        workspace,
        creationCorrelation: correlation,
      }),
    ).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "codex_create_notification_without_response",
      crossedSubmissionBoundary: true,
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/start"),
    ).toHaveLength(1);
    expect(harness.retirements).toEqual([1]);
  });

  it("fails closed when Codex creates a legacy thread after accepting the paginated request", async () => {
    const harness = new RpcHarness();
    const started = nativeThread({
      id: "legacy-create-response",
      threadSource: "legacy-create-response-correlation",
      turns: [],
    });
    harness.enqueue("thread/start", threadStartResult(started));

    await expect(
      driver(harness).create({
        scope,
        applicationThreadId: "application-create-legacy-response",
        applicationOperationId: "mutation-create-legacy-response",
        source: { kind: "user" },
        workspace,
        creationCorrelation: "legacy-create-response-correlation",
      }),
    ).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "codex_create_response_invalid",
      crossedSubmissionBoundary: true,
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/start"),
    ).toHaveLength(1);
    expect(harness.retirements).toEqual([1]);
  });

  it("uses the authoritative create response when thread/started follows it", async () => {
    const harness = new RpcHarness();
    const correlation = "response-before-create-notification-correlation";
    const responseThread = paginatedThread({
      id: "paginated-create-response",
      threadSource: correlation,
      turns: [],
    });
    harness.enqueue("thread/start", threadStartResult(responseThread));
    harness.after("thread/start", () => {
      harness.notify("thread/started", {
        thread: nativeThread({
          id: responseThread.id,
          threadSource: correlation,
          turns: [],
        }),
      });
    });

    await expect(
      driver(harness).create({
        scope,
        applicationThreadId: "application-create-response-before-notification",
        applicationOperationId: "mutation-create-response-before-notification",
        source: { kind: "user" },
        workspace,
        creationCorrelation: correlation,
      }),
    ).resolves.toMatchObject({
      backendConversationId: responseThread.id,
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/start"),
    ).toHaveLength(1);
    expect(harness.retirements).toEqual([]);
  });

  it("resolves a Fast catalog default to Standard when the created thread disables fast_mode", async () => {
    const harness = new RpcHarness();
    let desired = executionSettingsTuple({ serviceTier: "fast" });
    const resolveFastModeDisabled = vi.fn(() => {
      desired = { ...desired, serviceTier: "standard" };
      return desired;
    });
    const target = driver(
      harness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "catalog" },
      executionSettingsProvider({
        desiredSettings: () => desired,
        freezeOperationSnapshot: () => ({ settings: desired }),
        resolveFastModeDisabled,
      }),
    );
    harness.enqueue("model/list", {
      data: [
        nativeModel({
          serviceTiers: [{ id: "priority", name: "Fast", description: "Fast" }],
          defaultServiceTier: "priority",
        }),
      ],
      nextCursor: null,
    });
    const started = paginatedThread({
      id: "created-fast-disabled",
      threadSource: "create-fast-disabled-correlation",
      turns: [],
    });
    harness.enqueue("thread/start", {
      ...threadStartResult(started),
      serviceTier: "priority",
    });
    harness.enqueue("experimentalFeature/list", {
      data: [
        {
          name: "fast_mode",
          stage: "stable",
          displayName: "Fast mode",
          description: null,
          announcement: null,
          enabled: false,
          defaultEnabled: true,
        },
      ],
      nextCursor: null,
    });

    await target.create({
      scope,
      applicationThreadId: "application-create-fast-disabled",
      applicationOperationId: "mutation-create-fast-disabled",
      source: { kind: "user" },
      workspace,
      creationCorrelation: "create-fast-disabled-correlation",
      title: "New thread",
    });

    expect(
      harness.calls.find(({ method }) => method === "thread/start")?.params,
    ).toMatchObject({ serviceTier: "priority" });
    expect(resolveFastModeDisabled).toHaveBeenCalledWith(scope, {
      applicationThreadId: "application-create-fast-disabled",
      now: expect.any(Number),
    });
    expect(desired.serviceTier).toBe("standard");
  });

  it("installs isolated CLI context on Sedes-created start and resume", async () => {
    const harness = new RpcHarness();
    const cliEnvironment = availableAgentToolCliEnvironment();
    const target = driver(
      harness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "catalog" },
      executionSettingsProvider(),
      undefined,
      undefined,
      cliEnvironment,
    );
    const started = paginatedThread({
      id: "cli-created-thread",
      threadSource: "cli-create-correlation",
      turns: [],
    });
    harness.enqueue("thread/start", threadStartResult(started));

    await target.create({
      scope,
      applicationThreadId: "application-cli-create",
      applicationOperationId: "mutation-cli-create",
      source: { kind: "user" },
      workspace,
      creationCorrelation: "cli-create-correlation",
    });
    expect(
      harness.calls.find(({ method }) => method === "thread/start")?.params,
    ).toMatchObject({
      config: {
        model_reasoning_effort: "low",
        shell_environment_policy: {
          exclude: [
            "SEDES_AGENT_TOOL_ENDPOINT",
            "SEDES_AGENT_TOOL_SOURCE_CAPABILITY",
            "SEDES_AGENT_TOOL_CLIENT_TOKEN",
            "SEDES_AGENT_TOOL_CLI_MODE",
          ],
          set: {
            SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY: agentToolSourceCapability,
            SEDES_AGENT_TOOL_CLI_MODE: "progressive",
            PATH: "/opt/sedes/bin:/usr/bin",
          },
        },
      },
    });

    const handle = await target.attach(attachInput());
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", resumeResult());
    await handle.establishProjection({ signal: new AbortController().signal });
    expect(
      harness.calls.find(({ method }) => method === "thread/resume")?.params,
    ).toEqual({
      threadId: "thread-1",
      serviceTier: "default",
      config: {
        shell_environment_policy: {
          exclude: [
            "SEDES_AGENT_TOOL_ENDPOINT",
            "SEDES_AGENT_TOOL_SOURCE_CAPABILITY",
            "SEDES_AGENT_TOOL_CLIENT_TOKEN",
            "SEDES_AGENT_TOOL_CLI_MODE",
          ],
          set: {
            SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY: agentToolSourceCapability,
            SEDES_AGENT_TOOL_CLI_MODE: "progressive",
            PATH: "/opt/sedes/bin:/usr/bin",
          },
        },
      },
    });
  });

  it("holds an attached CLI lease through resume and releases it on close", async () => {
    const harness = new RpcHarness();
    const release = vi.fn();
    const acquire = vi.fn(async () => ({
      availability: "available" as const,
      endpoint: "unix:///run/user/1000/sedes-agent-tools.sock",
      executableDirectory: "/opt/sedes/bin",
      inheritedPath: "/usr/bin",
      sourceCapability: agentToolSourceCapability,
      mode: "progressive" as const,
      closed: new Promise(() => undefined),
      release,
    }));
    const target = driver(
      harness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "catalog" },
      executionSettingsProvider(),
      undefined,
      undefined,
      { acquire },
    );

    const handle = await target.attach(attachInput());
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    await establish(harness, handle);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(
      harness.calls.find(({ method }) => method === "thread/resume")?.params,
    ).toMatchObject({
      config: {
        shell_environment_policy: {
          set: {
            SEDES_AGENT_TOOL_ENDPOINT:
              "unix:///run/user/1000/sedes-agent-tools.sock",
          },
        },
      },
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reacquires a CLI lease whose sidecar session closes before generation recovery", async () => {
    const harness = new RpcHarness();
    let closeFirst!: () => void;
    const firstClosed = new Promise<void>((resolve) => {
      closeFirst = resolve;
    });
    const releases = [vi.fn(), vi.fn()];
    let acquisition = 0;
    const acquire = vi.fn(async () => {
      const index = acquisition++;
      return {
        availability: "available" as const,
        endpoint: `unix:///run/user/1000/sedes-agent-tools-${index}.sock`,
        executableDirectory: "/opt/sedes/bin",
        inheritedPath: "/usr/bin",
        sourceCapability: agentToolSourceCapability,
        mode: "progressive" as const,
        closed: index === 0 ? firstClosed : new Promise(() => undefined),
        release: releases[index]!,
      };
    });
    const target = driver(
      harness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "catalog" },
      executionSettingsProvider(),
      undefined,
      undefined,
      { acquire },
    );

    const handle = await target.attach(attachInput());
    await establish(harness, handle);
    expect(acquire).toHaveBeenCalledTimes(1);
    closeFirst();
    await firstClosed;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(releases[0]).toHaveBeenCalledTimes(1);

    harness.lifecycle("unavailable", 1);
    harness.lifecycle("ready", 2);
    await establish(harness, handle);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(
      harness.calls.findLast(({ method }) => method === "thread/resume")
        ?.params,
    ).toMatchObject({
      config: {
        shell_environment_policy: {
          set: {
            SEDES_AGENT_TOOL_ENDPOINT:
              "unix:///run/user/1000/sedes-agent-tools-1.sock",
          },
        },
      },
    });

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
    expect(releases[1]).toHaveBeenCalledTimes(1);
  });

  it("scrubs CLI context when provisioning fails without poisoning Codex create", async () => {
    const harness = new RpcHarness();
    const target = driver(
      harness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "catalog" },
      executionSettingsProvider(),
      undefined,
      undefined,
      {
        acquire: async () => {
          throw new Error("sidecar unavailable");
        },
      },
    );
    const started = paginatedThread({
      id: "cli-failed-thread",
      threadSource: "cli-failed-correlation",
      turns: [],
    });
    harness.enqueue("thread/start", threadStartResult(started));

    await expect(
      target.create({
        scope,
        applicationThreadId: "application-cli-failed",
        applicationOperationId: "mutation-cli-failed",
        source: { kind: "user" },
        workspace,
        creationCorrelation: "cli-failed-correlation",
      }),
    ).resolves.toMatchObject({ backendConversationId: started.id });
    expect(
      harness.calls.find(({ method }) => method === "thread/start")?.params,
    ).toMatchObject({
      config: {
        model_reasoning_effort: "low",
      },
    });
    expect(
      (
        harness.calls.find(({ method }) => method === "thread/start")
          ?.params as {
          config: Record<string, unknown>;
        }
      ).config,
    ).toMatchObject({
      shell_environment_policy: scrubbedAgentToolShellEnvironmentPolicy,
    });
  });

  it("resolves changed CLI eligibility immediately before resume", async () => {
    const harness = new RpcHarness();
    let available = false;
    const acquire = vi.fn(async () =>
      available
        ? availableAgentToolCliEnvironment().acquire(
            scope,
            "application-profile-1",
          )
        : {
            availability: "unavailable" as const,
            reason: "network_disabled" as const,
          },
    );
    const target = driver(
      harness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "catalog" },
      executionSettingsProvider(),
      undefined,
      undefined,
      { acquire },
    );

    const handle = await target.attach(attachInput());
    expect(acquire).not.toHaveBeenCalled();
    available = true;
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", resumeResult());
    await handle.establishProjection({ signal: new AbortController().signal });

    expect(acquire).toHaveBeenCalledWith(scope, "application-profile-1", {
      signal: expect.any(AbortSignal),
    });
    expect(
      harness.calls.find(({ method }) => method === "thread/resume")?.params,
    ).toMatchObject({
      config: {
        shell_environment_policy: {
          set: {
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY: agentToolSourceCapability,
          },
        },
      },
    });
  });

  it("scrubs CLI context when current resume eligibility is unavailable", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const handle = await target.attach(attachInput());
    harness.enqueue("thread/read", { thread: nativeThread() });
    harness.enqueue("thread/resume", resumeResult());

    await handle.establishProjection({ signal: new AbortController().signal });

    expect(
      harness.calls.find(({ method }) => method === "thread/resume")?.params,
    ).toEqual({
      threadId: "thread-1",
      serviceTier: "default",
      config: {
        shell_environment_policy: scrubbedAgentToolShellEnvironmentPolicy,
      },
    });
  });

  it("refuses an empty projection when a failed resume still has materialized history", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    const events: BackendConversationEvent[] = [];
    const unsubscribe = handle.subscribe((event) => events.push(event));
    harness.enqueue(
      "thread/read",
      { thread: nativeThread({ turns: [] }) },
      { thread: nativeThread({ turns: [nativeTurn(0)] }) },
    );
    harness.enqueue(
      "thread/resume",
      new CodexRpcRemoteError({
        code: -32600,
        message: "no rollout found for thread id thread-1",
        generation: 1,
        method: "thread/resume",
      }),
    );

    await expect(
      handle.establishProjection({
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(BackendError);

    expect(
      harness.calls
        .filter(
          ({ method }) =>
            method === "thread/read" || method === "thread/resume",
        )
        .map(({ method, params }) => ({ method, params })),
    ).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
      },
      {
        method: "thread/resume",
        params: {
          threadId: "thread-1",
          serviceTier: "default",
          config: {
            shell_environment_policy: scrubbedAgentToolShellEnvironmentPolicy,
          },
        },
      },
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true },
      },
    ]);
    expect(events).toEqual([]);
    await expect(handle.history({ limit: 1 })).rejects.toMatchObject({
      backendCode: "codex_history_not_established",
    });
    unsubscribe();
    await handle.close();
  });

  it("establishes an empty paginated thread without a compatibility full read", async () => {
    const harness = new RpcHarness();
    const handle = await attachIdle(harness);
    harness.enqueue("thread/read", {
      thread: paginatedThread({ status: { type: "notLoaded" } }),
    });
    harness.enqueue(
      "thread/resume",
      new CodexRpcRemoteError({
        code: -32600,
        message: "no rollout found for thread id thread-1",
        generation: 1,
        method: "thread/resume",
      }),
    );

    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(established.snapshot).toMatchObject({
      orderedBackendTurnIds: [],
      runState: "idle",
    });
    expect(established.history.previousCursor).toBeUndefined();
    expect(
      harness.calls.filter(
        ({ method, params }) =>
          method === "thread/read" &&
          (params as { includeTurns?: boolean }).includeTurns === true,
      ),
    ).toEqual([]);
    expect(
      harness.calls.some(
        ({ method }) =>
          method === "thread/turns/list" || method === "thread/items/list",
      ),
    ).toBe(false);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it.each(["legacy", "paginated"] as const)(
    "accepts the first message after a persistent %s session reports unmaterialized history",
    async (historyMode) => {
      const reattachThread = vi.fn(async () => {
        throw new CodexRpcRemoteError({
          code: -32603,
          message: historyMode === "paginated"
            ? "thread empty-persistent-thread is not materialized yet; thread/turns/list is unavailable before first user message"
            : "thread not materialized yet",
          generation: 7,
          method: historyMode === "paginated" ? "thread/turns/list" : "thread/read",
        });
      });
      const detachThread = vi.fn(async () => undefined);
      const harness = new RpcHarness({ reattachThread, detachThread });
      harness.lifecycle("ready", 7);
      const empty = nativeThread({
        id: "empty-persistent-thread",
        historyMode,
        turns: [],
      });
      const handle = await driver(harness).attach(
        attachInput(connection, empty.id),
      );
      harness.enqueue("thread/read", { thread: empty });
      if (historyMode === "legacy") {
        harness.enqueue(
          "thread/read",
          new CodexRpcRemoteError({
            code: -32603,
            message: "thread not materialized yet",
            generation: 7,
            method: "thread/read",
          }),
        );
      }

      try {
        const signal = new AbortController().signal;
        const established = await handle.establishProjection({ signal });
        expect(established.snapshot).toMatchObject({
          orderedBackendTurnIds: [],
          runState: "idle",
        });
        expect(established.history.previousCursor).toBeUndefined();
        expect(reattachThread).toHaveBeenCalledExactlyOnceWith(empty.id, {
          timeoutMilliseconds: 60_000,
          signal: expect.any(AbortSignal),
        });
        expect(
          harness.calls.filter(({ method }) => method === "thread/read"),
        ).toEqual([
          {
            method: "thread/read",
            params: { threadId: empty.id, includeTurns: false },
          },
          ...(historyMode === "legacy"
            ? [
                {
                  method: "thread/read",
                  params: { threadId: empty.id, includeTurns: true },
                },
              ]
            : []),
        ]);
        harness.enqueue("turn/start", {
          turn: {
            ...nativeTurn(1),
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            completedAt: null,
          },
        });

        await expect(
          handle.submit({
            applicationOperationId: "persistent-first-submit-operation",
            source: { kind: "user" },
            mutationId: "persistent-first-submit-mutation",
            reconciliationToken: "persistent-first-submit-token",
            taskContexts: [],
            contextExcerpts: [],
            attachments: [],
            text: "Start the work.",
          }),
        ).resolves.toMatchObject({
          accepted: true,
          backendTurnId: codexBackendTurnId(empty.id, "turn-1"),
          reconciliationToken: "persistent-first-submit-token",
        });
        expect(
          harness.calls.filter(({ method }) => method === "turn/start"),
        ).toHaveLength(1);
        expect(
          harness.calls.filter(({ method }) => method === "thread/resume"),
        ).toEqual([]);
      } finally {
        await handle.close();
      }
      expect(detachThread).toHaveBeenCalledExactlyOnceWith(empty.id, 7, false);
    },
  );

  it("fails closed on unrelated persistent reattach errors for an empty session", async () => {
    const reattachThread = vi.fn(async () => {
      throw new CodexRpcRemoteError({
        code: -32001,
        message: "server overloaded",
        generation: 1,
        method: "thread/turns/list",
      });
    });
    const harness = new RpcHarness({
      reattachThread,
      detachThread: vi.fn(async () => undefined),
    });
    const handle = await attachIdle(harness);
    const events: BackendConversationEvent[] = [];
    const unsubscribe = handle.subscribe((event) => events.push(event));
    harness.enqueue("thread/read", { thread: paginatedThread() });

    try {
      await expect(
        handle.establishProjection({
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        category: "overloaded",
        backendCode: "codex_remote_overloaded",
      });
      await expect(handle.history({ limit: 1 })).rejects.toMatchObject({
        backendCode: "codex_history_not_established",
      });
      expect(events).toEqual([]);
      expect(reattachThread).toHaveBeenCalledTimes(1);
      expect(harness.calls).toEqual([
        {
          method: "thread/read",
          params: { threadId: "thread-1", includeTurns: false },
        },
      ]);
    } finally {
      unsubscribe();
      await handle.close();
    }
  });

  it("keeps fork settings authoritative while reconciling an empty provider-created thread", async () => {
    const harness = new RpcHarness();
    const target = driver(
      harness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "catalog" },
      executionSettingsProvider(),
      undefined,
      undefined,
      availableAgentToolCliEnvironment(),
    );
    const empty = nativeThread({ id: "empty-created-thread", turns: [] });
    const unmaterialized = () =>
      new CodexRpcRemoteError({
        code: -32603,
        message: "thread not materialized yet",
        generation: 1,
        method: "thread/read",
      });

    const handle = await target.attach(attachInput(connection, empty.id));
    harness.enqueue("thread/read", { thread: empty }, unmaterialized());
    harness.enqueue(
      "thread/resume",
      new CodexRpcRemoteError({
        code: -32600,
        message: "no rollout found for thread id empty-created-thread",
        generation: 1,
        method: "thread/resume",
      }),
    );
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(
      harness.calls
        .filter(
          ({ method }) =>
            method === "thread/read" || method === "thread/resume",
        )
        .map(({ method, params }) => ({ method, params })),
    ).toEqual([
      {
        method: "thread/read",
        params: { threadId: empty.id, includeTurns: false },
      },
      {
        method: "thread/resume",
        params: expect.objectContaining({ threadId: empty.id }),
      },
      {
        method: "thread/read",
        params: { threadId: empty.id, includeTurns: true },
      },
    ]);
    expect(
      harness.calls.find(({ method }) => method === "thread/resume")?.params,
    ).toMatchObject({
      threadId: empty.id,
      config: {
        shell_environment_policy: {
          set: {
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY: agentToolSourceCapability,
          },
        },
      },
    });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      branching: {
        availability: "available",
      },
      effectiveSettings: {
        model: {
          provider: connection.id,
          id: "gpt-5.6",
        },
        thinkingLevel: "low",
      },
    });
    established.subscribeFromNext(() => undefined)();

    const action = {
      applicationOperationId: "initial-title",
      action: "rename" as const,
      title: "Sprint notes",
    };
    harness.enqueue("thread/read", { thread: empty });
    harness.enqueue(
      "thread/name/set",
      new CodexRpcDeliveryError({
        code: "codex_response_lost",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "thread/name/set",
      }),
    );
    await expect(handle.perform(action)).rejects.toMatchObject({
      crossedSubmissionBoundary: true,
    });
    harness.enqueue("thread/read", {
      thread: { ...empty, name: action.title },
    });
    await expect(handle.reconcileAction(action)).resolves.toEqual({
      outcome: "accepted",
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/name/set"),
    ).toHaveLength(1);
    expect(
      harness.calls.filter(
        ({ method, params }) =>
          method === "thread/read" &&
          (params as { includeTurns?: boolean }).includeTurns === false,
      ),
    ).toHaveLength(3);
    expect(
      harness.calls.filter(
        ({ method, params }) =>
          method === "thread/read" &&
          (params as { includeTurns?: boolean }).includeTurns === true,
      ),
    ).toHaveLength(1);
    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("steers the first turn of an initially unmaterialized thread from its accepted settings", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const empty = nativeThread({ id: "empty-created-thread", turns: [] });
    const unmaterialized = () =>
      new CodexRpcRemoteError({
        code: -32603,
        message: "thread not materialized yet",
        generation: 1,
        method: "thread/read",
      });

    const handle = await target.attach(attachInput(connection, empty.id));
    harness.enqueue("thread/read", { thread: empty }, unmaterialized());
    harness.enqueue(
      "thread/resume",
      new CodexRpcRemoteError({
        code: -32600,
        message: "no rollout found for thread id empty-created-thread",
        generation: 1,
        method: "thread/resume",
      }),
    );
    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(
      harness.calls
        .filter(
          ({ method }) =>
            method === "thread/read" || method === "thread/resume",
        )
        .map(({ method, params }) => ({ method, params })),
    ).toEqual([
      {
        method: "thread/read",
        params: { threadId: empty.id, includeTurns: false },
      },
      {
        method: "thread/resume",
        params: expect.objectContaining({ threadId: empty.id }),
      },
      {
        method: "thread/read",
        params: { threadId: empty.id, includeTurns: true },
      },
    ]);
    harness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    const submitted = await handle.submit({
      applicationOperationId: "first-submit-operation",
      source: { kind: "user" },
      mutationId: "first-submit-mutation",
      reconciliationToken: "first-submit-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "Start the work.",
    });
    harness.enqueue("turn/steer", { turnId: "turn-1" });

    await expect(
      handle.steer({
        applicationOperationId: "first-steer-operation",
        mutationId: "first-steer-mutation",
        reconciliationToken: "first-steer-token",
        target: { kind: "turn", turnId: submitted.backendTurnId! },
        taskContexts: [],
        contextExcerpts: [],
        attachments: [],
        text: "Continue with this clarification.",
      }),
    ).resolves.toMatchObject({
      status: "accepted",
      reconciliationToken: "first-steer-token",
    });
    expect(
      harness.calls.filter(({ method }) => method === "turn/steer"),
    ).toHaveLength(1);

    harness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();
  });

  it("propagates durable automation source to create and submit snapshot freezes", async () => {
    const source = {
      kind: "automation" as const,
      automationId: "automation-source-1",
      automationRunId: "automation-run-source-1",
    };
    const automationPolicy = executionSettingsTuple({
      sandboxMode: "workspace-write",
      networkAccess: "enabled",
      approvalPolicy: "on-request",
    });
    const createHarness = new RpcHarness();
    const createFreeze = vi.fn(() => ({
      settings: automationPolicy,
    }));
    const createDriver = driver(
      createHarness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "catalog" },
      executionSettingsProvider({ freezeOperationSnapshot: createFreeze }),
    );
    const started = paginatedThread({
      id: "automation-created-thread",
      threadSource: "automation-create-correlation",
      turns: [],
    });
    createHarness.enqueue("thread/start", threadStartResult(started));

    await expect(
      createDriver.create({
        scope,
        applicationThreadId: "automation-created-application-thread",
        applicationOperationId: "automation-create-operation",
        source,
        workspace,
        creationCorrelation: "automation-create-correlation",
      }),
    ).resolves.toMatchObject({
      backendConversationId: "automation-created-thread",
    });
    expect(createFreeze).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        applicationThreadId: "automation-created-application-thread",
        applicationOperationId: "automation-create-operation",
        source,
      }),
    );
    expect(
      createHarness.calls.find(({ method }) => method === "thread/start")
        ?.params,
    ).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      config: {
        "sandbox_workspace_write.network_access": true,
      },
    });

    const submitHarness = new RpcHarness();
    const submitFreeze = vi.fn(() => ({
      settings: automationPolicy,
    }));
    const submitHandle = await attachIdle(
      submitHarness,
      driver(
        submitHarness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        executionSettingsProvider({ freezeOperationSnapshot: submitFreeze }),
      ),
    );
    await establish(submitHarness, submitHandle);
    submitHarness.enqueue("turn/start", {
      turn: {
        ...nativeTurn(1),
        items: [],
        itemsView: "notLoaded",
        status: "inProgress",
        completedAt: null,
      },
    });
    await expect(
      submitHandle.submit({
        applicationOperationId: "automation-submit-operation",
        mutationId: "automation-submit-mutation",
        source,
        reconciliationToken: "automation-submit-token",
        taskContexts: [],
        contextExcerpts: [],
        attachments: [],
        text: "run automation",
      }),
    ).resolves.toMatchObject({ accepted: true });
    expect(submitFreeze).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        applicationThreadId: binding().applicationThreadId,
        applicationOperationId: "automation-submit-operation",
        source,
      }),
    );
    expect(
      submitHarness.calls.find(({ method }) => method === "turn/start")?.params,
    ).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: true,
      },
    });
    submitHarness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await submitHandle.close();
  });

  it("propagates a frozen execution-policy rejection before provider requests", async () => {
    const source = {
      kind: "automation" as const,
      automationId: "automation-policy-1",
      automationRunId: "automation-run-policy-1",
    };
    const rejectedProvider = (policyLabel: "workspace" | "unrestricted") =>
      executionSettingsProvider({
        freezeOperationSnapshot: vi.fn((_scope, input) => {
          expect(input.source).toEqual(source);
          throw new BackendError({
            category: "rejected",
            retryable: false,
            crossedSubmissionBoundary: false,
            safeMessage: `Execution policy rejected for ${policyLabel}.`,
            backendCode: "codex_execution_policy_rejected",
          });
        }),
      });

    const createHarness = new RpcHarness();
    const createDriver = driver(
      createHarness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "catalog" },
      rejectedProvider("workspace"),
    );
    await expect(
      createDriver.create({
        scope,
        applicationThreadId: "rejected-automation-create",
        applicationOperationId: "rejected-automation-create-operation",
        source,
        workspace,
        creationCorrelation: "rejected-automation-create-correlation",
      }),
    ).rejects.toMatchObject({
      backendCode: "codex_execution_policy_rejected",
      crossedSubmissionBoundary: false,
    });
    expect(
      createHarness.calls.some(({ method }) => method === "thread/start"),
    ).toBe(false);

    const submitHarness = new RpcHarness();
    const submitHandle = await attachIdle(
      submitHarness,
      driver(
        submitHarness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        rejectedProvider("unrestricted"),
      ),
    );
    await establish(submitHarness, submitHandle);
    await expect(
      submitHandle.submit({
        applicationOperationId: "rejected-automation-submit-operation",
        mutationId: "rejected-automation-submit-mutation",
        source,
        reconciliationToken: "rejected-automation-submit-token",
        taskContexts: [],
        contextExcerpts: [],
        attachments: [],
        text: "reject automation",
      }),
    ).rejects.toMatchObject({
      backendCode: "codex_execution_policy_rejected",
      crossedSubmissionBoundary: false,
    });
    expect(
      submitHarness.calls.some(({ method }) => method === "turn/start"),
    ).toBe(false);
    submitHarness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await submitHandle.close();
  });

  it("rechecks frozen models against current policy and catalog before provider mutation", async () => {
    const removedSettings = executionSettingsProvider({
      freezeOperationSnapshot: () => ({
        settings: executionSettingsTuple({ model: "removed-model" }),
      }),
    });
    const policyHarness = new RpcHarness();
    const policyDriver = driver(
      policyHarness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "allowlist", allowed: [{ modelIds: ["gpt-5.6"] }] },
      removedSettings,
    );
    await expect(
      policyDriver.create({
        scope,
        applicationThreadId: "removed-policy-create",
        applicationOperationId: "removed-policy-operation",
        source: { kind: "user" },
        workspace,
        creationCorrelation: "removed-policy-correlation",
      }),
    ).rejects.toMatchObject({
      backendCode: "codex_execution_settings_policy_rejected",
      crossedSubmissionBoundary: false,
    });
    expect(
      policyHarness.calls.some(
        ({ method }) => method === "model/list" || method === "thread/start",
      ),
    ).toBe(false);

    const catalogHarness = new RpcHarness();
    const catalogHandle = await attachIdle(
      catalogHarness,
      driver(
        catalogHarness,
        connection,
        new CodexConversationOwnershipRegistry(),
        { type: "catalog" },
        removedSettings,
      ),
    );
    await establish(catalogHarness, catalogHandle);
    await expect(
      catalogHandle.submit({
        applicationOperationId: "removed-catalog-submit",
        mutationId: "removed-catalog-mutation",
        source: { kind: "user" },
        reconciliationToken: "removed-catalog-token",
        taskContexts: [],
        contextExcerpts: [],
        attachments: [],
        text: "must not submit",
      }),
    ).rejects.toMatchObject({
      backendCode: "codex_execution_settings_catalog_rejected",
      crossedSubmissionBoundary: false,
    });
    // One catalog read resolves the import candidate during establishment;
    // the second rechecks the frozen model before the rejected submission.
    expect(
      catalogHarness.calls.filter(({ method }) => method === "model/list"),
    ).toHaveLength(2);
    expect(
      catalogHarness.calls.some(({ method }) => method === "turn/start"),
    ).toBe(false);
    catalogHarness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await catalogHandle.close();
  });

  it("records a detailed custom workspace create response", async () => {
    const harness = new RpcHarness();
    const observeEffective = vi.fn();
    const target = driver(
      harness,
      connection,
      new CodexConversationOwnershipRegistry(),
      { type: "catalog" },
      executionSettingsProvider({
        freezeOperationSnapshot: () => ({
          settings: executionSettingsTuple({
            sandboxMode: "workspace-write",
            networkAccess: "enabled",
            approvalPolicy: "on-request",
          }),
        }),
        observeEffective,
      }),
    );
    const started = paginatedThread({
      id: "created-drifted-thread",
      threadSource: "create-drift-correlation",
      turns: [],
    });
    harness.enqueue("thread/start", {
      ...threadStartResult(started),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: ["/tmp"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });

    await expect(
      target.create({
        scope,
        applicationThreadId: "application-create-drift",
        applicationOperationId: "mutation-create-drift",
        source: { kind: "user" },
        workspace,
        creationCorrelation: "create-drift-correlation",
      }),
    ).resolves.toMatchObject({
      backendConversationId: "created-drifted-thread",
    });
    expect(
      harness.calls.find(({ method }) => method === "thread/start")?.params,
    ).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      config: {
        "sandbox_workspace_write.network_access": true,
        "sandbox_workspace_write.exclude_tmpdir_env_var": true,
        "sandbox_workspace_write.exclude_slash_tmp": true,
        model_reasoning_effort: "low",
      },
    });
    expect(observeEffective).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        applicationThreadId: "application-create-drift",
        confirmationGeneration: 1,
        settings: {
          model: "gpt-5.6",
          reasoningEffort: "low",
          serviceTier: "standard",
          serviceTierClassification: "recognized",
          sandboxMode: null,
          sandboxClassification: "external_custom",
          networkAccess: "disabled",
          networkClassification: "recognized",
          approvalPolicy: "on-request",
          approvalPolicyClassification: "recognized",
          approvalReviewer: "user",
          approvalReviewerClassification: "recognized",
          policyObservation: "complete",
        },
      }),
    );
  });

  it("does not adopt a matching start notification when the create response is lost", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    const notificationThread = paginatedThread({
      id: "notification-only-thread",
      threadSource: "create-correlation-notification-only",
      turns: [],
    });
    harness.enqueue(
      "thread/start",
      (_params: unknown, activeHarness: RpcHarness) => {
        activeHarness.notify("thread/started", {
          thread: notificationThread,
        });
        throw new CodexRpcDeliveryError({
          code: "create_response_lost_after_notification",
          delivery: "sent_outcome_unknown",
          generation: 1,
          method: "thread/start",
        });
      },
    );

    await expect(
      target.create({
        scope,
        applicationThreadId: "application-create-notification-only",
        applicationOperationId: "mutation-create-notification-only",
        source: { kind: "user" },
        workspace,
        creationCorrelation: "create-correlation-notification-only",
      }),
    ).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "create_response_lost_after_notification",
      crossedSubmissionBoundary: true,
    });
    expect(harness.facade.lifecycleSnapshot()).toEqual({
      state: "unavailable",
      generation: 1,
    });
    expect(
      harness.calls.filter(({ method }) => method === "thread/start"),
    ).toHaveLength(1);
  });

  it("rejects application-assigned create identity and missing correlation", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    await expect(
      target.create({
        scope,
        applicationThreadId: "application-create-2",
        applicationOperationId: "mutation-create-2",
        source: { kind: "user" },
        workspace,
        requestedBackendConversationId: "app-assigned",
      }),
    ).rejects.toMatchObject({
      backendCode: "codex_create_requested_id_forbidden",
    });
    await expect(
      target.create({
        scope,
        applicationThreadId: "application-create-3",
        applicationOperationId: "mutation-create-3",
        source: { kind: "user" },
        workspace,
      }),
    ).rejects.toMatchObject({
      backendCode: "codex_create_correlation_invalid",
    });
  });

  it("marks maybe-sent create failures as crossed and not-sent as retryable", async () => {
    const harness = new RpcHarness();
    const target = driver(harness);
    harness.enqueue("thread/start", async () => {
      throw new CodexRpcDeliveryError({
        code: "create_unknown",
        delivery: "sent_outcome_unknown",
        generation: 1,
        method: "thread/start",
      });
    });
    await expect(
      target.create({
        scope,
        applicationThreadId: "application-create-4",
        applicationOperationId: "mutation-create-4",
        source: { kind: "user" },
        workspace,
        creationCorrelation: "create-correlation-unknown",
      }),
    ).rejects.toMatchObject({
      category: "submission_unknown",
      crossedSubmissionBoundary: true,
    });
    expect(harness.facade.lifecycleSnapshot()).toEqual({
      state: "unavailable",
      generation: 1,
    });

    harness.lifecycle("ready", 2);

    harness.enqueue("thread/start", async () => {
      throw new CodexRpcDeliveryError({
        code: "create_not_sent",
        delivery: "not_sent",
        generation: 2,
        method: "thread/start",
      });
    });
    await expect(
      target.create({
        scope,
        applicationThreadId: "application-create-5",
        applicationOperationId: "mutation-create-5",
        source: { kind: "user" },
        workspace,
        creationCorrelation: "create-correlation-not-sent",
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      crossedSubmissionBoundary: false,
    });
  });

  it("maps bounded binding failures at mutation and create boundaries without exposing provider diagnostics", async () => {
    const mutationHarness = new RpcHarness();
    const handle = await attachIdle(mutationHarness);
    await establish(mutationHarness, handle);
    mutationHarness.enqueue(
      "turn/start",
      new CodexAppServerBindingError({
        code: "codex_app_server_client_request_result_invalid",
        direction: "client_request_result",
        method: "turn/start",
      }),
    );
    const mutation = handle.submit({
      applicationOperationId: "binding-result-submit",
      mutationId: "binding-result-mutation",
      source: { kind: "user" },
      reconciliationToken: "binding-result-token",
      taskContexts: [],
      contextExcerpts: [],
      attachments: [],
      text: "start",
    });
    await expect(mutation).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "codex_mutation_response_invalid",
      safeMessage:
        "Codex returned an invalid mutation response; its outcome is unknown.",
      crossedSubmissionBoundary: true,
    });
    mutationHarness.enqueue("thread/unsubscribe", { status: "unsubscribed" });
    await handle.close();

    for (const [direction, expected] of [
      [
        "client_request_params",
        {
          category: "rejected",
          backendCode: "codex_create_input_invalid",
          crossedSubmissionBoundary: false,
        },
      ],
      [
        "client_request_result",
        {
          category: "submission_unknown",
          backendCode: "codex_create_response_invalid",
          crossedSubmissionBoundary: true,
        },
      ],
    ] as const) {
      const createHarness = new RpcHarness();
      createHarness.enqueue(
        "thread/start",
        new CodexAppServerBindingError({
          code: `codex_app_server_${direction}_invalid`,
          direction,
          method: "thread/start",
        }),
      );
      const creation = driver(createHarness).create({
        scope,
        applicationThreadId: `application-create-${direction}`,
        applicationOperationId: `mutation-create-${direction}`,
        source: { kind: "user" },
        workspace,
        creationCorrelation: `create-correlation-${direction}`,
      });
      await expect(creation).rejects.toMatchObject(expected);
      expect(createHarness.retirements).toEqual(
        direction === "client_request_result" ? [1] : [],
      );
    }

    const forkHarness = new RpcHarness();
    const forkDriver = driver(forkHarness);
    const source = nativeThread();
    enqueueCompleteLegacyRead(forkHarness, source);
    const checkpoint = await forkDriver.resolveBranchCheckpoint({
      ...attachInput(),
      selection: { kind: "latest_completed" },
    });
    enqueueCompleteLegacyRead(forkHarness, source);
    forkHarness.enqueue(
      "thread/fork",
      new CodexAppServerBindingError({
        code: "codex_app_server_client_request_params_invalid",
        direction: "client_request_params",
        method: "thread/fork",
      }),
    );
    await expect(
      forkDriver.branchConversation({
        scope,
        childApplicationThreadId: "application-binding-fork-child",
        applicationOperationId: "operation-binding-fork-child",
        source: { kind: "user" },
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: attachInput().opaqueBindingDetail,
        workspace,
        sourceCheckpoint: checkpoint,
        creationCorrelation: "binding-fork-correlation",
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "codex_fork_input_invalid",
      crossedSubmissionBoundary: false,
    });
    expect(forkHarness.retirements).toEqual([]);
  });
});

describe("CodexBackendDriverFactory", () => {
  it.each(["none", "local", "remote"])("shares ownership and stable drivers across profiles with residency=%s", async mode => {
    const retire = vi.fn(async () => {});
    const residency = mode !== "none" ? new RetainedRuntimeLifecycle({ wake: () => {}, retire }) : undefined;
    const detachThread = vi.fn(async () => {});
    const harness = new RpcHarness(mode === "remote" ? {
      reattachThread: async () => undefined, detachThread,
    } : undefined, residency);
    const factory = new CodexBackendDriverFactory({
    usageSink: NO_USAGE_SINK,
    nativeNamespace: "test-codex-store",
      scope,
      instance,
      client: harness.facade,
      serverRequests: harness.serverRequests,
      toolProvenanceKey,
      modelPolicy: catalogModelPolicy,
      executionSettings: executionSettingsProvider(),
      outputArtifacts: createInMemoryOutputArtifactPublisher(),
      fastModeSessions: new CodexFastModeSessionRegistry(),
      agentToolCliEnvironment: unavailableCodexAgentToolCliEnvironmentProvider,
      materializedConnections: [
        connection,
        connectionProfile("profile-2", "template-2"),
      ],
      connections: [
        {
          id: "template-1",
          enabled: true,
          configuration: {
            defaults: {
              sandboxMode: "read-only",
              networkAccess: "disabled",
              approvalPolicy: "never",
              approvalReviewer: "user",
              model: { type: "catalogDefault" },
            },
          },
        },
        {
          id: "template-2",
          enabled: true,
          configuration: {
            defaults: {
              sandboxMode: "read-only",
              networkAccess: "disabled",
              approvalPolicy: "never",
              approvalReviewer: "user",
              model: { type: "catalogDefault" },
            },
          },
        },
      ],
    });
    expect(factory.supportsConversationCreation).toBe(true);
    expect(factory.creationIdentity.assignment).toBe("provider");
    expect(() =>
      factory.create({
        ...connection,
        executionEnvironmentId: "forged-environment",
      }),
    ).toThrow("codex_driver_factory_connection_mismatch");
    expect(harness.calls).toEqual([]);
    expect(factory.create(connection)).toBe(factory.create(connection));
    expect(() => factory.create({ ...connection, label: "changed" })).toThrow(
      "codex_driver_factory_connection_mismatch",
    );
    expect(
      factory.create(connectionProfile("profile-2", "template-2")),
    ).not.toBe(factory.create(connection));
    expect(() =>
      factory.create({
        ...connection,
        id: "unknown",
        templateId: "unknown",
      }),
    ).toThrow("codex_driver_factory_connection_mismatch");
    if (residency) {
      const previous = residency.retain();
      const created = { backendConversationId: binding().backendConversationId, reconciliationToken: "created", opaqueBindingDetail: attachInput().opaqueBindingDetail };
      const create = vi.spyOn(CodexConversationBackendDriver.prototype, "create").mockImplementationOnce(async () => {
        await previous.release(true);
        return created;
      });
      try {
        const driver = factory.create(connection);
        await driver.create({} as Parameters<typeof driver.create>[0]);
        expect(retire).not.toHaveBeenCalled();
        const handle = await driver.attach(attachInput());
        expect(retire).not.toHaveBeenCalled();
        await handle.close({ reason: "evicted" });
        expect(retire).toHaveBeenCalledTimes(1);
      } finally { create.mockRestore(); }

      retire.mockClear();
      const source = residency.retain();
      const forked = { backendConversationId: "unopened-fork", reconciliationToken: "forked", opaqueBindingDetail: "fork-detail" };
      const fork = vi.spyOn(CodexConversationBackendDriver.prototype, "branchConversation").mockResolvedValueOnce(forked);
      try {
        const driver = factory.create(connection);
        await expect(driver.branchConversation({} as Parameters<typeof driver.branchConversation>[0])).resolves.toEqual(forked);
        expect(retire).not.toHaveBeenCalled();
        if (mode === "remote") expect(detachThread).toHaveBeenCalledWith("unopened-fork", harness.generation, true);
        await source.release(true);
        expect(retire).toHaveBeenCalledOnce();

        // Eviction can also race the fork response. The complete fork operation
        // protects that response, then retires without requiring child attach.
        retire.mockClear();
        const otherSource = residency.retain();
        fork.mockImplementationOnce(async () => { await otherSource.release(true); return forked; });
        if (mode === "remote") detachThread.mockRejectedValueOnce(new Error("release_response_lost"));
        await expect(driver.branchConversation({} as Parameters<typeof driver.branchConversation>[0])).resolves.toEqual(forked);
        expect(retire).toHaveBeenCalledOnce();
      } finally { fork.mockRestore(); }
    }
  });

  it("snapshots the configured model policy before constructing profile drivers", async () => {
    const harness = new RpcHarness();
    const allowed = [{ modelIds: ["gpt-5.6"] }];
    const factory = new CodexBackendDriverFactory({
    usageSink: NO_USAGE_SINK,
    nativeNamespace: "test-codex-store",
      scope,
      instance,
      client: harness.facade,
      serverRequests: harness.serverRequests,
      toolProvenanceKey,
      modelPolicy: compileBackendModelPolicy(
        { type: "allowlist", allowed },
        "model_effort",
      ),
      executionSettings: executionSettingsProvider(),
      outputArtifacts: createInMemoryOutputArtifactPublisher(),
      fastModeSessions: new CodexFastModeSessionRegistry(),
      agentToolCliEnvironment: unavailableCodexAgentToolCliEnvironmentProvider,
      materializedConnections: [connection],
      connections: [
        {
          id: "template-1",
          enabled: true,
          configuration: {
            defaults: {
              sandboxMode: "read-only",
              networkAccess: "disabled",
              approvalPolicy: "never",
              approvalReviewer: "user",
              model: { type: "catalogDefault" },
            },
          },
        },
      ],
    });
    allowed[0]!.modelIds.push("injected-after-factory-construction");
    harness.enqueue("model/list", {
      data: [
        nativeModel(),
        nativeModel({
          id: "injected-after-factory-construction",
          model: "injected-after-factory-construction",
          displayName: "Injected",
          isDefault: false,
        }),
      ],
      nextCursor: null,
    });

    await expect(
      factory.create(connection).catalog({ scope, workspace }),
    ).resolves.toMatchObject({
      models: [{ provider: connection.id, id: "gpt-5.6", label: "GPT-5.6" }],
    });
  });
});
