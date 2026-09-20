import { RetainedRuntimeLifecycle } from "../retained-runtime-lifecycle.js";
import path from "node:path";
import {
  CodexRpcClient,
  type CodexInboundServerRequest,
  type CodexRpcClosure,
  type CodexRpcMethod,
  type CodexRpcNotification,
  type CodexRpcRequestOptions,
  type CodexRpcRequestReceipt,
  type CodexServerRequestHandlers,
} from "./rpc/codex-rpc-client.js";
import {
  CodexAppServerBindingError,
  defineCodexAppServerMethod,
  type OfficialCodexClientRequestParams,
} from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import {
  CODEX_SERVER_REQUEST_METHODS,
  type CodexServerRequestMethod,
} from "./rpc/protocol.js";
import { CodexServerRequestRouter } from "./codex-server-request-router.js";
import {
  isValidFramedTransportAssurance,
  sameProviderTransportScope,
  FramedTransportOpenError,
  type ProviderTransportScope,
  type FramedMessageTransport,
  type FramedTransportFactory,
} from "../../provider-protocol/transport/assured-framed-transport.js";
import {
  CodexSharedClientFacade,
  type CodexClientLifecycleState,
  type CodexReadyClientGeneration,
} from "./codex-client-facade.js";
import {
  CodexRpcDeliveryError,
  CodexRpcProtocolError,
  CodexRpcRemoteError,
} from "./rpc/errors.js";
import {
  haveSameCodexRuntimeVersionPrecedence,
  verifyCodexRuntimeVersion,
  type VerifiedCodexRuntimeVersion,
} from "./codex-release-guard.js";
import {
  codexCleanupUncertainty,
  findCodexCleanupUncertainty,
  type CodexCleanupUncertainty,
  type CodexNativeStoreOwnershipGate,
} from "./codex-native-store-ownership.js";
import { SEDES_VERSION } from "../../../shared/version.js";

const CLIENT_NAME = "sedes_web";
const CLIENT_TITLE = "Sedes";
const CLIENT_VERSION = SEDES_VERSION;
const MAXIMUM_BUFFERED_NOTIFICATIONS = 256;
const MAXIMUM_BUFFERED_NOTIFICATION_BYTES = 4 * 1024 * 1024;
const BUFFERED_NOTIFICATION_ACCOUNTING_OVERHEAD_BYTES = 64;
const MAXIMUM_INITIALIZE_USER_AGENT_BYTES = 4 * 1024;
const MAXIMUM_INITIALIZE_HOME_BYTES = 16 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS = 7_000;
const DEFAULT_RESTART_DELAYS_MILLISECONDS = Object.freeze([
  100, 200, 400, 800, 1_600, 3_200, 5_000,
]);
const DEFAULT_RESTART_JITTER_RATIO = 0.2;
type InitializeParams = OfficialCodexClientRequestParams<"initialize">;

export interface CodexInitializeResult {
  readonly userAgent: string;
  readonly codexHome: string;
  readonly platformFamily: "unix" | "windows";
  readonly platformOs: "linux" | "macos" | "windows";
}

export type CodexDaemonSupervisorState =
  | "idle"
  | "new"
  | "starting"
  | "ready"
  | "backoff"
  | "restarting"
  | "circuit_open"
  | "failed"
  | "closing"
  | "closed";

export interface CodexDaemonSupervisorSnapshot {
  readonly state: CodexDaemonSupervisorState;
  readonly generation: number;
  /** Consecutive replacement attempts since the last stable window. */
  readonly restartAttempts: number;
  readonly cleanupUncertainty?: CodexCleanupUncertainty;
  readonly lastFailure?: string;
}

export interface CodexSupervisorClock {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface CodexSupervisorRpcClient {
  readonly generation: number;
  readonly closed: Promise<CodexRpcClosure>;
  start(): void;
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
  notify(
    method: "initialized",
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  subscribeNotifications(
    listener: (notification: CodexRpcNotification) => void,
  ): () => void;
  close(reason?: string): Promise<void>;
}

export type CodexSupervisorRpcFactory = (input: {
  readonly transport: FramedMessageTransport;
  readonly expectedScope: ProviderTransportScope;
  readonly generation: number;
  readonly handlers: CodexServerRequestHandlers;
}) => CodexSupervisorRpcClient;

type ActiveGeneration = CodexReadyClientGeneration & {
  readonly rpc: CodexSupervisorRpcClient;
  unsubscribeNotifications: () => void;
  phase: "initializing" | "ready";
  readonly bufferedNotifications: CodexRpcNotification[];
  bufferedNotificationBytes: number;
  invalidatedError?: CodexSupervisorFailure;
  invalidationPromise?: Promise<void>;
};

class CodexSupervisorFailure extends Error {
  readonly code: string;
  readonly permanent: boolean;

