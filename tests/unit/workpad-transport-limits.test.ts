import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  agentToolCliRequestSchema, agentToolInvocationResultSchema, createAgentToolInvocationRequestSchema,
  AgentToolCliFrameDecoder, encodeAgentToolCliFrame, isBoundedAgentToolJson,
} from "../../src/internal/agent-tool-cli-protocol/index.js";
import { agentToolsInvokeOperation } from "../../src/internal/sidecar-protocol/agent-tools-v5.js";
import { openCodeToolInvokeOperation } from "../../src/server/backends/opencode/opencode-tool-relay-wire.js";
import { opencodeMcpRequest } from "../../src/internal/opencode-mcp/contracts.js";
import { sedesMcpInvocationResult } from "../../src/internal/agent-tool-mcp/mcp-tool-projection.js";
import { agentToolInvocationBodyParser } from "../../src/server/agent-tools/http/agent-tool-router.js";
import { errorMiddleware } from "../../src/server/http/errors.js";
import { generatedAgentToolArtifacts } from "../../src/server/agent-tools/schema/check-agent-tool-artifacts.js";
import { compileCanonicalAgentToolSchema } from "../../src/server/agent-tools/schema/canonical-json-schema.js";
import { WORKPAD_CONTENT_MAX_CHARACTERS } from "../../src/shared/protocol/workpads.js";

const maximum = WORKPAD_CONTENT_MAX_CHARACTERS;
const stamp = "2026-10-13T00:00:00.000Z";
const id = "10000000-0000-4000-8000-000000000001";
const sourceCapability = "a".repeat(48);
const author = { kind: "user", threadId: null, clientId: null, name: "You", nameSnapshot: "You" };
const document = (content: string) => ({ id, title: "Notes", scope: { kind: "global" }, revision: 0,
  archivedAt: null, createdAt: stamp, updatedAt: stamp, author, content });
const invocation = (input: unknown, toolId = "workpad.create") => ({ toolId, schemaVersion: 2, requestId: id, input });
const completed = (output: unknown) => ({ invocationId: id, state: "completed" as const, output });

