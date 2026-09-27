import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  RUN_REAL_OPENCODE,
  startOpencodeNativeFixture,
  type OpenCodeNativeFixture,
} from "../support/opencode-native-fixture.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";

// These are consumed fixture fields, not a production OpenCode wire decoder.
// The admitted protocol is 2.0.18 / cd9a14a6b688d4021bee381dfd39d2cef9c0f862.
const message = z.object({
  id: z.string().startsWith("msg_"),
  type: z.enum([
    "agent-switched",
    "model-switched",
    "location-switched",
    "user",
    "synthetic",
    "system",
    "skill",
    "shell",
    "assistant",
    "compaction",
    "idle",
  ]),
  time: z.object({ created: z.number(), completed: z.number().optional() }),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .optional(),
});
const messagesPage = z.object({
  data: z.array(message),
  cursor: z.object({
    previous: z.string().nullable(),
    next: z.string().nullable(),
  }),
});
type Message = z.infer<typeof message>;

describe.runIf(RUN_REAL_OPENCODE)(
  "OpenCode v2 native history qualification",
  () => {
    let native: OpenCodeNativeFixture | undefined;
    let model:
      Awaited<ReturnType<typeof startOpencodeModelFixture>> | undefined;

    beforeEach(async () => {
      model = await startOpencodeModelFixture();
      native = await startOpencodeNativeFixture({ config: model.config });
    }, 45_000);

    afterEach(async () => {
      try {
        await native?.stop();
      } finally {
        await model?.stop();
        native = undefined;
        model = undefined;
      }
    }, 15_000);

    const create = async (title: string) => {
      const result = await native!.api("POST", "/api/session", {
        title,
        location: { directory: native!.workspace },
        model: { providerID: "probe", id: "probe-model" },
      });
      expect(result.status).toBe(200);
      return z
        .object({ data: z.object({ id: z.string().startsWith("ses_") }) })
        .parse(result.body).data.id;
    };

    const page = async (
      session: string,
      query: Record<string, string | number>,
    ) => {
      const parameters = new URLSearchParams(
        Object.entries(query).map(([key, value]) => [key, String(value)]),
      );
      const result = await native!.api(
        "GET",
        `/api/session/${session}/message?${parameters}`,
      );
      expect(result.status).toBe(200);
      return messagesPage.parse(result.body);
    };

    const history = async (session: string) =>
      (await page(session, { order: "asc", limit: 200 })).data;

    const prompt = async (
      session: string,
      id: string,
      text = id,
      delivery?: "steer",
    ) => {
      const result = await native!.api(
        "POST",
        `/api/session/${session}/prompt`,
        {
          id,
          text,
          ...(delivery ? { delivery } : {}),
        },
      );
      expect(result.status).toBe(200);
    };

    const settled = async (session: string, idleCount: number) => {
      let messages: Message[] = [];
      await vi.waitFor(
        async () => {
          messages = await history(session);
          expect(messages.filter(({ type }) => type === "idle")).toHaveLength(
            idleCount,
          );
        },
        { timeout: 20_000, interval: 25 },
      );
      return messages;
    };

    it("rejects every proposed idle filter instead of providing lightweight turn shells", async () => {
      const session = await create("Closed filter qualification");
      await prompt(session, "msg_filter");
      const full = await settled(session, 1);
      expect(full.at(-1)?.type).toBe("idle");

      for (const type of [
        "idle",
        "user,idle",
        "idle,user",
        "*",
        "execution.succeeded",
      ]) {
        const query = new URLSearchParams({ type, limit: "1" });
        const response = await native!.api(
          "GET",
          `/api/session/${session}/message?${query}`,
        );
        expect(response.status, type).toBe(400);
      }
      // A legal filter returns complete native message payloads, not turn shells.
      const users = await page(session, {
        type: "user",
        limit: 1,
        order: "desc",
      });
      expect(users.data.map(({ id }) => id)).toEqual(["msg_filter"]);
    }, 30_000);

    it("reads a stable opening after an idle with one opaque cursor request, including settings", async () => {
      const session = await create("Boundary cursors");
      expect(await history(session)).toEqual([]);
      await prompt(session, "msg_first");
      await settled(session, 1);
      const boundaryPage = await page(session, { order: "desc", limit: 1 });
      expect(boundaryPage.data[0]?.type).toBe("idle");
      const forward = boundaryPage.cursor.previous!;

      const change = await native!.api(
        "POST",
        `/api/session/${session}/model`,
        {
          model: { providerID: "probe", id: "second-model" },
        },
      );
      expect(change.status).toBe(204);
      const opening = await page(session, { cursor: forward, limit: 1 });
      expect(opening.data[0]?.type).toBe("model-switched");
      await prompt(session, "msg_second");
      const settledHistory = await settled(session, 2);
      expect((await page(session, { cursor: forward, limit: 1 })).data).toEqual(
        opening.data,
      );
      expect(
        (await page(session, { cursor: opening.cursor.previous!, limit: 1 }))
          .data[0]?.id,
      ).toBe("msg_second");
      const previousIndex = settledHistory.findIndex(
        ({ id }) => id === boundaryPage.data[0]!.id,
      );
      expect(settledHistory[previousIndex + 1]?.id).toBe(opening.data[0]!.id);
      expect(
        (await page(session, { order: "asc", limit: 1 })).data[0]?.id,
      ).toBe("msg_first");

      const forbidden = new URLSearchParams({ cursor: forward, order: "asc" });
      expect(
        (
          await native!.api(
            "GET",
            `/api/session/${session}/message?${forbidden}`,
          )
        ).status,
      ).toBe(400);
    }, 30_000);

    it("keeps active opening identity through steer and settlement while unfinished text is absent", async () => {
      const session = await create("Steered busy period");
      const hold = model!.holdNextStream("msg_active");
      try {
        await prompt(session, "msg_active");
        await hold.started;
        const active = await history(session);
        expect(active[0]?.id).toBe("msg_active");
        expect(active.some(({ type }) => type === "idle")).toBe(false);
        expect(
          active.find(({ type }) => type === "assistant")?.time.completed,
        ).toBeUndefined();
        expect(JSON.stringify(active)).not.toContain("PREFIX");
        await prompt(
          session,
          "msg_steer",
          "Steer during held response",
          "steer",
        );
        hold.release();
        const complete = await settled(session, 1);
        expect(complete[0]?.id).toBe(active[0]?.id);
        expect(
          complete.filter(({ type }) => type === "user").map(({ id }) => id),
        ).toEqual(["msg_active", "msg_steer"]);
        expect(
          complete.find(({ type }) => type === "assistant")?.content,
        ).toContainEqual({ type: "text", text: "PREFIXSUFFIX" });
        expect(
          (await page(session, { type: "user", limit: 200, order: "desc" }))
            .data,
        ).toHaveLength(2);
        expect(complete.filter(({ type }) => type === "idle")).toHaveLength(1);
      } finally {
        hold.release();
      }
    }, 30_000);

    it("exposes empty periods without implying another model invocation", async () => {
      const session = await create("Empty busy period");
      await prompt(session, "msg_empty_period");
      await settled(session, 1);
      const firstBoundary = await page(session, { order: "desc", limit: 1 });
      const requests = model!.requestCount;
      await prompt(session, "msg_empty_period");
      const repeated = await settled(session, 2);
      expect(repeated.slice(-2).map(({ type }) => type)).toEqual([
        "idle",
        "idle",
      ]);
      expect(model!.requestCount).toBe(requests);
      const emptyOpening = await page(session, {
        cursor: firstBoundary.cursor.previous!,
        limit: 1,
      });
      expect(emptyOpening.data[0]?.id).toBe(repeated.at(-1)?.id);
      expect(emptyOpening.data[0]?.type).toBe("idle");
    }, 30_000);

    it("returns empty pages for foreign and deleted anchors, so absence needs separate validation", async () => {
      const session = await create("Cursor invalidation");
      await prompt(session, "msg_before_revert");
      await settled(session, 1);
      await prompt(session, "msg_reverted");
      await settled(session, 2);
      const latest = await page(session, { order: "desc", limit: 1 });
      const foreign = await create("Foreign cursor scope");
      expect(
        (await page(foreign, { cursor: latest.cursor.next!, limit: 1 })).data,
      ).toEqual([]);
      expect(
        (
          await native!.api("POST", `/api/session/${session}/revert/stage`, {
            messageID: "msg_reverted",
            files: false,
          })
        ).status,
      ).toBe(200);
      expect(
        (await native!.api("POST", `/api/session/${session}/revert/commit`))
          .status,
      ).toBe(204);
      expect(
        (await page(session, { cursor: latest.cursor.next!, limit: 1 })).data,
      ).toEqual([]);
      expect(
        (
          await native!.api(
            "GET",
            `/api/session/${session}/message/${latest.data[0]!.id}`,
          )
        ).status,
      ).toBe(404);
      expect((await history(session))[0]?.id).toBe("msg_before_revert");
    }, 30_000);

    it("regenerates opening identities when a native historical fork copies a completed period", async () => {
      const session = await create("Fork identities");
      await prompt(session, "msg_fork_first");
      const first = await settled(session, 1);
      await prompt(session, "msg_fork_excluded");
      await settled(session, 2);
      const response = await native!.api(
        "POST",
        `/api/session/${session}/fork`,
        {
          before: "msg_fork_excluded",
        },
      );
      expect(response.status).toBe(200);
      const child = z
        .object({ data: z.object({ id: z.string().startsWith("ses_") }) })
        .parse(response.body).data.id;
      const copied = await history(child);
      expect(copied.map(({ type }) => type)).toEqual(
        first.map(({ type }) => type),
      );
      const parentIds = new Set(first.map(({ id }) => id));
      expect(copied.every(({ id }) => !parentIds.has(id))).toBe(true);
      expect(copied[0]?.id).not.toBe(first[0]?.id);
    }, 30_000);
  },
);
