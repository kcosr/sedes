import { once } from "node:events";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNormalizedApp } from "../../src/server/normalized-app.js";
import { directThreadExecutionWorkspaceLifecycle } from "../../src/server/pi-sandbox/pi-sandbox-lifecycle-service.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" } as const;
const INDEX_HTML = "<!doctype html><title>Sedes</title><div id=\"root\"></div>\n";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A built client inside a checkout whose path has a dot-directory segment. */
async function clientDirectoryBehindDotDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-client-fallback-"));
  roots.push(root);
  const clientDirectory = path.join(root, ".worktrees", "sedes", "dist", "client");
  await mkdir(path.join(clientDirectory, "assets"), { recursive: true });
  await writeFile(path.join(clientDirectory, "index.html"), INDEX_HTML);
  await writeFile(path.join(clientDirectory, "assets", "app.js"), "export {};\n");
  return clientDirectory;
}

function createApp(clientDirectory: string) {
  const unused = () => {
    throw new Error("route_not_configured_for_test");
  };
  return createNormalizedApp({
    usage: {
      availability: unused,
      read: unused,
      analytics: unused,
    },
    workpads: {} as never,
    questions: {} as never,
    cannedPrompts: {} as never,
    turnBookmarks: unavailableTurnBookmarks(),
    workspaceDiffReviews: {} as never,
    config: {
      authenticationRequired: false,
      experimentalUsageEnabled: false,
      host: "127.0.0.1",
      port: 4783,
      stateDirectory: "/tmp/client-fallback-http-test",
      allowedTailscaleHosts: [],
      packagedClientOrigins: [],
      conversationRetentionMilliseconds: 600_000,
      conversationRuntimeBudget: 8,
      providerPulseUrl: "http://127.0.0.1:4317",
    },
    csrfToken: "fallback-csrf",
    identity: { resolve: async () => scope },
    notifications: {} as never,
    principalPreferences: {} as never,
    executionTargets: {
      read: async () => ({ executionTargets: [], defaultTargetId: null }),
      requireSelectable: async () => undefined,
    },
    savedAgents: {} as never,
    threadTemplates: {} as never,
    composerAttachments: {} as never,
    outputArtifacts: {} as never,
    applicationSnapshots: { handoffThreadChange: vi.fn() } as never,
    threads: { snapshot: unused } as never,
    history: { loadOlder: unused } as never,
    threadRuntimes: { quiet: unused } as never,
    threadSnapshots: { publish: unused } as never,
    lifecycle: { createServerDraft: unused } as never,
    inventory: {} as never,
    threadGroups: {} as never,
    tasks: {} as never,
    workspaceFiles: {} as never,
    threadArchives: {} as never,
    threadExecutionWorkspaces: directThreadExecutionWorkspaceLifecycle,
    threadForceResets: {} as never,
    attention: { automationContexts: [] } as never,
    execution: {} as never,
    automations: {} as never,
    automationPrechecks: {} as never,
    agentTools: unavailableAgentToolRouterDependencies(),
    lineage: {
      forkManual: unused,
      updatePlacement: unused,
      listDescendants: unused,
    },
    clientDirectory,
  });
}

function fixture(clientDirectory: string) {
  const app = createApp(clientDirectory);
  return (target: string) => request(app).get(target).set("Host", "127.0.0.1:4783");
}

const HASHED_SCRIPT = `export const message = ${JSON.stringify("compressible client text ".repeat(400))};\n`;

/** A built client with content-hashed and unhashed files. */
async function builtClientDirectory(): Promise<string> {
  const clientDirectory = await clientDirectoryBehindDotDirectory();
  await writeFile(path.join(clientDirectory, "assets", "index-AbC_12-z.js"), HASHED_SCRIPT);
  await writeFile(path.join(clientDirectory, "assets", "small-AbCd1234.css"), "body{margin:0}\n");
  await writeFile(path.join(clientDirectory, "assets", "unhashed.js"), HASHED_SCRIPT);
  await writeFile(path.join(clientDirectory, "assets", ".hidden-AbCd1234.js"), HASHED_SCRIPT);
  await writeFile(path.join(clientDirectory, "favicon.png"), Buffer.alloc(4_096, 7));
  await writeFile(path.join(clientDirectory, "..", "outside.js"), HASHED_SCRIPT);
  return clientDirectory;
}

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

async function listening(clientDirectory: string) {
  const server = createApp(clientDirectory).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  return (target: string, headers: Record<string, string> = {}, method = "GET") => new Promise<RawResponse>((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port, path: target, method,
      headers: { Host: "127.0.0.1:4783", ...headers } }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body: Buffer.concat(chunks) }));
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("client static fallback", () => {
  it("serves deep links when the checkout path contains a dot-directory", async () => {
    const get = fixture(await clientDirectoryBehindDotDirectory());

    for (const deepLink of ["/", "/settings/environments", "/threads/thread-1"]) {
      const response = await get(deepLink).expect(200);
      expect(response.headers["content-type"]).toMatch(/^text\/html/u);
      expect(response.text).toBe(INDEX_HTML);
    }
    await get("/assets/app.js")
      .expect(200)
      .expect("Content-Type", /javascript/u);
  });

  it("keeps unknown API routes out of the client fallback", async () => {
    const get = fixture(await clientDirectoryBehindDotDirectory());

    const response = await get("/api/not-a-route").expect(404);
    expect(response.text).not.toBe(INDEX_HTML);
  });
});

