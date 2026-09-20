import { createServer, get, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApplicationDrainController,
  DetachedOperationDrainGate,
  HttpRequestOperationGate,
  LongLivedHttpConnectionRegistry,
  closeHttpServerBounded,
} from "../../src/server/runtime/application-shutdown.js";

describe("application shutdown lifecycle", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("enters drain idempotently", () => {
    const drain = new ApplicationDrainController();
    expect(drain.isDraining).toBe(false);
    drain.beginDrain();
    drain.beginDrain();
    expect(drain.isDraining).toBe(true);
  });

  it("stops detached admission and waits for every admitted operation", async () => {
    const gate = new DetachedOperationDrainGate();
    let release!: () => void;
    let admittedSignal: AbortSignal | undefined;
    const operation = gate.admit(
      (signal) =>
        new Promise<void>((resolve) => {
          admittedSignal = signal;
          release = resolve;
        }),
    );
    expect(operation).toBeDefined();
    await waitFor(() => gate.size === 1 && release !== undefined);

    let closed = false;
    const closing = gate.close().then(() => {
      closed = true;
    });
    expect(gate.admit(() => undefined)).toBeUndefined();
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(admittedSignal?.aborted).toBe(true);

    release();
    await closing;
    expect(closed).toBe(true);
    expect(gate.size).toBe(0);
  });

  it("does not report drained while an admitted continuation remains alive", async () => {
    const gate = new DetachedOperationDrainGate();
    let release!: () => void;
    const operation = gate.admit(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await waitFor(() => release !== undefined);
    let closed = false;
    const closing = gate.close().then(() => (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(gate.admit(() => undefined)).toBeUndefined();
    release();
    await operation;
    await closing;
    expect(closed).toBe(true);
  });

  it("drains ordinary handler promises independently of socket lifetime", async () => {
    const gate = new HttpRequestOperationGate();
    let release!: () => void;
    const handler = gate.run(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await waitFor(() => release !== undefined);

    let closed = false;
    const closing = gate.close().then(() => (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(gate.run(() => undefined)).rejects.toThrow(
      "http_request_operation_gate_closed",
    );

    release();
    await handler;
    await closing;
    expect(closed).toBe(true);
  });

  it("provides a client-only registry seam for future upgraded carriers", async () => {
    const connections = new LongLivedHttpConnectionRegistry();
    const identity = {};
    let serverStopped = false;
    let clientClosed = false;
    connections.trackOwnedConnection(identity, () => {
      clientClosed = true;
    });

    await connections.closeAll(5);
    expect(clientClosed).toBe(true);
    expect(serverStopped).toBe(false);
  });

  it("ends registered SSE responses before the HTTP listener closes", async () => {
    const connections = new LongLivedHttpConnectionRegistry();
    const server = createServer((_request, response) => {
      connections.track(response);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("event: live\ndata: {}\n\n");
    });
    servers.push(server);
    const port = await listen(server);
    const clientClosed = new Promise<void>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${port}`, (response) => {
        response.resume();
        response.once("end", resolve);
        response.once("error", reject);
      });
      request.once("error", reject);
    });
    await waitFor(() => connections.size === 1);

    await closeHttpServerBounded(server, connections, {
      graceMilliseconds: 20,
      closeMilliseconds: 100,
    });
    await clientClosed;
    expect(connections.size).toBe(0);
    expect(server.listening).toBe(false);
  });

  it("uses the owned-socket fallback for an unregistered active response", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("still-active");
    });
    servers.push(server);
    const port = await listen(server);
    const request = get(`http://127.0.0.1:${port}`, (response) => {
      response.resume();
    });
    request.on("error", () => undefined);
    await new Promise<void>((resolve) =>
      request.once("response", () => resolve()),
    );

    await closeHttpServerBounded(
      server,
      new LongLivedHttpConnectionRegistry(),
      { graceMilliseconds: 5, closeMilliseconds: 20 },
    );
    expect(server.listening).toBe(false);
  });
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test_http_address_unavailable");
  }
  return address.port;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("test_condition_not_reached");
}
