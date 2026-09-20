import type Database from "better-sqlite3";
import { z } from "zod";
import type { DatabaseMigration } from "../migrate.js";

const legacyPolicySchema = z
  .strictObject({
    enabled: z.boolean(),
    enabledToolIds: z.array(z.string().min(1).max(128)).max(512),
    presentationMode: z
      .enum(["cli", "native_progressive", "native_individual"])
      .optional(),
    environmentAccess: z.strictObject({
      otherEnvironments: z.enum(["ask", "allow"]),
    }),
  })
  .superRefine((policy, context) => {
    if (new Set(policy.enabledToolIds).size !== policy.enabledToolIds.length) {
      context.addIssue({
        code: "custom",
        message: "Saved Agent Sedes tool IDs must be unique.",
        path: ["enabledToolIds"],
      });
    }
  });

const migratedPolicySchema = z
  .strictObject({
    enabled: z.boolean(),
    enabledToolIds: z
      .array(
        z
          .string()
          .regex(/^[a-z][a-z0-9_.-]*$/)
          .max(128),
      )
      .max(512),
    presentation: z.strictObject({
      surface: z.enum(["native", "cli"]),
      mode: z.enum(["progressive", "individual"]),
    }),
    environmentAccess: z.strictObject({
      otherEnvironments: z.enum(["ask", "allow"]),
    }),
  })
  .superRefine((policy, context) => {
    if (new Set(policy.enabledToolIds).size !== policy.enabledToolIds.length) {
      context.addIssue({
        code: "custom",
        message: "Saved Agent Sedes tool IDs must be unique.",
        path: ["enabledToolIds"],
      });
    }
  });

type SavedAgentPolicyRow = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly backendTypeId: string;
  readonly sedesToolsJson: string;
};

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalLegacyPolicy(value: unknown) {
  const parsed = legacyPolicySchema.parse(value);
  return {
    enabled: parsed.enabled,
    enabledToolIds: [...parsed.enabledToolIds].sort(compareCodePoints),
    ...(parsed.presentationMode
      ? { presentationMode: parsed.presentationMode }
      : {}),
    environmentAccess: parsed.environmentAccess,
  };
}

function canonicalMigratedPolicy(value: unknown) {
  const parsed = migratedPolicySchema.parse(value);
  return {
    enabled: parsed.enabled,
    enabledToolIds: [...parsed.enabledToolIds].sort(compareCodePoints),
    presentation: parsed.presentation,
    environmentAccess: parsed.environmentAccess,
  };
}

function presentationFromLegacy(
  value: z.infer<typeof legacyPolicySchema>["presentationMode"],
  backendTypeId: string,
) {
  switch (value) {
    case "native_progressive":
      return { surface: "native" as const, mode: "progressive" as const };
    case "native_individual":
      return { surface: "native" as const, mode: "individual" as const };
    case "cli":
      return { surface: "cli" as const, mode: "progressive" as const };
    case undefined:
      switch (backendTypeId) {
        case "pi":
          return { surface: "native" as const, mode: "progressive" as const };
        case "codex":
        case "claude":
        case "grok":
          return { surface: "cli" as const, mode: "progressive" as const };
        default:
          throw new Error("saved_agent_durable_state_invalid");
      }
  }
}

