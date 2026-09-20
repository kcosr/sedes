import { randomBytes } from "node:crypto";
import { serializedUtf8Bytes } from "../../../shared/protocol/payload.js";
import {
  BackendError,
  type DiscoveredConversation,
  type DiscoveredConversationPage,
} from "../contracts.js";

export interface GrokDiscoverySnapshotBinding {
  readonly tenantId: string;
  readonly principalId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly canonicalWorkspacePath: string;
  readonly nativeNamespaceKey: string;
}

interface Snapshot {
  readonly binding: GrokDiscoverySnapshotBinding;
  readonly conversations: readonly DiscoveredConversation[];
  readonly pageSize: number;
  expectedOffset: number;
  expiresAt: number;
}

export class GrokDiscoverySnapshotStore {
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #now: () => number;
  readonly #createId: () => string;
  #closed = false;

  constructor(input?: {
    readonly now?: () => number;
    readonly createId?: () => string;
  }) {
    this.#now = input?.now ?? Date.now;
    this.#createId =
      input?.createId ?? (() => randomBytes(24).toString("base64url"));
  }

  createFirstPage(input: {
    readonly binding: GrokDiscoverySnapshotBinding;
    readonly conversations: readonly DiscoveredConversation[];
    readonly pageSize: number;
  }): DiscoveredConversationPage {
    this.#assertOpen();
    if (
      input.conversations.length > 1_000 ||
      serializedUtf8Bytes(input.conversations) > 8 * 1_024 * 1_024
    ) {
      throw error(
        "rejected",
        "The Grok discovery result exceeds its bounded snapshot limit.",
        "grok_discovery_snapshot_limit_exceeded",
      );
    }
    const conversations = Object.freeze(
      input.conversations.map((conversation) =>
        Object.freeze({ ...conversation }),
      ),
    );
    const page = conversations.slice(0, input.pageSize);
    if (page.length === conversations.length) return { conversations: page };
    const now = this.#now();
    this.#expire(now);
    if (this.#snapshots.size >= 8) {
      throw error(
        "overloaded",
        "Grok discovery has too many active scans.",
        "grok_discovery_snapshot_capacity_exceeded",
        true,
      );
    }
    const scanId = this.#uniqueId();
    const expectedOffset = page.length;
    this.#snapshots.set(scanId, {
      binding: Object.freeze({ ...input.binding }),
      conversations,
      pageSize: input.pageSize,
      expectedOffset,
      expiresAt: now + 5 * 60_000,
    });
    return {
      conversations: page,
      nextCursor: cursor(scanId, expectedOffset),
    };
  }

  continuePage(input: {
    readonly binding: GrokDiscoverySnapshotBinding;
    readonly cursor: string;
    readonly pageSize: number;
  }): DiscoveredConversationPage {
    this.#assertOpen();
    const now = this.#now();
    this.#expire(now);
    const parsed = parseCursor(input.cursor);
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
    snapshot.expiresAt = now + 5 * 60_000;
    return {
      conversations,
      nextCursor: cursor(parsed.scanId, nextOffset),
    };
  }

  close(): void {
    this.#closed = true;
    this.#snapshots.clear();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw error(
        "unavailable",
        "Grok discovery is shutting down.",
        "grok_discovery_snapshot_store_closed",
        true,
      );
    }
  }

  #expire(now: number): void {
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.expiresAt <= now) this.#snapshots.delete(id);
    }
  }

  #uniqueId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.#createId();
      if (!/^[A-Za-z0-9_-]{32}$/u.test(id)) {
        throw new Error("grok_discovery_snapshot_identity_invalid");
      }
      if (!this.#snapshots.has(id)) return id;
    }
    throw error(
      "unavailable",
      "Grok discovery could not allocate a scan identity.",
      "grok_discovery_snapshot_identity_unavailable",
      true,
    );
  }
}

function sameBinding(
  left: GrokDiscoverySnapshotBinding,
  right: GrokDiscoverySnapshotBinding,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId &&
    left.backendInstanceId === right.backendInstanceId &&
    left.connectionProfileId === right.connectionProfileId &&
    left.executionEnvironmentId === right.executionEnvironmentId &&
    left.canonicalWorkspacePath === right.canonicalWorkspacePath &&
    left.nativeNamespaceKey === right.nativeNamespaceKey
  );
}

function cursor(scanId: string, offset: number): string {
  return `grok-discovery:v1:${scanId}:${offset}`;
}

function parseCursor(
  value: string,
): { readonly scanId: string; readonly offset: number } | undefined {
  if (Buffer.byteLength(value) > 80) return undefined;
  const match = /^grok-discovery:v1:([A-Za-z0-9_-]{32}):([1-9]\d*)$/u.exec(
    value,
  );
  const offset = match ? Number(match[2]) : Number.NaN;
  return match && Number.isSafeInteger(offset)
    ? { scanId: match[1]!, offset }
    : undefined;
}

function invalidCursor(): BackendError {
  return error(
    "rejected",
    "The Grok discovery cursor is invalid or stale.",
    "grok_discovery_cursor_invalid",
  );
}

function error(
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
