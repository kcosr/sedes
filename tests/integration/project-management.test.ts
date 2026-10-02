import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { WorkpadRepository } from "../../src/server/db/repositories/workpad-repository.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { InventoryRepository, ProjectRemovalBlockedError, type InventoryWorkspaceRecord } from "../../src/server/db/repositories/inventory-repository.js";
import { TerminalServiceError } from "../../src/server/terminals/terminal-service-error.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { ProjectManagementService } from "../../src/server/application/project-management-service.js";
import { WorkspaceApplicationService } from "../../src/server/application/workspace-application-service.js";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { ApplicationSnapshotService } from "../../src/server/application/application-snapshot-service.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { ThreadRuntimeNotIdleError, ThreadRuntimeRetirementUnprovenError, type ThreadRuntimeObservation } from "../../src/server/events/thread-runtime-coordinator.js";
import { AgentToolEnvironmentAuthorityResolver, createTrustedEnvironmentAuthorityGrant } from "../../src/server/agent-tools/environment/environment-authority.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../../src/server/agent-tools/registry/canonical-agent-tool-manifest.js";
import path from "node:path";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));

type Retirement = import("../../src/server/application/project-management-service.js").WorkspaceRetirement["runWithWorkspaceRetired"];
type RuntimeRetirement = import("../../src/server/domain/thread-runtime-archive-retirement.js").ArchivedThreadRuntimeRetirement["runWithRuntimeRetired"];
type RuntimeCommit = import("../../src/server/events/thread-runtime-coordinator.js").ThreadRuntimeCoordinator["commitWithRuntimesObserved"];

function fixture() {
  const { database, scope } = savedAgentDatabase();
  cleanups.push(() => database.close());
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    environmentId: environment.id, canonicalPath: "/tmp/project-management", displayName: "Project",
    project: { kind: "new", name: "Project" },
    available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 200,
  });
  const bindings = new ConversationBindingRepository(database);
  const profile = database.prepare("SELECT id FROM agent_connection_profiles WHERE enabled = 1").get() as {id:string};
  const createIn = (workspaceId: string) => bindings.createUnboundThread(scope, { workspaceId, connectionProfileId: profile.id, title: "Retained thread", initialText: "Keep this draft", now: 300 });
  const create = () => createIn(workspace.id);
  const thread = create();
  bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: "retained-native-history", now: 400 });
  const runWithRuntimeRetired = vi.fn(async <T>(_scope: typeof scope, _id: string, operation: () => Promise<T>) => operation());
  const runWithWorkspaceRetired = vi.fn(async <T>(_scope: typeof scope, _id: string, operation: () => Promise<T>) => operation());
  const runWithTerminalsRetired = vi.fn(async <T>(_scope: typeof scope, _id: string, operation: () => Promise<T>) => operation());
  // Loaded runtimes by thread; a test sets one to make it busy or establishing.
  const runtimeStates = new Map<string, ThreadRuntimeObservation>();
  const observeRuntimes = vi.fn((_scope: typeof scope, threadIds: readonly string[]): ReadonlyMap<string, ThreadRuntimeObservation> =>
    new Map(threadIds.flatMap((id) => runtimeStates.has(id) ? [[id, runtimeStates.get(id)!] as const] : [])));
  const commitWithRuntimesObserved = vi.fn(async <T>(eventScope: typeof scope, threadIds: readonly string[], commit: (runtimes: ReadonlyMap<string, ThreadRuntimeObservation>) => T) =>
    commit(observeRuntimes(eventScope, threadIds)));
  const handoffAuthoritativeReplacement = vi.fn();
  const scheduleThreadPublications = vi.fn();
  // Validation echoes the requested directory unless a test makes it resolve elsewhere.
  const resolvesTo = new Map<string, string>();
  const validateWorkspace = vi.fn(async (_scope: typeof scope, environmentId: string, requested: string) => {
    const canonicalPath = resolvesTo.get(requested) ?? requested;
    return { canonicalPath, authorityRevision: environment.configurationRevision,
      summary: {id:randomUUID(), environmentId, displayName:path.basename(canonicalPath), displayPath:canonicalPath, availability:"available" as const, trustState:"trusted" as const, revision:0} };
  });
  const open = new WorkspaceApplicationService({inventory, execution: {validateWorkspace}, publications: {handoffAuthoritativeReplacement} });
  const service = new ProjectManagementService({ inventory,
    runtimes: {runWithRuntimeRetired: runWithRuntimeRetired as RuntimeRetirement, releaseProviderResidency: async () => undefined, observeRuntimes, commitWithRuntimesObserved: commitWithRuntimesObserved as RuntimeCommit},
    files: {runWithWorkspaceRetired: runWithWorkspaceRetired as Retirement},
    terminals: {runWithWorkspaceRetired: runWithTerminalsRetired as Retirement},
    locations: open, publications: {handoffAuthoritativeReplacement}, threads: {scheduleMany: scheduleThreadPublications},
    workpads: {publishWorkpadChange: async () => undefined} });
  const remove = () => service.removeLocation(scope, workspace.id, { expectedRevision: inventory.getWorkspace(scope, workspace.id).revision });
  const location = (canonicalPath: string, project: import("../../src/server/db/repositories/inventory-repository.js").InventoryProjectAssignment = { kind: "new", name: path.basename(canonicalPath) }) =>
    inventory.upsertWorkspace(scope, { environmentId: environment.id, canonicalPath, displayName: path.basename(canonicalPath), project,
      available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 250 });
  const project = (projectId: string) => inventory.getProject(scope, projectId);
  const queue = new QueuedInputRepository(database);
  const summaries = new DatabaseApplicationThreadSummaryReader({ inventory, queue, completion: new SubmissionCompletionRepository(database) });
  return {database,scope,inventory,environment,workspace,thread,bindings,create,createIn,service,remove,open,location,project,queue,summaries,resolvesTo,validateWorkspace,
    runWithRuntimeRetired,runWithWorkspaceRetired,runWithTerminalsRetired,runtimeStates,commitWithRuntimesObserved,handoffAuthoritativeReplacement,scheduleThreadPublications};
}

