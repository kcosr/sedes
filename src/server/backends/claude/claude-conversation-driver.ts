import type { UsageSink } from "../../usage/contracts.js";
import type { ThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import { normalizedAbsolutePath } from "../../../shared/absolute-path.js";
import { createHash } from "node:crypto";
import type {
  EffortLevel,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import type { ValidatedWorkspace } from "../../execution/contracts.js";
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
import {
  parseClaudeBindingDetail,
  serializeClaudeBindingDetail,
} from "./claude-binding-codec.js";
import { captureClaudeChildEnvironment } from "./claude-child-environment.js";
import {
  copyClaudeForkBoundaryKey,
  type ClaudeForkBoundaryAuthentication,
} from "./claude-fork-context-boundary.js";
import { ClaudeConversationHandle } from "./claude-conversation-handle.js";
import {
  assertClaudeHistorySession,
  ClaudeHistoryProjectionError,
  projectClaudeHistory,
  type ClaudeHistoryAuthentication,
  type ClaudeHistoryProjection,
} from "./claude-history-projector.js";
import type {
  ClaudeRuntimeClient,
  ClaudeRuntimeSession,
} from "./claude-runtime-client.js";
import type { ClaudeThreadRepository } from "./claude-thread-repository.js";
import type { AgentToolCliAvailability } from "../module.js";
import type { AgentToolSourceCapabilityIssuer } from "../../agent-tools/application/database-agent-tool-source-authority.js";
import type { BackendAgentToolFacade } from "../../agent-tools/adapters/backend-facade.js";
import {
  claudePermissionPolicyAllowsBypass,
  isClaudePermissionMode,
  isClaudePermissionModeAllowed,
  type ClaudePermissionMode,
  type ClaudePermissionPolicy,
} from "./claude-permission-policy.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import {
  claudeSkillComposerCommands,
  resolveClaudeSafeSkills,
} from "./claude-skills.js";
import type {
  ClaudeRuntimeVersionObservation,
  ClaudeRuntimeVersionObservationSource,
} from "./claude-runtime-installation-advisories.js";

const MAXIMUM_DISCOVERY_PAGE = 100;
const MAXIMUM_DISCOVERY_OFFSET = 10_000;
const MAXIMUM_CURSOR_BYTES = 2_048;
const MAXIMUM_RETRY_ANCHOR_BYTES = 4_096;
const MAXIMUM_BRANCH_CHECKPOINT_BYTES = 4_096;
const uuidSchema = z.string().uuid();
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const discoveryCursorSchema = z
  .object({
    version: z.literal(1),
    workspaceDigest: z.string().length(43),
    offset: z.number().int().positive().max(MAXIMUM_DISCOVERY_OFFSET),
    prefixDigest: z.string().length(43),
  })
  .strict();
const retryAnchorSchema = z
  .object({
    version: z.literal(1),
    messageCount: z.number().int().nonnegative(),
    lastMessageUuid: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[^\u0000-\u001f\u007f]+$/u)
      .nullable(),
    transcriptFingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.messageCount === 0 && value.lastMessageUuid !== null) ||
      (value.messageCount > 0 && value.lastMessageUuid === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Claude retry anchor count and leaf identity disagree.",
      });
    }
  });
