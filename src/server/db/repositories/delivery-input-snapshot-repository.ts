import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  deliveryInputOriginSchema,
  type DeliveryInputOrigin,
} from "../../../shared/protocol/conversation.js";
import {
  composerAttachmentArraySchema,
  type ComposerAttachmentDescriptor,
} from "../../../shared/protocol/composer-attachments.js";
import {
  contextExcerptArraySchema,
  type ContextExcerpt,
} from "../../../shared/protocol/context-excerpts.js";
import {
  materializedTaskContextsSchema,
  type MaterializedTaskContext,
} from "../../../shared/protocol/tasks.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  parseStoredContextExcerpts,
  serializeContextExcerpts,
} from "../context-excerpts-json.js";
import {
  assertMaterializedComposerBytes,
  parseStoredTaskContexts,
  serializeTaskContexts,
} from "../composer-tasks-json.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAXIMUM_OPERATION_ID_LENGTH = 160;
const MAXIMUM_SKILL_ID_LENGTH = 160;

export type PrepareDeliveryInputSnapshot = {
  readonly applicationOperationId: string;
  readonly text: string;
  readonly selectedSkillId?: string | null;
  readonly contextExcerpts: readonly ContextExcerpt[];
  readonly taskContexts: readonly MaterializedTaskContext[];
  readonly attachments: readonly Readonly<{
    descriptor: {
      readonly id: string;
      readonly kind: "file" | "image";
      readonly fileName: string;
      readonly mediaType: string;
      readonly byteSize: number;
    };
    sha256: string;
  }>[];
  readonly origin?: DeliveryInputOrigin;
  readonly createdAt: number;
};

export type DeliveryInputAttachmentEvidence = Readonly<{
  descriptor: ComposerAttachmentDescriptor;
  sha256: string;
}>;

export type DeliveryInputSnapshot = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly deliveryOperationId: string;
  readonly text: string;
  readonly selectedSkillId?: string;
  readonly contextExcerpts: readonly ContextExcerpt[];
  readonly taskContexts: readonly MaterializedTaskContext[];
  readonly attachments: readonly DeliveryInputAttachmentEvidence[];
  readonly origin?: DeliveryInputOrigin;
  readonly fingerprint: string;
  readonly createdAt: number;
};

type SnapshotRow = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly applicationOperationId: string;
  readonly text: string;
  readonly selectedSkillId: string | null;
  readonly contextExcerptsJson: string;
  readonly taskContextsJson: string;
  readonly attachmentsJson: string;
  readonly originJson: string | null;
  readonly fingerprint: string;
  readonly createdAt: number;
};

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS principalId,
  application_thread_id AS threadId,
  application_operation_id AS applicationOperationId,
  original_text AS text,
  selected_skill_id AS selectedSkillId,
  context_excerpts_json AS contextExcerptsJson,
  task_contexts_json AS taskContextsJson,
  attachments_json AS attachmentsJson,
  origin_json AS originJson,
  fingerprint,
  created_at AS createdAt