const newProject = { kind: "new", name: "Project" } as const;

describe("project registration lifecycle", () => {
  it("removes from inventory without changing thread state, draft, or native binding; re-add restores the identity", async () => {
    const f = fixture();
    const before = f.inventory.getThread(f.scope, f.thread.id);
    const binding = f.bindings.getBinding(f.scope, f.thread.id);
    expect(f.summaries.list(f.scope, f.environment.id)).toHaveLength(1);
    const removed = await f.remove();
    expect(removed).toMatchObject({id:f.workspace.projectId, removed:false, locations:[{id:f.workspace.id, removed:true, removedWithProject:false, threadCount:1, revision:1}]});
    expect(f.inventory.listWorkspaces(f.scope)).toEqual([]);
    expect(f.summaries.list(f.scope, f.environment.id)).toEqual([]);
    expect(f.summaries.listByIds(f.scope, [f.thread.id])).toEqual([]);
    expect(f.inventory.countThreadsByInventoryState(f.scope).active).toBe(0);
    expect(f.inventory.getThread(f.scope, f.thread.id)).toEqual(before);
    expect(f.bindings.getBinding(f.scope, f.thread.id)).toEqual(binding);
    expect(f.handoffAuthoritativeReplacement).toHaveBeenCalledOnce();
    const restored = await f.open.openWorkspace(f.scope, {environmentId:f.environment.id,path:f.workspace.canonicalPath,project:newProject});
    expect(restored.workspaceId).toBe(f.workspace.id);
    expect(f.inventory.listWorkspaces(f.scope)).toHaveLength(1);
    expect(f.summaries.list(f.scope, f.environment.id)).toHaveLength(1);
    expect(f.inventory.getThread(f.scope, f.thread.id)).toEqual(before);
    const again = await f.open.openWorkspace(f.scope, {environmentId:f.environment.id,path:f.workspace.canonicalPath,project:newProject});
    expect(again.workspaceId).toBe(f.workspace.id);
    expect(f.inventory.listProjects(f.scope)).toHaveLength(1);
  });

  it("keeps removed projects removed during background revalidation and prevents new work", async () => {
    const f = fixture();
    await f.remove();
    expect(() => f.inventory.upsertWorkspace(f.scope, {...f.workspace, available:true, now:500})).toThrow(/removed/);
    expect(() => f.create()).toThrow(/removed/);
    expect(() => f.queue.enqueue(f.scope, f.thread.id, {mutationId:randomUUID(), text:"Hidden work",contextExcerpts:[], attachmentIds:[],taskReferences:[],source:{kind:"agent_control",expectedThreadRevision:f.inventory.getThread(f.scope,f.thread.id).thread.revision,initiatingAgentThreadId:f.thread.id},now:600})).toThrow(/removed/);
    expect(f.inventory.isWorkspaceRemoved(f.scope, f.workspace.id)).toBe(true);
  });

  it("rejects stale revisions and cross-principal access, and permits safe offline removal", async () => {
    const f = fixture();
    await expect(f.service.removeLocation(f.scope,f.workspace.id,{expectedRevision:42})).rejects.toMatchObject({code:"conflict"});
    const stranger={...f.scope,principalId:"another-principal"};
    expect(f.service.list(stranger).projects).toEqual([]);
    await expect(f.service.removeLocation(stranger,f.workspace.id,{expectedRevision:0})).rejects.toMatchObject({code:"not_found"});
    f.inventory.updateEnvironmentAvailability(f.scope,f.environment.id,{available:false,now:500});
    await expect(f.remove()).resolves.toMatchObject({locations:[{removed:true, available:false}]});
  });

  it("rejects running runtimes and membership changes before commit", async () => {
    const f=fixture();
    f.runWithRuntimeRetired.mockRejectedValueOnce(new ThreadRuntimeNotIdleError());
    await expect(f.remove()).rejects.toMatchObject({code:"invalid_transition"});
    expect(f.inventory.isWorkspaceRemoved(f.scope,f.workspace.id)).toBe(false);
    f.runWithWorkspaceRetired.mockImplementationOnce(async (_scope,_id,operation) => {f.create(); return operation();});
    await expect(f.remove()).rejects.toMatchObject({code:"conflict"});
    expect(f.inventory.isWorkspaceRemoved(f.scope,f.workspace.id)).toBe(false);
  });

  it("requires schedules to be paused and never resumes them when restoring", async () => {
    const f=fixture();
    const automations=new AutomationRepository(f.database);
    const definition=automations.createDefinition(f.scope,{anchorThreadId:f.thread.id,name:"Periodic",prompt:"Check",precheck:null,runMode:"same_thread",enabled:true,schedule:{kind:"date_time",runAt:10000},misfirePolicy:"coalesce",nextRunAt:10000,now:500});
    await expect(f.remove()).rejects.toThrow(/Pause scheduled/);
    automations.pauseDefinition(f.scope,definition.id,{expectedRevision:definition.revision,now:600});
    await f.remove();
    expect(()=>automations.enableDefinition(f.scope,definition.id,{expectedRevision:1,nextRunAt:10000,now:700})).toThrow(/removed/);
    await f.open.openWorkspace(f.scope,{environmentId:f.environment.id,path:f.workspace.canonicalPath,project:newProject});
    expect(automations.getDefinition(f.scope,definition.id).enabled).toBe(false);
  });

  it.each(["project", "thread"] as const)("retains saved %s work while rejecting new records and moves into removed projects", async kind => {
    const f=fixture();
    const tasks=new TaskRepository(f.database);
    const pads=new WorkpadRepository(f.database);
    const target=kind === "project" ? {kind,projectId:f.workspace.projectId} : {kind,threadId:f.thread.id};
    const task=tasks.create(f.scope,{scope:target,title:"Retain task",mutationId:randomUUID(),now:500});
    const pad=pads.create(f.scope,{scope:target,title:"Retain pad",content:"Notes"});
    const globalTask=tasks.create(f.scope,{scope:{kind:"global"},title:"Global task",mutationId:randomUUID(),now:500});
    const globalPad=pads.create(f.scope,{scope:{kind:"global"},title:"Global pad"});
    await f.remove();
    if (kind === "project") {
      // Removing a project's last location leaves the project and its saved work active.
      const added=tasks.create(f.scope,{scope:target,title:"Still active",mutationId:randomUUID(),now:550});
      tasks.remove(f.scope,added.id);
      const current=f.project(f.workspace.projectId);
      await f.service.removeProject(f.scope,f.workspace.projectId,{expectedRevision:current.revision,expectedMembershipRevision:current.membershipRevision});
    }
    expect(tasks.get(f.scope,task.id).title).toBe("Retain task");
    expect(pads.get(f.scope,pad.id).content).toBe("Notes");
    // A removed project is not found as a destination; the commit-time guard backs both.
    const rejected=kind === "project" ? /not found/ : /removed/;
    expect(()=>tasks.create(f.scope,{scope:target,title:"Hidden task",mutationId:randomUUID(),now:600})).toThrow(rejected);
    expect(()=>pads.create(f.scope,{scope:target,title:"Hidden pad"})).toThrow(rejected);
    expect(()=>tasks.move(f.scope,globalTask.id,{scope:target,expectedRevision:globalTask.revision,mutationId:randomUUID(),now:600})).toThrow(rejected);
    expect(()=>pads.update(f.scope,globalPad.id,{scope:target,expectedRevision:globalPad.revision})).toThrow(rejected);
    const updatedTask=tasks.update(f.scope,task.id,{scope:target,title:"Updated retained task",expectedRevision:task.revision,mutationId:randomUUID(),now:600});
    const updatedPad=pads.update(f.scope,pad.id,{scope:target,title:"Updated retained pad",expectedRevision:pad.revision});
    expect(tasks.move(f.scope,task.id,{scope:{kind:"global"},expectedRevision:updatedTask.revision,mutationId:randomUUID(),now:700}).scopeKind).toBe("global");
    expect(pads.update(f.scope,pad.id,{scope:{kind:"global"},expectedRevision:updatedPad.revision}).scope).toEqual({kind:"global"});
  });

  it("captures active projects, including empty ones, and each location's project in the application snapshot", async () => {
    const f=fixture();
    const location=(canonicalPath:string,name:string,now:number)=>f.inventory.upsertWorkspace(f.scope,{environmentId:f.environment.id,canonicalPath,displayName:name,
      project:{kind:"new",name},available:true,trustState:"trusted",environmentConfigurationRevision:f.environment.configurationRevision,now});
    const emptied=location("/tmp/project-management-emptied","Emptied",500);
    f.inventory.removeWorkspace(f.scope,emptied.id,{expectedRevision:emptied.revision,expectedThreadIds:[],now:510});
    const removed=location("/tmp/project-management-removed","Removed",520);
    const removedProject=f.inventory.getProject(f.scope,removed.projectId);
    const inspection=f.inventory.inspectProjectRemoval(f.scope,removed.projectId,{expectedRevision:removedProject.revision,expectedMembershipRevision:removedProject.membershipRevision});
    f.inventory.removeProject(f.scope,removed.projectId,{expectedRevision:removedProject.revision,expectedMembershipRevision:removedProject.membershipRevision,expectedLocations:inspection.locations,now:530});
    const [summary]=f.summaries.list(f.scope,f.environment.id);
    const snapshot=await new ApplicationSnapshotService(f.inventory,f.summaries,{captureLoadedState:async()=>undefined},
      {read:async()=>({executionTargets:[{id:summary!.targetId,environmentId:f.environment.id,label:{text:"Target"},backend:summary!.backend,workspaceExecution:{kind:"direct_only"},available:true}],defaultTargetId:null}),requireSelectable:async()=>undefined},
      {list:()=>({forkOrigins:[],lineagePlacements:[],lineageFamilies:[]})},
      {listAssociated:()=>[],listAssociatedByThread:()=>[],findAssociated:()=>undefined},
      {list:()=>[]},()=>"unavailable",{summariesByThread:()=>new Map()}).capture(f.scope);
    expect(snapshot.projects).toEqual([
      {id:emptied.projectId,name:"Emptied",revision:f.inventory.getProject(f.scope,emptied.projectId).revision},
      {id:f.workspace.projectId,name:"Project",revision:f.inventory.getProject(f.scope,f.workspace.projectId).revision},
    ]);
    expect(snapshot.workspaces).toEqual([expect.objectContaining({id:f.workspace.id,projectId:f.workspace.projectId})]);
  });

  it("blocks queued work without mutating it", async () => {
    const f=fixture();
    const item=f.queue.enqueue(f.scope,f.thread.id,{mutationId:randomUUID(),text:"Queued",contextExcerpts:[],attachmentIds:[],taskReferences:[],source:{kind:"agent_control",expectedThreadRevision:f.inventory.getThread(f.scope,f.thread.id).thread.revision,initiatingAgentThreadId:f.thread.id},now:500});
    await expect(f.remove()).rejects.toThrow(/queued/);
    expect(f.queue.get(f.scope,f.thread.id,item.item.id).state).toBe("pending");
    expect(f.inventory.isWorkspaceRemoved(f.scope,f.workspace.id)).toBe(false);
  });
});

