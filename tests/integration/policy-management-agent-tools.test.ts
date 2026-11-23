import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { applicationSummaryFixture } from "../support/application-summary-fixture.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { AgentToolEnvironmentAuthorityResolver, createTrustedEnvironmentAuthorityGrant } from "../../src/server/agent-tools/environment/environment-authority.js";
import type { TrustedToolInvocationContext } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { PolicyManagementAgentToolService } from "../../src/server/agent-tools/tools/policy-management-agent-tool-service.js";
import { createPolicyManagementToolDefinitions, type PolicyManagementToolId } from "../../src/server/agent-tools/tools/policy-management-tools.js";
import { ToolPolicyService } from "../../src/server/tool-policies/tool-policy-service.js";
import { ToolPolicyRepository } from "../../src/server/db/repositories/tool-policy-repository.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { PrincipalAgentToolClientRepository } from "../../src/server/db/repositories/principal-agent-tool-client-repository.js";
import { ThreadTemplateRepository } from "../../src/server/db/repositories/thread-template-repository.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import { ConversationOperationRepository } from "../../src/server/db/repositories/conversation-operation-repository.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { ThreadMutationGateway } from "../../src/server/conversations/thread-mutation-gateway.js";
import { ThreadTemplateApplicationService } from "../../src/server/application/thread-template-application-service.js";
import type { AgentToolResourceScope } from "../../src/shared/protocol/conversation.js";
import type { ThreadTemplate } from "../../src/shared/protocol/thread-templates.js";

const databases: ReturnType<typeof applicationSummaryFixture>["database"][] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));
const restricted = { allowOtherEnvironments: false, allowOtherProjects: false };
const broad = { allowOtherEnvironments: true, allowOtherProjects: true };
const presentation = { surface: "native" as const, mode: "progressive" as const };

function fixture() {
  const f = applicationSummaryFixture(2);
  databases.push(f.database);
  const dependencies = createThreadAgentToolPolicyDependencies();
  const toolPolicies = new ThreadAgentToolPolicyRepository(f.database, dependencies.eligibility);
  const sourceId = f.ids[0]!;
  const targetThreadId = f.ids[1]!;
  const profile = f.database.prepare("SELECT id FROM agent_connection_profiles WHERE enabled=1").get() as { id: string };
  const policySets = new ToolPolicyService(new ToolPolicyRepository(f.database), undefined, dependencies.catalog, () => "pi");
  const agents = new SavedAgentRepository(f.database);
  const agent = agents.create(f.scope, {
    name: "Reviewer", description: "", backendTypeId: "pi", backendOverridesSchemaVersion: 1,
    backendOverrides: [], toolPolicySelection: { kind: "inherit" }, now: 1000,
  });
  const templateRepository = new ThreadTemplateRepository(f.database);
  let duringPreparation: (() => void) | undefined;
  const templates = new ThreadTemplateApplicationService({
    repository: templateRepository,
    savedAgents: {
      prepareThreadTemplateSelection: async (_scope, input) => {
        duringPreparation?.();
        return { ...input, capturedAgentName: "Reviewer", capturedWorkspaceName: "Workspace", capturedTargetName: "Pi", assertDurableFences: () => {} };
      },
    },
    now: () => 1000,
  });
  const authorityReader = new DatabaseAgentToolSourceAuthority(f.database, new Uint8Array(32).fill(1));
  const mutations = new ThreadMutationGateway({
    bindings: f.bindings, inventory: f.inventory,
    lifecycle: {} as never, forks: {} as never, queue: {} as never,
    operations: new ConversationOperationRepository(f.database), completions: f.completion,
    queueGateway: {} as never, runtimes: {} as never, actors: {} as never,
    interactions: {} as never, presentation: {} as never, agentToolPolicies: toolPolicies,
    actionPersistence: new Map(), publishThreadSnapshot: async () => {}, now: () => 1000,
  });
  const service = new PolicyManagementAgentToolService({
    policySets, templates, toolPolicies, authorityReader, mutations,
    principalToolClients: new PrincipalAgentToolClientRepository(f.database, { eligibleToolIds: new Set() }),
  });
  const definitions = createPolicyManagementToolDefinitions(service);
  const registry = new AgentToolRegistry();
  definitions.forEach(definition => registry.register(definition));
  const toolIds = [...definitions.map(definition => definition.id), "thread.status"];
  const setSource = (resourceScope: AgentToolResourceScope, enabledToolIds = toolIds) => toolPolicies.update(f.scope, sourceId, {
    expectedRevision: toolPolicies.getDurable(f.scope, sourceId).revision,
    enabled: true, enabledToolIds, resourceScope, presentation, now: 1000,
  });
  setSource(broad);
  const defaults = { kind: "thread_agent" as const, threadId: sourceId, workspaceId: f.workspace.id, projectId: f.workspace.projectId, environmentId: f.environment.id };
  const context = (id: PolicyManagementToolId, input: unknown): TrustedToolInvocationContext => {
    const definition = definitions.find(definition => definition.id === id)!;
    const policy = toolPolicies.getDurable(f.scope, sourceId);
    const policyIdentity = { ownerKind: "thread" as const, ownerId: sourceId, revision: policy.revision };
    const authority = new AgentToolEnvironmentAuthorityResolver(authorityReader).resolve({ tool: definition, input, scope: f.scope, defaults, resourceScope: policy.resourceScope });
    return {
      ...f.scope, invocationId: randomUUID(), mutationId: randomUUID(), requestId: randomUUID(), adapter: "mcp",
      subject: { kind: "thread_agent", sourceThreadId: sourceId, backendKind: "pi" }, defaults, policyIdentity,
      environmentAuthority: createTrustedEnvironmentAuthorityGrant({ ...authority, tool: { id: definition.id, schemaVersion: definition.schemaVersion }, callerKind: "thread_agent", defaults, resourceScope: policy.resourceScope, policyIdentity, admittedEnvironmentIds: [f.environment.id] }),
      effectiveCapabilities: [], hasCapability: () => false,
      abortSignal: new AbortController().signal, reportProgress: () => {},
    };
  };
  const invoke = async <T = any>(id: PolicyManagementToolId, input: unknown, override?: TrustedToolInvocationContext): Promise<T> => {
    const definition = definitions.find(definition => definition.id === id)!;
    expect(registry.validatesInput(id, 1, input)).toBe(true);
    const output = await definition.execute(input, override ?? context(id, input));
    expect(registry.validatesOutput(id, 1, output)).toBe(true);
    return output as T;
  };
  const createTemplate = async (name = "Template", workspaceId = f.workspace.id) => templates.create(f.scope, {
    name, workspaceId, targetId: profile.id, agentId: agent.id, executionWorkspace: { kind: "direct" },
    environmentVariables: { PRIVATE_VALUE: { kind: "literal", value: "must-stay-private" } },
    toolPolicySelection: { kind: "disabled" }, toolPresentation: presentation,
  });
  return { ...f, service, registry, definitions, toolPolicies, policySets, templates, templateRepository, agent, profile, sourceId, targetThreadId, context, invoke, setSource, createTemplate,
    duringPreparation: (callback: () => void) => { duringPreparation = callback; } };
}

