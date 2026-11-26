import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  codexThreadItemsListMethod,
  codexThreadReadMethod,
  codexThreadResumeMethod,
  type CodexThreadItem,
} from "../../src/server/backends/codex/codex-c1-protocol.js";
import {
  codexThreadCompactStartMethod,
  codexThreadStartMethod,
  codexTurnStartMethod,
  decodeCodexC2Notification,
} from "../../src/server/backends/codex/codex-c2-protocol.js";
import type { CodexRpcMethod } from "../../src/server/backends/codex/rpc/codex-rpc-client.js";
import {
  startMockResponsesServer,
  type MockResponseEvent,
} from "./mock-responses-server.mjs";
import { assertPinnedCodexRelease, codexBinary } from "./pinned-codex-release.mjs";
import {
  probeEnvironment,
  RawCodexAppServerClient,
  type RawCodexNotification,
} from "./raw-app-server-client.mjs";

type HistoryMode = "legacy" | "paginated";
type Model = Awaited<ReturnType<typeof startMockResponsesServer>>;
type McpItem = Extract<CodexThreadItem, { type: "mcpToolCall" }>;

const LIST_LIMIT = 30;
const TOOL_MARKERS = Array.from({ length: 14 }, (_, index) => `fixture-mcp-${index + 1}`);
const SUMMARY = "Fixture conversation summary from manual compaction.";
const MCP_FIXTURE = fileURLToPath(new URL("./mcp-history-fixture.mjs", import.meta.url));
const USAGE = { input_tokens: 11, output_tokens: 3, total_tokens: 14 };

class HistoryClient extends RawCodexAppServerClient {
  readonly events: RawCodexNotification[];

  constructor(executable: string, cwd: string, home: string) {
    const events: RawCodexNotification[] = [];
    super({
      codexBinary: executable,
      cwd,
      environment: probeEnvironment(home),
      notificationObserver: event => events.push(event),
    });
    this.events = events;
  }

  override request<Result>(method: string, params: unknown, timeoutMs?: number) {
    return super.request<Result>(
      method,
      method === "initialize"
        ? { ...Object(params), capabilities: { experimentalApi: true } }
        : params,
      timeoutMs,
    );
  }

  async call<Params, Result>(
    codec: CodexRpcMethod<Params, Result>,
    params: Params,
  ): Promise<Result> {
    return codec.decodeResult(await this.request(codec.method, codec.encodeParams(params)));
  }
}

function response(id: string, items: readonly Record<string, unknown>[]): MockResponseEvent[] {
  return [
    { type: "response.created", response: { id } },
    ...items.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    { type: "response.completed", response: { id, usage: USAGE } },
  ];
}

function assistant(id: string, text: string) {
  return { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] };
}

function queueToolTurn(model: Model): number {
  const requestIndex = model.requestCount;
  model.enqueue(response("fixture-tools", TOOL_MARKERS.map((marker, index) => ({
    type: "function_call",
    id: `fixture-tool-${index}`,
    call_id: `fixture-call-${index}`,
    namespace: "mcp__fixture",
    name: "echo",
    arguments: JSON.stringify({ marker }),
  }))));
  model.enqueue(response("fixture-answer", [assistant("fixture-finished", "Fixture tools completed.")]));
  return requestIndex;
}

function assertToolRequests(model: Model, requestIndex: number) {
  assert.equal(model.requestCount, requestIndex + 2);
  const first = JSON.parse(model.requestBodies[requestIndex]!);
  assert(first.tools.some((tool: { name: string; tools?: { name: string }[] }) =>
    tool.name === "mcp__fixture" && tool.tools?.some(entry => entry.name === "echo"),
  ), "The stock runtime must advertise the MCP fixture before it is called.");
  const followup = JSON.parse(model.requestBodies[requestIndex + 1]!) as {
    input: { type: string; call_id?: string; output?: unknown }[];
  };
  const outputs = followup.input.filter(item => item.type === "function_call_output");
  assert.equal(outputs.length, TOOL_MARKERS.length);
  for (const [index, marker] of TOOL_MARKERS.entries()) {
    const output = outputs.find(item => item.call_id === `fixture-call-${index}`)?.output;
    assert(output !== undefined && JSON.stringify(output).includes(marker),
      `MCP output absent from the model request: ${marker}`);
  }
}

