import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { loadE2ERunContext } from "./run-context";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  capture,
  expectNoPageOverflow,
  repositoryLabel,
  selectCustomNewThreadTarget,
  selectProjectIfNeeded,
} from "./helpers";

const primaryTitle = "Primary target scope acceptance";
const alternateTitle = "Alternate target scope acceptance";
const browsedProjectLabel = "src";
const fixtureRoot = path.join(
  loadE2ERunContext().workspacesDirectory,
  repositoryLabel,
);

async function directoryBrowseResponse(page: Page) {
  const response = await page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/directories/browse"),
  );
  expect(response.status(), await response.text()).toBe(200);
  return response;
}

async function browseFixtureRoot(
  page: Page,
  dialog: Locator,
  pathLabel: string,
): Promise<void> {
  await dialog.getByLabel(pathLabel).fill(fixtureRoot);
  await Promise.all([
    directoryBrowseResponse(page),
    dialog.getByRole("button", { name: "Browse", exact: true }).click(),
  ]);
}

async function browseInto(
  page: Page,
  dialog: Locator,
  directoryName: string,
): Promise<void> {
  await Promise.all([
    directoryBrowseResponse(page),
    dialog
      .getByRole("list", { name: "Directories" })
      .getByRole("button", {
        name: new RegExp(
          `^${directoryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: —|$)`,
        ),
      })
      .click(),
  ]);
}

async function openBrowsedProject(page: Page): Promise<void> {
  const picker = page
    .getByTestId("desktop-sidebar")
    .getByTestId("workspace-picker");
  await Promise.all([
    directoryBrowseResponse(page),
    picker.click(),
  ]);

  const dialog = page.getByRole("dialog", { name: "Add project" });
  await expect(
    dialog.getByRole("combobox", { name: "Directory environment" }),
  ).toContainText("Local");
  await browseFixtureRoot(page, dialog, "Absolute directory path");
  await browseInto(page, dialog, browsedProjectLabel);
  await expect(dialog.getByLabel("Absolute directory path")).toHaveValue(
    path.join(fixtureRoot, browsedProjectLabel),
  );
}

async function openNewThread(page: Page, title: string): Promise<void> {
  const trigger = page
    .getByTestId("desktop-sidebar")
    .getByTestId("new-thread-trigger");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await page.getByRole("textbox", { name: "Thread name" }).fill(title);
  await selectProjectIfNeeded(page, browsedProjectLabel);
}

async function expectMinimumHeight(
  locator: Locator,
  minimum: number,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(minimum);
}

async function expectMatchingSidebarActions(
  sidebar: Locator,
  minimumHeight: number,
): Promise<void> {
  const actions = [
    sidebar.getByTestId("new-thread-trigger"),
    sidebar.getByTestId("workspace-picker"),
  ];
  const [newThread, addProject] = await Promise.all(actions.map(async (action) => {
    await expect(action).toBeVisible();
    return action.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        style: {
          fontSize: style.fontSize, fontWeight: style.fontWeight,
          fontFamily: style.fontFamily, lineHeight: style.lineHeight,
          background: style.backgroundColor, color: style.color,
          borderRadius: style.borderRadius, padding: style.padding,
        },
      };
    });
  }));
  expect(Math.abs(newThread!.y - addProject!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(newThread!.width - addProject!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(newThread!.height - addProject!.height)).toBeLessThanOrEqual(1);
  expect(newThread!.x + newThread!.width).toBeLessThan(addProject!.x);
  expect(newThread!.height).toBeGreaterThanOrEqual(minimumHeight);
  expect(addProject!.height).toBeGreaterThanOrEqual(minimumHeight);
  expect(newThread!.style).toEqual(addProject!.style);
}

async function searchDirectoryEnvironment(
  page: Page,
  testInfo: TestInfo,
  screenshot: string,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
  const trigger = dialog.getByRole("combobox", { name: "Directory environment" });
  const pathInput = dialog.getByLabel("Absolute directory path");
  const selectedPath = await pathInput.inputValue();
  await trigger.click();
  const search = page.getByRole("combobox", { name: "Search environments" });
  if (page.viewportSize()!.width <= 819) {
    await expect(search).not.toBeFocused();
    await search.click();
  }
  await expect(search).toBeFocused();
  await search.fill("LOCAL");
  await expect(page.getByRole("option", { name: "Local", exact: true })).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(search).toBeInViewport();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, screenshot);
  await search.press("Enter");
  await expect(search).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText("Local");
  await expect(pathInput).toHaveValue(selectedPath);
  await expect(dialog).toBeVisible();
}

