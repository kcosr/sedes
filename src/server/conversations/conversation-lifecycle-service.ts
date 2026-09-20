import type { EnvironmentVariablesService, PreparedThreadEnvironmentVariables } from "../environment-variables/environment-variables-service.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AgentConnectionProfile,
  ConversationBinding,
  BackendCatalog,
  ConversationBackendDriver,
  ConversationCreationIdentity,
  ConversationSubmissionSource,
  CreateConversationResult,
  RegisteredBackendActionInput,
} from "../backends/contracts.js";
import type { BackendEffectiveSettings } from "../../shared/protocol/backend.js";
import {
  hasDeliverableComposerInput,
  type DeliveryInputOrigin,
} from "../../shared/protocol/conversation.js";
import { BackendError } from "../backends/contracts.js";
import type { AgentBackendRegistry } from "../backends/registry.js";
import {
  ConversationCreationTransaction,
  type ResolvedSavedAgentBackendConfiguration,
  type SavedAgentBackendAdapter,
} from "../backends/saved-agent-adapter.js";
import type { ConversationBindingRecord } from "../db/repositories/conversation-binding-repository.js";
import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type {
  ConversationCreationAttemptRecord,
  ConversationCreationRepository,
} from "../db/repositories/conversation-creation-repository.js";
import type {
  ConversationDraftRecord,
  ConversationDraftRepository,
} from "../db/repositories/conversation-draft-repository.js";
import type { SubmissionCompletionRepository } from "../db/repositories/submission-completion-repository.js";
import { DomainError } from "../domain/errors.js";
import type { ValidatedWorkspace } from "../execution/contracts.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ToolInitiator } from "../agent-tools/contracts/tool-initiator.js";
import type { ConversationActorManager } from "./conversation-actor-manager.js";
import type { ComposerAttachmentDeliveryService } from "../composer-attachments/composer-attachment-delivery-service.js";
import { ThreadCompletionCallbackRepository } from "../db/repositories/thread-completion-callback-repository.js";
import { boundDisplayText } from "./payload-policy.js";

export interface ResolvedLifecycleTarget {
  readonly connection: AgentConnectionProfile;
  readonly workspace: ValidatedWorkspace;
  readonly title?: string;
}

export interface ConversationLifecycleTargetResolver {
  resolveNew(
    scope: RequestScope,
    input: {
      readonly connectionProfileId: string;
      readonly workspaceId: string;
    },
    signal?: AbortSignal,
  ): Promise<ResolvedLifecycleTarget>;
  resolve(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ResolvedLifecycleTarget>;
}

export interface ResolvedNewThreadBootstrap {
  readonly backendAdapter: SavedAgentBackendAdapter;
  readonly backendConfiguration: ResolvedSavedAgentBackendConfiguration;
  /** Durable revision/configuration fences, evaluated inside the create transaction. */
  readonly assertDurableFences: (
    transaction: ConversationCreationTransaction,
  ) => void;
  /** Optional Sedes-tool policy replacement for the trigger-created default. */
  readonly initializeAgentTools?: (input: {
    readonly transaction: ConversationCreationTransaction;
    readonly applicationThreadId: string;
    readonly now: number;
  }) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("operation_aborted");
}

/**
 * Provider-specific persistence participates in the SQLite transaction opened
 * by the lifecycle service. Implementations must not perform external calls
 * and must replay identical initialize/detail/intent writes idempotently.
 */
export interface BackendThreadPersistenceAdapter {
  readonly database: Database.Database;
  initializeThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): void;
  initializeForkThread(
    scope: RequestScope,
    sourceApplicationThreadId: string,
    childApplicationThreadId: string,
    connection: AgentConnectionProfile,
    effectiveSettings: BackendEffectiveSettings,
  ): void;
  readForkSettings(
    scope: RequestScope,
    childApplicationThreadId: string,
  ): BackendEffectiveSettings;
  initializeNewThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
    catalog: BackendCatalog,
  ): void;
  validateInitialization(
    scope: RequestScope,
    applicationThreadId: string,
    catalog: BackendCatalog,
  ): void;
  initializationActions(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
  ): readonly RegisteredBackendActionInput[];
  recordSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly applicationOperationId: string;
      readonly mutationId: string;
      readonly reconciliationToken: string;
    },
  ): void;
  hasSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    applicationOperationId: string,
  ): boolean;
  saveBoundBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
    opaqueBindingDetail: string,
  ): void;
}

export type LifecycleBoundResult = {
  readonly status: "bound";
  readonly binding: ConversationBindingRecord;
};

export type LifecycleRecoveryResult = {
  readonly status: "recovery_required";
  readonly attempt: ConversationCreationAttemptRecord;
  readonly retryable: boolean;
};

export type LifecycleAbortedResult = {
  readonly status: "aborted";
  readonly attempt: ConversationCreationAttemptRecord;
};

export type FirstSendResult =
  LifecycleBoundResult | LifecycleRecoveryResult | LifecycleAbortedResult;

type InFlightAttemptOperation = {
  readonly promise: Promise<FirstSendResult>;
  readonly retryMutationId?: string;
};

export class ConversationLifecycleService {
  readonly #registry: AgentBackendRegistry;
  readonly #targets: ConversationLifecycleTargetResolver;
  readonly #backendPersistence: ReadonlyMap<
    string,
    BackendThreadPersistenceAdapter
  >;
  readonly #bindings: ConversationBindingRepository;
  readonly #creation: ConversationCreationRepository;
  readonly #drafts: ConversationDraftRepository;
  readonly #completion: SubmissionCompletionRepository;
  readonly #actors: ConversationActorManager;
  readonly #attachmentDelivery?: ComposerAttachmentDeliveryService;
  readonly #callbacks: ThreadCompletionCallbackRepository;
  readonly #environmentVariables?: EnvironmentVariablesService;
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #inFlightFirstSends = new Map<string, Promise<FirstSendResult>>();
  readonly #inFlightAttemptOperations = new Map<
    string,
    InFlightAttemptOperation
  >();

