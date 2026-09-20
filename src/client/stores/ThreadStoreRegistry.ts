import type { ApiClient } from "../api/ApiClient";
import type { EventStreamTransport } from "../api/EventStreamTransport";
import type { ActivityDetailMode } from "../../shared/index.js";
import { ThreadClientStore } from "./ThreadClientStore";
import { currentThreadLoadAttempt } from "../app/thread-load-diagnostics.js";
import { recordThreadLoadCategoryDiagnostic } from "../app/diagnostics.js";
import {
  getActivityDetail,
  getDiagnosticCategoryEnabled,
  subscribeActivityDetail,
} from "../app/settings.js";
import { clearPendingActivityDetailExpansion } from "../components/thread/activity-detail-intent.js";
import { isAndroidClient } from "../app/client-platform.js";

// Preserve recent navigation state for an hour. The serialized byte ceiling is
// intentionally below a typical mobile WebView heap because normalized object
// graphs occupy more memory than their wire representation.
export const INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS = 60 * 60_000;
export const MAXIMUM_INACTIVE_THREAD_STORES = 32;
export const MAXIMUM_INACTIVE_THREAD_STORE_BYTES = 256 * 1_024 * 1_024;
export const MAXIMUM_ANDROID_INACTIVE_THREAD_STORE_BYTES = 64 * 1_024 * 1_024;

type ThreadStoreEvictionReason =
  "idle_timeout" | "entry_limit" | "byte_limit" | "registry_dispose";

interface StoreEntry {
  readonly store: ThreadClientStore;
  references: number;
  streamReferences: number;
  inactiveOrder: number;
  inactiveAtMilliseconds: number;
  disposalTimer?: number;
  unsubscribe: () => void;
}

/**
 * Owns the browser's retained normalized thread projections and their streams.
 * Live references share one SSE regardless of consumer count; cache-only pane
 * references never open one. The last live release closes the stream
 * immediately, while the exact store remains available for a bounded
 * cursor-based resume.
 */
export class ThreadStoreRegistry {
  readonly #api: ApiClient;
  readonly #transport: EventStreamTransport;
  readonly #stores = new Map<string, StoreEntry>();
  readonly #maximumInactiveThreadStoreBytes: number;
  #activityDetail: ActivityDetailMode;
  #unsubscribeActivityDetail: () => void;
  #inactiveOrder = 0;

  constructor(api: ApiClient, transport: EventStreamTransport) {
    this.#api = api;
    this.#transport = transport;
    this.#maximumInactiveThreadStoreBytes = isAndroidClient()
      ? MAXIMUM_ANDROID_INACTIVE_THREAD_STORE_BYTES
      : MAXIMUM_INACTIVE_THREAD_STORE_BYTES;
    this.#activityDetail = getActivityDetail();
    this.#unsubscribeActivityDetail = subscribeActivityDetail(
      (activityDetail, source) => {
        if (source !== "inline_activity") {
          clearPendingActivityDetailExpansion();
        }
        if (activityDetail === this.#activityDetail) return;
        this.#activityDetail = activityDetail;
        for (const entry of this.#stores.values()) {
          entry.store.setActivityDetail(activityDetail);
        }
      },
    );
  }

  get(threadId: string): ThreadClientStore {
    let entry = this.#stores.get(threadId);
    if (!entry) {
      const store = new ThreadClientStore(
        threadId,
        this.#api,
        this.#transport,
        this.#activityDetail,
      );
      entry = {
        store,
        references: 0,
        streamReferences: 0,
        inactiveOrder: ++this.#inactiveOrder,
        inactiveAtMilliseconds: Date.now(),
        disposalTimer: undefined,
        unsubscribe: () => undefined,
      };
      entry.unsubscribe = store.subscribe(() => {
        if (entry!.references === 0) this.#enforceInactiveLimits();
      });
      this.#stores.set(threadId, entry);
      this.#armExpiration(threadId, entry);
      this.#enforceInactiveLimits();
    }
    return entry.store;
  }

  retain(threadId: string): ThreadClientStore {
    return this.#retain(threadId, true);
  }

  /** Retains the projection for a mounted consumer without owning an SSE. */
  retainCached(threadId: string): ThreadClientStore {
    return this.#retain(threadId, false);
  }

