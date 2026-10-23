export const automaticModelRetryMigration = {
  version: 155,
  name: "automatic_model_retry",
  sql: `
ALTER TABLE principal_application_preferences
ADD COLUMN auto_retry_model_failures INTEGER NOT NULL DEFAULT 1
  CHECK (auto_retry_model_failures IN (0, 1));
`,
} as const;
