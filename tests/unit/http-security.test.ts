import express from "express";
import type { IncomingMessage } from "node:http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/server/config/config.js";
import {
  packagedClientCors,
  csrfGuard,
  hostOriginGuard,
  securityHeaders,
  validateWebSocketHostOrigin,
} from "../../src/server/security/http-security.js";

const config: AppConfig = {
  authenticationRequired: true,
  host: "127.0.0.1",
  port: 4783,
  stateDirectory: "/tmp/sedes",
  allowedTailscaleHosts: ["sedes.example.ts.net"],
  packagedClientOrigins: [],
        conversationRetentionMilliseconds: 600_000,
        conversationRuntimeBudget: 8,
};

function secureApp(appConfig: AppConfig = config) {
  const app = express();
  app.use(securityHeaders);
  app.use(hostOriginGuard(appConfig));
  app.use(packagedClientCors(appConfig));
  app.use(csrfGuard("expected-token"));
  app.get("/value", (_request, response) => response.json({ ok: true }));
  app.post("/value", (_request, response) => response.json({ ok: true }));
  app.get("/api/value", (_request, response) => response.json({ ok: true }));
  app.post("/api/value", (_request, response) => response.json({ ok: true }));
  return app;
}

describe("HTTP security middleware", () => {
  it("keeps HTTP and upgraded-carrier Host/Origin authority in parity", async () => {
    const cases = [
      {
        name: "same loopback origin",
        headers: {
          host: "127.0.0.1:4783",
          origin: "http://127.0.0.1:4783",
        },
        allowed: true,
      },
      {
        name: "host suffix trick",
        headers: {
          host: "localhost.attacker.test:4783",
          origin: "http://localhost.attacker.test:4783",
        },
        allowed: false,
        reason: "host_not_allowed",
      },
      {
        name: "hostile origin",
        headers: {
          host: "127.0.0.1:4783",
          origin: "https://attacker.test",
        },
        allowed: false,
        reason: "origin_not_allowed",
      },
      {
        name: "trusted loopback proxy",
        headers: {
          host: "127.0.0.1:4783",
          origin: "https://sedes.example.ts.net",
          "x-forwarded-host": "sedes.example.ts.net",
          "x-forwarded-proto": "https",
        },
        allowed: true,
      },
      {
        name: "untrusted forwarded host",
        headers: {
          host: "127.0.0.1:4783",
          origin: "https://attacker.test",
          "x-forwarded-host": "attacker.test",
          "x-forwarded-proto": "https",
        },
        allowed: false,
        reason: "forwarded_origin_not_allowed",
      },
    ] as const;

    for (const candidate of cases) {
      const http = request(secureApp()).get("/api/value");
      for (const [name, value] of Object.entries(candidate.headers)) {
        http.set(name, value);
      }
      const httpResponse = await http;
      const webSocketRejection = validateWebSocketHostOrigin(
        fakeUpgradeRequest({
          ...candidate.headers,
          "sec-fetch-mode": "websocket",
          "sec-fetch-site": "same-origin",
        }),
        config,
      );
      expect({
        name: candidate.name,
        httpAllowed: httpResponse.status === 200,
        webSocketAllowed: webSocketRejection === undefined,
        webSocketRejection,
      }).toEqual({
        name: candidate.name,
        httpAllowed: candidate.allowed,
        webSocketAllowed: candidate.allowed,
        ...(candidate.allowed
          ? { webSocketRejection: undefined }
          : { webSocketRejection: candidate.reason }),
      });
    }
  });

  it("accepts omitted WebSocket Fetch Metadata, validates supplied metadata, and gates Android", () => {
    const headers = {
      host: "127.0.0.1:4783",
      origin: "http://localhost",
    };
    expect(
      validateWebSocketHostOrigin(fakeUpgradeRequest(headers), config),
    ).toBe("origin_not_allowed");
    expect(
      validateWebSocketHostOrigin(
        fakeUpgradeRequest({
          host: "127.0.0.1:4783",
          origin: "http://127.0.0.1:4783",
        }),
        config,
      ),
    ).toBeUndefined();
    expect(
      validateWebSocketHostOrigin(
        fakeUpgradeRequest({
          host: "127.0.0.1:4783",
          origin: "http://127.0.0.1:4783",
          "sec-fetch-mode": "websocket",
        }),
        config,
      ),
    ).toBe("origin_not_allowed");
    expect(
      validateWebSocketHostOrigin(fakeUpgradeRequest(headers), {
        ...config,
        packagedClientOrigins: ["http://localhost"],
      }),
    ).toBeUndefined();
    expect(
      validateWebSocketHostOrigin(
        fakeUpgradeRequest({
          ...headers,
          "sec-fetch-mode": "websocket",
          "sec-fetch-site": "cross-site",
        }),
        config,
      ),
    ).toBe("origin_not_allowed");
    expect(
      validateWebSocketHostOrigin(
        fakeUpgradeRequest({
          ...headers,
          "sec-fetch-mode": "websocket",
          "sec-fetch-site": "cross-site",
        }),
        { ...config, packagedClientOrigins: ["http://localhost"] },
      ),
    ).toBeUndefined();
  });

  it("accepts loopback and exact configured Tailscale hosts", async () => {
    await request(secureApp())
      .get("/value")
      .set("Host", "127.0.0.1:4783")
      .expect(200);
    await request(secureApp())
      .get("/value")
      .set("Host", "sedes.example.ts.net")
      .expect(200);
    await request(secureApp())
      .get("/value")
      .set("Host", "localhost:4783")
      .set("Origin", "http://localhost:4783")
      .expect(200);
  });

  it("rejects suffix tricks and hostile origins", async () => {
    const hostResponse = await request(secureApp())
      .get("/value")
      .set("Host", "sedes.example.ts.net.attacker.test")
      .expect(403);
    expect(hostResponse.body.error.code).toBe("host_not_allowed");
    expect(hostResponse.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );

    await request(secureApp())
      .get("/value")
      .set("Host", "attacker.test@localhost:4783")
      .expect(403);

    const originResponse = await request(secureApp())
      .get("/value")
      .set("Host", "127.0.0.1:4783")
      .set("Origin", "https://attacker.test")
      .expect(403);
    expect(originResponse.body.error.code).toBe("origin_not_allowed");

    await request(secureApp())
      .get("/value")
      .set("Host", "127.0.0.1:4783")
      .set("Sec-Fetch-Site", "cross-site")
      .expect(403);

    await request(secureApp())
      .get("/value")
      .set("Host", "localhost:4783")
      .set("Origin", "http://127.0.0.1:4783")
      .expect(403);
  });

  it("permits cross-site top-level GET navigation but not subresources or mutations", async () => {
    await request(secureApp())
      .get("/value")
      .set("Host", "sedes.example.ts.net")
      .set("Sec-Fetch-Site", "cross-site")
      .set("Sec-Fetch-Mode", "navigate")
      .set("Sec-Fetch-Dest", "document")
      .expect(200);

    await request(secureApp())
      .get("/value")
      .set("Host", "sedes.example.ts.net")
      .set("Sec-Fetch-Site", "cross-site")
      .set("Sec-Fetch-Mode", "no-cors")
      .set("Sec-Fetch-Dest", "script")
      .expect(403);

    await request(secureApp())
      .post("/value")
      .set("Host", "sedes.example.ts.net")
      .set("Sec-Fetch-Site", "cross-site")
      .set("Sec-Fetch-Mode", "navigate")
      .set("Sec-Fetch-Dest", "document")
      .set("X-CSRF-Token", "expected-token")
      .expect(403);
  });

  it("accepts exact forwarded Serve origin only from the loopback proxy", async () => {
    await request(secureApp())
      .get("/value")
      .set("Host", "127.0.0.1:4783")
      .set("X-Forwarded-Host", "sedes.example.ts.net")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", "https://sedes.example.ts.net")
      .expect(200);

    const response = await request(secureApp())
      .get("/value")
      .set("Host", "127.0.0.1:4783")
      .set("X-Forwarded-Host", "attacker.test")
      .set("X-Forwarded-Proto", "https")
      .expect(403);
    expect(response.body.error.code).toBe("forwarded_origin_not_allowed");

    await request(secureApp())
      .get("/value")
      .set("Host", "127.0.0.1:4783")
      .set("X-Forwarded-Host", "sedes.example.ts.net")
      .expect(403);

    await request(secureApp())
      .get("/value")
      .set("Host", "127.0.0.1:4783")
      .set("X-Forwarded-Host", "sedes.example.ts.net")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", "http://localhost:4783")
      .expect(403);
  });

  it("requires the process CSRF token only for mutations", async () => {
    await request(secureApp())
      .get("/value")
      .set("Host", "localhost:4783")
      .expect(200);
    await request(secureApp())
      .post("/value")
      .set("Host", "localhost:4783")
      .expect(403);
    await request(secureApp())
      .post("/value")
      .set("Host", "localhost:4783")
      .set("X-CSRF-Token", "expected-token")
      .expect(200);
  });

  it("allows only the exact opted-in Capacitor origin on API routes", async () => {
    const enabled = {
      ...config,
      packagedClientOrigins: ["http://localhost"] as const,
    };
    const response = await request(secureApp(enabled))
      .get("/api/value")
      .set("Host", "localhost:4783")
      .set("Origin", "http://localhost")
      .set("Sec-Fetch-Site", "cross-site")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost",
    );
    expect(response.headers.vary).toContain("Origin");
    expect(
      response.headers["access-control-allow-credentials"],
    ).toBeUndefined();

    await request(secureApp(config))
      .get("/api/value")
      .set("Host", "localhost:4783")
      .set("Origin", "http://localhost")
      .set("Sec-Fetch-Site", "cross-site")
      .expect(403);
    for (const origin of [
      "https://localhost",
      "http://localhost:80",
      "http://127.0.0.1",
      "null",
    ]) {
      await request(secureApp(enabled))
        .get("/api/value")
        .set("Host", "localhost:4783")
        .set("Origin", origin)
        .set("Sec-Fetch-Site", "cross-site")
        .expect(403);
    }

    await request(secureApp(enabled))
      .get("/value")
      .set("Host", "localhost:4783")
      .set("Origin", "http://localhost")
      .set("Sec-Fetch-Site", "cross-site")
      .expect(403);
    await request(secureApp(enabled))
      .get("/api/value")
      .set("Host", "attacker.test")
      .set("Origin", "http://localhost")
      .set("Sec-Fetch-Site", "cross-site")
      .expect(403);
  });

  it("admits Electron only through its exact independent packaged origin", async () => {
    const electron = {
      ...config,
      packagedClientOrigins: ["capacitor-electron://localhost"] as const,
    };
    const response = await request(secureApp(electron))
      .get("/api/value")
      .set("Host", "localhost:4783")
      .set("Origin", "capacitor-electron://localhost")
      .set("Sec-Fetch-Site", "cross-site")
      .expect(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "capacitor-electron://localhost",
    );

    await request(secureApp(electron))
      .get("/api/value")
      .set("Host", "localhost:4783")
      .set("Origin", "http://localhost")
      .set("Sec-Fetch-Site", "cross-site")
      .expect(403);
    expect(
      validateWebSocketHostOrigin(
        fakeUpgradeRequest({
          host: "localhost:4783",
          origin: "capacitor-electron://localhost",
          "sec-fetch-mode": "websocket",
          "sec-fetch-site": "cross-site",
        }),
        electron,
      ),
    ).toBeUndefined();
  });

  it("admits only the exact configured private bind Host", async () => {
    const enabled = {
      ...config,
      host: "0.0.0.0" as const,
      trustedLanHost: "192.168.50.51",
      packagedClientOrigins: ["http://localhost"] as const,
    };
    const response = await request(secureApp(enabled))
      .get("/api/value")
      .set("Host", "192.168.50.51:4783")
      .set("Origin", "http://localhost")
      .set("Sec-Fetch-Site", "cross-site")
      .expect(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost",
    );

    await request(secureApp(enabled))
      .get("/api/value")
      .set("Host", "192.168.50.52:4783")
      .set("Origin", "http://localhost")
      .set("Sec-Fetch-Site", "cross-site")
      .expect(403);
  });

  it("answers bounded Capacitor API preflights without credentialed CORS", async () => {
    const enabled = {
      ...config,
      packagedClientOrigins: ["http://localhost"] as const,
    };
    const response = await request(secureApp(enabled))
      .options("/api/value")
      .set("Host", "localhost:4783")
      .set("Origin", "http://localhost")
      .set("Sec-Fetch-Site", "cross-site")
      .set("Access-Control-Request-Method", "POST")
      .set(
        "Access-Control-Request-Headers",
        "content-type, last-event-id, x-csrf-token, authorization",
      )
      .expect(204);

    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost",
    );
    expect(response.headers["access-control-allow-methods"]).toBe(
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    expect(response.headers["access-control-allow-headers"]).toBe(
      "Content-Type, Last-Event-ID, X-CSRF-Token, Authorization",
    );
    expect(response.headers["access-control-max-age"]).toBe("600");
    expect(
      response.headers["access-control-allow-credentials"],
    ).toBeUndefined();

    for (const [method, headers] of [
      ["TRACE", "content-type"],
      ["POST", "x-unapproved-header"],
      ["POST", "content-type,,x-csrf-token"],
    ]) {
      await request(secureApp(enabled))
        .options("/api/value")
        .set("Host", "localhost:4783")
        .set("Origin", "http://localhost")
        .set("Sec-Fetch-Site", "cross-site")
        .set("Access-Control-Request-Method", method!)
        .set("Access-Control-Request-Headers", headers!)
        .expect(403);
    }
  });

  it.each(["http://localhost", "capacitor-electron://localhost"] as const)(
    "admits HEAD preflights requesting Authorization from the configured packaged origin %s",
    async (origin) => {
      const app = secureApp({ ...config, packagedClientOrigins: [origin] });
      const response = await request(app).options("/api/value")
        .set("Host", "localhost:4783").set("Origin", origin)
        .set("Sec-Fetch-Site", "cross-site")
        .set("Access-Control-Request-Method", "HEAD")
        .set("Access-Control-Request-Headers", "authorization").expect(204);
      expect(response.headers["access-control-allow-methods"]?.split(", ")).toContain("HEAD");
      await request(app).head("/api/value").set("Host", "localhost:4783")
        .set("Origin", origin).set("Sec-Fetch-Site", "cross-site").expect(200);
    },
  );

  it("emits a restrictive browser security policy", async () => {
    const response = await request(secureApp())
      .get("/value")
      .set("Host", "localhost")
      .expect(200);

    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers["content-security-policy"]).toContain(
      "style-src-attr 'unsafe-inline'",
    );
    expect(response.headers["content-security-policy"]).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
    expect(response.headers["content-security-policy"]).not.toMatch(
      /script-src[^;]*'unsafe-inline'/,
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });
});

function fakeUpgradeRequest(
  headers: Readonly<Record<string, string>>,
): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}
