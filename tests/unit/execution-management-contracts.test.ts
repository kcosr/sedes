import { randomUUID } from "node:crypto";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_TOOL_CLI_PROTOCOL_VERSION, AgentToolCliFrameDecoder, encodeAgentToolCliFrame,
  agentToolCatalogResponseSchema, agentToolCliRequestSchema,
} from "../../src/internal/agent-tool-cli-protocol/index.js";
import { projectSedesMcpTool, sedesMcpGatewayTools } from "../../src/internal/agent-tool-mcp/mcp-tool-projection.js";
import {
  agentToolsCatalogOperation, agentToolsDescribeOperation, agentToolsInvokeOperation, SidecarOperationRegistry,
} from "../../src/internal/sidecar-protocol/index.js";
import type { BackendAgentToolFacade, TrustedAgentToolSource } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { AGENT_TOOL_MAXIMUM_CATALOG_SUMMARY_BYTES } from "../../src/server/agent-tools/contracts/agent-tool-transport-limits.js";
import type { AgentToolCatalogSummary } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import {
  executionBackendKinds, executionConfigurationSchemas,
} from "../../src/server/agent-tools/execution/execution-configuration-contracts.js";
import type { ExecutionConfigurationTools } from "../../src/server/agent-tools/execution/execution-configuration-tools.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import {
  AGENT_TOOL_SCHEMA_LIMITS, compileCanonicalAgentToolSchema,
  type CanonicalAgentToolSchema,
} from "../../src/server/agent-tools/schema/canonical-json-schema.js";
import { registerSidecarAgentToolRelayOperations } from "../../src/server/agent-tools/sidecar/sidecar-agent-tool-relay.js";
import type { PolicyManagementAgentToolService } from "../../src/server/agent-tools/tools/policy-management-agent-tool-service.js";
import type { RuntimeAgentToolService } from "../../src/server/agent-tools/tools/runtime-agent-tool-service.js";

const executionConfiguration = { execute: vi.fn() } as unknown as ExecutionConfigurationTools;
function canonical() {
  return new CanonicalInlineAgentToolService({
    application: { readThreadStatus: async () => undefined },
    executionConfiguration,
    executionRuntime: { execute: vi.fn() } as unknown as RuntimeAgentToolService,
    policyManagement: { execute: vi.fn() } as unknown as PolicyManagementAgentToolService,
  });
}
function measure(schema: CanonicalAgentToolSchema, depth = 0): { nodes: number; depth: number } {
  const children = "anyOf" in schema ? schema.anyOf : schema.type === "object" ? Object.values(schema.properties) : schema.type === "array" ? [schema.items] : [];
  return children.reduce((total, child) => {
    const current = measure(child, depth + 1);
    return { nodes: total.nodes + current.nodes, depth: Math.max(total.depth, current.depth) };
  }, { nodes: 1, depth });
}
const scope = { tenantId: "tenant", principalId: "principal" };
const source: TrustedAgentToolSource = {
  scope, sourceThreadId: "source-thread", sourceWorkspaceId: "workspace", sourceEnvironmentId: "environment", backendKind: "codex_app_server",
};
const sourceCapability = "source-capability-1234567890abcdefghijklmnop";

