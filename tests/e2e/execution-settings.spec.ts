import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { configurationLifecycleImpactSchema, configurationLifecycleResultSchema, configurationSnapshotSchema, type ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { expect, test } from "./fixtures.js";
import { capture, expectNoPageOverflow, openSettingsPage, selectSettingsCategory } from "./helpers.js";

type Section = "environments" | "backends";

async function openSettings(page: Page, section: "Environments" | "Backends") {
  return openSettingsPage(page, section === "Environments" ? "environments" : "backends");
}

const details = (settings: Locator, label: string) => settings.getByRole("region", { name: `${label} details`, exact: true });
const headerActions = (settings: Locator, label: string) => details(settings, label).getByRole("group", { name: "Actions", exact: true });
const row = (scope: Locator, name: string) => scope.getByRole("listitem").filter({ has: scope.page().getByRole("link", { name, exact: true }) });

/** Returns from an entity to its list: the stacked layout's back link, or the category link. */
async function showList(page: Page, section: Section): Promise<void> {
  const back = page.getByTestId("settings-view").locator('a[data-slot="settings-page-back"][data-stack-only]').filter({ visible: true });
  if (await back.count()) await back.first().click();
  else await selectSettingsCategory(page, section);
  await expect(page).toHaveURL(`/settings/${section}`);
}

/** Backend filters sit behind a toggle when the list is narrow and inline when it is wide. */
async function showBackendFilters(settings: Locator): Promise<void> {
  const toggle = settings.getByRole("button", { name: /^Filters/u });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

async function expectReadableMobileSelect(select: Locator): Promise<void> {
  await expect(select).toBeVisible();
  const metrics = await select.evaluate((element) => {
    const field = element as HTMLSelectElement;
    const style = getComputedStyle(field);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return { height: field.getBoundingClientRect().height,
      availableWidth: field.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
      labelWidth: context.measureText(field.selectedOptions[0]!.label).width };
  });
  expect(metrics.height).toBeGreaterThanOrEqual(44);
  expect(metrics.availableWidth).toBeGreaterThanOrEqual(metrics.labelWidth);
}

test("execution settings persist typed configuration and distinguish unreachable from intentional disconnection", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  let settings = await openSettings(page, "Environments");
  await expect(settings.getByText("Pair a host", { exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Add environment", exact: true }).click();
  await expect(page).toHaveURL("/settings/environments/~new");
  await settings.getByRole("link", { name: "SSH host", exact: true }).click();
  await expect(page).toHaveURL("/settings/environments/~new/ssh");
  await settings.getByLabel("Environment name", { exact: true }).fill("Temporary build host");
  await settings.getByLabel("SSH host alias", { exact: true }).fill("e2e-unreachable");
  await settings.getByLabel("Workspace root 1", { exact: true }).fill("/work/e2e");
  await settings.getByLabel("Interactive terminals", { exact: true }).check();
  await settings.getByRole("button", { name: "Add variable", exact: true }).click();
  await settings.getByLabel("New variable name", { exact: true }).fill("BUILD_STAGE");
  await settings.getByLabel("Value for new variable", { exact: true }).fill("development");
  await settings.getByRole("button", { name: "Add", exact: true }).click();
  await expect(settings.getByLabel("Value for BUILD_STAGE", { exact: true })).toHaveValue("development");
  await capture(page, testInfo, "execution-environment-variables-desktop.png");
  const savedEnvironment = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/api/configuration") && response.ok());
  await settings.getByRole("button", { name: "Save environment", exact: true }).click();
  const saved = configurationSnapshotSchema.parse(await (await savedEnvironment).json());
  const environment = saved.configuration.executionEnvironments.find((entry) => entry.label === "Temporary build host");
  expect(environment?.kind).toBe("ssh");
  expect(environment).toMatchObject({ hostAlias: "e2e-unreachable", workspaceRoots: ["/work/e2e"], environmentVariables: { execution: { BUILD_STAGE: { kind: "literal", value: "development" } }, startup: {} } });
  await expect(page).toHaveURL(`/settings/environments/${environment!.id}`);
  const host = details(settings, "Temporary build host");
  await expect(host.getByRole("heading", { name: "Temporary build host", level: 2 })).toBeVisible();
  const status = host.getByRole("region", { name: "Temporary build host status", exact: true });
  await expect(status).toContainText(/Changes pending|Configuration not applied|Connect to check it/u);
  await expect(status.getByText("Connected", { exact: true })).toHaveCount(0);
  await host.getByRole("tab", { name: /^Backends/u }).click();
  await expect(host.getByText("No backends in this environment.", { exact: true })).toBeVisible();
  await host.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(host.getByRole("tabpanel", { name: "Activity" })).toContainText(/Pending application|Application unavailable/u);
  await host.getByRole("tab", { name: "Overview", exact: true }).click();

  const connectResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/configuration/lifecycle") && response.request().postDataJSON()?.action === "connect");
  await headerActions(settings, "Temporary build host").getByRole("button", { name: "Connect", exact: true }).click();
  const connected = configurationLifecycleResultSchema.parse(await (await connectResponse).json());
  expect(connected.state).toBe("unavailable");
  expect(connected.runtime.connectionState).toBe("unreachable");
  // One pill (the header's) and one Callout for the error.
  await expect(host.getByText("Unreachable", { exact: true })).toHaveCount(1);
  await expect(host.getByRole("alert")).toHaveCount(1);
  await expect(host.getByRole("button", { name: "Retry connection", exact: true })).toHaveCount(1);

  const disconnectResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/configuration/lifecycle") && response.request().postDataJSON()?.action === "disconnect");
  await expect(headerActions(settings, "Temporary build host").getByRole("button", { name: "Retry connection", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Runtime actions for Temporary build host", exact: true }).click();
  await page.getByRole("menuitem", { name: "Disconnect", exact: true }).click();
  const disconnected = configurationLifecycleResultSchema.parse(await (await disconnectResponse).json());
  expect(disconnected.runtime.preference).toBe("disconnected");
  await expect(host.getByText("Intentionally disconnected", { exact: true })).toBeVisible();
  await capture(page, testInfo, "execution-settings-disconnected-desktop.png");

  await page.reload();
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  settings = await openSettings(page, "Environments");
  const hostRow = row(settings, "Temporary build host");
  await expect(hostRow).toContainText("SSH · e2e-unreachable · 0 backends");
  await expect(hostRow).toContainText("Intentionally disconnected");
  await expect(details(settings, "Temporary build host")).toHaveCount(0);
  await capture(page, testInfo, "execution-settings-environments-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(hostRow).toBeVisible();
  await expect(hostRow).toContainText("Intentionally disconnected");
  expect((await hostRow.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  const hostActions = (await hostRow.getByRole("button", { name: "Actions for Temporary build host", exact: true }).boundingBox())!;
  expect(Math.min(hostActions.width, hostActions.height)).toBeGreaterThanOrEqual(44);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-environments-mobile.png");
  await page.setViewportSize({ width: 1440, height: 1000 });

  await selectSettingsCategory(page, "backends");
  await settings.getByRole("button", { name: "Add backend", exact: true }).click();
  await expect(page).toHaveURL("/settings/backends/~new");
  await expect(settings.getByLabel("Execution environment", { exact: true })).toHaveValue("");
  await expect(settings.getByRole("button", { name: "Save backend", exact: true })).toBeDisabled();
  await settings.getByLabel("Execution environment", { exact: true }).selectOption({ label: "Local" });
  await settings.getByLabel("Backend name", { exact: true }).fill("Dormant Codex");
  await settings.getByLabel("Connection transport", { exact: true }).selectOption("unix_websocket");
  await settings.getByLabel("Unix socket path", { exact: true }).fill("/tmp/sedes-test.sock");
  await settings.getByLabel("Backend enabled", { exact: true }).uncheck();
  await settings.getByLabel("Available models", { exact: true }).selectOption("allowlist");
  await settings.getByLabel("Model identifiers", { exact: true }).fill("gpt-5-test");
  await settings.getByLabel("Model identifiers", { exact: true }).press("Enter");
  await expect(settings.getByRole("button", { name: "Remove gpt-5-test", exact: true })).toBeVisible();
  await settings.getByLabel("Default model", { exact: true }).selectOption("fixed");
  await settings.getByLabel("Default model identifier", { exact: true }).fill("gpt-5-test");
  await expect(settings.getByRole("tab", { name: "Backend startup", exact: true })).toBeDisabled();
  await expect(settings.getByRole("note")).toContainText("Inherited startup settings are not applied");
  await settings.getByRole("button", { name: "Add variable", exact: true }).click();
  await settings.getByLabel("New variable name", { exact: true }).fill("LOG_LEVEL");
  await settings.getByLabel("Value for new variable", { exact: true }).fill("warn");
  await settings.getByRole("button", { name: "Add", exact: true }).click();
  const savedBackend = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/api/configuration") && response.ok());
  await settings.getByRole("button", { name: "Save backend", exact: true }).click();
  const backendSnapshot = configurationSnapshotSchema.parse(await (await savedBackend).json());
  const backend = backendSnapshot.configuration.backends.find((entry) => entry.label === "Dormant Codex");
  expect(backend).toMatchObject({ environmentVariables: { execution: { LOG_LEVEL: { kind: "literal", value: "warn" } }, startup: {} }, enabled: false, kind: "codex_app_server", modelPolicy: { type: "allowlist", allowed: [{ modelIds: ["gpt-5-test"] }] }, moduleConfiguration: { connection: { ownership: "external", channel: { type: "unix_websocket", socketPath: "/tmp/sedes-test.sock" } } } });
  expect(backendSnapshot.configuration.targets.find((entry) => entry.backendInstanceId === backend!.id)?.enabled).toBe(false);
  await expect(page).toHaveURL(`/settings/backends/${backend!.id}`);
  await expect(details(settings, "Dormant Codex").getByRole("heading", { name: "Dormant Codex", level: 2 })).toBeVisible();
  await showList(page, "backends");
  const codexRow = row(settings, "Dormant Codex");
  await expect(codexRow).toContainText("Disabled");
  await expect(codexRow).toContainText("Codex · 1 connection");
  await capture(page, testInfo, "execution-settings-backends-list-desktop.png");
  await codexRow.getByRole("link", { name: "Dormant Codex", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/settings/backends/${backend!.id}`);
  await expect(details(settings, "Dormant Codex").getByRole("region", { name: "Dormant Codex status", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Edit Dormant Codex", exact: true }).click();
  await expect(page).toHaveURL(`/settings/backends/${backend!.id}/edit`);
  await expect(settings.getByLabel("Unix socket path", { exact: true })).toHaveValue("/tmp/sedes-test.sock");
  await expect(settings.getByRole("button", { name: "Remove gpt-5-test", exact: true })).toBeVisible();
  await settings.locator(".settings-content").evaluate((element) => { element.scrollTop = 0; });
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-backend-desktop.png");

  await page.setViewportSize({ width: 390, height: 844 });
  await settings.getByLabel("Unix socket path", { exact: true }).scrollIntoViewIfNeeded();
  await expect(settings.getByLabel("Unix socket path", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-backend-mobile.png");

  await page.setViewportSize({ width: 1440, height: 1000 });
  const editor = settings.getByRole("region", { name: "Backend editor", exact: true });
  await editor.getByRole("link", { name: "Dormant Codex", exact: true }).click();
  await expect(page).toHaveURL(`/settings/backends/${backend!.id}`);
  await showList(page, "backends");
  await settings.getByLabel("Search backends", { exact: true }).fill("Dormant");
  await showBackendFilters(settings);
  await settings.getByLabel("Filter by provider", { exact: true }).selectOption("codex_app_server");
  await settings.getByLabel("Filter by status", { exact: true }).selectOption("disabled");
  await expect(codexRow).toBeVisible();
  await expect(settings.getByRole("link", { name: "Pi SDK", exact: true })).toHaveCount(0);
  await codexRow.getByRole("button", { name: "Actions for Dormant Codex", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await settings.getByLabel("Backend name", { exact: true }).fill("Unsaved Codex name");
  await selectSettingsCategory(page, "environments");
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page).toHaveURL(`/settings/backends/${backend!.id}/edit`);
  await expect(settings.getByLabel("Backend name", { exact: true })).toHaveValue("Unsaved Codex name");
  await editor.getByRole("link", { name: "Dormant Codex", exact: true }).click();
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(`/settings/backends/${backend!.id}`);
  await showList(page, "backends");
  await expect(settings.getByLabel("Search backends", { exact: true })).toHaveValue("Dormant");
  await expect(settings.getByLabel("Filter by provider", { exact: true })).toHaveValue("codex_app_server");
  await expect(settings.getByLabel("Filter by status", { exact: true })).toHaveValue("disabled");
  await expect(codexRow).toBeVisible();
  await showBackendFilters(settings);
  await settings.getByLabel("Filter by environment", { exact: true }).selectOption(environment!.id);
  await expect(settings.getByText("No backends match these filters.", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(settings.getByLabel("Search backends", { exact: true })).toBeFocused();
  await selectSettingsCategory(page, "environments");
  await settings.getByLabel("Search environments", { exact: true }).fill("e2e-unreachable");
  await expect(hostRow).toBeVisible();
  await expect(settings.getByRole("link", { name: "Local", exact: true })).toHaveCount(0);
  await hostRow.getByRole("link", { name: "Temporary build host", exact: true }).click();
  await details(settings, "Temporary build host").getByRole("tab", { name: /^Backends/u }).click();
  await settings.getByRole("button", { name: "Add backend", exact: true }).click();
  await expect(page).toHaveURL("/settings/backends/~new");
  await expect(settings.getByLabel("Execution environment", { exact: true })).toHaveValue(environment!.id);
  await expect(settings.getByLabel("Backend type", { exact: true }).locator('option[value="grok_build"]')).toBeDisabled();
  await settings.getByLabel("Backend type", { exact: true }).selectOption("claude_agent_sdk");
  await settings.getByLabel("Backend name", { exact: true }).fill("Dormant Claude");
  await settings.getByLabel("Backend enabled", { exact: true }).uncheck();
  await settings.getByRole("button", { name: /^Advanced/u }).click();
  await expect(settings.getByLabel("Claude configuration directory", { exact: true })).toHaveValue("");
  await expect(settings.getByLabel("Claude configuration directory", { exact: true })).not.toHaveAttribute("required", "");
  const savedClaude = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/api/configuration") && response.ok());
  await settings.getByRole("button", { name: "Save backend", exact: true }).click();
  const claudeSnapshot = configurationSnapshotSchema.parse(await (await savedClaude).json());
  const claude = claudeSnapshot.configuration.backends.find((entry) => entry.label === "Dormant Claude");
  expect(claude).toMatchObject({ enabled: false, kind: "claude_agent_sdk" });
  if (claude?.kind !== "claude_agent_sdk") throw new Error("Saved Claude backend is missing");
  expect(claude.moduleConfiguration).not.toHaveProperty("configDirectory");
  expect(claudeSnapshot.configuration.targets.find((entry) => entry.backendInstanceId === claude.id)).toMatchObject({ enabled: false, executionEnvironmentId: environment!.id });
  await expect(page).toHaveURL(`/settings/backends/${claude.id}`);
  await expect(details(settings, "Dormant Claude").getByRole("heading", { name: "Dormant Claude", level: 2 })).toBeVisible();
  // Save returns its committed pending snapshot; Refresh observes the fixture's
  // settled unavailable result for this deliberately unprovisioned backend.
  await showList(page, "backends");
  const refreshedConfiguration = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith("/api/configuration") && response.ok());
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  const refreshed = configurationSnapshotSchema.parse(await (await refreshedConfiguration).json());
  expect(refreshed.runtimes.find(runtime => runtime.resourceKind === "backend" && runtime.resourceId === claude.id))
    .toMatchObject({ applyState: "unavailable", effectiveRevision: null, connectionState: "unknown" });
  const claudeRow = row(settings, "Dormant Claude");
  await expect(claudeRow).toContainText("Disabled");
  await expect(claudeRow).toContainText("Status unknown");
  await claudeRow.getByRole("link", { name: "Dormant Claude", exact: true }).click();
  await details(settings, "Dormant Claude").getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(details(settings, "Dormant Claude").getByRole("tabpanel", { name: "Activity" })).toContainText("ConfigurationApplication unavailable");
  await showList(page, "backends");
  await selectSettingsCategory(page, "environments");
  await hostRow.getByRole("link", { name: "Temporary build host", exact: true }).click();
  const hostBackends = details(settings, "Temporary build host");
  await hostBackends.getByRole("tab", { name: /^Backends/u }).click();
  await expect(hostBackends.getByRole("link", { name: "Dormant Claude", exact: true })).toBeVisible();
  await expect(hostBackends.getByRole("link", { name: "Dormant Codex", exact: true })).toHaveCount(0);
  await capture(page, testInfo, "execution-settings-environment-backends-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileClaude = hostBackends.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Dormant Claude", exact: true }) });
  await expect(mobileClaude).toContainText("Disabled");
  await expect(mobileClaude).toContainText("Status unknown");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-environment-backends-mobile.png");
  await showList(page, "environments");
  await expect(settings.getByLabel("Search environments", { exact: true })).toHaveValue("e2e-unreachable");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await selectSettingsCategory(page, "backends");
  await settings.getByLabel("Search backends", { exact: true }).fill("e2e-unreachable");
  await expect(settings.getByRole("link", { name: "Dormant Claude", exact: true })).toBeVisible();
  await expect(settings.getByRole("link", { name: "Dormant Codex", exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(settings.getByRole("region", { name: "Local backends", exact: true })).toBeVisible();
  await expect(settings.getByRole("region", { name: "Temporary build host backends", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  settings = await openSettings(page, "Backends");
  await settings.getByRole("link", { name: "Dormant Claude", exact: true }).click();
  await settings.getByRole("button", { name: "Edit Dormant Claude", exact: true }).click();
  await settings.getByRole("button", { name: /^Advanced/u }).click();
  const claudeDirectory = settings.getByLabel("Claude configuration directory", { exact: true });
  await expect(claudeDirectory).toHaveValue("");
  await expect(claudeDirectory).not.toHaveAttribute("required", "");
  await page.setViewportSize({ width: 390, height: 844 });
  const directoryHelp = settings.getByText("Optional absolute directory on the execution host. Leave blank to use that account's CLAUDE_CONFIG_DIR or ~/.claude, locally, over SSH, or through an outbound connection.", { exact: true });
  // Center the help above the sticky save bar for the mobile screenshot.
  await directoryHelp.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect(claudeDirectory).toBeVisible();
  await expect(directoryHelp).toBeVisible();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-claude-native-directory-mobile.png");
});

test("entity routes deep-link, walk back, and split or stack with the settings column", async ({ page }, testInfo) => {
  const local = configurationSnapshotSchema.parse(await (await page.request.get("/api/configuration")).json())
    .configuration.executionEnvironments.find(entry => entry.kind === "local")!;
  const detailPath = `/settings/environments/${local.id}`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${detailPath}/edit`);
  const settings = page.getByTestId("settings-view");
  await expect(settings.getByRole("heading", { name: `Edit ${local.label}`, level: 2 })).toBeFocused();
  await expect(settings.getByLabel("Environment name", { exact: true })).toHaveValue(local.label);
  await page.goto("/settings/environments/10000000-0000-4000-8000-00000000ffff");
  await expect(settings.getByRole("heading", { name: "Environment unavailable", level: 2 })).toBeVisible();
  await page.goto("/settings/environments");
  await row(settings, local.label).getByRole("link", { name: local.label, exact: true }).click();
  await expect(page).toHaveURL(detailPath);
  await settings.getByRole("button", { name: `Edit ${local.label}`, exact: true }).click();
  await expect(page).toHaveURL(`${detailPath}/edit`);
  await page.goBack();
  await expect(page).toHaveURL(detailPath);
  await expect(details(settings, local.label)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/settings/environments");
  await expect(details(settings, local.label)).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(detailPath);
  await page.goForward();
  await expect(page).toHaveURL(`${detailPath}/edit`);
  await settings.getByLabel("Environment name", { exact: true }).fill("Unsaved name");
  await page.goBack();
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page).toHaveURL(`${detailPath}/edit`);
  await expect(settings.getByLabel("Environment name", { exact: true })).toHaveValue("Unsaved name");
  await page.goBack();
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(detailPath);

  // The panes split when the settings column is at least 960px: with the
  // sidebar collapsed that holds down to 1024 (1024 - 2 x 32 padding).
  await page.evaluate(() => localStorage.setItem("sedes-sidebar-collapsed", "true"));
  await page.reload();
  const list = settings.getByRole("region", { name: "Configured environments", exact: true });
  const detail = details(settings, local.label);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    await expect(detail).toBeVisible();
    await expect(list).toBeVisible();
    const [listBox, detailBox] = [(await list.boundingBox())!, (await detail.boundingBox())!];
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(detailBox.x);
    expect(listBox.width).toBeGreaterThanOrEqual(300);
    expect(listBox.width).toBeLessThanOrEqual(340);
    await expect(detail.locator('a[data-slot="settings-page-back"]')).toBeHidden();
  }
  await capture(page, testInfo, "execution-settings-split-collapsed-1024.png");
  // Restoring the sidebar at 1024 leaves a 700px column: the panes stack.
  await settings.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expect(settings).toHaveAttribute("data-nav", "sidebar");
  await expect(list).toBeHidden();
  await expect(detail.getByRole("link", { name: "Environments", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(list).toBeVisible();
  await capture(page, testInfo, "execution-settings-split-desktop.png");
  // Narrow, the list and the detail stack, with a way back to the list.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list).toBeHidden();
  await expect(detail).toBeVisible();
  await detail.getByRole("link", { name: "Environments", exact: true }).click();
  await expect(page).toHaveURL("/settings/environments");
  await expect(list).toBeVisible();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-stack-mobile.png");
});

test("unknown lifecycle receipts survive remount and retain confirmed Stop controls", async ({ page, request }, testInfo) => {
  const session = await (await request.get("/api/application/session")).json() as { csrfToken: string };
  const before = configurationSnapshotSchema.parse(await (await request.get("/api/configuration")).json());
  const environmentId = "31000000-0000-4000-8000-000000000001";
  const saved = await request.put("/api/configuration", { headers: { "X-CSRF-Token": session.csrfToken }, data: {
    mutationId: "31000000-0000-4000-8000-000000000002", expectedRevision: before.revision,
    configuration: { ...before.configuration, executionEnvironments: [...before.configuration.executionEnvironments, {
      id: environmentId, kind: "ssh", label: "Uncertain lifecycle host", hostAlias: "e2e-unknown-lifecycle", workspaceRoots: ["/work/e2e"],
      operations: { kind: "none" },
    }] },
  } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  let settings = await openSettings(page, "Environments");
  // Stop is in the runtime actions menu; while the earlier outcome is unknown it is the one command left.
  const runtimeMenu = () => settings.getByRole("button", { name: "Runtime actions for Uncertain lifecycle host", exact: true });
  const expectStopAlone = async () => {
    await runtimeMenu().click();
    await expect(page.getByRole("menuitem", { name: "Stop", exact: true })).toBeEnabled();
    await expect(page.getByRole("menuitem", { disabled: false })).toHaveText(["Stop"]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  };
  await settings.getByRole("link", { name: "Uncertain lifecycle host", exact: true }).click();
  const connectResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/configuration/lifecycle") && response.request().postDataJSON()?.resourceId === environmentId);
  await headerActions(settings, "Uncertain lifecycle host").getByRole("button", { name: "Connect", exact: true }).click();
  const original = configurationLifecycleResultSchema.parse(await (await connectResponse).json());
  expect(original.state).toBe("unknown");
  await expect(headerActions(settings, "Uncertain lifecycle host").getByRole("button", { name: "Refresh status", exact: true })).toBeEnabled();
  await showList(page, "environments");
  await settings.getByLabel("Filter by status", { exact: true }).selectOption("attention");
  await expect(row(settings, "Uncertain lifecycle host")).toContainText("Outcome unknown");
  await settings.getByLabel("Search environments", { exact: true }).fill("no-such-environment");
  await expect(settings.getByText("No environments match these filters.", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(settings.getByLabel("Search environments", { exact: true })).toBeFocused();
  await settings.getByRole("button", { name: "Actions for Uncertain lifecycle host", exact: true }).click();
  await page.getByRole("menuitem", { name: "View activity", exact: true }).click();
  const uncertain = details(settings, "Uncertain lifecycle host");
  await expect(uncertain.getByRole("tab", { name: "Activity", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(headerActions(settings, "Uncertain lifecycle host").getByRole("button", { name: "Refresh status", exact: true })).toBeEnabled();
  await uncertain.getByRole("tab", { name: "Overview", exact: true }).click();
  await expectStopAlone();
  await page.reload();
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  settings = await openSettings(page, "Environments");
  await settings.getByRole("link", { name: "Uncertain lifecycle host", exact: true }).click();
  await expect(uncertain).toContainText("outcome is unknown");
  await expectStopAlone();
  const receiptResponse = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith(`/api/configuration/lifecycle/${original.mutationId}`));
  await headerActions(settings, "Uncertain lifecycle host").getByRole("button", { name: "Refresh status", exact: true }).click();
  const recovered = configurationLifecycleResultSchema.parse(await (await receiptResponse).json());
  expect(recovered).toMatchObject({ mutationId: original.mutationId, state: "unknown" });
  await expectStopAlone();
  const impactResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/configuration/lifecycle/impact"));
  await runtimeMenu().click();
  await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
  const impact = configurationLifecycleImpactSchema.parse(await (await impactResponse).json());
  expect(impact).toMatchObject({ resourceId: environmentId, action: "stop", activeResources: 1 });
  const confirmation = page.getByRole("dialog", { name: "Stop Uncertain lifecycle host?", exact: true });
  await expect(confirmation).toContainText("1 affected resource");
  await expect(confirmation).toContainText("unknown outcome");
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(confirmation.getByRole("button", { name: "Confirm stop", exact: true })).toBeEnabled();
  await capture(page, testInfo, "execution-settings-unknown-stop-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(confirmation.getByRole("button", { name: "Confirm stop", exact: true })).toBeInViewport();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-unknown-stop-mobile.png");
  const stopResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/configuration/lifecycle") && response.request().postDataJSON()?.action === "stop");
  await confirmation.getByRole("button", { name: "Confirm stop", exact: true }).click();
  const stopped = configurationLifecycleResultSchema.parse(await (await stopResponse).json());
  expect(stopped).toMatchObject({ state: "applied", runtime: { connectionState: "stopped", preference: "stopped", activeResources: 0 } });
  expect((await stopResponse).request().postDataJSON()).toMatchObject({ resourceId: environmentId, impactToken: impact.token, expectedIncarnation: impact.incarnation });
  await expect(uncertain.getByText("Intentionally stopped", { exact: true })).toBeVisible();
  await expect(uncertain.getByRole("button", { name: "Refresh status", exact: true })).toHaveCount(0);
  const settled = configurationLifecycleResultSchema.parse(await (await request.get(`/api/configuration/lifecycle/${original.mutationId}`)).json());
  expect(settled.state).toBe("rejected");
});

test("outbound hosts can be paired, edited offline, denied, revoked and reapproved", async ({ page, request }, testInfo) => {
  const connectorId = "21000000-0000-4000-8000-000000000001";
  const register = await request.post("/__e2e/host-registrations", { data: {
    connectorId, registrationAttemptId: "21000000-0000-4000-8000-000000000002",
    metadata: { hostname: "Studio outbound", platform: "darwin", architecture: "arm64", account: "operator", connectorVersion: "e2e" },
  } });
  expect(register.ok()).toBe(true);
  const registration = await register.json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  let settings = await openSettings(page, "Environments");
  const awaiting = settings.getByRole("region", { name: "Awaiting approval", exact: true });
  await expect(awaiting).toContainText("1 host");
  await expect(row(awaiting, "Studio outbound")).toContainText(`Code ${registration.correlationCode} · macOS arm64`);
  await expect(row(awaiting, "Studio outbound")).toContainText("Host online");
  await awaiting.getByRole("link", { name: "Studio outbound", exact: true }).click();
  await expect(page).toHaveURL(`/settings/environments/~pending/${registration.id}`);
  const pending = settings.getByRole("region", { name: "Pending Studio outbound" });
  await expect(pending).toContainText(registration.correlationCode);
  await expect(pending).toContainText("macOS · arm64 · operator");
  await expect(pending).toContainText("Host online");
  await capture(page, testInfo, "outbound-host-pending-desktop.png");
  await settings.getByLabel("Environment name", { exact: true }).fill("Paired Studio");
  await settings.getByLabel("Workspace root 1", { exact: true }).fill("/Users/operator/Projects");
  await settings.getByLabel("Workspace tools and context", { exact: true }).check();
  await settings.getByLabel("Interactive terminals", { exact: true }).check();
  const acceptedResponse = page.waitForResponse(response => response.url().endsWith("/api/host-registrations/accept") && response.ok());
  await settings.getByRole("button", { name: "Accept host", exact: true }).click();
  const accepted = await (await acceptedResponse).json();
  expect(accepted.configuration.configuration.executionEnvironments.find((entry: { label: string }) => entry.label === "Paired Studio")).toMatchObject({ kind: "outbound", platform: "darwin", workspaceRoots: ["/Users/operator/Projects"] });
  await expect(page).toHaveURL(`/settings/environments/${accepted.pairing.executionEnvironmentId}`);
  const studio = details(settings, "Paired Studio");
  await expect(studio.getByRole("region", { name: "Host", exact: true })).toContainText("Host online");
  await studio.getByRole("button", { name: "Remove Paired Studio", exact: true }).click();
  const removal = page.getByRole("dialog", { name: "Remove Paired Studio?", exact: true });
  await expect(removal).toContainText("Revoke the pairing first.");
  await expect(removal.getByRole("button", { name: "Remove environment", exact: true })).toBeDisabled();
  await removal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(studio.getByRole("region", { name: "Paired Studio status", exact: true })).not.toContainText("Connected");
  expect((await request.post("/__e2e/host-presence", { data: { connectorId, connected: false } })).ok()).toBe(true);
  await showList(page, "environments");
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(row(settings, "Paired Studio")).toContainText("Host offline");
  await settings.getByRole("link", { name: "Paired Studio", exact: true }).click();
  await expect(studio.getByRole("region", { name: "Host", exact: true })).toContainText("Host offline");
  await settings.getByRole("button", { name: "Edit Paired Studio", exact: true }).click();
  await expect(settings.getByRole("group", { name: "Environment type", exact: true })).toContainText("Paired host");
  await expect(settings.getByRole("textbox", { name: "SSH host alias", exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Add root", exact: true }).click();
  await settings.getByLabel("Workspace root 2", { exact: true }).fill("/Users/operator/Shared");
  const editedResponse = page.waitForResponse(response => response.url().endsWith("/api/configuration") && response.request().method() === "PUT" && response.ok());
  await settings.getByRole("button", { name: "Save environment", exact: true }).click();
  const edited = configurationSnapshotSchema.parse(await (await editedResponse).json());
  expect(edited.configuration.executionEnvironments.find(entry => entry.label === "Paired Studio")?.workspaceRoots).toEqual(["/Users/operator/Projects", "/Users/operator/Shared"]);
  await expect(settings.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  settings = await openSettings(page, "Environments");
  await settings.getByRole("link", { name: "Paired Studio", exact: true }).click();
  await expect(studio.getByRole("region", { name: "Host", exact: true })).toContainText("Host offline");
  await studio.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(studio.getByRole("tabpanel", { name: "Activity" })).toContainText(connectorId);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "outbound-host-offline-mobile.png");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await studio.getByRole("tab", { name: "Overview", exact: true }).click();
  await studio.getByRole("button", { name: "Revoke Paired Studio", exact: true }).click();
  const revoke = page.getByRole("dialog", { name: "Revoke Paired Studio?", exact: true });
  await expect(revoke).toContainText("does not stop host-owned processes");
  await revoke.getByRole("button", { name: "Revoke pairing", exact: true }).click();
  await expect(studio.getByRole("button", { name: "Reapprove Paired Studio", exact: true })).toBeFocused();
  await studio.getByRole("button", { name: "Remove Paired Studio", exact: true }).click();
  await expect(removal.getByRole("button", { name: "Remove environment", exact: true })).toBeEnabled();
  await removal.getByRole("button", { name: "Cancel", exact: true }).click();
  await studio.getByRole("button", { name: "Reapprove Paired Studio", exact: true }).click();
  await page.getByRole("dialog", { name: "Reapprove Paired Studio?", exact: true }).getByRole("button", { name: "Reapprove pairing", exact: true }).click();
  await expect(studio.getByRole("button", { name: "Revoke Paired Studio", exact: true })).toBeVisible();
  const denied = await request.post("/__e2e/host-registrations", { data: {
    connectorId: "21000000-0000-4000-8000-000000000003", registrationAttemptId: "21000000-0000-4000-8000-000000000004",
    metadata: { hostname: "Windows candidate", platform: "win32", architecture: "x64", account: "operator", connectorVersion: "e2e" },
  } });
  expect(denied.ok()).toBe(true);
  await showList(page, "environments");
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  await settings.getByRole("link", { name: "Windows candidate", exact: true }).click();
  await settings.getByRole("button", { name: "Deny Windows candidate", exact: true }).click();
  await page.getByRole("dialog", { name: "Deny Windows candidate?", exact: true }).getByRole("button", { name: "Deny host", exact: true }).click();
  await expect(page).toHaveURL("/settings/environments");
  await expect(settings.getByRole("link", { name: "Windows candidate", exact: true })).toHaveCount(0);
  await settings.getByRole("link", { name: "Paired Studio", exact: true }).click();
  await studio.getByRole("tab", { name: "Activity", exact: true }).click();
  await capture(page, testInfo, "outbound-host-paired-desktop.png");

  await selectSettingsCategory(page, "backends");
  await settings.getByRole("button", { name: "Add backend", exact: true }).click();
  await settings.getByLabel("Execution environment", { exact: true }).selectOption(accepted.pairing.executionEnvironmentId);
  await settings.getByLabel("Backend type", { exact: true }).selectOption("claude_agent_sdk");
  await settings.getByLabel("Backend name", { exact: true }).fill("Paired Claude");
  await settings.getByLabel("Backend enabled", { exact: true }).uncheck();
  await settings.getByRole("button", { name: /^Advanced/u }).click();
  await expect(settings.getByLabel("Claude configuration directory", { exact: true })).toHaveValue("");
  const savedPairedClaude = page.waitForResponse(response => response.url().endsWith("/api/configuration") && response.request().method() === "PUT" && response.ok());
  await settings.getByRole("button", { name: "Save backend", exact: true }).click();
  const pairedConfiguration = configurationSnapshotSchema.parse(await (await savedPairedClaude).json());
  const pairedClaude = pairedConfiguration.configuration.backends.find(entry => entry.label === "Paired Claude");
  expect(pairedClaude).toMatchObject({ kind: "claude_agent_sdk", enabled: false });
  expect(pairedConfiguration.configuration.targets.find(entry => entry.backendInstanceId === pairedClaude!.id)).toMatchObject({ executionEnvironmentId: accepted.pairing.executionEnvironmentId, enabled: false });
  await page.reload();
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  settings = await openSettings(page, "Backends");
  await settings.getByRole("link", { name: "Paired Claude", exact: true }).click();
  await settings.getByRole("button", { name: "Edit Paired Claude", exact: true }).click();
  const pairedEnvironment = settings.getByRole("group", { name: "Execution environment", exact: true });
  await expect(pairedEnvironment).toContainText("Paired Studio");
  await expect(pairedEnvironment).toContainText("Locked");
  await expect(settings.getByRole("combobox", { name: "Execution environment", exact: true })).toHaveCount(0);
  await pairedEnvironment.scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "outbound-claude-connection-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await settings.getByRole("button", { name: /^Advanced/u }).click();
  await settings.getByLabel("Claude configuration directory", { exact: true }).evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect(settings.getByLabel("Claude configuration directory", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "outbound-claude-installation-mobile.png");
});


test("large backend inventories stay compact and filterable on mobile in dark appearance", async ({ page, request }, testInfo) => {
  // Only the coordinator's disposable configuration is extended. The scripted
  // adapter reports new providers as unavailable and never starts real work.
  const session = await (await request.get("/api/application/session")).json() as { csrfToken: string };
  const before = configurationSnapshotSchema.parse(await (await request.get("/api/configuration")).json());
  const environments: ConfigurationDocument["executionEnvironments"] = [
    "aw-internal-rocky8-sip",
    "Integration cluster · Shared application services",
    "Researchclusterexperimentalmodelvalidationwithoutwordbreaks0123456789",
  ].map((label, index) => ({ id: randomUUID(), label, kind: "ssh", hostAlias: `mobile-inventory-host-${index + 1}`,
    workspaceRoots: ["/work/mobile-inventory"], operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files", "workspace_tools", "workspace_context"] } }));
  const backends: ConfigurationDocument["backends"] = [];
  const targets: ConfigurationDocument["targets"] = [];
  for (let index = 0; index < 26 - before.configuration.backends.length; index++) {
    const backendId = randomUUID();
    const enabled = index % 2 !== 0;
    const suffix = String(index + 1).padStart(2, "0");
    const common = { id: backendId, enabled, modelPolicy: { type: "catalog" as const } };
    const connection = { id: randomUUID(), label: `Workspace connection ${suffix}`, backendInstanceId: backendId,
      executionEnvironmentId: environments[Math.floor(index / 3) % environments.length]!.id, enabled };
    if (index % 3 === 0) {
      backends.push({ ...common, kind: "pi", label: `Pi research ${suffix}` });
      targets.push({ ...connection, kind: "pi_sdk" });
    } else if (index % 3 === 1) {
      backends.push({ ...common, kind: "codex_app_server", label: `Codex implementation ${suffix}`, moduleConfiguration: {
        connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectory: "/work/mobile-inventory" } },
        policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["on-request"], allowedApprovalReviewers: ["user"] },
      } });
      targets.push({ ...connection, kind: "codex_app_server", moduleConfiguration: {
        defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "on-request", approvalReviewer: "user", model: { type: "catalogDefault" } },
      } });
    } else {
      backends.push({ ...common, kind: "claude_agent_sdk", label: `Claude review ${suffix}`, moduleConfiguration: {
        initializationTimeoutMs: 20_000, permissionPolicy: { allowedModes: ["default"] },
      } });
      targets.push({ ...connection, kind: "claude_agent_sdk", moduleConfiguration: { defaults: { permissionMode: "default" } } });
    }
  }
  const saved = await request.put("/api/configuration", { headers: { "X-CSRF-Token": session.csrfToken }, data: {
    mutationId: randomUUID(), expectedRevision: before.revision, configuration: { ...before.configuration,
      executionEnvironments: [...before.configuration.executionEnvironments, ...environments],
      backends: [...before.configuration.backends, ...backends], targets: [...before.configuration.targets, ...targets],
    },
  } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const disconnectedBackend = backends[7]!;
  // The large-inventory case checks rendering with one controlled, schema-valid
  // disconnected runtime. It does not claim provider/lifecycle integration;
  // the earlier cases exercise the real fixture service and lifecycle receipts.
  await page.route("**/api/configuration", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const response = await route.fetch();
    const snapshot = configurationSnapshotSchema.parse(await response.json());
    const presented = configurationSnapshotSchema.parse({ ...snapshot, runtimes: snapshot.runtimes.map(runtime =>
      runtime.resourceKind === "backend" && runtime.resourceId === disconnectedBackend.id
        ? { ...runtime, connectionState: "disconnected", preference: "disconnected", activeResources: 0, lastError: null }
        : runtime) });
    await route.fulfill({ response, json: presented });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const settings = await openSettings(page, "Backends");
  const navigation = page.getByTestId("desktop-sidebar").getByRole("navigation", { name: "Settings pages" });
  // The way back: the sidebar nav's return row, or the compact header's Settings link.
  const backControl = page.getByTestId("settings-return").or(settings.getByTestId("settings-list-link"));
  await selectSettingsCategory(page, "appearance");
  await settings.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await selectSettingsCategory(page, "backends");
  await page.setViewportSize({ width: 390, height: 844 });
  const content = settings.locator(".settings-content");
  await content.evaluate((element) => { element.scrollTop = 0; });
  const inventory = settings.getByRole("region", { name: "Configured backends", exact: true });
  const names = inventory.getByRole("link");
  await expect(names).toHaveCount(26);
  await expect.poll(() => names.evaluateAll((elements) => elements.filter((element) => {
    const bounds = element.closest("li")!.getBoundingClientRect();
    const viewport = element.closest(".settings-content")!.getBoundingClientRect();
    return bounds.width > 0 && bounds.top >= viewport.top && bounds.bottom <= Math.min(viewport.bottom, window.innerHeight);
  }).length)).toBeGreaterThanOrEqual(4);
  const filters = settings.getByRole("button", { name: /^Filters/u });
  await expect(filters).toHaveAttribute("aria-expanded", "false");
  await expect(settings.getByLabel("Filter by environment", { exact: true })).toBeHidden();
  const firstRow = row(inventory, "Claude review 03");
  await expect(firstRow).toContainText("Status unknown");
  await expect(firstRow).toContainText("Disabled");
  await expect(firstRow.getByText("Connected", { exact: true })).toHaveCount(0);
  for (const control of [filters, settings.getByLabel("Search backends", { exact: true }), firstRow.getByRole("button", { name: "Actions for Claude review 03", exact: true })]) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
  }
  expect((await firstRow.getByRole("link", { name: "Claude review 03", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await expectNoPageOverflow(page);
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, testInfo, "execution-settings-26-backends-dark-mobile.png");

  await filters.click();
  await expect(filters).toHaveAttribute("aria-expanded", "true");
  for (const label of ["Filter by environment", "Filter by provider", "Filter by status"]) {
    await expectReadableMobileSelect(settings.getByLabel(label, { exact: true }));
  }
  await expectNoPageOverflow(page);
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, testInfo, "execution-settings-26-backends-filters-dark-mobile.png");
  await settings.getByLabel("Filter by environment", { exact: true }).selectOption(environments[0]!.id);
  await expectReadableMobileSelect(settings.getByLabel("Filter by environment", { exact: true }));
  await settings.getByLabel("Filter by provider", { exact: true }).selectOption("claude_agent_sdk");
  await settings.getByLabel("Filter by status", { exact: true }).selectOption("disabled");
  await expect(filters).toHaveText("Filters (3)");
  await settings.getByRole("button", { name: "Show results", exact: true }).click();
  await expect(filters).toHaveAttribute("aria-expanded", "false");
  await expect(filters).toBeFocused();
  await expect(settings.getByLabel("Filter by environment", { exact: true })).toBeHidden();
  await settings.getByLabel("Search backends", { exact: true }).fill("review 03");
  await expect(names).toHaveCount(1);
  await expect(names).toHaveAccessibleName("Claude review 03");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-backends-filtered-dark-mobile.png");
  await settings.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(settings.getByLabel("Search backends", { exact: true })).toBeFocused();
  await expect(names).toHaveCount(26);
  await expect(filters).toHaveText("Filters");
  for (const viewport of [
    { width: 320, height: 740, screenshot: "execution-settings-26-backends-dark-mobile-320.png" },
    { width: 844, height: 320, screenshot: "execution-settings-26-backends-dark-landscape.png" },
    { width: 1440, height: 1000, screenshot: "execution-settings-26-backends-dark-desktop.png" },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await content.evaluate((element) => { element.scrollTop = 0; });
    await expect(names).toHaveCount(26);
    await expectNoPageOverflow(page);
    expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const addBounds = (await settings.getByRole("button", { name: "Add backend", exact: true }).boundingBox())!;
    const closeBounds = (await backControl.boundingBox())!;
    const controlsOverlap = Math.max(addBounds.x, closeBounds.x) < Math.min(addBounds.x + addBounds.width, closeBounds.x + closeBounds.width)
      && Math.max(addBounds.y, closeBounds.y) < Math.min(addBounds.y + addBounds.height, closeBounds.y + closeBounds.height);
    expect(controlsOverlap, "Add and return controls must remain separate at every viewport").toBe(false);
    await expect(await navigation.isVisible() ? navigation : settings.getByTestId("settings-list-link")).toBeInViewport({ ratio: 1 });
    await expect(backControl).toBeInViewport({ ratio: 1 });
    await capture(page, testInfo, viewport.screenshot);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const longEnvironment = inventory.getByRole("heading", { name: environments[2]!.label, exact: true });
  await longEnvironment.evaluate(element => element.scrollIntoView({ block: "start" }));
  await expect(longEnvironment).toBeInViewport();
  await expect(settings.getByTestId("settings-list-link")).toBeInViewport({ ratio: 1 });
  expect(await settings.evaluate(element => element.scrollTop)).toBe(0);
  await expectNoPageOverflow(page);
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await longEnvironment.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, testInfo, "execution-settings-unbroken-environment-dark-mobile-320.png");
  const disconnectedRow = row(inventory, disconnectedBackend.label);
  await disconnectedRow.evaluate(element => element.scrollIntoView({ block: "center" }));
  await expect(disconnectedRow).toBeInViewport();
  await expect(settings.getByTestId("settings-list-link")).toBeInViewport({ ratio: 1 });
  expect(await settings.evaluate(element => element.scrollTop)).toBe(0);
  await expect(disconnectedRow).toContainText("Intentionally disconnected");
  // The one pill and the kebab stay inside the row at the narrowest width.
  const fit = await disconnectedRow.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const pill = element.querySelector("[data-slot=status-pill]")!.getBoundingClientRect();
    const actions = element.querySelector("[data-slot=entity-row-actions]")!.getBoundingClientRect();
    return { inside: pill.left >= bounds.left && pill.right <= bounds.right && actions.right <= bounds.right, overflow: element.scrollWidth > element.clientWidth };
  });
  expect(fit).toEqual({ inside: true, overflow: false });
  await expectNoPageOverflow(page);
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, testInfo, "execution-settings-disconnected-backend-dark-mobile-320.png");
  await selectSettingsCategory(page, "environments");
  await expect(settings.getByRole("region", { name: "Configured environments", exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, testInfo, "execution-settings-environments-dark-mobile-320.png");
  await selectSettingsCategory(page, "backends");
  await expect(names).toHaveCount(26);
});


test("owned backend startup edits stay enabled and show pending restart without changing the running incarnation", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  const original = configurationSnapshotSchema.parse(await (await page.request.get("/api/configuration")).json());
  const before = original.runtimes.find(runtime => runtime.resourceId === "codex-stdio-e2e")!;
  const settings = await openSettings(page, "Backends");
  await settings.getByRole("button", { name: "Actions for Codex stdio", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(page).toHaveURL("/settings/backends/codex-stdio-e2e/edit");
  const startup = settings.getByRole("tab", { name: "Backend startup", exact: true });
  await expect(startup).toBeEnabled();
  await startup.click();
  await expect(settings.getByText("Saving does not restart a running backend. Changes remain pending until it restarts.", { exact: false })).toBeVisible();
  await settings.getByRole("button", { name: "Add variable", exact: true }).click();
  await settings.getByLabel("New variable name", { exact: true }).fill("BUILD_STAGE");
  await settings.getByLabel("Value for new variable", { exact: true }).fill("after-restart");
  await settings.getByRole("button", { name: "Add", exact: true }).click();
  const savedResponse = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/api/configuration") && response.ok());
  await settings.getByRole("button", { name: "Save backend", exact: true }).click();
  const saved = configurationSnapshotSchema.parse(await (await savedResponse).json());
  expect(saved.configuration.backends.find(backend => backend.id === "codex-stdio-e2e")?.environmentVariables?.startup)
    .toEqual({ BUILD_STAGE: { kind: "literal", value: "after-restart" } });
  // Save receipts describe the committed revision before runtime reconciliation.
  // Read the authoritative observation, as the settings refresh does.
  const observed = configurationSnapshotSchema.parse(await (await page.request.get("/api/configuration")).json());
  expect(observed.runtimes.find(runtime => runtime.resourceId === "codex-stdio-e2e"))
    .toMatchObject({ startupEnvironmentPending: true, connectionState: "connected", incarnation: before.incarnation });
  await expect(settings.getByText("Saved", { exact: true })).toBeVisible();
  const editor = settings.getByRole("region", { name: "Backend editor", exact: true });
  await editor.getByRole("link", { name: "Codex stdio", exact: true }).click();
  await showList(page, "backends");
  const backendRow = row(settings, "Codex stdio");
  await expect(backendRow).toContainText("Pending restart", { timeout: 10_000 });
  await backendRow.scrollIntoViewIfNeeded();
  await capture(page, testInfo, "execution-startup-pending-restart.png");
  await backendRow.getByRole("button", { name: "Actions for Codex stdio", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await expect(startup).toBeEnabled();
  await startup.click();
  await expect(settings.getByLabel("Value for BUILD_STAGE", { exact: true })).toHaveValue("after-restart");
});
