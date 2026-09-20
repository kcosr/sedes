import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSettingsPage,
  openWorkspaceDirectory,
  returnFromSettings,
  selectCustomNewThreadTarget,
  selectSettingsCategory,
} from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";

// Observe the reveal commit before the browser advances CSS transitions.
// Every captured return target must be focusable immediately.
async function observeWorkspaceRevealFocus(target: Locator) {
  return target.evaluateHandle(element => {
    const workspace = element.closest<HTMLElement>(".application-workspace")!;
    const result = { focused: false };
    const observer = new MutationObserver(() => {
      if (workspace.dataset.active !== "true") return;
      result.focused = document.activeElement === element;
      observer.disconnect();
    });
    observer.observe(workspace, { attributes: true, attributeFilter: ["data-active"] });
    return result;
  });
}

test("settings routes preserve the mounted composer through category history and return navigation", async ({ page }, testInfo) => {
  const workspace = path.join(loadE2ERunContext().workspacesDirectory, "settings-navigation");
  await mkdir(workspace, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspaceDirectory(page, workspace);
  const threadPath = await createDraftThread(page);
  const draft = Array.from({ length: 30 }, (_, index) => `Draft line ${index + 1}: preserve this local editing state.`).join("\n");
  await fillAndPersistDraft(page, draft);
  const composer = page.getByRole("textbox", { name: "Message Scripted agent", exact: true });
  const originalComposer = await composer.elementHandle();
  const scrollTop = await composer.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrollTop).toBeGreaterThan(0);

  await page.getByTestId("desktop-sidebar").getByTestId("settings-trigger").click();
  await expect(page).toHaveURL("/settings");
  const settings = page.getByTestId("settings-view");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("region", { name: "All settings", exact: true }).getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(settings.getByTestId("settings-return")).toHaveText("Back to chat");
  expect(await originalComposer!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.getByTestId("composer")).toBeHidden();
  await capture(page, testInfo, "settings-home-desktop.png");

  await selectSettingsCategory(page, "general");
  await expect(page).toHaveURL("/settings/general");
  await expect(settings.getByTestId("seek-on-submit-toggle")).toBeVisible();
  await expect(settings.getByTestId("seek-diagnostics-toggle")).toHaveCount(0);
  await selectSettingsCategory(page, "diagnostics");
  await expect(page).toHaveURL("/settings/diagnostics");
  await expect(settings.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
  await expect(settings.getByTestId("seek-on-submit-toggle")).toHaveCount(0);
  await capture(page, testInfo, "settings-diagnostics-desktop.png");
  await selectSettingsCategory(page, "general");
  await selectSettingsCategory(page, "appearance");
  await expect(page).toHaveURL("/settings/appearance");
  await page.goBack();
  await expect(page).toHaveURL("/settings/general");
  await expect(settings.getByTestId("activity-detail-setting")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL("/settings/appearance");
  await returnFromSettings(page);
  await expect(page).toHaveURL(threadPath);
  await expect(composer).toHaveValue(draft);
  await expect(page.getByTestId("desktop-sidebar").getByTestId("settings-trigger")).toBeFocused();
  expect(await composer.evaluate((element, previous) => element === previous, originalComposer)).toBe(true);
  expect(await composer.evaluate(element => element.scrollTop)).toBe(scrollTop);

  await page.getByTestId("desktop-sidebar").getByTestId("settings-trigger").click();
  await expect(page).toHaveURL("/settings");
  await page.goBack();
  await expect(page).toHaveURL(threadPath);
  await expect(page.getByTestId("desktop-sidebar").getByTestId("settings-trigger")).toBeFocused();

  // History navigation can capture any workspace control, not just the drawer trigger.
  const headerButton = page.getByRole("button", { name: "Find in thread", exact: true, includeHidden: true });
  await headerButton.focus();
  await page.goForward();
  await expect(page).toHaveURL("/settings");
  const headerReturnFocus = await observeWorkspaceRevealFocus(headerButton);
  await page.goBack();
  await expect(page).toHaveURL(threadPath);
  expect(await headerReturnFocus.evaluate(result => result.focused)).toBe(true);
  await headerReturnFocus.dispose();
  await expect(headerButton).toBeFocused();

  // History entry can start with no focused control (for example after clicking
  // ordinary transcript text). Body must never become the return target.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect(page.locator("body")).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL("/settings");
  await page.goBack();
  await expect(page).toHaveURL(threadPath);
  await expect.poll(() => page.locator(".application-workspace").evaluate(element =>
    element === document.activeElement || element.contains(document.activeElement),
  )).toBe(true);
  await expect(page.locator("body")).not.toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(composer).toBeVisible();
  const mobileComposer = await composer.elementHandle();
  await openSettingsPage(page, "general");
  await expect(page.getByRole("dialog", { name: "Thread navigation", exact: true })).toBeHidden();
  await expect(settings.getByRole("combobox", { name: "Settings category", exact: true })).toHaveValue("general");
  const returnFocus = await observeWorkspaceRevealFocus(
    page.locator('.application-workspace .sidebar-nav-trigger'),
  );
  await returnFromSettings(page);
  expect(await returnFocus.evaluate(result => result.focused)).toBe(true);
  await returnFocus.dispose();
  await expect(page).toHaveURL(threadPath);
  await expect(page.getByRole("button", { name: "Open thread navigation", exact: true })).toBeFocused();
  await expect(composer).toHaveValue(draft);
  expect(await composer.evaluate((element, previous) => element === previous, mobileComposer)).toBe(true);
});

test("settings deep links reload and mobile categories remain reachable while content scrolls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/general");
  const settings = page.getByTestId("settings-view");
  const picker = settings.getByRole("combobox", { name: "Settings category", exact: true });
  const content = settings.locator(".settings-content");
  await expect(picker).toHaveValue("general");
  await expect(settings.getByTestId("settings-return")).toHaveText("Back to workspace");
  await page.reload();
  await expect(page).toHaveURL("/settings/general");
  await expect(settings.getByTestId("activity-detail-setting")).toBeVisible();
  await picker.selectOption("");
  await expect(page).toHaveURL("/settings");
  await expect(settings.getByRole("region", { name: "All settings", exact: true }).getByRole("button", { name: "Environments", exact: true })).toBeVisible();
  await expect(settings.getByRole("region", { name: "All settings", exact: true }).getByRole("button", { name: "Projects", exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "settings-home-mobile.png");

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 480 });
    await selectSettingsCategory(page, "diagnostics");
    await expect(page).toHaveURL("/settings/diagnostics");
    await expect(settings.getByTestId("composer-input-diagnostics-toggle")).toBeVisible();
    await expect(settings.getByTestId("streaming-diagnostics-toggle")).toBeVisible();
    await expect(settings.getByTestId("thread-load-diagnostics-toggle")).toBeVisible();
    await expect(settings.getByTestId("seek-diagnostics-toggle")).toBeVisible();
    await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(picker).toBeInViewport({ ratio: 1 });
    await expect(settings.getByTestId("settings-return")).toBeInViewport({ ratio: 1 });
    const pickerBounds = (await picker.boundingBox())!;
    expect(pickerBounds.height).toBeGreaterThanOrEqual(44);
    await expectNoPageOverflow(page);
    expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await capture(page, testInfo, `settings-diagnostics-scrolled-mobile-${width}.png`);
    await page.reload();
    await expect(page).toHaveURL("/settings/diagnostics");
    await expect(picker).toHaveValue("diagnostics");
    await expect(settings.getByTestId("seek-diagnostics-toggle")).toBeVisible();
    await picker.selectOption("backends");
    await expect(page).toHaveURL("/settings/backends");
    await expect(settings.getByRole("region", { name: "Configured backends", exact: true })).toBeVisible();
    await picker.selectOption("projects");
    await expect(page).toHaveURL("/settings/projects");
    await expect(settings.getByRole("region", { name: "Projects", exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
  }

  await page.reload();
  await expect(page).toHaveURL("/settings/projects");
  await expect(picker).toHaveValue("projects");
  await expect(settings.getByRole("region", { name: "Projects", exact: true })).toBeVisible();

  await page.goto("/settings/tool-clients");
  await expect(settings.getByRole("heading", { name: "Tool clients", exact: true })).toBeVisible();
  await expect(picker).toHaveValue("tool_clients");
  await page.reload();
  await expect(page).toHaveURL("/settings/tool-clients");
  await expect(picker).toHaveValue("tool_clients");
  await page.setViewportSize({ width: 1440, height: 320 });
  const navigation = settings.getByRole("navigation", { name: "Settings pages", exact: true });
  await expect(navigation).toBeVisible();
  await navigation.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await navigation.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(navigation.getByRole("button").last()).toBeInViewport({ ratio: 1 });
  await expect(settings.getByTestId("settings-return")).toBeInViewport({ ratio: 1 });
  await expectNoPageOverflow(page);
});

test("dirty settings guard browser Back and return without saving discarded environment edits", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/settings/general");
  const settings = page.getByTestId("settings-view");
  await selectSettingsCategory(page, "environments");
  await expect(page).toHaveURL("/settings/environments");
  let writes = 0;
  page.on("request", request => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/configuration") writes++;
  });
  await settings.getByRole("button", { name: "Add environment", exact: true }).click();
  await settings.getByRole("button", { name: /^SSH host/u }).click();
  await settings.getByLabel("Environment name", { exact: true }).fill("Discard this draft");
  await page.goBack();
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page).toHaveURL("/settings/environments");
  await expect(settings.getByLabel("Environment name", { exact: true })).toHaveValue("Discard this draft");
  await page.goBack();
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL("/settings/general");
  await page.goForward();
  await expect(page).toHaveURL("/settings/environments");
  await expect(settings.getByRole("region", { name: "Configured environments", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Add environment", exact: true }).click();
  await settings.getByRole("button", { name: /^SSH host/u }).click();
  await settings.getByLabel("Environment name", { exact: true }).fill("Another unsaved draft");
  await settings.getByTestId("settings-return").click();
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(settings.getByLabel("Environment name", { exact: true })).toHaveValue("Another unsaved draft");
  await settings.getByTestId("settings-return").click();
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(settings).toBeHidden();
  expect(writes).toBe(0);
});

test.describe("sidebar name filtering preference", () => {
  test.use({ hasTouch: true });

  test("project and environment names filter cards by click, keyboard, and touch without opening a thread", async ({ page }, testInfo) => {
    const root = loadE2ERunContext().workspacesDirectory;
    const first = path.join(root, "click-project");
    const second = path.join(root, "other-project");
    const sameName = path.join(root, "another-checkout", "click-project");
    const firstProjectLinkLabel = `Filter threads by project click-project · ${first}`;
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await mkdir(sameName, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openWorkspaceDirectory(page, first);
    const firstThread = await createDraftThread(page);
    const initialSidebar = page.getByTestId("desktop-sidebar");
    await initialSidebar.getByTestId("workspace-picker").click();
    await page.getByLabel("Absolute directory path").fill(sameName);
    const added = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/workspaces/open") && response.status() === 201);
    await page.getByRole("dialog", { name: "Add project" }).getByRole("button", { name: "Add project", exact: true }).click();
    const sameWorkspace = await (await added).json();
    await expect(page.getByRole("dialog", { name: "Add project" })).toBeHidden();
    await expect(initialSidebar.getByTestId("project-row").filter({ hasText: "click-project" })).toHaveCount(2);
    // The name filter includes both directories; creation still needs one ID.
    await initialSidebar.getByTestId("new-thread-trigger").click();
    const concreteProject = page.getByRole("combobox", { name: "Project", exact: true });
    await expect(concreteProject).toContainText("Choose a project");
    await expect(page.getByRole("button", { name: "Create thread", exact: true })).toBeDisabled();
    await concreteProject.click();
    await expect(page.getByRole("option", { name: `click-project · ${first}`, exact: true })).toBeVisible();
    await page.getByRole("option", { name: `click-project · ${sameName}`, exact: true }).click();
    await selectCustomNewThreadTarget(page, "Pi SDK");
    await capture(page, testInfo, "same-name-project-creation.png");
    const sameCreated = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/threads") && response.status() === 201);
    await page.getByRole("button", { name: "Create thread", exact: true }).click();
    const sameResponse = await sameCreated;
    expect(sameResponse.request().postDataJSON()).toMatchObject({ workspaceId: sameWorkspace.id });
    const sameThreadId = (await sameResponse.json()).threadId;
    await openWorkspaceDirectory(page, second);
    const selectedThread = await createDraftThread(page);
    const sidebar = page.getByTestId("desktop-sidebar");
    await sidebar.getByTestId("view-options-trigger").click();
    await page.getByRole("radiogroup", { name: "Group by" }).getByRole("radio", { name: "Timeline" }).click();
    await sidebar.getByTestId("view-options-trigger").click();
    await page.getByRole("radiogroup", { name: "Density" }).getByRole("radio", { name: "Card", exact: true }).click();
    await page.keyboard.press("Escape");
    const clearProject = async () => {
      await sidebar.getByTestId("project-filter").click();
      await page.getByRole("option", { name: "All projects", exact: true }).click();
    };
    await clearProject();
    const firstRow = sidebar.locator(`[data-thread-id="${firstThread.split("/").pop()}"]`).first();
    const secondRow = sidebar.locator(`[data-thread-id="${selectedThread.split("/").pop()}"]`).first();
    const sameNameRow = sidebar.locator(`[data-thread-id="${sameThreadId}"]`).first();
    await sidebar.getByTestId("project-filter").click();
    await expect(page.getByRole("option", { name: "click-project", exact: true })).toHaveCount(1);
    await page.getByRole("option", { name: "click-project", exact: true }).click();
    await expect(firstRow).toBeVisible();
    await expect(sameNameRow).toBeVisible();
    await expect(secondRow).toHaveCount(0);
    await clearProject();
    await expect(firstRow.getByTestId("flat-row-project")).toBeVisible();
    await expect(firstRow.getByRole("button", { name: firstProjectLinkLabel, exact: true })).toHaveCount(0);
    await expect(firstRow.getByTestId("flat-row-environment")).toHaveCount(0);

    // A configured second environment makes Local meaningful even before a
    // remote backend or thread exists. No remote connection is needed here.
    const environments = await openSettingsPage(page, "environments");
    await environments.getByRole("button", { name: "Add environment", exact: true }).click();
    await environments.getByRole("button", { name: /^SSH host/u }).click();
    await environments.getByLabel("Environment name", { exact: true }).fill("AW personal");
    await environments.getByLabel("SSH host alias", { exact: true }).fill("e2e-unreachable");
    await environments.getByLabel("Workspace roots", { exact: true }).fill("/work/e2e");
    await environments.getByRole("button", { name: "Save environment", exact: true }).click();
    await expect(environments.getByRole("heading", { name: "AW personal", exact: true })).toBeVisible();
    await returnFromSettings(page);
    // Configuration reconciliation publishes the environment to the live sidebar.
    await expect(firstRow.getByTestId("flat-row-environment")).toHaveText("Local");
    await expect(firstRow.getByRole("button", { name: "Filter threads by environment Local" })).toHaveCount(0);

    const settings = await openSettingsPage(page, "general");
    const preference = settings.getByRole("checkbox", { name: "Click project and environment names to filter", exact: true });
    await expect(preference).not.toBeChecked();
    await preference.check();
    await capture(page, testInfo, "project-name-filter-setting.png");
    await returnFromSettings(page);
    const project = firstRow.getByRole("button", { name: firstProjectLinkLabel, exact: true });
    await expect(project).toBeVisible();
    await capture(page, testInfo, "project-name-filter-desktop.png");
    const environment = firstRow.getByRole("button", { name: "Filter threads by environment Local", exact: true });
    for (const activation of ["click", "Enter", "Space"] as const) {
      if (activation === "click") await environment.click();
      else {
        await environment.focus();
        await environment.press(activation);
      }
      await expect(sidebar.getByTestId("environment-filter")).toContainText("Local");
      await expect(firstRow).toBeVisible();
      await expect(secondRow).toBeVisible();
      await expect(page).toHaveURL(selectedThread);
      await expect(firstRow.getByTestId("flat-row-environment")).toHaveCount(0);
      await sidebar.getByRole("button", { name: "Clear", exact: true }).click();
      await expect(environment).toBeVisible();
    }
    await project.click();
    await expect(secondRow).toHaveCount(0);
    await expect(sameNameRow).toBeVisible();
    await expect(page).toHaveURL(selectedThread);
    await clearProject();
    await project.focus();
    await project.press("Enter");
    await expect(secondRow).toHaveCount(0);
    await expect(sameNameRow).toBeVisible();
    await expect(page).toHaveURL(selectedThread);
    await clearProject();
    await project.focus();
    await project.press("Space");
    await expect(secondRow).toHaveCount(0);
    await expect(sameNameRow).toBeVisible();
    await clearProject();
    await firstRow.getByTestId("thread-row-link").click();
    await expect(page).toHaveURL(firstThread);
    await secondRow.getByTestId("thread-row-link").click();
    await expect(page).toHaveURL(selectedThread);

    await page.reload();
    await expect(project).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open thread navigation", exact: true }).click();
    const mobileProject = page.locator(`[data-thread-id="${firstThread.split("/").pop()}"]`)
      .filter({ visible: true }).getByRole("button", {
        name: firstProjectLinkLabel, exact: true,
      });
    await expect(mobileProject).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "project-name-filter-mobile.png");
    const drawer = page.getByRole("dialog", { name: "Thread navigation" });
    await drawer.locator(`[data-thread-id="${firstThread.split("/").pop()}"]`)
      .getByRole("button", { name: "Filter threads by environment Local", exact: true }).tap();
    await expect(drawer.getByTestId("environment-filter")).toContainText("Local");
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(selectedThread);
    await drawer.getByRole("button", { name: "Clear", exact: true }).tap();
    await mobileProject.tap();
    await expect(page).toHaveURL(selectedThread);
    await expect(page.getByRole("dialog", { name: "Thread navigation" })).toBeVisible();
    await expect(page.getByTestId("project-filter").filter({ visible: true })).toContainText("click-project");
    await expect(drawer.locator(`[data-thread-id="${sameThreadId}"]`).first()).toBeVisible();

    await page.getByRole("button", { name: "Close thread navigation", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Thread navigation" })).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await clearProject();
    await openSettingsPage(page, "general");
    await expect(preference).toBeChecked();
    await preference.uncheck();
    await returnFromSettings(page);
    await expect(project).toHaveCount(0);
    await expect(environment).toHaveCount(0);
    await expect(firstRow.getByTestId("flat-row-environment")).toHaveText("Local");
    await firstRow.getByTestId("flat-row-environment").click();
    await expect(page).toHaveURL(firstThread);
  });
});
