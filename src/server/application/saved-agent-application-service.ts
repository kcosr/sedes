import type { EnvironmentVariablesService } from "../environment-variables/environment-variables-service.js";
import type {
  CreateThreadFromSettingsRequest,
  CreateThreadRequest,
  CreateThreadResult,
} from "../../shared/protocol/api.js";
import {
  agentToolBootstrapDescriptorSchema,
  resolveSavedAgentResultSchema,
  savedAgentOptionsResultSchema,
  type AgentToolBootstrapDescriptor,
  type AgentToolBootstrapPolicy,
  type CreateSavedAgentRequest,
  type NormalizedAgentConfigurationOverrides,
  type ResolveSavedAgentRequest,
  type ResolveSavedAgentResult,
  type ResolvedAgentToolBootstrapPolicy,
  type SavedAgent,
  type SavedAgentOptionsRequest,
  type SavedAgentOptionsResult,
  type SavedAgentResolutionCandidate,
  type SavedAgentTargetDescriptor,
  type UpdateSavedAgentRequest,
} from "../../shared/protocol/saved-agents.js";
import type { AgentBackendRegistry } from "../backends/registry.js";
import type { SavedAgentBackendAdapterRegistry } from "../backends/saved-agent-adapter-registry.js";
import type {
  CanonicalSavedAgentBackendOverrides,
  PreparedSavedAgentBackendContext,
  ResolvedSavedAgentBackendConfiguration,
  SavedAgentBackendAdapter,
  SavedAgentBackendContextInput,
} from "../backends/saved-agent-adapter.js";
import type { ExecutionTargetReader } from "./execution-target-reader.js";
import type { DatabaseConversationTargetStore } from "../conversations/database-conversation-adapters.js";
import type { ConversationLifecycleService } from "../conversations/conversation-lifecycle-service.js";
import { boundDisplayText } from "../conversations/payload-policy.js";
import type { ThreadAgentToolCatalogReader } from "../conversations/database-thread-application-readers.js";
import type {
  BackendConfigurationRepository,
  BackendInstanceRecord,
  ConnectionProfileRecord,
} from "../db/repositories/backend-configuration-repository.js";
import type {
  ThreadAgentToolEligibilityPolicy,
  ThreadAgentToolPolicyRecord,
  ThreadAgentToolPolicyRepository,
} from "../db/repositories/thread-agent-tool-policy-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { SavedAgentRepository } from "../db/repositories/saved-agent-repository.js";
import type { SavedAgentService } from "../domain/saved-agent-service.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import {
  requireAdmittedResource,
  type TrustedEnvironmentAuthorityGrant,
} from "../agent-tools/environment/environment-authority.js";
import type { ToolInitiator } from "../agent-tools/contracts/tool-initiator.js";
import type { ExecutionWorkspaceSelection } from "../../shared/protocol/conversation.js";
import type { ConversationCreationTransaction } from "../backends/saved-agent-adapter.js";
import type { ResolvedLifecycleTarget } from "../conversations/conversation-lifecycle-service.js";

type Candidate = {
  readonly target: SavedAgentTargetDescriptor;
  readonly adapter: SavedAgentBackendAdapter;
  readonly connectionProfileId: string;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
};

type ResolvedCandidate = Candidate & {
  readonly preview: SavedAgentResolutionCandidate;
  readonly backendConfiguration: ResolvedSavedAgentBackendConfiguration;
  readonly toolPolicy: ResolvedAgentToolBootstrapPolicy;
  readonly profileRevision: number;
  readonly profileFingerprint: string;
  readonly backendRevision: number;
  readonly backendFingerprint: string;
  readonly workspaceRevision: number;
  readonly workspaceAuthorityRevision: number;
};

type PreparedCandidate = Candidate & {
  readonly profile: ConnectionProfileRecord;
  readonly backend: BackendInstanceRecord;
  readonly context: SavedAgentBackendContextInput;
  readonly canonical: CanonicalSavedAgentBackendOverrides;
  readonly prepared: PreparedSavedAgentBackendContext;
  readonly preview: SavedAgentResolutionCandidate;
  readonly workspaceRevision: number;
  readonly workspaceAuthorityRevision: number;
};

export type SavedAgentCreationCallerContext =
  | { readonly kind: "http_ui" }
  | {
      readonly kind: "agent_tool";
      readonly initiator: ToolInitiator;
      readonly mutationId: string;
      readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
    };

/**
 * Server-derived template fields plus the exact durable fences that were used
 * while resolving them. The labels are presentation snapshots only; ids remain
 * the authority for every later validation and thread creation.
 */
export interface PreparedThreadTemplateSelection {
  readonly workspaceId: string;
  readonly targetId: string;
  readonly executionWorkspace: ExecutionWorkspaceSelection;
  readonly agentId: string;
  readonly capturedAgentName: string;
  readonly capturedWorkspaceName: string;
  readonly capturedTargetName: string;
  readonly assertDurableFences: () => void;
}

export interface ThreadExecutionWorkspaceAllocator {
  assertAvailable(input: {
    readonly backendInstanceId: string;
    readonly executionEnvironmentId: string;
    readonly networkProfile: "isolated" | "execution_host";
  }): void;
  selection(
    scope: RequestScope,
    applicationThreadId: string,
  ): ExecutionWorkspaceSelection;
  reserve(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly executionEnvironmentId: string;
      readonly sourceWorkspaceId: string;
    readonly sourceCanonicalPath: string;
    readonly workspaceAccess: "writable_clone" | "read_only";
    readonly networkProfile: "isolated" | "execution_host";
    },
  ): unknown;
}

