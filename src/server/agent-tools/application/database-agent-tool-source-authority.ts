import type Database from "better-sqlite3";
import type { BackendKind } from "../../backends/contracts.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { TrustedAgentToolSource } from "../adapters/backend-facade.js";
import type {
  AgentToolEnvironmentAuthorityReader,
  EnvironmentAuthorityResourceFact,
  EnvironmentAuthorityTaskFact,
} from "../environment/environment-authority.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-inline-agent-tool-service.js";
import {
  ThreadSourceReferenceCodec,
  type ThreadSourceReferenceAudience,
} from "./thread-source-reference.js";

type ScopedThreadFacts = {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly backendKind: BackendKind;
};

export interface EnvironmentScopedAgentToolSourceResolver {
  resolveCapabilityInExecutionEnvironment(
    scope: RequestScope,
    executionEnvironmentId: string,
    sourceCapability: string,
    signal: AbortSignal,
  ): Promise<TrustedAgentToolSource> | TrustedAgentToolSource;
}

export type AgentToolSourceCapabilityTransport =
  | "management_http"
  | "execution_environment_sidecar";

export interface AgentToolSourceCapabilityIssuer {
  issue(
    source: TrustedAgentToolSource,
    transport: AgentToolSourceCapabilityTransport,
  ): string;
}

/**
 * Resolves caller attribution exclusively beneath server-owned scope. The
 * execution-environment form additionally binds a sidecar claim to the
 * environment that owns its carrier; the supplied thread ID is never scope
 * authority by itself.
 */
