import { environmentVariableOverridesSchema, type EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  THREAD_TEMPLATE_CURSOR_MAX_CHARACTERS,
  THREAD_TEMPLATE_PAGE_MAX_ITEMS,
  threadTemplateCapturedAgentNameSchema,
  threadTemplateCapturedTargetNameSchema,
  threadTemplateCapturedWorkspaceNameSchema,
  threadTemplateIdSchema,
  threadTemplateNameSchema,
  threadTemplateTargetIdSchema,
} from "../../../shared/protocol/thread-templates.js";
import {
  executionWorkspaceSelectionSchema,
  type ExecutionWorkspaceSelection,
} from "../../../shared/protocol/conversation.js";
import { workspaceIdSchema } from "../../../shared/protocol/domain.js";
import { savedAgentIdSchema } from "../../../shared/protocol/saved-agents.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export interface ThreadTemplateRecord {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly executionWorkspace: ExecutionWorkspaceSelection;
  readonly agentId: string;
  readonly environmentVariables?: EnvironmentVariableOverrides;
  readonly capturedAgentName: string;
  readonly capturedWorkspaceName: string;
  readonly capturedTargetName: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ThreadTemplateListPageRecord {
  readonly items: readonly ThreadTemplateRecord[];
  readonly nextCursor?: string;
}

type ThreadTemplateRow = Omit<ThreadTemplateRecord, "executionWorkspace" | "environmentVariables"> & {
  readonly executionWorkspaceJson: string;
  readonly environmentVariablesJson: string;
  readonly normalizedName?: string;
};

export interface ThreadTemplateSelectionRecord {
  readonly workspaceId: string;
  readonly targetId: string;
  readonly executionWorkspace: ExecutionWorkspaceSelection;
  readonly agentId: string;
  readonly environmentVariables?: EnvironmentVariableOverrides;
  readonly capturedAgentName: string;
  readonly capturedWorkspaceName: string;
  readonly capturedTargetName: string;
}

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  id,
  name,
  workspace_id AS workspaceId,
  target_id AS targetId,
  execution_workspace_json AS executionWorkspaceJson,
  agent_id AS agentId,
  environment_variables_json AS environmentVariablesJson,
  captured_agent_name AS capturedAgentName,
  captured_workspace_name AS capturedWorkspaceName,
  captured_target_name AS capturedTargetName,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function queryFingerprint(pageSize: number): string {
  return createHash("sha256")
    .update(JSON.stringify(["thread_templates", pageSize]))
    .digest("hex");
}

