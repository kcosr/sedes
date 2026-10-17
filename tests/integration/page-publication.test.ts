import { testAgentToolExecutionAuthority } from "../support/agent-tool-execution-authority.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationAdmission } from "../../src/server/authentication/authentication-admission.js";
import { AuthenticationRepository } from "../../src/server/authentication/authentication-repository.js";
import { DatabaseAgentToolApplicationReader } from "../../src/server/agent-tools/application/database-agent-tool-application-reader.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import { SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { PageAgentToolService } from "../../src/server/agent-tools/tools/page-agent-tool-service.js";
import type { ConversationBinding, ConversationHandle } from "../../src/server/backends/contracts.js";
import type { AppConfig } from "../../src/server/config/config.js";
import { ConversationActorManager, type AcquiredConversationActor } from "../../src/server/conversations/conversation-actor-manager.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { PageRepository } from "../../src/server/db/repositories/page-repository.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { createNormalizedApp, type NormalizedAppDependencies } from "../../src/server/normalized-app.js";
import { PageService } from "../../src/server/pages/page-service.js";
import { HttpRequestOperationGate } from "../../src/server/runtime/application-shutdown.js";
import { downloadPageDocument } from "../../src/server/pages/html-download.js";
import { pageDownloadFileName } from "../../src/shared/page-download.js";
import type { BackendCapabilityDocument, BackendConversationSnapshot } from "../../src/shared/protocol/backend.js";
import { pagePublicationResultSchema } from "../../src/shared/protocol/pages.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { unavailablePrincipalAgentToolClientService } from "../support/agent-tool-http.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const configuration = parseResolvedBackendConfiguration({ schemaVersion: 10,
  executionEnvironments: [{ id: environmentId, kind: "local", label: "Local" }],
  backends: [{ id: "pi-primary", kind: "pi", label: "Pi", enabled: true, modelPolicy: { type: "catalog" } }],
  targets: [{ id: "pi-local", kind: "pi_sdk", label: "Pi", backendInstanceId: "pi-primary", executionEnvironmentId: environmentId, enabled: true }],
  defaultTargetId: "pi-local",
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-page-publication-"));
  cleanups.push(async () => { await rm(root, { force: true, recursive: true }); });
  const database = openOverlayDatabase(":memory:");
  cleanups.push(async () => { database.close(); });
  const localIdentity = new SingleUserIdentityProvider<Request>(database);
  const scope = localIdentity.getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(scope, { environmentId: environment.id, canonicalPath: root,
    displayName: "Pages", availability: "available", trustState: "trusted" }, 100);
  const source = legacy.createThread(scope, { workspaceId: workspace.id, title: "Page source" }, 110);
  const other = legacy.createThread(scope, { workspaceId: workspace.id, title: "Other thread" }, 120);
  applyBackendNormalizationMigration(database, { configuration, quiescentCutoverConfirmed: true, appliedAt: 200 });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  const inventory = new InventoryRepository(database);
  const repository = new PageRepository(database);
  const sourceThread = inventory.getThread(scope, source.thread.id).thread;
  const authenticationRepository = new AuthenticationRepository(root);
  cleanups.push(async () => { authenticationRepository.close(); });
  const authentication = new AuthenticationAdmission(authenticationRepository, "page-integration");
  cleanups.push(async () => { authentication.close(); });
  const owner = authenticationRepository.exchangePairing({ token: authenticationRepository.createPairing({ kind: "management" }).token,
    clientName: "Owner", kind: "device" })!;
  const otherPrincipal = authenticationRepository.exchangePairing({ token: authenticationRepository.createPairing({ kind: "management" }).token,
    clientName: "Other principal", kind: "device" })!;
  const otherTenant = authenticationRepository.exchangePairing({ token: authenticationRepository.createPairing({ kind: "management" }).token,
    clientName: "Other tenant", kind: "device" })!;
  const identity = { resolve: async (incoming: Request) => {
    const name = authentication.clientForRequest(incoming)?.name;
    return name === "Other principal" ? { ...scope, principalId: "different-principal" }
      : name === "Other tenant" ? { ...scope, tenantId: "different-tenant" } : scope;
  } };
  const csrf = (credential: string) => authentication.csrfForRequest({ headers: { authorization: `Bearer ${credential}` },
    rawHeaders: ["Authorization", `Bearer ${credential}`] } as IncomingMessage);

  const native: BackendConversationSnapshot = {
    orderedBackendTurnIds: ["native-turn"],
    turnsById: { "native-turn": { backendTurnId: "native-turn", status: "in_progress", orderedBackendItemIds: ["native-input"] } },
    itemsById: { "native-input": { backendItemId: "native-input", backendTurnId: "native-turn", semanticKind: "user_message",
      status: "completed", sourceOrder: 0, content: [{ kind: "text", text: { text: "Show a page" } }] } },
    runState: "running", activeBackendTurnId: "native-turn",
  };
  const capabilities: BackendCapabilityDocument = { revision: "test", actions: [], deliveryModes: ["submit"], steerTarget: null,
    composerAttachments: { fileStaging: false, nativeImage: false }, nonblockingQuestions: false, providerOutputArtifacts: { nativeImage: false },
    supportsHistory: true, branching: { availability: "unavailable", reason: { text: "No fork in fixture" } }, interactionKinds: [],
    usageAccounting: "unsupported", turnThroughput: "unsupported", usageSections: [], effectiveSettings: {} };
  const binding: ConversationBinding = { tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
    applicationThreadId: source.thread.id, backendInstanceId: sourceThread.backendInstanceId!, connectionProfileId: sourceThread.connectionProfileId!,
    executionEnvironmentId: environment.id, backendConversationId: "native-page-session", createdAt: "2026-10-11T00:00:00.000Z" };
  const validatedWorkspace = { canonicalPath: root, authorityRevision: 1,
    summary: { id: workspace.id, environmentId: environment.id, displayName: "Pages", displayPath: root,
      availability: "available" as const, trustState: "trusted" as const, revision: 0 } };
  let actors: ConversationActorManager;
  let acquired: AcquiredConversationActor;
  cleanups.push(async () => { acquired?.release(); await actors?.close(); });
  const startActor = async () => {
    const handle = { binding, automaticEviction: "requires_quiescence", subscribe: () => () => {},
      establishProjection: async () => ({ snapshot: native, handleSequence: -1, history: { operational: true }, subscribeFromNext: () => () => {} }),
      backendCapabilities: async () => capabilities, usage: async () => ({}), close: async () => {},
      history: async () => { const { runState: _run, activeBackendTurnId: _active, ...history } = native; return history; },
    } as unknown as ConversationHandle;
    actors = new ConversationActorManager({
      environments: { acquireLease: async () => ({ scope, workspace: validatedWorkspace,
        environment: { id: environment.id, label: "Local", availability: "available", diagnosticCode: null, revision: 0 }, release: async () => {} }) } as never,
      attachmentDelivery: {} as never, retentionMilliseconds: 60_000, runtimeBudget: 2,
      applicationPublications: (requestedScope, threadId, turnIds) => repository.publications(requestedScope, threadId, turnIds),
    });
    acquired = await actors.acquire({ scope, binding, workspace: validatedWorkspace, opaqueBindingDetail: "test",
      driver: { attach: async () => handle } as never }, { idleRelease: "retain" });
  };
  await startActor();
  const filesRead = vi.fn(async (_scope, threadId, filename, maximumBytes) => {
    expect(threadId).toBe(source.thread.id);
    expect(path.dirname(filename)).toBe(root);
    const content = await readFile(filename);
    if (content.byteLength > maximumBytes) throw new Error("file too large");
    return content;
  });
  const pages = new PageService({ repository, inventory, files: { readAbsoluteFile: filesRead },
    onPublished: (requestedScope, page) => actors.refreshApplicationPublications(requestedScope, page.threadId) });
  const sourceAuthority = new DatabaseAgentToolSourceAuthority(database, new Uint8Array(32).fill(7));
  const application = new DatabaseAgentToolApplicationReader(database, identity,
    { snapshot: async () => ({ thread: { inventoryState: "active", runState: "running" } }) } as never, sourceAuthority);
  const policies = new ThreadAgentToolPolicyRepository(database, createThreadAgentToolPolicyDependencies().eligibility);
  const initialPolicy = policies.get(scope, source.thread.id);
  policies.update(scope, source.thread.id, { expectedRevision: initialPolicy.revision, enabled: true,
    presentation: { surface: "cli", mode: "individual" }, resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
    enabledToolIds: ["page.publish", "page.get", "page.list", "page.revisions", "page.preview"], now: 300 });
  const canonical = new CanonicalInlineAgentToolService({ application,
    pages: new PageAgentToolService({ pages, capturePublication: (requestedScope, threadId) => actors.captureApplicationPublication(requestedScope, threadId) }) });
  cleanups.push(async () => { await canonical.close(); });
  const scoped = new SourceScopedAgentToolService(canonical,
policies,
new AgentToolEnvironmentAuthorityResolver(sourceAuthority),
sourceAuthority, testAgentToolExecutionAuthority);
  const sourceCapability = sourceAuthority.issue(sourceAuthority.resolveInScope(scope, source.thread.id, new AbortController().signal), "management_http", "cli");
  const config: AppConfig = { authenticationRequired: true, experimentalUsageEnabled: false, host: "127.0.0.1", port: 4784,
    stateDirectory: root, allowedTailscaleHosts: [], packagedClientOrigins: ["capacitor-electron://localhost"],
    conversationRetentionMilliseconds: 60_000, conversationRuntimeBudget: 2 };
  const requestOperations = new HttpRequestOperationGate();
  const app = createNormalizedApp({ workpads: {}, pages, requestOperations, config, csrfToken: "tool-csrf", identity, authentication,
    agentTools: { sources: application, clients: unavailablePrincipalAgentToolClientService(), tools: new PolicyCheckedAgentToolHttpService(scoped) },
  } as unknown as NormalizedAppDependencies);
  const invoke = (toolId: string, input: unknown) => request(app).post("/api/agent-tool-invocations")
    .set(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER, sourceCapability).set("X-CSRF-Token", "tool-csrf")
    .send({ requestId: randomUUID(), toolId, schemaVersion: 1, input });
  const restartActor = async () => { acquired.release(); await actors.close(); await startActor(); };
  return { root, database, scope, repository, app, invoke, owner, otherPrincipal, otherTenant, csrf, filesRead, requestOperations,
    threadId: source.thread.id, otherThreadId: other.thread.id, actor: () => acquired.actor, restartActor };
}

describe("page publishing through normalized application", () => {
  it("downloads exact saved revisions with captured images after source deletion, without the preview runtime", async () => {
    const current = await fixture();
    const filename = path.join(current.root, "export.html");
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/i8AAAAASUVORK5CYII=", "base64");
    await writeFile(path.join(current.root, "logo.png"), imageBytes);
    await writeFile(filename, '<!doctype html><html><head><meta charset="windows-1252"><style>.picture{background:url(logo.png)}</style></head><body><h1>Résumé 世界 🌍</h1><img src="logo.png"><input value="saved"></body></html>');
    const result = await current.invoke("page.publish", { path: filename, title: "Résumé 世界" }).expect(200);
    const { page } = pagePublicationResultSchema.parse(result.body.output);
    await rm(filename);
    await rm(path.join(current.root, "logo.png"));
    const newer = await current.invoke("page.publish", { html: "<h1>Newer revision</h1>", title: "Changed title", pageId: page.pageId, expectedRevision: 1 }).expect(200);
    const newerPage = pagePublicationResultSchema.parse(newer.body.output).page;
    const route = `/api/threads/${current.threadId}/pages/${page.pageId}/revisions/1/download`;
    const expected = downloadPageDocument(current.repository.content(current.scope, current.threadId, page.pageId, 1));
    const head = await request(current.app).head(route).auth(current.owner.credential, { type: "bearer" })
      .set("Origin", "capacitor-electron://localhost").expect(200)
      .expect("Content-Type", "application/octet-stream")
      .expect("Cache-Control", "private, no-store")
      .expect("Content-Length", String(page.byteSize + 3))
      .expect("X-Content-Type-Options", "nosniff")
      .expect("X-Sedes-Download-Revision", page.sha256);
    expect(head.text).toBeUndefined();
    expect(head.headers["x-sedes-workspace-file-revision"]).toBeUndefined();
    expect(head.headers["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent(pageDownloadFileName(page.title, 1))}`);
    expect(head.headers["access-control-expose-headers"]).toBe("Content-Disposition, Content-Length, X-Sedes-Download-Revision");
    const download = await request(current.app).get(route).auth(current.owner.credential, { type: "bearer" }).expect(200);
    expect(download.body).toEqual(expected);
    const html = (download.body as Buffer).subarray(3).toString("utf8");
    expect(html).toContain("Résumé 世界 🌍");
    expect(html).not.toContain("Newer revision");
    expect(html).toContain(`data:image/png;base64,${imageBytes.toString("base64")}`);
    expect(html).toContain('<input value="saved">');
    expect(html).not.toContain("sedes-page-document");
    expect(html).not.toContain("sedes:page-submit");
    expect(current.filesRead).toHaveBeenCalledTimes(2);
    const second = await request(current.app).get(route.replace("/1/download", "/2/download"))
      .auth(current.owner.credential, { type: "bearer" }).expect(200)
      .expect("X-Sedes-Download-Revision", newerPage.sha256);
    expect((second.body as Buffer).toString("utf8")).toContain("Newer revision");
    expect((second.body as Buffer).toString("utf8")).not.toContain("data:image/png");
    await request(current.app).get(route).auth(current.owner.credential, { type: "bearer" }).set("Range", "bytes=0-1").expect(416);
    await request(current.app).head(route).auth(current.owner.credential, { type: "bearer" }).set("Range", "bytes=0-1").expect(416);
  });

  it("requires scoped authentication for page downloads and denies deleted, missing, and shutdown revisions", async () => {
    const current = await fixture();
    const result = await current.invoke("page.publish", { html: "<h1>Private export</h1>", title: "Private" }).expect(200);
    const { page } = pagePublicationResultSchema.parse(result.body.output);
    const route = `/api/threads/${current.threadId}/pages/${page.pageId}/revisions/1/download`;
    for (const method of ["head", "get"] as const) {
      await request(current.app)[method](route).expect(401);
      await request(current.app)[method](route).auth(current.otherPrincipal.credential, { type: "bearer" }).expect(404);
      await request(current.app)[method](route).auth(current.otherTenant.credential, { type: "bearer" }).expect(404);
      await request(current.app)[method](route.replace(current.threadId, current.otherThreadId)).auth(current.owner.credential, { type: "bearer" }).expect(404);
      await request(current.app)[method](route.replace("/1/download", "/2/download")).auth(current.owner.credential, { type: "bearer" }).expect(404);
    }
    const mint = await request(current.app).post(route.replace("/download", "/render-token"))
      .auth(current.owner.credential, { type: "bearer" }).set("X-CSRF-Token", current.csrf(current.owner.credential)).expect(200);
    await request(current.app).get(route).auth(mint.body.url.split("/").at(-1), { type: "bearer" }).expect(401);
    current.database.prepare("DELETE FROM html_pages WHERE tenant_id=? AND owner_principal_id=? AND thread_id=? AND id=?")
      .run(current.scope.tenantId, current.scope.principalId, current.threadId, page.pageId);
    await request(current.app).get(route).auth(current.owner.credential, { type: "bearer" }).expect(404);
    await current.requestOperations.close();
    const read = vi.spyOn(current.repository, "content");
    await request(current.app).get(route).auth(current.owner.credential, { type: "bearer" }).expect(500);
    expect(read).not.toHaveBeenCalled();
  });

  it("publishes file and inline revisions through authenticated tools, preserves chat anchors, and renders immutable scoped content", async () => {
    const current = await fixture();
    const filename = path.join(current.root, "mockup.html");
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/i8AAAAASUVORK5CYII=", "base64");
    await writeFile(path.join(current.root, "logo.png"), imageBytes);
    await writeFile(filename, '<!doctype html><html><body><h1>First design</h1><img src="logo.png"></body></html>');
    const firstResponse = await current.invoke("page.publish", { path: filename, title: "Mock-up", viewport: { width: 390 } }).expect(200);
    const first = pagePublicationResultSchema.parse(firstResponse.body.output);
    expect(first.changed).toBe(true);
    expect(first.page.revision).toBe(1);
    expect(current.filesRead).toHaveBeenCalledTimes(2);
    await rm(path.join(current.root, "logo.png"));
    const secondResponse = await current.invoke("page.publish", { html: "<h1>Second design</h1>", title: "Mock-up", pageId: first.page.pageId,
      expectedRevision: 1, viewport: { width: 390 } }).expect(200);
    const second = pagePublicationResultSchema.parse(secondResponse.body.output);
    expect(second.page.revision).toBe(2);
    expect(current.filesRead).toHaveBeenCalledTimes(2);
    const noChange = await current.invoke("page.publish", { html: "<h1>Second design</h1>", title: "Mock-up", pageId: first.page.pageId,
      expectedRevision: 2, viewport: { width: 390 } }).expect(200);
    expect(noChange.body.output).toEqual({ page: second.page, changed: false });
    const originalSource = await current.invoke("page.get", { pageId: first.page.pageId, revision: 1 }).expect(200);
    expect(originalSource.body.output.sourcePath).toBe(filename);
    const inlineSource = await current.invoke("page.get", { pageId: first.page.pageId, revision: 2 }).expect(200);
    expect(inlineSource.body.output).not.toHaveProperty("sourcePath");
    const timeline = current.actor().timeline;
    expect(Object.values(timeline.itemsById).filter(item => item.kind === "page").map(item => item.page.revision)).toEqual([1, 2]);
    expect(current.repository.publications(current.scope, current.threadId)).toHaveLength(2);
    const history = await current.actor().history({ limit: 10 });
    expect(Object.values(history.page.itemsById).filter(item => item.kind === "page").map(item => item.page.revision)).toEqual([1, 2]);
    await current.restartActor();
    expect(current.actor().timeline.itemsById).toEqual(timeline.itemsById);
    const list = await request(current.app).get(`/api/threads/${current.threadId}/pages`).auth(current.owner.credential, { type: "bearer" }).expect(200);
    expect(list.body.items).toEqual([second.page]);
    const revisions = await request(current.app).get(`/api/threads/${current.threadId}/pages/${first.page.pageId}/revisions?limit=1`)
      .auth(current.owner.credential, { type: "bearer" }).expect(200);
    expect(revisions.body.items).toEqual([second.page]);
    const earlier = await request(current.app).get(`/api/threads/${current.threadId}/pages/${first.page.pageId}/revisions?limit=1&cursor=${encodeURIComponent(revisions.body.nextCursor)}`)
      .auth(current.owner.credential, { type: "bearer" }).expect(200);
    expect(earlier.body.items).toEqual([first.page]);
    const get = await request(current.app).get(`/api/threads/${current.threadId}/pages/${first.page.pageId}/revisions/1`)
      .auth(current.owner.credential, { type: "bearer" }).expect(200);
    expect(get.body).toEqual({ page: first.page });
    expect(JSON.stringify(get.body)).not.toContain("First design");
    const tokenRoute = `/api/threads/${current.threadId}/pages/${first.page.pageId}/revisions/1/render-token`;
    const mint = await request(current.app).post(tokenRoute).auth(current.owner.credential, { type: "bearer" })
      .set("X-CSRF-Token", current.csrf(current.owner.credential)).expect(200);
    const rendered = await request(current.app).get(mint.body.url).expect(200);
    expect(rendered.text).toContain("First design");
    expect(rendered.text).not.toContain("Second design");
    expect(rendered.text).toContain(`data:image/png;base64,${imageBytes.toString("base64")}`);
    expect(rendered.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(rendered.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(rendered.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(rendered.headers["x-frame-options"]).toBeUndefined();
    expect(rendered.headers["cache-control"]).toBe("no-store");
    await request(current.app).get(mint.body.url).set("Origin", "capacitor-electron://localhost")
      .set("Sec-Fetch-Site", "cross-site").set("Sec-Fetch-Mode", "navigate").set("Sec-Fetch-Dest", "iframe").expect(200);
    await request(current.app).get(mint.body.url).set("Origin", "https://attacker.example")
      .set("Sec-Fetch-Site", "cross-site").set("Sec-Fetch-Mode", "navigate").set("Sec-Fetch-Dest", "iframe").expect(403);
  });

  it("denies absent, wrong-scope, wrong-thread, and reused document authority at the actual HTTP boundary", async () => {
    const current = await fixture();
    const published = await current.invoke("page.publish", { html: "<h1>Private page</h1>", title: "Private" }).expect(200);
    const { page } = pagePublicationResultSchema.parse(published.body.output);
    const route = `/api/threads/${current.threadId}/pages/${page.pageId}/revisions/1`;
    await request(current.app).get(`/api/threads/${current.threadId}/pages`).expect(401);
    await request(current.app).get(`/api/threads/${current.threadId}/pages`).auth(current.otherPrincipal.credential, { type: "bearer" }).expect(404);
    await request(current.app).get(route).auth(current.otherPrincipal.credential, { type: "bearer" }).expect(404);
    await request(current.app).get(`/api/threads/${current.otherThreadId}/pages/${page.pageId}/revisions/1`)
      .auth(current.owner.credential, { type: "bearer" }).expect(404);
    await request(current.app).post(`${route}/render-token`).expect(401);
    await request(current.app).post(`${route}/render-token`).auth(current.owner.credential, { type: "bearer" }).expect(403);
    await request(current.app).post(`${route}/render-token`).auth(current.otherPrincipal.credential, { type: "bearer" })
      .set("X-CSRF-Token", current.csrf(current.otherPrincipal.credential)).expect(404);
    const mint = await request(current.app).post(`${route}/render-token`).auth(current.owner.credential, { type: "bearer" })
      .set("X-CSRF-Token", current.csrf(current.owner.credential)).expect(200);
    await request(current.app).get(route).auth(mint.body.url.split("/").at(-1), { type: "bearer" }).expect(401);
    await current.invoke("page.publish", { html: "<h1>Invalid</h1>", path: path.join(current.root, "both.html"), title: "Both sources" }).expect(400);
    await current.invoke("page.publish", { html: "<h1>Stale</h1>", title: "Stale", pageId: page.pageId, expectedRevision: 99 }).expect(409);
    await current.actor().close();
    await current.invoke("page.publish", { html: "<h1>Too late</h1>", title: "Ended turn" }).expect(503);
    await request(current.app).get(mint.body.url).expect(200);
    current.database.prepare("DELETE FROM html_pages WHERE tenant_id=? AND owner_principal_id=? AND thread_id=? AND id=?")
      .run(current.scope.tenantId, current.scope.principalId, current.threadId, page.pageId);
    await request(current.app).get(mint.body.url).expect(404);
  });
});
