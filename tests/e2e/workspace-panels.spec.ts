import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  sendCurrentDraft,
} from "./helpers";
import {
  openPanel,
  openPanelIn,
  openPanelsMenu,
  panelAnnouncement,
  panelRow,
  quickButton,
  stagePanel,
} from "./workspace-panel-helpers";

/** Remembers a panel's node, to tell a retained panel from a remounted one. */
async function retain(locator: Locator, key: string): Promise<void> {
  await locator.evaluate((node, name) => {
    (window as unknown as Record<string, unknown>)[name] = node;
  }, key);
}

async function isRetained(locator: Locator, key: string): Promise<boolean> {
  return locator.evaluate(
    (node, name) => (window as unknown as Record<string, unknown>)[name] === node,
    key,
  );
}

async function savedLayout(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("sedes-panel-regions@1") ?? "null") as {
        readonly shown: Record<string, string | null>;
        readonly loaded: readonly string[];
        readonly sizes: Record<string, { readonly width?: number } | undefined>;
      } | null,
  );
}

/**
 * Waits for Files to finish reading its roots: closing it or reloading
 * meanwhile cancels the read, which is expected but counts as a failure.
 */
async function filesSettled(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: "Refresh workspace files" }),
  ).toBeEnabled({ timeout: 15_000 });
}

async function width(page: Page, title: "Chat" | "Files"): Promise<number> {
  return (await stagePanel(page, title).boundingBox())?.width ?? 0;
}

