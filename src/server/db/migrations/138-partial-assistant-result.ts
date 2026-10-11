import type { DatabaseMigration } from "../migrate.js";

/** Existing frozen classifications predate partial evidence; preserve their text. */
export const partialAssistantResultMigration: DatabaseMigration = {
  version: 138,
  name: "partial_assistant_result",
  sql: `
UPDATE submission_completion_observations
SET classified_result_json = json_set(classified_result_json, '$.partial', NULL)
WHERE classified_result_json IS NOT NULL;
`,
};
