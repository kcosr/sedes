import type { RequestScope } from "../identity/identity-provider.js";
import type { ContextExcerpt } from "../../shared/protocol/context-excerpts.js";
import { composerAttachmentReferenceArraySchema } from "../../shared/protocol/composer-attachments.js";
import { composerTaskReferenceIdsSchema } from "../../shared/protocol/tasks.js";
import {
  contextExcerptArraySchema,
  MAXIMUM_COMPOSER_INPUT_BYTES,
  MAXIMUM_CONTEXT_EXCERPTS,
} from "../../shared/protocol/context-excerpts.js";
import {
  InventoryRepository,
  type InventoryPrincipalStateRecord,
  type InventoryTransition,
} from "../db/repositories/inventory-repository.js";
import { DomainError } from "./errors.js";
import {
  threadPreferredWorktreeUpdateResultSchema,
  type ThreadPreferredWorktreeUpdateRequest,
  type ThreadPreferredWorktreeUpdateResult,
} from "../../shared/protocol/workspace-files.js";

const MAXIMUM_DRAFT_BYTES = 64 * 1_024;
const MAXIMUM_STASHES_PER_THREAD = 50;
const MAXIMUM_WAKE_REMINDER_BYTES = 4_096;
const PUBLICATION_RETRY_MILLISECONDS = 1_000;

interface PendingPublication {
  readonly scope: RequestScope;
  readonly state: InventoryPrincipalStateRecord;
  retryAt: number;
  inFlight?: Promise<void>;
}

interface PendingApplicationThreadPublication {
  readonly scope: RequestScope;
  readonly threadId: string;
  retryAt: number;
}

export interface InventoryChangePublisher {
  publishMany(
    scope: RequestScope,
    states: readonly InventoryPrincipalStateRecord[],
  ): void | Promise<void>;
  onRetryPending?(): void;
  publishApplicationThread(
    scope: RequestScope,
    threadId: string,
  ): void | Promise<void>;
}

function assertBytes(value: string, maximum: number, label: string): void {
  if (Buffer.byteLength(value, "utf8") > maximum) {
    throw new DomainError(
      "invalid_transition",
      `${label} exceeds its ${maximum}-byte limit.`,
    );
  }
}

function assertComposerBytes(
  text: string,
  excerpts: readonly ContextExcerpt[],
  label: string,
): void {
  const encoder = new TextEncoder();
  let bytes = encoder.encode(text).byteLength;
  for (const excerpt of excerpts) {
    bytes += encoder.encode(excerpt.excerpt).byteLength;
    if (excerpt.note) bytes += encoder.encode(excerpt.note).byteLength;
  }
  if (bytes > MAXIMUM_COMPOSER_INPUT_BYTES) {
    throw new DomainError(
      "invalid_transition",
      `${label} exceeds the composer input limit.`,
    );
  }
}

/**
 * End-state inventory domain boundary for schema 10. Backend lifecycle,
 * bindings, queue state, and Pi detail deliberately remain in their own
 * services; this class owns only application inventory and composer overlay.
 */
export class InventoryService {
  readonly #publisher: InventoryChangePublisher;
  readonly #pendingPublications = new Map<string, PendingPublication>();
  readonly #pendingApplicationThreadPublications = new Map<
    string,
    PendingApplicationThreadPublication
  >();

  constructor(
    readonly repository: InventoryRepository,
    publisher: InventoryChangePublisher,
    readonly onDeadlineWake?: (
      scope: RequestScope,
      state: InventoryPrincipalStateRecord,
    ) => void,
  ) {
    this.#publisher = publisher;
  }

