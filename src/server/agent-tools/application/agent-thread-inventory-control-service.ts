import { z } from "zod";
import type {
  InventoryRepository,
  InventoryTransition,
} from "../../db/repositories/inventory-repository.js";
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
import { CanonicalAgentToolRequestError } from "../invocation/canonical-agent-tool-request-error.js";
import {
  projectAgentThreadSnooze,
  type AgentThreadSnoozeFields,
} from "./thread-snooze-presentation.js";

export interface AgentThreadArchiveInput {
  readonly threadId: string;
  readonly includeDescendants: boolean;
  // Agent archive has no reviewed task snapshot; completion is available in the browser.
  readonly openTaskDisposition?: Exclude<OpenTaskDisposition, "complete">;
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

export interface ThreadSetStateToolInput {
  readonly threadId?: string;
  readonly lifecycle: "active" | "parked" | "snoozed";
  readonly until?: string;
  readonly reminder?: string;
}

type AgentThreadSetStateInput = ThreadSetStateToolInput & {
  readonly mutationId: string;
  readonly environmentAuthority: TrustedEnvironmentAuthorityGrant;
};

export interface AgentThreadSetStateResult extends AgentThreadSnoozeFields {
  readonly threadId: string;
  readonly lifecycle: ThreadSetStateToolInput["lifecycle"];
}

const snoozeDeadlineSchema = z.iso.datetime({ offset: true });

function parseSnoozeChange(
  input: ThreadSetStateToolInput,
  now: number,
): Extract<InventoryTransition, { action: "snooze" }> | undefined {
  if (input.lifecycle !== "snoozed") {
    if (input.until !== undefined || input.reminder !== undefined) {
      throw new CanonicalAgentToolRequestError(
        "invalid_input",
        "Use until and reminder only when setting lifecycle to snoozed.",
      );
    }
    return undefined;
  }
  const until = snoozeDeadlineSchema.safeParse(input.until);
  const snoozedUntil = until.success ? Date.parse(until.data) : NaN;
  if (!Number.isFinite(snoozedUntil) || snoozedUntil <= now) {
    throw new CanonicalAgentToolRequestError(
      "invalid_input",
      "Snoozing requires until to be a future ISO timestamp with a time zone.",
    );
  }
  const wakeReminderText = input.reminder?.trim() || null;
  if (wakeReminderText?.includes("\0")) {
    throw new CanonicalAgentToolRequestError(
      "invalid_input",
      "The snooze reminder cannot contain a NUL character.",
    );
  }
  return { action: "snooze", snoozedUntil, wakeReminderText };
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
      readonly archives: Pick<ThreadArchiveService, "archive" | "park">;
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
      projectId: member.projectId,
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
    this.#requireAdmittedThread(scope, input.threadId, input.environmentAuthority);
    await this.input.transitions.transition(scope, input.threadId, {
      expectedRevision: current.inventoryRevision,
      mutationId: input.mutationId,
      change: { action: "restore" },
    });
    return { threadId: input.threadId };
  }

  async setState(
    scope: RequestScope,
    input: AgentThreadSetStateInput,
  ): Promise<AgentThreadSetStateResult> {
    const { lifecycle, environmentAuthority } = input;
    const threadId = input.threadId ?? environmentAuthority.defaults.threadId;
    if (threadId === undefined) {
      throw new CanonicalAgentToolRequestError(
        "invalid_input",
        "Provide threadId when the caller has no default thread.",
      );
    }
    this.#requireAdmittedThread(scope, threadId, environmentAuthority);
    const current = this.input.inventory.getInventory(scope, threadId);
    if (current.inventoryState === "archived") {
      throw new CanonicalAgentToolRequestError(
        "conflict",
        "Use thread.restore to restore an archived thread.",
      );
    }

    const now = Date.now();
    const snooze = parseSnoozeChange(input, now);
    if (current.inventoryState === lifecycle) {
      return { threadId, lifecycle, ...projectAgentThreadSnooze(current) };
    }

    const mutation = {
      expectedRevision: current.inventoryRevision,
      mutationId: input.mutationId,
    };
    if (lifecycle === "parked") {
      await this.input.archives.park(scope, threadId, mutation);
      return { threadId, lifecycle };
    }
    const state = await this.input.transitions.transition(
      scope,
      threadId,
      {
        ...mutation,
        change: snooze ?? {
          action: current.inventoryState === "snoozed" ? "wake" : "unpark",
        },
      },
      now,
    );
    return { threadId, lifecycle, ...projectAgentThreadSnooze(state) };
  }

  #requireAdmittedThread(
    scope: RequestScope,
    threadId: string,
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
  ): void {
    const thread = this.input.threads.getThread(scope, threadId).thread;
    requireAdmittedResource(environmentAuthority, {
      kind: "thread",
      id: thread.id,
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      workspaceId: thread.workspaceId,
    });
  }
}
