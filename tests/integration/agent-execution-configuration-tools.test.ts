import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { ConfigurationAdminService, type ConfigurationRuntimeAdapter } from "../../src/server/configuration-admin/configuration-admin-service.js";
import { commitWithConfigurationRemovalGuard } from "../../src/server/configuration-admin/configuration-removal-guard.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { configurationDocumentSchema, type ConfigurationBackend } from "../../src/shared/protocol/configuration-admin.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { ExecutionConfigurationTools, presentExecutionConfigurationMutation, type ExecutionConfigurationMutationResult } from "../../src/server/agent-tools/execution/execution-configuration-tools.js";
import { executionBackendKinds, executionConfigurationSchemas, type ExecutionConfigurationOperation } from "../../src/server/agent-tools/execution/execution-configuration-contracts.js";
import { ExecutionManagementAccess } from "../../src/server/agent-tools/application/execution-management-access.js";
import { AgentToolEnvironmentAuthorityResolver, type AgentToolEnvironmentAuthorityReader } from "../../src/server/agent-tools/environment/environment-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../../src/server/agent-tools/registry/canonical-agent-tool-manifest.js";
import { compileCanonicalAgentToolSchema } from "../../src/server/agent-tools/schema/canonical-json-schema.js";
import type { TrustedToolInvocationContext } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import type { ThreadAgentToolPolicyRecord } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { DomainError } from "../../src/server/domain/errors.js";

const localId="019196f7-a0a8-7bc4-a89b-8cf013978405";
const remoteId="019196f7-a0a8-7bc4-a89b-8cf013978499";
const sourceThreadId="019196f7-a0a8-7bc4-a89b-8cf013978401";
const workspaceId="019196f7-a0a8-7bc4-a89b-8cf013978402";
const projectId="019196f7-a0a8-7bc4-a89b-8cf013978403";
const legacy=parseResolvedBackendConfiguration({schemaVersion:10,
  executionEnvironments:[{id:localId,kind:"local",label:"Local"}],
  backends:[{id:"source-pi",kind:"pi",label:"Source",enabled:true,modelPolicy:{type:"catalog"}}],
  targets:[{id:"source-target",kind:"pi_sdk",label:"Source connection",backendInstanceId:"source-pi",executionEnvironmentId:localId,enabled:true}],defaultTargetId:"source-target"});