  saveDraft(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly text: string;
      readonly selectedSkillId?: string;
      readonly contextExcerpts: readonly ContextExcerpt[];
      readonly attachmentIds: readonly string[];
      readonly taskReferenceIds: readonly string[];
      readonly expectedRevision: number;
    },
    now = Date.now(),
  ) {
    assertBytes(input.text, MAXIMUM_DRAFT_BYTES, "Draft");
    contextExcerptArraySchema.parse(input.contextExcerpts);
    composerAttachmentReferenceArraySchema.parse(input.attachmentIds);
    composerTaskReferenceIdsSchema.parse(input.taskReferenceIds);
    assertComposerBytes(input.text, input.contextExcerpts, "Draft");
    return this.repository.saveDraft(scope, applicationThreadId, {
      text: input.text,
      ...(input.selectedSkillId === undefined
        ? {}
        : { selectedSkillId: input.selectedSkillId }),
      contextExcerpts: input.contextExcerpts,
      attachmentIds: input.attachmentIds,
      taskReferenceIds: input.taskReferenceIds,
      expectedRevision: input.expectedRevision,
      now,
    });
  }

  stashDraft(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedDraftRevision: number;
      readonly mutationId: string;
    },
    now = Date.now(),
  ) {
    const draft = this.repository.getDraft(scope, applicationThreadId);
    assertBytes(draft.text, MAXIMUM_DRAFT_BYTES, "Stashed prompt");
    return this.repository.stashDraft(scope, applicationThreadId, {
      ...input,
      maximumStashes: MAXIMUM_STASHES_PER_THREAD,
      now,
    });
  }

  restoreStash(
    scope: RequestScope,
    applicationThreadId: string,
    stashId: string,
    input: {
      readonly expectedDraftRevision: number;
      readonly mutationId: string;
    },
    now = Date.now(),
  ) {
    const draft = this.repository.getDraft(scope, applicationThreadId);
    const stash = this.repository
      .listStashes(scope, applicationThreadId)
      .find(({ id }) => id === stashId);
    if (stash) {
      const restored =
        draft.text.length === 0 ? stash.text : `${draft.text}\n\n${stash.text}`;
      const contextExcerpts = [
        ...draft.contextExcerpts,
        ...stash.contextExcerpts,
      ];
      assertBytes(restored, MAXIMUM_DRAFT_BYTES, "Restored draft");
      if (contextExcerpts.length > MAXIMUM_CONTEXT_EXCERPTS) {
        throw new DomainError(
          "invalid_transition",
          `A draft can contain at most ${MAXIMUM_CONTEXT_EXCERPTS} context excerpts.`,
        );
      }
      if (
        new Set(contextExcerpts.map(({ id }) => id)).size !==
        contextExcerpts.length
      ) {
        throw new DomainError(
          "invalid_transition",
          "The stashed prompt contains a context excerpt already in the draft.",
        );
      }
      try {
        contextExcerptArraySchema.parse(contextExcerpts);
      } catch (error) {
        throw new DomainError(
          "invalid_transition",
          "The restored context excerpts are invalid.",
          false,
          { cause: error },
        );
      }
      assertComposerBytes(restored, contextExcerpts, "Restored draft");
    }
    return this.repository.restoreStash(scope, applicationThreadId, stashId, {
      ...input,
      now,
    });
  }

  async transition(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly change: InventoryTransition;
    },
    now = Date.now(),
  ): Promise<InventoryPrincipalStateRecord> {
    if (
      (input.change.action === "snooze" || input.change.action === "remind") &&
      input.change.wakeReminderText !== undefined &&
      input.change.wakeReminderText !== null
    ) {
      if (
        input.change.wakeReminderText.length === 0 ||
        (input.change.action === "remind" &&
          input.change.wakeReminderText.trim().length === 0)
      ) {
        throw new DomainError(
          "invalid_transition",
          "Wake reminder cannot be empty.",
        );
      }
      assertBytes(
        input.change.wakeReminderText,
        MAXIMUM_WAKE_REMINDER_BYTES,
        "Wake reminder",
      );
    }
    const result = this.repository.transitionInventory(
      scope,
      applicationThreadId,
      { ...input, now },
    );
    await this.publishCommitted(scope, [result.state], now);
    return result.state;
  }

  async setPinned(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly pinned: boolean;
      readonly expectedRevision: number;
      readonly mutationId: string;
    },
    now = Date.now(),
  ): Promise<void> {
    this.repository.setThreadPinned(scope, applicationThreadId, {
      ...input,
      now,
    });
    await this.#publishApplicationThread(scope, applicationThreadId, now);
  }

  async setPreferredWorktree(
    scope: RequestScope,
    applicationThreadId: string,
    input: ThreadPreferredWorktreeUpdateRequest,
    now = Date.now(),
  ): Promise<ThreadPreferredWorktreeUpdateResult> {
    const result = this.repository.setPreferredWorktree(
      scope,
      applicationThreadId,
      { ...input, now },
    );
    await this.#publishApplicationThread(scope, applicationThreadId, now);
    return threadPreferredWorktreeUpdateResultSchema.parse(result);
  }

  async publishApplicationThreadChanges(
    scope: RequestScope,
    applicationThreadIds: readonly string[],
    now = Date.now(),
  ): Promise<void> {
    await Promise.all(
      applicationThreadIds.map((applicationThreadId) =>
        this.#publishApplicationThread(scope, applicationThreadId, now),
      ),
    );
  }

  async wakeDue(now = Date.now()): Promise<InventoryPrincipalStateRecord[]> {
    const changes = this.repository.wakeDueSnoozes(now);
    for (const { scope, state } of changes) {
      try {
        this.onDeadlineWake?.(scope, state);
      } catch {
        // Passive notifications cannot undo a committed wake or prevent its
        // ordinary UI publication. They have no retry or receipt contract.
      }
      this.#queuePublication(scope, state, now);
    }
    await this.#flushDuePublications(now);
    await this.#flushDueApplicationThreadPublications(now);
    return changes.map(({ state }) => state);
  }

  getNearestDeadline(): number | null {
    let deadline = this.repository.getNearestSnoozeDeadline();
    for (const { retryAt, inFlight } of this.#pendingPublications.values()) {
      if (inFlight) continue;
      if (deadline === null || retryAt < deadline) deadline = retryAt;
    }
    for (const {
      retryAt,
    } of this.#pendingApplicationThreadPublications.values()) {
      if (deadline === null || retryAt < deadline) deadline = retryAt;
    }
    return deadline;
  }

  async #publishApplicationThread(
    scope: RequestScope,
    threadId: string,
    now: number,
  ): Promise<void> {
    const key = `${scope.tenantId}\0${scope.principalId}\0${threadId}`;
    try {
      await this.#publisher.publishApplicationThread(scope, threadId);
      this.#pendingApplicationThreadPublications.delete(key);
    } catch {
      this.#pendingApplicationThreadPublications.set(key, {
        scope,
        threadId,
        retryAt: now + PUBLICATION_RETRY_MILLISECONDS,
      });
      try {
        this.#publisher.onRetryPending?.();
      } catch {
        // Retry scheduling is an observer. A later scheduler reconciliation
        // can still discover the pending deadline through getNearestDeadline.
      }
    }
  }

  async #flushDueApplicationThreadPublications(now: number): Promise<void> {
    for (const entry of this.#pendingApplicationThreadPublications.values()) {
      if (entry.retryAt > now) continue;
      await this.#publishApplicationThread(entry.scope, entry.threadId, now);
    }
  }

  async wakeForRuntimeSignal(
    scope: RequestScope,
    applicationThreadId: string,
    reason: "completion" | "failure" | "needs-input",
    now = Date.now(),
  ): Promise<InventoryPrincipalStateRecord> {
    const state = this.repository.wakeForRuntimeSignal(
      scope,
      applicationThreadId,
      reason,
      now,
    );
    await this.publishCommitted(scope, [state], now);
    return state;
  }

  async publishCommitted(
    scope: RequestScope,
    states: readonly InventoryPrincipalStateRecord[],
    now: number,
  ): Promise<void> {
    if (states.length === 0) return;
    const entries = states.map((state) =>
      this.#queuePublication(scope, state, now),
    );
    await this.#flushPublications(entries);
  }

  #queuePublication(
    scope: RequestScope,
    state: InventoryPrincipalStateRecord,
    now: number,
  ) {
    const key = `${scope.tenantId}\0${scope.principalId}\0${state.threadId}`;
    const entry = {
      scope,
      state,
      retryAt: now,
    };
    this.#pendingPublications.set(key, entry);
    return entry;
  }

  async #flushDuePublications(now: number): Promise<void> {
    const failures: unknown[] = [];
    const byScope = new Map<string, PendingPublication[]>();
    for (const entry of this.#pendingPublications.values()) {
      if (entry.inFlight || entry.retryAt > now) continue;
      const key = `${entry.scope.tenantId}\0${entry.scope.principalId}`;
      const entries = byScope.get(key) ?? [];
      entries.push(entry);
      byScope.set(key, entries);
    }
    for (const entries of byScope.values()) {
      try {
        await this.#flushPublications(entries);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more inventory publications failed.",
      );
    }
  }

  async #flushPublications(
    entries: readonly PendingPublication[],
  ): Promise<void> {
    const ready = entries.filter((entry) => !entry.inFlight);
    if (ready.length === 0) {
      await Promise.all(entries.map((entry) => entry.inFlight));
      return;
    }
    const scope = ready[0]!.scope;
    if (
      ready.some(
        (entry) =>
          entry.scope.tenantId !== scope.tenantId ||
          entry.scope.principalId !== scope.principalId,
      )
    ) {
      throw new Error("inventory_publication_scope_mismatch");
    }
    let failed = false;
    const publication: Promise<void> = Promise.resolve().then(async () => {
      try {
        await this.#publisher.publishMany(
          scope,
          ready.map(({ state }) => state),
        );
        for (const entry of ready) {
          const key =
            `${entry.scope.tenantId}\0${entry.scope.principalId}` +
            `\0${entry.state.threadId}`;
          if (this.#pendingPublications.get(key) === entry) {
            this.#pendingPublications.delete(key);
          }
        }
      } catch (error) {
        for (const entry of ready) {
          const key =
            `${entry.scope.tenantId}\0${entry.scope.principalId}` +
            `\0${entry.state.threadId}`;
          if (this.#pendingPublications.get(key) === entry) {
            entry.retryAt = Date.now() + PUBLICATION_RETRY_MILLISECONDS;
          }
        }
        failed = true;
        throw error;
      } finally {
        for (const entry of ready) {
          if (entry.inFlight === publication) entry.inFlight = undefined;
        }
        if (failed) {
          try {
            this.#publisher.onRetryPending?.();
          } catch {
            // Retry scheduling is an observer. The pending entry remains
            // authoritative and another scheduler reconciliation can recover it.
          }
        }
      }
    });
    for (const entry of ready) entry.inFlight = publication;
    return publication;
  }
}
