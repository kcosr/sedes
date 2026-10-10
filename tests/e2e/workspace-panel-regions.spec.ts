import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { capture, createDraftThread, openSedesWorkspace, overlaySettled } from "./helpers";
import {
  movePanel,
  openPanel,
  openPanelIn,
  openPanelsMenu,
  panelAnnouncement,
  panelRow,
  quickButton,
  stagePanel,
  type PanelTitle,
} from "./workspace-panel-helpers";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function box(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

function stage(page: Page): Locator {
  return page.locator(".workspace-panel-stage");
}

/** The stage's panels and their regions, in DOM order. */
async function regions(page: Page): Promise<Record<string, string>> {
  return Object.fromEntries(
    await page
      .locator(".workspace-panel-stage > .workspace-region")
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          (node as HTMLElement).dataset.regionKind ?? "",
          (node as HTMLElement).dataset.region ?? "",
        ]),
      ),
  );
}

async function expectSameBox(locator: Locator, expected: Box): Promise<void> {
  await expect
    .poll(async () => {
      const actual = await box(locator);
      return [actual.x, actual.y, actual.width, actual.height].map(Math.round);
    })
    .toEqual([expected.x, expected.y, expected.width, expected.height].map(Math.round));
}

/** Opens Terminals from ▾, which starts a terminal in a thread without one. */
async function openTerminals(page: Page): Promise<Locator> {
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/threads\/[^/]+\/terminals$/u.test(new URL(response.url()).pathname) &&
      response.status() === 201,
  );
  await openPanel(page, "Terminals");
  await created;
  const terminals = stagePanel(page, "Terminals");
  await expect(
    terminals.locator('.terminal-panel-emulator[data-restored="true"]'),
  ).toBeAttached({ timeout: 15_000 });
  return terminals;
}

async function savedPlacement(page: Page, kind: string): Promise<string | undefined> {
  return page.evaluate(
    (name) =>
      (
        JSON.parse(localStorage.getItem("sedes-panel-regions@1") ?? "{}") as {
          readonly placement?: Record<string, string>;
        }
      ).placement?.[name],
    kind,
  );
}

async function rowNames(menu: Locator, titles: readonly PanelTitle[]): Promise<string[]> {
  return Promise.all(
    titles.map(async (title) => (await panelRow(menu, title).getAttribute("aria-label")) ?? ""),
  );
}

