import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ContextExcerpt } from "../../../shared/protocol/context-excerpts.js";
import type { ComposerAttachmentDescriptor } from "../../../shared/protocol/composer-attachments.js";
import {
  parseStoredContextExcerpts,
  serializeContextExcerpts,
} from "../context-excerpts-json.js";
import { ComposerAttachmentRepository } from "./composer-attachment-repository.js";
import type { ComposerTaskReference } from "../../../shared/protocol/tasks.js";
import {
  parseStoredTaskReferences,
  resolveDraftTaskReferences,
  serializeTaskReferences,
} from "../composer-tasks-json.js";

export type ConversationDraftRecord = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly threadId: string;
  readonly text: string;
  readonly selectedSkillId: string | null;
  readonly contextExcerpts: ContextExcerpt[];
  readonly attachments: ComposerAttachmentDescriptor[];
  readonly taskReferences: ComposerTaskReference[];
  readonly updatedAt: number;
  readonly revision: number;
};

const columns = `
  tenant_id AS tenantId,
  principal_id AS principalId,
  thread_id AS threadId,
  text, selected_skill_id AS selectedSkillId,
  context_excerpts_json AS contextExcerptsJson,
  task_references_json AS taskReferencesJson,
  updated_at AS updatedAt,
  revision
`;

export class ConversationDraftRepository {
  readonly #attachments: ComposerAttachmentRepository;

  constructor(readonly database: Database.Database) {
    this.#attachments = new ComposerAttachmentRepository(database);
  }

  create(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly text?: string;
      readonly selectedSkillId?: string;
      readonly contextExcerpts?: readonly ContextExcerpt[];
      readonly attachmentIds?: readonly string[];
      readonly taskReferenceIds?: readonly string[];
      readonly now: number;
    },
  ): ConversationDraftRecord {
    this.database.transaction(() => {
      this.#attachments.replaceOwnerLinks(
        scope,
        { kind: "draft", threadId },
        input.attachmentIds ?? [],
      );
      this.database
        .prepare(
          `
          INSERT INTO thread_drafts(
            tenant_id, principal_id, thread_id, text, selected_skill_id,
            context_excerpts_json, task_references_json,
            updated_at, revision
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          threadId,
          input.text ?? "",
          input.selectedSkillId ?? null,
          serializeContextExcerpts(input.contextExcerpts ?? []),
          serializeTaskReferences(
            resolveDraftTaskReferences(
              this.database,
              scope,
              [],
              input.taskReferenceIds ?? [],
            ),
          ),
          input.now,
        );
    })();
    return this.get(scope, threadId);
  }

  get(scope: RequestScope, threadId: string): ConversationDraftRecord {
    const row = this.find(scope, threadId);
    if (!row) throw new DomainError("not_found", "The draft was not found.");
    return row;
  }

  find(
    scope: RequestScope,
    threadId: string,
  ): ConversationDraftRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM thread_drafts
          WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId) as
      | (Omit<
          ConversationDraftRecord,
          "contextExcerpts" | "attachments" | "taskReferences"
        > & {
          readonly contextExcerptsJson: string;
          readonly taskReferencesJson: string;
        })
      | undefined;
    return row
      ? {
          ...row,
          contextExcerpts: parseStoredContextExcerpts(row.contextExcerptsJson),
          taskReferences: parseStoredTaskReferences(row.taskReferencesJson),
          attachments: this.#attachments.descriptorsForOwner(scope, {
            kind: "draft",
            threadId,
          }),
        }
      : undefined;
  }

  save(
    scope: RequestScope,
    threadId: string,
    input: {
      readonly text: string;
      readonly selectedSkillId?: string;
      readonly contextExcerpts: readonly ContextExcerpt[];
      readonly attachmentIds: readonly string[];
      readonly taskReferenceIds: readonly string[];
      readonly expectedRevision: number;
      readonly now: number;
    },
  ): ConversationDraftRecord {
    const changed = this.database.transaction(() => {
      this.#attachments.replaceOwnerLinks(
        scope,
        { kind: "draft", threadId },
        input.attachmentIds,
      );
      return this.database
        .prepare(
          `
            UPDATE thread_drafts
            SET text = ?, selected_skill_id = ?, context_excerpts_json = ?,
              task_references_json = ?,
              updated_at = ?,
              revision = revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
              AND revision = ?
          `,
        )
        .run(
          input.text,
          input.selectedSkillId ?? null,
          serializeContextExcerpts(input.contextExcerpts),
          serializeTaskReferences(
            resolveDraftTaskReferences(
              this.database,
              scope,
              this.get(scope, threadId).taskReferences,
              input.taskReferenceIds,
            ),
          ),
          input.now,
          scope.tenantId,
          scope.principalId,
          threadId,
          input.expectedRevision,
        );
    })();
    if (changed.changes !== 1) {
      throw new DomainError(
        "draft_revision_conflict",
        "The draft changed before it could be saved.",
      );
    }
    return this.get(scope, threadId);
  }
}
