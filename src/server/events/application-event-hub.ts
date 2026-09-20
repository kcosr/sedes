import {
  normalizedApplicationEventSchema,
  type ApplicationEventEnvelope,
  type NormalizedApplicationEvent,
} from "../../shared/protocol/application.js";
import { EventHub, type EventHubOptions } from "./event-hub.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { ApplicationProjection } from "./application-projection.js";
import { assertBoundedSseFrame } from "./sse-frame.js";

export const DEFAULT_APPLICATION_EVENT_HUB_REPLAY_LIMIT = 32;
export const DEFAULT_APPLICATION_EVENT_HUB_REPLAY_BYTE_LIMIT = 64 * 1_024;
export const DEFAULT_APPLICATION_EVENT_HUB_IDLE_RETENTION_MILLISECONDS =
  60 * 60 * 1_000;
export const DEFAULT_APPLICATION_EVENT_HUB_IDLE_BYTE_LIMIT =
  256 * 1_024 * 1_024;
export interface ApplicationEventSubscription {
  readonly watermark: number;
  readonly replay: readonly ApplicationEventEnvelope[];
  close(): void;
}
export type ApplicationCheckpoint = ApplicationEventEnvelope & {
  event: Extract<NormalizedApplicationEvent, { type: "snapshot" }>;
};
export interface ApplicationDelivery {
  readonly envelope: ApplicationEventEnvelope;
  readonly frame: string;
  readonly bytes: number;
}
function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function delivery(envelope: ApplicationEventEnvelope): ApplicationDelivery {
  const frame = assertBoundedSseFrame(
    `id: ${envelope.eventId}\nevent: application\ndata: ${JSON.stringify(envelope)}\n\n`,
  );
  return { envelope, frame, bytes: Buffer.byteLength(frame, "utf8") };
}

/** Co-owned projection, stream position and replay. Only the publication boundary writes. */
export class ApplicationEventHub {
  readonly #hub: EventHub<ApplicationDelivery>;
  readonly #deliveries = new WeakMap<
    ApplicationEventEnvelope,
    ApplicationDelivery
  >();
  readonly #closeListeners = new Set<() => void>();
  #projection?: ApplicationProjection;
  #checkpoint?: ApplicationDelivery;
  #state: "unseeded" | "seeding" | "ready" | "recapturing" | "closed" =
    "unseeded";
  #invalidReason?: string;
  requestedEpoch = 0;
  coveredEpoch = 0;
  lastCaptureAt = -Infinity;
  recoverySpacing = 0;
  #readySince = -Infinity;
  readonly forkSelectionSaturated = new Map<string, boolean>();

