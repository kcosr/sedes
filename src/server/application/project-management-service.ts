import type { ThreadRunState } from "../../shared/protocol/conversation.js";
import type {
  ListProjectsResult,
  MergeProjectRequest,
  MoveLocationRequest,
  ProjectSummary,
  RemoveLocationRequest,
  RemoveProjectRequest,
  RenameProjectRequest,
  RestoreProjectRequest,
} from "../../shared/protocol/projects.js";
import {
  ProjectRemovalBlockedError,
  type InventoryProjectListing,
  type InventoryRepository,
  type ProjectRemovalLocation,
} from "../db/repositories/inventory-repository.js";
import { DomainError } from "../domain/errors.js";
import type { ThreadRuntimeCoordinator } from "../events/thread-runtime-coordinator.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { runWithArchivedThreadRuntimesRetired, type ArchivedThreadRuntimeRetirement } from "../domain/thread-runtime-archive-retirement.js";
import type { WorkspaceApplicationPublication, WorkspaceApplicationService } from "./workspace-application-service.js";

export interface WorkspaceRetirement {
  runWithWorkspaceRetired<Result>(scope: RequestScope, workspaceId: string, operation: () => Promise<Result>): Promise<Result>;
}

export type RestoredLocationOutcome =
  | { readonly id: string; readonly status: "restored" }
  /** The cause is server-private; HTTP projects it into the public error vocabulary. */
  | { readonly id: string; readonly status: "failed"; readonly cause: unknown };

// A loaded runtime in one of these states may be in or settling a turn.
const BUSY_RUN_STATES: ReadonlySet<ThreadRunState> = new Set([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "stopping",
  "reconciling",
]);

function presentProject(project: InventoryProjectListing): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    revision: project.revision,
    membershipRevision: project.membershipRevision,
    removed: project.removedAt !== null,
    locations: project.locations.map((location) => ({
      id: location.id,
      environmentId: location.environmentId,
      environmentLabel: location.environmentLabel,
      label: location.displayName,
      path: location.canonicalPath,
      removed: location.removedAt !== null,
      removedWithProject: location.removedWithProject,
      available: location.available,
      threadCount: location.threadCount,
      revision: location.revision,
    })),
  };
}

/**
 * Project and location lifecycle. Provider history and thread inventory
 * states survive every operation; each structural change publishes an
 * authoritative application replacement.
 */
export class ProjectManagementService {
  constructor(readonly input: {
    inventory: InventoryRepository;
    runtimes: ArchivedThreadRuntimeRetirement & Pick<ThreadRuntimeCoordinator, "captureLoadedState">;
    files: WorkspaceRetirement;
    terminals?: WorkspaceRetirement;
    locations: Pick<WorkspaceApplicationService, "restoreLocation">;
    publications: WorkspaceApplicationPublication;
    now?: () => number;
  }) {}

  list(scope: RequestScope): ListProjectsResult {
    return { projects: this.input.inventory.listProjects(scope).map(presentProject) };
  }

  rename(scope: RequestScope, projectId: string, request: RenameProjectRequest): ProjectSummary {
    const project = this.input.inventory.renameProject(scope, projectId, { ...request, now: this.#now() });
    this.input.publications.handoffAuthoritativeReplacement(scope);
    return presentProject(project);
  }

  /** Removes one location; its project stays active even when it was the last. */
  async removeLocation(scope: RequestScope, workspaceId: string, request: RemoveLocationRequest): Promise<ProjectSummary> {
    const threadIds = this.input.inventory.listThreadIdsForWorkspace(scope, workspaceId);
    this.input.inventory.assertWorkspaceRemovable(scope, workspaceId, { ...request, expectedThreadIds: threadIds });
    await this.#withLocationsRetired(scope, [{ workspaceId, threadIds }], async () =>
      this.input.inventory.removeWorkspace(scope, workspaceId, {
        ...request, expectedThreadIds: threadIds, now: this.#now(),
      }));
    this.input.publications.handoffAuthoritativeReplacement(scope);
    return presentProject(this.input.inventory.getProject(scope, this.input.inventory.getWorkspace(scope, workspaceId).projectId));
  }

  /**
   * Removes the project with every active location. All blockers are reported
   * together; then every location is fenced, in a fixed order, while one
   * transaction rechecks the location set and commits.
   */
  async removeProject(scope: RequestScope, projectId: string, request: RemoveProjectRequest): Promise<ProjectSummary> {
    const inspection = this.input.inventory.inspectProjectRemoval(scope, projectId, request);
    if (inspection.blockers.length > 0) throw new ProjectRemovalBlockedError(inspection.blockers);
    const removed = await this.#withLocationsRetired(scope, inspection.locations, async () =>
      this.input.inventory.removeProject(scope, projectId, {
        ...request, expectedLocations: inspection.locations, now: this.#now(),
      }));
    this.input.publications.handoffAuthoritativeReplacement(scope);
    return presentProject(removed);
  }

