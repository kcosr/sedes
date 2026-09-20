import type { DatabaseMigration } from "../migrate.js";

/** Old null payloads carry no resolution evidence and intentionally stay unknown. */
export const questionResolutionStatusMigration: DatabaseMigration = {
  version: 90,
  name: "question_resolution_status",
  sql: `
ALTER TABLE question_requests ADD COLUMN resolution_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(resolution_json) AND length(CAST(resolution_json AS BLOB)) <= 512);
`,
};