describe("client static assets", () => {
  const browserEncodings = { "Accept-Encoding": "gzip, deflate, br, zstd" };

  it("compresses hashed assets for immutable caching and keeps security headers", async () => {
    const get = await listening(await builtClientDirectory());
    const brotli = await get("/assets/index-AbC_12-z.js", browserEncodings);
    expect(brotli.status).toBe(200);
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(brotli.headers.vary).toMatch(/Accept-Encoding/u);
    expect(brotli.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(brotli.headers["content-type"]).toMatch(/javascript/u);
    expect(brotli.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(brotli.headers["x-content-type-options"]).toBe("nosniff");
    expect(Number(brotli.headers["content-length"])).toBe(brotli.body.length);
    expect(brotli.body.length).toBeLessThan(HASHED_SCRIPT.length / 4);
    expect(brotliDecompressSync(brotli.body).toString()).toBe(HASHED_SCRIPT);

    const gzipped = await get("/assets/index-AbC_12-z.js", { "Accept-Encoding": "gzip, br;q=0" });
    expect(gzipped.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gzipped.body).toString()).toBe(HASHED_SCRIPT);

    const identityEncodings: Record<string, string>[] = [{}, { "Accept-Encoding": "identity" }, { "Accept-Encoding": "gzip;q=0, br;q=0" }];
    for (const headers of identityEncodings) {
      const identity = await get("/assets/index-AbC_12-z.js", headers);
      expect(identity.status).toBe(200);
      expect(identity.headers["content-encoding"]).toBeUndefined();
      expect(identity.headers.vary).toMatch(/Accept-Encoding/u);
      expect(identity.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(identity.body.toString()).toBe(HASHED_SCRIPT);
    }
  });

  it("revalidates index.html and unhashed files and skips incompressible or tiny files", async () => {
    const get = await listening(await builtClientDirectory());
    for (const target of ["/", "/index.html", "/threads/thread-1"]) {
      const document = await get(target, browserEncodings);
      expect(document.status).toBe(200);
      expect(document.headers["cache-control"]).toBe("no-cache");
      expect(document.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(document.headers["content-encoding"]).toBeUndefined();
      expect(document.body.toString()).toBe(INDEX_HTML);
    }
    const unhashed = await get("/assets/unhashed.js", browserEncodings);
    expect(unhashed.headers["cache-control"]).toBe("no-cache");
    expect(unhashed.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(unhashed.body).toString()).toBe(HASHED_SCRIPT);
    const image = await get("/favicon.png", browserEncodings);
    expect(image.headers["content-encoding"]).toBeUndefined();
    expect(image.headers["cache-control"]).toBe("no-cache");
    expect(image.body).toEqual(Buffer.alloc(4_096, 7));
    const tiny = await get("/assets/small-AbCd1234.css", browserEncodings);
    expect(tiny.headers["content-encoding"]).toBeUndefined();
    expect(tiny.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(tiny.body.toString()).toBe("body{margin:0}\n");
  });

  it("answers conditional, HEAD and range requests and recompresses a replaced file", async () => {
    const clientDirectory = await builtClientDirectory();
    const get = await listening(clientDirectory);
    const target = "/assets/unhashed.js";
    const first = await get(target, browserEncodings);
    const etag = first.headers.etag!;
    expect(etag).toMatch(/^W\/".+-br"$/u);
    const unchanged = await get(target, { ...browserEncodings, "If-None-Match": etag });
    expect(unchanged.status).toBe(304);
    expect(unchanged.body.length).toBe(0);
    const head = await get(target, browserEncodings, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe("br");
    expect(head.headers["content-length"]).toBe(first.headers["content-length"]);
    expect(head.body.length).toBe(0);
    const range = await get(target, { ...browserEncodings, Range: "bytes=0-5" });
    expect(range.status).toBe(206);
    expect(range.headers["content-encoding"]).toBeUndefined();
    expect(range.body.toString()).toBe(HASHED_SCRIPT.slice(0, 6));

    const replacement = `export const replaced = ${JSON.stringify("replacement text ".repeat(400))};\n`;
    const file = path.join(clientDirectory, "assets", "unhashed.js");
    await writeFile(file, replacement);
    // Make the change signal deterministic rather than depending on timestamp resolution.
    await utimes(file, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    const replaced = await get(target, { ...browserEncodings, "If-None-Match": etag });
    expect(replaced.status).toBe(200);
    expect(replaced.headers.etag).not.toBe(etag);
    expect(brotliDecompressSync(replaced.body).toString()).toBe(replacement);
  });

  it("never serves dotfiles or files outside the client root and keeps the Host guard", async () => {
    const get = await listening(await builtClientDirectory());
    for (const target of ["/assets/.hidden-AbCd1234.js", "/assets/%2e%2e/%2e%2e/outside.js", "/..%2foutside.js", "/assets/..%5c..%5coutside.js"]) {
      const response = await get(target, browserEncodings);
      expect(response.body.toString()).not.toContain("compressible client text");
      expect(response.headers["content-encoding"]).toBeUndefined();
    }
    const foreign = await get("/assets/index-AbC_12-z.js", { ...browserEncodings, Host: "attacker.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.headers["content-encoding"]).toBeUndefined();
    expect(foreign.body.toString()).not.toContain("compressible client text");
  });
});
