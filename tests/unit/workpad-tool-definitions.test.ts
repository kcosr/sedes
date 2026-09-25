import { describe, expect, it } from "vitest";
import { createWorkpadToolDefinitions } from "../../src/server/agent-tools/tools/workpad-management-tools.js";
import type { WorkpadAgentToolService } from "../../src/server/agent-tools/tools/workpad-agent-tool-service.js";
import { canonicalCliOptionSpecs } from "../../src/server/agent-tools/schema/canonical-cli-options.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";

const definitions = createWorkpadToolDefinitions({} as WorkpadAgentToolService);

describe("Workpad tool surfaces", () => {
  it("uses one bounded canonical contract for Pi native, Codex/Claude MCP, and admitted Pi/Codex/Claude/Grok CLI presentations", () => {
    const registry = new AgentToolRegistry();
    for (const definition of definitions) {
      registry.register(definition);
      expect(definition.exposure.adapters).toEqual(["pi_sdk", "mcp", "http", "cli"]);
      expect(definition.callerEligibility).toEqual(["thread_agent", "principal_client"]);
      expect(definition.adapters.cli?.command).toBe(definition.id);
      expect(definition.adapters.pi?.name).toBe(definition.id.replace(".", "_" ).replace(/^/, "sedes_"));
      expect(definition.adapters.mcp?.name).toBe(definition.adapters.pi?.name);
      expect(definition.execution.uncertainExternalOutcome).toBe(definition.effects.application === "write");
    }
    expect(registry.list().map(({ id }) => id)).toEqual(["workpad.list", "workpad.get", "workpad.revisions", "workpad.create", "workpad.update"]);
  });

  it("exposes local file/stdin content options without accepting server file paths", () => {
    const create = definitions.find(({ id }) => id === "workpad.create")!;
    const update = definitions.find(({ id }) => id === "workpad.update")!;
    expect(canonicalCliOptionSpecs(create.inputSchema)).toContainEqual(expect.objectContaining({ name: "content-file", path: ["content"], representation: "file" }));
    expect(canonicalCliOptionSpecs(update.inputSchema)).toContainEqual(expect.objectContaining({ name: "edit-content-file", path: ["edit", "content"], representation: "file" }));
    expect(canonicalCliOptionSpecs(update.inputSchema)).toContainEqual(expect.objectContaining({ name: "edit-text-file", path: ["edit", "text"], representation: "file" }));
    const registry = new AgentToolRegistry();
    registry.register(update);
    expect(registry.validatesInput("workpad.update", 1, { workpadId: "pad", expectedRevision: 0, edit: { kind: "replace", path: "/some/file" } })).toBe(false);
  });
});
