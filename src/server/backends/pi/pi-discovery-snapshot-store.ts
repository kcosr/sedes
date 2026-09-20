import { randomBytes } from "node:crypto";
import { serializedUtf8Bytes } from "../../../shared/protocol/payload.js";
import {
  BackendError,
  type DiscoveredConversation,
  type DiscoveredConversationPage,
} from "../contracts.js";

export const PI_DISCOVERY_SNAPSHOT_DEFAULTS = Object.freeze({
  expiryMilliseconds: 5 * 60 * 1_000,
  maximumConcurrentSnapshots: 8,
  maximumConversations: 10_000,
  maximumProjectedBytes: 32 * 1_024 * 1_024,
});

export interface PiDiscoverySnapshotBinding {
  readonly tenantId: string;
  readonly principalId: string;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
  readonly canonicalWorkspacePath: string;
  readonly nativeNamespaceKey: string;
}

export interface PiDiscoverySnapshotStoreOptions {
  readonly expiryMilliseconds?: number;
  readonly maximumConcurrentSnapshots?: number;
  readonly maximumConversations?: number;
  readonly maximumProjectedBytes?: number;
  readonly nowMilliseconds?: () => number;
  readonly createScanId?: () => string;
}

interface PiDiscoverySnapshot {
  readonly binding: PiDiscoverySnapshotBinding;
  readonly conversations: readonly DiscoveredConversation[];
  readonly pageSize: number;
  expectedOffset: number;
  expiresAt: number;
}

const cursorPrefix = "pi-discovery:v1:";
const cursorPattern = /^pi-discovery:v1:([A-Za-z0-9_-]{32}):([1-9]\d*)$/;
const maximumCursorCharacters = 80;

function discoveryError(
  category: "overloaded" | "rejected" | "unavailable",
  safeMessage: string,
  backendCode: string,
  retryable = false,
): BackendError {
  return new BackendError({
    category,
    retryable,
    crossedSubmissionBoundary: false,
    safeMessage,
    backendCode,
  });
}

function invalidCursor(): BackendError {
  return discoveryError(
    "rejected",
    "The Pi discovery cursor is invalid or stale.",
    "pi_discovery_cursor_invalid",
  );
}

function sameBinding(
  left: PiDiscoverySnapshotBinding,
  right: PiDiscoverySnapshotBinding,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId &&
    left.backendInstanceId === right.backendInstanceId &&
    left.executionEnvironmentId === right.executionEnvironmentId &&
    left.canonicalWorkspacePath === right.canonicalWorkspacePath &&
    left.nativeNamespaceKey === right.nativeNamespaceKey
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`pi_discovery_snapshot_${name}_invalid`);
  }
  return value;
}

function freezeConversation(
  conversation: DiscoveredConversation,
): DiscoveredConversation {
  return Object.freeze({
    ...conversation,
    ...(conversation.nativeAncestry
      ? { nativeAncestry: Object.freeze({ ...conversation.nativeAncestry }) }
      : {}),
  });
}

/** Runtime-owned, provider-private stable pagination for one Pi native store. */
export class PiDiscoverySnapshotStore {
  readonly #expiryMilliseconds: number;
  readonly #maximumConcurrentSnapshots: number;
  readonly #maximumConversations: number;
  readonly #maximumProjectedBytes: number;
  readonly #nowMilliseconds: () => number;
  readonly #createScanId: () => string;
  readonly #snapshots = new Map<string, PiDiscoverySnapshot>();
  #closed = false;