  #retain(threadId: string, stream: boolean): ThreadClientStore {
    const store = this.get(threadId);
    const entry = this.#stores.get(threadId)!;
    if (entry.disposalTimer !== undefined) {
      window.clearTimeout(entry.disposalTimer);
      entry.disposalTimer = undefined;
    }
    entry.references += 1;
    if (stream) entry.streamReferences += 1;
    if (stream && entry.streamReferences === 1) {
      void entry.store.start(currentThreadLoadAttempt(threadId));
    }
    return store;
  }

  prepareForReconnect(): void {
    for (const entry of this.#stores.values()) {
      if (entry.streamReferences > 0) entry.store.prepareForReconnect();
    }
  }

  release(threadId: string): void {
    this.#release(threadId, true);
  }

  releaseCached(threadId: string): void {
    this.#release(threadId, false);
  }

  #release(threadId: string, stream: boolean): void {
    const entry = this.#stores.get(threadId);
    if (!entry || entry.references === 0) return;
    if (stream && entry.streamReferences === 0) return;
    entry.references -= 1;
    if (entry.references === 0) {
      entry.inactiveOrder = ++this.#inactiveOrder;
      entry.inactiveAtMilliseconds = Date.now();
      this.#armExpiration(threadId, entry);
      if (threadLoadDiagnosticsEnabled()) {
        recordThreadLoadCategoryDiagnostic("thread_store_cached", {
          bytes: entry.store.snapshotSerializedBytes,
          itemCount: itemCount(entry.store),
        });
      }
    }
    if (stream) {
      entry.streamReferences -= 1;
      if (entry.streamReferences === 0) entry.store.pause("inactive");
    }
    if (entry.references !== 0) return;
    // pause() notifies store subscribers. An over-budget callback may have
    // evicted this entry synchronously, so never continue against stale state.
    if (this.#stores.get(threadId) !== entry) return;
    this.#enforceInactiveLimits();
  }

  dispose(): void {
    this.#unsubscribeActivityDetail();
    this.#unsubscribeActivityDetail = () => undefined;
    for (const [threadId, entry] of this.#stores) {
      this.#disposeEntry(threadId, entry, "registry_dispose");
    }
    this.#stores.clear();
  }

  #armExpiration(threadId: string, entry: StoreEntry): void {
    if (entry.disposalTimer !== undefined) {
      window.clearTimeout(entry.disposalTimer);
    }
    entry.disposalTimer = window.setTimeout(() => {
      if (entry.references !== 0 || this.#stores.get(threadId) !== entry)
        return;
      this.#disposeEntry(threadId, entry, "idle_timeout");
      this.#stores.delete(threadId);
    }, INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS);
  }

  #enforceInactiveLimits(): void {
    const inactive = [...this.#stores.entries()]
      .filter(([, entry]) => entry.references === 0)
      .sort((left, right) => left[1].inactiveOrder - right[1].inactiveOrder);
    let bytes = inactive.reduce(
      (total, [, entry]) => total + entry.store.snapshotSerializedBytes,
      0,
    );
    while (
      inactive.length > MAXIMUM_INACTIVE_THREAD_STORES ||
      bytes > this.#maximumInactiveThreadStoreBytes
    ) {
      const oldest = inactive.shift();
      if (!oldest) break;
      const [threadId, entry] = oldest;
      const reason =
        inactive.length + 1 > MAXIMUM_INACTIVE_THREAD_STORES
          ? "entry_limit"
          : "byte_limit";
      bytes -= entry.store.snapshotSerializedBytes;
      this.#disposeEntry(threadId, entry, reason);
      this.#stores.delete(threadId);
    }
  }

  #disposeEntry(
    threadId: string,
    entry: StoreEntry,
    reason: ThreadStoreEvictionReason,
  ): void {
    if (this.#stores.get(threadId) !== entry) return;
    if (entry.disposalTimer !== undefined) {
      window.clearTimeout(entry.disposalTimer);
      entry.disposalTimer = undefined;
    }
    if (threadLoadDiagnosticsEnabled()) {
      recordThreadLoadCategoryDiagnostic("thread_store_evicted", {
        reason,
        bytes: entry.store.snapshotSerializedBytes,
        itemCount: itemCount(entry.store),
        durationMilliseconds:
          entry.references === 0
            ? Math.max(0, Date.now() - entry.inactiveAtMilliseconds)
            : 0,
      });
    }
    entry.unsubscribe();
    entry.store.dispose();
  }
}

function itemCount(store: ThreadClientStore): number {
  const items = store.getSnapshot().snapshot?.itemsById;
  return items ? Object.keys(items).length : 0;
}

function threadLoadDiagnosticsEnabled(): boolean {
  try {
    return getDiagnosticCategoryEnabled("thread_load");
  } catch {
    return false;
  }
}
