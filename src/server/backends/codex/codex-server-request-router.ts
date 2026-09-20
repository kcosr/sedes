import {
  refineCodexC2ServerRequest,
  encodeCodexC2RoutedServerResponse,
  type CodexC2RoutedServerRequestMethod,
  type CodexC2ServerRequest,
} from "./codex-c2-protocol.js";
import type {
  CodexInboundServerRequest,
  CodexServerRequestHandlers,
} from "./rpc/codex-rpc-client.js";
import {
  CODEX_SERVER_REQUEST_METHODS,
  type CodexServerRequestMethod,
} from "./rpc/protocol.js";

const ROUTED_METHODS = new Set<CodexServerRequestMethod>([
  "applyPatchApproval",
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

export interface CodexServerRequestRoute {
  readonly nativeThreadId: string;
  readonly nativeTurnId?: string;
  readonly nativeItemId?: string;
  readonly nativeCallId?: string;
  readonly nativeApprovalId?: string;
}

export type CodexRoutedServerRequest = {
  readonly [Method in CodexC2RoutedServerRequestMethod]: {
    readonly generation: number;
    readonly sequence: number;
    readonly requestId: string | number;
    readonly method: Method;
    readonly params: Extract<
      CodexC2ServerRequest,
      { readonly method: Method }
    >["params"];
    readonly route: CodexServerRequestRoute;
    readonly signal: AbortSignal;
  };
}[CodexC2RoutedServerRequestMethod];

export interface CodexServerRequestOwner {
  /**
   * Proves the complete native identity against the actor's current state.
   * The router never treats a process-global thread ID alone as authority for
   * a turn, item, or call.
   */
  owns(route: CodexServerRequestRoute): boolean;
  handle(request: CodexRoutedServerRequest): unknown | Promise<unknown>;
}

export interface CodexServerRequestOwnershipLease {
  readonly generation: number;
  readonly nativeThreadId: string;
  release(reason?: string): void;
}

type ActiveGeneration = {
  readonly generation: number;
  readonly controller: AbortController;
};

type ThreadOwner = {
  readonly generation: number;
  readonly nativeThreadId: string;
  readonly token: symbol;
  readonly controller: AbortController;
  readonly owner: CodexServerRequestOwner;
};

export class CodexServerRequestRoutingError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CodexServerRequestRoutingError";
    this.code = code;
  }
}

/**
 * Routes the daemon's process-global request stream to one current native
 * thread owner. The surrounding runtime already fixes tenant, principal, and
 * backend instance; this router adds native identity and generation fencing.
 *
 * It is deliberately above CodexRpcClient and FramedMessageTransport. A later
 * authenticated UDS or WebSocket adapter therefore cannot change routing or
 * approval semantics.
 */
export class CodexServerRequestRouter {
  readonly #owners = new Map<string, ThreadOwner>();
  #active: ActiveGeneration | undefined;
  #latestGeneration = 0;

