import { describe, expect, it, vi } from "vitest";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";

describe.skipIf(!RUN_REAL_OPENCODE)("OpenCode v2 native streaming evidence", () => {
  it("publishes a live prefix absent from active history and later stores the complete replacement", async () => {
    const model = await startOpencodeModelFixture();
    const native = await startOpencodeNativeFixture({ config: model.config }).catch(async (error) => { await model.stop(); throw error; });
    const hold = model.holdNextStream("stream qualification");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let prefix: Promise<unknown> | undefined;
    try {
      const created = await native.api("POST", "/api/session", {
        title: "Streaming qualification", location: { directory: native.workspace },
        model: { providerID: "probe", id: "probe-model" },
      });
      expect(created.status).toBe(200);
      const sessionId = created.body.data.id;
      const stream = await native.stream("/api/event", controller.signal);
      expect(stream.status).toBe(200);
      prefix = observePrefix(stream, sessionId);
      // Register a rejection consumer before native work so timeout is owned.
      void prefix.catch(() => {});
      expect((await native.api("POST", `/api/session/${sessionId}/prompt`, {
        id: "msg_stream", text: "stream qualification",
      })).status).toBe(200);
      await hold.started;
      const delta = await prefix;
      expect(delta).toMatchObject({ type: "session.text.delta", data: { sessionID: sessionId, delta: "PREFIX" } });
      const active = await native.api("GET", `/api/session/${sessionId}/message?order=asc&limit=200`);
      expect(active.status).toBe(200);
      expect(JSON.stringify(active.body)).not.toContain("PREFIX");
      expect(active.body.data.some((message: any) => message.type === "assistant")).toBe(true);
      expect(active.body.data.some((message: any) => message.type === "idle")).toBe(false);
      hold.release();
      await vi.waitFor(async () => {
        const complete = await native.api("GET", `/api/session/${sessionId}/message?order=asc&limit=200`);
        expect(complete.body.data.some((message: any) => message.type === "idle")).toBe(true);
        expect(JSON.stringify(complete.body)).toContain("PREFIXSUFFIX");
      }, { timeout: 10_000, interval: 25 });
      // This qualifies native observations only. A coherent Sedes actor install,
      // resnapshot, Stop admission, and same-generation overlay are still needed.
    } finally {
      controller.abort();
      clearTimeout(timer);
      hold.release();
      await prefix?.catch(() => {});
      try { await native.stop(); } finally { await model.stop(); }
    }
  });
});

async function observePrefix(response: Response, sessionId: string): Promise<unknown> {
  if (!response.body) throw new Error("Missing native SSE body");
  const decoder = new TextDecoder();
  let pending = "";
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > 8 * 1024 * 1024) throw new Error("Fixture SSE acquisition overflow");
    pending += decoder.decode(chunk, { stream: true });
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n");
      const line = pending.slice(0, end).trimEnd();
      pending = pending.slice(end + 1);
      if (!line.startsWith("data: ")) continue;
      const value = JSON.parse(line.slice(6));
      if (value.type === "session.text.delta" && value.data?.sessionID === sessionId && value.data.delta === "PREFIX") return value;
    }
  }
  throw new Error("Native SSE closed before the expected prefix");
}
