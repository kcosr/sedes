import { createAgentToolCliNamedPipeEndpoint } from "../../src/internal/agent-tool-cli-protocol/local-endpoint.js";
import { claudeRuntimeQueryEnvironmentSchema } from "../../src/server/backends/claude/worker/claude-runtime-v1.js";
import { expect, it, vi } from "vitest";

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

import { claudeAgentToolCliEnvironment } from "../../src/server/backends/claude/claude-agent-tool-cli-environment.js";

it("uses target POSIX paths for SSH CLI injection from a Windows main", () => {
  const environment = claudeAgentToolCliEnvironment({
    availability: {
      availability: "available",
      endpoint: "unix:///home/remote/.local/state/sedes/agent-tools.sock",
      executableDirectory: "/home/remote/.local/lib/sedes/bin",
      inheritedPath: "/usr/bin:/bin",
    },
    applicationThreadId: "thread-a",
    sourceCapability: "claude-capability-a-1234567890abcdefghijklmnop",
    mode: "individual",
    parentEnvironment: {},
  });
  expect(environment.PATH).toBe("/home/remote/.local/lib/sedes/bin:/usr/bin:/bin");
});

it("retains Windows path rules for a local loopback CLI endpoint", () => {
  const environment = claudeAgentToolCliEnvironment({
    availability: {
      availability: "available",
      endpoint: "http://127.0.0.1:4784",
      executableDirectory: "C:\\Sedes\\bin",
      inheritedPath: "C:\\Windows;C:\\Windows\\System32",
    },
    applicationThreadId: "thread-a",
    sourceCapability: "claude-capability-a-1234567890abcdefghijklmnop",
    mode: "individual",
    parentEnvironment: {},
  });
  expect(environment.PATH).toBe("C:\\Sedes\\bin;C:\\Windows;C:\\Windows\\System32");
});

it("uses a capability-bound named pipe and target Windows PATH without inherited casing conflicts", () => {
  const endpoint = createAgentToolCliNamedPipeEndpoint();
  const environment = claudeAgentToolCliEnvironment({
    availability: { availability: "available", endpoint, executableDirectory: "C:\\Sedes\\bin", inheritedPath: "C:\\Windows" },
    applicationThreadId: "thread-a", sourceCapability: "claude-capability-a-1234567890abcdefghijklmnop", mode: "individual",
    parentEnvironment: { Path: "stale" },
  });
  expect(environment.PATH).toBe("C:\\Sedes\\bin;C:\\Windows");
  expect(environment).not.toHaveProperty("Path");
  expect(claudeRuntimeQueryEnvironmentSchema.safeParse(environment).success).toBe(true);
  const forgedEndpoint = endpoint.replace(/#[a-f0-9]+$/u, `#${"0".repeat(64)}`);
  expect(claudeRuntimeQueryEnvironmentSchema.safeParse({ ...environment, SEDES_AGENT_TOOL_ENDPOINT: forgedEndpoint }).success).toBe(false);
  expect(() => claudeAgentToolCliEnvironment({
    availability: { availability: "available", endpoint: forgedEndpoint, executableDirectory: "C:\\Sedes\\bin", inheritedPath: "" },
    applicationThreadId: "thread-a", sourceCapability: "claude-capability-a-1234567890abcdefghijklmnop", mode: "individual", parentEnvironment: {},
  })).toThrow("claude_agent_tool_cli_url_invalid");
});