function encodeCursor(
  fingerprint: string,
  row: {
    readonly normalizedName: string;
    readonly name: string;
    readonly id: string;
  },
): string {
  return Buffer.from(JSON.stringify({ fingerprint, ...row }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(
  cursor: string,
  fingerprint: string,
): {
  readonly normalizedName: string;
  readonly name: string;
  readonly id: string;
} {
  if (cursor.length > THREAD_TEMPLATE_CURSOR_MAX_CHARACTERS) {
    throw new DomainError(
      "cursor_invalid",
      "The thread template cursor is invalid.",
    );
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
      !threadTemplateIdSchema.safeParse(parsed.id).success
    ) {
      throw new Error("thread_template_cursor_invalid");
    }
    return {
      normalizedName: parsed.normalizedName,
      name: parsed.name,
      id: parsed.id,
    };
  } catch (cause) {
    throw new DomainError(
      "cursor_invalid",
      "The thread template cursor is invalid.",
      false,
      { cause },
    );
  }
}

function requireTimestamp(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Number.isNaN(new Date(value).getTime())
  ) {
    throw new Error("thread_template_timestamp_invalid");
  }
  return value;
}

function invalidDurableState(cause?: unknown): Error {
  return new Error("thread_template_durable_state_invalid", { cause });
}

function canonicalExecutionWorkspace(
  value: ExecutionWorkspaceSelection,
): ExecutionWorkspaceSelection {
  return executionWorkspaceSelectionSchema.parse(value);
}

export class ThreadTemplateRepository {
  constructor(readonly database: Database.Database) {}

  find(
    scope: RequestScope,
    templateId: string,
  ): ThreadTemplateRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM thread_templates
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.principalId, templateId) as
      ThreadTemplateRow | undefined;
    return row ? this.#record(row) : undefined;
  }

  get(scope: RequestScope, templateId: string): ThreadTemplateRecord {
    const record = this.find(scope, templateId);
    if (!record) {
      throw new DomainError("not_found", "The thread template was not found.");
    }
    return record;
  }

  assertRevision(
    scope: RequestScope,
    templateId: string,
    expectedRevision: number,
  ): ThreadTemplateRecord {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision > Number.MAX_SAFE_INTEGER
    ) {
      throw new DomainError(
        "conflict",
        "The thread template changed in another client.",
      );
    }
    const record = this.get(scope, templateId);
    if (record.revision !== expectedRevision) {
      throw new DomainError(
        "conflict",
        "The thread template changed in another client.",
      );
    }
    return record;
  }

  listPage(
    scope: RequestScope,
    input: { readonly cursor?: string; readonly pageSize: number },
  ): ThreadTemplateListPageRecord {
    if (
      !Number.isInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > THREAD_TEMPLATE_PAGE_MAX_ITEMS
    ) {
      throw new Error("thread_template_page_size_invalid");
    }
    const fingerprint = queryFingerprint(input.pageSize);
    const after = input.cursor
      ? decodeCursor(input.cursor, fingerprint)
      : undefined;
    const conditions = ["tenant_id = ?", "owner_principal_id = ?"];
    const parameters: unknown[] = [scope.tenantId, scope.principalId];
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
         FROM thread_templates
         WHERE ${conditions.join(" AND ")}
         ORDER BY lower(name), name, id
         LIMIT ?`,
      )
      .all(...parameters, input.pageSize + 1) as ThreadTemplateRow[];
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
      readonly selection: ThreadTemplateSelectionRecord;
      readonly assertReferences: () => void;
      readonly now: number;
    },
  ): ThreadTemplateRecord {
    const id = threadTemplateIdSchema.parse(input.id ?? randomUUID());
    const name = threadTemplateNameSchema.parse(input.name);
    const selection = this.#selection(input.selection);
    const now = requireTimestamp(input.now);
    return this.database
      .transaction(() => {
        input.assertReferences();
        this.database
          .prepare(
            `INSERT INTO thread_templates(
            tenant_id, owner_principal_id, id, name, workspace_id, target_id,
            execution_workspace_json, agent_id, environment_variables_json, captured_agent_name,
            captured_workspace_name, captured_target_name, revision,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            id,
            name,
            selection.workspaceId,
            selection.targetId,
            JSON.stringify(selection.executionWorkspace),
            selection.agentId,
            JSON.stringify(selection.environmentVariables ?? {}),
            selection.capturedAgentName,
            selection.capturedWorkspaceName,
            selection.capturedTargetName,
            now,
            now,
          );
        return this.get(scope, id);
      })
      .immediate();
  }

  update(
    scope: RequestScope,
    templateId: string,
    input: {
      readonly expectedRevision: number;
      readonly name: string;
      readonly selection: ThreadTemplateSelectionRecord;
      readonly assertReferences: () => void;
      readonly now: number;
    },
  ): ThreadTemplateRecord {
    const name = threadTemplateNameSchema.parse(input.name);
    const selection = this.#selection(input.selection);
    const now = requireTimestamp(input.now);
    return this.database
      .transaction(() => {
        const current = this.assertRevision(
          scope,
          templateId,
          input.expectedRevision,
        );
        if (current.revision >= Number.MAX_SAFE_INTEGER) {
          throw new DomainError(
            "conflict",
            "The thread template revision can no longer be advanced.",
          );
        }
        input.assertReferences();
        const changed = this.database
          .prepare(
            `UPDATE thread_templates
           SET name = ?, workspace_id = ?, target_id = ?,
             execution_workspace_json = ?, agent_id = ?, environment_variables_json = ?,
             captured_agent_name = ?, captured_workspace_name = ?,
             captured_target_name = ?, revision = revision + 1,
             updated_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND revision = ?`,
          )
          .run(
            name,
            selection.workspaceId,
            selection.targetId,
            JSON.stringify(selection.executionWorkspace),
            selection.agentId,
            JSON.stringify(selection.environmentVariables ?? {}),
            selection.capturedAgentName,
            selection.capturedWorkspaceName,
            selection.capturedTargetName,
            now,
            scope.tenantId,
            scope.principalId,
            templateId,
            input.expectedRevision,
          );
        if (changed.changes !== 1) {
          throw new DomainError(
            "conflict",
            "The thread template changed in another client.",
          );
        }
        return this.get(scope, templateId);
      })
      .immediate();
  }

  delete(
    scope: RequestScope,
    templateId: string,
    input: { readonly expectedRevision: number },
  ): void {
    this.database
      .transaction(() => {
        this.assertRevision(scope, templateId, input.expectedRevision);
        const removed = this.database
          .prepare(
            `DELETE FROM thread_templates
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND revision = ?`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            templateId,
            input.expectedRevision,
          );
        if (removed.changes !== 1) {
          throw new DomainError(
            "conflict",
            "The thread template changed in another client.",
          );
        }
      })
      .immediate();
  }

  #selection(
    input: ThreadTemplateSelectionRecord,
  ): ThreadTemplateSelectionRecord {
    return {
      workspaceId: workspaceIdSchema.parse(input.workspaceId),
      targetId: threadTemplateTargetIdSchema.parse(input.targetId),
      executionWorkspace: canonicalExecutionWorkspace(input.executionWorkspace),
      agentId: savedAgentIdSchema.parse(input.agentId),
      environmentVariables: environmentVariableOverridesSchema.parse(input.environmentVariables ?? {}),
      capturedAgentName: threadTemplateCapturedAgentNameSchema.parse(
        input.capturedAgentName,
      ),
      capturedWorkspaceName: threadTemplateCapturedWorkspaceNameSchema.parse(
        input.capturedWorkspaceName,
      ),
      capturedTargetName: threadTemplateCapturedTargetNameSchema.parse(
        input.capturedTargetName,
      ),
    };
  }

  #record(row: ThreadTemplateRow): ThreadTemplateRecord {
    try {
      const id = threadTemplateIdSchema.parse(row.id);
      const name = threadTemplateNameSchema.parse(row.name);
      if (name !== row.name) throw invalidDurableState();
      const workspaceId = workspaceIdSchema.parse(row.workspaceId);
      const targetId = threadTemplateTargetIdSchema.parse(row.targetId);
      const agentId = savedAgentIdSchema.parse(row.agentId);
      const capturedAgentName = threadTemplateCapturedAgentNameSchema.parse(
        row.capturedAgentName,
      );
      const capturedWorkspaceName =
        threadTemplateCapturedWorkspaceNameSchema.parse(
          row.capturedWorkspaceName,
        );
      const capturedTargetName = threadTemplateCapturedTargetNameSchema.parse(
        row.capturedTargetName,
      );
      const parsedExecutionWorkspace = JSON.parse(
        row.executionWorkspaceJson,
      ) as unknown;
      const executionWorkspace = executionWorkspaceSelectionSchema.parse(
        parsedExecutionWorkspace,
      );
      if (
        JSON.stringify(executionWorkspace) !== row.executionWorkspaceJson ||
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
      return {
        tenantId: row.tenantId,
        ownerPrincipalId: row.ownerPrincipalId,
        id,
        name,
        workspaceId,
        targetId,
        executionWorkspace,
        environmentVariables: environmentVariableOverridesSchema.parse(JSON.parse(row.environmentVariablesJson)),
        agentId,
        capturedAgentName,
        capturedWorkspaceName,
        capturedTargetName,
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.message === "thread_template_durable_state_invalid"
      ) {
        throw cause;
      }
      throw invalidDurableState(cause);
    }
  }
}