export const directThreadExecutionWorkspaceAllocator: ThreadExecutionWorkspaceAllocator =
  Object.freeze({
    assertAvailable: () => {
      throw new DomainError(
        "runtime_unavailable",
        "Isolated workspace execution is unavailable.",
        true,
      );
    },
    selection: () => ({ kind: "direct" as const }),
    reserve: () => {
      throw new DomainError(
        "runtime_unavailable",
        "Isolated workspace execution is unavailable.",
        true,
      );
    },
  });

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameToolPolicy(
  left: ThreadAgentToolPolicyRecord,
  right: ThreadAgentToolPolicyRecord,
): boolean {
  return (
    left.revision === right.revision &&
    left.enabled === right.enabled &&
    left.presentation.surface === right.presentation.surface &&
    left.presentation.mode === right.presentation.mode &&
    left.accessBoundary ===
      right.accessBoundary &&
    left.enabledToolIds.length === right.enabledToolIds.length &&
    left.enabledToolIds.every(
      (toolId, index) => toolId === right.enabledToolIds[index],
    )
  );
}

export class SavedAgentApplicationService {
  constructor(
    readonly input: {
      readonly environmentVariables?: EnvironmentVariablesService;
      readonly agents: SavedAgentService;
      readonly repository: SavedAgentRepository;
      readonly adapters: SavedAgentBackendAdapterRegistry;
      readonly configuration: BackendConfigurationRepository;
      readonly inventory: InventoryRepository;
      readonly targets: DatabaseConversationTargetStore;
      readonly targetHealth: ExecutionTargetReader;
      readonly registry: AgentBackendRegistry;
      readonly lifecycle: ConversationLifecycleService;
      readonly toolPolicies: ThreadAgentToolPolicyRepository;
      readonly toolEligibility: ThreadAgentToolEligibilityPolicy;
      readonly toolCatalog: ThreadAgentToolCatalogReader;
      readonly executionWorkspaces: ThreadExecutionWorkspaceAllocator;
      readonly publications: {
        handoffThreadChange(scope: RequestScope, threadId: string): void;
      };
      readonly now?: () => number;
    },
  ) {
    if (
      input.repository.database !== input.toolPolicies.database ||
      input.repository.database !== input.configuration.database ||
      input.repository.database !== input.inventory.database
    ) {
      throw new Error("saved_agent_application_database_mismatch");
    }
  }

  list(
    scope: RequestScope,
    input: Parameters<SavedAgentService["list"]>[1] & {
      readonly targetId?: string;
    } = {},
  ) {
    const { targetId, ...filters } = input;
    if (!targetId) return this.input.agents.list(scope, filters);
    const profile = this.input.configuration.getProfile(scope, targetId);
    const adapter = this.input.adapters.requireByBackendInstanceId(
      profile.backendInstanceId,
    );
    return this.input.agents.list(scope, {
      ...filters,
      backendTypeId: adapter.typeId,
    });
  }

  get(scope: RequestScope, agentId: string): SavedAgent {
    return this.input.agents.get(scope, agentId);
  }

  async createAgent(
    scope: RequestScope,
    request: CreateSavedAgentRequest,
    signal?: AbortSignal,
  ): Promise<SavedAgent> {
    return this.#createAgent(scope, request, signal);
  }

