// Synthetic MCP peer for the opt-in native conformance suite. The control URL
// and bootstrap canary are disposable test values, never real credentials.
import { createInterface } from "node:readline";

const control = process.env.SEDES_MCP_FIXTURE_CONTROL;
if (!control) throw new Error("fixture control endpoint missing");
const canary = process.env.SEDES_MCP_FIXTURE_BOOTSTRAP;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const post = async (route, body) => {
  const response = await fetch(`${control}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`fixture controller rejected ${route}`);
  return response;
};

await post("/started", { pid: process.pid });
const redeemed = await post("/bootstrap", { canary });
const { channelCredential } = await redeemed.json();
delete process.env.SEDES_MCP_FIXTURE_BOOTSTRAP;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!request.method || request.id === undefined) continue;
  let result;
  if (request.method === "initialize") {
    result = {
      protocolVersion: "2025-11-25",
      serverInfo: { name: "sedes-m0-local-fixture", version: "1" },
      capabilities: { tools: {} },
    };
  } else if (request.method === "tools/list") {
    // The test releases this response explicitly. No timing sleep is used to
    // claim that the native effective catalog has become ready.
    await post("/catalog", { pid: process.pid });
    result = { tools: [{ name: "echo", description: "Synthetic conformance echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
  } else if (request.method === "tools/call") {
    await post("/call", { metadata: request.params?._meta ?? {}, name: request.params?.name });
    result = { content: [{ type: "text", text: "synthetic MCP result" }] };
  } else if (request.method === "ping") {
    result = {};
  } else {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Synthetic fixture method not implemented" } });
    continue;
  }
  send({ jsonrpc: "2.0", id: request.id, result });
}
// Do not print the bootstrap value. Its presence is examined by the native
// shell in the qualification test, before this fixture can redeem it.
void canary;
void channelCredential;
