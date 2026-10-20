import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ContextExcerpt } from "../../../shared/protocol/context-excerpts.js";
import type { ComposerAttachmentDescriptor } from "../../../shared/protocol/composer-attachments.js";
import { parseStoredContextExcerpts } from "../context-excerpts-json.js";
import { ComposerAttachmentRepository } from "./composer-attachment-repository.js";
import type { ComposerTaskReference } from "../../../shared/protocol/tasks.js";
import { parseStoredTaskReferences } from "../composer-tasks-json.js";

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
}
