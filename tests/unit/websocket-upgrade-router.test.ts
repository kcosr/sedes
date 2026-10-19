import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebSocketUpgradeRouter,
  rejectWebSocketUpgrade,
} from "../../src/server/http/websocket-upgrade-router.js";
import {
  captureProcessCrashes,
  sendUpgradeAndReset,
  upgradeUntilServerCloses,
} from "../helpers/raw-websocket-upgrade.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(): Promise<{ server: Server; router: WebSocketUpgradeRouter; port: number }> {
  const server = createServer((_request, response) => response.end());
  const router = new WebSocketUpgradeRouter(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { server, router, port: (server.address() as AddressInfo).port };
}

async function connectionCount(server: Server): Promise<number> {
  return await new Promise((resolve, reject) =>
    server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
  );
}

describe("WebSocket upgrade router", () => {
  it("dispatches exact paths and answers every other upgrade with 404", async () => {
    const { router, port } = await listen();
    const handler = vi.fn((_request, socket) => rejectWebSocketUpgrade(socket, 403));
    router.route("/claimed", handler);

    await expect(upgradeUntilServerCloses({ port, path: "/claimed", timeoutMilliseconds: 2_000 }))
      .resolves.toEqual({ response: expect.stringMatching(/^HTTP\/1\.1 403 Forbidden\r\n/) });
    for (const path of ["/claimed?x", "/claimed/", "/other"]) {
      await expect(upgradeUntilServerCloses({ port, path, timeoutMilliseconds: 2_000 }))
        .resolves.toEqual({ response: expect.stringMatching(/^HTTP\/1\.1 404 Not Found\r\n/) });
    }
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses duplicate claims and stops dispatching a released path", async () => {
    const { router, port } = await listen();
    const handler = vi.fn();
    const release = router.route("/claimed", handler);
    expect(() => router.route("/claimed", vi.fn())).toThrow("websocket_upgrade_route_conflict");
    release();
    const replacement = vi.fn((_request, socket) => rejectWebSocketUpgrade(socket, 401));
    const releaseReplacement = router.route("/claimed", replacement);
    release();
    await expect(upgradeUntilServerCloses({ port, path: "/claimed", timeoutMilliseconds: 2_000 }))
      .resolves.toEqual({ response: expect.stringMatching(/^HTTP\/1\.1 401 Unauthorized\r\n/) });
    releaseReplacement();
    await expect(upgradeUntilServerCloses({ port, path: "/claimed", timeoutMilliseconds: 2_000 }))
      .resolves.toEqual({ response: expect.stringMatching(/^HTTP\/1\.1 404 Not Found\r\n/) });
    expect(handler).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledOnce();
  });

  it("releases a refused socket whose peer never closes its half", async () => {
    const { server, port } = await listen();
    const peer = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    peer.on("error", () => undefined);
    const answered = new Promise<string>((resolve) => peer.once("data", (chunk: Buffer) => resolve(chunk.toString("latin1"))));
    peer.write("GET /unrouted HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    await expect(answered).resolves.toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
    await vi.waitFor(async () => expect(await connectionCount(server)).toBe(0), { timeout: 2_000 });
    peer.destroy();
  });

  it("keeps the process alive when a peer resets while a route is still deciding", async () => {
    const { router, port } = await listen();
    const decided: Promise<void>[] = [];
    router.route("/slow", (_request, socket) => {
      socket.pause();
      decided.push(new Promise<void>((resolve) => setTimeout(() => {
        rejectWebSocketUpgrade(socket, 403);
        resolve();
      }, 20)));
    });
    const crashes = captureProcessCrashes();
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sendUpgradeAndReset({ port, path: "/slow" });
      }
      await vi.waitFor(() => expect(decided).toHaveLength(20));
      await Promise.all(decided);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(crashes.errors).toEqual([]);
    } finally {
      crashes.dispose();
    }
  });
});
