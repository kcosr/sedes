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
  // The list's scope has no visible picker any more: the latest list request
  // names the thread or project the panel follows.
  const listQueries: URLSearchParams[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/workpads") listQueries.push(url.searchParams);
  });
  const listedScope = () => {
    const query = listQueries.at(-1);
    return query && { kind: query.get("scopeKind"), threadId: query.get("threadId"), projectId: query.get("projectId") };
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const threadPath = await createDraftThread(page);
  const threadId = threadPath.split("/").at(-1)!;
  const workpadsToggle = page.getByTestId("workpads-panel-toggle");
  await expect(workpadsToggle).toHaveAccessibleName("Open Workpads panel");
  await workpadsToggle.click();
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
  const addRow = panel.getByRole("textbox", { name: "New workpad title", exact: true });
  await expect(addRow).toHaveAttribute("placeholder", "New workpad in this thread…");
  await addRow.fill("Authentication integration");
  const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/workpads" && response.ok());
  await addRow.press("Enter");
  const workpad = workpadSchema.parse((await (await created).json()).workpad);
  // A new workpad opens ready for its first text; leave the editor to watch the viewer.
  const editor = panel.getByRole("textbox", { name: "Workpad content", exact: true });
  await expect(editor).toBeVisible();
  await expect(pane.locator(".workspace-panel-subtitle")).toHaveText("Authentication integration");
  await panel.getByRole("button", { name: "Done editing", exact: true }).click();
  await expect(editor).toHaveCount(0);
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
  await expect.poll(listedScope).toEqual({ kind: "thread", threadId: secondThreadPath.split("/").at(-1)!, projectId: null });
  await expect(panel.getByRole("radio", { name: "Thread", exact: true })).toBeChecked();
  await expect(addRow).toHaveAttribute("placeholder", "New workpad in this thread…");
  await expect(panel.getByText("No workpads in this thread yet", { exact: true })).toBeVisible();
  await expect(panel.locator(".workpad-document")).toHaveCount(0);
  expect(await panel.evaluate(node => (window as typeof window & { __retainedWorkpad?: Element }).__retainedWorkpad === node)).toBe(true);
  await expect(page.getByTestId("workspace-workbench-bar").getByRole("button", { name: "Close Workpads panel", exact: true })).toBeVisible();
  await capture(page, testInfo, "workpads-follow-thread.png");
  await page.goBack();
  await expect(page).toHaveURL(threadPath);
  await expect.poll(listedScope).toEqual({ kind: "thread", threadId, projectId: null });
  await panel.getByRole("button", { name: "Authentication integration", exact: true }).click();
  await expect(panel.locator(".workpad-document")).toContainText("15-minute timeout");
  await page.getByRole("button", { name: "Workpads panel actions", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Bottom", exact: true }).click();
  await expect.poll(async () => {
    const [chat, workpads] = await Promise.all([chatPane.boundingBox(), pane.boundingBox()]);
    return Boolean(chat && workpads && chat.y + chat.height <= workpads.y + 1);
  }).toBe(true);
  await page.getByRole("button", { name: "Workpads panel actions", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Right", exact: true }).click();
  await page.getByRole("button", { name: "Collapse Workpads panel", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByTestId("workspace-workbench-bar").getByRole("button", { name: "Show collapsed Workpads panel", exact: true }).click();
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
  // The revision before the latest, from the History menu, then back.
  await panel.getByRole("button", { name: "Revision history", exact: true }).click();
  const latestRevision = page.getByRole("menuitemradio", { name: new RegExp(`^Revision ${saved.revision} · latest`) });
  await expect(latestRevision).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: new RegExp(`^Revision ${saved.revision - 1}(?!\\d)`) }).click();
  await expect(panel.locator(".workpad-document")).toContainText("30-minute timeout");
  await expect(panel.locator(".workpad-document")).toContainText("legacy endpoint");
  await expect(panel).toContainText(`Viewing revision ${saved.revision - 1}. The latest is revision ${saved.revision}.`);
  await panel.getByRole("button", { name: "Back to latest", exact: true }).click();
  await expect(panel.locator(".workpad-document")).toContainText("15-minute timeout");
  await expect(panel.getByRole("button", { name: "Back to latest", exact: true })).toHaveCount(0);
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
  await expect(panel.getByRole("status")).toHaveText("Draft synced");
  expect((await readWorkpad(page, workpad.id)).revision).toBe(saved.revision);
  // A synced draft survives following another thread and reopening its document.
  await page.goForward();
  await expect(page).toHaveURL(secondThreadPath);
  await expect(panel.getByText("No workpads in this thread yet", { exact: true })).toBeVisible();
  await expect(editor).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(threadPath);
  await panel.getByRole("button", { name: "Authentication integration", exact: true }).click();
  await panel.getByRole("button", { name: "Edit workpad", exact: true }).click();
  await expect(editor).toHaveValue(draftText);
  const otherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const other = await otherContext.newPage();
  try {
    await other.goto(page.url());
    await other.getByTestId("workpads-panel-toggle").click();
    const otherPanel = other.getByRole("region", { name: "Workpads", exact: true });
    await otherPanel.getByRole("radio", { name: "Thread", exact: true }).click();
    await otherPanel.getByRole("button", { name: "Authentication integration", exact: true }).click();
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
    // Following a different thread would replace this editor. A pending save
    // must therefore allow the user to cancel browser Forward navigation.
    await page.goForward();
    const leaveWorkpad = page.getByRole("dialog", { name: "Leave unsynced workpad?", exact: true });
    await expect(leaveWorkpad).toBeVisible();
    await leaveWorkpad.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(leaveWorkpad).toBeHidden();
    await expect(page).toHaveURL(threadPath);
    await expect(editor).toHaveValue(`${draftText}Local device note.\n`);
    expect(await panel.evaluate(node => (window as typeof window & { __retainedWorkpad?: Element }).__retainedWorkpad === node)).toBe(true);
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
    await expect(panel.getByRole("alert").filter({ hasText: "The document changed." })).toContainText("Review the latest version before saving.", { timeout: 15_000 });
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

  // Project means the thread's project, named in the workpad's header.
  const snapshot = (await (await page.request.get("/api/application/snapshot")).json()) as {
    threads: { id: string; workspaceId: string }[]; workspaces: { id: string; projectId: string }[];
  };
  const threadWorkspaceId = snapshot.threads.find(({ id }) => id === threadId)!.workspaceId;
  const projectId = snapshot.workspaces.find(({ id }) => id === threadWorkspaceId)!.projectId;
  // "This project" in the header ⋯ Move to is the thread's project.
  await page.getByRole("button", { name: "Workpads panel actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move to", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /^This thread/ })).toBeDisabled();
  await page.getByRole("menuitem", { name: "This project", exact: true }).click();
  await expect.poll(async () => (await readWorkpad(page, workpad.id)).scope).toEqual({ kind: "project", projectId });
  await expect(panel.locator(".workpads-doc-meta")).toContainText("Project · workpad-workspace");
  const back = pane.getByRole("button", { name: "Back to workpads", exact: true });
  const row = panel.getByRole("button", { name: "Authentication integration", exact: true });
  await back.click();
  await expect(row).toHaveCount(0);
  await panel.getByRole("radio", { name: "Project", exact: true }).click();
  await row.click();
  const archivedNotice = panel.getByText("This workpad is archived.", { exact: true });
  await page.getByRole("button", { name: "Workpads panel actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(archivedNotice).toBeVisible();
  await expect(panel.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Edit workpad", exact: true })).toBeDisabled();
  await back.click();
  await expect(row).toHaveCount(0);
  await pane.getByRole("button", { name: "View options", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Archived", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Remove filter: Archived", exact: true })).toBeVisible();
  await row.click();
  await panel.getByRole("button", { name: "Unarchive", exact: true }).click();
  await expect(archivedNotice).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Edit workpad", exact: true })).toBeEnabled();
  expect((await readWorkpad(page, workpad.id)).archivedAt).toBeNull();
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

  // Project view keeps the same document between threads of one project.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goForward();
  await expect(page).toHaveURL(secondThreadPath);
  await expect(panel.locator(".workpad-document")).toContainText("Agent verified the endpoint.");
  expect(await panel.evaluate(node => (window as typeof window & { __retainedWorkpad?: Element }).__retainedWorkpad === node)).toBe(true);

  // A thread in a different project changes the Project filter and clears the
  // old document, without replacing the docked panel or its placement.
  await page.getByTestId("desktop-sidebar").getByTestId("workspace-picker").click();
  await page.getByLabel("Absolute directory path").fill(path.resolve(import.meta.dirname, "fixtures/task-workspace"));
  const projectOpened = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/workspaces/open") && response.status() === 201);
  await page.getByRole("dialog", { name: "Add project" }).getByRole("button", { name: "Add project", exact: true }).click();
  const otherWorkspace = (await (await projectOpened).json()) as { projectId: string };
  const otherProjectThreadPath = await createDraftThread(page);
  await expect(panel.getByRole("radio", { name: "Project", exact: true })).toBeChecked();
  await expect.poll(listedScope).toEqual({ kind: "project", projectId: otherWorkspace.projectId, threadId: null });
  await pane.getByRole("button", { name: "View options", exact: true }).click();
  const archivedOption = page.getByRole("menuitemcheckbox", { name: "Archived", exact: true });
  await expect(archivedOption).toBeChecked();
  await archivedOption.click();
  await expect(panel.getByRole("button", { name: "Remove filter: Archived", exact: true })).toHaveCount(0);
  await expect(addRow).toHaveAttribute("placeholder", "New workpad in this project…");
  await expect(panel.getByText("No workpads in this project yet", { exact: true })).toBeVisible();
  await expect(panel.locator(".workpad-document")).toHaveCount(0);
  expect(await panel.evaluate(node => (window as typeof window & { __retainedWorkpad?: Element }).__retainedWorkpad === node)).toBe(true);
  await expect.poll(async () => {
    const [chat, workpads] = await Promise.all([chatPane.boundingBox(), pane.boundingBox()]);
    return Boolean(chat && workpads && chat.x + chat.width <= workpads.x + 1);
  }).toBe(true);
  await capture(page, testInfo, "workpads-follow-project.png");
  await page.goBack();
  await expect(page).toHaveURL(secondThreadPath);
  await expect.poll(listedScope).toEqual({ kind: "project", projectId, threadId: null });
  await expect(row).toBeVisible();

  // Global stays selected across projects, including an open document.
  await panel.getByRole("radio", { name: "Global", exact: true }).click();
  await expect(addRow).toHaveAttribute("placeholder", "New global workpad…");
  await addRow.fill("Shared global notes");
  await addRow.press("Enter");
  const subtitle = pane.locator(".workspace-panel-subtitle");
  await expect(subtitle).toHaveText("Shared global notes");
  await expect(editor).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(otherProjectThreadPath);
  await expect(subtitle).toHaveText("Shared global notes");
  await expect(editor).toBeVisible();
  await back.click();
  await expect(panel.getByRole("radio", { name: "Global", exact: true })).toBeChecked();
  const globalRow = panel.getByRole("button", { name: "Shared global notes", exact: true });
  await expect(globalRow).toBeVisible();
  // A listed workpad renames from its row ⋯ without opening it.
  await panel.getByRole("button", { name: "Actions for “Shared global notes”", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename workpad", exact: true });
  await renameDialog.getByRole("textbox", { name: "Workpad title", exact: true }).fill("Shared team notes");
  await renameDialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(renameDialog).toBeHidden();
  await expect(panel.getByRole("button", { name: "Shared team notes", exact: true })).toBeVisible();
  await expect(globalRow).toHaveCount(0);
  await pane.getByRole("button", { name: "Close Workpads panel", exact: true }).click();
  await expect(panel).toHaveCount(0);
});