  constructor(code: string, permanent: boolean, options?: ErrorOptions) {
    super(code, options);
    this.name = "CodexSupervisorFailure";
    this.code = code;
    this.permanent = permanent;
  }
}

const initializeMethod = defineCodexAppServerMethod({
  method: "initialize",
  refineParams: refineInitializeParams,
  refineResult: decodeInitializeResult,
});

export class CodexDaemonSupervisor {
  readonly client: CodexSharedClientFacade;
  readonly serverRequests: CodexServerRequestRouter;
  readonly #scope: ProviderTransportScope;
  readonly #expectedCodexHome: string | undefined;
  readonly #transportFactory: FramedTransportFactory;
  readonly #rpcFactory: CodexSupervisorRpcFactory;
  readonly #clock: CodexSupervisorClock;
  readonly #restartDelays: readonly number[];
  readonly #restartDelayCapMilliseconds: number;
  readonly #restartJitterRatio: number;
  readonly #random: () => number;
  readonly #maximumRestartAttempts: number | "unbounded";
  readonly #initializationTimeoutMilliseconds: number;
  readonly #stabilityResetMilliseconds: number;
  readonly #shutdownTimeoutMilliseconds: number;
  readonly #nativeStoreOwnership: CodexNativeStoreOwnershipGate | undefined;
  #lifecycleController = new AbortController();
  #parking: Promise<void> | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #onRuntimeVersionAssessment: (
    assessment: VerifiedCodexRuntimeVersion,
  ) => void;
  readonly #expectedRuntimeVersion: (() => string | undefined) | undefined;
  #state: CodexDaemonSupervisorState = "new";
  #generation = 0;
  #restartAttempts = 0;
  #active: ActiveGeneration | undefined;
  #lastFailure: string | undefined;
  #cleanupUncertainty: CodexCleanupUncertainty | undefined;
  #startPromise: Promise<void> | undefined;
  #restartPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #stabilityController: AbortController | undefined;

