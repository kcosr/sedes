import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { WorkpadRepository } from "../../src/server/db/repositories/workpad-repository.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { ProjectManagementService } from "../../src/server/application/project-management-service.js";
import { WorkspaceApplicationService } from "../../src/server/application/workspace-application-service.js";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { ThreadRuntimeNotIdleError } from "../../src/server/events/thread-runtime-coordinator.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));

function fixture() {
  const { database, scope } = savedAgentDatabase();
  cleanups.push(() => database.close());
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    environmentId: environment.id, canonicalPath: "/tmp/project-management", displayName: "Project",
    available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 200,
  });
  const bindings = new ConversationBindingRepository(database);
  const profile = database.prepare("SELECT id FROM agent_connection_profiles WHERE enabled = 1").get() as {id:string};
  const create = () => bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId: profile.id, title: "Retained thread", initialText: "Keep this draft", now: 300 });
  const thread = create();
  bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: "retained-native-history", now: 400 });
  const runWithRuntimeRetired = vi.fn(async <T>(_scope: typeof scope, _id: string, operation: () => Promise<T>) => operation());
  const runWithWorkspaceRetired = vi.fn(async <T>(_scope: typeof scope, _id: string, operation: () => Promise<T>) => operation());
  const handoffAuthoritativeReplacement = vi.fn();
  const service = new ProjectManagementService({ inventory, runtimes: {runWithRuntimeRetired: runWithRuntimeRetired as import("../../src/server/domain/thread-runtime-archive-retirement.js").ArchivedThreadRuntimeRetirement["runWithRuntimeRetired"]}, files: {runWithWorkspaceRetired: runWithWorkspaceRetired as import("../../src/server/application/project-management-service.js").WorkspaceRetirement["runWithWorkspaceRetired"]}, publications: {handoffAuthoritativeReplacement} });
  const remove = () => service.remove(scope, workspace.id, { expectedRevision: inventory.getWorkspace(scope, workspace.id).revision });
  const open = new WorkspaceApplicationService({inventory, execution: {validateWorkspace: vi.fn(async () => ({ canonicalPath: workspace.canonicalPath, authorityRevision: environment.configurationRevision,
    summary: {id:workspace.id, environmentId:environment.id, displayName:workspace.displayName, displayPath:workspace.canonicalPath, availability:"available" as const, trustState:"trusted" as const, revision:0} }))}, publications: {handoffAuthoritativeReplacement} });
  const queue = new QueuedInputRepository(database);
  const summaries = new DatabaseApplicationThreadSummaryReader({ inventory, queue, completion: new SubmissionCompletionRepository(database) });
  return {database,scope,inventory,environment,workspace,thread,bindings,create,service,remove,open,queue,summaries,runWithRuntimeRetired,runWithWorkspaceRetired,handoffAuthoritativeReplacement};
}

describe("project registration lifecycle", () => {
  it("removes from inventory without changing thread state, draft, or native binding; re-add restores the identity", async () => {
    const f = fixture();
    const before = f.inventory.getThread(f.scope, f.thread.id);
    const binding = f.bindings.getBinding(f.scope, f.thread.id);
    expect(f.summaries.list(f.scope, f.environment.id)).toHaveLength(1);
    const removed = await f.remove();
    expect(removed).toMatchObject({id:f.workspace.id, removed:true, threadCount:1, revision:1});
    expect(f.inventory.listWorkspaces(f.scope)).toEqual([]);
    expect(f.summaries.list(f.scope, f.environment.id)).toEqual([]);
    expect(f.summaries.listByIds(f.scope, [f.thread.id])).toEqual([]);
    expect(f.inventory.countThreadsByInventoryState(f.scope).active).toBe(0);
    expect(f.inventory.getThread(f.scope, f.thread.id)).toEqual(before);
    expect(f.bindings.getBinding(f.scope, f.thread.id)).toEqual(binding);
    expect(f.handoffAuthoritativeReplacement).toHaveBeenCalledOnce();
    const restored = await f.open.openWorkspace(f.scope, {environmentId:f.environment.id,path:f.workspace.canonicalPath});
    expect(restored.workspaceId).toBe(f.workspace.id);
    expect(f.inventory.listWorkspaces(f.scope)).toHaveLength(1);
    expect(f.summaries.list(f.scope, f.environment.id)).toHaveLength(1);
    expect(f.inventory.getThread(f.scope, f.thread.id)).toEqual(before);
    const again = await f.open.openWorkspace(f.scope, {environmentId:f.environment.id,path:f.workspace.canonicalPath});
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
    await expect(f.service.remove(f.scope,f.workspace.id,{expectedRevision:42})).rejects.toMatchObject({code:"conflict"});
    const stranger={...f.scope,principalId:"another-principal"};
    expect(f.service.list(stranger).projects).toEqual([]);
    await expect(f.service.remove(stranger,f.workspace.id,{expectedRevision:0})).rejects.toMatchObject({code:"not_found"});
    f.inventory.updateEnvironmentAvailability(f.scope,f.environment.id,{available:false,now:500});
    await expect(f.remove()).resolves.toMatchObject({removed:true, available:false});
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
    await f.open.openWorkspace(f.scope,{environmentId:f.environment.id,path:f.workspace.canonicalPath});
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

  it("blocks queued work without mutating it", async () => {
    const f=fixture();
    const item=f.queue.enqueue(f.scope,f.thread.id,{mutationId:randomUUID(),text:"Queued",contextExcerpts:[],attachmentIds:[],taskReferences:[],source:{kind:"agent_control",expectedThreadRevision:f.inventory.getThread(f.scope,f.thread.id).thread.revision,initiatingAgentThreadId:f.thread.id},now:500});
    await expect(f.remove()).rejects.toThrow(/queued/);
    expect(f.queue.get(f.scope,f.thread.id,item.item.id).state).toBe("pending");
    expect(f.inventory.isWorkspaceRemoved(f.scope,f.workspace.id)).toBe(false);
  });
});
