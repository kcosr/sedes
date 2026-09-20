import type Database from "better-sqlite3";
import { z } from "zod";
import type { DatabaseMigration } from "../migrate.js";

// Frozen at migration 56. Later application schemas must not reinterpret the
// durable bytes that existed when this migration originally shipped.
const migration56PolicySchema = z.strictObject({
  enabled: z.boolean(),
  enabledToolIds: z.array(z.string().min(1).max(128)).max(512),
  presentationMode: z
    .enum(["cli", "native_progressive", "native_individual"])
    .optional(),
  environmentAccess: z.strictObject({
    otherEnvironments: z.enum(["ask", "allow"]),
  }),
});

function canonicalMigration56Policy(value: unknown) {
  const parsed = migration56PolicySchema.parse(value);
  return {
    enabled: parsed.enabled,
    enabledToolIds: [...parsed.enabledToolIds].sort(),
    ...(parsed.presentationMode
      ? { presentationMode: parsed.presentationMode }
      : {}),
    environmentAccess: parsed.environmentAccess,
  };
}

type SavedAgentPolicyRow = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly harnessToolsJson: string;
};

function migrateSavedAgentPolicies(database: Database.Database): void {
  const rows = database
    .prepare(
      `
        SELECT
          tenant_id AS tenantId,
          owner_principal_id AS principalId,
          id AS agentId,
          harness_tools_json AS harnessToolsJson
        FROM saved_agents
        WHERE harness_tools_json IS NOT NULL
        ORDER BY tenant_id, owner_principal_id, id
      `,
    )
    .all() as SavedAgentPolicyRow[];
  const update = database.prepare(
    `
      UPDATE saved_agents
      SET harness_tools_json = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
    `,
  );
  for (const row of rows) {
    const parsed = JSON.parse(row.harnessToolsJson) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("saved_agent_durable_state_invalid");
    }
    const record = parsed as Record<string, unknown>;
    const migrated = canonicalMigration56Policy({
        ...record,
        environmentAccess: { otherEnvironments: "ask" },
      });
    const legacyCanonical = {
      enabled: migrated.enabled,
      enabledToolIds: migrated.enabledToolIds,
      ...(migrated.presentationMode
        ? { presentationMode: migrated.presentationMode }
        : {}),
    };
    if (JSON.stringify(legacyCanonical) !== row.harnessToolsJson) {
      throw new Error("saved_agent_durable_state_invalid");
    }
    const changed = update.run(
      JSON.stringify(migrated),
      row.tenantId,
      row.principalId,
      row.agentId,
    );
    if (changed.changes !== 1) {
      throw new Error("saved_agent_policy_migration_write_failed");
    }
  }

  for (const row of rows) {
    const persisted = database
      .prepare(
        `SELECT harness_tools_json AS harnessToolsJson
         FROM saved_agents
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(row.tenantId, row.principalId, row.agentId) as
      { readonly harnessToolsJson: string } | undefined;
    if (!persisted) {
      throw new Error("saved_agent_policy_migration_write_failed");
    }
    const canonical = canonicalMigration56Policy(
      JSON.parse(persisted.harnessToolsJson) as unknown,
    );
    if (JSON.stringify(canonical) !== persisted.harnessToolsJson) {
      throw new Error("saved_agent_durable_state_invalid");
    }
  }
}

/** Tightens all existing policies to one-shot cross-environment approval. */
export const agentToolEnvironmentAccessMigration: DatabaseMigration = {
  version: 56,
  name: "agent_tool_environment_access",
  verifyDatabaseIntegrity: true,
  preflight: migrateSavedAgentPolicies,
  sql: `
ALTER TABLE thread_agent_tool_policies
  ADD COLUMN other_environment_access TEXT NOT NULL DEFAULT 'ask'
  CHECK (other_environment_access IN ('ask', 'allow'));
`,
};
