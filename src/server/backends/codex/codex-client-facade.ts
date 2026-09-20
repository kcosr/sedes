import { RetainedRuntimeLifecycle } from "../retained-runtime-lifecycle.js";
import type { CodexThreadResumeResponse } from "./codex-c1-protocol.js";
import type {
  CodexRpcMethod,
  CodexRpcNotification,
  CodexRpcRequestOptions,
  CodexRpcRequestReceipt,
} from "./rpc/codex-rpc-client.js";
import { CodexRpcDeliveryError } from "./rpc/errors.js";

export interface CodexPersistentSessionAccess {
  reattachThread(threadId: string, options: CodexRpcRequestOptions): Promise<CodexRpcRequestReceipt<CodexThreadResumeResponse> | undefined>;
  detachThread(threadId: string, generation: number, evicted?: boolean): Promise<void>;
}

export interface CodexReadyClientGeneration {
  readonly generation: number;
  request<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    options: CodexRpcRequestOptions,
  ): Promise<Result>;
  requestWithReceipt<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    options: CodexRpcRequestOptions,
  ): Promise<CodexRpcRequestReceipt<Result>>;
}

export type CodexNotificationListener = (
  notification: CodexRpcNotification,
) => void;

export type CodexClientLifecycleState =
  | "idle"
  | "unavailable"
  | "starting"
  | "reconciling"
  | "ready"
  | "circuit_open"
  | "closing"
  | "closed";

export interface CodexClientLifecycleSnapshot {
  readonly state: CodexClientLifecycleState;
  readonly generation: number;
  readonly unavailableReason?: "runtime_configuration_unavailable";
}

export type CodexLifecycleListener = (
  snapshot: CodexClientLifecycleSnapshot,
) => void;

/**
 * Stable, profile-shared client identity over replaceable daemon generations.
 *
 * A request binds to exactly one ready generation and is never replayed.
 * Transport/RPC delivery classifications pass through unchanged. A decoded
 * response remains authoritative even if the generation closes before this
 * façade's continuation runs.
 */
