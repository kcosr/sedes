import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { normalizedThreadSnapshotSchema, type CreateThreadRequest } from "../../src/shared/index.js";
import { formatThreadReferenceText } from "../../src/shared/thread-references.js";
import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, expectNoPageOverflow, fillAndPersistDraft, openWorkspaceDirectory, sendCurrentDraft } from "./helpers.js";
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
    text: formatThreadReferenceText(body, references.slice(0, 15)), contextExcerpts: [], attachmentIds: [],
    taskReferenceIds: taskIds.slice(0, 16), expectedRevision: snapshot.draft.revision,
  } });
  expect(saved.ok()).toBe(true);
  await page.reload();
  const composer = page.getByTestId("composer");
  const input = composer.getByRole("textbox");
  const threadList = composer.getByRole("list", { name: "Referenced threads" });
  const taskList = composer.getByRole("list", { name: "Attached tasks" });
  await expect(threadList.getByRole("listitem")).toHaveCount(15);
  await expect(taskList.getByRole("listitem")).toHaveCount(16);
  await input.fill(`${body} @16`);
  await expect(page.getByRole("option", { name: references[15]!.title, exact: true })).toBeVisible();
  await input.press("Enter");
  await expect(threadList.getByRole("listitem")).toHaveCount(16);
  await input.fill(`${body} @17`);
  await expect(page.getByRole("option", { name: references[16]!.title, exact: true })).toBeVisible();
  await input.press("Enter");
  await expect(composer.getByRole("alert")).toContainText("at most 16 threads");
  await expect(threadList.getByRole("listitem")).toHaveCount(16);
  await input.press("Escape");
  await fillAndPersistDraft(page, body);
  await page.reload();
  await expect(threadList.getByRole("listitem")).toHaveCount(16);
  await expect(taskList.getByRole("listitem")).toHaveCount(16);

  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
    for (const list of [threadList, taskList]) {
      expect((await list.boundingBox())!.height).toBeLessThanOrEqual(133);
      expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      await list.getByRole("listitem").last().getByRole("button").scrollIntoViewIfNeeded();
      await expect(list.getByRole("listitem").last().getByRole("button")).toBeInViewport();
    }
    await expect(input).toBeInViewport();
    await expect(composer.getByRole("button", { name: "Send message" })).toBeInViewport();
    await capture(page, testInfo, `composer-16-references-${name}.png`);
  }

  await composer.getByRole("button", { name: "Stash prompt" }).click();
  await expect(threadList).toHaveCount(0);
  await expect(taskList).toHaveCount(0);
  await page.getByRole("button", { name: "Open 1 stashed prompts" }).click();
  await page.getByRole("dialog", { name: "Stashed prompts" }).getByRole("button").filter({ hasText: "16 tasks" }).click();
  await expect(threadList.getByRole("listitem")).toHaveCount(16);
  await expect(taskList.getByRole("listitem")).toHaveCount(16);
  await sendCurrentDraft(page);
  const message = page.locator('[data-item-kind="user_message"]').filter({ hasText: body });
  await expect(message.locator(".thread-reference-chip")).toHaveCount(16);
  await expect(message.locator(".message-task-card")).toHaveCount(16);
  await expect(composer.getByRole("list", { name: "Attached tasks" })).toHaveCount(0);
  await expect(composer.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await capture(page, testInfo, "composer-16-references-streaming-phone.png");
  // The scripted first turn performs tool activity before its final response.
  await expect(page.locator('[data-item-kind="assistant_message"][data-item-status="completed"]')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(message.locator(".thread-reference-chip")).toHaveCount(16);
  await expect(message.locator(".message-task-card")).toHaveCount(16);
});
