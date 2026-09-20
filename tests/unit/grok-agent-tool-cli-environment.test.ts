import { describe, expect, it } from "vitest";
import { withGrokAgentToolCliEnvironment } from "../../src/server/backends/grok/grok-agent-tool-cli-environment.js";

const available = {
  availability: "available" as const,
  endpoint: "http://127.0.0.1:4784",
  executableDirectory: "/opt/sedes/bin",
  inheritedPath: "/usr/local/bin:/usr/bin",
};

describe("Grok agent-tool CLI environment", () => {
  it("removes ambient Sedes authority and installs one exact source capability", () => {
    expect(
      withGrokAgentToolCliEnvironment(
        {
          HOME: "/home/operator",
          GROK_HOME: "/home/operator/.grok",
          SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:9999",
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "ambient-capability",
          SEDES_AGENT_TOOL_CLIENT_TOKEN: "ambient-client-token",
          SEDES_AGENT_TOOL_CLI_MODE: "individual",
        },
        {
          availability: available,
          sourceCapability:
            "grok-thread-source-capability-7Qx2P9vK4nR8sT6wY1aD5fH0",
          mode: "progressive",
        },
      ),
    ).toEqual({
      HOME: "/home/operator",
      GROK_HOME: "/home/operator/.grok",
      SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
        "grok-thread-source-capability-7Qx2P9vK4nR8sT6wY1aD5fH0",
      SEDES_AGENT_TOOL_CLI_MODE: "progressive",
      PATH: "/opt/sedes/bin:/usr/local/bin:/usr/bin",
    });
  });

  it("keeps non-attached processes free of Sedes agent-tool authority", () => {
    expect(
      withGrokAgentToolCliEnvironment(
        {
          HOME: "/home/operator",
          SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:9999",
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "ambient-capability",
          SEDES_AGENT_TOOL_CLIENT_TOKEN: "ambient-client-token",
          SEDES_AGENT_TOOL_CLI_MODE: "individual",
        },
        undefined,
      ),
    ).toEqual({ HOME: "/home/operator" });
  });

  it.each([
    { availability: { ...available, endpoint: "http://localhost:4784" } },
    { availability: { ...available, endpoint: "https://127.0.0.1:4784" } },
    { availability: { ...available, executableDirectory: "relative/bin" } },
    { availability: { ...available, inheritedPath: "bad\npath" } },
  ])("rejects an invalid carrier %#", ({ availability }) => {
    expect(() =>
      withGrokAgentToolCliEnvironment(
        { HOME: "/home/operator" },
        {
          availability,
          sourceCapability:
            "grok-thread-source-capability-7Qx2P9vK4nR8sT6wY1aD5fH0",
          mode: "progressive",
        },
      ),
    ).toThrow(/grok_agent_tool_cli/u);
  });

  it("rejects a weak source capability", () => {
    expect(() =>
      withGrokAgentToolCliEnvironment(
        { HOME: "/home/operator" },
        {
          availability: available,
          sourceCapability: "too-short",
          mode: "progressive",
        },
      ),
    ).toThrow("grok_agent_tool_cli_source_capability_invalid");
  });

  it("rejects an invalid CLI presentation mode", () => {
    expect(() =>
      withGrokAgentToolCliEnvironment(
        { HOME: "/home/operator" },
        {
          availability: available,
          sourceCapability:
            "grok-thread-source-capability-7Qx2P9vK4nR8sT6wY1aD5fH0",
          mode: "hybrid" as never,
        },
      ),
    ).toThrow("grok_agent_tool_cli_mode_invalid");
  });
});
