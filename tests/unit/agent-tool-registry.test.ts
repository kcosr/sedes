import type { WorkpadAgentToolService } from "../../src/server/agent-tools/tools/workpad-agent-tool-service.js";
import { describe, expect, it, vi } from "vitest";
import {
  nativeAgentToolName,
  type AgentToolDefinition,
} from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_INVOCATION_ENVELOPE_HEADROOM_BYTES,
  AGENT_TOOL_MAXIMUM_CATALOG_SUMMARY_BYTES,
  AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES,
  AGENT_TOOL_MAXIMUM_RESPONSE_BYTES,
} from "../../src/server/agent-tools/contracts/agent-tool-transport-limits.js";
import { agentToolContractArtifactSchema } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import {
  CANONICAL_AGENT_TOOL_GROUPS,
  createCanonicalAgentToolDefinitions,
} from "../../src/server/agent-tools/registry/canonical-agent-tool-catalog.js";
import { CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES } from "../../src/server/agent-tools/registry/canonical-agent-tool-manifest.js";
import type { AgentManagementService } from "../../src/server/agent-tools/application/agent-management-service.js";
import type { AutomationAgentToolService } from "../../src/server/agent-tools/tools/automation-agent-tool-service.js";
import type { SavedAgentCanonicalToolService } from "../../src/server/agent-tools/tools/saved-agent-management-tools.js";
import type { AgentThreadCreationService } from "../../src/server/agent-tools/tools/thread-management-tools.js";
import type { AgentThreadControlToolServices } from "../../src/server/agent-tools/tools/thread-control-tools.js";
import {
  assertAgentToolArtifactContractSet,
  checkAgentToolArtifacts,
  generatedAgentToolArtifacts,
  writeAgentToolArtifacts,
} from "../../src/server/agent-tools/schema/check-agent-tool-artifacts.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  type CanonicalAgentToolRootSchema,
} from "../../src/server/agent-tools/schema/canonical-json-schema.js";
import { agentContextToolDefinition } from "../../src/server/agent-tools/tools/agent-context-tool.js";
import { createThreadStatusToolDefinition } from "../../src/server/agent-tools/tools/thread-status-tool.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import type { WebSearchExecutor } from "../../src/server/agent-tools/tools/web-search-tool.js";
import type { AgentThreadWorktreeService } from "../../src/server/agent-tools/tools/thread-worktree-tools.js";

const inputSchema = {
  $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
  maxProperties: 0,
} as const satisfies CanonicalAgentToolRootSchema;

const outputSchema = {
  $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
  maxProperties: 1,
} as const satisfies CanonicalAgentToolRootSchema;

const threadControl = {} as AgentThreadControlToolServices;
const webSearch = {
  search: vi.fn(async () => ({
    text: "answer",
    continued: false,
    continuationFallback: false,
  })),
} satisfies WebSearchExecutor;
const threadWorktrees = {} as AgentThreadWorktreeService;

function definition(
  overrides: Partial<AgentToolDefinition> = {},
): AgentToolDefinition {
  return {
    id: "example.read",
    schemaVersion: 1,
    description: "Reads one bounded example.",
    inputSchema,
    outputSchema,
    requiredCapabilities: [],
    effects: { application: "read", modelUsage: "none", external: "none" },
    execution: {
      form: "inline",
      adapterWaitCeilingMilliseconds: {
        pi_sdk: 30_000,
        http: 30_000,
        cli: 30_000,
      },
      supportsCancellation: true,
      idempotency: "not_applicable",
      progress: "none",
      maximumInputBytes: 1_024,
      maximumOutputBytes: 1_024,
      concurrencyClass: "example_read",
      uncertainExternalOutcome: false,
    },
    exposure: { adapters: ["pi_sdk", "http", "cli"] },
    catalog: { groupId: "context", label: "Example read", order: 10 },
    deployment: { eligible: true },
    environmentAuthority: { kind: "environment_neutral" },
    adapters: {
      pi: { name: "sedes_example_read", label: "Sedes example read" },
      http: { invocation: "inline" },
      cli: { command: "example.read" },
    },
    execute: vi.fn(async () => ({ ok: true })),
    ...overrides,
    callerEligibility: overrides.callerEligibility ?? ["thread_agent"],
  };
}