test("opening a panel replaces its region's panel, leaving Chat and the bottom terminal, and edge panels extend into corners", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  await createDraftThread(page);
  const chat = stagePanel(page, "Chat");

  // A terminal at the Bottom, then Workpads on the Right beside Chat.
  const terminals = await openTerminals(page);
  await expect(terminals).toHaveAttribute("data-region", "bottom");
  await openPanel(page, "Workpads");
  const workpads = stagePanel(page, "Workpads");
  await expect(workpads).toHaveAttribute("data-region", "right");
  expect(await regions(page)).toEqual({ chat: "middle", workpads: "right", terminals: "bottom" });
  const chatBefore = await box(chat);
  const terminalsBefore = await box(terminals);
  await capture(page, testInfo, "regions-chat-workpads-terminal.png");

  // Tasks opens on the Right in Workpads' place: no third column, Chat stays
  // in the Middle, and the terminal keeps its place and height.
  await openPanel(page, "Tasks");
  const tasks = stagePanel(page, "Tasks");
  await expect(tasks).toHaveAttribute("data-region", "right");
  await expect(workpads).toHaveCount(0);
  expect(await regions(page)).toEqual({ chat: "middle", tasks: "right", terminals: "bottom" });
  const chatAfter = await box(chat);
  const terminalsAfter = await box(terminals);
  expect(chatAfter.x).toBeCloseTo(chatBefore.x, 0);
  expect(chatAfter.y).toBeCloseTo(chatBefore.y, 0);
  expect(chatAfter.height).toBeCloseTo(chatBefore.height, 0);
  expect(terminalsAfter.x).toBeCloseTo(terminalsBefore.x, 0);
  expect(terminalsAfter.y).toBeCloseTo(terminalsBefore.y, 0);
  expect(terminalsAfter.height).toBeCloseTo(terminalsBefore.height, 0);
  const tasksBox = await box(tasks);
  expect(tasksBox.x).toBeGreaterThanOrEqual(chatAfter.x + chatAfter.width);
  // Workpads stays loaded behind Tasks: outlined, and "Loaded, hidden" in ▾.
  await expect(quickButton(page, "Workpads")).toHaveAttribute("data-state", "hidden");
  await expect(quickButton(page, "Workpads")).toHaveAccessibleName("Show Workpads panel");
  await expect(quickButton(page, "Tasks")).toHaveAttribute("data-state", "visible");
  await expect(quickButton(page, "Terminals")).toHaveAttribute("data-state", "visible");
  const menu = await openPanelsMenu(page);
  expect(await rowNames(menu, ["Chat", "Files", "Workpads", "Tasks", "Terminals"])).toEqual([
    "Chat, In the middle",
    "Files",
    "Workpads, Loaded, hidden",
    "Tasks, On the right",
    "Terminals, At the bottom",
  ]);
  await capture(page, testInfo, "regions-tasks-replaces-workpads-menu.png");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await capture(page, testInfo, "regions-tasks-replaces-workpads.png");

  // Workpads' quick button shows it in its place again, hiding Tasks.
  await quickButton(page, "Workpads").click();
  await expect(workpads).toHaveAttribute("data-region", "right");
  await expect(tasks).toHaveCount(0);
  await expect(quickButton(page, "Tasks")).toHaveAttribute("data-state", "hidden");
  await expect(quickButton(page, "Workpads")).toHaveAttribute("data-state", "visible");
  await expectSameBox(terminals, terminalsBefore);

  // Corners: by default the sides run full height and the Bottom spans the
  // Middle only.
  const stageBox = await box(stage(page));
  let workpadsBox = await box(workpads);
  expect(workpadsBox.y).toBeCloseTo(stageBox.y, 0);
  expect(workpadsBox.height).toBeCloseTo(stageBox.height, 0);
  expect((await box(terminals)).x + (await box(terminals)).width).toBeLessThanOrEqual(workpadsBox.x + 1);

  // Terminals' Full width takes both bottom corners.
  await terminals.getByRole("button", { name: "Terminals panel actions", exact: true }).click();
  const fullWidth = page.getByRole("menuitemcheckbox", { name: "Full width", exact: true });
  await expect(fullWidth).toHaveAttribute("aria-checked", "false");
  await fullWidth.click();
  await expect.poll(async () => Math.round((await box(terminals)).width)).toBe(Math.round(stageBox.width));
  workpadsBox = await box(workpads);
  expect(workpadsBox.y + workpadsBox.height).toBeLessThanOrEqual((await box(terminals)).y + 1);
  await capture(page, testInfo, "regions-bottom-full-width.png");

  // Workpads' Full height takes its corner back: the most recent wins.
  await workpads.getByRole("button", { name: "Workpads panel actions", exact: true }).click();
  const fullHeight = page.getByRole("menuitemcheckbox", { name: "Full height", exact: true });
  await expect(fullHeight).toHaveAttribute("aria-checked", "false");
  await fullHeight.click();
  await expect.poll(async () => Math.round((await box(workpads)).height)).toBe(Math.round(stageBox.height));
  const terminalsBox = await box(terminals);
  expect(terminalsBox.x + terminalsBox.width).toBeLessThanOrEqual((await box(workpads)).x + 1);
  expect(terminalsBox.x).toBeCloseTo(stageBox.x, 0);
  await capture(page, testInfo, "regions-right-full-height.png");
  await terminals.getByRole("button", { name: "Terminals panel actions", exact: true }).click();
  await expect(fullWidth).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
});