`;

function parseAttachments(value: string): DeliveryInputAttachmentEvidence[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not_array");
    const descriptors = composerAttachmentArraySchema.parse(
      parsed.map((entry) =>
        typeof entry === "object" && entry !== null && "descriptor" in entry
          ? (entry as { readonly descriptor: unknown }).descriptor
          : undefined,
      ),
    );
    return descriptors.map((descriptor, index) => {
      const entry = parsed[index] as { readonly sha256?: unknown };
      if (
        typeof entry.sha256 !== "string" ||
        !SHA256_PATTERN.test(entry.sha256)
      ) {
        throw new Error("invalid_sha256");
      }
      if (Object.keys(entry).length !== 2) throw new Error("unknown_field");
      return { descriptor, sha256: entry.sha256 };
    });
  } catch (error) {
    throw new DomainError(
      "conflict",
      "The stored delivery attachment evidence is invalid.",
      false,
      { cause: error },
    );
  }
}

function normalizeInput(input: PrepareDeliveryInputSnapshot): {
  readonly applicationOperationId: string;
  readonly text: string;
  readonly selectedSkillId?: string;
  readonly contextExcerpts: readonly ContextExcerpt[];
  readonly taskContexts: readonly MaterializedTaskContext[];
  readonly attachments: readonly DeliveryInputAttachmentEvidence[];
  readonly origin?: DeliveryInputOrigin;
  readonly createdAt: number;
} {
  if (
    input.applicationOperationId.length < 1 ||
    input.applicationOperationId.length > MAXIMUM_OPERATION_ID_LENGTH
  ) {
    throw new DomainError(
      "conflict",
      "The delivery operation identifier is invalid.",
    );
  }
  if (
    input.selectedSkillId != null &&
    (input.selectedSkillId.length < 1 ||
      input.selectedSkillId.length > MAXIMUM_SKILL_ID_LENGTH)
  ) {
    throw new DomainError(
      "conflict",
      "The selected skill identifier is invalid.",
    );
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new DomainError(
      "conflict",
      "The delivery snapshot timestamp is invalid.",
    );
  }
  const contextExcerpts = contextExcerptArraySchema.parse(
    input.contextExcerpts,
  );
  const taskContexts = materializedTaskContextsSchema.parse(input.taskContexts);
  const descriptors = composerAttachmentArraySchema.parse(
    input.attachments.map(({ descriptor }) => descriptor),
  );
  const attachments = descriptors.map((descriptor, index) => {
    const sha256 = input.attachments[index]?.sha256;
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
      throw new DomainError(
        "conflict",
        "A delivery attachment digest is invalid.",
      );
    }
    return { descriptor, sha256 };
  });
  const origin =
    input.origin === undefined
      ? undefined
      : deliveryInputOriginSchema.parse(input.origin);
  assertMaterializedComposerBytes({
    text: input.text,
    contextExcerpts,
    taskContexts,
  });
  return {
    applicationOperationId: input.applicationOperationId,
    text: input.text,
    selectedSkillId: input.selectedSkillId ?? undefined,
    contextExcerpts,
    taskContexts,
    attachments,
    ...(origin === undefined ? {} : { origin }),
    createdAt: input.createdAt,
  };
}

function snapshotFingerprint(
  threadId: string,
  input: ReturnType<typeof normalizeInput>,
): string {
  const fingerprintVersion = input.origin === undefined ? 1 : 2;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "delivery_input_snapshot",
        fingerprintVersion,
        threadId,
        input.applicationOperationId,
        input.text,
        input.selectedSkillId ?? null,
        input.contextExcerpts,
        input.taskContexts,
        input.attachments,
        ...(input.origin === undefined ? [] : [input.origin]),
      ]),
    )
    .digest("hex");
}

function present(row: SnapshotRow): DeliveryInputSnapshot {
  const snapshot = {
    tenantId: row.tenantId,
    principalId: row.principalId,
    threadId: row.threadId,
    deliveryOperationId: row.applicationOperationId,
    text: row.text,
    ...(row.selectedSkillId === null
      ? {}
      : { selectedSkillId: row.selectedSkillId }),
    contextExcerpts: Object.freeze(
      parseStoredContextExcerpts(row.contextExcerptsJson),
    ),
    taskContexts: Object.freeze(parseStoredTaskContexts(row.taskContextsJson)),
    attachments: Object.freeze(
      parseAttachments(row.attachmentsJson).map((entry) =>
        Object.freeze({
          descriptor: Object.freeze(entry.descriptor),
          sha256: entry.sha256,
        }),
      ),
    ),
    ...(row.originJson === null
      ? {}
      : {
          origin: Object.freeze(
            deliveryInputOriginSchema.parse(
              JSON.parse(row.originJson) as unknown,
            ),
          ),
        }),
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
  const expected = snapshotFingerprint(row.threadId, {
    applicationOperationId: snapshot.deliveryOperationId,
    text: snapshot.text,
    selectedSkillId: snapshot.selectedSkillId,
    contextExcerpts: snapshot.contextExcerpts,
    taskContexts: snapshot.taskContexts,
    attachments: snapshot.attachments,
    origin: snapshot.origin,
    createdAt: snapshot.createdAt,
  });
  if (expected !== row.fingerprint) {
    throw new DomainError(
      "conflict",
      "The stored delivery input snapshot is corrupt.",
    );
  }
  return Object.freeze(snapshot);
}

export class DeliveryInputSnapshotRepository {
  constructor(readonly database: Database.Database) {}

  prepare(
    scope: RequestScope,
    threadId: string,
    input: PrepareDeliveryInputSnapshot,
  ): DeliveryInputSnapshot {
    return this.database.transaction(() => {
      const normalized = normalizeInput(input);
      const fingerprint = snapshotFingerprint(threadId, normalized);
      const current = this.find(
        scope,
        threadId,
        normalized.applicationOperationId,
      );
      if (current) {
        if (current.fingerprint !== fingerprint) {
          throw new DomainError(
            "conflict",
            "The delivery operation identifier already has different prepared input.",
          );
        }
        return current;
      }
      const thread = this.database
        .prepare(
          `
            SELECT 1
            FROM application_threads
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .get(scope.tenantId, scope.principalId, threadId);
      if (!thread) {
        throw new DomainError(
          "not_found",
          "The application thread was not found.",
        );
      }
      this.database
        .prepare(
          `
            INSERT INTO delivery_input_snapshots(
              tenant_id, owner_principal_id, application_thread_id,
              application_operation_id, original_text, selected_skill_id,
              context_excerpts_json, task_contexts_json, attachments_json,
              origin_json, fingerprint, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          normalized.applicationOperationId,
          normalized.text,
          normalized.selectedSkillId ?? null,
          serializeContextExcerpts(normalized.contextExcerpts),
          serializeTaskContexts(normalized.taskContexts),
          JSON.stringify(normalized.attachments),
          normalized.origin === undefined
            ? null
            : JSON.stringify(normalized.origin),
          fingerprint,
          normalized.createdAt,
        );
      return this.find(scope, threadId, normalized.applicationOperationId)!;
    })();
  }

  find(
    scope: RequestScope,
    threadId: string,
    operationId: string,
  ): DeliveryInputSnapshot | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM delivery_input_snapshots
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND application_operation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId, operationId) as
      SnapshotRow | undefined;
    return row ? present(row) : undefined;
  }

  /** Preserves canonical input projection across provider-native forks. */
  copyThread(
    scope: RequestScope,
    sourceThreadId: string,
    childThreadId: string,
  ): number {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `
            SELECT ${columns}
            FROM delivery_input_snapshots
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ?
            ORDER BY created_at, application_operation_id
          `,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          sourceThreadId,
        ) as SnapshotRow[];
      for (const row of rows) {
        const snapshot = present(row);
        this.prepare(scope, childThreadId, {
          applicationOperationId: snapshot.deliveryOperationId,
          text: snapshot.text,
          selectedSkillId: snapshot.selectedSkillId ?? null,
          contextExcerpts: snapshot.contextExcerpts,
          taskContexts: snapshot.taskContexts,
          attachments: snapshot.attachments,
          origin: snapshot.origin,
          createdAt: snapshot.createdAt,
        });
      }
      return rows.length;
    })();
  }

  remove(scope: RequestScope, threadId: string, operationId: string): boolean {
    return (
      this.database
        .prepare(
          `
            DELETE FROM delivery_input_snapshots
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND application_thread_id = ? AND application_operation_id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, threadId, operationId)
        .changes === 1
    );
  }
}
