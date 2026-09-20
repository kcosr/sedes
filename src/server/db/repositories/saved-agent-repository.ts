import { environmentVariableOverridesSchema, type EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  SAVED_AGENT_CURSOR_MAX_CHARACTERS,
  SAVED_AGENT_PAGE_MAX_ITEMS,
  agentToolBootstrapPolicySchema,
  normalizedAgentConfigurationOverridesSchema,
  savedAgentBackendTypeIdSchema,
  savedAgentDescriptionSchema,
  savedAgentIdSchema,
  savedAgentNameSchema,
  type AgentToolBootstrapPolicy,
  type NormalizedAgentConfigurationOverrides,
  type SavedAgentBackendTypeId,
} from "../../../shared/protocol/saved-agents.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export interface SavedAgentRecord {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly backendTypeId: SavedAgentBackendTypeId;
  readonly backendOverridesSchemaVersion: number;
  readonly backendOverrides: NormalizedAgentConfigurationOverrides;
  readonly environmentVariables?: EnvironmentVariableOverrides;
  readonly sedesTools: AgentToolBootstrapPolicy | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SavedAgentListPageRecord {
  readonly items: readonly SavedAgentRecord[];
  readonly nextCursor?: string;
}

type SavedAgentRow = Omit<
  SavedAgentRecord,
  "backendTypeId" | "backendOverrides" | "sedesTools" | "environmentVariables"
> & {
  readonly backendTypeId: string;
  readonly backendOverridesJson: string;
  readonly environmentVariablesJson: string;
  readonly sedesToolsJson: string | null;
  readonly normalizedName?: string;
};

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  id,
  name,
  description,
  backend_type_id AS backendTypeId,
  backend_overrides_schema_version AS backendOverridesSchemaVersion,
  backend_overrides_json AS backendOverridesJson,
  environment_variables_json AS environmentVariablesJson,
  sedes_tools_json AS sedesToolsJson,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalSavedAgentOverrides(
  value: NormalizedAgentConfigurationOverrides,
): NormalizedAgentConfigurationOverrides {
  const parsed = normalizedAgentConfigurationOverridesSchema.parse(value);
  return [...parsed].sort((left, right) => compareCodePoints(left.id, right.id));
}

export function canonicalSavedAgentSedesTools(
  value: AgentToolBootstrapPolicy,
): AgentToolBootstrapPolicy {
  const parsed = agentToolBootstrapPolicySchema.parse(value);
  return {
    enabled: parsed.enabled,
    enabledToolIds: [...parsed.enabledToolIds].sort(compareCodePoints),
    presentation: parsed.presentation,
    accessBoundary: parsed.accessBoundary,
  };
}

function queryFingerprint(input: {
  readonly backendTypeId?: SavedAgentBackendTypeId;
  readonly nameSearch?: string;
  readonly pageSize: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "saved_agents",
        input.backendTypeId ?? null,
        input.nameSearch?.toLowerCase() ?? null,
        input.pageSize,
      ]),
    )
    .digest("hex");
}

function encodeCursor(
  fingerprint: string,
  row: { readonly normalizedName: string; readonly name: string; readonly id: string },
): string {
  return Buffer.from(
    JSON.stringify({ fingerprint, ...row }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  cursor: string,
  fingerprint: string,
): { readonly normalizedName: string; readonly name: string; readonly id: string } {
  if (cursor.length > SAVED_AGENT_CURSOR_MAX_CHARACTERS) {
    throw new DomainError("cursor_invalid", "The Saved Agent cursor is invalid.");
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).length !== 4 ||
      !("fingerprint" in parsed) ||
      parsed.fingerprint !== fingerprint ||
      !("normalizedName" in parsed) ||
      typeof parsed.normalizedName !== "string" ||
      !("name" in parsed) ||
      typeof parsed.name !== "string" ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !savedAgentIdSchema.safeParse(parsed.id).success
    ) {
      throw new Error("saved_agent_cursor_invalid");
    }
    return {
      normalizedName: parsed.normalizedName,
      name: parsed.name,
      id: parsed.id,
    };
  } catch (cause) {
    throw new DomainError(
      "cursor_invalid",
      "The Saved Agent cursor is invalid.",
      false,
      { cause },
    );
  }
}

