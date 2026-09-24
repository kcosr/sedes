import { NotificationSettingsStore } from "./NotificationSettingsStore.js";
import { useSyncExternalStore } from "react";
import type {
  AssociatedTask,
  BulkInventoryAction,
  BulkInventoryImpact,
  BulkInventoryMutationRequest,
  BulkInventoryMutationResult,
  CreateThreadFromSettingsRequest,
  CreateThreadRequest,
  CreateThreadResult,
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
  NormalizedThreadDescendant,
  NormalizedThreadLineagePlacement,
  OpenTaskDisposition,
  Task,
  TaskScope,
  ThreadArchiveImpact,
  ThreadExecutionWorkspaceResource,
  DeleteThreadExecutionWorkspaceResult,
  ImportThreadExecutionWorkspaceResult,
  HandoffThreadExecutionWorkspaceResult,
  InventoryTransitionRequest,
  NormalizedThreadGroup,
  ThreadForceResetImpact,
  ThreadForceResetResult,
} from "../../shared/index.js";
import { createThreadSearchMatcher } from "../lineage/sidebar-search.js";
import { ApiError, type ApiClient } from "../api/ApiClient.js";
import type {
  ConnectionState,
  EventStreamTransport,
  StreamSubscription,
} from "../api/EventStreamTransport.js";
import { NormalizedApplicationStore } from "./NormalizedApplicationStore.js";
import { CannedPromptClientStore } from "./CannedPromptClientStore.js";

const MAXIMUM_LOADED_DESCENDANTS = 10_000;
const MAXIMUM_PENDING_CREATED_THREAD_WORKSPACES = 256;
const MAXIMUM_THREAD_CONFIGURATION_COPY_ATTEMPTS = 256;
const MAXIMUM_APPLICATION_INVENTORY_REPLACEMENTS = 3;

type ThreadConfigurationCopyAttempt = {
  readonly request: CreateThreadFromSettingsRequest;
  pending?: Promise<CreateThreadResult>;
};

export interface ApplicationClientState {
  readonly status: "loading" | "ready" | "error";
  readonly error?: string;
  readonly connection: ConnectionState;
  readonly authoritative: boolean;
  /** The connected server's Sedes product version, absent until the handshake lands. */
  readonly serverVersion?: string;
  readonly providerPulseEnabled: boolean;
  readonly experimentalUsageEnabled: boolean;
  readonly search: string;
  readonly snapshot?: NormalizedApplicationSnapshot;
  readonly visibleThreads: readonly NormalizedApplicationThreadSummary[];
  readonly descendantPages: Readonly<Record<string, DescendantPageState>>;
  readonly pendingThreadConfigurationCopySourceIds: readonly string[];
}

export interface DescendantPageState {
  readonly descendants: readonly NormalizedThreadDescendant[];
  readonly nextCursor?: string;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly error?: string;
}

const initialState: ApplicationClientState = {
  status: "loading",
  connection: "reconnecting",
  authoritative: false,
  providerPulseEnabled: false,
  experimentalUsageEnabled: false,
  search: "",
  visibleThreads: [],
  descendantPages: {},
  pendingThreadConfigurationCopySourceIds: [],
};

export class ApplicationClientStore {
  readonly api: ApiClient;
  readonly transport: EventStreamTransport;
  readonly normalized = new NormalizedApplicationStore();
  readonly notifications: NotificationSettingsStore;
  readonly cannedPrompts: CannedPromptClientStore;
  #state = initialState;
  readonly #listeners = new Set<() => void>();
  #subscription?: StreamSubscription;
  #normalizedUnsubscribe?: () => void;
  #initializing?: Promise<void>;
  #refreshing?: Promise<void>;
  #finishInventoryRefresh?: () => void;
  #inventoryReplacementRequested = false;
  #inventoryReplacementFailureReason?: string;
  #terminalSessionFailure = false;
  #resuming?: Promise<void>;
  #hasConnected = false;
  #reconnectSessionRefresh?: Promise<void>;
  #reconnectSessionRefreshNeeded = false;
  #sessionRequestSequence = 0;
  readonly #descendantLoads = new Map<string, Promise<void>>();
  readonly #pendingCreatedThreadWorkspaces = new Map<string, string>();
  readonly #threadConfigurationCopyAttempts = new Map<
    string,
    ThreadConfigurationCopyAttempt
  >();
  #disposed = false;

