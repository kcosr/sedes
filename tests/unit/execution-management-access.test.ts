import { describe, expect, it } from "vitest";
import type { ConfigurationBackend, ConfigurationEnvironment, ConfigurationTarget } from "../../src/shared/protocol/configuration-admin.js";
import type { ThreadAgentToolPolicyRecord, ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { ExecutionManagementAccess } from "../../src/server/agent-tools/application/execution-management-access.js";
import type { TrustedToolInvocationContext } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { AgentToolEnvironmentAuthorityResolver, createTrustedEnvironmentAuthorityGrant, type AgentToolEnvironmentAuthorityReader,
  type ResolveEnvironmentAuthorityInput,
} from "../../src/server/agent-tools/environment/environment-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../../src/server/agent-tools/registry/canonical-agent-tool-manifest.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const environments = [{id:"env-a",environmentId:"env-a"}, {id:"env-b",environmentId:"env-b"}];
const sourceThread = {id:"source",environmentId:"env-a",backendInstanceId:"source-backend",workspaceId:"workspace-a",projectId:"project-a"};
const reader: AgentToolEnvironmentAuthorityReader = {
  resolveEnvironment: (_scope,id) => [...environments,{id:"removed",environmentId:"removed"}].find(item => item.id === id),
  resolveConfiguredEnvironment: (_scope,id) => environments.find(item => item.id === id),
  resolveBackend: (_scope,id) => id === "remote-backend" ? {id,environmentId:"env-b"}
    : ["source-backend","sibling-backend"].includes(id) ? {id,environmentId:"env-a"} : undefined,
  resolveTarget: (_scope,id) => id === "target-b" ? {id,environmentId:"env-b"} : undefined,
  resolveConfigurationTarget: (_scope,id) => id === "connection-b" ? {id,environmentId:"env-b"} : undefined,
  resolveThreadTemplate: (_scope,id) => id === "template-b" ? {id,environmentId:"env-b",workspaceId:"workspace-b",projectId:"project-b",revision:2} : undefined,
  resolveThread: (_scope,id) => id === "source" ? sourceThread : undefined,
  resolveWorkspace: () => undefined, resolveAutomation: () => undefined, resolveThreadFamily: () => undefined,
  resolveTask: () => undefined, resolveWorkpad: () => undefined,
  resolveSavedAgent: (_scope,id) => id === "agent" ? {id,revision:3} : undefined,
  resolveProject: (_scope,id) => id === "project-a" ? {id,membershipRevision:2,memberEnvironmentIds:["env-a"]} : undefined,
  resolveWorkspaceProject: (_scope,id) => id === "workspace-a" ? "project-a" : id === "workspace-b" ? "project-b" : undefined,
  listEnvironments: () => environments,
  resolveRuntimeReceipt: () => undefined,
  resolveConfigurationMutation: () => undefined,
};
const defaults = {kind:"thread_agent" as const,threadId:"source",environmentId:"env-a",workspaceId:"workspace-a",projectId:"project-a"};
function request(toolId: keyof typeof CANONICAL_AGENT_TOOL_MANIFEST, input: unknown,
  resourceScope = {allowOtherEnvironments:true,allowOtherProjects:true}): ResolveEnvironmentAuthorityInput {
  return {tool:CANONICAL_AGENT_TOOL_MANIFEST[toolId],input,scope,defaults,resourceScope,admittedEnvironmentIds:["env-a","env-b"]};
}
function context(toolId: keyof typeof CANONICAL_AGENT_TOOL_MANIFEST = "backend.configure", input: unknown = {backendId:"source-backend"},
  selectedReader = reader, resourceScope = {allowOtherEnvironments:true,allowOtherProjects:true}): TrustedToolInvocationContext {
  const resolved = new AgentToolEnvironmentAuthorityResolver(selectedReader).resolve(request(toolId,input,resourceScope));
  const policyIdentity = {ownerKind:"thread" as const,ownerId:"source",revision:1};
  return {...scope,invocationId:"invocation",mutationId:"transport-mutation",subject:{kind:"thread_agent",sourceThreadId:"source",backendKind:"pi"},
    defaults,policyIdentity,adapter:"mcp",effectiveCapabilities:[toolId],hasCapability:id=>id===toolId,requestId:"request",abortSignal:new AbortController().signal,
    reportProgress:()=>{},environmentAuthority:createTrustedEnvironmentAuthorityGrant({...resolved,tool:request(toolId,input).tool,
      callerKind:"thread_agent",defaults,policyIdentity,admittedEnvironmentIds:["env-a","env-b"],resourceScope})};
}
const denied = expect.objectContaining({code:"permission_denied"});
const livePolicy: ThreadAgentToolPolicyRecord = { tenantId:scope.tenantId,ownerPrincipalId:scope.principalId,applicationThreadId:"source",enabled:true,
  enabledToolIds:Object.keys(CANONICAL_AGENT_TOOL_MANIFEST),revision:1,resourceScope:{allowOtherEnvironments:true,allowOtherProjects:true},
  presentation:{surface:"native",mode:"individual"},updatedAt:0,policySet:null };
const toolPolicies: Pick<ThreadAgentToolPolicyRepository,"getDurable"> = {getDurable:()=>livePolicy};
const access = new ExecutionManagementAccess(reader,toolPolicies);
const local: ConfigurationEnvironment = {id:"env-a",kind:"local",label:"Local",workspaceRoots:["/work"],workspaceIsolation:{kind:"bubblewrap",networkProfiles:["isolated"]}};
const backend: ConfigurationBackend = {id:"source-backend",kind:"pi",enabled:true,label:"Pi",modelPolicy:{type:"catalog"}};

describe("execution-management authority", () => {
  it("requires exact capabilities and a coherent thread caller", () => {
    const current = {...context(),effectiveCapabilities:[],hasCapability:()=>false};
    const exact = new ExecutionManagementAccess(reader,{getDurable:()=>({...livePolicy,enabledToolIds:["backend.configure"]})});
    expect(exact.assertCaller(current,"backend.configure")).toEqual(scope);
    expect(() => exact.assertCaller(current,"backend.remove")).toThrow(denied);
    expect(() => new ExecutionManagementAccess(reader,{getDurable:()=>({...livePolicy,revision:2})}).assertCaller(current,"backend.configure")).toThrow(denied);
    expect(() => new ExecutionManagementAccess(reader,{getDurable:()=>({...livePolicy,enabled:false})}).assertCaller(current,"backend.configure")).toThrow(denied);
    expect(() => new ExecutionManagementAccess(reader,{getDurable:()=>({...livePolicy,resourceScope:{allowOtherEnvironments:false,allowOtherProjects:true}})}).assertCaller(current,"backend.configure")).toThrow(denied);
    expect(() => access.assertCaller({...current,subject:{kind:"thread_agent",sourceThreadId:"different",backendKind:"pi"}},"backend.configure")).toThrow(denied);
    expect(() => access.assertCaller({...current,subject:{kind:"principal_client",clientId:"client",credentialGeneration:1}},"backend.configure")).toThrow(denied);
  });

  it.each(["environment.create","execution.defaults.get","execution.defaults.update","tool_policy.list","tool_policy.create"] as const)("requires cross-environment authority for %s", tool => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    expect(() => resolver.resolve(request(tool,{}, {allowOtherEnvironments:false,allowOtherProjects:true}))).toThrow(denied);
    expect(resolver.resolve(request(tool,{})).resolvedResourceRefs).toEqual([{kind:"principal_management",id:scope.principalId,outsideEveryEnvironment:true}]);
    expect(() => resolver.resolve({...request(tool,{}),defaults:{kind:"principal_client",environmentId:"env-a"}})).toThrow(denied);
  });

  it("resolves backend ownership independently of a supplied environment and project scope", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    expect(() => resolver.resolve(request("backend.get",{backendId:"remote-backend",environmentId:"env-a"}, {allowOtherEnvironments:false,allowOtherProjects:true}))).toThrow(denied);
    const current = context("backend.get",{backendId:"remote-backend"},reader,{allowOtherEnvironments:true,allowOtherProjects:false});
    expect(access.backend(current,"remote-backend").environmentId).toBe("env-b");
    expect(() => access.backend(current,"sibling-backend")).toThrow(denied);
  });

  it("does not treat a retained inventory row as a configured environment", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    expect(() => resolver.resolve(request("environment.get",{environmentId:"removed"}))).toThrow(expect.objectContaining({code:"not_found"}));
    expect(() => resolver.resolve(request("tool_policy.defaults.get",{target:{kind:"environment",executionEnvironmentId:"removed"}}))).toThrow(expect.objectContaining({code:"not_found"}));
  });

  it("authorizes policy selections by their target and preview by projected target identity", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    expect(resolver.resolve(request("tool_policy.defaults.get",{target:{kind:"backend",backendId:"remote-backend"}})).targetEnvironmentIds).toEqual(["env-b"]);
    expect(() => resolver.resolve(request("tool_policy.defaults.get",{target:{kind:"account"}}, {allowOtherEnvironments:false,allowOtherProjects:true}))).toThrow(denied);
    expect(resolver.resolve(request("tool_policy.preview",{targetId:"target-b",agentId:"agent"})).resolvedResourceRefs).toEqual([
      {kind:"saved_agent",id:"agent",revision:3},{kind:"target",id:"target-b",environmentId:"env-b"},
    ]);
    expect(() => resolver.resolve(request("tool_policy.preview",{targetId:"connection-b"}))).toThrow(expect.objectContaining({code:"not_found"}));
  });

  it("uses retained command facts after deletion without changing caller or tool authority", () => {
    const retainedReader = {...reader,resolveConfigurationMutation:()=>({toolId:"backend.remove",sourceThreadId:"source",inputDigest:"digest",
      scopeFacts:{environmentIds:["env-b"],crossEnvironment:false}})};
    const resolver = new AgentToolEnvironmentAuthorityResolver(retainedReader);
    const input = {backendId:"deleted",mutationId:"mutation"};
    expect(resolver.resolve(request("backend.remove",input)).resolvedResourceRefs).toEqual([{kind:"environment",id:"env-b",environmentId:"env-b"}]);
    expect(() => resolver.resolve(request("backend.rename",input))).toThrow(denied);
    expect(() => resolver.resolve({...request("backend.remove",input),defaults:{...defaults,threadId:"other"}})).toThrow(denied);
    expect(() => resolver.resolve(request("backend.remove",input,{allowOtherEnvironments:false,allowOtherProjects:true}))).toThrow(denied);
    const current = context("backend.remove",input,retainedReader);
    new ExecutionManagementAccess(retainedReader,toolPolicies).retained(current,[{kind:"environment",id:"env-b",environmentId:"env-b"}]);
    expect(() => access.retained(current,[{kind:"environment",id:"env-a",environmentId:"env-a"}])).toThrow(denied);
  });

  it("authorizes lifecycle receipt lookup and replay through original retained ownership", () => {
    const retainedReader = {...reader,resolveRuntimeReceipt:()=>({resourceKind:"backend" as const,resourceId:"deleted",environmentId:"env-b"})};
    const resolver = new AgentToolEnvironmentAuthorityResolver(retainedReader);
    const expected = [{kind:"backend",id:"deleted",environmentId:"env-b"}];
    expect(resolver.resolve(request("runtime.operation.get",{mutationId:"operation"})).resolvedResourceRefs).toEqual(expected);
    expect(resolver.resolve(request("runtime.stop",{mutationId:"operation",resourceKind:"backend",resourceId:"deleted"})).resolvedResourceRefs).toEqual(expected);
    expect(() => resolver.resolve(request("runtime.stop",{mutationId:"operation",resourceKind:"backend",resourceId:"other"}))).toThrow(denied);
    expect(() => resolver.resolve(request("runtime.operation.get",{mutationId:"operation"},{allowOtherEnvironments:false,allowOtherProjects:true}))).toThrow(denied);
  });

  it("binds template updates to current revision, workspace and project", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    expect(() => resolver.resolve(request("thread_template.get",{templateId:"template-b"},{allowOtherEnvironments:true,allowOtherProjects:false}))).toThrow(denied);
    const current = context("thread_template.update",{templateId:"template-b"});
    const changed = new ExecutionManagementAccess({...reader,resolveThreadTemplate:()=>({id:"template-b",environmentId:"env-b",workspaceId:"workspace-b",projectId:"project-b",revision:3})},toolPolicies);
    expect(() => changed.revalidate(current,"thread_template.update",{templateId:"template-b"})).toThrow(denied);
  });

  it("resolves template lists using bounded environments and project membership", () => {
    const resolver = new AgentToolEnvironmentAuthorityResolver(reader);
    const restricted = resolver.resolve(request("thread_template.list",{}, {allowOtherEnvironments:false,allowOtherProjects:false}));
    expect(restricted.targetEnvironmentIds).toEqual(["env-a"]);
    expect(restricted.resolvedResourceRefs).toEqual([{kind:"environment",id:"env-a",environmentId:"env-a"},
      {kind:"project",id:"project-a",environmentId:"env-a",projectId:"project-a",revision:2}]);
    expect(resolver.resolve(request("thread_template.list",{})).resolvedResourceRefs).toHaveLength(2);
  });
});

