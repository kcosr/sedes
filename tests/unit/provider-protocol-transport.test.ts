import { describe, expect, it } from "vitest";
import {
  EnvironmentProcessWriteError,
  createEnvironmentPrivateUnixStreamIdentity,
  createEnvironmentOwnedProcessIdentity,
  type EnvironmentOwnedProcessChannel,
  type EnvironmentProcessClosure,
} from "../../src/server/execution/environment-channel.js";
import {
  FrameWriteError,
  createPrivateUnixSocketAssurance,
  externalTransport,
  isValidFramedTransportAssurance,
  type FramedTransportClosure,
  type PrivateUnixSocketAssurance,
  type ProviderTransportScope,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import {
  DEFAULT_OWNED_NDJSON_STDIO_LIMITS,
  OwnedNdjsonStdioTransport,
  type OwnedNdjsonStdioLimits,
} from "../../src/server/provider-protocol/transport/owned-ndjson-stdio-transport.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../src/server/provider-protocol/transport/framed-message-limits.js";
import {
  DEFAULT_WEBSOCKET_FRAMED_LIMITS,
  resolveWebSocketFramedLimits,
} from "../../src/server/provider-protocol/transport/websocket-framed-connection.js";

const scope: ProviderTransportScope = Object.freeze({
  tenantId: "tenant-provider-transport",
  principalId: "principal-provider-transport",
  backendInstanceId: "backend-provider-transport",
  executionEnvironmentId: "environment-provider-transport",
});

const defaultLimits: OwnedNdjsonStdioLimits = Object.freeze({
  maximumFrameBytes: 64,
  maximumInboundQueueBytes: 128,
  maximumInboundQueueFrames: 4,
  maximumOutboundQueueBytes: 128,
  maximumOutboundQueueFrames: 4,
  maximumStderrTailBytes: 64,
  gracefulCloseMilliseconds: 10,
  terminateMilliseconds: 10,
  killMilliseconds: 10,
});

describe("provider protocol owned NDJSON transport", () => {
  it("retains production defaults large enough for bounded provider history", () => {
    expect(DEFAULT_OWNED_NDJSON_STDIO_LIMITS).toMatchObject({
      maximumFrameBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
      maximumInboundQueueBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
      maximumOutboundQueueBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
    });
    for (const obsoleteLifetimeLimit of [
      "maximumStdoutBytes",
      "maximumStderrBytes",
      "maximumInboundFrames",
      "maximumOutboundFrames",
    ]) {
      expect(DEFAULT_OWNED_NDJSON_STDIO_LIMITS).not.toHaveProperty(
        obsoleteLifetimeLimit,
      );
    }
  });

  it("requires the inbound byte watermark to retain one maximum-sized frame", () => {
    expect(() =>
      transportFixture({
        maximumFrameBytes: 65,
        maximumInboundQueueBytes: 64,
      }),
    ).toThrow("test_transport_limits_invalid");
  });

  it("requires the outbound byte watermark to retain one maximum-sized frame", () => {
    expect(() =>
      transportFixture({
        maximumFrameBytes: 65,
        maximumOutboundQueueBytes: 64,
      }),
    ).toThrow("test_transport_limits_invalid");
  });

  it("carries one shared-maximum frame through both queues and rejects one byte above", async () => {
    const fixture = transportFixture({
      maximumFrameBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
      maximumInboundQueueBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
      maximumOutboundQueueBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
    });
    const iterator = fixture.transport.frames[Symbol.asyncIterator]();
    const inbound = iterator.next();
    fixture.channel.stdoutSource.push(
      Buffer.alloc(MAXIMUM_PROVIDER_FRAME_BYTES, 0x78),
    );
    fixture.channel.stdoutSource.push(Buffer.from("\n"));
    const received = await inbound;
    expect(received).toMatchObject({
      done: false,
      value: { byteLength: MAXIMUM_PROVIDER_FRAME_BYTES },
    });
    const maximumText = received.value?.text ?? "";
    await expect(fixture.transport.send(maximumText)).resolves.toEqual({
      disposition: "sent",
    });
    await expect(
      fixture.transport.send(`${maximumText}x`),
    ).rejects.toMatchObject({
      delivery: "not_sent",
      message: "test_transport_outbound_limit",
    });
    await fixture.transport.close("test_complete");
  }, 30_000);

  it.each([
    ["blank line", Buffer.from("\n"), {}, "invalid_stdout_frame"],
    [
      "oversized pre-newline bytes",
      Buffer.from("12345"),
      { maximumFrameBytes: 4 },
      "oversized_stdout_frame",
    ],
  ] as const)(
    "fails closed on %s",
    async (_label, bytes, limits, expectedReason) => {
      const fixture = transportFixture(limits);
      fixture.channel.stdoutSource.push(bytes);

      await expect(fixture.transport.closed).resolves.toMatchObject({
        reason: expectedReason,
        cause: expect.any(Error),
      });
    },
  );

  it("fails closed on an unterminated EOF frame", async () => {
    const fixture = transportFixture();
    fixture.channel.stdoutSource.push(Buffer.from('{"partial":true}'));
    fixture.channel.stdoutSource.end();

    await expect(fixture.transport.closed).resolves.toMatchObject({
      reason: "stdout_partial_frame",
      cause: expect.any(Error),
    });
  });

  it("can cross small lifetime totals while retaining only bounded current resources", async () => {
    const fixture = transportFixture({
      maximumFrameBytes: 32,
      maximumInboundQueueBytes: 32,
      maximumInboundQueueFrames: 1,
      maximumOutboundQueueBytes: 32,
      maximumOutboundQueueFrames: 1,
      maximumStderrTailBytes: 16,
    });
    const iterator = fixture.transport.frames[Symbol.asyncIterator]();
    const frame = "x".repeat(24);
    for (let index = 0; index < 4; index += 1) {
      fixture.channel.stdoutSource.push(Buffer.from(`${frame}\n`));
      await expect(iterator.next()).resolves.toMatchObject({
        value: { text: frame, byteLength: 24 },
        done: false,
      });
      await expect(fixture.transport.send(`request-${index}`)).resolves.toEqual(
        { disposition: "sent" },
      );
    }
    for (let index = 0; index < 3; index += 1) {
      fixture.channel.stderrSource.push(Buffer.from("stderr-line-1234567\n"));
    }
    await waitFor(() => fixture.transport.diagnostics().stderrBytesRead === 60);

    expect(fixture.transport.diagnostics()).toMatchObject({
      stdoutBytesRead: 100,
      stderrBytesRead: 60,
      inboundFramesRead: 4,
      outboundFramesAccepted: 4,
      outboundFramesWritten: 4,
      stderrTailBytes: 16,
    });
    await fixture.transport.close("test_complete");
    await expect(fixture.transport.closed).resolves.toMatchObject({
      reason: "test_complete",
    });
  });

  it("keeps bounded retained state healthy past the former lifetime frame and stderr thresholds", async () => {
    const fixture = transportFixture({
      maximumFrameBytes: 64,
      maximumInboundQueueBytes: 64,
      maximumInboundQueueFrames: 1,
      maximumOutboundQueueBytes: 64,
      maximumOutboundQueueFrames: 1,
      maximumStderrTailBytes: 16,
    });
    const iterator = fixture.transport.frames[Symbol.asyncIterator]();
    const frames = 4_097;
    for (let index = 0; index < frames; index += 1) {
      fixture.channel.stdoutSource.push(Buffer.from("x\n"));
      await expect(iterator.next()).resolves.toMatchObject({
        value: { text: "x", byteLength: 1 },
        done: false,
      });
      await expect(fixture.transport.send("request")).resolves.toEqual({
        disposition: "sent",
      });
    }
    fixture.channel.stderrSource.push(
      Buffer.alloc(16 * 1_024 * 1_024 + 1, 0x65),
    );
    await waitFor(
      () =>
        fixture.transport.diagnostics().stderrBytesRead ===
        16 * 1_024 * 1_024 + 1,
    );

    const diagnostics = fixture.transport.diagnostics();
    expect(diagnostics).toMatchObject({
      stdoutBytesRead: frames * 2,
      stderrBytesRead: 16 * 1_024 * 1_024 + 1,
      inboundFramesRead: frames,
      outboundFramesAccepted: frames,
      outboundFramesWritten: frames,
    });
    expect(diagnostics.stderrTailBytes).toBeLessThanOrEqual(16);
    await fixture.transport.close("test_complete");
    await expect(fixture.transport.closed).resolves.toMatchObject({
      reason: "test_complete",
    });
  }, 15_000);

  it.each([
    ["frame count", { maximumInboundQueueFrames: 1 }, Buffer.from("a\nb\n")],
    [
      "byte count",
      { maximumFrameBytes: 2, maximumInboundQueueBytes: 2 },
      Buffer.from("aa\nbb\n"),
    ],
  ] as const)(
    "pauses the stdout producer at the inbound %s watermark",
    async (_label, limits, bytes) => {
      const fixture = transportFixture(limits);
      const iterator = fixture.transport.frames[Symbol.asyncIterator]();
      fixture.channel.stdoutSource.push(bytes);

      await expect(iterator.next()).resolves.toEqual({
        value: {
          text: _label === "frame count" ? "a" : "aa",
          byteLength: _label === "frame count" ? 1 : 2,
        },
        done: false,
      });
      await expect(iterator.next()).resolves.toEqual({
        value: {
          text: _label === "frame count" ? "b" : "bb",
          byteLength: _label === "frame count" ? 1 : 2,
        },
        done: false,
      });
      expect(fixture.transport.diagnostics()).toMatchObject({
        inboundFramesRead: 2,
      });
      await fixture.transport.close("test_complete");
    },
  );

  it("closes while the stdout producer is paused at the inbound watermark", async () => {
    const fixture = transportFixture({ maximumInboundQueueFrames: 1 });
    const iterator = fixture.transport.frames[Symbol.asyncIterator]();
    fixture.channel.stdoutSource.push(Buffer.from("a\nb\n"));
    await waitFor(
      () => fixture.transport.diagnostics().inboundFramesRead === 2,
    );

    await expect(
      Promise.race([
        fixture.transport.close("test_complete"),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("transport_close_deadline")), 250),
        ),
      ]),
    ).resolves.toBeUndefined();
    await expect(fixture.transport.closed).resolves.toMatchObject({
      reason: "test_complete",
    });
    await expect(iterator.next()).resolves.toEqual({
      value: { text: "a", byteLength: 1 },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it("rejects invalid and oversized frames while saturated sends wait until close", async () => {
    const fixture = transportFixture({
      maximumFrameBytes: 4,
      maximumOutboundQueueBytes: 8,
      maximumOutboundQueueFrames: 1,
    });
    fixture.channel.blockWrites = true;

    for (const invalidFrame of ["", "{}\n{}", "{}\r{}"] as const) {
      await expect(fixture.transport.send(invalidFrame)).rejects.toMatchObject({
        delivery: "not_sent",
        message: "test_transport_frame_invalid",
      });
    }
    await expect(fixture.transport.send("12345")).rejects.toMatchObject({
      delivery: "not_sent",
      message: "test_transport_outbound_limit",
    });
    const active = fixture.transport.send("1234");
    const queued = fixture.transport.send("1");
    const waiting = fixture.transport.send("2");

    const closing = fixture.transport.close("test_complete");
    await expect(active).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(queued).rejects.toMatchObject({ delivery: "not_sent" });
    await expect(waiting).rejects.toMatchObject({ delivery: "not_sent" });
    await closing;
  });

  it("classifies pre-admission and queued aborts as not sent", async () => {
    const fixture = transportFixture({ maximumOutboundQueueFrames: 1 });
    fixture.channel.blockWrites = true;
    const registrationRace = abortAtRegistrationSignal();
    await expect(
      fixture.transport.send("registration-race", {
        signal: registrationRace,
      }),
    ).rejects.toMatchObject({ delivery: "not_sent" });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("pre_admission_abort"));
    await expect(
      fixture.transport.send("{}", { signal: alreadyAborted.signal }),
    ).rejects.toMatchObject({ delivery: "not_sent" });

    const active = fixture.transport.send("active");
    const queuedAbort = new AbortController();
    const queued = fixture.transport.send("queued", {
      signal: queuedAbort.signal,
    });
    queuedAbort.abort(new Error("queued_abort"));
    await expect(queued).rejects.toMatchObject({ delivery: "not_sent" });
    const replacement = fixture.transport.send("replacement");

    const closing = fixture.transport.close("test_complete");
    await expect(active).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(replacement).rejects.toMatchObject({ delivery: "not_sent" });
    await closing;
  });

  it("backpressures an ordinary finite outbound burst and delivers it in order", async () => {
    const fixture = transportFixture({ maximumOutboundQueueFrames: 1 });
    fixture.channel.blockWrites = true;
    const first = fixture.transport.send("first");
    const second = fixture.transport.send("second");
    const third = fixture.transport.send("third");

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fixture.transport.diagnostics().outboundFramesAccepted).toBe(2);
    fixture.channel.releaseWrites();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { disposition: "sent" },
      { disposition: "sent" },
      { disposition: "sent" },
    ]);
    expect(fixture.transport.diagnostics()).toMatchObject({
      outboundFramesAccepted: 3,
      outboundFramesWritten: 3,
    });
    expect(fixture.channel.writtenStdin).toEqual([
      "first\n",
      "second\n",
      "third\n",
    ]);
    await fixture.transport.close("test_complete");
  });

  it.each(["not_sent", "sent_outcome_unknown"] as const)(
    "preserves lower-channel %s delivery classification",
    async (delivery) => {
      const fixture = transportFixture();
      fixture.channel.nextWriteError = new EnvironmentProcessWriteError(
        "lower_channel_write_failed",
        delivery,
      );

      await expect(fixture.transport.send("{}")).rejects.toEqual(
        expect.objectContaining<Partial<FrameWriteError>>({ delivery }),
      );
      await expect(fixture.transport.closed).resolves.toMatchObject({
        reason: "stdin_error",
      });
    },
  );

  it("bounds stderr, resynchronizes at newline, and keeps later safe lines", async () => {
    const fixture = transportFixture({ maximumStderrTailBytes: 24 });
    fixture.channel.stderrSource.push(Buffer.from("x".repeat(30)));
    fixture.channel.stderrSource.push(Buffer.from("discarded\nsafe-line\n"));
    await waitFor(() =>
      fixture.transport.diagnostics().stderrTail.includes("safe-line"),
    );

    const diagnostics = fixture.transport.diagnostics();
    expect(diagnostics.stderrTailBytes).toBeLessThanOrEqual(24);
    expect(diagnostics.stderrTail).toContain("[REDACTED]");
    expect(diagnostics.stderrTail).toContain("safe-line");
    expect(diagnostics.stderrTail).not.toContain("discarded");
    await fixture.transport.close("test_complete");
  });

  it("settles one closure and revokes assurance across a close/exit race", async () => {
    const fixture = transportFixture();
    const closing = fixture.transport.close("caller_close");
    fixture.channel.exit();

    await closing;
    await expect(fixture.transport.closed).resolves.toMatchObject({
      reason: "caller_close",
    });
    expect(fixture.channel.closeCalls).toBe(1);
    expect(isValidFramedTransportAssurance(fixture.transport.assurance)).toBe(
      false,
    );
  });

  it("drains final stdout and stderr before settling transport closure", async () => {
    const fixture = transportFixture();
    fixture.channel.finalStdout = Buffer.from("final-frame\n");
    fixture.channel.finalStderr = Buffer.from("final-stderr\n");
    const iterator = fixture.transport.frames[Symbol.asyncIterator]();

    await fixture.transport.close("caller_close");
    await fixture.transport.closed;
    expect(fixture.transport.diagnostics()).toMatchObject({
      stdoutBytesRead: 12,
      stderrBytesRead: 13,
      inboundFramesRead: 1,
      streamsDrained: true,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: { text: "final-frame", byteLength: 11 },
      done: false,
    });
  });

  it("settles and revokes an owned assurance when the channel closure rejects", async () => {
    const fixture = transportFixture();
    fixture.channel.failClosure(new Error("environment_channel_failed"));

    await expect(fixture.transport.closed).resolves.toMatchObject({
      reason: "process_exit",
      cause: expect.objectContaining({ message: "environment_channel_failed" }),
    });
    expect(isValidFramedTransportAssurance(fixture.transport.assurance)).toBe(
      false,
    );
  });

  it("rejects forged external assurance and revokes genuine assurance on rejected closure", async () => {
    let rejectClosed!: (error: Error) => void;
    const connection = {
      maximumFrameBytes: 128 * 1_024 * 1_024,
      frames: { [Symbol.asyncIterator]: async function* () {} },
      closed: new Promise<FramedTransportClosure>((_resolve, reject) => {
        rejectClosed = reject;
      }),
      send: async () => ({ disposition: "sent" as const }),
      closeClient: async () => undefined,
      destroyClient: () => undefined,
    };
    expect(() =>
      externalTransport(
        {} as PrivateUnixSocketAssurance,
        connection,
        "test_provider",
      ),
    ).toThrow("test_provider_external_transport_assurance_invalid");

    const identity = createEnvironmentPrivateUnixStreamIdentity({
      kind: "private_unix_stream",
      scope,
      channelId: "external-provider-transport-channel",
      socketIdentity: "external-provider-transport-socket",
      filesystemIdentity: {
        ownerVerified: true,
        parentMode: "0700",
        socketMode: "0600",
      },
    });
    const assurance = createPrivateUnixSocketAssurance(
      scope,
      1,
      identity,
      "test_provider",
    );
    const transport = externalTransport(assurance, connection, "test_provider");
    rejectClosed(new Error("external_closure_rejected"));
    await expect(transport.closed).rejects.toThrow("external_closure_rejected");
    expect(isValidFramedTransportAssurance(assurance)).toBe(false);
  });
});

