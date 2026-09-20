import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { capture, createDraftThread, expectNoPageOverflow, openWorkspaceDirectory } from "./helpers";
import { workpadSchema } from "../../src/shared/protocol/workpads.js";

const workspace = path.resolve(import.meta.dirname, "fixtures/workpad-workspace");
const original = "# Authentication integration\n\nUse a 30-minute timeout.\n\n## Open questions\n\nKeep the legacy endpoint during rollout.\n";
const revised = "# Authentication integration\n\nUse a 15-minute timeout.\n\n## Decision\n\nShip the new endpoint.\n";

async function readWorkpad(page: Page, id: string) {
  const response = await page.request.get(`/api/workpads/${id}`);
  expect(response.ok()).toBe(true);
  return workpadSchema.parse((await response.json()).workpad);
}

// One state chain: later assertions deliberately inspect the revisions and draft
// produced by earlier edits, across clients and viewport sizes.
test("Workpads retain attributed history, reconcile shared drafts, and move between scopes", async ({ page, browser, browserDiagnostics }, testInfo) => {
  const workpadEvents: Array<{ workpadId: string; revision: number; change: "document" | "draft" }> = [];
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  network.on("Network.eventSourceMessageReceived", message => {
    if (message.eventName !== "application") return;
    const envelope = JSON.parse(message.data) as { event: { type: string; workpadId: string; revision: number; change: "document" | "draft" } };
    if (envelope.event.type === "workpad_changed") workpadEvents.push(envelope.event);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const threadPath = await createDraftThread(page);
  const threadId = threadPath.split("/").at(-1)!;
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  const workpadsMenuItem = page.getByRole("menuitem", { name: "Workpads", exact: true });
  await expect(workpadsMenuItem).toHaveAttribute("aria-description", "Closed");
  await workpadsMenuItem.click();
  const panel = page.getByRole("region", { name: "Workpads", exact: true });
  const pane = page.locator('[data-panel-instance-id="workpads"]');
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("Workpads");
  await page.reload();
  await expect(panel).toBeVisible();
  const chatPane = page.locator('[data-panel-instance-id="chat"]');
  await expect(chatPane).toBeVisible();
  await expect.poll(async () => {
    const [chat, workpads] = await Promise.all([chatPane.boundingBox(), pane.boundingBox()]);
    return Boolean(chat && workpads && chat.x + chat.width <= workpads.x + 1);
  }).toBe(true);
  expect(await panel.evaluate(element => getComputedStyle(element).position)).not.toBe("fixed");
  await panel.getByRole("radio", { name: "Thread", exact: true }).click();
  await panel.getByRole("button", { name: "New workpad", exact: true }).click();
  await panel.getByRole("textbox", { name: "Title", exact: true }).fill("Authentication integration");
  const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/workpads" && response.ok());
  await panel.getByRole("button", { name: "Create workpad", exact: true }).click();
  const workpad = workpadSchema.parse((await (await created).json()).workpad);
  const agentEdit = await page.request.post(`/__e2e/workpads/${workpad.id}/agent-edit/${threadId}`, {
    data: { expectedRevision: workpad.revision, edit: { kind: "replace", content: original } },
  });
  expect(agentEdit.ok()).toBe(true);
  const agentRevision = workpadSchema.parse(await agentEdit.json());
  await expect.poll(() => workpadEvents.some(event => event.workpadId === workpad.id && event.revision === agentRevision.revision && event.change === "document")).toBe(true);
  // The open viewer adopts the pushed change without focus or navigation.
  await expect(panel.locator(".workpad-document")).toContainText("30-minute timeout");

  browserDiagnostics.allowNetworkFailures = true; // Intentional offline/reconnect.
  await page.context().setOffline(true);
  try {
    const offlineEdit = await page.request.post(`/__e2e/workpads/${workpad.id}/agent-edit/${threadId}`, {
      data: { expectedRevision: agentRevision.revision, edit: { kind: "append", text: "\nRecovered after reconnect.\n" } },
    });
    expect(offlineEdit.ok()).toBe(true);
    await expect(panel.locator(".workpad-document")).not.toContainText("Recovered after reconnect.");
  } finally { await page.context().setOffline(false); }
  await expect(panel.locator(".workpad-document")).toContainText("Recovered after reconnect.", { timeout: 12_000 });
  browserDiagnostics.allowNetworkFailures = false;
  await panel.getByRole("button", { name: "Edit workpad", exact: true }).click();
  const editor = panel.getByRole("textbox", { name: "Workpad content", exact: true });
  await editor.fill(revised);
  await panel.getByRole("button", { name: "Save workpad", exact: true }).click();
  await expect(panel.locator(".workpad-document")).toContainText("15-minute timeout");
  await expect(panel.locator(".workpad-document")).not.toContainText("legacy endpoint");
  const saved = await readWorkpad(page, workpad.id);
  expect(saved.attribution.some(span => span.author.kind === "agent")).toBe(true);
  expect(saved.attribution.some(span => span.author.kind === "user")).toBe(true);
  await panel.evaluate(node => { (window as typeof window & { __retainedWorkpad?: Element }).__retainedWorkpad = node; });
  const secondThreadPath = await createDraftThread(page);
  expect(secondThreadPath).not.toBe(threadPath);
  await expect(panel.locator(".workpad-document")).toContainText("15-minute timeout");
  expect(await panel.evaluate(node => (window as typeof window & { __retainedWorkpad?: Element }).__retainedWorkpad === node)).toBe(true);
  await expect(page.getByTestId("workspace-workbench-bar").getByRole("button", { name: "Open Workpads panel", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(threadPath);
  await expect(panel.locator(".workpad-document")).toContainText("15-minute timeout");
  await page.getByRole("button", { name: "Workpads panel actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Dock bottom", exact: true }).click();
  await expect.poll(async () => {
    const [chat, workpads] = await Promise.all([chatPane.boundingBox(), pane.boundingBox()]);
    return Boolean(chat && workpads && chat.y + chat.height <= workpads.y + 1);
  }).toBe(true);
  await page.getByRole("button", { name: "Workpads panel actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Dock right", exact: true }).click();
  await page.getByRole("button", { name: "Collapse Workpads panel", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByTestId("workspace-workbench-bar").getByRole("button", { name: "Open Workpads panel", exact: true }).click();
  await expect(panel.locator(".workpad-document")).toContainText("15-minute timeout");
  await panel.getByRole("button", { name: "Show attribution", exact: true }).click();
  const marks = panel.locator("[data-workpad-attribution]");
  await expect(marks.first()).toBeVisible();
  await expect(marks.first()).toHaveCSS("user-select", "text");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await marks.first().dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBeTruthy();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await marks.first().click();
  await expect(page.getByRole("status", { name: "Attribution details" })).toBeVisible();
  await capture(page, testInfo, "workpads-desktop-attribution.png");
  await panel.getByRole("button", { name: "Previous revision", exact: true }).click();
  await expect(panel.locator(".workpad-document")).toContainText("30-minute timeout");
  await expect(panel.locator(".workpad-document")).toContainText("legacy endpoint");
  await panel.getByRole("button", { name: "Next revision", exact: true }).click();
  await panel.getByText("Revision details", { exact: true }).click();
  await expect(panel).toContainText("Removed");
  await capture(page, testInfo, "workpads-revision-details.png");
  await panel.getByText("Revision details", { exact: true }).click();

  // Autosaved working drafts sync without adding committed revisions.
  await panel.getByRole("button", { name: "Edit workpad", exact: true }).click();
  const draftText = `${revised}\nUser verification in progress.\n`;
  const synced = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/workpads/${workpad.id}/draft`) && response.ok());
  await editor.fill(draftText);
  await synced;
  expect((await readWorkpad(page, workpad.id)).revision).toBe(saved.revision);
  const otherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const other = await otherContext.newPage();
  try {
    await other.goto(page.url());
    await other.getByRole("button", { name: "Panels", exact: true }).click();
    await other.getByRole("menuitem", { name: "Workpads", exact: true }).click();
    const otherPanel = other.getByRole("region", { name: "Workpads", exact: true });
    await otherPanel.getByRole("radio", { name: "Thread", exact: true }).click();
    await otherPanel.getByRole("button", { name: /^Authentication integration/ }).click();
    await otherPanel.getByRole("button", { name: "Edit workpad", exact: true }).click();
    await expect(otherPanel.getByRole("textbox", { name: "Workpad content", exact: true })).toHaveValue(draftText);
    // A clean editor on another device adopts draft pushes while left open.
    for (const text of [`${draftText}Shared draft update.\n`, draftText]) {
      const pushedDraft = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/workpads/${workpad.id}/draft`) && response.ok());
      await editor.fill(text);
      await pushedDraft;
      await expect(otherPanel.getByRole("textbox", { name: "Workpad content", exact: true })).toHaveValue(text);
    }
    // Hold this client's real draft save until the other device commits its
    // version, deterministically exercising CAS without replacing a response.
    let releaseDraft!: () => void;
    let draftStarted!: () => void;
    const draftHeld = new Promise<void>(resolve => { draftStarted = resolve; });
    const draftRelease = new Promise<void>(resolve => { releaseDraft = resolve; });
    const draftRoute = `**/api/workpads/${workpad.id}/draft`;
    await page.route(draftRoute, async route => {
      if (route.request().method() === "PUT") {
        draftStarted();
        await draftRelease;
      }
      await route.continue();
    });
    await editor.fill(`${draftText}Local device note.\n`);
    await draftHeld;
    await page.goForward();
    await expect(page).toHaveURL(secondThreadPath);
    await expect(editor).toHaveValue(`${draftText}Local device note.\n`);
    expect(await panel.evaluate(node => (window as typeof window & { __retainedWorkpad?: Element }).__retainedWorkpad === node)).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(threadPath);
    await expect(editor).toHaveValue(`${draftText}Local device note.\n`);
    const otherSynced = other.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/workpads/${workpad.id}/draft`) && response.ok());
    await otherPanel.getByRole("textbox", { name: "Workpad content", exact: true }).fill(`${draftText}Other device note.\n`);
    const otherDraftRevision = ((await (await otherSynced).json()) as { draft: { revision: number } }).draft.revision;
    await expect.poll(() => workpadEvents.some(event => event.workpadId === workpad.id && event.revision === otherDraftRevision && event.change === "draft")).toBe(true);
    browserDiagnostics.allowNetworkFailures = true; // Expected stale draft HTTP 409.
    const draftRejected = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/workpads/${workpad.id}/draft`) && response.status() === 409);
    releaseDraft();
    await draftRejected;
    // Keep the released pass-through handler until context cleanup. Removing
    // interception here can strand the concurrent conflict-recovery GET.
    await expect(panel).toContainText("This draft changed on another device.");
    await expect(editor).toHaveValue(`${draftText}Local device note.\n`);
    // Browser/Android Back uses popstate rather than navigate(). A held draft
    // conflict must still block leaving the workbench when the user cancels.
    await page.goBack();
    const leaveWorkpad = page.getByRole("dialog", { name: "Leave unsynced workpad?", exact: true });
    await expect(leaveWorkpad).toBeVisible();
    await expect(leaveWorkpad).toContainText("Your latest workpad draft changes have not synced. Leave anyway?");
    await leaveWorkpad.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(leaveWorkpad).toBeHidden();
    await expect(page).toHaveURL(threadPath);
    await expect(editor).toHaveValue(`${draftText}Local device note.\n`);
    expect(await panel.evaluate(node => (window as typeof window & { __retainedWorkpad?: Element }).__retainedWorkpad === node)).toBe(true);
    await panel.getByRole("button", { name: "Use latest draft", exact: true }).click();
    await expect(editor).toHaveValue(`${draftText}Other device note.\n`);
    browserDiagnostics.allowNetworkFailures = false;
    const resetSynced = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/workpads/${workpad.id}/draft`) && response.ok());
    await editor.fill(draftText);
    await resetSynced;
    const agentUpdate = await page.request.post(`/__e2e/workpads/${workpad.id}/agent-edit/${threadId}`, {
      data: { expectedRevision: saved.revision, edit: { kind: "append", text: "\nAgent verified the endpoint.\n" } },
    });
    expect(agentUpdate.ok()).toBe(true);
    await expect(editor).toHaveValue(draftText);
    await expect(panel).toContainText("The document changed. Review the latest version before saving.", { timeout: 15_000 });
    await expect(panel).not.toContainText("This draft changed on another device.");
    await capture(page, testInfo, "workpads-draft-conflict.png");
  } finally { await otherContext.close(); }
  await expect(panel.getByRole("button", { name: "Save workpad", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(panel.getByText("Agent verified the endpoint.", { exact: false })).toBeVisible();
  const reconciled = `${draftText}\nAgent verified the endpoint.\n`;
  await editor.fill(reconciled);
  await panel.getByRole("button", { name: "Use my reconciled text", exact: true }).click();
  await panel.getByRole("button", { name: "Save workpad", exact: true }).click();
  await expect(panel.locator(".workpad-document")).toContainText("User verification in progress.");
  await expect(panel.locator(".workpad-document")).toContainText("Agent verified the endpoint.");
  expect((await readWorkpad(page, workpad.id)).content).toBe(reconciled);
  expect(agentRevision.revision).toBeLessThan(saved.revision);

  await panel.getByRole("button", { name: "Move workpad", exact: true }).click();
  await panel.getByRole("radiogroup", { name: "Destination scope" }).getByRole("radio", { name: "Project", exact: true }).click();
  await panel.getByRole("button", { name: "Move", exact: true }).click();
  await expect.poll(async () => (await readWorkpad(page, workpad.id)).scope.kind).toBe("workspace");
  await panel.getByRole("button", { name: "Back to workpads", exact: true }).click();
  await expect(panel.getByRole("button", { name: /^Authentication integration/ })).toHaveCount(0);
  await panel.getByRole("radio", { name: "Project", exact: true }).click();
  await panel.getByRole("button", { name: /^Authentication integration/ }).click();
  await panel.getByRole("button", { name: "Archive workpad", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Restore workpad", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Back to workpads", exact: true }).click();
  await expect(panel.getByRole("button", { name: /^Authentication integration/ })).toHaveCount(0);
  await panel.getByRole("checkbox", { name: "Archived", exact: true }).check();
  await panel.getByRole("button", { name: /^Authentication integration/ }).click();
  await panel.getByRole("button", { name: "Restore workpad", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Archive workpad", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  await expectNoPageOverflow(page);
  await expect(marks.first()).toHaveCSS("user-select", "text");
  await capture(page, testInfo, "workpads-mobile-attribution.png");
  await panel.getByRole("button", { name: "Show attribution", exact: true }).click();
  await expect(panel.locator("[data-workpad-attribution]")).toHaveCount(0);
  await expect(panel.locator(".workpad-document")).toContainText("Agent verified the endpoint.");
  await capture(page, testInfo, "workpads-mobile-clean.png");
  await panel.getByRole("button", { name: "Edit workpad", exact: true }).click();
  await editor.focus();
  // A reduced mobile viewport uses the same full-stage layout as Files and
  // Chat; Workpads must keep its editor and actions inside that stage.
  await page.setViewportSize({ width: 390, height: 544 });
  await expect(pane).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(panel.getByRole("button", { name: "Save workpad", exact: true })).toBeInViewport();
  await expect(page.getByTestId("workspace-workbench-bar")).toBeInViewport();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "workpads-mobile-keyboard.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("button", { name: "Done editing", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Edit workpad", exact: true })).toBeVisible();
  let idleWorkpadReads = 0;
  const countIdleReads = (request: import("@playwright/test").Request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname.startsWith("/api/workpads")) idleWorkpadReads += 1;
  };
  page.on("request", countIdleReads);
  // Absence is the behavior under test: exceed the former five-second list
  // polling period while leaving the document open and the browser online.
  await page.waitForTimeout(5_500);
  page.off("request", countIdleReads);
  expect(idleWorkpadReads).toBe(0);
  await page.getByRole("button", { name: "Close Workpads panel", exact: true }).click();
  await expect(panel).toHaveCount(0);
});
