import http from "node:http";
import { zstdDecompressSync } from "node:zlib";

export async function startMockResponsesServer() {
  let requestCount = 0;
  const requestBodies = [];
  const responseQueue = [];
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => {
      requestCount += 1;
      const encodedBody = Buffer.concat(chunks);
      const body =
        request.headers["content-encoding"] === "zstd"
          ? zstdDecompressSync(encodedBody)
          : encodedBody;
      requestBodies.push(body.toString("utf8"));
      const responseId = `fixture-response-${requestCount}`;
      const events = responseQueue.shift() ?? [
        {
          type: "response.created",
          response: { id: responseId },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: `fixture-message-${requestCount}`,
            content: [{ type: "output_text", text: "fixture complete" }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: responseId,
            usage: {
              input_tokens: 0,
              input_tokens_details: null,
              output_tokens: 0,
              output_tokens_details: null,
              total_tokens: 0,
            },
          },
        },
      ];
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });
      for (const event of events) {
        response.write(`event: ${event.type}\n`);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock_responses_server_address_unavailable");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requestCount() {
      return requestCount;
    },
    requestBodies,
    enqueue(events) {
      responseQueue.push(events);
    },
    close: async () => {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
