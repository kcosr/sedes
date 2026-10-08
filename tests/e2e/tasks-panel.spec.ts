import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { loadE2ERunContext } from "./run-context.js";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  capture,
  createDraftThread,
  overlaySettled,
  selectCustomNewThreadTarget,
  selectRadixOption,
} from "./helpers";
import {
  normalizedApplicationSnapshotSchema,
  taskMutationResultSchema,
} from "../../src/shared/index.js";

const TASK_MUTATION_TIMEOUT_MS = 15_000;
const taskWorkspace = path.resolve(
  import.meta.dirname,
  "fixtures/task-workspace",
);
const taskReadme = path.join(taskWorkspace, "README.md");

async function openTaskWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  const picker = page
    .getByTestId("desktop-sidebar")
    .getByTestId("workspace-picker");
  await picker.click();
  await page.getByLabel("Absolute directory path").fill(taskWorkspace);
  const opened = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/workspaces/open") &&
      response.status() === 201,
  );
  await page.getByRole("dialog", { name: "Add project" }).getByRole("button", { name: "Add project" }).click();
  await opened;
  await expect(
    page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger"),
  ).toBeEnabled();
}

/** The Tasks content (header and body) in whichever host shows it. */
function tasksContent(page: Page): Locator {
  return page.locator(".tasks-content").filter({ visible: true });
}

function taskRow(content: Locator, title: string): Locator {
  return content.locator(".tasks-row").filter({
    has: content.page().locator(".tasks-row-title", { hasText: title }),
  });
}

async function addTask(content: Locator, title: string): Promise<void> {
  const input = content.getByRole("textbox", { name: "Add a task" });
  // Clicking first takes focus from any deferred composer focus request.
  await input.click();
  await expect(input).toBeFocused();
  await input.fill(title);
  await expect(input).toHaveValue(title);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
}

/** Expands a task's inline detail (only one row is expanded at a time). */
async function expandTask(content: Locator, title: string): Promise<void> {
  const button = taskRow(content, title).getByRole("button", { name: title, exact: true });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
}

async function selectScope(
  content: Locator,
  name: "Thread" | "Project" | "Global" | "All",
): Promise<void> {
  await content
    .getByRole("radiogroup", { name: "Task scope view" })
    .getByRole("radio", { name, exact: true })
    .click();
}

