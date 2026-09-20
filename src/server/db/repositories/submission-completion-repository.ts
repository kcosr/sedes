import {
  classifiedAssistantResultSchema,
  type ClassifiedAssistantResult,
} from "../../../shared/protocol/completion-result.js";
import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  boundedTextSchema,
  type BoundedText,
} from "../../../shared/protocol/payload.js";
import { ComposerAttachmentRepository } from "./composer-attachment-repository.js";

export type SubmissionCompletionObservationRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly operationId: string;
  readonly acceptedAt: number;
  readonly backendCorrelation: string | null;
  readonly lastCompletionIdentity: string | null;
  readonly completionObservedAt: number | null;
  readonly applicationTurnId: string | null;
  readonly completionOutcome: "completed" | "interrupted" | "failed" | null;
  readonly assistantResult: BoundedText | null;
  readonly classifiedResult: ClassifiedAssistantResult | null;
  readonly attentionCreatedAt: number | null;
  readonly acknowledgedAt: number | null;
};

type ObservationRow = Omit<
  SubmissionCompletionObservationRecord,
  "assistantResult" | "classifiedResult"
> & { readonly assistantResultJson: string | null; readonly classifiedResultJson: string | null };

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  operation_id AS operationId,
  accepted_at AS acceptedAt,
  backend_correlation AS backendCorrelation,
  last_completion_identity AS lastCompletionIdentity,
  completion_observed_at AS completionObservedAt,
  application_turn_id AS applicationTurnId,
  completion_outcome AS completionOutcome,
  assistant_result_json AS assistantResultJson,
  classified_result_json AS classifiedResultJson,
  attention_created_at AS attentionCreatedAt,
  acknowledged_at AS acknowledgedAt
