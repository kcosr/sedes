import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PageRepository } from "../../src/server/db/repositories/page-repository.js";
import { UserInputRevisionRepository } from "../../src/server/db/repositories/user-input-revision-repository.js";
import { PAGE_RESPONSE_MAX_BYTES, type PageRevision } from "../../src/shared/protocol/pages.js";
import { directInputRequestBodySchema, directInputRequestSchema, type DirectInputRequest } from "../../src/shared/protocol/thread-input.js";
import { createInMemoryThreadRuntimeHarness } from "../support/in-memory-thread-runtime-harness.js";

type Harness = Awaited<ReturnType<typeof createInMemoryThreadRuntimeHarness>>;
const request = (text = "Bind the page owner"): DirectInputRequest => ({
  mutationId: randomUUID(), text, origin: { clientId: randomUUID() }, runningPolicy: { mode: "queue" },
});
async function draft(h: Harness) {
  return (await h.lifecycle.createServerDraft(h.scope, {
    workspaceId: h.workspaceRecord.id, connectionProfileId: h.connection.id,
    title: "Page owner", initialText: "Keep the composer draft",
  })).applicationThreadId;
}
async function settled(h: Harness, id: string) {
  await vi.waitFor(() => expect(h.actors.observeInputRuntime(h.scope, id)?.settled).toBe(true), { timeout: 15_000 });
  await Promise.all(h.completionFollowUps.splice(0));
}
function publish(h: Harness, threadId: string, title = "Release choices", previous?: PageRevision) {
  const html = "<html><body>Interactive choices</body></html>";
  return new PageRepository(h.database).publish(h.scope, threadId, {
    title, viewport: {}, invocationId: randomUUID(),
    ...(previous ? { pageId: previous.pageId, expectedRevision: previous.revision } : {}),
    prepared: { sourceHtml: html, escapedHtml: JSON.stringify(html).slice(1, -1), bootstrapOffset: 0,
      sha256: createHash("sha256").update(html).digest("hex"), byteSize: Buffer.byteLength(html) },
  }).page;
}
function response(page: PageRevision, text = "Selected: Web, Android\nNotes: keep the existing colors"): DirectInputRequest {
  return { ...request(text), pageResponse: { pageId: page.pageId, revision: page.revision } };
}