function migrateSavedAgentPolicies(database: Database.Database): void {
  const rows = database
    .prepare(
      `
        SELECT tenant_id AS tenantId, owner_principal_id AS principalId,
          id AS agentId, backend_type_id AS backendTypeId,
          sedes_tools_json AS sedesToolsJson
        FROM saved_agents
        WHERE sedes_tools_json IS NOT NULL
        ORDER BY tenant_id, owner_principal_id, id
      `,
    )
    .all() as SavedAgentPolicyRow[];
  const update = database.prepare(
    `UPDATE saved_agents SET sedes_tools_json = ?
     WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
  );
  for (const row of rows) {
    const parsedJson = JSON.parse(row.sedesToolsJson) as unknown;
    const legacy = canonicalLegacyPolicy(parsedJson);
    if (JSON.stringify(legacy) !== row.sedesToolsJson) {
      throw new Error("saved_agent_durable_state_invalid");
    }
    const migrated = canonicalMigratedPolicy({
      enabled: legacy.enabled,
      enabledToolIds: legacy.enabledToolIds,
      presentation: presentationFromLegacy(
        legacy.presentationMode,
        row.backendTypeId,
      ),
      environmentAccess: legacy.environmentAccess,
    });
    if (
      update.run(
        JSON.stringify(migrated),
        row.tenantId,
        row.principalId,
        row.agentId,
      ).changes !== 1
    ) {
      throw new Error("saved_agent_policy_migration_write_failed");
    }
  }
  for (const row of rows) {
    const persisted = database
      .prepare(
        `SELECT sedes_tools_json AS sedesToolsJson FROM saved_agents
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(row.tenantId, row.principalId, row.agentId) as
      { readonly sedesToolsJson: string } | undefined;
    if (!persisted)
      throw new Error("saved_agent_policy_migration_write_failed");
    const canonical = canonicalMigratedPolicy(
      JSON.parse(persisted.sedesToolsJson) as unknown,
    );
    if (JSON.stringify(canonical) !== persisted.sedesToolsJson) {
      throw new Error("saved_agent_durable_state_invalid");
    }
  }
}

export const agentToolPresentationAxesMigration: DatabaseMigration = {
  version: 85,
  name: "agent_tool_presentation_axes",
  requiresForeignKeysDisabled: true,
  verifyDatabaseIntegrity: true,
  preflight: migrateSavedAgentPolicies,
  sql: `
DROP TRIGGER application_threads_agent_tool_policy_insert;

ALTER TABLE thread_agent_tool_policies
  RENAME TO thread_agent_tool_policies_v82;
ALTER TABLE thread_agent_tool_policy_entries
  RENAME TO thread_agent_tool_policy_entries_v82;

CREATE TABLE thread_agent_tool_policies (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  presentation_surface TEXT NOT NULL CHECK (
    presentation_surface IN ('native', 'cli')
  ),
  presentation_mode TEXT NOT NULL CHECK (
    presentation_mode IN ('progressive', 'individual')
  ),
  other_environment_access TEXT NOT NULL CHECK (
    other_environment_access IN ('ask', 'allow')
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE thread_agent_tool_policy_entries (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  tool_id TEXT NOT NULL CHECK (length(tool_id) BETWEEN 1 AND 128),
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id, tool_id
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
    REFERENCES thread_agent_tool_policies(
      tenant_id, owner_principal_id, application_thread_id
    ) ON DELETE CASCADE
) STRICT;

INSERT INTO thread_agent_tool_policies(
  tenant_id, owner_principal_id, application_thread_id, enabled,
  presentation_surface, presentation_mode, other_environment_access,
  revision, updated_at
)
SELECT tenant_id, owner_principal_id, application_thread_id, enabled,
  CASE presentation_mode
    WHEN 'native_progressive' THEN 'native'
    WHEN 'native_individual' THEN 'native'
    ELSE 'cli'
  END,
  CASE presentation_mode
    WHEN 'native_individual' THEN 'individual'
    ELSE 'progressive'
  END,
  other_environment_access, revision, updated_at
FROM thread_agent_tool_policies_v82;

INSERT INTO thread_agent_tool_policy_entries(
  tenant_id, owner_principal_id, application_thread_id, tool_id
)
SELECT tenant_id, owner_principal_id, application_thread_id, tool_id
FROM thread_agent_tool_policy_entries_v82;

DROP TABLE thread_agent_tool_policy_entries_v82;
DROP TABLE thread_agent_tool_policies_v82;

CREATE TRIGGER application_threads_agent_tool_policy_insert
AFTER INSERT ON application_threads
BEGIN
  INSERT INTO thread_agent_tool_policies(
    tenant_id, owner_principal_id, application_thread_id, enabled,
    presentation_surface, presentation_mode, other_environment_access,
    revision, updated_at
  )
  SELECT NEW.tenant_id, NEW.owner_principal_id, NEW.id, 0,
    CASE WHEN backend.kind = 'pi' THEN 'native' ELSE 'cli' END,
    'progressive', 'ask', 0, NEW.updated_at
  FROM agent_backend_instances AS backend
  WHERE backend.tenant_id = NEW.tenant_id
    AND backend.id = NEW.backend_instance_id;
END;
`,
};
