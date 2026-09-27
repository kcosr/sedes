import { randomUUID } from "node:crypto";
import { configurationSnapshotSchema, type ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { expect, test } from "./fixtures.js";
import { capture, expectNoPageOverflow, openSettingsPage } from "./helpers.js";

for (const kind of ["local", "ssh", "outbound"] as const) test(`OpenCode v2 ${kind} owned and external definitions persist their exact host contracts`, async ({ page, request }, testInfo) => {
  const session = await (await request.get("/api/application/session")).json() as { csrfToken: string };
  const before = configurationSnapshotSchema.parse(await (await request.get("/api/configuration")).json());
  let environment: ConfigurationDocument["executionEnvironments"][number] = before.configuration.executionEnvironments.find(value => value.kind === "local")!;
  if (kind === "ssh") {
    const saved = await request.put("/api/configuration", { headers: { "X-CSRF-Token": session.csrfToken }, data: {
      mutationId: randomUUID(), expectedRevision: before.revision, configuration: { ...before.configuration,
        executionEnvironments: [...before.configuration.executionEnvironments, { id: randomUUID(), kind: "ssh",
          label: "OpenCode SSH host", hostAlias: "opencode-e2e", workspaceRoots: ["/fixture/workspace"],
          operations: { kind: "sidecar", enabledCapabilities: ["workspace_files"] } }],
      },
    } });
    expect(saved.ok(), await saved.text()).toBe(true);
    environment = configurationSnapshotSchema.parse(await saved.json()).configuration.executionEnvironments.find(value => value.label === "OpenCode SSH host")!;
  } else if (kind === "outbound") {
    const registered = await request.post("/__e2e/host-registrations", { data: { connectorId: randomUUID(), registrationAttemptId: randomUUID(),
      metadata: { hostname: "OpenCode Linux", platform: "linux", architecture: "x64", account: "operator", connectorVersion: "e2e" },
    } });
    expect(registered.ok(), await registered.text()).toBe(true);
    const registration = await registered.json();
    const accepted = await request.post("/api/host-registrations/accept", { headers: { "X-CSRF-Token": session.csrfToken }, data: {
      mutationId: randomUUID(), registrationId: registration.id, expectedRegistrationRevision: registration.revision,
      expectedConfigurationRevision: before.revision, label: "OpenCode outbound host", workspaceRoots: ["/fixture/workspace"],
      operations: { kind: "sidecar", enabledCapabilities: ["workspace_files"] },
    } });
    expect(accepted.ok(), await accepted.text()).toBe(true);
    environment = configurationSnapshotSchema.parse((await accepted.json()).configuration).configuration.executionEnvironments.find(value => value.label === "OpenCode outbound host")!;
  }
  const label = `OpenCode ${kind} qualification`;
  const storePath = `/fixture/opencode/${kind}/native.db`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  let settings = await openSettingsPage(page, "backends");
  await settings.getByRole("button", { name: "Add backend", exact: true }).click();
  await settings.getByLabel("Execution environment", { exact: true }).selectOption(environment.id);
  await settings.getByLabel("Backend type", { exact: true }).selectOption("opencode");
  await settings.getByLabel("Backend name", { exact: true }).fill(label);
  // Saving a disabled definition exercises browser/server persistence without
  // pretending this deterministic fixture owns a native provider process.
  await settings.getByLabel("Backend enabled", { exact: true }).uncheck();
  await expect(settings.getByLabel("Connection ownership", { exact: true })).toHaveValue("process_stdio");
  await settings.getByLabel("Native database path", { exact: true }).fill(storePath);
  await settings.getByLabel("OpenCode v2 executable path", { exact: true }).fill("/fixture/bin/opencode2");
  await settings.getByLabel("Working directory", { exact: true }).fill("/fixture/workspace");
  await expect(settings.getByRole("tab", { name: "Backend startup", exact: true })).toBeEnabled();
  await capture(page, testInfo, `opencode-${kind}-owned-settings-desktop.png`);
  const ownedSaved = page.waitForResponse(response => response.request().method() === "PUT" &&
    response.url().endsWith("/api/configuration"));
  await settings.getByRole("button", { name: "Save backend", exact: true }).click();
  const ownedResponse = await ownedSaved;
  expect(ownedResponse.status(), await ownedResponse.text()).toBe(200);
  const owned = configurationSnapshotSchema.parse(await ownedResponse.json());
  const backend = owned.configuration.backends.find(value => value.label === label);
  expect(backend).toMatchObject({ kind: "opencode", enabled: false, moduleConfiguration: {
    nativeStorePath: storePath, connection: { ownership: "owned", channel: {
      type: "process_stdio", executablePath: "/fixture/bin/opencode2", workingDirectory: "/fixture/workspace",
    } },
  } });
  expect(owned.configuration.targets.find(value => value.backendInstanceId === backend!.id))
    .toMatchObject({ kind: "opencode_http", enabled: false, executionEnvironmentId: environment.id });

  await page.reload();
  settings = await openSettingsPage(page, "backends");
  await settings.getByRole("button", { name: `Edit ${label}`, exact: true }).click();
  await expect(settings.getByLabel("Execution environment", { exact: true })).toBeDisabled();
  await expect(settings.getByLabel("Execution environment", { exact: true })).toHaveValue(environment.id);
  await expect(settings.getByLabel("OpenCode v2 executable path", { exact: true })).toHaveValue("/fixture/bin/opencode2");
  await settings.getByLabel("Connection ownership", { exact: true }).selectOption("http");
  await expect(settings.getByLabel("OpenCode v2 executable path", { exact: true })).toHaveCount(0);
  await expect(settings.getByLabel("HTTP endpoint", { exact: true })).toHaveAccessibleDescription(/selected execution host, including SSH and outbound hosts/);
  await settings.getByLabel("HTTP endpoint", { exact: true }).fill("http://127.0.0.1:4096");
  const secret = kind === "local" ? { source: "environment", variable: "SEDES_OPENCODE_QUALIFICATION_PASSWORD" }
    : { source: "protected_file", path: `/fixture/opencode/${kind}/password` };
  if (kind === "local") {
    await settings.getByLabel("Password source", { exact: true }).selectOption("environment");
    await settings.getByLabel("Password environment variable", { exact: true }).fill(secret.variable!);
  } else {
    await expect(settings.getByLabel("Password source", { exact: true }).getByRole("option")).toHaveCount(1);
    await settings.getByLabel("Password file reference", { exact: true }).fill(secret.path!);
  }
  await expect(settings.getByRole("tab", { name: "Backend startup", exact: true })).toBeDisabled();
  await capture(page, testInfo, `opencode-${kind}-external-settings-desktop.png`);
  await page.setViewportSize({ width: 390, height: 844 });
  await settings.getByLabel("HTTP endpoint", { exact: true }).scrollIntoViewIfNeeded();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, `opencode-${kind}-external-settings-mobile.png`);
  const externalSaved = page.waitForResponse(response => response.request().method() === "PUT" &&
    response.url().endsWith("/api/configuration"));
  await settings.getByRole("button", { name: "Save backend", exact: true }).click();
  const externalResponse = await externalSaved;
  expect(externalResponse.status(), await externalResponse.text()).toBe(200);
  const external = configurationSnapshotSchema.parse(await externalResponse.json());
  const saved = external.configuration.backends.find(value => value.id === backend!.id);
  expect(saved).toMatchObject({ kind: "opencode", enabled: false, moduleConfiguration: {
    nativeStorePath: storePath, connection: { ownership: "external", channel: {
      type: "http", url: "http://127.0.0.1:4096", authentication: { type: "basic", username: "opencode",
        secret },
    } },
  } });
  if (saved?.kind !== "opencode") throw new Error("Saved OpenCode backend missing");
  expect(saved.moduleConfiguration.connection.channel).not.toHaveProperty("executablePath");
  await page.reload();
  settings = await openSettingsPage(page, "backends");
  await settings.getByRole("button", { name: `Edit ${label}`, exact: true }).click();
  await expect(settings.getByLabel("Connection ownership", { exact: true })).toHaveValue("http");
  await expect(settings.getByLabel(kind === "local" ? "Password environment variable" : "Password file reference", { exact: true }))
    .toHaveValue(kind === "local" ? secret.variable! : secret.path!);
  await expect(settings.getByLabel("Execution environment", { exact: true })).toBeDisabled();
  await expect(settings.getByLabel("Execution environment", { exact: true })).toHaveValue(environment.id);
  await expectNoPageOverflow(page);
});
