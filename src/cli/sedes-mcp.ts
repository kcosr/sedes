import { SEDES_VERSION } from "../shared/version.js";
import { SedesMcpLineDecoder } from "../internal/agent-tool-mcp/mcp-protocol.js";
import { createSedesToolClient } from "./create-sedes-tool-client.js";
import {
  SEDES_AGENT_TOOL_CLIENT_TOKEN_VARIABLE,
  SEDES_AGENT_TOOL_ENDPOINT_VARIABLE,
  SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE,
  normalizeSedesAgentToolEndpoint,
} from "./sedes-agent-tool-endpoint.js";
import { SedesMcpServer, type SedesMcpPresentationMode } from "./sedes-mcp-server.js";
import {
  SedesToolApiError,
  normalizeSedesAgentToolSourceCapability,
} from "./sedes-tool-client.js";
import type { SedesToolLocalSocketConnector } from "./sedes-tool-local-client.js";

const usage = `Usage:
  sedes mcp --mode <progressive|individual>

Serves the thread's Sedes tools as a stdio MCP server. The provider starts it
with SEDES_AGENT_TOOL_ENDPOINT and SEDES_AGENT_TOOL_SOURCE_CAPABILITY set.
`;

/** A stdout-like sink that reports backpressure the way Node streams do. */
export interface SedesMcpOutput {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
}

export interface SedesMcpDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly input?: AsyncIterable<Uint8Array | string>;
  readonly output?: SedesMcpOutput;
  readonly stderr?: { write(value: string): unknown };
  readonly fetch?: typeof globalThis.fetch;
  readonly connect?: SedesToolLocalSocketConnector;
  readonly transportRequestId?: () => string;
  readonly id?: () => string;
  readonly signal?: AbortSignal;
}

class SedesMcpUsageError extends Error {}

function parseMode(arguments_: readonly string[]): SedesMcpPresentationMode {
  const [option, value, ...rest] =
    arguments_.length === 1 && arguments_[0]?.startsWith("--mode=")
      ? ["--mode", arguments_[0].slice("--mode=".length)]
      : arguments_;
  if (
    option !== "--mode" ||
    rest.length !== 0 ||
    (value !== "progressive" && value !== "individual")
  ) {
    throw new SedesMcpUsageError("sedes mcp requires --mode progressive or --mode individual.");
  }
  return value;
}

/**
 * Runs `sedes mcp` until stdin closes. Stdout carries only JSON-RPC; every
 * diagnostic goes to stderr as a fixed message that never echoes credentials.
 */
export async function runSedesMcp(
  arguments_: readonly string[],
  dependencies: SedesMcpDependencies = {},
): Promise<number> {
  const stderr = dependencies.stderr ?? process.stderr;
  const output = dependencies.output ?? process.stdout;
  if (
    arguments_.length === 1 &&
    (arguments_[0] === "--help" || arguments_[0] === "-h")
  ) {
    output.write(usage);
    return 0;
  }
  let server: SedesMcpServer;
  let writes = Promise.resolve();
  let writeFailed = false;
  try {
    const mode = parseMode(arguments_);
    const environment = dependencies.environment ?? process.env;
    if (environment[SEDES_AGENT_TOOL_CLIENT_TOKEN_VARIABLE]) {
      throw new SedesToolApiError(
        "invalid_environment",
        `sedes mcp serves thread agents only; unset ${SEDES_AGENT_TOOL_CLIENT_TOKEN_VARIABLE}.`,
        false,
      );
    }
    const endpoint = normalizeSedesAgentToolEndpoint(
      environment[SEDES_AGENT_TOOL_ENDPOINT_VARIABLE],
    );
    const sourceCapability = normalizeSedesAgentToolSourceCapability(
      environment[SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE],
    );
    const client = createSedesToolClient({
      endpoint,
      credential: { kind: "thread_source", value: sourceCapability },
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(dependencies.connect ? { connect: dependencies.connect } : {}),
      ...(dependencies.transportRequestId
        ? { transportRequestId: dependencies.transportRequestId }
        : {}),
    });
    server = new SedesMcpServer({
      client,
      mode,
      serverVersion: SEDES_VERSION,
      ...(dependencies.id ? { requestId: dependencies.id } : {}),
      send: (message) => {
        const line = `${JSON.stringify(message)}\n`;
        writes = writes.then(async () => {
          if (writeFailed) return;
          try {
            if (!output.write(line)) {
              await new Promise<void>((resolve) => output.once("drain", resolve));
            }
          } catch {
            writeFailed = true;
          }
        });
        return writes;
      },
    });
  } catch (error) {
    if (error instanceof SedesMcpUsageError) {
      stderr.write(`${error.message}\n${usage}`);
      return 2;
    }
    stderr.write(
      error instanceof SedesToolApiError
        ? `${error.code}: ${error.message}\n`
        : "sedes mcp could not start.\n",
    );
    return 1;
  }

  const input = dependencies.input ?? process.stdin;
  const iterator = input[Symbol.asyncIterator]();
  const stopped = new Promise<IteratorResult<Uint8Array | string>>((resolve) => {
    if (dependencies.signal?.aborted) resolve({ done: true, value: undefined });
    dependencies.signal?.addEventListener(
      "abort",
      () => resolve({ done: true, value: undefined }),
      { once: true },
    );
  });
  const decoder = new SedesMcpLineDecoder();
  let exitCode = 0;
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), stopped]);
      if (next.done || writeFailed) break;
      const chunk =
        typeof next.value === "string" ? Buffer.from(next.value, "utf8") : next.value;
      for (const line of decoder.push(chunk)) server.receive(line);
    }
  } catch (error) {
    stderr.write(
      error instanceof Error && error.message === "sedes_mcp_message_too_large"
        ? "sedes mcp received an oversized message.\n"
        : "sedes mcp could not read its input.\n",
    );
    exitCode = 1;
  } finally {
    // A read may still be pending after a signal stop; releasing the input
    // must not wait for it.
    void iterator.return?.().catch(() => undefined);
    await server.close();
    await writes;
  }
  return exitCode;
}

