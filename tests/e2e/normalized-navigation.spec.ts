import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  openWorkspaceDirectory,
  selectCustomNewThreadTarget,
  selectRadixOption,
  sendCurrentDraft,
} from "./helpers";
import { loadE2ERunContext } from "./run-context.js";

const execFileAsync = promisify(execFile);

test("thread identity stays visible while its initial stream is loading", async ({ page }, testInfo) => {
  const projectName = `loading-header-${randomUUID().slice(0, 8)}`;
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, projectName);
  await mkdir(workspace, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspaceDirectory(page, workspace);
  const title = `Imported Codex history — ${projectName}`;
  const row = page.getByTestId("desktop-sidebar")
    .getByTestId("thread-row-link")
    .filter({ hasText: title });
  await expect(row).toBeVisible();

  // Keep the real application stream and inventory available, but prevent the
  // selected thread from receiving even its first snapshot until explicitly
  // released. This proves the header does not depend on backend attachment.
  let releaseStream!: () => void;
  const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
  let streamHeld = false;
  await page.route((url) => /^\/api\/threads\/[0-9a-f-]+\/events$/u.test(url.pathname), async (route) => {
    streamHeld = true;
    await streamGate;
    await route.continue();
  });

  try {
    await row.click();
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
    await expect.poll(() => streamHeld).toBe(true);
    const thread = page.getByTestId("thread-loading-view");
    await expect(thread.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(thread.locator(".thread-panel-brand")).toHaveAttribute("title", /Codex/);
    await expect(thread.locator(".thread-project-name")).toHaveText(projectName);
    await expect(thread.getByTestId("thread-target-context")).toContainText("Codex TCP external");
    await expect(thread.locator(".thread-worktree-label")).toHaveText("Primary");
    await expect(thread.getByRole("status")).toHaveText("Loading conversation…");
    await expect(thread.locator(':scope > header[aria-label="Chat panel header"] + .runtime-banner[role="status"]')).toBeVisible();
    await expect(thread.locator('[data-slot="skeleton"]').first()).toBeVisible();
    await expect(thread.locator("[data-item-kind]")).toHaveCount(0);
    await expect(thread.getByRole("textbox")).toHaveCount(0);
    await expect(thread.getByRole("button", { name: "Send message" })).toHaveCount(0);
    await expect(thread.getByRole("button", { name: "Thread actions" })).toHaveCount(0);
    await expect(thread.getByRole("button", { name: /^Thread worktree:/ })).toHaveCount(0);
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "thread-header-loading-desktop.png");

    await page.setViewportSize({ width: 412, height: 915 });
    await expect(thread.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(thread.locator(".thread-project-name")).toBeVisible();
    await expect(thread.getByRole("status")).toHaveText("Loading conversation…");
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "thread-header-loading-mobile.png");

    releaseStream();
    const loadedThread = page.getByTestId("thread-view");
    await expect(loadedThread.locator('[data-item-kind="user_message"]').getByText(
      "Explain how this imported Codex conversation is preserved.",
      { exact: true },
    )).toBeVisible();
    await expect(loadedThread.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(thread).toHaveCount(0);
    await expect(loadedThread.getByRole("button", { name: "Thread actions" })).toBeVisible();
  } finally {
    releaseStream();
  }
});

test("mobile worktree removal closes its sheet before cancellation or confirmation", async ({ page }, testInfo) => {
  const fixtureRoot = path.join(loadE2ERunContext().workspacesDirectory, `mobile-worktree-${randomUUID()}`);
  const primary = path.join(fixtureRoot, "primary");
  const linked = path.join(fixtureRoot, "linked");
  await mkdir(primary, { recursive: true });
  const git = (...args: string[]) => execFileAsync("git", ["-C", primary, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  await git("init", "--quiet");
  await git("config", "user.name", "Sedes E2E");
  await git("config", "user.email", "sedes-e2e@example.invalid");
  await writeFile(path.join(primary, "README.md"), "Mobile worktree removal fixture\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "Seed mobile worktree fixture");
  await git("worktree", "add", "--quiet", "-b", "mobile-removal", linked);

  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspaceDirectory(page, primary);
  await createDraftThread(page);
  await page.setViewportSize({ width: 412, height: 915 });
  await page.getByRole("button", { name: "Show thread toolbar" }).click();
  const picker = page.getByRole("button", { name: /^Thread worktree:/ });
  await picker.click();
  const sheet = page.getByRole("dialog", { name: "Thread worktree", exact: true });
  await expect(sheet).toHaveClass(/thread-worktree-sheet/);
  await sheet.getByRole("button", { name: "Remove mobile-removal", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Remove linked worktree?", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(".thread-settings-sheet-overlay")).toHaveCount(0);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "worktree-remove-confirmation-mobile.png");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await stat(linked)).isDirectory()).toBe(true);

  await picker.click();
  await sheet.getByRole("button", { name: "Remove mobile-removal", exact: true }).click();
  await confirmation.getByRole("button", { name: "Remove worktree", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect.poll(async () => stat(linked).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })).toBe(false);
  await picker.click();
  await expect(sheet.getByRole("button", { name: "Remove mobile-removal", exact: true })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Select Primary", exact: true })).toBeVisible();
});

test.describe.serial("normalized target and mobile navigation", () => {
  test("explicit target selection reaches the alternate shared backend connection", async ({
    page,
  }) => {
    await openSedesWorkspace(page);
    const newThread = page
      .getByTestId("desktop-sidebar")
      .getByTestId("new-thread-trigger");
    await expect(newThread).toBeVisible();
    await newThread.click();
    const picker = await selectCustomNewThreadTarget(
      page,
      "Alternate scripted agent · Pi SDK",
    );
    const alternateTargetId = await picker.getAttribute("data-target-id");
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/threads") &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "Create thread" }).click();
    const response = await created;
    expect(response.request().postDataJSON()).toMatchObject({
      configuration: { kind: "custom", targetId: alternateTargetId },
    });
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).toBeVisible();
  });

  test("a moved workspace ends cold thread loading with an actionable error", async ({
    page,
  }, testInfo) => {
    const workspaceName = `moved-workspace-${randomUUID()}`;
    const workspace = path.join(
      loadE2ERunContext().workspacesDirectory,
      workspaceName,
    );
    const movedWorkspace = `${workspace}-removed`;
    await mkdir(workspace, { recursive: true });
    let workspaceMoved = false;
    try {
      await openWorkspaceDirectory(page, workspace);
      const threadPath = await createDraftThread(page);
      await fillAndPersistDraft(
        page,
        "Bind this thread before moving its workspace",
      );
      await sendCurrentDraft(page);
      await expect(
        page.locator(
          '[data-item-kind="assistant_message"][data-item-status="completed"]',
        ),
      ).toBeVisible({ timeout: 15_000 });

      const threadId = threadPath.slice(threadPath.lastIndexOf("/") + 1);
      await page.goto("/");
      await page.reload();
      const evicted = await page.request.post(
        `/__e2e/threads/${threadId}/close-idle-runtime`,
      );
      expect(evicted.status()).toBe(204);
      await rename(workspace, movedWorkspace);
      workspaceMoved = true;

      let eventRequests = 0;
      page.on("request", (request) => {
        if (
          request.method() === "GET" &&
          new URL(request.url()).pathname === `/api/threads/${threadId}/events`
        ) {
          eventRequests += 1;
        }
      });
      await page.goto(threadPath);
      await expect(
        page.getByRole("heading", { name: "Couldn’t open this thread" }),
      ).toBeVisible();
      await expect(
        page.getByText("The workspace directory was moved or removed."),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Try again" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Back to threads" }),
      ).toBeVisible();
      await capture(page, testInfo, "moved-workspace-load-error.png");
      // Chromium's native EventSource retry interval is approximately three
      // seconds. Waiting beyond it catches the old opaque reconnect loop; the
      // transport unit test remains the deterministic no-reopen authority.
      await page.waitForTimeout(4_000);
      expect(eventRequests).toBe(1);

      await rename(movedWorkspace, workspace);
      workspaceMoved = false;
      await page.getByRole("button", { name: "Try again" }).click();
      await expect.poll(() => eventRequests).toBe(2);
      await expect(
        page.locator(
          '[data-item-kind="assistant_message"][data-item-status="completed"]',
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message Scripted agent" }),
      ).toBeEnabled();
    } finally {
      if (workspaceMoved) await rename(movedWorkspace, workspace);
    }
  });

  test("mobile drawer navigates to a live normalized thread", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openSedesWorkspace(page);
    const mobileThreadPath = await createDraftThread(page);
    await fillAndPersistDraft(page, "Prepare a thread for mobile settings");
    await sendCurrentDraft(page);
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toBeVisible({ timeout: 15_000 });

    await page.setViewportSize({ width: 456, height: 844 });
    await page.evaluate(() =>
      window.localStorage.setItem("sedes-sidebar-collapsed", "true"),
    );
    await page.goto("/");
    const navigation = page.getByRole("button", {
      name: "Open thread navigation",
    });
    await expect(navigation).toBeVisible();
    await navigation.click();
    const drawer = page.getByRole("dialog", { name: "Thread navigation" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("new-thread-trigger")).toBeVisible();
    await drawer.getByTestId("new-thread-trigger").click();
    const creation = page.getByRole("dialog", { name: "New thread" });
    await expect(creation).toBeVisible();
    await expect(page.locator(".new-thread-sheet-overlay")).toBeVisible();
    await expect
      .poll(async () => {
        const currentBox = await creation.boundingBox();
        return currentBox
          ? Math.abs(currentBox.y + currentBox.height - 844)
          : 844;
      })
      .toBeLessThanOrEqual(2);
    const creationBox = await creation.boundingBox();
    expect(creationBox).not.toBeNull();
    expect(Math.abs(creationBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(creationBox!.width - 456)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(creationBox!.y + creationBox!.height - 844),
    ).toBeLessThanOrEqual(2);
    const mobileTargetPicker = creation.getByRole("combobox", {
      name: "Target",
      exact: true,
    });
    await expect(mobileTargetPicker).toBeVisible();
    await mobileTargetPicker.click();
    await expect(
      page.getByRole("option", { name: "Alternate scripted agent · Pi SDK" }),
    ).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "normalized-target-picker-mobile.png");
    await creation.getByRole("button", { name: "Cancel" }).click();

    const completedRow = drawer
      .getByTestId("thread-row-link")
      .filter({ hasText: "New thread" })
      .first();
    await completedRow.click();
    await expect(drawer).toBeHidden();
    await expect(page.getByTestId("thread-view")).toBeVisible();
    await page.goto(mobileThreadPath);
    await expect(
      page.locator('[data-item-kind="assistant_message"]'),
    ).toBeVisible();
    const threadToolbarToggle = page.getByRole("button", {
      name: "Show thread toolbar",
    });
    await expect(threadToolbarToggle).toBeVisible();
    await expect(page.getByTestId("thread-target-context")).toHaveCount(0);
    await expect(page.locator(".thread-project-name")).toBeVisible();
    const bookmarks = page.getByRole("button", { name: "Bookmarks", exact: true });
    const settings = page.getByRole("button", { name: "Thread actions" });
    const collapseChat = page.getByRole("button", { name: "Collapse Chat panel" });
    const closeChat = page.getByRole("button", { name: "Close Chat panel", exact: true });
    const headerControls = [bookmarks, settings, threadToolbarToggle, collapseChat, closeChat];
    const headerBoxes = [];
    for (const control of headerControls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(28);
      expect(box!.height).toBeGreaterThanOrEqual(28);
      headerBoxes.push(box!);
    }
    for (let index = 1; index < headerBoxes.length; index += 1) {
      expect(headerBoxes[index]!.x).toBeGreaterThan(headerBoxes[index - 1]!.x);
      expect(Math.abs(headerBoxes[index]!.y - headerBoxes[0]!.y)).toBeLessThanOrEqual(1);
    }
    await capture(page, testInfo, "thread-header-mobile-collapsed.png");
    await threadToolbarToggle.click();
    await expect(
      page.getByRole("button", { name: "Hide thread toolbar" }),
    ).toBeVisible();
    const findInThread = page.getByRole("button", {
      name: "Find in thread",
    });
    const tasksToggle = page
      .getByTestId("workspace-workbench-bar")
      .getByTestId("tasks-panel-toggle");
    await expect(findInThread).toBeVisible();
    await expect(tasksToggle).toBeVisible();
    const worktree = page.getByRole("button", { name: /^Thread worktree:/ });
    await expect(worktree).toBeVisible();
    const searchButtonBox = await findInThread.boundingBox();
    const worktreeBox = await worktree.boundingBox();
    expect(searchButtonBox).not.toBeNull();
    expect(worktreeBox).not.toBeNull();
    expect(searchButtonBox!.x + searchButtonBox!.width).toBeLessThanOrEqual(worktreeBox!.x);
    expect(Math.abs(searchButtonBox!.y + searchButtonBox!.height / 2 - worktreeBox!.y - worktreeBox!.height / 2)).toBeLessThanOrEqual(1);
    await capture(page, testInfo, "thread-header-mobile-expanded.png");
    await findInThread.click();
    const threadSearch = page.getByRole("searchbox", {
      name: "Find in thread",
    });
    await expect(threadSearch).toBeFocused();
    await expect(page.locator(".thread-find-count")).toBeEmpty();
    await expect(
      page.getByRole("button", { name: "Match case" }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Match whole word" }),
    ).toBeHidden();
    await threadSearch.fill("thread");
    await expect(page.locator(".thread-find-count")).toHaveText(
      /^1 of \d+$/,
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            CSS as unknown as {
              highlights?: Map<string, { size: number }>;
            }
          ).highlights?.get("sedes-thread-find-match")?.size ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "Next match" }).click();
    const findCount = page.locator(".thread-find-count");
    await expect(findCount).toHaveText(/^\d+ of \d+$/);
    expect(
      await findCount.evaluate((count) => ({
        clipped: count.scrollWidth > count.clientWidth,
        flexShrink: getComputedStyle(count).flexShrink,
      })),
    ).toEqual({ clipped: false, flexShrink: "0" });
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "thread-find-mobile.png");
    const searchBox = await threadSearch.boundingBox();
    expect(searchBox).not.toBeNull();
    expect(searchBox!.y).toBeGreaterThanOrEqual(searchButtonBox!.y + searchButtonBox!.height);
    await page.getByRole("button", { name: "Hide thread toolbar" }).click();
    await expect(threadSearch).toBeHidden();
    await expect(findInThread).toBeHidden();
    await expect(bookmarks).toBeVisible();
    await expect(settings).toBeVisible();
    await threadToolbarToggle.click();
    await expect(findInThread).toBeVisible();
    await expect(threadSearch).toBeHidden();
    await findInThread.click();
    await expect(threadSearch).toHaveValue("thread");
    await expect(findCount).toHaveText(/^\d+ of \d+$/);
    await page.getByRole("button", { name: "Hide thread toolbar" }).click();
    await expect(threadSearch).toBeHidden();
    await page.keyboard.press("Control+f");
    await expect(page.getByRole("button", { name: "Hide thread toolbar" })).toBeVisible();
    await expect(threadSearch).toBeFocused();
    await expect(threadSearch).toHaveValue("thread");
    await capture(page, testInfo, "thread-find-mobile-restored.png");
    await threadSearch.fill("definitely-not-in-this-thread");
    await expect(findCount).toHaveText("0 of 0");
    await page.keyboard.press("Escape");
    await expect(findInThread).toBeFocused();
    await expect(page.locator(".thread-find-bar")).toHaveAttribute(
      "data-open",
      "false",
    );
    await page.getByRole("button", { name: "Thread actions" }).click();
    const actionsSheet = page.getByTestId("thread-settings-sheet");
    await expect(actionsSheet).toHaveAccessibleName("Thread settings");
    const mobileModelPicker = actionsSheet.getByRole("combobox", {
      name: "Model",
    });
    await expect(mobileModelPicker).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Tools" })).toBeVisible();
    await mobileModelPicker.click();
    const mobileModelSearch = page.getByRole("searchbox", {
      name: "Search models",
    });
    await expect(mobileModelSearch).not.toBeFocused();
    await expect(page.getByRole("dialog", { name: "Choose model", exact: true })).toBeFocused();
    await mobileModelSearch.click();
    await expect(mobileModelSearch).toBeFocused();
    await mobileModelSearch.fill("conformance");
    await expect(
      page.getByRole("option", { name: "Conformance model" }),
    ).toBeVisible();
    await expect(actionsSheet).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "normalized-model-picker-mobile.png");
    await page.keyboard.press("Escape");
    await expect(mobileModelPicker).toBeFocused();
    await expect(actionsSheet).toBeVisible();
    const thinking = page.getByRole("combobox", { name: "Thinking" });
    await expect(thinking).toBeVisible();
    const settingResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().kind === "perform" &&
        response.request().postDataJSON().operation?.action === "set_setting" &&
        response.request().postDataJSON().operation?.settingId ===
          "thinking_level",
    );
    await selectRadixOption(page, thinking, "High");
    await settingResponse;
    await expect(thinking).toContainText("High");
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByRole("button", { name: "Thread actions" }).click();
    await expect(
      page.getByRole("combobox", { name: "Thinking" }),
    ).toContainText("High");
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "normalized-thread-mobile.png");
    await page.keyboard.press("Escape");
    await navigation.click();
    await expect(drawer).toBeVisible();
    const selectedRow = drawer.locator(
      '[data-testid="thread-row"][data-selected="true"]',
    );
    await expect(selectedRow.getByTestId("thread-row-archive")).toBeHidden();
    await expect(
      selectedRow.getByRole("button", { name: /^Settle / }),
    ).toBeHidden();
    await expect(selectedRow.locator(".thread-meta")).toBeVisible();
    await expect(selectedRow).toHaveCSS("user-select", "none");
    await expect(selectedRow.locator(".thread-meta")).toHaveCSS("user-select", "none");
    const rowBounds = await selectedRow.boundingBox();
    expect(rowBounds).not.toBeNull();
    const longPressPoint = {
      clientX: Math.round(rowBounds!.x + rowBounds!.width / 2),
      clientY: Math.round(rowBounds!.y + rowBounds!.height / 2),
    };
    await selectedRow.dispatchEvent("pointerdown", {
      pointerType: "touch",
      button: 0,
      ...longPressPoint,
    });
    await page.waitForTimeout(600);
    const rowSheet = page.getByTestId("thread-actions-sheet");
    await expect(rowSheet).toBeVisible();
    await expect(rowSheet).toHaveCSS("user-select", "none");
    await expect(rowSheet.getByRole("heading", { name: "Thread actions" })).toHaveCSS("user-select", "none");
    await expect(
      rowSheet.getByRole("heading", { name: "Thread actions" }),
    ).toBeVisible();
    await expect(page.getByTestId("thread-context-menu")).toHaveCount(0);
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "thread-actions-sheet-mobile.png");
    let releaseArchiveCheck!: () => void;
    const archiveCheckGate = new Promise<void>((resolve) => {
      releaseArchiveCheck = resolve;
    });
    await page.route("**/inventory/archive-impact", async (route) => {
      await archiveCheckGate;
      await route.continue();
    });
    await rowSheet
      .getByRole("button", { name: "Archive", exact: true })
      .click();
    const checkingArchive = page.getByRole("dialog", {
      name: "Checking thread activity",
      exact: true,
    });
    await expect(checkingArchive).toBeVisible();
    await expect(page.locator(".operation-overlay-backdrop")).toHaveCSS("z-index", "110");
    await expect(
      checkingArchive.getByText("Checking thread activity…", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Archive", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await expect(checkingArchive).toBeVisible();
    await capture(page, testInfo, "archive-checking-mobile.png");
    releaseArchiveCheck();
    await expect(rowSheet).toBeHidden();
    const archiveDialog = page.getByRole("dialog", {
      name: "Archive this thread",
    });
    await expect(archiveDialog).toBeVisible();
    const archiveThisThread = archiveDialog.getByRole("button", {
      name: "Archive",
      exact: true,
    });
    await expect(archiveThisThread).toBeEnabled();
    await capture(page, testInfo, "archive-choice-mobile.png");
    await archiveThisThread.click();
    await expect(page).toHaveURL("/");
    await expect(drawer).toBeVisible();
  });
});
