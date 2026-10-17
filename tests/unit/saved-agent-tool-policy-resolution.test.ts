import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { ToolPolicyRepository } from "../../src/server/db/repositories/tool-policy-repository.js";
import { ToolPolicyService } from "../../src/server/tool-policies/tool-policy-service.js";
import type { AgentToolPresentation, AgentToolResourceScope } from "../../src/shared/protocol/conversation.js";
import type { ToolPolicySelection } from "../../src/shared/protocol/tool-policies.js";
import type { CreateThreadRequest } from "../../src/shared/protocol/api.js";
import { describe, expect, it, vi } from "vitest";
import {
  directThreadExecutionWorkspaceAllocator,
  SavedAgentApplicationService,
} from "../../src/server/application/saved-agent-application-service.js";
import { SavedAgentBackendAdapterRegistry } from "../../src/server/backends/saved-agent-adapter-registry.js";
import type { SavedAgentBackendAdapter } from "../../src/server/backends/saved-agent-adapter.js";
import type { BackendKind } from "../../src/server/backends/contracts.js";
import {
  savedAgentBackendTypeIdSchema,
} from "../../src/shared/protocol/saved-agents.js";

let scope: {tenantId:string;principalId:string};
const workspaceId = "10000000-0000-4000-8000-000000000001";
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const targetId = "target-1";
const backendInstanceId = "pi-primary";
const backendTypeId = savedAgentBackendTypeIdSchema.parse("test-agent");

function adapter(backendKind: BackendKind): SavedAgentBackendAdapter {
  return {
    typeId: backendTypeId,
    backendKind,
    presentation: {
      typeId: backendTypeId,
      label: { text: "Test Agent" },
      brand: backendKind === "pi" ? "pi" : "codex",
    },
    overrideSchemaVersion: 1,
    validateOverrides: ({ overrides }) => ({
      backendTypeId,
      schemaVersion: 1,
      overrides,
    }),
    prepareResolutionContext: () => ({
      backendTypeId,
      schemaVersion: 1,
      value: {},
    }),
    resolve: () => ({
      backendTypeId,
      schemaVersion: 1,
      normalizedValues: [],
      value: {},
    }),
    describeEditor: () => ({
      backendTypeId,
      fields: [],
      canonicalOverrides: [],
    }),
    captureThreadConfiguration: () => {
      throw new Error("not_used");
    },
    assertThreadConfigurationCapture: () => {
      throw new Error("not_used");
    },
    initializeNewThread: () => undefined,
  };
}

