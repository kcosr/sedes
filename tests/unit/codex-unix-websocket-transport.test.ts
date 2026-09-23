import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UnixWebSocketTransportFactory,
  type UnixWebSocketLimits,
} from "../../src/server/backends/codex/transport/unix-websocket-transport.js";
import type {
  ProviderTransportScope,
  FramedMessageTransport,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import { isValidFramedTransportAssurance } from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import type {
  EnvironmentPrivateUnixStreamChannel,
  ExecutionEnvironmentChannelProvider,
} from "../../src/server/execution/environment-channel.js";
import { EnvironmentStreamWriteError } from "../../src/server/execution/environment-channel.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import {
  RawUdsWebSocketServer,
  type RawWebSocketHandshakeMode,
} from "../support/raw-uds-websocket-server.js";

const scope: ProviderTransportScope = Object.freeze({
  tenantId: "tenant-uds",
  principalId: "principal-uds",
  backendInstanceId: "codex-uds",
  executionEnvironmentId: "local-uds",
});

type Fixture = {
  readonly root: string;
  readonly peer: RawUdsWebSocketServer;
  readonly channels: LocalEnvironmentChannelProvider;
  readonly factory: UnixWebSocketTransportFactory;
  readonly gate?: UnixWriteGate;
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

describe.sequential("UnixWebSocketTransport", () => {
  it("performs a fixed originless Upgrade and exchanges exact text frames over byte-partial UDS I/O", async () => {
    const fixture = await createFixture({ partialHandshake: true });
    const transport = await fixture.open(7);
    const connection = fixture.peer.latestConnection;
    const request = await connection.requestReceived;

    expect(request).toMatch(/^GET \/ HTTP\/1\.1\r\n/u);
    expect(header(request, "host")).toBe("codex.invalid");
    expect(header(request, "upgrade")?.toLowerCase()).toBe("websocket");
    expect(header(request, "connection")?.toLowerCase()).toContain("upgrade");
    expect(header(request, "sec-websocket-version")).toBe("13");
    expect(header(request, "sec-websocket-key")).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    expect(header(request, "origin")).toBeUndefined();
    expect(request).not.toContain("jsonrpc");

    const outboundText = '{"jsonrpc":"2.0","id":1,"method":"thread/list"}';
    const outbound = transport.send(outboundText);
    const outboundFrame = await connection.waitForFrame(
      ({ opcode }) => opcode === 0x1,
    );
    await expect(outbound).resolves.toEqual({ disposition: "sent" });
    expect(outboundFrame).toMatchObject({
      fin: true,
      masked: true,
      opcode: 0x1,
    });
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
      kind: "private_unix_socket",
      ownership: "external",
      channel: "unix_websocket",
      scope,
      connectionGeneration: 7,
      websocketUpgradeVerified: true,
    });
  });

  it("answers ping, completes the close handshake, and leaves the external listener alive", async () => {
    const fixture = await createFixture();
    const transport = await fixture.open();
    const connection = fixture.peer.latestConnection;

    await connection.sendPing(Buffer.from("uds-ping"), { partial: true });
    const pong = await connection.waitForFrame(({ opcode }) => opcode === 0x0a);
    expect(pong.masked).toBe(true);
    expect(pong.payload.toString("utf8")).toBe("uds-ping");

    await connection.sendClose();
    const clientClose = await connection.waitForFrame(
      ({ opcode }) => opcode === 0x08,
    );
    expect(clientClose.masked).toBe(true);
    await expect(transport.closed).resolves.toMatchObject({
      reason: "external_peer_closed",
    });
    expect(fixture.peer.listening).toBe(true);
  });

  it.each([
    [
      "binary",
      async (fixture: Fixture) => {
        await fixture.peer.latestConnection.sendBinary(Buffer.from("{}"));
      },
      "codex_unix_websocket_binary_message",
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
      limits: {
        maximumFrameBytes: 8,
        maximumOutboundQueueBytes: 16,
      },
    });
    const frameTransport = await frameFixture.open();
    await expect(frameTransport.send("x".repeat(9))).rejects.toMatchObject({
      delivery: "not_sent",
    });
    await delay(10);
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
    const delivered = await queueFixture.peer.latestConnection.waitForFrame(
      ({ opcode }) => opcode === 0x1,
    );
    expect(delivered.payload.toString("utf8")).toBe("first");
    await queueFixture.peer.latestConnection.waitForFrame(
      ({ opcode, payload }) =>
        opcode === 0x1 && payload.toString("utf8") === "third",
    );
  });

  it("classifies pre-send and queued aborts as not_sent", async () => {
    const fixture = await createFixture({
      gatedWrites: true,
      limits: {
        maximumFrameBytes: 64,
        maximumOutboundQueueFrames: 2,
        maximumOutboundQueueBytes: 64,
      },
    });
    const transport = await fixture.open();

    let registrationAbortedReads = 0;
    const registrationRaceSignal = {
      get aborted() {
        registrationAbortedReads += 1;
        return registrationAbortedReads > 1;
      },
      reason: new Error("abort_at_registration"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    await expect(
      transport.send("registration-race", {
        signal: registrationRaceSignal,
      }),
    ).rejects.toMatchObject({ delivery: "not_sent" });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("pre_send_abort"));
    await expect(
      transport.send("pre-send", { signal: alreadyAborted.signal }),
    ).rejects.toMatchObject({ delivery: "not_sent" });

    fixture.gate!.block();
    const active = transport.send("active");
    const queuedController = new AbortController();
    const queued = transport.send("queued", {
      signal: queuedController.signal,
    });
    queuedController.abort(new Error("queued_abort"));
    await expect(queued).rejects.toMatchObject({ delivery: "not_sent" });
    const replacement = transport.send("replacement");
    fixture.gate!.release();
    await expect(active).resolves.toEqual({ disposition: "sent" });
    await expect(replacement).resolves.toEqual({ disposition: "sent" });
    await fixture.peer.latestConnection.waitForFrame(
      ({ opcode, payload }) =>
        opcode === 0x1 && payload.toString("utf8") === "active",
    );
    expect(
      fixture.peer.latestConnection.frames.some(
        ({ payload }) => payload.toString("utf8") === "queued",
      ),
    ).toBe(false);
    await fixture.peer.latestConnection.waitForFrame(
      ({ opcode, payload }) =>
        opcode === 0x1 && payload.toString("utf8") === "replacement",
    );
  });

  it("classifies an abort after the carrier write begins as sent_outcome_unknown", async () => {
    const fixture = await createFixture({ gatedWrites: true });
    const transport = await fixture.open();
    fixture.gate!.block();
    const controller = new AbortController();
    const sending = transport.send("possibly-delivered", {
      signal: controller.signal,
    });
    const queued = transport.send("must-not-be-replayed");

    controller.abort(new Error("active_send_abort"));
    await expect(sending).rejects.toMatchObject({
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

  it("classifies unsafe provider paths as permanent identity failures", async () => {
    const fixture = await createFixture();
    const unsafeFactory = new UnixWebSocketTransportFactory({
      scope,
      channels: fixture.channels,
      socketPath: `${fixture.root}/../${path.basename(fixture.root)}/${path.basename(fixture.peer.socketPath)}`,
    });

    await expect(
      unsafeFactory.open(scope, 1, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "codex_unix_websocket_identity_invalid",
      permanent: true,
    });
  });

  it("completes Upgrade through an owned private socket alias", async () => {
    const fixture = await createFixture();
    const alias = path.join(fixture.root, "configured.sock");
    await symlink(fixture.peer.socketPath, alias);
    const factory = new UnixWebSocketTransportFactory({scope, channels: fixture.channels, socketPath: alias});
    const transport = await factory.open(scope, 1, new AbortController().signal);
    fixture.transports.push(transport);
    expect(fixture.peer.requests).toHaveLength(1);
    expect(isValidFramedTransportAssurance(transport.assurance)).toBe(true);
    expect(transport.assurance).toMatchObject({websocketUpgradeVerified: true});
  });

  it("rejects a real alias retarget after Upgrade and allows a fresh generation", async () => {
    const fixture = await createFixture();
    const replacement = await createFixture();
    const alias = path.join(fixture.root, "configured.sock");
    await symlink(fixture.peer.socketPath, alias);
    const factory = new UnixWebSocketTransportFactory({scope, socketPath: alias,
      channels: wrappingProvider(fixture.channels, channel => wrappedChannel(channel, {
        revalidateIdentity: async () => {
          expect(fixture.peer.requests).toHaveLength(1);
          await rm(alias);
          await symlink(replacement.peer.socketPath, alias);
          await channel.revalidateIdentity();
        },
      })),
    });
    await expect(factory.open(scope, 1, new AbortController().signal)).rejects.toMatchObject({
      code: "codex_unix_websocket_unavailable", permanent: false,
    });
    const freshFactory = new UnixWebSocketTransportFactory({scope, channels: fixture.channels, socketPath: alias});
    const transport = await freshFactory.open(scope, 2, new AbortController().signal);
    fixture.transports.push(transport);
    expect(replacement.peer.requests).toHaveLength(1);
    expect(isValidFramedTransportAssurance(transport.assurance)).toBe(true);
  });

  it("retries a socket replacement detected after Upgrade with a fresh generation", async () => {
    const fixture = await createFixture();
    const replacementFactory = new UnixWebSocketTransportFactory({
      scope,
      channels: wrappingProvider(fixture.channels, (channel) =>
        wrappedChannel(channel, {
          revalidateIdentity: async () => {
            throw new Error(
              "environment_private_unix_stream_identity_replaced",
            );
          },
        }),
      ),
      socketPath: fixture.peer.socketPath,
    });

    await expect(
      replacementFactory.open(scope, 1, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "codex_unix_websocket_unavailable",
      permanent: false,
    });
  });

  it("retries a transient carrier failure while writing the Upgrade", async () => {
    const fixture = await createFixture();
    const failedWriteFactory = new UnixWebSocketTransportFactory({
      scope,
      channels: wrappingProvider(fixture.channels, (channel) =>
        wrappedChannel(channel, {
          write: async () => {
            const cause = Object.assign(new Error("fixture_socket_closed"), {
              code: "EPIPE",
            });
            throw new EnvironmentStreamWriteError(
              "environment_private_unix_stream_write_failed",
              "sent_outcome_unknown",
              { cause },
            );
          },
        }),
      ),
      socketPath: fixture.peer.socketPath,
    });

    await expect(
      beforeDeadline(
        failedWriteFactory.open(scope, 1, new AbortController().signal),
      ),
    ).rejects.toMatchObject({
      code: "codex_unix_websocket_unavailable",
      permanent: false,
    });
  });

  it("times out a silent Upgrade", async () => {
    const timeoutFixture = await createFixture({
      handshakeMode: "stall",
      limits: { handshakeTimeoutMilliseconds: 25 },
    });
    await expect(
      beforeDeadline(
        timeoutFixture.factory.open(scope, 1, new AbortController().signal),
        250,
      ),
    ).rejects.toMatchObject({
      code: "codex_unix_websocket_unavailable",
      permanent: false,
    });
  });

  it("permanently rejects an HTTP Upgrade denial", async () => {
    const rejectedFixture = await createFixture({ handshakeMode: "reject" });
    await expect(
      rejectedFixture.factory.open(scope, 1, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "codex_unix_websocket_upgrade_rejected",
      permanent: true,
    });
  });

  it("closes idempotently and closes only its client connection", async () => {
    const fixture = await createFixture();
    const firstTransport = await fixture.open(1);
    const firstConnection = fixture.peer.latestConnection;

    const firstClose = firstTransport.close("first_close");
    const repeatedClose = firstTransport.close("repeated_close");
    expect(repeatedClose).toBe(firstClose);
    await firstClose;
    expect(isValidFramedTransportAssurance(firstTransport.assurance)).toBe(
      false,
    );
    const closeFrame = await firstConnection.waitForFrame(
      ({ opcode }) => opcode === 0x08,
    );
    expect(closeFrame.masked).toBe(true);
    expect(fixture.peer.listening).toBe(true);

    const secondTransport = await fixture.open(2);
    expect(fixture.peer.connections).toHaveLength(2);
    expect(secondTransport.assurance).toMatchObject({
      connectionGeneration: 2,
    });
    await secondTransport.close("second_client_close");
    expect(fixture.peer.listening).toBe(true);
  });
});

async function createFixture(
  input: {
    readonly handshakeMode?: RawWebSocketHandshakeMode;
    readonly partialHandshake?: boolean;
    readonly limits?: Partial<UnixWebSocketLimits>;
    readonly gatedWrites?: boolean;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-codex-uds-wire-"));
  await chmod(root, 0o700);
  const peer = new RawUdsWebSocketServer({
    socketPath: path.join(root, "codex.sock"),
    ...(input.handshakeMode ? { handshakeMode: input.handshakeMode } : {}),
    ...(input.partialHandshake
      ? { partialHandshake: input.partialHandshake }
      : {}),
  });
  await peer.listen();
  const channels = new LocalEnvironmentChannelProvider({
    scope,
    executionEnvironmentId: scope.executionEnvironmentId,
  });
  const gate = input.gatedWrites ? new UnixWriteGate() : undefined;
  const channelProvider = gate ? gate.provider(channels) : channels;
  const factory = new UnixWebSocketTransportFactory({
    scope,
    channels: channelProvider,
    socketPath: peer.socketPath,
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
    ...(gate ? { gate } : {}),
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

class UnixWriteGate {
  #blocked = false;
  readonly #pending: Array<{
    readonly channel: EnvironmentPrivateUnixStreamChannel;
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
      openPrivateUnixStream: async (...arguments_) => {
        const channel = await channels.openPrivateUnixStream(...arguments_);
        return this.#wrap(channel);
      },
      openAssuredTcpStream: channels.openAssuredTcpStream.bind(channels),
      resolveSecret: channels.resolveSecret.bind(channels),
    };
  }

  #wrap(
    channel: EnvironmentPrivateUnixStreamChannel,
  ): EnvironmentPrivateUnixStreamChannel {
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
      revalidateIdentity: channel.revalidateIdentity.bind(channel),
      closeClient: channel.closeClient.bind(channel),
      destroyClient: channel.destroyClient.bind(channel),
    };
  }
}

function wrappingProvider(
  channels: LocalEnvironmentChannelProvider,
  wrap: (
    channel: EnvironmentPrivateUnixStreamChannel,
  ) => EnvironmentPrivateUnixStreamChannel,
): ExecutionEnvironmentChannelProvider {
  return {
    scope: channels.scope,
    executionEnvironmentId: channels.executionEnvironmentId,
    reportRuntimeAvailability:
      channels.reportRuntimeAvailability.bind(channels),
    resolveDirectory: channels.resolveDirectory.bind(channels),
    prepareOwnedProcess: channels.prepareOwnedProcess.bind(channels),
    openOwnedProcess: channels.openOwnedProcess.bind(channels),
    openPrivateUnixStream: async (...arguments_) =>
      wrap(await channels.openPrivateUnixStream(...arguments_)),
    openAssuredTcpStream: channels.openAssuredTcpStream.bind(channels),
    resolveSecret: channels.resolveSecret.bind(channels),
  };
}

function wrappedChannel(
  channel: EnvironmentPrivateUnixStreamChannel,
  overrides: Partial<
    Pick<EnvironmentPrivateUnixStreamChannel, "write" | "revalidateIdentity">
  >,
): EnvironmentPrivateUnixStreamChannel {
  return {
    identity: channel.identity,
    bytes: channel.bytes,
    closed: channel.closed,
    write: overrides.write ?? channel.write.bind(channel),
    revalidateIdentity:
      overrides.revalidateIdentity ?? channel.revalidateIdentity.bind(channel),
    closeClient: channel.closeClient.bind(channel),
    destroyClient: channel.destroyClient.bind(channel),
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
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("test_deadline_exceeded")),
        timeoutMilliseconds,
      );
    }),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
