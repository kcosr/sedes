import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  CANNED_PROMPT_MAX_ITEMS,
  cannedPromptIdSchema,
  cannedPromptLibrarySchema,
  createCannedPromptRequestSchema,
  deleteCannedPromptRequestSchema,
  reorderCannedPromptsRequestSchema,
  updateCannedPromptRequestSchema,
  type CannedPrompt,
  type CannedPromptLibrary,
  type CannedPromptMutationResult,
} from "../../../shared/protocol/canned-prompts.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

interface CollectionRow {
  readonly revision: number;
}

interface ReceiptRow {
  readonly operationKind: string;
  readonly requestFingerprint: string;
  readonly resultJson: string;
}

type StoredMutationResult = Omit<CannedPromptMutationResult, "replayed">;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function revisionConflict(): DomainError {
  return new DomainError(
    "conflict",
    "The canned prompt library changed in another client.",
  );
}

function invalidDurableState(cause?: unknown): Error {
  return new Error("canned_prompt_durable_state_invalid", { cause });
}

/** Principal-scoped persistence for one ordered canned-prompt collection. */
export class CannedPromptRepository {
  constructor(readonly database: Database.Database) {}

  list(scope: RequestScope): CannedPromptLibrary {
    const collection = this.#collection(scope);
    if (!collection) return { revision: 0, items: [] };
    return this.#readLibrary(scope, collection.revision);
  }

