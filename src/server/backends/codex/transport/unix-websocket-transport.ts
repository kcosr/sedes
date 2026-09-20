import type { IncomingMessage } from "node:http";
import {
  sameEnvironmentChannelScope,
  type EnvironmentPrivateUnixStreamChannel,
  type ExecutionEnvironmentChannelProvider,
} from "../../../execution/environment-channel.js";
import {
  FramedTransportOpenError,
  createPrivateUnixSocketAssurance,
  externalTransport,
  type FramedMessageTransport,
  type FramedTransportFactory,
  type ProviderTransportScope,
  sameProviderTransportScope,
} from "../../../provider-protocol/transport/assured-framed-transport.js";
import {
  WebSocketFramedConnection,
  resolveWebSocketFramedLimits,
  type WebSocketFramedLimits,
  type WebSocketHandshakePolicy,
} from "../../../provider-protocol/transport/websocket-framed-connection.js";

export type UnixWebSocketLimits = WebSocketFramedLimits;

const NON_AUTHORITATIVE_WEBSOCKET_URL = "ws://codex.invalid/";

export class UnixWebSocketTransportFactory implements FramedTransportFactory {
  readonly #scope: ProviderTransportScope;
  readonly #channels: ExecutionEnvironmentChannelProvider;
  readonly #socketPath: string;
  readonly #limits: WebSocketFramedLimits;

  constructor(input: {
    readonly scope: ProviderTransportScope;
    readonly channels: ExecutionEnvironmentChannelProvider;
    readonly socketPath: string;
    readonly limits?: Partial<UnixWebSocketLimits>;
  }) {
    this.#scope = Object.freeze({ ...input.scope });
    this.#channels = input.channels;
    this.#socketPath = input.socketPath;
    try {
      this.#limits = resolveWebSocketFramedLimits(
        input.limits,
        "codex_websocket",
      );
    } catch {
      throw new Error("codex_unix_websocket_limits_invalid");
    }
  }

  async open(
    expectedScope: ProviderTransportScope,
    connectionGeneration: number,
    signal: AbortSignal,
  ): Promise<FramedMessageTransport> {
    if (!sameProviderTransportScope(this.#scope, expectedScope)) {
      throw new FramedTransportOpenError(
        "codex_unix_websocket_scope_mismatch",
        true,
      );
    }
    if (
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration <= 0
    ) {
      throw new FramedTransportOpenError(
        "codex_unix_websocket_generation_invalid",
        true,
      );
    }
    if (signal.aborted) throw signal.reason;

    let channel: EnvironmentPrivateUnixStreamChannel;
    try {
      channel = await this.#channels.openPrivateUnixStream(
        expectedScope,
        this.#socketPath,
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw classifyEnvironmentOpenFailure(error);
    }
    if (!sameEnvironmentChannelScope(channel.identity.scope, expectedScope)) {
      channel.destroyClient("codex_unix_websocket_scope_mismatch");
      throw new FramedTransportOpenError(
        "codex_unix_websocket_scope_mismatch",
        true,
      );
    }

    try {
      const connection = new WebSocketFramedConnection({
        channel,
        limits: this.#limits,
        policy: unixHandshakePolicy,
      });
      await connection.waitUntilOpen(signal);
      await channel.revalidateIdentity(signal);
      if (signal.aborted) throw signal.reason;
      return externalTransport(
        createPrivateUnixSocketAssurance(
          expectedScope,
          connectionGeneration,
          channel.identity,
          "codex",
        ),
        connection,
        "codex",
      );
    } catch (error) {
      channel.destroyClient("codex_unix_websocket_open_failed");
      if (signal.aborted) throw signal.reason;
      if (error instanceof FramedTransportOpenError) throw error;
      if (isEnvironmentReplacementRace(error)) {
        throw new FramedTransportOpenError(
          "codex_unix_websocket_unavailable",
          false,
        );
      }
      if (isEnvironmentIdentityFailure(error)) {
        throw new FramedTransportOpenError(
          "codex_unix_websocket_identity_invalid",
          true,
        );
      }
      throw new FramedTransportOpenError(
        "codex_unix_websocket_upgrade_failed",
        true,
      );
    }
  }
}

const unixHandshakePolicy: WebSocketHandshakePolicy = Object.freeze({
  errorCodePrefix: "codex_unix_websocket",
  requestUrl: NON_AUTHORITATIVE_WEBSOCKET_URL,
  bridgeDestroyReason: "codex_websocket_bridge_destroyed",
  classifyHandshakeError(error: Error & { readonly code?: string }): Error {
    const transient = transientHandshakeError(error);
    return new FramedTransportOpenError(
      transient
        ? "codex_unix_websocket_unavailable"
        : "codex_unix_websocket_upgrade_invalid",
      !transient,
    );
  },
  classifyUnexpectedResponse(_response: IncomingMessage): Error {
    return new FramedTransportOpenError(
      "codex_unix_websocket_upgrade_rejected",
      true,
    );
  },
});

function transientConnectCode(code: string | undefined): boolean {
  return new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOENT",
    "ETIMEDOUT",
    "EPIPE",
  ]).has(code ?? "");
}

function transientHandshakeError(
  error: Error & { readonly code?: string },
): boolean {
  return (
    hasTransientConnectCause(error) ||
    error.message === "Opening handshake has timed out"
  );
}

function hasTransientConnectCause(
  error: unknown,
  visited = new Set<unknown>(),
): boolean {
  if (visited.has(error)) return false;
  visited.add(error);
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly cause?: unknown;
  };
  if (
    typeof candidate.code === "string" &&
    transientConnectCode(candidate.code)
  ) {
    return true;
  }
  return hasTransientConnectCause(candidate.cause, visited);
}

function isEnvironmentReplacementRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "environment_private_unix_stream_identity_replaced" ||
      error.message === "environment_private_unix_stream_closed")
  );
}

function isEnvironmentIdentityFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message !== "environment_private_unix_stream_identity_unavailable" &&
    (error.message.includes("identity") ||
      error.message.includes("scope_mismatch") ||
      error.message.includes("path_invalid") ||
      error.message.includes("path_unsafe") ||
      error.message.includes("owner_invalid") ||
      error.message.includes("mode_invalid") ||
      error.message.includes("type_invalid"))
  );
}

function classifyEnvironmentOpenFailure(error: unknown): Error {
  if (isEnvironmentReplacementRace(error)) {
    return new FramedTransportOpenError(
      "codex_unix_websocket_unavailable",
      false,
    );
  }
  if (isEnvironmentIdentityFailure(error)) {
    return new FramedTransportOpenError(
      "codex_unix_websocket_identity_invalid",
      true,
    );
  }
  return new FramedTransportOpenError(
    "codex_unix_websocket_unavailable",
    false,
  );
}
