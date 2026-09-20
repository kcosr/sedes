import type Database from "better-sqlite3";
import {
  BACKEND_BRANDS,
  type AgentBackendInstance,
  type AgentConnectionProfile,
  type BackendCatalog,
  type BackendKind,
} from "../backends/contracts.js";
import type { BackendEffectiveSettings } from "../../shared/protocol/backend.js";
import type {
  NormalizedThreadAttention,
  NormalizedThreadExecutionWorkspace,
  NormalizedThreadSummary,
} from "../../shared/protocol/conversation.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { QueuedInputRepository } from "../db/repositories/queued-input-repository.js";
import type { SubmissionCompletionRepository } from "../db/repositories/submission-completion-repository.js";
import type { ThreadAgentToolPolicyRepository } from "../db/repositories/thread-agent-tool-policy-repository.js";
import type { ToolEffects } from "../agent-tools/contracts/agent-tool-contracts.js";
import { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import {
  environmentAdmitsForegroundOperation,
  environmentOperationalState,
} from "../domain/environment-operational-state.js";
import type { ValidatedWorkspace } from "../execution/contracts.js";
import type { DatabaseConversationTargetStore } from "./database-conversation-adapters.js";
import { boundDisplayText } from "./payload-policy.js";
import type {
  AuthorizedThreadApplicationState,
  ThreadApplicationInventoryReader,
  ThreadApplicationPresentation,
  ThreadApplicationPresentationReader,
} from "./thread-application-service.js";

type InventoryThread = Omit<
  NormalizedThreadSummary,
  "runState" | "queuedInputCount"
>;

export interface ThreadAgentToolCatalogReader {
  list(): {
    readonly groups: readonly {
      readonly id: string;
      readonly label: string;
      readonly description: string;
      readonly order: number;
      readonly tools: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
        readonly order: number;
        readonly effects: ToolEffects;
        readonly available: boolean;
        readonly unavailableReason?: string;
      }[];
    }[];
  };
}

export interface ThreadExecutionWorkspaceReader {
  read(
    scope: RequestScope,
    applicationThreadId: string,
  ): NormalizedThreadExecutionWorkspace;
}

export const directThreadExecutionWorkspaceReader: ThreadExecutionWorkspaceReader =
  Object.freeze({
    read: () => ({ kind: "direct" as const }),
  });

type AutomationRow = {
  readonly status: "enabled" | "paused";
  readonly runMode: "same_thread" | "clone";
  readonly scheduleKind: "date_time" | "interval" | "cron";
  readonly nextRunAt: number | null;
  readonly revision: number;
  readonly hasPrecheck: 0 | 1;
  readonly runId: string | null;
  readonly runState:
    | "claimed"
    | "dispatching"
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "skipped"
    | "uncertain"
    | null;
  readonly occurrence: "scheduled" | "manual" | null;
  readonly scheduledFor: number | null;
  readonly finishedAt: number | null;
  readonly resultThreadId: string | null;
  readonly errorCode: string | null;
};

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function automation(
  database: Database.Database,
  scope: RequestScope,
  applicationThreadId: string,
): InventoryThread["automation"] {
  const row = database
    .prepare(
      `
        SELECT
          CASE WHEN definition.enabled = 1 THEN 'enabled' ELSE 'paused' END
            AS status,
          definition.run_mode AS runMode,
          definition.schedule_kind AS scheduleKind,
          definition.next_run_at AS nextRunAt,
          definition.revision,
          CASE WHEN definition.precheck_command IS NULL THEN 0 ELSE 1 END
            AS hasPrecheck,
          run.id AS runId, run.state AS runState,
          run.occurrence_kind AS occurrence,
          run.scheduled_for AS scheduledFor,
          run.finished_at AS finishedAt,
          coalesce(run.child_thread_id, run.anchor_thread_id) AS resultThreadId,
          run.error_code AS errorCode
        FROM automation_definitions AS definition
        LEFT JOIN automation_runs AS run
          ON run.tenant_id = definition.tenant_id
          AND run.owner_principal_id = definition.owner_principal_id
          AND run.automation_id = definition.id
          AND run.id = (
            SELECT candidate.id
            FROM automation_runs AS candidate
            WHERE candidate.tenant_id = definition.tenant_id
              AND candidate.owner_principal_id =
                definition.owner_principal_id
              AND candidate.automation_id = definition.id
            ORDER BY candidate.scheduled_for DESC,
              candidate.created_at DESC, candidate.id DESC
            LIMIT 1
          )
        WHERE definition.tenant_id = ?
          AND definition.owner_principal_id = ?
          AND definition.anchor_thread_id = ?
          AND definition.deleted_at IS NULL
      `,
    )
    .get(scope.tenantId, scope.principalId, applicationThreadId) as
    AutomationRow | undefined;
  if (!row) return null;
  return {
    status: row.status,
    runMode: row.runMode,
    scheduleKind: row.scheduleKind,
    ...(row.nextRunAt === null ? {} : { nextRunAt: iso(row.nextRunAt) }),
    revision: row.revision,
    hasPrecheck: row.hasPrecheck === 1,
    ...(row.runId === null ||
    row.runState === null ||
    row.occurrence === null ||
    row.scheduledFor === null
      ? {}
      : {
          lastRun: {
            id: row.runId,
            state: row.runState,
            occurrence: row.occurrence,
            scheduledFor: iso(row.scheduledFor),
            ...(row.finishedAt === null
              ? {}
              : { finishedAt: iso(row.finishedAt) }),
            ...(row.resultThreadId === null
              ? {}
              : { resultThreadId: row.resultThreadId }),
            ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
          },
        }),
  };
}

