import {
  WORKSPACE_FILE_PRIMARY_ROOT_ID,
  workspaceFileLinkedWorktreeRootIdSchema,
} from "../../../shared/protocol/workspace-files.js";
import type { InventoryService } from "../../domain/inventory-service.js";
import type { WorkspaceFileService } from "../../domain/workspace-file-service.js";
import { DomainError } from "../../domain/errors.js";
import { requireAdmittedResource } from "../environment/environment-authority.js";
import type {
  AgentThreadWorktreeContext,
  AgentThreadWorktreeItem,
  AgentThreadWorktreeListResult,
  AgentThreadWorktreePreference,
  AgentThreadWorktreeService,
  ThreadWorktreeClearInput,
  ThreadWorktreeSetInput,
} from "./thread-worktree-tools.js";
import type { RequestScope } from "../../identity/identity-provider.js";

/** Source-thread adapter over the same discovery and preference services as the thread UI. */
export class ThreadWorktreeAgentToolService implements AgentThreadWorktreeService {
  constructor(
    readonly files: WorkspaceFileService,
    readonly inventory: InventoryService,
  ) {}

  async list(
    scope: RequestScope,
    context: AgentThreadWorktreeContext,
  ): Promise<AgentThreadWorktreeListResult> {
    const thread = this.#thread(scope, context);
    const { roots } = await this.files.listRoots(
      scope,
      thread.workspaceId,
      context.signal,
    );
    const preference = this.#preference(scope, context.threadId);
    const worktrees: AgentThreadWorktreeItem[] = [];
    for (const root of roots) {
      if (root.kind === "primary") {
        worktrees.push({
          rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
          kind: "primary",
          displayLabel: root.displayLabel,
        });
      } else if (
        root.kind === "linked_worktree" &&
        root.availability === "available"
      ) {
        worktrees.push({
          rootId: root.rootId,
          kind: "linked_worktree",
          displayLabel: root.displayLabel,
          branch: root.branch,
          head: root.head,
        });
      }
    }
    return {
      worktrees,
      preference,
    };
  }

  async set(
    scope: RequestScope,
    context: AgentThreadWorktreeContext,
    input: ThreadWorktreeSetInput,
  ): Promise<AgentThreadWorktreePreference> {
    const thread = this.#thread(scope, context);
    const rootId = workspaceFileLinkedWorktreeRootIdSchema.parse(input.rootId);
    await this.files.requireAvailableLinkedWorktree(
      scope,
      thread.workspaceId,
      rootId,
      context.signal,
    );
    const result = await this.inventory.setPreferredWorktree(
      scope,
      context.threadId,
      {
        rootId,
        expectedRevision: input.expectedRevision,
        mutationId: context.mutationId,
      },
    );
    return result.preference;
  }

  async clear(
    scope: RequestScope,
    context: AgentThreadWorktreeContext,
    input: ThreadWorktreeClearInput,
  ): Promise<AgentThreadWorktreePreference> {
    this.#thread(scope, context);
    const result = await this.inventory.setPreferredWorktree(
      scope,
      context.threadId,
      {
        rootId: null,
        expectedRevision: input.expectedRevision,
        mutationId: context.mutationId,
      },
    );
    return result.preference;
  }

  #thread(scope: RequestScope, context: AgentThreadWorktreeContext) {
    const thread = this.inventory.repository.getThread(
      scope,
      context.threadId,
    ).thread;
    requireAdmittedResource(context.environmentAuthority, {
      kind: "thread",
      id: thread.id,
      environmentId: thread.environmentId,
    });
    if (
      thread.workspaceId !== context.workspaceId ||
      thread.environmentId !== context.environmentId
    ) {
      throw new DomainError("not_found", "The source thread was not found.");
    }
    return thread;
  }

  #preference(
    scope: RequestScope,
    threadId: string,
  ): AgentThreadWorktreePreference {
    const state = this.inventory.repository.getInventory(scope, threadId);
    return {
      rootId: state.preferredWorktreeRootId,
      revision: state.preferredWorktreeRevision,
    };
  }
}
