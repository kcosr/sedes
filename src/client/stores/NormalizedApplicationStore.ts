import {
  APPLICATION_SNAPSHOT_COLLECTION_LIMITS,
  MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
  applicationEventEnvelopeSchema,
  normalizedApplicationSessionSchema,
  reportApplicationSnapshotReferenceIssues,
  serializedUtf8Bytes,
  type ApplicationEventEnvelope,
  type NormalizedApplicationSnapshot,
  type NormalizedApplicationThreadSummary,
} from "../../shared/index.js";

export interface NormalizedApplicationState {
  readonly authoritative: boolean;
  readonly csrfToken?: string;
  /** The connected server's Sedes product version from the session handshake. */
  readonly serverVersion?: string;
  readonly providerPulseEnabled?: boolean;
  readonly experimentalUsageEnabled?: boolean;
  readonly generation?: string;
  readonly snapshot?: NormalizedApplicationSnapshot;
}

/** A scoped invalidation for content loaded separately from the inventory. */
export interface WorkpadChangeNotification {
  readonly workpadId: string;
  readonly revision: number;
  readonly change: "document" | "draft";
}

export interface AutomationChangeNotification {
  readonly automationId: string;
  readonly threadId: string;
  readonly revision: number;
  readonly runsRevision: number;
  readonly deleted: boolean;
}

export type NormalizedApplicationApplyResult =
  | { readonly kind: "applied" }
  | { readonly kind: "ignored" }
  | { readonly kind: "resnapshot_required"; readonly reason: string };

interface TransportCursor {
  readonly generation: string;
  readonly sequence: number;
}

function transportCursor(eventId: string): TransportCursor {
  const separator = eventId.lastIndexOf(".");
  return {
    generation: eventId.slice(0, separator),
    sequence: Number(eventId.slice(separator + 1)),
  };
}

/** Collections that incremental application events replace entries in. */
type IncrementalCollection = "environments" | "workspaces" | "threads" | "tasks";

/**
 * One incremental collection change. Untouched entries keep their identity,
 * and `byteDelta` is the exact change in the snapshot's serialized size: an
 * array entry serializes the same standalone, plus one separating comma.
 */
interface CollectionChange {
  readonly snapshot: NormalizedApplicationSnapshot;
  readonly byteDelta: number;
}

function upsertEntry<K extends IncrementalCollection>(
  snapshot: NormalizedApplicationSnapshot,
  collection: K,
  value: NormalizedApplicationSnapshot[K][number],
): CollectionChange {
  const values: readonly NormalizedApplicationSnapshot[K][number][] =
    snapshot[collection];
  const index = values.findIndex(({ id }) => id === value.id);
  const next = [...values];
  let byteDelta = serializedUtf8Bytes(value);
  if (index < 0) {
    next.push(value);
    if (values.length > 0) byteDelta += 1;
  } else {
    byteDelta -= serializedUtf8Bytes(values[index]);
    next[index] = value;
  }
  return { snapshot: { ...snapshot, [collection]: next }, byteDelta };
}

function removeEntry(
  snapshot: NormalizedApplicationSnapshot,
  collection: IncrementalCollection,
  id: string,
): CollectionChange {
  const values: readonly { readonly id: string }[] = snapshot[collection];
  const index = values.findIndex((value) => value.id === id);
  if (index < 0) return { snapshot, byteDelta: 0 };
  const next = values.filter((_, valueIndex) => valueIndex !== index);
  return {
    snapshot: { ...snapshot, [collection]: next },
    byteDelta:
      -serializedUtf8Bytes(values[index]) - (next.length > 0 ? 1 : 0),
  };
}

const collectionByEvent = {
  environment_upsert: "environments",
  environment_remove: "environments",
  workspace_upsert: "workspaces",
  workspace_remove: "workspaces",
  thread_upsert: "threads",
  thread_remove: "threads",
  task_upsert: "tasks",
  task_remove: "tasks",
} as const satisfies Record<string, IncrementalCollection>;

export class NormalizedApplicationStore {
  #state: NormalizedApplicationState = { authoritative: false };
  /** Serialized size of the installed snapshot, maintained per event. */
  #snapshotBytes = 0;
  #transport?: TransportCursor;
  readonly #listeners = new Set<() => void>();
  readonly #workpadListeners = new Set<
    (change: WorkpadChangeNotification | undefined) => void
  >();
  readonly #threadSummaryListeners = new Set<(threadId: string | undefined) => void>();

  readonly #automationListeners = new Set<(change: AutomationChangeNotification | undefined) => void>();

