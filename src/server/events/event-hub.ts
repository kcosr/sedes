import { randomUUID } from "node:crypto";

export interface SequencedEvent<T> {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly data: T;
}

export interface EventSubscription<T> {
  readonly watermark: number;
  readonly replay: readonly SequencedEvent<T>[];
  close(): void;
}

interface Subscriber<T> {
  readonly listener: (event: SequencedEvent<T>) => void;
}

export interface EventHubOptions {
  readonly replayLimit?: number;
  readonly replayByteLimit?: number;
  readonly supersedesReplay?: (type: string, data: unknown) => boolean;
}

/**
 * Thread hubs materialize a complete current snapshot separately, so
 * this buffer can devote its 32 MiB to the contiguous incremental suffix while
 * still allowing bursty provider output during a disconnect.
 */
export const DEFAULT_EVENT_HUB_REPLAY_LIMIT = 4_096;
export const DEFAULT_EVENT_HUB_REPLAY_BYTE_LIMIT = 32 * 1_024 * 1_024;

export class EventHub<T> {
  readonly generation = randomUUID();
  private sequence = 0;
  private readonly events: {
    readonly event: SequencedEvent<T>;
    readonly bytes: number;
  }[] = [];
  private readonly subscribers = new Set<Subscriber<T>>();
  private readonly replayLimit: number;
  private readonly replayByteLimit: number;
  private readonly supersedesReplay: (type: string, data: T) => boolean;
  private replayBytes = 0;

  constructor(options: EventHubOptions = {}) {
    this.replayLimit = options.replayLimit ?? DEFAULT_EVENT_HUB_REPLAY_LIMIT;
    this.replayByteLimit =
      options.replayByteLimit ?? DEFAULT_EVENT_HUB_REPLAY_BYTE_LIMIT;
    this.supersedesReplay =
      (options.supersedesReplay as
        | ((type: string, data: T) => boolean)
        | undefined) ?? (() => false);
    if (!Number.isSafeInteger(this.replayLimit) || this.replayLimit <= 0) {
      throw new Error("event_hub_replay_limit_invalid");
    }
    if (
      !Number.isSafeInteger(this.replayByteLimit) ||
      this.replayByteLimit <= 0
    ) {
      throw new Error("event_hub_replay_byte_limit_invalid");
    }
  }

  get watermark(): number {
    return this.sequence;
  }

  publish(
    type: string,
    data: T,
    commit?: {
      readonly bytes: number;
      readonly retain: boolean;
      readonly beforeFanout: (event: SequencedEvent<T>) => void;
    },
  ): SequencedEvent<T> {
    const event: SequencedEvent<T> = {
      id: `${this.generation}.${this.sequence + 1}`,
      sequence: this.sequence + 1,
      type,
      data,
    };
    const eventBytes =
      commit?.bytes ?? Buffer.byteLength(JSON.stringify(event), "utf8");
    this.sequence = event.sequence;
    if (this.supersedesReplay(type, data)) {
      this.events.length = 0;
      this.replayBytes = 0;
    }
    if (commit?.retain === false || eventBytes > this.replayByteLimit) {
      // Replay storage represents only a contiguous suffix. Retaining events
      // from before an individually oversized event would make the preceding
      // cursor appear replayable even though that event was omitted.
      this.events.length = 0;
      this.replayBytes = 0;
    } else {
      this.events.push({ event, bytes: eventBytes });
      this.replayBytes += eventBytes;
      while (
        this.events.length > this.replayLimit ||
        this.replayBytes > this.replayByteLimit
      ) {
        const removed = this.events.shift();
        if (!removed) break;
        // Reuse the publication-time byte count; eviction must not serialize
        // retained output a second time.
        this.replayBytes -= removed.bytes;
      }
    }

    commit?.beforeFanout(event);
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.listener(event);
      } catch {
        // A transport/subscriber failure cannot interrupt publication to the
        // remaining clients. Remove the failed subscriber so it cannot keep
        // throwing on later authoritative events.
        this.subscribers.delete(subscriber);
      }
    }

    return event;
  }

  close(): void {
    this.subscribers.clear();
    this.events.length = 0;
    this.replayBytes = 0;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get retainedEventCount(): number {
    return this.events.length;
  }

  get retainedBytes(): number {
    return this.replayBytes;
  }

  subscribe(
    listener: (event: SequencedEvent<T>) => void,
    lastEventId?: string,
  ): EventSubscription<T> {
    const subscriber: Subscriber<T> = {
      listener,
    };
    this.subscribers.add(subscriber);

    const requestedSequence = this.parseEventId(lastEventId);
    const oldest = this.events[0]?.event.sequence ?? this.sequence + 1;
    const replay =
      requestedSequence !== undefined && requestedSequence >= oldest - 1
        ? this.events
            .filter(({ event }) => event.sequence > requestedSequence)
            .map(({ event }) => event)
        : [];

    return {
      watermark: this.sequence,
      replay,
      close: () => this.subscribers.delete(subscriber),
    };
  }

  canReplay(lastEventId: string | undefined): boolean {
    const requestedSequence = this.parseEventId(lastEventId);
    if (requestedSequence === undefined) {
      return false;
    }
    const oldest = this.events[0]?.event.sequence ?? this.sequence + 1;
    return (
      requestedSequence >= oldest - 1 && requestedSequence <= this.sequence
    );
  }

  /** Publication-time byte counts avoid serializing retained output again. */
  replayBytesAfter(lastEventId: string | undefined): number | undefined {
    if (!this.canReplay(lastEventId)) return undefined;
    const requestedSequence = this.parseEventId(lastEventId)!;
    let bytes = 0;
    for (const retained of this.events) {
      if (retained.event.sequence > requestedSequence) bytes += retained.bytes;
    }
    return bytes;
  }

  /** Visits only enough retained events to compare a projected suffix cost. */
  replayCostExceeds(
    lastEventId: string,
    budget: number,
    cost: (event: SequencedEvent<T>) => number,
  ): boolean | undefined {
    if (!this.canReplay(lastEventId)) return undefined;
    const requestedSequence = this.parseEventId(lastEventId)!;
    let total = 0;
    for (const { event } of this.events) {
      if (event.sequence <= requestedSequence) continue;
      total += cost(event);
      if (total > budget) return true;
    }
    return false;
  }

  private parseEventId(eventId: string | undefined): number | undefined {
    if (!eventId) {
      return undefined;
    }
    const match = /^([0-9a-f-]+)\.(\d+)$/.exec(eventId);
    if (!match || match[1] !== this.generation) {
      return undefined;
    }
    const sequence = Number(match[2]);
    return Number.isSafeInteger(sequence) && sequence >= 0
      ? sequence
      : undefined;
  }
}
