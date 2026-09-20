import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import { environmentAdmitsForegroundOperation } from "../../domain/environment-operational-state.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export const PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_TOOLS = 256;
export const PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_ENVIRONMENTS = 16;
export const PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_ACTIVE = 64;
export const PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_RETAINED = 1_024;
export const PRINCIPAL_AGENT_TOOL_CLIENT_LAST_USED_COALESCE_MILLISECONDS =
  60_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOOL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

export interface PrincipalAgentToolClientRecord {
  readonly id: string;
  readonly creationRequestId: string;
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly defaultEnvironmentId?: string;
  readonly defaultWorkspaceId?: string;
  readonly defaultThreadId?: string;
  readonly policyRevision: number;
  readonly credentialGeneration: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt?: number;
  readonly revokedAt?: number;
  readonly toolIds: readonly string[];
  readonly allowedEnvironmentIds: readonly string[];
}

export interface PrincipalAgentToolClientAuthenticationRecord
  extends PrincipalAgentToolClientRecord {
  readonly credentialVerifier: Uint8Array;
}

export interface PrincipalAgentToolClientPolicyInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly toolIds: readonly string[];
  readonly defaultEnvironmentId: string;
  readonly allowedEnvironmentIds: readonly string[];
  readonly defaultWorkspaceId?: string;
  readonly defaultThreadId?: string;
}

export interface PrincipalAgentToolClientEligibility {
  readonly eligibleToolIds: ReadonlySet<string>;
}

type ClientRow = {
  readonly id: string;
  readonly creationRequestId: string;
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly name: string;
  readonly enabled: 0 | 1;
  readonly defaultEnvironmentId: string | null;
  readonly defaultWorkspaceId: string | null;
  readonly defaultThreadId: string | null;
  readonly policyRevision: number;
  readonly credentialGeneration: number;
  readonly credentialVerifier: Buffer | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
};

const clientColumns = `
  id,
  creation_request_id AS creationRequestId,
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  name,
  enabled,
  default_environment_id AS defaultEnvironmentId,
  default_workspace_id AS defaultWorkspaceId,
  default_thread_id AS defaultThreadId,
  policy_revision AS policyRevision,
  credential_generation AS credentialGeneration,
  credential_verifier AS credentialVerifier,
  created_at AS createdAt,
  updated_at AS updatedAt,
  last_used_at AS lastUsedAt,
  revoked_at AS revokedAt
`;

export class PrincipalAgentToolClientRepository {
  constructor(
    readonly database: Database.Database,
    readonly eligibility: PrincipalAgentToolClientEligibility,
  ) {}

