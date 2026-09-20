import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  supplementalRootConflictsWithPrimary,
  workspaceFileRootsOverlap,
} from "../../workspace-files/root-topology.js";

export type WorkspaceFileRootAvailability = "available" | "unavailable";

export type WorkspaceFileRootRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly workspaceId: string;
  readonly rootId: string;
  readonly canonicalPath: string;
  readonly displayLabel: string;
  readonly sortOrder: number;
  readonly availability: WorkspaceFileRootAvailability;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type WorkspaceFileLinkRootRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly workspaceId: string;
  readonly rootId: string;
  readonly canonicalPath: string;
  readonly createdAt: number;
};

type MutationReceipt = {
  readonly operationKind: string;
  readonly requestFingerprint: string;
  readonly resultJson: string;
};

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  workspace_id AS workspaceId,
  root_id AS rootId,
  canonical_path AS canonicalPath,
  display_label AS displayLabel,
  sort_order AS sortOrder,
  availability,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const linkRootColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  workspace_id AS workspaceId,
  root_id AS rootId,
  canonical_path AS canonicalPath,
  created_at AS createdAt
`;

function fingerprint(operation: string, parts: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, ...parts]))
    .digest("hex");
}

function createFingerprint(
  workspaceId: string,
  requestedPath: string,
  requestedDisplayLabel: string | undefined,
): string {
  return fingerprint("create_workspace_file_root", [
    workspaceId,
    requestedPath,
    requestedDisplayLabel ?? null,
  ]);
}

function mutationConflict(): DomainError {
  return new DomainError(
    "conflict",
    "The mutation ID was reused for a different operation.",
  );
}

function revisionConflict(): DomainError {
  return new DomainError(
    "conflict",
    "The workspace file root changed in another client.",
  );
}

export class WorkspaceFileRootRepository {
  static readonly maximumRootsPerWorkspace = 8;
  static readonly maximumLinkRootsPerWorkspace = 256;

  constructor(readonly database: Database.Database) {}

  list(
    scope: RequestScope,
    workspaceId: string,
  ): readonly WorkspaceFileRootRecord[] {
    return this.database
      .prepare(
        `
          SELECT ${columns}
          FROM workspace_file_roots
          WHERE tenant_id = ? AND owner_principal_id = ? AND workspace_id = ?
          ORDER BY sort_order ASC, created_at ASC, root_id ASC
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        workspaceId,
      ) as WorkspaceFileRootRecord[];
  }

  find(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
  ): WorkspaceFileRootRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT ${columns}
          FROM workspace_file_roots
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND workspace_id = ? AND root_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, workspaceId, rootId) as
      WorkspaceFileRootRecord | undefined;
  }

  findLinkRoot(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
  ): WorkspaceFileLinkRootRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT ${linkRootColumns}
          FROM workspace_file_link_roots
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND workspace_id = ? AND root_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, workspaceId, rootId) as
      WorkspaceFileLinkRootRecord | undefined;
  }

  rememberLinkRoot(
    scope: RequestScope,
    workspaceId: string,
    canonicalPath: string,
    now: number,
  ): WorkspaceFileLinkRootRecord {
    return this.database
      .transaction(() => {
        this.#getWorkspace(scope, workspaceId);
        const existing = this.database
          .prepare(
            `
              SELECT ${linkRootColumns}
              FROM workspace_file_link_roots
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND workspace_id = ? AND canonical_path = ?
            `,
          )
          .get(
            scope.tenantId,
            scope.principalId,
            workspaceId,
            canonicalPath,
        ) as WorkspaceFileLinkRootRecord | undefined;
        if (existing) {
          return existing;
        }
        const count = this.database
          .prepare(
            `
              SELECT COUNT(*) AS count
              FROM workspace_file_link_roots
              WHERE tenant_id = ? AND owner_principal_id = ? AND workspace_id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, workspaceId) as {
          readonly count: number;
        };
        if (
          count.count >=
          WorkspaceFileRootRepository.maximumLinkRootsPerWorkspace
        ) {
          throw new DomainError(
            "conflict",
            "The workspace has reached its remembered file-link root limit.",
          );
        }
        const rootId = `link-${randomUUID()}`;
        this.database
          .prepare(
            `
              INSERT INTO workspace_file_link_roots(
                tenant_id, owner_principal_id, workspace_id, root_id,
                canonical_path, created_at
              ) VALUES (?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            workspaceId,
            rootId,
            canonicalPath,
            now,
          );
        return this.findLinkRoot(scope, workspaceId, rootId)!;
      })
      .immediate();
  }

  get(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
  ): WorkspaceFileRootRecord {
    const record = this.find(scope, workspaceId, rootId);
    if (!record) {
      throw new DomainError(
        "not_found",
        "The supplemental workspace file root was not found.",
      );
    }
    return record;
  }

  /**
   * Checks attach idempotency using only the original normalized request.
   * Callers use this before filesystem and policy validation so an already
   * committed attach remains replayable when external eligibility changes.
   */
  replayCreate(
    scope: RequestScope,
    workspaceId: string,
    input: {
      readonly mutationId: string;
      readonly path: string;
      readonly displayLabel?: string;
    },
  ): WorkspaceFileRootRecord | undefined {
    return this.#replayedRecord(
      scope,
      input.mutationId,
      "create_workspace_file_root",
      createFingerprint(workspaceId, input.path, input.displayLabel),
    );
  }

  create(
    scope: RequestScope,
    workspaceId: string,
    input: {
      /** Original normalized attach request, before filesystem validation. */
      readonly path: string;
      readonly displayLabel?: string;
      /** Validated storage values resolved from the original request. */
      readonly canonicalPath: string;
      readonly resolvedDisplayLabel: string;
      readonly sortOrder?: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): WorkspaceFileRootRecord {
    const requestFingerprint = createFingerprint(
      workspaceId,
      input.path,
      input.displayLabel,
    );
    return this.database
      .transaction(() => {
        const replayed = this.#replayedRecord(
          scope,
          input.mutationId,
          "create_workspace_file_root",
          requestFingerprint,
        );
        if (replayed) return replayed;
        const workspace = this.#getWorkspace(scope, workspaceId);
        const existingCount = this.database
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM workspace_file_roots
            WHERE tenant_id = ? AND owner_principal_id = ? AND workspace_id = ?
          `,
          )
          .get(scope.tenantId, scope.principalId, workspaceId) as {
          readonly count: number;
        };
        if (
          existingCount.count >=
          WorkspaceFileRootRepository.maximumRootsPerWorkspace
        ) {
          throw new DomainError(
            "conflict",
            "A workspace can have at most 8 supplemental file roots.",
          );
        }
        if (
          supplementalRootConflictsWithPrimary(
            workspace.canonicalPath,
            input.canonicalPath,
          )
        ) {
          throw new DomainError(
            "conflict",
            "A supplemental file root cannot equal the primary workspace root.",
          );
        }
        const existingRoots = this.database
          .prepare(
            `
            SELECT canonical_path AS canonicalPath
            FROM workspace_file_roots
            WHERE tenant_id = ? AND owner_principal_id = ? AND workspace_id = ?
          `,
          )
          .all(scope.tenantId, scope.principalId, workspaceId) as readonly {
          readonly canonicalPath: string;
        }[];
        if (
          existingRoots.some(({ canonicalPath }) =>
            workspaceFileRootsOverlap(canonicalPath, input.canonicalPath),
          )
        ) {
          throw new DomainError(
            "conflict",
            "Supplemental file roots cannot overlap each other.",
          );
        }
        const otherWorkspace = this.database
          .prepare(
            `
            SELECT 1 FROM workspaces
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND id <> ? AND canonical_path = ?
          `,
          )
          .get(
            scope.tenantId,
            scope.principalId,
            workspaceId,
            input.canonicalPath,
          );
        if (otherWorkspace) {
          throw new DomainError(
            "conflict",
            "Another workspace already uses that canonical path.",
          );
        }
        const sortOrder =
          input.sortOrder ??
          (
            this.database
              .prepare(
                `
              SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder
              FROM workspace_file_roots
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND workspace_id = ?
            `,
              )
              .get(scope.tenantId, scope.principalId, workspaceId) as {
              readonly nextSortOrder: number;
            }
          ).nextSortOrder;
        const rootId = randomUUID();
        try {
          this.database
            .prepare(
              `
              INSERT INTO workspace_file_roots(
                tenant_id, owner_principal_id, workspace_id, root_id,
                canonical_path, display_label, sort_order, availability,
                revision, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'available', 1, ?, ?)
            `,
            )
            .run(
              scope.tenantId,
              scope.principalId,
              workspaceId,
              rootId,
              input.canonicalPath,
              input.resolvedDisplayLabel,
              sortOrder,
              input.now,
              input.now,
            );
        } catch (error) {
          if (isConstraintError(error)) {
            throw new DomainError(
              "conflict",
              "That supplemental workspace file root is already attached or its label is already in use.",
              false,
              { cause: error },
            );
          }
          throw error;
        }
        const record = this.get(scope, workspaceId, rootId);
        this.#insertReceipt(
          scope,
          input.mutationId,
          "create_workspace_file_root",
          requestFingerprint,
          record,
          input.now,
        );
        return record;
      })
      .immediate();
  }

  replayRemove(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
    input: {
      readonly expectedRevision: number;
      readonly mutationId: string;
    },
  ): WorkspaceFileRootRecord | undefined {
    return this.#replayedRecord(
      scope,
      input.mutationId,
      "remove_workspace_file_root",
      fingerprint("remove_workspace_file_root", [
        workspaceId,
        rootId,
        input.expectedRevision,
      ]),
    );
  }

  remove(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
    input: {
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): WorkspaceFileRootRecord {
    const requestFingerprint = fingerprint("remove_workspace_file_root", [
      workspaceId,
      rootId,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const replayed = this.#replayedRecord(
        scope,
        input.mutationId,
        "remove_workspace_file_root",
        requestFingerprint,
      );
      if (replayed) return replayed;
      const record = this.get(scope, workspaceId, rootId);
      const removed = this.database
        .prepare(
          `
            DELETE FROM workspace_file_roots
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND workspace_id = ? AND root_id = ? AND revision = ?
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          workspaceId,
          rootId,
          input.expectedRevision,
        );
      if (removed.changes !== 1) throw revisionConflict();
      this.#insertReceipt(
        scope,
        input.mutationId,
        "remove_workspace_file_root",
        requestFingerprint,
        record,
        input.now,
      );
      return record;
    })();
  }

  setAvailability(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
    input: {
      readonly availability: WorkspaceFileRootAvailability;
      readonly now: number;
    },
  ): WorkspaceFileRootRecord {
    return this.database.transaction(() => {
      const current = this.get(scope, workspaceId, rootId);
      if (current.availability === input.availability) return current;
      const changed = this.database
        .prepare(
          `
            UPDATE workspace_file_roots
            SET availability = ?, revision = revision + 1,
              updated_at = max(updated_at, ?)
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND workspace_id = ? AND root_id = ? AND revision = ?
          `,
        )
        .run(
          input.availability,
          input.now,
          scope.tenantId,
          scope.principalId,
          workspaceId,
          rootId,
          current.revision,
        );
      if (changed.changes !== 1) throw revisionConflict();
      return this.get(scope, workspaceId, rootId);
    })();
  }

  #getWorkspace(
    scope: RequestScope,
    workspaceId: string,
  ): { readonly canonicalPath: string } {
    const workspace = this.database
      .prepare(
        `
          SELECT canonical_path AS canonicalPath FROM workspaces
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, workspaceId) as
      { readonly canonicalPath: string } | undefined;
    if (!workspace) {
      throw new DomainError("not_found", "The workspace was not found.");
    }
    return workspace;
  }

  #replayedRecord(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
  ): WorkspaceFileRootRecord | undefined {
    const receipt = this.database
      .prepare(
        `
          SELECT operation_kind AS operationKind,
            request_fingerprint AS requestFingerprint,
            result_json AS resultJson
          FROM workspace_file_root_mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      MutationReceipt | undefined;
    if (!receipt) return undefined;
    if (
      receipt.operationKind !== operationKind ||
      receipt.requestFingerprint !== requestFingerprint
    ) {
      throw mutationConflict();
    }
    const parsed = JSON.parse(receipt.resultJson) as {
      readonly version: 1;
      readonly record: WorkspaceFileRootRecord;
    };
    return parsed.record;
  }

  #insertReceipt(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
    record: WorkspaceFileRootRecord,
    now: number,
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO workspace_file_root_mutation_receipts(
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
        JSON.stringify({ version: 1, record }),
        now,
      );
  }
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}
