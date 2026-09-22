import { CodexSubagentUsageCoordinator } from "./codex-subagent-usage.js";
import type { UsageSink } from "../../usage/contracts.js";
import type { ThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import { createHash } from "node:crypto";
import { posix as posixPath, win32 as windowsPath } from "node:path";
import { z } from "zod";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import type { ValidatedWorkspace } from "../../execution/contracts.js";
import { MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES } from "../../../shared/protocol/payload.js";
import {
  BackendError,
  type AgentBackendInstance,
  type AgentConnectionProfile,
  type AttachConversationInput,
  type BackendCatalog,
  type BackendCatalogContext,
  type BackendCheckpointRef,
  type BackendHealth,
  type BranchConversationInput,
  type ConversationBackendDriver,
  type ConversationHandle,
  type ConversationReadResult,
  type CreateConversationInput,
  type CreateConversationResult,
  type DiscoverConversationsInput,
  type DiscoveredConversationPage,
  type ReadConversationInput,
  type ReconcileSubmissionInput,
  type ResolveBranchCheckpointInput,
  type SubmissionReconciliation,
} from "../contracts.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import type { CodexManagedTuiController } from "./codex-managed-tui-controller.js";
import { CodexPaginatedHistoryAdapter } from "./codex-paginated-history-adapter.js";
import { CodexFastModeSessionRegistry } from "./codex-fast-mode-session.js";
import type { CodexServerRequestRouter } from "./codex-server-request-router.js";
import {
  codexThreadListMethod,
  codexThreadReadMethod,
  CODEX_C1_MAX_LIST_THREADS,
  type CodexThread,
  type CodexTurn,
} from "./codex-c1-protocol.js";
import {
  CODEX_C2_MAX_CATALOG_ITEMS,
  codexModelListMethod,
  codexThreadStartMethod,
  refineCodexSkillsChangedNotification,
  refineCodexThreadStartedNotification,
  type CodexModelListResponse,
} from "./codex-c2-protocol.js";
import {
  codexThreadForkMethod,
  type CodexThreadForkParams,
} from "./codex-c4-protocol.js";
import {
  CodexConversationHandle,
  codexObservedThreadExecutionSettings,
  codexSubmissionRetryAnchorMatches,
  normalizeCodexTurnStatuses,
  mapCodexHistoryProjectionError,
  projectCodexThreadHistory,
  selectCodexSnapshotWindow,
  verifiedCodexProjectionBytes,
  type CodexExecutionSettingsProvider,
  type CodexExecutionSettingsTuple,
} from "./codex-conversation-handle.js";
import { codexExecutionPolicy } from "./codex-execution-policy.js";
import { CODEX_HISTORY_TIMEOUT_MILLISECONDS } from "./codex-history-timeouts.js";
import {
  defaultCodexComposerSkillPreferenceReader,
  readCodexSkills,
  type CodexComposerSkillPreferenceReader,
} from "./codex-skills.js";
import {
  codexBackendTurnId,
  CodexHistoryProjectionError,
  inspectCodexForkContextBoundaries,
  materializeCodexGeneratedImagePublications,
  selectCodexNativeHistorySlice,
  type CodexHistoryProjection,
} from "./codex-history-projector.js";
import {
  codexClientUserMessageId,
  codexForkCreationMarker,
  codexSubmissionReconciliationClientUserMessageIds,
  copyCodexSubmissionCorrelationKey,
  inspectCodexForkCreationMarker,
  type CodexSubmissionCorrelationScope,
} from "./codex-submission-correlation.js";
import {
  parseCodexBindingDetail,
  serializeCodexBindingDetail,
} from "./codex-binding-codec.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import {
  CodexRpcDeliveryError,
  CodexRpcProtocolError,
  CodexRpcRemoteError,
} from "./rpc/errors.js";
import {
  withCodexAgentToolCliEnvironment,
  withCodexExecutionEnvironment,
  type CodexAgentToolCliEnvironmentProvider,
  type CodexAgentToolCliEnvironmentResolution,
} from "./codex-agent-tool-cli-environment.js";
import {
  CODEX_NATIVE_FAST_SERVICE_TIER,
  CODEX_NATIVE_ULTRAFAST_SERVICE_TIER,
  encodeCodexServiceTier,
} from "./codex-service-tier.js";
import { CodexAppServerBindingError } from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import {
  CODEX_DISCOVERY_SOURCE_KINDS,
  isCodexDiscoverableThread,
} from "./codex-thread-binding.js";

const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const FORK_REQUEST_TIMEOUT_MILLISECONDS = 60_000;
const MAXIMUM_CURSOR_BYTES = 4_096;
const MAXIMUM_MODEL_CATALOG_PAGES = 32;
const CODEX_BRANCH_CHECKPOINT_PREFIX = "codex-branch-checkpoint:";

const codexCompletedTurnBranchCheckpointSchema = z
  .object({
    version: z.literal(3),
    sourceThreadId: z.string().min(1).max(128),
    sourceSessionId: z.string().min(1).max(128),
    historyMode: z.enum(["legacy", "paginated"]),
    lastTurnId: z.string().min(1).max(512),
    turnDigest: z.string().length(64),
  })
  .strict();

const codexLatestSnapshotBranchCheckpointSchema = z
  .object({
    version: z.literal(4),
    boundary: z.literal("provider_snapshot_at_acceptance"),
    sourceThreadId: z.string().min(1).max(128),
    sourceSessionId: z.string().min(1).max(128),
    historyMode: z.enum(["legacy", "paginated"]),
  })
  .strict();

const codexBranchCheckpointSchema = z.discriminatedUnion("version", [
  codexCompletedTurnBranchCheckpointSchema,
  codexLatestSnapshotBranchCheckpointSchema,
]);

type Ownership = {
  readonly token: symbol;
  handle?: CodexConversationHandle;
};

interface CatalogFetchResult {
  readonly catalog: BackendCatalog;
  readonly cacheable: boolean;
}

/**
 * Runtime-wide logical ownership. All profile drivers for one principal and
 * backend instance share this registry, preventing two actors from attaching
 * the same native thread through different profiles.
 */
export class CodexConversationOwnershipRegistry {
  readonly #owners = new Map<string, Ownership>();