describe("AgentToolRegistry", () => {
  it("publishes one frozen stable group catalog", () => {
    expect(CANONICAL_AGENT_TOOL_GROUPS.map(({ id }) => id)).toEqual([
      "context",
      "threads",
      "agents",
      "tasks",
      "workpads",
      "automations",
      "research",
    ]);
    expect(Object.isFrozen(CANONICAL_AGENT_TOOL_GROUPS)).toBe(true);
    expect(CANONICAL_AGENT_TOOL_GROUPS.every(Object.isFrozen)).toBe(true);
  });
  it("keeps all canonical contracts equal to deterministic artifacts", () => {
    expect(() => checkAgentToolArtifacts()).not.toThrow();
    expect(() => checkAgentToolArtifacts(() => "{}\n")).toThrow(
      /artifact_stale/,
    );
    expect(Object.keys(generatedAgentToolArtifacts())).toEqual(
      CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.map(
        ({ id, schemaVersion }) => `${id}@${schemaVersion}`,
      ),
    );
    expect(CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES).toHaveLength(37);
  });

  it("assembles the complete production catalog only with every domain adapter", () => {
    const management = {} as AgentManagementService;
    const automations = {} as AutomationAgentToolService;
    const threadCreation = {} as AgentThreadCreationService;
    const savedAgents = {} as SavedAgentCanonicalToolService;
    const definitions = createCanonicalAgentToolDefinitions({
      application: { readThreadStatus: async () => undefined },
      management,
      automations,
      threadCreation,
      savedAgents,
      threadControl,
      webSearch,
      threadWorktrees,
      workpads: {} as WorkpadAgentToolService,
    });

    expect(definitions.map(({ id }) => id)).toEqual(
      CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.map(({ id }) => id),
    );
    expect(
      definitions.map(
        ({
          id,
          schemaVersion,
          description,
          catalog,
          effects,
          callerEligibility,
          deployment,
          environmentAuthority,
        }) => ({
          id,
          schemaVersion,
          description,
          catalog,
          effects,
          callerEligibility,
          deployment,
          environmentAuthority,
        }),
      ),
    ).toEqual(CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES);
    expect(() =>
      createCanonicalAgentToolDefinitions({
        application: { readThreadStatus: async () => undefined },
        management,
        automations,
        threadCreation,
      }),
    ).toThrow(/canonical_agent_tool_domain_services_incomplete/);
  });

  it("keeps the complete shipped discovery catalog compact", () => {
    const canonical = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      management: {} as AgentManagementService,
      automations: {} as AutomationAgentToolService,
      threadCreation: {} as AgentThreadCreationService,
      savedAgents: {} as SavedAgentCanonicalToolService,
      threadControl,
      webSearch,
      threadWorktrees,
      workpads: {} as WorkpadAgentToolService,
    });
    const summaries = canonical.catalogSummaries("cli", "thread_agent");

    expect(summaries).toHaveLength(37);
    expect(
      Buffer.byteLength(JSON.stringify({ tools: summaries }), "utf8"),
    ).toBeLessThanOrEqual(AGENT_TOOL_MAXIMUM_CATALOG_SUMMARY_BYTES);
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty("inputSchema");
      expect(summary).not.toHaveProperty("outputSchema");
      expect(summary).not.toHaveProperty("execution");
      expect(summary).not.toHaveProperty("adapters");
    }
  });

  it("rejects an aggregate description response above the transport limit", () => {
    const canonical = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
    });
    const properties = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `field${index}`,
        {
          type: "string" as const,
          description: "x".repeat(2_000),
          maxLength: 1,
        },
      ]),
    );
    const largeSchema = {
      $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
      type: "object" as const,
      properties,
      required: [],
      additionalProperties: false as const,
      maxProperties: 64,
    } satisfies CanonicalAgentToolRootSchema;
    const toolIds = Array.from(
      { length: 16 },
      (_, index) => `example.large_${index}`,
    );
    toolIds.forEach((id, index) => {
      canonical.registry.register(
        definition({
          id,
          inputSchema: largeSchema,
          outputSchema: largeSchema,
          adapters: {
            pi: {
              name: `sedes_example_large_${index}`,
              label: `Sedes large example ${index}`,
            },
            http: { invocation: "inline" },
            cli: { command: id },
          },
        }),
      );
    });

    expect(() =>
      canonical.describeMany("cli", "thread_agent", toolIds),
    ).toThrowError(expect.objectContaining({ code: "internal_error" }));
  });

  it("keeps deployment-selectable and canonically invocable IDs identical", () => {
    const definitions = createCanonicalAgentToolDefinitions({
      application: { readThreadStatus: async () => undefined },
      management: {} as AgentManagementService,
      automations: {} as AutomationAgentToolService,
      threadCreation: {} as AgentThreadCreationService,
      savedAgents: {} as SavedAgentCanonicalToolService,
      threadControl,
      webSearch,
      threadWorktrees,
      workpads: {} as WorkpadAgentToolService,
    });
    const invocable = definitions
      .filter(({ deployment }) => deployment?.eligible === true)
      .map(({ id }) => id);
    const policy = createThreadAgentToolPolicyDependencies();
    const selectable = policy.catalog
      .list()
      .groups.flatMap(({ tools }) => tools.map(({ id }) => id));

    expect([...policy.eligibility.eligibleToolIds]).toEqual(invocable);
    expect(selectable).toEqual(invocable);
  });

  it("keeps a runtime-unavailable tool visible for management but out of execution catalogs", () => {
    const availability = new Map([
      [
        "research.web_search",
        {
          available: false,
          reason: "The Grok CLI executable was not found.",
        },
      ] as const,
    ]);
    const policy = createThreadAgentToolPolicyDependencies(availability);
    const research = policy.catalog
      .list()
      .groups.flatMap(({ tools }) => tools)
      .find(({ id }) => id === "research.web_search");
    expect(research).toMatchObject({
      available: false,
      unavailableReason: "The Grok CLI executable was not found.",
    });

    const canonical = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      webSearch,
      unavailableToolIds: new Set(["research.web_search"]),
    });
    expect(
      canonical
        .catalogSummaries("cli", "thread_agent")
        .some(({ id }) => id === "research.web_search"),
    ).toBe(false);
    expect(() =>
      canonical.prepareInlineInvocation("cli", "thread_agent", {
        toolId: "research.web_search",
        schemaVersion: 1,
        requestId: "request-1",
        input: { query: "Current news" },
      }),
    ).toThrowError(expect.objectContaining({ code: "permission_denied" }));
  });

  it("marks every write timeout-indeterminate and every read determinate", () => {
    const definitions = createCanonicalAgentToolDefinitions({
      application: { readThreadStatus: async () => undefined },
      management: {} as AgentManagementService,
      automations: {} as AutomationAgentToolService,
      threadCreation: {} as AgentThreadCreationService,
      savedAgents: {} as SavedAgentCanonicalToolService,
      threadControl,
      webSearch,
      threadWorktrees,
      workpads: {} as WorkpadAgentToolService,
    });
    for (const definition of definitions) {
      expect(definition.execution.uncertainExternalOutcome, definition.id).toBe(
        definition.effects.application !== "read",
      );
    }
  });

  it("rejects missing and orphaned artifact locations", () => {
    expect(() =>
      assertAgentToolArtifactContractSet(
        ["agent.context@1", "thread.status@1"],
        ["agent.context@1"],
      ),
    ).toThrow(/artifact_contract_set_mismatch/);
    expect(() =>
      assertAgentToolArtifactContractSet(
        ["agent.context@1"],
        ["agent.context@1", "removed.tool@1"],
      ),
    ).toThrow(/artifact_contract_set_mismatch/);
    expect(() =>
      assertAgentToolArtifactContractSet(
        ["thread.status@1", "agent.context@1"],
        ["agent.context@1", "thread.status@1"],
      ),
    ).not.toThrow();
  });

  it("rejects on-disk artifact drift and removes only orphan artifacts when writing", () => {
    const expectedFilenames = CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.map(
      ({ id, schemaVersion }) => `${id}.v${schemaVersion}.json`,
    );
    expect(() =>
      checkAgentToolArtifacts(
        () => {
          throw new Error("artifact_read_should_not_run");
        },
        () => [...expectedFilenames, "removed.tool.v1.json"],
      ),
    ).toThrow(/artifact_file_set_mismatch/);
    expect(() =>
      checkAgentToolArtifacts(
        () => {
          throw new Error("artifact_read_should_not_run");
        },
        () => expectedFilenames.slice(1),
      ),
    ).toThrow(/artifact_file_set_mismatch/);

    const remove = vi.fn<(url: URL) => void>();
    writeAgentToolArtifacts(
      () => undefined,
      () => [
        ...expectedFilenames,
        "removed.tool.v1.json",
        "legacy.json",
        "README.json.tmp",
      ],
      remove,
    );
    expect(
      remove.mock.calls.map(([url]) => url.pathname.split("/").at(-1)),
    ).toEqual(["removed.tool.v1.json"]);
  });

  it("registers and resolves deterministic Pi, HTTP, and CLI presentations", () => {
    const registry = new AgentToolRegistry();
    registry.register(
      createThreadStatusToolDefinition({
        readThreadStatus: async () => undefined,
      }),
    );
    registry.register(agentContextToolDefinition);

    expect(registry.list().map(({ id }) => id)).toEqual([
      "agent.context",
      "thread.status",
    ]);
    expect(
      registry.resolveAdapterName("pi_sdk", "sedes_thread_status").id,
    ).toBe("thread.status");
    expect(registry.resolveAdapterName("http", "thread.status").id).toBe(
      "thread.status",
    );
    expect(registry.resolveAdapterName("cli", "thread.status").id).toBe(
      "thread.status",
    );
    expect(registry.artifact("thread.status", 2)).toMatchObject({
      deployment: { eligible: true },
      adapters: {
        http: { invocation: "inline" },
        cli: { command: "thread.status" },
      },
    });
  });

  it("names every MCP presentation like its Pi native tool", () => {
    const registry = new AgentToolRegistry();
    registry.register(
      createThreadStatusToolDefinition({
        readThreadStatus: async () => undefined,
      }),
    );
    expect(
      registry.resolveAdapterName("mcp", "sedes_thread_status").id,
    ).toBe("thread.status");
    expect(registry.artifact("thread.status", 2)).toMatchObject({
      exposure: { adapters: ["cli", "http", "mcp", "pi_sdk"] },
      adapters: { mcp: { name: "sedes_thread_status" } },
      execution: { adapterWaitCeilingMilliseconds: { mcp: 30_000 } },
    });
    expect(nativeAgentToolName("thread.worktree_list")).toBe(
      "sedes_thread_worktree_list",
    );

    const withMcp = (name: string) =>
      definition({
        exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
        execution: {
          ...definition().execution,
          adapterWaitCeilingMilliseconds: {
            ...definition().execution.adapterWaitCeilingMilliseconds,
            mcp: 30_000,
          },
        },
        adapters: { ...definition().adapters, mcp: { name } },
      });
    expect(() =>
      new AgentToolRegistry().register(withMcp("sedes_example_read")),
    ).not.toThrow();
    expect(() =>
      new AgentToolRegistry().register(withMcp("example_read")),
    ).toThrow("agent_tool_mcp_name_not_canonical");
    expect(() =>
      new AgentToolRegistry().register(
        definition({ adapters: { ...definition().adapters, mcp: { name: "sedes_example_read" } } }),
      ),
    ).toThrow("agent_tool_mcp_exposure_presentation_mismatch");
    expect(() =>
      new AgentToolRegistry().register(
        definition({
          exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
          adapters: { ...definition().adapters, mcp: { name: "sedes_example_read" } },
        }),
      ),
    ).toThrow("agent_tool_adapter_wait_ceiling_missing");
  });

  it("normalizes order and rejects ambiguous or malformed presentation", () => {
    const first = new AgentToolRegistry();
    first.register(definition());
    const second = new AgentToolRegistry();
    second.register(
      definition({ exposure: { adapters: ["cli", "http", "pi_sdk"] } }),
    );
    expect(second.serializedArtifact("example.read", 1)).toBe(
      first.serializedArtifact("example.read", 1),
    );

    expect(() => first.register(definition())).toThrow(/already_registered/);
    expect(() =>
      new AgentToolRegistry().register(
        definition({
          adapters: {
            ...definition().adapters,
            cli: { command: "tool.read" },
          },
        }),
      ),
    ).toThrow(/cli_command_path_invalid/);

    const collisions = new AgentToolRegistry();
    collisions.register(
      definition({
        adapters: {
          ...definition().adapters,
          cli: { command: "example-read" },
        },
      }),
    );
    expect(() =>
      collisions.register(
        definition({
          id: "example.other",
          adapters: {
            ...definition().adapters,
            cli: { command: "example_read" },
          },
        }),
      ),
    ).toThrow(/cli_command_path_already_registered/);

    const prefixes = new AgentToolRegistry();
    prefixes.register(
      definition({
        adapters: {
          ...definition().adapters,
          cli: { command: "example" },
        },
      }),
    );
    expect(() =>
      prefixes.register(
        definition({
          id: "example.child",
          adapters: {
            ...definition().adapters,
            cli: { command: "example.child" },
          },
        }),
      ),
    ).toThrow(/cli_command_path_ambiguous/);

    const reversePrefixes = new AgentToolRegistry();
    reversePrefixes.register(
      definition({
        adapters: {
          ...definition().adapters,
          cli: { command: "example.child" },
        },
      }),
    );
    expect(() =>
      reversePrefixes.register(
        definition({
          id: "example.parent",
          adapters: {
            ...definition().adapters,
            cli: { command: "example" },
          },
        }),
      ),
    ).toThrow(/cli_command_path_ambiguous/);

    const reservedInput = {
      $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
      type: "object",
      properties: { json: { type: "boolean" } },
      required: [],
      additionalProperties: false,
      maxProperties: 1,
    } as const satisfies CanonicalAgentToolRootSchema;
    expect(() =>
      new AgentToolRegistry().register(
        definition({ inputSchema: reservedInput }),
      ),
    ).toThrow(/cli_input_option_reserved:json/);

    const ambiguousInput = {
      $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
      type: "object",
      properties: {
        fooBar: { type: "string", maxLength: 16 },
        foo: {
          type: "object",
          properties: { bar: { type: "string", maxLength: 16 } },
          required: [],
          additionalProperties: false,
          maxProperties: 1,
        },
      },
      required: [],
      additionalProperties: false,
      maxProperties: 2,
    } as const satisfies CanonicalAgentToolRootSchema;
    expect(() =>
      new AgentToolRegistry().register(
        definition({ inputSchema: ambiguousInput }),
      ),
    ).toThrow(/cli_input_option_ambiguous:foo-bar/);
  });

  it("does not infer deployment eligibility from registration", () => {
    const registry = new AgentToolRegistry();
    registry.register(definition({ deployment: { eligible: false } }));
    expect(registry.artifact("example.read", 1).deployment).toEqual({
      eligible: false,
    });
  });

  it("fails closed when environment authority is absent or malformed", () => {
    expect(() =>
      new AgentToolRegistry().register(
        definition({ environmentAuthority: undefined as never }),
      ),
    ).toThrow(/environment_authority_missing/);
    expect(() =>
      new AgentToolRegistry().register(
        definition({
          environmentAuthority: {
            kind: "environment_neutral",
            extra: true,
          } as never,
        }),
      ),
    ).toThrow(/environment_authority_invalid/);
    expect(() =>
      new AgentToolRegistry().register(
        definition({
          environmentAuthority: {
            kind: "direct_resource",
            resource: "task",
            defaultToSource: true,
          } as never,
        }),
      ),
    ).toThrow(/environment_authority_invalid/);
  });

  it("rejects effect and timeout-uncertainty mismatches", () => {
    expect(() =>
      new AgentToolRegistry().register(
        definition({
          effects: {
            application: "write",
            modelUsage: "none",
            external: "none",
          },
        }),
      ),
    ).toThrow(/effect_uncertainty_mismatch/);
    expect(() =>
      new AgentToolRegistry().register(
        definition({
          execution: {
            ...definition().execution,
            uncertainExternalOutcome: true,
          },
        }),
      ),
    ).toThrow(/effect_uncertainty_mismatch/);
  });

  it("reserves invocation-envelope headroom for every HTTP tool output", () => {
    expect(
      AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES +
        AGENT_TOOL_INVOCATION_ENVELOPE_HEADROOM_BYTES,
    ).toBe(AGENT_TOOL_MAXIMUM_RESPONSE_BYTES);
    const atBoundary = new AgentToolRegistry();
    atBoundary.register(
      definition({
        execution: {
          ...definition().execution,
          maximumOutputBytes: AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES,
        },
      }),
    );
    expect(
      agentToolContractArtifactSchema.safeParse(
        atBoundary.artifact("example.read", 1),
      ).success,
    ).toBe(true);

    const overBoundary = {
      ...atBoundary.artifact("example.read", 1),
      execution: {
        ...atBoundary.artifact("example.read", 1).execution,
        maximumOutputBytes: AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES + 1,
      },
    };
    expect(
      agentToolContractArtifactSchema.safeParse(overBoundary).success,
    ).toBe(false);
    expect(() =>
      new AgentToolRegistry().register(
        definition({ execution: overBoundary.execution }),
      ),
    ).toThrow(/http_output_transport_limit_exceeded/);
  });
});
