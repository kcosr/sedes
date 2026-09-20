import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ListTurnBookmarksResult,
  SetTurnBookmarkRequest,
  SetTurnBookmarkResult,
  TurnBookmark,
} from "../../../shared/protocol/turn-bookmarks.js";
import { MAXIMUM_TURN_BOOKMARKS_PER_THREAD } from "../../../shared/protocol/turn-bookmarks.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { InventoryRepository } from "./inventory-repository.js";

type BookmarkRow = {
  readonly turnId: string;
  readonly userPreview: string;
  readonly assistantPreview: string | null;
  readonly responseState: "responded" | "no_response";
  readonly createdAt: number;
};

type ReceiptRow = {
  readonly threadId: string;
  readonly requestFingerprint: string;
  readonly resultJson: string;
};

type StoredMutationResult = Omit<SetTurnBookmarkResult, "replayed">;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class ConversationTurnBookmarkRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly inventory: Pick<InventoryRepository, "getInventory">,
  ) {}

  list(scope: RequestScope, threadId: string): ListTurnBookmarksResult {
    const inventory = this.inventory.getInventory(scope, threadId);
    const bookmarks = this.database
      .prepare(
        `
          SELECT turn_id AS turnId, user_preview AS userPreview,
            assistant_preview AS assistantPreview,
            response_state AS responseState, created_at AS createdAt
          FROM conversation_turn_bookmarks
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          ORDER BY created_at, turn_id
          LIMIT ?
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        threadId,
        MAXIMUM_TURN_BOOKMARKS_PER_THREAD,
      ) as BookmarkRow[];
    return {
      revision: inventory.bookmarkRevision,
      bookmarks,
    };
  }

  set(
    scope: RequestScope,
    threadId: string,
    turnId: string,
    input: SetTurnBookmarkRequest,
    now: number,
  ): SetTurnBookmarkResult {
    const requestFingerprint = fingerprint([
      "set_turn_bookmark",
      threadId,
      turnId,
      input,
    ]);
    return this.database.transaction(() => {
      const receipt = this.#receipt(scope, input.mutationId);
      if (receipt) {
        if (
          receipt.threadId !== threadId ||
          receipt.requestFingerprint !== requestFingerprint
        ) {
          throw new DomainError(
            "conflict",
            "The mutation ID was reused for a different operation.",
          );
        }
        const result = JSON.parse(receipt.resultJson) as StoredMutationResult;
        return { ...result, replayed: true };
      }

      const inventory = this.inventory.getInventory(scope, threadId);
      if (inventory.bookmarkRevision !== input.expectedRevision) {
        throw new DomainError(
          "bookmark_revision_conflict",
          "The thread bookmarks changed in another client.",
        );
      }

      const current = this.#get(scope, threadId, turnId);
      let bookmark: TurnBookmark | null = null;
      let changed = false;
      if (input.bookmarked) {
        bookmark = {
          turnId,
          userPreview: input.userPreview,
          assistantPreview: input.assistantPreview,
          responseState: input.responseState,
          createdAt: current?.createdAt ?? now,
        };
        changed =
          current === undefined ||
          current.userPreview !== bookmark.userPreview ||
          current.assistantPreview !== bookmark.assistantPreview ||
          current.responseState !== bookmark.responseState;
        if (current === undefined) this.#assertCapacity(scope, threadId);
        if (changed) this.#upsert(scope, threadId, bookmark);
      } else if (current !== undefined) {
        this.database
          .prepare(
            `
              DELETE FROM conversation_turn_bookmarks
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND turn_id = ?
            `,
          )
          .run(scope.tenantId, scope.principalId, threadId, turnId);
        changed = true;
      }

      const revision = input.expectedRevision + (changed ? 1 : 0);
      if (changed) {
        const update = this.database
          .prepare(
            `
              UPDATE thread_principal_state
              SET bookmark_revision = bookmark_revision + 1
              WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
                AND bookmark_revision = ?
            `,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            threadId,
            input.expectedRevision,
          );
        if (update.changes !== 1) {
          throw new DomainError(
            "bookmark_revision_conflict",
            "The thread bookmarks changed in another client.",
          );
        }
      }
      const result: StoredMutationResult = { revision, bookmark };
      this.database
        .prepare(
          `
            INSERT INTO conversation_turn_bookmark_mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id,
              request_fingerprint, result_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.mutationId,
          requestFingerprint,
          JSON.stringify(result),
          now,
        );
      return { ...result, replayed: false };
    })();
  }

  #get(
    scope: RequestScope,
    threadId: string,
    turnId: string,
  ): BookmarkRow | undefined {
    return this.database
      .prepare(
        `
          SELECT turn_id AS turnId, user_preview AS userPreview,
            assistant_preview AS assistantPreview,
            response_state AS responseState, created_at AS createdAt
          FROM conversation_turn_bookmarks
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
            AND turn_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId, turnId) as
      BookmarkRow | undefined;
  }

  #assertCapacity(scope: RequestScope, threadId: string): void {
    const row = this.database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM conversation_turn_bookmarks
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as { count: number };
    if (row.count >= MAXIMUM_TURN_BOOKMARKS_PER_THREAD) {
      throw new DomainError(
        "conflict",
        `A thread can have at most ${MAXIMUM_TURN_BOOKMARKS_PER_THREAD} bookmarks.`,
      );
    }
  }

  #upsert(scope: RequestScope, threadId: string, bookmark: TurnBookmark): void {
    this.database
      .prepare(
        `
          INSERT INTO conversation_turn_bookmarks(
            tenant_id, principal_id, thread_id, turn_id, user_preview,
            assistant_preview, response_state, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, principal_id, thread_id, turn_id) DO UPDATE SET
            user_preview = excluded.user_preview,
            assistant_preview = excluded.assistant_preview,
            response_state = excluded.response_state
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        threadId,
        bookmark.turnId,
        bookmark.userPreview,
        bookmark.assistantPreview,
        bookmark.responseState,
        bookmark.createdAt,
      );
  }

  #receipt(scope: RequestScope, mutationId: string): ReceiptRow | undefined {
    return this.database
      .prepare(
        `
          SELECT thread_id AS threadId,
            request_fingerprint AS requestFingerprint,
            result_json AS resultJson
          FROM conversation_turn_bookmark_mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      ReceiptRow | undefined;
  }
}
