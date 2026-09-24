import type { AuthenticationAdmission } from "../../src/server/authentication/authentication-admission.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request as ExpressRequest } from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/server/config/config.js";
import { errorMiddleware } from "../../src/server/http/errors.js";
import type {
  IdentityProvider,
  RequestScope,
} from "../../src/server/identity/identity-provider.js";
import { LongLivedHttpConnectionRegistry } from "../../src/server/runtime/application-shutdown.js";
import {
  csrfGuard,
  hostOriginGuard,
} from "../../src/server/security/http-security.js";
import {
  MANAGED_TERMINAL_ADMISSION_ROUTE,
  MANAGED_TERMINAL_WEBSOCKET_PATH,
  MANAGED_TERMINAL_WEBSOCKET_PROTOCOL,
  ManagedTerminalAdmissionTokens,
  ManagedTerminalCarrierError,
  attachManagedTerminalCarrier,
  createManagedTerminalAdmissionHandler,
  type ManagedTerminalCarrier,
  type ManagedTerminalResourceAuthority,
  type ManagedTerminalServerEvent,
  type ManagedTerminalViewerSession,
} from "../../src/server/terminal/managed-terminal-carrier.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const threadId = "00000000-0000-4000-8000-000000000001";
const config: AppConfig = {
  authenticationRequired: true,
  experimentalUsageEnabled: false,
  host: "127.0.0.1",
  port: 4783,
  stateDirectory: "/tmp/sedes-terminal-carrier-test",
  allowedTailscaleHosts: [],
  packagedClientOrigins: [],
        conversationRetentionMilliseconds: 600_000,
        conversationRuntimeBudget: 8,
};

class FixedIdentity<RequestLike> implements IdentityProvider<RequestLike> {
  constructor(readonly currentScope: RequestScope = scope) {}
  async resolve(_request: RequestLike): Promise<RequestScope> {
    return this.currentScope;
  }
}

class FakeAuthority implements ManagedTerminalResourceAuthority {
  generation = 7;
  attachGate: Promise<void> | undefined;
  readonly authorizeAdmission = vi.fn(
    async (): Promise<{ readonly resourceGeneration: number }> => ({
      resourceGeneration: this.generation,
    }),
  );
  readonly sendInput = vi.fn();
  readonly resize = vi.fn();
  readonly requestSync = vi.fn();
  readonly requestRefit = vi.fn();
  readonly closeViewer = vi.fn();
  emit: ((event: ManagedTerminalServerEvent) => void) | undefined;
  readonly attachViewer = vi.fn(
    async (
      _input: Parameters<ManagedTerminalResourceAuthority["attachViewer"]>[0],
      emit: (event: ManagedTerminalServerEvent) => void,
    ): Promise<ManagedTerminalViewerSession> => {
      await this.attachGate;
      this.emit = emit;
      return {
        sendInput: this.sendInput,
        resize: this.resize,
        requestSync: this.requestSync,
        requestRefit: this.requestRefit,
        close: this.closeViewer,
      };
    },
  );
}

interface Fixture {
  readonly server: Server;
  readonly authority: FakeAuthority;
  readonly admissions: ManagedTerminalAdmissionTokens;
  readonly connections: LongLivedHttpConnectionRegistry;
  readonly carrier: ManagedTerminalCarrier;
  readonly baseUrl: string;
  readonly wsUrl: string;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
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

describe("managed terminal carrier", () => {
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
      .post(`/api/threads/${threadId}/provider-features/codex.tui/terminal-admission`)
      .set("Host", new URL(fixture.baseUrl).host)
      .set("X-CSRF-Token", "terminal-csrf")
      .set("Authorization", "Bearer stale-invalid-credential")
      .send({}).expect(201);
    const token = response.body.token as string;
    await expect(openViewer(fixture, token, { origin: "https://attacker.test" })).rejects.toThrow("403");
    const viewer = await openViewer(fixture, token);
    await waitFor(() => fixture.authority.attachViewer.mock.calls.length === 1);
    viewer.close();
    await expect(openViewer(fixture, token)).rejects.toThrow("403");
    await expect(openViewer(fixture, "x".repeat(43))).rejects.toThrow("403");
    expect(fixture.authority.attachViewer).toHaveBeenCalledTimes(1);
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
    const token = (await issueAdmission(fixture)).token;
    expect(bindTicket).toHaveBeenCalledWith(token, "paired-client", expect.any(Number));
    const viewer = await openViewer(fixture, token);
    await waitFor(() => fixture.authority.attachViewer.mock.calls.length === 1);
    expect(consumeTicket).toHaveBeenCalledWith(token);
    const closed = new Promise<void>((resolve) => viewer.once("close", () => resolve()));
    revoke!();
    await closed;
    expect(fixture.authority.closeViewer).toHaveBeenCalledOnce();
    expect(untrack).toHaveBeenCalledOnce();
    consumeTicket.mockImplementationOnce(() => { throw new Error("authentication_required"); });
    const rejectedToken = (await issueAdmission(fixture)).token;
    await expect(openViewer(fixture, rejectedToken)).rejects.toThrow("403");
    expect(fixture.authority.attachViewer).toHaveBeenCalledTimes(1);
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
    const token = (await issueAdmission(fixture)).token;
    const viewer = await openViewer(fixture, token);
    await new Promise<void>((resolve) => viewer.once("close", () => resolve()));
    expect(fixture.authority.attachViewer).not.toHaveBeenCalled();
  });

