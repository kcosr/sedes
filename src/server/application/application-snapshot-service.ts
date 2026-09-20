import {
  normalizedApplicationSnapshotSchema,
  type ApplicationEventEnvelope,
  type NormalizedApplicationEvent,
  type NormalizedApplicationSnapshot,
  type NormalizedApplicationThreadSummary,
  type NormalizedThreadForkOrigin,
  type NormalizedThreadLineageFamily,
  type NormalizedThreadLineagePlacement,
} from "../../shared/protocol/application.js";
import type { ThreadRunState } from "../../shared/protocol/conversation.js";
import type { AssociatedTask } from "../../shared/protocol/tasks.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { AssociatedTaskRecord } from "../db/repositories/task-repository.js";
import type { ThreadGroupRepository } from "../db/repositories/thread-group-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { presentAssociatedTask } from "./task-presentation.js";
import type {
  ApplicationEventHub,
  ScopedApplicationEventHubs,
} from "../events/application-event-hub.js";
import type { ThreadRuntimeCoordinator } from "../events/thread-runtime-coordinator.js";
import { boundDisplayText } from "../conversations/payload-policy.js";
import type { ExecutionTargetReader } from "./execution-target-reader.js";
import { isDeepStrictEqual } from "node:util";
import {
  environmentAdmitsForegroundOperation,
  environmentOperationalState,
} from "../domain/environment-operational-state.js";
import {
  NO_INSTALLATION_ADVISORIES,
  type InstallationAdvisoryReader,
} from "./installation-advisory-reader.js";

export type ApplicationThreadDurableSummary = Omit<
  NormalizedApplicationThreadSummary,
  "runState" | "terminalSummary"
>;

export interface ApplicationTerminalSummaryReader {
  summariesByThread(
    scope: RequestScope,
    threadIds: readonly string[],
  ): ReadonlyMap<
    string,
    { readonly runningCount: number; readonly retainedCount: number }
  >;
}

export interface ApplicationThreadSummaryReader {
  forkSelectionSaturated(scope: RequestScope, environmentId: string): boolean;
  structure(
    scope: RequestScope,
    threadId: string,
  ):
    | { environmentId: string; isFork: boolean; isForkSource: boolean }
    | undefined;
  list(
    scope: RequestScope,
    environmentId: string,
  ): readonly ApplicationThreadDurableSummary[];
  listByIds(
    scope: RequestScope,
    threadIds: readonly string[],
  ): readonly ApplicationThreadDurableSummary[];
}

export interface ApplicationTaskReader {
  listAssociated(scope: RequestScope): readonly AssociatedTaskRecord[];
  listAssociatedByThread(
    scope: RequestScope,
    threadId: string,
  ): readonly AssociatedTaskRecord[];
  findAssociated(
    scope: RequestScope,
    taskId: string,
  ): AssociatedTaskRecord | undefined;
}

export interface ApplicationLineageSummaryReader {
  list(
    scope: RequestScope,
    childThreadIds: readonly string[],
  ): {
    readonly forkOrigins: readonly NormalizedThreadForkOrigin[];
    readonly lineagePlacements: readonly NormalizedThreadLineagePlacement[];
    readonly lineageFamilies: readonly NormalizedThreadLineageFamily[];
  };
}

function runState(
  backingState: NormalizedApplicationThreadSummary["backingState"],
  available: boolean,
  loaded: ThreadRunState | undefined,
): ThreadRunState {
  if (backingState === "creating") return "starting";
  if (backingState === "creation_unknown") return "failed";
  if (backingState === "unbound") return "idle";
  if (!available) return "disconnected";
  return loaded ?? "idle";
}

function presentEnvironment(
  environment: ReturnType<InventoryRepository["getEnvironment"]>,
  directoryBrowsing: "available" | "unavailable",
): NormalizedApplicationSnapshot["environments"][number] {
  return {
    id: environment.id,
    kind: environment.kind,
    label: boundDisplayText(environment.label),
    available: environmentAdmitsForegroundOperation(environment),
    directoryBrowsing,
    ...(environmentOperationalState(environment) !== "unavailable"
      ? {}
      : { diagnostic: boundDisplayText(environment.diagnosticCode) }),
  };
}

