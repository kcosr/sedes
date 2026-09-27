import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { link, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenCodeHttpClient, openCodeEndpoint } from "../../src/server/backends/opencode/opencode-http-client.js";
import { admitOpenCodeNativeProfile, admitOpenCodeRelease, openCodeOwnedEnvironment } from "../../src/server/backends/opencode/opencode-release.js";
import { canonicalOpenCodeStore } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { createOpenCodeNativeStoreLifecycle } from "../../src/server/backends/opencode/opencode-native-store.js";
import { OpenCodeRuntime } from "../../src/server/backends/opencode/opencode-runtime.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";

const roots: string[] = [];
const servers: Server[] = [];
const password = "fixture-private-password";
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-runtime-test-")); roots.push(root); return root;
}
async function server(input: { authenticated?: boolean; version?: string; redirect?: string; oversized?: boolean } = {}) {
  const requests: string[] = [];
  const http = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (input.authenticated !== false && request.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) {
      response.writeHead(401).end(); return;
    }
    if (input.redirect) { response.writeHead(302, { location: input.redirect }).end(); return; }
    if (request.url === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"evt_connected","type":"server.connected","data":{}}\n\n'); return;
    }
    response.setHeader("content-type", "application/json");
    response.end(input.oversized ? JSON.stringify("s".repeat(17 * 1024 * 1024)) : JSON.stringify({
      version: input.version ?? "2.0.18", pid: process.pid, urls: [], paths: { tmp: os.tmpdir() },
    }));
  });
  servers.push(http);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw new Error();
  return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}

