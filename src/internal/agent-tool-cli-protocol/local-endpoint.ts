import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const NAMED_PIPE_ENDPOINT = /^npipe:\/\/\.\/pipe\/sedes-agent-tools-([0-9a-f]{64})#([0-9a-f]{64})$/u;
export const AGENT_TOOL_CLI_MAXIMUM_UNIX_SOCKET_PATH_BYTES = 100;

export interface AgentToolCliNamedPipeEndpoint {
  readonly type: "npipe";
  readonly socketPath: string;
  readonly capability: string;
}

/** The fragment is a private TLS PSK, never a hostname or provider credential. */
export function createAgentToolCliNamedPipeEndpoint(): string {
  const capability = randomBytes(32).toString("hex");
  return `npipe://./pipe/sedes-agent-tools-${capabilityDigest(capability)}#${capability}`;
}

export function parseAgentToolCliNamedPipeEndpoint(
  value: string,
): AgentToolCliNamedPipeEndpoint | undefined {
  const match = NAMED_PIPE_ENDPOINT.exec(value);
  if (!match || match[1] !== capabilityDigest(match[2]!)) return undefined;
  return Object.freeze({
    type: "npipe",
    socketPath: `\\\\.\\pipe\\sedes-agent-tools-${match[1]}`,
    capability: match[2]!,
  });
}

/** Closed sidecar-local callback endpoints; HTTP origins are intentionally excluded. */
export function isAgentToolCliEndpoint(value: string): boolean {
  if (parseAgentToolCliNamedPipeEndpoint(value)) return true;
  try {
    const url = new URL(value);
    const socketPath = url.pathname;
    return (
      url.protocol === "unix:" &&
      !url.host &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !value.includes("%") &&
      socketPath.startsWith("/") &&
      socketPath !== "/" &&
      !socketPath.endsWith("/") &&
      path.posix.normalize(socketPath) === socketPath &&
      !/[\u0000-\u001f\u007f\\]/u.test(socketPath) &&
      Buffer.byteLength(socketPath, "utf8") <=
        AGENT_TOOL_CLI_MAXIMUM_UNIX_SOCKET_PATH_BYTES &&
      value === url.href &&
      url.href === `unix://${socketPath}`
    );
  } catch {
    return false;
  }
}

function capabilityDigest(capability: string): string {
  return createHash("sha256").update(Buffer.from(capability, "hex")).digest("hex");
}
