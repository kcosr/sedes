import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeAgentToolCliEnvironment,
  claudeAgentToolMcpServer,
} from "../../src/server/backends/claude/claude-agent-tool-cli-environment.js";

const capabilityA = "claude-capability-a-1234567890abcdefghijklmnop";
const capabilityB = "claude-capability-b-1234567890abcdefghijklmnop";

describe("Claude agent-tool CLI environment", () => {
  it("isolates two concurrent Claude contexts while preserving login and process environment", async () => {
    const parentEnvironment = {
      HOME: "/operator",
      CLAUDE_CONFIG_DIR: "/operator/.claude-custom",
      LANG: "en_US.UTF-8",
      PATH: "/ignored",
      SEDES_AGENT_TOOL_CLIENT_TOKEN: "must-not-reach-claude",
    };
    const availability = {
      availability: "available" as const,
      endpoint: "http://127.0.0.1:4784",
      executableDirectory: "/opt/sedes/bin",
      inheritedPath: "/usr/bin",
    };

    const [threadA, threadB] = await Promise.all([
      Promise.resolve(
        claudeAgentToolCliEnvironment({
          availability,
          applicationThreadId: "thread-a",
          sourceCapability: capabilityA,
          mode: "progressive",
          parentEnvironment,
        }),
      ),
      Promise.resolve(
        claudeAgentToolCliEnvironment({
          availability,
          applicationThreadId: "thread-b",
          sourceCapability: capabilityB,
          mode: "individual",
          parentEnvironment,
        }),
      ),
    ]);

    expect(threadA).toEqual({
      HOME: "/operator",
      CLAUDE_CONFIG_DIR: "/operator/.claude-custom",
      LANG: "en_US.UTF-8",
      PATH: `/opt/sedes/bin${path.delimiter}/usr/bin`,
      SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: capabilityA,
      SEDES_AGENT_TOOL_CLI_MODE: "progressive",
    });
    expect(threadB).toEqual({
      HOME: "/operator",
      CLAUDE_CONFIG_DIR: "/operator/.claude-custom",
      LANG: "en_US.UTF-8",
      PATH: `/opt/sedes/bin${path.delimiter}/usr/bin`,
      SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: capabilityB,
      SEDES_AGENT_TOOL_CLI_MODE: "individual",
    });
    expect(threadA).not.toBe(threadB);
    expect(Object.isFrozen(threadA)).toBe(true);
    expect(Object.isFrozen(threadB)).toBe(true);
    expect(parentEnvironment).toEqual({
      HOME: "/operator",
      CLAUDE_CONFIG_DIR: "/operator/.claude-custom",
      LANG: "en_US.UTF-8",
      PATH: "/ignored",
      SEDES_AGENT_TOOL_CLIENT_TOKEN: "must-not-reach-claude",
    });
  });

  it("uses the executable as PATH when the inherited PATH is empty", () => {
    expect(
      claudeAgentToolCliEnvironment({
        availability: {
          availability: "available",
          endpoint: "http://127.0.0.1:4784",
          executableDirectory: "/opt/sedes/bin",
          inheritedPath: "",
        },
        applicationThreadId: "thread-a",
        sourceCapability: capabilityA,
        mode: "progressive",
        parentEnvironment: { HOME: "/operator", PATH: "/ignored" },
      }),
    ).toEqual({
      HOME: "/operator",
      PATH: "/opt/sedes/bin",
      SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: capabilityA,
      SEDES_AGENT_TOOL_CLI_MODE: "progressive",
    });
  });

  it("accepts the canonical managed SSH unix endpoint", () => {
    expect(
      claudeAgentToolCliEnvironment({
        availability: {
          availability: "available",
          endpoint: "unix:///home/remote/.local/state/sedes/agent-tools.sock",
          executableDirectory: "/home/remote/.local/lib/sedes/bin",
          inheritedPath: "/usr/bin:/bin",
        },
        applicationThreadId: "thread-a",
        sourceCapability: capabilityA,
        mode: "individual",
        parentEnvironment: {},
      }),
    ).toEqual({
      PATH: "/home/remote/.local/lib/sedes/bin:/usr/bin:/bin",
      SEDES_AGENT_TOOL_ENDPOINT:
        "unix:///home/remote/.local/state/sedes/agent-tools.sock",
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: capabilityA,
      SEDES_AGENT_TOOL_CLI_MODE: "individual",
    });
  });

  it("preserves the prepared child environment when the CLI is unavailable", () => {
    expect(
      claudeAgentToolCliEnvironment({
        availability: {
          availability: "unavailable",
          reason: "cli_unavailable",
        },
        applicationThreadId: "thread-a",
        sourceCapability: capabilityA,
        mode: "progressive",
        parentEnvironment: {
          HOME: "/operator",
          CLAUDE_CONFIG_DIR: "/operator/.claude-custom",
          SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4999",
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY: capabilityB,
          SEDES_AGENT_TOOL_CLIENT_TOKEN: "must-not-reach-claude",
          SEDES_AGENT_TOOL_CLI_MODE: "individual",
        },
      }),
    ).toEqual({
      HOME: "/operator",
      CLAUDE_CONFIG_DIR: "/operator/.claude-custom",
    });
  });

  it.each([
    "http://localhost:4784",
    "http://192.168.1.2:4784",
    "https://127.0.0.1:4784",
    "http://127.0.0.1:4784/api",
    "unix:///tmp/../agent-tools.sock",
    "unix://remote/tmp/agent-tools.sock",
  ])("rejects unsupported Claude CLI endpoint %s", (endpoint) => {
    expect(() =>
      claudeAgentToolCliEnvironment({
        availability: {
          availability: "available",
          endpoint,
          executableDirectory: "/opt/sedes/bin",
          inheritedPath: "/usr/bin",
        },
        applicationThreadId: "thread-a",
        sourceCapability: capabilityA,
        mode: "progressive",
        parentEnvironment: { HOME: "/operator" },
      }),
    ).toThrow("claude_agent_tool_cli_url_invalid");
  });

  it("rejects a missing CLI presentation mode", () => {
    expect(() =>
      claudeAgentToolCliEnvironment({
        availability: {
          availability: "available",
          endpoint: "http://127.0.0.1:4784",
          executableDirectory: "/opt/sedes/bin",
          inheritedPath: "/usr/bin",
        },
        applicationThreadId: "thread-a",
        sourceCapability: capabilityA,
        parentEnvironment: {},
      }),
    ).toThrow("claude_agent_tool_cli_mode_invalid");
  });

  it("resolves Native presentation to the sedes MCP server beside the CLI", () => {
    const availability = {
      availability: "available" as const,
      endpoint: "unix:///run/user/1000/sedes/agent-tools.sock",
      executableDirectory: "/remote/sedes/sidecar",
      inheritedPath: "/usr/bin",
    };
    expect(
      claudeAgentToolMcpServer({
        availability,
        applicationThreadId: "thread-a",
        sourceCapability: capabilityA,
        mode: "individual",
      }),
    ).toEqual({
      command: "/remote/sedes/sidecar/sedes",
      mode: "individual",
      endpoint: "unix:///run/user/1000/sedes/agent-tools.sock",
      sourceCapability: capabilityA,
    });
    expect(
      claudeAgentToolMcpServer({
        availability: { availability: "unavailable", reason: "cli_unavailable" },
        applicationThreadId: "thread-a",
        sourceCapability: capabilityA,
        mode: "individual",
      }),
    ).toBeUndefined();
    expect(() =>
      claudeAgentToolMcpServer({
        availability,
        applicationThreadId: "thread-a",
        sourceCapability: "short",
        mode: "individual",
      }),
    ).toThrow("claude_agent_tool_cli_source_capability_invalid");
    expect(() =>
      claudeAgentToolMcpServer({
        availability: { ...availability, endpoint: "http://192.168.1.2:4784" },
        applicationThreadId: "thread-a",
        sourceCapability: capabilityA,
        mode: "progressive",
      }),
    ).toThrow("claude_agent_tool_cli_url_invalid");
    expect(() =>
      claudeAgentToolMcpServer({
        availability: { ...availability, executableDirectory: "C:\\Sedes\\bin" },
        applicationThreadId: "thread-a",
        sourceCapability: capabilityA,
        mode: "progressive",
      }),
    ).toThrow("claude_agent_tool_mcp_platform_unsupported");
  });
});
