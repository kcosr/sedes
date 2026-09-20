import type Database from "better-sqlite3";
import type { BackendKind } from "../../backends/contracts.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  AgentToolAccessBoundary,
  AgentToolPresentation,
  AgentToolPresentationOption,
} from "../../../shared/protocol/conversation.js";

export type ThreadAgentToolPresentation = AgentToolPresentation;

export interface ThreadAgentToolEligibilityPolicy {
  readonly eligibleToolIds: ReadonlySet<string>;
  presentationOptions(
    backendKind: BackendKind,
    environmentKind: "local" | "ssh" | "outbound",
  ): readonly AgentToolPresentationOption[];
}

export interface ThreadAgentToolPolicyRecord {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly enabled: boolean;
  readonly presentation: ThreadAgentToolPresentation;
  readonly accessBoundary: AgentToolAccessBoundary;
  readonly revision: number;
  readonly updatedAt: number;
  readonly enabledToolIds: readonly string[];
}

type PolicyRow = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly enabled: 0 | 1;
  readonly presentationSurface: ThreadAgentToolPresentation["surface"];
  readonly presentationMode: ThreadAgentToolPresentation["mode"];
  readonly accessBoundary: AgentToolAccessBoundary;
  readonly revision: number;
  readonly updatedAt: number;
  readonly backendKind: BackendKind;
  readonly environmentKind: "local" | "ssh" | "outbound";
};

const policyColumns = `
  policy.tenant_id AS tenantId,
  policy.owner_principal_id AS ownerPrincipalId,
  policy.application_thread_id AS applicationThreadId,
  policy.enabled,
  policy.presentation_surface AS presentationSurface,
  policy.presentation_mode AS presentationMode,
  policy.access_boundary AS accessBoundary,
  policy.revision,
  policy.updated_at AS updatedAt,
  backend.kind AS backendKind,
  environment.kind AS environmentKind
`;

function sortedDistinctToolIds(toolIds: readonly string[]): string[] {
  const sorted = [...toolIds].sort((left, right) => left.localeCompare(right));
  for (let index = 0; index < sorted.length; index += 1) {
    const toolId = sorted[index]!;
    if (
      toolId.length < 1 ||
      toolId.length > 128 ||
      (index > 0 && toolId === sorted[index - 1])
    ) {
      throw new DomainError(
        "invalid_transition",
        "The agent tool policy contains an invalid or duplicated tool ID.",
      );
    }
  }
  return sorted;
}

export class ThreadAgentToolPolicyRepository {
  constructor(
    readonly database: Database.Database,
    readonly eligibility: ThreadAgentToolEligibilityPolicy,
  ) {}

  get(
    scope: RequestScope,
    applicationThreadId: string,
  ): ThreadAgentToolPolicyRecord {
    const row = this.#row(scope, applicationThreadId);
    if (!row) {
      throw new DomainError(
        "not_found",
        "The thread agent tool policy was not found.",
      );
    }
    return this.#record(scope, row, true);
  }

  /**
   * Reads the complete durable enabled-ID set for configuration capture.
   * Unlike the runtime/browser projection, this does not silently omit tools
   * that left the current catalog; the caller can revalidate and fail closed.
   */
  getDurable(
    scope: RequestScope,
    applicationThreadId: string,
  ): ThreadAgentToolPolicyRecord {
    const row = this.#row(scope, applicationThreadId);
    if (!row) {
      throw new DomainError(
        "not_found",
        "The thread agent tool policy was not found.",
      );
    }
    return this.#record(scope, row, false);
  }

