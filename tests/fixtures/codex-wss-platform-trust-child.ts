import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  connect as createTlsConnection,
  createServer,
  type Server,
  type TLSSocket,
} from "node:tls";
import { TcpWebSocketTransportFactory } from "../../src/server/backends/codex/transport/tcp-websocket-transport.js";
import type {
  ProviderTransportScope,
  FramedMessageTransport,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import {
  EnvironmentStreamWriteError,
  createEnvironmentAssuredTcpStreamIdentity,
  isValidEnvironmentSecretIdentity,
  revokeEnvironmentAssuredTcpStreamIdentity,
  sameEnvironmentChannelScope,
  type EnvironmentAssuredTcpStreamChannel,
  type EnvironmentAssuredTcpStreamIdentity,
  type EnvironmentPrivateUnixStreamClosure,
  type EnvironmentSecretIdentity,
  type EnvironmentTcpRoute,
  type ExecutionEnvironmentChannelProvider,
} from "../../src/server/execution/environment-channel.js";
import { RawWebSocketConnection } from "../support/raw-uds-websocket-server.js";

const TOKEN_VARIABLE = "SEDES_CODEX_WSS_TOKEN";
const CAPABILITY_TOKEN = "wss-capability-token-12345";

type Scenario =
  | "valid"
  | "remote_valid"
  | "untrusted"
  | "hostname_mismatch"
  | "expired"
  | "tls_below_floor";

const [scenarioValue, certificatePath, privateKeyPath, host] =
  process.argv.slice(2);
if (
  ![
    "valid",
    "remote_valid",
    "untrusted",
    "hostname_mismatch",
    "expired",
    "tls_below_floor",
  ].includes(scenarioValue ?? "") ||
  !certificatePath ||
  !privateKeyPath ||
  !host
) {
  throw new Error("wss_fixture_arguments_invalid");
}
const scenario = scenarioValue as Scenario;
const fixturePaths = Object.freeze({ certificatePath, privateKeyPath, host });
const remoteEvidence = scenario === "remote_valid";

const scope: ProviderTransportScope = Object.freeze({
  tenantId: "tenant-wss-evidence",
  principalId: "principal-wss-evidence",
  backendInstanceId: "codex-wss-evidence",
  executionEnvironmentId: remoteEvidence
    ? "remote-wss-test-environment"
    : "local-wss-evidence",
});

const connections: RawWebSocketConnection[] = [];
const requests: string[] = [];
const negotiatedTlsProtocols: string[] = [];
async function main(): Promise<void> {
  const server = await createTlsFixtureServer(
    fixturePaths.certificatePath,
    fixturePaths.privateKeyPath,
  );
  const localChannels = new LocalEnvironmentChannelProvider({
    scope,
    executionEnvironmentId: scope.executionEnvironmentId,
    environment: { [TOKEN_VARIABLE]: CAPABILITY_TOKEN },
  });
  const channels = remoteEvidence
    ? createRemoteWssEvidenceEnvironmentProvider(
        localChannels,
        fixturePaths.host,
      )
    : localChannels;
  let transport: FramedMessageTransport | undefined;

  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("wss_fixture_address_invalid");
    }
    const endpoint = `wss://${fixturePaths.host}:${address.port}`;
    if (scenario === "tls_below_floor") {
      await assertTlsBelowProductionFloorReachable(
        fixturePaths.host,
        address.port,
      );
    }
    const factory = new TcpWebSocketTransportFactory({
      scope,
      channels,
      url: endpoint,
      secretReference: {
        source: "environment",
        variable: TOKEN_VARIABLE,
      },
      limits: { handshakeTimeoutMilliseconds: 1_000 },
    });

    if (scenario === "valid" || scenario === "remote_valid") {
      transport = await factory.open(scope, 11, new AbortController().signal);
      const connection = connections.at(-1);
      if (!connection) throw new Error("wss_fixture_connection_missing");
      const request = await connection.requestReceived;
      if (header(request, "authorization") !== `Bearer ${CAPABILITY_TOKEN}`) {
        throw new Error("wss_fixture_authorization_missing");
      }
      if (header(request, "origin") !== undefined) {
        throw new Error("wss_fixture_origin_present");
      }
      if (request.includes("jsonrpc")) {
        throw new Error("wss_fixture_raw_jsonl_upgrade_leak");
      }
      const message = '{"jsonrpc":"2.0","id":1,"method":"thread/list"}';
      await transport.send(message);
      const frame = await connection.waitForFrame(
        ({ opcode }) => opcode === 0x1,
      );
      if (
        !frame.fin ||
        !frame.masked ||
        frame.payload.toString("utf8") !== message ||
        frame.payload.at(-1) === 0x0a
      ) {
        throw new Error("wss_fixture_text_frame_invalid");
      }
      if (
        transport.assurance.kind !== "authenticated_tcp" ||
        transport.assurance.environmentChannelIdentity.transportSecurity
          .type !== "tls" ||
        transport.assurance.environmentChannelIdentity.transportSecurity
          .chainVerified !== true ||
        transport.assurance.environmentChannelIdentity.transportSecurity
          .peerIdentityVerified !== true
      ) {
        throw new Error("wss_fixture_tls_assurance_invalid");
      }
      const negotiatedTlsProtocol = negotiatedTlsProtocols.at(-1);
      if (
        negotiatedTlsProtocol !== "TLSv1.2" &&
        negotiatedTlsProtocol !== "TLSv1.3"
      ) {
        throw new Error("wss_fixture_tls_floor_invalid");
      }
      await transport.close("wss_fixture_complete");
      if (!server.listening) throw new Error("wss_fixture_server_stopped");
      process.stdout.write(
        `${JSON.stringify({
          scenario,
          outcome: "connected",
          ...(remoteEvidence ? { remoteRouteVerified: true } : {}),
          bearerVerified: true,
          originAbsent: true,
          textFrameVerified: true,
          tlsAssured: true,
          tlsFloorVerified: true,
          serverSurvivedClientClose: true,
        })}\n`,
      );
    } else {
      let failure: unknown;
      try {
        await factory.open(scope, 11, new AbortController().signal);
      } catch (error) {
        failure = error;
      }
      if (
        !(failure instanceof Error) ||
        failure.message !== "codex_tcp_websocket_tls_identity_invalid" ||
        !("permanent" in failure) ||
        failure.permanent !== true
      ) {
        throw new Error("wss_fixture_tls_failure_classification_invalid");
      }
      const serialized = `${String(failure)}\n${JSON.stringify(failure)}`;
      for (const forbidden of [
        CAPABILITY_TOKEN,
        endpoint,
        fixturePaths.certificatePath,
        fixturePaths.privateKeyPath,
        "Authorization:",
      ]) {
        if (serialized.includes(forbidden)) {
          throw new Error("wss_fixture_failure_leaked_private_material");
        }
      }
      process.stdout.write(
        `${JSON.stringify({
          scenario,
          outcome: "rejected",
          code: failure.message,
          permanent: true,
          privateMaterialAbsent: true,
        })}\n`,
      );
    }
  } finally {
    await transport?.close("wss_fixture_finally").catch(() => undefined);
    channels.close();
    for (const connection of connections) connection.destroy();
    await closeServer(server);
  }
}

