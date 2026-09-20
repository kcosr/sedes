import type { RequestScope } from "../../identity/identity-provider.js";
import type { CodexGoalStateV1 } from "./codex-goal-feature.js";

export type CodexGoalProjectionAvailability =
  | "available"
  | "unavailable";

export interface CodexGoalProjectionRecord {
  readonly applicationThreadId: string;
  readonly nativeThreadId: string;
  readonly revision: number;
  readonly availability: CodexGoalProjectionAvailability;
  readonly unavailableReason?: string;
  readonly state: CodexGoalStateV1;
  readonly connectionGeneration: number;
  readonly updatedAt: number;
}

function scopeKey(
  scope: RequestScope,
  applicationThreadId: string,
): string {
  return `${scope.tenantId}\0${scope.principalId}\0${applicationThreadId}`;
}

/**
 * Application-owned Goal projection for Codex threads. Authoritative native
 * state is always re-read through thread/goal/get; this store only holds the
 * latest validated browser projection and monotonic feature revision.
 */
export class CodexGoalProjectionStore {
  readonly #records = new Map<string, CodexGoalProjectionRecord>();

  get(
    scope: RequestScope,
    applicationThreadId: string,
  ): CodexGoalProjectionRecord | undefined {
    return this.#records.get(scopeKey(scope, applicationThreadId));
  }

  publish(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly nativeThreadId: string;
      readonly state: CodexGoalStateV1;
      readonly connectionGeneration: number;
      readonly now: number;
    },
  ): CodexGoalProjectionRecord {
    const key = scopeKey(scope, input.applicationThreadId);
    const existing = this.#records.get(key);
    const sameProjection =
      existing &&
      existing.nativeThreadId === input.nativeThreadId &&
      existing.connectionGeneration === input.connectionGeneration &&
      existing.availability === "available" &&
      JSON.stringify(existing.state) === JSON.stringify(input.state);
    const revision = !existing
      ? 1
      : sameProjection
        ? existing.revision
        : existing.revision + 1;
    const record: CodexGoalProjectionRecord = {
      applicationThreadId: input.applicationThreadId,
      nativeThreadId: input.nativeThreadId,
      revision,
      availability: "available",
      state: input.state,
      connectionGeneration: input.connectionGeneration,
      updatedAt: input.now,
    };
    this.#records.set(key, record);
    return record;
  }

  withdraw(
    scope: RequestScope,
    input: {
      readonly applicationThreadId: string;
      readonly nativeThreadId?: string;
      readonly connectionGeneration: number;
      readonly reason: string;
      readonly now: number;
    },
  ): CodexGoalProjectionRecord {
    const key = scopeKey(scope, input.applicationThreadId);
    const existing = this.#records.get(key);
    const record: CodexGoalProjectionRecord = {
      applicationThreadId: input.applicationThreadId,
      nativeThreadId:
        input.nativeThreadId ?? existing?.nativeThreadId ?? "unknown",
      revision: (existing?.revision ?? 0) + 1,
      availability: "unavailable",
      unavailableReason: input.reason,
      state: { state: "unset" },
      connectionGeneration: input.connectionGeneration,
      updatedAt: input.now,
    };
    this.#records.set(key, record);
    return record;
  }

  clear(scope: RequestScope, applicationThreadId: string): void {
    this.#records.delete(scopeKey(scope, applicationThreadId));
  }
}
