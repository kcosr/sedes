import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { historyPage, locateHistory, nativeBranch, nativeImageKey, projectNativeHistory, projectionWindow, publishNativeHistoryArtifacts } from "../../src/server/backends/pi/native/driver/history.js";
import type { PiNativeHistory } from "../../src/server/backends/pi/native/port.js";
import type { PiManagedOperation } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";
import { parsePiNativeEntry } from "../../src/server/backends/pi/native/rpc/pi-rpc-wire.js";
import { PI_NATIVE_TOOL_MARKER, PI_NATIVE_TOOL_RESULT_MARKER, signPiNativeToolCall, signPiNativeToolResult,
  verifyPiNativeToolCalls, verifyPiNativeToolResults, type PiNativeToolCall, type PiNativeToolResult } from "../../src/server/backends/pi/native/tool-provenance.js";

const time = "2026-10-26T00:00:00.000Z";
const user = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, timestamp: time,
  message: { role: "user", timestamp: Date.parse(time), content: [{ type: "text", text }] } });
const assistant = (id: string, parentId: string, text: string, stopReason = "stop") => ({ type: "message", id, parentId, timestamp: time,
  message: { role: "assistant", timestamp: Date.parse(time), content: [{ type: "text", text }], provider: "local", model: "model", api: "openai-completions", stopReason, usage: {} } });
function history(entries: PiNativeHistory["entries"], leafId = String(entries.at(-1)?.id)): PiNativeHistory {
  return { sessionId: "native-session", sessionFile: "/home/agent/.pi/agent/sessions/native.jsonl", cwd: "/work", entries,
    leafId: entries.length ? leafId : null, operations: [], toolCalls: [], toolResults: [], inheritedEntryIds: [], inheritance: "none" };
}
const authenticationKey = Buffer.alloc(32, 42);
function attested(entries: PiNativeHistory["entries"], leafId = String(entries.at(-1)?.id)): PiNativeHistory {
  const native = entries.map(parsePiNativeEntry);
  return { ...history(entries, leafId), toolCalls: verifyPiNativeToolCalls(native, "native-session", authenticationKey),
    toolResults: verifyPiNativeToolResults(native, "native-session", authenticationKey) };
}
const call = (name: string, id = name, argumentsValue: PiNativeToolCall["arguments"] = {}): PiNativeToolCall => ({
  toolCallId: id, toolName: name, assistantEntryId: "a", userEntryId: "u", sourceInfo: { source: "builtin", path: `builtin:${name}` }, arguments: argumentsValue,
});
const callMarker = (id: string, parentId: string, call: PiNativeToolCall) => ({ type: "custom", id, parentId, timestamp: time,
  customType: PI_NATIVE_TOOL_MARKER, data: { version: 1, call, authentication: signPiNativeToolCall("native-session", call, authenticationKey) } });
const resultMarker = (id: string, parentId: string, result: PiNativeToolResult) => ({ type: "custom", id, parentId, timestamp: time,
  customType: PI_NATIVE_TOOL_RESULT_MARKER, data: { version: 1, result, authentication: signPiNativeToolResult("native-session", result, authenticationKey) } });
const toolAssistant = (calls: readonly PiNativeToolCall[], id = "a", parentId = "u") => ({ ...assistant(id, parentId, "", "toolUse"),
  message: { ...assistant(id, parentId, "", "toolUse").message, content: calls.map(call => ({ type: "toolCall", id: call.toolCallId, name: call.toolName, arguments: call.arguments ?? {} })) } });
const toolResult = (id: string, parentId: string, call: PiNativeToolCall, result: Partial<PiNativeToolResult> = {}) => ({
  type: "message", id, parentId, timestamp: time, message: { role: "toolResult", timestamp: Date.parse(time), toolName: call.toolName,
    toolCallId: call.toolCallId, content: [{ type: "text", text: "done" }], isError: false, ...result },
});
const operation = (userEntryId: string, mode: "submit" | "steer", targetTurnId: string): PiManagedOperation => ({
  input: { operationId: `op-${userEntryId}`, mutationId: `mutation-${userEntryId}`, reconciliationToken: `receipt-${userEntryId}`,
    fingerprint: "a".repeat(64), mode, text: "private native envelope", presentation: { text: `Visible ${userEntryId}`, contextExcerpts: [], taskContexts: [], attachments: [] } },
  phase: "accepted", userEntryId, targetTurnId,
});