  claim(threadId: string): {
    readonly install: (handle: CodexConversationHandle) => void;
    readonly release: () => void;
  } {
    if (this.#owners.has(threadId)) {
      throw codexError(
        "invalid_state",
        "This Codex thread already has an active owner.",
        "codex_thread_already_attached",
      );
    }
    const token = Symbol(threadId);
    const ownership: Ownership = { token };
    this.#owners.set(threadId, ownership);
    let released = false;
    return {
      install: (handle) => {
        if (released || this.#owners.get(threadId)?.token !== token) {
          throw new Error("codex_thread_ownership_lost");
        }
        ownership.handle = handle;
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.#owners.get(threadId)?.token === token) {
          this.#owners.delete(threadId);
        }
      },
    };
  }

  current(threadId: string): CodexConversationHandle | undefined {
    return this.#owners.get(threadId)?.handle;
  }

  size(): number {
    return this.#owners.size;
  }

  async interruptOwnedActiveTurns(): Promise<void> {
    await Promise.all([...this.#owners.values()].map(owner => owner.handle?.interruptForOwnedStop()));
  }
}

export interface CodexConversationDriverInput {
  readonly usageSink: UsageSink;
  readonly nativeNamespace: string;
  readonly resolveThreadEnvironment?: ThreadEnvironmentResolver;
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly client: CodexSharedClientFacade;
  readonly serverRequests: CodexServerRequestRouter;
  readonly ownership: CodexConversationOwnershipRegistry;
  readonly toolProvenanceKey: Uint8Array;
  readonly modelPolicy: CompiledBackendModelPolicy;
  readonly executionSettings: CodexExecutionSettingsProvider;
  readonly outputArtifacts: import("../../output-artifacts/contracts.js").OutputArtifactPublisher;
  readonly agentToolCliEnvironment: CodexAgentToolCliEnvironmentProvider;
  readonly composerSkillPreferences?: CodexComposerSkillPreferenceReader;
  readonly fastModeSessions?: CodexFastModeSessionRegistry;
  readonly goalSessions?: import("./codex-goal-session.js").CodexGoalSessionRegistry;
  readonly managedTui?: CodexManagedTuiController;
  readonly now?: () => string;
  readonly onError?: (error: unknown) => void;
}

export class CodexConversationBackendDriver implements ConversationBackendDriver {
  readonly #resolveThreadEnvironment: ThreadEnvironmentResolver;
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly #usageSink: UsageSink;
  readonly #subagentUsage: CodexSubagentUsageCoordinator;
  readonly #nativeNamespace: string;
  readonly #client: CodexSharedClientFacade;
  readonly #serverRequests: CodexServerRequestRouter;
  readonly #ownership: CodexConversationOwnershipRegistry;
  readonly #toolProvenanceKey: Uint8Array;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #executionSettings: CodexExecutionSettingsProvider;
  readonly #outputArtifacts: import("../../output-artifacts/contracts.js").OutputArtifactPublisher;
  readonly #agentToolCliEnvironment: CodexAgentToolCliEnvironmentProvider;
  readonly #composerSkillPreferences: CodexComposerSkillPreferenceReader;
  readonly #fastModeSessions: CodexFastModeSessionRegistry;
  readonly #goalSessions:
    import("./codex-goal-session.js").CodexGoalSessionRegistry | undefined;
  readonly #managedTui: CodexManagedTuiController | undefined;
  readonly #now: () => string;
  readonly #onError: (error: unknown) => void;
  /**
   * The native model catalog only changes with daemon restarts or operator
   * config changes, and the daemon does not service model/list while a turn
   * is active (publication would otherwise hang into the RPC timeout).
   * Cache per client lifecycle generation: a generation change (daemon
   * restart) invalidates, failures are never cached, and concurrent callers
   * share one in-flight fetch.
   */
  #catalogCache?: {
    readonly generation: number;
    readonly workspacePath: string;
    readonly preferenceRevision: number;
    readonly showOpenAIComposerSkills: boolean;
    readonly catalog: BackendCatalog;
  };
  #catalogInflight?: {
    readonly generation: number;
    readonly workspacePath: string;
    readonly preferenceRevision: number;
    readonly showOpenAIComposerSkills: boolean;
    readonly promise: Promise<BackendCatalog>;
  };
  readonly #newUsageCounters = new Map<string, number>();
  readonly #createInFlight = new Map<
    string,
    Promise<CreateConversationResult>
  >();

  constructor(input: CodexConversationDriverInput) {
    this.#resolveThreadEnvironment = input.resolveThreadEnvironment ?? (async () => Object.freeze({}));
    this.instance = input.instance;
    this.connection = input.connection;
    this.#usageSink = input.usageSink;
    this.#nativeNamespace = input.nativeNamespace;
    this.#client = input.client;
    this.#serverRequests = input.serverRequests;
    this.#ownership = input.ownership;
    this.#toolProvenanceKey = copyCodexSubmissionCorrelationKey(
      input.toolProvenanceKey,
    );
    this.#modelPolicy = input.modelPolicy;
    this.#executionSettings = input.executionSettings;
    this.#outputArtifacts = input.outputArtifacts;
    this.#agentToolCliEnvironment = input.agentToolCliEnvironment;
    this.#composerSkillPreferences =
      input.composerSkillPreferences ??
      defaultCodexComposerSkillPreferenceReader;
    this.#fastModeSessions =
      input.fastModeSessions ?? new CodexFastModeSessionRegistry();
    this.#goalSessions = input.goalSessions;
    this.#managedTui = input.managedTui;
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#onError = input.onError ?? (() => undefined);
    if (
      this.instance.kind !== "codex_app_server" ||
      this.connection.kind !== "codex_app_server" ||
      this.instance.id !== this.connection.backendInstanceId ||
      this.instance.tenantId !== this.connection.tenantId ||
      this.connection.ownerPrincipalId.length === 0
    ) {
      throw new Error("codex_driver_configuration_invalid");
    }
    this.#subagentUsage = new CodexSubagentUsageCoordinator({ client: this.#client, sink: this.#usageSink, nativeNamespace: this.#nativeNamespace,
      runtimeScope:{tenantId:this.connection.tenantId,principalId:this.connection.ownerPrincipalId,backendInstanceId:this.instance.id,
        executionEnvironmentId:this.connection.executionEnvironmentId,connectionProfileId:this.connection.id},onError:this.#onError });
    this.#client.subscribeNotifications((notification) => {
      if (
        notification.kind !== "decoded_notification" ||
        notification.method !== "skills/changed"
      ) {
        return;
      }
      try {
        refineCodexSkillsChangedNotification(notification.params);
        this.#catalogCache = undefined;
        this.#catalogInflight = undefined;
      } catch (error) {
        this.#onError(error);
      }
    });
  }

  async health(): Promise<BackendHealth> {
    const lifecycle = this.#client.lifecycleSnapshot();
    const available =
      this.instance.enabled &&
      this.connection.enabled &&
      (lifecycle.state === "ready" || lifecycle.state === "idle");
    return {
      available,
      checkedAt: this.#now(),
      ...(!available
        ? {
            diagnostic: {
              text:
                lifecycle.unavailableReason ===
                "runtime_configuration_unavailable"
                  ? "The Codex runtime configuration is unavailable."
                  : lifecycle.state === "circuit_open"
                    ? "The Codex daemon requires operator attention."
                    : "The Codex daemon is not ready.",
            },
          }
        : {}),
    };
  }

  #catalogLifecycle(
    context: BackendCatalogContext,
  ): ReturnType<CodexSharedClientFacade["lifecycleSnapshot"]> {
    this.#assertScope(context.scope);
    this.#assertWorkspace(context.workspace);
    const lifecycle = this.#client.lifecycleSnapshot();
    if (lifecycle.state !== "ready") throw daemonUnavailable();
    return lifecycle;
  }

  async catalog(context: BackendCatalogContext): Promise<BackendCatalog> {
    const lifecycle = this.#catalogLifecycle(context);
    const preferences = this.#composerSkillPreferences.read(context.scope);
    if (
      this.#catalogCache?.generation === lifecycle.generation &&
      this.#catalogCache.workspacePath === context.workspace.canonicalPath &&
      this.#catalogCache.preferenceRevision === preferences.revision &&
      this.#catalogCache.showOpenAIComposerSkills ===
        preferences.showOpenAIComposerSkills
    ) {
      return this.#catalogCache.catalog;
    }
    if (
      this.#catalogInflight?.generation === lifecycle.generation &&
      this.#catalogInflight.workspacePath === context.workspace.canonicalPath &&
      this.#catalogInflight.preferenceRevision === preferences.revision &&
      this.#catalogInflight.showOpenAIComposerSkills ===
        preferences.showOpenAIComposerSkills
    ) {
      return this.#catalogInflight.promise;
    }
    const entry = {
      generation: lifecycle.generation,
      workspacePath: context.workspace.canonicalPath,
      preferenceRevision: preferences.revision,
      showOpenAIComposerSkills: preferences.showOpenAIComposerSkills,
      promise: undefined as unknown as Promise<BackendCatalog>,
    };
    entry.promise = this.#fetchCatalog(
      lifecycle.generation,
      context.workspace.canonicalPath,
      preferences.showOpenAIComposerSkills,
    ).then(
      ({ catalog, cacheable }) => {
        if (this.#catalogInflight === entry) {
          this.#catalogInflight = undefined;
          if (cacheable) {
            this.#catalogCache = {
              generation: entry.generation,
              workspacePath: entry.workspacePath,
              preferenceRevision: entry.preferenceRevision,
              showOpenAIComposerSkills: entry.showOpenAIComposerSkills,
              catalog,
            };
          }
        }
        return catalog;
      },
      (error: unknown) => {
        // A failed fetch must not poison the cache — the next caller retries.
        if (this.#catalogInflight === entry) this.#catalogInflight = undefined;
        throw error;
      },
    );
    this.#catalogInflight = entry;
    return entry.promise;
  }

  /**
   * Uncached read for the designed fail-closed rechecks — import candidate
   * resolution and pre-submission execution-settings validation deliberately
   * revalidate against the live provider catalog before a mutation.
   */
  #modelCatalogFresh(
    context: BackendCatalogContext,
  ): Promise<BackendCatalog["models"]> {
    const lifecycle = this.#catalogLifecycle(context);
    return this.#fetchModels(lifecycle.generation);
  }

  async #fetchCatalog(
    generation: number,
    canonicalWorkspacePath: string,
    showOpenAIComposerSkills: boolean,
  ): Promise<CatalogFetchResult> {
    const models = await this.#fetchModels(generation);
    try {
      const skillCatalog = await readCodexSkills(
        this.#client,
        canonicalWorkspacePath,
        false,
        showOpenAIComposerSkills,
      );
      this.#assertCatalogGeneration(generation, skillCatalog.generation);
      return {
        cacheable: true,
        catalog: {
          models,
          commands: [],
          skills: skillCatalog.skills.map(({ path: _path, ...skill }) => skill),
          notices:
            skillCatalog.errorCount > 0
              ? [
                  boundDisplayText(
                    `${skillCatalog.errorCount} Codex skill ${skillCatalog.errorCount === 1 ? "entry could" : "entries could"} not be loaded.`,
                  ),
                ]
              : [],
        },
      };
    } catch (error) {
      // Skills are additive presentation data. Keep models and settings
      // available when only skills/list fails, but never install a catalog
      // captured across a daemon generation change.
      this.#assertCatalogGeneration(generation, generation);
      this.#onError(error);
      return {
        cacheable: false,
        catalog: {
          models,
          commands: [],
          skills: [],
          notices: [
            boundDisplayText("Codex skills are temporarily unavailable."),
          ],
        },
      };
    }
  }

  async #fetchModels(generation: number): Promise<BackendCatalog["models"]> {
    const nativeIds = new Set<string>();
    const cursors = new Set<string>();
    const models: BackendCatalog["models"][number][] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAXIMUM_MODEL_CATALOG_PAGES; page += 1) {
        const remaining = CODEX_C2_MAX_CATALOG_ITEMS - nativeIds.size;
        if (remaining <= 0) {
          throw invalidModelCatalog("codex_model_catalog_too_large");
        }
        const response = await this.#client.requestWithReceipt(
          codexModelListMethod,
          {
            ...(cursor ? { cursor } : {}),
            limit: remaining,
            includeHidden: false,
          },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
        );
        this.#assertCatalogGeneration(generation, response.generation);
        this.#appendCatalogModels(response.result, nativeIds, models);
        const nextCursor = response.result.nextCursor;
        if (nextCursor === null) {
          return models;
        }
        if (
          nextCursor.length === 0 ||
          Buffer.byteLength(nextCursor, "utf8") > MAXIMUM_CURSOR_BYTES ||
          cursors.has(nextCursor)
        ) {
          throw invalidModelCatalog("codex_model_catalog_cursor_invalid");
        }
        cursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw invalidModelCatalog("codex_model_catalog_page_limit");
    } catch (error) {
      throw mapCodexReadError(error);
    }
  }

  #assertCatalogGeneration(expected: number, received: number): void {
    const current = this.#client.lifecycleSnapshot();
    if (
      received !== expected ||
      current.state !== "ready" ||
      current.generation !== received
    ) {
      throw codexError(
        "unavailable",
        "The Codex daemon generation changed while reading its model catalog.",
        "codex_generation_changed",
        true,
      );
    }
  }

  #appendCatalogModels(
    page: CodexModelListResponse,
    nativeIds: Set<string>,
    output: BackendCatalog["models"][number][],
  ): void {
    if (page.data.length > CODEX_C2_MAX_CATALOG_ITEMS - nativeIds.size) {
      throw invalidModelCatalog("codex_model_catalog_too_large");
    }
    for (const model of page.data) {
      if (
        model.id.trim().length === 0 ||
        model.id.length > 120 ||
        nativeIds.has(model.id)
      ) {
        throw invalidModelCatalog(
          nativeIds.has(model.id)
            ? "codex_model_catalog_duplicate_id"
            : "codex_model_catalog_id_invalid",
        );
      }
      nativeIds.add(model.id);
      if (model.hidden) {
        continue;
      }
      const label = boundDisplayText(
        model.displayName.trim() || model.model.trim() || model.id,
      ).text;
      if (!label) {
        throw invalidModelCatalog("codex_model_catalog_label_invalid");
      }
      const advertisedReasoningEfforts = model.supportedReasoningEfforts.map(
        ({ reasoningEffort }) => reasoningEffort,
      );
      if (
        !model.inputModalities.includes("text") ||
        new Set(model.inputModalities).size !== model.inputModalities.length
      ) {
        throw invalidModelCatalog(
          "codex_model_catalog_input_modalities_invalid",
        );
      }
      if (
        advertisedReasoningEfforts.length === 0 ||
        new Set(advertisedReasoningEfforts).size !==
          advertisedReasoningEfforts.length ||
        advertisedReasoningEfforts.some(
          (effort) => effort.trim().length === 0 || effort.length > 120,
        ) ||
        model.defaultReasoningEffort.length > 120 ||
        !advertisedReasoningEfforts.includes(model.defaultReasoningEffort)
      ) {
        throw invalidModelCatalog(
          "codex_model_catalog_reasoning_efforts_invalid",
        );
      }
      const supportedReasoningEfforts =
        this.#modelPolicy.filterReasoningEfforts(
          { modelId: model.id },
          advertisedReasoningEfforts,
        );
      if (supportedReasoningEfforts.length === 0) continue;
      const serviceTierIds = model.serviceTiers.map(({ id }) => id);
      // Codex 0.153 advertises Ultrafast as a distinct native tier. Sedes has
      // no corresponding normalized selection, so admit its reviewed catalog
      // metadata while continuing to project only the pinned Fast tier.
      if (
        new Set(serviceTierIds).size !== serviceTierIds.length ||
        serviceTierIds.some(
          (id) =>
            id.trim().length === 0 ||
            id.length > 120 ||
            (id !== CODEX_NATIVE_FAST_SERVICE_TIER &&
              id !== CODEX_NATIVE_ULTRAFAST_SERVICE_TIER),
        )
      ) {
        throw invalidModelCatalog(
          new Set(serviceTierIds).size !== serviceTierIds.length
            ? "codex_model_catalog_service_tier_duplicate"
            : "codex_model_catalog_service_tier_unknown",
        );
      }
      const fastTier = model.serviceTiers.find(
        ({ id }) => id === CODEX_NATIVE_FAST_SERVICE_TIER,
      );
      const fastDescription = fastTier?.description.trim();
      output.push({
        // model/list has no provider field. Namespace the catalog by the
        // immutable Sedes connection rather than inventing "openai" for
        // custom Codex model providers.
        provider: this.connection.id,
        id: model.id,
        label,
        inputModalities: model.inputModalities.filter(
          (modality): modality is "text" | "image" =>
            modality === "text" || modality === "image",
        ),
        ...(model.isDefault &&
        supportedReasoningEfforts.includes(model.defaultReasoningEffort)
          ? { isDefault: true as const }
          : {}),
        supportedReasoningEfforts,
        ...(supportedReasoningEfforts.includes(model.defaultReasoningEffort)
          ? { defaultReasoningEffort: model.defaultReasoningEffort }
          : {}),
        ...(fastTier
          ? {
              fastMode: {
                supported: true as const,
                defaultSelection:
                  model.defaultServiceTier === CODEX_NATIVE_FAST_SERVICE_TIER
                    ? ("fast" as const)
                    : ("standard" as const),
                ...(fastDescription
                  ? { description: boundDisplayText(fastDescription).text }
                  : {}),
              },
            }
          : {}),
      });
    }
  }

  async discover(
    input: DiscoverConversationsInput,
  ): Promise<DiscoveredConversationPage> {
    throwIfDiscoveryAborted(input.signal);
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > CODEX_C1_MAX_LIST_THREADS
    ) {
      throw codexError(
        "rejected",
        "The requested Codex discovery page size is invalid.",
        "codex_discovery_page_limit_invalid",
      );
    }
    const fingerprint = discoveryFingerprint(
      this.instance.id,
      this.connection.id,
      input.workspace.canonicalPath,
    );
    return await withCodexDiscoveryDeadline(input.signal, async (signal) => {
      const lifecycle = this.#client.lifecycleSnapshot();
      if (lifecycle.state !== "ready") throw daemonUnavailable();
      const providerCursor = input.cursor
        ? parseDiscoveryCursor(input.cursor, fingerprint, lifecycle.generation)
        : undefined;
      try {
        const response = await this.#client.requestWithReceipt(
          codexThreadListMethod,
          {
            ...(providerCursor ? { cursor: providerCursor } : {}),
            limit: input.limit,
            sortKey: "updated_at",
            sortDirection: "desc",
            sourceKinds: [...CODEX_DISCOVERY_SOURCE_KINDS],
            archived: false,
            cwd: input.workspace.canonicalPath,
            useStateDbOnly: true,
          },
          {
            timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
            signal,
          },
        );
        throwIfDiscoveryAborted(signal);
        const current = this.#client.lifecycleSnapshot();
        if (
          response.generation !== lifecycle.generation ||
          current.state !== "ready" ||
          current.generation !== response.generation
        ) {
          throw codexError(
            "unavailable",
            "The Codex daemon generation changed during discovery.",
            "codex_generation_changed",
            true,
          );
        }
        const ids = new Set<string>();
        const conversations = [];
        for (const thread of response.result.data) {
          throwIfDiscoveryAborted(signal);
          if (ids.has(thread.id)) {
            throw codexError(
              "incompatible_protocol",
              "Codex returned a duplicate thread identity.",
              "codex_discovery_duplicate_thread",
            );
          }
          ids.add(thread.id);
          if (
            !isCodexDiscoverableThread(thread, input.workspace.canonicalPath)
          ) {
            continue;
          }
          const forkInspection = thread.forkedFromId
            ? await this.#readNativeForkEvidence(
                thread,
                input.workspace,
                response.generation,
                signal,
              )
            : undefined;
          throwIfDiscoveryAborted(signal);
          const forkEvidence = forkInspection?.evidence;
          conversations.push({
            backendConversationId: thread.id,
            canonicalWorkspacePath: thread.cwd,
            ...(threadTitle(thread) ? { title: threadTitle(thread) } : {}),
            updatedAt: epochSecondsToIso(thread.recencyAt ?? thread.updatedAt),
            opaqueBindingDetail: serializeCodexBindingDetail({
              threadId: thread.id,
              sessionId: thread.sessionId,
              correlationAncestorThreadIds:
                forkInspection?.correlationAncestorThreadIds ??
                (thread.forkedFromId ? [thread.forkedFromId] : []),
              nativeAncestry: thread.forkedFromId
                ? {
                    forkedFromThreadId: thread.forkedFromId,
                    sourceTurnId: forkEvidence?.nativeSourceTurnId ?? null,
                  }
                : null,
            }),
            ...(thread.forkedFromId
              ? {
                  nativeAncestry: {
                    method: "provider_native" as const,
                    parentBackendConversationId: thread.forkedFromId,
                    ...(forkEvidence
                      ? {
                          applicationOperationId:
                            forkEvidence.applicationOperationId,
                          childIdentity: "provider_assigned" as const,
                          creationRecovery: "potentially_unknown" as const,
                          ...(forkEvidence.sourceBackendTurnId
                            ? {
                                sourceBackendTurnId:
                                  forkEvidence.sourceBackendTurnId,
                              }
                            : {}),
                        }
                      : {}),
                  },
                }
              : {}),
          });
        }
        this.#assertDiscoveryGeneration(
          response.generation,
          response.generation,
        );
        return {
          conversations,
          ...(response.result.nextCursor
            ? {
                nextCursor: serializeDiscoveryCursor({
                  fingerprint,
                  generation: response.generation,
                  providerCursor: response.result.nextCursor,
                }),
              }
            : {}),
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw mapCodexReadError(error);
      }
    });
  }

  create(input: CreateConversationInput): Promise<CreateConversationResult> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    if (input.requestedBackendConversationId !== undefined) {
      return Promise.reject(
        codexError(
          "rejected",
          "Codex assigns conversation identity; a requested backend ID is not accepted.",
          "codex_create_requested_id_forbidden",
        ),
      );
    }
    const correlation = input.creationCorrelation?.trim() ?? "";
    if (
      !correlation ||
      correlation.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(correlation)
    ) {
      return Promise.reject(
        codexError(
          "rejected",
          "Codex creation requires a durable correlation token.",
          "codex_create_correlation_invalid",
        ),
      );
    }
    const cacheKey = [
      input.applicationThreadId,
      input.applicationOperationId,
      JSON.stringify(input.source),
      correlation,
      input.workspace.canonicalPath,
    ].join("\0");
    const inFlight = this.#createInFlight.get(cacheKey);
    if (inFlight) return inFlight;
    const operation = this.#createOnce(input, correlation).finally(() => {
      if (this.#createInFlight.get(cacheKey) === operation) {
        this.#createInFlight.delete(cacheKey);
      }
    });
    this.#createInFlight.set(cacheKey, operation);
    return operation;
  }

  async #createOnce(
    input: CreateConversationInput,
    correlation: string,
  ): Promise<CreateConversationResult> {
    const lifecycle = this.#client.lifecycleSnapshot();
    if (lifecycle.state !== "ready") {
      throw mapCodexCreateError(daemonUnavailable());
    }
    const executionSnapshot =
      await this.#executionSettings.freezeOperationSnapshot(input.scope, {
        applicationThreadId: input.applicationThreadId,
        applicationOperationId: input.applicationOperationId,
        source: input.source,
        now: this.#nowMilliseconds(),
      });
    const executionSettings = executionSnapshot.settings;
    await this.#assertExecutionSettingsAvailable(
      input.scope,
      input.workspace,
      executionSettings,
    );
    const providerPolicy = codexExecutionPolicy(executionSettings).thread;
    const cliEnvironment = await this.#acquireAgentToolCliEnvironment(
      input.scope,
      input.applicationThreadId,
    );
    let matchedNotificationThreadId: string | undefined;
    let contradictoryNotificationHistoryMode = false;
    let unsubscribe: () => void = () => undefined;
    let mutationGeneration: number | undefined;
    try {
      unsubscribe = this.#client.subscribeNotifications((notification) => {
        if (
          notification.kind !== "decoded_notification" ||
          notification.generation !== lifecycle.generation ||
          notification.method !== "thread/started"
        ) {
          return;
        }
        try {
          const { thread } = refineCodexThreadStartedNotification(
            notification.params,
          );
          if (
            thread.threadSource === correlation &&
            thread.cwd === input.workspace.canonicalPath &&
            thread.ephemeral === false
          ) {
            if (thread.historyMode === "paginated") {
              matchedNotificationThreadId = thread.id;
            } else {
              contradictoryNotificationHistoryMode = true;
            }
          }
        } catch (error) {
          this.#onError(error);
        }
      });
      const response = await this.#client.requestWithReceipt(
        codexThreadStartMethod,
        {
          model: executionSettings.model,
          serviceTier: encodeCodexServiceTier(executionSettings.serviceTier),
          cwd: input.workspace.canonicalPath,
          approvalPolicy: providerPolicy.approvalPolicy,
          approvalsReviewer: providerPolicy.approvalsReviewer,
          sandbox: providerPolicy.sandbox,
          config: await this.#threadConfig(
            input.applicationThreadId,
            {
              ...providerPolicy.configOverrides,
              model_reasoning_effort: executionSettings.reasoningEffort,
            },
            cliEnvironment,
          ),
          ephemeral: false,
          historyMode: "paginated",
          threadSource: correlation,
        },
        { environmentVariablesFingerprint: this.#resolveThreadEnvironment.fingerprint?.(input.applicationThreadId), timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS, runtimeCorrelation: { kind: "create", applicationOperationId: input.applicationOperationId, applicationThreadId: input.applicationThreadId } },
      );
      mutationGeneration = response.generation;
      const current = this.#client.lifecycleSnapshot();
      if (
        response.generation !== lifecycle.generation ||
        current.state !== "ready" ||
        current.generation !== response.generation
      ) {
        throw codexError(
          "submission_unknown",
          "The Codex daemon generation changed during thread creation.",
          "codex_create_generation_changed",
          false,
          undefined,
          true,
        );
      }
      const thread = response.result.thread;
      if (
        !thread.id ||
        thread.ephemeral !== false ||
        thread.cwd !== input.workspace.canonicalPath ||
        thread.threadSource !== correlation ||
        thread.historyMode !== "paginated" ||
        response.result.cwd !== input.workspace.canonicalPath
      ) {
        throw codexError(
          "submission_unknown",
          "Codex returned an invalid create response.",
          "codex_create_response_invalid",
          false,
          undefined,
          true,
        );
      }
      try {
        this.#executionSettings.observeEffective(input.scope, {
          applicationThreadId: input.applicationThreadId,
          settings: codexObservedThreadExecutionSettings(
            response.result.model,
            response.result.reasoningEffort,
            response.result.serviceTier,
            response.result.approvalPolicy,
            response.result.approvalsReviewer,
            response.result.sandbox,
          ),
          confirmationGeneration: response.generation,
          now: this.#nowMilliseconds(),
        });
      } catch (error) {
        // The provider identity is known and must still be bound. A local
        // confirmation write failure leaves settings pending/unknown; it must
        // never be reclassified as an orphan-risk create outcome.
        this.#reportError(error);
      }
      const fastModeProjection = await this.#fastModeSessions.refresh({
        scope: input.scope,
        applicationThreadId: input.applicationThreadId,
        nativeThreadId: thread.id,
        connectionGeneration: response.generation,
        client: this.#client,
      });
      if (fastModeProjection.unavailableReason === "feature_disabled") {
        this.#executionSettings.resolveFastModeDisabled(input.scope, {
          applicationThreadId: input.applicationThreadId,
          now: this.#nowMilliseconds(),
        });
      }
      this.#newUsageCounters.set(thread.id, lifecycle.generation);
      const result: CreateConversationResult = Object.freeze({
        backendConversationId: thread.id,
        reconciliationToken: token(
          "create",
          input.applicationOperationId,
          thread.id,
          correlation,
        ),
        opaqueBindingDetail: serializeCodexBindingDetail({
          threadId: thread.id,
          sessionId: thread.sessionId,
          correlationAncestorThreadIds: [],
          nativeAncestry: null,
        }),
      });
      return result;
    } catch (error) {
      const initialMapped = mapCodexCreateError(error);
      const hasMatchingNotificationEvidence =
        matchedNotificationThreadId !== undefined ||
        contradictoryNotificationHistoryMode;
      const mapped =
        hasMatchingNotificationEvidence &&
        !initialMapped.crossedSubmissionBoundary
          ? codexError(
              "submission_unknown",
              "Codex reported a created thread but did not return its authoritative create response.",
              "codex_create_notification_without_response",
              false,
              error,
              true,
            )
          : initialMapped;
      if (mapped.crossedSubmissionBoundary) {
        try {
          await this.#client.retireGeneration(
            mutationGeneration ??
              codexRpcErrorGeneration(error) ??
              lifecycle.generation,
            "codex_create_outcome_unknown",
          );
        } catch (retirementError) {
          try {
            this.#onError(retirementError);
          } catch {
            // Diagnostics observers must not replace the authoritative
            // non-idempotent creation outcome.
          }
        }
      }
      throw mapped;
    } finally {
      unsubscribe();
      releaseAgentToolCliEnvironment(cliEnvironment);
    }
  }

  async attach(input: AttachConversationInput): Promise<ConversationHandle> {
    this.#assertAttach(input);
    const detail = parseCodexBindingDetail(input.opaqueBindingDetail);
    const ownership = this.#ownership.claim(
      input.binding.backendConversationId,
    );
    try {
      const resolvedModelInputModalities = new Map<
        string,
        readonly ("text" | "image")[]
      >();
      const handle = new CodexConversationHandle({
        usageSink: this.#usageSink,
        nativeNamespace: this.#nativeNamespace,
        usageProvenZero: this.#newUsageCounters.get(input.binding.backendConversationId) === this.#client.lifecycleSnapshot().generation,
        resolveThreadEnvironment: this.#resolveThreadEnvironment,
        binding: input.binding,
        canonicalWorkspacePath: input.workspace.canonicalPath,
        workspaceId: input.workspace.summary.id,
        opaqueBindingDetail: input.opaqueBindingDetail,
        client: this.#client,
        serverRequests: this.#serverRequests,
        toolProvenanceKey: copyCodexSubmissionCorrelationKey(
          this.#toolProvenanceKey,
        ),
        correlationAncestorThreadIds: detail.correlationAncestorThreadIds,
        executionSettings: this.#executionSettings,
        outputArtifacts: this.#outputArtifacts,
        fastModeSessions: this.#fastModeSessions,
        agentToolCliEnvironment: this.#agentToolCliEnvironment,
        composerSkillPreferences: this.#composerSkillPreferences,
        validateExecutionSettings: async (settings) =>
          await this.#assertExecutionSettingsAvailable(
            input.scope,
            input.workspace,
            settings,
            input.binding.applicationThreadId,
          ),
        assertModelPolicyAllowed: (model, reasoningEffort) =>
          this.#assertModelPolicyAllowed(model, reasoningEffort),
        resolveImportedReasoningEffort: async (model, observedEffort) => {
          const models = await this.#modelCatalogFresh({
            scope: input.scope,
            workspace: input.workspace,
          });
          const descriptor = models.find(
            (candidate) =>
              candidate.provider === this.connection.id &&
              candidate.id === model,
          );
          if (descriptor) {
            resolvedModelInputModalities.set(model, descriptor.inputModalities);
          }
          if (!descriptor?.supportedReasoningEfforts?.length) return undefined;
          if (observedEffort !== null) {
            return descriptor.supportedReasoningEfforts.includes(observedEffort)
              ? observedEffort
              : undefined;
          }
          return descriptor.defaultReasoningEffort &&
            descriptor.supportedReasoningEfforts.includes(
              descriptor.defaultReasoningEffort,
            )
            ? descriptor.defaultReasoningEffort
            : undefined;
        },
        resolveModelInputModalities: async (model, fresh) => {
          const cached = resolvedModelInputModalities.get(model);
          if (!fresh && cached) return cached;
          const models = await this.#modelCatalogFresh({
            scope: input.scope,
            workspace: input.workspace,
          });
          const inputModalities = models.find(
            (candidate) =>
              candidate.provider === this.connection.id &&
              candidate.id === model,
          )?.inputModalities ?? ["text"];
          resolvedModelInputModalities.set(model, inputModalities);
          return inputModalities;
        },
        ...(this.#goalSessions ? { goalSessions: this.#goalSessions } : {}),
        ...(this.#managedTui ? { managedTui: this.#managedTui } : {}),
        now: () => this.#nowMilliseconds(),
        releaseOwnership: ownership.release,
        onError: this.#onError,
      });
      this.#newUsageCounters.delete(input.binding.backendConversationId);
      ownership.install(handle);
      this.#subagentUsage.registerRoot(input.binding);
      return handle;
    } catch (error) {
      ownership.release();
      throw mapCodexReadError(error);
    }
  }

  async read(input: ReadConversationInput): Promise<ConversationReadResult> {
    this.#assertAttach(input);
    const detail = parseCodexBindingDetail(input.opaqueBindingDetail);
    const active = this.#ownership.current(input.binding.backendConversationId);
    if (active) return await active.readCurrent();
    const metadataReceipt = await this.#client
      .requestWithReceipt(
        codexThreadReadMethod,
        {
          threadId: input.binding.backendConversationId,
          includeTurns: false,
        },
        { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS },
      )
      .catch((error: unknown) => {
        throw mapCodexReadError(error);
      });
    const metadata = metadataReceipt.result.thread;
    assertThreadBinding(
      metadata,
      input.binding.backendConversationId,
      input.workspace.canonicalPath,
    );
    const scope = this.#correlationScope(
      metadata.id,
      detail.correlationAncestorThreadIds,
    );
    let thread: CodexThread;
    switch (metadata.historyMode) {
      case "legacy":
        thread = await this.#readNativeThread(
          input.binding.backendConversationId,
          input.workspace,
          detail.correlationAncestorThreadIds,
          input.binding.applicationThreadId,
          true,
          "legacy",
        );
        break;
      case "paginated":
        try {
          thread = await new CodexPaginatedHistoryAdapter({
            client: this.#client,
            thread: metadata,
            generation: metadataReceipt.generation,
            correlationScope: scope,
          }).readDetachedHead(10, new AbortController().signal);
        } catch (error) {
          throw mapCodexReadError(error);
        }
        break;
      default:
        throw codexError(
          "incompatible_protocol",
          "Codex returned an unsupported history mode.",
          "codex_history_mode_invalid",
        );
    }
    const projection = await this.#projectThreadHistory(
      thread,
      detail.correlationAncestorThreadIds,
      input.binding.applicationThreadId,
      10,
      metadata.historyMode,
    );
    const current = this.#client.lifecycleSnapshot();
    if (
      current.state !== "ready" ||
      current.generation !== metadataReceipt.generation
    ) {
      throw codexError(
        "unavailable",
        "Codex changed generation while the detached history was loading.",
        "codex_history_reconciliation_required",
        true,
      );
    }
    return {
      snapshot: selectCodexSnapshotWindow(projection.snapshot).snapshot,
      usage: {},
    };
  }

  async resolveBranchCheckpoint(
    input: ResolveBranchCheckpointInput,
  ): Promise<BackendCheckpointRef> {
    this.#assertAttach(input);
    const detail = parseCodexBindingDetail(input.opaqueBindingDetail);
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS);
    const metadataReceipt = await this.#client
      .requestWithReceipt(
        codexThreadReadMethod,
        {
          threadId: input.binding.backendConversationId,
          includeTurns: false,
        },
        { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS, signal },
      )
      .catch((error: unknown) => {
        throw mapCodexReadError(error);
      });
    const metadata = metadataReceipt.result.thread;
    assertThreadBinding(
      metadata,
      input.binding.backendConversationId,
      input.workspace.canonicalPath,
    );
    if (input.selection.kind === "latest_provider_snapshot") {
      const lifecycle = this.#client.lifecycleSnapshot();
      if (
        lifecycle.state !== "ready" ||
        lifecycle.generation !== metadataReceipt.generation
      ) {
        throw codexError(
          "unavailable",
          "Codex changed generation while resolving the fork checkpoint.",
          "codex_history_reconciliation_required",
          true,
        );
      }
      return {
        backendInstanceId: this.instance.id,
        kind: "conversation_leaf",
        opaqueReference: serializeCodexBranchCheckpoint({
          version: 4,
          boundary: "provider_snapshot_at_acceptance",
          sourceThreadId: metadata.id,
          sourceSessionId: metadata.sessionId,
          historyMode: metadata.historyMode,
        }),
      };
    }
    if (
      input.selection.kind === "latest_completed" &&
      metadata.status.type !== "idle"
    ) {
      throw codexError(
        "invalid_state",
        "The Codex source must be authoritatively idle before its latest completed turn can be forked. Select an earlier completed turn instead.",
        "codex_fork_source_not_idle",
      );
    }
    const selectedBackendTurnId =
      input.selection.kind === "selected_completed_turn"
        ? input.selection.backendTurnId
        : undefined;
    let selected: CodexTurn | undefined;
    if (metadata.historyMode === "legacy") {
      const completeReceipt = await this.#client
        .requestWithReceipt(
          codexThreadReadMethod,
          { threadId: metadata.id, includeTurns: true },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS, signal },
        )
        .catch((error: unknown) => {
          throw mapCodexReadError(error);
        });
      if (completeReceipt.generation !== metadataReceipt.generation) {
        throw codexError(
          "unavailable",
          "Codex changed generation while resolving the fork checkpoint.",
          "codex_history_reconciliation_required",
          true,
        );
      }
      const complete = completeReceipt.result.thread;
      assertThreadBinding(complete, metadata.id, input.workspace.canonicalPath);
      if (complete.historyMode !== "legacy") {
        throw codexError(
          "incompatible_protocol",
          "Codex changed history mode while resolving the fork checkpoint.",
          "codex_history_mode_changed",
        );
      }
      const hidden = inspectCodexForkContextBoundaries(
        complete,
        this.#correlationScope(
          complete.id,
          detail.correlationAncestorThreadIds,
        ),
      ).nativeTurnIds;
      selected =
        selectedBackendTurnId === undefined
          ? complete.turns.findLast(
              (turn) => turn.status === "completed" && !hidden.has(turn.id),
            )
          : complete.turns.find(
              (turn) =>
                !hidden.has(turn.id) &&
                codexBackendTurnId(complete.id, turn.id) ===
                  selectedBackendTurnId,
            );
    } else if (metadata.historyMode === "paginated") {
      selected = (
        await new CodexPaginatedHistoryAdapter({
          client: this.#client,
          thread: metadata,
          generation: metadataReceipt.generation,
          correlationScope: this.#correlationScope(
            metadata.id,
            detail.correlationAncestorThreadIds,
          ),
        }).findCompletedTurn(selectedBackendTurnId, signal)
      )?.turn;
    } else {
      throw codexError(
        "incompatible_protocol",
        "Codex returned an unsupported history mode.",
        "codex_history_mode_invalid",
      );
    }
    if (
      !selected ||
      selected.status !== "completed" ||
      selected.itemsView !== "full"
    ) {
      throw codexError(
        "invalid_state",
        "The selected Codex turn is not a durable successfully completed fork boundary.",
        "codex_fork_checkpoint_unavailable",
      );
    }
    const settledLifecycle = this.#client.lifecycleSnapshot();
    if (
      settledLifecycle.state !== "ready" ||
      settledLifecycle.generation !== metadataReceipt.generation
    ) {
      throw codexError(
        "unavailable",
        "Codex changed generation while resolving the fork checkpoint.",
        "codex_history_reconciliation_required",
        true,
      );
    }
    return {
      backendInstanceId: this.instance.id,
      kind: "conversation_leaf",
      opaqueReference: serializeCodexBranchCheckpoint({
        version: 3,
        sourceThreadId: metadata.id,
        sourceSessionId: metadata.sessionId,
        historyMode: metadata.historyMode,
        lastTurnId: selected.id,
        turnDigest: codexTurnPrefixDigest([selected]),
      }),
    };
  }

  async branchConversation(
    input: BranchConversationInput,
  ): Promise<CreateConversationResult> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    this.#assertSourceBinding(input.sourceBinding, input.workspace);
    if (
      input.sourceCheckpoint.backendInstanceId !== this.instance.id ||
      input.requestedBackendConversationId !== undefined ||
      !input.childApplicationThreadId ||
      !input.creationCorrelation ||
      input.creationCorrelation.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(input.creationCorrelation)
    ) {
      throw codexError(
        "rejected",
        "The Codex fork reservation is invalid.",
        "codex_fork_reservation_invalid",
      );
    }
    const checkpoint = parseCodexBranchCheckpoint(
      input.sourceCheckpoint.opaqueReference,
    );
    let sourceDetail;
    try {
      sourceDetail = parseCodexBindingDetail(input.sourceOpaqueBindingDetail);
    } catch {
      throw bindingMismatch();
    }
    if (
      checkpoint.sourceThreadId !== input.sourceBinding.backendConversationId ||
      sourceDetail.threadId !== input.sourceBinding.backendConversationId
    ) {
      throw bindingMismatch();
    }
    const lifecycle = this.#client.lifecycleSnapshot();
    if (lifecycle.state !== "ready") {
      throw mapCodexForkError(daemonUnavailable());
    }
    const evidenceSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS);
    const sourceMetadataReceipt = await this.#client
      .requestWithReceipt(
        codexThreadReadMethod,
        {
          threadId: input.sourceBinding.backendConversationId,
          includeTurns: false,
        },
        {
          timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
          signal: evidenceSignal,
        },
      )
      .catch((error: unknown) => {
        throw mapCodexForkError(error);
      });
    const sourceThread = sourceMetadataReceipt.result.thread;
    assertThreadBinding(
      sourceThread,
      input.sourceBinding.backendConversationId,
      input.workspace.canonicalPath,
    );
    if (
      sourceThread.sessionId !== checkpoint.sourceSessionId ||
      sourceThread.historyMode !== checkpoint.historyMode
    ) {
      throw codexError(
        "invalid_state",
        "The durable Codex fork checkpoint no longer matches the source history.",
        "codex_fork_checkpoint_changed",
      );
    }
    if (checkpoint.version === 3) {
      let selected: CodexTurn | undefined;
      if (sourceThread.historyMode === "legacy") {
        const completeReceipt = await this.#client
          .requestWithReceipt(
            codexThreadReadMethod,
            { threadId: sourceThread.id, includeTurns: true },
            {
              timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
              signal: evidenceSignal,
            },
          )
          .catch((error: unknown) => {
            throw mapCodexForkError(error);
          });
        if (completeReceipt.generation !== sourceMetadataReceipt.generation) {
          throw codexError(
            "unavailable",
            "Codex changed generation while validating the fork checkpoint.",
            "codex_history_reconciliation_required",
            true,
          );
        }
        const complete = completeReceipt.result.thread;
        assertThreadBinding(
          complete,
          sourceThread.id,
          input.workspace.canonicalPath,
        );
        if (complete.historyMode !== "legacy") {
          throw codexError(
            "incompatible_protocol",
            "Codex changed history mode while validating the fork checkpoint.",
            "codex_history_mode_changed",
          );
        }
        selected = complete.turns.find(
          ({ id }) => id === checkpoint.lastTurnId,
        );
      } else if (sourceThread.historyMode === "paginated") {
        selected = (
          await new CodexPaginatedHistoryAdapter({
            client: this.#client,
            thread: sourceThread,
            generation: sourceMetadataReceipt.generation,
            correlationScope: this.#correlationScope(
              sourceThread.id,
              sourceDetail.correlationAncestorThreadIds,
            ),
          }).findCompletedTurn(
            codexBackendTurnId(sourceThread.id, checkpoint.lastTurnId),
            evidenceSignal,
          )
        )?.turn;
      }
      if (
        !selected ||
        selected.status !== "completed" ||
        selected.itemsView !== "full" ||
        codexTurnPrefixDigest([selected]) !== checkpoint.turnDigest
      ) {
        throw codexError(
          "invalid_state",
          "The durable Codex fork checkpoint no longer matches the source history.",
          "codex_fork_checkpoint_changed",
        );
      }
    }
    const childDesired = this.#executionSettings.desiredSettings(
      input.scope,
      input.childApplicationThreadId,
    );
    if (childDesired?.serviceTier === "fast") {
      const currentModels = await this.#modelCatalogFresh({
        scope: input.scope,
        workspace: input.workspace,
      });
      const selectedModel = currentModels.find(
        (candidate) =>
          candidate.provider === this.connection.id &&
          candidate.id === childDesired.model,
      );
      if (selectedModel && !selectedModel.fastMode) {
        this.#executionSettings.resolveFastModeDisabled(input.scope, {
          applicationThreadId: input.childApplicationThreadId,
          now: this.#nowMilliseconds(),
        });
      }
    }
    const executionSnapshot =
      await this.#executionSettings.freezeOperationSnapshot(input.scope, {
        applicationThreadId: input.childApplicationThreadId,
        applicationOperationId: input.applicationOperationId,
        source: input.source,
        now: this.#nowMilliseconds(),
      });
    const executionSettings = executionSnapshot.settings;
    await this.#assertExecutionSettingsAvailable(
      input.scope,
      input.workspace,
      executionSettings,
      input.childApplicationThreadId,
    );
    const providerPolicy = codexExecutionPolicy(executionSettings).thread;
    const cliEnvironment = await this.#acquireAgentToolCliEnvironment(
      input.scope,
      input.childApplicationThreadId,
    );
    const forkMarker = codexForkCreationMarker({
      ...this.#correlationScope(input.sourceBinding.backendConversationId),
      applicationOperationId: input.applicationOperationId,
    });
    let forkParams: CodexThreadForkParams;
    try {
      forkParams = {
        threadId: input.sourceBinding.backendConversationId,
        ...(checkpoint.version === 3
          ? { lastTurnId: checkpoint.lastTurnId }
          : {}),
        excludeTurns: true,
        model: executionSettings.model,
        serviceTier: encodeCodexServiceTier(executionSettings.serviceTier),
        cwd: input.workspace.canonicalPath,
        approvalPolicy: providerPolicy.approvalPolicy,
        approvalsReviewer: providerPolicy.approvalsReviewer,
        sandbox: providerPolicy.sandbox,
        config: await this.#threadConfig(
          input.childApplicationThreadId,
          {
            ...providerPolicy.configOverrides,
            model_reasoning_effort: executionSettings.reasoningEffort,
          },
          cliEnvironment,
        ),
        ephemeral: false,
        threadSource: forkMarker,
      };
    } catch (error) {
      releaseAgentToolCliEnvironment(cliEnvironment);
      throw codexError(
        "rejected",
        "The Codex fork input is invalid.",
        "codex_fork_input_invalid",
        false,
        error,
        false,
      );
    }
    const mutationAdmission = this.#client.lifecycleSnapshot();
    if (mutationAdmission.state !== "ready") {
      releaseAgentToolCliEnvironment(cliEnvironment);
      throw mapCodexForkError(daemonUnavailable());
    }
    if (mutationAdmission.generation !== sourceMetadataReceipt.generation) {
      releaseAgentToolCliEnvironment(cliEnvironment);
      throw codexError(
        "unavailable",
        "Codex changed generation while preparing the native fork.",
        "codex_history_reconciliation_required",
        true,
      );
    }
    let mutationGeneration: number | undefined;
    try {
      const response = await this.#client.requestWithReceipt(
        codexThreadForkMethod,
        forkParams,
        { environmentVariablesFingerprint: this.#resolveThreadEnvironment.fingerprint?.(input.childApplicationThreadId), timeoutMilliseconds: FORK_REQUEST_TIMEOUT_MILLISECONDS, runtimeCorrelation: { kind: "fork", applicationOperationId: input.applicationOperationId, applicationThreadId: input.childApplicationThreadId } },
      );
      mutationGeneration = response.generation;
      const current = this.#client.lifecycleSnapshot();
      if (
        response.generation !== mutationAdmission.generation ||
        current.state !== "ready" ||
        current.generation !== response.generation
      ) {
        throw codexError(
          "submission_unknown",
          "The Codex daemon generation changed during native fork creation.",
          "codex_fork_generation_changed",
          false,
          undefined,
          true,
        );
      }
      const result = response.result;
      const child = result.thread;
      const childCorrelationAncestorThreadIds = [
        ...sourceDetail.correlationAncestorThreadIds,
        sourceDetail.threadId,
      ];
      const observedSettings = codexObservedThreadExecutionSettings(
        result.model,
        result.reasoningEffort,
        result.serviceTier,
        result.approvalPolicy,
        result.approvalsReviewer,
        result.sandbox,
      );
      const responseViolations = [
        child.id === input.sourceBinding.backendConversationId &&
          "child_identity",
        child.forkedFromId !== input.sourceBinding.backendConversationId &&
          "native_parent",
        child.parentThreadId !== null && "subagent_parent",
        child.ephemeral && "ephemeral_child",
        child.cwd !== input.workspace.canonicalPath && "child_workspace",
        result.cwd !== input.workspace.canonicalPath && "result_workspace",
        child.threadSource !== forkMarker && "creation_correlation",
        child.historyMode !== checkpoint.historyMode && "history_mode",
        child.status.type !== "idle" && "child_status",
        child.turns.length !== 0 && "response_turns",
        result.model !== executionSettings.model && "model",
        result.reasoningEffort !== executionSettings.reasoningEffort &&
          "reasoning_effort",
        (observedSettings.serviceTierClassification !== "recognized" ||
          observedSettings.serviceTier !== executionSettings.serviceTier) &&
          "service_tier",
        !codexForkSandboxMatches(result.sandbox, executionSettings) &&
          "sandbox",
        (observedSettings.networkClassification !== "recognized" ||
          observedSettings.networkAccess !== executionSettings.networkAccess) &&
          "network",
        (observedSettings.approvalPolicyClassification !== "recognized" ||
          observedSettings.approvalPolicy !==
            executionSettings.approvalPolicy) &&
          "approval_policy",
        (observedSettings.approvalReviewerClassification !== "recognized" ||
          observedSettings.approvalReviewer !==
            executionSettings.approvalReviewer) &&
          "approval_reviewer",
      ].filter((value): value is string => typeof value === "string");
      if (responseViolations.length > 0) {
        throw codexError(
          "submission_unknown",
          `Codex returned an ambiguous fork response (${responseViolations.join(", ")}); a full native copy may exist.`,
          "codex_fork_response_invalid",
          false,
          undefined,
          true,
        );
      }
      try {
        this.#executionSettings.observeEffective(input.scope, {
          applicationThreadId: input.childApplicationThreadId,
          settings: observedSettings,
          confirmationGeneration: response.generation,
          now: this.#nowMilliseconds(),
        });
      } catch (error) {
        this.#reportError(error);
      }
      const fastModeProjection = await this.#fastModeSessions.refresh({
        scope: input.scope,
        applicationThreadId: input.childApplicationThreadId,
        nativeThreadId: child.id,
        connectionGeneration: response.generation,
        client: this.#client,
      });
      if (fastModeProjection.unavailableReason === "feature_disabled") {
        this.#executionSettings.resolveFastModeDisabled(input.scope, {
          applicationThreadId: input.childApplicationThreadId,
          now: this.#nowMilliseconds(),
        });
      }
      return {
        backendConversationId: child.id,
        reconciliationToken: token(
          "fork",
          input.applicationOperationId,
          child.id,
          input.creationCorrelation,
        ),
        opaqueBindingDetail: serializeCodexBindingDetail({
          threadId: child.id,
          sessionId: child.sessionId,
          correlationAncestorThreadIds: [...childCorrelationAncestorThreadIds],
          nativeAncestry: {
            forkedFromThreadId: input.sourceBinding.backendConversationId,
            sourceTurnId:
              checkpoint.version === 3 ? checkpoint.lastTurnId : null,
          },
        }),
      };
    } catch (error) {
      const mapped = mapCodexForkError(error);
      if (mapped.crossedSubmissionBoundary) {
        try {
          await this.#client.retireGeneration(
            mutationGeneration ??
              codexRpcErrorGeneration(error) ??
              mutationAdmission.generation,
            "codex_fork_outcome_unknown",
          );
        } catch (retirementError) {
          this.#reportError(retirementError);
        }
      }
      throw mapped;
    } finally {
      releaseAgentToolCliEnvironment(cliEnvironment);
    }
  }

  async reconcileSubmission(
    input: ReconcileSubmissionInput,
  ): Promise<SubmissionReconciliation> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    const binding = input.binding;
    if (
      !binding ||
      binding.tenantId !== this.connection.tenantId ||
      binding.ownerPrincipalId !== this.connection.ownerPrincipalId ||
      binding.backendInstanceId !== this.instance.id ||
      binding.connectionProfileId !== this.connection.id ||
      binding.executionEnvironmentId !==
        this.connection.executionEnvironmentId ||
      !input.reconciliationToken ||
      !input.opaqueBindingDetail
    ) {
      return unresolvedSubmission(
        "Codex submission reconciliation is missing its durable binding or correlation token.",
      );
    }
    let detail;
    try {
      detail = parseCodexBindingDetail(input.opaqueBindingDetail);
    } catch {
      return unresolvedSubmission(
        "Codex submission reconciliation has invalid durable binding detail.",
      );
    }
    if (detail.threadId !== binding.backendConversationId) {
      return unresolvedSubmission(
        "Codex submission reconciliation binding detail does not match the conversation.",
      );
    }
    const expectedClientIds = codexSubmissionReconciliationClientUserMessageIds(
      {
        ...this.#correlationScope(binding.backendConversationId),
        applicationOperationId: input.applicationOperationId,
        reconciliationToken: input.reconciliationToken,
      },
    );
    try {
      const operationSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS);
      const metadataReceipt = await this.#client.requestWithReceipt(
        codexThreadReadMethod,
        { threadId: binding.backendConversationId, includeTurns: false },
        {
          timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
          signal: operationSignal,
        },
      );
      const metadata = metadataReceipt.result.thread;
      assertThreadBinding(
        metadata,
        binding.backendConversationId,
        input.workspace.canonicalPath,
      );
      let evidenceThread: CodexThread;
      let matchingTurn: CodexTurn | undefined;
      let matched = false;
      let duplicate = false;
      if (metadata.historyMode === "legacy") {
        const completeReceipt = await this.#client.requestWithReceipt(
          codexThreadReadMethod,
          { threadId: binding.backendConversationId, includeTurns: true },
          {
            timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
            signal: operationSignal,
          },
        );
        if (completeReceipt.generation !== metadataReceipt.generation) {
          throw codexError(
            "unavailable",
            "Codex changed generation during submission reconciliation.",
            "codex_history_reconciliation_required",
            true,
          );
        }
        evidenceThread = completeReceipt.result.thread;
        assertThreadBinding(
          evidenceThread,
          binding.backendConversationId,
          input.workspace.canonicalPath,
        );
        if (evidenceThread.historyMode !== "legacy") {
          throw codexError(
            "incompatible_protocol",
            "Codex changed history mode during submission reconciliation.",
            "codex_history_mode_changed",
          );
        }
        for (const turn of evidenceThread.turns) {
          const count = turn.items.filter(
            (item) =>
              item.type === "userMessage" &&
              item.clientId !== null &&
              expectedClientIds.includes(item.clientId),
          ).length;
          if (count > 1 || (count === 1 && matchingTurn)) duplicate = true;
          if (count === 1) {
            matched = true;
            if (!matchingTurn) matchingTurn = turn;
          }
        }
      } else if (metadata.historyMode === "paginated") {
        const adapter = new CodexPaginatedHistoryAdapter({
          client: this.#client,
          thread: metadata,
          generation: metadataReceipt.generation,
          correlationScope: this.#correlationScope(
            binding.backendConversationId,
            detail.correlationAncestorThreadIds,
          ),
        });
        const evidence = await adapter.findUserMessageByClientIds(
          expectedClientIds,
          operationSignal,
        );
        matched = evidence.matched;
        duplicate = evidence.duplicate;
        evidenceThread = {
          ...metadata,
          turns: evidence.terminalTurn ? [evidence.terminalTurn] : [],
        };
        const current = this.#client.lifecycleSnapshot();
        if (
          current.state !== "ready" ||
          current.generation !== metadataReceipt.generation
        ) {
          throw codexError(
            "unavailable",
            "Codex changed generation during submission reconciliation.",
            "codex_history_reconciliation_required",
            true,
          );
        }
      } else {
        throw codexError(
          "incompatible_protocol",
          "Codex returned an unsupported history mode.",
          "codex_history_mode_invalid",
        );
      }
      const settledLifecycle = this.#client.lifecycleSnapshot();
      if (
        settledLifecycle.state !== "ready" ||
        settledLifecycle.generation !== metadataReceipt.generation
      ) {
        throw codexError(
          "unavailable",
          "Codex changed generation during submission reconciliation.",
          "codex_history_reconciliation_required",
          true,
        );
      }
      if (matched && !duplicate) {
        if (!matchingTurn) return { status: "accepted" };
        let projection: CodexHistoryProjection;
        try {
          projection = await this.#projectThreadHistory(
            { ...metadata, turns: [matchingTurn] },
            detail.correlationAncestorThreadIds,
            binding.applicationThreadId,
          );
        } catch {
          return { status: "accepted" };
        }
        const backendTurnId = projection.backendTurnIdByNativeId.get(
          matchingTurn.id,
        );
        const backendTurn = backendTurnId
          ? projection.snapshot.turnsById[backendTurnId]
          : undefined;
        if (!backendTurnId || !backendTurn) {
          return unresolvedSubmission(
            "Codex accepted the correlated message but its turn could not be projected.",
          );
        }
        return {
          status: "accepted",
          backendTurn,
          ...(backendTurn.status === "completed" ||
          backendTurn.status === "interrupted" ||
          backendTurn.status === "failed"
            ? {
                completionIdentity: `${backendTurnId}:${backendTurn.status}`,
              }
            : {}),
        };
      }
      if (duplicate) {
        return unresolvedSubmission(
          "Codex history contains duplicate submission correlation identities.",
        );
      }
      if (
        input.retryAnchor &&
        codexSubmissionRetryAnchorMatches(input.retryAnchor, evidenceThread)
      ) {
        return { status: "not_accepted", retryable: true };
      }
      return unresolvedSubmission(
        "Codex history diverged from the submission retry anchor without a correlated message.",
      );
    } catch {
      return unresolvedSubmission(
        "Codex history is unavailable, so the submission outcome remains unknown.",
      );
    }
  }

  async #readNativeThread(
    threadId: string,
    workspace: ValidatedWorkspace,
    correlationAncestorThreadIds: readonly string[],
    applicationThreadId: string,
    deferProjection = false,
    confirmedHistoryMode?: "legacy",
  ): Promise<CodexThread> {
    try {
      if (confirmedHistoryMode === undefined) {
        const metadata = await this.#client.request(
          codexThreadReadMethod,
          { threadId, includeTurns: false },
          { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS },
        );
        assertThreadBinding(metadata.thread, threadId, workspace.canonicalPath);
        if (metadata.thread.historyMode !== "legacy") {
          throw codexError(
            "incompatible_protocol",
            "This Codex operation requires mode-specific paginated reconciliation.",
            "codex_paginated_operation_reconciliation_pending",
          );
        }
      }
      const response = await this.#client.request(
        codexThreadReadMethod,
        { threadId, includeTurns: true },
        { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS },
      );
      assertThreadBinding(response.thread, threadId, workspace.canonicalPath);
      if (response.thread.historyMode !== "legacy") {
        throw codexError(
          "incompatible_protocol",
          "Codex changed history mode during a complete legacy read.",
          "codex_history_mode_changed",
        );
      }
      if (!deferProjection) {
        await this.#projectThreadHistory(
          response.thread,
          correlationAncestorThreadIds,
          applicationThreadId,
        );
      }
      return response.thread;
    } catch (error) {
      throw mapCodexReadError(error);
    }
  }

  async #readNativeForkEvidence(
    listedChild: CodexThread,
    workspace: ValidatedWorkspace,
    expectedGeneration: number,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly correlationAncestorThreadIds: readonly string[];
        readonly evidence?: {
          readonly applicationOperationId: string;
          readonly nativeSourceTurnId?: string;
          readonly sourceBackendTurnId?: string;
        };
      }
    | undefined
  > {
    throwIfDiscoveryAborted(signal);
    if (!listedChild.forkedFromId) return undefined;
    const inspection = inspectCodexForkCreationMarker(
      listedChild.threadSource,
      this.#correlationScope(listedChild.forkedFromId),
    );
    if (inspection.type !== "authenticated") return undefined;
    try {
      const [childMetadata, parentMetadata] = await Promise.all([
        this.#client.requestWithReceipt(
          codexThreadReadMethod,
          { threadId: listedChild.id, includeTurns: false },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS, signal },
        ),
        this.#client.requestWithReceipt(
          codexThreadReadMethod,
          { threadId: listedChild.forkedFromId, includeTurns: false },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS, signal },
        ),
      ]);
      throwIfDiscoveryAborted(signal);
      this.#assertDiscoveryGeneration(
        expectedGeneration,
        childMetadata.generation,
      );
      this.#assertDiscoveryGeneration(
        expectedGeneration,
        parentMetadata.generation,
      );
      assertThreadBinding(
        childMetadata.result.thread,
        listedChild.id,
        workspace.canonicalPath,
      );
      assertThreadBinding(
        parentMetadata.result.thread,
        listedChild.forkedFromId,
        workspace.canonicalPath,
      );
      if (
        childMetadata.generation !== parentMetadata.generation ||
        childMetadata.result.thread.historyMode !==
          parentMetadata.result.thread.historyMode
      ) {
        throw codexError(
          "incompatible_protocol",
          "Codex fork evidence changed mode or generation during acquisition.",
          "codex_history_mode_changed",
        );
      }
      const childShell = childMetadata.result.thread;
      const parentShell = parentMetadata.result.thread;
      if (
        childShell.forkedFromId !== parentShell.id ||
        childShell.threadSource !== listedChild.threadSource
      ) {
        return undefined;
      }
      const correlationAncestorThreadIds = [parentShell.id];
      const seenAncestorIds = new Set([childShell.id, parentShell.id]);
      let nextAncestorId = parentShell.forkedFromId;
      while (nextAncestorId) {
        throwIfDiscoveryAborted(signal);
        if (
          correlationAncestorThreadIds.length >= 100 ||
          seenAncestorIds.has(nextAncestorId)
        ) {
          throw codexError(
            "incompatible_protocol",
            "Codex returned an invalid native fork ancestry chain.",
            "codex_fork_ancestry_invalid",
          );
        }
        const ancestorResponse = await this.#client.requestWithReceipt(
          codexThreadReadMethod,
          { threadId: nextAncestorId, includeTurns: false },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS, signal },
        );
        throwIfDiscoveryAborted(signal);
        this.#assertDiscoveryGeneration(
          expectedGeneration,
          ancestorResponse.generation,
        );
        const ancestor = ancestorResponse.result.thread;
        assertThreadBinding(ancestor, nextAncestorId, workspace.canonicalPath);
        correlationAncestorThreadIds.unshift(ancestor.id);
        seenAncestorIds.add(ancestor.id);
        nextAncestorId = ancestor.forkedFromId;
      }
      if (childShell.historyMode === "paginated") {
        const childAdapter = new CodexPaginatedHistoryAdapter({
          client: this.#client,
          thread: childShell,
          generation: expectedGeneration,
          correlationScope: this.#correlationScope(
            childShell.id,
            correlationAncestorThreadIds,
          ),
        });
        const parentAdapter = new CodexPaginatedHistoryAdapter({
          client: this.#client,
          thread: parentShell,
          generation: expectedGeneration,
          correlationScope: this.#correlationScope(
            parentShell.id,
            correlationAncestorThreadIds.slice(0, -1),
          ),
        });
        const childSourceTurn = (
          await childAdapter.findCompletedTurn(undefined, signal)
        )?.turn;
        const parentSourceTurn = childSourceTurn
          ? (
              await parentAdapter.findCompletedTurn(
                codexBackendTurnId(parentShell.id, childSourceTurn.id),
                signal,
              )
            )?.turn
          : undefined;
        const sourceTurnEvidence =
          childSourceTurn &&
          parentSourceTurn &&
          codexTurnPrefixDigest([childSourceTurn]) ===
            codexTurnPrefixDigest([parentSourceTurn])
            ? {
                nativeSourceTurnId: parentSourceTurn.id,
                sourceBackendTurnId: codexBackendTurnId(
                  parentShell.id,
                  parentSourceTurn.id,
                ),
              }
            : {};
        return {
          correlationAncestorThreadIds,
          evidence: {
            applicationOperationId: inspection.applicationOperationId,
            ...sourceTurnEvidence,
          },
        };
      }
      if (childShell.historyMode !== "legacy") {
        throw codexError(
          "incompatible_protocol",
          "Codex returned an unsupported history mode.",
          "codex_history_mode_invalid",
        );
      }
      const [childResponse, parentResponse] = await Promise.all([
        this.#client.requestWithReceipt(
          codexThreadReadMethod,
          { threadId: listedChild.id, includeTurns: true },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS, signal },
        ),
        this.#client.requestWithReceipt(
          codexThreadReadMethod,
          { threadId: listedChild.forkedFromId, includeTurns: true },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS, signal },
        ),
      ]);
      throwIfDiscoveryAborted(signal);
      this.#assertDiscoveryGeneration(
        expectedGeneration,
        childResponse.generation,
      );
      this.#assertDiscoveryGeneration(
        expectedGeneration,
        parentResponse.generation,
      );
      const child = childResponse.result.thread;
      const parent = parentResponse.result.thread;
      assertThreadBinding(child, listedChild.id, workspace.canonicalPath);
      assertThreadBinding(
        parent,
        listedChild.forkedFromId,
        workspace.canonicalPath,
      );
      if (child.historyMode !== "legacy" || parent.historyMode !== "legacy") {
        throw codexError(
          "incompatible_protocol",
          "Codex changed history mode during fork evidence acquisition.",
          "codex_history_mode_changed",
        );
      }
      if (
        child.forkedFromId !== parent.id ||
        child.threadSource !== listedChild.threadSource
      ) {
        return undefined;
      }
      let childBoundaryTurnIds: ReadonlySet<string> | undefined;
      let parentBoundaryTurnIds: ReadonlySet<string> | undefined;
      try {
        const childBoundaryInspection = inspectCodexForkContextBoundaries(
          child,
          this.#correlationScope(child.id, correlationAncestorThreadIds),
        );
        const parentBoundaryInspection = inspectCodexForkContextBoundaries(
          parent,
          this.#correlationScope(
            parent.id,
            correlationAncestorThreadIds.slice(0, -1),
          ),
        );
        childBoundaryTurnIds = childBoundaryInspection.nativeTurnIds;
        parentBoundaryTurnIds = parentBoundaryInspection.nativeTurnIds;
      } catch (error) {
        if (!(error instanceof CodexHistoryProjectionError)) throw error;
        // Historical boundary evidence is read-only. Isolate malformed or
        // forged evidence to this child and omit exact source-turn recovery.
      }
      let sharedPrefixLength = 0;
      const sharedLength = Math.min(child.turns.length, parent.turns.length);
      for (
        let index = 0;
        childBoundaryTurnIds && parentBoundaryTurnIds && index < sharedLength;
        index += 1
      ) {
        const childTurn = child.turns[index]!;
        const parentTurn = parent.turns[index]!;
        if (
          !codexCopiedForkTurnMatches(
            parentTurn,
            childTurn,
            parentBoundaryTurnIds,
            childBoundaryTurnIds,
          )
        ) {
          break;
        }
        sharedPrefixLength = index + 1;
      }
      let sourceTurnIndex = sharedPrefixLength - 1;
      while (
        sourceTurnIndex >= 0 &&
        parentBoundaryTurnIds?.has(parent.turns[sourceTurnIndex]!.id) &&
        childBoundaryTurnIds?.has(child.turns[sourceTurnIndex]!.id)
      ) {
        sourceTurnIndex -= 1;
      }
      const childSourceTurn = child.turns[sourceTurnIndex];
      const parentSourceTurn = parent.turns[sourceTurnIndex];
      const sourceTurnEvidence =
        childSourceTurn &&
        parentSourceTurn &&
        childSourceTurn.status === "completed" &&
        parentSourceTurn.status === "completed" &&
        childSourceTurn.itemsView === "full" &&
        parentSourceTurn.itemsView === "full"
          ? {
              nativeSourceTurnId: parentSourceTurn.id,
              sourceBackendTurnId: codexBackendTurnId(
                parent.id,
                parentSourceTurn.id,
              ),
            }
          : {};
      return {
        correlationAncestorThreadIds,
        evidence: {
          applicationOperationId: inspection.applicationOperationId,
          ...sourceTurnEvidence,
        },
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const mapped = mapCodexReadError(error);
      if (
        mapped.category === "not_found" ||
        mapped.category === "permission_denied"
      ) {
        return undefined;
      }
      throw mapped;
    }
  }

  #assertDiscoveryGeneration(expected: number, received: number): void {
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      received !== expected ||
      lifecycle.state !== "ready" ||
      lifecycle.generation !== expected
    ) {
      throw codexError(
        "unavailable",
        "The Codex daemon generation changed during discovery.",
        "codex_generation_changed",
        true,
      );
    }
  }

  async #projectThreadHistory(
    thread: CodexThread,
    correlationAncestorThreadIds: readonly string[],
    applicationThreadId: string,
    visibleLimit?: number,
    expectedHistoryMode: "legacy" | "paginated" = "legacy",
  ) {
    if (thread.historyMode !== expectedHistoryMode) {
      throw codexError(
        "incompatible_protocol",
        "Codex changed history mode during the read.",
        "codex_history_mode_changed",
      );
    }
    const context = {
      scope: {
        tenantId: this.connection.tenantId,
        principalId: this.connection.ownerPrincipalId,
      },
      applicationThreadId,
      outputArtifacts: this.#outputArtifacts,
      verifiedPublicationKeys: new Set<string>(),
    } as const;
    const normalized = normalizeCodexTurnStatuses(thread);
    const scope = this.#correlationScope(
      thread.id,
      correlationAncestorThreadIds,
    );
    let candidateLimit = visibleLimit;
    for (;;) {
      try {
        const candidate =
          candidateLimit === undefined
            ? normalized
            : selectCodexNativeHistorySlice(
                normalized,
                scope,
                normalized.turns.length,
                candidateLimit,
              ).thread;
        const projection = projectCodexThreadHistory(
          candidate,
          scope,
          new Map(),
          context,
        );
        const materialized = await materializeCodexGeneratedImagePublications(
          projection,
          context,
        );
        if (
          verifiedCodexProjectionBytes(materialized) >
          MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES
        ) {
          throw codexError(
            "unavailable",
            "This Codex thread is too large to display safely.",
            "history_too_large",
          );
        }
        return materialized;
      } catch (error) {
        const mapped = mapCodexHistoryProjectionError(error);
        if (
          candidateLimit === undefined ||
          !(mapped instanceof BackendError) ||
          mapped.backendCode !== "history_too_large" ||
          candidateLimit === 1
        ) {
          throw mapped;
        }
        candidateLimit = Math.max(1, Math.floor(candidateLimit / 2));
      }
    }
  }

  #correlationScope(
    nativeThreadId: string,
    correlationAncestorThreadIds: readonly string[] = [],
  ): CodexSubmissionCorrelationScope {
    return {
      toolProvenanceKey: this.#toolProvenanceKey,
      tenantId: this.connection.tenantId,
      principalId: this.connection.ownerPrincipalId,
      backendInstanceId: this.instance.id,
      nativeThreadId,
      correlationAncestorThreadIds,
    };
  }

  async #assertExecutionSettingsAvailable(
    scope: CreateConversationInput["scope"],
    workspace: ValidatedWorkspace,
    settings: CodexExecutionSettingsTuple,
    fastModeApplicationThreadId?: string,
  ): Promise<readonly ("text" | "image")[]> {
    if (
      settings.model.trim().length === 0 ||
      settings.reasoningEffort.trim().length === 0 ||
      !this.#modelPolicy.isSelectionAllowed({
        modelId: settings.model,
        reasoningEffort: settings.reasoningEffort,
      })
    ) {
      throw codexError(
        "rejected",
        "The selected Codex execution settings are no longer allowed.",
        "codex_execution_settings_policy_rejected",
      );
    }
    const models = await this.#modelCatalogFresh({ scope, workspace });
    const model = models.find(
      (candidate) =>
        candidate.provider === this.connection.id &&
        candidate.id === settings.model,
    );
    const fastModeProjection = fastModeApplicationThreadId
      ? this.#fastModeSessions.projection(scope, fastModeApplicationThreadId)
      : undefined;
    if (
      !model ||
      !model.supportedReasoningEfforts?.includes(settings.reasoningEffort) ||
      (settings.serviceTier === "fast" &&
        (!model.fastMode ||
          (fastModeApplicationThreadId !== undefined &&
            (fastModeProjection?.availability !== "available" ||
              fastModeProjection.enabled !== true))))
    ) {
      throw codexError(
        "rejected",
        "The selected Codex model, reasoning effort, or service tier is no longer available.",
        "codex_execution_settings_catalog_rejected",
      );
    }
    return model.inputModalities;
  }

  #assertModelPolicyAllowed(model: string, reasoningEffort: string): void {
    if (
      !this.#modelPolicy.isSelectionAllowed({ modelId: model, reasoningEffort })
    ) {
      throw codexError(
        "rejected",
        "This model or reasoning effort is not allowed by the backend policy.",
        "model_policy_rejected",
      );
    }
  }

  async #threadConfig(
    applicationThreadId: string,
    config: Readonly<
      Record<string, import("./codex-c2-protocol.js").CodexJsonValue>
    >,
    resolution: CodexAgentToolCliEnvironmentResolution,
  ): Promise<Readonly<Record<string, import("./codex-c2-protocol.js").CodexJsonValue>>> {
    const executionEnvironment = await this.#resolveThreadEnvironment(applicationThreadId);
    return withCodexAgentToolCliEnvironment(withCodexExecutionEnvironment(config, executionEnvironment), {
      executionEnvironment,
      resolution,
      applicationThreadId,
    });
  }

  async #acquireAgentToolCliEnvironment(
    scope: CreateConversationInput["scope"],
    applicationThreadId: string,
    signal?: AbortSignal,
  ): Promise<CodexAgentToolCliEnvironmentResolution> {
    try {
      return await this.#agentToolCliEnvironment.acquire(
        scope,
        applicationThreadId,
        signal ? { signal } : undefined,
      );
    } catch (error) {
      this.#reportError(error);
      return Object.freeze({
        availability: "unavailable",
        reason: "sidecar_unavailable",
      });
    }
  }

  #nowMilliseconds(): number {
    const value = Date.parse(this.#now());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("codex_driver_clock_invalid");
    }
    return value;
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Diagnostics observers never replace the authoritative provider result.
    }
  }

  #assertAttach(input: AttachConversationInput | ReadConversationInput): void {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    let detail;
    try {
      detail = parseCodexBindingDetail(input.opaqueBindingDetail);
    } catch {
      throw bindingMismatch();
    }
    if (
      input.binding.tenantId !== this.connection.tenantId ||
      input.binding.ownerPrincipalId !== this.connection.ownerPrincipalId ||
      input.binding.backendInstanceId !== this.instance.id ||
      input.binding.connectionProfileId !== this.connection.id ||
      input.binding.executionEnvironmentId !==
        this.connection.executionEnvironmentId ||
      detail.threadId !== input.binding.backendConversationId
    ) {
      throw bindingMismatch();
    }
  }

  #assertScope(scope: {
    readonly tenantId: string;
    readonly principalId: string;
  }): void {
    if (
      scope.tenantId !== this.connection.tenantId ||
      scope.principalId !== this.connection.ownerPrincipalId
    ) {
      throw bindingMismatch();
    }
  }

  #assertSourceBinding(
    binding: BranchConversationInput["sourceBinding"],
    workspace: ValidatedWorkspace,
  ): void {
    if (
      binding.tenantId !== this.connection.tenantId ||
      binding.ownerPrincipalId !== this.connection.ownerPrincipalId ||
      binding.backendInstanceId !== this.instance.id ||
      binding.connectionProfileId !== this.connection.id ||
      binding.executionEnvironmentId !==
        this.connection.executionEnvironmentId ||
      workspace.summary.environmentId !== binding.executionEnvironmentId
    ) {
      throw bindingMismatch();
    }
  }

  #assertWorkspace(workspace: ValidatedWorkspace): void {
    if (
      workspace.summary.environmentId !==
        this.connection.executionEnvironmentId ||
      !isAbsoluteWorkspacePath(workspace.canonicalPath)
    ) {
      throw bindingMismatch();
    }
  }
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return posixPath.isAbsolute(value) || windowsPath.isAbsolute(value);
}