  constructor(options: PiDiscoverySnapshotStoreOptions = {}) {
    this.#expiryMilliseconds = positiveInteger(
      options.expiryMilliseconds ??
        PI_DISCOVERY_SNAPSHOT_DEFAULTS.expiryMilliseconds,
      "expiry",
    );
    this.#maximumConcurrentSnapshots = positiveInteger(
      options.maximumConcurrentSnapshots ??
        PI_DISCOVERY_SNAPSHOT_DEFAULTS.maximumConcurrentSnapshots,
      "concurrency_limit",
    );
    this.#maximumConversations = positiveInteger(
      options.maximumConversations ??
        PI_DISCOVERY_SNAPSHOT_DEFAULTS.maximumConversations,
      "conversation_limit",
    );
    this.#maximumProjectedBytes = positiveInteger(
      options.maximumProjectedBytes ??
        PI_DISCOVERY_SNAPSHOT_DEFAULTS.maximumProjectedBytes,
      "byte_limit",
    );
    this.#nowMilliseconds = options.nowMilliseconds ?? Date.now;
    this.#createScanId =
      options.createScanId ?? (() => randomBytes(24).toString("base64url"));
  }

  assertConversationCount(count: number): void {
    this.#assertOpen();
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("pi_discovery_snapshot_conversation_count_invalid");
    }
    if (count > this.#maximumConversations) {
      throw discoveryError(
        "rejected",
        "The Pi discovery result exceeds the conversation limit.",
        "pi_discovery_snapshot_conversation_limit_exceeded",
      );
    }
  }

  createFirstPage(input: {
    readonly binding: PiDiscoverySnapshotBinding;
    readonly conversations: readonly DiscoveredConversation[];
    readonly pageSize: number;
  }): DiscoveredConversationPage {
    this.#assertOpen();
    this.assertConversationCount(input.conversations.length);
    if (
      serializedUtf8Bytes(input.conversations) > this.#maximumProjectedBytes
    ) {
      throw discoveryError(
        "rejected",
        "The Pi discovery result exceeds the projected byte limit.",
        "pi_discovery_snapshot_byte_limit_exceeded",
      );
    }
    const conversations = Object.freeze(
      input.conversations.map(freezeConversation),
    );
    const firstPage = conversations.slice(0, input.pageSize);
    if (firstPage.length === conversations.length) {
      return { conversations: firstPage };
    }

    const now = this.#nowMilliseconds();
    this.#removeExpired(now);
    if (this.#snapshots.size >= this.#maximumConcurrentSnapshots) {
      throw discoveryError(
        "overloaded",
        "Pi discovery has too many active scans.",
        "pi_discovery_snapshot_capacity_exceeded",
        true,
      );
    }
    const scanId = this.#uniqueScanId();
    const expectedOffset = firstPage.length;
    this.#snapshots.set(scanId, {
      binding: Object.freeze({ ...input.binding }),
      conversations,
      pageSize: input.pageSize,
      expectedOffset,
      expiresAt: now + this.#expiryMilliseconds,
    });
    return {
      conversations: firstPage,
      nextCursor: this.#cursor(scanId, expectedOffset),
    };
  }

  continuePage(input: {
    readonly binding: PiDiscoverySnapshotBinding;
    readonly cursor: string;
    readonly pageSize: number;
  }): DiscoveredConversationPage {
    this.#assertOpen();
    const now = this.#nowMilliseconds();
    this.#removeExpired(now);
    const parsed = this.#parseCursor(input.cursor);
    const snapshot = parsed ? this.#snapshots.get(parsed.scanId) : undefined;
    if (
      !parsed ||
      !snapshot ||
      !sameBinding(snapshot.binding, input.binding) ||
      snapshot.pageSize !== input.pageSize ||
      snapshot.expectedOffset !== parsed.offset
    ) {
      throw invalidCursor();
    }

    const conversations = snapshot.conversations.slice(
      parsed.offset,
      parsed.offset + snapshot.pageSize,
    );
    const nextOffset = parsed.offset + conversations.length;
    if (nextOffset >= snapshot.conversations.length) {
      this.#snapshots.delete(parsed.scanId);
      return { conversations };
    }

    snapshot.expectedOffset = nextOffset;
    snapshot.expiresAt = now + this.#expiryMilliseconds;
    return {
      conversations,
      nextCursor: this.#cursor(parsed.scanId, nextOffset),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#snapshots.clear();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw discoveryError(
        "unavailable",
        "Pi discovery is shutting down.",
        "pi_discovery_snapshot_store_closed",
        true,
      );
    }
  }

  #removeExpired(now: number): void {
    for (const [scanId, snapshot] of this.#snapshots) {
      if (snapshot.expiresAt <= now) this.#snapshots.delete(scanId);
    }
  }

  #uniqueScanId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const scanId = this.#createScanId();
      if (!/^[A-Za-z0-9_-]{32}$/.test(scanId)) {
        throw new Error("pi_discovery_snapshot_scan_id_invalid");
      }
      if (!this.#snapshots.has(scanId)) return scanId;
    }
    throw discoveryError(
      "unavailable",
      "Pi discovery could not allocate a scan identity.",
      "pi_discovery_snapshot_identity_unavailable",
      true,
    );
  }

  #parseCursor(
    cursor: string,
  ): { readonly scanId: string; readonly offset: number } | undefined {
    if (cursor.length > maximumCursorCharacters) return undefined;
    const match = cursorPattern.exec(cursor);
    const offset = match ? Number(match[2]) : Number.NaN;
    return match && Number.isSafeInteger(offset)
      ? { scanId: match[1]!, offset }
      : undefined;
  }

  #cursor(scanId: string, offset: number): string {
    return `${cursorPrefix}${scanId}:${offset}`;
  }
}
