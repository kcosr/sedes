import { randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";
import type { GetSessionMessagesOptions, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { SidecarOperationError } from "../../../internal/sidecar-protocol/operation-registry.js";
import { snapshotBoundedJson } from "../../provider-protocol/json/bounded-json-snapshot.js";

export const CLAUDE_HISTORY_PAGE_BYTES = 4 * 1024 * 1024;
export const CLAUDE_HISTORY_RESPONSE_BYTES = 32 * 1024 * 1024;
export const CLAUDE_HISTORY_MAXIMUM_BYTES = 256 * 1024 * 1024;
export const CLAUDE_HISTORY_MAXIMUM_MESSAGES = 262_144;
// The byte budget normally governs; this caps pages of very small records.
export const CLAUDE_HISTORY_PAGE_MESSAGES = 8_192;
export const CLAUDE_HISTORY_SNAPSHOT_IDLE_MS = 120_000;
export const CLAUDE_HISTORY_LOAD_TIMEOUT_MS = 30_000;
export const CLAUDE_HISTORY_MAXIMUM_SNAPSHOTS = 32;
const MAXIMUM_INFLIGHT_LOADS = 32;

/** A private acquisition identity, never a provider persistence cursor. */
export interface ClaudeHistoryCursor {
  readonly snapshotId: string;
  readonly offset: number;
  readonly end: number;
}
export type ClaudeHistoryPageOptions = Pick<GetSessionMessagesOptions, "dir" | "includeSystemMessages" | "offset" | "limit"> & {
  readonly cursor?: ClaudeHistoryCursor;
  readonly maintenance?: boolean;
};
export interface ClaudeHistoryPage<Message extends SessionMessage = SessionMessage> {
  readonly messages: Message[];
  readonly nextCursor: ClaudeHistoryCursor | null;
}

type Acquisition<Message extends SessionMessage> = {
  id: string; scope: string; maintenance: boolean; start: number; end: number; nextOffset: number;
  messages: readonly Message[]; sizes: number[]; bytes: number;
  idleExpiresAt: number; timer?: ReturnType<typeof setTimeout>;
};

/**
 * Bounded transient acquisitions owned by one runtime. The loader transfers
 * detached rows and must not mutate them after resolving. Pages reuse one
 * captured native read even if the provider later rewrites it. Acquisition
 * identities are never reused; snapshots expire only on inactivity or actual
 * cache pressure, so slow but progressing transfers have no throughput floor.
 * The SDK still materializes native history outside the retained-cache bound.
 */
export class ClaudeHistoryPager<Message extends SessionMessage = SessionMessage> {
  readonly #snapshots = new Map<string, Acquisition<Message>>();
  readonly #loads = new Set<object>();
  readonly #disposal = new AbortController();
  #bytes = 0;

  constructor() {
    setMaxListeners(MAXIMUM_INFLIGHT_LOADS, this.#disposal.signal);
  }

  async getPage(
    ownerScope: string,
    options: ClaudeHistoryPageOptions,
    load: () => Promise<readonly Message[]>,
  ): Promise<ClaudeHistoryPage<Message>> {
    if (this.#disposal.signal.aborted) throw historyError("closed");
    const scope = JSON.stringify([ownerScope, options.dir ?? null, options.includeSystemMessages ?? false,
      options.offset ?? 0, options.limit ?? null, options.maintenance ?? false]);
    if (options.cursor) {
      const snapshot = this.#snapshots.get(options.cursor.snapshotId);
      if (!snapshot) throw historyError("expired", true);
      if (Date.now() >= snapshot.idleExpiresAt) {
        this.#release(snapshot);
        throw historyError("expired", true);
      }
      if (snapshot.scope !== scope || snapshot.end !== options.cursor.end || snapshot.nextOffset !== options.cursor.offset) {
        throw historyError("invalid");
      }
      return this.#page(snapshot);
    }
    const history = await this.#load(load);
    if (this.#disposal.signal.aborted) throw historyError("closed");
    const start = Math.min(options.offset ?? 0, history.length);
    const end = Math.min(history.length, options.limit === undefined ? history.length : start + options.limit);
    if (end - start > CLAUDE_HISTORY_MAXIMUM_MESSAGES) throw new SidecarOperationError("claude_runtime_history_limit_exceeded");
    const messages = history.slice(start, end);
    let bytes = 0;
    const sizes = messages.map(message => {
      const size = Buffer.byteLength(JSON.stringify(message), "utf8");
      bytes += size;
      if (bytes > CLAUDE_HISTORY_MAXIMUM_BYTES) throw new SidecarOperationError("claude_runtime_history_limit_exceeded");
      return size;
    });
    return this.#page({ id: randomUUID(), scope, maintenance: options.maintenance === true, start, end, nextOffset: start,
      messages, sizes, bytes, idleExpiresAt: 0 });
  }

  close(): void {
    this.#disposal.abort();
    for (const snapshot of this.#snapshots.values()) this.#release(snapshot);
  }

  async #load(load: () => Promise<readonly Message[]>): Promise<readonly Message[]> {
    if (this.#loads.size >= MAXIMUM_INFLIGHT_LOADS) throw historyError("busy", true);
    const reservation = {};
    this.#loads.add(reservation);
    const pending = Promise.resolve().then(() => {
      if (this.#disposal.signal.aborted) throw historyError("closed");
      return load();
    });
    // The SDK offers no cancellation for history reads. A timed-out native read
    // still occupies its reservation until it actually settles; repeated caller
    // timeouts cannot create unlimited outstanding native reads.
    void pending.then(() => this.#loads.delete(reservation), () => this.#loads.delete(reservation));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(historyError("load_timeout", true)), CLAUDE_HISTORY_LOAD_TIMEOUT_MS);
      timer.unref();
      disposed = () => reject(historyError("closed"));
      this.#disposal.signal.addEventListener("abort", disposed, { once: true });
    });
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
      if (disposed) this.#disposal.signal.removeEventListener("abort", disposed);
    }
  }

  #release(snapshot: Acquisition<Message>): void {
    if (this.#snapshots.get(snapshot.id) !== snapshot) return;
    clearTimeout(snapshot.timer);
    this.#snapshots.delete(snapshot.id);
    this.#bytes -= snapshot.bytes;
  }

  #retain(snapshot: Acquisition<Message>): void {
    // Background reclamation must never restart another reader's transfer.
    // Existing snapshots already fit; only new maintenance admission can fail.
    if (snapshot.maintenance && !this.#snapshots.has(snapshot.id) && (
      this.#snapshots.size >= CLAUDE_HISTORY_MAXIMUM_SNAPSHOTS ||
      this.#bytes + snapshot.bytes > CLAUDE_HISTORY_MAXIMUM_BYTES
    )) throw historyError("busy", true);
    this.#release(snapshot);
    while (this.#snapshots.size >= CLAUDE_HISTORY_MAXIMUM_SNAPSHOTS || this.#bytes + snapshot.bytes > CLAUDE_HISTORY_MAXIMUM_BYTES) {
      this.#release(this.#snapshots.values().next().value!);
    }
    this.#snapshots.set(snapshot.id, snapshot);
    this.#bytes += snapshot.bytes;
    snapshot.idleExpiresAt = Date.now() + CLAUDE_HISTORY_SNAPSHOT_IDLE_MS;
    snapshot.timer = setTimeout(() => this.#release(snapshot), CLAUDE_HISTORY_SNAPSHOT_IDLE_MS);
    snapshot.timer.unref();
  }

  #page(snapshot: Acquisition<Message>): ClaudeHistoryPage<Message> {
    const messages: Message[] = [];
    let bytes = 0;
    let nextOffset = snapshot.nextOffset;
    while (nextOffset < snapshot.end) {
      const index = nextOffset - snapshot.start;
      const size = snapshot.sizes[index]!;
      if (messages.length && (bytes + size > CLAUDE_HISTORY_PAGE_BYTES || messages.length >= CLAUDE_HISTORY_PAGE_MESSAGES)) break;
      messages.push(snapshot.messages[index]!);
      bytes += size;
      nextOffset++;
    }
    const response = {
      messages,
      nextCursor: nextOffset < snapshot.end ? { snapshotId: snapshot.id, offset: nextOffset, end: snapshot.end } : null,
    };
    try {
      // Validate and detach only this page, never the complete acquisition again.
      const page = snapshotBoundedJson(response, {
        maximumDepth: 68, maximumObjectProperties: 16_384,
        maximumArrayItems: CLAUDE_HISTORY_MAXIMUM_MESSAGES,
        maximumStringBytes: 64 * 1024 * 1024, maximumTotalNodes: 1_000_000,
        maximumEncodedBytes: CLAUDE_HISTORY_RESPONSE_BYTES,
      }) as unknown as ClaudeHistoryPage<Message>;
      snapshot.nextOffset = nextOffset;
      if (!page.nextCursor) this.#release(snapshot);
      else this.#retain(snapshot);
      return page;
    } catch (cause) {
      this.#release(snapshot);
      if (cause instanceof SidecarOperationError) throw cause;
      throw new SidecarOperationError("claude_runtime_history_response_too_large", false, { cause });
    }
  }
}

/** Validate one acquisition while allowing callers to discard each consumed page. */
export async function* iterateClaudeSessionHistory(
  readPage: (options: ClaudeHistoryPageOptions) => Promise<ClaudeHistoryPage>,
  options: ClaudeHistoryPageOptions,
): AsyncGenerator<ClaudeHistoryPage> {
  let cursor: ClaudeHistoryCursor | undefined;
  let bytes = 0;
  let count = 0;
  do {
    const page = await readPage({ ...options, ...(cursor ? { cursor } : {}) });
    bytes += Buffer.byteLength(JSON.stringify(page.messages), "utf8");
    count += page.messages.length;
    if (bytes > CLAUDE_HISTORY_MAXIMUM_BYTES || count > CLAUDE_HISTORY_MAXIMUM_MESSAGES) {
      throw new SidecarOperationError("claude_runtime_history_limit_exceeded");
    }
    const pageEnd = (cursor?.offset ?? options.offset ?? 0) + page.messages.length;
    const next = page.nextCursor;
    if (next ? page.messages.length === 0 || next.offset !== pageEnd ||
      !Number.isSafeInteger(next.offset) || !Number.isSafeInteger(next.end) || next.end <= next.offset ||
      typeof next.snapshotId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(next.snapshotId) ||
      (cursor && (next.end !== cursor.end || next.snapshotId !== cursor.snapshotId))
      : cursor && pageEnd !== cursor.end) {
      throw new SidecarOperationError("claude_runtime_history_page_invalid");
    }
    yield page;
    cursor = next ?? undefined;
  } while (cursor);
}

/** Restart expired acquisitions in full; never concatenate different snapshots. */
export async function readClaudeSessionHistory(
  readPage: (options: ClaudeHistoryPageOptions) => Promise<ClaudeHistoryPage>,
  options: ClaudeHistoryPageOptions,
): Promise<SessionMessage[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const messages: SessionMessage[] = [];
      for await (const page of iterateClaudeSessionHistory(readPage, options)) {
        for (const message of page.messages) messages.push(message);
      }
      return messages;
    } catch (error) {
      if (attempt >= 2 || !(error instanceof SidecarOperationError) || error.code !== "claude_runtime_history_snapshot_expired") throw error;
    }
  }
}

function historyError(reason: "expired" | "invalid" | "busy" | "closed" | "load_timeout", retryable = false): SidecarOperationError {
  return new SidecarOperationError(`claude_runtime_history_snapshot_${reason}`, retryable);
}
