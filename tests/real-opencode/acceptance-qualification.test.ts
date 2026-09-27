import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";

describe.skipIf(!RUN_REAL_OPENCODE)("OpenCode v2 native acceptance qualification (loopback inference)", () => {
  it("recovers a dropped admission response by GET and proves first-payload-wins", async () => {
    const model = await startOpencodeModelFixture();
    const native = await startOpencodeNativeFixture({ config: model.config }).catch(async (error) => { await model.stop(); throw error; });
    let mutationCount = 0;
    const proxy = createServer((_request, response) => {
      // Lose the HTTP response only after the real native commit has returned.
      // The test caller therefore has an unknown outcome, not a fake refusal.
      mutationCount += 1;
      void native.api("POST", "/api/session/ses_acceptance/prompt", {
        id: "msg_receipt", text: "original", resume: false,
        metadata: { qualification: "original-fingerprint" },
      }).then(() => response.destroy(), () => response.destroy());
    });
    try {
      const original = await native.api("POST", "/api/session", {
        id: "ses_acceptance", title: "Original title", location: { directory: native.workspace },
        model: { providerID: "probe", id: "probe-model" },
      });
      expect(original.status).toBe(200);
      const duplicate = await native.api("POST", "/api/session", {
        id: "ses_acceptance", title: "Conflicting title", location: { directory: native.workspace },
      });
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.data.title).toBe("Original title");

      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      await expect(fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`, {
        method: "POST", signal: AbortSignal.timeout(30_000),
      })).rejects.toThrow();
      const inbox = await native.api("GET", "/api/session/ses_acceptance/inbox");
      expect(inbox.status).toBe(200);
      expect(inbox.body.data).toEqual([expect.objectContaining({
        id: "msg_receipt", sessionID: "ses_acceptance", type: "user",
        payload: { text: "original", metadata: { qualification: "original-fingerprint" } },
      })]);
      expect(mutationCount).toBe(1);
      expect(model.requestCount).toBe(0);

      // This deliberate conflicting write characterizes native semantics only;
      // recovery above never posts. A future adapter must reject it locally.
      const conflicting = await native.api("POST", "/api/session/ses_acceptance/prompt", {
        id: "msg_receipt", text: "replacement", resume: false,
        metadata: { qualification: "conflicting-fingerprint" },
      });
      expect(conflicting.status).toBe(200);
      expect(conflicting.body.data.payload).toEqual({ text: "original", metadata: { qualification: "original-fingerprint" } });
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      try { await native.stop(); } finally { await model.stop(); }
    }
  });

  it("reads exact materialization and withdraws an unconsumed steer separately from Stop", async () => {
    const model = await startOpencodeModelFixture();
    const native = await startOpencodeNativeFixture({ config: model.config }).catch(async (error) => { await model.stop(); throw error; });
    const hold = model.holdNextStream("hold");
    try {
      const created = await native.api("POST", "/api/session", {
        title: "Acceptance qualification", location: { directory: native.workspace }, model: { providerID: "probe", id: "probe-model" },
      });
      expect(created.status).toBe(200);
      const route = `/api/session/${created.body.data.id}`;
      expect((await native.api("POST", `${route}/prompt`, { id: "msg_active", text: "hold" })).status).toBe(200);
      await hold.started;
      const admitted = await native.api("POST", `${route}/prompt`, { id: "msg_steer", text: "pending", delivery: "steer" });
      expect(admitted.status).toBe(200);
      const inbox = await native.api("GET", `${route}/inbox`);
      expect(inbox.body.data.map((entry: any) => entry.id)).toEqual(["msg_steer"]);
      const delivered = await native.api("GET", `${route}/message/msg_active`);
      expect(delivered.status).toBe(200);
      expect(delivered.body.data).toMatchObject({ id: "msg_active", type: "user", text: "hold" });
      // Cancellation is a no-op for a delivered ID but still returns 204.
      expect((await native.api("DELETE", `${route}/inbox/msg_active`)).status).toBe(204);
      expect((await native.api("GET", `${route}/message/msg_active`)).status).toBe(200);
      expect((await native.api("GET", `${route}/message/msg_steer`)).status).toBe(404);

      const interrupted = await native.api("POST", `${route}/interrupt`);
      expect(interrupted.body).toMatchObject({ interrupted: true });
      // The acknowledgment precedes runner cleanup. Observe settlement in this
      // same live native process before checking that the steer stayed pending.
      await vi.waitFor(async () => {
        const active = await native.api("GET", "/api/session/active");
        expect(active.status).toBe(200);
        expect(created.body.data.id in active.body.data).toBe(false);
      }, { timeout: 20_000, interval: 25 });
      const stillPending = await native.api("GET", `${route}/inbox`);
      expect(stillPending.body.data.map((entry: any) => entry.id)).toEqual(["msg_steer"]);
      expect(model.streamRequestCount).toBe(1);
      // 204 acknowledges the cancellation request, including a native no-op.
      // This held fixture proves absence after Stop; a production promotion race
      // still needs exact terminal/history evidence, never the status alone.
      expect((await native.api("DELETE", `${route}/inbox/msg_steer`)).status).toBe(204);
      expect((await native.api("GET", `${route}/inbox`)).body.data).toEqual([]);
      expect((await native.api("GET", `${route}/message/msg_steer`)).status).toBe(404);
    } finally {
      hold.release();
      try { await native.stop(); } finally { await model.stop(); }
    }
  });

  it("demonstrates the history-first promotion race and exact read-only recovery", async () => {
    const model = await startOpencodeModelFixture();
    const native = await startOpencodeNativeFixture({ config: model.config }).catch(async (error) => { await model.stop(); throw error; });
    const hold = model.holdNextStream("trigger");
    try {
      const created = await native.api("POST", "/api/session", {
        title: "Promotion qualification", location: { directory: native.workspace },
        model: { providerID: "probe", id: "probe-model" },
      });
      expect(created.status).toBe(200);
      const route = `/api/session/${created.body.data.id}`;
      expect((await native.api("POST", `${route}/prompt`, {
        id: "msg_parked", text: "parked", resume: false,
      })).status).toBe(200);
      const earlierHistory = await native.api("GET", `${route}/message/msg_parked`);
      expect(earlierHistory.status).toBe(404);
      // A different input deliberately triggers native work between two reads.
      expect((await native.api("POST", `${route}/prompt`, {
        id: "msg_trigger", text: "trigger",
      })).status).toBe(200);
      await hold.started;
      const laterInbox = await native.api("GET", `${route}/inbox`);
      expect(laterInbox.body.data.find((entry: any) => entry.id === "msg_parked")).toBeUndefined();
      // Both observations above are empty although this operation was accepted.
      // Recover by exact GET; do not POST again or infer rejection from absence.
      const exact = await native.api("GET", `${route}/message/msg_parked`);
      expect(exact.status).toBe(200);
      expect(exact.body.data).toMatchObject({ id: "msg_parked", type: "user", text: "parked" });
    } finally {
      hold.release();
      try { await native.stop(); } finally { await model.stop(); }
    }
  });
});
