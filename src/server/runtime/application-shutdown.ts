import type { Server, ServerResponse } from "node:http";

const DEFAULT_HTTP_GRACE_MILLISECONDS = 250;
const DEFAULT_HTTP_CLOSE_MILLISECONDS = 5_000;

/** Process-local admission gate. It carries no backend or transport detail. */
export class ApplicationDrainController {
  #draining = false;

  get isDraining(): boolean {
    return this.#draining;
  }

  beginDrain(): void {
    this.#draining = true;
  }
}

/**
 * Owns detached application work whose continuations use runtime and database
 * resources. Closing the gate rejects new admission, cancels admitted work,
 * and waits for its continuations to settle before the resource stack disposes
 * their dependencies.
 */
export class DetachedOperationDrainGate {
  readonly #operations = new Set<Promise<void>>();
  readonly #controller = new AbortController();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  get size(): number {
    return this.#operations.size;
  }

  /** Returns undefined when shutdown has stopped admission. */
  admit(
    operation: (signal: AbortSignal) => void | Promise<void>,
  ): Promise<void> | undefined {
    if (this.#closing) return undefined;
    const completion = Promise.resolve().then(() =>
      operation(this.#controller.signal),
    );
    this.#operations.add(completion);
    void completion.then(
      () => this.#operations.delete(completion),
      () => this.#operations.delete(completion),
    );
    return completion;
  }

  close(): Promise<void> {
    this.#closing = true;
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new Error("detached_operation_cancelled"));
    }
    this.#closePromise ??= this.#drain();
    return this.#closePromise;
  }

  async #drain(): Promise<void> {
    await Promise.allSettled([...this.#operations]);
  }
}

/**
 * Owns ordinary HTTP handler promises independently of their client sockets.
 * Destroying a socket ends transport ownership, but it does not cancel an
 * async handler that may still be committing durable application state.
 */
export class HttpRequestOperationGate {
  readonly #operations = new Set<Promise<unknown>>();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#closing) {
      return Promise.reject(new Error("http_request_operation_gate_closed"));
    }
    const completion = Promise.resolve().then(operation);
    this.#operations.add(completion);
    void completion.then(
      () => this.#operations.delete(completion),
      () => this.#operations.delete(completion),
    );
    return completion;
  }

  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#drain();
    return this.#closePromise;
  }

  async #drain(): Promise<void> {
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
  }
}

/** Owns only Sedes HTTP responses and their client sockets. */
export class LongLivedHttpConnectionRegistry {
  readonly #responses = new Set<ServerResponse>();
  readonly #ownedConnections = new Map<object, () => void>();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  track(response: ServerResponse): () => void {
    if (this.#closing) {
      response.end();
      return () => undefined;
    }
    this.#responses.add(response);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#responses.delete(response);
    };
    response.once("close", release);
    return release;
  }

  get size(): number {
    return this.#responses.size + this.#ownedConnections.size;
  }

  /** Future upgraded carriers register only their Sedes-owned client close. */
  trackOwnedConnection(
    identity: object,
    closeOwnedClient: () => void,
  ): () => void {
    if (this.#closing) {
      closeOwnedClient();
      return () => undefined;
    }
    if (this.#ownedConnections.has(identity)) {
      throw new Error("http_owned_connection_already_registered");
    }
    this.#ownedConnections.set(identity, closeOwnedClient);
    return () => this.#ownedConnections.delete(identity);
  }

  closeAll(graceMilliseconds = DEFAULT_HTTP_GRACE_MILLISECONDS): Promise<void> {
    this.#closePromise ??= this.#performClose(graceMilliseconds);
    return this.#closePromise;
  }

  async #performClose(graceMilliseconds: number): Promise<void> {
    assertPositiveDeadline(graceMilliseconds, "http_connection_grace_invalid");
    this.#closing = true;
    for (const closeOwnedClient of this.#ownedConnections.values()) {
      closeOwnedClient();
    }
    this.#ownedConnections.clear();
    for (const response of this.#responses) response.end();
    if (this.#responses.size === 0) return;
    await delay(graceMilliseconds);
    for (const response of this.#responses) {
      response.socket?.destroy();
    }
    this.#responses.clear();
  }
}

/**
 * Stops admission, ends registered SSE responses, then destroys only Sedes-
 * owned client sockets if the bounded graceful close cannot finish.
 */
export async function closeHttpServerBounded(
  server: Server | undefined,
  connections: LongLivedHttpConnectionRegistry,
  input: {
    readonly graceMilliseconds?: number;
    readonly closeMilliseconds?: number;
  } = {},
): Promise<void> {
  if (!server?.listening) {
    await connections.closeAll(
      input.graceMilliseconds ?? DEFAULT_HTTP_GRACE_MILLISECONDS,
    );
    return;
  }
  const closeMilliseconds =
    input.closeMilliseconds ?? DEFAULT_HTTP_CLOSE_MILLISECONDS;
  assertPositiveDeadline(closeMilliseconds, "http_server_close_limit_invalid");
  let callbackError: Error | undefined;
  let callbackSettled = false;
  const closed = new Promise<void>((resolve) => {
    server.close((error) => {
      callbackSettled = true;
      callbackError = error ?? undefined;
      resolve();
    });
  });
  await connections.closeAll(
    input.graceMilliseconds ?? DEFAULT_HTTP_GRACE_MILLISECONDS,
  );
  await Promise.race([closed, delay(closeMilliseconds)]);
  if (!callbackSettled) {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await Promise.race([closed, delay(closeMilliseconds)]);
  }
  if (!callbackSettled) throw new Error("http_server_close_deadline_exceeded");
  if (callbackError) throw callbackError;
}

function assertPositiveDeadline(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
