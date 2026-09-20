import { describe, expect, it, vi } from "vitest";
import {
  parseDynamicToolInput,
  renderDynamicToolHelp,
  resolveDynamicCommand,
} from "../../src/cli/sedes-dynamic-tool-command.js";
import type {
  AgentToolCatalogSummary,
  AgentToolDescription,
} from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  type CanonicalAgentToolRootSchema,
} from "../../src/server/agent-tools/schema/canonical-json-schema.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";

const inputSchema = {
  $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 240 },
    details: { type: "string", maxLength: 65_536 },
    pinned: { type: "boolean" },
    expectedRevision: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    files: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 4_096 },
      maxItems: 16,
      uniqueItems: true,
    },
    scope: {
      anyOf: [
        {
          type: "object",
          properties: {
            kind: {
              type: "string",
              maxLength: 9,
              enum: ["global"],
            },
          },
          required: ["kind"],
          additionalProperties: false,
          maxProperties: 1,
        },
        {
          type: "object",
          properties: {
            kind: {
              type: "string",
              maxLength: 9,
              enum: ["workspace"],
            },
            workspaceId: { type: "string", minLength: 1, maxLength: 128 },
          },
          required: ["kind"],
          additionalProperties: false,
          maxProperties: 2,
        },
      ],
    },
  },
  required: ["scope", "title"],
  additionalProperties: false,
  maxProperties: 6,
} as const satisfies CanonicalAgentToolRootSchema;

const summary = {
  id: "task.create",
  schemaVersion: 1,
  label: "Create task",
  description: "Creates a task.",
  group: { id: "tasks", order: 30 },
  effects: { application: "write", modelUsage: "none", external: "none" },
  cli: { commandPath: ["task", "create"] },
} as const satisfies AgentToolCatalogSummary;

const readers = {
  readFile: vi.fn(async () => "Acceptance keeps `agent-access` and $HOME.\n"),
  readStdin: vi.fn(async () => '{"title":"stdin","scope":{"kind":"global"}}'),
};