async function expectMobileProjectSheet(page: Page, dialog: Locator): Promise<void> {
  const viewport = page.viewportSize()!;
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeCloseTo(0, 0);
  expect(bounds!.width).toBeCloseTo(viewport.width, 0);
  expect(bounds!.y).toBeGreaterThanOrEqual(15);
  expect(bounds!.y + bounds!.height).toBeCloseTo(viewport.height, 0);
  await expectMinimumHeight(dialog.getByRole("button", { name: "Cancel", exact: true }), 44);
  await expectMinimumHeight(dialog.getByLabel("Absolute directory path"), 44);
  await expectNoPageOverflow(page);
}

async function searchProjectFilter(page: Page, projects: Locator, kind: "environment" | "status", query: string, choice: string, testInfo: TestInfo, screenshot: string): Promise<void> {
  const trigger = projects.getByRole("combobox", { name: kind === "environment" ? "Project environment" : "Project status" });
  await trigger.click();
  const search = page.getByRole("combobox", { name: kind === "environment" ? "Search environments" : "Search project statuses" });
  if (page.viewportSize()!.width <= 819) {
    await expect(search).not.toBeFocused();
    await search.click();
  }
  await expect(search).toBeFocused();
  await search.fill(query);
  await expect(page.getByRole("option", { name: choice, exact: true })).toBeVisible();
  await expect(search).toBeInViewport();
  await capture(page, testInfo, screenshot);
  await search.press("Enter");
  await expect(search).toBeHidden();
  await expect(trigger).toContainText(choice);
  await expect(trigger).toBeFocused();
}