describe("workspace.open for agents", () => {
  function agentFixture() {
    const f=fixture();
    const grant=createTrustedEnvironmentAuthorityGrant({
      canonicalInputDigest:"input",authorityDigest:"authority",targetEnvironmentIds:[f.environment.id],
      resolvedResourceRefs:[{kind:"environment",id:f.environment.id,environmentId:f.environment.id}],
      display:{targetEnvironmentLabels:[],resourceLabels:[]},tool:{id:"workspace.open",schemaVersion:3},callerKind:"thread_agent",
      defaults:{kind:"thread_agent",environmentId:f.environment.id,workspaceId:f.workspace.id,projectId:f.workspace.projectId,threadId:f.thread.id},
      policyIdentity:{ownerKind:"thread",ownerId:f.thread.id,revision:1},admittedEnvironmentIds:[f.environment.id]});
    return {...f,open:(canonicalPath:string)=>f.open.openWorkspaceForAgent(f.scope,{environmentId:f.environment.id,path:canonicalPath},grant)};
  }

  it("gives a new directory its own project and keeps a known directory's project", async () => {
    const f=agentFixture();
    const opened=await f.open("/tmp/agent-opened");
    expect(opened).toMatchObject({environmentId:f.environment.id,label:"agent-opened",availability:"available"});
    expect(opened.projectId).not.toBe(f.workspace.projectId);
    expect(f.inventory.getProject(f.scope,opened.projectId)).toMatchObject({name:"agent-opened",locations:[expect.objectContaining({id:opened.workspaceId})]});
    await expect(f.open(f.workspace.canonicalPath)).resolves.toMatchObject({workspaceId:f.workspace.id,projectId:f.workspace.projectId});
    await expect(f.open("/tmp/agent-opened")).resolves.toEqual(opened);
  });

  it("restores a removed location only while its project is active", async () => {
    const f=agentFixture();
    const opened=await f.open("/tmp/agent-restored");
    const current=f.inventory.getWorkspace(f.scope,opened.workspaceId);
    f.inventory.removeWorkspace(f.scope,opened.workspaceId,{expectedRevision:current.revision,expectedThreadIds:[],now:600});
    await expect(f.open("/tmp/agent-restored")).resolves.toMatchObject({workspaceId:opened.workspaceId,projectId:opened.projectId});

    const project=f.inventory.getProject(f.scope,opened.projectId);
    const inspection=f.inventory.inspectProjectRemoval(f.scope,opened.projectId,{expectedRevision:project.revision,expectedMembershipRevision:project.membershipRevision});
    f.inventory.removeProject(f.scope,opened.projectId,{expectedRevision:project.revision,expectedMembershipRevision:project.membershipRevision,expectedLocations:inspection.locations,now:700});
    // Agents cannot restore projects; the tool maps this to a conflict.
    await expect(f.open("/tmp/agent-restored")).rejects.toMatchObject({code:"invalid_transition"});
    expect(f.inventory.isWorkspaceRemoved(f.scope,opened.workspaceId)).toBe(true);
    expect(f.inventory.getProject(f.scope,opened.projectId).removedAt).not.toBeNull();
  });
});