/**
 * Principal-scoped application projection. It reads durable inventory without
 * attaching dormant backend conversations; a currently loaded actor supplies
 * its live run state.
 */
export class ApplicationSnapshotService {
  readonly captureMetadata = new WeakMap<
    NormalizedApplicationSnapshot,
    ReadonlyMap<string, boolean>
  >();
  constructor(
    readonly inventory: InventoryRepository,
    readonly summaries: ApplicationThreadSummaryReader,
    readonly runtimes: Pick<ThreadRuntimeCoordinator, "captureLoadedState">,
    readonly executionTargets: ExecutionTargetReader,
    readonly lineage: ApplicationLineageSummaryReader,
    readonly tasks: ApplicationTaskReader,
    readonly groups: Pick<ThreadGroupRepository, "list">,
    readonly directoryBrowsingAvailability: (
      scope: RequestScope,
      environmentId: string,
    ) => "available" | "unavailable",
    readonly terminalSummaries: ApplicationTerminalSummaryReader,
    readonly advisories: InstallationAdvisoryReader = NO_INSTALLATION_ADVISORIES,
  ) {}

  async capture(scope: RequestScope): Promise<NormalizedApplicationSnapshot> {
    const environments = this.inventory.listEnvironments(scope);
    const workspaces = this.inventory.listWorkspaces(scope);
    const saturation = new Map(
      environments.map(({ id }) => [
        id,
        this.summaries.forkSelectionSaturated(scope, id),
      ]),
    );
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    const durableThreads = environments.flatMap((environment) =>
      this.summaries.list(scope, environment.id),
    );
    const terminalSummaries = this.terminalSummaries.summariesByThread(
      scope,
      durableThreads.map(({ id }) => id),
    );
    // Keep task associations and thread workspace placement from the same
    // synchronous durable-read turn. A draft can move workspaces while the
    // target/runtime reads below are awaiting; rereading tasks afterward
    // would combine the moved task association with the retained old thread.
    const associatedTasks = this.tasks
      .listAssociated(scope)
      .map(presentAssociatedTask)
      .filter(
        (task) =>
          task.associatedWorkspaceId === null ||
          workspaceIds.has(task.associatedWorkspaceId),
      );
    const targetCatalog = await this.executionTargets.read(scope);
    const environmentIds = new Set(environments.map(({ id }) => id));
    const admittedEnvironmentIds = new Set(
      environments
        .filter(environmentAdmitsForegroundOperation)
        .map(({ id }) => id),
    );
    // Historical profiles outlive removed empty hosts. Keep only descriptors
    // whose environment is present, including hosts retained by workspace history.
    const executionTargets = targetCatalog.executionTargets
      .filter((target) => environmentIds.has(target.environmentId))
      .map((target) =>
        target.available &&
        !admittedEnvironmentIds.has(target.environmentId) &&
        (this.executionTargets.environmentAvailabilityDisposition?.(
          scope,
          target.id,
        ) ?? "requires_available_environment") ===
          "requires_available_environment"
          ? {
              ...target,
              available: false as const,
              unavailableReason: boundDisplayText(
                "The execution environment is unavailable.",
              ),
            }
          : target,
      );
    const defaultNewThreadTargetId =
      targetCatalog.defaultTargetId !== null &&
      executionTargets.some(
        ({ id, available }) =>
          id === targetCatalog.defaultTargetId && available,
      )
        ? targetCatalog.defaultTargetId
        : null;
    const threads = await Promise.all(
      durableThreads.map(async (thread) => {
        const loaded = await this.runtimes.captureLoadedState(scope, thread.id);
        return {
          ...thread,
          terminalSummary: terminalSummaries.get(thread.id) ?? {
            runningCount: 0,
            retainedCount: 0,
          },
          runState: runState(
            thread.backingState,
            thread.available,
            loaded?.runState,
          ),
        };
      }),
    );
    threads.sort(
      (left, right) =>
        Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) ||
        left.id.localeCompare(right.id),
    );
    const lineage = this.lineage.list(
      scope,
      threads.map(({ id }) => id),
    );
    const snapshot = normalizedApplicationSnapshotSchema.parse({
      environments: environments.map((environment) =>
        presentEnvironment(
          environment,
          this.directoryBrowsingAvailability(scope, environment.id),
        ),
      ),
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        environmentId: workspace.environmentId,
        label: boundDisplayText(workspace.displayName),
        displayPath: boundDisplayText(workspace.canonicalPath),
        available: workspace.availability === "available",
      })),
      executionTargets,
      advisories: this.advisories.read(scope),
      defaultNewThreadTargetId,
      threads,
      groups: this.groups.list(scope).map((group) => ({
        id: group.id,
        name: group.name,
        revision: group.revision,
        memberCount: group.memberCount,
        activeMemberCount: group.activeMemberCount,
      })),
      forkOrigins: lineage.forkOrigins,
      lineagePlacements: lineage.lineagePlacements,
      lineageFamilies: lineage.lineageFamilies,
      counts: this.inventory.countThreadsByInventoryState(scope),
      tasks: associatedTasks,
    });
    this.captureMetadata.set(snapshot, saturation);
    return snapshot;
  }
}