  create(
    scope: RequestScope,
    input: PrincipalAgentToolClientPolicyInput & {
      readonly id: string;
      readonly creationRequestId: string;
      readonly credentialGeneration: number;
      readonly credentialVerifier: Uint8Array;
      readonly now: number;
    },
  ): PrincipalAgentToolClientRecord {
    return this.database.transaction(() => {
      assertUuid(input.id, "client ID");
      assertUuid(input.creationRequestId, "creation request ID");
      const policy = this.#validatePolicy(scope, input);
      if (
        !Number.isInteger(input.credentialGeneration) ||
        input.credentialGeneration < 1 ||
        input.credentialGeneration > 0xffff_ffff ||
        input.credentialVerifier.byteLength !== 32 ||
        !Number.isSafeInteger(input.now) ||
        input.now < 0
      ) {
        invalid("The tool client credential metadata is invalid.");
      }
      const existing = this.findByCreationRequestId(
        scope,
        input.creationRequestId,
      );
      if (existing) {
        throw new DomainError(
          "conflict",
          "The tool client creation request was already accepted.",
        );
      }
      this.database
        .prepare(
          `INSERT INTO principal_agent_tool_clients(
             tenant_id, owner_principal_id, id, creation_request_id, name,
             enabled, default_environment_id, default_workspace_id,
             default_thread_id, policy_revision, credential_generation,
             credential_verifier, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          input.id,
          input.creationRequestId,
          policy.name,
          input.enabled ? 1 : 0,
          policy.defaultEnvironmentId,
          policy.defaultWorkspaceId ?? null,
          policy.defaultThreadId ?? null,
          input.credentialGeneration,
          Buffer.from(input.credentialVerifier),
          input.now,
          input.now,
        );
      this.#replaceEntries(scope, input.id, policy.toolIds, policy.allowedEnvironmentIds);
      return this.get(scope, input.id);
    }).immediate();
  }

  get(scope: RequestScope, clientId: string): PrincipalAgentToolClientRecord {
    const row = this.#rowInScope(scope, clientId);
    if (!row) {
      throw new DomainError("not_found", "The tool client was not found.");
    }
    return this.#record(row);
  }

  findByCreationRequestId(
    scope: RequestScope,
    creationRequestId: string,
  ): PrincipalAgentToolClientRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${clientColumns}
         FROM principal_agent_tool_clients
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND creation_request_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, creationRequestId) as
      | ClientRow
      | undefined;
    return row ? this.#record(row) : undefined;
  }

  list(
    scope: RequestScope,
    input: {
      readonly limit: number;
      readonly before?: { readonly createdAt: number; readonly id: string };
    },
  ): readonly PrincipalAgentToolClientRecord[] {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101) {
      invalid("The tool client page size is invalid.");
    }
    const rows = this.database
      .prepare(
        `SELECT ${clientColumns}
         FROM principal_agent_tool_clients
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        input.before?.createdAt ?? null,
        input.before?.createdAt ?? null,
        input.before?.createdAt ?? null,
        input.before?.id ?? null,
        input.limit,
      ) as ClientRow[];
    return Object.freeze(rows.map((row) => this.#record(row)));
  }

  replace(
    scope: RequestScope,
    clientId: string,
    input: PrincipalAgentToolClientPolicyInput & {
      readonly expectedRevision: number;
      readonly now: number;
    },
  ): PrincipalAgentToolClientRecord {
    return this.database.transaction(() => {
      const row = this.#requireMutable(scope, clientId, input.expectedRevision);
      const policy = this.#validatePolicy(scope, input);
      this.database
        .prepare(
          `UPDATE principal_agent_tool_clients
           SET name = ?, enabled = ?, default_environment_id = ?,
             default_workspace_id = ?, default_thread_id = ?,
             policy_revision = policy_revision + 1, updated_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND policy_revision = ? AND revoked_at IS NULL`,
        )
        .run(
          policy.name,
          input.enabled ? 1 : 0,
          policy.defaultEnvironmentId,
          policy.defaultWorkspaceId ?? null,
          policy.defaultThreadId ?? null,
          input.now,
          scope.tenantId,
          scope.principalId,
          clientId,
          row.policyRevision,
        );
      this.#deleteEntries(scope, clientId);
      this.#replaceEntries(scope, clientId, policy.toolIds, policy.allowedEnvironmentIds);
      return this.get(scope, clientId);
    }).immediate();
  }

  rotate(
    scope: RequestScope,
    clientId: string,
    input: {
      readonly expectedRevision: number;
      readonly nextGeneration: number;
      readonly verifier: Uint8Array;
      readonly now: number;
    },
  ): PrincipalAgentToolClientRecord {
    return this.database.transaction(() => {
      const row = this.#requireMutable(scope, clientId, input.expectedRevision);
      if (
        row.credentialGeneration === 0xffff_ffff ||
        input.nextGeneration !== row.credentialGeneration + 1 ||
        input.verifier.byteLength !== 32
      ) {
        throw new DomainError(
          "conflict",
          "The tool client credential cannot be rotated.",
        );
      }
      const changed = this.database
        .prepare(
          `UPDATE principal_agent_tool_clients
           SET credential_generation = ?, credential_verifier = ?,
             policy_revision = policy_revision + 1, updated_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND policy_revision = ? AND credential_generation = ?
             AND revoked_at IS NULL`,
        )
        .run(
          input.nextGeneration,
          Buffer.from(input.verifier),
          input.now,
          scope.tenantId,
          scope.principalId,
          clientId,
          row.policyRevision,
          row.credentialGeneration,
        );
      if (changed.changes !== 1) conflict();
      return this.get(scope, clientId);
    }).immediate();
  }

  revoke(
    scope: RequestScope,
    clientId: string,
    input: { readonly expectedRevision: number; readonly now: number },
  ): PrincipalAgentToolClientRecord {
    return this.database.transaction(() => {
      const row = this.#requireMutable(scope, clientId, input.expectedRevision);
      this.#deleteEntries(scope, clientId);
      const changed = this.database
        .prepare(
          `UPDATE principal_agent_tool_clients
           SET enabled = 0, default_environment_id = NULL,
             default_workspace_id = NULL, default_thread_id = NULL,
             credential_verifier = NULL, revoked_at = ?,
             policy_revision = policy_revision + 1, updated_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND policy_revision = ? AND revoked_at IS NULL`,
        )
        .run(
          input.now,
          input.now,
          scope.tenantId,
          scope.principalId,
          clientId,
          row.policyRevision,
        );
      if (changed.changes !== 1) conflict();
      return this.get(scope, clientId);
    }).immediate();
  }

  /** Lookup by globally unique public ID. Scope becomes trusted only after verifier success. */
  authenticationRecord(
    clientId: string,
  ): PrincipalAgentToolClientAuthenticationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${clientColumns}
         FROM principal_agent_tool_clients
         WHERE id = ?`,
      )
      .get(clientId) as ClientRow | undefined;
    if (
      !row ||
      row.enabled !== 1 ||
      row.revokedAt !== null ||
      !row.credentialVerifier ||
      row.credentialVerifier.byteLength !== 32
    ) {
      return undefined;
    }
    return Object.freeze({
      ...this.#record(row),
      credentialVerifier: new Uint8Array(row.credentialVerifier),
    });
  }

  touchLastUsed(
    scope: RequestScope,
    clientId: string,
    generation: number,
    observedAt: number,
  ): void {
    this.database
      .prepare(
        `UPDATE principal_agent_tool_clients
         SET last_used_at = CASE
           WHEN last_used_at IS NULL OR last_used_at < ? THEN ?
           ELSE last_used_at
         END
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
           AND credential_generation = ? AND revoked_at IS NULL
           AND (last_used_at IS NULL OR last_used_at <= ?)` ,
      )
      .run(
        observedAt,
        observedAt,
        scope.tenantId,
        scope.principalId,
        clientId,
        generation,
        observedAt - PRINCIPAL_AGENT_TOOL_CLIENT_LAST_USED_COALESCE_MILLISECONDS,
      );
  }

  blockerNamesForEnvironments(
    scope: RequestScope,
    environmentIds: readonly string[],
    limit = 8,
  ): readonly string[] {
    if (environmentIds.length === 0) return Object.freeze([]);
    const unique = sortedDistinct(environmentIds, 16, "environment ID");
    const rows = this.database
      .prepare(
        `SELECT DISTINCT client.name
         FROM principal_agent_tool_client_environments AS environment
         JOIN principal_agent_tool_clients AS client
           ON client.tenant_id = environment.tenant_id
           AND client.owner_principal_id = environment.owner_principal_id
           AND client.id = environment.client_id
         WHERE environment.tenant_id = ?
           AND environment.owner_principal_id = ?
           AND client.revoked_at IS NULL
           AND environment.environment_id IN (${unique.map(() => "?").join(", ")})
         ORDER BY client.name, client.id
         LIMIT ?`,
      )
      .all(scope.tenantId, scope.principalId, ...unique, limit) as {
      readonly name: string;
    }[];
    return Object.freeze(rows.map(({ name }) => name));
  }

  blockerNamesForWorkspace(
    scope: RequestScope,
    workspaceId: string,
    limit = 8,
  ): readonly string[] {
    return this.#defaultBlockerNames(scope, "default_workspace_id", workspaceId, limit);
  }

  blockerNamesForThread(
    scope: RequestScope,
    threadId: string,
    limit = 8,
  ): readonly string[] {
    return this.#defaultBlockerNames(scope, "default_thread_id", threadId, limit);
  }

  #defaultBlockerNames(
    scope: RequestScope,
    column: "default_workspace_id" | "default_thread_id",
    id: string,
    limit: number,
  ): readonly string[] {
    const rows = this.database
      .prepare(
        `SELECT name FROM principal_agent_tool_clients
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND revoked_at IS NULL AND ${column} = ?
         ORDER BY name, id LIMIT ?`,
      )
      .all(scope.tenantId, scope.principalId, id, limit) as {
      readonly name: string;
    }[];
    return Object.freeze(rows.map(({ name }) => name));
  }

  #validatePolicy(
    scope: RequestScope,
    input: PrincipalAgentToolClientPolicyInput,
  ) {
    const name = normalizeName(input.name);
    const toolIds = sortedDistinct(
      input.toolIds,
      PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_TOOLS,
      "tool ID",
      TOOL_ID_PATTERN,
    );
    if (
      toolIds.length === 0 ||
      toolIds.some((toolId) => !this.eligibility.eligibleToolIds.has(toolId))
    ) {
      invalid("The tool client selection contains an unavailable tool.");
    }
    const allowedEnvironmentIds = sortedDistinct(
      input.allowedEnvironmentIds,
      PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_ENVIRONMENTS,
      "environment ID",
    );
    if (
      allowedEnvironmentIds.length === 0 ||
      !allowedEnvironmentIds.includes(input.defaultEnvironmentId)
    ) {
      invalid("The default environment must be in the allowed environment set.");
    }
    const environmentRows = this.database
      .prepare(
        `SELECT id, availability, diagnostic_code AS diagnosticCode
         FROM execution_environments
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND id IN (${allowedEnvironmentIds.map(() => "?").join(", ")})`,
      )
      .all(scope.tenantId, scope.principalId, ...allowedEnvironmentIds) as {
      readonly id: string;
      readonly availability: "available" | "unavailable";
      readonly diagnosticCode: string | null;
    }[];
    const defaultEnvironment = environmentRows.find(
      ({ id }) => id === input.defaultEnvironmentId,
    );
    if (
      environmentRows.length !== allowedEnvironmentIds.length ||
      !defaultEnvironment ||
      !environmentAdmitsForegroundOperation(defaultEnvironment)
    ) {
      invalid("The tool client environment selection is unavailable.");
    }
    if (input.defaultThreadId && !input.defaultWorkspaceId) {
      invalid("A default thread requires a default workspace.");
    }
    if (input.defaultWorkspaceId) {
      const workspace = this.database
        .prepare(
          `SELECT availability FROM workspaces
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND environment_id = ? AND id = ?`,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          input.defaultEnvironmentId,
          input.defaultWorkspaceId,
        ) as { readonly availability: "available" | "unavailable" } | undefined;
      if (!workspace || workspace.availability !== "available") {
        invalid("The default workspace is unavailable.");
      }
    }
    if (input.defaultThreadId) {
      const thread = this.database
        .prepare(
          `SELECT thread.availability, state.inventory_state AS inventoryState
           FROM application_threads AS thread
           JOIN thread_principal_state AS state
             ON state.tenant_id = thread.tenant_id
             AND state.principal_id = thread.owner_principal_id
             AND state.thread_id = thread.id
           WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
             AND thread.environment_id = ? AND thread.workspace_id = ?
             AND thread.id = ?`,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          input.defaultEnvironmentId,
          input.defaultWorkspaceId,
          input.defaultThreadId,
        ) as
        | {
            readonly availability: "available" | "missing" | "quarantined" | "environment_unavailable";
            readonly inventoryState: "active" | "snoozed" | "settled" | "archived";
          }
        | undefined;
      if (
        !thread ||
        thread.availability !== "available" ||
        thread.inventoryState === "archived"
      ) {
        invalid("The default thread is unavailable.");
      }
    }
    return Object.freeze({
      name,
      toolIds,
      allowedEnvironmentIds,
      defaultEnvironmentId: input.defaultEnvironmentId,
      ...(input.defaultWorkspaceId
        ? { defaultWorkspaceId: input.defaultWorkspaceId }
        : {}),
      ...(input.defaultThreadId ? { defaultThreadId: input.defaultThreadId } : {}),
    });
  }

  #replaceEntries(
    scope: RequestScope,
    clientId: string,
    toolIds: readonly string[],
    environmentIds: readonly string[],
  ): void {
    const insertTool = this.database.prepare(
      `INSERT INTO principal_agent_tool_client_entries(
         tenant_id, owner_principal_id, client_id, tool_id
       ) VALUES (?, ?, ?, ?)`,
    );
    for (const toolId of toolIds) {
      insertTool.run(scope.tenantId, scope.principalId, clientId, toolId);
    }
    const insertEnvironment = this.database.prepare(
      `INSERT INTO principal_agent_tool_client_environments(
         tenant_id, owner_principal_id, client_id, environment_id
       ) VALUES (?, ?, ?, ?)`,
    );
    for (const environmentId of environmentIds) {
      insertEnvironment.run(
        scope.tenantId,
        scope.principalId,
        clientId,
        environmentId,
      );
    }
  }

  #deleteEntries(scope: RequestScope, clientId: string): void {
    this.database
      .prepare(
        `DELETE FROM principal_agent_tool_client_entries
         WHERE tenant_id = ? AND owner_principal_id = ? AND client_id = ?`,
      )
      .run(scope.tenantId, scope.principalId, clientId);
    this.database
      .prepare(
        `DELETE FROM principal_agent_tool_client_environments
         WHERE tenant_id = ? AND owner_principal_id = ? AND client_id = ?`,
      )
      .run(scope.tenantId, scope.principalId, clientId);
  }

  #requireMutable(
    scope: RequestScope,
    clientId: string,
    expectedRevision: number,
  ): ClientRow {
    const row = this.#rowInScope(scope, clientId);
    if (!row) {
      throw new DomainError("not_found", "The tool client was not found.");
    }
    if (row.revokedAt !== null) {
      throw new DomainError("conflict", "The tool client is revoked.");
    }
    if (row.policyRevision !== expectedRevision) conflict();
    return row;
  }

  #rowInScope(scope: RequestScope, clientId: string): ClientRow | undefined {
    return this.database
      .prepare(
        `SELECT ${clientColumns}
         FROM principal_agent_tool_clients
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.principalId, clientId) as ClientRow | undefined;
  }

  #record(row: ClientRow): PrincipalAgentToolClientRecord {
    const toolIds = this.database
      .prepare(
        `SELECT tool_id AS id FROM principal_agent_tool_client_entries
         WHERE tenant_id = ? AND owner_principal_id = ? AND client_id = ?
         ORDER BY tool_id`,
      )
      .all(row.tenantId, row.ownerPrincipalId, row.id) as { readonly id: string }[];
    const environmentIds = this.database
      .prepare(
        `SELECT environment_id AS id
         FROM principal_agent_tool_client_environments
         WHERE tenant_id = ? AND owner_principal_id = ? AND client_id = ?
         ORDER BY environment_id`,
      )
      .all(row.tenantId, row.ownerPrincipalId, row.id) as { readonly id: string }[];
    return Object.freeze({
      id: row.id,
      creationRequestId: row.creationRequestId,
      tenantId: row.tenantId,
      ownerPrincipalId: row.ownerPrincipalId,
      name: row.name,
      enabled: row.enabled === 1,
      ...(row.defaultEnvironmentId
        ? { defaultEnvironmentId: row.defaultEnvironmentId }
        : {}),
      ...(row.defaultWorkspaceId ? { defaultWorkspaceId: row.defaultWorkspaceId } : {}),
      ...(row.defaultThreadId ? { defaultThreadId: row.defaultThreadId } : {}),
      policyRevision: row.policyRevision,
      credentialGeneration: row.credentialGeneration,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.lastUsedAt === null ? {} : { lastUsedAt: row.lastUsedAt }),
      ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
      toolIds: Object.freeze(toolIds.map(({ id }) => id)),
      allowedEnvironmentIds: Object.freeze(environmentIds.map(({ id }) => id)),
    });
  }
}

function normalizeName(value: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    Buffer.byteLength(normalized, "utf8") > 240
  ) {
    invalid("The tool client name is invalid.");
  }
  return normalized;
}

function sortedDistinct(
  values: readonly string[],
  maximum: number,
  label: string,
  pattern?: RegExp,
): readonly string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    invalid(`The tool client ${label} set is invalid.`);
  }
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  for (let index = 0; index < sorted.length; index += 1) {
    const value = sorted[index]!;
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      Buffer.byteLength(value, "utf8") > 128 ||
      (pattern && !pattern.test(value)) ||
      (index > 0 && value === sorted[index - 1])
    ) {
      invalid(`The tool client ${label} set is invalid.`);
    }
  }
  return Object.freeze(sorted);
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    invalid(`The tool client ${label} is invalid.`);
  }
}

function invalid(message: string): never {
  throw new DomainError("invalid_transition", message);
}

function conflict(): never {
  throw new DomainError(
    "conflict",
    "The tool client changed in another request.",
  );
}
