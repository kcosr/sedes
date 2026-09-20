import { randomUUID } from "node:crypto";
import type {
  BackingState,
  InventoryState,
} from "./legacy-domain.js";
import type {
  CreateWorkspaceInput,
  FirstSendPreparation,
  NativeOperationKind,
  OverlayRepository,
  ReconcileNativeSessionInput,
  ThreadListResult,
} from "./overlay-repository.js";
import type { RequestScope } from "../../../src/server/identity/identity-provider.js";
import type { ThreadCursorCodec } from "./cursor-codec.js";
import { DomainError } from "../../../src/server/domain/errors.js";
import type {
  DraftRecord,
  InventoryChangePublisher,
  StashRecord,
  ThreadInventoryChange,
  ThreadPrincipalStateRecord,
  ThreadWithState,
  WorkspaceRecord,
} from "./models.js";

const MAX_DRAFT_BYTES = 64 * 1024;
const MAX_STASHES_PER_THREAD = 50;
const MAX_TITLE_CHARACTERS = 240;
const MAX_WAKE_REMINDER_BYTES = 4_096;

const noopPublisher: InventoryChangePublisher = {
  publishInventoryChanged: () => {},
};

export class ThreadInventoryService {
  constructor(
    readonly repository: OverlayRepository,
    readonly publisher: InventoryChangePublisher = noopPublisher,
  ) {}

  getLocalEnvironment(scope: RequestScope) {
    return this.repository.getLocalEnvironment(scope);
  }