describe("canonical policy and tool-settings management", () => {
  it("permits broad policy administration while preserving the caller snapshot and revision conflicts", async () => {
    const f = fixture();
    const before = f.toolPolicies.getDurable(f.scope, f.sourceId);
    const policy = { name: "Administrator-created", enabledToolIds: ["task.delete"], resourceScope: broad };
    const created = await f.invoke("tool_policy.create", policy);
    const id = created.policySet.id;
    expect((await f.invoke("tool_policy.options", {})).groups.flatMap((group: any) => group.tools).some((tool: any) => tool.id === "task.delete")).toBe(true);
    expect((await f.invoke("tool_policy.list", {})).items.map((item: any) => item.id)).toContain(id);
    expect(await f.invoke("tool_policy.get", { policySetId: id })).toMatchObject({ policySet: policy });
    await f.invoke("tool_policy.defaults.update", { target: { kind: "account" }, selection: { kind: "policy_set", policySetId: id }, expectedRevision: 0 });
    expect(await f.invoke("tool_policy.preview", { targetId: f.profile.id })).toMatchObject({ enabledToolIds: ["task.delete"], source: "account" });
    expect(f.toolPolicies.getDurable(f.scope, f.sourceId)).toEqual(before);
    const update = { policySetId: id, expectedRevision: 0, ...policy, name: "Updated" };
    await f.invoke("tool_policy.update", update);
    await expect(f.invoke("tool_policy.update", update)).rejects.toMatchObject({ code: "conflict" });
    await f.invoke("tool_policy.remove", { policySetId: id, expectedRevision: 1 });
    await expect(f.invoke("tool_policy.preview", { targetId: f.profile.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("reads an unset authorized default as inherit/revision 0 and denies missing, foreign and over-scoped targets", async () => {
    const f = fixture();
    f.setSource(restricted);
    const target = { kind: "backend", backendId: "pi-primary" };
    expect(await f.invoke("tool_policy.defaults.get", { target })).toEqual({ setting: { target, selection: { kind: "inherit" }, revision: 0 } });
    const request = { target: { kind: "environment", executionEnvironmentId: f.environment.id } };
    const admitted = f.context("tool_policy.defaults.get", request);
    await expect(f.invoke("tool_policy.defaults.get", { target: { kind: "backend", backendId: "missing" } })).rejects.toMatchObject({ code: "not_found" });
    await expect(f.invoke("tool_policy.defaults.get", request, { ...admitted, principalId: "foreign" })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(f.invoke("tool_policy.defaults.get", { target: { kind: "account" } })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(f.invoke("tool_policy.list", {})).rejects.toMatchObject({ code: "permission_denied" });
    await expect(f.invoke("tool_policy.defaults.get", request, { ...admitted, environmentAuthority: { ...admitted.environmentAuthority, admittedEnvironmentIds: [] } })).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("rejects disabled exact permissions and stale source grants before reading or mutating", async () => {
    const f = fixture();
    const context = f.context("tool_policy.create", { name: "Denied", enabledToolIds: [], resourceScope: restricted });
    f.setSource(broad, ["thread.status"]);
    await expect(f.invoke("tool_policy.create", { name: "Denied", enabledToolIds: [], resourceScope: restricted }, context)).rejects.toMatchObject({ code: "permission_denied" });
    expect(f.policySets.list(f.scope).items).toEqual([]);
  });

  it("updates a different thread through the normal gateway, caps grants, and reconciles lost replies by readback", async () => {
    const f = fixture();
    const request = { threadId: f.targetThreadId, mutationId: randomUUID(), expectedPolicyRevision: 0,
      enabled: true, enabledToolIds: ["thread.status"], presentation, resourceScope: restricted };
    await expect(f.invoke("thread.tool_settings.update", { ...request, threadId: f.sourceId })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(f.invoke("thread.tool_settings.update", { ...request, enabledToolIds: ["task.delete"] })).rejects.toMatchObject({ code: "invalid_transition" });
    const result = await f.invoke("thread.tool_settings.update", request);
    expect(result).toMatchObject({ mutationId: request.mutationId, revision: 1, enabledToolIds: ["thread.status"] });
    // A client that lost this result has no mutation receipt to replay.
    await expect(f.invoke("thread.tool_settings.update", request)).rejects.toMatchObject({ code: "conflict" });
    expect(await f.invoke("thread.tool_settings.get", { threadId: f.targetThreadId })).toMatchObject({ revision: 1, enabledToolIds: ["thread.status"] });
  });

  it("preserves and omits template variables, clears presentation, and caps inherited assignments", async () => {
    const f = fixture();
    const template = await f.createTemplate();
    expect(await f.invoke("thread_template.get", { templateId: template.id })).toEqual({ template: expect.not.objectContaining({ environmentVariables: expect.anything() }) });
    const request = { templateId: template.id, expectedRevision: 0, toolPresentation: null };
    const result = await f.invoke("thread_template.update", request);
    expect(result.template).not.toHaveProperty("toolPresentation");
    expect(result.template).not.toHaveProperty("environmentVariables");
    expect(f.templates.get(f.scope, template.id)).toMatchObject({ environmentVariables: template.environmentVariables, workspaceId: template.workspaceId, agentId: template.agentId });
    await expect(f.invoke("thread_template.update", request)).rejects.toMatchObject({ code: "conflict" });
    const policy = f.policySets.create(f.scope, { name: "Outside caller", enabledToolIds: ["task.delete"], resourceScope: broad });
    f.policySets.updateSelection(f.scope, { target: { kind: "account" }, selection: { kind: "policy_set", policySetId: policy.id }, expectedRevision: 0 });
    await expect(f.invoke("thread_template.update", { templateId: template.id, expectedRevision: 1, toolPolicySelection: { kind: "inherit" } })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(f.templates.get(f.scope, template.id).toolPolicySelection).toEqual({ kind: "disabled" });
    expect(f.registry.validatesInput("thread_template.update", 1, { ...request, environmentVariables: {} })).toBe(false);
  });

  it("filters template pages before producing cursors and denies direct access in another project", async () => {
    const f = fixture();
    const otherWorkspace = f.inventory.upsertWorkspace(f.scope, { environmentId: f.environment.id, canonicalPath: "/tmp/other-project", displayName: "Other", project: { kind: "new", name: "Other" }, available: true, trustState: "trusted", environmentConfigurationRevision: f.environment.configurationRevision, now: 500 });
    const first = await f.createTemplate("A visible");
    const hidden = await f.createTemplate("B hidden", otherWorkspace.id);
    const last = await f.createTemplate("C visible");
    f.setSource(restricted);
    const page = await f.invoke("thread_template.list", { pageSize: 1 });
    expect(page.items.map((item: ThreadTemplate) => item.id)).toEqual([first.id]);
    expect(JSON.stringify(page)).not.toContain("must-stay-private");
    expect(Buffer.from(page.nextCursor, "base64url").toString()).not.toContain("hidden");
    const next = await f.invoke("thread_template.list", { pageSize: 1, cursor: page.nextCursor });
    expect(next.items.map((item: ThreadTemplate) => item.id)).toEqual([last.id]);
    expect(next.nextCursor).toBeUndefined();
    await expect(f.invoke("thread_template.get", { templateId: hidden.id })).rejects.toMatchObject({ code: "permission_denied" });
    f.setSource(broad);
    await expect(f.invoke("thread_template.list", { pageSize: 1, cursor: page.nextCursor })).rejects.toMatchObject({ code: "cursor_invalid" });
  });

  it("rechecks source authority after asynchronous template preparation before committing", async () => {
    const f = fixture();
    const template = await f.createTemplate();
    f.duringPreparation(() => f.setSource(restricted, ["thread.status"]));
    await expect(f.invoke("thread_template.update", { templateId: template.id, expectedRevision: 0, toolPresentation: null })).rejects.toMatchObject({ code: "permission_denied" });
    expect(f.templates.get(f.scope, template.id)).toEqual(template);
  });
});
