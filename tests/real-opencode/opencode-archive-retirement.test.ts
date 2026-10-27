import type { SessionMessageInfo } from "@opencode/client";
import { expect, it } from "vitest";
import { z } from "zod";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { createOpenCodeNativePortFixture } from "../helpers/opencode-native-port-fixture.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";

it.runIf(RUN_REAL_OPENCODE)("archives an inactive imported orphan through stock native inventories without settling or mutating its history", async () => {
  const model = await startOpencodeModelFixture();
  let native: Awaited<ReturnType<typeof startOpencodeNativeFixture>> | undefined;
  let current: ReturnType<typeof createOpenCodeConversationFixture> | undefined;
  let client: OpenCodeHttpClient | undefined;
  let acquired: Awaited<ReturnType<ReturnType<typeof createOpenCodeConversationFixture>["acquire"]>> | undefined;
  try {
    native = await startOpencodeNativeFixture({ config: model.config });
    const requests: { method: string; path: string }[] = [];
    client = new OpenCodeHttpClient({ endpoint: native.url, password: native.account.password, fetch: (value, init) => {
      requests.push({ method: init?.method ?? "GET", path: new URL(String(value)).pathname });
      return fetch(value, init);
    } });
    const created = await native.api("POST", "/api/session", { title: "Imported orphan fixture", location: { directory: native.workspace },
      model: { providerID: "probe", id: "probe-model" } });
    expect(created.status).toBe(200);
    const messages: SessionMessageInfo[] = [
      { id: "msg_imported_orphan_user", type: "user", text: "Old interrupted request", time: { created: 1 } },
      { id: "msg_imported_orphan_tool", type: "assistant", agent: "build", model: { providerID: "probe", id: "probe-model" }, finish: "tool-calls",
        content: [{ type: "tool", id: "tool_imported_orphan_read", name: "read", state: { status: "completed", input: {},
          content: [{ type: "text", text: "Old read result" }] }, time: { created: 2, completed: 3 } }], time: { created: 2, completed: 3 } },
      { id: "msg_imported_orphan_assistant", type: "assistant", agent: "build", model: { providerID: "probe", id: "probe-model" },
        content: [{ type: "text", text: "Partial imported response" }], error: { type: "aborted", message: "Aborted" }, time: { created: 4, completed: 5 } },
      { id: "msg_imported_orphan_system", type: "system", text: "Later system context", time: { created: 6 } },
    ];
    const imported = await native.api("POST", "/api/experimental/session/import", {
      info: { ...created.body.data, id: "ses_archive_orphan_fixture" }, messages, location: { directory: native.workspace },
    });
    expect(imported.status).toBe(200);
    const sessionID = z.object({ data: z.object({ id: z.string() }) }).parse(imported.body).data.id;
    current = createOpenCodeConversationFixture({ native: { client, sessionID, directory: native.workspace } });
    const api = new OpenCodeNativeApi(createOpenCodeNativePortFixture(client, { directory: native.workspace, sessionID }));
    await expect(api.getActivity(sessionID, native.workspace)).resolves.toMatchObject({ active: false, activeChildren: [], shells: [] });
    await expect(current.driver.releaseConversationResidency(current.target)).resolves.toBe("busy");
    await expect(current.driver.releaseConversationResidency({ ...current.target, purpose: "archive" })).resolves.toBe("released");

    acquired = await current.acquire();
    const actor = acquired.actor, snapshot = await actor.captureSnapshotState();
    expect(snapshot.timeline.runState).toBe("disconnected");
    expect(Object.values(snapshot.timeline.turnsById).map(turn => turn.status)).toEqual(["in_progress"]);
    expect(actor.canEvict).toBe(false); expect(actor.canRetireForArchive).toBe(true);
    acquired.release(); acquired = undefined;
    const fixture = current;
    await expect(current.manager.runWithRuntimeRetired({ scope, applicationThreadId: threadID, disposition: { kind: "archive" },
      detachCoordinatorRuntime: async () => {}, operation: () => fixture.driver.releaseConversationResidency({ ...fixture.target, purpose: "archive" }) }))
      .resolves.toBe("released");
    expect(actor.closed).toBe(true);
    acquired = await current.acquire();
    expect(acquired.actor.timeline.runState).toBe("disconnected");
    expect(Object.values(acquired.actor.timeline.turnsById).map(turn => turn.status)).toEqual(["in_progress"]);
    expect((await api.getHistoryPage(sessionID, { order: "asc", limit: 50 })).data).toEqual(messages);
    expect(requests.every(request => request.method === "GET")).toBe(true);
  } finally {
    acquired?.release();
    try { await current?.dispose(); } finally {
      client?.close(); try { await native?.stop(); } finally { await model.stop(); }
    }
  }
}, 60_000);
