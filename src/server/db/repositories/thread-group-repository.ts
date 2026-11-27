import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RequestScope } from "../../identity/identity-provider.js";
import { DomainError } from "../../domain/errors.js";
import { MAXIMUM_NEW_THREAD_GROUP_MEMBERS } from "../../../shared/protocol/thread-groups.js";

export interface ThreadGroupRecord {
  readonly tenantId: string;
  readonly principalId: string;
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly memberCount: number;
  readonly activeMemberCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ThreadGroupAssignmentRecord {
  readonly threadId: string;
  readonly groupId: string | null;
  readonly revision: number;
}

export interface ThreadGroupDirectoryPage {
  readonly items: readonly Pick<ThreadGroupRecord, "id" | "name">[];
  readonly nextCursor?: string;
}

interface GroupMutationReceipt {
  readonly operationKind: string;
  readonly requestFingerprint: string;
  readonly resultJson: string;
}

interface MutationResult {
  readonly groupId: string | null;
  readonly threadId?: string;
  readonly replayed: boolean;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeName(name: string): { name: string; nameKey: string } {
  const normalized = name.normalize("NFKC").trim();
  if (normalized.length < 1 || normalized.length > 120) {
    throw new DomainError(
      "bad_request",
      "A group name must contain between 1 and 120 characters.",
    );
  }
  return {
    name: normalized,
    nameKey: normalized.toLocaleLowerCase("en-US"),
  };
}

function directoryCursorPosition(cursor: string, expectedFingerprint: string): string {
  const invalid = () => new DomainError("cursor_invalid", "The thread Group directory cursor is invalid.");
  if (cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let position: unknown;
  try {
    position = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(position) || position.length !== 2 || position[0] !== expectedFingerprint ||
      typeof position[1] !== "string" || position[1].length === 0 || position[1].length > 240) {
    throw invalid();
  }
  return position[1];
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    String((error as { code?: unknown }).code).startsWith(
      "SQLITE_CONSTRAINT_UNIQUE",
    )
  );
}

/** Principal-scoped persistence for durable groups and singular membership. */
export class ThreadGroupRepository {
  constructor(readonly database: Database.Database) {}

  listDirectoryPage(
    scope: RequestScope,
    input: {
      readonly query?: string;
      readonly cursor?: string;
      readonly pageSize: number;
      readonly authorityDigest: string;
    },
  ): ThreadGroupDirectoryPage {
    const { pageSize } = input;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new DomainError("bad_request", "The Group directory page size must be between 1 and 100.");
    }
    const queryKey = input.query === undefined ? "" : normalizeName(input.query).nameKey;
    const queryFingerprint = fingerprint([
      "thread_group.list", scope.tenantId, scope.principalId, input.authorityDigest, queryKey, pageSize,
    ]);
    const after = input.cursor === undefined ? "" : directoryCursorPosition(input.cursor, queryFingerprint);
    // name_key is nonempty and unique within this principal, including for empty Groups.
    const rows = this.database.prepare(`
      SELECT id, name, name_key AS nameKey
      FROM thread_groups
      WHERE tenant_id = ? AND principal_id = ? AND name_key > ? AND instr(name_key, ?) > 0
      ORDER BY name_key
      LIMIT ?
    `).all(scope.tenantId, scope.principalId, after, queryKey, pageSize + 1) as Array<{
      id: string; name: string; nameKey: string;
    }>;
    const retained = rows.slice(0, pageSize);
    const last = retained.at(-1);
    return {
      items: retained.map(({ id, name }) => ({ id, name })),
      ...(rows.length > pageSize && last ? {
        nextCursor: Buffer.from(JSON.stringify([queryFingerprint, last.nameKey])).toString("base64url"),
      } : {}),
    };
  }

