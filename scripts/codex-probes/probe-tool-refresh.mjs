import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import {
  assertPinnedCodexRelease,
  codexBinary as binary,
} from "./pinned-codex-release.mjs";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
const here = path.dirname(fileURLToPath(import.meta.url));
// Offline: the real pinned app-server talks only to a local mock model and MCP fixture.
// No provider credentials or operator app-server are used.
const pinned = assertPinnedCodexRelease();
const version = `codex-cli ${pinned.release}`;
const output = path.resolve(
  process.argv[2] ?? "test-results/codex-tool-refresh.json",
);
await mkdir(path.dirname(output), { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), "sr-"));
const home = path.join(temporary, "home");
const workspace = path.join(temporary, "work");
const socket = path.join(temporary, "server.sock");
await Promise.all([mkdir(home), mkdir(workspace)]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bounded = async (predicate, label, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  }
  throw Error("timeout: " + label);
};
const usage = {
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  input_tokens_details: null,
  output_tokens_details: null,
};
const finalEvents = () => [
  { type: "response.created", response: { id: randomUUID() } },
  {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id: randomUUID(),
      content: [{ type: "output_text", text: "fixture complete" }],
    },
  },
  { type: "response.completed", response: { id: randomUUID(), usage } },
];
const requests = [];
const queue = [];
let responseHandler;
const model = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/responses"))
    return res.writeHead(404).end();
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const encoded = Buffer.concat(chunks);
    requests.push(
      JSON.parse(
        (req.headers["content-encoding"] === "zstd"
          ? zstdDecompressSync(encoded)
          : encoded
        ).toString(),
      ),
    );
    const job = queue.shift() ?? responseHandler?.(requests.at(-1));
    const send = () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });
      for (const event of job?.events ?? finalEvents())
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    };
    if (job?.hold) job.release = send;
    else send();
  });
});
await new Promise((resolve, reject) => {
  model.once("error", reject);
  model.listen(0, "127.0.0.1", resolve);
});
await writeFile(
  path.join(home, "config.toml"),
  `model = "sedes-fixture"\nmodel_provider = "sedes_fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.sedes_fixture]\nname = "Offline refresh probe"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\nunified_exec = false\n`,
  { mode: 0o600 },
);
const env = Object.fromEntries(
  ["LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "USER"].flatMap((k) =>
    process.env[k] ? [[k, process.env[k]]] : [],
  ),
);
Object.assign(env, { HOME: home, CODEX_HOME: home, TMPDIR: temporary });
let stderr = "";
const child = spawn(
  binary,
  ["app-server", "--strict-config", "--listen", `unix://${socket}`],
  { cwd: workspace, env, stdio: ["ignore", "ignore", "pipe"] },
);
child.stderr.on("data", (b) => {
  stderr = (stderr + b).slice(-40000);
});
const exited = new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
  child.once("error", (error) => resolve({ error: error.message }));
});
const clients = [];
class Client {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.calls = [];
    ws.on("message", (b) => {
      const msg = JSON.parse(b.toString());
      if (msg.method && msg.id !== undefined) {
        ws.send(
          JSON.stringify({
            id: msg.id,
            error: {
              code: -32601,
              message: "probe rejects unexpected server request",
            },
          }),
        );
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error
          ? p.reject(
              Object.assign(Error(JSON.stringify(msg.error)), {
                rpcError: msg.error,
              }),
            )
          : p.resolve(msg.result);
      } else this.events.push(msg);
    });
    ws.on("error", () => {});
  }
  request(method, params = {}, timeout = 20000) {
    const id = this.nextId++;
    this.calls.push({ method, threadId: params.threadId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("RPC timeout: " + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  notification(method, threadId, after = 0) {
    return bounded(
      () =>
        this.events
          .slice(after)
          .find((e) => e.method === method && e.params?.threadId === threadId),
      `${method} ${threadId}`,
      25000,
    );
  }
  close() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("probe closing"));
    }
    this.pending.clear();
    this.ws.terminate();
  }
}
async function connect() {
  const ws = new WebSocket(`ws+unix://${socket}:/`, {
    perMessageDeflate: false,
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const c = new Client(ws);
  clients.push(c);
  await c.request("initialize", {
    clientInfo: { name: "sedes_refresh_validation", version: "1" },
    capabilities: { experimentalApi: false },
  });
  ws.send(JSON.stringify({ method: "initialized", params: {} }));
  return c;
}
async function fixture(label, tools = [label]) {
  const dir = path.join(temporary, label);
  await mkdir(dir);
  const policyFile = path.join(dir, "policy.json");
  const log = path.join(dir, "events.jsonl");
  await writeFile(policyFile, JSON.stringify({ tools }));
  return {
    label,
    policyFile,
    log,
    config: {
      "mcp_servers.sedes": {
        command: process.execPath,
        args: [
          path.join(here, "tool-refresh-mcp-fixture.mjs"),
          policyFile,
          log,
        ],
        env: { SEDES_REFRESH_MCP_MARKER: label },
        required: true,
        startup_timeout_sec: 10,
        tool_timeout_sec: 10,
      },
      shell_environment_policy: {
        inherit: "all",
        set: { SEDES_REFRESH_MARKER: label },
      },
    },
  };
}
async function logs(f) {
  return readFile(f.log, "utf8").then(
    (s) => s.trim().split("\n").filter(Boolean).map(JSON.parse),
    (e) => (e.code === "ENOENT" ? [] : Promise.reject(e)),
  );
}
async function start(c, f, config = f.config) {
  return (
    await c.request("thread/start", {
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      config,
    })
  ).thread.id;
}
async function turn(c, id, prompt = "Materialize isolated fixture.") {
  const after = c.events.length;
  const response = await c.request("turn/start", {
    threadId: id,
    input: [{ type: "text", text: prompt, text_elements: [] }],
  });
  const done = await c.notification("turn/completed", id, after);
  assert.equal(done.params.turn.status, "completed", JSON.stringify(done));
  return response;
}
async function catalog(c, id) {
  const response = await c.request("mcpServerStatus/list", { threadId: id });
  return response.data
    .filter((s) => s.name === "sedes")
    .map((s) => ({
      name: s.name,
      tools: Object.keys(s.tools ?? {}),
      runtimeStatus: s.runtimeStatus,
    }));
}
async function identity(c, id, tool) {
  try {
    return {
      ok: true,
      result: (
        await c.request("mcpServer/tool/call", {
          threadId: id,
          server: "sedes",
          tool,
          arguments: {},
        })
      ).structuredContent,
    };
  } catch (e) {
    return { ok: false, error: e.rpcError ?? e.message };
  }
}
async function resume(c, id, config) {
  try {
    const r = await c.request("thread/resume", {
      threadId: id,
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "read-only",
      config,
    });
    return { ok: true, threadId: r.thread.id, status: r.thread.status };
  } catch (e) {
    return { ok: false, error: e.rpcError ?? e.message };
  }
}
async function shell(c, id) {
  const callId = randomUUID();
  const tools = requests.at(-1)?.tools ?? [];
  const names = tools.flatMap((t) =>
    t.type === "namespace"
      ? (t.tools ?? []).map((f) => `${t.name}.${f.name}`)
      : [t.name],
  );
  const name =
    names.find((n) => ["shell", "shell_command", "exec_command"].includes(n)) ??
    "shell";
  const command = 'printf "REFRESH=%s\\n" "$SEDES_REFRESH_MARKER"';
  const args =
    name === "shell"
      ? { command: ["bash", "-c", command], timeout_ms: 10000 }
      : name === "exec_command"
        ? {
            cmd: command,
            login: false,
            yield_time_ms: 10000,
            max_output_tokens: 1000,
          }
        : { command, timeout_ms: 10000 };
  const callEvents = (tool, arguments_, call_id) => [
    { type: "response.created", response: { id: randomUUID() } },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id,
        name: tool,
        arguments: JSON.stringify(arguments_),
      },
    },
    { type: "response.completed", response: { id: randomUUID(), usage } },
  ];
  queue.push({ events: callEvents(name, args, callId) });
  const callIds = new Set([callId]);
  responseHandler = (body) => {
    const output =
      (body.input ?? [])
        .filter(
          (i) => i.type === "function_call_output" && callIds.has(i.call_id),
        )
        .at(-1)?.output ?? "";
    const running = output.match(/Process running with session ID (\d+)/);
    if (!running) return undefined;
    const pollId = randomUUID();
    callIds.add(pollId);
    if (callIds.size > 6) throw Error("shell polling bound exceeded");
    return {
      events: callEvents(
        "write_stdin",
        {
          session_id: Number(running[1]),
          chars: "",
          yield_time_ms: 10000,
          max_output_tokens: 1000,
        },
        pollId,
      ),
    };
  };
  const before = requests.length;
  try {
    await turn(c, id, "Run isolated environment fixture.");
  } finally {
    responseHandler = undefined;
  }
  const outputs = [
    ...new Set(
      requests
        .slice(before)
        .flatMap((r) => r.input ?? [])
        .filter(
          (i) => i.type === "function_call_output" && callIds.has(i.call_id),
        )
        .map((i) => i.output),
    ),
  ];
  return {
    tool: name,
    modelToolNames: toolNames(requests[before]),
    outputs,
    marker: outputs.join("\n").match(/REFRESH=([^\s]*)/)?.[1] ?? null,
  };
}
function toolNames(request) {
  return (request?.tools ?? [])
    .flatMap((t) =>
      t.type === "namespace"
        ? (t.tools ?? []).map((f) => `${t.name}.${f.name}`)
        : [t.name],
    )
    .filter(Boolean);
}
const report = {
  version,
  binary,
  binarySha256: pinned.nativeExecutableSha256,
  createdAt: new Date().toISOString(),
  transport: "isolated shared WebSocket over UDS",
  liveProviderCalls: 0,
  cases: [],
};
try {
  await bounded(async () => {
    if (child.exitCode !== null) throw Error("app-server exited: " + stderr);
    return stat(socket).then(
      () => true,
      () => false,
    );
  }, "UDS listen");
  const c = await connect();
  const sibling = await fixture("sibling");
  const siblingId = await start(c, sibling);
  await turn(c, siblingId);
  const siblingBefore = await identity(c, siblingId, "sibling");
  assert(siblingBefore.ok);
  async function record(name, operation) {
    console.log("START " + name);
    const eventStart = c.events.length;
    try {
      const detail = await operation();
      const siblingAfter = await identity(c, siblingId, "sibling");
      const siblingUnchanged =
        siblingAfter.ok && siblingAfter.result.pid === siblingBefore.result.pid;
      assert(siblingUnchanged, "sibling was disturbed");
      report.cases.push({
        name,
        ...detail,
        siblingUnchanged,
        notifications: c.events
          .slice(eventStart)
          .filter((e) =>
            [
              "thread/closed",
              "thread/started",
              "thread/status/changed",
            ].includes(e.method),
          )
          .map((e) => ({
            method: e.method,
            threadId: e.params?.threadId ?? e.params?.thread?.id,
            status: e.params?.status,
          })),
      });
      console.log("DONE " + name);
    } catch (error) {
      report.cases.push({ name, probeError: error.stack });
      console.log("FAILED " + name + " " + error.message);
    }
    await writeFile(output, JSON.stringify(report, null, 2));
  }
  await record("empty-thread", async () => {
    const a = await fixture("empty_a");
    const b = await fixture("empty_b");
    const id = await start(c, a);
    await c.request("thread/read", { threadId: id, includeTurns: false });
    await c.request("thread/goal/get", { threadId: id });
    let history;
    try {
      history = await c.request("thread/turns/list", {
        threadId: id,
        limit: 1,
        itemsView: "notLoaded",
      });
    } catch (error) {
      return {
        id,
        preflightRejected: true,
        error: error.rpcError ?? error.message,
        retained: await identity(c, id, "empty_a"),
      };
    }
    await c.request("thread/unsubscribe", { threadId: id });
    const reloaded = await resume(c, id, b.config);
    return {
      id,
      history,
      reloaded,
      identity: await identity(c, id, "empty_b"),
    };
  });
  await record("changed-config-single-subscriber", async () => {
    const a = await fixture("single_a");
    const b = await fixture("single_b");
    const id = await start(c, a);
    await turn(c, id);
    const before = await identity(c, id, "single_a");
    const shellBefore = await shell(c, id);
    const unsubscribe = await c.request("thread/unsubscribe", { threadId: id });
    const reloaded = await resume(c, id, b.config);
    return {
      unsubscribe,
      reloaded,
      before,
      after: await identity(c, id, "single_b"),
      oldTool: await identity(c, id, "single_a"),
      catalog: await catalog(c, id),
      shellBefore,
      shellAfter: await shell(c, id),
      oldProcessEvents: await logs(a),
      newProcessEvents: await logs(b),
    };
  });
  await record("unchanged-config-policy-enabled", async () => {
    const f = await fixture("policy", []);
    const id = await start(c, f);
    await turn(c, id);
    const before = await catalog(c, id);
    await c.request("thread/unsubscribe", { threadId: id });
    await writeFile(
      f.policyFile,
      JSON.stringify({ tools: ["policy_enabled"] }),
    );
    const reloaded = await resume(c, id, f.config);
    await turn(c, id);
    return {
      before,
      reloaded,
      modelToolNames: toolNames(requests.at(-1)),
      after: await catalog(c, id),
      identity: await identity(c, id, "policy_enabled"),
      processEvents: await logs(f),
    };
  });
  await record("no-mcp-to-mcp", async () => {
    const f = await fixture("added");
    const id = await start(c, f, {
      shell_environment_policy: {
        inherit: "all",
        set: { SEDES_REFRESH_MARKER: "none" },
      },
    });
    await turn(c, id);
    await c.request("thread/unsubscribe", { threadId: id });
    const reloaded = await resume(c, id, f.config);
    return {
      reloaded,
      after: await identity(c, id, "added"),
      shellAfter: await shell(c, id),
    };
  });
  await record("idle-without-unsubscribe", async () => {
    const a = await fixture("subscribed_a");
    const b = await fixture("subscribed_b");
    const id = await start(c, a);
    await turn(c, id);
    const reloaded = await resume(c, id, b.config);
    return {
      reloaded,
      old: await identity(c, id, "subscribed_a"),
      changed: await identity(c, id, "subscribed_b"),
      shellAfter: await shell(c, id),
      newProcessEvents: await logs(b),
    };
  });
  await record("second-subscriber-retained", async () => {
    const a = await fixture("multi_a");
    const b = await fixture("multi_b");
    const d = await fixture("multi_c");
    const id = await start(c, a);
    await turn(c, id);
    const other = await connect();
    await other.request("thread/resume", { threadId: id });
    await c.request("thread/unsubscribe", { threadId: id });
    const whileOtherSubscribed = await resume(c, id, b.config);
    const afterFirst = {
      b: await identity(c, id, "multi_b"),
      a: await identity(c, id, "multi_a"),
      shell: await shell(c, id),
    };
    await other.request("thread/unsubscribe", { threadId: id });
    await c.request("thread/unsubscribe", { threadId: id });
    const afterAllUnsubscribed = await resume(c, id, d.config);
    return {
      whileOtherSubscribed,
      afterFirst,
      afterAllUnsubscribed,
      final: await identity(c, id, "multi_c"),
      finalShell: await shell(c, id),
      processEvents: { a: await logs(a), b: await logs(b), c: await logs(d) },
    };
  });
  await record("native-cli-native", async () => {
    const f = await fixture("switch_native");
    const nativeConfig = {
      ...f.config,
      shell_environment_policy: {
        inherit: "all",
        exclude: ["SEDES_REFRESH_MARKER"],
      },
    };
    const id = await start(c, f, nativeConfig);
    await turn(c, id);
    await c.request("thread/unsubscribe", { threadId: id });
    const toCli = await resume(c, id, {
      shell_environment_policy: {
        inherit: "all",
        set: { SEDES_REFRESH_MARKER: "cli" },
      },
    });
    const cli = { catalog: await catalog(c, id), shell: await shell(c, id) };
    await c.request("thread/unsubscribe", { threadId: id });
    const toNative = await resume(c, id, nativeConfig);
    return {
      toCli,
      cli,
      toNative,
      native: {
        identity: await identity(c, id, "switch_native"),
        shell: await shell(c, id),
      },
    };
  });
  await record("active-turn-reload", async () => {
    const a = await fixture("active_a");
    const b = await fixture("active_b");
    const id = await start(c, a);
    await turn(c, id);
    const job = { hold: true };
    queue.push(job);
    const after = c.events.length;
    await c.request("turn/start", {
      threadId: id,
      input: [
        { type: "text", text: "Held offline response.", text_elements: [] },
      ],
    });
    await bounded(() => job.release, "held model request");
    let reloaded;
    try {
      await c.request("thread/unsubscribe", { threadId: id });
      reloaded = await resume(c, id, b.config);
    } finally {
      job.release();
    }
    await c.notification("turn/completed", id, after);
    return {
      reloaded,
      old: await identity(c, id, "active_a"),
      changed: await identity(c, id, "active_b"),
      shellAfter: await shell(c, id),
    };
  });
  report.mockRequests = requests.length;
  report.modelToolNames = toolNames(requests.at(-1));
  const byName = Object.fromEntries(report.cases.map((c) => [c.name, c]));
  const single = byName["changed-config-single-subscriber"];
  const policy = byName["unchanged-config-policy-enabled"];
  const multiple = byName["second-subscriber-retained"];
  const switching = byName["native-cli-native"];
  const active = byName["active-turn-reload"];
  report.assertions = {
    emptyThreadPreserved: byName["empty-thread"].preflightRejected
      ? byName["empty-thread"].retained?.ok
      : byName["empty-thread"].reloaded?.threadId ===
          byName["empty-thread"].id && byName["empty-thread"].identity?.ok,
    noProbeErrors: report.cases.every((c) => !c.probeError),
    siblingUnchanged: report.cases.every((c) => c.siblingUnchanged),
    singleReloaded:
      single.after?.result?.marker === "single_b" &&
      single.after.result.pid !== single.before?.result?.pid &&
      single.shellBefore?.marker === "single_a" &&
      single.shellAfter?.marker === "single_b" &&
      single.shellAfter.modelToolNames.includes("mcp__sedes.single_b"),
    unchangedLaunchEnabledTools:
      policy.identity?.ok &&
      policy.modelToolNames?.includes("mcp__sedes.policy_enabled"),
    addedMcpAndEnvironment:
      byName["no-mcp-to-mcp"].after?.ok &&
      byName["no-mcp-to-mcp"].shellAfter?.marker === "added",
    ownSubscriberPreservedOld:
      byName["idle-without-unsubscribe"].old?.result?.marker ===
        "subscribed_a" &&
      !byName["idle-without-unsubscribe"].changed?.ok &&
      byName["idle-without-unsubscribe"].shellAfter?.marker === "subscribed_a",
    otherSubscriberPreservedOld:
      multiple.afterFirst?.a?.result?.marker === "multi_a" &&
      !multiple.afterFirst?.b?.ok &&
      multiple.afterFirst?.shell?.marker === "multi_a",
    allUnsubscribedReloaded:
      multiple.final?.result?.marker === "multi_c" &&
      multiple.finalShell?.marker === "multi_c",
    presentationSwitchesApplied:
      switching.cli?.catalog?.length === 0 &&
      switching.cli?.shell?.marker === "cli" &&
      switching.native?.identity?.ok &&
      switching.native?.shell?.marker === "",
    activePreservedOld:
      active.old?.result?.marker === "active_a" &&
      !active.changed?.ok &&
      active.shellAfter?.marker === "active_a",
  };
  if (!Object.values(report.assertions).every(Boolean)) process.exitCode = 1;
} catch (error) {
  report.fatalError = error.stack;
  process.exitCode = 1;
} finally {
  for (const c of clients) c.close();
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  report.appServerStderr = stderr;
  report.cleanedUp = true;
  await rm(temporary, { recursive: true, force: true });
  await writeFile(output, JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    version,
    output,
    cases: report.cases.length,
    errors: report.cases.filter((c) => c.probeError).length,
    fatalError: report.fatalError,
  }),
);
