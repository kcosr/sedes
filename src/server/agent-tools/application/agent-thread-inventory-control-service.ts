import type { InventoryRepository } from "../../db/repositories/inventory-repository.js";
import type { InventoryService } from "../../domain/inventory-service.js";
import type { ThreadArchiveService } from "../../domain/thread-archive-service.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { OpenTaskDisposition } from "../../../shared/protocol/tasks.js";
import { DomainError } from "../../domain/errors.js";
import type { ThreadLineageRepository } from "../../db/repositories/thread-lineage-repository.js";
import {
  requireAdmittedResource,
  type TrustedEnvironmentAuthorityGrant,
} from "../environment/environment-authority.js";

export interface AgentThreadArchiveInput {
  readonly threadId: string;
  readonly includeDescendants: boolean;
  readonly openTaskDisposition?: OpenTaskDisposition;
  readonly mutationId: string;
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
}

export interface AgentThreadArchiveResult {
  readonly threadId: string;
  readonly archivedThreadCount: number;
}

export interface AgentThreadRestoreInput {
  readonly threadId: string;
  readonly mutationId: string;
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
}

export interface AgentThreadRestoreResult {
  readonly threadId: string;
}

/**
 * Principal-scoped agent boundary for reversible inventory lifecycle changes.
 * The server reads the current revision immediately before the existing
 * revision-checked domain mutation; callers never supply tenancy or revision
 * authority.
 */
export class AgentThreadInventoryControlService {
  constructor(
    private readonly input: {
      readonly inventory: Pick<InventoryRepository, "getInventory">;
      readonly threads: Pick<InventoryRepository, "getThread">;
      readonly lineage: Pick<ThreadLineageRepository, "listFamilyThreadIds">;
      readonly archives: Pick<ThreadArchiveService, "archive">;
      readonly transitions: Pick<InventoryService, "transition">;
    },
  ) {}

  async archive(
    scope: RequestScope,
    input: AgentThreadArchiveInput,
  ): Promise<AgentThreadArchiveResult> {
    const current = this.input.inventory.getInventory(scope, input.threadId);
    const familyThreadIds = input.includeDescendants
      ? this.input.lineage.listFamilyThreadIds(scope, input.threadId, 10_000)
      : [input.threadId];
    const root = this.input.threads.getThread(scope, input.threadId).thread;
    for (const familyThreadId of familyThreadIds) {
      const member = this.input.threads.getThread(scope, familyThreadId).thread;
      if (
        member.environmentId !== root.environmentId ||
        member.workspaceId !== root.workspaceId
      ) {
        throw new DomainError(
          "conflict",
          "The thread family crosses workspace or execution-environment authority.",
        );
      }
      requireAdmittedResource(input.environmentAuthority, {
        kind: input.includeDescendants ? "thread_family" : "thread",
        id: member.id,
        environmentId: member.environmentId,
        workspaceId: member.workspaceId,
      });
    }
    const archivedThreadIds = await this.input.archives.archive(
      scope,
      input.threadId,
      {
        expectedRevision: current.inventoryRevision,
        mutationId: input.mutationId,
        includeDescendants: input.includeDescendants,
        expectedThreadIds: familyThreadIds,
        executionWorkspaceDisposition: { kind: "keep" },
        ...(input.openTaskDisposition
          ? { openTaskDisposition: input.openTaskDisposition }
          : {}),
      },
    );
    return {
      threadId: input.threadId,
      archivedThreadCount: archivedThreadIds.length,
    };
  }

  async restore(
    scope: RequestScope,
    input: AgentThreadRestoreInput,
  ): Promise<AgentThreadRestoreResult> {
    const current = this.input.inventory.getInventory(scope, input.threadId);
    const thread = this.input.threads.getThread(scope, input.threadId).thread;
    requireAdmittedResource(input.environmentAuthority, {
      kind: "thread",
      id: thread.id,
      environmentId: thread.environmentId,
      workspaceId: thread.workspaceId,
    });
    await this.input.transitions.transition(scope, input.threadId, {
      expectedRevision: current.inventoryRevision,
      mutationId: input.mutationId,
      change: { action: "restore" },
    });
    return { threadId: input.threadId };
  }
}