describe("Workpad transport bounds", () => {
  it.each(["x", "文", "\u0000"])("round-trips the full 256K body through each shared carrier (%j)", character => {
    const content = character.repeat(maximum);
    const call = invocation({ title: "Notes", scope: { kind: "global" }, content });
    expect(createAgentToolInvocationRequestSchema.safeParse(call).success).toBe(true);
    expect(agentToolsInvokeOperation.requestSchema.safeParse({ ...call, sourceCapability }).success).toBe(true);
    expect(opencodeMcpRequest.safeParse({ operation: "invoke", sessionID: "ses_test", request: call }).success).toBe(true);
    const frame = { protocolVersion: 5, requestId: id, sourceCapability, operation: { type: "invoke", request: call } };
    expect(agentToolCliRequestSchema.safeParse(frame).success).toBe(true);
    expect(new AgentToolCliFrameDecoder().push(encodeAgentToolCliFrame(frame))).toEqual(frame);
    const result = completed({ workpad: document(content) });
    expect(agentToolInvocationResultSchema.safeParse(result).success).toBe(true);
    expect(agentToolsInvokeOperation.responseSchema.safeParse({ outcome: "ok", result }).success).toBe(true);
    expect(openCodeToolInvokeOperation.responseSchema.safeParse({ outcome: "ok", result }).success).toBe(true);
    expect(new AgentToolCliFrameDecoder().push(encodeAgentToolCliFrame(result))).toEqual(result);
    expect(Buffer.byteLength(JSON.stringify(sedesMcpInvocationResult(result, "2025-11-25")))).toBeLessThan(4 * 1024 * 1024);
    const { id: workpadId, updatedAt: _updatedAt, ...revision } = document(content);
    expect(agentToolInvocationResultSchema.safeParse(completed({ workpad: { ...revision, workpadId } })).success).toBe(true);
  });

  it.each([
    { kind: "replace", content: "x".repeat(maximum) },
    { kind: "append", text: "x".repeat(maximum) },
    { kind: "patch", edits: [{ oldText: "x".repeat(maximum), newText: "y".repeat(maximum) }] },
  ])("admits only the declared Workpad edit passages", edit => {
    expect(createAgentToolInvocationRequestSchema.safeParse(invocation({ workpadId: id, expectedRevision: 0, edit }, "workpad.update")).success).toBe(true);
    expect(createAgentToolInvocationRequestSchema.safeParse(invocation({ edit }, "task.update")).success).toBe(false);
  });

  it.each(["x".repeat(maximum + 1), "🙂".repeat(maximum / 2 + 1), `${"x".repeat(65_536)}\uD800`])("rejects over-limit or malformed content before dispatch", content => {
    const result = createAgentToolInvocationRequestSchema.safeParse(invocation({ title: "Notes", scope: { kind: "global" }, content }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/^Workpad content /u);
    expect(agentToolInvocationResultSchema.safeParse(completed({ workpad: document(content) })).success).toBe(false);
  });

  it("retains generic string limits and rejects Workpad-shaped unknown fields or invalid metadata", () => {
    const content = "x".repeat(maximum);
    expect(isBoundedAgentToolJson({ workpad: document(content) })).toBe(false);
    for (const output of [
      { text: content }, { content }, { workpad: { content } },
      { workpad: document(content), extra: true },
      { workpad: { ...document(content), extra: true } },
      { workpad: { ...document(content), title: "x".repeat(241) } },
      { workpad: { ...document(content), author: { ...author, name: "x".repeat(65_537) } } },
    ]) expect(agentToolInvocationResultSchema.safeParse(completed(output)).success).toBe(false);
    expect(createAgentToolInvocationRequestSchema.safeParse(invocation({ title: "Notes", scope: { kind: "global" }, extra: content })).success).toBe(false);
    expect(createAgentToolInvocationRequestSchema.safeParse(invocation({ content }, "task.create")).success).toBe(false);
    expect(agentToolInvocationResultSchema.safeParse({ invocationId: id, state: "failed", error: {
      code: "invalid_input", message: "Failed", retryable: false, details: { workpad: document(content) },
    } }).success).toBe(false);
    const getter = vi.fn(() => content);
    expect(agentToolInvocationResultSchema.safeParse(completed({ workpad: Object.defineProperty({}, "content", { get: getter, enumerable: true }) })).success).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it("the larger result envelope cannot be produced by any unrelated canonical tool", () => {
    const output = { workpad: document("x".repeat(maximum)) };
    for (const [contract, serialized] of Object.entries(generatedAgentToolArtifacts())) {
      const artifact = JSON.parse(serialized);
      const accepted = compileCanonicalAgentToolSchema(artifact.outputSchema).check(output);
      expect(accepted, contract).toBe(["workpad.create", "workpad.get", "workpad.update"].includes(artifact.id));
    }
  });

  it("admits larger HTTP Workpad writes while preserving unrelated ingress and total byte bounds", async () => {
    const app = express();
    app.use("/api/agent-tool-invocations", agentToolInvocationBodyParser());
    app.use(express.json({ limit: "256kb" }));
    app.post("/api/agent-tool-invocations", (req, res) => res.json({ accepted: createAgentToolInvocationRequestSchema.safeParse(req.body).success }));
    app.use(errorMiddleware);
    const input = { title: "Notes", scope: { kind: "global" }, content: "文".repeat(maximum) };
    await request(app).post("/api/agent-tool-invocations").send(invocation(input)).expect(200, { accepted: true });
    await request(app).post("/api/agent-tool-invocations").send(invocation(input, "task.create")).expect(413);
    await request(app).post("/api/agent-tool-invocations").send(invocation({ ...input, content: "x".repeat(2 * 1024 * 1024 + 4096) })).expect(413);
  });
});