export interface PublishedApplicationSnapshot {
  readonly envelope: Omit<ApplicationEventEnvelope, "event"> & {
    readonly event: Extract<NormalizedApplicationEvent, { type: "snapshot" }>;
  };
  readonly snapshot: NormalizedApplicationSnapshot;
}

function applicationScopeKey(scope: RequestScope): string {
  return `${scope.tenantId}\0${scope.principalId}`;
}

/**
 * The sole capture-and-publication boundary for authoritative application
 * snapshots. Publication turns are serialized per principal so an older,
 * slower capture can never be published after a newer capture.
 */
type CaptureWaiter = {
  epoch: number;
  resolve(value: PublishedApplicationSnapshot): void;
  reject(error: unknown): void;
};
type CaptureOperation = {
  waiters: Set<CaptureWaiter>;
  running: boolean;
  done: Promise<void>;
  recovery: boolean;
  timer?: NodeJS.Timeout;
  cancelDelay?: () => void;
};
type ApplicationChange =
  | { kind: "thread"; id: string; forcePublication: boolean }
  | { kind: "task"; id: string }
  | {
      kind: "workpad";
      id: string;
      revision: number;
      change: "document" | "draft";
    };
type WaitingChange = {
  hint: ApplicationChange;
  reading: boolean;
  next?: ApplicationChange;
};

function changeKey(hint: ApplicationChange): string {
  return JSON.stringify([
    hint.kind,
    hint.id,
    hint.kind === "workpad" ? hint.change : null,
  ]);
}
function mergeChange(
  prior: ApplicationChange | undefined,
  next: ApplicationChange,
): ApplicationChange {
  if (prior?.kind === "thread" && next.kind === "thread")
    return {
      ...next,
      forcePublication: prior.forcePublication || next.forcePublication,
    };
  if (prior?.kind === "workpad" && next.kind === "workpad")
    return { ...next, revision: Math.max(prior.revision, next.revision) };
  return next;
}