function assertMcpItems(items: readonly CodexThreadItem[]): McpItem[] {
  const calls = items.filter((item): item is McpItem => item.type === "mcpToolCall");
  assert.equal(calls.length, TOOL_MARKERS.length);
  assert.equal(new Set(calls.map(item => item.id)).size, TOOL_MARKERS.length);
  const markers = calls.map(item => {
    assert.equal(item.environmentId, null, "A thread-wide MCP registration must carry a nullable scope.");
    assert.equal(item.status, "completed");
    assert.equal(item.server, "fixture");
    assert.equal(item.tool, "echo");
    const args = item.arguments as { marker: string };
    const content = item.result?.content;
    assert.equal(content?.length, 1);
    const block = content?.[0];
    assert(block !== null && typeof block === "object");
    assert.deepEqual({ ...block }, { type: "text", text: args.marker });
    return args.marker;
  });
  assert.deepEqual(markers.sort(), [...TOOL_MARKERS].sort());
  return calls;
}

async function readItems(
  client: HistoryClient,
  mode: HistoryMode,
  threadId: string,
  turnId: string,
): Promise<readonly CodexThreadItem[]> {
  if (mode === "paginated") {
    const result = await client.call(codexThreadItemsListMethod, { threadId, turnId, limit: LIST_LIMIT });
    assert.equal(result.nextCursor, null);
    assert(result.data.every(entry => entry.turnId === turnId));
    return result.data.map(entry => entry.item);
  }
  const result = await client.call(codexThreadReadMethod, { threadId, includeTurns: true });
  const turn = result.thread.turns.find(entry => entry.id === turnId);
  assert(turn, "Legacy history retained the requested turn.");
  return turn.items;
}

function assertCompactionMarker(items: readonly CodexThreadItem[]) {
  assert.equal(items.filter(item => item.type === "contextCompaction").length, 1);
  assert(!JSON.stringify(items).includes(SUMMARY), "Compaction summary is private model context.");
}

function textInput(text: string) {
  return [{ type: "text" as const, text, text_elements: [] }];
}

async function completedTurn(client: HistoryClient, threadId: string, turnId?: string) {
  const event = await client.nextNotification("turn/completed", 30_000);
  const completed = decodeCodexC2Notification("turn/completed", event.params);
  assert.equal(completed.threadId, threadId);
  assert.equal(completed.turn.status, "completed", completed.turn.error?.message ?? "Expected a completed fixture turn.");
  if (turnId !== undefined) assert.equal(completed.turn.id, turnId);
  return completed.turn.id;
}

async function verifyMode(
  mode: HistoryMode,
  model: Model,
  workspace: string,
  open: (executable?: string) => Promise<HistoryClient>,
  previousBinary?: string,
) {
  const client = await open(previousBinary);
  const requestIndex = queueToolTurn(model);
  const start = { cwd: workspace, historyMode: mode, ephemeral: false };
  const prompt = textInput("Run the deterministic MCP echo fixture.");
  let threadId: string;
  let turnId: string;
  if (previousBinary) {
    // The old runtime creates native history. Only the selected production
    // parser reads it, through the new runtime after restarting the server.
    const created = await client.request<{ thread: { id: string } }>("thread/start", start);
    threadId = created.thread.id;
    const accepted = await client.request<{ turn: { id: string } }>("turn/start", { threadId, input: prompt });
    turnId = accepted.turn.id;
    const completed = await client.nextNotification<{ threadId: string; turn: { id: string; status: string } }>(
      "turn/completed", 30_000,
    );
    assert.equal(completed.params.threadId, threadId);
    assert.equal(completed.params.turn.id, turnId);
    assert.equal(completed.params.turn.status, "completed");
  } else {
    const created = await client.call(codexThreadStartMethod, start);
    assert.equal(created.thread.historyMode, mode);
    threadId = created.thread.id;
    const accepted = await client.call(codexTurnStartMethod, { threadId, input: prompt });
    turnId = await completedTurn(client, threadId, accepted.turn.id);

    const starts = [];
    const completions = [];
    for (const event of client.events) {
      if (event.method !== "item/started" && event.method !== "item/completed") continue;
      const decoded = decodeCodexC2Notification(event.method, event.params);
      assert.equal(decoded.threadId, threadId);
      assert.equal(decoded.turnId, turnId);
      if (decoded.item.type !== "mcpToolCall") continue;
      if (event.method === "item/started") starts.push(decoded.item);
      else completions.push(decoded.item);
    }
    assertMcpItems(completions);
    assert.equal(starts.length, TOOL_MARKERS.length);
    for (const item of starts) {
      assert.equal(item.environmentId, null);
      assert.equal(item.status, "inProgress");
    }
    assert.deepEqual(starts.map(item => item.id).sort(), completions.map(item => item.id).sort());
    assertMcpItems(await readItems(client, mode, threadId, turnId));
  }
  assertToolRequests(model, requestIndex);

  let compactTurnId: string | undefined;
  if (!previousBinary) {
    model.enqueue(response("fixture-compaction", [assistant("fixture-summary", SUMMARY)]));
    const firstEvent = client.events.length;
    await client.call(codexThreadCompactStartMethod, { threadId });
    compactTurnId = await completedTurn(client, threadId);
    assert.notEqual(compactTurnId, turnId);
    const markers = client.events.slice(firstEvent).flatMap(event => {
      if (event.method !== "item/started" && event.method !== "item/completed") return [];
      const decoded = decodeCodexC2Notification(event.method, event.params);
      if (decoded.item.type !== "contextCompaction") return [];
      assert.equal(decoded.turnId, compactTurnId);
      return [{ method: event.method, id: decoded.item.id }];
    });
    assert.deepEqual(markers.map(marker => marker.method), ["item/started", "item/completed"]);
    assert.equal(markers[0]?.id, markers[1]?.id);
    assertMcpItems(await readItems(client, mode, threadId, turnId));
    assertCompactionMarker(await readItems(client, mode, threadId, compactTurnId));
  }

  await client.close();
  const reopened = await open();
  const resumed = await reopened.call(codexThreadResumeMethod, {
    threadId,
    ...(mode === "paginated" ? { excludeTurns: true } : {}),
  });
  assert.equal(resumed.thread.id, threadId);
  assert.equal(resumed.thread.historyMode, mode);
  assertMcpItems(await readItems(reopened, mode, threadId, turnId));
  if (mode === "legacy") {
    assertMcpItems(resumed.thread.turns.find(turn => turn.id === turnId)?.items ?? []);
  }
  if (compactTurnId !== undefined) {
    assertCompactionMarker(await readItems(reopened, mode, threadId, compactTurnId));
    const continuedRequest = model.requestCount;
    model.enqueue(response("fixture-continuation", [assistant("fixture-after", "Fixture continued.")]));
    const continued = await reopened.call(codexTurnStartMethod, { threadId, input: textInput("Continue from the checkpoint.") });
    await completedTurn(reopened, threadId, continued.turn.id);
    assert.equal(model.requestCount, continuedRequest + 1);
    assert(model.requestBodies[continuedRequest]?.includes(SUMMARY), "Cold continue consumed the compacted model context.");
  }
  return { historyMode: mode, mcpItems: TOOL_MARKERS.length, compactionVerified: compactTurnId !== undefined };
}

