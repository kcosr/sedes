import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isSideEffectFreeRead, SEDES_MCP_GATEWAY_NAMES } from "../../src/internal/agent-tool-mcp/mcp-tool-projection.js";
import { configurationDocumentSchema } from "../../src/shared/protocol/configuration-admin.js";
import { ConfigurationAdminService } from "../../src/server/configuration-admin/configuration-admin-service.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES } from "../../src/server/agent-tools/registry/canonical-agent-tool-manifest.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { deriveConnectionProfileId } from "../../src/server/db/connection-profile-id.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";
import { startProductionApplication, type RunningApplication } from "../../src/server/production-application.js";
import { loadOrCreateToolProvenanceKey } from "../../src/server/security/installation-secret.js";
import { authenticatedProductionFetch } from "../helpers/authenticated-production-client.js";
import { buildSedesToolExecutable } from "../helpers/built-sedes-cli.js";
import { testAgentToolExecutionAuthority } from "../support/agent-tool-execution-authority.js";

type Mode = "individual" | "progressive";
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const sourceBackendId = "management-source-codex";
const siblingBackendId = "management-sibling-claude";
const sourceTargetId = "management-source-target";
const siblingTargetId = "management-sibling-target";
const executionToolIds = () => CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES
  .filter(tool => tool.catalog.groupId === "execution" || tool.id.startsWith("thread.tool_settings.") || tool.id.startsWith("thread_template."))
  .map(tool => tool.id);

function output(result: ToolResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  const value = result.structuredContent;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("test_tool_output_missing");
  return value as Record<string, unknown>;
}