async function createTlsFixtureServer(
  certificatePath: string,
  privateKeyPath: string,
): Promise<Server> {
  const server = createServer(
    {
      cert: await readFile(certificatePath),
      key: await readFile(privateKeyPath),
      ...(scenario === "tls_below_floor"
        ? {
            minVersion: "TLSv1.1" as const,
            maxVersion: "TLSv1.1" as const,
            // The child process lowers its default cipher security only for
            // this counterfactual. That makes a TLS 1.1 connection possible
            // if the production client-side TLS 1.2 floor is removed.
            ciphers: "DEFAULT:@SECLEVEL=0",
          }
        : { minVersion: "TLSv1.2" as const }),
    },
    (socket: TLSSocket) => {
      negotiatedTlsProtocols.push(socket.getProtocol() ?? "");
      const connection = new RawWebSocketConnection({
        socket,
        handshakeMode: "accept",
        partialHandshake: true,
        onRequest: (request) => requests.push(request),
      });
      connections.push(connection);
    },
  );
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      server.removeListener("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.removeListener("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(0, "127.0.0.1");
  });
  return server;
}

async function assertTlsBelowProductionFloorReachable(
  host: string,
  port: number,
): Promise<void> {
  // This control uses the deliberately lowered child-process defaults. It
  // proves that the fixture can negotiate TLS 1.1 before the production
  // environment channel is expected to reject the same peer at its own floor.
  const socket = createTlsConnection({
    host,
    port,
    rejectUnauthorized: true,
  });
  try {
    await waitForSecureConnection(socket, new AbortController().signal);
    if (socket.authorized !== true || socket.getProtocol() !== "TLSv1.1") {
      throw new Error("wss_fixture_tls_below_floor_control_invalid");
    }
  } finally {
    socket.destroy();
  }
}

