import { randomUUID } from "node:crypto";
import {
  MAXIMUM_NORMALIZED_TIMELINE_ITEMS,
  MAXIMUM_NORMALIZED_TIMELINE_TURNS,
  conversationTurnSourceRevision,
  normalizedThreadEventSchema,
  threadCheckpointSchema,
  threadEventEnvelopeSchema,
  type NormalizedThreadEvent,
  type ThreadEventEnvelope,
  type NormalizedThreadSnapshot,
  type ThreadForkSourceCapability,
  type ThreadCheckpoint,
  type RuntimeNotice,
} from "../../shared/protocol/conversation.js";
import {
  EventHub,
  type EventHubOptions,
  type EventSubscription,
  type SequencedEvent,
} from "./event-hub.js";
import {
  MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
  serializedUtf8Bytes,
} from "../../shared/protocol/payload.js";
import { SerializedMailbox } from "../conversations/serialized-mailbox.js";
import { sameAgentToolPolicyRevision } from "../../shared/agent-tool-policy.js";
import type { DismissRuntimeNoticeRequest } from "../../shared/protocol/api.js";
import { fitApplicationItemsToSnapshot, isApplicationPublicationItem, type ApplicationPublicationItem, type ApplicationProjectionInput } from "../conversations/application-publication-projection.js";

export interface ThreadEventSubscription {
  readonly watermark: number;
  readonly replay: readonly ThreadEventEnvelope[];
  close(): void;
}

export interface ThreadCheckpointSubscription extends ThreadEventSubscription {
  readonly checkpoint: ThreadCheckpoint | undefined;
}

type ItemTurnEvent = Extract<NormalizedThreadEvent, { type: "item_upsert" | "turn_upsert" }>;

function envelope(
  event: SequencedEvent<NormalizedThreadEvent>,
): ThreadEventEnvelope {
  return threadEventEnvelopeSchema.parse({
    eventId: event.id,
    projectionGeneration: event.data.generation,
    event: event.data,
  });
}

/**
 * Validated normalized thread publication boundary.
 *
 * The first event for every projection generation must be a complete snapshot.
 * Transport IDs remain owned by EventHub and are embedded into the browser
 * envelope rather than being confused with projection generations.
 */
export class ThreadEventHub {
  readonly #hub: EventHub<NormalizedThreadEvent>;
  readonly #applicationPublications = new SerializedMailbox();
  readonly #subscriberCountListeners = new Set<(count: number) => void>();
  #internalSubscriberCount = 0;
  #projectionGeneration?: string;
  #snapshot?: NormalizedThreadSnapshot;
  // Shares native item objects with the fitted view; only optional page
  // membership differs. This process-local source is never persisted.
  #sourceSnapshot?: NormalizedThreadSnapshot;
  #sourceSnapshotBytes = 0;
  #sourceItemCount = 0;
  #snapshotBytes = 0;
  #snapshotItemCount = 0;
  #visibleApplicationIds: ReadonlySet<string> = new Set();
  #sourcePages: ReadonlyMap<string, ApplicationPublicationItem> = new Map();
  #checkpoint?: ThreadCheckpoint;
  #notices: readonly RuntimeNotice[] = [];
  #capabilityThreadRevision = 0;
  #capabilityRunState: NormalizedThreadSnapshot["runState"] = "idle";

