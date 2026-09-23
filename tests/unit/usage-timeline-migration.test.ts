import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { usageSubagentsMigration } from "../../src/server/db/migrations/112-usage-subagents.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { UsageService } from "../../src/server/usage/usage-service.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

it("upgrades schema 112 by scheduling existing sources for a timeline rebuild without touching evidence", () => {
  const {database, scope} = savedAgentDatabase(112);
  try {
    expect(createHash("sha256").update(usageSubagentsMigration.sql).digest("hex")).toBe("97d2669688afb7e5b24c97ac42184f86c9ca059646c3ca8ac3fcace56c8d1300");
    const applied = database.prepare("SELECT * FROM schema_migrations WHERE version=112").get();
    const inventory = new InventoryRepository(database), environment = inventory.getLocalEnvironment(scope);
    const workspace = inventory.upsertWorkspace(scope, {environmentId: environment.id, canonicalPath: "/tmp/timeline-migration", displayName: "Timeline",
      available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 100});
    const profile = database.prepare("SELECT id, backend_instance_id FROM agent_connection_profiles LIMIT 1").get() as {id: string; backend_instance_id: string};
    const thread = new ConversationBindingRepository(database).createUnboundThread(scope, {workspaceId: workspace.id, connectionProfileId: profile.id, title: "Timeline", now: 110});
    database.prepare("INSERT INTO usage_thread_state(tenant_id,principal_id,thread_id) VALUES(?,?,?)").run(scope.tenantId, scope.principalId, thread.id);
    database.prepare(`INSERT INTO usage_sources(id,tenant_id,principal_id,thread_id,backend_id,environment_id,workspace_id,native_namespace,native_session,epoch,normalization_version,baseline,capture_state)
      VALUES('pi-source',?,?,?,?,?,?,'store','native','native_entries','v1','unknown','idle')`).run(scope.tenantId, scope.principalId, thread.id, profile.backend_instance_id, environment.id, workspace.id);
    const fact = {id: "entry:usage", kind: "operation", sessionContribution: "additive", coverageDomain: "pi_native_entries", tokens: {input: "12", output: "3"},
      costs: [{amount: "0.01", currency: "USD", kind: "estimated", provenance: "sdk"}], models: [{provider: "anthropic", model: "claude"}], basis: ["sdk_normalized"],
      providerPresence: "unknown", quality: "complete", reasons: [], activity: "model", turn: null};
    database.prepare(`INSERT INTO usage_observations(source_id,observation_id,revision,fingerprint,evidence_json,normalization_version,occurred_at,received_at)
      VALUES('pi-source','entry','1','fingerprint',?,'v1','2026-09-10T08:00:00.000Z','2026-09-10T08:00:02.000Z')`).run(JSON.stringify({order: null, replaceCheckpoint: false, facts: [fact]}));
    database.prepare(`INSERT INTO usage_records(source_id,fact_id,observation_id,observation_revision,turn_id,fact_json,input,output) VALUES('pi-source','entry:usage','entry','1',NULL,?,12,3)`).run(JSON.stringify(fact));
    const evidence = database.prepare("SELECT * FROM usage_observations").all();
    applyDatabaseMigrations(database, backendNormalizedMigrations);
    expect(database.prepare("SELECT * FROM schema_migrations WHERE version=112").get()).toEqual(applied);
    expect(database.prepare("SELECT timeline_state FROM usage_sources").pluck().all()).toEqual(["backfill"]);
    expect(database.prepare("SELECT * FROM usage_observations").all()).toEqual(evidence);
    const result = new UsageService(database).analytics(scope, {from: "2026-09-10T00:00:00.000Z", to: "2026-09-11T00:00:00.000Z", timeZone: "UTC",
      bucket: "day", filters: {}, groupBy: "model", crossBy: null, breakdownLimit: 10, facets: false});
    expect(result.totals).toMatchObject({tokens: "15", costs: [{amount: "0.01"}]});
    expect(result.placement.reported).toBe("15");
    expect(result.labels.thread[thread.id]?.label).toBe("Timeline");
    expect(database.prepare("SELECT timeline_state FROM usage_sources").pluck().all()).toEqual(["current"]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(() => database.prepare("UPDATE usage_sources SET timeline_state='rebuilding'").run()).toThrow();
    expect(() => applyDatabaseMigrations(database, backendNormalizedMigrations)).not.toThrow();
  } finally { database.close(); }
});