function releaseAgentToolCliEnvironment(
  resolution: CodexAgentToolCliEnvironmentResolution,
): void {
  if (resolution.availability === "available") resolution.release();
}

function codexRpcErrorGeneration(error: unknown): number | undefined {
  return error instanceof CodexRpcDeliveryError ||
    error instanceof CodexRpcRemoteError ||
    error instanceof CodexRpcProtocolError
    ? error.generation
    : undefined;
}

function threadTitle(thread: CodexThread): string | undefined {
  return (
    normalizedThreadTitle(thread.name) ?? normalizedThreadTitle(thread.preview)
  );
}

function normalizedThreadTitle(value: string | null): string | undefined {
  const normalized = value?.replace(/[\r\n]+/gu, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= 240) return normalized;
  let bounded = normalized.slice(0, 240);
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    bounded = bounded.slice(0, -1);
  }
  return bounded.trimEnd() || undefined;
}

function epochSecondsToIso(value: number): string {
  const milliseconds = value * 1_000;
  const date = new Date(milliseconds);
  if (!Number.isSafeInteger(value) || !Number.isFinite(date.getTime())) {
    throw codexError(
      "incompatible_protocol",
      "Codex returned an invalid thread timestamp.",
      "codex_thread_timestamp_invalid",
    );
  }
  return date.toISOString();
}

