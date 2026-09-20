import type { ProjectSummary, RemoveProjectRequest } from "../../shared/protocol/projects.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { runWithArchivedThreadRuntimesRetired, type ArchivedThreadRuntimeRetirement } from "../domain/thread-runtime-archive-retirement.js";
import type { WorkspaceApplicationPublication } from "./workspace-application-service.js";

export interface WorkspaceRetirement {
  runWithWorkspaceRetired<Result>(scope: RequestScope, workspaceId: string, operation: () => Promise<Result>): Promise<Result>;
}

/** Registration lifecycle only. Provider history and thread inventory states survive. */
export class ProjectManagementService {
  constructor(readonly input: {
    inventory: InventoryRepository;
    runtimes: ArchivedThreadRuntimeRetirement;
    files: WorkspaceRetirement;
    terminals?: WorkspaceRetirement;
    publications: WorkspaceApplicationPublication;
  }) {}

  list(scope: RequestScope): { projects: ProjectSummary[] } {
    return { projects: this.input.inventory.listProjects(scope) };
  }

  async remove(scope: RequestScope, workspaceId: string, request: RemoveProjectRequest): Promise<ProjectSummary> {
    const threadIds = this.input.inventory.listThreadIdsForWorkspace(scope, workspaceId);
    this.input.inventory.assertWorkspaceRemovable(scope, workspaceId, { ...request, expectedThreadIds: threadIds });
    const retireThreads = () => runWithArchivedThreadRuntimesRetired({
      scope, threadIds, runtimes: this.input.runtimes,
      operation: () => this.input.files.runWithWorkspaceRetired(scope, workspaceId, async () => this.input.inventory.removeWorkspace(scope, workspaceId, {
        ...request, expectedThreadIds: threadIds, now: Date.now(),
      })),
    });
    await (this.input.terminals
      ? this.input.terminals.runWithWorkspaceRetired(scope, workspaceId, retireThreads)
      : retireThreads());
    this.input.publications.handoffAuthoritativeReplacement(scope);
    return this.input.inventory.listProjects(scope).find(project => project.id === workspaceId)!;
  }
}