describe("source route safety", () => {
  it("allows source environment labels, but denies roots, variables, isolation and removal", () => {
    const current = context();
    access.sourceEnvironmentChange(current,local,{...local,label:"Renamed"});
    for (const next of [{...local,workspaceRoots:["/elsewhere"]},{...local,environmentVariables:{startup:{NEW:{kind:"literal" as const,value:"value"}},execution:{}}},
      {...local,workspaceIsolation:{kind:"bubblewrap" as const,networkProfiles:["isolated","execution_host"] as ["isolated","execution_host"]}},undefined])
      expect(() => access.sourceEnvironmentChange(current,local,next)).toThrow(denied);
    access.sourceEnvironmentChange(current,{...local,id:"env-b"},undefined);
  });

  it("allows source backend labels and model policy but denies launch changes or removal", () => {
    const current = context();
    access.sourceBackendChange(current,backend,{...backend,label:"Renamed",modelPolicy:{type:"allowlist",allowed:[{modelIds:["model"]}]}},[],[]);
    expect(() => access.sourceBackendChange(current,backend,{...backend,enabled:false},[],[])).toThrow(denied);
    expect(() => access.sourceBackendChange(current,backend,{...backend,environmentVariables:{execution:{X:{kind:"literal",value:"Y"}},startup:{}}},[],[])).toThrow(denied);
    expect(() => access.sourceBackendChange(current,backend,undefined,[],[])).toThrow(denied);
    access.sourceBackendChange(current,{...backend,id:"sibling-backend"},undefined,[],[]);
  });

  it.each([
    ["pi_rpc",{provider:"provider",model:"old",thinkingLevel:"low"},{provider:"provider",model:"new",thinkingLevel:"high"}],
    ["codex_app_server",{sandboxMode:"read-only",networkAccess:"disabled",approvalPolicy:"never",approvalReviewer:"user",model:{type:"catalogDefault"}},
      {sandboxMode:"read-only",networkAccess:"disabled",approvalPolicy:"never",approvalReviewer:"user",model:{type:"fixed",modelId:"new"}}],
    ["grok_acp",{model:{type:"catalogDefault"},reasoningEffort:{type:"modelDefault"}},{model:{type:"fixed",modelId:"new"},reasoningEffort:{type:"fixed",effortId:"high"}}],
    ["opencode_http",{model:{type:"catalogDefault"},variant:{type:"modelDefault"}},{model:{type:"fixed",modelId:"new"},variant:{type:"fixed",variantId:"high"}}],
    ["antigravity_acp",{modelId:"old",thinkingLevel:"low",modeId:"planning"},{modelId:"new",thinkingLevel:"high",modeId:"planning"}],
  ])("allows only model/reasoning changes in %s source connection defaults", (kind,before,after) => {
    const target = {id:"connection",kind,label:"Connection",backendInstanceId:backend.id,executionEnvironmentId:"env-a",enabled:true,moduleConfiguration:{defaults:before}} as ConfigurationTarget;
    const changed = {...target,moduleConfiguration:{defaults:after}} as ConfigurationTarget;
    access.sourceBackendChange(context(),backend,backend,[target],[changed]);
    expect(() => access.sourceBackendChange(context(),backend,backend,[target],[{...changed,label:"Changed connection"}])).toThrow(denied);
    expect(() => access.sourceBackendChange(context(),backend,backend,[target],[])).toThrow(denied);
    expect(() => access.sourceBackendChange(context(),backend,backend,[target],[target,{...target,id:"extra"}])).toThrow(denied);
  });

  it.each([
    ["pi_rpc",{provider:"provider",model:"model",thinkingLevel:"low"}],
    ["antigravity_acp",{modelId:"model",thinkingLevel:"low"}],
  ])("allows resetting optional %s model/reasoning defaults", (kind,before) => {
    const target = {id:"connection",kind,label:"Connection",backendInstanceId:backend.id,executionEnvironmentId:"env-a",enabled:true,moduleConfiguration:{defaults:before}} as ConfigurationTarget;
    // A defaults:null patch removes the property before the completed target
    // schema restores its default {} value.
    for (const moduleConfiguration of [{}, {defaults:{}}]) {
      const reset = {...target,moduleConfiguration} as ConfigurationTarget;
      expect(() => access.sourceBackendChange(context(),backend,backend,[target],[reset])).not.toThrow();
      expect(() => access.sourceBackendChange(context(),backend,backend,[reset],[target])).not.toThrow();
    }
  });

  it.each([
    ["codex_app_server",{sandboxMode:"read-only",networkAccess:"disabled",approvalPolicy:"never",approvalReviewer:"user",model:{type:"catalogDefault"}},"sandboxMode","danger-full-access"],
    ["claude_agent_sdk",{permissionMode:"default"},"permissionMode","auto"],
    ["antigravity_acp",{modelId:"model",modeId:"planning"},"modeId","fast"],
  ])("denies %s permission/mode changes on the source connection", (kind,before,field,value) => {
    const target = {id:"connection",kind,label:"Connection",backendInstanceId:backend.id,executionEnvironmentId:"env-a",enabled:true,moduleConfiguration:{defaults:before}} as ConfigurationTarget;
    const changed = {...target,moduleConfiguration:{defaults:{...before,[field as string]:value}}} as ConfigurationTarget;
    expect(() => access.sourceBackendChange(context(),backend,backend,[target],[changed])).toThrow(denied);
    const cleared = Object.fromEntries(Object.entries(before).filter(([key]) => key !== field));
    expect(() => access.sourceBackendChange(context(),backend,backend,[target],[{...target,moduleConfiguration:{defaults:cleared}} as ConfigurationTarget])).toThrow(denied);
    expect(() => access.sourceBackendChange(context(),backend,backend,[target],[{...target,moduleConfiguration:{defaults:{}}} as ConfigurationTarget])).toThrow(denied);
    if (kind === "antigravity_acp")
      expect(() => access.sourceBackendChange(context(),backend,backend,[target],[{...target,moduleConfiguration:{}} as ConfigurationTarget])).toThrow(denied);
  });

  it("forbids own runtime and applied tool-policy changes while permitting a sibling backend", () => {
    const current = context();
    expect(() => access.sourceRuntimeAction(current,"environment","env-a")).toThrow(denied);
    expect(() => access.sourceRuntimeAction(current,"backend","source-backend")).toThrow(denied);
    access.sourceRuntimeAction(current,"backend","sibling-backend");
    access.sourceRuntimeAction(current,"environment","env-b");
    expect(() => access.sourceThreadUpdate(current,"source")).toThrow(denied);
    access.sourceThreadUpdate(current,"other");
    expect(() => new ExecutionManagementAccess({...reader,resolveThread:()=>undefined},toolPolicies).sourceRuntimeAction(current,"backend","sibling-backend")).toThrow(denied);
  });
});