describe("provider WebSocket frame limits", () => {
  it("uses the shared capacity for the frame and both byte watermarks", () => {
    expect(DEFAULT_WEBSOCKET_FRAMED_LIMITS).toMatchObject({
      maximumFrameBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
      maximumInboundQueueBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
      maximumOutboundQueueBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
    });
  });

  it.each(["maximumInboundQueueBytes", "maximumOutboundQueueBytes"] as const)(
    "rejects %s below the maximum frame",
    (watermark) => {
      expect(() =>
        resolveWebSocketFramedLimits(
          { maximumFrameBytes: 65, [watermark]: 64 },
          "test_websocket",
        ),
      ).toThrow("test_websocket_limits_invalid");
    },
  );
});

function transportFixture(overrides: Partial<OwnedNdjsonStdioLimits> = {}) {
  const channel = new FakeOwnedProcessChannel();
  const transport = new OwnedNdjsonStdioTransport({
    scope,
    connectionGeneration: 1,
    channel,
    limits: Object.freeze({ ...defaultLimits, ...overrides }),
    sensitiveValues: ["provider-secret"],
    assuranceDiagnosticPrefix: "test_provider",
    transportDiagnosticPrefix: "test_transport",
  });
  return { channel, transport };
}

class FakeOwnedProcessChannel implements EnvironmentOwnedProcessChannel {
  readonly identity = createEnvironmentOwnedProcessIdentity({
    kind: "owned_process",
    scope,
    channelId: "provider-transport-channel",
    executable: {
      kind: "executable",
      canonicalPath: "/usr/bin/provider-fixture",
    },
    providerProcessIdentity: {
      type: "local_process_group",
      processId: 44_444,
      processGroupId: 44_444,
    },
  });
  readonly stdoutSource = new AsyncByteSource();
  readonly stderrSource = new AsyncByteSource();
  readonly stdout = this.stdoutSource;
  readonly stderr = this.stderrSource;
  readonly closed: Promise<EnvironmentProcessClosure>;
  blockWrites = false;
  nextWriteError: Error | undefined;
  finalStdout: Uint8Array | undefined;
  finalStderr: Uint8Array | undefined;
  closeCalls = 0;
  readonly writtenStdin: string[] = [];
  #resolveClosed!: (closure: EnvironmentProcessClosure) => void;
  #rejectClosed!: (error: Error) => void;
  #closed = false;
  #blockedWrites: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }> = [];