test.describe("panel workbench", () => {
  test("hide, show, close, empty stage, resize, persistence, and streaming keep loaded panels", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let threadEventRequests = 0;
    page.on("request", (request) => {
      if (
        /\/api\/threads\/[^/]+\/events$/.test(new URL(request.url()).pathname)
      ) {
        threadEventRequests += 1;
      }
    });
    await openSedesWorkspace(page);
    await createDraftThread(page);
    // The pre-region keys are only read, once, to migrate a device.
    await page.evaluate(() => {
      localStorage.setItem("sedes-panel-companions@1", "legacy-companions-marker");
    });

    const chat = page.getByTestId("thread-view");
    await expect(chat).toBeVisible();
    await retain(chat, "__chat");
    // Only Chat is loaded: one quick button, filled, and Chat in the middle.
    const loadedPanels = page
      .getByTestId("workspace-workbench-bar")
      .getByRole("group", { name: "Loaded panels" })
      .getByRole("button");
    await expect(loadedPanels).toHaveCount(1);
    await expect(quickButton(page, "Chat")).toHaveAccessibleName("Hide Chat panel");
    await expect(quickButton(page, "Chat")).toHaveAttribute("data-state", "visible");
    await expect(stagePanel(page, "Chat")).toHaveAttribute("data-region", "middle");
    await capture(page, testInfo, "panels-chat-default.png");

    // ▾ launches every panel, in the fixed order, each row saying its state.
    const menu = await openPanelsMenu(page);
    await expect
      .poll(() =>
        menu
          .locator("[data-panel-row]")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label"))),
      )
      .toEqual(["Chat, In the middle", "Files", "Workpads", "Tasks", "Terminals"]);
    await expect(menu.getByRole("menuitem", { name: "Reset layout" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Show all" })).toHaveCount(0);
    await capture(page, testInfo, "panels-menu-states.png");
    await panelRow(menu, "Files").click();
    const files = page.getByRole("region", { name: "Workspace files" });
    await expect(files).toBeVisible({ timeout: 15_000 });
    await expect(stagePanel(page, "Files")).toHaveAttribute("data-region", "right");
    await expect(quickButton(page, "Files")).toHaveAttribute("data-state", "visible");
    await expect(loadedPanels).toHaveCount(2);
    await filesSettled(page);
    await retain(files, "__files");

    // The divider resizes Files, remembered for the device.
    const defaultWidth = await width(page, "Files");
    const resize = page.getByRole("separator", { name: "Resize Files panel" });
    const resizeBox = (await resize.boundingBox())!;
    await page.mouse.move(
      resizeBox.x + resizeBox.width / 2,
      resizeBox.y + resizeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeBox.x + resizeBox.width / 2 - 72,
      resizeBox.y + resizeBox.height / 2,
      { steps: 4 },
    );
    await page.mouse.up();
    await expect.poll(() => width(page, "Files")).toBeGreaterThan(defaultWidth + 60);
    const resizedWidth = await width(page, "Files");
    expect((await savedLayout(page))?.sizes.files?.width).toEqual(expect.any(Number));
    await capture(page, testInfo, "panels-chat-files.png");

    // Chat's ✕ only hides it: it stays loaded, with its draft and node, and
    // the right region takes the stage.
    const composer = page.getByRole("textbox", { name: "Message Scripted agent" });
    await fillAndPersistDraft(page, "Hiding must retain this draft");
    await stagePanel(page, "Chat")
      .getByRole("button", { name: "Hide Chat panel", exact: true })
      .click();
    await expect(chat).toBeHidden();
    await expect(stagePanel(page, "Chat")).toHaveCount(0);
    await expect(panelAnnouncement(page)).toHaveText("Chat panel hidden.");
    await expect(quickButton(page, "Chat")).toHaveAccessibleName("Show Chat panel");
    await expect(quickButton(page, "Chat")).toHaveAttribute("data-state", "hidden");
    const stage = (await page.locator(".workspace-panel-stage").boundingBox())!;
    await expect.poll(() => width(page, "Files")).toBeCloseTo(stage.width, 0);
    const workbenchBar = page.getByTestId("workspace-workbench-bar");
    await workbenchBar.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.getByTestId("desktop-sidebar")).toBeHidden();
    await workbenchBar.getByRole("button", { name: "Show sidebar" }).click();
    await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
    await quickButton(page, "Chat").click();
    await expect(chat).toBeVisible();
    await expect(composer).toHaveValue("Hiding must retain this draft");
    expect(await isRetained(chat, "__chat")).toBe(true);
    await expect.poll(() => width(page, "Files")).toBeCloseTo(resizedWidth, 0);

    // A stream keeps running, without a new subscription, while Chat is hidden.
    await sendCurrentDraft(page);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await capture(page, testInfo, "panels-streaming.png");
    const requestsBeforeHiding = threadEventRequests;
    await quickButton(page, "Chat").click();
    await expect(chat).toBeHidden();
    await quickButton(page, "Chat").click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    expect(threadEventRequests).toBe(requestsBeforeHiding);
    expect(await isRetained(chat, "__chat")).toBe(true);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();

    // Files' quick button hides it, still loaded, and shows the same node.
    await quickButton(page, "Files").click();
    await expect(files).toBeHidden();
    await expect(panelAnnouncement(page)).toHaveText("Files panel hidden.");
    await expect(quickButton(page, "Files")).toHaveAttribute("data-state", "hidden");
    const hiddenMenu = await openPanelsMenu(page);
    await expect(panelRow(hiddenMenu, "Files")).toHaveAccessibleName("Files, Loaded, hidden");
    await page.keyboard.press("Escape");
    await expect(hiddenMenu).toBeHidden();
    await quickButton(page, "Files").click();
    await expect(files).toBeVisible();
    expect(await isRetained(files, "__files")).toBe(true);
    await filesSettled(page);

    // With nothing shown, the stage says so, and that survives a reload.
    await quickButton(page, "Files").click();
    await quickButton(page, "Chat").click();
    const empty = page.getByTestId("workspace-panel-empty");
    await expect(empty).toContainText("No panels are shown");
    await capture(page, testInfo, "panels-none-shown.png");
    expect(await savedLayout(page)).toMatchObject({
      shown: { middle: null, right: null },
      loaded: ["files"],
    });
    await page.reload();
    await expect(empty).toContainText("No panels are shown");
    await expect(quickButton(page, "Chat")).toHaveAttribute("data-state", "hidden");
    await expect(quickButton(page, "Files")).toHaveAttribute("data-state", "hidden");
    await quickButton(page, "Chat").click();
    await quickButton(page, "Files").click();
    await expect(chat).toBeVisible();
    await expect(files).toBeVisible({ timeout: 15_000 });
    await filesSettled(page);
    await expect.poll(() => width(page, "Files")).toBeCloseTo(resizedWidth, 0);
    expect(
      await page.evaluate(() => localStorage.getItem("sedes-panel-companions@1")),
    ).toBe("legacy-companions-marker");
    await retain(files, "__files");

    // ✕ closes Files: it unloads, its quick button goes, and reopening it
    // mounts new content in its place, at its remembered width.
    await stagePanel(page, "Files")
      .getByRole("button", { name: "Close Files panel", exact: true })
      .click();
    await expect(stagePanel(page, "Files")).toHaveCount(0);
    await expect(panelAnnouncement(page)).toHaveText("Files panel closed.");
    await expect(quickButton(page, "Files")).toHaveCount(0);
    await expect(loadedPanels).toHaveCount(1);
    const closedMenu = await openPanelsMenu(page);
    await expect(panelRow(closedMenu, "Files")).toHaveAccessibleName("Files");
    await panelRow(closedMenu, "Files").click();
    await expect(files).toBeVisible({ timeout: 15_000 });
    await expect(stagePanel(page, "Files")).toHaveAttribute("data-region", "right");
    await expect.poll(() => width(page, "Files")).toBeCloseTo(resizedWidth, 0);
    expect(await isRetained(files, "__files")).toBe(false);
    await filesSettled(page);
  });

  test("Tasks stays on the right with Chat hidden, follows thread switches, and selection shows and focuses Chat", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSedesWorkspace(page);
    const firstThreadPath = await createDraftThread(page);
    const secondThreadPath = await createDraftThread(page);
    const firstThreadId = firstThreadPath.split("/").at(-1)!;
    const secondThreadId = secondThreadPath.split("/").at(-1)!;

    const tasks = page.locator('[data-slot="tasks-panel"]');
    await expect(quickButton(page, "Tasks")).toHaveCount(0);
    await openPanel(page, "Tasks");
    await expect(tasks).toHaveAttribute("data-presentation", "panel");
    await expect(stagePanel(page, "Tasks")).toHaveAttribute("data-region", "right");
    await expect(quickButton(page, "Tasks")).toHaveAttribute("data-state", "visible");
    await stagePanel(page, "Chat")
      .getByRole("button", { name: "Hide Chat panel", exact: true })
      .click();
    await expect(stagePanel(page, "Chat")).toHaveCount(0);
    await expect(tasks).toBeVisible();

    // Selecting a thread shows its Chat wherever it lives, focused, and the
    // device's Tasks stays beside it.
    const selectThread = async (threadId: string, threadPath: string) => {
      await page
        .getByTestId("desktop-sidebar")
        .locator(`[data-thread-id="${threadId}"]`)
        .getByTestId("thread-row-link")
        .click();
      await expect(page).toHaveURL(threadPath);
      await expect(
        page.getByRole("textbox", { name: "Message Scripted agent" }),
      ).toBeFocused();
      await expect(stagePanel(page, "Chat")).toHaveCount(1);
      await expect(stagePanel(page, "Chat")).toHaveAttribute("data-region", "middle");
    };
    await selectThread(firstThreadId, firstThreadPath);
    await expect(stagePanel(page, "Tasks")).toBeVisible();
    await expect(tasks).toHaveAttribute("data-presentation", "panel");
    const chatBox = (await stagePanel(page, "Chat").boundingBox())!;
    const tasksBox = (await stagePanel(page, "Tasks").boundingBox())!;
    expect(tasksBox.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width);

    await stagePanel(page, "Chat")
      .getByRole("button", { name: "Hide Chat panel", exact: true })
      .click();
    await expect(stagePanel(page, "Chat")).toHaveCount(0);
    await selectThread(secondThreadId, secondThreadPath);
    await expect(stagePanel(page, "Tasks")).toBeVisible();
  });

  test("composer shrinks back to its empty height under reduced motion after Chat is hidden beside Files", async ({
    page,
  }) => {
    // A hidden Chat keeps the composer laid out with no content width, so the
    // placeholder wraps and the textarea measures at its 220px maximum. Reduced
    // motion gives every element a 0.01ms transition, which must not hold the
    // old height while the textarea measures itself back down.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSedesWorkspace(page);
    await createDraftThread(page);
    const textarea = page.getByRole("textbox", {
      name: "Message Scripted agent",
    });
    const height = () =>
      textarea.evaluate((element) => element.getBoundingClientRect().height);
    const empty = await height();

    await openPanel(page, "Files");
    await expect(
      page.getByRole("region", { name: "Workspace files" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect.poll(height).toBe(empty);
    await stagePanel(page, "Chat")
      .getByRole("button", { name: "Hide Chat panel", exact: true })
      .click();
    await expect(page.getByTestId("thread-view")).toBeHidden();
    await quickButton(page, "Chat").click();
    await expect(textarea).toBeVisible();
    await expect.poll(height).toBe(empty);

    await textarea.fill("one\ntwo\nthree\nfour\nfive");
    await expect.poll(height).toBeGreaterThan(empty);
    await textarea.fill("");
    await expect.poll(height).toBe(empty);
  });

  test("phones show one foreground panel, switched from the bar, with Chat as home and Tasks as a sheet", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSedesWorkspace(page);
    await createDraftThread(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const chat = page.getByTestId("thread-view");
    await expect(chat).toBeVisible();

    // ▾ is a sheet on phones, above the navigation drawer, without places.
    const menu = await openPanelsMenu(page);
    await expect(menu).toHaveAttribute("role", "dialog");
    expect(
      await menu.evaluate(
        (sheet) =>
          Number(getComputedStyle(sheet).zIndex) >
          Number(
            getComputedStyle(document.documentElement).getPropertyValue("--z-drawer"),
          ),
      ),
    ).toBe(true);
    await expect(menu.getByRole("menuitem", { name: /^Choose where to open/ })).toHaveCount(0);
    await panelRow(menu, "Files").click();
    const filesPanel = page.getByRole("region", { name: "Files panel", exact: true });
    const files = page.getByRole("region", { name: "Workspace files" });
    await expect(filesPanel).toBeVisible();
    await expect(files).toBeVisible({ timeout: 15_000 });
    // One panel on stage; phones have no Maximize.
    await expect(page.locator(".workspace-panel-stage [data-panel-kind]")).toHaveCount(1);
    await expect(chat).toBeHidden();
    await expect(
      filesPanel.getByRole("button", { name: "Maximize Files panel" }),
    ).toHaveCount(0);
    await expect(quickButton(page, "Chat")).toHaveAttribute("data-state", "hidden");
    await expect(quickButton(page, "Files")).toHaveAttribute("data-state", "visible");
    await retain(files, "__phoneFiles");
    await files.getByRole("treeitem", { name: /^android(?:\s|$)/ }).click();
    await files.getByRole("treeitem", { name: /^build\.gradle(?:\s|$)/ }).click();
    await expect(files.getByRole("tab", { name: /build\.gradle/ })).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "panels-phone-files.png");

    // The quick buttons switch the foreground; Files stays loaded meanwhile.
    await quickButton(page, "Chat").click();
    await expect(chat).toBeVisible();
    await expect(filesPanel).toHaveCount(0);
    await expect(quickButton(page, "Files")).toHaveAttribute("data-state", "hidden");
    await capture(page, testInfo, "panels-phone-chat.png");
    await quickButton(page, "Files").click();
    await expect(filesPanel).toBeVisible();
    await expect(files.getByRole("tab", { name: /build\.gradle/ })).toBeVisible();
    expect(await isRetained(files, "__phoneFiles")).toBe(true);
    await filesSettled(page);

    // Chat is the phone's home: its header has no ✕, and its quick button
    // keeps it in front.
    await quickButton(page, "Chat").click();
    await expect(chat).toBeVisible();
    await expect(
      stagePanel(page, "Chat").getByRole("button", { name: /^(Hide|Close) Chat panel$/ }),
    ).toHaveCount(0);
    await expect(quickButton(page, "Chat")).toHaveAccessibleName("Chat panel");
    await quickButton(page, "Chat").click();
    await expect(chat).toBeVisible();
    await expect(quickButton(page, "Chat")).toHaveAttribute("data-state", "visible");

    // Hiding the panel in front shows Chat; Files stays loaded.
    await quickButton(page, "Files").click();
    await expect(filesPanel).toBeVisible();
    await quickButton(page, "Files").click();
    await expect(chat).toBeVisible();
    await expect(filesPanel).toHaveCount(0);
    await expect(quickButton(page, "Files")).toHaveAttribute("data-state", "hidden");

    // Placed in the Middle on a wider screen, Files replaces Chat there; on
    // the phone, hiding it shows Chat in the Middle again.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openPanelIn(page, "Files", "Middle");
    await expect(stagePanel(page, "Chat")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(filesPanel).toBeVisible();
    await expect(chat).toBeHidden();
    await expect(quickButton(page, "Chat")).toHaveAttribute("data-state", "hidden");
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "panels-phone-files-in-middle.png");
    await quickButton(page, "Files").click();
    await expect(chat).toBeVisible();
    await expect(filesPanel).toHaveCount(0);
    await expect.poll(async () => (await savedLayout(page))?.shown.middle).toBe("chat");
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "panels-phone-chat-home.png");

    // Its button brings Files back as it was, in the Middle again.
    await quickButton(page, "Files").click();
    await expect(filesPanel).toBeVisible();
    await expect(files.getByRole("tab", { name: /build\.gradle/ })).toBeVisible();
    expect(await isRetained(files, "__phoneFiles")).toBe(true);
    await expect.poll(async () => (await savedLayout(page))?.shown.middle).toBe("files");
    await filesSettled(page);

    // ✕ closes Files, and Chat comes back without raising the keyboard.
    await filesPanel.getByRole("button", { name: "Close Files panel", exact: true }).click();
    await expect(filesPanel).toHaveCount(0);
    await expect(quickButton(page, "Files")).toHaveCount(0);
    await expect(chat).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).not.toBeFocused();
    await expect.poll(async () => (await savedLayout(page))?.shown.middle).toBe("chat");
    await expectNoPageOverflow(page);

    // Tasks opens as a sheet over the foreground panel, never on stage.
    await openPanel(page, "Tasks");
    const sheet = page.getByRole("dialog", { name: "Tasks", exact: true });
    await expect(sheet).toBeVisible();
    await expect(stagePanel(page, "Tasks")).toHaveCount(0);
    await expect(quickButton(page, "Tasks")).toHaveAttribute("data-state", "visible");
    await expect(stagePanel(page, "Chat")).toBeAttached();
    await capture(page, testInfo, "panels-phone-tasks-sheet.png");
    await sheet.getByRole("button", { name: "Close Tasks panel" }).click();
    await expect(sheet).toBeHidden();
    await expect(chat).toBeVisible();
    await expectNoPageOverflow(page);
  });
});