`;

function present(row: ObservationRow): SubmissionCompletionObservationRecord {
  let assistantResult: BoundedText | null = null;
  if (row.assistantResultJson !== null) {
    try {
      assistantResult = boundedTextSchema.parse(
        JSON.parse(row.assistantResultJson) as unknown,
      );
    } catch (error) {
      throw new DomainError(
        "conflict",
        "The stored completion assistant result is invalid.",
        false,
        { cause: error },
      );
    }
  }
  const classifiedResult = row.classifiedResultJson === null
    ? null
    : classifiedAssistantResultSchema.parse(JSON.parse(row.classifiedResultJson));
  const { assistantResultJson: _assistantResultJson, classifiedResultJson: _classifiedResultJson, ...record } = row;
  return Object.freeze({ ...record, assistantResult, classifiedResult });
}

type FinalizedCompletion = {
  readonly applicationTurnId: string;
  readonly outcome: "completed" | "interrupted" | "failed";
  readonly result: BoundedText;
  readonly classifiedResult: ClassifiedAssistantResult | null;
};

export class SubmissionCompletionRepository {
  readonly #attachments: ComposerAttachmentRepository;

  constructor(readonly database: Database.Database) {
    this.#attachments = new ComposerAttachmentRepository(database);
  }

  recordAccepted(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly operationId: string;
      readonly acceptedAt: number;
      readonly backendCorrelation?: string;
      readonly attachmentIds?: readonly string[];
    },
  ): SubmissionCompletionObservationRecord {
    return this.database.transaction(() => {
      const current = this.find(scope, applicationThreadId, input.operationId);
      if (current) {
        if (
          current.acceptedAt !== input.acceptedAt ||
          current.backendCorrelation !== (input.backendCorrelation ?? null)
        ) {
          throw new DomainError(
            "conflict",
            "The operation acceptance anchor does not match its durable record.",
          );
        }
        if (input.attachmentIds !== undefined) {
          const storedIds = this.#attachments
            .descriptorsForOwner(scope, {
              kind: "submitted",
              threadId: applicationThreadId,
              operationId: input.operationId,
            })
            .map(({ id }) => id);
          if (storedIds.join("\0") !== input.attachmentIds.join("\0")) {
            throw new DomainError(
              "conflict",
              "The operation acceptance attachments do not match its durable record.",
            );
          }
        }
        return current;
      }
      this.database
        .prepare(
          `
            INSERT INTO submission_completion_observations(
              tenant_id, owner_principal_id, application_thread_id,
              operation_id, accepted_at, backend_correlation
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.operationId,
          input.acceptedAt,
          input.backendCorrelation ?? null,
        );
      this.#attachments.replaceOwnerLinks(
        scope,
        {
          kind: "submitted",
          threadId: applicationThreadId,
          operationId: input.operationId,
        },
        input.attachmentIds ?? [],
      );
      return this.get(scope, applicationThreadId, input.operationId);
    })();
  }

  observeCompletion(
    scope: RequestScope,
    applicationThreadId: string,
    operationId: string,
    input: {
      readonly completionIdentity: string;
      readonly observedAt: number;
      readonly createAttention: boolean;
      readonly finalized?: FinalizedCompletion;
    },
  ): SubmissionCompletionObservationRecord {
    return this.database.transaction(() => {
      const current = this.get(scope, applicationThreadId, operationId);
      if (
        current.lastCompletionIdentity !== null &&
        current.lastCompletionIdentity !== input.completionIdentity
      ) {
        throw new DomainError(
          "conflict",
          "The accepted operation already has a different completion identity.",
        );
      }
      const attentionCreatedAt =
        input.createAttention && current.attentionCreatedAt === null
          ? this.#nextAttentionCreatedAt(
              scope,
              applicationThreadId,
              input.observedAt,
            )
          : input.observedAt;
      const finalized = input.finalized
        ? {
            ...input.finalized,
            result: boundedTextSchema.parse(input.finalized.result),
            classifiedResult: input.finalized.classifiedResult === null
              ? null
              : classifiedAssistantResultSchema.parse(input.finalized.classifiedResult),
          }
        : undefined;
      if (
        finalized &&
        current.applicationTurnId !== null &&
        (current.applicationTurnId !== finalized.applicationTurnId ||
          current.completionOutcome !== finalized.outcome ||
          JSON.stringify(current.assistantResult) !==
            JSON.stringify(finalized.result) ||
          (current.classifiedResult !== null &&
            JSON.stringify(current.classifiedResult) !==
              JSON.stringify(finalized.classifiedResult)))
      ) {
        throw new DomainError(
          "conflict",
          "The accepted operation already has a different finalized completion snapshot.",
        );
      }
      const result = this.database
        .prepare(
          `
            UPDATE submission_completion_observations
            SET last_completion_identity =
                  coalesce(last_completion_identity, ?),
              completion_observed_at =
                  coalesce(completion_observed_at, ?),
              attention_created_at = CASE
                WHEN ? = 1 THEN coalesce(attention_created_at, ?)
                ELSE attention_created_at
              END,
              application_turn_id = coalesce(application_turn_id, ?),
              completion_outcome = coalesce(completion_outcome, ?),
              assistant_result_json = coalesce(assistant_result_json, ?),
              classified_result_json = CASE WHEN application_turn_id IS NULL
                THEN ? ELSE classified_result_json END
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND operation_id = ?
              AND (
                last_completion_identity IS NULL
                OR last_completion_identity = ?
              )
          `,
        )
        .run(
          input.completionIdentity,
          input.observedAt,
          input.createAttention ? 1 : 0,
          attentionCreatedAt,
          finalized?.applicationTurnId ?? null,
          finalized?.outcome ?? null,
          finalized ? JSON.stringify(finalized.result) : null,
          finalized?.classifiedResult ? JSON.stringify(finalized.classifiedResult) : null,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          operationId,
          input.completionIdentity,
        );
      if (result.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The completion observation changed concurrently.",
        );
      }
      return this.get(scope, applicationThreadId, operationId);
    })();
  }

  /**
   * Observer seam for authoritative terminal backend-turn events. Imported
   * history has no Sedes acceptance anchor and is intentionally ignored.
   */
  observeBackendCompletion(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly backendCorrelation: string;
      readonly completionIdentity: string;
      readonly observedAt: number;
      readonly applicationTurnId: string;
      readonly outcome: "completed" | "interrupted" | "failed";
      readonly result: BoundedText;
      readonly classifiedResult: ClassifiedAssistantResult | null;
    },
  ): SubmissionCompletionObservationRecord | undefined {
    return this.database.transaction(() => {
      const matches = this.database
        .prepare(
          `
            SELECT operation_id AS operationId
            FROM submission_completion_observations
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND backend_correlation = ?
            ORDER BY operation_id
            LIMIT 2
          `,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.backendCorrelation,
        ) as Array<{ operationId: string }>;
      if (matches.length === 0) return undefined;
      if (matches.length > 1) {
        throw new DomainError(
          "conflict",
          "The backend completion correlation is not unique.",
        );
      }
      const current = this.get(
        scope,
        applicationThreadId,
        matches[0]!.operationId,
      );
      if (
        current.lastCompletionIdentity !== null &&
        current.lastCompletionIdentity !== input.completionIdentity
      ) {
        throw new DomainError(
          "conflict",
          "The accepted operation already has a different completion identity.",
        );
      }
      const observed = this.observeCompletion(
        scope,
        applicationThreadId,
        matches[0]!.operationId,
        {
          completionIdentity: input.completionIdentity,
          observedAt: input.observedAt,
          createAttention: true,
          finalized: {
            applicationTurnId: input.applicationTurnId,
            outcome: input.outcome,
            result: input.result,
            classifiedResult: input.classifiedResult,
          },
        },
      );
      // Reconciliation may have recorded the same terminal identity before
      // normalized history was available. Enrich that durable observation,
      // but do not replay thread activity/attention side effects.
      if (current.lastCompletionIdentity !== null) {
        return observed;
      }
      const thread = this.database
        .prepare(
          `
            UPDATE application_threads
            SET revision = revision + 1,
              last_activity_at = max(last_activity_at, ?), updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backing_state = 'bound'
          `,
        )
        .run(
          input.observedAt,
          input.observedAt,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
        );
      if (thread.changes !== 1) {
        throw new DomainError(
          "invalid_transition",
          "The bound thread changed while completion attention was recorded.",
        );
      }
      return observed;
    })();
  }

  acknowledgeThrough(
    scope: RequestScope,
    applicationThreadId: string,
    operationId: string,
    now: number,
  ): SubmissionCompletionObservationRecord {
    return this.database.transaction(() => {
      const target = this.get(scope, applicationThreadId, operationId);
      if (target.attentionCreatedAt === null) {
        throw new DomainError(
          "invalid_transition",
          "There is no completion attention to acknowledge.",
        );
      }
      this.database
        .prepare(
          `
            UPDATE submission_completion_observations
            SET acknowledged_at = coalesce(acknowledged_at, ?)
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ?
              AND attention_created_at IS NOT NULL
              AND acknowledged_at IS NULL
              AND (
                attention_created_at < ?
                OR (
                  attention_created_at = ?
                  AND operation_id <= ?
                )
              )
          `,
        )
        .run(
          now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          target.attentionCreatedAt,
          target.attentionCreatedAt,
          operationId,
        );
      return this.get(scope, applicationThreadId, operationId);
    })();
  }

  listUnacknowledged(
    scope: RequestScope,
  ): SubmissionCompletionObservationRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM submission_completion_observations
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND attention_created_at IS NOT NULL
            AND acknowledged_at IS NULL
          ORDER BY attention_created_at, application_thread_id, operation_id
        `,
      )
      .all(scope.tenantId, scope.principalId) as ObservationRow[];
    return rows.map(present);
  }

  find(
    scope: RequestScope,
    applicationThreadId: string,
    operationId: string,
  ): SubmissionCompletionObservationRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM submission_completion_observations
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND operation_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        operationId,
      ) as ObservationRow | undefined;
    return row ? present(row) : undefined;
  }

  #nextAttentionCreatedAt(
    scope: RequestScope,
    applicationThreadId: string,
    observedAt: number,
  ): number {
    // This timestamp is also the durable per-thread attention watermark.
    // Advancing equal or regressed clocks preserves causal acknowledgement:
    // a completion recorded after a visible snapshot must sort after it.
    const latest = this.database
      .prepare(
        `
          SELECT max(attention_created_at) AS latest
          FROM submission_completion_observations
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
            AND attention_created_at IS NOT NULL
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as {
      latest: number | null;
    };
    const next = Math.max(observedAt, (latest.latest ?? observedAt - 1) + 1);
    if (!Number.isSafeInteger(next)) {
      throw new DomainError(
        "conflict",
        "The completion attention watermark is exhausted.",
      );
    }
    return next;
  }

  get(
    scope: RequestScope,
    applicationThreadId: string,
    operationId: string,
  ): SubmissionCompletionObservationRecord {
    const row = this.find(scope, applicationThreadId, operationId);
    if (!row) {
      throw new DomainError(
        "not_found",
        "The completion observation was not found.",
      );
    }
    return row;
  }
}