function createRemoteWssEvidenceEnvironmentProvider(
  local: LocalEnvironmentChannelProvider,
  expectedHost: string,
): ExecutionEnvironmentChannelProvider & { close(): void } {
  return Object.freeze({
    scope: local.scope,
    executionEnvironmentId: local.executionEnvironmentId,
    reportRuntimeAvailability: local.reportRuntimeAvailability.bind(local),
    resolveDirectory: local.resolveDirectory.bind(local),
    prepareOwnedProcess: local.prepareOwnedProcess.bind(local),
    openOwnedProcess: local.openOwnedProcess.bind(local),
    openPrivateUnixStream: local.openPrivateUnixStream.bind(local),
    resolveSecret: local.resolveSecret.bind(local),
    openAssuredTcpStream: async (
      channelScope: ProviderTransportScope,
      route: EnvironmentTcpRoute,
      connectionGeneration: number,
      authenticationIdentity: EnvironmentSecretIdentity,
      signal: AbortSignal,
    ) =>
      await openRemoteWssEvidenceChannel({
        scope: channelScope,
        route,
        expectedHost,
        connectionGeneration,
        authenticationIdentity,
        signal,
      }),
    close: () => local.close(),
  });
}

async function openRemoteWssEvidenceChannel(input: {
  readonly scope: ProviderTransportScope;
  readonly route: EnvironmentTcpRoute;
  readonly expectedHost: string;
  readonly connectionGeneration: number;
  readonly authenticationIdentity: EnvironmentSecretIdentity;
  readonly signal: AbortSignal;
}): Promise<EnvironmentAssuredTcpStreamChannel> {
  if (
    input.route.security !== "tls" ||
    input.route.trustPolicy !== "platform" ||
    input.route.host !== input.expectedHost ||
    input.expectedHost === "127.0.0.1" ||
    input.expectedHost === "::1" ||
    !isValidEnvironmentSecretIdentity(input.authenticationIdentity) ||
    input.authenticationIdentity.connectionGeneration !==
      input.connectionGeneration ||
    !sameEnvironmentChannelScope(
      input.scope,
      input.authenticationIdentity.scope,
    )
  ) {
    throw new Error("wss_remote_evidence_route_invalid");
  }
  if (input.signal.aborted) throw input.signal.reason;
  const socket = createTlsConnection({
    // This test-only environment owns the route namespace: the logical peer
    // remains a distinct remote-style DNS identity while its byte channel is
    // deterministically carried by a loopback fixture.
    host: "127.0.0.1",
    port: input.route.port,
    servername: input.route.host,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  });
  try {
    await waitForSecureConnection(socket, input.signal);
    if (socket.authorized !== true || socket.remoteAddress !== "127.0.0.1") {
      throw new Error("wss_remote_evidence_tls_identity_invalid");
    }
    const peer = socket.getPeerCertificate(true);
    if (!peer.raw || peer.raw.byteLength === 0) {
      throw new Error("wss_remote_evidence_tls_identity_invalid");
    }
    socket.setNoDelay(true);
    return new RemoteWssEvidenceChannel({
      socket,
      scope: input.scope,
      route: input.route,
      connectionGeneration: input.connectionGeneration,
      authenticationIdentity: input.authenticationIdentity,
      peerCertificate: peer.raw,
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

class RemoteWssEvidenceChannel implements EnvironmentAssuredTcpStreamChannel {
  readonly identity: EnvironmentAssuredTcpStreamIdentity;
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly closed: Promise<EnvironmentPrivateUnixStreamClosure>;
  readonly #socket: TLSSocket;
  readonly #resolveClosed: (
    closure: EnvironmentPrivateUnixStreamClosure,
  ) => void;
  #clientClosed = false;
  #socketFailed = false;
  #settled = false;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly socket: TLSSocket;
    readonly scope: ProviderTransportScope;
    readonly route: Extract<EnvironmentTcpRoute, { security: "tls" }>;
    readonly connectionGeneration: number;
    readonly authenticationIdentity: EnvironmentSecretIdentity;
    readonly peerCertificate: Buffer;
  }) {
    this.#socket = input.socket;
    this.bytes = input.socket;
    const routeIdentity = createHash("sha256")
      .update(input.route.host)
      .update("\0")
      .update(String(input.route.port))
      .update("\0platform\0")
      .update(input.peerCertificate)
      .digest("base64url");
    this.identity = createEnvironmentAssuredTcpStreamIdentity({
      kind: "assured_tcp_stream",
      scope: Object.freeze({ ...input.scope }),
      channelId: randomUUID(),
      connectionGeneration: input.connectionGeneration,
      authenticationIdentity: input.authenticationIdentity,
      routeIdentity,
      transportSecurity: Object.freeze({
        type: "tls" as const,
        chainVerified: true as const,
        peerIdentityVerified: true as const,
        trustPolicy: "platform" as const,
      }),
    });
    let resolveClosed!: (closure: EnvironmentPrivateUnixStreamClosure) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
    input.socket.on("error", () => {
      this.#socketFailed = true;
    });
    input.socket.once("close", () => this.#settleClosed());
  }

  async write(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (this.#socket.destroyed || !this.#socket.writable) {
      throw new EnvironmentStreamWriteError(
        "wss_remote_evidence_stream_closed",
        "not_sent",
      );
    }
    if (options?.signal?.aborted) {
      throw new EnvironmentStreamWriteError(
        "wss_remote_evidence_write_aborted",
        "not_sent",
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(Buffer.from(bytes), (error) => {
        if (error) {
          reject(
            new EnvironmentStreamWriteError(
              "wss_remote_evidence_write_failed",
              "sent_outcome_unknown",
            ),
          );
        } else {
          resolve();
        }
      });
    });
  }

  closeClient(_reason: string): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  destroyClient(_reason: string): void {
    this.#clientClosed = true;
    this.#socket.destroy();
  }

  async #performClose(): Promise<void> {
    this.#clientClosed = true;
    if (!this.#socket.destroyed) this.#socket.end();
    if (!(await beforeDeadline(this.closed, 1_000))) {
      this.#socket.destroy();
      if (!(await beforeDeadline(this.closed, 1_000))) {
        throw new Error("wss_remote_evidence_close_deadline_exceeded");
      }
    }
  }

  #settleClosed(): void {
    if (this.#settled) return;
    this.#settled = true;
    revokeEnvironmentAssuredTcpStreamIdentity(this.identity);
    this.#resolveClosed(
      this.#socketFailed
        ? {
            reason: "socket_error",
            cause: new Error("wss_remote_evidence_socket_error"),
          }
        : { reason: this.#clientClosed ? "client_closed" : "peer_closed" },
    );
  }
}

async function waitForSecureConnection(
  socket: TLSSocket,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("wss_remote_evidence_connect_timeout")),
      2_000,
    );
    timer.unref();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      socket.removeListener("secureConnect", connected);
      socket.removeListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () =>
      finish(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("wss_remote_evidence_connect_aborted"),
      );
    const connected = () => finish();
    const failed = () =>
      finish(new Error("wss_remote_evidence_tls_identity_invalid"));
    signal.addEventListener("abort", aborted, { once: true });
    socket.once("secureConnect", connected);
    socket.once("error", failed);
    if (signal.aborted) aborted();
  });
}

async function beforeDeadline(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function header(request: string, name: string): string | undefined {
  const prefix = `${name.toLowerCase()}:`;
  for (const line of request.split("\r\n").slice(1)) {
    if (line.toLowerCase().startsWith(prefix)) {
      return line.slice(line.indexOf(":") + 1).trim();
    }
  }
  return undefined;
}

await main();
