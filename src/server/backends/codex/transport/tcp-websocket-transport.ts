import type { IncomingMessage } from "node:http";
import {
  isValidEnvironmentAssuredTcpStreamIdentity,
  sameEnvironmentChannelScope,
  type EnvironmentAssuredTcpStreamChannel,
  type EnvironmentSecretReference,
  type EnvironmentTcpRoute,
  type ExecutionEnvironmentChannelProvider,
  type ResolvedEnvironmentSecret,
} from "../../../execution/environment-channel.js";
import {
  FramedTransportOpenError,
  createAuthenticatedTcpAssurance,
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

export type TcpWebSocketLimits = WebSocketFramedLimits;

export interface CapabilityTokenResolver {
  resolve(
    scope: ProviderTransportScope,
    reference: EnvironmentSecretReference,
    connectionGeneration: number,
    signal: AbortSignal,
  ): Promise<ResolvedEnvironmentSecret>;
}

export type ParsedTcpEndpoint = Readonly<{
  route: EnvironmentTcpRoute;
  requestUrl: string;
  hostHeader: string;
}>;

export class TcpWebSocketTransportFactory implements FramedTransportFactory {
  readonly #scope: ProviderTransportScope;
  readonly #channels: ExecutionEnvironmentChannelProvider;
  readonly #secretReference: EnvironmentSecretReference;
  readonly #resolveToken: CapabilityTokenResolver;
  readonly #endpoint: ParsedTcpEndpoint;
  readonly #limits: WebSocketFramedLimits;

  constructor(input: {
    readonly scope: ProviderTransportScope;
    readonly channels: ExecutionEnvironmentChannelProvider;
    readonly url: string;
    readonly secretReference: EnvironmentSecretReference;
    readonly tokenResolver?: CapabilityTokenResolver;
    readonly limits?: Partial<TcpWebSocketLimits>;
  }) {
    this.#scope = Object.freeze({ ...input.scope });
    this.#channels = input.channels;
    this.#secretReference = Object.freeze({ ...input.secretReference });
    this.#resolveToken =
      input.tokenResolver ??
      Object.freeze({
        resolve: async (
          scope: ProviderTransportScope,
          reference: EnvironmentSecretReference,
          connectionGeneration: number,
          signal: AbortSignal,
        ) =>
          await input.channels.resolveSecret(
            scope,
            reference,
            connectionGeneration,
            signal,
          ),
      });
    this.#endpoint = parseCodexTcpEndpoint(input.url);
    try {
      this.#limits = resolveWebSocketFramedLimits(
        input.limits,
        "codex_websocket",
      );
    } catch {
      throw new Error("codex_tcp_websocket_limits_invalid");
    }
  }

  async open(
    expectedScope: ProviderTransportScope,
    connectionGeneration: number,
    signal: AbortSignal,
  ): Promise<FramedMessageTransport> {
    if (!sameProviderTransportScope(this.#scope, expectedScope)) {
      throw new FramedTransportOpenError(
        "codex_tcp_websocket_scope_mismatch",
        true,
      );
    }
    if (
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration <= 0
    ) {
      throw new FramedTransportOpenError(
        "codex_tcp_websocket_generation_invalid",
        true,
      );
    }
    if (signal.aborted) throw signal.reason;

    let secret: ResolvedEnvironmentSecret;
    try {
      secret = await this.#resolveToken.resolve(
        expectedScope,
        this.#secretReference,
        connectionGeneration,
        signal,
      );
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new FramedTransportOpenError(
        "codex_tcp_websocket_authentication_invalid",
        true,
      );
    }

    let channel: EnvironmentAssuredTcpStreamChannel;
    try {
      if (signal.aborted) throw signal.reason;
      channel = await this.#channels.openAssuredTcpStream(
        expectedScope,
        this.#endpoint.route,
        connectionGeneration,
        secret.identity,
        signal,
      );
    } catch (error) {
      secret.discard();
      if (signal.aborted) throw signal.reason;
      throw classifyEnvironmentOpenFailure(error);
    }

    if (
      !isValidEnvironmentAssuredTcpStreamIdentity(channel.identity) ||
      !sameEnvironmentChannelScope(channel.identity.scope, expectedScope) ||
      channel.identity.connectionGeneration !== connectionGeneration ||
      channel.identity.authenticationIdentity !== secret.identity
    ) {
      channel.destroyClient("codex_tcp_websocket_identity_invalid");
      secret.discard();
      throw new FramedTransportOpenError(
        "codex_tcp_websocket_identity_invalid",
        true,
      );
    }

    try {
      const connection = new WebSocketFramedConnection({
        channel,
        limits: this.#limits,
        policy: tcpHandshakePolicy(
          this.#endpoint.requestUrl,
          this.#endpoint.hostHeader,
          secret.value,
        ),
      });
      await connection.waitUntilOpen(signal);
      if (signal.aborted) throw signal.reason;
      return externalTransport(
        createAuthenticatedTcpAssurance(
          expectedScope,
          connectionGeneration,
          channel.identity,
          "codex",
        ),
        connection,
        "codex",
      );
    } catch (error) {
      channel.destroyClient("codex_tcp_websocket_open_failed");
      secret.discard();
      if (signal.aborted) throw signal.reason;
      if (error instanceof FramedTransportOpenError) throw error;
      throw new FramedTransportOpenError(
        "codex_tcp_websocket_upgrade_invalid",
        true,
      );
    }
  }
}

