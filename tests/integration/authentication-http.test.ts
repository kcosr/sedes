import { mkdtempSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createServer, get, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationAdmission } from "../../src/server/authentication/authentication-admission.js";
import { AuthenticationRepository, PAIRING_MAX_ATTEMPTS, PAIRING_RATE_LIMIT } from "../../src/server/authentication/authentication-repository.js";
import { loadConfig } from "../../src/server/config/config.js";
import { errorMiddleware } from "../../src/server/http/errors.js";
import { csrfGuard, hostOriginGuard, packagedClientCors } from "../../src/server/security/http-security.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(required = true, existingDirectory?: string) {
  const directory = existingDirectory ?? mkdtempSync(path.join(os.tmpdir(), "sedes-auth-http-"));
  const repository = new AuthenticationRepository(directory);
  const admission = new AuthenticationAdmission(repository, directory, { required });
  cleanups.push(() => { admission.close(); repository.close(); if (!existingDirectory) rmSync(directory, { recursive: true, force: true }); });
  const config = loadConfig({ APP_STATE_DIR: directory }, { schemaVersion: 11, packagedClients: ["android", "electron"] });
  const app = express();
  app.use(hostOriginGuard(config), packagedClientCors(config));
  app.use("/api/auth", admission.router());
  app.use(admission.middleware());
  app.use((req, res, next) => csrfGuard(admission.csrfForRequest(req))(req, res, next));
  app.get("/", (_req, res) => res.send("Public application shell"));
  app.get("/api/csrf", (req, res) => res.json({ csrfToken: admission.csrfForRequest(req) }));
  app.get("/api/private", (_req, res) => res.json({ private: true }));
  app.post("/api/private", (_req, res) => res.status(204).end());
  app.get("/api/stream", (_req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.write("data: ready\n\n"); });
  app.get("/api/outbound/artifacts/:hash/:part", (_req, res) => res.json({ artifact: true }));
  app.get("/api/outbound/connector/sedes-sidecar.mjs", (_req, res) => res.send("// public connector"));
  app.get("/api/agent-tools", (_req, res) => res.status(418).json({ independentlyAuthenticated: true }));
  app.get("/api/agent-tool-csrf", (_req, res) => res.json({ csrfToken: "public-agent-tool-token" }));
  app.get("/api/agent-tools/other", (_req, res) => res.send("private"));
  app.use(errorMiddleware);
  const api = request(app);
  const pair = (kind: "browser" | "device" | "sidecar", connectorId?: string) => api.post("/api/auth/pair")
    .set("Host", "127.0.0.1").send({ token: repository.createPairing({ kind: kind === "sidecar" ? "sidecar" : "management" }).token,
      clientName: kind, kind, ...(connectorId ? { connectorId } : {}) });
  return { app, api, pair, repository, admission, directory };
}