  constructor(options: EventHubOptions = {}) {
    this.#hub = new EventHub({
      ...options,
      supersedesReplay: (type) => type === "snapshot",
    });
  }

  get transportGeneration(): string {
    return this.#hub.generation;
  }

  get watermark(): number {
    return this.#hub.watermark;
  }

  get subscriberCount(): number {
    return Math.max(
      0,
      this.#hub.subscriberCount - this.#internalSubscriberCount,
    );
  }

  get retainedEventCount(): number {
    return this.#hub.retainedEventCount;
  }

  get retainedBytes(): number {
    return this.#hub.retainedBytes;
  }

  get projectionGeneration(): string | undefined {
    return this.#projectionGeneration;
  }

  get snapshot(): NormalizedThreadSnapshot | undefined {
    return this.#snapshot;
  }

  get threadSummary(): NormalizedThreadSnapshot["thread"] | undefined {
    return this.#snapshot?.thread;
  }

  eventIdAt(sequence: number): string {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("thread_event_sequence_invalid");
    }
    return `${this.#hub.generation}.${sequence}`;
  }

  sequenceOf(eventId: string): number | undefined {
    const prefix = `${this.#hub.generation}.`;
    if (!eventId.startsWith(prefix)) return undefined;
    const rawSequence = eventId.slice(prefix.length);
    if (!/^(0|[1-9]\d*)$/.test(rawSequence)) return undefined;
    const sequence = Number(rawSequence);
    return Number.isSafeInteger(sequence) &&
      sequence >= 0 &&
      sequence <= this.#hub.watermark
      ? sequence
      : undefined;
  }

  /**
   * Order application capture through publication across actor replacements
   * and durable-state updates. The boundary belongs to the retained hub, so
   * replacing a runtime binding cannot start an independent publication queue.
   * Actor capture and provider catalog refresh must finish before entering;
   * queued captures use cached presentation. Synchronous runtime deltas remain
   * independent and are merged against the current snapshot.
   */
  serializeApplicationPublication<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.#applicationPublications.enqueue(operation);
  }

  /** A native item and its owning turn must reach a capacity reset together. */
  publishBatch(events: readonly ItemTurnEvent[]): readonly ThreadEventEnvelope[] {
    if (events.some(event => event.type !== "item_upsert" && event.type !== "turn_upsert")) throw new Error("thread_projection_item_turn_batch_required");
    if (events.length < 2 || (this.#sourcePages.size === 0 && !events.some(event => event.type === "item_upsert" && isApplicationPublicationItem(event.item)))) {
      return events.map(event => this.publish(event));
    }
    if (!this.#sourceSnapshot) throw new Error("thread_projection_snapshot_required");
    let source = this.#sourceSnapshot;
    let bytes = this.#sourceSnapshotBytes;
    let itemCount = this.#sourceItemCount;
    let pages = this.#sourcePages;
    let published = this.#snapshot!;
    let publishedBytes = this.#snapshotBytes;
    let publishedCount = this.#snapshotItemCount;
    let prefixOverflow = false;
    let expectedPageIds = this.#visibleApplicationIds;
    for (const event of events) if (event.type === "item_upsert" && isApplicationPublicationItem(event.item) && !this.#sourcePages.has(event.item.id)) expectedPageIds = new Set([...expectedPageIds, event.item.id]);
    const allSourcePagesVisible = this.#sourcePages.size === this.#visibleApplicationIds.size;
    const pending: { event: ItemTurnEvent; source: NormalizedThreadSnapshot; bytes: number; itemCount: number;
      pages: ReadonlyMap<string, ApplicationPublicationItem>; published: NormalizedThreadSnapshot; publishedBytes: number; publishedCount: number }[] = [];
    for (const raw of events) {
      const event = normalizedThreadEventSchema.parse(raw);
      if ((event.type !== "item_upsert" && event.type !== "turn_upsert") || event.generation !== this.#projectionGeneration) throw new Error("thread_projection_item_turn_batch_required");
      const next = applyIncremental(source, event);
      const nextCount = nextItemCount(source, event, itemCount);
      bytes += snapshotFieldByteDelta(source, next, event, itemCount, nextCount);
      itemCount = nextCount;
      source = next;
      pages = nextApplicationPublicationItems(pages, event);
      const visibleEvent = allSourcePagesVisible ? event : visibleTurnEvent(event, pages, expectedPageIds);
      if (allSourcePagesVisible) {
        published = source;
        publishedBytes = bytes;
        publishedCount = itemCount;
      } else {
        const nextPublished = applyIncremental(published, visibleEvent);
        const nextPublishedCount = nextItemCount(published, visibleEvent, publishedCount);
        publishedBytes += snapshotFieldByteDelta(published, nextPublished, visibleEvent, publishedCount, nextPublishedCount);
        publishedCount = nextPublishedCount;
        published = nextPublished;
      }
      if (publishedBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES || publishedCount > MAXIMUM_NORMALIZED_TIMELINE_ITEMS) {
        prefixOverflow = true;
      }
      pending.push({ event: visibleEvent, source, bytes, itemCount, pages, published, publishedBytes, publishedCount });
    }
    const fitted = fitApplicationItemsToSnapshot(source, bytes, pages, itemCount);
    if (fitted.serializedBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES ||
      itemCount - pages.size + fitted.applicationIds.size > MAXIMUM_NORMALIZED_TIMELINE_ITEMS) throw new Error("thread_projection_snapshot_limit_exceeded");
    const omittedPageEvent = events.some(event => event.type === "item_upsert" && isApplicationPublicationItem(event.item) && !fitted.applicationIds.has(event.item.id));
    if (prefixOverflow || omittedPageEvent || !samePageIds(fitted.applicationIds, expectedPageIds)) {
      const event = normalizedThreadEventSchema.parse({ type: "snapshot", generation: events[0]!.generation, snapshot: fitted.snapshot });
      this.#sourceSnapshot = source;
      this.#sourceSnapshotBytes = bytes;
      this.#sourceItemCount = itemCount;
      this.#sourcePages = pages;
      this.#visibleApplicationIds = fitted.applicationIds;
      this.#snapshot = fitted.snapshot;
      this.#snapshotBytes = fitted.serializedBytes;
      this.#snapshotItemCount = itemCount - pages.size + fitted.applicationIds.size;
      this.#checkpoint = undefined;
      return [envelope(this.#hub.publish(event.type, event))];
    }
    return pending.map(step => {
      this.#sourceSnapshot = step.source;
      this.#sourceSnapshotBytes = step.bytes;
      this.#sourceItemCount = step.itemCount;
      this.#sourcePages = step.pages;
      this.#snapshot = step.published;
      this.#snapshotBytes = step.publishedBytes;
      this.#snapshotItemCount = step.publishedCount;
      if (step.event.type === "item_upsert" && isApplicationPublicationItem(step.event.item) && !this.#visibleApplicationIds.has(step.event.item.id)) {
        this.#visibleApplicationIds = new Set([...this.#visibleApplicationIds, step.event.item.id]);
      }
      this.#checkpoint = undefined;
      return envelope(this.#hub.publish(step.event.type, step.event));
    });
  }

  publish(rawEvent: Exclude<NormalizedThreadEvent, { type: "notice" }>, sourceTimeline?: ApplicationProjectionInput): ThreadEventEnvelope;
  publish(rawEvent: NormalizedThreadEvent, sourceTimeline?: ApplicationProjectionInput): ThreadEventEnvelope | undefined;
  publish(rawEvent: NormalizedThreadEvent, sourceTimeline?: ApplicationProjectionInput): ThreadEventEnvelope | undefined {
    const priorGeneration = this.#projectionGeneration;
    const priorCapabilityRevision = this.#snapshot?.capabilities.revision;
    let event: NormalizedThreadEvent;
    if (rawEvent.type === "snapshot") {
      const sourceSnapshot = sourceTimeline ? {
        ...rawEvent.snapshot,
        orderedTurnIds: [...sourceTimeline.orderedTurnIds],
        turnsById: sourceTimeline.turnsById,
        itemsById: sourceTimeline.itemsById,
      } : rawEvent.snapshot;
      const bytes = serializedUtf8Bytes(sourceSnapshot);
      const itemCount = Object.keys(sourceSnapshot.itemsById).length;
      const pages = new Map(Object.entries(sourceSnapshot.itemsById).filter((entry): entry is [string, ApplicationPublicationItem] => isApplicationPublicationItem(entry[1])));
      const fitted = fitApplicationItemsToSnapshot(sourceSnapshot, bytes, pages, itemCount);
      event = normalizedThreadEventSchema.parse({ ...rawEvent, snapshot: fitted.snapshot });
      this.#sourceSnapshot = fitted.snapshot === sourceSnapshot && event.type === "snapshot" ? event.snapshot : sourceSnapshot;
      this.#sourceSnapshotBytes = bytes;
      this.#sourceItemCount = itemCount;
      this.#snapshotBytes = fitted.serializedBytes;
      this.#snapshotItemCount = itemCount - pages.size + fitted.applicationIds.size;
      this.#visibleApplicationIds = fitted.applicationIds;
      this.#sourcePages = pages;
    } else {
      event = normalizedThreadEventSchema.parse(rawEvent);
    }
    if (event.type === "snapshot") {
      const sameGeneration = event.generation === priorGeneration;
      this.#projectionGeneration = event.generation;
      this.#snapshot = event.snapshot;
      if (!sameGeneration) this.#notices = [];
      if (!sameGeneration || event.snapshot.capabilities.revision !== priorCapabilityRevision) {
        this.#capabilityThreadRevision = event.snapshot.thread.threadRevision;
        this.#capabilityRunState = event.snapshot.capabilities.runState;
      }
    } else if (event.generation !== this.#projectionGeneration) {
      throw new Error("thread_projection_snapshot_required");
    } else {
      // Repeated provider warnings are one visible occurrence. Preserve its
      // identity and timestamp without advancing replay or notifying viewers.
      if (event.type === "notice") {
        const incoming = event.notice;
        if (this.#notices.some(notice => notice.tone === incoming.tone && notice.message.text === incoming.message.text)) return undefined;
        // Provider IDs can be reused for different diagnostics. Each accepted
        // application occurrence owns a unique identity for rendering/dismissal.
        event = { ...event, notice: { ...incoming, id: randomUUID() } };
      }
      if (
        event.type === "capabilities_changed" &&
        event.threadRevision < this.#capabilityThreadRevision
      ) {
        throw new Error("thread_projection_thread_revision_regressed");
      }
      const source = this.#sourceSnapshot ?? this.#snapshot;
      const nextSource = applyIncremental(source, event);
      const itemCount = nextItemCount(source!, event, this.#sourceItemCount);
      const sourceBytes = this.#sourceSnapshotBytes + snapshotFieldByteDelta(source!, nextSource, event, this.#sourceItemCount, itemCount);
      const pages = nextApplicationPublicationItems(this.#sourcePages, event);
      const unchangedVisiblePages = event.type === "item_upsert" && !isApplicationPublicationItem(event.item) &&
        Object.hasOwn(source!.itemsById, event.item.id) && pages === this.#sourcePages && pages.size === this.#visibleApplicationIds.size &&
        sourceBytes <= MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES && itemCount <= MAXIMUM_NORMALIZED_TIMELINE_ITEMS;
      const fitted = unchangedVisiblePages
        ? { snapshot: nextSource, serializedBytes: sourceBytes, applicationIds: this.#visibleApplicationIds }
        : fitApplicationItemsToSnapshot(nextSource, sourceBytes, pages, itemCount);
      if (event.type === "history_prepend" && (
        itemCount - pages.size + fitted.applicationIds.size > MAXIMUM_NORMALIZED_TIMELINE_ITEMS ||
        fitted.serializedBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES
      )) throw new Error("thread_projection_history_limit_exceeded");
      if (fitted.serializedBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES ||
        itemCount - pages.size + fitted.applicationIds.size > MAXIMUM_NORMALIZED_TIMELINE_ITEMS) {
        throw new Error("thread_projection_snapshot_limit_exceeded");
      }
      let expectedPageIds = this.#visibleApplicationIds;
      if (event.type === "history_prepend") {
        const added = Object.values(event.page.itemsById).filter(item => isApplicationPublicationItem(item));
        if (added.length) expectedPageIds = new Set([...expectedPageIds, ...added.map(item => item.id)]);
      }
      const membershipChanged = !samePageIds(fitted.applicationIds, expectedPageIds);
      const hiddenApplicationPublicationItem = event.type === "item_upsert" && isApplicationPublicationItem(event.item) && !fitted.applicationIds.has(event.item.id);
      if (membershipChanged || hiddenApplicationPublicationItem) {
        // A complete reset clears removed items, and includes both newly
        // admitted page items and every changed turn in one consistent frame.
        event = normalizedThreadEventSchema.parse({ type: "snapshot", generation: event.generation, snapshot: fitted.snapshot });
      } else if (event.type === "turn_upsert") {
        event = normalizedThreadEventSchema.parse({ ...event, turn: fitted.snapshot.turnsById[event.turn.id] });
      }
      this.#sourceSnapshot = nextSource;
      this.#sourceSnapshotBytes = sourceBytes;
      this.#sourceItemCount = itemCount;
      this.#snapshotBytes = fitted.serializedBytes;
      this.#snapshotItemCount = itemCount - pages.size + fitted.applicationIds.size;
      this.#visibleApplicationIds = fitted.applicationIds;
      this.#sourcePages = pages;
      this.#snapshot = fitted.snapshot;
      if (event.type === "snapshot") {
        if (event.snapshot.capabilities.revision !== priorCapabilityRevision) {
          this.#capabilityThreadRevision = event.snapshot.thread.threadRevision;
          this.#capabilityRunState = event.snapshot.capabilities.runState;
        }
      }
      if (event.type === "capabilities_changed")
        this.#capabilityThreadRevision = event.threadRevision;
      if (event.type === "application_state_changed")
        this.#capabilityThreadRevision = event.state.thread.threadRevision;
      if (event.type === "capabilities_changed")
        this.#capabilityRunState = event.capabilities.runState;
      if (event.type === "application_state_changed")
        this.#capabilityRunState = event.state.capabilities.runState;
      if (event.type === "notice")
        this.#notices = [...this.#notices, event.notice].slice(-100);
      if (event.type === "notice_dismissed") {
        const dismissedId = event.noticeId;
        this.#notices = this.#notices.filter(notice => notice.id !== dismissedId);
      }
    }
    this.#checkpoint = undefined;
    const published = envelope(this.#hub.publish(event.type, event));
    return published;
  }

  /** Does not attach a provider or retain an acknowledgement after removal. */
  dismissNotice(request: DismissRuntimeNoticeRequest): void {
    if (request.generation !== this.#projectionGeneration) return;
    if (!this.#notices.some(notice => notice.id === request.noticeId)) return;
    this.publish({ type: "notice_dismissed", generation: request.generation, noticeId: request.noticeId });
  }

  subscribe(
    listener: (event: ThreadEventEnvelope) => void,
    lastEventId?: string,
  ): ThreadEventSubscription {
    const subscription = this.#subscribe(listener, lastEventId);
    this.#notifySubscriberCountChanged();
    let closed = false;
    return {
      watermark: subscription.watermark,
      replay: subscription.replay,
      close: () => {
        if (closed) return;
        closed = true;
        subscription.close();
        this.#notifySubscriberCountChanged();
      },
    };
  }

  /** Process-local observers do not own or keep a backend runtime alive. */
  subscribeInternal(
    listener: (event: ThreadEventEnvelope) => void,
    lastEventId?: string,
  ): ThreadEventSubscription {
    const subscription = this.#subscribe(listener, lastEventId);
    this.#internalSubscriberCount += 1;
    let closed = false;
    return {
      watermark: subscription.watermark,
      replay: subscription.replay,
      close: () => {
        if (closed) return;
        closed = true;
        this.#internalSubscriberCount = Math.max(
          0,
          this.#internalSubscriberCount - 1,
        );
        subscription.close();
      },
    };
  }

  onSubscriberCountChanged(listener: (count: number) => void): () => void {
    this.#subscriberCountListeners.add(listener);
    return () => this.#subscriberCountListeners.delete(listener);
  }

  #subscribe(
    listener: (event: ThreadEventEnvelope) => void,
    lastEventId?: string,
  ): ThreadEventSubscription {
    const subscription: EventSubscription<NormalizedThreadEvent> =
      this.#hub.subscribe((event) => listener(envelope(event)), lastEventId);
    try {
      return {
        watermark: subscription.watermark,
        replay: subscription.replay.map(envelope),
        close: () => subscription.close(),
      };
    } catch (error) {
      subscription.close();
      throw error;
    }
  }

  #notifySubscriberCountChanged(): void {
    const count = this.subscriberCount;
    for (const listener of [...this.#subscriberCountListeners]) {
      try {
        listener(count);
      } catch {
        // Runtime retention observers cannot interrupt stream ownership.
      }
    }
  }

  /** Captures only already-published state; never reads or publishes provider state. */
  currentCheckpoint(): ThreadCheckpoint | undefined {
    if (!this.#snapshot || !this.#projectionGeneration) return undefined;
    this.#checkpoint ??= threadCheckpointSchema.parse({
      eventId: this.eventIdAt(this.watermark),
      projectionGeneration: this.#projectionGeneration,
      snapshot: this.#snapshot,
      notices: this.#notices,
      capabilityThreadRevision: this.#capabilityThreadRevision,
      capabilityRunState: this.#capabilityRunState,
    });
    return this.#checkpoint;
  }

  /** Capture and subscribe before retention callbacks can publish newer events. */
  subscribeFromCurrentSnapshot(
    listener: (event: ThreadEventEnvelope) => void,
  ): ThreadCheckpointSubscription {
    const checkpoint = this.currentCheckpoint();
    const subscription = this.subscribe(listener);
    return {
      ...subscription,
      checkpoint,
    };
  }

  canReplay(lastEventId: string | undefined): boolean {
    return this.#hub.canReplay(lastEventId);
  }

  replayBytesAfter(lastEventId: string | undefined): number | undefined {
    return this.#hub.replayBytesAfter(lastEventId);
  }

  replayCostExceeds(
    lastEventId: string,
    budget: number,
    cost: (event: ThreadEventEnvelope) => number,
  ): boolean | undefined {
    return this.#hub.replayCostExceeds(lastEventId, budget, (event) =>
      cost({
        eventId: event.id,
        projectionGeneration: event.data.generation,
        event: event.data,
      }),
    );
  }
}

/** Count only changed metadata or map entries; never serialize retained text. */
function samePageIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left === right) return true;
  return left.size === right.size && [...left].every(id => right.has(id));
}

function nextItemCount(snapshot: NormalizedThreadSnapshot, event: Exclude<NormalizedThreadEvent, { type: "snapshot" }>, count: number): number {
  if (event.type === "item_upsert") return count + (Object.hasOwn(snapshot.itemsById, event.item.id) ? 0 : 1);
  if (event.type === "history_prepend") return count + Object.keys(event.page.itemsById).length;
  return count;
}

function nextApplicationPublicationItems(pages: ReadonlyMap<string, ApplicationPublicationItem>, event: Exclude<NormalizedThreadEvent, { type: "snapshot" }>): ReadonlyMap<string, ApplicationPublicationItem> {
  if (event.type === "item_upsert" && (isApplicationPublicationItem(event.item) || pages.has(event.item.id))) {
    const next = new Map(pages);
    if (isApplicationPublicationItem(event.item)) next.set(event.item.id, event.item);
    else next.delete(event.item.id);
    return next;
  }
  if (event.type === "history_prepend") {
    const added = Object.values(event.page.itemsById).filter((item): item is ApplicationPublicationItem => isApplicationPublicationItem(item));
    return added.length ? new Map([...pages, ...added.map(item => [item.id, item] as const)]) : pages;
  }
  return pages;
}

function visibleTurnEvent(event: ItemTurnEvent, pages: ReadonlyMap<string, ApplicationPublicationItem>, visible: ReadonlySet<string>): ItemTurnEvent {
  if (event.type !== "turn_upsert") return event;
  const orderedItemIds = event.turn.orderedItemIds.filter(id => !pages.has(id) || visible.has(id));
  const removed = event.turn.orderedItemIds.length - orderedItemIds.length;
  return removed === 0 ? event : { ...event, turn: { ...event.turn, orderedItemIds, revision: event.turn.revision - removed } };
}

function snapshotFieldByteDelta(
  previous: NormalizedThreadSnapshot,
  next: NormalizedThreadSnapshot,
  event: Exclude<NormalizedThreadEvent, { type: "snapshot" }>,
  previousItemCount: number,
  nextItemCount: number,
): number {
  let delta = 0;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof NormalizedThreadSnapshot>;
  for (const key of keys) {
    if (previous[key] === next[key]) continue;
    if (key === "itemsById" || key === "turnsById" || key === "forksByTurnId") {
      const changedId = event.type === "item_upsert" && key === "itemsById" ? event.item.id :
        event.type === "turn_upsert" && (key === "turnsById" || key === "forksByTurnId") ? event.turn.id : undefined;
      const previousCount = key === "itemsById" ? previousItemCount : previous.orderedTurnIds.length;
      const nextCount = key === "itemsById" ? nextItemCount : next.orderedTurnIds.length;
      delta += recordMapByteDelta(previous[key], next[key], changedId, previousCount, nextCount);
      continue;
    }
    if (previous[key] !== undefined) delta -= serializedUtf8Bytes({ [key]: previous[key] }) - 1;
    if (next[key] !== undefined) delta += serializedUtf8Bytes({ [key]: next[key] }) - 1;
  }
  return delta;
}

function recordMapByteDelta(previous: Readonly<Record<string, unknown>>, next: Readonly<Record<string, unknown>>, changedId: string | undefined, previousCount: number, nextCount: number): number {
  if (changedId !== undefined) {
    if (previous[changedId] !== undefined && next[changedId] !== undefined) return serializedUtf8Bytes(next[changedId]) - serializedUtf8Bytes(previous[changedId]);
    return Math.max(0, nextCount - 1) - Math.max(0, previousCount - 1) +
      (next[changedId] === undefined ? 0 : serializedUtf8Bytes({ [changedId]: next[changedId] }) - 2) -
      (previous[changedId] === undefined ? 0 : serializedUtf8Bytes({ [changedId]: previous[changedId] }) - 2);
  }
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  let delta = Math.max(0, nextKeys.length - 1) - Math.max(0, previousKeys.length - 1);
  for (const key of previousKeys) if (previous[key] !== next[key]) delta -= serializedUtf8Bytes({ [key]: previous[key] }) - 2;
  for (const key of nextKeys) if (previous[key] !== next[key]) delta += serializedUtf8Bytes({ [key]: next[key] }) - 2;
  return delta;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Entity revisions are monotonic within one projection generation (the
 * projector bumps a revision on every change and emits nothing for identical
 * content). A regression — or different content at the same revision — is
 * therefore only possible when two publication streams interleave into one
 * hub, which would poison the retained replay suffix for every future
 * attach. Fail closed so the publisher's recovery path replaces the
 * projection instead of retaining a corrupted history.
 * Independently changing runtime fields must be excluded by a caller-supplied
 * equality function; they are not governed by a saved policy revision.
 */
function assertRevisionMonotonic<T extends { readonly revision: number }>(
  prior: T | undefined,
  next: T,
  regressedCode: string,
  conflictCode: string,
  equal: (left: T, right: T) => boolean = sameValue,
): void {
  if (!prior) return;
  if (next.revision < prior.revision) throw new Error(regressedCode);
  if (next.revision === prior.revision && !equal(prior, next)) {
    throw new Error(conflictCode);
  }
}

function assertThreadSummaryMonotonic(
  prior: NormalizedThreadSnapshot["thread"],
  next: NormalizedThreadSnapshot["thread"],
): void {
  if (
    next.inventoryRevision < prior.inventoryRevision ||
    next.threadRevision < prior.threadRevision
  ) {
    throw new Error("thread_projection_thread_revision_regressed");
  }
}

function assertProviderFeatureProjectionMonotonic(
  prior: Pick<NormalizedThreadSnapshot, "capabilities" | "providerFeatures">,
  next: Pick<NormalizedThreadSnapshot, "capabilities" | "providerFeatures">,
): void {
  for (const capability of next.capabilities.providerFeatures) {
    const priorCapability = prior.capabilities.providerFeatures.find(
      ({ ref }) =>
        ref.featureId === capability.ref.featureId &&
        ref.schemaVersion === capability.ref.schemaVersion,
    );
    if (!priorCapability) continue;
    if (capability.revision < priorCapability.revision) {
      throw new Error("thread_projection_provider_feature_revision_regressed");
    }
    if (capability.revision !== priorCapability.revision) continue;
    const stateFor = (
      projection: Pick<
        NormalizedThreadSnapshot,
        "capabilities" | "providerFeatures"
      >,
    ) =>
      projection.providerFeatures.find(
        ({ ref }) =>
          ref.featureId === capability.ref.featureId &&
          ref.schemaVersion === capability.ref.schemaVersion,
      );
    if (
      !sameProviderFeatureRevisionProjection(
        priorCapability,
        capability,
        stateFor(prior),
        stateFor(next),
      )
    ) {
      throw new Error("thread_projection_provider_feature_revision_conflict");
    }
  }
}

function sameProviderFeatureRevisionProjection(
  priorCapability: NormalizedThreadSnapshot["capabilities"]["providerFeatures"][number],
  nextCapability: NormalizedThreadSnapshot["capabilities"]["providerFeatures"][number],
  priorState: NormalizedThreadSnapshot["providerFeatures"][number] | undefined,
  nextState: NormalizedThreadSnapshot["providerFeatures"][number] | undefined,
): boolean {
  if (!sameValue(priorState, nextState)) return false;
  if (sameValue(priorCapability, nextCapability)) return true;
  if (
    priorCapability.availability === "unavailable" ||
    nextCapability.availability === "unavailable"
  ) {
    return false;
  }
  const {
    availability: _priorAvailability,
    unavailableReason: _priorReason,
    operations: priorOperations,
    ...priorProviderCapability
  } = priorCapability;
  const {
    availability: _nextAvailability,
    unavailableReason: _nextReason,
    operations: nextOperations,
    ...nextProviderCapability
  } = nextCapability;
  if (!sameValue(priorProviderCapability, nextProviderCapability)) return false;
  if (!sameOperationProjection(priorOperations, nextOperations)) return false;
  return (
    priorCapability.availability !== nextCapability.availability ||
    sameValue(
      priorCapability.unavailableReason,
      nextCapability.unavailableReason,
    )
  );
}

function sameOperationProjection(
  prior: readonly unknown[],
  next: readonly unknown[],
): boolean {
  if (sameValue(prior, next)) return true;
  if (prior.length === 0 || next.length === 0) return false;
  const orderedSubset = (
    subset: readonly unknown[],
    superset: readonly unknown[],
  ): boolean => {
    let subsetIndex = 0;
    for (const operation of superset) {
      if (sameValue(subset[subsetIndex], operation)) subsetIndex += 1;
    }
    return subsetIndex === subset.length;
  };
  return orderedSubset(prior, next) || orderedSubset(next, prior);
}

function applyIncremental(
  snapshot: NormalizedThreadSnapshot | undefined,
  event: Exclude<NormalizedThreadEvent, { readonly type: "snapshot" }>,
): NormalizedThreadSnapshot {
  if (!snapshot) throw new Error("thread_projection_snapshot_required");
  let next: NormalizedThreadSnapshot;
  switch (event.type) {
    case "history_prepend": {
      if (
        event.page.orderedTurnIds.some((turnId) =>
          Object.hasOwn(snapshot.turnsById, turnId),
        ) ||
        Object.keys(event.page.itemsById).some((itemId) =>
          Object.hasOwn(snapshot.itemsById, itemId),
        )
      ) {
        throw new Error("thread_projection_history_overlap");
      }
      const forksByTurnId = {
        ...forkCapabilities(event.page.turnsById, event.page.itemsById, snapshot.forkSource),
        ...snapshot.forksByTurnId,
      };
      next = {
        ...snapshot,
        orderedTurnIds: [
          ...event.page.orderedTurnIds,
          ...snapshot.orderedTurnIds,
        ],
        turnsById: { ...event.page.turnsById, ...snapshot.turnsById },
        forksByTurnId,
        itemsById: { ...event.page.itemsById, ...snapshot.itemsById },
        history: event.page.previousCursor
          ? { hasOlder: true, olderCursor: event.page.previousCursor }
          : { hasOlder: false },
      };
      if (
        next.orderedTurnIds.length > MAXIMUM_NORMALIZED_TIMELINE_TURNS
      ) {
        throw new Error("thread_projection_history_limit_exceeded");
      }
      break;
    }
    case "turn_upsert":
      for (const id of event.turn.orderedItemIds) {
        if (snapshot.itemsById[id]?.turnId !== event.turn.id) throw new Error("thread_projection_turn_item_reference_invalid");
      }
      if (event.fork.expectedTurnRevision !== conversationTurnSourceRevision(event.turn, snapshot.itemsById)) {
        throw new Error("thread_projection_turn_fork_revision_invalid");
      }
      assertRevisionMonotonic(
        snapshot.turnsById[event.turn.id],
        event.turn,
        "thread_projection_turn_revision_regressed",
        "thread_projection_turn_revision_conflict",
      );
      next = {
        ...snapshot,
        orderedTurnIds: Object.hasOwn(snapshot.turnsById, event.turn.id)
          ? snapshot.orderedTurnIds
          : [...snapshot.orderedTurnIds, event.turn.id],
        turnsById: { ...snapshot.turnsById, [event.turn.id]: event.turn },
        forksByTurnId: {
          ...snapshot.forksByTurnId,
          [event.turn.id]: clampTurnFork(event.fork, snapshot.forkSource),
        },
      };
      break;
    case "fork_source_state_changed":
      next = {
        ...snapshot,
        forkSource: event.forkSource,
        forksByTurnId: forkCapabilities(snapshot.turnsById, snapshot.itemsById, event.forkSource),
      };
      break;
    case "item_upsert":
      assertRevisionMonotonic(
        snapshot.itemsById[event.item.id],
        event.item,
        "thread_projection_item_revision_regressed",
        "thread_projection_item_revision_conflict",
      );
      next = {
        ...snapshot,
        itemsById: { ...snapshot.itemsById, [event.item.id]: event.item },
      };
      break;
    case "run_state":
      next = {
        ...snapshot,
        thread: { ...snapshot.thread, runState: event.state },
        capabilities: { ...snapshot.capabilities, runState: event.state },
        runState: event.state,
        ...(event.activeTurnId
          ? { activeTurnId: event.activeTurnId }
          : { activeTurnId: undefined }),
      };
      break;
    case "queue_changed":
      if (event.threadRevision < snapshot.thread.threadRevision) {
        throw new Error("thread_projection_thread_revision_regressed");
      }
      if (
        event.threadRevision === snapshot.thread.threadRevision &&
        !sameValue(snapshot.queue, event.items)
      ) {
        throw new Error("thread_projection_queue_revision_conflict");
      }
      next = {
        ...snapshot,
        thread: {
          ...snapshot.thread,
          threadRevision: event.threadRevision,
          queuedInputCount: event.items.length,
        },
        queue: event.items,
      };
      break;
    case "capabilities_changed":
      assertProviderFeatureProjectionMonotonic(snapshot, event);
      next = {
        ...snapshot,
        thread: {
          ...snapshot.thread,
          threadRevision: Math.max(
            snapshot.thread.threadRevision,
            event.threadRevision,
          ),
        },
        capabilities: { ...event.capabilities, runState: snapshot.runState },
        providerFeatures: event.providerFeatures,
      };
      break;
    case "interaction_opened": {
      const existingIndex = snapshot.interactions.findIndex(
        ({ id }) => id === event.interaction.id,
      );
      const interactions = [...snapshot.interactions];
      if (existingIndex === -1) interactions.push(event.interaction);
      else interactions[existingIndex] = event.interaction;
      next = {
        ...snapshot,
        interactions,
      };
      break;
    }
    case "interaction_resolved":
      next = {
        ...snapshot,
        interactions: snapshot.interactions.filter(
          ({ id }) => id !== event.interactionId,
        ),
      };
      break;
    case "usage_revision_changed":
      next = snapshot;
      break;
    case "usage_changed":
      next = { ...snapshot, usage: event.usage };
      break;
    case "background_activity_changed":
      next = { ...snapshot, backgroundActivity: event.activity };
      break;
    case "thread_changed":
      next = { ...snapshot, thread: event.thread };
      break;
    case "draft_changed":
      next = { ...snapshot, draft: event.draft };
      break;
    case "stashes_changed":
      next = { ...snapshot, stashes: event.stashes };
      break;
    case "settings_changed":
      next = { ...snapshot, settings: event.settings };
      break;
    case "attention_changed":
      next = { ...snapshot, attention: event.attention };
      break;
    case "application_state_changed":
      assertThreadSummaryMonotonic(snapshot.thread, event.state.thread);
      assertRevisionMonotonic(
        snapshot.draft,
        event.state.draft,
        "thread_projection_draft_revision_regressed",
        "thread_projection_draft_revision_conflict",
      );
      assertRevisionMonotonic(
        snapshot.settings,
        event.state.settings,
        "thread_projection_settings_revision_regressed",
        "thread_projection_settings_revision_conflict",
      );
      assertRevisionMonotonic(
        snapshot.agentTools,
        event.state.agentTools,
        "thread_projection_agent_tool_revision_regressed",
        "thread_projection_agent_tool_revision_conflict",
        sameAgentToolPolicyRevision,
      );
      assertProviderFeatureProjectionMonotonic(snapshot, event.state);
      next = {
        ...snapshot,
        ...event.state,
        ...(event.state.recovery
          ? { recovery: event.state.recovery }
          : { recovery: undefined }),
        forksByTurnId: forkCapabilities(
          snapshot.turnsById,
          snapshot.itemsById,
          event.state.forkSource,
        ),
      };
      break;
    case "questions_changed":
    case "notice":
    case "notice_dismissed":
      return snapshot;
  }
  return next;
}

function forkCapabilities(
  turnsById: NormalizedThreadSnapshot["turnsById"],
  itemsById: NormalizedThreadSnapshot["itemsById"],
  forkSource: ThreadForkSourceCapability,
): NormalizedThreadSnapshot["forksByTurnId"] {
  return Object.fromEntries(
    Object.values(turnsById).map((turn) => {
      const turnEligible =
        turn.status === "completed" && turn.endedBy === "agent_settled";
      const available =
        turnEligible && forkSource.selectedCompletedTurn.available;
      return [
        turn.id,
        {
          sourceTurnId: turn.id,
          expectedTurnRevision: conversationTurnSourceRevision(turn, itemsById),
          available,
          ...(available
            ? {}
            : {
                unavailableReason: turnEligible
                  ? forkSource.selectedCompletedTurn.unavailableReason!
                  : {
                      text: "Only a successfully completed turn can be forked.",
                    },
              }),
        },
      ];
    }),
  );
}

function clampTurnFork(
  fork: NormalizedThreadSnapshot["forksByTurnId"][string],
  forkSource: ThreadForkSourceCapability,
): NormalizedThreadSnapshot["forksByTurnId"][string] {
  if (!fork.available || forkSource.selectedCompletedTurn.available) {
    return fork;
  }
  return {
    sourceTurnId: fork.sourceTurnId,
    expectedTurnRevision: fork.expectedTurnRevision,
    available: false,
    unavailableReason: forkSource.selectedCompletedTurn.unavailableReason!,
  };
}
