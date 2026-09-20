import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const [logFilename, catalog] = process.argv.slice(2);
const token = process.env.SEDES_D2A_TOKEN;
if (!logFilename || !catalog || !token) {
  throw new Error("d2a_mcp_fixture_configuration_missing");
}
const tokenFingerprint = createHash("sha256").update(token).digest("hex");
const toolName = `identity_${catalog}`;

record({ event: "started", pid: process.pid, catalog, tokenFingerprint });

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    record({ event: "malformed_request" });
    return;
  }
  if (message.method === "notifications/initialized") {
    record({ event: "initialized" });
    return;
  }
  if (!("id" in message)) return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: `sedes-d2a-${catalog}`,
        version: "1.0.0",
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    record({ event: "catalog_listed", toolName });
    respond(message.id, {
      tools: [
        {
          name: toolName,
          description: `Return the trusted ${catalog} fixture identity.`,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params?.name !== toolName) {
      respondError(message.id, -32602, "tool_not_authorized");
      return;
    }
    const threadId = message.params?._meta?.threadId;
    record({ event: "tool_called", toolName, threadId });
    respond(message.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            catalog,
            tokenFingerprint,
            threadId,
          }),
        },
      ],
      structuredContent: {
        catalog,
        tokenFingerprint,
        threadId,
      },
      isError: false,
    });
    return;
  }
  if (message.method === "resources/list") {
    respond(message.id, { resources: [] });
    return;
  }
  if (message.method === "prompts/list") {
    respond(message.id, { prompts: [] });
    return;
  }
  if (message.method === "ping") {
    respond(message.id, {});
    return;
  }
  respondError(message.id, -32601, "method_not_found");
});

let stopped = false;
function stop(reason) {
  if (stopped) return;
  stopped = true;
  record({ event: "stopped", reason });
}
lines.once("close", () => stop("stdin_closed"));
process.once("SIGTERM", () => {
  stop("sigterm");
  process.exit(0);
});
process.once("SIGINT", () => {
  stop("sigint");
  process.exit(0);
});
process.once("exit", () => stop("process_exit"));

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    })}\n`,
  );
}

function record(event) {
  appendFileSync(logFilename, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
