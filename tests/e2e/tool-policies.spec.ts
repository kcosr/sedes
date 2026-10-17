import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { configurationSnapshotSchema } from "../../src/shared/protocol/configuration-admin.js";
import { normalizedApplicationSnapshotSchema } from "../../src/shared/protocol/application.js";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { capture, expectNoPageOverflow, openSedesWorkspace, repositoryLabel, selectProjectIfNeeded, selectRadixOption } from "./helpers";

async function sessionToken(page: Page): Promise<string> {
  const response = await page.request.get("/api/application/session");
  expect(response.ok()).toBe(true);
  return (await response.json()).csrfToken as string;
}

/** This job owns its policies, defaults and thread; it never uses another spec's state. */
test("policy sets replace inherited tools across levels and snapshot new threads", async ({ page, browserDiagnostics }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openSedesWorkspace(page);
  const token = await sessionToken(page);
  const configResponse = await page.request.get("/api/configuration");
  expect(configResponse.ok()).toBe(true);
  const config = configurationSnapshotSchema.parse(await configResponse.json()).configuration;
  const target = config.targets.find(item => item.kind === "pi_sdk" && item.enabled)!;
  expect(target).toBeDefined();
  const applicationResponse = await page.request.get("/api/application/snapshot");
  expect(applicationResponse.ok()).toBe(true);
  const application = normalizedApplicationSnapshotSchema.parse(await applicationResponse.json());
  const executionTarget = application.executionTargets.find(item => item.label.text === target.label && item.environmentId === target.executionEnvironmentId && item.backend.brand === "pi");
  expect(executionTarget).toBeDefined();
  if (!executionTarget) throw new Error("policy_e2e_execution_target_unavailable");

  await page.goto("/settings/tool-policies");
  await expect(page.getByRole("heading", { name: "Tool policies", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New policy set" }).first().click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Everyday");
  await page.getByRole("button", { name: "Context", exact: true }).click();
  await page.getByRole("checkbox", { name: "Agent context", exact: true }).check();
  await page.getByRole("button", { name: "Threads", exact: true }).click();
  await page.getByRole("checkbox", { name: "List threads", exact: true }).check();
  await page.getByRole("switch", { name: "Allow other environments", exact: true }).check();
  const created = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/tool-policies") && response.status() === 201);
  await page.getByRole("button", { name: "Create policy set", exact: true }).click();
  const everyday = (await (await created).json()).policySet;
  expect(everyday).toMatchObject({ enabledToolIds: ["agent.context", "thread.list"], resourceScope: { allowOtherEnvironments: true, allowOtherProjects: false } });
  await expect(page).toHaveURL(`/settings/tool-policies/${everyday.id}`);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "tool-policy-editor-desktop.png");

  await page.goto("/settings/tool-policies");
  await page.getByRole("combobox", { name: "Default tool policy", exact: true }).selectOption(everyday.id);
  const accountSaved = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/api/tool-policy-selections") && response.ok());
  await page.getByRole("button", { name: "Save default", exact: true }).click();
  await accountSaved;
  await capture(page, testInfo, "tool-policy-account-default.png");

  const reviewerResponse = await page.request.post("/api/tool-policies", { headers: { "X-CSRF-Token": token }, data: {
    name: "Reviewer", enabledToolIds: ["thread.list"], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
  } });
  expect(reviewerResponse.status()).toBe(201);
  const reviewer = (await reviewerResponse.json()).policySet;
  const resolve = async () => {
    const response = await page.request.post("/api/tool-policies/resolve", { headers: { "X-CSRF-Token": token }, data: { targetId: executionTarget.id } });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  expect(await resolve()).toMatchObject({ source: "account", enabledToolIds: ["agent.context", "thread.list"] });

  await page.goto(`/settings/environments/${target.executionEnvironmentId}`);
  const environmentPolicy = page.getByRole("region", { name: "Sedes tool policy", exact: true });
  await expect(environmentPolicy.getByText("Inherited from account defaults", { exact: true })).toBeVisible();
  await environmentPolicy.getByRole("combobox", { name: "Tool policy", exact: true }).selectOption("disabled");
  const environmentSaved = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/api/tool-policy-selections") && response.ok());
  await environmentPolicy.getByRole("button", { name: "Save default", exact: true }).click();
  await environmentSaved;
  expect(await resolve()).toMatchObject({ source: "environment", enabled: false, enabledToolIds: [] });

  await page.goto(`/settings/backends/${target.backendInstanceId}`);
  const backendPolicy = page.getByRole("region", { name: "Sedes tool policy", exact: true });
  await expect(backendPolicy.getByText("Inherited from environment defaults", { exact: true })).toBeVisible();
  await backendPolicy.getByRole("combobox", { name: "Tool policy", exact: true }).selectOption(reviewer.id);
  const backendSaved = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/api/tool-policy-selections") && response.ok());
  await backendPolicy.getByRole("button", { name: "Save default", exact: true }).click();
  await backendSaved;
  expect(await resolve()).toMatchObject({ source: "backend", enabledToolIds: ["thread.list"], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } });
  await capture(page, testInfo, "tool-policy-backend-default.png");

  await page.goto("/");
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await selectProjectIfNeeded(page, repositoryLabel);
  await selectRadixOption(page, page.getByRole("combobox", { name: "Target", exact: true }), target.label);
  const creation = page.getByRole("dialog", { name: "New thread", exact: true });
  await expect(creation.getByText("Inherited from backend settings · Reviewer", { exact: true })).toBeVisible();
  await expect(creation.getByText("1 tool · This project in this environment", { exact: true })).toBeVisible();
  const threadCreated = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/threads") && response.status() === 201);
  await creation.getByRole("button", { name: "Create thread", exact: true }).click();
  const threadId = (await (await threadCreated).json()).threadId as string;
  await expect(page).toHaveURL(`/threads/${threadId}`);
  const snapshot = async () => {
    const response = await page.request.get(`/api/threads/${threadId}?activityDetail=full`);
    expect(response.ok()).toBe(true);
    return normalizedThreadSnapshotSchema.parse(await response.json());
  };
  const initial = await snapshot();
  expect(initial.agentTools.resourceScope).toEqual({ allowOtherEnvironments: false, allowOtherProjects: false });
  expect(initial.agentTools.groups.flatMap(group => group.tools.filter(tool => tool.enabled).map(tool => tool.id))).toEqual(["thread.list"]);

  await page.goto(`/settings/tool-policies/${reviewer.id}`);
  await page.getByRole("switch", { name: "Allow other environments", exact: true }).check();
  await page.getByRole("switch", { name: "Allow other projects", exact: true }).check();
  const policyUpdated = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/api/tool-policies/${reviewer.id}`) && response.ok());
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await policyUpdated;
  expect(await resolve()).toMatchObject({ source: "backend", resourceScope: { allowOtherEnvironments: true, allowOtherProjects: true } });
  expect((await snapshot()).agentTools.resourceScope).toEqual(initial.agentTools.resourceScope);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await expect(page.getByRole("region", { name: "Policy sets", exact: true })).toBeHidden();
  await capture(page, testInfo, "tool-policy-editor-mobile.png");

  await page.getByRole("button", { name: "Delete policy set…", exact: true }).click();
  const deletion = page.getByRole("dialog", { name: "Delete Reviewer?", exact: true });
  await expect(deletion).toContainText("Needs attention");
  const policyDeleted = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().endsWith(`/api/tool-policies/${reviewer.id}`) && response.ok());
  await deletion.getByRole("button", { name: "Delete policy set", exact: true }).click();
  await policyDeleted;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/settings/backends/${target.backendInstanceId}`);
  await expect(backendPolicy.getByText(/Needs attention: this policy set was deleted/)).toBeVisible();
  await backendPolicy.getByRole("combobox", { name: "Tool policy", exact: true }).selectOption("disabled");
  const repaired = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/api/tool-policy-selections") && response.ok());
  await backendPolicy.getByRole("button", { name: "Save default", exact: true }).click();
  await repaired;
  expect(await resolve()).toMatchObject({ source: "backend", enabled: false, enabledToolIds: [] });
  expect((await snapshot()).agentTools.resourceScope).toEqual(initial.agentTools.resourceScope);
  // No expected request failures are suppressed: every mutation and preview above must succeed.
  expect(browserDiagnostics.allowNetworkFailures).toBe(false);
});