  constructor(input: {
    readonly scope: ProviderTransportScope;
    readonly expectedCodexHome?: string;
    readonly transportFactory: FramedTransportFactory;
    readonly rpcFactory?: CodexSupervisorRpcFactory;
    readonly clock?: CodexSupervisorClock;
    readonly restartDelaysMilliseconds?: readonly number[];
    readonly restartJitterRatio?: number;
    readonly random?: () => number;
    readonly maximumRestartAttempts?: number | "unbounded";
    readonly initializationTimeoutMilliseconds?: number;
    readonly stabilityResetMilliseconds?: number;
    readonly shutdownTimeoutMilliseconds?: number;
    readonly nativeStoreOwnership?: CodexNativeStoreOwnershipGate;
    readonly serverRequestRouter?: CodexServerRequestRouter;
    readonly onError?: (error: unknown) => void;
    readonly onRuntimeVersionAssessment?: (
      assessment: VerifiedCodexRuntimeVersion,
    ) => void;
    readonly expectedRuntimeVersion?: () => string | undefined;
  }) {
    if (
      (input.expectedCodexHome !== undefined &&
        !path.isAbsolute(input.expectedCodexHome)) ||
      !input.scope.tenantId ||
      !input.scope.principalId ||
      !input.scope.backendInstanceId ||
      !input.scope.executionEnvironmentId
    ) {
      throw new Error("codex_daemon_supervisor_configuration_invalid");
    }
    this.#scope = Object.freeze({ ...input.scope });
    this.#expectedCodexHome = input.expectedCodexHome;
    this.#transportFactory = input.transportFactory;
    this.serverRequests =
      input.serverRequestRouter ?? new CodexServerRequestRouter();
    this.#rpcFactory =
      input.rpcFactory ?? ((options) => new CodexRpcClient(options));
    this.#clock = input.clock ?? systemClock;
    this.#restartDelays = Object.freeze([
      ...(input.restartDelaysMilliseconds ??
        DEFAULT_RESTART_DELAYS_MILLISECONDS),
    ]);
    this.#restartDelayCapMilliseconds = this.#restartDelays.reduce(
      (maximum, delay) => Math.max(maximum, delay),
      0,
    );
    this.#restartJitterRatio =
      input.restartJitterRatio ??
      (input.clock ? 0 : DEFAULT_RESTART_JITTER_RATIO);
    this.#random = input.random ?? Math.random;
    this.#maximumRestartAttempts =
      input.maximumRestartAttempts ?? this.#restartDelays.length;
    this.#initializationTimeoutMilliseconds =
      input.initializationTimeoutMilliseconds ?? 30_000;
    this.#stabilityResetMilliseconds =
      input.stabilityResetMilliseconds ?? 30_000;
    this.#shutdownTimeoutMilliseconds =
      input.shutdownTimeoutMilliseconds ??
      DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS;
    this.#nativeStoreOwnership = input.nativeStoreOwnership;
    this.#onError = input.onError ?? (() => undefined);
    this.#onRuntimeVersionAssessment =
      input.onRuntimeVersionAssessment ?? (() => undefined);
    this.#expectedRuntimeVersion = input.expectedRuntimeVersion;
    if (
      this.#restartDelays.length === 0 ||
      this.#restartDelays.some(
        (delay) => !Number.isSafeInteger(delay) || delay < 0,
      ) ||
      !Number.isFinite(this.#restartJitterRatio) ||
      this.#restartJitterRatio < 0 ||
      this.#restartJitterRatio > 1 ||
      (this.#maximumRestartAttempts !== "unbounded" &&
        (!Number.isSafeInteger(this.#maximumRestartAttempts) ||
          this.#maximumRestartAttempts <= 0)) ||
      !Number.isSafeInteger(this.#initializationTimeoutMilliseconds) ||
      this.#initializationTimeoutMilliseconds <= 0 ||
      !Number.isSafeInteger(this.#stabilityResetMilliseconds) ||
      this.#stabilityResetMilliseconds <= 0 ||
      !Number.isSafeInteger(this.#shutdownTimeoutMilliseconds) ||
      this.#shutdownTimeoutMilliseconds <= 0
    ) {
      throw new Error("codex_daemon_supervisor_limits_invalid");
    }
    this.client = new CodexSharedClientFacade({
      residency: new RetainedRuntimeLifecycle({
        wake: () => this.wake(),
        retire: () => this.park(),
        onRetirementError: error => this.#reportError(error),
      }),
      current: () =>
        this.#active?.phase === "ready" ? this.#active : undefined,
      latestGeneration: () => this.#generation,
      retireGeneration: (generation, reason) =>
        this.#retireGeneration(generation, reason),
      onListenerError: this.#onError,
    });
  }

  snapshot(): CodexDaemonSupervisorSnapshot {
    return Object.freeze({
      state: this.#state,
      generation: this.#generation,
      restartAttempts: this.#restartAttempts,
      ...(this.#cleanupUncertainty
        ? { cleanupUncertainty: this.#cleanupUncertainty }
        : {}),
      ...(this.#lastFailure ? { lastFailure: this.#lastFailure } : {}),
    });
  }

  start(): Promise<void> {
    if (this.#state === "idle") {
      this.#lifecycleController = new AbortController();
      this.#startPromise = undefined;
      this.#restartAttempts = 0;
      this.#state = "new";
    }
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== "new") {
      return Promise.reject(new Error("codex_daemon_supervisor_not_startable"));
    }
    this.#transition("starting");
    this.#startPromise = this.#startInitialGeneration();
    return this.#startPromise;
  }

  wake(): void | Promise<void> {
    if (this.#parking) return this.#parking.then(() => this.wake());
    if (this.#state === "idle") return this.start();
    if (this.#state === "starting") return this.#startPromise;
  }

  park(): Promise<void> {
    if (this.#closePromise || this.#state === "idle") return Promise.resolve();
    this.#parking ??= this.#performClose(true).finally(() => { this.#parking = undefined; });
    return this.#parking;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#parking
      ? this.#parking.then(() => this.#performClose())
      : this.#performClose();
    return this.#closePromise;
  }

  async #startInitialGeneration(): Promise<void> {
    try {
      await this.#openGeneration();
    } catch (error) {
      this.#recordCleanupUncertainty(error);
      const failure = sanitizedSupervisorFailure(error);
      this.#lastFailure = failure.code;
      if (this.#state !== "closing" && this.#state !== "closed") {
        if (failure.permanent) {
          this.#transition("circuit_open");
        } else {
          this.#transition("backoff");
          this.#scheduleRestart();
        }
      }
      throw error instanceof CodexRpcDeliveryError ? error : failure;
    }
  }

  async #openGeneration(): Promise<void> {
    if (this.#lifecycleController.signal.aborted) {
      throw this.#lifecycleController.signal.reason;
    }
    const generation = ++this.#generation;
    this.#publishLifecycle();
    this.serverRequests.activateGeneration(generation);
    let transport: FramedMessageTransport | undefined;
    let active: ActiveGeneration | undefined;
    try {
      transport = await this.#transportFactory.open(
        this.#scope,
        generation,
        this.#lifecycleController.signal,
        this.#nativeStoreOwnership
          ? {
              launchStarted: () => this.#nativeStoreOwnership!.armLaunch(),
              cleanupProven: () => this.#nativeStoreOwnership!.proveClosed(),
              cleanupFailed: (error) => {
                this.#recordCleanupFailure(error);
              },
            }
          : undefined,
      );
      if (transport.assurance.ownership === "owned") {
        if (!this.#nativeStoreOwnership) {
          throw new CodexSupervisorFailure(
            "codex_owned_transport_without_native_ownership",
            true,
          );
        }
        // Fail closed if a custom owned-process factory omitted its callback.
        this.#nativeStoreOwnership.armLaunch();
      } else if (this.#nativeStoreOwnership) {
        throw new CodexSupervisorFailure(
          "codex_external_transport_claimed_native_ownership",
          true,
        );
      }
      if (
        !isValidFramedTransportAssurance(transport.assurance) ||
        !sameProviderTransportScope(transport.assurance.scope, this.#scope)
      ) {
        throw new CodexSupervisorFailure(
          "codex_daemon_transport_assurance_invalid",
          true,
        );
      }
      const rpc = this.#rpcFactory({
        transport,
        expectedScope: this.#scope,
        generation,
        handlers: this.#generationHandlers(generation),
      });
      active = {
        generation,
        rpc,
        phase: "initializing",
        request: rpc.request.bind(rpc),
        requestWithReceipt: rpc.requestWithReceipt.bind(rpc),
        unsubscribeNotifications: () => undefined,
        bufferedNotifications: [],
        bufferedNotificationBytes: 0,
      };
      this.#active = active;
      active.unsubscribeNotifications = rpc.subscribeNotifications(
        (notification) => this.#receiveNotification(active!, notification),
      );
      rpc.start();
      const initialized = await rpc.request(
        initializeMethod,
        {
          clientInfo: {
            name: CLIENT_NAME,
            title: CLIENT_TITLE,
            version: CLIENT_VERSION,
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
        {
          timeoutMilliseconds: this.#initializationTimeoutMilliseconds,
          signal: this.#lifecycleController.signal,
        },
      );
      this.#validateInitializeResult(initialized);
      this.#assertCurrentGeneration(generation);
      await rpc.notify("initialized", {
        signal: this.#lifecycleController.signal,
      });
      this.#assertCurrentGeneration(generation);
      active.phase = "ready";
      this.#transition("ready");
      const bufferedNotifications = active.bufferedNotifications.splice(0);
      active.bufferedNotificationBytes = 0;
      for (const notification of bufferedNotifications) {
        if (notification.method === "account/updated") continue;
        this.#receiveNotification(active, notification);
      }
      this.#scheduleStabilityReset(active);
      void rpc.closed.then((closure) =>
        this.#handleUnexpectedClosure(generation, closure),
      );
    } catch (error) {
      const failure = active?.invalidatedError ?? error;
      if (active?.invalidationPromise) {
        await active.invalidationPromise;
      } else if (active) {
        await this.#teardownGeneration(active, "startup_failed");
      } else if (transport) {
        try {
          await transport.close("startup_failed");
          if (transport.assurance.ownership === "owned") {
            this.#nativeStoreOwnership?.proveClosed();
          }
        } catch (cleanupError) {
          throw this.#recordCleanupFailure(cleanupError);
        }
      }
      this.serverRequests.invalidateGeneration(
        generation,
        "codex_server_request_generation_startup_failed",
      );
      this.#recordCleanupUncertainty(failure);
      throw failure;
    }
  }

  #validateInitializeResult(result: CodexInitializeResult): void {
    const expectedSuffix = ` (${CLIENT_NAME}; ${CLIENT_VERSION})`;
    const runtimeAssessment = assessInitializedRuntimeVersion(result.userAgent);
    const expectedRuntimeVersion = this.#expectedRuntimeVersion?.();
    if (
      (this.#expectedCodexHome !== undefined &&
        result.codexHome !== this.#expectedCodexHome) ||
      !isSupportedCodexPlatform(
        result.platformFamily,
        result.platformOs,
      ) ||
      !runtimeAssessment ||
      (this.#expectedRuntimeVersion !== undefined &&
        (expectedRuntimeVersion === undefined ||
          !haveSameCodexRuntimeVersionPrecedence(
            runtimeAssessment.version,
            expectedRuntimeVersion,
          ))) ||
      !result.userAgent.endsWith(expectedSuffix)
    ) {
      throw new CodexSupervisorFailure(
        "codex_daemon_initialize_identity_mismatch",
        true,
      );
    }
    try {
      this.#onRuntimeVersionAssessment(runtimeAssessment);
    } catch {
      // Advisory observers must never influence provider admission or lifecycle.
    }
  }

  async #retireGeneration(generation: number, reason: string): Promise<void> {
    const active = this.#active;
    if (!active || active.generation !== generation) return;
    if (!active.invalidatedError) {
      this.#invalidateGeneration(
        active,
        new CodexSupervisorFailure(reason, false),
      );
    }
    try {
      await active.invalidationPromise;
    } finally {
      if (this.#state === "backoff" && !this.#cleanupUncertainty) {
        this.#scheduleRestart();
      }
    }
  }

  #generationHandlers(generation: number): CodexServerRequestHandlers {
    const handlers = this.serverRequests.handlersForGeneration(generation);
    const wrapped: Partial<
      Record<
        CodexServerRequestMethod,
        (request: CodexInboundServerRequest) => Promise<unknown>
      >
    > = {};
    for (const method of CODEX_SERVER_REQUEST_METHODS) {
      const handler = handlers[method];
      if (!handler) continue;
      wrapped[method] = async (request) => {
        this.#assertCurrentGeneration(generation, request.generation);
        const result = await handler(request as never);
        this.#assertCurrentGeneration(generation, request.generation);
        return result;
      };
    }
    return wrapped as CodexServerRequestHandlers;
  }

  #receiveNotification(
    active: ActiveGeneration,
    notification: CodexRpcNotification,
  ): void {
    if (
      this.#active !== active ||
      notification.generation !== active.generation
    ) {
      return;
    }
    // Codex authentication is provider execution state, not app-server
    // transport health. Logout and account replacement leave local app-server
    // operations available, so they must not retire or revalidate a generation.
    if (notification.method === "account/updated") return;
    if (active.phase === "initializing") {
      const notificationBytes = bufferedNotificationBytes(notification);
      if (
        active.bufferedNotifications.length >= MAXIMUM_BUFFERED_NOTIFICATIONS ||
        notificationBytes > MAXIMUM_BUFFERED_NOTIFICATION_BYTES ||
        active.bufferedNotificationBytes >
          MAXIMUM_BUFFERED_NOTIFICATION_BYTES - notificationBytes
      ) {
        this.#invalidateGeneration(
          active,
          new CodexSupervisorFailure(
            "codex_daemon_notification_buffer_limit",
            true,
          ),
        );
        return;
      }
      active.bufferedNotifications.push(notification);
      active.bufferedNotificationBytes += notificationBytes;
      return;
    }
    this.client.forwardNotification(active.generation, notification);
  }

  #assertCurrentGeneration(
    expectedGeneration: number,
    callbackGeneration = expectedGeneration,
  ): void {
    if (
      callbackGeneration !== expectedGeneration ||
      this.#active?.generation !== expectedGeneration ||
      this.#state === "closing" ||
      this.#state === "closed"
    ) {
      throw new Error("codex_daemon_stale_generation");
    }
    if (this.#active.invalidatedError) {
      throw this.#active.invalidatedError;
    }
  }

  #handleUnexpectedClosure(generation: number, closure: CodexRpcClosure): void {
    if (this.#state !== "ready" || this.#active?.generation !== generation) {
      return;
    }
    if (process.env.SEDES_DEBUG_DELIVERY) {
      console.error(
        `[delivery-lifecycle] phase=connection_closed generation=${generation} closure=${diagnosticClosureCode(closure.reason)} cause=${errorCode(closure.cause)}`,
      );
    }
    const cleanupFailure = unsafeTransportCleanupFailure(closure.reason);
    this.#lastFailure = cleanupFailure?.code ?? errorCode(closure.cause);
    this.#stabilityController?.abort();
    this.#stabilityController = undefined;
    this.serverRequests.invalidateGeneration(
      generation,
      closure.reason || "codex_server_request_generation_closed",
    );
    this.#active.unsubscribeNotifications();
    this.#active = undefined;
    if (cleanupFailure) {
      const failure = this.#recordCleanupFailure(cleanupFailure);
      this.#transition(failure.permanent ? "circuit_open" : "backoff");
      this.#reportError(failure);
      if (!failure.permanent) this.#scheduleRestart();
      return;
    }
    this.#nativeStoreOwnership?.proveClosed();
    this.#transition("backoff");
    this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    if (!this.#restartPromise) {
      const restart = this.#restartLoop();
      this.#restartPromise = restart;
      const clear = () => {
        if (this.#restartPromise === restart) {
          this.#restartPromise = undefined;
          if (this.#state === "backoff") this.#scheduleRestart();
        }
      };
      void restart.then(clear, clear);
    }
  }

  async #restartLoop(): Promise<void> {
    while (!this.#lifecycleController.signal.aborted) {
      if (
        this.#maximumRestartAttempts !== "unbounded" &&
        this.#restartAttempts >= this.#maximumRestartAttempts
      ) {
        this.#transition("circuit_open");
        return;
      }
      const delay = this.#restartDelay(this.#restartAttempts);
      this.#restartAttempts = Math.min(
        this.#restartAttempts + 1,
        Number.MAX_SAFE_INTEGER,
      );
      this.#transition("backoff");
      try {
        await this.#clock.sleep(delay, this.#lifecycleController.signal);
      } catch (error) {
        if (this.#lifecycleController.signal.aborted) return;
        this.#reportError(error);
        continue;
      }
      if (this.#lifecycleController.signal.aborted) return;
      this.#transition("restarting");
      try {
        await this.#openGeneration();
        return;
      } catch (error) {
        this.#recordCleanupUncertainty(error);
        this.#lastFailure = errorCode(error);
        this.#reportError(error);
        if (isPermanentFailure(error)) {
          this.#transition("circuit_open");
          return;
        }
      }
    }
  }

  #restartDelay(attempt: number): number {
    const base =
      this.#restartDelays[Math.min(attempt, this.#restartDelays.length - 1)]!;
    if (this.#restartJitterRatio === 0 || base === 0) return base;
    const lower = Math.max(0, Math.ceil(base * (1 - this.#restartJitterRatio)));
    const upper = Math.min(
      this.#restartDelayCapMilliseconds,
      Math.floor(base * (1 + this.#restartJitterRatio)),
    );
    const sampled = this.#random();
    const normalized = Number.isFinite(sampled)
      ? Math.min(1, Math.max(0, sampled))
      : 0.5;
    return lower + Math.round(normalized * (upper - lower));
  }

  async #teardownGeneration(
    active: ActiveGeneration,
    reason: string,
    timeoutMilliseconds = this.#shutdownTimeoutMilliseconds,
  ): Promise<void> {
    this.serverRequests.invalidateGeneration(
      active.generation,
      reason || "codex_server_request_generation_closed",
    );
    active.unsubscribeNotifications();
    if (this.#active === active) this.#active = undefined;
    try {
      await beforeDeadline(
        active.rpc.close(reason),
        timeoutMilliseconds,
        "codex_rpc_close_deadline_exceeded",
      );
      this.#nativeStoreOwnership?.proveClosed();
    } catch (error) {
      this.#reportError(error);
      throw this.#recordCleanupFailure(error);
    }
  }

  async #performClose(idle = false): Promise<void> {
    if (this.#state === "closed") return;
    if (idle) this.#state = "closing";
    else this.#transition("closing");
    this.#lifecycleController.abort(
      new CodexSupervisorFailure("codex_daemon_supervisor_closed", false),
    );
    this.#stabilityController?.abort();
    this.#stabilityController = undefined;
    const deadline = Date.now() + this.#shutdownTimeoutMilliseconds;
    let cleanupFailure: unknown;
    const active = this.#active;
    if (active) {
      try {
        await this.#teardownGeneration(
          active,
          "supervisor_closed",
          remainingMilliseconds(deadline),
        );
      } catch (error) {
        cleanupFailure = error;
      }
    }
    const lifecycleSettled = await settleBeforeDeadline(
      [this.#startPromise, this.#restartPromise].filter(
        (promise): promise is Promise<void> => promise !== undefined,
      ),
      remainingMilliseconds(deadline),
    );
    if (!lifecycleSettled) {
      cleanupFailure ??= this.#recordCleanupFailure(
        new Error("codex_daemon_shutdown_deadline_exceeded"),
      );
    }
    if (this.#active && Date.now() < deadline) {
      try {
        await this.#teardownGeneration(
          this.#active,
          "supervisor_closed_after_start",
          remainingMilliseconds(deadline),
        );
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    if (!idle) this.#transition("closed");
    try {
      this.#nativeStoreOwnership?.assertReleaseSafe();
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure) {
      if (idle) this.#transition("circuit_open");
      throw cleanupFailure;
    }
    if (idle) {
      this.#startPromise = undefined;
      this.#restartPromise = undefined;
      this.#transition("idle");
    }
  }

  #scheduleStabilityReset(active: ActiveGeneration): void {
    this.#stabilityController?.abort();
    const controller = new AbortController();
    this.#stabilityController = controller;
    void this.#clock
      .sleep(this.#stabilityResetMilliseconds, controller.signal)
      .then(
        () => {
          if (
            !controller.signal.aborted &&
            this.#active === active &&
            active.phase === "ready" &&
            this.#state === "ready"
          ) {
            this.#restartAttempts = 0;
          }
        },
        (error) => {
          if (!controller.signal.aborted) this.#reportError(error);
        },
      );
  }

  #invalidateGeneration(
    active: ActiveGeneration,
    failure: CodexSupervisorFailure,
  ): void {
    if (active.invalidatedError) return;
    active.invalidatedError = failure;
    this.#lastFailure = failure.code;
    this.#transition(failure.permanent ? "circuit_open" : "backoff");
    this.#stabilityController?.abort();
    this.#stabilityController = undefined;
    this.#reportError(failure);
    const invalidation = this.#teardownGeneration(active, failure.code);
    active.invalidationPromise = invalidation;
    void invalidation.catch((error) => {
      this.#recordCleanupUncertainty(error);
      const failure = this.#recordCleanupFailure(error);
      this.#lastFailure = failure.code;
      this.#transition(failure.permanent ? "circuit_open" : "backoff");
      this.#reportError(failure);
      if (!failure.permanent) this.#scheduleRestart();
    });
  }

  #reportError(error: unknown): void {
    try {
      const outcome = this.#onError(
        sanitizedSupervisorFailure(error),
      ) as unknown;
      if (isPromiseLike(outcome)) {
        void Promise.resolve(outcome).catch(() => undefined);
      }
    } catch {
      // Diagnostics observers must never influence daemon lifecycle state.
    }
  }

  #recordCleanupUncertainty(error: unknown): void {
    if (!this.#nativeStoreOwnership) return;
    const uncertainty = findCodexCleanupUncertainty(error);
    if (!uncertainty) return;
    this.#cleanupUncertainty ??= uncertainty;
    this.#nativeStoreOwnership?.latchCleanupFailure(error);
  }

  #recordCleanupFailure(error: unknown): CodexSupervisorFailure {
    const uncertainty = findCodexCleanupUncertainty(error);
    if (uncertainty) this.#cleanupUncertainty ??= uncertainty;
    if (!this.#nativeStoreOwnership) {
      return new CodexSupervisorFailure(
        "codex_external_client_cleanup_failed",
        false,
      );
    }
    this.#nativeStoreOwnership.latchCleanupFailure(error);
    return new CodexSupervisorFailure(
      uncertainty ?? "codex_daemon_cleanup_unproven",
      true,
    );
  }

  #transition(state: CodexDaemonSupervisorState): void {
    this.#state = state;
    this.#publishLifecycle();
  }

  #publishLifecycle(): void {
    this.client.updateLifecycle({
      state: clientLifecycleState(this.#state),
      generation: this.#generation,
    });
  }
}

