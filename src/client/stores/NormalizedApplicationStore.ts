import {
  applicationEventEnvelopeSchema,
  normalizedApplicationSessionSchema,
  normalizedApplicationSnapshotSchema,
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

function upsertById<T extends { readonly id: string }>(
  values: readonly T[],
  value: T,
): T[] {
  const index = values.findIndex(({ id }) => id === value.id);
  if (index < 0) return [...values, value];
  const next = [...values];
  next[index] = value;
  return next;
}

export class NormalizedApplicationStore {
  #state: NormalizedApplicationState = { authoritative: false };
  #transport?: TransportCursor;
  readonly #listeners = new Set<() => void>();
  readonly #workpadListeners = new Set<
    (change: WorkpadChangeNotification | undefined) => void
  >();

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
    let next: NormalizedApplicationSnapshot;
    switch (event.type) {
      case "environment_upsert":
        next = {
          ...snapshot,
          environments: upsertById(snapshot.environments, event.environment),
        };
        break;
      case "environment_remove":
        next = {
          ...snapshot,
          environments: snapshot.environments.filter(
            ({ id }) => id !== event.environmentId,
          ),
        };
        break;
      case "workspace_upsert":
        next = {
          ...snapshot,
          workspaces: upsertById(snapshot.workspaces, event.workspace),
        };
        break;
      case "workspace_remove":
        next = {
          ...snapshot,
          workspaces: snapshot.workspaces.filter(
            ({ id }) => id !== event.workspaceId,
          ),
        };
        break;
      case "thread_upsert": {
        const prior = snapshot.threads.find(({ id }) => id === event.thread.id);
        if (prior && revisionsRegress(prior, event.thread)) {
          return this.#invalidate("application_thread_revision_regressed");
        }
        next = {
          ...snapshot,
          threads: upsertById(snapshot.threads, event.thread),
          counts: event.counts,
        };
        break;
      }
      case "thread_remove":
        next = {
          ...snapshot,
          threads: snapshot.threads.filter(({ id }) => id !== event.threadId),
          counts: event.counts,
        };
        break;
      case "inventory_counts_changed":
        next = { ...snapshot, counts: event.counts };
        break;
      case "task_upsert": {
        const prior = snapshot.tasks.find(({ id }) => id === event.task.id);
        if (prior && event.task.revision < prior.revision) {
          return this.#invalidate("application_task_revision_regressed");
        }
        next = {
          ...snapshot,
          tasks: upsertById(snapshot.tasks, event.task),
        };
        break;
      }
      case "task_remove":
        next = {
          ...snapshot,
          tasks: snapshot.tasks.filter(({ id }) => id !== event.taskId),
        };
        break;
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

    const validated = normalizedApplicationSnapshotSchema.safeParse(next);
    if (!validated.success) {
      return this.#invalidate("application_inventory_reference_invalid");
    }
    this.#replaceState({ ...this.#state, snapshot: validated.data });
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