  constructor() {
    this.closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
  }

  async writeStdin(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = undefined;
      throw error;
    }
    if (this.blockWrites) {
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(options?.signal?.reason);
        options?.signal?.addEventListener("abort", aborted, { once: true });
        this.#blockedWrites.push({ resolve, reject });
      });
    }
    this.writtenStdin.push(Buffer.from(bytes).toString("utf8"));
  }

  releaseWrites(): void {
    this.blockWrites = false;
    for (const blocked of this.#blockedWrites.splice(0)) blocked.resolve();
  }

  closeStdin(): void {}

  async close(_reason: string): Promise<void> {
    this.closeCalls += 1;
    for (const blocked of this.#blockedWrites.splice(0)) {
      blocked.reject(
        new EnvironmentProcessWriteError(
          "fake_channel_closed_during_write",
          "sent_outcome_unknown",
        ),
      );
    }
    if (this.finalStdout) this.stdoutSource.push(this.finalStdout);
    if (this.finalStderr) this.stderrSource.push(this.finalStderr);
    this.exit();
  }

  exit(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stdoutSource.end();
    this.stderrSource.end();
    this.#resolveClosed({
      reason: "exit",
      exitCode: 0,
      signal: null,
    });
  }

  failClosure(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stdoutSource.end();
    this.stderrSource.end();
    this.#rejectClosed(error);
  }
}

class AsyncByteSource implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  #ended = false;

  push(value: Uint8Array): void {
    if (this.#ended) throw new Error("async_byte_source_ended");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { value, done: false };
        if (this.#ended) return { value: undefined, done: true };
        return await new Promise<IteratorResult<Uint8Array>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("provider_transport_condition_not_observed");
}

function abortAtRegistrationSignal(): AbortSignal {
  let abortedReads = 0;
  return {
    get aborted() {
      abortedReads += 1;
      return abortedReads > 1;
    },
    reason: new Error("abort_at_registration"),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as AbortSignal;
}
