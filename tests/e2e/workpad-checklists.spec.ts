import path from "node:path";
import type { Page, Request } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { capture, createDraftThread, expectNoPageOverflow, openWorkspaceDirectory } from "./helpers.js";
import { workpadDraftSchema, workpadSchema } from "../../src/shared/protocol/workpads.js";

const workspace = path.resolve(import.meta.dirname, "fixtures/workpad-workspace");
const content = "\uFEFF# Release checks\n\n- [ ] Repeat this check\n- [ ] Repeat this check\n  - [ ] Nested check\n\n- [X] Already done\n\n```md\n- [ ] Example only\n```\n";
const firstToggle = content.replace("- [ ] Repeat this check\n  -", "- [x] Repeat this check\n  -");

async function readWorkpad(page: Page, id: string) {
  const response = await page.request.get(`/api/workpads/${id}`);
  expect(response.ok()).toBe(true);
  return workpadSchema.parse((await response.json()).workpad);
}

// One document's committed revisions and retained draft form a single state
// chain; a separate job keeps this independent of the larger Workpads journey.
test("Workpad checkboxes preserve source and drafts while thread badges follow membership", async ({ page, browserDiagnostics }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const sourcePath = await createDraftThread(page, "Checklist source");
  const sourceId = sourcePath.split("/").at(-1)!;
  const destinationPath = await createDraftThread(page, "Checklist destination");
  const destinationId = destinationPath.split("/").at(-1)!;
  await page.goto(sourcePath);
  const session = (await (await page.request.get("/api/application/session")).json()) as { csrfToken: string };
  const headers = { "X-CSRF-Token": session.csrfToken };
  const toggle = page.getByTestId("workpads-panel-toggle");
  await expect(toggle).toHaveAccessibleName("Open Workpads panel");
  const listRequests: Request[] = [];
  const countLists = (request: Request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/workpads") listRequests.push(request);
  };
  page.on("request", countLists);
  const created = await page.request.post("/api/workpads", {
    headers, data: { title: "Release checks", scope: { kind: "thread", threadId: sourceId }, content },
  });
  expect(created.status()).toBe(201);
  const workpad = workpadSchema.parse((await created.json()).workpad);
  await expect(toggle).toHaveAccessibleName("Open Workpads panel, 1 workpad in this thread");
  // The closed panel has fetched no list to learn its new count.
  expect(listRequests).toHaveLength(0);
  await toggle.click();
  const panel = page.getByRole("region", { name: "Workpads", exact: true });
  await panel.getByRole("button", { name: "Release checks", exact: true }).click();
  const document = panel.locator(".workpad-document");
  const repeats = document.getByRole("checkbox", { name: "Repeat this check", exact: true });
  const nested = document.getByRole("checkbox", { name: "Nested check", exact: true });
  await expect(document.getByRole("checkbox")).toHaveCount(4);
  await expect(repeats).toHaveCount(2);
  await expect(repeats.nth(0)).not.toBeChecked();
  await expect(document.getByRole("checkbox", { name: "Already done", exact: true })).toBeChecked();
  await expect(panel.getByRole("textbox", { name: "Workpad content", exact: true })).toHaveCount(0);

  const patchUrl = `**/api/workpads/${workpad.id}`;
  let holdPatch = true;
  let releasePatch!: () => void;
  let patchStarted!: () => void;
  let started = new Promise<void>(resolve => { patchStarted = resolve; });
  let released = new Promise<void>(resolve => { releasePatch = resolve; });
  await page.route(patchUrl, async route => {
    if (route.request().method() === "PATCH" && holdPatch) {
      patchStarted();
      await released;
    }
    await route.continue();
  });
  const savedResponse = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/workpads/${workpad.id}` && response.ok());
  try {
    await repeats.nth(1).focus();
    await repeats.nth(1).press("Space");
    await started;
    await expect(panel.getByRole("status")).toContainText("Saving checklist item");
    await expect(repeats.nth(1)).toHaveAttribute("aria-disabled", "true");
    await expect(repeats.nth(1)).not.toBeChecked();
    await capture(page, testInfo, "workpad-checklist-saving.png");
  } finally { holdPatch = false; releasePatch(); }
  const saved = workpadSchema.parse((await (await savedResponse).json()).workpad);
  expect(saved.content).toBe(firstToggle);
  expect(saved.revision).toBe(workpad.revision + 1);
  await expect(repeats.nth(1)).toBeChecked();
  await expect(repeats.nth(1)).toBeFocused();
  await expect(repeats.nth(0)).not.toBeChecked();

  // Keep a real autosaved draft, then make a committed checkbox edit without
  // publishing the unrelated draft text or silently replacing its base.
  await panel.getByRole("button", { name: "Edit workpad", exact: true }).click();
  const draftText = `${firstToggle}\nUnfinished release notes.\n`;
  const draftSaved = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/workpads/${workpad.id}/draft` && response.ok());
  await panel.getByRole("textbox", { name: "Workpad content", exact: true }).fill(draftText);
  await draftSaved;
  await panel.getByRole("button", { name: "Done editing", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("button", { name: "Show attribution", exact: true }).click();
  await nested.click();
  const secondToggle = firstToggle.replace("- [ ] Nested check", "- [x] Nested check");
  await expect.poll(async () => (await readWorkpad(page, workpad.id)).content).toBe(secondToggle);
  await expect(nested).toBeChecked();
  const draft = workpadDraftSchema.parse((await (await page.request.get(`/api/workpads/${workpad.id}/draft`)).json()).draft);
  expect(draft.content).toBe(draftText);
  expect(draft.baseRevision).toBe(saved.revision);
  const touchTarget = await nested.evaluate(input => {
    const bounds = input.closest("label")?.getBoundingClientRect();
    return bounds ? { width: bounds.width, height: bounds.height } : null;
  });
  expect(touchTarget?.width).toBeGreaterThanOrEqual(44);
  expect(touchTarget?.height).toBeGreaterThanOrEqual(44);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "workpad-checklist-mobile.png");

  // Delay a real checkbox PATCH while an agent commits newer document text.
  // The stale click must fail its revision check and preserve that newer text.
  started = new Promise<void>(resolve => { patchStarted = resolve; });
  released = new Promise<void>(resolve => { releasePatch = resolve; });
  holdPatch = true;
  browserDiagnostics.allowNetworkFailures = true; // Expected stale PATCH HTTP 409.
  const rejected = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/workpads/${workpad.id}` && response.status() === 409);
  const latestBeforeConflict = await readWorkpad(page, workpad.id);
  const agentNote = "\nAgent verified the release notes.\n";
  try {
    await repeats.nth(1).click();
    await started;
    const agentEdit = await page.request.post(`/__e2e/workpads/${workpad.id}/agent-edit/${sourceId}`, {
      data: { expectedRevision: latestBeforeConflict.revision, edit: { kind: "append", text: agentNote } },
    });
    expect(agentEdit.ok()).toBe(true);
  } finally { holdPatch = false; releasePatch(); }
  await rejected;
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(document).toContainText("Agent verified the release notes.");
  await expect(repeats.nth(1)).toBeChecked();
  expect((await readWorkpad(page, workpad.id)).content).toBe(secondToggle + agentNote);
  browserDiagnostics.allowNetworkFailures = false;

  // Historical checkboxes remain inert while the current document stays saved.
  await panel.getByRole("button", { name: "Revision history", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /^Created / }).click();
  await expect(repeats.nth(1)).not.toBeChecked();
  await expect(repeats.nth(1)).toBeDisabled();
  await panel.getByRole("button", { name: "Back to latest", exact: true }).click();
  await expect(repeats.nth(1)).toBeChecked();

  // Count publication continues with the panel closed, including both ends of
  // a move. These requests change real storage; the badge uses application SSE.
  await page.getByRole("button", { name: "Close Workpads panel", exact: true }).click();
  await expect(panel).toHaveCount(0);
  listRequests.length = 0;
  const change = async (data: Record<string, unknown>) => {
    const current = await readWorkpad(page, workpad.id);
    const response = await page.request.patch(`/api/workpads/${workpad.id}`, {
      headers, data: { expectedRevision: current.revision, ...data },
    });
    expect(response.ok()).toBe(true);
  };
  await change({ archived: true });
  await expect(toggle).toHaveAccessibleName("Open Workpads panel");
  await change({ archived: false });
  await expect(toggle).toHaveAccessibleName("Open Workpads panel, 1 workpad in this thread");
  await change({ scope: { kind: "thread", threadId: destinationId } });
  await expect(toggle).toHaveAccessibleName("Open Workpads panel");
  await page.goto(destinationPath);
  await expect(toggle).toHaveAccessibleName("Open Workpads panel, 1 workpad in this thread");
  await change({ scope: { kind: "global" } });
  await expect(toggle).toHaveAccessibleName("Open Workpads panel");
  expect(listRequests).toHaveLength(0);
  page.off("request", countLists);
});
