import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { WORKSPACE_FILE_MAX_LINKED_WORKTREES } from "../../../shared/workspace-file-limits.js";

export type WorkspaceFileLinkedWorktreeRootRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly workspaceId: string;
  readonly rootId: string;
  readonly canonicalPath: string;
  readonly canonicalCheckoutPath: string | null;
  readonly canonicalGitDir: string;
  readonly identityToken: string;
  readonly displayLabel: string;
  readonly branchRef: string | null;
  readonly headOid: string;
  readonly provenanceKind: "same" | "contained" | "unmerged" | "unknown";
  readonly aheadCount: number | null;
  readonly behindCount: number | null;
  readonly availability: "available" | "unavailable";
  readonly revision: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly unavailableAt: number | null;
};

export type DiscoveredLinkedWorktree = {
  readonly canonicalPath: string;
  readonly canonicalCheckoutPath: string;
  readonly canonicalGitDir: string;
  readonly identityToken: string;
  readonly displayLabel: string;
  readonly branchRef: string | null;
  readonly headOid: string;
  readonly provenanceKind: "same" | "contained" | "unmerged" | "unknown";
  readonly aheadCount: number | null;
  readonly behindCount: number | null;
};

export type LinkedWorktreeReconciliationResult = {
  readonly roots: readonly WorkspaceFileLinkedWorktreeRootRecord[];
  readonly tombstonedRootIds: readonly string[];
  readonly clearedThreadIds: readonly string[];
};

export type LinkedWorktreeForgetResult = {
  readonly rootId: string;
  readonly outcome: "removed" | "forgotten";
  readonly clearedThreadIds: readonly string[];
};

const columns = `
  tenant_id AS tenantId, owner_principal_id AS ownerPrincipalId,
  workspace_id AS workspaceId, root_id AS rootId,
  canonical_path AS canonicalPath, canonical_git_dir AS canonicalGitDir,
  canonical_checkout_path AS canonicalCheckoutPath,
  identity_token AS identityToken,
  display_label AS displayLabel, branch_ref AS branchRef,
  head_oid AS headOid, provenance_kind AS provenanceKind,
  ahead_count AS aheadCount, behind_count AS behindCount,
  availability, revision,
  first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
  unavailable_at AS unavailableAt
`;

/** Principal-scoped durable identities for Git-linked worktrees. */
export class WorkspaceFileLinkedWorktreeRepository {
  static readonly maximumDiscoveredWorktrees =
    WORKSPACE_FILE_MAX_LINKED_WORKTREES;

  constructor(readonly database: Database.Database) {}

  list(
    scope: RequestScope,
    workspaceId: string,
    options: { readonly includeUnavailable?: boolean } = {},
  ): readonly WorkspaceFileLinkedWorktreeRootRecord[] {
    return this.database
      .prepare(
        `SELECT ${columns}
         FROM workspace_file_linked_worktree_roots
         WHERE tenant_id = ? AND owner_principal_id = ? AND workspace_id = ?
           ${options.includeUnavailable ? "" : "AND availability = 'available'"}
         ORDER BY availability ASC,
           CASE WHEN availability = 'unavailable' THEN unavailable_at END DESC,
           display_label COLLATE NOCASE, root_id
         ${options.includeUnavailable ? `LIMIT ${WORKSPACE_FILE_MAX_LINKED_WORKTREES}` : ""}`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        workspaceId,
      ) as WorkspaceFileLinkedWorktreeRootRecord[];
  }

