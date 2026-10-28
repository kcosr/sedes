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
import { largeDirectInputText } from "../support/large-direct-input.js";
import { installVoiceFixture } from "./voice-controls-fixture.js";
import {
  capture,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  selectCustomNewThreadTarget,
  sendCurrentDraft,
} from "./helpers";

declare global {
  interface Window {
    __directInputPresentations: string[];
    __observerInputPresentations: {
      stripInsertions: number;
      messages: { count: number; state: string | null; text: string }[];
      stop(): void;
    };
  }
}

async function createBoundCodexThread(
  page: Page,
  initialText = "Prepare this thread for spoken input.",
): Promise<string> {
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
  await fillAndPersistDraft(page, initialText, "Message Codex");
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
  await installVoiceFixture(page);
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
  // Queue traffic can precede the local native receipt. Hold its scoped full
  // content read so this checks the first DOM presentation, not eventual hydration.
  let detailReadEntered = false;
  let releaseDetail!: () => void;
  const detailGate = new Promise<void>(resolve => { releaseDetail = resolve; });
  const detailPattern = `**/api/threads/${threadId}/queued-inputs/*`;
  const holdDetail: Parameters<Page["route"]>[1] = async route => {
    detailReadEntered = true;
    await detailGate;
    await route.continue();
  };
  await page.route(detailPattern, holdDetail);
  await page.evaluate(() => {
    const observed: string[] = [];
    window.__directInputPresentations = observed;
    new MutationObserver(() => {
      // Loading placeholders do not claim to contain the submitted message.
      for (const message of document.querySelectorAll('[data-client-provisional="true"][data-message-role="user"]:not([data-submission-content-state])')) {
        const text = message.querySelector(".message-row.user .message-body")?.textContent ?? "";
        if (observed.at(-1) !== text) observed.push(text);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const receipt = await submit(spokenText, { mode: "queue" });
  expect(receipt.admittedMode).toBe("submit");
  const messages = page.getByRole("region", { name: "Messages" });
  const message = messages.locator(
    `[data-message-role="user"][data-delivery-operation-id="${receipt.operationId}"]`,
  );
  const strip = page.getByRole("region", { name: "Pending inputs" });
  try {
    await expect.poll(() => detailReadEntered).toBe(true);
    await expect(message).toHaveCount(1);
    await expect(message).toHaveAttribute("data-submission-content-state", "loading");
    await expect(strip).toHaveCount(0);
    await page.evaluate(({ threadId, operationId, queuedInputId, text }) => {
      const { profileId, serverOrigin, identity, connectionGeneration } = window.__voiceFixture.state;
      window.__voiceFixture.emitInputSubmitted({ profileId: profileId!, serverOrigin: serverOrigin!, identity: identity!,
        connectionGeneration, threadId, operationId, queuedInputId, text });
    }, { threadId, operationId: receipt.operationId, queuedInputId: receipt.queuedInputId ?? null, text: spokenText });
    await expect(message).toHaveCount(1);
    await expect(message).toContainText(spokenText);
    await expect(message.locator("[data-submission-phase]")).toHaveCount(0);
    const presentations = await page.evaluate(() => window.__directInputPresentations);
    expect(presentations.length).toBeGreaterThan(0);
    expect(presentations).toEqual([spokenText]);
  } finally {
    releaseDetail();
    await page.unroute(detailPattern, holdDetail);
  }
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
  const queuedText = largeDirectInputText;
  const queued = await submit(queuedText, { mode: "queue" });
  expect(queued.admittedMode).toBe("queue");
  const queuedRow = strip.locator(`[data-queued-input-id="${queued.queuedInputId}"]`);
  await expect(queuedRow).toContainText("Recording transcript:");
  await expect(messages.locator(`[data-delivery-operation-id="${queued.operationId}"]`)).toHaveCount(0);
  await expect(composer).toHaveValue(retainedDraft);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  // The transcript now fits the shared composer limit. Restore remains fenced
  // by the occupied independent draft; Copy must still preserve both inputs.
  const restore = queuedRow.getByRole("button", { name: /^Restore queued input to composer:/ });
  await expect(restore).toBeDisabled();
  await expect(restore).toHaveAttribute("title", "Clear the composer before restoring a queued input.");
  await queuedRow.getByRole("button", { name: /^Copy full text:/ }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(queuedText);
  await expect(queuedRow.getByRole("button", { name: /^Copied full text:/ })).toBeVisible();
  await expect(composer).toHaveValue(retainedDraft);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "direct-input-active-queue-mobile.png");
  // An ordinary queued input ahead would correctly make Steer unavailable.
  await queuedRow.getByRole("button", { name: /^Delete queued input:/ }).click();
  await expect(queuedRow).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });

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

test("another device's idle input stays in the transcript while its full content loads without seeking the observer", async ({
  page,
}, testInfo) => {
  // The observer has Seek on send enabled, but receives no native submission
  // callback or composer transfer for the other registered device's send.
  await page.addInitScript(() => localStorage.setItem("sedes-seek-on-submit", "true"));
  await page.setViewportSize({ width: 1280, height: 800 });
  const initialText = Array.from({ length: 24 }, (_, index) =>
    `Earlier deployment note ${index + 1}: keep this part of the conversation available while reading.`,
  ).join("\n\n");
  const threadId = await createBoundCodexThread(page, initialText);
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  const retainedDraft = "The observing device's separate unfinished draft.";
  await fillAndPersistDraft(page, retainedDraft, "Message Codex");
  const session = normalizedApplicationSessionSchema.parse(
    await (await page.request.get("/api/application/session")).json(),
  );
  const registration = await page.request.post("/api/client-registration", {
    headers: { "X-CSRF-Token": session.csrfToken },
    data: {
      platform: "android", capabilities: { navigate: true, voice: true, voiceSettings: true },
      state: { runtime: { foreground: true, voiceReady: false, interactionActive: false }, settings: null },
    },
  });
  expect(registration.ok(), await registration.text()).toBe(true);
  const { connectionToken } = await registration.json();
  await expect.poll(async () => threadInputContextSchema.parse(
    await (await page.request.get(`/api/threads/${threadId}/input-context`)).json(),
  ).runState).toBe("idle");

  const messages = page.getByRole("region", { name: "Messages" });
  await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200);
  await messages.press("Home");
  await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBe(0);
  const operationId = randomUUID();
  const spokenText = [
    "This message was spoken on another device while the desktop reader was reviewing older notes.",
    "Preserve the observer's draft and reading position while the full recognized text is loading.",
    "The café deployment and Unicode details belong to this one exact submitted message.",
    "This final sentence must appear in full after the abbreviated queue preview would have ended.",
  ].join(" ");
  expect(new TextEncoder().encode(spokenText).byteLength).toBeGreaterThan(240);
  await page.getByTestId("thread-view").evaluate((scope, operationId) => {
    const messageSelector = `[data-message-role="user"][data-delivery-operation-id="${operationId}"]`;
    const stripSelector = `[data-queued-input-id][data-delivery-operation-id="${operationId}"]`;
    const observed: Window["__observerInputPresentations"] = {
      stripInsertions: 0, messages: [], stop: () => observer.disconnect(),
    };
    const observer = new MutationObserver(records => {
      // Inspect added nodes as well as the current tree so a short-lived queue
      // row cannot escape the assertion by disappearing before a later poll.
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          observed.stripInsertions += Number(node.matches(stripSelector)) + node.querySelectorAll(stripSelector).length;
        }
      }
      const rows = scope.querySelectorAll(messageSelector);
      // Ignore the initial interval before admission, then retain every absence
      // so a disappearing and reappearing message cannot pass as continuous.
      if (rows.length === 0 && observed.messages.length === 0) return;
      const next = {
        count: rows.length,
        state: rows[0]?.getAttribute("data-submission-content-state") ?? null,
        text: rows[0]?.querySelector(".message-row.user .message-body")?.textContent ?? "",
      };
      if (JSON.stringify(observed.messages.at(-1)) !== JSON.stringify(next)) observed.messages.push(next);
    });
    window.__observerInputPresentations = observed;
    observer.observe(scope, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["data-submission-content-state", "data-client-provisional"] });
  }, operationId);

  let detailReadEntered = false;
  let releaseDetail!: () => void;
  const detailGate = new Promise<void>(resolve => { releaseDetail = resolve; });
  const detailPattern = `**/api/threads/${threadId}/queued-inputs/*`;
  const holdDetail: Parameters<Page["route"]>[1] = async route => {
    detailReadEntered = true;
    await detailGate;
    await route.continue();
  };
  await page.route(detailPattern, holdDetail);
  expect((await page.request.post("/__e2e/codex/submit-materialization/arm")).status()).toBe(204);
  const message = messages.locator(`[data-message-role="user"][data-delivery-operation-id="${operationId}"]`);
  const strip = page.getByRole("region", { name: "Pending inputs" });
  try {
    const response = await page.request.post(`/api/threads/${threadId}/inputs`, {
      headers: { "X-CSRF-Token": session.csrfToken, "X-Sedes-Client": connectionToken },
      data: { mutationId: operationId, text: spokenText, runningPolicy: { mode: "queue" } },
    });
    expect(response.status(), await response.text()).toBe(200);
    const receipt = directInputReceiptSchema.parse(await response.json());
    expect(receipt).toMatchObject({ admittedMode: "submit", operationId });
    await expect.poll(() => detailReadEntered).toBe(true);
    await expect(message).toHaveCount(1);
    await expect(message).toHaveAttribute("data-submission-content-state", "loading");
    await expect(message.getByRole("status")).toHaveText("Loading message…");
    await expect(message.locator(".message-row.user")).toHaveAttribute("aria-busy", "true");
    await expect(message).not.toContainText(spokenText.slice(0, 100));
    await expect(message.getByRole("button")).toHaveCount(0);
    await expect(strip).toHaveCount(0);
    await expect(composer).toHaveValue(retainedDraft);
    await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBe(0);

    // Acceptance removes the durable queue row before canonical history exists.
    // The observer must retain its one loading entry through that interval.
    await expect.poll(async () => normalizedThreadSnapshotSchema.parse(
      await (await page.request.get(`/api/threads/${threadId}?activityDetail=full`)).json(),
    ).queue.length).toBe(0);
    await expect.poll(async () => (await (await page.request.get("/__e2e/codex/submit-materialization/state")).json()).held).toBe(true);
    await expect(message).toHaveAttribute("data-submission-content-state", "loading");
    await message.scrollIntoViewIfNeeded();
    await capture(page, testInfo, "direct-input-observer-loading-desktop.png");
    await messages.press("Home");
    await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBe(0);
    releaseDetail();
    await expect(message).not.toHaveAttribute("data-submission-content-state");
    await expect(message).toHaveCount(1);
    await expect(message).toHaveAttribute("data-client-provisional", "true");
    await expect(message).toContainText(spokenText);
    await expect(message.getByRole("status")).toHaveCount(0);
    await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBe(0);
    await expect(composer).toHaveValue(retainedDraft);
    await expect(strip).toHaveCount(0);
    await message.scrollIntoViewIfNeeded();
    await capture(page, testInfo, "direct-input-observer-in-flight-desktop.png");

    expect((await page.request.post("/__e2e/codex/submit-materialization/release")).status()).toBe(204);
    await expect(message).not.toHaveAttribute("data-client-provisional");
    await expect(message).toHaveCount(1);
    await expect(message).toContainText(spokenText);
    await expect(composer).toHaveValue(retainedDraft);
    await expect(strip).toHaveCount(0);
    const presentations = await page.evaluate(() => {
      const { stripInsertions, messages } = window.__observerInputPresentations;
      return { stripInsertions, messages };
    });
    expect(presentations.stripInsertions).toBe(0);
    expect(presentations.messages[0]).toEqual({ count: 1, state: "loading", text: "Loading message…" });
    for (const presentation of presentations.messages) {
      expect(presentation.count).toBe(1);
      if (presentation.state !== null) {
        expect(presentation).toEqual({ count: 1, state: "loading", text: "Loading message…" });
      }
    }
    expect(presentations.messages.filter(({ state }) => state === null).map(({ text }) => text)).toEqual([spokenText]);
    await expectNoPageOverflow(page);
  } finally {
    releaseDetail();
    await page.unroute(detailPattern, holdDetail);
    await page.evaluate(() => window.__observerInputPresentations?.stop());
  }
});