describe("execution management canonical contracts", () => {
  it("measures every closed configuration schema against the finite shared budget", () => {
    const measurements = Object.values(executionConfigurationSchemas).flatMap(schemas => Object.values(schemas).map(schema => {
      expect(() => compileCanonicalAgentToolSchema(schema)).not.toThrow();
      return measure(schema);
    }));
    const maximumNodes = Math.max(...measurements.map(value => value.nodes));
    const maximumDepth = Math.max(...measurements.map(value => value.depth));
    // These measured provider contracts justify the expansion from 256 / 8.
    expect(maximumNodes).toBeGreaterThan(256);
    expect(maximumDepth).toBeGreaterThan(8);
    expect(maximumNodes).toBeLessThanOrEqual(AGENT_TOOL_SCHEMA_LIMITS.maximumNodes);
    expect(maximumDepth).toBeLessThanOrEqual(AGENT_TOOL_SCHEMA_LIMITS.maximumDepth);
  });

  it.each(executionBackendKinds)("keeps %s creation closed and equivalent in Ajv and TypeBox", kind => {
    const validator = compileCanonicalAgentToolSchema(executionConfigurationSchemas["backend.create"].input);
    const typebox = Compile(validator.schema as TSchema);
    const input = { mutationId: randomUUID(), expectedRevision: 0, environmentId: randomUUID(), backend: { kind, label: "Provider" } };
    expect(validator.check(input)).toBe(true);
    expect(typebox.Check(input)).toBe(true);
    const forged = { ...input, backend: { ...input.backend, arbitraryConfiguration: {} } };
    expect(validator.check(forged)).toBe(false);
    expect(typebox.Check(forged)).toBe(false);
  });

  it("requires named variable entries and rejects open maps and invalid bindings", () => {
    const validator = compileCanonicalAgentToolSchema(executionConfigurationSchemas["backend.configure"].input);
    const input = { mutationId: randomUUID(), expectedRevision: 1, backendId: "backend", changes: {
      environmentVariables: { execution: { set: [{ name: "EXAMPLE", binding: { kind: "literal", value: "value" } }] } },
    } };
    expect(validator.check(input)).toBe(true);
    expect(validator.check({ ...input, changes: { environmentVariables: { execution: { EXAMPLE: "value" } } } })).toBe(false);
    expect(validator.check({ ...input, changes: { environmentVariables: { execution: { set: [{ name: "EXAMPLE", binding: { arbitrary: true } }] } } } })).toBe(false);
  });

  it("exposes new definitions only to thread agents with identical native schemas", () => {
    const service = canonical();
    const ids = service.catalogSummaries("mcp", "thread_agent").filter(tool => tool.group.id === "execution" || tool.id.startsWith("thread.tool_settings.") || tool.id.startsWith("thread_template.")).map(tool => tool.id);
    expect(ids).toHaveLength(36);
    const external = new Set(service.catalogSummaries("http", "principal_client").map(tool => tool.id));
    expect(ids.every(id => !external.has(id))).toBe(true);
    expect(() => service.prepareInlineInvocation("http", "principal_client", {
      toolId: "environment.get", schemaVersion: 1, requestId: randomUUID(), input: { environmentId: randomUUID() },
    })).toThrowError(expect.objectContaining({ code: "permission_denied" }));
    for (let start = 0; start < ids.length; start += 16) {
      for (const description of service.describeMany("mcp", "thread_agent", ids.slice(start, start + 16))) {
        const projected = projectSedesMcpTool(description, "2025-11-25");
        expect(ToolSchema.safeParse(projected).success).toBe(true);
        expect(projected.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
        expect(projected._meta).toMatchObject({ "sedes/toolId": description.id, "sedes/schemaVersion": 1 });
      }
    }
    const lanes = sedesMcpGatewayTools(service.catalogSummaries("mcp", "thread_agent"), "2025-11-25");
    expect(lanes.find(tool => tool.name === "sedes_act")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("admits destructive lifecycle actions and keeps receipt recovery out of the read lane", () => {
    const service = canonical();
    const lifecycle = { mutationId: randomUUID(), expectedRevision: 1, resourceKind: "backend", resourceId: "backend",
      expectedIncarnation: "instance", impactToken: "impact" };
    for (const action of ["disconnect", "stop", "restart", "upgrade"]) {
      const tool = service.prepareInlineInvocation("mcp", "thread_agent", { requestId: randomUUID(), toolId: `runtime.${action}`, schemaVersion: 1, input: lifecycle });
      expect(tool.effects).toEqual({ application: "destructive", modelUsage: "none", external: "durable_side_effect" });
    }
    const receipt = service.prepareInlineInvocation("mcp", "thread_agent", { requestId: randomUUID(), toolId: "runtime.operation.get", schemaVersion: 1, input: { mutationId: randomUUID() } });
    expect(receipt.effects).toEqual({ application: "write", modelUsage: "none", external: "durable_side_effect" });
    expect(receipt.execution.uncertainExternalOutcome).toBe(true);
    const [description] = service.describeMany("mcp", "thread_agent", ["runtime.operation.get"]);
    expect(projectSedesMcpTool(description!, "2025-11-25").annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  it("uses one finite UTF-8 catalog budget on CLI/HTTP and sidecar consumers", () => {
    const entry: AgentToolCatalogSummary = { id: "example.read", schemaVersion: 1, label: "Example", description: "x",
      group: { id: "execution", order: 1 }, effects: { application: "read", modelUsage: "none", external: "none" } };
    const tools: AgentToolCatalogSummary[] = [];
    let remaining = AGENT_TOOL_MAXIMUM_CATALOG_SUMMARY_BYTES - Buffer.byteLength(JSON.stringify({ tools }));
    while (remaining > 2_001) {
      tools.push({ ...entry, description: "x".repeat(1_500) });
      remaining = AGENT_TOOL_MAXIMUM_CATALOG_SUMMARY_BYTES - Buffer.byteLength(JSON.stringify({ tools }));
    }
    tools.push({ ...entry });
    const missing = AGENT_TOOL_MAXIMUM_CATALOG_SUMMARY_BYTES - Buffer.byteLength(JSON.stringify({ tools }));
    tools[tools.length - 1] = { ...entry, description: "x".repeat(missing + 1) };
    expect(Buffer.byteLength(JSON.stringify({ tools }))).toBe(AGENT_TOOL_MAXIMUM_CATALOG_SUMMARY_BYTES);
    expect(agentToolCatalogResponseSchema.safeParse({ tools }).success).toBe(true);
    expect(agentToolsCatalogOperation.responseSchema.safeParse({ outcome: "ok", tools }).success).toBe(true);
    tools[tools.length - 1] = { ...tools[tools.length - 1]!, description: tools[tools.length - 1]!.description + "x" };
    expect(agentToolCatalogResponseSchema.safeParse({ tools }).success).toBe(false);
    expect(agentToolsCatalogOperation.responseSchema.safeParse({ outcome: "ok", tools }).success).toBe(false);
  });

  it.each(["cli", "mcp"] as const)("carries management catalog, descriptions and receipts through the %s sidecar relay", async presentation => {
    const service = canonical();
    const output = { revision: 2, backendId: "backend", changedSettings: ["label"], runtimes: [] };
    const invoke = vi.fn(async () => ({ invocationId: "invocation", state: "completed" as const, output }));
    const facade = {
      catalogSummaries: (_source: TrustedAgentToolSource, adapter: "cli" | "mcp") => service.catalogSummaries(adapter, "thread_agent"),
      describeMany: (_source: TrustedAgentToolSource, adapter: "cli" | "mcp", ids: readonly string[]) => service.describeMany(adapter, "thread_agent", ids),
      invoke,
    } as unknown as BackendAgentToolFacade;
    const registry = new SidecarOperationRegistry();
    registerSidecarAgentToolRelayOperations(registry, { authority: { scope, executionEnvironmentId: source.sourceEnvironmentId },
      sources: { resolveCapabilityInExecutionEnvironment: () => ({ source, presentation }) }, tools: facade });
    const context = { requestId: randomUUID(), signal: new AbortController().signal };
    const catalog = await registry.resolve(agentToolsCatalogOperation)!.handler({ sourceCapability }, context);
    expect(agentToolsCatalogOperation.responseSchema.safeParse(catalog).success).toBe(true);
    expect(catalog).toMatchObject({ outcome: "ok", tools: expect.arrayContaining([expect.objectContaining({ id: "backend.create", group: { id: "execution", order: 90 } })]) });
    const described = await registry.resolve(agentToolsDescribeOperation)!.handler({ sourceCapability, toolIds: ["backend.rename", "runtime.operation.get"] }, context);
    expect(agentToolsDescribeOperation.responseSchema.safeParse(described).success).toBe(true);
    const request = { toolId: "backend.rename", schemaVersion: 1, requestId: randomUUID(), input: { mutationId: randomUUID(), expectedRevision: 1, backendId: "backend", label: "Renamed" } };
    const result = await registry.resolve(agentToolsInvokeOperation)!.handler({ sourceCapability, ...request }, context);
    expect(agentToolsInvokeOperation.responseSchema.parse(result)).toMatchObject({ outcome: "ok", result: { output } });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ source, adapter: presentation, request }));
    const frame = encodeAgentToolCliFrame({ protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION, requestId: randomUUID(), sourceCapability, operation: { type: "invoke", request } });
    const decoded = new AgentToolCliFrameDecoder().push(frame);
    expect(agentToolCliRequestSchema.safeParse(decoded).success).toBe(true);
    expect(agentToolCliRequestSchema.safeParse({ ...decoded as object, protocolVersion: 6 }).success).toBe(false);
  });
});
