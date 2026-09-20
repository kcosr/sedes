export const applicationSummaryIndexMigration = {
  version: 13,
  name: "application_summary_index",
  sql: `
CREATE INDEX automation_runs_application_summary_latest
  ON automation_runs(
    tenant_id, owner_principal_id, automation_id,
    scheduled_for DESC, created_at DESC, id DESC
  );
`,
} as const;
