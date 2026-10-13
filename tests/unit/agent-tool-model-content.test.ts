import { describe, expect, it } from "vitest";
import { agentToolCatalogResponseSchema, agentToolInvocationResultSchema, agentToolCliRequestSchema, AgentToolCliFrameDecoder, encodeAgentToolCliFrame } from "../../src/internal/agent-tool-cli-protocol/index.js";
import { agentToolModelContentsSchema, AGENT_TOOL_MODEL_IMAGE_MAXIMUM_BYTES } from "../../src/internal/agent-tool-cli-protocol/model-content.js";
import { opencodeMcpHello } from "../../src/internal/opencode-mcp/contracts.js";

const image = {
  type: "image" as const,
  mimeType: "image/png" as const,
  data: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(70_000)]).toString("base64"),
};

describe("agent-tool model content", () => {
  it("transports image bytes larger than generic JSON strings in a closed media field", () => {
    const result = { invocationId: "preview", state: "completed", output: { width: 390 }, modelContent: [image] };
    expect(image.data.length).toBeGreaterThan(65_536);
    const parsed = agentToolInvocationResultSchema.parse(result);
    const decoder = new AgentToolCliFrameDecoder();
    expect(decoder.push(encodeAgentToolCliFrame(parsed))).toEqual(result);
    expect(agentToolInvocationResultSchema.safeParse({ ...result, output: { data: image.data } }).success).toBe(false);
  });

  it("rejects unknown content, unsupported media, malformed base64, and excess decoded bytes", () => {
    for (const content of [
      [{ ...image, extra: true }],
      [{ ...image, mimeType: "image/svg+xml" }],
      [{ ...image, data: `${image.data}\n` }],
      [{ ...image, data: Buffer.alloc(16).toString("base64") }],
      [{ ...image, data: Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(AGENT_TOOL_MODEL_IMAGE_MAXIMUM_BYTES)]).toString("base64") }],
      [{ type: "text", text: "a".repeat(65_537) }],
    ]) expect(agentToolModelContentsSchema.safeParse(content).success).toBe(false);
  });

  it("bounds the complete response and allows media only on completed results", () => {
    const large = { ...image, data: Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(1_600_000)]).toString("base64") };
    expect(agentToolInvocationResultSchema.safeParse({ invocationId: "too-large", state: "completed", output: {}, modelContent: [large, large] }).success).toBe(false);
    expect(agentToolInvocationResultSchema.safeParse({ invocationId: "cancelled", state: "cancelled", error: { code: "cancelled", message: "Stopped", retryable: false }, modelContent: [image] }).success).toBe(false);
  });

  it("requires v6 local transport and rejects the previous v5 frames", () => {
    const request = { protocolVersion: 6, requestId: "10000000-0000-4000-8000-000000000001", sourceCapability: "a".repeat(48), operation: { type: "list" } };
    expect(agentToolCliRequestSchema.safeParse(request).success).toBe(true);
    expect(agentToolCliRequestSchema.safeParse({ ...request, protocolVersion: 5 }).success).toBe(false);
  });

  it("requires the image-catalog-aware OpenCode bridge handshake", () => {
    const hello = { protocolVersion: 4, streamID: "10000000-0000-4000-8000-000000000001", catalog: [] };
    expect(opencodeMcpHello.safeParse(hello).success).toBe(true);
    expect(opencodeMcpHello.safeParse({ ...hello, protocolVersion: 3 }).success).toBe(false);
    expect(opencodeMcpHello.safeParse({ streamID: hello.streamID, catalog: [] }).success).toBe(false);
  });

  it("carries the closed Images catalog group across both private transports", () => {
    const tool = { id: "image.show", schemaVersion: 1, label: "Show image", description: "Show a retained image in chat.",
      group: { id: "images", order: 10 }, effects: { application: "write", modelUsage: "none", external: "none" } };
    expect(agentToolCatalogResponseSchema.safeParse({ tools: [tool] }).success).toBe(true);
    expect(opencodeMcpHello.safeParse({ protocolVersion: 4, streamID: "10000000-0000-4000-8000-000000000001", catalog: [tool] }).success).toBe(true);
    expect(agentToolCatalogResponseSchema.safeParse({ tools: [{ ...tool, group: { id: "unknown", order: 10 } }] }).success).toBe(false);
  });
});
