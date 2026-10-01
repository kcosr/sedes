import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { loadE2ERunContext } from "./run-context.js";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { capture, createDraftThread, overlaySettled } from "./helpers";
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

test.describe.serial("Tasks panel", () => {
  test("global tasks from home, per-scope creation, completion, and re-scope from a thread", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTaskWorkspace(page);

    // Home has no panels and no implicit task destination: Tasks is a
    // popover anchored to the corner toggle, with no pin and no resize.
    const homeTasksToggle = page.getByTestId("tasks-panel-toggle").first();
    await homeTasksToggle.click();
    const panel = page.locator('[data-slot="tasks-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-presentation", "popover");
    await expect(homeTasksToggle).toHaveAttribute("aria-expanded", "true");
    const popoverBox = await panel.boundingBox();
    const toggleBox = await homeTasksToggle.boundingBox();
    expect(popoverBox!.y).toBeGreaterThanOrEqual(toggleBox!.y + toggleBox!.height);
    expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(1440);
    await expect(panel.getByRole("button", { name: /Pin Tasks panel/ })).toHaveCount(0);
    await expect(page.getByRole("separator", { name: "Resize Tasks panel" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Close Tasks panel" }).click();
    await expect(panel).toHaveCount(0);
    await expect(homeTasksToggle).toBeFocused();
    await homeTasksToggle.click();
    await expect(panel).toBeVisible();
    // An outside press dismisses the popover; the toggle reopens it.
    await page
      .getByRole("heading", { name: "What should the agent work on?" })
      .click();
    await expect(panel).toHaveCount(0);
    await homeTasksToggle.click();
    await expect(panel).toBeVisible();
    // View options belong to the view in front: Thread, the first view.
    await expect(panel.getByRole("radio", { name: "Thread" })).toBeChecked();
    const panelOptions = panel.getByRole("button", {
      name: "Tasks panel options",
    });
    await panelOptions.click();
    // The last view is remembered; there is no default-view preference.
    await expect(page.getByRole("group", { name: "Default view" })).toHaveCount(0);
    const searchContent = page.getByRole("menuitemcheckbox", {
      name: "Search task content",
    });
    await expect(searchContent).not.toBeChecked();
    // Choosing a menu row closes the menu.
    await searchContent.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(panel.getByRole("radio", { name: "Project" })).toBeEnabled();
    await expect(panel.getByRole("radio", { name: "Thread" })).toBeEnabled();
    await panel.getByRole("radio", { name: "Project" }).click();
    await panel.getByPlaceholder("Search or add task").fill("Needs a destination");
    await expect(panel.getByRole("button", { name: "Add task" })).toBeDisabled();
    await panel.getByRole("combobox", { name: "Task project" }).click();
    await page.getByRole("combobox", { name: "Search projects" }).fill("task-workspace");
    const projectChoice = page.getByRole("option").filter({ hasText: "task-workspace" });
    await expect(projectChoice).toHaveCount(1);
    await capture(page, testInfo, "tasks-project-search-desktop.png");
    await projectChoice.click();
    await expect(panel.getByRole("button", { name: "Add task" })).toBeEnabled();
    await panel.getByRole("radio", { name: "Global" }).click();
    await panel.getByPlaceholder("Search or add task").fill("Global errand");
    await panel.getByRole("button", { name: "Add task" }).click();
    await expect(
      panel.getByRole("button", { name: 'View "Global errand"' }),
    ).toBeVisible();
    await expect(panel.locator(".tasks-detail-title")).toHaveText(
      "Global errand",
    );
    await expect(
      panel.getByRole("button", { name: "Edit", exact: true }),
    ).toBeVisible();
    await capture(page, testInfo, "tasks-panel-home-global.png");

    // Thread route: Tasks docks beside Chat; create a thread task.
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
    await expect(panel.getByRole("radio", { name: "Thread" })).toBeEnabled();
    await panel.getByRole("radio", { name: "Thread" }).click();
    await panel.getByPlaceholder("Search or add task").fill("Verify endpoint");
    await panel.getByPlaceholder("Search or add task").press("Enter");
    const threadTask = panel
      .locator(".tasks-row")
      .filter({ hasText: "Verify endpoint" });
    await expect(threadTask).toBeVisible();
    await expect(panel.locator(".tasks-detail-title")).toHaveText(
      "Verify endpoint",
    );
    await expect(
      sidebarThread.getByRole("img", { name: "1 open task" }),
    ).toBeVisible();
    await expect(threadTasksToggle).toHaveAccessibleName(
      "Close Tasks panel, 1 open task",
    );
    await expect(
      threadTasksToggle.locator('[data-slot="count-badge"]'),
    ).toHaveText("1");

    // Docked Tasks is a panel of its own and stays on stage when Chat collapses.
    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await expect(panel).toBeVisible();
    await expect(threadTasksToggle).toBeVisible();
    await expect(panel.getByRole("radio", { name: "Thread" })).toBeChecked();
    await threadTasksToggle.click();
    await expect(panel).toHaveCount(0);
    await threadTasksToggle.click();
    await expect(threadTask).toBeVisible();
    await capture(page, testInfo, "tasks-chat-collapsed.png");
    await page.getByRole("button", { name: "Open Chat panel", exact: true }).click();
    // Reopening Chat requests composer focus after its retained panel mounts.
    // Let that transition finish before typing into another panel's input.
    await expect(page.getByRole("textbox", { name: "Message Scripted agent", exact: true })).toBeFocused();

    // Pinning stays on the task row; file metadata and scope use the editor.
    // Explicitly choosing the input cancels Chat's deferred focus request.
    // fill() alone does not dispatch pointerdown and can race its next frame.
    const taskInput = panel.getByPlaceholder("Search or add task");
    await taskInput.click();
    await expect(taskInput).toBeFocused();
    await taskInput.fill("Unpinned follow-up");
    await expect(taskInput).toHaveValue("Unpinned follow-up");
    await taskInput.press("Enter");
    await expect(
      sidebarThread.getByRole("img", { name: "2 open tasks" }),
    ).toBeVisible();
    await expect(threadTasksToggle).toHaveAccessibleName(
      "Close Tasks panel, 2 open tasks",
    );
    await expect(
      threadTasksToggle.locator('[data-slot="count-badge"]'),
    ).toHaveText("2");
    await threadTask
      .getByRole("button", { name: 'Pin "Verify endpoint"' })
      .click();
    await expect(
      threadTask.getByRole("button", { name: 'Unpin "Verify endpoint"' }),
    ).toBeVisible({ timeout: TASK_MUTATION_TIMEOUT_MS });
    await threadTask
      .getByRole("button", { name: 'View "Verify endpoint"' })
      .click();
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    let editor = panel.locator(".tasks-editor");
    await editor
      .getByRole("textbox", { name: "Absolute file path" })
      .fill(taskReadme);
    await editor.getByRole("button", { name: "Add file" }).click();
    await editor
      .getByRole("textbox", { name: "Task notes" })
      .fill("Open the linked project file");
    await editor.getByRole("button", { name: "Save task" }).click();
    await expect(editor).toHaveCount(0, {
      timeout: TASK_MUTATION_TIMEOUT_MS,
    });
    await expect(
      threadTask.getByRole("button", { name: 'Unpin "Verify endpoint"' }),
    ).toBeVisible();
    await expect
      .poll(() => panel.locator(".tasks-row-title").allTextContents())
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
    await panel
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
    await threadTask
      .getByRole("button", { name: 'View "Verify endpoint"' })
      .click();

    // Complete it.
    await threadTask
      .getByRole("checkbox", { name: 'Mark "Verify endpoint" as done' })
      .click();
    await expect(
      threadTask.getByRole("checkbox", {
        name: 'Mark "Verify endpoint" as open',
      }),
    ).toBeVisible({ timeout: TASK_MUTATION_TIMEOUT_MS });
    await expect(
      sidebarThread.getByRole("img", {
        name: "1 open task",
      }),
    ).toBeVisible();

    // Project view is a pure filter: the thread task must not appear there.
    await panel.getByRole("radio", { name: "Project" }).click();
    await expect(panel.getByText("Verify endpoint")).toHaveCount(0);
    await expect(panel.getByText("No project tasks yet.")).toBeVisible();
    const includeNestedScopes = panel.getByRole("checkbox", {
      name: "Include nested scopes",
    });
    await includeNestedScopes.check();
    await expect(
      panel.getByRole("button", { name: 'View "Verify endpoint"' }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: 'View "Unpinned follow-up"' }),
    ).toBeVisible();
    await includeNestedScopes.uncheck();
    await expect(panel.getByText("Verify endpoint")).toHaveCount(0);

    // Re-scope the thread task to the project via the details editor.
    await panel.getByRole("radio", { name: "Thread" }).click();
    await threadTask
      .getByRole("button", { name: 'View "Verify endpoint"' })
      .click();
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    editor = panel.locator(".tasks-editor");
    await expect(editor).toBeVisible();
    await editor
      .getByRole("radiogroup", { name: "Task scope" })
      .getByRole("radio", { name: "Project" })
      .click();
    await editor.getByRole("combobox", { name: "Assign task to project" }).click();
    await page.getByRole("combobox", { name: "Search projects" }).fill("task-workspace");
    await page.getByRole("option").filter({ hasText: "task-workspace" }).click();
    await capture(page, testInfo, "tasks-assign-project-desktop.png");
    await editor
      .getByRole("textbox", { name: "Task notes" })
      .fill("Moved up to the project");
    const taskRescoped = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        /\/api\/tasks\/[^/]+$/u.test(new URL(response.url()).pathname) &&
        response.ok(),
      { timeout: TASK_MUTATION_TIMEOUT_MS },
    );
    await editor.getByRole("button", { name: "Save task" }).click();
    await taskRescoped;
    await expect(editor).toHaveCount(0, {
      timeout: TASK_MUTATION_TIMEOUT_MS,
    });
    await expect(panel.getByText("Unpinned follow-up")).toBeVisible();
    await expect(panel.getByText("Verify endpoint")).toHaveCount(0);
    await expect(
      sidebarThread.getByRole("img", { name: "1 open task" }),
    ).toBeVisible();
    await expect(threadTasksToggle).toHaveAccessibleName(
      "Close Tasks panel, 1 open task",
    );
    await expect(
      threadTasksToggle.locator('[data-slot="count-badge"]'),
    ).toHaveText("1");
    const followUpTask = panel
      .locator(".tasks-row")
      .filter({ hasText: "Unpinned follow-up" });
    await followUpTask
      .getByRole("checkbox", { name: 'Mark "Unpinned follow-up" as done' })
      .click();
    await expect(
      followUpTask.getByRole("checkbox", {
        name: 'Mark "Unpinned follow-up" as open',
      }),
    ).toBeVisible({ timeout: TASK_MUTATION_TIMEOUT_MS });
    await expect(sidebarThread.getByRole("img", { name: /task/i })).toHaveCount(
      0,
      { timeout: TASK_MUTATION_TIMEOUT_MS },
    );
    await expect(threadTasksToggle).toHaveAccessibleName("Close Tasks panel");
    await expect(
      threadTasksToggle.locator('[data-slot="count-badge"]'),
    ).toHaveCount(0);
    await panel.getByRole("radio", { name: "Project" }).click();
    const projectTask = panel
      .locator(".tasks-row")
      .filter({ hasText: "Verify endpoint" });
    await expect(projectTask).toBeVisible();
    await capture(page, testInfo, "tasks-panel-project-after-move.png");

    // Global view still shows only the global task.
    await panel.getByRole("radio", { name: "Global" }).click();
    await expect(panel.getByText("Global errand")).toBeVisible();
    await expect(panel.getByText("Verify endpoint")).toHaveCount(0);
    await includeNestedScopes.check();
    await expect(
      panel.getByRole("button", { name: 'View "Global errand"' }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: 'View "Verify endpoint"' }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: 'View "Unpinned follow-up"' }),
    ).toBeVisible();
    await capture(page, testInfo, "tasks-panel-global-nested.png");

    // The docked panel, its width and the per-view options survive a reload.
    await page.reload();
    await expect(page.locator('[data-slot="tasks-panel"]')).toBeVisible();
    await expect(panel).toHaveAttribute("data-presentation", "panel");
    await expect
      .poll(async () => (await tasksLeaf.boundingBox())?.width ?? 0)
      .toBeCloseTo(widenedWidth, 0);
    await panel.getByRole("radio", { name: "Global" }).click();
    await expect(
      panel.getByRole("checkbox", { name: "Include nested scopes" }),
    ).toBeChecked();
    await expect(
      panel.getByRole("button", { name: 'View "Verify endpoint"' }),
    ).toBeVisible();
    // Search content was switched on for the Thread view, on Home.
    await panel.getByRole("radio", { name: "Thread" }).click();
    await panelOptions.click();
    await expect(
      page.getByRole("menuitemcheckbox", { name: "Search task content" }),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await panel.getByRole("radio", { name: "Global" }).click();
    await panelOptions.click();
    await expect(
      page.getByRole("menuitemcheckbox", { name: "Search task content" }),
    ).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // On mobile, Tasks is available without expanding the thread toolbar.
    await panel.getByRole("button", { name: "Close Tasks panel" }).click();
    await page.setViewportSize({ width: 412, height: 915 });
    await expect(page.getByTestId("thread-controls")).toBeHidden();
    await expect(threadTasksToggle).toBeVisible();
    await threadTasksToggle.click();
    const sheet = page.getByRole("dialog", { name: "Tasks", exact: true });
    await expect(sheet).toBeVisible();
    await expect(panel).toHaveAttribute("data-presentation", "sheet");
    await expect(page.locator('[data-panel-id="tasks"]')).toHaveCount(0);
    // The sheet opens on the last view chosen, whatever presented it.
    await expect(sheet.getByRole("radio", { name: "Global" })).toBeChecked();
    await sheet.getByRole("radio", { name: "Thread" }).click();
    await expect(sheet.getByRole("radio", { name: "Thread" })).toBeChecked();
    await expect(sheet.getByRole("combobox", { name: "Task thread", exact: true })).toContainText("Current thread");
    await sheet.getByRole("combobox", { name: "Task thread" }).click();
    const threadSearch = page.getByRole("combobox", { name: "Search threads" });
    await expect(threadSearch).not.toBeFocused();
    await threadSearch.click();
    await expect(threadSearch).toBeFocused();
    await threadSearch.fill(threadId);
    const threadChoice = page.getByRole("option").filter({ hasText: "task-workspace" });
    await expect(threadChoice).toHaveCount(1);
    await capture(page, testInfo, "tasks-thread-search-mobile.png");
    await threadChoice.click();
    await expect(sheet).toBeVisible();
    const selectedThread = sheet.getByRole("combobox", { name: "Task thread", exact: true });
    await expect(selectedThread).not.toContainText("Current thread");
    await expect(selectedThread.locator(".searchable-select-field-label")).toHaveCount(0);
    await capture(page, testInfo, "tasks-thread-selected-mobile.png");
    await expect(sheet.getByRole("button", { name: 'View "Unpinned follow-up"' })).toBeVisible();
    await sheet.getByRole("radio", { name: "Global" }).click();
    await expect(sheet.getByRole("radio", { name: "Global" })).toBeChecked();
    await expect(sheet.getByRole("button", { name: 'View "Global errand"' })).toBeVisible();
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
    await page.getByTestId("tasks-panel-toggle").first().click();
    const panel = page.locator('[data-slot="tasks-panel"]');
    await panel.getByRole("radio", { name: "Thread" }).click();
    await panel.getByPlaceholder("Search or add task").fill("Restart service");
    await panel.getByPlaceholder("Search or add task").press("Enter");
    await expect(
      panel.getByRole("button", { name: 'View "Restart service"' }),
    ).toBeVisible();
    await expect(panel.locator(".tasks-detail-title")).toHaveText(
      "Restart service",
    );

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
    await panel.getByRole("radio", { name: "Project" }).click();
    const moved = panel
      .locator(".tasks-row")
      .filter({ hasText: "Restart service" });
    await expect(moved).toBeVisible();
    await capture(page, testInfo, "tasks-archive-moved-to-project.png");
    await panel.getByRole("radio", { name: "Thread", exact: true }).click();
    await panel.getByRole("combobox", { name: "Task thread", exact: true }).click();
    await page.getByRole("combobox", { name: "Search threads" }).fill(archivedThreadPath.split("/").at(-1)!);
    await expect(page.getByText("No matching threads.", { exact: true })).toBeVisible();
  });
});

