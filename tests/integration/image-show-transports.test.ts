import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import request from "supertest";
import { DatabaseAgentToolApplicationReader } from "../../src/server/agent-tools/application/database-agent-tool-application-reader.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import { SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { ImageShowAgentToolService } from "../../src/server/agent-tools/tools/image-show-agent-tool-service.js";
import { createPiAgentToolSet } from "../../src/server/backends/pi/pi-agent-tool-adapter.js";
import { PiToolAccessController } from "../../src/server/backends/pi/pi-tool-access.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ImageShowRepository } from "../../src/server/db/repositories/image-show-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { OutputImageArtifactRepository } from "../../src/server/db/repositories/output-image-artifact-repository.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { SingleUserIdentityProvider, type RequestScope } from "../../src/server/identity/identity-provider.js";
import { createNormalizedApp, type NormalizedAppDependencies } from "../../src/server/normalized-app.js";
import { ImageShowError } from "../../src/server/output-artifacts/image-show-error.js";
import { ImageShowService } from "../../src/server/output-artifacts/image-show-service.js";
import { OutputArtifactBlobStore } from "../../src/server/output-artifacts/blob-store.js";
import { OutputArtifactService } from "../../src/server/output-artifacts/service.js";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { unavailablePrincipalAgentToolClientService } from "../support/agent-tool-http.js";
import { buildSedesToolExecutable } from "../helpers/built-sedes-cli.js";

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
let built: Awaited<ReturnType<typeof buildSedesToolExecutable>>;
beforeAll(async () => { built = await buildSedesToolExecutable(); }, 60_000);
afterAll(async () => { if (built) await rm(built.buildRoot, { recursive: true, force: true }); });
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/i8AAAAASUVORK5CYII=", "base64");

/** Real canonical admission/storage and transport, with a test-owned Files reader and turn lease. */
async function fixture(kind: "pi" | "codex_app_server") {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-image-transport-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const database = openOverlayDatabaseConnection(":memory:");
  cleanups.push(async () => database.close());
  const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
  const configuration = parseResolvedBackendConfiguration({ schemaVersion: 10,
    executionEnvironments: [{ id: environmentId, kind: "local", label: "Local" }],
    backends: [{ id: "primary", kind, label: "Primary", enabled: true, modelPolicy: { type: "catalog" },
      ...(kind === "codex_app_server" ? { moduleConfiguration: {
        connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectory: root } },
        policy: { allowedSandboxModes: ["workspace-write"], allowedNetworkAccess: ["enabled"], allowedApprovalPolicies: ["never"], allowedApprovalReviewers: ["user"] },
      } } : {}),
    }],
    targets: [{ id: "local", kind: kind === "pi" ? "pi_sdk" : "codex_app_server", label: "Local", backendInstanceId: "primary", executionEnvironmentId: environmentId, enabled: true,
      ...(kind === "codex_app_server" ? { moduleConfiguration: { defaults: {
        sandboxMode: "workspace-write", networkAccess: "enabled", approvalPolicy: "never", approvalReviewer: "user", model: { type: "fixed", modelId: "gpt-5.6-luna" },
      } } } : {}),
    }],
    defaultTargetId: "local" });
  initializeEmptyBackendNormalizedDatabase(database);
  importLegacyDatabaseConfigurationFixture(database, { configuration, localWorkspaceRoots: [root], sourceLabel: "image-show-transports" }, 100);
  const identity = new SingleUserIdentityProvider<Request>(database);
  const scope = identity.getScope();
  const inventory = new InventoryRepository(database);
  const environment = inventory.updateEnvironmentAvailability(scope, environmentId, { available: true, now: 110 });
  const workspace = inventory.upsertWorkspace(scope, { environmentId, canonicalPath: root, displayName: "Images", project: { kind: "new", name: "Images" },
    available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 120 });
  const profile = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
  const bindings = new ConversationBindingRepository(database);
  const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId: profile.id, title: "Source", now: 130 });
  bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: "native-source", now: 140 });
  const source = path.join(root, "chart.png");
  await writeFile(source, png);
  const filesRead = vi.fn(async (requestScope: RequestScope, threadId: string, filename: string, maximumBytes: number, signal?: AbortSignal) => {
    expect(requestScope).toEqual(scope); expect(threadId).toBe(thread.id); expect(path.dirname(filename)).toBe(root);
    const content = await readFile(filename, { signal });
    if (content.length > maximumBytes) throw new ImageShowError("size");
    return content;
  });
  const artifacts = new OutputArtifactService(new OutputArtifactBlobStore(root), new OutputImageArtifactRepository(database));
  await artifacts.initialize();
  const images = new ImageShowService({ repository: new ImageShowRepository(database), files: { readAbsoluteFile: filesRead }, inventory, bindings, artifacts });
  const tools = new ImageShowAgentToolService({ images, capturePublication: (requestScope, threadId) => {
    expect(requestScope).toEqual(scope); expect(threadId).toBe(thread.id);
    return { anchor: { turnId: "active-turn", afterItemId: "active-item" }, assertCurrent: () => undefined };
  } });
  const sources = new DatabaseAgentToolSourceAuthority(database, new Uint8Array(32).fill(7));
  const application = new DatabaseAgentToolApplicationReader(database, identity,
    { snapshot: async () => ({ thread: { inventoryState: "active", runState: "running" } }) } as never, sources);
  const policies = new ThreadAgentToolPolicyRepository(database, createThreadAgentToolPolicyDependencies().eligibility);
  const setPolicy = (surface: "cli" | "native", mode: "individual" | "progressive", enabled = true) => policies.update(scope, thread.id, {
    expectedRevision: policies.get(scope, thread.id).revision, enabled, presentation: { surface, mode }, accessBoundary: "thread", enabledToolIds: ["image.show"], now: 200 });
  const canonical = new CanonicalInlineAgentToolService({ application, images: tools });
  cleanups.push(async () => { await canonical.close(); await images.close(); });
  const scoped = new SourceScopedAgentToolService(canonical, policies, new AgentToolEnvironmentAuthorityResolver(sources), sources,
    { acquireAgentToolApprovalAuthority: async () => { throw new Error("image.show must remain source-only"); } },
    { requestApplicationDecision: async () => { throw new Error("image.show must not request cross-thread access"); } });
  const app = createNormalizedApp({ workpads: {}, identity, csrfToken: "image-csrf", config: {
    authenticationRequired: true, experimentalUsageEnabled: false, host: "127.0.0.1", port: 4784, stateDirectory: root,
    allowedTailscaleHosts: [], packagedClientOrigins: [], conversationRetentionMilliseconds: 60_000, conversationRuntimeBudget: 2 },
    agentTools: { sources: application, clients: unavailablePrincipalAgentToolClientService(), tools: new PolicyCheckedAgentToolHttpService(scoped) },
  } as unknown as NormalizedAppDependencies);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const trustedSource = sources.resolveInScope(scope, thread.id, new AbortController().signal);
  const reference = (surface: "cli" | "mcp") => sources.issue(trustedSource, "management_http", surface);
  const environmentFor = (surface: "cli" | "mcp", mode: "individual" | "progressive") => {
    const env = { ...process.env };
    delete env.SEDES_AGENT_TOOL_CLIENT_TOKEN;
    return { ...env, SEDES_AGENT_TOOL_ENDPOINT: endpoint, SEDES_AGENT_TOOL_SOURCE_CAPABILITY: reference(surface), SEDES_AGENT_TOOL_CLI_MODE: mode };
  };
  return { root, database, app, source, filesRead, trustedSource, scoped, setPolicy, reference, environmentFor };
}

