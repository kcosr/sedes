import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { queuedInputPresentationSchema } from "../../src/shared/protocol/api.js";
import { pagePublicationResultSchema } from "../../src/shared/protocol/pages.js";
import { directInputReceiptSchema } from "../../src/shared/protocol/thread-input.js";
import { expect, test } from "./fixtures.js";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openWorkspaceDirectory,
  overlaySettled,
  sendCurrentDraft,
} from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";

const title = "Release choices";
const notes = "Keep the canary small.\nPreserve whitespace & Unicode: café 🌍.";
const expectedText = `  Deployment request
Include tests: Yes
Strategy: Canary
Regions: Europe, US East
Notes:
${notes}
Capture: 1
  `;

// The page owns its controls and serialization. The host only requests one
// immutable string when its Send button is clicked.
const formHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;padding:20px;font:16px system-ui;background:#edf4f5;color:#183c43}
  main{max-width:520px;margin:auto;padding:20px;background:white;border:1px solid #c7dcdc;border-radius:14px}
  h1{font-size:24px;margin:0 0 8px}p{margin:8px 0 18px;color:#4b656a}
  fieldset{border:0;padding:0;margin:18px 0}legend{font-weight:600;margin-bottom:10px}
  label{display:block;margin:10px 0}input{accent-color:#187c76}select,textarea{display:block;width:100%;font:inherit;padding:8px;border:1px solid #9bbbbb;border-radius:6px;margin-top:7px}
  textarea{height:90px}output{display:block;margin-top:16px;font-size:13px;color:#4b656a}
  </style></head><body><main><h1>Release choices</h1><p>Choose the rollout and send your response to the conversation.</p>
  <label><input id="tests" type="checkbox"> Include tests</label>
  <fieldset><legend>Strategy</legend><label><input type="radio" name="strategy" value="all" checked> All at once</label>
  <label><input type="radio" name="strategy" value="canary"> Canary</label></fieldset>
  <label>Regions<select id="regions" multiple size="3"><option value="ap-south">Asia Pacific</option><option value="eu-west">Europe</option><option value="us-east">US East</option></select></label>
  <label>Release notes<textarea id="notes"></textarea></label><output id="captures">Captures: 0</output>
  </main><script>
  let captures=0,committedNotes='';
  document.querySelector('#notes').onblur=event=>{committedNotes=event.target.value};
  window.sedes.onSubmit(()=>{
    const includeTests=document.querySelector('#tests').checked?'Yes':'No';
    const strategy=document.querySelector('input[name="strategy"]:checked').value==='canary'?'Canary':'All at once';
    const regions=Array.from(document.querySelector('#regions').selectedOptions,option=>option.textContent).join(', ');
    ++captures;
    document.querySelector('#captures').textContent='Captures: '+captures;
    return '  Deployment request\\nInclude tests: '+includeTests+'\\nStrategy: '+strategy+'\\nRegions: '+regions+'\\nNotes:\\n'+committedNotes+'\\nCapture: '+captures+'\\n  ';
  });
  </script></body></html>`;

function pageCard(page: Page): Locator {
  return page.locator('[data-item-kind="page"]').filter({
    has: page.getByRole("group", { name: title, exact: true }),
  });
}

function pageDocument(container: Locator): FrameLocator {
  return container.frameLocator(".page-frame-document").frameLocator("iframe[data-page-document]");
}

async function fillChoices(frame: FrameLocator): Promise<void> {
  await frame.getByRole("checkbox", { name: "Include tests" }).check();
  await frame.getByRole("radio", { name: "Canary", exact: true }).check();
  await frame.getByRole("listbox", { name: "Regions", exact: true }).selectOption(["eu-west", "us-east"]);
  await frame.getByRole("textbox", { name: "Release notes" }).fill(notes);
}

async function expandPage(page: Page, card: Locator): Promise<Locator> {
  await card.getByRole("button", { name: /^Expand page:/ }).click();
  const dialog = page.getByRole("dialog").filter({ has: page.locator(".page-preview-fullscreen-header") });
  await expect(dialog).toBeVisible();
  await overlaySettled(dialog);
  return dialog;
}

async function snapshot(page: Page, threadPath: string) {
  const response = await page.request.get(`/api${threadPath}?activityDetail=full`);
  expect(response.ok(), await response.text()).toBe(true);
  return normalizedThreadSnapshotSchema.parse(await response.json());
}

test("page responses capture once, queue while busy, and retain exact text and source after reload and fork", async ({ page }, testInfo) => {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "page-responses");
  await mkdir(workspace, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspaceDirectory(page, workspace);
  const threadPath = await createDraftThread(page, "Page response workflow");
  const threadId = threadPath.split("/").at(-1)!;
  expect((await page.request.post("/__e2e/pi/turn-response/arm")).status()).toBe(204);
  await fillAndPersistDraft(page, "Prepare the release choices while this turn stays active.");
  await sendCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  let held = true;
  try {
    const published = await page.request.post(`/__e2e/threads/${threadId}/pages`, {
      data: { title, html: formHtml, viewport: { width: 460, height: 660 } },
    });
    expect(published.ok(), await published.text()).toBe(true);
    const source = pagePublicationResultSchema.parse(await published.json()).page;
    const origin = { kind: "page_response", pageId: source.pageId, revision: 1, title };
    const card = pageCard(page);
    await card.scrollIntoViewIfNeeded();
    const frame = pageDocument(card);
    await expect(frame.getByRole("heading", { name: title })).toBeVisible();
    await card.locator(".page-frame-viewport").click({ position: { x: 20, y: 20 } });
    await fillChoices(frame);
    await expect(frame.locator("#captures")).toHaveText("Captures: 0");

    // Leave a normal draft intact: a page response is a separate direct input.
    const draft = "Keep this unsent composer draft.";
    await fillAndPersistDraft(page, draft);
    const inputAccepted = page.waitForResponse(response => response.request().method() === "POST"
      && response.url().endsWith(`/api/threads/${threadId}/inputs`));
    await card.getByRole("button", { name: "Send page response", exact: true }).click();
    const sent = await inputAccepted;
    expect(sent.ok(), await sent.text()).toBe(true);
    expect(sent.request().postDataJSON()).toMatchObject({
      text: expectedText,
      pageResponse: { pageId: source.pageId, revision: 1 },
      runningPolicy: { mode: "queue" },
    });
    const receipt = directInputReceiptSchema.parse(await sent.json());
    expect(receipt).toMatchObject({ admittedMode: "queue", currentMode: "queue", status: "queued" });
    await expect(page.getByTestId("pending-input-strip").locator(`[data-queued-input-id="${receipt.queuedInputId}"]`)).toBeVisible();
    await expect(frame.locator("#captures")).toHaveText("Captures: 1");
    await expect(page.getByRole("textbox", { name: "Message Scripted agent" })).toHaveValue(draft);

    // Editing controls after Send must not re-capture or change admitted bytes.
    await frame.getByRole("checkbox", { name: "Include tests" }).uncheck();
    await frame.getByRole("radio", { name: "All at once", exact: true }).check();
    await frame.getByRole("listbox", { name: "Regions", exact: true }).selectOption("ap-south");
    await frame.getByRole("textbox", { name: "Release notes" }).fill("Edits made after Send must remain local.");
    await expect(frame.locator("#captures")).toHaveText("Captures: 1");
    const queuedResponse = await page.request.get(`/api${threadPath}/queued-inputs/${receipt.queuedInputId}`);
    expect(queuedResponse.ok(), await queuedResponse.text()).toBe(true);
    const queued = queuedInputPresentationSchema.parse(await queuedResponse.json());
    expect(queued.inputOrigin).toEqual(origin);
    expect(queued.content).toEqual([{ kind: "text", text: { text: expectedText } }]);
    const busy = await snapshot(page, threadPath);
    expect(busy.queue).toHaveLength(1);
    expect(busy.queue[0]).toMatchObject({ inputOrigin: origin, resolvedDeliveryMode: "queue" });
    expect(Object.values(busy.itemsById).filter(item => item.kind === "user_message" && item.origin?.kind === "page_response")).toHaveLength(0);
    await capture(page, testInfo, "page-response-queued-desktop.png");

    expect((await page.request.post("/__e2e/pi/turn-response/release")).status()).toBe(204);
    held = false;
    const responses = page.locator('[data-item-kind="user_message"]').filter({
      has: page.locator('[data-message-origin="page_response"]'),
    });
    await expect(responses).toHaveCount(1, { timeout: 20_000 });
    const response = responses.first();
    const disclosure = response.locator(".page-response-disclosure");
    await response.scrollIntoViewIfNeeded();
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(disclosure.locator("summary")).toContainText("Page response");
    await expect(disclosure.locator("summary")).toContainText(title);
    await expect(disclosure.locator("summary")).toContainText("Revision 1");
    await expect(disclosure.locator(".page-response-text")).toBeHidden();
    await disclosure.locator("summary").click();
    await expect(disclosure.locator(".page-response-text")).toBeVisible();
    expect(await disclosure.locator(".page-response-text").textContent()).toBe(expectedText);
    // The conformance provider streams tools for nine 800ms stages before
    // starting its assistant text, so wait for that specific tenth stage.
    const streaming = page.locator('[data-turn-status="in_progress"] [data-item-kind="assistant_message"][data-item-status="streaming"]');
    await expect(streaming).toBeVisible({ timeout: 12_000 });
    await streaming.scrollIntoViewIfNeeded();
    await capture(page, testInfo, "page-response-streaming-desktop.png");

    // Both completed provider turns, then a cold runtime, exercise durable
    // origin projection rather than relying on the live browser receipt.
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 15_000 });
    await page.goto("/");
    await expect.poll(async () => (await page.request.post(`/__e2e/threads/${threadId}/close-idle-runtime`)).status()).toBe(204);
    await page.goto(threadPath);
    await page.reload();
    await expect(responses).toHaveCount(1);
    await response.scrollIntoViewIfNeeded();
    await expect(disclosure).not.toHaveAttribute("open", "");
    await disclosure.locator("summary").click();
    expect(await disclosure.locator(".page-response-text").textContent()).toBe(expectedText);
    const restored = await snapshot(page, threadPath);
    const restoredResponses = Object.values(restored.itemsById).filter(item => item.kind === "user_message" && item.origin?.kind === "page_response");
    expect(restoredResponses).toHaveLength(1);
    expect(restoredResponses[0]).toMatchObject({ kind: "user_message", origin, content: [{ kind: "text", text: { text: expectedText } }] });
    await page.setViewportSize({ width: 390, height: 844 });
    await response.scrollIntoViewIfNeeded();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "page-response-expanded-phone.png");
    await disclosure.locator("summary").click();
    await capture(page, testInfo, "page-response-compact-phone.png");

    // The page remains usable at idle from the enlarged viewer on a phone.
    await card.scrollIntoViewIfNeeded();
    const viewer = await expandPage(page, card);
    const viewerFrame = pageDocument(viewer);
    await fillChoices(viewerFrame);
    await expect(viewerFrame.locator("#captures")).toHaveText("Captures: 0");
    await capture(page, testInfo, "page-response-form-phone.png");
    const idleAccepted = page.waitForResponse(candidate => candidate.request().method() === "POST"
      && candidate.url().endsWith(`/api/threads/${threadId}/inputs`));
    await viewer.getByRole("button", { name: "Send page response", exact: true }).click();
    const idleSent = await idleAccepted;
    expect(idleSent.ok(), await idleSent.text()).toBe(true);
    expect(idleSent.request().postDataJSON()).toMatchObject({ text: expectedText });
    expect(directInputReceiptSchema.parse(await idleSent.json()).admittedMode).toBe("submit");
    await expect(viewerFrame.locator("#captures")).toHaveText("Captures: 1");
    await viewer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await expect(responses).toHaveCount(2);

    // Fork at the completed response boundary while the new response runs.
    // The native provider copies history; the original response attribution
    // and exact text must survive even though its page is not cloned.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(`[data-turn-id="${restoredResponses[0]!.turnId}"]`)
      .getByRole("button", { name: /Fork from here/ }).click();
    await expect.poll(() => new URL(page.url()).pathname).not.toBe(threadPath);
    await expect(responses).toHaveCount(1);
    await response.scrollIntoViewIfNeeded();
    await expect(disclosure.locator("summary")).toContainText(title);
    await expect(disclosure.locator("summary")).toContainText("Revision 1");
    await disclosure.locator("summary").click();
    expect(await disclosure.locator(".page-response-text").textContent()).toBe(expectedText);
    const childPath = new URL(page.url()).pathname;
    const inputHeaders = idleSent.request().headers();
    expect(inputHeaders["x-sedes-client"]).toBeTruthy();
    expect(inputHeaders["x-csrf-token"]).toBeTruthy();
    const foreignResponse = await page.request.post(`/api${childPath}/inputs`, {
      headers: { "X-Sedes-Client": inputHeaders["x-sedes-client"]!, "X-CSRF-Token": inputHeaders["x-csrf-token"]! },
      data: {
        mutationId: randomUUID(), text: expectedText,
        pageResponse: { pageId: source.pageId, revision: 1 }, runningPolicy: { mode: "queue" },
      },
    });
    expect(foreignResponse.status()).toBe(404);
    expect(await foreignResponse.json()).toMatchObject({ error: { code: "not_found" } });
    expect((await snapshot(page, childPath)).queue).toHaveLength(0);
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "page-response-source-fork-desktop.png");
  } finally {
    // A timed-out test may have already disposed its request context; preserve
    // its original failure while the coordinator tears down this isolated job.
    if (held) await page.request.post("/__e2e/pi/turn-response/release").catch(() => undefined);
  }
});
