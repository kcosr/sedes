import { createServer, type Server } from "node:http";
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
    accessBoundary: "environment",
    enabledToolIds: [...input.enabledToolIds],
    now: 310,
  });
  const scopedTools = new SourceScopedAgentToolService(
    new CanonicalInlineAgentToolService({
      application,
      invocationId: () => "live-agent-tool-invocation",
    }),
    policies,
    new AgentToolEnvironmentAuthorityResolver(sources),
    sources,
    {
      acquireAgentToolApprovalAuthority: async () => ({
        generation: "generation-1",
        signal: new AbortController().signal,
        isCurrent: () => true,
        release: () => undefined,
      }),
    },
    { requestApplicationDecision: async () => "allow" },
  );
  const config: AppConfig = {
    authenticationRequired: true,
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
    issue: (presentation: "cli" | "mcp") =>
      sources.issue(trustedSource, "management_http", presentation),
    async close() {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      database.close();
    },
  };
}
