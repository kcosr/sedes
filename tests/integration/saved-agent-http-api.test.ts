import { ToolPolicyService } from "../../src/server/tool-policies/tool-policy-service.js";
import { ToolPolicyRepository } from "../../src/server/db/repositories/tool-policy-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";
import { savedAgentBackendTypeIdSchema } from "../../src/shared/protocol/saved-agents.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" } as const;
const agentId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8000-000000000001";
const threadId = "30000000-0000-4000-8000-000000000001";
const copiedThreadId = "40000000-0000-4000-8000-000000000001";
const backendTypeId = savedAgentBackendTypeIdSchema.parse("pi");
const backend = {
  typeId: backendTypeId,
  label: { text: "Pi" },
  brand: "pi" as const,
};
const agent = {
  id: agentId,
  name: "Reviewer",
  backendTypeId,
  backend,
  backendOverrides: [],
  toolPolicySelection: { kind: "inherit" as const },
  revision: 0,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
};
const target = { id: "target-1", label: { text: "Local Pi" }, backend };
const sedesTools = {
  defaultPolicy: {
    source: "default" as const,
    enabled: false,
    enabledToolIds: [],
    presentation: { surface: "native" as const, mode: "progressive" as const },
    resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
  },
  resolvedPolicy: {
    source: "default" as const,
    enabled: false,
    enabledToolIds: [],
    presentation: { surface: "native" as const, mode: "progressive" as const },
    resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
  },
  defaultPresentation: { surface: "native" as const, mode: "progressive" as const },
  groups: [],
  presentationOptions: [
    {
      surface: "native" as const,
      modes: ["progressive", "individual"] as const,
    },
    { surface: "cli" as const, modes: ["progressive", "individual"] as const },
  ] as const,
};
const configuration = {
  backendTypeId,
  fields: [],
  canonicalOverrides: [],
};

function fixture(options: { policySets?: ToolPolicyService; requestScope?: {tenantId:string;principalId:string} } = {}) {
  const handoffThreadChange = vi.fn();
  const savedAgents = {
    list: vi.fn(() => ({
      items: [
        {
          id: agentId,
          name: agent.name,
          backendTypeId,
          backend,
          overrideCount: 0,
          toolPolicySelection: { kind: "inherit" as const },
          revision: 0,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
        },
      ],
    })),
    get: vi.fn(() => agent),
    createAgent: vi.fn(async () => agent),
    updateAgent: vi.fn(async () => ({ ...agent, revision: 1 })),
    deleteAgent: vi.fn(() => ({ deleted: true as const, agentId })),
    options: vi.fn(async (_scope, input: { targetId?: string }) =>
      input.targetId
        ? {
            kind: "configuration" as const,
            target,
            configuration,
            sedesTools,
          }
        : { kind: "targets" as const, targets: [target] },
    ),
    resolveAgent: vi.fn(async () => ({
      candidates: [{ target, configuration, sedesTools }],
      failures: [],
    })),
    createThread: vi.fn(async () => {
      handoffThreadChange(scope, threadId);
      return { threadId, workspaceId, targetId: target.id };
    }),
    createThreadFromSettings: vi.fn(async () => ({
      threadId: copiedThreadId,
      workspaceId,
      targetId: target.id,
    })),
  };
  const policySet = {
    id: "60000000-0000-4000-8000-000000000001", name: "Everyday",
    enabledToolIds: ["thread.list"], resourceScope: {allowOtherEnvironments:false,allowOtherProjects:false},
    revision: 0, createdAt: agent.createdAt, updatedAt: agent.updatedAt,
  };
  const policySets = {
    list: vi.fn(() => ({items:[policySet]})), get: vi.fn(() => policySet),
    options: vi.fn(() => ({groups:[]})), create: vi.fn(() => policySet),
    update: vi.fn(() => ({...policySet,revision:1})), delete: vi.fn(() => ({deleted:true})),
    listSelections: vi.fn(() => ({items:[]})),
    updateSelection: vi.fn((_scope, input) => ({target:input.target,selection:input.selection,revision:1})),
    preview: vi.fn(() => ({enabled:true,enabledToolIds:policySet.enabledToolIds,resourceScope:policySet.resourceScope,source:"account",policySet:{id:policySet.id,name:policySet.name,revision:0},defaultPresentation:{surface:"native",mode:"progressive"},presentationOptions:[{surface:"native",modes:["progressive","individual"]}]})),
  };
  const unused = () => {
    throw new Error("route_not_configured_for_test");
  };
  const app = createNormalizedApp({
    usage: {availability: () => {throw new Error("usage_not_configured_in_fixture");}, read: () => { throw new Error("usage_not_configured_in_fixture"); }, analytics: () => { throw new Error("usage_not_configured_in_fixture"); }, facets: () => { throw new Error("usage_not_configured_in_fixture"); }},
    workpads: {} as never,
    questions: {} as never,
    cannedPrompts: {} as never,
    turnBookmarks: unavailableTurnBookmarks(),
    workspaceDiffReviews: {} as never,
    config: {
      authenticationRequired: true, clientResponseCompression: true,
      experimentalUsageEnabled: false,
      host: "127.0.0.1",
      port: 4783,
      stateDirectory: "/tmp/saved-agent-http-test",
      allowedTailscaleHosts: [],
      packagedClientOrigins: [],
      conversationRetentionMilliseconds: 600_000,
      conversationRuntimeBudget: 8,
    },
    csrfToken: "saved-agent-csrf",
    identity: { resolve: async () => options.requestScope ?? scope },
    notifications: {} as never,
    principalPreferences: {} as never,
    executionTargets: {
      read: async () => ({ executionTargets: [], defaultTargetId: null }),
      requireSelectable: async () => undefined,
    },
    savedAgents: savedAgents as never,
    policySets: (options.policySets ?? policySets) as never,
    threadTemplates: {} as never,
    composerAttachments: {} as never,
    outputArtifacts: {} as never,
    applicationSnapshots: { handoffThreadChange } as never,
    threads: { snapshot: unused } as never,
    history: { loadOlder: unused } as never,
    threadRuntimes: { quiet: unused } as never,
    threadSnapshots: { publish: unused } as never,
    lifecycle: { createServerDraft: unused } as never,
    inventory: {} as never,
    threadGroups: {} as never,
    tasks: {} as never,
    workspaceFiles: {} as never,
    threadArchives: {} as never,
    threadExecutionWorkspaces: directThreadExecutionWorkspaceLifecycle,
    threadForceResets: {} as never,
    attention: { automationContexts: [] } as never,
    execution: {} as never,
    automations: {} as never,
    automationPrechecks: {} as never,
    agentTools: unavailableAgentToolRouterDependencies(),
    lineage: {
      forkManual: unused,
      updatePlacement: unused,
      listDescendants: unused,
    },
  });
  const get = (path: string) =>
    request(app).get(path).set("Host", "127.0.0.1:4783");
  const mutate = (method: "post" | "patch" | "delete" | "put", path: string) =>
    request(app)
      [method](path)
      .set("Host", "127.0.0.1:4783")
      .set("X-CSRF-Token", "saved-agent-csrf");
  return { app, savedAgents, policySets, policySet, handoffThreadChange, get, mutate };
}