describe("workspace.open@3 with a project", () => {
  function projectFixture() {
    const f=fixture();
    const reader=new DatabaseAgentToolSourceAuthority(f.database,new Uint8Array(32).fill(7));
    const open=new WorkspaceApplicationService({inventory:f.inventory,execution:{validateWorkspace:f.validateWorkspace},
      publications:{handoffAuthoritativeReplacement:f.handoffAuthoritativeReplacement},projectAuthority:reader});
    const tool=CANONICAL_AGENT_TOOL_MANIFEST["workspace.open"];
    const defaults={kind:"thread_agent" as const,environmentId:f.environment.id,workspaceId:f.workspace.id,projectId:f.workspace.projectId,threadId:f.thread.id};
    const policyIdentity={ownerKind:"thread" as const,ownerId:f.thread.id,revision:1};
    /** Admits like a thread agent whose request needs no approval, then runs it. */
    const admit=(input:{readonly environmentId:string;readonly path:string;readonly projectId?:string})=>{
      const resolved=new AgentToolEnvironmentAuthorityResolver(reader).resolve({tool,input,scope:f.scope,defaults});
      return createTrustedEnvironmentAuthorityGrant({...resolved,tool,callerKind:"thread_agent",defaults,policyIdentity,
        admittedEnvironmentIds:[f.environment.id,...resolved.targetEnvironmentIds]});
    };
    const openIn=(path:string,projectId?:string)=>{
      const input={environmentId:f.environment.id,path,...(projectId?{projectId}:{})};
      return open.openWorkspaceForAgent(f.scope,input,admit(input));
    };
    return {...f,reader,open,admit,openIn};
  }

  it("adds a new directory to an existing project the caller reaches", async () => {
    const f=projectFixture();
    const before=f.project(f.workspace.projectId);
    const opened=await f.openIn("/tmp/agent-joined",f.workspace.projectId);
    expect(opened).toMatchObject({projectId:f.workspace.projectId,label:"agent-joined"});
    expect(f.project(f.workspace.projectId)).toMatchObject({membershipRevision:before.membershipRevision+1});
    expect(f.project(f.workspace.projectId).locations.map(({id})=>id)).toContain(opened.workspaceId);
    // Selecting a known directory through its own project is not a move.
    await expect(f.openIn("/tmp/agent-joined",f.workspace.projectId)).resolves.toEqual(opened);
  });

  it("never moves a known directory and fails closed for removed projects and changed membership", async () => {
    const f=projectFixture();
    const other=await f.openIn("/tmp/agent-other");
    await expect(f.openIn(f.workspace.canonicalPath,other.projectId)).rejects.toMatchObject({code:"conflict"});
    expect(f.inventory.getWorkspace(f.scope,f.workspace.id).projectId).toBe(f.workspace.projectId);

    const otherProject=f.project(other.projectId);
    const otherLocation=f.inventory.getWorkspace(f.scope,other.workspaceId);
    f.inventory.removeWorkspace(f.scope,other.workspaceId,{expectedRevision:otherLocation.revision,expectedThreadIds:[],now:600});
    const emptied=f.project(other.projectId);
    const inspection=f.inventory.inspectProjectRemoval(f.scope,other.projectId,{expectedRevision:emptied.revision,expectedMembershipRevision:emptied.membershipRevision});
    f.inventory.removeProject(f.scope,other.projectId,{expectedRevision:emptied.revision,expectedMembershipRevision:emptied.membershipRevision,expectedLocations:inspection.locations,now:610});
    expect(otherProject.membershipRevision).toBeLessThan(emptied.membershipRevision);
    // A removed project is not found, so an agent can neither join nor restore it.
    expect(()=>f.admit({environmentId:f.environment.id,path:"/tmp/agent-late",projectId:other.projectId})).toThrow(expect.objectContaining({code:"not_found"}));

    // Admission binds the membership revision; a location edit before the commit denies the request.
    const input={environmentId:f.environment.id,path:"/tmp/agent-raced",projectId:f.workspace.projectId};
    const grant=f.admit(input);
    f.location("/tmp/agent-raced-sibling",{kind:"existing",projectId:f.workspace.projectId});
    await expect(f.open.openWorkspaceForAgent(f.scope,input,grant)).rejects.toMatchObject({code:"permission_denied"});
    expect(f.inventory.listWorkspaces(f.scope).map(({canonicalPath})=>canonicalPath)).not.toContain("/tmp/agent-raced");
  });
});