  subscribeAutomationChanges = (listener: (change: AutomationChangeNotification | undefined) => void): (() => void) => {
    this.#automationListeners.add(listener);
    return () => { this.#automationListeners.delete(listener); };
  };

  #notifyAutomations(change: AutomationChangeNotification | undefined): void {
    for (const listener of this.#automationListeners) listener(change);
  }

  /** Invalidates independently loaded summaries; undefined covers replacement or location availability changes. */
  subscribeThreadSummaryChanges = (listener: (threadId: string | undefined) => void): (() => void) => {
    this.#threadSummaryListeners.add(listener);
    return () => { this.#threadSummaryListeners.delete(listener); };
  };

  subscribeWorkpadChanges = (
    listener: (change: WorkpadChangeNotification | undefined) => void,
  ): (() => void) => {
    this.#workpadListeners.add(listener);
    return () => this.#workpadListeners.delete(listener);
  };

  resyncWorkpads(): void {
    if (this.#state.authoritative) this.#notifyWorkpads(undefined);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): NormalizedApplicationState => this.#state;

  get state(): NormalizedApplicationState {
    return this.#state;
  }

  get replayCursor(): string | undefined {
    return this.#transport
      ? `${this.#transport.generation}.${this.#transport.sequence}`
      : undefined;
  }

  installSession(rawSession: unknown): NormalizedApplicationApplyResult {
    const parsed = normalizedApplicationSessionSchema.safeParse(rawSession);
    if (!parsed.success) {
      return this.#invalidate("invalid_application_session");
    }
    this.#replaceState({
      ...this.#state,
      csrfToken: parsed.data.csrfToken,
      serverVersion: parsed.data.version,
      providerPulseEnabled: parsed.data.providerPulseEnabled,
      experimentalUsageEnabled: parsed.data.experimentalUsageEnabled,
    });
    return { kind: "applied" };
  }

  resetInventory(): void {
    this.#transport = undefined;
    this.#replaceState({
      ...this.#state,
      authoritative: false,
    });
  }

  apply(rawEnvelope: unknown): NormalizedApplicationApplyResult {
    const parsed = applicationEventEnvelopeSchema.safeParse(rawEnvelope);
    if (!parsed.success) {
      return this.#invalidate("invalid_application_event");
    }
    const envelope = parsed.data;
    const cursor = transportCursor(envelope.eventId);
    const cursorResult = this.#acceptCursor(cursor, envelope);
    if (cursorResult) return cursorResult;

    if (envelope.event.type === "snapshot") {
      this.#transport = cursor;
      this.#snapshotBytes = serializedUtf8Bytes(envelope.event.snapshot);
      this.#replaceState({
        authoritative: true,
        ...(this.#state.csrfToken ? { csrfToken: this.#state.csrfToken } : {}),
        ...(this.#state.providerPulseEnabled !== undefined
          ? { providerPulseEnabled: this.#state.providerPulseEnabled }
          : {}),
        experimentalUsageEnabled: this.#state.experimentalUsageEnabled === true,
        generation: envelope.event.generation,
        snapshot: envelope.event.snapshot,
      });
      // A replacement may follow a replay gap or server restart. Separately
      // loaded documents must reconcile even when no change events survived.
      this.#notifyWorkpads(undefined);
      this.#notifyThreadSummaries(undefined);
      this.#notifyAutomations(undefined);
      return { kind: "applied" };
    }

    const snapshot = this.#state.snapshot;
    if (
      !this.#state.authoritative ||
      !snapshot ||
      envelope.event.generation !== this.#state.generation
    ) {
      return this.#invalidate("application_generation_missing");
    }

    const result = this.#applyIncremental(envelope, snapshot);
    if (result.kind !== "resnapshot_required") {
      this.#transport = cursor;
    }
    return result;
  }

