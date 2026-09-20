import type { DatabaseMigration } from "../migrate.js";

/** Adds principal-owned pin state without coupling it to inventory lifecycle. */
export const threadPinningMigration: DatabaseMigration = {
  version: 62,
  name: "thread_pinning",
  verifyDatabaseIntegrity: true,
  sql: `
ALTER TABLE thread_principal_state
ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));

ALTER TABLE thread_principal_state
ADD COLUMN pin_revision INTEGER NOT NULL DEFAULT 0 CHECK (
  pin_revision BETWEEN 0 AND 9007199254740991
);
`,
};