/**
 * Principal-scoped schema-10 inventory projection used as the authorization
 * boundary for normalized thread snapshots.
 */
export class DatabaseThreadApplicationInventoryReader implements ThreadApplicationInventoryReader {
  readonly #database: Database.Database;
  readonly #inventory: InventoryRepository;
  readonly #queue: QueuedInputRepository;
  readonly #completion: SubmissionCompletionRepository;
  readonly #agentTools: ThreadAgentToolPolicyRepository;
  readonly #agentToolCatalog: ThreadAgentToolCatalogReader;
  readonly #bindings: ConversationBindingRepository;
  readonly #directoryBrowsingAvailability: (
    scope: RequestScope,
    environmentId: string,
  ) => "available" | "unavailable";
  readonly #executionWorkspaces: ThreadExecutionWorkspaceReader;

  constructor(input: {
    readonly inventory: InventoryRepository;
    readonly queue: QueuedInputRepository;
    readonly completion: SubmissionCompletionRepository;
    readonly agentTools: ThreadAgentToolPolicyRepository;
    readonly agentToolCatalog: ThreadAgentToolCatalogReader;
    readonly directoryBrowsingAvailability: (
      scope: RequestScope,
      environmentId: string,
    ) => "available" | "unavailable";
    readonly executionWorkspaces: ThreadExecutionWorkspaceReader;
  }) {
    if (
      input.inventory.database !== input.queue.database ||
      input.inventory.database !== input.completion.database ||
      input.inventory.database !== input.agentTools.database
    ) {
      throw new Error("thread_application_inventory_database_mismatch");
    }
    this.#database = input.inventory.database;
    this.#inventory = input.inventory;
    this.#queue = input.queue;
    this.#completion = input.completion;
    this.#agentTools = input.agentTools;
    this.#agentToolCatalog = input.agentToolCatalog;
    this.#directoryBrowsingAvailability = input.directoryBrowsingAvailability;
    this.#executionWorkspaces = input.executionWorkspaces;
    this.#bindings = new ConversationBindingRepository(this.#database);
  }

  async getAuthorized(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<AuthorizedThreadApplicationState> {
    const aggregate = this.#inventory.getThread(scope, applicationThreadId);
    const workspace = this.#inventory.getWorkspace(
      scope,
      aggregate.thread.workspaceId,
    );
    const environment = this.#inventory.getEnvironment(
      scope,
      aggregate.thread.environmentId,
    );
    const stashes = this.#inventory.listStashes(scope, applicationThreadId);
    const binding = this.#bindings.getBinding(scope, applicationThreadId);
    const savedAgentOrigin = this.#database
      .prepare(
        `
          SELECT origin.agent_id AS agentId,
            origin.agent_revision AS agentRevision,
            origin.agent_name AS agentName,
            CASE WHEN agent.id IS NULL THEN 0 ELSE 1 END AS agentAvailable
          FROM thread_saved_agent_origins AS origin
          LEFT JOIN saved_agents AS agent
            ON agent.tenant_id = origin.tenant_id
            AND agent.owner_principal_id = origin.owner_principal_id
            AND agent.id = origin.agent_id
          WHERE origin.tenant_id = ? AND origin.owner_principal_id = ?
            AND origin.thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      | {
          readonly agentId: string;
          readonly agentRevision: number;
          readonly agentName: string;
          readonly agentAvailable: 0 | 1;
        }
      | undefined;
    const backend = this.#database
      .prepare(
        `
          SELECT kind, label
          FROM agent_backend_instances
          WHERE tenant_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, aggregate.thread.backendInstanceId) as
      { readonly kind: BackendKind; readonly label: string } | undefined;
    if (!backend) {
      throw new DomainError(
        "not_found",
        "The thread backend instance was not found.",
      );
    }
    const agentTools = this.#agentTools.get(scope, applicationThreadId);
    const enabledAgentToolIds = new Set(agentTools.enabledToolIds);
    const agentToolCatalog = this.#agentToolCatalog.list();
    const available =
      aggregate.thread.availability === "available" &&
      workspace.availability === "available" &&
      environmentAdmitsForegroundOperation(environment);
    const thread: InventoryThread = {
      id: aggregate.thread.id,
      workspaceId: aggregate.thread.workspaceId,
      targetId: aggregate.thread.connectionProfileId,
      title: boundDisplayText(aggregate.thread.title),
      backend: {
        label: boundDisplayText(backend.label),
        brand: BACKEND_BRANDS[backend.kind],
      },
      backingState: aggregate.thread.backingState,
      inventoryState: aggregate.inventory.inventoryState,
      inventoryRevision: aggregate.inventory.inventoryRevision,
      threadRevision: aggregate.thread.revision,
      available,
      lastActivityAt: iso(aggregate.thread.lastActivityAt),
      stateChangedAt: iso(aggregate.inventory.stateChangedAt),
      ...(aggregate.inventory.snoozedUntil === null
        ? {}
        : { snoozedUntil: iso(aggregate.inventory.snoozedUntil) }),
      automation: automation(this.#database, scope, applicationThreadId),
    };
    return {
      tenantId: aggregate.thread.tenantId,
      ownerPrincipalId: aggregate.thread.ownerPrincipalId,
      backendInstanceId: aggregate.thread.backendInstanceId,
      ...(binding ? { backendSessionId: binding.backendConversationId } : {}),
      thread,
      executionWorkspace: this.#executionWorkspaces.read(
        scope,
        applicationThreadId,
      ),
      ...(savedAgentOrigin
        ? {
            createdWithAgent: {
              id: savedAgentOrigin.agentId,
              revision: savedAgentOrigin.agentRevision,
              name: boundDisplayText(savedAgentOrigin.agentName),
              available: savedAgentOrigin.agentAvailable === 1,
            },
          }
        : {}),
      workspace: {
        id: workspace.id,
        environmentId: workspace.environmentId,
        label: boundDisplayText(workspace.displayName),
        displayPath: boundDisplayText(workspace.canonicalPath),
        available: workspace.availability === "available" && !this.#inventory.isWorkspaceRemoved(scope, workspace.id),
      },
      environment: {
        id: environment.id,
        kind: environment.kind,
        label: boundDisplayText(environment.label),
        available: environmentAdmitsForegroundOperation(environment),
        directoryBrowsing: this.#directoryBrowsingAvailability(
          scope,
          environment.id,
        ),
        ...(environmentOperationalState(environment) !== "unavailable"
          ? {}
          : { diagnostic: boundDisplayText(environment.diagnosticCode) }),
      },
      draft: {
        text: aggregate.draft.text,
        ...(aggregate.draft.selectedSkillId === null
          ? {}
          : { selectedSkillId: aggregate.draft.selectedSkillId }),
        contextExcerpts: aggregate.draft.contextExcerpts,
        attachments: aggregate.draft.attachments,
        taskReferences: aggregate.draft.taskReferences,
        revision: aggregate.draft.revision,
        updatedAt: iso(aggregate.draft.updatedAt),
      },
      stashes: stashes.map((stash) => ({
        id: stash.id,
        text: stash.text,
        ...(stash.selectedSkillId === null
          ? {}
          : { selectedSkillId: stash.selectedSkillId }),
        contextExcerpts: stash.contextExcerpts,
        attachments: stash.attachments,
        taskReferences: stash.taskReferences,
        createdAt: iso(stash.createdAt),
      })),
      agentTools: {
        enabled: agentTools.enabled,
        accessBoundary: agentTools.accessBoundary,
        groups: [...agentToolCatalog.groups]
          .sort(
            (left, right) =>
              left.order - right.order || left.id.localeCompare(right.id),
          )
          .map((group) => ({
            id: group.id,
            label: boundDisplayText(group.label),
            description: boundDisplayText(group.description),
            order: group.order,
            tools: [...group.tools]
              .sort(
                (left, right) =>
                  left.order - right.order || left.id.localeCompare(right.id),
              )
              .map((tool) => ({
                id: tool.id,
                label: boundDisplayText(tool.label),
                ...(tool.description
                  ? { description: boundDisplayText(tool.description) }
                  : {}),
                order: tool.order,
                effects: tool.effects,
                enabled: enabledAgentToolIds.has(tool.id),
                available: tool.available,
                ...(tool.unavailableReason
                  ? {
                      unavailableReason: boundDisplayText(
                        tool.unavailableReason,
                      ),
                    }
                  : {}),
              })),
          })),
        presentation: agentTools.presentation,
        presentationOptions: [
          ...this.#agentTools.presentationOptions(scope, applicationThreadId),
        ],
        revision: agentTools.revision,
      },
      attention: this.#attention(
        scope,
        applicationThreadId,
        aggregate.inventory,
      ),
    };
  }

  #attention(
    scope: RequestScope,
    applicationThreadId: string,
    inventory: ReturnType<InventoryRepository["getInventory"]>,
  ): NormalizedThreadAttention {
    const completion = this.#completion
      .listUnacknowledged(scope)
      .filter(
        ({ applicationThreadId: threadId }) => threadId === applicationThreadId,
      )
      .at(-1);
    const queueFailure = this.#queue.getFailureAttention(
      scope,
      applicationThreadId,
    );
    return {
      ...(inventory.wokeAt !== null &&
      (inventory.wakeAcknowledgedAt === null ||
        inventory.wakeAcknowledgedAt < inventory.wokeAt)
        ? {
            wake: {
              wokeAt: iso(inventory.wokeAt),
              ...(inventory.wakeReminderText === null
                ? {}
                : { text: boundDisplayText(inventory.wakeReminderText) }),
            },
          }
        : {}),
      ...(inventory.automationContextRunId &&
      inventory.automationContextSourceThreadId &&
      inventory.automationContextAt !== null &&
      inventory.automationContextOutcome
        ? {
            automationContext: {
              runId: inventory.automationContextRunId,
              sourceThreadId: inventory.automationContextSourceThreadId,
              triggeredAt: iso(inventory.automationContextAt),
              outcome: inventory.automationContextOutcome,
              ...(inventory.automationContextDiagnostic === null
                ? {}
                : {
                    diagnostic: boundDisplayText(
                      inventory.automationContextDiagnostic,
                    ),
                  }),
            },
          }
        : {}),
      ...(completion?.attentionCreatedAt === null ||
      completion?.attentionCreatedAt === undefined
        ? {}
        : {
            unseenCompletion: {
              operationId: completion.operationId,
              completedAt: iso(completion.attentionCreatedAt),
            },
          }),
      ...(queueFailure
        ? {
            queueFailure: {
              queuedInputId: queueFailure.queuedInputId,
              failedAt: iso(queueFailure.failedAt),
              diagnostic: boundDisplayText(queueFailure.diagnostic),
            },
          }
        : {}),
    };
  }
}