  list(scope: RequestScope): readonly ThreadGroupRecord[] {
    return this.database
      .prepare(
        `
          SELECT
            groups.tenant_id AS tenantId,
            groups.principal_id AS principalId,
            groups.id,
            groups.name,
            groups.revision,
            count(membership.thread_id) AS memberCount,
            coalesce(sum(CASE
              WHEN state.inventory_state <> 'archived' THEN 1 ELSE 0
            END), 0) AS activeMemberCount,
            groups.created_at AS createdAt,
            groups.updated_at AS updatedAt
          FROM thread_groups AS groups
          LEFT JOIN thread_group_memberships AS membership
            ON membership.tenant_id = groups.tenant_id
            AND membership.principal_id = groups.principal_id
            AND membership.group_id = groups.id
          LEFT JOIN thread_principal_state AS state
            ON state.tenant_id = membership.tenant_id
            AND state.principal_id = membership.principal_id
            AND state.thread_id = membership.thread_id
          WHERE groups.tenant_id = ? AND groups.principal_id = ?
          GROUP BY groups.tenant_id, groups.principal_id, groups.id
          ORDER BY groups.name_key, groups.id
        `,
      )
      .all(scope.tenantId, scope.principalId) as ThreadGroupRecord[];
  }

  get(scope: RequestScope, groupId: string): ThreadGroupRecord {
    const group = this.database
      .prepare(
        `
          SELECT
            groups.tenant_id AS tenantId,
            groups.principal_id AS principalId,
            groups.id,
            groups.name,
            groups.revision,
            (
              SELECT count(*)
              FROM thread_group_memberships AS membership
              WHERE membership.tenant_id = groups.tenant_id
                AND membership.principal_id = groups.principal_id
                AND membership.group_id = groups.id
            ) AS memberCount,
            (
              SELECT count(*)
              FROM thread_group_memberships AS membership
              JOIN thread_principal_state AS state
                ON state.tenant_id = membership.tenant_id
                AND state.principal_id = membership.principal_id
                AND state.thread_id = membership.thread_id
              WHERE membership.tenant_id = groups.tenant_id
                AND membership.principal_id = groups.principal_id
                AND membership.group_id = groups.id
                AND state.inventory_state <> 'archived'
            ) AS activeMemberCount,
            groups.created_at AS createdAt,
            groups.updated_at AS updatedAt
          FROM thread_groups AS groups
          WHERE groups.tenant_id = ? AND groups.principal_id = ?
            AND groups.id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, groupId) as
      | ThreadGroupRecord
      | undefined;
    if (!group) throw new DomainError("not_found", "Thread group not found.");
    return group;
  }

  getAssignment(
    scope: RequestScope,
    threadId: string,
  ): ThreadGroupAssignmentRecord {
    const row = this.database
      .prepare(
        `
          SELECT
            state.thread_id AS threadId,
            membership.group_id AS groupId,
            state.group_assignment_revision AS revision
          FROM thread_principal_state AS state
          LEFT JOIN thread_group_memberships AS membership
            ON membership.tenant_id = state.tenant_id
            AND membership.principal_id = state.principal_id
            AND membership.thread_id = state.thread_id
          WHERE state.tenant_id = ? AND state.principal_id = ?
            AND state.thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      | ThreadGroupAssignmentRecord
      | undefined;
    if (!row) throw new DomainError("not_found", "Thread not found.");
    return row;
  }

  createAndAssign(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly name: string;
      readonly members: readonly {
        readonly threadId: string;
        readonly expectedRevision: number;
      }[];
      readonly mutationId: string;
      readonly now: number;
    },
  ): MutationResult {
    const normalized = normalizeName(input.name);
    if (
      input.members.length < 1 ||
      input.members.length > MAXIMUM_NEW_THREAD_GROUP_MEMBERS ||
      new Set(input.members.map((member) => member.threadId)).size !== input.members.length ||
      !input.members.some((member) => member.threadId === threadId) ||
      input.members.some((member) => !Number.isSafeInteger(member.expectedRevision) || member.expectedRevision < 0)
    ) {
      throw new DomainError("bad_request", "Provide distinct group members including the target thread, with their current revisions.");
    }
    const members = input.members
      .map(({ threadId: memberId, expectedRevision }) => ({ threadId: memberId, expectedRevision }))
      .sort((left, right) => left.threadId.localeCompare(right.threadId));
    const requestFingerprint = fingerprint([
      "create_thread_group",
      threadId,
      normalized.name,
      members,
    ]);
    return this.database.transaction(() => {
      const replay = this.#replay(
        scope,
        input.mutationId,
        "create_thread_group",
        requestFingerprint,
      );
      if (replay) return replay;
      for (const member of members) {
        this.#assertAssignmentRevision(scope, member.threadId, member.expectedRevision);
      }
      const groupId = randomUUID();
      try {
        this.database
          .prepare(
            `
              INSERT INTO thread_groups(
                tenant_id, principal_id, id, name, name_key,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            groupId,
            normalized.name,
            normalized.nameKey,
            input.now,
            input.now,
          );
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new DomainError(
            "group_name_conflict",
            "A group with this name already exists.",
          );
        }
        throw error;
      }
      for (const member of members) {
        this.#writeAssignment(scope, member.threadId, groupId, input.now);
        this.#bumpAssignmentRevision(scope, member.threadId, member.expectedRevision);
      }
      this.#bumpGeneration(scope);
      const result = { groupId, threadId };
      this.#insertReceipt(
        scope,
        input.mutationId,
        "create_thread_group",
        requestFingerprint,
        result,
        input.now,
      );
      return { ...result, replayed: false };
    })();
  }

  assign(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly groupId: string | null;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): MutationResult {
    const operationKind =
      input.groupId === null ? "remove_thread_group" : "assign_thread_group";
    const requestFingerprint = fingerprint([
      operationKind,
      threadId,
      input.groupId,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const replay = this.#replay(
        scope,
        input.mutationId,
        operationKind,
        requestFingerprint,
      );
      if (replay) return replay;
      const current = this.#assertAssignmentRevision(
        scope,
        threadId,
        input.expectedRevision,
      );
      if (input.groupId !== null) this.get(scope, input.groupId);
      const changed = current.groupId !== input.groupId;
      if (changed) {
        if (input.groupId === null) {
          this.database
            .prepare(
              `
                DELETE FROM thread_group_memberships
                WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              `,
            )
            .run(scope.tenantId, scope.principalId, threadId);
        } else {
          this.#writeAssignment(scope, threadId, input.groupId, input.now);
        }
        this.#bumpAssignmentRevision(scope, threadId, input.expectedRevision);
        this.#bumpGeneration(scope);
      }
      const result = { groupId: input.groupId, threadId };
      this.#insertReceipt(
        scope,
        input.mutationId,
        operationKind,
        requestFingerprint,
        result,
        input.now,
      );
      return { ...result, replayed: false };
    })();
  }

  rename(
    scope: RequestScope,
    groupId: string,
    input: {
      readonly name: string;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): MutationResult {
    const normalized = normalizeName(input.name);
    const requestFingerprint = fingerprint([
      "rename_thread_group",
      groupId,
      normalized.name,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const replay = this.#replay(
        scope,
        input.mutationId,
        "rename_thread_group",
        requestFingerprint,
      );
      if (replay) return replay;
      const current = this.get(scope, groupId);
      if (current.revision !== input.expectedRevision) {
        throw new DomainError(
          "group_revision_conflict",
          "The group changed in another client.",
        );
      }
      if (current.name !== normalized.name) {
        try {
          const changed = this.database
            .prepare(
              `
                UPDATE thread_groups
                SET name = ?, name_key = ?, revision = revision + 1,
                  updated_at = ?
                WHERE tenant_id = ? AND principal_id = ? AND id = ?
                  AND revision = ?
              `,
            )
            .run(
              normalized.name,
              normalized.nameKey,
              input.now,
              scope.tenantId,
              scope.principalId,
              groupId,
              input.expectedRevision,
            );
          if (changed.changes !== 1) {
            throw new DomainError(
              "group_revision_conflict",
              "The group changed in another client.",
            );
          }
        } catch (error) {
          if (isUniqueConstraint(error)) {
            throw new DomainError(
              "group_name_conflict",
              "A group with this name already exists.",
            );
          }
          throw error;
        }
        this.#bumpGeneration(scope);
      }
      const result = { groupId };
      this.#insertReceipt(
        scope,
        input.mutationId,
        "rename_thread_group",
        requestFingerprint,
        result,
        input.now,
      );
      return { ...result, replayed: false };
    })();
  }

  delete(
    scope: RequestScope,
    groupId: string,
    input: {
      readonly expectedRevision: number;
      readonly expectedMemberCount: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): MutationResult {
    const requestFingerprint = fingerprint([
      "delete_thread_group",
      groupId,
      input.expectedRevision,
      input.expectedMemberCount,
    ]);
    return this.database.transaction(() => {
      const replay = this.#replay(
        scope,
        input.mutationId,
        "delete_thread_group",
        requestFingerprint,
      );
      if (replay) return replay;
      const current = this.get(scope, groupId);
      if (current.revision !== input.expectedRevision) {
        throw new DomainError(
          "group_revision_conflict",
          "The group changed in another client.",
        );
      }
      if (current.memberCount !== input.expectedMemberCount) {
        throw new DomainError(
          "group_revision_conflict",
          "The group membership changed in another client.",
        );
      }
      this.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET group_assignment_revision = group_assignment_revision + 1
            WHERE tenant_id = ? AND principal_id = ?
              AND thread_id IN (
                SELECT thread_id FROM thread_group_memberships
                WHERE tenant_id = ? AND principal_id = ? AND group_id = ?
              )
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          scope.tenantId,
          scope.principalId,
          groupId,
        );
      const deleted = this.database
        .prepare(
          `
            DELETE FROM thread_groups
            WHERE tenant_id = ? AND principal_id = ? AND id = ?
              AND revision = ?
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          groupId,
          input.expectedRevision,
        );
      if (deleted.changes !== 1) {
        throw new DomainError(
          "group_revision_conflict",
          "The group changed in another client.",
        );
      }
      this.#bumpGeneration(scope);
      const result = { groupId: null };
      this.#insertReceipt(
        scope,
        input.mutationId,
        "delete_thread_group",
        requestFingerprint,
        result,
        input.now,
      );
      return { ...result, replayed: false };
    })();
  }

