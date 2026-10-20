import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

export type WebSocketUpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

const REJECTED_UPGRADE_DESTROY_DELAY_MILLISECONDS = 250;
const REJECTION_STATUS_TEXT = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
} as const;

/**
 * The server's only `'upgrade'` listener, routing by exact request path.
 *
 * Once any upgrade listener exists, Node hands every `Upgrade:` request to the
 * listeners instead of Express, without header or request timeouts, after
 * removing its own socket error listener. Dispatching here guarantees each
 * upgrade socket has an error listener before any carrier awaits admission and
 * that requests for unrouted paths are answered and closed.
 */
export class WebSocketUpgradeRouter {
  readonly #routes = new Map<string, WebSocketUpgradeHandler>();

  constructor(server: Server) {
    server.on("upgrade", this.#dispatch);
  }

  /** Claims one exact path; the returned function releases the claim. */
  route(path: string, handler: WebSocketUpgradeHandler): () => void {
    if (this.#routes.has(path)) {
      throw new Error("websocket_upgrade_route_conflict");
    }
    this.#routes.set(path, handler);
    return () => {
      if (this.#routes.get(path) === handler) this.#routes.delete(path);
    };
  }

  readonly #dispatch = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    // A peer reset while a carrier awaits admission or writes its rejection
    // would otherwise emit an unlistened 'error' and terminate the process.
    socket.on("error", () => socket.destroy());
    const handler =
      request.url === undefined ? undefined : this.#routes.get(request.url);
    if (!handler) {
      rejectWebSocketUpgrade(socket, 404);
      return;
    }
    handler(request, socket, head);
  };
}

/**
 * Answers a refused upgrade and destroys the socket shortly afterwards, so a
 * peer that never closes its half cannot hold the descriptor open.
 */
export function rejectWebSocketUpgrade(
  socket: Duplex,
  status: keyof typeof REJECTION_STATUS_TEXT,
): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${REJECTION_STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  const timer = setTimeout(
    () => socket.destroy(),
    REJECTED_UPGRADE_DESTROY_DELAY_MILLISECONDS,
  );
  timer.unref();
}