  #acceptCursor(
    cursor: TransportCursor,
    envelope: ApplicationEventEnvelope,
  ): NormalizedApplicationApplyResult | undefined {
    const previous = this.#transport;
    if (!previous) {
      return envelope.event.type === "snapshot"
        ? undefined
        : this.#invalidate("initial_application_snapshot_missing");
    }
    if (cursor.generation !== previous.generation) {
      return envelope.event.type === "snapshot"
        ? undefined
        : this.#invalidate("application_transport_generation_changed");
    }
    if (cursor.sequence < previous.sequence) {
      return { kind: "ignored" };
    }
    if (
      cursor.sequence === previous.sequence &&
      envelope.event.type !== "snapshot"
    ) {
      return { kind: "ignored" };
    }
    if (
      cursor.sequence === previous.sequence &&
      envelope.event.type === "snapshot" &&
      this.#state.authoritative
    ) {
      return { kind: "ignored" };
    }
    if (
      cursor.sequence !== previous.sequence + 1 &&
      envelope.event.type !== "snapshot"
    ) {
      return this.#invalidate("application_transport_sequence_gap");
    }
    return undefined;
  }

  #applyIncremental(
    envelope: ApplicationEventEnvelope,
    snapshot: NormalizedApplicationSnapshot,
  ): NormalizedApplicationApplyResult {
    const event = envelope.event;
    let change: CollectionChange;
    switch (event.type) {
      case "environment_upsert":
        change = upsertEntry(snapshot, "environments", event.environment);
        break;
      case "environment_remove":
        change = removeEntry(snapshot, "environments", event.environmentId);
        break;
      case "workspace_upsert":
        change = upsertEntry(snapshot, "workspaces", event.workspace);
        break;
      case "workspace_remove":
        change = removeEntry(snapshot, "workspaces", event.workspaceId);
        break;
      case "thread_upsert": {
        const prior = snapshot.threads.find(({ id }) => id === event.thread.id);
        if (prior && revisionsRegress(prior, event.thread)) {
          return this.#invalidate("application_thread_revision_regressed");
        }
        change = upsertEntry(snapshot, "threads", event.thread);
        break;
      }
      case "thread_remove":
        change = removeEntry(snapshot, "threads", event.threadId);
        break;
      case "task_upsert": {
        const prior = snapshot.tasks.find(({ id }) => id === event.task.id);
        if (prior && event.task.revision < prior.revision) {
          return this.#invalidate("application_task_revision_regressed");
        }
        change = upsertEntry(snapshot, "tasks", event.task);
        break;
      }
      case "task_remove":
        change = removeEntry(snapshot, "tasks", event.taskId);
        break;
      case "automation_changed":
        this.#notifyAutomations(event);
        return { kind: "applied" };
      case "workpad_changed":
        this.#notifyWorkpads({
          workpadId: event.workpadId,
          revision: event.revision,
          change: event.change,
        });
        return { kind: "applied" };
      case "snapshot":
        throw new Error("snapshot handled before incremental dispatch");
    }

    // The envelope schema validated the changed entity. The rest of the
    // snapshot schema is checked for the result without re-parsing (and
    // re-creating) every untouched entity.
    const next = change.snapshot;
    const snapshotBytes = this.#snapshotBytes + change.byteDelta;
    const collection = collectionByEvent[event.type];
    let referencesValid = true;
    reportApplicationSnapshotReferenceIssues(next, () => {
      referencesValid = false;
    });
    if (
      !referencesValid ||
      snapshotBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES ||
      next[collection].length > APPLICATION_SNAPSHOT_COLLECTION_LIMITS[collection]
    ) {
      return this.#invalidate("application_inventory_reference_invalid");
    }
    this.#snapshotBytes = snapshotBytes;
    this.#replaceState({ ...this.#state, snapshot: next });
    if (event.type === "thread_upsert") this.#notifyThreadSummaries(event.thread.id);
    else if (event.type === "thread_remove") this.#notifyThreadSummaries(event.threadId);
    else if (event.type === "environment_upsert" || event.type === "environment_remove" ||
      event.type === "workspace_upsert" || event.type === "workspace_remove") this.#notifyThreadSummaries(undefined);
    return { kind: "applied" };
  }

  #invalidate(reason: string): NormalizedApplicationApplyResult {
    if (this.#state.authoritative) {
      this.#replaceState({ ...this.#state, authoritative: false });
    }
    return { kind: "resnapshot_required", reason };
  }

  #replaceState(state: NormalizedApplicationState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #notifyWorkpads(change: WorkpadChangeNotification | undefined): void {
    for (const listener of this.#workpadListeners) listener(change);
  }

  #notifyThreadSummaries(threadId: string | undefined): void {
    for (const listener of this.#threadSummaryListeners) listener(threadId);
  }
}

function revisionsRegress(
  prior: NormalizedApplicationThreadSummary,
  next: NormalizedApplicationThreadSummary,
): boolean {
  return (
    next.inventoryRevision < prior.inventoryRevision ||
    next.pinRevision < prior.pinRevision ||
    next.preferredWorktreeRevision < prior.preferredWorktreeRevision ||
    next.groupAssignmentRevision < prior.groupAssignmentRevision ||
    next.threadRevision < prior.threadRevision
  );
}