function fixture(input: {
  readonly backendKind: BackendKind;
  readonly nativePresentation: boolean;
  readonly environmentKind?: "local" | "ssh";
  readonly eligibleToolIds?: ReadonlySet<string>;
}) {
  const initialized = vi.fn();
  const originRecorded = vi.fn();
  const {database, scope: realScope} = savedAgentDatabase();
  scope = realScope;
  const policySets = new ToolPolicyService(new ToolPolicyRepository(database));
  let beforeCreation: (() => void) | undefined;
  let agentSelection: ToolPolicySelection = {kind:"inherit"};
  const sourcePolicy = { enabled: true, enabledToolIds: ["task.list"], resourceScope: {allowOtherEnvironments:false,allowOtherProjects:false}, revision: 0 };
  const createServerDraft = vi.fn(async (_scope, value) => {
    beforeCreation?.();
    const transaction = {assertActive() {}};
    value.bootstrap?.assertDurableFences(transaction);
    value.bootstrap?.initializeAgentTools({transaction,applicationThreadId:"created-thread",now:1});
    value.initializeApplicationThread?.({transaction,applicationThreadId:"created-thread",target:{connection:{backendInstanceId,executionEnvironmentId:environmentId}},now:1});
    return {applicationThreadId:"created-thread"};
  });
  const profile = {
    id: targetId,
    backendInstanceId,
    executionEnvironmentId: environmentId,
    label: "Target",
    enabled: 1 as const,
    configurationRevision: 0,
    configurationFingerprint: "profile-fingerprint",
  };
  const backend = {
    id: backendInstanceId,
    kind: input.backendKind,
    enabled: 1 as const,
    configurationRevision: 0,
    configurationFingerprint: "backend-fingerprint",
  };
  const service = new SavedAgentApplicationService({
    policySets,
    principalToolClients: {get: () => ({enabled:true,policyRevision:2,credentialGeneration:1,toolIds:["task.list"]})} as never,
    toolPolicyOrigins: {database, record: originRecorded} as never,
    agents: {get: () => ({id:"20000000-0000-4000-8000-000000000001",name:"Reviewer",backendTypeId,backendOverrides:[],revision:0,toolPolicySelection:agentSelection})} as never,
    repository: { database, assertRevision: () => undefined } as never,
    adapters: new SavedAgentBackendAdapterRegistry([
      { backendInstanceId, adapter: adapter(input.backendKind) },
    ]),
    configuration: {
      database,
      listProfiles: () => [profile],
      getProfile: () => profile,
      getBackend: () => backend,
    } as never,
    inventory: {
      database,
      getWorkspace: () => ({
        id: workspaceId,
        environmentId,
        projectId: "project-1",
        revision: 0,
        environmentConfigurationRevision: 0,
      }),
      getEnvironment: () => ({ kind: input.environmentKind ?? "local" }),
      assertWorkspaceActive: () => undefined,
      getThread: () => ({thread:{workspaceId,environmentId}}),
    } as never,
    targets: {
      lifecycle: async () => ({
        connection: {
          ...profile,
          tenantId: scope.tenantId,
          ownerPrincipalId: scope.principalId,
          templateId: targetId,
          kind: input.backendKind === "pi" ? "pi_sdk" : "codex_app_server",
          enabled: true,
        },
        workspace: {
          canonicalPath: "/workspace",
          authorityRevision: 0,
          summary: {
            id: workspaceId,
            environmentId,
            displayName: "Workspace",
            displayPath: "/workspace",
            availability: "available" as const,
            trustState: "trusted" as const,
            revision: 0,
          },
        },
      }),
    } as never,
    targetHealth: {
      requireSelectable: async () => undefined,
      requireAgentSelectable: async () => undefined,
    } as never,
    registry: {
      driver: () => ({
        catalog: async () => ({
          models: [],
          commands: [],
          skills: [],
          notices: [],
        }),
      }),
    } as never,
    lifecycle: {createServerDraft} as never,
    toolPolicies: { database, initialize: initialized, getDurable: () => sourcePolicy } as never,
    toolEligibility: {
      eligibleToolIds: input.eligibleToolIds ?? new Set(),
      presentationOptions: (_backendKind, environmentKind) =>
        input.nativePresentation
          ? environmentKind === "local"
            ? [
                { surface: "native", modes: ["progressive", "individual"] },
                { surface: "cli", modes: ["progressive", "individual"] },
              ]
            : [
                { surface: "native", modes: ["progressive", "individual"] },
              ]
          : [{ surface: "cli", modes: ["progressive", "individual"] }],
    },
    toolCatalog: { list: () => ({ groups: [] }) },
    executionWorkspaces: directThreadExecutionWorkspaceAllocator,
    publications: { handoffThreadChange: () => undefined },
  });
  return { database, service, policySets, initialized, originRecorded, createServerDraft, sourcePolicy, beforeCreate(callback:()=>void) {beforeCreation = callback;}, setAgentSelection(selection: ToolPolicySelection) {agentSelection = selection;} };
}

async function options(
  current: ReturnType<typeof fixture>,
  sedesTools: {enabled:boolean;enabledToolIds:string[];presentation:AgentToolPresentation;resourceScope:AgentToolResourceScope},
) {
  return current.service.options(scope, {
    workspaceId,
    targetId,
    overrides: [],
    toolPolicySelection: sedesTools.enabled ? {kind:"policy_set",policySetId:current.policySets.repository.create(scope,{name:"Options policy",enabledToolIds:sedesTools.enabledToolIds,resourceScope:sedesTools.resourceScope}).id} : {kind:"disabled"},
    toolPresentation: sedesTools.presentation,
  });
}

