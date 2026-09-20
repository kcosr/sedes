import { describe, expect, it } from "vitest";
import {
  assertAuditedPiBuiltinToolCatalog,
  classifyPiBuiltinTool,
  PI_BUILTIN_TOOL_DISPOSITIONS,
  PI_EXCLUDED_TOOL_NAMES,
  PI_INTENTIONALLY_UNSUPPORTED_BUILTIN_TOOL_NAMES,
  PI_MUTATING_BUILTIN_TOOL_NAMES,
  PI_READ_ONLY_BUILTIN_TOOL_NAMES,
  PI_SUPPORTED_BUILTIN_TOOL_NAMES,
} from "../../src/server/backends/pi/pi-builtin-tool-policy.js";

function tool(name: string, source: string, sourcePath: string) {
  return { name, sourceInfo: { source, path: sourcePath } };
}

describe("Pi 0.86.0 built-in tool policy", () => {
  it("gives every reviewed built-in one explicit disposition", () => {
    expect(Object.keys(PI_BUILTIN_TOOL_DISPOSITIONS)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "write",
      "edit",
      "powershell",
    ]);
    expect(PI_SUPPORTED_BUILTIN_TOOL_NAMES).toEqual([
      "bash",
      "read",
      "write",
      "edit",
      "grep",
      "find",
      "ls",
    ]);
    expect(PI_READ_ONLY_BUILTIN_TOOL_NAMES).toEqual([
      "read",
      "grep",
      "find",
      "ls",
    ]);
    expect(PI_MUTATING_BUILTIN_TOOL_NAMES).toEqual(["bash", "write", "edit"]);
    expect(PI_INTENTIONALLY_UNSUPPORTED_BUILTIN_TOOL_NAMES).toEqual([
      "powershell",
    ]);
    expect(PI_EXCLUDED_TOOL_NAMES).toEqual(["powershell"]);
  });

  it("classifies direct and trusted executor built-ins by source identity", () => {
    expect(
      classifyPiBuiltinTool(tool("read", "builtin", "<builtin:read>")),
    ).toBe("read");
    const trusted = new Set(PI_SUPPORTED_BUILTIN_TOOL_NAMES);
    expect(
      classifyPiBuiltinTool(tool("bash", "sdk", "<sdk:bash>"), trusted),
    ).toBe("bash");
    expect(
      classifyPiBuiltinTool(
        tool("project_read", "extension", "/workspace/.pi/extensions/read.ts"),
      ),
    ).toBeUndefined();
    expect(
      classifyPiBuiltinTool(
        tool("read", "extension", "/workspace/.pi/extensions/read.ts"),
      ),
    ).toBeUndefined();

    const localCliOverride = new Set(["bash"] as const);
    expect(
      classifyPiBuiltinTool(
        tool("bash", "sdk", "<sdk:bash>"),
        localCliOverride,
      ),
    ).toBe("bash");
    expect(
      classifyPiBuiltinTool(
        tool("read", "builtin", "<builtin:read>"),
        localCliOverride,
      ),
    ).toBe("read");
    expect(() =>
      assertAuditedPiBuiltinToolCatalog(
        [
          tool("bash", "sdk", "<sdk:bash>"),
          tool("read", "builtin", "<builtin:read>"),
        ],
        localCliOverride,
      ),
    ).not.toThrow();
  });

  it("fails closed for unsupported, unreviewed, malformed, and untrusted built-ins", () => {
    expect(() =>
      classifyPiBuiltinTool(
        tool("powershell", "builtin", "<builtin:powershell>"),
      ),
    ).toThrow("pi_builtin_tool_intentionally_unsupported");
    expect(() =>
      classifyPiBuiltinTool(
        tool("future_tool", "builtin", "<builtin:future_tool>"),
      ),
    ).toThrow("pi_builtin_tool_disposition_missing");
    expect(() =>
      classifyPiBuiltinTool(tool("read", "builtin", "<builtin:write>")),
    ).toThrow("pi_builtin_tool_identity_malformed");
    expect(() =>
      classifyPiBuiltinTool(tool("read", "sdk", "<sdk:read>")),
    ).toThrow("pi_builtin_tool_override_untrusted");
  });

  it("requires the complete executor override catalog and rejects host built-ins", () => {
    const trusted = new Set(PI_SUPPORTED_BUILTIN_TOOL_NAMES);
    const overrides = PI_SUPPORTED_BUILTIN_TOOL_NAMES.map((name) =>
      tool(name, "sdk", `<sdk:${name}>`),
    );
    expect(() =>
      assertAuditedPiBuiltinToolCatalog(
        [...overrides, tool("sedes_read", "sdk", "<sdk:sedes_read>")],
        trusted,
      ),
    ).not.toThrow();
    expect(() =>
      assertAuditedPiBuiltinToolCatalog(overrides.slice(1), trusted),
    ).toThrow("pi_executor_builtin_override_incomplete");
    expect(() =>
      assertAuditedPiBuiltinToolCatalog(
        [...overrides, tool("future_tool", "builtin", "<builtin:future_tool>")],
        trusted,
      ),
    ).toThrow("pi_builtin_tool_disposition_missing");
    expect(() =>
      assertAuditedPiBuiltinToolCatalog(
        overrides.map((entry) =>
          entry.name === "bash"
            ? tool("bash", "builtin", "<builtin:bash>")
            : entry,
        ),
        trusted,
      ),
    ).toThrow("pi_executor_host_builtin_residual");
  });
});