export class CodexSharedClientFacade {
  readonly persistentSessions: CodexPersistentSessionAccess | undefined;
  readonly residency: RetainedRuntimeLifecycle | undefined;
  readonly #current: () => CodexReadyClientGeneration | undefined;
  readonly #latestGeneration: () => number;
  readonly #retireGeneration: (
    generation: number,
    reason: string,
  ) => Promise<void>;
  readonly #listeners = new Set<CodexNotificationListener>();
  readonly #lifecycleListeners = new Set<CodexLifecycleListener>();
  readonly #onListenerError: (error: unknown) => void;
  #lifecycle: CodexClientLifecycleSnapshot = Object.freeze({
    state: "unavailable",
    generation: 0,
  });

  constructor(input: {
    readonly residency?: RetainedRuntimeLifecycle;
    readonly persistentSessions?: CodexPersistentSessionAccess;
    readonly current: () => CodexReadyClientGeneration | undefined;
    readonly latestGeneration: () => number;
    readonly retireGeneration: (
      generation: number,
      reason: string,
    ) => Promise<void>;
    readonly onListenerError?: (error: unknown) => void;
  }) {
    this.persistentSessions = input.persistentSessions;
    this.residency = input.residency;
    this.#current = input.current;
    this.#latestGeneration = input.latestGeneration;
    this.#retireGeneration = input.retireGeneration;
    this.#onListenerError = input.onListenerError ?? (() => undefined);
  }

  async request<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    options: CodexRpcRequestOptions,
  ): Promise<Result> {
    return this.residency
      ? this.residency.run(() => this.#request(specification, params, options))
      : this.#request(specification, params, options);
  }

  async #request<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    options: CodexRpcRequestOptions,
  ): Promise<Result> {
    const current = this.#current();
    if (!current) {
      throw new CodexRpcDeliveryError({
        code: "codex_daemon_not_ready",
        delivery: "not_sent",
        generation: Math.max(1, this.#latestGeneration()),
        method: specification.method,
      });
    }
    // TEMPORARY DIAGNOSTIC (SEDES_DEBUG_DELIVERY): per-RPC timings.
    const rpcStart = Date.now();
    try {
      const result = await current.request(specification, params, options);
      if (process.env.SEDES_DEBUG_DELIVERY) {
        console.error(
          `[delivery-rpc] method=${specification.method} ms=${Date.now() - rpcStart} ok=1`,
        );
      }
      return result;
    } catch (error) {
      if (process.env.SEDES_DEBUG_DELIVERY) {
        console.error(
          `[delivery-rpc] method=${specification.method} ms=${Date.now() - rpcStart} ok=0 error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  async requestWithReceipt<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    options: CodexRpcRequestOptions,
  ): Promise<CodexRpcRequestReceipt<Result>> {
    return this.residency
      ? this.residency.run(() => this.#requestWithReceipt(specification, params, options))
      : this.#requestWithReceipt(specification, params, options);
  }

  async #requestWithReceipt<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    options: CodexRpcRequestOptions,
  ): Promise<CodexRpcRequestReceipt<Result>> {
    const current = this.#current();
    if (!current) {
      throw new CodexRpcDeliveryError({
        code: "codex_daemon_not_ready",
        delivery: "not_sent",
        generation: Math.max(1, this.#latestGeneration()),
        method: specification.method,
      });
    }
    // TEMPORARY DIAGNOSTIC (SEDES_DEBUG_DELIVERY): per-RPC timings.
    const rpcStart = Date.now();
    try {
      const result = await current.requestWithReceipt(
        specification,
        params,
        options,
      );
      if (process.env.SEDES_DEBUG_DELIVERY) {
        console.error(
          `[delivery-rpc] method=${specification.method} ms=${Date.now() - rpcStart} ok=1`,
        );
      }
      return result;
    } catch (error) {
      if (process.env.SEDES_DEBUG_DELIVERY) {
        console.error(
          `[delivery-rpc] method=${specification.method} ms=${Date.now() - rpcStart} ok=0 error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  subscribeNotifications(listener: CodexNotificationListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  subscribeLifecycle(listener: CodexLifecycleListener): () => void {
    this.#lifecycleListeners.add(listener);
    this.#invokeListener(
      listener,
      this.#lifecycle,
      "codex_lifecycle_listener_must_be_synchronous",
    );
    return () => {
      this.#lifecycleListeners.delete(listener);
    };
  }

  lifecycleSnapshot(): CodexClientLifecycleSnapshot {
    return this.#lifecycle;
  }

  async retireGeneration(generation: number, reason: string): Promise<void> {
    if (
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      reason.length === 0 ||
      reason.length > 128 ||
      /[^a-z0-9_]/u.test(reason)
    ) {
      throw new Error("codex_generation_retirement_invalid");
    }
    await this.#retireGeneration(generation, reason);
  }

  updateLifecycle(snapshot: CodexClientLifecycleSnapshot): void {
    if (
      !Number.isSafeInteger(snapshot.generation) ||
      snapshot.generation < 0 ||
      (snapshot.unavailableReason !== undefined &&
        (snapshot.state !== "unavailable" ||
          snapshot.unavailableReason !== "runtime_configuration_unavailable"))
    ) {
      throw new Error("codex_client_lifecycle_generation_invalid");
    }
    if (
      this.#lifecycle.state === snapshot.state &&
      this.#lifecycle.generation === snapshot.generation &&
      this.#lifecycle.unavailableReason === snapshot.unavailableReason
    ) {
      return;
    }
    this.#lifecycle = Object.freeze({ ...snapshot });
    // TEMPORARY DIAGNOSTIC (SEDES_DEBUG_DELIVERY): lifecycle transitions.
    if (process.env.SEDES_DEBUG_DELIVERY) {
      console.error(
        `[delivery-lifecycle] state=${snapshot.state} generation=${snapshot.generation} reason=${snapshot.unavailableReason ?? "-"}`,
      );
    }
    for (const listener of [...this.#lifecycleListeners]) {
      this.#invokeListener(
        listener,
        this.#lifecycle,
        "codex_lifecycle_listener_must_be_synchronous",
      );
    }
  }

  forwardNotification(
    generation: number,
    notification: CodexRpcNotification,
  ): void {
    const current = this.#current();
    if (
      !current ||
      current.generation !== generation ||
      notification.generation !== generation
    ) {
      return;
    }
    for (const listener of [...this.#listeners]) {
      this.#invokeListener(
        listener,
        notification,
        "codex_notification_listener_must_be_synchronous",
      );
    }
  }

  #invokeListener<T>(
    listener: (value: T) => void,
    value: T,
    asynchronousCode: string,
  ): void {
    try {
      const outcome = listener(value) as unknown;
      if (isPromiseLike(outcome)) {
        this.#reportListenerError(new Error(asynchronousCode));
        void Promise.resolve(outcome).catch((error) =>
          this.#reportListenerError(error),
        );
      }
    } catch (error) {
      this.#reportListenerError(error);
    }
  }

  #reportListenerError(error: unknown): void {
    try {
      const outcome = this.#onListenerError(error) as unknown;
      if (isPromiseLike(outcome)) {
        void Promise.resolve(outcome).catch(() => undefined);
      }
    } catch {
      // Diagnostics observers must never affect notification delivery.
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null && "then" in value) ||
    (typeof value === "function" && "then" in value)
  );
}