function assessInitializedRuntimeVersion(
  userAgent: string,
): VerifiedCodexRuntimeVersion | undefined {
  const match =
    /^(sedes_web|pi_web_harness|codex-tui|Codex Desktop)\/([^ ]+) /u.exec(
    userAgent,
  );
  if (!match?.[2]) return undefined;
  try {
    return verifyCodexRuntimeVersion(match[2]);
  } catch {
    return undefined;
  }
}

function refineInitializeParams(params: InitializeParams): InitializeParams {
  if (
    Object.keys(params).some(
      (key) => key !== "clientInfo" && key !== "capabilities",
    ) ||
    Object.keys(params.clientInfo).some(
      (key) => key !== "name" && key !== "title" && key !== "version",
    ) ||
    params.capabilities === null ||
    Object.keys(params.capabilities).some(
      (key) => key !== "experimentalApi" && key !== "requestAttestation",
    ) ||
    params.clientInfo.name !== CLIENT_NAME ||
    params.clientInfo.title !== CLIENT_TITLE ||
    params.clientInfo.version !== CLIENT_VERSION ||
    params.capabilities.experimentalApi !== true ||
    params.capabilities.requestAttestation !== false
  ) {
    throw new CodexSupervisorFailure(
      "codex_daemon_initialize_params_invalid",
      true,
    );
  }
  return {
    clientInfo: {
      name: params.clientInfo.name,
      title: params.clientInfo.title,
      version: params.clientInfo.version,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  };
}

function decodeInitializeResult(value: unknown): CodexInitializeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodexSupervisorFailure(
      "codex_daemon_initialize_response_invalid",
      true,
    );
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.userAgent !== "string" ||
    Buffer.byteLength(record.userAgent, "utf8") >
      MAXIMUM_INITIALIZE_USER_AGENT_BYTES ||
    typeof record.codexHome !== "string" ||
    record.codexHome.length === 0 ||
    !path.isAbsolute(record.codexHome) ||
    /[\u0000-\u001f\u007f]/u.test(record.codexHome) ||
    Buffer.byteLength(record.codexHome, "utf8") >
      MAXIMUM_INITIALIZE_HOME_BYTES ||
    !isSupportedCodexPlatform(record.platformFamily, record.platformOs)
  ) {
    throw new CodexSupervisorFailure(
      "codex_daemon_initialize_response_invalid",
      true,
    );
  }
  return Object.freeze({
    userAgent: record.userAgent,
    codexHome: record.codexHome,
    platformFamily: record.platformFamily as CodexInitializeResult["platformFamily"],
    platformOs: record.platformOs as CodexInitializeResult["platformOs"],
  });
}