describe("native Pi history", () => {
  it("projects only the selected native parent chain, preserving exact content", () => {
    const input = history([user("u1", null, "first"), assistant("a1", "u1", "answer"), user("abandoned", "a1", "old branch"),
      user("u2", "a1", "second"), assistant("a2", "u2", "second answer")]);
    const projected = projectNativeHistory(input);
    expect(projected.snapshot.orderedBackendTurnIds).toEqual(["u1", "u2"]);
    expect(JSON.stringify(projected.snapshot)).not.toContain("old branch");
    expect(projected.snapshot.turnsById.u2?.status).toBe("completed");
    expect(projected.leafByTurn.get("u1")).toBe("a1");
    expect(projected.snapshot.itemsById["a2:text:0"]).toMatchObject({ markdown: { text: "second answer" }, responsePhase: "final" });
  });
  it("rejects duplicate IDs, missing parents and cycles", () => {
    expect(() => nativeBranch(history([user("a", null, "x"), user("a", null, "y")]))).toThrow();
    expect(() => nativeBranch(history([user("a", "missing", "x")]))).toThrow();
    expect(() => nativeBranch(history([user("a", "b", "x"), user("b", "a", "y")]))).toThrow();
  });
  it("groups exact authenticated Steer evidence and hides only authenticated envelopes", () => {
    const input = history([user("u1", null, "private native envelope"), assistant("a1", "u1", "working", "toolUse"),
      user("u2", "a1", "private native envelope"), assistant("a2", "u2", "done")]);
    const projected = projectNativeHistory({ ...input, operations: [operation("u1", "submit", "u1"), operation("u2", "steer", "u1")] });
    expect(projected.snapshot.orderedBackendTurnIds).toEqual(["u1"]);
    expect(projected.snapshot.turnsById.u1?.completionCorrelations).toEqual(["op-u1", "op-u2"]);
    expect(projected.snapshot.itemsById["u2:user"]).toMatchObject({ deliveryOperationId: "op-u2", content: [{ kind: "text", text: { text: "Visible u2" } }] });
    const untrusted = projectNativeHistory({ ...input, operations: [] });
    expect(untrusted.snapshot.orderedBackendTurnIds).toEqual(["u1", "u2"]);
    expect(untrusted.snapshot.itemsById["u2:user"]).not.toHaveProperty("deliveryOperationId");
  });
  it("keeps running and incomplete imported turns distinct from completed turns", () => {
    const input = history([user("u", null, "work")]);
    expect(projectNativeHistory(input).snapshot.turnsById.u?.status).toBe("interrupted");
    const live = projectNativeHistory(input, { running: true });
    expect(live.snapshot.turnsById.u?.status).toBe("in_progress");
    expect(live.snapshot.activeBackendTurnId).toBe("u");
    const failed = projectNativeHistory(history([user("u", null, "work"), assistant("a", "u", "", "error")]));
    expect(failed.snapshot.runState).toBe("failed");
    expect(failed.snapshot.turnsById.u?.status).toBe("failed");
  });
  it("uses immutable snapshot-bound cursors and bounded targeted lookup", () => {
    const input = history([user("u1", null, "one"), assistant("a1", "u1", "first"), user("u2", "a1", "two"), assistant("a2", "u2", "second")]);
    const projection = projectNativeHistory(input);
    const page = historyPage(projection, input.sessionId, { limit: 1 });
    expect(page.orderedBackendTurnIds).toEqual(["u2"]);
    expect(historyPage(projection, input.sessionId, { limit: 1, cursor: page.previousCursor }).orderedBackendTurnIds).toEqual(["u1"]);
    const next = projectNativeHistory(history([...input.entries, user("u3", "a2", "three")]));
    expect(() => historyPage(next, input.sessionId, { limit: 1, cursor: page.previousCursor })).toThrow();
    expect(locateHistory(projection, { maximumTurnCandidates: 1, matchesBackendTurnId: id => id === "u1" }).status).toBe("search_limit_reached");
    expect(locateHistory(projection, { maximumTurnCandidates: 2, matchesBackendTurnId: id => id === "u1" }).status).toBe("found");
    expect(projectionWindow(projection, input.sessionId).history.operational).toBe(true);
  });
  it("keeps a completed fork checkpoint before the next submission intent and settings", () => {
    const nextTime = "2026-10-26T01:00:00.000Z";
    const input = history([user("u1", null, "first"), assistant("a1", "u1", "answer"),
      { type: "model_change", id: "model", parentId: "a1", timestamp: time, provider: "local", modelId: "next" },
      { type: "custom", id: "intent", parentId: "model", timestamp: time, customType: "sedes.native.input.v1",
        data: { version: 1, operation: { ...operation("u2", "submit", "u2"), phase: "intent" } } },
      { ...user("u2", "intent", "next"), timestamp: nextTime }, { ...assistant("a2", "u2", "next answer"), timestamp: nextTime }]);
    const projected = projectNativeHistory(input);
    expect(projected.leafByTurn.get("u1")).toBe("a1");
    expect(projected.snapshot.turnsById.u1?.completedAt).toBe(time);
  });
  it("retains tools and authentic tool result status without inferring builtin authority from names", () => {
    const call = assistant("a", "u", "");
    call.message.content = [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "false" } }] as never;
    call.message.stopReason = "toolUse";
    const input = history([user("u", null, "work"), call, { type: "message", id: "result", parentId: "a", timestamp: time,
      message: { role: "toolResult", timestamp: Date.parse(time), toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "failed" }], isError: true } }, assistant("done", "result", "explained")]);
    const projection = projectNativeHistory(input);
    expect(projection.snapshot.itemsById["a:tool:0"]).toMatchObject({ semanticKind: "tool", status: "failed", phase: "failed", toolName: { text: "bash" } });
    expect(projection.usage.counters).toMatchObject({ toolCalls: 1, toolResults: 1, userMessages: 1, assistantMessages: 2 });
  });

  it("projects authenticated current builtins with patches and bounded rich details", () => {
    const calls = [call("bash", "shell", { command: "printf hello", timeout: 2 }), call("read", "read", { path: "file.ts", offset: 2, limit: 3 }),
      call("write", "write", { path: "new.ts", content: "one\ntwo\n" }), call("edit", "edit", { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] })];
    const entries: Record<string, unknown>[] = [user("u", null, "work"), toolAssistant(calls)];
    for (const item of calls) entries.push(callMarker(`provenance-${item.toolCallId}`, String(entries.at(-1)!.id), item));
    const patch = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
    for (const item of calls) entries.push(toolResult(`result-${item.toolCallId}`, String(entries.at(-1)!.id), item,
      item.toolName === "edit" ? { details: { patch, diff: "display diff must not be used" } } : { content: [{ type: "text", text: "hello" }] }));
    entries.push(assistant("done", String(entries.at(-1)!.id), "done"));
    const projected = projectNativeHistory(attested(entries));
    expect(projected.snapshot.itemsById["a:tool:0"]).toMatchObject({ semanticKind: "command", command: { text: "printf hello" }, output: { text: "hello" }, timeoutMs: 2000, phase: "completed" });
    expect(projected.snapshot.itemsById["a:tool:1"]).toMatchObject({ semanticKind: "file_read", path: { text: "file.ts" }, range: { startLine: 2, endLine: 4 }, contentPreview: { text: "hello" } });
    expect(projected.snapshot.itemsById["a:tool:2"]).toMatchObject({ semanticKind: "file_change", operation: "write", effect: "applied", contentPreview: { text: "one\ntwo\n" }, additions: 2 });
    expect(projected.snapshot.itemsById["a:tool:3"]).toMatchObject({ semanticKind: "file_change", operation: "edit", effect: "applied", diff: { text: { text: patch } }, additions: 1, deletions: 1 });
  });

  it("keeps name overrides generic, rejects forged provenance, and uses attested execution arguments", () => {
    const builtin = call("read", "read", { path: "actual.txt" });
    const override = { ...call("bash"), sourceInfo: { source: "extension", path: "/third-party/override.ts" } };
    const assistantEntry = toolAssistant([builtin, override]);
    assistantEntry.message.content[0]!.arguments = { path: "unvalidated.txt" };
    const fake = callMarker("fake", "a", { ...builtin, sourceInfo: { source: "builtin", path: "builtin:read" } });
    fake.data.authentication = "x".repeat(43);
    const input = attested([user("u", null, "work"), assistantEntry, fake, callMarker("override", "fake", override),
      toolResult("r1", "override", builtin), toolResult("r2", "r1", override)]);
    expect(input.toolCalls).toEqual([override]);
    const generic = projectNativeHistory(input);
    expect(generic.snapshot.itemsById["a:tool:0"]?.semanticKind).toBe("tool");
    expect(generic.snapshot.itemsById["a:tool:1"]?.semanticKind).toBe("tool");
    const trusted = projectNativeHistory(attested([...input.entries, callMarker("real", "r2", builtin)]));
    expect(trusted.snapshot.itemsById["a:tool:0"]).toMatchObject({ semanticKind: "file_read", path: { text: "actual.txt" } });
  });

  it("projects nested codemode calls from exact signed lifecycle records and ignores display-only guesses", () => {
    const root = { ...call("codemode", "code", { code: "await tools.edit(...)" }), managed: "codemode" as const,
      sourceInfo: { source: "extension", path: "/managed/codemode.ts" } };
    const child = { ...call("edit", "code/1", { path: "file.ts", edits: [{ oldText: "a", newText: "b" }] }), parentToolCallId: "code" };
    const result: PiNativeToolResult = { toolCallId: child.toolCallId, assistantEntryId: "a", userEntryId: "u", content: [{ type: "text", text: "edited" }],
      details: { patch: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-a\n+b\n" }, isError: false };
    const entries = [user("u", null, "edit"), toolAssistant([root]), callMarker("root", "a", root), callMarker("child", "root", child),
      resultMarker("child-result", "child", result), toolResult("root-result", "child-result", root,
        { details: { calls: [{ id: "fake/1", name: "write", args: "{truncated", status: "ok" }] } }), assistant("done", "root-result", "done")];
    const projection = projectNativeHistory(attested(entries));
    expect(projection.snapshot.itemsById["a:tool:0"]).toMatchObject({ semanticKind: "tool", toolName: { text: "codemode" } });
    expect(projection.snapshot.itemsById["child:tool"]).toMatchObject({ semanticKind: "file_change", operation: "edit", path: { text: "file.ts" }, phase: "completed" });
    expect(Object.values(projection.snapshot.itemsById).filter(item => item.semanticKind === "file_change")).toHaveLength(1);
    const withoutResult = projectNativeHistory(attested(entries.slice(0, 4)), { running: true });
    expect(withoutResult.snapshot.itemsById["child:tool"]).toMatchObject({ status: "streaming", phase: "preflight_or_executing", effect: "proposed",
      replacement: { before: { text: "a" }, after: { text: "b" } } });
    const abandoned = projectNativeHistory(attested([...entries, { type: "custom", id: "alternative", parentId: "root", timestamp: time, customType: "test", data: {} }], "alternative"));
    expect(abandoned.snapshot.itemsById["child:tool"]).toBeUndefined();
  });

  it("preserves tool identity when attestation arrives after the assistant entry", () => {
    const builtin = call("bash", "shell", { command: "echo ok" });
    const entries = [user("u", null, "work"), toolAssistant([builtin])];
    const before = projectNativeHistory(attested(entries), { running: true });
    expect(before.snapshot.itemsById["a:tool:0"]).toBeUndefined();
    const running = projectNativeHistory(attested([...entries, callMarker("c", "a", builtin)]), { running: true });
    expect(running.snapshot.itemsById["a:tool:0"]).toMatchObject({ semanticKind: "command", status: "streaming", phase: "preflight_or_executing" });
    const completed = projectNativeHistory(attested([...entries, callMarker("c", "a", builtin), toolResult("r", "c", builtin)]));
    expect(completed.snapshot.itemsById["a:tool:0"]?.sourceOrder).toBe(running.snapshot.itemsById["a:tool:0"]?.sourceOrder);
    expect(completed.snapshot.itemsById["a:tool:0"]?.startedAt).toBe(running.snapshot.itemsById["a:tool:0"]?.startedAt);
  });

  it("verifies identical provider call IDs independently in different assistant entries", () => {
    const first = call("read", "same", { path: "first" });
    const second = { ...call("read", "same", { path: "second" }), assistantEntryId: "a2" };
    const entries = [user("u", null, "read"), toolAssistant([first]), callMarker("c1", "a", first), toolResult("r1", "c1", first),
      toolAssistant([second], "a2", "r1"), callMarker("c2", "a2", second), toolResult("r2", "c2", second)];
    const input = attested(entries);
    expect(input.toolCalls).toHaveLength(2);
    expect(projectNativeHistory(input).snapshot.itemsById["a2:tool:0"]).toMatchObject({ path: { text: "second" } });
    expect(verifyPiNativeToolCalls(entries.map(parsePiNativeEntry), "other-session", authenticationKey)).toEqual([]);
  });

  it.each([false, true])("projects agent-tool cards only from exact authenticated invocation results (failed=%s)", (isError) => {
    const nativeCall = { ...call("sedes_read", "agent", { toolId: "thread.list", schemaVersion: 8, input: {} }),
      managed: "agent" as const, sourceInfo: { source: "extension", path: "/managed/sedes.ts" } };
    const correlation = { toolId: "thread.list", schemaVersion: 8, invocationId: "invocation-1" };
    const result: PiNativeToolResult = { toolCallId: "agent", assistantEntryId: "a", userEntryId: "u", isError,
      content: [{ type: "text", text: isError ? "failed" : "completed" }], details: { agentToolInvocation: correlation,
        invocation: { invocationId: correlation.invocationId, state: isError ? "failed" : "completed" } } };
    const base = [user("u", null, "work"), toolAssistant([nativeCall]), callMarker("call", "a", nativeCall)];
    const unsigned = attested([...base, toolResult("raw", "call", nativeCall, result)]);
    expect(projectNativeHistory(unsigned).snapshot.itemsById["a:tool:0"]).not.toHaveProperty("agentToolInvocation");
    const signed = attested([...base, resultMarker("signed", "call", result), toolResult("raw", "signed", nativeCall, result)]);
    expect(projectNativeHistory(signed).snapshot.itemsById["a:tool:0"]).toMatchObject({ semanticKind: "tool",
      status: isError ? "failed" : "completed", agentToolInvocation: correlation });
    const wrongTool = { ...result, details: { agentToolInvocation: { ...correlation, toolId: "thread.archive" }, invocation: { invocationId: correlation.invocationId } } };
    const mismatched = attested([...base, resultMarker("signed", "call", wrongTool), toolResult("raw", "signed", nativeCall, result)]);
    expect(projectNativeHistory(mismatched).snapshot.itemsById["a:tool:0"]).not.toHaveProperty("agentToolInvocation");
  });

  it("publishes bounded exact native image bytes using scoped immutable keys and only selected branches", async () => {
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE3sAAAAASUVORK5CYII=";
    const builtin = call("read", "read", { path: "/private/path/picture.png" });
    const entries = [user("u", null, "view"), toolAssistant([builtin]), callMarker("c", "a", builtin),
      toolResult("image-result", "c", builtin, { content: [{ type: "image", data: imageData, mimeType: "image/png" }] }),
      toolResult("abandoned", "c", builtin, { content: [{ type: "image", data: "not image", mimeType: "image/png" }] })];
    const input = attested(entries, "image-result");
    const bytes = Buffer.from(imageData, "base64");
    const descriptor = { artifactId: "627b2b24-f5f6-47d7-9b0e-4121dc236713", mediaType: "image/png" as const,
      byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const publisher = { findImage: vi.fn().mockReturnValue(undefined), publishImage: vi.fn().mockResolvedValue(descriptor) };
    const binding = { tenantId: "tenant", ownerPrincipalId: "principal", applicationThreadId: "thread" };
    const images = await publishNativeHistoryArtifacts(input, binding, publisher);
    expect(publisher.publishImage).toHaveBeenCalledOnce();
    expect(publisher.publishImage).toHaveBeenCalledWith(expect.objectContaining({ scope: { tenantId: "tenant", principalId: "principal" }, threadId: "thread", bytes,
      publicationKey: nativeImageKey(input.sessionId, "image-result", 0) }));
    const projected = projectNativeHistory(input, { images });
    expect(projected.snapshot.itemsById["image-result:viewed:0"]).toMatchObject({ semanticKind: "viewed_image", fileName: { text: "picture.png" } });
    expect(projected.snapshot.itemsById["image-result:image:0"]).toMatchObject({ semanticKind: "image", origin: { kind: "viewed", capture: "provider_input" }, image: { representation: "artifact", artifactId: descriptor.artifactId } });
    expect(JSON.stringify(projected.snapshot)).not.toContain(imageData);
    expect(JSON.stringify(images)).not.toContain("abandoned");
  });

  it("does not mutate an image placeholder after a transient publication failure", async () => {
    const builtin = call("read", "read", { path: "image.png" });
    const input = attested([user("u", null, "view"), toolAssistant([builtin]), callMarker("c", "a", builtin),
      toolResult("r", "c", builtin, { content: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE3sAAAAASUVORK5CYII=", mimeType: "image/png" }] })]);
    const publisher = { findImage: vi.fn(), publishImage: vi.fn().mockRejectedValue(new Error("temporarily unavailable")) };
    const images = await publishNativeHistoryArtifacts(input, { tenantId: "t", ownerPrincipalId: "p", applicationThreadId: "thread" }, publisher);
    expect(projectNativeHistory(input, { images }).snapshot.itemsById["r:image:0"]).toBeUndefined();
    expect(projectNativeHistory(input, { images }).snapshot.itemsById["r:viewed:0"]).toBeDefined();
  });
});
