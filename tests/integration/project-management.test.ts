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
import { ThreadRuntimeNotIdleError } from "../../src/server/events/thread-runtime-coordinator.js";
import type { ThreadRunState } from "../../src/shared/protocol/conversation.js";
import { createTrustedEnvironmentAuthorityGrant } from "../../src/server/agent-tools/environment/environment-authority.js";
import path from "node:path";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));

type Retirement = import("../../src/server/application/project-management-service.js").WorkspaceRetirement["runWithWorkspaceRetired"];
type RuntimeRetirement = import("../../src/server/domain/thread-runtime-archive-retirement.js").ArchivedThreadRuntimeRetirement["runWithRuntimeRetired"];

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
  const captureLoadedState = vi.fn(async (_scope: typeof scope, _threadId: string): Promise<{ readonly runState: ThreadRunState } | undefined> => undefined);
  const handoffAuthoritativeReplacement = vi.fn();
  // Validation echoes the requested directory unless a test makes it resolve elsewhere.
  const resolvesTo = new Map<string, string>();
  const validateWorkspace = vi.fn(async (_scope: typeof scope, environmentId: string, requested: string) => {
    const canonicalPath = resolvesTo.get(requested) ?? requested;
    return { canonicalPath, authorityRevision: environment.configurationRevision,
      summary: {id:randomUUID(), environmentId, displayName:path.basename(canonicalPath), displayPath:canonicalPath, availability:"available" as const, trustState:"trusted" as const, revision:0} };
  });
  const open = new WorkspaceApplicationService({inventory, execution: {validateWorkspace}, publications: {handoffAuthoritativeReplacement} });
  const service = new ProjectManagementService({ inventory,
    runtimes: {runWithRuntimeRetired: runWithRuntimeRetired as RuntimeRetirement, releaseProviderResidency: async () => undefined, captureLoadedState},
    files: {runWithWorkspaceRetired: runWithWorkspaceRetired as Retirement},
    terminals: {runWithWorkspaceRetired: runWithTerminalsRetired as Retirement},
    locations: open, publications: {handoffAuthoritativeReplacement} });
  const remove = () => service.removeLocation(scope, workspace.id, { expectedRevision: inventory.getWorkspace(scope, workspace.id).revision });
  const location = (canonicalPath: string, project: import("../../src/server/db/repositories/inventory-repository.js").InventoryProjectAssignment = { kind: "new", name: path.basename(canonicalPath) }) =>
    inventory.upsertWorkspace(scope, { environmentId: environment.id, canonicalPath, displayName: path.basename(canonicalPath), project,
      available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 250 });
  const project = (projectId: string) => inventory.getProject(scope, projectId);
  const queue = new QueuedInputRepository(database);
  const summaries = new DatabaseApplicationThreadSummaryReader({ inventory, queue, completion: new SubmissionCompletionRepository(database) });
  return {database,scope,inventory,environment,workspace,thread,bindings,create,createIn,service,remove,open,location,project,queue,summaries,resolvesTo,validateWorkspace,
    runWithRuntimeRetired,runWithWorkspaceRetired,runWithTerminalsRetired,captureLoadedState,handoffAuthoritativeReplacement};
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

  it.each(["workspace", "thread"] as const)("retains saved %s work while rejecting new records and moves into removed projects", async kind => {
    const f=fixture();
    const tasks=new TaskRepository(f.database);
    const pads=new WorkpadRepository(f.database);
    const target=kind === "workspace" ? {kind,workspaceId:f.workspace.id} : {kind,threadId:f.thread.id};
    const task=tasks.create(f.scope,{scope:target,title:"Retain task",mutationId:randomUUID(),now:500});
    const pad=pads.create(f.scope,{scope:target,title:"Retain pad",content:"Notes"});
    const globalTask=tasks.create(f.scope,{scope:{kind:"global"},title:"Global task",mutationId:randomUUID(),now:500});
    const globalPad=pads.create(f.scope,{scope:{kind:"global"},title:"Global pad"});
    await f.remove();
    expect(tasks.get(f.scope,task.id).title).toBe("Retain task");
    expect(pads.get(f.scope,pad.id).content).toBe("Notes");
    expect(()=>tasks.create(f.scope,{scope:target,title:"Hidden task",mutationId:randomUUID(),now:600})).toThrow(/removed/);
    expect(()=>pads.create(f.scope,{scope:target,title:"Hidden pad"})).toThrow(/removed/);
    expect(()=>tasks.move(f.scope,globalTask.id,{scope:target,expectedRevision:globalTask.revision,mutationId:randomUUID(),now:600})).toThrow(/removed/);
    expect(()=>pads.update(f.scope,globalPad.id,{scope:target,expectedRevision:globalPad.revision})).toThrow(/removed/);
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
      display:{targetEnvironmentLabels:[],resourceLabels:[]},tool:{id:"workspace.open",schemaVersion:2},callerKind:"thread_agent",
      defaults:{kind:"thread_agent",environmentId:f.environment.id,workspaceId:f.workspace.id,threadId:f.thread.id},
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

  it("moves a location only while its threads are idle and never retires their runtimes", async () => {
    const f = fixture();
    const move = (target: Parameters<Fixture["service"]["moveLocation"]>[2]["target"]) => f.service.moveLocation(f.scope, f.workspace.id, {
      target, expectedRevision: f.inventory.getWorkspace(f.scope, f.workspace.id).revision,
    });
    f.captureLoadedState.mockResolvedValueOnce({ runState: "running" });
    await expect(move({ kind: "new", name: "Split" })).rejects.toMatchObject({ code: "invalid_transition" });
    enqueue(f, f.thread.id);
    await expect(move({ kind: "new", name: "Split" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(f.inventory.getWorkspace(f.scope, f.workspace.id).projectId).toBe(f.workspace.projectId);
    await expect(f.service.moveLocation(f.scope, f.workspace.id, { target: { kind: "new", name: "Split" }, expectedRevision: 99 }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("moves an idle location with a live terminal and leaves the emptied project active", async () => {
    const f = fixture();
    terminal(f, f.workspace, f.thread.id);
    const source = f.project(f.workspace.projectId);
    const destination = await f.service.moveLocation(f.scope, f.workspace.id, {
      target: { kind: "new", name: "Split" }, expectedRevision: f.workspace.revision,
    });
    expect(destination).toMatchObject({ name: "Split", removed: false, locations: [{ id: f.workspace.id, removed: false }] });
    expect(f.project(source.id)).toMatchObject({ removedAt: null, locations: [], membershipRevision: source.membershipRevision + 1 });
    expect(f.runWithRuntimeRetired).not.toHaveBeenCalled();
    expect(f.runWithTerminalsRetired).not.toHaveBeenCalled();
    expect(f.runWithWorkspaceRetired).not.toHaveBeenCalled();
    expect(f.handoffAuthoritativeReplacement).toHaveBeenCalledOnce();

    await f.service.removeProject(f.scope, source.id, expected(f, source.id));
    await expect(f.service.moveLocation(f.scope, f.workspace.id, {
      target: { kind: "existing", projectId: source.id }, expectedRevision: f.inventory.getWorkspace(f.scope, f.workspace.id).revision,
    })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("merges only an idle project into an active one and deletes the source", async () => {
    const f = fixture();
    const target = f.location("/tmp/project-management-target");
    const merge = () => f.service.merge(f.scope, f.workspace.projectId, {
      targetProjectId: target.projectId,
      expectedSourceMembershipRevision: f.project(f.workspace.projectId).membershipRevision,
      expectedTargetMembershipRevision: f.project(target.projectId).membershipRevision,
    });
    f.captureLoadedState.mockResolvedValueOnce({ runState: "waiting_for_input" });
    await expect(merge()).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(f.service.merge(f.scope, f.workspace.projectId, {
      targetProjectId: target.projectId, expectedSourceMembershipRevision: 99, expectedTargetMembershipRevision: 0,
    })).rejects.toMatchObject({ code: "conflict" });
    const merged = await merge();
    expect(merged.id).toBe(target.projectId);
    expect(merged.locations.map(({ id }) => id).sort()).toEqual([f.workspace.id, target.id].sort());
    expect(() => f.project(f.workspace.projectId)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(f.handoffAuthoritativeReplacement).toHaveBeenCalledOnce();
  });
});