  /**
   * Restores the project, then each requested location through the
   * revalidating path. A location failure leaves the others and the project
   * restored. Schedules stay paused.
   */
  async restoreProject(scope: RequestScope, projectId: string, request: RestoreProjectRequest): Promise<{
    readonly project: ProjectSummary;
    readonly locations: readonly RestoredLocationOutcome[];
  }> {
    const members = new Set(this.input.inventory.getProject(scope, projectId).locations.map(({ id }) => id));
    if (request.locationIds.some((id) => !members.has(id))) {
      throw new DomainError("bad_request", "Every location to restore must belong to the project.");
    }
    this.input.inventory.restoreProject(scope, projectId, {
      expectedRevision: request.expectedRevision, now: this.#now(),
    });
    this.input.publications.handoffAuthoritativeReplacement(scope);
    const locations: RestoredLocationOutcome[] = [];
    for (const id of request.locationIds) {
      try {
        await this.input.locations.restoreLocation(scope, id, { expectedProjectId: projectId });
        locations.push({ id, status: "restored" });
      } catch (cause) {
        locations.push({ id, status: "failed", cause });
      }
    }
    return { project: presentProject(this.input.inventory.getProject(scope, projectId)), locations };
  }

  /**
   * Moves one location, with everything keyed by it, into another or a new
   * project. Running, queued, or uncertain work blocks it; terminals, Files,
   * and idle runtimes do not, and nothing is retired.
   */
  async moveLocation(scope: RequestScope, workspaceId: string, request: MoveLocationRequest): Promise<ProjectSummary> {
    const threadIds = this.input.inventory.listThreadIdsForWorkspace(scope, workspaceId);
    if (!this.input.inventory.isWorkspaceRemoved(scope, workspaceId)) {
      await this.#assertThreadsIdle(scope, threadIds, "Resolve running, queued, or uncertain work before moving this location.");
    }
    const moved = this.input.inventory.moveWorkspaceToProject(scope, workspaceId, {
      ...request, expectedThreadIds: threadIds, now: this.#now(),
    });
    this.input.publications.handoffAuthoritativeReplacement(scope);
    return presentProject(this.input.inventory.getProject(scope, moved.projectId));
  }

  /** Moves every location into the target and deletes the source; it cannot be undone. */
  async merge(scope: RequestScope, sourceProjectId: string, request: MergeProjectRequest): Promise<ProjectSummary> {
    const threadIds = this.input.inventory.listActiveThreadIdsForProject(scope, sourceProjectId);
    await this.#assertThreadsIdle(scope, threadIds, "Resolve running, queued, or uncertain work before merging this project.");
    const merged = this.input.inventory.mergeProject(scope, sourceProjectId, {
      ...request, expectedThreadIds: threadIds, now: this.#now(),
    });
    this.input.publications.handoffAuthoritativeReplacement(scope);
    return presentProject(merged);
  }

  /**
   * Fences each location in turn (terminal admission, then its thread
   * runtimes, then Files) and runs the operation with every fence held. The
   * fences fail fast, so nesting them cannot wait on each other.
   */
  #withLocationsRetired<Result>(
    scope: RequestScope,
    locations: readonly Pick<ProjectRemovalLocation, "workspaceId" | "threadIds">[],
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const ordered = [...locations].sort((left, right) =>
      left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0);
    const fence = (index: number): Promise<Result> => {
      const location = ordered[index];
      if (!location) return operation();
      const retireThreads = () => runWithArchivedThreadRuntimesRetired({
        scope, threadIds: location.threadIds, runtimes: this.input.runtimes,
        operation: () => this.input.files.runWithWorkspaceRetired(scope, location.workspaceId, () => fence(index + 1)),
      });
      return this.input.terminals
        ? this.input.terminals.runWithWorkspaceRetired(scope, location.workspaceId, retireThreads)
        : retireThreads();
    };
    return fence(0);
  }

  async #assertThreadsIdle(scope: RequestScope, threadIds: readonly string[], message: string): Promise<void> {
    const loaded = await Promise.all(threadIds.map((threadId) => this.input.runtimes.captureLoadedState(scope, threadId)));
    if (loaded.some((state) => state !== undefined && BUSY_RUN_STATES.has(state.runState))) {
      throw new DomainError("invalid_transition", message);
    }
  }

  #now(): number {
    return this.input.now?.() ?? Date.now();
  }
}