for (const action of ["Settle", "Archive"] as const) {
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
      action === "Settle" ? "settled" : "archived",
    );
  });
}


test("mobile task destinations remain usable with long lists and short viewports", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTaskWorkspace(page);
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
      data: { path: projectPath, environmentId: workspace.environmentId },
    })).ok()).toBe(true);
    expect((await page.request.post("/api/tasks", {
      headers,
      data: { mutationId: randomUUID(), title: `Chooser task ${index}`, scope: { kind: "global" } },
    })).ok()).toBe(true);
  }
  await page.reload();
  await page.setViewportSize({ width: 412, height: 915 });
  await page.getByTestId("tasks-panel-toggle").first().click();
  const sheet = page.getByRole("dialog", { name: "Tasks", exact: true });
  await sheet.getByRole("radio", { name: "Project", exact: true }).click();
  await sheet.getByRole("combobox", { name: "Task project", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "Choose task project", exact: true });
  await expect(chooser).toBeVisible();
  await chooser.getByRole("combobox", { name: "Search projects" }).fill("Chooser project");
  await expect(chooser.getByRole("option")).toHaveCount(12);
  const options = chooser.getByRole("listbox");
  expect(await options.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await overlaySettled(chooser);
  const bounds = await chooser.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(915);
  await capture(page, testInfo, "tasks-project-chooser-mobile-long-results.png");
  await chooser.getByRole("option").filter({ hasText: "Chooser project 11" }).click();
  await expect(chooser).toHaveCount(0);
  await expect(sheet.getByRole("combobox", { name: "Task project", exact: true })).toContainText("Chooser project 11");

  await sheet.getByRole("radio", { name: "Global", exact: true }).click();
  await sheet.getByRole("button", { name: 'View "Chooser task 0"', exact: true }).click();
  await sheet.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet.getByRole("radiogroup", { name: "Task scope", exact: true }).getByRole("radio", { name: "Project", exact: true }).click();
  await sheet.getByRole("combobox", { name: "Assign task to project", exact: true }).click();
  const assignment = page.getByRole("dialog", { name: "Choose assign task to project", exact: true });
  await expect(assignment).toBeVisible();
  await page.setViewportSize({ width: 412, height: 480 });
  await assignment.getByRole("combobox", { name: "Search projects" }).fill("Chooser project");
  await expect(assignment.getByRole("option")).toHaveCount(12);
  await overlaySettled(assignment);
  const compactBounds = await assignment.boundingBox();
  expect(compactBounds!.y).toBeGreaterThanOrEqual(0);
  expect(compactBounds!.y + compactBounds!.height).toBeLessThanOrEqual(480);
  await capture(page, testInfo, "tasks-project-chooser-mobile-short-viewport.png");
  await assignment.getByRole("option").filter({ hasText: "Chooser project 10" }).click();
  await expect(assignment).toHaveCount(0);
  await expect(sheet.getByRole("combobox", { name: "Assign task to project", exact: true })).toContainText("Chooser project 10");
});
