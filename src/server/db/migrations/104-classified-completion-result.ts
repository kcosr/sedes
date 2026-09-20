import type { DatabaseMigration } from "../migrate.js";

export const classifiedCompletionResultMigration: DatabaseMigration = {
  version: 104,
  name: "classified_completion_result",
  // Old immutable completions deliberately retain unavailable classification.
  sql: `ALTER TABLE submission_completion_observations ADD COLUMN classified_result_json TEXT;`,
};
