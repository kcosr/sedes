import type { RequestScope } from "../../identity/identity-provider.js";
import {
  availableCodexGoalActionIds,
  codexGoalPostconditionMatches,
  desiredPostconditionForCodexGoalAction,
  parseCodexGoalCreateObjective,
  type CodexGoalActionId,
  type CodexGoalDesiredPostcondition,
  type CodexGoalStateV1,
} from "./codex-goal-feature.js";
import {
  codexThreadGoalClearMethod,
  codexThreadGoalGetMethod,
  codexThreadGoalSetMethod,
  encodeCodexGoalSetParams,
  projectCodexGoalGetResponse,
  projectCodexNativeGoal,
} from "./codex-goal-protocol.js";
import {
  CodexGoalProjectionStore,
  type CodexGoalProjectionRecord,
} from "./codex-goal-projection-store.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import {
  CodexRpcDeliveryError,
  CodexRpcProtocolError,
  CodexRpcRemoteError,
} from "./rpc/errors.js";

const REQUEST_TIMEOUT_MILLISECONDS = 10_000;

export type CodexGoalNativeOutcome =
  | {
      readonly kind: "accepted";
      readonly state: CodexGoalStateV1;
    }
  | {
      readonly kind: "uncertain";
      readonly observed?: CodexGoalStateV1;
      readonly reason: string;
    }
  | {
      readonly kind: "rejected";
      readonly preBoundary: true;
      readonly reason: string;
    };

/**
 * Generation-aware Goal projection + invalidation for one Codex backend
 * instance. Authoritative state always comes from thread/goal/get; store
 * records are browser-safe projections with monotonic feature revisions.
 */
export class CodexGoalSessionRegistry {
  readonly store: CodexGoalProjectionStore;
  readonly #pendingInvalidations = new Map<string, Promise<void>>();
  /** Keys dirtied by a notification while a reread for that key is in flight. */
  readonly #dirtiedInvalidations = new Set<string>();
  readonly #now: () => number;

  constructor(input?: {
    readonly store?: CodexGoalProjectionStore;
    readonly now?: () => number;
  }) {
    this.store = input?.store ?? new CodexGoalProjectionStore();
    this.#now = input?.now ?? (() => Date.now());
  }

  projection(
    scope: RequestScope,
    applicationThreadId: string,
  ): CodexGoalProjectionRecord | undefined {
    return this.store.get(scope, applicationThreadId);
  }

