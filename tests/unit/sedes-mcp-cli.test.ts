import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runSedesCli } from "../../src/cli/sedes-cli.js";
import { runSedesMcp, type SedesMcpOutput } from "../../src/cli/sedes-mcp.js";
import { SEDES_MCP_MAXIMUM_INBOUND_LINE_BYTES } from "../../src/internal/agent-tool-mcp/mcp-protocol.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import {
  SEDES_AGENT_TOOL_CSRF_ROUTE,
  SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
} from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";

const sourceCapability = "m".repeat(48);
const threadId = "10000000-0000-4000-8000-000000000001";

function canonical() {
  return new CanonicalInlineAgentToolService({
    application: { readThreadStatus: async () => undefined },
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The management HTTP routes as the `sedes mcp` HTTP client sees them. */
function sedesHttp() {
  const tools = canonical();
  const requests: { path: string; capability: string | null }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const headers = new Headers(init?.headers);
    requests.push({
      path,
      capability: headers.get(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER),
    });
    if (path === "/api/agent-tools") {
      return json({ tools: tools.catalogSummaries("mcp", "thread_agent") });
    }
    if (path === "/api/agent-tool-descriptions") {
      const { toolIds } = JSON.parse(String(init?.body)) as { toolIds: string[] };
      return json({ tools: tools.describeMany("mcp", "thread_agent", toolIds) });
    }
    if (path === SEDES_AGENT_TOOL_CSRF_ROUTE) return json({ csrfToken: "csrf-1" });
    if (path === "/api/agent-tool-invocations") {
      return json({
        invocationId: "invocation-1",
        state: "completed",
        output: { backend: "codex_app_server", threadId, workspaceId: "workspace-1" },
      });
    }
    return json({ error: { code: "not_found", message: "Missing.", retryable: false } }, 404);
  });
  return { fetch, requests };
}

function collected(): { output: SedesMcpOutput; lines: () => unknown[]; text: () => string } {
  let text = "";
  return {
    output: {
      write(chunk: string) {
        text += chunk;
        return true;
      },
      once: () => undefined,
    },
    lines: () =>
      text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
    text: () => text,
  };
}

function stderr() {
  let text = "";
  return {
    sink: { write: (value: string) => void (text += value) },
    text: () => text,
  };
}

const environment = {
  SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
  SEDES_AGENT_TOOL_SOURCE_CAPABILITY: sourceCapability,
};

function message(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

const initialize = message({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex", version: "0.153.0" },
  },
});

describe("sedes mcp command", () => {
  it("serves newline-delimited JSON-RPC until stdin closes", async () => {
    const http = sedesHttp();
    const input = new PassThrough();
    const output = collected();
    const errors = stderr();
    const done = runSedesMcp(["--mode", "individual"], {
      environment,
      input,
      output: output.output,
      stderr: errors.sink,
      fetch: http.fetch as typeof globalThis.fetch,
      id: () => "tool-request-1",
    });
    input.write(initialize);
    input.write(message({ jsonrpc: "2.0", method: "notifications/initialized" }));
    // Split one message across chunks and send a CRLF terminator.
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    input.write(list.slice(0, 10));
    input.write(`${list.slice(10)}\r\n`);
    input.write(
      message({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "sedes_agent_context", arguments: {} },
      }),
    );
    await vi.waitFor(() => expect(output.lines()).toHaveLength(3));
    input.end();
    await expect(done).resolves.toBe(0);

    const [initialized, listed, called] = output.lines();
    expect(initialized).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "sedes" } },
    });
    expect(
      (listed as { result: { tools: { name: string }[] } }).result.tools.map(
        ({ name }) => name,
      ),
    ).toEqual(["sedes_agent_context", "sedes_thread_status"]);
    expect(called).toMatchObject({
      id: 3,
      result: {
        structuredContent: { backend: "codex_app_server", threadId },
      },
    });
    expect(errors.text()).toBe("");
    // Only the per-process CSRF bootstrap is sent without the thread reference.
    expect(
      http.requests
        .filter(({ path }) => path !== SEDES_AGENT_TOOL_CSRF_ROUTE)
        .every(({ capability }) => capability === sourceCapability),
    ).toBe(true);
    expect(output.text().endsWith("\n")).toBe(true);
  });

  it("requires an explicit presentation mode", async () => {
    for (const args of [[], ["--mode"], ["--mode", "native"], ["--mode", "individual", "x"]]) {
      const output = collected();
      const errors = stderr();
      await expect(
        runSedesMcp(args, { environment, output: output.output, stderr: errors.sink }),
      ).resolves.toBe(2);
      expect(output.text()).toBe("");
      expect(errors.text()).toContain("--mode progressive or --mode individual");
    }
    const output = collected();
    await expect(
      runSedesMcp(["--mode=progressive"], {
        environment,
        input: (async function* () {})(),
        output: output.output,
        stderr: stderr().sink,
      }),
    ).resolves.toBe(0);
  });

  it("prints usage for --help without starting the server", async () => {
    const output = collected();
    await expect(runSedesMcp(["--help"], { output: output.output })).resolves.toBe(0);
    expect(output.text()).toContain("sedes mcp --mode <progressive|individual>");
  });

  it.each([
    ["a missing endpoint", { SEDES_AGENT_TOOL_SOURCE_CAPABILITY: sourceCapability }, "SEDES_AGENT_TOOL_ENDPOINT"],
    ["a missing thread reference", { SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784" }, "SEDES_AGENT_TOOL_SOURCE_CAPABILITY"],
    [
      "a principal Tool client token",
      {
        ...environment,
        SEDES_AGENT_TOOL_CLIENT_TOKEN: `hatc1_10000000-0000-4000-8000-000000000001_1_${"a".repeat(43)}`,
      },
      "thread agents only",
    ],
  ])("fails before serving with %s", async (_label, env, expected) => {
    const output = collected();
    const errors = stderr();
    await expect(
      runSedesMcp(["--mode", "individual"], {
        environment: env,
        output: output.output,
        stderr: errors.sink,
      }),
    ).resolves.toBe(1);
    expect(output.text()).toBe("");
    expect(errors.text()).toContain(expected);
    expect(errors.text()).not.toContain(sourceCapability);
  });

  it("exits on an oversized message without writing to stdout", async () => {
    const output = collected();
    const errors = stderr();
    const oversized = Buffer.alloc(SEDES_MCP_MAXIMUM_INBOUND_LINE_BYTES + 1, 0x20);
    await expect(
      runSedesMcp(["--mode", "individual"], {
        environment,
        input: (async function* () {
          yield oversized;
        })(),
        output: output.output,
        stderr: errors.sink,
      }),
    ).resolves.toBe(1);
    expect(output.text()).toBe("");
    expect(errors.text()).toBe("sedes mcp received an oversized message.\n");
  });

  it("stops when its process signal aborts", async () => {
    const controller = new AbortController();
    const input = new PassThrough();
    const done = runSedesMcp(["--mode", "progressive"], {
      environment,
      input,
      output: collected().output,
      stderr: stderr().sink,
      signal: controller.signal,
    });
    controller.abort(new Error("interrupted"));
    await expect(done).resolves.toBe(0);
  });

  it("is dispatched by the shared CLI without a CLI mode hint", async () => {
    let errors = "";
    await expect(
      runSedesCli(["mcp", "--mode", "native"], {
        environment,
        io: {
          stdout: { write: () => undefined },
          stderr: { write: (value: string) => void (errors += value) },
        },
      }),
    ).resolves.toBe(2);
    expect(errors).toContain("sedes mcp --mode <progressive|individual>");
    expect(errors).not.toContain("SEDES_AGENT_TOOL_CLI_MODE");
  });
});