let seed:Buffer;
const databases:Database.Database[]=[];
afterEach(()=>{for(const database of databases.splice(0))database.close();});
function fixture() {
  if(!seed){const db=openOverlayDatabase(":memory:");applyBackendNormalizationMigration(db,{configuration:legacy,quiescentCutoverConfirmed:true,appliedAt:100});applyDatabaseMigrations(db,backendNormalizedMigrations);seed=db.serialize();db.close();}
  const database=new Database(seed);database.pragma("foreign_keys = ON");databases.push(database);
  const scope=new SingleUserIdentityProvider(database).getScope();
  const repository=new ConfigurationRepository(database);
  const projection=new ConfigurationProjection(database,Object.fromEntries(executionBackendKinds.map(kind=>[kind,"test"])));
  const document=configurationDocumentSchema.parse({executionEnvironments:[
    {id:localId,kind:"local",label:"Local",workspaceRoots:["/tmp"],workspaceIsolation:{kind:"bubblewrap",networkProfiles:["isolated"]}},
    {id:remoteId,kind:"ssh",label:"Remote",hostAlias:"builder",workspaceRoots:["/work"],connectionCompression:true,operations:{kind:"sidecar",enabledCapabilities:["workspace_tools","workspace_context","agent_tools_cli"]}},
  ],backends:legacy.backends.map(({protocolRelease:_release,...b})=>b),targets:legacy.targets,defaultTargetId:legacy.defaultTargetId,webSearch:null});
  repository.initialize(scope,document,{sourceFingerprint:configurationFingerprint(document),sourceLabel:"agent-execution-test"},()=>{projection.adoptLegacyOwnership(scope);projection.project(scope,document);});
  const authorizeSecretReference=vi.fn(()=>{}),reconcile=vi.fn(async()=>{}),activeBackends=new Set<string>();
  const runtime:ConfigurationRuntimeAdapter={observe:async(_scope,snapshot)=>snapshot.runtimes.map(item=>({...item,lastError:"literal-provider-secret",effects:item.effects?.map(effect=>({...effect,detail:"literal-provider-secret"}))})),reconcile,
    commitConfiguration:async(_scope,previous,next,commit)=>commitWithConfigurationRemovalGuard({previous:previous.configuration,next,commit,
      async withBackendStopped(id,work){if(activeBackends.has(id))throw new DomainError("conflict","Stop the backend before removing it.");return work();},
      async withEnvironmentStopped(_id,work){return work();}}),
    impact:async()=>{throw new Error("unused");},execute:async()=>{throw new Error("unused");}};
  let service=new ConfigurationAdminService(repository,{authorize(){},projection,runtime,authorizeSecretReference});
  let enabled=true,crossEnvironment=true;
  const enabledToolIds=new Set(Object.keys(executionConfigurationSchemas));
  const policy=():ThreadAgentToolPolicyRecord=>({tenantId:scope.tenantId,ownerPrincipalId:scope.principalId,applicationThreadId:sourceThreadId,enabled,revision:1,updatedAt:0,
    presentation:{surface:"native",mode:"individual"},resourceScope:{allowOtherEnvironments:crossEnvironment,allowOtherProjects:true},enabledToolIds:[...enabledToolIds],policySet:null});
  const env=(id:string)=>{const value=repository.get(scope).configuration.executionEnvironments.find(e=>e.id===id);return value?{id,environmentId:id,label:value.label}:undefined;};
  const backend=(id:string)=>{const d=repository.get(scope).configuration;const b=d.backends.find(b=>b.id===id);const target=d.targets.find(t=>t.backendInstanceId===id);return b&&target?{id,environmentId:target.executionEnvironmentId,label:b.label}:undefined;};
  const configurationTarget=(id:string)=>{const target=repository.get(scope).configuration.targets.find(t=>t.id===id);return target?{id,environmentId:target.executionEnvironmentId,label:target.label}:undefined;};
  const reader:AgentToolEnvironmentAuthorityReader={
    resolveEnvironment:(_s,id)=>env(id),resolveConfiguredEnvironment:(_s,id)=>env(id),resolveBackend:(_s,id)=>backend(id),
    resolveTarget:()=>undefined,resolveConfigurationTarget:(_s,id)=>configurationTarget(id),resolveThreadTemplate:()=>undefined,resolveRuntimeReceipt:()=>undefined,
    resolveConfigurationMutation:(_s,id)=>repository.commandReceiptAuthority(scope,id),
    resolveThread:(_s,id)=>id===sourceThreadId?{id,threadId:id,environmentId:localId,workspaceId,projectId,backendInstanceId:"source-pi"}:undefined,
    resolveWorkspace:()=>undefined,resolveAutomation:()=>undefined,resolveThreadFamily:()=>undefined,resolveTask:()=>undefined,resolveSavedAgent:()=>undefined,resolveWorkpad:()=>undefined,
    resolveProject:()=>undefined,resolveWorkspaceProject:()=>projectId,listEnvironments:()=>repository.get(scope).configuration.executionEnvironments.map(e=>({id:e.id,environmentId:e.id,label:e.label})),
  };
  const access=new ExecutionManagementAccess(reader,{getDurable:()=>policy()});
  const tools=new ExecutionConfigurationTools({configuration:()=>service,access});
  function context(operation:ExecutionConfigurationOperation,input:unknown):TrustedToolInvocationContext {
    const defaults={kind:"thread_agent" as const,environmentId:localId,workspaceId,projectId,threadId:sourceThreadId};
    const resourceScope=policy().resourceScope;
    const resolved=new AgentToolEnvironmentAuthorityResolver(reader).resolve({tool:CANONICAL_AGENT_TOOL_MANIFEST[operation],input,scope,defaults,resourceScope});
    const policyIdentity={ownerKind:"thread" as const,ownerId:sourceThreadId,revision:1};
    return {...scope,invocationId:randomUUID(),mutationId:randomUUID(),subject:{kind:"thread_agent",sourceThreadId,backendKind:"pi"},defaults,policyIdentity,adapter:"mcp",
      effectiveCapabilities:[],hasCapability:()=>false,requestId:randomUUID(),abortSignal:new AbortController().signal,reportProgress(){},
      environmentAuthority:{...resolved,id:randomUUID(),callerKind:"thread_agent",defaults,policyIdentity,resourceScope,
        admittedEnvironmentIds:[...new Set([localId,...reader.listEnvironments(scope).map(e=>e.id),...resolved.targetEnvironmentIds])]},
    };
  }
  async function call<T=Record<string,unknown>>(operation:ExecutionConfigurationOperation,input:unknown):Promise<T> {
    const result=await tools.execute(context(operation,input),operation,input);
    const validator=compileCanonicalAgentToolSchema(executionConfigurationSchemas[operation].output);
    expect(validator.check(result),JSON.stringify(validator.errors())).toBe(true);
    return result as T;
  }
  const mutation=()=>({mutationId:randomUUID(),expectedRevision:repository.get(scope).revision});
  async function create(kind:ConfigurationBackend["kind"],environmentId=localId,extra:Record<string,unknown>={}) {
    return call<ExecutionConfigurationMutationResult>("backend.create",{...mutation(),environmentId,backend:{kind,label:`Test ${kind}`,
      ...(kind==="codex_app_server"?{moduleConfiguration:{connection:{channel:{workingDirectory:"/tmp",executablePath:"/bin/codex"}}}}:{}),...extra}});
  }
  return {database,scope,repository,projection,tools,reader,call,context,mutation,create,reconcile,authorizeSecretReference,activeBackends,enabledToolIds,
    setEnabled(value:boolean){enabled=value;},setCrossEnvironment(value:boolean){crossEnvironment=value;},
    restart(){service=new ConfigurationAdminService(new ConfigurationRepository(database),{authorize(){},projection,runtime,authorizeSecretReference});},
  };
}