  constructor(api: ApiClient, transport: EventStreamTransport) {
    this.api = api;
    this.transport = transport;
    this.notifications = new NotificationSettingsStore(api);
    this.cannedPrompts = new CannedPromptClientStore(api);
    this.#normalizedUnsubscribe = this.normalized.subscribe(() => {
      this.#deriveNormalizedState();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ApplicationClientState => this.#state;

  initialize(): Promise<void> {
    if (!this.#initializing) this.#initializing = this.#start();
    return this.#initializing;
  }

  refresh(): Promise<void> {
    if (!this.#refreshing) {
      if (!this.#inventoryReplacementRequested) {
        this.#inventoryReplacementFailureReason = undefined;
      }
      this.#inventoryReplacementRequested = true;
      const reloadSession = this.#state.status === "error";
      this.#refreshing = (async () => {
        if (reloadSession) {
          this.#replaceState({
            ...this.#state,
            status: "loading",
            error: undefined,
          });
          await this.#loadSession(true, true);
        }
        await this.#replaceInventoryStreams();
      })().finally(() => {
        this.#refreshing = undefined;
      });
    }
    return this.#refreshing;
  }

  resume(): Promise<void> {
    if (!this.#disposed) this.transport.reconnectAll();
    if (!this.#resuming) {
      this.#resuming = (async () => {
        let failed = false;
        let terminalFailure = false;
        let failure: unknown;
        try {
          await this.#loadSession(true);
        } catch (error) {
          failed = true;
          terminalFailure = error instanceof ApiError && !error.retryable;
          failure = error;
        }
        if (!this.#disposed) {
          if (terminalFailure) {
            this.#inventoryReplacementRequested = false;
            this.#finishInventoryRefresh?.();
            this.#subscription?.close();
            this.#subscription = undefined;
          }
        }
        if (failed) throw failure;
      })().finally(() => {
        this.#resuming = undefined;
      });
    }
    return this.#resuming;
  }

  setSearch(search: string): void {
    this.#replaceState({
      ...this.#state,
      search,
      visibleThreads: filterAndSortThreads(
        this.#state.snapshot?.threads ?? [],
        search,
        this.#state.snapshot,
      ),
    });
  }

  getThreadSummaries(): readonly NormalizedApplicationThreadSummary[] {
    return this.#state.snapshot?.threads ?? [];
  }

  workspaceIdForThread = (threadId: string): string | undefined => {
    return (
      this.#state.snapshot?.threads.find(({ id }) => id === threadId)
        ?.workspaceId ?? this.#pendingCreatedThreadWorkspaces.get(threadId)
    );
  };

  async createThread(
    request: CreateThreadRequest,
  ): Promise<CreateThreadResult> {
    const result = await this.api.createThread(request);
    this.#trackCreatedThread(result);
    return result;
  }

  async createThreadFromSettings(
    sourceThreadId: string,
    input: Pick<CreateThreadFromSettingsRequest, "title">,
  ): Promise<CreateThreadResult> {
    let attempt = this.#threadConfigurationCopyAttempts.get(sourceThreadId);
    if (attempt && attempt.request.title !== input.title) {
      throw new Error(
        "A settings-copy retry must retain its original thread title.",
      );
    }
    if (!attempt) {
      this.#makeRoomForThreadConfigurationCopyAttempt();
      attempt = {
        request: { title: input.title, mutationId: crypto.randomUUID() },
      };
      this.#threadConfigurationCopyAttempts.set(sourceThreadId, attempt);
    }
    if (attempt.pending) return attempt.pending;
    const currentAttempt = attempt;
    this.#setThreadConfigurationCopyPending(sourceThreadId, true);
    currentAttempt.pending = this.api
      .createThreadFromSettings(sourceThreadId, currentAttempt.request)
      .then((result) => {
        this.#trackCreatedThread(result);
        if (
          this.#threadConfigurationCopyAttempts.get(sourceThreadId) ===
          currentAttempt
        ) {
          this.#threadConfigurationCopyAttempts.delete(sourceThreadId);
        }
        return result;
      })
      .catch((error: unknown) => {
        currentAttempt.pending = undefined;
        throw error;
      })
      .finally(() => {
        this.#setThreadConfigurationCopyPending(sourceThreadId, false);
      });
    return currentAttempt.pending;
  }

  #setThreadConfigurationCopyPending(
    sourceThreadId: string,
    pending: boolean,
  ): void {
    const current = this.#state.pendingThreadConfigurationCopySourceIds;
    const alreadyPending = current.includes(sourceThreadId);
    if (alreadyPending === pending) return;
    this.#replaceState({
      ...this.#state,
      pendingThreadConfigurationCopySourceIds: pending
        ? [...current, sourceThreadId]
        : current.filter((threadId) => threadId !== sourceThreadId),
    });
  }

  #makeRoomForThreadConfigurationCopyAttempt(): void {
    if (
      this.#threadConfigurationCopyAttempts.size <
      MAXIMUM_THREAD_CONFIGURATION_COPY_ATTEMPTS
    ) {
      return;
    }
    for (const [sourceThreadId, attempt] of this
      .#threadConfigurationCopyAttempts) {
      if (!attempt.pending) {
        this.#threadConfigurationCopyAttempts.delete(sourceThreadId);
        return;
      }
    }
  }

  #trackCreatedThread(result: CreateThreadResult): void {
    const { threadId, workspaceId } = result;
    if (!this.#state.snapshot?.threads.some(({ id }) => id === threadId)) {
      this.#pendingCreatedThreadWorkspaces.set(threadId, workspaceId);
      if (
        this.#pendingCreatedThreadWorkspaces.size >
        MAXIMUM_PENDING_CREATED_THREAD_WORKSPACES
      ) {
        const oldest = this.#pendingCreatedThreadWorkspaces.keys().next().value;
        if (oldest !== undefined) {
          this.#pendingCreatedThreadWorkspaces.delete(oldest);
        }
      }
    }
  }

  async openWorkspace(path: string, environmentId: string): Promise<string> {
    return this.api.openWorkspace(path, environmentId);
  }

  async reopenWorkspace(workspaceId: string): Promise<string> {
    return this.api.reopenWorkspace(workspaceId);
  }

  async mutateInventory(
    thread: NormalizedApplicationThreadSummary,
    action:
      | "settle"
      | "unsettle"
      | "snooze"
      | "remind"
      | "wake"
      | "archive"
      | "restore",
    options?: {
      readonly snoozedUntil?: string;
      readonly wakeReminder?: string;
      readonly openTaskDisposition?: OpenTaskDisposition;
      readonly expectedStashedPromptCount?: number;
      readonly executionWorkspaceDisposition?:
        | { readonly kind: "keep" }
        | {
            readonly kind: "delete";
            readonly expectedRevision: number;
            readonly operationId: string;
          };
    },
  ): Promise<void> {
    if (action === "snooze" && !options?.snoozedUntil) {
      throw new Error("A snooze deadline is required.");
    }
    if (action === "remind" && !options?.wakeReminder?.trim()) {
      throw new Error("Reminder text is required.");
    }
    if (
      (action === "archive" || action === "settle") &&
      options?.expectedStashedPromptCount === undefined
    ) {
      throw new Error(
        "A confirmed stashed-prompt count is required for this action.",
      );
    }
    await this.api.mutateInventory(thread.id, {
      action,
      expectedRevision: thread.inventoryRevision,
      mutationId: crypto.randomUUID(),
      ...(action === "snooze" || action === "remind"
        ? {
            ...(action === "snooze"
              ? { snoozedUntil: options!.snoozedUntil! }
              : {}),
            ...(options!.wakeReminder?.trim()
              ? { wakeReminder: options!.wakeReminder!.trim() }
              : {}),
          }
        : {}),
      ...((action === "archive" || action === "settle") &&
      options?.openTaskDisposition
        ? { openTaskDisposition: options.openTaskDisposition }
        : {}),
      ...((action === "archive" || action === "settle") &&
      options?.expectedStashedPromptCount !== undefined
        ? { expectedStashedPromptCount: options.expectedStashedPromptCount }
        : {}),
      ...(action === "archive"
        ? {
            executionWorkspaceDisposition:
              options?.executionWorkspaceDisposition ?? { kind: "keep" },
          }
        : {}),
    });
  }

  async setThreadPinned(
    thread: NormalizedApplicationThreadSummary,
    pinned: boolean,
  ): Promise<void> {
    await this.api.mutateThreadPin(thread.id, {
      pinned,
      expectedRevision: thread.pinRevision,
      mutationId: crypto.randomUUID(),
    });
  }

  getThreadArchiveImpact(threadId: string): Promise<ThreadArchiveImpact> {
    return this.api.getThreadArchiveImpact(threadId);
  }

  getBulkInventoryImpact(
    action: BulkInventoryAction,
    threadIds: readonly string[],
  ): Promise<BulkInventoryImpact> {
    return this.api.getBulkInventoryImpact({
      action,
      threadIds: [...threadIds],
    });
  }

  createBulkInventoryMutationRequest(
    impact: BulkInventoryImpact,
    options: { readonly openTaskDisposition?: OpenTaskDisposition } = {},
  ): BulkInventoryMutationRequest {
    const targets = impact.targets.map((target) => ({ ...target }));
    for (const target of targets) Object.freeze(target);
    Object.freeze(targets);
    const mutationId = crypto.randomUUID();
    if (impact.action === "unsettle") {
      const request: BulkInventoryMutationRequest = {
        action: "unsettle",
        targets,
        mutationId,
      };
      Object.freeze(request);
      return request;
    }
    const confirmed = {
      targets,
      expectedStashedPromptCount: impact.stashedPromptCount,
      expectedOpenTaskCount: impact.openTasks.total,
      ...(impact.openTasks.total > 0 && options.openTaskDisposition
        ? { openTaskDisposition: options.openTaskDisposition }
        : {}),
      mutationId,
    };
    const request: BulkInventoryMutationRequest =
      impact.action === "settle"
        ? { action: "settle", ...confirmed }
        : { action: "archive", ...confirmed };
    Object.freeze(request);
    return request;
  }

  mutateBulkInventory(
    request: BulkInventoryMutationRequest,
  ): Promise<BulkInventoryMutationResult> {
    return this.api.mutateBulkInventory(request);
  }

  getThreadExecutionWorkspace(
    threadId: string,
  ): Promise<ThreadExecutionWorkspaceResource> {
    return this.api.getThreadExecutionWorkspace(threadId);
  }

  deleteThreadExecutionWorkspace(
    threadId: string,
    expectedRevision: number,
  ): Promise<DeleteThreadExecutionWorkspaceResult> {
    return this.api.deleteThreadExecutionWorkspace(threadId, {
      expectedRevision,
      operationId: crypto.randomUUID(),
    });
  }

  importThreadExecutionWorkspace(
    threadId: string,
    expectedRevision: number,
  ): Promise<ImportThreadExecutionWorkspaceResult> {
    return this.api.importThreadExecutionWorkspace(threadId, {
      expectedRevision,
      operationId: crypto.randomUUID(),
    });
  }

  handoffThreadExecutionWorkspace(
    threadId: string,
    expectedRevision: number,
  ): Promise<HandoffThreadExecutionWorkspaceResult> {
    return this.api.handoffThreadExecutionWorkspace(threadId, {
      expectedRevision,
      operationId: crypto.randomUUID(),
    });
  }

  getThreadForceResetImpact(threadId: string): Promise<ThreadForceResetImpact> {
    return this.api.getThreadForceResetImpact(threadId);
  }

  forceResetThread(
    threadId: string,
    expectedBlockerFingerprint: string,
    mutationId: string,
  ): Promise<ThreadForceResetResult> {
    return this.api.forceResetThread(
      threadId,
      expectedBlockerFingerprint,
      mutationId,
    );
  }

  async archiveThreadFamily(
    thread: NormalizedApplicationThreadSummary,
    options: {
      readonly expectedStashedPromptCount: number;
      readonly openTaskDisposition?: OpenTaskDisposition;
      readonly executionWorkspaceDisposition: Extract<
        InventoryTransitionRequest,
        { action: "archive_family" }
      >["executionWorkspaceDisposition"];
    },
  ): Promise<readonly string[]> {
    const result = await this.api.archiveThreads(thread.id, {
      action: "archive_family",
      expectedRevision: thread.inventoryRevision,
      expectedStashedPromptCount: options.expectedStashedPromptCount,
      executionWorkspaceDisposition: options.executionWorkspaceDisposition,
      mutationId: crypto.randomUUID(),
      ...(options?.openTaskDisposition
        ? { openTaskDisposition: options.openTaskDisposition }
        : {}),
    });
    return result.archivedThreadIds;
  }

  getTasks(): readonly AssociatedTask[] {
    return this.#state.snapshot?.tasks ?? [];
  }

  async createTask(title: string, scope: TaskScope): Promise<Task> {
    return this.api.createTask({
      mutationId: crypto.randomUUID(),
      title,
      scope,
    });
  }

  async updateTask(
    task: Task,
    changes: {
      readonly title?: string;
      readonly details?: string;
      readonly completed?: boolean;
      readonly scope?: TaskScope;
      readonly pinned?: boolean;
      readonly files?: readonly string[];
    },
  ): Promise<Task> {
    const { files, ...otherChanges } = changes;
    return this.api.updateTask(task.id, {
      mutationId: crypto.randomUUID(),
      expectedRevision: task.revision,
      ...otherChanges,
      ...(files === undefined ? {} : { files: [...files] }),
    });
  }

  async moveTask(
    task: Task,
    scope: TaskScope,
    mutationId: string = crypto.randomUUID(),
  ): Promise<Task> {
    return this.api.moveTask(task.id, {
      mutationId,
      expectedRevision: task.revision,
      scope,
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.api.deleteTask(taskId);
  }

  /**
   * Renames a thread from inventory context (sidebar rows) without spinning
   * up its ThreadClientStore: the server accepts rename as a thread
   * operation, and the summary's `threadRevision` is the freshest revision
   * the application stream knows. The summary carries no per-operation
   * capabilities, so feasibility stays server-checked — callers surface a
   * rejection non-destructively instead of pre-filtering.
   */
  async renameThread(
    thread: NormalizedApplicationThreadSummary,
    title: string,
  ): Promise<void> {
    await this.api.operateThread(thread.id, {
      kind: "perform",
      mutationId: crypto.randomUUID(),
      expectedThreadRevision: thread.threadRevision,
      operation: { action: "rename", title },
    });
  }

  createThreadGroup(
    thread: NormalizedApplicationThreadSummary,
    name: string,
  ): Promise<unknown> {
    return this.api.mutateThreadGroup(thread.id, {
      action: "create",
      name,
      expectedRevision: thread.groupAssignmentRevision,
      mutationId: crypto.randomUUID(),
    });
  }

  assignThreadGroup(
    thread: NormalizedApplicationThreadSummary,
    groupId: string,
  ): Promise<unknown> {
    return this.api.mutateThreadGroup(thread.id, {
      action: "assign",
      groupId,
      expectedRevision: thread.groupAssignmentRevision,
      mutationId: crypto.randomUUID(),
    });
  }

  removeThreadGroup(
    thread: NormalizedApplicationThreadSummary,
  ): Promise<unknown> {
    return this.api.mutateThreadGroup(thread.id, {
      action: "remove",
      expectedRevision: thread.groupAssignmentRevision,
      mutationId: crypto.randomUUID(),
    });
  }

  renameThreadGroup(
    group: NormalizedThreadGroup,
    name: string,
  ): Promise<unknown> {
    return this.api.mutateGroup(group.id, {
      action: "rename",
      name,
      expectedRevision: group.revision,
      mutationId: crypto.randomUUID(),
    });
  }

  deleteThreadGroup(group: NormalizedThreadGroup): Promise<unknown> {
    return this.api.mutateGroup(group.id, {
      action: "delete",
      expectedRevision: group.revision,
      expectedMemberCount: group.memberCount,
      mutationId: crypto.randomUUID(),
    });
  }

  loadMoreDescendants(threadId: string): Promise<void> {
    const current = this.#descendantLoads.get(threadId);
    if (current) return current;
    const page = this.#state.descendantPages[threadId];
    if (page?.loaded && !page.nextCursor) return Promise.resolve();
    this.#replaceState({
      ...this.#state,
      descendantPages: {
        ...this.#state.descendantPages,
        [threadId]: {
          descendants: page?.descendants ?? [],
          ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}),
          loading: true,
          loaded: page?.loaded ?? false,
        },
      },
    });
    const operation = this.api
      .listThreadDescendants(threadId, {
        ...(page?.nextCursor ? { cursor: page.nextCursor } : {}),
        pageSize: 50,
      })
      .then((result) => {
        const latest = this.#state.descendantPages[threadId];
        const bootstrapThreadIds = new Set(
          this.#state.snapshot?.threads.map(({ id }) => id) ?? [],
        );
        const byId = new Map(
          (latest?.descendants ?? [])
            .filter(
              (descendant) => !bootstrapThreadIds.has(descendant.thread.id),
            )
            .map((descendant) => [descendant.thread.id, descendant]),
        );
        for (const descendant of result.descendants) {
          if (bootstrapThreadIds.has(descendant.thread.id)) continue;
          byId.set(descendant.thread.id, descendant);
        }
        const descendants = [...byId.values()].slice(
          0,
          MAXIMUM_LOADED_DESCENDANTS,
        );
        this.#replaceState({
          ...this.#state,
          descendantPages: {
            ...this.#state.descendantPages,
            [threadId]: {
              descendants,
              ...(result.nextCursor &&
              descendants.length < MAXIMUM_LOADED_DESCENDANTS
                ? { nextCursor: result.nextCursor }
                : {}),
              loading: false,
              loaded: true,
            },
          },
        });
      })
      .catch((error: unknown) => {
        const latest = this.#state.descendantPages[threadId];
        this.#replaceState({
          ...this.#state,
          descendantPages: {
            ...this.#state.descendantPages,
            [threadId]: {
              descendants: latest?.descendants ?? [],
              ...(latest?.nextCursor ? { nextCursor: latest.nextCursor } : {}),
              loading: false,
              loaded: latest?.loaded ?? false,
              error: messageFrom(error),
            },
          },
        });
        throw error;
      })
      .finally(() => {
        this.#descendantLoads.delete(threadId);
      });
    this.#descendantLoads.set(threadId, operation);
    return operation;
  }

  async updateLineagePlacement(
    placement: NormalizedThreadLineagePlacement,
    mode: "nested_under_source" | "top_level",
  ): Promise<void> {
    await this.api.updateThreadLineagePlacement(placement.childThreadId, {
      mode,
      expectedRevision: placement.revision,
      mutationId: crypto.randomUUID(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#finishInventoryRefresh?.();
    this.cannedPrompts.dispose();
    this.notifications.dispose();
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#normalizedUnsubscribe?.();
    this.#normalizedUnsubscribe = undefined;
    this.#listeners.clear();
  }

  async #start(): Promise<void> {
    this.#replaceState({ ...this.#state, status: "loading", error: undefined });
    await this.#loadSession();
    if (this.#disposed) return;
    this.#subscribeToEvents();
  }

  async #replaceInventoryStream(): Promise<void> {
    if (this.#disposed) return;
    const authoritative = new Promise<void>((resolve) => {
      let unsubscribe: () => void = () => undefined;
      const finish = () => {
        unsubscribe();
        if (this.#finishInventoryRefresh === finish) {
          this.#finishInventoryRefresh = undefined;
        }
        resolve();
      };
      unsubscribe = this.normalized.subscribe(() => {
        if (this.#disposed || this.normalized.state.authoritative) finish();
      });
      this.#finishInventoryRefresh = finish;
    });
    this.normalized.resetInventory();
    this.#subscribeToEvents("authoritative_replacement");
    if (this.normalized.state.authoritative) {
      this.#finishInventoryRefresh?.();
    }
    await authoritative;
  }

  async #replaceInventoryStreams(): Promise<void> {
    let replacements = 0;
    while (this.#inventoryReplacementRequested && !this.#disposed) {
      this.#inventoryReplacementRequested = false;
      replacements += 1;
      await this.#replaceInventoryStream();
      if (
        this.#inventoryReplacementRequested &&
        replacements >= MAXIMUM_APPLICATION_INVENTORY_REPLACEMENTS
      ) {
        this.#inventoryReplacementRequested = false;
        this.#subscription?.close();
        this.#subscription = undefined;
        const reason =
          this.#inventoryReplacementFailureReason ??
          "replacement inventory was repeatedly rejected";
        this.#replaceState({
          ...this.#state,
          status: "error",
          error: `Application inventory could not be synchronized: ${reason}.`,
        });
      }
    }
    this.#inventoryReplacementFailureReason = undefined;
  }

  #queueInventoryReplacement(reason: string): void {
    if (this.#state.status === "error") return;
    this.#inventoryReplacementRequested = true;
    this.#inventoryReplacementFailureReason = reason;
    this.#finishInventoryRefresh?.();
    void this.refresh().catch(() => undefined);
  }

  #subscribeToEvents(initialHandshake?: "authoritative_replacement"): void {
    this.#subscription?.close();
    this.#subscription = this.transport.subscribeApplication({
      getReplayCursor: () => this.normalized.replayCursor,
      ...(initialHandshake ? { initialHandshake } : {}),
      onConnection: (connection) => {
        const resumed = connection === "connected" && this.#state.connection !== "connected";
        this.#replaceState({ ...this.#state, connection });
        // An invalidation may arrive just before disconnection while its HTTP
        // read fails. A replay-only live handshake must retry that read too.
        if (resumed) {
          this.normalized.resyncWorkpads();
          // A server restart can change installation-owned features without
          // a browser visibility/online transition. Refresh only the session;
          // resume() would reconnect the stream again.
          if (this.#hasConnected) this.#refreshSessionAfterReconnect();
          this.#hasConnected = true;
        }
      },
      onProtocolError: (error) => {
        this.#replaceState({ ...this.#state, error: error.message });
      },
      onTerminalError: (error) => {
        if (this.#disposed) return;
        if (
          this.normalized.state.authoritative &&
          !this.#terminalSessionFailure
        ) {
          this.#replaceState({
            ...this.#state,
            connection: "disconnected",
            error: error.message,
          });
          return;
        }
        this.#inventoryReplacementRequested = false;
        this.#finishInventoryRefresh?.();
        this.#subscription?.close();
        this.#subscription = undefined;
        this.#replaceState({
          ...this.#state,
          status: "error",
          connection: "disconnected",
          error: error.message,
        });
      },
      onEnvelope: (envelope) => {
        const result = this.normalized.apply(envelope);
        if (result.kind === "resnapshot_required") {
          this.#queueInventoryReplacement(result.reason);
          return;
        }
        if (
          this.normalized.state.authoritative &&
          !this.#terminalSessionFailure
        ) {
          this.#replaceState({
            ...this.#state,
            status: "ready",
            error: undefined,
          });
        }
      },
    });
  }

  #refreshSessionAfterReconnect(): void {
    this.#reconnectSessionRefreshNeeded = true;
    // A newer connection invalidates an older response even while that
    // request is pending. Coalesce repeated reconnects into one follow-up.
    this.#sessionRequestSequence += 1;
    if (this.#reconnectSessionRefresh) return;
    this.#reconnectSessionRefresh = (async () => {
      while (this.#reconnectSessionRefreshNeeded && !this.#disposed) {
        this.#reconnectSessionRefreshNeeded = false;
        await this.#loadSession(true).catch(() => undefined);
      }
    })().finally(() => { this.#reconnectSessionRefresh = undefined; });
  }

  async #loadSession(
    refresh = false,
    terminalOnFailure = !refresh,
  ): Promise<void> {
    const requestSequence = ++this.#sessionRequestSequence;
    try {
      const session = await this.api.session(
        refresh ? { refresh: true } : undefined,
      );
      if (this.#disposed || requestSequence !== this.#sessionRequestSequence) return;
      const result = this.normalized.installSession(session);
      if (result.kind === "resnapshot_required") {
        throw new ApiError(
          502,
          "invalid_application_session",
          `Application session was rejected: ${result.reason}`,
          false,
        );
      }
      this.#terminalSessionFailure = false;
    } catch (error) {
      if (this.#disposed || requestSequence !== this.#sessionRequestSequence) return;
      const nonRetryableSessionFailure =
        error instanceof ApiError && !error.retryable;
      if (nonRetryableSessionFailure) this.#terminalSessionFailure = true;
      const terminal = terminalOnFailure || nonRetryableSessionFailure;
      this.#replaceState({
        ...this.#state,
        status: terminal ? "error" : this.#state.status,
        error: messageFrom(error),
      });
      throw error;
    }
  }

  #deriveNormalizedState(): void {
    const normalized = this.normalized.state;
    for (const { id } of normalized.snapshot?.threads ?? []) {
      this.#pendingCreatedThreadWorkspaces.delete(id);
    }
    this.#replaceState({
      ...this.#state,
      authoritative: normalized.authoritative,
      ...(normalized.serverVersion ? { serverVersion: normalized.serverVersion } : {}),
      providerPulseEnabled: normalized.providerPulseEnabled === true,
      experimentalUsageEnabled: normalized.experimentalUsageEnabled === true,
      snapshot: normalized.snapshot,
      visibleThreads: filterAndSortThreads(
        normalized.snapshot?.threads ?? [],
        this.#state.search,
        normalized.snapshot,
      ),
    });
  }

  #replaceState(state: ApplicationClientState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

