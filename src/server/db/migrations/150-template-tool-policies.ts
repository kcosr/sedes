import type { DatabaseMigration } from "../migrate.js";

export const templateToolPoliciesMigration: DatabaseMigration = {
  version: 150,
  name: "template_tool_policies",
  sql: `
ALTER TABLE thread_templates ADD COLUMN tool_policy_selection_json TEXT NOT NULL DEFAULT '{"kind":"inherit"}' CHECK(json_valid(tool_policy_selection_json));
ALTER TABLE thread_templates ADD COLUMN tool_presentation_json TEXT CHECK(tool_presentation_json IS NULL OR json_valid(tool_presentation_json));
`,
};
