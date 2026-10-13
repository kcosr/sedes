import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { capture, createDraftThread, openSedesWorkspace } from "./helpers";

async function expectNearFullComposerWidth(page: Page): Promise<void> {
  const composer = page.getByTestId("composer");
  await page.getByRole("button", { name: "Choose skill" }).click();
  const picker = page.getByRole("dialog", { name: "Choose a skill" });
  await expect(picker).toBeVisible();

  const composerBox = await composer.boundingBox();
  const pickerBox = await picker.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(pickerBox).not.toBeNull();

  const leftInset = pickerBox!.x - composerBox!.x;
  const rightInset =
    composerBox!.x + composerBox!.width - (pickerBox!.x + pickerBox!.width);
  expect(leftInset).toBeGreaterThanOrEqual(8);
  expect(leftInset).toBeLessThanOrEqual(10);
  expect(Math.abs(leftInset - rightInset)).toBeLessThanOrEqual(1);
  expect(pickerBox!.width / composerBox!.width).toBeGreaterThan(0.94);
}

test("skill picker nearly spans the composer on desktop and mobile", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSedesWorkspace(page);
  const threadPath = await createDraftThread(page);

  await expectNearFullComposerWidth(page);
  await capture(page, testInfo, "skill-picker-wide-desktop.png");
  await page.keyboard.press("Escape");

  const message = page.getByTestId("composer").getByRole("textbox");
  await message.fill("");
  await message.pressSequentially("@");
  const references = page.getByRole("dialog", { name: "Reference a thread", exact: true });
  await expect(references).toBeVisible();
  const sidebarSearch = page.getByTestId("desktop-sidebar").getByRole("searchbox", { name: "Search threads", exact: true });
  await sidebarSearch.click();
  await expect(references).toBeHidden();
  await expect(sidebarSearch).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(threadPath);
  await expectNearFullComposerWidth(page);
  await capture(page, testInfo, "skill-picker-wide-mobile.png");
  await page.keyboard.press("Escape");
  await message.fill("");
  await message.pressSequentially("@");
  await expect(references).toBeVisible();
  await page.getByText("This thread is ready", { exact: true }).click();
  await expect(references).toBeHidden();
  await expect(page.getByTestId("composer").getByRole("textbox")).not.toBeFocused();
});
