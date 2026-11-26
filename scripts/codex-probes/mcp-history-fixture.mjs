import readline from "node:readline";

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of lines) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "sedes-history-fixture", version: "1" },
    });
  } else if (method === "tools/list") {
    reply(id, {
      tools: [{
        name: "echo",
        description: "Returns a fixture marker.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: { marker: { type: "string" } },
          required: ["marker"],
          additionalProperties: false,
        },
      }],
    });
  } else if (method === "tools/call") {
    const marker = params.arguments?.marker;
    if (params.name !== "echo" || typeof marker !== "string") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Invalid fixture call." },
      }) + "\n");
      continue;
    }
    reply(id, { content: [{ type: "text", text: marker }] });
  } else {
    reply(id, {});
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
