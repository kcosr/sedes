import { configurationSnapshotSchema } from "../../src/shared/protocol/configuration-admin.js";
import { expect, test } from "./fixtures.js";
import { capture, expectNoPageOverflow, openSettingsPage } from "./helpers.js";

test("OpenCode v2 owned and external definitions persist their exact connection contracts", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  let settings = await openSettingsPage(page, "backends");
  await settings.getByRole("button", { name: "Add backend", exact: true }).click();
  await settings.getByLabel("Execution environment", { exact: true }).selectOption({ label: "Local" });
  await settings.getByLabel("Backend type", { exact: true }).selectOption("opencode");
  await settings.getByLabel("Backend name", { exact: true }).fill("OpenCode v2 qualification");
  // Saving a disabled definition exercises browser/server persistence without
  // pretending this deterministic fixture owns a native provider process.
  await settings.getByLabel("Backend enabled", { exact: true }).uncheck();
  await expect(settings.getByLabel("Connection ownership", { exact: true })).toHaveValue("process_stdio");
  await settings.getByLabel("Native database path", { exact: true }).fill("/fixture/opencode/native.db");
  await settings.getByLabel("OpenCode v2 executable path", { exact: true }).fill("/fixture/bin/opencode2");
  await settings.getByLabel("Working directory", { exact: true }).fill("/fixture/workspace");
  await expect(settings.getByRole("tab", { name: "Backend startup", exact: true })).toBeEnabled();
  await capture(page, testInfo, "opencode-owned-settings-desktop.png");
  const ownedSaved = page.waitForResponse(response => response.request().method() === "PUT" &&
    response.url().endsWith("/api/configuration"));
  await settings.getByRole("button", { name: "Save backend", exact: true }).click();
  const ownedResponse = await ownedSaved;
  expect(ownedResponse.status(), await ownedResponse.text()).toBe(200);
  const owned = configurationSnapshotSchema.parse(await ownedResponse.json());
  const backend = owned.configuration.backends.find(value => value.label === "OpenCode v2 qualification");
  expect(backend).toMatchObject({ kind: "opencode", enabled: false, moduleConfiguration: {
    nativeStorePath: "/fixture/opencode/native.db", connection: { ownership: "owned", channel: {
      type: "process_stdio", executablePath: "/fixture/bin/opencode2", workingDirectory: "/fixture/workspace",
    } },
  } });
  expect(owned.configuration.targets.find(value => value.backendInstanceId === backend!.id))
    .toMatchObject({ kind: "opencode_http", enabled: false });

  await page.reload();
  settings = await openSettingsPage(page, "backends");
  await settings.getByRole("button", { name: "Edit OpenCode v2 qualification", exact: true }).click();
  await expect(settings.getByLabel("OpenCode v2 executable path", { exact: true })).toHaveValue("/fixture/bin/opencode2");
  await settings.getByLabel("Connection ownership", { exact: true }).selectOption("http");
  await expect(settings.getByLabel("OpenCode v2 executable path", { exact: true })).toHaveCount(0);
  await settings.getByLabel("HTTP endpoint", { exact: true }).fill("http://127.0.0.1:4096");
  await settings.getByLabel("Password source", { exact: true }).selectOption("environment");
  await settings.getByLabel("Password environment variable", { exact: true }).fill("SEDES_OPENCODE_QUALIFICATION_PASSWORD");
  await expect(settings.getByRole("tab", { name: "Backend startup", exact: true })).toBeDisabled();
  await capture(page, testInfo, "opencode-external-settings-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await settings.getByLabel("HTTP endpoint", { exact: true }).scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "opencode-external-settings-mobile.png");
  const externalSaved = page.waitForResponse(response => response.request().method() === "PUT" &&
    response.url().endsWith("/api/configuration"));
  await settings.getByRole("button", { name: "Save backend", exact: true }).click();
  const externalResponse = await externalSaved;
  expect(externalResponse.status(), await externalResponse.text()).toBe(200);
  const external = configurationSnapshotSchema.parse(await externalResponse.json());
  const saved = external.configuration.backends.find(value => value.id === backend!.id);
  expect(saved).toMatchObject({ kind: "opencode", enabled: false, moduleConfiguration: {
    nativeStorePath: "/fixture/opencode/native.db", connection: { ownership: "external", channel: {
      type: "http", url: "http://127.0.0.1:4096", authentication: { type: "basic", username: "opencode",
        secret: { source: "environment", variable: "SEDES_OPENCODE_QUALIFICATION_PASSWORD" } },
    } },
  } });
  if (saved?.kind !== "opencode") throw new Error("Saved OpenCode backend missing");
  expect(saved.moduleConfiguration.connection.channel).not.toHaveProperty("executablePath");
  await page.reload();
  settings = await openSettingsPage(page, "backends");
  await settings.getByRole("button", { name: "Edit OpenCode v2 qualification", exact: true }).click();
  await expect(settings.getByLabel("Connection ownership", { exact: true })).toHaveValue("http");
  await expect(settings.getByLabel("Password environment variable", { exact: true })).toHaveValue("SEDES_OPENCODE_QUALIFICATION_PASSWORD");
  await expectNoPageOverflow(page);
});
