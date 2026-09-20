import {
  AGENT_TOOL_CLI_MAXIMUM_UNIX_SOCKET_PATH_BYTES,
  isAgentToolCliEndpoint,
  parseAgentToolCliNamedPipeEndpoint,
  type AgentToolCliNamedPipeEndpoint,
} from "../internal/agent-tool-cli-protocol/local-endpoint.js";
import { SedesToolApiError } from "./sedes-tool-client.js";

export const SEDES_AGENT_TOOL_ENDPOINT_VARIABLE =
  "SEDES_AGENT_TOOL_ENDPOINT" as const;
export const SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE =
  "SEDES_AGENT_TOOL_SOURCE_CAPABILITY" as const;
export const SEDES_AGENT_TOOL_CLIENT_TOKEN_VARIABLE =
  "SEDES_AGENT_TOOL_CLIENT_TOKEN" as const;
export const SEDES_AGENT_TOOL_CLI_MODE_VARIABLE =
  "SEDES_AGENT_TOOL_CLI_MODE" as const;
export const SEDES_AGENT_TOOL_MAXIMUM_UNIX_SOCKET_PATH_BYTES = AGENT_TOOL_CLI_MAXIMUM_UNIX_SOCKET_PATH_BYTES;

export type SedesAgentToolCliMode = "progressive" | "individual";

export function normalizeSedesAgentToolCliMode(
  value: string | undefined,
): SedesAgentToolCliMode {
  if (value !== "progressive" && value !== "individual") {
    throw new SedesToolApiError(
      "invalid_environment",
      `${SEDES_AGENT_TOOL_CLI_MODE_VARIABLE} must be progressive or individual.`,
      false,
    );
  }
  return value;
}

export type SedesAgentToolEndpoint =
  | Readonly<{ readonly type: "http"; readonly origin: URL }>
  | Readonly<{ readonly type: "unix"; readonly socketPath: string }>
  | AgentToolCliNamedPipeEndpoint;

export function normalizeSedesAgentToolEndpoint(
  value: string | undefined,
): SedesAgentToolEndpoint {
  if (!value) {
    throw invalidEndpoint(
      `${SEDES_AGENT_TOOL_ENDPOINT_VARIABLE} is required.`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidEndpoint(
      `${SEDES_AGENT_TOOL_ENDPOINT_VARIABLE} is invalid.`,
    );
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw invalidEndpoint(
        `${SEDES_AGENT_TOOL_ENDPOINT_VARIABLE} must be an HTTP(S) origin without credentials, path, query, or fragment.`,
      );
    }
    return Object.freeze({ type: "http", origin: new URL(url.origin) });
  }
  const pipe = parseAgentToolCliNamedPipeEndpoint(value);
  if (pipe) return pipe;
  if (!isAgentToolCliEndpoint(value)) {
    throw invalidEndpoint(
      `${SEDES_AGENT_TOOL_ENDPOINT_VARIABLE} must be an HTTP(S) origin, canonical absolute Unix socket URL, or capability-bound named pipe URL.`,
    );
  }
  const socketPath = url.pathname;
  return Object.freeze({ type: "unix", socketPath });
}

function invalidEndpoint(message: string): SedesToolApiError {
  return new SedesToolApiError("invalid_environment", message, false);
}
