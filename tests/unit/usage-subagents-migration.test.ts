import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { usageGapSessionScopeMigration } from "../../src/server/db/migrations/111-usage-gap-session-scope.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

it("upgrades schema 111 without changing existing evidence or previously applied migration checksums", () => {
  const {database,scope}=savedAgentDatabase(111);
  try {
    const checksum=createHash("sha256").update(usageGapSessionScopeMigration.sql).digest("hex");
    expect(checksum).toBe("e449c83095bf6d0334f81c861d8fe1d00623dce6418e830fc96f86b0f219221c");
    const applied=database.prepare("SELECT * FROM schema_migrations WHERE version=111").get();
    const inventory=new InventoryRepository(database), environment=inventory.getLocalEnvironment(scope);
    const workspace=inventory.upsertWorkspace(scope,{environmentId:environment.id,canonicalPath:"/tmp/subagent-migration",displayName:"Migration",available:true,trustState:"trusted",environmentConfigurationRevision:environment.configurationRevision,now:100});
    const profile=database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as {id:string};
    const thread=new ConversationBindingRepository(database).createUnboundThread(scope,{workspaceId:workspace.id,connectionProfileId:profile.id,title:"Migration",now:110});
    database.prepare("INSERT INTO usage_thread_state(tenant_id,principal_id,thread_id,revision,report_json) VALUES(?,?,?,7,'{}')").run(scope.tenantId,scope.principalId,thread.id);
    database.prepare("INSERT INTO usage_turn_state(tenant_id,principal_id,thread_id,turn_id,status,report_json) VALUES(?,?,?,'turn','completed','{}')").run(scope.tenantId,scope.principalId,thread.id);
    database.prepare(`INSERT INTO usage_sources(id,tenant_id,principal_id,thread_id,backend_id,environment_id,workspace_id,native_namespace,native_session,epoch,normalization_version,baseline,capture_state)
      VALUES('main',?,?,?,'codex',?,?,'store','native','epoch','v1','unknown','idle')`).run(scope.tenantId,scope.principalId,thread.id,environment.id,workspace.id);
    database.prepare(`INSERT INTO usage_observations(source_id,observation_id,revision,fingerprint,evidence_json,normalization_version,received_at)
      VALUES('main','one','1','fingerprint','{"facts":[]}','v1','2026-09-22T00:00:00Z')`).run();
    const evidence=database.prepare("SELECT * FROM usage_observations").all();
    applyDatabaseMigrations(database,backendNormalizedMigrations);
    expect(database.prepare("SELECT * FROM schema_migrations WHERE version=111").get()).toEqual(applied);
    expect(JSON.stringify(applied)).toContain(checksum);
    expect(database.prepare("SELECT agent_role FROM usage_sources").get()).toEqual({agent_role:"main"});
    expect(database.prepare("SELECT revision,report_json FROM usage_thread_state").get()).toEqual({revision:7,report_json:null});
    expect(database.prepare("SELECT report_json FROM usage_turn_state").get()).toEqual({report_json:null});
    expect(database.prepare("SELECT * FROM usage_observations").all()).toEqual(evidence);
    expect(database.prepare("SELECT * FROM usage_subagents").all()).toEqual([]);
    expect(()=>database.prepare("UPDATE usage_sources SET agent_role='unknown'").run()).toThrow();
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(()=>applyDatabaseMigrations(database,backendNormalizedMigrations)).not.toThrow();
  } finally {database.close();}
});
