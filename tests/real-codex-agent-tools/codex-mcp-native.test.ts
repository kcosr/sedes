import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { startLiveAgentToolListener } from "../helpers/live-agent-tool-listener.js";

const roots: string[] = [];
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const liveGate = "SEDES_RUN_REAL_CODEX_AGENT_TOOLS";

function configuration(workspace: string): ConfigurationDocument {
  return {
    executionEnvironments: [{
      id: environmentId,
      kind: "local",
      label: "Local",
      workspaceRoots: [workspace],
      workspaceIsolation: {
        kind: "bubblewrap",
        networkProfiles: ["isolated", "execution_host"],
      },
    }],
    backends: [{
      id: "codex-primary",
      kind: "codex_app_server",
      label: "Codex",
      enabled: true,
      modelPolicy: { type: "catalog" },
      moduleConfiguration: {
        connection: {
          ownership: "owned",
          channel: { type: "process_stdio", workingDirectory: workspace },
        },
        policy: {
          allowedSandboxModes: ["workspace-write"],
          allowedNetworkAccess: ["enabled"],
          allowedApprovalPolicies: ["never"],
          allowedApprovalReviewers: ["user"],
        },
      },
    }],
    targets: [{
      id: "codex-local",
      kind: "codex_app_server",
      label: "Codex",
      backendInstanceId: "codex-primary",
      executionEnvironmentId: environmentId,
      enabled: true,
      moduleConfiguration: {
        defaults: {
          sandboxMode: "workspace-write",
          networkAccess: "enabled",
          approvalPolicy: "never",
          approvalReviewer: "user",
          model: { type: "fixed", modelId: "gpt-5.6-luna" },
        },
      },
    }],
    defaultTargetId: "codex-local",
    webSearch: null,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function parseJsonLines(output: string): Record<string, unknown>[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function completedItems(
  events: readonly Record<string, unknown>[],
  type: string,
): Record<string, unknown>[] {
  return events.flatMap((event) => {
    const item = event.item as Record<string, unknown> | undefined;
    return event.type === "item.completed" && item?.type === type ? [item] : [];
  });
}

/** TOML literal for one `--config` override value. */
function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  return `{ ${Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${key} = ${toml(entry)}`)
    .join(", ")} }`;
}

async function runCodex(input: {
  readonly arguments_: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.resolve("node_modules/.bin/codex"), input.arguments_, {
      cwd: input.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, 340_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut || code !== 0) {
        reject(
          new Error(
            `real_codex_mcp_failed (${String(code)}, ${String(signal)}, timedOut=${timedOut}): stderr=${result.stderr.trim()} stdout=${result.stdout.trim()}`,
          ),
        );
        return;
      }
      resolve(result);
    });
    child.stdin.end(input.stdin);
  });
}

/**
 * Runs one real Codex turn with the thread's `sedes` MCP server configured
 * exactly as Sedes sends it in thread config, against a real Sedes listener.
 */
async function nativeRun(mode: "progressive" | "individual", prompt: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-real-codex-mcp-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const listener = await startLiveAgentToolListener({
    root,
    workspace,
    configuration: configuration(workspace),
    environmentId,
    targetId: "codex-local",
    presentation: { surface: "native", mode },
    enabledToolIds: ["agent.context", "thread.status"],
  });
  try {
    const reference = listener.issue("mcp");
    const outputSchemaPath = path.join(root, "proof.schema.json");
    const outputPath = path.join(root, "proof.json");
    await writeFile(
      outputSchemaPath,
      JSON.stringify({
        type: "object",
        additionalProperties: false,
        required: ["threadId", "workspaceId", "backend"],
        properties: {
          threadId: { type: "string" },
          workspaceId: { type: "string" },
          backend: { type: "string" },
        },
      }),
    );
    const server = {
      command: path.resolve("dist/cli/provider-bin/sedes"),
      args: ["mcp", "--mode", mode],
      env: {
        SEDES_AGENT_TOOL_ENDPOINT: listener.endpoint,
        SEDES_AGENT_TOOL_SOURCE_CAPABILITY: reference,
      },
      startup_timeout_sec: 30,
      tool_timeout_sec: 86_400,
    };
    const execution = await runCodex({
      cwd: workspace,
      stdin: prompt,
      arguments_: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--json",
        "--output-schema",
        outputSchemaPath,
        "--output-last-message",
        outputPath,
        "--model",
        "gpt-5.6-luna",
        "--sandbox",
        "workspace-write",
        "--config",
        'model_reasoning_effort="low"',
        "--config",
        'approval_policy="never"',
        ...Object.entries(server).flatMap(([key, value]) => [
          "--config",
          `mcp_servers.sedes.${key}=${toml(value)}`,
        ]),
        "--cd",
        workspace,
        "-",
      ],
    });
    const events = parseJsonLines(execution.stdout);
    return {
      listener,
      reference,
      events,
      proof: JSON.parse(await readFile(outputPath, "utf8")) as unknown,
      stdout: execution.stdout,
    };
  } catch (error) {
    await listener.close();
    throw error;
  }
}

describe("real Codex Native Sedes MCP tools", () => {
  const run = process.env[liveGate] === "1" ? it : it.skip;

  run(
    "calls an individual Sedes tool through the thread's MCP server",
    async () => {
      const result = await nativeRun(
        "individual",
        [
          "Call the `sedes_agent_context` tool from the `sedes` MCP server exactly once with an empty object.",
          "Do not run any shell command.",
          "Return its threadId, workspaceId, and backend as the required JSON proof.",
        ].join("\n"),
      );
      try {
        expect(completedItems(result.events, "command_execution")).toEqual([]);
        const calls = completedItems(result.events, "mcp_tool_call");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          server: "sedes",
          tool: "sedes_agent_context",
          status: "completed",
          result: {
            structured_content: {
              threadId: result.listener.threadId,
              workspaceId: result.listener.workspaceId,
              backend: "codex_app_server",
            },
          },
        });
        expect(result.proof).toEqual({
          threadId: result.listener.threadId,
          workspaceId: result.listener.workspaceId,
          backend: "codex_app_server",
        });
        expect(
          result.listener.observed.filter(
            ({ url }) => url === "/api/agent-tool-invocations",
          ),
        ).toEqual([
          {
            method: "POST",
            url: "/api/agent-tool-invocations",
            sourceReference: result.reference,
          },
        ]);
        expect(result.stdout).not.toContain(result.reference);
      } finally {
        await result.listener.close();
      }
    },
    420_000,
  );

  run(
    "discovers and reads through the progressive Sedes gateways",
    async () => {
      const result = await nativeRun(
        "progressive",
        [
          "Use only the `sedes` MCP server tools and no shell command.",
          "Call `sedes_catalog` with {\"action\":\"list\"}, then with {\"action\":\"describe\",\"toolIds\":[\"agent.context\"]}.",
          "Then call `sedes_read` with the described toolId, schemaVersion, and an empty input object.",
          "Return the threadId, workspaceId, and backend from that result as the required JSON proof.",
        ].join("\n"),
      );
      try {
        expect(completedItems(result.events, "command_execution")).toEqual([]);
        const calls = completedItems(result.events, "mcp_tool_call");
        expect(calls.map(({ tool }) => tool)).toEqual([
          "sedes_catalog",
          "sedes_catalog",
          "sedes_read",
        ]);
        expect(calls.every(({ status }) => status === "completed")).toBe(true);
        expect(result.proof).toEqual({
          threadId: result.listener.threadId,
          workspaceId: result.listener.workspaceId,
          backend: "codex_app_server",
        });
      } finally {
        await result.listener.close();
      }
    },
    420_000,
  );
});