function isSupportedCodexPlatform(
  family: unknown,
  operatingSystem: unknown,
): boolean {
  return (
    (family === "unix" &&
      (operatingSystem === "linux" || operatingSystem === "macos")) ||
    (family === "windows" && operatingSystem === "windows")
  );
}

function isPermanentFailure(error: unknown): boolean {
  if (findSupervisorFailure(error)?.permanent) return true;
  if (findInitializeBindingFailure(error)) return true;
  if (findTransportOpenFailure(error)?.permanent) return true;
  return findUnsafeTransportCleanupFailure(error) !== undefined;
}

function diagnosticClosureCode(reason: string): string {
  return /^[a-z][a-z0-9_]{0,127}$/u.test(reason) ? reason : "unclassified";
}

function errorCode(error: unknown): string {
  const supervisorFailure = findSupervisorFailure(error);
  if (supervisorFailure) return supervisorFailure.code;
  if (findInitializeBindingFailure(error)) {
    return "codex_daemon_initialize_response_invalid";
  }
  const transportOpenFailure = findTransportOpenFailure(error);
  if (transportOpenFailure) return transportOpenFailure.code;
  const cleanupFailure = findUnsafeTransportCleanupFailure(error);
  if (cleanupFailure) return cleanupFailure.code;
  if (error instanceof CodexRpcDeliveryError) {
    return `codex_daemon_rpc_delivery_${error.delivery}`;
  }
  if (error instanceof CodexRpcProtocolError) {
    return "codex_daemon_rpc_protocol_error";
  }
  if (error instanceof CodexRpcRemoteError) {
    return "codex_daemon_rpc_remote_error";
  }
  return "codex_daemon_failure";
}

