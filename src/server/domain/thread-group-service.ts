import type {
  ThreadGroupMutationResult,
  UpdateThreadGroupAssignmentRequest,
  UpdateThreadGroupRequest,
} from "../../shared/protocol/thread-groups.js";
import type { ApplicationSnapshotPublicationBoundary } from "../application/application-snapshot-service.js";
import type { ThreadGroupRepository } from "../db/repositories/thread-group-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";

/** Coordinates principal-owned group mutations with an atomic snapshot refresh. */
export class ThreadGroupService {
  constructor(
    readonly repository: ThreadGroupRepository,
    readonly applicationSnapshots: ApplicationSnapshotPublicationBoundary,
  ) {}

  async updateAssignment(
    scope: RequestScope,
    threadId: string,
    input: UpdateThreadGroupAssignmentRequest,
    now = Date.now(),
  ): Promise<ThreadGroupMutationResult> {
    const result =
      input.action === "create"
        ? this.repository.createAndAssign(scope, threadId, { ...input, now })
        : this.repository.assign(scope, threadId, {
            groupId: input.action === "assign" ? input.groupId : null,
            expectedRevision: input.expectedRevision,
            mutationId: input.mutationId,
            now,
          });
    await this.applicationSnapshots.publishAuthoritativeReplacement(scope);
    return { groupId: result.groupId, threadId };
  }

  async updateGroup(
    scope: RequestScope,
    groupId: string,
    input: UpdateThreadGroupRequest,
    now = Date.now(),
  ): Promise<ThreadGroupMutationResult> {
    const result =
      input.action === "rename"
        ? this.repository.rename(scope, groupId, { ...input, now })
        : this.repository.delete(scope, groupId, { ...input, now });
    await this.applicationSnapshots.publishAuthoritativeReplacement(scope);
    return { groupId: result.groupId };
  }
}