  constructor(input: {
    readonly environmentVariables?: EnvironmentVariablesService;
    readonly registry: AgentBackendRegistry;
    readonly targets: ConversationLifecycleTargetResolver;
    readonly backendPersistence: ReadonlyMap<
      string,
      BackendThreadPersistenceAdapter
    >;
    readonly bindings: ConversationBindingRepository;
    readonly creation: ConversationCreationRepository;
    readonly drafts: ConversationDraftRepository;
    readonly completion: SubmissionCompletionRepository;
    readonly actors: ConversationActorManager;
    readonly attachmentDelivery?: ComposerAttachmentDeliveryService;
    readonly now?: () => number;
    readonly id?: () => string;
  }) {
    if (
      input.bindings.database !== input.creation.database ||
      input.bindings.database !== input.drafts.database ||
      input.bindings.database !== input.completion.database ||
      [...input.backendPersistence.values()].some(
        ({ database }) => database !== input.bindings.database,
      )
    ) {
      throw new Error(
        "Conversation lifecycle repositories must share one database connection.",
      );
    }
    this.#environmentVariables = input.environmentVariables;
    this.#registry = input.registry;
    this.#targets = input.targets;
    this.#backendPersistence = input.backendPersistence;
    this.#bindings = input.bindings;
    this.#creation = input.creation;
    this.#drafts = input.drafts;
    this.#completion = input.completion;
    this.#actors = input.actors;
    this.#attachmentDelivery = input.attachmentDelivery;
    this.#callbacks = new ThreadCompletionCallbackRepository(
      input.bindings.database,
    );
    this.#now = input.now ?? Date.now;
    this.#id = input.id ?? randomUUID;
  }

  #agentMessageOrigin(
    scope: RequestScope,
    sourceThreadId: string,
  ): DeliveryInputOrigin {
    const source = this.#bindings.findThreadDefinition(scope, sourceThreadId);
    if (!source) {
      throw new DomainError(
        "not_found",
        "The initiating agent thread was not found.",
      );
    }
    return {
      kind: "agent_message",
      sourceThreadId,
      sourceThreadLabel: boundDisplayText(source.title),
    };
  }

  findThreadConfigurationCopy(
    scope: RequestScope,
    input: {
      readonly sourceApplicationThreadId: string;
      readonly title: string;
      readonly mutationId: string;
    },
  ):
    | {
        readonly applicationThreadId: string;
        readonly workspaceId: string;
        readonly targetId: string;
        readonly draft: ConversationDraftRecord;
      }
    | undefined {
    const receipt = this.#bindings.findThreadConfigurationCopyReceipt(
      scope,
      input,
    );
    return receipt
      ? {
          ...receipt,
          draft: this.#drafts.get(scope, receipt.applicationThreadId),
        }
      : undefined;
  }

  async createServerDraft(
    scope: RequestScope,
    input: {
      readonly id?: string;
      readonly workspaceId: string;
      readonly connectionProfileId: string;
      readonly title: string;
      readonly initialText?: string;
      readonly environmentVariables?: PreparedThreadEnvironmentVariables;
      readonly bootstrap?: ResolvedNewThreadBootstrap;
      /** Application-owned SQLite initialization in the same create transaction. */
      readonly initializeApplicationThread?: (input: {
        readonly transaction: ConversationCreationTransaction;
        readonly applicationThreadId: string;
        readonly target: ResolvedLifecycleTarget;
        readonly now: number;
      }) => void;
      readonly savedAgentOrigin?: {
        readonly agentId: string;
        readonly agentRevision: number;
        readonly agentName: string;
      };
      readonly toolCreationOrigin?: {
        readonly initiator: ToolInitiator;
        readonly mutationId: string;
      };
      readonly configurationCopy?: {
        readonly sourceApplicationThreadId: string;
        readonly mutationId: string;
      };
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly applicationThreadId: string;
    readonly draft: ConversationDraftRecord;
  }> {
    if (input.id && input.bootstrap) {
      throw new Error(
        "Saved Agent thread creation does not accept a caller-selected draft ID.",
      );
    }
    if (input.id && input.toolCreationOrigin) {
      throw new Error(
        "Tool-created drafts require a server-selected thread ID.",
      );
    }
    if (input.configurationCopy && (!input.bootstrap || input.id)) {
      throw new Error(
        "Thread configuration copies require resolved bootstrap settings and a server-selected ID.",
      );
    }
    if (input.savedAgentOrigin && !input.bootstrap) {
      throw new Error(
        "Saved Agent thread origin requires resolved bootstrap settings.",
      );
    }
    if (input.savedAgentOrigin && (input.id || input.configurationCopy)) {
      throw new Error(
        "Saved Agent thread origin requires a new non-copy thread.",
      );
    }
    if (input.configurationCopy) {
      const replay = this.#bindings.findThreadConfigurationCopyReceipt(scope, {
        ...input.configurationCopy,
        title: input.title,
      });
      if (replay) {
        return {
          applicationThreadId: replay.applicationThreadId,
          draft: this.#drafts.get(scope, replay.applicationThreadId),
        };
      }
    }
    if (input.id) {
      const existing = this.#bindings.findThreadDefinition(scope, input.id);
      if (existing) {
        const draft = this.#drafts.find(scope, input.id);
        if (
          existing.workspaceId !== input.workspaceId ||
          existing.connectionProfileId !== input.connectionProfileId ||
          existing.title !== input.title ||
          existing.backingState !== "unbound" ||
          !draft ||
          draft.text !== (input.initialText ?? "")
        ) {
          throw new DomainError(
            "conflict",
            "The requested draft ID is already used by different state.",
          );
        }
        return { applicationThreadId: input.id, draft };
      }
    }
    throwIfAborted(signal);
    const now = this.#now();
    const resolved = await this.#targets.resolveNew(
      scope,
      {
        connectionProfileId: input.connectionProfileId,
        workspaceId: input.workspaceId,
      },
      signal,
    );
    throwIfAborted(signal);
    if (resolved.connection.id !== input.connectionProfileId) {
      throw new DomainError(
        "conflict",
        "The resolved connection does not match the requested target.",
      );
    }
    if (
      resolved.connection.tenantId !== scope.tenantId ||
      resolved.connection.ownerPrincipalId !== scope.principalId ||
      resolved.workspace.summary.id !== input.workspaceId ||
      resolved.workspace.summary.environmentId !==
        resolved.connection.executionEnvironmentId
    ) {
      throw new DomainError(
        "conflict",
        "The resolved draft target does not match the requested scope and workspace.",
      );
    }
    const variables = input.environmentVariables ?? this.#environmentVariables?.prepare(scope, input.connectionProfileId);
    let catalog: BackendCatalog | undefined;
    if (!input.bootstrap) {
      try {
        catalog = await this.#registry
          .driver(resolved.connection)
          .catalog({ scope, workspace: resolved.workspace });
        throwIfAborted(signal);
      } catch {
        throwIfAborted(signal);
        catalog = { models: [], commands: [], skills: [], notices: [] };
      }
    }
    throwIfAborted(signal);
    return this.#bindings.database.transaction(() => {
      if (input.configurationCopy) {
        const replay = this.#bindings.findThreadConfigurationCopyReceipt(
          scope,
          {
            ...input.configurationCopy,
            title: input.title,
          },
        );
        if (replay) {
          return {
            applicationThreadId: replay.applicationThreadId,
            draft: this.#drafts.get(scope, replay.applicationThreadId),
          };
        }
      }
      const transaction = ConversationCreationTransaction.fromActiveDatabase(
        this.#bindings.database,
      );
      input.bootstrap?.assertDurableFences(transaction);
      const created = this.#bindings.createUnboundThread(scope, {
        ...(input.id ? { id: input.id } : {}),
        workspaceId: input.workspaceId,
        connectionProfileId: input.connectionProfileId,
        title: input.title,
        ...(input.initialText !== undefined
          ? { initialText: input.initialText }
          : {}),
        now,
      });
      if (variables) this.#environmentVariables?.initialize(scope, created.id, variables);
      if (input.toolCreationOrigin) {
        const { initiator, mutationId } = input.toolCreationOrigin;
        this.#bindings.database
          .prepare(
            `INSERT INTO thread_tool_creation_origins(
               tenant_id, owner_principal_id, thread_id, initiator_kind,
               initiating_agent_thread_id, initiating_tool_client_id,
               creation_mutation_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            created.id,
            initiator.kind,
            initiator.kind === "thread_agent" ? initiator.sourceThreadId : null,
            initiator.kind === "principal_client" ? initiator.clientId : null,
            mutationId,
            now,
          );
      }
      if (input.savedAgentOrigin) {
        this.#bindings.database
          .prepare(
            `INSERT INTO thread_saved_agent_origins(
               tenant_id, owner_principal_id, thread_id, agent_id,
               agent_revision, agent_name, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            created.id,
            input.savedAgentOrigin.agentId,
            input.savedAgentOrigin.agentRevision,
            input.savedAgentOrigin.agentName,
            now,
          );
      }
      if (
        created.target.backendInstanceId !==
          resolved.connection.backendInstanceId ||
        created.target.connectionProfileId !== resolved.connection.id ||
        created.target.executionEnvironmentId !==
          resolved.connection.executionEnvironmentId
      ) {
        throw new DomainError(
          "conflict",
          "The materialized thread target changed while its draft was created.",
        );
      }
      if (input.bootstrap) {
        input.bootstrap.backendAdapter.initializeNewThread({
          transaction,
          scope,
          applicationThreadId: created.id,
          connection: resolved.connection,
          resolved: input.bootstrap.backendConfiguration,
        });
        input.bootstrap.initializeAgentTools?.({
          transaction,
          applicationThreadId: created.id,
          now,
        });
      } else {
        this.#persistenceForThread(scope, created.id).initializeNewThread(
          scope,
          created.id,
          resolved.connection,
          catalog!,
        );
      }
      input.initializeApplicationThread?.({
        transaction,
        applicationThreadId: created.id,
        target: resolved,
        now,
      });
      if (input.configurationCopy) {
        this.#bindings.recordThreadConfigurationCopyReceipt(scope, created.id, {
          ...input.configurationCopy,
          workspaceId: input.workspaceId,
          targetId: input.connectionProfileId,
          title: input.title,
          now,
        });
      }
      return {
        applicationThreadId: created.id,
        draft: this.#drafts.get(scope, created.id),
      };
    })();
  }

  startFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly attemptId?: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly expectedDraftRevision: number;
    },
  ): Promise<FirstSendResult> {
    const key = operationKey(scope, applicationThreadId, input.mutationId);
    const existing = this.#inFlightFirstSends.get(key);
    if (existing) return existing;
    const operation = this.#startFirstSend(
      scope,
      applicationThreadId,
      input,
    ).finally(() => {
      if (this.#inFlightFirstSends.get(key) === operation) {
        this.#inFlightFirstSends.delete(key);
      }
    });
    this.#inFlightFirstSends.set(key, operation);
    return operation;
  }

  hasFirstInputMutation(scope: RequestScope, mutationId: string): boolean {
    return (
      this.#creation.findByMutationId(scope, mutationId)?.creationKind ===
      "first_input"
    );
  }

  isBoundFirstInputMutation(scope: RequestScope, mutationId: string): boolean {
    const attempt = this.#creation.findByMutationId(scope, mutationId);
    return attempt?.creationKind === "first_input" && attempt.phase === "bound";
  }

  startAutomationFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly attemptId?: string;
      readonly automationId: string;
      readonly automationRunId: string;
      readonly prompt: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
    },
  ): Promise<FirstSendResult> {
    const key = operationKey(scope, applicationThreadId, input.mutationId);
    const existing = this.#inFlightFirstSends.get(key);
    if (existing) return existing;
    const operation = this.#startAutomationFirstSend(
      scope,
      applicationThreadId,
      input,
    ).finally(() => {
      if (this.#inFlightFirstSends.get(key) === operation) {
        this.#inFlightFirstSends.delete(key);
      }
    });
    this.#inFlightFirstSends.set(key, operation);
    return operation;
  }

  startAgentControlFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly attemptId?: string;
      readonly initiatingAgentThreadId: string;
      readonly completionCallback?: {
        readonly id: string;
        readonly callerThreadId: string;
      };
      readonly prompt: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
    },
  ): Promise<FirstSendResult> {
    const key = operationKey(scope, applicationThreadId, input.mutationId);
    const existing = this.#inFlightFirstSends.get(key);
    if (existing) return existing;
    const operation = this.#startToolFirstSend(scope, applicationThreadId, {
      ...input,
      sourceKind: "agent_control",
    }).finally(() => {
      if (this.#inFlightFirstSends.get(key) === operation) {
        this.#inFlightFirstSends.delete(key);
      }
    });
    this.#inFlightFirstSends.set(key, operation);
    return operation;
  }

  startPrincipalClientFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly attemptId?: string;
      readonly initiatingToolClientId: string;
      readonly prompt: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
    },
  ): Promise<FirstSendResult> {
    const key = operationKey(scope, applicationThreadId, input.mutationId);
    const existing = this.#inFlightFirstSends.get(key);
    if (existing) return existing;
    const operation = this.#startToolFirstSend(scope, applicationThreadId, {
      ...input,
      sourceKind: "principal_client",
    }).finally(() => {
      if (this.#inFlightFirstSends.get(key) === operation) {
        this.#inFlightFirstSends.delete(key);
      }
    });
    this.#inFlightFirstSends.set(key, operation);
    return operation;
  }

  async #startToolFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    input:
      | {
          readonly sourceKind: "agent_control";
          readonly attemptId?: string;
          readonly initiatingAgentThreadId: string;
          readonly completionCallback?: {
            readonly id: string;
            readonly callerThreadId: string;
          };
          readonly prompt: string;
          readonly mutationId: string;
          readonly expectedThreadRevision: number;
        }
      | {
          readonly sourceKind: "principal_client";
          readonly attemptId?: string;
          readonly initiatingToolClientId: string;
          readonly prompt: string;
          readonly mutationId: string;
          readonly expectedThreadRevision: number;
        },
  ): Promise<FirstSendResult> {
    const replay = this.#creation.findByMutationId(scope, input.mutationId);
    if (replay) {
      const callback = this.#callbacks.findForTargetOperation(
        scope,
        applicationThreadId,
        input.mutationId,
      );
      if (
        replay.applicationThreadId !== applicationThreadId ||
        (input.attemptId !== undefined &&
          replay.attemptId !== input.attemptId) ||
        replay.creationKind !== "first_input" ||
        replay.sourceKind !== input.sourceKind ||
        replay.initiatingAgentThreadId !==
          (input.sourceKind === "agent_control"
            ? input.initiatingAgentThreadId
            : null) ||
        replay.initiatingToolClientId !==
          (input.sourceKind === "principal_client"
            ? input.initiatingToolClientId
            : null) ||
        replay.initialInputText !== input.prompt ||
        (callback?.callerThreadId ?? null) !==
          (input.sourceKind === "agent_control"
            ? (input.completionCallback?.callerThreadId ?? null)
            : null) ||
        (input.sourceKind === "agent_control" &&
          input.completionCallback !== undefined &&
          callback?.id !== input.completionCallback.id)
      ) {
        throw new DomainError(
          "conflict",
          "The tool-control mutation ID was reused with different input.",
        );
      }
      return this.#runAttemptOperation(
        scope,
        applicationThreadId,
        replay.attemptId,
        () =>
          this.#recoverFirstSend(scope, applicationThreadId, replay.attemptId),
      );
    }
    if (
      !hasDeliverableComposerInput({
        text: input.prompt,
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
      })
    ) {
      throw new DomainError(
        "invalid_transition",
        "The tool-control prompt is empty.",
      );
    }
    // The initiating thread is trusted invocation context, but still must
    // resolve inside the same server-derived principal scope before it is
    // retained as durable provenance.
    if (input.sourceKind === "agent_control") {
      this.#bindings.getTarget(scope, input.initiatingAgentThreadId);
    }
    await this.#validateInitialization(scope, applicationThreadId);
    let attempt: ConversationCreationAttemptRecord;
    try {
      attempt = this.#creation.prepare(scope, applicationThreadId, {
        attemptId: input.attemptId ?? this.#id(),
        mutationId: input.mutationId,
        expectedThreadRevision: input.expectedThreadRevision,
        creationKind: "first_input",
        ...(input.sourceKind === "agent_control"
          ? {
              sourceKind: "agent_control" as const,
              initiatingAgentThreadId: input.initiatingAgentThreadId,
              ...(input.completionCallback === undefined
                ? {}
                : { completionCallback: input.completionCallback }),
            }
          : {
              sourceKind: "principal_client" as const,
              initiatingToolClientId: input.initiatingToolClientId,
            }),
        initialInputText: input.prompt,
        initialAttachmentIds: [],
        backendCreationCorrelation: this.#id(),
        now: this.#now(),
      });
    } catch (error) {
      const concurrent = this.#creation.findByMutationId(
        scope,
        input.mutationId,
      );
      const callback = this.#callbacks.findForTargetOperation(
        scope,
        applicationThreadId,
        input.mutationId,
      );
      if (
        !concurrent ||
        concurrent.applicationThreadId !== applicationThreadId ||
        concurrent.creationKind !== "first_input" ||
        concurrent.sourceKind !== input.sourceKind ||
        concurrent.initiatingAgentThreadId !==
          (input.sourceKind === "agent_control"
            ? input.initiatingAgentThreadId
            : null) ||
        concurrent.initiatingToolClientId !==
          (input.sourceKind === "principal_client"
            ? input.initiatingToolClientId
            : null) ||
        concurrent.initialInputText !== input.prompt ||
        (input.attemptId !== undefined &&
          concurrent.attemptId !== input.attemptId) ||
        (callback?.callerThreadId ?? null) !==
          (input.sourceKind === "agent_control"
            ? (input.completionCallback?.callerThreadId ?? null)
            : null) ||
        (input.sourceKind === "agent_control" &&
          input.completionCallback !== undefined &&
          callback?.id !== input.completionCallback.id)
      ) {
        throw error;
      }
      attempt = concurrent;
    }
    if (attempt.phase !== "prepared") {
      return this.#runAttemptOperation(
        scope,
        applicationThreadId,
        attempt.attemptId,
        () =>
          this.#recoverFirstSend(scope, applicationThreadId, attempt.attemptId),
      );
    }
    return this.#runAttemptOperation(
      scope,
      applicationThreadId,
      attempt.attemptId,
      () => this.#beginCreate(scope, attempt),
    );
  }

  async #startAutomationFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly attemptId?: string;
      readonly automationId: string;
      readonly automationRunId: string;
      readonly prompt: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
    },
  ): Promise<FirstSendResult> {
    const replay = this.#creation.findByMutationId(scope, input.mutationId);
    if (replay) {
      if (
        replay.applicationThreadId !== applicationThreadId ||
        (input.attemptId !== undefined &&
          replay.attemptId !== input.attemptId) ||
        replay.creationKind !== "first_input" ||
        replay.sourceKind !== "automation" ||
        replay.sourceAutomationId !== input.automationId ||
        replay.sourceAutomationRunId !== input.automationRunId ||
        replay.initialInputText !== input.prompt
      ) {
        throw new DomainError(
          "conflict",
          "The automation mutation ID was reused with different input.",
        );
      }
      return this.#runAttemptOperation(
        scope,
        applicationThreadId,
        replay.attemptId,
        () =>
          this.#recoverFirstSend(scope, applicationThreadId, replay.attemptId),
      );
    }
    if (input.prompt.length === 0) {
      throw new DomainError(
        "invalid_transition",
        "The automation prompt is empty.",
      );
    }
    await this.#validateInitialization(scope, applicationThreadId);
    let attempt: ConversationCreationAttemptRecord;
    try {
      attempt = this.#creation.prepare(scope, applicationThreadId, {
        attemptId: input.attemptId ?? this.#id(),
        mutationId: input.mutationId,
        expectedThreadRevision: input.expectedThreadRevision,
        creationKind: "first_input",
        sourceKind: "automation",
        sourceAutomationId: input.automationId,
        sourceAutomationRunId: input.automationRunId,
        initialInputText: input.prompt,
        initialAttachmentIds: [],
        backendCreationCorrelation: this.#id(),
        now: this.#now(),
      });
    } catch (error) {
      const concurrent = this.#creation.findByMutationId(
        scope,
        input.mutationId,
      );
      if (
        !concurrent ||
        concurrent.applicationThreadId !== applicationThreadId ||
        concurrent.creationKind !== "first_input" ||
        concurrent.sourceKind !== "automation" ||
        concurrent.sourceAutomationId !== input.automationId ||
        concurrent.sourceAutomationRunId !== input.automationRunId ||
        concurrent.initialInputText !== input.prompt ||
        (input.attemptId !== undefined &&
          concurrent.attemptId !== input.attemptId)
      ) {
        throw error;
      }
      attempt = concurrent;
    }
    if (attempt.phase !== "prepared") {
      return this.#runAttemptOperation(
        scope,
        applicationThreadId,
        attempt.attemptId,
        () =>
          this.#recoverFirstSend(scope, applicationThreadId, attempt.attemptId),
      );
    }
    return this.#runAttemptOperation(
      scope,
      applicationThreadId,
      attempt.attemptId,
      () => this.#beginCreate(scope, attempt),
    );
  }

  async #startFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly attemptId?: string;
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly expectedDraftRevision: number;
    },
  ): Promise<FirstSendResult> {
    const replay = this.#creation.findByMutationId(scope, input.mutationId);
    if (replay) {
      if (
        replay.applicationThreadId !== applicationThreadId ||
        (input.attemptId !== undefined &&
          replay.attemptId !== input.attemptId) ||
        replay.creationKind !== "first_input" ||
        replay.sourceKind !== "composer" ||
        replay.consumedDraftRevision !== input.expectedDraftRevision + 1
      ) {
        throw new DomainError(
          "conflict",
          "The first-send mutation ID was reused with different input.",
        );
      }
      return this.#runAttemptOperation(
        scope,
        applicationThreadId,
        replay.attemptId,
        () =>
          this.#recoverFirstSend(scope, applicationThreadId, replay.attemptId),
      );
    }
    const draft = this.#drafts.get(scope, applicationThreadId);
    if (
      draft.revision !== input.expectedDraftRevision ||
      !hasDeliverableComposerInput(draft)
    ) {
      throw new DomainError(
        "draft_revision_conflict",
        "The server draft changed or is empty.",
      );
    }
    await this.#validateInitialization(
      scope,
      applicationThreadId,
      draft.selectedSkillId ?? undefined,
    );
    let attempt: ConversationCreationAttemptRecord;
    {
      try {
        attempt = this.#creation.prepare(scope, applicationThreadId, {
          attemptId: input.attemptId ?? this.#id(),
          mutationId: input.mutationId,
          expectedThreadRevision: input.expectedThreadRevision,
          creationKind: "first_input",
          sourceKind: "composer",
          initialInputText: draft.text,
          ...(draft.selectedSkillId === null
            ? {}
            : { initialSkillId: draft.selectedSkillId }),
          initialContextExcerpts: draft.contextExcerpts,
          initialAttachmentIds: draft.attachments.map(({ id }) => id),
          initialTaskReferences: draft.taskReferences,
          expectedDraftRevision: input.expectedDraftRevision,
          backendCreationCorrelation: this.#id(),
          now: this.#now(),
        });
      } catch (error) {
        const concurrent = this.#creation.findByMutationId(
          scope,
          input.mutationId,
        );
        if (
          !concurrent ||
          concurrent.applicationThreadId !== applicationThreadId ||
          concurrent.creationKind !== "first_input" ||
          concurrent.sourceKind !== "composer" ||
          concurrent.initialInputText !== draft.text ||
          concurrent.initialSkillId !== draft.selectedSkillId ||
          JSON.stringify(concurrent.initialContextExcerpts) !==
            JSON.stringify(draft.contextExcerpts) ||
          JSON.stringify(concurrent.initialAttachments) !==
            JSON.stringify(draft.attachments) ||
          JSON.stringify(concurrent.initialTaskContexts.map(({ id }) => id)) !==
            JSON.stringify(draft.taskReferences.map(({ taskId }) => taskId)) ||
          (input.attemptId !== undefined &&
            concurrent.attemptId !== input.attemptId)
        ) {
          throw error;
        }
        attempt = concurrent;
      }
    }
    if (attempt.phase !== "prepared") {
      return this.#runAttemptOperation(
        scope,
        applicationThreadId,
        attempt.attemptId,
        () =>
          this.#recoverFirstSend(scope, applicationThreadId, attempt.attemptId),
      );
    }
    return this.#runAttemptOperation(
      scope,
      applicationThreadId,
      attempt.attemptId,
      () => this.#beginCreate(scope, attempt),
    );
  }

  async #validateInitialization(
    scope: RequestScope,
    applicationThreadId: string,
    selectedSkillId?: string,
  ): Promise<void> {
    const resolved = await this.#targets.resolve(scope, applicationThreadId);
    const catalog = await this.#registry
      .driver(resolved.connection)
      .catalog({ scope, workspace: resolved.workspace });
    if (
      selectedSkillId !== undefined &&
      !catalog.skills.some(({ id }) => id === selectedSkillId)
    ) {
      throw new DomainError(
        "invalid_transition",
        "The selected skill is no longer available in this workspace.",
      );
    }
    this.#persistenceForThread(
      scope,
      applicationThreadId,
    ).validateInitialization(scope, applicationThreadId, catalog);
  }

  recoverFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
  ): Promise<FirstSendResult> {
    return this.#runAttemptOperation(
      scope,
      applicationThreadId,
      attemptId,
      () => this.#recoverFirstSend(scope, applicationThreadId, attemptId),
    );
  }

  recoverActiveFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<FirstSendResult> | undefined {
    const attempt = this.#creation.findActiveForThread(
      scope,
      applicationThreadId,
    );
    if (!attempt || attempt.creationKind !== "first_input") return undefined;
    return this.recoverFirstSend(scope, applicationThreadId, attempt.attemptId);
  }

  async #recoverFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
  ): Promise<FirstSendResult> {
    let attempt = this.#creation.get(scope, applicationThreadId, attemptId);
    if (attempt.phase === "bound") {
      const binding = this.#bindings.getBinding(scope, applicationThreadId);
      if (!binding) {
        throw new DomainError(
          "materialization_unresolved",
          "The bound creation attempt has no conversation binding.",
        );
      }
      return { status: "bound", binding };
    }
    if (attempt.phase === "aborted_unpersisted") {
      attempt = this.#creation.ensureAbortedCompletionCallbackCancelled(
        scope,
        applicationThreadId,
        attemptId,
        this.#now(),
      );
      return { status: "aborted", attempt };
    }
    if (attempt.phase === "accepted_unpersisted") {
      if (attempt.acceptedAt === null) {
        throw new DomainError(
          "materialization_unresolved",
          "The accepted attempt has no acceptance anchor.",
        );
      }
      return this.#finalizeAccepted(
        scope,
        applicationThreadId,
        attemptId,
        attempt.acceptedAt,
      );
    }
    if (attempt.phase === "prepared") {
      return this.#beginCreate(scope, attempt);
    }
    if (
      attempt.phase === "external_call_started" ||
      (attempt.phase === "recovery_required" &&
        attempt.provisionalBackendConversationId === null)
    ) {
      const identity = await this.#creationIdentityForAttempt(scope, attempt);
      if (identity.createReplay === "never") {
        if (attempt.phase === "external_call_started") {
          return this.#requireRecovery(
            scope,
            applicationThreadId,
            attemptId,
            "external_call_started",
            new BackendError({
              category: "submission_unknown",
              retryable: false,
              crossedSubmissionBoundary: true,
              safeMessage:
                "Provider-assigned creation cannot be replayed after the external boundary was crossed; an empty native conversation may exist.",
            }),
          );
        }
        return {
          status: "recovery_required",
          attempt,
          retryable: false,
        };
      }
      return this.#replayCreate(scope, attempt, attempt.phase);
    }
    if (attempt.phase === "conversation_identified") {
      return this.#submitIdentified(scope, attempt);
    }
    if (attempt.phase === "first_submission_started") {
      attempt = this.#creation.markRecoveryRequired(
        scope,
        applicationThreadId,
        attemptId,
        {
          expected: "first_submission_started",
          ...(attempt.reconciliationToken
            ? { reconciliationToken: attempt.reconciliationToken }
            : {}),
          diagnostic: "Restarted before first-send acceptance was persisted.",
          now: this.#now(),
        },
      );
    }
    if (attempt.phase !== "recovery_required") {
      throw new DomainError(
        "invalid_transition",
        `Creation attempt in phase ${attempt.phase} cannot be recovered.`,
      );
    }
    if (this.#isPreSubmissionRecovery(scope, applicationThreadId, attempt)) {
      let identified;
      try {
        identified = this.#creation.recordConversationIdentified(
          scope,
          applicationThreadId,
          attemptId,
          {
            expected: "recovery_required",
            backendConversationId: attempt.provisionalBackendConversationId!,
            opaqueBindingDetail: attempt.provisionalOpaqueBindingDetail!,
            ...(attempt.reconciliationToken
              ? { reconciliationToken: attempt.reconciliationToken }
              : {}),
            now: this.#now(),
          },
        );
      } catch (error) {
        return this.#resumeConcurrentTransition(
          scope,
          applicationThreadId,
          attemptId,
          "recovery_required",
          error,
        );
      }
      return this.#submitIdentified(scope, identified);
    }
    if (
      attempt.retryAuthorizedAt !== null &&
      attempt.retryMutationId === null
    ) {
      return {
        status: "recovery_required",
        attempt,
        retryable: true,
      };
    }
    const reconciliationToken =
      attempt.retryMutationId === null
        ? attempt.reconciliationToken
        : attempt.retryReconciliationToken;
    if (!reconciliationToken) {
      return {
        status: "recovery_required",
        attempt: this.#creation.refreshRecoveryRequired(
          scope,
          applicationThreadId,
          attemptId,
          {
            diagnostic:
              "Recovery requires an operator-resolvable backend token.",
            now: this.#now(),
          },
        ),
        retryable: false,
      };
    }

    const resolved = await this.#resolveAttemptTarget(scope, attempt);
    const driver = this.#registry.driver(resolved.connection);
    const binding =
      attempt.provisionalBackendConversationId === null
        ? undefined
        : bindingFromAttempt(
            scope,
            attempt,
            attempt.provisionalBackendConversationId,
            attempt.preparedAt,
          );
    let result;
    try {
      const attachmentEvidence =
        attempt.initialAttachments.length === 0
          ? []
          : this.#attachmentDelivery?.resolveCanonicalEvidence(
              scope,
              applicationThreadId,
              attempt.initialAttachments,
            );
      if (attachmentEvidence === undefined) {
        throw new Error("composer_attachment_reconciliation_unavailable");
      }
      result = await driver.reconcileSubmission({
        scope,
        ...(binding ? { binding } : {}),
        ...(binding && attempt.provisionalOpaqueBindingDetail
          ? { opaqueBindingDetail: attempt.provisionalOpaqueBindingDetail }
          : {}),
        workspace: resolved.workspace,
        applicationOperationId: attempt.mutationId,
        reconciliationToken,
        ...(attempt.retryAnchor ? { retryAnchor: attempt.retryAnchor } : {}),
        ...(attachmentEvidence.length > 0 ? { attachmentEvidence } : {}),
      });
    } catch (error) {
      return {
        status: "recovery_required",
        attempt: this.#creation.refreshRecoveryRequired(
          scope,
          applicationThreadId,
          attemptId,
          { diagnostic: diagnostic(error), now: this.#now() },
        ),
        retryable: false,
      };
    }
    if (result.status === "accepted") {
      if (!attempt.provisionalBackendConversationId) {
        return {
          status: "recovery_required",
          attempt: this.#creation.refreshRecoveryRequired(
            scope,
            applicationThreadId,
            attemptId,
            {
              diagnostic:
                "The backend proved acceptance without a recoverable conversation identity.",
              now: this.#now(),
            },
          ),
          retryable: false,
        };
      }
      const acceptedAt = this.#now();
      const backendCorrelation = attempt.mutationId;
      try {
        const acceptance = this.#bindings.database
          .transaction(() => {
            this.#creation.markAcceptedUnpersisted(
              scope,
              applicationThreadId,
              attemptId,
              {
                expected: "recovery_required",
                acceptedAt,
                reconciliationToken,
                backendCorrelation,
                ...(result.completionIdentity
                  ? { completionIdentity: result.completionIdentity }
                  : {}),
              },
            );
            return { mismatch: undefined };
          })
          .immediate();
        if (acceptance.mismatch) {
          return {
            status: "recovery_required",
            attempt: acceptance.mismatch,
            retryable: false,
          };
        }
      } catch (error) {
        return this.#resumeConcurrentTransition(
          scope,
          applicationThreadId,
          attemptId,
          "recovery_required",
          error,
        );
      }
      return this.#finalizeAccepted(
        scope,
        applicationThreadId,
        attemptId,
        acceptedAt,
      );
    }
    if (result.status === "not_accepted" && result.retryable) {
      let authorized;
      try {
        authorized = this.#creation.authorizeRetry(
          scope,
          applicationThreadId,
          attemptId,
          {
            expectedRetryMutationId: attempt.retryMutationId,
            diagnostic:
              "The first submission was proven not accepted and may be retried.",
            now: this.#now(),
          },
        );
      } catch (error) {
        return this.#resumeConcurrentTransition(
          scope,
          applicationThreadId,
          attemptId,
          "recovery_required",
          error,
        );
      }
      return {
        status: "recovery_required",
        attempt: authorized,
        retryable: true,
      };
    }
    const safeDiagnostic =
      result.status === "unresolved" || result.status === "failed_unknown"
        ? result.diagnostic.text
        : "The first submission was not accepted.";
    return {
      status: "recovery_required",
      attempt: this.#creation.refreshRecoveryRequired(
        scope,
        applicationThreadId,
        attemptId,
        { diagnostic: safeDiagnostic, now: this.#now() },
      ),
      retryable: false,
    };
  }

  retryFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    retryMutationId: string,
  ): Promise<FirstSendResult> {
    return this.#runAttemptOperation(
      scope,
      applicationThreadId,
      attemptId,
      () =>
        this.#retryFirstSend(
          scope,
          applicationThreadId,
          attemptId,
          retryMutationId,
        ),
      retryMutationId,
    );
  }

  async #retryFirstSend(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    retryMutationId: string,
  ): Promise<FirstSendResult> {
    let attempt = this.#creation.get(scope, applicationThreadId, attemptId);
    if (
      attempt.phase !== "recovery_required" ||
      !attempt.provisionalBackendConversationId ||
      attempt.initialInputText === null
    ) {
      throw new DomainError(
        "invalid_transition",
        "The creation attempt cannot retry its first submission.",
      );
    }
    if (attempt.retryMutationId !== null) {
      if (attempt.retryMutationId !== retryMutationId) {
        throw new DomainError(
          "conflict",
          "A different first-submission retry is already in flight.",
        );
      }
      return this.#recoverFirstSend(scope, applicationThreadId, attemptId);
    }
    if (attempt.retryAuthorizedAt === null) {
      throw new DomainError(
        "invalid_transition",
        "The first submission has not been proven safe to retry.",
      );
    }
    const persistence = this.#persistenceForThread(scope, applicationThreadId);
    const detail = attempt.provisionalOpaqueBindingDetail;
    if (!detail) {
      throw new DomainError(
        "materialization_unresolved",
        "The creation attempt has no durable backend binding detail.",
      );
    }
    const resolved = await this.#resolveAttemptTarget(scope, attempt);
    const driver = this.#registry.driver(resolved.connection);
    const ephemeralBinding = bindingFromAttempt(
      scope,
      attempt,
      attempt.provisionalBackendConversationId,
      attempt.preparedAt,
    );
    let acquired;
    try {
      acquired = await this.#actors.acquire(
        {
          scope,
          binding: ephemeralBinding,
          workspace: resolved.workspace,
          opaqueBindingDetail: detail,
          driver,
        },
        { idleRelease: "retain" },
      );
    } catch (error) {
      return {
        status: "recovery_required",
        attempt: this.#creation.refreshRecoveryRequired(
          scope,
          applicationThreadId,
          attemptId,
          { diagnostic: diagnostic(error), now: this.#now() },
        ),
        retryable: error instanceof BackendError && error.retryable,
      };
    }
    let newlyClaimed = false;
    try {
      await this.#applyInitializationActions(
        scope,
        applicationThreadId,
        attemptId,
        acquired.actor,
      );
    } catch (error) {
      acquired.release();
      return {
        status: "recovery_required",
        attempt: this.#creation.refreshRecoveryRequired(
          scope,
          applicationThreadId,
          attemptId,
          {
            diagnostic: diagnostic(error),
            now: this.#now(),
          },
        ),
        retryable: error instanceof BackendError && error.retryable,
      };
    }
    let attachmentDelivery;
    try {
      attachmentDelivery = await acquired.actor.materializeAttachments(
        attempt.initialAttachments,
      );
    } catch (error) {
      acquired.release();
      return {
        status: "recovery_required",
        attempt: this.#creation.refreshRecoveryRequired(
          scope,
          applicationThreadId,
          attemptId,
          { diagnostic: diagnostic(error), now: this.#now() },
        ),
        retryable: error instanceof BackendError && error.retryable,
      };
    }
    try {
      const retryAnchor = await acquired.actor.captureSubmissionRetryAnchor();
      this.#bindings.database.transaction(() => {
        const reconciliationToken = retryMutationId;
        persistence.recordSubmissionIntent(
          scope,
          applicationThreadId,
          attemptId,
          {
            applicationOperationId: attempt.mutationId,
            mutationId: retryMutationId,
            reconciliationToken,
          },
        );
        const claim = this.#creation.claimRetry(
          scope,
          applicationThreadId,
          attemptId,
          {
            retryMutationId,
            reconciliationToken,
            retryAnchor,
            now: this.#now(),
          },
        );
        attempt = claim.attempt;
        newlyClaimed = claim.newlyClaimed;
      })();
    } catch (error) {
      acquired.release();
      const recovered = this.#bindings.database
        .transaction(() => {
          const refreshed = this.#creation.refreshRecoveryRequired(
            scope,
            applicationThreadId,
            attemptId,
            { diagnostic: diagnostic(error), now: this.#now() },
          );
          return refreshed;
        })
        .immediate();
      return {
        status: "recovery_required",
        attempt: recovered,
        retryable: error instanceof BackendError && error.retryable,
      };
    }
    if (!newlyClaimed) {
      acquired.release();
      return this.#recoverFirstSend(scope, applicationThreadId, attemptId);
    }
    let accepted;
    try {
      accepted = await acquired.actor.submit({
        applicationOperationId: attempt.mutationId,
        mutationId: retryMutationId,
        source: submissionSource(attempt),
        reconciliationToken: attempt.retryReconciliationToken!,
        text: attempt.initialInputText,
        ...(attempt.initialSkillId === null
          ? {}
          : { selectedSkillId: attempt.initialSkillId }),
        contextExcerpts: attempt.initialContextExcerpts,
        attachments: attachmentDelivery.attachments,
        ...(attachmentDelivery.attachments.length > 0
          ? {
              attachmentBytes: attachmentDelivery.canonicalBytes,
              attachmentEvidence: attachmentDelivery.canonicalEvidence,
            }
          : {}),
        taskContexts: attempt.initialTaskContexts,
        ...(attempt.initiatingAgentThreadId === null
          ? {}
          : {
              inputOrigin: this.#agentMessageOrigin(
                scope,
                attempt.initiatingAgentThreadId,
              ),
            }),
      });
      if (
        accepted.reconciliationToken !== attempt.retryReconciliationToken ||
        accepted.completionCorrelation !== attempt.mutationId
      ) {
        throw new BackendError({
          category: "submission_unknown",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage:
            "The backend did not echo the durable reconciliation identity.",
        });
      }
    } catch (error) {
      acquired.release();
      const recovered = this.#bindings.database
        .transaction(() => {
          const refreshed = this.#creation.refreshRecoveryRequired(
            scope,
            applicationThreadId,
            attemptId,
            { diagnostic: diagnostic(error), now: this.#now() },
          );
          return refreshed;
        })
        .immediate();
      return {
        status: "recovery_required",
        attempt: recovered,
        retryable: false,
      };
    }
    try {
      const acceptedAt = this.#now();
      const acceptance = this.#bindings.database
        .transaction(() => {
          this.#creation.markAcceptedUnpersisted(
            scope,
            applicationThreadId,
            attemptId,
            {
              expected: "recovery_required",
              acceptedAt,
              reconciliationToken: accepted.reconciliationToken,
              backendCorrelation: accepted.completionCorrelation,
            },
          );
          return { mismatch: undefined };
        })
        .immediate();
      if (acceptance.mismatch) {
        return {
          status: "recovery_required",
          attempt: acceptance.mismatch,
          retryable: false,
        };
      }
      const result = this.#finalizeAccepted(
        scope,
        applicationThreadId,
        attemptId,
        acceptedAt,
      );
      await acquired.actor.replayAuthoritativeCompletions();
      return result;
    } finally {
      acquired.release();
    }
  }

  async #beginCreate(
    scope: RequestScope,
    attempt: ConversationCreationAttemptRecord,
  ): Promise<FirstSendResult> {
    let resolved: ResolvedLifecycleTarget;
    let driver: ConversationBackendDriver;
    try {
      resolved = await this.#resolveAttemptTarget(scope, attempt);
      driver = this.#registry.driver(resolved.connection);
    } catch (error) {
      const aborted = this.#creation.abortProvenUnpersisted(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        {
          expected: "prepared",
          diagnostic: diagnostic(error),
          now: this.#now(),
        },
      );
      return { status: "aborted", attempt: aborted };
    }
    let started;
    try {
      started = this.#creation.markExternalCallStarted(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        this.#now(),
      );
    } catch (error) {
      return this.#resumeConcurrentTransition(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        "prepared",
        error,
      );
    }
    return this.#replayCreate(scope, started, "external_call_started", {
      resolved,
      driver,
    });
  }

  async moveServerDraftWorkspace(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly workspaceId: string;
      readonly expectedThreadRevision: number;
      readonly mutationId: string;
    },
  ): Promise<void> {
    if (
      this.#bindings.isUnboundThreadWorkspaceMoveReplay(
        scope,
        applicationThreadId,
        input,
      )
    ) {
      return;
    }
    const current = this.#bindings.getTarget(scope, applicationThreadId);
    if (current.backingState !== "unbound") {
      throw new DomainError(
        "invalid_transition",
        "Only an unbound draft thread can change workspaces.",
      );
    }
    if (current.workspaceId === input.workspaceId) {
      this.#bindings.moveUnboundThreadWorkspace(scope, applicationThreadId, {
        ...input,
        now: this.#now(),
      });
      return;
    }
    const resolved = await this.#targets.resolveNew(scope, {
      connectionProfileId: current.connectionProfileId,
      workspaceId: input.workspaceId,
    });
    if (
      resolved.connection.tenantId !== scope.tenantId ||
      resolved.connection.ownerPrincipalId !== scope.principalId ||
      resolved.connection.id !== current.connectionProfileId ||
      resolved.connection.backendInstanceId !== current.backendInstanceId ||
      resolved.connection.executionEnvironmentId !==
        current.executionEnvironmentId ||
      resolved.workspace.summary.id !== input.workspaceId ||
      resolved.workspace.summary.environmentId !==
        current.executionEnvironmentId
    ) {
      throw new DomainError(
        "conflict",
        "The destination workspace does not match the draft execution target.",
      );
    }
    this.#bindings.moveUnboundThreadWorkspace(scope, applicationThreadId, {
      ...input,
      now: this.#now(),
    });
  }

  async #replayCreate(
    scope: RequestScope,
    attempt: ConversationCreationAttemptRecord,
    expected: "external_call_started" | "recovery_required",
    prepared?: {
      readonly resolved: ResolvedLifecycleTarget;
      readonly driver: ConversationBackendDriver;
    },
  ): Promise<FirstSendResult> {
    const resolved =
      prepared?.resolved ?? (await this.#resolveAttemptTarget(scope, attempt));
    const driver =
      prepared?.driver ?? this.#registry.driver(resolved.connection);
    const identity = this.#registry.creationIdentity(resolved.connection);
    let created: CreateConversationResult;
    try {
      created = await driver.create({
        scope,
        applicationThreadId: attempt.applicationThreadId,
        applicationOperationId: attempt.mutationId,
        source: submissionSource(attempt),
        workspace: resolved.workspace,
        ...(identity.assignment === "application"
          ? {
              requestedBackendConversationId:
                attempt.backendCreationCorrelation,
            }
          : {
              creationCorrelation: attempt.backendCreationCorrelation,
            }),
        ...(resolved.title ? { title: resolved.title } : {}),
      });
      if (
        identity.assignment === "application" &&
        created.backendConversationId !== attempt.backendCreationCorrelation
      ) {
        throw new BackendError({
          category: "internal",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage:
            "The backend returned a different conversation identity than requested.",
        });
      }
    } catch (error) {
      if (error instanceof BackendError && !error.crossedSubmissionBoundary) {
        const aborted = this.#creation.abortProvenUnpersisted(
          scope,
          attempt.applicationThreadId,
          attempt.attemptId,
          {
            expected,
            diagnostic: diagnostic(error),
            now: this.#now(),
          },
        );
        return { status: "aborted", attempt: aborted };
      }
      if (expected === "recovery_required") {
        return {
          status: "recovery_required",
          attempt: this.#creation.refreshRecoveryRequired(
            scope,
            attempt.applicationThreadId,
            attempt.attemptId,
            {
              diagnostic: diagnostic(error),
              now: this.#now(),
            },
          ),
          retryable: false,
        };
      }
      return this.#requireRecovery(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        expected,
        error,
      );
    }

    try {
      this.#bindings.database.transaction(() => {
        this.#creation.recordConversationIdentified(
          scope,
          attempt.applicationThreadId,
          attempt.attemptId,
          {
            expected,
            backendConversationId: created.backendConversationId,
            opaqueBindingDetail: created.opaqueBindingDetail,
            reconciliationToken: created.reconciliationToken,
            now: this.#now(),
          },
        );
        if (identity.bindBeforeFirstSubmission) {
          // Bind the native identity before the first prompt while leaving the
          // provisional binding detail in place until first-send acceptance
          // finalizes the attempt.
          this.#bindings.bindProviderAssignedConversation(
            scope,
            attempt.applicationThreadId,
            {
              attemptId: attempt.attemptId,
              backendConversationId: created.backendConversationId,
              boundAt: this.#now(),
            },
          );
        }
      })();
    } catch (error) {
      const current = this.#creation.get(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
      );
      if (current.phase === expected) {
        if (expected === "recovery_required") {
          this.#creation.refreshRecoveryRequired(
            scope,
            attempt.applicationThreadId,
            attempt.attemptId,
            {
              reconciliationToken: created.reconciliationToken,
              diagnostic: diagnostic(error),
              now: this.#now(),
            },
          );
        } else {
          this.#creation.markRecoveryRequired(
            scope,
            attempt.applicationThreadId,
            attempt.attemptId,
            {
              expected,
              reconciliationToken: created.reconciliationToken,
              diagnostic: diagnostic(error),
              now: this.#now(),
            },
          );
        }
      }
      return {
        status: "recovery_required",
        attempt: this.#creation.get(
          scope,
          attempt.applicationThreadId,
          attempt.attemptId,
        ),
        retryable: false,
      };
    }
    return this.#submitIdentified(
      scope,
      this.#creation.get(scope, attempt.applicationThreadId, attempt.attemptId),
    );
  }

  async #creationIdentityForAttempt(
    scope: RequestScope,
    attempt: ConversationCreationAttemptRecord,
  ): Promise<ConversationCreationIdentity> {
    const resolved = await this.#resolveAttemptTarget(scope, attempt);
    return this.#registry.creationIdentity(resolved.connection);
  }

  async #submitIdentified(
    scope: RequestScope,
    attempt: ConversationCreationAttemptRecord,
  ): Promise<FirstSendResult> {
    if (
      attempt.phase !== "conversation_identified" ||
      attempt.provisionalBackendConversationId === null ||
      attempt.initialInputText === null
    ) {
      throw new DomainError(
        "invalid_transition",
        "The identified conversation cannot accept its first input.",
      );
    }
    const persistence = this.#persistenceForThread(
      scope,
      attempt.applicationThreadId,
    );
    const detail = attempt.provisionalOpaqueBindingDetail;
    if (!detail) {
      return this.#requireRecovery(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        "conversation_identified",
        new Error("The provisional backend binding detail is missing."),
      );
    }
    const resolved = await this.#resolveAttemptTarget(scope, attempt);
    const driver = this.#registry.driver(resolved.connection);
    const ephemeralBinding = bindingFromAttempt(
      scope,
      attempt,
      attempt.provisionalBackendConversationId,
      attempt.preparedAt,
    );
    let acquired;
    try {
      acquired = await this.#actors.acquire(
        {
          scope,
          binding: ephemeralBinding,
          workspace: resolved.workspace,
          opaqueBindingDetail: detail,
          driver,
        },
        { idleRelease: "retain" },
      );
    } catch (error) {
      return this.#requireRecovery(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        "conversation_identified",
        error,
      );
    }
    try {
      await this.#applyInitializationActions(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        acquired.actor,
      );
    } catch (error) {
      acquired.release();
      return this.#requirePreSubmissionRecovery(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        error,
      );
    }
    let attachmentDelivery;
    try {
      attachmentDelivery = await acquired.actor.materializeAttachments(
        attempt.initialAttachments,
      );
    } catch (error) {
      acquired.release();
      return this.#requirePreSubmissionRecovery(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        error,
      );
    }
    try {
      const retryAnchor = await acquired.actor.captureSubmissionRetryAnchor();
      this.#bindings.database.transaction(() => {
        const reconciliationToken = attempt.mutationId;
        persistence.recordSubmissionIntent(
          scope,
          attempt.applicationThreadId,
          attempt.attemptId,
          {
            applicationOperationId: attempt.mutationId,
            mutationId: attempt.mutationId,
            reconciliationToken,
          },
        );
        attempt = this.#creation.markFirstSubmissionStarted(
          scope,
          attempt.applicationThreadId,
          attempt.attemptId,
          {
            reconciliationToken,
            retryAnchor,
            now: this.#now(),
          },
        );
      })();
    } catch (error) {
      acquired.release();
      return this.#requireRecovery(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        "conversation_identified",
        error,
      );
    }
    let accepted;
    try {
      accepted = await acquired.actor.submit({
        applicationOperationId: attempt.mutationId,
        mutationId: attempt.mutationId,
        source: submissionSource(attempt),
        reconciliationToken: attempt.reconciliationToken!,
        text: attempt.initialInputText,
        ...(attempt.initialSkillId === null
          ? {}
          : { selectedSkillId: attempt.initialSkillId }),
        contextExcerpts: attempt.initialContextExcerpts,
        attachments: attachmentDelivery.attachments,
        ...(attachmentDelivery.attachments.length > 0
          ? {
              attachmentBytes: attachmentDelivery.canonicalBytes,
              attachmentEvidence: attachmentDelivery.canonicalEvidence,
            }
          : {}),
        taskContexts: attempt.initialTaskContexts,
        ...(attempt.initiatingAgentThreadId === null
          ? {}
          : {
              inputOrigin: this.#agentMessageOrigin(
                scope,
                attempt.initiatingAgentThreadId,
              ),
            }),
      });
      if (
        accepted.reconciliationToken !== attempt.reconciliationToken ||
        accepted.completionCorrelation !== attempt.mutationId
      ) {
        throw new BackendError({
          category: "submission_unknown",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage:
            "The backend did not echo the durable reconciliation identity.",
        });
      }
    } catch (error) {
      acquired.release();
      return this.#requireRecovery(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        "first_submission_started",
        error,
      );
    }
    try {
      const acceptedAt = this.#now();
      const acceptance = this.#bindings.database
        .transaction(() => {
          this.#creation.markAcceptedUnpersisted(
            scope,
            attempt.applicationThreadId,
            attempt.attemptId,
            {
              expected: "first_submission_started",
              acceptedAt,
              reconciliationToken: accepted.reconciliationToken,
              backendCorrelation: accepted.completionCorrelation,
            },
          );
          return { mismatch: undefined };
        })
        .immediate();
      if (acceptance.mismatch) {
        return {
          status: "recovery_required",
          attempt: acceptance.mismatch,
          retryable: false,
        };
      }
      const result = this.#finalizeAccepted(
        scope,
        attempt.applicationThreadId,
        attempt.attemptId,
        acceptedAt,
      );
      await acquired.actor.replayAuthoritativeCompletions();
      return result;
    } finally {
      acquired.release();
    }
  }

  async #applyInitializationActions(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    actor: Awaited<ReturnType<ConversationActorManager["acquire"]>>["actor"],
  ): Promise<void> {
    const actions = this.#persistenceForThread(
      scope,
      applicationThreadId,
    ).initializationActions(scope, applicationThreadId, attemptId);
    const operationIds = new Set<string>();
    for (const action of actions) {
      if (
        action.applicationOperationId.length === 0 ||
        operationIds.has(action.applicationOperationId)
      ) {
        throw new DomainError(
          "conflict",
          "The backend initialization plan contains an invalid operation identity.",
        );
      }
      operationIds.add(action.applicationOperationId);
      const reconciliation = await actor.reconcileAction(action);
      if (reconciliation.outcome === "accepted") continue;
      if (reconciliation.outcome === "unknown") {
        throw new BackendError({
          category: "submission_unknown",
          retryable: true,
          crossedSubmissionBoundary: true,
          safeMessage:
            "The backend initialization action outcome is still unknown.",
        });
      }
      await actor.perform(action);
    }
  }

  #finalizeAccepted(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    acceptedAt: number,
  ): LifecycleBoundResult {
    const attempt = this.#creation.get(scope, applicationThreadId, attemptId);
    if (!attempt.provisionalBackendConversationId) {
      throw new DomainError(
        "materialization_unresolved",
        "The accepted attempt has no backend conversation identity.",
      );
    }
    const persistence = this.#persistenceForThread(scope, applicationThreadId);
    const detail = attempt.provisionalOpaqueBindingDetail;
    if (!detail) {
      throw new DomainError(
        "materialization_unresolved",
        "The accepted attempt has no durable backend binding detail.",
      );
    }
    return this.#bindings.database.transaction(() => {
      const existing = this.#bindings.getBinding(scope, applicationThreadId);
      const binding =
        existing &&
        existing.backendConversationId ===
          attempt.provisionalBackendConversationId
          ? this.#bindings.completeProviderAssignedFirstSend(
              scope,
              applicationThreadId,
              {
                attemptId,
                backendConversationId:
                  attempt.provisionalBackendConversationId!,
                acceptedAt,
              },
            )
          : this.#bindings.bindCreatedConversation(scope, applicationThreadId, {
              attemptId,
              backendConversationId: attempt.provisionalBackendConversationId!,
              acceptedAt,
            });
      persistence.saveBoundBindingDetail(scope, applicationThreadId, detail);
      this.#completion.recordAccepted(scope, applicationThreadId, {
        operationId: attempt.mutationId,
        acceptedAt,
        ...(attempt.backendCorrelation
          ? { backendCorrelation: attempt.backendCorrelation }
          : {}),
        attachmentIds: attempt.initialAttachments.map(({ id }) => id),
      });
      if (attempt.completionIdentity) {
        this.#completion.observeCompletion(
          scope,
          applicationThreadId,
          attempt.mutationId,
          {
            completionIdentity: attempt.completionIdentity,
            observedAt: acceptedAt,
            createAttention: true,
          },
        );
      }
      return { status: "bound" as const, binding };
    })();
  }

  #requireRecovery(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    expected:
      | "external_call_started"
      | "conversation_identified"
      | "first_submission_started",
    error: unknown,
    reconciliationToken?: string,
  ): LifecycleRecoveryResult {
    const attempt = this.#bindings.database
      .transaction(() => {
        const transitioned = this.#creation.markRecoveryRequired(
          scope,
          applicationThreadId,
          attemptId,
          {
            expected,
            ...(reconciliationToken ? { reconciliationToken } : {}),
            diagnostic: diagnostic(error),
            now: this.#now(),
          },
        );
        return transitioned;
      })
      .immediate();
    return { status: "recovery_required", attempt, retryable: false };
  }

  #requirePreSubmissionRecovery(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    error: unknown,
  ): LifecycleRecoveryResult {
    return {
      status: "recovery_required",
      attempt: this.#creation.markRecoveryRequired(
        scope,
        applicationThreadId,
        attemptId,
        {
          expected: "conversation_identified",
          diagnostic: diagnostic(error),
          now: this.#now(),
        },
      ),
      retryable: error instanceof BackendError && error.retryable,
    };
  }

  #isPreSubmissionRecovery(
    scope: RequestScope,
    applicationThreadId: string,
    attempt: ConversationCreationAttemptRecord,
  ): boolean {
    return (
      attempt.phase === "recovery_required" &&
      attempt.provisionalBackendConversationId !== null &&
      attempt.retryAnchor === null &&
      attempt.acceptedAt === null &&
      attempt.backendCorrelation === null &&
      attempt.retryAuthorizedAt === null &&
      attempt.retryMutationId === null &&
      !this.#persistenceForThread(
        scope,
        applicationThreadId,
      ).hasSubmissionIntent(
        scope,
        applicationThreadId,
        attempt.attemptId,
        attempt.mutationId,
      )
    );
  }

  #assertTarget(
    attempt: ConversationCreationAttemptRecord,
    connection: AgentConnectionProfile,
  ): void {
    if (
      connection.tenantId !== attempt.tenantId ||
      connection.ownerPrincipalId !== attempt.ownerPrincipalId ||
      connection.id !== attempt.connectionProfileId ||
      connection.backendInstanceId !== attempt.backendInstanceId ||
      connection.executionEnvironmentId !== attempt.executionEnvironmentId
    ) {
      throw new DomainError(
        "conflict",
        "The resolved backend target does not match the durable creation attempt.",
      );
    }
  }

  async #resumeConcurrentTransition(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    expectedPhase: ConversationCreationAttemptRecord["phase"],
    error: unknown,
  ): Promise<FirstSendResult> {
    const current = this.#creation.get(scope, applicationThreadId, attemptId);
    if (current.phase === expectedPhase) {
      throw error;
    }
    return this.#recoverFirstSend(scope, applicationThreadId, attemptId);
  }

  #runAttemptOperation(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    run: () => Promise<FirstSendResult>,
    retryMutationId?: string,
  ): Promise<FirstSendResult> {
    const key = operationKey(scope, applicationThreadId, attemptId);
    const existing = this.#inFlightAttemptOperations.get(key);
    if (existing) {
      if (
        retryMutationId !== undefined &&
        existing.retryMutationId !== retryMutationId
      ) {
        return Promise.reject(
          new DomainError(
            "conflict",
            existing.retryMutationId === undefined
              ? "First-submission recovery is already in flight."
              : "A different first-submission retry is already in flight.",
          ),
        );
      }
      return existing.promise;
    }

    let promise!: Promise<FirstSendResult>;
    promise = Promise.resolve()
      .then(run)
      .finally(() => {
        if (this.#inFlightAttemptOperations.get(key)?.promise === promise) {
          this.#inFlightAttemptOperations.delete(key);
        }
      });
    this.#inFlightAttemptOperations.set(key, {
      promise,
      ...(retryMutationId === undefined ? {} : { retryMutationId }),
    });
    return promise;
  }

  async #resolveAttemptTarget(
    scope: RequestScope,
    attempt: ConversationCreationAttemptRecord,
  ): Promise<ResolvedLifecycleTarget> {
    const resolved = await this.#targets.resolve(
      scope,
      attempt.applicationThreadId,
    );
    this.#assertTarget(attempt, resolved.connection);
    const target = this.#bindings.getTarget(scope, attempt.applicationThreadId);
    const canonicalPath = this.#bindings.getWorkspaceCanonicalPath(
      scope,
      target.workspaceId,
      target.executionEnvironmentId,
    );
    if (
      resolved.workspace.summary.id !== target.workspaceId ||
      resolved.workspace.summary.environmentId !==
        target.executionEnvironmentId ||
      resolved.workspace.canonicalPath !== canonicalPath
    ) {
      throw new DomainError(
        "conflict",
        "The resolved workspace does not match the durable conversation target.",
      );
    }
    return resolved;
  }

  #persistenceForThread(
    scope: RequestScope,
    applicationThreadId: string,
  ): BackendThreadPersistenceAdapter {
    const thread = this.#bindings.findThreadDefinition(
      scope,
      applicationThreadId,
    );
    const persistence = thread
      ? this.#backendPersistence.get(thread.backendInstanceId)
      : undefined;
    if (!persistence) {
      throw new DomainError(
        "invalid_transition",
        "The thread backend persistence provider is unavailable.",
      );
    }
    return persistence;
  }
}