  activateGeneration(generation: number): void {
    assertGeneration(generation);
    if (this.#active?.generation === generation) return;
    if (generation <= this.#latestGeneration) {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_generation_not_monotonic",
      );
    }
    this.#abortActive("codex_server_request_generation_replaced");
    this.#active = {
      generation,
      controller: new AbortController(),
    };
    this.#latestGeneration = generation;
  }

  invalidateGeneration(generation: number, reason: string): void {
    assertGeneration(generation);
    if (this.#active?.generation !== generation) return;
    this.#abortActive(reason || "codex_server_request_generation_invalidated");
  }

  claimThread(input: {
    readonly generation: number;
    readonly nativeThreadId: string;
    readonly owner: CodexServerRequestOwner;
  }): CodexServerRequestOwnershipLease {
    assertGeneration(input.generation);
    if (!input.nativeThreadId || input.nativeThreadId.length > 512) {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_thread_id_invalid",
      );
    }
    if (
      this.#active?.generation !== input.generation ||
      this.#active.controller.signal.aborted
    ) {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_generation_inactive",
      );
    }
    if (this.#owners.has(input.nativeThreadId)) {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_thread_already_owned",
      );
    }
    const token = Symbol(input.nativeThreadId);
    const controller = new AbortController();
    const ownership: ThreadOwner = {
      generation: input.generation,
      nativeThreadId: input.nativeThreadId,
      token,
      controller,
      owner: input.owner,
    };
    this.#owners.set(input.nativeThreadId, ownership);
    let released = false;
    return Object.freeze({
      generation: input.generation,
      nativeThreadId: input.nativeThreadId,
      release: (reason = "codex_server_request_ownership_released") => {
        if (released) return;
        released = true;
        if (this.#owners.get(input.nativeThreadId)?.token === token) {
          this.#owners.delete(input.nativeThreadId);
        }
        controller.abort(
          new CodexServerRequestRoutingError(
            reason || "codex_server_request_ownership_released",
          ),
        );
      },
    });
  }

  handlersForGeneration(generation: number): CodexServerRequestHandlers {
    assertGeneration(generation);
    return Object.freeze(
      Object.fromEntries(
        CODEX_SERVER_REQUEST_METHODS.map((method) => [
          method,
          (request: CodexInboundServerRequest) =>
            this.#route(generation, request),
        ]),
      ),
    ) as CodexServerRequestHandlers;
  }

  /** Readiness only; response dispatch repeats every ownership check. */
  canHandleRequest(request: CodexInboundServerRequest): boolean {
    if (this.#active?.generation !== request.generation) return false;
    try {
      const decoded = { method: request.method, params: refineCodexC2ServerRequest(request.method, request.params) } as CodexC2ServerRequest;
      if (decoded.method === "account/chatgptAuthTokens/refresh" || decoded.method === "attestation/generate" || decoded.method === "item/tool/call") return false;
      const route = routeFromRequest(decoded);
      const owner = this.#owners.get(route.nativeThreadId);
      return owner?.generation === request.generation && !owner.controller.signal.aborted && owner.owner.owns(route);
    } catch { return false; }
  }

  ownerCount(): number {
    return this.#owners.size;
  }

  async #route(
    handlerGeneration: number,
    request: CodexInboundServerRequest,
  ): Promise<unknown> {
    this.#assertActive(handlerGeneration, request.generation);
    const decoded = {
      method: request.method,
      params: refineCodexC2ServerRequest(request.method, request.params),
    } as CodexC2ServerRequest;
    switch (decoded.method) {
      case "account/chatgptAuthTokens/refresh":
        throw new CodexServerRequestRoutingError(
          "codex_server_request_account_refresh_unavailable",
        );
      case "attestation/generate":
        throw new CodexServerRequestRoutingError(
          "codex_server_request_attestation_unavailable",
        );
      case "item/tool/call":
        // Sedes tools require run-bound T2 grants. A process-wide daemon
        // credential is forbidden, even when a logical thread has an owner.
        return { contentItems: [], success: false };
      default:
        return await this.#routeToOwner(handlerGeneration, request, decoded);
    }
  }

  async #routeToOwner(
    generation: number,
    request: CodexInboundServerRequest,
    decoded: Extract<
      CodexC2ServerRequest,
      { readonly method: CodexC2RoutedServerRequestMethod }
    >,
  ): Promise<unknown> {
    if (!ROUTED_METHODS.has(decoded.method)) {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_method_not_routable",
      );
    }
    const route = routeFromRequest(decoded);
    const ownership = this.#owners.get(route.nativeThreadId);
    if (
      !ownership ||
      ownership.generation !== generation ||
      ownership.controller.signal.aborted
    ) {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_thread_unowned",
      );
    }
    let ownsRoute = false;
    try {
      ownsRoute = ownership.owner.owns(route);
    } catch {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_ownership_check_failed",
      );
    }
    if (!ownsRoute) {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_native_identity_unowned",
      );
    }

    const active = this.#active;
    if (!active || active.generation !== generation) {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_stale_generation",
      );
    }
    const signal = AbortSignal.any([
      request.signal,
      active.controller.signal,
      ownership.controller.signal,
    ]);
    const routed = Object.freeze({
      generation,
      sequence: request.sequence,
      requestId: request.id,
      method: decoded.method,
      params: decoded.params,
      route,
      signal,
    }) as CodexRoutedServerRequest;
    const result = await raceWithAbort(
      Promise.resolve().then(() => ownership.owner.handle(routed)),
      signal,
    );
    this.#assertActive(generation, request.generation);
    if (
      this.#owners.get(route.nativeThreadId)?.token !== ownership.token ||
      !ownership.owner.owns(route)
    ) {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_ownership_lost",
      );
    }
    return encodeCodexC2RoutedServerResponse(decoded.method, result);
  }

  #assertActive(expected: number, actual: number): void {
    if (
      actual !== expected ||
      this.#active?.generation !== expected ||
      this.#active.controller.signal.aborted
    ) {
      throw new CodexServerRequestRoutingError(
        "codex_server_request_stale_generation",
      );
    }
  }

  #abortActive(reason: string): void {
    const active = this.#active;
    this.#active = undefined;
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(
        new CodexServerRequestRoutingError(
          reason || "codex_server_request_generation_invalidated",
        ),
      );
    }
    for (const ownership of this.#owners.values()) {
      if (!ownership.controller.signal.aborted) {
        ownership.controller.abort(
          new CodexServerRequestRoutingError(
            reason || "codex_server_request_generation_invalidated",
          ),
        );
      }
    }
    this.#owners.clear();
  }
}

function routeFromRequest(
  request: Extract<
    CodexC2ServerRequest,
    { readonly method: CodexC2RoutedServerRequestMethod }
  >,
): CodexServerRequestRoute {
  switch (request.method) {
    case "applyPatchApproval":
      return Object.freeze({
        nativeThreadId: request.params.conversationId,
        nativeCallId: request.params.callId,
      });
    case "execCommandApproval":
      return Object.freeze({
        nativeThreadId: request.params.conversationId,
        nativeCallId: request.params.callId,
        ...(request.params.approvalId
          ? { nativeApprovalId: request.params.approvalId }
          : {}),
      });
    case "item/commandExecution/requestApproval":
      return Object.freeze({
        nativeThreadId: request.params.threadId,
        nativeTurnId: request.params.turnId,
        nativeItemId: request.params.itemId,
        ...(request.params.approvalId
          ? { nativeApprovalId: request.params.approvalId }
          : {}),
      });
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
    case "item/tool/requestUserInput":
      return Object.freeze({
        nativeThreadId: request.params.threadId,
        nativeTurnId: request.params.turnId,
        nativeItemId: request.params.itemId,
      });
    case "mcpServer/elicitation/request":
      return Object.freeze({
        nativeThreadId: request.params.threadId,
        ...(request.params.turnId
          ? { nativeTurnId: request.params.turnId }
          : {}),
      });
  }
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new CodexServerRequestRoutingError(
          "codex_server_request_route_aborted",
        );
  }
  let remove: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new CodexServerRequestRoutingError(
              "codex_server_request_route_aborted",
            ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    remove();
  }
}

function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new CodexServerRequestRoutingError(
      "codex_server_request_generation_invalid",
    );
  }
}
