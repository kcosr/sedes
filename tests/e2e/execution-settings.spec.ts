import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { configurationLifecycleImpactSchema, configurationLifecycleResultSchema, configurationSnapshotSchema, type ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { expect, test } from "./fixtures.js";
import { capture, expectNoPageOverflow, openSettingsPage, selectSettingsCategory } from "./helpers.js";

async function openSettings(page: Page, section: "Environments" | "Backends") {
  return openSettingsPage(page, section === "Environments" ? "environments" : "backends");
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
  await settings.getByRole("button", { name: /^SSH host/u }).click();
  await settings.getByLabel("Environment name", { exact: true }).fill("Temporary build host");
  await settings.getByLabel("SSH host alias", { exact: true }).fill("e2e-unreachable");
  await settings.getByLabel("Workspace roots", { exact: true }).fill("/work/e2e");
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
  await expect(settings.getByRole("heading", { name: "Temporary build host", exact: true })).toBeVisible();
  await expect(settings.getByText("No backends in this environment. Add a backend to make a provider available.", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Activity & diagnostics", exact: true }).click();
  const runtime = settings.getByRole("region", { name: "Temporary build host runtime", exact: true });
  await expect(runtime).toContainText(/Changes pending|Configuration not applied|Connect to check it/u);
  await runtime.getByRole("button", { name: "Temporary build host runtime details", exact: true }).click();
  await expect(runtime).toContainText(/Pending application|Application unavailable/u);
  await expect(runtime.getByText("Connected", { exact: true })).toHaveCount(0);

  const connectResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/configuration/lifecycle") && response.request().postDataJSON()?.action === "connect");
  await runtime.getByRole("button", { name: "Connect", exact: true }).click();
  const connected = configurationLifecycleResultSchema.parse(await (await connectResponse).json());
  expect(connected.state).toBe("unavailable");
  expect(connected.runtime.connectionState).toBe("unreachable");
  await expect(runtime.getByText("Unreachable", { exact: true })).toBeVisible();

  const disconnectResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/configuration/lifecycle") && response.request().postDataJSON()?.action === "disconnect");
  await expect(runtime.getByRole("button", { name: "Retry connection", exact: true })).toBeVisible();
  await runtime.getByRole("button", { name: "Runtime actions for Temporary build host", exact: true }).click();
  await page.getByRole("menuitem", { name: "Disconnect", exact: true }).click();
  const disconnected = configurationLifecycleResultSchema.parse(await (await disconnectResponse).json());
  expect(disconnected.runtime.preference).toBe("disconnected");
  await expect(runtime.getByText("Intentionally disconnected", { exact: true })).toBeVisible();
  await capture(page, testInfo, "execution-settings-disconnected-desktop.png");

  await page.reload();
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  settings = await openSettings(page, "Environments");
  const hostSummary = settings.getByRole("button", { name: "Temporary build host details", exact: true });
  await expect(settings.getByRole("row").filter({ has: page.getByRole("button", { name: "Temporary build host details", exact: true }) })).toContainText("Intentionally disconnected");
  await expect(hostSummary).toHaveText("Temporary build host");
  await expect(settings.getByRole("region", { name: "Temporary build host runtime", exact: true })).toHaveCount(0);
  await capture(page, testInfo, "execution-settings-environments-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(hostSummary).toBeVisible();
  const mobileEnvironments = settings.getByRole("region", { name: "Configured environments", exact: true }).getByRole("table");
  await expect(mobileEnvironments.getByRole("rowgroup")).toHaveCount(2);
  await expect(mobileEnvironments.getByRole("columnheader")).toHaveText(["Environment", "Host connection", "Runtime", "Backends", "Actions"]);
  const mobileHost = mobileEnvironments.getByRole("row").filter({ has: page.getByRole("button", { name: "Temporary build host details", exact: true }) });
  await expect(mobileHost.getByRole("cell")).toHaveCount(5);
  await expect(mobileHost.getByRole("cell").nth(2)).toContainText("Intentionally disconnected");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-environments-mobile.png");
  await page.setViewportSize({ width: 1440, height: 1000 });

  await selectSettingsCategory(page, "backends");
  await settings.getByRole("button", { name: "Add backend", exact: true }).click();
  await expect(settings.getByLabel("Execution environment", { exact: true })).toHaveValue("");
  await expect(settings.getByRole("button", { name: "Save backend", exact: true })).toBeDisabled();
  await settings.getByLabel("Execution environment", { exact: true }).selectOption({ label: "Local" });
  await settings.getByLabel("Backend name", { exact: true }).fill("Dormant Codex");
  await settings.getByLabel("Connection transport", { exact: true }).selectOption("unix_websocket");
  await settings.getByLabel("Unix socket path", { exact: true }).fill("/tmp/sedes-test.sock");
  await settings.getByLabel("Backend enabled", { exact: true }).uncheck();
  await settings.getByLabel("Available models", { exact: true }).selectOption("allowlist");
  await settings.getByLabel("Model identifiers", { exact: true }).fill("gpt-5-test");
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
  const backendSummary = settings.getByRole("button", { name: "Dormant Codex details", exact: true });
  await expect(settings.getByRole("row").filter({ has: page.getByRole("button", { name: "Dormant Codex details", exact: true }) })).toContainText("Disabled");
  await expect(backendSummary).toHaveText("Dormant Codex");
  await capture(page, testInfo, "execution-settings-backends-list-desktop.png");
  await backendSummary.focus();
  await page.keyboard.press("Enter");
  await expect(settings.getByRole("heading", { name: "Dormant Codex", exact: true })).toBeVisible();
  await expect(settings.getByRole("region", { name: "Dormant Codex runtime", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Edit Dormant Codex", exact: true }).click();
  await expect(settings.getByLabel("Unix socket path", { exact: true })).toHaveValue("/tmp/sedes-test.sock");
  await expect(settings.getByLabel("Model identifiers", { exact: true })).toHaveValue("gpt-5-test");
  await settings.locator(".settings-content").evaluate((element) => { element.scrollTop = 0; });
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-backend-desktop.png");

  await page.setViewportSize({ width: 390, height: 844 });
  await settings.getByLabel("Unix socket path", { exact: true }).scrollIntoViewIfNeeded();
  await expect(settings.getByLabel("Unix socket path", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-backend-mobile.png");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await settings.getByLabel("Search backends", { exact: true }).fill("Dormant");
  await settings.getByLabel("Filter by provider", { exact: true }).selectOption("codex_app_server");
  await settings.getByLabel("Filter by status", { exact: true }).selectOption("disabled");
  await expect(backendSummary).toBeVisible();
  await expect(settings.getByRole("button", { name: "Pi SDK details", exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Edit Dormant Codex", exact: true }).click();
  await settings.getByLabel("Backend name", { exact: true }).fill("Unsaved Codex name");
  await selectSettingsCategory(page, "environments");
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(settings.getByLabel("Backend name", { exact: true })).toHaveValue("Unsaved Codex name");
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(settings.getByLabel("Search backends", { exact: true })).toHaveValue("Dormant");
  await expect(settings.getByLabel("Filter by provider", { exact: true })).toHaveValue("codex_app_server");
  await expect(settings.getByLabel("Filter by status", { exact: true })).toHaveValue("disabled");
  await expect(backendSummary).toBeVisible();
  await settings.getByLabel("Filter by environment", { exact: true }).selectOption(environment!.id);
  await expect(settings.getByText("No backends match these filters.", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(settings.getByLabel("Search backends", { exact: true })).toBeFocused();
  await selectSettingsCategory(page, "environments");
  await settings.getByLabel("Search environments", { exact: true }).fill("e2e-unreachable");
  await expect(hostSummary).toBeVisible();
  await expect(settings.getByRole("button", { name: "Local details", exact: true })).toHaveCount(0);
  await hostSummary.click();
  await settings.getByRole("button", { name: "Add backend", exact: true }).click();
  await expect(settings.getByLabel("Execution environment", { exact: true })).toHaveValue(environment!.id);
  await expect(settings.getByLabel("Backend type", { exact: true }).locator('option[value="grok_build"]')).toBeDisabled();
  await settings.getByLabel("Backend type", { exact: true }).selectOption("claude_agent_sdk");
  await settings.getByLabel("Backend name", { exact: true }).fill("Dormant Claude");
  await settings.getByLabel("Backend enabled", { exact: true }).uncheck();
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
  await expect(settings.getByRole("heading", { name: "Temporary build host", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Dormant Claude details", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Dormant Codex details", exact: true })).toHaveCount(0);
  // Save returns its committed pending snapshot; Refresh observes the fixture's
  // settled unavailable result for this deliberately unprovisioned backend.
  const refreshedConfiguration = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith("/api/configuration") && response.ok());
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  const refreshed = configurationSnapshotSchema.parse(await (await refreshedConfiguration).json());
  expect(refreshed.runtimes.find(runtime => runtime.resourceKind === "backend" && runtime.resourceId === claude.id))
    .toMatchObject({ applyState: "unavailable", effectiveRevision: null, connectionState: "unknown" });
  await expect(settings.getByRole("row").filter({ has: page.getByRole("button", { name: "Dormant Claude details", exact: true }) }).getByRole("cell").nth(3))
    .toHaveText("Configuration: Not applied");
  await capture(page, testInfo, "execution-settings-environment-backends-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBackends = settings.getByRole("region", { name: "Configured backends", exact: true }).getByRole("table");
  await expect(mobileBackends.getByRole("rowgroup")).toHaveCount(2);
  await expect(mobileBackends.getByRole("columnheader")).toHaveText(["Backend", "Provider", "Runtime", "Configuration", "Actions"]);
  const mobileClaude = mobileBackends.getByRole("row").filter({ has: page.getByRole("button", { name: "Dormant Claude details", exact: true }) });
  await expect(mobileClaude.getByRole("cell")).toHaveCount(5);
  await expect(mobileClaude.getByRole("cell").nth(0)).toContainText("Disabled");
  await expect(mobileClaude.getByRole("cell").nth(2)).toHaveText("Status unknown");
  await expect(mobileClaude.getByRole("cell").nth(3)).toHaveText("Configuration: Not applied");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-environment-backends-mobile.png");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await expect(settings.getByLabel("Search environments", { exact: true })).toHaveValue("e2e-unreachable");
  await selectSettingsCategory(page, "backends");
  await settings.getByLabel("Search backends", { exact: true }).fill("e2e-unreachable");
  await expect(settings.getByRole("button", { name: "Dormant Claude details", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Dormant Codex details", exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(settings.getByRole("region", { name: "Local backends", exact: true })).toBeVisible();
  await expect(settings.getByRole("region", { name: "Temporary build host backends", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  settings = await openSettings(page, "Backends");
  await settings.getByRole("button", { name: "Dormant Claude details", exact: true }).click();
  await settings.getByRole("button", { name: "Edit Dormant Claude", exact: true }).click();
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
  await settings.getByRole("button", { name: "Uncertain lifecycle host details", exact: true }).click();
  await settings.getByRole("button", { name: "Activity & diagnostics", exact: true }).click();
  let runtime = settings.getByRole("region", { name: "Uncertain lifecycle host runtime", exact: true });
  const connectResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/configuration/lifecycle") && response.request().postDataJSON()?.resourceId === environmentId);
  await runtime.getByRole("button", { name: "Connect", exact: true }).click();
  const original = configurationLifecycleResultSchema.parse(await (await connectResponse).json());
  expect(original.state).toBe("unknown");
  await expect(runtime.getByRole("button", { name: "Refresh status", exact: true })).toBeEnabled();
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await settings.getByLabel("Filter by status", { exact: true }).selectOption("attention");
  await expect(settings.getByRole("row").filter({ has: page.getByRole("button", { name: "Uncertain lifecycle host details", exact: true }) })).toContainText("Outcome unknown");
  await settings.getByLabel("Search environments", { exact: true }).fill("no-such-environment");
  await expect(settings.getByText("No environments match these filters.", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(settings.getByLabel("Search environments", { exact: true })).toBeFocused();
  await settings.getByRole("button", { name: "Actions for Uncertain lifecycle host", exact: true }).click();
  await page.getByRole("menuitem", { name: "Runtime and actions", exact: true }).click();
  await expect(runtime.getByRole("button", { name: "Refresh status", exact: true })).toBeEnabled();
  await expect(runtime.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  settings = await openSettings(page, "Environments");
  await settings.getByRole("button", { name: "Uncertain lifecycle host details", exact: true }).click();
  await settings.getByRole("button", { name: "Activity & diagnostics", exact: true }).click();
  runtime = settings.getByRole("region", { name: "Uncertain lifecycle host runtime", exact: true });
  await expect(runtime).toContainText("outcome is unknown");
  await expect(runtime.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  const receiptResponse = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith(`/api/configuration/lifecycle/${original.mutationId}`));
  await runtime.getByRole("button", { name: "Refresh status", exact: true }).click();
  const recovered = configurationLifecycleResultSchema.parse(await (await receiptResponse).json());
  expect(recovered).toMatchObject({ mutationId: original.mutationId, state: "unknown" });
  await expect(runtime.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  const impactResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/configuration/lifecycle/impact"));
  await runtime.getByRole("button", { name: "Stop", exact: true }).click();
  const impact = configurationLifecycleImpactSchema.parse(await (await impactResponse).json());
  expect(impact).toMatchObject({ resourceId: environmentId, action: "stop", activeResources: 1 });
  const confirmation = runtime.getByRole("group", { name: "Confirm runtime interruption" });
  await expect(confirmation).toContainText("1 affected resource");
  await expect(confirmation).toContainText("unknown outcome");
  await expect(confirmation.getByRole("button", { name: "Confirm stop", exact: true })).toBeEnabled();
  await capture(page, testInfo, "execution-settings-unknown-stop-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await confirmation.getByRole("button", { name: "Confirm stop", exact: true }).scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "execution-settings-unknown-stop-mobile.png");
  const stopResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/configuration/lifecycle") && response.request().postDataJSON()?.action === "stop");
  await confirmation.getByRole("button", { name: "Confirm stop", exact: true }).click();
  const stopped = configurationLifecycleResultSchema.parse(await (await stopResponse).json());
  expect(stopped).toMatchObject({ state: "applied", runtime: { connectionState: "stopped", preference: "stopped", activeResources: 0 } });
  expect((await stopResponse).request().postDataJSON()).toMatchObject({ resourceId: environmentId, impactToken: impact.token, expectedIncarnation: impact.incarnation });
  await expect(runtime).toContainText("Intentionally stopped");
  await expect(runtime.getByRole("button", { name: "Refresh status", exact: true })).toHaveCount(0);
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
  await expect(settings.getByText("1 host awaiting approval", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Review hosts", exact: true }).click();
  const pending = settings.getByRole("article", { name: "Pending Studio outbound" });
  await expect(pending).toContainText(registration.correlationCode);
  await expect(pending).toContainText("macOS · arm64");
  await expect(pending).toContainText("Host online");
  await capture(page, testInfo, "outbound-host-pending-desktop.png");
  await pending.getByRole("button", { name: "Accept Studio outbound" }).click();
  await settings.getByLabel("Environment name", { exact: true }).fill("Paired Studio");
  await settings.getByLabel("Workspace roots", { exact: true }).fill("/Users/operator/Projects");
  await settings.getByLabel("Workspace tools and context", { exact: true }).check();
  await settings.getByLabel("Interactive terminals", { exact: true }).check();
  const acceptedResponse = page.waitForResponse(response => response.url().endsWith("/api/host-registrations/accept") && response.ok());
  await settings.getByRole("button", { name: "Accept host", exact: true }).click();
  const accepted = await (await acceptedResponse).json();
  expect(accepted.configuration.configuration.executionEnvironments.find((entry: { label: string }) => entry.label === "Paired Studio")).toMatchObject({ kind: "outbound", platform: "darwin", workspaceRoots: ["/Users/operator/Projects"] });
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  const summary = settings.getByRole("button", { name: "Paired Studio details", exact: true });
  await expect(settings.getByRole("row").filter({ has: page.getByRole("button", { name: "Paired Studio details", exact: true }) })).toContainText("Host online");
  await summary.click();
  await settings.getByRole("button", { name: "Activity & diagnostics", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Remove Paired Studio" })).toBeDisabled();
  await expect(settings.getByRole("region", { name: "Paired Studio runtime", exact: true })).not.toContainText("Connected");
  expect((await request.post("/__e2e/host-presence", { data: { connectorId, connected: false } })).ok()).toBe(true);
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(settings.locator(".execution-settings-overview")).toContainText("Host offline");
  await settings.getByRole("button", { name: "Edit Paired Studio", exact: true }).click();
  await expect(settings.getByLabel("Environment type", { exact: true })).toHaveValue("outbound");
  await expect(settings.getByLabel("Environment type", { exact: true })).toBeDisabled();
  await expect(settings.getByLabel("SSH host alias", { exact: true })).toHaveCount(0);
  await settings.getByLabel("Workspace roots", { exact: true }).fill("/Users/operator/Projects\n/Users/operator/Shared");
  const editedResponse = page.waitForResponse(response => response.url().endsWith("/api/configuration") && response.request().method() === "PUT" && response.ok());
  await settings.getByRole("button", { name: "Save environment", exact: true }).click();
  await editedResponse;
  await page.reload();
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  settings = await openSettings(page, "Environments");
  await settings.getByRole("button", { name: "Paired Studio details", exact: true }).click();
  await settings.getByRole("button", { name: "Activity & diagnostics", exact: true }).click();
  await expect(settings).toContainText(connectorId);
  await expect(settings.locator(".execution-settings-overview")).toContainText("Host offline");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "outbound-host-offline-mobile.png");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await settings.getByRole("button", { name: "Revoke Paired Studio", exact: true }).click();
  await expect(settings).toContainText("does not stop host-owned processes");
  await settings.getByRole("button", { name: "Confirm revocation", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Reapprove Paired Studio", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Remove Paired Studio", exact: true })).toBeEnabled();
  await settings.getByRole("button", { name: "Reapprove Paired Studio", exact: true }).click();
  await settings.getByRole("button", { name: "Confirm reapproval", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Revoke Paired Studio", exact: true })).toBeVisible();
  const denied = await request.post("/__e2e/host-registrations", { data: {
    connectorId: "21000000-0000-4000-8000-000000000003", registrationAttemptId: "21000000-0000-4000-8000-000000000004",
    metadata: { hostname: "Windows candidate", platform: "win32", architecture: "x64", account: "operator", connectorVersion: "e2e" },
  } });
  expect(denied.ok()).toBe(true);
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  await settings.getByRole("button", { name: "Review hosts", exact: true }).click();
  await settings.getByRole("button", { name: "Deny Windows candidate", exact: true }).click();
  await expect(settings.getByRole("article", { name: "Pending Windows candidate" })).toHaveCount(0);
  await settings.getByRole("button", { name: "Back", exact: true }).click();
  await settings.getByRole("button", { name: "Paired Studio details", exact: true }).click();
  await settings.getByRole("button", { name: "Activity & diagnostics", exact: true }).click();
  await capture(page, testInfo, "outbound-host-paired-desktop.png");

  await selectSettingsCategory(page, "backends");
  await settings.getByRole("button", { name: "Add backend", exact: true }).click();
  await settings.getByLabel("Execution environment", { exact: true }).selectOption(accepted.pairing.executionEnvironmentId);
  await settings.getByLabel("Backend type", { exact: true }).selectOption("claude_agent_sdk");
  await settings.getByLabel("Backend name", { exact: true }).fill("Paired Claude");
  await settings.getByLabel("Backend enabled", { exact: true }).uncheck();
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
  await settings.getByRole("button", { name: "Paired Claude details", exact: true }).click();
  await settings.getByRole("button", { name: "Edit Paired Claude", exact: true }).click();
  await expect(settings.getByLabel("Execution environment", { exact: true })).toHaveValue(accepted.pairing.executionEnvironmentId);
  await expect(settings.getByLabel("Execution environment", { exact: true })).toBeDisabled();
  await settings.getByLabel("Execution environment", { exact: true }).scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "outbound-claude-connection-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
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
  const navigation = settings.getByRole("navigation", { name: "Settings pages" });
  await selectSettingsCategory(page, "appearance");
  await settings.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await selectSettingsCategory(page, "backends");
  await page.setViewportSize({ width: 390, height: 844 });
  const content = settings.locator(".settings-content");
  await content.evaluate((element) => { element.scrollTop = 0; });
  const inventory = settings.getByRole("region", { name: "Configured backends", exact: true });
  const names = inventory.getByRole("button", { name: / details$/u });
  await expect(names).toHaveCount(26);
  await expect.poll(() => names.evaluateAll((elements) => elements.filter((element) => {
    const bounds = element.closest("tr")!.getBoundingClientRect();
    const viewport = element.closest(".settings-content")!.getBoundingClientRect();
    return bounds.width > 0 && bounds.top >= viewport.top && bounds.bottom <= Math.min(viewport.bottom, window.innerHeight);
  }).length)).toBeGreaterThanOrEqual(4);
  const filters = settings.getByRole("button", { name: /^Filters/u });
  await expect(filters).toHaveAttribute("aria-expanded", "false");
  await expect(settings.getByLabel("Filter by environment", { exact: true })).toBeHidden();
  const firstRow = inventory.getByRole("row").filter({ has: page.getByRole("button", { name: "Claude review 03 details", exact: true }) });
  await expect(firstRow.getByRole("cell").nth(2)).toContainText("Status unknown");
  await expect(firstRow.getByRole("cell").nth(3)).toContainText("Not applied");
  await expect(firstRow.getByText("Connected", { exact: true })).toHaveCount(0);
  for (const control of [filters, settings.getByLabel("Search backends", { exact: true }), firstRow.getByRole("button", { name: "Edit Claude review 03", exact: true }), firstRow.getByRole("button", { name: "Actions for Claude review 03", exact: true })]) {
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
  }
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
  await expect(names).toHaveText("Claude review 03");
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
    const closeBounds = (await settings.getByTestId("settings-return").boundingBox())!;
    const controlsOverlap = Math.max(addBounds.x, closeBounds.x) < Math.min(addBounds.x + addBounds.width, closeBounds.x + closeBounds.width)
      && Math.max(addBounds.y, closeBounds.y) < Math.min(addBounds.y + addBounds.height, closeBounds.y + closeBounds.height);
    expect(controlsOverlap, "Add and return controls must remain separate at every viewport").toBe(false);
    const categoryPicker = settings.getByRole("combobox", { name: "Settings category", exact: true });
    await expect(await categoryPicker.isVisible() ? categoryPicker : navigation).toBeInViewport({ ratio: 1 });
    await expect(settings.getByTestId("settings-return")).toBeInViewport({ ratio: 1 });
    await capture(page, testInfo, viewport.screenshot);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const longEnvironment = inventory.getByRole("button", { name: environments[2]!.label, exact: true });
  await longEnvironment.evaluate(element => element.scrollIntoView({ block: "start" }));
  await expect(longEnvironment).toBeInViewport();
  await expect(settings.getByRole("combobox", { name: "Settings category", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(settings.getByTestId("settings-return")).toBeInViewport({ ratio: 1 });
  expect(await settings.evaluate(element => element.scrollTop)).toBe(0);
  await expectNoPageOverflow(page);
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await longEnvironment.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, testInfo, "execution-settings-unbroken-environment-dark-mobile-320.png");
  const disconnectedRow = inventory.getByRole("row").filter({ has: page.getByRole("button", { name: `${disconnectedBackend.label} details`, exact: true }) });
  await disconnectedRow.evaluate(element => element.scrollIntoView({ block: "center" }));
  await expect(disconnectedRow).toBeInViewport();
  await expect(settings.getByRole("combobox", { name: "Settings category", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(settings.getByTestId("settings-return")).toBeInViewport({ ratio: 1 });
  expect(await settings.evaluate(element => element.scrollTop)).toBe(0);
  await expect(disconnectedRow.getByRole("cell").nth(2)).toContainText("Intentionally disconnected");
  const tracks = await disconnectedRow.evaluate((element) => {
    const cells = element.querySelectorAll("td");
    return { row: element.getBoundingClientRect().width, identity: cells[0]!.getBoundingClientRect().width,
      runtime: cells[2]!.getBoundingClientRect().width, gap: Number.parseFloat(getComputedStyle(element).columnGap) };
  });
  expect(tracks.runtime).toBeLessThanOrEqual(tracks.row / 2 + 1);
  expect(tracks.identity).toBeGreaterThanOrEqual(tracks.row / 2 - tracks.gap - 1);
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
  await settings.getByRole("button", { name: "Edit Codex stdio", exact: true }).click();
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
  const backendRow = settings.getByRole("row").filter({ has: page.getByRole("button", { name: "Codex stdio details", exact: true }) });
  await expect(backendRow.getByRole("cell").nth(3)).toContainText("Pending restart", { timeout: 10_000 });
  await expect(backendRow.getByRole("cell").nth(3)).toBeVisible();
  await backendRow.scrollIntoViewIfNeeded();
  await capture(page, testInfo, "execution-startup-pending-restart.png");
  await settings.getByRole("button", { name: "Edit Codex stdio", exact: true }).click();
  await expect(startup).toBeEnabled();
  await startup.click();
  await expect(settings.getByLabel("Value for BUILD_STAGE", { exact: true })).toHaveValue("after-restart");
});