const branchCheckpointSchema = z
  .object({
    version: z.literal(1),
    sourceSessionId: z.string().uuid(),
    backendTurnId: z.string().min(1).max(512),
    retainedLeafUuid: z.string().uuid(),
    retainedPrefixCount: z.number().int().positive(),
    retainedPrefixDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    retainedContentDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict();

export interface ClaudeConversationDriverInput {
  readonly usage: UsageSink;
  readonly nativeNamespace: string;
  readonly resolveThreadEnvironment?: ThreadEnvironmentResolver;
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly runtimeClient: ClaudeRuntimeClient;
  readonly executablePath: string;
  readonly initializationTimeoutMs: number;
  readonly probeDirectory: string;
  readonly settings: ClaudeThreadRepository;
  readonly permissionPolicy: ClaudePermissionPolicy;
  readonly modelPolicy: CompiledBackendModelPolicy;
  readonly attachmentProvenanceKey: Uint8Array;
  readonly agentToolCli?: AgentToolCliAvailability;
  readonly agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly agentTools: BackendAgentToolFacade;
  readonly toolProvenanceKey: Uint8Array;
  readonly childEnvironment: Readonly<Record<string, string | undefined>>;
  readonly beginVersionObservation?: (
    source: ClaudeRuntimeVersionObservationSource,
  ) => ClaudeRuntimeVersionObservation;
  /** Runtime-wide admission is shared by every profile for one backend. */
  readonly acquireSession?: (sessionId: string) => () => void;
  readonly now?: () => string;
}

/** Local, subscription-backed Claude Code conversation driver. */
export class ClaudeConversationBackendDriver implements ConversationBackendDriver {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly #usage: UsageSink;
  readonly #nativeNamespace: string;
  readonly #resolveThreadEnvironment: ThreadEnvironmentResolver;
  readonly #runtimeClient: ClaudeRuntimeClient;
  readonly #executablePath: string;
  readonly #initializationTimeoutMs: number;
  readonly #probeDirectory: string;
  readonly #settings: ClaudeThreadRepository;
  readonly #permissionPolicy: ClaudePermissionPolicy;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #attachmentProvenanceKey: Uint8Array;
  readonly #agentToolCli: AgentToolCliAvailability;
  readonly #agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly #agentTools: BackendAgentToolFacade;
  readonly #childEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #forkBoundaryAuthentication: ClaudeForkBoundaryAuthentication;
  readonly #acquireSession: (sessionId: string) => () => void;
  readonly #now: () => string;
  readonly #beginVersionObservation:
    | ((
        source: ClaudeRuntimeVersionObservationSource,
      ) => ClaudeRuntimeVersionObservation)
    | undefined;
  readonly #handles = new Set<ClaudeConversationHandle>();
  #nextQueryGeneration = 0;

  constructor(input: ClaudeConversationDriverInput) {
    this.#usage = input.usage;
    this.#nativeNamespace = input.nativeNamespace;
    this.#resolveThreadEnvironment = input.resolveThreadEnvironment ?? (async () => Object.freeze({}));
    this.instance = input.instance;
    this.connection = input.connection;
    this.#runtimeClient = input.runtimeClient;
    this.#executablePath = input.executablePath;
    this.#initializationTimeoutMs = input.initializationTimeoutMs;
    this.#probeDirectory = input.probeDirectory;
    this.#settings = input.settings;
    this.#permissionPolicy = input.permissionPolicy;
    this.#modelPolicy = input.modelPolicy;
    this.#attachmentProvenanceKey = new Uint8Array(
      input.attachmentProvenanceKey,
    );
    this.#agentToolCli =
      input.agentToolCli ??
      Object.freeze({
        availability: "unavailable" as const,
        reason: "cli_unavailable" as const,
      });
    this.#agentToolSourceCapabilities = input.agentToolSourceCapabilities;
    this.#agentTools = input.agentTools;
    this.#childEnvironment = captureClaudeChildEnvironment(
      input.childEnvironment,
    );
    this.#forkBoundaryAuthentication = Object.freeze({
      installationKey: copyClaudeForkBoundaryKey(input.toolProvenanceKey),
      tenantId: this.connection.tenantId,
      principalId: this.connection.ownerPrincipalId,
      backendInstanceId: this.instance.id,
    });
    this.#acquireSession = input.acquireSession ?? (() => () => undefined);
    this.#beginVersionObservation = input.beginVersionObservation;
    this.#now = input.now ?? (() => new Date().toISOString());
    if (
      input.instance.kind !== "claude_agent_sdk" ||
      input.connection.kind !== "claude_agent_sdk" ||
      input.instance.id !== input.connection.backendInstanceId ||
      input.instance.tenantId !== input.connection.tenantId ||
      !input.connection.ownerPrincipalId ||
      (input.executablePath !== "claude" &&
        !normalizedAbsolutePath(input.executablePath)) ||
      !normalizedAbsolutePath(input.probeDirectory) ||
      !Number.isSafeInteger(input.initializationTimeoutMs) ||
      input.initializationTimeoutMs < 1_000 ||
      this.#attachmentProvenanceKey.byteLength !== 32
    ) {
      throw new Error("claude_driver_configuration_invalid");
    }
  }

  async health(): Promise<BackendHealth> {
    if (!this.instance.enabled || !this.connection.enabled) {
      return {
        available: false,
        checkedAt: this.#now(),
        diagnostic: boundDisplayText("The Claude backend is disabled."),
      };
    }
    try {
      await this.#probe(this.#probeDirectory);
      return { available: true, checkedAt: this.#now() };
    } catch {
      return {
        available: false,
        checkedAt: this.#now(),
        diagnostic: boundDisplayText(
          "The externally authenticated Claude subscription CLI is unavailable.",
        ),
      };
    }
  }

  async catalog(context: BackendCatalogContext): Promise<BackendCatalog> {
    this.#assertScope(context.scope);
    this.#assertWorkspace(context.workspace);
    this.#assertEnabled();
    try {
      const result = await this.#probe(context.workspace.canonicalPath);
      const models: BackendCatalog["models"][number][] = [];
      const modelGroups = new Map<string, typeof result.models>();
      for (const model of result.models) {
        const id = model.resolvedModel ?? model.value;
        modelGroups.set(id, [...(modelGroups.get(id) ?? []), model]);
      }
      for (const [id, aliases] of modelGroups) {
        // The moving default alias can carry stale presentation metadata.
        // Keep one exact identity and take model/effort metadata from an
        // explicit row when available; conflicting explicit rows remain
        // ambiguous and are omitted fail-closed.
        const model =
          aliases.find(({ value }) => value !== "default") ?? aliases[0]!;
        const effortSignature = (candidate: (typeof aliases)[number]) =>
          JSON.stringify(
            candidate.supportsEffort
              ? (candidate.supportedEffortLevels ?? [])
              : [],
          );
        const explicitAliases = aliases.filter(
          ({ value }) => value !== "default",
        );
        if (
          explicitAliases.some(
            (candidate) =>
              effortSignature(candidate) !== effortSignature(model),
          )
        ) {
          continue;
        }
        const identity = { modelId: id };
        const advertisedEfforts =
          model.supportsEffort && model.supportedEffortLevels?.length
            ? [...model.supportedEffortLevels]
            : [];
        const efforts = this.#modelPolicy.filterReasoningEfforts(
          identity,
          advertisedEfforts,
        );
        if (
          advertisedEfforts.length > 0
            ? efforts.length === 0
            : !this.#modelPolicy.isModelWithoutReasoningEffortAllowed(identity)
        ) {
          continue;
        }
        models.push({
          provider: this.connection.id,
          id,
          label: boundDisplayText(model.displayName).text,
          inputModalities: ["text", "image"],
          ...(aliases.some(({ value }) => value === "default")
            ? { isDefault: true as const }
            : {}),
          ...(efforts.length
            ? {
                supportedReasoningEfforts: efforts,
                defaultReasoningEffort: efforts.includes(advertisedEfforts[0]!)
                  ? advertisedEfforts[0]!
                  : efforts[0]!,
              }
            : {}),
        });
      }
      const skills = resolveClaudeSafeSkills({
        commands: result.commands,
        skillNames: result.skillNames,
        terminalCommandNames: result.terminalCommandNames,
      });
      return {
        models,
        commands: claudeSkillComposerCommands(skills, result.commands),
        skills,
        notices: [],
      };
    } catch (error) {
      throw mapClaudeReadError(error);
    }
  }

  async discover(
    input: DiscoverConversationsInput,
  ): Promise<DiscoveredConversationPage> {
    throwIfAborted(input.signal);
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    this.#assertEnabled();
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAXIMUM_DISCOVERY_PAGE
    ) {
      throw claudeError(
        "rejected",
        "The requested Claude discovery page size is invalid.",
        "claude_discovery_page_limit_invalid",
      );
    }
    const workspaceDigest = digest(input.workspace.canonicalPath);
    const cursor = input.cursor
      ? parseDiscoveryCursor(input.cursor, workspaceDigest)
      : undefined;
    const offset = cursor?.offset ?? 0;
    if (offset + input.limit > MAXIMUM_DISCOVERY_OFFSET) {
      throw claudeError(
        "rejected",
        "The Claude discovery cursor exceeds the supported snapshot bound.",
        "claude_discovery_offset_too_large",
      );
    }
    try {
      // Always reread the prefix. This detects reorder/insertion drift between
      // pages instead of silently importing an incoherent mutable offset view.
      const sessions = await this.#runtimeClient.listSessions(
        {
          dir: input.workspace.canonicalPath,
          limit: offset + input.limit + 1,
          offset: 0,
          includeWorktrees: false,
          includeProgrammatic: true,
        },
        this.#childEnvironment,
      );
      throwIfAborted(input.signal);
      if (
        cursor &&
        cursor.prefixDigest !== discoveryPrefixDigest(sessions.slice(0, offset))
      ) {
        throw claudeError(
          "unavailable",
          "Claude sessions changed while this discovery snapshot was being paged. Restart discovery.",
          "claude_discovery_snapshot_changed",
          true,
        );
      }
      const page = sessions.slice(offset, offset + input.limit);
      const ids = new Set<string>();
      const conversations = page.map((session) => {
        throwIfAborted(input.signal);
        const sessionId = uuidSchema.parse(session.sessionId);
        if (ids.has(sessionId)) {
          throw new Error("claude_discovery_duplicate_session");
        }
        ids.add(sessionId);
        if (
          session.cwd !== undefined &&
          session.cwd !== input.workspace.canonicalPath
        ) {
          throw new Error("claude_discovery_workspace_mismatch");
        }
        if (
          !Number.isSafeInteger(session.lastModified) ||
          session.lastModified < 0
        ) {
          throw new Error("claude_discovery_timestamp_invalid");
        }
        const title = (session.customTitle ?? session.summary).trim();
        return {
          backendConversationId: sessionId,
          canonicalWorkspacePath: input.workspace.canonicalPath,
          ...(title ? { title: boundDisplayText(title).text } : {}),
          updatedAt: new Date(session.lastModified).toISOString(),
          opaqueBindingDetail: serializeClaudeBindingDetail({
            version: 1,
            sessionId,
          }),
        };
      });
      const nextOffset = offset + page.length;
      return {
        conversations,
        ...(sessions.length > nextOffset
          ? {
              nextCursor: serializeDiscoveryCursor({
                version: 1,
                workspaceDigest,
                offset: nextOffset,
                prefixDigest: discoveryPrefixDigest(
                  sessions.slice(0, nextOffset),
                ),
              }),
            }
          : {}),
      };
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      throw mapClaudeReadError(error);
    }
  }

  async create(
    input: CreateConversationInput,
  ): Promise<CreateConversationResult> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    this.#assertEnabled();
    const sessionId = uuidSchema.safeParse(
      input.requestedBackendConversationId,
    );
    if (
      !sessionId.success ||
      !uuidSchema.safeParse(input.applicationOperationId).success ||
      input.creationCorrelation !== undefined
    ) {
      throw claudeError(
        "rejected",
        "Claude creation requires one application-assigned conversation UUID.",
        "claude_create_identity_invalid",
      );
    }
    return {
      backendConversationId: sessionId.data,
      reconciliationToken: digest(
        `claude-create\0${input.applicationOperationId}\0${sessionId.data}`,
      ),
      opaqueBindingDetail: serializeClaudeBindingDetail({
        version: 1,
        sessionId: sessionId.data,
      }),
    };
  }

  async attach(input: AttachConversationInput): Promise<ConversationHandle> {
    this.#assertAttach(input);
    this.#assertEnabled();
    const sessionId = input.binding.backendConversationId;
    const releaseAdmission = this.#acquireSession(sessionId);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseAdmission();
    };
    try {
      const info = await this.#runtimeClient.getSessionInfo(
        sessionId,
        { dir: input.workspace.canonicalPath },
        this.#childEnvironment,
      );
      if (info && info.sessionId !== sessionId) {
        throw sessionIdentityMismatch();
      }
      if (info?.cwd && info.cwd !== input.workspace.canonicalPath) {
        throw new Error("claude_session_workspace_mismatch");
      }
      const priorSettings = this.#settings.get(
        input.scope,
        input.binding.applicationThreadId,
      );
      this.#settings.markEffectiveUnknown(
        input.scope,
        input.binding.applicationThreadId,
        {
          expectedRevision: priorSettings.revision,
          now: Date.parse(this.#now()),
        },
      );
      const queryGeneration = this.#allocateQueryGeneration();
      const agentToolSource = {
        scope: input.scope,
        sourceThreadId: input.binding.applicationThreadId,
        sourceWorkspaceId: input.workspace.summary.id,
        sourceEnvironmentId: input.workspace.summary.environmentId,
        backendKind: "claude_agent_sdk" as const,
      };
      const agentToolPolicy =
        this.#agentToolCli.availability !== "unavailable"
          ? this.#agentTools.readPolicy(agentToolSource)
          : undefined;
      const cliPresentation =
        agentToolPolicy?.presentation.surface === "cli";
      // Native presentation runs `sedes mcp` through the same CLI runtime.
      const mcpPresentation =
        agentToolPolicy?.presentation.surface === "native";
      const sourceCapability =
        (cliPresentation || mcpPresentation) &&
        this.#agentToolCli.availability !== "unavailable"
          ? this.#agentToolSourceCapabilities.issue(
              agentToolSource,
              this.#agentToolCli.availability === "managed"
                ? "execution_environment_sidecar"
                : "management_http",
              mcpPresentation ? "mcp" : "cli",
            )
          : undefined;
      let handle: ClaudeConversationHandle | undefined;
      const versionObservation = this.#newVersionObservation(
        "conversation_session",
      );
      handle = await ClaudeConversationHandle.create({
        usage: this.#usage,
        nativeNamespace: this.#nativeNamespace,
        binding: input.binding,
        canonicalWorkspacePath: input.workspace.canonicalPath,
        workspaceId: input.workspace.summary.id,
        opaqueBindingDetail: input.opaqueBindingDetail,
        runtimeClient: this.#runtimeClient,
        executablePath: this.#executablePath,
        initializationTimeoutMs: this.#initializationTimeoutMs,
        settings: this.#settings,
        permissionPolicy: this.#permissionPolicy,
        modelPolicy: this.#modelPolicy,
        queryGeneration,
        allowDangerouslySkipPermissions: claudePermissionPolicyAllowsBypass(
          this.#permissionPolicy,
        )
          ? true
          : undefined,
        onPermissionModeEvidence: (evidence) =>
          this.#recordPermissionModeEvidence(
            input.binding.applicationThreadId,
            evidence,
          ),
        onModelEvidence: (evidence) =>
          this.#recordModelEvidence(
            input.binding.applicationThreadId,
            evidence,
          ),
        onEffortEvidence: (evidence) =>
          this.#recordEffortEvidence(
            input.binding.applicationThreadId,
            evidence,
          ),
        onQueryGenerationLost: (generation) =>
          this.#recordQueryGenerationLost(
            input.binding.applicationThreadId,
            generation,
          ),
        onEffectiveAxisUnknown: (generation, axis) =>
          this.#recordEffectiveAxisUnknown(
            input.binding.applicationThreadId,
            generation,
            axis,
          ),
        attachmentProvenanceKey: this.#attachmentProvenanceKey,
        ...(cliPresentation || mcpPresentation
          ? { agentToolCli: this.#agentToolCli }
          : {}),
        ...(cliPresentation
          ? { agentToolCliMode: agentToolPolicy!.presentation.mode }
          : {}),
        ...(mcpPresentation
          ? { agentToolMcpMode: agentToolPolicy!.presentation.mode }
          : {}),
        ...(sourceCapability ? { sourceCapability } : {}),
        childEnvironment: this.#childEnvironment,
        executionEnvironment: await this.#resolveThreadEnvironment(input.binding.applicationThreadId),
        onVersionAssessment: versionObservation.observeVersionAssessment,
        onVersionAssessmentFailed: versionObservation.failed,
        forkBoundaryAuthentication: this.#forkBoundaryAuthentication,
        loadInitialMessages: async () => {
          if (!info) return [];
          const messages = await this.#runtimeClient.getSessionMessages(
            sessionId,
            { dir: input.workspace.canonicalPath },
            this.#childEnvironment,
          );
          try {
            assertClaudeHistorySession(messages, sessionId);
          } catch (error) {
            throw mapClaudeReadError(error);
          }
          return messages;
        },
        resumeSession: info !== undefined,
        releaseSession: () => {
          if (handle) this.#handles.delete(handle);
          release();
        },
        now: () => Date.parse(this.#now()),
      });
      this.#handles.add(handle);
      return handle;
    } catch (error) {
      release();
      throw mapClaudeReadError(error);
    }
  }

  async read(input: ReadConversationInput): Promise<ConversationReadResult> {
    this.#assertAttach(input);
    this.#assertEnabled();
    try {
      const messages = await this.#readMessages(
        input.binding.backendConversationId,
        input.workspace,
      );
      const projection = projectClaudeHistory(
        messages,
        this.#settings.listTerminalReceipts(
          input.scope,
          input.binding.applicationThreadId,
        ),
        this.#historyAuthentication(
          input.scope,
          input.binding.applicationThreadId,
          input.binding.backendConversationId,
        ),
      );
      return { snapshot: projection.snapshot, usage: projection.usage ?? {} };
    } catch (error) {
      throw mapClaudeReadError(error);
    }
  }

  async resolveBranchCheckpoint(
    input: ResolveBranchCheckpointInput,
  ): Promise<BackendCheckpointRef> {
    this.#assertAttach(input);
    this.#assertEnabled();
    if (input.selection.kind === "latest_provider_snapshot") {
      throw claudeError(
        "invalid_state",
        "Claude does not support forking the provider's latest in-flight snapshot.",
        "claude_provider_snapshot_fork_unsupported",
      );
    }
    try {
      const messages = await this.#readMessages(
        input.binding.backendConversationId,
        input.workspace,
      );
      const projection = projectClaudeHistory(
        messages,
        this.#settings.listTerminalReceipts(
          input.scope,
          input.binding.applicationThreadId,
        ),
        this.#historyAuthentication(
          input.scope,
          input.binding.applicationThreadId,
          input.binding.backendConversationId,
        ),
      );
      const backendTurnId =
        input.selection.kind === "selected_completed_turn"
          ? input.selection.backendTurnId
          : projection.snapshot.orderedBackendTurnIds.at(-1);
      const retainedLeafUuid = backendTurnId
        ? projection.terminalCheckpointUuidByBackendTurnId.get(backendTurnId)
        : undefined;
      const retainedLeafIndex = retainedLeafUuid
        ? messages.findIndex((message) => message.uuid === retainedLeafUuid)
        : -1;
      if (!backendTurnId || !retainedLeafUuid || retainedLeafIndex < 0) {
        throw claudeError(
          "invalid_state",
          "The selected Claude turn is not a durable successfully completed fork boundary.",
          "claude_fork_checkpoint_unavailable",
        );
      }
      const prefix = messages.slice(0, retainedLeafIndex + 1);
      return {
        backendInstanceId: this.instance.id,
        kind: "conversation_leaf",
        opaqueReference: serializeBranchCheckpoint({
          version: 1,
          sourceSessionId: input.binding.backendConversationId,
          backendTurnId,
          retainedLeafUuid,
          retainedPrefixCount: prefix.length,
          retainedPrefixDigest: transcriptFingerprint(prefix),
          retainedContentDigest: transcriptContentFingerprint(prefix),
        }),
      };
    } catch (error) {
      throw mapClaudeForkReadError(error);
    }
  }

  async branchConversation(
    input: BranchConversationInput,
  ): Promise<CreateConversationResult> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    this.#assertEnabled();
    this.#assertBinding(
      input.sourceBinding,
      input.workspace,
      input.sourceOpaqueBindingDetail,
    );
    if (
      input.sourceCheckpoint.backendInstanceId !== this.instance.id ||
      input.sourceCheckpoint.kind !== "conversation_leaf" ||
      !uuidSchema.safeParse(input.requestedBackendConversationId).success ||
      input.requestedBackendConversationId ===
        input.sourceBinding.backendConversationId ||
      input.creationCorrelation !== undefined ||
      !uuidSchema.safeParse(input.applicationOperationId).success
    ) {
      throw claudeError(
        "rejected",
        "The Claude fork reservation is invalid.",
        "claude_fork_reservation_invalid",
      );
    }
    const checkpoint = parseBranchCheckpoint(
      input.sourceCheckpoint.opaqueReference,
    );
    if (
      checkpoint.sourceSessionId !== input.sourceBinding.backendConversationId
    ) {
      throw bindingMismatch();
    }
    const childSettings = this.#settings.freezeOperationSnapshot(input.scope, {
      applicationThreadId: input.childApplicationThreadId,
      applicationOperationId: input.applicationOperationId,
      now: Date.parse(this.#now()),
    });
    this.#assertPermissionModeAllowed(childSettings.permissionMode);
    if (
      !childSettings.model ||
      input.inheritedSettings?.model?.provider !== this.connection.id ||
      input.inheritedSettings.model.id !== childSettings.model ||
      (input.inheritedSettings.thinkingLevel ?? null) !== childSettings.effort
    ) {
      throw claudeError(
        "invalid_state",
        "The Claude fork settings do not match the durable source snapshot.",
        "claude_fork_settings_mismatch",
      );
    }
    const sourceMessages = await this.#readMessages(
      input.sourceBinding.backendConversationId,
      input.workspace,
    );
    const retainedLeafIndex = sourceMessages.findIndex(
      ({ uuid }) => uuid === checkpoint.retainedLeafUuid,
    );
    const prefix = sourceMessages.slice(0, retainedLeafIndex + 1);
    if (
      retainedLeafIndex < 0 ||
      prefix.length !== checkpoint.retainedPrefixCount ||
      transcriptFingerprint(prefix) !== checkpoint.retainedPrefixDigest ||
      transcriptContentFingerprint(prefix) !== checkpoint.retainedContentDigest
    ) {
      throw claudeError(
        "invalid_state",
        "The durable Claude fork checkpoint no longer matches the source history.",
        "claude_fork_checkpoint_changed",
      );
    }
    const retainedProjection = projectClaudeHistory(
      prefix,
      [],
      this.#historyAuthentication(
        input.scope,
        input.sourceBinding.applicationThreadId,
        input.sourceBinding.backendConversationId,
      ),
    );
    const copyTaskContextEvidence = (): void =>
      this.#settings.copyOperationSnapshotsForFork(input.scope, {
        sourceApplicationThreadId: input.sourceBinding.applicationThreadId,
        childApplicationThreadId: input.childApplicationThreadId,
        applicationOperationIds:
          retainedProjection.authenticatedTaskContextOperationIds,
      });
    const copyInputEvidence = (childMessages: readonly SessionMessage[]): void => {
      const evidence = {
        sourceApplicationThreadId: input.sourceBinding.applicationThreadId,
        childApplicationThreadId: input.childApplicationThreadId,
        nativeUserMessageMappings: prefix.flatMap((sourceMessage, index) => {
          const childMessage = childMessages[index];
          return sourceMessage.type === "user" && childMessage?.type === "user"
            ? [{ sourceUuid: sourceMessage.uuid, childUuid: childMessage.uuid }]
            : [];
        }),
      };
      this.#settings.copySkillInvocationsForFork(input.scope, evidence);
      this.#settings.copySteerOperationsForFork(input.scope, evidence);
    };
    const childSessionId = input.requestedBackendConversationId!;
    const copyTaskLifecycleEvidence = (): void =>
      this.#settings.copyTaskLifecycleReceiptsForFork(input.scope, {
        sourceApplicationThreadId: input.sourceBinding.applicationThreadId,
        sourceNativeSessionId: input.sourceBinding.backendConversationId,
        childApplicationThreadId: input.childApplicationThreadId,
        childNativeSessionId: childSessionId,
        nativeToolUseIds: retainedProjection.nativeToolUseIds,
      });
    const resultForChild = (): CreateConversationResult => ({
      backendConversationId: childSessionId,
      reconciliationToken: digest(
        `claude-fork\0${input.applicationOperationId}\0${childSessionId}`,
      ),
      opaqueBindingDetail: serializeClaudeBindingDetail({
        version: 1,
        sessionId: childSessionId,
      }),
    });
    const existingChild = await this.#runtimeClient.getSessionInfo(
      childSessionId,
      { dir: input.workspace.canonicalPath },
      this.#childEnvironment,
    );
    if (existingChild) {
      const existingMessages = await this.#readMessages(
        childSessionId,
        input.workspace,
      );
      if (
        existingMessages.length !== checkpoint.retainedPrefixCount ||
        transcriptContentFingerprint(existingMessages) !==
          checkpoint.retainedContentDigest
      ) {
        throw claudeError(
          "invalid_state",
          "The reserved Claude fork identity already belongs to another session.",
          "claude_fork_identity_conflict",
        );
      }
      copyTaskContextEvidence();
      copyInputEvidence(existingMessages);
      copyTaskLifecycleEvidence();
      return resultForChild();
    }
    this.#assertModelPolicyAllowed(childSettings.model, childSettings.effort);
    const versionObservation = this.#newVersionObservation(
      "conversation_session",
    );
    const session = this.#runtimeClient.createSession({
      executionEnvironment: await this.#resolveThreadEnvironment(input.childApplicationThreadId),
      executablePath: this.#executablePath,
      initializationTimeoutMs: this.#initializationTimeoutMs,
      sessionId: childSessionId,
      sourceSessionId: input.sourceBinding.backendConversationId,
      resumeSessionAt: checkpoint.retainedLeafUuid,
      cwd: input.workspace.canonicalPath,
      launch: "fork",
      ...(input.title ? { title: input.title } : {}),
      model: childSettings.model,
      ...(childSettings.effort
        ? { effort: effortSchema.parse(childSettings.effort) as EffortLevel }
        : {}),
      permissionMode: childSettings.permissionMode,
      ...(claudePermissionPolicyAllowsBypass(this.#permissionPolicy)
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      environment: this.#childEnvironment,
      onVersionAssessment: versionObservation.observeVersionAssessment,
      onVersionAssessmentFailed: versionObservation.failed,
      onMessage: () => undefined,
    });
    const releaseAdmission = this.#acquireSession(childSessionId);
    try {
      const initialization = await session.start();
      await this.#confirmTransientSessionSettings(
        session,
        initialization,
        childSettings,
        "fork",
      );
      await session.close();
      const childMessages = await this.#readMessages(
        childSessionId,
        input.workspace,
      );
      if (
        childMessages.length !== checkpoint.retainedPrefixCount ||
        transcriptContentFingerprint(childMessages) !==
          checkpoint.retainedContentDigest
      ) {
        throw new Error("claude_fork_response_history_invalid");
      }
      copyTaskContextEvidence();
      copyInputEvidence(childMessages);
      copyTaskLifecycleEvidence();
      return resultForChild();
    } catch (error) {
      await session.close();
      if (
        error instanceof BackendError &&
        (error.backendCode === "claude_fork_effective_settings_mismatch" ||
          error.backendCode === "claude_fork_effort_unconfirmed")
      ) {
        throw error;
      }
      throw claudeMutationUnknown(
        "Claude fork creation crossed the provider boundary without a fully verified response.",
        "claude_fork_outcome_unknown",
        error,
      );
    } finally {
      releaseAdmission();
    }
  }

  async reconcileSubmission(
    input: ReconcileSubmissionInput,
  ): Promise<SubmissionReconciliation> {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    if (!input.binding || !input.opaqueBindingDetail) {
      return unresolved(
        "Claude submission reconciliation is missing its durable binding.",
      );
    }
    try {
      this.#assertBinding(
        input.binding,
        input.workspace,
        input.opaqueBindingDetail,
      );
      uuidSchema.parse(input.applicationOperationId);
      const messages = await this.#readMessages(
        input.binding.backendConversationId,
        input.workspace,
      );
      const projection = projectClaudeHistory(
        messages,
        this.#settings.listTerminalReceipts(
          input.scope,
          input.binding.applicationThreadId,
        ),
        this.#historyAuthentication(
          input.scope,
          input.binding.applicationThreadId,
          input.binding.backendConversationId,
        ),
      );
      const reconciliation = reconcileProjectedSubmission(
        projection,
        messages,
        input.applicationOperationId,
        input.retryAnchor,
      );
      if (reconciliation.status === "accepted") return reconciliation;
      const steerOperations = this.#settings.listSteerOperations(input.scope, input.binding.applicationThreadId);
      if (this.#runtimeClient.submissionDisposition) {
        // Enqueue and consumption are distinct. Ask the owner even without an
        // idle-submit anchor, but never invent not_sent from a missing journal.
        const disposition = await this.#runtimeClient.submissionDisposition({
          sessionId: input.binding.backendConversationId,
          operationId: input.applicationOperationId,
          cwd: input.workspace.canonicalPath,
        });
        if (disposition === "session_ended") {
          if (typeof this.#settings.listSteerOperations(input.scope, input.binding.applicationThreadId).get(input.applicationOperationId) === "string") {
            return unresolved("Claude retained consumption evidence while its delivery owner was being checked.");
          }
          for (const handle of this.#handles) {
            if (handle.binding.applicationThreadId === input.binding.applicationThreadId &&
                handle.binding.backendConversationId === input.binding.backendConversationId &&
                !handle.endSubmissionObservation(input.applicationOperationId)) {
              return unresolved("Claude consumed this input while its delivery owner was being checked.");
            }
          }
          if (!steerOperations.has(input.applicationOperationId)) {
            return unresolved("Claude's delivery owner ended before this input could be confirmed. Claude may have received it.");
          }
          return { status: "failed_unknown", diagnostic: boundDisplayText(
            "Claude's delivery owner ended before this steering message could be confirmed. Claude may have received it. Review the conversation before explicitly restoring or sending it again.",
          ) };
        }
        if (disposition === "not_sent") {
          if (messages.some(message => message.type === "user" && message.uuid === input.applicationOperationId) ||
              typeof this.#settings.listSteerOperations(input.scope, input.binding.applicationThreadId).get(input.applicationOperationId) === "string") {
            return unresolved("Claude's non-admission evidence conflicts with retained native input evidence.");
          }
          for (const handle of this.#handles) {
            if (handle.binding.applicationThreadId === input.binding.applicationThreadId &&
                handle.binding.backendConversationId === input.binding.backendConversationId) {
              if (!handle.forgetProvenUnsentSubmission(input.applicationOperationId)) {
                return unresolved("Claude consumed this input while its admission status was being checked.");
              }
            }
          }
          this.#settings.forgetUnconsumedSteerOperation(input.scope, input.binding.applicationThreadId, input.applicationOperationId);
          return { status: "not_accepted", retryable: true };
        }
        return unresolved(
          disposition === "submitted"
            ? "The remote Claude runtime retained this submission, but native history has not yet established its outcome."
            : "The remote Claude runtime cannot prove this submission was not sent.",
        );
      }
      if (steerOperations.has(input.applicationOperationId)) {
        if (typeof steerOperations.get(input.applicationOperationId) === "string") {
          return unresolved("Claude retained exact steering consumption evidence, but its history has not materialized yet.");
        }
        const localObservers = [...this.#handles].filter(handle =>
          handle.binding.applicationThreadId === input.binding!.applicationThreadId &&
          handle.binding.backendConversationId === input.binding!.backendConversationId);
        if (localObservers.some(handle => handle.hasPendingSubmissionObservation(input.applicationOperationId))) {
          return unresolved("Claude is still tracking this queued steering message; consumption has not been confirmed.");
        }
        if (localObservers.some(handle => !handle.endSubmissionObservation(input.applicationOperationId))) {
          return unresolved("Claude consumed this input while its delivery owner was being checked.");
        }
        // Local SDK observers cannot reattach after their owning handle/process
        // ends. This ends delivery tracking, not a claim that an orphaned CLI
        // stopped or that the message was never consumed. Preserve its identity
        // for late exact evidence, and never authorize an automatic retry.
        return { status: "failed_unknown", diagnostic: boundDisplayText(
          "Local Claude delivery tracking ended before this steering message could be confirmed. Claude may have received it. Review the conversation before explicitly restoring or sending it again.",
        ) };
      }
      const unconfirmedObservers = [...this.#handles].filter(handle =>
        handle.binding.applicationThreadId === input.binding!.applicationThreadId &&
        handle.binding.backendConversationId === input.binding!.backendConversationId &&
        handle.hasUnconfirmedSubmission(input.applicationOperationId));
      if (unconfirmedObservers.length > 0) {
        for (const handle of unconfirmedObservers) {
          if (!handle.hasPendingSubmissionObservation(input.applicationOperationId)) {
            handle.endSubmissionObservation(input.applicationOperationId);
          }
        }
        // The old transcript anchor cannot prove that an input retained by the
        // live session was never sent. Only exact owner not_sent proof above
        // may clear this waiter and authorize another native submission.
        return unresolved("Claude still has unconfirmed submission evidence; unchanged history does not prove this input was not sent.");
      }
      return reconciliation;
    } catch (error) {
      if (error instanceof BackendError && error.category === "not_found") {
        return unresolved(
          "Claude has not exposed the session yet, so submission acceptance cannot be distinguished from native-store persistence lag.",
        );
      }
      return unresolved(
        "Claude could not authoritatively reconcile the submission.",
      );
    }
  }

  async close(): Promise<void> {
    const handles = [...this.#handles];
    await Promise.allSettled(
      handles.map(async (handle) => await handle.close()),
    );
    this.#handles.clear();
  }

  #recordPermissionModeEvidence(
    applicationThreadId: string,
    evidence: {
      readonly generation: number;
      readonly mode: import("@anthropic-ai/claude-agent-sdk").PermissionMode;
      readonly source: "init" | "setter" | "status";
    },
  ): void {
    const scope = {
      tenantId: this.connection.tenantId,
      principalId: this.connection.ownerPrincipalId,
    };
    const current = this.#settings.get(scope, applicationThreadId);
    if (
      evidence.source === "init" &&
      current.permissionMode === null &&
      isClaudePermissionMode(evidence.mode) &&
      isClaudePermissionModeAllowed(evidence.mode, this.#permissionPolicy)
    ) {
      this.#settings.adoptImportedPermissionMode(scope, applicationThreadId, {
        expectedRevision: current.revision,
        permissionMode: evidence.mode,
        queryGeneration: evidence.generation,
        now: Date.parse(this.#now()),
      });
      return;
    }
    const latest = this.#settings.get(scope, applicationThreadId);
    this.#settings.confirmEffectivePermissionMode(scope, applicationThreadId, {
      expectedRevision: latest.revision,
      permissionMode: isClaudePermissionMode(evidence.mode)
        ? evidence.mode
        : null,
      classification: isClaudePermissionMode(evidence.mode)
        ? "recognized"
        : "external_custom",
      queryGeneration: evidence.generation,
      now: Date.parse(this.#now()),
    });
  }

  async #confirmTransientSessionSettings(
    session: ClaudeRuntimeSession,
    initialization: Awaited<ReturnType<ClaudeRuntimeSession["start"]>>,
    settings: {
      readonly model: string;
      readonly effort: string | null;
      readonly permissionMode: ClaudePermissionMode;
    },
    operation: "fork",
  ): Promise<void> {
    if (
      initialization.actualModel !== settings.model ||
      initialization.actualPermissionMode !== settings.permissionMode
    ) {
      throw claudeError(
        "invalid_state",
        "Claude did not initialize with the frozen execution settings.",
        `claude_${operation}_effective_settings_mismatch`,
      );
    }
    try {
      await session.setEffort(
        settings.effort
          ? (effortSchema.parse(settings.effort) as EffortLevel)
          : undefined,
      );
    } catch (error) {
      throw new BackendError(
        {
          category: "unavailable",
          retryable: true,
          crossedSubmissionBoundary: false,
          safeMessage: "Claude did not acknowledge the frozen effort setting.",
          backendCode: `claude_${operation}_effort_unconfirmed`,
        },
        { cause: error },
      );
    }
  }

  #recordModelEvidence(
    applicationThreadId: string,
    evidence: { readonly generation: number; readonly model: string },
  ): void {
    const scope = {
      tenantId: this.connection.tenantId,
      principalId: this.connection.ownerPrincipalId,
    };
    const current = this.#settings.get(scope, applicationThreadId);
    this.#settings.confirmEffectiveModel(scope, applicationThreadId, {
      expectedRevision: current.revision,
      model: evidence.model,
      queryGeneration: evidence.generation,
      now: Date.parse(this.#now()),
    });
  }

  #recordEffortEvidence(
    applicationThreadId: string,
    evidence: { readonly generation: number; readonly effort: string | null },
  ): void {
    const scope = {
      tenantId: this.connection.tenantId,
      principalId: this.connection.ownerPrincipalId,
    };
    const current = this.#settings.get(scope, applicationThreadId);
    this.#settings.confirmEffectiveEffort(scope, applicationThreadId, {
      expectedRevision: current.revision,
      effort: evidence.effort,
      queryGeneration: evidence.generation,
      now: Date.parse(this.#now()),
    });
  }

  #recordQueryGenerationLost(
    applicationThreadId: string,
    generation: number,
  ): void {
    const scope = {
      tenantId: this.connection.tenantId,
      principalId: this.connection.ownerPrincipalId,
    };
    const current = this.#settings.get(scope, applicationThreadId);
    if (
      current.effectiveModelGeneration !== generation &&
      current.effectiveEffortGeneration !== generation &&
      current.effectivePermissionGeneration !== generation
    ) {
      return;
    }
    this.#settings.markEffectiveUnknown(scope, applicationThreadId, {
      expectedRevision: current.revision,
      now: Date.parse(this.#now()),
    });
  }

  #recordEffectiveAxisUnknown(
    applicationThreadId: string,
    generation: number,
    axis: "model" | "effort" | "permission",
  ): void {
    const scope = {
      tenantId: this.connection.tenantId,
      principalId: this.connection.ownerPrincipalId,
    };
    const current = this.#settings.get(scope, applicationThreadId);
    const effectiveGeneration =
      axis === "model"
        ? current.effectiveModelGeneration
        : axis === "effort"
          ? current.effectiveEffortGeneration
          : current.effectivePermissionGeneration;
    if (effectiveGeneration !== generation) return;
    this.#settings.markEffectiveAxisUnknown(scope, applicationThreadId, {
      expectedRevision: current.revision,
      axis,
      queryGeneration: generation,
      now: Date.parse(this.#now()),
    });
  }

  #allocateQueryGeneration(): number {
    if (this.#nextQueryGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error("claude_query_generation_exhausted");
    }
    this.#nextQueryGeneration += 1;
    return this.#nextQueryGeneration;
  }

  #assertPermissionModeAllowed(mode: ClaudePermissionMode): void {
    if (isClaudePermissionModeAllowed(mode, this.#permissionPolicy)) return;
    throw claudeError(
      "rejected",
      "The selected Claude permission mode is no longer allowed.",
      "claude_permission_mode_rejected",
    );
  }

  #assertModelPolicyAllowed(model: string, effort: string | null): void {
    if (
      effort === null
        ? this.#modelPolicy.isModelWithoutReasoningEffortAllowed({
            modelId: model,
          })
        : this.#modelPolicy.isSelectionAllowed({
            modelId: model,
            reasoningEffort: effort,
          })
    ) {
      return;
    }
    throw claudeError(
      "rejected",
      "This model or reasoning effort is not allowed by the backend policy.",
      "model_policy_rejected",
    );
  }

  #historyAuthentication(
    scope: Readonly<{ tenantId: string; principalId: string }>,
    applicationThreadId: string,
    nativeSessionId: string,
  ): ClaudeHistoryAuthentication {
    const permittedByOperationId = new Map<string, boolean>();
    const skillByNativeUserUuid = new Map<string, string | null>();
    return {
      steerOperations: this.#settings.listSteerOperations(scope, applicationThreadId),
      taskLifecycleReceipts: this.#settings.listTaskLifecycleReceipts(scope, applicationThreadId, nativeSessionId),
      attachmentProvenanceKey: this.#attachmentProvenanceKey,
      forkBoundaryAuthentication: this.#forkBoundaryAuthentication,
      isApplicationInputOperation: (applicationOperationId) => {
        const cached = permittedByOperationId.get(applicationOperationId);
        if (cached !== undefined) return cached;
        const permitted = this.#settings.hasOperationSnapshot(scope, {
          applicationThreadId,
          applicationOperationId,
        });
        permittedByOperationId.set(applicationOperationId, permitted);
        return permitted;
      },
      resolveSkillName: (nativeUserMessageUuid) => {
        if (skillByNativeUserUuid.has(nativeUserMessageUuid)) {
          return skillByNativeUserUuid.get(nativeUserMessageUuid) ?? undefined;
        }
        const skillName = this.#settings.findSkillInvocation(
          scope,
          applicationThreadId,
          nativeUserMessageUuid,
        )?.skillName;
        skillByNativeUserUuid.set(nativeUserMessageUuid, skillName ?? null);
        return skillName;
      },
    };
  }

  async #probe(cwd: string) {
    const versionObservation = this.#newVersionObservation("health_probe");
    try {
      return await this.#runtimeClient.probe({
        executablePath: this.#executablePath,
        cwd,
        timeoutMs: this.#initializationTimeoutMs,
        environment: this.#childEnvironment,
        onVersionAssessment: versionObservation.observeVersionAssessment,
      });
    } catch (error) {
      versionObservation.failed();
      throw error;
    }
  }

  #newVersionObservation(
    source: ClaudeRuntimeVersionObservationSource,
  ): ClaudeRuntimeVersionObservation {
    return (
      this.#beginVersionObservation?.(source) ??
      Object.freeze({
        source,
        generation: 0,
        observeVersionAssessment: () => undefined,
        failed: () => undefined,
      })
    );
  }

  async #readMessages(
    sessionId: string,
    workspace: ValidatedWorkspace,
  ): Promise<SessionMessage[]> {
    const info = await this.#runtimeClient.getSessionInfo(
      sessionId,
      { dir: workspace.canonicalPath },
      this.#childEnvironment,
    );
    if (!info) {
      throw claudeError(
        "not_found",
        "The Claude session was not found.",
        "claude_session_not_found",
      );
    }
    if (info.sessionId !== sessionId) {
      throw sessionIdentityMismatch();
    }
    if (info.cwd && info.cwd !== workspace.canonicalPath) {
      throw new Error("claude_session_workspace_mismatch");
    }
    const messages = await this.#runtimeClient.getSessionMessages(
      sessionId,
      { dir: workspace.canonicalPath },
      this.#childEnvironment,
    );
    assertClaudeHistorySession(messages, sessionId);
    return messages;
  }

  #assertAttach(input: AttachConversationInput | ReadConversationInput): void {
    this.#assertScope(input.scope);
    this.#assertWorkspace(input.workspace);
    this.#assertBinding(
      input.binding,
      input.workspace,
      input.opaqueBindingDetail,
    );
  }

  #assertBinding(
    binding: AttachConversationInput["binding"],
    workspace: ValidatedWorkspace,
    opaqueBindingDetail: string,
  ): void {
    let detail;
    try {
      detail = parseClaudeBindingDetail(opaqueBindingDetail);
    } catch {
      throw bindingMismatch();
    }
    if (
      binding.tenantId !== this.connection.tenantId ||
      binding.ownerPrincipalId !== this.connection.ownerPrincipalId ||
      binding.backendInstanceId !== this.instance.id ||
      binding.connectionProfileId !== this.connection.id ||
      binding.executionEnvironmentId !==
        this.connection.executionEnvironmentId ||
      workspace.summary.environmentId !== binding.executionEnvironmentId ||
      detail.sessionId !== binding.backendConversationId
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

  #assertWorkspace(workspace: ValidatedWorkspace): void {
    if (
      workspace.summary.environmentId !==
        this.connection.executionEnvironmentId ||
      !normalizedAbsolutePath(workspace.canonicalPath)
    ) {
      throw bindingMismatch();
    }
  }

  #assertEnabled(): void {
    if (!this.instance.enabled || !this.connection.enabled) {
      throw claudeError(
        "unavailable",
        "The Claude backend is disabled.",
        "claude_backend_disabled",
      );
    }
  }
}