export class ApplicationSnapshotPublicationBoundary {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #changes = new Set<Promise<void>>();
  readonly #waitingChanges = new Map<
    ApplicationEventHub,
    Map<string, WaitingChange>
  >();
  readonly #captures = new Map<ApplicationEventHub, CaptureOperation>();
  readonly #audits = new Map<ApplicationEventHub, NodeJS.Timeout>();
  readonly #registered = new WeakSet<ApplicationEventHub>();
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(
    readonly snapshots: ApplicationSnapshotService,
    readonly hubs: ScopedApplicationEventHubs,
  ) {}
  hub(scope: RequestScope): ApplicationEventHub {
    if (this.#closing)
      throw new Error("application_snapshot_publication_boundary_closed");
    const hub = this.hubs.application(scope);
    this.#register(hub);
    return hub;
  }
  capture(scope: RequestScope): Promise<NormalizedApplicationSnapshot> {
    return this.snapshots.capture(scope);
  }
  release(scope: RequestScope): void {
    this.hubs.release(scope);
  }
  async flush(): Promise<void> {
    while (this.#tails.size || this.#captures.size || this.#changes.size) {
      // A backoff timer is deliberately outside the lane. Await its owning
      // operation instead of polling the event loop until that timer expires.
      await Promise.allSettled([
        ...this.#tails.values(),
        ...this.#changes,
        ...[...this.#captures.values()].map((operation) => operation.done),
      ]);
    }
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    for (const timer of this.#audits.values()) clearTimeout(timer);
    this.#audits.clear();
    for (const [hub, op] of this.#captures) if (op.timer) hub.close();
    this.#closePromise = this.flush().finally(() => this.hubs.close());
    return this.#closePromise;
  }

  /** Called only after the handshake has registered its listener. */
  async checkpoint(
    scope: RequestScope,
    hub: ApplicationEventHub,
    force = false,
  ): Promise<PublishedApplicationSnapshot> {
    if (this.#closing)
      throw new Error("application_snapshot_publication_boundary_closed");
    this.#assertOwned(scope, hub);
    if (!force && hub.state === "ready" && !hub.pendingReplacement) {
      if (hub.projection?.auditDue()) await this.#audit(scope, hub);
      this.#assertOwned(scope, hub);
      if (hub.state === "ready" && !hub.pendingReplacement) {
        try {
          const envelope = hub.currentCheckpoint()!;
          return { envelope, snapshot: envelope.event.snapshot };
        } catch (error) {
          this.#failed(scope, error, hub);
        }
      }
    }
    if (force || !hub.pendingReplacement) hub.requestedEpoch++;
    return this.#requestCapture(
      scope,
      hub,
      force || hub.invalidReason !== undefined,
    );
  }
  resumed(scope: RequestScope, hub: ApplicationEventHub): void {
    this.#scheduleAudit(scope, hub);
  }

  async publishAuthoritativeReplacement(scope: RequestScope): Promise<void> {
    if (this.#closing)
      throw new Error("application_snapshot_publication_boundary_closed");
    const hub = this.hubs.peek(scope);
    if (!hub) return;
    if (!hub.subscriberCount) {
      this.hubs.retire(scope, hub);
      return;
    }
    hub.requestedEpoch++;
    // A committed mutation admits a hint; its HTTP outcome does not depend on
    // subscriber lifetime, capture latency, or a client's recovery backoff.
    void this.#requestCapture(scope, hub, false).catch((error) =>
      this.#failed(scope, error, hub),
    );
  }
  handoffAuthoritativeReplacement(scope: RequestScope): void {
    const hub = this.hubs.peek(scope);
    void this.publishAuthoritativeReplacement(scope).catch((error) => {
      if (hub) this.#failed(scope, error, hub);
    });
  }
  async publishEnvironmentChange(
    scope: RequestScope,
    environmentId: string,
  ): Promise<void> {
    this.snapshots.inventory.getEnvironment(scope, environmentId);
    await this.publishAuthoritativeReplacement(scope);
  }
  handoffEnvironmentChange(scope: RequestScope, environmentId: string): void {
    const hub = this.hubs.peek(scope);
    void this.publishEnvironmentChange(scope, environmentId).catch((error) => {
      if (hub) this.#failed(scope, error, hub);
    });
  }
  handoffThreadChange(scope: RequestScope, threadId: string): void {
    const hub = this.hubs.peek(scope);
    void this.publishThreadChange(scope, threadId).catch((error) => {
      if (hub) this.#failed(scope, error, hub);
    });
  }

  /** Admit committed bulk structural facts before any per-thread runtime waits. */
  handoffStructuralThreadChanges(
    scope: RequestScope,
    ids: readonly string[],
  ): void {
    const hub = this.hubs.peek(scope);
    if (!hub || this.#closing) return;
    try {
      if (hub.state !== "ready" || hub.pendingReplacement) {
        this.handoffAuthoritativeReplacement(scope);
        return;
      }
      const changed: ApplicationThreadDurableSummary[] = [];
      for (let offset = 0; offset < ids.length; offset += 100)
        changed.push(
          ...this.snapshots.summaries.listByIds(
            scope,
            ids.slice(offset, offset + 100),
          ),
        );
      const byId = new Map(changed.map((thread) => [thread.id, thread]));
      if (
        ids.some((id) =>
          this.#structuralChange(scope, hub, id, byId.get(id) ?? null),
        )
      ) {
        this.handoffAuthoritativeReplacement(scope);
      }
    } catch (error) {
      this.#failed(scope, error, hub);
    }
  }
  #structuralChange(
    scope: RequestScope,
    hub: ApplicationEventHub,
    id: string,
    thread: ApplicationThreadDurableSummary | null,
  ): boolean {
    const prior = hub.projection!.get("threads", id);
    const structure = this.snapshots.summaries.structure(scope, id);
    const groupedCrossing =
      prior &&
      thread &&
      (prior.groupId !== null || thread.groupId !== null) &&
      (prior.groupId !== thread.groupId ||
        (prior.inventoryState === "archived") !==
          (thread.inventoryState === "archived"));
    const moved = prior && thread && prior.workspaceId !== thread.workspaceId;
    const saturated =
      structure && hub.forkSelectionSaturated.get(structure.environmentId);
    const selectionChanged =
      saturated &&
      structure &&
      (structure.isFork || structure.isForkSource) &&
      prior &&
      thread &&
      (prior.pinned !== thread.pinned ||
        prior.groupId !== thread.groupId ||
        prior.inventoryState !== thread.inventoryState);
    return Boolean(
      groupedCrossing ||
        moved ||
        selectionChanged ||
        (!prior && structure?.isFork) ||
        (!thread && hub.projection!.referencesThread(id)),
    );
  }

  async publishThreadChange(
    scope: RequestScope,
    id: string,
    options?: { readonly forcePublication?: boolean },
  ): Promise<void> {
    await this.#change(scope, {
      kind: "thread",
      id,
      forcePublication: options?.forcePublication === true,
    });
  }
  async #publishThreadChange(
    scope: RequestScope,
    hub: ApplicationEventHub,
    id: string,
    forcePublication: boolean,
  ): Promise<void | "retry"> {
    const counts = this.snapshots.inventory.countThreadsByInventoryState(scope);
    const durable = this.snapshots.summaries.listByIds(scope, [id])[0];
    const prior = hub.projection!.get("threads", id);
    let thread: NormalizedApplicationThreadSummary | null = null;
    if (durable) {
      const terminals = this.snapshots.terminalSummaries
        .summariesByThread(scope, [id])
        .get(id) ?? { runningCount: 0, retainedCount: 0 };
      const loaded = await this.snapshots.runtimes.captureLoadedState(
        scope,
        id,
      );
      if (!this.#readyToPublish(scope, hub)) return "retry";
      thread = {
        ...durable,
        terminalSummary: terminals,
        runState: runState(
          durable.backingState,
          durable.available,
          loaded?.runState,
        ),
      };
    }
    if (this.#structuralChange(scope, hub, id, thread)) {
      hub.requestedEpoch++;
      void this.#requestCapture(scope, hub, false).catch((error) =>
        this.#failed(scope, error, hub),
      );
      return;
    }
    const checkpointCounts = hub.projection!.counts;
    if (
      !forcePublication &&
      isDeepStrictEqual(prior ?? null, thread) &&
      isDeepStrictEqual(checkpointCounts, counts)
    )
      return;
    hub.publish(
      thread
        ? {
            type: "thread_upsert",
            generation: hub.generation,
            thread,
            counts,
          }
        : {
            type: "thread_remove",
            generation: hub.generation,
            threadId: id,
            counts,
          },
    );
    if (!this.#readyToPublish(scope, hub)) return "retry";
    if (!prior && thread)
      for (const record of this.snapshots.tasks.listAssociatedByThread(
        scope,
        id,
      )) {
        if (!this.#readyToPublish(scope, hub)) return "retry";
        this.#publishTask(
          hub,
          record.id,
          record.associatedWorkspaceId &&
            this.snapshots.inventory.isWorkspaceRemoved(
              scope,
              record.associatedWorkspaceId,
            )
            ? null
            : presentAssociatedTask(record),
        );
      }
  }
  async publishTaskChange(scope: RequestScope, id: string): Promise<void> {
    await this.#change(scope, { kind: "task", id });
  }
  #publishTaskChange(
    scope: RequestScope,
    hub: ApplicationEventHub,
    id: string,
  ): void {
    const record = this.snapshots.tasks.findAssociated(scope, id);
    const task = record ? presentAssociatedTask(record) : null;
    this.#publishTask(
      hub,
      id,
      task?.associatedWorkspaceId &&
        this.snapshots.inventory.isWorkspaceRemoved(
          scope,
          task.associatedWorkspaceId,
        )
        ? null
        : task,
    );
  }
  async publishWorkpadChange(
    scope: RequestScope,
    workpadId: string,
    revision: number,
    change: "document" | "draft",
  ): Promise<void> {
    await this.#change(scope, {
      kind: "workpad",
      id: workpadId,
      revision,
      change,
    });
  }
  #publishTask(
    hub: ApplicationEventHub,
    id: string,
    task: AssociatedTask | null,
  ): void {
    if (isDeepStrictEqual(hub.projection!.get("tasks", id) ?? null, task))
      return;
    hub.publish(
      task
        ? { type: "task_upsert", generation: hub.generation, task }
        : { type: "task_remove", generation: hub.generation, taskId: id },
    );
  }
  async #change(scope: RequestScope, hint: ApplicationChange): Promise<void> {
    if (this.#closing)
      throw new Error("application_snapshot_publication_boundary_closed");
    const hub = this.hubs.peek(scope);
    if (!hub) return;
    this.#register(hub);
    const key = changeKey(hint);
    let waiting = this.#waitingChanges.get(hub);
    const existing = waiting?.get(key);
    if (existing) {
      // Hints admitted after a durable read starts need one more reread. They
      // cannot be merged into the already captured row and silently discarded.
      if (existing.reading) existing.next = mergeChange(existing.next, hint);
      else existing.hint = mergeChange(existing.hint, hint);
      return;
    }
    let work: Promise<void>;
    if (hub.state !== "ready" || hub.pendingReplacement) {
      if (!waiting) this.#waitingChanges.set(hub, (waiting = new Map()));
      const entry: WaitingChange = { hint, reading: false };
      waiting.set(key, entry);
      work = this.#drainChange(scope, hub, key, entry);
    } else {
      // Preserve ordinary ready-stream forced publications and workpad events.
      work = this.#applyChange(scope, hub, () =>
        this.#dispatchChange(scope, hub, hint),
      );
    }
    this.#changes.add(work);
    void work.then(
      () => {
        this.#changes.delete(work);
      },
      (error) => {
        this.#changes.delete(work);
        this.#failed(scope, error, hub);
      },
    );
  }
  async #dispatchChange(
    scope: RequestScope,
    hub: ApplicationEventHub,
    hint: ApplicationChange,
  ): Promise<void | "retry"> {
    switch (hint.kind) {
      case "thread":
        return this.#publishThreadChange(
          scope,
          hub,
          hint.id,
          hint.forcePublication,
        );
      case "task":
        return this.#publishTaskChange(scope, hub, hint.id);
      case "workpad":
        hub.publish({
          type: "workpad_changed",
          generation: hub.generation,
          workpadId: hint.id,
          revision: hint.revision,
          change: hint.change,
        });
        return;
    }
  }
  async #drainChange(
    scope: RequestScope,
    hub: ApplicationEventHub,
    key: string,
    entry: WaitingChange,
  ): Promise<void> {
    try {
      while (this.hubs.owns(scope, hub)) {
        await this.#applyChange(scope, hub, async () => {
          entry.reading = true;
          const result = await this.#dispatchChange(scope, hub, entry.hint);
          if (result === "retry") {
            if (entry.next) entry.hint = mergeChange(entry.hint, entry.next);
            entry.next = undefined;
            entry.reading = false;
          }
          return result;
        });
        if (!entry.next) return;
        entry.hint = entry.next;
        entry.next = undefined;
        entry.reading = false;
      }
    } finally {
      const waiting = this.#waitingChanges.get(hub);
      if (waiting?.get(key) === entry) waiting.delete(key);
      if (waiting?.size === 0) this.#waitingChanges.delete(hub);
    }
  }
  async #applyChange(
    scope: RequestScope,
    hub: ApplicationEventHub,
    change: (hub: ApplicationEventHub) => Promise<void | "retry">,
  ): Promise<void> {
    while (this.hubs.owns(scope, hub)) {
      if (hub.state !== "ready" || hub.pendingReplacement) {
        if (!hub.subscriberCount) {
          if (hub.state !== "unseeded") this.hubs.retire(scope, hub);
          return;
        }
        if (!hub.pendingReplacement) hub.requestedEpoch++;
        // Ordinary changes join the admitted baseline outside the lane. They
        // do not dirty its capture epoch: reread/fold them after installation,
        // even when publications arrive continuously throughout the capture.
        await this.#requestCapture(scope, hub, false);
      }
      const retry = await this.#serialize(scope, async () => {
        if (!this.hubs.owns(scope, hub)) return;
        if (hub.state !== "ready" || hub.pendingReplacement) return "retry";
        try {
          const result = await change(hub);
          if (
            this.hubs.owns(scope, hub) &&
            hub.subscriberCount &&
            hub.state === "ready" &&
            !hub.pendingReplacement &&
            hub.projection?.auditDue()
          )
            hub.currentCheckpoint();
          this.#scheduleAudit(scope, hub);
          return result;
        } catch (error) {
          this.#failed(scope, error, hub);
        }
      });
      if (retry !== "retry") return;
    }
  }
  #failed(
    scope: RequestScope,
    error: unknown,
    expected?: ApplicationEventHub,
  ): void {
    const hub = this.hubs.peek(scope);
    if (
      !hub ||
      (expected && hub !== expected) ||
      this.#closing ||
      hub.state === "closed"
    )
      return;
    hub.invalidate(
      error instanceof Error ? error.message : "application_publication_failed",
    );
    hub.requestedEpoch++;
    if (!hub.subscriberCount) {
      this.hubs.retire(scope, hub);
      return;
    }
    void this.#requestCapture(scope, hub, true).catch(() => {
      this.hubs.retire(scope, hub);
    });
  }
  #requestCapture(
    scope: RequestScope,
    hub: ApplicationEventHub,
    recovery: boolean,
  ): Promise<PublishedApplicationSnapshot> {
    if (this.#closing)
      return Promise.reject(
        new Error("application_snapshot_publication_boundary_closed"),
      );
    this.#register(hub);
    if (hub.state === "unseeded") hub.beginCapture();
    else if (recovery && hub.state === "ready")
      hub.invalidate("application_client_recovery");
    let op = this.#captures.get(hub);
    if (!op) {
      op = {
        waiters: new Set(),
        running: false,
        done: Promise.resolve(),
        recovery: false,
      };
      this.#captures.set(hub, op);
    }
    op.recovery ||= recovery;
    const operation = op;
    const promise = new Promise<PublishedApplicationSnapshot>(
      (resolve, reject) =>
        operation.waiters.add({ epoch: hub.requestedEpoch, resolve, reject }),
    );
    if (!op.running) {
      op.running = true;
      operation.done = Promise.resolve().then(async () => {
        try {
          while (operation.waiters.size) {
            this.#assertOwned(scope, hub);
            if (!hub.subscriberCount)
              throw new Error("application_projection_unobserved");
            const result = await this.#serialize(scope, async () => {
              this.#assertOwned(scope, hub);
              if (!hub.subscriberCount)
                throw new Error("application_projection_unobserved");
              // Decide at admission: a forced request may have arrived while
              // this turn waited behind an ordinary publication. Delay outside
              // the lane, without consuming a backoff step before capture starts.
              if (operation.recovery) {
                const spacing = Math.min(
                  30_000,
                  Math.max(1_000, hub.recoverySpacing * 2),
                );
                const delay = hub.lastCaptureAt + spacing - performance.now();
                if (delay > 0) return { delay };
                hub.recoverySpacing = spacing;
              }
              operation.recovery = false;
              const epoch = hub.requestedEpoch;
              hub.beginCapture();
              hub.lastCaptureAt = performance.now();
              const snapshot = await this.snapshots.capture(scope);
              this.#assertOwned(scope, hub);
              if (!hub.subscriberCount)
                throw new Error("application_projection_unobserved");
              hub.forkSelectionSaturated.clear();
              const metadata = this.snapshots.captureMetadata.get(snapshot);
              if (!metadata)
                throw new Error("application_capture_metadata_missing");
              for (const [id, saturated] of metadata)
                hub.forkSelectionSaturated.set(id, saturated);
              hub.coveredEpoch = epoch;
              const envelope = hub.publish({
                type: "snapshot",
                generation: hub.generation,
                snapshot,
              });
              if (envelope.event.type !== "snapshot")
                throw new Error("application_snapshot_publication_invalid");
              this.#scheduleAudit(scope, hub);
              return {
                epoch,
                value: {
                  envelope:
                    envelope as PublishedApplicationSnapshot["envelope"],
                  snapshot,
                },
              };
            });
            if ("delay" in result) {
              this.#assertOwned(scope, hub);
              if (this.#closing)
                throw new Error(
                  "application_snapshot_publication_boundary_closed",
                );
              await new Promise<void>((resolve) => {
                operation.cancelDelay = resolve;
                operation.timer = setTimeout(resolve, result.delay);
              });
              operation.timer = undefined;
              operation.cancelDelay = undefined;
              continue;
            }
            for (const waiter of [...operation.waiters])
              if (waiter.epoch <= result.epoch) {
                operation.waiters.delete(waiter);
                waiter.resolve(result.value);
              }
          }
        } catch (error) {
          for (const waiter of operation.waiters) waiter.reject(error);
          operation.waiters.clear();
          this.hubs.retire(scope, hub);
        } finally {
          operation.running = false;
          if (this.#captures.get(hub) === operation) this.#captures.delete(hub);
        }
      });
    }
    return promise;
  }
  #register(hub: ApplicationEventHub): void {
    if (this.#registered.has(hub)) return;
    this.#registered.add(hub);
    hub.onClose(() => {
      this.#waitingChanges.delete(hub);
      const timer = this.#audits.get(hub);
      if (timer) clearTimeout(timer);
      this.#audits.delete(hub);
      const op = this.#captures.get(hub);
      if (op) {
        if (op.timer) clearTimeout(op.timer);
        op.cancelDelay?.();
        for (const waiter of op.waiters)
          waiter.reject(new Error("application_projection_closed"));
        op.waiters.clear();
      }
    });
  }
  #scheduleAudit(scope: RequestScope, hub: ApplicationEventHub): void {
    const old = this.#audits.get(hub);
    if (old) clearTimeout(old);
    this.#audits.delete(hub);
    if (
      this.#closing ||
      !this.hubs.owns(scope, hub) ||
      !hub.subscriberCount ||
      hub.state !== "ready"
    )
      return;
    const deadline = hub.projection?.auditDeadline;
    if (deadline === undefined) return;
    const delay = hub.projection!.auditDue()
      ? 0
      : Math.max(0, deadline - performance.now());
    const timer = setTimeout(() => {
      this.#audits.delete(hub);
      void this.#audit(scope, hub).catch((error) =>
        this.#failed(scope, error, hub),
      );
    }, delay);
    timer.unref();
    this.#audits.set(hub, timer);
  }
  async #audit(scope: RequestScope, hub: ApplicationEventHub): Promise<void> {
    await this.#serialize(scope, async () => {
      if (
        !this.hubs.owns(scope, hub) ||
        !hub.subscriberCount ||
        hub.state !== "ready" ||
        hub.pendingReplacement
      )
        return;
      try {
        hub.currentCheckpoint();
      } catch (error) {
        this.#failed(scope, error, hub);
      }
    });
  }
  #assertOwned(scope: RequestScope, hub: ApplicationEventHub): void {
    if (!this.hubs.owns(scope, hub))
      throw new Error("application_projection_closed");
  }
  #readyToPublish(scope: RequestScope, hub: ApplicationEventHub): boolean {
    this.#assertOwned(scope, hub);
    // A replacement admitted across an await or synchronous subscriber callback
    // is joined outside this turn, then the change is reread and deduplicated.
    if (hub.pendingReplacement) return false;
    if (hub.state !== "ready")
      throw new Error("application_projection_not_ready");
    return true;
  }
  async #serialize<T>(
    scope: RequestScope,
    publication: () => Promise<T>,
  ): Promise<T> {
    const key = applicationScopeKey(scope);
    const predecessor = this.#tails.get(key) ?? Promise.resolve();
    const result = predecessor.catch(() => {}).then(publication);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.#tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

/**
 * Adapts committed thread-change notifications to the shared authoritative
 * application-snapshot publication boundary.
 */
export class ApplicationThreadChangePublisher {
  constructor(readonly publications: ApplicationSnapshotPublicationBoundary) {}

  async publish(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    await this.publications.publishThreadChange(scope, applicationThreadId);
  }
}
