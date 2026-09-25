import { normalizedAbsolutePath } from "../../../shared/absolute-path.js";
import { isAgentToolCliEndpoint } from "../../../internal/agent-tool-cli-protocol/local-endpoint.js";
import { pathForRemoteRoot } from "../../execution/remote-path.js";
import type { AgentToolCliAvailability } from "../module.js";
import type { AgentToolPresentationMode } from "../../../shared/protocol/conversation.js";
import type { ClaudeRuntimeAgentToolMcp } from "./worker/claude-runtime-v1.js";

/**
 * Builds the complete environment required by the Agent SDK when Sedes's
 * generated CLI is available. The SDK replaces `env`, so every handle starts
 * from the runtime's immutable prepared environment. This keeps HOME and
 * CLAUDE_CONFIG_DIR identical to the environment used for namespace identity
 * and provider probes.
 */
export function claudeAgentToolCliEnvironment(input: {
  readonly availability?: AgentToolCliAvailability;
  readonly applicationThreadId: string;
  readonly sourceCapability?: string;
  readonly mode?: AgentToolPresentationMode;
  readonly parentEnvironment: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<string, string | undefined>> {
  const parent = { ...input.parentEnvironment };
  delete parent.SEDES_AGENT_TOOL_ENDPOINT;
  delete parent.SEDES_AGENT_TOOL_SOURCE_CAPABILITY;
  delete parent.SEDES_AGENT_TOOL_CLIENT_TOKEN;
  delete parent.SEDES_AGENT_TOOL_CLI_MODE;
  if (!input.availability || input.availability.availability !== "available") {
    return Object.freeze(parent);
  }
  assertThreadId(input.applicationThreadId);
  assertSourceCapability(input.sourceCapability);
  assertMode(input.mode);
  const endpoint = canonicalAgentToolEndpoint(input.availability.endpoint);
  const executableDirectory = absoluteDirectory(
    input.availability.executableDirectory,
  );
  const targetPath = pathForRemoteRoot(executableDirectory);
  if (targetPath.sep === "\\") {
    for (const key of Object.keys(parent)) if (key.toUpperCase() === "PATH") delete parent[key];
  }
  const inheritedPath = boundedValue(
    input.availability.inheritedPath,
    "claude_agent_tool_cli_path_invalid",
    true,
  );
  return Object.freeze({
    ...parent,
    SEDES_AGENT_TOOL_ENDPOINT: endpoint,
    SEDES_AGENT_TOOL_SOURCE_CAPABILITY: input.sourceCapability,
    SEDES_AGENT_TOOL_CLI_MODE: input.mode,
    PATH: inheritedPath
      ? `${executableDirectory}${targetPath.delimiter}${inheritedPath}`
      : executableDirectory,
  });
}

/**
 * Resolves the query's Native Sedes tools to the `sedes mcp` server run from
 * the same executable directory the CLI would use: the provider bin locally,
 * or the sidecar binary on an SSH or outbound host. Unavailable CLI runtime
 * leaves the query without Sedes tools rather than falling back.
 */
export function claudeAgentToolMcpServer(input: {
  readonly availability?: AgentToolCliAvailability;
  readonly applicationThreadId: string;
  readonly sourceCapability?: string;
  readonly mode?: AgentToolPresentationMode;
}): ClaudeRuntimeAgentToolMcp | undefined {
  if (!input.availability || input.availability.availability !== "available") {
    return undefined;
  }
  assertThreadId(input.applicationThreadId);
  assertSourceCapability(input.sourceCapability);
  assertMode(input.mode);
  const executableDirectory = absoluteDirectory(
    input.availability.executableDirectory,
  );
  const targetPath = pathForRemoteRoot(executableDirectory);
  if (targetPath.sep === "\\") {
    throw new Error("claude_agent_tool_mcp_platform_unsupported");
  }
  return Object.freeze({
    command: targetPath.join(executableDirectory, "sedes"),
    mode: input.mode,
    endpoint: canonicalAgentToolEndpoint(input.availability.endpoint),
    sourceCapability: input.sourceCapability,
  });
}

function assertMode(
  value: AgentToolPresentationMode | undefined,
): asserts value is AgentToolPresentationMode {
  if (value !== "progressive" && value !== "individual") {
    throw new Error("claude_agent_tool_cli_mode_invalid");
  }
}

function assertSourceCapability(
  value: string | undefined,
): asserts value is string {
  if (value === undefined || !/^[A-Za-z0-9_-]{32,256}$/u.test(value)) {
    throw new Error("claude_agent_tool_cli_source_capability_invalid");
  }
}

function canonicalAgentToolEndpoint(value: string): string {
  const bounded = boundedValue(
    value,
    "claude_agent_tool_cli_url_invalid",
    false,
  );
  if (isAgentToolCliEndpoint(bounded)) return bounded;
  let parsed: URL;
  try {
    parsed = new URL(bounded);
  } catch (error) {
    throw new Error("claude_agent_tool_cli_url_invalid", { cause: error });
  }
  const loopbackHttp =
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    parsed.port.length > 0 &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname === "/" &&
    !parsed.search &&
    !parsed.hash &&
    parsed.origin === bounded;
  if (!loopbackHttp) {
    throw new Error("claude_agent_tool_cli_url_invalid");
  }
  return bounded;
}

function absoluteDirectory(value: string): string {
  const bounded = boundedValue(
    value,
    "claude_agent_tool_cli_directory_invalid",
    false,
  );
  if (!normalizedAbsolutePath(bounded)) {
    throw new Error("claude_agent_tool_cli_directory_invalid");
  }
  return bounded;
}

function boundedValue(
  value: string,
  code: string,
  allowEmpty: boolean,
): string {
  if (
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > 16_384 ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}

function assertThreadId(value: string): void {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("claude_agent_tool_cli_source_thread_invalid");
  }
}