test.describe.serial("Tasks panel", () => {
  test("Tasks beside a thread: per-scope creation, Global from the thread, completion, and re-scope", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTaskWorkspace(page);

    // Home has no Tasks: no toggle, no surface, and the Tasks shortcut is
    // left to the page.
    const panel = page.locator('[data-slot="tasks-panel"]');
    await expect(
      page.getByRole("heading", { name: "What should the agent work on?" }),
    ).toBeVisible();
    await expect(page.getByTestId("tasks-panel-toggle")).toHaveCount(0);
    await page.keyboard.press("Control+Shift+L");
    await expect(panel).toHaveCount(0);

    // Thread route: Tasks docks beside Chat; every view applies and Thread
    // follows the chat.
    const threadPath = await createDraftThread(page);
    const threadId = threadPath.split("/").at(-1)!;
    const threadTasksToggle = page
      .getByTestId("workspace-workbench-bar")
      .getByTestId("tasks-panel-toggle");
    await expect(threadTasksToggle).toBeVisible();
    await expect(panel).toHaveCount(0);
    await threadTasksToggle.click();
    await expect(panel).toHaveAttribute("data-presentation", "panel");
    await expect(threadTasksToggle).toHaveAttribute("aria-expanded", "true");
    const tasksLeaf = page.locator('[data-panel-id="tasks"]');
    const chatLeaf = page.locator('[data-panel-id="chat"]');
    const dockedBox = await tasksLeaf.boundingBox();
    const chatBox = await chatLeaf.boundingBox();
    // Docked right of Chat, reflowing it rather than covering it.
    expect(dockedBox!.x).toBeGreaterThanOrEqual(chatBox!.x + chatBox!.width);
    expect(dockedBox!.y).toBeCloseTo(chatBox!.y, 0);
    expect(dockedBox!.height).toBeCloseTo(chatBox!.height, 0);
    // One header: the content's panel chrome with the layout's controls.
    await expect(tasksLeaf.locator("header")).toHaveCount(1);
    await expect(tasksLeaf.getByRole("button", { name: "Collapse Tasks panel" })).toBeVisible();
    const resize = page.getByRole("separator", { name: "Resize Chat and Files panels" });
    const resizeBox = await resize.boundingBox();
    await page.mouse.move(
      resizeBox!.x + resizeBox!.width / 2,
      resizeBox!.y + resizeBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeBox!.x + resizeBox!.width / 2 - 96,
      resizeBox!.y + resizeBox!.height / 2,
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await tasksLeaf.boundingBox())?.width ?? 0)
      .toBeGreaterThan(dockedBox!.width + 80);
    const widenedWidth = (await tasksLeaf.boundingBox())!.width;
    const sidebarThread = page
      .getByTestId("desktop-sidebar")
      .locator(`[data-thread-id="${threadId}"]`);
    const tasks = tasksContent(page);
    const scopes = tasks.getByRole("radiogroup", { name: "Task scope view" });

    // Global tasks are reached from the Global scope of any thread's Tasks.
    await selectScope(tasks, "Global");
    await tasks.getByRole("button", { name: "View options" }).click();
    // Search matches titles until Search notes is on; choices keep the menu open.
    const searchNotes = page.getByRole("menuitemcheckbox", { name: "Search notes" });
    await expect(searchNotes).not.toBeChecked();
    await searchNotes.click();
    await expect(searchNotes).toBeChecked();
    await searchNotes.click();
    await expect(searchNotes).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(tasks.getByRole("textbox", { name: "Add a task" })).toHaveAttribute(
      "placeholder",
      "Add a global task…",
    );
    const pinNewTask = tasks.getByRole("button", { name: "Pin new task" });
    await expect(pinNewTask).toHaveAttribute("aria-pressed", "false");
    await pinNewTask.click();
    const createPinnedTask = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/tasks"));
    await addTask(tasks, "Global errand");
    expect((await createPinnedTask).postDataJSON()).toMatchObject({ pinned: true });
    await expect(pinNewTask).toHaveAttribute("aria-pressed", "false");
    await expect(taskRow(tasks, "Global errand")).toBeVisible({
      timeout: TASK_MUTATION_TIMEOUT_MS,
    });
    // The toggle counts only the thread's own open tasks.
    await expect(
      threadTasksToggle.locator('[data-slot="count-badge"]'),
    ).toHaveCount(0);
    await capture(page, testInfo, "tasks-panel-thread-global.png");

    await expect(scopes.getByRole("radio", { name: "Thread" })).toBeEnabled();
    await selectScope(tasks, "Thread");
    await addTask(tasks, "Verify endpoint");
    const threadTask = taskRow(tasks, "Verify endpoint");
    await expect(threadTask).toBeVisible();
    await expect(
      sidebarThread.getByRole("img", { name: "1 open task" }),
    ).toBeVisible();
    await expect(threadTasksToggle).toHaveAccessibleName(
      "Close Tasks panel, 1 open task",
    );
    await expect(
      threadTasksToggle.locator('[data-slot="count-badge"]'),
    ).toHaveText("1");

    // Archived has no Tasks either; returning to the thread finds its docked
    // Tasks as it was left.
    await page
      .getByTestId("desktop-sidebar")
      .getByRole("button", { name: "More" })
      .click();
    await page.getByRole("menuitem", { name: "Archived threads" }).click();
    await expect(page).toHaveURL("/archived");
    await expect(page.getByTestId("tasks-panel-toggle")).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    await page.keyboard.press("Control+Shift+L");
    await expect(panel).toHaveCount(0);
    await sidebarThread.getByTestId("thread-row-link").click();
    await expect(page).toHaveURL(threadPath);
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent", exact: true }),
    ).toBeFocused();
    await expect(panel).toHaveAttribute("data-presentation", "panel");
    await expect(threadTasksToggle).toHaveAttribute("aria-expanded", "true");
    await expect(scopes.getByRole("radio", { name: "Thread" })).toHaveAttribute("aria-checked", "true");
    await expect(threadTask).toBeVisible();

    // Docked Tasks is a panel of its own and stays on stage when Chat collapses.
    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await expect(panel).toBeVisible();
    await expect(threadTasksToggle).toBeVisible();
    await expect(scopes.getByRole("radio", { name: "Thread" })).toHaveAttribute("aria-checked", "true");
    await threadTasksToggle.click();
    await expect(panel).toHaveCount(0);
    await threadTasksToggle.click();
    await expect(threadTask).toBeVisible();
    await capture(page, testInfo, "tasks-chat-collapsed.png");
    await page.getByRole("button", { name: "Open Chat panel", exact: true }).click();
    // Reopening Chat requests composer focus after its retained panel mounts.
    // Let that transition finish before typing into another panel's input.
    await expect(page.getByRole("textbox", { name: "Message Scripted agent", exact: true })).toBeFocused();

    // Adding keeps focus in the add row; pin from the row menu.
    await addTask(tasks, "Unpinned follow-up");
    await expect(
      sidebarThread.getByRole("img", { name: "2 open tasks" }),
    ).toBeVisible();
    await expect(threadTasksToggle).toHaveAccessibleName(
      "Close Tasks panel, 2 open tasks",
    );
    await expect(
      threadTasksToggle.locator('[data-slot="count-badge"]'),
    ).toHaveText("2");
    await threadTask.hover();
    await threadTask.getByRole("button", { name: 'Actions for "Verify endpoint"' }).click();
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(threadTask.locator(".tasks-row-pin")).toBeVisible({
      timeout: TASK_MUTATION_TIMEOUT_MS,
    });

    // Files and notes are edited in the dialog.
    await expandTask(tasks, "Verify endpoint");
    await tasks.getByRole("button", { name: "Edit", exact: true }).click();
    let editor = page.getByRole("dialog", { name: "Edit task" });
    await editor.getByRole("button", { name: "Add file" }).click();
    await editor
      .getByRole("textbox", { name: "Absolute file path" })
      .fill(taskReadme);
    await editor.getByRole("button", { name: "Add", exact: true }).click();
    await editor
      .getByRole("textbox", { name: "Notes" })
      .fill("Open the linked project file");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0, {
      timeout: TASK_MUTATION_TIMEOUT_MS,
    });
    await expect(threadTask.locator(".tasks-row-pin")).toBeVisible();
    await expect
      .poll(() => tasks.locator(".tasks-row-title").allTextContents())
      .toEqual(["Verify endpoint", "Unpinned follow-up"]);

    // The singleton Files surface consumes the task intent and keeps its
    // ordinary markdown preview/edit controls.
    await page.getByRole("button", { name: "Panels", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Files(?: —|$)/ }).click();
    const filesPanel = page.getByRole("region", { name: "Workspace files" });
    await expect(filesPanel).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh workspace files" }),
    ).toBeEnabled({ timeout: TASK_MUTATION_TIMEOUT_MS });
    const linkedFileResolved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/file-links/resolve") &&
        response.ok(),
    );
    await tasks
      .getByRole("button", {
        name: `Open ${taskReadme} in Files`,
      })
      .click();
    await linkedFileResolved;
    await expect(
      filesPanel.getByRole("tab", { name: /README\.md/ }),
    ).toBeVisible({ timeout: TASK_MUTATION_TIMEOUT_MS });
    await expect(
      filesPanel.getByRole("heading", { name: "Sedes" }),
    ).toBeVisible({ timeout: 15_000 });
    await filesPanel.getByRole("button", { name: "Edit", exact: true }).click();
    const doneEditing = filesPanel.getByRole("button", {
      name: "Done",
      exact: true,
    });
    await expect(doneEditing).toBeVisible();
    await expect(doneEditing).toBeEnabled();
    await doneEditing.click();
    await capture(page, testInfo, "tasks-file-open-existing-pane.png");
    await page.getByRole("button", { name: "Close Files panel" }).click();
    await expect(filesPanel).toHaveCount(0);

    // Completing moves the task into the collapsed Completed section.
    await threadTask
      .getByRole("checkbox", { name: 'Mark "Verify endpoint" as done' })
      .click();
    const completed = tasks.getByRole("button", { name: /^Completed/ });
    await expect(completed).toHaveText("Completed1", {
      timeout: TASK_MUTATION_TIMEOUT_MS,
    });
    await expect(
      sidebarThread.getByRole("img", {
        name: "1 open task",
      }),
    ).toBeVisible();
    await completed.click();
    await expect(
      threadTask.getByRole("checkbox", {
        name: 'Mark "Verify endpoint" as open',
      }),
    ).toBeChecked();
    await expect(threadTask).toHaveAttribute("data-completed", "true");

    // Project view is a pure filter: thread tasks join only on request.
    await selectScope(tasks, "Project");
    await expect(taskRow(tasks, "Verify endpoint")).toHaveCount(0);
    await expect(tasks.getByText("No tasks for this project yet.")).toBeVisible();
    await tasks.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Include thread tasks" }).click();
    await page.keyboard.press("Escape");
    await expect(taskRow(tasks, "Unpinned follow-up")).toBeVisible();
    await expect(tasks.getByRole("button", { name: /^Completed/ })).toHaveText("Completed1");
    await tasks.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Include thread tasks" }).click();
    await page.keyboard.press("Escape");
    await expect(taskRow(tasks, "Unpinned follow-up")).toHaveCount(0);

    // Re-scope the thread task to the project from the edit dialog.
    await selectScope(tasks, "Thread");
    // The Completed section stays open across views.
    await expect(tasks.getByRole("button", { name: /^Completed/ })).toHaveAttribute("aria-expanded", "true");
    await expandTask(tasks, "Verify endpoint");
    await tasks.getByRole("button", { name: "Edit", exact: true }).click();
    editor = page.getByRole("dialog", { name: "Edit task" });
    await expect(editor).toBeVisible();
    await editor.getByRole("combobox", { name: "Belongs to" }).click();
    await page.getByRole("option", { name: /^This project · task-workspace/ }).click();
    await capture(page, testInfo, "tasks-assign-project-desktop.png");
    await editor
      .getByRole("textbox", { name: "Notes" })
      .fill("Moved up to the project");
    const taskRescoped = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        /\/api\/tasks\/[^/]+$/u.test(new URL(response.url()).pathname) &&
        response.ok(),
      { timeout: TASK_MUTATION_TIMEOUT_MS },
    );
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await taskRescoped;
    await expect(editor).toHaveCount(0, {
      timeout: TASK_MUTATION_TIMEOUT_MS,
    });
    await expect(taskRow(tasks, "Unpinned follow-up")).toBeVisible();
    await expect(taskRow(tasks, "Verify endpoint")).toHaveCount(0);
    await expect(
      sidebarThread.getByRole("img", { name: "1 open task" }),
    ).toBeVisible();
    await expect(threadTasksToggle).toHaveAccessibleName(
      "Close Tasks panel, 1 open task",
    );
    await expect(
      threadTasksToggle.locator('[data-slot="count-badge"]'),
    ).toHaveText("1");
    const followUpTask = taskRow(tasks, "Unpinned follow-up");
    await followUpTask
      .getByRole("checkbox", { name: 'Mark "Unpinned follow-up" as done' })
      .click();
    await expect(tasks.getByRole("button", { name: /^Completed/ })).toHaveText(
      "Completed1",
      { timeout: TASK_MUTATION_TIMEOUT_MS },
    );
    await expect(sidebarThread.getByRole("img", { name: /task/i })).toHaveCount(
      0,
      { timeout: TASK_MUTATION_TIMEOUT_MS },
    );
    await expect(threadTasksToggle).toHaveAccessibleName("Close Tasks panel");
    await expect(
      threadTasksToggle.locator('[data-slot="count-badge"]'),
    ).toHaveCount(0);
    await selectScope(tasks, "Project");
    await expect(tasks.getByRole("button", { name: /^Completed/ })).toHaveText("Completed1");
    await capture(page, testInfo, "tasks-panel-project-after-move.png");

    // Global shows only the global task; All shows every task, grouped.
    await selectScope(tasks, "Global");
    await expect(taskRow(tasks, "Global errand")).toBeVisible();
    await expect(taskRow(tasks, "Verify endpoint")).toHaveCount(0);
    await selectScope(tasks, "All");
    await expect(tasks.getByRole("button", { name: /^Global\s*1$/ })).toBeVisible();
    await expect(tasks.getByRole("button", { name: /^Completed\s*2$/ })).toHaveAttribute("aria-expanded", "true");
    await expect(taskRow(tasks, "Verify endpoint")).toBeVisible();
    await expect(taskRow(tasks, "Unpinned follow-up")).toBeVisible();
    await tasks.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Group by project" }).click();
    await page.keyboard.press("Escape");
    await expect(tasks.locator(".tasks-group-heading")).toHaveCount(0);
    await capture(page, testInfo, "tasks-panel-all.png");

    // The docked panel, its width, the last view and its View options
    // survive a reload.
    await page.reload();
    await expect(page.locator('[data-slot="tasks-panel"]')).toBeVisible();
    await expect(panel).toHaveAttribute("data-presentation", "panel");
    await expect
      .poll(async () => (await tasksLeaf.boundingBox())?.width ?? 0)
      .toBeCloseTo(widenedWidth, 0);
    await expect(scopes.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    await expect(tasks.locator(".tasks-group-heading")).toHaveCount(0);
    await tasks.getByRole("button", { name: "View options" }).click();
    await expect(
      page.getByRole("menuitemcheckbox", { name: "Group by project" }),
    ).not.toBeChecked();
    await page.getByRole("menuitemcheckbox", { name: "Group by project" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // On mobile, Tasks is a sheet with a detail view inside it.
    await tasks.getByRole("button", { name: "Close Tasks panel" }).click();
    await page.setViewportSize({ width: 412, height: 915 });
    await expect(page.getByTestId("thread-controls")).toBeHidden();
    await expect(threadTasksToggle).toBeVisible();
    await threadTasksToggle.click();
    const sheet = page.getByRole("dialog", { name: "Tasks", exact: true });
    await expect(sheet).toBeVisible();
    await expect(panel).toHaveAttribute("data-presentation", "sheet");
    await expect(page.locator('[data-panel-id="tasks"]')).toHaveCount(0);
    // The sheet opens on the last view chosen, whatever presented it.
    await expect(sheet.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    await selectScope(tasks, "Global");
    await expect(sheet.getByRole("radio", { name: "Global" })).toHaveAttribute("aria-checked", "true");
    await sheet.getByRole("button", { name: "Global errand", exact: true }).click();
    await expect(sheet.getByRole("heading", { name: "Global errand" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Back to tasks" })).toBeFocused();
    await capture(page, testInfo, "tasks-mobile-detail.png");
    await sheet.getByRole("button", { name: "Back to tasks" }).click();
    await expect(sheet.getByRole("textbox", { name: "Add a task" })).toBeVisible();
    await capture(page, testInfo, "tasks-mobile-header.png");
    await sheet.getByRole("button", { name: "Close Tasks panel" }).click();
    await expect(page.getByRole("button", { name: "Thread actions" })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await threadTasksToggle.click();
    await expect(panel).toHaveAttribute("data-presentation", "panel");

    // Escape leaves the docked panel alone; Ctrl+Shift+L toggles it from
    // anywhere, including the composer.
    await page.keyboard.press("Escape");
    await expect(panel).toBeVisible();
    await page.getByRole("textbox", { name: "Message Scripted agent", exact: true }).click();
    await page.keyboard.press("Control+Shift+L");
    await expect(page.locator('[data-slot="tasks-panel"]')).toHaveCount(0);
    await expect(threadTasksToggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Control+Shift+L");
    await expect(panel).toHaveAttribute("data-presentation", "panel");
  });

  test("archiving a thread with open tasks routes through the disposition modal and moves them to the project", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTaskWorkspace(page);
    const siblingThreadPath = await createDraftThread(page);
    const archivedThreadPath = await createDraftThread(page);

    // Create one open thread task on the second draft.
    await page.getByTestId("tasks-panel-toggle").click();
    const panel = page.locator('[data-slot="tasks-panel"]');
    const tasks = tasksContent(page);
    await selectScope(tasks, "Thread");
    await addTask(tasks, "Restart service");
    await expect(taskRow(tasks, "Restart service")).toBeVisible();

    // Desktop no-descendant archive normally fires immediately; with an open
    // task it must interpose the archive choices modal instead.
    await page.getByRole("button", { name: "Thread actions" }).click();
    await page
      .getByTestId("thread-actions-menu")
      .getByRole("menuitem", { name: "Archive", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Archive this thread" });
    await expect(dialog).toBeVisible();
    const disposition = dialog.getByTestId("archive-task-disposition");
    await expect(disposition).toBeVisible();
    await expect(disposition.getByText("1 open task")).toBeVisible();
    await expect(disposition.getByText("Restart service")).toBeVisible();
    await expect(
      disposition.getByRole("radio", { name: "To project" }),
    ).toHaveAttribute("aria-checked", "true");
    await capture(page, testInfo, "tasks-archive-disposition.png");

    // Confirm with the default "To project" disposition.
    await dialog.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // The task now lives at the project scope: visible from a sibling thread.
    await page.goto(siblingThreadPath);
    await expect(panel).toBeVisible();
    await selectScope(tasks, "Project");
    const moved = taskRow(tasks, "Restart service");
    await expect(moved).toBeVisible();
    await capture(page, testInfo, "tasks-archive-moved-to-project.png");

    // Archived threads are not offered as destinations.
    await moved.hover();
    await moved.getByRole("button", { name: 'Actions for "Restart service"' }).click();
    await page.getByRole("menuitem", { name: "Move to" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("menu", { name: "Move to" }).getByRole("menuitem", { name: "Choose…" }).click();
    const chooser = page.getByRole("dialog", { name: "Move task" });
    await chooser.getByRole("combobox", { name: "Search threads and projects" }).fill(archivedThreadPath.split("/").at(-1)!);
    await expect(chooser.getByText("No matching threads or projects.", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(chooser).toHaveCount(0);
  });
});

for (const action of ["Park", "Archive"] as const) {
  test(`${action.toLowerCase()} lists tasks and completes them without moving ownership`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTaskWorkspace(page);
    const threadPath = await createDraftThread(page);
    const threadId = threadPath.split("/").at(-1)!;
    const session = await (await page.request.get("/api/application/session")).json();
    const headers = { "X-CSRF-Token": session.csrfToken };
    const tasks = [];
    for (const title of [`${action} reviewed endpoint`, `${action} reviewed docs`]) {
      const response = await page.request.post("/api/tasks", {
        headers,
        data: { mutationId: randomUUID(), title, scope: { kind: "thread", threadId } },
      });
      expect(response.status()).toBe(201);
      tasks.push(taskMutationResultSchema.parse(await response.json()).task);
    }

    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByTestId("thread-actions-menu").getByRole("menuitem", { name: action, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `${action} this thread` });
    for (const task of tasks) await expect(dialog.getByText(task.title, { exact: true })).toBeVisible();
    await dialog.getByRole("radio", { name: "Complete all", exact: true }).click();
    if (action === "Archive") await page.setViewportSize({ width: 412, height: 700 });
    await expect(dialog.getByRole("radio", { name: "Complete all", exact: true })).toBeVisible();
    await capture(page, testInfo, `tasks-${action.toLowerCase()}-complete-preview.png`);
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog).toBeHidden();

    const snapshot = normalizedApplicationSnapshotSchema.parse(
      await (await page.request.get("/api/application/snapshot")).json(),
    );
    for (const task of tasks) {
      const completed = snapshot.tasks.find(({ id }) => id === task.id);
      expect(completed).toMatchObject({
        scope: { kind: "thread", threadId },
        revision: task.revision + 1,
      });
      expect(completed?.completedAt).toEqual(expect.any(String));
    }
    expect(snapshot.threads.find(({ id }) => id === threadId)?.inventoryState).toBe(
      action === "Park" ? "settled" : "archived",
    );
  });
}


/** Creates a named thread in one location of a project through New thread. */
async function createThreadAt(
  page: Page,
  project: RegExp,
  location: RegExp,
  title: string,
): Promise<string> {
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await page.getByRole("textbox", { name: "Thread name" }).fill(title);
  await selectRadixOption(page, page.getByRole("combobox", { name: "Project", exact: true }), project);
  await selectRadixOption(page, page.getByRole("combobox", { name: "Location", exact: true }), location);
  await selectCustomNewThreadTarget(page, "Pi SDK");
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
  return new URL(page.url()).pathname;
}

test("a project's tasks are shared by every location of the project", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const session = (await (await page.request.get("/api/application/session")).json()) as { csrfToken: string };
  const snapshot = normalizedApplicationSnapshotSchema.parse(
    await (await page.request.get("/api/application/snapshot")).json(),
  );
  const environmentId = snapshot.environments.find(({ kind }) => kind === "local")!.id;
  const headers = { "X-CSRF-Token": session.csrfToken };
  // One project with two locations: the same work in two directories.
  const root = path.join(loadE2ERunContext().workspacesDirectory, `shared-project-${randomUUID()}`);
  const [alphaPath, betaPath] = ["alpha", "beta"].map((name) => path.join(root, name)) as [string, string];
  await Promise.all([alphaPath, betaPath].map((directory) => mkdir(directory, { recursive: true })));
  const alpha = await page.request.post("/api/workspaces/open", {
    headers,
    data: { environmentId, path: alphaPath, project: { kind: "new", name: "Shared app" } },
  });
  expect(alpha.status(), await alpha.text()).toBe(201);
  const { projectId } = (await alpha.json()) as { projectId: string };
  const beta = await page.request.post("/api/workspaces/open", {
    headers,
    data: { environmentId, path: betaPath, project: { kind: "existing", projectId } },
  });
  expect(beta.status(), await beta.text()).toBe(201);
  await page.reload();

  // A project task and a thread task created in the alpha location.
  await createThreadAt(page, /^Shared app/u, /alpha$/u, "Alpha work");
  const toggle = page.getByTestId("workspace-workbench-bar").getByTestId("tasks-panel-toggle");
  await toggle.click();
  const tasks = tasksContent(page);
  await selectScope(tasks, "Thread");
  await addTask(tasks, "Alpha follow-up");
  await expect(taskRow(tasks, "Alpha follow-up")).toBeVisible({ timeout: TASK_MUTATION_TIMEOUT_MS });
  await selectScope(tasks, "Project");
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/tasks" &&
      response.ok(),
  );
  await addTask(tasks, "Shared release checklist");
  const task = taskMutationResultSchema.parse(await (await created).json()).task;
  // Created for the project, never for one of its locations.
  expect(task.scope).toEqual({ kind: "project", projectId });
  await expect(taskRow(tasks, "Shared release checklist")).toBeVisible();

  // A thread in the beta location sees it in This project.
  await createThreadAt(page, /^Shared app/u, /beta$/u, "Beta work");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const betaTasks = tasksContent(page);
  await selectScope(betaTasks, "Project");
  await expect(taskRow(betaTasks, "Shared release checklist")).toBeVisible();
  await expect(taskRow(betaTasks, "Alpha follow-up")).toHaveCount(0);
  // With thread tasks, the alpha thread's task says where its thread runs.
  await betaTasks.getByRole("button", { name: "View options" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Include thread tasks" }).click();
  await page.keyboard.press("Escape");
  await expect(
    taskRow(betaTasks, "Alpha follow-up").getByRole("button", { name: "Alpha follow-up", exact: true }),
  ).toHaveAccessibleDescription("In Alpha work · alpha");
  await capture(page, testInfo, "tasks-project-shared-across-locations.png");

  // All groups the project once, with both locations' threads under it.
  await selectScope(betaTasks, "All");
  const projectGroups = betaTasks
    .locator('.tasks-group[data-kind="project"]')
    .filter({ has: page.locator(".tasks-group-heading", { hasText: /^Shared app\d+$/u }) });
  await expect(projectGroups).toHaveCount(1);
  await expect(projectGroups.getByRole("button", { name: /^Alpha work · alpha/u })).toBeVisible();
  await expect(taskRow(projectGroups, "Shared release checklist")).toBeVisible();
  await capture(page, testInfo, "tasks-project-shared-all-grouped.png");
});

test("mobile task destinations remain usable with long lists and short viewports", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTaskWorkspace(page);
  // Tasks appears beside a thread: open one in the task workspace before
  // the chooser projects exist.
  await createDraftThread(page);
  const response = await page.request.get("/api/application/snapshot");
  expect(response.ok()).toBe(true);
  const snapshot = await response.json();
  const workspace = snapshot.workspaces.find((candidate: { displayPath: { text: string } }) => candidate.displayPath.text === taskWorkspace);
  expect(workspace).toBeDefined();
  const sessionResponse = await page.request.get("/api/application/session");
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const root = path.join(loadE2ERunContext().workspacesDirectory, `task-chooser-${randomUUID()}`);
  for (let index = 0; index < 12; index++) {
    const projectPath = path.join(root, `Chooser project ${String(index).padStart(2, "0")}`);
    await mkdir(projectPath, { recursive: true });
    expect((await page.request.post("/api/workspaces/open", {
      headers,
      data: { path: projectPath, environmentId: workspace.environmentId, project: { kind: "new", name: path.basename(projectPath) } },
    })).ok()).toBe(true);
    expect((await page.request.post("/api/tasks", {
      headers,
      data: { mutationId: randomUUID(), title: `Chooser task ${index}`, scope: { kind: "global" } },
    })).ok()).toBe(true);
  }
  await page.reload();
  await page.setViewportSize({ width: 412, height: 915 });
  await page
    .getByTestId("workspace-workbench-bar")
    .getByTestId("tasks-panel-toggle")
    .click();
  const sheet = page.getByRole("dialog", { name: "Tasks", exact: true });
  await sheet.getByRole("radio", { name: "Global", exact: true }).click();

  // Belongs to in the edit sheet: a long, searchable chooser.
  await sheet.getByRole("button", { name: "Chooser task 0", exact: true }).click();
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit task", exact: true });
  await editor.getByRole("combobox", { name: "Belongs to", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "Choose belongs to", exact: true });
  await expect(chooser).toBeVisible();
  await chooser.getByRole("combobox", { name: "Search threads and projects" }).fill("Chooser project");
  // Each project also lists its threads; the projects come first, together.
  await expect(chooser.getByRole("group", { name: "Projects" }).getByRole("option")).toHaveCount(12);
  const options = chooser.getByRole("listbox");
  expect(await options.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await overlaySettled(chooser);
  const bounds = await chooser.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(915);
  await capture(page, testInfo, "tasks-project-chooser-mobile-long-results.png");
  await chooser.getByRole("group", { name: "Projects" }).getByRole("option").filter({ hasText: "Chooser project 11" }).click();
  await expect(chooser).toHaveCount(0);
  await expect(editor.getByRole("combobox", { name: "Belongs to", exact: true })).toContainText("Chooser project 11");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard and close" }).click();
  await expect(editor).toHaveCount(0);

  // Move to › Choose… stays inside a short viewport.
  await sheet.getByRole("button", { name: 'Actions for "Chooser task 0"' }).click();
  const actions = page.getByRole("dialog", { name: "Chooser task 0" });
  await actions.getByRole("menuitem", { name: "Move to" }).click();
  await actions.getByRole("menuitem", { name: "Choose…" }).click();
  const move = page.getByRole("dialog", { name: "Move task", exact: true });
  await expect(move).toBeVisible();
  await page.setViewportSize({ width: 412, height: 480 });
  await move.getByRole("combobox", { name: "Search threads and projects" }).fill("Chooser project");
  await expect(move.getByRole("group", { name: "Projects" }).getByRole("option")).toHaveCount(12);
  await overlaySettled(move);
  const compactBounds = await move.boundingBox();
  expect(compactBounds!.y).toBeGreaterThanOrEqual(0);
  expect(compactBounds!.y + compactBounds!.height).toBeLessThanOrEqual(480);
  await capture(page, testInfo, "tasks-project-chooser-mobile-short-viewport.png");
  const moved = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      candidate.url().includes("/move") &&
      candidate.ok(),
  );
  await move.getByRole("group", { name: "Projects" }).getByRole("option").filter({ hasText: "Chooser project 10" }).click();
  await expect(move).toHaveCount(0);
  await moved;
  await expect(sheet.getByRole("button", { name: "Chooser task 0", exact: true })).toHaveCount(0);
});
