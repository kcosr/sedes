import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSedesToolClient } from "../../src/cli/create-sedes-tool-client.js";
import { normalizeSedesAgentToolEndpoint } from "../../src/cli/sedes-agent-tool-endpoint.js";
import { createAgentToolCliNamedPipeEndpoint, parseAgentToolCliNamedPipeEndpoint } from "../../src/internal/agent-tool-cli-protocol/local-endpoint.js";
import { createAgentToolCliNamedPipeServer } from "../../src/internal/agent-tool-cli-protocol/named-pipe-tls.js";
import { AgentToolCliFrameDecoder, agentToolCliRequestSchema, encodeAgentToolCliFrame, AGENT_TOOL_CLI_PROTOCOL_VERSION } from "../../src/internal/agent-tool-cli-protocol/index.js";
import { AgentToolCliLocalIngress } from "../../src/server/sidecar/agent-tool-cli-local-ingress.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const url = createAgentToolCliNamedPipeEndpoint();
  const endpoint = parseAgentToolCliNamedPipeEndpoint(url)!;
  const root = await mkdtemp(path.join(tmpdir(), "sedes-psk-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const localPath = process.platform === "win32" ? endpoint.socketPath : path.join(root, "cli.sock");
  const server = createAgentToolCliNamedPipeServer(endpoint.capability, 200);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(localPath, resolve); });
  const observed = vi.fn();
  server.on("secureConnection", (socket) => {
    const decoder = new AgentToolCliFrameDecoder();
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      const value = decoder.push(chunk);
      if (value === undefined) return;
      const request = agentToolCliRequestSchema.parse(value);
      observed(request);
      socket.end(encodeAgentToolCliFrame({ protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION, requestId: request.requestId, result: { type: "list", value: { tools: [] } } }));
    });
  });
  const client = (clientUrl = url) => createSedesToolClient({
    endpoint: normalizeSedesAgentToolEndpoint(clientUrl),
    credential: { kind: "thread_source", value: "c".repeat(48) },
    connect: (requestedPath) => {
      expect(requestedPath).toMatch(/^\\\\\.\\pipe\\sedes-agent-tools-[0-9a-f]{64}$/u);
      return createConnection({ path: localPath });
    },
  });
  return { client, observed, localPath };
}

describe("agent tool named pipe admission", () => {
  it("relays real CLI frames through PSK-encrypted IPC", async () => {
    const { client, observed } = await fixture();
    await expect(client().listTools()).resolves.toEqual({ tools: [] });
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ sourceCapability: "c".repeat(48), operation: { type: "list" } }));
  });

  it("rejects another incarnation's capability before exposing source credentials", async () => {
    const { client, observed } = await fixture();
    await expect(client(createAgentToolCliNamedPipeEndpoint()).listTools()).rejects.toMatchObject({ code: "transport_error" });
    expect(observed).not.toHaveBeenCalled();
  });

  it("rejects plaintext peers before invoking the relay", async () => {
    const { localPath, observed } = await fixture();
    const socket = createConnection({ path: localPath });
    socket.on("error", () => {});
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(Buffer.from("unauthenticated callback"));
    await closed;
    expect(observed).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform !== "win32")("runs the production callback ingress over a native Windows named pipe", async () => {
  const relay = vi.fn(async () => ({ type: "list" as const, value: { tools: [] } }));
  const ingress = await AgentToolCliLocalIngress.start({ endpointKey: "0123456789abcdef01234567", relay: { handle: relay } });
  cleanups.push(() => ingress.close());
  expect(ingress.endpointUrl).toMatch(/^npipe:/u);
  const client = createSedesToolClient({ endpoint: normalizeSedesAgentToolEndpoint(ingress.endpointUrl), credential: { kind: "thread_source", value: "c".repeat(48) } });
  await expect(client.listTools()).resolves.toEqual({ tools: [] });
  expect(relay).toHaveBeenCalledOnce();
  await ingress.close();
  await expect(client.listTools()).rejects.toMatchObject({ code: "transport_error" });
});
