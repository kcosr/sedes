import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { normalizedApplicationSnapshotSchema, normalizedThreadSnapshotSchema, type CreateThreadRequest } from "../../src/shared/index.js";
import { formatInlineThreadReferenceText, readThreadReferenceBody } from "../../src/shared/thread-references.js";
import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, expectNoPageOverflow, openWorkspaceDirectory, sendCurrentDraft } from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";

test("16 thread and task references stay usable, persist, and deliver together", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "composer-reference-limits");
  await mkdir(workspace, { recursive: true });
  await openWorkspaceDirectory(page, workspace);
  const creation = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/threads"));
  const threadPath = await createDraftThread(page, "Review selected work");
  const threadId = threadPath.split("/").at(-1)!;
  const createInput = (await creation).postDataJSON() as CreateThreadRequest;
  const { csrfToken } = await (await page.request.get("/api/application/session")).json();
  const headers = { "X-CSRF-Token": csrfToken };
  const references: { threadId: string; title: string }[] = [];
  const taskIds: string[] = [];
  // Seed real scoped inventory and tasks through their public APIs. The last
  // reference is selected in the composer, and the next one must be refused.
  for (let index = 1; index <= 17; index++) {
    const title = `Reference thread ${index} — review the selected implementation`;
    const created = await page.request.post("/api/threads", { headers, data: { ...createInput, title } });
    expect(created.status()).toBe(201);
    references.push({ threadId: (await created.json()).threadId, title });
    if (index <= 16) {
      const task = await page.request.post("/api/tasks", { headers, data: {
        mutationId: randomUUID(), title: `Selected task ${index} — preserve the exact details`,
        details: `Task ${index} captured with this message.`, scope: { kind: "thread", threadId },
      } });
      expect(task.status()).toBe(201);
      taskIds.push((await task.json()).task.id);
    }
  }
  const snapshot = normalizedThreadSnapshotSchema.parse(await (await page.request.get(`/api/threads/${threadId}?activityDetail=full`)).json());
  const body = "Compare the selected work.";
  const saved = await page.request.put(`/api/threads/${threadId}/draft`, { headers, data: {
    text: formatInlineThreadReferenceText([body, ...references.slice(0, 15).flatMap(reference => [" ", reference])]), contextExcerpts: [], attachmentIds: [],
    taskReferenceIds: taskIds.slice(0, 16), expectedRevision: snapshot.draft.revision,
  } });
  expect(saved.ok()).toBe(true);
  await page.reload();
  const composer = page.getByTestId("composer");
  const input = composer.getByRole("textbox");
  const chips = input.locator("[data-thread-reference-id]");
  const taskList = composer.getByRole("list", { name: "Attached tasks" });
  await expect(chips).toHaveCount(15);
  await expect(taskList.getByRole("listitem")).toHaveCount(16);
  await input.press("Control+End");
  await input.pressSequentially(" @16");
  await expect(page.getByRole("option", { name: references[15]!.title, exact: true })).toBeVisible();
  await input.press("Enter");
  await expect(chips).toHaveCount(16);
  await input.pressSequentially(" @17");
  await expect(page.getByRole("option", { name: references[16]!.title, exact: true })).toBeVisible();
  await input.press("Enter");
  await expect(composer.getByRole("alert")).toContainText("at most 16 threads");
  await expect(chips).toHaveCount(16);
  await input.press("Escape");
  await input.press("Backspace");
  await input.press("Backspace");
  await input.press("Backspace");
  await expect.poll(async () => {
    const response = await page.request.get(`/api/threads/${threadId}?activityDetail=full`);
    const draft = normalizedThreadSnapshotSchema.parse(await response.json()).draft;
    const { parts } = readThreadReferenceBody(draft.text);
    return { ids: parts.flatMap(part => typeof part === "string" ? [] : [part.threadId]), last: parts.at(-1) };
  }).toMatchObject({ ids: references.slice(0, 16).map(reference => reference.threadId), last: expect.stringMatching(/^\s*$/u) });
  await page.reload();
  await expect(chips).toHaveCount(16);
  await expect(taskList.getByRole("listitem")).toHaveCount(16);

  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
    expect((await taskList.boundingBox())!.height).toBeLessThanOrEqual(133);
    expect(await taskList.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    const lastTask = taskList.getByRole("listitem").last().getByRole("button");
    await lastTask.scrollIntoViewIfNeeded();
    await expect(lastTask).toBeInViewport();
    expect((await input.boundingBox())!.height).toBeLessThanOrEqual(220);
    await chips.last().scrollIntoViewIfNeeded();
    await expect(chips.last()).toBeInViewport();
    await expect(input).toBeInViewport();
    await expect(composer.getByRole("button", { name: "Send message" })).toBeInViewport();
    await capture(page, testInfo, `composer-16-references-${name}.png`);
  }

  await composer.getByRole("button", { name: "Stash prompt" }).click();
  await expect(chips).toHaveCount(0);
  await expect(taskList).toHaveCount(0);
  await page.getByRole("button", { name: "Open 1 stashed prompts" }).click();
  await page.getByRole("dialog", { name: "Stashed prompts" }).getByRole("button").filter({ hasText: "16 tasks" }).click();
  await expect(chips).toHaveCount(16);
  await expect(taskList.getByRole("listitem")).toHaveCount(16);
  await sendCurrentDraft(page);
  const message = page.locator('[data-item-kind="user_message"]').filter({ hasText: body });
  await expect(message.locator("a[data-thread-reference-id]")).toHaveCount(16);
  await expect(message.locator(".message-task-card")).toHaveCount(16);
  await expect(composer.getByRole("list", { name: "Attached tasks" })).toHaveCount(0);
  await expect(composer.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await capture(page, testInfo, "composer-16-references-streaming-phone.png");
  // The scripted first turn performs tool activity before its final response.
  await expect(page.locator('[data-item-kind="assistant_message"][data-item-status="completed"]')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(message.locator("a[data-thread-reference-id]")).toHaveCount(16);
  await expect(message.locator(".message-task-card")).toHaveCount(16);
});