function error(result: ToolResult): unknown {
  expect(result.isError).toBe(true);
  if (!Array.isArray(result.content)) throw new Error("test_tool_error_missing");
  const text = result.content.find((item: unknown): item is { type: "text"; text: string } =>
    item !== null && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string");
  if (!text) throw new Error("test_tool_error_missing");
  return JSON.parse(text.text);
}

describe("production execution management through the built MCP executable", () => {
  let built: Awaited<ReturnType<typeof buildSedesToolExecutable>>;
  let application: RunningApplication | undefined;
  let directory: string | undefined;
  const clients: Client[] = [];

  beforeAll(async () => { built = await buildSedesToolExecutable(); }, 60_000);
  afterAll(async () => { if (built) await rm(built.buildRoot, { recursive: true, force: true }); });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    await application?.close();
    application = undefined;
    vi.restoreAllMocks();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function fixture(mode: Mode) {
    directory = await mkdtemp(path.join(os.tmpdir(), "sedes-management-mcp-"));
    await writeFile(path.join(directory, "server.json"), JSON.stringify({ schemaVersion: 11, packagedClients: [] }));
    // This test exercises real production registration, admission, persistence,
    // reconciliation and MCP transport without launching an authenticated model.
    // Source-runtime lease lifetime has separate coordinator coverage.
    vi.spyOn(ThreadRuntimeCoordinator.prototype, "acquireAgentToolExecutionAuthority")
      .mockImplementation(testAgentToolExecutionAuthority.acquireAgentToolExecutionAuthority);
    const getter = vi.spyOn(ConfigurationAdminService.prototype, "get");
    application = await startProductionApplication({
      ...process.env, APP_STATE_DIR: directory, SEDES_CONFIG_FILE: path.join(directory, "server.json"), PORT: "0",
      PI_CODING_AGENT_DIR: path.join(directory, "pi"), XDG_RUNTIME_DIR: path.join(directory, "runtime"),
    });
    const address = application.server.address();
    if (!address || typeof address === "string") throw new Error("test_server_not_listening");
    const origin = `http://127.0.0.1:${address.port}`;
    const request = await authenticatedProductionFetch(application);
    expect((await request(`${origin}/api/configuration`)).status).toBe(200);
    const configuration = getter.mock.contexts.at(-1)! as ConfigurationAdminService;
    const scope = getter.mock.calls.at(-1)![0];
    getter.mockRestore();
    const environmentId = randomUUID();
    const document = configurationDocumentSchema.parse({
      executionEnvironments: [{ id: environmentId, kind: "local", label: "Management host", workspaceRoots: [directory],
        workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] },
        environmentVariables: { execution: { HOST_VALUE: { kind: "literal", value: "host-literal" } }, startup: {} },
      }],
      backends: [
        { id: sourceBackendId, kind: "codex_app_server", label: "Source", enabled: true, modelPolicy: { type: "catalog" },
          moduleConfiguration: {
            connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectory: directory,
              executablePath: path.join(directory, "uninstalled-codex") } },
            policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"],
              allowedApprovalPolicies: ["on-request"], allowedApprovalReviewers: ["user"] },
          },
        },
        { id: siblingBackendId, kind: "claude_agent_sdk", label: "Sibling", enabled: true, modelPolicy: { type: "catalog" },
          environmentVariables: { execution: {
            API_TOKEN: { kind: "literal", value: "foo" }, KEEP_ME: { kind: "literal", value: "preserved-literal" },
          }, startup: {} },
          moduleConfiguration: { executablePath: path.join(directory, "uninstalled-claude"),
            configDirectory: path.join(directory, "sibling-claude"), initializationTimeoutMs: 1000,
            permissionPolicy: { allowedModes: ["default"] } },
        },
      ],
      targets: [
        { id: sourceTargetId, kind: "codex_app_server", backendInstanceId: sourceBackendId, executionEnvironmentId: environmentId,
          label: "Source connection", enabled: true,
          moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "on-request",
            approvalReviewer: "user", model: { type: "catalogDefault" } } } },
        { id: siblingTargetId, kind: "claude_agent_sdk", backendInstanceId: siblingBackendId, executionEnvironmentId: environmentId,
          label: "Independently named connection", enabled: true, moduleConfiguration: { defaults: { permissionMode: "default" } } },
      ],
      defaultTargetId: null, webSearch: null,
    });
    await configuration.save(scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: document });
    const database = configuration.repository.database;
    const inventory = new InventoryRepository(database);
    const workspace = inventory.upsertWorkspace(scope, { environmentId, canonicalPath: directory,
      displayName: "Management workspace", project: { kind: "new", name: "Management" }, available: true,
      trustState: "trusted", environmentConfigurationRevision: 1, now: Date.now() });
    const source = new ConversationBindingRepository(database).createUnboundThread(scope, {
      workspaceId: workspace.id, connectionProfileId: deriveConnectionProfileId(scope.tenantId, scope.principalId, sourceTargetId),
      title: "Management source", now: Date.now(),
    });
    const policies = new ThreadAgentToolPolicyRepository(database, createThreadAgentToolPolicyDependencies().eligibility);
    const setPolicy = (enabledToolIds = executionToolIds(), allowOtherEnvironments = true) => policies.update(scope, source.id, {
      expectedRevision: policies.get(scope, source.id).revision, enabled: true, enabledToolIds,
      presentation: { surface: "native", mode }, resourceScope: { allowOtherEnvironments, allowOtherProjects: true }, now: Date.now(),
    });
    setPolicy();
    const sources = new DatabaseAgentToolSourceAuthority(database, await loadOrCreateToolProvenanceKey(directory));
    const trusted = sources.resolveInScope(scope, source.id, new AbortController().signal);
    const reference = sources.issue(trusted, "management_http", "mcp");
    const { SEDES_AGENT_TOOL_CLIENT_TOKEN: _clientToken, SEDES_AGENT_TOOL_CLI_MODE: _mode, ...inherited } = process.env;
    const transport = new StdioClientTransport({ command: built.executable, args: ["mcp", "--mode", mode],
      env: { ...(inherited as Record<string, string>), SEDES_AGENT_TOOL_ENDPOINT: origin, SEDES_AGENT_TOOL_SOURCE_CAPABILITY: reference },
      stderr: "pipe" });
    const client = new Client({ name: "management-production-test", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    const call = (toolId: string, input: Record<string, unknown>) => {
      const definition = CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.find(tool => tool.id === toolId)!;
      return client.callTool(mode === "individual"
        ? { name: `sedes_${toolId.replaceAll(".", "_")}`, arguments: input }
        : { name: isSideEffectFreeRead(definition.effects) ? SEDES_MCP_GATEWAY_NAMES.read : SEDES_MCP_GATEWAY_NAMES.act,
            arguments: { toolId, schemaVersion: definition.schemaVersion, input } });
    };
    const revision = () => configuration.repository.get(scope).revision;
    return { client, call, scope, configuration, environmentId, source, policies, setPolicy, revision };
  }

  it.each(["individual", "progressive"] as const)("reads literals and applies scoped partial edits with durable replay via %s MCP", async mode => {
    const f = await fixture(mode);
    const details = output(await f.call("backend.get", { backendId: siblingBackendId }));
    expect(details).toMatchObject({ backend: { environmentVariables: { execution: expect.arrayContaining([
      { name: "API_TOKEN", binding: { kind: "literal", value: "foo" } },
    ]) } }, connections: [{ configurationTargetId: siblingTargetId,
      targetId: deriveConnectionProfileId(f.scope.tenantId, f.scope.principalId, siblingTargetId) }] });
    const listed = output(await f.call("backend.list", {}));
    expect(JSON.stringify(listed)).not.toContain("API_TOKEN");
    expect(JSON.stringify(listed)).not.toContain("preserved-literal");
    const changed = { backendId: siblingBackendId, expectedRevision: f.revision(), mutationId: randomUUID(), changes: {
      moduleConfiguration: { initializationTimeoutMs: 4000 },
      environmentVariables: { execution: { set: [{ name: "LOG_LEVEL", binding: { kind: "literal", value: "debug" } }] } },
    } };
    const receipt = output(await f.call("backend.configure", changed));
    expect(receipt.revision).toBe(changed.expectedRevision + 1);
    expect(JSON.stringify(receipt)).not.toContain("preserved-literal");
    expect(JSON.stringify(receipt)).not.toContain('"debug"');
    const current = f.configuration.repository.get(f.scope);
    const backend = current.configuration.backends.find(item => item.id === siblingBackendId)!;
    expect(backend).toMatchObject({ moduleConfiguration: { initializationTimeoutMs: 4000,
      executablePath: path.join(directory!, "uninstalled-claude"), configDirectory: path.join(directory!, "sibling-claude"),
      permissionPolicy: { allowedModes: ["default"] } }, environmentVariables: { execution: {
      API_TOKEN: { kind: "literal", value: "foo" }, KEEP_ME: { kind: "literal", value: "preserved-literal" },
      LOG_LEVEL: { kind: "literal", value: "debug" },
    } } });
    backend.label = "Renamed in Settings";
    await f.configuration.save(f.scope, { mutationId: randomUUID(), expectedRevision: current.revision, configuration: current.configuration });
    expect(output(await f.call("backend.configure", changed))).toEqual(receipt);
    expect(f.configuration.repository.get(f.scope).configuration.backends.find(item => item.id === siblingBackendId)?.label).toBe("Renamed in Settings");
    expect(error(await f.call("backend.configure", { ...changed, mutationId: randomUUID() }))).toMatchObject({ error: { code: "conflict" } });
    expect(error(await f.call("backend.configure", { ...changed, changes: { enabled: false } }))).toMatchObject({ error: { code: "conflict" } });
    expect(error(await f.call("environment.configure", { environmentId: f.environmentId, expectedRevision: f.revision(), mutationId: randomUUID(),
      changes: { environmentVariables: { execution: { set: [{ name: "SOURCE_CHANGE", binding: { kind: "literal", value: "blocked" } }] } } } })))
      .toMatchObject({ error: { code: "permission_denied" } });
    expect(error(await f.call("backend.configure", { backendId: sourceBackendId, expectedRevision: f.revision(), mutationId: randomUUID(), changes: { enabled: false } })))
      .toMatchObject({ error: { code: "permission_denied" } });
    output(await f.call("backend.rename", { backendId: sourceBackendId, expectedRevision: f.revision(), mutationId: randomUUID(), label: "Renamed source" }));
    expect(f.configuration.repository.get(f.scope).configuration.targets.find(item => item.id === sourceTargetId)?.label).toBe("Source connection");
  }, 60_000);
});
