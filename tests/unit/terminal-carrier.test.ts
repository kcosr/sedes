import express from "express";
import request from "supertest";
import { createTerminalRouter } from "../../src/server/terminals/terminal-http.js";
import { errorMiddleware } from "../../src/server/http/errors.js";
import type { AuthenticationAdmission } from "../../src/server/authentication/authentication-admission.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_WEBSOCKET_PATH,
  TERMINAL_WEBSOCKET_PROTOCOL,
  encodeTerminalBinaryFrame,
  type TerminalClientFrame,
  type TerminalServerFrame,
} from "../../src/shared/protocol/terminals.js";
import type { AppConfig } from "../../src/server/config/config.js";
import type {
  IdentityProvider,
  RequestScope,
} from "../../src/server/identity/identity-provider.js";
import { LongLivedHttpConnectionRegistry } from "../../src/server/runtime/application-shutdown.js";
import {
  TerminalAdmissionTokens,
  attachTerminalCarrier,
} from "../../src/server/terminals/terminal-carrier.js";
import type {
  TerminalService,
} from "../../src/server/terminals/terminal-service.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const terminalId = "11111111-1111-4111-8111-111111111111";
const incarnationId = "22222222-2222-4222-8222-222222222222";
const producerId = "33333333-3333-4333-8333-333333333333";
const config: AppConfig = { authenticationRequired: true, experimentalUsageEnabled: false,
  host: "127.0.0.1",
  port: 4783,
  stateDirectory: "/tmp/sedes-terminal-carrier-test",
  allowedTailscaleHosts: [],
  packagedClientOrigins: [],
        conversationRetentionMilliseconds: 600_000,
        conversationRuntimeBudget: 8,
};

class FixedIdentity implements IdentityProvider<IncomingMessage> {
  async resolve(): Promise<RequestScope> {
    return scope;
  }
}

class FakeTerminalService {
  readonly dispatch = vi.fn(async (_frame: TerminalClientFrame) => undefined);
  readonly closeViewer = vi.fn();
  readonly attach = vi.fn(async (input: {
    readonly emit: (frame: TerminalServerFrame) => void;
  }) => {
    this.emit = input.emit;
    return { dispatch: this.dispatch, close: this.closeViewer };
  });
  emit: ((frame: TerminalServerFrame) => void) | undefined;

  get() {
    return { terminalId, incarnationId, lifecycle: "running" as const };
  }
}

interface Fixture {
  readonly server: Server;
  readonly service: FakeTerminalService;
  readonly admissions: TerminalAdmissionTokens;
  readonly carrier: { close(): Promise<void> };
  readonly connections: LongLivedHttpConnectionRegistry;
  readonly baseUrl: string;
  readonly wsUrl: string;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    fixtures.splice(0).map(async ({ server, carrier }) => {
      await carrier.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }),
  );
});