export function useApplicationStore(
  store: ApplicationClientStore,
): ApplicationClientState {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

/**
 * Filter matching summaries, then append non-matching nested ancestors so the
 * Projects tree keeps lineage context. Flat views apply the shared indexed
 * matcher to their merged descendant list and omit those context-only rows.
 */
function filterAndSortThreads(
  threads: readonly NormalizedApplicationThreadSummary[],
  search: string,
  snapshot?: NormalizedApplicationSnapshot,
): NormalizedApplicationThreadSummary[] {
  const query = search.trim().toLocaleLowerCase();
  const matchesSearch = createThreadSearchMatcher(search, snapshot);
  const matched = threads.filter(matchesSearch);
  if (query && snapshot) {
    const includedIds = new Set(matched.map(({ id }) => id));
    const origins = new Map(
      snapshot.forkOrigins.map((origin) => [origin.childThreadId, origin]),
    );
    const placements = new Map(
      snapshot.lineagePlacements.map((placement) => [
        placement.childThreadId,
        placement,
      ]),
    );
    const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
    for (const match of matched) {
      const seen = new Set([match.id]);
      let currentId = match.id;
      while (placements.get(currentId)?.mode === "nested_under_source") {
        const sourceId = origins.get(currentId)?.sourceThreadId;
        if (!sourceId || seen.has(sourceId)) break;
        const source = threadsById.get(sourceId);
        if (!source) break;
        includedIds.add(sourceId);
        seen.add(sourceId);
        currentId = sourceId;
      }
    }
    for (const thread of threads) {
      if (includedIds.has(thread.id) && !matched.includes(thread))
        matched.push(thread);
    }
  }
  return matched.sort((left, right) => {
    const stateOrder = {
      active: 0,
      snoozed: 1,
      settled: 2,
      archived: 3,
    } as const;
    const byState =
      stateOrder[left.inventoryState] - stateOrder[right.inventoryState];
    if (byState !== 0) return byState;
    if (left.inventoryState === "snoozed") {
      return (
        (left.snoozedUntil ?? "").localeCompare(right.snoozedUntil ?? "") ||
        left.id.localeCompare(right.id)
      );
    }
    const timestamp =
      left.inventoryState === "active" ? "lastActivityAt" : "stateChangedAt";
    return (
      right[timestamp].localeCompare(left[timestamp]) ||
      left.id.localeCompare(right.id)
    );
  });
}

export function messageFrom(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}