function sanitizedSupervisorFailure(error: unknown): CodexSupervisorFailure {
  return new CodexSupervisorFailure(
    errorCode(error),
    isPermanentFailure(error),
  );
}

const systemClock: CodexSupervisorClock = Object.freeze({
  sleep: async (milliseconds: number, signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (outcome: "resolve" | "reject") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (outcome === "resolve") resolve();
        else reject(signal.reason);
      };
      const timer = setTimeout(() => settle("resolve"), milliseconds);
      timer.unref?.();
      const abort = () => settle("reject");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  },
});

function bufferedNotificationBytes(notification: CodexRpcNotification): number {
  try {
    const serialized = JSON.stringify(notification);
    if (serialized === undefined) {
      return MAXIMUM_BUFFERED_NOTIFICATION_BYTES + 1;
    }
    const bytes =
      Buffer.byteLength(serialized, "utf8") +
      BUFFERED_NOTIFICATION_ACCOUNTING_OVERHEAD_BYTES;
    return Number.isSafeInteger(bytes)
      ? bytes
      : MAXIMUM_BUFFERED_NOTIFICATION_BYTES + 1;
  } catch {
    return MAXIMUM_BUFFERED_NOTIFICATION_BYTES + 1;
  }
}

function findSupervisorFailure(
  error: unknown,
  visited = new Set<unknown>(),
): CodexSupervisorFailure | undefined {
  if (visited.has(error)) return undefined;
  visited.add(error);
  if (error instanceof CodexSupervisorFailure) return error;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return findSupervisorFailure(error.cause, visited);
  }
  return undefined;
}

