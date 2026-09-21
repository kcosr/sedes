import { describe, expect, it, vi } from "vitest";
import {
  CodexDaemonSupervisor,
  type CodexSupervisorClock,
  type CodexSupervisorRpcClient,
  type CodexSupervisorRpcFactory,
} from "../../src/server/backends/codex/codex-daemon-supervisor.js";
import {
  CODEX_RPC_UNDECODABLE_NOTIFICATION_CODE,
  defineCodexRpcMethod,
  type CodexRpcClosure,
  type CodexRpcMethod,
  type CodexRpcNotification,
  type CodexRpcRequestOptions,
  type CodexRpcRequestReceipt,
  type CodexServerRequestHandlers,
} from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import { CodexNativeStoreOwnershipGate } from "../../src/server/backends/codex/codex-native-store-ownership.js";
import {
  CodexRpcProtocolError,
  CodexRpcRemoteError,
} from "../../src/server/backends/codex/rpc/errors.js";
import {
  FramedTransportOpenError,
  createAuthenticatedTcpAssurance,
  createOwnedProcessAssurance,
  externalTransport,
  type ProviderTransportScope,
  type ExternalFramedConnection,
  type FramedMessageTransport,
  type FramedTransportFactory,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import {
  createEnvironmentAssuredTcpStreamIdentity,
  createEnvironmentOwnedProcessIdentity,
  createEnvironmentSecretIdentity,
  revokeEnvironmentAssuredTcpStreamIdentity,
} from "../../src/server/execution/environment-channel.js";
import { decodeCodexServerRequestParams } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import { SEDES_VERSION } from "../../src/shared/version.js";

const scope: ProviderTransportScope = {
  tenantId: "tenant-one",
  principalId: "principal-one",
  backendInstanceId: "codex-one",
  executionEnvironmentId: "environment-one",
};
const codexHome = "/srv/codex/principal-one";

function authenticatedTcpTransportFactory(
  openConnection: (
    generation: number,
  ) => ExternalFramedConnection | Promise<ExternalFramedConnection>,
): FramedTransportFactory {
  return {
    open: async (expectedScope, connectionGeneration) => {
      const connection = await openConnection(connectionGeneration);
      const authenticationIdentity = createEnvironmentSecretIdentity({
        kind: "environment_secret",
        scope: expectedScope,
        connectionGeneration,
        secretIdentity: `secret-${connectionGeneration}`,
      });
      const identity = createEnvironmentAssuredTcpStreamIdentity({
        kind: "assured_tcp_stream",
        scope: expectedScope,
        channelId: `channel-${connectionGeneration}`,
        connectionGeneration,
        authenticationIdentity,
        routeIdentity: `route-${connectionGeneration}`,
        transportSecurity: {
          type: "loopback_plaintext",
          loopbackVerified: true,
        },
      });
      const revokingConnection: ExternalFramedConnection = {
        maximumFrameBytes: 128 * 1_024 * 1_024,
        frames: connection.frames,
        closed: connection.closed,
        send: connection.send.bind(connection),
        closeClient: async (reason) => {
          try {
            await connection.closeClient(reason);
          } finally {
            revokeEnvironmentAssuredTcpStreamIdentity(identity);
          }
        },
        destroyClient: (reason) => {
          try {
            connection.destroyClient(reason);
          } finally {
            revokeEnvironmentAssuredTcpStreamIdentity(identity);
          }
        },
      };
      return externalTransport(
        createAuthenticatedTcpAssurance(
          expectedScope,
          connectionGeneration,
          identity,
          "codex",
        ),
        revokingConnection,
        "codex",
      );
    },
  };
}

const goodInitialize = {
  userAgent:
    `sedes_web/0.153.0 (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
  codexHome,
  platformFamily: "unix",
  platformOs: "linux",
};
type Script = {
  initialize?: unknown;
  initializeError?: Error;
  pendingMethods?: Set<string>;
  notificationDuringInitialize?: CodexRpcNotification;
  notificationsDuringInitialize?: CodexRpcNotification[];
  closeAfterInitialized?: boolean;
  closeError?: Error;
  blockClose?: boolean;
  blockInitialize?: boolean;
  wrapDecodeErrors?: boolean;
};

class FakeRpc implements CodexSupervisorRpcClient {
  readonly generation: number;
  readonly closed: Promise<CodexRpcClosure>;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly timeouts: Array<{ method: string; milliseconds: number }> = [];
  readonly handlers: CodexServerRequestHandlers;
  readonly script: Script;
  readonly #resolveClosed: (closure: CodexRpcClosure) => void;
  readonly #pending = new Map<
    string,
    Array<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }>
  >();
  #listener: ((notification: CodexRpcNotification) => void) | undefined;
  started = false;
  closedCount = 0;
  notified = false;

  constructor(
    generation: number,
    handlers: CodexServerRequestHandlers,
    script: Script,
  ) {
    this.generation = generation;
    this.handlers = handlers;
    this.script = script;
    let resolveClosed!: (closure: CodexRpcClosure) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  start(): void {
    expect(this.#listener).toBeDefined();
    this.started = true;
  }

  async request<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    options: CodexRpcRequestOptions,
  ): Promise<Result> {
    const encoded = specification.encodeParams(params);
    this.calls.push({ method: specification.method, params: encoded });
    this.timeouts.push({
      method: specification.method,
      milliseconds: options.timeoutMilliseconds,
    });
    if (options.signal?.aborted) throw options.signal.reason;
    if (specification.method === "initialize") {
      if (this.script.notificationDuringInitialize) {
        this.#listener?.(this.script.notificationDuringInitialize);
      }
      for (const notification of this.script.notificationsDuringInitialize ??
        []) {
        this.#listener?.(notification);
      }
      if (this.script.blockInitialize) {
        return await new Promise<Result>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      }
      if (this.script.initializeError) throw this.script.initializeError;
      try {
        return specification.decodeResult(
          this.script.initialize ?? goodInitialize,
        );
      } catch (error) {
        if (this.script.wrapDecodeErrors) {
          throw new CodexRpcProtocolError(
            "codex_rpc_response_schema_invalid",
            this.generation,
            { cause: error },
          );
        }
        throw error;
      }
    }
    if (this.script.pendingMethods?.has(specification.method)) {
      return await new Promise<Result>((resolve, reject) => {
        const pending = this.#pending.get(specification.method) ?? [];
        pending.push({ resolve: (value) => resolve(value as Result), reject });
        this.#pending.set(specification.method, pending);
      });
    }
    return specification.decodeResult({});
  }

  async requestWithReceipt<Params, Result>(
    specification: CodexRpcMethod<Params, Result>,
    params: Params,
    options: CodexRpcRequestOptions,
  ): Promise<CodexRpcRequestReceipt<Result>> {
    return {
      result: await this.request(specification, params, options),
      generation: this.generation,
      inboundSequence: this.calls.length,
    };
  }

  async notify(method: "initialized"): Promise<void> {
    expect(method).toBe("initialized");
    this.notified = true;
    if (this.script.closeAfterInitialized) {
      queueMicrotask(() => this.crash("immediate_close"));
    }
  }

  subscribeNotifications(
    listener: (notification: CodexRpcNotification) => void,
  ): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  emit(notification: CodexRpcNotification): void {
    this.#listener?.(notification);
  }

  completePending(method: string, value: unknown): void {
    const pending = this.#pending.get(method)?.shift();
    if (!pending) throw new Error("no_pending_rpc_request");
    pending.resolve(value);
  }

  crash(reason = "crash"): void {
    const error = new Error(reason);
    for (const pending of this.#pending.values()) {
      for (const request of pending) request.reject(error);
    }
    this.#pending.clear();
    this.#resolveClosed({
      generation: this.generation,
      reason,
      cause: error,
    });
  }

  async close(reason = "closed"): Promise<void> {
    this.closedCount += 1;
    this.crash(reason);
    if (this.script.blockClose) await new Promise<void>(() => undefined);
    if (this.script.closeError) throw this.script.closeError;
  }
}

class ManualClock implements CodexSupervisorClock {
  readonly sleeps: Array<{
    readonly milliseconds: number;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }> = [];

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const remove = () => {
        const index = this.sleeps.indexOf(entry);
        if (index >= 0) this.sleeps.splice(index, 1);
      };
      const entry = {
        milliseconds,
        resolve: () => {
          remove();
          resolve();
        },
        reject: (error: unknown) => {
          remove();
          reject(error);
        },
      };
      this.sleeps.push(entry);
      signal.addEventListener("abort", () => entry.reject(signal.reason), {
        once: true,
      });
    });
  }

  advance(milliseconds: number): void {
    const next = this.sleeps.find(
      (entry) => entry.milliseconds === milliseconds,
    );
    if (!next) throw new Error("no_pending_supervisor_sleep");
    next.resolve();
  }
}

function transportFactory(): FramedTransportFactory {
  let pid = 10_000;
  return {
    open: async (expectedScope, connectionGeneration) => {
      let close!: (closure: { reason: string }) => void;
      const closed = new Promise<{ reason: string }>((resolve) => {
        close = resolve;
      });
      return {
        maximumFrameBytes: 128 * 1_024 * 1_024,
        assurance: createOwnedProcessAssurance(
          expectedScope,
          connectionGeneration,
          createEnvironmentOwnedProcessIdentity({
            kind: "owned_process",
            scope: { ...expectedScope },
            channelId: `fake-${pid}`,
            executable: {
              kind: "executable",
              canonicalPath: "/usr/bin/codex",
            },
            providerProcessIdentity: {
              type: "local_process_group",
              processId: pid,
              processGroupId: pid++,
            },
          }),
          "codex",
        ),
        frames: {
          [Symbol.asyncIterator]: async function* () {},
        },
        closed,
        send: async () => ({ disposition: "sent" }),
        close: async (reason) => close({ reason }),
      } satisfies FramedMessageTransport;
    },
  };
}

function fixture(
  scripts: Script[],
  input?: {
    expectedCodexHome?: string | null;
    expectedRuntimeVersion?: string;
    maximumRestartAttempts?: number | "unbounded";
    useDefaultRestartDelays?: boolean;
    restartDelaysMilliseconds?: readonly number[];
    restartJitterRatio?: number;
    random?: () => number;
    stabilityResetMilliseconds?: number;
    initializationTimeoutMilliseconds?: number;
    shutdownTimeoutMilliseconds?: number;
    onError?: (error: unknown) => void;
    onRuntimeVersionAssessment?: (assessment: {
      readonly version: string;
      readonly newerThanTested: boolean;
    }) => void;
    transportFactory?: FramedTransportFactory;
  },
) {
  const rpcs: FakeRpc[] = [];
  const clock = new ManualClock();
  const ownership = new CodexNativeStoreOwnershipGate();
  const rpcFactory: CodexSupervisorRpcFactory = ({ generation, handlers }) => {
    const rpc = new FakeRpc(
      generation,
      handlers,
      scripts[generation - 1] ?? {},
    );
    rpcs.push(rpc);
    return rpc;
  };
  const supervisor = new CodexDaemonSupervisor({
    scope,
    ...(input?.expectedCodexHome === null
      ? {}
      : { expectedCodexHome: input?.expectedCodexHome ?? codexHome }),
    transportFactory: input?.transportFactory ?? transportFactory(),
    rpcFactory,
    clock,
    ...(input?.useDefaultRestartDelays
      ? {}
      : {
          restartDelaysMilliseconds: input?.restartDelaysMilliseconds ?? [
            1, 2, 3,
          ],
        }),
    restartJitterRatio: input?.restartJitterRatio,
    random: input?.random,
    maximumRestartAttempts: input?.maximumRestartAttempts ?? 3,
    stabilityResetMilliseconds: input?.stabilityResetMilliseconds ?? 30,
    initializationTimeoutMilliseconds: input?.initializationTimeoutMilliseconds,
    shutdownTimeoutMilliseconds: input?.shutdownTimeoutMilliseconds,
    nativeStoreOwnership: ownership,
    onError: input?.onError,
    onRuntimeVersionAssessment: input?.onRuntimeVersionAssessment,
    ...(input?.expectedRuntimeVersion
      ? { expectedRuntimeVersion: () => input.expectedRuntimeVersion }
      : {}),
  });
  return { supervisor, rpcs, clock, ownership };
}

const readMethod = defineCodexRpcMethod<void, { ok: true }>({
  method: "thread/list",
  encodeParams: () => ({}),
  decodeResult: () => ({ ok: true }),
});

describe("CodexDaemonSupervisor", () => {
  it("retires the last evicted conversation and restarts the same facade on demand", async () => {
    const { supervisor, rpcs, ownership } = fixture([{}, {}]);
    await supervisor.start();
    const client = supervisor.client;
    const first = client.residency!.retain();
    const last = client.residency!.retain();
    await first.release(true);
    expect(rpcs[0]!.closedCount).toBe(0);
    await last.release(true);
    expect(rpcs[0]!.closedCount).toBe(1);
    expect(supervisor.snapshot().state).toBe("idle");
    expect(ownership.snapshot().releaseSafety).toBe("safe");
    const reopened = client.residency!.retain();
    await Promise.all([
      client.request(readMethod, undefined, { timeoutMilliseconds: 100 }),
      client.request(readMethod, undefined, { timeoutMilliseconds: 100 }),
    ]);
    expect(rpcs).toHaveLength(2);
    expect(supervisor.client).toBe(client);
    expect(supervisor.snapshot()).toMatchObject({ state: "ready", generation: 2 });
    await reopened.release(true);
    await supervisor.close();
  });

  it("does not retire on ordinary handle release or wake after final shutdown", async () => {
    const { supervisor, rpcs } = fixture([{}]);
    await supervisor.start();
    await supervisor.client.residency!.retain().release();
    expect(rpcs[0]!.closedCount).toBe(0);
    await supervisor.close();
    await expect(supervisor.client.request(readMethod, undefined, { timeoutMilliseconds: 100 })).rejects.toThrow("codex_daemon_not_ready");
    expect(rpcs).toHaveLength(1);
  });

  it("installs safe handlers, buffers notifications, and becomes ready", async () => {
    const warning: CodexRpcNotification = {
      kind: "decoded_notification",
      generation: 1,
      sequence: 1,
      method: "warning",
      params: {},
    };
    const undecodable: CodexRpcNotification = {
      kind: "undecodable_notification",
      generation: 1,
      sequence: 2,
      method: "turn/started",
      nativeThreadId: "thread-safe",
      code: CODEX_RPC_UNDECODABLE_NOTIFICATION_CODE,
    };
    const { supervisor, rpcs } = fixture(
      [
        {
          notificationsDuringInitialize: [warning, undecodable],
        },
      ],
      {
        initializationTimeoutMilliseconds: 22_000,
      },
    );
    const notifications: CodexRpcNotification[] = [];
    supervisor.client.subscribeNotifications((value) => {
      notifications.push(value);
    });

    await supervisor.start();

    expect(Object.keys(rpcs[0]!.handlers)).toHaveLength(10);
    expect(rpcs[0]!.calls[0]).toEqual({
      method: "initialize",
      params: {
        clientInfo: {
          name: "sedes_web",
          title: "Sedes",
          version: SEDES_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
    expect(rpcs[0]!.calls[0]).not.toHaveProperty(
      "params.capabilities.extensions",
    );
    expect(rpcs[0]!.calls[0]).not.toHaveProperty(
      "params.capabilities.mcpServerOpenaiFormElicitation",
    );
    expect(rpcs[0]!.notified).toBe(true);
    expect(rpcs[0]!.calls).toHaveLength(1);
    expect(rpcs[0]!.timeouts).toEqual([
      { method: "initialize", milliseconds: 22_000 },
    ]);
    expect(supervisor.snapshot()).toMatchObject({
      state: "ready",
      generation: 1,
    });
    expect(notifications).toEqual([warning, undecodable]);
    await supervisor.close();
  });

  it("accepts additive initialize metadata from the exact generated release", async () => {
    const { supervisor } = fixture([
      {
        initialize: {
          ...goodInitialize,
          userAgent:
            `sedes_web/0.153.0 (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
          futureRuntimeMetadata: { revision: 2 },
        },
      },
    ]);

    await supervisor.start();

    expect(supervisor.snapshot()).toMatchObject({
      state: "ready",
      generation: 1,
    });
    await supervisor.close();
  });

  it("accepts the exact generated protocol baseline during initialization", async () => {
    const { supervisor } = fixture([{ initialize: goodInitialize }]);

    await supervisor.start();

    expect(supervisor.snapshot()).toMatchObject({
      state: "ready",
      generation: 1,
    });
    await supervisor.close();
  });

  it("accepts the exact supported release reported by an operator-started Codex TUI daemon", async () => {
    const { supervisor } = fixture([
      {
        initialize: {
          ...goodInitialize,
          userAgent:
            `codex-tui/0.153.0 (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
        },
      },
    ]);

    await supervisor.start();

    expect(supervisor.snapshot()).toMatchObject({
      state: "ready",
      generation: 1,
    });
    await supervisor.close();
  });

  it("accepts the historical external runtime prefix with the current Sedes client identity", async () => {
    const { supervisor } = fixture([
      {
        initialize: {
          ...goodInitialize,
          userAgent:
            `pi_web_harness/0.153.0 (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
        },
      },
    ]);

    await supervisor.start();

    expect(supervisor.snapshot()).toMatchObject({
      state: "ready",
      generation: 1,
    });
    await supervisor.close();
  });

  it.each([
    [
      "an unrelated runtime prefix",
      `unrelated-runtime/0.151.1 (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
    ],
    [
      "the historical client suffix",
      "pi_web_harness/0.151.1 (Ubuntu 26.4.0; x86_64) unknown (pi_web_harness; 0.1.0)",
    ],
  ])("rejects %s during initialization", async (_label, userAgent) => {
    const { supervisor } = fixture([
      { initialize: { ...goodInitialize, userAgent } },
    ]);

    await expect(supervisor.start()).rejects.toThrow(
      "codex_daemon_initialize_identity_mismatch",
    );
    expect(supervisor.snapshot()).toMatchObject({
      state: "circuit_open",
      lastFailure: "codex_daemon_initialize_identity_mismatch",
    });
  });

  it("accepts and assesses a newer stable external runtime", async () => {
    const onRuntimeVersionAssessment = vi.fn();
    const { supervisor } = fixture(
      [
        {
          initialize: {
            ...goodInitialize,
            userAgent:
              `sedes_web/0.155.0+vendor.1 (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
          },
        },
      ],
      { onRuntimeVersionAssessment },
    );

    await supervisor.start();

    expect(onRuntimeVersionAssessment).toHaveBeenCalledWith({
      version: "0.155.0+vendor.1",
      newerThanTested: true,
    });
    expect(supervisor.snapshot().state).toBe("ready");
    await supervisor.close();
  });

  it.each([
    ["0.153.0", "0.154.0"],
    ["0.154.0", "0.153.0"],
  ])(
    "rejects an owned runtime whose probed %s executable initializes as %s",
    async (expectedRuntimeVersion, initializedRuntimeVersion) => {
      const { supervisor } = fixture(
        [
          {
            initialize: {
              ...goodInitialize,
              userAgent: `sedes_web/${initializedRuntimeVersion} (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
            },
          },
        ],
        { expectedRuntimeVersion },
      );

      await expect(supervisor.start()).rejects.toThrow(
        "codex_daemon_initialize_identity_mismatch",
      );
      expect(supervisor.snapshot()).toMatchObject({
        state: "circuit_open",
        lastFailure: "codex_daemon_initialize_identity_mismatch",
      });
    },
  );

  it("matches an owned runtime by semantic precedence rather than build metadata", async () => {
    const { supervisor } = fixture([{ initialize: goodInitialize }], {
      expectedRuntimeVersion: "0.153.0+owned.1",
    });

    await supervisor.start();

    expect(supervisor.snapshot().state).toBe("ready");
    await supervisor.close();
  });

  it.each([
    [
      "malformed",
      `sedes_web/not-a-version (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
    ],
    [
      "unsupported older release",
      `sedes_web/0.145.9 (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
    ],
    [
      "unsupported patch release",
      `sedes_web/0.148.1 (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
    ],
    [
      "unsupported prerelease alias",
      `sedes_web/0.153.0-rc.1 (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
    ],
    [
      "unknown server product",
      `forged-server/0.153.0 (Ubuntu 26.4.0; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
    ],
  ])(
    "rejects a %s initialized runtime version on a replacement generation",
    async (_label, userAgent) => {
      const { supervisor, rpcs, clock } = fixture([
        {},
        {
          initialize: {
            ...goodInitialize,
            userAgent,
          },
        },
      ]);
      await supervisor.start();

      rpcs[0]!.crash("replacement_required");
      await waitFor(() => supervisor.snapshot().state === "backoff");
      clock.advance(1);
      await waitFor(() => supervisor.snapshot().state === "circuit_open");

      expect(rpcs).toHaveLength(2);
      expect(supervisor.snapshot()).toMatchObject({
        state: "circuit_open",
        generation: 2,
        lastFailure: "codex_daemon_initialize_identity_mismatch",
      });
      await supervisor.close();
    },
  );

  it("bounds consumed initialize identity fields while ignoring additive metadata", async () => {
    const oversizedUserAgent = fixture([
      {
        initialize: {
          ...goodInitialize,
          userAgent: "x".repeat(4 * 1024 + 1),
          futureRuntimeMetadata: true,
        },
      },
    ]);

    await expect(oversizedUserAgent.supervisor.start()).rejects.toThrow(
      "codex_daemon_initialize_response_invalid",
    );
    expect(oversizedUserAgent.supervisor.snapshot().state).toBe("circuit_open");
  });

  it("fails closed on a permanent initialize identity mismatch", async () => {
    const wrongHome = fixture([
      { initialize: { ...goodInitialize, codexHome: "/wrong" } },
    ]);
    await expect(wrongHome.supervisor.start()).rejects.toThrow(
      "codex_daemon_initialize_identity_mismatch",
    );
    expect(wrongHome.supervisor.snapshot().state).toBe("circuit_open");
    expect(wrongHome.rpcs[0]!.closedCount).toBeGreaterThan(0);
  });

  it("admits a reviewed macOS initialize identity", async () => {
    const { supervisor } = fixture([
      { initialize: { ...goodInitialize, platformOs: "macos" } },
    ]);

    await supervisor.start();
    expect(supervisor.snapshot().state).toBe("ready");
    await supervisor.close();
  });

  it.runIf(process.platform === "win32")(
    "admits an absolute native Windows Codex home",
    async () => {
      const windowsHome = "C:\\Users\\operator\\.codex";
      const { supervisor } = fixture(
        [
          {
            initialize: {
              ...goodInitialize,
              userAgent:
                `Codex Desktop/0.153.4 (Windows 10.0.26200; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
              codexHome: windowsHome,
              platformFamily: "windows",
              platformOs: "windows",
            },
          },
        ],
        { expectedCodexHome: windowsHome },
      );

      await supervisor.start();
      expect(supervisor.snapshot().state).toBe("ready");
      await supervisor.close();
    },
  );

  it("treats Codex home as informational when no expected home is configured", async () => {
    const { supervisor, rpcs, clock } = fixture(
      [
        { initialize: { ...goodInitialize, codexHome: "/srv/codex/first" } },
        {
          initialize: { ...goodInitialize, codexHome: "/srv/codex/replaced" },
        },
      ],
      { expectedCodexHome: null },
    );

    await supervisor.start();
    rpcs[0]!.crash("operator_replaced_external_runtime");
    await waitFor(() => supervisor.snapshot().state === "backoff");
    clock.advance(1);
    await waitFor(
      () =>
        supervisor.snapshot().state === "ready" &&
        supervisor.snapshot().generation === 2,
    );

    expect(rpcs).toHaveLength(2);
    await supervisor.close();
  });

  it("classifies wrapped schema failures and redacts remote failure messages", async () => {
    const wrapped = fixture([
      {},
      {
        initialize: {
          ...goodInitialize,
          platformOs: "unsupported",
        },
        wrapDecodeErrors: true,
      },
    ]);
    await wrapped.supervisor.start();
    wrapped.rpcs[0]!.crash();
    await waitFor(() => wrapped.supervisor.snapshot().state === "backoff");
    wrapped.clock.advance(1);
    await waitFor(() => wrapped.supervisor.snapshot().state === "circuit_open");
    expect(wrapped.rpcs).toHaveLength(2);
    expect(wrapped.supervisor.snapshot().lastFailure).toBe(
      "codex_daemon_initialize_response_invalid",
    );

    const remote = fixture([
      {
        initializeError: new CodexRpcRemoteError({
          code: -32_000,
          message: "provider-secret-must-not-reach-supervisor-state",
          generation: 1,
          method: "initialize",
        }),
      },
    ]);
    await expect(remote.supervisor.start()).rejects.toThrow(
      "codex_daemon_rpc_remote_error",
    );
    expect(remote.supervisor.snapshot().lastFailure).toBe(
      "codex_daemon_rpc_remote_error",
    );
  });

  it("retries a transport-classified replacement race during the initial connection", async () => {
    const delegate = transportFactory();
    let attempts = 0;
    const generations: number[] = [];
    const transientFactory: FramedTransportFactory = {
      open: async (expectedScope, connectionGeneration, signal) => {
        attempts += 1;
        generations.push(connectionGeneration);
        if (attempts === 1) {
          throw new FramedTransportOpenError(
            "codex_unix_websocket_unavailable",
            false,
          );
        }
        return delegate.open(expectedScope, connectionGeneration, signal);
      },
    };
    const { supervisor, rpcs, clock } = fixture([{}], {
      transportFactory: transientFactory,
    });

    await expect(supervisor.start()).rejects.toThrow(
      "codex_unix_websocket_unavailable",
    );
    expect(supervisor.snapshot()).toMatchObject({
      state: "backoff",
      generation: 1,
      lastFailure: "codex_unix_websocket_unavailable",
    });
    clock.advance(1);
    await waitFor(() => supervisor.snapshot().state === "ready");
    expect(attempts).toBe(2);
    expect(generations).toEqual([1, 2]);
    expect(rpcs).toHaveLength(1);
    await supervisor.close();
  });

  it("opens the circuit without retrying a terminal transport-open failure", async () => {
    const attempts: number[] = [];
    const terminalFactory: FramedTransportFactory = {
      open: async (_expectedScope, connectionGeneration) => {
        attempts.push(connectionGeneration);
        throw new FramedTransportOpenError(
          "codex_tcp_websocket_authentication_failed",
          true,
        );
      },
    };
    const { supervisor, clock } = fixture([], {
      transportFactory: terminalFactory,
      maximumRestartAttempts: "unbounded",
    });

    await expect(supervisor.start()).rejects.toThrow(
      "codex_tcp_websocket_authentication_failed",
    );
    expect(supervisor.snapshot()).toMatchObject({
      state: "circuit_open",
      generation: 1,
      restartAttempts: 0,
      lastFailure: "codex_tcp_websocket_authentication_failed",
    });
    expect(attempts).toEqual([1]);
    expect(clock.sleeps).toEqual([]);
    await supervisor.close();
  });

  it("uses capped exponential production defaults for replacement generations", async () => {
    const transient = new Error("retryable_open_failure");
    const current = fixture(
      [
        {},
        ...Array.from({ length: 8 }, () => ({ initializeError: transient })),
      ],
      {
        useDefaultRestartDelays: true,
        maximumRestartAttempts: "unbounded",
      },
    );
    await current.supervisor.start();
    current.rpcs[0]!.crash("retryable_connection_loss");

    const expectedDelays = [100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000];
    for (const [index, delay] of expectedDelays.entries()) {
      await waitFor(() =>
        current.clock.sleeps.some((entry) => entry.milliseconds === delay),
      );
      current.clock.advance(delay);
      await waitFor(
        () => current.supervisor.snapshot().generation === index + 2,
      );
    }

    expect(current.rpcs).toHaveLength(9);
    await waitFor(() => current.supervisor.snapshot().state === "backoff");
    expect(current.supervisor.snapshot()).toMatchObject({
      state: "backoff",
      generation: 9,
      restartAttempts: 9,
    });
    await current.supervisor.close();
  });

  it("bounds reconnect jitter without exceeding the configured delay cap", async () => {
    const samples = [0, 1, 1];
    const current = fixture(
      [
        {},
        { initializeError: new Error("transient-one") },
        { initializeError: new Error("transient-two") },
      ],
      {
        restartDelaysMilliseconds: [100, 200, 400],
        restartJitterRatio: 0.25,
        random: () => samples.shift() ?? 1,
        maximumRestartAttempts: "unbounded",
      },
    );
    await current.supervisor.start();
    current.rpcs[0]!.crash("retryable_connection_loss");

    await waitFor(() => current.clock.sleeps.length === 1);
    expect(current.clock.sleeps[0]!.milliseconds).toBe(75);
    current.clock.advance(75);
    await waitFor(() => current.clock.sleeps.length === 1);
    expect(current.clock.sleeps[0]!.milliseconds).toBe(250);
    current.clock.advance(250);
    await waitFor(() => current.clock.sleeps.length === 1);
    expect(current.clock.sleeps[0]!.milliseconds).toBe(400);
    expect(current.supervisor.snapshot().generation).toBe(3);
    await current.supervisor.close();
  });

  it("aborts an unbounded reconnect while sleeping and never opens a new generation", async () => {
    const current = fixture([{}], {
      maximumRestartAttempts: "unbounded",
    });
    await current.supervisor.start();
    current.rpcs[0]!.crash("retryable_connection_loss");
    await waitFor(() => current.clock.sleeps.length === 1);

    const firstClose = current.supervisor.close();
    expect(current.supervisor.close()).toBe(firstClose);
    await firstClose;

    expect(current.supervisor.snapshot()).toMatchObject({
      state: "closed",
      generation: 1,
      restartAttempts: 1,
    });
    expect(current.clock.sleeps).toEqual([]);
    expect(current.rpcs).toHaveLength(1);
  });

  it("keeps bounded-delay reconnect active with an unbounded attempt budget", async () => {
    const delegate = transportFactory();
    let attempts = 0;
    const recoveringFactory: FramedTransportFactory = {
      open: async (expectedScope, connectionGeneration, signal) => {
        attempts += 1;
        if (attempts <= 4) throw new Error("server_still_unavailable");
        return delegate.open(expectedScope, connectionGeneration, signal);
      },
    };
    const { supervisor, clock } = fixture([{}], {
      transportFactory: recoveringFactory,
      maximumRestartAttempts: "unbounded",
    });

    await expect(supervisor.start()).rejects.toThrow("codex_daemon_failure");
    for (const delay of [1, 2, 3, 3]) {
      clock.advance(delay);
      if (attempts < 5) {
        await waitFor(() => clock.sleeps.length === 1);
        expect(supervisor.snapshot().state).not.toBe("circuit_open");
      }
    }
    await waitFor(() => supervisor.snapshot().state === "ready");
    expect(attempts).toBe(5);
    await supervisor.close();
  });

  it("restarts without replay and rejects callbacks from the old generation", async () => {
    const { supervisor, rpcs, clock } = fixture([
      { pendingMethods: new Set(["thread/list"]) },
      {},
      {},
    ]);
    await supervisor.start();
    const pending = supervisor.client.request(readMethod, undefined, {
      timeoutMilliseconds: 1_000,
    });
    const oldHandler = rpcs[0]!.handlers["item/tool/call"]!;
    rpcs[0]!.crash();
    await expect(pending).rejects.toThrow("crash");
    await waitFor(() => supervisor.snapshot().state === "backoff");
    clock.advance(1);
    await waitFor(
      () =>
        supervisor.snapshot().generation === 2 &&
        supervisor.snapshot().state === "ready",
    );
    expect(supervisor.snapshot().state).toBe("ready");
    expect(
      rpcs[1]!.calls.filter((call) => call.method === "thread/list"),
    ).toHaveLength(0);
    await expect(
      oldHandler({
        generation: 1,
        sequence: 1,
        id: 1,
        method: "item/tool/call",
        params: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("codex_daemon_stale_generation");

    rpcs[1]!.crash("second_crash");
    await waitFor(() => supervisor.snapshot().state === "backoff");
    clock.advance(2);
    await waitFor(
      () =>
        supervisor.snapshot().generation === 3 &&
        supervisor.snapshot().state === "ready",
    );
    expect(supervisor.snapshot().state).toBe("ready");
    await supervisor.close();
  });

  it("emits only bounded machine closure evidence when delivery diagnostics are enabled", async () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { supervisor, rpcs } = fixture([{}]);
    try {
      await supervisor.start();
      rpcs[0]!.crash("provider detail with spaces: /private/path");
      await waitFor(() => supervisor.snapshot().state === "backoff");

      expect(logged).toHaveBeenCalledWith(
        "[delivery-lifecycle] phase=connection_closed generation=1 closure=unclassified cause=codex_daemon_failure",
      );
      expect(logged.mock.calls.flat().join(" ")).not.toContain("private/path");
    } finally {
      await supervisor.close();
      logged.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("retires an uncertain generation before replacement work can proceed", async () => {
    const { supervisor, rpcs, clock } = fixture([{}, {}]);
    await supervisor.start();

    await supervisor.client.retireGeneration(1, "codex_create_outcome_unknown");

    expect(rpcs[0]!.closedCount).toBe(1);
    expect(supervisor.snapshot()).toMatchObject({
      state: "backoff",
      generation: 1,
      lastFailure: "codex_create_outcome_unknown",
    });
    await expect(
      supervisor.client.request(readMethod, undefined, {
        timeoutMilliseconds: 1_000,
      }),
    ).rejects.toThrow("codex_daemon_not_ready");

    clock.advance(1);
    await waitFor(
      () =>
        supervisor.snapshot().state === "ready" &&
        supervisor.snapshot().generation === 2,
    );
    expect(rpcs).toHaveLength(2);
    await supervisor.close();
  });

  it("binds request ownership to one generation and aborts it on daemon loss", async () => {
    const { supervisor, rpcs } = fixture([{}]);
    await supervisor.start();
    let routedSignal: AbortSignal | undefined;
    supervisor.serverRequests.claimThread({
      generation: 1,
      nativeThreadId: "thread-1",
      owner: {
        owns: (route) =>
          route.nativeTurnId === "turn-1" && route.nativeItemId === "item-1",
        handle: (request) =>
          new Promise((_resolve, reject) => {
            routedSignal = request.signal;
            request.signal.addEventListener(
              "abort",
              () => reject(request.signal.reason),
              { once: true },
            );
          }),
      },
    });
    const pending = rpcs[0]!.handlers["item/commandExecution/requestApproval"]!(
      {
        generation: 1,
        sequence: 1,
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: decodeCodexServerRequestParams(
          "item/commandExecution/requestApproval",
          {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "item-1",
            startedAtMs: 1,
            environmentId: null,
          },
        ),
        signal: new AbortController().signal,
      },
    );
    await waitFor(() => routedSignal !== undefined);

    rpcs[0]!.crash("request_generation_lost");
    await expect(pending).rejects.toMatchObject({
      code: "request_generation_lost",
    });
    expect(routedSignal!.aborted).toBe(true);
    expect(supervisor.serverRequests.ownerCount()).toBe(0);
    await supervisor.close();
  });

  it.each([
    "orphaned_process_group",
    "process_cleanup_failed",
    "codex_rpc_transport_close_failed",
  ])("opens the circuit for unsafe transport cleanup: %s", async (reason) => {
    const onError = vi.fn();
    const { supervisor, rpcs, clock, ownership } = fixture([{}, {}], {
      onError,
    });
    await supervisor.start();
    rpcs[0]!.crash(reason);
    await waitFor(() => supervisor.snapshot().state === "circuit_open");
    expect(supervisor.snapshot()).toMatchObject({
      generation: 1,
      restartAttempts: 0,
      lastFailure: reason,
      cleanupUncertainty: reason,
    });
    expect(ownership.snapshot()).toEqual({
      state: "cleanup_failed",
      releaseSafety: "blocked",
      retentionReason: reason,
      cleanupUncertainty: reason,
    });
    expect(clock.sleeps).toHaveLength(0);
    expect(rpcs).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: reason }),
    );
    await expect(supervisor.close()).rejects.toMatchObject({
      name: "CodexNativeStoreRetentionError",
      retentionReason: reason,
      cleanupUncertainty: reason,
    });
    expect(supervisor.snapshot().state).toBe("closed");
  });

  it("publishes transport-neutral lifecycle and replacement generations", async () => {
    const { supervisor, rpcs, clock } = fixture([{}, {}]);
    const observed: Array<{ state: string; generation: number }> = [];
    const unsubscribe = supervisor.client.subscribeLifecycle((snapshot) => {
      observed.push(snapshot);
    });

    await supervisor.start();
    rpcs[0]!.crash();
    await waitFor(() => supervisor.snapshot().state === "backoff");
    clock.advance(1);
    await waitFor(() => supervisor.snapshot().state === "ready");
    await supervisor.close();
    unsubscribe();

    expect(observed).toEqual([
      { state: "unavailable", generation: 0 },
      { state: "starting", generation: 0 },
      { state: "starting", generation: 1 },
      { state: "ready", generation: 1 },
      { state: "unavailable", generation: 1 },
      { state: "reconciling", generation: 1 },
      { state: "reconciling", generation: 2 },
      { state: "ready", generation: 2 },
      { state: "closing", generation: 2 },
      { state: "closed", generation: 2 },
    ]);
  });

  it("isolates synchronous and asynchronous lifecycle listener failures", async () => {
    const onError = vi.fn();
    const current = {
      generation: 1,
      request: vi.fn(),
      requestWithReceipt: vi.fn(),
    };
    const { CodexSharedClientFacade } =
      await import("../../src/server/backends/codex/codex-client-facade.js");
    const facade = new CodexSharedClientFacade({
      current: () => current,
      latestGeneration: () => 1,
      retireGeneration: async () => undefined,
      onListenerError: onError,
    });

    expect(() =>
      facade.subscribeLifecycle(() => {
        throw new Error("synchronous-lifecycle-listener-failure");
      }),
    ).not.toThrow();
    facade.subscribeLifecycle(async () => {
      throw new Error("asynchronous-lifecycle-listener-failure");
    });
    expect(() =>
      facade.updateLifecycle({ state: "ready", generation: 1 }),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "synchronous-lifecycle-listener-failure",
      }),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "codex_lifecycle_listener_must_be_synchronous",
      }),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "asynchronous-lifecycle-listener-failure",
      }),
    );
  });

  it("allows preflight failure release but retains after launch without close proof", async () => {
    const preflight = fixture([], {
      transportFactory: {
        open: async () => {
          throw new Error("preflight-failure");
        },
      },
    });
    await expect(preflight.supervisor.start()).rejects.toThrow(
      "codex_daemon_failure",
    );
    await expect(preflight.supervisor.close()).resolves.toBeUndefined();
    expect(preflight.ownership.snapshot()).toEqual({
      state: "prelaunch",
      releaseSafety: "safe",
    });

    const launched = fixture([], {
      transportFactory: {
        open: async (_scope, _generation, _signal, lifecycle) => {
          lifecycle!.launchStarted();
          throw new Error("open-failed-after-launch");
        },
      },
    });
    await expect(launched.supervisor.start()).rejects.toThrow(
      "codex_daemon_failure",
    );
    await expect(launched.supervisor.close()).rejects.toMatchObject({
      name: "CodexNativeStoreRetentionError",
      retentionReason: "codex_daemon_cleanup_unproven",
    });
    expect(launched.ownership.snapshot()).toEqual({
      state: "launch_armed",
      releaseSafety: "blocked",
      retentionReason: "codex_daemon_cleanup_unproven",
    });
  });

  it("retains ownership after every close rejection, including unknown errors", async () => {
    const onError = vi.fn();
    const failed = fixture([{ closeError: new Error("secret-close-error") }], {
      onError,
    });
    await failed.supervisor.start();

    await expect(failed.supervisor.close()).rejects.toThrow(
      "codex_daemon_cleanup_unproven",
    );
    expect(failed.ownership.snapshot()).toEqual({
      state: "cleanup_failed",
      releaseSafety: "blocked",
      retentionReason: "codex_daemon_cleanup_unproven",
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "codex_daemon_failure" }),
    );
  });

  it("bounds a stuck RPC close and retains the owned native-store lock", async () => {
    const blocked = fixture([{ blockClose: true }], {
      shutdownTimeoutMilliseconds: 10,
    });
    await blocked.supervisor.start();

    await expect(blocked.supervisor.close()).rejects.toThrow(
      "codex_daemon_cleanup_unproven",
    );
    expect(blocked.supervisor.snapshot().state).toBe("closed");
    expect(blocked.ownership.snapshot()).toEqual({
      state: "cleanup_failed",
      releaseSafety: "blocked",
      retentionReason: "codex_daemon_cleanup_unproven",
    });
  });

  it("closes only an external client and never claims owned-server cleanup", async () => {
    const closeClient = vi.fn(async () => undefined);
    const destroyClient = vi.fn();
    const serverStop = vi.fn();
    const transportFactory = authenticatedTcpTransportFactory(async () => ({
      maximumFrameBytes: 128 * 1_024 * 1_024,
      frames: { [Symbol.asyncIterator]: async function* () {} },
      closed: new Promise(() => undefined),
      send: async () => ({ disposition: "sent" as const }),
      closeClient,
      destroyClient,
    }));
    const rpcFactory: CodexSupervisorRpcFactory = ({
      generation,
      handlers,
      transport,
    }) => {
      const rpc = new FakeRpc(generation, handlers, {});
      const closeRpc = rpc.close.bind(rpc);
      vi.spyOn(rpc, "close").mockImplementation(async (reason) => {
        await closeRpc(reason);
        await transport.close(reason ?? "closed");
      });
      return rpc;
    };
    const supervisor = new CodexDaemonSupervisor({
      scope,
      expectedCodexHome: codexHome,
      transportFactory,
      rpcFactory,
    });

    await supervisor.start();
    await supervisor.close();
    expect(closeClient).toHaveBeenCalledOnce();
    expect(destroyClient).not.toHaveBeenCalled();
    expect(serverStop).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).not.toHaveProperty("cleanupUncertainty");
  });

  it("retries after a transient externally owned client cleanup failure", async () => {
    const clock = new ManualClock();
    const rpcs: FakeRpc[] = [];
    let connections = 0;
    let clientCloses = 0;
    const externalFactory = authenticatedTcpTransportFactory(async () => {
      connections += 1;
      return {
        maximumFrameBytes: 128 * 1_024 * 1_024,
        frames: { [Symbol.asyncIterator]: async function* () {} },
        closed: new Promise(() => undefined),
        send: async () => ({ disposition: "sent" as const }),
        closeClient: async () => {
          clientCloses += 1;
          if (clientCloses === 1) {
            throw new Error("temporary_client_close_failure");
          }
        },
        destroyClient: vi.fn(),
      };
    });
    const supervisor = new CodexDaemonSupervisor({
      scope,
      expectedCodexHome: codexHome,
      transportFactory: externalFactory,
      rpcFactory: ({ generation, handlers, transport }) => {
        const rpc = new FakeRpc(generation, handlers, {});
        const closeRpc = rpc.close.bind(rpc);
        vi.spyOn(rpc, "close").mockImplementation(async (reason) => {
          await closeRpc(reason);
          await transport.close(reason ?? "closed");
        });
        rpcs.push(rpc);
        return rpc;
      },
      clock,
      restartDelaysMilliseconds: [1],
    });

    await supervisor.start();
    await expect(
      supervisor.client.retireGeneration(
        1,
        "codex_generation_retired_for_test",
      ),
    ).rejects.toThrow("codex_external_client_cleanup_failed");
    await waitFor(
      () =>
        supervisor.snapshot().state === "backoff" && clock.sleeps.length === 1,
    );
    expect(supervisor.snapshot().lastFailure).toBe(
      "codex_external_client_cleanup_failed",
    );
    clock.advance(1);
    await waitFor(() => supervisor.snapshot().state === "ready");
    expect(connections).toBe(2);
    expect(rpcs).toHaveLength(2);
    await supervisor.close();
  });

  it("keeps the same ready generation across logout and account replacement", async () => {
    const { supervisor, rpcs } = fixture([
      { pendingMethods: new Set(["thread/list"]) },
    ]);
    await supervisor.start();
    const inFlightRead = supervisor.client.request(readMethod, undefined, {
      timeoutMilliseconds: 1_000,
    });
    rpcs[0]!.emit({
      kind: "decoded_notification",
      generation: 1,
      sequence: 2,
      method: "account/updated",
      params: { authMode: null },
    });
    expect(supervisor.snapshot()).toMatchObject({
      state: "ready",
      generation: 1,
    });
    rpcs[0]!.completePending("thread/list", { ok: true });
    await expect(inFlightRead).resolves.toEqual({ ok: true });
    rpcs[0]!.emit({
      kind: "decoded_notification",
      generation: 1,
      sequence: 3,
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    expect(supervisor.snapshot()).toMatchObject({
      state: "ready",
      generation: 1,
    });
    expect(rpcs).toHaveLength(1);
    rpcs[0]!.script.pendingMethods?.delete("thread/list");
    await expect(
      supervisor.client.request(readMethod, undefined, {
        timeoutMilliseconds: 1_000,
      }),
    ).resolves.toEqual({ ok: true });
    await supervisor.close();
  });

  it("opens the circuit after its rapid replacement budget and closes during backoff", async () => {
    const budget = fixture(
      [
        {},
        { initializeError: new Error("transient-one") },
        { initializeError: new Error("transient-two") },
      ],
      { maximumRestartAttempts: 2 },
    );
    await budget.supervisor.start();
    budget.rpcs[0]!.crash();
    await waitFor(() => budget.clock.sleeps.length === 1);
    budget.clock.advance(1);
    await waitFor(() => budget.clock.sleeps.length === 1);
    budget.clock.advance(2);
    await waitFor(() => budget.supervisor.snapshot().state === "circuit_open");
    expect(budget.supervisor.snapshot().restartAttempts).toBe(2);

    const closing = fixture([{}]);
    await closing.supervisor.start();
    closing.rpcs[0]!.crash();
    await waitFor(() => closing.clock.sleeps.length === 1);
    const firstClose = closing.supervisor.close();
    const secondClose = closing.supervisor.close();
    expect(firstClose).toBe(secondClose);
    await firstClose;
    expect(closing.supervisor.snapshot().state).toBe("closed");
    expect(closing.rpcs).toHaveLength(1);
  });

  it("recovers an immediately closed replacement and resets budget after stability", async () => {
    const immediate = fixture([{}, { closeAfterInitialized: true }, {}]);
    await immediate.supervisor.start();
    immediate.rpcs[0]!.crash();
    await waitFor(() =>
      immediate.clock.sleeps.some((entry) => entry.milliseconds === 1),
    );
    immediate.clock.advance(1);
    await waitFor(
      () =>
        immediate.supervisor.snapshot().state === "backoff" &&
        immediate.supervisor.snapshot().generation === 2,
    );
    await waitFor(() =>
      immediate.clock.sleeps.some((entry) => entry.milliseconds === 2),
    );
    immediate.clock.advance(2);
    await waitFor(
      () =>
        immediate.supervisor.snapshot().state === "ready" &&
        immediate.supervisor.snapshot().generation === 3,
    );

    const stable = fixture([{}, {}, {}], {
      maximumRestartAttempts: 1,
      stabilityResetMilliseconds: 30,
    });
    await stable.supervisor.start();
    stable.rpcs[0]!.crash();
    await waitFor(() =>
      stable.clock.sleeps.some((entry) => entry.milliseconds === 1),
    );
    stable.clock.advance(1);
    await waitFor(() => stable.supervisor.snapshot().state === "ready");
    expect(stable.supervisor.snapshot().restartAttempts).toBe(1);
    stable.clock.advance(30);
    await waitFor(() => stable.supervisor.snapshot().restartAttempts === 0);
    stable.rpcs[1]!.crash();
    await waitFor(() => stable.supervisor.snapshot().state === "backoff");
    stable.clock.advance(1);
    await waitFor(
      () =>
        stable.supervisor.snapshot().state === "ready" &&
        stable.supervisor.snapshot().generation === 3,
    );
  });

  it("isolates throwing and rejecting error observers from restart lifecycle", async () => {
    const onError = vi
      .fn<(error: unknown) => void | Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error("synchronous-observer-failure");
      })
      .mockImplementationOnce(async () => {
        throw new Error("asynchronous-observer-failure");
      });
    const observed = fixture(
      [
        {},
        {
          initializeError: new Error("unredacted-provider-failure"),
        },
        {},
      ],
      { onError },
    );
    await observed.supervisor.start();
    observed.rpcs[0]!.crash();
    await waitFor(() => observed.supervisor.snapshot().state === "backoff");
    observed.clock.advance(1);
    await waitFor(() =>
      observed.clock.sleeps.some((entry) => entry.milliseconds === 2),
    );
    expect(observed.supervisor.snapshot().lastFailure).toBe(
      "codex_daemon_failure",
    );
    observed.clock.advance(2);
    await waitFor(
      () =>
        observed.supervisor.snapshot().state === "ready" &&
        observed.supervisor.snapshot().generation === 3,
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "codex_daemon_failure" }),
    );
    await Promise.resolve();
  });

  it("observes accidental async notification listeners", async () => {
    const onError = vi.fn();
    const current = {
      generation: 1,
      request: vi.fn(),
      requestWithReceipt: vi.fn(),
    };
    const { CodexSharedClientFacade } =
      await import("../../src/server/backends/codex/codex-client-facade.js");
    const facade = new CodexSharedClientFacade({
      current: () => current,
      latestGeneration: () => 1,
      retireGeneration: async () => undefined,
      onListenerError: onError,
    });
    facade.subscribeNotifications(async () => undefined);
    facade.forwardNotification(1, {
      kind: "decoded_notification",
      generation: 1,
      sequence: 1,
      method: "warning",
      params: {},
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "codex_notification_listener_must_be_synchronous",
      }),
    );
  });

  it("snapshots notification subscribers before delivery", async () => {
    const current = {
      generation: 1,
      request: vi.fn(),
      requestWithReceipt: vi.fn(),
    };
    const { CodexSharedClientFacade } =
      await import("../../src/server/backends/codex/codex-client-facade.js");
    const facade = new CodexSharedClientFacade({
      current: () => current,
      latestGeneration: () => 1,
      retireGeneration: async () => undefined,
    });
    const late = vi.fn();
    facade.subscribeNotifications(() => {
      facade.subscribeNotifications(late);
    });
    const notification: CodexRpcNotification = {
      kind: "decoded_notification",
      generation: 1,
      sequence: 1,
      method: "warning",
      params: {},
    };
    facade.forwardNotification(1, notification);
    expect(late).not.toHaveBeenCalled();
    facade.forwardNotification(1, { ...notification, sequence: 2 });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("fails closed on notification overflow and closes safely during initial start", async () => {
    const overflow = fixture([
      {
        notificationsDuringInitialize: Array.from(
          { length: 257 },
          (_, index) => ({
            kind: "decoded_notification" as const,
            generation: 1,
            sequence: index + 1,
            method: "warning" as const,
            params: {},
          }),
        ),
      },
    ]);
    await expect(overflow.supervisor.start()).rejects.toThrow(
      "codex_daemon_notification_buffer_limit",
    );
    expect(overflow.supervisor.snapshot().state).toBe("circuit_open");

    const onError = vi.fn();
    const byteOverflow = fixture(
      [
        {
          closeError: new Error("unredacted-close-error"),
          notificationsDuringInitialize: Array.from(
            { length: 65 },
            (_, index) => ({
              kind: "decoded_notification" as const,
              generation: 1,
              sequence: index + 1,
              method: "warning" as const,
              params: { message: "x".repeat(64 * 1_024) },
            }),
          ),
        },
      ],
      { onError },
    );
    await expect(byteOverflow.supervisor.start()).rejects.toThrow(
      "codex_daemon_cleanup_unproven",
    );
    expect(byteOverflow.rpcs[0]!.closedCount).toBe(1);
    expect(byteOverflow.supervisor.snapshot()).toMatchObject({
      state: "circuit_open",
      lastFailure: "codex_daemon_cleanup_unproven",
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "codex_daemon_notification_buffer_limit",
      }),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "codex_daemon_failure" }),
    );

    const race = fixture([{ blockInitialize: true }]);
    const starting = race.supervisor.start();
    await waitFor(() => race.rpcs.length === 1);
    const closing = race.supervisor.close();
    await expect(starting).rejects.toThrow("codex_daemon_supervisor_closed");
    await closing;
    expect(race.supervisor.snapshot().state).toBe("closed");
    expect(race.rpcs[0]!.closedCount).toBeGreaterThan(0);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("supervisor_condition_not_reached");
}