describe("Saved Agent Sedes-tool policy resolution", () => {
  it("rejects a Sedes tool outside the canonical Saved Agent eligibility set", async () => {
    const current = fixture({ backendKind: "pi", nativePresentation: true });
    try {
      await expect(
        options(current, {
          enabled: true,
          enabledToolIds: ["not.saved-agent-eligible"],
          presentation: { surface: "native", mode: "progressive" },
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
    } finally {
      current.database.close();
    }
  });

  it("accepts an explicit CLI mode for a CLI-only Codex target", async () => {
    const current = fixture({
      backendKind: "codex_app_server",
      nativePresentation: false,
    });
    try {
      await expect(
        options(current, {
          enabled: false,
          enabledToolIds: [],
          presentation: { surface: "cli", mode: "individual" },
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        }),
      ).resolves.toMatchObject({
        kind: "configuration",
        sedesTools: {
          resolvedPolicy: {
            presentation: { surface: "cli", mode: "individual" },
          },
        },
      });
    } finally {
      current.database.close();
    }
  });

  it("allows an Agent when its configured CLI tools are unavailable in the target environment", async () => {
    const toolId = "task.list";
    const current = fixture({
      backendKind: "pi",
      nativePresentation: true,
      eligibleToolIds: new Set([toolId]),
    });
    try {
      await expect(
        options(current, {
          enabled: true,
          enabledToolIds: [toolId],
          presentation: { surface: "cli", mode: "progressive" },
          resourceScope: { allowOtherEnvironments: true, allowOtherProjects: true },
        }),
      ).resolves.toMatchObject({
        kind: "configuration",
        sedesTools: {
          resolvedPolicy: {
            enabled: true,
            enabledToolIds: [toolId],
            presentation: { surface: "cli", mode: "progressive" },
            resourceScope: { allowOtherEnvironments: true, allowOtherProjects: true },
          },
        },
      });
    } finally {
      current.database.close();
    }
  });

  it("advertises only native presentations and rejects CLI for an SSH Pi target", async () => {
    const current = fixture({
      backendKind: "pi",
      nativePresentation: true,
      environmentKind: "ssh",
    });
    try {
      await expect(
        options(current, {
          enabled: false,
          enabledToolIds: [],
          presentation: { surface: "native", mode: "progressive" },
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        }),
      ).resolves.toMatchObject({
        kind: "configuration",
        sedesTools: {
          presentationOptions: [
            { surface: "native", modes: ["progressive", "individual"] },
          ],
          resolvedPolicy: expect.objectContaining({
            resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
          }),
        },
      });
      await expect(
        options(current, {
          enabled: false,
          enabledToolIds: [],
          presentation: { surface: "cli", mode: "progressive" },
          resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
    } finally {
      current.database.close();
    }
  });
});


describe("new-thread tool policy snapshots", () => {
  function request(): CreateThreadRequest {
    return {workspaceId,title:"Policy example",executionWorkspace:{kind:"direct"},configuration:{kind:"custom",targetId}};
  }
  function configure(current: ReturnType<typeof fixture>, level: "account" | "environment" | "backend", name: string, tools: string[]) {
    const policy = current.policySets.create(scope,{name,enabledToolIds:tools,resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}});
    const target = level === "account" ? {kind:level as "account"} : level === "environment" ? {kind:level as "environment",executionEnvironmentId:environmentId} : {kind:level as "backend",backendId:backendInstanceId};
    current.policySets.updateSelection(scope,{target,selection:{kind:"policy_set",policySetId:policy.id},expectedRevision:0});
    return policy;
  }
  it("uses account defaults for custom creation and freezes exact IDs and provenance", async () => {
    const current = fixture({backendKind:"pi",nativePresentation:true,eligibleToolIds:new Set(["task.list","thread.status"])});
    try {
      const policy = configure(current,"account","Everyday",["task.list"]);
      await current.service.createThread(scope,request(),{kind:"http_ui"});
      expect(current.initialized).toHaveBeenCalledWith(scope,"created-thread",expect.objectContaining({enabled:true,enabledToolIds:["task.list"],presentation:{surface:"native",mode:"progressive"}}));
      expect(current.originRecorded).toHaveBeenCalledWith(scope,"created-thread",{source:"account",policySet:{id:policy.id,name:"Everyday",revision:0}},1);
      current.policySets.update(scope,policy.id,{name:policy.name,enabledToolIds:["thread.status"],resourceScope:policy.resourceScope,expectedRevision:0});
      expect(current.initialized.mock.calls[0]![2].enabledToolIds).toEqual(["task.list"]);
    } finally {current.database.close();}
  });
  it("replaces the whole inherited list at the closest selected level and allows explicit disablement", async () => {
    const current = fixture({backendKind:"pi",nativePresentation:true,eligibleToolIds:new Set(["task.list","thread.status"])});
    try {
      configure(current,"account","Everyday",["task.list"]);
      configure(current,"backend","Backend",["thread.status"]);
      await current.service.createThread(scope,request(),{kind:"http_ui"});
      expect(current.initialized.mock.calls[0]![2].enabledToolIds).toEqual(["thread.status"]);
      await current.service.createThread(scope,{...request(),toolPolicySelection:{kind:"disabled"}},{kind:"http_ui"});
      expect(current.initialized.mock.calls[1]![2]).toMatchObject({enabled:false,enabledToolIds:[],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}});
    } finally {current.database.close();}
  });
  it("replaces backend defaults with an Agent policy and permits a thread override", async () => {
    const current = fixture({backendKind:"pi",nativePresentation:true,eligibleToolIds:new Set(["task.list","thread.status"])});
    try {
      const account = configure(current,"account","Everyday",["task.list"]);
      configure(current,"backend","Backend",["task.list"]);
      const agent = current.policySets.create(scope,{name:"Reviewer",enabledToolIds:["thread.status"],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:true}});
      current.setAgentSelection({kind:"policy_set",policySetId:agent.id});
      const fromAgent: CreateThreadRequest = {...request(),configuration:{kind:"saved_agent",agentId:"20000000-0000-4000-8000-000000000001",targetId}};
      await current.service.createThread(scope,fromAgent,{kind:"http_ui"});
      expect(current.initialized.mock.calls[0]![2].enabledToolIds).toEqual(["thread.status"]);
      expect(current.originRecorded.mock.calls[0]![2].source).toBe("agent");
      await current.service.createThread(scope,{...fromAgent,toolPolicySelection:{kind:"policy_set",policySetId:account.id}},{kind:"http_ui"});
      expect(current.initialized.mock.calls[1]![2].enabledToolIds).toEqual(["task.list"]);
      expect(current.originRecorded.mock.calls[1]![2].source).toBe("thread");
    } finally {current.database.close();}
  });
  it("allows an explicit replacement when an inherited policy was deleted", async () => {
    const current = fixture({backendKind:"pi",nativePresentation:true,eligibleToolIds:new Set(["task.list"])});
    try {
      const account = configure(current,"account","Everyday",["task.list"]);
      current.policySets.delete(scope,account.id,account.revision);
      await expect(current.service.createThread(scope,request(),{kind:"http_ui"})).rejects.toMatchObject({code:"not_found"});
      await current.service.createThread(scope,{...request(),toolPolicySelection:{kind:"disabled"}},{kind:"http_ui"});
      expect(current.initialized).toHaveBeenCalledOnce();
      const preview = await current.service.options(scope,{workspaceId,targetId,toolPolicySelection:{kind:"disabled"}});
      expect(preview).toMatchObject({kind:"configuration",sedesTools:{defaultPolicy:null,defaultUnavailableReason:{text:expect.stringContaining("inherited tool policy")}}});
    } finally {current.database.close();}
  });
  it("rejects policy edits between resolution and creation commit", async () => {
    const current = fixture({backendKind:"pi",nativePresentation:true,eligibleToolIds:new Set(["task.list","thread.status"])});
    try {
      const policy = configure(current,"account","Everyday",["task.list"]);
      current.beforeCreate(() => current.policySets.update(scope,policy.id,{name:policy.name,enabledToolIds:["thread.status"],resourceScope:policy.resourceScope,expectedRevision:0}));
      await expect(current.service.createThread(scope,request(),{kind:"http_ui"})).rejects.toMatchObject({code:"conflict"});
      expect(current.initialized).not.toHaveBeenCalled();
    } finally {current.database.close();}
  });
  it("fails closed when a selected policy belongs to another principal", async () => {
    const current = fixture({backendKind:"pi",nativePresentation:true,eligibleToolIds:new Set(["task.list"])});
    try {
      const policy = configure(current,"account","Everyday",["task.list"]);
      await expect(current.service.options({...scope,principalId:"another-principal"},{workspaceId,targetId,toolPolicySelection:{kind:"policy_set",policySetId:policy.id}})).rejects.toMatchObject({code:"not_found"});
    } finally {current.database.close();}
  });
  it("prevents an agent from giving a child more tools or cross-environment access", async () => {
    const current = fixture({backendKind:"pi",nativePresentation:true,eligibleToolIds:new Set(["task.list","thread.status"])});
    try {
      const policy = current.policySets.create(scope,{name:"Too broad",enabledToolIds:["task.list","thread.status"],resourceScope:{allowOtherEnvironments:true,allowOtherProjects:false}});
      const authority = {id:"grant",callerKind:"thread_agent",defaults:{kind:"thread_agent",threadId:"source-thread",workspaceId,environmentId,projectId:"project-1"},policyIdentity:{ownerKind:"thread",ownerId:"source-thread",revision:0},admittedEnvironmentIds:[environmentId],targetEnvironmentIds:[environmentId],resolvedResourceRefs:[{kind:"workspace",id:workspaceId,environmentId,projectId:"project-1"}],display:{targetEnvironmentLabels:[],resourceLabels:[]},canonicalInputDigest:"input",authorityDigest:"authority",resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}} as const;
      const caller = {kind:"agent_tool",initiator:{kind:"thread_agent",sourceThreadId:"source-thread",sourceWorkspaceId:workspaceId},mutationId:"create-child",environmentAuthority:authority} as const;
      await expect(current.service.createThread(scope,{...request(),toolPolicySelection:{kind:"policy_set",policySetId:policy.id}},caller)).rejects.toMatchObject({code:"invalid_transition"});
      expect(current.createServerDraft).not.toHaveBeenCalled();
      await current.service.createThread(scope,{...request(),toolPolicySelection:{kind:"disabled"}},caller);
      expect(current.initialized).toHaveBeenCalledOnce();
    } finally {current.database.close();}
  });
  it("caps delegated threads to the principal tool client's selected tools and environment", async () => {
    const current = fixture({backendKind:"pi",nativePresentation:true,eligibleToolIds:new Set(["task.list","thread.status"])});
    try {
      const policy = current.policySets.create(scope,{name:"Too broad",enabledToolIds:["task.list"],resourceScope:{allowOtherEnvironments:true,allowOtherProjects:false}});
      const authority = {id:"grant",callerKind:"principal_client",defaults:{kind:"principal_client",environmentId},policyIdentity:{ownerKind:"principal_client",ownerId:"client",revision:2,credentialGeneration:1},admittedEnvironmentIds:[environmentId],targetEnvironmentIds:[environmentId],resolvedResourceRefs:[{kind:"workspace",id:workspaceId,environmentId,projectId:"project-1"}],display:{targetEnvironmentLabels:[],resourceLabels:[]},canonicalInputDigest:"input",authorityDigest:"authority"} as const;
      const caller = {kind:"agent_tool",initiator:{kind:"principal_client",clientId:"client"},mutationId:"create-client-child",environmentAuthority:authority} as const;
      await expect(current.service.createThread(scope,{...request(),toolPolicySelection:{kind:"disabled"}},{...caller,initiator:{kind:"principal_client",clientId:"different-client"}})).rejects.toMatchObject({code:"conflict"});
      await expect(current.service.createThread(scope,{...request(),toolPolicySelection:{kind:"disabled"}},{...caller,environmentAuthority:{...authority,callerKind:"thread_agent"}})).rejects.toMatchObject({code:"conflict"});
      expect(current.createServerDraft).not.toHaveBeenCalled();
      await expect(current.service.createThread(scope,{...request(),toolPolicySelection:{kind:"policy_set",policySetId:policy.id}},caller)).rejects.toMatchObject({code:"invalid_transition"});
      current.policySets.update(scope,policy.id,{name:policy.name,enabledToolIds:["thread.status"],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false},expectedRevision:0});
      await expect(current.service.createThread(scope,{...request(),toolPolicySelection:{kind:"policy_set",policySetId:policy.id}},caller)).rejects.toMatchObject({code:"invalid_transition"});
      current.policySets.update(scope,policy.id,{name:policy.name,enabledToolIds:["task.list"],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:true},expectedRevision:1});
      await current.service.createThread(scope,{...request(),toolPolicySelection:{kind:"policy_set",policySetId:policy.id}},caller);
      expect(current.initialized).toHaveBeenCalledOnce();
    } finally {current.database.close();}
  });

});
