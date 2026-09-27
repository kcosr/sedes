import { createServer, type ServerResponse } from "node:http";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture, type OpenCodeNativeFixture } from "../support/opencode-native-fixture";

// This suite characterizes accepted native limitations, not Sedes support.
// Its older bootstrap canary demonstrates the same-account environment exposure
// also accepted for the planned direct channel credential; no bootstrap is required.
// It runs no authenticated/live model provider. All model and MCP responses are
// local fixtures and each native process receives a disposable private HOME.
const enabled = RUN_REAL_OPENCODE;
const fixture = fileURLToPath(new URL("../fixtures/opencode/mcp-qualification-server.mjs", import.meta.url));
type RecordValue = Record<string, unknown>;
type NativeResponse = { status: number; body: unknown };

function data<T>(response: NativeResponse): T {
  expect(response.status).toBeLessThan(300);
  return (response.body as { data: T }).data;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, message: string, timeout = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function startFixture(initialMcp: boolean, profile: RecordValue = {}) {
  const started = deferred<{ pid: number; response: ServerResponse }>();
  let bootstrapRedeemed = false;
  const catalog = deferred<ServerResponse>();
  let nextRequest = deferred<RecordValue>();
  let nextToolCall: { name: string; input: RecordValue } | undefined;
  let native: OpenCodeNativeFixture | undefined;
  const responses = new Set<ServerResponse>();
  let modelRequests = 0;
  const errors: unknown[] = [];
  const canary = `synthetic-bootstrap-${crypto.randomUUID()}`;
  const channelCredential = `synthetic-channel-${crypto.randomUUID()}`;
  const controller = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) throw new Error("synthetic controller request exceeded bound");
        chunks.push(Buffer.from(chunk));
      }
      if (responses.size > 8) throw new Error("too many pending synthetic controller requests");
      response.once("close", () => responses.delete(response));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RecordValue;
      if (request.url === "/started") {
        started.resolve({ pid: body.pid as number, response });
        if (initialMcp) response.writeHead(204).end();
        else responses.add(response);
      } else if (request.url === "/bootstrap") {
        expect(body.canary).toBe(canary);
        if (bootstrapRedeemed) { response.writeHead(403).end(); return; }
        bootstrapRedeemed = true;
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ channelCredential }));
      } else if (request.url === "/catalog") {
        responses.add(response);
        catalog.resolve(response);
      } else if (request.url === "/call") {
        response.writeHead(204).end();
      } else if (request.url === "/v1/chat/completions") {
        expect(request.headers.authorization).toBe("Bearer synthetic-local-model-key");
        if (++modelRequests > 16) throw new Error("too many synthetic model requests");
        if (body.stream === true) {
          nextRequest.resolve(body);
          const frame = (delta: RecordValue, finishReason: string | null = null) => ({ id: "local-fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
          const toolCall = nextToolCall;
          nextToolCall = undefined;
          const frames = toolCall
            ? [frame({ role: "assistant", tool_calls: [{ index: 0, id: "synthetic-removed-tool", type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) } }] }), frame({}, "tool_calls")]
            : [frame({ role: "assistant", content: "Synthetic fixture completed." }), frame({}, "stop")];
          const text = frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
          response.writeHead(200, { "content-type": "text/event-stream" }).end(text);
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "local-title", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "Synthetic title" }, finish_reason: "stop" }] }));
        }
      } else {
        response.writeHead(404).end();
      }
    } catch (error) {
      if (errors.length < 16) errors.push(error);
      response.writeHead(500).end();
    }
  });
  controller.maxConnections = 8;
  controller.requestTimeout = 30_000;
  await new Promise<void>((resolve) => controller.listen(0, "127.0.0.1", resolve));
  const address = controller.address();
  if (!address || typeof address === "string") throw new Error("missing fixture listener");
  const control = `http://127.0.0.1:${address.port}`;
  const mcp = {
    type: "local", command: [process.execPath, fixture], protocol: "legacy", codemode: false,
    environment: { SEDES_MCP_FIXTURE_CONTROL: control, SEDES_MCP_FIXTURE_BOOTSTRAP: canary },
  };
  const nativeConfig = {
    update: "disable", model: "fixture/model",
    providers: { fixture: { package: "aisdk:@ai-sdk/openai-compatible", settings: { apiKey: "synthetic-local-model-key", baseURL: `${control}/v1` }, models: { model: { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 100_000, output: 10_000 } } } } },
    ...(initialMcp ? { mcp: { servers: { qualification: mcp } } } : {}),
    ...profile,
  };
  const close = async () => {
    for (const response of responses) if (!response.writableEnded) response.writeHead(204).end();
    try { await native?.stop(); }
    finally {
      controller.closeAllConnections();
      await new Promise<void>((resolve) => controller.close(() => resolve()));
    }
  };
  try {
    native = await startOpencodeNativeFixture({ config: nativeConfig });
    const { workspace, rootDirectory: root } = native;
    const request = native.api;
    const configFile = path.join(root, "config", "opencode", "opencode.json");
    const location = `?${new URLSearchParams({ "location[directory]": workspace })}`;
    const session = data<{ id: string }>(await request("POST", "/api/session", { title: "M0 MCP qualification", location: { directory: workspace }, model: { providerID: "fixture", id: "model" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] }));
    return {
      root, workspace, location, session, request, close, mcp, canary, channelCredential, configFile, started, catalog, errors,
      bootstrapRedeemed: () => bootstrapRedeemed,
      setNextToolCall: (call: { name: string; input: RecordValue }) => { nextToolCall = call; },
      waitForIdle: async () => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const active = data<RecordValue>(await request("GET", "/api/session/active"));
          if (!(session.id in active)) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("native session did not become idle");
      },
      prompt: async () => {
        nextRequest = deferred<RecordValue>();
        expect((await request("POST", `/api/session/${session.id}/prompt`, { id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, text: "Report the synthetic fixture result." })).status).toBe(200);
        return bounded(nextRequest.promise, "local model request timeout");
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

it.skipIf(!enabled)("characterizes the accepted initial MCP catalog race and persisted config canary exposure", async () => {
  const fixture = await startFixture(true);
  try {
    const firstPrompt = fixture.prompt();
    await bounded(fixture.catalog.promise, "initial MCP catalog request timeout");
    const status = data<Array<{ name: string; status: { status: string } }>>(await fixture.request("GET", `/api/mcp${fixture.location}`));
    expect(status.find((entry) => entry.name === "qualification")?.status.status).toBe("pending");
    const request = await firstPrompt;
    expect(JSON.stringify(request.tools)).not.toContain("qualification_echo");
    expect(JSON.stringify((await fixture.request("GET", `/api/config${fixture.location}`)).body)).toContain(fixture.canary);
    expect(await readFile(fixture.configFile, "utf8")).toContain(fixture.canary);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
}, 90_000);

it.skipIf(!enabled)("characterizes plugin removal and its loss of shell, subagent and command features", async () => {
  const removed = ["opencode.tool.shell", "opencode.tool.subagent", "opencode.config.command"];
  const fixture = await startFixture(false, { plugins: removed.map((id) => `-${id}`) });
  try {
    const attemptedOutput = path.join(fixture.workspace, "forbidden-background-output");
    fixture.setNextToolCall({ name: "shell", input: { command: `touch ${attemptedOutput}`, background: true } });
    const request = await fixture.prompt();
    const tools = request.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).not.toContain("shell");
    expect(tools.map((tool) => tool.function.name)).not.toContain("subagent");
    const plugins = data<Array<{ id: string }>>(await fixture.request("GET", `/api/plugin${fixture.location}`));
    for (const id of removed) expect(plugins.map((plugin) => plugin.id)).not.toContain(id);
    await fixture.waitForIdle();
    await expect(access(attemptedOutput)).rejects.toMatchObject({ code: "ENOENT" });
    expect(data<unknown[]>(await fixture.request("GET", `/api/shell${fixture.location}`))).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
}, 90_000);

it.skipIf(!enabled || process.platform !== "linux")("characterizes accepted same-account MCP environment exposure while runtime config reads remain clean", async () => {
  const fixture = await startFixture(false);
  try {
    const addition = fixture.request("PUT", `/api/experimental/mcp/qualification${fixture.location}`, { config: fixture.mcp });
    const startup = await bounded(fixture.started.promise, "runtime MCP startup timeout");
    expect(JSON.stringify((await fixture.request("GET", `/api/config${fixture.location}`)).body)).not.toContain(fixture.canary);
    expect(JSON.stringify((await fixture.request("GET", `/api/mcp${fixture.location}`)).body)).not.toContain(fixture.canary);
    // The native server starts the shell itself. No controller credential is
    // passed to the shell; /proc still reveals the MCP child's initial env.
    expect(fixture.bootstrapRedeemed()).toBe(false);
    const shell = await fixture.request("POST", `/api/session/${fixture.session.id}/shell`, { command: `cat /proc/${startup.pid}/environ` });
    expect(shell.status).toBe(204);
    const history = await fixture.request("GET", `/api/session/${fixture.session.id}/message?limit=100&order=desc`);
    expect(JSON.stringify(history.body)).toContain(fixture.canary);
    expect(JSON.stringify(history.body)).not.toContain(fixture.channelCredential);
    expect(fixture.bootstrapRedeemed()).toBe(false);
    startup.response.writeHead(204).end();
    const catalog = await bounded(fixture.catalog.promise, "runtime MCP catalog request timeout");
    expect(fixture.bootstrapRedeemed()).toBe(true);
    catalog.writeHead(204).end();
    expect((await addition).status).toBe(204);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
}, 90_000);
