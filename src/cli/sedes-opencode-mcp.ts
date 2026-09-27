import { SEDES_VERSION } from "../shared/version.js";
import { agentToolCatalogResponseSchema, agentToolDescriptionsResponseSchema, agentToolInvocationResultSchema,
  isBoundedAgentToolJson } from "../internal/agent-tool-cli-protocol/contracts.js";
import { OPENCODE_MCP_CREDENTIAL, OPENCODE_MCP_ENDPOINT, OPENCODE_MCP_MAXIMUM_BYTES,
  OPENCODE_MCP_STARTUP_MS, OPENCODE_MCP_WATCHDOG_MS, opencodeMcpCredential, opencodeMcpEndpoint,
  opencodeMcpHello, opencodeMcpSession, type OpenCodeMcpRequest } from "../internal/opencode-mcp/contracts.js";
import { SedesToolApiError, type SedesToolClient } from "./sedes-tool-client.js";
import { runSedesMcpStdio, type SedesMcpDependencies } from "./sedes-mcp.js";

/** Private child command. Only the provider registration supplies its environment. */
export async function runSedesOpenCodeMcp(arguments_: readonly string[], dependencies: SedesMcpDependencies = {}): Promise<number> {
  const owner = new AbortController();
  const signal = AbortSignal.any([owner.signal, ...(dependencies.signal ? [dependencies.signal] : [])]);
  const fetch_ = dependencies.fetch ?? globalThis.fetch;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let ended: Promise<void> | undefined;
  try {
    if (arguments_.length) throw unavailable();
    const env = dependencies.environment ?? process.env;
    const endpoint = opencodeMcpEndpoint(env[OPENCODE_MCP_ENDPOINT]);
    const credential = opencodeMcpCredential.parse(env[OPENCODE_MCP_CREDENTIAL]);
    const startup = setTimeout(() => owner.abort(), OPENCODE_MCP_STARTUP_MS);
    let response: Response;
    try {
      response = await fetch_(`${endpoint}/lifetime`, { headers: { authorization: `Bearer ${credential}` },
        redirect: "error", signal });
      if (response.status !== 200 || !response.body || response.headers.get("content-type") !== "application/x-ndjson") throw unavailable();
      reader = response.body.getReader();
      const lines = readLines(reader);
      const first = await lines.next();
      if (first.done) throw unavailable();
      const hello = opencodeMcpHello.parse(JSON.parse(first.value));
      clearTimeout(startup);
      const heartbeat = () => { clearTimeout(watchdog); watchdog = setTimeout(() => owner.abort(), OPENCODE_MCP_WATCHDOG_MS); };
      heartbeat();
      ended = (async () => {
        try { for await (const line of lines) { if (line !== "{}") throw unavailable(); heartbeat(); } }
        catch { /* Fixed diagnostic below; never expose response or endpoint. */ }
        finally { owner.abort(); }
      })();
      const request = async (body: OpenCodeMcpRequest, caller?: AbortSignal): Promise<unknown> => {
        const response = await fetch_(`${endpoint}/tools`, { method: "POST", redirect: "error",
          headers: { authorization: `Bearer ${credential}`, "x-sedes-stream": hello.streamID, "content-type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.any([signal, ...(caller ? [caller] : [])]) });
        if (response.headers.get("content-type") !== "application/json") { await response.body?.cancel(); throw unavailable(); }
        const value = await boundedJson(response);
        if (response.status !== 200) {
          // The private ingress emits only bounded canonical error fields.
          if (value && typeof value === "object" && "code" in value && "message" in value &&
              typeof value.code === "string" && value.code.length <= 64 && typeof value.message === "string" && value.message.length <= 1_024) {
            throw new SedesToolApiError(value.code, value.message, false);
          }
          throw unavailable();
        }
        return value;
      };
      const listing: SedesToolClient = { listTools: async () => ({ tools: hello.catalog }),
        describeTools: async () => { throw unavailable(); }, invoke: async () => { throw unavailable(); } };
      return await runSedesMcpStdio({ mode: "progressive", includeEmptyGatewayLanes: true, serverVersion: SEDES_VERSION,
        listClient: listing,
        resolveClient: ({ metadata }) => {
          const session = opencodeMcpSession.safeParse(metadata?.["ai.opencode/sessionID"]);
          if (!session.success) throw unmapped();
          const sessionID = session.data;
          return Object.freeze({
            listTools: async (signal?: AbortSignal) => agentToolCatalogResponseSchema.parse(await request({ operation: "list", sessionID }, signal)),
            describeTools: async (toolIds: readonly string[], signal?: AbortSignal) => agentToolDescriptionsResponseSchema.parse(
              await request({ operation: "describe", sessionID, toolIds: [...toolIds] }, signal)),
            invoke: async (input, signal?: AbortSignal) => agentToolInvocationResultSchema.parse(
              await request({ operation: "invoke", sessionID, request: input }, signal)),
          } satisfies SedesToolClient);
        },
      }, { ...dependencies, signal });
    } finally { clearTimeout(startup); }
  } catch {
    (dependencies.stderr ?? process.stderr).write("Sedes OpenCode tools are unavailable.\n");
    return 1;
  } finally {
    owner.abort(); clearTimeout(watchdog);
    await reader?.cancel().catch(() => undefined);
    await ended;
  }
}

function unavailable() { return new SedesToolApiError("unavailable", "Sedes OpenCode tools are unavailable.", false); }
function unmapped() { return new SedesToolApiError("permission_denied", "This OpenCode session is not admitted to Sedes tools.", false); }
async function* readLines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  let buffer = Buffer.alloc(0);
  for (;;) {
    const part = await reader.read();
    if (part.done) { if (buffer.length) throw unavailable(); return; }
    buffer = Buffer.concat([buffer, part.value]);
    if (buffer.length > OPENCODE_MCP_MAXIMUM_BYTES) throw unavailable();
    for (;;) { const index = buffer.indexOf(10); if (index < 0) break;
      const line = buffer.subarray(0, index).toString("utf8"); buffer = buffer.subarray(index + 1); yield line;
    }
  }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break;
    bytes += part.value.byteLength; if (bytes > OPENCODE_MCP_MAXIMUM_BYTES) throw unavailable(); chunks.push(part.value);
  } } finally { await reader.cancel().catch(() => undefined); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isBoundedAgentToolJson(value)) throw unavailable(); return value;
}
