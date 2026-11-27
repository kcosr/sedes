import type { ContextExcerpt } from "../../../shared/protocol/context-excerpts.js";
import { escapeHistoricalComposerText } from "../../domain/stored-composer-text.js";
import type { DatabaseMigration } from "../migrate.js";

export const inlineThreadReferencesMigration: DatabaseMigration = {
  version: 175,
  name: "inline_thread_references",
  sql: `
ALTER TABLE conversation_creation_attempts ADD COLUMN has_thread_reference_body INTEGER NOT NULL DEFAULT 0
  CHECK (has_thread_reference_body IN (0, 1) AND (has_thread_reference_body = 0 OR source_kind = 'composer'));
CREATE TRIGGER creation_attempt_thread_reference_body_immutable
BEFORE UPDATE OF has_thread_reference_body ON conversation_creation_attempts
WHEN NEW.has_thread_reference_body <> OLD.has_thread_reference_body
BEGIN
  SELECT RAISE(ABORT, 'Creation input body classification is immutable');
END;
ALTER TABLE queued_inputs ADD COLUMN has_thread_reference_body INTEGER NOT NULL DEFAULT 0
  CHECK (has_thread_reference_body IN (0, 1) AND
    (has_thread_reference_body = 0 OR (is_user_input = 1 AND trigger_kind = 'user' AND input_origin_json IS NULL)));
CREATE TRIGGER queued_input_thread_reference_body_immutable
BEFORE UPDATE OF has_thread_reference_body ON queued_inputs
WHEN NEW.has_thread_reference_body <> OLD.has_thread_reference_body
BEGIN
  SELECT RAISE(ABORT, 'Queued input body classification is immutable');
END;
ALTER TABLE delivery_input_snapshots ADD COLUMN has_thread_reference_body INTEGER NOT NULL DEFAULT 0
  CHECK (has_thread_reference_body IN (0, 1) AND (has_thread_reference_body = 0 OR origin_json IS NULL));
`,
  convertRows(database) {
    for (const table of ["thread_drafts", "prompt_stashes"]) {
      const candidates = database.prepare(`SELECT rowid, text, context_excerpts_json AS excerpts FROM ${table}
        WHERE text LIKE 'Sedes inline thread reference body:%'`).all() as {
        rowid: number; text: string; excerpts: string;
      }[];
      const update = database.prepare(`UPDATE ${table} SET text = ? WHERE rowid = ?`);
      for (const row of candidates) {
        const text = escapeHistoricalComposerText(row.text, JSON.parse(row.excerpts) as ContextExcerpt[]);
        if (text !== row.text) update.run(text, row.rowid);
      }
    }
  },
};
