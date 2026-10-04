import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  normalizedApplicationSessionSchema,
  normalizedThreadSnapshotSchema,
} from "../../src/shared/index.js";
import {
  directInputReceiptSchema,
  threadInputContextSchema,
  type DirectInputRequest,
} from "../../src/shared/protocol/thread-input.js";
import { expect, test } from "./fixtures";
import {
  capture,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  selectCustomNewThreadTarget,
  sendCurrentDraft,
} from "./helpers";

async function createBoundCodexThread(page: Page): Promise<string> {
  await openSedesWorkspace(page);
  await page
    .getByTestId("desktop-sidebar")
    .getByTestId("new-thread-trigger")
    .click();
  await selectCustomNewThreadTarget(page, "Codex TCP external · Codex TCP");
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
  const threadId = new URL(page.url()).pathname.split("/").at(-1)!;
  await fillAndPersistDraft(page, "Prepare this thread for spoken input.", "Message Codex");
  await sendCurrentDraft(page);
  await expect(
    page.locator('[data-item-kind="assistant_message"][data-item-status="completed"]'),
  ).toContainText("Codex is streaming a browser-neutral normalized response.");
  return threadId;
}

test.afterEach(async ({ request }) => {
  for (const gate of ["submit-materialization", "steer-materialization"]) {
    expect((await request.post(`/__e2e/codex/${gate}/reset`)).status()).toBe(204);
  }
});