  updateEnvironmentAvailability(
    scope: RequestScope,
    environmentId: string,
    input: {
      available: boolean;
      diagnosticCode?: string;
    },
    now = Date.now(),
  ) {
    if (input.diagnosticCode) {
      this.#assertBoundedText(
        input.diagnosticCode,
        120,
        "Environment diagnostic",
      );
    }
    return this.repository.updateEnvironmentAvailability(scope, environmentId, {
      availability: input.available ? "available" : "unavailable",
      diagnosticCode: input.available ? null : input.diagnosticCode ?? null,
      now,
    });
  }

  listThreadIdsForEnvironment(
    scope: RequestScope,
    environmentId: string,
  ): string[] {
    return this.repository.listThreadIdsForEnvironment(scope, environmentId);
  }

  rememberWorkspace(
    scope: RequestScope,
    input: Omit<CreateWorkspaceInput, "now">,
    now = Date.now(),
  ): WorkspaceRecord {
    this.#assertBoundedText(input.canonicalPath, 4096, "Workspace path");
    this.#assertBoundedText(input.displayName, 240, "Workspace name");
    return this.repository.upsertWorkspace(scope, { ...input, now });
  }

  createThread(
    scope: RequestScope,
    input: { workspaceId: string; title?: string },
    now = Date.now(),
  ): ThreadWithState {
    const title = input.title?.trim() || "New thread";
    this.#assertBoundedText(title, MAX_TITLE_CHARACTERS, "Thread title");
    return this.repository.createThread(scope, {
      workspaceId: input.workspaceId,
      title,
      now,
    });
  }

  getThread(scope: RequestScope, threadId: string): ThreadWithState {
    return this.repository.getThread(scope, threadId);
  }

  getWorkspace(scope: RequestScope, workspaceId: string): WorkspaceRecord {
    return this.repository.getWorkspace(scope, workspaceId);
  }

  listWorkspaces(scope: RequestScope): WorkspaceRecord[] {
    return this.repository.listWorkspaces(scope);
  }

  saveDraft(
    scope: RequestScope,
    threadId: string,
    input: { text: string; expectedRevision: number },
    now = Date.now(),
  ): DraftRecord {
    this.#assertUtf8Bytes(input.text, MAX_DRAFT_BYTES, "Draft");
    return this.repository.saveDraft(
      scope,
      threadId,
      input.text,
      input.expectedRevision,
      now,
    );
  }

  listStashes(scope: RequestScope, threadId: string): StashRecord[] {
    return this.repository.listStashes(scope, threadId);
  }

  stashDraft(
    scope: RequestScope,
    threadId: string,
    input: { expectedDraftRevision: number; mutationId: string },
    now = Date.now(),
  ) {
    const draft = this.repository.getDraft(scope, threadId);
    this.#assertUtf8Bytes(draft.text, MAX_DRAFT_BYTES, "Stashed prompt");
    return this.repository.stashDraft(scope, threadId, {
      expectedDraftRevision: input.expectedDraftRevision,
      mutationId: input.mutationId,
      stashId: randomUUID(),
      maximumStashes: MAX_STASHES_PER_THREAD,
      now,
    });
  }

  restoreStash(
    scope: RequestScope,
    threadId: string,
    stashId: string,
    input: { expectedDraftRevision: number; mutationId: string },
    now = Date.now(),
  ) {
    const draft = this.repository.getDraft(scope, threadId);
    const stash = this.repository
      .listStashes(scope, threadId)
      .find((candidate) => candidate.id === stashId);
    if (stash) {
      const separatorBytes = draft.text.length === 0 ? 0 : 2;
      if (
        Buffer.byteLength(draft.text, "utf8") +
          separatorBytes +
          Buffer.byteLength(stash.text, "utf8") >
        MAX_DRAFT_BYTES
      ) {
        throw new DomainError(
          "invalid_transition",
          "Restoring this prompt would exceed the draft size limit.",
        );
      }
    }
    return this.repository.restoreStash(scope, threadId, stashId, {
      ...input,
      now,
    });
  }

  deleteStash(
    scope: RequestScope,
    threadId: string,
    stashId: string,
  ): boolean {
    return this.repository.deleteStash(scope, threadId, stashId);
  }

  transitionInventory(
    scope: RequestScope,
    threadId: string,
    input: {
      expectedRevision: number;
      mutationId: string;
      change: ThreadInventoryChange;
    },
    now = Date.now(),
  ): ThreadPrincipalStateRecord {
    if (input.change.action === "snooze" && input.change.wakeReminderText) {
      this.#assertUtf8Bytes(
        input.change.wakeReminderText,
        MAX_WAKE_REMINDER_BYTES,
        "Wake reminder",
      );
    }
    const result = this.repository.transitionInventory(scope, threadId, {
      ...input,
      now,
    });
    if (!result.replayed) {
      this.publisher.publishInventoryChanged({
        scope,
        threadId,
        state: result.state,
      });
    }
    return result.state;
  }

  dismissWakeReminder(
    scope: RequestScope,
    threadId: string,
    observedWokeAt: number,
    now = Date.now(),
  ): ThreadPrincipalStateRecord {
    const before = this.repository.getThread(scope, threadId).inventory;
    const state = this.repository.dismissWakeReminder(
      scope,
      threadId,
      observedWokeAt,
      now,
    );
    if (state.inventoryRevision !== before.inventoryRevision) {
      this.publisher.publishInventoryChanged({ scope, threadId, state });
    }
    return state;
  }

  dismissAutomationContext(
    scope: RequestScope,
    threadId: string,
    runId: string,
  ): ThreadPrincipalStateRecord {
    const before = this.repository.getThread(scope, threadId).inventory;
    const state = this.repository.dismissAutomationContext(
      scope,
      threadId,
      runId,
    );
    if (state.inventoryRevision !== before.inventoryRevision) {
      this.publisher.publishInventoryChanged({ scope, threadId, state });
    }
    return state;
  }

  recordAgentCompletion(
    scope: RequestScope,
    threadId: string,
    completionId: string,
    now = Date.now(),
  ): ThreadPrincipalStateRecord {
    this.#assertUtf8Bytes(completionId, 128, "Completion ID");
    const before = this.repository.getThread(scope, threadId).inventory;
    const state = this.repository.recordAgentCompletion(
      scope,
      threadId,
      completionId,
      now,
    );
    if (state.inventoryRevision !== before.inventoryRevision) {
      this.publisher.publishInventoryChanged({ scope, threadId, state });
    }
    return state;
  }

  acknowledgeAgentCompletion(
    scope: RequestScope,
    threadId: string,
    completionId: string,
  ): ThreadPrincipalStateRecord {
    const before = this.repository.getThread(scope, threadId).inventory;
    const state = this.repository.acknowledgeAgentCompletion(
      scope,
      threadId,
      completionId,
    );
    if (state.inventoryRevision !== before.inventoryRevision) {
      this.publisher.publishInventoryChanged({ scope, threadId, state });
    }
    return state;
  }

  publishAttentionChanged(
    scope: RequestScope,
    threadId: string,
  ): ThreadPrincipalStateRecord {
    const state = this.repository.getThread(scope, threadId).inventory;
    this.publisher.publishInventoryChanged({ scope, threadId, state });
    return state;
  }

  acknowledgeWake(
    scope: RequestScope,
    threadId: string,
    observedWokeAt: number,
    now = Date.now(),
  ): ThreadPrincipalStateRecord {
    const before = this.repository.getThread(scope, threadId).inventory;
    const state = this.repository.acknowledgeWake(
      scope,
      threadId,
      observedWokeAt,
      now,
    );
    if (state.inventoryRevision !== before.inventoryRevision) {
      this.publisher.publishInventoryChanged({ scope, threadId, state });
    }
    return state;
  }

  activateForAcceptedSend(
    scope: RequestScope,
    threadId: string,
    now = Date.now(),
  ): ThreadPrincipalStateRecord {
    const before = this.repository.getThread(scope, threadId).inventory;
    const state = this.repository.activateForAcceptedSend(
      scope,
      threadId,
      now,
    );
    if (state.inventoryRevision !== before.inventoryRevision) {
      this.publisher.publishInventoryChanged({ scope, threadId, state });
    }
    return state;
  }

  wakeSnoozedForRuntimeSignal(
    scope: RequestScope,
    threadId: string,
    reason: "completion" | "failure" | "needs-input",
    now = Date.now(),
  ): ThreadPrincipalStateRecord {
    const before = this.repository.getThread(scope, threadId).inventory;
    const state = this.repository.wakeSnoozedForRuntimeSignal(
      scope,
      threadId,
      reason,
      now,
    );
    if (state.inventoryRevision !== before.inventoryRevision) {
      this.publisher.publishInventoryChanged({ scope, threadId, state });
    }
    return state;
  }

  reconcileDueSnoozes(now = Date.now()): ThreadPrincipalStateRecord[] {
    const changes = this.repository.wakeDueSnoozes(now);
    for (const change of changes) {
      this.publisher.publishInventoryChanged({
        scope: change.scope,
        threadId: change.state.threadId,
        state: change.state,
      });
    }
    return changes.map((change) => change.state);
  }

  getNearestSnoozeDeadline(): number | null {
    return this.repository.getNearestSnoozeDeadline();
  }

  listThreads(
    scope: RequestScope,
    input: {
      inventoryState: InventoryState;
      backingState?: BackingState;
      search: string;
      pageSize: number;
      cursor?: string;
      cursorCodec: ThreadCursorCodec;
    },
  ): ThreadListResult {
    return this.repository.listThreads(scope, input);
  }

  reconcileDiscoveredNativeSession(
    scope: RequestScope,
    input: Omit<ReconcileNativeSessionInput, "now">,
    now = Date.now(),
  ): ThreadWithState {
    const title = input.title?.trim().slice(0, MAX_TITLE_CHARACTERS) || undefined;
    this.#assertBoundedText(
      input.nativeSessionId,
      240,
      "Native session ID",
    );
    this.#assertBoundedText(
      input.canonicalSessionPath,
      4096,
      "Native session path",
    );
    if (!Number.isFinite(input.updatedAt) || input.updatedAt < 0) {
      throw new DomainError(
        "invalid_transition",
        "Native session activity time is invalid.",
      );
    }
    return this.repository.reconcileDiscoveredNativeSession(scope, {
      ...input,
      title,
      updatedAt: Math.min(input.updatedAt, now),
      now,
    });
  }

  finishNativeDiscovery(
    scope: RequestScope,
    environmentId: string,
    seenNativeSessionIds: ReadonlySet<string>,
    now = Date.now(),
  ): ThreadWithState[] {
    return this.repository.finishNativeDiscovery(
      scope,
      environmentId,
      seenNativeSessionIds,
      now,
    );
  }

  quarantineNativeSessions(
    scope: RequestScope,
    environmentId: string,
    nativeSessionIds: readonly string[],
    canonicalSessionPaths: readonly string[],
    now = Date.now(),
  ): ThreadWithState[] {
    return this.repository.quarantineNativeSessions(
      scope,
      environmentId,
      nativeSessionIds,
      canonicalSessionPaths,
      now,
    );
  }

  prepareFirstSend(
    scope: RequestScope,
    threadId: string,
    input: {
      expectedDraftRevision: number;
      mutationId: string;
      reservedNativeSessionId: string;
    },
    now = Date.now(),
  ): FirstSendPreparation {
    const draft = this.repository.getDraft(scope, threadId);
    this.#assertUtf8Bytes(draft.text, MAX_DRAFT_BYTES, "First prompt");
    return this.repository.prepareFirstSend(scope, threadId, {
      ...input,
      attemptId: randomUUID(),
      now,
    });
  }

  prepareAutomationFirstSend(
    scope: RequestScope,
    threadId: string,
    input: {
      prompt: string;
      automationId: string;
      automationRunId: string;
      mutationId: string;
      reservedNativeSessionId: string;
    },
    now = Date.now(),
  ): FirstSendPreparation {
    this.#assertUtf8Bytes(input.prompt, MAX_DRAFT_BYTES, "Automation prompt");
    return this.repository.prepareAutomationFirstSend(scope, threadId, {
      ...input,
      attemptId: randomUUID(),
      now,
    });
  }

  markSubmitting(
    scope: RequestScope,
    threadId: string,
    attemptId: string,
    now = Date.now(),
  ): ThreadWithState {
    return this.repository.setMaterializationPhase(
      scope,
      threadId,
      attemptId,
      "submitting",
      now,
    );
  }

  activateForAutomation(
    scope: RequestScope,
    threadId: string,
    now = Date.now(),
  ) {
    const state = this.repository.activateForAutomation(scope, threadId, now);
    this.publisher.publishInventoryChanged({ scope, threadId, state });
    return state;
  }

  markAcceptedUnpersisted(
    scope: RequestScope,
    threadId: string,
    attemptId: string,
    now = Date.now(),
  ): ThreadWithState {
    return this.repository.setMaterializationPhase(
      scope,
      threadId,
      attemptId,
      "accepted_unpersisted",
      now,
    );
  }

  markMaterializationUncertain(
    scope: RequestScope,
    threadId: string,
    attemptId: string,
    now = Date.now(),
  ): ThreadWithState {
    return this.repository.markMaterializationUncertain(
      scope,
      threadId,
      attemptId,
      now,
    );
  }

  markAbortedUnpersisted(
    scope: RequestScope,
    threadId: string,
    attemptId: string,
    now = Date.now(),
  ): ThreadWithState {
    return this.repository.setMaterializationPhase(
      scope,
      threadId,
      attemptId,
      "aborted_unpersisted",
      now,
    );
  }

  bindNativeSession(
    scope: RequestScope,
    threadId: string,
    input: {
      attemptId: string;
      nativeSessionPath: string;
      promptVerified: boolean;
    },
    now = Date.now(),
  ): ThreadWithState {
    return this.repository.bindNativeSession(scope, threadId, {
      ...input,
      now,
    });
  }

  getStartPreferences(scope: RequestScope, threadId: string) {
    return this.repository.getStartPreferences(scope, threadId);
  }

  getPendingFirstSend(scope: RequestScope, threadId: string) {
    return this.repository.getPendingFirstSend(scope, threadId);
  }

  updateThreadConfiguration(
    scope: RequestScope,
    threadId: string,
    input: {
      expectedRevision: number;
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
      toolMode: "read_only" | "full";
    },
    now = Date.now(),
  ) {
    return this.repository.updateThreadConfiguration(scope, threadId, {
      ...input,
      now,
    });
  }

  moveDraftThread(
    scope: RequestScope,
    threadId: string,
    input: {
      workspaceId: string;
      expectedRevision: number;
      mutationId: string;
    },
    now = Date.now(),
  ) {
    return this.repository.moveDraftThread(
      scope,
      threadId,
      { ...input, now },
    );
  }

  renameThread(
    scope: RequestScope,
    threadId: string,
    input: {
      title: string;
      expectedRevision: number;
      mutationId: string;
    },
    now = Date.now(),
  ) {
    this.#assertBoundedText(input.title, MAX_TITLE_CHARACTERS, "Thread title");
    return this.repository.renameThread(scope, threadId, { ...input, now });
  }

  beginNativeOperation(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      kind: NativeOperationKind;
      request: unknown;
    },
    now = Date.now(),
  ) {
    return this.repository.beginNativeOperation(
      scope,
      threadId,
      { ...input, now },
    );
  }

  prepareMaterializationRetry(
    scope: RequestScope,
    threadId: string,
    input: {
      attemptId: string;
      mutationId: string;
      anchorEntryId: string | null;
      anchorEntryCount: number;
    },
    now = Date.now(),
  ) {
    return this.repository.prepareMaterializationRetry(
      scope,
      threadId,
      { ...input, now },
    );
  }

  completeNativeOperation(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      kind: NativeOperationKind;
      request: unknown;
    },
    now = Date.now(),
  ): void {
    this.repository.completeNativeOperation(
      scope,
      threadId,
      { ...input, now },
    );
  }

  cancelNativeOperationBeforeSubmission(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      kind: NativeOperationKind;
      request: unknown;
    },
  ): void {
    this.repository.cancelNativeOperationBeforeSubmission(
      scope,
      threadId,
      input,
    );
  }

  completeNativeSend(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      delivery: "normal" | "steer" | "followUp";
      expectedDraftRevision: number;
    },
    now = Date.now(),
  ) {
    return this.repository.completeNativeSend(
      scope,
      threadId,
      { ...input, now },
    );
  }

  completeNativeRename(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      title: string;
      expectedRevision: number;
    },
    now = Date.now(),
  ) {
    this.#assertBoundedText(input.title, MAX_TITLE_CHARACTERS, "Thread title");
    return this.repository.completeNativeRename(
      scope,
      threadId,
      { ...input, now },
    );
  }

  completeNativeConfiguration(
    scope: RequestScope,
    threadId: string,
    input: {
      mutationId: string;
      request: unknown;
      expectedRevision: number;
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
      toolMode: "read_only" | "full";
    },
    now = Date.now(),
  ) {
    return this.repository.completeNativeConfiguration(
      scope,
      threadId,
      { ...input, now },
    );
  }

  resolveDefiniteFirstSendFailure(
    scope: RequestScope,
    threadId: string,
    attemptId: string,
    now = Date.now(),
  ) {
    return this.repository.resolveDefiniteFirstSendFailure(
      scope,
      threadId,
      attemptId,
      now,
    );
  }

  resolveMaterializationRecovery(
    scope: RequestScope,
    threadId: string,
    input: {
      action: "restore_to_draft" | "discard";
      expectedDraftRevision?: number;
      mutationId: string;
    },
    now = Date.now(),
  ) {
    if (input.action === "restore_to_draft") {
      const current = this.repository.getThread(scope, threadId);
      const pending = this.repository.getPendingFirstSend(scope, threadId);
      if (pending) {
        const separatorBytes = current.draft.text.length === 0 ? 0 : 2;
        if (
          Buffer.byteLength(current.draft.text, "utf8") +
            separatorBytes +
            Buffer.byteLength(pending.text, "utf8") >
          MAX_DRAFT_BYTES
        ) {
          throw new DomainError(
            "invalid_transition",
            "Restoring the first prompt would exceed the draft size limit.",
          );
        }
      }
    }
    return this.repository.resolveMaterializationRecovery(scope, threadId, {
      ...input,
      now,
    });
  }

  replayMaterializationRecovery(
    scope: RequestScope,
    threadId: string,
    input: {
      action: "restore_to_draft" | "discard";
      expectedDraftRevision?: number;
      mutationId: string;
    },
  ) {
    return this.repository.replayMaterializationRecovery(
      scope,
      threadId,
      input,
    );
  }

  #assertBoundedText(value: string, maximumCharacters: number, label: string): void {
    if (value.length === 0 || value.length > maximumCharacters) {
      throw new DomainError(
        "invalid_transition",
        `${label} must contain between 1 and ${maximumCharacters} characters.`,
      );
    }
  }

  #assertUtf8Bytes(value: string, maximumBytes: number, label: string): void {
    if (Buffer.byteLength(value, "utf8") > maximumBytes) {
      throw new DomainError(
        "invalid_transition",
        `${label} exceeds the ${maximumBytes}-byte limit.`,
      );
    }
  }
}

export const threadInventoryLimits = Object.freeze({
  maximumDraftBytes: MAX_DRAFT_BYTES,
  maximumStashesPerThread: MAX_STASHES_PER_THREAD,
});
