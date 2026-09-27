import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BackendAgentToolRequestError } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { OpenCodeMcpIngress } from "../../src/server/backends/opencode/opencode-mcp-ingress.js";
import { SEDES_VERSION } from "../../src/shared/version.js";
import { buildSedesToolExecutable } from "../helpers/built-sedes-cli.js";

const run = promisify(execFile);
const roots: string[] = [];
const executables = new Map<string, string>();

beforeAll(async () => {
  const provider = await buildSedesToolExecutable();
  roots.push(provider.buildRoot);
  executables.set("local provider", provider.executable);
  const sidecar = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-mcp-package-"));
  roots.push(sidecar);
  await run(process.execPath, [path.resolve("scripts/build-sidecar.mjs"), "--output-directory", sidecar], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  executables.set("sidecar", path.join(sidecar, "sedes"));
}, 60_000);

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("built OpenCode MCP entrypoints", () => {
  it.each(["local provider", "sidecar"])("runs the shared private bridge through the actual %s executable", async kind => {
    const executable = executables.get(kind)!;
    const ingress = new OpenCodeMcpIngress();
    const observed: string[] = [];
    const channel = await ingress.admit({ catalog: [], invoke: async request => {
      observed.push(request.sessionID);
      if (request.operation !== "list" || request.sessionID !== "ses_admitted") {
        throw new BackendAgentToolRequestError({ code: "permission_denied", message: "Unmapped session.", retryable: false });
      }
      return { tools: [] };
    } });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [executable, "opencode-mcp"],
      env: { ...channel.environment, SEDES_AGENT_TOOL_CLI_MODE: "not-a-cli-mode" },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", value => { stderr += String(value); });
    const client = new Client({ name: "sedes-opencode-package-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({ name: "sedes" });
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
        "sedes_catalog", "sedes_read", "sedes_act",
      ]);
      const result = await client.callTool({ name: "sedes_catalog", arguments: { action: "list" },
        _meta: { "ai.opencode/sessionID": "ses_admitted" } });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ tools: [] });
      expect(observed).toEqual(["ses_admitted"]);
      expect((await client.callTool({ name: "sedes_catalog", arguments: { action: "list" } })).isError).toBe(true);
      expect(observed).toEqual(["ses_admitted"]);
      expect((await client.callTool({ name: "sedes_catalog", arguments: { action: "list" },
        _meta: { "ai.opencode/sessionID": "ses_foreign" } })).isError).toBe(true);
      expect(observed).toEqual(["ses_admitted", "ses_foreign"]);
      channel.revoke();
      await vi.waitFor(() => expect(transport.pid).toBeNull(), { timeout: 5_000 });
      expect(stderr).toBe("");
    } finally {
      channel.revoke();
      await client.close();
      await ingress.close();
    }
    await expect(run(process.execPath, [executable, "opencode-mcp"], { env: {}, timeout: 5_000 }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "Sedes OpenCode tools are unavailable.\n" });
    expect((await run(process.execPath, [executable, "--version"], { env: {}, timeout: 5_000 })).stdout)
      .toBe(`sedes ${SEDES_VERSION}\n`);
  }, 15_000);
});