function assertThreadBinding(
  thread: CodexThread,
  threadId: string,
  canonicalWorkspacePath: string,
): void {
  if (
    thread.id !== threadId ||
    !isCodexDiscoverableThread(thread, canonicalWorkspacePath)
  ) {
    throw bindingMismatch();
  }
}

type DiscoveryCursor = {
  readonly fingerprint: string;
  readonly generation: number;
  readonly providerCursor: string;
};

function discoveryFingerprint(
  backendInstanceId: string,
  connectionProfileId: string,
  canonicalWorkspacePath: string,
): string {
  return createHash("sha256")
    .update("sedes.codex-discovery.v1\0")
    .update(backendInstanceId)
    .update("\0")
    .update(connectionProfileId)
    .update("\0")
    .update(canonicalWorkspacePath)
    .digest("base64url");
}

function serializeDiscoveryCursor(cursor: DiscoveryCursor): string {
  const encoded = Buffer.from(
    JSON.stringify({
      version: 1,
      fingerprint: cursor.fingerprint,
      generation: cursor.generation,
      providerCursor: cursor.providerCursor,
    }),
    "utf8",
  ).toString("base64url");
  const serialized = `codex-discovery:${encoded}`;
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_CURSOR_BYTES) {
    throw codexError(
      "incompatible_protocol",
      "Codex returned an oversized discovery cursor.",
      "codex_discovery_cursor_oversized",
    );
  }
  return serialized;
}