describe("page response admission", { timeout: 30_000 }, () => {
  it("captures exact text and the selected revision title, replays once, and attaches a dormant owner", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000, persistDeliveryInputSnapshots: true });
    try {
      const id = await draft(h);
      await h.mutations.admitInput(h.scope, id, request());
      await settled(h, id);
      const page = publish(h, id);
      publish(h, id, "Renamed release choices", page);
      const before = h.inventoryRepository.getDraft(h.scope, id);
      await h.runtimes.runWithRuntimeRetired(h.scope, id, async () => undefined);
      expect(h.actors.observeInputRuntime(h.scope, id)).toBeUndefined();
      const input = response(page, "/do-not-run-as-a-skill\n\nSelected: Web\n");
      const receipt = await h.mutations.admitInput(h.scope, id, input);
      expect(receipt).toMatchObject({ admittedMode: "submit" });
      await vi.waitFor(() => expect(h.mutations.readInputReceipt(h.scope, input.mutationId))
        .toMatchObject({ status: "found", receipt: { status: "accepted" } }));
      await settled(h, id);
      const origin = { kind: "page_response", pageId: page.pageId, revision: 1, title: "Release choices" };
      expect(h.queueRepository.get(h.scope, id, receipt.queuedInputId!)).toMatchObject({ text: input.text, inputOrigin: origin });
      const stored = h.database.prepare("SELECT original_text AS text, origin_json AS origin FROM delivery_input_snapshots WHERE application_operation_id = ?")
        .get(input.mutationId) as { text: string; origin: string };
      expect(stored.text).toBe(input.text);
      expect(JSON.parse(stored.origin)).toEqual(origin);
      expect(h.inventoryRepository.getDraft(h.scope, id)).toEqual(before);
      const revisions = new UserInputRevisionRepository(h.database);
      const revision = revisions.capture(h.scope, id, []).userInputRevision;
      expect(revision).toBe(2);
      await expect(h.mutations.admitInput(h.scope, id, input)).resolves.toMatchObject({ status: "accepted", queuedInputId: receipt.queuedInputId });
      expect(revisions.capture(h.scope, id, []).userInputRevision).toBe(revision);
      for (const changed of [
        { ...input, text: "Different capture" },
        { ...input, pageResponse: { ...input.pageResponse!, revision: 2 } },
        { ...input, pageResponse: undefined },
      ]) await expect(h.mutations.admitInput(h.scope, id, changed)).rejects.toMatchObject({ code: "conflict" });
    } finally { await h.close(); }
  });

  it("queues while busy even when Steer is available and preserves the captured origin", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    const held: (() => void)[] = [];
    try {
      const id = await draft(h);
      vi.spyOn(h.driver, "deliverScriptedAssistantStage").mockImplementation((_text, stage, deliver) => {
        if (stage === "settled") held.push(deliver); else deliver();
      });
      await h.mutations.admitInput(h.scope, id, request());
      await vi.waitFor(async () => expect((await h.mutations.inputContext(h.scope, id)).steer.availability).toBe("available"));
      const page = publish(h, id);
      const input = response(page);
      vi.spyOn(h.queueDispatcher, "dispatchAdmitted").mockResolvedValue();
      const receipt = await h.mutations.admitInput(h.scope, id, input);
      expect(receipt).toMatchObject({ admittedMode: "queue", currentMode: "queue", status: "queued" });
      expect(h.queueRepository.get(h.scope, id, receipt.queuedInputId!)).toMatchObject({
        text: input.text, inputOrigin: { kind: "page_response", pageId: page.pageId, revision: 1, title: page.title },
      });
      await expect(h.mutations.admitInput(h.scope, id, input)).resolves.toEqual(receipt);
      await h.mutations.mutate(h.scope, id, { kind: "cancel_queued_input", queuedInputId: receipt.queuedInputId!,
        mutationId: randomUUID(), expectedThreadRevision: h.inventoryRepository.getThread(h.scope, id).thread.revision });
      vi.restoreAllMocks();
      for (const release of held.splice(0)) release();
      await settled(h, id);
    } finally {
      vi.restoreAllMocks();
      for (const release of held) release();
      await h.close();
    }
  });

  it("rejects missing revisions, foreign pages/principals, and unbound send targets before admission", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const id = await draft(h);
      const other = await draft(h);
      const unbound = await draft(h);
      for (const threadId of [id, other]) {
        await h.mutations.admitInput(h.scope, threadId, request());
        await settled(h, threadId);
      }
      const page = publish(h, id);
      await expect(h.mutations.admitInput(h.scope, other, response(page))).rejects.toMatchObject({ code: "not_found" });
      await expect(h.mutations.admitInput({ ...h.scope, principalId: randomUUID() }, id, response(page))).rejects.toThrow();
      await expect(h.mutations.admitInput(h.scope, id, { ...response(page), pageResponse: { pageId: page.pageId, revision: 999 } }))
        .rejects.toMatchObject({ code: "not_found" });
      await expect(h.mutations.admitInput(h.scope, unbound, response(page))).rejects.toMatchObject({ code: "invalid_transition" });
      expect(h.database.prepare("SELECT count(*) AS count FROM direct_input_receipts").get()).toEqual({ count: 2 });
    } finally { await h.close(); }
  });

  it("enforces a UTF-8 byte bound, queue-only intent, and server-owned metadata on both request shapes", () => {
    const page = { pageId: randomUUID(), revision: 1 };
    const input = { ...request("é".repeat(PAGE_RESPONSE_MAX_BYTES / 2)), pageResponse: page };
    expect(directInputRequestSchema.safeParse(input).success).toBe(true);
    expect(directInputRequestSchema.safeParse({ ...input, text: input.text + "é" }).success).toBe(false);
    expect(directInputRequestSchema.safeParse({ ...input, pageResponse: { ...page, title: "Forged" } }).success).toBe(false);
    expect(directInputRequestSchema.safeParse({ ...input, runningPolicy: { mode: "steer", target: { kind: "conversation" }, onUnavailable: "queue" } }).success).toBe(false);
    const { origin: _origin, ...body } = input;
    expect(directInputRequestBodySchema.safeParse(body).success).toBe(true);
    expect(directInputRequestBodySchema.safeParse(input).success).toBe(false);
    expect(directInputRequestBodySchema.safeParse({ ...body, text: " \n\t" }).success).toBe(false);
    expect(directInputRequestBodySchema.safeParse({ ...body, text: input.text + "é" }).success).toBe(false);
  });
});