  constructor(
    options: EventHubOptions = {},
    readonly lifecycle?: {
      subscribersChanged(): void;
      changed(): void;
    },
  ) {
    this.#hub = new EventHub({
      ...options,
      replayLimit: Math.min(
        options.replayLimit ?? DEFAULT_APPLICATION_EVENT_HUB_REPLAY_LIMIT,
        DEFAULT_APPLICATION_EVENT_HUB_REPLAY_LIMIT,
      ),
      replayByteLimit: Math.min(
        options.replayByteLimit ??
          DEFAULT_APPLICATION_EVENT_HUB_REPLAY_BYTE_LIMIT,
        DEFAULT_APPLICATION_EVENT_HUB_REPLAY_BYTE_LIMIT,
      ),
      supersedesReplay: (type) => type === "snapshot",
    });
  }
  get generation(): string {
    return this.#hub.generation;
  }
  get watermark(): number {
    return this.#hub.watermark;
  }
  get subscriberCount(): number {
    return this.#hub.subscriberCount;
  }
  get retainedEventCount(): number {
    return this.#hub.retainedEventCount;
  }
  get retainedBytes(): number {
    return this.#hub.retainedBytes;
  }
  get state() {
    return this.#state;
  }
  get invalidReason() {
    return this.#invalidReason;
  }
  get projection() {
    return this.#projection;
  }
  get pendingReplacement(): boolean {
    return this.requestedEpoch > this.coveredEpoch;
  }
  get accountedBytes(): number {
    return (
      (this.#projection?.serializedBytes ?? 0) +
      this.retainedBytes +
      (this.#checkpoint
        ? this.#checkpoint.bytes + (this.#projection?.serializedBytes ?? 0)
        : 0)
    );
  }
  eventIdAt(sequence: number): string {
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new Error("application_event_sequence_invalid");
    return `${this.generation}.${sequence}`;
  }
  sequenceOf(eventId: string): number | undefined {
    const prefix = `${this.generation}.`;
    if (!eventId.startsWith(prefix)) return undefined;
    const suffix = eventId.slice(prefix.length);
    if (!/^(0|[1-9]\d*)$/.test(suffix)) return undefined;
    const n = Number(suffix);
    return Number.isSafeInteger(n) && n <= this.watermark ? n : undefined;
  }
  beginCapture(): void {
    this.#assertOpen();
    this.#state = this.#projection ? "recapturing" : "seeding";
  }
  invalidate(reason: string): void {
    if (this.#state === "closed") return;
    if (
      this.#state === "ready" &&
      performance.now() - this.#readySince >= 60_000
    )
      this.recoverySpacing = 0;
    this.#state = "recapturing";
    this.#invalidReason = reason;
    this.#checkpoint = undefined;
  }
  onClose(listener: () => void): () => void {
    if (this.#state === "closed") {
      listener();
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }
  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#projection = undefined;
    this.#checkpoint = undefined;
    this.forkSelectionSaturated.clear();
    for (const listener of [...this.#closeListeners]) listener();
    this.#closeListeners.clear();
    this.#hub.close();
  }
  publish(raw: NormalizedApplicationEvent): ApplicationEventEnvelope {
    this.#assertOpen();
    const event = immutable(normalizedApplicationEventSchema.parse(raw));
    if (event.generation !== this.generation)
      throw new Error("application_event_generation_mismatch");
    if (event.type !== "snapshot" && this.#state !== "ready")
      throw new Error("application_projection_snapshot_required");
    // All fallible preparation precedes the sequence commit and subscriber callbacks.
    const projection =
      event.type === "snapshot"
        ? new ApplicationProjection(event.snapshot)
        : this.#projection!;
    const fold =
      event.type === "snapshot" ? () => {} : projection.prepare(event);
    const envelope: ApplicationEventEnvelope = Object.freeze({
      eventId: this.eventIdAt(this.watermark + 1),
      applicationGeneration: this.generation,
      event,
    });
    const prepared = delivery(envelope);
    this.#deliveries.set(envelope, prepared);
    try {
      this.#hub.publish(event.type, prepared, {
        bytes: prepared.bytes,
        retain: event.type !== "snapshot",
        beforeFanout: () => {
          fold();
          this.#projection = projection;
          this.#checkpoint = event.type === "snapshot" ? prepared : undefined;
          this.#state = "ready";
          if (event.type === "snapshot") this.#readySince = performance.now();
          this.#invalidReason = undefined;
        },
      });
    } catch (error) {
      this.close();
      throw error;
    }
    this.lifecycle?.changed();
    return envelope;
  }
  encoded(envelope: ApplicationEventEnvelope): ApplicationDelivery {
    const result = this.#deliveries.get(envelope);
    if (!result) throw new Error("application_event_not_owned");
    return result;
  }
  currentCheckpoint(): ApplicationCheckpoint | undefined {
    if (this.#state !== "ready" || !this.#projection) return undefined;
    if (!this.#checkpoint) {
      const envelope: ApplicationCheckpoint = immutable({
        eventId: this.eventIdAt(this.watermark),
        applicationGeneration: this.generation,
        event: {
          type: "snapshot",
          generation: this.generation,
          snapshot: this.#projection.materialize(),
        },
      });
      this.#checkpoint = delivery(envelope);
      this.#deliveries.set(envelope, this.#checkpoint);
      this.lifecycle?.changed();
    }
    return this.#checkpoint.envelope as ApplicationCheckpoint;
  }
  subscribe(
    listener: (event: ApplicationEventEnvelope) => void,
    cursor?: string,
  ): ApplicationEventSubscription {
    this.#assertOpen();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      sub.close();
      this.lifecycle?.subscribersChanged();
    };
    const sub = this.#hub.subscribe((event) => {
      try {
        listener(event.data.envelope);
      } catch {
        close();
      }
    }, cursor);
    this.lifecycle?.subscribersChanged();
    return {
      watermark: sub.watermark,
      replay: sub.replay.map((event) => event.data.envelope),
      close,
    };
  }
  canReplay(cursor: string | undefined): boolean {
    if (
      this.#state !== "ready" ||
      this.pendingReplacement ||
      !this.#hub.canReplay(cursor)
    )
      return false;
    const sequence = this.sequenceOf(cursor!);
    return (
      sequence !== undefined &&
      this.watermark - sequence <= DEFAULT_APPLICATION_EVENT_HUB_REPLAY_LIMIT &&
      (this.#hub.replayBytesAfter(cursor) ?? Infinity) <=
        DEFAULT_APPLICATION_EVENT_HUB_REPLAY_BYTE_LIMIT
    );
  }
  #assertOpen(): void {
    if (this.#state === "closed")
      throw new Error("application_projection_closed");
  }
}

function scopeKey(scope: RequestScope): string {
  return `${scope.tenantId}\0${scope.principalId}`;
}
export interface ScopedApplicationEventHubOptions {
  readonly maximumRetainedHubs?: number;
  readonly idleRetentionMilliseconds?: number;
  readonly idleByteLimit?: number;
  readonly replayLimit?: number;
  readonly replayByteLimit?: number;
}
interface Entry {
  hub: ApplicationEventHub;
  expiration?: NodeJS.Timeout;
  idleSince: number;
}
export class ScopedApplicationEventHubs {
  readonly #hubs = new Map<string, Entry>();
  readonly #max: number;
  readonly #idleMs: number;
  readonly #idleBytes: number;
  constructor(readonly options: ScopedApplicationEventHubOptions = {}) {
    this.#max = options.maximumRetainedHubs ?? 128;
    this.#idleMs =
      options.idleRetentionMilliseconds ??
      DEFAULT_APPLICATION_EVENT_HUB_IDLE_RETENTION_MILLISECONDS;
    this.#idleBytes =
      options.idleByteLimit ?? DEFAULT_APPLICATION_EVENT_HUB_IDLE_BYTE_LIMIT;
    for (const [value, code] of [
      [this.#max, "registry_limit"],
      [this.#idleMs, "idle_retention"],
      [this.#idleBytes, "idle_byte_limit"],
      [options.replayLimit ?? 32, "replay_limit"],
      [options.replayByteLimit ?? 65_536, "replay_byte_limit"],
    ] as const)
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`application_event_hub_${code}_invalid`);
  }
  get retainedHubCount(): number {
    return this.#hubs.size;
  }
  peek(scope: RequestScope): ApplicationEventHub | undefined {
    return this.#hubs.get(scopeKey(scope))?.hub;
  }
  owns(scope: RequestScope, hub: ApplicationEventHub): boolean {
    return this.peek(scope) === hub && hub.state !== "closed";
  }
  application(scope: RequestScope): ApplicationEventHub {
    const key = scopeKey(scope);
    const existing = this.#hubs.get(key);
    if (existing) return existing.hub;
    const entry: Entry = { hub: undefined!, idleSince: performance.now() };
    entry.hub = new ApplicationEventHub(this.options, {
      subscribersChanged: () => {
        if (this.#hubs.get(key) !== entry) return;
        if (entry.hub.subscriberCount) {
          if (entry.expiration) clearTimeout(entry.expiration);
          entry.expiration = undefined;
        } else if (
          entry.hub.pendingReplacement ||
          entry.hub.state === "seeding" ||
          entry.hub.state === "recapturing"
        )
          this.#delete(key, entry);
        else this.#retain(key, entry);
      },
      changed: () => this.#evict(),
    });
    this.#hubs.set(key, entry);
    entry.hub.onClose(() => {
      if (this.#hubs.get(key) === entry) {
        this.#hubs.delete(key);
        if (entry.expiration) clearTimeout(entry.expiration);
      }
    });
    this.#retain(key, entry);
    return entry.hub;
  }
  release(scope: RequestScope): void {
    const key = scopeKey(scope),
      entry = this.#hubs.get(key);
    if (entry && !entry.hub.subscriberCount && !entry.expiration)
      this.#retain(key, entry);
  }
  retire(scope: RequestScope, hub: ApplicationEventHub): void {
    const key = scopeKey(scope),
      entry = this.#hubs.get(key);
    if (entry?.hub === hub) this.#delete(key, entry);
  }
  close(): void {
    for (const [key, entry] of [...this.#hubs]) this.#delete(key, entry);
  }
  #retain(key: string, entry: Entry): void {
    if (entry.expiration) return;
    entry.idleSince = performance.now();
    entry.expiration = setTimeout(() => {
      if (!entry.hub.subscriberCount) this.#delete(key, entry);
    }, this.#idleMs);
    entry.expiration.unref();
    this.#evict();
  }
  #evict(): void {
    const idle = [...this.#hubs]
      .filter(([, entry]) => !entry.hub.subscriberCount)
      .sort((a, b) => a[1].idleSince - b[1].idleSince);
    let count = idle.length,
      bytes = idle.reduce(
        (sum, [, entry]) => sum + entry.hub.accountedBytes,
        0,
      );
    for (const [key, entry] of idle) {
      if (count <= this.#max && bytes <= this.#idleBytes) break;
      count--;
      bytes -= entry.hub.accountedBytes;
      this.#delete(key, entry);
    }
  }
  #delete(key: string, entry: Entry): void {
    if (this.#hubs.get(key) !== entry) return;
    this.#hubs.delete(key);
    if (entry.expiration) clearTimeout(entry.expiration);
    entry.hub.close();
  }
}
