import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { maximumPreviewPng, maximumPreviewResult } from "../helpers/page-preview-media-fixture.js";
import { agentToolInvocationResultSchema, AgentToolCliFrameDecoder, encodeAgentToolCliFrame } from "../../src/internal/agent-tool-cli-protocol/index.js";
import { agentToolsInvokeOperation } from "../../src/internal/sidecar-protocol/index.js";
import { openCodeToolInvokeOperation } from "../../src/server/backends/opencode/opencode-tool-relay-wire.js";
import { sedesMcpInvocationResult } from "../../src/internal/agent-tool-mcp/mcp-tool-projection.js";
import { decodeCodexC2Notification } from "../../src/server/backends/codex/codex-c2-protocol.js";
import { codexRuntimeEventSchema } from "../../src/server/backends/codex/runtime/codex-runtime-wire.js";
import { claudeRuntimeQueryMessageEventSchema } from "../../src/server/backends/claude/worker/claude-runtime-v4.js";
import { claudePersistentEventSchema } from "../../src/server/backends/claude/runtime/claude-persistent-runtime-wire.js";
import { SedesToolHttpClient } from "../../src/cli/sedes-tool-api-client.js";

describe("maximum page preview media boundaries", () => {
  it("preserves maximum PNG and worst escaped console through local, sidecar, OpenCode and provider event contracts", () => {
    const result = maximumPreviewResult();
    const serialized = JSON.stringify(result);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(3_900_000);
    agentToolInvocationResultSchema.parse(result);
    const decoder = new AgentToolCliFrameDecoder(), frame = encodeAgentToolCliFrame(result);
    let decoded;
    for (let offset = 0; offset < frame.length; offset += 32_771) decoded = decoder.push(frame.subarray(offset, offset + 32_771)) ?? decoded;
    decoder.finish(); expect(decoded).toEqual(result);
    expect(agentToolsInvokeOperation.responseSchema.parse({ outcome: "ok", result })).toEqual({ outcome: "ok", result });
    expect(openCodeToolInvokeOperation.responseSchema.parse({ outcome: "ok", result })).toEqual({ outcome: "ok", result });
    const mcp = sedesMcpInvocationResult(result, "2025-06-18");
    // MCP repeats structured metadata as model text. This exceeds the canonical
    // invocation budget, and must still fit the separate provider frame limits.
    expect(Buffer.byteLength(JSON.stringify(mcp))).toBeGreaterThan(4 * 1024 * 1024);
    const params = { threadId: "thread-a", turnId: "turn-a", completedAtMs: 1, item: {
      type: "mcpToolCall", id: "preview", server: "sedes", tool: "sedes_page_preview", status: "completed",
      arguments: { html: "<p>preview</p>" }, appContext: null, mcpAppResourceUri: null, mcpAppUi: null, pluginId: null,
      readOnlyHint: true, result: { content: mcp.content, structuredContent: mcp.structuredContent, _meta: null }, error: null, durationMs: 1,
    } };
    decodeCodexC2Notification("item/completed", params);
    expect(codexRuntimeEventSchema.parse({ type: "notification", notification: { kind: "decoded_notification", generation: 1, sequence: 1, method: "item/completed", params } })).toMatchObject({ type: "notification" });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const message = { type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "preview", content: [
      { type: "text", text: JSON.stringify(result.output) },
      { type: "image", source: { type: "base64", media_type: "image/png", data: result.modelContent[0]!.data } },
    ] }] } };
    expect(claudeRuntimeQueryMessageEventSchema.parse({ queryId: sessionId, message })).toEqual({ queryId: sessionId, message });
    expect(claudePersistentEventSchema.parse({ sessionId, sequence: 1, payload: { kind: "message", message } })).toMatchObject({ payload: { message } });
    const over = { ...result, modelContent: [{ ...result.modelContent[0]!, data: maximumPreviewPng(1).toString("base64") }] };
    expect(agentToolInvocationResultSchema.safeParse(over).success).toBe(false);
    expect(agentToolsInvokeOperation.responseSchema.safeParse({ outcome: "ok", result: over }).success).toBe(false);
    expect(openCodeToolInvokeOperation.responseSchema.safeParse({ outcome: "ok", result: over }).success).toBe(false);
  });

  it("reads the maximum completed result through the real HTTP client and rejects one byte over the image cap", async () => {
    let result = maximumPreviewResult();
    const server = createServer((request, response) => {
      request.resume(); response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.url === "/api/agent-tool-csrf" ? { csrfToken: "csrf" } : result));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("address missing");
      const client = new SedesToolHttpClient(new URL(`http://127.0.0.1:${address.port}`), { kind: "thread_source", value: "c".repeat(48) });
      const request = { toolId: "page.preview", schemaVersion: 1, requestId: "max-preview", input: { html: "<p>preview</p>" } };
      expect(await client.invoke(request)).toEqual(result);
      result = { ...result, modelContent: [{ ...result.modelContent[0]!, data: maximumPreviewPng(1).toString("base64") }] };
      await expect(client.invoke(request)).rejects.toMatchObject({ code: "invalid_response" });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
