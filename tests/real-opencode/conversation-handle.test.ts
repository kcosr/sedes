import { createOpenCodeNativePortFixture } from "../helpers/opencode-native-port-fixture.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionMessageInfo } from "@opencode/client";
import type { BackendConversationEvent } from "../../src/shared/protocol/backend.js";
import type { ConversationActor } from "../../src/server/conversations/conversation-actor.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { boundedOpenCodeProcessFile } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";

function seedMessages(): SessionMessageInfo[] {
  return Array.from({ length: 12 }, (_, index) => [
    { id: `msg_seed_user_${index}`, type: "user", text: `Seed ${index}`, time: { created: index * 3 + 1 } },
    { id: `msg_seed_assistant_${index}`, type: "assistant", agent: "build", model: { providerID: "probe", id: "probe-model" },
      content: [{ type: "text", text: `Seed answer ${index}` }], time: { created: index * 3 + 2, completed: index * 3 + 2 } },
    { id: `msg_seed_idle_${index}`, type: "idle", outcome: "succeeded", time: { created: index * 3 + 3 } },
  ] as SessionMessageInfo[]).flat();
}

function assistantItems(actor: ConversationActor) {
  return Object.values(actor.timeline.itemsById).filter(item => item.kind === "assistant_message");
}

it.runIf(RUN_REAL_OPENCODE)("projects stock native history and live replacement through the real actor, with independent Stop and retained older turns", async () => {
  const model = await startOpencodeModelFixture();
  let native: Awaited<ReturnType<typeof startOpencodeNativeFixture>> | undefined;
  let current: ReturnType<typeof createOpenCodeConversationFixture> | undefined;
  let client: OpenCodeHttpClient | undefined;
  let acquired: Awaited<ReturnType<ReturnType<typeof createOpenCodeConversationFixture>["acquire"]>> | undefined;
  const holds: ReturnType<typeof model.holdNextStream>[] = [];
  try {
    native = await startOpencodeNativeFixture({ config: model.config });
    const entries = (await boundedOpenCodeProcessFile(`/proc/${native.pid}/environ`, 1_048_576)).toString("utf8").split("\0");
    const password = entries.find(entry => entry.startsWith("OPENCODE_PASSWORD="))?.slice("OPENCODE_PASSWORD=".length);
    if (!password) throw new Error("isolated fixture password unavailable");
    client = new OpenCodeHttpClient({ endpoint: native.url, password });
    const created = await native.api("POST", "/api/session", { title: "Actor qualification", location: { directory: native.workspace },
      model: { providerID: "probe", id: "probe-model" } });
    expect(created.status).toBe(200);
    // Only the native fixture seeds imported history; the production adapter
    // reads that history and separately controls the active native session.
    const imported = await native.api("POST", "/api/experimental/session/import", {
      info: { ...created.body.data, id: "ses_actor_qualification", title: "Imported actor qualification" },
      messages: seedMessages(), location: { directory: native.workspace },
    });
    expect(imported.status).toBe(200);
    const sessionID = z.object({ data: z.object({ id: z.string() }) }).parse(imported.body).data.id;
    const port = createOpenCodeNativePortFixture(client, { directory: native.workspace, sessionID: sessionID });
    const api = new OpenCodeNativeApi(port);
    current = createOpenCodeConversationFixture({ native: { client, sessionID, directory: native.workspace } });
    acquired = await current.acquire();
    const actor = acquired.actor;
    const observed: BackendConversationEvent[] = [];
    (await current.handle()).subscribe(event => observed.push(event));
    const expectNoRecovery = (since: number) => {
      expect(observed.slice(since).filter(event => event.type === "run_state_changed" &&
        (event.state === "disconnected" || event.state === "reconciling"))).toEqual([]);
      expect(observed.slice(since).filter(event => event.type === "resnapshot_required")).toEqual([]);
    };
    const initial = await actor.captureSnapshotState();
    expect(initial.timeline.runState).toBe("idle");
    expect(initial.timeline.orderedTurnIds).toHaveLength(10);
    expect(initial.history?.previousCursor).toBeDefined();
    expect(initial.usage).toMatchObject({ context: { windowTokens: 100_000 },
      counters: { userMessages: 12, assistantMessages: 12, totalMessages: 24 } });
    expect(initial.usage.context?.usedTokens).toBeUndefined();
    const older = await actor.history({ cursor: initial.history!.previousCursor!, limit: 10 });
    expect(older.page.orderedTurnIds).toHaveLength(2);
    expect(older.page.previousCursor).toBeUndefined();
    const firstTurn = older.page.orderedTurnIds[0]!;
    expect(await actor.locateTurn({ targetTurnId: firstTurn })).toMatchObject({ status: "found", page: { orderedTurnIds: [firstTurn] } });

    const completedHold = model.holdNextStream("complete through actor"); holds.push(completedHold);
    const firstStartup = observed.length;
    expect((await native.api("POST", `/api/session/${sessionID}/prompt`, { id: "msg_actor_complete", text: "complete through actor" })).status).toBe(200);
    await completedHold.started;
    // Native request startup alone is insufficient: wait for the actual actor
    // to consume the SSE prefix before inspecting its active projection.
    await vi.waitFor(() => expect(assistantItems(actor)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "streaming", markdown: { text: "PREFIX" } }),
    ])), { timeout: 15_000, interval: 25 });
    const activeTurn = actor.timeline.activeTurnId!;
    expect(actor.timeline.runState).toBe("running");
    expect(activeTurn).toBeDefined();
    expectNoRecovery(firstStartup);
    expect(await actor.locateTurn({ targetTurnId: firstTurn })).toMatchObject({ status: "found", page: { orderedTurnIds: [firstTurn] } });
    completedHold.release();
    await vi.waitFor(() => {
      expect(actor.timeline.runState).toBe("idle");
      expect(actor.timeline.turnsById[activeTurn]!.status).toBe("completed");
      expect(assistantItems(actor)).toEqual(expect.arrayContaining([
        expect.objectContaining({ turnId: activeTurn, status: "completed", markdown: { text: "PREFIXSUFFIX" } }),
      ]));
    }, { timeout: 15_000, interval: 25 });
    expectNoRecovery(firstStartup);
    await vi.waitFor(async () => {
      const { usage } = await actor.captureSnapshotState();
      expect(usage.context?.usedTokens).toBeGreaterThan(0);
      expect(usage.context?.windowTokens).toBe(100_000);
      expect(usage.context?.percent).toBe(usage.context!.usedTokens! / 100_000 * 100);
      expect(usage.counters).toMatchObject({ userMessages: 13, assistantMessages: 13, totalMessages: 26 });
    });
    expect(observed.some(event => event.type === "usage_changed" && event.usage.context?.usedTokens !== undefined)).toBe(true);
    expect(assistantItems(actor).some(item => item.markdown.text.includes("PREFIXPREFIX"))).toBe(false);
    expect((await actor.history({ cursor: initial.history!.previousCursor!, limit: 10 })).page.orderedTurnIds).toEqual(older.page.orderedTurnIds);

    const interruptedHold = model.holdNextStream("interrupt through actor"); holds.push(interruptedHold);
    const secondStartup = observed.length;
    expect((await native.api("POST", `/api/session/${sessionID}/prompt`, { id: "msg_actor_interrupt", text: "interrupt through actor" })).status).toBe(200);
    await interruptedHold.started;
    await vi.waitFor(() => {
      expect(actor.timeline.runState).toBe("running");
      expect(actor.timeline.activeTurnId).not.toBe(activeTurn);
      expect(assistantItems(actor)).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "streaming", markdown: { text: "PREFIX" } }),
      ]));
    }, { timeout: 15_000, interval: 25 });
    const interruptedTurn = actor.timeline.activeTurnId!;
    expectNoRecovery(secondStartup);
    const control = current.manager.acquireExistingControl(scope, threadID)!;
    expect(control).toBeDefined();
    const operation = { applicationOperationId: "native-actor-stop", deadlineAt: Date.now() + 30_000 };
    try {
      await control.control.interrupt(operation);
      expect(await control.control.reconcileInterrupt(operation)).toEqual({ outcome: "accepted" });
    } finally { control.release(); }
    // Stop acknowledgment is not terminal evidence. Require native idle and
    // its actor-projected interrupted outcome before asserting settlement.
    await vi.waitFor(async () => {
      expect((await api.getHistoryPage(sessionID, { order: "desc", limit: 1 })).data[0]).toMatchObject({ type: "idle", outcome: "interrupted" });
      expect(actor.timeline.turnsById[interruptedTurn]!.status).toBe("interrupted");
      expect(actor.timeline.runState).toBe("idle");
    }, { timeout: 15_000, interval: 25 });
    expectNoRecovery(secondStartup);
    interruptedHold.release();
    expect(current.attached).toHaveBeenCalledOnce();
    expect(actor.projectionRecoveryRequired).toBe(false);
    expect(Object.values(actor.timeline.itemsById).filter(item => item.kind === "user_message").every(item => item.deliveryOperationId === undefined)).toBe(true);
  } finally {
    for (const hold of holds) hold.release();
    acquired?.release();
    try { await current?.dispose(); } finally {
      client?.close();
      try { await native?.stop(); } finally { await model.stop(); }
    }
  }
}, 90_000);