function findInitializeBindingFailure(
  error: unknown,
  visited = new Set<unknown>(),
): CodexAppServerBindingError | undefined {
  if (visited.has(error)) return undefined;
  visited.add(error);
  if (
    error instanceof CodexAppServerBindingError &&
    error.method === "initialize" &&
    error.direction === "client_request_result"
  ) {
    return error;
  }
  if (typeof error === "object" && error !== null && "cause" in error) {
    return findInitializeBindingFailure(error.cause, visited);
  }
  return undefined;
}

function findTransportOpenFailure(
  error: unknown,
  visited = new Set<unknown>(),
): FramedTransportOpenError | undefined {
  if (visited.has(error)) return undefined;
  visited.add(error);
  if (error instanceof FramedTransportOpenError) return error;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return findTransportOpenFailure(error.cause, visited);
  }
  return undefined;
}

function unsafeTransportCleanupFailure(
  reason: string,
): CodexSupervisorFailure | undefined {
  const uncertainty = codexCleanupUncertainty(reason);
  return uncertainty
    ? new CodexSupervisorFailure(uncertainty, true)
    : undefined;
}

function findUnsafeTransportCleanupFailure(
  error: unknown,
): CodexSupervisorFailure | undefined {
  const uncertainty = findCodexCleanupUncertainty(error);
  return uncertainty
    ? new CodexSupervisorFailure(uncertainty, true)
    : undefined;
}

function clientLifecycleState(
  state: CodexDaemonSupervisorState,
): CodexClientLifecycleState {
  switch (state) {
    case "idle":
      return "idle";
    case "new":
    case "failed":
    case "backoff":
      return "unavailable";
    case "starting":
      return "starting";
    case "restarting":
      return "reconciling";
    case "ready":
      return "ready";
    case "circuit_open":
      return "circuit_open";
    case "closing":
      return "closing";
    case "closed":
      return "closed";
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null && "then" in value) ||
    (typeof value === "function" && "then" in value)
  );
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function settleBeforeDeadline(
  promises: readonly Promise<void>[],
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (promises.length === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(promises).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function beforeDeadline<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
  code: string,
): Promise<T> {
  void promise.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
