import { createServer as createHttpServer, type Server } from "node:http";
import express from "express";
import { createServer as createViteServer } from "vite";
import { expect, it } from "vitest";
import viteConfig from "../../vite.config.js";
import type { AppConfig } from "../../src/server/config/config.js";
import { csrfGuard, hostOriginGuard } from "../../src/server/security/http-security.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

it("admits same-origin requests through the development proxy without admitting hostile origins", async () => {
  const config: AppConfig = {
    authenticationRequired: true,
    experimentalUsageEnabled: false,
    host: "127.0.0.1",
    port: 4784,
    stateDirectory: "/unused",
    allowedTailscaleHosts: [],
    packagedClientOrigins: [],
    conversationRetentionMilliseconds: 600_000,
    conversationRuntimeBudget: 8,
  };
  const app = express();
  app.use(hostOriginGuard(config));
  app.use(csrfGuard("test-token"));
  app.all("/api/probe", (request, response) => {
    response.json({ host: request.headers.host });
  });
  const backend = createHttpServer(app);
  const target = await listen(backend);
  try {
    const configuredProxy = viteConfig.server?.proxy?.["/api"];
    if (!configuredProxy) throw new Error("Missing development API proxy");
    // Substitute only the listener address; retain the committed proxy behavior.
    const proxy = typeof configuredProxy === "string"
      ? target
      : { ...configuredProxy, target };
    const vite = await createViteServer({
      configFile: false,
      server: { middlewareMode: true, hmr: false, watch: null, proxy: { "/api": proxy } },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    const frontend = createHttpServer(vite.middlewares);
    try {
      const origin = await listen(frontend);
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const response = await fetch(`${origin}/api/probe`, {
          method,
          headers: {
            ...(method === "GET" ? {} : { Origin: origin }),
            "X-CSRF-Token": "test-token",
          },
        });
        expect(response.status, method).toBe(200);
        expect(await response.json()).toEqual({ host: new URL(origin).host });
      }
      const hostile = await fetch(`${origin}/api/probe`, {
        method: "POST",
        headers: { Origin: "https://attacker.example", "X-CSRF-Token": "test-token" },
      });
      expect(hostile.status).toBe(403);
      expect(await hostile.json()).toMatchObject({ error: { code: "origin_not_allowed" } });

      const missingToken = await fetch(`${origin}/api/probe`, {
        method: "POST",
        headers: { Origin: origin },
      });
      expect(missingToken.status).toBe(403);
      expect(await missingToken.json()).toMatchObject({ error: { code: "csrf_token_invalid" } });
    } finally {
      await close(frontend);
      await vite.close();
    }
  } finally {
    await close(backend);
  }
});