export class DatabaseAgentToolSourceAuthority
  implements
    EnvironmentScopedAgentToolSourceResolver,
    AgentToolSourceCapabilityIssuer,
    AgentToolEnvironmentAuthorityReader
{
  readonly #references: ThreadSourceReferenceCodec;

  constructor(
    readonly database: Database.Database,
    installationKey: Uint8Array,
  ) {
    this.#references = new ThreadSourceReferenceCodec(installationKey);
  }

  issue(
    source: TrustedAgentToolSource,
    transport: AgentToolSourceCapabilityTransport,
  ): string {
    if (
      transport !== "management_http" &&
      transport !== "execution_environment_sidecar"
    ) {
      throw new Error("agent_tool_source_capability_transport_invalid");
    }
    const current = this.#resolve(
      source.scope,
      source.sourceThreadId,
      source.sourceEnvironmentId,
      new AbortController().signal,
    );
    if (
      current.sourceWorkspaceId !== source.sourceWorkspaceId ||
      current.backendKind !== source.backendKind
    ) {
      throw new CanonicalAgentToolRequestError(
        "permission_denied",
        "The agent-tool runtime source does not match live application state.",
      );
    }
    return this.#references.issue(source.scope, source.sourceThreadId, transport);
  }

  resolveInScope(
    scope: RequestScope,
    sourceThreadId: string,
    signal: AbortSignal,
  ): TrustedAgentToolSource {
    return this.#resolve(scope, sourceThreadId, undefined, signal);
  }

  resolveCapabilityInScope(
    scope: RequestScope,
    sourceCapability: string,
    signal: AbortSignal,
  ): TrustedAgentToolSource {
    return this.#resolveCapability(
      scope,
      sourceCapability,
      "management_http",
      undefined,
      signal,
    );
  }

  resolveCapabilityInExecutionEnvironment(
    scope: RequestScope,
    executionEnvironmentId: string,
    sourceCapability: string,
    signal: AbortSignal,
  ): TrustedAgentToolSource {
    if (!executionEnvironmentId) {
      throw new Error("agent_tool_source_environment_required");
    }
    return this.#resolveCapability(
      scope,
      sourceCapability,
      "execution_environment_sidecar",
      executionEnvironmentId,
      signal,
    );
  }

  resolveEnvironment(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityResourceFact | undefined {
    return this.database
      .prepare(
        `
          SELECT id, id AS environmentId, label
          FROM execution_environments
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, id) as
      EnvironmentAuthorityResourceFact | undefined;
  }

  resolveWorkspace(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityResourceFact | undefined {
    return this.database
      .prepare(
        `
          SELECT id, environment_id AS environmentId, display_name AS label
          FROM workspaces
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, id) as
      EnvironmentAuthorityResourceFact | undefined;
  }

  resolveThread(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityResourceFact | undefined {
    return this.database
      .prepare(
        `
          SELECT id, environment_id AS environmentId,
            workspace_id AS workspaceId, title AS label
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, id) as
      EnvironmentAuthorityResourceFact | undefined;
  }

  resolveThreadFamily(
    scope: RequestScope,
    id: string,
  ): readonly EnvironmentAuthorityResourceFact[] | undefined {
    const source = this.resolveThread(scope, id);
    if (!source) return undefined;
    const descendants = this.database
      .prepare(
        `
          SELECT thread.id, thread.environment_id AS environmentId,
            thread.workspace_id AS workspaceId, thread.title AS label
          FROM thread_lineage_closure AS lineage
          JOIN application_threads AS thread
            ON thread.tenant_id = lineage.tenant_id
            AND thread.owner_principal_id = lineage.owner_principal_id
            AND thread.id = lineage.descendant_thread_id
          WHERE lineage.tenant_id = ? AND lineage.owner_principal_id = ?
            AND lineage.ancestor_thread_id = ?
          ORDER BY thread.id
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        id,
      ) as EnvironmentAuthorityResourceFact[];
    return Object.freeze([source, ...descendants]);
  }

  resolveSavedAgent(
    scope: RequestScope,
    id: string,
  ): { readonly id: string; readonly revision: number; readonly label: string } | undefined {
    return this.database
      .prepare(
        `SELECT id, revision, name AS label
         FROM saved_agents
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.principalId, id) as
      { readonly id: string; readonly revision: number; readonly label: string } | undefined;
  }

  resolveTask(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityTaskFact | undefined {
    return this.database
      .prepare(
        `
          SELECT task.id, task.revision, task.scope_kind AS scopeKind,
            CASE
              WHEN task.scope_kind = 'thread' THEN thread.environment_id
              WHEN task.scope_kind = 'workspace' THEN workspace.environment_id
              ELSE NULL
            END AS environmentId,
            task.workspace_id AS workspaceId, task.thread_id AS threadId,
            task.title AS label
          FROM tasks AS task
          LEFT JOIN application_threads AS thread
            ON thread.tenant_id = task.tenant_id
            AND thread.owner_principal_id = task.owner_principal_id
            AND thread.id = task.thread_id
          LEFT JOIN workspaces AS workspace
            ON workspace.tenant_id = task.tenant_id
            AND workspace.owner_principal_id = task.owner_principal_id
            AND workspace.id = task.workspace_id
          WHERE task.tenant_id = ? AND task.owner_principal_id = ?
            AND task.id = ?
            AND (task.scope_kind <> 'thread' OR thread.id IS NOT NULL)
            AND (task.scope_kind <> 'workspace' OR workspace.id IS NOT NULL)
            AND (task.scope_kind <> 'workspace'
              OR task.environment_id = workspace.environment_id)
        `,
      )
      .get(scope.tenantId, scope.principalId, id) as
      EnvironmentAuthorityTaskFact | undefined;
  }

  resolveWorkpad(
    scope: RequestScope,
    id: string,
  ): EnvironmentAuthorityTaskFact | undefined {
    return this.database.prepare(`
      SELECT pad.id, pad.revision, pad.scope_kind AS scopeKind,
        CASE WHEN pad.scope_kind = 'thread' THEN thread.environment_id
          WHEN pad.scope_kind = 'workspace' THEN workspace.environment_id ELSE NULL END AS environmentId,
        pad.workspace_id AS workspaceId, pad.thread_id AS threadId, pad.title AS label
      FROM workpads AS pad
      LEFT JOIN application_threads AS thread ON thread.tenant_id = pad.tenant_id
        AND thread.owner_principal_id = pad.owner_principal_id AND thread.id = pad.thread_id
      LEFT JOIN workspaces AS workspace ON workspace.tenant_id = pad.tenant_id
        AND workspace.owner_principal_id = pad.owner_principal_id AND workspace.id = pad.workspace_id
      WHERE pad.tenant_id = ? AND pad.owner_principal_id = ? AND pad.id = ?
        AND (pad.scope_kind <> 'thread' OR thread.id IS NOT NULL)
        AND (pad.scope_kind <> 'workspace' OR workspace.id IS NOT NULL)
    `).get(scope.tenantId, scope.principalId, id) as EnvironmentAuthorityTaskFact | undefined;
  }

  listEnvironments(
    scope: RequestScope,
  ): readonly EnvironmentAuthorityResourceFact[] {
    return Object.freeze(
      this.database
        .prepare(
          `
            SELECT id, id AS environmentId, label
            FROM execution_environments
            WHERE tenant_id = ? AND owner_principal_id = ?
            ORDER BY id
          `,
        )
        .all(
          scope.tenantId,
          scope.principalId,
        ) as EnvironmentAuthorityResourceFact[],
    );
  }

  #resolve(
    scope: RequestScope,
    sourceThreadId: string,
    executionEnvironmentId: string | undefined,
    signal: AbortSignal,
  ): TrustedAgentToolSource {
    this.#assertOpen(signal);
    const facts = this.database
      .prepare(
        `
          SELECT thread.id AS threadId, workspace.id AS workspaceId,
            thread.environment_id AS environmentId,
            backend.kind AS backendKind
          FROM application_threads AS thread
          JOIN workspaces AS workspace
            ON workspace.tenant_id = thread.tenant_id
            AND workspace.owner_principal_id = thread.owner_principal_id
            AND workspace.environment_id = thread.environment_id
            AND workspace.id = thread.workspace_id
          JOIN agent_backend_instances AS backend
            ON backend.tenant_id = thread.tenant_id
            AND backend.id = thread.backend_instance_id
          JOIN thread_principal_state AS inventory
            ON inventory.tenant_id = thread.tenant_id
            AND inventory.principal_id = thread.owner_principal_id
            AND inventory.thread_id = thread.id
          WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
            AND thread.id = ?
            AND inventory.inventory_state <> 'archived'
            AND workspace.removed_at IS NULL
            ${executionEnvironmentId === undefined ? "" : "AND thread.environment_id = ?"}
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        sourceThreadId,
        ...(executionEnvironmentId === undefined
          ? []
          : [executionEnvironmentId]),
      ) as ScopedThreadFacts | undefined;
    this.#assertOpen(signal);
    if (!facts) {
      throw new CanonicalAgentToolRequestError(
        "not_found",
        "The source thread was not found.",
      );
    }
    return Object.freeze({
      scope: Object.freeze({ ...scope }),
      sourceThreadId: facts.threadId,
      sourceWorkspaceId: facts.workspaceId,
      sourceEnvironmentId: facts.environmentId,
      backendKind: facts.backendKind,
    });
  }

  #resolveCapability(
    scope: RequestScope,
    sourceCapability: string,
    transport: AgentToolSourceCapabilityTransport,
    executionEnvironmentId: string | undefined,
    signal: AbortSignal,
  ): TrustedAgentToolSource {
    this.#assertOpen(signal);
    let sourceThreadId: string;
    try {
      sourceThreadId = this.#references.resolve(
        scope,
        sourceCapability,
        transport as ThreadSourceReferenceAudience,
      );
    } catch {
      throw new CanonicalAgentToolRequestError(
        "permission_denied",
        "The agent-tool source capability is invalid or expired.",
      );
    }
    return this.#resolve(
      scope,
      sourceThreadId,
      executionEnvironmentId,
      signal,
    );
  }

  #assertOpen(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new CanonicalAgentToolRequestError(
        "cancelled",
        "The agent-tool request was cancelled.",
      );
    }
  }
}
