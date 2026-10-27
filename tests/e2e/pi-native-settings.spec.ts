import { configurationSnapshotSchema } from "../../src/shared/protocol/configuration-admin.js";
import { expect, test } from "./fixtures.js";
import { capture, expectNoPageOverflow, openSettingsPage } from "./helpers.js";

test("native Pi configuration persists independently of Pi SDK", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const settings = await openSettingsPage(page, "backends");
  await settings.getByRole("button", { name: "Add backend", exact: true }).click();
  await settings.getByLabel("Execution environment", { exact: true }).selectOption({ label: "Local" });
  const type = settings.getByLabel("Backend type", { exact: true });
  await expect(type.locator('option[value="pi_native"]')).toHaveText("Pi");
  await expect(type.locator('option[value="pi"]')).toHaveText("Pi SDK");
  await type.selectOption("pi_native");
  await settings.getByLabel("Backend name", { exact: true }).fill("Native Pi test");
  await settings.getByLabel("Backend enabled", { exact: true }).uncheck();
  await expect(settings.getByLabel("Trust Pi project resources", { exact: true })).not.toBeChecked();
  await settings.getByLabel("Trust Pi project resources", { exact: true }).check();
  await settings.getByRole("button", { name: /^Advanced/u }).click();
  await settings.getByLabel("Pi executable path", { exact: true }).fill("/opt/pi/bin/pi");
  await settings.getByLabel("Pi agent directory", { exact: true }).fill("/home/operator/.pi/agent");
  await settings.getByLabel("Pi session directory", { exact: true }).fill("/home/operator/pi-sessions");
  await settings.getByLabel("Initialization timeout", { exact: true }).fill("45000");
  await settings.getByLabel("Default model", { exact: true }).selectOption("fixed");
  await settings.getByLabel("Default model provider", { exact: true }).fill("test-provider");
  await settings.getByLabel("Default model identifier", { exact: true }).fill("test-model");
  await settings.getByLabel("Default reasoning effort", { exact: true }).selectOption("low");
  const saved = page.waitForResponse(response => response.request().method() === "PUT"
    && response.url().endsWith("/api/configuration"));
  await settings.getByRole("button", { name: "Save backend", exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  const snapshot = configurationSnapshotSchema.parse(await response.json());
  const native = snapshot.configuration.backends.find(backend => backend.label === "Native Pi test");
  expect(native).toMatchObject({ kind: "pi_native", enabled: false, moduleConfiguration: {
    executablePath: "/opt/pi/bin/pi", agentDirectory: "/home/operator/.pi/agent",
    sessionDirectory: "/home/operator/pi-sessions", initializationTimeoutMs: 45000, projectTrusted: true,
  } });
  expect(snapshot.configuration.targets.find(target => target.backendInstanceId === native!.id)).toMatchObject({
    kind: "pi_rpc", enabled: false, moduleConfiguration: {
      defaults: { provider: "test-provider", model: "test-model", thinkingLevel: "low" },
    },
  });
  await expect(page).toHaveURL(`/settings/backends/${native!.id}`);
  await page.reload();
  await settings.getByRole("button", { name: "Edit Native Pi test", exact: true }).click();
  await expect(settings.getByLabel("Pi agent directory", { exact: true })).toHaveValue("/home/operator/.pi/agent");
  await expect(settings.getByLabel("Default reasoning effort", { exact: true })).toHaveValue("low");
  await settings.getByLabel("Pi executable path", { exact: true }).scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "native-pi-settings-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await settings.getByLabel("Pi agent directory", { exact: true }).scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "native-pi-settings-mobile.png");
});
