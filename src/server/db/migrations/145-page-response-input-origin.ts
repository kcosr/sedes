import type { DatabaseMigration } from "../migrate.js";

export const pageResponseInputOriginMigration: DatabaseMigration = {
  version: 145,
  name: "page_response_input_origin",
  sql: `
ALTER TABLE queued_inputs RENAME COLUMN question_response_origin_json TO input_origin_json;
`,
};
