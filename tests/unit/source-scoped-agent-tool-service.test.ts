import { testAgentToolExecutionAuthority } from "../support/agent-tool-execution-authority.js";
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver, type AgentToolEnvironmentAuthorityReader } from "../../src/server/agent-tools/environment/environment-authority.js";
import { agentContextToolDefinition } from "../../src/server/agent-tools/tools/agent-context-tool.js";
import type { AgentToolDefinition } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import type { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import type { AgentToolResourceScope, AgentToolPresentation } from "../../src/shared/protocol/conversation.js";
import { AGENT_TOOL_JSON_SCHEMA_DIALECT, normalizeCanonicalAgentToolSchema } from "../../src/server/agent-tools/schema/canonical-json-schema.js";

const source = {scope: {tenantId:"tenant",principalId:"principal"}, sourceThreadId:"source", sourceWorkspaceId:"workspace", sourceEnvironmentId:"local", backendKind:"pi" as const};
const threads = new Map([
  ["source", {id:"source",environmentId:"local",workspaceId:"workspace",projectId:"project"}],
  ["same-project-remote", {id:"same-project-remote",environmentId:"remote",workspaceId:"workspace-remote",projectId:"project"}],
  ["other-project-local", {id:"other-project-local",environmentId:"local",workspaceId:"other-workspace",projectId:"other"}],
  ["other-project-remote", {id:"other-project-remote",environmentId:"remote",workspaceId:"other-remote",projectId:"other"}],
]);
const reader: AgentToolEnvironmentAuthorityReader = {
  resolveEnvironment: (_scope,id) => ({id,environmentId:id}),
  resolveWorkspace: (_scope,id) => { const fact=[...threads.values()].find(thread=>thread.workspaceId===id); return fact ? {...fact,id} : undefined; },
  resolveWorkspaceProject: (_scope,id) => [...threads.values()].find(thread=>thread.workspaceId===id)?.projectId,
  resolveThread: (_scope,id) => threads.get(id), resolveThreadFamily: (_scope,id) => threads.has(id) ? [threads.get(id)!] : undefined,
  resolveAutomation: () => undefined, resolveSavedAgent: (_scope,id) => ({id,revision:1}),
  resolveTask: (_scope,id) => id === "project-task" ? {id,revision:1,scopeKind:"project",projectId:"project"} : undefined,
  resolveWorkpad: () => undefined,
  resolveProject: (_scope,id) => ({id,membershipRevision:1,memberEnvironmentIds:["local","remote"]}),
  listEnvironments: () => ["local","remote"].map(id=>({id,environmentId:id})),
};
function fixture(resourceScope: AgentToolResourceScope, presentation: AgentToolPresentation = {surface:"cli",mode:"individual"}) {
  const executed = vi.fn();
  const specs = [
    ["example.direct", {kind:"direct_resource",resource:"thread"}],
    ["example.task", {kind:"direct_resource",resource:"task"}],
    ["example.query", {kind:"scoped_query",resource:"thread"}],
    ["example.environments", {kind:"installation_directory"}],
    ["example.agent", {kind:"direct_resource",resource:"saved_agent",inputField:"agentId"}],
  ] as const;
  const definitions = specs.map(([id,environmentAuthority]) => ({
    ...agentContextToolDefinition,id,schemaVersion:1,environmentAuthority,
    inputSchema:normalizeCanonicalAgentToolSchema({$schema:AGENT_TOOL_JSON_SCHEMA_DIALECT,...Type.Object({threadId:Type.Optional(Type.String({minLength:1,maxLength:128})),taskId:Type.Optional(Type.String({minLength:1,maxLength:128})),agentId:Type.Optional(Type.String({minLength:1,maxLength:128})),scope:Type.Optional(Type.Object({kind:Type.String({minLength:1,maxLength:128}),workspaceId:Type.Optional(Type.String({minLength:1,maxLength:128}))},{additionalProperties:false,maxProperties:4}))},{additionalProperties:false,maxProperties:4})}),
    outputSchema:normalizeCanonicalAgentToolSchema({$schema:AGENT_TOOL_JSON_SCHEMA_DIALECT,...Type.Object({environments:Type.Array(Type.String({minLength:1,maxLength:128}),{maxItems:100}),resources:Type.Array(Type.String({minLength:1,maxLength:128}),{maxItems:100})},{additionalProperties:false,maxProperties:4})}),
    adapters:{pi:{name:`sedes_${id.replaceAll(".","_")}`,label:id},mcp:{name:`sedes_${id.replaceAll(".","_")}`},http:{invocation:"inline"},cli:{command:id}},
    execute: async (_input,context) => {executed();return {environments:[...context.environmentAuthority.targetEnvironmentIds],resources:context.environmentAuthority.resolvedResourceRefs.map(ref=>ref.id)};},
  }) as AgentToolDefinition);
  let policy = {enabled:true,enabledToolIds:specs.map(([id])=>id) as string[],presentation,resourceScope,revision:1};
  let attached = source;
  const canonical = new CanonicalInlineAgentToolService({application:{readThreadStatus:async()=>undefined},additionalDefinitions:definitions});
  const service = new SourceScopedAgentToolService(canonical, {get:()=>policy} as unknown as ThreadAgentToolPolicyRepository,
    new AgentToolEnvironmentAuthorityResolver(reader),{resolveInScope:()=>attached}, testAgentToolExecutionAuthority);
  const invoke = (toolId:string,input:unknown,adapter:"cli"|"pi_sdk"|"mcp"="cli") => service.invoke({source,adapter,request:{toolId,schemaVersion:1,requestId:crypto.randomUUID(),input},signal:new AbortController().signal});
  return {service,invoke,executed,setPolicy:(next:Partial<typeof policy>)=>{policy={...policy,...next};},changeSource:()=>{attached={...source,sourceWorkspaceId:"moved"};}};
}

describe("thread tool resource scope",()=>{
  it.each([
    [false,false,["source"]], [true,false,["source","same-project-remote"]],
    [false,true,["source","other-project-local"]], [true,true,[...threads.keys()]],
  ] as const)("enforces independent environment=%s and project=%s on explicit IDs", async (allowOtherEnvironments,allowOtherProjects,allowed)=>{
    const f=fixture({allowOtherEnvironments,allowOtherProjects});
    for (const id of threads.keys()) {
      const request=f.invoke("example.direct",{threadId:id});
      if ((allowed as readonly string[]).includes(id)) await expect(request).resolves.toMatchObject({state:"completed"});
      else await expect(request).rejects.toMatchObject({toolError:{code:"permission_denied"}});
    }
    expect(f.executed).toHaveBeenCalledTimes(allowed.length);
  });
  it("explains an explicit denial without an approval interaction",async()=>{
    const f=fixture({allowOtherEnvironments:false,allowOtherProjects:false});
    await expect(f.invoke("example.direct",{threadId:"same-project-remote"})).rejects.toMatchObject({toolError:{message:expect.stringContaining("Cross-environment access is disabled")}});
    await expect(f.invoke("example.direct",{threadId:"other-project-local"})).rejects.toMatchObject({toolError:{message:expect.stringContaining("other projects is disabled")}});
    expect(f.executed).not.toHaveBeenCalled();
  });
  it("intersects broad and explicit workspace discovery with scope",async()=>{
    const f=fixture({allowOtherEnvironments:false,allowOtherProjects:false});
    await expect(f.invoke("example.query",{scope:{kind:"all_allowed_environments"}})).resolves.toMatchObject({output:{environments:["local"]}});
    await expect(f.invoke("example.query",{scope:{kind:"workspace",workspaceId:"other-remote"}})).resolves.toMatchObject({output:{environments:[],resources:[]}});
    await expect(f.invoke("example.environments",{})).resolves.toMatchObject({output:{environments:["local"]}});
  });
  it("shares project records across the project's hosts and keeps Saved Agents account-wide",async()=>{
    const f=fixture({allowOtherEnvironments:false,allowOtherProjects:false});
    await expect(f.invoke("example.task",{taskId:"project-task"})).resolves.toMatchObject({state:"completed"});
    await expect(f.invoke("example.agent",{agentId:"agent"})).resolves.toMatchObject({state:"completed"});
  });
  it("rereads the live policy, never using attachment as invocation authority",async()=>{
    const f=fixture({allowOtherEnvironments:true,allowOtherProjects:true});
    f.setPolicy({resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}});
    await expect(f.invoke("example.direct",{threadId:"same-project-remote"})).rejects.toMatchObject({toolError:{code:"permission_denied"}});
    f.setPolicy({enabledToolIds:[]});
    await expect(f.invoke("example.direct",{threadId:"source"})).rejects.toMatchObject({toolError:{code:"permission_denied"}});
    expect(f.executed).not.toHaveBeenCalled();
  });
  it("revalidates the server-derived source before admission",async()=>{
    const f=fixture({allowOtherEnvironments:true,allowOtherProjects:true});f.changeSource();
    await expect(f.invoke("example.direct",{threadId:"source"})).rejects.toMatchObject({toolError:{code:"permission_denied"}});
  });
  it("preserves backend-native versus CLI presentation admission",async()=>{
    const f=fixture({allowOtherEnvironments:true,allowOtherProjects:true},{surface:"native",mode:"individual"});
    await expect(f.invoke("example.direct",{threadId:"source"},"pi_sdk")).resolves.toMatchObject({state:"completed"});
    for (const adapter of ["cli","mcp"] as const) await expect(f.invoke("example.direct",{threadId:"source"},adapter)).rejects.toMatchObject({toolError:{code:"permission_denied"}});
  });
  it("filters discovery by enabled IDs and validates descriptions atomically",()=>{
    const f=fixture({allowOtherEnvironments:false,allowOtherProjects:false});
    f.setPolicy({enabledToolIds:["example.direct"]});
    expect(f.service.catalogSummaries(source,"cli").map(tool=>tool.id)).toEqual(["example.direct"]);
    expect(()=>f.service.describeMany(source,"cli",["example.direct","example.query"])).toThrow();
    expect(f.service.catalogSummaries(source,"http")).toEqual([]);
    f.setPolicy({enabled:false});expect(f.service.catalogSummaries(source,"cli")).toEqual([]);
  });
  it("keeps ordinary execution alive without requiring current-user proof", async () => {
    const f = fixture({allowOtherEnvironments:false,allowOtherProjects:false});
    const release = vi.fn();
    const runtime = new AbortController();
    const acquire = vi.spyOn(f.service.executionAuthority, "acquireAgentToolExecutionAuthority").mockResolvedValue({generation:"one",signal:runtime.signal,isCurrent:()=>true,release});
    let finish!: (value: never) => void;
    const pending = new Promise<never>(resolve => {finish = resolve;});
    const execute = vi.spyOn(f.service.canonical, "invoke").mockReturnValue(pending);
    try {
      const userProof = vi.fn(async () => { throw new Error("No user input exists for this automation call."); });
      const result = f.service.invoke({source,adapter:"cli",request:{toolId:"example.direct",schemaVersion:1,requestId:crypto.randomUUID(),input:{threadId:"source"}},signal:new AbortController().signal,accessDecisionAuthority:{acquire:userProof}});
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(userProof).not.toHaveBeenCalled();
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      finish({state:"completed",output:{}} as never);
      await expect(result).resolves.toMatchObject({state:"completed"});
      expect(release).toHaveBeenCalledOnce();
    } finally { acquire.mockRestore(); execute.mockRestore(); }
  });
  it("rechecks policy after borrowing a source runtime and releases denied work", async () => {
    const f = fixture({allowOtherEnvironments:false,allowOtherProjects:false});
    const release = vi.fn();
    let finish!: (value: Awaited<ReturnType<typeof f.service.executionAuthority.acquireAgentToolExecutionAuthority>>) => void;
    const acquire = vi.spyOn(f.service.executionAuthority, "acquireAgentToolExecutionAuthority").mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    try {
      const result = f.invoke("example.direct",{threadId:"source"});
      f.setPolicy({enabled:false});
      finish({generation:"one",signal:new AbortController().signal,isCurrent:()=>true,release});
      await expect(result).rejects.toMatchObject({toolError:{code:"permission_denied"}});
      expect(f.executed).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally { acquire.mockRestore(); }
  });

});