describe("authentication HTTP admission", () => {
  it("accepts normalized short codes and rejects further guesses after the installation-wide budget", async () => {
    const first = fixture();
    const token = first.repository.createPairing({ kind: "management" }).token;
    const paired = await first.api.post("/api/auth/pair").send({ token: `  ${token.toLowerCase().replace("-", "")}  `, clientName: "Phone", kind: "device" }).expect(200);
    expect(paired.body.credential).toHaveLength(43);
    const pending = first.repository.createPairing({ kind: "management" }).token;
    const wrong = pending === "BCDF-GHJK" ? "JKLM-NPQR" : "BCDF-GHJK";
    for (let n = 0; n < PAIRING_MAX_ATTEMPTS; n++) {
      await first.api.post("/api/auth/pair").set("X-Forwarded-For", `192.0.2.${n + 1}`).send({ token: wrong, clientName: "Guess", kind: "device" }).expect(401);
    }
    const reopened = fixture(true, first.directory);
    await reopened.api.post("/api/auth/pair").send({ token: pending, clientName: "Phone", kind: "device" }).expect(401);
    await reopened.api.get("/api/private").auth(paired.body.credential, { type: "bearer" }).expect(200);
  });

  it("rate limits malformed pairing requests durably across admission instances", async () => {
    const first = fixture();
    for (let n = 0; n < PAIRING_RATE_LIMIT; n++) await first.api.post("/api/auth/pair").send({ token: "invalid" }).expect(400);
    const reopened = fixture(true, first.directory);
    const valid = reopened.repository.createPairing({ kind: "management" }).token;
    await reopened.api.post("/api/auth/pair").set("X-Forwarded-For", "192.0.2.250").send({ token: valid, clientName: "Phone", kind: "device" }).expect(429);
  });

  it("leaves the shell public and denies APIs while preserving exact independent tool routes", async () => {
    const { api } = fixture();
    await api.get("/").set("Host", "127.0.0.1").expect(200);
    await api.get("/api/private").set("Host", "127.0.0.1").expect(401);
    await api.get("/api/agent-tools").set("Host", "127.0.0.1").expect(418);
    await api.get("/api/agent-tools/other").set("Host", "127.0.0.1").expect(401);
    await api.get("/api/outbound/connector/sedes-sidecar.mjs").set("Host", "127.0.0.1").expect(200);
    await api.get("/api/auth/status").set("Host", "127.0.0.1").expect({ required: true, authenticated: false });
  });

  it("preserves browser and device credentials across required, disabled, and required restarts", async () => {
    const enabled = fixture();
    const device = (await enabled.pair("device").expect(200)).body;
    const browser = await enabled.pair("browser").expect(200);
    const cookie = browser.headers["set-cookie"]![0]!.split(";")[0] as string;
    const disabled = fixture(false, enabled.directory);
    await disabled.api.get("/api/auth/status").expect({ required: false, authenticated: false });
    await disabled.api.get("/api/private").expect(200);
    await disabled.api.get("/api/private").set("Authorization", "Bearer expired-or-malformed").expect(200);
    const status = await disabled.api.get("/api/auth/status").auth(device.credential, { type: "bearer" }).expect(200);
    expect(status.body).toMatchObject({ required: false, authenticated: true, client: { id: device.client.id } });
    expect(status.headers["set-cookie"]).toBeUndefined();
    const browserStatus = await disabled.api.get("/api/auth/status").set("Cookie", cookie).expect(200);
    expect(browserStatus.body.client.id).toBe(browser.body.client.id);
    expect(browserStatus.headers["set-cookie"]).toBeUndefined();
    const csrf = (await disabled.api.get("/api/csrf").expect(200)).body.csrfToken;
    expect(csrf).toHaveLength(43);
    await disabled.api.post("/api/private").expect(403);
    await disabled.api.post("/api/private").set("X-CSRF-Token", csrf).set("Authorization", "invalid-old-credential").expect(204);
    await disabled.api.get("/api/private").set("Origin", "https://evil.example").expect(403);
    await disabled.api.get("/api/agent-tools").expect(418);
    const optionalPair = (await disabled.pair("device").expect(200)).body;
    const resumed = fixture(true, enabled.directory);
    await resumed.api.get("/api/private").expect(401);
    await resumed.api.get("/api/private").auth(device.credential, { type: "bearer" }).expect(200);
    await resumed.api.get("/api/private").set("Cookie", cookie).expect(200);
    await resumed.api.get("/api/private").auth(optionalPair.credential, { type: "bearer" }).expect(200);
    expect(resumed.repository.listClients()).toHaveLength(3);
  });

  it("ignores a revoked credential while disabled without restoring its authority on re-enable", async () => {
    const enabled = fixture();
    const device = (await enabled.pair("device").expect(200)).body;
    enabled.admission.revokeClient(device.client.id);
    const disabled = fixture(false, enabled.directory);
    await disabled.api.get("/api/private").auth(device.credential, { type: "bearer" }).expect(200);
    const resumed = fixture(true, enabled.directory);
    await resumed.api.get("/api/private").auth(device.credential, { type: "bearer" }).expect(401);
  });

  it("exchanges browser pairing once for an HttpOnly cookie and enforces client-bound CSRF", async () => {
    const { api, repository } = fixture();
    const token = repository.createPairing({ kind: "management" }).token;
    const input = { token, clientName: "browser", kind: "browser" };
    const paired = await api.post("/api/auth/pair").set("Host", "127.0.0.1").send(input).expect(200);
    expect(paired.body.credential).toBeUndefined();
    const setCookie = paired.headers["set-cookie"]![0] as string;
    expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("SameSite=Strict"); expect(setCookie).toContain("Path=/api");
    const cookie = setCookie.split(";")[0]!;
    await api.post("/api/auth/pair").set("Host", "127.0.0.1").send(input).expect(401);
    await api.get("/api/private").set("Host", "127.0.0.1").set("Cookie", cookie).expect(200);
    await api.post("/api/private").set("Host", "127.0.0.1").set("Cookie", cookie).expect(403);
    const csrf = await api.get("/api/csrf").set("Host", "127.0.0.1").set("Cookie", cookie).expect(200);
    const publicCsrf = await api.get("/api/agent-tool-csrf").set("Host", "127.0.0.1").expect(200);
    const forged = createHmac("sha256", publicCsrf.body.csrfToken).update(paired.body.client.id).digest("base64url");
    await api.post("/api/private").set("Host", "127.0.0.1").set("Cookie", cookie).set("X-CSRF-Token", forged).expect(403);
    await api.post("/api/private").set("Host", "127.0.0.1").set("Cookie", cookie).set("X-CSRF-Token", csrf.body.csrfToken).expect(204);
    await api.post("/api/auth/logout").set("Host", "127.0.0.1").set("Cookie", cookie).expect(403);
    await api.post("/api/auth/logout").set("Host", "127.0.0.1").set("Cookie", cookie).set("X-CSRF-Token", csrf.body.csrfToken).expect(204);
    await api.get("/api/private").set("Host", "127.0.0.1").set("Cookie", cookie).expect(401);
  });

  it("protects pairing by host/origin, rejects malformed input, and marks trusted proxy cookies secure", async () => {
    const { api, repository } = fixture();
    const input = { token: repository.createPairing({ kind: "management" }).token, clientName: "browser", kind: "browser" };
    await api.post("/api/auth/pair").set("Host", "evil.example").send(input).expect(403);
    await api.post("/api/auth/pair").set("Host", "127.0.0.1").set("Origin", "https://evil.example").send(input).expect(403);
    await api.post("/api/auth/pair").set("Host", "127.0.0.1").send({ ...input, connectorId: "injected" }).expect(400);
    const paired = await api.post("/api/auth/pair").set("Host", "127.0.0.1").set("X-Forwarded-Host", "localhost").set("X-Forwarded-Proto", "https").send(input).expect(200);
    expect(paired.headers["set-cookie"]![0]).toContain("Secure");
  });

  it("admits native bearer credentials and limits sidecars to artifacts and their connector identity", async () => {
    const { api, pair, admission } = fixture();
    const device = await pair("device").expect(200);
    expect(device.headers["set-cookie"]).toBeUndefined();
    await api.get("/api/private").set("Host", "127.0.0.1").auth(device.body.credential, { type: "bearer" }).expect(200);
    const sidecar = await pair("sidecar", "connector-1").expect(200);
    expect(sidecar.body.client.connectorId).toBe("connector-1");
    await api.get("/api/private").set("Host", "127.0.0.1").auth(sidecar.body.credential, { type: "bearer" }).expect(403);
    await api.get("/api/auth/clients").set("Host", "127.0.0.1").auth(sidecar.body.credential, { type: "bearer" }).expect(403);
    await api.get("/api/outbound/artifacts/abcdef/manifest").set("Host", "127.0.0.1").auth(sidecar.body.credential, { type: "bearer" }).expect(200);
    await api.get("/api/outbound/artifacts/abcdef/other").set("Host", "127.0.0.1").auth(sidecar.body.credential, { type: "bearer" }).expect(403);
    admission.revokeConnector("connector-1");
    await api.get("/api/outbound/artifacts/abcdef/manifest").set("Host", "127.0.0.1").auth(sidecar.body.credential, { type: "bearer" }).expect(401);
  });

  it("allows exact packaged origins to preflight Authorization and rejects hostile origins", async () => {
    const { api } = fixture();
    const allowed = await api.options("/api/private").set("Host", "127.0.0.1").set("Origin", "capacitor-electron://localhost")
      .set("Access-Control-Request-Method", "GET").set("Access-Control-Request-Headers", "authorization").expect(204);
    expect(String(allowed.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
    await api.options("/api/private").set("Host", "127.0.0.1").set("Origin", "http://localhost.evil.example")
      .set("Access-Control-Request-Method", "GET").set("Access-Control-Request-Headers", "authorization").expect(403);
  });

  it("rejects ambiguous credentials and never falls back from an invalid bearer to a valid cookie", async () => {
    const { api, pair } = fixture();
    const browser = await pair("browser").expect(200);
    const cookie = browser.headers["set-cookie"]![0]!.split(";")[0] as string;
    await api.get("/api/private").set("Host", "127.0.0.1").set("Cookie", `${cookie}; ${cookie}`).expect(401);
    await api.get("/api/private").set("Host", "127.0.0.1").set("Cookie", cookie).set("Authorization", "Bearer invalid").expect(401);
  });

  it("binds one-use tickets to the issuing actor and checks expiry/revocation on consumption", async () => {
    const { admission, pair } = fixture();
    const first = (await pair("device")).body.client;
    const second = (await pair("device")).body.client;
    admission.bindTicket("first-ticket", first.id, Date.now() + 60_000);
    expect(admission.consumeTicket("first-ticket").id).toBe(first.id);
    expect(() => admission.consumeTicket("first-ticket")).toThrow();
    admission.bindTicket("expired-ticket", first.id, Date.now() - 1);
    expect(() => admission.consumeTicket("expired-ticket")).toThrow();
    admission.bindTicket("second-ticket", second.id, Date.now() + 60_000);
    admission.revokeClient(first.id);
    expect(admission.consumeTicket("second-ticket").id).toBe(second.id);
    admission.bindTicket("revoked-ticket", second.id, Date.now() + 60_000);
    admission.revokeClient(second.id);
    expect(() => admission.consumeTicket("revoked-ticket")).toThrow();
    expect(() => admission.bindTicket("stale", first.id, Date.now() + 60_000)).toThrow();
  });

  it("closes open SSE immediately on HTTP revocation and on the offline CLI polling boundary", async () => {
    const { app, api, pair, directory } = fixture();
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing server address");
    async function stream(credential: string) {
      let closed = false;
      await new Promise<void>((resolve, reject) => {
        const req = get({ hostname: "127.0.0.1", port: (address as { port: number }).port, path: "/api/stream", headers: { Authorization: `Bearer ${credential}` } }, res => {
          res.once("data", () => resolve()); res.once("close", () => { closed = true; }); res.on("error", () => undefined);
        }); req.on("error", reject);
      });
      return () => closed;
    }
    const first = (await pair("device")).body;
    const firstClosed = await stream(first.credential);
    await api.delete(`/api/auth/clients/${first.client.id}`).set("Host", "127.0.0.1").auth(first.credential, { type: "bearer" }).expect(204);
    await vi.waitFor(() => expect(firstClosed()).toBe(true), { timeout: 500 });
    const second = (await pair("device")).body;
    const secondClosed = await stream(second.credential);
    const offline = new AuthenticationRepository(directory);
    try { offline.revokeClient(second.client.id); } finally { offline.close(); }
    await vi.waitFor(() => expect(secondClosed()).toBe(true), { timeout: 2_000 });
  });

  it("fails closed for tracked connections and tickets if revocation storage becomes unavailable", async () => {
    const { admission, pair, repository } = fixture();
    const client = (await pair("device")).body.client;
    admission.bindTicket("pending", client.id, Date.now() + 60_000);
    const close = vi.fn();
    admission.trackClient(client.id, () => { throw new Error("Broken transport"); });
    admission.trackClient(client.id, close);
    const lookup = vi.spyOn(repository, "listClients").mockImplementation(() => { throw new Error("Storage unavailable"); });
    expect(() => admission.refresh()).not.toThrow();
    expect(close).toHaveBeenCalledOnce();
    lookup.mockRestore();
    expect(() => admission.consumeTicket("pending")).toThrow();
  });
});