describe("image.show transports", () => {
  it("uses real CLI discovery and both command presentations without returning image bytes", async () => {
    const f = await fixture("pi");
    f.setPolicy("cli", "progressive");
    const run = (args: string[], mode: "individual" | "progressive" = "progressive") => execFileAsync(built.executable, args, { env: f.environmentFor("cli", mode), encoding: "utf8" });
    const listed = await run(["tool", "list", "--json"]);
    expect(listed.stderr).toBe(""); expect(listed.stdout).toContain('"image.show"');
    const described = await run(["tool", "describe", "image.show", "--json"]);
    expect(described.stdout).toContain("Show image"); expect(described.stdout).not.toContain("outputMediaTypes");
    const shown = await run(["tool", "invoke", "image.show", "--input-json", JSON.stringify({ path: f.source, title: "Results" }), "--json"]);
    expect(shown.stderr).toBe("");
    expect(JSON.parse(shown.stdout)).toMatchObject({ image: { mimeType: "image/png", alt: { text: "Results" } } });
    expect(shown.stdout).not.toContain("modelContent"); expect(shown.stdout).not.toContain(png.toString("base64"));
    f.setPolicy("cli", "individual");
    const direct = await run(["image", "show", "--path", f.source, "--title", "Direct", "--json"], "individual");
    expect(JSON.parse(direct.stdout)).toMatchObject({ image: { alt: { text: "Direct" } } });
    await writeFile(f.source, "This is text, not an image.");
    await expect(run(["image", "show", "--path", f.source, "--json"], "individual")).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("Only PNG, JPEG, GIF, and WebP images can be shown.") });
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM shown_images").get()).toEqual({ count: 2 });
  }, 60_000);

  it("uses real MCP individual and progressive write lanes with safe errors and live revocation", async () => {
    const f = await fixture("codex_app_server"); f.setPolicy("native", "individual");
    const connect = async (mode: "individual" | "progressive", surface: "mcp" | "cli" = "mcp") => {
      const transport = new StdioClientTransport({ command: built.executable, args: ["mcp", "--mode", mode],
        env: f.environmentFor(surface, mode) as Record<string, string>, stderr: "pipe" });
      const client = new Client({ name: "image-show-test", version: "1.0.0" });
      await client.connect(transport); cleanups.push(() => client.close()); return client;
    };
    const individual = await connect("individual");
    const catalog = await individual.listTools();
    expect(catalog.tools.map(tool => tool.name)).toEqual(["sedes_image_show"]);
    expect(catalog.tools[0]).toMatchObject({ description: expect.stringContaining("image"), annotations: { readOnlyHint: false } });
    const result = await individual.callTool({ name: "sedes_image_show", arguments: { path: f.source, title: "MCP" } });
    expect(result.structuredContent).toMatchObject({ image: { mimeType: "image/png", alt: { text: "MCP" } } });
    expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
    const invalid = await individual.callTool({ name: "sedes_image_show", arguments: { path: f.source, threadId: "another-thread" } });
    expect(invalid.isError).toBe(true);
    const missing = await individual.callTool({ name: "sedes_image_show", arguments: { path: path.join(f.root, "missing.png") } });
    expect(missing.isError).toBe(true); expect(JSON.stringify(missing)).toContain("unavailable through this thread's Files access");
    expect(JSON.stringify(missing)).not.toContain(f.root);
    expect((await (await connect("individual", "cli")).listTools()).tools).toEqual([]);
    f.setPolicy("native", "progressive");
    const progressive = await connect("progressive");
    expect((await progressive.listTools()).tools.map(tool => tool.name)).toEqual(["sedes_catalog", "sedes_act"]);
    const action = await progressive.callTool({ name: "sedes_act", arguments: { toolId: "image.show", schemaVersion: 1, input: { path: f.source } } });
    expect(action.structuredContent).toMatchObject({ image: { mimeType: "image/png" } });
    expect(action.content).toEqual([{ type: "text", text: expect.any(String) }]);
    f.setPolicy("native", "progressive", false);
    expect((await progressive.listTools()).tools).toEqual([]);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM shown_images").get()).toEqual({ count: 2 });
  }, 60_000);

  it("replays the exact HTTP request after source deletion and denies request-ID or source tampering", async () => {
    const f = await fixture("pi"); f.setPolicy("cli", "progressive");
    const invoke = (input: unknown, source = f.reference("cli")) => request(f.app).post("/api/agent-tool-invocations")
      .set(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER, source).set("X-CSRF-Token", "image-csrf")
      .send({ requestId: "same-image-request", toolId: "image.show", schemaVersion: 1, input });
    const first = await invoke({ path: f.source }).expect(200);
    await rm(f.source);
    const second = await invoke({ path: f.source }).expect(200);
    expect(second.body.output).toEqual(first.body.output); expect(second.body.invocationId).not.toBe(first.body.invocationId);
    expect(f.filesRead).toHaveBeenCalledTimes(1);
    expect(second.body.modelContent).toBeUndefined();
    const conflict = await invoke({ path: f.source, title: "Different" }).expect(409);
    expect(conflict.body.error.message).toContain("request ID was already used");
    await invoke({ path: f.source, threadId: "another-thread" }).expect(400);
    await invoke({ path: f.source }, "a".repeat(64)).expect(403);
    expect(f.filesRead).toHaveBeenCalledTimes(1);
  });

  it("publishes from Pi Native through canonical admission and keeps image bytes out of model content", async () => {
    const f = await fixture("pi"); f.setPolicy("native", "individual");
    const entries = [
      { type: "message", id: "user-entry", parentId: null, timestamp: "2026-10-13T00:00:00.000Z", message: { role: "user", content: "Show image" } },
      { type: "message", id: "assistant-entry", parentId: "user-entry", timestamp: "2026-10-13T00:00:01.000Z", message: { role: "assistant", content: [
        { type: "toolCall", id: "pi-show-call", name: "sedes_image_show", arguments: { path: f.source } },
      ] } },
    ] as SessionEntry[];
    const manager = { getBranch: () => entries, appendCustomEntry: (customType: string, data: unknown) => {
      const id = `marker-${entries.length}`; entries.push({ type: "custom", id, parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-10-13T00:00:02.000Z", customType, data } as SessionEntry); return id;
    } } as unknown as SessionManager;
    const set = createPiAgentToolSet({ facade: f.scoped, source: f.trustedSource, manager,
      authentication: { conversationId: "native-source", installationKey: new Uint8Array(32).fill(9) },
      providerTurnCorrelation: () => "user-entry", toolAccess: new PiToolAccessController("full") });
    const imageTool = set.tools.find(tool => tool.name === "sedes_image_show");
    expect(imageTool).toBeDefined();
    const shown = await imageTool!.execute("pi-show-call", { path: f.source }, undefined, undefined, {} as never);
    expect(shown.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(JSON.parse((shown.content[0] as { text: string }).text)).toMatchObject({ image: { mimeType: "image/png" } });
    expect(JSON.stringify(shown)).not.toContain(png.toString("base64"));
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM shown_images").get()).toEqual({ count: 1 });
  });
});