test("Move to and ▾'s place menu set where a panel opens, on this device and in every thread", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  await createDraftThread(page);
  const chat = stagePanel(page, "Chat");
  const files = stagePanel(page, "Files");
  const filesSettled = () =>
    expect(page.getByRole("button", { name: "Refresh workspace files" })).toBeEnabled({
      timeout: 15_000,
    });

  await openPanel(page, "Files");
  await expect(files).toHaveAttribute("data-region", "right");
  await filesSettled();
  // Moving never remounts the panel.
  const filesContent = page.getByRole("region", { name: "Workspace files" });
  await filesContent.evaluate((node) => {
    (window as unknown as { __movedFiles?: Element }).__movedFiles = node;
  });
  await files.getByRole("button", { name: "Files panel actions", exact: true }).click();
  const moveTo = page.getByRole("group", { name: "Move to", exact: true });
  await expect(moveTo.getByRole("menuitemradio", { name: "Right", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(moveTo.getByRole("menuitemradio")).toHaveText(["Middle", "Left", "Right", "Top", "Bottom"]);
  await moveTo.getByRole("menuitemradio", { name: "Bottom", exact: true }).click();
  await expect(files).toHaveAttribute("data-region", "bottom");
  await expect(panelAnnouncement(page)).toHaveText("Files panel moved to the bottom.");
  const chatBox = await box(chat);
  expect(chatBox.y + chatBox.height).toBeLessThanOrEqual((await box(files)).y + 1);
  expect(await savedPlacement(page, "files")).toBe("bottom");
  expect(
    await filesContent.evaluate(
      (node) => (window as unknown as { __movedFiles?: Element }).__movedFiles === node,
    ),
  ).toBe(true);
  await capture(page, testInfo, "regions-files-moved-bottom.png");

  // Closed, Files reopens at the Bottom: its place follows the panel.
  await files.getByRole("button", { name: "Close Files panel", exact: true }).click();
  await expect(files).toHaveCount(0);
  await expect(quickButton(page, "Files")).toHaveCount(0);
  await openPanel(page, "Files");
  await expect(files).toHaveAttribute("data-region", "bottom");
  await filesSettled();

  // The place is the device's: it survives a reload and holds in every thread.
  await page.reload();
  await expect(files).toHaveAttribute("data-region", "bottom");
  await filesSettled();
  await createDraftThread(page);
  await expect(files).toHaveAttribute("data-region", "bottom");
  await filesSettled();
  await files.getByRole("button", { name: "Close Files panel", exact: true }).click();
  await expect(files).toHaveCount(0);
  await openPanel(page, "Files");
  await expect(files).toHaveAttribute("data-region", "bottom");
  await filesSettled();

  // ▾'s place menu: Right opens it from its button and Left closes it.
  const menu = await openPanelsMenu(page);
  const placeTrigger = menu.getByRole("menuitem", { name: "Choose where to open Workpads", exact: true });
  const places = page.getByRole("menu", { name: "Choose where to open Workpads", exact: true });
  await placeTrigger.focus();
  await page.keyboard.press("ArrowRight");
  await expect(places).toBeVisible();
  await expect(places.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  await expect(places).toBeHidden();
  await expect(placeTrigger).toBeFocused();

  // It opens beside the menu, clear of its rows, lined up with its row, with
  // the current place checked. Choosing a place opens the panel there and
  // makes it its place.
  await placeTrigger.click();
  const placeItems = places.getByRole("group", { name: "Open Workpads in", exact: true }).getByRole("menuitemradio");
  await expect(placeItems).toHaveText(["Middle", "Left", "Right", "Top", "Bottom"]);
  await expect(places.getByRole("menuitemradio", { name: "Right", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await overlaySettled(menu);
  await overlaySettled(places);
  const menuBox = await box(menu);
  const placesBox = await box(places);
  expect(placesBox.x + placesBox.width).toBeLessThanOrEqual(menuBox.x);
  const triggerBox = await box(placeTrigger);
  expect(Math.abs(placesBox.y - triggerBox.y)).toBeLessThanOrEqual(8);
  await capture(page, testInfo, "regions-place-menu.png");

  // The pointer crosses the row's own label to reach it. Radix keeps a
  // submenu open for 300ms while the pointer heads for it; the row keeps it
  // open however long the crossing takes, so this waits out that window.
  const rowBox = await box(panelRow(menu, "Workpads"));
  const rowY = rowBox.y + rowBox.height / 2;
  await placeTrigger.hover();
  // Heading left inside the button first, as a hand does.
  await page.mouse.move(triggerBox.x + 4, rowY, { steps: 3 });
  await page.mouse.move(rowBox.x + rowBox.width / 2, rowY, { steps: 4 });
  await page.waitForTimeout(400);
  await page.mouse.move(rowBox.x + 2, rowY, { steps: 4 });
  // Still open, not closing: the row did not take the highlight.
  await expect(placeTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(places).toHaveAttribute("data-state", "open");
  await expect(panelRow(menu, "Workpads")).not.toBeFocused();
  await places.getByRole("menuitemradio", { name: "Left", exact: true }).click();
  await expect(menu).toBeHidden();
  const workpads = stagePanel(page, "Workpads");
  await expect(workpads).toHaveAttribute("data-region", "left");
  expect(await regions(page)).toEqual({ chat: "middle", workpads: "left", files: "bottom" });
  expect(await savedPlacement(page, "workpads")).toBe("left");
  const workpadsBox = await box(workpads);
  expect(workpadsBox.x + workpadsBox.width).toBeLessThanOrEqual((await box(chat)).x + 1);
  await capture(page, testInfo, "regions-workpads-left-files-bottom.png");

  // Closed and reopened from its row, Workpads returns to the Left.
  await workpads.getByRole("button", { name: "Close Workpads panel", exact: true }).click();
  await expect(workpads).toHaveCount(0);
  await openPanel(page, "Workpads");
  await expect(workpads).toHaveAttribute("data-region", "left");

  // Choosing a place that another panel shows replaces it there.
  await openPanelIn(page, "Tasks", "Bottom");
  await expect(stagePanel(page, "Tasks")).toHaveAttribute("data-region", "bottom");
  await expect(files).toHaveCount(0);
  await expect(quickButton(page, "Files")).toHaveAttribute("data-state", "hidden");
  expect(await savedPlacement(page, "tasks")).toBe("bottom");

  // Move to the Middle puts a panel where Chat was; Chat stays loaded.
  await movePanel(page, "Workpads", "Middle");
  await expect(chat).toHaveCount(0);
  await expect(quickButton(page, "Chat")).toHaveAttribute("data-state", "hidden");
  await quickButton(page, "Chat").click();
  await expect(chat).toHaveAttribute("data-region", "middle");
  await expect(workpads).toHaveCount(0);

  // Reset layout: every panel back to its default place, and Chat alone.
  const resetMenu = await openPanelsMenu(page);
  await resetMenu.getByRole("menuitem", { name: "Reset layout", exact: true }).click();
  await expect(panelAnnouncement(page)).toHaveText("Panel layout reset.");
  expect(await regions(page)).toEqual({ chat: "middle" });
  await expect(
    page.getByRole("group", { name: "Loaded panels" }).getByRole("button"),
  ).toHaveCount(1);
  for (const kind of ["files", "workpads", "tasks"]) expect(await savedPlacement(page, kind)).toBe("right");
  await openPanel(page, "Workpads");
  await expect(workpads).toHaveAttribute("data-region", "right");
});

test("Maximize fills the stage until Restore, Escape or another panel, and is never saved", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  await createDraftThread(page);
  await openPanel(page, "Workpads");
  const chat = stagePanel(page, "Chat");
  const workpads = stagePanel(page, "Workpads");
  await expect(workpads).toHaveAttribute("data-region", "right");
  const stageBox = await box(stage(page));
  const chatBox = await box(chat);
  const workpadsBox = await box(workpads);
  const maximize = workpads.getByRole("button", { name: "Maximize Workpads panel", exact: true });
  const restore = workpads.getByRole("button", { name: "Restore Workpads panel", exact: true });
  const expectMaximized = async () => {
    await expect(stage(page)).toHaveAttribute("data-maximized", "workpads");
    await expectSameBox(workpads, stageBox);
    await expect(chat).toHaveCount(0);
    await expect(quickButton(page, "Chat")).toHaveAttribute("data-state", "hidden");
  };
  const expectRestored = async () => {
    await expect(stage(page)).not.toHaveAttribute("data-maximized", /.*/);
    await expectSameBox(chat, chatBox);
    await expectSameBox(workpads, workpadsBox);
  };

  await maximize.click();
  await expectMaximized();
  await expect(panelAnnouncement(page)).toHaveText("Workpads panel maximized.");
  await expect(restore).toBeVisible();
  const menu = await openPanelsMenu(page);
  await expect(panelRow(menu, "Workpads")).toHaveAccessibleName("Workpads, Maximized");
  await expect(panelRow(menu, "Chat")).toHaveAccessibleName("Chat, Loaded, hidden");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  // Escape closed the menu, not the maximized layout.
  await expect(stage(page)).toHaveAttribute("data-maximized", "workpads");
  await capture(page, testInfo, "regions-workpads-maximized.png");
  await restore.click();
  await expectRestored();
  await expect(panelAnnouncement(page)).toHaveText("Panel layout restored.");

  await maximize.click();
  await expectMaximized();
  await page.keyboard.press("Escape");
  await expectRestored();

  // Opening another panel returns the layout as it was.
  await maximize.click();
  await expectMaximized();
  await quickButton(page, "Chat").click();
  await expectRestored();

  // Maximize is never saved.
  await maximize.click();
  await expectMaximized();
  await page.reload();
  await expect(workpads).toBeVisible();
  await expectRestored();
});

test("a stage too narrow for every region hides the least recently used edge region, then shows it again", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  await createDraftThread(page);
  await openPanelIn(page, "Workpads", "Left");
  await openPanel(page, "Tasks");
  const workpads = stagePanel(page, "Workpads");
  const tasks = stagePanel(page, "Tasks");
  await expect(workpads).toHaveAttribute("data-region", "left");
  await expect(tasks).toHaveAttribute("data-region", "right");

  // Chat (360px), Workpads (320px) and Tasks (300px) do not fit 840px.
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(workpads).toHaveCount(0);
  await expect(panelAnnouncement(page)).toHaveText("Workpads hidden to make room.");
  await expect(tasks).toHaveAttribute("data-region", "right");
  await expect(stagePanel(page, "Chat")).toBeVisible();
  await expect(quickButton(page, "Workpads")).toHaveAttribute("data-state", "hidden");
  await capture(page, testInfo, "regions-make-room.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(workpads).toHaveAttribute("data-region", "left");
  await expect(panelAnnouncement(page)).toHaveText("Workpads shown again.");

  // Using Workpads makes Tasks the least recently used.
  await workpads.locator(".workspace-panel-title").click();
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(tasks).toHaveCount(0);
  await expect(panelAnnouncement(page)).toHaveText("Tasks hidden to make room.");
  await expect(workpads).toHaveAttribute("data-region", "left");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(tasks).toHaveAttribute("data-region", "right");
  await expect(panelAnnouncement(page)).toHaveText("Tasks shown again.");
});
