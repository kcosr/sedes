import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, expect, it } from "vitest";
import model from "../../scripts/codex-probes/speed-fixture-model.json";
import { startMockResponsesServer, type MockResponseEvent } from "../../scripts/codex-probes/mock-responses-server.mjs";
import { RawCodexAppServerClient, probeEnvironment } from "../../scripts/codex-probes/raw-app-server-client.mjs";
import { codexThreadReadMethod, type CodexThread } from "../../src/server/backends/codex/codex-c1-protocol.js";
import { codexThreadStartMethod, codexTurnStartMethod } from "../../src/server/backends/codex/codex-c2-protocol.js";

// An explicitly selected, digest-verified stock 0.166.0 binary, disposable
// native stores, and loopback inference only. No credentials or shell tools.
const candidate = process.env.SEDES_SPEED_NATIVE_EXECUTABLE;
const native = candidate ? it : it.skip;
if (candidate) beforeAll(async () => {
  expect(path.isAbsolute(candidate)).toBe(true);
  const versionHome = await mkdtemp(path.join(tmpdir(), "codex166-version-"));
  try {
    expect(execFileSync(candidate, ["--version"], {
      env: probeEnvironment(versionHome), encoding: "utf8", timeout: 10_000,
    }).trim()).toBe("codex-cli 0.166.0");
  } finally { await rm(versionHome, { recursive: true, force: true }); }
  const metadata = JSON.parse(await readFile(path.resolve(
    "protocol/codex-app-server/0.166.0/runtime-compatibility/0.166.0.json"), "utf8")) as {
      platforms: { nodePlatform: string; nodeArch: string; executableSha256: string }[];
    };
  const platform = metadata.platforms.find(value => value.nodePlatform === process.platform && value.nodeArch === process.arch);
  expect(platform).toBeDefined();
  const sha256 = createHash("sha256").update(await readFile(candidate)).digest("hex");
  expect(sha256).toBe(platform!.executableSha256);
  process.stdout.write(`Offline Codex166 lifecycle qualification: ${JSON.stringify({
    version: "0.166.0", sha256, platform: process.platform, arch: process.arch, authenticatedProvider: false,
  })}\n`);
});