describe("application terminal carrier", () => {
  it("skips credential authority when disabled but retains origin and one-time ticket admission", async () => {
    const unexpected = vi.fn(() => { throw new Error("credential_checks_must_be_disabled"); });
    const authentication = {
      required: false,
      clientForRequest: unexpected,
      bindTicket: unexpected,
      consumeTicket: unexpected,
      trackClient: unexpected,
    } as unknown as AuthenticationAdmission;
    const fixture = await createFixture(config, authentication);
    const response = await request(fixture.server)
      .post(`/api/terminals/${terminalId}/admissions`)
      .set("Authorization", "Bearer stale-invalid-credential")
      .send({ producerId, requestedRole: "controller",
        emulator: { family: "ghostty-web", version: "0.4.0", unicodeVersion: "11", restoreFormat: "ansi-checkpoint-v1" },
        restore: { kind: "checkpoint" } }).expect(201);
    const token = response.body.token as string;
    await expect(open(fixture, token, undefined, { origin: "https://attacker.test" })).rejects.toThrow("403");
    const viewer = await open(fixture, token);
    await waitFor(() => fixture.service.attach.mock.calls.length === 1);
    viewer.close();
    await expect(open(fixture, token)).rejects.toThrow("403");
    await expect(open(fixture, "x".repeat(43))).rejects.toThrow("403");
    expect(fixture.service.attach).toHaveBeenCalledTimes(1);
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("requires a credential-bound ticket and closes the viewer on credential revocation", async () => {
    let revoke: (() => void) | undefined;
    const bindTicket = vi.fn();
    const consumeTicket = vi.fn(() => ({ id: "paired-client" }));
    const untrack = vi.fn();
    const authentication = {
      required: true,
      clientForRequest: () => ({ id: "paired-client" }),
      bindTicket,
      consumeTicket,
      trackClient: vi.fn((_id: string, close: () => void) => { revoke = close; return untrack; }),
    } as unknown as AuthenticationAdmission;
    const fixture = await createFixture(config, authentication);
    const token = issue(fixture);
    const viewer = await open(fixture, token);
    await waitFor(() => fixture.service.attach.mock.calls.length === 1);
    expect(consumeTicket).toHaveBeenCalledWith(token);
    const closed = new Promise<void>((resolve) => viewer.once("close", () => resolve()));
    revoke!();
    await closed;
    expect(fixture.service.closeViewer).toHaveBeenCalledOnce();
    expect(untrack).toHaveBeenCalledOnce();
    consumeTicket.mockImplementationOnce(() => { throw new Error("authentication_required"); });
    const rejectedToken = issue(fixture);
    await expect(open(fixture, rejectedToken)).rejects.toThrow("403");
    expect(fixture.service.attach).toHaveBeenCalledTimes(1);
  });

  it("does not attach if the credential is revoked while the upgrade is completing", async () => {
    const authentication = {
      required: true,
      clientForRequest: () => ({ id: "paired-client" }),
      bindTicket: vi.fn(),
      consumeTicket: () => ({ id: "paired-client" }),
      trackClient: (_id: string, close: () => void) => { close(); return () => undefined; },
    } as unknown as AuthenticationAdmission;
    const fixture = await createFixture(config, authentication);
    const token = issue(fixture);
    const viewer = await open(fixture, token);
    await new Promise<void>((resolve) => viewer.once("close", () => resolve()));
    expect(fixture.service.attach).not.toHaveBeenCalled();
  });

  it("admits an exact trusted-LAN Host for an enabled packaged client", async () => {
    const trusted = await createFixture({
      ...config,
      host: "0.0.0.0",
      trustedLanHost: "192.168.50.51",
      packagedClientOrigins: ["http://localhost"],
    });
    const trustedToken = issue(trusted);
    const viewer = await open(trusted, trustedToken, undefined, {
      host: "192.168.50.51",
      origin: "http://localhost",
      fetchSite: "cross-site",
    });
    expect(viewer.protocol).toBe(TERMINAL_WEBSOCKET_PROTOCOL);
    viewer.close();
  });

  it("denies a hostile Origin before consuming admission", async () => {
    const fixture = await createFixture();
    const token = issue(fixture);
    await expect(
      open(fixture, token, [TERMINAL_WEBSOCKET_PROTOCOL, token], {
        origin: "https://attacker.test",
      }),
    ).rejects.toThrow(/Unexpected server response: 403/);
    const viewer = await open(fixture, token);
    expect(viewer.protocol).toBe(TERMINAL_WEBSOCKET_PROTOCOL);
    viewer.close();
  });

  it("requires the exact protocol-token pair and consumes it across concurrent upgrades", async () => {
    const fixture = await createFixture();
    const missingProtocol = issue(fixture);
    await expect(open(fixture, missingProtocol, [missingProtocol])).rejects.toThrow(
      /Unexpected server response: 403/,
    );
    const invalidProtocol = issue(fixture);
    await expect(
      open(fixture, invalidProtocol, ["sedes.wrong.v1", invalidProtocol]),
    ).rejects.toThrow(/Unexpected server response: 403/);

    const token = issue(fixture);
    const attempts = await Promise.allSettled([
      open(fixture, token),
      open(fixture, token),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    for (const attempt of attempts) {
      if (attempt.status === "fulfilled") attempt.value.close();
    }
  });

  it("closes an upgraded viewer cleanly when attach throws synchronously", async () => {
    const fixture = await createFixture();
    fixture.service.attach.mockImplementationOnce(() => {
      throw new Error("terminal_disappeared_during_upgrade");
    });

    const viewer = await open(fixture, issue(fixture));
    await expect(nextClose(viewer)).resolves.toEqual({
      code: 1008,
      reason: "terminal_unavailable",
    });
  });

  it("rejects terminal input carried as text JSON", async () => {
    const fixture = await createFixture();
    const viewer = await open(fixture, issue(fixture));
    await waitFor(() => fixture.service.attach.mock.calls.length === 1);
    const closed = nextClose(viewer);
    viewer.send(JSON.stringify({
      v: 2,
      type: "input",
      terminalId,
      incarnationId,
      controllerEpoch: 1,
      producerId,
      inputSeq: 1,
      data: Buffer.from("unsafe text input").toString("base64url"),
    }));
    await expect(closed).resolves.toMatchObject({ code: 1008 });
    expect(fixture.service.dispatch).not.toHaveBeenCalled();
  });

  it("waits for viewer attachment before dispatching an early valid frame", async () => {
    const fixture = await createFixture();
    const attachment = deferred<void>();
    fixture.service.attach.mockImplementationOnce(async (input) => {
      fixture.service.emit = input.emit;
      await attachment.promise;
      return {
        dispatch: fixture.service.dispatch,
        close: fixture.service.closeViewer,
      };
    });
    const viewer = await open(fixture, issue(fixture));
    viewer.send(JSON.stringify({
      v: 2,
      type: "claim_control",
      terminalId,
      incarnationId,
    }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(viewer.readyState).toBe(WebSocket.OPEN);
    expect(fixture.service.dispatch).not.toHaveBeenCalled();

    attachment.resolve();
    await waitFor(() => fixture.service.dispatch.mock.calls.length === 1);
    expect(fixture.service.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "claim_control",
    }));
    expect(viewer.readyState).toBe(WebSocket.OPEN);
    viewer.close();
  });

  it("coalesces one replay window of cumulative output acknowledgements", async () => {
    const fixture = await createFixture();
    const viewer = await open(fixture, issue(fixture));
    await waitFor(() => fixture.service.attach.mock.calls.length === 1);
    const socket = (viewer as unknown as {
      _socket: { cork(): void; uncork(): void };
    })._socket;

    socket.cork();
    for (let appliedSeq = 1; appliedSeq <= 64; appliedSeq += 1) {
      viewer.send(JSON.stringify({
        v: 2,
        type: "ack_output",
        terminalId,
        incarnationId,
        appliedSeq,
      }));
    }
    socket.uncork();

    await waitFor(() => fixture.service.dispatch.mock.calls.some(
      ([frame]) => frame.type === "ack_output" && frame.appliedSeq === 64,
    ));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(viewer.readyState).toBe(WebSocket.OPEN);
    expect(fixture.service.dispatch.mock.calls.length).toBeLessThan(64);
    viewer.close();
  });

  it("drops a pending output acknowledgement when viewer attachment fails", async () => {
    const fixture = await createFixture();
    const attachment = deferred<void>();
    fixture.service.attach.mockImplementationOnce(async (input) => {
      fixture.service.emit = input.emit;
      await attachment.promise;
      throw new Error("terminal_unavailable");
    });
    const viewer = await open(fixture, issue(fixture));
    const closed = nextClose(viewer);
    viewer.send(JSON.stringify({
      v: 2,
      type: "ack_output",
      terminalId,
      incarnationId,
      appliedSeq: 0,
    }));

    attachment.reject(new Error("terminal_unavailable"));

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "terminal_unavailable",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.service.dispatch).not.toHaveBeenCalled();
  });

  it("coalesces keyboard resize bursts behind slow remote work without moving input", async () => {
    const fixture = await createFixture();
    const blocked = deferred<void>();
    fixture.service.dispatch.mockImplementationOnce(async () => {
      await blocked.promise;
      return undefined;
    });
    const viewer = await open(fixture, issue(fixture));
    const send = (payload: Record<string, unknown>) => viewer.send(JSON.stringify({
      v: 2, terminalId, incarnationId, ...payload,
    }));
    send({ type: "resize", controllerEpoch: 1, columns: 80, rows: 80 });
    await waitFor(() => fixture.service.dispatch.mock.calls.length === 1);

    for (let rows = 79; rows >= 10; rows -= 1)
      send({ type: "resize", controllerEpoch: 1, columns: 80, rows });
    viewer.send(encodeTerminalBinaryFrame("input", {
      v: 2, terminalId, incarnationId, type: "input",
      controllerEpoch: 1, producerId, inputSeq: 1,
    }, Buffer.from("hello")));
    for (let rows = 11; rows <= 80; rows += 1)
      send({ type: "resize", controllerEpoch: 1, columns: 80, rows });
    // A ping/pong fences receipt of the burst while remote dispatch is blocked.
    await new Promise<void>((resolve) => {
      viewer.once("pong", () => resolve());
      viewer.once("close", () => resolve());
      viewer.ping();
    });
    blocked.resolve();
    expect(viewer.readyState).toBe(WebSocket.OPEN);
    await waitFor(() => fixture.service.dispatch.mock.calls.length === 4);
    expect(fixture.service.dispatch.mock.calls.map(([frame]) => frame)).toMatchObject([
      { type: "resize", rows: 80 },
      { type: "resize", rows: 10 },
      { type: "input", inputSeq: 1 },
      { type: "resize", rows: 80 },
    ]);
    viewer.close();
  });

  it.each(["controllerEpoch", "terminalId", "incarnationId"] as const)(
    "does not coalesce resize frames across a changed %s",
    async (field) => {
      const fixture = await createFixture();
      const blocked = deferred<void>();
      fixture.service.dispatch.mockImplementationOnce(async () => {
        await blocked.promise;
        return undefined;
      });
      const viewer = await open(fixture, issue(fixture));
      viewer.send(JSON.stringify({ v: 2, terminalId, incarnationId, type: "claim_control" }));
      await waitFor(() => fixture.service.dispatch.mock.calls.length === 1);
      const resize = { v: 2, terminalId, incarnationId, type: "resize", controllerEpoch: 1, columns: 80, rows: 24 };
      viewer.send(JSON.stringify(resize));
      const changed = { ...resize, [field]: field === "controllerEpoch" ? 2 : producerId, rows: 12 };
      viewer.send(JSON.stringify(changed));
      await new Promise<void>((resolve) => {
        viewer.once("pong", () => resolve());
        viewer.ping();
      });
      blocked.resolve();
      await waitFor(() => fixture.service.dispatch.mock.calls.length === 3);
      expect(fixture.service.dispatch.mock.calls.slice(1).map(([frame]) => frame)).toEqual([resize, changed]);
      viewer.close();
    },
  );

  it("keeps the pending-frame bound for non-coalescible control traffic", async () => {
    const fixture = await createFixture();
    const viewer = await open(fixture, issue(fixture));
    await waitFor(() => fixture.service.attach.mock.calls.length === 1);
    const socket = (viewer as unknown as {
      _socket: { cork(): void; uncork(): void };
    })._socket;
    const closed = nextClose(viewer);

    socket.cork();
    for (let index = 0; index < 33; index += 1) {
      viewer.send(JSON.stringify({
        v: 2,
        type: "claim_control",
        terminalId,
        incarnationId,
      }));
    }
    socket.uncork();

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "protocol_error",
    });
  });

  it("closes a viewer whose outbound WebSocket buffer exceeds the bound", async () => {
    const fixture = await createFixture();
    const viewer = await open(fixture, issue(fixture));
    await waitFor(() => fixture.service.emit !== undefined);
    const socket = (viewer as unknown as {
      _socket: { pause(): void; resume(): void };
    })._socket;
    socket.pause();
    const closed = nextClose(viewer);
    const data = Buffer.alloc(100 * 1024, 120).toString("base64url");
    for (let seq = 1; seq <= 40 && viewer.readyState === WebSocket.OPEN; seq += 1) {
      fixture.service.emit?.({
        v: 2,
        type: "output",
        terminalId,
        incarnationId,
        seq,
        data,
      });
    }
    socket.resume();
    await expect(closed).resolves.toMatchObject({ code: 1013 });
  });

  it("delivers terminal_removed before actively closing and detaching the viewer", async () => {
    const fixture = await createFixture();
    const viewer = await open(fixture, issue(fixture));
    await waitFor(() => fixture.service.emit !== undefined);
    const messages: unknown[] = [];
    viewer.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    const closed = nextClose(viewer);

    fixture.service.emit?.({
      v: 2,
      type: "terminal_removed",
      terminalId,
      incarnationId,
    });

    await expect(closed).resolves.toEqual({
      code: 1000,
      reason: "terminal_removed",
    });
    expect(messages).toEqual([
      {
        v: 2,
        type: "terminal_removed",
        terminalId,
        incarnationId,
      },
    ]);
    await waitFor(() => fixture.service.closeViewer.mock.calls.length === 1);
  });
});

async function createFixture(appConfig: AppConfig = config, authentication?: AuthenticationAdmission): Promise<Fixture> {
  const service = new FakeTerminalService();
  const typedService = service as unknown as TerminalService;
  const admissions = new TerminalAdmissionTokens(typedService);
  const app = express();
  app.use(express.json());
  app.use(createTerminalRouter({ identity: new FixedIdentity(), service: typedService, admissions, ...(authentication ? { authentication } : {}) }));
  app.use(errorMiddleware);
  const server = createServer(app);
  const connections = new LongLivedHttpConnectionRegistry();
  const carrier = attachTerminalCarrier(server, {
    config: appConfig,
    identity: new FixedIdentity(),
    admissions,
    ...(authentication ? { authentication } : {}),
    service: typedService,
    connections,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const fixture = {
    server,
    service,
    admissions,
    ...(authentication ? { authentication } : {}),
    carrier,
    connections,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}${TERMINAL_WEBSOCKET_PATH}`,
  };
  fixtures.push(fixture);
  return fixture;
}

function issue(fixture: Fixture): string {
  return fixture.admissions.issue({
    scope,
    terminalId,
    producerId,
    requestedRole: "controller",
    restore: { kind: "checkpoint" },
  }).token;
}

function open(
  fixture: Fixture,
  token: string,
  protocols: string[] | undefined = [TERMINAL_WEBSOCKET_PROTOCOL, token],
  input: {
    readonly fetchSite?: string;
    readonly host?: string;
    readonly origin?: string;
  } = {},
): Promise<WebSocket> {
  const viewer = new WebSocket(
    fixture.wsUrl,
    protocols ?? [TERMINAL_WEBSOCKET_PROTOCOL, token],
    {
      origin: input.origin ?? fixture.baseUrl,
      headers: {
        ...(input.host ? { Host: input.host } : {}),
        "Sec-Fetch-Mode": "websocket",
        "Sec-Fetch-Site": input.fetchSite ?? "same-origin",
      },
    },
  );
  return new Promise((resolve, reject) => {
    viewer.once("open", () => resolve(viewer));
    viewer.once("error", reject);
  });
}

function nextClose(viewer: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    viewer.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString("utf8") }),
    );
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("terminal_carrier_test_condition_not_reached");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