  /**
   * Authoritative reread for attach/reconnect/daemon generation replacement.
   * Fail-closed withdraws the feature on malformed native payloads.
   */
  async refresh(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly nativeThreadId: string;
    readonly connectionGeneration: number;
    readonly client: CodexSharedClientFacade;
    readonly signal?: AbortSignal;
  }): Promise<CodexGoalProjectionRecord> {
    try {
      const response = await input.client.request(
        codexThreadGoalGetMethod,
        { threadId: input.nativeThreadId },
        {
          timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      const state = projectCodexGoalGetResponse({
        response,
        expectedThreadId: input.nativeThreadId,
      });
      return this.store.publish(input.scope, {
        applicationThreadId: input.applicationThreadId,
        nativeThreadId: input.nativeThreadId,
        state,
        connectionGeneration: input.connectionGeneration,
        now: this.#now(),
      });
    } catch (error) {
      return this.store.withdraw(input.scope, {
        applicationThreadId: input.applicationThreadId,
        nativeThreadId: input.nativeThreadId,
        connectionGeneration: input.connectionGeneration,
        reason: withdrawReason(error),
        now: this.#now(),
      });
    }
  }

  /**
   * Treat goal notifications as invalidation hints only. Coalesce concurrent
   * hints and ignore generations that no longer own the projection.
   */
  scheduleInvalidation(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly nativeThreadId: string;
    readonly connectionGeneration: number;
    readonly client: CodexSharedClientFacade;
    readonly onSettled?: (
      record: CodexGoalProjectionRecord,
    ) => void | Promise<void>;
  }): void {
    const key = invalidationKey(
      input.scope,
      input.applicationThreadId,
      input.connectionGeneration,
    );
    const existing = this.#pendingInvalidations.get(key);
    if (existing) {
      // Leading+trailing coalesce: a notification during an in-flight reread
      // dirties the key so one more authoritative get runs after settlement.
      this.#dirtiedInvalidations.add(key);
      return;
    }
    let work!: Promise<void>;
    work = (async () => {
      try {
        for (;;) {
          this.#dirtiedInvalidations.delete(key);
          const current = this.store.get(
            input.scope,
            input.applicationThreadId,
          );
          if (
            current &&
            current.connectionGeneration !== input.connectionGeneration
          ) {
            return;
          }
          const record = await this.refresh({
            scope: input.scope,
            applicationThreadId: input.applicationThreadId,
            nativeThreadId: input.nativeThreadId,
            connectionGeneration: input.connectionGeneration,
            client: input.client,
          });
          // Drop results that raced a newer generation publish.
          const latest = this.store.get(
            input.scope,
            input.applicationThreadId,
          );
          if (
            latest &&
            latest.connectionGeneration !== input.connectionGeneration
          ) {
            return;
          }
          await input.onSettled?.(record);
          if (!this.#dirtiedInvalidations.has(key)) {
            return;
          }
        }
      } finally {
        if (this.#pendingInvalidations.get(key) === work) {
          this.#pendingInvalidations.delete(key);
        }
        this.#dirtiedInvalidations.delete(key);
      }
    })();
    this.#pendingInvalidations.set(key, work);
    void work.catch(() => undefined);
  }

  publishObserved(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly nativeThreadId: string;
    readonly connectionGeneration: number;
    readonly state: CodexGoalStateV1;
  }): CodexGoalProjectionRecord {
    return this.store.publish(input.scope, {
      applicationThreadId: input.applicationThreadId,
      nativeThreadId: input.nativeThreadId,
      state: input.state,
      connectionGeneration: input.connectionGeneration,
      now: this.#now(),
    });
  }

  withdraw(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly nativeThreadId?: string;
    readonly connectionGeneration: number;
    readonly reason: string;
  }): CodexGoalProjectionRecord {
    return this.store.withdraw(input.scope, {
      applicationThreadId: input.applicationThreadId,
      ...(input.nativeThreadId
        ? { nativeThreadId: input.nativeThreadId }
        : {}),
      connectionGeneration: input.connectionGeneration,
      reason: input.reason,
      now: this.#now(),
    });
  }

  clear(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    this.store.clear(scope, applicationThreadId);
  }

  /**
   * Native create/pause/resume/clear mapping. Callers prepare receipts before
   * invoking this and recover via postcondition after a lost boundary.
   */
  async mutateNative(input: {
    readonly client: CodexSharedClientFacade;
    readonly nativeThreadId: string;
    readonly actionId: CodexGoalActionId;
    readonly desired: CodexGoalDesiredPostcondition;
    readonly arguments: unknown;
    readonly currentState: CodexGoalStateV1;
  }): Promise<CodexGoalNativeOutcome> {
    const available = availableCodexGoalActionIds(input.currentState);
    if (!available.includes(input.actionId)) {
      return {
        kind: "rejected",
        preBoundary: true,
        reason: "The requested Goal action is not available.",
      };
    }
    try {
      desiredPostconditionForCodexGoalAction({
        actionId: input.actionId,
        arguments: input.arguments,
        currentState: input.currentState,
      });
    } catch {
      return {
        kind: "rejected",
        preBoundary: true,
        reason: "The Goal action arguments are invalid.",
      };
    }

    try {
      if (input.actionId === "clear") {
        const response = await input.client.request(
          codexThreadGoalClearMethod,
          { threadId: input.nativeThreadId },
          { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
        );
        if (response.cleared !== true) {
          return await this.#recoverAfterBoundary({
            client: input.client,
            nativeThreadId: input.nativeThreadId,
            desired: input.desired,
            reason: "goal_clear_not_confirmed",
          });
        }
        return { kind: "accepted", state: { state: "unset" } };
      }

      const params = encodeNativeSetParams(
        input.nativeThreadId,
        input.actionId,
        input.desired,
        input.arguments,
      );
      const response = await input.client.request(
        codexThreadGoalSetMethod,
        params,
        { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
      );
      const state = projectCodexNativeGoal({
        nativeGoal: response.goal,
        expectedThreadId: input.nativeThreadId,
      });
      if (
        !codexGoalPostconditionMatches({
          desired: input.desired,
          observed: state,
        })
      ) {
        return {
          kind: "uncertain",
          observed: state,
          reason: "goal_response_postcondition_mismatch",
        };
      }
      return { kind: "accepted", state };
    } catch (error) {
      if (isPreBoundaryFailure(error)) {
        return {
          kind: "rejected",
          preBoundary: true,
          reason: withdrawReason(error),
        };
      }
      return await this.#recoverAfterBoundary({
        client: input.client,
        nativeThreadId: input.nativeThreadId,
        desired: input.desired,
        reason: withdrawReason(error),
      });
    }
  }

  async #recoverAfterBoundary(input: {
    readonly client: CodexSharedClientFacade;
    readonly nativeThreadId: string;
    readonly desired: CodexGoalDesiredPostcondition;
    readonly reason: string;
  }): Promise<CodexGoalNativeOutcome> {
    try {
      const response = await input.client.request(
        codexThreadGoalGetMethod,
        { threadId: input.nativeThreadId },
        { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
      );
      const observed = projectCodexGoalGetResponse({
        response,
        expectedThreadId: input.nativeThreadId,
      });
      if (
        codexGoalPostconditionMatches({
          desired: input.desired,
          observed,
        })
      ) {
        return { kind: "accepted", state: observed };
      }
      return {
        kind: "uncertain",
        observed,
        reason: input.reason,
      };
    } catch {
      return {
        kind: "uncertain",
        reason: input.reason,
      };
    }
  }
}

