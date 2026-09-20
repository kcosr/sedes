import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TcpWebSocketTransportFactory,
  type TcpWebSocketLimits,
} from "../../src/server/backends/codex/transport/tcp-websocket-transport.js";
import {
  isValidFramedTransportAssurance,
  type ProviderTransportScope,
  type FramedMessageTransport,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import type {
  EnvironmentAssuredTcpStreamChannel,
  EnvironmentSecretReference,
  ExecutionEnvironmentChannelProvider,
} from "../../src/server/execution/environment-channel.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import {
  RawTcpWebSocketServer,
  type RawWebSocketHandshakeResponder,
} from "../support/raw-uds-websocket-server.js";

const scope: ProviderTransportScope = Object.freeze({
  tenantId: "tenant-tcp",
  principalId: "principal-tcp",
  backendInstanceId: "codex-tcp",
  executionEnvironmentId: "local-tcp",
});
const TOKEN_VARIABLE = "SEDES_CODEX_TCP_TOKEN";
const CAPABILITY_TOKEN = "tcp-capability-token-12345";

type Fixture = {
  readonly root: string;
  readonly peer: RawTcpWebSocketServer;
  readonly channels: LocalEnvironmentChannelProvider;
  readonly factory: TcpWebSocketTransportFactory;
  readonly gate?: TcpWriteGate;
  readonly secretPath?: string;
  readonly expectedToken: { value: string };
  readonly transports: FramedMessageTransport[];
  open(
    generation?: number,
    signal?: AbortSignal,
  ): Promise<FramedMessageTransport>;
};

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    fixture.gate?.release();
    await Promise.allSettled(
      fixture.transports.map((transport) =>
        transport.close("test_fixture_cleanup"),
      ),
    );
    fixture.channels.close();
    await fixture.peer.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe.sequential("TcpWebSocketTransport", () => {
  it("sends an exact originless bearer Upgrade and one JSON-RPC text message per partial TCP WebSocket frame", async () => {
    const fixture = await createFixture({ partialHandshake: true });
    const transport = await fixture.open(7);
    const connection = fixture.peer.latestConnection;
    const request = await connection.requestReceived;

    expect(request).toMatch(/^GET \/ HTTP\/1\.1\r\n/u);
    expect(header(request, "host")).toBe(`127.0.0.1:${fixture.peer.port}`);
    expect(header(request, "authorization")).toBe(`Bearer ${CAPABILITY_TOKEN}`);
    expect(header(request, "origin")).toBeUndefined();
    expect(header(request, "upgrade")?.toLowerCase()).toBe("websocket");
    expect(header(request, "sec-websocket-version")).toBe("13");
    expect(request).not.toContain("jsonrpc");

    const outboundText = '{"jsonrpc":"2.0","id":1,"method":"thread/list"}';
    const outbound = transport.send(outboundText);
    const outboundFrame = await connection.waitForFrame(
      ({ opcode }) => opcode === 0x1,
    );
    await expect(outbound).resolves.toEqual({ disposition: "sent" });
    expect(outboundFrame).toMatchObject({ fin: true, masked: true, opcode: 1 });
    expect(outboundFrame.payload.toString("utf8")).toBe(outboundText);
    expect(outboundFrame.payload.at(-1)).not.toBe(0x0a);

    const inboundText = '{"jsonrpc":"2.0","id":1,"result":{"ok":"☃"}}';
    const iterator = transport.frames[Symbol.asyncIterator]();
    const inbound = iterator.next();
    await connection.sendText(inboundText, { partial: true });
    await expect(inbound).resolves.toEqual({
      done: false,
      value: {
        text: inboundText,
        byteLength: Buffer.byteLength(inboundText, "utf8"),
      },
    });
    expect(transport.assurance).toMatchObject({
      kind: "authenticated_tcp",
      ownership: "external",
      channel: "tcp_websocket",
      scope,
      connectionGeneration: 7,
      websocketUpgradeVerified: true,
    });
    const serializedAssurance = JSON.stringify(transport.assurance);
    expect(transport.assurance).not.toHaveProperty("authentication");
    expect(serializedAssurance).not.toContain(CAPABILITY_TOKEN);
    expect(serializedAssurance).not.toContain(fixture.peer.url);
  });

  it("answers ping, completes close, and leaves the TCP listener alive for a new generation", async () => {
    const fixture = await createFixture();
    const first = await fixture.open(1);
    const firstConnection = fixture.peer.latestConnection;

    await firstConnection.sendPing(Buffer.from("tcp-ping"), { partial: true });
    const pong = await firstConnection.waitForFrame(
      ({ opcode }) => opcode === 0x0a,
    );
    expect(pong.masked).toBe(true);
    expect(pong.payload.toString("utf8")).toBe("tcp-ping");

    const firstClose = first.close("first_close");
    expect(first.close("repeated_close")).toBe(firstClose);
    await firstClose;
    const closeFrame = await firstConnection.waitForFrame(
      ({ opcode }) => opcode === 0x08,
    );
    expect(closeFrame.masked).toBe(true);
    expect(fixture.peer.listening).toBe(true);
    expect(isValidFramedTransportAssurance(first.assurance)).toBe(false);

    const second = await fixture.open(2);
    expect(fixture.peer.connections).toHaveLength(2);
    expect(second.assurance.connectionGeneration).toBe(2);
    await second.close("second_close");
    expect(fixture.peer.listening).toBe(true);
  });

  it.each([
    [
      "binary",
      async (fixture: Fixture) => {
        await fixture.peer.latestConnection.sendBinary(Buffer.from("{}"));
      },
      "codex_tcp_websocket_binary_message",
      undefined,
    ],
    [
      "invalid UTF-8",
      async (fixture: Fixture) => {
        await fixture.peer.latestConnection.sendFrame(
          0x1,
          Buffer.from([0xc3, 0x28]),
        );
      },
      "external_peer_closed",
      1007,
    ],
    [
      "oversize",
      async (fixture: Fixture) => {
        await fixture.peer.latestConnection.sendText("x".repeat(17));
      },
      "external_peer_closed",
      1009,
    ],
    [
      "fragmented",
      async (fixture: Fixture) => {
        await fixture.peer.latestConnection.sendText("{", { fin: false });
        await fixture.peer.latestConnection.sendFrame(0x0, Buffer.from("}"));
      },
      "external_peer_closed",
      1008,
    ],
  ] as const)(
    "fails closed on %s inbound messages",
    async (_label, send, expectedReason, expectedCloseCode) => {
      const fixture = await createFixture({
        limits: { maximumFrameBytes: 16 },
      });
      const transport = await fixture.open();
      const iterator = transport.frames[Symbol.asyncIterator]();

      await send(fixture);
      const closure = await beforeDeadline(transport.closed);
      expect(closure.reason).toBe(expectedReason);
      if (expectedCloseCode !== undefined) {
        const close = await fixture.peer.latestConnection.waitForFrame(
          ({ opcode }) => opcode === 0x08,
        );
        expect(close.payload.readUInt16BE(0)).toBe(expectedCloseCode);
      }
      await expect(iterator.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    },
  );

  it.each([
    [
      "frame count",
      {
        maximumFrameBytes: 100,
        maximumInboundQueueFrames: 1,
        maximumInboundQueueBytes: 100,
      },
      "first",
      "second",
    ],
    [
      "byte count",
      {
        maximumFrameBytes: 6,
        maximumInboundQueueFrames: 5,
        maximumInboundQueueBytes: 6,
      },
      "1234",
      "5678",
    ],
  ] as const)(
    "backpressures at the inbound %s queue watermark",
    async (_label, limits, first, second) => {
      const fixture = await createFixture({ limits });
      const transport = await fixture.open();
      const iterator = transport.frames[Symbol.asyncIterator]();
      await fixture.peer.latestConnection.sendText(first);
      await delay(10);
      await fixture.peer.latestConnection.sendText(second);
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { text: first, byteLength: Buffer.byteLength(first) },
      });
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { text: second, byteLength: Buffer.byteLength(second) },
      });
      await transport.close("test_complete");
    },
  );

  it("rejects oversized frames and backpressures a finite outbound burst", async () => {
    const frameFixture = await createFixture({
      limits: { maximumFrameBytes: 8, maximumOutboundQueueBytes: 16 },
    });
    const frameTransport = await frameFixture.open();
    await expect(frameTransport.send("x".repeat(9))).rejects.toMatchObject({
      delivery: "not_sent",
    });
    expect(frameFixture.peer.latestConnection.frames).toEqual([]);

    const queueFixture = await createFixture({
      gatedWrites: true,
      limits: {
        maximumFrameBytes: 16,
        maximumOutboundQueueBytes: 32,
        maximumOutboundQueueFrames: 1,
      },
    });
    const queueTransport = await queueFixture.open();
    queueFixture.gate!.block();
    const active = queueTransport.send("first");
    const queued = queueTransport.send("second");
    const waiting = queueTransport.send("third");
    queueFixture.gate!.release();
    await expect(Promise.all([active, queued, waiting])).resolves.toEqual([
      { disposition: "sent" },
      { disposition: "sent" },
      { disposition: "sent" },
    ]);
  });

  it("preserves not_sent for pre/queued abort and sent_outcome_unknown after carrier write begins", async () => {
    const fixture = await createFixture({ gatedWrites: true });
    const transport = await fixture.open();

    const preAborted = new AbortController();
    preAborted.abort(new Error("pre_send_abort"));
    await expect(
      transport.send("pre-send", { signal: preAborted.signal }),
    ).rejects.toMatchObject({ delivery: "not_sent" });

    fixture.gate!.block();
    const controller = new AbortController();
    const active = transport.send("possibly-delivered", {
      signal: controller.signal,
    });
    const queued = transport.send("must-not-be-replayed");
    controller.abort(new Error("active_send_abort"));
    await expect(active).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(queued).rejects.toMatchObject({ delivery: "not_sent" });
    fixture.gate!.release();
    await expect(beforeDeadline(transport.closed)).resolves.toMatchObject({
      reason: expect.any(String),
    });
    expect(
      fixture.peer.latestConnection.frames.some(
        ({ payload }) => payload.toString("utf8") === "must-not-be-replayed",
      ),
    ).toBe(false);
  });

  it.each([401, 403] as const)(
    "classifies HTTP %s as terminal authentication rejection",
    async (statusCode) => {
      const fixture = await createFixture({ responseStatus: statusCode });
      await expect(fixture.open()).rejects.toMatchObject({
        code: "codex_tcp_websocket_authentication_rejected",
        permanent: true,
      });
    },
  );

  it.each([429, 503] as const)(
    "classifies HTTP %s as retryable overload",
    async (statusCode) => {
      const fixture = await createFixture({ responseStatus: statusCode });
      await expect(fixture.open()).rejects.toMatchObject({
        code: "codex_tcp_websocket_overloaded",
        permanent: false,
      });
    },
  );

  it("classifies a stalled Upgrade and connection refusal as retryable availability", async () => {
    const stalled = await createFixture({
      stallHandshake: true,
      limits: { handshakeTimeoutMilliseconds: 25 },
    });
    await expect(beforeDeadline(stalled.open(), 250)).rejects.toMatchObject({
      code: "codex_tcp_websocket_unavailable",
      permanent: false,
    });

    const refused = await createFixture();
    const url = refused.peer.url;
    await refused.peer.close();
    const factory = new TcpWebSocketTransportFactory({
      scope,
      channels: refused.channels,
      url,
      secretReference: {
        source: "environment",
        variable: TOKEN_VARIABLE,
      },
      limits: { handshakeTimeoutMilliseconds: 100 },
    });
    await expect(
      factory.open(scope, 1, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "codex_tcp_websocket_unavailable",
      permanent: false,
    });
  });

  it.each([
    [undefined, "missing"],
    ["", "empty"],
    ["malformed token with spaces", "malformed"],
  ] as const)(
    "rejects a %s environment token before opening a TCP connection",
    async (token, _label) => {
      const fixture = await createFixture({ environmentToken: token });
      await expect(fixture.open()).rejects.toMatchObject({
        code: "codex_tcp_websocket_authentication_invalid",
        permanent: true,
      });
      expect(fixture.peer.connections).toHaveLength(0);
    },
  );

  it("sends a valid but wrong environment token once and treats the listener rejection as terminal", async () => {
    const wrongToken = "wrong-capability-token-12345";
    const fixture = await createFixture({ environmentToken: wrongToken });
    await expect(fixture.open()).rejects.toMatchObject({
      code: "codex_tcp_websocket_authentication_rejected",
      permanent: true,
    });
    expect(
      header(
        await fixture.peer.latestConnection.requestReceived,
        "authorization",
      ),
    ).toBe(`Bearer ${wrongToken}`);
    expect(String(await rejectedOpen(fixture.factory))).not.toContain(
      wrongToken,
    );
  });

  it("authenticates a rotated environment token after rebuilding the environment capability", async () => {
    const fixture = await createFixture();
    const first = await fixture.open(1);
    await first.close("before_environment_rotation");

    const rotatedToken = "rotated-environment-token-67890";
    fixture.expectedToken.value = rotatedToken;
    const rotatedChannels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: scope.executionEnvironmentId,
      environment: { [TOKEN_VARIABLE]: rotatedToken },
    });
    const rotatedFactory = new TcpWebSocketTransportFactory({
      scope,
      channels: rotatedChannels,
      url: fixture.peer.url,
      secretReference: {
        source: "environment",
        variable: TOKEN_VARIABLE,
      },
    });
    let rotated: FramedMessageTransport | undefined;
    try {
      rotated = await rotatedFactory.open(
        scope,
        2,
        new AbortController().signal,
      );
      expect(
        header(
          await fixture.peer.latestConnection.requestReceived,
          "authorization",
        ),
      ).toBe(`Bearer ${rotatedToken}`);
    } finally {
      await rotated?.close("environment_rotation_complete");
      rotatedChannels.close();
    }
  });

  it("re-resolves a protected-file token for each generation and authenticates rotation", async () => {
    const fixture = await createFixture({ protectedFileToken: true });
    if (!fixture.secretPath) throw new Error("test_secret_path_missing");
    const first = await fixture.open(1);
    expect(
      header(
        await fixture.peer.latestConnection.requestReceived,
        "authorization",
      ),
    ).toBe(`Bearer ${CAPABILITY_TOKEN}`);
    await first.close("rotate_token");

    fixture.expectedToken.value = "rotated-capability-token-67890";
    await writeFile(fixture.secretPath, `${fixture.expectedToken.value}\n`, {
      mode: 0o600,
    });
    await chmod(fixture.secretPath, 0o600);
    const second = await fixture.open(2);
    expect(
      header(
        await fixture.peer.latestConnection.requestReceived,
        "authorization",
      ),
    ).toBe(`Bearer ${fixture.expectedToken.value}`);
    await second.close("rotation_complete");
  });

  it("rejects wrong scope, invalid generation, and structurally forged environment assurance before initialization", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.factory.open(
        { ...scope, principalId: "wrong-principal" },
        1,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "codex_tcp_websocket_scope_mismatch",
      permanent: true,
    });
    await expect(
      fixture.factory.open(scope, 0, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "codex_tcp_websocket_generation_invalid",
      permanent: true,
    });

    const forgedFactory = new TcpWebSocketTransportFactory({
      scope,
      channels: forgingProvider(fixture.channels),
      url: fixture.peer.url,
      secretReference: {
        source: "environment",
        variable: TOKEN_VARIABLE,
      },
    });
    await expect(
      forgedFactory.open(scope, 3, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "codex_tcp_websocket_identity_invalid",
      permanent: true,
    });
  });

  it("keeps token, endpoint, protected path, and Authorization header out of failures", async () => {
    const fixture = await createFixture({
      protectedFileToken: true,
      responseStatus: 403,
    });
    if (!fixture.secretPath) throw new Error("test_secret_path_missing");
    let failure: unknown;
    try {
      await fixture.open();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "codex_tcp_websocket_authentication_rejected",
      permanent: true,
    });
    const serialized = `${String(failure)}\n${JSON.stringify(failure)}`;
    for (const forbidden of [
      CAPABILITY_TOKEN,
      fixture.peer.url,
      fixture.secretPath,
      `Bearer ${CAPABILITY_TOKEN}`,
      "Authorization:",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

async function createFixture(
  input: {
    readonly partialHandshake?: boolean;
    readonly responseStatus?: 401 | 403 | 429 | 503;
    readonly stallHandshake?: boolean;
    readonly handshakeResponder?: RawWebSocketHandshakeResponder;
    readonly limits?: Partial<TcpWebSocketLimits>;
    readonly gatedWrites?: boolean;
    readonly environmentToken?: string;
    readonly protectedFileToken?: boolean;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-codex-tcp-wire-"));
  await chmod(root, 0o700);
  const expectedToken = { value: CAPABILITY_TOKEN };
  const defaultResponder: RawWebSocketHandshakeResponder = (request) => {
    if (input.stallHandshake) return "stall";
    if (input.responseStatus) return { statusCode: input.responseStatus };
    return header(request, "authorization") === `Bearer ${expectedToken.value}`
      ? "accept"
      : { statusCode: 401 };
  };
  const peer = new RawTcpWebSocketServer({
    ...(input.partialHandshake
      ? { partialHandshake: input.partialHandshake }
      : {}),
    handshakeResponder: input.handshakeResponder ?? defaultResponder,
  });
  await peer.listen();
  const environmentTokenPresent = Object.hasOwn(input, "environmentToken");
  const channels = new LocalEnvironmentChannelProvider({
    scope,
    executionEnvironmentId: scope.executionEnvironmentId,
    environment: {
      [TOKEN_VARIABLE]: environmentTokenPresent
        ? input.environmentToken
        : CAPABILITY_TOKEN,
    },
  });
  let secretPath: string | undefined;
  let secretReference: EnvironmentSecretReference = {
    source: "environment",
    variable: TOKEN_VARIABLE,
  };
  if (input.protectedFileToken) {
    secretPath = path.join(root, "capability-token");
    await writeFile(secretPath, `${CAPABILITY_TOKEN}\n`, { mode: 0o600 });
    await chmod(secretPath, 0o600);
    secretReference = { source: "protected_file", path: secretPath };
  }
  const gate = input.gatedWrites ? new TcpWriteGate() : undefined;
  const provider = gate ? gate.provider(channels) : channels;
  const factory = new TcpWebSocketTransportFactory({
    scope,
    channels: provider,
    url: peer.url,
    secretReference,
    limits: {
      handshakeTimeoutMilliseconds: 250,
      ...(input.limits ?? {}),
    },
  });
  const transports: FramedMessageTransport[] = [];
  const fixture: Fixture = {
    root,
    peer,
    channels,
    factory,
    expectedToken,
    ...(gate ? { gate } : {}),
    ...(secretPath ? { secretPath } : {}),
    transports,
    async open(
      generation = 1,
      signal = new AbortController().signal,
    ): Promise<FramedMessageTransport> {
      const transport = await factory.open(scope, generation, signal);
      transports.push(transport);
      return transport;
    },
  };
  fixtures.push(fixture);
  return fixture;
}

class TcpWriteGate {
  #blocked = false;
  readonly #pending: Array<{
    readonly channel: EnvironmentAssuredTcpStreamChannel;
    readonly bytes: Uint8Array;
    readonly options?: { readonly signal?: AbortSignal };
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }> = [];

  block(): void {
    this.#blocked = true;
  }

  release(): void {
    this.#blocked = false;
    for (const entry of this.#pending.splice(0)) {
      void entry.channel
        .write(entry.bytes, entry.options)
        .then(entry.resolve, entry.reject);
    }
  }

  provider(
    channels: LocalEnvironmentChannelProvider,
  ): ExecutionEnvironmentChannelProvider {
    return {
      scope: channels.scope,
      executionEnvironmentId: channels.executionEnvironmentId,
      reportRuntimeAvailability:
        channels.reportRuntimeAvailability.bind(channels),
      resolveDirectory: channels.resolveDirectory.bind(channels),
      prepareOwnedProcess: channels.prepareOwnedProcess.bind(channels),
      openOwnedProcess: channels.openOwnedProcess.bind(channels),
      openPrivateUnixStream: channels.openPrivateUnixStream.bind(channels),
      openAssuredTcpStream: async (...arguments_) =>
        this.#wrap(await channels.openAssuredTcpStream(...arguments_)),
      resolveSecret: channels.resolveSecret.bind(channels),
    };
  }

  #wrap(
    channel: EnvironmentAssuredTcpStreamChannel,
  ): EnvironmentAssuredTcpStreamChannel {
    return {
      identity: channel.identity,
      bytes: channel.bytes,
      closed: channel.closed,
      write: (bytes, options) => {
        if (!this.#blocked) return channel.write(bytes, options);
        return new Promise<void>((resolve, reject) => {
          this.#pending.push({
            channel,
            bytes: new Uint8Array(bytes),
            ...(options ? { options } : {}),
            resolve,
            reject,
          });
        });
      },
      closeClient: channel.closeClient.bind(channel),
      destroyClient: channel.destroyClient.bind(channel),
    };
  }
}

function forgingProvider(
  channels: LocalEnvironmentChannelProvider,
): ExecutionEnvironmentChannelProvider {
  return {
    scope: channels.scope,
    executionEnvironmentId: channels.executionEnvironmentId,
    reportRuntimeAvailability:
      channels.reportRuntimeAvailability.bind(channels),
    resolveDirectory: channels.resolveDirectory.bind(channels),
    prepareOwnedProcess: channels.prepareOwnedProcess.bind(channels),
    openOwnedProcess: channels.openOwnedProcess.bind(channels),
    openPrivateUnixStream: channels.openPrivateUnixStream.bind(channels),
    openAssuredTcpStream: async (...arguments_) => {
      const channel = await channels.openAssuredTcpStream(...arguments_);
      return {
        identity: Object.freeze({
          ...channel.identity,
          channelId: "structurally-forged-channel",
        }),
        bytes: channel.bytes,
        closed: channel.closed,
        write: channel.write.bind(channel),
        closeClient: channel.closeClient.bind(channel),
        destroyClient: channel.destroyClient.bind(channel),
      };
    },
    resolveSecret: channels.resolveSecret.bind(channels),
  };
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

async function beforeDeadline<T>(
  promise: Promise<T>,
  timeoutMilliseconds = 1_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("test_deadline_exceeded")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function rejectedOpen(
  factory: TcpWebSocketTransportFactory,
): Promise<unknown> {
  try {
    await factory.open(scope, 19, new AbortController().signal);
  } catch (error) {
    return error;
  }
  throw new Error("test_expected_open_rejection");
}