  /**
   * Replaces the trigger-created policy while a new thread is still inside
   * its caller-owned creation transaction. This is initialization, not a
   * user-visible policy mutation, so the stored revision remains zero.
   */
  initialize(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly enabled: boolean;
      readonly presentation: ThreadAgentToolPresentation;
      readonly accessBoundary: AgentToolAccessBoundary;
      readonly enabledToolIds: readonly string[];
      readonly now: number;
    },
  ): ThreadAgentToolPolicyRecord {
    if (!this.database.inTransaction) {
      throw new Error(
        "thread_agent_tool_policy_initialization_outside_transaction",
      );
    }
    const row = this.#row(scope, applicationThreadId);
    if (!row || row.revision !== 0) {
      throw new DomainError(
        "conflict",
        "The initial agent tool policy is unavailable.",
      );
    }
    const existingEntry = this.database
      .prepare(
        `
          SELECT 1 AS present
          FROM thread_agent_tool_policy_entries
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
          LIMIT 1
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId);
    if (existingEntry) {
      throw new DomainError(
        "conflict",
        "The initial agent tool policy has already been configured.",
      );
    }
    const enabledToolIds = this.#validate(
      row.backendKind,
      row.environmentKind,
      input.presentation,
      input.enabledToolIds,
    );
    this.#validateAccessBoundary(input.accessBoundary);
    const changed = this.database
      .prepare(
        `
          UPDATE thread_agent_tool_policies
          SET enabled = ?, presentation_surface = ?, presentation_mode = ?,
            access_boundary = ?, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND revision = 0
        `,
      )
      .run(
        input.enabled ? 1 : 0,
        input.presentation.surface,
        input.presentation.mode,
        input.accessBoundary,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
      );
    if (changed.changes !== 1) {
      throw new DomainError(
        "conflict",
        "The initial agent tool policy changed before it was configured.",
      );
    }
    const insert = this.database.prepare(
      `
        INSERT INTO thread_agent_tool_policy_entries(
          tenant_id, owner_principal_id, application_thread_id, tool_id
        ) VALUES (?, ?, ?, ?)
      `,
    );
    for (const toolId of enabledToolIds) {
      insert.run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        toolId,
      );
    }
    return this.get(scope, applicationThreadId);
  }

  update(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly enabled: boolean;
      readonly presentation: ThreadAgentToolPresentation;
      readonly accessBoundary: AgentToolAccessBoundary;
      readonly enabledToolIds: readonly string[];
      readonly now: number;
    },
  ): ThreadAgentToolPolicyRecord {
    const update = this.database.transaction(() => {
      const row = this.#row(scope, applicationThreadId);
      if (!row) {
        throw new DomainError(
          "not_found",
          "The thread agent tool policy was not found.",
        );
      }
      const enabledToolIds = this.#validate(
        row.backendKind,
        row.environmentKind,
        input.presentation,
        input.enabledToolIds,
      );
      this.#validateAccessBoundary(input.accessBoundary);
      const changed = this.database
        .prepare(
          `
            UPDATE thread_agent_tool_policies
            SET enabled = ?, presentation_surface = ?, presentation_mode = ?,
              access_boundary = ?,
              revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND revision = ?
          `,
        )
        .run(
          input.enabled ? 1 : 0,
          input.presentation.surface,
          input.presentation.mode,
          input.accessBoundary,
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.expectedRevision,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The thread agent tool policy changed in another client.",
        );
      }
      this.database
        .prepare(
          `
            DELETE FROM thread_agent_tool_policy_entries
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, applicationThreadId);
      const insert = this.database.prepare(
        `
          INSERT INTO thread_agent_tool_policy_entries(
            tenant_id, owner_principal_id, application_thread_id, tool_id
          ) VALUES (?, ?, ?, ?)
        `,
      );
      for (const toolId of enabledToolIds) {
        insert.run(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          toolId,
        );
      }
      return this.get(scope, applicationThreadId);
    });
    return update.immediate();
  }

  #row(
    scope: RequestScope,
    applicationThreadId: string,
  ): PolicyRow | undefined {
    return this.database
      .prepare(
        `
          SELECT ${policyColumns}
          FROM thread_agent_tool_policies AS policy
          JOIN application_threads AS thread
            ON thread.tenant_id = policy.tenant_id
            AND thread.owner_principal_id = policy.owner_principal_id
            AND thread.id = policy.application_thread_id
          JOIN agent_backend_instances AS backend
            ON backend.tenant_id = thread.tenant_id
            AND backend.id = thread.backend_instance_id
          JOIN execution_environments AS environment
            ON environment.tenant_id = thread.tenant_id
            AND environment.owner_principal_id = thread.owner_principal_id
            AND environment.id = thread.environment_id
          WHERE policy.tenant_id = ? AND policy.owner_principal_id = ?
            AND policy.application_thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      PolicyRow | undefined;
  }

  #record(
    scope: RequestScope,
    row: PolicyRow,
    filterCurrentEligibility: boolean,
  ): ThreadAgentToolPolicyRecord {
    if (
      !this.eligibility
        .presentationOptions(row.backendKind, row.environmentKind)
        .some(
          ({ surface, modes }) =>
            surface === row.presentationSurface &&
            modes.includes(row.presentationMode),
        )
    ) {
      throw new DomainError(
        "invalid_transition",
        "The stored agent tool presentation is unavailable for the thread target.",
      );
    }
    const storedToolIds = (
      this.database
        .prepare(
          `
            SELECT tool_id AS toolId
            FROM thread_agent_tool_policy_entries
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ?
            ORDER BY tool_id
          `,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          row.applicationThreadId,
        ) as Array<{ readonly toolId: string }>
    ).map(({ toolId }) => toolId);
    // Eligibility is enforced when policy is written. On read, omit entries
    // that are no longer in the current catalog so a later catalog shrink
    // cannot make the thread snapshot (and therefore runtime attach) fail.
    // The durable rows remain available for operator inspection and a later
    // revision-checked update replaces the exact set.
    const durableToolIds = sortedDistinctToolIds(storedToolIds);
    const enabledToolIds = filterCurrentEligibility
      ? durableToolIds.filter((toolId) =>
          this.eligibility.eligibleToolIds.has(toolId),
        )
      : durableToolIds;
    return {
      tenantId: row.tenantId,
      ownerPrincipalId: row.ownerPrincipalId,
      applicationThreadId: row.applicationThreadId,
      enabled: row.enabled === 1,
      presentation: {
        surface: row.presentationSurface,
        mode: row.presentationMode,
      },
      accessBoundary: row.accessBoundary,
      revision: row.revision,
      updatedAt: row.updatedAt,
      enabledToolIds,
    };
  }

  #validate(
    backendKind: BackendKind,
    environmentKind: "local" | "ssh" | "outbound",
    presentation: ThreadAgentToolPresentation,
    rawToolIds: readonly string[],
  ): string[] {
    if (
      (presentation.surface !== "native" && presentation.surface !== "cli") ||
      (presentation.mode !== "progressive" &&
        presentation.mode !== "individual")
    ) {
      throw new DomainError(
        "invalid_transition",
        "The agent tool presentation mode is invalid.",
      );
    }
    const presentationOptions = this.eligibility.presentationOptions(
      backendKind,
      environmentKind,
    );
    if (
      presentationOptions.length === 0 ||
      new Set(presentationOptions.map(({ surface }) => surface)).size !==
        presentationOptions.length ||
      presentationOptions.some(
        ({ modes }) => new Set(modes).size !== modes.length,
      ) ||
      !presentationOptions.some(
        ({ surface, modes }) =>
          surface === presentation.surface && modes.includes(presentation.mode),
      )
    ) {
      throw new DomainError(
        "invalid_transition",
        "This agent tool presentation is unavailable for the thread target.",
      );
    }
    const toolIds = sortedDistinctToolIds(rawToolIds);
    if (
      toolIds.some((toolId) => !this.eligibility.eligibleToolIds.has(toolId))
    ) {
      throw new DomainError(
        "invalid_transition",
        "The agent tool policy contains an ineligible tool.",
      );
    }
    return toolIds;
  }

  presentationOptions(
    scope: RequestScope,
    applicationThreadId: string,
  ): readonly AgentToolPresentationOption[] {
    const row = this.#row(scope, applicationThreadId);
    if (!row) {
      throw new DomainError(
        "not_found",
        "The thread agent tool policy was not found.",
      );
    }
    const options = this.eligibility.presentationOptions(
      row.backendKind,
      row.environmentKind,
    );
    if (
      options.length === 0 ||
      new Set(options.map(({ surface }) => surface)).size !== options.length ||
      options.some(({ modes }) => new Set(modes).size !== modes.length)
    ) {
      throw new Error("thread_agent_tool_presentation_options_invalid");
    }
    return Object.freeze([...options]);
  }

  #validateAccessBoundary(value: AgentToolAccessBoundary): void {
    if (
      value !== "thread" &&
      value !== "environment" &&
      value !== "unrestricted"
    ) {
      throw new DomainError(
        "invalid_transition",
        "The agent tool access boundary is invalid.",
      );
    }
  }
}
