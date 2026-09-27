import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/** Local deterministic inference only. This fixture never contacts a provider. */
export async function startOpencodeModelFixture() {
  let requestCount = 0;
  let streamRequestCount = 0;
  const requests: Array<{
    model: string;
    stream: boolean;
    lastRole?: string;
    lastText?: string;
  }> = [];
  let nextHold: StreamHold | undefined;
  const holds = new Set<StreamHold>();
  const handlers = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const handling = handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    handlers.add(handling);
    void handling.finally(() => handlers.delete(handling));
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(value);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      typeof input !== "object" ||
      input === null ||
      !("model" in input) ||
      typeof input.model !== "string" ||
      !("stream" in input) ||
      typeof input.stream !== "boolean"
    ) {
      response.writeHead(400).end();
      return;
    }
    requestCount += 1;
    if (requestCount > 100) {
      response.writeHead(429).end();
      return;
    }
    const messages =
      "messages" in input && Array.isArray(input.messages)
        ? input.messages
        : [];
    const last: unknown = messages.at(-1);
    const lastRole =
      typeof last === "object" &&
      last !== null &&
      "role" in last &&
      typeof last.role === "string"
        ? last.role
        : undefined;
    const lastText =
      typeof last === "object" &&
      last !== null &&
      "content" in last &&
      typeof last.content === "string"
        ? last.content
        : undefined;
    requests.push({
      model: input.model,
      stream: input.stream,
      lastRole,
      lastText: lastText?.slice(0, 1024),
    });
    const id = `chatcmpl-fixture-${requestCount}`;
    const usage = { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 };
    if (!input.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: 1,
          model: input.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Fixture response" },
              finish_reason: "stop",
            },
          ],
          usage,
        }),
      );
      return;
    }
    streamRequestCount += 1;
    // Native title generation may use a streamed request too. Hold only the
    // explicitly selected user prompt, never whichever request happens first.
    const hold =
      nextHold?.promptMarker === lastText && lastRole === "user"
        ? nextHold
        : undefined;
    if (hold) nextHold = undefined;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (
      delta: Record<string, string>,
      finishReason: "stop" | null,
    ) => {
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(finishReason ? { usage } : {}),
        })}\n\n`,
      );
    };
    send(
      { role: "assistant", content: hold ? "PREFIX" : "Fixture response" },
      null,
    );
    if (hold) {
      response.once("close", hold.release);
      hold.markStarted();
      await hold.released;
      response.off("close", hold.release);
      holds.delete(hold);
      if (response.destroyed) return;
      send({ content: "SUFFIX" }, null);
    }
    send({}, "stop");
    response.end("data: [DONE]\n\n");
  }

  const model = {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 100_000, output: 10_000 },
    cost: { input: 0, output: 0 },
  };
  return {
    config: {
      update: "disable",
      model: "probe/probe-model",
      providers: {
        probe: {
          name: "Deterministic loopback fixture",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: {
            apiKey: "fixture-only",
            baseURL: `http://127.0.0.1:${port}/v1`,
          },
          models: { "probe-model": model, "second-model": model },
        },
      },
    },
    get requestCount() {
      return requestCount;
    },
    get streamRequestCount() {
      return streamRequestCount;
    },
    get requests() {
      return requests.slice();
    },
    holdNextStream(promptMarker: string) {
      if (nextHold)
        throw new Error("A fixture stream hold is already pending.");
      if (!promptMarker || promptMarker.length > 1024)
        throw new Error("Invalid fixture hold marker.");
      const hold = createStreamHold(promptMarker);
      nextHold = hold;
      holds.add(hold);
      return { started: hold.started, release: hold.release };
    },
    async stop() {
      for (const hold of holds) hold.release();
      nextHold = undefined;
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
      await Promise.all(handlers);
    },
  };
}

interface StreamHold {
  readonly promptMarker: string;
  readonly started: Promise<void>;
  readonly released: Promise<void>;
  readonly markStarted: () => void;
  readonly release: () => void;
}

function createStreamHold(promptMarker: string): StreamHold {
  let markStarted!: () => void;
  let release!: () => void;
  let rejectStarted!: (error: Error) => void;
  let began = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = new Promise<void>((resolve, reject) => {
    rejectStarted = reject;
    markStarted = () => { began = true; clearTimeout(timer); resolve(); };
  });
  // The test may still be awaiting native prompt admission when this expires.
  // Own the rejection immediately; its later await still receives the failure.
  void started.catch(() => {});
  const released = new Promise<void>((resolve) => {
    release = () => {
      clearTimeout(timer);
      if (!began) rejectStarted(new Error("Model fixture hold released before startup"));
      resolve();
    };
  });
  timer = setTimeout(() => {
    rejectStarted(new Error("Model fixture request did not start within 20 seconds"));
    release();
  }, 20_000);
  return {
    promptMarker,
    started,
    released,
    markStarted,
    release,
  };
}
