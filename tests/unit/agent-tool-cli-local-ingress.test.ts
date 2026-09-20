import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TOOL_CLI_PROTOCOL_VERSION,
  AgentToolCliFrameDecoder,
  agentToolCliResponseSchema,
  encodeAgentToolCliFrame,
  type AgentToolCliRequest,
  type AgentToolCliResponse,
  type AgentToolCliResult,
} from "../../src/internal/agent-tool-cli-protocol/index.js";
import {
  AgentToolCliIngressError,
  AgentToolCliLocalIngress,
  type AgentToolCliIngressRelay,
} from "../../src/server/sidecar/agent-tool-cli-local-ingress.js";

const roots = new Set<string>();
const ENDPOINT_KEY = randomBytes(12).toString("hex");

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("agent-tool CLI Unix socket ingress", () => {
  it("uses a short private default endpoint with a long HOME and TMPDIR", async () => {
    vi.stubEnv("HOME", `/home/${"a-long-account-and-workspace-directory-".repeat(8)}`);
    vi.stubEnv("TMPDIR", `/tmp/${"a-long-temporary-directory-".repeat(8)}`);
    const runtimeDirectory = path.join(await realpath("/tmp"), `sedes-agent-tools-${process.geteuid!()}`);
    const existed = await lstat(runtimeDirectory).then(() => true, () => false);
    const ingress = await AgentToolCliLocalIngress.start({ endpointKey: randomBytes(12).toString("hex"), relay: relay() });
    try {
      expect(path.dirname(path.dirname(ingress.socketPath))).toBe(runtimeDirectory);
      expect(Buffer.byteLength(ingress.socketPath)).toBeLessThanOrEqual(100);
      expect((await lstat(runtimeDirectory)).mode & 0o777).toBe(0o700);
      await expect(call(ingress.socketPath, listRequest())).resolves.toMatchObject({ result: { type: "list" } });
    } finally {
      await ingress.close();
      if (!existed) await rmdir(runtimeDirectory).catch(error => { if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error; });
    }
  });

  it("creates an owner-only endpoint directory and socket and relays one request", async () => {
    const runtimeDirectory = await privateRuntimeDirectory();
    const seen: AgentToolCliRequest[] = [];
    const ingress = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      relay: relay(async (request) => {
        seen.push(request);
        return { type: "list", value: { tools: [] } };
      }),
    });
    const sessionMetadata = await lstat(path.dirname(ingress.socketPath));
    const socketMetadata = await lstat(ingress.socketPath);
    expect(ingress.socketPath).toBe(
      path.join(runtimeDirectory, ENDPOINT_KEY, "agent-tools.sock"),
    );
    expect(sessionMetadata.mode & 0o777).toBe(0o700);
    expect(socketMetadata.isSocket()).toBe(true);
    expect(socketMetadata.mode & 0o777).toBe(0o600);

    const request = listRequest();
    await expect(call(ingress.socketPath, request)).resolves.toEqual({
      protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
      requestId: request.requestId,
      result: { type: "list", value: { tools: [] } },
    });
    expect(seen).toEqual([request]);

    await ingress.close();
    await expect(lstat(ingress.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.dirname(ingress.socketPath))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    await expect(
      lstat(path.dirname(path.dirname(ingress.socketPath))),
    ).resolves.toMatchObject({
      mode: expect.any(Number),
    });
  });

  it("rejects a namespace that is a symlink or is not exact owner-only mode", async () => {
    const root = await temporaryRoot();
    const real = path.join(root, "real");
    await mkdir(real, { mode: 0o700 });
    const linked = path.join(root, "linked");
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(real, linked),
    );
    await expect(
      AgentToolCliLocalIngress.start({
        runtimeDirectory: linked,
        endpointKey: ENDPOINT_KEY,
        relay: relay(),
      }),
    ).rejects.toThrow("agent_tool_cli_ingress_namespace_invalid");

    await chmod(real, 0o750);
    await expect(
      AgentToolCliLocalIngress.start({
        runtimeDirectory: real,
        endpointKey: ENDPOINT_KEY,
        relay: relay(),
      }),
    ).rejects.toThrow("agent_tool_cli_ingress_namespace_invalid");
  });

  it("rejects a second live listener for the same endpoint", async () => {
    const runtimeDirectory = await privateRuntimeDirectory();
    const first = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      relay: relay(),
    });
    await expect(
      AgentToolCliLocalIngress.start({
        runtimeDirectory,
        endpointKey: ENDPOINT_KEY,
        relay: relay(),
      }),
    ).rejects.toThrow("agent_tool_cli_ingress_socket_active");
    await first.close();
  });

  it("reuses the stable endpoint path after a clean sidecar restart", async () => {
    const runtimeDirectory = await privateRuntimeDirectory();
    const first = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      relay: relay(),
    });
    const socketPath = first.socketPath;
    await first.close();

    const restarted = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      relay: relay(),
    });
    expect(restarted.socketPath).toBe(socketPath);
    await restarted.close();
  });

  it("maps bounded relay errors without exposing arbitrary failures", async () => {
    const runtimeDirectory = await privateRuntimeDirectory();
    let failure: unknown = new AgentToolCliIngressError({
      code: "permission_denied",
      message: "This thread cannot invoke that tool.",
      retryable: false,
    });
    const ingress = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      relay: relay(async () => {
        throw failure;
      }),
    });
    const first = listRequest();
    await expect(call(ingress.socketPath, first)).resolves.toMatchObject({
      requestId: first.requestId,
      error: { code: "permission_denied", retryable: false },
    });
    failure = new Error("sensitive remote diagnostic");
    const second = listRequest("8cc97061-1c25-4d97-b3ef-e6d637855ae1");
    await expect(call(ingress.socketPath, second)).resolves.toEqual({
      protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
      requestId: second.requestId,
      error: {
        code: "internal_error",
        message: "The Sedes tool request failed.",
        retryable: false,
      },
    });
    await ingress.close();
  });

  it("bounds relay execution by the request deadline and propagates cancellation", async () => {
    const runtimeDirectory = await privateRuntimeDirectory();
    let observedAbort: Promise<unknown> | undefined;
    const ingress = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      listDescribeTimeoutMilliseconds: 10,
      relay: relay(async (_request, signal) => {
        observedAbort = new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve(signal.reason), {
            once: true,
          }),
        );
        return await new Promise<AgentToolCliResult>(() => undefined);
      }),
    });
    const request = listRequest();
    await expect(call(ingress.socketPath, request)).resolves.toMatchObject({
      requestId: request.requestId,
      error: { code: "timed_out", retryable: true },
    });
    await expect(observedAbort).resolves.toBeInstanceOf(Error);
    await ingress.close();
  });

  it("does not impose an invocation response deadline", async () => {
    const runtimeDirectory = await privateRuntimeDirectory();
    let started!: () => void;
    const relayStarted = new Promise<void>((resolve) => (started = resolve));
    let signal: AbortSignal | undefined;
    const ingress = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      listDescribeTimeoutMilliseconds: 10,
      relay: relay(
        async (_request, observedSignal) => {
          signal = observedSignal;
          started();
          return await new Promise<AgentToolCliResult>(() => undefined);
        },
      ),
    });
    const request: AgentToolCliRequest = {
      ...listRequest(),
      operation: {
        type: "invoke",
        request: {
          toolId: "agent.context",
          schemaVersion: 2,
          requestId: "invocation-request",
          input: {},
        },
      },
    };
    const socket = net.createConnection(ingress.socketPath);
    socket.write(Buffer.from(encodeAgentToolCliFrame(request)));
    await relayStarted;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(signal?.aborted).toBe(false);
    socket.destroy();
    await ingress.close();
  });

  it("rejects malformed and trailing frames without invoking the relay", async () => {
    const runtimeDirectory = await privateRuntimeDirectory();
    let calls = 0;
    const ingress = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      relay: relay(async () => {
        calls += 1;
        return { type: "list", value: { tools: [] } };
      }),
    });
    await sendInvalid(ingress.socketPath, Buffer.from([0, 0, 0, 0]));
    await sendInvalid(
      ingress.socketPath,
      Buffer.concat([
        Buffer.from(encodeAgentToolCliFrame(listRequest())),
        Buffer.from([0x01]),
      ]),
    );
    expect(calls).toBe(0);
    await ingress.close();
  });

  it("bounds concurrent clients and remains usable after capacity is released", async () => {
    const runtimeDirectory = await privateRuntimeDirectory();
    const ingress = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      maximumClients: 1,
      relay: relay(),
    });
    const occupying = net.createConnection(ingress.socketPath);
    await new Promise<void>((resolve, reject) => {
      occupying.once("connect", resolve);
      occupying.once("error", reject);
    });
    const rejected = net.createConnection(ingress.socketPath);
    await new Promise<void>((resolve) => {
      rejected.once("close", () => resolve());
      rejected.once("error", () => undefined);
    });
    occupying.destroy();
    await new Promise<void>((resolve) => occupying.once("close", resolve));
    const request = listRequest();
    await expect(call(ingress.socketPath, request)).resolves.toMatchObject({
      requestId: request.requestId,
      result: { type: "list" },
    });
    await ingress.close();
  });

  it("cancels the relay when a CLI client disconnects", async () => {
    const runtimeDirectory = await privateRuntimeDirectory();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => (resolveStarted = resolve));
    let observedAbort: Promise<unknown> | undefined;
    const ingress = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      relay: relay(async (_request, signal) => {
        observedAbort = new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve(signal.reason), {
            once: true,
          }),
        );
        resolveStarted();
        return await new Promise<AgentToolCliResult>(() => undefined);
      }),
    });
    const socket = net.createConnection(ingress.socketPath);
    socket.write(Buffer.from(encodeAgentToolCliFrame(listRequest())));
    await started;
    socket.destroy();
    await expect(observedAbort).resolves.toBeInstanceOf(Error);
    await ingress.close();
  });

  it("does not unlink a replacement inode during cleanup", async () => {
    const runtimeDirectory = await privateRuntimeDirectory();
    const ingress = await AgentToolCliLocalIngress.start({
      runtimeDirectory,
      endpointKey: ENDPOINT_KEY,
      relay: relay(),
    });
    await unlink(ingress.socketPath);
    await writeFile(ingress.socketPath, "replacement", { mode: 0o600 });

    await expect(ingress.close()).rejects.toThrow(
      "agent_tool_cli_ingress_socket_ownership_lost",
    );
    await expect(readFile(ingress.socketPath, "utf8")).resolves.toBe(
      "replacement",
    );
  });
});