test("idle direct input becomes one complete transcript message while active queue and steer retain their cards", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const threadId = await createBoundCodexThread(page);
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  const retainedDraft = "Keep this separate draft while I speak.";
  await fillAndPersistDraft(page, retainedDraft, "Message Codex");
  const session = normalizedApplicationSessionSchema.parse(
    await (await page.request.get("/api/application/session")).json(),
  );
  const registration = await page.request.post("/api/client-registration", { headers: { "X-CSRF-Token": session.csrfToken },
    data: { platform: "android", capabilities: { navigate: true, voice: true, voiceSettings: true },
      state: { runtime: { foreground: true, voiceReady: false, interactionActive: false }, settings: null } } });
  expect(registration.ok(), await registration.text()).toBe(true);
  const { connectionToken } = await registration.json();
  const submit = async (text: string, runningPolicy: DirectInputRequest["runningPolicy"]) => {
    const response = await page.request.post(`/api/threads/${threadId}/inputs`, {
      headers: { "X-CSRF-Token": session.csrfToken, "X-Sedes-Client": connectionToken },
      data: { mutationId: randomUUID(), text, runningPolicy },
    });
    expect(response.status(), await response.text()).toBe(200);
    return directInputReceiptSchema.parse(await response.json());
  };
  const inputContext = async () => {
    const response = await page.request.get(`/api/threads/${threadId}/input-context`);
    expect(response.status()).toBe(200);
    return threadInputContextSchema.parse(await response.json());
  };
  const snapshot = async () => {
    const response = await page.request.get(`/api/threads/${threadId}?activityDetail=full`);
    expect(response.status()).toBe(200);
    return normalizedThreadSnapshotSchema.parse(await response.json());
  };
  await expect.poll(async () => (await inputContext()).runState).toBe("idle");
  expect((await snapshot()).thread.backingState).toBe("bound");
  expect(
    (await page.request.post("/__e2e/codex/submit-materialization/arm")).status(),
  ).toBe(204);

  // Long enough to cross the queue's preview limit: the browser must load the
  // complete normalized content without ever borrowing the separate draft.
  const spokenText = [
    "Please review the deployment notes and describe the remaining verification steps.",
    "Keep the existing working draft available so I can finish editing it after this spoken request.",
    "Include the café migration, Unicode handling, and a clear explanation of how we will confirm the release.",
    "This final sentence must remain visible beyond the abbreviated queue preview.",
  ].join(" ");
  expect(new TextEncoder().encode(spokenText).byteLength).toBeGreaterThan(240);
  const receipt = await submit(spokenText, { mode: "queue" });
  expect(receipt.admittedMode).toBe("submit");
  const messages = page.getByRole("region", { name: "Messages" });
  const message = messages.locator(
    `[data-message-role="user"][data-delivery-operation-id="${receipt.operationId}"]`,
  );
  const strip = page.getByRole("region", { name: "Pending inputs" });
  await expect(message).toHaveCount(1);
  await expect(message).toHaveAttribute("data-client-provisional", "true");
  await expect(message).toContainText(spokenText);
  await expect(message.locator("[data-submission-phase]")).toHaveCount(0);
  await expect(composer).toHaveValue(retainedDraft);
  await expect(strip).toHaveCount(0);
  await expect.poll(async () => {
    const response = await page.request.get("/__e2e/codex/submit-materialization/state");
    return (await response.json()).held;
  }).toBe(true);

  // Acceptance removes the queue row before the provider publishes its user
  // item. That absence must preserve the one already displayed message.
  await expect.poll(async () => (await snapshot()).queue.length).toBe(0);
  expect(Object.values((await snapshot()).itemsById).some(
    (item) => item.kind === "user_message" && item.deliveryOperationId === receipt.operationId,
  )).toBe(false);
  await expect(message).toHaveCount(1);
  await expect(message).toHaveAttribute("data-client-provisional", "true");
  await expect(message).toContainText(spokenText);
  await expect(message.locator("[data-submission-phase]")).toHaveCount(0);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "direct-input-pending-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(message).toBeVisible();
  await expect(strip).toHaveCount(0);
  await expect(composer).toHaveValue(retainedDraft);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "direct-input-pending-mobile.png");

  // The same API still represents genuinely queued or steering input in the
  // strip while this turn is active.
  await expect.poll(async () => (await inputContext()).runState).toBe("running");
  const queuedText = "Queue this spoken follow-up until the current turn finishes.";
  const queued = await submit(queuedText, { mode: "queue" });
  expect(queued.admittedMode).toBe("queue");
  const queuedRow = strip.locator(`[data-queued-input-id="${queued.queuedInputId}"]`);
  await expect(queuedRow).toContainText(queuedText);
  await expect(messages.locator(`[data-delivery-operation-id="${queued.operationId}"]`)).toHaveCount(0);
  await expect(composer).toHaveValue(retainedDraft);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "direct-input-active-queue-mobile.png");
  // An ordinary queued input ahead would correctly make Steer unavailable.
  await queuedRow.getByRole("button", { name: `Delete queued input: ${queuedText}` }).click();
  await expect(queuedRow).toHaveCount(0);

  expect(
    (await page.request.post(`/__e2e/codex/steer-materialization/arm/${threadId}`)).status(),
  ).toBe(204);
  const context = await inputContext();
  if (context.steer.availability !== "available") throw new Error("e2e_direct_input_steer_unavailable");
  const steerText = "Steer this spoken correction into the active response.";
  const steered = await submit(steerText, {
    mode: "steer", target: context.steer.target, onUnavailable: "queue",
  });
  expect(steered.admittedMode).toBe("steer");
  const steerRow = strip.locator(`[data-queued-input-id="${steered.queuedInputId}"]`);
  await expect(steerRow).toContainText(steerText);
  await expect.poll(async () => {
    const response = await page.request.get("/__e2e/codex/steer-materialization/state");
    return (await response.json()).heldCount;
  }).toBe(1);
  await expect(messages.locator(`[data-delivery-operation-id="${steered.operationId}"]`)).toHaveCount(0);
  await expect(composer).toHaveValue(retainedDraft);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "direct-input-active-steer-mobile.png");

  expect(
    (await page.request.post("/__e2e/codex/submit-materialization/release")).status(),
  ).toBe(204);
  await expect(message).not.toHaveAttribute("data-client-provisional");
  await expect(message).toHaveCount(1);
  await expect(message).toContainText(spokenText);
  expect(
    (await page.request.post("/__e2e/codex/steer-materialization/release")).status(),
  ).toBe(204);
  await expect(steerRow).toHaveCount(0);
  await expect(messages.locator(`[data-delivery-operation-id="${steered.operationId}"]`)).toHaveCount(1);
  await expect.poll(async () => (await inputContext()).runState).toBe("idle");
  await expect(message).toHaveCount(1);
  await expect(messages.locator('[data-client-provisional="true"]')).toHaveCount(0);
  await expect(strip).toHaveCount(0);
  await expect(composer).toHaveValue(retainedDraft);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "direct-input-materialized-mobile.png");
});
