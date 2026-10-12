import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/server/config/config.js";
import { ApiError, errorMiddleware } from "../../src/server/http/errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { createPageRenderRoutes } from "../../src/server/pages/render-routes.js";
import { capturePageDocument } from "../../src/server/pages/html-policy.js";
import { parse } from "parse5";
import { PageRenderTokens, PAGE_RENDER_TOKEN_LIFETIME_MS } from "../../src/server/pages/render-tokens.js";
import { hostOriginGuard, securityHeaders } from "../../src/server/security/http-security.js";

const scope = { tenantId: "tenant-a", principalId: "principal-a" };
const threadId = "00000000-0000-4000-8000-000000000001";
const pageId = "00000000-0000-4000-8000-000000000002";
const mintPath = `/api/threads/${threadId}/pages/${pageId}/revisions/2/render-token`;
const config: AppConfig = {
  authenticationRequired: true,
  experimentalUsageEnabled: false,
  host: "127.0.0.1",
  port: 4783,
  stateDirectory: "/tmp/sedes",
  allowedTailscaleHosts: ["sedes.example.ts.net"],
  packagedClientOrigins: ["capacitor-electron://localhost", "http://localhost"],
  conversationRetentionMilliseconds: 600_000,
  conversationRuntimeBudget: 8,
};

function fixture() {
  let now = 1_000_000;
  let exists = true;
  const reads: Array<{ scope: RequestScope; thread: string; page: string; revision: number }> = [];
  const tokens = new PageRenderTokens(() => now);
  const assertAuthority = (value: RequestScope, thread: string, page: string, revision: number) => {
    if (!exists || value.tenantId !== scope.tenantId || value.principalId !== scope.principalId || thread !== threadId || page !== pageId || revision !== 2) {
      throw new ApiError(404, "not_found", "Page not found.");
    }
  };
  const routes = createPageRenderRoutes({
    config,
    tokens,
    identity: { resolve: async (req) => req.header("Authorization") === "Bearer other" ? { ...scope, principalId: "principal-other" } : scope },
    pages: {
      get: assertAuthority,
      content: async (value, thread, page, revision) => {
        reads.push({ scope: value, thread, page, revision });
        assertAuthority(value, thread, page, revision);
        return capturePageDocument(parse("<!doctype html><html><head></head><body><h1>Saved revision two</h1><script>window.example=1</script></body></html>"));
      },
    },
  });
  const app = express();
  app.use(securityHeaders);
  app.use(hostOriginGuard(config));
  app.use(routes.publicRouter);
  app.use((req, res, next) => {
    if (!req.header("Authorization")) { res.status(401).end(); return; }
    next();
  });
  app.use(routes.authenticatedRouter);
  app.get("/api/other", (_req, res) => res.json({ other: true }));
  app.use(errorMiddleware);
  return { app, reads, expire: () => { now += PAGE_RENDER_TOKEN_LIFETIME_MS; }, remove: () => { exists = false; } };
}

async function mint(app: express.Express): Promise<string> {
  const response = await request(app).post(mintPath).set("Authorization", "Bearer owner").expect(200);
  expect(response.body.url).toMatch(/^\/page-render\/[A-Za-z0-9_-]{43}$/u);
  expect(response.headers["cache-control"]).toBe("no-store");
  return response.body.url as string;
}

describe("page render document authority", () => {
  it("mints only authenticated scoped revisions and serves only that immutable document", async () => {
    const { app, reads } = fixture();
    await request(app).post(mintPath).expect(401);
    await request(app).post(mintPath).set("Authorization", "Bearer other").expect(404);
    const url = await mint(app);
    expect(reads).toHaveLength(0);
    const rendered = await request(app).get(url).expect(200);
    expect(rendered.text).toContain("Saved revision two");
    expect(rendered.text).toContain("sedes:page-size");
    expect(rendered.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(rendered.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(rendered.headers["content-security-policy"]).toContain("frame-ancestors 'self' capacitor-electron://localhost http://localhost");
    expect(rendered.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(rendered.headers["x-frame-options"]).toBeUndefined();
    expect(rendered.headers["referrer-policy"]).toBe("no-referrer");
    expect(rendered.headers["cache-control"]).toBe("no-store");
    expect(reads.at(-1)).toEqual({ scope, thread: threadId, page: pageId, revision: 2 });
    await request(app).get("/api/other").expect(401);
  });

  it("expires capabilities and rechecks deletion instead of retaining document bytes", async () => {
    const expired = fixture();
    const expiredUrl = await mint(expired.app);
    expired.expire();
    await request(expired.app).get(expiredUrl).expect(404);
    expect(expired.reads).toHaveLength(0);
    const deleted = fixture();
    const deletedUrl = await mint(deleted.app);
    deleted.remove();
    await request(deleted.app).get(deletedUrl).expect(404);
    await request(fixture().app).get(deletedUrl).expect(404);
  });

  it("admits packaged iframe navigation without weakening host, origin, or API guards", async () => {
    const { app } = fixture();
    const url = await mint(app);
    await request(app).get(url)
      .set("Sec-Fetch-Site", "cross-site").set("Sec-Fetch-Mode", "navigate").set("Sec-Fetch-Dest", "iframe")
      .set("Origin", "capacitor-electron://localhost").expect(200);
    await request(app).get(url)
      .set("Sec-Fetch-Site", "cross-site").set("Sec-Fetch-Mode", "navigate").set("Sec-Fetch-Dest", "iframe")
      .set("Origin", "https://attacker.example").expect(403);
    await request(app).get(url).set("Host", "attacker.example").expect(403);
    await request(app).get("/api/other").set("Sec-Fetch-Site", "cross-site")
      .set("Sec-Fetch-Mode", "navigate").set("Sec-Fetch-Dest", "iframe").expect(403);
    await request(app).get(url).set("Sec-Fetch-Site", "cross-site")
      .set("Sec-Fetch-Mode", "cors").set("Sec-Fetch-Dest", "empty").expect(403);
  });
});