function reconcileProjectedSubmission(
  projection: ClaudeHistoryProjection,
  messages: readonly SessionMessage[],
  operationId: string,
  retryAnchor: string | undefined,
): SubmissionReconciliation {
  const matches = Object.entries(projection.snapshot.turnsById).filter(
    ([, turn]) => turn.completionCorrelations?.includes(operationId),
  );
  if (matches.length === 0) {
    const anchor = parseRetryAnchor(retryAnchor);
    if (!anchor || !retryAnchorMatches(anchor, messages)) {
      return unresolved(
        "Claude did not expose the submission identity, but the durable pre-submit transcript anchor is missing, invalid, or no longer current.",
      );
    }
    return { status: "not_accepted", retryable: true };
  }
  if (matches.length !== 1) {
    return unresolved(
      "Claude exposed duplicate user-message identities for this submission.",
    );
  }
  const [backendTurnId] = matches[0]!;
  const backendTurn = projection.snapshot.turnsById[backendTurnId];
  if (!backendTurn) {
    return unresolved(
      "Claude accepted the message but its turn could not be projected.",
    );
  }
  return {
    status: "accepted",
    backendTurn,
    ...(backendTurn.status === "completed" ||
    backendTurn.status === "interrupted" ||
    backendTurn.status === "failed"
      ? { completionIdentity: `${backendTurnId}:${backendTurn.status}` }
      : {}),
  };
}