  #assertAssignmentRevision(
    scope: RequestScope,
    threadId: string,
    expectedRevision: number,
  ): ThreadGroupAssignmentRecord {
    const current = this.getAssignment(scope, threadId);
    if (current.revision !== expectedRevision) {
      throw new DomainError(
        "group_assignment_revision_conflict",
        "The thread group changed in another client.",
      );
    }
    return current;
  }

  #writeAssignment(
    scope: RequestScope,
    threadId: string,
    groupId: string,
    now: number,
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO thread_group_memberships(
            tenant_id, principal_id, thread_id, group_id, assigned_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, principal_id, thread_id) DO UPDATE SET
            group_id = excluded.group_id,
            assigned_at = excluded.assigned_at
        `,
      )
      .run(scope.tenantId, scope.principalId, threadId, groupId, now);
  }

  #bumpAssignmentRevision(
    scope: RequestScope,
    threadId: string,
    expectedRevision: number,
  ): void {
    const changed = this.database
      .prepare(
        `
          UPDATE thread_principal_state
          SET group_assignment_revision = group_assignment_revision + 1
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND group_assignment_revision = ?
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        threadId,
        expectedRevision,
      );
    if (changed.changes !== 1) {
      throw new DomainError(
        "group_assignment_revision_conflict",
        "The thread group changed in another client.",
      );
    }
  }

  #bumpGeneration(scope: RequestScope): void {
    this.database
      .prepare(
        `
          UPDATE principal_generations
          SET inventory_generation = inventory_generation + 1
          WHERE tenant_id = ? AND principal_id = ?
        `,
      )
      .run(scope.tenantId, scope.principalId);
  }

  #receipt(
    scope: RequestScope,
    mutationId: string,
  ): GroupMutationReceipt | undefined {
    return this.database
      .prepare(
        `
          SELECT
            operation_kind AS operationKind,
            request_fingerprint AS requestFingerprint,
            result_json AS resultJson
          FROM thread_group_mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      | GroupMutationReceipt
      | undefined;
  }

  #replay(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
  ): MutationResult | undefined {
    const receipt = this.#receipt(scope, mutationId);
    if (!receipt) return undefined;
    if (
      receipt.operationKind !== operationKind ||
      receipt.requestFingerprint !== requestFingerprint
    ) {
      throw new DomainError(
        "conflict",
        "The mutation id was already used for a different group operation.",
      );
    }
    return {
      ...(JSON.parse(receipt.resultJson) as Omit<MutationResult, "replayed">),
      replayed: true,
    };
  }

  #insertReceipt(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
    result: Omit<MutationResult, "replayed">,
    now: number,
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO thread_group_mutation_receipts(
            tenant_id, principal_id, mutation_id, operation_kind,
            request_fingerprint, result_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        mutationId,
        operationKind,
        requestFingerprint,
        JSON.stringify(result),
        now,
      );
  }
}