  create(
    scope: RequestScope,
    input: {
      readonly title: string;
      readonly text: string;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): CannedPromptMutationResult {
    input = {
      ...createCannedPromptRequestSchema.parse({
        title: input.title,
        text: input.text,
        expectedRevision: input.expectedRevision,
        mutationId: input.mutationId,
      }),
      now: input.now,
    };
    const requestFingerprint = fingerprint([
      "create",
      input.title,
      input.text,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      this.#ensureCollection(scope, input.now);
      const replay = this.#replay(
        scope,
        input.mutationId,
        "create",
        requestFingerprint,
      );
      if (replay) return replay;
      const current = this.#assertRevision(scope, input.expectedRevision);
      if (current.items.length >= CANNED_PROMPT_MAX_ITEMS) {
        throw new DomainError(
          "invalid_transition",
          `A canned prompt library can contain at most ${CANNED_PROMPT_MAX_ITEMS} prompts.`,
        );
      }
      this.database
        .prepare(
          `
            INSERT INTO canned_prompts(
              tenant_id, principal_id, id, title, prompt_text, position,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          randomUUID(),
          input.title,
          input.text,
          current.items.length,
          input.now,
          input.now,
        );
      const result = this.#finishMutation(
        scope,
        input.expectedRevision,
        input.now,
      );
      this.#insertReceipt(
        scope,
        input.mutationId,
        "create",
        requestFingerprint,
        result,
        input.now,
      );
      return { ...result, replayed: false };
    })();
  }

  update(
    scope: RequestScope,
    promptId: string,
    input: {
      readonly title: string;
      readonly text: string;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): CannedPromptMutationResult {
    promptId = cannedPromptIdSchema.parse(promptId);
    input = {
      ...updateCannedPromptRequestSchema.parse({
        title: input.title,
        text: input.text,
        expectedRevision: input.expectedRevision,
        mutationId: input.mutationId,
      }),
      now: input.now,
    };
    const requestFingerprint = fingerprint([
      "update",
      promptId,
      input.title,
      input.text,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const replay = this.#replay(
        scope,
        input.mutationId,
        "update",
        requestFingerprint,
      );
      if (replay) return replay;
      const current = this.#assertRevision(scope, input.expectedRevision);
      if (!current.items.some((item) => item.id === promptId)) {
        throw new DomainError("not_found", "The canned prompt was not found.");
      }
      const changed = this.database
        .prepare(
          `
            UPDATE canned_prompts
            SET title = ?, prompt_text = ?, updated_at = ?
            WHERE tenant_id = ? AND principal_id = ? AND id = ?
          `,
        )
        .run(
          input.title,
          input.text,
          input.now,
          scope.tenantId,
          scope.principalId,
          promptId,
        );
      if (changed.changes !== 1) {
        throw new DomainError("not_found", "The canned prompt was not found.");
      }
      const result = this.#finishMutation(
        scope,
        input.expectedRevision,
        input.now,
      );
      this.#insertReceipt(
        scope,
        input.mutationId,
        "update",
        requestFingerprint,
        result,
        input.now,
      );
      return { ...result, replayed: false };
    })();
  }

  delete(
    scope: RequestScope,
    promptId: string,
    input: {
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): CannedPromptMutationResult {
    promptId = cannedPromptIdSchema.parse(promptId);
    input = {
      ...deleteCannedPromptRequestSchema.parse({
        expectedRevision: input.expectedRevision,
        mutationId: input.mutationId,
      }),
      now: input.now,
    };
    const requestFingerprint = fingerprint([
      "delete",
      promptId,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const replay = this.#replay(
        scope,
        input.mutationId,
        "delete",
        requestFingerprint,
      );
      if (replay) return replay;
      const current = this.#assertRevision(scope, input.expectedRevision);
      const removedIndex = current.items.findIndex(
        (item) => item.id === promptId,
      );
      if (removedIndex < 0) {
        throw new DomainError("not_found", "The canned prompt was not found.");
      }
      this.#replaceItems(
        scope,
        current.items
          .filter((item) => item.id !== promptId)
          .map((item, position) => ({
            ...item,
            position,
            updatedAt: item.position === position ? item.updatedAt : input.now,
          })),
      );
      const result = this.#finishMutation(
        scope,
        input.expectedRevision,
        input.now,
      );
      this.#insertReceipt(
        scope,
        input.mutationId,
        "delete",
        requestFingerprint,
        result,
        input.now,
      );
      return { ...result, replayed: false };
    })();
  }

  reorder(
    scope: RequestScope,
    input: {
      readonly promptIds: readonly string[];
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): CannedPromptMutationResult {
    input = {
      ...reorderCannedPromptsRequestSchema.parse({
        promptIds: input.promptIds,
        expectedRevision: input.expectedRevision,
        mutationId: input.mutationId,
      }),
      now: input.now,
    };
    const requestFingerprint = fingerprint([
      "reorder",
      input.promptIds,
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const replay = this.#replay(
        scope,
        input.mutationId,
        "reorder",
        requestFingerprint,
      );
      if (replay) return replay;
      const current = this.#assertRevision(scope, input.expectedRevision);
      const requested = new Set(input.promptIds);
      if (
        requested.size !== input.promptIds.length ||
        requested.size !== current.items.length ||
        current.items.some((item) => !requested.has(item.id))
      ) {
        throw new DomainError(
          "bad_request",
          "A canned prompt reorder must include every prompt exactly once.",
        );
      }
      const byId = new Map(current.items.map((item) => [item.id, item]));
      this.#replaceItems(
        scope,
        input.promptIds.map((id, position) => {
          const item = byId.get(id);
          if (!item) throw invalidDurableState();
          return {
            ...item,
            position,
            updatedAt: item.position === position ? item.updatedAt : input.now,
          };
        }),
      );
      const result = this.#finishMutation(
        scope,
        input.expectedRevision,
        input.now,
      );
      this.#insertReceipt(
        scope,
        input.mutationId,
        "reorder",
        requestFingerprint,
        result,
        input.now,
      );
      return { ...result, replayed: false };
    })();
  }

  #collection(scope: RequestScope): CollectionRow | undefined {
    return this.database
      .prepare(
        `
          SELECT revision FROM canned_prompt_collections
          WHERE tenant_id = ? AND principal_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId) as CollectionRow | undefined;
  }

  #ensureCollection(scope: RequestScope, now: number): void {
    this.database
      .prepare(
        `
          INSERT INTO canned_prompt_collections(
            tenant_id, principal_id, revision, updated_at
          ) VALUES (?, ?, 0, ?)
          ON CONFLICT(tenant_id, principal_id) DO NOTHING
        `,
      )
      .run(scope.tenantId, scope.principalId, now);
  }

  #assertRevision(
    scope: RequestScope,
    expectedRevision: number,
  ): CannedPromptLibrary {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw revisionConflict();
    }
    const current = this.list(scope);
    if (current.revision !== expectedRevision) throw revisionConflict();
    return current;
  }

  #readLibrary(scope: RequestScope, revision: number): CannedPromptLibrary {
    const items = this.database
      .prepare(
        `
          SELECT id, title, prompt_text AS text, position,
            created_at AS createdAt, updated_at AS updatedAt
          FROM canned_prompts
          WHERE tenant_id = ? AND principal_id = ?
          ORDER BY position, id
        `,
      )
      .all(scope.tenantId, scope.principalId) as CannedPrompt[];
    if (items.some((item, index) => item.position !== index)) {
      throw invalidDurableState();
    }
    const parsed = cannedPromptLibrarySchema.safeParse({ revision, items });
    if (!parsed.success) throw invalidDurableState(parsed.error);
    return parsed.data;
  }

  #replaceItems(scope: RequestScope, items: readonly CannedPrompt[]): void {
    this.database
      .prepare(
        "DELETE FROM canned_prompts WHERE tenant_id = ? AND principal_id = ?",
      )
      .run(scope.tenantId, scope.principalId);
    const insert = this.database.prepare(
      `
        INSERT INTO canned_prompts(
          tenant_id, principal_id, id, title, prompt_text, position,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    for (const item of items) {
      insert.run(
        scope.tenantId,
        scope.principalId,
        item.id,
        item.title,
        item.text,
        item.position,
        item.createdAt,
        item.updatedAt,
      );
    }
  }

  #finishMutation(
    scope: RequestScope,
    expectedRevision: number,
    now: number,
  ): StoredMutationResult {
    const changed = this.database
      .prepare(
        `
          UPDATE canned_prompt_collections
          SET revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND principal_id = ? AND revision = ?
        `,
      )
      .run(now, scope.tenantId, scope.principalId, expectedRevision);
    if (changed.changes !== 1) throw revisionConflict();
    return this.#readLibrary(scope, expectedRevision + 1);
  }

  #replay(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
  ): CannedPromptMutationResult | undefined {
    const receipt = this.database
      .prepare(
        `
          SELECT operation_kind AS operationKind,
            request_fingerprint AS requestFingerprint,
            result_json AS resultJson
          FROM canned_prompt_mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      ReceiptRow | undefined;
    if (!receipt) return undefined;
    if (
      receipt.operationKind !== operationKind ||
      receipt.requestFingerprint !== requestFingerprint
    ) {
      throw new DomainError(
        "conflict",
        "The mutation id was already used for a different canned prompt operation.",
      );
    }
    try {
      const result = cannedPromptLibrarySchema.parse(
        JSON.parse(receipt.resultJson) as unknown,
      );
      return { ...result, replayed: true };
    } catch (cause) {
      throw invalidDurableState(cause);
    }
  }

  #insertReceipt(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
    result: StoredMutationResult,
    now: number,
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO canned_prompt_mutation_receipts(
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