function parseDiscoveryCursor(
  value: string,
  fingerprint: string,
  generation: number,
): string {
  if (
    !value.startsWith("codex-discovery:") ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_CURSOR_BYTES
  ) {
    throw invalidDiscoveryCursor();
  }
  const encoded = value.slice("codex-discovery:".length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw invalidDiscoveryCursor();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw invalidDiscoveryCursor();
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Object.keys(decoded).some(
      (key) =>
        key !== "version" &&
        key !== "fingerprint" &&
        key !== "generation" &&
        key !== "providerCursor",
    ) ||
    !("version" in decoded) ||
    decoded.version !== 1 ||
    !("fingerprint" in decoded) ||
    decoded.fingerprint !== fingerprint ||
    !("generation" in decoded) ||
    decoded.generation !== generation ||
    !("providerCursor" in decoded) ||
    typeof decoded.providerCursor !== "string" ||
    decoded.providerCursor.length === 0
  ) {
    throw invalidDiscoveryCursor();
  }
  return decoded.providerCursor;
}

function invalidDiscoveryCursor(): BackendError {
  return codexError(
    "rejected",
    "The Codex discovery cursor is invalid or stale.",
    "codex_discovery_cursor_invalid",
  );
}

function invalidModelCatalog(code: string): BackendError {
  return codexError(
    "incompatible_protocol",
    "Codex returned an invalid or oversized model catalog.",
    code,
  );
}