function tcpHandshakePolicy(
  requestUrl: string,
  hostHeader: string,
  capabilityToken: string,
): WebSocketHandshakePolicy {
  return Object.freeze({
    errorCodePrefix: "codex_tcp_websocket",
    requestUrl,
    bridgeDestroyReason: "codex_websocket_bridge_destroyed",
    headers: Object.freeze({
      Host: hostHeader,
      Authorization: `Bearer ${capabilityToken}`,
    }),
    classifyHandshakeError: classifyTcpHandshakeError,
    classifyUnexpectedResponse: classifyTcpUnexpectedResponse,
  });
}

function classifyTcpHandshakeError(
  error: Error & { readonly code?: string },
): Error {
  const retryable =
    hasRetryableConnectCause(error) ||
    error.message === "Opening handshake has timed out";
  return new FramedTransportOpenError(
    retryable
      ? "codex_tcp_websocket_unavailable"
      : "codex_tcp_websocket_upgrade_invalid",
    !retryable,
  );
}

function classifyTcpUnexpectedResponse(response: IncomingMessage): Error {
  if (response.statusCode === 401 || response.statusCode === 403) {
    return new FramedTransportOpenError(
      "codex_tcp_websocket_authentication_rejected",
      true,
    );
  }
  if (response.statusCode === 429 || response.statusCode === 503) {
    return new FramedTransportOpenError(
      "codex_tcp_websocket_overloaded",
      false,
    );
  }
  return new FramedTransportOpenError(
    "codex_tcp_websocket_upgrade_rejected",
    true,
  );
}

export function parseCodexTcpEndpoint(value: string): ParsedTcpEndpoint {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    /[^\u0021-\u007e]/u.test(value) ||
    value.includes("\\")
  ) {
    throw new Error("codex_tcp_websocket_endpoint_invalid");
  }
  const match = /^(ws|wss):\/\/(\[[^\]]+\]|[^:/?#]+):([0-9]{1,5})$/u.exec(
    value,
  );
  if (!match) throw new Error("codex_tcp_websocket_endpoint_invalid");
  const scheme = match[1]!;
  const encodedHost = match[2]!;
  const encodedPort = match[3]!;
  const port = Number(encodedPort);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("codex_tcp_websocket_endpoint_invalid");
  }
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    encodedHost.includes("%") ||
    encodedHost.endsWith(".") ||
    parsed.hostname !== encodedHost ||
    String(port) !== encodedPort
  ) {
    throw new Error("codex_tcp_websocket_endpoint_invalid");
  }
  const host = encodedHost.startsWith("[")
    ? encodedHost.slice(1, -1)
    : encodedHost;
  const route: EnvironmentTcpRoute =
    scheme === "ws"
      ? host === "127.0.0.1" || host === "::1"
        ? Object.freeze({
            security: "loopback_plaintext" as const,
            host,
            port,
          })
        : invalidPlaintextRoute()
      : Object.freeze({
          security: "tls" as const,
          host,
          port,
          trustPolicy: "platform" as const,
        });
  return Object.freeze({
    route,
    // TLS is already established and assured below this HTTP Upgrade layer.
    requestUrl: `ws://${encodedHost}:${port}/`,
    hostHeader: `${encodedHost}:${port}`,
  });
}

function invalidPlaintextRoute(): never {
  throw new Error("codex_tcp_websocket_endpoint_insecure");
}

function hasRetryableConnectCause(
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
    new Set([
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
      "EPIPE",
    ]).has(candidate.code)
  ) {
    return true;
  }
  return hasRetryableConnectCause(candidate.cause, visited);
}

function classifyEnvironmentOpenFailure(error: unknown): Error {
  const code = error instanceof Error ? error.message : "";
  if (
    code === "environment_assured_tcp_stream_unavailable" ||
    code === "environment_assured_tcp_stream_connect_timeout"
  ) {
    return new FramedTransportOpenError(
      "codex_tcp_websocket_unavailable",
      false,
    );
  }
  if (code === "environment_assured_tcp_stream_tls_identity_invalid") {
    return new FramedTransportOpenError(
      "codex_tcp_websocket_tls_identity_invalid",
      true,
    );
  }
  if (code === "environment_assured_tcp_stream_remote_environment_required") {
    return new FramedTransportOpenError(
      "codex_tcp_websocket_remote_environment_required",
      true,
    );
  }
  if (code === "environment_assured_tcp_stream_authentication_invalid") {
    return new FramedTransportOpenError(
      "codex_tcp_websocket_authentication_invalid",
      true,
    );
  }
  return new FramedTransportOpenError(
    "codex_tcp_websocket_route_invalid",
    true,
  );
}
