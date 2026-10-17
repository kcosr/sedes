import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { ToolPolicyRepository } from "../../src/server/db/repositories/tool-policy-repository.js";
import { ToolPolicyService } from "../../src/server/tool-policies/tool-policy-service.js";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import { toolPolicySetListSchema, TOOL_POLICY_MAX_BYTES } from "../../src/shared/protocol/tool-policies.js";
import { MAXIMUM_BROWSER_ENTITY_BYTES, serializedUtf8Bytes } from "../../src/shared/protocol/payload.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture(version?: number) {
  const state = savedAgentDatabase(version);
  databases.push(state.database);
  const repository = new ToolPolicyRepository(state.database);
  const service = new ToolPolicyService(repository);
  const target = {backendId:"pi-primary",executionEnvironmentId:"019196f7-a0a8-7bc4-a89b-8cf013978405"};
  return {...state,repository,service,target};
}
const definition = {name:"Everyday",enabledToolIds:["thread.list"],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}};

describe("principal-owned tool policies", () => {
  it("bounds serialized pages without losing policy sets or sharing cursors across owners", () => {
    const {scope,repository,service} = fixture();
    const enabledToolIds = Array.from({length:512},(_,index) => `tool${index}`.padEnd(128,"x"));
    const all = Array.from({length:15},(_,index) => repository.create(scope,{...definition,name:`Policy ${String(index).padStart(2,"0")}`,enabledToolIds}));
    expect(serializedUtf8Bytes(all[0])).toBeLessThan(TOOL_POLICY_MAX_BYTES);
    expect(toolPolicySetListSchema.safeParse({items:all}).success).toBe(false);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = service.list(scope,{...(cursor ? {cursor}:{}),pageSize:100});
      expect(serializedUtf8Bytes(page)).toBeLessThanOrEqual(MAXIMUM_BROWSER_ENTITY_BYTES);
      ids.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
      if (cursor) expect(() => service.list({...scope,principalId:"other"},{cursor})).toThrow("cursor is invalid");
    } while (cursor);
    expect(ids).toEqual(all.map(item => item.id));
    const escapedName = repository.create(scope,{...definition,name:"\u0001".repeat(160)});
    const escapedPage = service.list(scope,{pageSize:1});
    expect(escapedPage.items[0]?.id).toBe(escapedName.id);
    expect(escapedPage.nextCursor!.length).toBeGreaterThan(2048);
    expect(service.list(scope,{pageSize:1,cursor:escapedPage.nextCursor}).items[0]?.id).toBe(all[0]!.id);
  });

  it("rejects invalid oversized definitions before writing or changing a revision", () => {
    const {scope,repository,database} = fixture();
    const oversized = {...definition,enabledToolIds:Array.from({length:512},(_,index) => `tool${index}`.padEnd(300,"x"))};
    expect(() => repository.create(scope,oversized)).toThrow();
    expect(database.prepare("SELECT count(*) AS count FROM tool_policy_sets").get()).toEqual({count:0});
    const policy = repository.create(scope,definition);
    expect(() => repository.update(scope,policy.id,oversized,0)).toThrow();
    expect(repository.get(scope,policy.id)).toEqual(policy);
  });

  it("keeps preview read-only and rejects incompatible or foreign Saved Agents", () => {
    const {scope,repository,database} = fixture();
    const agents = new SavedAgentRepository(database);
    const base = {name:"Agent",description:"",backendOverridesSchemaVersion:1,backendOverrides:[],toolPolicySelection:{kind:"inherit" as const},now:100};
    const compatible = agents.create(scope,{...base,backendTypeId:"pi"});
    const incompatible = agents.create(scope,{...base,backendTypeId:"codex"});
    const target = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as {id:string};
    const service = new ToolPolicyService(repository,undefined,undefined,() => "pi");
    const before = database.prepare("SELECT total_changes() AS changes").get();
    expect(service.preview(scope,{targetId:target.id,agentId:compatible.id}).enabled).toBe(false);
    expect(() => service.preview(scope,{targetId:target.id,agentId:incompatible.id})).toThrow("different backend type");
    expect(() => service.preview({...scope,principalId:"foreign"},{targetId:target.id,agentId:compatible.id})).toThrow("not found");
    expect(database.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
  });

  it("normalizes the complete tool catalog for the browser options endpoint", () => {
    const {scope,service} = fixture();
    const options = service.options(scope);
    expect(options.groups.length).toBeGreaterThan(0);
    expect(options.groups.flatMap(group => group.tools).some(tool => tool.id === "thread.list")).toBe(true);
    expect(options.groups[0]!.label.text).toBeTruthy();
    expect(options.groups.flatMap(group => group.tools).every(tool => tool.enabled === false)).toBe(true);
  });

  it("isolates owners and validates revisions without touching execution configuration", () => {
    const {database,scope,service,repository} = fixture();
    const before = database.prepare("SELECT * FROM principal_execution_configuration").all();
    const policy = service.create(scope,definition);
    expect(service.list({...scope,principalId:"another-principal"})).toEqual({items:[]});
    expect(() => service.get({...scope,principalId:"another-principal"},policy.id)).toThrow("not found");
    expect(() => service.update(scope,policy.id,{...definition,name:"Stale",expectedRevision:1})).toThrow("changed");
    service.updateSelection(scope,{target:{kind:"account"},selection:{kind:"policy_set",policySetId:policy.id},expectedRevision:0});
    expect(() => service.updateSelection(scope,{target:{kind:"account"},selection:{kind:"disabled"},expectedRevision:0})).toThrow("changed");
    expect(() => repository.updateSelection({...scope,principalId:"another-principal"},{kind:"account"},{kind:"policy_set",policySetId:policy.id},0)).toThrow("not found");
    expect(database.prepare("SELECT * FROM principal_execution_configuration").all()).toEqual(before);
    database.prepare("UPDATE tool_policy_sets SET revision=? WHERE id=?").run(Number.MAX_SAFE_INTEGER,policy.id);
    expect(() => service.update(scope,policy.id,{...definition,expectedRevision:Number.MAX_SAFE_INTEGER})).toThrow("can no longer be advanced");
    database.prepare("UPDATE tool_policy_selections SET revision=?").run(Number.MAX_SAFE_INTEGER);
    expect(() => service.updateSelection(scope,{target:{kind:"account"},selection:{kind:"disabled"},expectedRevision:Number.MAX_SAFE_INTEGER})).toThrow("changed");
  });

  it("replaces each whole policy at the closest explicit level", () => {
    const {scope,service,target} = fixture();
    const everyday = service.create(scope,definition);
    const review = service.create(scope,{...definition,name:"Review",enabledToolIds:["task.list"],resourceScope:{allowOtherEnvironments:true,allowOtherProjects:false}});
    const choose = (policySetId:string) => ({kind:"policy_set" as const,policySetId});
    service.updateSelection(scope,{target:{kind:"account"},selection:choose(everyday.id),expectedRevision:0});
    expect(service.resolvePolicy(scope,{target})).toMatchObject({source:"account",enabledToolIds:["thread.list"]});
    service.updateSelection(scope,{target:{kind:"environment",executionEnvironmentId:target.executionEnvironmentId},selection:choose(review.id),expectedRevision:0});
    expect(service.resolvePolicy(scope,{target})).toMatchObject({source:"environment",enabledToolIds:["task.list"],resourceScope:review.resourceScope});
    service.updateSelection(scope,{target:{kind:"backend",backendId:target.backendId},selection:choose(everyday.id),expectedRevision:0});
    expect(service.resolvePolicy(scope,{target,agentSelection:choose(review.id)})).toMatchObject({source:"agent",enabledToolIds:["task.list"]});
    expect(service.resolvePolicy(scope,{target,agentSelection:choose(review.id),threadSelection:{kind:"disabled"}})).toEqual({source:"thread",enabled:false,enabledToolIds:[],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}});
  });

  it("preserves missing selections after deletion and never silently inherits", () => {
    const {scope,service,target,repository} = fixture();
    const policy = service.create(scope,definition);
    service.updateSelection(scope,{target:{kind:"account"},selection:{kind:"policy_set",policySetId:policy.id},expectedRevision:0});
    const snapshot = service.resolvePolicy(scope,{target});
    service.delete(scope,policy.id,policy.revision);
    expect(repository.getSelection(scope,{kind:"account"}).selection).toEqual({kind:"policy_set",policySetId:policy.id});
    expect(() => service.resolvePolicy(scope,{target})).toThrow("not found");
    expect(snapshot.enabledToolIds).toEqual(["thread.list"]);
    expect(service.resolvePolicy(scope,{target,threadSelection:{kind:"disabled"}}).enabled).toBe(false);
  });

  it("denies foreign targets and unknown tools before saving", () => {
    const {scope,service} = fixture();
    expect(() => service.create(scope,{...definition,enabledToolIds:["unknown.tool"]})).toThrow("ineligible");
    expect(() => service.updateSelection(scope,{target:{kind:"environment",executionEnvironmentId:"missing"},selection:{kind:"disabled"},expectedRevision:0})).toThrow("not found");
  });

  it("migrates saved Agent lists into reusable sets while retaining presentation", () => {
    const {database,scope} = fixture(147);
    const enabledId = "77777777-7777-4777-8777-777777777777";
    const disabledId = "88888888-8888-4888-8888-888888888888";
    const unicodeId = "99999999-9999-4999-8999-999999999999";
    const unicodeName = `${"😀".repeat(78)}\nend`;
    const insert = database.prepare(`INSERT INTO saved_agents(tenant_id,owner_principal_id,id,name,description,backend_type_id,backend_overrides_schema_version,backend_overrides_json,sedes_tools_json,revision,created_at,updated_at) VALUES(?,?,?,?,'','pi',1,'[]',?,0,100,100)`);
    const legacy = {enabled:true,enabledToolIds:["thread.list"],presentation:{surface:"native",mode:"progressive"},accessBoundary:"environment"};
    insert.run(scope.tenantId,scope.principalId,enabledId,"Existing Agent",JSON.stringify(legacy));
    insert.run(scope.tenantId,scope.principalId,disabledId,"Disabled",JSON.stringify({...legacy,enabled:false}));
    insert.run(scope.tenantId,scope.principalId,unicodeId,unicodeName,JSON.stringify(legacy));
    applyDatabaseMigrations(database,backendNormalizedMigrations);
    const repository = new ToolPolicyRepository(database);
    expect(repository.get(scope,enabledId)).toMatchObject({name:"Existing Agent",enabledToolIds:["thread.list"],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:true}});
    expect(database.prepare("SELECT tool_policy_selection_json AS selection,tool_presentation_json AS presentation FROM saved_agents WHERE id=?").get(enabledId)).toEqual({selection:JSON.stringify({kind:"policy_set",policySetId:enabledId}),presentation:JSON.stringify(legacy.presentation)});
    expect(database.prepare("SELECT tool_policy_selection_json AS selection FROM saved_agents WHERE id=?").get(disabledId)).toEqual({selection:'{"kind":"disabled"}'});
    expect(repository.get(scope,disabledId)).toMatchObject({name:"Disabled",enabledToolIds:legacy.enabledToolIds,resourceScope:{allowOtherEnvironments:false,allowOtherProjects:true}});
    expect(repository.get(scope,unicodeId).name).toBe(unicodeName);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });
});