  find(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
  ): WorkspaceFileLinkedWorktreeRootRecord | undefined {
    return this.database
      .prepare(
        `SELECT ${columns}
         FROM workspace_file_linked_worktree_roots
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND workspace_id = ? AND root_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, workspaceId, rootId) as
      WorkspaceFileLinkedWorktreeRootRecord | undefined;
  }

  get(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
  ): WorkspaceFileLinkedWorktreeRootRecord {
    const root = this.find(scope, workspaceId, rootId);
    if (!root) {
      throw new DomainError(
        "not_found",
        "The linked worktree was not found.",
      );
    }
    return root;
  }

  hasOtherWorkspaceOverlap(
    scope: RequestScope,
    environmentId: string,
    workspaceId: string,
    canonicalCheckoutPath: string,
  ): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM workspaces
           WHERE tenant_id = ? AND environment_id = ?
             AND NOT (owner_principal_id = ? AND id = ?)
             AND (
               canonical_path = ?
               OR substr(canonical_path, 1, length(?) + 1) = ? || '/'
               OR substr(?, 1, length(canonical_path) + 1) = canonical_path || '/'
             )
           LIMIT 1`,
        )
        .get(
          scope.tenantId,
          environmentId,
          scope.principalId,
          workspaceId,
          canonicalCheckoutPath,
          canonicalCheckoutPath,
          canonicalCheckoutPath,
          canonicalCheckoutPath,
        ),
    );
  }

  /**
   * Reconciles only a complete, successfully validated discovery result.
   * Missing active roots become terminal tombstones and cannot later be
   * rebound to a recreated worktree that reuses the same Git admin path.
   */
  reconcileDiscovery(
    scope: RequestScope,
    workspaceId: string,
    discovered: readonly DiscoveredLinkedWorktree[],
    input: { readonly complete: boolean; readonly now: number },
  ): LinkedWorktreeReconciliationResult {
    if (
      discovered.length >
      WorkspaceFileLinkedWorktreeRepository.maximumDiscoveredWorktrees
    ) {
      throw new DomainError(
        "conflict",
        "The workspace has too many linked worktrees to discover safely.",
      );
    }
    if (
      new Set(discovered.map(({ identityToken }) => identityToken)).size !==
        discovered.length ||
      new Set(discovered.map(({ canonicalGitDir }) => canonicalGitDir)).size !==
        discovered.length ||
      new Set(discovered.map(({ canonicalPath }) => canonicalPath)).size !==
        discovered.length
    ) {
      throw new DomainError(
        "conflict",
        "Linked-worktree discovery returned duplicate identities or paths.",
      );
    }

    return this.database
      .transaction(() => {
        this.#getWorkspace(scope, workspaceId);
        const active = this.list(scope, workspaceId);
        const discoveredIdentities = new Set(
          discovered.map(({ identityToken }) => identityToken),
        );
        const tombstoned = input.complete
          ? active.filter(
              ({ identityToken }) => !discoveredIdentities.has(identityToken),
            )
          : [];
        const tombstonedRootIds = tombstoned.map(({ rootId }) => rootId);
        const clearedThreadIds: string[] = [];
        for (const { rootId } of tombstoned) {
          const rows = this.database
            .prepare(
              `SELECT state.thread_id AS threadId
               FROM thread_principal_state AS state
               JOIN application_threads AS thread
                 ON thread.tenant_id = state.tenant_id
                 AND thread.owner_principal_id = state.principal_id
                 AND thread.id = state.thread_id
               WHERE state.tenant_id = ? AND state.principal_id = ?
                 AND thread.workspace_id = ?
                 AND state.preferred_worktree_root_id = ?`,
            )
            .all(scope.tenantId, scope.principalId, workspaceId, rootId) as {
            readonly threadId: string;
          }[];
          clearedThreadIds.push(...rows.map(({ threadId }) => threadId));
          this.database
            .prepare(
              `UPDATE thread_principal_state
               SET preferred_worktree_root_id = NULL,
                 preferred_worktree_revision = preferred_worktree_revision + 1
               WHERE tenant_id = ? AND principal_id = ?
                 AND preferred_worktree_root_id = ?
                 AND thread_id IN (
                   SELECT id FROM application_threads
                   WHERE tenant_id = ? AND owner_principal_id = ?
                     AND workspace_id = ?
                 )`,
            )
            .run(
              scope.tenantId,
              scope.principalId,
              rootId,
              scope.tenantId,
              scope.principalId,
              workspaceId,
            );
          this.database
            .prepare(
              `UPDATE workspace_file_linked_worktree_roots
               SET availability = 'unavailable', unavailable_at = ?,
                 revision = revision + 1
               WHERE tenant_id = ? AND owner_principal_id = ?
                 AND workspace_id = ? AND root_id = ?
                 AND availability = 'available'`,
            )
            .run(
              input.now,
              scope.tenantId,
              scope.principalId,
              workspaceId,
              rootId,
            );
        }
        const survivors = active.filter(
          ({ rootId }) => !tombstonedRootIds.includes(rootId),
        );
        const activeByIdentity = new Map(
          survivors.map((root) => [root.identityToken, root] as const),
        );

        for (const candidate of discovered) {
          const current = activeByIdentity.get(candidate.identityToken);
          if (!current) {
            if (
              survivors.some(
                (root) =>
                  root.canonicalPath === candidate.canonicalPath ||
                  root.canonicalGitDir === candidate.canonicalGitDir,
              )
            ) {
              // A truncated discovery cannot prove that a prior identity which
              // owns this path is gone. Defer replacement until a complete pass.
              continue;
            }
            this.database
              .prepare(
                `INSERT INTO workspace_file_linked_worktree_roots(
                   tenant_id, owner_principal_id, workspace_id, root_id,
                   canonical_path, canonical_checkout_path, canonical_git_dir,
                   identity_token, display_label, branch_ref, head_oid,
                   provenance_kind, ahead_count, behind_count, availability, revision,
                   first_seen_at, last_seen_at, unavailable_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   'available', 1, ?, ?, NULL)`,
              )
              .run(
                scope.tenantId,
                scope.principalId,
                workspaceId,
                randomUUID(),
                candidate.canonicalPath,
                candidate.canonicalCheckoutPath,
                candidate.canonicalGitDir,
                candidate.identityToken,
                candidate.displayLabel,
                candidate.branchRef,
                candidate.headOid,
                candidate.provenanceKind,
                candidate.aheadCount,
                candidate.behindCount,
                input.now,
                input.now,
              );
            continue;
          }
          const changed =
            current.canonicalPath !== candidate.canonicalPath ||
            current.canonicalCheckoutPath !== candidate.canonicalCheckoutPath ||
            current.displayLabel !== candidate.displayLabel ||
            current.branchRef !== candidate.branchRef ||
            current.headOid !== candidate.headOid ||
            current.provenanceKind !== candidate.provenanceKind ||
            current.aheadCount !== candidate.aheadCount ||
            current.behindCount !== candidate.behindCount;
          this.database
            .prepare(
              `UPDATE workspace_file_linked_worktree_roots
               SET canonical_path = ?, canonical_checkout_path = ?,
                 display_label = ?, branch_ref = ?, head_oid = ?,
                 provenance_kind = ?, ahead_count = ?, behind_count = ?,
                 last_seen_at = max(last_seen_at, ?),
                 revision = revision + ?
               WHERE tenant_id = ? AND owner_principal_id = ?
                 AND workspace_id = ? AND root_id = ? AND availability = 'available'`,
            )
            .run(
              candidate.canonicalPath,
              candidate.canonicalCheckoutPath,
              candidate.displayLabel,
              candidate.branchRef,
              candidate.headOid,
              candidate.provenanceKind,
              candidate.aheadCount,
              candidate.behindCount,
              input.now,
              changed ? 1 : 0,
              scope.tenantId,
              scope.principalId,
              workspaceId,
              current.rootId,
            );
        }

        if (clearedThreadIds.length > 0) {
          const bumped = this.database
            .prepare(
              `UPDATE principal_generations
               SET inventory_generation = inventory_generation + 1
               WHERE tenant_id = ? AND principal_id = ?`,
            )
            .run(scope.tenantId, scope.principalId);
          if (bumped.changes !== 1) {
            throw new DomainError(
              "conflict",
              "The principal inventory generation is missing.",
            );
          }
        }
        return {
          roots: this.list(scope, workspaceId),
          tombstonedRootIds,
          clearedThreadIds: [...new Set(clearedThreadIds)],
        };
      })
      .immediate();
  }

  replayForget(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
    input: { readonly expectedRevision: number; readonly mutationId: string },
  ): LinkedWorktreeForgetResult | undefined {
    const fingerprint = this.#forgetFingerprint(
      workspaceId,
      rootId,
      input.expectedRevision,
    );
    const receipt = this.database
      .prepare(
        `SELECT operation_kind AS operationKind,
           request_fingerprint AS requestFingerprint, result_json AS resultJson
         FROM workspace_file_root_mutation_receipts
         WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, input.mutationId) as
      | {
          readonly operationKind: string;
          readonly requestFingerprint: string;
          readonly resultJson: string;
        }
      | undefined;
    if (!receipt) return undefined;
    if (
      receipt.operationKind !== "delete_linked_worktree" ||
      receipt.requestFingerprint !== fingerprint
    ) {
      throw new DomainError(
        "conflict",
        "The mutation ID was reused for a different operation.",
      );
    }
    return JSON.parse(receipt.resultJson) as LinkedWorktreeForgetResult;
  }

  forget(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
    input: {
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly outcome: "removed" | "forgotten";
      readonly now: number;
    },
  ): LinkedWorktreeForgetResult {
    const replayed = this.replayForget(scope, workspaceId, rootId, input);
    if (replayed) return replayed;
    return this.database.transaction(() => {
      this.#getWorkspace(scope, workspaceId);
      const root = this.get(scope, workspaceId, rootId);
      if (
        root.availability === "available" &&
        root.revision !== input.expectedRevision
      ) {
        throw new DomainError(
          "conflict",
          "The linked worktree changed in another client.",
        );
      }
      const rows = this.database
        .prepare(
          `SELECT state.thread_id AS threadId
           FROM thread_principal_state AS state
           JOIN application_threads AS thread
             ON thread.tenant_id = state.tenant_id
             AND thread.owner_principal_id = state.principal_id
             AND thread.id = state.thread_id
           WHERE state.tenant_id = ? AND state.principal_id = ?
             AND thread.workspace_id = ?
             AND state.preferred_worktree_root_id = ?`,
        )
        .all(scope.tenantId, scope.principalId, workspaceId, rootId) as {
        readonly threadId: string;
      }[];
      this.database
        .prepare(
          `UPDATE thread_principal_state
           SET preferred_worktree_root_id = NULL,
             preferred_worktree_revision = preferred_worktree_revision + 1
           WHERE tenant_id = ? AND principal_id = ?
             AND preferred_worktree_root_id = ?
             AND thread_id IN (
               SELECT id FROM application_threads
               WHERE tenant_id = ? AND owner_principal_id = ? AND workspace_id = ?
             )`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          rootId,
          scope.tenantId,
          scope.principalId,
          workspaceId,
        );
      this.database
        .prepare(
          `DELETE FROM workspace_file_linked_worktree_roots
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND workspace_id = ? AND root_id = ?`,
        )
        .run(scope.tenantId, scope.principalId, workspaceId, rootId);
      if (rows.length > 0) {
        this.database
          .prepare(
            `UPDATE principal_generations
             SET inventory_generation = inventory_generation + 1
             WHERE tenant_id = ? AND principal_id = ?`,
          )
          .run(scope.tenantId, scope.principalId);
      }
      const result: LinkedWorktreeForgetResult = {
        rootId,
        outcome: input.outcome,
        clearedThreadIds: rows.map(({ threadId }) => threadId),
      };
      this.database
        .prepare(
          `INSERT INTO workspace_file_root_mutation_receipts(
             tenant_id, principal_id, mutation_id, operation_kind,
             request_fingerprint, result_json, created_at
           ) VALUES (?, ?, ?, 'delete_linked_worktree', ?, ?, ?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          input.mutationId,
          this.#forgetFingerprint(workspaceId, rootId, input.expectedRevision),
          JSON.stringify(result),
          input.now,
        );
      return result;
    }).immediate();
  }

  #forgetFingerprint(
    workspaceId: string,
    rootId: string,
    expectedRevision: number,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          "delete_linked_worktree",
          workspaceId,
          rootId,
          expectedRevision,
          true,
        ]),
      )
      .digest("hex");
  }

  #getWorkspace(scope: RequestScope, workspaceId: string): void {
    const workspace = this.database
      .prepare(
        `SELECT 1 FROM workspaces
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.principalId, workspaceId);
    if (!workspace)
      throw new DomainError("not_found", "The workspace was not found.");
  }
}