  async createAgentForAgentTool(
    scope: RequestScope,
    request: CreateSavedAgentRequest,
    signal: AbortSignal | undefined,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
  ): Promise<SavedAgent> {
    this.#requireAgentDestination(
      scope,
      request.authoringContext.workspaceId,
      environmentAuthority,
    );
    return this.#createAgent(scope, request, signal);
  }

  async #createAgent(
    scope: RequestScope,
    request: CreateSavedAgentRequest,
    signal?: AbortSignal,
  ): Promise<SavedAgent> {
    const resolved = await this.#resolveTarget(
      scope,
      request.authoringContext.workspaceId,
      request.authoringContext.targetId,
      request.backendOverrides,
      request.sedesTools,
      signal,
    );
    return this.input.agents.create(scope, {
      name: request.name,
      ...(request.description === undefined
        ? {}
        : { description: request.description }),
      backendTypeId: resolved.adapter.typeId,
      environmentVariables: request.environmentVariables,
      backendOverrides: resolved.preview.configuration.canonicalOverrides,
      ...(request.sedesTools === undefined
        ? {}
        : { sedesTools: request.sedesTools }),
    });
  }

  async updateAgent(
    scope: RequestScope,
    agentId: string,
    request: UpdateSavedAgentRequest,
    signal?: AbortSignal,
  ): Promise<SavedAgent> {
    return this.#updateAgent(scope, agentId, request, signal);
  }

  async updateAgentForAgentTool(
    scope: RequestScope,
    agentId: string,
    request: UpdateSavedAgentRequest,
    signal: AbortSignal | undefined,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
  ): Promise<SavedAgent> {
    if (request.authoringContext) {
      this.#requireAgentDestination(
        scope,
        request.authoringContext.workspaceId,
        environmentAuthority,
      );
    }
    return this.#updateAgent(scope, agentId, request, signal);
  }

  async #updateAgent(
    scope: RequestScope,
    agentId: string,
    request: UpdateSavedAgentRequest,
    signal?: AbortSignal,
  ): Promise<SavedAgent> {
    const current = this.input.agents.get(scope, agentId);
    if (request.authoringContext) {
      const resolved = await this.#resolveTarget(
        scope,
        request.authoringContext.workspaceId,
        request.authoringContext.targetId,
        request.backendOverrides ?? current.backendOverrides,
        request.sedesTools === null
          ? undefined
          : (request.sedesTools ?? current.sedesTools),
        signal,
      );
      if (resolved.adapter.typeId !== current.backendTypeId) {
        throw new DomainError(
          "conflict",
          "The authoring target uses a different Saved Agent backend type.",
        );
      }
    }
    return this.input.agents.update(scope, agentId, {
      expectedRevision: request.expectedRevision,
      environmentVariables: request.environmentVariables,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.description === undefined
        ? {}
        : { description: request.description }),
      ...(request.backendOverrides === undefined
        ? {}
        : { backendOverrides: request.backendOverrides }),
      ...(request.sedesTools === undefined
        ? {}
        : { sedesTools: request.sedesTools }),
    });
  }

  deleteAgent(scope: RequestScope, agentId: string, expectedRevision: number) {
    return this.input.agents.delete(scope, agentId, expectedRevision);
  }

  async options(
    scope: RequestScope,
    request: SavedAgentOptionsRequest,
    signal?: AbortSignal,
  ): Promise<SavedAgentOptionsResult> {
    return this.#options(scope, request, signal);
  }

  async optionsForAgentTool(
    scope: RequestScope,
    request: SavedAgentOptionsRequest,
    signal: AbortSignal | undefined,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
  ): Promise<SavedAgentOptionsResult> {
    this.#requireAgentDestination(
      scope,
      request.workspaceId,
      environmentAuthority,
    );
    return this.#options(scope, request, signal);
  }

  async #options(
    scope: RequestScope,
    request: SavedAgentOptionsRequest,
    signal?: AbortSignal,
  ): Promise<SavedAgentOptionsResult> {
    if (!request.targetId) {
      const candidates = await this.#candidates(
        scope,
        request.workspaceId,
        undefined,
        signal,
      );
      return savedAgentOptionsResultSchema.parse({
        kind: "targets",
        targets: candidates.map(({ target }) => target),
      });
    }
    const preview = await this.#previewTarget(
      scope,
      request.workspaceId,
      request.targetId,
      request.overrides ?? [],
      request.sedesTools,
      signal,
    );
    return savedAgentOptionsResultSchema.parse({
      kind: "configuration",
      ...preview,
    });
  }

  async resolveAgent(
    scope: RequestScope,
    agentId: string,
    request: ResolveSavedAgentRequest,
    signal?: AbortSignal,
  ): Promise<ResolveSavedAgentResult> {
    const agent = this.input.agents.get(scope, agentId);
    const candidates = await this.#candidates(
      scope,
      request.workspaceId,
      agent.backendTypeId,
      signal,
      false,
    );
    const selected = request.targetId
      ? candidates.filter(
          ({ connectionProfileId }) => connectionProfileId === request.targetId,
        )
      : candidates;
    if (request.targetId && selected.length === 0) {
      throw new DomainError(
        "not_found",
        "The selected Saved Agent target was not found in this workspace.",
      );
    }
    const results = await Promise.all(
      selected.map(async (candidate) => {
        try {
          return {
            status: "resolved" as const,
            value: await this.#materialize(
              scope,
              request.workspaceId,
              candidate,
              agent.backendOverrides,
              agent.sedesTools,
              signal,
            ),
          };
        } catch (error) {
          throwIfAborted(signal);
          return {
            status: "failed" as const,
            target: candidate.target,
            reason: this.#failureReason(error),
          };
        }
      }),
    );
    return resolveSavedAgentResultSchema.parse({
      candidates: results.flatMap((result) =>
        result.status === "resolved" ? [result.value.preview] : [],
      ),
      failures: results.flatMap((result) =>
        result.status === "failed"
          ? [{ target: result.target, reason: boundDisplayText(result.reason) }]
          : [],
      ),
    });
  }

  async prepareThreadTemplateSelection(
    scope: RequestScope,
    input: {
      readonly workspaceId: string;
      readonly targetId: string;
      readonly executionWorkspace: ExecutionWorkspaceSelection;
      readonly agentId: string;
    },
    signal?: AbortSignal,
  ): Promise<PreparedThreadTemplateSelection> {
    const agent = this.input.agents.get(scope, input.agentId);
    const resolved = await this.#resolveTarget(
      scope,
      input.workspaceId,
      input.targetId,
      agent.backendOverrides,
      agent.sedesTools,
      signal,
    );
    if (resolved.adapter.typeId !== agent.backendTypeId) {
      throw new DomainError(
        "conflict",
        "The template target uses a different Saved Agent backend type.",
      );
    }
    throwIfAborted(signal);
    this.#executionWorkspaceInitialization(
      scope,
      input.workspaceId,
      input.targetId,
      input.executionWorkspace,
    );
    const workspace = this.input.inventory.getWorkspace(
      scope,
      input.workspaceId,
    );
    const agentRevision = agent.revision;
    return {
      workspaceId: input.workspaceId,
      targetId: resolved.connectionProfileId,
      executionWorkspace: input.executionWorkspace,
      agentId: agent.id,
      capturedAgentName: agent.name,
      capturedWorkspaceName: workspace.displayName,
      capturedTargetName: resolved.target.label.text,
      assertDurableFences: () => {
        this.#assertCandidateFences(scope, input.workspaceId, resolved);
        this.input.repository.assertRevision(scope, agent.id, agentRevision);
        this.#executionWorkspaceInitialization(
          scope,
          input.workspaceId,
          input.targetId,
          input.executionWorkspace,
        );
      },
    };
  }

  async createThread(
    scope: RequestScope,
    request: CreateThreadRequest,
    caller: SavedAgentCreationCallerContext,
    signal?: AbortSignal,
  ): Promise<CreateThreadResult> {
    if (caller.kind === "agent_tool" && caller.initiator.kind === "thread_agent") {
      const source = this.input.inventory.getThread(
        scope,
        caller.initiator.sourceThreadId,
      ).thread;
      const sourceWorkspace = this.input.inventory.getWorkspace(
        scope,
        caller.initiator.sourceWorkspaceId,
      );
      if (
        source.workspaceId !== caller.initiator.sourceWorkspaceId ||
        sourceWorkspace?.environmentId !==
          caller.environmentAuthority.defaults.environmentId
      ) {
        throw new DomainError(
          "conflict",
          "The trusted agent caller context does not match its source thread.",
        );
      }
      this.#requireAgentDestination(
        scope,
        request.workspaceId,
        caller.environmentAuthority,
      );
    }
    if (
      request.configuration.kind === "custom" &&
      request.configuration.backendOverrides === undefined &&
      request.configuration.sedesTools === undefined
    ) {
      this.#assertSimpleTargetDestination(scope, request, caller);
      if (this.input.targetHealth.requireAgentSelectable) {
        await this.input.targetHealth.requireAgentSelectable(
          scope,
          request.configuration.targetId,
          signal,
        );
      } else {
        await this.input.targetHealth.requireSelectable(
          scope,
          request.configuration.targetId,
        );
      }
      throwIfAborted(signal);
      this.#assertSimpleTargetDestination(scope, request, caller);
      const created = await this.input.lifecycle.createServerDraft(
        scope,
        {
          workspaceId: request.workspaceId,
          connectionProfileId: request.configuration.targetId,
          title: request.title,
          environmentVariables: this.input.environmentVariables?.prepare(scope, request.configuration.targetId, { overrides: request.environmentVariables, expectedRevision: request.environmentVariablesRevision }),
          ...(caller.kind === "agent_tool"
            ? {
                toolCreationOrigin: {
                  initiator: caller.initiator,
                  mutationId: caller.mutationId,
                },
              }
            : {}),
          ...this.#executionWorkspaceInitialization(
            scope,
            request.workspaceId,
            request.configuration.targetId,
            request.executionWorkspace,
          ),
        },
        signal,
      );
      this.input.publications.handoffThreadChange(
        scope,
        created.applicationThreadId,
      );
      return {
        threadId: created.applicationThreadId,
        workspaceId: request.workspaceId,
        targetId: request.configuration.targetId,
      };
    }
    let agentRevision:
      { readonly id: string; readonly revision: number; readonly name: string }
      | undefined;
    let initializeTools = false;
    let resolved: ResolvedCandidate;
    if (request.configuration.kind === "saved_agent") {
      const agent = this.input.agents.get(scope, request.configuration.agentId);
      agentRevision = {
        id: agent.id,
        revision: agent.revision,
        name: agent.name,
      };
      initializeTools = agent.sedesTools !== undefined;
      const candidates = await this.#candidates(
        scope,
        request.workspaceId,
        agent.backendTypeId,
        signal,
        false,
      );
      const selected = request.configuration.targetId
        ? candidates.filter(
            ({ connectionProfileId }) =>
              connectionProfileId === request.configuration.targetId,
          )
        : candidates;
      if (request.configuration.targetId && selected.length === 0) {
        throw new DomainError(
          "not_found",
          "The selected Saved Agent target was not found in this workspace.",
        );
      }
      if (request.configuration.targetId) {
        resolved = await this.#materialize(
          scope,
          request.workspaceId,
          selected[0]!,
          agent.backendOverrides,
          agent.sedesTools,
          signal,
        );
      } else {
        const compatible = (
          await Promise.all(
            selected.map(async (candidate) => {
              try {
                return await this.#materialize(
                  scope,
                  request.workspaceId,
                  candidate,
                  agent.backendOverrides,
                  agent.sedesTools,
                  signal,
                );
              } catch {
                throwIfAborted(signal);
                return undefined;
              }
            }),
          )
        ).filter(
          (candidate): candidate is ResolvedCandidate =>
            candidate !== undefined,
        );
        if (compatible.length === 0) {
          throw new DomainError(
            "runtime_unavailable",
            "No compatible Saved Agent target is available in this workspace.",
            true,
          );
        }
        if (compatible.length > 1) {
          const choices = compatible
            .slice(0, 2)
            .map(
              ({ target, connectionProfileId }) =>
                `${Array.from(target.label.text).slice(0, 24).join("")} (${connectionProfileId})`,
            );
          throw new DomainError(
            "conflict",
            `Multiple compatible targets are available: ${choices.join(", ")}${
              compatible.length > choices.length ? ", …" : ""
            }. Use Saved Agent resolution and select one target explicitly.`,
          );
        }
        resolved = compatible[0]!;
      }
    } else {
      initializeTools = request.configuration.sedesTools !== undefined;
      resolved = await this.#resolveTarget(
        scope,
        request.workspaceId,
        request.configuration.targetId,
        request.configuration.backendOverrides ?? [],
        request.configuration.sedesTools,
        signal,
      );
    }
    throwIfAborted(signal);
    if (caller.kind === "agent_tool") {
      this.#requireAgentDestination(
        scope,
        request.workspaceId,
        caller.environmentAuthority,
      );
    }
    const created = await this.input.lifecycle.createServerDraft(
      scope,
      {
        workspaceId: request.workspaceId,
        connectionProfileId: resolved.connectionProfileId,
        title: request.title,
        environmentVariables: this.input.environmentVariables?.prepare(scope, resolved.connectionProfileId, { overrides: request.environmentVariables, expectedRevision: request.environmentVariablesRevision, ...(agentRevision ? { agentId: agentRevision.id } : {}) }),
        ...(agentRevision
          ? {
              savedAgentOrigin: {
                agentId: agentRevision.id,
                agentRevision: agentRevision.revision,
                agentName: agentRevision.name,
              },
            }
          : {}),
        ...(caller.kind === "agent_tool"
          ? {
              toolCreationOrigin: {
                initiator: caller.initiator,
                mutationId: caller.mutationId,
              },
            }
          : {}),
        ...this.#executionWorkspaceInitialization(
          scope,
          request.workspaceId,
          resolved.connectionProfileId,
          request.executionWorkspace,
        ),
        bootstrap: {
          backendAdapter: resolved.adapter,
          backendConfiguration: resolved.backendConfiguration,
          assertDurableFences: (transaction) => {
            transaction.assertActive();
            if (caller.kind === "agent_tool") {
              this.#requireAgentDestination(
                scope,
                request.workspaceId,
                caller.environmentAuthority,
              );
            }
            this.#assertCandidateFences(scope, request.workspaceId, resolved);
            if (agentRevision) {
              this.input.repository.assertRevision(
                scope,
                agentRevision.id,
                agentRevision.revision,
              );
            }
          },
          ...(initializeTools
            ? {
                initializeAgentTools: ({
                  transaction,
                  applicationThreadId,
                  now,
                }) => {
                  transaction.assertActive();
                  this.input.toolPolicies.initialize(
                    scope,
                    applicationThreadId,
                    { ...resolved.toolPolicy, now },
                  );
                },
              }
            : {}),
        },
      },
      signal,
    );
    this.input.publications.handoffThreadChange(
      scope,
      created.applicationThreadId,
    );
    return {
      threadId: created.applicationThreadId,
      workspaceId: request.workspaceId,
      targetId: resolved.connectionProfileId,
    };
  }

  async createThreadFromSettings(
    scope: RequestScope,
    sourceApplicationThreadId: string,
    request: CreateThreadFromSettingsRequest,
    signal?: AbortSignal,
  ): Promise<CreateThreadResult> {
    const receiptInput = {
      sourceApplicationThreadId,
      title: request.title,
      mutationId: request.mutationId,
    };
    const replay = this.input.lifecycle.findThreadConfigurationCopy(
      scope,
      receiptInput,
    );
    if (replay) {
      this.input.publications.handoffThreadChange(
        scope,
        replay.applicationThreadId,
      );
      return {
        threadId: replay.applicationThreadId,
        workspaceId: replay.workspaceId,
        targetId: replay.targetId,
      };
    }

    const source = this.input.inventory.getThread(
      scope,
      sourceApplicationThreadId,
    );
    if (source.thread.availability !== "available") {
      throw new DomainError(
        "invalid_transition",
        "Only an available thread can supply settings for a new thread.",
      );
    }
    const candidates = await this.#candidates(
      scope,
      source.thread.workspaceId,
      undefined,
      signal,
      false,
    );
    const candidate = candidates.find(
      ({ connectionProfileId, backendInstanceId, executionEnvironmentId }) =>
        connectionProfileId === source.thread.connectionProfileId &&
        backendInstanceId === source.thread.backendInstanceId &&
        executionEnvironmentId === source.thread.environmentId,
    );
    if (!candidate) {
      throw new DomainError(
        "runtime_unavailable",
        "The source thread target is no longer available.",
        true,
      );
    }
    const profile = this.input.configuration.getProfile(
      scope,
      source.thread.connectionProfileId,
    );
    const connection = {
      ...profile,
      enabled: profile.enabled === 1,
    };
    const capturedBackend = candidate.adapter.captureThreadConfiguration({
      scope,
      applicationThreadId: sourceApplicationThreadId,
      connection,
    });
    if (
      capturedBackend.backendTypeId !== candidate.adapter.typeId ||
      capturedBackend.schemaVersion !== candidate.adapter.overrideSchemaVersion
    ) {
      throw new Error("thread_configuration_capture_result_invalid");
    }
    const capturedTools = this.input.toolPolicies.getDurable(
      scope,
      sourceApplicationThreadId,
    );
    const environment = this.input.inventory.getEnvironment(
      scope,
      source.thread.environmentId,
    );
    const presentationOptions = this.input.toolEligibility.presentationOptions(
      candidate.adapter.backendKind,
      environment.kind,
    );
    const sedesTools: AgentToolBootstrapPolicy = {
      enabled: capturedTools.enabled,
      enabledToolIds: [...capturedTools.enabledToolIds],
      presentation: capturedTools.presentation,
      accessBoundary: capturedTools.accessBoundary,
    };
    const resolved = await this.#materialize(
      scope,
      source.thread.workspaceId,
      candidate,
      capturedBackend.overrides,
      sedesTools,
      signal,
    );
    throwIfAborted(signal);
    const executionWorkspace = this.input.executionWorkspaces.selection(
      scope,
      sourceApplicationThreadId,
    );
    const created = await this.input.lifecycle.createServerDraft(
      scope,
      {
        workspaceId: source.thread.workspaceId,
        connectionProfileId: source.thread.connectionProfileId,
        title: request.title,
        environmentVariables: this.input.environmentVariables ? { snapshot: this.input.environmentVariables.get(scope, sourceApplicationThreadId), assertCurrent() {} } : undefined,
        configurationCopy: {
          sourceApplicationThreadId,
          mutationId: request.mutationId,
        },
        ...this.#executionWorkspaceInitialization(
          scope,
          source.thread.workspaceId,
          source.thread.connectionProfileId,
          executionWorkspace,
        ),
        bootstrap: {
          backendAdapter: resolved.adapter,
          backendConfiguration: resolved.backendConfiguration,
          assertDurableFences: (transaction) => {
            transaction.assertActive();
            this.#assertCandidateFences(
              scope,
              source.thread.workspaceId,
              resolved,
            );
            const currentSource = this.input.inventory.getThread(
              scope,
              sourceApplicationThreadId,
            ).thread;
            if (
              currentSource.availability !== "available" ||
              currentSource.workspaceId !== source.thread.workspaceId ||
              currentSource.environmentId !== source.thread.environmentId ||
              currentSource.backendInstanceId !==
                source.thread.backendInstanceId ||
              currentSource.connectionProfileId !==
                source.thread.connectionProfileId
            ) {
              throw new DomainError(
                "conflict",
                "The source thread target changed while the new thread was created.",
              );
            }
            resolved.adapter.assertThreadConfigurationCapture({
              transaction,
              scope,
              applicationThreadId: sourceApplicationThreadId,
              connection,
              capture: capturedBackend,
            });
            const currentTools = this.input.toolPolicies.getDurable(
              scope,
              sourceApplicationThreadId,
            );
            if (!sameToolPolicy(currentTools, capturedTools)) {
              throw new DomainError(
                "conflict",
                "The source Sedes tool policy changed while the new thread was created.",
              );
            }
          },
          initializeAgentTools: ({ transaction, applicationThreadId, now }) => {
            transaction.assertActive();
            this.input.toolPolicies.initialize(scope, applicationThreadId, {
              ...resolved.toolPolicy,
              now,
            });
          },
        },
      },
      signal,
    );
    const completed = this.input.lifecycle.findThreadConfigurationCopy(
      scope,
      receiptInput,
    );
    if (
      !completed ||
      completed.applicationThreadId !== created.applicationThreadId
    ) {
      throw new Error("thread_configuration_copy_receipt_missing");
    }
    this.input.publications.handoffThreadChange(
      scope,
      completed.applicationThreadId,
    );
    return {
      threadId: completed.applicationThreadId,
      workspaceId: completed.workspaceId,
      targetId: completed.targetId,
    };
  }

  async #resolveTarget(
    scope: RequestScope,
    workspaceId: string,
    targetId: string,
    overrides: NormalizedAgentConfigurationOverrides,
    sedesTools: AgentToolBootstrapPolicy | undefined,
    signal?: AbortSignal,
  ): Promise<ResolvedCandidate> {
    const candidates = await this.#candidates(
      scope,
      workspaceId,
      undefined,
      signal,
      false,
    );
    const candidate = candidates.find(
      ({ connectionProfileId }) => connectionProfileId === targetId,
    );
    if (!candidate) {
      throw new DomainError(
        "not_found",
        "The selected Saved Agent target was not found in this workspace.",
      );
    }
    return this.#materialize(
      scope,
      workspaceId,
      candidate,
      overrides,
      sedesTools,
      signal,
    );
  }

  async #previewTarget(
    scope: RequestScope,
    workspaceId: string,
    targetId: string,
    overrides: NormalizedAgentConfigurationOverrides,
    sedesTools: AgentToolBootstrapPolicy | undefined,
    signal?: AbortSignal,
  ): Promise<SavedAgentResolutionCandidate> {
    const candidates = await this.#candidates(
      scope,
      workspaceId,
      undefined,
      signal,
      false,
    );
    const candidate = candidates.find(
      ({ connectionProfileId }) => connectionProfileId === targetId,
    );
    if (!candidate) {
      throw new DomainError(
        "not_found",
        "The selected Saved Agent target was not found in this workspace.",
      );
    }
    return (
      await this.#prepareCandidate(
        scope,
        workspaceId,
        candidate,
        overrides,
        sedesTools,
        signal,
      )
    ).preview;
  }

  async #candidates(
    scope: RequestScope,
    workspaceId: string,
    backendTypeId: SavedAgent["backendTypeId"] | undefined,
    signal?: AbortSignal,
    requireHealthy = true,
  ): Promise<Candidate[]> {
    throwIfAborted(signal);
    const workspace = this.input.inventory.getWorkspace(scope, workspaceId);
    const candidates = this.input.configuration
      .listProfiles(scope)
      .flatMap((profile) => {
        const backend = this.input.configuration.getBackend(
          scope,
          profile.backendInstanceId,
        );
        const adapter = this.input.adapters.findByBackendInstanceId(backend.id);
        if (
          profile.enabled !== 1 ||
          backend.enabled !== 1 ||
          profile.executionEnvironmentId !== workspace.environmentId ||
          !adapter ||
          (backendTypeId !== undefined && adapter.typeId !== backendTypeId)
        ) {
          return [];
        }
        return [
          {
            target: {
              id: profile.id,
              label: boundDisplayText(profile.label),
              backend: adapter.presentation,
            },
            adapter,
            connectionProfileId: profile.id,
            backendInstanceId: backend.id,
            executionEnvironmentId: profile.executionEnvironmentId,
          } satisfies Candidate,
        ];
      });
    if (!requireHealthy) {
      return candidates.sort(
        (left, right) =>
          compareCodePoints(left.target.label.text, right.target.label.text) ||
          compareCodePoints(
            left.connectionProfileId,
            right.connectionProfileId,
          ),
      );
    }
    const healthy = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          if (this.input.targetHealth.requireAgentSelectable) {
            await this.input.targetHealth.requireAgentSelectable(
              scope,
              candidate.connectionProfileId,
              signal,
            );
          } else {
            await this.input.targetHealth.requireSelectable(
              scope,
              candidate.connectionProfileId,
            );
          }
          throwIfAborted(signal);
          return candidate;
        } catch {
          throwIfAborted(signal);
          return undefined;
        }
      }),
    );
    return healthy
      .filter((candidate): candidate is Candidate => candidate !== undefined)
      .sort(
        (left, right) =>
          compareCodePoints(left.target.label.text, right.target.label.text) ||
          compareCodePoints(
            left.connectionProfileId,
            right.connectionProfileId,
          ),
      );
  }

  async #materialize(
    scope: RequestScope,
    workspaceId: string,
    candidate: Candidate,
    overrides: NormalizedAgentConfigurationOverrides,
    sedesTools: AgentToolBootstrapPolicy | null | undefined,
    signal?: AbortSignal,
  ): Promise<ResolvedCandidate> {
    const preparedCandidate = await this.#prepareCandidate(
      scope,
      workspaceId,
      candidate,
      overrides,
      sedesTools,
      signal,
    );
    const backendConfiguration = candidate.adapter.resolve({
      ...preparedCandidate.context,
      prepared: preparedCandidate.prepared,
      overrides: preparedCandidate.canonical,
    });
    if (
      backendConfiguration.backendTypeId !== candidate.adapter.typeId ||
      backendConfiguration.schemaVersion !==
        candidate.adapter.overrideSchemaVersion
    ) {
      throw new Error("saved_agent_backend_resolution_result_invalid");
    }
    return {
      ...candidate,
      preview: preparedCandidate.preview,
      backendConfiguration,
      toolPolicy: preparedCandidate.preview.sedesTools.resolvedPolicy,
      profileRevision: preparedCandidate.profile.configurationRevision,
      profileFingerprint: preparedCandidate.profile.configurationFingerprint,
      backendRevision: preparedCandidate.backend.configurationRevision,
      backendFingerprint: preparedCandidate.backend.configurationFingerprint,
      workspaceRevision: preparedCandidate.workspaceRevision,
      workspaceAuthorityRevision: preparedCandidate.workspaceAuthorityRevision,
    };
  }

  async #prepareCandidate(
    scope: RequestScope,
    workspaceId: string,
    candidate: Candidate,
    overrides: NormalizedAgentConfigurationOverrides,
    sedesTools: AgentToolBootstrapPolicy | null | undefined,
    signal?: AbortSignal,
  ): Promise<PreparedCandidate> {
    throwIfAborted(signal);
    if (this.input.targetHealth.requireAgentSelectable) {
      await this.input.targetHealth.requireAgentSelectable(
        scope,
        candidate.connectionProfileId,
        signal,
      );
    } else {
      await this.input.targetHealth.requireSelectable(
        scope,
        candidate.connectionProfileId,
      );
    }
    throwIfAborted(signal);
    const profile = this.input.configuration.getProfile(
      scope,
      candidate.connectionProfileId,
    );
    const backend = this.input.configuration.getBackend(
      scope,
      candidate.backendInstanceId,
    );
    const resolvedTarget = await this.input.targets.lifecycle(scope, {
      connectionProfileId: candidate.connectionProfileId,
      workspaceId,
      signal,
    });
    throwIfAborted(signal);
    let catalog;
    try {
      catalog = await this.input.registry
        .driver(resolvedTarget.connection)
        .catalog({ scope, workspace: resolvedTarget.workspace });
    } catch (cause) {
      throwIfAborted(signal);
      throw new DomainError(
        "runtime_unavailable",
        "The Saved Agent target catalog is not currently available.",
        true,
        { cause },
      );
    }
    throwIfAborted(signal);
    const canonical = candidate.adapter.validateOverrides({ overrides });
    if (
      canonical.backendTypeId !== candidate.adapter.typeId ||
      canonical.schemaVersion !== candidate.adapter.overrideSchemaVersion
    ) {
      throw new Error("saved_agent_backend_validation_result_invalid");
    }
    const context = {
      scope,
      workspace: resolvedTarget.workspace,
      connection: resolvedTarget.connection,
      catalog,
    };
    const prepared = candidate.adapter.prepareResolutionContext(context);
    if (
      prepared.backendTypeId !== candidate.adapter.typeId ||
      prepared.schemaVersion !== candidate.adapter.overrideSchemaVersion
    ) {
      throw new Error("saved_agent_backend_prepared_context_invalid");
    }
    const configuration = candidate.adapter.describeEditor({
      ...context,
      prepared,
      overrides: canonical,
    });
    if (configuration.backendTypeId !== candidate.adapter.typeId) {
      throw new Error("saved_agent_backend_editor_result_invalid");
    }
    const sedesToolsDescriptor = this.#toolDescriptor(
      backend.kind,
      this.input.inventory.getEnvironment(
        context.scope,
        context.workspace.summary.environmentId,
      ).kind,
      sedesTools ?? undefined,
    );
    return {
      ...candidate,
      profile,
      backend,
      context,
      canonical,
      prepared,
      preview: {
        target: candidate.target,
        configuration,
        sedesTools: sedesToolsDescriptor,
      },
      workspaceRevision: resolvedTarget.workspace.summary.revision,
      workspaceAuthorityRevision: resolvedTarget.workspace.authorityRevision,
    };
  }

  #toolDescriptor(
    backendKind: Parameters<
      ThreadAgentToolEligibilityPolicy["presentationOptions"]
    >[0],
    environmentKind: Parameters<
      ThreadAgentToolEligibilityPolicy["presentationOptions"]
    >[1],
    requested: AgentToolBootstrapPolicy | undefined,
  ): AgentToolBootstrapDescriptor {
    const presentationOptions = this.input.toolEligibility.presentationOptions(
      backendKind,
      environmentKind,
    );
    const defaultPresentationOption = presentationOptions[0];
    const defaultPresentationMode = defaultPresentationOption?.modes[0];
    if (!defaultPresentationOption || !defaultPresentationMode) {
      throw new Error("saved_agent_tool_presentation_options_invalid");
    }
    const defaultPolicy: ResolvedAgentToolBootstrapPolicy = {
      enabled: false,
      enabledToolIds: [],
      presentation: {
        surface: defaultPresentationOption.surface,
        mode: defaultPresentationMode,
      },
      accessBoundary: "environment",
    };
    let resolvedPolicy = defaultPolicy;
    if (requested) {
      for (const id of requested.enabledToolIds) {
        if (!this.input.toolEligibility.eligibleToolIds.has(id)) {
          throw new DomainError(
            "invalid_transition",
            `Sedes tool "${id}" is not available for Saved Agents.`,
          );
        }
      }
      resolvedPolicy = {
        enabled: requested.enabled,
        enabledToolIds: [...requested.enabledToolIds].sort(compareCodePoints),
        presentation: requested.presentation,
        accessBoundary: requested.accessBoundary,
      };
      if (
        !presentationOptions.some(
          ({ surface, modes }) =>
            surface === resolvedPolicy.presentation.surface &&
            modes.includes(resolvedPolicy.presentation.mode),
        )
      ) {
        throw new DomainError(
          "invalid_transition",
          "This Sedes tool presentation mode is unavailable for the selected target.",
        );
      }
    }
    const enabled = new Set(resolvedPolicy.enabledToolIds);
    const groups = this.input.toolCatalog.list().groups.map((group) => ({
      id: group.id,
      label: boundDisplayText(group.label),
      description: boundDisplayText(group.description),
      order: group.order,
      tools: group.tools.map((tool) => ({
        id: tool.id,
        label: boundDisplayText(tool.label),
        ...(tool.description
          ? { description: boundDisplayText(tool.description) }
          : {}),
        order: tool.order,
        effects: tool.effects,
        enabled: enabled.has(tool.id),
        available: tool.available,
        ...(tool.unavailableReason
          ? { unavailableReason: boundDisplayText(tool.unavailableReason) }
          : {}),
      })),
    }));
    return agentToolBootstrapDescriptorSchema.parse({
      defaultPolicy,
      resolvedPolicy,
      groups,
      presentationOptions,
    });
  }

  #assertCandidateFences(
    scope: RequestScope,
    workspaceId: string,
    resolved: ResolvedCandidate,
  ): void {
    this.input.inventory.assertWorkspaceActive(scope, workspaceId);
    const profile = this.input.configuration.getProfile(
      scope,
      resolved.connectionProfileId,
    );
    const backend = this.input.configuration.getBackend(
      scope,
      resolved.backendInstanceId,
    );
    const workspace = this.input.inventory.getWorkspace(scope, workspaceId);
    if (
      profile.enabled !== 1 ||
      profile.backendInstanceId !== resolved.backendInstanceId ||
      profile.executionEnvironmentId !== resolved.executionEnvironmentId ||
      profile.configurationRevision !== resolved.profileRevision ||
      profile.configurationFingerprint !== resolved.profileFingerprint ||
      backend.enabled !== 1 ||
      backend.configurationRevision !== resolved.backendRevision ||
      backend.configurationFingerprint !== resolved.backendFingerprint ||
      workspace.environmentId !== resolved.executionEnvironmentId ||
      workspace.revision !== resolved.workspaceRevision ||
      workspace.environmentConfigurationRevision !==
        resolved.workspaceAuthorityRevision
    ) {
      throw new DomainError(
        "conflict",
        "The Saved Agent target changed while the thread was created.",
      );
    }
  }

  #requireAgentDestination(
    scope: RequestScope,
    workspaceId: string,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
  ): void {
    this.input.inventory.assertWorkspaceActive(scope, workspaceId);
    const workspace = this.input.inventory.getWorkspace(scope, workspaceId);
    requireAdmittedResource(environmentAuthority, {
      kind: "workspace",
      id: workspace.id,
      environmentId: workspace.environmentId,
    });
  }

  #assertSimpleTargetDestination(
    scope: RequestScope,
    request: CreateThreadRequest,
    caller: SavedAgentCreationCallerContext,
  ): void {
    if (request.configuration.kind !== "custom") return;
    this.input.inventory.assertWorkspaceActive(scope, request.workspaceId);
    const workspace = this.input.inventory.getWorkspace(
      scope,
      request.workspaceId,
    );
    const profile = this.input.configuration.getProfile(
      scope,
      request.configuration.targetId,
    );
    if (profile.executionEnvironmentId !== workspace.environmentId) {
      throw new DomainError(
        "not_found",
        "The selected target was not found in this workspace.",
      );
    }
    if (caller.kind === "agent_tool") {
      requireAdmittedResource(caller.environmentAuthority, {
        kind: "workspace",
        id: workspace.id,
        environmentId: workspace.environmentId,
      });
    }
  }

  #executionWorkspaceInitialization(
    scope: RequestScope,
    workspaceId: string,
    targetId: string,
    selection: ExecutionWorkspaceSelection,
  ):
    | Readonly<{
        initializeApplicationThread: (input: {
          readonly transaction: ConversationCreationTransaction;
          readonly applicationThreadId: string;
          readonly target: ResolvedLifecycleTarget;
          readonly now: number;
        }) => void;
      }>
    | Readonly<Record<string, never>> {
    if (selection.kind === "direct") return {};
    const workspace = this.input.inventory.getWorkspace(scope, workspaceId);
    const environment = this.input.inventory.getEnvironment(
      scope,
      workspace.environmentId,
    );
    const profile = this.input.configuration.getProfile(scope, targetId);
    const backend = this.input.configuration.getBackend(
      scope,
      profile.backendInstanceId,
    );
    if (
      environment.kind !== "local" ||
      profile.executionEnvironmentId !== workspace.environmentId ||
      profile.kind !== "pi_sdk" ||
      backend.kind !== "pi"
    ) {
      throw new DomainError(
        "invalid_transition",
        "The selected target does not support isolated workspace execution.",
      );
    }
    this.input.executionWorkspaces.assertAvailable({
      backendInstanceId: backend.id,
      executionEnvironmentId: environment.id,
      networkProfile: selection.networkProfile,
    });
    return {
      initializeApplicationThread: ({
        transaction,
        applicationThreadId,
        target,
      }) => {
        transaction.assertActive();
        if (
          target.connection.id !== targetId ||
          target.connection.executionEnvironmentId !== environment.id ||
          target.workspace.summary.id !== workspace.id ||
          target.workspace.canonicalPath !== workspace.canonicalPath
        ) {
          throw new DomainError(
            "conflict",
            "The isolated workspace target changed while the thread was created.",
          );
        }
        this.input.executionWorkspaces.reserve(scope, {
          applicationThreadId,
          executionEnvironmentId: environment.id,
          sourceWorkspaceId: workspace.id,
          sourceCanonicalPath: workspace.canonicalPath,
          workspaceAccess: selection.workspaceAccess,
          networkProfile: selection.networkProfile,
        });
      },
    };
  }

  #failureReason(error: unknown): string {
    if (error instanceof DomainError) return error.message;
    return "The target could not resolve this Saved Agent configuration.";
  }
}