describe("dynamic Sedes tool commands", () => {
  it("resolves only live catalog command paths", () => {
    expect(resolveDynamicCommand([summary], ["task", "create", "--json"]))
      .toEqual({ tool: summary, arguments: ["--json"] });
    expect(() => resolveDynamicCommand([], ["task", "create"])).toThrow(
      /Unknown or ambiguous/,
    );
  });

  it("builds typed nested input and preserves exact file-backed strings", async () => {
    const parsed = await parseDynamicToolInput(
      inputSchema,
      [
        "--title",
        "Typed task",
        "--details-file",
        "/tmp/details.md",
        "--pinned",
        "false",
        "--expected-revision=7",
        "--files",
        "/workspace/a.md",
        "--files",
        "/workspace/b.md",
        "--scope-kind",
        "workspace",
        "--scope-workspace-id",
        "workspace-1",
        "--json",
      ],
      readers,
    );

    expect(parsed).toEqual({
      json: true,
      input: {
        title: "Typed task",
        details: "Acceptance keeps `agent-access` and $HOME.\n",
        pinned: false,
        expectedRevision: 7,
        files: ["/workspace/a.md", "/workspace/b.md"],
        scope: { kind: "workspace", workspaceId: "workspace-1" },
      },
    });
    expect(readers.readFile).toHaveBeenCalledWith("/tmp/details.md");
  });

  it("accepts an exact complete input object from stdin", async () => {
    await expect(
      parseDynamicToolInput(inputSchema, ["--input-file", "-"], readers),
    ).resolves.toEqual({
      json: false,
      input: { title: "stdin", scope: { kind: "global" } },
    });
  });

  it("rejects unsafe coercions, duplicates, unknowns, and mixed sources", async () => {
    for (const arguments_ of [
      ["--pinned", "yes"],
      ["--expected-revision", "1.5"],
      ["--title", "one", "--title", "two"],
      ["--unknown", "value"],
      ["--input-file", "-", "--title", "mixed"],
      ["--scope-json", '{"kind":"global"}', "--scope-kind", "global"],
    ]) {
      await expect(
        parseDynamicToolInput(inputSchema, arguments_, readers),
      ).rejects.toBeInstanceOf(Error);
    }
  });

  it("prefers specific primitive union members and supports an exact JSON form", async () => {
    const unionSchema = {
      $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
      type: "object",
      properties: {
        choice: {
          anyOf: [
            { type: "string", maxLength: 32 },
            { type: "integer", minimum: 0, maximum: 100 },
          ],
        },
      },
      required: ["choice"],
      additionalProperties: false,
      maxProperties: 1,
    } as const satisfies CanonicalAgentToolRootSchema;

    await expect(
      parseDynamicToolInput(unionSchema, ["--choice", "5"], readers),
    ).resolves.toMatchObject({ input: { choice: 5 } });
    await expect(
      parseDynamicToolInput(
        unionSchema,
        ["--choice-json", '"5"'],
        readers,
      ),
    ).resolves.toMatchObject({ input: { choice: "5" } });
  });

  it("renders live schema and effects in command help", () => {
    const tool = {
      ...summary,
      inputSchema,
      outputSchema: {
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
        maxProperties: 0,
      },
      execution: {
        form: "inline",
        waitCeilingMilliseconds: 30_000,
        supportsCancellation: true,
        idempotency: "required",
        progress: "none",
        maximumInputBytes: 1_024,
        maximumOutputBytes: 1_024,
        uncertainExternalOutcome: true,
      },
    } satisfies AgentToolDescription;
    const help = renderDynamicToolHelp(tool, ["task", "create"]);
    expect(help).toContain("Usage: sedes task create [options]");
    expect(help).toContain("--title <string>  required alternative");
    expect(help).toContain("--details-file <PATH|->");
    expect(help).toContain(
      "--scope-kind <global|workspace>  required alternative",
    );
    expect(help).toContain("--scope-workspace-id <string>  optional");
    expect(help).toContain("values must be unique");
    expect(help).toContain("application=write");
  });

  it("renders root minimum-property constraints", () => {
    const tool = {
      ...summary,
      inputSchema: { ...inputSchema, minProperties: 3 },
      outputSchema: {
        $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
        maxProperties: 0,
      },
      execution: {
        form: "inline",
        waitCeilingMilliseconds: 30_000,
        supportsCancellation: true,
        idempotency: "required",
        progress: "none",
        maximumInputBytes: 1_024,
        maximumOutputBytes: 1_024,
        uncertainExternalOutcome: true,
      },
    } satisfies AgentToolDescription;

    expect(renderDynamicToolHelp(tool, ["task", "create"])).toContain(
      "at least 3 total properties (1 additional optional field)",
    );
  });

  it("represents every canonical CLI tool with one typed named command", () => {
    const service = new CanonicalInlineAgentToolService({
      application: { readThreadStatus: async () => undefined },
      management: {} as never,
      automations: {} as never,
      threadCreation: {} as never,
      savedAgents: {} as never,
      threadControl: {} as never,
      webSearch: {} as never,
    });
    const catalog = service.catalogSummaries("cli", "thread_agent");
    const descriptions = new Map(
      [catalog.slice(0, 16), catalog.slice(16)]
        .flatMap((chunk) =>
          service.describeMany(
            "cli",
            "thread_agent",
            chunk.map(({ id }) => id),
          ),
        )
        .map((tool) => [tool.id, tool] as const),
    );
    expect(catalog.length).toBeGreaterThan(20);
    expect(
      new Set(catalog.map(({ cli }) => cli!.commandPath.join(" "))).size,
    ).toBe(catalog.length);
    for (const summary of catalog) {
      expect(() =>
        renderDynamicToolHelp(
          descriptions.get(summary.id)!,
          summary.cli!.commandPath,
        ),
      ).not.toThrow();
    }
  });
});