function submissionSource(
  attempt: ConversationCreationAttemptRecord,
): ConversationSubmissionSource {
  return attempt.sourceKind === "composer"
    ? { kind: "user" }
    : {
        kind: "automation",
        automationId: attempt.sourceAutomationId!,
        automationRunId: attempt.sourceAutomationRunId!,
      };
}

function bindingFromAttempt(
  scope: RequestScope,
  attempt: ConversationCreationAttemptRecord,
  backendConversationId: string,
  createdAt: number,
): ConversationBinding {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId: attempt.applicationThreadId,
    backendInstanceId: attempt.backendInstanceId,
    connectionProfileId: attempt.connectionProfileId,
    executionEnvironmentId: attempt.executionEnvironmentId,
    backendConversationId,
    createdAt: new Date(createdAt).toISOString(),
  };
}

function operationKey(
  scope: RequestScope,
  applicationThreadId: string,
  operationId: string,
): string {
  return JSON.stringify([
    scope.tenantId,
    scope.principalId,
    applicationThreadId,
    operationId,
  ]);
}

function diagnostic(error: unknown): string {
  const message =
    error instanceof BackendError
      ? error.safeMessage
      : error instanceof Error
        ? error.message
        : "Unknown backend lifecycle failure.";
  return message.length <= 500 ? message : message.slice(0, 500);
}