  it("keeps admission POST behind CSRF and shared API error codes", async () => {
    const fixture = await createFixture();
    const route = `/api/threads/${threadId}/provider-features/codex.tui/terminal-admission`;
    const csrfFailure = await request(fixture.server)
      .post(route)
      .set("Host", new URL(fixture.baseUrl).host)
      .send({})
      .expect(403);
    expect(csrfFailure.body.error.code).toBe("csrf_token_invalid");

    fixture.authority.authorizeAdmission.mockRejectedValueOnce(
      new ManagedTerminalCarrierError(
        "terminal_unavailable",
        "The managed terminal is unavailable.",
        true,
      ),
    );
    const unavailable = await request(fixture.server)
      .post(route)
      .set("Host", new URL(fixture.baseUrl).host)
      .set("X-CSRF-Token", "terminal-csrf")
      .send({})
      .expect(503);
    expect(unavailable.body.error.code).toBe("runtime_unavailable");
  });

  it("mints one-time scoped admission and carries strict input and binary output", async () => {
    const fixture = await createFixture();
    const admission = await issueAdmission(fixture);
    expect(admission.resourceGeneration).toBe(7);
    expect(admission.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const viewer = await openViewer(fixture, admission.token);
    expect(viewer.protocol).toBe(MANAGED_TERMINAL_WEBSOCKET_PROTOCOL);
    await waitFor(() => fixture.authority.attachViewer.mock.calls.length === 1);
    expect(fixture.authority.attachViewer.mock.calls[0]?.[0]).toMatchObject({
      scope,
      applicationThreadId: threadId,
      resourceGeneration: 7,
    });

    viewer.send(
      JSON.stringify({
        v: 1,
        type: "input",
        data: Buffer.from("hello").toString("base64url"),
      }),
    );
    viewer.send(
      JSON.stringify({ v: 1, type: "resize", columns: 120, rows: 40 }),
    );
    viewer.send(JSON.stringify({ v: 1, type: "request_sync" }));
    viewer.send(
      JSON.stringify({
        v: 1,
        type: "request_refit",
        columns: 100,
        rows: 30,
      }),
    );
    await waitFor(() => fixture.authority.requestRefit.mock.calls.length === 1);
    expect(Buffer.from(fixture.authority.sendInput.mock.calls[0]?.[0])).toEqual(
      Buffer.from("hello"),
    );
    expect(fixture.authority.resize).toHaveBeenCalledWith({
      columns: 120,
      rows: 40,
    });
    expect(fixture.authority.requestSync).toHaveBeenCalledOnce();
    expect(fixture.authority.requestRefit).toHaveBeenCalledWith({
      columns: 100,
      rows: 30,
    });

    const output = nextMessage(viewer);
    fixture.authority.emit?.({
      type: "output",
      bytes: Buffer.from([0, 1, 2, 255]),
    });
    const delivered = await output;
    expect(delivered.isBinary).toBe(true);
    expect(Buffer.from(delivered.data as Buffer)).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(fixture.connections.size).toBe(1);

    viewer.close();
    await waitFor(() => fixture.authority.closeViewer.mock.calls.length === 1);
    expect(fixture.connections.size).toBe(0);
  });

  it("admits the exact opted-in Capacitor origin through the negotiated terminal protocol", async () => {
    const disabled = await createFixture();
    const disabledAdmission = await issueAdmission(disabled);
    await expect(
      openViewer(disabled, disabledAdmission.token, {
        origin: "http://localhost",
        fetchSite: "cross-site",
      }),
    ).rejects.toThrow(/Unexpected server response: 403/);

    const enabled = await createFixture({
      ...config,
      packagedClientOrigins: ["http://localhost"],
    });
    const admission = await issueAdmission(enabled, {
      origin: "http://localhost",
      fetchSite: "cross-site",
    });
    const viewer = await openViewer(enabled, admission.token, {
      origin: "http://localhost",
      fetchSite: "cross-site",
    });
    expect(viewer.protocol).toBe(MANAGED_TERMINAL_WEBSOCKET_PROTOCOL);
    await waitFor(() => enabled.authority.attachViewer.mock.calls.length === 1);

    viewer.send(
      JSON.stringify({
        v: 1,
        type: "input",
        data: Buffer.from("capacitor-input").toString("base64url"),
      }),
    );
    viewer.send(
      JSON.stringify({ v: 1, type: "resize", columns: 72, rows: 18 }),
    );
    await waitFor(() => enabled.authority.resize.mock.calls.length === 1);
    expect(Buffer.from(enabled.authority.sendInput.mock.calls[0]?.[0])).toEqual(
      Buffer.from("capacitor-input"),
    );
    expect(enabled.authority.resize).toHaveBeenCalledWith({
      columns: 72,
      rows: 18,
    });

    viewer.close();
    await waitFor(() => enabled.authority.closeViewer.mock.calls.length === 1);
  });

  it("rejects replayed admission and hostile upgrade origins", async () => {
    const fixture = await createFixture();
    const first = await issueAdmission(fixture);
    const viewer = await openViewer(fixture, first.token);
    viewer.close();
    await waitFor(() => viewer.readyState === WebSocket.CLOSED);

    await expect(openViewer(fixture, first.token)).rejects.toThrow(
      /Unexpected server response: 403/,
    );

    const second = await issueAdmission(fixture);
    await expect(
      openViewer(fixture, second.token, { origin: "https://attacker.test" }),
    ).rejects.toThrow(/Unexpected server response: 403/);
    expect(fixture.authority.attachViewer).toHaveBeenCalledTimes(1);
  });

  it("closes malformed viewers and maps authority failures to the closed error enum", async () => {
    const fixture = await createFixture();
    const first = await issueAdmission(fixture);
    const malformed = await openViewer(fixture, first.token);
    await waitFor(() => fixture.authority.attachViewer.mock.calls.length === 1);
    const control = nextMessage(malformed);
    malformed.send(
      JSON.stringify({
        v: 1,
        type: "resize",
        columns: 80,
        rows: 24,
        extra: true,
      }),
    );
    const error = JSON.parse((await control).data.toString());
    expect(error).toMatchObject({
      v: 1,
      type: "error",
      code: "protocol_error",
      retryable: false,
    });
    await waitFor(() => malformed.readyState === WebSocket.CLOSED);

    fixture.authority.attachViewer.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new ManagedTerminalCarrierError(
        "generation_changed",
        "The managed terminal generation changed.",
        true,
      );
    });
    const second = await issueAdmission(fixture);
    const stale = await openViewer(fixture, second.token);
    const staleError = JSON.parse((await nextMessage(stale)).data.toString());
    expect(staleError.code).toBe("generation_changed");
    await waitFor(() => stale.readyState === WebSocket.CLOSED);
  });

  it("registers accepted viewers for bounded application shutdown", async () => {
    const fixture = await createFixture();
    const admission = await issueAdmission(fixture);
    const viewer = await openViewer(fixture, admission.token);
    await waitFor(() => fixture.connections.size === 1);

    await fixture.connections.closeAll(20);
    await waitFor(() => viewer.readyState === WebSocket.CLOSED);
    expect(fixture.authority.closeViewer).toHaveBeenCalledOnce();
    expect(fixture.connections.size).toBe(0);
  });

  it("disconnects only the viewer after a retryable resynchronization failure", async () => {
    const fixture = await createFixture();
    const admission = await issueAdmission(fixture);
    const viewer = await openViewer(fixture, admission.token);
    await waitFor(() => fixture.authority.attachViewer.mock.calls.length === 1);
    const errorMessage = nextMessage(viewer);
    fixture.authority.emit?.({
      type: "error",
      code: "resync_failed",
      message: "The terminal repaint did not complete.",
      retryable: true,
    });
    expect(JSON.parse((await errorMessage).data.toString())).toMatchObject({
      v: 1,
      type: "error",
      code: "resync_failed",
      retryable: true,
    });
    await waitFor(() => viewer.readyState === WebSocket.CLOSED);
    expect(fixture.authority.closeViewer).toHaveBeenCalledOnce();
  });

  it("bounds frames queued while a slow authority attaches", async () => {
    const fixture = await createFixture();
    let releaseAttach: () => void = () => undefined;
    fixture.authority.attachGate = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    const admission = await issueAdmission(fixture);
    const viewer = await openViewer(fixture, admission.token);
    const errorMessage = nextMessage(viewer);
    for (let index = 0; index < 33; index += 1) {
      viewer.send(JSON.stringify({ v: 1, type: "request_sync" }));
    }
    const error = JSON.parse((await errorMessage).data.toString());
    expect(error).toMatchObject({
      v: 1,
      type: "error",
      code: "protocol_error",
      retryable: false,
    });
    await waitFor(() => viewer.readyState === WebSocket.CLOSED);
    releaseAttach();
    await waitFor(() => fixture.authority.closeViewer.mock.calls.length === 1);
    expect(fixture.authority.requestSync).not.toHaveBeenCalled();
  });

  it("expires and scope-fences opaque tokens before resource attach", async () => {
    const authority = new FakeAuthority();
    let now = 1_000;
    const admissions = new ManagedTerminalAdmissionTokens(authority, {
      ttlMilliseconds: 10,
      now: () => now,
    });
    const wrongScopeToken = await admissions.issue({
      scope,
      applicationThreadId: threadId,
    });
    expect(() =>
      admissions.consume(wrongScopeToken.token, {
        tenantId: scope.tenantId,
        principalId: "another-principal",
      }),
    ).toThrowError(expect.objectContaining({ code: "admission_invalid" }));

    const expired = await admissions.issue({
      scope,
      applicationThreadId: threadId,
    });
    now += 11;
    expect(() => admissions.consume(expired.token, scope)).toThrowError(
      expect.objectContaining({ code: "admission_invalid" }),
    );
    expect(admissions.size).toBe(0);
  });
});