function relay(
  handle: (
    request: AgentToolCliRequest,
    signal: AbortSignal,
  ) => Promise<AgentToolCliResult> = async () => ({
    type: "list",
    value: { tools: [] },
  }),
): AgentToolCliIngressRelay {
  return {
    handle: async (request, { signal }) => await handle(request, signal),
  };
}

function listRequest(
  requestId = "d219ef2e-a295-43f0-b5c9-b4b6930673e2",
): AgentToolCliRequest {
  return {
    protocolVersion: AGENT_TOOL_CLI_PROTOCOL_VERSION,
    requestId,
    sourceCapability: "c".repeat(48),
    operation: { type: "list" },
  };
}

async function call(
  socketPath: string,
  request: AgentToolCliRequest,
): Promise<AgentToolCliResponse> {
  const socket = net.createConnection(socketPath);
  const decoder = new AgentToolCliFrameDecoder();
  let decoded: unknown;
  socket.write(Buffer.from(encodeAgentToolCliFrame(request)));
  for await (const chunk of socket) {
    const value = decoder.push(chunk as Buffer);
    if (value !== undefined) decoded = value;
  }
  decoder.finishRequest();
  return agentToolCliResponseSchema.parse(decoded);
}

async function sendInvalid(
  socketPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const socket = net.createConnection(socketPath);
  socket.end(Buffer.from(bytes));
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
}

async function privateRuntimeDirectory(): Promise<string> {
  return await temporaryRoot();
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hat-"));
  roots.add(root);
  return root;
}