function mapCodexReadError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof CodexRpcDeliveryError) {
    return codexError(
      "unavailable",
      "The Codex daemon is unavailable.",
      error.message,
      true,
      error,
    );
  }
  if (error instanceof CodexRpcRemoteError) {
    if (error.code === -32001) {
      return codexError(
        "overloaded",
        "The Codex daemon is overloaded.",
        "codex_remote_overloaded",
        true,
        error,
      );
    }
    if (error.code === -32601 || error.code === -32602) {
      return codexError(
        "incompatible_protocol",
        "The Codex daemon rejected a required released operation.",
        `codex_remote_${error.code}`,
        false,
        error,
      );
    }
    return codexError(
      "unavailable",
      "Codex could not read the thread.",
      `codex_remote_${error.code}`,
      false,
      error,
    );
  }
  if (error instanceof CodexRpcProtocolError) {
    return codexError(
      "incompatible_protocol",
      "Codex returned an invalid protocol response.",
      error.message,
      false,
      error,
    );
  }
  if (
    (error instanceof CodexAppServerBindingError &&
      error.direction === "client_request_result") ||
    (error instanceof Error && error.name === "ZodError")
  ) {
    return codexError(
      "incompatible_protocol",
      "Codex returned an invalid protocol response.",
      "codex_c1_protocol_invalid",
      false,
      error,
    );
  }
  return codexError(
    "internal",
    "Codex could not complete the read safely.",
    "codex_read_internal",
    false,
    error,
  );
}