describe("Saved Agent normalized HTTP API", () => {
  it("keeps policy data and mutations within the authenticated principal", async () => {
    const state = savedAgentDatabase();
    try {
      const service = new ToolPolicyService(new ToolPolicyRepository(state.database));
      const definition = {name:"Private tools",enabledToolIds:["thread.list"],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}};
      const policy = service.create(state.scope,definition);
      const foreignScope = {...state.scope,principalId:"other-principal"};
      state.database.prepare("INSERT INTO principals(tenant_id,id,kind,created_at) VALUES (?,?,'local_human',100)").run(foreignScope.tenantId,foreignScope.principalId);
      const owner = fixture({policySets:service,requestScope:state.scope});
      const other = fixture({policySets:service,requestScope:foreignScope});
      await owner.get(`/api/tool-policies/${policy.id}`).expect(200);
      await other.get("/api/tool-policies").expect(200).expect({items:[]});
      await other.get(`/api/tool-policies/${policy.id}`).expect(404);
      await other.mutate("patch",`/api/tool-policies/${policy.id}`).send({...definition,expectedRevision:0}).expect(404);
      await other.mutate("delete",`/api/tool-policies/${policy.id}`).send({expectedRevision:0}).expect(404);
      await other.mutate("put","/api/tool-policy-selections").send({target:{kind:"account"},selection:{kind:"policy_set",policySetId:policy.id},expectedRevision:0}).expect(404);
      await other.mutate("post","/api/tool-policies").send({...definition,principalId:state.scope.principalId}).expect(400);
      expect(service.get(state.scope,policy.id)).toEqual(policy);
      expect(service.listSelections(foreignScope)).toEqual({items:[]});
    } finally { state.database.close(); }
  });

  it("returns an actionable missing-level issue and permits a thread override", async () => {
    const state = savedAgentDatabase();
    try {
      const service = new ToolPolicyService(new ToolPolicyRepository(state.database));
      const policy = service.create(state.scope,{name:"Daily tools",enabledToolIds:["thread.list"],resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}});
      service.updateSelection(state.scope,{target:{kind:"account"},selection:{kind:"policy_set",policySetId:policy.id},expectedRevision:0});
      service.delete(state.scope,policy.id,0);
      const owner = fixture({policySets:service,requestScope:state.scope});
      const {id:targetId} = state.database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as {id:string};
      await owner.mutate("post","/api/tool-policies/resolve").send({targetId}).expect(404).expect(({body}) => {
        expect(body.error).toMatchObject({code:"not_found",retryable:false,toolPolicyIssue:{kind:"missing_policy_set",source:"account",policySetId:policy.id}});
      });
      await owner.mutate("post","/api/tool-policies/resolve").send({targetId,threadSelection:{kind:"disabled"}}).expect(200).expect(({body}) => {
        expect(body).toMatchObject({enabled:false,source:"thread"});
      });
    } finally {state.database.close();}
  });

  it("validates policy set and default-selection routes under server-derived ownership", async () => {
    const current = fixture();
    const {id,revision,createdAt,updatedAt,...definition} = current.policySet;
    await current.get("/api/tool-policies").expect(200).expect({items:[current.policySet]});
    await current.get("/api/tool-policies/options").expect(200).expect({groups:[]});
    await current.mutate("post","/api/tool-policies").send(definition).expect(201);
    expect(current.policySets.create).toHaveBeenCalledWith(scope,definition);
    await current.mutate("post","/api/tool-policies").send({...definition,principalId:"foreign"}).expect(400);
    await current.get(`/api/tool-policies/${id}`).expect(200);
    await current.mutate("patch",`/api/tool-policies/${id}`).send({...definition,expectedRevision:0}).expect(200);
    const selection = {target:{kind:"account"},selection:{kind:"policy_set",policySetId:id},expectedRevision:0};
    await current.mutate("put","/api/tool-policy-selections").send(selection).expect(200);
    expect(current.policySets.updateSelection).toHaveBeenCalledWith(scope,selection);
    await current.mutate("post","/api/tool-policies/resolve").send({targetId:target.id}).expect(200);
    await current.mutate("delete",`/api/tool-policies/${id}`).send({expectedRevision:1}).expect(200).expect({deleted:true});
  });
  it("normalizes CRUD, options, and resolution envelopes", async () => {
    const current = fixture();
    await current.get("/api/agents?pageSize=10").expect(200);
    await current
      .mutate("post", "/api/agents/options")
      .send({ workspaceId })
      .expect(200)
      .expect(({ body }) => expect(body.kind).toBe("targets"));
    await current
      .mutate("post", "/api/agents/options")
      .send({ workspaceId, overrides: [] })
      .expect(400);
    await current
      .mutate("post", "/api/agents")
      .send({
        name: "Reviewer",
        authoringContext: { workspaceId, targetId: target.id },
        backendOverrides: [],
      })
      .expect(201)
      .expect(({ body }) => expect(body.agent.id).toBe(agentId));
    await current.get(`/api/agents/${agentId}`).expect(200);
    await current
      .mutate("patch", `/api/agents/${agentId}`)
      .send({ expectedRevision: 0, name: "Senior Reviewer" })
      .expect(200)
      .expect(({ body }) => expect(body.agent.revision).toBe(1));
    await current
      .mutate("post", `/api/agents/${agentId}/resolve`)
      .send({ workspaceId })
      .expect(200)
      .expect(({ body }) => expect(body.candidates).toHaveLength(1));
    await current
      .mutate("delete", `/api/agents/${agentId}`)
      .send({ expectedRevision: 1 })
      .expect(200)
      .expect({ deleted: true, agentId });
  });

  it("accepts only the discriminated create request and hands off publication", async () => {
    const current = fixture();
    await current
      .mutate("post", "/api/threads")
      .send({ workspaceId, targetId: target.id, title: "Old shape" })
      .expect(400);
    expect(current.savedAgents.createThread).not.toHaveBeenCalled();

    await current
      .mutate("post", "/api/threads")
      .send({
        workspaceId,
        title: "New thread",
        configuration: { kind: "custom", targetId: target.id },
        executionWorkspace: { kind: "direct" },
      })
      .expect(201)
      .expect({ threadId, workspaceId, targetId: target.id });
    expect(current.savedAgents.createThread).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        configuration: { kind: "custom", targetId: target.id },
        executionWorkspace: { kind: "direct" },
      }),
      { kind: "http_ui" },
    );
    expect(current.handoffThreadChange).toHaveBeenCalledWith(scope, threadId);
  });

  it("derives a same-settings child from only the scoped source thread", async () => {
    const current = fixture();
    const mutationId = "50000000-0000-4000-8000-000000000001";
    await current
      .mutate("post", `/api/threads/${threadId}/configuration-copies`)
      .send({
        title: "New thread",
        mutationId,
        targetId: "browser-selected-target",
      })
      .expect(400);
    expect(current.savedAgents.createThreadFromSettings).not.toHaveBeenCalled();

    await current
      .mutate("post", `/api/threads/${threadId}/configuration-copies`)
      .send({ title: "New thread", mutationId })
      .expect(201)
      .expect({ threadId: copiedThreadId, workspaceId, targetId: target.id });
    expect(current.savedAgents.createThreadFromSettings).toHaveBeenCalledWith(
      scope,
      threadId,
      { title: "New thread", mutationId },
    );
  });
});