function encodeNativeSetParams(
  threadId: string,
  actionId: Exclude<CodexGoalActionId, "clear">,
  desired: CodexGoalDesiredPostcondition,
  argumentsValue: unknown,
) {
  switch (actionId) {
    case "create": {
      if (desired.kind !== "create") {
        throw new Error("codex_goal_desired_mismatch");
      }
      // Objective text lives only on the action arguments / native request —
      // never in the durable receipt postcondition (8 KiB JSON cap).
      return encodeCodexGoalSetParams({
        threadId,
        objective: parseCodexGoalCreateObjective(argumentsValue),
        status: "active",
      });
    }
    case "pause":
      return encodeCodexGoalSetParams({
        threadId,
        status: "paused",
      });
    case "resume":
      return encodeCodexGoalSetParams({
        threadId,
        status: "active",
      });
  }
}

function invalidationKey(
  scope: RequestScope,
  applicationThreadId: string,
  connectionGeneration: number,
): string {
  return `${scope.tenantId}\0${scope.principalId}\0${applicationThreadId}\0${connectionGeneration}`;
}

function withdrawReason(error: unknown): string {
  if (error instanceof CodexRpcRemoteError) {
    return error.message || "The Codex Goal request was rejected.";
  }
  if (error instanceof CodexRpcProtocolError) {
    return "The Codex Goal response was malformed.";
  }
  if (error instanceof CodexRpcDeliveryError) {
    return "The Codex Goal request could not be delivered.";
  }
  if (error instanceof Error && error.message) {
    return error.message.startsWith("codex_goal_")
      ? "The Codex Goal payload could not be projected."
      : error.message;
  }
  return "The Codex Goal state is temporarily unavailable.";
}

function isPreBoundaryFailure(error: unknown): boolean {
  if (error instanceof CodexRpcRemoteError) {
    // Only the explicit rejected-not-accepted disposition is proven pre-boundary.
    return error.disposition === "rejected_not_accepted";
  }
  if (error instanceof CodexRpcProtocolError) {
    // Decode failures after a request was sent are treated as post-boundary.
    return false;
  }
  if (error instanceof CodexRpcDeliveryError) {
    return error.delivery === "not_sent";
  }
  return false;
}
