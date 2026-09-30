import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { configurationSnapshotSchema } from "../../src/shared/protocol/configuration-admin.js";
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

  const sidebar = page.getByTestId("desktop-sidebar");
  const inventory = sidebar.locator(".desktop-sidebar-inventory");
  await sidebar.getByTestId("settings-trigger").click();
  // With the nav in the sidebar slot, /settings opens a page instead of a list.
  await expect(page).toHaveURL("/settings/general");
  const settings = page.getByTestId("settings-view");
  await expect(settings).toBeVisible();
  const navigation = sidebar.getByRole("navigation", { name: "Settings pages", exact: true });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: "General", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(settings.getByRole("heading", { name: "General", level: 1 })).toBeVisible();
  // Categories are listed once: no in-page nav, picker or list.
  await expect(settings.getByRole("navigation")).toHaveCount(0);
  await expect(settings.getByRole("combobox", { name: "Settings category" })).toHaveCount(0);
  await expect(settings.getByTestId("settings-page")).toHaveCount(0);
  // The inventory is retained under the nav, same width, and inert.
  await expect(inventory).toHaveAttribute("inert", "");
  await expect(inventory).toHaveAttribute("aria-hidden", "true");
  await expect(inventory).toHaveCSS("opacity", "0");
  const [sidebarBounds, navigationBounds] = await Promise.all([sidebar.boundingBox(), navigation.boundingBox()]);
  expect(navigationBounds!.x).toBe(sidebarBounds!.x);
  expect(Math.abs(navigationBounds!.width - (sidebarBounds!.width - 1))).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("settings-return")).toHaveText("Back to chat");
  expect(await originalComposer!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.getByTestId("composer")).toBeHidden();
  await capture(page, testInfo, "settings-home-desktop.png");

  await expect(settings.getByTestId("seek-on-submit-toggle")).toBeVisible();
  await expect(settings.getByTestId("seek-diagnostics-toggle")).toHaveCount(0);
  await selectSettingsCategory(page, "diagnostics");
  await expect(page).toHaveURL("/settings/diagnostics");
  await expect(settings.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Diagnostics", exact: true })).toHaveAttribute("aria-current", "page");
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
  await expect(inventory).not.toHaveAttribute("inert");
  await expect(navigation).toHaveCount(0);
  await expect(composer).toHaveValue(draft);
  await expect(sidebar.getByTestId("settings-trigger")).toBeFocused();
  expect(await composer.evaluate((element, previous) => element === previous, originalComposer)).toBe(true);
  expect(await composer.evaluate(element => element.scrollTop)).toBe(scrollTop);

  // The landing reopens the last page shown and replaces its own entry.
  await sidebar.getByTestId("settings-trigger").click();
  await expect(page).toHaveURL("/settings/appearance");
  await page.goBack();
  await expect(page).toHaveURL(threadPath);
  await expect(sidebar.getByTestId("settings-trigger")).toBeFocused();

  // History navigation can capture any workspace control, not just the drawer trigger.
  const headerButton = page.getByRole("button", { name: "Find in thread", exact: true, includeHidden: true });
  await headerButton.focus();
  await page.goForward();
  await expect(page).toHaveURL("/settings/appearance");
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
  await expect(page).toHaveURL("/settings/appearance");
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
  await expect(settings).toHaveAttribute("data-nav", "compact");
  await expect(settings.getByRole("heading", { name: "General", level: 1 })).toBeVisible();
  await expect(settings.getByTestId("settings-list-link")).toHaveText("Settings");
  const returnFocus = await observeWorkspaceRevealFocus(
    page.locator('.application-workspace .sidebar-nav-trigger'),
  );
  // A page goes back to the list, and the list returns to the workspace.
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
  const back = settings.getByTestId("settings-list-link");
  const content = settings.locator(".settings-content");
  await expect(settings.getByRole("heading", { name: "General", level: 1 })).toBeVisible();
  await expect(back).toHaveText("Settings");
  await page.reload();
  await expect(page).toHaveURL("/settings/general");
  await expect(settings.getByTestId("activity-detail-setting")).toBeVisible();
  await back.click();
  await expect(page).toHaveURL("/settings");
  const list = settings.getByTestId("settings-page");
  await expect(settings.getByRole("link", { name: "Environments", exact: true })).toBeVisible();
  await expect(settings.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
  await expect(settings.getByRole("link", { name: "Environments", exact: true })).toHaveAccessibleDescription("Where agents run and what they can reach.");
  await expect(settings.getByRole("heading", { name: "Execution", level: 2 })).toBeVisible();
  await expect(settings.getByTestId("settings-return")).toHaveText("Back to workspace");
  expect(await list.count()).toBeGreaterThanOrEqual(10);
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
    await expect(back).toBeInViewport({ ratio: 1 });
    const backBounds = (await back.boundingBox())!;
    expect(backBounds.height).toBeGreaterThanOrEqual(44);
    await expectNoPageOverflow(page);
    expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await capture(page, testInfo, `settings-diagnostics-scrolled-mobile-${width}.png`);
    await page.reload();
    await expect(page).toHaveURL("/settings/diagnostics");
    await expect(settings.getByRole("heading", { name: "Diagnostics", level: 1 })).toBeVisible();
    await expect(settings.getByTestId("seek-diagnostics-toggle")).toBeVisible();
    await selectSettingsCategory(page, "backends");
    await expect(page).toHaveURL("/settings/backends");
    await expect(settings.getByRole("region", { name: "Configured backends", exact: true })).toBeVisible();
    await selectSettingsCategory(page, "projects");
    await expect(page).toHaveURL("/settings/projects");
    await expect(settings.getByRole("region", { name: "Projects", exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
  }

  await page.reload();
  await expect(page).toHaveURL("/settings/projects");
  await expect(settings.getByRole("region", { name: "Projects", exact: true })).toBeVisible();

  await page.goto("/settings/tool-clients");
  await expect(settings.getByRole("heading", { name: "Tool clients", exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL("/settings/tool-clients");
  await expect(settings.getByRole("heading", { name: "Tool clients", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 320 });
  const navigation = page.getByTestId("desktop-sidebar").getByRole("navigation", { name: "Settings pages", exact: true });
  await expect(navigation).toBeVisible();
  await expect(back).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: "Tool clients", exact: true })).toHaveAttribute("aria-current", "page");
  const navigationScroll = navigation.locator('[data-slot="settings-nav-scroll"]');
  await navigationScroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await navigationScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(navigation.getByRole("link").last()).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("settings-return")).toBeInViewport({ ratio: 1 });
  await expectNoPageOverflow(page);

  // A collapsed desktop sidebar has no slot for the nav: /settings is the
  // list, and restoring the sidebar brings the nav back on the last page.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem("sedes-sidebar-collapsed", "true"));
  await page.goto("/settings");
  await expect(settings).toHaveAttribute("data-nav", "compact");
  await expect(page.getByTestId("desktop-sidebar")).toBeHidden();
  await expect(settings.getByRole("link", { name: "Tool clients", exact: true })).toBeVisible();
  await capture(page, testInfo, "settings-home-collapsed-desktop.png");
  await settings.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expect(page).toHaveURL("/settings/tool-clients");
  await expect(navigation).toBeVisible();
  await expect(settings).toHaveAttribute("data-nav", "sidebar");
  // The landing opened a page, so focus moves to its heading.
  await expect(settings.getByRole("heading", { name: "Tool clients", level: 1 })).toBeFocused();
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
  await settings.getByRole("link", { name: "SSH host", exact: true }).click();
  await expect(page).toHaveURL("/settings/environments/~new/ssh");
  await settings.getByLabel("Environment name", { exact: true }).fill("Discard this draft");
  await page.goBack();
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page).toHaveURL("/settings/environments/~new/ssh");
  await expect(settings.getByLabel("Environment name", { exact: true })).toHaveValue("Discard this draft");
  await page.goBack();
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  // Back walks the add flow's own steps: the kind chooser, then the list.
  await expect(page).toHaveURL("/settings/environments/~new");
  await page.goBack();
  await expect(page).toHaveURL("/settings/environments");
  await page.goBack();
  await expect(page).toHaveURL("/settings/general");
  await page.goForward();
  await expect(page).toHaveURL("/settings/environments");
  await expect(settings.getByRole("region", { name: "Configured environments", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Add environment", exact: true }).click();
  await settings.getByRole("link", { name: "SSH host", exact: true }).click();
  await settings.getByLabel("Environment name", { exact: true }).fill("Another unsaved draft");
  // The sidebar nav's links and return row go through the same guard.
  await page.getByTestId("desktop-sidebar").getByRole("link", { name: "Backends", exact: true }).click();
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page).toHaveURL("/settings/environments/~new/ssh");
  await page.getByTestId("settings-return").click();
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(settings.getByLabel("Environment name", { exact: true })).toHaveValue("Another unsaved draft");
  await page.getByTestId("settings-return").click();
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(settings).toBeHidden();
  expect(writes).toBe(0);
});

test("environment and backend routes live inside the settings shell: nav, history, deep links and the ‹ links", async ({ page }) => {
  const { configuration } = configurationSnapshotSchema.parse(await (await page.request.get("/api/configuration")).json());
  const local = configuration.executionEnvironments[0]!;
  const backend = configuration.backends[0]!;
  const localPath = `/settings/environments/${local.id}`;
  const settings = page.getByTestId("settings-view");
  const sidebar = page.getByTestId("desktop-sidebar");
  const navigation = sidebar.getByRole("navigation", { name: "Settings pages", exact: true });
  const list = settings.getByRole("region", { name: "Configured environments", exact: true });
  const detail = settings.getByRole("region", { name: `${local.label} details`, exact: true });
  const editorBack = settings.getByRole("region", { name: "Environment editor", exact: true }).getByRole("link", { name: local.label, exact: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/general");
  await navigation.getByRole("link", { name: "Environments", exact: true }).click();
  await list.getByRole("link", { name: local.label, exact: true }).click();
  await expect(page).toHaveURL(localPath);
  await expect(navigation.getByRole("link", { name: "Environments", exact: true })).toHaveAttribute("aria-current", "page");
  // With the nav in the sidebar slot the settings column splits at 1440.
  const [listBounds, detailBounds] = await Promise.all([list.boundingBox(), detail.boundingBox()]);
  expect(listBounds!.x + listBounds!.width).toBeLessThanOrEqual(detailBounds!.x);
  await detail.getByRole("button", { name: `Edit ${local.label}`, exact: true }).click();
  await expect(page).toHaveURL(`${localPath}/edit`);
  await editorBack.click();
  await expect(page).toHaveURL(localPath);
  await navigation.getByRole("link", { name: "Appearance", exact: true }).click();
  await expect(page).toHaveURL("/settings/appearance");
  // The ‹ link went back instead of stacking an entry, so Back walks the same path.
  await page.goBack();
  await expect(page).toHaveURL(localPath);
  await expect(detail.getByRole("heading", { name: local.label, level: 2 })).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL("/settings/environments");
  await page.goForward();
  await expect(page).toHaveURL(localPath);
  // From an entity, its page's nav link returns to the list.
  await navigation.getByRole("link", { name: "Environments", exact: true }).click();
  await expect(page).toHaveURL("/settings/environments");
  await expect(detail).toBeHidden();

  // A deep link opens an editor; the landing afterwards opens its page's list.
  await page.goto(`/settings/backends/${encodeURIComponent(backend.id)}/edit`);
  await expect(settings.getByRole("region", { name: "Backend editor", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Backends", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByTestId("settings-return").click();
  await expect(settings).toBeHidden();
  await sidebar.getByTestId("settings-trigger").click();
  await expect(page).toHaveURL("/settings/backends");
  await expect(settings.getByRole("region", { name: "Backend editor", exact: true })).toHaveCount(0);

  // A phone: the list, Environments, the entity and its editor, then up again.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open thread navigation", exact: true }).click();
  await page.locator('[data-testid="settings-trigger"]:not([inert] *)').filter({ visible: true }).click();
  await expect(page).toHaveURL("/settings");
  await settings.getByRole("link", { name: "Environments", exact: true }).click();
  await list.getByRole("link", { name: local.label, exact: true }).click();
  await expect(page).toHaveURL(localPath);
  await expect(list).toBeHidden();
  await detail.getByRole("button", { name: `Edit ${local.label}`, exact: true }).click();
  await expect(page).toHaveURL(`${localPath}/edit`);
  await editorBack.click();
  await expect(page).toHaveURL(localPath);
  await detail.getByRole("link", { name: "Environments", exact: true }).click();
  await expect(page).toHaveURL("/settings/environments");
  await expect(list).toBeVisible();
  await settings.getByTestId("settings-list-link").click();
  await expect(page).toHaveURL("/settings");
  // Each step went back through history, so Back now leaves Settings.
  await page.goBack();
  await expect(page).toHaveURL("/");
});

test("a resource's confirmation closes when Back or the settings nav leaves it", async ({ page }) => {
  const { configuration } = configurationSnapshotSchema.parse(await (await page.request.get("/api/configuration")).json());
  const local = configuration.executionEnvironments[0]!;
  const localPath = `/settings/environments/${local.id}`;
  const settings = page.getByTestId("settings-view");
  const navigation = page.getByTestId("desktop-sidebar").getByRole("navigation", { name: "Settings pages", exact: true });
  const list = settings.getByRole("region", { name: "Configured environments", exact: true });
  const detail = settings.getByRole("region", { name: `${local.label} details`, exact: true });
  const confirmation = page.getByRole("dialog", { name: `Remove ${local.label}?`, exact: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/environments");
  await list.getByRole("link", { name: local.label, exact: true }).click();
  await expect(page).toHaveURL(localPath);
  await detail.getByRole("button", { name: `Remove ${local.label}`, exact: true }).click();
  await expect(confirmation).toBeVisible();
  // Browser Back leaves the resource: its confirmation closes and stays closed.
  await page.goBack();
  await expect(page).toHaveURL("/settings/environments");
  await expect(confirmation).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(localPath);
  await expect(detail).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A modal blocks pointer input, so dispatch the nav link's click as a
  // programmatic navigation would; General then owns the page and focus.
  await list.getByRole("button", { name: `Actions for ${local.label}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove…", exact: true }).click();
  await expect(confirmation).toBeVisible();
  await navigation.getByRole("link", { name: "General", exact: true }).dispatchEvent("click");
  await expect(page).toHaveURL("/settings/general");
  await expect(confirmation).toBeHidden();
  await expect(settings.getByRole("heading", { name: "General", level: 1 })).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(localPath);
  await expect(detail).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Escape goes up one Settings level after open layers and focused fields, through the discard guard", async ({ page }) => {
  const { configuration } = configurationSnapshotSchema.parse(await (await page.request.get("/api/configuration")).json());
  const local = configuration.executionEnvironments[0]!;
  const localPath = `/settings/environments/${local.id}`;
  const settings = page.getByTestId("settings-view");
  const list = settings.getByRole("region", { name: "Configured environments", exact: true });
  const detail = settings.getByRole("region", { name: `${local.label} details`, exact: true });
  const name = settings.getByRole("region", { name: "Environment editor", exact: true }).getByLabel("Environment name", { exact: true });
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const environments = await openSettingsPage(page, "environments");
  await expect(page).toHaveURL("/settings/environments");
  // A focused search field keeps the first Escape: it loses focus, and its
  // own Escape (Chromium clears a search field) still runs. Settings stays.
  const search = list.getByRole("searchbox", { name: "Search environments", exact: true });
  await search.fill("no such environment");
  await expect(list.getByRole("link", { name: local.label, exact: true })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(search).not.toBeFocused();
  await expect(search).toHaveValue("");
  await expect(page).toHaveURL("/settings/environments");
  await list.getByRole("link", { name: local.label, exact: true }).click();
  await detail.getByRole("button", { name: `Edit ${local.label}`, exact: true }).click();
  await expect(page).toHaveURL(`${localPath}/edit`);

  // A dirty editor goes through the discard guard; the dialog takes Escape first.
  await name.fill(`${local.label} escaped`);
  await page.keyboard.press("Escape");
  await expect(name).not.toBeFocused();
  await expect(page).toHaveURL(`${localPath}/edit`);
  await page.keyboard.press("Escape");
  await expect(discard).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(discard).toBeHidden();
  await expect(page).toHaveURL(`${localPath}/edit`);
  await expect(name).toHaveValue(`${local.label} escaped`);
  await blur();
  await page.keyboard.press("Escape");
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(localPath);
  await expect(detail.getByRole("heading", { name: local.label, level: 2 })).toBeFocused();

  // An open menu takes Escape and closes; nothing else happens.
  await list.getByRole("button", { name: `Actions for ${local.label}`, exact: true }).click();
  const menu = page.getByRole("menu", { name: `Actions for ${local.label}`, exact: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL(localPath);
  await expect(detail).toBeVisible();

  // Then editor → entity → list → workspace, as the ‹ links and Back to workspace go.
  await detail.getByRole("button", { name: `Edit ${local.label}`, exact: true }).click();
  await expect(page).toHaveURL(`${localPath}/edit`);
  await blur();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(localPath);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/settings/environments");
  await expect(detail).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  await expect(environments).toBeHidden();

  // Without the sidebar nav: a page goes to the Settings list, the list to the workspace.
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettingsPage(page, "appearance");
  await expect(settings).toHaveAttribute("data-nav", "compact");
  await blur();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/settings");
  await expect(settings.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL("/");
  await expect(settings).toBeHidden();
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
    await page.getByRole("group", { name: "Group by" }).getByRole("menuitemradio", { name: "Timeline" }).click();
    await expect(page.getByRole("menu", { name: "View options" })).toBeHidden();
    await sidebar.getByTestId("view-options-trigger").click();
    await page.getByRole("group", { name: "Density" }).getByRole("menuitemradio", { name: "Card", exact: true }).click();
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
    await environments.getByRole("link", { name: "SSH host", exact: true }).click();
    await environments.getByLabel("Environment name", { exact: true }).fill("AW personal");
    await environments.getByLabel("SSH host alias", { exact: true }).fill("e2e-unreachable");
    await environments.getByLabel("Workspace root 1", { exact: true }).fill("/work/e2e");
    await environments.getByRole("button", { name: "Save environment", exact: true }).click();
    await expect(environments.getByRole("heading", { name: "AW personal", exact: true })).toBeVisible();
    await returnFromSettings(page);
    // Configuration reconciliation publishes the environment to the live sidebar.
    await expect(firstRow.getByTestId("flat-row-environment")).toHaveText("Local");
    await expect(firstRow.getByRole("button", { name: "Filter threads by environment Local" })).toHaveCount(0);

    const settings = await openSettingsPage(page, "general");
    const preference = settings.getByRole("switch", { name: "Click project and environment names to filter", exact: true });
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