function completedResponse(id: string): MockResponseEvent[] {
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item: { type: "message", role: "assistant", id,
      content: [{ type: "output_text", text: "Offline native qualification complete." }] } },
    { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-codex166-runtime-"));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace");
  const provider = await startMockResponsesServer();
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const catalog = path.join(home, "models.json");
  await writeFile(catalog, JSON.stringify({ models: [model] }));
  const configPath = path.join(home, "config.toml");
  const configure = async (selection: "original" | "replacement") => {
    const providers = ["original", "replacement"].map(name => `[model_providers.${name}]
name = "Offline ${name}"
base_url = "${provider.baseUrl}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
requires_openai_auth = false
supports_websockets = false
`).join("\n");
    await writeFile(configPath, `model = "${model.slug}"
model_catalog_json = ${JSON.stringify(catalog)}
model_provider = "${selection}"
approval_policy = "on-request"
sandbox_mode = "read-only"
${providers}
[features]
apps = false
plugins = false
memories = false
multi_agent = true
`, { mode: 0o600 });
  };
  await configure("original");
  const notifications: { method: string; params: unknown }[] = [];
  const client = new RawCodexAppServerClient({ codexBinary: candidate!, cwd: workspace,
    environment: probeEnvironment(home),
    notificationObserver: notification => notifications.push(notification),
    serverRequestHandler: request => { throw new Error(`offline_unexpected_server_request:${request.method}`); },
  });
  try { await client.start(); } catch (error) {
    await Promise.all([client.close(), provider.close()]);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const read = async (threadId: string): Promise<CodexThread> => codexThreadReadMethod.decodeResult(
    await client.request("thread/read", { threadId, includeTurns: true })).thread;
  const start = async () => codexThreadStartMethod.decodeResult(await client.request("thread/start", {
    cwd: workspace, approvalPolicy: "on-request", sandbox: "read-only",
  })).thread.id;
  const send = async (threadId: string, text: string) => codexTurnStartMethod.decodeResult(await client.request("turn/start", {
    threadId, input: [{ type: "text", text, text_elements: [] }],
  }));
  const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 20_000;
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error(`offline_native_qualification_timeout:${label}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const close = async () => {
    await client.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  };
  return { client, notifications, provider, configure, start, send, read, waitFor, close };
}

native("offline 0.166 restores a real spawned child archived independently of its parent", async () => {
  const f = await fixture();
  try {
    let response = 0;
    f.provider.setResponder(async () => {
      response++;
      if (response !== 1) return completedResponse(`completed-${response}`);
      return [
        { type: "response.created", response: { id: "spawn-response" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "spawn-child",
          name: "spawn_agent", namespace: "multi_agent_v1",
          arguments: JSON.stringify({ message: "OFFLINE_ARCHIVE_CHILD: finish immediately", fork_context: false }) } },
        { type: "response.completed", response: { id: "spawn-response", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
    });
    const parentId = await f.start();
    await f.send(parentId, "Explicitly spawn one child for the offline native archive qualification.");
    await f.waitFor(() => f.notifications.some(notification => notification.method === "turn/completed" &&
      (notification.params as { threadId: string }).threadId === parentId), "parent completion");
    const parent = await f.read(parentId);
    const spawn = parent.turns.flatMap(turn => turn.items).find(item => item.type === "collabAgentToolCall" &&
      item.receiverThreadIds.length > 0);
    expect(spawn, JSON.stringify(parent.turns)).toBeDefined();
    if (spawn?.type !== "collabAgentToolCall") throw new Error("offline_native_child_not_spawned");
    const childId = spawn.receiverThreadIds[0]!;
    // Native child creation does not broadcast thread/started to a client
    // subscribed only to the root. Read the child's provider-owned history.
    await f.waitFor(async () => {
      const child = await f.read(childId);
      return child.status.type === "idle" && child.turns.some(turn => turn.status === "completed");
    }, "child completion");

    await f.client.request("thread/archive", { threadId: childId });
    expect(path.basename(path.dirname((await f.read(childId)).path!))).toBe("archived_sessions");
    await f.client.request("thread/archive", { threadId: parentId });
    expect(path.basename(path.dirname((await f.read(parentId)).path!))).toBe("archived_sessions");
    const beforeRestore = f.notifications.length;
    await f.client.request("thread/unarchive", { threadId: parentId });
    await f.waitFor(() => [parentId, childId].every(threadId => f.notifications.slice(beforeRestore).some(notification =>
      notification.method === "thread/unarchived" && (notification.params as { threadId: string }).threadId === threadId)),
    "cascade restore notifications");
    for (const threadId of [parentId, childId]) {
      const restored = await f.read(threadId);
      expect(restored.id).toBe(threadId);
      expect(path.basename(path.dirname(restored.path!))).not.toBe("archived_sessions");
      expect(restored.turns.length).toBeGreaterThan(0);
      expect(restored.turns.flatMap(turn => turn.items).some(item => item.type === "commandExecution")).toBe(false);
    }
  } finally { await f.close(); }
}, 60_000);

native("offline 0.166 rejects provider-mismatched resume and input while preserving readable history", async () => {
  const f = await fixture();
  try {
    const threadId = await f.start();
    await f.send(threadId, "Complete one original-provider fixture turn.");
    await f.waitFor(() => f.notifications.some(notification => notification.method === "turn/completed" &&
      (notification.params as { threadId: string }).threadId === threadId), "original provider completion");
    const original = await f.read(threadId);
    expect(original.modelProvider).toBe("original");
    const beforeRejected = f.provider.requestCount;
    await f.configure("replacement");
    for (const [method, params] of [
      ["thread/resume", { threadId }],
      ["thread/resume", { threadId, modelProvider: "replacement" }],
      ["thread/resume", { threadId, config: { model_provider: "replacement" } }],
      ["turn/start", { threadId, input: [{ type: "text", text: "Must not infer on replacement.", text_elements: [] }] }],
    ] as const) {
      await expect(f.client.request(method, params)).rejects.toMatchObject({ rpcError: {
        code: -32600, data: { type: "modelProviderMismatch", modelProvider: "original", currentModelProvider: "replacement" },
      } });
    }
    expect(f.provider.requestCount).toBe(beforeRejected);
    const readable = await f.read(threadId);
    expect(readable.modelProvider).toBe("original");
    expect(readable.turns).toEqual(original.turns);
    await f.configure("original");
    const resumed = await f.client.request<{ modelProvider: string }>("thread/resume", { threadId });
    expect(resumed.modelProvider).toBe("original");
    const beforeContinuation = f.notifications.length;
    await f.send(threadId, "Continue after original provider configuration is restored.");
    await f.waitFor(() => f.notifications.slice(beforeContinuation).some(notification => notification.method === "turn/completed" &&
      (notification.params as { threadId: string }).threadId === threadId), "restored provider continuation");
    expect(f.provider.requestCount).toBe(beforeRejected + 1);
  } finally { await f.close(); }
}, 60_000);
