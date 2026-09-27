import { readFileSync, appendFileSync } from "node:fs";
import readline from "node:readline";
const [policyFile, logFile] = process.argv.slice(2);
const record = (event) =>
  appendFileSync(
    logFile,
    JSON.stringify({ ...event, pid: process.pid, at: Date.now() }) + "\n",
  );
const policy = () => JSON.parse(readFileSync(policyFile, "utf8"));
record({ event: "started" });
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (!("id" in msg)) return;
  let result;
  if (msg.method === "initialize")
    result = {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "refresh-probe", version: "1" },
    };
  else if (msg.method === "tools/list") {
    const names = policy().tools;
    record({ event: "listed", names });
    result = {
      tools: names.map((name) => ({
        name,
        description: "Return isolated fixture identity",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      })),
    };
  } else if (msg.method === "tools/call") {
    if (!policy().tools.includes(msg.params.name)) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "tool_not_in_current_catalog" },
        }) + "\n",
      );
      return;
    }
    record({ event: "called", name: msg.params.name });
    const value = {
      name: msg.params.name,
      pid: process.pid,
      marker: process.env.SEDES_REFRESH_MCP_MARKER,
      threadId: msg.params._meta?.threadId,
    };
    result = {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    };
  } else if (msg.method === "resources/list") result = { resources: [] };
  else if (msg.method === "prompts/list") result = { prompts: [] };
  else result = {};
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n",
  );
});
let stopped = false;
function stop(reason) {
  if (!stopped) {
    stopped = true;
    record({ event: "stopped", reason });
  }
}
lines.on("close", () => stop("stdin_closed"));
process.on("SIGTERM", () => {
  stop("sigterm");
  process.exit(0);
});
process.on("exit", () => stop("exit"));
