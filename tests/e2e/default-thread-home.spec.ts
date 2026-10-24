import { test, expect } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  openSedesWorkspace,
  openSettingsPage,
} from "./helpers";
import { openPanelIn, quickButton, stagePanel } from "./workspace-panel-helpers";

test("Home opens the default chat and connection changes leave the toolbar in place", async ({
  page, context, browserDiagnostics,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  const homePath = await createDraftThread(page, "Home destination");
  const bar = page.getByTestId("workspace-workbench-bar");
  const home = bar.getByRole("button", { name: "Home", exact: true });
  await expect(home).toHaveCount(0);
  await page.getByTestId("desktop-sidebar").getByTestId("thread-row-link")
    .filter({ hasText: "Home destination" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Make default thread", exact: true }).click();
  await expect(home).toBeVisible();
  await createDraftThread(page, "Other destination");
  await home.click();
  await expect(page).toHaveURL(homePath);
  const composer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
  await expect(composer).toBeFocused();

  // Clicking Home also reveals Chat when the route already names the default.
  await openPanelIn(page, "Pages", "Middle");
  await expect(stagePanel(page, "Pages")).toBeVisible();
  await expect(composer).toBeHidden();
  await home.click();
  await expect(page).toHaveURL(homePath);
  await expect(stagePanel(page, "Chat")).toBeVisible();
  await expect(composer).toBeFocused();
  await capture(page, testInfo, "default-home-desktop.png");

  await page.setViewportSize({ width: 320, height: 740 });
  await expectNoPageOverflow(page);
  const controls = bar.locator(".sidebar-nav-control");
  await expect(controls.getByRole("button")).toHaveCount(3);
  await expect(controls.getByRole("button").nth(0)).toHaveAccessibleName("Open thread navigation");
  await expect(controls.getByRole("button").nth(1)).toHaveAccessibleName("Silence notifications");
  await expect(controls.getByRole("button").nth(2)).toHaveAccessibleName("Home");
  await quickButton(page, "Pages").focus();
  await page.keyboard.press("Enter");
  await expect(stagePanel(page, "Pages")).toBeVisible();
  await home.click();
  await expect(composer).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat panel content", exact: true })).toBeFocused();
  await capture(page, testInfo, "default-home-mobile.png");

  const positions = () => bar.locator(".sidebar-nav-control, .workspace-workbench-actions")
    .evaluateAll(elements => elements.map(element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }));
  const connectedPositions = await positions();
  browserDiagnostics.allowNetworkFailures = true;
  try {
    await context.setOffline(true);
    await expect(controls.getByRole("img", { name: /Application (reconnecting|disconnected)/u }))
      .toBeVisible({ timeout: 15_000 });
    expect(await positions()).toEqual(connectedPositions);
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "default-home-mobile-reconnecting.png");
  } finally {
    await context.setOffline(false);
  }
  await expect(controls.getByRole("img")).toHaveCount(0, { timeout: 15_000 });
  expect(await positions()).toEqual(connectedPositions);
  browserDiagnostics.allowNetworkFailures = false;

  // Compact Settings uses the same navigation control and returns to Chat.
  await openSettingsPage(page, "general");
  await page.getByTestId("settings-view").getByRole("button", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(homePath);
  await expect(composer).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat panel content", exact: true })).toBeFocused();

  await openSettingsPage(page, "general");
  await page.getByRole("region", { name: "Default thread", exact: true })
    .getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByRole("button", { name: "Home", exact: true, includeHidden: true })).toHaveCount(0);
});
