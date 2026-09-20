import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  MAXIMUM_PENDING_QUESTION_REQUESTS,
  NONBLOCKING_QUESTIONS_MAXIMUM_PAYLOAD_BYTES,
  nonblockingQuestionsPayloadSchema,
  questionRequestSchema,
  type NonblockingQuestionsPayload,
  type QuestionRequest,
  type QuestionRequestsResult,
  questionStatusesRequestSchema,
  questionStatusesResultSchema,
  type QuestionStatusesResult,
} from "../../../shared/protocol/questions.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { InventoryRepository } from "./inventory-repository.js";

type QuestionRow = {
  id: string;
  sourceItemId: string;
  createdAt: number;
  payloadJson: string;
  revision: number;
};

/** Server-authorized durable admission and CAS resolution of asynchronous questions. */
export class QuestionRequestRepository {
  constructor(
    readonly database: Database.Database,
    private readonly inventory: Pick<InventoryRepository, "getInventory">,
  ) {}

  list(scope: RequestScope, threadId: string): QuestionRequestsResult {
    this.inventory.getInventory(scope, threadId);
    const head = this.database
      .prepare(
        `SELECT revision FROM question_request_heads
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      { revision: number } | undefined;
    const rows = this.database
      .prepare(
        `SELECT id, source_item_id AS sourceItemId,
      created_at AS createdAt, payload_json AS payloadJson, revision FROM question_requests
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND payload_json IS NOT NULL
      ORDER BY created_at, rowid`,
      )
      .all(scope.tenantId, scope.principalId, threadId) as QuestionRow[];
    return {
      revision: head?.revision ?? 0,
      requests: rows.map((row) => this.#decode(threadId, row)),
    };
  }

  statuses(
    scope: RequestScope,
    threadId: string,
    sourceItemIds: string[],
  ): QuestionStatusesResult {
    this.inventory.getInventory(scope, threadId);
    const ids = questionStatusesRequestSchema.parse({ sourceItemIds }).sourceItemIds;
    const head = this.database.prepare(`SELECT revision FROM question_request_heads
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`).get(
        scope.tenantId, scope.principalId, threadId,
      ) as { revision: number } | undefined;
    const rows = this.database.prepare(`SELECT source_item_id AS sourceItemId,
      payload_json AS payloadJson, resolution_json AS resolutionJson FROM question_requests
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
      AND source_item_id IN (${ids.map(() => "?").join(",")})
      ORDER BY source_item_id`).all(
        scope.tenantId, scope.principalId, threadId, ...ids,
      ) as {
        sourceItemId: string;
        payloadJson: string | null;
        resolutionJson: string;
      }[];
    return questionStatusesResultSchema.parse({
      revision: head?.revision ?? 0,
      statuses: rows.map((row) => {
        const resolutions = JSON.parse(row.resolutionJson) as Record<
          string, "answered" | "dismissed"
        >;
        const states = new Map<number, "pending" | "answered" | "dismissed">(
          Object.entries(resolutions).map(([index, status]) => [Number(index), status]),
        );
        if (row.payloadJson) {
          const payload = JSON.parse(row.payloadJson) as {
            questions: { index: number }[];
          };
          for (const question of payload.questions) {
            states.set(question.index, "pending");
          }
        }
        return {
          sourceItemId: row.sourceItemId,
          questions: [...states]
            .sort(([a], [b]) => a - b)
            .map(([index, status]) => ({ index, status })),
        };
      }),
    });
  }

  get(
    scope: RequestScope,
    threadId: string,
    id: string,
  ): QuestionRequest | undefined {
    this.inventory.getInventory(scope, threadId);
    const row = this.database
      .prepare(
        `SELECT id, source_item_id AS sourceItemId,
      created_at AS createdAt, payload_json AS payloadJson, revision FROM question_requests
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND id = ?
        AND payload_json IS NOT NULL`,
      )
      .get(scope.tenantId, scope.principalId, threadId, id) as
      QuestionRow | undefined;
    return row ? this.#decode(threadId, row) : undefined;
  }

  admit(
    scope: RequestScope,
    threadId: string,
    sourceItemId: string,
    payload: NonblockingQuestionsPayload,
    now: number,
  ): QuestionRequest | undefined {
    return this.database.transaction(() => {
      this.inventory.getInventory(scope, threadId);
      const count = this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM question_requests
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND payload_json IS NOT NULL`,
        )
        .get(scope.tenantId, scope.principalId, threadId) as { count: number };
      const parsed = nonblockingQuestionsPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        this.remember(scope, threadId, sourceItemId, now);
        return undefined;
      }
      const nativePayloadJson = JSON.stringify(parsed.data);
      if (
        count.count >= MAXIMUM_PENDING_QUESTION_REQUESTS ||
        Buffer.byteLength(nativePayloadJson) >
          NONBLOCKING_QUESTIONS_MAXIMUM_PAYLOAD_BYTES
      ) {
        this.remember(scope, threadId, sourceItemId, now);
        return undefined;
      }
      const payloadJson = JSON.stringify({
        questions: parsed.data.questions.map((question, index) => ({
          index,
          ...question,
        })),
      });
      const id = randomUUID();
      const inserted = this.database
        .prepare(
          `INSERT INTO question_requests
        (tenant_id, principal_id, thread_id, id, source_item_id, created_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, principal_id, thread_id, source_item_id) DO NOTHING`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          id,
          sourceItemId,
          now,
          payloadJson,
        );
      if (inserted.changes === 0) return undefined;
      this.#advance(scope, threadId);
      return this.#decode(threadId, {
        id,
        sourceItemId,
        createdAt: now,
        payloadJson,
        revision: 1,
      });
    })();
  }

  /** Record history identities without reviving questions from before observation began. */
  remember(
    scope: RequestScope,
    threadId: string,
    sourceItemId: string,
    now: number,
  ): void {
    this.inventory.getInventory(scope, threadId);
    this.database
      .prepare(
        `INSERT INTO question_requests
      (tenant_id, principal_id, thread_id, id, source_item_id, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(tenant_id, principal_id, thread_id, source_item_id) DO NOTHING`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        threadId,
        randomUUID(),
        sourceItemId,
        now,
      );
  }

  dismiss(
    scope: RequestScope,
    threadId: string,
    id: string,
    revision: number,
  ): boolean {
    return this.database.transaction(() => {
      const request = this.get(scope, threadId, id);
      if (!request || request.revision !== revision) return false;
      const resolutions = JSON.stringify(
        Object.fromEntries(request.questions.map(({ index }) => [index, "dismissed"])),
      );
      const result = this.database
        .prepare(
          `UPDATE question_requests SET payload_json = NULL, resolution_json = json_patch(resolution_json, ?), revision = revision + 1
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND id = ?
          AND payload_json IS NOT NULL AND revision = ?`,
        )
        .run(resolutions, scope.tenantId, scope.principalId, threadId, id, revision);
      if (result.changes === 0) return false;
      this.#advance(scope, threadId);
      return true;
    })();
  }

  /** Resolve an exact pending subset without renumbering the remaining questions. */
  resolveAnswers(
    scope: RequestScope,
    threadId: string,
    id: string,
    revision: number,
    questionIndices: number[],
  ): boolean {
    return this.database.transaction(() => {
      const request = this.get(scope, threadId, id);
      if (!request || request.revision !== revision) return false;
      const selected = new Set(questionIndices);
      if (
        selected.size === 0 ||
        selected.size !== questionIndices.length ||
        questionIndices.some(
          (index) =>
            !request.questions.some((question) => question.index === index),
        )
      )
        return false;
      const remaining = request.questions.filter(
        (question) => !selected.has(question.index),
      );
      const result = this.database
        .prepare(
          `
        UPDATE question_requests SET payload_json = ?, resolution_json = json_patch(resolution_json, ?), revision = revision + 1
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND id = ?
          AND payload_json IS NOT NULL AND revision = ?
      `,
        )
        .run(
          remaining.length > 0
            ? JSON.stringify({ questions: remaining })
            : null,
          JSON.stringify(Object.fromEntries(questionIndices.map((index) => [index, "answered"]))),
          scope.tenantId,
          scope.principalId,
          threadId,
          id,
          revision,
        );
      if (result.changes === 0) return false;
      this.#advance(scope, threadId);
      return true;
    })();
  }

  #advance(scope: RequestScope, threadId: string): void {
    this.database
      .prepare(
        `INSERT INTO question_request_heads
      (tenant_id, principal_id, thread_id, revision) VALUES (?, ?, ?, 1)
      ON CONFLICT(tenant_id, principal_id, thread_id) DO UPDATE SET revision = revision + 1`,
      )
      .run(scope.tenantId, scope.principalId, threadId);
  }

  #decode(threadId: string, row: QuestionRow): QuestionRequest {
    const payload = JSON.parse(row.payloadJson) as Pick<
      QuestionRequest,
      "questions"
    >;
    return questionRequestSchema.parse({
      id: row.id,
      threadId,
      sourceItemId: row.sourceItemId,
      revision: row.revision,
      createdAt: new Date(row.createdAt).toISOString(),
      questions: payload.questions,
    });
  }
}