function daemonUnavailable(): BackendError {
  return codexError(
    "unavailable",
    "The Codex daemon is unavailable.",
    "codex_daemon_not_ready",
    true,
  );
}

function throwIfDiscoveryAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

async function withCodexDiscoveryDeadline<Result>(
  callerSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const deadlineController = new AbortController();
  const deadline = setTimeout(
    () => deadlineController.abort(new Error("codex_discovery_deadline")),
    REQUEST_TIMEOUT_MILLISECONDS,
  );
  const signal = AbortSignal.any([callerSignal, deadlineController.signal]);
  let rejectAborted!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abort = () => rejectAborted(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([operation(signal), aborted]);
  } catch (error) {
    if (deadlineController.signal.aborted && !callerSignal.aborted) {
      throw codexError(
        "unavailable",
        "Codex fork discovery did not complete within the request deadline.",
        "codex_discovery_deadline",
        true,
        error,
      );
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    clearTimeout(deadline);
  }
}

function bindingMismatch(): BackendError {
  return codexError(
    "permission_denied",
    "The Codex thread does not match this configured target.",
    "codex_thread_binding_mismatch",
  );
}

function unresolvedSubmission(diagnostic: string): SubmissionReconciliation {
  return {
    status: "unresolved",
    diagnostic: boundDisplayText(diagnostic),
  };
}

function codexTurnPrefixDigest(
  turns: readonly CodexThread["turns"][number][],
): string {
  return createHash("sha256").update(JSON.stringify(turns)).digest("hex");
}

function codexCopiedForkTurnMatches(
  sourceTurn: CodexThread["turns"][number],
  childTurn: CodexThread["turns"][number],
  authenticatedSourceBoundaryTurnIds: ReadonlySet<string>,
  authenticatedChildBoundaryTurnIds: ReadonlySet<string>,
): boolean {
  if (sourceTurn.id === childTurn.id) {
    return (
      codexTurnPrefixDigest([sourceTurn]) === codexTurnPrefixDigest([childTurn])
    );
  }
  if (
    !authenticatedSourceBoundaryTurnIds.has(sourceTurn.id) ||
    !authenticatedChildBoundaryTurnIds.has(childTurn.id)
  ) {
    return false;
  }
  // Codex may renumber the native wrapper around a copied hidden boundary.
  // Authentication gates this one remap; every other serialized field stays
  // part of the exact fidelity digest.
  return (
    codexTurnPrefixDigest([{ ...sourceTurn, id: "authenticated-boundary" }]) ===
    codexTurnPrefixDigest([{ ...childTurn, id: "authenticated-boundary" }])
  );
}

function codexForkSandboxMatches(
  sandbox: unknown,
  settings: CodexExecutionSettingsTuple,
): boolean {
  if (
    typeof sandbox !== "object" ||
    sandbox === null ||
    Array.isArray(sandbox) ||
    !("type" in sandbox) ||
    typeof sandbox.type !== "string"
  ) {
    return false;
  }
  if (settings.sandboxMode === "danger-full-access") {
    return sandbox.type === "dangerFullAccess";
  }
  const expectedType =
    settings.sandboxMode === "read-only" ? "readOnly" : "workspaceWrite";
  return sandbox.type === expectedType;
}

function serializeCodexBranchCheckpoint(
  value: z.infer<typeof codexBranchCheckpointSchema>,
): string {
  const encoded = Buffer.from(
    JSON.stringify(codexBranchCheckpointSchema.parse(value)),
    "utf8",
  ).toString("base64url");
  const serialized = `${CODEX_BRANCH_CHECKPOINT_PREFIX}${encoded}`;
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_CURSOR_BYTES) {
    throw codexError(
      "internal",
      "The Codex fork checkpoint exceeded its bounded representation.",
      "codex_fork_checkpoint_oversized",
    );
  }
  return serialized;
}

