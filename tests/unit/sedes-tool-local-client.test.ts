import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SedesToolLocalClient } from "../../src/cli/sedes-tool-local-client.js";
import {
  AGENT_TOOL_CLI_PROTOCOL_VERSION,
  AgentToolCliFrameDecoder,
  agentToolCliRequestSchema,
  encodeAgentToolCliFrame,
  type AgentToolCliRequest,
  type AgentToolCliResult,
} from "../../src/internal/agent-tool-cli-protocol/index.js";

const roots: string[] = [];
const servers: Server[] = [];
const sourceCapability = "c".repeat(48);
const transportRequestId = "20000000-0000-4000-8000-000000000001";

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function socketPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "h-cli-"));
  roots.push(root);
  const runtime = path.join(root, "r");
  await mkdir(runtime);
  return path.join(runtime, "t.sock");
}

async function listen(
  handler: (request: AgentToolCliRequest, socket: Socket) => void,
): Promise<string> {
  const endpoint = await socketPath();
  const server = createServer((socket) => {
    const decoder = new AgentToolCliFrameDecoder();
    socket.on("data", (chunk) => {
      const value = decoder.push(Buffer.from(chunk));
      if (value !== undefined)
        handler(agentToolCliRequestSchema.parse(value), socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
  return endpoint;
}

function respond(
  socket: Socket,
  request: AgentToolCliRequest,
  result: AgentToolCliResult,
): void {
  socket.end(
    encodeAgentToolCliFrame({
      protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
      requestId: request.requestId,
      result,
    }),
  );
}

describe("SedesToolLocalClient", () => {
  it("sends a scoped framed list request and validates the framed result", async () => {
    let observed: AgentToolCliRequest | undefined;
    const endpoint = await listen((request, socket) => {
      observed = request;
      respond(socket, request, { type: "list", value: { tools: [] } });
    });
    const client = new SedesToolLocalClient(
      endpoint,
      sourceCapability,
      undefined,
      () => transportRequestId,
    );

    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    expect(observed).toEqual({
      protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
      requestId: transportRequestId,
      sourceCapability,
      operation: { type: "list" },
    });
  });

  it("preserves canonical relay errors", async () => {
    const endpoint = await listen((request, socket) => {
      socket.end(
        encodeAgentToolCliFrame({
          protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
          requestId: request.requestId,
          error: {
            code: "permission_denied",
            message: "The tool is disabled.",
            retryable: false,
          },
        }),
      );
    });
    const client = new SedesToolLocalClient(
      endpoint,
      sourceCapability,
      undefined,
      () => transportRequestId,
    );

    await expect(client.listTools()).rejects.toMatchObject({
      code: "permission_denied",
      retryable: false,
    });
  });

  it("reports an uncertain invocation after its request is delivered and the carrier closes", async () => {
    const endpoint = await listen((_request, socket) => socket.destroy());
    const client = new SedesToolLocalClient(
      endpoint,
      sourceCapability,
      undefined,
      () => transportRequestId,
    );

    await expect(
      client.invoke({
        toolId: "agent.context",
        schemaVersion: 2,
        requestId: "invocation-request",
        input: {},
      }),
    ).rejects.toMatchObject({ code: "uncertain_outcome", retryable: false });
  });

  it("preserves caller cancellation", async () => {
    const endpoint = await listen(() => undefined);
    const client = new SedesToolLocalClient(
      endpoint,
      sourceCapability,
      undefined,
      () => transportRequestId,
    );
    const controller = new AbortController();
    const reason = new Error("caller_cancelled");
    const pending = client.listTools(controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("reports an uncertain invocation when caller cancellation follows delivery", async () => {
    const controller = new AbortController();
    const endpoint = await listen(() =>
      controller.abort(new Error("caller_cancelled")),
    );
    const client = new SedesToolLocalClient(
      endpoint,
      sourceCapability,
      undefined,
      () => transportRequestId,
    );

    await expect(
      client.invoke(
        {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "invocation-request",
          input: {},
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "uncertain_outcome", retryable: false });
  });

  it("rejects malformed, mismatched, and trailing frames", async () => {
    for (const reply of [
      {
        protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        result: { type: "list", value: { tools: [] } },
      },
      {
        protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
        requestId: transportRequestId,
        result: { type: "unknown", value: {} },
      },
    ]) {
      const endpoint = await listen((_request, socket) =>
        socket.end(encodeAgentToolCliFrame(reply)),
      );
      const client = new SedesToolLocalClient(
        endpoint,
        sourceCapability,
        undefined,
        () => transportRequestId,
      );
      await expect(client.listTools()).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });
});
