import { expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { boundedOpenCodeProcessFile } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { readOpenCodeHistory, refreshOpenCodeHistory } from "../../src/server/backends/opencode/opencode-history-reader.js";
import { OpenCodeHistoryProjection } from "../../src/server/backends/opencode/opencode-history-projection.js";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";

it.runIf(RUN_REAL_OPENCODE)("projects real native history and catches up through desc.previous pages without changing its opening coordinate", async () => {
  const model = await startOpencodeModelFixture();
  let native: Awaited<ReturnType<typeof startOpencodeNativeFixture>> | undefined;
  let client: OpenCodeHttpClient | undefined;
  try {
    native = await startOpencodeNativeFixture({ config: model.config });
    const environment = await boundedOpenCodeProcessFile(`/proc/${native.pid}/environ`, 1_048_576);
    const password = environment.toString("utf8").split("\0").find(entry => entry.startsWith("OPENCODE_PASSWORD="))?.slice("OPENCODE_PASSWORD=".length);
    if (!password) throw new Error("isolated fixture password unavailable");
    client = new OpenCodeHttpClient({ endpoint: native.url, password });
    const api = new OpenCodeNativeApi(client);
    const response = await native.api("POST", "/api/session", {
      title: "Retained history projection", location: { directory: native.workspace }, model: { providerID: "probe", id: "probe-model" },
    });
    expect(response.status).toBe(200);
    const sessionId = z.object({ data: z.object({ id: z.string() }) }).parse(response.body).data.id;
    const identity = { bindingScope: ["qualification", native.workspace, sessionId], generation: "fixture-owner", activity: "idle" as const };
    expect(new OpenCodeHistoryProjection(await readOpenCodeHistory(api, { sessionId }), identity).snapshot().snapshot.orderedBackendTurnIds).toEqual([]);
    expect((await native.api("POST", `/api/session/${sessionId}/prompt`, { id: "msg_first", text: "first" })).status).toBe(200);
    await vi.waitFor(async () => expect((await api.getHistoryPage(sessionId, { order: "desc", limit: 1 })).data[0]?.type).toBe("idle"), { timeout: 20_000, interval: 25 });
    const original = await readOpenCodeHistory(api, { sessionId, pageSize: 2 });
    const first = new OpenCodeHistoryProjection(original, identity);
    const firstId = first.orderedBackendTurnIds[0]!;

    const hold = model.holdNextStream("second");
    try {
      expect((await native.api("POST", `/api/session/${sessionId}/model`, { model: { providerID: "probe", id: "second-model" } })).status).toBe(204);
      expect((await native.api("POST", `/api/session/${sessionId}/prompt`, { id: "msg_second", text: "second" })).status).toBe(200);
      await hold.started;
      const active = await refreshOpenCodeHistory(api, original, { sessionId, pageSize: 2 });
      const running = new OpenCodeHistoryProjection(active, { ...identity, activity: "running" });
      const activeId = running.activeBackendTurnId!;
      expect(running.orderedBackendTurnIds).toEqual([firstId, activeId]);
      expect(running.turnsById[activeId]!.status).toBe("in_progress");
      hold.release();
      await vi.waitFor(async () => expect((await api.getHistoryPage(sessionId, { order: "desc", limit: 1 })).data[0]?.type).toBe("idle"), { timeout: 20_000, interval: 25 });
      const complete = await refreshOpenCodeHistory(api, active, { sessionId, pageSize: 2 });
      expect(complete.messages).toEqual((await readOpenCodeHistory(api, { sessionId, pageSize: 2 })).messages);
      const finished = new OpenCodeHistoryProjection(complete, identity);
      expect(finished.orderedBackendTurnIds).toEqual([firstId, activeId]);
      expect(finished.turnsById[activeId]!.status).toBe("completed");
      expect(Object.values(finished.itemsById).filter(item => item.semanticKind === "assistant_message")).toEqual(expect.arrayContaining([
        expect.objectContaining({ markdown: { text: "PREFIXSUFFIX" }, status: "completed" }),
      ]));
      const latest = finished.snapshot({ limit: 1 });
      expect(finished.history({ cursor: latest.previousCursor, limit: 1 }).orderedBackendTurnIds).toEqual([firstId]);
      expect(finished.locateTurn({ maximumTurnCandidates: 2, matchesBackendTurnId: id => id === firstId })).toMatchObject({ status: "found", page: { orderedBackendTurnIds: [firstId] } });
    } finally { hold.release(); }
  } finally {
    client?.close();
    try { await native?.stop(); } finally { await model.stop(); }
  }
}, 60_000);
