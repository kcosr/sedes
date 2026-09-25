import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationSnapshotPublicationBoundary } from "../../src/server/application/application-snapshot-service.js";
import { DatabaseAgentToolApplicationReader } from "../../src/server/agent-tools/application/database-agent-tool-application-reader.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import type { AppConfig } from "../../src/server/config/config.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
  deployedMigrations,
} from "../../src/server/db/migrate.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import {
  createNormalizedApp,
  type NormalizedAppDependencies,
} from "../../src/server/normalized-app.js";
import { buildSedesToolExecutable } from "../helpers/built-sedes-cli.js";
import { unavailablePrincipalAgentToolClientService } from "../support/agent-tool-http.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

const roots: string[] = [];
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [{ id: environmentId, kind: "local", label: "Local" }],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
    {
      id: "codex-primary",
      kind: "codex_app_server",
      label: "Codex",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "pi-local",
      kind: "pi_sdk",
      label: "Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: environmentId,
      enabled: true,
    },
    {
      id: "codex-local",
      kind: "codex_app_server",
      label: "Codex",
      backendInstanceId: "codex-primary",
      executionEnvironmentId: environmentId,
      enabled: true,
    },
  ],
  defaultTargetId: "pi-local",
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("agent_tool_mcp_test_listener_invalid");
  }
  return address.port;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}