export interface ThreadBackendPresentationProvider {
  read(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly backend: AgentBackendInstance;
    readonly connection: AgentConnectionProfile;
    readonly workspace?: ValidatedWorkspace;
    readonly catalog?: BackendCatalog;
    readonly effectiveSettings?: BackendEffectiveSettings;
  }): Promise<ThreadApplicationPresentation>;
}

/**
 * Resolves the durable target before delegating presentation to the selected
 * backend. The normalized application service never reads Pi settings or
 * native catalogs directly.
 */
export class DatabaseThreadApplicationPresentationReader implements ThreadApplicationPresentationReader {
  static readonly maximumCachedCatalogs = 256;
  readonly #targets: DatabaseConversationTargetStore;
  readonly #providers: ReadonlyMap<string, ThreadBackendPresentationProvider>;
  readonly #catalogs = new Map<
    string,
    { readonly targetRevision: string; readonly catalog: BackendCatalog }
  >();

  constructor(input: {
    readonly targets: DatabaseConversationTargetStore;
    readonly providers: ReadonlyMap<string, ThreadBackendPresentationProvider>;
  }) {
    this.#targets = input.targets;
    this.#providers = input.providers;
  }

  async read(
    scope: RequestScope,
    applicationThreadId: string,
    effectiveSettings?: BackendEffectiveSettings,
  ): Promise<ThreadApplicationPresentation> {
    const target = await this.#targets.presentationForThread(
      scope,
      applicationThreadId,
    );
    const catalog =
      target.workspace && target.driver
        ? await target.driver.catalog({ scope, workspace: target.workspace })
        : undefined;
    if (catalog) {
      const key = this.#key(scope, applicationThreadId);
      this.#catalogs.delete(key);
      this.#catalogs.set(key, {
        targetRevision: this.#targetRevision(target),
        catalog,
      });
      while (
        this.#catalogs.size >
        DatabaseThreadApplicationPresentationReader.maximumCachedCatalogs
      ) {
        const oldest = this.#catalogs.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#catalogs.delete(oldest);
      }
    }
    return this.#readProvider(
      scope,
      applicationThreadId,
      target,
      catalog,
      effectiveSettings,
    );
  }

  async readCached(
    scope: RequestScope,
    applicationThreadId: string,
    effectiveSettings?: BackendEffectiveSettings,
  ): Promise<ThreadApplicationPresentation> {
    const target = await this.#targets.presentationForThread(
      scope,
      applicationThreadId,
    );
    let catalog: BackendCatalog | undefined;
    if (target.workspace && target.driver) {
      const cached = this.#catalogs.get(this.#key(scope, applicationThreadId));
      if (cached?.targetRevision === this.#targetRevision(target)) {
        const key = this.#key(scope, applicationThreadId);
        this.#catalogs.delete(key);
        this.#catalogs.set(key, cached);
        catalog = cached.catalog;
      }
    }
    return this.#readProvider(
      scope,
      applicationThreadId,
      target,
      catalog,
      effectiveSettings,
    );
  }

  async #readProvider(
    scope: RequestScope,
    applicationThreadId: string,
    target: Awaited<
      ReturnType<DatabaseConversationTargetStore["presentationForThread"]>
    >,
    catalog: BackendCatalog | undefined,
    effectiveSettings: BackendEffectiveSettings | undefined,
  ): Promise<ThreadApplicationPresentation> {
    const provider = this.#providers.get(target.backend.id);
    if (!provider) {
      throw new DomainError(
        "not_found",
        "The thread presentation provider is not registered.",
      );
    }
    return provider.read({
      scope,
      applicationThreadId,
      backend: target.backend,
      connection: target.connection,
      ...(target.workspace ? { workspace: target.workspace } : {}),
      ...(catalog ? { catalog } : {}),
      ...(effectiveSettings ? { effectiveSettings } : {}),
    });
  }

  #key(scope: RequestScope, applicationThreadId: string): string {
    return `${scope.tenantId}\0${scope.principalId}\0${applicationThreadId}`;
  }

  #targetRevision(
    target: Awaited<
      ReturnType<DatabaseConversationTargetStore["presentationForThread"]>
    >,
  ): string {
    return JSON.stringify([
      target.backend.id,
      target.backend.configurationRevision,
      target.connection.id,
      target.connection.configurationRevision,
      target.workspace?.summary.id,
      target.workspace?.summary.revision,
      target.workspace?.authorityRevision,
      target.workspace?.canonicalPath,
    ]);
  }
}