function parseRetryAnchor(
  value: string | undefined,
): z.infer<typeof retryAnchorSchema> | undefined {
  if (
    value === undefined ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_RETRY_ANCHOR_BYTES
  ) {
    return undefined;
  }
  try {
    return retryAnchorSchema.parse(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function retryAnchorMatches(
  anchor: z.infer<typeof retryAnchorSchema>,
  messages: readonly SessionMessage[],
): boolean {
  return (
    anchor.messageCount === messages.length &&
    anchor.lastMessageUuid === (messages.at(-1)?.uuid ?? null) &&
    anchor.transcriptFingerprint === transcriptFingerprint(messages)
  );
}

function transcriptFingerprint(messages: readonly SessionMessage[]): string {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(message.uuid).update("\0");
  return hash.digest("base64url");
}

function transcriptContentFingerprint(
  messages: readonly SessionMessage[],
): string {
  return digest(
    JSON.stringify(
      messages.map((message) => ({
        type: message.type,
        parentToolUseId: message.parent_tool_use_id,
        parentAgentId: message.parent_agent_id,
        origin: "origin" in message ? message.origin : undefined,
        message: message.message,
      })),
    ),
  );
}

function serializeBranchCheckpoint(
  input: z.infer<typeof branchCheckpointSchema>,
): string {
  return Buffer.from(
    JSON.stringify(branchCheckpointSchema.parse(input)),
  ).toString("base64url");
}

function parseBranchCheckpoint(
  value: string,
): z.infer<typeof branchCheckpointSchema> {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_BRANCH_CHECKPOINT_BYTES) {
    throw invalidBranchCheckpoint();
  }
  try {
    return branchCheckpointSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw invalidBranchCheckpoint();
  }
}

function invalidBranchCheckpoint(): BackendError {
  return claudeError(
    "rejected",
    "The Claude fork checkpoint is invalid.",
    "claude_fork_checkpoint_invalid",
  );
}

function discoveryPrefixDigest(
  sessions: readonly {
    readonly sessionId: string;
    readonly lastModified: number;
  }[],
): string {
  return digest(
    sessions
      .map(({ sessionId, lastModified }) => `${sessionId}\0${lastModified}`)
      .join("\n"),
  );
}

function serializeDiscoveryCursor(
  input: z.infer<typeof discoveryCursorSchema>,
): string {
  return Buffer.from(
    JSON.stringify(discoveryCursorSchema.parse(input)),
  ).toString("base64url");
}

function parseDiscoveryCursor(
  value: string,
  workspaceDigest: string,
): z.infer<typeof discoveryCursorSchema> {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_CURSOR_BYTES) {
    throw claudeError(
      "rejected",
      "The Claude discovery cursor is invalid.",
      "claude_discovery_cursor_invalid",
    );
  }
  try {
    const parsed = discoveryCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (parsed.workspaceDigest !== workspaceDigest)
      throw new Error("workspace");
    return parsed;
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw claudeError(
      "rejected",
      "The Claude discovery cursor is invalid.",
      "claude_discovery_cursor_invalid",
    );
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function bindingMismatch(): BackendError {
  return claudeError(
    "permission_denied",
    "The Claude conversation binding does not match this execution scope.",
    "claude_binding_mismatch",
  );
}

function unresolved(diagnostic: string): SubmissionReconciliation {
  return { status: "unresolved", diagnostic: boundDisplayText(diagnostic) };
}

function claudeError(
  category: ConstructorParameters<typeof BackendError>[0]["category"],
  safeMessage: string,
  backendCode: string,
  retryable = false,
  cause?: unknown,
): BackendError {
  return new BackendError({
    category,
    retryable,
    crossedSubmissionBoundary: false,
    safeMessage,
    backendCode,
  }, cause === undefined ? undefined : { cause });
}

function claudeMutationUnknown(
  safeMessage: string,
  backendCode: string,
  cause?: unknown,
): BackendError {
  return new BackendError(
    {
      category: "submission_unknown",
      retryable: false,
      crossedSubmissionBoundary: true,
      safeMessage,
      backendCode,
    },
    cause === undefined ? undefined : { cause },
  );
}

function mapClaudeForkReadError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  return mapClaudeReadError(error);
}

function sessionIdentityMismatch(): BackendError {
  return claudeError(
    "incompatible_protocol",
    "Claude returned session data for another native conversation.",
    "claude_session_identity_mismatch",
  );
}

function mapClaudeReadError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (
    error instanceof Error &&
    error.message === "claude_session_workspace_mismatch"
  ) {
    return claudeError(
      "invalid_state",
      "The Claude session belongs to another workspace.",
      "claude_session_workspace_mismatch",
    );
  }
  if (error instanceof ClaudeHistoryProjectionError) {
    if (error.code === "claude_message_payload_too_large") {
      return claudeError(
        "incompatible_protocol",
        "Claude returned conversation content that exceeds the supported message size.",
        error.code,
        false,
        error,
      );
    }
    if (error.code === "claude_history_session_identity_mismatch") {
      return sessionIdentityMismatch();
    }
    if (error.code === "history_too_large") {
      return claudeError(
        "unavailable",
        "This Claude thread is too large to display safely.",
        error.code,
      );
    }
    if (error.code === "claude_history_cursor_invalid") {
      return claudeError(
        "rejected",
        "The Claude history cursor is invalid.",
        error.code,
      );
    }
    return claudeError(
      "incompatible_protocol",
      "Claude returned incomplete or invalid session history.",
      error.code,
    );
  }
  return claudeError(
    "unavailable",
    "Claude session data is temporarily unavailable.",
    "claude_sdk_read_failed",
    true,
    error,
  );
}
