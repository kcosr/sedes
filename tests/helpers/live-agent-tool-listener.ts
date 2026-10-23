import { testAgentToolExecutionAuthority } from "../support/agent-tool-execution-authority.js";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Request } from "express";
import { ApplicationSnapshotPublicationBoundary } from "../../src/server/application/application-snapshot-service.js";
import { DatabaseAgentToolApplicationReader } from "../../src/server/agent-tools/application/database-agent-tool-application-reader.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import type { AppConfig } from "../../src/server/config/config.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { deriveConnectionProfileId } from "../../src/server/db/connection-profile-id.js";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import {
  createNormalizedApp,
  type NormalizedAppDependencies,
} from "../../src/server/normalized-app.js";
import type { AgentToolPresentation } from "../../src/shared/protocol/conversation.js";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { initializeDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { PageRepository } from "../../src/server/db/repositories/page-repository.js";
import { PageService } from "../../src/server/pages/page-service.js";
import { PagePreviewBrowser } from "../../src/server/pages/preview-browser.js";
import { PageAgentToolService } from "../../src/server/agent-tools/tools/page-agent-tool-service.js";
import { ImageShowAgentToolService } from "../../src/server/agent-tools/tools/image-show-agent-tool-service.js";
import { ImageShowRepository } from "../../src/server/db/repositories/image-show-repository.js";
import { OutputImageArtifactRepository } from "../../src/server/db/repositories/output-image-artifact-repository.js";
import { ImageShowService } from "../../src/server/output-artifacts/image-show-service.js";
import { OutputArtifactService } from "../../src/server/output-artifacts/service.js";
import { OutputArtifactBlobStore } from "../../src/server/output-artifacts/blob-store.js";

export interface ObservedAgentToolRequest {
  readonly method: string;
  readonly url: string;
  readonly sourceReference: string | undefined;
}

/**
 * A real normalized agent-tool listener over SQLite for opt-in live provider
 * suites: one unbound thread on the given target, its tool policy, and an
 * HTTP endpoint that records every agent-tool request it serves.
 */
export async function startLiveAgentToolListener(input: {
  readonly root: string;
  readonly workspace: string;
  readonly configuration: ConfigurationDocument;
  readonly environmentId: string;
  readonly targetId: string;
  readonly presentation: AgentToolPresentation;
  readonly enabledToolIds: readonly string[];
  /** Enable the real page service and preview browser. */
  readonly pages?: boolean;
  /** Exact test-owned source files; contents are never included in the prompt. */
  readonly pageSourceFiles?: readonly string[];
  /** Enable image.show for exact test-owned image paths, with real retained artifact storage. */
  readonly imageSourceFiles?: readonly string[];
}) {
  const database = openOverlayDatabaseConnection(
    path.join(input.root, "state", "overlay.sqlite"),
  );
  initializeEmptyBackendNormalizedDatabase(database);
  initializeDatabaseConfigurationFixture(database, input.configuration, {
    sourceLabel: "live-agent-tool-fixture",
    now: 100,
  });
  const identity = new SingleUserIdentityProvider<Request>(database);
  const scope = identity.getScope();
  const inventory = new InventoryRepository(database);
  const environment = inventory.updateEnvironmentAvailability(
    scope,
    input.environmentId,
    { available: true, now: 110 },
  );
  const workspace = inventory.upsertWorkspace(scope, {
    environmentId: input.environmentId,
    canonicalPath: input.workspace,
    displayName: "Live agent-tool workspace",
    project: { kind: "new", name: "Live agent-tool workspace" },
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision,
    now: 120,
  });
  const thread = new ConversationBindingRepository(
    database,
  ).createUnboundThread(scope, {
    workspaceId: workspace.id,
    connectionProfileId: deriveConnectionProfileId(
      scope.tenantId,
      scope.principalId,
      input.targetId,
    ),
    title: "Live agent-tool source",
    now: 300,
  });
  if (input.imageSourceFiles) {
    // Provider wiring is tested independently of the actor lifecycle here.
    // The private fixture binding lets image.show fence its real durable receipt.
    new ConversationBindingRepository(database).bindDiscoveredConversation(scope, thread.id, {
      backendConversationId: "live-image-tool-source", now: 301,
    });
  }
  const sources = new DatabaseAgentToolSourceAuthority(
    database,
    new Uint8Array(32).fill(7),
  );
  const application = new DatabaseAgentToolApplicationReader(
    database,
    identity,
    {
      snapshot: async () => ({
        thread: { inventoryState: "active", runState: "idle" },
      }),
    } as never,
    sources,
  );
  const policies = new ThreadAgentToolPolicyRepository(
    database,
    createThreadAgentToolPolicyDependencies().eligibility,
  );
  policies.update(scope, thread.id, {
    expectedRevision: policies.get(scope, thread.id).revision,
    enabled: true,
    presentation: input.presentation,
    resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
    enabledToolIds: [...input.enabledToolIds],
    now: 310,
  });
  const pageService = input.pages ? new PageService({ repository: new PageRepository(database), inventory,
    files: { readAbsoluteFile: async (_scope, _threadId, filePath, maximumBytes, signal) => {
      if (!input.pageSourceFiles?.includes(filePath)) throw new Error("live_fixture_source_not_allowed");
      const bytes = await readFile(filePath, { signal });
      if (bytes.length > maximumBytes) throw new Error("live_fixture_source_too_large");
      return bytes;
    } } }) : undefined;
  const preview = input.pages ? new PagePreviewBrowser() : undefined;
  const pageTools = pageService && preview ? new PageAgentToolService({ pages: pageService,
    capturePublication: () => ({ anchor: { turnId: "live-page-tool-turn" }, assertCurrent: () => undefined }),
    preview: async request => { const { png, imageWidth, imageHeight, ...metadata } = await preview.render(request);
      return { ...metadata, screenshot: { mimeType: "image/png", data: png.toString("base64"), width: imageWidth, height: imageHeight } }; },
  }) : undefined;
  const imageRepository = input.imageSourceFiles ? new ImageShowRepository(database) : undefined;
  const outputArtifacts = imageRepository ? new OutputArtifactService(new OutputArtifactBlobStore(input.root),
    new OutputImageArtifactRepository(database)) : undefined;
  await outputArtifacts?.initialize();
  const images = imageRepository && outputArtifacts ? new ImageShowService({ repository: imageRepository, artifacts: outputArtifacts,
    inventory, bindings: new ConversationBindingRepository(database), files: {
      readAbsoluteFile: async (requestScope, threadId, filePath, maximumBytes, signal) => {
        if (requestScope.tenantId !== scope.tenantId || requestScope.principalId !== scope.principalId || threadId !== thread.id ||
          !input.imageSourceFiles?.includes(filePath)) throw new Error("live_fixture_image_source_not_allowed");
        const bytes = await readFile(filePath, { signal });
        if (bytes.length > maximumBytes) throw new Error("live_fixture_image_source_too_large");
        return bytes;
      },
    } }) : undefined;
  const imageTools = images ? new ImageShowAgentToolService({ images,
    capturePublication: () => ({ anchor: { turnId: "live-image-tool-turn" }, assertCurrent: () => undefined }),
  }) : undefined;
  const canonical = new CanonicalInlineAgentToolService({
    application,
    ...(pageTools ? { pages: pageTools } : {}),
    ...(imageTools ? { images: imageTools } : {}),
    invocationId: () => "live-agent-tool-invocation",
  });
  const scopedTools = new SourceScopedAgentToolService(canonical,
policies,
new AgentToolEnvironmentAuthorityResolver(sources),
sources, testAgentToolExecutionAuthority);
  const config: AppConfig = {
    authenticationRequired: true, clientResponseCompression: true,
    experimentalUsageEnabled: false,
    host: "127.0.0.1",
    port: 4784,
    stateDirectory: path.join(input.root, "state"),
    allowedTailscaleHosts: [],
    packagedClientOrigins: [],
    conversationRetentionMilliseconds: 600_000,
    conversationRuntimeBudget: 8,
  };
  const app = createNormalizedApp({
    workpads: {} as never,
    config,
    csrfToken: "live-agent-tool-csrf",
    identity,
    applicationSnapshots: new ApplicationSnapshotPublicationBoundary(
      { capture: async () => ({}) } as never,
      new ScopedApplicationEventHubs(),
    ),
    agentTools: {
      sources: application,
      tools: new PolicyCheckedAgentToolHttpService(scopedTools),
    },
  } as unknown as NormalizedAppDependencies);
  const observed: ObservedAgentToolRequest[] = [];
  const server: Server = createServer((request, response) => {
    if (request.url?.startsWith("/api/agent-tool")) {
      observed.push({
        method: request.method ?? "",
        url: request.url,
        sourceReference: request.headers[
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER.toLowerCase()
        ] as string | undefined,
      });
    }
    app(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("live_agent_tool_listener_invalid");
  }
  const trustedSource = sources.resolveInScope(
    scope,
    thread.id,
    new AbortController().signal,
  );
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    threadId: thread.id,
    workspaceId: workspace.id,
    observed,
    pages: pageService,
    imagePublications: () => imageRepository?.publications(scope, thread.id) ?? [],
    outputArtifacts,
    scope,
    issue: (presentation: "cli" | "mcp") =>
      sources.issue(trustedSource, "management_http", presentation),
    async close() {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await canonical.close();
      await images?.close();
      database.close();
    },
  };
}