describe("OpenCode v2 transport admission", () => {
  it.each(["http://localhost:1234", "http://127.1:1234", "http://2130706433:1234", "http://127.00.0.1:1234", "https://127.0.0.1:1234", "http://127.0.0.1", "http://user:secret@127.0.0.1:1234", "http://127.0.0.1:1234/path", "http://127.0.0.1:1234?credential=secret", "http://[::]:1234"])("rejects nonadmitted endpoint %s", value => {
    expect(() => openCodeEndpoint(value)).toThrow("opencode_endpoint_invalid");
  });
  it("accepts literal loopback and the exact pinned release", () => {
    expect(openCodeEndpoint("http://127.0.0.1:80/")).toBe("http://127.0.0.1:80");
    expect(openCodeEndpoint("http://[::1]:1234")).toBe("http://[::1]:1234");
    expect(admitOpenCodeRelease("2.0.18")).toBe("2.0.18");
    for (const version of ["1.0.0", "2.0.19", "v2.0.18", "2.0.18-beta"]) expect(() => admitOpenCodeRelease(version)).toThrow();
  });
  it("preserves native HOME/provider authentication while removing incompatible process inputs", () => {
    const ambientSedesSecrets = {
      SEDES_AGENT_TOOL_ENDPOINT: "outer-endpoint", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "outer-capability",
      SEDES_AGENT_TOOL_CLIENT_TOKEN: "outer-token", SEDES_AGENT_TOOL_CLI_MODE: "outer-mode",
      SEDES_OPENCODE_EXTERNAL_PASSWORD: "other-opencode-secret", SEDES_OPENCODE_PASSWORD_LOCAL: "another-secret",
      SEDES_CODEX_REMOTE_TOKEN: "other-codex-secret", SEDES_CODEX_TOKEN_LOCAL: "another-token",
    };
    const environment = { ...ambientSedesSecrets, HOME: "/operator", XDG_CONFIG_HOME: "/operator/config", PROVIDER_API_KEY: "native-secret", OPENCODE_SIMULATE: "1", OPENCODE_CONFIG: "/wrong", OPENCODE_CONFIG_CONTENT: "secret-content", OPENCODE_CLIENT: "wrong", OPENCODE_MODELS_URL: "https://wrong", OPENCODE_SERVER_PASSWORD: "old", OPENCODE_PASSWORD: "old", OPENCODE_DISABLE_AUTOUPDATE: "0" };
    const launch = openCodeOwnedEnvironment({ environment, nativeStorePath: "/operator/data/opencode.db", configDirectory: "/operator/config/opencode", password, marker: "marker" });
    expect(launch.HOME).toBe(environment.HOME);
    expect(launch.PROVIDER_API_KEY).toBe("native-secret");
    for (const name of Object.keys(ambientSedesSecrets)) expect(launch[name]).toBeUndefined();
    expect(launch.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(launch.OPENCODE_PASSWORD).toBe(password);
    expect(launch.OPENCODE_SIMULATE).toBeUndefined();
    expect(launch.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(launch.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(environment.OPENCODE_PASSWORD).toBe("old");
    expect(() => admitOpenCodeNativeProfile(Object.entries(launch).map(([name, value]) => `${name}=${value}`))).not.toThrow();
    expect(() => admitOpenCodeNativeProfile(["OPENCODE_SIMULATE=true"])).toThrow("opencode_simulation_profile_rejected");
    for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLIENT", "OPENCODE_MODELS_URL"]) {
      expect(() => admitOpenCodeNativeProfile([`${name}=incompatible-canary`])).toThrow("opencode_native_profile_incompatible");
    }
    expect(() => openCodeOwnedEnvironment({ environment: { ...environment, OPENCODE_DB: "/another/db" }, nativeStorePath: "/operator/data/opencode.db", configDirectory: "/operator/config/opencode", password, marker: "marker" })).toThrow("opencode_native_store_override_conflict");
  });
  it("authenticates and validates the official generated server response", async () => {
    const fixture = await server();
    const client = new OpenCodeHttpClient({ endpoint: fixture.endpoint, password });
    await client.requireAuthentication();
    await expect(client.info()).resolves.toMatchObject({ version: "2.0.18", pid: process.pid });
    client.close();
    await expect(client.info()).rejects.toThrow("opencode_request_aborted");
    expect(JSON.stringify(client)).not.toContain(password);
  });
  it("rejects absent server authentication, wrong credentials, redirects, unknown versions and oversized bodies", async () => {
    const unprotected = await server({ authenticated: false });
    await expect(new OpenCodeHttpClient({ endpoint: unprotected.endpoint, password }).requireAuthentication()).rejects.toThrow("opencode_authentication_required");
    const protectedServer = await server();
    await expect(new OpenCodeHttpClient({ endpoint: protectedServer.endpoint, password: "wrong" }).info()).rejects.toThrow("opencode_request_failed");
    const redirected = await server({ redirect: protectedServer.endpoint });
    await expect(new OpenCodeHttpClient({ endpoint: redirected.endpoint, password }).info()).rejects.toThrow();
    expect(protectedServer.requests).toEqual(["GET /api/info"]);
    const unknown = await server({ version: "1.0.0" });
    await expect(new OpenCodeHttpClient({ endpoint: unknown.endpoint, password }).info()).rejects.toThrow("opencode_release_incompatible");
    const oversized = await server({ oversized: true });
    await expect(new OpenCodeHttpClient({ endpoint: oversized.endpoint, password }).info()).rejects.toThrow();
  });
  it("bounds stalled response headers and cancels SSE subscribers without reconnecting", async () => {
    let requests = 0;
    const http = createServer((request, response) => {
      requests += 1;
      if (request.url === "/api/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"type":"server.connected","properties":{}}\n\n');
      }
      // Other routes deliberately never send headers.
    });
    servers.push(http);
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const address = http.address(); if (!address || typeof address === "string") throw new Error();
    const client = new OpenCodeHttpClient({ endpoint: `http://127.0.0.1:${address.port}`, password, requestMilliseconds: 50 });
    await expect(client.info()).rejects.toThrow("opencode_request_aborted");
    const subscription = client.events(value => {
      if (!value || typeof value !== "object" || !("type" in value) || value.type !== "server.connected") throw new Error();
      return value as import("@opencode/client").OpenCodeEvent;
    })[Symbol.asyncIterator]();
    await expect(subscription.next()).resolves.toMatchObject({ done: false, value: { type: "server.connected" } });
    const pending = subscription.next(); client.close();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(requests).toBe(2);
  });
});

describe.skipIf(process.platform !== "linux")("OpenCode native store and external ownership", () => {
  it("excludes duplicate Sedes owners and never deletes the canonical native database", async () => {
    const root = await directory();
    const store = path.join(root, "opencode.db"); await writeFile(store, "native history");
    const lifecycle = createOpenCodeNativeStoreLifecycle({ canonicalStorePath: store, label: "test", ownership: "external", hostIncarnation: "fixture-host" });
    const lease = await lifecycle.acquire();
    await expect(lifecycle.acquire()).rejects.toThrow("opencode_native_store_already_owned");
    await lease.release(); await lease.release();
    expect(await readFile(store, "utf8")).toBe("native history");
    const next = await lifecycle.acquire(); await next.release();
  });
  it("rejects symlink aliases rather than silently changing the durable native namespace", async () => {
    const root = await directory(); const store = path.join(root, "opencode.db");
    await writeFile(store, "native history"); const alias = path.join(root, "alias.db"); await symlink(store, alias);
    await expect(canonicalOpenCodeStore(alias, false)).rejects.toThrow("opencode_native_store_not_canonical");
    const hardlink = path.join(root, "linked.db"); await link(store, hardlink);
    await expect(canonicalOpenCodeStore(hardlink, false)).rejects.toThrow("opencode_native_store_identity_ambiguous");
  });
  it("retains tampered ownership evidence instead of releasing an unproved lease", async () => {
    const root = await directory(); const store = path.join(root, "opencode.db"); await writeFile(store, "native history");
    const lifecycle = createOpenCodeNativeStoreLifecycle({ canonicalStorePath: store, label: "test", ownership: "external", hostIncarnation: "fixture-host" });
    const lease = await lifecycle.acquire();
    const lock = (await readdir(root)).find(name => name.endsWith(".lock"))!;
    await writeFile(path.join(root, lock, "owner.json"), JSON.stringify({ token: "replacement" }));
    await expect(lease.release()).rejects.toThrow("opencode_native_store_release_unproved");
    await expect(lifecycle.acquire()).rejects.toThrow("opencode_native_store_recovery_required");
  });
  it("keeps an external server alive after references and disconnect, and fences store replacement", async () => {
    const root = await directory(); const store = path.join(root, "opencode.db"); await writeFile(store, "native history");
    const fixture = await server();
    const runtime = new OpenCodeRuntime({
      hostIncarnation: "fixture-host",
      authority: { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "local" },
      nativeStorePath: store, environment: {}, externalPassword: async () => password,
      connection: { ownership: "external", channel: { type: "http", url: fixture.endpoint } },
    });
    await runtime.start(); const first = runtime.acquire({ directory: root }); const second = runtime.acquire({ directory: root });
    first.release(); expect(second.client.lifetime.aborted).toBe(false);
    second.release(); expect(first.client.lifetime.aborted).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ state: "ready", references: 0 });
    const bound = runtime.acquire({ directory: root, session: {
      applicationThreadId: "thread", nativeSessionID: "ses_fixture", bindingFingerprint: "binding",
    } });
    const control = openCodeTestMutationControl("external-environment");
    await expect(bound.client.mutate("installSessionEnvironment", { sessionID: "ses_fixture", definitions: {},
      definitionFingerprint: configurationFingerprint({}), cliAdmissionId: null }, control))
      .rejects.toMatchObject({ delivery: "not_sent", code: "opencode_environment_topology_unsupported" });
    await bound.client.acknowledgeMutation("installSessionEnvironment", control.identity); bound.release();
    const withoutTools = runtime.acquire({ directory: root, session: {
      applicationThreadId: "thread", nativeSessionID: "ses_fixture", bindingFingerprint: "binding",
    } });
    const register = openCodeTestMutationControl("unavailable-tools");
    await expect(withoutTools.client.mutate("ensureMcpRegistration", { directory: root, registrationAdmissionId: "missing-admission" }, register))
      .rejects.toMatchObject({ delivery: "not_sent", code: "opencode_agent_tools_unavailable" });
    await withoutTools.client.acknowledgeMutation("ensureMcpRegistration", register.identity); withoutTools.release();
    await expect(runtime.stop()).rejects.toThrow("opencode_external_stop_forbidden");
    await rename(store, `${store}.old`); await writeFile(store, "replacement");
    await expect(runtime.assertCurrent()).rejects.toThrow("opencode_runtime_identity_changed");
    await expect(runtime.start()).rejects.toThrow("opencode_runtime_requires_explicit_cleanup");
    await expect(runtime.close()).resolves.toEqual({ cleanup: "proved", nativeInterrupts: "not_owned" });
    const stillRunning = new OpenCodeHttpClient({ endpoint: fixture.endpoint, password });
    await expect(stillRunning.info()).resolves.toMatchObject({ pid: process.pid });
    expect(fixture.requests.every(value => value === "GET /api/info" || value === "GET /api/event")).toBe(true);
    stillRunning.close();
  });
  it("does not revoke a healthy native owner when one identity probe is cancelled", async () => {
    const root = await directory(); const store = path.join(root, "opencode.db"); await writeFile(store, "native history");
    const fixture = await server();
    const runtime = new OpenCodeRuntime({
      hostIncarnation: "fixture-host",
      authority: { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "local" },
      nativeStorePath: store, environment: {}, externalPassword: async () => password,
      connection: { ownership: "external", channel: { type: "http", url: fixture.endpoint } },
    });
    try {
      await runtime.start();
      const generation = runtime.snapshot().generation;
      const cancelled = new AbortController(); cancelled.abort();
      await expect(runtime.assertCurrent(cancelled.signal)).rejects.toThrow("opencode_request_aborted");
      expect(runtime.snapshot()).toMatchObject({ state: "ready", generation });
      // Stop the HTTP fixture from responding only after admission, then cancel
      // a request that has actually crossed the wire rather than only a preflight.
      const http = servers.at(-1)!;
      http.removeAllListeners("request");
      let observed!: () => void;
      const entered = new Promise<void>(resolve => { observed = resolve; });
      http.on("request", () => observed());
      const abort = new AbortController();
      const pending = runtime.assertCurrent(abort.signal);
      const rejected = expect(pending).rejects.toThrow("opencode_request_aborted");
      await entered; abort.abort(); await rejected;
      expect(runtime.snapshot()).toMatchObject({ state: "ready", generation });
      const lease = runtime.acquire({ directory: root }); expect(lease.client.lifetime.aborted).toBe(false); lease.release();
    } finally { await runtime.close(); }
  });
  it("revokes acquired ports synchronously when runtime retirement starts", async () => {
    const root = await directory(); const store = path.join(root, "opencode.db"); await writeFile(store, "native history");
    const fixture = await server();
    const runtime = new OpenCodeRuntime({
      hostIncarnation: "fixture-host",
      authority: { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "local" },
      nativeStorePath: store, environment: {}, externalPassword: async () => password,
      connection: { ownership: "external", channel: { type: "http", url: fixture.endpoint } },
    });
    await runtime.start();
    const lease = runtime.acquire({ directory: root, session: { applicationThreadId: "thread", nativeSessionID: "ses_retiring", bindingFingerprint: "binding" } });
    const retiring = runtime.close();
    try {
      expect(lease.client.lifetime.aborted).toBe(true);
      await expect(lease.client.mutate("interruptSession", { sessionID: "ses_retiring" }, {
        identity: { origin: "application", applicationOperationId: "late-stop", operationKind: "interrupt", step: "interrupt" }, deadlineAt: Date.now() + 30_000,
      })).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
      expect(fixture.requests.every(request => request === "GET /api/info")).toBe(true);
    } finally { lease.release(); await retiring; }
  });
  it("fences restart when native ownership evidence cannot be safely released", async () => {
    const root = await directory(); const store = path.join(root, "opencode.db"); await writeFile(store, "native history");
    const fixture = await server();
    const runtime = new OpenCodeRuntime({
      hostIncarnation: "fixture-host",
      authority: { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "local" },
      nativeStorePath: store, environment: {}, externalPassword: async () => password,
      connection: { ownership: "external", channel: { type: "http", url: fixture.endpoint } },
    });
    await runtime.start();
    const lock = (await readdir(root)).find(name => name.endsWith(".lock"))!;
    await writeFile(path.join(root, lock, "owner.json"), JSON.stringify({ token: "replacement" }));
    await expect(runtime.close()).rejects.toThrow("opencode_owned_cleanup_unproved");
    expect(runtime.snapshot().state).toBe("cleanup_unproved");
    await expect(runtime.start()).rejects.toThrow("opencode_runtime_requires_explicit_cleanup");
    expect(await readFile(store, "utf8")).toBe("native history");
  });
});