async function createFixture(appConfig: AppConfig = config, authentication?: AuthenticationAdmission): Promise<Fixture> {
  const authority = new FakeAuthority();
  const admissions = new ManagedTerminalAdmissionTokens(authority);
  const app = express();
  const expressIdentity = new FixedIdentity<ExpressRequest>();
  app.use(hostOriginGuard(appConfig));
  app.use(express.json());
  app.use(csrfGuard("terminal-csrf"));
  app.post(
    MANAGED_TERMINAL_ADMISSION_ROUTE,
    createManagedTerminalAdmissionHandler({
      identity: expressIdentity,
      admissions,
    ...(authentication ? { authentication } : {}),
    }),
  );
  app.use(errorMiddleware);
  const server = createServer(app);
  const connections = new LongLivedHttpConnectionRegistry();
  const carrier = attachManagedTerminalCarrier(server, {
    config: appConfig,
    identity: new FixedIdentity<IncomingMessage>(),
    admissions,
    ...(authentication ? { authentication } : {}),
    authority,
    connections,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const fixture = {
    server,
    authority,
    admissions,
    ...(authentication ? { authentication } : {}),
    connections,
    carrier,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}${MANAGED_TERMINAL_WEBSOCKET_PATH}`,
  };
  fixtures.push(fixture);
  return fixture;
}

async function issueAdmission(
  fixture: Fixture,
  input: {
    readonly origin?: string;
    readonly fetchSite?: "same-origin" | "same-site" | "cross-site";
  } = {},
): Promise<{
  readonly token: string;
  readonly expiresAt: string;
  readonly resourceGeneration: number;
}> {
  let admissionRequest = request(fixture.server)
    .post(
      `/api/threads/${threadId}/provider-features/codex.tui/terminal-admission`,
    )
    .set("Host", new URL(fixture.baseUrl).host)
    .set("X-CSRF-Token", "terminal-csrf")
    .send({});
  if (input.origin) {
    admissionRequest = admissionRequest.set("Origin", input.origin);
  }
  if (input.fetchSite) {
    admissionRequest = admissionRequest.set("Sec-Fetch-Site", input.fetchSite);
  }
  const response = await admissionRequest.expect(201);
  return response.body;
}

function openViewer(
  fixture: Fixture,
  token: string,
  input: {
    readonly origin?: string;
    readonly fetchSite?: "same-origin" | "same-site" | "cross-site";
  } = {},
): Promise<WebSocket> {
  const webSocket = new WebSocket(
    fixture.wsUrl,
    [MANAGED_TERMINAL_WEBSOCKET_PROTOCOL, token],
    {
      origin: input.origin ?? fixture.baseUrl,
      headers: {
        "Sec-Fetch-Mode": "websocket",
        "Sec-Fetch-Site": input.fetchSite ?? "same-origin",
      },
    },
  );
  return new Promise((resolve, reject) => {
    webSocket.once("open", () => resolve(webSocket));
    webSocket.once("error", reject);
  });
}

function nextMessage(webSocket: WebSocket): Promise<{
  readonly data: WebSocket.RawData;
  readonly isBinary: boolean;
}> {
  return new Promise((resolve, reject) => {
    webSocket.once("message", (data, isBinary) => resolve({ data, isBinary }));
    webSocket.once("error", reject);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("managed_terminal_test_condition_not_reached");
}
