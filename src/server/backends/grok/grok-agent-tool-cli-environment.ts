import path from "node:path";
import type { AgentToolCliAvailability } from "../module.js";
import type { AgentToolPresentationMode } from "../../../shared/protocol/conversation.js";

export interface GrokAgentToolCliEnvironmentInput {
  readonly availability: AgentToolCliAvailability;
  readonly sourceCapability: string;
  readonly mode: AgentToolPresentationMode;
}

/** Adds exact thread-scoped Sedes CLI authority after runtime verification. */
export function withGrokAgentToolCliEnvironment(
  parentEnvironment: Readonly<Record<string, string>>,
  input: GrokAgentToolCliEnvironmentInput | undefined,
): Readonly<Record<string, string>> {
  const parent = { ...parentEnvironment };
  delete parent.SEDES_AGENT_TOOL_ENDPOINT;
  delete parent.SEDES_AGENT_TOOL_SOURCE_CAPABILITY;
  delete parent.SEDES_AGENT_TOOL_CLIENT_TOKEN;
  delete parent.SEDES_AGENT_TOOL_CLI_MODE;
  if (!input || input.availability.availability !== "available") {
    return Object.freeze(parent);
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(input.sourceCapability)) {
    throw new Error("grok_agent_tool_cli_source_capability_invalid");
  }
  if (input.mode !== "progressive" && input.mode !== "individual") {
    throw new Error("grok_agent_tool_cli_mode_invalid");
  }
  const endpoint = canonicalLoopbackEndpoint(input.availability.endpoint);
  const executableDirectory = canonicalDirectory(
    input.availability.executableDirectory,
  );
  const inheritedPath = boundedValue(
    input.availability.inheritedPath,
    "grok_agent_tool_cli_path_invalid",
    true,
  );
  return Object.freeze({
    ...parent,
    SEDES_AGENT_TOOL_ENDPOINT: endpoint,
    SEDES_AGENT_TOOL_SOURCE_CAPABILITY: input.sourceCapability,
    SEDES_AGENT_TOOL_CLI_MODE: input.mode,
    PATH: inheritedPath
      ? `${executableDirectory}${path.delimiter}${inheritedPath}`
      : executableDirectory,
  });
}

function canonicalLoopbackEndpoint(value: string): string {
  const bounded = boundedValue(value, "grok_agent_tool_cli_url_invalid", false);
  let parsed: URL;
  try {
    parsed = new URL(bounded);
  } catch (error) {
    throw new Error("grok_agent_tool_cli_url_invalid", { cause: error });
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port.length === 0 ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== bounded
  ) {
    throw new Error("grok_agent_tool_cli_url_invalid");
  }
  return parsed.origin;
}

function canonicalDirectory(value: string): string {
  const bounded = boundedValue(
    value,
    "grok_agent_tool_cli_directory_invalid",
    false,
  );
  if (!path.isAbsolute(bounded) || path.resolve(bounded) !== bounded) {
    throw new Error("grok_agent_tool_cli_directory_invalid");
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
    Buffer.byteLength(value) > 16_384 ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(code);
  }
  return value;
}