describe("built Sedes MCP server", () => {
  it("serves a Native Codex thread through the real listener and presentation-bound references", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-tool-mcp-e2e-"));
    roots.push(root);
    const built = await buildSedesToolExecutable();
    roots.push(built.buildRoot);

    const database = openOverlayDatabaseConnection(
      path.join(root, "state", "overlay.sqlite"),
    );
    let server: Server | undefined;
    const clients: Client[] = [];
    try {
      applyDatabaseMigrations(database, deployedMigrations);
      const identity = new SingleUserIdentityProvider<Request>(database);
      const scope = identity.getScope();
      const legacy = new ThreadInventoryService(new OverlayRepository(database));
      const environment = legacy.getLocalEnvironment(scope);
      const workspace = legacy.rememberWorkspace(
        scope,
        {
          environmentId: environment.id,
          canonicalPath: path.join(root, "workspace"),
          displayName: "MCP test workspace",
          availability: "available",
          trustState: "trusted",
        },
        100,
      );
      const source = legacy.createThread(
        scope,
        { workspaceId: workspace.id, title: "MCP source" },
        110,
      );
      applyBackendNormalizationMigration(database, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 200,
      });
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      // Rebind the unbound thread to the Codex instance: MCP is its Native tool
      // mechanism, while a Pi thread's Native surface admits only Pi SDK tools.
      database
        .prepare(
          `INSERT INTO agent_backend_instances(
             tenant_id, id, kind, label, enabled, protocol_release,
             created_at, updated_at, owner_principal_id
           ) VALUES (?, 'codex-primary', 'codex_app_server', 'Codex', 1,
             '0.153.0', 250, 250, ?)`,
        )
        .run(scope.tenantId, scope.principalId);
      database
        .prepare(
          `INSERT INTO agent_connection_profiles(
             tenant_id, owner_principal_id, id, template_id, backend_instance_id,
             backend_kind, execution_environment_id, kind, label, enabled,
             created_at, updated_at
           ) VALUES (?, ?, '10000000-0000-4000-8000-0000000000c0', 'codex-local',
             'codex-primary', 'codex_app_server', ?, 'codex_app_server', 'Codex',
             1, 250, 250)`,
        )
        .run(scope.tenantId, scope.principalId, environment.id);
      database
        .prepare(
          `UPDATE application_threads
           SET backend_instance_id = 'codex-primary',
             connection_profile_id = (
               SELECT profile.id FROM agent_connection_profiles AS profile
               WHERE profile.tenant_id = application_threads.tenant_id
                 AND profile.owner_principal_id = application_threads.owner_principal_id
                 AND profile.backend_instance_id = 'codex-primary'
                 AND profile.execution_environment_id = application_threads.environment_id
             )
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(scope.tenantId, scope.principalId, source.thread.id);

      const sourceAuthority = new DatabaseAgentToolSourceAuthority(
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
        sourceAuthority,
      );
      const policies = new ThreadAgentToolPolicyRepository(
        database,
        createThreadAgentToolPolicyDependencies().eligibility,
      );
      let revision = policies.get(scope, source.thread.id).revision;
      const setPresentation = (
        surface: "native" | "cli",
        mode: "progressive" | "individual",
      ) => {
        policies.update(scope, source.thread.id, {
          expectedRevision: revision,
          enabled: true,
          presentation: { surface, mode },
          accessBoundary: "environment",
          enabledToolIds: ["agent.context", "thread.status"],
          now: 300 + revision,
        });
        revision += 1;
      };
      setPresentation("native", "individual");

      const canonical = new CanonicalInlineAgentToolService({
        application,
        invocationId: () => "mcp-e2e-invocation",
      });
      const agentTools = {
        sources: application,
        clients: unavailablePrincipalAgentToolClientService(),
        tools: new PolicyCheckedAgentToolHttpService(
          new SourceScopedAgentToolService(
            canonical,
            policies,
            new AgentToolEnvironmentAuthorityResolver(sourceAuthority),
            sourceAuthority,
            {
              acquireAgentToolApprovalAuthority: async () => ({
                generation: "generation-1",
                signal: new AbortController().signal,
                isCurrent: () => true,
                release: () => undefined,
              }),
            },
            { requestApplicationDecision: async () => "allow" },
          ),
        ),
      };
      const trustedSource = sourceAuthority.resolveInScope(
        scope,
        source.thread.id,
        new AbortController().signal,
      );
      expect(trustedSource.backendKind).toBe("codex_app_server");
      const mcpReference = sourceAuthority.issue(
        trustedSource,
        "management_http",
        "mcp",
      );
      const cliReference = sourceAuthority.issue(
        trustedSource,
        "management_http",
        "cli",
      );
      const config: AppConfig = {
        authenticationRequired: true,
        experimentalUsageEnabled: false,
        host: "127.0.0.1",
        port: 4784,
        stateDirectory: path.join(root, "state"),
        allowedTailscaleHosts: [],
        packagedClientOrigins: [],
        conversationRetentionMilliseconds: 600_000,
        conversationRuntimeBudget: 8,
      };
      const app = createNormalizedApp({
        workpads: {} as never,
        config,
        csrfToken: "mcp-e2e-csrf",
        identity,
        applicationSnapshots: new ApplicationSnapshotPublicationBoundary(
          { capture: async () => ({}) } as never,
          new ScopedApplicationEventHubs(),
        ),
        agentTools,
      } as unknown as NormalizedAppDependencies);
      server = createServer(app);
      const port = await listen(server);
      const {
        SEDES_AGENT_TOOL_CLIENT_TOKEN: _clientToken,
        SEDES_AGENT_TOOL_CLI_MODE: _cliMode,
        ...inherited
      } = process.env;
      const connect = async (
        reference: string,
        mode: "progressive" | "individual",
      ) => {
        const transport = new StdioClientTransport({
          command: built.executable,
          args: ["mcp", "--mode", mode],
          env: {
            ...(inherited as Record<string, string>),
            SEDES_AGENT_TOOL_ENDPOINT: `http://127.0.0.1:${port}`,
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY: reference,
          },
          stderr: "pipe",
        });
        const client = new Client({ name: "sedes-e2e", version: "1.0.0" });
        await client.connect(transport);
        clients.push(client);
        return client;
      };

      const individual = await connect(mcpReference, "individual");
      expect(individual.getServerVersion()).toMatchObject({ name: "sedes" });
      const { tools } = await individual.listTools();
      expect(tools.map(({ name }) => name)).toEqual([
        "sedes_agent_context",
        "sedes_thread_status",
      ]);
      expect(tools[0]).toMatchObject({
        annotations: { readOnlyHint: true },
        _meta: { "sedes/toolId": "agent.context" },
      });
      const context = await individual.callTool({
        name: "sedes_agent_context",
        arguments: {},
      });
      expect(context.structuredContent).toEqual({
        backend: "codex_app_server",
        threadId: source.thread.id,
        workspaceId: workspace.id,
      });
      const status = await individual.callTool({
        name: "sedes_thread_status",
        arguments: { threadId: source.thread.id },
      });
      expect(status.isError).toBeUndefined();
      expect(status.structuredContent).toMatchObject({
        threadId: source.thread.id,
        backend: "codex_app_server",
      });
      const invalid = await individual.callTool({
        name: "sedes_thread_status",
        arguments: {},
      });
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toMatchObject({ error: { code: "invalid_input" } });

      // The CLI reference cannot drive the Native MCP presentation.
      const wrongPresentation = await connect(cliReference, "individual");
      expect((await wrongPresentation.listTools()).tools).toEqual([]);

      // A surface change revokes the running MCP server's tools immediately:
      // each call re-reads the catalog, which no longer offers them.
      setPresentation("cli", "individual");
      await expect(
        individual.callTool({ name: "sedes_agent_context", arguments: {} }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect((await individual.listTools()).tools).toEqual([]);

      setPresentation("native", "progressive");
      const progressive = await connect(mcpReference, "progressive");
      expect(
        (await progressive.listTools()).tools.map(({ name }) => name),
      ).toEqual(["sedes_catalog", "sedes_read"]);
      const read = await progressive.callTool({
        name: "sedes_read",
        arguments: {
          toolId: "thread.status",
          schemaVersion: 2,
          input: { threadId: source.thread.id },
        },
      });
      expect(read.structuredContent).toMatchObject({
        threadId: source.thread.id,
      });
    } finally {
      for (const client of clients) await client.close();
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      database.close();
    }
  }, 60_000);
});