/** Compare actual glyph positions in the same rendered line, including font ascenders. */
async function expectAlignedMention(container: Locator) {
  const difference = await container.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let prefix: Node | undefined;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.startsWith("Compare")) { prefix = node; break; }
    }
    const title = element.querySelector(".inline-thread-reference-title")?.firstChild;
    if (!prefix || !title) throw new Error("Missing text alongside the inline reference");
    const top = (node: Node) => {
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 1);
      return range.getBoundingClientRect().top;
    };
    return Math.abs(top(prefix) - top(title));
  });
  expect(difference, "The mention title follows the adjacent text baseline").toBeLessThanOrEqual(2);
}

async function expectWrappedMentionGap(container: Locator) {
  const gap = await container.locator(".inline-thread-reference").evaluateAll(([earlier, later]) =>
    later!.getBoundingClientRect().top - earlier!.getBoundingClientRect().bottom);
  expect(gap, "Adjacent lines leave space between the mention backgrounds").toBeGreaterThanOrEqual(3);
}

test("picker and sidebar insert references in sentence order through delivery", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  const locations = loadE2ERunContext().workspacesDirectory;
  const playback = path.join(locations, "Playback");
  const speech = path.join(locations, "Speech");
  await mkdir(playback, { recursive: true });
  await mkdir(speech, { recursive: true });
  await openWorkspaceDirectory(page, playback);
  await createDraftThread(page, "Playback baseline");
  await openWorkspaceDirectory(page, speech);
  const creation = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/threads"));
  await createDraftThread(page, "Speech latency review");
  const createInput = (await creation).postDataJSON() as CreateThreadRequest;
  const { csrfToken } = await (await page.request.get("/api/application/session")).json();
  const inventory = normalizedApplicationSnapshotSchema.parse(await (await page.request.get("/api/application/snapshot")).json());
  const workspace = inventory.workspaces.find(item => item.id === createInput.workspaceId)!;
  const createReference = async (title: string, brand: "codex" | "claude") => {
    const target = inventory.executionTargets.find(item => item.available && item.environmentId === workspace.environmentId && item.backend.brand === brand)!;
    const response = await page.request.post("/api/threads", { headers: { "X-CSRF-Token": csrfToken }, data: {
      ...createInput, title, configuration: { kind: "custom", targetId: target.id },
    } });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).threadId as string;
  };
  const faster = await createReference("Faster TTS streaming", "claude");
  const parked = await createReference("Parked speech", "codex");
  const composer = page.getByTestId("composer");
  const editor = composer.getByRole("textbox");
  const captureDetail = async (name: string, top: Locator, bottom: Locator = top) => {
    const start = await top.boundingBox();
    const end = await bottom.boundingBox();
    if (!start || !end) throw new Error("Screenshot content is not visible");
    const x = Math.max(0, Math.min(start.x, end.x) - 12);
    const y = Math.max(0, start.y - (top === composer ? 40 : 12));
    const { width, height } = page.viewportSize()!;
    await capture(page, testInfo, name, { clip: { x, y,
      width: Math.min(width, Math.max(start.x + start.width, end.x + end.width) + 12) - x,
      height: Math.min(height, end.y + end.height + 12) - y,
    } });
  };
  const picker = page.getByRole("dialog", { name: "Reference a thread" });
  await editor.fill("Compare @");
  await expect(picker.getByRole("option", { name: "Parked speech" })).toBeVisible();
  await expect(picker.getByRole("option", { name: "Playback baseline" })).toHaveCount(0);
  await expect(picker.getByRole("option", { name: "New thread…" })).toHaveCount(0);
  const all = picker.getByRole("option", { name: "All threads…" });
  await expect(all).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await capture(page, testInfo, "inline-thread-mentions-picker.png");
  await captureDetail("inline-thread-mentions-picker-detail.png", picker, composer);
  await editor.pressSequentially("Playback");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await editor.press("ArrowDown");
  await expect(all).toHaveAttribute("aria-selected", "true");
  await editor.press("Enter");
  await expect(picker.getByRole("option", { name: "Playback baseline" })).toBeVisible();
  await expect(editor).toBeFocused();
  await editor.press("ArrowLeft");
  await expect(picker.getByRole("option", { name: "All threads…" })).toBeVisible();
  await expect(editor).toHaveText("Compare @Playback");
  // Selecting all and typing a new query at the same @ position reopens the picker.
  await editor.fill("Compare @Parked");
  await expect(picker.getByRole("option", { name: "Parked speech" })).toHaveAttribute("aria-selected", "true");
  await editor.press("Enter");
  await expect(picker).toBeHidden();
  const firstChip = editor.locator(`[data-thread-reference-id="${parked}"]`);
  await expect(firstChip.locator('[data-backend-brand="codex"]')).toBeVisible();
  await editor.press("End");
  await editor.pressSequentially(" with  before we change the audio pipeline.");
  // Resolve the exact visual insertion boundary in the rendered sentence.
  const point = await editor.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.textContent?.indexOf(" before");
      if (offset === undefined || offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      const { left, top, height } = range.getBoundingClientRect();
      return { x: left, y: top + height / 2 };
    }
    throw new Error("Missing insertion boundary");
  });
  const source = page.getByTestId("desktop-sidebar").locator(`[data-thread-drop-id="${faster}"]`);
  await expect(source).toHaveAttribute("draggable", "true");
  await source.hover();
  await page.mouse.down();
  await page.mouse.move(point.x - 4, point.y, { steps: 12 });
  await page.mouse.move(point.x, point.y);
  await expect(page.getByTestId("composer").locator(".composer-drop-caret")).toBeVisible();
  await capture(page, testInfo, "inline-thread-mentions-drop.png");
  await page.mouse.up();
  const secondChip = editor.locator(`[data-thread-reference-id="${faster}"]`);
  await expect(secondChip.locator('[data-backend-brand="claude"]')).toBeVisible();
  await expect(editor).toHaveText(/Compare\s*Parked speech.*with\s*Faster TTS streaming.*before we change the audio pipeline\./su);
  await expect(firstChip.locator(".inline-thread-reference-project [data-label]")).toHaveAttribute("data-label", "Speech");
  await expectAlignedMention(editor);
  await capture(page, testInfo, "inline-thread-mentions-composer.png");
  await captureDetail("inline-thread-mentions-composer-detail.png", composer);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await expect(secondChip).toBeInViewport();
  await expectWrappedMentionGap(editor);
  await capture(page, testInfo, "inline-thread-mentions-composer-phone.png");
  await captureDetail("inline-thread-mentions-composer-phone-detail.png", composer);
  await page.setViewportSize({ width: 1280, height: 800 });
  await sendCurrentDraft(page);
  const sent = page.locator('[data-item-kind="user_message"]').filter({ hasText: "before we change the audio pipeline." });
  const links = sent.locator("a[data-thread-reference-id]");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute("href", `/threads/${parked}`);
  await expect(links.nth(1)).toHaveAttribute("href", `/threads/${faster}`);
  await expect(sent).toContainText(/Compare\s*Parked speech.*with\s*Faster TTS streaming.*before we change the audio pipeline\./su);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expectAlignedMention(sent);
  await expectWrappedMentionGap(sent);
  await capture(page, testInfo, "inline-thread-mentions-sent.png");
  await captureDetail("inline-thread-mentions-sent-detail.png", sent.getByTestId("message-row"));
  await expect(page.locator('[data-item-kind="assistant_message"][data-item-status="completed"]')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(links).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await sent.scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await expectWrappedMentionGap(sent);
  await captureDetail("inline-thread-mentions-sent-phone-detail.png", sent.getByTestId("message-row"));
  await links.first().click();
  await expect(page).toHaveURL(new RegExp(`/threads/${parked}$`));
});