describe("project and location management", () => {
  type Fixture = ReturnType<typeof fixture>;
  const expected = (f: Fixture, projectId: string) => {
    const current = f.project(projectId);
    return { expectedRevision: current.revision, expectedMembershipRevision: current.membershipRevision };
  };
  const terminal = (f: Fixture, workspace: InventoryWorkspaceRecord, threadId: string) => f.database.prepare(`INSERT INTO terminals(
      tenant_id, owner_principal_id, terminal_id, thread_id, workspace_id, environment_id, environment_label,
      display_name, initial_cwd, lifecycle, lifecycle_revision, rows, columns, initial_rows, initial_columns,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'Local', 'Shell', ?, 'running', 1, 24, 80, 24, 80, 1, 1)`)
    .run(f.scope.tenantId, f.scope.principalId, randomUUID(), threadId, workspace.id, workspace.environmentId, workspace.canonicalPath);
  const enqueue = (f: Fixture, threadId: string) => f.queue.enqueue(f.scope, threadId, {mutationId:randomUUID(),text:"Queued",contextExcerpts:[],attachmentIds:[],taskReferences:[],
    source:{kind:"agent_control",expectedThreadRevision:f.inventory.getThread(f.scope,threadId).thread.revision,initiatingAgentThreadId:threadId},now:500});
  /** A project with the fixture location and a second one, each with a thread. */
  const twoLocations = (f: Fixture) => {
    const second = f.location("/tmp/project-management-second", { kind: "existing", projectId: f.workspace.projectId });
    const secondThread = f.createIn(second.id);
    return { second, secondThread, threadOf: new Map([[f.workspace.id, f.thread.id], [second.id, secondThread.id]]) };
  };

  it("removes a project after fencing every active location in id order, with every fence held at commit", async () => {
    const f = fixture();
    const { second, threadOf } = twoLocations(f);
    const earlier = f.location("/tmp/project-management-earlier", { kind: "existing", projectId: f.workspace.projectId });
    f.inventory.removeWorkspace(f.scope, earlier.id, { expectedRevision: earlier.revision, expectedThreadIds: [], now: 260 });
    const events: string[] = [];
    let held = 0;
    let heldAtCommit = -1;
    const track = (kind: string) => async <T>(_scope: unknown, id: string, operation: () => Promise<T>) => {
      events.push(`${kind}:${id}`);
      held += 1;
      try { return await operation(); } finally { held -= 1; }
    };
    f.runWithTerminalsRetired.mockImplementation(track("terminals"));
    f.runWithRuntimeRetired.mockImplementation(track("runtime"));
    f.runWithWorkspaceRetired.mockImplementation(track("files"));
    const commit = f.inventory.removeProject.bind(f.inventory);
    vi.spyOn(f.inventory, "removeProject").mockImplementation((...args) => {
      heldAtCommit = held;
      events.push("commit");
      return commit(...args);
    });

    const removed = await f.service.removeProject(f.scope, f.workspace.projectId, expected(f, f.workspace.projectId));
    const [first, last] = [f.workspace.id, second.id].sort();
    expect(events).toEqual([
      `terminals:${first}`, `runtime:${threadOf.get(first!)}`, `files:${first}`,
      `terminals:${last}`, `runtime:${threadOf.get(last!)}`, `files:${last}`,
      "commit",
    ]);
    expect(heldAtCommit).toBe(6);
    expect(removed).toMatchObject({ id: f.workspace.projectId, removed: true });
    expect(Object.fromEntries(removed.locations.map(({ id, removed: gone, removedWithProject }) => [id, [gone, removedWithProject]])))
      .toEqual({ [f.workspace.id]: [true, true], [second.id]: [true, true], [earlier.id]: [true, false] });
    expect(f.handoffAuthoritativeReplacement).toHaveBeenCalledOnce();
    expect(f.inventory.listWorkspaces(f.scope)).toEqual([]);
  });

  it("rejects stale revisions and reports every blocker across locations before fencing", async () => {
    const f = fixture();
    const { second, secondThread } = twoLocations(f);
    const current = expected(f, f.workspace.projectId);
    await expect(f.service.removeProject(f.scope, f.workspace.projectId, { ...current, expectedRevision: current.expectedRevision + 1 }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(f.service.removeProject(f.scope, f.workspace.projectId, { ...current, expectedMembershipRevision: current.expectedMembershipRevision - 1 }))
      .rejects.toMatchObject({ code: "conflict" });

    enqueue(f, f.thread.id);
    terminal(f, second, secondThread.id);
    const blocked = f.service.removeProject(f.scope, f.workspace.projectId, current);
    await expect(blocked).rejects.toBeInstanceOf(ProjectRemovalBlockedError);
    await expect(blocked).rejects.toMatchObject({
      code: "invalid_transition",
      blockers: expect.arrayContaining([
        { workspaceId: f.workspace.id, environmentId: f.environment.id, kind: "durable_work", threadIds: [f.thread.id] },
        { workspaceId: second.id, environmentId: f.environment.id, kind: "live_terminal", threadIds: [secondThread.id] },
      ]),
    });
    expect(f.runWithTerminalsRetired).not.toHaveBeenCalled();
    expect(f.project(f.workspace.projectId).removedAt).toBeNull();
  });

  it("reports busy runtimes of every location with the durable blockers, before fencing", async () => {
    const f = fixture();
    const { second, secondThread } = twoLocations(f);
    const idle = f.createIn(second.id);
    const establishing = f.createIn(second.id);
    enqueue(f, f.thread.id);
    f.runtimeStates.set(f.thread.id, { kind: "loaded", runState: "running", retirable: false });
    f.runtimeStates.set(secondThread.id, { kind: "loaded", runState: "idle", retirable: false });
    // An idle runtime is retired by removal, and an establishing one is cancelled.
    f.runtimeStates.set(idle.id, { kind: "loaded", runState: "idle", retirable: true });
    f.runtimeStates.set(establishing.id, { kind: "establishing" });

    const blocked = f.service.removeProject(f.scope, f.workspace.projectId, expected(f, f.workspace.projectId));
    const byLocation = {
      [f.workspace.id]: [
        { workspaceId: f.workspace.id, environmentId: f.environment.id, kind: "durable_work", threadIds: [f.thread.id] },
        { workspaceId: f.workspace.id, environmentId: f.environment.id, kind: "busy_runtime", threadIds: [f.thread.id] },
      ],
      [second.id]: [
        { workspaceId: second.id, environmentId: f.environment.id, kind: "busy_runtime", threadIds: [secondThread.id] },
      ],
    };
    await expect(blocked).rejects.toBeInstanceOf(ProjectRemovalBlockedError);
    await expect(blocked).rejects.toMatchObject({
      code: "invalid_transition",
      blockers: [f.workspace.id, second.id].sort().flatMap((id) => byLocation[id]!),
    });
    expect(f.runWithTerminalsRetired).not.toHaveBeenCalled();
    expect(f.runWithRuntimeRetired).not.toHaveBeenCalled();
    expect(f.project(f.workspace.projectId).removedAt).toBeNull();
  });

  it.each([
    ["a busy runtime", (f: Fixture, threadId: string) => f.runWithRuntimeRetired.mockImplementation(async (_scope, id, operation) => {
      if (id === threadId) throw new ThreadRuntimeNotIdleError();
      return operation();
    }), "invalid_transition"],
    ["a terminal fence conflict", (f: Fixture, _threadId: string, workspaceId: string) => f.runWithTerminalsRetired.mockImplementation(async (_scope, id, operation) => {
      if (id === workspaceId) throw new TerminalServiceError("conflict", "Terminal admission is already suspended for this project.", true);
      return operation();
    }), "conflict"],
  ] as const)("commits nothing when %s refuses a later location", async (_label, refuse, code) => {
    const f = fixture();
    const { second, threadOf } = twoLocations(f);
    const last = [f.workspace.id, second.id].sort()[1]!;
    refuse(f, threadOf.get(last)!, last);
    await expect(f.service.removeProject(f.scope, f.workspace.projectId, expected(f, f.workspace.projectId)))
      .rejects.toMatchObject({ code });
    expect(f.project(f.workspace.projectId)).toMatchObject({ removedAt: null });
    expect(f.inventory.listWorkspaces(f.scope)).toHaveLength(2);
    expect(f.handoffAuthoritativeReplacement).not.toHaveBeenCalled();
  });

  it("renames with a revision check and publishes the change", async () => {
    const f = fixture();
    const current = f.project(f.workspace.projectId);
    expect(() => f.service.rename(f.scope, current.id, { name: "Renamed", expectedRevision: current.revision + 1 }))
      .toThrow(expect.objectContaining({ code: "conflict" }));
    expect(f.service.rename(f.scope, current.id, { name: "Renamed", expectedRevision: current.revision }))
      .toMatchObject({ id: current.id, name: "Renamed", revision: current.revision + 1 });
    expect(f.handoffAuthoritativeReplacement).toHaveBeenCalledOnce();
  });

  it("restores the project, then each requested location under its own identity, reporting each result", async () => {
    const f = fixture();
    const { second } = twoLocations(f);
    const moved = f.location("/tmp/project-management-moved", { kind: "existing", projectId: f.workspace.projectId });
    await f.service.removeProject(f.scope, f.workspace.projectId, expected(f, f.workspace.projectId));
    const other = f.location("/tmp/project-management-other");
    const removed = f.project(f.workspace.projectId);
    await expect(f.service.restoreProject(f.scope, removed.id, { expectedRevision: removed.revision, locationIds: [other.id] }))
      .rejects.toMatchObject({ code: "bad_request" });
    await expect(f.service.restoreProject(f.scope, removed.id, { expectedRevision: removed.revision + 1, locationIds: [] }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(f.project(removed.id).removedAt).not.toBeNull();

    // This directory now resolves elsewhere, so its location cannot be restored.
    f.resolvesTo.set(moved.canonicalPath, "/tmp/project-management-renamed");
    f.handoffAuthoritativeReplacement.mockClear();
    const restored = await f.service.restoreProject(f.scope, removed.id, {
      expectedRevision: removed.revision, locationIds: [moved.id, f.workspace.id],
    });
    expect(restored.locations).toEqual([
      { id: moved.id, status: "failed", cause: expect.objectContaining({ code: "conflict" }) },
      { id: f.workspace.id, status: "restored" },
    ]);
    expect(restored.project).toMatchObject({ id: removed.id, removed: false });
    expect(Object.fromEntries(restored.project.locations.map(({ id, removed: gone, removedWithProject }) => [id, [gone, removedWithProject]])))
      .toEqual({ [f.workspace.id]: [false, false], [second.id]: [true, true], [moved.id]: [true, true] });
    expect(f.inventory.listWorkspaces(f.scope).map(({ id }) => id).sort()).toEqual([f.workspace.id, other.id].sort());
    expect(f.handoffAuthoritativeReplacement).toHaveBeenCalled();
    // A location restore never revives its removed project.
    await f.service.removeProject(f.scope, removed.id, expected(f, removed.id));
    await expect(f.open.restoreLocation(f.scope, f.workspace.id)).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("fails a location restore whose location moved to another project while validation was pending", async () => {
    const f = fixture();
    await f.service.removeProject(f.scope, f.workspace.projectId, expected(f, f.workspace.projectId));
    const other = f.location("/tmp/project-management-other");
    let finishValidation!: () => void;
    const validation = new Promise<void>((resolve) => { finishValidation = resolve; });
    const validate = f.validateWorkspace.getMockImplementation()!;
    f.validateWorkspace.mockImplementationOnce(async (...args) => {
      await validation;
      return validate(...args);
    });
    const removed = f.project(f.workspace.projectId);
    const restoring = f.service.restoreProject(f.scope, removed.id, {
      expectedRevision: removed.revision, locationIds: [f.workspace.id],
    });
    await vi.waitFor(() => expect(f.validateWorkspace).toHaveBeenCalledOnce());
    // Moving a removed location is allowed; it now belongs to the other project.
    f.inventory.moveWorkspaceToProject(f.scope, f.workspace.id, {
      target: { kind: "existing", projectId: other.projectId },
      expectedRevision: f.inventory.getWorkspace(f.scope, f.workspace.id).revision,
      expectedThreadIds: [f.thread.id], now: 600,
    });
    finishValidation();

    const restored = await restoring;
    expect(restored.locations).toEqual([
      { id: f.workspace.id, status: "failed", cause: expect.objectContaining({ code: "conflict" }) },
    ]);
    expect(restored.project).toMatchObject({ id: removed.id, removed: false, locations: [] });
    expect(f.inventory.getWorkspace(f.scope, f.workspace.id).projectId).toBe(other.projectId);
    expect(f.inventory.isWorkspaceRemoved(f.scope, f.workspace.id)).toBe(true);
  });

  it("moves a location only while its threads are idle and never retires their runtimes", async () => {
    const f = fixture();
    const move = (target: Parameters<Fixture["service"]["moveLocation"]>[2]["target"]) => f.service.moveLocation(f.scope, f.workspace.id, {
      target, expectedRevision: f.inventory.getWorkspace(f.scope, f.workspace.id).revision,
    });
    for (const runtime of [{ kind: "loaded", runState: "running", retirable: false }, { kind: "establishing" }] as const) {
      f.runtimeStates.set(f.thread.id, runtime);
      await expect(move({ kind: "new", name: "Split" })).rejects.toMatchObject({ code: "invalid_transition" });
    }
    f.runtimeStates.set(f.thread.id, { kind: "loaded", runState: "disconnected", retirable: false });
    f.commitWithRuntimesObserved.mockRejectedValueOnce(new ThreadRuntimeRetirementUnprovenError(new Error("close failed")));
    await expect(move({ kind: "new", name: "Split" })).rejects.toMatchObject({ code: "operation_outcome_uncertain" });
    expect(f.inventory.getWorkspace(f.scope, f.workspace.id).projectId).toBe(f.workspace.projectId);
    enqueue(f, f.thread.id);
    await expect(move({ kind: "new", name: "Split" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(f.inventory.getWorkspace(f.scope, f.workspace.id).projectId).toBe(f.workspace.projectId);
    await expect(f.service.moveLocation(f.scope, f.workspace.id, { target: { kind: "new", name: "Split" }, expectedRevision: 99 }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("moves an idle location with a live terminal and leaves the emptied project active", async () => {
    const f = fixture();
    terminal(f, f.workspace, f.thread.id);
    // An offline host's disconnected runtime does not block reorganizing it.
    f.runtimeStates.set(f.thread.id, { kind: "loaded", runState: "disconnected", retirable: false });
    const source = f.project(f.workspace.projectId);
    const destination = await f.service.moveLocation(f.scope, f.workspace.id, {
      target: { kind: "new", name: "Split" }, expectedRevision: f.workspace.revision,
    });
    expect(f.commitWithRuntimesObserved).toHaveBeenCalledWith(f.scope, [f.thread.id], expect.any(Function));
    expect(destination).toMatchObject({ name: "Split", removed: false, locations: [{ id: f.workspace.id, removed: false }] });
    expect(f.project(source.id)).toMatchObject({ removedAt: null, locations: [], membershipRevision: source.membershipRevision + 1 });
    expect(f.runWithRuntimeRetired).not.toHaveBeenCalled();
    expect(f.runWithTerminalsRetired).not.toHaveBeenCalled();
    expect(f.runWithWorkspaceRetired).not.toHaveBeenCalled();
    expect(f.handoffAuthoritativeReplacement).toHaveBeenCalledOnce();
    // Each thread's snapshot carries its project, so every moved thread is republished.
    expect(f.scheduleThreadPublications.mock.calls).toEqual([[f.scope, [f.thread.id]]]);

    await f.service.removeProject(f.scope, source.id, expected(f, source.id));
    await expect(f.service.moveLocation(f.scope, f.workspace.id, {
      target: { kind: "existing", projectId: source.id }, expectedRevision: f.inventory.getWorkspace(f.scope, f.workspace.id).revision,
    })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("merges only an idle project into an active one and deletes the source", async () => {
    const f = fixture();
    const target = f.location("/tmp/project-management-target");
    const targetThread = f.createIn(target.id);
    // A removed location of the source moves too, with its threads.
    const retired = f.location("/tmp/project-management-retired", { kind: "existing", projectId: f.workspace.projectId });
    const retiredThread = f.createIn(retired.id);
    f.inventory.removeWorkspace(f.scope, retired.id, { expectedRevision: retired.revision, expectedThreadIds: [retiredThread.id], now: 260 });
    const merge = () => f.service.merge(f.scope, f.workspace.projectId, {
      targetProjectId: target.projectId,
      expectedSourceMembershipRevision: f.project(f.workspace.projectId).membershipRevision,
      expectedTargetMembershipRevision: f.project(target.projectId).membershipRevision,
    });
    f.runtimeStates.set(f.thread.id, { kind: "loaded", runState: "waiting_for_input", retirable: false });
    await expect(merge()).rejects.toMatchObject({ code: "invalid_transition" });
    f.runtimeStates.set(f.thread.id, { kind: "loaded", runState: "idle", retirable: true });
    await expect(f.service.merge(f.scope, f.workspace.projectId, {
      targetProjectId: target.projectId, expectedSourceMembershipRevision: 99, expectedTargetMembershipRevision: 0,
    })).rejects.toMatchObject({ code: "conflict" });
    expect(f.scheduleThreadPublications).not.toHaveBeenCalled();
    const merged = await merge();
    expect(merged.id).toBe(target.projectId);
    expect(merged.locations.map(({ id }) => id).sort()).toEqual([f.workspace.id, target.id, retired.id].sort());
    expect(() => f.project(f.workspace.projectId)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(f.handoffAuthoritativeReplacement).toHaveBeenCalledOnce();
    expect(f.scheduleThreadPublications).toHaveBeenCalledOnce();
    const [publishedScope, published] = f.scheduleThreadPublications.mock.calls[0]!;
    expect(publishedScope).toBe(f.scope);
    expect([...published].sort()).toEqual([f.thread.id, retiredThread.id].sort());
    expect(published).not.toContain(targetThread.id);
  });
});