function invalidDurableState(cause?: unknown): Error {
  return new Error("saved_agent_durable_state_invalid", { cause });
}

function requireTimestamp(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Number.isNaN(new Date(value).getTime())
  ) {
    throw new Error("saved_agent_timestamp_invalid");
  }
  return value;
}

export class SavedAgentRepository {
  constructor(readonly database: Database.Database) {}

  find(scope: RequestScope, agentId: string): SavedAgentRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM saved_agents
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.principalId, agentId) as
      | SavedAgentRow
      | undefined;
    return row ? this.#record(row) : undefined;
  }

  get(scope: RequestScope, agentId: string): SavedAgentRecord {
    const record = this.find(scope, agentId);
    if (!record) {
      throw new DomainError("not_found", "The Saved Agent was not found.");
    }
    return record;
  }

  assertRevision(
    scope: RequestScope,
    agentId: string,
    expectedRevision: number,
  ): SavedAgentRecord {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision > Number.MAX_SAFE_INTEGER
    ) {
      throw new DomainError(
        "conflict",
        "The Saved Agent changed in another client.",
      );
    }
    const record = this.get(scope, agentId);
    if (record.revision !== expectedRevision) {
      throw new DomainError(
        "conflict",
        "The Saved Agent changed in another client.",
      );
    }
    return record;
  }

  listPage(
    scope: RequestScope,
    input: {
      readonly backendTypeId?: SavedAgentBackendTypeId;
      readonly nameSearch?: string;
      readonly cursor?: string;
      readonly pageSize: number;
    },
  ): SavedAgentListPageRecord {
    if (
      !Number.isInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > SAVED_AGENT_PAGE_MAX_ITEMS
    ) {
      throw new Error("saved_agent_page_size_invalid");
    }
    const backendTypeId = input.backendTypeId
      ? savedAgentBackendTypeIdSchema.parse(input.backendTypeId)
      : undefined;
    const nameSearch = input.nameSearch
      ? savedAgentNameSchema.parse(input.nameSearch)
      : undefined;
    const fingerprint = queryFingerprint({
      ...(backendTypeId ? { backendTypeId } : {}),
      ...(nameSearch ? { nameSearch } : {}),
      pageSize: input.pageSize,
    });
    const after = input.cursor
      ? decodeCursor(input.cursor, fingerprint)
      : undefined;
    const conditions = ["tenant_id = ?", "owner_principal_id = ?"];
    const parameters: unknown[] = [scope.tenantId, scope.principalId];
    if (backendTypeId) {
      conditions.push("backend_type_id = ?");
      parameters.push(backendTypeId);
    }
    if (nameSearch) {
      conditions.push("instr(lower(name), lower(?)) > 0");
      parameters.push(nameSearch);
    }
    if (after) {
      conditions.push(`(
        lower(name) > ?
        OR (lower(name) = ? AND name > ?)
        OR (lower(name) = ? AND name = ? AND id > ?)
      )`);
      parameters.push(
        after.normalizedName,
        after.normalizedName,
        after.name,
        after.normalizedName,
        after.name,
        after.id,
      );
    }
    const rows = this.database
      .prepare(
        `SELECT ${columns}, lower(name) AS normalizedName
         FROM saved_agents
         WHERE ${conditions.join(" AND ")}
         ORDER BY lower(name), name, id
         LIMIT ?`,
      )
      .all(...parameters, input.pageSize + 1) as SavedAgentRow[];
    const retained = rows.slice(0, input.pageSize);
    const last = retained.at(-1);
    return {
      items: retained.map((row) => this.#record(row)),
      ...(rows.length > input.pageSize && last?.normalizedName !== undefined
        ? {
            nextCursor: encodeCursor(fingerprint, {
              normalizedName: last.normalizedName,
              name: last.name,
              id: last.id,
            }),
          }
        : {}),
    };
  }

  create(
    scope: RequestScope,
    input: {
      readonly id?: string;
      readonly name: string;
      readonly description: string;
      readonly backendTypeId: SavedAgentBackendTypeId;
      readonly backendOverridesSchemaVersion: number;
      readonly backendOverrides: NormalizedAgentConfigurationOverrides;
      readonly environmentVariables?: EnvironmentVariableOverrides;
  readonly sedesTools: AgentToolBootstrapPolicy | null;
      readonly now: number;
    },
  ): SavedAgentRecord {
    const values = this.#validatedValues(input);
    const id = savedAgentIdSchema.parse(input.id ?? randomUUID());
    const now = requireTimestamp(input.now);
    this.database
      .prepare(
        `INSERT INTO saved_agents(
          tenant_id, owner_principal_id, id, name, description,
          backend_type_id, backend_overrides_schema_version,
          backend_overrides_json, sedes_tools_json, environment_variables_json, revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        id,
        values.name,
        values.description,
        values.backendTypeId,
        values.backendOverridesSchemaVersion,
        JSON.stringify(values.backendOverrides),
        values.sedesTools === null
          ? null
          : JSON.stringify(values.sedesTools),
        JSON.stringify(values.environmentVariables),
        now,
        now,
      );
    return this.get(scope, id);
  }

  update(
    scope: RequestScope,
    agentId: string,
    input: {
      readonly expectedRevision: number;
      readonly name?: string;
      readonly description?: string;
      readonly backendOverrides?: {
        readonly schemaVersion: number;
        readonly values: NormalizedAgentConfigurationOverrides;
      };
      readonly environmentVariables?: EnvironmentVariableOverrides;
      readonly sedesTools?: AgentToolBootstrapPolicy | null;
      readonly now: number;
    },
  ): SavedAgentRecord {
    const now = requireTimestamp(input.now);
    return this.database.transaction(() => {
      const current = this.assertRevision(
        scope,
        agentId,
        input.expectedRevision,
      );
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new DomainError(
          "conflict",
          "The Saved Agent revision can no longer be advanced.",
        );
      }
      const values = this.#validatedValues({
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        backendTypeId: current.backendTypeId,
        backendOverridesSchemaVersion:
          input.backendOverrides?.schemaVersion ??
          current.backendOverridesSchemaVersion,
        backendOverrides:
          input.backendOverrides?.values ?? current.backendOverrides,
        environmentVariables: input.environmentVariables ?? current.environmentVariables,
        sedesTools:
          input.sedesTools === undefined
            ? current.sedesTools
            : input.sedesTools,
      });
      const changed = this.database
        .prepare(
          `UPDATE saved_agents
           SET name = ?, description = ?,
             backend_overrides_schema_version = ?,
             backend_overrides_json = ?, sedes_tools_json = ?, environment_variables_json = ?,
             revision = revision + 1, updated_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND revision = ?`,
        )
        .run(
          values.name,
          values.description,
          values.backendOverridesSchemaVersion,
          JSON.stringify(values.backendOverrides),
          values.sedesTools === null
            ? null
            : JSON.stringify(values.sedesTools),
          JSON.stringify(values.environmentVariables),
          now,
          scope.tenantId,
          scope.principalId,
          agentId,
          input.expectedRevision,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The Saved Agent changed in another client.",
        );
      }
      return this.get(scope, agentId);
    }).immediate();
  }

  delete(
    scope: RequestScope,
    agentId: string,
    input: { readonly expectedRevision: number },
  ): void {
    this.database.transaction(() => {
      this.assertRevision(scope, agentId, input.expectedRevision);
      const removed = this.database
        .prepare(
          `DELETE FROM saved_agents
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND revision = ?`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          agentId,
          input.expectedRevision,
        );
      if (removed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The Saved Agent changed in another client.",
        );
      }
    }).immediate();
  }

  #validatedValues(input: {
    readonly name: string;
    readonly description: string;
    readonly backendTypeId: SavedAgentBackendTypeId;
    readonly backendOverridesSchemaVersion: number;
    readonly backendOverrides: NormalizedAgentConfigurationOverrides;
    readonly environmentVariables?: EnvironmentVariableOverrides;
  readonly sedesTools: AgentToolBootstrapPolicy | null;
  }) {
    const name = savedAgentNameSchema.parse(input.name);
    const description = savedAgentDescriptionSchema.parse(input.description);
    const backendTypeId = savedAgentBackendTypeIdSchema.parse(
      input.backendTypeId,
    );
    if (
      !Number.isSafeInteger(input.backendOverridesSchemaVersion) ||
      input.backendOverridesSchemaVersion < 1
    ) {
      throw new Error("saved_agent_backend_schema_version_invalid");
    }
    return {
      name,
      description,
      backendTypeId,
      backendOverridesSchemaVersion: input.backendOverridesSchemaVersion,
      backendOverrides: canonicalSavedAgentOverrides(input.backendOverrides),
      environmentVariables: environmentVariableOverridesSchema.parse(input.environmentVariables ?? {}),
      sedesTools:
        input.sedesTools === null
          ? null
          : canonicalSavedAgentSedesTools(input.sedesTools),
    };
  }

  #record(row: SavedAgentRow): SavedAgentRecord {
    try {
      const id = savedAgentIdSchema.parse(row.id);
      const name = savedAgentNameSchema.parse(row.name);
      // Transforming validation must not normalize corrupt durable state.
      if (name !== row.name) throw invalidDurableState();
      const description = savedAgentDescriptionSchema.parse(row.description);
      const backendTypeId = savedAgentBackendTypeIdSchema.parse(
        row.backendTypeId,
      );
      if (
        !Number.isSafeInteger(row.backendOverridesSchemaVersion) ||
        row.backendOverridesSchemaVersion < 1 ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        row.revision > Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < 0 ||
        Number.isNaN(new Date(row.createdAt).getTime()) ||
        !Number.isSafeInteger(row.updatedAt) ||
        row.updatedAt < row.createdAt ||
        Number.isNaN(new Date(row.updatedAt).getTime())
      ) {
        throw invalidDurableState();
      }
      const parsedOverrides = JSON.parse(row.backendOverridesJson) as unknown;
      const backendOverrides = canonicalSavedAgentOverrides(
        normalizedAgentConfigurationOverridesSchema.parse(parsedOverrides),
      );
      if (JSON.stringify(backendOverrides) !== row.backendOverridesJson) {
        throw invalidDurableState();
      }
      let sedesTools: AgentToolBootstrapPolicy | null = null;
      if (row.sedesToolsJson !== null) {
        const parsedTools = JSON.parse(row.sedesToolsJson) as unknown;
        sedesTools = canonicalSavedAgentSedesTools(
          agentToolBootstrapPolicySchema.parse(parsedTools),
        );
        if (JSON.stringify(sedesTools) !== row.sedesToolsJson) {
          throw invalidDurableState();
        }
      }
      return {
        tenantId: row.tenantId,
        ownerPrincipalId: row.ownerPrincipalId,
        id,
        name,
        description,
        backendTypeId,
        backendOverridesSchemaVersion: row.backendOverridesSchemaVersion,
        backendOverrides,
        sedesTools,
        environmentVariables: environmentVariableOverridesSchema.parse(JSON.parse(row.environmentVariablesJson)),
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.message === "saved_agent_durable_state_invalid"
      ) {
        throw cause;
      }
      throw invalidDurableState(cause);
    }
  }
}
