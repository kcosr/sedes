import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { SettingsPage } from "../../src/client/app/settings-route.js";
import { expect } from "./fixtures";
import { loadE2ERunContext } from "./run-context.js";

export async function selectSettingsCategory(page: Page, category: SettingsPage): Promise<void> {
  const settings = page.getByTestId("settings-view");
  const picker = settings.getByRole("combobox", { name: "Settings category", exact: true });
  if (await picker.isVisible()) await picker.selectOption(category);
  else await settings.getByTestId("settings-page").and(settings.locator(`[data-page="${category}"]`)).click();
}

export async function openSettingsPage(page: Page, category: SettingsPage): Promise<Locator> {
  const trigger = page.getByTestId("settings-trigger").filter({ visible: true });
  const mobileNavigation = page.getByRole("button", { name: "Open thread navigation", exact: true });
  await expect(trigger.or(mobileNavigation).first()).toBeVisible();
  if (await trigger.count() === 0) await mobileNavigation.click();
  await trigger.click();
  const settings = page.getByTestId("settings-view");
  await expect(settings).toBeVisible();
  await selectSettingsCategory(page, category);
  return settings;
}

export async function returnFromSettings(page: Page): Promise<void> {
  await page.getByTestId("settings-return").click();
  await expect(page.getByTestId("settings-view")).toBeHidden();
}

export async function selectRadixOption(
  page: Page,
  trigger: Locator,
  optionName: string | RegExp,
): Promise<void> {
  await trigger.click();
  await page
    .getByRole("option", {
      name: optionName,
      exact: typeof optionName === "string",
    })
    .click();
}

export async function selectCustomNewThreadTarget(
  page: Page,
  optionName: string | RegExp,
): Promise<Locator> {
  const targetPicker = page.getByRole("combobox", {
    name: "Target",
    exact: true,
  });
  await selectRadixOption(page, targetPicker, optionName);
  const agentPicker = page.getByRole("combobox", { name: "Agent" });
  await agentPicker.click();
  await page.getByRole("option", { name: /Custom/ }).click();
  return targetPicker;
}

export async function selectProjectIfNeeded(
  page: Page,
  projectName: string,
): Promise<void> {
  const project = page.getByRole("combobox", {
    name: "Project",
    exact: true,
  });
  if ((await project.count()) === 0) return;
  if ((await project.textContent())?.match(/Choose a project/i)) {
    await selectRadixOption(page, project, projectName);
  }
}

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export const repositoryLabel = path.basename(repositoryRoot);
const screenshotDirectory = loadE2ERunContext().screenshotsDirectory;

export async function openWorkspaceDirectory(
  page: Page,
  directory: string,
): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "New thread" }).first(),
  ).toBeVisible();
  const picker = page
    .getByTestId("desktop-sidebar")
    .getByTestId("workspace-picker");
  await picker.click();
  await page.getByLabel("Absolute directory path").fill(directory);
  const opened = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/workspaces/open") &&
      response.status() === 201,
  );
  await page.getByRole("dialog", { name: "Add project" }).getByRole("button", { name: "Add project" }).click();
  await opened;
  // This shared fixture exercises hierarchy-specific inventory controls.
  const sidebar = page.getByTestId("desktop-sidebar");
  await sidebar.getByTestId("view-options-trigger").click();
  await page.getByRole("radiogroup", { name: "Group by" }).getByRole("radio", { name: "Projects", exact: true }).click();
  await expect(
    page
      .getByTestId("desktop-sidebar")
      .getByTestId("project-row")
      .filter({ hasText: path.basename(directory) }),
  ).toBeVisible();
}

export async function openSedesWorkspace(page: Page): Promise<void> {
  await openWorkspaceDirectory(page, repositoryRoot);
}

export async function createDraftThread(page: Page): Promise<string> {
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await page
    .getByTestId("desktop-sidebar")
    .getByTestId("new-thread-trigger")
    .click();
  // Name panel always opens; multi-target setups also show the agent picker.
  await expect(
    page.getByRole("textbox", { name: "Thread name" }),
  ).toBeVisible();
  await selectCustomNewThreadTarget(page, "Pi SDK");
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("textbox", { name: "Message Scripted agent" }),
  ).toBeVisible();
  return new URL(page.url()).pathname;
}

export async function fillAndPersistDraft(
  page: Page,
  text: string,
  composerName = "Message Scripted agent",
): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/draft") &&
      response.ok(),
  );
  await page.getByRole("textbox", { name: composerName }).fill(text);
  await saved;
}

export async function sendCurrentDraft(page: Page): Promise<void> {
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/operations") &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await accepted;
}

export async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { readonly animations?: "allow" | "disabled" } = {},
): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  const screenshotPath = path.join(screenshotDirectory, name);
  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
    animations: options.animations ?? "disabled",
  });
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/png",
  });
}

export async function expectNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

export async function selectDeliveryMode(page: Page, mode: "Steer" | "Queue"): Promise<void> {
  await page.getByRole("button", { name: "Delivery mode", exact: true }).click();
  await page.getByRole("menuitem", { name: mode, exact: true }).click();
}