describe("agent execution configuration",()=>{
  it("denies a cross-provider source connection patch without an internal error", async()=>{
    const f=fixture();
    const before=f.repository.get(f.scope);
    await expect(f.call("backend.configure",{...f.mutation(),backendId:"source-pi",connections:{update:[{
      configurationTargetId:"source-target",changes:{moduleConfiguration:{}},
    }]}})).rejects.toMatchObject({code:"permission_denied"});
    expect(f.repository.get(f.scope)).toEqual(before);
  });
  it.each(executionBackendKinds)("creates %s and its initial connection atomically with shared defaults",async kind=>{
    const f=fixture();const before=structuredClone(f.repository.get(f.scope).configuration.backends[0]);
    f.activeBackends.add("source-pi");
    const result=await f.create(kind);
    expect(result.connections).toHaveLength(1);
    const ids=result.connections![0]!;
    expect(ids.configurationTargetId).not.toBe(ids.targetId);
    const row=f.database.prepare("SELECT id,template_id FROM agent_connection_profiles WHERE template_id=?").get(ids.configurationTargetId);
    expect(row).toEqual({id:ids.targetId,template_id:ids.configurationTargetId});
    expect(f.repository.get(f.scope).configuration.backends.find(b=>b.id==="source-pi")).toEqual(before);
    expect(result.runtimes.find(r=>r.resourceKind==="backend")).toMatchObject({applyState:"pending",effectiveRevision:null});
    expect(f.reconcile).toHaveBeenCalledTimes(1);
  });

  it("adds a remote sibling without editing its environment and rejects incompatible provider creation atomically",async()=>{
    const f=fixture();const before=structuredClone(f.repository.get(f.scope).configuration.executionEnvironments);
    const result=await f.create("claude_agent_sdk",remoteId);
    expect(result.environmentId).toBe(remoteId);
    expect(f.repository.get(f.scope).configuration.executionEnvironments).toEqual(before);
    const revision=f.repository.get(f.scope).revision;
    const count=f.database.prepare("SELECT COUNT(*) AS count FROM execution_configuration_identities").get();
    await expect(f.create("grok_build",remoteId)).rejects.toThrow("invalid");
    expect(f.repository.get(f.scope).revision).toBe(revision);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM execution_configuration_identities").get()).toEqual(count);
  });

  it("preserves nested siblings, replaces only supplied arrays, and clears optional paths",async()=>{
    const f=fixture();const added=await f.create("codex_app_server");
    await f.call("backend.configure",{...f.mutation(),backendId:added.backendId,changes:{moduleConfiguration:{connection:{channel:{executablePath:null}},policy:{allowedSandboxModes:["read-only","workspace-write"]}}},
      connections:{update:[{configurationTargetId:added.connections![0]!.configurationTargetId,changes:{moduleConfiguration:{defaults:{model:{type:"fixed",modelId:"chosen-model"}}}}}]}});
    const saved=f.repository.get(f.scope).configuration;
    const b=saved.backends.find(b=>b.id===added.backendId)!;
    expect(b).toMatchObject({moduleConfiguration:{connection:{ownership:"owned",channel:{type:"process_stdio",workingDirectory:"/tmp"}},policy:{allowedSandboxModes:["read-only","workspace-write"],allowedNetworkAccess:["disabled"],allowedApprovalPolicies:["on-request"],allowedApprovalReviewers:["user"]}}});
    expect(JSON.stringify(b)).not.toContain("executablePath");
    expect(saved.targets.find(t=>t.backendInstanceId===b.id)).toMatchObject({moduleConfiguration:{defaults:{sandboxMode:"read-only",networkAccess:"disabled",approvalPolicy:"on-request",approvalReviewer:"user",model:{type:"fixed",modelId:"chosen-model"}}}});
  });

  it("returns exact literal/reference bindings only in detail reads and preserves omitted variables",async()=>{
    const f=fixture();const added=await f.create("claude_agent_sdk",localId,{environmentVariables:{execution:{set:[
      {name:"API_TOKEN",binding:{kind:"literal",value:"foo"}},
      {name:"KEEP",binding:{kind:"secret",source:{kind:"protected_file",path:"/private/keep"}}},
    ]},startup:{set:[{name:"BOOT",binding:{kind:"literal",value:"initial"}}]}}});
    const request={...f.mutation(),backendId:added.backendId,changes:{environmentVariables:{execution:{set:[{name:"MODE",binding:{kind:"unset"}}]},startup:{set:[{name:"BOOT",binding:{kind:"literal",value:"replaced"}}]}}}};
    const result=await f.call("backend.configure",request);
    expect(JSON.stringify(result)).not.toMatch(/foo|replaced|\/private\/keep|literal-provider-secret/);
    const detail=await f.call<{backend:{environmentVariables:{execution:unknown[];startup:unknown[]}}}>("backend.get",{backendId:added.backendId});
    expect(detail.backend.environmentVariables.execution).toEqual(expect.arrayContaining([
      {name:"API_TOKEN",binding:{kind:"literal",value:"foo"}},
      {name:"KEEP",binding:{kind:"secret",source:{kind:"protected_file",path:"/private/keep"}}},
      {name:"MODE",binding:{kind:"unset"}},
    ]));
    expect(detail.backend.environmentVariables.startup).toEqual([{name:"BOOT",binding:{kind:"literal",value:"replaced"}}]);
    expect(JSON.stringify(await f.call("backend.list",{}))).not.toMatch(/foo|replaced|\/private\/keep|literal-provider-secret/);
    expect(await f.call("backend.configure",request)).toEqual(result);
    await f.call("backend.configure",{...f.mutation(),backendId:added.backendId,changes:{environmentVariables:{execution:{remove:["API_TOKEN","MODE"]}}}});
    expect(f.repository.get(f.scope).configuration.backends.find(b=>b.id===added.backendId)?.environmentVariables?.execution).toEqual({KEEP:{kind:"secret",source:{kind:"protected_file",path:"/private/keep"}}});
  });

  it("edits non-source environment variables without replacing other maps or host settings",async()=>{
    const f=fixture();const mutation={...f.mutation(),environmentId:remoteId,changes:{environmentVariables:{execution:{set:[{name:"API_TOKEN",binding:{kind:"literal",value:"foo"}}]}}}};
    const result=await f.call("environment.configure",mutation);
    expect(JSON.stringify(result)).not.toContain("foo");
    await f.call("environment.configure",{...f.mutation(),environmentId:remoteId,changes:{connectionCompression:false}});
    const detail=await f.call<{environment:Record<string,unknown>}>("environment.get",{environmentId:remoteId});
    expect(detail.environment).toMatchObject({hostAlias:"builder",workspaceRoots:["/work"],connectionCompression:false,environmentVariables:{execution:[{name:"API_TOKEN",binding:{kind:"literal",value:"foo"}}],startup:[]}});
    expect(await f.call("environment.configure",mutation)).toEqual(result);
  });

  it("removes only an empty non-source environment and revalidates retained removal receipts",async()=>{
    const f=fixture();const before=f.repository.get(f.scope).configuration;
    const request={...f.mutation(),environmentId:remoteId};
    const result=await f.call("environment.remove",request);
    expect(f.repository.get(f.scope).configuration).toEqual({...before,executionEnvironments:before.executionEnvironments.filter(item=>item.id!==remoteId)});
    const saved=f.repository.get(f.scope);
    f.restart();
    expect(await f.call("environment.remove",request)).toEqual(result);
    f.setCrossEnvironment(false);
    await expect(f.call("environment.remove",request)).rejects.toMatchObject({code:"permission_denied"});
    f.setCrossEnvironment(true);
    f.enabledToolIds.delete("environment.remove");
    await expect(f.call("environment.remove",request)).rejects.toMatchObject({code:"permission_denied"});
    f.enabledToolIds.add("environment.remove");
    expect(await f.call("environment.remove",request)).toEqual(result);
    expect(f.repository.get(f.scope)).toEqual(saved);
    expect(f.reconcile).toHaveBeenCalledTimes(1);
  });

  it("rejects environment removal while disabled backends remain without cascading changes",async()=>{
    const f=fixture();await f.create("claude_agent_sdk",remoteId,{enabled:false});
    const before=f.repository.get(f.scope);
    f.reconcile.mockClear();
    await expect(f.call("environment.remove",{...f.mutation(),environmentId:remoteId})).rejects.toMatchObject({
      code:"conflict",message:"Remove this environment's backends before removing the environment.",
    });
    expect(f.repository.get(f.scope)).toEqual(before);
    expect(f.reconcile).not.toHaveBeenCalled();
  });

  it("denies source environment removal before checking dependent backends",async()=>{
    const f=fixture();const before=f.repository.get(f.scope);
    await expect(f.call("environment.remove",{...f.mutation(),environmentId:localId})).rejects.toMatchObject({code:"permission_denied"});
    expect(f.repository.get(f.scope)).toEqual(before);
    expect(f.reconcile).not.toHaveBeenCalled();
  });

  it("keeps connection collections and names stable while adding/updating/removing exact IDs",async()=>{
    const f=fixture();const added=await f.create("claude_agent_sdk");
    await f.call("backend.configure",{...f.mutation(),backendId:added.backendId,connections:{create:[{label:"Second"}]}});
    const targets=f.repository.get(f.scope).configuration.targets.filter(t=>t.backendInstanceId===added.backendId);
    expect(targets.map(t=>t.label)).toEqual(["Default connection","Second"]);
    await f.call("backend.rename",{...f.mutation(),backendId:added.backendId,label:"Changed backend"});
    await f.call("backend.configure",{...f.mutation(),backendId:added.backendId,connections:{update:[{configurationTargetId:targets[1]!.id,changes:{label:"Changed second"}}]}});
    expect(f.repository.get(f.scope).configuration.targets.filter(t=>t.backendInstanceId===added.backendId).map(t=>t.label)).toEqual(["Default connection","Changed second"]);
    await f.call("backend.configure",{...f.mutation(),backendId:added.backendId,connections:{remove:[targets[1]!.id]}});
    expect(f.repository.get(f.scope).configuration.targets.filter(t=>t.backendInstanceId===added.backendId).map(t=>t.id)).toEqual([targets[0]!.id]);
  });

  it("changes a mutable OpenCode connection variant only with a complete replacement and approves its reference",async()=>{
    const f=fixture();const added=await f.create("opencode");
    await expect(f.call("backend.configure",{...f.mutation(),backendId:added.backendId,changes:{moduleConfiguration:{connection:{ownership:"external"}}}})).rejects.toThrow("invalid");
    await f.call("backend.configure",{...f.mutation(),backendId:added.backendId,changes:{moduleConfiguration:{connection:{ownership:"external",channel:{type:"http",url:"http://127.0.0.1:4580",authentication:{type:"basic",username:"opencode",secret:{source:"protected_file",path:"/private/opencode-password"}}}}}}});
    expect(f.authorizeSecretReference).toHaveBeenCalledWith(f.scope,localId,{source:"protected_file",path:"/private/opencode-password"});
    expect(f.repository.hasApprovedSecret(f.scope,localId,{source:"protected_file",path:"/private/opencode-password"})).toBe(true);
    expect(f.repository.get(f.scope).configuration.backends.find(b=>b.id===added.backendId)).toMatchObject({moduleConfiguration:{connection:{ownership:"external",channel:{type:"http"}}}});
  });

  it.each([
    {kind:"codex_app_server",from:"environment"},
    {kind:"codex_app_server",from:"protected_file"},
    {kind:"opencode",from:"environment"},
    {kind:"opencode",from:"protected_file"},
  ] as const)("replaces $kind authentication references from $from through secret approval",async({kind,from})=>{
    const f=fixture();
    const environment={source:"environment" as const,variable:kind==="codex_app_server"?"SEDES_CODEX_TEST_TOKEN":"SEDES_OPENCODE_TEST_PASSWORD"};
    const file={source:"protected_file" as const,path:`/private/${kind}-credential`};
    const before=from==="environment"?environment:file;
    const after=from==="environment"?file:environment;
    const authentication=kind==="codex_app_server"?{type:"capability_token",secret:before}:{type:"basic",username:"opencode",secret:before};
    const channel=kind==="codex_app_server"?{type:"tcp_websocket",url:"ws://127.0.0.1:4581",authentication}:{type:"http",url:"http://127.0.0.1:4580",authentication};
    const added=await f.create(kind,localId,{moduleConfiguration:{connection:{ownership:"external",channel}}});
    const saved=f.repository.get(f.scope);
    expect(f.repository.hasApprovedSecret(f.scope,localId,before)).toBe(true);
    f.authorizeSecretReference.mockClear();
    const configure=(secret:unknown)=>f.call("backend.configure",{...f.mutation(),backendId:added.backendId,changes:{moduleConfiguration:{connection:{channel:{authentication:{secret}}}}}});

    await expect(configure({source:after.source})).rejects.toThrow("invalid");
    expect(f.authorizeSecretReference).not.toHaveBeenCalled();
    expect(f.repository.get(f.scope)).toEqual(saved);

    f.authorizeSecretReference.mockImplementationOnce(()=>{throw new DomainError("bad_request","Secret reference is not approved.");});
    await expect(configure(after)).rejects.toThrow("Secret reference is not approved.");
    expect(f.repository.hasApprovedSecret(f.scope,localId,after)).toBe(false);
    expect(f.repository.get(f.scope)).toEqual(saved);
    f.authorizeSecretReference.mockClear();

    await configure(after);
    expect(f.authorizeSecretReference).toHaveBeenCalledExactlyOnceWith(f.scope,localId,after);
    expect(f.repository.hasApprovedSecret(f.scope,localId,after)).toBe(true);
    const backend=f.repository.get(f.scope).configuration.backends.find(item=>item.id===added.backendId)!;
    expect(backend).toMatchObject({moduleConfiguration:{connection:{ownership:"external",channel:{...channel,authentication:{...authentication,secret:after}}}}});
    if(backend.kind!=="codex_app_server"&&backend.kind!=="opencode")throw new Error("Unexpected backend kind");
    const connection=backend.moduleConfiguration.connection;
    if(connection.ownership!=="external"||connection.channel.type==="unix_websocket")throw new Error("Unexpected connection kind");
    expect(connection.channel.authentication.secret).toEqual(after);
  });

  it("rejects backend kind patches before changing saved configuration",async()=>{
    const f=fixture();const added=await f.create("claude_agent_sdk");
    const before=f.repository.get(f.scope);
    await expect(f.call("backend.configure",{...f.mutation(),backendId:added.backendId,changes:{kind:"claude_agent_sdk",label:"Changed"}})).rejects.toMatchObject({code:"bad_request"});
    expect(f.repository.get(f.scope)).toEqual(before);
  });

  it("replays creation after intervening edits/removal/restart without reallocating IDs or exposing configured values",async()=>{
    const f=fixture();const request={...f.mutation(),environmentId:localId,backend:{kind:"claude_agent_sdk",label:"Replay",environmentVariables:{execution:{set:[{name:"API_TOKEN",binding:{kind:"literal",value:"foo"}}]}}}};
    const created=await f.call<ExecutionConfigurationMutationResult>("backend.create",request);
    await f.call("backend.rename",{...f.mutation(),backendId:created.backendId,label:"Later"});
    await f.call("backend.remove",{...f.mutation(),backendId:created.backendId});
    f.restart();
    expect(await f.call("backend.create",request)).toEqual(created);
    expect(f.repository.get(f.scope).configuration.backends.some(b=>b.id===created.backendId)).toBe(false);
    expect(JSON.stringify(created)).not.toContain("foo");
    await expect(f.call("backend.create",{...request,backend:{...request.backend,label:"Changed retry"}})).rejects.toThrow("different contents");
    await expect(f.call("backend.create",{...request,mutationId:randomUUID()})).rejects.toThrow("changed");
  });

  it("selects and clears defaults using configuration IDs, refusing implicit default changes on removal",async()=>{
    const f=fixture();const added=await f.create("claude_agent_sdk");const ids=added.connections![0]!;
    await expect(f.call("execution.defaults.update",{...f.mutation(),configurationTargetId:ids.targetId})).rejects.toThrow();
    const selected=await f.call("execution.defaults.update",{...f.mutation(),configurationTargetId:ids.configurationTargetId});
    expect(selected).toMatchObject({connections:[ids]});
    expect(await f.call("execution.defaults.get",{})).toMatchObject({connection:{...ids,backendId:added.backendId,environmentId:localId}});
    await expect(f.call("backend.remove",{...f.mutation(),backendId:added.backendId})).rejects.toThrow("default");
    await f.call("execution.defaults.update",{...f.mutation(),configurationTargetId:null});
    expect(await f.call("execution.defaults.get",{})).toMatchObject({connection:null});
  });

  it("keeps source label/model-policy changes available but rejects route-disruptive edits and guarded removals",async()=>{
    const f=fixture();await f.call("environment.rename",{...f.mutation(),environmentId:localId,label:"Home"});
    await f.call("backend.configure",{...f.mutation(),backendId:"source-pi",changes:{label:"Assistant",modelPolicy:{type:"denylist",denied:[{modelIds:["unwanted"]}]}}});
    await expect(f.call("environment.configure",{...f.mutation(),environmentId:localId,changes:{workspaceRoots:["/another"]}})).rejects.toThrow("source environment");
    await expect(f.call("backend.configure",{...f.mutation(),backendId:"source-pi",changes:{enabled:false}})).rejects.toThrow("source backend");
    const added=await f.create("claude_agent_sdk");f.activeBackends.add(added.backendId!);
    await expect(f.call("backend.remove",{...f.mutation(),backendId:added.backendId})).rejects.toThrow("Stop");
    expect(f.repository.get(f.scope).configuration.backends.some(b=>b.id===added.backendId)).toBe(true);
  });

  it("enforces protected names, startup restrictions, variable ambiguity, immutable identity and exact tool grants",async()=>{
    const f=fixture();const added=await f.create("claude_agent_sdk");
    await expect(f.call("backend.configure",{...f.mutation(),backendId:added.backendId,changes:{environmentVariables:{execution:{set:[{name:"HOME",binding:{kind:"literal",value:"private-literal"}}]}}}})).rejects.not.toThrow("private-literal");
    await expect(f.call("backend.configure",{...f.mutation(),backendId:added.backendId,changes:{environmentVariables:{execution:{set:[{name:"one",binding:{kind:"unset"}}],remove:["ONE"]}}}})).rejects.toThrow("only once");
    const pi=await f.create("pi");
    await expect(f.call("backend.configure",{...f.mutation(),backendId:pi.backendId,changes:{environmentVariables:{startup:{set:[{name:"START",binding:{kind:"literal",value:"private-literal"}}]}}}})).rejects.toThrow("Startup variables require");
    await expect(f.call("backend.configure",{...f.mutation(),backendId:added.backendId,changes:{moduleConfiguration:{configDirectory:"/new-identity"}}})).rejects.toThrow("immutable");
    f.enabledToolIds.delete("backend.get");
    await expect(f.call("backend.get",{backendId:added.backendId})).rejects.toMatchObject({code:"permission_denied"});
    f.setCrossEnvironment(false);
    await expect(f.call("environment.get",{environmentId:remoteId})).rejects.toThrow();
    await expect(f.call("environment.create",{...f.mutation(),environment:{kind:"ssh",label:"New",hostAlias:"new",workspaceRoots:["/work"]}})).rejects.toThrow();
  });

  it("creates SSH environments with shared defaults and reports provider compatibility without probing hosts",async()=>{
    const f=fixture();const result=await f.call<ExecutionConfigurationMutationResult>("environment.create",{...f.mutation(),environment:{kind:"ssh",label:"New builder",hostAlias:"new-builder",workspaceRoots:["/work"]}});
    const definition=f.repository.get(f.scope).configuration.executionEnvironments.find(e=>e.id===result.environmentId);
    expect(definition).toMatchObject({connectionCompression:true,operations:{kind:"sidecar",enabledCapabilities:["directory_browser","workspace_files"]}});
    const options=await f.call<{providers:Array<{kind:string;supported:boolean}>}>("backend.options",{environmentId:result.environmentId});
    expect(options.providers.find(p=>p.kind==="grok_build")?.supported).toBe(false);
    expect(options.providers.find(p=>p.kind==="pi")?.supported).toBe(false);
    expect(options.providers.find(p=>p.kind==="claude_agent_sdk")?.supported).toBe(true);
  });
  it("bounds command receipts independently of retained effect history and reports omitted effects", () => {
    const f = fixture();
    const snapshot = f.repository.get(f.scope);
    snapshot.revision = 8;
    snapshot.runtimes = snapshot.runtimes.map(item => ({ ...item, desiredRevision: 8, effects: Array.from({ length: 512 }, (_, index) => ({
      component: "host_policy" as const, subjectId: `${index}-` + "x".repeat(240), subjectLabel: "private-provider-detail",
      desiredRevision: index < 8 ? 7 : 8, effectiveRevision: null, state: "awaiting_host" as const,
      detail: "private-provider-detail",
    })) }));
    const presented = presentExecutionConfigurationMutation(f.scope, snapshot, {
      environmentId: localId, backendId: "source-pi", connectionIds: ["source-target"], changedSettings: ["connections"],
    });
    expect(Buffer.byteLength(JSON.stringify(presented))).toBeLessThanOrEqual(60 * 1024);
    expect(presented.effectsScope).toBe("current_command");
    expect(presented.effectsOmitted).toBeGreaterThan(0);
    expect(presented.runtimes.flatMap(item => item.effects ?? []).every(effect => effect.desiredRevision === 8)).toBe(true);
    expect(presented.runtimes.reduce((sum, item) => sum + (item.effects?.length ?? 0), 0) + presented.effectsOmitted).toBe(2 * 504);
    expect(JSON.stringify(presented)).not.toContain("private-provider-detail");
    expect(compileCanonicalAgentToolSchema(executionConfigurationSchemas["backend.configure"].output).check(presented)).toBe(true);
  });

});