async function runScenario(mode: HistoryMode, previousBinary?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-codex-mcp-history-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const clients: HistoryClient[] = [];
  let model: Model | undefined;
  try {
    await Promise.all([mkdir(home), mkdir(workspace)]);
    model = await startMockResponsesServer();
    await writeFile(path.join(home, "config.toml"), `
model = "sedes-fixture"
model_provider = "sedes_fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.sedes_fixture]
name = "Sedes offline fixture"
base_url = "${model.baseUrl}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
requires_openai_auth = false
[features]
apps = false
plugins = false
[mcp_servers.fixture]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(MCP_FIXTURE)}]
required = true
`, { mode: 0o600 });
    return await verifyMode(mode, model, workspace, async (executable = codexBinary) => {
      const client = new HistoryClient(executable, workspace, home);
      clients.push(client);
      await client.start();
      return client;
    }, previousBinary);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    if (model) await model.close();
    await rm(root, { recursive: true, force: true });
  }
}

const previousBinary = process.argv[2];
assert(process.argv.length <= 3 && (!previousBinary || path.isAbsolute(previousBinary)),
  "Usage: verify:codex-mcp-history -- [/absolute/path/to/codex-0.169.0]");
const pinned = assertPinnedCodexRelease();
const historyModes = ["legacy", "paginated"] as const;
const evidence = {
  ...pinned,
  platform: `${process.platform}/${process.arch}`,
  native: await runScenarios(),
  previousStore: previousBinary ? await verifyPreviousStore(previousBinary) : null,
  liveProviderVerified: false,
};
console.log(JSON.stringify(evidence, null, 2));

async function verifyPreviousStore(executable: string) {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const hash = createHash("sha256").update(await readFile(executable)).digest("hex");
  assert.equal(hash, "b452ca20f838a8855a88a41050ee4a694033fff4ea3ecdad5633e6e0e8d13f2b");
  const version = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  assert.equal(version, "codex-cli 0.169.0");
  return {
    release: "0.169.0",
    nativeExecutableSha256: hash,
    histories: await runScenarios(executable),
  };
}

async function runScenarios(previousBinary?: string) {
  const results = [];
  for (const mode of historyModes) results.push(await runScenario(mode, previousBinary));
  return results;
}