test("sidebar execution scope filters creation and persists responsively", async ({
  page,
}, testInfo) => {
  // Directory pages are fenced against concurrent filesystem changes. Keep
  // browsing isolated from other jobs and development writes in the checkout.
  await mkdir(path.join(fixtureRoot, browsedProjectLabel), { recursive: true });
  await mkdir(path.join(fixtureRoot, "docs"), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, browsedProjectLabel, "example.ts"),
    "export const fixture = true;\n",
  );
  await writeFile(
    path.join(fixtureRoot, "docs", "guide.md"),
    "# Sidebar scope fixture\n",
  );
  await page.goto("/");
  const desktopSidebar = page.getByTestId("desktop-sidebar");
  await expect(
    desktopSidebar.getByRole("img", { name: "Application connected" }),
  ).toHaveCount(0);
  await expect(desktopSidebar.getByTestId("view-quick-toggle")).toHaveAccessibleName("Switch to Projects");
  await expectMatchingSidebarActions(desktopSidebar, 34);
  {
    await openBrowsedProject(page);
    const projectDialog = page.getByRole("dialog", { name: "Add project" });
    await searchDirectoryEnvironment(page, testInfo, "directory-picker-environment-search-desktop.png");
    await capture(page, testInfo, "directory-picker-add-project-desktop.png");
    const initialViewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectMobileProjectSheet(page, projectDialog);
    await searchDirectoryEnvironment(page, testInfo, "directory-picker-environment-search-mobile.png");
    await capture(page, testInfo, "add-project-bottom-sheet-mobile.png");
    await page.setViewportSize({ width: 320, height: 480 });
    await expectMobileProjectSheet(page, projectDialog);
    await projectDialog.getByRole("button", { name: "Cancel", exact: true }).scrollIntoViewIfNeeded();
    await expect(projectDialog.getByRole("button", { name: "Add project", exact: true })).toBeInViewport();
    await capture(page, testInfo, "add-project-bottom-sheet-mobile-short.png");
    await page.setViewportSize(initialViewport!);
    const opened = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/workspaces/open") &&
        response.status() === 201,
    );
    await projectDialog.getByRole("button", { name: "Add project" }).click();
    const openResponse = await opened;
    expect(openResponse.request().postDataJSON()).toMatchObject({
      path: path.join(fixtureRoot, browsedProjectLabel),
    });
    await expect(projectDialog).toBeHidden();
    await expect(
      desktopSidebar
        .getByTestId("project-filter"),
    ).toContainText(browsedProjectLabel);
  }

  await openNewThread(page, primaryTitle);
  await selectCustomNewThreadTarget(page, /^Pi SDK$/);
  const primaryCreated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Create thread" }).click();
  await primaryCreated;
  await expect(
    desktopSidebar.getByText(primaryTitle, { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Files(?: —|$)/ }).click();
  const filesPanel = page.getByRole("region", { name: "Workspace files" });
  await expect(filesPanel).toBeVisible({ timeout: 15_000 });
  await Promise.all([
    directoryBrowseResponse(page),
    page.getByRole("button", { name: "Add folder to Files" }).click(),
  ]);
  const supplementalDialog = page.getByRole("dialog", {
    name: "Add folder to Files",
  });
  const fixedEnvironment = supplementalDialog.getByLabel("Environment", { exact: true });
  await expect(fixedEnvironment).toHaveValue("Local");
  await expect(fixedEnvironment).toHaveAttribute("readonly", "");
  await browseFixtureRoot(page, supplementalDialog, "Absolute folder path");
  await browseInto(page, supplementalDialog, "docs");
  await supplementalDialog
    .getByRole("textbox", { name: "Folder display label" })
    .fill("Project docs");
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await expect(
    supplementalDialog
      .getByRole("navigation", { name: "Directory breadcrumbs" })
      .getByRole("button", { name: "docs", exact: true }),
  ).toBeInViewport();
  await capture(page, testInfo, "directory-picker-supplemental-mobile.png");
  const attached = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/file-roots") &&
      response.status() === 201,
  );
  await supplementalDialog
    .getByRole("button", { name: "Add folder", exact: true })
    .click();
  const attachResponse = await attached;
  expect(attachResponse.request().postDataJSON()).toMatchObject({
    path: path.join(fixtureRoot, "docs"),
    displayLabel: "Project docs",
  });
  await expect(supplementalDialog).toBeHidden();
  const treeToggle = page.getByRole("button", { name: "Toggle file browser" });
  if ((await treeToggle.getAttribute("aria-expanded")) !== "true") {
    await treeToggle.click();
  }
  await expect(
    filesPanel.getByRole("tab", { name: "Project docs" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse Files panel" }).click();
  await page.setViewportSize(desktopViewport ?? { width: 1280, height: 720 });

  const targetFilter = desktopSidebar.getByTestId("target-filter");
  const originalTargetScope = await targetFilter.getAttribute("data-scope-value");
  await targetFilter.focus();
  await page.keyboard.press("Enter");
  const targetSearch = page.getByRole("combobox", {
    name: "Search targets",
    exact: true,
  });
  await expect(targetSearch).toBeFocused();
  await targetSearch.fill("scope-no-such-target");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(
    page.getByRole("listbox", { name: "Target filter options", exact: true }).getByRole("status"),
  ).toHaveText("No matching targets");
  await targetSearch.press("Enter");
  await expect(targetSearch).toBeVisible();
  await expect(page.getByRole("option", { name: "All targets", exact: true })).toBeVisible();
  await expect(targetFilter).toHaveAttribute("data-scope-value", originalTargetScope!);
  await expect(desktopSidebar.getByText(primaryTitle, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(targetSearch).toBeHidden();
  await expect(targetFilter).toBeFocused();
  await targetFilter.click();
  await targetSearch.fill("alternate");
  await targetSearch.press("Tab");
  await expect(targetSearch).toBeHidden();
  await expect(desktopSidebar.getByTestId("project-filter")).toBeFocused();
  await expect(targetFilter).toHaveAttribute("data-scope-value", originalTargetScope!);

  await targetFilter.click();
  await expect(targetSearch).toHaveValue("");
  await targetSearch.fill("alternate");
  const alternateOption = page.getByRole("option", {
    name: "Alternate scripted agent · Pi SDK",
    exact: true,
  });
  await expect(alternateOption).toBeVisible();
  await expect(page.getByRole("option", { name: "Pi SDK", exact: true })).toHaveCount(0);
  await capture(page, testInfo, "sidebar-scope-search-desktop.png");
  await targetSearch.press("ArrowUp");
  await expect(page.getByRole("option", { name: "All targets", exact: true })).toHaveAttribute("data-active", "true");
  await targetSearch.press("ArrowDown");
  await expect(alternateOption).toHaveAttribute("data-active", "true");
  await targetSearch.press("Enter");
  await expect(targetSearch).toBeHidden();
  await expect(targetFilter).toBeFocused();
  await expect(targetFilter).toContainText("Alternate scripted agent");
  const alternateTargetId = await targetFilter.getAttribute("data-scope-value");
  expect(alternateTargetId).toBeTruthy();
  await expect(
    desktopSidebar.getByText(primaryTitle, { exact: true }),
  ).toHaveCount(0);

  await openNewThread(page, alternateTitle);
  const agentPicker = page.getByRole("combobox", { name: "Agent" });
  await agentPicker.click();
  await page.getByRole("option", { name: /Custom/ }).click();
  await expect(
    page.getByRole("combobox", { name: "Target", exact: true }),
  ).toHaveCount(0);

  const alternateCreated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Create thread" }).click();
  const createResponse = await alternateCreated;
  expect(createResponse.request().postDataJSON()).toMatchObject({
    title: alternateTitle,
    configuration: {
      kind: "custom",
      targetId: alternateTargetId,
    },
  });
  await expect(
    desktopSidebar.getByText(alternateTitle, { exact: true }),
  ).toBeVisible();
  await expect(
    desktopSidebar.getByText(primaryTitle, { exact: true }),
  ).toHaveCount(0);

  const scopeToggle = desktopSidebar.getByRole("button", {
    name: /Collapse thread scope/,
  });
  await expect(scopeToggle).toHaveAttribute("aria-expanded", "true");
  await capture(page, testInfo, "sidebar-execution-scope-expanded-desktop.png");
  await scopeToggle.click();
  await expect(
    desktopSidebar.getByRole("button", { name: /Expand thread scope/ }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.reload();

  const persistedScopeToggle = desktopSidebar.getByRole("button", {
    name: /Expand thread scope/,
  });
  await expect(persistedScopeToggle).toHaveAttribute("aria-expanded", "false");
  await expect(desktopSidebar.getByTestId("target-filter")).toHaveCount(0);
  await expect(desktopSidebar).toContainText("Alternate scripted agent");
  await capture(
    page,
    testInfo,
    "sidebar-execution-scope-collapsed-desktop.png",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open thread navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Thread navigation" });
  await expect(drawer).toBeVisible();
  const workbenchBar = page.getByTestId("workspace-workbench-bar");
  const closeNavigation = page.getByRole("button", {
    name: "Close thread navigation",
  });
  await expect(workbenchBar).toBeVisible();
  await expect(closeNavigation).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: /thread navigation/ }),
  ).toHaveCount(0);
  const [workbenchBarBox, drawerBox, closeNavigationBox] = await Promise.all([
    workbenchBar.boundingBox(),
    drawer.boundingBox(),
    closeNavigation.boundingBox(),
  ]);
  expect(workbenchBarBox).not.toBeNull();
  expect(drawerBox).not.toBeNull();
  expect(closeNavigationBox).not.toBeNull();
  expect(
    Math.abs(drawerBox!.y - (workbenchBarBox!.y + workbenchBarBox!.height)),
  ).toBeLessThanOrEqual(1);
  expect(
    closeNavigationBox!.y + closeNavigationBox!.height,
  ).toBeLessThanOrEqual(drawerBox!.y);
  const mobileScopeToggle = drawer.getByRole("button", {
    name: /Expand thread scope/,
  });
  await mobileScopeToggle.click();
  await expect(
    drawer.getByRole("button", { name: /Collapse thread scope/ }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(drawer.getByTestId("target-filter")).toContainText(
    "Alternate scripted agent",
  );

  const mobileProjectFilter = drawer.getByTestId("project-filter");
  await mobileProjectFilter.click();
  const projectSearch = page.getByRole("combobox", { name: "Search projects", exact: true });
  await expect(projectSearch).not.toBeFocused();
  await projectSearch.click();
  await expect(projectSearch).toBeFocused();
  await projectSearch.fill(path.join(repositoryLabel, browsedProjectLabel));
  const browsedProjectOption = page.getByRole("option", { name: /^src\b/ });
  await expect(browsedProjectOption).toBeVisible();
  await expect(projectSearch).toBeInViewport();
  await expect(browsedProjectOption).toBeInViewport();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "sidebar-scope-search-mobile.png");
  await browsedProjectOption.click();
  await expect(mobileProjectFilter).toContainText(browsedProjectLabel);
  await expect(drawer.getByTestId("target-filter")).toHaveAttribute("data-scope-value", alternateTargetId!);
  await expect(drawer.getByText(alternateTitle, { exact: true })).toBeVisible();

  await expectMinimumHeight(drawer.getByTestId("target-filter"), 44);
  await expectMinimumHeight(drawer.getByTestId("project-filter"), 44);
  await expectMinimumHeight(drawer.getByTestId("new-thread-trigger"), 44);
  await expectMinimumHeight(drawer.getByRole("button", { name: "Add project", exact: true }), 44);
  await expectMatchingSidebarActions(drawer, 44);
  await drawer.getByTestId("new-thread-trigger").click();
  const mobileNewThread = page.getByRole("dialog", { name: "New thread", exact: true });
  await mobileNewThread.getByRole("textbox", { name: "Thread name" }).fill("Preserve this mobile draft");
  await mobileNewThread.getByRole("button", { name: "Add project", exact: true }).click();
  const mobileAddProject = page.getByRole("dialog", { name: "Add project", exact: true });
  await expect(mobileAddProject.getByLabel("Absolute directory path")).toBeVisible();
  await expect(mobileAddProject.getByLabel("Environment", { exact: true })).toHaveAttribute("readonly", "");
  await expectMobileProjectSheet(page, mobileAddProject);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "add-project-from-new-thread-mobile.png");
  await mobileAddProject.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(mobileNewThread.getByRole("textbox", { name: "Thread name" })).toHaveValue("Preserve this mobile draft");
  await mobileNewThread.getByRole("button", { name: "Cancel", exact: true }).click();

  const drawerDimensions = await drawer.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(drawerDimensions.scrollWidth).toBeLessThanOrEqual(
    drawerDimensions.clientWidth,
  );
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "sidebar-execution-scope-expanded-mobile.png");

  const settingsTrigger = drawer.getByRole("button", { name: "Settings" });
  const footerMenuTrigger = drawer.getByRole("button", {
    name: "More",
  });
  const [settingsBox, footerMenuBox] = await Promise.all([
    settingsTrigger.boundingBox(),
    footerMenuTrigger.boundingBox(),
  ]);
  expect(settingsBox).not.toBeNull();
  expect(footerMenuBox).not.toBeNull();
  expect(footerMenuBox!.x + footerMenuBox!.width).toBeLessThanOrEqual(
    settingsBox!.x,
  );
  await footerMenuTrigger.click();
  const footerMenu = page.getByRole("menu");
  await expect(footerMenu).toBeVisible();
  await expect(footerMenu).toHaveAttribute("data-side", "top");
  const agentsMenuItem = footerMenu.getByRole("menuitem", { name: "Agents" });
  await expect(agentsMenuItem).toBeVisible();
  await expect(
    footerMenu.getByRole("menuitem", { name: "Archived threads" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      agentsMenuItem.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return hitTarget === element || element.contains(hitTarget);
      }),
    )
    .toBe(true);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Panels" }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");

  // Project registration belongs to the account and survives removal/restoration.
  await page.setViewportSize(desktopViewport!);
  await page.goto("/settings/projects");
  const projects = page.getByRole("region", { name: "Projects", exact: true });
  const projectRow = projects.getByRole("listitem").filter({ hasText: path.join(fixtureRoot, browsedProjectLabel) });
  await searchProjectFilter(page, projects, "environment", "LOCAL", "Local", testInfo, "projects-environment-search-desktop.png");
  // The scripted Codex discovery adds "Imported Codex history — src" alongside
  // the two threads created above, regardless of the sidebar's target filter.
  await expect(projectRow).toContainText("3 threads");
  await projects.getByRole("heading", { name: "Projects", exact: true }).scrollIntoViewIfNeeded();
  await capture(page, testInfo, "projects-settings-desktop.png");
  await projectRow.getByRole("button", { name: `Remove project ${browsedProjectLabel}` }).click();
  const removal = page.getByRole("dialog", { name: `Remove project ${browsedProjectLabel}?` });
  await expect(removal).toContainText("Files, conversation history, and saved application data are retained");
  const removed = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/remove"));
  await removal.getByRole("button", { name: "Remove project", exact: true }).click();
  const removedResponse = await removed;
  expect(removedResponse.status(), await removedResponse.text()).toBe(200);
  const removedProject = await removedResponse.json() as { id: string };
  await expect(projectRow.getByRole("button", { name: `Restore project ${browsedProjectLabel}` })).toBeVisible();
  await expect(desktopSidebar.getByText(alternateTitle, { exact: true })).toBeHidden();
  await expect(desktopSidebar.getByText(primaryTitle, { exact: true })).toBeHidden();
  await page.reload();
  const restored = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/api/workspaces/${removedProject.id}/open`));
  await projectRow.getByRole("button", { name: `Restore project ${browsedProjectLabel}` }).click();
  const restoredResponse = await restored;
  expect(restoredResponse.status(), await restoredResponse.text()).toBe(200);
  expect(await restoredResponse.json()).toMatchObject({ id: removedProject.id });
  await expect(projectRow).toContainText("3 threads");
  await expect(projectRow.getByRole("button", { name: `Remove project ${browsedProjectLabel}` })).toBeVisible();
  await expect(desktopSidebar.getByText(alternateTitle, { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectMinimumHeight(projectRow.getByRole("button", { name: `Remove project ${browsedProjectLabel}` }), 44);
  await expectNoPageOverflow(page);
  await projects.getByRole("button", { name: "Filters", exact: true }).click();
  await searchProjectFilter(page, projects, "environment", "LOCAL", "Local", testInfo, "projects-environment-search-mobile.png");
  await searchProjectFilter(page, projects, "status", "remembered", "Remembered projects", testInfo, "projects-status-search-mobile.png");
  await projects.getByRole("button", { name: "Show results", exact: true }).click();
  await expect(projects.getByRole("button", { name: "Filters (2)", exact: true })).toBeVisible();
  await expect(projectRow).toContainText("3 threads");
  await projects.getByRole("heading", { name: "Projects", exact: true }).scrollIntoViewIfNeeded();
  await capture(page, testInfo, "projects-settings-mobile.png");

});