function parseCodexBranchCheckpoint(
  value: string,
): z.infer<typeof codexBranchCheckpointSchema> {
  if (
    !value.startsWith(CODEX_BRANCH_CHECKPOINT_PREFIX) ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_CURSOR_BYTES
  ) {
    throw invalidCodexBranchCheckpoint();
  }
  try {
    const encoded = value.slice(CODEX_BRANCH_CHECKPOINT_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
      throw new Error("invalid");
    }
    return codexBranchCheckpointSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    throw invalidCodexBranchCheckpoint();
  }
}

function invalidCodexBranchCheckpoint(): BackendError {
  return codexError(
    "rejected",
    "The Codex fork checkpoint is invalid.",
    "codex_fork_checkpoint_invalid",
  );
}

function mapCodexForkError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof CodexAppServerBindingError) {
    if (
      error.method === "thread/fork" &&
      error.direction === "client_request_params"
    ) {
      return codexError(
        "rejected",
        "The Codex fork input is invalid.",
        "codex_fork_input_invalid",
        false,
        error,
        false,
      );
    }
    if (
      error.method === "thread/fork" &&
      error.direction === "client_request_result"
    ) {
      return codexError(
        "submission_unknown",
        "Codex returned an invalid fork response; a full native copy may exist.",
        "codex_fork_response_invalid",
        false,
        error,
        true,
      );
    }
    return codexError(
      "internal",
      "Codex could not complete the fork safely.",
      "codex_fork_internal",
      false,
      error,
      false,
    );
  }
  if (error instanceof CodexRpcDeliveryError) {
    if (error.delivery === "sent_outcome_unknown") {
      return codexError(
        "submission_unknown",
        "The Codex fork outcome is unknown; a full native copy may exist.",
        error.message,
        false,
        error,
        true,
      );
    }
    return codexError(
      "unavailable",
      "The Codex daemon was unavailable before the fork was sent.",
      error.message,
      true,
      error,
      false,
    );
  }
  if (error instanceof CodexRpcRemoteError) {
    if (error.code === -32001) {
      return codexError(
        "overloaded",
        "The Codex daemon is overloaded.",
        `codex_remote_${error.code}`,
        true,
        error,
        false,
      );
    }
    if (
      error.code === -32600 ||
      error.code === -32601 ||
      error.code === -32602
    ) {
      return codexError(
        "rejected",
        "Codex rejected the selected fork request before execution.",
        `codex_remote_${error.code}`,
        false,
        error,
        false,
      );
    }
    return codexError(
      "submission_unknown",
      "Codex reported an internal fork failure; a full native copy may exist.",
      `codex_remote_${error.code}`,
      false,
      error,
      true,
    );
  }
  if (error instanceof CodexRpcProtocolError) {
    return codexError(
      "submission_unknown",
      "Codex returned an invalid fork response; a full native copy may exist.",
      "codex_fork_response_invalid",
      false,
      error,
      true,
    );
  }
  if (error instanceof Error && error.name === "ZodError") {
    return codexError(
      "submission_unknown",
      "Codex returned an invalid fork response; a full native copy may exist.",
      "codex_fork_response_invalid",
      false,
      error,
      true,
    );
  }
  return codexError(
    "submission_unknown",
    "The Codex fork could not be confirmed; a full native copy may exist.",
    "codex_fork_internal_unknown",
    false,
    error,
    true,
  );
}

function mapCodexCreateError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof CodexAppServerBindingError) {
    if (
      error.method === "thread/start" &&
      error.direction === "client_request_params"
    ) {
      return codexError(
        "rejected",
        "The Codex create input is invalid.",
        "codex_create_input_invalid",
        false,
        error,
        false,
      );
    }
    if (
      error.method === "thread/start" &&
      error.direction === "client_request_result"
    ) {
      return codexError(
        "submission_unknown",
        "Codex returned an invalid create response; its outcome is unknown.",
        "codex_create_response_invalid",
        false,
        error,
        true,
      );
    }
    return codexError(
      "internal",
      "Codex could not complete thread creation safely.",
      "codex_create_internal",
      false,
      error,
      false,
    );
  }
  if (error instanceof CodexRpcDeliveryError) {
    if (error.delivery === "sent_outcome_unknown") {
      return codexError(
        "submission_unknown",
        "Codex thread creation was sent but its outcome is unknown.",
        error.message,
        false,
        error,
        true,
      );
    }
    return codexError(
      "unavailable",
      "The Codex daemon was unavailable before thread creation was sent.",
      error.message,
      true,
      error,
      false,
    );
  }
  if (error instanceof CodexRpcRemoteError) {
    return codexError(
      error.code === -32001 ? "overloaded" : "rejected",
      error.code === -32001
        ? "The Codex daemon is overloaded."
        : "Codex rejected thread creation.",
      `codex_remote_${error.code}`,
      error.code === -32001,
      error,
      false,
    );
  }
  if (error instanceof CodexRpcProtocolError) {
    return codexError(
      "submission_unknown",
      "Codex returned an invalid create response; its outcome is unknown.",
      "codex_create_response_invalid",
      false,
      error,
      true,
    );
  }
  if (error instanceof Error && error.name === "ZodError") {
    return codexError(
      "rejected",
      "The Codex create input is invalid.",
      "codex_create_input_invalid",
      false,
      error,
      false,
    );
  }
  return codexError(
    "internal",
    "Codex could not complete thread creation safely.",
    "codex_create_internal",
    false,
    error,
    false,
  );
}

function token(
  kind: string,
  applicationOperationId: string,
  backendConversationId: string,
  correlation: string,
): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(applicationOperationId)
    .update("\0")
    .update(backendConversationId)
    .update("\0")
    .update(correlation)
    .digest("hex");
}

function codexError(
  category: BackendError["category"],
  safeMessage: string,
  backendCode: string,
  retryable = false,
  cause?: unknown,
  crossedSubmissionBoundary = false,
): BackendError {
  return new BackendError(
    {
      category,
      retryable,
      crossedSubmissionBoundary,
      safeMessage,
      backendCode,
    },
    cause === undefined ? undefined : { cause },
  );
}
