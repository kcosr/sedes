import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  sendCurrentDraft,
} from "./helpers";

function openPanelsTrigger(page: Page) {
  return page.getByRole("button", { name: "Panels" });
}

// The bar's menu always lists every available panel, so collapse is read from the
// item state rather than from the trigger existing at all.
async function expectCollapsedPanels(
  page: Page,
  panels: readonly ("Chat" | "Files")[],
) {
  await openPanelsTrigger(page).click();
  await expect(page.getByRole("menuitem", { name: /Collapsed$/ })).toHaveCount(
    panels.length,
  );
  for (const panel of panels) {
    await expect(
      page.getByRole("menuitem", {
        name: new RegExp(`^${panel} —.*Collapsed$`),
      }),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");
}

async function restoreCollapsed(page: Page, panel: "Chat" | "Files") {
  await openPanelsTrigger(page).click();
  const item = page.getByRole("menuitem", {
    name: new RegExp(`^${panel} —.*Collapsed$`),
  });
  await expect(item).toBeVisible();
  await item.click();
}

test.describe("panel-instance workbench", () => {
  test("collapse, restore, empty state, resize, persistence, and streaming retain both surfaces", async ({
    page,
  }, testInfo) => {
    // This comprehensive journey reached ~63s under the former full 12-lane
    // default even though its targeted runtime is ~11s.
    test.setTimeout(90_000);
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
    await page.evaluate(() => {
      localStorage.setItem("sedes-panel-layout@1", "legacy-layout-marker");
    });

    const chat = page.getByTestId("thread-view");
    await expect(chat).toBeVisible();
    await chat.evaluate((node) => {
      (
        window as typeof window & { __singletonChat?: Element }
      ).__singletonChat = node;
    });
    await capture(page, testInfo, "singleton-chat-default.png");

    await openPanelsTrigger(page).click();
    // Tasks and Workpads open from their own toggles, not this menu.
    const panelItems = page.getByRole("menuitem").filter({ hasText: /^(Chat|Files|Workpads|Tasks|Terminals)( —|$)/ });
    await expect(panelItems).toHaveCount(3);
    expect((await panelItems.allTextContents()).map(text => text.split(" —")[0])).toEqual(["Chat", "Files", "Terminals"]);
    await expect(panelItems.nth(0)).toHaveAttribute("aria-description", "Open");
    for (const item of [1, 2]) await expect(panelItems.nth(item)).toHaveAttribute("aria-description", "Closed");
    await capture(page, testInfo, "panels-menu-open-and-closed.png");
    await panelItems.nth(1).click();
    const files = page.getByRole("region", { name: "Workspace files" });
    await expect(files).toBeVisible({ timeout: 15_000 });
    await files.evaluate((node) => {
      (
        window as typeof window & { __singletonFiles?: Element }
      ).__singletonFiles = node;
    });
    const split = page.getByTestId("workspace-panel-split");
    await expect(split).toHaveAttribute("data-orientation", "row");
    const resize = page.getByRole("separator", {
      name: "Resize Chat and Files panels",
    });
    const resizeBox = await resize.boundingBox();
    expect(resizeBox).not.toBeNull();
    await page.mouse.move(
      resizeBox!.x + resizeBox!.width / 2,
      resizeBox!.y + resizeBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeBox!.x + resizeBox!.width / 2 - 72,
      resizeBox!.y + resizeBox!.height / 2,
    );
    await page.mouse.up();
    const canonicalLayout = await page.evaluate(() =>
      localStorage.getItem(`sedes-thread-panel-instance-layout@4:${encodeURIComponent(location.pathname.split("/")[2] ?? "")}`),
    );
    expect(canonicalLayout).toContain('"version":4');
    await capture(page, testInfo, "singleton-chat-files-split.png");

    const composer = page.getByRole("textbox", {
      name: "Message Scripted agent",
    });
    await fillAndPersistDraft(page, "Collapse must retain this draft");
    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await expect(chat).toBeHidden();
    const workbenchBar = page.getByTestId("workspace-workbench-bar");
    await expect(
      workbenchBar.getByRole("button", { name: "Panels" }),
    ).toBeVisible();
    const hideSidebar = workbenchBar.getByRole("button", {
      name: "Hide sidebar",
    });
    await hideSidebar.click();
    await expect(page.getByTestId("desktop-sidebar")).toBeHidden();
    await workbenchBar.getByRole("button", { name: "Show sidebar" }).click();
    await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
    await restoreCollapsed(page, "Chat");
    await expect(composer).toHaveValue("Collapse must retain this draft");
    expect(
      await chat.evaluate(
        (node) =>
          (window as typeof window & { __singletonChat?: Element })
            .__singletonChat === node,
      ),
    ).toBe(true);

    await sendCurrentDraft(page);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await capture(page, testInfo, "singleton-panels-streaming.png");
    const requestsBeforeStreamingCollapse = threadEventRequests;
    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await restoreCollapsed(page, "Chat");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    expect(threadEventRequests).toBe(requestsBeforeStreamingCollapse);
    expect(
      await chat.evaluate(
        (node) =>
          (window as typeof window & { __singletonChat?: Element })
            .__singletonChat === node,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();

    await page.getByRole("button", { name: "Collapse Files panel" }).click();
    await expect(files).toBeHidden();
    await restoreCollapsed(page, "Files");
    expect(
      await files.evaluate(
        (node) =>
          (window as typeof window & { __singletonFiles?: Element })
            .__singletonFiles === node,
      ),
    ).toBe(true);

    await page.getByRole("button", { name: "Collapse Files panel" }).click();
    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await expect(page.getByTestId("workspace-panel-empty")).toContainText(
      "All panels are collapsed",
    );
    await expectCollapsedPanels(page, ["Chat", "Files"]);
    await capture(page, testInfo, "singleton-all-collapsed-empty.png");
    expect(
      await page.evaluate(() =>
        localStorage.getItem(`sedes-thread-panel-instance-collapsed@4:${encodeURIComponent(location.pathname.split("/")[2] ?? "")}`),
      ),
    ).toBe('{"version":4,"collapsed":["chat","workspace-files"]}');

    await page.reload();
    await expect(page.getByTestId("workspace-panel-empty")).toContainText(
      "All panels are collapsed",
    );
    await expectCollapsedPanels(page, ["Chat", "Files"]);
    expect(
      await page.evaluate(() =>
        localStorage.getItem(`sedes-thread-panel-instance-layout@4:${encodeURIComponent(location.pathname.split("/")[2] ?? "")}`),
      ),
    ).toBe(canonicalLayout);

    await openPanelsTrigger(page).click();
    await page.getByRole("menuitem", { name: "Show all" }).click();
    await expect(chat).toBeVisible();
    await expect(files).toBeVisible();
    await expect(page.getByTestId("workspace-panel-split")).toBeVisible();
    expect(
      await page.evaluate(() =>
        localStorage.getItem(`sedes-thread-panel-instance-layout@4:${encodeURIComponent(location.pathname.split("/")[2] ?? "")}`),
      ),
    ).toBe(canonicalLayout);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("sedes-panel-layout@1"),
      ),
    ).toBe("legacy-layout-marker");
    await capture(page, testInfo, "singleton-restored-split.png");

    await page.reload();
    await expect(page.getByTestId("thread-view")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Workspace files" }),
    ).toBeVisible({
      timeout: 15_000,
    });
    // Both surfaces came back, so the menu stays but nothing reads collapsed.
    await expect(page.getByTestId("workspace-panel-split")).toBeVisible();
    await expectCollapsedPanels(page, []);
    expect(
      await page.evaluate(() =>
        localStorage.getItem(`sedes-thread-panel-instance-layout@4:${encodeURIComponent(location.pathname.split("/")[2] ?? "")}`),
      ),
    ).toBe(canonicalLayout);
    await page.getByRole("button", { name: "Close Chat panel", exact: true }).click();
    await expect(chat).toBeHidden();
    await openPanelsTrigger(page).click();
    const closedChat = page.getByRole("menuitem", { name: /^Chat(?: —|$)/ });
    await expect(closedChat).toHaveAttribute("aria-description", "Closed");
    await closedChat.click();
    await expect(chat).toBeVisible();
  });

  test("docked Tasks stays open with Chat collapsed, follows thread switches, and selection restores and focuses Chat", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSedesWorkspace(page);
    const firstThreadPath = await createDraftThread(page);
    const secondThreadPath = await createDraftThread(page);
    const firstThreadId = firstThreadPath.split("/").at(-1)!;
    const secondThreadId = secondThreadPath.split("/").at(-1)!;

    const tasks = page.locator('[data-slot="tasks-panel"]');
    const tasksLeaf = page.locator('[data-panel-id="tasks"]');
    await page.getByTestId("tasks-panel-toggle").click();
    await expect(tasks).toBeVisible();
    await expect(tasks).toHaveAttribute("data-presentation", "panel");
    await expect(tasksLeaf).toBeVisible();
    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await expect(tasks).toBeVisible();

    await page
      .getByTestId("desktop-sidebar")
      .locator(`[data-thread-id="${secondThreadId}"]`)
      .getByTestId("thread-row-link")
      .click();
    await expect(page).toHaveURL(secondThreadPath);
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).toBeFocused();
    await expect(page.locator('[data-panel-id="chat"]')).toHaveCount(1);
    // Tasks stays docked in the next thread's layout, beside its Chat.
    await expect(tasksLeaf).toBeVisible();
    await expect(tasks).toHaveAttribute("data-presentation", "panel");
    const chatBox = await page.locator('[data-panel-id="chat"]').boundingBox();
    const tasksBox = await tasksLeaf.boundingBox();
    expect(tasksBox!.x).toBeGreaterThanOrEqual(chatBox!.x + chatBox!.width);

    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await page
      .getByTestId("desktop-sidebar")
      .locator(`[data-thread-id="${firstThreadId}"]`)
      .getByTestId("thread-row-link")
      .click();
    await expect(page).toHaveURL(firstThreadPath);
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).toBeFocused();
    await expect(page.locator('[data-panel-id="chat"]')).toHaveCount(1);
  });

  test("composer shrinks back to its empty height under reduced motion after Chat is collapsed beside Files", async ({
    page,
  }) => {
    // A collapsed Chat keeps the composer laid out with no content width, so the
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

    await openPanelsTrigger(page).click();
    await page.getByRole("menuitem", { name: /^Files(?: —|$)/ }).click();
    await expect(
      page.getByRole("region", { name: "Workspace files" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect.poll(height).toBe(empty);
    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await expect(page.getByTestId("thread-view")).toBeHidden();
    await restoreCollapsed(page, "Chat");
    await expect(textarea).toBeVisible();
    await expect.poll(height).toBe(empty);

    await textarea.fill("one\ntwo\nthree\nfour\nfive");
    await expect.poll(height).toBeGreaterThan(empty);
    await textarea.fill("");
    await expect.poll(height).toBe(empty);
  });

  test("narrow Files panel collapses without unmounting and can become the base surface", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSedesWorkspace(page);
    await createDraftThread(page);
    await page.setViewportSize({ width: 412, height: 915 });

    await page.getByRole("button", { name: "Panels", exact: true }).click();
    // The shared floating layer already stacks menus above the mobile drawer.
    expect(
      await page
        .getByRole("menu", { name: "Panels" })
        .evaluate(
          (menu) =>
            Number(getComputedStyle(menu).zIndex) >
            Number(
              getComputedStyle(document.documentElement).getPropertyValue(
                "--z-drawer",
              ),
            ),
        ),
    ).toBe(true);
    await page.getByRole("menuitem", { name: /^Files(?: —|$)/ }).click();
    const filesPanel = page.getByRole("region", {
      name: "Files panel",
      exact: true,
    });
    const files = page.getByRole("region", { name: "Workspace files" });
    await expect(filesPanel).toBeVisible();
    await expect(files).toBeVisible({ timeout: 15_000 });
    await files.evaluate((node) => {
      (window as typeof window & { __narrowFiles?: Element }).__narrowFiles =
        node;
    });
    await files.getByRole("treeitem", { name: /^android(?:\s|$)/ }).click();
    const visibleFile = files.getByRole("treeitem", {
      name: /^build\.gradle(?:\s|$)/,
    });
    await visibleFile.click();
    await expect(
      files.getByRole("tab", { name: /build\.gradle/ }),
    ).toBeVisible();
    await capture(page, testInfo, "singleton-mobile-files-sheet.png");

    await page.getByRole("button", { name: "Collapse Files panel" }).click();
    await expect(filesPanel).toHaveCount(0);
    await expectCollapsedPanels(page, ["Files"]);
    await restoreCollapsed(page, "Files");
    await expect(filesPanel).toBeVisible();
    await expect(
      files.getByRole("tab", { name: /build\.gradle/ }),
    ).toBeVisible();
    expect(
      await files.evaluate(
        (node) =>
          (window as typeof window & { __narrowFiles?: Element })
            .__narrowFiles === node,
      ),
    ).toBe(true);

    await page.getByRole("button", { name: "Collapse Files panel" }).click();
    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await expect(page.getByTestId("workspace-panel-empty")).toBeVisible();
    await restoreCollapsed(page, "Files");
    await expect(filesPanel).toBeVisible();
    await expect(files).toBeVisible();
    await expect(
      files.getByRole("tab", { name: /build\.gradle/ }),
    ).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "singleton-mobile-files-base.png");

    await page.getByRole("button", { name: "Collapse Files panel" }).click();
    await restoreCollapsed(page, "Chat");
    await expect(page.getByTestId("thread-view")).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).not.toBeFocused();
    await expectNoPageOverflow(page);
  });
});
